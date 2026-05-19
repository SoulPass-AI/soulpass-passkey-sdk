// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { buildSecp256r1PrecompileIxData } from '../../src/wire-format/secp256r1'

const SIG = new Uint8Array(64).fill(0x11)
const PK = new Uint8Array(33).fill(0x02)
const MSG = new Uint8Array([0xaa, 0xbb, 0xcc])

describe('buildSecp256r1PrecompileIxData', () => {
  it('produces the exact SIP-mandated layout', () => {
    const data = buildSecp256r1PrecompileIxData({ signature: SIG, publicKey: PK, message: MSG })

    // Header
    expect(data[0]).toBe(1) // num_signatures
    expect(data[1]).toBe(0) // padding
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    expect(view.getUint16(2, true)).toBe(16)       // sig_offset
    expect(view.getUint16(4, true)).toBe(0xffff)   // sig_ix (same ix)
    expect(view.getUint16(6, true)).toBe(80)       // pubkey_offset
    expect(view.getUint16(8, true)).toBe(0xffff)
    expect(view.getUint16(10, true)).toBe(113)     // msg_offset
    expect(view.getUint16(12, true)).toBe(MSG.length)
    expect(view.getUint16(14, true)).toBe(0xffff)

    // Payload
    expect(data.slice(16, 80)).toEqual(SIG)
    expect(data.slice(80, 113)).toEqual(PK)
    expect(data.slice(113)).toEqual(MSG)
    expect(data.length).toBe(16 + 64 + 33 + MSG.length)
  })

  it('rejects wrong-size signature / publicKey / empty message', () => {
    expect(() =>
      buildSecp256r1PrecompileIxData({
        signature: new Uint8Array(63),
        publicKey: PK,
        message: MSG,
      }),
    ).toThrow(/64 bytes/)
    expect(() =>
      buildSecp256r1PrecompileIxData({
        signature: SIG,
        publicKey: new Uint8Array(32),
        message: MSG,
      }),
    ).toThrow(/33 bytes/)
    expect(() =>
      buildSecp256r1PrecompileIxData({
        signature: SIG,
        publicKey: PK,
        message: new Uint8Array(),
      }),
    ).toThrow(/non-empty/)
  })

  it('handles a large WebAuthn-shaped message (authData + sha256(cdj))', () => {
    // Real WebAuthn: authData ~= 37 bytes + sha256(cdj) = 32 bytes → 69 bytes.
    const message = new Uint8Array(69)
    const data = buildSecp256r1PrecompileIxData({ signature: SIG, publicKey: PK, message })
    expect(data.length).toBe(16 + 64 + 33 + 69)
    const view = new DataView(data.buffer)
    expect(view.getUint16(12, true)).toBe(69)
  })
})
