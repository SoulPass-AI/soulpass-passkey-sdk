/**
 * MachineWallet instruction discriminators.
 *
 * The numbers ARE the wire format — they sit at `data[0]` of every
 * MachineWallet instruction and are the dispatcher key the on-chain program
 * matches against (`instruction.rs::MachineWalletInstruction::unpack`). Don't
 * paraphrase them at call sites; import this constant.
 *
 * Keep in sync with `machine-wallet/program/src/instruction.rs`.
 */
export const MachineWalletDisc = {
  /** CreateWallet — initialises the MachineWallet PDA. */
  CreateWallet: 0,
  /** Execute — CPI batch signed by the vault PDA. */
  Execute: 1,
  /** CloseWallet — closes the wallet and sweeps the vault to `destination`. */
  CloseWallet: 2,
  /** AdvanceNonce — burns the current nonce (invalidates outstanding signatures). */
  AdvanceNonce: 3,
  /** CreateSession — budgeted session bound to a mandate and a creator authority. */
  CreateSession: 4,
  /** SessionExecute — CPI batch signed by a live session key. */
  SessionExecute: 5,
  /** RevokeSession — authority-governed session revocation. */
  RevokeSession: 6,
  /** SelfRevokeSession — the session key revokes itself. */
  SelfRevokeSession: 7,
  /** CloseSession — closes a dead session, refunding its rent payer. */
  CloseSession: 8,
  /** AddAuthority — appends a new (sig_scheme, pubkey) slot. */
  AddAuthority: 9,
  /** RemoveAuthority — removes a slot (self-removal or root-and-threshold). */
  RemoveAuthority: 10,
  /** SetThreshold — changes the spending threshold. */
  SetThreshold: 11,
  /** OwnerCloseSession — authority-governed close of a session account. */
  OwnerCloseSession: 12,
  /** ProvideWebAuthnEvidence — sidecar carrying clientDataJSON for WebAuthn signers. */
  ProvideWebAuthnEvidence: 15,
  /**
   * ExecuteWithEphemeralSigners — like Execute, plus 1..=4 per-call bump
   * bytes; the handler `invoke_signed`s each derived PDA so inner CPIs can
   * demand external-keypair signer privilege (`SystemProgram.createAccount`, …).
   */
  ExecuteWithEphemeralSigners: 16,
  /** RotateRoot — move the root role to an already-registered authority. */
  RotateRoot: 17,
  /** ProposeRecovery — recovery-threshold proposal of a new root, after a delay. */
  ProposeRecovery: 20,
  /** CancelRecovery — the root vetoes a pending recovery. */
  CancelRecovery: 21,
  /** ExecuteRecovery — the pending root completes recovery once the eta passes. */
  ExecuteRecovery: 22,
  /** BumpEpoch — increments authority_epoch, killing every session. */
  BumpEpoch: 23,
  /** SetRecoveryThreshold — 0 follows the spending threshold. */
  SetRecoveryThreshold: 24,
} as const;

export type MachineWalletDiscValue =
  (typeof MachineWalletDisc)[keyof typeof MachineWalletDisc];

/**
 * Discriminators the program's dispatcher rejects (`InvalidInstructionData`).
 * 13 never shipped, 14 was the removed full-authData sidecar (superseded by
 * 15), 18/19 were the removed CreateSessionV2 / AdoptRoot
 * (`retired_and_unknown_discs_rejected`). Nothing in the SDK may emit them.
 */
export const REJECTED_DISCS: readonly number[] = Object.freeze([13, 14, 18, 19]);
