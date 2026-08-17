import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  generateChannelId,
  SignChannelClient,
  type SignChannelResult,
} from '../src/sign-channel'
import { deriveApiUrl } from '../src/matrix-http'
import { asVaultPda } from '../src/types'
import { CHANNEL_ID_RE, jsonResponse } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('generateChannelId', () => {
  it('emits 22-char base64url ids that satisfy the cross-stack regex', () => {
    const id = generateChannelId()
    expect(id).toHaveLength(22)
    expect(id).toMatch(CHANNEL_ID_RE)
  })
  it('is collision-free across a small sample', () => {
    const seen = new Set(Array.from({ length: 64 }, () => generateChannelId()))
    expect(seen.size).toBe(64)
  })
})

describe('deriveApiUrl', () => {
  it('maps production wallet origin to the api host', () => {
    expect(deriveApiUrl('https://soulpass.ai')).toBe('https://api.soulpass.ai/api')
  })
  it('maps env-prefixed wallet origins to env api hosts', () => {
    expect(deriveApiUrl('https://test.soulpass.ai')).toBe('https://api-test.soulpass.ai/api')
    expect(deriveApiUrl('https://uat.soulpass.ai')).toBe('https://api-uat.soulpass.ai/api')
  })
  it('falls back to same-origin /api for unknown hosts', () => {
    expect(deriveApiUrl('https://localhost:3000')).toBe('https://localhost:3000/api')
  })
})

describe('SignChannelClient.putPayload', () => {
  it('POSTs the payload to the sign-channels endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SignChannelClient('https://api.soulpass.ai/api')
    const delivered = await client.putPayload('c'.repeat(22), {
      transaction: 'AQID',
      walletAddress: asVaultPda('VauLt111'),
      network: 'mainnet-beta',
    })
    expect(delivered).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.soulpass.ai/api/user/v1/sign-channels/payload')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.channelId).toBe('c'.repeat(22))
    expect(body.transaction).toBe('AQID')
  })
  it('swallows network failures and reports the mailbox as undelivered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const client = new SignChannelClient('https://api.soulpass.ai/api')
    await expect(
      client.putPayload('c'.repeat(22), {
        transaction: 'AQID',
        walletAddress: asVaultPda('VauLt111'),
        network: 'mainnet-beta',
      }),
    ).resolves.toBe(false)
  })
})

describe('SignChannelClient.pollResult', () => {
  it('resolves on the first terminal status', async () => {
    vi.useFakeTimers()
    const answers = [
      jsonResponse({ status: 'pending' }),
      jsonResponse({ status: 'claimed' }),
      jsonResponse({ status: 'completed', signature: 'sig123' }),
    ]
    const fetchMock = vi.fn(async () => answers.shift() ?? jsonResponse({ status: 'completed', signature: 'sig123' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SignChannelClient('https://api.soulpass.ai/api')
    const controller = new AbortController()
    const resultP = client.pollResult('c'.repeat(22), { signal: controller.signal, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(3500)
    const result: SignChannelResult = await resultP
    expect(result.status).toBe('completed')
    expect(result.signature).toBe('sig123')
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe(
      `https://api.soulpass.ai/api/user/v1/sign-channels/result-poll?channelId=${'c'.repeat(22)}`,
    )
  })
  it('resolves cancelled as a terminal status (caller maps it to reject)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'cancelled' })))
    const client = new SignChannelClient('https://api.soulpass.ai/api')
    const controller = new AbortController()
    const resultP = client.pollResult('c'.repeat(22), { signal: controller.signal, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(10)
    await expect(resultP).resolves.toEqual({ status: 'cancelled' })
  })
  it('stops polling and rejects when aborted', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'pending' }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new SignChannelClient('https://api.soulpass.ai/api')
    const controller = new AbortController()
    const resultP = client.pollResult('c'.repeat(22), { signal: controller.signal, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(1500)
    const callsBeforeAbort = fetchMock.mock.calls.length
    controller.abort()
    await expect(resultP).rejects.toThrow('ABORTED')
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock.mock.calls.length).toBe(callsBeforeAbort)
  })
  it('keeps polling through transient network errors', async () => {
    vi.useFakeTimers()
    let first = true
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (first) { first = false; throw new Error('flaky') }
      return jsonResponse({ status: 'completed', signature: 's' })
    }))
    const client = new SignChannelClient('https://api.soulpass.ai/api')
    const controller = new AbortController()
    const resultP = client.pollResult('c'.repeat(22), { signal: controller.signal, intervalMs: 1000 })
    await vi.advanceTimersByTimeAsync(2500)
    await expect(resultP).resolves.toEqual({ status: 'completed', signature: 's' })
  })
})
