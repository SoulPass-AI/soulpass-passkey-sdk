/**
 * MachineWallet and SessionState PDA derivation. Seeds mirror
 * `processor::create_wallet` and `processor::create_session`:
 *
 *   wallet  = [WALLET_SEED,  keccak256(authority33)]   (`MachineWallet::compute_id`)
 *   session = [SESSION_SEED, wallet, session_authority32]
 *
 * Both use `find_program_address`, i.e. the canonical bump.
 */

import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { MACHINE_WALLET_PROGRAM_ADDRESS } from '../protocol';
import { requireLength } from './_bytes';
import { AUTHORITY_PUBKEY_SIZE, SESSION_SEED, WALLET_SEED } from './constants';

export interface ProgramAddress {
  address: PublicKey;
  bump: number;
}

const encoder = new TextEncoder();
const WALLET_SEED_BYTES = encoder.encode(WALLET_SEED);
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
