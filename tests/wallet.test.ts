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
