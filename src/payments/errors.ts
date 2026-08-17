import { SoulPassError, isPaymentErrorCode } from '../errors'
import type { PaymentErrorCode, SoulPassErrorContext } from '../errors'

export type { PaymentErrorCode }
/** @deprecated Use {@link SoulPassErrorContext}. */
export type PaymentErrorContext = SoulPassErrorContext

/**
 * Payment-layer failure with enough context to recover safely.
 *
 * A subclass of {@link SoulPassError} rather than a parallel hierarchy: one
 * `await soulpass.pay()` can reject with a wallet-side code (`POPUP_BLOCKED`,
 * `USER_REJECTED`) or a payment-side one, and a caller should need exactly one
 * `catch` shape for both.
 *
 * A transaction id on `PAYMENT_STATUS_UNKNOWN` means value may already have
 * moved. The caller must retrieve the PaymentIntent instead of starting a new
 * payment, which is how the SDK avoids turning a response-loss into a double
 * charge.
 */
export class PaymentError extends SoulPassError {
  override readonly code: PaymentErrorCode

  constructor(
    code: PaymentErrorCode,
    message: string,
    context: SoulPassErrorContext = {},
  ) {
    super(code, message, context)
    this.name = 'PaymentError'
    this.code = code
  }
}

/**
 * Narrow to a payment-layer failure. Prefer `isSoulPassError` at dApp
 * boundaries — it covers wallet-side rejections too; use this only when the
 * branch genuinely needs the payment inventory (e.g. reading `paymentIntentId`).
 */
export function isPaymentError(err: unknown): err is PaymentError {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && isPaymentErrorCode(code)
}
