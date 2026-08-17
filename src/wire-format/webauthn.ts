/**
 * Client-side mirror of `machine-wallet/program/src/webauthn.rs` WebAuthn
 * policy constants. The chain is the authority — these exist so clients can
 * fail fast before submitting a transaction that the program would reject
 * (and paying its fee).
 */

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

const HTTPS_PREFIX = 'https://';

/**
 * Mirror of on-chain `is_allowed_origin`: accept only the SoulPass HTTPS root
 * origin and syntactically-valid HTTPS subdomains. Ports, paths, userinfo,
 * lookalike suffixes, uppercase/non-ASCII labels, and empty DNS labels are
 * rejected; hosts are capped at 253 bytes.
 */
export function isAllowedWebAuthnOrigin(origin: string): boolean {
  if (!origin.startsWith(HTTPS_PREFIX)) {
    return false;
  }
  const host = origin.slice(HTTPS_PREFIX.length);
  if (host === SOULPASS_RP_ID) {
    return true;
  }
  if (host.length > 253 || !host.endsWith('.' + SOULPASS_RP_ID)) {
    return false;
  }

  const subdomain = host.slice(0, host.length - SOULPASS_RP_ID.length - 1);
  return subdomain.split('.').every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      !label.startsWith('-') &&
      !label.endsWith('-') &&
      /^[a-z0-9-]+$/.test(label),
  );
}
