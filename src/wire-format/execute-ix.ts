/**
 * Pure-byte builders for MachineWallet instruction `data` blobs. These return
 * `Uint8Array` only — `keys` and `programId` are the caller's responsibility,
 * because Node-backend usage (matrix-contract) and browser usage (popup) wrap
 * the data in their own `TransactionInstruction` types.
 *
 * Mirrors `machine-wallet/program/src/instruction.rs` decoders byte-for-byte.
 */

import { MachineWalletDisc } from './disc';
import type { InnerInstruction } from './inner-hash';
import { FLAG_WRITABLE, FLAG_EPHEMERAL_SIGNER } from './inner-hash';
import { u16LE, u32LE, u64LE, concatBytes } from './_bytes';
import { PublicKey } from '@solana/web3.js';

/**
 * Build the data blob for disc=15 `ProvideWebAuthnEvidence`:
 *
 *   [tag(1)=15] [cdj_len(2 u16 LE)] [clientDataJSON(N)]
 *
 * The sidecar carries the JSON the authenticator signed; on-chain
 * `threshold.rs` re-hashes it and matches against the secp256r1 precompile
 * message tail. Empty `clientDataJSON` is rejected by the program.
 */
export function buildEvidenceIxData(clientDataJSON: Uint8Array): Uint8Array {
  if (clientDataJSON.length === 0) {
    throw new RangeError('clientDataJSON must be non-empty');
  }
  return concatBytes([
    Uint8Array.of(MachineWalletDisc.ProvideWebAuthnEvidence),
    u16LE(clientDataJSON.length),
    clientDataJSON,
  ]);
}

/**
 * Build the data blob for the compact disc=15 evidence variant:
 *
 *   [tag(1)=15] [challenge(43)] [cd_hash(32)]   // total = 76 bytes
 *
 * Saves ~104 bytes vs. the JSON-carrying variant by relying on the on-chain
 * scanner to recompute `clientDataJSON` from the challenge + cd_hash. Useful
 * when the outer tx is bumping against the 1232-byte legacy ceiling — typical
 * caller is the popup's swap path, not RIP.
 */
export function buildEvidenceCompactIxData(
  challenge: Uint8Array,
  cdHash: Uint8Array,
): Uint8Array {
  if (challenge.length !== 43) {
    throw new RangeError(
      `challenge must be 43 bytes (base64url_nopad of 32-byte operation_hash), ` +
        `got ${challenge.length}`,
    );
  }
  if (cdHash.length !== 32) {
    throw new RangeError(`cdHash must be 32 bytes (sha256), got ${cdHash.length}`);
  }
  return concatBytes([
    Uint8Array.of(MachineWalletDisc.ProvideWebAuthnEvidence),
    challenge,
    cdHash,
  ]);
}

/**
 * Build the data blob for `Execute` (disc=1) or `ExecuteWithEphemeralSigners`
 * (disc=16). Picks the format from whether `ephemeralSignerBumps` is provided
 * and non-empty.
 *
 * Layouts (mirrors `instruction.rs::Execute::deserialize` and `::ExecuteWithEphemeralSigners::deserialize`):
 *
 *   disc=1:
 *     [tag(1)=1] [max_slot u64 LE] [inner_count u32 LE] [encoded inner ixs...]
 *
 *   disc=16:
 *     [tag(1)=16] [max_slot u64 LE]
 *     [num_ephemeral u8] [bumps(num_ephemeral bytes)]
 *     [inner_count u32 LE] [encoded inner ixs...]
 *
 * Inner instruction encoding (mirrors `InnerInstruction` Borsh layout):
 *
 *   [program_id(32)]
 *   [accounts_len u16 LE]
 *   [data_len u16 LE]
 *   [account_entries: (index u8, flags u8) * accounts_len]
 *   [data (data_len bytes)]
 *
 * The `index` field refers to position in a de-duplicated `remainingAccounts`
 * list — see {@link encodeRemainingAccounts}. Callers building the full
 * `TransactionInstruction` MUST pass the same list to the on-chain ix's `keys`
 * tail in the same order, or the chain's account scanner will read the wrong
 * pubkey for `index`.
 */
export function buildExecuteIxData(args: {
  maxSlot: bigint;
  innerInstructions: ReadonlyArray<InnerInstruction>;
  /**
   * De-duplicated remaining-accounts list produced by
   * {@link encodeRemainingAccounts}. Required so `index` bytes line up with
   * what the caller will pass as the ix's tail keys.
   */
  remainingAccounts: ReadonlyArray<RemainingAccount>;
  /**
   * Per-call ephemeral signer bumps. Non-empty switches to disc=16; the same
   * bumps must have fed `computeExecuteMessageV1` so the operation_hash the
   * authenticator signed matches what the chain recomputes.
   */
  ephemeralSignerBumps?: Uint8Array;
}): Uint8Array {
  const { maxSlot, innerInstructions, remainingAccounts, ephemeralSignerBumps } = args;

  const indexByPubkey = new Map<string, number>();
  for (let i = 0; i < remainingAccounts.length; i++) {
    indexByPubkey.set(remainingAccounts[i].pubkey.toBase58(), i);
  }

  const encodedParts: Uint8Array[] = [];
  for (const ix of innerInstructions) {
    const programIdBytes = new PublicKey(ix.programId).toBytes();

    const accountEntries = new Uint8Array(ix.accounts.length * 2);
    for (let i = 0; i < ix.accounts.length; i++) {
      const acc = ix.accounts[i];
      const idx = indexByPubkey.get(acc.pubkey);
      if (idx === undefined) {
        throw new Error(
          `Account ${acc.pubkey} not present in remainingAccounts — ` +
            `did the caller forget to pass programId / account through encodeRemainingAccounts?`,
        );
      }
      if (idx > 0xff) {
        throw new RangeError(
          `Account index ${idx} exceeds u8 — too many unique accounts in remainingAccounts`,
        );
      }
      let flags = 0;
      if (acc.isWritable) flags |= FLAG_WRITABLE;
      if (acc.isEphemeralSigner) flags |= FLAG_EPHEMERAL_SIGNER;
      accountEntries[i * 2] = idx;
      accountEntries[i * 2 + 1] = flags;
    }

    encodedParts.push(programIdBytes);
    encodedParts.push(u16LE(ix.accounts.length));
    encodedParts.push(u16LE(ix.data.length));
    encodedParts.push(accountEntries);
    encodedParts.push(ix.data);
  }

  const useEphemeral =
    ephemeralSignerBumps !== undefined && ephemeralSignerBumps.length > 0;

  const head: Uint8Array[] = useEphemeral
    ? [
        Uint8Array.of(MachineWalletDisc.ExecuteWithEphemeralSigners),
        u64LE(maxSlot),
        Uint8Array.of(ephemeralSignerBumps!.length),
        ephemeralSignerBumps!,
        u32LE(innerInstructions.length),
      ]
    : [
        Uint8Array.of(MachineWalletDisc.Execute),
        u64LE(maxSlot),
        u32LE(innerInstructions.length),
      ];

  return concatBytes([...head, ...encodedParts]);
}

/**
 * Entry in the de-duplicated remaining-accounts list passed to
 * {@link buildExecuteIxData}. The caller appends these to the ix `keys` tail
 * (each as `{ pubkey, isSigner: false, isWritable }`) in the same order.
 */
export interface RemainingAccount {
  pubkey: PublicKey;
  isWritable: boolean;
}

/**
 * Build the de-duplicated remaining-accounts list the on-chain handler will
 * iterate over. Order matters — the program IDs of every inner ix come
 * **first**, then accounts in first-seen order across all inner ixs.
 * `isWritable` is OR-aggregated across all references (a single writable
 * reference makes the slot writable for the whole tx).
 *
 * Returned shape feeds both `buildExecuteIxData` (to map account → index byte)
 * and the caller's `TransactionInstruction.keys` tail. Keeping the de-dup in
 * the SDK eliminates the popup ↔ matrix-contract drift risk where two
 * implementations could pick different orderings.
 */
export function encodeRemainingAccounts(
  innerInstructions: ReadonlyArray<InnerInstruction>,
): RemainingAccount[] {
  const seen = new Map<string, number>();
  const out: RemainingAccount[] = [];

  const visit = (pubkeyStr: string, isWritable: boolean) => {
    const existing = seen.get(pubkeyStr);
    if (existing !== undefined) {
      if (isWritable) out[existing].isWritable = true;
      return;
    }
    seen.set(pubkeyStr, out.length);
    out.push({ pubkey: new PublicKey(pubkeyStr), isWritable });
  };

  // Program IDs first (non-writable), then accounts.
  for (const ix of innerInstructions) visit(ix.programId, false);
  for (const ix of innerInstructions) {
    for (const acc of ix.accounts) visit(acc.pubkey, acc.isWritable);
  }

  return out;
}
