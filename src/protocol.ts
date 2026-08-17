/**
 * MachineWallet protocol constants — mirror machine-wallet/program/src/lib.rs
 * + execute.rs. Dep-free strings/numbers so the SDK core stays free of
 * @solana/web3.js; the solana adapter wraps what needs PublicKey.
 */

export const MACHINE_WALLET_PROGRAM_ADDRESS = 'SouLi11jcPZGRS1yBfJDxcrDAWHNvJeSwph8pxZWzYw';

/** PDA seed for the system-owned vault (mirrors on-chain `machine_vault`). */
export const MACHINE_WALLET_VAULT_SEED = 'machine_vault';

/** Signature validity window in slots (mirrors on-chain `max_slot` policy). */
export const MAX_SLOT_WINDOW = 150n;

/** Nominal Solana slot time, used to reason about wall-clock budgets. */
export const SOLANA_SLOT_MS = 400;

/**
 * Signature window for adding an authority — ten times the ordinary one.
 *
 * AddAuthority is the only operation whose signing spans two machines and two
 * human moments: the joining device proving it holds its key, and the user
 * reaching for their passkey. `maxSlot` is fixed before either happens, so a
 * 150-slot (~60s) window expires on ceremonies that everyone performed
 * correctly.
 *
 * Widening is safe here in a way it would not be for a transfer. The only
 * thing signed while the window is open is the possession proof, which
 * authorizes nothing by itself — it merely shows a key exists. The approval,
 * the half that actually moves authority, is produced at the very end and
 * submitted immediately, so it is never left sitting signed.
 *
 * Matches `AuthorityCeremony.challengeWindowSlots` in the Swift SDK, which
 * carries the same reasoning for the terminal-to-terminal ceremony.
 */
export const ADD_AUTHORITY_CEREMONY_SLOT_WINDOW = 1_500n;
