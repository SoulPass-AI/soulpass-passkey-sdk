/** The single first-party Solana wire format: v1, with inline accounts. */
import {
  address, blockhash, compileTransactionMessage, decompileTransactionMessage,
  getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder,
  getTransactionDecoder, getTransactionEncoder,
  type CompiledTransactionMessageWithLifetime, type V1CompiledTransactionMessage,
  type V1TransactionConfig, type Transaction as KitTransaction,
} from '@solana/kit'
import { ed25519 } from '@noble/curves/ed25519'
import {
  ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount, type Signer, type Connection, type SimulateTransactionConfig,
  type SimulatedTransactionResponse, type RpcResponseAndContext,
} from '@solana/web3.js'
import { uint8ArrayToBase64 } from './encoding'
import { isAllZero } from './wire-format/_bytes'

export class SolanaTransactionCapacityError extends Error {
  constructor(message: string) { super(message); this.name = 'SolanaTransactionCapacityError' }
}

export const SOLANA_TRANSACTION_MAX_BYTES = 4096
/** Legacy and v0 packet limit; only external-wallet compiles use it. */
export const SOLANA_LEGACY_TRANSACTION_MAX_BYTES = 1232
export const SOLANA_MAX_COMPUTE_UNITS = 1_400_000
export const SOLANA_MAX_LOADED_ACCOUNT_BYTES = 64 * 1024 * 1024
/**
 * Ceiling on the TOTAL priority fee of any first-party v1 transaction
 * (0.0014 SOL). One value shared by both SDKs and the sponsor (matrix-contract),
 * which rejects anything above it.
 */
export const MAX_PRIORITY_FEE_LAMPORTS = 1_400_000n
const MIN_HEAP_BYTES = 32 * 1024
const MAX_HEAP_BYTES = 256 * 1024

/** Explicit limits are mandatory in v1: omitted CU/data budgets mean zero. */
export type SolanaTransactionResources = Readonly<{
  computeUnitLimit: number
  loadedAccountsDataSizeLimit: number
  priorityFeeLamports: bigint
  heapSize?: number
}>

/** Probe with these limits; use measured resources for the final transaction. */
export const SOLANA_SIMULATION_RESOURCES: SolanaTransactionResources = Object.freeze({
  computeUnitLimit: SOLANA_MAX_COMPUTE_UNITS,
  loadedAccountsDataSizeLimit: SOLANA_MAX_LOADED_ACCOUNT_BYTES,
  priorityFeeLamports: 0n,
})

function integerInRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
}

function validateHeapSize(heapSize: number): void {
  integerInRange(heapSize, MIN_HEAP_BYTES, MAX_HEAP_BYTES, 'heap size')
  if (heapSize % 1024 !== 0) throw new Error('Heap size must be a multiple of 1024')
}

export function validateSolanaResources(config: V1TransactionConfig): asserts config is SolanaTransactionResources {
  integerInRange(config.computeUnitLimit ?? 0, 1, SOLANA_MAX_COMPUTE_UNITS, 'compute unit limit')
  integerInRange(config.loadedAccountsDataSizeLimit ?? 0, 1, SOLANA_MAX_LOADED_ACCOUNT_BYTES, 'loaded account data limit')
  if (typeof config.priorityFeeLamports !== 'bigint' || config.priorityFeeLamports < 0n || config.priorityFeeLamports > 0xffff_ffff_ffff_ffffn) {
    throw new Error('Invalid total priority fee')
  }
  if (config.heapSize !== undefined) validateHeapSize(config.heapSize)
}

/**
 * The V1 total priority fee for a route's price signal (market
 * `computeUnitPriceMicroLamports`, µL/CU as a decimal string) and the measured
 * CU limit: `ceil(price × cu / 1e6)`, clamped to
 * {@link MAX_PRIORITY_FEE_LAMPORTS} — a congested price buys the capped fee,
 * never a transaction the sponsor refuses.
 */
export function priorityFeeLamportsFromPrice(computeUnitPriceMicroLamports: string | bigint, computeUnitLimit: number): bigint {
  const price = typeof computeUnitPriceMicroLamports === 'bigint'
    ? computeUnitPriceMicroLamports
    : /^(0|[1-9]\d{0,19})$/.test(computeUnitPriceMicroLamports) ? BigInt(computeUnitPriceMicroLamports) : -1n
  if (price < 0n || price > 0xffff_ffff_ffff_ffffn) throw new Error('Invalid compute unit price')
  integerInRange(computeUnitLimit, 1, SOLANA_MAX_COMPUTE_UNITS, 'compute unit limit')
  const total = (price * BigInt(computeUnitLimit) + 999_999n) / 1_000_000n
  return total > MAX_PRIORITY_FEE_LAMPORTS ? MAX_PRIORITY_FEE_LAMPORTS : total
}

// ── Priority-fee price (D6) ─────────────────────────────────────────────────

/** Ceiling on an estimated price, µL/CU. An explicit caller price is clamped only by the total cap. */
export const MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 1_000_000n
/** Helius accepts at most 64 `accountKeys`; v1 transactions carry at most 64 accounts anyway. */
const MAX_PRICE_ACCOUNT_KEYS = 64

/**
 * One JSON-RPC call: resolves to the response's `result`, rejects on a
 * transport failure or a JSON-RPC `error`. soulpass-ai passes its backend
 * gateway (`(method, params) => backendRpc(slug, method, params)`).
 */
export type SolanaJsonRpcCall = (method: string, params: readonly unknown[]) => Promise<unknown>
/** Where a Solana RPC call goes: a URL, a web3.js `Connection`, or a JSON-RPC caller. */
export type SolanaRpcSource = string | Connection | SolanaJsonRpcCall

let rpcRequestId = 0

/** Normalise any {@link SolanaRpcSource} into a {@link SolanaJsonRpcCall}. */
export function toSolanaJsonRpcCall(rpc: SolanaRpcSource): SolanaJsonRpcCall {
  if (typeof rpc === 'function') return rpc
  if (typeof rpc === 'string') {
    return async (method, params) => {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcRequestId, method, params }),
      })
      if (!response.ok) throw new Error(`RPC ${method} failed: HTTP ${response.status}`)
      return jsonRpcResult(method, await response.json())
    }
  }
  // web3.js 1.x keeps its transport (custom fetch, headers) behind `_rpcRequest`.
  const request = (rpc as unknown as { _rpcRequest?: (method: string, params: unknown[]) => Promise<unknown> })._rpcRequest
  if (typeof request !== 'function') throw new Error('Connection exposes no JSON-RPC transport')
  return async (method, params) => jsonRpcResult(method, await request.call(rpc, method, [...params]))
}

function jsonRpcResult(method: string, envelope: unknown): unknown {
  const body = envelope as { result?: unknown; error?: { code?: number; message?: string } } | null
  if (body?.error) throw new Error(`RPC ${method} failed (${body.error.code ?? '?'}): ${body.error.message ?? 'unknown error'}`)
  if (!body || !('result' in body)) throw new Error(`RPC ${method} returned no result`)
  return body.result
}

/** Anything whose write-locked accounts can be read: a v1 transaction / message, a web3 transaction, or a draft. */
export type WritableKeysSource =
  | SolanaTransaction
  | SolanaMessage
  | VersionedTransaction
  | Transaction
  | Readonly<{ payerKey: PublicKey; instructions: readonly TransactionInstruction[] }>

/**
 * The accounts a transaction write-locks, fee payer first — what priority is
 * priced on. A v0 message's looked-up writable accounts are included only when
 * `addressLookupTableAccounts` is supplied.
 */
export function writableAccountKeys(
  source: WritableKeysSource,
  opts: { addressLookupTableAccounts?: readonly AddressLookupTableAccount[] } = {},
): string[] {
  const keys = new Set<string>()
  const add = (key: PublicKey | undefined) => { if (key) keys.add(key.toBase58()) }
  const message = source instanceof SolanaTransaction ? source.message : source
  if (message instanceof SolanaMessage || message instanceof VersionedTransaction) {
    const msg = message instanceof VersionedTransaction ? message.message : message
    const accounts = 'addressTableLookups' in msg && msg.addressTableLookups.length > 0 && opts.addressLookupTableAccounts
      ? msg.getAccountKeys({ addressLookupTableAccounts: [...opts.addressLookupTableAccounts] })
      : msg.getAccountKeys()
    for (let i = 0; i < accounts.length; i++) if (msg.isAccountWritable(i)) add(accounts.get(i))
  } else {
    add(message instanceof Transaction ? message.feePayer ?? message.signatures[0]?.publicKey : message.payerKey)
    for (const ix of message.instructions) for (const meta of ix.keys) if (meta.isWritable) add(meta.pubkey)
  }
  return [...keys]
}

/** p75 of the non-zero samples (nearest-rank), 0 when every sample is zero. */
function recentFeesP75(samples: unknown): bigint {
  if (!Array.isArray(samples)) throw new Error('getRecentPrioritizationFees returned no samples')
  const fees = samples
    .map(s => Number((s as { prioritizationFee?: unknown })?.prioritizationFee))
    .filter(fee => Number.isFinite(fee) && fee > 0)
    .sort((a, b) => a - b)
  return fees.length === 0 ? 0n : BigInt(Math.ceil(fees[Math.ceil(fees.length * 0.75) - 1]))
}

/**
 * The compute-unit price (µL/CU) for a transaction's write-locked accounts:
 *
 * 1. Helius `getPriorityFeeEstimate` in accountKeys mode, `priorityLevel: "High"`;
 * 2. where that is unavailable (a public node: method not found), p75 of the
 *    non-zero `getRecentPrioritizationFees` samples for the same keys;
 * 3. any further failure → `0n`, logged, never blocking the send.
 *
 * Clamped to {@link MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS}. Turn it into the
 * v1 total with {@link priorityFeeLamportsFromPrice}.
 */
export async function estimateComputeUnitPriceMicroLamports(
  rpc: SolanaRpcSource,
  writableKeys: readonly (string | PublicKey)[],
  opts: { priorityLevel?: string } = {},
): Promise<bigint> {
  const keys = [...new Set(writableKeys.map(key => typeof key === 'string' ? key : key.toBase58()))].slice(0, MAX_PRICE_ACCOUNT_KEYS)
  const clamp = (price: bigint) => price > MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS ? MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS : price
  let call: SolanaJsonRpcCall
  try { call = toSolanaJsonRpcCall(rpc) } catch (error) { return warnZero(error) }
  try {
    const result = await call('getPriorityFeeEstimate', [{ accountKeys: keys, options: { priorityLevel: opts.priorityLevel ?? 'High' } }])
    const fee = Number((result as { priorityFeeEstimate?: unknown } | null)?.priorityFeeEstimate)
    if (!Number.isFinite(fee) || fee < 0) throw new Error('getPriorityFeeEstimate returned no estimate')
    return clamp(BigInt(Math.ceil(fee)))
  } catch {
    try {
      return clamp(recentFeesP75(await call('getRecentPrioritizationFees', [keys])))
    } catch (error) {
      return warnZero(error)
    }
  }
}

function warnZero(error: unknown): bigint {
  console.warn('[SoulPass SDK] priority fee estimate unavailable; sending at 0 µL/CU:', error instanceof Error ? error.message : error)
  return 0n
}

/**
 * The v1 total priority fee for a measured CU limit: the explicit caller price
 * when given (market's route price, CLI `--cu-price`), otherwise the
 * estimate for the transaction's writable accounts. Capped at
 * {@link MAX_PRIORITY_FEE_LAMPORTS}.
 */
export async function resolvePriorityFeeLamports(args: {
  rpc: SolanaRpcSource
  writableAccountKeys: readonly (string | PublicKey)[]
  computeUnitLimit: number
  computeUnitPriceMicroLamports?: string | bigint
}): Promise<bigint> {
  const price = args.computeUnitPriceMicroLamports ?? await estimateComputeUnitPriceMicroLamports(args.rpc, args.writableAccountKeys)
  return priorityFeeLamportsFromPrice(price, args.computeUnitLimit)
}

function isComputeBudget(ix: TransactionInstruction): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId)
}

/**
 * Split a dApp's ComputeBudget instructions off its instruction list. CU limit,
 * CU price and loaded-account limits are discarded (our simulation sets them;
 * a dApp never sets what the sponsor or the user pays); a heap request is kept
 * because execution may need it. Malformed or repeated budget instructions are
 * rejected, as the runtime would.
 */
export function stripComputeBudget(instructions: readonly TransactionInstruction[]): { instructions: TransactionInstruction[]; heapSize?: number } {
  const kept: TransactionInstruction[] = []
  const seen = new Set<number>()
  let heapSize: number | undefined
  for (const ix of instructions) {
    if (!isComputeBudget(ix)) { kept.push(ix); continue }
    const data = ix.data
    const tag = data[0]
    const width = tag === 0 || tag === 3 ? 9 : 5
    if (ix.keys.length !== 0 || data.length !== width || tag > 4) throw new Error('Invalid compute budget instruction')
    if (seen.has(tag)) throw new Error('Duplicate compute budget instruction')
    seen.add(tag)
    if (tag === 1) {
      heapSize = data.readUInt32LE(1)
      validateHeapSize(heapSize)
    }
  }
  return heapSize === undefined ? { instructions: kept } : { instructions: kept, heapSize }
}

type CompiledMessage = V1CompiledTransactionMessage & CompiledTransactionMessageWithLifetime

/** Web3 instruction interoperability; all wire encoding is owned by official Kit. */
export class SolanaMessage {
  readonly version = 1 as const
  readonly staticAccountKeys: readonly PublicKey[]
  readonly header: Readonly<{ numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number }>
  readonly compiledInstructions: readonly Readonly<{ programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }>[]
  readonly recentBlockhash: string
  readonly config: SolanaTransactionResources
  private readonly bytes: Uint8Array

  constructor(compiled: CompiledMessage) {
    if ((compiled.configMask & ~31) || ((compiled.configMask & 3) !== 0 && (compiled.configMask & 3) !== 3)) throw new Error('Unsupported v1 transaction config')
    const source = decompileTransactionMessage(compiled)
    const config = { priorityFeeLamports: 0n, ...source.config }
    validateSolanaResources(config)
    const h = compiled.header
    if (compiled.staticAccounts.length > 64) throw new SolanaTransactionCapacityError('Solana transaction exceeds 64 accounts')
    if (compiled.staticAccounts.length < 1) throw new Error('Invalid account count')
    integerInRange(compiled.instructionHeaders.length, 1, 64, 'instruction count')
    integerInRange(h.numSignerAccounts, 1, compiled.staticAccounts.length, 'signer count')
    integerInRange(h.numReadonlySignerAccounts, 0, h.numSignerAccounts - 1, 'readonly signer count')
    integerInRange(h.numReadonlyNonSignerAccounts, 0, compiled.staticAccounts.length - h.numSignerAccounts, 'readonly account count')
    if (new Set(compiled.staticAccounts).size !== compiled.staticAccounts.length) throw new Error('Duplicate transaction account')
    if (compiled.numStaticAccounts !== compiled.staticAccounts.length || compiled.numInstructions !== compiled.instructionHeaders.length || compiled.instructionPayloads.length !== compiled.numInstructions) {
      throw new Error('Invalid v1 message counts')
    }
    this.staticAccountKeys = Object.freeze(compiled.staticAccounts.map(key => new PublicKey(key)))
    this.header = Object.freeze({
      numRequiredSignatures: h.numSignerAccounts,
      numReadonlySignedAccounts: h.numReadonlySignerAccounts,
      numReadonlyUnsignedAccounts: h.numReadonlyNonSignerAccounts,
    })
    this.compiledInstructions = Object.freeze(compiled.instructionHeaders.map((ix, i) => {
      const payload = compiled.instructionPayloads[i]
      const indexes = [...(payload.instructionAccountIndices ?? [])]
      const data = Uint8Array.from(payload.instructionData ?? [])
      integerInRange(ix.programAccountIndex, 0, this.staticAccountKeys.length - 1, 'program index')
      for (const index of indexes) integerInRange(index, 0, this.staticAccountKeys.length - 1, 'account index')
      if (ix.numInstructionAccounts !== indexes.length || ix.numInstructionDataBytes !== data.length) throw new Error('Invalid v1 instruction lengths')
      if (this.staticAccountKeys[ix.programAccountIndex].equals(ComputeBudgetProgram.programId)) throw new Error('Use v1 resource config instead of ComputeBudget instructions')
      return Object.freeze({ programIdIndex: ix.programAccountIndex, accountKeyIndexes: indexes, data })
    }))
    this.recentBlockhash = compiled.lifetimeToken
    this.config = Object.freeze(config)
    this.bytes = Uint8Array.from(getCompiledTransactionMessageEncoder().encode(compiled))
    if (this.bytes.length + h.numSignerAccounts * 64 > SOLANA_TRANSACTION_MAX_BYTES) throw new SolanaTransactionCapacityError('Solana transaction exceeds 4096 bytes')
  }

  serialize(): Uint8Array { return this.bytes.slice() }
  isAccountSigner(index: number): boolean { return index >= 0 && index < this.header.numRequiredSignatures }
  isAccountWritable(index: number): boolean {
    if (index < 0 || index >= this.staticAccountKeys.length) return false
    const h = this.header
    return this.isAccountSigner(index)
      ? index < h.numRequiredSignatures - h.numReadonlySignedAccounts
      : index < this.staticAccountKeys.length - h.numReadonlyUnsignedAccounts
  }
  getAccountKeys(): { get(index: number): PublicKey | undefined; length: number; staticAccountKeys: readonly PublicKey[] } {
    return { get: index => this.staticAccountKeys[index], length: this.staticAccountKeys.length, staticAccountKeys: this.staticAccountKeys }
  }
  instructions(): TransactionInstruction[] {
    return this.compiledInstructions.map(ix => new TransactionInstruction({
      programId: this.staticAccountKeys[ix.programIdIndex],
      keys: ix.accountKeyIndexes.map(i => ({ pubkey: this.staticAccountKeys[i], isSigner: this.isAccountSigner(i), isWritable: this.isAccountWritable(i) })),
      data: Buffer.from(ix.data),
    }))
  }
}

export class SolanaTransaction {
  readonly version = 1 as const
  readonly message: SolanaMessage
  readonly signatures: Uint8Array[]
  constructor(message: SolanaMessage, signatures?: readonly Uint8Array[]) {
    this.message = message
    this.signatures = signatures?.map(sig => sig.slice()) ?? Array.from({ length: message.header.numRequiredSignatures }, () => new Uint8Array(64))
    this.validateSignatures()
  }
  private validateSignatures(): void {
    if (this.signatures.length !== this.message.header.numRequiredSignatures || this.signatures.some(sig => sig.length !== 64)) throw new Error('Invalid transaction signatures')
  }
  addSignature(publicKey: PublicKey, signature: Uint8Array): void {
    const index = this.message.staticAccountKeys.findIndex(key => key.equals(publicKey))
    if (!this.message.isAccountSigner(index) || signature.length !== 64) throw new Error('Invalid transaction signer')
    if (!ed25519.verify(signature, this.message.serialize(), publicKey.toBytes())) throw new Error('Invalid transaction signature')
    this.signatures[index] = signature.slice()
  }
  sign(signers: readonly Signer[]): void {
    const message = this.message.serialize()
    for (const signer of signers) this.addSignature(signer.publicKey, ed25519.sign(message, signer.secretKey.subarray(0, 32)))
  }
  serialize(): Uint8Array {
    this.validateSignatures()
    // The decoder supplies Kit's branded message/signature types and validates framing.
    const message = this.message.serialize()
    const framed = new Uint8Array(message.length + this.signatures.length * 64)
    framed.set(message)
    this.signatures.forEach((sig, i) => framed.set(sig, message.length + i * 64))
    return Uint8Array.from(getTransactionEncoder().encode(getTransactionDecoder().decode(framed)))
  }
  static deserialize(bytes: Uint8Array): SolanaTransaction {
    if (bytes.length > SOLANA_TRANSACTION_MAX_BYTES || bytes[0] !== 0x81) throw new Error('Expected a v1 transaction of at most 4096 bytes')
    const decoded: KitTransaction = getTransactionDecoder().decode(bytes)
    const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)
    if (compiled.version !== 1) throw new Error('Expected a v1 message')
    const message = new SolanaMessage(compiled)
    const signatures = compiled.staticAccounts.slice(0, message.header.numRequiredSignatures).map(key => Uint8Array.from(decoded.signatures[key] ?? new Uint8Array(64)))
    const tx = new SolanaTransaction(message, signatures)
    const canonical = tx.serialize()
    if (canonical.length !== bytes.length || canonical.some((byte, i) => byte !== bytes[i])) throw new Error('Noncanonical v1 transaction')
    return tx
  }
}

/** Compile a first-party v1 transaction; the total priority fee is capped at {@link MAX_PRIORITY_FEE_LAMPORTS}. */
export function compileV1Transaction(args: {
  payerKey: PublicKey
  recentBlockhash: string
  instructions: readonly TransactionInstruction[]
  config: SolanaTransactionResources
}): SolanaTransaction {
  validateSolanaResources(args.config)
  if (args.config.priorityFeeLamports > MAX_PRIORITY_FEE_LAMPORTS) throw new Error('Total priority fee exceeds MAX_PRIORITY_FEE_LAMPORTS')
  const compiled = compileTransactionMessage({
    version: 1,
    feePayer: { address: address(args.payerKey.toBase58()) },
    lifetimeConstraint: { blockhash: blockhash(args.recentBlockhash), lastValidBlockHeight: 0n },
    config: args.config,
    instructions: args.instructions.map(ix => ({
      programAddress: address(ix.programId.toBase58()),
      accounts: ix.keys.map(key => ({ address: address(key.pubkey.toBase58()), role: (key.isSigner ? 2 : 0) | (key.isWritable ? 1 : 0) })),
      data: ix.data,
    })),
  })
  return new SolanaTransaction(new SolanaMessage(compiled))
}

/** A fixed total priority fee does not increase when resource headroom is added. */
export function resourcesFromSimulation(result: {
  err: unknown
  unitsConsumed?: number
  loadedAccountsDataSize?: number
}, priorityFeeLamports = 0n): SolanaTransactionResources {
  if (result.err != null) throw new Error('Solana transaction simulation failed')
  if (result.unitsConsumed === undefined || result.loadedAccountsDataSize === undefined) throw new Error('RPC omitted transaction resource measurements')
  integerInRange(result.unitsConsumed, 0, SOLANA_MAX_COMPUTE_UNITS, 'measured compute units')
  integerInRange(result.loadedAccountsDataSize, 0, SOLANA_MAX_LOADED_ACCOUNT_BYTES, 'measured loaded account data')
  const config = {
    computeUnitLimit: Math.min(SOLANA_MAX_COMPUTE_UNITS, Math.max(1, Math.ceil(result.unitsConsumed * 110 / 100))),
    loadedAccountsDataSizeLimit: Math.min(SOLANA_MAX_LOADED_ACCOUNT_BYTES, Math.max(32_768, Math.ceil(result.loadedAccountsDataSize * 110 / (100 * 32_768)) * 32_768)),
    priorityFeeLamports,
  }
  validateSolanaResources(config)
  return config
}

/**
 * Call after authority proofs are filled, before any outer Ed25519 signature.
 * The total priority fee is derived from the measured CU limit
 * ({@link priorityFeeLamportsFromPrice}) at `computeUnitPriceMicroLamports`
 * when the caller sets one, otherwise at the estimate for the transaction's
 * writable accounts ({@link estimateComputeUnitPriceMicroLamports}, asked of
 * `priorityFeeRpc`, default `rpc`).
 */
export async function optimizeV1Transaction(
  rpc: SolanaRpcSource,
  transaction: SolanaTransaction,
  options: { computeUnitPriceMicroLamports?: string | bigint; priorityFeeRpc?: SolanaRpcSource } = {},
): Promise<SolanaTransaction> {
  if (hasSignature(transaction.signatures)) throw new Error('Estimate resources before signing the outer transaction')
  const { message } = transaction
  const draft = { payerKey: message.staticAccountKeys[0], recentBlockhash: message.recentBlockhash, instructions: message.instructions() }
  const probe = compileV1Transaction({ ...draft, config: { ...SOLANA_SIMULATION_RESOURCES, priorityFeeLamports: message.config.priorityFeeLamports, heapSize: message.config.heapSize } })
  // The price depends only on the writable accounts, so it is asked for alongside the simulation.
  const [result, price] = await Promise.all([
    simulateProbe(rpc, probe),
    options.computeUnitPriceMicroLamports ?? estimateComputeUnitPriceMicroLamports(options.priorityFeeRpc ?? rpc, writableAccountKeys(transaction)),
  ])
  const config = resourcesFromSimulation(result)
  return compileV1Transaction({ ...draft, config: { ...config, priorityFeeLamports: priorityFeeLamportsFromPrice(price, config.computeUnitLimit), heapSize: message.config.heapSize } })
}

async function simulateProbe(rpc: SolanaRpcSource, probe: SolanaTransaction): Promise<{ err: unknown; unitsConsumed?: number; loadedAccountsDataSize?: number }> {
  type Simulation = { err: unknown; unitsConsumed?: number | bigint; loadedAccountsDataSize?: number | bigint }
  const result = await toSolanaJsonRpcCall(rpc)('simulateTransaction', [uint8ArrayToBase64(probe.serialize()), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }])
  const value: Simulation = (result as { value?: Simulation } | null)?.value ?? { err: 'RPC returned no simulation' }
  return {
    err: value.err,
    unitsConsumed: value.unitsConsumed === undefined ? undefined : Number(value.unitsConsumed),
    loadedAccountsDataSize: value.loadedAccountsDataSize === undefined ? undefined : Number(value.loadedAccountsDataSize),
  }
}

/** web3.js 1.x's versioned RPC overload only serializes the supplied transaction. */
export function simulateV1Transaction(connection: Connection, transaction: SolanaTransaction, config: SimulateTransactionConfig): Promise<RpcResponseAndContext<SimulatedTransactionResponse>> {
  const simulate = connection.simulateTransaction as unknown as (tx: SolanaTransaction, options: SimulateTransactionConfig) => Promise<RpcResponseAndContext<SimulatedTransactionResponse>>
  return simulate.call(connection, transaction, config)
}

// ── External wallets (Phantom, Wallet Standard) ─────────────────────────────

/** The transaction formats an external wallet can be handed, best first. */
export type ExternalWalletTransactionVersion = 1 | 0 | 'legacy'

/**
 * Pick the format for an external wallet from what it advertises
 * (Wallet Standard `solana:signTransaction.supportedTransactionVersions`, or
 * a wallet-adapter's `supportedTransactionVersions`): `1` when offered, else
 * `0`, else `'legacy'`. A wallet-adapter `null` means legacy-only. A wallet
 * offering none of the three is an explicit error.
 */
export function selectExternalWalletTransactionVersion(
  supported: Iterable<string | number> | null | undefined,
): ExternalWalletTransactionVersion {
  if (supported == null) return 'legacy'
  const offered = new Set<string | number>(supported)
  if (offered.has(1)) return 1
  if (offered.has(0)) return 0
  if (offered.has('legacy')) return 'legacy'
  throw new Error('External wallet supports no usable Solana transaction version')
}

/**
 * The ComputeBudget instructions equivalent to v1 resources, for a legacy or
 * v0 compile: CU limit, CU price `ceil(total × 1e6 / cu)` (omitted when the
 * total is zero), loaded-accounts limit, and the heap request when set.
 */
export function computeBudgetInstructions(resources: SolanaTransactionResources): TransactionInstruction[] {
  validateSolanaResources(resources)
  const cu = resources.computeUnitLimit
  const loaded = Buffer.alloc(5)
  loaded[0] = 4
  loaded.writeUInt32LE(resources.loadedAccountsDataSizeLimit, 1)
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cu }),
    ...(resources.priorityFeeLamports > 0n
      ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: (resources.priorityFeeLamports * 1_000_000n + BigInt(cu) - 1n) / BigInt(cu) })]
      : []),
    new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: loaded }),
    ...(resources.heapSize === undefined ? [] : [ComputeBudgetProgram.requestHeapFrame({ bytes: resources.heapSize })]),
  ]
}

export type ExternalWalletTransaction =
  | Readonly<{ version: 1; transaction: SolanaTransaction }>
  | Readonly<{ version: 0 | 'legacy'; transaction: VersionedTransaction }>

/**
 * The one place an external-wallet transaction is compiled (tens-gg and
 * soulpass-ai call this; no local copies). The format is negotiated from the
 * wallet's advertised versions **before** any signature — ephemeral keypairs
 * sign the returned, unsigned transaction.
 *
 * - `1`: a v1 transaction carrying `resources` in its config (4096 bytes).
 * - `0`: ComputeBudget instructions derived from `resources` appended after the
 *   caller's instructions (so fixed indices such as an Ed25519 precompile at 0
 *   stay valid; the runtime reads budgets from any position), the caller's
 *   address lookup tables applied when supplied (1232 bytes).
 * - `'legacy'`: the same suffix, inline accounts (1232 bytes).
 *
 * The draft must not carry its own ComputeBudget instructions. A draft that
 * does not fit the chosen format throws {@link SolanaTransactionCapacityError};
 * it is never split or downgraded.
 */
export function compileExternalWalletTransaction(args: {
  supportedTransactionVersions: Iterable<string | number> | null | undefined
  payerKey: PublicKey
  recentBlockhash: string
  instructions: readonly TransactionInstruction[]
  resources: SolanaTransactionResources
  addressLookupTables?: readonly AddressLookupTableAccount[]
}): ExternalWalletTransaction {
  if (args.instructions.some(isComputeBudget)) throw new Error('Pass resources instead of ComputeBudget instructions')
  const version = selectExternalWalletTransactionVersion(args.supportedTransactionVersions)
  if (version === 1) {
    return { version, transaction: compileV1Transaction({ payerKey: args.payerKey, recentBlockhash: args.recentBlockhash, instructions: args.instructions, config: args.resources }) }
  }
  const message = new TransactionMessage({
    payerKey: args.payerKey,
    recentBlockhash: args.recentBlockhash,
    instructions: [...args.instructions, ...computeBudgetInstructions(args.resources)],
  })
  const tooLarge = () => new SolanaTransactionCapacityError(`Solana ${version} transaction exceeds ${SOLANA_LEGACY_TRANSACTION_MAX_BYTES} bytes`)
  let transaction: VersionedTransaction
  let size: number
  try {
    transaction = new VersionedTransaction(version === 0
      ? message.compileToV0Message(args.addressLookupTables ? [...args.addressLookupTables] : [])
      : message.compileToLegacyMessage())
    size = transaction.serialize().length
  } catch (error) {
    // web3.js encodes into a 1232-byte buffer and overruns it on oversize drafts.
    if (error instanceof RangeError) throw tooLarge()
    throw error
  }
  if (size > SOLANA_LEGACY_TRANSACTION_MAX_BYTES) throw tooLarge()
  return { version, transaction }
}

// ── dApp input to the SoulPass wallet ───────────────────────────────────────

/** What a dApp may hand the wallet: a web3 draft, legacy / v0 / v1 bytes or objects. */
export type DappTransactionInput = Transaction | VersionedTransaction | SolanaTransaction | Uint8Array

function hasSignature(signatures: readonly (Uint8Array | null)[]): boolean {
  return signatures.some(sig => sig !== null && !isAllZero(sig))
}

/**
 * Turn a dApp transaction (legacy, v0 or v1) into the unsigned v1 draft the
 * wallet wraps in its Execute. v0 lookup tables are resolved through
 * `connection` (a missing or deactivated table is an explicit error). The
 * dApp's ComputeBudget instructions and v1 CU / loaded-accounts / priority-fee
 * config are discarded — the wallet simulates and sets them — while a heap
 * request is kept. Signed input is refused: rebuilding it would drop the
 * signatures.
 */
export async function normalizeDappTransaction(
  input: DappTransactionInput,
  connection: Pick<Connection, 'getAddressLookupTable' | 'getLatestBlockhash'>,
  defaults: { payerKey?: PublicKey } = {},
): Promise<SolanaTransaction> {
  let payerKey: PublicKey | undefined
  let recentBlockhash: string | undefined
  let instructions: TransactionInstruction[]
  let heapSize: number | undefined
  const decoded = input instanceof Uint8Array
    ? (input[0] === 0x81 ? SolanaTransaction.deserialize(input) : VersionedTransaction.deserialize(input))
    : input
  const tx = decoded instanceof VersionedTransaction && decoded.version === 1 ? SolanaTransaction.deserialize(decoded.serialize()) : decoded
  const signatures = tx instanceof Transaction ? tx.signatures.map(slot => slot.signature) : tx.signatures
  if (hasSignature(signatures)) throw new Error('Signed dApp transactions cannot be rewrapped')
  if (tx instanceof SolanaTransaction) {
    payerKey = tx.message.staticAccountKeys[0]
    recentBlockhash = tx.message.recentBlockhash
    instructions = tx.message.instructions()
    heapSize = tx.message.config.heapSize
  } else if (tx instanceof VersionedTransaction) {
    const addressLookupTableAccounts = await Promise.all(tx.message.addressTableLookups.map(async lookup => {
      const table = (await connection.getAddressLookupTable(lookup.accountKey)).value
      if (!table) throw new Error(`Address lookup table ${lookup.accountKey.toBase58()} not found`)
      if (!table.isActive()) throw new Error(`Address lookup table ${lookup.accountKey.toBase58()} is deactivated`)
      return table
    }))
    const decompiled = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts })
    payerKey = decompiled.payerKey
    recentBlockhash = decompiled.recentBlockhash
    instructions = decompiled.instructions
  } else {
    payerKey = tx.feePayer
    recentBlockhash = tx.recentBlockhash
    instructions = tx.instructions
  }
  const stripped = stripComputeBudget(instructions)
  payerKey ??= defaults.payerKey
  if (!payerKey) throw new Error('dApp transaction has no fee payer')
  recentBlockhash ??= (await connection.getLatestBlockhash()).blockhash
  heapSize = stripped.heapSize ?? heapSize
  return compileV1Transaction({
    payerKey,
    recentBlockhash,
    instructions: stripped.instructions,
    config: heapSize === undefined ? SOLANA_SIMULATION_RESOURCES : { ...SOLANA_SIMULATION_RESOURCES, heapSize },
  })
}
