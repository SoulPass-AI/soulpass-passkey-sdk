import { describe, it, expect } from 'vitest'
import { MachineWalletDisc } from '../../src/wire-format/disc'

describe('MachineWalletDisc', () => {
  // Compile-time test: any drift here also moves the WebAuthn challenge bytes
  // and silently breaks every live signature. Pin the numbers as data so a
  // typo in `disc.ts` fails CI instead of production.
  it('matches the on-chain instruction.rs enum tags', () => {
    expect(MachineWalletDisc.CreateWallet).toBe(0)
    expect(MachineWalletDisc.Execute).toBe(1)
    expect(MachineWalletDisc.AddAuthority).toBe(9)
    expect(MachineWalletDisc.ProvideWebAuthnEvidence).toBe(15)
    expect(MachineWalletDisc.ExecuteWithEphemeralSigners).toBe(16)
  })
})
