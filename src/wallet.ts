import { PopupManager } from './popup-manager'
import type {
  SoulPassWalletConfig,
  PopupMessage,
} from './types'
import { DEFAULT_WALLET_URL } from './types'

type EventType = 'connect' | 'disconnect' | 'accountChanged'
type EventHandler = (...args: any[]) => void

export class SoulPassWallet {
  private config: Required<Pick<SoulPassWalletConfig, 'network'>> & SoulPassWalletConfig
  private popup: PopupManager
  private events = new Map<EventType, Set<EventHandler>>()

  private _connected = false
  private _publicKey: string | null = null
  private _walletAddress: string | null = null

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

  // --- Public methods ---

  async connect(): Promise<{ publicKey: string; walletAddress: string }> {
    return new Promise((resolve, reject) => {
      const id = this.popup.generateId()

      this.popup.onMessage((msg: PopupMessage) => {
        if (msg.type === 'READY') {
          this.popup.send({
            type: 'CONNECT',
            id,
            payload: { network: this.config.network },
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

  async signTransaction(serializedTx: Uint8Array): Promise<{ signature: string; signedTransaction: string }> {
    this.assertConnected()
    return this.requestSign('SIGN_TRANSACTION', {
      transaction: uint8ArrayToBase64(serializedTx),
    })
  }

  async signAndSendTransaction(
    serializedTx: Uint8Array,
    _options?: { skipPreflight?: boolean },
  ): Promise<string> {
    const result = await this.signTransaction(serializedTx)
    return result.signature
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    this.assertConnected()
    const result = await this.requestSign('SIGN_MESSAGE', {
      message: uint8ArrayToBase64(message),
    })
    return base64ToUint8Array(result.signature)
  }

  disconnect(): void {
    this._connected = false
    this._publicKey = null
    this._walletAddress = null
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

  private handleConnectSuccess(payload: { publicKey: string; walletAddress: string }): void {
    this._connected = true
    this._publicKey = payload.publicKey
    this._walletAddress = payload.walletAddress
    this.emit('connect', payload.publicKey)
  }

  private assertConnected(): void {
    if (!this._connected) throw new Error('Wallet not connected')
  }

  private requestSign(
    type: 'SIGN_TRANSACTION' | 'SIGN_MESSAGE',
    payload: { transaction?: string; message?: string },
  ): Promise<{ signature: string; signedTransaction: string }> {
    return new Promise((resolve, reject) => {
      const id = this.popup.generateId()

      this.popup.onMessage((msg: PopupMessage) => {
        if (msg.type === 'READY') {
          this.popup.send({ type, id, payload } as any)
          return
        }

        if ('id' in msg && msg.id !== id) return

        if (msg.type === 'SIGN_SUCCESS') {
          this.popup.close()
          resolve({
            signature: msg.payload.signature,
            signedTransaction: msg.payload.signedTransaction ?? '',
          })
        } else if (msg.type === 'ERROR') {
          this.popup.close()
          reject(new Error(`${msg.payload.code}: ${msg.payload.message}`))
        }
      })

      const path = type === 'SIGN_TRANSACTION' ? '/wallet/sign' : '/wallet/message'
      this.popup.open(path)
    })
  }

  private emit(event: EventType, ...args: any[]): void {
    this.events.get(event)?.forEach(handler => handler(...args))
  }
}

// --- Helpers ---

function uint8ArrayToBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
