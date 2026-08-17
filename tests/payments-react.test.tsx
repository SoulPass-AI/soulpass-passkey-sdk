// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PaymentError } from '../src/payments/errors'
import { SoulPassError } from '../src/errors'
import type { PaymentResult } from '../src/payments/types'

// The hook's contract is entirely about what a merchant does NOT have to write:
// no decline branch, no double-submit guard, no client lifecycle. Each test below is
// one of those omissions, so a regression shows up as merchant code that has to come
// back rather than as a failing assertion nobody can interpret.

const pay = vi.fn()
const retrieveDirectPayment = vi.fn()
const createSoulPassPayments = vi.fn(() => ({ pay, retrieveDirectPayment }))

vi.mock('../src/payments/factory', () => ({
  createSoulPassPayments: (config: unknown) => createSoulPassPayments(config as never),
}))

const { useSoulPassPayments } = await import('../src/payments/react')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const INPUT = { amount: '10.00', recipients: { solana: 'MerchantXYZ' } }
const SETTLED = { transactionId: 'sig', attemptId: 'pa_1' } as unknown as PaymentResult

let container: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useSoulPassPayments> | null = null
let renders = 0

function Probe({ config }: { config?: Parameters<typeof useSoulPassPayments>[0] }) {
  renders += 1
  latest = useSoulPassPayments(config)
  return null
}

function render(node: React.ReactNode) {
  act(() => {
    root.render(node)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  renders = 0
  latest = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useSoulPassPayments', () => {
  it('exposes the settled payment and clears busy state', async () => {
    pay.mockResolvedValue(SETTLED)
    render(<Probe />)

    await act(async () => {
      await latest!.pay(INPUT)
    })

    expect(pay).toHaveBeenCalledWith(INPUT)
    expect(latest!.result).toBe(SETTLED)
    expect(latest!.paying).toBe(false)
    expect(latest!.error).toBeNull()
  })

  it('treats a decline as a non-event: no error, no rejection', async () => {
    pay.mockRejectedValue(new SoulPassError('USER_REJECTED', 'user said no'))
    render(<Probe />)

    let returned: unknown = 'unset'
    await act(async () => {
      returned = await latest!.pay(INPUT)
    })

    // The whole point: a merchant that never writes a catch block still does not
    // show an error toast when someone closes the wallet window.
    expect(returned).toBeNull()
    expect(latest!.error).toBeNull()
    expect(latest!.result).toBeNull()
  })

  it('surfaces a real failure without rejecting', async () => {
    pay.mockRejectedValue(new PaymentError('PAYMENT_INSUFFICIENT_FUNDS', 'not enough'))
    render(<Probe />)

    await act(async () => {
      await latest!.pay(INPUT)
    })

    expect(latest!.error).toMatchObject({ code: 'PAYMENT_INSUFFICIENT_FUNDS' })
    expect(latest!.statusUnknown).toBe(false)
  })

  it('flags status-unknown separately, because that branch must not retry', async () => {
    pay.mockRejectedValue(new PaymentError('PAYMENT_STATUS_UNKNOWN', 'lost', {
      paymentIntentId: 'pi_1',
    }))
    render(<Probe />)

    await act(async () => {
      await latest!.pay(INPUT)
    })

    expect(latest!.statusUnknown).toBe(true)
    // Extracted from the error so no consumer has to cast `error` to reach it.
    expect(latest!.unknownPaymentIntentId).toBe('pi_1')
    expect(latest!.error).toMatchObject({ code: 'PAYMENT_STATUS_UNKNOWN' })

    // recover() needs no argument: it targets the flagged intent.
    retrieveDirectPayment.mockResolvedValue({ id: 'pi_1', status: 'processing' })
    await act(async () => {
      await latest!.recover()
    })
    expect(retrieveDirectPayment).toHaveBeenCalledWith('pi_1')
  })

  it('recover() without a flagged payment rejects instead of guessing', async () => {
    render(<Probe />)
    await expect(latest!.recover()).rejects.toMatchObject({
      code: 'PAYMENT_INTENT_INVALID',
    })
    expect(retrieveDirectPayment).not.toHaveBeenCalled()
  })

  it('a second click in the same tick cannot start a second charge', async () => {
    pay.mockResolvedValue(SETTLED)
    render(<Probe />)

    await act(async () => {
      // Both calls happen before any re-render, so `paying` is still false for the
      // second one — state cannot be the guard here, and this is why there is a ref.
      await Promise.all([latest!.pay(INPUT), latest!.pay(INPUT)])
    })

    expect(pay).toHaveBeenCalledTimes(1)
  })

  it('keeps one client across renders even with a fresh config object each time', () => {
    render(<Probe config={{ walletUrl: 'https://soulpass.ai' }} />)
    const first = latest!.payments
    render(<Probe config={{ walletUrl: 'https://soulpass.ai' }} />)

    expect(renders).toBeGreaterThan(1)
    expect(createSoulPassPayments).toHaveBeenCalledTimes(1)
    expect(latest!.payments).toBe(first)
  })

  it('rebuilds the client when a config value actually changes', () => {
    render(<Probe config={{ walletUrl: 'https://soulpass.ai' }} />)
    render(<Probe config={{ walletUrl: 'https://test.soulpass.ai' }} />)

    expect(createSoulPassPayments).toHaveBeenCalledTimes(2)
  })

  it('reset clears the previous outcome', async () => {
    pay.mockResolvedValue(SETTLED)
    render(<Probe />)
    await act(async () => {
      await latest!.pay(INPUT)
    })
    expect(latest!.result).toBe(SETTLED)

    act(() => latest!.reset())
    expect(latest!.result).toBeNull()
  })
})
