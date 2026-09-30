/**
 * Off-chain reader for the SessionState account (`'S'` tag) and the
 * liveness predicate `SessionExecute` enforces.
 *
 * Mirrors `machine-wallet/program/src/state.rs::SessionState` (the validating
 * `deserialize` path) and the session checks in
 * `processor/session_execute.rs`. Pinned by `tests/fixtures/layout_kat.json`
 * (`session_p2_sol_cash1_sleeve1_passkey_creator`).
 *
 * Layout (`sessionAccountSize(P, C)` bytes, integers LE):
 *
 * | offset            | field                  | type                |
 * |-------------------|------------------------|---------------------|
 * | 0                 | tag                    | u8 (= 'S')          |
 * | 1                 | bump                   | u8                  |
 * | 2                 | wallet                 | [u8; 32]            |
 * | 34                | authority              | [u8; 32]            |
 * | 66                | created_slot           | u64                 |
 * | 74                | expiry_slot            | u64                 |
 * | 82                | revoked                | u8 (non-zero = yes) |
 * | 83                | wallet_creation_slot   | u64                 |
 * | 91                | authority_epoch        | u64                 |
 * | 99                | flags                  | u8                  |
 * | 100               | allowed_programs_count | u8 (P, 1..=8)       |
 * | 101               | allowed_programs       | [[u8; 32]; P]       |
 * | B = 101 + 32P     | mandate_hash           | [u8; 32]            |
 * | B + 32            | creator                | AuthoritySlot       |
 * | B + 66            | rent_payer             | [u8; 32]            |
 * | B + 98            | cash_count             | u8 (C, 0..=5)       |
 * | B + 99            | cash                   | [CashMintState; C]  |
 * | B + 99 + 88C      | sleeve_count           | u8 (0..=16)         |
 * | B + 100 + 88C     | sleeve                 | [SleeveEntry; 16]   |
 *
 * The sleeve is pre-allocated at full capacity; slots past `sleeve_count` are
 * ignored, as on chain.
 */

import {
  AUTHORITY_SLOT_SIZE,
  CASH_MINT_STATE_SIZE,
  MAX_ALLOWED_PROGRAMS,
  MAX_CASH_MINTS,
  MAX_SLEEVE_MINTS,
  isNativeSolMint,
  SESSION_ACCOUNT_TAG,
  SESSION_FLAGS_KNOWN,
  SESSION_HEADER_SIZE,
  SLEEVE_ENTRY_SIZE,
} from './constants';
import { bytesEqual } from './_bytes';
import type { CashMintPolicy } from './session';
import { isKnownSigScheme, type MachineWalletState, type WalletAuthoritySlot } from '../wallet-state';

/** A session's per-mint budget: the signed policy plus the program's running counters. */
export interface CashMintState extends CashMintPolicy {
  periodStartSlot: bigint;
  spentInPeriod: bigint;
  lifetimeSpent: bigint;
}

/** A purchased non-cash balance the session tracks (`SleeveEntry`). */
export interface SleeveEntry {
  /** 32-byte mint. */
  mint: Uint8Array;
  amount: bigint;
}

/** Decoded SessionState account. Returned by {@link parseSessionState}. */
export interface SessionState {
  bump: number;
  /** 32-byte wallet PDA the session spends for. */
  wallet: Uint8Array;
  /** 32-byte Ed25519 session key that signs `SessionExecute`. */
  authority: Uint8Array;
  createdSlot: bigint;
  /** Last slot at which the program still accepts the session. */
  expirySlot: bigint;
  revoked: boolean;
  /** The wallet's `creation_slot` when the session was created. */
  walletCreationSlot: bigint;
  /** The wallet's `authority_epoch` when the session was created. */
  authorityEpoch: bigint;
  /** `SESSION_FLAG_*` bits. */
  flags: number;
  /** 1..=8 program ids, 32 bytes each. */
  allowedPrograms: Uint8Array[];
  mandateHash: Uint8Array;
  /** The wallet authority that created the session. */
  creator: WalletAuthoritySlot;
  /** 32-byte CreateSession fee payer; the only rent refund target. */
  rentPayer: Uint8Array;
  /** 1..=5 budgets; exactly one under {@link NATIVE_SOL_MINT}. */
  cash: CashMintState[];
  /** Live sleeve entries (`sleeve_count` of them). */
  sleeve: SleeveEntry[];
}

const OFFSET = {
  TAG: 0,
  BUMP: 1,
  WALLET: 2,
  AUTHORITY: 34,
  CREATED_SLOT: 66,
  EXPIRY_SLOT: 74,
  REVOKED: 82,
  WALLET_CREATION_SLOT: 83,
  AUTHORITY_EPOCH: 91,
  FLAGS: 99,
  ALLOWED_PROGRAMS_COUNT: 100,
} as const;

/** Offsets inside the budget segment, relative to `101 + 32P`. */
const BUDGET = {
  MANDATE: 0,
  CREATOR: 32,
  RENT_PAYER: 32 + AUTHORITY_SLOT_SIZE,
  CASH_COUNT: 32 + AUTHORITY_SLOT_SIZE + 32,
  CASH: 32 + AUTHORITY_SLOT_SIZE + 32 + 1,
} as const;

const budgetOffset = (programCount: number): number => SESSION_HEADER_SIZE + programCount * 32;

/**
 * Exact account length for `programCount` allowed programs and `cashCount`
 * cash entries (`SessionState::size`): `841 + 32P + 88C`.
 */
export function sessionAccountSize(programCount: number, cashCount: number): number {
  if (!Number.isInteger(programCount) || programCount < 0 || programCount > MAX_ALLOWED_PROGRAMS) {
    throw new RangeError(`sessionAccountSize: programCount must be 0..=${MAX_ALLOWED_PROGRAMS}, got ${programCount}`);
  }
  if (!Number.isInteger(cashCount) || cashCount < 0 || cashCount > MAX_CASH_MINTS) {
    throw new RangeError(`sessionAccountSize: cashCount must be 0..=${MAX_CASH_MINTS}, got ${cashCount}`);
  }
  return (
    budgetOffset(programCount) +
    BUDGET.CASH +
    cashCount * CASH_MINT_STATE_SIZE +
    1 +
    MAX_SLEEVE_MINTS * SLEEVE_ENTRY_SIZE
  );
}

const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

/**
 * Parse a raw account body into a typed {@link SessionState}, rejecting
 * everything `SessionState::deserialize` rejects:
 *
 * - byte 0 is not `'S'` (`Unsupported SessionState account tag <n>`);
 * - unknown `flags` bits;
 * - `allowed_programs_count` outside 1..=8, `cash_count` above 5, or a length
 *   other than exactly {@link sessionAccountSize}`(P, C)`;
 * - an all-zero wallet or authority, or `created_slot > expiry_slot`;
 * - a repeated allowed program, cash mint or sleeve mint;
 * - an unknown creator `sig_scheme`;
 * - a cash entry with a zero `period_cap` / `period_slots` / `lifetime_cap`,
 *   or a spent counter above its cap;
 * - no SOL budget (no entry under {@link NATIVE_SOL_MINT});
 * - `sleeve_count` above 16.
 *
 * Every byte array in the result is a copy, never a view onto `data`.
 */
export function parseSessionState(data: Uint8Array): SessionState {
  if (data.length < SESSION_HEADER_SIZE) {
    throw new Error(`SessionState account too small: ${data.length} < ${SESSION_HEADER_SIZE}`);
  }
  const tag = data[OFFSET.TAG];
  if (tag !== SESSION_ACCOUNT_TAG) {
    throw new Error(`Unsupported SessionState account tag ${tag}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (off: number): bigint => view.getBigUint64(off, true);

  const flags = data[OFFSET.FLAGS];
  if ((flags & ~SESSION_FLAGS_KNOWN) !== 0) {
    throw new Error(`SessionState has unknown flags bits: 0x${flags.toString(16)}`);
  }
  const programCount = data[OFFSET.ALLOWED_PROGRAMS_COUNT];
  if (programCount === 0 || programCount > MAX_ALLOWED_PROGRAMS) {
    throw new Error(`Invalid allowed_programs_count: ${programCount} (expected 1..=${MAX_ALLOWED_PROGRAMS})`);
  }

  const base = budgetOffset(programCount);
  const cashCountOff = base + BUDGET.CASH_COUNT;
  if (data.length <= cashCountOff) {
    throw new Error(`SessionState account too small: ${data.length} cannot hold ${programCount} programs`);
  }
  const cashCount = data[cashCountOff];
  if (cashCount > MAX_CASH_MINTS) {
    throw new Error(`Invalid cash_count: ${cashCount} (expected 0..=${MAX_CASH_MINTS})`);
  }
  const expected = sessionAccountSize(programCount, cashCount);
  if (data.length !== expected) {
    const what = data.length < expected ? 'too small' : 'has trailing bytes';
    throw new Error(
      `SessionState account ${what}: ${data.length} != ${expected} for ${programCount} programs, ${cashCount} cash entries`,
    );
  }

  const wallet = data.slice(OFFSET.WALLET, OFFSET.WALLET + 32);
  const authority = data.slice(OFFSET.AUTHORITY, OFFSET.AUTHORITY + 32);
  const createdSlot = u64(OFFSET.CREATED_SLOT);
  const expirySlot = u64(OFFSET.EXPIRY_SLOT);
  if (isZero(wallet)) throw new Error('SessionState wallet is all zero');
  if (isZero(authority)) throw new Error('SessionState authority is all zero');
  if (createdSlot > expirySlot) {
    throw new Error(`SessionState created_slot ${createdSlot} > expiry_slot ${expirySlot}`);
  }

  const allowedPrograms: Uint8Array[] = [];
  for (let i = 0; i < programCount; i++) {
    const start = SESSION_HEADER_SIZE + i * 32;
    const program = data.slice(start, start + 32);
    if (allowedPrograms.some((prev) => bytesEqual(prev, program))) {
      throw new Error(`SessionState allowed program ${i} repeats an earlier entry`);
    }
    allowedPrograms.push(program);
  }

  const creatorOff = base + BUDGET.CREATOR;
  const creatorScheme = data[creatorOff];
  if (!isKnownSigScheme(creatorScheme)) {
    throw new Error(`Unknown creator sig_scheme byte: ${creatorScheme}`);
  }
  const creator: WalletAuthoritySlot = {
    sigScheme: creatorScheme,
    pubkey: data.slice(creatorOff + 1, creatorOff + AUTHORITY_SLOT_SIZE),
  };

  const cash: CashMintState[] = [];
  for (let i = 0; i < cashCount; i++) {
    const o = base + BUDGET.CASH + i * CASH_MINT_STATE_SIZE;
    const e: CashMintState = {
      mint: data.slice(o, o + 32),
      perTxCap: u64(o + 32),
      periodCap: u64(o + 40),
      periodSlots: u64(o + 48),
      periodStartSlot: u64(o + 56),
      spentInPeriod: u64(o + 64),
      lifetimeCap: u64(o + 72),
      lifetimeSpent: u64(o + 80),
    };
    if (
      e.periodCap === 0n ||
      e.lifetimeCap === 0n ||
      e.periodSlots === 0n ||
      e.spentInPeriod > e.periodCap ||
      e.lifetimeSpent > e.lifetimeCap
    ) {
      throw new Error(`SessionState cash[${i}] breaks a policy invariant`);
    }
    if (cash.some((prev) => bytesEqual(prev.mint, e.mint))) {
      throw new Error(`SessionState cash[${i}] repeats an earlier mint`);
    }
    cash.push(e);
  }
  if (!cash.some((c) => isNativeSolMint(c.mint))) {
    throw new Error('SessionState has no SOL budget (NATIVE_SOL_MINT entry)');
  }

  const sleeveCountOff = base + BUDGET.CASH + cashCount * CASH_MINT_STATE_SIZE;
  const sleeveCount = data[sleeveCountOff];
  if (sleeveCount > MAX_SLEEVE_MINTS) {
    throw new Error(`Invalid sleeve_count: ${sleeveCount} (expected 0..=${MAX_SLEEVE_MINTS})`);
  }
  const sleeve: SleeveEntry[] = [];
  for (let i = 0; i < sleeveCount; i++) {
    const o = sleeveCountOff + 1 + i * SLEEVE_ENTRY_SIZE;
    const mint = data.slice(o, o + 32);
    if (sleeve.some((prev) => bytesEqual(prev.mint, mint))) {
      throw new Error(`SessionState sleeve[${i}] repeats an earlier mint`);
    }
    sleeve.push({ mint, amount: u64(o + 32) });
  }

  const rentPayerOff = base + BUDGET.RENT_PAYER;
  return {
    bump: data[OFFSET.BUMP],
    wallet,
    authority,
    createdSlot,
    expirySlot,
    revoked: data[OFFSET.REVOKED] !== 0,
    walletCreationSlot: u64(OFFSET.WALLET_CREATION_SLOT),
    authorityEpoch: u64(OFFSET.AUTHORITY_EPOCH),
    flags,
    allowedPrograms,
    mandateHash: data.slice(base + BUDGET.MANDATE, base + BUDGET.MANDATE + 32),
    creator,
    rentPayer: data.slice(rentPayerOff, rentPayerOff + 32),
    cash,
    sleeve,
  };
}

/**
 * Whether `SessionExecute` would accept this session against `wallet` at
 * `currentSlot`: not revoked, not expired, the wallet not closed and
 * recreated since (`creation_slot`), and the wallet's authority set unchanged
 * since (`authority_epoch` — an authority removed, the root moved, the
 * threshold changed, or BumpEpoch).
 *
 * `expirySlot` is the last slot at which the program still accepts the
 * session (`session_execute.rs` fails only on `clock.slot > expiry_slot`), so
 * the expiry test is `currentSlot <= expirySlot`. The caller must pass the
 * wallet the session names (`session.wallet`); this predicate does not check
 * that pairing.
 */
export function isSessionLive(s: SessionState, wallet: MachineWalletState, currentSlot: bigint): boolean {
  return (
    !s.revoked &&
    currentSlot <= s.expirySlot &&
    s.walletCreationSlot === wallet.creationSlot &&
    s.authorityEpoch === wallet.authorityEpoch
  );
}

/** The session's SOL budget: the cash entry under {@link NATIVE_SOL_MINT}. */
export function sessionSolPolicy(s: SessionState): CashMintState | undefined {
  return s.cash.find((c) => isNativeSolMint(c.mint));
}
