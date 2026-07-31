import type { CanonicalNat64 } from "../protocol/types.ts";
import { parseCanonicalNat64 } from "../protocol/ids.ts";
import {
  FILES_ENCRYPTED_METADATA_MAX_BYTES,
  FILES_SHA256_BYTES,
} from "../crypto/types.ts";
import { assertFixedBytes } from "../crypto/canonical.ts";
import { FILES_V2_LIMITS } from "../protocol/constants.ts";
import {
  unicodeScalarCount,
  validateFilesName,
} from "./paths.ts";
import type { FilesPrivateMetadata } from "./types.ts";

const VERSION = 2;
const FOLDER = 0;
const FILE = 1;
const TEXT = 1;
const BINARY = 2;
const MAX_PLAINTEXT_BYTES =
  FILES_ENCRYPTED_METADATA_MAX_BYTES - 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function validateFilesMetadata(
  value: FilesPrivateMetadata,
): FilesPrivateMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Files metadata is invalid");
  }
  const root = value.name === "";
  const name = root ? "" : validateFilesName(value.name);
  const createdAtNs = parseCanonicalNat64(
    value.createdAtNs,
    "Files created time",
  );
  const modifiedAtNs = parseCanonicalNat64(
    value.modifiedAtNs,
    "Files modified time",
  );
  if (BigInt(createdAtNs) > BigInt(modifiedAtNs)) {
    throw new Error("Files metadata timestamps are reversed");
  }
  if (value.nodeKind === "folder") {
    return Object.freeze({
      nodeKind: "folder",
      name,
      createdAtNs,
      modifiedAtNs,
    });
  }
  if (
    value.nodeKind !== "file" ||
    root ||
    (value.contentKind !== "text_v1" &&
      value.contentKind !== "binary_v1") ||
    !Number.isSafeInteger(value.plaintextBytes) ||
    value.plaintextBytes < 0 ||
    value.plaintextBytes > FILES_V2_LIMITS.binaryFileBytes
  ) {
    throw new Error("Files file metadata is invalid");
  }
  if (
    value.contentKind === "text_v1" &&
    value.plaintextBytes > FILES_V2_LIMITS.textFileBytes
  ) {
    throw new Error("Files text metadata exceeds its bound");
  }
  if (
    typeof value.mimeType !== "string" ||
    encoder.encode(value.mimeType).byteLength > 128 ||
    !/^[\x20-\x7e]*$/u.test(value.mimeType)
  ) {
    throw new Error("Files MIME metadata is invalid");
  }
  assertFixedBytes(
    value.plaintextSha256,
    FILES_SHA256_BYTES,
    "Files plaintext digest",
  );
  return Object.freeze({
    nodeKind: "file",
    name,
    contentKind: value.contentKind,
    mimeType: value.mimeType,
    plaintextBytes: value.plaintextBytes,
    plaintextSha256: value.plaintextSha256.slice(),
    createdAtNs,
    modifiedAtNs,
  });
}

export function encodeFilesMetadata(
  value: FilesPrivateMetadata,
): Uint8Array {
  const metadata = validateFilesMetadata(value);
  const name = encoder.encode(metadata.name);
  const mime =
    metadata.nodeKind === "file"
      ? encoder.encode(metadata.mimeType)
      : new Uint8Array();
  const length =
    1 + 1 + 2 + 2 + name.byteLength + 8 + 8 +
    (metadata.nodeKind === "file"
      ? 1 + 2 + mime.byteLength + 8 + 32
      : 0);
  if (length > MAX_PLAINTEXT_BYTES) {
    throw new Error("Files metadata plaintext exceeds its bound");
  }
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  output[offset++] = VERSION;
  output[offset++] = metadata.nodeKind === "folder" ? FOLDER : FILE;
  view.setUint16(offset, unicodeScalarCount(metadata.name), false);
  offset += 2;
  view.setUint16(offset, name.byteLength, false);
  offset += 2;
  output.set(name, offset);
  offset += name.byteLength;
  writeU64(output, offset, BigInt(metadata.createdAtNs));
  offset += 8;
  writeU64(output, offset, BigInt(metadata.modifiedAtNs));
  offset += 8;
  if (metadata.nodeKind === "file") {
    output[offset++] = metadata.contentKind === "text_v1" ? TEXT : BINARY;
    view.setUint16(offset, mime.byteLength, false);
    offset += 2;
    output.set(mime, offset);
    offset += mime.byteLength;
    writeU64(output, offset, BigInt(metadata.plaintextBytes));
    offset += 8;
    output.set(metadata.plaintextSha256, offset);
    offset += 32;
  }
  if (offset !== output.byteLength) {
    throw new Error("Files metadata encoding failed");
  }
  return output;
}

export function decodeFilesMetadata(
  input: Uint8Array,
): FilesPrivateMetadata {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength < 22 ||
    input.byteLength > MAX_PLAINTEXT_BYTES
  ) {
    throw new Error("Files metadata plaintext is invalid");
  }
  const view = new DataView(
    input.buffer,
    input.byteOffset,
    input.byteLength,
  );
  let offset = 0;
  if (input[offset++] !== VERSION) {
    throw new Error("Files metadata version is unsupported");
  }
  const nodeKind = input[offset++];
  if (nodeKind !== FOLDER && nodeKind !== FILE) {
    throw new Error("Files metadata kind is unsupported");
  }
  const declaredScalars = view.getUint16(offset, false);
  offset += 2;
  const nameBytes = view.getUint16(offset, false);
  offset += 2;
  requireRemaining(input, offset, nameBytes + 16);
  const name = decodeStrict(input.subarray(offset, offset + nameBytes));
  offset += nameBytes;
  if (unicodeScalarCount(name) !== declaredScalars) {
    throw new Error("Files metadata name declaration is invalid");
  }
  if (name !== "") validateFilesName(name);
  const createdAtNs = readU64(input, offset).toString() as CanonicalNat64;
  offset += 8;
  const modifiedAtNs = readU64(input, offset).toString() as CanonicalNat64;
  offset += 8;
  if (nodeKind === FOLDER) {
    if (offset !== input.byteLength) {
      throw new Error("Files folder metadata has trailing bytes");
    }
    return validateFilesMetadata({
      nodeKind: "folder",
      name,
      createdAtNs,
      modifiedAtNs,
    });
  }
  requireRemaining(input, offset, 1 + 2 + 8 + 32);
  const kindByte = input[offset++];
  const contentKind =
    kindByte === TEXT
      ? "text_v1"
      : kindByte === BINARY
        ? "binary_v1"
        : null;
  if (contentKind === null) {
    throw new Error("Files content kind is unsupported");
  }
  const mimeBytes = view.getUint16(offset, false);
  offset += 2;
  requireRemaining(input, offset, mimeBytes + 8 + 32);
  const mimeType = decodeStrict(input.subarray(offset, offset + mimeBytes));
  offset += mimeBytes;
  const plaintextLength = readU64(input, offset);
  offset += 8;
  if (plaintextLength > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Files plaintext length is invalid");
  }
  const plaintextSha256 = input.slice(offset, offset + 32);
  offset += 32;
  if (offset !== input.byteLength) {
    throw new Error("Files file metadata has trailing bytes");
  }
  return validateFilesMetadata({
    nodeKind: "file",
    name,
    contentKind,
    mimeType,
    plaintextBytes: Number(plaintextLength),
    plaintextSha256,
    createdAtNs,
    modifiedAtNs,
  });
}

export function assertFilesMetadataBinding(
  metadata: FilesPrivateMetadata,
  input: {
    nodeKind: "folder" | "file";
    declaredNameScalars: number;
    root: boolean;
  },
): void {
  const validated = validateFilesMetadata(metadata);
  if (
    validated.nodeKind !== input.nodeKind ||
    unicodeScalarCount(validated.name) !== input.declaredNameScalars ||
    (input.root && validated.name !== "") ||
    (!input.root && validated.name === "")
  ) {
    throw new Error("Files decrypted metadata does not match its binding");
  }
}

export function assertStrictUtf8Text(
  bytes: Uint8Array,
  maximumBytes = FILES_V2_LIMITS.textFileBytes,
): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) {
    throw new Error("Files text exceeds its bound");
  }
  return decodeStrict(bytes);
}

function decodeStrict(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error("Files text is not strict UTF-8");
  }
}

function requireRemaining(
  input: Uint8Array,
  offset: number,
  bytes: number,
): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    offset + bytes > input.byteLength
  ) {
    throw new Error("Files metadata plaintext is truncated");
  }
}

function readU64(bytes: Uint8Array, offset: number): bigint {
  requireRemaining(bytes, offset, 8);
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
