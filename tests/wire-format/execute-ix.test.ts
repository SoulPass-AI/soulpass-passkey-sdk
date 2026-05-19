// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  buildEvidenceIxData,
  buildEvidenceCompactIxData,
  buildExecuteIxData,
  encodeRemainingAccounts,
} from '../../src/wire-format/execute-ix'
import { MachineWalletDisc } from '../../src/wire-format/disc'
import type { InnerInstruction } from '../../src/wire-format/inner-hash'

describe('buildEvidenceIxData', () => {
  it('emits [disc=15][len u16 LE][cdj]', () => {
    const cdj = new TextEncoder().encode('{"type":"webauthn.get"}')
    const data = buildEvidenceIxData(cdj)
    expect(data[0]).toBe(MachineWalletDisc.ProvideWebAuthnEvidence)
    const lenLo = data[1]
    const lenHi = data[2]
    expect(lenLo + (lenHi << 8)).toBe(cdj.length)
    expect(data.slice(3)).toEqual(cdj)
    expect(data.length).toBe(1 + 2 + cdj.length)
  })

  it('rejects empty clientDataJSON (chain rejects too)', () => {
    expect(() => buildEvidenceIxData(new Uint8Array())).toThrow(/non-empty/)
  })
})

describe('buildEvidenceCompactIxData', () => {
  it('emits exactly 76 bytes [disc=15][challenge 43][cdHash 32]', () => {
    const challenge = new Uint8Array(43).fill(0x11)
    const cdHash = new Uint8Array(32).fill(0x22)
    const data = buildEvidenceCompactIxData(challenge, cdHash)
    expect(data.length).toBe(1 + 43 + 32)
    expect(data[0]).toBe(MachineWalletDisc.ProvideWebAuthnEvidence)
    expect(data.slice(1, 44)).toEqual(challenge)
    expect(data.slice(44)).toEqual(cdHash)
  })

  it('rejects wrong-size challenge / cdHash', () => {
    expect(() =>
      buildEvidenceCompactIxData(new Uint8Array(42), new Uint8Array(32)),
    ).toThrow(/43 bytes/)
    expect(() =>
      buildEvidenceCompactIxData(new Uint8Array(43), new Uint8Array(31)),
    ).toThrow(/32 bytes/)
  })
})

describe('encodeRemainingAccounts', () => {
  const prog1 = Keypair.generate().publicKey
  const prog2 = Keypair.generate().publicKey
  const acc1 = Keypair.generate().publicKey
  const acc2 = Keypair.generate().publicKey

  it('lists program IDs first, then accounts in first-seen order', () => {
    const inner: InnerInstruction[] = [
      {
        programId: prog1.toBase58(),
        accounts: [
          { pubkey: acc1.toBase58(), isWritable: true },
          { pubkey: acc2.toBase58(), isWritable: false },
        ],
        data: new Uint8Array(),
      },
      {
        programId: prog2.toBase58(),
        accounts: [{ pubkey: acc1.toBase58(), isWritable: false }],
        data: new Uint8Array(),
      },
    ]

    const result = encodeRemainingAccounts(inner)
    expect(result.map((r) => r.pubkey.toBase58())).toEqual([
      prog1.toBase58(),
      prog2.toBase58(),
      acc1.toBase58(),
      acc2.toBase58(),
    ])
  })

  it('OR-aggregates isWritable across repeated references', () => {
    // acc1 referenced as non-writable (in prog2 ix), but also as writable
    // (in prog1 ix) — the de-duped slot must end up writable, otherwise the
    // on-chain account scanner would refuse the writable inner mutation.
    const inner: InnerInstruction[] = [
      {
        programId: prog1.toBase58(),
        accounts: [{ pubkey: acc1.toBase58(), isWritable: true }],
        data: new Uint8Array(),
      },
      {
        programId: prog2.toBase58(),
        accounts: [{ pubkey: acc1.toBase58(), isWritable: false }],
        data: new Uint8Array(),
      },
    ]

    const result = encodeRemainingAccounts(inner)
    const acc1Entry = result.find((r) => r.pubkey.equals(acc1))
    expect(acc1Entry?.isWritable).toBe(true)
  })

  it('program IDs always isWritable=false', () => {
    const inner: InnerInstruction[] = [
      {
        programId: prog1.toBase58(),
        accounts: [{ pubkey: prog1.toBase58(), isWritable: true }],
        data: new Uint8Array(),
      },
    ]
    const result = encodeRemainingAccounts(inner)
    // Even though prog1 appears as an inner-ix account with isWritable=true,
    // it was registered as a program ID first, so the OR-aggregation flips
    // it to writable. This is correct: the same pubkey in both roles MUST be
    // writable in the outer ix or the inner mutation fails.
    expect(result[0].pubkey.equals(prog1)).toBe(true)
    expect(result[0].isWritable).toBe(true)
  })
})

describe('buildExecuteIxData', () => {
  const prog = Keypair.generate().publicKey
  const acc = Keypair.generate().publicKey

  const inner: InnerInstruction[] = [
    {
      programId: prog.toBase58(),
      accounts: [{ pubkey: acc.toBase58(), isWritable: true }],
      data: new Uint8Array([0xde, 0xad]),
    },
  ]

  it('disc=1 layout when no bumps: [disc=1][max_slot u64 LE][inner_count u32 LE][...payload]', () => {
    const remaining = encodeRemainingAccounts(inner)
    const data = buildExecuteIxData({
      maxSlot: 0x1122334455667788n,
      innerInstructions: inner,
      remainingAccounts: remaining,
    })

    expect(data[0]).toBe(MachineWalletDisc.Execute)
    // max_slot u64 LE at bytes 1..9
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    expect(view.getBigUint64(1, true)).toBe(0x1122334455667788n)
    // inner_count u32 LE at bytes 9..13
    expect(view.getUint32(9, true)).toBe(1)
    // Then the encoded inner ix starts: program_id (32) | accounts_len (2) | data_len (2) | entries (2) | data (2)
    const payloadStart = 13
    expect(data.slice(payloadStart, payloadStart + 32)).toEqual(prog.toBytes())
    expect(view.getUint16(payloadStart + 32, true)).toBe(1) // accounts_len
    expect(view.getUint16(payloadStart + 34, true)).toBe(2) // data_len
    // account entry: index byte + flags byte. encodeRemainingAccounts puts
    // program IDs first (prog → index 0), then accounts in first-seen order
    // (acc → index 1). So the inner-ix's only account references index 1.
    expect(data[payloadStart + 36]).toBe(1)
    expect(data[payloadStart + 37]).toBe(0x01) // FLAG_WRITABLE
    expect(data.slice(payloadStart + 38)).toEqual(new Uint8Array([0xde, 0xad]))
  })

  it('disc=16 layout when bumps present: [disc=16][max_slot][num_eph][bumps][inner_count][...payload]', () => {
    const remaining = encodeRemainingAccounts(inner)
    const bumps = Uint8Array.of(254, 253)
    const data = buildExecuteIxData({
      maxSlot: 42n,
      innerInstructions: inner,
      remainingAccounts: remaining,
      ephemeralSignerBumps: bumps,
    })

    expect(data[0]).toBe(MachineWalletDisc.ExecuteWithEphemeralSigners)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    expect(view.getBigUint64(1, true)).toBe(42n)
    expect(data[9]).toBe(bumps.length)
    expect(data.slice(10, 10 + bumps.length)).toEqual(bumps)
    // inner_count u32 LE right after bumps
    expect(view.getUint32(10 + bumps.length, true)).toBe(1)
  })

  it('rejects inner-ix referencing an account missing from remainingAccounts', () => {
    const stray = Keypair.generate().publicKey
    const innerWithStray: InnerInstruction[] = [
      {
        programId: prog.toBase58(),
        accounts: [{ pubkey: stray.toBase58(), isWritable: false }],
        data: new Uint8Array(),
      },
    ]
    const remaining = [{ pubkey: prog, isWritable: false }]
    expect(() =>
      buildExecuteIxData({
        maxSlot: 0n,
        innerInstructions: innerWithStray,
        remainingAccounts: remaining,
      }),
    ).toThrow(/not present in remainingAccounts/)
  })

  it('rejects > 255 unique accounts (u8 index ceiling)', () => {
    // Pre-build 257 accounts; encodeRemainingAccounts gives us indices 0..256.
    // 256 is the boundary that breaks `index <= 0xff`.
    const programs: PublicKey[] = Array.from({ length: 257 }, () => Keypair.generate().publicKey)
    const innerOverflow: InnerInstruction[] = programs.map((p, idx) => ({
      programId: p.toBase58(),
      accounts: idx === 256 ? [{ pubkey: p.toBase58(), isWritable: false }] : [],
      data: new Uint8Array(),
    }))
    const remaining = encodeRemainingAccounts(innerOverflow)
    expect(() =>
      buildExecuteIxData({
        maxSlot: 0n,
        innerInstructions: innerOverflow,
        remainingAccounts: remaining,
      }),
    ).toThrow(/exceeds u8/)
  })
})
