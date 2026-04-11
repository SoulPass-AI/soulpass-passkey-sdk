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
})
