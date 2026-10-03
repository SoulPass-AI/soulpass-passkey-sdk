// @vitest-environment node
import { describe, expect, it } from 'vitest'
import golden from './fixtures/solana-v1.json'
import { AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { getTransactionDecoder, getCompiledTransactionMessageDecoder } from '@solana/kit'
import { ed25519 } from '@noble/curves/ed25519'
import {
  compileV1Transaction, SolanaTransaction, SOLANA_SIMULATION_RESOURCES,
  resourcesFromSimulation, optimizeV1Transaction, MAX_PRIORITY_FEE_LAMPORTS,
  priorityFeeLamportsFromPrice, stripComputeBudget, normalizeDappTransaction,
  selectExternalWalletTransactionVersion, compileExternalWalletTransaction, SolanaTransactionCapacityError,
} from '../src/solana-transaction'

const payer = Keypair.fromSeed(new Uint8Array(32).fill(1))
const receiver = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey
const recentBlockhash = new PublicKey(new Uint8Array(32).fill(3)).toBase58()
const config = { ...SOLANA_SIMULATION_RESOURCES, computeUnitLimit: 20_000, priorityFeeLamports: 731n }
const transfer = () => compileV1Transaction({
  payerKey: payer.publicKey, recentBlockhash, config,
  instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: receiver, lamports: 123n })],
})

describe('v1 transaction boundary', () => {
  it('round trips signed bytes through the official decoder with config and signature at the tail', () => {
    const tx = transfer()
    tx.sign([payer])
    const bytes = tx.serialize()
    expect(bytes[0]).toBe(0x81)
    expect(bytes.slice(-64)).toEqual(tx.signatures[0])
    const official = getTransactionDecoder().decode(bytes)
    expect(getCompiledTransactionMessageDecoder().decode(official.messageBytes).version).toBe(1)
    expect(ed25519.verify(tx.signatures[0], Uint8Array.from(official.messageBytes), payer.publicKey.toBytes())).toBe(true)
    const restored = SolanaTransaction.deserialize(bytes)
    expect(restored.serialize()).toEqual(bytes)
    expect(restored.message.config).toEqual(config)
    expect(restored.message.instructions()[0]).toEqual(tx.message.instructions()[0])
  })

  it('accepts a full 4096 byte transaction and rejects the next byte including signature slots', () => {
    const compile = (dataBytes: number) => compileV1Transaction({ payerKey: payer.publicKey, recentBlockhash, config, instructions: [new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(dataBytes) })] })
    const overhead = compile(0).serialize().length
    expect(compile(4096 - overhead).serialize()).toHaveLength(4096)
    expect(() => compile(4097 - overhead)).toThrow('4096')
  })

  it('refuses legacy bytes, truncation, trailing data, and unknown signers', () => {
    const tx = transfer()
    const bytes = tx.serialize()
    expect(() => SolanaTransaction.deserialize(new Uint8Array([0]))).toThrow()
    expect(() => SolanaTransaction.deserialize(bytes.slice(0, -1))).toThrow()
    expect(() => SolanaTransaction.deserialize(new Uint8Array([...bytes, 0]))).toThrow()
    expect(() => tx.sign([Keypair.generate()])).toThrow('signer')
    expect(() => tx.addSignature(payer.publicKey, new Uint8Array(64))).toThrow('signature')
  })

  it('does not permit silent zero budgets or obsolete compute budget instructions', () => {
    expect(() => compileV1Transaction({ payerKey: payer.publicKey, recentBlockhash, instructions: [], config: { ...config, computeUnitLimit: 0 } })).toThrow('compute')
    expect(() => compileV1Transaction({ payerKey: payer.publicKey, recentBlockhash, config, instructions: [new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from([2, 1, 0, 0, 0]) })] })).toThrow('ComputeBudget')
  })

  it('adds measured headroom while keeping total priority fee constant, and fails closed on missing measurements', () => {
    expect(resourcesFromSimulation({ err: null, unitsConsumed: 100_000, loadedAccountsDataSize: 33_000 }, 731n)).toEqual({ computeUnitLimit: 110_000, loadedAccountsDataSizeLimit: 65_536, priorityFeeLamports: 731n })
    expect(() => resourcesFromSimulation({ err: null, unitsConsumed: 1 })).toThrow('omitted')
    expect(() => resourcesFromSimulation({ err: { InstructionError: [0, 'Custom'] } })).toThrow('failed')
  })
})

it('matches the shared official Kit / Swift wire and Ed25519 vector byte for byte', () => {
  const tx = compileV1Transaction({payerKey:new PublicKey(Buffer.from(golden.payerHex,'hex')),recentBlockhash:new PublicKey(Buffer.from(golden.blockhashHex,'hex')).toBase58(),
    config:{computeUnitLimit:20000,loadedAccountsDataSizeLimit:65536,priorityFeeLamports:731n,heapSize:32768},
    instructions:golden.instructions.map(ix=>new TransactionInstruction({programId:new PublicKey(Buffer.from(ix.programHex,'hex')),data:Buffer.from(ix.dataHex,'hex'),keys:ix.accounts.map(a=>({pubkey:new PublicKey(Buffer.from(a.keyHex,'hex')),isSigner:a.isSigner,isWritable:a.isWritable}))}))});
  expect(Buffer.from(tx.message.serialize()).toString('hex')).toBe(golden.messageHex);
  tx.sign([payer]); expect(Buffer.from(tx.serialize()).toString('hex')).toBe(golden.transactionHex);
});
it('reads resource measurements through the web3 RPC parser and never rewrites signed messages',async()=>{
  const connection=new Connection('https://rpc.test.invalid', {fetch: async (_url,init)=>{
    const req=JSON.parse(init!.body as string);
    expect(req.method).toBe('simulateTransaction');
    expect(Buffer.from(req.params[0],'base64')[0]).toBe(0x81);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{context:{slot:1},value:{err:null,logs:[],unitsConsumed:100000,loadedAccountsDataSize:33000}}}),{status:200,headers:{'content-type':'application/json'}});
  }});
  const tx=await optimizeV1Transaction(connection,transfer());
  expect(tx.message.config.computeUnitLimit).toBe(110000);expect(tx.message.config.loadedAccountsDataSizeLimit).toBe(65536);
  expect(tx.message.config.priorityFeeLamports).toBe(731n);
  tx.sign([payer]);await expect(optimizeV1Transaction(connection,tx)).rejects.toThrow('before signing');
});

describe('priority fee (D2/D3)', () => {
  it('turns a µL/CU price and measured CU into the v1 total, rounding up', () => {
    expect(priorityFeeLamportsFromPrice('0', 200_000)).toBe(0n)
    expect(priorityFeeLamportsFromPrice('1', 1)).toBe(1n)
    expect(priorityFeeLamportsFromPrice('50000', 200_000)).toBe(10_000n)
    expect(priorityFeeLamportsFromPrice(3n, 333_334)).toBe(2n)
  })

  it('clamps to MAX_PRIORITY_FEE_LAMPORTS and rejects malformed prices', () => {
    expect(MAX_PRIORITY_FEE_LAMPORTS).toBe(1_400_000n)
    expect(priorityFeeLamportsFromPrice('10000000', 1_400_000)).toBe(MAX_PRIORITY_FEE_LAMPORTS)
    for (const bad of ['', '-1', '1.5', '01', ' 1', '1e6', '99999999999999999999999']) {
      expect(() => priorityFeeLamportsFromPrice(bad, 1000), bad).toThrow('price')
    }
    expect(() => priorityFeeLamportsFromPrice('1', 0)).toThrow('compute unit limit')
  })

  it('refuses to compile a first-party v1 above the cap', () => {
    const instructions = [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: receiver, lamports: 1n })]
    expect(() => compileV1Transaction({ payerKey: payer.publicKey, recentBlockhash, instructions, config: { ...config, priorityFeeLamports: MAX_PRIORITY_FEE_LAMPORTS + 1n } })).toThrow('MAX_PRIORITY_FEE_LAMPORTS')
    expect(compileV1Transaction({ payerKey: payer.publicKey, recentBlockhash, instructions, config: { ...config, priorityFeeLamports: MAX_PRIORITY_FEE_LAMPORTS } }).message.config.priorityFeeLamports).toBe(MAX_PRIORITY_FEE_LAMPORTS)
  })

  it('optimizeV1Transaction derives the total from the price and the measured CU', async () => {
    const connection = new Connection('https://rpc.test.invalid', { fetch: async (_url, init) => {
      const req = JSON.parse(init!.body as string)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 100000, loadedAccountsDataSize: 33000 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    } })
    const tx = await optimizeV1Transaction(connection, transfer(), { computeUnitPriceMicroLamports: '50000' })
    expect(tx.message.config.computeUnitLimit).toBe(110_000)
    expect(tx.message.config.priorityFeeLamports).toBe(5_500n)
  })
})

describe('stripComputeBudget (dApp input)', () => {
  const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: receiver, lamports: 1n })
  it('drops CU limit / price / loaded-accounts / requestUnits and keeps the heap request', () => {
    const loaded = new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([4, 0, 0, 1, 0]) })
    const out = stripComputeBudget([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 9n }),
      loaded, ComputeBudgetProgram.requestHeapFrame({ bytes: 128 * 1024 }), ix,
    ])
    expect(out).toEqual({ instructions: [ix], heapSize: 128 * 1024 })
    expect(stripComputeBudget([ix])).toEqual({ instructions: [ix] })
  })
  it('rejects malformed, duplicate, or out-of-range budget instructions', () => {
    expect(() => stripComputeBudget([ComputeBudgetProgram.requestHeapFrame({ bytes: 16 * 1024 })])).toThrow('heap')
    expect(() => stripComputeBudget([ComputeBudgetProgram.requestHeapFrame({ bytes: 33 * 1024 + 1 })])).toThrow('1024')
    expect(() => stripComputeBudget([ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 2 })])).toThrow('Duplicate')
    expect(() => stripComputeBudget([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.from([9, 0, 0, 0, 0]) })])).toThrow('Invalid')
  })
})

describe('normalizeDappTransaction', () => {
  const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: receiver, lamports: 1n })
  const tableKey = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey
  const table = (deactivationSlot = BigInt('18446744073709551615')) => new AddressLookupTableAccount({
    key: tableKey, state: { deactivationSlot, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [receiver] },
  })
  const rpc = (value: AddressLookupTableAccount | null) => ({
    getAddressLookupTable: async () => ({ context: { slot: 1 }, value }),
    getLatestBlockhash: async () => ({ blockhash: recentBlockhash, lastValidBlockHeight: 1 }),
  })
  const v0 = () => new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000n }), ix],
  }).compileToV0Message([table()]))

  it('resolves v0 lookups through RPC and drops the dApp fee', async () => {
    const tx = await normalizeDappTransaction(v0().serialize(), rpc(table()))
    expect(tx.message.instructions()).toEqual([ix])
    expect(tx.message.config).toEqual(SOLANA_SIMULATION_RESOURCES)
  })

  it('refuses missing or deactivated lookup tables and signed input', async () => {
    await expect(normalizeDappTransaction(v0(), rpc(null))).rejects.toThrow('not found')
    await expect(normalizeDappTransaction(v0(), rpc(table(5n)))).rejects.toThrow('deactivated')
    const signed = v0(); signed.sign([payer])
    await expect(normalizeDappTransaction(signed, rpc(table()))).rejects.toThrow('Signed')
  })

  it('discards a v1 input\'s CU and fee but keeps its heap', async () => {
    const dapp = compileV1Transaction({ payerKey: payer.publicKey, recentBlockhash, instructions: [ix], config: { computeUnitLimit: 7, loadedAccountsDataSizeLimit: 7, priorityFeeLamports: 999n, heapSize: 40 * 1024 } })
    const tx = await normalizeDappTransaction(dapp.serialize(), rpc(null))
    expect(tx.message.config).toEqual({ ...SOLANA_SIMULATION_RESOURCES, heapSize: 40 * 1024 })
  })

  it('fills a legacy draft\'s missing blockhash and payer', async () => {
    const draft = new Transaction().add(ix)
    const tx = await normalizeDappTransaction(draft, rpc(null), { payerKey: payer.publicKey })
    expect(tx.message.staticAccountKeys[0]).toEqual(payer.publicKey)
    expect(tx.message.recentBlockhash).toBe(recentBlockhash)
  })
})

describe('external wallet negotiation (D1)', () => {
  const resources = { computeUnitLimit: 200_000, loadedAccountsDataSizeLimit: 65_536, priorityFeeLamports: 10_001n, heapSize: 64 * 1024 }
  const base = { payerKey: payer.publicKey, recentBlockhash, resources, instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: receiver, lamports: 1n })] }

  it('prefers 1, then 0, then legacy; refuses a wallet offering none', () => {
    expect(selectExternalWalletTransactionVersion(['legacy', 0, 1])).toBe(1)
    expect(selectExternalWalletTransactionVersion(new Set(['legacy', 0]))).toBe(0)
    expect(selectExternalWalletTransactionVersion(['legacy'])).toBe('legacy')
    expect(selectExternalWalletTransactionVersion(null)).toBe('legacy')
    expect(() => selectExternalWalletTransactionVersion([2])).toThrow('no usable')
  })

  it('v1 carries the resources in its config', () => {
    const out = compileExternalWalletTransaction({ ...base, supportedTransactionVersions: [1, 0] })
    expect(out.version).toBe(1)
    if (out.version !== 1) throw new Error("expected v1")
    expect(out.transaction.message.config).toEqual(resources)
  })

  it('v0/legacy prepend ComputeBudget instructions derived from the resources', () => {
    for (const version of [0, 'legacy'] as const) {
      const out = compileExternalWalletTransaction({ ...base, supportedTransactionVersions: [version] })
      expect(out.version).toBe(version)
      const tx = out.transaction as VersionedTransaction
      expect(tx.version).toBe(version)
      const keys = tx.message.staticAccountKeys
      const budget = tx.message.compiledInstructions.filter(ix => keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)).map(ix => Buffer.from(ix.data).toString('hex'))
      // limit 200000; price ceil(10001e6 / 200000) = 50005; loaded 65536; heap 65536.
      expect(budget).toEqual(['02400d0300', '0355c3000000000000', '0400000100', '0100000100'])
    }
  })

  it('omits the price instruction at a zero fee and uses the caller\'s lookup tables for v0', () => {
    const table = new AddressLookupTableAccount({ key: Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [receiver] } })
    const out = compileExternalWalletTransaction({ ...base, resources: { ...resources, priorityFeeLamports: 0n }, supportedTransactionVersions: [0], addressLookupTables: [table] })
    const tx = out.transaction as VersionedTransaction
    expect(tx.message.compiledInstructions).toHaveLength(4)
    expect(tx.message.addressTableLookups).toHaveLength(1)
  })

  it('throws instead of splitting when a draft exceeds 1232 bytes, and refuses budget instructions in the draft', () => {
    const big = new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(1100) })
    expect(() => compileExternalWalletTransaction({ ...base, instructions: [big], supportedTransactionVersions: ['legacy'] })).toThrow(SolanaTransactionCapacityError)
    expect(compileExternalWalletTransaction({ ...base, instructions: [big], supportedTransactionVersions: [1, 'legacy'] }).version).toBe(1)
    expect(() => compileExternalWalletTransaction({ ...base, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })], supportedTransactionVersions: [0] })).toThrow('resources')
  })
})
