/**
 * Off-chain reader for the MachineWallet account (`'W'` tag, 170-byte header).
 *
 * Lives here (not in `ephemeral-signers.ts`) because the byte layout is an
 * on-chain implementation detail of `machine-wallet`, while ephemeral-signer
 * derivation is the public Squads-v4-style protocol layered on top.
 *
 * **Why the dApp doesn't read the account directly:** the byte offsets and
 * the "missing account ⇒ default 0n" contract (documented below) are both
 * on-chain invariants that change with `state.rs`. Routing through this
 * module makes a layout change a single-PR rollout — bump the SDK, every
 * consumer follows on `npm update`.
 */

import type { Connection } from '@solana/web3.js'
import type { StatePda, StatePdaKey } from './types'
import { bytesEqual, isAllZero } from './wire-format/_bytes'
import {
  AUTHORITY_SLOT_SIZE,
  MAX_AUTHORITIES,
  WALLET_ACCOUNT_TAG,
  WALLET_HEADER_SIZE,
} from './wire-format/constants'
import { readKnownSlot, SigScheme, type WalletAuthoritySlot } from './wire-format/authority-slot'

export { AUTHORITY_PUBKEY_SIZE } from './wire-format/constants'
export { SigScheme } from './wire-format/authority-slot'
export type { SigSchemeValue, WalletAuthoritySlot } from './wire-format/authority-slot'

/**
 * `MachineWallet` header offsets (`state.rs`), all integers LE:
 *
 * | offset | field              | type          |
 * |--------|--------------------|---------------|
 * | 0      | tag                | u8 (= 'W')    |
 * | 1      | bump               | u8            |
 * | 2      | wallet_id          | [u8; 32]      |
 * | 34     | threshold          | u8            |
 * | 35     | authority_count    | u8            |
 * | 36     | nonce              | u64           |
 * | 44     | creation_slot      | u64           |
 * | 52     | vault_bump         | u8            |
 * | 53     | root               | AuthoritySlot |
 * | 87     | authority_epoch    | u64           |
 * | 95     | pending_root       | AuthoritySlot |
 * | 129    | recovery_eta       | u64           |
 * | 137    | vault              | [u8; 32]      |
 * | 169    | recovery_threshold | u8            |
 * | 170    | authorities        | [AuthoritySlot; N] |
 */
const OFFSET = {
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
} as const

/** `AuthoritySlot::EMPTY.sig_scheme`: the pending-root slot when no recovery is pending. */
const EMPTY_SLOT_SCHEME = 0xff

/** Exact account length of a wallet with `authorityCount` slots (`MachineWallet::account_size`). */
export function walletAccountSize(authorityCount: number): number {
  if (!Number.isInteger(authorityCount) || authorityCount < 0 || authorityCount > MAX_AUTHORITIES) {
    throw new RangeError(`walletAccountSize: authorityCount must be 0..=${MAX_AUTHORITIES}, got ${authorityCount}`)
  }
  return WALLET_HEADER_SIZE + authorityCount * AUTHORITY_SLOT_SIZE
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

/** Decoded MachineWallet account. Returned by {@link parseWalletState}. */
export interface MachineWalletState {
  bump: number
  /** 32 bytes: keccak256 of the creating authority's pubkey; the wallet PDA seed. */
  walletId: Uint8Array
  threshold: number
  authorityCount: number
  nonce: bigint
  creationSlot: bigint
  vaultBump: number
  /**
   * The root authority: alone may remove authorities, change the threshold,
   * close the wallet and rotate the root. Always one of `authorities`.
   */
  root: WalletAuthoritySlot
  /**
   * Bumped whenever the trust basis of existing sessions changes (an authority
   * removed, the root moved, the threshold changed, BumpEpoch). A session is
   * live only while its recorded epoch equals this.
   */
  authorityEpoch: bigint
  /** The authority a pending recovery hands the root to; `null` when none is pending. */
  pendingRoot: WalletAuthoritySlot | null
  /** First slot `ExecuteRecovery` is accepted; always `0n` when `pendingRoot` is `null`. */
  recoveryEta: bigint
  /** 32-byte vault PDA, recorded at creation. */
  vault: Uint8Array
  /** Signatures `ProposeRecovery` needs; 0 = the spending `threshold`. */
  recoveryThreshold: number
  /** Every authority slot, in on-chain order. */
  authorities: WalletAuthoritySlot[]
}

/**
 * Distinct class so lazy-deploy callers can `instanceof`-match on it without
 * resorting to error-message string sniffing. "Wallet PDA has no on-chain
 * account yet" is a recoverable state (popup will lazy-create on first sign);
 * a generic Error from {@link parseWalletState} (wrong tag, truncated body) is
 * not.
 */
export class WalletNotDeployedError extends Error {
  constructor(public readonly walletAddress: StatePda) {
    super(`MachineWallet not found: ${walletAddress}`)
    this.name = 'WalletNotDeployedError'
  }
}

const slotEqual = (a: WalletAuthoritySlot, b: WalletAuthoritySlot): boolean =>
  a.sigScheme === b.sigScheme && bytesEqual(a.pubkey, b.pubkey)

/**
 * `AuthoritySlot::is_valid`: a P-256 key must carry a compressed SEC1 prefix
 * (0x02/0x03) and a non-zero x; an Ed25519 key a zero pad byte and a non-zero
 * key. A format check only, as on chain.
 */
function isValidAuthorityKey(slot: WalletAuthoritySlot): boolean {
  const k = slot.pubkey
  if (slot.sigScheme === SigScheme.Ed25519) {
    return k[32] === 0 && k.subarray(0, 32).some((b) => b !== 0)
  }
  return (k[0] === 0x02 || k[0] === 0x03) && k.subarray(1).some((b) => b !== 0)
}

/**
 * Parse a raw account body into a typed {@link MachineWalletState}. Mirrors
 * `state.rs::MachineWallet::deserialize` (the validating path) and rejects
 * everything it rejects:
 *
 * - byte 0 is not `'W'` (`Unsupported MachineWallet account tag <n>`) — a
 *   session, a retired layout or a foreign account never decodes as a wallet;
 * - `threshold` / `authority_count` outside `1 ≤ threshold ≤ count ≤ 16`;
 * - a length other than exactly {@link walletAccountSize}`(count)`;
 * - an unknown `sig_scheme` or a malformed key in any authority slot;
 * - a root with an unknown scheme or one that is not an authority;
 * - a pending root that is neither the canonical empty encoding (`0xFF ‖ 33×0`,
 *   which requires eta 0) nor a known-scheme slot (any eta, as on chain);
 * - `recovery_threshold > authority_count`.
 *
 * All are unrecoverable — distinct from "account doesn't exist yet", which the
 * caller detects (typically `getAccountInfo` returned null, then
 * {@link WalletNotDeployedError}).
 */
export function parseWalletState(data: Uint8Array): MachineWalletState {
  if (data.length < WALLET_HEADER_SIZE) {
    throw new Error(`MachineWallet account too small: ${data.length} < ${WALLET_HEADER_SIZE}`)
  }
  const tag = data[OFFSET.TAG]
  if (tag !== WALLET_ACCOUNT_TAG) {
    throw new Error(`Unsupported MachineWallet account tag ${tag}`)
  }

  const threshold = data[OFFSET.THRESHOLD]
  const authorityCount = data[OFFSET.AUTHORITY_COUNT]
  if (authorityCount < 1 || authorityCount > MAX_AUTHORITIES) {
    throw new Error(`Invalid authority_count: ${authorityCount} (expected 1..=${MAX_AUTHORITIES})`)
  }
  if (threshold < 1 || threshold > authorityCount) {
    throw new Error(`Invalid threshold: ${threshold} (expected 1..=${authorityCount})`)
  }

  // Exact length: `CreateWallet` / realloc always size the account to
  // `account_size(count)`, so a stale tail slot can never shadow a live one.
  const expected = walletAccountSize(authorityCount)
  if (data.length !== expected) {
    const what = data.length < expected ? 'too small' : 'has trailing bytes'
    throw new Error(
      `MachineWallet account ${what}: ${data.length} != ${expected} for ${authorityCount} authorities`,
    )
  }

  const authorities: WalletAuthoritySlot[] = []
  for (let i = 0; i < authorityCount; i++) {
    const slot = readKnownSlot(data, WALLET_HEADER_SIZE + i * AUTHORITY_SLOT_SIZE, `authority slot ${i}`)
    if (!isValidAuthorityKey(slot)) {
      throw new Error(`Invalid authority pubkey in slot ${i}`)
    }
    authorities.push(slot)
  }

  const root = readKnownSlot(data, OFFSET.ROOT, 'root')
  if (!authorities.some((a) => slotEqual(a, root))) {
    throw new Error('MachineWallet root is not one of its authorities')
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const recoveryEta = view.getBigUint64(OFFSET.RECOVERY_ETA, true)
  const pendingOff = OFFSET.PENDING_ROOT
  let pendingRoot: WalletAuthoritySlot | null
  if (
    data[pendingOff] === EMPTY_SLOT_SCHEME &&
    isAllZero(data.subarray(pendingOff + 1, pendingOff + AUTHORITY_SLOT_SIZE))
  ) {
    if (recoveryEta !== 0n) {
      throw new Error(`MachineWallet has no pending root but recovery_eta is ${recoveryEta}`)
    }
    pendingRoot = null
  } else {
    pendingRoot = readKnownSlot(data, pendingOff, 'pending root')
  }

  const recoveryThreshold = data[OFFSET.RECOVERY_THRESHOLD]
  if (recoveryThreshold > authorityCount) {
    throw new Error(`Invalid recovery_threshold: ${recoveryThreshold} > authority_count ${authorityCount}`)
  }

  return {
    bump: data[OFFSET.BUMP],
    walletId: data.slice(OFFSET.WALLET_ID, OFFSET.WALLET_ID + 32),
    threshold,
    authorityCount,
    nonce: view.getBigUint64(OFFSET.NONCE, true),
    creationSlot: view.getBigUint64(OFFSET.CREATION_SLOT, true),
    vaultBump: data[OFFSET.VAULT_BUMP],
    root,
    authorityEpoch: view.getBigUint64(OFFSET.AUTHORITY_EPOCH, true),
    pendingRoot,
    recoveryEta,
    vault: data.slice(OFFSET.VAULT, OFFSET.VAULT + 32),
    recoveryThreshold,
    authorities,
  }
}

/** True iff `slot` (scheme AND pubkey) is the wallet's root. */
export function isRoot(state: MachineWalletState, slot: WalletAuthoritySlot): boolean {
  return slotEqual(state.root, slot)
}

/** Index of `slot` (scheme AND pubkey) among the wallet's authorities, or -1. */
export function findAuthority(state: MachineWalletState, slot: WalletAuthoritySlot): number {
  return state.authorities.findIndex((a) => slotEqual(a, slot))
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
 * `machine-wallet/program/src/processor/create_wallet.rs` and
 * `processor/execute.rs`).
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
 * The on-chain `CreateWallet` initialiser writes `nonce = 0` unconditionally.
 * The popup's lazy-deploy choreography is the SDK ↔ popup contract: changing
 * it on either side requires a coordinated rollout, of which this function is
 * the dApp-facing surface. A layout that started elsewhere would carry a new
 * account tag, which {@link parseWalletState} would reject.
 *
 * Throws
 * ------
 * Re-throws any {@link parseWalletState} failure (wrong tag, truncated body,
 * unknown sig_scheme) verbatim — those are real format incompatibilities
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
