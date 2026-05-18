// @vitest-environment node
//
// Forced to node because jsdom's globalThis doesn't expose the BigInt math
// `PublicKey.findProgramAddressSync` uses for the Ed25519 on-curve check;
// every PDA derivation in jsdom fails with "Unable to find a viable program
// address nonce" even for inputs that work natively. Other tests stay on
// jsdom (default in vitest.config.ts) — this is a per-file override.
import { describe, it, expect } from 'vitest'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  deriveEphemeralSigners,
  EPHEMERAL_SIGNER_SEED_PREFIX,
  MAX_EPHEMERAL_SIGNERS,
} from '../src/ephemeral-signers'

// Canonical machine-wallet program ID (mirrors lib.rs `declare_id!`). Embedded
// directly so the test never depends on a constants module that might drift.
const MACHINE_WALLET_PROGRAM_ID = new PublicKey(
  '7VD7mx5bYgmSJY7D1etvADEdDXijdp3UMz79M53vTdMo',
)

describe('deriveEphemeralSigners', () => {
  const walletAddress = Keypair.generate().publicKey

  it('returns `count` deterministic PDAs for a given (walletAddress, nonce)', () => {
    const out1 = deriveEphemeralSigners({
      walletAddress,
      walletNonce: 42n,
      count: 2,
      programId: MACHINE_WALLET_PROGRAM_ID,
    })
    const out2 = deriveEphemeralSigners({
      walletAddress,
      walletNonce: 42n,
      count: 2,
      programId: MACHINE_WALLET_PROGRAM_ID,
    })

    expect(out1).toHaveLength(2)
    expect(out1[0]!.pubkey.equals(out2[0]!.pubkey)).toBe(true)
    expect(out1[1]!.pubkey.equals(out2[1]!.pubkey)).toBe(true)
    expect(out1[0]!.index).toBe(0)
    expect(out1[1]!.index).toBe(1)
    // Distinct slot indices must produce distinct PDAs.
    expect(out1[0]!.pubkey.equals(out1[1]!.pubkey)).toBe(false)
  })

  it('rotates PDAs when nonce changes — replay protection', () => {
    // Same wallet, same slot, different nonce → different PDA. This is the
    // property the program relies on to refuse a relayed re-broadcast.
    const a = deriveEphemeralSigners({
      walletAddress,
      walletNonce: 100n,
      count: 1,
      programId: MACHINE_WALLET_PROGRAM_ID,
    })
    const b = deriveEphemeralSigners({
      walletAddress,
      walletNonce: 101n,
      count: 1,
      programId: MACHINE_WALLET_PROGRAM_ID,
    })
    expect(a[0]!.pubkey.equals(b[0]!.pubkey)).toBe(false)
  })

  it('uses the program id — same seeds under a different program produce a different PDA', () => {
    const otherProgram = Keypair.generate().publicKey
    const a = deriveEphemeralSigners({
      walletAddress,
      walletNonce: 5n,
      count: 1,
      programId: MACHINE_WALLET_PROGRAM_ID,
    })
    const b = deriveEphemeralSigners({
      walletAddress,
      walletNonce: 5n,
      count: 1,
      programId: otherProgram,
    })
    expect(a[0]!.pubkey.equals(b[0]!.pubkey)).toBe(false)
  })

  it('matches the on-chain seeds layout — derivable bump-by-bump', () => {
    // Cross-check against a manual PublicKey.findProgramAddressSync using the
    // exported seed prefix. Catches regressions where seed order or types
    // diverge from the on-chain processor.
    const nonce = 7n
    const count = 3
    const out = deriveEphemeralSigners({
      walletAddress,
      walletNonce: nonce,
      count,
      programId: MACHINE_WALLET_PROGRAM_ID,
    })

    const nonceBytes = new Uint8Array(8)
    let v = nonce
    for (let i = 0; i < 8; i++) {
      nonceBytes[i] = Number(v & 0xffn)
      v >>= 8n
    }

    for (let i = 0; i < count; i++) {
      const [expected, expectedBump] = PublicKey.findProgramAddressSync(
        [
          EPHEMERAL_SIGNER_SEED_PREFIX,
          walletAddress.toBytes(),
          nonceBytes,
          new Uint8Array([i]),
        ],
        MACHINE_WALLET_PROGRAM_ID,
      )
      expect(out[i]!.pubkey.equals(expected)).toBe(true)
      expect(out[i]!.bump).toBe(expectedBump)
    }
  })

  it('rejects count outside [1, MAX_EPHEMERAL_SIGNERS]', () => {
    const baseArgs = {
      walletAddress,
      walletNonce: 0n,
      programId: MACHINE_WALLET_PROGRAM_ID,
    }
    expect(() => deriveEphemeralSigners({ ...baseArgs, count: 0 })).toThrow(
      RangeError,
    )
    expect(() =>
      deriveEphemeralSigners({
        ...baseArgs,
        count: MAX_EPHEMERAL_SIGNERS + 1,
      }),
    ).toThrow(RangeError)
  })

  it('rejects nonce outside u64 range', () => {
    expect(() =>
      deriveEphemeralSigners({
        walletAddress,
        walletNonce: -1n,
        count: 1,
        programId: MACHINE_WALLET_PROGRAM_ID,
      }),
    ).toThrow(RangeError)
    expect(() =>
      deriveEphemeralSigners({
        walletAddress,
        walletNonce: 1n << 64n,
        count: 1,
        programId: MACHINE_WALLET_PROGRAM_ID,
      }),
    ).toThrow(RangeError)
  })
})
