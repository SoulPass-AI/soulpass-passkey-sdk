// @vitest-environment node
/**
 * The decoders against the program's layout vectors (`layout_kat.json`, a
 * verbatim copy) and as inverses of the builders, plus every rejection the
 * program's decoder makes.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { bytesToHex as hex, hexToBytes } from '@noble/hashes/utils'
import {
  decodeCreateSessionIxData,
  decodeExecuteIxData,
  decodeSessionExecuteIxData,
} from '../../src/wire-format/decode-ix'
import { encodeExecute, encodeRemainingAccounts } from '../../src/wire-format/execute-ix'
import { buildSessionExecuteIxData } from '../../src/wire-format/instructions'
import { buildCreateSessionIxData, type SessionParams } from '../../src/wire-format/session'
import { NATIVE_SOL_MINT } from '../../src/wire-format/constants'
import type { InnerInstruction } from '../../src/wire-format/inner-hash'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const layoutKat = JSON.parse(readFileSync(join(fixtureDir, 'layout_kat.json'), 'utf8')) as {
  vectors: { name: string; bytes_hex: string }[]
}
const vector = (name: string): Uint8Array => hexToBytes(layoutKat.vectors.find((v) => v.name === name)!.bytes_hex)

const inner: InnerInstruction[] = [
  {
    programId: Keypair.generate().publicKey.toBase58(),
    accounts: [
      { pubkey: Keypair.generate().publicKey.toBase58(), isWritable: true },
      { pubkey: Keypair.generate().publicKey.toBase58(), isWritable: false, isEphemeralSigner: true },
    ],
    data: Uint8Array.of(1, 2, 3),
  },
]

describe('decodeExecuteIxData', () => {
  it('reads ix_execute_disc1 (vault 3, one writable account, data abcd)', () => {
    const d = decodeExecuteIxData(vector('ix_execute_disc1'))
    expect(d).toMatchObject({ disc: 1, maxSlot: 0x75bcd15n, vaultIndex: 3 })
    expect(d.ephemeralSignerBumps).toBeUndefined()
    expect(d.innerInstructions).toHaveLength(1)
    expect(hex(d.innerInstructions[0].programId)).toBe('51'.repeat(32))
    expect(d.innerInstructions[0].accounts).toEqual([{ index: 0, flags: 1 }])
    expect(hex(d.innerInstructions[0].data)).toBe('abcd')
  })

  it.each([undefined, Uint8Array.of(254, 253)])('inverts encodeExecute (bumps %s)', (ephemeralSignerBumps) => {
    const { data } = encodeExecute({
      walletPDA: Keypair.generate().publicKey,
      creationSlot: 1n,
      fundsNonce: 7n,
      maxSlot: 99n,
      deployment: 'devnet',
      vaultIndex: 513,
      innerInstructions: inner,
      ephemeralSignerBumps,
    })
    const d = decodeExecuteIxData(data)
    expect(d.disc).toBe(ephemeralSignerBumps ? 16 : 1)
    expect(d.maxSlot).toBe(99n)
    expect(d.vaultIndex).toBe(513)
    expect(d.ephemeralSignerBumps).toEqual(ephemeralSignerBumps)
    expect(d.innerInstructions[0].accounts).toEqual([
      { index: 1, flags: 1 },
      { index: 2, flags: 2 },
    ])
    expect(d.innerInstructions[0].data).toEqual(Uint8Array.of(1, 2, 3))
  })

  const disc1 = vector('ix_execute_disc1')
  it.each<[string, Uint8Array]>([
    ['another discriminator', Uint8Array.of(5, ...disc1.slice(1))],
    ['truncated header', disc1.slice(0, 10)],
    ['truncated inner data', disc1.slice(0, -1)],
    ['trailing bytes', Uint8Array.of(...disc1, 0)],
    ['zero inner instructions', Uint8Array.of(...disc1.slice(0, 11), 0, 0, 0, 0)],
    ['65 inner instructions', Uint8Array.of(...disc1.slice(0, 11), 65, 0, 0, 0)],
    ['unknown account flag bit', Uint8Array.of(...disc1.slice(0, -3), 0x04, 0xab, 0xcd)],
    ['disc 16 with zero ephemeral signers', Uint8Array.of(16, ...disc1.slice(1, 11), 0, ...disc1.slice(11))],
    ['disc 16 with five ephemeral signers', Uint8Array.of(16, ...disc1.slice(1, 11), 5, 1, 2, 3, 4, 5, ...disc1.slice(11))],
  ])('rejects %s', (_name, data) => {
    expect(() => decodeExecuteIxData(data)).toThrow(/^Execute: /)
  })
})

describe('decodeExecuteIxData: ExecuteBounded (disc 25)', () => {
  it('reads ix_execute_bounded_disc25', () => {
    const d = decodeExecuteIxData(vector('ix_execute_bounded_disc25'))
    expect(d).toMatchObject({ disc: 25, vaultIndex: 3 })
    expect(d.bounds).toEqual([
      { mint: new Uint8Array(32).fill(0x33), kind: 0, amount: 5000n },
      { mint: new Uint8Array(32), kind: 1, amount: 7n },
    ])
    expect(hex(d.innerInstructions[0].data)).toBe('abcd')
  })

  const disc25 = vector('ix_execute_bounded_disc25')
  // Offsets: disc 0, max_slot 1..9, vault 9..11, count 11, bound 0 at 12 (kind at 44), bound 1 at 53.
  it.each([
    ['kind above 1', (d: Uint8Array) => { d[44] = 2 }, /kind 2/],
    ['a mint named twice', (d: Uint8Array) => { d.set(d.slice(12, 44), 53) }, /twice/],
    ['more than 8 bounds', (d: Uint8Array) => { d[11] = 9 }, /above 8|data ends/],
  ])('rejects %s, as BalanceBounds::from_bytes does', (_name, mutate, re) => {
    const d = disc25.slice()
    mutate(d)
    expect(() => decodeExecuteIxData(d)).toThrow(re)
  })
})

describe('decodeSessionExecuteIxData', () => {
  it('reads ix_session_execute_disc5 (generation 19)', () => {
    const d = decodeSessionExecuteIxData(vector('ix_session_execute_disc5'))
    expect(d.generation).toBe(19n)
    expect(d.innerInstructions[0].accounts).toEqual([{ index: 0, flags: 1 }])
    expect(hex(d.innerInstructions[0].data)).toBe('a1b2')
  })

  it('inverts buildSessionExecuteIxData', () => {
    const data = buildSessionExecuteIxData({ generation: 3n, innerInstructions: inner, remainingAccounts: encodeRemainingAccounts(inner) })
    const d = decodeSessionExecuteIxData(data)
    expect(d.generation).toBe(3n)
    expect(d.innerInstructions).toHaveLength(1)
  })

  it('rejects Execute data and trailing bytes', () => {
    expect(() => decodeSessionExecuteIxData(vector('ix_execute_disc1'))).toThrow(/^SessionExecute: /)
    expect(() => decodeSessionExecuteIxData(Uint8Array.of(...vector('ix_session_execute_disc5'), 0))).toThrow(/trailing/)
  })
})

describe('decodeCreateSessionIxData', () => {
  it('inverts ix_create_session_disc4 byte for byte', () => {
    const data = vector('ix_create_session_disc4')
    const d = decodeCreateSessionIxData(data)
    expect(d.vaultIndex).toBe(3)
    expect(hex(buildCreateSessionIxData(d))).toBe(hex(data))
  })

  const params: SessionParams & { maxSlot: bigint } = {
    maxSlot: 10n,
    sessionAuthority: new Uint8Array(32).fill(7),
    expirySlot: 500n,
    vaultIndex: 2,
    allowedPrograms: [new Uint8Array(32).fill(9)],
    mandateHash: new Uint8Array(32).fill(1),
    creator: { sigScheme: 2, pubkey: new Uint8Array(33).fill(3) },
    flags: 1,
    cash: [{ mint: NATIVE_SOL_MINT, perTxCap: 1n, periodCap: 2n, periodSlots: 3n, lifetimeCap: 4n }],
  }
  const data = buildCreateSessionIxData(params)

  it('inverts buildCreateSessionIxData', () => {
    expect(decodeCreateSessionIxData(data)).toEqual(params)
  })

  const COUNT = 1 + 8 + 32 + 8 + 2
  const withByte = (at: number, v: number) => Uint8Array.from(data, (b, i) => (i === at ? v : b))
  it.each<[string, Uint8Array]>([
    ['zero programs', withByte(COUNT, 0)],
    ['nine programs', withByte(COUNT, 9)],
    ['six cash mints', withByte(COUNT + 1 + 32 + 68 - 1, 6)],
    ['one byte short', data.slice(0, -1)],
    ['trailing bytes', Uint8Array.of(...data, 0)],
  ])('rejects %s', (_name, bad) => {
    expect(() => decodeCreateSessionIxData(bad)).toThrow(/^CreateSession: /)
  })
})
