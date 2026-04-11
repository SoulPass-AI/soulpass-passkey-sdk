import { describe, it, expect } from 'vitest'
import { SoulPassWalletAdapter } from '../../src/adapters/solana'

describe('SoulPassWalletAdapter', () => {
  it('has correct adapter metadata', () => {
    const adapter = new SoulPassWalletAdapter()
    expect(adapter.name).toBe('SoulPass')
    expect(adapter.url).toBe('https://soulpass.ai')
    expect(adapter.readyState).toBe('Installed')
    expect(adapter.connected).toBe(false)
    expect(adapter.publicKey).toBeNull()
  })

  it('exposes Wallet Adapter interface methods', () => {
    const adapter = new SoulPassWalletAdapter({ network: 'devnet' })
    expect(typeof adapter.connect).toBe('function')
    expect(typeof adapter.disconnect).toBe('function')
    expect(typeof adapter.signTransaction).toBe('function')
    expect(typeof adapter.signMessage).toBe('function')
  })
})
