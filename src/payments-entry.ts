export { SoulPassPayments, selectSettlementAccount } from './payments/client'
export { createSoulPassPayments } from './payments/factory'
export type { CreateSoulPassPaymentsConfig } from './payments/factory'
export { HttpPaymentIntentProvider } from './payments/http-provider'
export { PaymentError, isPaymentError } from './payments/errors'
export type { PaymentErrorCode, PaymentErrorContext } from './payments/errors'
// PaymentError extends SoulPassError, so a merchant catching a payment also
// needs the base guard for wallet-side codes (USER_REJECTED, POPUP_CLOSED).
export { SoulPassError, isSoulPassError } from './errors'
export type { SoulPassErrorCode, SoulPassErrorContext } from './errors'
export type {
  CompletePaymentInput,
  CreatedPaymentIntent,
  CreateDirectPaymentInput,
  DirectPaymentInput,
  BeginPaymentOptions,
  EvmMachineAccountExecution,
  EvmPaymentCall,
  HttpPaymentIntentProviderConfig,
  PaymentAmount,
  PaymentAccount,
  PaymentAuthorizationSession,
  PaymentConfirmationSession,
  PaymentIntent,
  PaymentIntentProvider,
  PaymentIntentStatus,
  PaymentExecution,
  PaymentFailure,
  PaymentMerchant,
  PaymentProtocolFee,
  PaymentFetch,
  PaymentResult,
  PaymentSettlementOption,
  PaymentWallet,
  PreparedPayment,
  PreparePaymentInput,
  RetrievedPaymentIntent,
  SolanaMachineWalletExecution,
  SoulPassPaymentsConfig,
} from './payments/types'
