/**
 * SessionState ('S') decoding and the liveness predicate, pinned by the
 * program's `session_p2_sol_cash1_sleeve1_passkey_creator` layout vector
 * (`tests/fixtures/layout_kat.json`, a verbatim copy of the program's file).
 *
 * Offsets are written out from `state.rs` (`SessionState`) for P = 2, C = 2:
 * generation at 101; budget segment at 109 + 2×32 = 173 → mandate 173,
 * creator 205, rent_payer 239, cash_count 271, cash 272, sleeve_count 448,
 * sleeve 449.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import {
  isSessionLive,
  parseSessionState,
  sessionAccountSize,
  sessionSolPolicy,
  type SessionState,
} from '../../src/wire-format/session-state'
import { parseWalletState, SigScheme, type MachineWalletState } from '../../src/wallet-state'
import { NATIVE_SOL_MINT } from '../../src/wire-format/constants'

interface LayoutVector {
  name: string
  fields: { name: string; hex: string }[]
  bytes_hex: string
}
const layoutKat: { vectors: LayoutVector[] } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures/layout_kat.json'), 'utf8'),
)
const kat = (name: string): LayoutVector => {
  const v = layoutKat.vectors.find((x) => x.name === name)
  if (!v) throw new Error(`layout_kat.json is missing ${name}`)
  return v
}
const SESSION = kat('session_p2_sol_cash1_sleeve1_passkey_creator')
const field = (name: string): Uint8Array => {
  const f = SESSION.fields.find((x) => x.name === name || x.name.startsWith(`${name} `))
  if (!f) throw new Error(`session vector has no field ${name}`)
  return hexToBytes(f.hex)
}
const u64 = (b: Uint8Array, off = 0): bigint => new DataView(b.buffer, b.byteOffset).getBigUint64(off, true)
const sessionBytes = (): Uint8Array => hexToBytes(SESSION.bytes_hex)
const walletState = (): MachineWalletState =>
  parseWalletState(hexToBytes(kat('wallet_2auth_passkey_root_pending_recovery').bytes_hex))

const OFF = {
  REVOKED: 82,
  FLAGS: 99,
  PROGRAMS_COUNT: 100,
  PROGRAM_1: 141,
  CREATOR: 205,
  CASH_COUNT: 271,
  CASH_0: 272,
  CASH_1: 360,
  SLEEVE_COUNT: 448,
  SLEEVE_1: 489,
} as const

describe('parseSessionState — layout KAT (program bytes)', () => {
  it('decodes session_p2_sol_cash1_sleeve1_passkey_creator field-for-field', () => {
    const data = sessionBytes()
    expect(data).toHaveLength(1089)
    expect(sessionAccountSize(2, 2)).toBe(1089)

    const s: SessionState = parseSessionState(data)
    expect(s.bump).toBe(0xfc)
    expect(s.wallet).toEqual(field('wallet'))
    expect(s.authority).toEqual(field('authority'))
    expect(s.generation).toBe(u64(field('generation_le')))
    expect(s.createdSlot).toBe(u64(field('created_slot_le')))
    expect(s.expirySlot).toBe(u64(field('expiry_slot_le')))
    expect(s.revoked).toBe(false)
    expect(s.walletCreationSlot).toBe(u64(field('wallet_creation_slot_le')))
    expect(s.authorityEpoch).toBe(3n)
    expect(s.flags).toBe(1)
    expect(s.allowedPrograms).toEqual([field('allowed_program_0'), field('allowed_program_1')])
    expect(s.mandateHash).toEqual(field('mandate_hash'))
    expect(s.creator.sigScheme).toBe(SigScheme.Webauthn)
    expect(s.creator.pubkey).toEqual(field('creator').slice(1))
    expect(s.rentPayer).toEqual(field('rent_payer'))

    expect(s.cash).toHaveLength(2)
    expect(s.cash[0].mint).toEqual(NATIVE_SOL_MINT)
    const c1 = field('cash_1')
    expect(s.cash[1]).toEqual({
      mint: c1.slice(0, 32),
      perTxCap: u64(c1, 32),
      periodCap: u64(c1, 40),
      periodSlots: u64(c1, 48),
      periodStartSlot: u64(c1, 56),
      spentInPeriod: u64(c1, 64),
      lifetimeCap: u64(c1, 72),
      lifetimeSpent: u64(c1, 80),
    })

    expect(s.sleeve).toHaveLength(1)
    const sleeve = field('sleeve')
    expect(s.sleeve[0]).toEqual({ mint: sleeve.slice(0, 32), amount: u64(sleeve, 32) })
  })

  it('sessionAccountSize is 849 + 32P + 88C', () => {
    expect(sessionAccountSize(1, 1)).toBe(969)
    expect(sessionAccountSize(8, 5)).toBe(1545)
  })

  it('sessionSolPolicy returns the all-zero-mint entry', () => {
    const s = parseSessionState(sessionBytes())
    expect(sessionSolPolicy(s)).toBe(s.cash[0])
    expect(sessionSolPolicy(s)!.periodCap).toBe(u64(field('cash_0'), 40))
  })

  it('returns copies, never views into the caller buffer', () => {
    const data = sessionBytes()
    const s = parseSessionState(data)
    data.fill(0)
    expect(s.wallet).toEqual(field('wallet'))
    expect(s.allowedPrograms[0]).toEqual(field('allowed_program_0'))
    expect(s.cash[1].mint).toEqual(field('cash_1').slice(0, 32))
  })
})

describe('sessionStateValidation', () => {
  const rejects = (mutate: (d: Uint8Array) => Uint8Array | void, pattern: RegExp | string) => {
    const d = sessionBytes()
    const out = mutate(d) ?? d
    expect(() => parseSessionState(out)).toThrow(pattern)
  }

  it('rejects a wrong tag (wallet, retired, foreign)', () => {
    for (const tag of [0, 1, 2, 0x57, 0x99]) {
      rejects((d) => void (d[0] = tag), `Unsupported SessionState account tag ${tag}`)
    }
  })

  it('rejects a length mismatch (±1 byte) and a body shorter than the header', () => {
    rejects((d) => d.slice(0, -1), /too small/i)
    rejects((d) => {
      const long = new Uint8Array(d.length + 1)
      long.set(d)
      return long
    }, /trailing bytes/i)
    rejects((d) => d.slice(0, 100), /too small/i)
  })

  it('rejects unknown flag bits (flags = 2)', () => {
    rejects((d) => void (d[OFF.FLAGS] = 2), /flags/i)
  })

  it('rejects allowed_programs_count 0 and 9', () => {
    for (const n of [0, 9]) rejects((d) => void (d[OFF.PROGRAMS_COUNT] = n), /allowed_programs_count/i)
  })

  it('rejects cash_count 6', () => {
    rejects((d) => void (d[OFF.CASH_COUNT] = 6), /cash_count/i)
  })

  it('rejects sleeve_count 17', () => {
    rejects((d) => void (d[OFF.SLEEVE_COUNT] = 17), /sleeve_count/i)
  })

  it('rejects a zero wallet, a zero authority and created_slot > expiry_slot', () => {
    rejects((d) => void d.fill(0, 2, 34), /wallet/i)
    rejects((d) => void d.fill(0, 34, 66), /authority/i)
    rejects((d) => void new DataView(d.buffer).setBigUint64(66, 600_000n, true), /created_slot/i)
  })

  it('rejects a repeated allowed program', () => {
    rejects((d) => void d.copyWithin(OFF.PROGRAM_1, 109, 141), /allowed program/i)
  })

  it('rejects an unknown creator sig_scheme', () => {
    rejects((d) => void (d[OFF.CREATOR] = 7), /creator/i)
  })

  it('rejects a cash entry that breaks a policy invariant', () => {
    const view = (d: Uint8Array) => new DataView(d.buffer)
    // period_cap 0, period_slots 0, lifetime_cap 0
    for (const rel of [40, 48, 72]) {
      rejects((d) => void view(d).setBigUint64(OFF.CASH_1 + rel, 0n, true), /cash\[1\]/i)
    }
    // spent_in_period > period_cap; lifetime_spent > lifetime_cap
    rejects((d) => void view(d).setBigUint64(OFF.CASH_1 + 64, 1n << 40n, true), /cash\[1\]/i)
    rejects((d) => void view(d).setBigUint64(OFF.CASH_1 + 80, 1n << 40n, true), /cash\[1\]/i)
  })

  it('rejects a repeated cash mint and a session without the SOL budget', () => {
    rejects((d) => void d.fill(0, OFF.CASH_1, OFF.CASH_1 + 32), /cash\[1\]/i)
    rejects((d) => void d.fill(0xc0, OFF.CASH_0, OFF.CASH_0 + 32), /SOL/)
  })

  it('rejects a repeated sleeve mint', () => {
    rejects((d) => {
      d[OFF.SLEEVE_COUNT] = 2
      d.copyWithin(OFF.SLEEVE_1, OFF.SLEEVE_COUNT + 1, OFF.SLEEVE_1)
    }, /sleeve\[1\]/i)
  })
})

describe('isSessionLive', () => {
  const wallet = walletState()
  const session = parseSessionState(sessionBytes())

  it('is live for the matching wallet before expiry', () => {
    expect(isSessionLive(session, wallet, 1_000n)).toBe(true)
  })

  it('is not live once revoked', () => {
    const d = sessionBytes()
    d[OFF.REVOKED] = 1
    expect(isSessionLive(parseSessionState(d), wallet, 1_000n)).toBe(false)
  })

  it('is live at expiry_slot (the last accepted slot) and not past it', () => {
    expect(isSessionLive(session, wallet, session.expirySlot)).toBe(true)
    expect(isSessionLive(session, wallet, session.expirySlot + 1n)).toBe(false)
  })

  it('is not live after the wallet was closed and recreated (creation_slot moved)', () => {
    expect(isSessionLive(session, { ...wallet, creationSlot: wallet.creationSlot + 1n }, 1_000n)).toBe(false)
  })

  it('is not live once the wallet authority epoch moved', () => {
    expect(isSessionLive(session, { ...wallet, authorityEpoch: wallet.authorityEpoch + 1n }, 1_000n)).toBe(false)
  })
})
