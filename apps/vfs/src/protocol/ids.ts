import type {
  CanonicalNat64,
  FilesId128Key,
  FilesId128V2,
} from "./types.ts";

const MAX_U64 = (1n << 64n) - 1n;
const MAX_U32 = 0xffff_ffff;
const ID128_KEY = /^[a-f0-9]{32}$/u;

export class FilesProtocolValueError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FilesProtocolValueError";
  }
}

export function parseCanonicalNat64(
  value: unknown,
  label = "nat64",
): CanonicalNat64 {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_U64) {
      throw new FilesProtocolValueError(
        "FILES_INVALID_NAT64",
        `${label} exceeds nat64`,
      );
    }
    return value.toString() as CanonicalNat64;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 20 ||
    !/^(0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_NAT64",
      `${label} must be a canonical unsigned decimal nat64`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_NAT64",
      `${label} exceeds nat64`,
    );
  }
  return value as CanonicalNat64;
}

export function parseNat32(value: unknown, label = "nat32"): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_U32) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_NAT32",
      `${label} must be an unsigned nat32`,
    );
  }
  return value as number;
}

export function parseFilesId128(
  value: unknown,
  label = "id",
): FilesId128V2 {
  const object = exactRecord(value, ["hi", "lo"], label);
  return Object.freeze({
    hi: parseCanonicalNat64(object.hi, `${label}.hi`),
    lo: parseCanonicalNat64(object.lo, `${label}.lo`),
  });
}

export function filesId128ToKey(id: FilesId128V2): FilesId128Key {
  const hi = BigInt(parseCanonicalNat64(id.hi, "id.hi"))
    .toString(16)
    .padStart(16, "0");
  const lo = BigInt(parseCanonicalNat64(id.lo, "id.lo"))
    .toString(16)
    .padStart(16, "0");
  return `${hi}${lo}` as FilesId128Key;
}

export function filesId128FromKey(key: string): FilesId128V2 {
  if (!ID128_KEY.test(key)) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_ID128_KEY",
      "ID key must contain exactly 32 lowercase hexadecimal characters",
    );
  }
  return Object.freeze({
    hi: BigInt(`0x${key.slice(0, 16)}`).toString() as CanonicalNat64,
    lo: BigInt(`0x${key.slice(16)}`).toString() as CanonicalNat64,
  });
}

export function filesId128Equal(
  left: FilesId128V2,
  right: FilesId128V2,
): boolean {
  return left.hi === right.hi && left.lo === right.lo;
}

export function filesId128IsZero(id: FilesId128V2): boolean {
  return id.hi === "0" && id.lo === "0";
}

export function parseByteArray(
  value: unknown,
  options: {
    label?: string;
    exactBytes?: number;
    maximumBytes?: number;
  } = {},
): Uint8Array<ArrayBuffer> {
  const label = options.label ?? "bytes";
  const bytes =
    value instanceof Uint8Array
      ? Array.from(value)
      : Array.isArray(value)
        ? value
        : null;
  if (
    bytes === null ||
    bytes.some(
      (byte) =>
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255,
    )
  ) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_BYTES",
      `${label} must be a byte array`,
    );
  }
  if (options.exactBytes !== undefined && bytes.length !== options.exactBytes) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_BYTES",
      `${label} must contain exactly ${options.exactBytes} bytes`,
    );
  }
  if (
    options.maximumBytes !== undefined &&
    bytes.length > options.maximumBytes
  ) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_BYTES",
      `${label} exceeds ${options.maximumBytes} bytes`,
    );
  }
  return new Uint8Array(bytes);
}

export function validateLsbBitmap(
  bitmap: Uint8Array,
  bitCount: number,
  label = "bitmap",
): void {
  if (!Number.isSafeInteger(bitCount) || bitCount < 0) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_BITMAP",
      `${label} bit count is invalid`,
    );
  }
  const expectedBytes = Math.ceil(bitCount / 8);
  if (bitmap.byteLength !== expectedBytes) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_BITMAP",
      `${label} has the wrong byte length`,
    );
  }
  const usedLastBits = bitCount % 8;
  if (usedLastBits !== 0 && bitmap.byteLength > 0) {
    const unusedMask = 0xff << usedLastBits;
    if ((bitmap[bitmap.byteLength - 1]! & unusedMask) !== 0) {
      throw new FilesProtocolValueError(
        "FILES_INVALID_BITMAP",
        `${label} has nonzero unused high bits`,
      );
    }
  }
}

export function lsbBitmapHas(bitmap: Uint8Array, index: number): boolean {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bitmap.byteLength * 8) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_BITMAP_INDEX",
      "Bitmap index is out of range",
    );
  }
  return (bitmap[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0;
}

export function lsbBitmapSet(bitmap: Uint8Array, index: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bitmap.byteLength * 8) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_BITMAP_INDEX",
      "Bitmap index is out of range",
    );
  }
  bitmap[Math.floor(index / 8)]! |= 1 << (index % 8);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_RECORD",
      `${label} must be a plain record`,
    );
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw new FilesProtocolValueError(
      "FILES_INVALID_RECORD",
      `${label} has unexpected fields`,
    );
  }
  return record;
}
