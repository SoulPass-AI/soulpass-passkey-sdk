/**
 * Budgeted sessions (CreateSession, disc 4): the session-data hash the
 * authorities sign over, the instruction data blob, and a client-side mirror
 * of the program's parameter checks.
 *
 * Mirrors `hash_session_data` and the handler checks in
 * `machine-wallet/program/src/processor/create_session.rs`, and the disc-4
 * decoder in `program/src/instruction.rs`. Pinned byte-for-byte by
 * `tests/fixtures/session_data_kat.json` and `tests/fixtures/layout_kat.json`
 * (`ix_create_session_disc4`), both verbatim copies of the program's vectors.
 *
 * Runtime-dependency-free (no @solana/web3.js): every key is a raw byte array.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, requireByte, requireLength, u64LE } from './_bytes';
import { MAX_ALLOWED_PROGRAMS, MAX_CASH_MINTS, NATIVE_SOL_MINT, SESSION_FLAGS_KNOWN } from './constants';
import { MachineWalletDisc } from './disc';
import type { MachineWalletErrorName } from './errors';

export { computeCreateSessionMessage } from './authority-messages';

/** On-chain `CashMintPolicy::WIRE_LEN`. */
export const CASH_MINT_POLICY_WIRE_LEN = 64;

/**
 * Per-mint cash budget of a session — the program's `CashMintPolicy`. The SOL
 * budget uses {@link NATIVE_SOL_MINT} (all zero) as its mint.
 */
export interface CashMintPolicy {
  /** 32-byte mint address. */
  mint: Uint8Array;
  perTxCap: bigint;
  periodCap: bigint;
  periodSlots: bigint;
  lifetimeCap: bigint;
}

/**
 * The 64-byte wire form (`CashMintPolicy::to_wire`):
 * `mint(32) || per_tx_cap || period_cap || period_slots || lifetime_cap` (u64 LE each).
 * The same bytes go on the wire and into {@link hashSessionData}.
 */
export function encodeCashMintPolicy(p: CashMintPolicy): Uint8Array {
  return concatBytes([
    requireLength(p.mint, 32, 'cash mint'),
    u64LE(p.perTxCap),
    u64LE(p.periodCap),
    u64LE(p.periodSlots),
    u64LE(p.lifetimeCap),
  ]);
}

/** Every operand a session commits to (hashed and on the wire alike). */
export interface SessionParams {
  /** 32-byte session key (the Ed25519 key that will sign SessionExecute). */
  sessionAuthority: Uint8Array;
  expirySlot: bigint;
  /** 1..=8 distinct program ids, 32 bytes each. */
  allowedPrograms: ReadonlyArray<Uint8Array>;
  /** 32-byte hash of the off-chain mandate the owner approved. */
  mandateHash: Uint8Array;
  /**
   * The authority slot creating the session; it must be a current wallet
   * authority and must itself sign. `sigScheme`: 0 secp256r1, 1 ed25519,
   * 2 webauthn. `pubkey`: 33 bytes (an Ed25519 key is 32 bytes + one 0x00 pad).
   */
  creator: { sigScheme: number; pubkey: Uint8Array };
  /** Session flag bits; only `SESSION_FLAGS_KNOWN` bits are accepted. */
  flags: number;
  /** 1..=5 cash budgets with distinct mints, one of them for SOL. */
  cash: ReadonlyArray<CashMintPolicy>;
}

function chainError(name: MachineWalletErrorName, detail: string, tag?: string): Error {
  return new Error(`${name}${tag === undefined ? '' : `(${tag})`}: ${detail}`);
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Reject parameters the program would reject, before anyone signs them.
 * Thrown `Error` messages start with the on-chain error name (`TooManyAllowedPrograms`,
 * `TooManyCashMints`, `DuplicateCashMint`, `InvalidCashCap`, `SessionSolBudgetMissing`,
 * `InvalidSessionData(<field>)`); wrong-width fields throw `RangeError`.
 *
 * Not checked here (they need chain state): expiry vs the current slot and
 * `MAX_SESSION_LIFETIME_SLOTS`, and whether the creator is a wallet authority.
 */
export function validateSessionParams(p: SessionParams): void {
  requireLength(p.sessionAuthority, 32, 'sessionAuthority');
  requireLength(p.mandateHash, 32, 'mandateHash');
  requireByte(p.creator.sigScheme, 'creator.sigScheme');
  requireLength(p.creator.pubkey, 33, 'creator.pubkey');
  requireByte(p.flags, 'flags');
  p.allowedPrograms.forEach((program, i) => requireLength(program, 32, `allowedPrograms[${i}]`));
  p.cash.forEach((c, i) => requireLength(c.mint, 32, `cash[${i}].mint`));

  if (p.sessionAuthority.every((b) => b === 0)) {
    throw chainError('InvalidSessionData', 'sessionAuthority must not be all zero', 'sessionAuthority');
  }
  // The decoder rejects a count of 0 or > MAX under this name.
  const n = p.allowedPrograms.length;
  if (n === 0 || n > MAX_ALLOWED_PROGRAMS) {
    throw chainError('TooManyAllowedPrograms', `allowedPrograms must hold 1..=${MAX_ALLOWED_PROGRAMS} entries, got ${n}`);
  }
  if ((p.flags & ~SESSION_FLAGS_KNOWN) !== 0) {
    throw chainError('InvalidSessionData', `unknown flag bits 0x${p.flags.toString(16)}`, 'flags');
  }
  p.allowedPrograms.forEach((program, i) => {
    if (p.allowedPrograms.slice(0, i).some((prev) => bytesEqual(prev, program))) {
      throw chainError('InvalidSessionData', `allowedPrograms[${i}] repeats an earlier entry`, 'allowedPrograms');
    }
  });

  if (p.cash.length > MAX_CASH_MINTS) {
    throw chainError('TooManyCashMints', `cash must hold at most ${MAX_CASH_MINTS} entries, got ${p.cash.length}`);
  }
  p.cash.forEach((c, i) => {
    // A zero cap is a dead budget; a zero period is a rollover hazard.
    if (c.periodCap === 0n || c.lifetimeCap === 0n || c.periodSlots === 0n) {
      throw chainError('InvalidCashCap', `cash[${i}]: periodCap, lifetimeCap and periodSlots must be non-zero`);
    }
    if (p.cash.slice(0, i).some((prev) => bytesEqual(prev.mint, c.mint))) {
      throw chainError('DuplicateCashMint', `cash[${i}] repeats an earlier mint`);
    }
  });
  if (!p.cash.some((c) => bytesEqual(c.mint, NATIVE_SOL_MINT))) {
    throw chainError('SessionSolBudgetMissing', 'cash must include a NATIVE_SOL_MINT (all-zero) entry');
  }
}

/**
 * The fields shared by the hash and the instruction, in program order:
 * `session_authority(32) || expiry_slot_le(8) || programs_count(1) || programs(32 each) ||
 *  mandate_hash(32) || creator_sig_scheme(1) || creator_pubkey(33) || flags(1) ||
 *  cash_count(1) || cash(64 each)`.
 */
function sessionFields(p: SessionParams): Uint8Array[] {
  validateSessionParams(p);
  return [
    p.sessionAuthority,
    u64LE(p.expirySlot),
    Uint8Array.of(p.allowedPrograms.length),
    ...p.allowedPrograms,
    p.mandateHash,
    Uint8Array.of(p.creator.sigScheme),
    p.creator.pubkey,
    Uint8Array.of(p.flags),
    Uint8Array.of(p.cash.length),
    ...p.cash.map(encodeCashMintPolicy),
  ];
}

/**
 * `session_data_hash` — the 32-byte value `computeCreateSessionMessage` binds:
 * keccak256 over {@link sessionFields}. Validates first
 * ({@link validateSessionParams}), so nobody signs a session the program refuses.
 *
 * SECURITY: every operand the owner sees at signing time is in this hash; a
 * missing field would let a relayer swap it between signature and chain.
 */
export function hashSessionData(p: SessionParams): Uint8Array {
  return keccak_256(concatBytes(sessionFields(p)));
}

/**
 * CreateSession instruction data (disc 4):
 * `[4] || max_slot(u64 LE) || <sessionFields>` — length 118 + 32N + 64M.
 * Accounts: {@link CREATE_SESSION_ACCOUNTS}.
 */
export function buildCreateSessionIxData(maxSlot: bigint, p: SessionParams): Uint8Array {
  return concatBytes([Uint8Array.of(MachineWalletDisc.CreateSession), u64LE(maxSlot), ...sessionFields(p)]);
}

/**
 * CreateSession account order (`create_session.rs`). `fee_payer` signs and
 * funds the session PDA's rent, and is recorded as its rent payer.
 */
export const CREATE_SESSION_ACCOUNTS = [
  'instructions_sysvar',
  'wallet (w)',
  'fee_payer (s) = rent_payer',
  'session (w)',
  'system_program',
] as const;
