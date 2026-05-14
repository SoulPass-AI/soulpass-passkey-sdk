import { PopupManager } from './popup-manager'
import type {
  SoulPassWalletConfig,
  PopupMessage,
  SoulPassSession,
  SDKSignTransactionMessage,
  SDKSignMessageMessage,
  SignTransactionSession,
  SignMessageSession,
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

  /**
   * Synchronously open the sign popup so this call survives in the click-handler
   * tick — the only window during which `window.open()` produces an actual popup
   * window rather than a new browser tab (transient user activation). Return a
   * single-shot session whose `.send(tx)` posts the serialized transaction once
   * the dApp's async tx-build finishes; the popup shows "Waiting for
   * transaction…" in between.
   *
   * Misuse note: callers must invoke this from a click / pointer event handler,
   * not from a useEffect or after an `await`. Outside a user gesture, browsers
   * either block the popup or downgrade it to a tab.
   */
  beginSignTransaction(): SignTransactionSession {
    this.assertConnected()
    return this.beginSign<{ signature: string }>(
      '/wallet/sign',
      (id, data: Uint8Array) => ({
        type: 'SIGN_TRANSACTION',
        id,
        payload: {
          transaction: uint8ArrayToBase64(data),
          ...this.signContext,
        },
      }),
      (msg) => ({ signature: msg.payload.signature }),
    )
  }

  /**
   * Two-phase counterpart of `signMessage` — see `beginSignTransaction` for
   * timing semantics. Returns base64-decoded WebAuthn fields verbatim.
   */
  beginSignMessage(): SignMessageSession {
    this.assertConnected()
    return this.beginSign<{
      signature: Uint8Array
      authenticatorData: Uint8Array
      clientDataJSON: Uint8Array
    }>(
      '/wallet/message',
      (id, data: Uint8Array) => ({
        type: 'SIGN_MESSAGE',
        id,
        payload: {
          message: uint8ArrayToBase64(data),
          ...this.signContext,
        },
      }),
      (msg) => {
        if (!msg.payload.authenticatorData || !msg.payload.clientDataJSON) {
          throw new Error('SIGN_MESSAGE response missing WebAuthn fields')
        }
        return {
          signature: base64ToUint8Array(msg.payload.signature),
          authenticatorData: base64ToUint8Array(msg.payload.authenticatorData),
          clientDataJSON: base64ToUint8Array(msg.payload.clientDataJSON),
        }
      },
    )
  }

  /**
   * One-shot signing — only safe when the caller already has the tx bytes
   * available in the same synchronous tick as the user click. Most async tx
   * builds (RPC blockhash fetches, anchor IDL setup) cross a microtask
   * boundary, at which point the click gesture is gone and the popup
   * downgrades to a tab. Prefer `beginSignTransaction()` for those flows.
   */
  async signTransaction(serializedTx: Uint8Array): Promise<{ signature: string }> {
    return this.beginSignTransaction().send(serializedTx)
  }

  async signAndSendTransaction(serializedTx: Uint8Array): Promise<string> {
    const { signature } = await this.signTransaction(serializedTx)
    return signature
  }

  async signMessage(message: Uint8Array): Promise<{
    signature: Uint8Array
    authenticatorData: Uint8Array
    clientDataJSON: Uint8Array
  }> {
    return this.beginSignMessage().send(message)
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

  /**
   * Generic two-phase sign session. `buildMessage` and `parseSuccess` adapt the
   * shared state machine to the per-flow message types so SIGN_TRANSACTION and
   * SIGN_MESSAGE can share the popup-ready/queue/cleanup wiring.
   *
   * State machine:
   *   1. popup.open() runs synchronously here (preserves user gesture).
   *   2. onMessage waits for popup READY; if data has arrived, flush; else stash.
   *   3. send(data): if popup is READY, post immediately; else stash and return
   *      a promise that resolves on SIGN_SUCCESS / rejects on ERROR or cancel.
   *   4. cancel(): closes popup and rejects any pending send() with CANCELLED.
   */
  private beginSign<R>(
    path: string,
    buildMessage: (id: string, data: Uint8Array) => SDKSignTransactionMessage | SDKSignMessageMessage,
    parseSuccess: (msg: Extract<PopupMessage, { type: 'SIGN_SUCCESS' }>) => R,
  ): { send: (data: Uint8Array) => Promise<R>; cancel: (reason?: string) => void } {
    const id = this.popup.generateId()

    let popupReady = false
    // Stashed payload when send() is called before popup READY. We keep it as
    // the prebuilt SDKMessage rather than raw bytes so we don't have to thread
    // `id` into the closure on the send path.
    let queuedMessage: SDKSignTransactionMessage | SDKSignMessageMessage | null = null
    let closed = false
    let sendCalled = false
    let pending: { resolve: (r: R) => void; reject: (e: Error) => void } | null = null

    const cleanup = () => {
      if (closed) return
      closed = true
      this.popup.close()
    }

    this.popup.onMessage((msg: PopupMessage) => {
      if (closed) return
      if (msg.type === 'READY') {
        popupReady = true
        // Flush queued payload exactly once. If send() hasn't been called yet,
        // we stay idle — the popup's own UI shows "Waiting for transaction…"
        // until either send() arrives or the user closes the popup.
        if (queuedMessage) {
          const m = queuedMessage
          queuedMessage = null
          this.popup.send(m)
        }
        return
      }
      if ('id' in msg && msg.id !== id) return
      if (msg.type === 'SIGN_SUCCESS') {
        if (pending) {
          try {
            pending.resolve(parseSuccess(msg))
          } catch (err) {
            pending.reject(err instanceof Error ? err : new Error(String(err)))
          }
        }
        cleanup()
      } else if (msg.type === 'ERROR') {
        pending?.reject(new Error(`${msg.payload.code}: ${msg.payload.message}`))
        cleanup()
      }
    })

    // Sync — must run in the same task as the caller's click handler.
    this.popup.open(path)

    return {
      send: (data: Uint8Array) => {
        if (sendCalled) {
          return Promise.reject(new Error('Session already used — beginSign is single-shot'))
        }
        sendCalled = true
        if (closed) {
          return Promise.reject(new Error('CANCELLED: session was cancelled before send'))
        }
        return new Promise<R>((resolve, reject) => {
          pending = { resolve, reject }
          const message = buildMessage(id, data)
          if (popupReady) {
            this.popup.send(message)
          } else {
            // popup is still loading — stash and let onMessage flush on READY.
            queuedMessage = message
          }
        })
      },
      cancel: (reason?: string) => {
        if (closed) return
        if (pending) {
          pending.reject(new Error(`CANCELLED: ${reason ?? 'session cancelled'}`))
        }
        cleanup()
      },
    }
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
