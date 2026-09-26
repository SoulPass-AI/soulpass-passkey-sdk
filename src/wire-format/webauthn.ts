/**
 * Client-side mirror of `machine-wallet/program/src/webauthn.rs` WebAuthn
 * policy constants. The chain is the authority — these exist so clients can
 * fail fast before submitting a transaction that the program would reject
 * (and paying its fee).
 */

import type { MachineWalletDeployment } from './signed-message';

/**
 * Relying Party identifier for all SoulPass passkeys (mirrors
 * `EXPECTED_RP_ID`). The on-chain program requires
 * `authenticatorData.rpIdHash == SHA-256(this)` (error 47) and a
 * clientDataJSON `origin` allowed by {@link isAllowedWebAuthnOrigin}
 * (error 49).
 */
export const SOULPASS_RP_ID = 'soulpass.ai';

/**
 * Maximum clientDataJSON size accepted by the on-chain disc=15 sidecar
 * parser (mirrors `MAX_CLIENT_DATA_JSON_SIZE`).
 */
export const MAX_CLIENT_DATA_JSON_SIZE = 1024;

/** The production wallet origin — the only one a mainnet deployment accepts. */
export const PRODUCTION_WEBAUTHN_ORIGIN = 'https://soulpass.ai';

/** The test wallet frontend, accepted only by devnet/test deployments. */
export const TEST_WEBAUTHN_ORIGIN = 'https://test.soulpass.ai';

/**
 * Exact origin allowlist per deployment, mirroring the chain's compile-time
 * `ALLOWED_ORIGIN_HOSTS` (see machine-wallet README "Cluster-locked build
 * flags"): mainnet and the default local build accept only the production
 * wallet; the devnet build (`test-origin` feature) adds the test frontend.
 *
 * Deliberately NOT "any *.soulpass.ai": the rpId lets every subdomain obtain
 * an assertion, so a suffix rule would turn a stale CNAME, a preview deploy
 * or one XSS on a marketing host into a wallet-authorization surface. Only
 * hosts the wallet team controls end to end belong here. (The EVM
 * MachineAccount verifier follows the same split: 1.1.0 on mainnet accepts
 * only the production origin.)
 */
const ALLOWED_ORIGINS: Record<MachineWalletDeployment, readonly string[]> = {
  local: [PRODUCTION_WEBAUTHN_ORIGIN],
  devnet: [PRODUCTION_WEBAUTHN_ORIGIN, TEST_WEBAUTHN_ORIGIN],
  mainnet: [PRODUCTION_WEBAUTHN_ORIGIN],
};

/** The exact origins a deployment's verifier accepts. */
export function allowedWebAuthnOrigins(
  deployment: MachineWalletDeployment,
): readonly string[] {
  const origins = ALLOWED_ORIGINS[deployment];
  if (origins === undefined) {
    throw new RangeError(`unknown MachineWallet deployment: ${String(deployment)}`);
  }
  return origins;
}

/**
 * Mirror of on-chain `is_allowed_origin`: exact byte equality against the
 * deployment's allowlist. Ports, paths, trailing slashes, userinfo, case
 * variants and every other host-parsing trick simply fail to match.
 *
 * Defaults to `mainnet`, the strictest policy; pass the deployment you are
 * submitting to when checking a devnet assertion.
 */
export function isAllowedWebAuthnOrigin(
  origin: string,
  deployment: MachineWalletDeployment = 'mainnet',
): boolean {
  return allowedWebAuthnOrigins(deployment).includes(origin);
}
