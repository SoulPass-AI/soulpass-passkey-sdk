import { describe, it, expect, vi } from 'vitest'
import { Keypair } from '@solana/web3.js'
import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js'
import { SigScheme, predictNextExecuteNonce, walletAccountSize } from '../src/wallet-state'

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

// Build a synthetic single-authority 'W' account (186-byte header + one slot)
// that survives parseWalletState's full validation. Filler is `0xAA` so a
// mis-aligned read surfaces as a wrong value rather than a coincidental zero;
// only the fields the decoder checks are set (offsets from `state.rs`).
function makeAccountBody(nonce: bigint): Buffer {
  const buf = Buffer.alloc(walletAccountSize(1), 0xaa)
  buf[0] = 0x57 // 'W'
  buf[34] = 1 // threshold
  buf[35] = 1 // authority_count
  buf.writeBigUInt64LE(nonce, 36)
  // root (53) and authority 0 (186): the same WebAuthn key.
  for (const off of [53, 186]) {
    buf[off] = SigScheme.Webauthn
    buf[off + 1] = 0x02
  }
  // pending_root (95) EMPTY: 0xFF || 33 zero bytes, recovery_eta (129) = 0.
  buf[95] = 0xff
  buf.fill(0, 96, 137)
  buf[169] = 0 // recovery_threshold
  // session_nonce (170) and governance_nonce (178) differ from N, so reading
  // the wrong counter as the Execute nonce fails.
  buf.writeBigUInt64LE(0x0b0b_0b0bn, 170)
  buf.writeBigUInt64LE(0x1111_1111n, 178)
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

  it('throws when the account exists but is too short', async () => {
    // One byte short of a one-authority wallet. Contract is "missing ⇒ 0n,
    // malformed ⇒ throw"; this asserts the second branch doesn't silently
    // degrade into the first.
    const connection = makeConnection(async () => ({
      data: makeAccountBody(0n).subarray(0, walletAccountSize(1) - 1),
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
