// @vitest-environment node
//
// Companion to wallet-state.test.ts — that file covers `predictNextExecuteNonce`'s
// RPC fallback contract; this one covers the pure `parseWalletState` byte-decoder
// added alongside the wire-format split.

import { describe, it, expect } from 'vitest'
import {
  parseWalletState,
  V1_HEADER_SIZE,
  V1_OFFSET,
  AUTHORITY_SLOT_SIZE,
  SigScheme,
  type MachineWalletState,
} from '../src/wallet-state'

function makeAccount(opts: {
  version?: number
  bump?: number
  walletIdFill?: number
  threshold?: number
  authorityCount?: number
  nonce?: bigint
  creationSlot?: bigint
  vaultBump?: number
  sigScheme?: number
  authorityFill?: number
  trailingBytes?: number
}): Uint8Array {
  const authorityCount = opts.authorityCount ?? 1
  const buf = Buffer.alloc(
    V1_HEADER_SIZE + authorityCount * AUTHORITY_SLOT_SIZE + (opts.trailingBytes ?? 0),
    0,
  )

  buf[V1_OFFSET.VERSION] = opts.version ?? 1
  buf[V1_OFFSET.BUMP] = opts.bump ?? 254
  if (opts.walletIdFill !== undefined) {
    buf.fill(opts.walletIdFill, V1_OFFSET.WALLET_ID, V1_OFFSET.WALLET_ID + 32)
  }
  buf[V1_OFFSET.THRESHOLD] = opts.threshold ?? 1
  buf[V1_OFFSET.AUTHORITY_COUNT] = authorityCount
  buf.writeBigUInt64LE(opts.nonce ?? 0n, V1_OFFSET.NONCE)
  buf.writeBigUInt64LE(opts.creationSlot ?? 0n, V1_OFFSET.CREATION_SLOT)
  buf[V1_OFFSET.VAULT_BUMP] = opts.vaultBump ?? 253

  const slotStart = V1_OFFSET.AUTHORITY_SLOTS_START
  buf[slotStart] = opts.sigScheme ?? SigScheme.Webauthn
  if (opts.authorityFill !== undefined) {
    buf.fill(opts.authorityFill, slotStart + 1, slotStart + 1 + 33)
  } else {
    // 33-byte compressed P-256: prefix 0x02 + 32 bytes X. Use a fixed pattern.
    buf[slotStart + 1] = 0x02
    buf.fill(0xab, slotStart + 2, slotStart + 1 + 33)
  }

  return new Uint8Array(buf)
}

describe('parseWalletState', () => {
  it('decodes a well-formed v1 single-authority account', () => {
    const data = makeAccount({
      bump: 250,
      walletIdFill: 0x42,
      threshold: 1,
      nonce: 0x0123456789abcdefn,
      creationSlot: 0xabcd_ef01_2345_6789n,
      vaultBump: 200,
      sigScheme: SigScheme.Webauthn,
      authorityFill: undefined,
    })

    const state: MachineWalletState = parseWalletState(data)
    expect(state.version).toBe(1)
    expect(state.bump).toBe(250)
    expect(state.walletId.length).toBe(32)
    expect(Array.from(state.walletId).every((b) => b === 0x42)).toBe(true)
    expect(state.threshold).toBe(1)
    expect(state.authorityCount).toBe(1)
    expect(state.nonce).toBe(0x0123456789abcdefn)
    expect(state.creationSlot).toBe(0xabcd_ef01_2345_6789n)
    expect(state.vaultBump).toBe(200)
    expect(state.sigScheme).toBe(SigScheme.Webauthn)
    expect(state.authority.length).toBe(33)
    expect(state.authority[0]).toBe(0x02)
  })

  it('rejects an account smaller than v1 minimum', () => {
    expect(() => parseWalletState(new Uint8Array(V1_HEADER_SIZE - 1))).toThrow(
      /account too small/i,
    )
  })

  it('rejects a version byte != 1', () => {
    expect(() => parseWalletState(makeAccount({ version: 2 }))).toThrow(
      /unsupported.*version/i,
    )
  })

  it('rejects authority_count = 0 (chain enforces ≥ 1)', () => {
    // Allocate one authority slot's worth of bytes so the body passes the
    // `V1_MIN_ACCOUNT_SIZE` gate, then override the header byte to 0. We
    // want the `authority_count` check itself to fire, not the size check —
    // those are two distinct failure modes the parser must surface.
    const data = makeAccount({ authorityCount: 1 })
    const buf = Buffer.from(data)
    buf[V1_OFFSET.AUTHORITY_COUNT] = 0
    expect(() => parseWalletState(new Uint8Array(buf))).toThrow(
      /invalid authority_count/i,
    )
  })

  it('rejects an unknown sig_scheme byte (silent lock-out guard)', () => {
    expect(() =>
      parseWalletState(makeAccount({ sigScheme: 99 })),
    ).toThrow(/sig_scheme/i)
  })

  it('reads only the FIRST authority slot when multiple are present', () => {
    // Layout: header + 2 slots. We fill slot 0 with 0x02-prefixed pubkey
    // pattern, slot 1 with 0x03 prefix — parseWalletState must return the
    // first.
    const data = makeAccount({ authorityCount: 2, authorityFill: undefined })
    const slot1Start = V1_OFFSET.AUTHORITY_SLOTS_START + AUTHORITY_SLOT_SIZE
    const buf = Buffer.from(data)
    buf[slot1Start] = SigScheme.Ed25519
    buf[slot1Start + 1] = 0x03

    const state = parseWalletState(new Uint8Array(buf))
    expect(state.authorityCount).toBe(2)
    expect(state.sigScheme).toBe(SigScheme.Webauthn)
    expect(state.authority[0]).toBe(0x02)
  })

  it('rejects when authority_count > what the body can hold', () => {
    // Body sized for 1 authority but header claims 2 — caller-side data
    // corruption case that the chain would reject too.
    const data = makeAccount({ authorityCount: 1 })
    const buf = Buffer.from(data)
    buf[V1_OFFSET.AUTHORITY_COUNT] = 2
    expect(() => parseWalletState(new Uint8Array(buf))).toThrow(
      /account too small/i,
    )
  })
})
