import {
  MAIL_LIMITS,
  type MailPrivateBody,
  type MailPrivateHeader,
  validateBodyMarkdown,
  validateClaimedSenderName,
  validateMessageId,
  validateSubject,
  validateUnsignedDecimal,
} from "./model.ts";
import {
  MAIL_BODY_PLAINTEXT_BUCKETS,
  MAIL_HEADER_PLAINTEXT_BYTES,
} from "./protocol.ts";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_U64 = (1n << 64n) - 1n;

export type MailContentCodecErrorCode =
  | "INVALID_CBOR"
  | "NONCANONICAL_CBOR"
  | "INVALID_SCHEMA"
  | "INVALID_CONTENT";

export class MailContentCodecError extends Error {
  constructor(
    public readonly code: MailContentCodecErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MailContentCodecError";
  }
}

/**
 * Deterministic CBOR for the frozen V1 header map:
 * {1: 1, 2: sender name, 3: subject, 4: sender time u64, 5: bytes[16] | null}
 */
export function encodeMailPrivateHeaderV1(
  input: MailPrivateHeader,
): Uint8Array {
  if (!input || input.contentSchema !== 1) {
    throw codecError("INVALID_SCHEMA", "Mail header schema must be 1");
  }
  const claimedSenderName = validateClaimedSenderName(input.claimedSenderName);
  const subject = validateSubject(input.subject);
  const senderCreatedAtNs = BigInt(
    validateUnsignedDecimal(input.senderCreatedAtNs, "Sender-created time", MAX_U64),
  );
  const inReplyTo =
    input.inReplyTo === null ? null : validateMessageId(input.inReplyTo);
  const encoded = concat(
    encodeHead(5, 5n),
    encodeUnsigned(1n),
    encodeUnsigned(1n),
    encodeUnsigned(2n),
    encodeText(claimedSenderName),
    encodeUnsigned(3n),
    encodeText(subject),
    encodeUnsigned(4n),
    encodeUnsigned(senderCreatedAtNs),
    encodeUnsigned(5n),
    inReplyTo === null ? Uint8Array.of(0xf6) : encodeBytes(inReplyTo),
  );
  if (encoded.byteLength + 5 > MAIL_HEADER_PLAINTEXT_BYTES) {
    throw codecError("INVALID_CONTENT", "Mail header does not fit its padding bucket");
  }
  return encoded;
}

export function decodeMailPrivateHeaderV1(
  encoded: Uint8Array,
): MailPrivateHeader {
  const reader = new CborReader(
    encoded,
    MAIL_HEADER_PLAINTEXT_BYTES - 5,
    "Mail header",
  );
  reader.expectMap(5);
  reader.expectKey(1);
  reader.expectUnsigned(1n, "Mail header schema");
  reader.expectKey(2);
  const claimedSenderName = validateClaimedSenderName(reader.readText());
  reader.expectKey(3);
  const subject = validateSubject(reader.readText());
  reader.expectKey(4);
  const senderCreatedAtNs = reader.readUnsigned().toString();
  reader.expectKey(5);
  const inReplyTo = reader.peek() === 0xf6
    ? (reader.readNull(), null)
    : validateMessageId(reader.readBytes());
  reader.expectEnd();
  return {
    contentSchema: 1,
    claimedSenderName,
    subject,
    senderCreatedAtNs,
    inReplyTo,
  };
}

/** Deterministic CBOR for the frozen V1 body map: {1: 1, 2: Markdown}. */
export function encodeMailPrivateBodyV1(input: MailPrivateBody): Uint8Array {
  if (!input || input.contentSchema !== 1) {
    throw codecError("INVALID_SCHEMA", "Mail body schema must be 1");
  }
  const bodyMarkdown = validateBodyMarkdown(input.bodyMarkdown);
  const encoded = concat(
    encodeHead(5, 2n),
    encodeUnsigned(1n),
    encodeUnsigned(1n),
    encodeUnsigned(2n),
    encodeText(bodyMarkdown),
  );
  if (encoded.byteLength + 5 > MAIL_BODY_PLAINTEXT_BUCKETS.at(-1)!) {
    throw codecError("INVALID_CONTENT", "Mail body does not fit its padding bucket");
  }
  return encoded;
}

export function decodeMailPrivateBodyV1(encoded: Uint8Array): MailPrivateBody {
  const reader = new CborReader(
    encoded,
    MAIL_BODY_PLAINTEXT_BUCKETS.at(-1)! - 5,
    "Mail body",
  );
  reader.expectMap(2);
  reader.expectKey(1);
  reader.expectUnsigned(1n, "Mail body schema");
  reader.expectKey(2);
  const bodyMarkdown = validateBodyMarkdown(reader.readText());
  reader.expectEnd();
  return { contentSchema: 1, bodyMarkdown };
}

class CborReader {
  private cursor = 0;

  constructor(
    private readonly bytes: Uint8Array,
    maximumBytes: number,
    label: string,
  ) {
    if (!(bytes instanceof Uint8Array)) {
      throw codecError("INVALID_CBOR", `${label} must be CBOR bytes`);
    }
    if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
      throw codecError("INVALID_CBOR", `${label} CBOR length is invalid`);
    }
  }

  peek(): number {
    this.require(1);
    return this.bytes[this.cursor]!;
  }

  expectMap(length: number): void {
    const actual = this.readHead(5);
    if (actual !== BigInt(length)) {
      throw codecError("INVALID_SCHEMA", "Mail CBOR map has an unexpected size");
    }
  }

  expectKey(key: number): void {
    const actual = this.readUnsigned();
    if (actual !== BigInt(key)) {
      throw codecError(
        "INVALID_SCHEMA",
        "Mail CBOR keys are missing, duplicated, unknown, or out of order",
      );
    }
  }

  expectUnsigned(expected: bigint, label: string): void {
    if (this.readUnsigned() !== expected) {
      throw codecError("INVALID_SCHEMA", `${label} is unsupported`);
    }
  }

  readUnsigned(): bigint {
    return this.readHead(0);
  }

  readText(): string {
    const length = this.lengthAsNumber(this.readHead(3));
    const value = this.take(length);
    try {
      return utf8Decoder.decode(value);
    } catch {
      throw codecError("INVALID_CBOR", "Mail CBOR contains invalid UTF-8");
    }
  }

  readBytes(): Uint8Array {
    const length = this.lengthAsNumber(this.readHead(2));
    return this.take(length).slice();
  }

  readNull(): void {
    if (this.peek() !== 0xf6) {
      throw codecError("INVALID_SCHEMA", "Expected null reply reference");
    }
    this.cursor += 1;
  }

  expectEnd(): void {
    if (this.cursor !== this.bytes.byteLength) {
      throw codecError("INVALID_CBOR", "Mail CBOR contains trailing bytes");
    }
  }

  private readHead(expectedMajor: number): bigint {
    const initial = this.take(1)[0]!;
    const major = initial >>> 5;
    const additional = initial & 0x1f;
    if (major !== expectedMajor) {
      throw codecError("INVALID_SCHEMA", "Mail CBOR value has the wrong type");
    }
    if (additional < 24) return BigInt(additional);
    if (additional === 24) {
      const value = BigInt(this.take(1)[0]!);
      if (value < 24n) throw noncanonical();
      return value;
    }
    if (additional === 25) {
      const value = BigInt(this.readView(2).getUint16(0, false));
      if (value <= 0xffn) throw noncanonical();
      return value;
    }
    if (additional === 26) {
      const value = BigInt(this.readView(4).getUint32(0, false));
      if (value <= 0xffffn) throw noncanonical();
      return value;
    }
    if (additional === 27) {
      const value = this.readView(8).getBigUint64(0, false);
      if (value <= 0xffff_ffffn) throw noncanonical();
      return value;
    }
    throw codecError(
      "INVALID_CBOR",
      "Indefinite or reserved CBOR forms are not allowed",
    );
  }

  private lengthAsNumber(value: bigint): number {
    const remaining = BigInt(this.bytes.byteLength - this.cursor);
    if (value > remaining || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw codecError("INVALID_CBOR", "Mail CBOR length exceeds its input");
    }
    return Number(value);
  }

  private readView(length: number): DataView {
    const value = this.take(length);
    return new DataView(value.buffer, value.byteOffset, value.byteLength);
  }

  private take(length: number): Uint8Array {
    this.require(length);
    const value = this.bytes.subarray(this.cursor, this.cursor + length);
    this.cursor += length;
    return value;
  }

  private require(length: number): void {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.cursor + length > this.bytes.byteLength
    ) {
      throw codecError("INVALID_CBOR", "Mail CBOR ended early");
    }
  }
}

function encodeUnsigned(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_U64) {
    throw codecError("INVALID_CONTENT", "Mail CBOR integer is outside u64");
  }
  return encodeHead(0, value);
}

function encodeText(value: string): Uint8Array {
  const bytes = utf8Encoder.encode(value);
  return concat(encodeHead(3, BigInt(bytes.byteLength)), bytes);
}

function encodeBytes(value: Uint8Array): Uint8Array {
  return concat(encodeHead(2, BigInt(value.byteLength)), value);
}

function encodeHead(major: number, value: bigint): Uint8Array {
  if (major < 0 || major > 7 || value < 0n || value > MAX_U64) {
    throw codecError("INVALID_CONTENT", "Mail CBOR head is invalid");
  }
  const prefix = major << 5;
  if (value < 24n) return Uint8Array.of(prefix | Number(value));
  if (value <= 0xffn) return Uint8Array.of(prefix | 24, Number(value));
  if (value <= 0xffffn) {
    const output = new Uint8Array(3);
    output[0] = prefix | 25;
    view(output).setUint16(1, Number(value), false);
    return output;
  }
  if (value <= 0xffff_ffffn) {
    const output = new Uint8Array(5);
    output[0] = prefix | 26;
    view(output).setUint32(1, Number(value), false);
    return output;
  }
  const output = new Uint8Array(9);
  output[0] = prefix | 27;
  view(output).setBigUint64(1, value, false);
  return output;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    values.reduce((total, value) => total + value.byteLength, 0),
  );
  let cursor = 0;
  for (const value of values) {
    output.set(value, cursor);
    cursor += value.byteLength;
  }
  return output;
}

function view(value: Uint8Array): DataView {
  return new DataView(value.buffer, value.byteOffset, value.byteLength);
}

function noncanonical(): MailContentCodecError {
  return codecError(
    "NONCANONICAL_CBOR",
    "Mail CBOR integer or length does not use its shortest form",
  );
}

function codecError(
  code: MailContentCodecErrorCode,
  message: string,
): MailContentCodecError {
  return new MailContentCodecError(code, message);
}

export const MAIL_CONTENT_CODEC_LIMITS = Object.freeze({
  maximumHeaderCborBytes: MAIL_HEADER_PLAINTEXT_BYTES - 5,
  maximumBodyCborBytes: MAIL_BODY_PLAINTEXT_BUCKETS.at(-1)! - 5,
  maximumBodyMarkdownBytes: MAIL_LIMITS.bodyBytes,
});
