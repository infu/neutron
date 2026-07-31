import { sha256 } from "@noble/hashes/sha2.js";
import {
  WAGYU_CAPABILITY_TOKEN_PATTERN,
  WAGYU_LIMITS,
  WAGYU_LOWER_HEX_32_PATTERN,
} from "./constants.ts";
import type {
  CandidOpt,
  WagyuBytes16,
  WagyuBytes32,
  WagyuExactCandidBytes,
} from "./types.ts";

const TEXT_ENCODER = new TextEncoder();
const NON_TEXT_CONTROLS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffff_ffff;
const MAX_U64 = (1n << 64n) - 1n;

export class WagyuProtocolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WagyuProtocolError";
  }
}

export function copyBytes(
  value: Uint8Array | ArrayBuffer,
  label = "bytes",
): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  throw new WagyuProtocolError(
    "WAGYU_INVALID_BLOB",
    `${label} must be a Uint8Array or ArrayBuffer`,
  );
}

export function exactCandidBytes(
  value: Uint8Array | ArrayBuffer,
  maximumBytes = Number.MAX_SAFE_INTEGER,
  label = "Candid message",
): WagyuExactCandidBytes {
  const bytes = copyBytes(value, label);
  if (bytes.byteLength > maximumBytes) {
    throw new WagyuProtocolError(
      "WAGYU_CANDID_TOO_LARGE",
      `${label} exceeds ${maximumBytes} bytes`,
    );
  }
  return bytes as WagyuExactCandidBytes;
}

export function bytes16(
  value: Uint8Array | ArrayBuffer,
  label = "nonce",
): WagyuBytes16 {
  const bytes = copyBytes(value, label);
  if (bytes.byteLength !== WAGYU_LIMITS.nonceBytes) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_BYTES16",
      `${label} must contain exactly ${WAGYU_LIMITS.nonceBytes} bytes`,
    );
  }
  return bytes as WagyuBytes16;
}

export function bytes32(
  value: Uint8Array | ArrayBuffer,
  label = "digest",
): WagyuBytes32 {
  const bytes = copyBytes(value, label);
  if (bytes.byteLength !== WAGYU_LIMITS.digestBytes) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_BYTES32",
      `${label} must contain exactly ${WAGYU_LIMITS.digestBytes} bytes`,
    );
  }
  return bytes as WagyuBytes32;
}

export function sha256Exact(
  value: Uint8Array | ArrayBuffer,
): WagyuBytes32 {
  return sha256(value instanceof Uint8Array ? value : new Uint8Array(value)) as
    WagyuBytes32;
}

export function equalBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export function utf8(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

export function utf8Length(value: string): number {
  return utf8(value).byteLength;
}

export function u32be(value: number, label = "u32"): Uint8Array {
  assertNat32(value, label);
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
}

export function u64be(value: bigint, label = "u64"): Uint8Array {
  assertNat64(value, label);
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, false);
  return result;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

export function lp(value: Uint8Array): Uint8Array {
  if (value.byteLength > MAX_U32) {
    throw new WagyuProtocolError(
      "WAGYU_LP_ITEM_TOO_LARGE",
      "LP item exceeds the u32 byte-length field",
    );
  }
  return concatBytes(u32be(value.byteLength), value);
}

/**
 * Frozen Wagyu hash framing: SHA256(LP(item[0]) || LP(item[1]) || ...).
 * Callers must supply the ASCII domain bytes as item zero.
 */
export function hashLp(...items: readonly Uint8Array[]): WagyuBytes32 {
  if (items.length === 0) {
    throw new WagyuProtocolError(
      "WAGYU_MISSING_HASH_DOMAIN",
      "A Wagyu hash requires its domain as the first LP item",
    );
  }
  const hasher = sha256.create();
  for (const item of items) {
    hasher.update(u32be(item.byteLength));
    hasher.update(item);
  }
  return hasher.digest() as WagyuBytes32;
}

export function lowerHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function parseLowerHex32(
  value: string,
  label = "digest hex",
): WagyuBytes32 {
  if (!WAGYU_LOWER_HEX_32_PATTERN.test(value)) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_HEX32",
      `${label} must contain exactly 64 lowercase hexadecimal characters`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes as WagyuBytes32;
}

export function assertNat8(value: number, label = "nat8"): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_NAT8",
      `${label} must be an unsigned nat8`,
    );
  }
  return value;
}

export function assertNat16(value: number, label = "nat16"): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U16) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_NAT16",
      `${label} must be an unsigned nat16`,
    );
  }
  return value;
}

export function assertNat32(value: number, label = "nat32"): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_NAT32",
      `${label} must be an unsigned nat32`,
    );
  }
  return value;
}

export function assertNat64(value: bigint, label = "nat64"): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_U64) {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_NAT64",
      `${label} must be an unsigned nat64`,
    );
  }
  return value;
}

export function requireKnownOpt<T>(
  value: CandidOpt<T>,
  label: string,
): T {
  if (value.length !== 1) {
    throw new WagyuProtocolError(
      "WAGYU_UNSUPPORTED_OPTION",
      `${label} is missing or unsupported`,
    );
  }
  return value[0]!;
}

export function assertBoundedText(
  value: string,
  maximumUtf8Bytes: number,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new WagyuProtocolError(
      "WAGYU_INVALID_TEXT",
      `${label} must be text`,
    );
  }
  if (NON_TEXT_CONTROLS.test(value)) {
    throw new WagyuProtocolError(
      "WAGYU_TEXT_CONTROL",
      `${label} contains a non-text control character`,
    );
  }
  if (utf8Length(value) > maximumUtf8Bytes) {
    throw new WagyuProtocolError(
      "WAGYU_TEXT_TOO_LARGE",
      `${label} exceeds ${maximumUtf8Bytes} UTF-8 bytes`,
    );
  }
  return value;
}

export function assertCapabilities(
  capabilities: readonly string[],
): void {
  if (capabilities.length > WAGYU_LIMITS.profileCapabilities) {
    throw new WagyuProtocolError(
      "WAGYU_TOO_MANY_CAPABILITIES",
      `Profile capabilities exceed ${WAGYU_LIMITS.profileCapabilities}`,
    );
  }
  let previous: string | undefined;
  for (const capability of capabilities) {
    if (
      !WAGYU_CAPABILITY_TOKEN_PATTERN.test(capability) ||
      utf8Length(capability) > WAGYU_LIMITS.profileCapabilityUtf8Bytes
    ) {
      throw new WagyuProtocolError(
        "WAGYU_INVALID_CAPABILITY",
        `Invalid profile capability token: ${capability}`,
      );
    }
    if (previous !== undefined && previous >= capability) {
      throw new WagyuProtocolError(
        "WAGYU_UNSORTED_CAPABILITIES",
        "Profile capabilities must be sorted and duplicate-free",
      );
    }
    previous = capability;
  }
}
