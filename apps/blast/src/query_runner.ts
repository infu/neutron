import type { JsonValue } from "neutron-tools/app";
import {
  assertBoundedBlastJson,
  boundedErrorOr,
  isUnicodeScalarText,
  unicodeScalarLength,
} from "./json.ts";
import { BLAST_LIMITS } from "./limits.ts";
import {
  QUERY_PROTOCOL_VERSION,
  isQueryResponse,
  type QueryRequest,
} from "./query_protocol.ts";

export async function runJsonataQuery(
  expression: string,
  input: JsonValue,
  signal?: AbortSignal,
): Promise<JsonValue> {
  if (
    expression.length < 1 ||
    !isUnicodeScalarText(expression) ||
    unicodeScalarLength(expression) > BLAST_LIMITS.jsonataExpressionCharacters
  ) {
    throw new Error("JSONata expression size is invalid");
  }
  assertBoundedBlastJson(
    input,
    "JSONata input",
    BLAST_LIMITS.jsonataInputBytes,
  );
  const worker = new Worker(new URL("./query_worker.js", import.meta.url), {
    type: "module",
    name: "neutron-blast-jsonata",
  });
  const request: QueryRequest = {
    type: "blast:query:run",
    version: QUERY_PROTOCOL_VERSION,
    expression,
    input,
    timeoutMs: BLAST_LIMITS.jsonataTimeoutMs,
  };

  return new Promise<JsonValue>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finishError(new Error("JSONata query deadline exceeded")),
      BLAST_LIMITS.jsonataTimeoutMs + 250,
    );
    const abort = (): void =>
      finishError(abortError(signal), "JSONata query was cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const finishError = (
      error: unknown,
      fallback = "JSONata query failed",
    ): void => {
      if (settled) return;
      const failure = new Error(boundedErrorOr(error, fallback));
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure);
    };
    const finishValue = (value: JsonValue): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    worker.addEventListener("error", (event) => {
      finishError(new Error(event.message || "JSONata Worker failed"));
    });
    worker.addEventListener("messageerror", () => {
      finishError(new Error("JSONata Worker sent an unreadable message"));
    });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isQueryResponse(event.data)) {
        finishError(new Error("JSONata Worker protocol violation"));
        return;
      }
      if (!event.data.ok) {
        finishError(new Error(event.data.error));
        return;
      }
      try {
        assertBoundedBlastJson(
          event.data.value,
          "JSONata result",
          BLAST_LIMITS.jsonataOutputBytes,
        );
        finishValue(event.data.value);
      } catch (error) {
        finishError(error);
      }
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.postMessage(request);
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("JSONata query was cancelled");
}
