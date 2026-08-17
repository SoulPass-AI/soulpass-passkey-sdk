// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  SOULPASS_RP_ID,
  MAX_CLIENT_DATA_JSON_SIZE,
  isAllowedWebAuthnOrigin,
} from '../../src/wire-format/webauthn'

// Mirrors the accept/reject matrix in machine-wallet/program/src/webauthn.rs
// tests — the two implementations must agree on every case.
describe('isAllowedWebAuthnOrigin', () => {
  it('pins the RP id and sidecar cap to the on-chain constants', () => {
    expect(SOULPASS_RP_ID).toBe('soulpass.ai')
    expect(MAX_CLIENT_DATA_JSON_SIZE).toBe(1024)
  })

  it.each([
    'https://soulpass.ai',
    'https://app.soulpass.ai',
    'https://wallet.dev.soulpass.ai',
    'https://foo-bar.soulpass.ai',
  ])('accepts %s', (origin) => {
    expect(isAllowedWebAuthnOrigin(origin)).toBe(true)
  })

  it.each([
    'http://soulpass.ai',
    'https://evil-soulpass.ai',
    'https://soulpass.ai.evil.com',
    'https://evil.com/soulpass.ai',
    'https://soulpass.ai:443',
    'https://foo..soulpass.ai',
    'https://-foo.soulpass.ai',
    'https://foo-.soulpass.ai',
    'https://App.soulpass.ai',
    'https://.soulpass.ai',
    'https://soulpass.ai/',
    'https://user@soulpass.ai',
    '',
  ])('rejects %s', (origin) => {
    expect(isAllowedWebAuthnOrigin(origin)).toBe(false)
  })

  it('rejects hosts over 253 bytes even when every label is valid', () => {
    // Four 60-byte labels + dots + "soulpass.ai" = 255-byte host.
    const label = 'a'.repeat(60)
    const origin = `https://${label}.${label}.${label}.${label}.soulpass.ai`
    expect(isAllowedWebAuthnOrigin(origin)).toBe(false)
  })

  it('rejects labels over 63 bytes', () => {
    expect(isAllowedWebAuthnOrigin(`https://${'a'.repeat(64)}.soulpass.ai`)).toBe(false)
    expect(isAllowedWebAuthnOrigin(`https://${'a'.repeat(63)}.soulpass.ai`)).toBe(true)
  })
})
