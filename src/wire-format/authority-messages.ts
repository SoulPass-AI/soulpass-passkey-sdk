/**
 * Message hashes for every authority-signed MachineWallet operation other than
 * Execute (which lives in `operation-hash.ts`).
 *
 * One definition per operation, in the package the chain-facing code already
 * depends on, so no consumer hand-rolls a preimage.
 *
 * Every payload below is pinned byte-for-byte against the contract's own KAT
 * vectors in `tests/wire-format/signed-message-kat.test.ts`.
 *
 * All operations except CreateWallet share the same preamble —
 * `wallet(32) || creation_slot_u64_le || nonce_u64_le || max_slot_u64_le` —
 * binding the signature to one wallet lifetime, one nonce, and one expiry.
 */

import type { PublicKey } from '@solana/web3.js';
import { requireByte, requireLength, u64LE } from './_bytes';
import { hashSignedMessage, type MachineWalletDeployment } from './signed-message';

const encoder = new TextEncoder();

/**
 * Every instruction tag the program signs under, verbatim from
 * `machine-wallet/program/src/processor/*.rs`. All `_v1`: the program has a
 * single account layout and a single message format per operation, so there
 * is no second version of any tag to confuse with the first.
 *
 * This table is the SDK's whole tag set — `signed-message-kat.test.ts` asserts
 * it equals the fixture's tag set exactly, so adding an operation here without
 * a contract vector (or vice versa) fails.
 */
export const MACHINE_WALLET_TAGS = {
  createWallet: 'machine_wallet_create_wallet_v1',
  execute: 'machine_wallet_execute_v1',
  executeEphemeral: 'machine_wallet_execute_ephemeral_v1',
  advanceNonce: 'machine_wallet_advance_nonce_v1',
  createSession: 'machine_wallet_create_session_v1',
  revokeSession: 'machine_wallet_revoke_session_v1',
  ownerCloseSession: 'machine_wallet_owner_close_session_v1',
  addAuthority: 'machine_wallet_add_authority_v1',
  addAuthorityPop: 'machine_wallet_add_authority_pop_v1',
  removeSelf: 'machine_wallet_remove_self_v1',
  removeOther: 'machine_wallet_remove_other_v1',
  setThreshold: 'machine_wallet_set_threshold_v1',
  close: 'machine_wallet_close_v1',
  rotateRoot: 'machine_wallet_rotate_root_v1',
  proposeRecovery: 'machine_wallet_propose_recovery_v1',
  cancelRecovery: 'machine_wallet_cancel_recovery_v1',
  executeRecovery: 'machine_wallet_execute_recovery_v1',
  setRecoveryThreshold: 'machine_wallet_set_recovery_threshold_v1',
  bumpEpoch: 'machine_wallet_bump_epoch_v1',
} as const;

export type MachineWalletTag = (typeof MACHINE_WALLET_TAGS)[keyof typeof MACHINE_WALLET_TAGS];

export const CREATE_WALLET_TAG = encoder.encode(MACHINE_WALLET_TAGS.createWallet);
export const CLOSE_WALLET_TAG = encoder.encode(MACHINE_WALLET_TAGS.close);
export const ADVANCE_NONCE_TAG = encoder.encode(MACHINE_WALLET_TAGS.advanceNonce);
export const CREATE_SESSION_TAG = encoder.encode(MACHINE_WALLET_TAGS.createSession);
export const REVOKE_SESSION_TAG = encoder.encode(MACHINE_WALLET_TAGS.revokeSession);
export const OWNER_CLOSE_SESSION_TAG = encoder.encode(MACHINE_WALLET_TAGS.ownerCloseSession);
export const ADD_AUTHORITY_TAG = encoder.encode(MACHINE_WALLET_TAGS.addAuthority);
/**
 * Signed by the key *being added*, proving it holds its private key. Distinct
 * from {@link ADD_AUTHORITY_TAG} so the incoming key's proof can never be
 * counted toward the existing owners' threshold.
 */
export const ADD_AUTHORITY_POP_TAG = encoder.encode(MACHINE_WALLET_TAGS.addAuthorityPop);
/** RemoveAuthority where the signer removes itself (`REMOVE_SELF_TAG` in remove_authority.rs). */
export const REMOVE_SELF_TAG = encoder.encode(MACHINE_WALLET_TAGS.removeSelf);
/** RemoveAuthority of another authority — root AND threshold (`REMOVE_OTHER_TAG` in remove_authority.rs). */
export const REMOVE_OTHER_TAG = encoder.encode(MACHINE_WALLET_TAGS.removeOther);
export const SET_THRESHOLD_TAG = encoder.encode(MACHINE_WALLET_TAGS.setThreshold);
/** RotateRoot, signed by the current root (`ROTATE_ROOT_TAG` in rotate_root.rs). */
export const ROTATE_ROOT_TAG = encoder.encode(MACHINE_WALLET_TAGS.rotateRoot);
export const PROPOSE_RECOVERY_TAG = encoder.encode(MACHINE_WALLET_TAGS.proposeRecovery);
export const CANCEL_RECOVERY_TAG = encoder.encode(MACHINE_WALLET_TAGS.cancelRecovery);
export const EXECUTE_RECOVERY_TAG = encoder.encode(MACHINE_WALLET_TAGS.executeRecovery);
export const SET_RECOVERY_THRESHOLD_TAG = encoder.encode(MACHINE_WALLET_TAGS.setRecoveryThreshold);
export const BUMP_EPOCH_TAG = encoder.encode(MACHINE_WALLET_TAGS.bumpEpoch);

/** Operands shared by every authority-signed operation except CreateWallet. */
export interface AuthorityMessageBase {
  walletPDA: PublicKey;
  creationSlot: bigint;
  nonce: bigint;
  maxSlot: bigint;
  deployment: MachineWalletDeployment;
}

/** The shared preamble bytes (see the module doc above). */
function authorityPayload(base: AuthorityMessageBase): Uint8Array[] {
  return [
    base.walletPDA.toBytes(),
    u64LE(base.creationSlot),
    u64LE(base.nonce),
    u64LE(base.maxSlot),
  ];
}

/**
 * Hash `tag` over the shared preamble followed by `operands`. Exported for
 * `operation-hash.ts`, whose Execute messages share this exact preamble.
 */
export function hashGoverned(tag: Uint8Array, base: AuthorityMessageBase, ...operands: Uint8Array[]): Uint8Array {
  return hashSignedMessage({
    deployment: base.deployment,
    tag,
    payloadParts: [...authorityPayload(base), ...operands],
  });
}

/**
 * CreateWallet: `wallet(32) || max_slot || sig_scheme(1) || authority(33)`.
 *
 * The only signed operation with no creation_slot/nonce — the wallet does not
 * exist yet, so there is no lifetime or nonce to bind to. Signing `sig_scheme`
 * prevents a known WebAuthn P-256 pubkey from being front-run into a raw
 * Secp256r1 wallet at the same PDA.
 *
 * This value IS the WebAuthn challenge for CreateWallet.
 */
export function computeCreateWalletMessage(args: {
  walletPDA: PublicKey;
  maxSlot: bigint;
  sigScheme: number;
  /** 33-byte compressed P-256 point. */
  authority: Uint8Array;
  deployment: MachineWalletDeployment;
}): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: CREATE_WALLET_TAG,
    payloadParts: [
      args.walletPDA.toBytes(),
      u64LE(args.maxSlot),
      requireByte(args.sigScheme, 'sigScheme'),
      requireLength(args.authority, 33, 'authority'),
    ],
  });
}

/** CloseWallet: preamble `|| destination(32)`. */
export function computeCloseWalletMessage(
  args: AuthorityMessageBase & { destination: Uint8Array },
): Uint8Array {
  return hashGoverned(CLOSE_WALLET_TAG, args, requireLength(args.destination, 32, 'destination'));
}

/** AdvanceNonce: the bare preamble. */
export function computeAdvanceNonceMessage(args: AuthorityMessageBase): Uint8Array {
  return hashGoverned(ADVANCE_NONCE_TAG, args);
}

/** CreateSession: preamble `|| session_data_hash(32)`. */
export function computeCreateSessionMessage(
  args: AuthorityMessageBase & { sessionDataHash: Uint8Array },
): Uint8Array {
  return hashGoverned(
    CREATE_SESSION_TAG,
    args,
    requireLength(args.sessionDataHash, 32, 'sessionDataHash'),
  );
}

/** RevokeSession (owner path): preamble `|| session_authority(32)`. */
export function computeRevokeSessionMessage(
  args: AuthorityMessageBase & { sessionAuthority: Uint8Array },
): Uint8Array {
  return hashGoverned(
    REVOKE_SESSION_TAG,
    args,
    requireLength(args.sessionAuthority, 32, 'sessionAuthority'),
  );
}

/**
 * OwnerCloseSession: preamble `|| session_authority(32)`.
 *
 * No destination: the rent always goes back to the session's recorded
 * `rent_payer` (it was the payer's deposit), so there is nothing to choose.
 */
export function computeOwnerCloseSessionMessage(
  args: AuthorityMessageBase & { sessionAuthority: Uint8Array },
): Uint8Array {
  return hashGoverned(
    OWNER_CLOSE_SESSION_TAG,
    args,
    requireLength(args.sessionAuthority, 32, 'sessionAuthority'),
  );
}

/**
 * AddAuthority — the existing owners' approval.
 * Preamble `|| new_sig_scheme(1) || new_pubkey(33) || new_threshold(1)`.
 */
export function computeAddAuthorityMessage(
  args: AuthorityMessageBase & {
    newSigScheme: number;
    newPubkey: Uint8Array;
    newThreshold: number;
  },
): Uint8Array {
  return hashGoverned(
    ADD_AUTHORITY_TAG,
    args,
    requireByte(args.newSigScheme, 'newSigScheme'),
    requireLength(args.newPubkey, 33, 'newPubkey'),
    requireByte(args.newThreshold, 'newThreshold'),
  );
}

/**
 * AddAuthority proof-of-possession — signed by the key being added.
 * Preamble `|| new_sig_scheme(1) || new_pubkey(33)`.
 *
 * The program requires this *in addition to* the owners' approval: approval
 * proves the add was authorized, this proves the key being added actually
 * exists. Without it, adding an unheld key and then removing the old authority
 * leaves the wallet owned by a key nobody can sign with — unrecoverable.
 *
 * `newThreshold` is deliberately absent: the incoming key attests only to its
 * own existence and consent to join at this nonce. What the threshold becomes
 * is the existing owners' decision, bound into the message they sign.
 */
export function computeAddAuthorityPopMessage(
  args: AuthorityMessageBase & { newSigScheme: number; newPubkey: Uint8Array },
): Uint8Array {
  return hashGoverned(
    ADD_AUTHORITY_POP_TAG,
    args,
    requireByte(args.newSigScheme, 'newSigScheme'),
    requireLength(args.newPubkey, 33, 'newPubkey'),
  );
}

/** Operands naming one authority slot: `sig_scheme(1) || pubkey(33)`. */
export interface AuthorityKeyOperand {
  sigScheme: number;
  /** 33-byte compressed P-256 point. */
  pubkey: Uint8Array;
}

function keyOperand(args: AuthorityKeyOperand): Uint8Array[] {
  return [requireByte(args.sigScheme, 'sigScheme'), requireLength(args.pubkey, 33, 'pubkey')];
}

/**
 * RemoveAuthority, self-removal: preamble `|| sig_scheme(1) || pubkey(33) ||
 * new_threshold(1)`. The key named signs (proving consent), plus the usual
 * threshold.
 */
export function computeRemoveSelfMessage(
  args: AuthorityMessageBase & AuthorityKeyOperand & { newThreshold: number },
): Uint8Array {
  return hashGoverned(
    REMOVE_SELF_TAG,
    args,
    ...keyOperand(args),
    requireByte(args.newThreshold, 'newThreshold'),
  );
}

/**
 * RemoveAuthority of another authority (root AND threshold): same payload as
 * {@link computeRemoveSelfMessage} under a distinct tag, so a self-removal
 * signature can never authorize removing someone else.
 */
export function computeRemoveOtherMessage(
  args: AuthorityMessageBase & AuthorityKeyOperand & { newThreshold: number },
): Uint8Array {
  return hashGoverned(
    REMOVE_OTHER_TAG,
    args,
    ...keyOperand(args),
    requireByte(args.newThreshold, 'newThreshold'),
  );
}

/** SetThreshold: preamble `|| new_threshold(1)`. */
export function computeSetThresholdMessage(
  args: AuthorityMessageBase & { newThreshold: number },
): Uint8Array {
  return hashGoverned(SET_THRESHOLD_TAG, args, requireByte(args.newThreshold, 'newThreshold'));
}

/**
 * RotateRoot: preamble `|| sig_scheme(1) || pubkey(33)` naming the new root,
 * which must already be an authority. Signed by the current root.
 */
export function computeRotateRootMessage(
  args: AuthorityMessageBase & AuthorityKeyOperand,
): Uint8Array {
  return hashGoverned(ROTATE_ROOT_TAG, args, ...keyOperand(args));
}

/**
 * ProposeRecovery: preamble `|| sig_scheme(1) || pubkey(33)` naming an
 * existing authority as the next root. Approved by the recovery threshold;
 * starts the recovery delay.
 */
export function computeProposeRecoveryMessage(
  args: AuthorityMessageBase & AuthorityKeyOperand,
): Uint8Array {
  return hashGoverned(PROPOSE_RECOVERY_TAG, args, ...keyOperand(args));
}

/**
 * ExecuteRecovery: same payload as {@link computeProposeRecoveryMessage}
 * (the pending root), signed by the pending root itself once the delay has
 * elapsed. The distinct tag keeps a proposal signature from executing.
 */
export function computeExecuteRecoveryMessage(
  args: AuthorityMessageBase & AuthorityKeyOperand,
): Uint8Array {
  return hashGoverned(EXECUTE_RECOVERY_TAG, args, ...keyOperand(args));
}

/** CancelRecovery (root-signed veto): the bare preamble. */
export function computeCancelRecoveryMessage(args: AuthorityMessageBase): Uint8Array {
  return hashGoverned(CANCEL_RECOVERY_TAG, args);
}

/**
 * BumpEpoch: the bare preamble. Any single authority may sign it — it only
 * invalidates every session created under the current authority epoch.
 */
export function computeBumpEpochMessage(args: AuthorityMessageBase): Uint8Array {
  return hashGoverned(BUMP_EPOCH_TAG, args);
}

/**
 * SetRecoveryThreshold (root AND threshold): preamble `|| recovery_threshold(1)`.
 * `0` follows the spending threshold.
 */
export function computeSetRecoveryThresholdMessage(
  args: AuthorityMessageBase & { recoveryThreshold: number },
): Uint8Array {
  return hashGoverned(
    SET_RECOVERY_THRESHOLD_TAG,
    args,
    requireByte(args.recoveryThreshold, 'recoveryThreshold'),
  );
}
