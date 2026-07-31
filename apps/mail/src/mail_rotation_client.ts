import {
  callTool,
  type ExposedToolOptions,
  type JsonObject,
  type JsonValue,
  type MsgBusEndpointId,
} from "neutron-tools/app";
import type { MailBackendCryptoProgress } from "./backend.ts";
import {
  MAIL_CRYPTO_MIGRATE_TOOL,
  MailRotationError,
  type MailRotationErrorCode,
  type MailRotationStep,
} from "./mail_rotation.ts";

const decimalSchema: JsonObject = {
  type: "string",
  pattern: "^0$|^[1-9][0-9]*$",
  maxLength: 20,
};
const nullablePositiveDecimalSchema: JsonObject = {
  oneOf: [
    { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 20 },
    { type: "null" },
  ],
};
const referenceSchema = objectSchema(
  ["settings", "inbox", "outbox", "total"],
  {
    settings: decimalSchema,
    inbox: decimalSchema,
    outbox: decimalSchema,
    total: decimalSchema,
  },
);
const progressSchema = objectSchema(
  ["revision", "keyHolder", "currentEpoch", "previousEpoch", "previousReferences", "readyToRetire"],
  {
    revision: decimalSchema,
    keyHolder: { type: "string", minLength: 3, maxLength: 80 },
    currentEpoch: { type: "string", pattern: "^[1-9][0-9]*$", maxLength: 20 },
    previousEpoch: nullablePositiveDecimalSchema,
    previousReferences: referenceSchema,
    readyToRetire: { type: "boolean" },
  },
);
const stepSchema = objectSchema(
  ["version", "changed", "scanned", "scanComplete", "progress"],
  {
    version: { const: 1 },
    changed: decimalSchema,
    scanned: decimalSchema,
    scanComplete: { type: "boolean" },
    progress: progressSchema,
  },
);
const errorSchema = objectSchema(["code", "message"], {
  code: {
    type: "string",
    enum: [
      "not_rotating",
      "current_locked",
      "previous_locked",
      "capability_changed",
      "conflict",
      "unavailable",
    ],
  },
  message: { type: "string", minLength: 1, maxLength: 160 },
});

export const MAIL_CRYPTO_MIGRATE_OPTIONS: ExposedToolOptions = {
  title: "Migrate Private Mail Key Wraps",
  description:
    "Internal same-app tile operation. Rewraps at most fifty local CEKs after scanning at most four bounded pages; message ciphertext and delivery metadata are immutable.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  outputSchema: {
    oneOf: [
      objectSchema(["ok", "step"], { ok: { const: true }, step: stepSchema }),
      objectSchema(["ok", "error"], { ok: { const: false }, error: errorSchema }),
    ],
  },
  annotations: { "neutron:effects": ["write"] },
};

export class MailRotationTileClient {
  readonly #target: MsgBusEndpointId;

  constructor(target = "app:mail:background" as MsgBusEndpointId) {
    this.#target = target;
  }

  async migrateStep(): Promise<MailRotationStep> {
    return parseMailRotationResult(await callTool({
      target: this.#target,
      name: MAIL_CRYPTO_MIGRATE_TOOL,
      arguments: {},
    }, 90));
  }
}

export function mailRotationFailure(error: unknown): JsonObject {
  const code: MailRotationErrorCode = error instanceof MailRotationError
    ? error.code
    : "unavailable";
  const message = error instanceof MailRotationError
    ? error.message
    : "Mail key migration is temporarily unavailable";
  return { ok: false, error: { code, message: [...message].slice(0, 160).join("") } };
}

export function parseMailRotationResult(value: unknown): MailRotationStep {
  const result = exactObject(value, "Mail key migration result");
  if (typeof result.ok !== "boolean") invalid();
  if (!result.ok) {
    exactKeys(result, ["ok", "error"]);
    const error = exactObject(result.error, "Mail key migration error");
    exactKeys(error, ["code", "message"]);
    if (!isErrorCode(error.code) || typeof error.message !== "string" || !error.message) invalid();
    throw new MailRotationError(error.code, error.message);
  }
  exactKeys(result, ["ok", "step"]);
  const valueStep = exactObject(result.step, "Mail key migration step");
  exactKeys(valueStep, ["version", "changed", "scanned", "scanComplete", "progress"]);
  if (valueStep.version !== 1 || typeof valueStep.scanComplete !== "boolean") invalid();
  return {
    version: 1,
    changed: decimal(valueStep.changed),
    scanned: decimal(valueStep.scanned),
    scanComplete: valueStep.scanComplete,
    progress: parseProgress(valueStep.progress),
  };
}

function parseProgress(value: unknown): MailBackendCryptoProgress {
  const progress = exactObject(value, "Mail key rotation progress");
  exactKeys(progress, [
    "revision",
    "keyHolder",
    "currentEpoch",
    "previousEpoch",
    "previousReferences",
    "readyToRetire",
  ]);
  if (
    typeof progress.keyHolder !== "string" ||
    progress.keyHolder.length < 3 ||
    progress.keyHolder.length > 80 ||
    typeof progress.readyToRetire !== "boolean"
  ) invalid();
  const references = exactObject(progress.previousReferences, "Mail previous key references");
  exactKeys(references, ["settings", "inbox", "outbox", "total"]);
  const settings = decimal(references.settings);
  const inbox = decimal(references.inbox);
  const outbox = decimal(references.outbox);
  const total = decimal(references.total);
  if (BigInt(settings) + BigInt(inbox) + BigInt(outbox) !== BigInt(total)) invalid();
  const currentEpoch = positiveDecimal(progress.currentEpoch);
  const previousEpoch = progress.previousEpoch === null
    ? null
    : positiveDecimal(progress.previousEpoch);
  if (
    currentEpoch === previousEpoch ||
    progress.readyToRetire !== (previousEpoch !== null && total === "0")
  ) invalid();
  return {
    revision: decimal(progress.revision),
    keyHolder: progress.keyHolder,
    currentEpoch,
    previousEpoch,
    previousReferences: { settings, inbox, outbox, total },
    readyToRetire: progress.readyToRetire,
  };
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(value)) invalid();
  return BigInt(value).toString();
}

function positiveDecimal(value: unknown): string {
  const parsed = decimal(value);
  if (parsed === "0") invalid();
  return parsed;
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

function isErrorCode(value: unknown): value is MailRotationErrorCode {
  return value === "not_rotating" ||
    value === "current_locked" ||
    value === "previous_locked" ||
    value === "capability_changed" ||
    value === "conflict" ||
    value === "unavailable";
}

function objectSchema(required: readonly string[], properties: JsonObject): JsonObject {
  return { type: "object", required: [...required], properties, additionalProperties: false };
}

function invalid(): never {
  throw new Error("Invalid Mail key migration response");
}
