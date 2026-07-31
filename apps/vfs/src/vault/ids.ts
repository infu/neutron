import type {
  CanonicalNat64,
  FilesDigest256V2,
  FilesId128V2,
} from "../protocol/types.ts";
import {
  parseCanonicalNat64,
  parseFilesId128,
} from "../protocol/ids.ts";
import { assertFixedBytes, equalBytes } from "../crypto/canonical.ts";
import { secureRandomBytes, zeroBytes } from "../crypto/webcrypto.ts";

const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export function randomFilesId128(
  randomBytes: (length: number) => Uint8Array = secureRandomBytes,
): FilesId128V2 {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const bytes = randomBytes(16);
    assertFixedBytes(bytes, 16, "Files random id");
    try {
      const hi = readU64(bytes, 0);
      const lo = readU64(bytes, 8);
      if (hi !== 0n || lo !== 0n) {
        return Object.freeze({
          hi: hi.toString() as CanonicalNat64,
          lo: lo.toString() as CanonicalNat64,
        });
      }
    } finally {
      zeroBytes(bytes);
    }
  }
  throw new Error("Secure randomness repeatedly produced the reserved Files id");
}
export const randomFilesNodeId = randomFilesId128;
export const randomFilesContentId = randomFilesId128;
export const randomFilesRequestId = randomFilesId128;

export function incrementFilesRevision(
  current: CanonicalNat64,
): CanonicalNat64 {
  const value = BigInt(parseCanonicalNat64(current, "Files revision"));
  if (value >= MAX_U64) throw new Error("Files revision overflow");
  return (value + 1n).toString() as CanonicalNat64;
}

export function bytesToFilesId128(bytes: Uint8Array): FilesId128V2 {
  assertFixedBytes(bytes, 16, "Files id");
  return Object.freeze({
    hi: readU64(bytes, 0).toString() as CanonicalNat64,
    lo: readU64(bytes, 8).toString() as CanonicalNat64,
  });
}

export function filesId128ToBytes(id: FilesId128V2): Uint8Array {
  const parsed = parseFilesId128(id);
  const output = new Uint8Array(16);
  writeU64(output, 0, BigInt(parsed.hi));
  writeU64(output, 8, BigInt(parsed.lo));
  return output;
}

export function bytesToFilesDigest(bytes: Uint8Array): FilesDigest256V2 {
  assertFixedBytes(bytes, 32, "Files digest");
  return Object.freeze({
    a: readU64(bytes, 0).toString() as CanonicalNat64,
    b: readU64(bytes, 8).toString() as CanonicalNat64,
    c: readU64(bytes, 16).toString() as CanonicalNat64,
    d: readU64(bytes, 24).toString() as CanonicalNat64,
  });
}

export function filesDigestToBytes(digest: FilesDigest256V2): Uint8Array {
  const output = new Uint8Array(32);
  writeU64(output, 0, BigInt(parseCanonicalNat64(digest.a, "digest.a")));
  writeU64(output, 8, BigInt(parseCanonicalNat64(digest.b, "digest.b")));
  writeU64(output, 16, BigInt(parseCanonicalNat64(digest.c, "digest.c")));
  writeU64(output, 24, BigInt(parseCanonicalNat64(digest.d, "digest.d")));
  return output;
}

export function sameFilesId(
  left: FilesId128V2,
  right: FilesId128V2,
): boolean {
  return left.hi === right.hi && left.lo === right.lo;
}

export function sameFilesDigest(
  left: FilesDigest256V2,
  right: FilesDigest256V2,
): boolean {
  const leftBytes = filesDigestToBytes(left);
  const rightBytes = filesDigestToBytes(right);
  try {
    return equalBytes(leftBytes, rightBytes);
  } finally {
    zeroBytes(leftBytes);
    zeroBytes(rightBytes);
  }
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]!);
  }
  return value;
}

function writeU64(output: Uint8Array, offset: number, value: bigint): void {
  let remaining = value;
  for (let index = 7; index >= 0; index -= 1) {
    output[offset + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}
