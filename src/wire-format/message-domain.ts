/**
 * SoulPass signed-message domain separation — the cross-device contract for
 * "sign this arbitrary message" flows. Any byte-level drift here breaks every
 * previously-signed message and every dApp verifier. TS-only today: no Swift
 * or Rust counterpart exists yet (tracked in the README contract table).
 */

import { concatBytes, u32LE } from './_bytes';

/**
 * Immutable namespace bytes for SoulPass message signing. The "\x19" leading
 * byte is borrowed from EIP-191 — it is not a valid starting byte for any
 * other Solana or Ethereum signing scheme we know of, which makes the
 * resulting preimage provably distinct.
 *
 * NEVER rename, reformat, or "upgrade" this constant without coordinating a
 * versioned SDK bump. Verifiers re-derive the preimage from this exact
 * string; any divergence breaks every previously-signed message.
 */
export const MESSAGE_DOMAIN = new TextEncoder().encode(
  '\x19SoulPass Signed Message:\n',
);

/**
 * Build the preimage that will be SHA-256'd into a WebAuthn challenge:
 *   MESSAGE_DOMAIN || u32_le(len) || message
 *
 * The u32 length sits inside the preimage (not just concatenation) so the
 * construction is collision-resistant on its own: without the length,
 * "domain || A || B" aliases with "domain || A" when B is zero-length, and
 * more subtly, a trailing-NUL message aliases with its truncation.
 */
export function domainSeparate(message: Uint8Array): Uint8Array {
  return concatBytes([MESSAGE_DOMAIN, u32LE(message.length), message]);
}
