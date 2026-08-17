import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils'
import { compressP256, derToRawEcdsaSignature, isOnP256Curve, bytesToBigIntBE } from '../src/p256'

/**
 * TS half of the cross-language P-256 compression contract. The vectors here
 * are self-contained — hand-synced from `soulpass-swift-sdk/Tests/Fixtures/`,
 * the same file the Swift suite reads
 * (Tests/SoulPassKitTests/P256CompressionGoldenVectorsTests.swift) — and
 * assert `compressP256` agrees with it byte-for-byte.
 *
 * soulpass-ai and soulpass-swift-sdk each implement WebAuthn P-256 (x, y) →
 * 33-byte compressed point independently (TS cannot call Swift, and vice
 * versa). Neither side's own self-consistency tests would catch the two
 * drifting apart — only a shared fixture, read by both, does. A drift here
 * means an authority gets registered on-chain that nobody holds the matching
 * private key for.
 */

interface ValidVector {
  name: string
  x: string
  y: string
  compressed: string
  xy: string
}

interface InvalidVector {
  name: string
  x: string
  y: string
  reason: string
}

interface Fixture {
  valid: ValidVector[]
  invalidShape: InvalidVector[]
  invalidCurve: InvalidVector[]
}

const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/p256-compression-vectors.json')

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

describe('P-256 compression golden vectors (shared with soulpass-swift-sdk)', () => {
  /** Every vector that must be rejected, tagged with why it is invalid. */
  const rejected = [
    ...fixture.invalidShape.map((v) => ['invalidShape', v] as const),
    ...fixture.invalidCurve.map((v) => ['invalidCurve', v] as const),
  ]

  it('fixture is non-empty in all three categories', () => {
    expect(fixture.valid.length).toBeGreaterThan(0)
    expect(fixture.invalidShape.length).toBeGreaterThan(0)
    expect(fixture.invalidCurve.length).toBeGreaterThan(0)
  })

  describe('compressP256', () => {
    for (const vector of fixture.valid) {
      it(`compresses '${vector.name}' to the expected 33-byte point`, () => {
        const compressed = compressP256(vector.x, vector.y)
        expect(bytesToHex(compressed)).toBe(vector.compressed)
      })
    }

    for (const [category, vector] of rejected) {
      it(`rejects ${category} '${vector.name}' (${vector.reason})`, () => {
        expect(() => compressP256(vector.x, vector.y)).toThrow()
      })
    }
  })
})

/**
 * Unit tests for DER → raw r||s conversion used in the MachineWallet signing
 * path. The on-chain webauthn.rs verifier rejects anything other than
 * canonical 64-byte low-s signatures, so this module must never emit
 * malformed output from valid authenticator signatures, and must reject
 * obviously bad inputs rather than silently pad them to 64 bytes.
 */

const P256_N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')

function bigIntTo32Bytes(x: bigint): Uint8Array {
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

/** Build a DER signature with the given r and s INTEGER bodies. */
function encodeDer(r: Uint8Array, s: Uint8Array): Uint8Array {
  const inner = new Uint8Array(2 + r.length + 2 + s.length)
  inner[0] = 0x02
  inner[1] = r.length
  inner.set(r, 2)
  inner[2 + r.length] = 0x02
  inner[3 + r.length] = s.length
  inner.set(s, 4 + r.length)
  const out = new Uint8Array(2 + inner.length)
  out[0] = 0x30
  out[1] = inner.length
  out.set(inner, 2)
  return out
}

describe('derToRawEcdsaSignature — happy paths', () => {
  it('32-byte r and 32-byte s pass through with correct layout', () => {
    const r = new Uint8Array(32).fill(0x11)
    const s = new Uint8Array(32).fill(0x22) // below n/2 → no normalization
    const raw = derToRawEcdsaSignature(encodeDer(r, s))
    expect(raw.length).toBe(64)
    expect(raw.slice(0, 32)).toEqual(r)
    expect(raw.slice(32, 64)).toEqual(s)
  })

  it('strips DER sign-bit leading 0x00 (33-byte r when high bit set)', () => {
    // r high bit set → DER encodes with 0x00 prefix → 33 bytes
    const rBody = new Uint8Array(33)
    rBody[0] = 0x00
    rBody.set(new Uint8Array(32).fill(0x80), 1)
    const s = new Uint8Array(32).fill(0x11)
    const raw = derToRawEcdsaSignature(encodeDer(rBody, s))
    // Leading 0x00 removed → first 32 bytes are the real r (all 0x80)
    expect(raw.slice(0, 32)).toEqual(new Uint8Array(32).fill(0x80))
    expect(raw.slice(32, 64)).toEqual(s)
  })

  it('left-pads short r (high bytes zero) to 32 bytes', () => {
    // r = 0x01 (1 byte) → raw r must be 31 zero bytes + 0x01
    const r = new Uint8Array([0x01])
    const s = new Uint8Array(32).fill(0x11)
    const raw = derToRawEcdsaSignature(encodeDer(r, s))
    const expectedR = new Uint8Array(32)
    expectedR[31] = 0x01
    expect(raw.slice(0, 32)).toEqual(expectedR)
  })
})

describe('derToRawEcdsaSignature — low-s normalization', () => {
  it('normalizes high-s (s > n/2) to n - s', () => {
    const r = new Uint8Array(32).fill(0x11)
    // s = n - 1 is the maximum high-s value → should become 1
    const highS = P256_N - 1n
    const sBytes = bigIntTo32Bytes(highS)
    // Prefix with 0x00 because top bit is set
    const sDer = new Uint8Array(33)
    sDer[0] = 0x00
    sDer.set(sBytes, 1)

    const raw = derToRawEcdsaSignature(encodeDer(r, sDer))
    const normalizedS = bytesToBigIntBE(raw.slice(32, 64))
    expect(normalizedS).toBe(1n)
  })

  it('leaves low-s (s ≤ n/2) untouched', () => {
    const r = new Uint8Array(32).fill(0x11)
    const lowS = (P256_N >> 1n) - 1n
    const s = bigIntTo32Bytes(lowS)
    const raw = derToRawEcdsaSignature(encodeDer(r, s))
    expect(bytesToBigIntBE(raw.slice(32, 64))).toBe(lowS)
  })
})

describe('derToRawEcdsaSignature — rejects malformed inputs', () => {
  it('rejects non-SEQUENCE tag', () => {
    const bad = new Uint8Array([0x31, 0x44, 0x02, 0x20, ...new Array(32).fill(1), 0x02, 0x20, ...new Array(32).fill(1)])
    expect(() => derToRawEcdsaSignature(bad)).toThrow(/SEQUENCE/)
  })

  it('rejects length below minimum', () => {
    expect(() => derToRawEcdsaSignature(new Uint8Array([0x30, 0x00]))).toThrow(/length/)
  })

  it('rejects length above 72 bytes', () => {
    const huge = new Uint8Array(100)
    huge[0] = 0x30
    huge[1] = 98
    expect(() => derToRawEcdsaSignature(huge)).toThrow(/length/)
  })

  it('rejects outer length mismatch', () => {
    const r = new Uint8Array(32).fill(1)
    const s = new Uint8Array(32).fill(1)
    const der = encodeDer(r, s)
    der[1] = der[1] + 1 // claim one more byte than exists
    expect(() => derToRawEcdsaSignature(der)).toThrow(/outer length/)
  })

  it('rejects r = 0', () => {
    const r = new Uint8Array([0x00])
    const s = new Uint8Array(32).fill(1)
    expect(() => derToRawEcdsaSignature(encodeDer(r, s))).toThrow(/out of range/)
  })

  it('rejects s = 0', () => {
    const r = new Uint8Array(32).fill(1)
    const s = new Uint8Array([0x00])
    expect(() => derToRawEcdsaSignature(encodeDer(r, s))).toThrow(/out of range/)
  })

  it('rejects r ≥ n', () => {
    const r = bigIntTo32Bytes(P256_N) // exactly n (invalid)
    const rDer = new Uint8Array(33) // needs 0x00 prefix since top bit set
    rDer[0] = 0x00
    rDer.set(r, 1)
    const s = new Uint8Array(32).fill(1)
    expect(() => derToRawEcdsaSignature(encodeDer(rDer, s))).toThrow(/out of range/)
  })

  it('rejects missing r INTEGER tag', () => {
    const der = new Uint8Array([0x30, 0x44, 0x03, 0x20, ...new Array(32).fill(1), 0x02, 0x20, ...new Array(32).fill(1)])
    expect(() => derToRawEcdsaSignature(der)).toThrow(/r INTEGER/)
  })

  it('rejects rLen = 0', () => {
    const der = new Uint8Array([0x30, 0x24, 0x02, 0x00, 0x02, 0x20, ...new Array(32).fill(1)])
    expect(() => derToRawEcdsaSignature(der)).toThrow(/r length/)
  })
})

describe('isOnP256Curve / bytesToBigIntBE', () => {
  it('accepts the P-256 generator point', () => {
    const gx = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n
    const gy = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n
    expect(isOnP256Curve(gx, gy)).toBe(true)
  })
  it('converts big-endian bytes', () => {
    expect(bytesToBigIntBE(new Uint8Array([0x01, 0x00]))).toBe(256n)
  })
})
