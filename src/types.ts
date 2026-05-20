// --- Branded address types ---
//
// SoulPass wallets carry TWO Solana PDAs with very different semantics:
//   • vault PDA  — SystemProgram-owned, holds funds + ATAs (user-facing).
//   • state PDA  — program-owned MachineWallet account, holds nonce /
//                  authorities / threshold (protocol seed for ephemeral
//                  signer derivation + Execute nonce prediction).
//
// Both are base58 strings, so a plain `string` type cannot stop the recurring
// 0x7d2 ConstraintSigner bug where the vault PDA leaks into the state PDA
// slot (`predictNextExecuteNonce` against a SystemProgram-owned account
// silently returns 0). Branding them as nominal types makes such misuse a
// compile error at every API boundary.
//
// Use the `asVaultPda` / `asStatePda` factories at the bytes-in boundary
// (sessionStorage rehydration, manual base58 input) to stamp the brand.
// Use the `validateVaultPda` / `validateStatePda` helpers exported from
// `./adapters/solana` when the bytes come from an untrusted source
// (sessionStorage that might have been XSS'd, dApp user input) — those
// throw on malformed base58 instead of leaking garbage downstream.

// `import type` only — types.ts must stay peerDep-free at runtime so SDK
// users who consume just the wire-format pieces don't pay the
// @solana/web3.js cost. The PublicKey-form brands below are pure
// compile-time refinements; their factory bodies have no PublicKey
// runtime reference.
import type { PublicKey } from '@solana/web3.js'

declare const __vaultPdaBrand: unique symbol
declare const __statePdaBrand: unique symbol
declare const __vaultPdaKeyBrand: unique symbol
declare const __statePdaKeyBrand: unique symbol

/** Vault PDA (SystemProgram-owned, user-facing receive address). Base58. */
export type VaultPda = string & { readonly [__vaultPdaBrand]: true }
/** MachineWallet state PDA (program-owned, protocol seed). Base58. */
export type StatePda = string & { readonly [__statePdaBrand]: true }
/** {@link PublicKey} known to be a vault PDA. */
export type VaultPdaKey = PublicKey & { readonly [__vaultPdaKeyBrand]: true }
/** {@link PublicKey} known to be a MachineWallet state PDA. */
export type StatePdaKey = PublicKey & { readonly [__statePdaKeyBrand]: true }

/** Cast a raw base58 to {@link VaultPda}. Caller asserts the value is a vault PDA. */
export function asVaultPda(addr: string): VaultPda { return addr as VaultPda }
/** Cast a raw base58 to {@link StatePda}. Caller asserts the value is a state PDA. */
export function asStatePda(addr: string): StatePda { return addr as StatePda }
/** Cast a {@link PublicKey} to {@link VaultPdaKey}. Caller asserts the value is a vault PDA. */
export function asVaultPdaKey(pk: PublicKey): VaultPdaKey { return pk as VaultPdaKey }
/** Cast a {@link PublicKey} to {@link StatePdaKey}. Caller asserts the value is a state PDA. */
export function asStatePdaKey(pk: PublicKey): StatePdaKey { return pk as StatePdaKey }

// --- SDK Configuration ---

export type SoulPassNetwork = 'mainnet-beta' | 'devnet'

export interface SoulPassWalletConfig {
  /** Solana network */
  network?: SoulPassNetwork
  /** Custom Solana RPC endpoint */
  endpoint?: string
  /** Override signing page base URL (default: https://soulpass.ai) */
  walletUrl?: string
  /**
   * Calling product's productType (matches matrix-backend's
   * `ProductType.getName()`, e.g. `'tens'`, `'tigerpass'`). Forwarded to the
   * popup so the matrix-user JWT is stored under the *caller's* product
   * namespace in Redis — not the popup's own (`'soulpass'`).
   *
   * Why this matters: the popup is hosted on soulpass.ai and its
   * `X-Exchange-Info` carries `productType=soulpass`. Without this override
   * the JWT lands under `matrix:jwt:{userId}:soulpass:...`, but the Gateway
   * on the caller's domain reads `matrix:jwt:{userId}:tens:...` on every
   * subsequent request, surfaces "JWT not found in Redis", and returns 401
   * right after sign-in.
   *
   * Optional for back-compat with older popup builds that don't honour the
   * field — they fall back to their own X-Exchange-Info productType. New
   * dApp integrations should always set this.
   */
  productType?: string
}

// --- Wallet State ---

export interface WalletState {
  connected: boolean
  /**
   * User-facing Solana address — the vault PDA. Same value as
   * {@link walletAddress}; both exist so `publicKey` stays the idiomatic
   * wallet-adapter accessor while `walletAddress` is the explicit name.
   */
  publicKey: VaultPda | null
  /** Alias for {@link publicKey} — the vault PDA, base58. */
  walletAddress: VaultPda | null
  /**
   * MachineWallet state PDA — distinct from {@link walletAddress}. See
   * {@link StatePda} for the full semantics; the brand prevents accidental
   * cross-assignment in caller code.
   */
  accountAddress: StatePda | null
}

// --- Session ---

/**
 * Matrix-user JWT the popup obtained during `/auth/passkey/signin/verify`.
 * Forwarded to dApps so they can address matrix-user APIs on behalf of the
 * signed-in user (NFT discovery via DAS, portfolio reads, etc) without a
 * second round of authentication.
 *
 * Refresh token is intentionally NOT included: it's long-lived and exposing
 * it cross-origin would let any XSS on the dApp extend the session
 * indefinitely. When the access token expires the dApp should re-invoke
 * `connect()` — one additional passkey tap, bounded blast radius.
 */
export interface SoulPassSession {
  /** Matrix-user bearer JWT. Sent raw in `Authorization` header (no prefix). */
  accessToken: string
  /** Seconds until expiry — dApp is expected to refresh by re-connecting. */
  expiresIn?: number
}

// --- postMessage Protocol: SDK → Popup ---

export type SDKMessageType = 'CONNECT' | 'SIGN_TRANSACTION' | 'SIGN_MESSAGE'

export interface SDKConnectMessage {
  type: 'CONNECT'
  id: string
  payload: {
    network: SoulPassNetwork
    /**
     * Calling dApp's productType — see {@link SoulPassWalletConfig.productType}.
     * The popup forwards this verbatim to matrix-user's
     * `/auth/passkey/signin/verify` request body as `clientProductType`, which
     * decides the Redis namespace the issued JWT lands in.
     *
     * Optional: older popup builds ignore this field, and that's fine for
     * single-product deployments where popup.productType == caller.productType.
     */
    productType?: string
  }
}

export interface SDKSignTransactionMessage {
  type: 'SIGN_TRANSACTION'
  id: string
  payload: {
    /** base64-serialized Transaction (legacy or v0 without ALT) */
    transaction: string
    /** Vault PDA base58 — the popup derives state PDA / authorities from this. */
    walletAddress: VaultPda
    /** Forwarded from SDK config so the popup picks the right RPC */
    network: SoulPassNetwork
    /**
     * Address Lookup Table addresses (base58). When provided, the popup
     * resolves them on-chain and compiles the inner instructions into a v0
     * VersionedTransaction, saving ~150 bytes per ALT-covered account
     * (a 32-byte pubkey collapses to a 1-byte index). Required for swap and
     * other dense flows that exceed the 1232-byte legacy tx limit.
     *
     * Without ALT, the popup falls back to legacy / minimal v0 assembly
     * which works for short ix lists (CreateWallet, send-token, simple NFT
     * ops) — see soulpass-ai/lib/machine-wallet-tx.ts.
     */
    altAddresses?: string[]
    /**
     * Caller-supplied bumps for per-Execute ephemeral signer PDAs. When
     * provided AND non-empty, the popup compiles the inner instructions
     * into a `disc=16 ExecuteWithEphemeralSigners` call, where each bump
     * is fed into `Pubkey::create_program_address` against seeds
     * `["machine_ephemeral", walletAddress, walletNonce_le, index, bump]`.
     * Inner-ix accounts referencing those derived PDAs must set
     * `AccountEntry.FLAG_EPHEMERAL_SIGNER` (bit 1) so the on-chain handler
     * promotes them to signer at CPI time.
     *
     * Length must match the number of ephemeral signers the dApp asked
     * for via {@link deriveEphemeralSigners}; reusing those PDAs in the
     * inner ixs is the dApp's responsibility. Maximum is the program's
     * MAX_EPHEMERAL_SIGNERS (4).
     *
     * Omit or pass an empty array to use the legacy `disc=1 Execute`
     * path — no behaviour change for non-ephemeral flows.
     */
    ephemeralSignerBumps?: number[]
  }
}

export interface SDKSignMessageMessage {
  type: 'SIGN_MESSAGE'
  id: string
  payload: {
    /** base64 message bytes */
    message: string
    walletAddress: VaultPda
    network: SoulPassNetwork
  }
}

export type SDKMessage =
  | SDKConnectMessage
  | SDKSignTransactionMessage
  | SDKSignMessageMessage

// --- Two-phase sign session: open popup in the click-handler tick, post the
// actual payload later when the dApp's async tx-build resolves. The popup
// already supports a waiting/placeholder phase (the sign page renders
// "Waiting for transaction…" until SIGN_TRANSACTION arrives) — this API just
// reflects the split on the SDK side so the caller can split the
// gesture-preserving open() from the data-ready send(). ---

/**
 * Per-tx options passed alongside the serialized transaction.
 *
 * Kept as a separate parameter (not bundled into the tx bytes) so the popup
 * can use them to choose its assembly strategy — e.g. ALT addresses are
 * resolved on-chain and fed into v0 message compilation, not part of the tx
 * blob the dApp serialized.
 */
export interface SignTransactionOptions {
  /** See {@link SDKSignTransactionMessage.payload.altAddresses}. */
  altAddresses?: string[]
  /**
   * Bumps for the ephemeral signer PDAs the dApp derived via
   * {@link deriveEphemeralSigners}. Their pubkeys must already appear in the
   * inner instructions flagged with `FLAG_EPHEMERAL_SIGNER`.
   *
   * See {@link SDKSignTransactionMessage.payload.ephemeralSignerBumps}.
   */
  ephemeralSignerBumps?: number[]
}

export interface SignTransactionSession {
  /** Deliver the serialized transaction to the popup. Resolves with the
   * Solana signature once the popup completes; rejects on failure. Calling
   * twice on the same session throws — sessions are single-shot. */
  send(
    serializedTx: Uint8Array,
    options?: SignTransactionOptions,
  ): Promise<{ signature: string }>
  /** Close the popup without sending data. Subsequent `send()` rejects with
   * `CANCELLED`. Safe to call multiple times; no-op after `send()` resolves. */
  cancel(reason?: string): void
}

/**
 * Multi-shot counterpart of `SignTransactionSession`. The popup is opened ONCE
 * and stays open across N consecutive signs; `send()` may be called serially N
 * times. Structurally identical to `SignTransactionSession` — the single-shot
 * vs multi-shot contract is enforced by the session implementation, not the type.
 *
 * Call `cancel()` when done (success or error) — it is idempotent.
 */
export type BatchSignTransactionSession = SignTransactionSession

export interface SignMessageSession {
  send(message: Uint8Array): Promise<{
    signature: Uint8Array
    authenticatorData: Uint8Array
    clientDataJSON: Uint8Array
  }>
  cancel(reason?: string): void
}

// --- postMessage Protocol: Popup → SDK ---

export interface PopupReadyMessage {
  type: 'READY'
}

export interface PopupConnectSuccessMessage {
  type: 'CONNECT_SUCCESS'
  id: string
  payload: {
    /** Same value as {@link walletAddress} — the vault PDA. */
    publicKey: VaultPda
    /** Vault PDA — user-facing receive address (funds + ATAs live here). */
    walletAddress: VaultPda
    /**
     * MachineWallet state PDA — see {@link StatePda}. The brand prevents
     * `walletAddress` (vault PDA) from being substituted here in caller code.
     */
    accountAddress: StatePda
    /**
     * Optional matrix-user session. Present when the popup successfully
     * completed `/auth/passkey/signin/verify`. Older popup builds (≤ 0.1.x)
     * omit this field — dApps must treat it as optional for back-compat.
     */
    session?: SoulPassSession
  }
}

export interface PopupSignSuccessMessage {
  type: 'SIGN_SUCCESS'
  id: string
  payload: {
    /**
     * SIGN_TRANSACTION: Solana transaction signature (base58) — the tx has
     *   already been submitted by the wallet; this signature is what a dApp
     *   passes to `connection.confirmTransaction`.
     * SIGN_MESSAGE: raw WebAuthn assertion signature (base64).
     */
    signature: string
    /** Reserved; kept for adapter compatibility. Always undefined post-v0.1. */
    signedTransaction?: string
    /** SIGN_MESSAGE only: base64 authenticatorData needed to verify the signature. */
    authenticatorData?: string
    /** SIGN_MESSAGE only: base64 clientDataJSON needed to verify the signature. */
    clientDataJSON?: string
  }
}

export interface PopupErrorMessage {
  type: 'ERROR'
  id: string
  payload: {
    code: 'USER_REJECTED' | 'PASSKEY_FAILED' | 'NETWORK_ERROR' | 'UNKNOWN'
    message: string
  }
}

export type PopupMessage =
  | PopupReadyMessage
  | PopupConnectSuccessMessage
  | PopupSignSuccessMessage
  | PopupErrorMessage

// --- Constants ---

export const DEFAULT_WALLET_URL = 'https://soulpass.ai'
export const POPUP_WIDTH = 420
export const POPUP_HEIGHT = 620
export const MESSAGE_SOURCE = 'soulpass-passkey-sdk'
