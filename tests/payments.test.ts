import { describe, expect, it, vi } from 'vitest'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import {
  SoulPassPayments,
  selectSettlementAccount,
  __resetIdempotencySaltForTests,
} from '../src/payments/client'
import { PaymentError, isPaymentError } from '../src/payments/errors'
import { SoulPassError, isSoulPassError } from '../src/errors'
import { HttpPaymentIntentProvider } from '../src/payments/http-provider'
import type {
  EvmMachineAccountExecution,
  PaymentAccount,
  PaymentIntent,
  PaymentIntentProvider,
  PaymentSettlementOption,
  PaymentWallet,
  PreparedPayment,
} from '../src/payments/types'
import { jsonResponse, TEST_VAULT } from './helpers'

/**
 * Swap in a storage implementation and clear the module's salt cache.
 *
 * This defines the whole `localStorage` property rather than spying on
 * `Storage.prototype`: under this jsdom build `globalThis.localStorage` is a plain
 * object that does not inherit from `Storage`, so prototype spies never reach it and
 * `clear()` does not exist. Passing `null` installs a throwing implementation — the
 * privacy-mode / partitioned-storage case.
 */
function installLocalStorage(store: Record<string, string> | null): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const unavailable = () => { throw new Error('storage disabled') }
  const impl = store === null
    ? { getItem: unavailable, setItem: unavailable, removeItem: unavailable }
    : {
        getItem: (key: string) => (key in store ? store[key] : null),
        setItem: (key: string, value: string) => { store[key] = value },
        removeItem: (key: string) => { delete store[key] },
      }
  Object.defineProperty(globalThis, 'localStorage', {
    value: impl, configurable: true, writable: true,
  })
  __resetIdempotencySaltForTests()
  return () => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete (globalThis as { localStorage?: unknown }).localStorage
    __resetIdempotencySaltForTests()
  }
}

const CLIENT_SECRET = 'pi_secret_checkout_123'
const DISPLAY_TOKEN = 'pdt_display_123'
const SOLANA_PAYER = TEST_VAULT
const EVM_PAYER = '0x1111111111111111111111111111111111111111'
const SOLANA_SIGNATURE = '4wC9xkS7gqVzHZmrMiTbPS1CZV1XFJsTH9r2ofuKaGnGZGU44WR16wEoCAWwmzWb6nV9LMeFizT2ZgnhLYjzCdEz'

const SOLANA_OPTION: PaymentSettlementOption = {
  id: 'pmo_solana',
  rail: 'solana_spl',
  network: 'SOLANA',
  chainType: 'SOLANA',
  chainId: 'mainnet-beta',
  assetAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: { value: '10990000', decimals: 6, currency: 'USDC' },
  merchantReceives: { value: '10980000', decimals: 6, currency: 'USDC' },
  protocolFee: {
    basisPoints: 10,
    amount: { value: '10000', decimals: 6, currency: 'USDC' },
    recipient: '6hTQwKSPV7SLYqzZViEYhKobHLNCqZwjmTBhL7xJ7PHb',
  },
  recipient: 'DG3tStfrXLFnRZ5N7hAZuCDyzJDABZxY6dfKFgpe11iu',
}

const EVM_OPTION: PaymentSettlementOption = {
  id: 'pmo_base',
  rail: 'evm_machine_account',
  network: 'BASE',
  chainType: 'BASE',
  chainId: '8453',
  assetAddress: '0x2222222222222222222222222222222222222222',
  amount: { value: '10990000', decimals: 6, currency: 'USDC' },
  merchantReceives: { value: '10980000', decimals: 6, currency: 'USDC' },
  protocolFee: {
    basisPoints: 10,
    amount: { value: '10000', decimals: 6, currency: 'USDC' },
    recipient: '0x4444444444444444444444444444444444444444',
  },
  recipient: '0x3333333333333333333333333333333333333333',
}

/** Wrap an intent in the retrieve response shape the payment API now returns. */
function retrieved(intent: PaymentIntent) {
  return { paymentIntent: intent, displayToken: DISPLAY_TOKEN }
}

/**
 * Swap in a tab-scoped sessionStorage. Mirrors installLocalStorage above; the
 * suite runs in node, where `globalThis.sessionStorage` does not exist at all.
 */
function installSessionStorage(store: Record<string, string>): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const impl = {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
  }
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: impl, configurable: true, writable: true,
  })
  return () => {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  }
}

function paymentIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_siya_123',
    status: 'requires_confirmation',
    presentment: { value: '10990000', decimals: 6, currency: 'USDC' },
    settlementOptions: [SOLANA_OPTION, EVM_OPTION],
    merchant: { id: 'siya', name: 'Siya', domain: 'siya.ai', orderId: 'ORDER-1001' },
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }
}

function solanaPrepared(): PreparedPayment {
  return {
    paymentIntent: paymentIntent({ settlement: SOLANA_OPTION }),
    attemptId: 'pa_solana_123',
    execution: {
      kind: 'solana_machine_wallet_transfer',
      protocol: 'solana_machine_wallet_execute_v1',
      network: 'SOLANA',
      account: SOLANA_PAYER,
      mint: SOLANA_OPTION.assetAddress,
      recipient: SOLANA_OPTION.recipient,
      amount: SOLANA_OPTION.merchantReceives.value,
      protocolFeeRecipient: SOLANA_OPTION.protocolFee.recipient,
      protocolFeeAmount: SOLANA_OPTION.protocolFee.amount.value,
      decimals: 6,
      submissionPath: '/v1/wallet/solana/tx/submit',
    },
  }
}

function evmPrepared(): PreparedPayment {
  const execution: EvmMachineAccountExecution = {
    kind: 'evm_machine_account_batch',
    protocol: 'machine_account_execute_batch_with_signature_v1',
    network: 'BASE',
    chainId: '8453',
    account: EVM_PAYER,
    calls: [
      { target: EVM_OPTION.assetAddress, value: '0', data: '0xa9059cbb00' },
      { target: EVM_OPTION.assetAddress, value: '0', data: '0xa9059cbb01' },
    ],
    submissionPath: '/v1/wallet/evm/submit',
  }
  return {
    paymentIntent: paymentIntent({ settlement: EVM_OPTION }),
    attemptId: 'pa_base_123',
    execution,
  }
}

function harness(options: {
  accounts?: PaymentAccount[]
  prepare?: PaymentIntentProvider['prepare']
  complete?: PaymentIntentProvider['complete']
  retrieve?: PaymentIntentProvider['retrieve']
  confirmationTimeoutMs?: number
  confirmationPollIntervalMs?: number
} = {}) {
  const execute = vi.fn(async () => ({ transactionId: SOLANA_SIGNATURE }))
  const cancel = vi.fn()
  const getPaymentAccounts = vi.fn(async () => options.accounts ?? [{
    settlementOptionId: SOLANA_OPTION.id,
    payerAddress: SOLANA_PAYER,
    availableAmount: '20000000',
  }])
  const notifyPreparing = vi.fn()
  const beginPaymentAuthorization = vi.fn(() => ({
    getPaymentAccounts, notifyPreparing, execute, cancel,
  }))
  const wallet: PaymentWallet = {
    beginPaymentAuthorization,
  }
  const provider: PaymentIntentProvider = {
    createDirect: vi.fn(async () => ({
      paymentIntent: paymentIntent(),
      clientSecret: CLIENT_SECRET,
      displayToken: DISPLAY_TOKEN,
    })),
    retrieve: vi.fn(options.retrieve ?? (async () => retrieved(paymentIntent()))),
    prepare: vi.fn(options.prepare ?? (async () => solanaPrepared())),
    complete: vi.fn(options.complete ?? (async () => paymentIntent({
      status: 'succeeded',
      settlement: SOLANA_OPTION,
      transactionId: SOLANA_SIGNATURE,
    }))),
  }
  const payments = new SoulPassPayments({
    wallet,
    provider,
    confirmationTimeoutMs: options.confirmationTimeoutMs,
    confirmationPollIntervalMs: options.confirmationPollIntervalMs,
  })
  return {
    payments,
    provider,
    execute,
    cancel,
    getPaymentAccounts,
    notifyPreparing,
    beginPaymentAuthorization,
  }
}

describe('SoulPassPayments', () => {
  it('reserves authorization synchronously and aligns prepare/complete request fields', async () => {
    const h = harness()
    const session = h.payments.beginPayment(CLIENT_SECRET)

    expect(h.beginPaymentAuthorization).toHaveBeenCalledTimes(1)
    expect(h.provider.retrieve).not.toHaveBeenCalled()

    const result = await session.confirm()
    // Store mode: the display token comes out of the retrieve response and
    // must reach the wallet leg so the popup can fetch canonical state.
    expect(h.getPaymentAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pi_siya_123' }),
      DISPLAY_TOKEN,
    )
    expect(h.provider.prepare).toHaveBeenCalledWith(CLIENT_SECRET, {
      settlementOptionId: SOLANA_OPTION.id,
      payerAddress: SOLANA_PAYER,
    })
    expect(h.execute).toHaveBeenCalledWith(solanaPrepared().execution)
    expect(h.provider.complete).toHaveBeenCalledWith({
      clientSecret: CLIENT_SECRET,
      paymentIntentId: 'pi_siya_123',
      attemptId: 'pa_solana_123',
      transactionId: SOLANA_SIGNATURE,
    })
    expect(result).toMatchObject({
      transactionId: SOLANA_SIGNATURE,
      attemptId: 'pa_solana_123',
      settlement: { id: SOLANA_OPTION.id },
    })
  })

  it('tells the popup a server round-trip started, before prepare resolves', async () => {
    const order: string[] = []
    const h = harness({
      prepare: async () => {
        order.push('prepare')
        return solanaPrepared()
      },
    })
    h.notifyPreparing.mockImplementation(() => order.push('notify'))

    await h.payments.beginPayment(CLIENT_SECRET).confirm()
    expect(h.notifyPreparing).toHaveBeenCalledWith(SOLANA_OPTION.id)
    // Ordering is the whole point: a notice after prepare() returns would
    // leave the popup frozen for exactly the window it is meant to cover.
    expect(order).toEqual(['notify', 'prepare'])
  })

  it('works with a PaymentWallet that omits the optional notice', async () => {
    const h = harness()
    h.beginPaymentAuthorization.mockReturnValue({
      getPaymentAccounts: h.getPaymentAccounts,
      execute: h.execute,
      cancel: h.cancel,
    })
    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).resolves.toMatchObject({
      transactionId: SOLANA_SIGNATURE,
    })
  })

  it('defaults to Solana when Solana and EVM both have enough USDC', () => {
    const selected = selectSettlementAccount(
      [EVM_OPTION, SOLANA_OPTION],
      [
        { settlementOptionId: EVM_OPTION.id, payerAddress: EVM_PAYER, availableAmount: '99999999' },
        { settlementOptionId: SOLANA_OPTION.id, payerAddress: SOLANA_PAYER, availableAmount: '11000000' },
      ],
    )
    expect(selected.option.id).toBe(SOLANA_OPTION.id)
  })

  it('falls back to a funded EVM route when Solana USDC is insufficient', async () => {
    const evmHash = `0x${'a'.repeat(64)}`
    const h = harness({
      accounts: [
        { settlementOptionId: SOLANA_OPTION.id, payerAddress: SOLANA_PAYER, availableAmount: '1' },
        { settlementOptionId: EVM_OPTION.id, payerAddress: EVM_PAYER, availableAmount: '11000000' },
      ],
      prepare: async () => evmPrepared(),
      complete: async () => paymentIntent({
        status: 'succeeded',
        settlement: EVM_OPTION,
        transactionId: evmHash,
      }),
    })
    h.execute.mockResolvedValue({ transactionId: evmHash })

    const result = await h.payments.beginPayment(CLIENT_SECRET).confirm()

    expect(h.provider.prepare).toHaveBeenCalledWith(CLIENT_SECRET, {
      settlementOptionId: EVM_OPTION.id,
      payerAddress: EVM_PAYER,
    })
    expect(result.settlement.network).toBe('BASE')
  })

  it('fails before prepare when no accepted chain has sufficient balance', async () => {
    const h = harness({
      accounts: [
        { settlementOptionId: SOLANA_OPTION.id, payerAddress: SOLANA_PAYER, availableAmount: '1' },
        { settlementOptionId: EVM_OPTION.id, payerAddress: EVM_PAYER, availableAmount: '2' },
      ],
    })

    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'PAYMENT_INSUFFICIENT_FUNDS',
    })
    expect(h.provider.prepare).not.toHaveBeenCalled()
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('requires enough balance for the gross merchant price, not only merchant net', () => {
    expect(() => selectSettlementAccount(
      [SOLANA_OPTION],
      [{
        settlementOptionId: SOLANA_OPTION.id,
        payerAddress: SOLANA_PAYER,
        availableAmount: SOLANA_OPTION.merchantReceives.value,
      }],
    )).toThrowError(expect.objectContaining({ code: 'PAYMENT_INSUFFICIENT_FUNDS' }))
  })

  it('rejects a settlement whose gross debit differs from the displayed checkout price', async () => {
    const h = harness({
      retrieve: async () => retrieved(paymentIntent({
        presentment: { value: '10990001', decimals: 6, currency: 'USDC' },
      })),
    })

    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'PAYMENT_INTENT_INVALID',
    })
    expect(h.getPaymentAccounts).not.toHaveBeenCalled()
    expect(h.provider.prepare).not.toHaveBeenCalled()
  })

  it('opens checkout without a prior wallet connect ceremony', () => {
    const h = harness()
    expect(() => h.payments.beginPayment(CLIENT_SECRET)).not.toThrow()
    expect(h.beginPaymentAuthorization).toHaveBeenCalledTimes(1)
  })

  it('creates a permissionless intent internally and resolves only after success', async () => {
    const h = harness()
    const result = await h.payments.pay({
      amount: '10.50',
      recipients: { solana: SOLANA_OPTION.recipient },
      reference: 'order-7',
    })
    // The human price goes over the wire as-is: the payment API scales it with
    // the configured asset's decimals, so no token table lives in this SDK.
    expect(h.provider.createDirect).toHaveBeenCalledWith(expect.objectContaining({
      amount: '10.50',
      currency: 'USDC',
      settlementOptions: [{ network: 'SOLANA', recipient: SOLANA_OPTION.recipient }],
      reference: 'order-7',
      idempotencyKey: expect.stringMatching(/^sdk_ref_[0-9a-f]{40}$/),
    }))
    // Direct mode: the display token issued at create reaches the wallet leg,
    // so the popup renders server-canonical state, not the relayed intent.
    expect(h.getPaymentAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pi_siya_123' }),
      DISPLAY_TOKEN,
    )
    expect(result.intent.status).toBe('succeeded')
  })

  it('rejects a create response without a display token before any wallet leg runs', async () => {
    const h = harness()
    vi.mocked(h.provider.createDirect).mockResolvedValue({
      paymentIntent: paymentIntent(),
      clientSecret: CLIENT_SECRET,
    } as never)
    // The wallet hard-fails a checkout without a token; failing here instead
    // turns a dead popup into a typed error at the merchant boundary.
    await expect(h.payments.pay({
      amount: '10.50',
      recipients: { solana: SOLANA_OPTION.recipient },
    })).rejects.toMatchObject({
      code: 'PAYMENT_INTENT_INVALID',
      message: expect.stringContaining('display token'),
    })
    expect(h.getPaymentAccounts).not.toHaveBeenCalled()
    expect(h.cancel).toHaveBeenCalled()
  })

  it('rejects a retrieve response without a display token', async () => {
    const h = harness({
      retrieve: (async () => ({ paymentIntent: paymentIntent() })) as never,
    })
    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'PAYMENT_INTENT_INVALID',
      message: expect.stringContaining('display token'),
    })
    expect(h.getPaymentAccounts).not.toHaveBeenCalled()
  })

  it('persists the recovery capability with its display token across a reload', async () => {
    const store: Record<string, string> = {}
    const restore = installSessionStorage(store)
    try {
      const h = harness({ complete: async () => { throw new Error('response lost') } })
      await expect(h.payments.pay({
        amount: '10.50',
        recipients: { solana: SOLANA_OPTION.recipient },
      })).rejects.toMatchObject({ code: 'PAYMENT_STATUS_UNKNOWN' })

      // The tab-scoped record carries both capabilities under the v2 key.
      expect(JSON.parse(store['soulpass_direct_payment_v2:pi_siya_123'])).toEqual({
        clientSecret: CLIENT_SECRET,
        displayToken: DISPLAY_TOKEN,
      })

      // A reload = a fresh client with empty memory but the same tab storage.
      const reloaded = harness({
        retrieve: async () => retrieved(paymentIntent({
          status: 'processing',
          settlement: SOLANA_OPTION,
          transactionId: SOLANA_SIGNATURE,
        })),
      })
      await expect(reloaded.payments.retrieveDirectPayment('pi_siya_123')).resolves.toMatchObject({
        status: 'processing',
      })
      expect(reloaded.provider.retrieve).toHaveBeenCalledWith(CLIENT_SECRET)
    } finally {
      restore()
    }
  })

  it('forwards a currency this SDK build has never heard of', async () => {
    const h = harness()
    await h.payments.pay({
      amount: '10.50',
      currency: 'USDT',
      recipients: { solana: SOLANA_OPTION.recipient },
    })
    // Adding a stablecoin must not require an SDK release: the server owns the
    // asset catalog, so an unknown code is its call to accept or reject.
    expect(h.provider.createDirect).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '10.50', currency: 'USDT' }),
    )
  })

  it('still rejects a price that is not a positive decimal', async () => {
    const h = harness()
    await expect(h.payments.pay({
      amount: '0.00',
      recipients: { solana: SOLANA_OPTION.recipient },
    })).rejects.toMatchObject({ code: 'PAYMENT_INTENT_INVALID' })
    await expect(h.payments.pay({
      amount: '-1',
      recipients: { solana: SOLANA_OPTION.recipient },
    })).rejects.toMatchObject({ code: 'PAYMENT_INTENT_INVALID' })
    expect(h.provider.createDirect).not.toHaveBeenCalled()
  })

  it('rejects malformed direct inputs before opening the wallet', async () => {
    const h = harness()
    await expect(h.payments.pay({
      amount: '10.50',
      recipients: { solana: SOLANA_OPTION.recipient },
      metadata: { 'unsafe key': 'value' },
    })).rejects.toMatchObject({ code: 'PAYMENT_INTENT_INVALID' })
    expect(h.beginPaymentAuthorization).not.toHaveBeenCalled()
    expect(h.provider.createDirect).not.toHaveBeenCalled()
  })

  it('uses a stable idempotency key when the same checkout reference is retried', async () => {
    const h = harness()
    const input = {
      amount: '10.50',
      recipients: { solana: SOLANA_OPTION.recipient },
      reference: 'order-7',
    }
    await h.payments.pay(input)
    await h.payments.pay(input)

    const first = vi.mocked(h.provider.createDirect).mock.calls[0][0].idempotencyKey
    const second = vi.mocked(h.provider.createDirect).mock.calls[1][0].idempotencyKey
    expect(second).toBe(first)
  })

  it('does not derive the idempotency key from the reference alone', async () => {
    // An unsalted key is sha256(order id) — computable by anyone who can guess the
    // order id, which is enough to pre-create an intent under it and permanently
    // break that checkout. Pinning the exact value is the point of this test: it is
    // the equality an attacker needs and the one this must never satisfy.
    const reference = 'order-7'
    const unsalted = bytesToHex(sha256(new TextEncoder().encode(reference)).slice(0, 20))

    const h = harness()
    await h.payments.pay({ amount: '10.50', recipients: { solana: SOLANA_OPTION.recipient }, reference })

    const key = vi.mocked(h.provider.createDirect).mock.calls[0][0].idempotencyKey
    expect(key).toMatch(/^sdk_ref_[0-9a-f]{40}$/)
    expect(key).not.toBe(`sdk_ref_${unsalted}`)
  })

  it('a fresh browser derives a different key for the same reference', async () => {
    const input = {
      amount: '10.50',
      recipients: { solana: SOLANA_OPTION.recipient },
      reference: 'order-7',
    }
    const firstBrowser = installLocalStorage({})
    let first: string
    try {
      const h = harness()
      await h.payments.pay(input)
      first = vi.mocked(h.provider.createDirect).mock.calls[0][0].idempotencyKey
    } finally {
      firstBrowser()
    }

    // Same origin, different browser: no shared salt, so no shared key — which is
    // what stops one shopper's idempotent replay from handing another shopper the
    // first one's client secret.
    const secondBrowser = installLocalStorage({})
    try {
      const h = harness()
      await h.payments.pay(input)
      expect(vi.mocked(h.provider.createDirect).mock.calls[0][0].idempotencyKey).not.toBe(first)
    } finally {
      secondBrowser()
    }
  })

  it('survives storage being unavailable, still converging within the page', async () => {
    const restore = installLocalStorage(null)
    try {
      const h = harness()
      const input = {
        amount: '10.50',
        recipients: { solana: SOLANA_OPTION.recipient },
        reference: 'order-7',
      }
      await h.payments.pay(input)
      await h.payments.pay(input)
      const calls = vi.mocked(h.provider.createDirect).mock.calls
      expect(calls[1][0].idempotencyKey).toBe(calls[0][0].idempotencyKey)
    } finally {
      restore()
    }
  })

  it('keeps the internal capability for canonical recovery after status unknown', async () => {
    const h = harness({ complete: async () => { throw new Error('response lost') } })
    await expect(h.payments.pay({
      amount: '10.50',
      recipients: { solana: SOLANA_OPTION.recipient },
      reference: 'order-recovery',
    })).rejects.toMatchObject({
      code: 'PAYMENT_STATUS_UNKNOWN',
      paymentIntentId: 'pi_siya_123',
    })
    vi.mocked(h.provider.retrieve).mockResolvedValueOnce(retrieved(paymentIntent({
      status: 'processing',
      settlement: SOLANA_OPTION,
      transactionId: SOLANA_SIGNATURE,
    })))

    await expect(h.payments.retrieveDirectPayment('pi_siya_123')).resolves.toMatchObject({
      status: 'processing',
      transactionId: SOLANA_SIGNATURE,
    })
  })

  it('fails closed when canonical reconciliation reports a failed transaction', async () => {
    const h = harness({
      complete: async () => paymentIntent({
        status: 'failed',
        settlement: SOLANA_OPTION,
        failure: { code: 'TRANSFER_MISMATCH', reason: 'recipient mismatch' },
      }),
    })
    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'PAYMENT_FAILED',
      message: 'recipient mismatch',
    })
  })

  it('cancels reserved authorization when the intent expires', async () => {
    const h = harness({
      retrieve: async () =>
        retrieved(paymentIntent({ expiresAt: new Date(Date.now() - 1_000).toISOString() })),
    })
    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'PAYMENT_INTENT_EXPIRED',
    })
    expect(h.cancel).toHaveBeenCalledWith('payment preparation failed')
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('returns STATUS_UNKNOWN with the transaction id when completion fails', async () => {
    const h = harness({ complete: async () => { throw new Error('response lost') } })
    // retryable === false is the pin that matters: a transaction id exists, so a
    // generic `if (err.retryable) retry()` branch must never see true here —
    // that branch re-running pay() is the double-charge path.
    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'PAYMENT_STATUS_UNKNOWN',
      paymentIntentId: 'pi_siya_123',
      transactionId: SOLANA_SIGNATURE,
      retryable: false,
    })
  })

  it('the confirmation-timeout path is never retryable either', async () => {
    const h = harness({
      complete: async () => paymentIntent({
        status: 'processing',
        settlement: SOLANA_OPTION,
        transactionId: SOLANA_SIGNATURE,
      }),
      confirmationTimeoutMs: 0,
      confirmationPollIntervalMs: 1,
    })
    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'PAYMENT_STATUS_UNKNOWN',
      transactionId: SOLANA_SIGNATURE,
      retryable: false,
    })
  })

  it('rejects a second pay() while one is in flight, without opening a second popup', async () => {
    let finishComplete!: (intent: PaymentIntent) => void
    const h = harness({
      complete: () => new Promise<PaymentIntent>((resolve) => { finishComplete = resolve }),
    })
    const input = { amount: '10.50', recipients: { solana: SOLANA_OPTION.recipient } }

    const first = h.payments.pay(input)
    await expect(h.payments.pay(input)).rejects.toMatchObject({ code: 'PAYMENT_IN_PROGRESS' })
    // The rejection must precede any popup work — one checkout, one window.
    expect(h.beginPaymentAuthorization).toHaveBeenCalledTimes(1)

    // Let the first checkout reach its pending complete() before releasing it.
    await vi.waitFor(() => expect(h.provider.complete).toHaveBeenCalled())
    finishComplete(paymentIntent({
      status: 'succeeded',
      settlement: SOLANA_OPTION,
      transactionId: SOLANA_SIGNATURE,
    }))
    await expect(first).resolves.toMatchObject({ transactionId: SOLANA_SIGNATURE })

    // The slot frees the moment the pending payment settles.
    vi.mocked(h.provider.complete).mockResolvedValue(paymentIntent({
      status: 'succeeded',
      settlement: SOLANA_OPTION,
      transactionId: SOLANA_SIGNATURE,
    }))
    await expect(h.payments.pay(input)).resolves.toMatchObject({
      transactionId: SOLANA_SIGNATURE,
    })
  })

  it('beginPayment() shares the single-flight slot and cancel() releases it', () => {
    const h = harness()
    const session = h.payments.beginPayment(CLIENT_SECRET)
    expect(() => h.payments.beginPayment(CLIENT_SECRET))
      .toThrowError(expect.objectContaining({ code: 'PAYMENT_IN_PROGRESS' }))
    session.cancel('merchant navigated away')
    expect(() => h.payments.beginPayment(CLIENT_SECRET)).not.toThrow()
  })

  it('preserves a typed authorization failure without calling complete', async () => {
    const h = harness()
    h.execute.mockRejectedValue(new PaymentError('PAYMENT_AUTHORIZATION_FAILED', 'Rejected'))
    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'PAYMENT_AUTHORIZATION_FAILED',
    })
    expect(h.provider.complete).not.toHaveBeenCalled()
  })

  it('keeps the wallet-side code instead of flattening it into the payment layer', async () => {
    const h = harness()
    h.execute.mockRejectedValue(new SoulPassError('USER_REJECTED', 'user declined'))
    // A decline is not a payment failure — merchants branch on this to stay
    // silent rather than showing an error, so the code must survive the leg.
    await expect(h.payments.beginPayment(CLIENT_SECRET).confirm()).rejects.toMatchObject({
      code: 'USER_REJECTED',
    })
    expect(h.provider.complete).not.toHaveBeenCalled()
  })

  it('narrows every rejection through one guard', async () => {
    const walletSide = new SoulPassError('POPUP_BLOCKED', 'blocked')
    const paymentSide = new PaymentError('PAYMENT_API_ERROR', 'down', { retryable: true })
    expect(isSoulPassError(walletSide)).toBe(true)
    expect(isSoulPassError(paymentSide)).toBe(true)
    expect(isPaymentError(paymentSide)).toBe(true)
    expect(isPaymentError(walletSide)).toBe(false)
    expect(paymentSide.retryable).toBe(true)
  })
})

describe('HttpPaymentIntentProvider', () => {
  it('creates direct payments without a merchant secret', async () => {
    const created = { paymentIntent: paymentIntent(), clientSecret: CLIENT_SECRET }
    const fetchMock = vi.fn(async () => jsonResponse(created))
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1',
      fetch: fetchMock,
    })
    await provider.createDirect({
      idempotencyKey: 'sdk_12345678',
      amount: { value: '1000000', decimals: 6, currency: 'USDC' },
      settlementOptions: [{ network: 'SOLANA', recipient: SOLANA_OPTION.recipient }],
    })
    const [url, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(url).toBe('https://pay.soulpass.ai/v1/payment-intents/direct')
    expect(headers.get('Idempotency-Key')).toBe('sdk_12345678')
    expect(headers.has('X-SoulPass-Client-Secret')).toBe(false)
  })

  it('unwraps ResponseVo and sends the selected option and payer', async () => {
    const prepared = solanaPrepared()
    const fetchMock = vi.fn(async () => jsonResponse(prepared))
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1/',
      fetch: fetchMock,
    })

    await expect(provider.prepare(CLIENT_SECRET, {
      settlementOptionId: SOLANA_OPTION.id,
      payerAddress: SOLANA_PAYER,
    })).resolves.toEqual(prepared)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://pay.soulpass.ai/v1/payment-intents/prepare')
    expect(String(url)).not.toContain(CLIENT_SECRET)
    expect(new Headers(init?.headers).get('X-SoulPass-Client-Secret')).toBe(CLIENT_SECRET)
    expect(init?.body).toBe(JSON.stringify({
      settlementOptionId: SOLANA_OPTION.id,
      payerAddress: SOLANA_PAYER,
    }))
  })

  it('includes attemptId in completion', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(paymentIntent({ status: 'processing', settlement: SOLANA_OPTION })))
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1',
      fetch: fetchMock,
    })

    await provider.complete({
      clientSecret: CLIENT_SECRET,
      paymentIntentId: 'pi_siya_123',
      attemptId: 'pa_solana_123',
      transactionId: SOLANA_SIGNATURE,
    })
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({
      paymentIntentId: 'pi_siya_123',
      attemptId: 'pa_solana_123',
      transactionId: SOLANA_SIGNATURE,
    }))
  })

  it('reads matrix-backend top-level error messages', async () => {
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1',
      fetch: async () => new Response(
        JSON.stringify({ code: 500, message: 'temporarily unavailable', success: false }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    })
    await expect(provider.retrieve(CLIENT_SECRET)).rejects.toMatchObject({
      code: 'PAYMENT_API_ERROR',
      message: 'temporarily unavailable',
      retryable: true,
    })
  })

  it('does not blame a client secret when the credential-less create endpoint 404s', async () => {
    const notFound = async () => new Response('not found', { status: 404 })
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1',
      fetch: notFound,
    })
    // Create sends no secret, so 401/403/404 cannot mean "bad secret" — the
    // usual cause is a wrong paymentApiUrl, and the message must say so.
    await expect(provider.createDirect({
      idempotencyKey: 'sdk_12345678',
      amount: '10.50',
      currency: 'USDC',
      settlementOptions: [{ network: 'SOLANA', recipient: SOLANA_OPTION.recipient }],
    })).rejects.toMatchObject({
      code: 'PAYMENT_API_ERROR',
      message: expect.stringContaining('paymentApiUrl'),
    })
    // Credentialed endpoints keep the secret-focused mapping.
    await expect(provider.retrieve(CLIENT_SECRET)).rejects.toMatchObject({
      code: 'INVALID_CLIENT_SECRET',
    })
  })

  it('opts into http-status-v1 on every call', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(paymentIntent({})))
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1',
      fetch: fetchMock,
    })

    await provider.retrieve(CLIENT_SECRET)
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-Matrix-Response-Mode']).toBe('http-status-v1')
  })

  it('classifies a v1 conflict as an unpayable intent and keeps the envelope message', async () => {
    // Business code 12003 projected to HTTP 409 — this is what "already
    // settled" and "quote window passed" both look like on the wire.
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1',
      fetch: async () => new Response(
        JSON.stringify({
          code: 12003, message: 'PaymentIntent has expired', data: null, success: false,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    })
    await expect(provider.retrieve(CLIENT_SECRET)).rejects.toMatchObject({
      code: 'PAYMENT_INTENT_NOT_PAYABLE',
      message: 'PaymentIntent has expired',
      retryable: false,
    })
  })

  it('does not retry HTTP 501 — it is business code 700, not a fault', async () => {
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1',
      fetch: async () => new Response(
        JSON.stringify({
          code: 700, message: 'Feature under development', data: null, success: false,
        }),
        { status: 501, headers: { 'Content-Type': 'application/json' } },
      ),
    })
    await expect(provider.retrieve(CLIENT_SECRET)).rejects.toMatchObject({
      code: 'PAYMENT_API_ERROR',
      message: 'Feature under development',
      // `status >= 500` would have made this retryable forever.
      retryable: false,
    })
  })

  it('treats a v1 422 domain rejection as a non-retryable API error', async () => {
    const provider = new HttpPaymentIntentProvider({
      baseUrl: 'https://pay.soulpass.ai/v1',
      fetch: async () => new Response(
        JSON.stringify({
          code: 501, message: 'Business error', data: null, success: false,
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    })
    // Business code 501 is BUSINESS_ERROR and maps to HTTP 422 — never to 501.
    await expect(provider.retrieve(CLIENT_SECRET)).rejects.toMatchObject({
      code: 'PAYMENT_API_ERROR',
      message: 'Business error',
      retryable: false,
    })
  })

  it('refuses plaintext payment APIs outside localhost', () => {
    expect(() => new HttpPaymentIntentProvider({
      baseUrl: 'http://pay.example.com/v1',
      fetch: vi.fn(),
    })).toThrowError(expect.objectContaining({ code: 'PAYMENT_API_ERROR' }))
  })
})
