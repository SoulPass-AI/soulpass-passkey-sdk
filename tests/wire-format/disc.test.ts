import { describe, it, expect } from 'vitest'
import { MachineWalletDisc, REJECTED_DISCS } from '../../src/wire-format/disc'

describe('MachineWalletDisc', () => {
  // Any drift here also moves the WebAuthn challenge bytes and silently breaks
  // every live signature. Pin the whole table as data so a typo in `disc.ts`
  // fails CI instead of production.
  it('is exactly the on-chain instruction.rs dispatcher table', () => {
    expect(MachineWalletDisc).toEqual({
      CreateWallet: 0,
      Execute: 1,
      CloseWallet: 2,
      AdvanceNonce: 3,
      CreateSession: 4,
      SessionExecute: 5,
      RevokeSession: 6,
      SelfRevokeSession: 7,
      CloseSession: 8,
      AddAuthority: 9,
      RemoveAuthority: 10,
      SetThreshold: 11,
      OwnerCloseSession: 12,
      ProvideWebAuthnEvidence: 15,
      ExecuteWithEphemeralSigners: 16,
      RotateRoot: 17,
      ProposeRecovery: 20,
      CancelRecovery: 21,
      ExecuteRecovery: 22,
      BumpEpoch: 23,
      SetRecoveryThreshold: 24,
    })
  })

  it('lists 13, 14, 18 and 19 as rejected, and none of them is a live disc', () => {
    expect(REJECTED_DISCS).toEqual([13, 14, 18, 19])
    const live = new Set<number>(Object.values(MachineWalletDisc))
    for (const d of REJECTED_DISCS) expect(live.has(d)).toBe(false)
  })
})
