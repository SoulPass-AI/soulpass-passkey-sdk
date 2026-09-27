/**
 * Matrix platform HTTP conventions shared by the SDK's HTTP legs (the
 * sign-channel relay and the payments provider). One definition per cross-repo
 * wire contract — a header rename or a mode bump lands here and every client
 * follows, instead of two modules holding drifting string copies.
 */

import { DEFAULT_WALLET_URL } from './types'

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

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Reduce a configured wallet URL to the exact origin the popup will report in
 * `MessageEvent.origin`. A trailing slash or path would otherwise make every
 * reply fail the origin check and be dropped silently; plain HTTP would put
 * the whole signing channel on the wire in clear. HTTP is allowed only on
 * loopback, for local popup development.
 */
export function normalizeWalletOrigin(walletUrl: string): string {
  let url: URL
  try {
    url = new URL(walletUrl)
  } catch {
    throw new TypeError(`[SoulPass SDK] walletUrl is not a valid URL: ${walletUrl}`)
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new TypeError(
      '[SoulPass SDK] walletUrl must use HTTPS (HTTP is allowed only on localhost).',
    )
  }
  return url.origin
}

/**
 * The two endpoints every entry point derives from wallet config — one place,
 * so the popup channel and the HTTP legs can't end up on different hosts.
 */
export function resolveWalletEndpoints(
  config: { walletUrl?: string; apiUrl?: string },
): { walletOrigin: string; apiUrl: string } {
  const walletOrigin = normalizeWalletOrigin(config.walletUrl ?? DEFAULT_WALLET_URL)
  return { walletOrigin, apiUrl: config.apiUrl ?? deriveApiUrl(walletOrigin) }
}
