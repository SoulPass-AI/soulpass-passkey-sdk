/**
 * Instruction `data` builders for every MachineWallet instruction not covered
 * by `execute-ix.ts` (Execute, ExecuteWithEphemeralSigners,
 * ProvideWebAuthnEvidence) or `session.ts` (CreateSession), plus the account
 * order of each handler.
 *
 * Mirrors the decoders in `machine-wallet/program/src/instruction.rs`
 * byte-for-byte; the decoder checks exact lengths, so a wrong width here is a
 * rejected transaction, not a misread. Root / recovery / epoch layouts are
 * pinned against `tests/fixtures/layout_kat.json`.
 *
 * Like `execute-ix.ts`, these return bytes only: `keys` and `programId` are
 * the caller's. The `*_ACCOUNTS` tables name the account order the handler
 * reads (`(w)` writable, `(s)` signer).
 */

import { concatBytes, requireByte, requireLength, u64LE } from './_bytes';
import { MachineWalletDisc } from './disc';
import { encodeInnerInstructions, type RemainingAccount } from './execute-ix';
import type { InnerInstruction } from './inner-hash';
import type { AuthorityKeyOperand } from './authority-messages';

const disc = (d: number): Uint8Array => Uint8Array.of(d);

/** `[disc] || max_slot(u64 LE)` — the 9-byte form. */
function maxSlotOnly(d: number, maxSlot: bigint): Uint8Array {
  return concatBytes([disc(d), u64LE(maxSlot)]);
}

/** `[disc] || max_slot || sig_scheme(1) || pubkey(33)` — 43 bytes. */
function maxSlotKey(d: number, maxSlot: bigint, sigScheme: number, pubkey: Uint8Array, label: string): Uint8Array {
  return concatBytes([
    disc(d),
    u64LE(maxSlot),
    requireByte(sigScheme, `${label} sigScheme`),
    requireLength(pubkey, 33, `${label} pubkey`),
  ]);
}

/** `[disc] || max_slot || session_authority(32)` — 41 bytes. */
function maxSlotSession(d: number, maxSlot: bigint, sessionAuthority: Uint8Array): Uint8Array {
  return concatBytes([disc(d), u64LE(maxSlot), requireLength(sessionAuthority, 32, 'sessionAuthority')]);
}

/** `[disc] || generation(u64 LE)` — 9 bytes. */
function discGeneration(d: number, generation: bigint): Uint8Array {
  return concatBytes([disc(d), u64LE(generation)]);
}

/** `[disc] || sig_scheme(1) || pubkey(33) || new_threshold(1) || max_slot` — 44 bytes. */
function keyThresholdMaxSlot(
  d: number,
  sigScheme: number,
  pubkey: Uint8Array,
  newThreshold: number,
  maxSlot: bigint,
): Uint8Array {
  return concatBytes([
    disc(d),
    requireByte(sigScheme, 'sigScheme'),
    requireLength(pubkey, 33, 'pubkey'),
    requireByte(newThreshold, 'newThreshold'),
    u64LE(maxSlot),
  ]);
}

// ── Account tables ────────────────────────────────────────────────────────

/**
 * The shared prefix of every authority-governed instruction
 * (`processor/mod.rs::load_governed`) except RevokeSession, whose wallet is
 * read-only ({@link REVOKE_SESSION_ACCOUNTS}). AdvanceNonce (3), SetThreshold (11),
 * RotateRoot (17), ProposeRecovery (20), CancelRecovery (21),
 * ExecuteRecovery (22), BumpEpoch (23) and SetRecoveryThreshold (24) use
 * exactly these three; AddAuthority (9) and RemoveAuthority (10) append the
 * System Program ({@link ADD_AUTHORITY_ACCOUNTS}, {@link REMOVE_AUTHORITY_ACCOUNTS}).
 */
export const GOVERNED_ACCOUNTS = ['instructions_sysvar', 'wallet (w)', 'fee_payer (s)'] as const;
/** AddAuthority (9), `add_authority.rs`: the System Program at index 3 (the wallet account grows). */
export const ADD_AUTHORITY_ACCOUNTS = [...GOVERNED_ACCOUNTS, 'system_program'] as const;
/** RemoveAuthority (10), `remove_authority.rs`: the System Program at index 3 (the wallet account shrinks). */
export const REMOVE_AUTHORITY_ACCOUNTS = [...GOVERNED_ACCOUNTS, 'system_program'] as const;
/**
 * RevokeSession (6), `revoke_session.rs`. The wallet is **read-only**: revoke
 * consumes no wallet counter, so it takes no write lock on the wallet and
 * revocations never race grants, spends or governance.
 */
export const REVOKE_SESSION_ACCOUNTS = ['instructions_sysvar', 'wallet', 'fee_payer (s)', 'session (w)'] as const;
/**
 * OwnerCloseSession (12), `owner_close_session.rs`. The rent goes to
 * `destination`, which must be the session's recorded rent payer.
 */
export const OWNER_CLOSE_SESSION_ACCOUNTS = [...GOVERNED_ACCOUNTS, 'session (w)', 'destination (w) = rent_payer'] as const;
/** CloseSession (8), `close_session.rs`; signed by the session key, rent to the recorded rent payer. */
export const CLOSE_SESSION_ACCOUNTS = ['session (w)', 'authority (s)', 'destination (w) = rent_payer'] as const;
/** SelfRevokeSession (7), `self_revoke_session.rs`; signed by the session key. */
export const SELF_REVOKE_SESSION_ACCOUNTS = ['session (w)', 'authority (s)'] as const;
/** CloseWallet (2), `close_wallet.rs`. */
export const CLOSE_WALLET_ACCOUNTS = [...GOVERNED_ACCOUNTS, 'vault (w)', 'destination (w)', 'system_program'] as const;
/** CreateWallet (0), `create_wallet.rs`. */
export const CREATE_WALLET_ACCOUNTS = ['instructions_sysvar', 'payer (s)', 'wallet (w)', 'system_program'] as const;
/**
 * Execute (1) and ExecuteWithEphemeralSigners (16), `execute.rs`: the
 * de-duplicated remaining accounts (`encodeRemainingAccounts`) follow, in the
 * order their `index` bytes name them.
 */
export const EXECUTE_ACCOUNTS = [...GOVERNED_ACCOUNTS, 'vault (w)', '…remaining'] as const;
/**
 * SessionExecute (5), `session_execute.rs`: `authority` is the session key;
 * the wallet is read-only; the de-duplicated remaining accounts
 * (`encodeRemainingAccounts`) follow.
 */
export const SESSION_EXECUTE_ACCOUNTS = ['session (w)', 'wallet', 'authority (s)', 'vault (w)', '…remaining'] as const;

// ── Builders ──────────────────────────────────────────────────────────────

/** CreateWallet (0): `[0] || max_slot || sig_scheme(1) || authority(33)` — 43 B. */
export function buildCreateWalletIxData(args: {
  maxSlot: bigint;
  sigScheme: number;
  /** 33 bytes (an Ed25519 key is 32 bytes + one 0x00 pad). */
  authority: Uint8Array;
}): Uint8Array {
  return maxSlotKey(MachineWalletDisc.CreateWallet, args.maxSlot, args.sigScheme, args.authority, 'authority');
}

/** CloseWallet (2): `[2] || max_slot || destination(32)` — 41 B. */
export function buildCloseWalletIxData(args: { maxSlot: bigint; destination: Uint8Array }): Uint8Array {
  return concatBytes([
    disc(MachineWalletDisc.CloseWallet),
    u64LE(args.maxSlot),
    requireLength(args.destination, 32, 'destination'),
  ]);
}

/** AdvanceNonce (3): `[3] || max_slot` — 9 B. Accounts: {@link GOVERNED_ACCOUNTS}. */
export function buildAdvanceNonceIxData(args: { maxSlot: bigint }): Uint8Array {
  return maxSlotOnly(MachineWalletDisc.AdvanceNonce, args.maxSlot);
}

/**
 * SessionExecute (5): `[5] || generation(u64 LE) || inner_count(u32 LE) ||
 * inner ixs` — the same inner encoding as Execute, with no max_slot (the
 * session key signs the transaction itself). `generation` is the session's
 * `SessionState.generation`; a mismatch fails with 76
 * `SessionGenerationMismatch` (the grant changed — never refresh it and re-sign
 * the old intent). Pass the same `remainingAccounts` as the ix keys tail.
 */
export function buildSessionExecuteIxData(args: {
  generation: bigint;
  innerInstructions: ReadonlyArray<InnerInstruction>;
  remainingAccounts: ReadonlyArray<RemainingAccount>;
}): Uint8Array {
  return concatBytes([
    disc(MachineWalletDisc.SessionExecute),
    u64LE(args.generation),
    encodeInnerInstructions(args.innerInstructions, args.remainingAccounts),
  ]);
}

/** RevokeSession (6): `[6] || max_slot || session_authority(32)` — 41 B. */
export function buildRevokeSessionIxData(args: { maxSlot: bigint; sessionAuthority: Uint8Array }): Uint8Array {
  return maxSlotSession(MachineWalletDisc.RevokeSession, args.maxSlot, args.sessionAuthority);
}

/** SelfRevokeSession (7): `[7] || generation(u64 LE)` — 9 B. */
export function buildSelfRevokeSessionIxData(generation: bigint): Uint8Array {
  return discGeneration(MachineWalletDisc.SelfRevokeSession, generation);
}

/** CloseSession (8): `[8] || generation(u64 LE)` — 9 B. */
export function buildCloseSessionIxData(generation: bigint): Uint8Array {
  return discGeneration(MachineWalletDisc.CloseSession, generation);
}

/**
 * AddAuthority (9): `[9] || new_sig_scheme || new_pubkey(33) || new_threshold || max_slot` — 44 B.
 * Accounts: {@link ADD_AUTHORITY_ACCOUNTS}.
 *
 * `newThreshold` defaults to 0. The program accepts only 0 or the current
 * threshold (`validate_new_threshold`), both meaning "unchanged". The handler
 * hashes the byte it decoded, so this value MUST equal the `newThreshold` the
 * owners signed in `computeAddAuthorityMessage`. The web wallet and the Swift
 * SDK both sign and build `new_threshold` 0 through one constant; a ceremony
 * that signed any other value needs that same value here.
 */
export function buildAddAuthorityIxData(args: {
  newSigScheme: number;
  newPubkey: Uint8Array;
  maxSlot: bigint;
  newThreshold?: number;
}): Uint8Array {
  return keyThresholdMaxSlot(
    MachineWalletDisc.AddAuthority,
    args.newSigScheme,
    args.newPubkey,
    args.newThreshold ?? 0,
    args.maxSlot,
  );
}

/**
 * RemoveAuthority (10): `[10] || sig_scheme || pubkey(33) || new_threshold || max_slot` — 44 B.
 * Accounts: {@link REMOVE_AUTHORITY_ACCOUNTS}.
 */
export function buildRemoveAuthorityIxData(
  args: AuthorityKeyOperand & { newThreshold: number; maxSlot: bigint },
): Uint8Array {
  return keyThresholdMaxSlot(
    MachineWalletDisc.RemoveAuthority,
    args.sigScheme,
    args.pubkey,
    args.newThreshold,
    args.maxSlot,
  );
}

/** SetThreshold (11): `[11] || new_threshold || max_slot` — 10 B. */
export function buildSetThresholdIxData(args: { newThreshold: number; maxSlot: bigint }): Uint8Array {
  return concatBytes([
    disc(MachineWalletDisc.SetThreshold),
    requireByte(args.newThreshold, 'newThreshold'),
    u64LE(args.maxSlot),
  ]);
}

/** OwnerCloseSession (12): `[12] || max_slot || session_authority(32)` — 41 B. */
export function buildOwnerCloseSessionIxData(args: { maxSlot: bigint; sessionAuthority: Uint8Array }): Uint8Array {
  return maxSlotSession(MachineWalletDisc.OwnerCloseSession, args.maxSlot, args.sessionAuthority);
}

/**
 * RotateRoot (17): `[17] || max_slot || sig_scheme || pubkey(33)` — 43 B (the new root).
 * The new root must already be a registered authority; signed by the current root.
 */
export function buildRotateRootIxData(args: AuthorityKeyOperand & { maxSlot: bigint }): Uint8Array {
  return maxSlotKey(MachineWalletDisc.RotateRoot, args.maxSlot, args.sigScheme, args.pubkey, 'new root');
}

/** ProposeRecovery (20): `[20] || max_slot || sig_scheme || pubkey(33)` — 43 B (the proposed root). */
export function buildProposeRecoveryIxData(args: AuthorityKeyOperand & { maxSlot: bigint }): Uint8Array {
  return maxSlotKey(MachineWalletDisc.ProposeRecovery, args.maxSlot, args.sigScheme, args.pubkey, 'proposed root');
}

/** CancelRecovery (21): `[21] || max_slot` — 9 B. */
export function buildCancelRecoveryIxData(args: { maxSlot: bigint }): Uint8Array {
  return maxSlotOnly(MachineWalletDisc.CancelRecovery, args.maxSlot);
}

/** ExecuteRecovery (22): `[22] || max_slot` — 9 B. */
export function buildExecuteRecoveryIxData(args: { maxSlot: bigint }): Uint8Array {
  return maxSlotOnly(MachineWalletDisc.ExecuteRecovery, args.maxSlot);
}

/** BumpEpoch (23): `[23] || max_slot` — 9 B. */
export function buildBumpEpochIxData(args: { maxSlot: bigint }): Uint8Array {
  return maxSlotOnly(MachineWalletDisc.BumpEpoch, args.maxSlot);
}

/** SetRecoveryThreshold (24): `[24] || recovery_threshold || max_slot` — 10 B (threshold first). */
export function buildSetRecoveryThresholdIxData(args: { recoveryThreshold: number; maxSlot: bigint }): Uint8Array {
  return concatBytes([
    disc(MachineWalletDisc.SetRecoveryThreshold),
    requireByte(args.recoveryThreshold, 'recoveryThreshold'),
    u64LE(args.maxSlot),
  ]);
}
