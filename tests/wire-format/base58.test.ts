// @vitest-environment node
//
// The decoder's correctness bar is exact parity with web3.js `PublicKey` —
// inner_hash feeds the WebAuthn challenge, so a one-byte disagreement is a
// silent MessageMismatch at submit time. Random keypairs + the all-zero system
// program cover both the numeric path and the leading-`1` (zero byte) path.
import { describe, it, expect } from 'vitest'
import { Keypair, PublicKey } from '@solana/web3.js'
import { base58ToPubkeyBytes } from '../../src/wire-format/base58'

describe('base58ToPubkeyBytes', () => {
  it('matches PublicKey.toBytes() for random keypairs', () => {
    for (let i = 0; i < 32; i++) {
      const key = Keypair.generate().publicKey
      expect(base58ToPubkeyBytes(key.toBase58())).toEqual(key.toBytes())
    }
  })

  it('decodes the system program (all leading 1s → all zero bytes)', () => {
    const systemProgram = '11111111111111111111111111111111'
    expect(base58ToPubkeyBytes(systemProgram)).toEqual(
      new PublicKey(systemProgram).toBytes(),
    )
  })

  it('rejects characters outside the base58 alphabet', () => {
    for (const bad of ['0', 'O', 'I', 'l']) {
      const value = `${bad}${Keypair.generate().publicKey.toBase58().slice(1)}`
      expect(() => base58ToPubkeyBytes(value)).toThrow(RangeError)
    }
  })

  it('rejects values that do not decode to exactly 32 bytes', () => {
    expect(() => base58ToPubkeyBytes('')).toThrow(RangeError)
    expect(() => base58ToPubkeyBytes('abc')).toThrow(RangeError)
    // A valid encoding with an extra leading '1' claims 33 decoded bytes.
    expect(() =>
      base58ToPubkeyBytes(`1${Keypair.generate().publicKey.toBase58()}`),
    ).toThrow(RangeError)
    // 45 chars exceeds the 44-char ceiling for 32-byte values.
    expect(() => base58ToPubkeyBytes('2'.repeat(45))).toThrow(RangeError)
  })
})
