/**
 * Client-side quorum preflight for root-governed MachineWallet operations, so
 * nobody passes a biometric prompt for a transaction the program will reject.
 *
 * Mirrors `machine-wallet/program/src/processor/{set_threshold,recovery,
 * add_authority,remove_authority}.rs` with `threshold::Policy`. The program
 * stays the authority: the mandatory pre-sign simulation still runs; this only
 * moves the predictable refusals before the ceremony.
 *
 * | Operation                 | Needs |
 * |---------------------------|-------|
 * | SetThreshold(k)           | root + max(threshold, k) signers |
 * | SetRecoveryThreshold(k)   | root + max(threshold, k) signers (k = 0 follows the spending threshold) |
 * | AddAuthority              | root + threshold (new_threshold 0); the new key's PoP is separate |
 * | RemoveAuthority (other)   | root + threshold, and the post-removal threshold from surviving keys |
 * | RemoveAuthority (self)    | the leaving key + threshold, and min(threshold, n − 1) surviving keys |
 *
 * The removed key never counts toward the surviving quorum.
 *
 * Thrown `Error` messages start with the on-chain error name the program would
 * return (`RootRequired`, `InsufficientSignatures`, `InvalidThreshold`,
 * `AuthorityNotFound`, `CannotRemoveLastAuthority`).
 */

import type { MachineWalletErrorName } from './wire-format/errors'
import { findAuthority, isRoot, type MachineWalletState, type WalletAuthoritySlot } from './wallet-state'

export type GovernanceQuorumOperation =
  | { kind: 'setThreshold'; newThreshold: number }
  | { kind: 'setRecoveryThreshold'; recoveryThreshold: number }
  | { kind: 'addAuthority' }
  | { kind: 'removeAuthority'; target: WalletAuthoritySlot; newThreshold: number }
  | { kind: 'removeSelf'; target: WalletAuthoritySlot }

/** What an operation needs: the root's signature and how many distinct authorities. */
export interface GovernanceQuorum {
  rootRequired: boolean
  /** Distinct live authorities that must sign (the root counts). */
  signers: number
  /** For removals: signers other than the removed key. */
  survivingSigners?: number
}

type QuorumState = Pick<MachineWalletState, 'threshold' | 'authorityCount' | 'authorities' | 'root'>

function fail(name: MachineWalletErrorName, detail: string): never {
  throw new Error(`${name}: ${detail}`)
}

/** The quorum `op` needs against `state`; throws for parameters the program rejects outright. */
export function governanceQuorum(state: QuorumState, op: GovernanceQuorumOperation): GovernanceQuorum {
  const { threshold, authorityCount: n } = state
  switch (op.kind) {
    case 'setThreshold':
      if (!Number.isInteger(op.newThreshold) || op.newThreshold < 1 || op.newThreshold > n) fail('InvalidThreshold', `threshold must be 1..=${n}`)
      return { rootRequired: true, signers: Math.max(threshold, op.newThreshold) }
    case 'setRecoveryThreshold':
      if (!Number.isInteger(op.recoveryThreshold) || op.recoveryThreshold < 0 || op.recoveryThreshold > n) fail('InvalidThreshold', `recovery threshold must be 0..=${n}`)
      return { rootRequired: true, signers: Math.max(threshold, op.recoveryThreshold) }
    case 'addAuthority':
      return { rootRequired: true, signers: threshold }
    case 'removeAuthority':
    case 'removeSelf': {
      if (findAuthority(state, op.target) < 0) fail('AuthorityNotFound', 'target is not an authority')
      if (n <= 1) fail('CannotRemoveLastAuthority', 'the wallet keeps at least one authority')
      const newCount = n - 1
      if (op.kind === 'removeSelf') return { rootRequired: false, signers: threshold, survivingSigners: Math.min(threshold, newCount) }
      if (!Number.isInteger(op.newThreshold) || op.newThreshold < 0 || op.newThreshold > newCount) fail('InvalidThreshold', `new threshold must be 0..=${newCount}`)
      if (op.newThreshold === 0 && threshold > newCount) fail('InvalidThreshold', 'the current threshold exceeds the remaining authorities; name a new one')
      return { rootRequired: true, signers: threshold, survivingSigners: op.newThreshold || threshold }
    }
  }
}

/**
 * Throw unless `signers` (the authorities that will sign this operation's
 * message) satisfy {@link governanceQuorum}. Unknown keys and repeats count
 * once or not at all, as on chain.
 */
export function assertGovernanceQuorum(
  state: QuorumState,
  op: GovernanceQuorumOperation,
  signers: readonly WalletAuthoritySlot[],
): void {
  const need = governanceQuorum(state, op)
  const indexes = new Set(signers.map((s) => findAuthority(state, s)).filter((i) => i >= 0))
  const targetSigned = 'target' in op && indexes.has(findAuthority(state, op.target))
  if (op.kind === 'removeSelf' && !targetSigned) {
    fail('InsufficientSignatures', 'a self-removal is signed by the leaving key')
  }
  if (need.rootRequired && !signers.some((s) => isRoot(state, s))) fail('RootRequired', 'the root must sign')
  if (indexes.size < need.signers) fail('InsufficientSignatures', `${need.signers} authorities must sign, got ${indexes.size}`)
  if (need.survivingSigners !== undefined) {
    const surviving = indexes.size - (targetSigned ? 1 : 0)
    if (surviving < need.survivingSigners) {
      fail('InsufficientSignatures', `${need.survivingSigners} surviving authorities must sign (the removed key never counts), got ${surviving}`)
    }
  }
}
