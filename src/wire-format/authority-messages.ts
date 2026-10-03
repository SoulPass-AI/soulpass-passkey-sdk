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
 * `wallet(32) || creation_slot_u64_le || counter_u64_le || max_slot_u64_le` —
 * binding the signature to one wallet lifetime, one counter, and one expiry.
 *
 * The counter is typed per operation (the program's replay domains), so a
 * caller can never feed the wrong one:
 *
 * | Field             | Counter                         | Operations |
 * |-------------------|---------------------------------|------------|
 * | `fundsNonce`      | funds `nonce` (N)               | Execute, ExecuteEphemeral, AdvanceNonce, OwnerCloseSession, CreateSession (+ `sessionNonce`) |
 * | `sessionNonce`    | `session_nonce` (S)             | BumpEpoch; CreateSession's trailing operand |
 * | `generation`      | target session's generation     | RevokeSession |
 * | `governanceNonce` | `governance_nonce` (G)          | RotateRoot, Propose/Cancel/ExecuteRecovery, AddAuthority approval and PoP, RemoveSelf/Other, SetThreshold, SetRecoveryThreshold, CloseWallet |
 *
 * CreateSession consumes only N; the new session's generation is N + 1
 * ({@link import('../wallet-state').nextSessionGeneration}). RevokeSession and
 * ProposeRecovery consume nothing.
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

/** What every authority-signed operation except CreateWallet binds besides its counter. */
export interface WalletMessageScope {
  walletPDA: PublicKey;
  creationSlot: bigint;
  maxSlot: bigint;
  deployment: MachineWalletDeployment;
}

/** Binds the funds nonce N (`MachineWallet.nonce`, {@link import('../wallet-state').MachineWalletState.nonce}). */
export interface FundsNonceBound extends WalletMessageScope {
  fundsNonce: bigint;
}

/** Binds the session nonce S (`MachineWallet.session_nonce`). */
export interface SessionNonceBound extends WalletMessageScope {
  sessionNonce: bigint;
}

/** Binds the governance nonce G (`MachineWallet.governance_nonce`). */
export interface GovernanceNonceBound extends WalletMessageScope {
  governanceNonce: bigint;
}

/** Binds the target session's generation (`SessionState.generation`) in the counter position. */
export interface SessionGenerationBound extends WalletMessageScope {
  generation: bigint;
}

/**
 * Hash `tag` over `wallet || creation_slot || counter || max_slot` followed by
 * `operands`. Exported for `operation-hash.ts`, whose Execute messages share
 * this exact preamble.
 */
export function hashWalletOp(
  tag: Uint8Array,
  scope: WalletMessageScope,
  counter: bigint,
  ...operands: Uint8Array[]
): Uint8Array {
  return hashSignedMessage({
    deployment: scope.deployment,
    tag,
    payloadParts: [
      scope.walletPDA.toBytes(),
      u64LE(scope.creationSlot),
      u64LE(counter),
      u64LE(scope.maxSlot),
      ...operands,
    ],
  });
}

/**
 * CreateWallet: `wallet(32) || max_slot || sig_scheme(1) || authority(33)`.
 *
 * The only signed operation with no creation_slot/counter — the wallet does not
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
  args: GovernanceNonceBound & { destination: Uint8Array },
): Uint8Array {
  return hashWalletOp(CLOSE_WALLET_TAG, args, args.governanceNonce, requireLength(args.destination, 32, 'destination'));
}

/** AdvanceNonce: the bare preamble. */
export function computeAdvanceNonceMessage(args: FundsNonceBound): Uint8Array {
  return hashWalletOp(ADVANCE_NONCE_TAG, args, args.fundsNonce);
}

/**
 * CreateSession: preamble (funds nonce N) `|| session_nonce(8) ||
 * session_data_hash(32)`. Binds N and S, consumes only N; the created
 * session's generation is the post-increment N.
 */
export function computeCreateSessionMessage(
  args: FundsNonceBound & { sessionNonce: bigint; sessionDataHash: Uint8Array },
): Uint8Array {
  return hashWalletOp(
    CREATE_SESSION_TAG,
    args,
    args.fundsNonce,
    u64LE(args.sessionNonce),
    requireLength(args.sessionDataHash, 32, 'sessionDataHash'),
  );
}

/**
 * RevokeSession (owner path): preamble with the target session's generation in
 * the counter position `|| session_authority(32)`. Consumes no counter and
 * leaves the wallet read-only, so revocations can be pre-signed and run in
 * parallel; the proof dies with the session incarnation it names.
 */
export function computeRevokeSessionMessage(
  args: SessionGenerationBound & { sessionAuthority: Uint8Array },
): Uint8Array {
  return hashWalletOp(
    REVOKE_SESSION_TAG,
    args,
    args.generation,
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
  args: FundsNonceBound & { sessionAuthority: Uint8Array },
): Uint8Array {
  return hashWalletOp(
    OWNER_CLOSE_SESSION_TAG,
    args,
    args.fundsNonce,
    requireLength(args.sessionAuthority, 32, 'sessionAuthority'),
  );
}

/**
 * AddAuthority — the existing owners' approval.
 * Preamble `|| new_sig_scheme(1) || new_pubkey(33) || new_threshold(1)`.
 */
export function computeAddAuthorityMessage(
  args: GovernanceNonceBound & {
    newSigScheme: number;
    newPubkey: Uint8Array;
    newThreshold: number;
  },
): Uint8Array {
  return hashWalletOp(
    ADD_AUTHORITY_TAG,
    args,
    args.governanceNonce,
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
 * own existence and consent to join at this governance nonce. What the threshold becomes
 * is the existing owners' decision, bound into the message they sign.
 */
export function computeAddAuthorityPopMessage(
  args: GovernanceNonceBound & { newSigScheme: number; newPubkey: Uint8Array },
): Uint8Array {
  return hashWalletOp(
    ADD_AUTHORITY_POP_TAG,
    args,
    args.governanceNonce,
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
  args: GovernanceNonceBound & AuthorityKeyOperand & { newThreshold: number },
): Uint8Array {
  return hashWalletOp(
    REMOVE_SELF_TAG,
    args,
    args.governanceNonce,
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
  args: GovernanceNonceBound & AuthorityKeyOperand & { newThreshold: number },
): Uint8Array {
  return hashWalletOp(
    REMOVE_OTHER_TAG,
    args,
    args.governanceNonce,
    ...keyOperand(args),
    requireByte(args.newThreshold, 'newThreshold'),
  );
}

/** SetThreshold: preamble `|| new_threshold(1)`. */
export function computeSetThresholdMessage(
  args: GovernanceNonceBound & { newThreshold: number },
): Uint8Array {
  return hashWalletOp(SET_THRESHOLD_TAG, args, args.governanceNonce, requireByte(args.newThreshold, 'newThreshold'));
}

/**
 * RotateRoot: preamble `|| sig_scheme(1) || pubkey(33)` naming the new root,
 * which must already be an authority. Signed by the current root.
 */
export function computeRotateRootMessage(
  args: GovernanceNonceBound & AuthorityKeyOperand,
): Uint8Array {
  return hashWalletOp(ROTATE_ROOT_TAG, args, args.governanceNonce, ...keyOperand(args));
}

/**
 * ProposeRecovery: preamble `|| sig_scheme(1) || pubkey(33)` naming an
 * existing authority as the next root. Approved by the recovery threshold;
 * starts the recovery delay. Consumes no counter and fails with 77
 * `RecoveryAlreadyPending` while a proposal is pending — show the pending
 * recovery, never retry.
 */
export function computeProposeRecoveryMessage(
  args: GovernanceNonceBound & AuthorityKeyOperand,
): Uint8Array {
  return hashWalletOp(PROPOSE_RECOVERY_TAG, args, args.governanceNonce, ...keyOperand(args));
}

/**
 * ExecuteRecovery: same payload as {@link computeProposeRecoveryMessage}
 * (the pending root), signed by the pending root itself once the delay has
 * elapsed. The distinct tag keeps a proposal signature from executing.
 */
export function computeExecuteRecoveryMessage(
  args: GovernanceNonceBound & AuthorityKeyOperand,
): Uint8Array {
  return hashWalletOp(EXECUTE_RECOVERY_TAG, args, args.governanceNonce, ...keyOperand(args));
}

/** CancelRecovery (root-signed veto): the bare preamble. */
export function computeCancelRecoveryMessage(args: GovernanceNonceBound): Uint8Array {
  return hashWalletOp(CANCEL_RECOVERY_TAG, args, args.governanceNonce);
}

/**
 * BumpEpoch: the bare preamble over the session nonce S (consumed). Any single
 * authority may sign it — it only
 * invalidates every session created under the current authority epoch.
 */
export function computeBumpEpochMessage(args: SessionNonceBound): Uint8Array {
  return hashWalletOp(BUMP_EPOCH_TAG, args, args.sessionNonce);
}

/**
 * SetRecoveryThreshold (root AND threshold): preamble `|| recovery_threshold(1)`.
 * `0` follows the spending threshold.
 */
export function computeSetRecoveryThresholdMessage(
  args: GovernanceNonceBound & { recoveryThreshold: number },
): Uint8Array {
  return hashWalletOp(
    SET_RECOVERY_THRESHOLD_TAG,
    args,
    args.governanceNonce,
    requireByte(args.recoveryThreshold, 'recoveryThreshold'),
  );
}
