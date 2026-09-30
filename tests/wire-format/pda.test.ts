// @vitest-environment node
// Forced to node: jsdom breaks PublicKey PDA derivation (see ephemeral-signers.test.ts).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { keccak_256 } from '@noble/hashes/sha3'
import { hexToBytes } from '@noble/hashes/utils'
import { deriveWalletPda, deriveSessionPda } from '../../src/wire-format/pda'
import { SESSION_SEED, WALLET_SEED } from '../../src/wire-format/constants'
import { MACHINE_WALLET_PROGRAM_ADDRESS } from '../../src/protocol'

const here = dirname(fileURLToPath(import.meta.url))
const layoutKat = JSON.parse(
  readFileSync(join(here, '../fixtures/layout_kat.json'), 'utf8'),
) as { vectors: { name: string; fields: { name: string; hex: string }[] }[] }

const PROGRAM_ID = new PublicKey(MACHINE_WALLET_PROGRAM_ADDRESS)
const enc = new TextEncoder()

// A fixed passkey authority: the 33-byte compressed P-256 generator (the KAT root's pubkey).
const AUTHORITY33 = hexToBytes(
  '036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',
)

function katField(vector: string, field: string): Uint8Array {
  const v = layoutKat.vectors.find((x) => x.name === vector)
  const f = v?.fields.find((x) => x.name === field)
  if (!f) throw new Error(`missing ${vector}.${field}`)
  return hexToBytes(f.hex)
}

describe('deriveWalletPda', () => {
  it('KAT wallet_id is a valid [WALLET_SEED, id] seed set', () => {
    const walletId = katField('wallet_2auth_passkey_root_pending_recovery', 'wallet_id')
    const bump = katField('wallet_2auth_passkey_root_pending_recovery', 'bump')
    expect(walletId).toHaveLength(32)
    expect(bump).toHaveLength(1)
    // The KAT id and bump are synthetic layout bytes, not a real derivation:
    // derive the canonical bump for the same id and prove it round-trips.
    const [address, canonical] = PublicKey.findProgramAddressSync(
      [enc.encode(WALLET_SEED), walletId],
      PROGRAM_ID,
    )
    expect(
      PublicKey.createProgramAddressSync(
        [enc.encode(WALLET_SEED), walletId, new Uint8Array([canonical])],
        PROGRAM_ID,
      ).equals(address),
    ).toBe(true)
  })

  it('matches findProgramAddressSync over [WALLET_SEED, keccak256(authority33)]', () => {
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [enc.encode(WALLET_SEED), keccak_256(AUTHORITY33)],
      PROGRAM_ID,
    )
    const { address, bump } = deriveWalletPda(AUTHORITY33)
    expect(address.equals(expected)).toBe(true)
    expect(bump).toBe(expectedBump)
    // Canonical bump round-trips through createProgramAddressSync.
    expect(
      PublicKey.createProgramAddressSync(
        [enc.encode(WALLET_SEED), keccak_256(AUTHORITY33), new Uint8Array([bump])],
        PROGRAM_ID,
      ).equals(address),
    ).toBe(true)
  })

  it('honours an explicit programId', () => {
    const other = new PublicKey(new Uint8Array(32).fill(7))
    const [expected] = PublicKey.findProgramAddressSync(
      [enc.encode(WALLET_SEED), keccak_256(AUTHORITY33)],
      other,
    )
    expect(deriveWalletPda(AUTHORITY33, other).address.equals(expected)).toBe(true)
  })

  it('rejects an authority that is not 33 bytes', () => {
    expect(() => deriveWalletPda(new Uint8Array(32))).toThrow(RangeError)
  })
})

describe('deriveSessionPda', () => {
  const sessionAuthority = new Uint8Array(32).fill(0x42)

  it('matches findProgramAddressSync over [SESSION_SEED, wallet, sessionAuthority]', () => {
    const wallet = deriveWalletPda(AUTHORITY33).address
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [enc.encode(SESSION_SEED), wallet.toBytes(), sessionAuthority],
      PROGRAM_ID,
    )
    const { address, bump } = deriveSessionPda(wallet, sessionAuthority)
    expect(address.equals(expected)).toBe(true)
    expect(bump).toBe(expectedBump)
  })

  it('rejects a session authority that is not 32 bytes', () => {
    const wallet = deriveWalletPda(AUTHORITY33).address
    expect(() => deriveSessionPda(wallet, new Uint8Array(33))).toThrow(RangeError)
  })
})
