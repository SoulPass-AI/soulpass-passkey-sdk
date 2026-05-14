import { PopupManager } from './popup-manager'
import type {
  SoulPassWalletConfig,
  PopupMessage,
  SoulPassSession,
  SDKSignTransactionMessage,
  SDKSignMessageMessage,
} from './types'
import { DEFAULT_WALLET_URL } from './types'

type EventType = 'connect' | 'disconnect' | 'accountChanged' | 'session'
type EventHandler = (...args: any[]) => void

export class SoulPassWallet {
  private config: Required<Pick<SoulPassWalletConfig, 'network'>> & SoulPassWalletConfig
  private popup: PopupManager
  private events = new Map<EventType, Set<EventHandler>>()

  private _connected = false
  private _publicKey: string | null = null
  private _walletAddress: string | null = null
  private _session: SoulPassSession | null = null

  constructor(config: SoulPassWalletConfig = {}) {
    this.config = {
      network: config.network ?? 'mainnet-beta',
      ...config,
    }
    const walletUrl = config.walletUrl ?? DEFAULT_WALLET_URL
    this.popup = new PopupManager(walletUrl)
  }

  // --- Public state ---

  get connected(): boolean { return this._connected }
  get publicKey(): string | null { return this._publicKey }
  get walletAddress(): string | null { return this._walletAddress }
  /**
   * The matrix-user JWT the popup obtained during signin. `null` before
   * `connect()` resolves, or when the popup build predates session
   * forwarding (≤ 0.1.x).
   */
  get session(): SoulPassSession | null { return this._session }

  // --- Public methods ---

  async connect(): Promise<{
    publicKey: string
    walletAddress: string
    session?: SoulPassSession
  }> {
    return new Promise((resolve, reject) => {
      const id = this.popup.generateId()

      this.popup.onMessage((msg: PopupMessage) => {
        if (msg.type === 'READY') {
          this.popup.send({
            type: 'CONNECT',
            id,
            payload: {
              network: this.config.network,
              // Spread-conditional so older popup builds (which strictly typecheck the
              // payload) don't see an explicit `productType: undefined` key.
              ...(this.config.productType ? { productType: this.config.productType } : {}),
            },
          })
          return
        }

        if ('id' in msg && msg.id !== id) return

        if (msg.type === 'CONNECT_SUCCESS') {
          this.handleConnectSuccess(msg.payload)
          this.popup.close()
          resolve(msg.payload)
        } else if (msg.type === 'ERROR') {
          this.popup.close()
          reject(new Error(`${msg.payload.code}: ${msg.payload.message}`))
        }
      })

      this.popup.open('/wallet/connect')
    })
  }

  async signTransaction(serializedTx: Uint8Array): Promise<{ signature: string }> {
    this.assertConnected()
    const result = await this.requestSign({
      type: 'SIGN_TRANSACTION',
      id: this.popup.generateId(),
      payload: {
        transaction: uint8ArrayToBase64(serializedTx),
        ...this.signContext,
      },
    }, '/wallet/sign')
    return { signature: result.signature }
  }

  async signAndSendTransaction(serializedTx: Uint8Array): Promise<string> {
    const result = await this.signTransaction(serializedTx)
    return result.signature
  }

  async signMessage(message: Uint8Array): Promise<{
    signature: Uint8Array
    authenticatorData: Uint8Array
    clientDataJSON: Uint8Array
  }> {
    this.assertConnected()
    const result = await this.requestSign({
      type: 'SIGN_MESSAGE',
      id: this.popup.generateId(),
      payload: {
        message: uint8ArrayToBase64(message),
        ...this.signContext,
      },
    }, '/wallet/message')
    if (!result.authenticatorData || !result.clientDataJSON) {
      throw new Error('SIGN_MESSAGE response missing WebAuthn fields')
    }
    return {
      signature: base64ToUint8Array(result.signature),
      authenticatorData: base64ToUint8Array(result.authenticatorData),
      clientDataJSON: base64ToUint8Array(result.clientDataJSON),
    }
  }

  disconnect(): void {
    this._connected = false
    this._publicKey = null
    this._walletAddress = null
    this._session = null
    this.popup.close()
    this.emit('disconnect')
  }

  // --- Events ---

  on(event: EventType, handler: EventHandler): void {
    if (!this.events.has(event)) this.events.set(event, new Set())
    this.events.get(event)!.add(handler)
  }

  off(event: EventType, handler: EventHandler): void {
    this.events.get(event)?.delete(handler)
  }

  // --- Internal ---

  private handleConnectSuccess(payload: {
    publicKey: string
    walletAddress: string
    session?: SoulPassSession
  }): void {
    this._connected = true
    this._publicKey = payload.publicKey
    this._walletAddress = payload.walletAddress
    this._session = payload.session ?? null
    this.emit('connect', payload.publicKey)
    // Separate event so session subscribers don't have to poll the getter
    // or race the 'connect' event. Fired only when the popup actually
    // forwarded a session — pre-session popup builds emit 'connect' alone.
    if (payload.session) this.emit('session', payload.session)
  }

  private assertConnected(): void {
    if (!this._connected) throw new Error('Wallet not connected')
  }

  private get signContext() {
    return {
      walletAddress: this._walletAddress!,
      network: this.config.network,
    }
  }

  private requestSign(
    message: SDKSignTransactionMessage | SDKSignMessageMessage,
    path: string,
  ): Promise<{
    signature: string
    authenticatorData?: string
    clientDataJSON?: string
  }> {
    return new Promise((resolve, reject) => {
      this.popup.onMessage((msg: PopupMessage) => {
        if (msg.type === 'READY') {
          this.popup.send(message)
          return
        }

        if ('id' in msg && msg.id !== message.id) return

        if (msg.type === 'SIGN_SUCCESS') {
          this.popup.close()
          resolve({
            signature: msg.payload.signature,
            authenticatorData: msg.payload.authenticatorData,
            clientDataJSON: msg.payload.clientDataJSON,
          })
        } else if (msg.type === 'ERROR') {
          this.popup.close()
          reject(new Error(`${msg.payload.code}: ${msg.payload.message}`))
        }
      })

      this.popup.open(path)
    })
  }

  private emit(event: EventType, ...args: any[]): void {
    this.events.get(event)?.forEach(handler => handler(...args))
  }
}

// --- Helpers ---

function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Chunked to avoid the argument-count RangeError that `...bytes` hits on
  // large inputs (signMessage is dApp-controlled; txs stay under 1232 B).
  const CHUNK = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
