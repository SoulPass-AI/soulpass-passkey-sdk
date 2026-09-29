/**
 * Off-chain reader for the MachineWallet account body (layout v1 and v2).
 *
 * Lives here (not in `ephemeral-signers.ts`) because the byte layout is an
 * on-chain implementation detail of `machine-wallet`, while ephemeral-signer
 * derivation is the public Squads-v4-style protocol layered on top. Future
 * SDK additions that consume other fields (e.g. `creation_slot` for a
 * sponsored Execute preflight) belong here too.
 *
 * **Why the dApp doesn't read the account directly:** the byte offset and
 * the "missing account ⇒ default 0n" contract (documented below) are both
 * on-chain invariants that change with `state.rs`. Routing through this
 * module makes a layout bump a single-PR rollout — bump SDK minor, every
 * consumer follows on `npm update`. The previous in-dApp `NONCE_OFFSET = 36`
 * literal had no such cross-cutting fixup path.
 */

import type { Connection } from '@solana/web3.js'
import type { StatePda, StatePdaKey } from './types'

/**
 * v1 MachineWallet header layout (53 bytes, fixed):
 *
 * | range   | field           | type            |
 * |---------|-----------------|-----------------|
 * | 0..1    | version         | u8 (= 1)        |
 * | 1..2    | bump            | u8              |
 * | 2..34   | wallet_id       | [u8; 32]        |
 * | 34..35  | threshold       | u8              |
 * | 35..36  | authority_count | u8              |
 * | 36..44  | nonce           | u64 LE          |
 * | 44..52  | creation_slot   | u64 LE          |
 * | 52..53  | vault_bump      | u8              |
 *
 * Authority slots (34 bytes each: `sig_scheme(1) || pubkey(33)`) follow the
 * header. The set of offset / size constants below mirrors
 * `machine-wallet/program/src/state.rs::MachineWallet` byte-for-byte.
 */
export const V1_OFFSET = {
  VERSION: 0,
  BUMP: 1,
  WALLET_ID: 2,
  THRESHOLD: 34,
  AUTHORITY_COUNT: 35,
  NONCE: 36,
  CREATION_SLOT: 44,
  VAULT_BUMP: 52,
  AUTHORITY_SLOTS_START: 53,
} as const

export const V1_HEADER_SIZE = 53
/** Stored pubkey width, one byte after the slot's `sig_scheme` tag. */
export const AUTHORITY_PUBKEY_SIZE = 33
export const AUTHORITY_SLOT_SIZE = 1 + AUTHORITY_PUBKEY_SIZE
export const V1_MIN_ACCOUNT_SIZE = V1_HEADER_SIZE + AUTHORITY_SLOT_SIZE

/**
 * Wallet layout versions (mirror `state.rs::MachineWallet::LAYOUT_VERSION{,_V2}`).
 * v2 = the v1 body (header + N slots, offsets unchanged) followed by ONE
 * trailing 34-byte root slot at `53 + N×34`; total `53 + N×34 + 34`.
 * Every wallet the v2 program creates (and every wallet that ran AdoptRoot)
 * is v2. The version byte `2` is shared with SessionState v2 — the lengths are
 * disjoint (wallet ≤ 631, session v2 ≥ 856), which the exact-length check
 * below turns into a hard reject.
 */
export const WALLET_LAYOUT_V1 = 1
export const WALLET_LAYOUT_V2 = 2

/** Exact account length for a wallet of `version` with `authorityCount` slots. */
export function walletAccountSize(version: 1 | 2, authorityCount: number): number {
  return (
    V1_HEADER_SIZE +
    authorityCount * AUTHORITY_SLOT_SIZE +
    (version === WALLET_LAYOUT_V2 ? AUTHORITY_SLOT_SIZE : 0)
  )
}

/**
 * Authority signature schemes (mirror `program/src/state.rs::SigScheme`).
 * The chain scanner uses these tags to route a stored authority to the
 * correct signature verifier; **registering the wrong scheme silently locks
 * the signer out**, so callers should always use these named values rather
 * than literal `0`/`1`/`2`.
 */
export const SigScheme = {
  /** Raw P-256 ECDSA — signer signs the 32-byte operation_hash directly. */
  Secp256r1: 0,
  /** Ed25519 — session keys + Ed25519 hardware. */
  Ed25519: 1,
  /** P-256 ECDSA via WebAuthn envelope — chain expects `auth_data ‖ sha256(cdj)`. */
  Webauthn: 2,
} as const

export type SigSchemeValue = (typeof SigScheme)[keyof typeof SigScheme]

/**
 * Narrow a raw slot byte to a known scheme. Kept as three explicit comparisons
 * to mirror `state.rs::deserialize_inner` line-for-line — a lookup table would
 * read differently from the chain code this module exists to shadow.
 */
function isKnownSigScheme(b: number): b is SigSchemeValue {
  return b === SigScheme.Secp256r1 || b === SigScheme.Ed25519 || b === SigScheme.Webauthn
}

/**
 * One decoded authority slot. `pubkey` is the raw 33-byte STORAGE form, which
 * is layout, not the key itself: `Secp256r1`/`Webauthn` slots hold a genuine
 * SEC1-compressed P-256 key, while `Ed25519` slots hold a 32-byte key padded
 * with a trailing `0x00`. Use {@link effectiveAuthorityKey} to cross from
 * storage form to the bytes a verifier actually consumes.
 */
export interface WalletAuthoritySlot {
  sigScheme: SigSchemeValue
  /**
   * 33-byte authority slot bytes (see storage-form note above). A **copy**,
   * not a view onto the caller's buffer — deliberately, since parsed states
   * get cached and a `subarray` would pin the whole RPC buffer alive.
   */
  pubkey: Uint8Array
}

/**
 * Project a stored authority slot onto the byte form its verifier consumes:
 * 32 bytes for `Ed25519` (the trailing storage pad dropped), the full 33 for
 * the P-256 schemes.
 *
 * This lives in the SDK rather than in each caller because it is a property of
 * the on-chain slot layout, not a display choice: passing slot bytes straight
 * to the Ed25519 precompile trips its 32-byte precondition. The Swift SDK
 * carries the same projection as `SignatureScheme.effectivePubkey(fromSlot:)`
 * — keep the two in lockstep.
 *
 * Returns a copy, matching {@link WalletAuthoritySlot.pubkey}'s ownership rule,
 * so mutating the result can't reach back into the parsed state.
 */
export function effectiveAuthorityKey(slot: WalletAuthoritySlot): Uint8Array {
  return slot.sigScheme === SigScheme.Ed25519
    ? slot.pubkey.slice(0, 32)
    : slot.pubkey.slice()
}

/**
 * Decoded MachineWallet account (layout v1 or v2). Returned by {@link parseWalletState}.
 *
 * `sigScheme` + `authority` mirror the *first* authority slot (back-compat
 * with the single-authority era); `authorities` carries every slot, in
 * on-chain order, so multi-owner surfaces don't re-derive byte offsets.
 */
export interface MachineWalletState {
  version: 1 | 2
  bump: number
  walletId: Uint8Array // 32 bytes (keccak256(authority))
  threshold: number
  authorityCount: number
  nonce: bigint
  creationSlot: bigint
  vaultBump: number
  sigScheme: SigSchemeValue
  /**
   * First authority's 33-byte storage-form pubkey — the *same* `Uint8Array`
   * instance as `authorities[0].pubkey`, not a second copy. Slot 0 is not
   * necessarily P-256; read `sigScheme` before routing it to a verifier.
   */
  authority: Uint8Array
  /** Every authority slot, in on-chain order. `authorities[0]` ≡ `{ sigScheme, pubkey: authority }`. */
  authorities: ReadonlyArray<WalletAuthoritySlot>
  /**
   * v2 root slot (the authority that alone may remove authorities, change the
   * threshold, close the wallet, rotate the root). Always one of
   * `authorities` (same scheme and pubkey). `null` on v1 wallets.
   */
  root: WalletAuthoritySlot | null
}

/**
 * Distinct class so lazy-deploy callers can `instanceof`-match on it without
 * resorting to error-message string sniffing. "Wallet PDA has no on-chain
 * account yet" is a recoverable state (popup will lazy-create on first sign);
 * a generic Error from {@link parseWalletState} (wrong version, truncated
 * body) is not.
 */
export class WalletNotDeployedError extends Error {
  constructor(public readonly walletAddress: StatePda) {
    super(`MachineWallet not found: ${walletAddress}`)
    this.name = 'WalletNotDeployedError'
  }
}

/**
 * Parse a raw account body into a typed {@link WalletState}. Mirrors
 * `state.rs::MachineWallet::deserialize` byte-for-byte.
 *
 * Throws if the body is shorter than the v1 minimum, the version byte is
 * neither `1` nor `2`, `authority_count` is zero, the length is not EXACTLY
 * `walletAccountSize(version, authority_count)` (the chain's own
 * `deserialize_inner` rule — it also keeps a SessionState v2 body, which
 * shares version byte 2, from decoding as a wallet), a slot carries an
 * unknown scheme, or a v2 root is not one of the authorities. All are
 * unrecoverable — distinct from "account doesn't exist yet" which is the
 * caller's responsibility to detect (typically by checking `getAccountInfo`
 * returned null, then throwing {@link WalletNotDeployedError}).
 */
export function parseWalletState(data: Uint8Array): MachineWalletState {
  if (data.length < V1_MIN_ACCOUNT_SIZE) {
    throw new Error(
      `MachineWallet account too small: ${data.length} < ${V1_MIN_ACCOUNT_SIZE}`,
    )
  }

  const rawVersion = data[V1_OFFSET.VERSION]
  if (rawVersion !== WALLET_LAYOUT_V1 && rawVersion !== WALLET_LAYOUT_V2) {
    throw new Error(`Unsupported MachineWallet version: ${rawVersion} (expected 1 or 2)`)
  }
  const version: 1 | 2 = rawVersion

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const authorityCount = data[V1_OFFSET.AUTHORITY_COUNT]
  if (authorityCount < 1) {
    throw new Error(`Invalid authority_count: ${authorityCount}`)
  }
  // Exact length, per version — the chain's rule (`state.rs::deserialize_inner`
  // `src.len() != account_size_v(version, count)`). `CreateWallet`/`realloc`
  // always size the account exactly, so a real wallet never carries trailing
  // bytes; with v2 the trailing slot IS data (the root), so a lenient `<`
  // would read a root from whatever sits at `53 + N×34`.
  const expected = walletAccountSize(version, authorityCount)
  if (data.length !== expected) {
    const what = data.length < expected ? 'too small' : 'has trailing bytes'
    throw new Error(
      `MachineWallet account ${what}: ${data.length} != ${expected} for v${version} with ${authorityCount} authorities`,
    )
  }

  const authorities: WalletAuthoritySlot[] = []
  for (let i = 0; i < authorityCount; i++) {
    const slotStart = V1_OFFSET.AUTHORITY_SLOTS_START + i * AUTHORITY_SLOT_SIZE
    const sigSchemeRaw = data[slotStart]
    // The lock-out guard applies to EVERY slot: an unknown scheme byte in any
    // slot means this SDK build can't tell which verifier that authority
    // routes to, and guessing silently locks the signer out. This mirrors the
    // chain — `state.rs::deserialize_inner` rejects the whole account for the
    // same reason, so such an account can't exist on chain today.
    //
    // Known divergence: the Swift SDK decodes tolerantly instead, keeping the
    // unknown byte raw on `OnChainAuthority.sigScheme`. If a future scheme
    // ships without a `version` bump, Swift readers degrade and TS readers
    // throw. Deliberate — TS stays symmetric with the on-chain read contract.
    if (!isKnownSigScheme(sigSchemeRaw)) {
      throw new Error(`Unknown sig_scheme byte: ${sigSchemeRaw}`)
    }
    authorities.push({
      sigScheme: sigSchemeRaw,
      pubkey: data.slice(slotStart + 1, slotStart + 1 + AUTHORITY_PUBKEY_SIZE),
    })
  }

  let root: WalletAuthoritySlot | null = null
  if (version === WALLET_LAYOUT_V2) {
    const off = walletAccountSize(WALLET_LAYOUT_V1, authorityCount)
    const scheme = data[off]
    if (!isKnownSigScheme(scheme)) {
      throw new Error(`Unknown root sig_scheme byte: ${scheme}`)
    }
    const pubkey = data.slice(off + 1, off + 1 + AUTHORITY_PUBKEY_SIZE)
    // Chain rule: the root must be a current authority (same scheme AND pubkey).
    const isAuthority = authorities.some(
      (a) => a.sigScheme === scheme && a.pubkey.every((b, i) => b === pubkey[i]),
    )
    if (!isAuthority) {
      throw new Error('MachineWallet v2 root is not one of its authorities')
    }
    root = { sigScheme: scheme, pubkey }
  }

  return {
    version,
    bump: data[V1_OFFSET.BUMP],
    walletId: data.slice(V1_OFFSET.WALLET_ID, V1_OFFSET.WALLET_ID + 32),
    threshold: data[V1_OFFSET.THRESHOLD],
    authorityCount,
    nonce: view.getBigUint64(V1_OFFSET.NONCE, true),
    creationSlot: view.getBigUint64(V1_OFFSET.CREATION_SLOT, true),
    vaultBump: data[V1_OFFSET.VAULT_BUMP],
    sigScheme: authorities[0].sigScheme,
    authority: authorities[0].pubkey,
    authorities,
    root,
  }
}

/**
 * Fetch + parse helper. Throws {@link WalletNotDeployedError} when the
 * account doesn't exist (recoverable — the popup lazy-creates on first sign)
 * and re-throws any parse failure verbatim (unrecoverable from this layer).
 */
export async function getWalletState(
  connection: Connection,
  walletAddress: StatePdaKey,
): Promise<MachineWalletState> {
  const account = await connection.getAccountInfo(walletAddress, 'confirmed')
  if (!account || !account.data) {
    // A PublicKey is already a valid 32-byte key; only the brand is added.
    throw new WalletNotDeployedError(walletAddress.toBase58() as StatePda)
  }
  return parseWalletState(new Uint8Array(account.data))
}

/**
 * Returns the `wallet.nonce` value the next `MachineWallet::Execute` will
 * observe — `0n` if the wallet hasn't been deployed yet on this cluster.
 *
 * Why `0n` is the correct fallback for an undeployed wallet
 * --------------------------------------------------------
 * For passkey (WebAuthn) wallets, the soulpass.ai popup lazy-deploys the
 * MachineWallet PDA when it sees a sign request against a missing account:
 * it submits `CreateWallet` (which initialises `nonce = 0`) and then the
 * dApp's `Execute` in two ordered txs — they can't be bundled because
 * `Execute`'s `operation_hash` is bound to `creation_slot`, which is only
 * fixed once `CreateWallet` lands on chain (see
 * `machine-wallet/program/src/processor/create_wallet.rs` and the
 * `compute_message_hash_v1` discussion in `processor/execute.rs`).
 *
 * The dApp doesn't see those two txs — from its perspective it hands one
 * `Execute` (with inner ixs) to the popup and gets back a signature.
 * `nonce` only increments **inside** `Execute`, so when the chain reads
 * `wallet.nonce` to verify ephemeral-signer PDAs against the dApp-supplied
 * `ephemeralSignerBumps`, it reads `0`. Deriving ephemeral PDAs with
 * `walletNonce: 0n` therefore yields the same PDAs `invoke_signed` will
 * produce — signer privilege grants line up, no `MessageMismatch`.
 *
 * Why this isn't a "may break later" hack
 * ---------------------------------------
 * The on-chain `CreateWallet` initialiser writes `nonce = 0` unconditionally
 * (see `state.rs::MachineWallet::new`). The popup's lazy-deploy
 * choreography is the SDK ↔ popup contract: changing it on either side
 * requires a coordinated rollout, of which this function is the dApp-facing
 * surface. If a future MachineWallet version needs a non-zero starting
 * nonce, that version is necessarily a `state.rs` bump too — the version
 * gating below would reject it, and the SDK helper signature would change
 * accordingly.
 *
 * Throws
 * ------
 * Re-throws any {@link parseWalletState} failure (wrong version, truncated
 * body, unknown sig_scheme) verbatim — those are real format incompatibilities
 * distinct from the recoverable "not deployed yet" case.
 */
export async function predictNextExecuteNonce(
  connection: Connection,
  walletAddress: StatePdaKey,
): Promise<bigint> {
  try {
    const state = await getWalletState(connection, walletAddress)
    return state.nonce
  } catch (e) {
    if (e instanceof WalletNotDeployedError) return 0n
    throw e
  }
}
