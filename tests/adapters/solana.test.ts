// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { SoulPassWalletAdapter, deriveVaultPDA } from '../../src/adapters/solana'
import { asStatePdaKey } from '../../src/types'

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

describe('deriveVaultPDA', () => {
  it('derives the machine_vault PDA with the cached bump as the last seed (golden vector)', () => {
    const walletPDA = asStatePdaKey(new PublicKey('SouLi11jcPZGRS1yBfJDxcrDAWHNvJeSwph8pxZWzYw'))
    const vault = deriveVaultPDA(walletPDA, 254)
    expect(vault.toBase58()).toBe('Aeb61U3d3NpsQmt5UgxiJUXaXaUR8imbmsw5Z5imjj46')
  })

  it('throws rather than searching when the bump yields an on-curve point', () => {
    const walletPDA = asStatePdaKey(new PublicKey('SouLi11jcPZGRS1yBfJDxcrDAWHNvJeSwph8pxZWzYw'))
    expect(() => deriveVaultPDA(walletPDA, 252)).toThrow()
  })
})
