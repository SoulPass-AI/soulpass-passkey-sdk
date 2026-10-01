/**
 * `AuthoritySlot` (`state.rs`): `sig_scheme(1) || pubkey(33)`, the on-chain
 * form of one authority in the wallet's set, its root, its pending root and a
 * session's creator. Decoded here once for `wallet-state.ts` and
 * `session-state.ts`.
 */

import { AUTHORITY_SLOT_SIZE } from './constants';

/**
 * Authority signature schemes (mirror `state.rs::SIG_SCHEME_*`).
 * The chain routes a stored authority to its verifier by this tag;
 * **registering the wrong scheme silently locks the signer out**, so callers
 * should always use these named values rather than literal `0`/`1`/`2`.
 */
export const SigScheme = {
  /** Raw P-256 ECDSA — signer signs the 32-byte operation_hash directly. */
  Secp256r1: 0,
  /** Ed25519 — session keys + Ed25519 hardware. */
  Ed25519: 1,
  /** P-256 ECDSA via WebAuthn envelope — chain expects `auth_data ‖ sha256(cdj)`. */
  Webauthn: 2,
} as const;

export type SigSchemeValue = (typeof SigScheme)[keyof typeof SigScheme];

/** `AuthoritySlot::is_known_scheme`. */
export function isKnownSigScheme(b: number): b is SigSchemeValue {
  return b === SigScheme.Secp256r1 || b === SigScheme.Ed25519 || b === SigScheme.Webauthn;
}

/**
 * One decoded authority slot. `pubkey` is the raw 33-byte STORAGE form, which
 * is layout, not the key itself: `Secp256r1`/`Webauthn` slots hold a genuine
 * SEC1-compressed P-256 key, while `Ed25519` slots hold a 32-byte key padded
 * with a trailing `0x00`. Use `effectiveAuthorityKey` to cross from storage
 * form to the bytes a verifier actually consumes.
 */
export interface WalletAuthoritySlot {
  sigScheme: SigSchemeValue;
  /**
   * 33-byte authority slot bytes (see storage-form note above). A **copy**,
   * not a view onto the caller's buffer — deliberately, since parsed states
   * get cached and a `subarray` would pin the whole RPC buffer alive.
   */
  pubkey: Uint8Array;
}

/**
 * Decode the slot at `off`, rejecting an unknown `sig_scheme`: this build
 * can't tell which verifier such an authority routes to, and guessing
 * silently locks the signer out. `what` names the slot in the error.
 */
export function readKnownSlot(data: Uint8Array, off: number, what: string): WalletAuthoritySlot {
  const sigScheme = data[off];
  if (!isKnownSigScheme(sigScheme)) {
    throw new Error(`Unknown ${what} sig_scheme byte: ${sigScheme}`);
  }
  return { sigScheme, pubkey: data.slice(off + 1, off + AUTHORITY_SLOT_SIZE) };
}
