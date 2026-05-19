import { describe, it, expect, vi } from 'vitest'
import { Keypair } from '@solana/web3.js'
import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js'
import {
  V1_OFFSET,
  V1_MIN_ACCOUNT_SIZE,
  SigScheme,
  predictNextExecuteNonce,
} from '../src/wallet-state'

/**
 * Stub Connection: only `getAccountInfo` is exercised, so we accept the
 * narrow shape predictNextExecuteNonce actually depends on without dragging
 * the full @solana/web3.js Connection class into the test.
 */
function makeConnection(
  impl: (address: PublicKey) => Promise<AccountInfo<Buffer> | null>,
): Connection {
  return {
    getAccountInfo: vi.fn((address: PublicKey) => impl(address)),
  } as unknown as Connection
}

// Build a synthetic v1 account body that survives parseWalletState's full
// validation. Filler is `0xAA` so a mis-aligned read surfaces as a wrong value
// rather than a coincidental zero.
function makeAccountBody(nonce: bigint, totalLen = V1_MIN_ACCOUNT_SIZE): Buffer {
  const buf = Buffer.alloc(totalLen, 0xaa)
  buf[V1_OFFSET.VERSION] = 1
  buf[V1_OFFSET.AUTHORITY_COUNT] = 1
  buf.writeBigUInt64LE(nonce, V1_OFFSET.NONCE)
  buf[V1_OFFSET.AUTHORITY_SLOTS_START] = SigScheme.Webauthn
  return buf
}

describe('predictNextExecuteNonce', () => {
  const walletAddress = Keypair.generate().publicKey

  it('returns 0n when the wallet PDA has no on-chain account yet', async () => {
    const connection = makeConnection(async () => null)
    const nonce = await predictNextExecuteNonce(connection, walletAddress)
    expect(nonce).toBe(0n)
  })

  it('reads the live nonce as u64 little-endian from offset 36', async () => {
    const connection = makeConnection(async () => ({
      data: makeAccountBody(0x0102030405060708n),
      owner: walletAddress,
      executable: false,
      lamports: 0,
      rentEpoch: 0,
    }))
    const nonce = await predictNextExecuteNonce(connection, walletAddress)
    expect(nonce).toBe(0x0102030405060708n)
  })

  it('reads the boundary value u64::MAX without overflow', async () => {
    const max = (1n << 64n) - 1n
    const connection = makeConnection(async () => ({
      data: makeAccountBody(max),
      owner: walletAddress,
      executable: false,
      lamports: 0,
      rentEpoch: 0,
    }))
    expect(await predictNextExecuteNonce(connection, walletAddress)).toBe(max)
  })

  it('throws when the account exists but is too short for v1', async () => {
    // Below `V1_MIN_ACCOUNT_SIZE`. Contract is "missing ⇒ 0n, malformed ⇒
    // throw"; this asserts the second branch doesn't silently degrade into
    // the first.
    const connection = makeConnection(async () => ({
      data: Buffer.alloc(V1_MIN_ACCOUNT_SIZE - 1, 0xaa),
      owner: walletAddress,
      executable: false,
      lamports: 0,
      rentEpoch: 0,
    }))
    await expect(
      predictNextExecuteNonce(connection, walletAddress),
    ).rejects.toThrow(/too small/i)
  })

  it('queries getAccountInfo at the wallet PDA with confirmed commitment', async () => {
    const spy = vi.fn(async () => null)
    const connection = { getAccountInfo: spy } as unknown as Connection
    await predictNextExecuteNonce(connection, walletAddress)
    expect(spy).toHaveBeenCalledWith(walletAddress, 'confirmed')
  })
})
