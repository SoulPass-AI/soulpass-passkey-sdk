// ─────────────────────────────────────────────────────────────────────────
// @soulpass/passkey-sdk/protocol — MachineWallet protocol layer.
//
// The TypeScript single source of truth for MachineWallet wire formats,
// account-state parsing, and PDA/signature primitives. Ordinary dApp
// integrations never need this entry — it exists for the popup, for
// advanced flows (ephemeral signers, nonce prediction), and for keeping
// TS / Swift / Rust byte-identical (see ARCHITECTURE.md).
// ─────────────────────────────────────────────────────────────────────────

// ── Deployment + client signing-window policy ────────────────────────────
export {
  MACHINE_WALLET_PROGRAM_ADDRESS,
  MAX_SLOT_WINDOW,
  SOLANA_SLOT_MS,
  ADD_AUTHORITY_CEREMONY_SLOT_WINDOW,
} from './protocol'

// ── Program constants (each mirrors one line of machine-wallet) ──────────
export {
  WALLET_ACCOUNT_TAG,
  SESSION_ACCOUNT_TAG,
  RETIRED_ACCOUNT_TAGS,
  MAX_AUTHORITIES,
  MAX_ALLOWED_PROGRAMS,
  MAX_CASH_MINTS,
  MAX_SLEEVE_MINTS,
  MAX_EPHEMERAL_SIGNERS,
  MAX_INNER_INSTRUCTIONS,
  MAX_CLIENT_DATA_JSON_SIZE,
  MAX_SIGNATURE_TTL_SLOTS,
  MAX_SESSION_LIFETIME_SLOTS,
  RECOVERY_DELAY_SLOTS,
  SESSION_FLAG_NET_EXPOSURE,
  SESSION_FLAGS_KNOWN,
  NATIVE_SOL_MINT,
  isNativeSolMint,
  AUTHORITY_SLOT_SIZE,
  WALLET_HEADER_SIZE,
  SESSION_HEADER_SIZE,
  CASH_MINT_STATE_SIZE,
  SLEEVE_ENTRY_SIZE,
  WALLET_SEED,
  VAULT_SEED,
  SESSION_SEED,
} from './wire-format/constants'

// ── Program error codes ──────────────────────────────────────────────────
export {
  MachineWalletError,
  RETIRED_ERROR_CODES,
  describeMachineWalletError,
} from './wire-format/errors'
export type { MachineWalletErrorName, MachineWalletErrorCode } from './wire-format/errors'

// ── PDA derivation ───────────────────────────────────────────────────────
export { deriveWalletPda, deriveSessionPda } from './wire-format/pda'
export type { ProgramAddress } from './wire-format/pda'

// ── Ephemeral signer PDA derivation (Squads-v4 model) ────────────────────
export {
  deriveEphemeralSigners,
  EPHEMERAL_SIGNER_SEED_PREFIX,
} from './ephemeral-signers'
export type {
  EphemeralSigner,
  DeriveEphemeralSignersInput,
} from './ephemeral-signers'

// ── On-chain MachineWallet account state ─────────────────────────────────
export {
  predictNextExecuteNonce,
  nextSessionGeneration,
  parseWalletState,
  getWalletState,
  WalletNotDeployedError,
  walletAccountSize,
  AUTHORITY_PUBKEY_SIZE,
  SigScheme,
  effectiveAuthorityKey,
  isRoot,
  findAuthority,
} from './wallet-state'
export type { MachineWalletState, SigSchemeValue, WalletAuthoritySlot } from './wallet-state'

// ── Governance quorum preflight (before any biometric prompt) ────────────
export { governanceQuorum, assertGovernanceQuorum } from './governance-quorum'
export type { GovernanceQuorum, GovernanceQuorumOperation } from './governance-quorum'

// ── On-chain SessionState account + liveness ─────────────────────────────
export {
  parseSessionState,
  sessionAccountSize,
  isSessionLive,
  sessionSolPolicy,
} from './wire-format/session-state'
export type { SessionState, CashMintState, SleeveEntry } from './wire-format/session-state'

// ── MachineWallet wire format (single source of truth for popup + contract) ──
export { MachineWalletDisc, REJECTED_DISCS } from './wire-format/disc'
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
  MACHINE_WALLET_TAGS,
  CREATE_WALLET_TAG,
  CLOSE_WALLET_TAG,
  ADVANCE_NONCE_TAG,
  CREATE_SESSION_TAG,
  REVOKE_SESSION_TAG,
  OWNER_CLOSE_SESSION_TAG,
  ADD_AUTHORITY_TAG,
  ADD_AUTHORITY_POP_TAG,
  REMOVE_SELF_TAG,
  REMOVE_OTHER_TAG,
  SET_THRESHOLD_TAG,
  ROTATE_ROOT_TAG,
  PROPOSE_RECOVERY_TAG,
  CANCEL_RECOVERY_TAG,
  EXECUTE_RECOVERY_TAG,
  SET_RECOVERY_THRESHOLD_TAG,
  BUMP_EPOCH_TAG,
  computeCreateWalletMessage,
  computeCloseWalletMessage,
  computeAdvanceNonceMessage,
  computeCreateSessionMessage,
  computeRevokeSessionMessage,
  computeOwnerCloseSessionMessage,
  computeAddAuthorityMessage,
  computeAddAuthorityPopMessage,
  computeRemoveSelfMessage,
  computeRemoveOtherMessage,
  computeSetThresholdMessage,
  computeRotateRootMessage,
  computeProposeRecoveryMessage,
  computeCancelRecoveryMessage,
  computeExecuteRecoveryMessage,
  computeSetRecoveryThresholdMessage,
  computeBumpEpochMessage,
} from './wire-format/authority-messages'
export type {
  WalletMessageScope,
  FundsNonceBound,
  SessionNonceBound,
  GovernanceNonceBound,
  SessionGenerationBound,
  AuthorityKeyOperand,
  MachineWalletTag,
} from './wire-format/authority-messages'
export {
  buildExecuteIxData,
  buildEvidenceIxData,
  encodeRemainingAccounts,
} from './wire-format/execute-ix'
export type { RemainingAccount } from './wire-format/execute-ix'
export {
  GOVERNED_ACCOUNTS,
  ADD_AUTHORITY_ACCOUNTS,
  REMOVE_AUTHORITY_ACCOUNTS,
  EXECUTE_ACCOUNTS,
  REVOKE_SESSION_ACCOUNTS,
  OWNER_CLOSE_SESSION_ACCOUNTS,
  CLOSE_SESSION_ACCOUNTS,
  SELF_REVOKE_SESSION_ACCOUNTS,
  CLOSE_WALLET_ACCOUNTS,
  CREATE_WALLET_ACCOUNTS,
  SESSION_EXECUTE_ACCOUNTS,
  buildCreateWalletIxData,
  buildCloseWalletIxData,
  buildAdvanceNonceIxData,
  buildSessionExecuteIxData,
  buildRevokeSessionIxData,
  buildSelfRevokeSessionIxData,
  buildCloseSessionIxData,
  buildAddAuthorityIxData,
  buildRemoveAuthorityIxData,
  buildSetThresholdIxData,
  buildOwnerCloseSessionIxData,
  buildRotateRootIxData,
  buildProposeRecoveryIxData,
  buildCancelRecoveryIxData,
  buildExecuteRecoveryIxData,
  buildBumpEpochIxData,
  buildSetRecoveryThresholdIxData,
} from './wire-format/instructions'
export {
  CASH_MINT_POLICY_WIRE_LEN,
  CREATE_SESSION_ACCOUNTS,
  encodeCashMintPolicy,
  validateSessionParams,
  hashSessionData,
  buildCreateSessionIxData,
} from './wire-format/session'
export type { CashMintPolicy, SessionParams } from './wire-format/session'
export { buildSecp256r1PrecompileIxData } from './wire-format/secp256r1'
export {
  SOULPASS_RP_ID,
  PRODUCTION_WEBAUTHN_ORIGIN,
  TEST_WEBAUTHN_ORIGIN,
  allowedWebAuthnOrigins,
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
