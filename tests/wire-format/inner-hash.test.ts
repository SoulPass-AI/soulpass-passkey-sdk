// @vitest-environment node
//
// Forced to node because jsdom's globalThis doesn't expose the BigInt math
// `PublicKey.findProgramAddressSync` uses on this codepath (see
// ephemeral-signers.test.ts header). The same concern doesn't strictly apply
// to computeInnerHash, but staying on node keeps the suite uniformly fast
// and removes any latent jsdom typed-array confusion.
import { describe, it, expect } from 'vitest'
import { Keypair, PublicKey } from '@solana/web3.js'
import { keccak_256 } from '@noble/hashes/sha3'
import {
  computeInnerHash,
  FLAG_WRITABLE,
  FLAG_EPHEMERAL_SIGNER,
  type InnerInstruction,
} from '../../src/wire-format/inner-hash'

function u16(v: number): Uint8Array {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, v, true)
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

describe('computeInnerHash', () => {
  const programId = Keypair.generate().publicKey
  const accountA = Keypair.generate().publicKey
  const accountB = Keypair.generate().publicKey

  it('matches a hand-rolled keccak — single ix, single account, no flags', () => {
    const ix: InnerInstruction = {
      programId: programId.toBase58(),
      accounts: [{ pubkey: accountA.toBase58(), isWritable: false }],
      data: new Uint8Array([0xaa, 0xbb, 0xcc]),
    }

    // Hand-rolled mirror of the spec to catch any future refactor that
    // changes the field order. Two-keccak nesting is intentional — the chain
    // hashes each ix individually then hashes the concatenation.
    const ixDigest = keccak_256(
      concat([
        programId.toBytes(),
        u16(1),
        accountA.toBytes(),
        Uint8Array.of(0),
        u16(3),
        ix.data,
      ]),
    )
    const expected = keccak_256(ixDigest)

    expect(computeInnerHash([ix])).toEqual(expected)
  })

  it('writable / ephemeral_signer flags set the correct bits', () => {
    const ix: InnerInstruction = {
      programId: programId.toBase58(),
      accounts: [
        { pubkey: accountA.toBase58(), isWritable: true, isEphemeralSigner: false },
        { pubkey: accountB.toBase58(), isWritable: false, isEphemeralSigner: true },
      ],
      data: new Uint8Array(),
    }

    const ixDigest = keccak_256(
      concat([
        programId.toBytes(),
        u16(2),
        accountA.toBytes(),
        Uint8Array.of(FLAG_WRITABLE),
        accountB.toBytes(),
        Uint8Array.of(FLAG_EPHEMERAL_SIGNER),
        u16(0),
      ]),
    )
    const expected = keccak_256(ixDigest)

    expect(computeInnerHash([ix])).toEqual(expected)
  })

  it('rotates output when any byte of inner ixs changes (avalanche)', () => {
    const base: InnerInstruction = {
      programId: programId.toBase58(),
      accounts: [{ pubkey: accountA.toBase58(), isWritable: true }],
      data: new Uint8Array([0x01]),
    }
    const flipped: InnerInstruction = {
      ...base,
      data: new Uint8Array([0x02]),
    }
    expect(computeInnerHash([base])).not.toEqual(computeInnerHash([flipped]))
  })

  it('hashes ix order — swapping two ixs produces a different digest', () => {
    const ix1: InnerInstruction = {
      programId: programId.toBase58(),
      accounts: [{ pubkey: accountA.toBase58(), isWritable: false }],
      data: new Uint8Array([0x01]),
    }
    const ix2: InnerInstruction = {
      programId: programId.toBase58(),
      accounts: [{ pubkey: accountB.toBase58(), isWritable: false }],
      data: new Uint8Array([0x02]),
    }
    expect(computeInnerHash([ix1, ix2])).not.toEqual(
      computeInnerHash([ix2, ix1]),
    )
  })

  it('handles 0-account 0-data ixs', () => {
    const ix: InnerInstruction = {
      programId: programId.toBase58(),
      accounts: [],
      data: new Uint8Array(),
    }
    const ixDigest = keccak_256(concat([programId.toBytes(), u16(0), u16(0)]))
    expect(computeInnerHash([ix])).toEqual(keccak_256(ixDigest))
  })

  it('flag values pinned to spec (1 = writable, 2 = ephemeral)', () => {
    // Drift here moves the WebAuthn challenge and silently breaks every live
    // signature. Pin as data so a typo fails CI before users do.
    expect(FLAG_WRITABLE).toBe(0x01)
    expect(FLAG_EPHEMERAL_SIGNER).toBe(0x02)
  })

  it('uses the real pubkey bytes — different pubkeys → different digest', () => {
    const ix1: InnerInstruction = {
      programId: programId.toBase58(),
      accounts: [{ pubkey: accountA.toBase58(), isWritable: false }],
      data: new Uint8Array(),
    }
    const ix2: InnerInstruction = {
      ...ix1,
      accounts: [{ pubkey: accountB.toBase58(), isWritable: false }],
    }
    expect(computeInnerHash([ix1])).not.toEqual(computeInnerHash([ix2]))
  })
})
