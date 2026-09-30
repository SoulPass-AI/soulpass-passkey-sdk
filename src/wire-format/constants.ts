/**
 * machine-wallet protocol constants. Each value mirrors one line in the
 * program (`machine-wallet/program/src`); the source is named beside it.
 * The program is the truth — change there first, then here.
 *
 * Slot counts are `bigint` because the program holds them as `u64`.
 * The ephemeral-signer seed lives in `../ephemeral-signers.ts`.
 */

/** `state::WALLET_ACCOUNT_TAG` (`b'W'`): byte 0 of every MachineWallet account. */
export const WALLET_ACCOUNT_TAG = 0x57;
/** `state::SESSION_ACCOUNT_TAG` (`b'S'`): byte 0 of every SessionState account. */
export const SESSION_ACCOUNT_TAG = 0x53;
/** `state::RETIRED_ACCOUNT_TAGS`: byte-0 values earlier builds wrote; never reused. */
export const RETIRED_ACCOUNT_TAGS: readonly number[] = Object.freeze([0, 1, 2]);

/** `state::MAX_AUTHORITIES`. */
export const MAX_AUTHORITIES = 16;
/** `state::MAX_ALLOWED_PROGRAMS`. */
export const MAX_ALLOWED_PROGRAMS = 8;
/** `instruction::MAX_CASH_MINTS` (SOL budget included). */
export const MAX_CASH_MINTS = 5;
/** `instruction::MAX_SLEEVE_MINTS`. */
export const MAX_SLEEVE_MINTS = 16;
/** `state::MAX_EPHEMERAL_SIGNERS`. */
export const MAX_EPHEMERAL_SIGNERS = 4;
/** `instruction::MAX_INNER_INSTRUCTIONS`. */
export const MAX_INNER_INSTRUCTIONS = 64;
/** `webauthn::MAX_CLIENT_DATA_JSON_SIZE` (bytes). */
export const MAX_CLIENT_DATA_JSON_SIZE = 1024;

/** `processor::MAX_SIGNATURE_TTL_SLOTS`: furthest `max_slot` may sit past the current slot. */
export const MAX_SIGNATURE_TTL_SLOTS = 2_000n;
/** `processor::create_session::MAX_SESSION_LIFETIME_SLOTS`. */
export const MAX_SESSION_LIFETIME_SLOTS = 6_480_000n;
/** `processor::recovery::RECOVERY_DELAY_SLOTS`: ProposeRecovery → ExecuteRecovery delay. */
export const RECOVERY_DELAY_SLOTS = 1_512_000n;

/** `state::SESSION_FLAG_NET_EXPOSURE`. */
export const SESSION_FLAG_NET_EXPOSURE = 0x01;
/** `state::SESSION_FLAGS_KNOWN`: every flag bit the program accepts. */
export const SESSION_FLAGS_KNOWN = 0x01;

/**
 * `state::NATIVE_SOL_MINT`: the all-zero mint under which a session carries
 * its SOL budget. Callers must not mutate it.
 */
export const NATIVE_SOL_MINT: Uint8Array = new Uint8Array(32);

/** `state::AUTHORITY_SLOT_SIZE`: `sig_scheme(1) || pubkey(33)`. */
export const AUTHORITY_SLOT_SIZE = 34;
/** `MachineWallet::HEADER_SIZE`. */
export const WALLET_HEADER_SIZE = 170;
/** `SessionState::HEADER_SIZE`. */
export const SESSION_HEADER_SIZE = 101;
/** `CashMintState::SIZE`. */
export const CASH_MINT_STATE_SIZE = 88;
/** `SleeveEntry::SIZE`. */
export const SLEEVE_ENTRY_SIZE = 40;

/** `MachineWallet::SEED_PREFIX`. */
export const WALLET_SEED = 'machine_wallet';
/** `MachineWallet::VAULT_SEED_PREFIX`. */
export const VAULT_SEED = 'machine_vault';
/** `state::SESSION_SEED_PREFIX`. */
export const SESSION_SEED = 'machine_session';
