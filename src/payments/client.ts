import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, randomBytes } from '@noble/hashes/utils'
import { SoulPassError, isSoulPassError } from '../errors'
import { PaymentError, isPaymentError } from './errors'
import {
  PAYMENT_INTENT_PENDING_STATUSES,
  PAYMENT_INTENT_TERMINAL_STATUSES,
} from './types'
import type {
  BeginPaymentOptions,
  DirectPaymentInput,
  PaymentAccount,
  PaymentAuthorizationSession,
  PaymentAmount,
  PaymentConfirmationSession,
  PaymentExecution,
  PaymentIntent,
  PaymentIntentProvider,
  PaymentResult,
  PaymentSettlementOption,
  PaymentWallet,
  PreparedPayment,
  SoulPassPaymentsConfig,
} from './types'

const PAYMENT_INTENT_STATUSES: ReadonlySet<string> = new Set<string>([
  ...PAYMENT_INTENT_PENDING_STATUSES,
  ...PAYMENT_INTENT_TERMINAL_STATUSES,
])
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>(
  PAYMENT_INTENT_TERMINAL_STATUSES,
)

const DEFAULT_DIRECT_NETWORKS = [
  'SOLANA', 'BASE', 'ETHEREUM', 'BSC', 'POLYGON', 'ARBITRUM', 'HYPEREVM', 'ROBINHOOD',
] as const
// v2: the record became JSON `{ clientSecret, displayToken }` when the wallet
// popup started fetching canonical intent state with a display-scoped token.
// v1 (bare secret string) records are simply ignored — they only ever covered
// a payment pending in this same tab, so none can meaningfully survive a
// version bump of the SDK bundle.
const DIRECT_SECRET_STORAGE_PREFIX = 'soulpass_direct_payment_v2:'

/** The per-intent capabilities the SDK holds while a direct payment is pending. */
interface DirectPaymentCapability {
  clientSecret: string
  displayToken: string
}

/** High-level, chain-neutral stablecoin payment orchestration. */
export class SoulPassPayments {
  private readonly wallet: PaymentWallet
  private readonly provider: PaymentIntentProvider
  private readonly preferredNetworks: readonly string[]
  private readonly confirmationTimeoutMs: number
  private readonly confirmationPollIntervalMs: number
  private readonly directSecrets = new Map<string, DirectPaymentCapability>()
  /**
   * One checkout at a time per client. Two concurrent sessions would share one
   * PopupManager, whose message handler is last-listener-wins — the first
   * session's replies silently vanish. Rejecting the second call with
   * PAYMENT_IN_PROGRESS is the honest version of that failure.
   */
  private sessionActive = false

  constructor(config: SoulPassPaymentsConfig) {
    this.wallet = config.wallet
    this.provider = config.provider
    this.preferredNetworks = (config.preferredNetworks ?? []).map((network) =>
      network.toUpperCase(),
    )
    this.confirmationTimeoutMs = config.confirmationTimeoutMs ?? 90_000
    this.confirmationPollIntervalMs = config.confirmationPollIntervalMs ?? 1_500
  }

  async retrievePayment(clientSecret: string): Promise<PaymentIntent> {
    assertClientSecret(clientSecret)
    const retrieved = await this.provider.retrieve(clientSecret)
    assertRetrievedPayment(retrieved)
    return retrieved.paymentIntent
  }

  /**
   * Recover canonical state after `pay()` reports PAYMENT_STATUS_UNKNOWN.
   * The short-lived capability remains SDK-internal and is restored from this
   * tab's sessionStorage after a reload.
   */
  async retrieveDirectPayment(paymentIntentId: string): Promise<PaymentIntent> {
    assertPaymentIntentId(paymentIntentId)
    const capability = this.readDirectSecret(paymentIntentId)
    if (!capability) {
      throw new PaymentError(
        'INVALID_CLIENT_SECRET',
        'No direct-payment recovery capability exists in this browser tab.',
        { paymentIntentId },
      )
    }
    const intent = await this.retrievePayment(capability.clientSecret)
    if (isTerminal(intent.status)) this.forgetDirectSecret(paymentIntentId)
    return intent
  }

  /**
   * Permissionless one-call checkout. The popup is reserved synchronously,
   * then the SDK creates its short-lived immutable PaymentIntent internally.
   * Resolves only after canonical on-chain verification says `succeeded`.
   */
  async pay(input: DirectPaymentInput): Promise<PaymentResult> {
    const direct = normalizeDirectPayment(input)
    const authorization = this.withSessionSlot(() => this.wallet.beginPaymentAuthorization())
    let created
    try {
      created = await this.provider.createDirect({
        ...direct,
        idempotencyKey: generateIdempotencyKey(direct.reference),
      })
      assertPaymentIntent(created.paymentIntent)
      assertClientSecret(created.clientSecret)
      assertDisplayToken(created.displayToken)
      this.rememberDirectSecret(created.paymentIntent.id, {
        clientSecret: created.clientSecret,
        displayToken: created.displayToken,
      })
    } catch (err) {
      this.sessionActive = false
      authorization.cancel('direct payment creation failed')
      throw normalizePreparationError(err)
    }
    try {
      const result = await this.paymentSession(
        created.clientSecret,
        authorization,
        {},
        { intent: created.paymentIntent, displayToken: created.displayToken },
      ).confirm()
      this.forgetDirectSecret(created.paymentIntent.id)
      return result
    } catch (err) {
      if (!isPaymentError(err) || err.code !== 'PAYMENT_STATUS_UNKNOWN') {
        this.forgetDirectSecret(created.paymentIntent.id)
      }
      throw err
    }
  }

  private rememberDirectSecret(
    paymentIntentId: string,
    capability: DirectPaymentCapability,
  ): void {
    this.directSecrets.set(paymentIntentId, capability)
    try {
      globalThis.sessionStorage?.setItem(
        `${DIRECT_SECRET_STORAGE_PREFIX}${paymentIntentId}`,
        JSON.stringify(capability),
      )
    } catch {
      // Storage may be unavailable in privacy mode; in-memory recovery remains.
    }
  }

  private readDirectSecret(paymentIntentId: string): DirectPaymentCapability | null {
    const memory = this.directSecrets.get(paymentIntentId)
    if (memory) return memory
    try {
      const stored = globalThis.sessionStorage?.getItem(
        `${DIRECT_SECRET_STORAGE_PREFIX}${paymentIntentId}`,
      )
      if (stored) {
        const parsed = JSON.parse(stored) as DirectPaymentCapability
        assertClientSecret(parsed.clientSecret)
        assertDisplayToken(parsed.displayToken)
        const capability = {
          clientSecret: parsed.clientSecret,
          displayToken: parsed.displayToken,
        }
        this.directSecrets.set(paymentIntentId, capability)
        return capability
      }
    } catch {
      // Corrupt or unavailable storage is treated as no recovery capability.
    }
    return null
  }

  private forgetDirectSecret(paymentIntentId: string): void {
    this.directSecrets.delete(paymentIntentId)
    try {
      globalThis.sessionStorage?.removeItem(`${DIRECT_SECRET_STORAGE_PREFIX}${paymentIntentId}`)
    } catch {
      // Best-effort cleanup for storage-restricted browsers.
    }
  }

  /**
   * Reserve the chain-neutral wallet authorization surface synchronously.
   * Retrieval, balance discovery and route preparation start in `confirm()`.
   */
  beginPayment(
    clientSecret: string,
    options: BeginPaymentOptions = {},
  ): PaymentConfirmationSession {
    assertClientSecret(clientSecret)
    return this.withSessionSlot(() =>
      this.paymentSession(clientSecret, this.wallet.beginPaymentAuthorization(), options),
    )
  }

  /**
   * Take the single-flight slot for one checkout and run `open` under it.
   * Throws PAYMENT_IN_PROGRESS if a checkout is already in flight; a throw
   * from `open` releases the slot before propagating, so a failed open can't
   * wedge the client. The slot is otherwise released when the session settles
   * or is cancelled.
   */
  private withSessionSlot<T>(open: () => T): T {
    if (this.sessionActive) {
      throw new PaymentError(
        'PAYMENT_IN_PROGRESS',
        'Another payment is already in flight on this client. Await or cancel it before starting a new checkout.',
      )
    }
    this.sessionActive = true
    try {
      return open()
    } catch (err) {
      this.sessionActive = false
      throw err
    }
  }

  private paymentSession(
    clientSecret: string,
    authorization: PaymentAuthorizationSession,
    options: BeginPaymentOptions = {},
    /** Freshly created and already validated — skips one retrieve round-trip
     * while the user is watching the checkout popup. Absent for beginPayment(),
     * whose intent is server-owned and may have moved since the merchant saw it. */
    seed?: { intent: PaymentIntent; displayToken: string },
  ): PaymentConfirmationSession {
    let state: 'open' | 'confirming' | 'settled' | 'cancelled' = 'open'
    // Read through a function: cancel() can flip `state` while confirm() is
    // awaiting, which TypeScript's control-flow narrowing cannot see.
    const sessionWasCancelled = () => state === 'cancelled'

    // Every terminal transition releases the client's single-flight slot, so a
    // merchant can start the next checkout the moment this one is over.
    const settle = () => {
      state = 'settled'
      this.sessionActive = false
    }

    const cancel = (reason?: string) => {
      if (state === 'settled' || state === 'cancelled') return
      state = 'cancelled'
      this.sessionActive = false
      authorization.cancel(reason ?? 'payment session cancelled')
    }

    return {
      confirm: async (): Promise<PaymentResult> => {
        if (state === 'cancelled') {
          throw new SoulPassError(
            'CANCELLED',
            'Payment session was cancelled before confirmation.',
          )
        }
        if (state !== 'open') {
          throw new SoulPassError(
            'SESSION_USED',
            'Payment sessions are single-shot. Retrieve the PaymentIntent before retrying.',
          )
        }
        state = 'confirming'

        let prepared: PreparedPayment
        let selected: { option: PaymentSettlementOption; account: PaymentAccount }
        try {
          let intent = seed?.intent
          let displayToken = seed?.displayToken
          if (intent === undefined || displayToken === undefined) {
            const retrieved = await this.provider.retrieve(clientSecret)
            assertRetrievedPayment(retrieved)
            intent = retrieved.paymentIntent
            displayToken = retrieved.displayToken
          }
          assertPayable(intent)
          const accounts = await authorization.getPaymentAccounts(intent, displayToken)
          selected = selectSettlementAccount(
            intent.settlementOptions,
            accounts,
            this.preferredNetworks,
            options.settlementOptionId,
          )
          // The popup is idle for this whole round-trip — let it say so.
          authorization.notifyPreparing?.(selected.option.id)
          prepared = await this.provider.prepare(clientSecret, {
            settlementOptionId: selected.option.id,
            payerAddress: selected.account.payerAddress,
          })
          assertPreparedPayment(prepared)
          assertPayable(prepared.paymentIntent)
          if (prepared.paymentIntent.id !== intent.id) {
            throw new PaymentError(
              'PAYMENT_INTENT_INVALID',
              'Payment provider prepared a different PaymentIntent.',
              { paymentIntentId: intent.id },
            )
          }
          if (prepared.paymentIntent.settlement?.id !== selected.option.id) {
            throw new PaymentError(
              'PAYMENT_INTENT_INVALID',
              'Payment provider prepared a different settlement option.',
              { paymentIntentId: intent.id },
            )
          }
          if (sessionWasCancelled()) {
            throw new SoulPassError(
              'CANCELLED',
              'Payment session was cancelled during preparation.',
              { paymentIntentId: intent.id },
            )
          }
        } catch (err) {
          settle()
          authorization.cancel('payment preparation failed')
          throw normalizePreparationError(err)
        }

        let transactionId: string
        try {
          const result = await authorization.execute(prepared.execution)
          transactionId = result.transactionId
          if (typeof transactionId !== 'string' || transactionId.length === 0) {
            throw new PaymentError(
              'PAYMENT_AUTHORIZATION_FAILED',
              'Wallet returned no transaction identifier.',
              { paymentIntentId: prepared.paymentIntent.id },
            )
          }
        } catch (err) {
          settle()
          // A wallet-side rejection already carries the code the caller needs
          // (USER_REJECTED, POPUP_CLOSED, CANCELLED). Flattening it into
          // PAYMENT_AUTHORIZATION_FAILED would destroy the one distinction
          // that decides whether to show an error at all.
          if (isSoulPassError(err)) throw err
          throw new PaymentError(
            'PAYMENT_AUTHORIZATION_FAILED',
            err instanceof Error ? err.message : 'Payer authorization failed.',
            { paymentIntentId: prepared.paymentIntent.id, cause: err },
          )
        }

        try {
          const submitted = await this.provider.complete({
            clientSecret,
            paymentIntentId: prepared.paymentIntent.id,
            attemptId: prepared.attemptId,
            transactionId,
          })
          assertPaymentIntent(submitted)
          if (submitted.id !== prepared.paymentIntent.id) {
            throw new PaymentError(
              'PAYMENT_INTENT_INVALID',
              'Payment provider completed a different PaymentIntent.',
              { paymentIntentId: prepared.paymentIntent.id },
            )
          }
          const intent = await this.waitForSuccess(clientSecret, submitted, transactionId)
          settle()
          return {
            intent,
            transactionId,
            attemptId: prepared.attemptId,
            settlement: selected.option,
          }
        } catch (err) {
          settle()
          if (isPaymentError(err) && err.code === 'PAYMENT_FAILED') throw err
          // Deliberately NOT retryable: a transaction id exists, so value may
          // already have moved. Retrying pay() here is the double-charge path
          // this code exists to prevent — retrieve the same PaymentIntent.
          throw new PaymentError(
            'PAYMENT_STATUS_UNKNOWN',
            'The transaction was submitted, but payment reconciliation did not finish. Retrieve this PaymentIntent — do not create a second payment.',
            {
              paymentIntentId: prepared.paymentIntent.id,
              transactionId,
              retryable: false,
              cause: err,
            },
          )
        }
      },
      cancel,
    }
  }

  private async waitForSuccess(
    clientSecret: string,
    initial: PaymentIntent,
    transactionId: string,
  ): Promise<PaymentIntent & { status: 'succeeded' }> {
    const deadline = Date.now() + this.confirmationTimeoutMs
    let intent = initial
    for (;;) {
      if (intent.status === 'succeeded') {
        return intent as PaymentIntent & { status: 'succeeded' }
      }
      if (isTerminal(intent.status)) {
        throw new PaymentError(
          'PAYMENT_FAILED',
          intent.failure?.reason ?? `Payment ended in status ${intent.status}.`,
          { paymentIntentId: intent.id, transactionId },
        )
      }
      if (Date.now() >= deadline) {
        // Same rule as the completion path: a transaction id exists, so this
        // is never retryable — retrieve, or let the webhook settle it.
        throw new PaymentError(
          'PAYMENT_STATUS_UNKNOWN',
          'The transaction was submitted, but on-chain confirmation is still pending. Retrieve this PaymentIntent — do not create a second payment.',
          { paymentIntentId: intent.id, transactionId, retryable: false },
        )
      }
      await delay(this.confirmationPollIntervalMs)
      const retrieved = await this.provider.retrieve(clientSecret)
      assertRetrievedPayment(retrieved)
      intent = retrieved.paymentIntent
    }
  }
}

/**
 * Pick a funded route deterministically: explicit override, then Solana,
 * configured preferences, and finally the merchant's original option order.
 */
export function selectSettlementAccount(
  options: readonly PaymentSettlementOption[],
  accounts: readonly PaymentAccount[],
  preferredNetworks: readonly string[] = [],
  settlementOptionId?: string,
): { option: PaymentSettlementOption; account: PaymentAccount } {
  const optionById = new Map(options.map((option) => [option.id, option]))
  const spendable = accounts.flatMap((account) => {
    const option = optionById.get(account.settlementOptionId)
    if (!option || !isNonNegativeInteger(account.availableAmount)) return []
    if (typeof account.payerAddress !== 'string' || account.payerAddress.length === 0) return []
    return BigInt(account.availableAmount) >= BigInt(option.amount.value)
      ? [{ option, account }]
      : []
  })

  if (settlementOptionId) {
    const explicit = spendable.find(({ option }) => option.id === settlementOptionId)
    if (explicit) return explicit
    if (!optionById.has(settlementOptionId)) {
      throw new PaymentError(
        'PAYMENT_INTENT_INVALID',
        'Requested settlement option does not belong to this PaymentIntent.',
      )
    }
    throw new PaymentError(
      'PAYMENT_INSUFFICIENT_FUNDS',
      'The selected network does not have enough stablecoin balance.',
    )
  }

  const preference = new Map(
    preferredNetworks.map((network, index) => [network.toUpperCase(), index]),
  )
  const optionOrder = new Map(options.map((option, index) => [option.id, index]))
  spendable.sort((left, right) => {
    const leftSolana = left.option.rail === 'solana_spl' ? 0 : 1
    const rightSolana = right.option.rail === 'solana_spl' ? 0 : 1
    if (leftSolana !== rightSolana) return leftSolana - rightSolana
    const leftPreferred = preference.get(left.option.network.toUpperCase()) ?? Number.MAX_SAFE_INTEGER
    const rightPreferred = preference.get(right.option.network.toUpperCase()) ?? Number.MAX_SAFE_INTEGER
    if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred
    return (optionOrder.get(left.option.id) ?? 0) - (optionOrder.get(right.option.id) ?? 0)
  })
  const selected = spendable[0]
  if (!selected) {
    throw new PaymentError(
      'PAYMENT_INSUFFICIENT_FUNDS',
      'No accepted network has enough stablecoin balance for this payment.',
    )
  }
  return selected
}

function assertClientSecret(clientSecret: string): void {
  if (typeof clientSecret !== 'string' || clientSecret.trim().length < 8) {
    throw new PaymentError('INVALID_CLIENT_SECRET', 'Payment client secret is missing or malformed.')
  }
}

/**
 * The display token is opaque (`pdt_…`) and validated only for presence — its
 * meaning belongs to the wallet and the payment API. The wallet hard-fails a
 * checkout without one, so catching its absence here turns a dead popup into a
 * typed error at the merchant boundary.
 */
function assertDisplayToken(displayToken: string): void {
  if (typeof displayToken !== 'string' || displayToken.trim().length === 0) {
    throw new PaymentError(
      'PAYMENT_INTENT_INVALID',
      'Payment API did not return a display token for this PaymentIntent.',
    )
  }
}

function assertRetrievedPayment(retrieved: {
  paymentIntent: PaymentIntent
  displayToken: string
}): void {
  if (!retrieved || typeof retrieved !== 'object') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment API returned no PaymentIntent.')
  }
  assertPaymentIntent(retrieved.paymentIntent)
  assertDisplayToken(retrieved.displayToken)
}

function assertPaymentIntentId(paymentIntentId: string): void {
  if (typeof paymentIntentId !== 'string' || !/^pi_[A-Za-z0-9_-]{1,64}$/.test(paymentIntentId)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'PaymentIntent id is malformed.')
  }
}

function assertMoney(amount: PaymentAmount, field: string, allowZero = false): void {
  const valuePattern = allowZero ? /^\d+$/ : /^[1-9]\d*$/
  if (!amount || typeof amount !== 'object' || !valuePattern.test(amount.value)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', `${field}.value must be a positive integer string.`)
  }
  if (!Number.isInteger(amount.decimals) || amount.decimals < 0 || amount.decimals > 18) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', `${field}.decimals must be an integer between 0 and 18.`)
  }
  if (typeof amount.currency !== 'string' || !/^[A-Z0-9]{2,12}$/.test(amount.currency)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', `${field}.currency must be an uppercase asset code.`)
  }
}

function assertPaymentIntent(intent: PaymentIntent): void {
  if (!intent || typeof intent !== 'object') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'PaymentIntent id is missing.')
  }
  assertPaymentIntentId(intent.id)
  if (!PAYMENT_INTENT_STATUSES.has(intent.status)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', `Unknown PaymentIntent status: ${String(intent.status)}`, {
      paymentIntentId: intent.id,
    })
  }
  assertMoney(intent.presentment, 'presentment')
  if (!Array.isArray(intent.settlementOptions) || intent.settlementOptions.length === 0) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'PaymentIntent has no settlement options.', {
      paymentIntentId: intent.id,
    })
  }
  const ids = new Set<string>()
  for (const option of intent.settlementOptions) {
    assertSettlementOption(option, intent.id)
    if (!sameMoney(intent.presentment, option.amount)
      || intent.presentment.value !== option.amount.value) {
      throw new PaymentError(
        'PAYMENT_INTENT_INVALID',
        'Settlement option gross amount does not match the checkout price.',
        { paymentIntentId: intent.id },
      )
    }
    if (ids.has(option.id)) {
      throw new PaymentError('PAYMENT_INTENT_INVALID', 'PaymentIntent has duplicate settlement options.', {
        paymentIntentId: intent.id,
      })
    }
    ids.add(option.id)
  }
  if (intent.settlement) {
    assertSettlementOption(intent.settlement, intent.id)
    if (!ids.has(intent.settlement.id)) {
      throw new PaymentError('PAYMENT_INTENT_INVALID', 'Selected settlement is not one of the offered options.', {
        paymentIntentId: intent.id,
      })
    }
  }
  if (!intent.merchant?.id || !intent.merchant.name) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'PaymentIntent merchant identity is missing.', {
      paymentIntentId: intent.id,
    })
  }
  if (!isIsoDate(intent.createdAt) || (intent.expiresAt && !isIsoDate(intent.expiresAt))) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'PaymentIntent timestamps are invalid.', {
      paymentIntentId: intent.id,
    })
  }
}

function assertSettlementOption(option: PaymentSettlementOption, paymentIntentId: string): void {
  assertMoney(option?.amount, 'settlementOption.amount')
  assertMoney(option?.merchantReceives, 'settlementOption.merchantReceives')
  assertMoney(option?.protocolFee?.amount, 'settlementOption.protocolFee.amount', true)
  if (!option?.id || !option.rail || !option.network || !option.chainType || !option.chainId) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Settlement option identity is incomplete.', {
      paymentIntentId,
    })
  }
  if (!option.assetAddress || !option.recipient) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Settlement option asset or recipient is missing.', {
      paymentIntentId,
    })
  }
  const fee = option.protocolFee
  if (!Number.isInteger(fee.basisPoints) || fee.basisPoints < 0) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Settlement option protocol fee rate is invalid.', {
      paymentIntentId,
    })
  }
  // Unit coherence, not arithmetic: the SDK surfaces `amount` and
  // `merchantReceives` side by side, so they have to be denominated alike.
  if (!sameMoney(option.amount, fee.amount)
    || !sameMoney(option.amount, option.merchantReceives)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Settlement option money units do not match.', {
      paymentIntentId,
    })
  }
  // Deliberately NOT re-derived here: `merchantReceives + fee === amount`, the
  // fee-rate ceiling, the fee-recipient presence rule, and fee ≠ merchant
  // recipient. A compromised server would satisfy all four by adjusting the
  // fields together, so they buy no security; what they do buy is a hard
  // version gate — a new fee model or settlement rail would make this SDK
  // reject intents the server legitimately issued. Those invariants belong to
  // the issuer and to the KAT vectors in the cross-language contract table.
}

function sameMoney(left: PaymentAmount, right: PaymentAmount): boolean {
  return left.decimals === right.decimals && left.currency === right.currency
}

function assertPreparedPayment(prepared: PreparedPayment): void {
  if (!prepared || typeof prepared !== 'object') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment provider returned no preparation.')
  }
  assertPaymentIntent(prepared.paymentIntent)
  if (typeof prepared.attemptId !== 'string' || prepared.attemptId.length < 3) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Prepared payment attempt is missing.', {
      paymentIntentId: prepared.paymentIntent.id,
    })
  }
  assertExecution(prepared.execution, prepared.paymentIntent.id)
}

function assertExecution(execution: PaymentExecution, paymentIntentId: string): void {
  if (!execution || typeof execution !== 'object') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Prepared payment execution is missing.', {
      paymentIntentId,
    })
  }
  // Known rails get a shape check so a malformed payload fails here rather
  // than deep inside the wallet. An UNKNOWN rail is forwarded untouched: the
  // popup ships with the server and can support a rail this SDK build predates,
  // so rejecting here would make every new chain an SDK release plus a
  // merchant-wide upgrade.
  if (execution.kind === 'solana_machine_wallet_transfer') {
    if (
      execution.protocol !== 'solana_machine_wallet_execute_v1' ||
      !execution.mint ||
      !execution.recipient ||
      !/^\d+$/.test(execution.protocolFeeAmount)
    ) {
      throw new PaymentError('PAYMENT_INTENT_INVALID', 'Solana payment execution is invalid.', { paymentIntentId })
    }
    return
  }
  if (execution.kind === 'evm_machine_account_batch') {
    if (
      execution.protocol !== 'machine_account_execute_batch_with_signature_v1' ||
      !execution.chainId ||
      !Array.isArray(execution.calls) ||
      execution.calls.length === 0
    ) {
      throw new PaymentError('PAYMENT_INTENT_INVALID', 'EVM payment execution is invalid.', { paymentIntentId })
    }
  }
}

function assertPayable(intent: PaymentIntent): void {
  if (intent.expiresAt && Date.parse(intent.expiresAt) <= Date.now()) {
    throw new PaymentError('PAYMENT_INTENT_EXPIRED', 'PaymentIntent has expired. Create a new order before paying.', {
      paymentIntentId: intent.id,
    })
  }
  if (intent.status !== 'requires_confirmation') {
    throw new PaymentError('PAYMENT_INTENT_NOT_PAYABLE', `PaymentIntent cannot be paid from status ${intent.status}.`, {
      paymentIntentId: intent.id,
    })
  }
}

function normalizePreparationError(err: unknown): SoulPassError {
  // Same rule as the authorization leg: an already-typed rejection (payment or
  // wallet-side) keeps its code; only untyped throws get a payment wrapper.
  if (isSoulPassError(err)) return err
  return new PaymentError(
    'PAYMENT_PREPARATION_FAILED',
    err instanceof Error ? err.message : 'Payment preparation failed.',
    { retryable: true, cause: err },
  )
}

function isIsoDate(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isNonNegativeInteger(value: string): boolean {
  return typeof value === 'string' && /^\d+$/.test(value)
}

function normalizeDirectPayment(input: DirectPaymentInput) {
  if (!input || typeof input !== 'object') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment input is required.')
  }
  if (input.currency !== undefined && typeof input.currency !== 'string') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment currency must be a string.')
  }
  const currency = (input.currency ?? 'USDC').trim().toUpperCase()
  const amount = assertDecimalAmount(input.amount)
  const recipients = normalizeRecipients(input.recipients)
  const settlementOptions = resolveSettlementOptions(input.networks, recipients)
  const reference = normalizeDirectReference(input.reference)
  const metadata = normalizeDirectMetadata(input.metadata)
  const expiresInSeconds = input.expiresInSeconds
  if (expiresInSeconds !== undefined
      && (!Number.isInteger(expiresInSeconds)
        || expiresInSeconds < 60
        || expiresInSeconds > 86_400)) {
    throw new PaymentError(
      'PAYMENT_INTENT_INVALID',
      'expiresInSeconds must be an integer between 60 and 86400.',
    )
  }
  const webhookUrl = normalizeWebhookUrl(input.webhookUrl)
  return {
    amount,
    currency,
    settlementOptions,
    ...(reference ? { reference } : {}),
    ...(metadata ? { metadata } : {}),
    ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
    ...(webhookUrl ? { webhookUrl } : {}),
  }
}

/**
 * Shape only. Whether this URL is one you are allowed to name is decided server-side
 * against the request Origin — a check the SDK could not perform honestly anyway, since
 * it would be asserting something about the page it is running in.
 */
function normalizeWebhookUrl(value?: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment webhookUrl must be a string.')
  }
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > 2048) {
    throw new PaymentError(
      'PAYMENT_INTENT_INVALID',
      'Payment webhookUrl must not exceed 2048 characters.',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment webhookUrl is not a valid URL.')
  }
  if (parsed.protocol !== 'https:') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment webhookUrl must use HTTPS.')
  }
  return trimmed
}

/** Trim and upper-case the caller's recipient map, keyed by family or network. */
function normalizeRecipients(
  recipients: DirectPaymentInput['recipients'],
): ReadonlyMap<string, string> {
  if (!recipients || typeof recipients !== 'object' || Array.isArray(recipients)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment recipients are required.')
  }
  const normalized = new Map<string, string>()
  for (const [key, recipient] of Object.entries(recipients)) {
    if (recipient === undefined) continue
    if (typeof recipient !== 'string') {
      throw new PaymentError('PAYMENT_INTENT_INVALID', `Recipient for ${key} must be a string.`)
    }
    const address = recipient.trim()
    if (!address || address.length > 128) {
      throw new PaymentError(
        'PAYMENT_INTENT_INVALID',
        `Recipient for ${key} must contain 1-128 characters.`,
      )
    }
    normalized.set(key.toUpperCase(), address)
  }
  return normalized
}

/**
 * Expand the recipient map over the requested networks. An exact network key
 * wins over its family address; when the caller names no networks, every
 * default network whose family has an address is offered.
 */
function resolveSettlementOptions(
  requested: DirectPaymentInput['networks'],
  recipients: ReadonlyMap<string, string>,
): { network: string; recipient: string }[] {
  const familyOnly = new Set(['SOLANA', 'EVM'])
  const exactNetworks = [...recipients.keys()].filter((key) => !familyOnly.has(key))
  const defaults = DEFAULT_DIRECT_NETWORKS.filter((network) =>
    network === 'SOLANA' ? recipients.has('SOLANA') : recipients.has('EVM'),
  )
  if (requested !== undefined && !Array.isArray(requested)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment networks must be an array.')
  }
  const networks = [...new Set((requested ?? [...exactNetworks, ...defaults]).map((network) => {
    if (typeof network !== 'string') {
      throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment network names must be strings.')
    }
    return network.toUpperCase()
  }))]
  if (networks.length === 0 || networks.length > 8) {
    throw new PaymentError(
      'PAYMENT_INTENT_INVALID',
      'Direct payment requires between 1 and 8 settlement networks.',
    )
  }
  return networks.map((network) => {
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(network)) {
      throw new PaymentError('PAYMENT_INTENT_INVALID', `Invalid payment network: ${network}`)
    }
    const recipient = recipients.get(network)
      ?? recipients.get(network.startsWith('SOLANA') ? 'SOLANA' : 'EVM')
    if (!recipient) {
      throw new PaymentError(
        'PAYMENT_INTENT_INVALID',
        `No recipient was configured for ${network}.`,
      )
    }
    return { network, recipient }
  })
}

function normalizeDirectReference(value?: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment reference must be a string.')
  }
  const normalized = value.trim()
  if (normalized.length > 128) {
    throw new PaymentError(
      'PAYMENT_INTENT_INVALID',
      'Payment reference must not exceed 128 characters.',
    )
  }
  return normalized || undefined
}

function normalizeDirectMetadata(
  value?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment metadata must be an object.')
  }
  const entries = Object.entries(value)
  if (entries.length > 50) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment metadata must not exceed 50 entries.')
  }
  const normalized: Record<string, string> = {}
  for (const [key, metadataValue] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) {
      throw new PaymentError(
        'PAYMENT_INTENT_INVALID',
        'Payment metadata keys must contain 1-64 safe characters.',
      )
    }
    if (typeof metadataValue !== 'string' || metadataValue.length > 500) {
      throw new PaymentError(
        'PAYMENT_INTENT_INVALID',
        `Payment metadata value for ${key} must be a string of at most 500 characters.`,
      )
    }
    normalized[key] = metadataValue
  }
  return normalized
}

/**
 * Validate the shape of a human decimal price and nothing more.
 *
 * How many decimal places the asset supports is a property of the configured
 * stablecoin, which the payment API resolves per network; pinning a token table
 * here only let this SDK disagree with it, and made "support USDT" mean an SDK
 * release plus a merchant-wide upgrade.
 */
function assertDecimalAmount(value: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new PaymentError(
      'PAYMENT_INTENT_INVALID',
      'Payment amount must be a positive decimal string.',
    )
  }
  if (/^0(?:\.0*)?$/.test(value)) {
    throw new PaymentError('PAYMENT_INTENT_INVALID', 'Payment amount must be greater than zero.')
  }
  return value
}

/**
 * Per-browser salt mixed into reference-derived idempotency keys.
 *
 * Without it the key is `sha256(reference)`, and `reference` is documented as your
 * order id — a value an attacker can often guess. Anyone could then spoof the Origin
 * header, pre-create an intent under the key your next checkout will derive, and every
 * real payment for that order would fail forever on "idempotency key was already used
 * with different parameters". Same-origin reference collisions between two shoppers had
 * a quieter version of the same problem: idempotent replay hands the second caller the
 * FIRST one's client secret, so one shopper's capability leaked to another.
 *
 * A salt fixes both because it makes the key unguessable while keeping the property the
 * key exists for — a double-click or a reload in THIS browser still converges on one
 * immutable intent. What it deliberately gives up is convergence across devices, which
 * was never a safe form of deduplication: two browsers are two shoppers until proven
 * otherwise.
 */
const DIRECT_IDEMPOTENCY_SALT_KEY = 'soulpass_direct_payment_salt_v1'
const SALT_PATTERN = /^[0-9a-f]{32}$/
let cachedSalt: string | null = null

function originIdempotencySalt(): string {
  if (cachedSalt) return cachedSalt
  try {
    const stored = globalThis.localStorage?.getItem(DIRECT_IDEMPOTENCY_SALT_KEY)
    if (stored && SALT_PATTERN.test(stored)) {
      cachedSalt = stored
      return stored
    }
  } catch {
    // Privacy mode / partitioned storage. The module-level cache below still
    // deduplicates within this page, which is where double-clicks happen.
  }
  const fresh = bytesToHex(randomBytes(16))
  cachedSalt = fresh
  try {
    globalThis.localStorage?.setItem(DIRECT_IDEMPOTENCY_SALT_KEY, fresh)
  } catch {
    // Same as above: a page-lifetime salt is a weaker guarantee, not a broken one.
  }
  return fresh
}

function generateIdempotencyKey(reference?: string): string {
  if (reference) {
    // NUL separator so ("ab", "c") and ("a", "bc") cannot collide.
    const digest = sha256(new TextEncoder().encode(`${originIdempotencySalt()}\u0000${reference}`))
    return `sdk_ref_${bytesToHex(digest.slice(0, 20))}`
  }
  return `sdk_${bytesToHex(randomBytes(16))}`
}

/** Test seam: drop the cached salt so a suite can observe a fresh browser. */
export function __resetIdempotencySaltForTests(): void {
  cachedSalt = null
}

function isTerminal(status: PaymentIntent['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
