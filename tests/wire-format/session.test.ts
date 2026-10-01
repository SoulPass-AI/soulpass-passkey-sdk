/**
 * Known-answer tests for the budgeted session (CreateSession, disc 4): the
 * session-data hash the authorities sign over, the instruction data blob, and
 * the client-side mirror of the program's parameter checks.
 *
 * `tests/fixtures/session_data_kat.json` and `tests/fixtures/layout_kat.json`
 * are verbatim copies of the machine-wallet program's vectors, produced by its
 * own `hash_session_data` and instruction decoder.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex as hex, hexToBytes } from '@noble/hashes/utils'
import {
  CASH_MINT_POLICY_WIRE_LEN,
  CREATE_SESSION_ACCOUNTS,
  buildCreateSessionIxData,
  encodeCashMintPolicy,
  hashSessionData,
  validateSessionParams,
  type CashMintPolicy,
  type SessionParams,
} from '../../src/wire-format/session'
import { NATIVE_SOL_MINT } from '../../src/wire-format/constants'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'))

interface SessionDataVector {
  name: string
  inputs: {
    session_authority_hex: string
    expiry_slot_le_hex: string
    programs_hex: string[]
    mandate_hash_hex: string
    creator_sig_scheme_hex: string
    creator_pubkey_hex: string
    flags_hex: string
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

const sessionKat = load<{ format: string; sol_mint_hex: string; vectors: SessionDataVector[] }>(
  'session_data_kat.json',
)
const layoutKat = load<{ vectors: LayoutVector[] }>('layout_kat.json')

const u64 = (leHex: string): bigint => new DataView(hexToBytes(leHex).buffer).getBigUint64(0, true)
const byte = (h: string): number => hexToBytes(h)[0]!

/** Inverse of encodeCashMintPolicy — reads the fixtures' 64-byte wire entries. */
const decodeCashMintPolicy = (wireHex: string): CashMintPolicy => {
  const b = hexToBytes(wireHex)
  expect(b).toHaveLength(CASH_MINT_POLICY_WIRE_LEN)
  const v = new DataView(b.buffer, b.byteOffset)
  return {
    mint: b.slice(0, 32),
    perTxCap: v.getBigUint64(32, true),
    periodCap: v.getBigUint64(40, true),
    periodSlots: v.getBigUint64(48, true),
    lifetimeCap: v.getBigUint64(56, true),
  }
}

describe('hashSessionData against session_data_kat.json', () => {
  it('pins the byte order the program hashes', () => {
    expect(sessionKat.format).toBe(
      'keccak256(session_authority(32) || expiry_slot_le(8) || programs_count(1) || programs(32 each) || mandate_hash(32) || creator_sig_scheme(1) || creator_pubkey(33) || flags(1) || cash_count(1) || cash(mint(32) || per_tx_cap_le(8) || period_cap_le(8) || period_slots_le(8) || lifetime_cap_le(8)) each)',
    )
    expect(sessionKat.sol_mint_hex).toBe(hex(NATIVE_SOL_MINT))
    expect(sessionKat.vectors).toHaveLength(4)
  })

  it.each(sessionKat.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const cash = v.inputs.cash_wire_hex.map(decodeCashMintPolicy)
    // encode is the exact inverse of the fixture's wire entries.
    cash.forEach((c, i) => expect(hex(encodeCashMintPolicy(c))).toBe(v.inputs.cash_wire_hex[i]))
    const params: SessionParams = {
      sessionAuthority: hexToBytes(v.inputs.session_authority_hex),
      expirySlot: u64(v.inputs.expiry_slot_le_hex),
      allowedPrograms: v.inputs.programs_hex.map(hexToBytes),
      mandateHash: hexToBytes(v.inputs.mandate_hash_hex),
      creator: {
        sigScheme: byte(v.inputs.creator_sig_scheme_hex),
        pubkey: hexToBytes(v.inputs.creator_pubkey_hex),
      },
      flags: byte(v.inputs.flags_hex),
      cash,
    }
    expect(hex(hashSessionData(params))).toBe(v.keccak256_hex)
  })
})

/** Rebuild the SessionParams (and max_slot) from a layout vector's named fields. */
function paramsFromLayout(v: LayoutVector): { maxSlot: bigint; params: SessionParams } {
  const f = (name: string): string => {
    const field = v.fields.find((x) => x.name === name)
    if (!field) throw new Error(`layout vector ${v.name} has no field ${name}`)
    return field.hex
  }
  const count = byte(f('programs_count'))
  const cashCount = byte(f('cash_count'))
  const cashNames = v.fields.map((x) => x.name).filter((n) => n.startsWith('cash_') && n !== 'cash_count')
  expect(cashNames).toHaveLength(cashCount)
  return {
    maxSlot: u64(f('max_slot_le')),
    params: {
      sessionAuthority: hexToBytes(f('session_authority')),
      expirySlot: u64(f('expiry_slot_le')),
      allowedPrograms: Array.from({ length: count }, (_, i) => hexToBytes(f(`program_${i}`))),
      mandateHash: hexToBytes(f('mandate_hash')),
      creator: { sigScheme: byte(f('creator_sig_scheme')), pubkey: hexToBytes(f('creator_pubkey')) },
      flags: byte(f('flags')),
      cash: cashNames.map((n) => decodeCashMintPolicy(f(n))),
    },
  }
}

describe('buildCreateSessionIxData against layout_kat.json', () => {
  const v = layoutKat.vectors.find((x) => x.name === 'ix_create_session_disc4')!

  it('ix_create_session_disc4 is byte-identical (374 B)', () => {
    expect(v).toBeDefined()
    const { maxSlot, params } = paramsFromLayout(v)
    const data = buildCreateSessionIxData({ maxSlot, ...params })
    expect(data).toHaveLength(374)
    expect(data).toHaveLength(v.length)
    expect(data[0]).toBe(4)
    expect(hex(data)).toBe(v.bytes_hex)
    // The tail after disc + max_slot is exactly the preimage the hash covers.
    expect(hex(keccak_256(data.slice(9)))).toBe(hex(hashSessionData(params)))
  })

  it('account table matches the program', () => {
    expect(CREATE_SESSION_ACCOUNTS).toEqual([
      'instructions_sysvar',
      'wallet (w)',
      'fee_payer (s) = rent_payer',
      'session (w)',
      'system_program',
    ])
  })
})

describe('sessionParamsValidation', () => {
  const sol: CashMintPolicy = {
    mint: new Uint8Array(32),
    perTxCap: 1_000_000n,
    periodCap: 5_000_000n,
    periodSlots: 216_000n,
    lifetimeCap: 5_000_000n,
  }
  const usdc: CashMintPolicy = { ...sol, mint: new Uint8Array(32).fill(0xc0) }
  const base: SessionParams = {
    sessionAuthority: new Uint8Array(32).fill(0x11),
    expirySlot: 500_000n,
    allowedPrograms: [new Uint8Array(32).fill(0x51)],
    mandateHash: new Uint8Array(32).fill(0x71),
    creator: { sigScheme: 0, pubkey: new Uint8Array(33).fill(0x02) },
    flags: 0,
    cash: [sol, usdc],
  }
  const expectChainError = (p: SessionParams, name: string) => {
    const startsWithName = new RegExp(`^${name.replace(/[()]/g, '\\$&')}`)
    expect(() => validateSessionParams(p)).toThrow(startsWithName)
    // The hash and the builder refuse the same parameters.
    expect(() => hashSessionData(p)).toThrow(startsWithName)
    expect(() => buildCreateSessionIxData({ maxSlot: 1n, ...p })).toThrow(startsWithName)
  }

  it('accepts a well-formed budget (flags 0 and 1)', () => {
    expect(() => validateSessionParams(base)).not.toThrow()
    expect(() => validateSessionParams({ ...base, flags: 1 })).not.toThrow()
    // per_tx_cap 0 is legal on chain (only period/lifetime/period_slots are checked).
    expect(() => validateSessionParams({ ...base, cash: [{ ...sol, perTxCap: 0n }] })).not.toThrow()
  })

  it('missing SOL entry → SessionSolBudgetMissing', () => {
    expectChainError({ ...base, cash: [usdc] }, 'SessionSolBudgetMissing')
  })

  it('periodCap 0 → InvalidCashCap', () => {
    expectChainError({ ...base, cash: [{ ...sol, periodCap: 0n }] }, 'InvalidCashCap')
  })

  it('lifetimeCap 0 or periodSlots 0 → InvalidCashCap', () => {
    expectChainError({ ...base, cash: [{ ...sol, lifetimeCap: 0n }] }, 'InvalidCashCap')
    expectChainError({ ...base, cash: [{ ...sol, periodSlots: 0n }] }, 'InvalidCashCap')
  })

  it('duplicate mint → DuplicateCashMint', () => {
    expectChainError({ ...base, cash: [sol, usdc, { ...usdc }] }, 'DuplicateCashMint')
  })

  it('6 cash entries → TooManyCashMints', () => {
    const cash = [sol, ...Array.from({ length: 5 }, (_, i) => ({ ...sol, mint: new Uint8Array(32).fill(0xc0 + i) }))]
    expectChainError({ ...base, cash }, 'TooManyCashMints')
  })

  it('flags = 2 → InvalidSessionData(flags)', () => {
    expectChainError({ ...base, flags: 2 }, 'InvalidSessionData(flags)')
  })

  it('9 programs → TooManyAllowedPrograms', () => {
    const allowedPrograms = Array.from({ length: 9 }, (_, i) => new Uint8Array(32).fill(0x50 + i))
    expectChainError({ ...base, allowedPrograms }, 'TooManyAllowedPrograms')
  })

  it('0 programs → TooManyAllowedPrograms (the parser rejects count 0 under that name)', () => {
    expectChainError({ ...base, allowedPrograms: [] }, 'TooManyAllowedPrograms')
  })

  it('duplicate program / zero session authority → InvalidSessionData', () => {
    expectChainError({ ...base, allowedPrograms: [base.allowedPrograms[0]!, base.allowedPrograms[0]!] }, 'InvalidSessionData(allowedPrograms)')
    expectChainError({ ...base, sessionAuthority: new Uint8Array(32) }, 'InvalidSessionData(sessionAuthority)')
  })

  it('reports the fault the chain would when several are present (decoder counts first)', () => {
    const zeroAuthority = new Uint8Array(32)
    expectChainError({ ...base, sessionAuthority: zeroAuthority, allowedPrograms: [] }, 'TooManyAllowedPrograms')
    const sixCash = [sol, ...Array.from({ length: 5 }, (_, i) => ({ ...sol, mint: new Uint8Array(32).fill(0xc0 + i) }))]
    expectChainError({ ...base, sessionAuthority: zeroAuthority, cash: sixCash }, 'TooManyCashMints')
    expectChainError({ ...base, allowedPrograms: [], cash: sixCash }, 'TooManyAllowedPrograms')
  })

  it('wrong-width fields throw RangeError', () => {
    expect(() => hashSessionData({ ...base, creator: { sigScheme: 0, pubkey: new Uint8Array(32) } })).toThrow(RangeError)
    expect(() => hashSessionData({ ...base, cash: [{ ...sol, mint: new Uint8Array(31) }] })).toThrow(RangeError)
    expect(() => hashSessionData({ ...base, mandateHash: new Uint8Array(31) })).toThrow(RangeError)
  })
})
