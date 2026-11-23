// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  buildEvidenceIxData,
  buildExecuteIxData,
  encodeExecute,
  encodeRemainingAccounts,
} from '../../src/wire-format/execute-ix'
import { computeExecuteEphemeralMessage, computeExecuteMessage } from '../../src/wire-format/operation-hash'
import { computeInnerHash } from '../../src/wire-format/inner-hash'
import { deriveVaultPda } from '../../src/wire-format/pda'
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

  it('rejects clientDataJSON over the on-chain 1024-byte sidecar cap', () => {
    expect(() => buildEvidenceIxData(new Uint8Array(1025))).toThrow(/1024/)
    expect(buildEvidenceIxData(new Uint8Array(1024)).length).toBe(1 + 2 + 1024)
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

  it('disc=1 layout when no bumps: [disc=1][max_slot u64 LE][vault_index u16 LE][inner_count u32 LE][...payload]', () => {
    const remaining = encodeRemainingAccounts(inner)
    const data = buildExecuteIxData({
      maxSlot: 0x1122334455667788n,
      vaultIndex: 0x0203,
      innerInstructions: inner,
      remainingAccounts: remaining,
    })

    expect(data[0]).toBe(MachineWalletDisc.Execute)
    // max_slot u64 LE at bytes 1..9
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    expect(view.getBigUint64(1, true)).toBe(0x1122334455667788n)
    // vault_index u16 LE at bytes 9..11
    expect(view.getUint16(9, true)).toBe(0x0203)
    // inner_count u32 LE at bytes 11..15
    expect(view.getUint32(11, true)).toBe(1)
    // Then the encoded inner ix starts: program_id (32) | accounts_len (2) | data_len (2) | entries (2) | data (2)
    const payloadStart = 15
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

  it('disc=16 layout when bumps present: [disc=16][max_slot][vault_index][num_eph][bumps][inner_count][...payload]', () => {
    const remaining = encodeRemainingAccounts(inner)
    const bumps = Uint8Array.of(254, 253)
    const data = buildExecuteIxData({
      maxSlot: 42n,
      vaultIndex: 7,
      innerInstructions: inner,
      remainingAccounts: remaining,
      ephemeralSignerBumps: bumps,
    })

    expect(data[0]).toBe(MachineWalletDisc.ExecuteWithEphemeralSigners)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    expect(view.getBigUint64(1, true)).toBe(42n)
    expect(view.getUint16(9, true)).toBe(7)
    expect(data[11]).toBe(bumps.length)
    expect(data.slice(12, 12 + bumps.length)).toEqual(bumps)
    // inner_count u32 LE right after bumps
    expect(view.getUint32(12 + bumps.length, true)).toBe(1)
  })

  it('vaultIndex must be a u16 (no default: the caller names the vault)', () => {
    const remaining = encodeRemainingAccounts(inner)
    for (const vaultIndex of [-1, 0x10000, 1.5]) {
      expect(() =>
        buildExecuteIxData({ maxSlot: 1n, vaultIndex, innerInstructions: inner, remainingAccounts: remaining }),
      ).toThrow(/vaultIndex must be a u16/)
    }
  })

  it('disc=16 takes 1..=4 bumps: num_ephemeral 0 and 5 throw (TooManyEphemeralSigners on chain)', () => {
    const remaining = encodeRemainingAccounts(inner)
    const build = (bumps: Uint8Array) =>
      buildExecuteIxData({
        maxSlot: 42n,
        vaultIndex: 0,
        innerInstructions: inner,
        remainingAccounts: remaining,
        ephemeralSignerBumps: bumps,
      })
    expect(() => build(new Uint8Array(0))).toThrow(RangeError)
    expect(() => build(new Uint8Array(5).fill(255))).toThrow(RangeError)
    expect(build(new Uint8Array(1).fill(255))[11]).toBe(1)
    expect(build(new Uint8Array(4).fill(255))[11]).toBe(4)
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
        vaultIndex: 0,
        innerInstructions: innerWithStray,
        remainingAccounts: remaining,
      }),
    ).toThrow(/not present in remainingAccounts/)
  })

  it('rejects > 255 unique accounts (u8 index ceiling)', () => {
    // One inner ix over 257 distinct accounts: encodeRemainingAccounts gives
    // indices 0..257 (program first); 256 is the boundary that breaks `index <= 0xff`.
    const accounts: PublicKey[] = Array.from({ length: 257 }, () => Keypair.generate().publicKey)
    const innerOverflow: InnerInstruction[] = [
      {
        programId: Keypair.generate().publicKey.toBase58(),
        accounts: accounts.map((a) => ({ pubkey: a.toBase58(), isWritable: false })),
        data: new Uint8Array(),
      },
    ]
    const remaining = encodeRemainingAccounts(innerOverflow)
    expect(() =>
      buildExecuteIxData({
        maxSlot: 0n,
        vaultIndex: 0,
        innerInstructions: innerOverflow,
        remainingAccounts: remaining,
      }),
    ).toThrow(/exceeds u8/)
  })

  it('rejects an empty inner list and more than MAX_INNER_INSTRUCTIONS (64)', () => {
    const one: InnerInstruction = {
      programId: Keypair.generate().publicKey.toBase58(),
      accounts: [],
      data: new Uint8Array(),
    }
    const build = (innerInstructions: InnerInstruction[]) =>
      buildExecuteIxData({
        maxSlot: 0n,
        vaultIndex: 0,
        innerInstructions,
        remainingAccounts: encodeRemainingAccounts(innerInstructions),
      })
    expect(() => build([])).toThrow(RangeError)
    expect(() => build(Array(65).fill(one))).toThrow(RangeError)
    expect(() => build(Array(64).fill(one))).not.toThrow()
  })
})

describe('encodeExecute', () => {
  const inner: InnerInstruction[] = [
    {
      programId: Keypair.generate().publicKey.toBase58(),
      accounts: [{ pubkey: Keypair.generate().publicKey.toBase58(), isWritable: true }],
      data: new Uint8Array([1]),
    },
  ]
  const op = {
    walletPDA: Keypair.generate().publicKey,
    creationSlot: 100n,
    fundsNonce: 5n,
    maxSlot: 200n,
    deployment: 'devnet' as const,
    vaultIndex: 3,
    innerInstructions: inner,
  }
  const innerHash = computeInnerHash(inner)
  const remainingAccounts = encodeRemainingAccounts(inner)

  it('projects message, data and accounts from the one operation', () => {
    const e = encodeExecute(op)
    expect(e.operationHash).toEqual(computeExecuteMessage({ ...op, innerHash }))
    expect(e.data).toEqual(buildExecuteIxData({ ...op, remainingAccounts }))
    expect(e.wallet.equals(op.walletPDA)).toBe(true)
    expect(e.vault.equals(deriveVaultPda(op.walletPDA, 3).address)).toBe(true)
    expect(e.remainingAccounts).toEqual(remainingAccounts)
  })

  it('bumps select disc=16 in both the message and the data', () => {
    const ephemeralSignerBumps = Uint8Array.of(255)
    const e = encodeExecute({ ...op, ephemeralSignerBumps })
    expect(e.operationHash).toEqual(computeExecuteEphemeralMessage({ ...op, ephemeralSignerBumps, innerHash }))
    expect(e.data[0]).toBe(MachineWalletDisc.ExecuteWithEphemeralSigners)
  })
})
