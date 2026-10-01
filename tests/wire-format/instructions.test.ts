// @vitest-environment node
/**
 * Instruction-data builders for every MachineWallet instruction other than
 * Execute / ExecuteWithEphemeralSigners / ProvideWebAuthnEvidence
 * (`execute-ix.ts`) and CreateSession (`session.ts`).
 *
 * The six root/recovery/epoch vectors are pinned byte-for-byte against
 * `tests/fixtures/layout_kat.json`, a verbatim copy of the machine-wallet
 * program's vectors; the rest are pinned to the `instruction.rs` decoder's
 * exact-length checks.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Keypair } from '@solana/web3.js'
import { bytesToHex as hex, hexToBytes } from '@noble/hashes/utils'
import {
  ADD_AUTHORITY_ACCOUNTS,
  EXECUTE_ACCOUNTS,
  REMOVE_AUTHORITY_ACCOUNTS,
  CLOSE_SESSION_ACCOUNTS,
  CLOSE_WALLET_ACCOUNTS,
  CREATE_WALLET_ACCOUNTS,
  GOVERNED_ACCOUNTS,
  OWNER_CLOSE_SESSION_ACCOUNTS,
  REVOKE_SESSION_ACCOUNTS,
  SELF_REVOKE_SESSION_ACCOUNTS,
  SESSION_EXECUTE_ACCOUNTS,
  buildAddAuthorityIxData,
  buildAdvanceNonceIxData,
  buildBumpEpochIxData,
  buildCancelRecoveryIxData,
  buildCloseSessionIxData,
  buildCloseWalletIxData,
  buildCreateWalletIxData,
  buildExecuteRecoveryIxData,
  buildOwnerCloseSessionIxData,
  buildProposeRecoveryIxData,
  buildRemoveAuthorityIxData,
  buildRevokeSessionIxData,
  buildRotateRootIxData,
  buildSelfRevokeSessionIxData,
  buildSessionExecuteIxData,
  buildSetRecoveryThresholdIxData,
  buildSetThresholdIxData,
} from '../../src/wire-format/instructions'
import { buildExecuteIxData, encodeRemainingAccounts } from '../../src/wire-format/execute-ix'
import { MachineWalletDisc } from '../../src/wire-format/disc'
import type { InnerInstruction } from '../../src/wire-format/inner-hash'

interface LayoutVector {
  name: string
  fields: { name: string; hex: string }[]
  length: number
  bytes_hex: string
}

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const layoutKat: { vectors: LayoutVector[] } = JSON.parse(
  readFileSync(join(fixtureDir, 'layout_kat.json'), 'utf8'),
)

function vector(name: string) {
  const v = layoutKat.vectors.find((x) => x.name === name)
  if (!v) throw new Error(`layout_kat.json is missing ${name}`)
  const field = (n: string): Uint8Array => {
    const f = v.fields.find((x) => x.name === n)
    if (!f) throw new Error(`${name} has no field ${n}`)
    return hexToBytes(f.hex)
  }
  const u64 = (n: string): bigint => new DataView(field(n).buffer, field(n).byteOffset).getBigUint64(0, true)
  const u8 = (n: string): number => field(n)[0]
  return { v, field, u64, u8 }
}

function expectKat(name: string, data: Uint8Array, disc: number) {
  const { v, u8 } = vector(name)
  expect(u8('discriminator')).toBe(disc)
  expect(data).toHaveLength(v.length)
  expect(hex(data)).toBe(v.bytes_hex)
}

describe('builders against layout_kat.json', () => {
  it('ix_rotate_root_disc17', () => {
    const { u64, u8, field } = vector('ix_rotate_root_disc17')
    const data = buildRotateRootIxData({
      maxSlot: u64('max_slot_le'),
      sigScheme: u8('sig_scheme'),
      pubkey: field('pubkey'),
    })
    expectKat('ix_rotate_root_disc17', data, MachineWalletDisc.RotateRoot)
    expect(data).toHaveLength(43)
  })

  it('ix_propose_recovery_disc20', () => {
    const { u64, u8, field } = vector('ix_propose_recovery_disc20')
    const data = buildProposeRecoveryIxData({
      maxSlot: u64('max_slot_le'),
      sigScheme: u8('sig_scheme'),
      pubkey: field('pubkey'),
    })
    expectKat('ix_propose_recovery_disc20', data, MachineWalletDisc.ProposeRecovery)
    expect(data).toHaveLength(43)
  })

  it('ix_cancel_recovery_disc21', () => {
    const { u64 } = vector('ix_cancel_recovery_disc21')
    const data = buildCancelRecoveryIxData({ maxSlot: u64('max_slot_le') })
    expectKat('ix_cancel_recovery_disc21', data, MachineWalletDisc.CancelRecovery)
    expect(data).toHaveLength(9)
  })

  it('ix_execute_recovery_disc22', () => {
    const { u64 } = vector('ix_execute_recovery_disc22')
    const data = buildExecuteRecoveryIxData({ maxSlot: u64('max_slot_le') })
    expectKat('ix_execute_recovery_disc22', data, MachineWalletDisc.ExecuteRecovery)
    expect(data).toHaveLength(9)
  })

  it('ix_bump_epoch_disc23', () => {
    const { u64 } = vector('ix_bump_epoch_disc23')
    const data = buildBumpEpochIxData({ maxSlot: u64('max_slot_le') })
    expectKat('ix_bump_epoch_disc23', data, MachineWalletDisc.BumpEpoch)
    expect(data).toHaveLength(9)
  })

  it('ix_set_recovery_threshold_disc24 (threshold before max_slot)', () => {
    const { u64, u8 } = vector('ix_set_recovery_threshold_disc24')
    const data = buildSetRecoveryThresholdIxData({
      recoveryThreshold: u8('recovery_threshold'),
      maxSlot: u64('max_slot_le'),
    })
    expectKat('ix_set_recovery_threshold_disc24', data, MachineWalletDisc.SetRecoveryThreshold)
    expect(data).toHaveLength(10)
  })
})

describe('builders pinned to the decoder lengths', () => {
  const pk33 = new Uint8Array(33).fill(0x02)
  const key32 = new Uint8Array(32).fill(0x31)
  const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength)

  it('CreateWallet: [0] max_slot sig_scheme authority(33) = 43 B', () => {
    const d = buildCreateWalletIxData({ maxSlot: 7n, sigScheme: 2, authority: pk33 })
    expect(d).toHaveLength(43)
    expect(d[0]).toBe(0)
    expect(view(d).getBigUint64(1, true)).toBe(7n)
    expect(d[9]).toBe(2)
    expect(d.slice(10)).toEqual(pk33)
  })

  it('CloseWallet: [2] max_slot destination(32) = 41 B', () => {
    const d = buildCloseWalletIxData({ maxSlot: 7n, destination: key32 })
    expect(d).toHaveLength(41)
    expect(d[0]).toBe(2)
    expect(d.slice(9)).toEqual(key32)
  })

  it('AdvanceNonce: [3] max_slot = 9 B', () => {
    const d = buildAdvanceNonceIxData({ maxSlot: 7n })
    expect(d).toHaveLength(9)
    expect(d[0]).toBe(3)
  })

  it('RevokeSession: [6] max_slot session_authority(32) = 41 B', () => {
    const d = buildRevokeSessionIxData({ maxSlot: 7n, sessionAuthority: key32 })
    expect(d).toHaveLength(41)
    expect(d[0]).toBe(6)
    expect(d.slice(9)).toEqual(key32)
  })

  it('SelfRevokeSession and CloseSession carry the disc alone', () => {
    expect(buildSelfRevokeSessionIxData()).toEqual(Uint8Array.of(7))
    expect(buildCloseSessionIxData()).toEqual(Uint8Array.of(8))
  })

  it('AddAuthority: [9] sig_scheme pubkey(33) new_threshold max_slot = 44 B, new_threshold always 0', () => {
    const d = buildAddAuthorityIxData({ newSigScheme: 1, newPubkey: pk33, maxSlot: 7n })
    expect(d).toHaveLength(44)
    expect(d[0]).toBe(9)
    expect(d[1]).toBe(1)
    expect(d.slice(2, 35)).toEqual(pk33)
    expect(d[35]).toBe(0)
    expect(view(d).getBigUint64(36, true)).toBe(7n)
  })

  it('AddAuthority carries the newThreshold the owners signed (default 0)', () => {
    const d = buildAddAuthorityIxData({ newSigScheme: 0, newPubkey: pk33, maxSlot: 7n, newThreshold: 2 })
    expect(d[35]).toBe(2)
    expect(() => buildAddAuthorityIxData({ newSigScheme: 0, newPubkey: pk33, maxSlot: 7n, newThreshold: 256 })).toThrow(
      RangeError,
    )
  })

  it('RemoveAuthority: [10] sig_scheme pubkey(33) new_threshold max_slot = 44 B', () => {
    const d = buildRemoveAuthorityIxData({ sigScheme: 2, pubkey: pk33, newThreshold: 3, maxSlot: 7n })
    expect(d).toHaveLength(44)
    expect(d[0]).toBe(10)
    expect(d[35]).toBe(3)
    expect(view(d).getBigUint64(36, true)).toBe(7n)
  })

  it('SetThreshold: [11] new_threshold max_slot = 10 B', () => {
    const d = buildSetThresholdIxData({ newThreshold: 2, maxSlot: 7n })
    expect(d).toHaveLength(10)
    expect(d[0]).toBe(11)
    expect(d[1]).toBe(2)
    expect(view(d).getBigUint64(2, true)).toBe(7n)
  })

  it('OwnerCloseSession: [12] max_slot session_authority(32) = 41 B', () => {
    const d = buildOwnerCloseSessionIxData({ maxSlot: 7n, sessionAuthority: key32 })
    expect(d).toHaveLength(41)
    expect(d[0]).toBe(12)
  })

  it('rejects wrong-width keys and out-of-range bytes', () => {
    expect(() => buildCreateWalletIxData({ maxSlot: 1n, sigScheme: 0, authority: key32 })).toThrow(RangeError)
    expect(() => buildRevokeSessionIxData({ maxSlot: 1n, sessionAuthority: pk33 })).toThrow(RangeError)
    expect(() => buildRotateRootIxData({ maxSlot: 1n, sigScheme: 0, pubkey: key32 })).toThrow(RangeError)
    expect(() => buildSetThresholdIxData({ newThreshold: 256, maxSlot: 1n })).toThrow(RangeError)
    expect(() =>
      buildRemoveAuthorityIxData({ sigScheme: 0, pubkey: key32, newThreshold: 1, maxSlot: 1n }),
    ).toThrow(RangeError)
    expect(() => buildProposeRecoveryIxData({ sigScheme: 0, pubkey: key32, maxSlot: 1n })).toThrow(RangeError)
    expect(() => buildCloseWalletIxData({ maxSlot: 1n, destination: pk33 })).toThrow(RangeError)
  })
})

describe('buildSessionExecuteIxData', () => {
  const prog = Keypair.generate().publicKey
  const acc = Keypair.generate().publicKey
  const inner: InnerInstruction[] = [
    {
      programId: prog.toBase58(),
      accounts: [{ pubkey: acc.toBase58(), isWritable: true }],
      data: Uint8Array.of(0xde, 0xad),
    },
  ]

  it('is [5] || u32 count || inner, the same inner encoding Execute uses', () => {
    const remainingAccounts = encodeRemainingAccounts(inner)
    const d = buildSessionExecuteIxData({ innerInstructions: inner, remainingAccounts })
    const exec = buildExecuteIxData({ maxSlot: 9n, innerInstructions: inner, remainingAccounts })
    expect(d[0]).toBe(MachineWalletDisc.SessionExecute)
    expect(new DataView(d.buffer, d.byteOffset).getUint32(1, true)).toBe(1)
    // Execute is [1] || max_slot(8) || <same tail>; SessionExecute has no max_slot.
    expect(d.slice(1)).toEqual(exec.slice(9))
  })
})

describe('account tables', () => {
  it('match the program handlers', () => {
    expect(GOVERNED_ACCOUNTS).toEqual(['instructions_sysvar', 'wallet (w)', 'fee_payer (s)'])
    // add_authority.rs / remove_authority.rs read the System Program at accounts[3].
    expect(ADD_AUTHORITY_ACCOUNTS).toEqual([...GOVERNED_ACCOUNTS, 'system_program'])
    expect(REMOVE_AUTHORITY_ACCOUNTS).toEqual([...GOVERNED_ACCOUNTS, 'system_program'])
    expect(EXECUTE_ACCOUNTS).toEqual(['instructions_sysvar', 'wallet (w)', 'fee_payer (s)', 'vault (w)', '…remaining'])
    expect(REVOKE_SESSION_ACCOUNTS).toEqual([...GOVERNED_ACCOUNTS, 'session (w)'])
    expect(OWNER_CLOSE_SESSION_ACCOUNTS).toEqual([...GOVERNED_ACCOUNTS, 'session (w)', 'destination (w) = rent_payer'])
    expect(CLOSE_SESSION_ACCOUNTS).toEqual(['session (w)', 'authority (s)', 'destination (w) = rent_payer'])
    expect(SELF_REVOKE_SESSION_ACCOUNTS).toEqual(['session (w)', 'authority (s)'])
    expect(CLOSE_WALLET_ACCOUNTS).toEqual([...GOVERNED_ACCOUNTS, 'vault (w)', 'destination (w)', 'system_program'])
    expect(CREATE_WALLET_ACCOUNTS).toEqual(['instructions_sysvar', 'payer (s)', 'wallet (w)', 'system_program'])
    expect(SESSION_EXECUTE_ACCOUNTS).toEqual(['session (w)', 'wallet', 'authority (s)', 'vault (w)', '…remaining'])
  })
})
