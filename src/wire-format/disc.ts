/**
 * MachineWallet instruction discriminators.
 *
 * The numbers ARE the wire format — they sit at `data[0]` of every
 * MachineWallet instruction and are the dispatcher key the on-chain program
 * matches against (`processor/mod.rs::process_instruction`). Don't paraphrase
 * them at call sites; import this constant.
 *
 * Keep in sync with `machine-wallet/program/src/instruction.rs`. Adding a new
 * variant is an SDK minor bump; renaming an existing one is a major.
 */
export const MachineWalletDisc = {
  /** CreateWallet — initialises the MachineWallet PDA. */
  CreateWallet: 0,
  /** Execute — legacy single-CPI path; only the vault PDA gets `invoke_signed`. */
  Execute: 1,
  /** AddAuthority — appends a new (sig_scheme, pubkey) slot. */
  AddAuthority: 9,
  /** ProvideWebAuthnEvidence — sidecar carrying clientDataJSON for WebAuthn signers. */
  ProvideWebAuthnEvidence: 15,
  /**
   * ExecuteWithEphemeralSigners — Squads-v4-style: dApp passes per-call bump
   * bytes, the handler `invoke_signed`s each derived PDA so inner CPIs can
   * demand external-keypair signer privilege (Switchboard `Randomness.create`,
   * `SystemProgram.createAccount`, …). See
   * `processor/execute.rs::process_with_ephemeral_signers`.
   */
  ExecuteWithEphemeralSigners: 16,
} as const;

export type MachineWalletDiscValue =
  (typeof MachineWalletDisc)[keyof typeof MachineWalletDisc];
