/**
 * Typed error contract for the integration surface.
 *
 * Every rejection a dApp can observe from `connect()` / `beginSign*()` /
 * `session.send()` carries a machine-readable {@link SoulPassError.code} so
 * callers branch on `err.code`, never on message text. The wallet-flow
 * rejections that existed pre-0.3 keep their historical `"CODE: detail"`
 * message shape (built by {@link soulPassError}) so consumers that
 * string-match prefixes keep working unchanged; layers added after the typed
 * contract (payments, popup guards) construct {@link SoulPassError} directly.
 */

// Single source for the code inventory — the exported union type and the
// runtime Set `isSoulPassError` duck-types against are both derived from it,
// so a new code can't land in one and silently miss the other.
const SOULPASS_ERROR_CODE_LIST = [
  'USER_REJECTED', // user declined the request in the wallet popup or the app
  'PASSKEY_FAILED', // the WebAuthn passkey ceremony failed inside the wallet
  'NETWORK_ERROR', // wallet-side network failure (RPC, backend)
  'POPUP_CLOSED', // user closed the wallet window before answering
  'POPUP_BLOCKED', // window.open() blocked — ask the user to allow popups
  'CANCELLED', // the dApp cancelled the session via session.cancel()
  'SESSION_USED', // second send() on a single-shot session
  'SEND_IN_FLIGHT', // batch: previous send() still pending (single-in-flight)
  'NOT_CONNECTED', // beginSign*() called before connect() / restoreSession()
  'TIMEOUT', // dual-channel sign: no signer responded within the deadline
  'SIGN_FAILED', // the app-side signer reported a failure over the relay
  'IN_APP_BROWSER', // known-broken in-app browser (WeChat, Facebook, …)
  'NO_BROWSER', // no window — SSR or non-browser runtime
  'PROTOCOL_ERROR', // the wallet popup answered with a malformed payload
  'UNKNOWN', // wallet-side catch-all
] as const

/** Machine-readable failure category. Stable across SDK versions. */
export type SoulPassErrorCode = (typeof SOULPASS_ERROR_CODE_LIST)[number]

// Payment codes live here, not in payments/, for the same reason the wire
// types do: `err.code` is what callers branch on, so the inventory is public
// API surface, and `isSoulPassError` can only duck-type against a full set.
const PAYMENT_ERROR_CODE_LIST = [
  'INVALID_CLIENT_SECRET', // the client secret is unknown, expired or revoked
  'PAYMENT_INTENT_INVALID', // the intent failed client-side shape validation
  'PAYMENT_INTENT_NOT_PAYABLE', // already settled, cancelled or in flight
  'PAYMENT_INTENT_EXPIRED', // the merchant's quote window has passed
  'PAYMENT_INSUFFICIENT_FUNDS', // no offered route the payer can cover
  'PAYMENT_API_ERROR', // payment backend unreachable or misbehaving
  'PAYMENT_PREPARATION_FAILED', // the server could not lock an attempt
  'PAYMENT_AUTHORIZATION_FAILED', // the payer leg failed inside the wallet
  'PAYMENT_STATUS_UNKNOWN', // submitted, but confirmation was never observed
  'PAYMENT_FAILED', // the intent reached a terminal non-success state
  'PAYMENT_IN_PROGRESS', // a second pay()/beginPayment() while one is in flight
] as const

/** Payment-layer failure category. A refinement of {@link SoulPassErrorCode}. */
export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODE_LIST)[number]

const SOULPASS_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...SOULPASS_ERROR_CODE_LIST,
  ...PAYMENT_ERROR_CODE_LIST,
])

const PAYMENT_ERROR_CODES: ReadonlySet<string> = new Set<string>(PAYMENT_ERROR_CODE_LIST)

/** True for codes in the payment inventory. Kept next to the lists so the two
 * can't drift. */
export function isPaymentErrorCode(code: string): code is PaymentErrorCode {
  return PAYMENT_ERROR_CODES.has(code)
}

/**
 * Recovery context. Not payment-specific: a relay-leg `TIMEOUT` is as
 * retryable as an HTTP 503, and both want to carry their underlying cause.
 */
export interface SoulPassErrorContext {
  /** Safe to retry the same call. Never set once value may have moved. */
  retryable?: boolean
  /** Set when an operation may already have taken effect on-chain. Retrieve
   * rather than retry — this is how a lost response avoids a double charge. */
  transactionId?: string
  paymentIntentId?: string
  cause?: unknown
}

export class SoulPassError extends Error {
  readonly code: SoulPassErrorCode | PaymentErrorCode
  readonly retryable: boolean
  readonly transactionId?: string
  readonly paymentIntentId?: string
  override readonly cause?: unknown

  constructor(
    code: SoulPassErrorCode | PaymentErrorCode,
    message?: string,
    context: SoulPassErrorContext = {},
  ) {
    super(message ?? code)
    this.name = 'SoulPassError'
    this.code = code
    this.retryable = context.retryable ?? false
    this.transactionId = context.transactionId
    this.paymentIntentId = context.paymentIntentId
    this.cause = context.cause
  }
}

/**
 * Narrow an unknown rejection to {@link SoulPassError}. Prefer this over
 * `instanceof` at dApp boundaries — bundlers that duplicate the SDK module
 * (npm + vendored copy) break identity-based checks, while the code shape
 * survives. Subclasses (e.g. `InAppBrowserError`) override `name`, so the
 * duck-type leg keys on a known code, not the name. Payment codes are part of
 * the same inventory, so this narrows every rejection the SDK can produce.
 */
export function isSoulPassError(err: unknown): err is SoulPassError {
  if (err instanceof SoulPassError) return true
  return (
    err instanceof Error &&
    SOULPASS_ERROR_CODES.has((err as { code?: unknown }).code as string)
  )
}

/** Builds the historical `"CODE: detail"` message shape pre-0.3 string-matchers
 * rely on — the prefix rule lives here, next to the contract that declares it,
 * not restated at each throw site. Used by the wallet popup flows; layers whose
 * messages postdate the typed contract construct SoulPassError directly. */
export function soulPassError(code: SoulPassErrorCode | PaymentErrorCode, detail: string): SoulPassError {
  return new SoulPassError(code, `${code}: ${detail}`)
}

// Kept next to the code inventory so a future "the payer walked away" code
// can't land in the list and silently miss this classification.
const USER_DECLINED_CODES: ReadonlySet<string> = new Set<string>([
  'USER_REJECTED',
  'POPUP_CLOSED',
  'CANCELLED',
] satisfies SoulPassErrorCode[])

/**
 * True when a rejection means "the payer changed their mind", not "something
 * went wrong". Showing an error state for these is the single most common
 * checkout bug — branch on this instead of rediscovering the code list.
 */
export function isUserDeclined(err: unknown): boolean {
  return isSoulPassError(err) && USER_DECLINED_CODES.has(err.code)
}
