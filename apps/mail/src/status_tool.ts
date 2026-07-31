import type { JsonObject } from "neutron-tools/app";
import type { MailBackendStatus } from "./backend.ts";
import type { MailPrivateAvailability } from "./model.ts";

const decimalSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 78,
  pattern: "^0$|^[1-9][0-9]*$",
};

const optionalDecimalSchema: JsonObject = {
  oneOf: [decimalSchema, { type: "null" }],
};

export const MAIL_STATUS_OUTPUT_FIELDS = Object.freeze([
  "revision",
  "contactsRevision",
  "cleanupEpoch",
  "privateMailActive",
  "privateMailState",
  "keyHolder",
  "currentEpoch",
  "previousEpoch",
  "encryptedSettingsRevision",
  "unread",
  "inboxCount",
  "inboxBytes",
  "unknownInboxCount",
  "unknownInboxBytes",
  "sentCount",
  "outboxCount",
  "activeSends",
  "sentAndOutboxBytes",
  "storageLevel",
] as const);

export type MailStatusToolResult = MailBackendStatus & {
  privateMailState: MailPrivateAvailability;
};

export const MAIL_STATUS_OUTPUT_SCHEMA: JsonObject = {
  type: "object",
  required: [...MAIL_STATUS_OUTPUT_FIELDS],
  properties: {
    revision: decimalSchema,
    contactsRevision: decimalSchema,
    cleanupEpoch: decimalSchema,
    privateMailActive: { type: "boolean" },
    privateMailState: {
      type: "string",
      enum: ["not_configured", "preparing", "ready", "unavailable"],
    },
    keyHolder: {
      oneOf: [
        {
          type: "string",
          minLength: 3,
          maxLength: 80,
          pattern: "^[a-z0-9-]+$",
        },
        { type: "null" },
      ],
    },
    currentEpoch: optionalDecimalSchema,
    previousEpoch: optionalDecimalSchema,
    encryptedSettingsRevision: optionalDecimalSchema,
    unread: decimalSchema,
    inboxCount: decimalSchema,
    inboxBytes: decimalSchema,
    unknownInboxCount: decimalSchema,
    unknownInboxBytes: decimalSchema,
    sentCount: decimalSchema,
    outboxCount: decimalSchema,
    activeSends: decimalSchema,
    sentAndOutboxBytes: decimalSchema,
    storageLevel: {
      type: "string",
      enum: ["normal", "approaching_limit", "almost_full"],
    },
  },
  additionalProperties: false,
};

export function projectMailStatusTool(
  status: MailBackendStatus,
  residentState: MailPrivateAvailability = status.privateMailActive
    ? "preparing"
    : "not_configured",
): MailStatusToolResult {
  const privateMailState: MailPrivateAvailability = !status.privateMailActive
    ? "not_configured"
    : residentState === "ready"
      ? "ready"
      : residentState === "unavailable"
        ? "unavailable"
        : "preparing";
  return {
    ...status,
    privateMailState,
  };
}
