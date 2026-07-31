import {
  callTool,
  loadTileContext,
  type JsonObject,
  type JsonValue,
  type ExposedToolOptions,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import type { MailBackendCurrentContact } from "./backend.ts";
import {
  MAIL_PRIVATE_GET_TOOL,
  MAIL_PRIVATE_LIST_TOOL,
  MAIL_PRIVATE_SEARCH_TOOL,
  MailPrivateError,
  type MailPrivateDecryption,
  type MailPrivateErrorCode,
  type MailPrivateListPage,
  type MailPrivateMessage,
  type MailPrivateRow,
  type MailPrivateSearchResult,
} from "./mail_private.ts";
import type { MailDeliveryStatus, MailFolder } from "./model.ts";
import {
  validateBodyMarkdown,
  validateClaimedSenderName,
  validateSubject,
  validateUnsignedDecimal,
} from "./model.ts";

const decimalSchema: JsonObject = {
  type: "string",
  pattern: "^0$|^[1-9][0-9]*$",
  maxLength: 20,
};
const positiveDecimalSchema: JsonObject = {
  type: "string",
  pattern: "^[1-9][0-9]*$",
  maxLength: 20,
};
const signedDecimalSchema: JsonObject = {
  type: "string",
  pattern: "^0$|^-?[1-9][0-9]*$",
  maxLength: 20,
};
const nullableDecimalSchema: JsonObject = {
  oneOf: [decimalSchema, { type: "null" }],
};
const folderSchema: JsonObject = {
  type: "string",
  enum: ["inbox", "sent", "outbox"],
};
const currentContactSchema: JsonObject = {
  oneOf: [
    objectSchema(
      ["status", "contactId", "contactRevision", "contactName"],
      {
        status: { const: "in_contacts" },
        contactId: positiveDecimalSchema,
        contactRevision: positiveDecimalSchema,
        contactName: { type: "string", minLength: 1, maxLength: 120 },
      },
    ),
    objectSchema(["status"], { status: { const: "not_in_contacts" } }),
    objectSchema(["status"], { status: { const: "contact_conflict" } }),
  ],
};
const headerSchema = objectSchema(
  ["claimedSenderName", "subject", "senderCreatedAtNs", "inReplyTo"],
  {
    claimedSenderName: { type: "string", minLength: 1, maxLength: 256 },
    subject: { type: "string", minLength: 1, maxLength: 512 },
    senderCreatedAtNs: signedDecimalSchema,
    inReplyTo: {
      oneOf: [
        { type: "string", pattern: "^[0-9a-f]{32}$" },
        { type: "null" },
      ],
    },
  },
);
const decryptionSchema: JsonObject = {
  oneOf: [
    objectSchema(["state", "header"], {
      state: { const: "ready" },
      header: headerSchema,
    }),
    objectSchema(["state"], { state: { const: "corrupt" } }),
  ],
};
const rowSchema = objectSchema(
  [
    "folder",
    "localId",
    "messageId",
    "peerPrincipal",
    "currentContact",
    "timestampNs",
    "read",
    "deliveryStatus",
    "replyContextLabel",
    "decryption",
  ],
  {
    folder: folderSchema,
    localId: positiveDecimalSchema,
    messageId: { type: "string", pattern: "^[0-9a-f]{32}$" },
    peerPrincipal: { type: "string", minLength: 3, maxLength: 80 },
    currentContact: currentContactSchema,
    timestampNs: signedDecimalSchema,
    read: { type: "boolean" },
    deliveryStatus: {
      type: ["string", "null"],
      enum: ["sending", "accepted", "not_sent", "delivery_uncertain", null],
    },
    replyContextLabel: {
      type: ["string", "null"],
      enum: ["Reply to an earlier message", null],
    },
    decryption: decryptionSchema,
  },
);
const privateErrorSchema = objectSchema(["code", "message"], {
  code: {
    type: "string",
    enum: ["mail_locked", "capability_changed", "temporarily_unavailable"],
  },
  message: { type: "string", minLength: 1, maxLength: 160 },
});
export const MAIL_PRIVATE_LIST_PAGE_SCHEMA = objectSchema(
  [
    "revision",
    "contactsRevision",
    "cleanupEpoch",
    "items",
    "total",
    "nextOffset",
    "ciphertextBytes",
  ],
  {
    revision: decimalSchema,
    contactsRevision: decimalSchema,
    cleanupEpoch: decimalSchema,
    items: { type: "array", maxItems: 50, items: rowSchema },
    total: decimalSchema,
    nextOffset: nullableDecimalSchema,
    ciphertextBytes: decimalSchema,
  },
);

export const MAIL_PRIVATE_LIST_OPTIONS: ExposedToolOptions = {
  title: "Decrypt Mail Headers",
  description:
    "Internal same-app tile operation. Decrypts one bounded ciphertext header page in the resident worker; bodies and keys are never returned.",
  inputSchema: objectSchema(
    [
      "folder",
      "unreadOnly",
      "offset",
      "limit",
      "expectedRevision",
      "expectedContactsRevision",
    ],
    {
      folder: folderSchema,
      unreadOnly: { type: "boolean" },
      offset: decimalSchema,
      limit: { type: "integer", minimum: 1, maximum: 50 },
      expectedRevision: nullableDecimalSchema,
      expectedContactsRevision: nullableDecimalSchema,
    },
  ),
  outputSchema: privateResultSchema("page", MAIL_PRIVATE_LIST_PAGE_SCHEMA),
  annotations: { "neutron:effects": ["read"] },
};

export const MAIL_PRIVATE_GET_OPTIONS: ExposedToolOptions = {
  title: "Decrypt Mail Message",
  description:
    "Internal same-app tile operation. Fetches and decrypts exactly one ciphertext record in the resident worker.",
  inputSchema: objectSchema(["folder", "localId"], {
    folder: folderSchema,
    localId: positiveDecimalSchema,
  }),
  outputSchema: privateResultSchema(
    "message",
    objectSchema(
      [
        "folder",
        "localId",
        "messageId",
        "peerPrincipal",
        "currentContact",
        "timestampNs",
        "read",
        "deliveryStatus",
        "replyContextLabel",
        "decryption",
        "bodyMarkdown",
      ],
      {
        ...(rowSchema.properties as JsonObject),
        bodyMarkdown: {
          oneOf: [
            { type: "string", maxLength: 32_768 },
            { type: "null" },
          ],
        },
      },
    ),
  ),
  annotations: { "neutron:effects": ["read"] },
};

export const MAIL_PRIVATE_SEARCH_OPTIONS: ExposedToolOptions = {
  title: "Search Decrypted Mail Headers",
  description:
    "Internal same-app tile operation. Searches only the resident's volatile authenticated header cache, never ciphertext bodies.",
  inputSchema: objectSchema(["folder", "query", "limit"], {
    folder: folderSchema,
    query: { type: "string", maxLength: 120 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  }),
  outputSchema: privateResultSchema(
    "search",
    objectSchema(["query", "folder", "items"], {
      query: { type: "string", maxLength: 120 },
      folder: folderSchema,
      items: { type: "array", maxItems: 50, items: rowSchema },
    }),
  ),
  annotations: { "neutron:effects": ["read"] },
};

export type MailPrivateTilePort = {
  list(request: {
    folder: MailFolder;
    unreadOnly: boolean;
    offset: string;
    limit: number;
    expectedRevision: string | null;
    expectedContactsRevision: string | null;
  }): Promise<MailPrivateListPage>;
  get(folder: MailFolder, localId: string): Promise<MailPrivateMessage>;
  search(folder: MailFolder, query: string, limit?: number): Promise<MailPrivateSearchResult>;
};

export class MailPrivateTileClient implements MailPrivateTilePort {
  readonly #target: MsgBusEndpointId;

  constructor(target = defaultResidentTarget()) {
    this.#target = target;
  }

  async list(request: Parameters<MailPrivateTilePort["list"]>[0]): Promise<MailPrivateListPage> {
    const result = parsePrivateResult(
      await callTool({
        target: this.#target,
        name: MAIL_PRIVATE_LIST_TOOL,
        arguments: request,
      }, 45),
      "page",
      parseMailPrivateListPage,
    );
    return result;
  }

  async get(folder: MailFolder, localId: string): Promise<MailPrivateMessage> {
    return parsePrivateResult(
      await callTool({
        target: this.#target,
        name: MAIL_PRIVATE_GET_TOOL,
        arguments: { folder, localId },
      }, 45),
      "message",
      parseMailPrivateMessage,
    );
  }

  async search(
    folder: MailFolder,
    query: string,
    limit = 50,
  ): Promise<MailPrivateSearchResult> {
    return parsePrivateResult(
      await callTool({
        target: this.#target,
        name: MAIL_PRIVATE_SEARCH_TOOL,
        arguments: { folder, query, limit },
      }, 15),
      "search",
      parseSearch,
    );
  }
}

export function privateFailure(error: unknown): JsonObject {
  const code: MailPrivateErrorCode = error instanceof MailPrivateError
    ? error.code
    : "temporarily_unavailable";
  const message = code === "mail_locked"
    ? "Private Mail is still preparing. Try again."
    : code === "capability_changed"
      ? "Mail key access changed. Try again."
      : "Private mail is temporarily unavailable.";
  return { ok: false, error: { code, message } };
}

function parsePrivateResult<T>(
  value: unknown,
  field: string,
  parse: (value: unknown) => T,
): T {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new MailPrivateError("temporarily_unavailable", "Invalid private Mail response");
  }
  if (!value.ok) {
    const result = exactObject(value, ["ok", "error"], "private Mail error result");
    const error = exactObject(result.error, ["code", "message"], "private Mail error");
    if (!isErrorCode(error.code) || typeof error.message !== "string") {
      throw new MailPrivateError("temporarily_unavailable", "Invalid private Mail error");
    }
    throw new MailPrivateError(error.code, error.message);
  }
  const result = exactObject(value, ["ok", field], "private Mail result");
  return parse(result[field]);
}

export function parseMailPrivateListPage(value: unknown): MailPrivateListPage {
  const page = exactObject(value, [
    "revision",
    "contactsRevision",
    "cleanupEpoch",
    "items",
    "total",
    "nextOffset",
    "ciphertextBytes",
  ], "private Mail page");
  if (!Array.isArray(page.items) || page.items.length > 50) invalid();
  return {
    revision: decimal(page.revision),
    contactsRevision: decimal(page.contactsRevision),
    cleanupEpoch: decimal(page.cleanupEpoch),
    items: (page.items as unknown[]).map(parseRow),
    total: decimal(page.total),
    nextOffset: page.nextOffset === null ? null : decimal(page.nextOffset),
    ciphertextBytes: decimal(page.ciphertextBytes),
  };
}

export function parseMailPrivateMessage(value: unknown): MailPrivateMessage {
  const record = exactObject(value, [
    "folder",
    "localId",
    "messageId",
    "peerPrincipal",
    "currentContact",
    "timestampNs",
    "read",
    "deliveryStatus",
    "replyContextLabel",
    "decryption",
    "bodyMarkdown",
  ], "private Mail message");
  // The exact message shape adds one body field to the exact row shape.
  // Project only the authenticated row fields before applying the strict row
  // parser; passing the superset would correctly look like schema smuggling.
  const row = parseRow({
    folder: record.folder,
    localId: record.localId,
    messageId: record.messageId,
    peerPrincipal: record.peerPrincipal,
    currentContact: record.currentContact,
    timestampNs: record.timestampNs,
    read: record.read,
    deliveryStatus: record.deliveryStatus,
    replyContextLabel: record.replyContextLabel,
    decryption: record.decryption,
  });
  if (record.bodyMarkdown !== null) {
    try {
      validateBodyMarkdown(record.bodyMarkdown);
    } catch {
      invalid();
    }
  }
  if (
    (row.decryption.state === "ready" && record.bodyMarkdown === null) ||
    (row.decryption.state === "corrupt" && record.bodyMarkdown !== null)
  ) invalid();
  return { ...row, bodyMarkdown: record.bodyMarkdown as string | null };
}

function parseSearch(value: unknown): MailPrivateSearchResult {
  const result = exactObject(value, ["query", "folder", "items"], "private Mail search");
  if (
    typeof result.query !== "string" ||
    result.query.length > 120 ||
    !Array.isArray(result.items) ||
    result.items.length > 50
  ) invalid();
  const folder = parseFolder(result.folder);
  const items = (result.items as unknown[]).map(parseRow);
  if (items.some((item) => item.folder !== folder)) invalid();
  return { query: result.query, folder, items };
}

function parseRow(value: unknown): MailPrivateRow {
  const row = exactObject(value, [
    "folder",
    "localId",
    "messageId",
    "peerPrincipal",
    "currentContact",
    "timestampNs",
    "read",
    "deliveryStatus",
    "replyContextLabel",
    "decryption",
  ], "private Mail row");
  const folder = parseFolder(row.folder);
  if (
    typeof row.peerPrincipal !== "string" ||
    row.peerPrincipal.length < 3 ||
    row.peerPrincipal.length > 80 ||
    !/^[a-z0-9-]+$/u.test(row.peerPrincipal) ||
    typeof row.timestampNs !== "string" ||
    !/^(0|-?[1-9][0-9]*)$/u.test(row.timestampNs) ||
    typeof row.read !== "boolean"
  ) invalid();
  if (
    typeof row.messageId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(row.messageId) ||
    (row.replyContextLabel !== null && row.replyContextLabel !== "Reply to an earlier message")
  ) invalid();
  const deliveryStatus = parseDeliveryStatus(row.deliveryStatus);
  if (
    (folder === "inbox" && deliveryStatus !== null) ||
    (folder !== "inbox" && (deliveryStatus === null || row.read !== true))
  ) invalid();
  return {
    folder,
    localId: positiveDecimal(row.localId),
    messageId: row.messageId,
    peerPrincipal: row.peerPrincipal,
    currentContact: parseContact(row.currentContact),
    timestampNs: row.timestampNs,
    read: row.read,
    deliveryStatus,
    replyContextLabel: row.replyContextLabel as MailPrivateRow["replyContextLabel"],
    decryption: parseDecryption(row.decryption),
  };
}

function parseDecryption(value: unknown): MailPrivateDecryption {
  if (!isRecord(value) || (value.state !== "ready" && value.state !== "corrupt")) invalid();
  if (value.state === "corrupt") {
    exactObject(value, ["state"], "private Mail corruption state");
    return { state: "corrupt" };
  }
  const record = exactObject(value, ["state", "header"], "private Mail decryption state");
  const header = exactObject(record.header, [
    "claimedSenderName",
    "subject",
    "senderCreatedAtNs",
    "inReplyTo",
  ], "private Mail header");
  if (
    typeof header.senderCreatedAtNs !== "string" ||
    !/^(0|-?[1-9][0-9]*)$/u.test(header.senderCreatedAtNs) ||
    (header.inReplyTo !== null &&
      (typeof header.inReplyTo !== "string" || !/^[0-9a-f]{32}$/u.test(header.inReplyTo)))
  ) invalid();
  let claimedSenderName: string;
  let subject: string;
  try {
    claimedSenderName = validateClaimedSenderName(header.claimedSenderName);
    subject = validateSubject(header.subject);
  } catch {
    invalid();
  }
  return {
    state: "ready",
    header: {
      claimedSenderName,
      subject,
      senderCreatedAtNs: header.senderCreatedAtNs,
      inReplyTo: header.inReplyTo as string | null,
    },
  };
}

function parseContact(value: unknown): MailBackendCurrentContact {
  if (!isRecord(value) || typeof value.status !== "string") invalid();
  if (value.status === "not_in_contacts" || value.status === "contact_conflict") {
    exactObject(value, ["status"], "private Mail contact");
    return { status: value.status };
  }
  if (value.status !== "in_contacts") invalid();
  const contact = exactObject(
    value,
    ["status", "contactId", "contactRevision", "contactName"],
    "private Mail contact",
  );
  if (
    typeof contact.contactName !== "string" ||
    !contact.contactName.trim() ||
    [...contact.contactName].length > 120
  ) invalid();
  return {
    status: "in_contacts",
    contactId: positiveDecimal(contact.contactId),
    contactRevision: positiveDecimal(contact.contactRevision),
    contactName: contact.contactName,
  };
}

function parseFolder(value: unknown): MailFolder {
  if (value !== "inbox" && value !== "sent" && value !== "outbox") invalid();
  return value;
}

function parseDeliveryStatus(value: unknown): MailDeliveryStatus | null {
  if (value === null) return null;
  if (
    value !== "sending" &&
    value !== "accepted" &&
    value !== "not_sent" &&
    value !== "delivery_uncertain"
  ) invalid();
  return value;
}

function exactObject(value: unknown, keys: readonly string[], label: string): JsonObject {
  if (!isRecord(value)) throw new MailPrivateError("temporarily_unavailable", `Invalid ${label}`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw new MailPrivateError("temporarily_unavailable", `Invalid ${label}`);
  }
  return value as JsonObject;
}

function decimal(value: unknown): string {
  try {
    return validateUnsignedDecimal(value, "Private Mail decimal");
  } catch {
    invalid();
  }
}

function positiveDecimal(value: unknown): string {
  const parsed = decimal(value);
  if (parsed === "0") invalid();
  return parsed;
}

function invalid(): never {
  throw new MailPrivateError("temporarily_unavailable", "Invalid private Mail response");
}

function isErrorCode(value: unknown): value is MailPrivateErrorCode {
  return value === "mail_locked" ||
    value === "capability_changed" ||
    value === "temporarily_unavailable";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function defaultResidentTarget(): MsgBusEndpointId {
  const context = loadTileContext();
  return `app:${context.app ?? "mail"}:background` as MsgBusEndpointId;
}

function objectSchema(required: readonly string[], properties: JsonObject): JsonObject {
  return { type: "object", required: [...required], properties, additionalProperties: false };
}

function privateResultSchema(field: string, schema: JsonObject): JsonObject {
  return {
    oneOf: [
      objectSchema(["ok", field], { ok: { const: true }, [field]: schema }),
      objectSchema(["ok", "error"], { ok: { const: false }, error: privateErrorSchema }),
    ],
  };
}
