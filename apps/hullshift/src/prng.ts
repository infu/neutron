/** Canonical UInt64 seed parsing retained for saved-level and share-code compatibility. */

export const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export function parseCanonicalSeed(value: string): bigint {
  if (!/^[0-9a-f]{16}$/.test(value)) {
    throw new RangeError("Seed must contain exactly 16 lowercase hexadecimal digits");
  }
  return BigInt(`0x${value}`);
}

export function formatCanonicalSeed(seed: bigint): string {
  if (seed < 0n || seed > UINT64_MAX) {
    throw new RangeError("Hullshift seed must be an unsigned 64-bit integer");
  }
  return seed.toString(16).padStart(16, "0");
}
