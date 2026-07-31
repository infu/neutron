import {
  isJsonObject,
  querySelf,
  updateSelf,
  type JsonObject,
  type SelfCallObject,
} from "neutron-tools/app";
import { Principal } from "@dfinity/principal";
import type { MailDeliveryStatus, MailFolder } from "./model.ts";
import {
  MAIL_BODY_CIPHERTEXT_BUCKETS,
  MAIL_HEADER_CIPHERTEXT_BYTES,
  MAIL_MAX_ENVELOPE_BYTES,
  computeMailKeyFingerprint,
  decodeMailEnvelopeV1,
} from "./protocol.ts";

const MAIL_U64_MAX = (1n << 64n) - 1n;
const MAIL_SIGNED_TIMESTAMP_MAX = (1n << 63n) - 1n;
const MAIL_PREPARE_REQUEST_ID_BYTES = 16;
const MAIL_PERMIT_ID_BYTES = 32;
const MAIL_COMMAND_ID_BYTES = 16;
const MAIL_PUBLIC_INFO_HASH_BYTES = 32;
const MAIL_RETRY_REQUEST_ID_BYTES = 16;
const MAIL_SETTINGS_RECORD_ID_BYTES = 16;
const MAIL_LOCAL_WRAP_MAX_BYTES = 4_096;
const MAIL_SETTINGS_CIPHERTEXT_MIN_BYTES = 16;
const MAIL_SETTINGS_CIPHERTEXT_MAX_BYTES = 4_096;

export type MailStorageLevel = "normal" | "approaching_limit" | "almost_full";

export type MailBackendStatus = {
  revision: string;
  contactsRevision: string;
  cleanupEpoch: string;
  privateMailActive: boolean;
  keyHolder: string | null;
  currentEpoch: string | null;
  previousEpoch: string | null;
  encryptedSettingsRevision: string | null;
  unread: string;
  inboxCount: string;
  inboxBytes: string;
  unknownInboxCount: string;
  unknownInboxBytes: string;
  sentCount: string;
  outboxCount: string;
  activeSends: string;
  sentAndOutboxBytes: string;
  storageLevel: MailStorageLevel;
};

export type MailBackendPulse = {
  revision: string;
  contactsRevision: string;
  cleanupEpoch: string;
  inboxCount: string;
  unread: string;
};

export type MailBackendCryptoProgress = {
  revision: string;
  keyHolder: string;
  currentEpoch: string;
  previousEpoch: string | null;
  previousReferences: {
    settings: string;
    inbox: string;
    outbox: string;
    total: string;
  };
  readyToRetire: boolean;
};

export type MailCryptoRewrapTarget =
  | {
      kind: "settings";
      expectedRevision: string;
      expectedLocalWrappedCek: Uint8Array;
      replacementLocalWrappedCek: Uint8Array;
    }
  | {
      kind: "inbox" | "outbox";
      localId: string;
      expectedLocalWrappedCek: Uint8Array;
      replacementLocalWrappedCek: Uint8Array;
    };

export type MailCryptoRewrapRequest = {
  expectedCurrentEpoch: string;
  expectedPreviousEpoch: string;
  targets: MailCryptoRewrapTarget[];
};

export type MailBackendCryptoRewrapResult = {
  changed: string;
  messageWrapsChanged: string;
  settingsWrapChanged: boolean;
  progress: MailBackendCryptoProgress;
};

export type MailBackendCryptoErrorCode =
  | "invalid_request"
  | "not_configured"
  | "already_configured"
  | "not_reserved"
  | "disabled"
  | "manifest_suspended"
  | "generation_unavailable"
  | "key_holder_changed"
  | "rotation_in_progress"
  | "rotation_not_ready"
  | "capability_changed"
  | "vetkeys_unavailable"
  | "previous_references"
  | "revision_conflict"
  | "corrupt_state";

export class MailBackendCryptoError extends Error {
  constructor(
    public readonly code: MailBackendCryptoErrorCode,
    message: string,
    public readonly retryAfterSeconds?: string,
  ) {
    super(message);
    this.name = "MailBackendCryptoError";
  }
}

export type MailBackendRecipient = {
  contactId: string;
  contactRevision: string;
  contactName: string;
  principal: string;
};

export type MailBackendRecipientsPage = {
  bookRevision: string;
  recipients: MailBackendRecipient[];
  total: string;
  nextOffset: string | null;
};

export type MailRecipientsRequest = {
  searchText?: string;
  offset?: string;
  limit: number;
};

export type MailBackendStatusErrorCode =
  | "BACKEND_UNAVAILABLE"
  | "INVALID_RESPONSE";

export class MailBackendStatusError extends Error {
  constructor(
    public readonly code: MailBackendStatusErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MailBackendStatusError";
  }
}

export type MailBackendCurrentContact =
  | {
      status: "in_contacts";
      contactId: string;
      contactRevision: string;
      contactName: string;
    }
  | { status: "not_in_contacts" }
  | { status: "contact_conflict" };

export type MailBackendInboxItem = {
  kind: "inbox";
  localId: string;
  sender: string;
  receivedAtNs: string;
  read: boolean;
  knownAtReceipt: boolean;
  currentContact: MailBackendCurrentContact;
  retainedBytes: string;
};

export type MailBackendOutboxState = {
  status: MailDeliveryStatus;
  acceptedAtNs?: string;
  notSentReason?:
    | "invalid"
    | "rate_limited"
    | "mailbox_full"
    | "stale_key"
    | "crypto_unavailable"
    | "permission_required";
};

export type MailBackendOutboxItem = {
  kind: "sent" | "outbox";
  localId: string;
  recipient: string;
  contactId: string | null;
  contactRevision: string | null;
  currentContact: MailBackendCurrentContact;
  createdAtNs: string;
  updatedAtNs: string;
  cleanupEpoch: string;
  attemptNo: string;
  state: MailBackendOutboxState;
  retainedBytes: string;
};

export type MailBackendListItem = MailBackendInboxItem | MailBackendOutboxItem;

export type MailBackendListPage = {
  revision: string;
  contactsRevision: string;
  cleanupEpoch: string;
  items: MailBackendListItem[];
  total: string;
  nextOffset: string | null;
  ciphertextBytes: string;
};

export type MailListRequest = {
  folder: MailFolder;
  unreadOnly?: boolean;
  offset?: string;
  limit: number;
  expectedRevision?: string | null;
  expectedContactsRevision?: string | null;
};

export type MailBackendExactRecord =
  | (MailBackendInboxItem & { kind: "inbox" })
  | (Omit<MailBackendOutboxItem, "kind"> & { kind: "sent" | "outbox" });

export type MailBackendGetResult = {
  revision: string;
  contactsRevision: string;
  cleanupEpoch: string;
  record: MailBackendExactRecord;
};

export type MailBackendMutationResult = {
  revision: string;
  cleanupEpoch: string;
  changed: string;
  inboxDeleted: string;
  outboxDeleted: string;
  unreadDeleted: string;
  retainedBytesDeleted: string;
  unreadRemaining: string;
};

export type MailBackendCleanupScope =
  | "read_inbox"
  | "unknown_senders"
  | "all_mail";

export type MailBackendCleanupCounts = {
  total: string;
  unread: string;
  inbox: string;
  sent: string;
  outbox: string;
  activeSends: string;
  retainedBytes: string;
};

export type MailBackendCleanupPreview = {
  scope: MailBackendCleanupScope;
  revision: string;
  contactsRevision: string;
  cleanupEpoch: string;
  counts: MailBackendCleanupCounts;
  previewToken: string;
};

export class MailBackendMailboxError extends Error {
  constructor(
    public readonly code:
      | "BACKEND_UNAVAILABLE"
      | "INVALID_RESPONSE"
      | "INVALID_REQUEST"
      | "NOT_FOUND"
      | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "MailBackendMailboxError";
  }
}

/**
 * Ciphertext-bearing values are intentionally separate from the locked list
 * and exact-record projections above. They are for the resident browser
 * decryption boundary only and must never be returned by agent tools.
 */
export type MailBackendEncryptedHeader = {
  messageId: Uint8Array;
  deliveryKeyEpoch: string;
  deliveryKeyFingerprint: Uint8Array;
  localWrapEpoch: string;
  localWrapFingerprint: Uint8Array;
  localWrappedCek: Uint8Array;
  headerNonce: Uint8Array;
  headerCiphertextAndTag: Uint8Array;
};

export type MailBackendEncryptedContent = {
  header: MailBackendEncryptedHeader;
  bodyNonce: Uint8Array;
  bodyCiphertextAndTag: Uint8Array;
};

export type MailBackendEncryptedInboxItem = MailBackendInboxItem & {
  encryptedHeader: MailBackendEncryptedHeader;
};

export type MailBackendEncryptedOutboxItem = MailBackendOutboxItem & {
  encryptedHeader: MailBackendEncryptedHeader;
};

export type MailBackendEncryptedListItem =
  | MailBackendEncryptedInboxItem
  | MailBackendEncryptedOutboxItem;

export type MailBackendEncryptedListPage = Omit<MailBackendListPage, "items"> & {
  items: MailBackendEncryptedListItem[];
};

export type MailBackendEncryptedInboxRecord = MailBackendInboxItem & {
  encrypted: MailBackendEncryptedContent;
};

export type MailBackendEncryptedOutboxRecord = MailBackendOutboxItem & {
  commandId: Uint8Array;
  attemptRequestId: Uint8Array | null;
  encrypted: MailBackendEncryptedContent;
};

export type MailBackendEncryptedExactRecord =
  | MailBackendEncryptedInboxRecord
  | MailBackendEncryptedOutboxRecord;

export type MailBackendEncryptedGetResult = Omit<MailBackendGetResult, "record"> & {
  record: MailBackendEncryptedExactRecord;
};

export type MailBackendKeyInfo = {
  protocolVersion: 1;
  suite: 1;
  deliveryKeyEpoch: string;
  contextPublicKey: Uint8Array;
  effectiveIbeIdentity: Uint8Array;
  recipientKeyFingerprint: Uint8Array;
  maxEnvelopeBytes: typeof MAIL_MAX_ENVELOPE_BYTES;
};

export type MailPrepareRecipientRequest = {
  recipient:
    | { kind: "direct"; principal: string }
    | {
        kind: "contact";
        principal: string;
        contactId: string;
        expectedContactRevision: string;
      };
  permitRequestId: Uint8Array;
};

export type MailBackendPreparedRecipient = {
  permitId: Uint8Array;
  recipient: string;
  contactId: string | null;
  contactRevision: string | null;
  bookRevision: string;
  expiresAtNs: string;
  publicInfoHash: Uint8Array;
  keyInfo: MailBackendKeyInfo;
};

export type MailSendEncryptedRequest = {
  commandId: Uint8Array;
  permitId: Uint8Array;
  recipient: string;
  publicInfoHash: Uint8Array;
  envelope: Uint8Array;
  localWrapEpoch: string;
  localWrapFingerprint: Uint8Array;
  localWrappedCek: Uint8Array;
};

export type MailRetryRequest = {
  localId: string;
  retryRequestId: Uint8Array;
};

export type MailBackendDeliveryView = {
  localId: string;
  revision: string;
  cleanupEpoch: string;
  attemptNo: string;
  state: MailBackendOutboxState;
  updatedAtNs: string;
};

export type MailBackendEncryptedSettings = {
  recordId: Uint8Array;
  revision: string;
  localWrapEpoch: string;
  localWrapFingerprint: Uint8Array;
  localWrappedCek: Uint8Array;
  nonce: Uint8Array;
  ciphertextAndTag: Uint8Array;
};

export type MailEncryptedSettingsMutation =
  | { kind: "create"; settings: MailBackendEncryptedSettings }
  | {
      kind: "replace";
      expectedRevision: string;
      settings: MailBackendEncryptedSettings;
    }
  | {
      kind: "rewrap";
      expectedRevision: string;
      localWrapEpoch: string;
      localWrapFingerprint: Uint8Array;
      localWrappedCek: Uint8Array;
    };

export type MailBackendPrivateErrorCode =
  | "BACKEND_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "PERMISSION_REQUIRED"
  | "RECIPIENT_UNAVAILABLE"
  | "RECIPIENT_CHANGED"
  | "PERMIT_CAPACITY"
  | "PERMIT_REQUEST_REUSED"
  | "PERMIT_MISSING"
  | "PERMIT_EXPIRED"
  | "PERMIT_MISMATCH"
  | "MAILBOX_FULL"
  | "CRYPTO_UNAVAILABLE"
  | "COMMAND_CONFLICT"
  | "COMMAND_DELETED"
  | "NOT_FOUND"
  | "NOT_RETRYABLE"
  | "RETRY_DELETED"
  | "ATTEMPT_SUPERSEDED"
  | "NOT_CONFIGURED"
  | "REVISION_CONFLICT";

export class MailBackendPrivateError extends Error {
  constructor(
    public readonly code: MailBackendPrivateErrorCode,
    message: string,
    public readonly localId: string | null = null,
  ) {
    super(message);
    this.name = "MailBackendPrivateError";
  }
}

export async function getMailRecipients(
  request: MailRecipientsRequest,
): Promise<MailBackendRecipientsPage> {
  const encoded = encodeMailRecipientsRequest(request);
  const offset = encoded.offset as string;
  const requestedLimit = request.limit;
  let response: unknown;
  try {
    response = await querySelf("mail_recipients", [encoded]);
  } catch {
    throw mailboxUnavailable("Mail recipients are temporarily unavailable");
  }
  return parseMailRecipientsPage(response, requestedLimit, offset);
}

export function encodeMailRecipientsRequest(
  request: MailRecipientsRequest,
): JsonObject {
  const searchText = request.searchText ?? "";
  if (
    typeof searchText !== "string" ||
    [...searchText].length > 120 ||
    hasUnsafeSingleLineControls(searchText)
  ) {
    throw mailboxInvalidRequest(
      "Recipient search must be at most 120 characters without control characters",
    );
  }
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
    throw mailboxInvalidRequest("Recipient search limit must be from 1 to 50");
  }
  const offset = natural(request.offset ?? "0", "Recipient search offset");
  if (BigInt(offset) > 2_000n) {
    throw mailboxInvalidRequest("Recipient search offset must not exceed 2000");
  }
  return {
    search_text: searchText,
    offset,
    // icblast's JSON boundary represents every Candid Nat as a decimal
    // string. Keeping this one as a JavaScript number passed unit parsers but
    // was rejected by the live kernel method schema.
    limit: request.limit.toString(),
  };
}

export function parseMailRecipientsPage(
  response: unknown,
  requestedLimit = 50,
  requestedOffset: string = "0",
): MailBackendRecipientsPage {
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    throw mailboxInvalidRequest("Recipient search limit must be from 1 to 50");
  }
  const offset = natural(requestedOffset, "Recipient search offset");
  if (BigInt(offset) > 2_000n) {
    throw mailboxInvalidRequest("Recipient search offset must not exceed 2000");
  }
  const value = mailboxObject(response, "Mail recipients");
  assertMailboxKeys(
    value,
    ["book_revision", "contacts", "total"],
    ["next_offset"],
    "Mail recipients",
  );
  if (!Array.isArray(value.contacts) || value.contacts.length > requestedLimit) {
    throw mailboxInvalid("Mail recipients");
  }
  const recipients = value.contacts.map((candidate) => {
    const contact = mailboxObject(candidate, "Mail recipient");
    assertMailboxKeys(
      contact,
      ["contact_id", "contact_revision", "contact_name", "principal"],
      [],
      "Mail recipient",
    );
    const contactName = boundedContactName(contact.contact_name);
    return {
      contactId: positiveNatural(contact.contact_id, "Mail contact id"),
      contactRevision: positiveNatural(
        contact.contact_revision,
        "Mail contact revision",
      ),
      contactName,
      principal: mailboxCanisterPrincipal(contact.principal, "Mail recipient principal"),
    };
  });
  const ids = new Set(recipients.map(({ contactId }) => contactId));
  const principals = new Set(recipients.map(({ principal: value }) => value));
  if (ids.size !== recipients.length || principals.size !== recipients.length) {
    throw mailboxInvalid("Mail recipients");
  }

  const total = natural(value.total, "Mail recipient total");
  if (BigInt(total) > 2_000n) throw mailboxInvalid("Mail recipient total");
  const nextOffset = optionalNatural(
    value.next_offset,
    "Mail recipient next offset",
  );
  if (nextOffset !== null && BigInt(nextOffset) > BigInt(total)) {
    throw mailboxInvalid("Mail recipient next offset");
  }
  const expectedCount = BigInt(offset) >= BigInt(total)
    ? 0
    : Math.min(requestedLimit, Number(BigInt(total) - BigInt(offset)));
  const end = BigInt(offset) + BigInt(recipients.length);
  const expectedNext = end < BigInt(total) ? end.toString() : null;
  if (recipients.length !== expectedCount || nextOffset !== expectedNext) {
    throw mailboxInvalid("Mail recipient page");
  }
  return {
    bookRevision: natural(value.book_revision, "Contacts book revision"),
    recipients,
    total,
    nextOffset,
  };
}

export async function prepareMailRecipient(
  request: MailPrepareRecipientRequest,
): Promise<MailBackendPreparedRecipient> {
  const encoded = encodeMailPrepareRecipientRequest(request);
  let response: unknown;
  try {
    response = await updateSelf("mail_prepare_recipient", [encoded]);
  } catch (error) {
    throw deliveryThrownError(error, "Mail recipient preparation");
  }
  return parseMailPreparedRecipient(response, request);
}

export function encodeMailPrepareRecipientRequest(
  request: MailPrepareRecipientRequest,
): SelfCallObject {
  const value = privateRequestObject(request, "Mail recipient preparation");
  assertPrivateKeys(
    value,
    ["recipient", "permitRequestId"],
    [],
    "Mail recipient preparation",
  );
  const recipient = privateRequestObject(value.recipient, "Mail recipient");
  const kind = recipient.kind;
  let encodedRecipient: SelfCallObject;
  if (kind === "direct") {
    assertPrivateKeys(recipient, ["kind", "principal"], [], "Mail recipient");
    encodedRecipient = {
      direct: { principal: canonicalCanisterPrincipal(recipient.principal, "Mail recipient") },
    };
  } else if (kind === "contact") {
    assertPrivateKeys(
      recipient,
      ["kind", "principal", "contactId", "expectedContactRevision"],
      [],
      "Mail recipient",
    );
    encodedRecipient = {
      contact: {
        principal: canonicalCanisterPrincipal(recipient.principal, "Mail recipient"),
        contact_id: privatePositiveNatural(recipient.contactId, "Mail contact id"),
        expected_contact_revision: privatePositiveNatural(
          recipient.expectedContactRevision,
          "Mail contact revision",
        ),
      },
    };
  } else {
    throw privateInvalidRequest("Mail recipient kind is invalid");
  }
  return {
    recipient: encodedRecipient,
    permit_request_id: encodePrivateBytes(
      value.permitRequestId,
      "Mail permit request id",
      { exact: MAIL_PREPARE_REQUEST_ID_BYTES, nonzero: true },
    ),
  };
}

export function parseMailPreparedRecipient(
  response: unknown,
  expected?: MailPrepareRecipientRequest,
): MailBackendPreparedRecipient {
  const value = privateResponseObject(response, "Mail recipient preparation");
  assertPrivateResponseKeys(
    value,
    [
      "permit_id",
      "recipient",
      "book_revision",
      "expires_at_ns",
      "public_info_hash",
      "key_info",
    ],
    ["contact_id", "contact_revision"],
    "Mail prepared recipient",
  );
  const contactId = privateOptionalNatural(value.contact_id, "Mail contact id");
  const contactRevision = privateOptionalNatural(
    value.contact_revision,
    "Mail contact revision",
  );
  const bookRevision = privateNatural(value.book_revision, "Contacts book revision");
  if (
    (contactId === null) !== (contactRevision === null) ||
    (contactId === null && bookRevision !== "0") ||
    (contactId !== null &&
      (contactId === "0" || contactRevision === "0" || bookRevision === "0"))
  ) {
    throw privateInvalidResponse("Mail prepared recipient binding");
  }
  const prepared: MailBackendPreparedRecipient = {
    permitId: parsePrivateBytes(value.permit_id, "Mail permit id", {
      exact: MAIL_PERMIT_ID_BYTES,
      nonzero: true,
    }),
    recipient: canonicalCanisterPrincipalResponse(value.recipient, "Mail recipient"),
    contactId,
    contactRevision,
    bookRevision,
    expiresAtNs: privateTimestamp(value.expires_at_ns, "Mail permit expiry"),
    publicInfoHash: parsePrivateBytes(value.public_info_hash, "Mail public-info hash", {
      exact: MAIL_PUBLIC_INFO_HASH_BYTES,
      nonzero: true,
    }),
    keyInfo: parseMailBackendKeyInfo(value.key_info),
  };
  if (expected !== undefined) {
    // Re-run the closed request validator before comparing so an untyped caller
    // cannot smuggle an alternate binding into this post-await check.
    encodeMailPrepareRecipientRequest(expected);
    const binding = expected.recipient;
    if (
      prepared.recipient !== binding.principal ||
      (binding.kind === "direct" &&
        (prepared.contactId !== null || prepared.contactRevision !== null ||
          prepared.bookRevision !== "0")) ||
      (binding.kind === "contact" &&
        (prepared.contactId !== binding.contactId ||
          prepared.contactRevision !== binding.expectedContactRevision ||
          prepared.bookRevision === "0"))
    ) {
      throw privateInvalidResponse("Mail prepared recipient binding");
    }
  }
  return prepared;
}

export async function sendEncryptedMail(
  request: MailSendEncryptedRequest,
): Promise<MailBackendDeliveryView> {
  const encoded = encodeMailSendEncryptedRequest(request);
  let response: unknown;
  try {
    response = await updateSelf("mail_send_encrypted", [encoded]);
  } catch (error) {
    throw deliveryThrownError(error, "Mail send");
  }
  // Exact command replay intentionally returns the current Outbox record. It
  // may therefore be on a later retry attempt even though this is the original
  // send command being replayed after a lost response.
  return parseMailDeliveryView(response);
}

export function encodeMailSendEncryptedRequest(
  request: MailSendEncryptedRequest,
): SelfCallObject {
  const value = privateRequestObject(request, "Encrypted Mail send");
  assertPrivateKeys(
    value,
    [
      "commandId",
      "permitId",
      "recipient",
      "publicInfoHash",
      "envelope",
      "localWrapEpoch",
      "localWrapFingerprint",
      "localWrappedCek",
    ],
    [],
    "Encrypted Mail send",
  );
  const envelope = privateInputBytes(value.envelope, "Mail envelope");
  try {
    decodeMailEnvelopeV1(envelope);
  } catch {
    throw privateInvalidRequest("Mail envelope is invalid");
  }
  return {
    command_id: encodePrivateBytes(value.commandId, "Mail command id", {
      exact: MAIL_COMMAND_ID_BYTES,
      nonzero: true,
    }),
    permit_id: encodePrivateBytes(value.permitId, "Mail permit id", {
      exact: MAIL_PERMIT_ID_BYTES,
      nonzero: true,
    }),
    recipient: canonicalCanisterPrincipal(value.recipient, "Mail recipient"),
    public_info_hash: encodePrivateBytes(value.publicInfoHash, "Mail public-info hash", {
      exact: MAIL_PUBLIC_INFO_HASH_BYTES,
      nonzero: true,
    }),
    envelope,
    local_wrap_epoch: privatePositiveU64(value.localWrapEpoch, "Mail local wrap epoch"),
    local_wrap_fingerprint: encodePrivateBytes(
      value.localWrapFingerprint,
      "Mail local wrap fingerprint",
      { exact: 32, nonzero: true },
    ),
    local_wrapped_cek: encodePrivateBytes(
      value.localWrappedCek,
      "Mail local wrapped key",
      { exact: 168, nonzero: true },
    ),
  };
}

export async function retryEncryptedMail(
  request: MailRetryRequest,
): Promise<MailBackendDeliveryView> {
  const encoded = encodeMailRetryRequest(request);
  let response: unknown;
  try {
    response = await updateSelf("mail_retry", [encoded]);
  } catch (error) {
    throw deliveryThrownError(error, "Mail retry");
  }
  return parseMailDeliveryView(response, request.localId);
}

export function encodeMailRetryRequest(request: MailRetryRequest): SelfCallObject {
  const value = privateRequestObject(request, "Mail retry");
  assertPrivateKeys(value, ["localId", "retryRequestId"], [], "Mail retry");
  return {
    local_id: privatePositiveNatural(value.localId, "Mail local id"),
    retry_request_id: encodePrivateBytes(
      value.retryRequestId,
      "Mail retry request id",
      { exact: MAIL_RETRY_REQUEST_ID_BYTES, nonzero: true },
    ),
  };
}

export function parseMailDeliveryView(
  response: unknown,
  expectedLocalId?: string,
): MailBackendDeliveryView {
  const value = privateResponseObject(response, "Mail delivery");
  assertPrivateResponseKeys(
    value,
    [
      "local_id",
      "mail_revision",
      "cleanup_epoch",
      "attempt_no",
      "state",
      "updated_at_ns",
    ],
    [],
    "Mail delivery",
  );
  const result: MailBackendDeliveryView = {
    localId: privatePositiveNaturalResponse(value.local_id, "Mail local id"),
    revision: privateNatural(value.mail_revision, "Mail revision"),
    cleanupEpoch: privateNatural(value.cleanup_epoch, "Mail cleanup epoch"),
    attemptNo: privatePositiveNaturalResponse(value.attempt_no, "Mail attempt number"),
    state: parsePrivateDeliveryState(value.state),
    updatedAtNs: privateTimestamp(value.updated_at_ns, "Mail delivery update time"),
  };
  if (expectedLocalId !== undefined) {
    const expected = privatePositiveNatural(expectedLocalId, "Mail local id");
    if (result.localId !== expected) throw privateInvalidResponse("Mail retry local id");
  }
  return result;
}

export async function getMailEncryptedSettings(): Promise<MailBackendEncryptedSettings | null> {
  let response: unknown;
  try {
    response = await querySelf("mail_settings_encrypted", [null]);
  } catch (error) {
    throw settingsThrownError(error, "Encrypted Mail settings");
  }
  return parseMailEncryptedSettingsResult(response);
}

export function parseMailEncryptedSettingsResult(
  response: unknown,
): MailBackendEncryptedSettings | null {
  return response === null ? null : parseMailEncryptedSettings(response);
}

export async function setMailEncryptedSettings(
  mutation: MailEncryptedSettingsMutation,
): Promise<MailBackendEncryptedSettings> {
  const encoded = encodeMailEncryptedSettingsMutation(mutation);
  let response: unknown;
  try {
    response = await updateSelf("mail_settings_set_encrypted", [encoded]);
  } catch (error) {
    throw settingsThrownError(error, "Encrypted Mail settings update");
  }
  return parseMailEncryptedSettingsSetResult(response);
}

export function parseMailEncryptedSettingsSetResult(
  response: unknown,
): MailBackendEncryptedSettings {
  return parseMailEncryptedSettings(response);
}

export function encodeMailEncryptedSettingsMutation(
  mutation: MailEncryptedSettingsMutation,
): SelfCallObject {
  const value = privateRequestObject(mutation, "Encrypted Mail settings mutation");
  const kind = value.kind;
  if (kind === "create") {
    assertPrivateKeys(value, ["kind", "settings"], [], "Encrypted Mail settings mutation");
    const settings = encodeMailEncryptedSettings(value.settings);
    if (settings.revision !== "1") {
      throw privateInvalidRequest("New encrypted Mail settings must start at revision 1");
    }
    return { create: settings };
  }
  if (kind === "replace") {
    assertPrivateKeys(
      value,
      ["kind", "expectedRevision", "settings"],
      [],
      "Encrypted Mail settings mutation",
    );
    const expectedRevision = privatePositiveU64(
      value.expectedRevision,
      "Expected Mail settings revision",
    );
    const settings = encodeMailEncryptedSettings(value.settings);
    const settingsRevision = settings.revision;
    if (typeof settingsRevision !== "string") {
      throw privateInvalidRequest("Encrypted Mail settings revision is invalid");
    }
    if (BigInt(expectedRevision) === MAIL_U64_MAX ||
      BigInt(settingsRevision) !== BigInt(expectedRevision) + 1n) {
      throw privateInvalidRequest(
        "Replacement encrypted Mail settings must increment the expected revision",
      );
    }
    return { replace: { expected_revision: expectedRevision, settings } };
  }
  if (kind === "rewrap") {
    assertPrivateKeys(
      value,
      [
        "kind",
        "expectedRevision",
        "localWrapEpoch",
        "localWrapFingerprint",
        "localWrappedCek",
      ],
      [],
      "Encrypted Mail settings mutation",
    );
    return {
      rewrap: {
        expected_revision: privatePositiveU64(
          value.expectedRevision,
          "Expected Mail settings revision",
        ),
        local_wrap_epoch: privatePositiveU64(
          value.localWrapEpoch,
          "Mail settings local wrap epoch",
        ),
        local_wrap_fingerprint: encodePrivateBytes(
          value.localWrapFingerprint,
          "Mail settings local wrap fingerprint",
          { exact: 32, nonzero: true },
        ),
        local_wrapped_cek: encodePrivateBytes(
          value.localWrappedCek,
          "Mail settings local wrapped key",
          { minimum: 1, maximum: MAIL_LOCAL_WRAP_MAX_BYTES, nonzero: true },
        ),
      },
    };
  }
  throw privateInvalidRequest("Encrypted Mail settings mutation kind is invalid");
}

/**
 * The Kernel self-call boundary projects a successful Store.Result to its bare
 * Store.Status payload and rejects the error arm.
 */
export async function getMailBackendStatus(): Promise<MailBackendStatus> {
  let response: unknown;
  try {
    response = await querySelf("mail_status", [null]);
  } catch {
    // Store errors and transport errors are deliberately not projected as an
    // empty/not-configured mailbox. Callers retain their last good snapshot.
    throw new MailBackendStatusError(
      "BACKEND_UNAVAILABLE",
      "Mail status is temporarily unavailable",
    );
  }
  return parseMailBackendStatus(response);
}

/** Constant-size mailbox change token for visible idle polling. */
export async function getMailBackendPulse(): Promise<MailBackendPulse> {
  let response: unknown;
  try {
    response = await querySelf("mail_pulse", [null]);
  } catch {
    throw new MailBackendStatusError(
      "BACKEND_UNAVAILABLE",
      "Mail status is temporarily unavailable",
    );
  }
  return parseMailBackendPulse(response);
}

/** Public lifecycle state only; this endpoint never returns key material. */
export async function getMailCryptoStatus(): Promise<MailBackendCryptoProgress | null> {
  let response: unknown;
  try {
    response = await querySelf("mail_crypto_status", [null]);
  } catch (error) {
    if (isMailCryptoNotConfiguredError(error)) return null;
    throw new MailBackendCryptoError(
      "vetkeys_unavailable",
      "Private Mail key status is temporarily unavailable",
    );
  }
  return parseMailCryptoStatus(response);
}

/** Cache the exact app-bound public slot information after kernel reservation. */
export async function setupMailCrypto(): Promise<MailBackendCryptoProgress> {
  let response: unknown;
  try {
    response = await updateSelf("mail_crypto_setup", [null]);
  } catch {
    throw new MailBackendCryptoError(
      "vetkeys_unavailable",
      "Private Mail could not be activated right now",
    );
  }
  return parseMailCryptoProgress(response);
}

/** Reconcile Mail's cached public generations after a trusted kernel rotation. */
export async function rotateMailCrypto(): Promise<MailBackendCryptoProgress> {
  let response: unknown;
  try {
    response = await updateSelf("mail_crypto_rotate", [null]);
  } catch {
    throw new MailBackendCryptoError(
      "vetkeys_unavailable",
      "Private Mail key rotation is temporarily unavailable",
    );
  }
  return parseMailCryptoProgress(response);
}

/**
 * Atomically replace a bounded set of storage-local CEK wraps. The request has
 * no delivery metadata or ciphertext fields, so immutable message content
 * cannot be rewritten through this endpoint.
 */
export async function rewrapMailCrypto(
  request: MailCryptoRewrapRequest,
): Promise<MailBackendCryptoRewrapResult> {
  const encoded = encodeMailCryptoRewrapRequest(request);
  let response: unknown;
  try {
    response = await updateSelf("mail_crypto_rewrap", [encoded]);
  } catch {
    throw new MailBackendCryptoError(
      "vetkeys_unavailable",
      "Private Mail key migration is temporarily unavailable",
    );
  }
  return parseMailCryptoRewrapResult(response);
}

export function parseMailCryptoStatus(
  response: unknown,
): MailBackendCryptoProgress {
  return parseMailCryptoProgress(response);
}

export function encodeMailCryptoRewrapRequest(
  request: MailCryptoRewrapRequest,
): SelfCallObject {
  if (!isPlainRecord(request)) throw cryptoInvalidRequest();
  const actual = Object.keys(request);
  if (
    actual.length !== 3 ||
    !actual.includes("expectedCurrentEpoch") ||
    !actual.includes("expectedPreviousEpoch") ||
    !actual.includes("targets") ||
    !Array.isArray(request.targets) ||
    request.targets.length < 1 ||
    request.targets.length > 50
  ) throw cryptoInvalidRequest();

  const expectedCurrentEpoch = cryptoPositiveU64(
    request.expectedCurrentEpoch,
    "Mail current key epoch",
  );
  const expectedPreviousEpoch = cryptoPositiveU64(
    request.expectedPreviousEpoch,
    "Mail previous key epoch",
  );
  if (expectedCurrentEpoch === expectedPreviousEpoch) throw cryptoInvalidRequest();

  const seen = new Set<string>();
  const targets = request.targets.map((target): SelfCallObject => {
    if (!isPlainRecord(target) || typeof target.kind !== "string") {
      throw cryptoInvalidRequest();
    }
    const expected = cryptoWrapBytes(target.expectedLocalWrappedCek, "old Mail key wrap");
    const replacement = cryptoWrapBytes(
      target.replacementLocalWrappedCek,
      "replacement Mail key wrap",
    );
    if (equalBytes(expected, replacement)) throw cryptoInvalidRequest();

    if (target.kind === "settings") {
      assertCryptoRequestKeys(target, [
        "kind",
        "expectedRevision",
        "expectedLocalWrappedCek",
        "replacementLocalWrappedCek",
      ]);
      const key = "settings";
      if (seen.has(key)) throw cryptoInvalidRequest();
      seen.add(key);
      return {
        settings: {
          expected_revision: cryptoPositiveU64(
            target.expectedRevision,
            "Mail settings revision",
          ),
          expected_local_wrapped_cek: expected,
          replacement_local_wrapped_cek: replacement,
        },
      };
    }
    if (target.kind !== "inbox" && target.kind !== "outbox") {
      throw cryptoInvalidRequest();
    }
    assertCryptoRequestKeys(target, [
      "kind",
      "localId",
      "expectedLocalWrappedCek",
      "replacementLocalWrappedCek",
    ]);
    const localId = cryptoPositiveNatural(target.localId, "Mail local id");
    const key = `${target.kind}:${localId}`;
    if (seen.has(key)) throw cryptoInvalidRequest();
    seen.add(key);
    return {
      [target.kind]: {
        local_id: localId,
        expected_local_wrapped_cek: expected,
        replacement_local_wrapped_cek: replacement,
      },
    };
  });

  return {
    expected_current_epoch: expectedCurrentEpoch,
    expected_previous_epoch: expectedPreviousEpoch,
    targets,
  };
}

export function parseMailCryptoRewrapResult(
  response: unknown,
): MailBackendCryptoRewrapResult {
  const value = object(response, "Mail crypto rewrap result");
  assertExactKeys(
    value,
    ["changed", "message_wraps_changed", "settings_wrap_changed", "progress"],
    [],
    "Mail crypto rewrap result",
  );
  const changed = natural(value.changed, "Mail changed key wraps");
  const messageWrapsChanged = natural(
    value.message_wraps_changed,
    "Mail changed message key wraps",
  );
  if (typeof value.settings_wrap_changed !== "boolean") {
    throw invalid("Mail settings key-wrap change");
  }
  const changedCount = BigInt(changed);
  const messageCount = BigInt(messageWrapsChanged);
  if (
    changedCount < 1n ||
    changedCount > 50n ||
    messageCount + (value.settings_wrap_changed ? 1n : 0n) !== changedCount
  ) throw invalid("Mail crypto rewrap counters");
  return {
    changed,
    messageWrapsChanged,
    settingsWrapChanged: value.settings_wrap_changed,
    progress: parseMailCryptoProgress(value.progress),
  };
}

export function parseMailBackendStatus(response: unknown): MailBackendStatus {
  const value = object(response, "Mail status");
  assertExactKeys(
    value,
    [
      "mail_revision",
      "contacts_revision",
      "cleanup_epoch",
      "setup",
      "inbox_count",
      "inbox_bytes",
      "unknown_at_receipt_count",
      "unknown_at_receipt_bytes",
      "unread_count",
      "sent_count",
      "outbox_count",
      "active_sends",
      "sent_and_outbox_bytes",
      "storage_level",
    ],
    ["encrypted_settings_revision"],
    "Mail status",
  );

  const setup = parseSetup(value.setup);
  return {
    revision: natural(value.mail_revision, "Mail revision"),
    contactsRevision: natural(value.contacts_revision, "Contacts revision"),
    cleanupEpoch: natural(value.cleanup_epoch, "Mail cleanup epoch"),
    privateMailActive: setup.configured,
    keyHolder: setup.keyHolder,
    currentEpoch: setup.currentEpoch,
    previousEpoch: setup.previousEpoch,
    encryptedSettingsRevision: optionalNatural(
      value.encrypted_settings_revision,
      "Encrypted settings revision",
    ),
    unread: natural(value.unread_count, "Unread count"),
    inboxCount: natural(value.inbox_count, "Inbox count"),
    inboxBytes: natural(value.inbox_bytes, "Inbox bytes"),
    unknownInboxCount: natural(
      value.unknown_at_receipt_count,
      "Unknown-at-receipt Inbox count",
    ),
    unknownInboxBytes: natural(
      value.unknown_at_receipt_bytes,
      "Unknown-at-receipt Inbox bytes",
    ),
    sentCount: natural(value.sent_count, "Sent count"),
    outboxCount: natural(value.outbox_count, "Outbox count"),
    activeSends: natural(value.active_sends, "Active send count"),
    sentAndOutboxBytes: natural(
      value.sent_and_outbox_bytes,
      "Sent and Outbox bytes",
    ),
    storageLevel: parseStorageLevel(value.storage_level),
  };
}

export function parseMailBackendPulse(response: unknown): MailBackendPulse {
  const value = object(response, "Mail pulse");
  assertExactKeys(
    value,
    [
      "mail_revision",
      "contacts_revision",
      "cleanup_epoch",
      "inbox_count",
      "unread_count",
    ],
    [],
    "Mail pulse",
  );
  return {
    revision: natural(value.mail_revision, "Mail revision"),
    contactsRevision: natural(value.contacts_revision, "Contacts revision"),
    cleanupEpoch: natural(value.cleanup_epoch, "Mail cleanup epoch"),
    inboxCount: natural(value.inbox_count, "Inbox count"),
    unread: natural(value.unread_count, "Unread count"),
  };
}

export async function getMailList(
  request: MailListRequest,
): Promise<MailBackendListPage> {
  const encoded = encodeMailListRequest(request);
  let response: unknown;
  try {
    response = await querySelf("mail_list_encrypted", [encoded]);
  } catch {
    throw mailboxUnavailable("Mail list is temporarily unavailable");
  }
  const page = parseMailListPage(response);
  if (page.items.some((item) => item.kind !== request.folder)) {
    throw mailboxInvalid("Mail list folder");
  }
  validateMailListPageForRequest(page, request.limit, encoded.offset as string);
  return page;
}

/**
 * Resident-only counterpart to getMailList. It preserves authenticated header
 * ciphertext for in-memory browser decryption. Do not expose this result from
 * a tool handler or persist it outside Mail's resident runtime.
 */
export async function getMailEncryptedList(
  request: MailListRequest,
): Promise<MailBackendEncryptedListPage> {
  const encoded = encodeMailListRequest(request);
  let response: unknown;
  try {
    response = await querySelf("mail_list_encrypted", [encoded]);
  } catch (error) {
    throw mailboxThrownError(error, "Mail list");
  }
  const page = parseMailEncryptedListPage(response);
  if (page.items.some((item) => item.kind !== request.folder)) {
    throw mailboxInvalid("Mail list folder");
  }
  validateMailListPageForRequest(page, request.limit, encoded.offset as string);
  return page;
}

export function validateMailListPageForRequest(
  page: MailBackendListPage,
  requestedLimit: number,
  requestedOffset: string,
): void {
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    throw mailboxInvalidRequest("Mail list limit must be from 1 to 50");
  }
  const offset = BigInt(natural(requestedOffset, "Mail list offset"));
  const total = BigInt(page.total);
  const itemCount = BigInt(page.items.length);
  const end = offset + itemCount;
  const nextOffset = page.nextOffset === null ? null : BigInt(page.nextOffset);

  if (page.items.length > requestedLimit) throw mailboxInvalid("Mail list items");
  if (BigInt(page.ciphertextBytes) > 163_840n) {
    throw mailboxInvalid("Mail list ciphertext bytes");
  }

  const ids = new Set(page.items.map((item) => item.localId));
  if (ids.size !== page.items.length) throw mailboxInvalid("Mail list item ids");

  if (offset >= total) {
    if (itemCount !== 0n || nextOffset !== null) throw mailboxInvalid("Mail list page");
    return;
  }
  // A non-terminal page must consume at least one record. Its cursor is the
  // exact absolute offset following those records, so it cannot stall, skip,
  // or loop even when the ciphertext byte cap shortens the page.
  if (itemCount === 0n || end > total) throw mailboxInvalid("Mail list page");
  const expectedNext = end < total ? end : null;
  if (nextOffset !== expectedNext) throw mailboxInvalid("Mail list next offset");
}

export function parseMailListPage(response: unknown): MailBackendListPage {
  const value = mailboxObject(response, "Mail list");
  assertMailboxKeys(
    value,
    [
      "mail_revision",
      "contacts_revision",
      "cleanup_epoch",
      "items",
      "total",
      "ciphertext_bytes",
    ],
    ["next_offset"],
    "Mail list",
  );
  if (!Array.isArray(value.items) || value.items.length > 50) {
    throw mailboxInvalid("Mail list items");
  }
  const items = value.items.map(parseMailListItem);
  const total = natural(value.total, "Mail list total");
  const nextOffset = optionalNatural(value.next_offset, "Mail list next offset");
  if (nextOffset !== null && BigInt(nextOffset) > BigInt(total)) {
    throw mailboxInvalid("Mail list next offset");
  }
  return {
    revision: natural(value.mail_revision, "Mail revision"),
    contactsRevision: natural(value.contacts_revision, "Contacts revision"),
    cleanupEpoch: natural(value.cleanup_epoch, "Mail cleanup epoch"),
    items,
    total,
    nextOffset,
    ciphertextBytes: natural(value.ciphertext_bytes, "Mail list ciphertext bytes"),
  };
}

export function parseMailEncryptedListPage(
  response: unknown,
): MailBackendEncryptedListPage {
  const value = mailboxObject(response, "Mail list");
  assertMailboxKeys(
    value,
    [
      "mail_revision",
      "contacts_revision",
      "cleanup_epoch",
      "items",
      "total",
      "ciphertext_bytes",
    ],
    ["next_offset"],
    "Mail list",
  );
  if (!Array.isArray(value.items) || value.items.length > 50) {
    throw mailboxInvalid("Mail list items");
  }
  const items = value.items.map(parseMailEncryptedListItem);
  const total = natural(value.total, "Mail list total");
  const nextOffset = optionalNatural(value.next_offset, "Mail list next offset");
  if (nextOffset !== null && BigInt(nextOffset) > BigInt(total)) {
    throw mailboxInvalid("Mail list next offset");
  }
  return {
    revision: natural(value.mail_revision, "Mail revision"),
    contactsRevision: natural(value.contacts_revision, "Contacts revision"),
    cleanupEpoch: natural(value.cleanup_epoch, "Mail cleanup epoch"),
    items,
    total,
    nextOffset,
    ciphertextBytes: natural(value.ciphertext_bytes, "Mail list ciphertext bytes"),
  };
}

export async function getMailRecord(
  folder: MailFolder,
  localId: string,
): Promise<MailBackendGetResult> {
  const id = positiveNatural(localId, "Mail local id");
  let response: unknown;
  try {
    response = await querySelf("mail_get_encrypted", [
      {
        store: { [folder === "inbox" ? "inbox" : "outbox"]: null },
        local_id: id,
      },
    ]);
  } catch {
    throw mailboxUnavailable("Mail message is temporarily unavailable");
  }
  const result = parseMailGetResult(response);
  if (result.record.kind !== folder || result.record.localId !== id) {
    throw mailboxInvalid("Mail record store");
  }
  return result;
}

/** Resident-only exact ciphertext fetch; locked projections use getMailRecord. */
export async function getMailEncryptedRecord(
  folder: MailFolder,
  localId: string,
): Promise<MailBackendEncryptedGetResult> {
  const encoded = encodeMailGetRequest(folder, localId);
  let response: unknown;
  try {
    response = await querySelf("mail_get_encrypted", [encoded]);
  } catch (error) {
    throw mailboxThrownError(error, "Mail message");
  }
  const result = parseMailEncryptedGetResult(response);
  if (
    result.record.kind !== folder ||
    result.record.localId !== encoded.local_id
  ) {
    throw mailboxInvalid("Mail record store");
  }
  return result;
}

export function parseMailGetResult(response: unknown): MailBackendGetResult {
  const value = mailboxObject(response, "Mail message");
  assertMailboxKeys(
    value,
    ["mail_revision", "contacts_revision", "cleanup_epoch", "record"],
    [],
    "Mail message",
  );
  const [kind, payload] = mailboxVariant(
    value.record,
    ["inbox", "outbox"] as const,
    "Mail record",
  );
  return {
    revision: natural(value.mail_revision, "Mail revision"),
    contactsRevision: natural(value.contacts_revision, "Contacts revision"),
    cleanupEpoch: natural(value.cleanup_epoch, "Mail cleanup epoch"),
    record: kind === "inbox"
      ? parseInboxRecord(payload)
      : parseOutboxRecord(payload),
  };
}

export function parseMailEncryptedGetResult(
  response: unknown,
): MailBackendEncryptedGetResult {
  const value = mailboxObject(response, "Mail message");
  assertMailboxKeys(
    value,
    ["mail_revision", "contacts_revision", "cleanup_epoch", "record"],
    [],
    "Mail message",
  );
  const [kind, payload] = mailboxVariant(
    value.record,
    ["inbox", "outbox"] as const,
    "Mail record",
  );
  return {
    revision: natural(value.mail_revision, "Mail revision"),
    contactsRevision: natural(value.contacts_revision, "Contacts revision"),
    cleanupEpoch: natural(value.cleanup_epoch, "Mail cleanup epoch"),
    record: kind === "inbox"
      ? parseMailEncryptedInboxRecord(payload)
      : parseMailEncryptedOutboxRecord(payload),
  };
}

export async function markMailRead(
  localIds: readonly string[],
  read: boolean,
): Promise<MailBackendMutationResult> {
  if (localIds.length > 100) {
    throw mailboxInvalidRequest("At most 100 messages may be marked at once");
  }
  const ids = uniqueNaturalIds(localIds, "Mail mark ids");
  let response: unknown;
  try {
    response = await updateSelf("mail_mark", [{ local_ids: ids, read }]);
  } catch {
    throw mailboxUnavailable("Mail could not update the read state");
  }
  return parseMailMutationResult(response);
}

export async function deleteMailRecords(
  targets: readonly { folder: MailFolder; localId: string }[],
): Promise<MailBackendMutationResult> {
  if (targets.length > 100) {
    throw mailboxInvalidRequest("At most 100 messages may be deleted at once");
  }
  const keys = new Set<string>();
  const encoded = targets.map((target) => {
    const store = target.folder === "inbox" ? "inbox" : "outbox";
    const localId = natural(target.localId, "Mail local id");
    const key = `${store}:${localId}`;
    if (keys.has(key)) throw mailboxInvalidRequest("Mail delete targets must be unique");
    keys.add(key);
    return { [store]: localId };
  });
  let response: unknown;
  try {
    response = await updateSelf("mail_delete", [{ targets: encoded }]);
  } catch {
    throw mailboxUnavailable("Mail could not delete the message");
  }
  return parseMailMutationResult(response);
}

export function parseMailMutationResult(response: unknown): MailBackendMutationResult {
  const value = mailboxObject(response, "Mail mutation");
  assertMailboxKeys(
    value,
    [
      "mail_revision",
      "cleanup_epoch",
      "changed",
      "inbox_deleted",
      "outbox_deleted",
      "unread_deleted",
      "retained_bytes_deleted",
      "unread_remaining",
    ],
    [],
    "Mail mutation",
  );
  return {
    revision: natural(value.mail_revision, "Mail revision"),
    cleanupEpoch: natural(value.cleanup_epoch, "Mail cleanup epoch"),
    changed: natural(value.changed, "Changed message count"),
    inboxDeleted: natural(value.inbox_deleted, "Deleted Inbox count"),
    outboxDeleted: natural(value.outbox_deleted, "Deleted Outbox count"),
    unreadDeleted: natural(value.unread_deleted, "Deleted unread count"),
    retainedBytesDeleted: natural(
      value.retained_bytes_deleted,
      "Deleted retained bytes",
    ),
    unreadRemaining: natural(value.unread_remaining, "Remaining unread count"),
  };
}

export async function previewMailCleanup(
  scope: MailBackendCleanupScope,
): Promise<MailBackendCleanupPreview> {
  let response: unknown;
  try {
    response = await querySelf("mail_cleanup_preview", [
      { [cleanupScopeToBackend(scope)]: null },
    ]);
  } catch {
    throw mailboxUnavailable("Mail cleanup preview is temporarily unavailable");
  }
  return parseMailCleanupPreview(response);
}

export function parseMailCleanupPreview(response: unknown): MailBackendCleanupPreview {
  const value = mailboxObject(response, "Mail cleanup preview");
  assertMailboxKeys(
    value,
    ["scope", "mail_revision", "contacts_revision", "cleanup_epoch", "counts"],
    [],
    "Mail cleanup preview",
  );
  const [scopeTag, scopePayload] = mailboxVariant(
    value.scope,
    ["read_inbox", "unknown_current", "all_mail"] as const,
    "Mail cleanup scope",
  );
  if (scopePayload !== null) throw mailboxInvalid("Mail cleanup scope");
  const countsValue = mailboxObject(value.counts, "Mail cleanup counts");
  assertMailboxKeys(
    countsValue,
    ["total", "unread", "inbox", "sent", "outbox", "active_sends", "retained_bytes"],
    [],
    "Mail cleanup counts",
  );
  const preview = {
    scope: cleanupScopeFromBackend(scopeTag),
    revision: natural(value.mail_revision, "Mail revision"),
    contactsRevision: natural(value.contacts_revision, "Contacts revision"),
    cleanupEpoch: natural(value.cleanup_epoch, "Mail cleanup epoch"),
    counts: {
      total: natural(countsValue.total, "Cleanup total"),
      unread: natural(countsValue.unread, "Cleanup unread count"),
      inbox: natural(countsValue.inbox, "Cleanup Inbox count"),
      sent: natural(countsValue.sent, "Cleanup Sent count"),
      outbox: natural(countsValue.outbox, "Cleanup Outbox count"),
      activeSends: natural(countsValue.active_sends, "Cleanup active send count"),
      retainedBytes: natural(countsValue.retained_bytes, "Cleanup retained bytes"),
    },
  };
  return { ...preview, previewToken: cleanupPreviewToken(preview) };
}

export async function commitMailCleanup(
  preview: MailBackendCleanupPreview,
): Promise<MailBackendMutationResult> {
  if (preview.previewToken !== cleanupPreviewToken(preview)) {
    throw mailboxInvalidRequest("Mail cleanup preview token is stale");
  }
  let response: unknown;
  try {
    response = await updateSelf("mail_cleanup", [encodeCleanupPreview(preview)]);
  } catch (error) {
    // icblast rejects a Candid Result.err instead of returning the variant.
    // Restore that domain error before deciding this was a transport outage so
    // a stale authoritative preview remains a reviewable conflict in the UI.
    throw mailboxThrownError(error, "Mail cleanup");
  }
  return parseMailMutationResult(response);
}

function parseMailListItem(value: unknown): MailBackendListItem {
  const [kind, payload] = mailboxVariant(
    value,
    ["inbox", "sent", "outbox"] as const,
    "Mail list item",
  );
  if (kind === "inbox") return parseInboxListItem(payload);
  return parseOutboxListItem(payload, kind);
}

function parseMailEncryptedListItem(value: unknown): MailBackendEncryptedListItem {
  const [kind, payload] = mailboxVariant(
    value,
    ["inbox", "sent", "outbox"] as const,
    "Mail list item",
  );
  if (kind === "inbox") {
    const record = mailboxObject(payload, "Inbox list item");
    assertMailboxKeys(
      record,
      [
        "local_id",
        "sender",
        "received_at_ns",
        "read",
        "known_at_receipt",
        "current_contact",
        "retained_bytes",
        "encrypted_header",
      ],
      [],
      "Inbox list item",
    );
    return {
      ...inboxProjection(record),
      encryptedHeader: parseEncryptedHeader(record.encrypted_header),
    };
  }
  const record = mailboxObject(payload, `${kind} list item`);
  assertMailboxKeys(
    record,
    [
      "local_id",
      "recipient",
      "current_contact",
      "created_at_ns",
      "updated_at_ns",
      "cleanup_epoch",
      "attempt_no",
      "state",
      "retained_bytes",
      "encrypted_header",
    ],
    ["contact_id", "contact_revision"],
    `${kind} list item`,
  );
  const state = parseOutboxState(record.state);
  return {
    ...outboxProjection(record, kind, state),
    encryptedHeader: parseEncryptedHeader(record.encrypted_header),
  };
}

function parseInboxListItem(value: unknown): MailBackendInboxItem {
  const record = mailboxObject(value, "Inbox list item");
  assertMailboxKeys(
    record,
    [
      "local_id",
      "sender",
      "received_at_ns",
      "read",
      "known_at_receipt",
      "current_contact",
      "retained_bytes",
      "encrypted_header",
    ],
    [],
    "Inbox list item",
  );
  validateEncryptedHeader(record.encrypted_header);
  return inboxProjection(record);
}

function parseInboxRecord(value: unknown): MailBackendInboxItem {
  const record = mailboxObject(value, "Inbox record");
  assertMailboxKeys(
    record,
    [
      "local_id",
      "sender",
      "received_at_ns",
      "read",
      "known_at_receipt",
      "current_contact",
      "retained_bytes",
      "encrypted",
    ],
    [],
    "Inbox record",
  );
  validateEncryptedContent(record.encrypted);
  return inboxProjection(record);
}

function parseMailEncryptedInboxRecord(
  value: unknown,
): MailBackendEncryptedInboxRecord {
  const record = mailboxObject(value, "Inbox record");
  assertMailboxKeys(
    record,
    [
      "local_id",
      "sender",
      "received_at_ns",
      "read",
      "known_at_receipt",
      "current_contact",
      "retained_bytes",
      "encrypted",
    ],
    [],
    "Inbox record",
  );
  return {
    ...inboxProjection(record),
    encrypted: parseEncryptedContent(record.encrypted),
  };
}

function inboxProjection(record: SelfCallObject): MailBackendInboxItem {
  return {
    kind: "inbox",
    localId: positiveNatural(record.local_id, "Mail local id"),
    sender: mailboxCanisterPrincipal(record.sender, "Mail sender"),
    receivedAtNs: integer(record.received_at_ns, "Mail received time"),
    read: requiredBoolean(record.read, "Mail read state"),
    knownAtReceipt: requiredBoolean(
      record.known_at_receipt,
      "Mail known-at-receipt state",
    ),
    currentContact: parseCurrentContact(record.current_contact),
    retainedBytes: natural(record.retained_bytes, "Mail retained bytes"),
  };
}

function parseOutboxListItem(
  value: unknown,
  kind: "sent" | "outbox",
): MailBackendOutboxItem {
  const record = mailboxObject(value, `${kind} list item`);
  assertMailboxKeys(
    record,
    [
      "local_id",
      "recipient",
      "current_contact",
      "created_at_ns",
      "updated_at_ns",
      "cleanup_epoch",
      "attempt_no",
      "state",
      "retained_bytes",
      "encrypted_header",
    ],
    ["contact_id", "contact_revision"],
    `${kind} list item`,
  );
  validateEncryptedHeader(record.encrypted_header);
  return outboxProjection(record, kind);
}

function parseOutboxRecord(value: unknown): MailBackendExactRecord {
  const record = mailboxObject(value, "Outbox record");
  assertMailboxKeys(
    record,
    [
      "local_id",
      "command_id",
      "recipient",
      "current_contact",
      "created_at_ns",
      "updated_at_ns",
      "cleanup_epoch",
      "attempt_no",
      "state",
      "retained_bytes",
      "encrypted",
    ],
    ["contact_id", "contact_revision", "attempt_request_id"],
    "Outbox record",
  );
  parseMailboxBytes(record.command_id, "Mail command id", {
    exact: MAIL_COMMAND_ID_BYTES,
    nonzero: true,
  });
  let attemptRequestId: Uint8Array | null = null;
  if (record.attempt_request_id !== null && record.attempt_request_id !== undefined) {
    attemptRequestId = parseMailboxBytes(
      record.attempt_request_id,
      "Mail attempt request id",
      {
        exact: MAIL_RETRY_REQUEST_ID_BYTES,
        nonzero: true,
      },
    );
  }
  const attemptNo = positiveNatural(record.attempt_no, "Mail attempt number");
  if (
    (attemptNo === "1" && attemptRequestId !== null) ||
    (attemptNo !== "1" && attemptRequestId === null)
  ) {
    throw mailboxInvalid("Mail attempt request id");
  }
  validateEncryptedContent(record.encrypted);
  const state = parseOutboxState(record.state);
  return outboxProjection(
    record,
    state.status === "accepted" ? "sent" : "outbox",
    state,
  );
}

function parseMailEncryptedOutboxRecord(
  value: unknown,
): MailBackendEncryptedOutboxRecord {
  const record = mailboxObject(value, "Outbox record");
  assertMailboxKeys(
    record,
    [
      "local_id",
      "command_id",
      "recipient",
      "current_contact",
      "created_at_ns",
      "updated_at_ns",
      "cleanup_epoch",
      "attempt_no",
      "state",
      "retained_bytes",
      "encrypted",
    ],
    ["contact_id", "contact_revision", "attempt_request_id"],
    "Outbox record",
  );
  const commandId = parseMailboxBytes(record.command_id, "Mail command id", {
    exact: MAIL_COMMAND_ID_BYTES,
    nonzero: true,
  });
  const attemptRequestId = record.attempt_request_id === null ||
      record.attempt_request_id === undefined
    ? null
    : parseMailboxBytes(record.attempt_request_id, "Mail attempt request id", {
        exact: MAIL_RETRY_REQUEST_ID_BYTES,
        nonzero: true,
      });
  const state = parseOutboxState(record.state);
  const projected = outboxProjection(
    record,
    state.status === "accepted" ? "sent" : "outbox",
    state,
  );
  if (
    (projected.attemptNo === "1" && attemptRequestId !== null) ||
    (projected.attemptNo !== "1" && attemptRequestId === null)
  ) {
    throw mailboxInvalid("Mail attempt request id");
  }
  return {
    ...projected,
    commandId,
    attemptRequestId,
    encrypted: parseEncryptedContent(record.encrypted),
  };
}

function outboxProjection(
  record: SelfCallObject,
  kind: "sent" | "outbox",
  parsedState = parseOutboxState(record.state),
): MailBackendOutboxItem {
  if (kind === "sent" && parsedState.status !== "accepted") {
    throw mailboxInvalid("Sent delivery state");
  }
  if (kind === "outbox" && parsedState.status === "accepted") {
    throw mailboxInvalid("Outbox delivery state");
  }
  const contactId = optionalPositiveNatural(record.contact_id, "Mail contact id");
  const contactRevision = optionalPositiveNatural(
    record.contact_revision,
    "Mail contact revision",
  );
  if ((contactId === null) !== (contactRevision === null)) {
    throw mailboxInvalid("Mail contact binding");
  }
  return {
    kind,
    localId: positiveNatural(record.local_id, "Mail local id"),
    recipient: mailboxCanisterPrincipal(record.recipient, "Mail recipient"),
    contactId,
    contactRevision,
    currentContact: parseCurrentContact(record.current_contact),
    createdAtNs: integer(record.created_at_ns, "Mail created time"),
    updatedAtNs: integer(record.updated_at_ns, "Mail updated time"),
    cleanupEpoch: natural(record.cleanup_epoch, "Mail cleanup epoch"),
    attemptNo: positiveNatural(record.attempt_no, "Mail attempt number"),
    state: parsedState,
    retainedBytes: natural(record.retained_bytes, "Mail retained bytes"),
  };
}

function parseCurrentContact(value: unknown): MailBackendCurrentContact {
  const [status, payload] = mailboxVariant(
    value,
    ["in_contacts", "not_in_contacts", "contact_conflict"] as const,
    "Current Mail contact",
  );
  if (status !== "in_contacts") {
    if (payload !== null) throw mailboxInvalid("Current Mail contact");
    return { status };
  }
  const contact = mailboxObject(payload, "Current Mail contact");
  assertMailboxKeys(
    contact,
    ["contact_id", "contact_revision", "contact_name"],
    [],
    "Current Mail contact",
  );
  return {
    status,
    contactId: positiveNatural(contact.contact_id, "Current Mail contact id"),
    contactRevision: positiveNatural(
      contact.contact_revision,
      "Current Mail contact revision",
    ),
    contactName: boundedContactName(contact.contact_name),
  };
}

function parseOutboxState(value: unknown): MailBackendOutboxState {
  const [tag, payload] = mailboxVariant(
    value,
    ["sending", "accepted", "not_sent", "delivery_uncertain"] as const,
    "Mail delivery state",
  );
  if (tag === "sending" || tag === "delivery_uncertain") {
    if (payload !== null) throw mailboxInvalid("Mail delivery state");
    return { status: tag };
  }
  if (tag === "accepted") {
    const accepted = mailboxObject(payload, "Accepted delivery state");
    assertMailboxKeys(
      accepted,
      ["received_at_ns"],
      [],
      "Accepted delivery state",
    );
    return {
      status: "accepted",
      acceptedAtNs: integer(accepted.received_at_ns, "Accepted time"),
    };
  }
  const [reason, reasonPayload] = mailboxVariant(
    payload,
    [
      "invalid",
      "rate_limited",
      "mailbox_full",
      "stale_key",
      "crypto_unavailable",
      "permission_required",
    ] as const,
    "Mail not-sent reason",
  );
  if (reasonPayload !== null) throw mailboxInvalid("Mail not-sent reason");
  return { status: "not_sent", notSentReason: reason };
}

function validateEncryptedHeader(value: unknown): void {
  parseEncryptedHeader(value);
}

function parseEncryptedHeader(value: unknown): MailBackendEncryptedHeader {
  const header = mailboxObject(value, "Encrypted Mail header");
  assertMailboxKeys(
    header,
    [
      "message_id",
      "delivery_key_epoch",
      "delivery_key_fingerprint",
      "local_wrap_epoch",
      "local_wrap_fingerprint",
      "local_wrapped_cek",
      "header_nonce",
      "header_ciphertext_and_tag",
    ],
    [],
    "Encrypted Mail header",
  );
  return {
    messageId: parseMailboxBytes(header.message_id, "Mail message id", {
      exact: 16,
      nonzero: true,
    }),
    deliveryKeyEpoch: mailboxPositiveU64(
      header.delivery_key_epoch,
      "Mail delivery key epoch",
    ),
    deliveryKeyFingerprint: parseMailboxBytes(
      header.delivery_key_fingerprint,
      "Mail delivery key fingerprint",
      { exact: 32, nonzero: true },
    ),
    localWrapEpoch: mailboxPositiveU64(
      header.local_wrap_epoch,
      "Mail local wrap epoch",
    ),
    localWrapFingerprint: parseMailboxBytes(
      header.local_wrap_fingerprint,
      "Mail local wrap fingerprint",
      { exact: 32, nonzero: true },
    ),
    localWrappedCek: parseMailboxBytes(
      header.local_wrapped_cek,
      "Mail local wrapped key",
      { exact: 168, nonzero: true },
    ),
    headerNonce: parseMailboxBytes(header.header_nonce, "Mail header nonce", {
      exact: 12,
    }),
    headerCiphertextAndTag: parseMailboxBytes(
      header.header_ciphertext_and_tag,
      "Mail encrypted header",
      { exact: MAIL_HEADER_CIPHERTEXT_BYTES },
    ),
  };
}

function validateEncryptedContent(value: unknown): void {
  parseEncryptedContent(value);
}

function parseEncryptedContent(value: unknown): MailBackendEncryptedContent {
  const content = mailboxObject(value, "Encrypted Mail content");
  assertMailboxKeys(
    content,
    ["header", "body_nonce", "body_ciphertext_and_tag"],
    [],
    "Encrypted Mail content",
  );
  const header = parseEncryptedHeader(content.header);
  const bodyNonce = parseMailboxBytes(content.body_nonce, "Mail body nonce", {
    exact: 12,
  });
  const bodyCiphertextAndTag = parseMailboxBytes(
    content.body_ciphertext_and_tag,
    "Mail encrypted body",
    { minimum: 1, maximum: Math.max(...MAIL_BODY_CIPHERTEXT_BUCKETS) },
  );
  if (
    !(MAIL_BODY_CIPHERTEXT_BUCKETS as readonly number[]).includes(
      bodyCiphertextAndTag.byteLength,
    ) || equalBytes(header.headerNonce, bodyNonce)
  ) {
    throw mailboxInvalid("Mail encrypted body");
  }
  return { header, bodyNonce, bodyCiphertextAndTag };
}

export function encodeMailListRequest(request: MailListRequest): JsonObject {
  const value = privateRequestObject(request, "Mail list request");
  assertPrivateKeys(
    value,
    ["folder", "limit"],
    [
      "unreadOnly",
      "offset",
      "expectedRevision",
      "expectedContactsRevision",
    ],
    "Mail list request",
  );
  if (value.folder !== "inbox" && value.folder !== "sent" && value.folder !== "outbox") {
    throw privateInvalidRequest("Mail list folder is invalid");
  }
  if (!Number.isInteger(value.limit) || (value.limit as number) < 1 ||
    (value.limit as number) > 50) {
    throw privateInvalidRequest("Mail list limit must be from 1 to 50");
  }
  if (value.unreadOnly !== undefined && typeof value.unreadOnly !== "boolean") {
    throw privateInvalidRequest("Mail unread-only filter must be boolean");
  }
  const offset = privateNatural(value.offset ?? "0", "Mail list offset", true);
  const expectedRevision = privateOptionalNaturalRequest(
    value.expectedRevision,
    "Expected Mail revision",
  );
  const expectedContactsRevision = privateOptionalNaturalRequest(
    value.expectedContactsRevision,
    "Expected Contacts revision",
  );
  return {
    folder: { [value.folder]: null },
    unread_only: value.unreadOnly ?? false,
    offset,
    // Candid Nat values cross the icblast JSON API as canonical decimals.
    limit: (value.limit as number).toString(),
    // icblast models Candid optionals in records as optional properties. A
    // present JSON null fails its inner Nat schema before the call is made;
    // omission is the canonical wire representation of Candid `none` here.
    ...(expectedRevision === null
      ? {}
      : { expected_mail_revision: expectedRevision }),
    ...(expectedContactsRevision === null
      ? {}
      : { expected_contacts_revision: expectedContactsRevision }),
  };
}

function encodeMailGetRequest(folder: MailFolder, localId: string): JsonObject {
  if (folder !== "inbox" && folder !== "sent" && folder !== "outbox") {
    throw privateInvalidRequest("Mail record folder is invalid");
  }
  return {
    store: { [folder === "inbox" ? "inbox" : "outbox"]: null },
    local_id: privatePositiveNatural(localId, "Mail local id"),
  };
}

function cleanupScopeToBackend(
  scope: MailBackendCleanupScope,
): "read_inbox" | "unknown_current" | "all_mail" {
  switch (scope) {
    case "read_inbox": return "read_inbox";
    case "unknown_senders": return "unknown_current";
    case "all_mail": return "all_mail";
  }
}

function cleanupScopeFromBackend(
  scope: "read_inbox" | "unknown_current" | "all_mail",
): MailBackendCleanupScope {
  return scope === "unknown_current" ? "unknown_senders" : scope;
}

function cleanupPreviewToken(
  preview: Omit<MailBackendCleanupPreview, "previewToken"> | MailBackendCleanupPreview,
): string {
  const counts = preview.counts;
  return [
    preview.scope,
    preview.revision,
    preview.contactsRevision,
    preview.cleanupEpoch,
    counts.total,
    counts.unread,
    counts.inbox,
    counts.sent,
    counts.outbox,
    counts.activeSends,
    counts.retainedBytes,
  ].join(":");
}

function encodeCleanupPreview(preview: MailBackendCleanupPreview): JsonObject {
  return {
    scope: { [cleanupScopeToBackend(preview.scope)]: null },
    mail_revision: preview.revision,
    contacts_revision: preview.contactsRevision,
    cleanup_epoch: preview.cleanupEpoch,
    counts: {
      total: preview.counts.total,
      unread: preview.counts.unread,
      inbox: preview.counts.inbox,
      sent: preview.counts.sent,
      outbox: preview.counts.outbox,
      active_sends: preview.counts.activeSends,
      retained_bytes: preview.counts.retainedBytes,
    },
  };
}

function uniqueNaturalIds(values: readonly string[], label: string): string[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const id = natural(value, label);
    if (seen.has(id)) throw mailboxInvalidRequest(`${label} must be unique`);
    seen.add(id);
    return id;
  });
}

function parseMailBackendKeyInfo(value: unknown): MailBackendKeyInfo {
  const info = privateResponseObject(value, "Mail key info");
  assertPrivateResponseKeys(
    info,
    [
      "protocol_version",
      "suite",
      "delivery_key_epoch",
      "context_public_key",
      "effective_ibe_identity",
      "recipient_key_fingerprint",
      "max_envelope_bytes",
    ],
    [],
    "Mail key info",
  );
  if (info.protocol_version !== 1 || info.suite !== 1) {
    throw privateInvalidResponse("Mail key info protocol");
  }
  const deliveryKeyEpoch = privatePositiveU64Response(
    info.delivery_key_epoch,
    "Mail delivery key epoch",
  );
  const contextPublicKey = parsePrivateBytes(
    info.context_public_key,
    "Mail context public key",
    { minimum: 1, maximum: 4_096 },
  );
  const effectiveIbeIdentity = parsePrivateBytes(
    info.effective_ibe_identity,
    "Mail IBE identity",
    { minimum: 1, maximum: 4_096 },
  );
  const recipientKeyFingerprint = parsePrivateBytes(
    info.recipient_key_fingerprint,
    "Mail recipient key fingerprint",
    { exact: 32, nonzero: true },
  );
  if (info.max_envelope_bytes !== MAIL_MAX_ENVELOPE_BYTES) {
    throw privateInvalidResponse("Mail maximum envelope size");
  }
  let canonicalFingerprint: Uint8Array;
  try {
    canonicalFingerprint = computeMailKeyFingerprint({
      suite: 1,
      epoch: BigInt(deliveryKeyEpoch),
      contextPublicKey,
      effectiveIbeIdentity,
    });
  } catch {
    throw privateInvalidResponse("Mail key info");
  }
  if (!equalBytes(canonicalFingerprint, recipientKeyFingerprint)) {
    throw privateInvalidResponse("Mail recipient key fingerprint");
  }
  return {
    protocolVersion: 1,
    suite: 1,
    deliveryKeyEpoch,
    contextPublicKey,
    effectiveIbeIdentity,
    recipientKeyFingerprint,
    maxEnvelopeBytes: MAIL_MAX_ENVELOPE_BYTES,
  };
}

function parseMailEncryptedSettings(value: unknown): MailBackendEncryptedSettings {
  const settings = privateResponseObject(value, "Encrypted Mail settings");
  assertPrivateResponseKeys(
    settings,
    [
      "record_id",
      "revision",
      "local_wrap_epoch",
      "local_wrap_fingerprint",
      "local_wrapped_cek",
      "nonce",
      "ciphertext_and_tag",
    ],
    [],
    "Encrypted Mail settings",
  );
  return {
    recordId: parsePrivateBytes(settings.record_id, "Mail settings record id", {
      exact: MAIL_SETTINGS_RECORD_ID_BYTES,
      nonzero: true,
    }),
    revision: privatePositiveU64Response(
      settings.revision,
      "Mail settings revision",
    ),
    localWrapEpoch: privatePositiveU64Response(
      settings.local_wrap_epoch,
      "Mail settings local wrap epoch",
    ),
    localWrapFingerprint: parsePrivateBytes(
      settings.local_wrap_fingerprint,
      "Mail settings local wrap fingerprint",
      { exact: 32, nonzero: true },
    ),
    localWrappedCek: parsePrivateBytes(
      settings.local_wrapped_cek,
      "Mail settings local wrapped key",
      { minimum: 1, maximum: MAIL_LOCAL_WRAP_MAX_BYTES, nonzero: true },
    ),
    nonce: parsePrivateBytes(settings.nonce, "Mail settings nonce", {
      exact: 12,
      nonzero: true,
    }),
    ciphertextAndTag: parsePrivateBytes(
      settings.ciphertext_and_tag,
      "Mail settings ciphertext",
      {
        minimum: MAIL_SETTINGS_CIPHERTEXT_MIN_BYTES,
        maximum: MAIL_SETTINGS_CIPHERTEXT_MAX_BYTES,
        nonzero: true,
      },
    ),
  };
}

function encodeMailEncryptedSettings(value: unknown): SelfCallObject {
  const settings = privateRequestObject(value, "Encrypted Mail settings");
  assertPrivateKeys(
    settings,
    [
      "recordId",
      "revision",
      "localWrapEpoch",
      "localWrapFingerprint",
      "localWrappedCek",
      "nonce",
      "ciphertextAndTag",
    ],
    [],
    "Encrypted Mail settings",
  );
  return {
    record_id: encodePrivateBytes(settings.recordId, "Mail settings record id", {
      exact: MAIL_SETTINGS_RECORD_ID_BYTES,
      nonzero: true,
    }),
    revision: privatePositiveU64(settings.revision, "Mail settings revision"),
    local_wrap_epoch: privatePositiveU64(
      settings.localWrapEpoch,
      "Mail settings local wrap epoch",
    ),
    local_wrap_fingerprint: encodePrivateBytes(
      settings.localWrapFingerprint,
      "Mail settings local wrap fingerprint",
      { exact: 32, nonzero: true },
    ),
    local_wrapped_cek: encodePrivateBytes(
      settings.localWrappedCek,
      "Mail settings local wrapped key",
      { minimum: 1, maximum: MAIL_LOCAL_WRAP_MAX_BYTES, nonzero: true },
    ),
    nonce: encodePrivateBytes(settings.nonce, "Mail settings nonce", {
      exact: 12,
      nonzero: true,
    }),
    ciphertext_and_tag: encodePrivateBytes(
      settings.ciphertextAndTag,
      "Mail settings ciphertext",
      {
        minimum: MAIL_SETTINGS_CIPHERTEXT_MIN_BYTES,
        maximum: MAIL_SETTINGS_CIPHERTEXT_MAX_BYTES,
        nonzero: true,
      },
    ),
  };
}

function parsePrivateDeliveryState(value: unknown): MailBackendOutboxState {
  const [tag, payload] = privateResponseVariant(
    value,
    ["sending", "accepted", "not_sent", "delivery_uncertain"] as const,
    "Mail delivery state",
  );
  if (tag === "sending" || tag === "delivery_uncertain") {
    if (payload !== null) throw privateInvalidResponse("Mail delivery state");
    return { status: tag };
  }
  if (tag === "accepted") {
    const accepted = privateResponseObject(payload, "Accepted Mail delivery");
    assertPrivateResponseKeys(
      accepted,
      ["received_at_ns"],
      [],
      "Accepted Mail delivery",
    );
    return {
      status: "accepted",
      acceptedAtNs: privateTimestamp(accepted.received_at_ns, "Mail accepted time"),
    };
  }
  const [reason, reasonPayload] = privateResponseVariant(
    payload,
    [
      "invalid",
      "rate_limited",
      "mailbox_full",
      "stale_key",
      "crypto_unavailable",
      "permission_required",
    ] as const,
    "Mail not-sent reason",
  );
  if (reasonPayload !== null) throw privateInvalidResponse("Mail not-sent reason");
  return { status: "not_sent", notSentReason: reason };
}

function deliveryResultError(value: unknown, label: string): MailBackendPrivateError {
  const [tag, payload] = privateResponseVariant(
    value,
    [
      "invalid_request",
      "permission_required",
      "recipient_unavailable",
      "recipient_changed",
      "permit_capacity",
      "permit_request_reused",
      "permit_missing",
      "permit_expired",
      "permit_mismatch",
      "mailbox_full",
      "crypto_unavailable",
      "command_conflict",
      "command_deleted",
      "not_found",
      "not_retryable",
      "retry_deleted",
      "attempt_superseded",
      "clock_invalid",
      "corrupt_state",
    ] as const,
    `${label} error`,
  );
  if (tag === "command_deleted") {
    const deleted = privateResponseObject(payload, `${label} deleted command`);
    assertPrivateResponseKeys(
      deleted,
      ["local_id"],
      [],
      `${label} deleted command`,
    );
    return new MailBackendPrivateError(
      "COMMAND_DELETED",
      "That encrypted Mail command was already deleted",
      privatePositiveNaturalResponse(deleted.local_id, "Mail local id"),
    );
  }
  if (payload !== null) throw privateInvalidResponse(`${label} error`);
  const mapped: Record<Exclude<typeof tag, "command_deleted">, MailBackendPrivateErrorCode> = {
    invalid_request: "INVALID_REQUEST",
    permission_required: "PERMISSION_REQUIRED",
    recipient_unavailable: "RECIPIENT_UNAVAILABLE",
    recipient_changed: "RECIPIENT_CHANGED",
    permit_capacity: "PERMIT_CAPACITY",
    permit_request_reused: "PERMIT_REQUEST_REUSED",
    permit_missing: "PERMIT_MISSING",
    permit_expired: "PERMIT_EXPIRED",
    permit_mismatch: "PERMIT_MISMATCH",
    mailbox_full: "MAILBOX_FULL",
    crypto_unavailable: "CRYPTO_UNAVAILABLE",
    command_conflict: "COMMAND_CONFLICT",
    not_found: "NOT_FOUND",
    not_retryable: "NOT_RETRYABLE",
    retry_deleted: "RETRY_DELETED",
    attempt_superseded: "ATTEMPT_SUPERSEDED",
    clock_invalid: "BACKEND_UNAVAILABLE",
    corrupt_state: "BACKEND_UNAVAILABLE",
  };
  return new MailBackendPrivateError(mapped[tag], privateErrorMessage(mapped[tag]));
}

function settingsResultError(value: unknown, label: string): MailBackendPrivateError {
  const [tag, payload] = privateResponseVariant(
    value,
    ["invalid_request", "not_configured", "corrupt_state", "revision_conflict"] as const,
    `${label} error`,
  );
  if (tag === "revision_conflict") {
    const conflict = privateResponseObject(payload, `${label} revision conflict`);
    assertPrivateResponseKeys(
      conflict,
      ["expected", "actual"],
      [],
      `${label} revision conflict`,
    );
    privateOptionalU64Response(conflict.expected, "Expected Mail settings revision");
    privateOptionalU64Response(conflict.actual, "Actual Mail settings revision");
    return new MailBackendPrivateError(
      "REVISION_CONFLICT",
      "Encrypted Mail settings changed; reload before saving",
    );
  }
  if (payload !== null) throw privateInvalidResponse(`${label} error`);
  if (tag === "invalid_request") {
    return new MailBackendPrivateError("INVALID_REQUEST", "Encrypted Mail settings are invalid");
  }
  if (tag === "not_configured") {
    return new MailBackendPrivateError("NOT_CONFIGURED", "Private Mail is not configured");
  }
  return new MailBackendPrivateError(
    "BACKEND_UNAVAILABLE",
    "Encrypted Mail settings are temporarily unavailable",
  );
}

function deliveryThrownError(error: unknown, label: string): MailBackendPrivateError {
  const parsed = parseThrownPrivateError(error, label, deliveryResultError);
  return parsed ?? new MailBackendPrivateError(
    "BACKEND_UNAVAILABLE",
    `${label} is temporarily unavailable`,
  );
}

function settingsThrownError(error: unknown, label: string): MailBackendPrivateError {
  const parsed = parseThrownPrivateError(error, label, settingsResultError);
  return parsed ?? new MailBackendPrivateError(
    "BACKEND_UNAVAILABLE",
    `${label} is temporarily unavailable`,
  );
}

function parseThrownPrivateError(
  error: unknown,
  label: string,
  parseError: (value: unknown, label: string) => MailBackendPrivateError,
): MailBackendPrivateError | null {
  try {
    const variant = canisterResultVariantError(error);
    if (variant !== null) return parseError(variant, label);
    return parseError(error, label);
  } catch {
    return null;
  }
}

export function canisterResultVariantError(error: unknown): JsonObject | null {
  if (!(error instanceof Error)) return null;
  if (error.name === "CanisterResultError") {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(code)) {
      return null;
    }
    return { [code]: null };
  }

  // The kernel can attach a stable code to nullary Result errors. Structured
  // errors currently cross the bounded JSON bus as a canonical message. Keep
  // this restoration deliberately exact and bounded; arbitrary exception text
  // must never be promoted to an authoritative backend conflict.
  const prefix = "revision conflict: ";
  if (!error.message.startsWith(prefix)) return null;
  const fields = error.message.slice(prefix.length).split(", ");
  if (fields.length !== 3) return null;
  const revisions: {
    mail_revision?: string;
    contacts_revision?: string;
    cleanup_epoch?: string;
  } = {};
  for (const field of fields) {
    const match = /^(mail revision|contacts revision|cleanup epoch) (0|[1-9][0-9]{0,39})$/u.exec(field);
    if (!match) return null;
    const key = match[1] === "mail revision"
      ? "mail_revision"
      : match[1] === "contacts revision"
        ? "contacts_revision"
        : "cleanup_epoch";
    if (revisions[key] !== undefined) return null;
    revisions[key] = match[2]!;
  }
  if (
    revisions.mail_revision === undefined ||
    revisions.contacts_revision === undefined ||
    revisions.cleanup_epoch === undefined
  ) return null;
  return {
    revision_conflict: {
      mail_revision: revisions.mail_revision,
      contacts_revision: revisions.contacts_revision,
      cleanup_epoch: revisions.cleanup_epoch,
    },
  };
}

export function isMailCryptoNotConfiguredError(error: unknown): boolean {
  const variant = canisterResultVariantError(error);
  if (variant === null) return false;
  try {
    return parseMailCryptoError(variant).code === "not_configured";
  } catch {
    return false;
  }
}

export function mailboxThrownError(error: unknown, label: string): MailBackendMailboxError {
  try {
    const variant = canisterResultVariantError(error);
    if (variant !== null) return mailboxResultError(variant, label);
    return mailboxResultError(error, label);
  } catch {
    return mailboxUnavailable(`${label} is temporarily unavailable`);
  }
}

function privateErrorMessage(code: MailBackendPrivateErrorCode): string {
  switch (code) {
    case "PERMISSION_REQUIRED": return "Mail needs permission to connect to that recipient";
    case "RECIPIENT_UNAVAILABLE": return "That Mail recipient is unavailable";
    case "RECIPIENT_CHANGED": return "The selected Mail recipient changed; select it again";
    case "PERMIT_CAPACITY": return "Too many recipient preparations are active";
    case "PERMIT_REQUEST_REUSED": return "That recipient preparation was already used";
    case "PERMIT_MISSING": return "The Mail recipient preparation is missing";
    case "PERMIT_EXPIRED": return "The Mail recipient preparation expired";
    case "PERMIT_MISMATCH": return "The encrypted Mail does not match its recipient preparation";
    case "MAILBOX_FULL": return "The Mail Outbox is full";
    case "CRYPTO_UNAVAILABLE": return "Private Mail encryption is unavailable";
    case "COMMAND_CONFLICT": return "That Mail send command conflicts with an earlier command";
    case "NOT_FOUND": return "That Mail message was not found";
    case "NOT_RETRYABLE": return "That Mail delivery cannot be retried";
    case "RETRY_DELETED": return "That Mail retry belongs to a deleted message";
    case "ATTEMPT_SUPERSEDED": return "That Mail delivery attempt was superseded";
    case "INVALID_REQUEST": return "The encrypted Mail request is invalid";
    default: return "Private Mail is temporarily unavailable";
  }
}

function privateRequestObject(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    value instanceof Uint8Array
  ) {
    throw privateInvalidRequest(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function privateResponseObject(value: unknown, label: string): SelfCallObject {
  if (!isJsonObject(value)) throw privateInvalidResponse(label);
  return value as SelfCallObject;
}

function assertPrivateKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw privateInvalidRequest(`${label} has unexpected or missing fields`);
  }
}

function assertPrivateResponseKeys(
  value: SelfCallObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw privateInvalidResponse(label);
  }
}

function privateResponseVariant<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): [T, unknown] {
  const record = privateResponseObject(value, label);
  const keys = Object.keys(record);
  if (keys.length !== 1 || !allowed.includes(keys[0] as T)) {
    throw privateInvalidResponse(label);
  }
  const key = keys[0] as T;
  return [key, record[key]];
}

type PrivateByteBounds = {
  exact?: number;
  minimum?: number;
  maximum?: number;
  nonzero?: boolean;
};

function privateInputBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw privateInvalidRequest(`${label} must be bytes`);
  }
  return value.slice();
}

function encodePrivateBytes(
  value: unknown,
  label: string,
  bounds: PrivateByteBounds,
): Uint8Array {
  const bytes = privateInputBytes(value, label);
  assertPrivateByteBounds(bytes, label, bounds, true);
  return bytes;
}

function parsePrivateBytes(
  value: unknown,
  label: string,
  bounds: PrivateByteBounds,
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw privateInvalidResponse(label);
  }
  const bytes = value.slice();
  assertPrivateByteBounds(bytes, label, bounds, false);
  return bytes;
}

function parseMailboxBytes(
  value: unknown,
  label: string,
  bounds: PrivateByteBounds,
): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw mailboxInvalid(label);
  }
  const bytes = value.slice();
  const length = bytes.byteLength;
  if (
    (bounds.exact !== undefined && length !== bounds.exact) ||
    (bounds.minimum !== undefined && length < bounds.minimum) ||
    (bounds.maximum !== undefined && length > bounds.maximum) ||
    (bounds.nonzero && bytes.every((byte) => byte === 0))
  ) {
    throw mailboxInvalid(label);
  }
  return bytes;
}

function assertPrivateByteBounds(
  bytes: Uint8Array,
  label: string,
  bounds: PrivateByteBounds,
  request: boolean,
): void {
  const length = bytes.byteLength;
  if (
    (bounds.exact !== undefined && length !== bounds.exact) ||
    (bounds.minimum !== undefined && length < bounds.minimum) ||
    (bounds.maximum !== undefined && length > bounds.maximum) ||
    (bounds.nonzero && bytes.every((byte) => byte === 0))
  ) {
    if (request) throw privateInvalidRequest(`${label} has an invalid length or value`);
    throw privateInvalidResponse(label);
  }
}


function canonicalCanisterPrincipal(value: unknown, label: string): string {
  try {
    const text = typeof value === "string" ? value : "";
    const parsed = Principal.fromText(text);
    if (text !== parsed.toText() || !isCanisterPrincipalBytes(parsed.toUint8Array())) {
      throw new Error("invalid principal");
    }
    return text;
  } catch {
    throw privateInvalidRequest(`${label} must be a canonical canister principal`);
  }
}

function canonicalCanisterPrincipalResponse(value: unknown, label: string): string {
  try {
    const text = typeof value === "string" ? value : "";
    const parsed = Principal.fromText(text);
    if (text !== parsed.toText() || !isCanisterPrincipalBytes(parsed.toUint8Array())) {
      throw new Error("invalid principal");
    }
    return text;
  } catch {
    throw privateInvalidResponse(label);
  }
}

function isCanisterPrincipalBytes(value: Uint8Array): boolean {
  return value.byteLength >= 1 && value.byteLength <= 29 &&
    value[value.byteLength - 1] === 1;
}

function privateNatural(
  value: unknown,
  label: string,
  request = false,
): string {
  let parsed: bigint;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    parsed = BigInt(value);
  } else if (typeof value === "bigint" && value >= 0n) {
    parsed = value;
  } else {
    if (request) throw privateInvalidRequest(`${label} must be an unsigned integer`);
    throw privateInvalidResponse(label);
  }
  return parsed.toString();
}

function privatePositiveNatural(value: unknown, label: string): string {
  const parsed = privateNatural(value, label, true);
  if (parsed === "0") throw privateInvalidRequest(`${label} must be positive`);
  return parsed;
}

function privatePositiveNaturalResponse(value: unknown, label: string): string {
  const parsed = privateNatural(value, label);
  if (parsed === "0") throw privateInvalidResponse(label);
  return parsed;
}

function privateOptionalNatural(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : privateNatural(value, label);
}

function privateOptionalNaturalRequest(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : privateNatural(value, label, true);
}

function privatePositiveU64(value: unknown, label: string): string {
  const parsed = privateNatural(value, label, true);
  if (parsed === "0" || BigInt(parsed) > MAIL_U64_MAX) {
    throw privateInvalidRequest(`${label} is out of range`);
  }
  return parsed;
}

function privatePositiveU64Response(value: unknown, label: string): string {
  const parsed = privateNatural(value, label);
  if (parsed === "0" || BigInt(parsed) > MAIL_U64_MAX) {
    throw privateInvalidResponse(label);
  }
  return parsed;
}

function privateOptionalU64Response(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = privateNatural(value, label);
  if (BigInt(parsed) > MAIL_U64_MAX) throw privateInvalidResponse(label);
  return parsed;
}

function privateTimestamp(value: unknown, label: string): string {
  let parsed: bigint;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value)) {
    parsed = BigInt(value);
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    parsed = BigInt(value);
  } else if (typeof value === "bigint" && value >= 0n) {
    parsed = value;
  } else {
    throw privateInvalidResponse(label);
  }
  if (parsed > MAIL_SIGNED_TIMESTAMP_MAX) throw privateInvalidResponse(label);
  return parsed.toString();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function privateInvalidRequest(message: string): MailBackendPrivateError {
  return new MailBackendPrivateError("INVALID_REQUEST", message);
}

function privateInvalidResponse(label: string): MailBackendPrivateError {
  return new MailBackendPrivateError("INVALID_RESPONSE", `Invalid ${label}`);
}

function mailboxResultError(value: unknown, label: string): MailBackendMailboxError {
  const [tag, payload] = mailboxVariant(
    value,
    [
      "invalid_request",
      "not_found",
      "revision_conflict",
      "contacts_conflict",
      "clock_invalid",
      "corrupt_state",
      "contacts_error",
      "invalid_dependency",
    ] as const,
    `${label} error`,
  );
  if (tag === "revision_conflict") {
    const conflict = mailboxObject(payload, `${label} revision conflict`);
    assertMailboxKeys(
      conflict,
      ["mail_revision", "contacts_revision", "cleanup_epoch"],
      [],
      `${label} revision conflict`,
    );
    natural(conflict.mail_revision, "Mail revision");
    natural(conflict.contacts_revision, "Contacts revision");
    natural(conflict.cleanup_epoch, "Mail cleanup epoch");
    return new MailBackendMailboxError(
      "CONFLICT",
      `${label} changed; refresh and review it again`,
    );
  }
  if (payload !== null) throw mailboxInvalid(`${label} error`);
  switch (tag) {
    case "invalid_request":
      return mailboxInvalidRequest(`${label} request is invalid`);
    case "not_found":
      return new MailBackendMailboxError("NOT_FOUND", `${label} was not found`);
    case "contacts_conflict":
      return new MailBackendMailboxError(
        "CONFLICT",
        "Contacts changed; refresh and review Mail again",
      );
    case "clock_invalid":
    case "corrupt_state":
    case "contacts_error":
    case "invalid_dependency":
      return mailboxUnavailable(`${label} is temporarily unavailable`);
  }
}

function mailboxObject(value: unknown, label: string): SelfCallObject {
  if (!isJsonObject(value)) throw mailboxInvalid(label);
  return value as SelfCallObject;
}

function mailboxVariant<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): [T, unknown] {
  const record = mailboxObject(value, label);
  const keys = Object.keys(record);
  if (keys.length !== 1 || !allowed.includes(keys[0] as T)) {
    throw mailboxInvalid(label);
  }
  const key = keys[0] as T;
  return [key, record[key]];
}

function assertMailboxKeys(
  value: SelfCallObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw mailboxInvalid(label);
  }
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw mailboxInvalid(label);
  return value;
}

function boundedContactName(value: unknown): string {
  if (
    typeof value !== "string" ||
    [...value].length < 1 ||
    [...value].length > 120 ||
    hasUnsafeSingleLineControls(value)
  ) {
    throw mailboxInvalid("Mail contact name");
  }
  return value;
}

function hasUnsafeSingleLineControls(value: string): boolean {
  for (const character of value) {
    const scalar = character.codePointAt(0)!;
    if (scalar < 0x20 || scalar === 0x7f) return true;
  }
  return false;
}

function integer(value: unknown, label: string): string {
  if (typeof value === "string") {
    if (!/^(?:0|-?[1-9][0-9]*)$/u.test(value)) throw mailboxInvalid(label);
    return BigInt(value).toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw mailboxInvalid(label);
    return BigInt(value).toString();
  }
  if (typeof value === "bigint") return value.toString();
  throw mailboxInvalid(label);
}

function mailboxCanisterPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string") throw mailboxInvalid(label);
  try {
    const parsed = Principal.fromText(value);
    if (parsed.toText() !== value || !isCanisterPrincipalBytes(parsed.toUint8Array())) {
      throw new Error("invalid canister principal");
    }
    return value;
  } catch {
    throw mailboxInvalid(label);
  }
}

function mailboxInvalid(label: string): MailBackendMailboxError {
  return new MailBackendMailboxError("INVALID_RESPONSE", `Invalid ${label}`);
}

function mailboxInvalidRequest(message: string): MailBackendMailboxError {
  return new MailBackendMailboxError("INVALID_REQUEST", message);
}

function mailboxUnavailable(message: string): MailBackendMailboxError {
  return new MailBackendMailboxError("BACKEND_UNAVAILABLE", message);
}

function parseSetup(value: unknown): {
  configured: boolean;
  keyHolder: string | null;
  currentEpoch: string | null;
  previousEpoch: string | null;
} {
  const [tag, payload] = variant(
    value,
    ["not_configured", "configured"] as const,
    "Mail setup",
  );
  if (tag === "not_configured") {
    if (payload !== null) throw invalid("Mail setup");
    return {
      configured: false,
      keyHolder: null,
      currentEpoch: null,
      previousEpoch: null,
    };
  }

  const configured = object(payload, "Configured Mail setup");
  assertExactKeys(
    configured,
    ["key_holder", "current_epoch"],
    ["previous_epoch"],
    "Configured Mail setup",
  );
  return {
    configured: true,
    keyHolder: nonemptyString(configured.key_holder, "Mail key holder"),
    currentEpoch: natural(configured.current_epoch, "Mail key epoch"),
    previousEpoch: optionalNatural(
      configured.previous_epoch,
      "Previous Mail key epoch",
    ),
  };
}

function parseMailCryptoProgress(value: unknown): MailBackendCryptoProgress {
  const progress = object(value, "Mail crypto progress");
  assertExactKeys(
    progress,
    [
      "mail_revision",
      "key_holder",
      "current_epoch",
      "previous_references",
      "ready_to_retire",
    ],
    ["previous_epoch"],
    "Mail crypto progress",
  );
  const references = object(
    progress.previous_references,
    "Mail crypto previous references",
  );
  assertExactKeys(
    references,
    ["settings", "inbox", "outbox", "total"],
    [],
    "Mail crypto previous references",
  );
  const settings = natural(references.settings, "Mail settings key references");
  const inbox = natural(references.inbox, "Mail Inbox key references");
  const outbox = natural(references.outbox, "Mail Outbox key references");
  const total = natural(references.total, "Mail total key references");
  if (BigInt(settings) + BigInt(inbox) + BigInt(outbox) !== BigInt(total)) {
    throw invalid("Mail crypto previous references");
  }
  if (typeof progress.ready_to_retire !== "boolean") {
    throw invalid("Mail crypto retirement state");
  }
  const previousEpoch = optionalPositiveStatusNatural(
    progress.previous_epoch,
    "Previous Mail key epoch",
  );
  if (
    progress.ready_to_retire !== (previousEpoch !== null && total === "0")
  ) {
    throw invalid("Mail crypto retirement state");
  }
  return {
    revision: natural(progress.mail_revision, "Mail revision"),
    keyHolder: canonicalPrincipal(progress.key_holder, "Mail key holder"),
    currentEpoch: positiveStatusNatural(
      progress.current_epoch,
      "Mail current key epoch",
    ),
    previousEpoch,
    previousReferences: { settings, inbox, outbox, total },
    readyToRetire: progress.ready_to_retire,
  };
}

function parseMailCryptoError(value: unknown): MailBackendCryptoError {
  const [tag, payload] = variant(
    value,
    [
      "invalid_request",
      "not_configured",
      "already_configured",
      "not_reserved",
      "disabled",
      "manifest_suspended",
      "generation_unavailable",
      "key_holder_changed",
      "rotation_in_progress",
      "rotation_not_ready",
      "capability_changed",
      "vetkeys",
      "previous_references",
      "revision_conflict",
      "corrupt_state",
    ] as const,
    "Mail crypto error",
  );
  if (tag === "vetkeys") return parseNestedVetKeysError(payload);
  if (tag === "previous_references") {
    // Validate the bounded diagnostic without leaking it through the error.
    const references = object(payload, "Mail previous references error");
    assertExactKeys(
      references,
      ["settings", "inbox", "outbox", "total"],
      [],
      "Mail previous references error",
    );
    const settings = natural(references.settings, "Mail settings key references");
    const inbox = natural(references.inbox, "Mail Inbox key references");
    const outbox = natural(references.outbox, "Mail Outbox key references");
    const total = natural(references.total, "Mail total key references");
    if (BigInt(settings) + BigInt(inbox) + BigInt(outbox) !== BigInt(total)) {
      throw invalid("Mail previous references error");
    }
  } else if (payload !== null) {
    throw invalid("Mail crypto error");
  }
  const code = tag as Exclude<typeof tag, "vetkeys">;
  return new MailBackendCryptoError(code, mailCryptoErrorMessage(code));
}

function parseNestedVetKeysError(value: unknown): MailBackendCryptoError {
  const [tag, payload] = variant(
    value,
    [
      "not_declared",
      "not_reserved",
      "manifest_suspended",
      "disabled",
      "generation_unavailable",
      "invalid_request",
      "challenge_expired",
      "challenge_consumed",
      "busy",
      "low_cycles",
      "key_unavailable",
      "management_failure",
      "source_gone",
      "owner_required",
    ] as const,
    "Mail vetKeys error",
  );
  if (payload !== null) {
    throw invalid("Mail vetKeys error");
  }
  return new MailBackendCryptoError(
    "vetkeys_unavailable",
    tag === "owner_required"
      ? "Sign in with an authorized Neutron principal"
      : tag === "low_cycles"
        ? "Neutron needs more cycles before private Mail can be activated"
        : "Private Mail key service is temporarily unavailable",
  );
}

function assertCryptoRequestKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw cryptoInvalidRequest();
  }
}

function cryptoPositiveU64(value: unknown, label: string): string {
  const parsed = cryptoPositiveNatural(value, label);
  if (BigInt(parsed) > MAIL_U64_MAX) {
    throw new MailBackendCryptoError("invalid_request", `${label} is invalid`);
  }
  return parsed;
}

function cryptoPositiveNatural(value: unknown, label: string): string {
  const text = typeof value === "bigint" ? value.toString() : value;
  if (typeof text !== "string" || !/^[1-9][0-9]{0,39}$/u.test(text)) {
    throw new MailBackendCryptoError("invalid_request", `${label} is invalid`);
  }
  return BigInt(text).toString();
}

function cryptoWrapBytes(value: unknown, label: string): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < 1 ||
    value.byteLength > MAIL_LOCAL_WRAP_MAX_BYTES
  ) {
    throw new MailBackendCryptoError("invalid_request", `${label} is invalid`);
  }
  return value.slice();
}

function cryptoInvalidRequest(): MailBackendCryptoError {
  return new MailBackendCryptoError(
    "invalid_request",
    "The private Mail key request was invalid",
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function mailCryptoErrorMessage(code: MailBackendCryptoErrorCode): string {
  switch (code) {
    case "not_configured":
      return "Private Mail is not configured";
    case "already_configured":
      return "Private Mail is already active";
    case "not_reserved":
      return "Activate the private Mail key slot first";
    case "disabled":
      return "The private Mail key slot is disabled";
    case "manifest_suspended":
      return "The private Mail key declaration is suspended";
    case "generation_unavailable":
    case "capability_changed":
    case "key_holder_changed":
      return "Private Mail key access changed. Review Neutron Settings and try again";
    case "rotation_in_progress":
    case "rotation_not_ready":
    case "previous_references":
      return "Private Mail key rotation is still in progress";
    case "revision_conflict":
      return "Private Mail changed; refresh and try again";
    case "invalid_request":
      return "The private Mail key request was invalid";
    case "vetkeys_unavailable":
    case "corrupt_state":
      return "Private Mail key service is temporarily unavailable";
  }
}

function positiveStatusNatural(value: unknown, label: string): string {
  const parsed = natural(value, label);
  if (parsed === "0" || BigInt(parsed) > MAIL_U64_MAX) throw invalid(label);
  return parsed;
}

function optionalPositiveStatusNatural(
  value: unknown,
  label: string,
): string | null {
  return value === null || value === undefined
    ? null
    : positiveStatusNatural(value, label);
}

function canonicalPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string") throw invalid(label);
  try {
    const principal = Principal.fromText(value);
    if (principal.isAnonymous() || principal.toText() !== value) throw new Error();
    return value;
  } catch {
    throw invalid(label);
  }
}

function parseStorageLevel(value: unknown): MailStorageLevel {
  const [tag, payload] = variant(
    value,
    ["normal", "approaching_limit", "almost_full"] as const,
    "Mail storage level",
  );
  if (payload !== null) throw invalid("Mail storage level");
  return tag;
}

function variant<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): [T, unknown] {
  const record = object(value, label);
  const keys = Object.keys(record);
  if (keys.length !== 1 || !allowed.includes(keys[0] as T)) {
    throw invalid(label);
  }
  const key = keys[0] as T;
  return [key, record[key]];
}

function object(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw invalid(label);
  return value as JsonObject;
}

function assertExactKeys(
  value: JsonObject,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalid(label);
  }
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(label);
  }
  return value;
}

function natural(value: unknown, label: string): string {
  let parsed: bigint;
  if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw invalid(label);
    parsed = BigInt(value);
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid(label);
    parsed = BigInt(value);
  } else if (typeof value === "bigint") {
    parsed = value;
  } else {
    throw invalid(label);
  }
  if (parsed < 0n) throw invalid(label);
  return parsed.toString();
}

function positiveNatural(value: unknown, label: string): string {
  let parsed: string;
  try {
    parsed = natural(value, label);
  } catch {
    throw mailboxInvalid(label);
  }
  if (parsed === "0") throw mailboxInvalid(label);
  return parsed;
}

function optionalPositiveNatural(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : positiveNatural(value, label);
}

function mailboxPositiveU64(value: unknown, label: string): string {
  const parsed = positiveNatural(value, label);
  if (BigInt(parsed) > MAIL_U64_MAX) throw mailboxInvalid(label);
  return parsed;
}

function optionalNatural(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : natural(value, label);
}

function invalid(label: string): MailBackendStatusError {
  return new MailBackendStatusError("INVALID_RESPONSE", `Invalid ${label}`);
}
