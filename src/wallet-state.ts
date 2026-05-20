/**
 * Off-chain reader for the MachineWallet v1 account body.
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
import { asStatePda } from './types'

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
export const AUTHORITY_SLOT_SIZE = 34
export const V1_MIN_ACCOUNT_SIZE = V1_HEADER_SIZE + AUTHORITY_SLOT_SIZE

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
 * Decoded v1 MachineWallet account. Returned by {@link parseWalletState}.
 *
 * `sigScheme` + `authority` are the *first* authority slot only — the current
 * single-authority layout. Multi-authority callers should read additional
 * slots at `V1_OFFSET.AUTHORITY_SLOTS_START + i * AUTHORITY_SLOT_SIZE`.
 */
export interface MachineWalletState {
  version: 1
  bump: number
  walletId: Uint8Array // 32 bytes (keccak256(authority))
  threshold: number
  authorityCount: number
  nonce: bigint
  creationSlot: bigint
  vaultBump: number
  sigScheme: SigSchemeValue
  /** 33-byte SEC1-compressed P-256 pubkey for the first authority. */
  authority: Uint8Array
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
 * Throws if the body is shorter than the v1 minimum, the version byte isn't
 * `1`, or `authority_count` is zero / would over-read the buffer. All three
 * are unrecoverable — distinct from "account doesn't exist yet" which is the
 * caller's responsibility to detect (typically by checking `getAccountInfo`
 * returned null, then throwing {@link WalletNotDeployedError}).
 */
export function parseWalletState(data: Uint8Array): MachineWalletState {
  if (data.length < V1_MIN_ACCOUNT_SIZE) {
    throw new Error(
      `MachineWallet account too small: ${data.length} < ${V1_MIN_ACCOUNT_SIZE}`,
    )
  }

  const version = data[V1_OFFSET.VERSION]
  if (version !== 1) {
    throw new Error(`Unsupported MachineWallet version: ${version} (expected 1)`)
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const authorityCount = data[V1_OFFSET.AUTHORITY_COUNT]
  if (authorityCount < 1) {
    throw new Error(`Invalid authority_count: ${authorityCount}`)
  }
  const expected = V1_HEADER_SIZE + authorityCount * AUTHORITY_SLOT_SIZE
  if (data.length < expected) {
    throw new Error(
      `MachineWallet account too small: ${data.length} < ${expected} for ${authorityCount} authorities`,
    )
  }

  const slotStart = V1_OFFSET.AUTHORITY_SLOTS_START
  const sigSchemeRaw = data[slotStart]
  if (sigSchemeRaw !== SigScheme.Secp256r1 && sigSchemeRaw !== SigScheme.Ed25519 && sigSchemeRaw !== SigScheme.Webauthn) {
    throw new Error(`Unknown sig_scheme byte: ${sigSchemeRaw}`)
  }

  return {
    version: 1,
    bump: data[V1_OFFSET.BUMP],
    walletId: data.slice(V1_OFFSET.WALLET_ID, V1_OFFSET.WALLET_ID + 32),
    threshold: data[V1_OFFSET.THRESHOLD],
    authorityCount,
    nonce: view.getBigUint64(V1_OFFSET.NONCE, true),
    creationSlot: view.getBigUint64(V1_OFFSET.CREATION_SLOT, true),
    vaultBump: data[V1_OFFSET.VAULT_BUMP],
    sigScheme: sigSchemeRaw as SigSchemeValue,
    authority: data.slice(slotStart + 1, slotStart + 1 + 33),
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
    throw new WalletNotDeployedError(asStatePda(walletAddress.toBase58()))
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
