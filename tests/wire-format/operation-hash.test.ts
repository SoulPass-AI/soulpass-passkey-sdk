// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import {
  computeExecuteMessageV0,
  computeExecuteMessageV1,
  EXECUTE_MESSAGE_DOMAIN_V0,
  EXECUTE_MESSAGE_DOMAIN_V1,
} from '../../src/wire-format/operation-hash'

const walletPDA = Keypair.generate().publicKey

const VALID_INNER_HASH = new Uint8Array(32).fill(0xaa)

describe('computeExecuteMessageV0', () => {
  it('produces a 32-byte hash and is deterministic', () => {
    const a = computeExecuteMessageV0({
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      innerHash: VALID_INNER_HASH,
    })
    const b = computeExecuteMessageV0({
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      innerHash: VALID_INNER_HASH,
    })
    expect(a.length).toBe(32)
    expect(a).toEqual(b)
  })

  it('rotates on every input field — avalanche guard', () => {
    const base = { walletPDA, creationSlot: 100n, nonce: 5n, maxSlot: 200n, innerHash: VALID_INNER_HASH }
    const a = computeExecuteMessageV0(base)
    expect(computeExecuteMessageV0({ ...base, creationSlot: 101n })).not.toEqual(a)
    expect(computeExecuteMessageV0({ ...base, nonce: 6n })).not.toEqual(a)
    expect(computeExecuteMessageV0({ ...base, maxSlot: 201n })).not.toEqual(a)
    const otherInner = new Uint8Array(32).fill(0xbb)
    expect(computeExecuteMessageV0({ ...base, innerHash: otherInner })).not.toEqual(a)
    const otherWallet = Keypair.generate().publicKey
    expect(computeExecuteMessageV0({ ...base, walletPDA: otherWallet })).not.toEqual(a)
  })

  it('rejects innerHash != 32 bytes — wrong length is always a wrong hash', () => {
    expect(() =>
      computeExecuteMessageV0({
        walletPDA,
        creationSlot: 0n,
        nonce: 0n,
        maxSlot: 0n,
        innerHash: new Uint8Array(31),
      }),
    ).toThrow(/32 bytes/)
  })

  it('domain separator string is exactly the on-chain tag', () => {
    expect(new TextDecoder().decode(EXECUTE_MESSAGE_DOMAIN_V0)).toBe(
      'machine_wallet_execute_v0',
    )
  })
})

describe('computeExecuteMessageV1', () => {
  it('produces a 32-byte hash and binds bumps into the digest', () => {
    const a = computeExecuteMessageV1({
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      ephemeralSignerBumps: Uint8Array.of(255),
      innerHash: VALID_INNER_HASH,
    })
    const b = computeExecuteMessageV1({
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      ephemeralSignerBumps: Uint8Array.of(254),
      innerHash: VALID_INNER_HASH,
    })
    expect(a.length).toBe(32)
    expect(a).not.toEqual(b)
  })

  it('v0 and v1 with otherwise-identical inputs produce different hashes', () => {
    // Domain separator collision would let a v0-signed challenge replay
    // against a v1 handler — and vice versa. The whole point of having
    // two tags is to make that impossible.
    const v0 = computeExecuteMessageV0({
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      innerHash: VALID_INNER_HASH,
    })
    const v1 = computeExecuteMessageV1({
      walletPDA,
      creationSlot: 100n,
      nonce: 5n,
      maxSlot: 200n,
      ephemeralSignerBumps: new Uint8Array(),
      innerHash: VALID_INNER_HASH,
    })
    expect(v0).not.toEqual(v1)
  })

  it('length-prefixes bumps — empty and single-zero must differ', () => {
    const empty = computeExecuteMessageV1({
      walletPDA,
      creationSlot: 0n,
      nonce: 0n,
      maxSlot: 0n,
      ephemeralSignerBumps: new Uint8Array(),
      innerHash: VALID_INNER_HASH,
    })
    const zero = computeExecuteMessageV1({
      walletPDA,
      creationSlot: 0n,
      nonce: 0n,
      maxSlot: 0n,
      ephemeralSignerBumps: Uint8Array.of(0),
      innerHash: VALID_INNER_HASH,
    })
    expect(empty).not.toEqual(zero)
  })

  it('rejects > 255 bumps — u8 length prefix invariant', () => {
    expect(() =>
      computeExecuteMessageV1({
        walletPDA,
        creationSlot: 0n,
        nonce: 0n,
        maxSlot: 0n,
        ephemeralSignerBumps: new Uint8Array(256),
        innerHash: VALID_INNER_HASH,
      }),
    ).toThrow(/u8/)
  })

  it('rejects innerHash != 32 bytes', () => {
    expect(() =>
      computeExecuteMessageV1({
        walletPDA,
        creationSlot: 0n,
        nonce: 0n,
        maxSlot: 0n,
        ephemeralSignerBumps: new Uint8Array(),
        innerHash: new Uint8Array(33),
      }),
    ).toThrow(/32 bytes/)
  })

  it('domain separator string is exactly the on-chain tag', () => {
    expect(new TextDecoder().decode(EXECUTE_MESSAGE_DOMAIN_V1)).toBe(
      'machine_wallet_execute_v1',
    )
  })
})
