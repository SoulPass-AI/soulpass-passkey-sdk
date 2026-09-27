import { SoulPassWallet } from '../wallet'
import { resolveWalletEndpoints } from '../matrix-http'
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
  const { apiUrl } = resolveWalletEndpoints(config)
  return new SoulPassPayments({
    wallet: new SoulPassWallet(config),
    provider: new HttpPaymentIntentProvider({
      baseUrl: config.paymentApiUrl ?? paymentApiBaseFromRoot(apiUrl),
    }),
    preferredNetworks: config.preferredNetworks,
    confirmationTimeoutMs: config.confirmationTimeoutMs,
    confirmationPollIntervalMs: config.confirmationPollIntervalMs,
  })
}
