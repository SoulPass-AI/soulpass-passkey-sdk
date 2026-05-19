/**
 * Per-Execute ephemeral signer PDAs — Squads-v4 model adapted for
 * machine-wallet's monotonic-nonce design.
 *
 * Motivation
 * ----------
 * A passkey wallet routes every inner instruction through
 * `MachineWallet::Execute`, which historically only ever promoted the vault
 * PDA to `is_signer = true` via `invoke_signed`. That blocks integrations
 * with any program whose inner ix demands an external keypair signer:
 * Switchboard `Randomness.create`, `SystemProgram.createAccount`,
 * `token_metadata::MasterEdition`, etc.
 *
 * Squads-v4 solves this by replacing the dApp's `Keypair.generate()` with a
 * PDA whose seeds incorporate per-call entropy (their transaction PDA);
 * `invoke_signed` then provides signer privilege at CPI time. We adopt the
 * same shape — the entropy source is the wallet's monotonic nonce instead
 * of a per-tx state account, because machine-wallet has no per-tx state.
 *
 * Seeds (must mirror machine-wallet `MachineWallet::EPHEMERAL_SIGNER_SEED_PREFIX`
 * and `processor::execute::process_with_ephemeral_signers`):
 *
 *   [b"machine_ephemeral",
 *    walletAccount.toBytes(),
 *    walletNonce.toLeBytes(8),
 *    [index_u8],
 *    [bump]]
 *
 * Lifetime
 * --------
 * The PDA is meaningful only inside the single Execute call that bumps the
 * wallet nonce; after success the same `index` derives a different PDA
 * (next nonce). A relay cannot replay because the on-chain handler binds
 * `(nonce, bumps, inner_hash)` into the threshold challenge — see
 * `compute_message_hash_v1`. Off-curve PDAs reclaim their own rent when
 * inner ix closes the account they were init'd into.
 */

import { PublicKey } from '@solana/web3.js'
import { u64LE } from './wire-format/_bytes'

/** Mirror of `MachineWallet::EPHEMERAL_SIGNER_SEED_PREFIX` (state.rs). */
export const EPHEMERAL_SIGNER_SEED_PREFIX = new TextEncoder().encode(
  'machine_ephemeral',
)

/** Mirror of `state::MAX_EPHEMERAL_SIGNERS` — keep in sync with the on-chain cap. */
export const MAX_EPHEMERAL_SIGNERS = 4

/** A single ephemeral signer the dApp can reference in an inner instruction. */
export interface EphemeralSigner {
  /** PDA pubkey to use in inner-ix accounts (with `FLAG_EPHEMERAL_SIGNER`). */
  pubkey: PublicKey
  /** Bump byte that must be forwarded to the popup via `SignTransactionOptions.ephemeralSignerBumps`. */
  bump: number
  /** Position in the bumps array — matches the seed `index` byte. */
  index: number
}

export interface DeriveEphemeralSignersInput {
  /** MachineWallet account pubkey (PDA) — same value `SoulPassWallet.walletAddress` returns. */
  walletAddress: PublicKey
  /**
   * Current value of `wallet.nonce` from the on-chain MachineWallet account.
   * Use `predictNextExecuteNonce(connection, walletAddress)` to obtain this —
   * it handles the "undeployed wallet ⇒ `0n`" contract (popup lazy-deploys
   * CreateWallet before the dApp's Execute lands; `Execute` then reads
   * `nonce = 0`).
   */
  walletNonce: bigint
  /** Number of distinct ephemeral signers needed for this Execute call. */
  count: number
  /** machine-wallet `programId`. */
  programId: PublicKey
}

/**
 * Derive `count` ephemeral signer PDAs deterministically. Pure function:
 * given the same `(walletAddress, walletNonce, count)` it always returns
 * the same pubkeys. The matching nonce MUST be live at Execute time — if
 * another instruction bumps the wallet nonce between derive and submit,
 * the chain rejects with `MessageMismatch` (compute_message_hash_v1
 * differs on `nonce`) before any state change.
 *
 * Throws if `count` is outside `1..=MAX_EPHEMERAL_SIGNERS`. Throws if the
 * runtime cannot find a valid bump for some `index` — this is statistically
 * negligible (probability 2^-256 per index) but surfacing the error keeps
 * the failure mode explicit instead of silently dropping a signer.
 */
export function deriveEphemeralSigners(
  input: DeriveEphemeralSignersInput,
): EphemeralSigner[] {
  const { walletAddress, walletNonce, count, programId } = input
  if (count < 1 || count > MAX_EPHEMERAL_SIGNERS) {
    throw new RangeError(
      `count must be in [1, ${MAX_EPHEMERAL_SIGNERS}] — got ${count}`,
    )
  }
  if (walletNonce < 0n || walletNonce >= 1n << 64n) {
    throw new RangeError(`nonce out of u64 range: ${walletNonce}`)
  }

  const walletKeyBytes = walletAddress.toBytes()
  const nonceBytes = u64LE(walletNonce)

  const result: EphemeralSigner[] = []
  for (let i = 0; i < count; i++) {
    const indexBytes = new Uint8Array([i])
    const [pubkey, bump] = PublicKey.findProgramAddressSync(
      [EPHEMERAL_SIGNER_SEED_PREFIX, walletKeyBytes, nonceBytes, indexBytes],
      programId,
    )
    result.push({ pubkey, bump, index: i })
  }
  return result
}
