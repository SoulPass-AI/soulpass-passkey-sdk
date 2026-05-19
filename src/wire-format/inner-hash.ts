/**
 * `inner_hash` byte layout and computation — mirrors
 * `machine-wallet/program/src/processor/execute.rs::validate_and_hash_inner_instructions`.
 *
 * Why this matters: `inner_hash` feeds straight into the WebAuthn challenge
 * (`operation_hash`). A one-byte disagreement between what the popup hashes
 * and what the chain re-hashes turns into `MessageMismatch` at submit time —
 * with no actionable diagnostic. Routing this through the SDK eliminates that
 * class of bug across popup + matrix-contract.
 */

import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { u16LE, concatBytes } from './_bytes';

/**
 * Inner-instruction account flag bits. **MUST** match
 * `program/src/instruction.rs::AccountEntry::FLAG_*` —
 * mismatched bits surface as either `MessageMismatch` (challenge fail) or
 * `EphemeralSignerKeyMismatch` (CPI fail), both painful to debug.
 */
export const FLAG_WRITABLE = 0x01;
/**
 * Marks an inner-ix account as one of the per-Execute ephemeral signer PDAs.
 * `process_with_ephemeral_signers` `invoke_signed`s the derived PDA, granting
 * `is_signer = true` to the CPI. Inert on the legacy disc=1 Execute path —
 * still hashed into `inner_hash`, but no signer privilege is conferred.
 */
export const FLAG_EPHEMERAL_SIGNER = 0x02;

/**
 * Inner instruction wire-format type. Stable across popup + contract +
 * matrix-backend — pubkeys are base58 strings to keep this type
 * web3.js-agnostic at the boundary (callers convert at the edges).
 */
export interface InnerInstruction {
  /** base58 program ID. */
  programId: string;
  accounts: ReadonlyArray<{
    /** base58 pubkey. */
    pubkey: string;
    /** Maps to `FLAG_WRITABLE` in the wire encoding. */
    isWritable: boolean;
    /**
     * Maps to `FLAG_EPHEMERAL_SIGNER`. Set this when the caller plans to
     * supply a matching bump in `ephemeralSignerBumps` so the on-chain
     * `invoke_signed` covers the account. Leaving it off when a bump is
     * supplied (or vice versa) is the canonical cause of "signer privilege
     * escalated" on Switchboard / SystemProgram CPIs.
     */
    isEphemeralSigner?: boolean;
  }>;
  data: Uint8Array;
}

/**
 * Mirrors `execute.rs::hash_inner_instructions` byte-for-byte:
 *
 *   ix_hash    = keccak256(
 *     program_id(32) ||
 *     accounts_len_u16_le ||
 *     (pubkey(32) || flags(1))... ||
 *     data_len_u16_le ||
 *     data
 *   )
 *   inner_hash = keccak256(ix_hash_0 || ix_hash_1 || ...)
 *
 * Note the ordering: `accounts_len` comes BEFORE the account entries, and
 * `data_len` comes BEFORE the data — the chain reads them in that order too.
 * Don't try to "tidy" this without coordinating with the on-chain layout.
 */
export function computeInnerHash(
  innerInstructions: ReadonlyArray<InnerInstruction>,
): Uint8Array {
  const ixHashes: Uint8Array[] = [];

  for (const ix of innerInstructions) {
    const programIdBytes = new PublicKey(ix.programId).toBytes();
    const parts: Uint8Array[] = [programIdBytes, u16LE(ix.accounts.length)];
    for (const acc of ix.accounts) {
      parts.push(new PublicKey(acc.pubkey).toBytes());
      let flags = 0;
      if (acc.isWritable) flags |= FLAG_WRITABLE;
      if (acc.isEphemeralSigner) flags |= FLAG_EPHEMERAL_SIGNER;
      parts.push(Uint8Array.of(flags));
    }
    parts.push(u16LE(ix.data.length));
    parts.push(ix.data);

    ixHashes.push(keccak_256(concatBytes(parts)));
  }

  return keccak_256(concatBytes(ixHashes));
}
