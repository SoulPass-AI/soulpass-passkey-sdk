import type { PopupManager } from './popup-manager'
import type { SDKMessage, PopupMessage } from './types'

/**
 * One cross-origin request/response channel bound to a wallet popup.
 *
 * Every `begin*` flow needs the same four things, and each used to hand-roll
 * them: open inside the click tick, hold the first payload until the popup
 * says READY, drop replies that don't carry this channel's id, and tear down
 * exactly once no matter which of the many endings fires (reply, ERROR, user
 * closes the window, dApp cancels).
 *
 * What it deliberately does NOT own is the *termination policy* — how many
 * legs a flow runs, whether a reply closes the window, and whether a closed
 * window means failure. `beginSign` keeps the popup alive when a relay leg may
 * still answer; the batch session stays open across N signs. Those differ per
 * flow, so they stay with the caller.
 *
 * Correlation ids: the caller supplies one per leg. Flows that reuse a single
 * popup for independent requests (batch) mint a fresh id per send; flows whose
 * legs are phases of one operation (payment discover → execute) reuse one.
 */
export class PopupSession {
  private readonly popup: PopupManager
  private ready = false
  private queued: SDKMessage | null = null
  private disposed = false
  private stopWatchdog: (() => void) | null = null
  private onClose: (() => void) | null = null

  constructor(popup: PopupManager) {
    this.popup = popup
  }

  get closed(): boolean {
    return this.disposed
  }

  /**
   * Route replies to `handler`, filtered to `matchId()`. READY is consumed
   * here — it is transport-level handshake, never flow logic.
   *
   * `matchId` is a callback rather than a value because the batch flow's
   * current id changes between sends on the same channel.
   */
  listen(matchId: () => string | null, handler: (msg: PopupMessage) => void): void {
    this.popup.onMessage((msg: PopupMessage) => {
      if (this.disposed) return
      if (msg.type === 'READY') {
        this.ready = true
        const pending = this.queued
        this.queued = null
        if (pending) this.popup.send(pending)
        return
      }
      if ('id' in msg && msg.id !== matchId()) return
      handler(msg)
    })
  }

  /** Open the popup. Must run in the user-activation tick. */
  open(path: string): void {
    this.popup.open(path)
  }

  /**
   * Detect a window the user closed with the OS chrome ✕, which emits no
   * postMessage and would otherwise leave the flow pending forever. Callers
   * that have a second channel still in play simply don't arm this.
   */
  watchClose(onClosed: () => void): void {
    this.onClose = onClosed
    this.stopWatchdog = this.popup.watchClosed(() => {
      if (this.disposed) return
      this.onClose?.()
    })
  }

  /** Send now, or hold until READY. Silently ignored once disposed. */
  send(message: SDKMessage): void {
    if (this.disposed) return
    if (this.ready) this.popup.send(message)
    else this.queued = message
  }

  /**
   * Idempotent teardown. Releases the queued payload, which can be large.
   *
   * `keepWindowOpen` detaches this channel (listener, watchdog, queue) without
   * closing the wallet window. Used when the popup reports a fatal error it is
   * still displaying: the wallet owns that window's lifecycle, and the SDK
   * closing it would erase the explanation before the user can read it.
   */
  dispose(options: { keepWindowOpen?: boolean } = {}): void {
    if (this.disposed) return
    this.disposed = true
    this.queued = null
    this.onClose = null
    this.stopWatchdog?.()
    this.stopWatchdog = null
    if (options.keepWindowOpen) this.popup.removeMessageHandler()
    else this.popup.close()
  }
}
