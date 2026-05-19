/**
 * Tiny byte-encoding helpers shared across the wire-format modules. Internal —
 * not re-exported from the package root. Reasons:
 *  - These are 3-line functions; depending on `Buffer` (the obvious alternative)
 *    would drag Node-specific types into a browser-first SDK for no win.
 *  - Keeping them out of the public surface lets us swap them for native
 *    `DataView` chains later without an SDK major bump.
 *
 * Every function mirrors a single line in the on-chain Rust implementation
 * (`u16::to_le_bytes`, `u64::to_le_bytes`, `[a, b].concat()`) — change here
 * and the rest of `wire-format/` automatically follows.
 */

/** Little-endian u16 (matches `u16::to_le_bytes` on chain). */
export function u16LE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`u16LE: value out of range: ${value}`);
  }
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

/** Little-endian u32 (matches `u32::to_le_bytes` on chain). */
export function u32LE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`u32LE: value out of range: ${value}`);
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/** Little-endian u64 (matches `u64::to_le_bytes` on chain). */
export function u64LE(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 64n) {
    throw new RangeError(`u64LE: value out of u64 range: ${value}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** Flat concat. Allocates exactly once — important on hot paths like inner_hash. */
export function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
