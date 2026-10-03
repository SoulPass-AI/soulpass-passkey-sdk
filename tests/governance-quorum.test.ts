// @vitest-environment node
// Mirrors the quorum checks in machine-wallet set_threshold.rs, recovery.rs,
// add_authority.rs and remove_authority.rs (spec D4 "Quorum").
import { describe, it, expect } from 'vitest'
import { governanceQuorum, assertGovernanceQuorum } from '../src/governance-quorum'
import { SigScheme, type WalletAuthoritySlot } from '../src/wallet-state'

const key = (b: number): WalletAuthoritySlot => ({ sigScheme: SigScheme.Ed25519, pubkey: Uint8Array.from([...new Uint8Array(32).fill(b), 0]) })
const [ROOT, A, B, C] = [key(1), key(2), key(3), key(4)]
const wallet = (threshold: number, authorities = [ROOT, A, B, C]) => ({ threshold, authorityCount: authorities.length, authorities, root: ROOT })

describe('governanceQuorum', () => {
  it('SetThreshold(k) needs root + max(old, k)', () => {
    expect(governanceQuorum(wallet(2), { kind: 'setThreshold', newThreshold: 3 })).toEqual({ rootRequired: true, signers: 3 })
    expect(governanceQuorum(wallet(3), { kind: 'setThreshold', newThreshold: 1 })).toEqual({ rootRequired: true, signers: 3 })
    expect(() => governanceQuorum(wallet(2), { kind: 'setThreshold', newThreshold: 5 })).toThrow(/^InvalidThreshold/)
  })

  it('SetRecoveryThreshold(k) needs root + max(spending, k)', () => {
    expect(governanceQuorum(wallet(2), { kind: 'setRecoveryThreshold', recoveryThreshold: 4 }).signers).toBe(4)
    expect(governanceQuorum(wallet(2), { kind: 'setRecoveryThreshold', recoveryThreshold: 0 }).signers).toBe(2)
  })

  it('AddAuthority needs root + threshold', () => {
    expect(governanceQuorum(wallet(3), { kind: 'addAuthority' })).toEqual({ rootRequired: true, signers: 3 })
  })

  it('removals need the post-removal threshold from surviving keys', () => {
    expect(governanceQuorum(wallet(2), { kind: 'removeAuthority', target: A, newThreshold: 0 })).toEqual({ rootRequired: true, signers: 2, survivingSigners: 2 })
    expect(governanceQuorum(wallet(2), { kind: 'removeAuthority', target: A, newThreshold: 3 }).survivingSigners).toBe(3)
    expect(governanceQuorum(wallet(4), { kind: 'removeSelf', target: A })).toEqual({ rootRequired: false, signers: 4, survivingSigners: 3 })
    expect(() => governanceQuorum(wallet(4), { kind: 'removeAuthority', target: A, newThreshold: 0 })).toThrow(/^InvalidThreshold/)
    expect(() => governanceQuorum(wallet(1, [ROOT]), { kind: 'removeSelf', target: ROOT })).toThrow(/^CannotRemoveLastAuthority/)
    expect(() => governanceQuorum(wallet(1), { kind: 'removeAuthority', target: key(9), newThreshold: 0 })).toThrow(/^AuthorityNotFound/)
  })
})

describe('assertGovernanceQuorum', () => {
  it('requires the root', () => {
    expect(() => assertGovernanceQuorum(wallet(2), { kind: 'setThreshold', newThreshold: 2 }, [A, B])).toThrow(/^RootRequired/)
    expect(() => assertGovernanceQuorum(wallet(2), { kind: 'setThreshold', newThreshold: 2 }, [ROOT, A])).not.toThrow()
  })

  it('counts distinct authorities only', () => {
    expect(() => assertGovernanceQuorum(wallet(2), { kind: 'addAuthority' }, [ROOT, ROOT, key(9)])).toThrow(/^InsufficientSignatures/)
  })

  it('never counts the removed key toward the surviving quorum', () => {
    const op = { kind: 'removeAuthority', target: A, newThreshold: 0 } as const
    expect(() => assertGovernanceQuorum(wallet(2), op, [ROOT, A])).toThrow(/surviving/)
    expect(() => assertGovernanceQuorum(wallet(2), op, [ROOT, B])).not.toThrow()
  })

  it('a self-removal is signed by the leaving key and needs no root', () => {
    expect(() => assertGovernanceQuorum(wallet(2), { kind: 'removeSelf', target: A }, [B, C])).toThrow(/leaving key/)
    expect(() => assertGovernanceQuorum(wallet(2), { kind: 'removeSelf', target: A }, [A, B])).toThrow(/surviving/)
    expect(() => assertGovernanceQuorum(wallet(2), { kind: 'removeSelf', target: A }, [A, B, C])).not.toThrow()
  })
})
