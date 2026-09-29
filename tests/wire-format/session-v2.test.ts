/**
 * Known-answer tests for the machine-wallet v2 session hash and the v2
 * instruction data builders (discs 17 / 18 / 19).
 *
 * `tests/fixtures/session_data_v2_kat.json` and `tests/fixtures/v2_layout_kat.json`
 * are verbatim copies of machine-wallet `program/tests/vectors/` (ca6073d),
 * produced by the program's own `hash_session_data_v2` and instruction
 * decoder; `scripts/check-fixtures.mjs` keeps them byte-identical to the Swift
 * SDK's copies.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { bytesToHex as hex, hexToBytes } from '@noble/hashes/utils'
import {
  buildAdoptRootIxData,
  buildCreateSessionV2IxData,
  buildRotateRootIxData,
  encodeCashMintPolicy,
  hashSessionDataV2,
  type SessionCashPolicy,
} from '../../src/wire-format/session-v2'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))

interface SessionDataVector {
  name: string
  inputs: {
    session_authority_hex: string
    expiry_slot_le_hex: string
    max_lamports_per_call_le_hex: string
    max_total_spent_lamports_le_hex: string
    programs_hex: string[]
    mandate_hash_hex: string
    creator_sig_scheme_hex: string
    creator_pubkey_hex: string
    cash_wire_hex: string[]
  }
  keccak256_hex: string
}

interface LayoutVector {
  name: string
  fields: { name: string; hex: string }[]
  length: number
  bytes_hex: string
}

const sessionKat = load<{ format: string; vectors: SessionDataVector[] }>('session_data_v2_kat.json')
const layoutKat = load<{ format: string; vectors: LayoutVector[] }>('v2_layout_kat.json')

const u64 = (leHex: string): bigint => new DataView(hexToBytes(leHex).buffer).getBigUint64(0, true)

/** Inverse of encodeCashMintPolicy — reads the fixture's 64-byte wire entries. */
const cashFromWire = (wireHex: string): SessionCashPolicy => {
  const b = hexToBytes(wireHex)
  expect(b).toHaveLength(64)
  const v = new DataView(b.buffer)
  return {
    mint: b.slice(0, 32),
    perTxCap: v.getBigUint64(32, true),
    periodCap: v.getBigUint64(40, true),
    periodSlots: v.getBigUint64(48, true),
    lifetimeCap: v.getBigUint64(56, true),
  }
}

const field = (v: LayoutVector, name: string): string => {
  const f = v.fields.find((x) => x.name === name)
  if (!f) throw new Error(`${v.name} has no field ${name}`)
  return f.hex
}
const layout = (name: string): LayoutVector => {
  const v = layoutKat.vectors.find((x) => x.name === name)
  if (!v) throw new Error(`v2_layout_kat.json is missing ${name}`)
  return v
}

describe('hashSessionDataV2 against session_data_v2_kat.json', () => {
  it('covers the four program vectors', () => {
    expect(sessionKat.vectors.map((v) => v.name)).toEqual([
      'programs1_cash0',
      'programs3_cash1',
      'programs8_cash4',
      'programs2_cash2_webauthn_creator',
    ])
  })

  it.each(sessionKat.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const i = v.inputs
    const cash = i.cash_wire_hex.map(cashFromWire)
    // encodeCashMintPolicy is the exact inverse of the fixture's wire entries.
    expect(cash.map((c) => hex(encodeCashMintPolicy(c)))).toEqual(i.cash_wire_hex)
    const digest = hashSessionDataV2({
      sessionAuthority: hexToBytes(i.session_authority_hex),
      expirySlot: u64(i.expiry_slot_le_hex),
      maxLamportsPerCall: u64(i.max_lamports_per_call_le_hex),
      maxTotalSpentLamports: u64(i.max_total_spent_lamports_le_hex),
      allowedPrograms: i.programs_hex.map(hexToBytes),
      mandateHash: hexToBytes(i.mandate_hash_hex),
      creatorSigScheme: hexToBytes(i.creator_sig_scheme_hex)[0],
      creatorPubkey: hexToBytes(i.creator_pubkey_hex),
      cash,
    })
    expect(hex(digest)).toBe(v.keccak256_hex)
  })

  it('refuses shapes the program refuses instead of hashing them', () => {
    const base = {
      sessionAuthority: new Uint8Array(32),
      expirySlot: 1n,
      maxLamportsPerCall: 1n,
      maxTotalSpentLamports: 1n,
      allowedPrograms: [new Uint8Array(32)],
      mandateHash: new Uint8Array(32),
      creatorSigScheme: 2,
      creatorPubkey: new Uint8Array(33),
      cash: [] as SessionCashPolicy[],
    }
    expect(() => hashSessionDataV2({ ...base, allowedPrograms: [] })).toThrow(RangeError)
    expect(() =>
      hashSessionDataV2({ ...base, allowedPrograms: Array.from({ length: 9 }, () => new Uint8Array(32)) }),
    ).toThrow(RangeError)
    const policy = { mint: new Uint8Array(32), perTxCap: 1n, periodCap: 1n, periodSlots: 1n, lifetimeCap: 1n }
    expect(() => hashSessionDataV2({ ...base, cash: Array.from({ length: 5 }, () => policy) })).toThrow(RangeError)
    expect(() => hashSessionDataV2({ ...base, creatorPubkey: new Uint8Array(32) })).toThrow(RangeError)
  })
})

describe('v2 instruction data against v2_layout_kat.json', () => {
  it('CreateSessionV2 (disc 18)', () => {
    const v = layout('ix_create_session_v2_disc18')
    const cash = ['cash_0', 'cash_1'].map((n) => cashFromWire(field(v, n)))
    const data = buildCreateSessionV2IxData({
      maxSlot: u64(field(v, 'max_slot_le')),
      sessionAuthority: hexToBytes(field(v, 'session_authority')),
      expirySlot: u64(field(v, 'expiry_slot_le')),
      maxLamportsPerCall: u64(field(v, 'max_lamports_per_call_le')),
      maxTotalSpentLamports: u64(field(v, 'max_total_spent_lamports_le')),
      allowedPrograms: [hexToBytes(field(v, 'program_0')), hexToBytes(field(v, 'program_1'))],
      mandateHash: hexToBytes(field(v, 'mandate_hash')),
      creatorSigScheme: hexToBytes(field(v, 'creator_sig_scheme'))[0],
      creatorPubkey: hexToBytes(field(v, 'creator_pubkey')),
      cash,
    })
    expect(data).toHaveLength(v.length)
    expect(hex(data)).toBe(v.bytes_hex)
  })

  it('RotateRoot (disc 17)', () => {
    const v = layout('ix_rotate_root_disc17')
    const data = buildRotateRootIxData({
      maxSlot: u64(field(v, 'max_slot_le')),
      newRootSigScheme: hexToBytes(field(v, 'sig_scheme'))[0],
      newRootPubkey: hexToBytes(field(v, 'pubkey')),
    })
    expect(data).toHaveLength(43)
    expect(hex(data)).toBe(v.bytes_hex)
  })

  it('AdoptRoot (disc 19)', () => {
    const v = layout('ix_adopt_root_disc19')
    const data = buildAdoptRootIxData({
      maxSlot: u64(field(v, 'max_slot_le')),
      rootSigScheme: hexToBytes(field(v, 'sig_scheme'))[0],
      rootPubkey: hexToBytes(field(v, 'pubkey')),
    })
    expect(data).toHaveLength(43)
    expect(hex(data)).toBe(v.bytes_hex)
  })

  it('every layout vector is the concatenation of its fields', () => {
    for (const v of layoutKat.vectors) {
      expect(v.fields.map((f) => f.hex).join(''), v.name).toBe(v.bytes_hex)
      expect(v.bytes_hex.length / 2, v.name).toBe(v.length)
    }
  })
})
