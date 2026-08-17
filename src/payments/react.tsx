/**
 * `@soulpass/passkey-sdk/payments-react` — the checkout button, as a hook.
 *
 * A separate entry from `/react` on purpose. That provider owns a connection ceremony
 * and a wallet instance; a Web2 checkout has neither and should not pull either into its
 * bundle. Payments needs no `connect()`, no provider, and no state that outlives one
 * click — so this is one hook, not a context.
 *
 * The one thing it must not get wrong is user activation: `pay()` opens the wallet popup,
 * and a browser only grants that inside the synchronous part of a click handler. Every
 * line of `pay` below runs before the first await for that reason.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { isSoulPassError, isUserDeclined } from '../errors'
import { PaymentError } from './errors'
import { SoulPassPayments } from './client'
import { createSoulPassPayments, type CreateSoulPassPaymentsConfig } from './factory'
import type { DirectPaymentInput, PaymentIntent, PaymentResult } from './types'

export interface UseSoulPassPaymentsResult {
  /**
   * Start a checkout. Call directly in a click handler — never after an `await`,
   * or the browser drops the popup grant and the payment cannot open.
   *
   * Resolves with the settled payment, or `null` when the payer declined. It does not
   * reject for declines, so the common case needs no try/catch at all.
   */
  pay: (input: DirectPaymentInput) => Promise<PaymentResult | null>
  /** True between the click and the settled payment. Drive the button's disabled state. */
  paying: boolean
  /** The settled payment, kept until the next `pay()` or `reset()`. */
  result: PaymentResult | null
  /**
   * The last failure, excluding declines. Already narrowed: `error.code` is a
   * `SoulPassError` code when `isSoulPassError(error)`.
   */
  error: Error | null
  /**
   * True when the last attempt ended because funds may have moved but confirmation did
   * not finish. Do not charge again — call `recover()`.
   */
  statusUnknown: boolean
  /**
   * The PaymentIntent behind `statusUnknown`, already extracted from the error so no
   * cast is needed. Null whenever `statusUnknown` is false.
   */
  unknownPaymentIntentId: string | null
  /**
   * Re-read canonical state for a payment this browser tab started. With no argument
   * it targets the current status-unknown payment; pass an id to reconcile another
   * intent this tab created.
   */
  recover: (paymentIntentId?: string) => Promise<PaymentIntent>
  reset: () => void
  /** The underlying client, for anything this hook does not surface. */
  payments: SoulPassPayments
}

/**
 * @param config forwarded to `createSoulPassPayments`. Read once per distinct set of
 *   values — passing a fresh object literal every render is fine and expected, which is
 *   why the memo key is the fields rather than the object.
 */
export function useSoulPassPayments(
  config: CreateSoulPassPaymentsConfig = {},
): UseSoulPassPaymentsResult {
  const payments = useMemo(
    () => createSoulPassPayments(config),
    // 依赖是字段而非 config 对象本身，见上方注释。
    [
      config.walletUrl,
      config.apiUrl,
      config.paymentApiUrl,
      config.productType,
      config.confirmationTimeoutMs,
      config.confirmationPollIntervalMs,
      config.preferredNetworks?.join(','),
    ],
  )

  const [paying, setPaying] = useState(false)
  const [result, setResult] = useState<PaymentResult | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [statusUnknown, setStatusUnknown] = useState(false)
  const [unknownPaymentIntentId, setUnknownPaymentIntentId] = useState<string | null>(null)
  // Mirror of unknownPaymentIntentId for recover(): a callback created before the
  // status-unknown render must still see the id at call time.
  const unknownIntentRef = useRef<string | null>(null)
  // A second click while a popup is open would open a second popup and start a second
  // charge. State cannot guard that — it has not re-rendered yet when the second click
  // arrives in the same tick.
  const inFlight = useRef(false)

  const reset = useCallback(() => {
    setResult(null)
    setError(null)
    setStatusUnknown(false)
    setUnknownPaymentIntentId(null)
    unknownIntentRef.current = null
  }, [])

  const pay = useCallback(
    (input: DirectPaymentInput): Promise<PaymentResult | null> => {
      if (inFlight.current) return Promise.resolve(null)
      inFlight.current = true
      setPaying(true)
      setResult(null)
      setError(null)
      setStatusUnknown(false)
      setUnknownPaymentIntentId(null)
      unknownIntentRef.current = null
      // Not awaited before this line: `pay()` reserves the popup synchronously.
      return payments
        .pay(input)
        .then((settled) => {
          setResult(settled)
          return settled
        })
        .catch((cause: unknown) => {
          // Declines resolve to null instead of setting `error` — showing an
          // error for "the payer changed their mind" is the most common
          // checkout bug, and the code list lives in errors.ts, not here.
          if (isUserDeclined(cause)) return null
          if (isSoulPassError(cause) && cause.code === 'PAYMENT_STATUS_UNKNOWN') {
            setStatusUnknown(true)
            setUnknownPaymentIntentId(cause.paymentIntentId ?? null)
            unknownIntentRef.current = cause.paymentIntentId ?? null
          }
          setError(cause instanceof Error ? cause : new Error(String(cause)))
          return null
        })
        .finally(() => {
          inFlight.current = false
          setPaying(false)
        })
    },
    [payments],
  )

  const recover = useCallback(
    (paymentIntentId?: string) => {
      const target = paymentIntentId ?? unknownIntentRef.current
      if (!target) {
        return Promise.reject(new PaymentError(
          'PAYMENT_INTENT_INVALID',
          'No status-unknown payment to recover. Pass a paymentIntentId explicitly.',
        ))
      }
      return payments.retrieveDirectPayment(target)
    },
    [payments],
  )

  return {
    pay,
    paying,
    result,
    error,
    statusUnknown,
    unknownPaymentIntentId,
    recover,
    reset,
    payments,
  }
}
