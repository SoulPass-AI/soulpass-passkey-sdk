/**
 * Execute `operation_hash` — the value WebAuthn signs as challenge. Mirrors
 * `machine-wallet/program/src/processor/execute.rs::compute_message_hash`
 * (disc=1) and `compute_ephemeral_message_hash` (disc=16).
 *
 * Naming: these used to be `computeExecuteMessageV0` / `...V1`, where the
 * suffix meant the instruction discriminator. That collided head-on with the
 * protocol's own versioning — on chain, plain Execute is now
 * `machine_wallet_execute_v1` and the ephemeral variant is
 * `machine_wallet_execute_ephemeral_v2`, so "V1" would have named the wrong
 * one. Named by operation instead; the version lives in the tag alone.
 *
 * Two distinct tags ensure a challenge signed for the disc=1 path can never
 * replay against the disc=16 handler. The ephemeral tag also length-prefixes
 * the bump array so two different bump-set sizes can't canonicalise to the same
 * byte sequence.
 */

import { requireByte, requireLength } from './_bytes';
import { authorityPayload, type AuthorityMessageBase } from './authority-messages';
import { hashSignedMessage } from './signed-message';

/** Instruction tag for the disc=1 Execute message hash. */
export const EXECUTE_TAG = new TextEncoder().encode('machine_wallet_execute_v1');

/**
 * Instruction tag for the disc=16 ExecuteWithEphemeralSigners message hash.
 *
 * `_v2`, not `_v1`: plain Execute owns `machine_wallet_execute_v1`. Do not
 * "fix" this to match the neighbouring constant — they name different
 * operations, and making them agree would point the ephemeral path at Execute's
 * tag.
 */
export const EXECUTE_EPHEMERAL_TAG = new TextEncoder().encode(
  'machine_wallet_execute_ephemeral_v2',
);

/**
 * Compute the disc=1 Execute challenge.
 *
 * Payload: `wallet(32) || creation_slot_u64_le || nonce_u64_le ||
 * max_slot_u64_le || inner_hash(32)`, hashed under the envelope and deployment
 * domain — see {@link hashSignedMessage}.
 *
 * `innerHash` MUST come from {@link import('./inner-hash').computeInnerHash} —
 * any other hash function will produce a value the chain rejects.
 */
export function computeExecuteMessage(
  args: AuthorityMessageBase & { innerHash: Uint8Array },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: EXECUTE_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireLength(args.innerHash, 32, 'innerHash'),
    ],
  });
}

/**
 * Compute the disc=16 ExecuteWithEphemeralSigners challenge.
 *
 * Payload: `wallet(32) || creation_slot_u64_le || nonce_u64_le ||
 * max_slot_u64_le || bumps_len(1) || bumps(bumps_len) || inner_hash(32)`.
 *
 * The `bumps_len` byte caps `ephemeralSignerBumps.length` at 255 — well above
 * the on-chain `MAX_EPHEMERAL_SIGNERS = 4`. `requireByte` throws at the
 * wire-format ceiling rather than silently truncating.
 */
export function computeExecuteEphemeralMessage(
  args: AuthorityMessageBase & { ephemeralSignerBumps: Uint8Array; innerHash: Uint8Array },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: EXECUTE_EPHEMERAL_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireByte(args.ephemeralSignerBumps.length, 'ephemeralSignerBumps length'),
      args.ephemeralSignerBumps,
      requireLength(args.innerHash, 32, 'innerHash'),
    ],
  });
}
