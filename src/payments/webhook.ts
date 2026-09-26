/**
 * Server-side verification for direct-mode payment webhooks.
 *
 * Two independent questions, and a merchant must answer both before fulfilling:
 *
 * 1. **Did SoulPass send this?** — {@link verifyPaymentWebhook} checks the
 *    platform Ed25519 signature over `"{t}.{rawBody}"` and the timestamp window.
 * 2. **Is it a payment for MY order, to ME?** — {@link assertPaymentWebhookMatchesOrder}.
 *
 * The second is not implied by the first. Direct-mode create takes no
 * credential, and its webhook-domain check keys off the request `Origin`, which
 * any non-browser client can forge. A signed `payment_intent.succeeded` event
 * therefore proves only that *some* payment settled on-chain exactly as the
 * event describes — possibly one an attacker created with your webhook URL,
 * your order id as `reference`, their own address as recipient, and a price of
 * one cent. Only the merchant knows the order, so only the merchant can reject
 * that: recipient, currency, amount and reference must all match the order your
 * server holds.
 *
 * Runs on any runtime with WebCrypto Ed25519 (Node ≥ 20, Deno, Bun, Workers).
 */

/** One published key from `GET /v1/payment-webhook-keys` (`data.keys[]`). */
export interface PaymentWebhookKey {
  /** Matches the `SoulPass-Key-Id` delivery header. */
  keyId: string
  /** Currently always `ed25519`. */
  algorithm?: string
  /** Hex-encoded raw 32-byte Ed25519 public key. */
  publicKey: string
}

/** Wire shape of the event body (snake_case, exactly as delivered). */
export interface PaymentWebhookEvent {
  id: string
  object: 'event'
  /** `payment_intent.<status>`, e.g. `payment_intent.succeeded`. */
  type: string
  created: number
  data: { object: PaymentWebhookPaymentIntent }
}

export interface PaymentWebhookPaymentIntent {
  id: string
  object: 'payment_intent'
  status: string
  /** The `reference` passed to `pay()`. When none was passed the server stores
   * its idempotency key here, which the merchant cannot match — so always pass
   * `reference` when you rely on the webhook. */
  merchant_order_id: string | null
  /** Price in smallest units: `value` is an integer string scaled by `decimals`. */
  amount: { value: string; decimals: number; currency: string }
  metadata: Record<string, unknown>
  transaction: {
    id: string | null
    rail: string
    network: string
    chain_type: string
    chain_id: string
    asset: string
    asset_address: string
    /** Gross debit from the payer, smallest units. */
    amount: string
    /** What the recipient receives after the protocol fee, smallest units. */
    merchant_amount: string
    recipient: string
    protocol_fee: { basis_points: number | null; amount: string | null; recipient: string | null }
  }
  failure?: { code: string | null; reason: string | null }
}

export type PaymentWebhookFailureReason =
  | 'missing_header'
  | 'malformed_signature'
  | 'timestamp_out_of_tolerance'
  | 'unknown_key'
  | 'bad_signature'
  | 'malformed_body'
  | 'crypto_unavailable'
  | 'not_succeeded'
  | 'reference_mismatch'
  | 'currency_mismatch'
  | 'amount_mismatch'
  | 'recipient_mismatch'
  | 'asset_mismatch'

/** Thrown by the verifiers. Respond non-2xx and do NOT fulfil. */
export class PaymentWebhookError extends Error {
  readonly reason: PaymentWebhookFailureReason

  constructor(reason: PaymentWebhookFailureReason, message: string) {
    super(message)
    this.name = 'PaymentWebhookError'
    this.reason = reason
  }
}

type HeaderSource =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>

export interface VerifyPaymentWebhookInput {
  /** The request body exactly as received — never a re-serialized JSON object. */
  rawBody: string | Uint8Array
  /** A Fetch `Headers`, or a Node-style header record. */
  headers: HeaderSource
  /** From `GET /v1/payment-webhook-keys`; cache it and refetch on an unknown key id. */
  keys: readonly PaymentWebhookKey[]
  /** Accepted clock skew / replay window. Default 300 seconds. */
  toleranceSeconds?: number
  /** Injected clock, seconds since the epoch. Defaults to now. */
  nowSeconds?: number
}

const SIGNATURE_HEADER = 'soulpass-signature'
const KEY_ID_HEADER = 'soulpass-key-id'

/**
 * Authenticate a delivery and return its parsed event. Throws
 * {@link PaymentWebhookError} on any failure. This alone is NOT permission to
 * fulfil — follow it with {@link assertPaymentWebhookMatchesOrder}.
 */
export async function verifyPaymentWebhook(
  input: VerifyPaymentWebhookInput,
): Promise<PaymentWebhookEvent> {
  const signatureHeader = readHeader(input.headers, SIGNATURE_HEADER)
  const keyId = readHeader(input.headers, KEY_ID_HEADER)
  if (!signatureHeader || !keyId) {
    throw new PaymentWebhookError('missing_header', 'SoulPass-Signature and SoulPass-Key-Id are required.')
  }
  const { timestamp, signature } = parseSignatureHeader(signatureHeader)

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = input.toleranceSeconds ?? 300
  if (Math.abs(now - Number(timestamp)) > tolerance) {
    throw new PaymentWebhookError('timestamp_out_of_tolerance', 'Webhook timestamp is outside the accepted window.')
  }

  const key = input.keys.find((candidate) => candidate.keyId === keyId)
  if (!key || (key.algorithm !== undefined && key.algorithm.toLowerCase() !== 'ed25519')) {
    throw new PaymentWebhookError('unknown_key', `No ed25519 key published for key id ${keyId}.`)
  }
  const publicKey = hexToBytes(key.publicKey, 32)
  if (!publicKey) {
    throw new PaymentWebhookError('unknown_key', `Published key ${keyId} is not 32 hex-encoded bytes.`)
  }

  const body = typeof input.rawBody === 'string'
    ? new TextEncoder().encode(input.rawBody)
    : input.rawBody
  const prefix = new TextEncoder().encode(`${timestamp}.`)
  const message = new Uint8Array(prefix.length + body.length)
  message.set(prefix, 0)
  message.set(body, prefix.length)

  if (!(await ed25519Verify(publicKey, signature, message))) {
    throw new PaymentWebhookError('bad_signature', 'Webhook signature does not verify.')
  }

  let event: unknown
  try {
    event = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new PaymentWebhookError('malformed_body', 'Webhook body is not JSON.')
  }
  if (!isEventShape(event)) {
    throw new PaymentWebhookError('malformed_body', 'Webhook body is not a payment_intent event.')
  }
  return event
}

/** The order your server holds — the only source of truth for what to accept. */
export interface ExpectedPaymentOrder {
  /** The `reference` you passed to `pay()` for this order. */
  reference: string
  /** Human decimal price you charged, e.g. `"10.50"` — same string you passed to `pay()`. */
  amount: string
  /** Asset code you charged in. Default `USDC` (the `pay()` default). */
  currency?: string
  /** Every address you accept funds on (Solana base58 and/or EVM 0x). */
  recipients: readonly string[]
  /**
   * Optional allowlist of `(chain_id, asset_address)` pairs. Recommended when
   * you only reconcile specific chains; omitted, any asset the server resolved
   * for `currency` is accepted.
   */
  assets?: readonly { chainId: string; assetAddress: string }[]
}

/**
 * Throw unless a verified event is a *succeeded* payment of exactly this order
 * to one of your own addresses. Fulfil only when this returns.
 */
export function assertPaymentWebhookMatchesOrder(
  event: PaymentWebhookEvent,
  expected: ExpectedPaymentOrder,
): void {
  const intent = event.data.object
  if (event.type !== 'payment_intent.succeeded' || intent.status !== 'succeeded') {
    throw new PaymentWebhookError('not_succeeded', `Event ${event.type} is not a settled payment.`)
  }
  if (intent.merchant_order_id !== expected.reference) {
    throw new PaymentWebhookError('reference_mismatch', 'Event reference does not match this order.')
  }
  const currency = (expected.currency ?? 'USDC').trim().toUpperCase()
  if (String(intent.amount?.currency ?? '').toUpperCase() !== currency) {
    throw new PaymentWebhookError('currency_mismatch', 'Event currency does not match this order.')
  }
  const expectedAtomic = decimalToAtomic(expected.amount, intent.amount.decimals)
  if (expectedAtomic === null || intent.amount.value !== expectedAtomic) {
    throw new PaymentWebhookError('amount_mismatch', 'Event amount does not match this order.')
  }
  const recipient = intent.transaction?.recipient
  if (typeof recipient !== 'string' || !expected.recipients.some((own) => sameAddress(own, recipient))) {
    throw new PaymentWebhookError('recipient_mismatch', 'Funds did not go to an address you own.')
  }
  if (expected.assets) {
    const chainId = String(intent.transaction.chain_id)
    const asset = intent.transaction.asset_address
    const allowed = expected.assets.some(
      (candidate) => candidate.chainId === chainId && sameAddress(candidate.assetAddress, asset),
    )
    if (!allowed) {
      throw new PaymentWebhookError('asset_mismatch', 'Event settled on a chain/asset you do not accept.')
    }
  }
}

// --- internals ---

function readHeader(headers: HeaderSource, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(name: string): string | null }).get(name)
  }
  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name) continue
    if (typeof value === 'string') return value
    if (Array.isArray(value) && value.length === 1) return value[0]
    return null
  }
  return null
}

function parseSignatureHeader(header: string): { timestamp: string; signature: Uint8Array } {
  let timestamp: string | null = null
  let signatureHex: string | null = null
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name === 't') timestamp = value
    else if (name === 'ed25519') signatureHex = value
  }
  const signature = signatureHex === null ? null : hexToBytes(signatureHex, 64)
  if (timestamp === null || !/^\d{1,12}$/.test(timestamp) || !signature) {
    throw new PaymentWebhookError('malformed_signature', 'SoulPass-Signature must be "t=<seconds>,ed25519=<hex>".')
  }
  return { timestamp, signature }
}

function hexToBytes(hex: string, length: number): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length !== length * 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function ed25519Verify(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new PaymentWebhookError('crypto_unavailable', 'WebCrypto is not available in this runtime.')
  }
  let key: CryptoKey
  try {
    key = await subtle.importKey('raw', publicKey as BufferSource, { name: 'Ed25519' }, false, ['verify'])
  } catch {
    throw new PaymentWebhookError('crypto_unavailable', 'This runtime\'s WebCrypto does not support Ed25519 (Node ≥ 20 does).')
  }
  return subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, message as BufferSource)
}

function isEventShape(value: unknown): value is PaymentWebhookEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<PaymentWebhookEvent>
  const intent = event.data?.object as Partial<PaymentWebhookPaymentIntent> | undefined
  return (
    typeof event.type === 'string' &&
    !!intent &&
    typeof intent.id === 'string' &&
    typeof intent.status === 'string' &&
    !!intent.amount &&
    typeof intent.amount.value === 'string' &&
    Number.isInteger(intent.amount.decimals) &&
    !!intent.transaction &&
    typeof intent.transaction === 'object'
  )
}

/** `"10.5"` at 6 decimals → `"10500000"`; null if it cannot be represented exactly. */
function decimalToAtomic(value: string, decimals: number): string | null {
  if (typeof value !== 'string' || !Number.isInteger(decimals) || decimals < 0) return null
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return null
  const whole = match[1]
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  if (fraction.length > decimals) return null
  return BigInt(whole + fraction.padEnd(decimals, '0')).toString()
}

/** EVM hex addresses compare case-insensitively (EIP-55 is only a checksum);
 * everything else (Solana base58) is case-sensitive. */
function sameAddress(a: string, b: string): boolean {
  const evm = /^0x[0-9a-fA-F]{40}$/
  if (evm.test(a) && evm.test(b)) return a.toLowerCase() === b.toLowerCase()
  return a === b
}
