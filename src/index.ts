// ─────────────────────────────────────────────────────────────────────────
// @soulpass/passkey-sdk — integration surface.
//
// This entry exports only what a dApp needs to connect, sign, and handle
// failures. The MachineWallet protocol layer (wire formats, account-state
// parsing, PDA derivation primitives) lives behind the './protocol' subpath;
// the wallet-adapter integration behind './solana-adapter'. Keeping the main
// entry small is deliberate: autocomplete here should read like a quickstart,
// not like the protocol spec.
// ─────────────────────────────────────────────────────────────────────────

// ── Wallet client ────────────────────────────────────────────────────────
export { SoulPassWallet } from './wallet'
export type {
  SoulPassWalletConfig,
  SoulPassNetwork,
  WalletState,
  SoulPassSession,
  SignTransactionSession,
  SignMessageSession,
  BatchSignTransactionSession,
  SignTransactionOptions,
} from './types'

// ── Typed errors — branch on `err.code`, never on message text ───────────
export { SoulPassError, isSoulPassError, isUserDeclined } from './errors'
export type { SoulPassErrorCode } from './errors'

// ── Branded PDA types (vault vs state PDA — see ARCHITECTURE.md) ─────────
export type { VaultPda, StatePda, VaultPdaKey, StatePdaKey } from './types'
export {
  asVaultPda,
  asStatePda,
  asVaultPdaKey,
  asStatePdaKey,
} from './types'

// ── Environment detection (in-app browsers can't do WebAuthn) ────────────
export { detectInAppBrowser, InAppBrowserError } from './environment'
