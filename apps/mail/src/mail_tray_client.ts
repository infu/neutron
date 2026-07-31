import {
  callTool,
  type ExposedToolOptions,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import {
  MAIL_PRIVATE_LIST_PAGE_SCHEMA,
  parseMailPrivateListPage,
} from "./mail_private_client.ts";
import {
  MAIL_TRAY_PROJECTION_TOOL,
  type MailTrayProjection,
} from "./mail_tray_projection.ts";

const decimalSchema: JsonObject = {
  type: "string",
  pattern: "^0$|^[1-9][0-9]*$",
  maxLength: 20,
};

export const MAIL_TRAY_PROJECTION_OPTIONS: ExposedToolOptions = {
  title: "Read Recent Private Mail Headers",
  description:
    "Internal Mail-tray projection. Prepares and returns at most five authenticated Inbox headers; it never fetches a body or exposes key material.",
  inputSchema: objectSchema(
    ["expectedRevision", "expectedContactsRevision"],
    {
      expectedRevision: decimalSchema,
      expectedContactsRevision: decimalSchema,
    },
  ),
  outputSchema: {
    oneOf: [
      objectSchema(["version", "state"], {
        version: { const: 1 },
        state: { const: "loading" },
      }),
      objectSchema(["version", "state"], {
        version: { const: 1 },
        state: { const: "not_configured" },
      }),
      objectSchema(["version", "state"], {
        version: { const: 1 },
        state: { const: "unavailable" },
      }),
      objectSchema(["version", "state", "page"], {
        version: { const: 1 },
        state: { const: "ready" },
        page: MAIL_PRIVATE_LIST_PAGE_SCHEMA,
      }),
    ],
  },
  annotations: { "neutron:effects": ["read"] },
};

export class MailTrayProjectionClient {
  readonly #target: MsgBusEndpointId;

  constructor(target = "app:mail:background" as MsgBusEndpointId) {
    this.#target = target;
  }

  async snapshot(input: {
    expectedRevision: string;
    expectedContactsRevision: string;
  }): Promise<MailTrayProjection> {
    return parseMailTrayProjection(await callTool({
      target: this.#target,
      name: MAIL_TRAY_PROJECTION_TOOL,
      arguments: input,
    }, 45));
  }
}

export function parseMailTrayProjection(value: unknown): MailTrayProjection {
  const record = exactObject(value, "Mail tray projection");
  if (record.version !== 1 || typeof record.state !== "string") invalid();
  if (
    record.state === "loading" ||
    record.state === "not_configured" ||
    record.state === "unavailable"
  ) {
    exactKeys(record, ["version", "state"]);
    return { version: 1, state: record.state };
  }
  if (record.state !== "ready") invalid();
  exactKeys(record, ["version", "state", "page"]);
  const page = parseMailPrivateListPage(record.page);
  if (page.items.length > 5 || page.items.some((item) => item.folder !== "inbox")) invalid();
  return {
    version: 1,
    state: "ready",
    page,
  };
}

function objectSchema(required: readonly string[], properties: JsonObject): JsonObject {
  return { type: "object", required: [...required], properties, additionalProperties: false };
}

function exactObject(value: unknown, label: string): Record<string, JsonValue> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`Invalid ${label}`);
  return value as Record<string, JsonValue>;
}

function exactKeys(value: Record<string, JsonValue>, keys: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) invalid();
}

function invalid(): never {
  throw new Error("Invalid Mail tray projection");
}
