import type { JsonObject, JsonValue } from "neutron-tools/app";
import {
  assertBoundedBlastJson,
  assertBoundedBlastJsonEnvelope,
  assertBoundedBlastStoredV1JsonEnvelope,
  boundedErrorOr,
  randomId,
  stringBytes,
} from "./json.ts";
import { BLAST_LIMITS } from "./limits.ts";
import {
  SCRIPT_PROTOCOL_VERSION,
  isScriptWorkerMessage,
  type ScriptHostRequestMessage,
  type ScriptHostResponseMessage,
  type ScriptLimits,
  type ScriptStartMessage,
} from "./script_protocol.ts";

export type ScriptHost = (
  operation: string,
  argumentsValue: JsonObject,
  signal: AbortSignal,
  causality?: ScriptHostCausality,
) => Promise<JsonValue>;

export type ScriptHostCausality = Readonly<{
  requestId: number;
  observedResponseIds: readonly number[];
}>;

export type RunScriptRequest = Readonly<{
  source: string;
  input: JsonValue;
  timeoutMs?: number;
  signal?: AbortSignal;
  host: ScriptHost;
}>;

export async function runScript(request: RunScriptRequest): Promise<JsonValue> {
  validateRunRequest(request);
  const timeoutMs = request.timeoutMs ?? BLAST_LIMITS.scriptDefaultTimeoutMs;
  const worker = new Worker(new URL("./script_worker.js", import.meta.url), {
    type: "module",
    name: "neutron-blast-script",
  });
  const controller = new AbortController();
  let hostCalls = 0;
  let concurrentHostCalls = 0;
  let ready = false;
  let settled = false;
  const terminate = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("Script execution ended"));
    }
    worker.terminate();
  };

  return new Promise<JsonValue>((resolve, reject) => {
    const timeout = setTimeout(() => {
      settleReject(new Error("Script deadline exceeded"));
    }, timeoutMs + 1_000);
    const abort = (): void => {
      settleReject(
        abortError(request.signal),
        "Script execution was cancelled",
      );
    };
    request.signal?.addEventListener("abort", abort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abort);
      terminate();
    };
    const settleResolve = (value: JsonValue): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (
      error: unknown,
      fallback = "Script execution failed",
    ): void => {
      if (settled) return;
      const failure = new Error(boundedErrorOr(error, fallback));
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure);
    };

    worker.addEventListener("error", (event) => {
      settleReject(new Error(event.message || "Script Worker failed"));
    });
    worker.addEventListener("messageerror", () => {
      settleReject(new Error("Script Worker sent an unreadable message"));
    });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isScriptWorkerMessage(event.data)) {
        settleReject(new Error("Script Worker protocol violation"));
        return;
      }
      const message = event.data;
      if (message.type === "blast:script:ready") {
        if (ready) {
          settleReject(new Error("Script Worker became ready twice"));
          return;
        }
        ready = true;
        const limits: ScriptLimits = {
          deadlineMs: timeoutMs,
          memoryBytes: BLAST_LIMITS.scriptHeapBytes,
          stackBytes: BLAST_LIMITS.scriptStackBytes,
          pendingJobs: BLAST_LIMITS.scriptPendingJobs,
          resultBytes: BLAST_LIMITS.scriptResultBytes,
        };
        const start: ScriptStartMessage = {
          type: "blast:script:start",
          version: SCRIPT_PROTOCOL_VERSION,
          runId: randomId("run"),
          source: request.source,
          input: request.input,
          limits,
        };
        worker.postMessage(start);
        return;
      }
      if (!ready) {
        settleReject(new Error("Script Worker sent work before readiness"));
        return;
      }
      if (message.type === "blast:script:host-request") {
        // Observe a late host failure immediately without coupling terminal
        // settlement to a host implementation that may ignore cancellation.
        const active = Promise.resolve().then(() => handleHostRequest(message));
        void active.catch(() => undefined);
        return;
      }
      if (concurrentHostCalls !== 0) {
        settleReject(
          new Error("Script completed with unfinished host operations"),
        );
        return;
      }
      if (message.ok) {
        try {
          assertBoundedBlastJson(
            message.value,
            "Script result",
            BLAST_LIMITS.scriptResultBytes,
          );
          settleResolve(message.value);
        } catch (error) {
          settleReject(error);
        }
      } else {
        settleReject(new Error(message.error));
      }
    });

    const handleHostRequest = async (
      message: ScriptHostRequestMessage,
    ): Promise<void> => {
      if (settled) return;
      hostCalls += 1;
      concurrentHostCalls += 1;
      if (hostCalls > BLAST_LIMITS.scriptHostCalls) {
        settleReject(new Error("Script host-call limit exceeded"));
        return;
      }
      if (concurrentHostCalls > BLAST_LIMITS.scriptConcurrentHostCalls) {
        settleReject(new Error("Script concurrent host-call limit exceeded"));
        return;
      }
      try {
        assertBoundedBlastJsonEnvelope(
          message.arguments,
          "Script host request",
          BLAST_LIMITS.scriptHostRequestBytes,
        );
        const value = await request.host(
          message.operation,
          message.arguments,
          controller.signal,
          {
            requestId: message.requestId,
            observedResponseIds: [...message.observedResponseIds],
          },
        );
        if (message.operation === "collections.pages") {
          assertBoundedBlastStoredV1JsonEnvelope(
            value,
            "Script host response",
            BLAST_LIMITS.scriptHostResponseBytes,
          );
        } else {
          assertBoundedBlastJsonEnvelope(
            value,
            "Script host response",
            BLAST_LIMITS.scriptHostResponseBytes,
          );
        }
        sendHostResponse({
          type: "blast:script:host-response",
          version: SCRIPT_PROTOCOL_VERSION,
          requestId: message.requestId,
          ok: true,
          value,
        });
      } catch (error) {
        sendHostResponse({
          type: "blast:script:host-response",
          version: SCRIPT_PROTOCOL_VERSION,
          requestId: message.requestId,
          ok: false,
          error: boundedErrorOr(error, "Host operation failed"),
        });
      } finally {
        concurrentHostCalls -= 1;
      }
    };

    const sendHostResponse = (message: ScriptHostResponseMessage): void => {
      if (!settled) worker.postMessage(message);
    };

    if (request.signal?.aborted) abort();
  });
}

function validateRunRequest(request: RunScriptRequest): void {
  const sourceBytes = stringBytes(request.source);
  if (sourceBytes < 1 || sourceBytes > BLAST_LIMITS.scriptSourceBytes) {
    throw new Error("Script source size is invalid");
  }
  assertBoundedBlastJson(
    request.input,
    "Script input",
    BLAST_LIMITS.scriptArgumentsBytes,
  );
  const timeout = request.timeoutMs ?? BLAST_LIMITS.scriptDefaultTimeoutMs;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1_000 ||
    timeout > BLAST_LIMITS.scriptMaximumTimeoutMs
  ) {
    throw new Error("Script timeout is invalid");
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("Script execution was cancelled");
}
