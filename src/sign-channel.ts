/**
 * Sign-channel relay client — the second leg of the dual-channel sign flow.
 *
 * The popup postMessage protocol stays the primary leg; this client mirrors
 * every SIGN_TRANSACTION payload to the backend relay so that when iOS takes
 * over the sign URL via universal link (the popup window never comes up),
 * the app can fetch the payload and the SDK can learn the outcome by
 * polling. Whoever answers first wins — see `wallet.ts`.
 *
 * The payload PUT is anonymous by design: third-party productTypes no longer
 * receive an access token at connect time, so the channelId itself is the
 * capability (128-bit CSPRNG). It carries no secrets — a compiled transaction
 * and public addresses. The requesting origin is stamped server-side from the
 * HTTP Origin header; nothing this client claims about origin is trusted.
 */
import { base64urlNoPad } from './encoding'
import { SoulPassError } from './errors'
import { RESPONSE_MODE_HEADER, RESPONSE_MODE_HTTP_STATUS_V1 } from './matrix-http'
import type { SDKSignTransactionMessage } from './types'

const CHANNEL_ID_BYTES = 16

/** Relay route base — both endpoints below live under it. */
const SIGN_CHANNEL_PATH = '/user/v1/sign-channels'

/**
 * Query-param name the sign URL carries the channel id under. Cross-repo
 * contract: the iOS AASA component match (`?channel=?*`) and the wallet popup
 * both key on this exact string — rename here and both must follow.
 */
export const SIGN_CHANNEL_PARAM = 'channel'

export function generateChannelId(): string {
  const bytes = new Uint8Array(CHANNEL_ID_BYTES)
  crypto.getRandomValues(bytes)
  return base64urlNoPad(bytes)
}

/**
 * The relay mirrors the popup payload verbatim, so it reuses the popup's own
 * payload type — one definition means a new SIGN_TRANSACTION field can't
 * reach the popup leg while silently missing the relay leg, and the relay
 * can't accept branded values (VaultPda, SoulPassNetwork) the popup rejects.
 * `productType` is the only relay-side addition.
 */
export type SignChannelPayloadInput = SDKSignTransactionMessage['payload'] & {
  productType?: string
}

export interface SignChannelResult {
  status: 'completed' | 'cancelled' | 'error'
  signature?: string
  message?: string
}

const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'error'])

export class SignChannelClient {
  constructor(private readonly apiUrl: string) {}

  /**
   * Mirror the sign payload to the relay. Never rejects — the popup leg is
   * still alive, and a relay hiccup must not break the flow that worked
   * before the relay existed. Returns whether the mailbox was created: a
   * failed mirror means no app can ever fetch the payload, so the caller can
   * skip polling a channel that is guaranteed to stay empty.
   */
  async putPayload(channelId: string, payload: SignChannelPayloadInput): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}${SIGN_CHANNEL_PATH}/payload`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RESPONSE_MODE_HEADER]: RESPONSE_MODE_HTTP_STATUS_V1,
        },
        body: JSON.stringify({ channelId, ...payload }),
      })
      return res.ok
    } catch {
      // Relay unreachable — popup leg carries the flow.
      return false
    }
  }

  /**
   * Poll until a terminal status. Transient network errors keep polling;
   * only an abort stops the loop (rejects with a `CANCELLED` SoulPassError).
   * Overall timeout is the caller's responsibility — it owns the popup leg
   * and the deadline.
   */
  async pollResult(
    channelId: string,
    opts: { signal: AbortSignal; intervalMs?: number },
  ): Promise<SignChannelResult> {
    const intervalMs = opts.intervalMs ?? 2000
    const url =
      `${this.apiUrl}${SIGN_CHANNEL_PATH}/result-poll?channelId=` +
      encodeURIComponent(channelId)
    for (;;) {
      // Message keeps the historical "ABORTED: …" prefix for string-matchers;
      // the typed code is what callers should branch on.
      if (opts.signal.aborted) {
        throw new SoulPassError('CANCELLED', 'ABORTED: sign-channel poll aborted')
      }
      try {
        // Signal-aware so an abort mid-flight drops the request instead of
        // paying for a round-trip whose answer nobody reads.
        const res = await fetch(url, {
          signal: opts.signal,
          headers: { [RESPONSE_MODE_HEADER]: RESPONSE_MODE_HTTP_STATUS_V1 },
        })
        // The backend wraps every response in `{ code, success, data }`; only
        // `data` is read — the status is carried by `data.status`. A rejected
        // poll is now a real non-2xx, but the body is still the same envelope
        // and `data` is simply absent, so the loop keeps waiting rather than
        // treating a transient refusal as a terminal answer.
        const body = (await res.json()) as { data?: SignChannelResult }
        const data = body?.data
        if (data && TERMINAL_STATUSES.has(data.status)) {
          const result: SignChannelResult = { status: data.status }
          if (data.signature) result.signature = data.signature
          if (data.message) result.message = data.message
          return result
        }
      } catch {
        // Transient relay/network error — keep polling until abort.
      }
      // Sleep, waking early on abort. Resolve-only: the loop head above owns
      // the single ABORTED throw. Resolving immediately when already aborted
      // matters — a listener attached to a settled signal never fires, and
      // the pending timer would pin this closure for a full interval.
      await new Promise<void>((resolve) => {
        if (opts.signal.aborted) return resolve()
        const timer = setTimeout(() => {
          opts.signal.removeEventListener('abort', onAbort)
          resolve()
        }, intervalMs)
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
}
