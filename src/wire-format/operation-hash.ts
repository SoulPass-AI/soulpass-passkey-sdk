/**
 * Execute `operation_hash` — the value WebAuthn signs as challenge. Mirrors
 * `machine-wallet/program/src/processor/execute.rs::compute_message_hash`
 * (disc=1) and `compute_ephemeral_message_hash` (disc=16).
 *
 * Named by operation, not by discriminator or version: the version lives in
 * the tag alone (`machine_wallet_execute_v1` /
 * `machine_wallet_execute_ephemeral_v1`).
 *
 * Two distinct tags ensure a challenge signed for the disc=1 path can never
 * replay against the disc=16 handler. The ephemeral tag also length-prefixes
 * the bump array so two different bump-set sizes can't canonicalise to the same
 * byte sequence.
 */

import { concatBytes, requireLength } from './_bytes';
import { MAX_EPHEMERAL_SIGNERS } from './constants';
import { hashGoverned, MACHINE_WALLET_TAGS, type AuthorityMessageBase } from './authority-messages';

/** Instruction tag for the disc=1 Execute message hash. */
export const EXECUTE_TAG = new TextEncoder().encode(MACHINE_WALLET_TAGS.execute);

/**
 * Instruction tag for the disc=16 ExecuteWithEphemeralSigners message hash.
 * A different operation from Execute (different tag string), so a disc=1
 * challenge can never replay against the disc=16 handler.
 */
export const EXECUTE_EPHEMERAL_TAG = new TextEncoder().encode(
  MACHINE_WALLET_TAGS.executeEphemeral,
);

/**
 * Compute the disc=1 Execute challenge.
 *
 * Payload: `wallet(32) || creation_slot_u64_le || nonce_u64_le ||
 * max_slot_u64_le || inner_hash(32)`, hashed under the envelope and deployment
 * domain — see `hashSignedMessage`.
 *
 * `innerHash` MUST come from {@link import('./inner-hash').computeInnerHash} —
 * any other hash function will produce a value the chain rejects.
 */
export function computeExecuteMessage(
  args: AuthorityMessageBase & { innerHash: Uint8Array },
): Uint8Array {
  return hashGoverned(EXECUTE_TAG, args, requireLength(args.innerHash, 32, 'innerHash'));
}

/**
 * Compute the disc=16 ExecuteWithEphemeralSigners challenge.
 *
 * Payload: `wallet(32) || creation_slot_u64_le || nonce_u64_le ||
 * max_slot_u64_le || bumps_len(1) || bumps(bumps_len) || inner_hash(32)`.
 *
 * Throws `RangeError` unless `ephemeralSignerBumps` holds
 * 1..=`MAX_EPHEMERAL_SIGNERS` (4) bumps — encoded by the same
 * `encodeEphemeralBumps` as `buildExecuteIxData`.
 */
export function computeExecuteEphemeralMessage(
  args: AuthorityMessageBase & { ephemeralSignerBumps: Uint8Array; innerHash: Uint8Array },
): Uint8Array {
  return hashGoverned(
    EXECUTE_EPHEMERAL_TAG,
    args,
    encodeEphemeralBumps(args.ephemeralSignerBumps),
    requireLength(args.innerHash, 32, 'innerHash'),
  );
}

/**
 * `num_ephemeral(1) || bumps` — shared by the disc=16 ix data and its signed
 * message (`computeExecuteEphemeralMessage`), so nothing the chain would
 * reject gets signed first. Internal to `wire-format/`.
 *
 * Throws `RangeError` outside 1..=`MAX_EPHEMERAL_SIGNERS` (4): the decoder
 * rejects 0 or more than that (TooManyEphemeralSigners). An empty list is a caller bug,
 * not a request for disc=1 — omit the field for that.
 */
export function encodeEphemeralBumps(bumps: Uint8Array): Uint8Array {
  const n = bumps.length;
  if (n < 1 || n > MAX_EPHEMERAL_SIGNERS) {
    throw new RangeError(`ephemeralSignerBumps must hold 1..=${MAX_EPHEMERAL_SIGNERS} bumps, got ${n}`);
  }
  return concatBytes([Uint8Array.of(n), bumps]);
}
