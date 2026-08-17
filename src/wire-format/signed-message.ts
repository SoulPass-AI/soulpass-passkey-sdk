/**
 * The versioned envelope every authority-signed MachineWallet operation is
 * hashed under. Mirrors `machine-wallet/program/src/domain.rs`.
 *
 * Preimage layout:
 *
 *   keccak256(
 *     len(envelope) u8 || envelope ||
 *     len(domain)   u8 || domain   ||
 *     len(tag)      u8 || tag      ||
 *     payload[0] || payload[1] || ...
 *   )
 *
 * The three header segments are variable-length ASCII, so each carries a
 * one-byte length prefix: no choice of envelope/domain/tag can produce the same
 * header bytes under a different split. Payload fields need no prefixes because
 * their widths are fixed by the tag — every caller passes fixed-width fields, or
 * hashes that are themselves length-prefixed.
 *
 * Runtime-dependency-free like the rest of `wire-format/`, so consumers that
 * only need to compute a challenge never pull in @solana/web3.js.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { concatBytes, requireByte } from './_bytes';

/**
 * Which MachineWallet deployment a signature is scoped to.
 *
 * The deployment domain is part of the signed preimage, so a signature made for
 * one deployment is not valid on any other. This is what stops a signature
 * harvested from a devnet build — where the test frontend is an accepted
 * WebAuthn origin — from authorizing the same operation on mainnet.
 *
 * Getting it wrong is not a forgery risk: the chain hashes under its own
 * compiled-in domain and simply rejects the signature.
 */
export type MachineWalletDeployment = 'local' | 'devnet' | 'mainnet';

/**
 * Outer envelope shared by every authority-signed operation. Makes the
 * deployment domain a mandatory part of every signature hash, so a new signed
 * operation cannot be added without an explicit domain choice.
 */
export const SIGNED_MESSAGE_ENVELOPE = new TextEncoder().encode(
  'machine_wallet_signed_message_v1',
);

const DEPLOYMENT_DOMAINS: Record<MachineWalletDeployment, Uint8Array> = {
  local: new TextEncoder().encode('machine_wallet_local_v1'),
  devnet: new TextEncoder().encode('machine_wallet_devnet_v1'),
  mainnet: new TextEncoder().encode('machine_wallet_mainnet_v1'),
};

/** ASCII domain string for a deployment. Throws on an unknown deployment
 * rather than defaulting — a wrong domain silently produces signatures the
 * chain rejects, which is far harder to diagnose than a thrown error. */
export function deploymentDomain(deployment: MachineWalletDeployment): Uint8Array {
  const domain = DEPLOYMENT_DOMAINS[deployment];
  if (domain === undefined) {
    throw new RangeError(
      `unknown MachineWallet deployment: ${String(deployment)}. ` +
        `Expected one of: ${Object.keys(DEPLOYMENT_DOMAINS).join(', ')}.`,
    );
  }
  return domain;
}

function lengthPrefixed(segment: Uint8Array, label: string): Uint8Array[] {
  return [requireByte(segment.length, `${label} length`), segment];
}

/**
 * Hash an authority-signed message under a deployment domain.
 *
 * `payloadParts` are concatenated verbatim — the tag fixes their widths, so
 * they carry no prefixes of their own.
 */
export function hashSignedMessage(args: {
  deployment: MachineWalletDeployment;
  tag: Uint8Array;
  payloadParts: ReadonlyArray<Uint8Array>;
}): Uint8Array {
  const domain = deploymentDomain(args.deployment);
  return keccak_256(
    concatBytes([
      ...lengthPrefixed(SIGNED_MESSAGE_ENVELOPE, 'envelope'),
      ...lengthPrefixed(domain, 'deployment domain'),
      ...lengthPrefixed(args.tag, 'instruction tag'),
      ...args.payloadParts,
    ]),
  );
}
