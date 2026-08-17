/**
 * Minimal base58 (Bitcoin alphabet) pubkey decoder.
 *
 * Exists so challenge computation (`computeInnerHash` → operation hash) does
 * not pull `@solana/web3.js` into consumers' bundles — `signed-message.ts`
 * promises that challenge-only consumers stay web3-free, and a base58 codec
 * is all `inner-hash.ts` ever used web3.js for. Builders whose public API
 * already speaks `PublicKey` (`execute-ix.ts`) keep using web3.js.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const DIGIT_VALUES = new Map<string, number>(
  Array.from(ALPHABET, (ch, i) => [ch, i] as const),
);

/**
 * Decode a base58 Solana pubkey to its 32 raw bytes. Rejects exactly what
 * `new PublicKey(x)` rejects: characters outside the alphabet, and values
 * that do not decode to 32 bytes (leading `1`s count as leading zero bytes,
 * per the base58 canonical form).
 */
export function base58ToPubkeyBytes(value: string): Uint8Array {
  // 32 bytes encode to at most 44 base58 chars; longer strings would only
  // fail the carry check below after wasted work.
  if (value.length === 0 || value.length > 44) {
    throw new RangeError(`base58 pubkey must decode to 32 bytes: '${value}'`);
  }
  // Fixed-width big-endian accumulator: for each digit, out = out * 58 + digit.
  const out = new Uint8Array(32);
  for (const ch of value) {
    const digit = DIGIT_VALUES.get(ch);
    if (digit === undefined) {
      throw new RangeError(`invalid base58 character '${ch}' in pubkey '${value}'`);
    }
    let carry = digit;
    for (let i = 31; i >= 0; i--) {
      carry += out[i] * 58;
      out[i] = carry & 0xff;
      carry >>= 8;
    }
    if (carry !== 0) {
      throw new RangeError(`base58 pubkey must decode to 32 bytes: '${value}'`);
    }
  }
  // Canonical form: each leading '1' stands for one leading zero byte, so the
  // zero prefix plus the numeric payload must fill exactly 32 bytes.
  let leadingOnes = 0;
  while (leadingOnes < value.length && value[leadingOnes] === '1') leadingOnes++;
  let firstNonZero = 0;
  while (firstNonZero < 32 && out[firstNonZero] === 0) firstNonZero++;
  if (leadingOnes + (32 - firstNonZero) !== 32) {
    throw new RangeError(`base58 pubkey must decode to 32 bytes: '${value}'`);
  }
  return out;
}
