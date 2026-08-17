/**
 * P-256 (secp256r1) point encoding primitives.
 *
 * Zero-dependency and synchronous on purpose. Curve membership is a pure
 * arithmetic predicate over public data, so it is expressed as one — not
 * borrowed from `crypto.subtle.importKey`, which would make every caller
 * async, tie the primitive to an ambient global, and put it out of reach of
 * synchronous validation paths (a render-time guard, for instance).
 *
 * Note this file handles only *public* key material. There are no secrets and
 * no timing-sensitive operations here, so plain `bigint` arithmetic is the
 * right tool; anything touching a private key must not follow this pattern.
 */

/** Field prime: 2^256 − 2^224 + 2^192 + 2^96 − 1 (FIPS 186-4, D.1.2.3). */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
/** Curve coefficient b. `a` is fixed at −3 and inlined below. */
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

/**
 * Exported so callers outside this module (e.g. `evm-pop.ts`, whose pubkey
 * wire format is raw big-endian x‖y rather than SEC1-compressed) can feed
 * {@link isOnP256Curve} without re-deriving this conversion.
 */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * True when the affine point (x, y) satisfies y² ≡ x³ − 3x + b (mod p) and
 * both coordinates are reduced mod p.
 *
 * The range check is not redundant with the curve equation: an unreduced
 * coordinate can satisfy the congruence while being a different encoding of
 * the same point, and the chain stores the encoding verbatim. The point at
 * infinity has no affine encoding and is rejected here as (0, 0), which fails
 * the equation because b ≠ 0.
 */
export function isOnP256Curve(x: bigint, y: bigint): boolean {
  if (x < 0n || x >= P || y < 0n || y >= P) return false;
  const lhs = (y * y) % P;
  const rhs = (((x * x) % P) * x + (P - 3n) * x + B) % P;
  return lhs === rhs;
}

/**
 * Private hex parser with the same acceptance rules as soulpass-ai's
 * `lib/hex.ts`: optional 0x/0X prefix, even length, full-string validation
 * (a pair like "9g" must throw, not parse as 9). The KAT fixture's
 * invalidShape vectors pin these rules.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length input (${clean.length} chars)`);
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('hexToBytes: contains non-hex characters');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Convert raw P-256 X/Y hex coordinates into a 33-byte SEC1-compressed pubkey
 * — the format the on-chain MachineWallet stores authorities in.
 *
 *   prefix = 0x02 if y is even, 0x03 if y is odd
 *   followed by 32 bytes of the X coordinate big-endian
 *
 * Validates the point lies on the curve before compressing, mirroring the
 * Swift side's `compressWebAuthnPublicKey`: an off-curve point would still
 * produce 33 well-formed bytes here, register as an on-chain authority, and
 * then be permanently unusable — nobody holds a private key for a point that
 * isn't on the curve.
 */
export function compressP256(xHex: string, yHex: string): Uint8Array {
  const x = hexToBytes(xHex);
  const y = hexToBytes(yHex);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(
      `P-256 X/Y must be 32 bytes each (got X=${x.length}, Y=${y.length})`,
    );
  }
  if (!isOnP256Curve(bytesToBigIntBE(x), bytesToBigIntBE(y))) {
    throw new Error('P-256 public key (x, y) is not a valid point on the P-256 curve.');
  }

  const out = new Uint8Array(33);
  out[0] = (y[31] & 1) === 0 ? 0x02 : 0x03;
  out.set(x, 1);
  return out;
}

/**
 * Convert a DER-encoded ECDSA (P-256) signature — what WebAuthn browsers
 * return — into raw r||s (32+32 = 64 bytes) which is what the MachineWallet
 * on-chain `execute_webauthn` instruction expects.
 *
 * Also applies low-s normalization (s → n-s if s > n/2) to produce a
 * canonical signature. Solana's webauthn.rs verifier rejects high-s to
 * prevent signature malleability (same policy as Bitcoin BIP-66 / EIP-2).
 */
const P256_N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
const P256_N_HALF = P256_N >> 1n;

function bigIntTo32Bytes(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function derToRawEcdsaSignature(der: Uint8Array): Uint8Array {
  // P-256 signatures are always short-form DER (outer length ≤ 70). Bail on
  // long-form rather than accept inputs the WebAuthn authenticator would
  // never produce — keeps this parser narrow and auditable.
  if (der.length < 8 || der.length > 72) {
    throw new Error('Invalid DER signature: length out of bounds');
  }
  if (der[0] !== 0x30) throw new Error('Invalid DER signature: missing SEQUENCE tag');
  if (der[1] !== der.length - 2) throw new Error('Invalid DER signature: outer length mismatch');

  let offset = 2;
  if (der[offset] !== 0x02) throw new Error('Invalid DER signature: missing r INTEGER');
  const rLen = der[offset + 1];
  if (rLen === 0 || rLen > 33 || offset + 2 + rLen > der.length) {
    throw new Error('Invalid DER signature: r length invalid');
  }
  const r = der.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;

  if (der[offset] !== 0x02) throw new Error('Invalid DER signature: missing s INTEGER');
  const sLen = der[offset + 1];
  if (sLen === 0 || sLen > 33 || offset + 2 + sLen !== der.length) {
    throw new Error('Invalid DER signature: s length invalid');
  }
  const s = der.subarray(offset + 2, offset + 2 + sLen);

  // No explicit leading-zero strip: a 33-byte INTEGER body is only valid as
  // 0x00 + high-bit value, which converts to the same bigint, and a 33-byte
  // body with a nonzero lead is ≥ 2^256 > n and fails the range check below.
  const rBig = bytesToBigIntBE(r);
  let sBig = bytesToBigIntBE(s);
  if (rBig === 0n || rBig >= P256_N || sBig === 0n || sBig >= P256_N) {
    throw new Error('Invalid DER signature: r/s out of range [1, n-1]');
  }
  if (sBig > P256_N_HALF) sBig = P256_N - sBig;

  const raw = new Uint8Array(64);
  raw.set(bigIntTo32Bytes(rBig), 0);
  raw.set(bigIntTo32Bytes(sBig), 32);
  return raw;
}
