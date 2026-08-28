import type { JsonValue } from "neutron-tools/app";

export const QUERY_PROTOCOL_VERSION = 1 as const;

export type QueryRequest = Readonly<{
  type: "blast:query:run";
  version: typeof QUERY_PROTOCOL_VERSION;
  expression: string;
  input: JsonValue;
  timeoutMs: number;
}>;

export type QueryResponse =
  | Readonly<{
      type: "blast:query:result";
      version: typeof QUERY_PROTOCOL_VERSION;
      ok: true;
      value: JsonValue;
    }>
  | Readonly<{
      type: "blast:query:result";
      version: typeof QUERY_PROTOCOL_VERSION;
      ok: false;
      error: string;
    }>;

export function isQueryRequest(value: unknown): value is QueryRequest {
  if (!isRecord(value)) return false;
  return (
    value.type === "blast:query:run" &&
    value.version === QUERY_PROTOCOL_VERSION &&
    typeof value.expression === "string" &&
    Number.isSafeInteger(value.timeoutMs) &&
    (value.timeoutMs as number) > 0 &&
    Object.hasOwn(value, "input")
  );
}

export function isQueryResponse(value: unknown): value is QueryResponse {
  if (
    !isRecord(value) ||
    value.type !== "blast:query:result" ||
    value.version !== QUERY_PROTOCOL_VERSION ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  return value.ok
    ? Object.hasOwn(value, "value") && !Object.hasOwn(value, "error")
    : typeof value.error === "string" && !Object.hasOwn(value, "value");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
