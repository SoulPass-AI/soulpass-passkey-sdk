/**
 * ExecuteBounded's outcome bounds (disc=25): what the owner signs instead of a
 * route. Mirrors `machine-wallet/program/src/instruction.rs` `BalanceBounds`.
 */

import { PublicKey } from '@solana/web3.js';
import { bytesEqual, concatBytes, requireLength, u64LE } from './_bytes';
import { MAX_BALANCE_BOUNDS, NATIVE_SOL_MINT, WSOL_MINT } from './constants';

/** Wire `kind` of a {@link BalanceBound} (`instruction::BalanceFloor`). */
export const BalanceBoundKind = {
  /** The vault's balance of the mint may fall by at most `amount`. */
  MaxOut: 0,
  /** The vault's balance of the mint must rise by at least `amount`. */
  MinIn: 1,
} as const;

/**
 * One signed bound on an ExecuteBounded: the least net change the call may
 * leave in the vault's balance of `mint`, over every vault token account.
 * `mint` is 32 bytes; SOL is {@link NATIVE_SOL_MINT} (all zero) and covers
 * wrapped SOL too — a bound naming the wSOL mint matches nothing (build swap
 * bounds with {@link swapBalanceBounds}). A mint with no bound may not fall.
 */
export interface BalanceBound {
  mint: Uint8Array;
  kind: (typeof BalanceBoundKind)[keyof typeof BalanceBoundKind];
  amount: bigint;
}

/**
 * `bound_count(1) || bound_count × (mint 32 | kind u8 | amount u64 LE)` —
 * shared by the disc=25 ix data and its signed message. Internal to
 * `wire-format/`.
 *
 * Throws `RangeError` for what the program's decoder rejects
 * (`BalanceBounds::from_bytes`, `InvalidInstructionData`): more than
 * {@link MAX_BALANCE_BOUNDS}, a kind above 1, a mint named twice.
 */
export function encodeBalanceBounds(bounds: ReadonlyArray<BalanceBound>): Uint8Array {
  validateBalanceBounds(bounds);
  return concatBytes([Uint8Array.of(bounds.length), ...bounds.flatMap((b) => [b.mint, Uint8Array.of(b.kind), u64LE(b.amount)])]);
}

/**
 * `BalanceBounds::from_bytes`'s rules, in one place for the encoder and the
 * decoder: at most {@link MAX_BALANCE_BOUNDS}, 32-byte mints, kind 0 or 1, no
 * mint named twice. Throws `RangeError` naming the offending entry.
 */
export function validateBalanceBounds(bounds: ReadonlyArray<BalanceBound>): void {
  if (bounds.length > MAX_BALANCE_BOUNDS) {
    throw new RangeError(`bounds must hold at most ${MAX_BALANCE_BOUNDS} entries, got ${bounds.length}`);
  }
  bounds.forEach((b, i) => {
    requireLength(b.mint, 32, `bounds[${i}].mint`);
    if (b.kind !== BalanceBoundKind.MaxOut && b.kind !== BalanceBoundKind.MinIn) {
      throw new RangeError(`bounds[${i}].kind must be 0 or 1, got ${String(b.kind)}`);
    }
    if (bounds.slice(0, i).some((prior) => bytesEqual(prior.mint, b.mint))) {
      throw new RangeError(`bounds[${i}] names a mint already bounded`);
    }
  });
}

/** A swap end's bound mint: SOL and wSOL are SOL (a copy — `NATIVE_SOL_MINT` is shared), anything else its own 32 bytes. */
function boundMint(mint: string): Uint8Array {
  return mint === WSOL_MINT ? NATIVE_SOL_MINT.slice() : new PublicKey(mint).toBytes();
}

/**
 * The two bounds of a vault swap, from the amounts the USER confirmed — never
 * from a planner's echo: at most `amountIn` of the input mint out (kind 0), at
 * least `minOut` of the output mint in (kind 1). A SOL or wSOL end is the
 * all-zero mint (a bound naming the wSOL mint matches nothing on chain, so a
 * required gain there always fails).
 *
 * `amountIn` assumes the vault pays no rent to a non-vault account in this
 * call (sponsor-paid ATA creates); a path where it does must add that to a SOL
 * input's cap. Throws on a non-positive amount or a pair that is one mint after
 * the wSOL mapping (a SOL ↔ wSOL "swap" has no outcome to bound).
 */
export function swapBalanceBounds(p: { inputMint: string; amountIn: bigint; outputMint: string; minOut: bigint }): BalanceBound[] {
  if (p.amountIn <= 0n) throw new RangeError(`swap amountIn must be positive, got ${p.amountIn}`);
  if (p.minOut <= 0n) throw new RangeError(`swap minOut must be positive, got ${p.minOut}`);
  const input = boundMint(p.inputMint);
  const output = boundMint(p.outputMint);
  if (bytesEqual(input, output)) {
    throw new RangeError(`swap ${p.inputMint} → ${p.outputMint} is one mint once wSOL counts as SOL`);
  }
  return [
    { mint: input, kind: BalanceBoundKind.MaxOut, amount: p.amountIn },
    { mint: output, kind: BalanceBoundKind.MinIn, amount: p.minOut },
  ];
}
