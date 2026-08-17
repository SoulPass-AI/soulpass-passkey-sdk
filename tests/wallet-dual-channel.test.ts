import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SoulPassWallet } from '../src/wallet'
import { SoulPassError } from '../src/errors'
import { CHANNEL_ID_CHARS, jsonResponse } from './helpers'

const CHANNEL_RE = new RegExp(`[?&]channel=(${CHANNEL_ID_CHARS})(&|$)`)

type PopupHarness = {
  wallet: SoulPassWallet
  openedPaths: string[]
  emit: (msg: unknown) => void
  sendSpy: ReturnType<typeof vi.fn>
  setPopupOpen: (open: boolean) => void
}

function harness(config: ConstructorParameters<typeof SoulPassWallet>[0] = {}): PopupHarness {
  const wallet = new SoulPassWallet({ network: 'devnet', ...config })
  wallet['handleConnectSuccess']({
    publicKey: 'VauLtPda11111111111111111111111111111111111',
    walletAddress: 'VauLtPda11111111111111111111111111111111111',
    accountAddress: 'StatePda1111111111111111111111111111111111',
  } as any)

  const openedPaths: string[] = []
  let handler: ((msg: unknown) => void) | null = null
  let popupOpen = true
  const popup = wallet['popup']
  vi.spyOn(popup, 'open').mockImplementation((path: string) => {
    openedPaths.push(path)
    return {} as Window
  })
  const sendSpy = vi.fn()
  // Mirror the real PopupManager.send throw shape so the mock can't drift
  // from the behavior under test.
  vi.spyOn(popup, 'send').mockImplementation((msg: unknown) => {
    if (!popupOpen) throw new SoulPassError('POPUP_CLOSED', 'Popup is not open')
    sendSpy(msg)
  })
  vi.spyOn(popup, 'onMessage').mockImplementation((h) => {
    handler = h as typeof handler
  })
  vi.spyOn(popup, 'close').mockImplementation(() => {
    popupOpen = false
  })
  Object.defineProperty(popup, 'isOpen', { get: () => popupOpen, configurable: true })

  return {
    wallet,
    openedPaths,
    emit: (msg) => handler?.(msg),
    sendSpy,
    setPopupOpen: (open) => {
      popupOpen = open
    },
  }
}

type FetchCall = { url: string; init?: RequestInit }

function stubRelay(pollStatus: () => Record<string, unknown>) {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse(url.includes('result-poll') ? pollStatus() : {})
    }),
  )
  return calls
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dual-channel beginSignTransaction', () => {
  it('opens /wallet/sign with a channel param; message/batch paths carry none', () => {
    const h = harness()
    stubRelay(() => ({ status: 'pending' }))
    h.wallet.beginSignTransaction()
    expect(h.openedPaths[0]).toMatch(/^\/wallet\/sign\?channel=/)
    expect(h.openedPaths[0]).toMatch(CHANNEL_RE)

    h.wallet.beginSignMessage()
    expect(h.openedPaths[1]).toBe('/wallet/message')

    h.wallet.beginBatchSignTransaction()
    expect(h.openedPaths[2]).toBe('/wallet/sign')
  })

  it('send() mirrors the payload to the relay under the same channelId', async () => {
    const h = harness({ productType: 'tens' })
    const calls = stubRelay(() => ({ status: 'pending' }))
    const session = h.wallet.beginSignTransaction()
    const channelId = h.openedPaths[0].match(CHANNEL_RE)![1]

    const p = session.send(new Uint8Array([1, 2, 3]))
    p.catch(() => {}) // cancelled at the end of the test — rejection expected
    await vi.advanceTimersByTimeAsync(10)

    const put = calls.find((c) => c.url.endsWith('/user/v1/sign-channels/payload'))
    expect(put).toBeDefined()
    const body = JSON.parse(put!.init!.body as string)
    expect(body.channelId).toBe(channelId)
    expect(body.transaction).toBe('AQID')
    expect(body.walletAddress).toBe('VauLtPda11111111111111111111111111111111111')
    expect(body.productType).toBe('tens')
    session.cancel()
  })

  it('popup wins: SIGN_SUCCESS resolves and the relay poll stops', async () => {
    const h = harness()
    const calls = stubRelay(() => ({ status: 'pending' }))
    const session = h.wallet.beginSignTransaction()
    h.emit({ type: 'READY' })
    const p = session.send(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(10)
    const sentId = (h.sendSpy.mock.calls[0][0] as { id: string }).id
    h.emit({ type: 'SIGN_SUCCESS', id: sentId, payload: { signature: 'popup-sig' } })
    await expect(p).resolves.toEqual({ signature: 'popup-sig' })
    const pollsAtResolve = calls.filter((c) => c.url.includes('result-poll')).length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.filter((c) => c.url.includes('result-poll')).length).toBe(pollsAtResolve)
  })

  it('relay wins: app-completed status resolves with the signature', async () => {
    const h = harness()
    let status: Record<string, unknown> = { status: 'claimed' }
    stubRelay(() => status)
    const session = h.wallet.beginSignTransaction()
    const p = session.send(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(10)
    status = { status: 'completed', signature: 'app-sig' }
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toEqual({ signature: 'app-sig' })
  })

  it('relay cancelled rejects as USER_REJECTED', async () => {
    const h = harness()
    stubRelay(() => ({ status: 'cancelled' }))
    const session = h.wallet.beginSignTransaction()
    const p = session.send(new Uint8Array([1]))
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).rejects.toThrow('USER_REJECTED')
  })

  it('popup closing does NOT kill a channel flow — relay leg finishes it', async () => {
    const h = harness()
    let status: Record<string, unknown> = { status: 'claimed' }
    stubRelay(() => status)
    const session = h.wallet.beginSignTransaction()
    const p = session.send(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(10)
    // Universal-link takeover: the popup window dies without any postMessage.
    h.setPopupOpen(false)
    await vi.advanceTimersByTimeAsync(2000) // watchdog ticks past 500ms — must not reject
    status = { status: 'completed', signature: 'app-sig' }
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toEqual({ signature: 'app-sig' })
  })

  it('non-channel flows keep the POPUP_CLOSED watchdog behavior', async () => {
    const h = harness()
    stubRelay(() => ({ status: 'pending' }))
    const session = h.wallet.beginSignMessage()
    const p = session.send(new Uint8Array([1]))
    p.catch(() => {})
    h.setPopupOpen(false)
    await vi.advanceTimersByTimeAsync(600)
    await expect(p).rejects.toThrow('POPUP_CLOSED')
  })

  it('rejects with TIMEOUT when no signer ever responds', async () => {
    const h = harness()
    stubRelay(() => ({ status: 'pending' }))
    const session = h.wallet.beginSignTransaction()
    const p = session.send(new Uint8Array([1]))
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(301_000)
    await expect(p).rejects.toThrow('TIMEOUT')
  })

  it('send() survives a popup that already died when the channel leg exists', async () => {
    const h = harness()
    let status: Record<string, unknown> = { status: 'pending' }
    stubRelay(() => status)
    const session = h.wallet.beginSignTransaction()
    h.emit({ type: 'READY' })
    h.setPopupOpen(false) // takeover happened before the dApp finished building the tx
    const p = session.send(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(10)
    status = { status: 'completed', signature: 'late-sig' }
    await vi.advanceTimersByTimeAsync(2500)
    await expect(p).resolves.toEqual({ signature: 'late-sig' })
  })

  it('cancel() aborts the relay poll', async () => {
    const h = harness()
    const calls = stubRelay(() => ({ status: 'pending' }))
    const session = h.wallet.beginSignTransaction()
    const p = session.send(new Uint8Array([1]))
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(4500)
    session.cancel('done testing')
    const pollsAtCancel = calls.filter((c) => c.url.includes('result-poll')).length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.filter((c) => c.url.includes('result-poll')).length).toBe(pollsAtCancel)
    await expect(p).rejects.toThrow('CANCELLED')
  })
})
