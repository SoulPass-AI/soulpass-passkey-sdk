// @vitest-environment node
//
// Companion to wallet-state.test.ts — that file covers `predictNextExecuteNonce`'s
// RPC fallback contract; this one covers the pure `parseWalletState` byte-decoder.
// Offsets below are written out from `machine-wallet/program/src/state.rs`
// (`MachineWallet`) rather than imported, so a drift in the decoder's own
// offsets cannot hide behind a shared constant.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { hexToBytes } from '@noble/hashes/utils'
import {
  walletAccountSize,
  nextSessionGeneration,
  parseWalletState,
  effectiveAuthorityKey,
  isRoot,
  findAuthority,
  SigScheme,
  type MachineWalletState,
  type WalletAuthoritySlot,
} from '../src/wallet-state'
import { deriveVaultPDA } from '../src/adapters/solana'
import { asStatePdaKey } from '../src/types'

const OFF = {
  TAG: 0,
  BUMP: 1,
  WALLET_ID: 2,
  THRESHOLD: 34,
  AUTHORITY_COUNT: 35,
  NONCE: 36,
  CREATION_SLOT: 44,
  VAULT_BUMP: 52,
  ROOT: 53,
  AUTHORITY_EPOCH: 87,
  PENDING_ROOT: 95,
  RECOVERY_ETA: 129,
  VAULT: 137,
  RECOVERY_THRESHOLD: 169,
  SESSION_NONCE: 170,
  GOVERNANCE_NONCE: 178,
  AUTHORITIES: 186,
} as const
const SLOT = 34

/** A valid compressed P-256 point (x of the generator), 33 bytes. */
const P256_KEY = hexToBytes('036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296')

/** 33-byte Ed25519 storage form: 32 key bytes + the trailing 0x00 pad. */
function ed25519SlotForm(fill: number): Uint8Array {
  const out = new Uint8Array(33)
  out.fill(fill, 0, 32)
  return out
}

const PASSKEY: WalletAuthoritySlot = { sigScheme: SigScheme.Webauthn, pubkey: P256_KEY }
const SE_KEY: WalletAuthoritySlot = { sigScheme: SigScheme.Ed25519, pubkey: ed25519SlotForm(0xcd) }

function writeSlot(buf: Uint8Array, off: number, slot: { sigScheme: number; pubkey: Uint8Array }) {
  buf[off] = slot.sigScheme
  buf.set(slot.pubkey, off + 1)
}

/**
 * A program-shaped 'W' account: 186-byte header + one slot per authority,
 * with `vault` derived from a real wallet PDA and `vault_bump`.
 */
function makeAccount(opts: {
  authorities?: WalletAuthoritySlot[]
  root?: WalletAuthoritySlot
  threshold?: number
  nonce?: bigint
  sessionNonce?: bigint
  governanceNonce?: bigint
  creationSlot?: bigint
  authorityEpoch?: bigint
  pending?: { slot: WalletAuthoritySlot; eta: bigint }
  recoveryThreshold?: number
} = {}): { data: Uint8Array; vault: Uint8Array; walletPda: Uint8Array } {
  const authorities = opts.authorities ?? [PASSKEY]
  const n = authorities.length
  const buf = new Uint8Array(186 + n * SLOT)
  const walletPda = Keypair.generate().publicKey
  const vaultBump = 255
  let vault: Uint8Array | undefined
  // Walk bumps down until the vault seeds land off-curve, as the program's
  // find_program_address did at creation.
  for (let b = vaultBump; vault === undefined; b--) {
    try {
      vault = deriveVaultPDA(asStatePdaKey(walletPda), b).toBytes()
      buf[OFF.VAULT_BUMP] = b
    } catch {
      /* on-curve: next bump */
    }
  }
  buf[OFF.TAG] = 0x57
  buf[OFF.BUMP] = 254
  buf.fill(0x42, OFF.WALLET_ID, OFF.WALLET_ID + 32)
  buf[OFF.THRESHOLD] = opts.threshold ?? 1
  buf[OFF.AUTHORITY_COUNT] = n
  const view = new DataView(buf.buffer)
  view.setBigUint64(OFF.NONCE, opts.nonce ?? 0n, true)
  view.setBigUint64(OFF.SESSION_NONCE, opts.sessionNonce ?? 0n, true)
  view.setBigUint64(OFF.GOVERNANCE_NONCE, opts.governanceNonce ?? 0n, true)
  view.setBigUint64(OFF.CREATION_SLOT, opts.creationSlot ?? 0n, true)
  writeSlot(buf, OFF.ROOT, opts.root ?? authorities[0])
  view.setBigUint64(OFF.AUTHORITY_EPOCH, opts.authorityEpoch ?? 0n, true)
  if (opts.pending) {
    writeSlot(buf, OFF.PENDING_ROOT, opts.pending.slot)
    view.setBigUint64(OFF.RECOVERY_ETA, opts.pending.eta, true)
  } else {
    buf[OFF.PENDING_ROOT] = 0xff
  }
  buf.set(vault, OFF.VAULT)
  buf[OFF.RECOVERY_THRESHOLD] = opts.recoveryThreshold ?? 0
  authorities.forEach((a, i) => writeSlot(buf, OFF.AUTHORITIES + i * SLOT, a))
  return { data: buf, vault, walletPda: walletPda.toBytes() }
}

describe('parseWalletState', () => {
  it('decodes a well-formed single-authority account, vault included', () => {
    const { data, vault } = makeAccount({
      // Distinct N, S, G: a counter read from the wrong offset fails.
      nonce: 0x0123456789abcdefn,
      sessionNonce: 0x1111_2222_3333_4444n,
      governanceNonce: 0x5555_6666_7777_8888n,
      creationSlot: 0xabcd_ef01_2345_6789n,
      authorityEpoch: 9n,
    })
    const s: MachineWalletState = parseWalletState(data)
    expect(s.bump).toBe(254)
    expect(Array.from(s.walletId).every((b) => b === 0x42)).toBe(true)
    expect(s.threshold).toBe(1)
    expect(s.authorityCount).toBe(1)
    expect(s.nonce).toBe(0x0123456789abcdefn)
    expect(s.sessionNonce).toBe(0x1111_2222_3333_4444n)
    expect(s.governanceNonce).toBe(0x5555_6666_7777_8888n)
    expect(nextSessionGeneration(s)).toBe(0x0123456789abcdf0n)
    expect(s.creationSlot).toBe(0xabcd_ef01_2345_6789n)
    expect(s.authorityEpoch).toBe(9n)
    expect(s.pendingRoot).toBeNull()
    expect(s.recoveryEta).toBe(0n)
    expect(s.vault).toEqual(vault)
    expect(s.recoveryThreshold).toBe(0)
    expect(s.authorities).toEqual([PASSKEY])
    expect(s.root).toEqual(PASSKEY)
  })

  it('walletAccountSize is 186 + 34n', () => {
    expect(walletAccountSize(1)).toBe(220)
    expect(walletAccountSize(2)).toBe(254)
    expect(walletAccountSize(16)).toBe(730)
  })

  it('rejects a body shorter than the header', () => {
    expect(() => parseWalletState(new Uint8Array(169))).toThrow(/too small/i)
  })

  it('rejects threshold 0, threshold > count, count 0 and count > 16', () => {
    const cases: [number, number][] = [
      [0, 1],
      [2, 1],
      [1, 0],
      [1, 17],
    ]
    for (const [threshold, count] of cases) {
      const { data } = makeAccount()
      data[OFF.THRESHOLD] = threshold
      data[OFF.AUTHORITY_COUNT] = count
      expect(() => parseWalletState(data), `t=${threshold} n=${count}`).toThrow(
        /threshold|authority_count/i,
      )
    }
  })

  it('rejects an unknown sig_scheme in any authority slot (silent lock-out guard)', () => {
    const { data } = makeAccount({ authorities: [PASSKEY, SE_KEY] })
    data[OFF.AUTHORITIES + SLOT] = 99
    expect(() => parseWalletState(data)).toThrow(/sig_scheme/i)
  })

  it('rejects a malformed authority key, as the program deserializer does', () => {
    const badP256 = makeAccount({ authorities: [PASSKEY, SE_KEY] }).data
    badP256[OFF.AUTHORITIES + 1] = 0x04 // not a compressed SEC1 prefix
    const badPad = makeAccount({ authorities: [PASSKEY, SE_KEY] }).data
    badPad[OFF.AUTHORITIES + SLOT + 33] = 0x01 // Ed25519 pad byte
    for (const d of [badP256, badPad]) {
      expect(() => parseWalletState(d)).toThrow(/invalid authority pubkey/i)
    }
  })

  it('rejects an unknown root sig_scheme', () => {
    const { data } = makeAccount()
    data[OFF.ROOT] = 7
    expect(() => parseWalletState(data)).toThrow(/root sig_scheme/i)
  })

  it('rejects a pending root with an unknown scheme, and an EMPTY scheme with a non-zero key', () => {
    const unknown = makeAccount().data
    unknown[OFF.PENDING_ROOT] = 7
    const notEmpty = makeAccount().data
    notEmpty[OFF.PENDING_ROOT + 1] = 1 // scheme 0xff, key not all zero
    for (const d of [unknown, notEmpty]) {
      expect(() => parseWalletState(d)).toThrow(/pending root/i)
    }
  })

  it('pendingEmptyRequiresEtaZero', () => {
    const { data } = makeAccount()
    new DataView(data.buffer).setBigUint64(OFF.RECOVERY_ETA, 1n, true)
    expect(() => parseWalletState(data)).toThrow(/recovery_eta/i)
  })

  it('accepts a known-scheme pending root with eta 0, as the program does', () => {
    const { data } = makeAccount({
      authorities: [PASSKEY, SE_KEY],
      pending: { slot: SE_KEY, eta: 0n },
    })
    const s = parseWalletState(data)
    expect(s.pendingRoot).toEqual(SE_KEY)
    expect(s.recoveryEta).toBe(0n)
  })

  it('rejects recovery_threshold > authority_count', () => {
    const { data } = makeAccount({ recoveryThreshold: 2 })
    expect(() => parseWalletState(data)).toThrow(/recovery_threshold/i)
  })

  it('returns copies, never views into the caller buffer', () => {
    const { data } = makeAccount()
    const s = parseWalletState(data)
    data.fill(0)
    expect(s.authorities[0].pubkey).toEqual(P256_KEY)
    expect(s.root.pubkey).toEqual(P256_KEY)
    expect(s.vault.some((b) => b !== 0)).toBe(true)
  })

  it('projects each slot onto its verifier form via effectiveAuthorityKey', () => {
    const s = parseWalletState(makeAccount({ authorities: [PASSKEY, SE_KEY] }).data)
    expect(effectiveAuthorityKey(s.authorities[0])).toEqual(P256_KEY)
    expect(effectiveAuthorityKey(s.authorities[1])).toEqual(new Uint8Array(32).fill(0xcd))
    const projected = effectiveAuthorityKey(s.authorities[0])
    projected[0] = 0xff
    expect(s.authorities[0].pubkey[0]).toBe(0x03)
  })

  it('isRoot and findAuthority compare (scheme, pubkey)', () => {
    const s = parseWalletState(
      makeAccount({ authorities: [SE_KEY, PASSKEY], root: PASSKEY }).data,
    )
    expect(isRoot(s, PASSKEY)).toBe(true)
    expect(isRoot(s, SE_KEY)).toBe(false)
    // Same key bytes under another scheme is a different authority.
    expect(isRoot(s, { sigScheme: SigScheme.Secp256r1, pubkey: P256_KEY })).toBe(false)
    expect(findAuthority(s, SE_KEY)).toBe(0)
    expect(findAuthority(s, PASSKEY)).toBe(1)
    expect(findAuthority(s, { sigScheme: SigScheme.Secp256r1, pubkey: P256_KEY })).toBe(-1)
  })
})

// ── machine-wallet layout KAT ────────────────────────────────────────────
//
// `tests/fixtures/layout_kat.json` is a verbatim copy of the program's vector
// file of the same name.

interface LayoutVector {
  name: string
  fields: { name: string; hex: string }[]
  length: number
  bytes_hex: string
}
const layoutKat: { vectors: LayoutVector[] } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/layout_kat.json'), 'utf8'),
)
const kat = (name: string): LayoutVector => {
  const v = layoutKat.vectors.find((x) => x.name === name)
  if (!v) throw new Error(`layout_kat.json is missing ${name}`)
  return v
}
const katField = (v: LayoutVector, name: string): Uint8Array => {
  const f = v.fields.find((x) => x.name === name)
  if (!f) throw new Error(`${v.name} has no field ${name}`)
  return hexToBytes(f.hex)
}
const u64Field = (v: LayoutVector, name: string): bigint =>
  new DataView(katField(v, name).buffer).getBigUint64(0, true)
const slotField = (v: LayoutVector, name: string): WalletAuthoritySlot => {
  const b = katField(v, name)
  return { sigScheme: b[0] as WalletAuthoritySlot['sigScheme'], pubkey: b.slice(1) }
}

const WALLET_KAT = 'wallet_2auth_passkey_root_pending_recovery'

describe('parseWalletState — layout KAT (program bytes)', () => {
  it(`decodes ${WALLET_KAT} field-for-field`, () => {
    const v = kat(WALLET_KAT)
    const data = hexToBytes(v.bytes_hex)
    expect(data).toHaveLength(254)
    expect(walletAccountSize(2)).toBe(254)

    const s = parseWalletState(data)
    expect(s.bump).toBe(0xfe)
    expect(s.walletId).toEqual(katField(v, 'wallet_id'))
    expect(s.threshold).toBe(katField(v, 'threshold')[0])
    expect(s.authorityCount).toBe(2)
    expect(s.nonce).toBe(u64Field(v, 'nonce_le'))
    expect(s.sessionNonce).toBe(u64Field(v, 'session_nonce_le'))
    expect(s.governanceNonce).toBe(u64Field(v, 'governance_nonce_le'))
    // The program's vector uses distinct counters, so a swapped offset cannot pass.
    expect(new Set([s.nonce, s.sessionNonce, s.governanceNonce]).size).toBe(3)
    expect(s.creationSlot).toBe(u64Field(v, 'creation_slot_le'))
    expect(s.vaultBump).toBe(0xfd)
    expect(s.authorityEpoch).toBe(3n)
    expect(s.pendingRoot).not.toBeNull()
    expect(s.pendingRoot).toEqual(slotField(v, 'pending_root'))
    expect(s.recoveryEta).toBe(u64Field(v, 'recovery_eta_le'))
    expect(s.recoveryEta).toBeGreaterThan(0n)
    expect(s.vault).toEqual(katField(v, 'vault'))
    expect(s.recoveryThreshold).toBe(katField(v, 'recovery_threshold')[0])
    expect(s.authorities).toEqual([slotField(v, 'authority_0'), slotField(v, 'authority_1')])

    // The root is the passkey (scheme 2) among the two authorities.
    const passkey = [slotField(v, 'authority_0'), slotField(v, 'authority_1')].find(
      (a) => a.sigScheme === SigScheme.Webauthn,
    )!
    expect(s.root).toEqual(passkey)
    expect(s.root).toEqual(slotField(v, 'root'))
    expect(isRoot(s, passkey)).toBe(true)
  })

  it('rejectsRetiredAndForeignTags', () => {
    for (const tag of [0, 1, 2, 0x53, 0x99]) {
      const data = hexToBytes(kat(WALLET_KAT).bytes_hex)
      data[0] = tag
      expect(() => parseWalletState(data), `tag ${tag}`).toThrow(
        `Unsupported MachineWallet account tag ${tag}`,
      )
    }
  })

  it('never decodes the session KAT image as a wallet', () => {
    const data = hexToBytes(kat('session_p2_sol_cash1_sleeve1_passkey_creator').bytes_hex)
    expect(() => parseWalletState(data)).toThrow('Unsupported MachineWallet account tag 83')
  })

  it('rejectsLengthMismatch', () => {
    const data = hexToBytes(kat(WALLET_KAT).bytes_hex)
    const long = new Uint8Array(data.length + 1)
    long.set(data)
    expect(() => parseWalletState(long)).toThrow(/trailing bytes/i)
    expect(() => parseWalletState(data.slice(0, -1))).toThrow(/too small/i)
  })

  it('rejectsRootNotAnAuthority', () => {
    const data = hexToBytes(kat(WALLET_KAT).bytes_hex)
    // A valid P-256 key (other parity) that is not on the roster.
    data[OFF.ROOT + 1] = 0x02
    expect(() => parseWalletState(data)).toThrow(/root is not one of its authorities/i)
  })
})
