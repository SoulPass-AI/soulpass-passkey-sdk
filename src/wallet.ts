import { PopupManager } from './popup-manager'
import type {
  SoulPassWalletConfig,
  PopupMessage,
  SoulPassSession,
  SDKSignTransactionMessage,
  SDKSignMessageMessage,
  SignTransactionSession,
  SignMessageSession,
  BatchSignTransactionSession,
  SignTransactionOptions,
  VaultPda,
  StatePda,
} from './types'
import { DEFAULT_WALLET_URL } from './types'

type EventType = 'connect' | 'disconnect' | 'accountChanged' | 'session'
type EventHandler = (...args: any[]) => void

export class SoulPassWallet {
  private config: Required<Pick<SoulPassWalletConfig, 'network'>> & SoulPassWalletConfig
  private popup: PopupManager
  private events = new Map<EventType, Set<EventHandler>>()

  private _connected = false
  // SSoT for the vault PDA — `publicKey` and `walletAddress` are both
  // derived getters. Two storage slots would let future edits drift one
  // without the other.
  private _walletAddress: VaultPda | null = null
  private _accountAddress: StatePda | null = null
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
  /** Vault PDA — wallet-adapter idiomatic alias of {@link walletAddress}. */
  get publicKey(): VaultPda | null { return this._walletAddress }
  /** Vault PDA — explicit name; same value {@link publicKey} returns. */
  get walletAddress(): VaultPda | null { return this._walletAddress }
  /**
   * MachineWallet **state** PDA — the program-owned account that stores
   * nonce/authorities/threshold. Required as the seed for ephemeral signer
   * derivation; **never the same as `walletAddress`** (vault PDA).
   */
  get accountAddress(): StatePda | null { return this._accountAddress }
  /**
   * The matrix-user JWT the popup obtained during signin. `null` before
   * `connect()` resolves, or when the popup build predates session
   * forwarding (≤ 0.1.x).
   */
  get session(): SoulPassSession | null { return this._session }

  // --- Public methods ---

  async connect(): Promise<{
    publicKey: VaultPda
    walletAddress: VaultPda
    accountAddress: StatePda
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
   * Synchronously open the sign popup inside the click-handler tick — the
   * only window during which `window.open()` produces a real popup window
   * rather than a downgraded new tab (transient user activation). Returns a
   * single-shot session; the dApp posts the serialized tx through
   * `.send()` once its async build resolves.
   *
   * MUST be called from a click / pointer event handler. Calling from a
   * useEffect or after an `await` loses the user-activation flag.
   */
  beginSignTransaction(): SignTransactionSession {
    this.assertConnected()
    return this.beginSign<{ signature: string }, SignTransactionOptions>(
      '/wallet/sign',
      (id, data: Uint8Array, options?: SignTransactionOptions) => ({
        type: 'SIGN_TRANSACTION',
        id,
        payload: this.buildSignTxPayload(data, options),
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
   * Open the sign popup ONCE and keep it open across N consecutive signs.
   *
   * MUST be called synchronously inside a click / pointer event handler —
   * same timing constraint as `beginSignTransaction`. Each subsequent
   * `session.send()` posts a new SIGN_TRANSACTION to the already-open popup
   * (which resets to its waiting state after each approval), avoiding the
   * re-open activation requirement that turns looped single-shot calls into
   * new browser tabs.
   *
   * Call `session.cancel()` when the batch is done (success or error) to
   * close the popup. It is idempotent.
   */
  beginBatchSignTransaction(): BatchSignTransactionSession {
    this.assertConnected()

    let closed = false
    let watchdogId: ReturnType<typeof setInterval> | null = null
    let currentPending: { resolve: (r: { signature: string }) => void; reject: (e: Error) => void } | null = null
    let currentId: string | null = null
    let ready = false
    let queuedMessage: SDKSignTransactionMessage | null = null

    const closeAll = () => {
      if (closed) return
      closed = true
      if (watchdogId !== null) { clearInterval(watchdogId); watchdogId = null }
      this.popup.close()
    }

    this.popup.onMessage((msg: PopupMessage) => {
      if (closed) return
      if (msg.type === 'READY') {
        ready = true
        if (queuedMessage) { const m = queuedMessage; queuedMessage = null; this.popup.send(m) }
        return
      }
      if (!('id' in msg) || msg.id !== currentId) return
      if (msg.type === 'SIGN_SUCCESS') {
        const p = currentPending
        currentPending = null
        currentId = null
        p?.resolve({ signature: msg.payload.signature })
      } else if (msg.type === 'ERROR') {
        const p = currentPending
        currentPending = null
        currentId = null
        closeAll()
        p?.reject(new Error(`${msg.payload.code}: ${msg.payload.message}`))
      }
    })

    this.popup.open('/wallet/sign')

    watchdogId = setInterval(() => {
      if (closed) return
      if (!this.popup.isOpen) {
        const p = currentPending
        currentPending = null
        currentId = null
        closeAll()
        p?.reject(new Error('POPUP_CLOSED: user closed the wallet window'))
      }
    }, 500)

    return {
      send: (
        serializedTx: Uint8Array,
        options?: SignTransactionOptions,
      ): Promise<{ signature: string }> => {
        if (closed) return Promise.reject(new Error('CANCELLED: batch session is closed'))
        if (currentPending) return Promise.reject(new Error('Previous send() is still pending — batch is single-in-flight'))
        return new Promise<{ signature: string }>((resolve, reject) => {
          const id = this.popup.generateId()
          currentId = id
          currentPending = { resolve, reject }
          const message: SDKSignTransactionMessage = {
            type: 'SIGN_TRANSACTION',
            id,
            payload: this.buildSignTxPayload(serializedTx, options),
          }
          if (ready) {
            this.popup.send(message)
          } else {
            queuedMessage = message
          }
        })
      },
      cancel: (reason?: string): void => {
        const p = currentPending
        currentPending = null
        currentId = null
        closeAll()
        p?.reject(new Error(`CANCELLED: ${reason ?? 'batch session cancelled'}`))
      },
    }
  }

  /** Convenience wrapper over {@link beginSignTransaction} for callers whose
   * tx bytes are ready in the same tick as the user click. Most async
   * tx-build flows should use `beginSignTransaction()` directly. */
  async signTransaction(
    serializedTx: Uint8Array,
    options?: SignTransactionOptions,
  ): Promise<{ signature: string }> {
    return this.beginSignTransaction().send(serializedTx, options)
  }

  async signAndSendTransaction(
    serializedTx: Uint8Array,
    options?: SignTransactionOptions,
  ): Promise<string> {
    const { signature } = await this.signTransaction(serializedTx, options)
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
    this._walletAddress = null
    this._accountAddress = null
    this._session = null
    this.popup.close()
    this.emit('disconnect')
  }

  /**
   * Re-prime in-memory state from a previously-persisted `connect()` payload.
   * Use after a page reload where the dApp held on to the addresses + JWT
   * (e.g. in sessionStorage) but the SDK has lost its runtime state — call
   * before any `beginSign*()` so it passes `assertConnected()` without
   * re-running WebAuthn.
   *
   * Silent: does NOT emit `connect` / `session`. Those fire on fresh popup
   * auth only; subscribers wired to re-init UI on `connect` should not run
   * again on a session restore.
   */
  restoreSession(state: {
    publicKey: VaultPda
    walletAddress: VaultPda
    accountAddress: StatePda
    session: SoulPassSession | null
  }): void {
    this._connected = true
    this._walletAddress = state.walletAddress
    this._accountAddress = state.accountAddress
    this._session = state.session
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
    publicKey: VaultPda
    walletAddress: VaultPda
    accountAddress: StatePda
    session?: SoulPassSession
  }): void {
    this._connected = true
    this._walletAddress = payload.walletAddress
    this._accountAddress = payload.accountAddress
    this._session = payload.session ?? null
    this.emit('connect', payload.walletAddress)
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

  private buildSignTxPayload(
    serializedTx: Uint8Array,
    options?: SignTransactionOptions,
  ): SDKSignTransactionMessage['payload'] {
    return {
      transaction: uint8ArrayToBase64(serializedTx),
      ...this.signContext,
      ...(options?.altAddresses ? { altAddresses: options.altAddresses } : {}),
      // Omit when absent so older popup builds fall back to the disc=1 Execute path.
      ...(options?.ephemeralSignerBumps && options.ephemeralSignerBumps.length > 0
        ? { ephemeralSignerBumps: options.ephemeralSignerBumps }
        : {}),
    }
  }

  /**
   * Generic two-phase sign session. `buildMessage` and `parseSuccess` adapt
   * the shared state machine to per-flow message types so SIGN_TRANSACTION
   * and SIGN_MESSAGE can share the popup-ready / queue / cleanup wiring.
   *
   * `O` carries per-`send()` options (currently only SIGN_TRANSACTION uses
   * this for `altAddresses`); SIGN_MESSAGE callers parameterize as `void` and
   * ignore the third arg.
   */
  private beginSign<R, O = void>(
    path: string,
    buildMessage: (id: string, data: Uint8Array, options?: O) => SDKSignTransactionMessage | SDKSignMessageMessage,
    parseSuccess: (msg: Extract<PopupMessage, { type: 'SIGN_SUCCESS' }>) => R,
  ): { send: (data: Uint8Array, options?: O) => Promise<R>; cancel: (reason?: string) => void } {
    const id = this.popup.generateId()

    let popupReady = false
    // Stashed payload when send() is called before popup READY. Stored as the
    // prebuilt SDKMessage so onMessage doesn't need to re-thread `id`.
    let queuedMessage: SDKSignTransactionMessage | SDKSignMessageMessage | null = null
    let closed = false
    let sendCalled = false
    let pending: { resolve: (r: R) => void; reject: (e: Error) => void } | null = null
    // Watchdog so a popup the user closes manually (OS chrome ✕) — which
    // emits no postMessage — doesn't leave `pending` permanently unresolved.
    // Reset on cleanup so we don't double-poll after explicit cancel/success.
    let closedWatchdog: ReturnType<typeof setInterval> | null = null

    const cleanup = () => {
      if (closed) return
      closed = true
      if (closedWatchdog !== null) {
        clearInterval(closedWatchdog)
        closedWatchdog = null
      }
      this.popup.close()
    }

    this.popup.onMessage((msg: PopupMessage) => {
      if (closed) return
      if (msg.type === 'READY') {
        popupReady = true
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

    this.popup.open(path)

    // Poll the popup window for an OS-level close. 500ms is fast enough that
    // the dApp sees a reject within a UI tick of the user closing, and slow
    // enough that the polling cost (~1 boolean read per 500ms) is invisible.
    closedWatchdog = setInterval(() => {
      if (closed) return
      if (!this.popup.isOpen) {
        pending?.reject(new Error('POPUP_CLOSED: user closed the wallet window'))
        cleanup()
      }
    }, 500)

    return {
      send: (data: Uint8Array, options?: O) => {
        if (sendCalled) {
          return Promise.reject(new Error('Session already used — beginSign is single-shot'))
        }
        sendCalled = true
        if (closed) {
          return Promise.reject(new Error('CANCELLED: session was cancelled before send'))
        }
        return new Promise<R>((resolve, reject) => {
          pending = { resolve, reject }
          const message = buildMessage(id, data, options)
          if (popupReady) {
            this.popup.send(message)
          } else {
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
