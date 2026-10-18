import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { expect, it } from 'vitest'
import { paymentMarkerCall, paymentMemoData, paymentReferenceFor } from '../src/payment-binding'

it('binds a canonical server attempt to an unambiguous marker', () => {
  const reference = paymentReferenceFor(`pa_${'a'.repeat(32)}`)
  const marker = paymentMarkerCall(reference)
  expect(marker.target).toBe('0x0000000000000000000000000000000000000000')
  expect(marker.value).toBe('0')
  expect(marker.data).toBe(`0x${bytesToHex(utf8ToBytes(reference))}`)
  expect(paymentMemoData(reference)).toEqual(utf8ToBytes(reference))
  expect(() => paymentReferenceFor('merchant-chosen-reference')).toThrow()
  expect(() => paymentMarkerCall(reference + ':another')).toThrow()
  expect(() => paymentMemoData(reference + ':another')).toThrow()
})
