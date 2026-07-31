import { Gunzip } from "fflate";

const MIB = 1024 * 1024;
const GZIP_STREAM_INPUT_CHUNK_BYTES = 4 * 1024;
const RESERVED_MAP_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

/**
 * Finite safety ceilings for the deliberate local-file installer. Repository
 * imports pass their smaller protocol ceilings explicitly; keeping those
 * limits out of these defaults preserves the existing manual install surface.
 */
export const DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS = Object.freeze({
  maxRawBytes: 128 * MIB,
  maxEntries: 16_384,
  maxPathBytes: 4_096,
  maxCompressedEntryBytes: 128 * MIB,
  maxDecodedEntryBytes: 64 * MIB,
  maxDecodedTotalBytes: 256 * MIB,
});

/** Candidate v1 ceilings for one package fetched from a setup repository. */
export const REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS = Object.freeze({
  maxRawBytes: 32 * MIB,
  maxEntries: 4_096,
  maxPathBytes: 512,
  maxCompressedEntryBytes: 32 * MIB,
  maxDecodedEntryBytes: 16 * MIB,
  maxDecodedTotalBytes: 64 * MIB,
});

export type NeutronPackageDecodeLimits = {
  maxRawBytes: number;
  maxEntries: number;
  maxPathBytes: number;
  maxCompressedEntryBytes: number;
  maxDecodedEntryBytes: number;
  maxDecodedTotalBytes: number;
};

export type NeutronPackageDecodeOptions = {
  limits?: Partial<NeutronPackageDecodeLimits>;
};

export type DecodedNeutronPackage = Record<string, Uint8Array>;

type BinaryDescriptor = {
  path: string;
  offset: number;
  length: number;
};

type EntryDescriptor = BinaryDescriptor;

/**
 * Decode the deliberately small `.neutron` MessagePack shape without first
 * asking a general-purpose decoder to materialize an attacker-sized object.
 * The only supported shape is the flat string-path -> MessagePack-binary map
 * emitted by the current packer.
 */
export function decodeNeutronPackageArchive(
  input: Uint8Array,
  options: NeutronPackageDecodeOptions = {},
): DecodedNeutronPackage {
  const limits = normalizeDecodeLimits(options.limits);
  if (!(input instanceof Uint8Array)) {
    throw new Error("Invalid .neutron package bytes");
  }
  if (input.byteLength > limits.maxRawBytes) {
    throw new Error(
      `.neutron package exceeds the ${limits.maxRawBytes}-byte raw limit`,
    );
  }

  const reader = new MessagePackPackageReader(input);
  const count = reader.readMapLength();
  if (count > limits.maxEntries) {
    throw new Error(
      `.neutron package has ${count} entries; limit is ${limits.maxEntries}`,
    );
  }

  const seen = new Set<string>();
  const entries: EntryDescriptor[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = reader.readPath(limits.maxPathBytes);
    assertSafeArchivePath(path, limits.maxPathBytes);
    if (RESERVED_MAP_KEYS.has(path)) {
      throw new Error(`Dangerous package map key ${path}`);
    }
    if (seen.has(path)) throw new Error(`Duplicate package path ${path}`);
    seen.add(path);
    entries.push(
      reader.readByteValue(path, limits.maxCompressedEntryBytes),
    );
  }
  reader.assertFinished();

  const unpacked = Object.create(null) as DecodedNeutronPackage;
  let decodedTotal = 0;
  for (const descriptor of entries) {
    const compressed = reader.materializeByteValue(descriptor);
    const remaining = limits.maxDecodedTotalBytes - decodedTotal;
    const decoded = gunzipBounded(
      compressed,
      descriptor.path,
      Math.min(limits.maxDecodedEntryBytes, remaining),
    );
    decodedTotal = checkedAdd(decodedTotal, decoded.byteLength, "decoded bytes");
    if (decodedTotal > limits.maxDecodedTotalBytes) {
      throw new Error(
        `.neutron package decoded files exceed the ${limits.maxDecodedTotalBytes}-byte aggregate limit`,
      );
    }
    unpacked[descriptor.path] = decoded;
  }
  return unpacked;
}

export function assertSafeArchivePath(
  packagePath: string,
  maxPathBytes: number = DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS.maxPathBytes,
): void {
  if (typeof packagePath !== "string" || packagePath.length === 0) {
    throw new Error("Invalid package path");
  }
  if (textEncoder.encode(packagePath).byteLength > maxPathBytes) {
    throw new Error(`Package path exceeds the ${maxPathBytes}-byte limit`);
  }
  if (
    packagePath.startsWith("/") ||
    packagePath.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(packagePath)
  ) {
    throw new Error(`Unsafe package path ${packagePath}`);
  }
  const segments = packagePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Unsafe package path ${packagePath}`);
  }
}

function normalizeDecodeLimits(
  overrides: Partial<NeutronPackageDecodeLimits> | undefined,
): NeutronPackageDecodeLimits {
  const limits = {
    ...DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS,
    ...(overrides ?? {}),
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

class MessagePackPackageReader {
  private offset = 0;

  constructor(private readonly input: Uint8Array) {}

  readMapLength(): number {
    const type = this.readUint8();
    if (type >= 0x80 && type <= 0x8f) return type - 0x80;
    if (type === 0xde) return this.readUint16();
    if (type === 0xdf) return this.readUint32();
    throw new Error("Invalid .neutron package payload: expected a map");
  }

  readPath(maxPathBytes: number): string {
    const type = this.readUint8();
    let length: number;
    if (type >= 0xa0 && type <= 0xbf) length = type - 0xa0;
    else if (type === 0xd9) length = this.readUint8();
    else if (type === 0xda) length = this.readUint16();
    else if (type === 0xdb) length = this.readUint32();
    else throw new Error("Invalid .neutron package path key");
    if (length > maxPathBytes) {
      throw new Error(`Package path exceeds the ${maxPathBytes}-byte limit`);
    }
    const encoded = this.readSlice(length, "package path");
    try {
      return textDecoder.decode(encoded);
    } catch (error) {
      throw new Error("Package path is not valid UTF-8", { cause: error });
    }
  }

  readByteValue(path: string, maxBytes: number): EntryDescriptor {
    const type = this.readUint8();
    let length: number;
    if (type === 0xc4) length = this.readUint8();
    else if (type === 0xc5) length = this.readUint16();
    else if (type === 0xc6) length = this.readUint32();
    else throw new Error(`Invalid package file bytes for ${path}`);
    if (length > maxBytes) {
      throw new Error(
        `Compressed package entry ${path} exceeds the ${maxBytes}-byte limit`,
      );
    }
    const offset = this.offset;
    this.skip(length, `package file ${path}`);
    return { path, offset, length };
  }

  materializeByteValue(descriptor: EntryDescriptor): Uint8Array {
    return this.input.subarray(
      descriptor.offset,
      descriptor.offset + descriptor.length,
    );
  }

  assertFinished(): void {
    if (this.offset !== this.input.byteLength) {
      throw new Error("Invalid .neutron package payload: trailing data");
    }
  }

  private readUint8(): number {
    if (this.offset >= this.input.byteLength) this.unexpectedEnd();
    return this.input[this.offset++]!;
  }

  private readUint16(): number {
    const high = this.readUint8();
    const low = this.readUint8();
    return high * 0x100 + low;
  }

  private readUint32(): number {
    return (
      this.readUint8() * 0x1_000000 +
      this.readUint8() * 0x1_0000 +
      this.readUint8() * 0x100 +
      this.readUint8()
    );
  }

  private skip(length: number, label: string): void {
    this.readSlice(length, label);
  }

  private readSlice(length: number, label: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error(`Invalid ${label} length`);
    }
    const end = this.offset + length;
    if (!Number.isSafeInteger(end) || end > this.input.byteLength) {
      this.unexpectedEnd();
    }
    const result = this.input.subarray(this.offset, end);
    this.offset = end;
    return result;
  }

  private unexpectedEnd(): never {
    throw new Error("Invalid .neutron package payload: unexpected end");
  }
}

function gunzipBounded(
  compressed: Uint8Array,
  path: string,
  maxDecodedBytes: number,
): Uint8Array {
  if (maxDecodedBytes < 0) {
    throw new Error("Invalid remaining decoded package budget");
  }
  const footer = inspectSingleGzipEnvelope(compressed, path);
  if (footer.size > maxDecodedBytes) {
    throw new Error(
      `Decoded package entry ${path} exceeds the ${maxDecodedBytes}-byte remaining limit`,
    );
  }

  const output = new Uint8Array(footer.size);
  let outputOffset = 0;
  let memberCount = 1;
  const gunzip = new Gunzip((chunk) => {
    const next = checkedAdd(outputOffset, chunk.byteLength, "gzip output bytes");
    if (next > maxDecodedBytes || next > footer.size) {
      throw new Error(`Decoded package entry ${path} exceeds its declared size`);
    }
    output.set(chunk, outputOffset);
    outputOffset = next;
  });
  gunzip.onmember = () => {
    memberCount += 1;
    throw new Error(`Package entry ${path} contains multiple gzip members`);
  };

  try {
    for (let offset = 0; offset < compressed.byteLength; ) {
      const end = Math.min(
        compressed.byteLength,
        offset + GZIP_STREAM_INPUT_CHUNK_BYTES,
      );
      gunzip.push(compressed.subarray(offset, end), end === compressed.byteLength);
      offset = end;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes(`Package entry ${path}`)) {
      throw error;
    }
    throw new Error(`Invalid gzip data for package entry ${path}`, {
      cause: error,
    });
  }

  if (memberCount !== 1) {
    throw new Error(`Package entry ${path} contains multiple gzip members`);
  }
  if (outputOffset !== footer.size) {
    throw new Error(`Invalid gzip size for package entry ${path}`);
  }
  if (crc32(output) !== footer.crc32) {
    throw new Error(`Invalid gzip checksum for package entry ${path}`);
  }
  return output;
}

function inspectSingleGzipEnvelope(
  compressed: Uint8Array,
  path: string,
): { crc32: number; size: number } {
  if (compressed.byteLength < 18) {
    throw new Error(`Invalid gzip data for package entry ${path}`);
  }
  if (
    compressed[0] !== 0x1f ||
    compressed[1] !== 0x8b ||
    compressed[2] !== 8
  ) {
    throw new Error(`Invalid gzip header for package entry ${path}`);
  }
  const flags = compressed[3]!;
  if ((flags & 0xe0) !== 0) {
    throw new Error(`Invalid gzip flags for package entry ${path}`);
  }
  let offset = 10;
  const footerOffset = compressed.byteLength - 8;
  if (flags & 0x04) {
    if (offset + 2 > footerOffset) {
      throw new Error(`Invalid gzip header for package entry ${path}`);
    }
    const extraLength = compressed[offset]! | (compressed[offset + 1]! << 8);
    offset += 2 + extraLength;
  }
  if (flags & 0x08) offset = skipZeroTerminated(compressed, offset, footerOffset, path);
  if (flags & 0x10) offset = skipZeroTerminated(compressed, offset, footerOffset, path);
  if (flags & 0x02) offset += 2;
  if (offset > footerOffset) {
    throw new Error(`Invalid gzip header for package entry ${path}`);
  }
  return {
    crc32: readUint32LittleEndian(compressed, footerOffset),
    size: readUint32LittleEndian(compressed, footerOffset + 4),
  };
}

function skipZeroTerminated(
  input: Uint8Array,
  offset: number,
  end: number,
  path: string,
): number {
  while (offset < end && input[offset] !== 0) offset += 1;
  if (offset >= end) {
    throw new Error(`Invalid gzip header for package entry ${path}`);
  }
  return offset + 1;
}

function readUint32LittleEndian(input: Uint8Array, offset: number): number {
  return (
    (input[offset]! |
      (input[offset + 1]! << 8) |
      (input[offset + 2]! << 16) |
      (input[offset + 3]! << 24)) >>>
    0
  );
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(input: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of input) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${label} exceed the safe integer range`);
  }
  return result;
}
