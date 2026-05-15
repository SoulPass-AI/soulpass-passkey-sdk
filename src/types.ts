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
  publicKey: string | null       // Ed25519 base58
  walletAddress: string | null   // MachineWallet base58
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
    /** MachineWallet PDA base58 — needed by the wallet popup to read on-chain state */
    walletAddress: string
    /** Forwarded from SDK config so the popup picks the right RPC */
    network: SoulPassNetwork
  }
}

export interface SDKSignMessageMessage {
  type: 'SIGN_MESSAGE'
  id: string
  payload: {
    /** base64 message bytes */
    message: string
    walletAddress: string
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

export interface SignTransactionSession {
  /** Deliver the serialized transaction to the popup. Resolves with the
   * Solana signature once the popup completes; rejects on failure. Calling
   * twice on the same session throws — sessions are single-shot. */
  send(serializedTx: Uint8Array): Promise<{ signature: string }>
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
    publicKey: string       // Ed25519 base58
    walletAddress: string   // MachineWallet base58
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
