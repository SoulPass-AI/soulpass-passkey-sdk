import { SoulPassWallet } from '../wallet'
import { deriveApiUrl } from '../matrix-http'
import { DEFAULT_WALLET_URL } from '../types'
import type { SoulPassWalletConfig } from '../types'
import { SoulPassPayments } from './client'
import { HttpPaymentIntentProvider, paymentApiBaseFromRoot } from './http-provider'

export interface CreateSoulPassPaymentsConfig extends SoulPassWalletConfig {
  /**
   * Payment API base including the service context and `/v1` (e.g.
   * `https://api.soulpass.ai/api/system/v1`); defaults from the wallet
   * environment.
   */
  paymentApiUrl?: string
  preferredNetworks?: readonly string[]
  confirmationTimeoutMs?: number
  confirmationPollIntervalMs?: number
}

/** Zero-registration production client for `await soulpass.pay(...)`. */
export function createSoulPassPayments(
  config: CreateSoulPassPaymentsConfig = {},
): SoulPassPayments {
  const walletUrl = config.walletUrl ?? DEFAULT_WALLET_URL
  const apiRoot = config.apiUrl ?? deriveApiUrl(walletUrl)
  return new SoulPassPayments({
    wallet: new SoulPassWallet(config),
    provider: new HttpPaymentIntentProvider({
      baseUrl: config.paymentApiUrl ?? paymentApiBaseFromRoot(apiRoot),
    }),
    preferredNetworks: config.preferredNetworks,
    confirmationTimeoutMs: config.confirmationTimeoutMs,
    confirmationPollIntervalMs: config.confirmationPollIntervalMs,
  })
}
