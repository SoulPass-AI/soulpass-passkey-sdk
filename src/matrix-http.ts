/**
 * Matrix platform HTTP conventions shared by the SDK's HTTP legs (the
 * sign-channel relay and the payments provider). One definition per cross-repo
 * wire contract — a header rename or a mode bump lands here and every client
 * follows, instead of two modules holding drifting string copies.
 */

/**
 * Matrix HTTP Response Standard v1 opt-in (matrix-backend
 * `docs/specs/http-response-standard-v1.md`).
 *
 * Without it every failure comes back as HTTP 200 and the transport can tell
 * outcomes apart only by reading the body. With it the server projects each
 * business code to its semantic status. Backends that predate v1 ignore the
 * header and keep answering 200, so this needs no negotiation or feature flag.
 */
export const RESPONSE_MODE_HEADER = 'X-Matrix-Response-Mode'
export const RESPONSE_MODE_HTTP_STATUS_V1 = 'http-status-v1'

/**
 * Wallet origin → API base. Mirrors the env split the wallet frontends use
 * (`api.soulpass.ai` / `api-test` / `api-uat`); unknown hosts (local dev)
 * assume a same-origin `/api` proxy. Environment topology is SDK-wide
 * knowledge — both the relay client and the payments factory derive from it.
 */
export function deriveApiUrl(walletUrl: string): string {
  const url = new URL(walletUrl)
  if (url.hostname === 'soulpass.ai') return 'https://api.soulpass.ai/api'
  const envMatch = url.hostname.match(/^(test|uat)\.soulpass\.ai$/)
  if (envMatch) return `https://api-${envMatch[1]}.soulpass.ai/api`
  return `${url.origin}/api`
}
