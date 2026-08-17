import { describe, it, expect, vi } from 'vitest'
import { SoulPassWallet } from '../src/wallet'
import { SoulPassError, isSoulPassError } from '../src/errors'
import { InAppBrowserError } from '../src/environment'
import { setupPopupSpies, connectedWallet as connected } from './helpers'

// The typed-error contract: every rejection a dApp can observe from the
// integration surface carries a machine-readable `code`, and the message
// keeps the historical "CODE: detail" prefix so pre-0.3 string-matchers
// keep working. These tests pin both halves.

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (err) {
    expect(isSoulPassError(err)).toBe(true)
    return (err as SoulPassError).code
  }
}

describe('typed error contract', () => {
  it('isSoulPassError narrows SoulPassError and subclasses, not plain Error', () => {
    expect(isSoulPassError(new SoulPassError('TIMEOUT'))).toBe(true)
    expect(isSoulPassError(new InAppBrowserError('WeChat'))).toBe(true)
    expect(isSoulPassError(new Error('TIMEOUT: nope'))).toBe(false)
    expect(isSoulPassError(undefined)).toBe(false)
  })

  it('InAppBrowserError keeps its name and appName under the shared base', () => {
    const err = new InAppBrowserError('WeChat')
    expect(err.code).toBe('IN_APP_BROWSER')
    expect(err.name).toBe('InAppBrowserError')
    expect(err.appName).toBe('WeChat')
    expect(err).toBeInstanceOf(SoulPassError)
  })

  it('sign before connect → NOT_CONNECTED', async () => {
    const w = new SoulPassWallet({ network: 'devnet' })
    await expect(codeOf(w.signTransaction(new Uint8Array()))).resolves.toBe('NOT_CONNECTED')
  })

  it('session.cancel() → CANCELLED, message keeps the prefix', async () => {
    const w = connected()
    setupPopupSpies(w)
    const session = w.beginSignTransaction()
    const promise = session.send(new Uint8Array([1]))
    session.cancel('user navigated away')
    const err = await promise.catch((e) => e)
    expect(isSoulPassError(err)).toBe(true)
    expect(err.code).toBe('CANCELLED')
    expect(err.message).toBe('CANCELLED: user navigated away')
  })

  it('second send() on a single-shot session → SESSION_USED', async () => {
    const w = connected()
    const { getOnMessage } = setupPopupSpies(w)
    const session = w.beginSignTransaction()
    getOnMessage()?.({ type: 'READY' })
    void session.send(new Uint8Array([1]))
    await expect(codeOf(session.send(new Uint8Array([2])))).resolves.toBe('SESSION_USED')
  })

  it('popup ERROR payload maps code + "CODE: detail" message', async () => {
    const w = connected()
    const { sendSpy, getOnMessage } = setupPopupSpies(w)
    const session = w.beginSignTransaction()
    getOnMessage()?.({ type: 'READY' })
    const promise = session.send(new Uint8Array([1]))
    const messageId = (sendSpy.mock.calls[0][0] as { id: string }).id
    getOnMessage()?.({
      type: 'ERROR',
      id: messageId,
      payload: { code: 'USER_REJECTED', message: 'user said no' },
    })
    const err = await promise.catch((e) => e)
    expect(err.code).toBe('USER_REJECTED')
    expect(err.message).toBe('USER_REJECTED: user said no')
  })

  it('connect() popup close → POPUP_CLOSED', async () => {
    vi.useFakeTimers()
    try {
      const w = new SoulPassWallet({ network: 'devnet' })
      setupPopupSpies(w)
      vi.spyOn(w['popup'], 'isOpen', 'get').mockReturnValue(false)
      const promise = w.connect()
      const pendingCode = codeOf(promise)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pendingCode).resolves.toBe('POPUP_CLOSED')
    } finally {
      vi.useRealTimers()
    }
  })

  it('batch: overlapping send() → SEND_IN_FLIGHT', async () => {
    const w = connected()
    const { getOnMessage } = setupPopupSpies(w)
    vi.spyOn(w['popup'], 'isOpen', 'get').mockReturnValue(true)
    const session = w.beginBatchSignTransaction()
    getOnMessage()?.({ type: 'READY' })
    // First send stays pending until cancel() below rejects it — keep the
    // handler attached so the rejection isn't unhandled.
    const first = session.send(new Uint8Array([1])).catch((e) => e)
    await expect(codeOf(session.send(new Uint8Array([2])))).resolves.toBe('SEND_IN_FLIGHT')
    session.cancel()
    await expect(first).resolves.toMatchObject({ code: 'CANCELLED' })
  })
})
