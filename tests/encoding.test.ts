import { describe, it, expect } from 'vitest';
import { base64urlNoPad } from '../src/encoding';

describe('base64urlNoPad', () => {
  it('is URL-safe and unpadded for known RFC 4648 §10 vectors', () => {
    expect(base64urlNoPad(new TextEncoder().encode(''))).toBe('');
    expect(base64urlNoPad(new TextEncoder().encode('f'))).toBe('Zg');
    expect(base64urlNoPad(new TextEncoder().encode('fo'))).toBe('Zm8');
    expect(base64urlNoPad(new TextEncoder().encode('foo'))).toBe('Zm9v');
    expect(base64urlNoPad(new TextEncoder().encode('foob'))).toBe('Zm9vYg');
    expect(base64urlNoPad(new TextEncoder().encode('fooba'))).toBe('Zm9vYmE');
    expect(base64urlNoPad(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy');
  });

  it('substitutes -_ for +/ and strips padding', () => {
    // 0xfb 0xff encodes as '+/8=' under standard base64 — one exact assertion
    // proves both alphabet substitutions and padding removal.
    expect(base64urlNoPad(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
  });
});
