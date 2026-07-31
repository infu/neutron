import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
const HEX = /^[0-9a-f]+$/u;

export function utf8(value: string): Uint8Array {
  return UTF8.encode(value);
}

export function decodeUtf8(value: Uint8Array, label = "UTF-8 value"): string {
  try {
    return UTF8_FATAL.decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    different |= left[index]! ^ right[index]!;
  }
  return different === 0;
}

export function copyBytes(value: Uint8Array): Uint8Array {
  return value.slice();
}

export function requireBytes(
  value: unknown,
  label: string,
  minimum: number,
  maximum = minimum,
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${label} must be bytes`);
  }
  if (value.byteLength < minimum || value.byteLength > maximum) {
    const expected = minimum === maximum
      ? `${minimum}`
      : `${minimum}-${maximum}`;
    throw new Error(`${label} must be ${expected} bytes`);
  }
  return value;
}

export function toLowerHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}

export function fromLowerHex(
  value: string,
  expectedBytes?: number,
): Uint8Array {
  if (
    value.length === 0 ||
    value.length % 2 !== 0 ||
    !HEX.test(value) ||
    (expectedBytes !== undefined && value.length !== expectedBytes * 2)
  ) {
    throw new Error("Expected canonical lowercase hexadecimal");
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.byteLength; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function toBase64(value: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(
      ...value.subarray(offset, Math.min(value.byteLength, offset + chunkSize)),
    );
  }
  return btoa(binary);
}

export function fromCanonicalBase64(
  value: string,
  label: string,
  maximumBytes: number,
): Uint8Array {
  if (
    value.length === 0 ||
    value.length > Math.ceil(maximumBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
      .test(value)
  ) {
    throw new Error(`${label} is not canonical base64`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  if (binary.length > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  const result = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64(result) !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return result;
}

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(value.byteLength);
  input.set(value);
  // Sandboxed Neutron app and background frames intentionally have opaque
  // origins. Chromium still provides Worker isolation and secure randomness
  // there, but does not expose SubtleCrypto. Keep hashing inside the packaged
  // verifier with the same audited implementation used by Wagyu's protocol
  // codecs so certified reads work in that real runtime.
  return nobleSha256(input);
}

export function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((total, value) => total + value.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

export function u32be(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("Value is not an unsigned 32-bit integer");
  }
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

export function u64be(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error("Value is not an unsigned 64-bit integer");
  }
  const result = new Uint8Array(8);
  let remaining = value;
  for (let index = 7; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

export function unsignedLeb128(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("LEB128 value must be unsigned");
  const output: number[] = [];
  let remaining = value;
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    output.push(byte);
  } while (remaining !== 0n);
  return Uint8Array.from(output);
}

export function decodeUnsignedLeb128(
  value: Uint8Array,
  label: string,
): bigint {
  if (value.byteLength === 0 || value.byteLength > 10) {
    throw new Error(`${label} is not a bounded Nat64 LEB128 value`);
  }
  let result = 0n;
  let shift = 0n;
  for (let index = 0; index < value.byteLength; index += 1) {
    const byte = value[index]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (index !== value.byteLength - 1) {
        throw new Error(`${label} has trailing LEB128 bytes`);
      }
      if (index > 0 && byte === 0) {
        throw new Error(`${label} is not canonical LEB128`);
      }
      if (result > 0xffff_ffff_ffff_ffffn) {
        throw new Error(`${label} exceeds Nat64`);
      }
      return result;
    }
    shift += 7n;
  }
  throw new Error(`${label} is unterminated LEB128`);
}

export function plainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain record`);
  }
  return value as Record<string, unknown>;
}
