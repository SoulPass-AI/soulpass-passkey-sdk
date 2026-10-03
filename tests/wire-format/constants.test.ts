import { describe, it, expect } from 'vitest'
import * as C from '../../src/wire-format/constants'

// Every value mirrors machine-wallet program/src (state.rs, instruction.rs,
// webauthn.rs, processor/{mod,create_session,recovery}.rs). Pinned as data so
// a drift fails here instead of on chain.
describe('machine-wallet constants', () => {
  it('account tags', () => {
    expect(C.WALLET_ACCOUNT_TAG).toBe(0x57)
    expect(C.SESSION_ACCOUNT_TAG).toBe(0x53)
    expect(C.RETIRED_ACCOUNT_TAGS).toEqual([0, 1, 2])
    expect(C.RETIRED_ACCOUNT_TAGS).not.toContain(C.WALLET_ACCOUNT_TAG)
    expect(C.RETIRED_ACCOUNT_TAGS).not.toContain(C.SESSION_ACCOUNT_TAG)
  })

  it('caps', () => {
    expect(C.MAX_AUTHORITIES).toBe(16)
    expect(C.MAX_ALLOWED_PROGRAMS).toBe(8)
    expect(C.MAX_CASH_MINTS).toBe(5)
    expect(C.MAX_SLEEVE_MINTS).toBe(16)
    expect(C.MAX_EPHEMERAL_SIGNERS).toBe(4)
    expect(C.MAX_INNER_INSTRUCTIONS).toBe(64)
    expect(C.MAX_CLIENT_DATA_JSON_SIZE).toBe(1024)
  })

  it('slot windows are u64 bigints', () => {
    expect(C.MAX_SIGNATURE_TTL_SLOTS).toBe(2_000n)
    expect(C.MAX_SESSION_LIFETIME_SLOTS).toBe(6_480_000n)
    expect(C.RECOVERY_DELAY_SLOTS).toBe(1_512_000n)
  })

  it('session flags', () => {
    expect(C.SESSION_FLAG_NET_EXPOSURE).toBe(0x01)
    expect(C.SESSION_FLAGS_KNOWN).toBe(0x01)
  })

  it('native SOL mint is 32 zero bytes', () => {
    expect(C.NATIVE_SOL_MINT).toBeInstanceOf(Uint8Array)
    expect(C.NATIVE_SOL_MINT.length).toBe(32)
    expect(C.NATIVE_SOL_MINT.every((b) => b === 0)).toBe(true)
  })

  it('layout sizes', () => {
    expect(C.AUTHORITY_SLOT_SIZE).toBe(34)
    expect(C.WALLET_HEADER_SIZE).toBe(186)
    expect(C.SESSION_HEADER_SIZE).toBe(109)
    expect(C.CASH_MINT_STATE_SIZE).toBe(88)
    expect(C.SLEEVE_ENTRY_SIZE).toBe(40)
  })

  it('PDA seeds', () => {
    expect(C.WALLET_SEED).toBe('machine_wallet')
    expect(C.VAULT_SEED).toBe('machine_vault')
    expect(C.SESSION_SEED).toBe('machine_session')
  })
})
