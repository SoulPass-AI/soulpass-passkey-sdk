import { PopupManager } from './popup-manager'
import { PopupSession } from './popup-session'
import { uint8ArrayToBase64 } from './encoding'
import { SoulPassError, soulPassError } from './errors'
import { deriveApiUrl } from './matrix-http'
import { SignChannelClient, generateChannelId, SIGN_CHANNEL_PARAM } from './sign-channel'
import type {
  SoulPassWalletConfig,
  PopupMessage,
  PopupErrorMessage,
  SoulPassSession,
  SDKMessage,
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
import type {
  PaymentAccount,
  PaymentAuthorizationSession,
  PaymentExecution,
  PaymentIntent,
} from './payment-wire'

type EventType = 'connect' | 'disconnect' | 'accountChanged' | 'session'
type EventHandler = (...args: any[]) => void

/** One unresolved request/response leg on an open popup session. */
type PendingReply<T> = {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

/**
 * Overall deadline for a dual-channel sign. The popup flow has no deadline
 * (the window's presence IS the liveness signal), but once the popup may have
 * been taken over by the iOS app via universal link there is no window to
 * watch — the relay poll needs a hard stop. Matches the relay channel TTL
 * (300s) so the SDK never keeps polling a channel the backend already
 * expired.
 */
const SIGN_CHANNEL_TIMEOUT_MS = 300_000

/** Popup ERROR payloads already carry a SoulPassErrorCode subset — lift them
 * into the typed contract. */
function popupError(payload: PopupErrorMessage['payload']): SoulPassError {
  return soulPassError(payload.code, payload.message)
}

// Once per page load, not per instance — a dApp that constructs the wallet in
// a React render path would otherwise spam the console on every re-render.
let productTypeWarned = false
function warnIfProductTypeMissing(config: SoulPassWalletConfig): void {
  if (config.productType || productTypeWarned) return
  productTypeWarned = true
  console.warn(
    '[SoulPass SDK] config.productType is not set. Third-party integrations ' +
      'can ignore this — your session is automatically scoped to your origin. ' +
      'First-party Matrix products must set their ProductType name (e.g. ' +
      "new SoulPassWallet({ productType: 'tens' })) so sessions land in their " +
      'canonical backend namespace.',
  )
}

export class SoulPassWallet {
  private config: Required<Pick<SoulPassWalletConfig, 'network'>> & SoulPassWalletConfig
  private popup: PopupManager
  /** Built once from the resolved wallet URL so the popup origin and the
   * derived API base can't drift between signs. */
  private signChannel: SignChannelClient
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
    this.signChannel = new SignChannelClient(config.apiUrl ?? deriveApiUrl(walletUrl))
    warnIfProductTypeMissing(config)
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
      const session = new PopupSession(this.popup)

      session.listen(() => id, (msg) => {
        if (msg.type === 'CONNECT_SUCCESS') {
          session.dispose()
          this.handleConnectSuccess(msg.payload)
          resolve(msg.payload)
        } else if (msg.type === 'ERROR') {
          session.dispose()
          reject(popupError(msg.payload))
        }
      })

      session.open('/wallet/connect')
      // Closing the popup via the OS ✕ emits no postMessage, so without the
      // watchdog the promise never settles and the dApp's "Connecting…"
      // state spins forever.
      session.watchClose(() => {
        session.dispose()
        reject(soulPassError('POPUP_CLOSED', 'user closed the wallet window'))
      })
      // Held by the session until the popup says READY.
      session.send({
        type: 'CONNECT',
        id,
        payload: {
          network: this.config.network,
          ...this.productTypeField,
        },
      })
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
    // The channel id rides in the sign URL so that when iOS takes the URL
    // over via universal link, the app knows which relay mailbox to claim.
    // Web popups ignore the param. Batch/message flows deliberately carry no
    // channel — the AASA component match (`?channel=?*`) leaves them in the
    // browser.
    const channelId = generateChannelId()
    return this.beginSign<{ signature: string }, SignTransactionOptions, SDKSignTransactionMessage>(
      `/wallet/sign?${SIGN_CHANNEL_PARAM}=${channelId}`,
      (id, data: Uint8Array, options?: SignTransactionOptions) => ({
        type: 'SIGN_TRANSACTION',
        id,
        payload: this.buildSignTxPayload(data, options),
      }),
      (msg) => ({ signature: msg.payload.signature }),
      (message, settle) => this.startRelayLeg(channelId, message.payload, settle),
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
          throw new SoulPassError('PROTOCOL_ERROR', 'SIGN_MESSAGE response missing WebAuthn fields')
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
   * Reserve SoulPass's complete checkout surface in the user's click tick.
   * Balance discovery and signing both stay inside the same `/wallet/pay`
   * popup, so a merchant never needs the wallet JWT, RPC keys, or chain SDKs.
   */
  beginPaymentAuthorization(): PaymentAuthorizationSession {
    const id = this.popup.generateId()
    const session = new PopupSession(this.popup)
    // Both legs are phases of one checkout, so they share a correlation id.
    let phase: 'idle' | 'discovering' | 'discovered' | 'executing' = 'idle'
    let discovery: PendingReply<readonly PaymentAccount[]> | null = null
    let execution: PendingReply<{ transactionId: string }> | null = null
    // A wallet ERROR can land between legs (e.g. the user rejects while the
    // SDK is mid-prepare), when neither promise is pending. Kept so the next
    // leg rejects with the wallet's own code instead of a generic CANCELLED.
    let terminalError: Error | null = null

    const rejectPending = (error: Error) => {
      discovery?.reject(error)
      discovery = null
      execution?.reject(error)
      execution = null
    }

    session.listen(() => id, (msg) => {
      if (msg.type === 'PAYMENT_ACCOUNTS') {
        phase = 'discovered'
        discovery?.resolve(msg.payload.accounts)
        discovery = null
      } else if (msg.type === 'PAYMENT_SUCCESS') {
        execution?.resolve({ transactionId: msg.payload.transactionId })
        execution = null
        session.dispose()
      } else if (msg.type === 'ERROR') {
        const error = popupError(msg.payload)
        terminalError = error
        rejectPending(error)
        // The wallet keeps its fatal-error screen open so the user can read
        // the explanation; the SDK detaches its channel but must not close a
        // window whose content the wallet still owns. Success and dApp-side
        // cancel still close it.
        session.dispose({ keepWindowOpen: true })
      }
    })

    session.open('/wallet/pay')
    session.watchClose(() => {
      rejectPending(soulPassError('POPUP_CLOSED', 'user closed the payment window'))
      session.dispose()
    })

    const leg = <T>(
      message: SDKMessage,
      bind: (pending: PendingReply<T>) => void,
    ): Promise<T> => {
      if (session.closed) {
        return Promise.reject(
          terminalError ?? soulPassError('CANCELLED', 'payment session is closed'),
        )
      }
      return new Promise<T>((resolve, reject) => {
        bind({ resolve, reject })
        session.send(message)
      })
    }

    return {
      getPaymentAccounts: (intent: PaymentIntent, displayToken: string) => {
        if (phase !== 'idle') {
          return Promise.reject(
            new SoulPassError('SESSION_USED', 'Payment account discovery is single-shot'),
          )
        }
        phase = 'discovering'
        // The relayed intent is only a first-paint hint. The popup fetches
        // canonical state with the display token and renders that, so a page
        // doctoring `intent` changes nothing the user actually reviews.
        return leg<readonly PaymentAccount[]>(
          { type: 'PAYMENT_DISCOVER', id, payload: { intent, displayToken } },
          (pending) => {
            discovery = pending
          },
        )
      },
      notifyPreparing: (settlementOptionId: string) => {
        if (phase !== 'discovered') return
        session.send({ type: 'PAYMENT_PREPARING', id, payload: { settlementOptionId } })
      },
      execute: (paymentExecution: PaymentExecution) => {
        if (phase === 'idle' || phase === 'discovering') {
          return Promise.reject(
            new SoulPassError(
              'PROTOCOL_ERROR',
              'Discover payment accounts before requesting authorization',
            ),
          )
        }
        if (phase === 'executing') {
          return Promise.reject(
            new SoulPassError('SESSION_USED', 'Payment execution is single-shot'),
          )
        }
        phase = 'executing'
        return leg<{ transactionId: string }>(
          { type: 'PAYMENT_EXECUTE', id, payload: { execution: paymentExecution } },
          (pending) => {
            execution = pending
          },
        )
      },
      cancel: (reason?: string) => {
        if (session.closed) return
        rejectPending(soulPassError('CANCELLED', reason ?? 'payment session cancelled'))
        session.dispose()
      },
    }
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

    const session = new PopupSession(this.popup)
    let currentPending: PendingReply<{ signature: string }> | null = null
    // Independent requests over one window, so each send mints a fresh id.
    let currentId: string | null = null

    const takePending = () => {
      const pending = currentPending
      currentPending = null
      currentId = null
      return pending
    }

    session.listen(() => currentId, (msg) => {
      if (msg.type === 'SIGN_SUCCESS') {
        // Popup stays open for the next sign — that is the point of a batch.
        takePending()?.resolve({ signature: msg.payload.signature })
      } else if (msg.type === 'ERROR') {
        const pending = takePending()
        session.dispose()
        pending?.reject(popupError(msg.payload))
      }
    })

    session.open('/wallet/sign')
    session.watchClose(() => {
      const pending = takePending()
      session.dispose()
      pending?.reject(soulPassError('POPUP_CLOSED', 'user closed the wallet window'))
    })

    return {
      send: (
        serializedTx: Uint8Array,
        options?: SignTransactionOptions,
      ): Promise<{ signature: string }> => {
        if (session.closed) return Promise.reject(soulPassError('CANCELLED', 'batch session is closed'))
        if (currentPending) return Promise.reject(new SoulPassError('SEND_IN_FLIGHT', 'Previous send() is still pending — batch is single-in-flight'))
        return new Promise<{ signature: string }>((resolve, reject) => {
          const id = this.popup.generateId()
          currentId = id
          currentPending = { resolve, reject }
          session.send({
            type: 'SIGN_TRANSACTION',
            id,
            payload: this.buildSignTxPayload(serializedTx, options),
          })
        })
      },
      cancel: (reason?: string): void => {
        const pending = takePending()
        session.dispose()
        pending?.reject(soulPassError('CANCELLED', reason ?? 'batch session cancelled'))
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
    if (!this._connected) throw new SoulPassError('NOT_CONNECTED', 'Wallet not connected')
  }

  private get signContext() {
    return {
      walletAddress: this._walletAddress!,
      network: this.config.network,
    }
  }

  /** Spread-conditional so wire payloads omit the key entirely when unset —
   * older popup builds strictly typecheck payloads and would trip on an
   * explicit `productType: undefined`. */
  private get productTypeField(): { productType?: string } {
    return this.config.productType ? { productType: this.config.productType } : {}
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
   * ignore the third arg. `M` pins the concrete message type so a
   * `secondLeg` sees the payload it was built for, without narrowing.
   *
   * `secondLeg` — an alternate delivery leg the flow may settle through
   * (today: the relay for dual-channel SIGN_TRANSACTION, see
   * {@link startRelayLeg}). Started in send(); first terminal answer across
   * legs wins. Its presence is the single signal that the popup may
   * legitimately die mid-flow: it suppresses the close watchdog and makes a
   * dead popup.send() non-fatal. Returns a disposer so the leg owns its own
   * resources and cleanup stays a fixed size however many legs a flow grows.
   */
  private beginSign<R, O = void, M extends SDKSignTransactionMessage | SDKSignMessageMessage = SDKSignTransactionMessage | SDKSignMessageMessage>(
    path: string,
    buildMessage: (id: string, data: Uint8Array, options?: O) => M,
    parseSuccess: (msg: Extract<PopupMessage, { type: 'SIGN_SUCCESS' }>) => R,
    secondLeg?: (
      message: M,
      settle: (outcome: { result: R } | { error: Error }) => void,
    ) => () => void,
  ): { send: (data: Uint8Array, options?: O) => Promise<R>; cancel: (reason?: string) => void } {
    const id = this.popup.generateId()

    let sendCalled = false
    let pending: PendingReply<R> | null = null
    let disposeSecondLeg: (() => void) | null = null

    const session = new PopupSession(this.popup)
    const cleanup = () => {
      if (session.closed) return
      if (disposeSecondLeg !== null) {
        disposeSecondLeg()
        disposeSecondLeg = null
      }
      session.dispose()
    }

    session.listen(() => id, (msg) => {
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
        pending?.reject(popupError(msg.payload))
        cleanup()
      }
    })

    session.open(path)

    // Second-leg flows arm no close watchdog at all: iOS grabbing the sign
    // URL via universal link kills (or blanks) the popup without any
    // postMessage — the EXPECTED shape of the app flow, not a user rejection.
    // The second leg carries the session; only its terminal answer or its
    // deadline ends the flow.
    if (!secondLeg) {
      session.watchClose(() => {
        pending?.reject(soulPassError('POPUP_CLOSED', 'user closed the wallet window'))
        cleanup()
      })
    }

    return {
      send: (data: Uint8Array, options?: O) => {
        if (sendCalled) {
          return Promise.reject(new SoulPassError('SESSION_USED', 'Session already used — beginSign is single-shot'))
        }
        sendCalled = true
        if (session.closed) {
          return Promise.reject(soulPassError('CANCELLED', 'session was cancelled before send'))
        }
        return new Promise<R>((resolve, reject) => {
          pending = { resolve, reject }
          const message = buildMessage(id, data, options)
          try {
            session.send(message)
          } catch (err) {
            // With a second leg the popup may already be dead (takeover) —
            // that leg is the flow now, so a dead postMessage must not
            // reject. Without one there is nothing to fall back to, so the
            // failure has to surface.
            if (!secondLeg) throw err
          }
          if (secondLeg) {
            disposeSecondLeg = secondLeg(message, (outcome) => {
              if (session.closed) return
              if ('error' in outcome) {
                pending?.reject(outcome.error)
              } else {
                pending?.resolve(outcome.result)
              }
              cleanup()
            })
          }
        })
      },
      cancel: (reason?: string) => {
        if (session.closed) return
        if (pending) {
          pending.reject(soulPassError('CANCELLED', reason ?? 'session cancelled'))
        }
        cleanup()
      },
    }
  }

  /**
   * Second leg of a dual-channel sign: mirror the payload to the relay and
   * poll for the app's answer. First terminal answer across both legs wins;
   * the popup listener guards on `closed` exactly like `settle` does, so
   * whichever settles first cleans up and the loser becomes a no-op.
   *
   * Returns a disposer that aborts the poll and clears the deadline — the leg
   * owns its own resources instead of parking them in the caller's closure.
   */
  private startRelayLeg(
    channelId: string,
    payload: SDKSignTransactionMessage['payload'],
    settle: (outcome: { result: { signature: string } } | { error: Error }) => void,
  ): () => void {
    const abort = new AbortController()

    // Poll only after the payload lands: starting both in the same tick
    // guarantees a first GET that races the POST creating the channel and can
    // only ever come back `pending`. A PUT that didn't land means the mailbox
    // doesn't exist — no app can ever answer, so skip the poll entirely and
    // let the popup leg or the deadline end the flow.
    void (async () => {
      const delivered = await this.signChannel.putPayload(channelId, {
        // `payload` is already normalized by buildSignTxPayload (optional
        // fields omitted, not undefined) — spread it rather than restating
        // that policy here.
        ...payload,
        ...this.productTypeField,
      })
      if (!delivered) return
      let result
      try {
        result = await this.signChannel.pollResult(channelId, { signal: abort.signal })
      } catch {
        return // aborted — the popup leg won or the session was cancelled
      }
      if (result.status === 'completed' && result.signature) {
        settle({ result: { signature: result.signature } })
      } else if (result.status === 'cancelled') {
        settle({ error: soulPassError('USER_REJECTED', 'cancelled in app') })
      } else {
        settle({
          error: soulPassError('SIGN_FAILED', result.message ?? 'app signer failed'),
        })
      }
    })()

    const deadline = setTimeout(
      () => settle({ error: soulPassError('TIMEOUT', 'no signer responded') }),
      SIGN_CHANNEL_TIMEOUT_MS,
    )

    return () => {
      abort.abort()
      clearTimeout(deadline)
    }
  }

  private emit(event: EventType, ...args: any[]): void {
    this.events.get(event)?.forEach(handler => handler(...args))
  }
}

// --- Helpers ---

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
