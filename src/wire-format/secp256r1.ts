/**
 * `Secp256r1SigVerify` precompile instruction data builder. The Solana
 * secp256r1 SIP defines a fixed wire format — getting any offset wrong
 * surfaces as a precompile failure at submit time, which the chain reports
 * as a generic "Program failed to complete" with no actionable message.
 *
 * The popup ALSO uses this builder for its placeholder ix during v0 tx
 * compilation (before the WebAuthn ceremony runs). Same byte layout; just
 * zeros in the signature / pubkey / auth-data slots.
 */

import { u16LE, concatBytes } from './_bytes';

/** Header size (bytes 0..16). */
const HEADER_SIZE = 16;
/** Offset of signature payload (bytes 16..80). */
const SIG_OFFSET = 16;
/** Offset of compressed P-256 pubkey (bytes 80..113). */
const PUBKEY_OFFSET = 80;
/** Offset of message payload (bytes 113..). */
const MESSAGE_OFFSET = 113;

/** Sentinel for "data lives in this instruction" — Solana secp256r1 SIP convention. */
const IX_IDX_SAME = 0xffff;

/**
 * Build the precompile `data` blob:
 *
 *   data[0]   = num_signatures (1)
 *   data[1]   = padding (0)
 *   data[2-3] = sig_offset    u16 LE = 16
 *   data[4-5] = sig_ix        u16 LE = 0xFFFF
 *   data[6-7] = pubkey_offset u16 LE = 80
 *   data[8-9] = pubkey_ix     u16 LE = 0xFFFF
 *   data[10-11] = msg_offset  u16 LE = 113
 *   data[12-13] = msg_size    u16 LE = message.length
 *   data[14-15] = msg_ix      u16 LE = 0xFFFF
 *   data[16..80]  = signature (64 bytes raw r||s, low-s normalised)
 *   data[80..113] = pubkey (33 bytes SEC1-compressed)
 *   data[113..]   = message (`authData ‖ sha256(clientDataJSON)` for WebAuthn,
 *                            or `keccak256(...)` for raw Secp256r1 signers)
 *
 * Caller is responsible for the WebAuthn-specific message construction. The
 * builder enforces only structural invariants (sig=64, pubkey=33, message≥1).
 */
export function buildSecp256r1PrecompileIxData(args: {
  /** 64 bytes — raw r ‖ s, low-s normalised. NOT DER-encoded. */
  signature: Uint8Array;
  /** 33 bytes — SEC1-compressed P-256 public key. */
  publicKey: Uint8Array;
  /** Variable length — the bytes the authenticator signed over. */
  message: Uint8Array;
}): Uint8Array {
  const { signature, publicKey, message } = args;

  if (signature.length !== 64) {
    throw new RangeError(`signature must be 64 bytes (raw r||s), got ${signature.length}`);
  }
  if (publicKey.length !== 33) {
    throw new RangeError(`publicKey must be 33 bytes (compressed P-256), got ${publicKey.length}`);
  }
  if (message.length === 0) {
    throw new RangeError('message must be non-empty');
  }

  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  header[0] = 1; // num_signatures
  header[1] = 0; // padding
  view.setUint16(2, SIG_OFFSET, true);
  view.setUint16(4, IX_IDX_SAME, true);
  view.setUint16(6, PUBKEY_OFFSET, true);
  view.setUint16(8, IX_IDX_SAME, true);
  view.setUint16(10, MESSAGE_OFFSET, true);
  view.setUint16(12, message.length, true);
  view.setUint16(14, IX_IDX_SAME, true);

  return concatBytes([header, signature, publicKey, message]);
}

/** Re-export so callers using bare `u16LE` don't need a second import path. */
export { u16LE };
