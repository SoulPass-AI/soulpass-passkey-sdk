// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  SOULPASS_RP_ID,
  PRODUCTION_WEBAUTHN_ORIGIN,
  TEST_WEBAUTHN_ORIGIN,
  allowedWebAuthnOrigins,
  isAllowedWebAuthnOrigin,
} from '../../src/wire-format/webauthn'

// Mirrors `ALLOWED_ORIGIN_HOSTS` in machine-wallet/program/src/webauthn.rs:
// exact allowlist per deployment, never a *.soulpass.ai suffix rule.
describe('isAllowedWebAuthnOrigin', () => {
  it('pins the RP id to the on-chain constant', () => {
    expect(SOULPASS_RP_ID).toBe('soulpass.ai')
  })

  it('mainnet and local accept only the production wallet origin', () => {
    expect(allowedWebAuthnOrigins('mainnet')).toEqual(['https://soulpass.ai'])
    expect(allowedWebAuthnOrigins('local')).toEqual(['https://soulpass.ai'])
    expect(isAllowedWebAuthnOrigin(PRODUCTION_WEBAUTHN_ORIGIN)).toBe(true)
    expect(isAllowedWebAuthnOrigin(TEST_WEBAUTHN_ORIGIN)).toBe(false)
    expect(isAllowedWebAuthnOrigin(TEST_WEBAUTHN_ORIGIN, 'mainnet')).toBe(false)
  })

  it('devnet additionally accepts the test frontend (test-origin build)', () => {
    expect(isAllowedWebAuthnOrigin('https://soulpass.ai', 'devnet')).toBe(true)
    expect(isAllowedWebAuthnOrigin('https://test.soulpass.ai', 'devnet')).toBe(true)
    expect(isAllowedWebAuthnOrigin('https://uat.soulpass.ai', 'devnet')).toBe(false)
  })

  it.each([
    // Syntactically valid subdomains are NOT trusted — the whole point.
    'https://app.soulpass.ai',
    'https://wallet.dev.soulpass.ai',
    'https://foo-bar.soulpass.ai',
    'http://soulpass.ai',
    'https://evil-soulpass.ai',
    'https://soulpass.ai.evil.com',
    'https://evil.com/soulpass.ai',
    'https://soulpass.ai:443',
    'https://App.soulpass.ai',
    'https://SOULPASS.AI',
    'https://soulpass.ai/',
    'https://soulpass.ai.',
    'https://user@soulpass.ai',
    '',
  ])('rejects %s on every deployment', (origin) => {
    expect(isAllowedWebAuthnOrigin(origin, 'mainnet')).toBe(false)
    expect(isAllowedWebAuthnOrigin(origin, 'devnet')).toBe(false)
    expect(isAllowedWebAuthnOrigin(origin, 'local')).toBe(false)
  })

  it('throws on an unknown deployment instead of defaulting', () => {
    expect(() => allowedWebAuthnOrigins('testnet' as never)).toThrow(RangeError)
  })
})
