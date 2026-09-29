// @vitest-environment node
//
// Companion to wallet-state.test.ts — that file covers `predictNextExecuteNonce`'s
// RPC fallback contract; this one covers the pure `parseWalletState` byte-decoder
// added alongside the wire-format split.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { hexToBytes } from '@noble/hashes/utils'
import {
  walletAccountSize,
  parseWalletState,
  effectiveAuthorityKey,
  V1_HEADER_SIZE,
  V1_OFFSET,
  AUTHORITY_SLOT_SIZE,
  SigScheme,
  type MachineWalletState,
} from '../src/wallet-state'

/** Raw storage bytes for one authority slot beyond slot 0. */
interface ExtraSlot {
  sigScheme?: number
  /** Exact 33-byte storage form; defaults to zeros. */
  pubkey?: Uint8Array
}

/** 33-byte Ed25519 storage form: 32 key bytes + the trailing 0x00 pad. */
function ed25519SlotForm(fill: number): Uint8Array {
  const out = new Uint8Array(33)
  out.fill(fill, 0, 32)
  return out
}

function makeAccount(opts: {
  version?: number
  bump?: number
  walletIdFill?: number
  threshold?: number
  extraSlots?: ExtraSlot[]
  nonce?: bigint
  creationSlot?: bigint
  vaultBump?: number
  sigScheme?: number
  authorityFill?: number
}): Uint8Array {
  const extraSlots = opts.extraSlots ?? []
  const authorityCount = 1 + extraSlots.length
  const buf = Buffer.alloc(V1_HEADER_SIZE + authorityCount * AUTHORITY_SLOT_SIZE, 0)

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

  extraSlots.forEach((slot, i) => {
    const start = V1_OFFSET.AUTHORITY_SLOTS_START + (i + 1) * AUTHORITY_SLOT_SIZE
    buf[start] = slot.sigScheme ?? SigScheme.Secp256r1
    if (slot.pubkey) buf.set(slot.pubkey, start + 1)
  })

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

  it('rejects a version byte other than 1 or 2', () => {
    for (const version of [0, 3, 0xff]) {
      expect(() => parseWalletState(makeAccount({ version })), `v${version}`).toThrow(
        /unsupported.*version/i,
      )
    }
  })

  it('rejects a v1 body with trailing bytes (exact length, as the chain)', () => {
    const v1 = makeAccount({})
    const padded = new Uint8Array(v1.length + 1)
    padded.set(v1)
    expect(() => parseWalletState(padded)).toThrow(/trailing bytes/i)
  })

  it('rejects a version-2 body without the trailing root slot', () => {
    // A v1-sized body relabelled v2 is 34 bytes short of its root.
    expect(() => parseWalletState(makeAccount({ version: 2 }))).toThrow(/too small/i)
  })

  it('a v1 wallet has root = null', () => {
    expect(parseWalletState(makeAccount({})).root).toBeNull()
  })

  it('rejects authority_count = 0 (chain enforces ≥ 1)', () => {
    // Allocate one authority slot's worth of bytes so the body passes the
    // `V1_MIN_ACCOUNT_SIZE` gate, then override the header byte to 0. We
    // want the `authority_count` check itself to fire, not the size check —
    // those are two distinct failure modes the parser must surface.
    const data = makeAccount({})
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

  it('parses ALL authority slots into `authorities`', () => {
    // 2-authority fixture: slot 0 webauthn (0x02-prefixed P-256), slot 1
    // ed25519 (32 bytes 0xCD + trailing 0x00 storage padding).
    const slot1 = ed25519SlotForm(0xcd)
    const state = parseWalletState(
      makeAccount({ extraSlots: [{ sigScheme: SigScheme.Ed25519, pubkey: slot1 }] }),
    )
    expect(state.authorityCount).toBe(2)
    expect(state.authorities).toHaveLength(2)

    expect(state.authorities[0].sigScheme).toBe(SigScheme.Webauthn)
    expect(state.authorities[0].pubkey.length).toBe(33)
    expect(state.authorities[0].pubkey[0]).toBe(0x02)
    // Back-compat: the legacy single-slot fields must keep reporting slot 0
    // verbatim even once multiple slots are present.
    expect(state.authorities[0].pubkey).toEqual(state.authority)
    expect(state.authorities[0].sigScheme).toBe(state.sigScheme)

    // Slot 1 round-trips verbatim, trailing 0x00 pad included.
    expect(state.authorities[1].sigScheme).toBe(SigScheme.Ed25519)
    expect(state.authorities[1].pubkey).toEqual(slot1)
  })

  it('exposes a single-element `authorities` for a single-authority account', () => {
    const state = parseWalletState(makeAccount({}))
    expect(state.authorities).toHaveLength(1)
    expect(state.authorities[0].sigScheme).toBe(state.sigScheme)
    expect(state.authorities[0].pubkey).toEqual(state.authority)
  })

  it('rejects an unknown sig_scheme byte in a NON-first slot too', () => {
    // The lock-out guard must cover every slot the caller might route a
    // signature to, not just slot 0.
    expect(() =>
      parseWalletState(makeAccount({ extraSlots: [{ sigScheme: 99 }] })),
    ).toThrow(/sig_scheme/i)
  })

  it('projects each slot onto its verifier form via effectiveAuthorityKey', () => {
    // Storage form is uniformly 33 bytes; only Ed25519 carries a pad to drop.
    const slot1 = ed25519SlotForm(0xcd)
    const state = parseWalletState(
      makeAccount({ extraSlots: [{ sigScheme: SigScheme.Ed25519, pubkey: slot1 }] }),
    )

    // P-256 (webauthn) keeps all 33 bytes — the 0x02 SEC1 prefix is part of it.
    expect(effectiveAuthorityKey(state.authorities[0])).toEqual(state.authorities[0].pubkey)

    // Ed25519 drops the trailing pad, yielding what the precompile accepts.
    expect(effectiveAuthorityKey(state.authorities[1])).toEqual(new Uint8Array(32).fill(0xcd))
  })

  it('returns a copy from effectiveAuthorityKey, never a view into parsed state', () => {
    // The ownership rule the pubkey doc promises: mutating the projection must
    // not reach back into the parsed slot.
    const state = parseWalletState(makeAccount({}))
    const projected = effectiveAuthorityKey(state.authorities[0])
    projected[0] = 0xff
    expect(state.authorities[0].pubkey[0]).toBe(0x02)
  })

  it('rejects when authority_count > what the body can hold', () => {
    // Body sized for 1 authority but header claims 2 — caller-side data
    // corruption case that the chain would reject too.
    const data = makeAccount({})
    const buf = Buffer.from(data)
    buf[V1_OFFSET.AUTHORITY_COUNT] = 2
    expect(() => parseWalletState(new Uint8Array(buf))).toThrow(
      /account too small/i,
    )
  })
})

// ── machine-wallet v2 layout KATs ────────────────────────────────────────
//
// `tests/fixtures/v2_layout_kat.json` is a verbatim copy of machine-wallet
// `program/tests/vectors/v2_layout_kat.json` (ca6073d); check-fixtures keeps it
// byte-identical to the Swift SDK's copy.

interface LayoutVector {
  name: string
  fields: { name: string; hex: string }[]
  length: number
  bytes_hex: string
}
const layoutKat: { vectors: LayoutVector[] } = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/v2_layout_kat.json'),
    'utf8',
  ),
)
const kat = (name: string): LayoutVector => {
  const v = layoutKat.vectors.find((x) => x.name === name)
  if (!v) throw new Error(`v2_layout_kat.json is missing ${name}`)
  return v
}
const katField = (v: LayoutVector, name: string): Uint8Array => {
  const f = v.fields.find((x) => x.name === name)
  if (!f) throw new Error(`${v.name} has no field ${name}`)
  return hexToBytes(f.hex)
}

describe('parseWalletState — v2 KAT (program bytes)', () => {
  it('decodes wallet_v2_2auth_passkey_root field-for-field, root included', () => {
    const v = kat('wallet_v2_2auth_passkey_root')
    const data = hexToBytes(v.bytes_hex)
    expect(data).toHaveLength(155)
    expect(walletAccountSize(2, 2)).toBe(155)

    const s = parseWalletState(data)
    expect(s.version).toBe(2)
    expect(s.bump).toBe(0xfe)
    expect(Array.from(s.walletId)).toEqual(Array.from(katField(v, 'wallet_id')))
    expect(s.threshold).toBe(1)
    expect(s.authorityCount).toBe(2)
    expect(s.nonce).toBe(7n)
    expect(s.creationSlot).toBe(42n)
    expect(s.vaultBump).toBe(0xfd)
    expect(s.authorities).toHaveLength(2)
    const slot = (name: string) => katField(v, name)
    expect(s.authorities[0].sigScheme).toBe(SigScheme.Ed25519)
    expect(Array.from(s.authorities[0].pubkey)).toEqual(Array.from(slot('authority_0').slice(1)))
    expect(s.authorities[1].sigScheme).toBe(SigScheme.Webauthn)
    expect(Array.from(s.authorities[1].pubkey)).toEqual(Array.from(slot('authority_1').slice(1)))
    expect(s.root).not.toBeNull()
    expect(s.root!.sigScheme).toBe(SigScheme.Webauthn)
    expect(Array.from(s.root!.pubkey)).toEqual(Array.from(slot('root').slice(1)))
    // Offsets shared with v1 are unchanged: the nonce still sits at 36.
    expect(V1_OFFSET.NONCE).toBe(36)
  })

  it('rejects the v2 wallet image with a trailing byte or one byte short', () => {
    const data = hexToBytes(kat('wallet_v2_2auth_passkey_root').bytes_hex)
    const long = new Uint8Array(data.length + 1)
    long.set(data)
    expect(() => parseWalletState(long)).toThrow(/trailing bytes/i)
    expect(() => parseWalletState(data.slice(0, -1))).toThrow(/too small/i)
  })

  it('rejects a v2 root that is not one of the authorities', () => {
    const data = hexToBytes(kat('wallet_v2_2auth_passkey_root').bytes_hex)
    data[data.length - 1] ^= 0x01
    expect(() => parseWalletState(data)).toThrow(/root is not one of its authorities/i)
  })

  it('rejects an unknown root sig_scheme', () => {
    const data = hexToBytes(kat('wallet_v2_2auth_passkey_root').bytes_hex)
    data[walletAccountSize(1, 2)] = 7
    expect(() => parseWalletState(data)).toThrow(/unknown root sig_scheme/i)
  })

  it('never decodes a SessionState v2 image (shared version byte 2) as a wallet', () => {
    const v = kat('session_v2_p2_cash1_sleeve1_passkey_creator')
    const data = hexToBytes(v.bytes_hex)
    expect(data).toHaveLength(976)
    expect(data[0]).toBe(2)
    expect(() => parseWalletState(data)).toThrow(/MachineWallet account/i)
  })
})
