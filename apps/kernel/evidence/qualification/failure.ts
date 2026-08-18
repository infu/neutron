const QUALIFICATION_FAILURE_MAX_ERRORS = 8;
const QUALIFICATION_FAILURE_MAX_NAME_JSON_BYTES = 128;
const QUALIFICATION_FAILURE_MAX_MESSAGE_JSON_BYTES = 512;
const QUALIFICATION_FAILURE_MAX_STACK_JSON_BYTES = 1024;
export const QUALIFICATION_FAILURE_MAX_DIAGNOSTIC_BYTES = 16 * 1024;

type FailureTraversalState =
  | "complete"
  | "cycle"
  | "truncated"
  | "unreadable";

type PendingFailure = Readonly<{
  value: unknown;
  depth: number;
}>;

/**
 * Render bounded failure diagnostics without relying on Error.stack to carry
 * the Error name or message. The qualification worker has emitted a bare
 * `Error` stack despite contextual wrappers, so every cause and AggregateError
 * member is read and printed independently. Property access is guarded because
 * JavaScript permits hostile thrown proxies and accessors.
 */
export function formatQualificationFailure(error: unknown): string {
  const errors: Array<{
    depth: number;
    name: string;
    message: string;
    stack: string;
  }> = [];
  const states = new Set<FailureTraversalState>();
  const seen = new Set<object>();
  const pending: PendingFailure[] = [{ value: error, depth: 0 }];

  while (
    pending.length > 0 &&
    errors.length < QUALIFICATION_FAILURE_MAX_ERRORS
  ) {
    const current = pending.shift()!;
    if (!isReference(current.value)) {
      errors.push({
        depth: current.depth,
        name: boundedJsonStringValue(
          `thrown-${typeof current.value}`,
          QUALIFICATION_FAILURE_MAX_NAME_JSON_BYTES,
        ),
        message: boundedJsonStringValue(
          primitiveFailureText(current.value),
          QUALIFICATION_FAILURE_MAX_MESSAGE_JSON_BYTES,
        ),
        stack: "",
      });
      continue;
    }
    if (seen.has(current.value)) {
      states.add("cycle");
      continue;
    }
    seen.add(current.value);
    errors.push({
      depth: current.depth,
      name: boundedFailureProperty(
        current.value,
        "name",
        QUALIFICATION_FAILURE_MAX_NAME_JSON_BYTES,
      ),
      message: boundedFailureProperty(
        current.value,
        "message",
        QUALIFICATION_FAILURE_MAX_MESSAGE_JSON_BYTES,
      ),
      stack: boundedFailureProperty(
        current.value,
        "stack",
        QUALIFICATION_FAILURE_MAX_STACK_JSON_BYTES,
      ),
    });

    const cause = readFailureProperty(current.value, "cause");
    if (!cause.readable) {
      states.add("unreadable");
    } else if (cause.value !== undefined) {
      enqueueFailure(pending, {
        value: cause.value,
        depth: current.depth + 1,
      }, states, errors.length);
    }

    const aggregate = readAggregateErrors(current.value);
    if (!aggregate.readable) {
      states.add("unreadable");
    } else {
      for (const member of aggregate.values) {
        enqueueFailure(pending, {
          value: member,
          depth: current.depth + 1,
        }, states, errors.length);
      }
      if (aggregate.truncated) states.add("truncated");
    }
  }
  if (pending.length > 0) states.add("truncated");

  const diagnostic = JSON.stringify({
    schema: "neutron.kernel.certified-assets-qualification-failure.v1",
    cause_chain: failureTraversalState(states),
    errors,
  });
  if (
    Buffer.byteLength(diagnostic, "utf8") >
      QUALIFICATION_FAILURE_MAX_DIAGNOSTIC_BYTES
  ) {
    return JSON.stringify({
      schema: "neutron.kernel.certified-assets-qualification-failure.v1",
      cause_chain: "truncated",
      errors: errors.slice(0, 1).map(({ depth, name, message }) => ({
        depth,
        name,
        message,
        stack: "diagnostic-overflow",
      })),
    });
  }
  return diagnostic;
}

function enqueueFailure(
  pending: PendingFailure[],
  failure: PendingFailure,
  states: Set<FailureTraversalState>,
  renderedCount: number,
): void {
  if (
    renderedCount + pending.length >= QUALIFICATION_FAILURE_MAX_ERRORS
  ) {
    states.add("truncated");
    return;
  }
  pending.push(failure);
}

function readAggregateErrors(value: object): Readonly<
  | { readable: true; values: readonly unknown[]; truncated: boolean }
  | { readable: false }
> {
  const property = readFailureProperty(value, "errors");
  if (!property.readable) return { readable: false };
  if (property.value === undefined) {
    return { readable: true, values: [], truncated: false };
  }
  let isArray: boolean;
  try {
    isArray = Array.isArray(property.value);
  } catch {
    return { readable: false };
  }
  if (!isArray) {
    return { readable: true, values: [], truncated: false };
  }
  const values: unknown[] = [];
  let length: number;
  try {
    length = (property.value as unknown[]).length;
  } catch {
    return { readable: false };
  }
  const retained = Math.min(length, QUALIFICATION_FAILURE_MAX_ERRORS);
  for (let index = 0; index < retained; index += 1) {
    try {
      values.push((property.value as unknown[])[index]);
    } catch {
      return { readable: false };
    }
  }
  return {
    readable: true,
    values,
    truncated: length > retained,
  };
}

function failureTraversalState(
  states: ReadonlySet<FailureTraversalState>,
): FailureTraversalState {
  if (states.has("unreadable")) return "unreadable";
  if (states.has("truncated")) return "truncated";
  if (states.has("cycle")) return "cycle";
  return "complete";
}

function boundedFailureProperty(
  value: object,
  property: "name" | "message" | "stack",
  maximumBytes: number,
): string {
  const result = readFailureProperty(value, property);
  if (!result.readable) return "unreadable";
  if (typeof result.value !== "string") {
    return boundedJsonStringValue(
      `non-string-${typeof result.value}`,
      maximumBytes,
    );
  }
  return boundedJsonStringValue(result.value, maximumBytes);
}

function boundedJsonStringValue(value: string, maximumBytes: number): string {
  if (
    value.length <= maximumBytes &&
    jsonStringBytes(value) <= maximumBytes
  ) {
    return value;
  }
  const marker = "...[truncated]";
  let low = 0;
  let high = Math.min(value.length, maximumBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonStringBytes(`${value.slice(0, middle)}${marker}`) <= maximumBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${value.slice(0, low)}${marker}`;
}

function jsonStringBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readFailureProperty(
  value: object,
  property: "name" | "message" | "stack" | "cause" | "errors",
): Readonly<
  | { readable: true; value: unknown }
  | { readable: false }
> {
  try {
    return {
      readable: true,
      value: (value as Record<string, unknown>)[property],
    };
  } catch {
    return { readable: false };
  }
}

function primitiveFailureText(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
    case "undefined":
    case "symbol":
      return String(value);
    default:
      return "unsupported thrown value";
  }
}

function isReference(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  );
}
