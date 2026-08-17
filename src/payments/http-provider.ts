// Response Standard v1: the server projects each business code to a semantic
// HTTP status, which is what makes `retryable` an answer rather than a guess.
// The body is unchanged either way, so nothing below may stop parsing it: a
// v1 error response still carries the merchant-facing message.
import { RESPONSE_MODE_HEADER, RESPONSE_MODE_HTTP_STATUS_V1 } from '../matrix-http'
import { PaymentError } from './errors'
import type {
  CompletePaymentInput,
  CreatedPaymentIntent,
  CreateDirectPaymentInput,
  HttpPaymentIntentProviderConfig,
  PaymentFetch,
  PaymentIntent,
  PaymentIntentProvider,
  PreparedPayment,
  PreparePaymentInput,
  RetrievedPaymentIntent,
} from './types'

interface ResponseEnvelope<T> {
  code: number
  message?: string
  data?: T
  success: boolean
}

/**
 * PaymentIntent lives in matrix-system, so the gateway path carries that
 * service context (`/api/system/v1/...`) exactly like the sign-channel relay
 * carries `/user/v1/...`. Dropping it routes to a 404. Single source: the
 * factory joins with it and the 404 diagnostic below derives its example from
 * it, so the convention can't drift between the two.
 */
export const PAYMENT_API_SERVICE_PATH = '/system/v1'

/** Payment API base for a platform API root (e.g. `https://api.soulpass.ai/api`).
 * Collapses a trailing slash before joining — `normalizeBaseUrl()` only trims
 * the joined URL's tail. */
export function paymentApiBaseFromRoot(apiRoot: string): string {
  return `${apiRoot.replace(/\/$/, '')}${PAYMENT_API_SERVICE_PATH}`
}

interface ErrorEnvelope {
  message?: string
  error?: { message?: string }
}

/**
 * HTTP adapter matching matrix-backend's `ResponseVo<T>` contract exactly, and
 * speaking Matrix HTTP Response Standard v1 on the wire: it asks for semantic
 * HTTP statuses and reads the envelope on every response, 2xx or not.
 */
export class HttpPaymentIntentProvider implements PaymentIntentProvider {
  private readonly baseUrl: string
  private readonly fetchImpl: PaymentFetch
  private readonly extraHeaders: Readonly<Record<string, string>>

  constructor(config: HttpPaymentIntentProviderConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl)
    const fetchImpl = config.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new PaymentError('PAYMENT_API_ERROR', 'No fetch implementation is available for the payment provider.')
    }
    this.fetchImpl = fetchImpl.bind(globalThis)
    this.extraHeaders = config.headers ?? {}
  }

  createDirect(input: CreateDirectPaymentInput): Promise<CreatedPaymentIntent> {
    return this.post<CreatedPaymentIntent>('/payment-intents/direct', {
      // The public create endpoint is authenticated by idempotency key, not by
      // a client secret — that secret is what this call returns. Because no
      // secret is sent, a 401/403/404 here must never be reported as
      // INVALID_CLIENT_SECRET (see classifyHttpError).
      credentialed: false,
      headers: { 'Idempotency-Key': input.idempotencyKey },
      payload: {
        amount: input.amount,
        currency: input.currency,
        settlementOptions: input.settlementOptions,
        ...(input.reference ? { reference: input.reference } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.expiresInSeconds ? { expiresInSeconds: input.expiresInSeconds } : {}),
        ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
      },
      networkMessage: 'Could not create the payment session.',
    })
  }

  retrieve(clientSecret: string): Promise<RetrievedPaymentIntent> {
    return this.post<RetrievedPaymentIntent>('/payment-intents/retrieve', {
      headers: { 'X-SoulPass-Client-Secret': clientSecret },
    })
  }

  prepare(clientSecret: string, input: PreparePaymentInput): Promise<PreparedPayment> {
    return this.post<PreparedPayment>('/payment-intents/prepare', {
      headers: { 'X-SoulPass-Client-Secret': clientSecret },
      payload: {
        settlementOptionId: input.settlementOptionId,
        payerAddress: input.payerAddress,
      },
    })
  }

  complete(input: CompletePaymentInput): Promise<PaymentIntent> {
    return this.post<PaymentIntent>('/payment-intents/complete', {
      headers: { 'X-SoulPass-Client-Secret': input.clientSecret },
      payload: {
        paymentIntentId: input.paymentIntentId,
        attemptId: input.attemptId,
        transactionId: input.transactionId,
      },
    })
  }

  /** The single HTTP path — every endpoint differs only in auth header and body. */
  private async post<T>(
    path: string,
    options: {
      headers: Readonly<Record<string, string>>
      payload?: Readonly<Record<string, unknown>>
      networkMessage?: string
      /** False only for the public create endpoint, which sends no client
       * secret and therefore cannot fail because of one. Defaults to true. */
      credentialed?: boolean
    },
  ): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          ...this.extraHeaders,
          'Content-Type': 'application/json',
          [RESPONSE_MODE_HEADER]: RESPONSE_MODE_HTTP_STATUS_V1,
          ...options.headers,
        },
        body: options.payload ? JSON.stringify(options.payload) : undefined,
      })
    } catch (cause) {
      throw new PaymentError(
        'PAYMENT_API_ERROR',
        options.networkMessage ?? 'Could not reach the payment API.',
        { retryable: true, cause },
      )
    }

    const body = await parseJson(response)
    if (!response.ok) {
      throw classifyHttpError(response.status, readErrorMessage(body), options.credentialed ?? true)
    }
    if (!isResponseEnvelope<T>(body)) {
      throw new PaymentError('PAYMENT_API_ERROR', 'Payment API returned an invalid response envelope.')
    }
    if (!body.success) {
      throw new PaymentError(
        'PAYMENT_API_ERROR',
        readErrorMessage(body) ?? `Payment API request failed (${body.code}).`,
      )
    }
    if (body.data === undefined || body.data === null) {
      throw new PaymentError('PAYMENT_API_ERROR', 'Payment API response data is missing.')
    }
    return body.data
  }
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new PaymentError('PAYMENT_API_ERROR', 'Payment API baseUrl is invalid.')
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new PaymentError('PAYMENT_API_ERROR', 'Payment API baseUrl must use HTTPS (HTTP is allowed only on localhost).')
  }
  if (parsed.search || parsed.hash) {
    throw new PaymentError('PAYMENT_API_ERROR', 'Payment API baseUrl cannot contain a query string or fragment.')
  }
  return parsed.toString().replace(/\/$/, '')
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (cause) {
    if (response.ok) {
      throw new PaymentError('PAYMENT_API_ERROR', 'Payment API returned invalid JSON.', { cause })
    }
    return null
  }
}

function isResponseEnvelope<T>(body: unknown): body is ResponseEnvelope<T> {
  if (!body || typeof body !== 'object') return false
  const envelope = body as Partial<ResponseEnvelope<T>>
  return typeof envelope.code === 'number' && typeof envelope.success === 'boolean'
}

function readErrorMessage(body: unknown): string | null {
  const envelope = body as ErrorEnvelope | null
  const message = envelope?.message ?? envelope?.error?.message
  return typeof message === 'string' && message.length <= 500 ? message : null
}

/**
 * HTTP status → payment error. Under `http-status-v1` the status is the
 * server's own projection of the business code, so this reads a semantic
 * result rather than guessing from a transport accident.
 *
 * The message always comes from the parsed envelope — a v1 failure response is
 * non-2xx but still carries the full `ResponseVo`, and dropping it would
 * replace the merchant's reason with a bare status number.
 *
 * matrix-backend expresses both "already settled/cancelled" and "quote window
 * passed" as business code 12003 (→ 409), so a genuinely expired intent
 * surfaces here as `PAYMENT_INTENT_NOT_PAYABLE`. The dedicated 410 mapping is
 * kept for deployments that distinguish them; nothing infers expiry from the
 * message text.
 */
function classifyHttpError(
  status: number,
  message: string | null,
  credentialed: boolean,
): PaymentError {
  const safeMessage = message ?? `Payment API request failed (${status}).`
  if (status === 401 || status === 403 || status === 404) {
    // The credential-less create endpoint cannot fail on a secret it never
    // sent — there a 401/403/404 almost always means the request never reached
    // the payment API (wrong paymentApiUrl, missing version segment, proxy).
    if (!credentialed) {
      return new PaymentError(
        'PAYMENT_API_ERROR',
        message
          ?? `Payment API rejected the create request (${status}). `
            + 'Check that paymentApiUrl points at the payment API version root '
            + `(for example https://api.soulpass.ai/api${PAYMENT_API_SERVICE_PATH}).`,
      )
    }
    return new PaymentError('INVALID_CLIENT_SECRET', safeMessage)
  }
  if (status === 409) return new PaymentError('PAYMENT_INTENT_NOT_PAYABLE', safeMessage)
  if (status === 410) return new PaymentError('PAYMENT_INTENT_EXPIRED', safeMessage)
  return new PaymentError('PAYMENT_API_ERROR', safeMessage, {
    retryable: isRetryableStatus(status),
  })
}

/**
 * Deliberately not `status >= 500`. v1 puts three different outcomes in the
 * 5xx range and only two of them can change on a retry:
 *
 *   - 500 server fault, 503 dependency unavailable → transient.
 *   - 501 is business code 700, "feature under development" → permanent, and
 *     retrying it is a guaranteed waste of the payer's time.
 *
 * 502/504 come from proxies ahead of the app and carry 503's meaning.
 */
function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true
  return status === 500 || status === 502 || status === 503 || status === 504
}
