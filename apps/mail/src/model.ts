export const MAIL_PROTOCOL_VERSION = 1 as const;
export const MAIL_CIPHER_SUITE = 1 as const;

export const MAIL_LIMITS = Object.freeze({
  claimedSenderNameScalars: 80,
  claimedSenderNameBytes: 256,
  subjectScalars: 160,
  subjectBytes: 512,
  bodyBytes: 32 * 1024,
  messageIdBytes: 16,
  fingerprintBytes: 32,
  nonceBytes: 12,
  wrappedCekBytes: 168,
  pageSize: 50,
  markDeleteBatch: 100,
  unknownPerHour: 10,
});

export type MailFolder = "inbox" | "sent" | "outbox";
export type MailTrust = "in_contacts" | "not_in_contacts" | "contact_conflict";
export type MailDeliveryStatus =
  | "sending"
  | "accepted"
  | "not_sent"
  | "delivery_uncertain";
export type MailLockState = "not_configured" | "locked" | "unlocked";
export type MailPrivateAvailability =
  | "not_configured"
  | "preparing"
  | "ready"
  | "unavailable";

export type MailPrivateHeader = {
  contentSchema: 1;
  claimedSenderName: string;
  subject: string;
  senderCreatedAtNs: string;
  inReplyTo: Uint8Array | null;
};

export type MailPrivateBody = {
  contentSchema: 1;
  bodyMarkdown: string;
};

export type MailRecipientBinding =
  | {
      kind: "direct";
      principal: string;
    }
  | {
      kind: "contact";
      principal: string;
      contactId: string;
      contactRevision: string;
    };

export type MailHelpTopic =
  | "overview"
  | "privacy"
  | "compose"
  | "markdown"
  | "trust"
  | "limits"
  | "agents"
  | "errors";

export type MailValidationCode =
  | "INVALID_TYPE"
  | "INVALID_SCALAR"
  | "INVALID_CONTROL"
  | "INVALID_LENGTH"
  | "INVALID_BYTES"
  | "INVALID_DECIMAL";

export class MailValidationError extends Error {
  constructor(
    public readonly code: MailValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "MailValidationError";
  }
}

const utf8 = new TextEncoder();

export function validateClaimedSenderName(value: unknown): string {
  return validateSingleLine(value, "Sender name", {
    maxScalars: MAIL_LIMITS.claimedSenderNameScalars,
    maxBytes: MAIL_LIMITS.claimedSenderNameBytes,
  });
}

export function validateSubject(value: unknown): string {
  return validateSingleLine(value, "Subject", {
    maxScalars: MAIL_LIMITS.subjectScalars,
    maxBytes: MAIL_LIMITS.subjectBytes,
  });
}

export function validateBodyMarkdown(value: unknown): string {
  if (typeof value !== "string") {
    throw new MailValidationError("INVALID_TYPE", "Message body must be text");
  }
  assertUnicodeScalars(value, "Message body");
  for (const character of value) {
    const scalar = character.codePointAt(0)!;
    if (
      scalar === 0 ||
      (scalar < 0x20 && scalar !== 0x09 && scalar !== 0x0a && scalar !== 0x0d) ||
      (scalar >= 0x7f && scalar <= 0x9f)
    ) {
      throw new MailValidationError(
        "INVALID_CONTROL",
        "Message body contains unsupported control characters",
      );
    }
  }
  if (utf8.encode(value).byteLength > MAIL_LIMITS.bodyBytes) {
    throw new MailValidationError(
      "INVALID_LENGTH",
      "Message body is larger than 32 KiB",
    );
  }
  return value;
}

export function validateMessageId(value: unknown): Uint8Array {
  return validateNonzeroFixedBytes(value, MAIL_LIMITS.messageIdBytes, "Message id");
}

export function validateFingerprint(value: unknown): Uint8Array {
  return validateNonzeroFixedBytes(value, MAIL_LIMITS.fingerprintBytes, "Key fingerprint");
}

export function validateNonzeroFixedBytes(
  value: unknown,
  length: number,
  label: string,
): Uint8Array {
  const validated = validateFixedBytes(value, length, label);
  if (validated.every((byte) => byte === 0)) {
    throw new MailValidationError("INVALID_BYTES", `${label} cannot be all zero`);
  }
  return validated;
}

export function validateFixedBytes(
  value: unknown,
  length: number,
  label: string,
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new MailValidationError("INVALID_BYTES", `${label} must be bytes`);
  }
  if (value.byteLength !== length) {
    throw new MailValidationError(
      "INVALID_LENGTH",
      `${label} must contain exactly ${length} bytes`,
    );
  }
  return value.slice();
}

export function validateUnsignedDecimal(
  value: unknown,
  label: string,
  maximum = (1n << 64n) - 1n,
): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new MailValidationError(
      "INVALID_DECIMAL",
      `${label} must be an unsigned decimal string`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > maximum) {
    throw new MailValidationError("INVALID_LENGTH", `${label} is out of range`);
  }
  return value;
}

export function utf8ByteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

export function unicodeScalarCount(value: string): number {
  assertUnicodeScalars(value, "Text");
  return [...value].length;
}

function validateSingleLine(
  value: unknown,
  label: string,
  limits: { maxScalars: number; maxBytes: number },
): string {
  if (typeof value !== "string") {
    throw new MailValidationError("INVALID_TYPE", `${label} must be text`);
  }
  assertUnicodeScalars(value, label);
  const scalarCount = [...value].length;
  const byteCount = utf8.encode(value).byteLength;
  if (
    scalarCount < 1 ||
    scalarCount > limits.maxScalars ||
    byteCount > limits.maxBytes ||
    value.trim().length === 0
  ) {
    throw new MailValidationError(
      "INVALID_LENGTH",
      `${label} is empty or exceeds its character or byte limit`,
    );
  }
  for (const character of value) {
    const scalar = character.codePointAt(0)!;
    if (isControl(scalar) || isDefaultIgnorable(scalar)) {
      throw new MailValidationError(
        "INVALID_CONTROL",
        `${label} contains unsupported formatting or control characters`,
      );
    }
  }
  return value;
}

function assertUnicodeScalars(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new MailValidationError(
          "INVALID_SCALAR",
          `${label} contains an invalid Unicode scalar`,
        );
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new MailValidationError(
        "INVALID_SCALAR",
        `${label} contains an invalid Unicode scalar`,
      );
    }
  }
}

function isControl(scalar: number): boolean {
  return (
    scalar <= 0x1f ||
    (scalar >= 0x7f && scalar <= 0x9f) ||
    scalar === 0x2028 ||
    scalar === 0x2029
  );
}

// Unicode Default_Ignorable_Code_Point ranges that can obscure short identity
// and subject fields. Variation selectors are included intentionally: these
// fields favor an unambiguous rendering over emoji presentation variants.
function isDefaultIgnorable(scalar: number): boolean {
  return (
    scalar === 0x00ad ||
    scalar === 0x034f ||
    scalar === 0x061c ||
    (scalar >= 0x115f && scalar <= 0x1160) ||
    (scalar >= 0x17b4 && scalar <= 0x17b5) ||
    (scalar >= 0x180b && scalar <= 0x180f) ||
    (scalar >= 0x200b && scalar <= 0x200f) ||
    (scalar >= 0x202a && scalar <= 0x202e) ||
    (scalar >= 0x2060 && scalar <= 0x206f) ||
    scalar === 0x3164 ||
    (scalar >= 0xfe00 && scalar <= 0xfe0f) ||
    scalar === 0xfeff ||
    scalar === 0xffa0 ||
    (scalar >= 0x1bca0 && scalar <= 0x1bca3) ||
    (scalar >= 0x1d173 && scalar <= 0x1d17a) ||
    (scalar >= 0xe0000 && scalar <= 0xe0fff)
  );
}
