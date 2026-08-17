// ─────────────────────────────────────────────────────────────────────────
// @soulpass/passkey-sdk/protocol — MachineWallet protocol layer.
//
// The TypeScript single source of truth for MachineWallet wire formats,
// account-state parsing, and PDA/signature primitives. Ordinary dApp
// integrations never need this entry — it exists for the popup, for
// advanced flows (ephemeral signers, nonce prediction), and for keeping
// TS / Swift / Rust byte-identical (see ARCHITECTURE.md).
// ─────────────────────────────────────────────────────────────────────────

// ── MachineWallet protocol constants ─────────────────────────────────────
export {
  MACHINE_WALLET_PROGRAM_ADDRESS,
  MACHINE_WALLET_VAULT_SEED,
  MAX_SLOT_WINDOW,
  SOLANA_SLOT_MS,
  ADD_AUTHORITY_CEREMONY_SLOT_WINDOW,
} from './protocol'

// ── Ephemeral signer PDA derivation (Squads-v4 model) ────────────────────
export {
  deriveEphemeralSigners,
  EPHEMERAL_SIGNER_SEED_PREFIX,
  MAX_EPHEMERAL_SIGNERS,
} from './ephemeral-signers'
export type {
  EphemeralSigner,
  DeriveEphemeralSignersInput,
} from './ephemeral-signers'

// ── On-chain MachineWallet account state ─────────────────────────────────
export {
  predictNextExecuteNonce,
  parseWalletState,
  getWalletState,
  WalletNotDeployedError,
  V1_OFFSET,
  V1_HEADER_SIZE,
  V1_MIN_ACCOUNT_SIZE,
  AUTHORITY_SLOT_SIZE,
  AUTHORITY_PUBKEY_SIZE,
  SigScheme,
  effectiveAuthorityKey,
} from './wallet-state'
export type { MachineWalletState, SigSchemeValue, WalletAuthoritySlot } from './wallet-state'

// ── MachineWallet wire format (single source of truth for popup + contract) ──
export { MachineWalletDisc } from './wire-format/disc'
export type { MachineWalletDiscValue } from './wire-format/disc'
export {
  FLAG_WRITABLE,
  FLAG_EPHEMERAL_SIGNER,
  computeInnerHash,
} from './wire-format/inner-hash'
export type { InnerInstruction } from './wire-format/inner-hash'
export {
  EXECUTE_TAG,
  EXECUTE_EPHEMERAL_TAG,
  computeExecuteMessage,
  computeExecuteEphemeralMessage,
} from './wire-format/operation-hash'
export {
  SIGNED_MESSAGE_ENVELOPE,
  deploymentDomain,
  hashSignedMessage,
} from './wire-format/signed-message'
export type { MachineWalletDeployment } from './wire-format/signed-message'
export {
  CREATE_WALLET_TAG,
  CLOSE_WALLET_TAG,
  ADVANCE_NONCE_TAG,
  CREATE_SESSION_TAG,
  REVOKE_SESSION_TAG,
  OWNER_CLOSE_SESSION_TAG,
  ADD_AUTHORITY_TAG,
  ADD_AUTHORITY_POP_TAG,
  REMOVE_AUTHORITY_TAG,
  SET_THRESHOLD_TAG,
  computeCreateWalletMessage,
  computeCloseWalletMessage,
  computeAdvanceNonceMessage,
  computeCreateSessionMessage,
  computeRevokeSessionMessage,
  computeOwnerCloseSessionMessage,
  computeAddAuthorityMessage,
  computeAddAuthorityPopMessage,
  computeRemoveAuthorityMessage,
  computeSetThresholdMessage,
} from './wire-format/authority-messages'
export type { AuthorityMessageBase } from './wire-format/authority-messages'
export {
  buildExecuteIxData,
  buildEvidenceIxData,
  encodeRemainingAccounts,
} from './wire-format/execute-ix'
export type { RemainingAccount } from './wire-format/execute-ix'
export { buildSecp256r1PrecompileIxData } from './wire-format/secp256r1'
export {
  SOULPASS_RP_ID,
  MAX_CLIENT_DATA_JSON_SIZE,
  isAllowedWebAuthnOrigin,
} from './wire-format/webauthn'
export { MESSAGE_DOMAIN, domainSeparate } from './wire-format/message-domain'

// ── Sign-channel relay (dual-channel sign: popup + app takeover) ─────────
export { generateChannelId, SignChannelClient } from './sign-channel'
export type { SignChannelPayloadInput, SignChannelResult } from './sign-channel'
export { deriveApiUrl } from './matrix-http'

// ── Encoding utilities ───────────────────────────────────────────────────
export { base64urlNoPad } from './encoding'

// ── P-256 (secp256r1) point + signature primitives ───────────────────────
export {
  bytesToBigIntBE,
  isOnP256Curve,
  compressP256,
  derToRawEcdsaSignature,
} from './p256'

// ── Popup postMessage protocol ───────────────────────────────────────────
// The popup is the other half of every message the SDK sends, so it consumes
// these instead of re-declaring them. Hand-mirrored envelopes are how a new
// message type (PAYMENT_PREPARING) ends up handled on one side only.
export type {
  SDKMessageType,
  SDKMessage,
  SDKConnectMessage,
  SDKSignTransactionMessage,
  SDKSignMessageMessage,
  SDKPaymentDiscoverMessage,
  SDKPaymentPreparingMessage,
  SDKPaymentExecuteMessage,
  PopupMessage,
  PopupReadyMessage,
  PopupConnectSuccessMessage,
  PopupSignSuccessMessage,
  PopupPaymentAccountsMessage,
  PopupPaymentSuccessMessage,
  PopupErrorMessage,
} from './types'
