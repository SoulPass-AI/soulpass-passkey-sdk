/**
 * In-app browser detection.
 *
 * WebAuthn (and often window.open) is unavailable inside third-party apps'
 * embedded WKWebViews — WeChat, Facebook, Instagram et al. A passkey wallet
 * that silently fails there burns the integration's funnel; detecting the
 * host and telling the user to open the system browser is the only fix we
 * control. Detection is UA-token based: these hosts all stamp their UA, and
 * hosts that use SFSafariViewController (which supports passkeys) don't need
 * blocking — so the list stays known-broken-only, never heuristic.
 */
import { SoulPassError } from './errors'

const IN_APP_BROWSER_TOKENS: ReadonlyArray<readonly [RegExp, string]> = [
  [/MicroMessenger/i, 'WeChat'],
  [/FBAN|FBAV|FB_IAB/i, 'Facebook'],
  [/Instagram/i, 'Instagram'],
  [/\bLine\//i, 'LINE'],
  [/TikTok|musical_ly|Bytedance/i, 'TikTok'],
  [/Snapchat/i, 'Snapchat'],
]

export function detectInAppBrowser(userAgent?: string): string | null {
  const ua =
    userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')
  if (!ua) return null
  for (const [pattern, name] of IN_APP_BROWSER_TOKENS) {
    if (pattern.test(ua)) return name
  }
  return null
}

export class InAppBrowserError extends SoulPassError {
  readonly appName: string

  constructor(appName: string) {
    super(
      'IN_APP_BROWSER',
      `Passkey signing is not available inside the ${appName} in-app browser. ` +
        'Open this page in Safari (iOS) or Chrome (Android) to continue.',
    )
    this.name = 'InAppBrowserError'
    this.appName = appName
  }
}
