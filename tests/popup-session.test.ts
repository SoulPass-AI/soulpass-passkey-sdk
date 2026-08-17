import { describe, it, expect, vi } from 'vitest'
import { PopupSession } from '../src/popup-session'
import type { PopupManager } from '../src/popup-manager'
import type { PopupMessage, SDKMessage } from '../src/types'

/** Minimal PopupManager stand-in — PopupSession only touches these five. */
function fakePopup() {
  let handler: ((msg: PopupMessage) => void) | null = null
  const api = {
    send: vi.fn(),
    close: vi.fn(),
    onMessage: vi.fn((h: (msg: PopupMessage) => void) => {
      handler = h
    }),
    open: vi.fn(),
    watchClosed: vi.fn(() => vi.fn()),
  }
  return {
    manager: api as unknown as PopupManager,
    api,
    emit: (msg: PopupMessage) => handler?.(msg),
  }
}

const MSG = { type: 'SIGN_TRANSACTION', id: 'a', payload: {} } as unknown as SDKMessage

describe('PopupSession', () => {
  it('holds the payload until READY, then flushes it exactly once', () => {
    const p = fakePopup()
    const session = new PopupSession(p.manager)
    session.listen(() => 'a', vi.fn())

    session.send(MSG)
    expect(p.api.send).not.toHaveBeenCalled()

    p.emit({ type: 'READY' } as PopupMessage)
    expect(p.api.send).toHaveBeenCalledTimes(1)

    p.emit({ type: 'READY' } as PopupMessage)
    expect(p.api.send).toHaveBeenCalledTimes(1)
  })

  it('sends straight through once READY has arrived', () => {
    const p = fakePopup()
    const session = new PopupSession(p.manager)
    session.listen(() => 'a', vi.fn())
    p.emit({ type: 'READY' } as PopupMessage)

    session.send(MSG)
    expect(p.api.send).toHaveBeenCalledTimes(1)
  })

  it('drops replies whose id does not match the current leg', () => {
    const p = fakePopup()
    const session = new PopupSession(p.manager)
    const handler = vi.fn()
    session.listen(() => 'a', handler)

    p.emit({ type: 'SIGN_SUCCESS', id: 'other', payload: { signature: 'x' } } as PopupMessage)
    expect(handler).not.toHaveBeenCalled()

    p.emit({ type: 'SIGN_SUCCESS', id: 'a', payload: { signature: 'x' } } as PopupMessage)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('follows a correlation id that changes between legs', () => {
    const p = fakePopup()
    const session = new PopupSession(p.manager)
    const handler = vi.fn()
    let current = 'first'
    session.listen(() => current, handler)

    p.emit({ type: 'SIGN_SUCCESS', id: 'second', payload: { signature: 'x' } } as PopupMessage)
    expect(handler).not.toHaveBeenCalled()

    current = 'second'
    p.emit({ type: 'SIGN_SUCCESS', id: 'second', payload: { signature: 'x' } } as PopupMessage)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('disposes once and stops delivering afterwards', () => {
    const p = fakePopup()
    const stop = vi.fn()
    p.api.watchClosed.mockReturnValue(stop)
    const session = new PopupSession(p.manager)
    const handler = vi.fn()
    session.listen(() => 'a', handler)
    session.watchClose(vi.fn())

    session.dispose()
    session.dispose()

    expect(session.closed).toBe(true)
    expect(p.api.close).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)

    p.emit({ type: 'SIGN_SUCCESS', id: 'a', payload: { signature: 'x' } } as PopupMessage)
    expect(handler).not.toHaveBeenCalled()
  })

  it('releases a payload queued before READY when disposed', () => {
    const p = fakePopup()
    const session = new PopupSession(p.manager)
    session.listen(() => 'a', vi.fn())

    session.send(MSG)
    session.dispose()

    // The user closed the window before the popup ever handshook; the held
    // payload must not reach a reopened window, nor stay referenced.
    p.emit({ type: 'READY' } as PopupMessage)
    expect(p.api.send).not.toHaveBeenCalled()
  })
})
