import { describe, it, expect } from 'vitest'
import {
  MachineWalletError,
  RETIRED_ERROR_CODES,
  describeMachineWalletError,
} from '../../src/wire-format/errors'

// Mirrors machine-wallet program/src/error.rs.
describe('MachineWalletError', () => {
  const codes = Object.values(MachineWalletError) as number[]

  it('pins anchor codes', () => {
    expect(MachineWalletError.InvalidPrecompileInstruction).toBe(0)
    expect(MachineWalletError.InvalidAuthorityPubkey).toBe(36)
    expect(MachineWalletError.InvalidWebAuthnAuthData).toBe(40)
    expect(MachineWalletError.RootRequired).toBe(62)
    expect(MachineWalletError.SessionEpochStale).toBe(70)
    expect(MachineWalletError.SessionSolBudgetMissing).toBe(75)
    expect(MachineWalletError.SessionGenerationMismatch).toBe(76)
    expect(MachineWalletError.RecoveryAlreadyPending).toBe(77)
  })

  it('retired codes are listed and absent from the table', () => {
    expect(RETIRED_ERROR_CODES).toEqual([13, 26, 48, 50, 61, 66])
    for (const c of RETIRED_ERROR_CODES) expect(codes).not.toContain(c)
  })

  it('table is ascending with unique codes', () => {
    expect(codes).toEqual([...codes].sort((a, b) => a - b))
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('every code 0..77 is either live, retired, or in the 37..39 gap — never both', () => {
    // error.rs jumps from 36 (InvalidAuthorityPubkey) to 40 (InvalidWebAuthnAuthData);
    // 37..39 were never assigned.
    const unassigned = [37, 38, 39]
    for (let c = 0; c <= 77; c++) {
      const live = codes.includes(c)
      const retired = RETIRED_ERROR_CODES.includes(c)
      const gap = unassigned.includes(c)
      expect([live, retired, gap].filter(Boolean)).toHaveLength(1)
    }
    expect(Math.max(...codes)).toBe(77)
  })

  it('describes codes', () => {
    expect(describeMachineWalletError(62)).toBe('RootRequired')
    expect(describeMachineWalletError(0)).toBe('InvalidPrecompileInstruction')
    expect(describeMachineWalletError(66)).toBe('retired(66)')
    expect(describeMachineWalletError(13)).toBe('retired(13)')
    expect(describeMachineWalletError(38)).toBe('unknown(38)')
    expect(describeMachineWalletError(76)).toBe('SessionGenerationMismatch')
    expect(describeMachineWalletError(77)).toBe('RecoveryAlreadyPending')
    expect(describeMachineWalletError(78)).toBe('unknown(78)')
    expect(describeMachineWalletError(-1)).toBe('unknown(-1)')
  })
})
