/**
 * machine-wallet on-chain error codes — `ProgramError::Custom(code)` values
 * from `machine-wallet/program/src/error.rs`, names copied verbatim and
 * listed in ascending code order.
 *
 * Codes 37–39 were never assigned. Retired codes ({@link RETIRED_ERROR_CODES})
 * belonged to variants the program removed and are never reused, so a
 * retired code on the wire means the transaction ran against an old build.
 */

export const MachineWalletError = {
  InvalidPrecompileInstruction: 0,
  PublicKeyMismatch: 1,
  MessageMismatch: 2,
  InvalidNonce: 3,
  InvalidSignatureOffsets: 4,
  WalletAlreadyInitialized: 5,
  WalletNotInitialized: 6,
  InvalidVaultPDA: 7,
  InvalidWalletPDA: 8,
  InstructionMissing: 9,
  SignatureExpired: 10,
  CpiReentryDenied: 11,
  CpiToSelfDenied: 12,
  TooManyInnerInstructions: 14,
  MissingProgramAccount: 15,
  InvalidDestination: 16,
  InvalidVaultOwner: 17,
  AccountNotWritable: 18,
  SessionExpired: 19,
  SessionRevoked: 20,
  SessionAuthorityMismatch: 21,
  SessionWalletMismatch: 22,
  ProgramNotAllowed: 23,
  SessionAlreadyExists: 24,
  InvalidSessionPDA: 25,
  InvalidSessionData: 27,
  TooManyAllowedPrograms: 28,
  SessionStillActive: 29,
  InsufficientSignatures: 30,
  AuthorityLimitExceeded: 31,
  DuplicateAuthority: 32,
  CannotRemoveLastAuthority: 33,
  InvalidThreshold: 34,
  AuthorityNotFound: 35,
  InvalidAuthorityPubkey: 36,
  InvalidWebAuthnAuthData: 40,
  InvalidWebAuthnClientDataJson: 41,
  WebAuthnChallengeMismatch: 42,
  WebAuthnInvalidType: 43,
  WebAuthnUserNotPresent: 44,
  WebAuthnDuplicateField: 45,
  WebAuthnUserNotVerified: 46,
  WebAuthnRpIdMismatch: 47,
  WebAuthnOriginMismatch: 49,
  TooManyEphemeralSigners: 51,
  InvalidEphemeralSignerBump: 52,
  EphemeralSignerKeyMismatch: 53,
  WebAuthnCrossOrigin: 54,
  SignatureExpiryTooFar: 55,
  SessionCashCapExceeded: 56,
  SessionPeriodCapExceeded: 57,
  SessionLifetimeCashCapExceeded: 58,
  SessionSleeveExceeded: 59,
  SessionSleeveFull: 60,
  RootRequired: 62,
  RootNotAnAuthority: 63,
  TooManyCashMints: 64,
  DuplicateCashMint: 65,
  InvalidCashCap: 67,
  SessionCreatorDidNotSign: 68,
  SessionAuthorityChangeDenied: 69,
  SessionEpochStale: 70,
  NoPendingRecovery: 71,
  RecoveryDelayNotElapsed: 72,
  InvalidRecoveryTarget: 73,
  SessionVaultAuthorityDenied: 74,
  SessionSolBudgetMissing: 75,
  /**
   * A session-key transaction names a different creation of this session PDA.
   * The grant changed: never refresh the generation and re-sign the old intent.
   */
  SessionGenerationMismatch: 76,
  /**
   * ProposeRecovery while a proposal is pending. Show the pending recovery;
   * never retry — only the root's CancelRecovery (or ExecuteRecovery) clears it.
   */
  RecoveryAlreadyPending: 77,
} as const;

export type MachineWalletErrorName = keyof typeof MachineWalletError;
export type MachineWalletErrorCode = (typeof MachineWalletError)[MachineWalletErrorName];

/** Codes whose variants the program removed; `error.rs` forbids reusing them. */
export const RETIRED_ERROR_CODES: readonly number[] = Object.freeze([13, 26, 48, 50, 61, 66]);

const NAME_BY_CODE: ReadonlyMap<number, MachineWalletErrorName> = new Map(
  (Object.entries(MachineWalletError) as [MachineWalletErrorName, number][]).map(
    ([name, code]) => [code, name],
  ),
);

/**
 * Variant name for a machine-wallet custom error code; `retired(<code>)` for
 * a retired code and `unknown(<code>)` for anything else.
 */
export function describeMachineWalletError(code: number): string {
  const name = NAME_BY_CODE.get(code);
  if (name !== undefined) return name;
  if (RETIRED_ERROR_CODES.includes(code)) return `retired(${code})`;
  return `unknown(${code})`;
}
