/**
 * Standard base64 (RFC 4648 §4). Chunked to avoid the argument-count
 * RangeError that `String.fromCharCode(...bytes)` hits on large inputs
 * (signMessage payloads are dApp-controlled; txs stay under 1232 B).
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Inverse of {@link uint8ArrayToBase64}. Throws on malformed input (`atob`). */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** RFC 4648 §5 base64url without padding — the exact form webauthn.rs expects. */
export function base64urlNoPad(bytes: Uint8Array): string {
  return uint8ArrayToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
