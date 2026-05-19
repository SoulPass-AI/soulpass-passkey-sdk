/**
 * Off-chain reader for the MachineWallet v1 account body.
 *
 * Lives here (not in `ephemeral-signers.ts`) because the byte layout is an
 * on-chain implementation detail of `machine-wallet`, while ephemeral-signer
 * derivation is the public Squads-v4-style protocol layered on top. Future
 * SDK additions that consume other fields (e.g. `creation_slot` for a
 * sponsored Execute preflight) belong here too.
 *
 * **Why the dApp doesn't read the account directly:** the byte offset and
 * the "missing account ⇒ default 0n" contract (documented below) are both
 * on-chain invariants that change with `state.rs`. Routing through this
 * module makes a layout bump a single-PR rollout — bump SDK minor, every
 * consumer follows on `npm update`. The previous in-dApp `NONCE_OFFSET = 36`
 * literal had no such cross-cutting fixup path.
 */

import type { Connection, PublicKey } from '@solana/web3.js'

/**
 * Byte offset of `wallet.nonce` (u64 LE) inside a serialized MachineWallet
 * v1 account body. Mirrors `machine-wallet/program/src/state.rs::MachineWallet::NONCE_OFFSET`.
 *
 * v1 header layout (53 bytes, fixed):
 *
 * | range   | field           | type            |
 * |---------|-----------------|-----------------|
 * | 0..1    | version         | u8 (= 1)        |
 * | 1..2    | bump            | u8              |
 * | 2..34   | wallet_id       | [u8; 32]        |
 * | 34..35  | threshold       | u8              |
 * | 35..36  | authority_count | u8              |
 * | 36..44  | **nonce**       | u64 LE          |
 * | 44..52  | creation_slot   | u64 LE          |
 * | 52..53  | vault_bump      | u8              |
 *
 * Authority slots (34 bytes each) follow the header.
 */
export const MACHINE_WALLET_NONCE_OFFSET = 36

/**
 * Returns the `wallet.nonce` value the next `MachineWallet::Execute` will
 * observe — `0n` if the wallet hasn't been deployed yet on this cluster.
 *
 * Why `0n` is the correct fallback for an undeployed wallet
 * --------------------------------------------------------
 * For passkey (WebAuthn) wallets, the soulpass.ai popup lazy-deploys the
 * MachineWallet PDA when it sees a sign request against a missing account:
 * it submits `CreateWallet` (which initialises `nonce = 0`) and then the
 * dApp's `Execute` in two ordered txs — they can't be bundled because
 * `Execute`'s `operation_hash` is bound to `creation_slot`, which is only
 * fixed once `CreateWallet` lands on chain (see
 * `machine-wallet/program/src/processor/create_wallet.rs` and the
 * `compute_message_hash_v1` discussion in `processor/execute.rs`).
 *
 * The dApp doesn't see those two txs — from its perspective it hands one
 * `Execute` (with inner ixs) to the popup and gets back a signature.
 * `nonce` only increments **inside** `Execute`, so when the chain reads
 * `wallet.nonce` to verify ephemeral-signer PDAs against the dApp-supplied
 * `ephemeralSignerBumps`, it reads `0`. Deriving ephemeral PDAs with
 * `walletNonce: 0n` therefore yields the same PDAs `invoke_signed` will
 * produce — signer privilege grants line up, no `MessageMismatch`.
 *
 * Why this isn't a "may break later" hack
 * ---------------------------------------
 * The on-chain `CreateWallet` initialiser writes `nonce = 0` unconditionally
 * (see `state.rs::MachineWallet::new`). The popup's lazy-deploy
 * choreography is the SDK ↔ popup contract: changing it on either side
 * requires a coordinated rollout, of which this function is the dApp-facing
 * surface. If a future MachineWallet version needs a non-zero starting
 * nonce, that version is necessarily a `state.rs` bump too — the version
 * gating below would reject it, and the SDK helper signature would change
 * accordingly.
 *
 * Throws
 * ------
 * - When the account exists but is shorter than `MACHINE_WALLET_NONCE_OFFSET + 8`.
 *   That's a real format incompatibility (corrupt state, or a future major
 *   version with a smaller header), distinct from the recoverable
 *   lazy-deploy case.
 */
export async function predictNextExecuteNonce(
  connection: Connection,
  walletAddress: PublicKey,
): Promise<bigint> {
  const account = await connection.getAccountInfo(walletAddress, 'confirmed')
  if (!account) return 0n
  const data = account.data
  if (data.length < MACHINE_WALLET_NONCE_OFFSET + 8) {
    throw new Error(
      `MachineWallet account body too short: ${data.length} bytes ` +
        `(expected at least ${MACHINE_WALLET_NONCE_OFFSET + 8} for v1 layout) ` +
        `— refusing to fabricate a nonce`,
    )
  }
  // Use DataView (not `Buffer`) so this module stays browser-friendly
  // without pulling Node's polyfill into the SDK bundle.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return view.getBigUint64(MACHINE_WALLET_NONCE_OFFSET, true)
}
