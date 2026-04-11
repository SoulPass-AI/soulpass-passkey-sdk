// --- SDK Configuration ---

export interface SoulPassWalletConfig {
  /** Solana network */
  network?: 'mainnet-beta' | 'devnet'
  /** Custom Solana RPC endpoint */
  endpoint?: string
  /** Override signing page base URL (default: https://soulpass.ai) */
  walletUrl?: string
}

// --- Wallet State ---

export interface WalletState {
  connected: boolean
  publicKey: string | null       // Ed25519 base58
  walletAddress: string | null   // MachineWallet base58
}

// --- postMessage Protocol: SDK → Popup ---

export type SDKMessageType = 'CONNECT' | 'SIGN_TRANSACTION' | 'SIGN_MESSAGE'

export interface SDKConnectMessage {
  type: 'CONNECT'
  id: string
  payload: { network: string }
}

export interface SDKSignTransactionMessage {
  type: 'SIGN_TRANSACTION'
  id: string
  payload: { transaction: string } // base64
}

export interface SDKSignMessageMessage {
  type: 'SIGN_MESSAGE'
  id: string
  payload: { message: string } // base64
}

export type SDKMessage =
  | SDKConnectMessage
  | SDKSignTransactionMessage
  | SDKSignMessageMessage

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
  }
}

export interface PopupSignSuccessMessage {
  type: 'SIGN_SUCCESS'
  id: string
  payload: {
    signature: string            // base64
    signedTransaction?: string   // base64
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
