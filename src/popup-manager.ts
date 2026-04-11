import type { SDKMessage, PopupMessage } from './types'
import { POPUP_WIDTH, POPUP_HEIGHT } from './types'

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
    const url = `${this.walletOrigin}${path}`
    const features = this.getPopupFeatures()
    const popup = window.open(url, 'soulpass-wallet', features)
    if (!popup) {
      throw new Error('Popup blocked. Please allow popups for this site.')
    }
    this.popup = popup
    return popup
  }

  send(message: SDKMessage): void {
    if (!this.popup || this.popup.closed) {
      throw new Error('Popup is not open')
    }
    this.popup.postMessage(message, this.walletOrigin)
  }

  onMessage(handler: (message: PopupMessage) => void): void {
    this.removeMessageHandler()
    this.messageHandler = (event: MessageEvent) => {
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
}
