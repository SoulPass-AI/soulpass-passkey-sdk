// @vitest-environment node
//
// Behavioural guards for the two Execute message hashes. Byte-exact agreement
// with the chain lives in signed-message-kat.test.ts; what this file adds is
// that every operand actually reaches the preimage, and that the guard rails
// (length checks, u8 prefix ceiling) hold.
import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import {
  computeExecuteMessage,
  computeExecuteEphemeralMessage,
  EXECUTE_TAG,
  EXECUTE_EPHEMERAL_TAG,
} from '../../src/wire-format/operation-hash'

const walletPDA = Keypair.generate().publicKey

const VALID_INNER_HASH = new Uint8Array(32).fill(0xaa)

// Every case pins a deployment explicitly. The domain is part of the signed
// preimage, so leaving it to a default would make these assertions depend on
// ambient configuration rather than on the code under test.
const DEPLOYMENT = 'devnet' as const

describe('computeExecuteMessage', () => {
  it('produces a 32-byte hash and is deterministic', () => {
    const args = {
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      innerHash: VALID_INNER_HASH,
      deployment: DEPLOYMENT,
    }
    const a = computeExecuteMessage(args)
    const b = computeExecuteMessage(args)
    expect(a.length).toBe(32)
    expect(a).toEqual(b)
  })

  it('rotates on every input field — avalanche guard', () => {
    const base = {
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      innerHash: VALID_INNER_HASH,
      deployment: DEPLOYMENT,
    }
    const a = computeExecuteMessage(base)
    expect(computeExecuteMessage({ ...base, creationSlot: 101n })).not.toEqual(a)
    expect(computeExecuteMessage({ ...base, nonce: 6n })).not.toEqual(a)
    expect(computeExecuteMessage({ ...base, maxSlot: 201n })).not.toEqual(a)
    const otherInner = new Uint8Array(32).fill(0xbb)
    expect(computeExecuteMessage({ ...base, innerHash: otherInner })).not.toEqual(a)
    const otherWallet = Keypair.generate().publicKey
    expect(computeExecuteMessage({ ...base, walletPDA: otherWallet })).not.toEqual(a)
    // The deployment domain is signed too — same operands, different chain.
    expect(computeExecuteMessage({ ...base, deployment: 'mainnet' })).not.toEqual(a)
  })

  it('rejects innerHash != 32 bytes — wrong length is always a wrong hash', () => {
    expect(() =>
      computeExecuteMessage({
        walletPDA,
        creationSlot: 0n,
        nonce: 0n,
        maxSlot: 0n,
        innerHash: new Uint8Array(31),
        deployment: DEPLOYMENT,
      }),
    ).toThrow(/32 bytes/)
  })

  it('instruction tag is exactly the on-chain tag', () => {
    expect(new TextDecoder().decode(EXECUTE_TAG)).toBe('machine_wallet_execute_v1')
  })
})

describe('computeExecuteEphemeralMessage', () => {
  it('produces a 32-byte hash and binds bumps into the digest', () => {
    const base = {
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      innerHash: VALID_INNER_HASH,
      deployment: DEPLOYMENT,
    }
    const a = computeExecuteEphemeralMessage({
      ...base,
      ephemeralSignerBumps: Uint8Array.of(255),
    })
    const b = computeExecuteEphemeralMessage({
      ...base,
      ephemeralSignerBumps: Uint8Array.of(254),
    })
    expect(a.length).toBe(32)
    expect(a).not.toEqual(b)
  })

  it('the two execute paths with identical operands produce different hashes', () => {
    // A shared tag would let a disc=1 challenge replay against the disc=16
    // handler — and vice versa. Having two tags is what makes that impossible.
    const plain = computeExecuteMessage({
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      innerHash: VALID_INNER_HASH,
      deployment: DEPLOYMENT,
    })
    const ephemeral = computeExecuteEphemeralMessage({
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      ephemeralSignerBumps: new Uint8Array(),
      innerHash: VALID_INNER_HASH,
      deployment: DEPLOYMENT,
    })
    expect(plain).not.toEqual(ephemeral)
  })

  it('length-prefixes bumps — empty and single-zero must differ', () => {
    const base = {
      walletPDA,
      creationSlot: 0n,
      nonce: 0n,
      maxSlot: 0n,
      innerHash: VALID_INNER_HASH,
      deployment: DEPLOYMENT,
    }
    const empty = computeExecuteEphemeralMessage({
      ...base,
      ephemeralSignerBumps: new Uint8Array(),
    })
    const zero = computeExecuteEphemeralMessage({
      ...base,
      ephemeralSignerBumps: Uint8Array.of(0),
    })
    expect(empty).not.toEqual(zero)
  })

  it('rejects > 255 bumps — u8 length prefix invariant', () => {
    expect(() =>
      computeExecuteEphemeralMessage({
        walletPDA,
        creationSlot: 0n,
        nonce: 0n,
        maxSlot: 0n,
        ephemeralSignerBumps: new Uint8Array(256),
        innerHash: VALID_INNER_HASH,
        deployment: DEPLOYMENT,
      }),
    ).toThrow(/u8/)
  })

  it('rejects innerHash != 32 bytes', () => {
    expect(() =>
      computeExecuteEphemeralMessage({
        walletPDA,
        creationSlot: 0n,
        nonce: 0n,
        maxSlot: 0n,
        ephemeralSignerBumps: new Uint8Array(),
        innerHash: new Uint8Array(33),
        deployment: DEPLOYMENT,
      }),
    ).toThrow(/32 bytes/)
  })

  it('instruction tag is the ephemeral operation, not Execute', () => {
    expect(new TextDecoder().decode(EXECUTE_EPHEMERAL_TAG)).toBe(
      'machine_wallet_execute_ephemeral_v2',
    )
    expect(EXECUTE_EPHEMERAL_TAG).not.toEqual(EXECUTE_TAG)
  })
})
