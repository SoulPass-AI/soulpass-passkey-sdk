import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import type { EvmPaymentCall } from './payment-wire'

const REFERENCE_PREFIX = 'soulpass:payment:v1:'

function isPaymentAttemptId(attemptId: string): boolean {
  return /^pa_[0-9a-f]{32}$/.test(attemptId)
}

/** Server-generated attempt identity, carried inside the signed wallet operation. */
export function paymentReferenceFor(attemptId: string): string {
  if (!isPaymentAttemptId(attemptId)) throw new Error('Invalid payment attempt identifier')
  return `${REFERENCE_PREFIX}${attemptId}`
}

/** Wire bytes of a reference: EVM marker calldata and Solana Memo data alike. */
export function paymentMemoData(reference: string): Uint8Array {
  if (!reference.startsWith(REFERENCE_PREFIX) || !isPaymentAttemptId(reference.slice(REFERENCE_PREFIX.length))) {
    throw new Error('Invalid payment reference')
  }
  return utf8ToBytes(reference)
}

/** A zero-value, no-code call inside the account's signed atomic batch. */
export function paymentMarkerCall(reference: string): EvmPaymentCall {
  return {
    target: '0x0000000000000000000000000000000000000000',
    value: '0',
    data: `0x${bytesToHex(paymentMemoData(reference))}`,
  }
}
