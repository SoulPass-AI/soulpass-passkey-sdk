import type { SDKMessage, PopupMessage } from './types'
import { POPUP_WIDTH, POPUP_HEIGHT } from './types'
import { detectInAppBrowser, InAppBrowserError } from './environment'
import { SoulPassError } from './errors'

export class PopupManager {
  private walletOrigin: string
  private popup: Window | null = null
  private messageHandler: ((event: MessageEvent) => void) | null = null
  private counter = 0

  constructor(walletOrigin: string) {
    this.walletOrigin = walletOrigin
  }

  generateId(): string {
    return `sp_${Date.now()}_${++this.counter}`
  }

  getPopupFeatures(): string {
    const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2)
    const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2)
    return `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`
  }

  open(path: string): Window {
    // The wallet popup refuses to handshake without a pinned dApp origin — it
    // uses this value to target postMessage replies so a malicious site can't
    // scrape signed results by timing window.opener. Failing loud here beats
    // a confusing "Missing ?origin parameter" in the popup later.
    const dAppOrigin =
      typeof window !== 'undefined' ? window.location.origin : ''
    if (!dAppOrigin) {
      throw new SoulPassError('NO_BROWSER', 'SoulPass SDK requires a browser window.')
    }
    // Known-broken embedded webviews can't run the passkey ceremony the popup
    // needs — fail with guidance now, not with a dead popup later.
    const inAppHost = detectInAppBrowser()
    if (inAppHost) {
      throw new InAppBrowserError(inAppHost)
    }
    // Losing transient user activation doesn't throw — the browser silently
    // downgrades the popup to a tab or blocks it, which is near-impossible to
    // debug from the dApp side. Warn at the moment the mistake happens.
    const activation = (navigator as Navigator & {
      userActivation?: { isActive: boolean }
    }).userActivation
    if (activation && !activation.isActive) {
      console.warn(
        '[SoulPass SDK] window.open() called without transient user activation — ' +
          'the browser may block the popup or downgrade it to a new tab. ' +
          'Call connect() / beginSign*() / beginPayment() synchronously inside a click or pointer ' +
          'event handler (not after an await, and not from an effect).',
      )
    }
    const sep = path.includes('?') ? '&' : '?'
    const url = `${this.walletOrigin}${path}${sep}origin=${encodeURIComponent(dAppOrigin)}`
    const features = this.getPopupFeatures()
    const popup = window.open(url, 'soulpass-wallet', features)
    if (!popup) {
      throw new SoulPassError('POPUP_BLOCKED', 'Popup blocked. Please allow popups for this site.')
    }
    this.popup = popup
    return popup
  }

  send(message: SDKMessage): void {
    if (!this.popup || this.popup.closed) {
      throw new SoulPassError('POPUP_CLOSED', 'Popup is not open')
    }
    this.popup.postMessage(message, this.walletOrigin)
  }

  onMessage(handler: (message: PopupMessage) => void): void {
    this.removeMessageHandler()
    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== this.popup) return
      if (event.origin !== this.walletOrigin) return
      handler(event.data as PopupMessage)
    }
    window.addEventListener('message', this.messageHandler)
  }

  removeMessageHandler(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler)
      this.messageHandler = null
    }
  }

  close(): void {
    this.removeMessageHandler()
    if (this.popup && !this.popup.closed) {
      this.popup.close()
    }
    this.popup = null
  }

  get isOpen(): boolean {
    return this.popup !== null && !this.popup.closed
  }

  /**
   * Poll for a window the user closed manually. Closing emits no event to the
   * opener, so polling is the only signal; lives here because `popup` is the
   * private handle being watched. Returns a disposer.
   */
  watchClosed(onClosed: () => void, intervalMs = 500): () => void {
    const watchdog = setInterval(() => {
      if (!this.isOpen) onClosed()
    }, intervalMs)
    return () => clearInterval(watchdog)
  }
}
