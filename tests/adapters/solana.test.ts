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

describe('SoulPassWalletAdapter.sendTransaction — dApp input', () => {
  it('accepts an Anchor draft with a ComputeBudget prefix: budgets dropped, heap kept, v1 sent', async () => {
    const { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } = await import('@solana/web3.js')
    const { SolanaTransaction, SOLANA_SIMULATION_RESOURCES } = await import('../../src/solana-transaction')
    const adapter = new SoulPassWalletAdapter({ network: 'devnet' })
    let sent: Uint8Array | undefined
    ;(adapter as unknown as { wallet: { signAndSendTransaction(b: Uint8Array): Promise<string> } }).wallet.signAndSendTransaction =
      async (bytes) => { sent = bytes; return 'sig' }
    const payer = Keypair.generate().publicKey
    const draft = new Transaction({ feePayer: payer, recentBlockhash: new PublicKey(new Uint8Array(32).fill(3)).toBase58() }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
    )
    const connection = { getAddressLookupTable: async () => { throw new Error('unused') }, getLatestBlockhash: async () => { throw new Error('unused') } }
    await expect(adapter.sendTransaction(draft, connection as never)).resolves.toBe('sig')
    const v1 = SolanaTransaction.deserialize(sent!)
    expect(v1.message.instructions()).toHaveLength(1)
    expect(v1.message.config).toEqual({ ...SOLANA_SIMULATION_RESOURCES, heapSize: 64 * 1024 })
  })

  it('advertises legacy, v0 and v1 input', () => {
    expect([...new SoulPassWalletAdapter().supportedTransactionVersions]).toEqual(['legacy', 0, 1])
  })
})
