// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import {
  PaymentWebhookError,
  assertPaymentWebhookMatchesOrder,
  verifyPaymentWebhook,
  type PaymentWebhookEvent,
} from '../src/payments/webhook'

// Body shape mirrors matrix-backend PaymentWebhookOutboxManager.payload().
const MERCHANT_SOL = '3BZpunigX3YomxFsjHegwLcng2s9EjGgWkJAZCqMJWcQ'
const MERCHANT_EVM = '0xAbCdEf0123456789abcdef0123456789ABCDEF01'

function event(overrides: {
  type?: string
  status?: string
  reference?: string | null
  value?: string
  currency?: string
  recipient?: string
  chainId?: string
  asset?: string
} = {}): PaymentWebhookEvent {
  const status = overrides.status ?? 'succeeded'
  return {
    id: 'evt_1',
    object: 'event',
    type: overrides.type ?? `payment_intent.${status}`,
    created: 1_760_000_000,
    data: {
      object: {
        id: 'pi_1',
        object: 'payment_intent',
        status,
        merchant_order_id: overrides.reference === undefined ? 'order-42' : overrides.reference,
        amount: { value: overrides.value ?? '10500000', decimals: 6, currency: overrides.currency ?? 'USDC' },
        metadata: {},
        transaction: {
          id: 'sig',
          rail: 'solana_spl',
          network: 'SOLANA',
          chain_type: 'SOLANA',
          chain_id: overrides.chainId ?? 'mainnet',
          asset: 'USDC',
          asset_address: overrides.asset ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          amount: '10500000',
          merchant_amount: '10500000',
          recipient: overrides.recipient ?? MERCHANT_SOL,
          protocol_fee: { basis_points: 0, amount: '0', recipient: null },
        },
      },
    },
  }
}

const ORDER = { reference: 'order-42', amount: '10.50', recipients: [MERCHANT_SOL, MERCHANT_EVM] }

describe('assertPaymentWebhookMatchesOrder', () => {
  it('accepts a succeeded payment of exactly this order to an owned address', () => {
    expect(() => assertPaymentWebhookMatchesOrder(event(), ORDER)).not.toThrow()
    // EVM addresses compare case-insensitively.
    expect(() => assertPaymentWebhookMatchesOrder(
      event({ recipient: MERCHANT_EVM.toLowerCase() }), ORDER,
    )).not.toThrow()
  })

  // Each row is the forged-webhook attack from the audit: a genuinely signed
  // event for a payment the attacker created against the merchant's webhook.
  it.each([
    ['not_succeeded', event({ status: 'processing' })],
    ['reference_mismatch', event({ reference: 'someone-elses-order' })],
    ['reference_mismatch', event({ reference: null })],
    ['amount_mismatch', event({ value: '10000' })],
    ['currency_mismatch', event({ currency: 'USDT' })],
    ['recipient_mismatch', event({ recipient: 'AttackerAddress1111111111111111111111111111' })],
  ] as const)('rejects %s', (reason, forged) => {
    expect(() => assertPaymentWebhookMatchesOrder(forged, ORDER)).toThrow(
      expect.objectContaining({ reason }),
    )
  })

  it('treats "10.5" and "10.50" as the same price and rejects sub-unit precision', () => {
    expect(() => assertPaymentWebhookMatchesOrder(event(), { ...ORDER, amount: '10.5' })).not.toThrow()
    expect(() => assertPaymentWebhookMatchesOrder(event(), { ...ORDER, amount: '10.5000001' }))
      .toThrow(expect.objectContaining({ reason: 'amount_mismatch' }))
  })

  it('never accepts a zero expected amount', () => {
    expect(() => assertPaymentWebhookMatchesOrder(event({ value: '0' }), { ...ORDER, amount: '0' }))
      .toThrow(expect.objectContaining({ reason: 'amount_mismatch' }))
  })

  it('fails closed with malformed_body on a hand-parsed event missing fields', () => {
    const broken = { ...event(), data: { object: { id: 'pi_1', status: 'succeeded' } } }
    expect(() => assertPaymentWebhookMatchesOrder(broken as unknown as PaymentWebhookEvent, ORDER))
      .toThrow(expect.objectContaining({ reason: 'malformed_body' }))
  })

  it('enforces an asset allowlist when given', () => {
    const assets = [{ chainId: 'mainnet', assetAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }]
    expect(() => assertPaymentWebhookMatchesOrder(event(), { ...ORDER, assets })).not.toThrow()
    expect(() => assertPaymentWebhookMatchesOrder(event({ chainId: 'devnet' }), { ...ORDER, assets }))
      .toThrow(expect.objectContaining({ reason: 'asset_mismatch' }))
  })
})

describe('verifyPaymentWebhook', () => {
  let keyPair: CryptoKeyPair
  let publicKeyHex: string
  const KEY_ID = 'pwk_test'
  const NOW = 1_760_000_000

  beforeAll(async () => {
    keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey))
    publicKeyHex = Buffer.from(raw).toString('hex')
  })

  async function sign(t: number, body: string): Promise<string> {
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, new TextEncoder().encode(`${t}.${body}`))
    return `t=${t},ed25519=${Buffer.from(new Uint8Array(sig)).toString('hex')}`
  }

  const body = JSON.stringify(event())

  it('returns the event for a genuine delivery (Headers or Node record)', async () => {
    const signature = await sign(NOW, body)
    const keys = [{ keyId: KEY_ID, algorithm: 'ed25519', publicKey: publicKeyHex }]
    const viaHeaders = await verifyPaymentWebhook({
      rawBody: body,
      headers: new Headers({ 'SoulPass-Signature': signature, 'SoulPass-Key-Id': KEY_ID }),
      keys,
      nowSeconds: NOW,
    })
    expect(viaHeaders.data.object.id).toBe('pi_1')
    const viaRecord = await verifyPaymentWebhook({
      rawBody: new TextEncoder().encode(body),
      headers: { 'soulpass-signature': signature, 'soulpass-key-id': KEY_ID },
      keys,
      nowSeconds: NOW + 60,
    })
    expect(viaRecord.type).toBe('payment_intent.succeeded')
  })

  it('rejects a tampered body, a stale timestamp, and an unknown key', async () => {
    const signature = await sign(NOW, body)
    const keys = [{ keyId: KEY_ID, publicKey: publicKeyHex }]
    const headers = { 'soulpass-signature': signature, 'soulpass-key-id': KEY_ID }
    await expect(verifyPaymentWebhook({
      rawBody: body.replace('10500000', '99999999'), headers, keys, nowSeconds: NOW,
    })).rejects.toMatchObject({ reason: 'bad_signature' })
    await expect(verifyPaymentWebhook({
      rawBody: body, headers, keys, nowSeconds: NOW + 301,
    })).rejects.toMatchObject({ reason: 'timestamp_out_of_tolerance' })
    await expect(verifyPaymentWebhook({
      rawBody: body, headers: { ...headers, 'soulpass-key-id': 'pwk_other' }, keys, nowSeconds: NOW,
    })).rejects.toBeInstanceOf(PaymentWebhookError)
    await expect(verifyPaymentWebhook({
      rawBody: body, headers: { 'soulpass-signature': 't=1,v1=abc', 'soulpass-key-id': KEY_ID }, keys, nowSeconds: NOW,
    })).rejects.toMatchObject({ reason: 'malformed_signature' })
  })
})
