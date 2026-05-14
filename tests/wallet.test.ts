import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SoulPassWallet } from '../src/wallet'

describe('SoulPassWallet', () => {
  let wallet: SoulPassWallet

  beforeEach(() => {
    wallet = new SoulPassWallet({ network: 'devnet' })
  })

  it('initializes as disconnected', () => {
    expect(wallet.connected).toBe(false)
    expect(wallet.publicKey).toBeNull()
    expect(wallet.walletAddress).toBeNull()
  })

  it('emits connect event', () => {
    const handler = vi.fn()
    wallet.on('connect', handler)

    // Simulate internal state update via private method
    wallet['handleConnectSuccess']({
      publicKey: '7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG',
      walletAddress: '4rL8RczAsg3MHfJkMPXN5pzGYrmE1EWQP6pJqBrxVo',
    })

    expect(handler).toHaveBeenCalledWith('7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG')
    expect(wallet.connected).toBe(true)
    expect(wallet.publicKey).toBe('7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG')
  })

  it('emits disconnect event', () => {
    const handler = vi.fn()
    wallet.on('disconnect', handler)

    wallet['handleConnectSuccess']({
      publicKey: '7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG',
      walletAddress: '4rL8RczAsg3MHfJkMPXN5pzGYrmE1EWQP6pJqBrxVo',
    })
    wallet.disconnect()

    expect(handler).toHaveBeenCalled()
    expect(wallet.connected).toBe(false)
    expect(wallet.publicKey).toBeNull()
  })

  it('throws on signTransaction when disconnected', async () => {
    await expect(wallet.signTransaction(new Uint8Array())).rejects.toThrow('Wallet not connected')
  })

  it('throws on signMessage when disconnected', async () => {
    await expect(wallet.signMessage(new Uint8Array())).rejects.toThrow('Wallet not connected')
  })

  it('removes event handler with off()', () => {
    const handler = vi.fn()
    wallet.on('disconnect', handler)
    wallet.off('disconnect', handler)

    wallet['handleConnectSuccess']({
      publicKey: 'test',
      walletAddress: 'test',
    })
    wallet.disconnect()

    expect(handler).not.toHaveBeenCalled()
  })

  it('forwards productType to popup on CONNECT', () => {
    // Why this is pinned: passkey signin is hosted by a cross-origin popup whose
    // own X-Exchange-Info reflects productType=soulpass. The dApp's productType
    // (e.g. 'tens') must reach matrix-user via the CONNECT payload → popup verify
    // body → JwtSessionStore.issueWithProductOverride. Drop the forwarding and
    // the JWT lands under the popup's namespace and the Gateway on the dApp's
    // domain returns 401 immediately after sign-in.
    const w = new SoulPassWallet({ network: 'devnet', productType: 'tens' })
    const sendSpy = vi.spyOn(w['popup'], 'send').mockImplementation(() => {})
    vi.spyOn(w['popup'], 'open').mockImplementation(() => ({}) as Window)
    let onMessage: ((msg: any) => void) | null = null
    vi.spyOn(w['popup'], 'onMessage').mockImplementation((h) => {
      onMessage = h as typeof onMessage
    })
    vi.spyOn(w['popup'], 'close').mockImplementation(() => {})

    void w.connect()
    // Popup handshake — the SDK only sends CONNECT after READY arrives, so the
    // forwarding bug is invisible until a real popup is loaded. Synthesizing
    // READY here exercises the same code path under unit-test latency.
    onMessage?.({ type: 'READY' })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'CONNECT',
      id: expect.any(String),
      payload: { network: 'devnet', productType: 'tens' },
    })
  })

  describe('beginSignTransaction (two-phase)', () => {
    /**
     * The whole point of the two-phase API is to keep `popup.open()` on the
     * synchronous click-handler tick. These tests pin the state machine so a
     * refactor that re-orders open/send/onMessage can't silently re-introduce
     * the popup-becomes-a-tab regression.
     */
    function setupPopupSpies(w: SoulPassWallet) {
      const openSpy = vi
        .spyOn(w['popup'], 'open')
        .mockImplementation(() => ({}) as Window)
      const sendSpy = vi.spyOn(w['popup'], 'send').mockImplementation(() => {})
      let onMessage: ((msg: any) => void) | null = null
      vi.spyOn(w['popup'], 'onMessage').mockImplementation((h) => {
        onMessage = h as typeof onMessage
      })
      vi.spyOn(w['popup'], 'close').mockImplementation(() => {})
      return { openSpy, sendSpy, getOnMessage: () => onMessage }
    }

    function connected(): SoulPassWallet {
      const w = new SoulPassWallet({ network: 'devnet' })
      w['handleConnectSuccess']({
        publicKey: '7xKXjJ8x9kN3mNpQrStuvWxY1zZ2aAbBcCdDeEfFgG',
        walletAddress: '4rL8RczAsg3MHfJkMPXN5pzGYrmE1EWQP6pJqBrxVo',
      })
      return w
    }

    it('opens the popup synchronously (preserves user gesture)', () => {
      const w = connected()
      const { openSpy } = setupPopupSpies(w)
      w.beginSignTransaction()
      // Same-tick assertion — open() must have fired before any microtask hop.
      expect(openSpy).toHaveBeenCalledWith('/wallet/sign')
    })

    it('queues send() until popup READY arrives', () => {
      const w = connected()
      const { sendSpy, getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()

      // Caller calls send before popup has loaded — must NOT send yet.
      void session.send(new Uint8Array([1, 2, 3]))
      expect(sendSpy).not.toHaveBeenCalled()

      // Popup boots → SDK flushes the queued SIGN_TRANSACTION message.
      getOnMessage()?.({ type: 'READY' })
      expect(sendSpy).toHaveBeenCalledTimes(1)
      const message = sendSpy.mock.calls[0][0] as { type: string }
      expect(message.type).toBe('SIGN_TRANSACTION')
    })

    it('sends immediately when send() is called after popup READY', () => {
      const w = connected()
      const { sendSpy, getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()

      // Popup ready first → no queued payload to flush yet.
      getOnMessage()?.({ type: 'READY' })
      expect(sendSpy).not.toHaveBeenCalled()

      // Caller's tx-build resolves → send() posts straightaway.
      void session.send(new Uint8Array([1, 2, 3]))
      expect(sendSpy).toHaveBeenCalledTimes(1)
    })

    it('resolves with the signature on SIGN_SUCCESS', async () => {
      const w = connected()
      const { getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()
      getOnMessage()?.({ type: 'READY' })

      const promise = session.send(new Uint8Array([1, 2, 3]))
      // The popup answers with the matching id — pull it off the spy.
      const messageId = (
        vi.mocked(w['popup'].send).mock.calls[0][0] as { id: string }
      ).id
      getOnMessage()?.({
        type: 'SIGN_SUCCESS',
        id: messageId,
        payload: { signature: 'sigBase58' },
      })
      await expect(promise).resolves.toEqual({ signature: 'sigBase58' })
    })

    it('cancel() rejects a pending send() with CANCELLED', async () => {
      const w = connected()
      setupPopupSpies(w)
      const session = w.beginSignTransaction()
      const promise = session.send(new Uint8Array([1]))
      session.cancel('user closed')
      await expect(promise).rejects.toThrow(/CANCELLED/)
    })

    it('throws on a second send() — sessions are single-shot', async () => {
      const w = connected()
      const { getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()
      getOnMessage()?.({ type: 'READY' })

      // First call wires up the pending promise but never resolves (no
      // SIGN_SUCCESS injected). Second call must reject immediately so a
      // confused caller can't accidentally double-spend.
      void session.send(new Uint8Array([1]))
      await expect(session.send(new Uint8Array([2]))).rejects.toThrow(/single-shot/)
    })

    it('rejects send() on popup ERROR', async () => {
      const w = connected()
      const { getOnMessage } = setupPopupSpies(w)
      const session = w.beginSignTransaction()
      getOnMessage()?.({ type: 'READY' })

      const promise = session.send(new Uint8Array([1]))
      const messageId = (
        vi.mocked(w['popup'].send).mock.calls[0][0] as { id: string }
      ).id
      getOnMessage()?.({
        type: 'ERROR',
        id: messageId,
        payload: { code: 'USER_REJECTED', message: 'user said no' },
      })
      await expect(promise).rejects.toThrow(/USER_REJECTED.*user said no/)
    })
  })

  it('omits productType from CONNECT when not configured (back-compat)', () => {
    // Older popup builds may strictly typecheck the payload — sending an explicit
    // `productType: undefined` key would still trip a "has own property" guard.
    // Spread-conditional in wallet.ts keeps the key absent when no productType.
    const w = new SoulPassWallet({ network: 'devnet' })
    const sendSpy = vi.spyOn(w['popup'], 'send').mockImplementation(() => {})
    vi.spyOn(w['popup'], 'open').mockImplementation(() => ({}) as Window)
    let onMessage: ((msg: any) => void) | null = null
    vi.spyOn(w['popup'], 'onMessage').mockImplementation((h) => {
      onMessage = h as typeof onMessage
    })
    vi.spyOn(w['popup'], 'close').mockImplementation(() => {})

    void w.connect()
    onMessage?.({ type: 'READY' })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const sentMessage = sendSpy.mock.calls[0][0] as { payload: Record<string, unknown> }
    expect(sentMessage.payload).toEqual({ network: 'devnet' })
    expect('productType' in sentMessage.payload).toBe(false)
  })
})
