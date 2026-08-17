/**
 * Message hashes for every authority-signed MachineWallet operation other than
 * Execute (which lives in `operation-hash.ts`).
 *
 * These previously had no SDK mirror, so each consumer hand-rolled the ones it
 * needed — soulpass-ai carried its own CreateWallet/AddAuthority preimages, and
 * they were still v0 long after the chain moved to v1. One definition per
 * operation, in the package the chain-facing code already depends on, is what
 * stops that from recurring.
 *
 * Every payload below is pinned byte-for-byte against the contract's own KAT
 * vectors in `tests/wire-format/signed-message-kat.test.ts`.
 *
 * All operations except CreateWallet share the same preamble —
 * `wallet(32) || creation_slot_u64_le || nonce_u64_le || max_slot_u64_le` —
 * binding the signature to one wallet lifetime, one nonce, and one expiry.
 */

import type { PublicKey } from '@solana/web3.js';
import { requireByte, requireLength, u64LE } from './_bytes';
import { hashSignedMessage, type MachineWalletDeployment } from './signed-message';

const encoder = new TextEncoder();

export const CREATE_WALLET_TAG = encoder.encode('machine_wallet_create_wallet_v1');
export const CLOSE_WALLET_TAG = encoder.encode('machine_wallet_close_v1');
export const ADVANCE_NONCE_TAG = encoder.encode('machine_wallet_advance_nonce_v1');
export const CREATE_SESSION_TAG = encoder.encode('machine_wallet_create_session_v1');
export const REVOKE_SESSION_TAG = encoder.encode('machine_wallet_revoke_session_v1');
export const OWNER_CLOSE_SESSION_TAG = encoder.encode(
  'machine_wallet_owner_close_session_v1',
);
export const ADD_AUTHORITY_TAG = encoder.encode('machine_wallet_add_authority_v1');
/**
 * Signed by the key *being added*, proving it holds its private key. Distinct
 * from {@link ADD_AUTHORITY_TAG} so the incoming key's proof can never be
 * counted toward the existing owners' threshold.
 */
export const ADD_AUTHORITY_POP_TAG = encoder.encode(
  'machine_wallet_add_authority_pop_v1',
);
export const REMOVE_AUTHORITY_TAG = encoder.encode('machine_wallet_remove_authority_v1');
export const SET_THRESHOLD_TAG = encoder.encode('machine_wallet_set_threshold_v1');

/** Operands shared by every authority-signed operation except CreateWallet. */
export interface AuthorityMessageBase {
  walletPDA: PublicKey;
  creationSlot: bigint;
  nonce: bigint;
  maxSlot: bigint;
  deployment: MachineWalletDeployment;
}

/**
 * The shared preamble bytes. Exported for `operation-hash.ts`, whose Execute
 * messages share this exact preamble (see the module doc above).
 */
export function authorityPayload(base: AuthorityMessageBase): Uint8Array[] {
  return [
    base.walletPDA.toBytes(),
    u64LE(base.creationSlot),
    u64LE(base.nonce),
    u64LE(base.maxSlot),
  ];
}

/**
 * CreateWallet: `wallet(32) || max_slot || sig_scheme(1) || authority(33)`.
 *
 * The only signed operation with no creation_slot/nonce — the wallet does not
 * exist yet, so there is no lifetime or nonce to bind to. Signing `sig_scheme`
 * prevents a known WebAuthn P-256 pubkey from being front-run into a raw
 * Secp256r1 wallet at the same PDA.
 *
 * This value IS the WebAuthn challenge for CreateWallet.
 */
export function computeCreateWalletMessage(args: {
  walletPDA: PublicKey;
  maxSlot: bigint;
  sigScheme: number;
  /** 33-byte compressed P-256 point. */
  authority: Uint8Array;
  deployment: MachineWalletDeployment;
}): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: CREATE_WALLET_TAG,
    payloadParts: [
      args.walletPDA.toBytes(),
      u64LE(args.maxSlot),
      requireByte(args.sigScheme, 'sigScheme'),
      requireLength(args.authority, 33, 'authority'),
    ],
  });
}

/** CloseWallet: preamble `|| destination(32)`. */
export function computeCloseWalletMessage(
  args: AuthorityMessageBase & { destination: Uint8Array },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: CLOSE_WALLET_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireLength(args.destination, 32, 'destination'),
    ],
  });
}

/** AdvanceNonce: the bare preamble. */
export function computeAdvanceNonceMessage(args: AuthorityMessageBase): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: ADVANCE_NONCE_TAG,
    payloadParts: authorityPayload(args),
  });
}

/** CreateSession: preamble `|| session_data_hash(32)`. */
export function computeCreateSessionMessage(
  args: AuthorityMessageBase & { sessionDataHash: Uint8Array },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: CREATE_SESSION_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireLength(args.sessionDataHash, 32, 'sessionDataHash'),
    ],
  });
}

/** RevokeSession (owner path): preamble `|| session_authority(32)`. */
export function computeRevokeSessionMessage(
  args: AuthorityMessageBase & { sessionAuthority: Uint8Array },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: REVOKE_SESSION_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireLength(args.sessionAuthority, 32, 'sessionAuthority'),
    ],
  });
}

/** OwnerCloseSession: preamble `|| session_authority(32) || destination(32)`. */
export function computeOwnerCloseSessionMessage(
  args: AuthorityMessageBase & { sessionAuthority: Uint8Array; destination: Uint8Array },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: OWNER_CLOSE_SESSION_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireLength(args.sessionAuthority, 32, 'sessionAuthority'),
      requireLength(args.destination, 32, 'destination'),
    ],
  });
}

/**
 * AddAuthority — the existing owners' approval.
 * Preamble `|| new_sig_scheme(1) || new_pubkey(33) || new_threshold(1)`.
 */
export function computeAddAuthorityMessage(
  args: AuthorityMessageBase & {
    newSigScheme: number;
    newPubkey: Uint8Array;
    newThreshold: number;
  },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: ADD_AUTHORITY_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireByte(args.newSigScheme, 'newSigScheme'),
      requireLength(args.newPubkey, 33, 'newPubkey'),
      requireByte(args.newThreshold, 'newThreshold'),
    ],
  });
}

/**
 * AddAuthority proof-of-possession — signed by the key being added.
 * Preamble `|| new_sig_scheme(1) || new_pubkey(33)`.
 *
 * The program requires this *in addition to* the owners' approval: approval
 * proves the add was authorized, this proves the key being added actually
 * exists. Without it, adding an unheld key and then removing the old authority
 * leaves the wallet owned by a key nobody can sign with — unrecoverable.
 *
 * `newThreshold` is deliberately absent: the incoming key attests only to its
 * own existence and consent to join at this nonce. What the threshold becomes
 * is the existing owners' decision, bound into the message they sign.
 */
export function computeAddAuthorityPopMessage(
  args: AuthorityMessageBase & { newSigScheme: number; newPubkey: Uint8Array },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: ADD_AUTHORITY_POP_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireByte(args.newSigScheme, 'newSigScheme'),
      requireLength(args.newPubkey, 33, 'newPubkey'),
    ],
  });
}

/**
 * RemoveAuthority: preamble `|| remove_sig_scheme(1) || remove_pubkey(33) ||
 * new_threshold(1)`.
 */
export function computeRemoveAuthorityMessage(
  args: AuthorityMessageBase & {
    removeSigScheme: number;
    removePubkey: Uint8Array;
    newThreshold: number;
  },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: REMOVE_AUTHORITY_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireByte(args.removeSigScheme, 'removeSigScheme'),
      requireLength(args.removePubkey, 33, 'removePubkey'),
      requireByte(args.newThreshold, 'newThreshold'),
    ],
  });
}

/** SetThreshold: preamble `|| new_threshold(1)`. */
export function computeSetThresholdMessage(
  args: AuthorityMessageBase & { newThreshold: number },
): Uint8Array {
  return hashSignedMessage({
    deployment: args.deployment,
    tag: SET_THRESHOLD_TAG,
    payloadParts: [
      ...authorityPayload(args),
      requireByte(args.newThreshold, 'newThreshold'),
    ],
  });
}
