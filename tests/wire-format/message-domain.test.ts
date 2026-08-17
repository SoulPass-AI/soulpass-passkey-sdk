import { describe, expect, it } from 'vitest';

import {
  MESSAGE_DOMAIN,
  domainSeparate,
} from '../../src/wire-format/message-domain';
import { u32LE } from '../../src/wire-format/_bytes';

// ============================================================================
// MESSAGE_DOMAIN — bit-level constant, any drift breaks every dApp verifier
// ============================================================================

describe('MESSAGE_DOMAIN', () => {
  it('is byte-for-byte identical to the hardcoded ASCII preimage', () => {
    // Hardcoded expected bytes — this test intentionally duplicates the
    // constant verbatim so that any "cleanup" of message-domain.ts that
    // accidentally shifts a byte gets caught here.
    const expected = Uint8Array.of(
      0x19, // \x19
      0x53, // S
      0x6f, // o
      0x75, // u
      0x6c, // l
      0x50, // P
      0x61, // a
      0x73, // s
      0x73, // s
      0x20, // (space)
      0x53, // S
      0x69, // i
      0x67, // g
      0x6e, // n
      0x65, // e
      0x64, // d
      0x20, // (space)
      0x4d, // M
      0x65, // e
      0x73, // s
      0x73, // s
      0x61, // a
      0x67, // g
      0x65, // e
      0x3a, // :
      0x0a, // \n
    );
    expect(Array.from(MESSAGE_DOMAIN)).toEqual(Array.from(expected));
  });
});

// ============================================================================
// domainSeparate — length-prefixed preimage, collision-resistant
// ============================================================================

describe('domainSeparate', () => {
  it('produces total length = 26 + 4 + message.length', () => {
    const msg = new TextEncoder().encode('hello');
    const out = domainSeparate(msg);
    expect(out.length).toBe(26 + 4 + 5);
  });

  it('writes MESSAGE_DOMAIN into the first 26 bytes', () => {
    const msg = new TextEncoder().encode('anything');
    const out = domainSeparate(msg);
    expect(Array.from(out.subarray(0, 26))).toEqual(Array.from(MESSAGE_DOMAIN));
  });

  it('encodes message.length as u32 little-endian at offset 26', () => {
    // We use 0x223344 instead of 0x11223344 to avoid allocating 287 MB in
    // the test worker. This still exercises three distinct little-endian
    // byte positions and asserts the little-endian order.
    const len = 0x00223344; // ~2.2 MB — safe for worker memory
    const msg = new Uint8Array(len);
    const out = domainSeparate(msg);
    expect(out[26]).toBe(0x44);
    expect(out[27]).toBe(0x33);
    expect(out[28]).toBe(0x22);
    expect(out[29]).toBe(0x00);
  });

  it('appends the message verbatim after the length prefix', () => {
    const msg = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const out = domainSeparate(msg);
    expect(Array.from(out.subarray(30))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('handles the empty message: domain || 0x00000000 || (nothing)', () => {
    const out = domainSeparate(new Uint8Array(0));
    expect(out.length).toBe(26 + 4);
    expect(Array.from(out.subarray(0, 26))).toEqual(Array.from(MESSAGE_DOMAIN));
    expect(out[26]).toBe(0x00);
    expect(out[27]).toBe(0x00);
    expect(out[28]).toBe(0x00);
    expect(out[29]).toBe(0x00);
  });

  it('length-prefix aliasing at 2^32 is unreachable: u32LE throws instead of wrapping', () => {
    // We cannot allocate a 4 GB Uint8Array to exercise the real
    // `domainSeparate` at length = 2^32, so pin the guard it relies on:
    // the u32LE length prefix rejects out-of-range values rather than
    // encoding 2^32 + 5 identically to 5.
    expect(() => u32LE(2 ** 32)).toThrow(RangeError);
    expect(() => u32LE(2 ** 32 + 5)).toThrow(RangeError);
  });

  it('is deterministic: two calls on equal input produce byte-equal output', () => {
    const msg = Uint8Array.of(1, 2, 3, 4, 5);
    const a = domainSeparate(msg);
    const b = domainSeparate(msg);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('collision-resistance: (1,2,3) vs (1,2,3,0) produce different preimages', () => {
    const a = domainSeparate(Uint8Array.of(1, 2, 3));
    const b = domainSeparate(Uint8Array.of(1, 2, 3, 0));
    expect(Array.from(a)).not.toEqual(Array.from(b));
    // Specifically, the length prefix differs (3 vs 4).
    expect(a[26]).toBe(0x03);
    expect(b[26]).toBe(0x04);
  });

  it('collision-resistance: domainSeparate(A||B) != domainSeparate(A) and != domainSeparate(B)', () => {
    const A = Uint8Array.of(0xaa, 0xbb);
    const B = Uint8Array.of(0xcc, 0xdd);
    const AB = Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd);
    const dA = domainSeparate(A);
    const dB = domainSeparate(B);
    const dAB = domainSeparate(AB);
    expect(Array.from(dAB)).not.toEqual(Array.from(dA));
    expect(Array.from(dAB)).not.toEqual(Array.from(dB));
  });
});
