/**
 * Payment types that cross the SDK ↔ popup boundary.
 *
 * The split between this file and `./payments/types` is "does it go over the
 * wire", not "is it a payment thing". Everything here appears inside a
 * postMessage payload (or in a `SoulPassWallet` method signature), so it is
 * protocol surface owned by the core — the same rule that keeps
 * `SDKSignTransactionMessage` in `./types`. Merchant-facing application types
 * (provider ports, client config, `DirectPaymentInput`) stay in `./payments`,
 * which depends on this file and never the other way around.
 *
 * Runtime-free apart from the two status lists, so `./types` can import it
 * without breaking its peerDep-free guarantee.
 */

/**
 * Integer money amount safe to move through JSON without IEEE-754 rounding.
 * `value` is expressed in the currency's smallest unit.
 */
export interface PaymentAmount {
  value: string
  decimals: number
  currency: string
}

// Single source for the status inventory — the union type, the runtime
// validation Set and the terminal-state checks are all derived from these two
// lists, so a new status can't land in one and silently miss the others.
/** Statuses a PaymentIntent can still move out of. */
export const PAYMENT_INTENT_PENDING_STATUSES = [
  'requires_confirmation',
  'processing',
] as const
/** Statuses a PaymentIntent can never leave. */
export const PAYMENT_INTENT_TERMINAL_STATUSES = [
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'refunded',
] as const

export type PaymentIntentStatus =
  | (typeof PAYMENT_INTENT_PENDING_STATUSES)[number]
  | (typeof PAYMENT_INTENT_TERMINAL_STATUSES)[number]

export interface PaymentMerchant {
  id: string
  name: string
  domain?: string | null
  orderId?: string | null
}

/** Platform fee collected atomically with the merchant transfer. */
export interface PaymentProtocolFee {
  basisPoints: number
  amount: PaymentAmount
  /** Null only when the frozen fee amount is zero. */
  recipient?: string | null
}

/** One immutable stablecoin route offered by the merchant. */
export interface PaymentSettlementOption {
  id: string
  /** `solana_spl` or `evm_machine_account`. */
  rail: string
  /** Canonical network alias, for example `SOLANA`, `BASE`, or `BASE_SEPOLIA`. */
  network: string
  /** Chain family (`SOLANA`, `BASE`, `ETHEREUM`, ...). */
  chainType: string
  /** Exact native network id (`mainnet-beta`, `devnet`, `8453`, ...). */
  chainId: string
  /** Exact stablecoin mint/contract address on this network. */
  assetAddress: string
  /** Gross purchase price, excluding any separately configured user relay fee. */
  amount: PaymentAmount
  /** Net amount transferred to the merchant after the included protocol fee. */
  merchantReceives: PaymentAmount
  protocolFee: PaymentProtocolFee
  recipient: string
}

export interface PaymentFailure {
  code: string
  reason: string
}

/** Canonical server-owned payment state. */
export interface PaymentIntent {
  id: string
  status: PaymentIntentStatus
  presentment: PaymentAmount
  /** Ordered routes accepted by the merchant. Solana is returned first by default. */
  settlementOptions: readonly PaymentSettlementOption[]
  /** Set only after one option has been prepared and locked to an attempt. */
  settlement?: PaymentSettlementOption | null
  merchant: PaymentMerchant
  createdAt: string
  expiresAt?: string | null
  confirmedAt?: string | null
  transactionId?: string | null
  failure?: PaymentFailure | null
  metadata?: Readonly<Record<string, string>> | null
}

export interface SolanaMachineWalletExecution {
  kind: 'solana_machine_wallet_transfer'
  protocol: 'solana_machine_wallet_execute_v1'
  network: string
  account: string
  mint: string
  recipient: string
  amount: string
  protocolFeeRecipient?: string | null
  protocolFeeAmount: string
  decimals: number
  submissionPath: '/v1/wallet/solana/tx/submit'
}

export interface EvmPaymentCall {
  target: string
  value: string
  data: string
}

/** EIP-7702 MachineAccount execution; deliberately not an ERC-4337 UserOperation. */
export interface EvmMachineAccountExecution {
  kind: 'evm_machine_account_batch'
  protocol: 'machine_account_execute_batch_with_signature_v1'
  network: string
  chainId: string
  account: string
  calls: readonly EvmPaymentCall[]
  submissionPath: '/v1/wallet/evm/spend/submit'
}

export type PaymentExecution =
  | SolanaMachineWalletExecution
  | EvmMachineAccountExecution

/**
 * One spendable account discovered by the wallet for one offered option.
 * `availableAmount` uses the option asset's smallest unit.
 */
export interface PaymentAccount {
  settlementOptionId: string
  payerAddress: string
  availableAmount: string
}

/** A popup/session reserved synchronously from the user's Pay click. */
export interface PaymentAuthorizationSession {
  /**
   * Let the wallet discover its own canonical addresses and stablecoin balances.
   * This deliberately lives on the popup session: the merchant page never receives
   * the wallet's Matrix JWT or private RPC credentials.
   *
   * `displayToken` is the display-scoped capability issued with the intent. The
   * wallet uses it to fetch canonical intent state from the payment API and
   * renders only that; the `intent` argument is a hint for instant first paint,
   * never the source of truth. The wallet hard-fails without a token, so it is
   * required here. It is not a secret on par with the client secret — it
   * necessarily transits the merchant page — but it must never be logged and
   * never placed in a URL.
   */
  getPaymentAccounts(
    intent: PaymentIntent,
    displayToken: string,
  ): Promise<readonly PaymentAccount[]>
  /**
   * Tell the popup a server round-trip is under way so it can show progress
   * instead of a frozen balance list. Advisory and fire-and-forget — optional
   * so third-party `PaymentWallet` implementations stay valid without it.
   */
  notifyPreparing?(settlementOptionId: string): void
  execute(execution: PaymentExecution): Promise<{ transactionId: string }>
  cancel(reason?: string): void
}
