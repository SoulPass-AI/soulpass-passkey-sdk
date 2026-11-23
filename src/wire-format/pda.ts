/**
 * MachineWallet, vault and SessionState PDA derivation. Seeds mirror
 * `processor::create_wallet`, `processor::derive_vault` and
 * `processor::create_session`:
 *
 *   wallet  = [WALLET_SEED,  keccak256(authority33)]   (`MachineWallet::compute_id`)
 *   vault   = [VAULT_SEED,   wallet, vault_index_u16_le]
 *   session = [SESSION_SEED, wallet, session_authority32]
 *
 * All use `find_program_address`, i.e. the canonical bump.
 */

import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { MACHINE_WALLET_PROGRAM_ADDRESS } from '../protocol';
import { requireLength, u16LE } from './_bytes';
import { AUTHORITY_PUBKEY_SIZE, SESSION_SEED, VAULT_SEED, WALLET_SEED } from './constants';

export interface ProgramAddress {
  address: PublicKey;
  bump: number;
}

const encoder = new TextEncoder();
const WALLET_SEED_BYTES = encoder.encode(WALLET_SEED);
const VAULT_SEED_BYTES = encoder.encode(VAULT_SEED);
const SESSION_SEED_BYTES = encoder.encode(SESSION_SEED);
/** The deployed program id, as a `PublicKey`. */
export const MACHINE_WALLET_PROGRAM_ID = new PublicKey(MACHINE_WALLET_PROGRAM_ADDRESS);

/**
 * Wallet PDA for the authority that created it. `authority33` is the
 * 33-byte pubkey field of the creating `AuthoritySlot` (without the
 * sig_scheme byte), exactly as `CreateWallet` carries it.
 */
export function deriveWalletPda(
  authority33: Uint8Array,
  programId: PublicKey = MACHINE_WALLET_PROGRAM_ID,
): ProgramAddress {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [WALLET_SEED_BYTES, keccak_256(requireLength(authority33, AUTHORITY_PUBKEY_SIZE, 'deriveWalletPda: authority'))],
    programId,
  );
  return { address, bump };
}

/**
 * Vault `vaultIndex` (u16) of a wallet PDA: the SystemProgram-owned account
 * that holds that vault's funds. The wallet stores no vault — every index
 * exists implicitly; 0 ({@link import('./constants').MAIN_VAULT_INDEX}) is the
 * owner's main account.
 */
export function deriveVaultPda(
  wallet: PublicKey,
  vaultIndex: number,
  programId: PublicKey = MACHINE_WALLET_PROGRAM_ID,
): ProgramAddress {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [VAULT_SEED_BYTES, wallet.toBytes(), u16LE(vaultIndex, 'deriveVaultPda: vaultIndex')],
    programId,
  );
  return { address, bump };
}

/** Session PDA for a wallet PDA and a 32-byte session authority (ed25519 pubkey). */
export function deriveSessionPda(
  wallet: PublicKey,
  sessionAuthority: Uint8Array,
  programId: PublicKey = MACHINE_WALLET_PROGRAM_ID,
): ProgramAddress {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [SESSION_SEED_BYTES, wallet.toBytes(), requireLength(sessionAuthority, 32, 'deriveSessionPda: session authority')],
    programId,
  );
  return { address, bump };
}
