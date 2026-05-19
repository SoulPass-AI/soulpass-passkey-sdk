/**
 * Execute `operation_hash` — the value WebAuthn signs as challenge. Mirrors
 * `machine-wallet/program/src/processor/execute.rs::compute_message_hash`
 * (v0) and `compute_message_hash_v1` (v16).
 *
 * Two distinct domain separators (`_v0` / `_v1`) ensure a challenge signed for
 * the legacy disc=1 path can never replay against the disc=16 handler. `_v1`
 * also length-prefixes the bump array so two different bump-set sizes can't
 * canonicalise to the same byte sequence.
 */

import type { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { u64LE, concatBytes } from './_bytes';

/** Domain separator for disc=1 Execute message hash. */
export const EXECUTE_MESSAGE_DOMAIN_V0 = new TextEncoder().encode(
  'machine_wallet_execute_v0',
);

/** Domain separator for disc=16 ExecuteWithEphemeralSigners message hash. */
export const EXECUTE_MESSAGE_DOMAIN_V1 = new TextEncoder().encode(
  'machine_wallet_execute_v1',
);

/**
 * Compute disc=1 Execute challenge:
 *
 *   keccak256(
 *     "machine_wallet_execute_v0" ||
 *     wallet(32) || creation_slot_u64_le || nonce_u64_le || max_slot_u64_le ||
 *     inner_hash(32)
 *   )
 *
 * `innerHash` MUST come from {@link import('./inner-hash').computeInnerHash} —
 * any other hash function will produce a value the chain rejects.
 */
export function computeExecuteMessageV0(args: {
  walletPDA: PublicKey;
  creationSlot: bigint;
  nonce: bigint;
  maxSlot: bigint;
  innerHash: Uint8Array;
}): Uint8Array {
  if (args.innerHash.length !== 32) {
    throw new RangeError(`innerHash must be 32 bytes, got ${args.innerHash.length}`);
  }
  return keccak_256(
    concatBytes([
      EXECUTE_MESSAGE_DOMAIN_V0,
      args.walletPDA.toBytes(),
      u64LE(args.creationSlot),
      u64LE(args.nonce),
      u64LE(args.maxSlot),
      args.innerHash,
    ]),
  );
}

/**
 * Compute disc=16 ExecuteWithEphemeralSigners challenge:
 *
 *   keccak256(
 *     "machine_wallet_execute_v1" ||
 *     wallet(32) || creation_slot_u64_le || nonce_u64_le || max_slot_u64_le ||
 *     bumps_len(1) || bumps(bumps_len) ||
 *     inner_hash(32)
 *   )
 *
 * The `bumps_len` byte caps `ephemeralSignerBumps.length` at 255 — well above
 * the on-chain `MAX_EPHEMERAL_SIGNERS = 4`. The explicit guard documents the
 * wire-format ceiling rather than silently truncating.
 */
export function computeExecuteMessageV1(args: {
  walletPDA: PublicKey;
  creationSlot: bigint;
  nonce: bigint;
  maxSlot: bigint;
  ephemeralSignerBumps: Uint8Array;
  innerHash: Uint8Array;
}): Uint8Array {
  if (args.innerHash.length !== 32) {
    throw new RangeError(`innerHash must be 32 bytes, got ${args.innerHash.length}`);
  }
  if (args.ephemeralSignerBumps.length > 255) {
    throw new RangeError(
      `ephemeralSignerBumps must fit in a u8 length prefix (≤255), ` +
        `got ${args.ephemeralSignerBumps.length}`,
    );
  }
  return keccak_256(
    concatBytes([
      EXECUTE_MESSAGE_DOMAIN_V1,
      args.walletPDA.toBytes(),
      u64LE(args.creationSlot),
      u64LE(args.nonce),
      u64LE(args.maxSlot),
      Uint8Array.of(args.ephemeralSignerBumps.length),
      args.ephemeralSignerBumps,
      args.innerHash,
    ]),
  );
}
