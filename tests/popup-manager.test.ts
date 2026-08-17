import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PopupManager } from '../src/popup-manager'

describe('PopupManager', () => {
  let manager: PopupManager

  beforeEach(() => {
    manager = new PopupManager('https://soulpass.ai')
  })

  afterEach(() => {
    manager.close()
  })

  it('generates unique request IDs', () => {
    const id1 = manager.generateId()
    const id2 = manager.generateId()
    expect(id1).not.toBe(id2)
    expect(id1).toMatch(/^sp_/)
  })

  it('computes popup features string', () => {
    const features = manager.getPopupFeatures()
    expect(features).toContain('width=420')
    expect(features).toContain('height=620')
    expect(features).toContain('popup=yes')
  })

  it('rejects messages from wrong origin', () => {
    const handler = vi.fn()
    manager.onMessage(handler)

    const event = new MessageEvent('message', {
      data: { type: 'READY' },
      origin: 'https://evil.com',
    })
    window.dispatchEvent(event)

    expect(handler).not.toHaveBeenCalled()
  })

  it('accepts messages from correct origin', () => {
    const handler = vi.fn()
    manager.onMessage(handler)

    const event = new MessageEvent('message', {
      data: { type: 'READY' },
      origin: 'https://soulpass.ai',
    })
    window.dispatchEvent(event)

    expect(handler).toHaveBeenCalledWith({ type: 'READY' })
  })
})
