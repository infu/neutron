import { Principal } from "@dfinity/principal";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  MAIL_CIPHER_SUITE,
  MAIL_LIMITS,
  MAIL_PROTOCOL_VERSION,
  validateFingerprint,
  validateFixedBytes,
  validateMessageId,
  validateNonzeroFixedBytes,
} from "./model.ts";

export const MAIL_AAD_DOMAIN = "neutron-mail-envelope-v1";
export const MAIL_KEY_INFO_DOMAIN = "neutron-mail-key-info-v1";
export const MAIL_PADDING_VERSION = 1;
export const MAIL_HEADER_PLAINTEXT_BYTES = 2 * 1024;
export const MAIL_BODY_PLAINTEXT_BUCKETS = Object.freeze([
  1 * 1024,
  4 * 1024,
  16 * 1024,
  36 * 1024,
] as const);
export const MAIL_AES_GCM_TAG_BYTES = 16;
export const MAIL_HEADER_CIPHERTEXT_BYTES =
  MAIL_HEADER_PLAINTEXT_BYTES + MAIL_AES_GCM_TAG_BYTES;
export const MAIL_BODY_LENGTH_BYTES = 4;
export const MAIL_BODY_CIPHERTEXT_BUCKETS = Object.freeze(
  MAIL_BODY_PLAINTEXT_BUCKETS.map(
    (size) => size + MAIL_AES_GCM_TAG_BYTES,
  ),
);

// Exact V1 offsets. Every integer is unsigned big-endian. The sole variable
// field has a fixed-width u32 length followed by exactly that many bytes.
export const MAIL_ENVELOPE_OFFSETS = Object.freeze({
  version: 0,
  suite: 1,
  deliveryKeyEpoch: 3,
  recipientKeyFingerprint: 11,
  messageId: 43,
  recipientWrappedCek: 59,
  headerNonce: 227,
  headerCiphertextAndTag: 239,
  bodyNonce: 2303,
  bodyCiphertextLength: 2315,
  bodyCiphertextAndTag: 2319,
});
export const MAIL_ENVELOPE_PREFIX_BYTES =
  1 + // protocol version
  2 + // suite
  8 + // recipient key epoch
  MAIL_LIMITS.fingerprintBytes +
  MAIL_LIMITS.messageIdBytes +
  MAIL_LIMITS.wrappedCekBytes +
  MAIL_LIMITS.nonceBytes +
  MAIL_HEADER_CIPHERTEXT_BYTES +
  MAIL_LIMITS.nonceBytes +
  MAIL_BODY_LENGTH_BYTES;
export const MAIL_ENVELOPE_SIZES = Object.freeze(
  MAIL_BODY_CIPHERTEXT_BUCKETS.map(
    (bodyBytes) => MAIL_ENVELOPE_PREFIX_BYTES + bodyBytes,
  ),
);
export const MAIL_MAX_ENVELOPE_BYTES = MAIL_ENVELOPE_SIZES.at(-1)!;

export type MailSectionDomain = "header" | "body";

export type MailEnvelopeV1 = {
  version: 1;
  suite: 1;
  deliveryKeyEpoch: bigint;
  recipientKeyFingerprint: Uint8Array;
  messageId: Uint8Array;
  recipientWrappedCek: Uint8Array;
  headerNonce: Uint8Array;
  headerCiphertextAndTag: Uint8Array;
  bodyNonce: Uint8Array;
  bodyCiphertextAndTag: Uint8Array;
};

export type MailAadInput = {
  senderPrincipal: string | Uint8Array;
  recipientPrincipal: string | Uint8Array;
  deliveryKeyEpoch: bigint;
  recipientKeyFingerprint: Uint8Array;
  messageId: Uint8Array;
  section: MailSectionDomain;
};

export type MailKeyFingerprintInput = {
  suite?: 1;
  epoch: bigint;
  contextPublicKey: Uint8Array;
  effectiveIbeIdentity: Uint8Array;
};

export type MailProtocolErrorCode =
  | "INVALID_ENVELOPE"
  | "INVALID_VERSION"
  | "INVALID_SUITE"
  | "INVALID_EPOCH"
  | "INVALID_LENGTH"
  | "INVALID_NONCE"
  | "INVALID_PRINCIPAL"
  | "INVALID_PADDING";

export class MailProtocolError extends Error {
  constructor(
    public readonly code: MailProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MailProtocolError";
  }
}

export function encodeMailEnvelopeV1(input: MailEnvelopeV1): Uint8Array {
  const envelope = normalizeEnvelope(input);
  const output = new Uint8Array(
    MAIL_ENVELOPE_PREFIX_BYTES + envelope.bodyCiphertextAndTag.byteLength,
  );
  const view = dataView(output);
  let cursor = 0;
  output[cursor++] = envelope.version;
  view.setUint16(cursor, envelope.suite, false);
  cursor += 2;
  view.setBigUint64(cursor, envelope.deliveryKeyEpoch, false);
  cursor += 8;
  cursor = writeBytes(output, cursor, envelope.recipientKeyFingerprint);
  cursor = writeBytes(output, cursor, envelope.messageId);
  cursor = writeBytes(output, cursor, envelope.recipientWrappedCek);
  cursor = writeBytes(output, cursor, envelope.headerNonce);
  cursor = writeBytes(output, cursor, envelope.headerCiphertextAndTag);
  cursor = writeBytes(output, cursor, envelope.bodyNonce);
  view.setUint32(cursor, envelope.bodyCiphertextAndTag.byteLength, false);
  cursor += MAIL_BODY_LENGTH_BYTES;
  cursor = writeBytes(output, cursor, envelope.bodyCiphertextAndTag);
  if (cursor !== output.byteLength) {
    throw new MailProtocolError(
      "INVALID_ENVELOPE",
      "Mail envelope encoding length mismatch",
    );
  }
  return output;
}

export function decodeMailEnvelopeV1(value: Uint8Array): MailEnvelopeV1 {
  if (!(value instanceof Uint8Array)) {
    throw new MailProtocolError("INVALID_ENVELOPE", "Mail envelope must be bytes");
  }
  if (!MAIL_ENVELOPE_SIZES.includes(value.byteLength)) {
    throw new MailProtocolError(
      "INVALID_LENGTH",
      `Mail envelope has a noncanonical byte length`,
    );
  }
  const view = dataView(value);
  let cursor = 0;
  const version = value[cursor++];
  if (version !== MAIL_PROTOCOL_VERSION) {
    throw new MailProtocolError("INVALID_VERSION", "Unsupported Mail protocol version");
  }
  const suite = view.getUint16(cursor, false);
  cursor += 2;
  if (suite !== MAIL_CIPHER_SUITE) {
    throw new MailProtocolError("INVALID_SUITE", "Unsupported Mail cipher suite");
  }
  const deliveryKeyEpoch = view.getBigUint64(cursor, false);
  cursor += 8;
  assertEpoch(deliveryKeyEpoch);

  const recipientKeyFingerprint = validateFingerprint(
    readBytes(value, cursor, MAIL_LIMITS.fingerprintBytes),
  );
  cursor += MAIL_LIMITS.fingerprintBytes;
  const messageId = validateMessageId(
    readBytes(value, cursor, MAIL_LIMITS.messageIdBytes),
  );
  cursor += MAIL_LIMITS.messageIdBytes;
  const recipientWrappedCek = validateNonzeroFixedBytes(
    readBytes(value, cursor, MAIL_LIMITS.wrappedCekBytes),
    MAIL_LIMITS.wrappedCekBytes,
    "Recipient CEK wrap",
  );
  cursor += MAIL_LIMITS.wrappedCekBytes;
  const headerNonce = readBytes(value, cursor, MAIL_LIMITS.nonceBytes);
  cursor += MAIL_LIMITS.nonceBytes;
  const headerCiphertextAndTag = readBytes(
    value,
    cursor,
    MAIL_HEADER_CIPHERTEXT_BYTES,
  );
  cursor += MAIL_HEADER_CIPHERTEXT_BYTES;
  const bodyNonce = readBytes(value, cursor, MAIL_LIMITS.nonceBytes);
  cursor += MAIL_LIMITS.nonceBytes;
  const bodyCiphertextLength = view.getUint32(cursor, false);
  cursor += MAIL_BODY_LENGTH_BYTES;
  if (!MAIL_BODY_CIPHERTEXT_BUCKETS.includes(bodyCiphertextLength)) {
    throw new MailProtocolError(
      "INVALID_LENGTH",
      "Body ciphertext has a noncanonical declared size",
    );
  }
  if (cursor + bodyCiphertextLength !== value.byteLength) {
    throw new MailProtocolError(
      "INVALID_LENGTH",
      "Body ciphertext length does not match the Mail envelope",
    );
  }
  const bodyCiphertextAndTag = readBytes(value, cursor, bodyCiphertextLength);

  assertDistinctNonces(headerNonce, bodyNonce);
  return {
    version: MAIL_PROTOCOL_VERSION,
    suite: MAIL_CIPHER_SUITE,
    deliveryKeyEpoch,
    recipientKeyFingerprint,
    messageId,
    recipientWrappedCek,
    headerNonce,
    headerCiphertextAndTag,
    bodyNonce,
    bodyCiphertextAndTag,
  };
}

export function buildMailSectionAad(input: MailAadInput): Uint8Array {
  const domain = new TextEncoder().encode(MAIL_AAD_DOMAIN);
  const sender = principalBytes(input.senderPrincipal);
  const recipient = principalBytes(input.recipientPrincipal);
  const fingerprint = validateFingerprint(input.recipientKeyFingerprint);
  const messageId = validateMessageId(input.messageId);
  assertEpoch(input.deliveryKeyEpoch);
  if (domain.byteLength > 0xff || sender.byteLength > 0xff || recipient.byteLength > 0xff) {
    throw new MailProtocolError("INVALID_LENGTH", "Mail AAD field is too long");
  }

  const output = new Uint8Array(
    1 + domain.byteLength +
      1 + 2 +
      1 + sender.byteLength +
      1 + recipient.byteLength +
      8 + fingerprint.byteLength + messageId.byteLength + 1,
  );
  const view = dataView(output);
  let cursor = 0;
  output[cursor++] = domain.byteLength;
  cursor = writeBytes(output, cursor, domain);
  output[cursor++] = MAIL_PROTOCOL_VERSION;
  view.setUint16(cursor, MAIL_CIPHER_SUITE, false);
  cursor += 2;
  output[cursor++] = sender.byteLength;
  cursor = writeBytes(output, cursor, sender);
  output[cursor++] = recipient.byteLength;
  cursor = writeBytes(output, cursor, recipient);
  view.setBigUint64(cursor, input.deliveryKeyEpoch, false);
  cursor += 8;
  cursor = writeBytes(output, cursor, fingerprint);
  cursor = writeBytes(output, cursor, messageId);
  output[cursor++] = input.section === "header" ? 1 : input.section === "body" ? 2 : 0;
  if (output[cursor - 1] === 0 || cursor !== output.byteLength) {
    throw new MailProtocolError("INVALID_ENVELOPE", "Invalid Mail section domain");
  }
  return output;
}

export function computeMailKeyFingerprint(
  input: MailKeyFingerprintInput,
): Uint8Array {
  const suite = input.suite ?? MAIL_CIPHER_SUITE;
  if (suite !== MAIL_CIPHER_SUITE) {
    throw new MailProtocolError("INVALID_SUITE", "Unsupported Mail cipher suite");
  }
  assertEpoch(input.epoch);
  const domain = new TextEncoder().encode(MAIL_KEY_INFO_DOMAIN);
  const publicKey = boundedPublicBytes(input.contextPublicKey, "Context public key");
  const identity = boundedPublicBytes(input.effectiveIbeIdentity, "IBE identity");
  return sha256(
    concatBytes(
      lengthPrefix(domain),
      u16be(suite),
      u64be(input.epoch),
      lengthPrefix(publicKey),
      lengthPrefix(identity),
    ),
  );
}

export function padHeaderSection(
  payload: Uint8Array,
  randomFill: RandomFill = secureRandomFill,
): Uint8Array {
  return padSection(payload, MAIL_HEADER_PLAINTEXT_BYTES, randomFill);
}

export function padBodySection(
  payload: Uint8Array,
  randomFill: RandomFill = secureRandomFill,
): Uint8Array {
  const payloadBytes = checkedPayload(payload);
  const bucket = MAIL_BODY_PLAINTEXT_BUCKETS.find(
    (size) => payloadBytes.byteLength + 5 <= size,
  );
  if (bucket === undefined) {
    throw new MailProtocolError(
      "INVALID_LENGTH",
      "Encoded Mail body does not fit the largest padding bucket",
    );
  }
  return padSection(payloadBytes, bucket, randomFill);
}

export function unpadHeaderSection(value: Uint8Array): Uint8Array {
  return unpadSection(value, [MAIL_HEADER_PLAINTEXT_BYTES]);
}

export function unpadBodySection(value: Uint8Array): Uint8Array {
  return unpadSection(value, MAIL_BODY_PLAINTEXT_BUCKETS);
}

export type RandomFill = (target: Uint8Array) => void;

export function padSection(
  payload: Uint8Array,
  targetBytes: number,
  randomFill: RandomFill = secureRandomFill,
): Uint8Array {
  const source = checkedPayload(payload);
  if (
    !Number.isSafeInteger(targetBytes) ||
    targetBytes < 5 ||
    source.byteLength > targetBytes - 5
  ) {
    throw new MailProtocolError(
      "INVALID_LENGTH",
      "Mail payload does not fit its padding bucket",
    );
  }
  const output = new Uint8Array(targetBytes);
  output[0] = MAIL_PADDING_VERSION;
  dataView(output).setUint32(1, source.byteLength, false);
  output.set(source, 5);
  const padding = output.subarray(5 + source.byteLength);
  if (padding.byteLength > 0) randomFill(padding);
  return output;
}

export function unpadSection(
  value: Uint8Array,
  allowedSizes: readonly number[],
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new MailProtocolError("INVALID_PADDING", "Padded Mail section must be bytes");
  }
  if (!allowedSizes.includes(value.byteLength)) {
    throw new MailProtocolError(
      "INVALID_PADDING",
      "Padded Mail section has a noncanonical size",
    );
  }
  if (value.byteLength < 5 || value[0] !== MAIL_PADDING_VERSION) {
    throw new MailProtocolError("INVALID_PADDING", "Unsupported Mail padding format");
  }
  const logicalLength = dataView(value).getUint32(1, false);
  if (logicalLength > value.byteLength - 5) {
    throw new MailProtocolError("INVALID_PADDING", "Mail padding length is invalid");
  }
  return value.slice(5, 5 + logicalLength);
}

export function principalBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength < 1 || value.byteLength > 29) {
      throw new MailProtocolError("INVALID_PRINCIPAL", "Principal bytes are invalid");
    }
    return value.slice();
  }
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new MailProtocolError("INVALID_PRINCIPAL", "Principal text is invalid");
  }
  try {
    const principal = Principal.fromText(value);
    if (principal.toText() !== value) {
      throw new Error("Principal text is not canonical");
    }
    const bytes = principal.toUint8Array();
    if (bytes.byteLength < 1 || bytes.byteLength > 29) {
      throw new Error("Principal byte length is invalid");
    }
    return bytes.slice();
  } catch {
    throw new MailProtocolError("INVALID_PRINCIPAL", "Principal text is invalid");
  }
}

function normalizeEnvelope(input: MailEnvelopeV1): MailEnvelopeV1 {
  if (!input || typeof input !== "object") {
    throw new MailProtocolError("INVALID_ENVELOPE", "Mail envelope is invalid");
  }
  if (input.version !== MAIL_PROTOCOL_VERSION) {
    throw new MailProtocolError("INVALID_VERSION", "Unsupported Mail protocol version");
  }
  if (input.suite !== MAIL_CIPHER_SUITE) {
    throw new MailProtocolError("INVALID_SUITE", "Unsupported Mail cipher suite");
  }
  assertEpoch(input.deliveryKeyEpoch);
  const recipientKeyFingerprint = validateFingerprint(input.recipientKeyFingerprint);
  const messageId = validateMessageId(input.messageId);
  const recipientWrappedCek = validateNonzeroFixedBytes(
    input.recipientWrappedCek,
    MAIL_LIMITS.wrappedCekBytes,
    "Recipient CEK wrap",
  );
  const headerNonce = validateFixedBytes(
    input.headerNonce,
    MAIL_LIMITS.nonceBytes,
    "Header nonce",
  );
  const headerCiphertextAndTag = validateFixedBytes(
    input.headerCiphertextAndTag,
    MAIL_HEADER_CIPHERTEXT_BYTES,
    "Header ciphertext",
  );
  const bodyNonce = validateFixedBytes(
    input.bodyNonce,
    MAIL_LIMITS.nonceBytes,
    "Body nonce",
  );
  if (
    !(input.bodyCiphertextAndTag instanceof Uint8Array) ||
    !MAIL_BODY_CIPHERTEXT_BUCKETS.includes(input.bodyCiphertextAndTag.byteLength)
  ) {
    throw new MailProtocolError(
      "INVALID_LENGTH",
      "Body ciphertext has a noncanonical size",
    );
  }
  assertDistinctNonces(headerNonce, bodyNonce);
  return {
    version: MAIL_PROTOCOL_VERSION,
    suite: MAIL_CIPHER_SUITE,
    deliveryKeyEpoch: input.deliveryKeyEpoch,
    recipientKeyFingerprint,
    messageId,
    recipientWrappedCek,
    headerNonce,
    headerCiphertextAndTag,
    bodyNonce,
    bodyCiphertextAndTag: input.bodyCiphertextAndTag.slice(),
  };
}

function assertEpoch(value: bigint): void {
  if (typeof value !== "bigint" || value < 1n || value > (1n << 64n) - 1n) {
    throw new MailProtocolError("INVALID_EPOCH", "Mail key epoch is out of range");
  }
}

function assertDistinctNonces(left: Uint8Array, right: Uint8Array): void {
  if (left.every((value, index) => value === right[index])) {
    throw new MailProtocolError(
      "INVALID_NONCE",
      "Header and body nonces must be distinct",
    );
  }
}

function boundedPublicBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 4096) {
    throw new MailProtocolError("INVALID_LENGTH", `${label} has an invalid length`);
  }
  return value.slice();
}

function checkedPayload(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new MailProtocolError("INVALID_PADDING", "Mail payload must be bytes");
  }
  return value;
}

function secureRandomFill(target: Uint8Array): void {
  globalThis.crypto.getRandomValues(target as Uint8Array<ArrayBuffer>);
}

function lengthPrefix(value: Uint8Array): Uint8Array {
  if (value.byteLength > 0xffff_ffff) {
    throw new MailProtocolError("INVALID_LENGTH", "Length-prefixed value is too large");
  }
  return concatBytes(u32be(value.byteLength), value);
}

function u16be(value: number): Uint8Array {
  const output = new Uint8Array(2);
  dataView(output).setUint16(0, value, false);
  return output;
}

function u32be(value: number): Uint8Array {
  const output = new Uint8Array(4);
  dataView(output).setUint32(0, value, false);
  return output;
}

function u64be(value: bigint): Uint8Array {
  const output = new Uint8Array(8);
  dataView(output).setBigUint64(0, value, false);
  return output;
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const value of values) {
    output.set(value, cursor);
    cursor += value.byteLength;
  }
  return output;
}

function readBytes(value: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset < 0 || length < 0 || offset + length > value.byteLength) {
    throw new MailProtocolError("INVALID_LENGTH", "Mail envelope ended early");
  }
  return value.slice(offset, offset + length);
}

function writeBytes(target: Uint8Array, offset: number, value: Uint8Array): number {
  if (offset < 0 || offset + value.byteLength > target.byteLength) {
    throw new MailProtocolError("INVALID_LENGTH", "Mail envelope is too large");
  }
  target.set(value, offset);
  return offset + value.byteLength;
}

function dataView(value: Uint8Array): DataView {
  return new DataView(value.buffer, value.byteOffset, value.byteLength);
}
