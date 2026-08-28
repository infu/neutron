import type { BlastLocalIdentity } from "./identity.ts";
import {
  assertIcblastLocalOperationResult,
  IcblastLocalDispatchedCallError,
  IcblastLocalInputValidationError,
  type IcblastLocalOperationRequest,
  type IcblastLocalOperationResult,
  type IcblastMethodKind,
} from "./icblast_operation.ts";
import {
  ICBLAST_WORKER_PROTOCOL_VERSION,
  isIcblastWorkerResponseMessage,
  type IcblastWorkerStartMessage,
} from "./icblast_worker_protocol.ts";
import { assertBoundedBlastJson, boundedErrorOr } from "./json.ts";
import { BLAST_LIMITS } from "./limits.ts";
import type { BlastTrustedRuntime } from "./runtime_config.ts";

export async function runIcblastWorkerOperation(
  runtime: BlastTrustedRuntime,
  identity: BlastLocalIdentity,
  request: IcblastLocalOperationRequest,
  signal: AbortSignal,
  options: Readonly<{ createWorker?: () => Worker }> = {},
): Promise<IcblastLocalOperationResult> {
  if (signal.aborted) throw ordinaryBoundaryError(signal.reason);
  const worker = options.createWorker?.() ??
    new Worker(new URL("./icblast_worker.js", import.meta.url), {
      type: "module",
      name: "neutron-blast-icblast",
    });
  let settled = false;
  let ready = false;
  let started = false;
  let preparedKind: IcblastMethodKind | null = null;
  let invokeSent = false;

  return await new Promise<IcblastLocalOperationResult>((resolve, reject) => {
    const boundaryError = (error: unknown): Error => {
      if (request.operation !== "update" || !invokeSent) {
        return ordinaryBoundaryError(error);
      }
      return new IcblastLocalDispatchedCallError(
        {
          canister: request.canister,
          method: request.method,
          kind: preparedKind ?? "update",
          resultStatus: "dispatched_result_unknown",
          resultBytes: null,
          dispatchStatus: "unknown",
        },
        { cause: error },
      );
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const finishValue = (value: IcblastLocalOperationResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(boundaryError(error));
    };
    const finishValidatedWorkerError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const protocolError = (message: string): void => finishError(new Error(message));
    const abort = (): void => finishError(signal.reason);
    signal.addEventListener("abort", abort, { once: true });

    worker.addEventListener("error", (event) => {
      finishError(
        new Error(boundedErrorOr(event.message, "ICBlast Worker failed")),
      );
    });
    worker.addEventListener("messageerror", () => {
      finishError(new Error("ICBlast Worker sent an unreadable message"));
    });
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isIcblastWorkerResponseMessage(event.data)) {
        protocolError("ICBlast Worker protocol violation");
        return;
      }
      const message = event.data;
      if (message.type === "blast:icblast:ready") {
        if (ready || started) {
          protocolError("ICBlast Worker became ready twice");
          return;
        }
        ready = true;
        try {
          const start: IcblastWorkerStartMessage = {
            type: "blast:icblast:start",
            version: ICBLAST_WORKER_PROTOCOL_VERSION,
            runtime: { host: runtime.agentHost, local: runtime.local },
            identity: {
              keyPair: identity.identity.getKeyPair(),
              principal: identity.principal,
            },
            request,
          };
          signal.throwIfAborted();
          worker.postMessage(start);
          started = true;
        } catch (error) {
          finishError(error);
        }
        return;
      }
      if (!ready || !started) {
        protocolError("ICBlast Worker sent work before readiness");
        return;
      }
      if (message.type === "blast:icblast:prepared") {
        if (
          preparedKind !== null ||
          (request.operation !== "query" && request.operation !== "update") ||
          (request.operation === "query" && message.kind !== "query") ||
          (request.operation === "update" && message.kind === "query")
        ) {
          protocolError("ICBlast Worker returned invalid preparation evidence");
          return;
        }
        preparedKind = message.kind;
        try {
          signal.throwIfAborted();
          worker.postMessage({
            type: "blast:icblast:invoke",
            version: ICBLAST_WORKER_PROTOCOL_VERSION,
          });
          invokeSent = true;
        } catch (error) {
          finishError(error);
        }
        return;
      }
      if (message.type === "blast:icblast:result") {
        try {
          assertIcblastLocalOperationResult(request, message.value);
          if (
            (request.operation === "query" ||
              request.operation === "update") &&
            (!invokeSent ||
              !("kind" in message.value) ||
              message.value.kind !== preparedKind)
          ) {
            throw new Error(
              "ICBlast Worker returned invalid call-result evidence",
            );
          }
          finishValue(message.value);
        } catch (error) {
          finishError(error);
        }
        return;
      }

      const failure = message.failure;
      if (failure.kind === "input_validation") {
        if (
          invokeSent ||
          request.operation === "scan" ||
          request.operation === "schema" ||
          failure.method !== request.method
        ) {
          protocolError("ICBlast Worker returned invalid validation evidence");
          return;
        }
        try {
          assertBoundedBlastJson(
            failure.errors,
            "ICBlast Worker validation diagnostics",
            BLAST_LIMITS.canisterSchemaBytes,
          );
          finishValidatedWorkerError(
            new IcblastLocalInputValidationError(
              failure.method,
              failure.errors,
            ),
          );
        } catch (error) {
          finishError(error);
        }
        return;
      }
      if (failure.kind === "dispatched") {
        if (
          !invokeSent ||
          (request.operation !== "query" && request.operation !== "update") ||
          failure.canister !== request.canister ||
          failure.method !== request.method ||
          failure.methodKind !== preparedKind ||
          (failure.resultStatus === "result_exceeds_processing_limit" &&
            (failure.dispatchStatus !== "confirmed" ||
              failure.resultBytes === null)) ||
          (failure.resultStatus === "dispatched_result_unknown" &&
            failure.resultBytes !== null) ||
          (failure.dispatchStatus === "unknown" &&
            failure.resultStatus !== "dispatched_result_unknown")
        ) {
          protocolError("ICBlast Worker returned invalid dispatch evidence");
          return;
        }
        finishValidatedWorkerError(
          new IcblastLocalDispatchedCallError(
            {
              canister: failure.canister,
              method: failure.method,
              kind: failure.methodKind,
              resultStatus: failure.resultStatus,
              resultBytes: failure.resultBytes,
              dispatchStatus: failure.dispatchStatus,
            },
            { cause: new Error(failure.error) },
          ),
        );
        return;
      }
      finishError(new Error(failure.error));
    });

    if (signal.aborted) abort();
  });
}

function ordinaryBoundaryError(error: unknown): Error {
  if (
    error instanceof IcblastLocalDispatchedCallError ||
    error instanceof IcblastLocalInputValidationError
  ) {
    return new Error("ICBlast Worker boundary failed", { cause: error });
  }
  return error instanceof Error
    ? error
    : new Error(boundedErrorOr(error, "ICBlast Worker failed"));
}
