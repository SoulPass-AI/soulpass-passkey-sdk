// ── Popup-facing SoulPass wallet client ───────────────────────────────────
export { SoulPassWallet } from './wallet'
export type {
  SoulPassWalletConfig,
  WalletState,
  SoulPassSession,
  SignTransactionSession,
  SignMessageSession,
  BatchSignTransactionSession,
  SignTransactionOptions,
} from './types'
export {
  SoulPassWalletAdapter,
  SoulPassWalletName,
} from './adapters/solana'

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
  SigScheme,
} from './wallet-state'
export type { MachineWalletState, SigSchemeValue } from './wallet-state'

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
  EXECUTE_MESSAGE_DOMAIN_V0,
  EXECUTE_MESSAGE_DOMAIN_V1,
  computeExecuteMessageV0,
  computeExecuteMessageV1,
} from './wire-format/operation-hash'
export {
  buildExecuteIxData,
  buildEvidenceIxData,
  buildEvidenceCompactIxData,
  encodeRemainingAccounts,
} from './wire-format/execute-ix'
export type { RemainingAccount } from './wire-format/execute-ix'
export { buildSecp256r1PrecompileIxData } from './wire-format/secp256r1'
