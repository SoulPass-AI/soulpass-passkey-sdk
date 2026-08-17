import { describe, it, expect, afterEach, vi } from 'vitest'
import { detectInAppBrowser, InAppBrowserError } from '../src/environment'
import { PopupManager } from '../src/popup-manager'

const WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49'
const IOS_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const FACEBOOK_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0;FB_IAB/FB4A]'

describe('detectInAppBrowser', () => {
  it('detects WeChat', () => {
    expect(detectInAppBrowser(WECHAT_UA)).toBe('WeChat')
  })
  it('detects Facebook', () => {
    expect(detectInAppBrowser(FACEBOOK_UA)).toBe('Facebook')
  })
  it('passes plain iOS Safari through', () => {
    expect(detectInAppBrowser(IOS_SAFARI_UA)).toBeNull()
  })
  it('passes desktop Chrome through', () => {
    expect(
      detectInAppBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      ),
    ).toBeNull()
  })
})

describe('PopupManager in-app guard', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('open() throws InAppBrowserError inside WeChat instead of a dead window.open', () => {
    vi.stubGlobal('navigator', { userAgent: WECHAT_UA })
    const pm = new PopupManager('https://soulpass.ai')
    expect(() => pm.open('/wallet/sign')).toThrowError(InAppBrowserError)
  })
})
