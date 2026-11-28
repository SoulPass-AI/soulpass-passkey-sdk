/**
 * Decoders paired with the instruction-data builders: Execute (1) /
 * ExecuteWithEphemeralSigners (16) / ExecuteBounded (25), SessionExecute (5)
 * and CreateSession (4).
 *
 * Each mirrors the program's decoder (`machine-wallet/program/src/instruction.rs`
 * `MachineWalletInstruction::unpack` + `parse_inner_instructions`) check for
 * check, so "decodes here" means "the program's decoder accepts it": a relayer
 * reading untrusted ix data (matrix-contract's sponsor) reads it exactly as the
 * chain will, instead of re-deriving offsets. One addition: an empty inner list
 * is rejected here although the decoder takes it, because every handler rejects
 * it and the builders never emit it.
 *
 * Malformed data throws `Error`. Byte arrays in the results are copies.
 */

import { MachineWalletDisc } from './disc';
import { MAX_ALLOWED_PROGRAMS, MAX_BALANCE_BOUNDS, MAX_CASH_MINTS, MAX_EPHEMERAL_SIGNERS, MAX_INNER_INSTRUCTIONS } from './constants';
import type { BalanceBound } from './balance-bounds';
import { bytesEqual } from './_bytes';
import { FLAG_EPHEMERAL_SIGNER, FLAG_WRITABLE } from './inner-hash';
import type { CashMintPolicy, SessionParams } from './session';

/** One `(index, flags)` account entry; `index` points into the ix's remaining accounts (`accounts[4..]`). */
export interface DecodedAccountEntry {
  index: number;
  flags: number;
}

/** One inner instruction as encoded on the wire. */
export interface DecodedInnerInstruction {
  /** 32-byte program id. */
  programId: Uint8Array;
  accounts: DecodedAccountEntry[];
  data: Uint8Array;
}

/** Execute (disc 1), ExecuteWithEphemeralSigners (disc 16) or ExecuteBounded (disc 25) instruction data. */
export interface DecodedExecute {
  disc:
    | typeof MachineWalletDisc.Execute
    | typeof MachineWalletDisc.ExecuteWithEphemeralSigners
    | typeof MachineWalletDisc.ExecuteBounded;
  maxSlot: bigint;
  /** The vault that signs the inner instructions. */
  vaultIndex: number;
  /** 1..=4 bumps, present exactly when `disc` is 16. */
  ephemeralSignerBumps?: Uint8Array;
  /** 0..=8 outcome bounds, present exactly when `disc` is 25. */
  bounds?: BalanceBound[];
  innerInstructions: DecodedInnerInstruction[];
}

/** SessionExecute (disc 5) instruction data. The vault is the session account's `vault_index`, not on the wire. */
export interface DecodedSessionExecute {
  generation: bigint;
  innerInstructions: DecodedInnerInstruction[];
}

const VALID_ACCOUNT_FLAGS = FLAG_WRITABLE | FLAG_EPHEMERAL_SIGNER;

/** Front-to-back reader over ix data, the counterpart of the program's `Reader`. */
class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly data: Uint8Array, private readonly label: string) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  bytes(n: number): Uint8Array {
    if (this.offset + n > this.data.length) {
      throw new Error(`${this.label}: data ends at ${this.data.length}, needs ${this.offset + n}`);
    }
    const out = this.data.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  u8(): number {
    return this.bytes(1)[0];
  }

  u16(): number {
    const v = this.bytes(2);
    return v[0] | (v[1] << 8);
  }

  u32(): number {
    this.bytes(4);
    return this.view.getUint32(this.offset - 4, true);
  }

  u64(): bigint {
    this.bytes(8);
    return this.view.getBigUint64(this.offset - 8, true);
  }

  /** `r.finish()`: every byte consumed. */
  finish(): void {
    if (this.offset !== this.data.length) {
      throw new Error(`${this.label}: ${this.data.length - this.offset} trailing bytes`);
    }
  }
}

function readDisc(r: Reader, label: string, allowed: readonly number[]): number {
  const disc = r.u8();
  if (!allowed.includes(disc)) throw new Error(`${label}: unexpected discriminator ${disc}`);
  return disc;
}

/** `parse_inner_instructions`: count u32, then count × (program_id, accounts_len, data_len, entries, data), to the end. */
function readInnerInstructions(r: Reader, label: string): DecodedInnerInstruction[] {
  const count = r.u32();
  if (count === 0 || count > MAX_INNER_INSTRUCTIONS) {
    throw new Error(`${label}: inner instruction count ${count} outside 1..=${MAX_INNER_INSTRUCTIONS}`);
  }
  const out: DecodedInnerInstruction[] = [];
  for (let i = 0; i < count; i++) {
    const programId = r.bytes(32);
    const accountsLen = r.u16();
    const dataLen = r.u16();
    const entries = r.bytes(accountsLen * 2);
    const accounts: DecodedAccountEntry[] = [];
    for (let a = 0; a < entries.length; a += 2) {
      const flags = entries[a + 1];
      if ((flags & ~VALID_ACCOUNT_FLAGS) !== 0) {
        throw new Error(`${label}: inner[${i}] account ${a / 2} has unknown flag bits 0x${flags.toString(16)}`);
      }
      accounts.push({ index: entries[a], flags });
    }
    out.push({ programId, accounts, data: r.bytes(dataLen) });
  }
  r.finish();
  return out;
}

/** Decode Execute (disc 1), ExecuteWithEphemeralSigners (disc 16) or ExecuteBounded (disc 25) instruction data. */
export function decodeExecuteIxData(data: Uint8Array): DecodedExecute {
  const label = 'Execute';
  const r = new Reader(data, label);
  const disc = readDisc(r, label, [
    MachineWalletDisc.Execute,
    MachineWalletDisc.ExecuteWithEphemeralSigners,
    MachineWalletDisc.ExecuteBounded,
  ]) as DecodedExecute['disc'];
  const maxSlot = r.u64();
  const vaultIndex = r.u16();
  if (disc === MachineWalletDisc.Execute) {
    return { disc, maxSlot, vaultIndex, innerInstructions: readInnerInstructions(r, label) };
  }
  if (disc === MachineWalletDisc.ExecuteBounded) {
    return { disc, maxSlot, vaultIndex, bounds: readBalanceBounds(r, label), innerInstructions: readInnerInstructions(r, label) };
  }
  const numEphemeral = r.u8();
  if (numEphemeral === 0 || numEphemeral > MAX_EPHEMERAL_SIGNERS) {
    throw new Error(`${label}: ephemeral signer count ${numEphemeral} outside 1..=${MAX_EPHEMERAL_SIGNERS}`);
  }
  const ephemeralSignerBumps = r.bytes(numEphemeral);
  return { disc, maxSlot, vaultIndex, ephemeralSignerBumps, innerInstructions: readInnerInstructions(r, label) };
}

/** `BalanceBounds::from_bytes`: count ≤ 8, kind ≤ 1, no mint named twice. */
function readBalanceBounds(r: Reader, label: string): BalanceBound[] {
  const count = r.u8();
  if (count > MAX_BALANCE_BOUNDS) throw new Error(`${label}: bound count ${count} above ${MAX_BALANCE_BOUNDS}`);
  const out: BalanceBound[] = [];
  for (let i = 0; i < count; i++) {
    const mint = r.bytes(32);
    const kind = r.u8();
    if (kind > 1) throw new Error(`${label}: bound ${i} kind ${kind} above 1`);
    if (out.some((b) => bytesEqual(b.mint, mint))) throw new Error(`${label}: bound ${i} names a mint twice`);
    out.push({ mint, kind: kind as BalanceBound['kind'], amount: r.u64() });
  }
  return out;
}

/** Decode SessionExecute (disc 5) instruction data. */
export function decodeSessionExecuteIxData(data: Uint8Array): DecodedSessionExecute {
  const label = 'SessionExecute';
  const r = new Reader(data, label);
  readDisc(r, label, [MachineWalletDisc.SessionExecute]);
  const generation = r.u64();
  return { generation, innerInstructions: readInnerInstructions(r, label) };
}

/**
 * Decode CreateSession (disc 4) instruction data — the inverse of
 * `buildCreateSessionIxData`. Applies the decoder's checks only (program count
 * 1..=8, cash count ≤ 5, exact length); the handler's field checks are
 * `validateSessionParams`.
 */
export function decodeCreateSessionIxData(data: Uint8Array): SessionParams & { maxSlot: bigint } {
  const label = 'CreateSession';
  const r = new Reader(data, label);
  readDisc(r, label, [MachineWalletDisc.CreateSession]);
  const maxSlot = r.u64();
  const sessionAuthority = r.bytes(32);
  const expirySlot = r.u64();
  const vaultIndex = r.u16();
  const programCount = r.u8();
  if (programCount === 0 || programCount > MAX_ALLOWED_PROGRAMS) {
    throw new Error(`${label}: allowed program count ${programCount} outside 1..=${MAX_ALLOWED_PROGRAMS}`);
  }
  const allowedPrograms = Array.from({ length: programCount }, () => r.bytes(32));
  const mandateHash = r.bytes(32);
  const creator = { sigScheme: r.u8(), pubkey: r.bytes(33) };
  const flags = r.u8();
  const cashCount = r.u8();
  if (cashCount > MAX_CASH_MINTS) {
    throw new Error(`${label}: cash mint count ${cashCount} above ${MAX_CASH_MINTS}`);
  }
  const cash = Array.from({ length: cashCount }, (): CashMintPolicy => ({
    mint: r.bytes(32),
    perTxCap: r.u64(),
    periodCap: r.u64(),
    periodSlots: r.u64(),
    lifetimeCap: r.u64(),
  }));
  r.finish();
  return { maxSlot, sessionAuthority, expirySlot, vaultIndex, allowedPrograms, mandateHash, creator, flags, cash };
}
