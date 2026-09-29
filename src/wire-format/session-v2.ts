/**
 * MachineWallet v2 sessions (CreateSessionV2, disc 18): the session-data hash
 * the authorities sign over, and the instruction data blob.
 *
 * Mirrors `hash_session_data_v2` in `machine-wallet/program/src/processor/create_session.rs`
 * and the disc-18 decoder in `program/src/instruction.rs`. Pinned byte-for-byte by
 * `tests/fixtures/session_data_v2_kat.json` and `tests/fixtures/v2_layout_kat.json`
 * (`ix_create_session_v2_disc18`), both verbatim copies of the program's vectors.
 *
 * Runtime-dependency-free (no @solana/web3.js): every key is a raw 32-byte array.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { MachineWalletDisc } from './disc';
import { concatBytes, requireByte, requireLength, u64LE } from './_bytes';

/** On-chain `MAX_ALLOWED_PROGRAMS` (state.rs). */
export const MAX_SESSION_ALLOWED_PROGRAMS = 8;
/** On-chain `MAX_CASH_MINTS` (instruction.rs). */
export const MAX_SESSION_CASH_MINTS = 4;
/** On-chain `CashMintPolicy::WIRE_LEN`. */
export const CASH_MINT_POLICY_WIRE_LEN = 64;

/**
 * Per-mint cash budget of a v2 session — the program's `CashMintPolicy`.
 * Semantic checks (duplicate mints, zero caps) are the program handler's; this
 * type only fixes the layout.
 */
export interface SessionCashPolicy {
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
 * The same bytes go on the wire and into {@link hashSessionDataV2}.
 */
export function encodeCashMintPolicy(policy: SessionCashPolicy): Uint8Array {
  return concatBytes([
    requireLength(policy.mint, 32, 'cash mint'),
    u64LE(policy.perTxCap),
    u64LE(policy.periodCap),
    u64LE(policy.periodSlots),
    u64LE(policy.lifetimeCap),
  ]);
}

/** Every operand a v2 session commits to (hashed and on the wire alike). */
export interface SessionV2Params {
  /** 32-byte session key (the key that will sign SessionExecute). */
  sessionAuthority: Uint8Array;
  expirySlot: bigint;
  maxLamportsPerCall: bigint;
  maxTotalSpentLamports: bigint;
  /** 1..=8 program ids, 32 bytes each. */
  allowedPrograms: ReadonlyArray<Uint8Array>;
  /** 32-byte mandate hash. */
  mandateHash: Uint8Array;
  /** Creator AuthoritySlot scheme byte: 0 secp256r1, 1 ed25519, 2 webauthn. */
  creatorSigScheme: number;
  /** Creator AuthoritySlot pubkey: 33 bytes (an Ed25519 key is 32 bytes + one 0x00 pad). */
  creatorPubkey: Uint8Array;
  /** 0..=4 cash policies — only the supplied entries, never padded to 4. */
  cash: ReadonlyArray<SessionCashPolicy>;
}

/**
 * The fields shared by the hash and the instruction, in program order:
 * `authority || expiry || max_per_call || max_total || count(u8) || programs ||
 *  mandate_hash || creator_scheme(u8) || creator_pubkey(33) || cash_count(u8) || cash(64 each)`.
 */
function sessionV2Fields(p: SessionV2Params): Uint8Array[] {
  if (p.allowedPrograms.length === 0 || p.allowedPrograms.length > MAX_SESSION_ALLOWED_PROGRAMS) {
    throw new RangeError(
      `allowedPrograms must hold 1..=${MAX_SESSION_ALLOWED_PROGRAMS} entries, got ${p.allowedPrograms.length}`,
    );
  }
  if (p.cash.length > MAX_SESSION_CASH_MINTS) {
    throw new RangeError(`cash must hold at most ${MAX_SESSION_CASH_MINTS} entries, got ${p.cash.length}`);
  }
  return [
    requireLength(p.sessionAuthority, 32, 'sessionAuthority'),
    u64LE(p.expirySlot),
    u64LE(p.maxLamportsPerCall),
    u64LE(p.maxTotalSpentLamports),
    Uint8Array.of(p.allowedPrograms.length),
    ...p.allowedPrograms.map((program, i) => requireLength(program, 32, `allowedPrograms[${i}]`)),
    requireLength(p.mandateHash, 32, 'mandateHash'),
    requireByte(p.creatorSigScheme, 'creatorSigScheme'),
    requireLength(p.creatorPubkey, 33, 'creatorPubkey'),
    Uint8Array.of(p.cash.length),
    ...p.cash.map(encodeCashMintPolicy),
  ];
}

/**
 * `session_data_hash` of a v2 session — the 32-byte value that
 * `computeCreateSessionV2Message` binds. keccak256 over {@link sessionV2Fields}.
 *
 * SECURITY: every operand the owner sees at signing time is in this hash; a
 * missing field would let a relayer swap it between signature and chain.
 */
export function hashSessionDataV2(params: SessionV2Params): Uint8Array {
  return keccak_256(concatBytes(sessionV2Fields(params)));
}

/**
 * CreateSessionV2 instruction data (disc 18):
 * `[18] || max_slot(u64 LE) || <sessionV2Fields>` — length 66 + 32N + 67 + 64M.
 *
 * Accounts (program side): `[instructions_sysvar, wallet(w), fee_payer(s),
 * session(w), system_program]`; `fee_payer` funds the session PDA rent.
 */
export function buildCreateSessionV2IxData(args: SessionV2Params & { maxSlot: bigint }): Uint8Array {
  return concatBytes([
    Uint8Array.of(MachineWalletDisc.CreateSessionV2),
    u64LE(args.maxSlot),
    ...sessionV2Fields(args),
  ]);
}

/**
 * RotateRoot (17) / AdoptRoot (19) share one layout (instruction.rs `17 | 19`):
 * `[disc] || max_slot(u64 LE) || sig_scheme(u8) || pubkey(33)` — 43 bytes.
 */
function buildRootIxData(disc: number, maxSlot: bigint, sigScheme: number, pubkey: Uint8Array): Uint8Array {
  return concatBytes([
    Uint8Array.of(disc),
    u64LE(maxSlot),
    requireByte(sigScheme, 'sigScheme'),
    requireLength(pubkey, 33, 'pubkey'),
  ]);
}

/**
 * RotateRoot (disc 17): move a v2 wallet's root to an already-registered
 * authority. Accounts: `[instructions_sysvar, wallet(w), fee_payer(s)]`.
 */
export function buildRotateRootIxData(args: {
  maxSlot: bigint;
  newRootSigScheme: number;
  newRootPubkey: Uint8Array;
}): Uint8Array {
  return buildRootIxData(MachineWalletDisc.RotateRoot, args.maxSlot, args.newRootSigScheme, args.newRootPubkey);
}

/**
 * AdoptRoot (disc 19): designate the root of a v1 wallet (one of its current
 * authorities). Accounts: `[instructions_sysvar, wallet(w), fee_payer(s),
 * system_program]`; `fee_payer` funds the 34-byte root tail.
 */
export function buildAdoptRootIxData(args: {
  maxSlot: bigint;
  rootSigScheme: number;
  rootPubkey: Uint8Array;
}): Uint8Array {
  return buildRootIxData(MachineWalletDisc.AdoptRoot, args.maxSlot, args.rootSigScheme, args.rootPubkey);
}
