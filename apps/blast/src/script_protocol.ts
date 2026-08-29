import type { JsonObject, JsonValue } from "neutron-tools/app";
import { BLAST_LIMITS } from "./limits.ts";

export const SCRIPT_PROTOCOL_VERSION = 1 as const;

export type ScriptLimits = Readonly<{
  deadlineMs: number;
  memoryBytes: number;
  stackBytes: number;
  pendingJobs: number;
  resultBytes: number;
}>;

export type ScriptStartMessage = Readonly<{
  type: "blast:script:start";
  version: typeof SCRIPT_PROTOCOL_VERSION;
  runId: string;
  source: string;
  input: JsonValue;
  limits: ScriptLimits;
}>;

export type ScriptHostResponseMessage = Readonly<{
  type: "blast:script:host-response";
  version: typeof SCRIPT_PROTOCOL_VERSION;
  requestId: number;
  ok: boolean;
  value?: JsonValue;
  error?: string;
}>;

export type ScriptReadyMessage = Readonly<{
  type: "blast:script:ready";
  version: typeof SCRIPT_PROTOCOL_VERSION;
}>;

export type ScriptHostRequestMessage = Readonly<{
  type: "blast:script:host-request";
  version: typeof SCRIPT_PROTOCOL_VERSION;
  requestId: number;
  /** Successful host responses consumed by the guest before this request. */
  observedResponseIds: readonly number[];
  operation: string;
  arguments: JsonObject;
}>;

export type ScriptResultMessage = Readonly<{
  type: "blast:script:result";
  version: typeof SCRIPT_PROTOCOL_VERSION;
  ok: boolean;
  value?: JsonValue;
  error?: string;
}>;

export type ScriptWorkerMessage =
  | ScriptReadyMessage
  | ScriptHostRequestMessage
  | ScriptResultMessage;

export function isScriptHostResponseMessage(
  value: unknown,
): value is ScriptHostResponseMessage {
  if (!isRecord(value)) return false;
  if (
    value.type !== "blast:script:host-response" ||
    value.version !== SCRIPT_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.requestId) ||
    (value.requestId as number) < 1 ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.ok
    ? Object.hasOwn(value, "value") && !Object.hasOwn(value, "error")
    : typeof value.error === "string" && !Object.hasOwn(value, "value");
}

export function isScriptWorkerMessage(
  value: unknown,
): value is ScriptWorkerMessage {
  if (!isRecord(value) || value.version !== SCRIPT_PROTOCOL_VERSION) {
    return false;
  }
  if (value.type === "blast:script:ready") return true;
  if (value.type === "blast:script:host-request") {
    return (
      Number.isSafeInteger(value.requestId) &&
      (value.requestId as number) > 0 &&
      isScriptObservedResponseIds(
        value.observedResponseIds,
        value.requestId as number,
      ) &&
      typeof value.operation === "string" &&
      value.operation.length > 0 &&
      value.operation.length <= 64 &&
      isRecord(value.arguments)
    );
  }
  if (value.type !== "blast:script:result" || typeof value.ok !== "boolean") {
    return false;
  }
  return value.ok
    ? Object.hasOwn(value, "value") && !Object.hasOwn(value, "error")
    : typeof value.error === "string" && !Object.hasOwn(value, "value");
}

export function isScriptObservedResponseIds(
  value: unknown,
  requestId: number,
): value is readonly number[] {
  if (!Array.isArray(value) || value.length > BLAST_LIMITS.scriptHostCalls) {
    return false;
  }
  const unique = new Set<number>();
  for (const id of value) {
    if (
      !Number.isSafeInteger(id) ||
      id < 1 ||
      id >= requestId ||
      unique.has(id)
    ) {
      return false;
    }
    unique.add(id);
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
