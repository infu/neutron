import {
  callTool,
  loadTileContext,
  type ExposedToolOptions,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import {
  MAIL_PRIVATE_RETRY_TOOL,
  MAIL_PRIVATE_ACCESS_PREPARE_TOOL,
  MAIL_PRIVATE_SEND_TOOL,
  MAIL_PRIVATE_SETTINGS_GET_TOOL,
  MAIL_PRIVATE_SETTINGS_SET_TOOL,
  MailComposeError,
  type MailComposeErrorCode,
  type MailPrivateDelivery,
  type MailPrivateSendRequest,
  type MailPrivateSettings,
} from "./mail_compose.ts";
import {
  parseMailDeliveryAccessRequest,
  projectMailDeliveryAccessRequest,
  type MailDeliveryAccessRequest,
} from "./mail_delivery_access.ts";
import { MAIL_MAX_ENVELOPE_BYTES } from "./protocol.ts";
import { validateClaimedSenderName } from "./model.ts";

const positiveDecimalSchema: JsonObject = {
  type: "string",
  pattern: "^[1-9][0-9]*$",
  maxLength: 20,
};
const commandIdSchema: JsonObject = {
  type: "string",
  pattern: "^[0-9a-f]{32}$",
  minLength: 32,
  maxLength: 32,
};
const recipientSchema: JsonObject = {
  oneOf: [
    objectSchema(["kind", "principal"], {
      kind: { const: "direct" },
      principal: { type: "string", minLength: 3, maxLength: 80 },
    }),
    objectSchema(
      ["kind", "principal", "contactId", "expectedContactRevision"],
      {
        kind: { const: "contact" },
        principal: { type: "string", minLength: 3, maxLength: 80 },
        contactId: positiveDecimalSchema,
        expectedContactRevision: positiveDecimalSchema,
      },
    ),
  ],
};
const hexSchema = (bytes: number): JsonObject => ({
  type: "string",
  pattern: `^[0-9a-f]{${bytes * 2}}$`,
  minLength: bytes * 2,
  maxLength: bytes * 2,
});
const accessRequestSchema = objectSchema(["recipient", "permitRequestId"], {
  recipient: recipientSchema,
  permitRequestId: hexSchema(16),
});
const accessPreparationSchema = objectSchema(["request", "prepared"], {
  request: accessRequestSchema,
  prepared: objectSchema([
    "permitId", "recipient", "contactId", "contactRevision", "bookRevision",
    "expiresAtNs", "publicInfoHash", "keyInfo",
  ], {
    permitId: hexSchema(32),
    recipient: { type: "string", minLength: 3, maxLength: 80 },
    contactId: { oneOf: [positiveDecimalSchema, { type: "null" }] },
    contactRevision: { oneOf: [positiveDecimalSchema, { type: "null" }] },
    bookRevision: { type: "string", pattern: "^0$|^[1-9][0-9]*$", maxLength: 20 },
    expiresAtNs: { type: "string", pattern: "^0$|^[1-9][0-9]*$", maxLength: 24 },
    publicInfoHash: hexSchema(32),
    keyInfo: objectSchema([
      "protocolVersion", "suite", "deliveryKeyEpoch", "contextPublicKey",
      "effectiveIbeIdentity", "recipientKeyFingerprint", "maxEnvelopeBytes",
    ], {
      protocolVersion: { const: 1 },
      suite: { const: 1 },
      deliveryKeyEpoch: positiveDecimalSchema,
      contextPublicKey: hexSchema(96),
      effectiveIbeIdentity: hexSchema(32),
      recipientKeyFingerprint: hexSchema(32),
      maxEnvelopeBytes: { const: MAIL_MAX_ENVELOPE_BYTES },
    }),
  }),
});
const draftFields: JsonObject = {
  subject: { type: "string", minLength: 1, maxLength: 512 },
  bodyMarkdown: { type: "string", maxLength: 32_768 },
};
const sendRequestSchema: JsonObject = {
  oneOf: [
    objectSchema(["kind", "commandId", "recipient", "subject", "bodyMarkdown"], {
      kind: { const: "new" },
      commandId: commandIdSchema,
      recipient: recipientSchema,
      ...draftFields,
      approvedPreparation: accessPreparationSchema,
    }),
    objectSchema(["kind", "commandId", "replyTo", "subject", "bodyMarkdown"], {
      kind: { const: "reply" },
      commandId: commandIdSchema,
      replyTo: objectSchema(["folder", "localId"], {
        folder: { const: "inbox" },
        localId: positiveDecimalSchema,
      }),
      ...draftFields,
      approvedPreparation: accessPreparationSchema,
    }),
  ],
};
const composeErrorSchema: JsonObject = objectSchema(["code", "message"], {
  code: {
    type: "string",
    enum: [
      "mail_locked",
      "delivery_uncertain",
      "delivery_state_changed",
      "sender_name_required",
      "invalid_draft",
      "recipient_changed",
      "recipient_unavailable",
      "permission_required",
      "mailbox_full",
      "settings_changed",
      "message_unavailable",
      "capability_changed",
      "not_retryable",
      "temporarily_unavailable",
    ],
  },
  message: { type: "string", minLength: 1, maxLength: 200 },
});
const deliverySchema = objectSchema(
  [
    "localId",
    "revision",
    "cleanupEpoch",
    "attemptNo",
    "status",
    "notSentReason",
    "updatedAtNs",
    "staleReplacementFor",
  ],
  {
    localId: positiveDecimalSchema,
    revision: { type: "string", pattern: "^0$|^[1-9][0-9]*$", maxLength: 20 },
    cleanupEpoch: { type: "string", pattern: "^0$|^[1-9][0-9]*$", maxLength: 20 },
    attemptNo: positiveDecimalSchema,
    status: {
      type: "string",
      enum: ["sending", "accepted", "not_sent", "delivery_uncertain"],
    },
    notSentReason: {
      type: ["string", "null"],
      enum: [
        "invalid",
        "rate_limited",
        "mailbox_full",
        "stale_key",
        "crypto_unavailable",
        "permission_required",
        null,
      ],
    },
    updatedAtNs: { type: "string", pattern: "^0$|^-?[1-9][0-9]*$", maxLength: 24 },
    staleReplacementFor: {
      oneOf: [positiveDecimalSchema, { type: "null" }],
    },
  },
);
const settingsSchema = objectSchema(["configured", "senderName", "revision"], {
  configured: { type: "boolean" },
  senderName: { oneOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }] },
  revision: { oneOf: [positiveDecimalSchema, { type: "null" }] },
});

export const MAIL_PRIVATE_SEND_OPTIONS: ExposedToolOptions = {
  title: "Encrypt and Send Mail",
  description:
    "Internal same-app tile operation. Validates resident plaintext, encrypts it in the key worker, and sends only ciphertext to the backend.",
  inputSchema: sendRequestSchema,
  outputSchema: resultSchema("delivery", deliverySchema),
  annotations: { "neutron:effects": ["read", "write", "network"] },
};

export const MAIL_PRIVATE_ACCESS_PREPARE_OPTIONS: ExposedToolOptions = {
  title: "Prepare Private Mail Delivery Access",
  description:
    "Internal same-app tile operation. Resolves one exact authenticated recipient and creates a bounded access request; it does not grant backend access.",
  inputSchema: sendRequestSchema,
  outputSchema: resultSchema("accessRequest", accessRequestSchema),
  annotations: { "neutron:effects": ["read"] },
};

export const MAIL_PRIVATE_RETRY_OPTIONS: ExposedToolOptions = {
  title: "Retry Encrypted Mail",
  description:
    "Internal same-app tile operation. Retries the exact ciphertext already stored in one Outbox record.",
  inputSchema: objectSchema(["localId"], { localId: positiveDecimalSchema }),
  outputSchema: resultSchema("delivery", deliverySchema),
  annotations: { "neutron:effects": ["write", "network"] },
};

export const MAIL_PRIVATE_SETTINGS_GET_OPTIONS: ExposedToolOptions = {
  title: "Decrypt Mail Sender Settings",
  description:
    "Internal same-app tile operation. Decrypts the local sender name in the resident worker.",
  inputSchema: objectSchema([], {}),
  outputSchema: resultSchema("settings", settingsSchema),
  annotations: { "neutron:effects": ["read"] },
};

export const MAIL_PRIVATE_SETTINGS_SET_OPTIONS: ExposedToolOptions = {
  title: "Encrypt Mail Sender Settings",
  description:
    "Internal same-app tile operation. Encrypts the sender name before storing the new settings revision.",
  inputSchema: objectSchema(["senderName"], {
    senderName: { type: "string", minLength: 1, maxLength: 256 },
  }),
  outputSchema: resultSchema("settings", settingsSchema),
  annotations: { "neutron:effects": ["write"] },
};

export type MailComposeTilePort = {
  prepareDeliveryAccess(request: MailPrivateSendRequest): Promise<MailDeliveryAccessRequest>;
  send(request: MailPrivateSendRequest): Promise<MailPrivateDelivery>;
  retry(localId: string): Promise<MailPrivateDelivery>;
  getSettings(): Promise<MailPrivateSettings>;
  setSenderName(senderName: string): Promise<MailPrivateSettings>;
};

export class MailComposeTileClient implements MailComposeTilePort {
  readonly #target: MsgBusEndpointId;

  constructor(target = defaultResidentTarget()) {
    this.#target = target;
  }

  async prepareDeliveryAccess(request: MailPrivateSendRequest): Promise<MailDeliveryAccessRequest> {
    return parseResult(
      await callTool({
        target: this.#target,
        name: MAIL_PRIVATE_ACCESS_PREPARE_TOOL,
        arguments: request,
      }, 45),
      "accessRequest",
      (value) => projectMailDeliveryAccessRequest(parseMailDeliveryAccessRequest(value)),
    );
  }

  async send(request: MailPrivateSendRequest): Promise<MailPrivateDelivery> {
    return parseResult(
      await callTool({
        target: this.#target,
        name: MAIL_PRIVATE_SEND_TOOL,
        arguments: request,
      }, 120),
      "delivery",
      parseDelivery,
    );
  }

  async retry(localId: string): Promise<MailPrivateDelivery> {
    return parseResult(
      await callTool({
        target: this.#target,
        name: MAIL_PRIVATE_RETRY_TOOL,
        arguments: { localId },
      }, 120),
      "delivery",
      parseDelivery,
    );
  }

  async getSettings(): Promise<MailPrivateSettings> {
    return parseResult(
      await callTool({
        target: this.#target,
        name: MAIL_PRIVATE_SETTINGS_GET_TOOL,
        arguments: {},
      }, 30),
      "settings",
      parseSettings,
    );
  }

  async setSenderName(senderName: string): Promise<MailPrivateSettings> {
    return parseResult(
      await callTool({
        target: this.#target,
        name: MAIL_PRIVATE_SETTINGS_SET_TOOL,
        arguments: { senderName },
      }, 45),
      "settings",
      parseSettings,
    );
  }
}

export function composeFailure(error: unknown): JsonObject {
  const compose = error instanceof MailComposeError
    ? error
    : new MailComposeError(
        "temporarily_unavailable",
        "Private Mail is temporarily unavailable. Your unsent text remains in this tile.",
      );
  return { ok: false, error: { code: compose.code, message: compose.message } };
}

function parseResult<T>(
  value: unknown,
  field: string,
  parser: (value: unknown) => T,
): T {
  const result = exactObject(value, "private Mail result");
  if (result.ok === false) {
    if (Object.keys(result).length !== 2 || !("error" in result)) invalid();
    const error = exactObject(result.error, "private Mail error");
    if (
      Object.keys(error).length !== 2 ||
      !isComposeCode(error.code) ||
      typeof error.message !== "string" ||
      !error.message
    ) invalid();
    throw new MailComposeError(error.code, error.message);
  }
  if (result.ok !== true || Object.keys(result).length !== 2 || !(field in result)) invalid();
  return parser(result[field]);
}

function parseDelivery(value: unknown): MailPrivateDelivery {
  const delivery = exactKeys(value, [
    "localId",
    "revision",
    "cleanupEpoch",
    "attemptNo",
    "status",
    "notSentReason",
    "updatedAtNs",
    "staleReplacementFor",
  ]);
  const status = delivery.status;
  if (
    status !== "sending" &&
    status !== "accepted" &&
    status !== "not_sent" &&
    status !== "delivery_uncertain"
  ) invalid();
  const reason = delivery.notSentReason;
  if (
    reason !== null &&
    reason !== "invalid" &&
    reason !== "rate_limited" &&
    reason !== "mailbox_full" &&
    reason !== "stale_key" &&
    reason !== "crypto_unavailable" &&
    reason !== "permission_required"
  ) invalid();
  if ((status === "not_sent") !== (reason !== null)) invalid();
  if (typeof delivery.updatedAtNs !== "string" || !/^(0|-?[1-9][0-9]*)$/u.test(delivery.updatedAtNs)) {
    invalid();
  }
  return {
    localId: positiveDecimal(delivery.localId),
    revision: decimal(delivery.revision),
    cleanupEpoch: decimal(delivery.cleanupEpoch),
    attemptNo: positiveDecimal(delivery.attemptNo),
    status,
    notSentReason: reason,
    updatedAtNs: delivery.updatedAtNs,
    staleReplacementFor: delivery.staleReplacementFor === null
      ? null
      : positiveDecimal(delivery.staleReplacementFor),
  };
}

function parseSettings(value: unknown): MailPrivateSettings {
  const settings = exactKeys(value, ["configured", "senderName", "revision"]);
  if (typeof settings.configured !== "boolean") invalid();
  if (!settings.configured) {
    if (settings.senderName !== null || settings.revision !== null) invalid();
    return { configured: false, senderName: null, revision: null };
  }
  let senderName: string;
  try {
    senderName = validateClaimedSenderName(settings.senderName);
  } catch {
    invalid();
  }
  return {
    configured: true,
    senderName,
    revision: positiveDecimal(settings.revision),
  };
}

function objectSchema(required: readonly string[], properties: JsonObject): JsonObject {
  return { type: "object", required: [...required], properties, additionalProperties: false };
}

function resultSchema(field: string, schema: JsonObject): JsonObject {
  return {
    oneOf: [
      objectSchema(["ok", field], { ok: { const: true }, [field]: schema }),
      objectSchema(["ok", "error"], { ok: { const: false }, error: composeErrorSchema }),
    ],
  };
}

function exactObject(value: unknown, label: string): Record<string, JsonValue> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new MailComposeError("temporarily_unavailable", `Invalid ${label}`);
  return value as Record<string, JsonValue>;
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, JsonValue> {
  const result = exactObject(value, "private Mail response");
  const actual = Object.keys(result);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) invalid();
  return result;
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 20) invalid();
  return value;
}

function positiveDecimal(value: unknown): string {
  const result = decimal(value);
  if (result === "0") invalid();
  return result;
}

function isComposeCode(value: unknown): value is MailComposeErrorCode {
  return value === "mail_locked" ||
    value === "delivery_uncertain" ||
    value === "delivery_state_changed" ||
    value === "sender_name_required" ||
    value === "invalid_draft" ||
    value === "recipient_changed" ||
    value === "recipient_unavailable" ||
    value === "permission_required" ||
    value === "mailbox_full" ||
    value === "settings_changed" ||
    value === "message_unavailable" ||
    value === "capability_changed" ||
    value === "not_retryable" ||
    value === "temporarily_unavailable";
}

function invalid(): never {
  throw new MailComposeError("temporarily_unavailable", "Invalid private Mail response");
}

function defaultResidentTarget(): MsgBusEndpointId {
  const context = loadTileContext();
  return `app:${context.app ?? "mail"}:background` as MsgBusEndpointId;
}
