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

import { requireByte, requireLength } from './_bytes';
import {
  authorityPayload,
  MACHINE_WALLET_TAGS,
  type AuthorityMessageBase,
} from './authority-messages';
import { hashSignedMessage } from './signed-message';

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
