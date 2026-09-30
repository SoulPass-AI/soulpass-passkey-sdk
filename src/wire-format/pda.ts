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
import { SESSION_SEED, WALLET_SEED } from './constants';

export interface ProgramAddress {
  address: PublicKey;
  bump: number;
}

const encoder = new TextEncoder();
const WALLET_SEED_BYTES = encoder.encode(WALLET_SEED);
const SESSION_SEED_BYTES = encoder.encode(SESSION_SEED);
const DEFAULT_PROGRAM_ID = new PublicKey(MACHINE_WALLET_PROGRAM_ADDRESS);

/**
 * Wallet PDA for the authority that created it. `authority33` is the
 * 33-byte pubkey field of the creating `AuthoritySlot` (without the
 * sig_scheme byte), exactly as `CreateWallet` carries it.
 */
export function deriveWalletPda(
  authority33: Uint8Array,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): ProgramAddress {
  if (authority33.length !== 33) {
    throw new RangeError(`deriveWalletPda: authority must be 33 bytes, got ${authority33.length}`);
  }
  const [address, bump] = PublicKey.findProgramAddressSync(
    [WALLET_SEED_BYTES, keccak_256(authority33)],
    programId,
  );
  return { address, bump };
}

/** Session PDA for a wallet PDA and a 32-byte session authority (ed25519 pubkey). */
export function deriveSessionPda(
  wallet: PublicKey,
  sessionAuthority: Uint8Array,
  programId: PublicKey = DEFAULT_PROGRAM_ID,
): ProgramAddress {
  if (sessionAuthority.length !== 32) {
    throw new RangeError(
      `deriveSessionPda: session authority must be 32 bytes, got ${sessionAuthority.length}`,
    );
  }
  const [address, bump] = PublicKey.findProgramAddressSync(
    [SESSION_SEED_BYTES, wallet.toBytes(), sessionAuthority],
    programId,
  );
  return { address, bump };
}
