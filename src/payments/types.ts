/**
 * Merchant-facing application types for the payments client.
 *
 * Wire types (PaymentIntent, PaymentExecution, PaymentAccount, ...) live in
 * `../payment-wire` because they cross the popup boundary; this module depends
 * on core, never the reverse. They are re-exported here so
 * `@soulpass/passkey-sdk/payments` stays a single import site for merchants.
 */
import type {
  PaymentAmount,
  PaymentAuthorizationSession,
  PaymentIntent,
  PaymentExecution,
  PaymentSettlementOption,
} from '../payment-wire'

export type {
  EvmMachineAccountExecution,
  EvmPaymentCall,
  PaymentAccount,
  PaymentAmount,
  PaymentAuthorizationSession,
  PaymentExecution,
  PaymentFailure,
  PaymentIntent,
  PaymentIntentStatus,
  PaymentMerchant,
  PaymentProtocolFee,
  PaymentSettlementOption,
  SolanaMachineWalletExecution,
} from '../payment-wire'
export {
  PAYMENT_INTENT_PENDING_STATUSES,
  PAYMENT_INTENT_TERMINAL_STATUSES,
} from '../payment-wire'

/** Server preparation locked to exactly one PaymentAttempt. */
export interface PreparedPayment {
  paymentIntent: PaymentIntent
  attemptId: string
  execution: PaymentExecution
}

export interface PreparePaymentInput {
  settlementOptionId: string
  payerAddress: string
}

export interface CompletePaymentInput {
  clientSecret: string
  paymentIntentId: string
  attemptId: string
  transactionId: string
}

/** Atomic permissionless create payload sent to SoulPass's public endpoint. */
export interface CreateDirectPaymentInput {
  idempotencyKey: string
  /** Human decimal price, e.g. `"10.50"`. The server scales it to the
   * smallest unit using the configured asset's decimals. */
  amount: string
  currency: string
  settlementOptions: readonly { network: string; recipient: string }[]
  reference?: string
  metadata?: Readonly<Record<string, string>>
  expiresInSeconds?: number
  webhookUrl?: string
}

export interface CreatedPaymentIntent {
  paymentIntent: PaymentIntent
  clientSecret: string
  /**
   * Display-scoped capability (`pdt_…`) forwarded to the wallet popup, which
   * uses it to fetch canonical intent state instead of trusting the
   * opener-relayed copy. Unlike `clientSecret` it necessarily transits the
   * merchant page — treat it like the intent data itself, but never log it and
   * never put it in a URL.
   */
  displayToken: string
}

/** Canonical state plus the display capability the wallet renders it with. */
export interface RetrievedPaymentIntent {
  paymentIntent: PaymentIntent
  displayToken: string
}

export interface PaymentIntentProvider {
  createDirect(input: CreateDirectPaymentInput): Promise<CreatedPaymentIntent>
  retrieve(clientSecret: string): Promise<RetrievedPaymentIntent>
  prepare(clientSecret: string, input: PreparePaymentInput): Promise<PreparedPayment>
  complete(input: CompletePaymentInput): Promise<PaymentIntent>
}

/**
 * Chain-neutral wallet port. The wallet owns balance discovery, passkey
 * authorization and submission through its existing Solana/EVM channels.
 */
export interface PaymentWallet {
  beginPaymentAuthorization(): PaymentAuthorizationSession
}

export interface SoulPassPaymentsConfig {
  wallet: PaymentWallet
  provider: PaymentIntentProvider
  /** Preferred network aliases after the built-in Solana-first rule. */
  preferredNetworks?: readonly string[]
  /** How long pay()/confirm() waits for canonical on-chain success. */
  confirmationTimeoutMs?: number
  confirmationPollIntervalMs?: number
}

/**
 * Developer-facing permissionless input. Family recipients are expanded over
 * `networks`; exact network keys may override the family address.
 */
export interface DirectPaymentInput {
  /** Human decimal string, for example `"10"` or `"10.50"`. */
  amount: string
  currency?: string
  recipients: Readonly<Record<string, string | undefined>> & {
    solana?: string
    evm?: string
  }
  /** Defaults to Solana plus every current Swift-compatible EVM mainnet. */
  networks?: readonly string[]
  /** Opaque merchant correlation; SoulPass does not interpret it. */
  reference?: string
  metadata?: Readonly<Record<string, string>>
  expiresInSeconds?: number
  /**
   * HTTPS endpoint notified once when this payment reaches a terminal state.
   *
   * Set this whenever fulfilment matters. Without it the only signal is `pay()`
   * resolving in the payer's browser, and a payer who closes the tab after signing
   * has still moved the funds. Deliveries are Ed25519-signed against the platform key
   * published at `/v1/payment-webhook-keys` — there is no secret to configure.
   *
   * Must be hosted on the checkout page's own domain (or a subdomain). That is what
   * stands in for a credential on an endpoint that takes none.
   */
  webhookUrl?: string
}

export interface BeginPaymentOptions {
  /** Optional user/merchant override. It still must have sufficient balance. */
  settlementOptionId?: string
}

export type PaymentFetch = typeof fetch

export interface HttpPaymentIntentProviderConfig {
  /** Base URL including the API version, e.g. `https://pay.example.com/v1`. */
  baseUrl: string
  fetch?: PaymentFetch
  headers?: Readonly<Record<string, string>>
}

export interface PaymentResult {
  intent: PaymentIntent & { status: 'succeeded' }
  transactionId: string
  attemptId: string
  settlement: PaymentSettlementOption
}

export interface PaymentConfirmationSession {
  confirm(): Promise<PaymentResult>
  cancel(reason?: string): void
}
