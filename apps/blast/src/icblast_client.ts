import type { JsonValue, ScopedKernelClient } from "neutron-tools/app";
import {
  scheduleDeadline,
  type DeadlineScheduler,
} from "./deadline.ts";
import { boundedBlastJsonBytes, requiredBlastMethodName } from "./json.ts";
import { BLAST_LIMITS } from "./limits.ts";
import type { BlastLocalIdentity } from "./identity.ts";
import {
  assertExternalCanister,
  checkedIcblastArgs,
  executeIcblastLocalOperation,
  IcblastLocalDispatchedCallError,
  IcblastLocalInputValidationError,
  type IcblastActor,
  type IcblastCallResult,
  type IcblastLocalOperationRequest,
  type IcblastLocalOperationResult,
  type IcblastMethodKind,
  type IcblastMethodSchema,
  type IcblastScanResult,
  type IcblastSchemaResult,
  type IcblastValidationResult,
} from "./icblast_operation.ts";
import { runIcblastWorkerOperation } from "./icblast_worker_runner.ts";
import {
  assertBlastTrustedRuntime,
  type BlastTrustedRuntime,
} from "./runtime_config.ts";

const KERNEL_CALL_DIALOG_V2 = "canister.call_dialog_v2";
const KERNEL_CALL_DIALOG_LEGACY = "canister.call_dialog";
const IN_PROCESS_TEST_DIDC_WASM = "test:icblast-in-process-adapter";

export type BlastIdentityMode = "local" | "kernel";
export type BlastMethodKind = IcblastMethodKind;
export type BlastMethodSchema = IcblastMethodSchema;
export type BlastScanResult = IcblastScanResult;
export type BlastSchemaResult = IcblastSchemaResult;
export type BlastValidationResult = IcblastValidationResult;

export type BlastCallRequest = Readonly<{
  canister: string;
  method: string;
  args?: JsonValue[];
  identityMode?: BlastIdentityMode;
}>;

/** Trusted execution controls kept outside Blast's JSON tool arguments. */
export type BlastOperationOptions = Readonly<{
  signal?: AbortSignal;
  /** True only when the exposed tool is running inside Agent Mode. */
  agentMode?: boolean;
}>;

export type BlastCallResult = Readonly<{
  canister: string;
  method: string;
  /** Live local kind; Kernel-identity calls retain the conservative update route. */
  kind: BlastMethodKind;
  identityMode: BlastIdentityMode;
  result: JsonValue;
  /** Exact serialized size computed inside the post-dispatch boundary. */
  resultBytes: number;
}>;

export type BlastDispatchedResultStatus =
  | "dispatched_result_unknown"
  | "result_exceeds_processing_limit";
export type BlastDispatchStatus = "confirmed" | "unknown";

type IcblastRequestOptions = Readonly<{
  redirect: "error";
  signal: AbortSignal;
}>;

type IcblastFactoryOptions = Readonly<{
  host: string;
  local: boolean;
  identity: BlastLocalIdentity["identity"];
  didcWasm: string;
  allowNumberedPrincipals: false;
  agentOptions: Readonly<{
    host: string;
    verifyQuerySignatures: boolean;
    fetchOptions: IcblastRequestOptions;
    callOptions: IcblastRequestOptions;
  }>;
}>;

type GetIcblastActor = (canister: string) => Promise<IcblastActor>;

/** Injected only by unit tests; production ICBlast always runs in its Worker. */
export type BlastIcblastAdapters = Readonly<{
  connect(options: IcblastFactoryOptions): Promise<GetIcblastActor>;
  explainSchema(source: unknown, method: string): unknown;
  validateInput(
    schema: BlastMethodSchema,
    args: JsonValue[],
  ): Readonly<{ ok: boolean; errors?: unknown }>;
  normalize(value: unknown): unknown;
  scheduleDeadline?: DeadlineScheduler;
}>;

export type BlastIcblastClient = Readonly<{
  scan(
    canister: string,
    options?: BlastOperationOptions,
  ): Promise<BlastScanResult>;
  schema(
    canister: string,
    method: string,
    options?: BlastOperationOptions,
  ): Promise<BlastSchemaResult>;
  validateInput(
    canister: string,
    method: string,
    args?: JsonValue[],
    options?: BlastOperationOptions,
  ): Promise<BlastValidationResult>;
  query(
    request: BlastCallRequest,
    kernel?: ScopedKernelClient,
    options?: BlastOperationOptions,
  ): Promise<BlastCallResult>;
  update(
    request: BlastCallRequest,
    kernel?: ScopedKernelClient,
    options?: BlastOperationOptions,
  ): Promise<BlastCallResult>;
}>;

/**
 * Create the resident's ICBlast boundary.
 *
 * Production creates a fresh disposable Worker for each local operation. The
 * Worker performs ICBlast discovery, didc conversion, schema validation, and
 * the call; terminating it makes synchronous Wasm compilation cancellable.
 * One shared executor is used by that Worker and the injected unit-test actor.
 */
export function createBlastIcblastClient({
  runtime,
  localIdentity,
  adapters,
}: Readonly<{
  runtime: BlastTrustedRuntime;
  localIdentity: BlastLocalIdentity;
  adapters?: BlastIcblastAdapters;
}>): BlastIcblastClient {
  const trustedRuntime = assertBlastTrustedRuntime(runtime);
  const factoryOptionsFor = (signal: AbortSignal): IcblastFactoryOptions => {
    const requestOptions: IcblastRequestOptions = Object.freeze({
      redirect: "error",
      signal,
    });
    return Object.freeze({
      host: trustedRuntime.agentHost,
      local: trustedRuntime.local,
      identity: localIdentity.identity,
      didcWasm: IN_PROCESS_TEST_DIDC_WASM,
      allowNumberedPrincipals: false,
      agentOptions: Object.freeze({
        host: trustedRuntime.agentHost,
        verifyQuerySignatures: !trustedRuntime.local,
        fetchOptions: requestOptions,
        callOptions: requestOptions,
      }),
    });
  };
  const withDeadline = <T>(
    parentSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> =>
    runWithOperationDeadline(
      parentSignal,
      adapters?.scheduleDeadline ?? scheduleDeadline,
      operation,
    );

  const runLocalOperation = async <T extends IcblastLocalOperationResult>(
    request: IcblastLocalOperationRequest,
    signal: AbortSignal,
  ): Promise<T> => {
    try {
      if (!adapters) {
        return (await runIcblastWorkerOperation(
          trustedRuntime,
          localIdentity,
          request,
          signal,
        )) as T;
      }

      throwIfAborted(signal);
      const getActor = await awaitAbortable(
        adapters.connect(factoryOptionsFor(signal)),
        signal,
      );
      throwIfAborted(signal);
      const actor = await awaitAbortable(getActor(request.canister), signal);
      throwIfAborted(signal);
      return (await executeIcblastLocalOperation(
        actor,
        request,
        adapters,
        {
          awaitOperation: <Value>(operation: Promise<Value>) =>
            awaitAbortable(operation, signal),
          beforeInvoke: () => throwIfAborted(signal),
        },
      )) as T;
    } catch (error) {
      if (error instanceof IcblastLocalInputValidationError) {
        throw new BlastInputValidationError(error.method, error.errors);
      }
      if (error instanceof IcblastLocalDispatchedCallError) {
        throw dispatchedCallError({
          ...error.details,
          identityMode: "local",
          cause: error.cause,
        });
      }
      throw error;
    }
  };

  return Object.freeze({
    async scan(rawCanister, options) {
      const request = Object.freeze({
        operation: "scan" as const,
        canister: assertExternalCanister(rawCanister),
      });
      return withDeadline(options?.signal, (signal) =>
        runLocalOperation<BlastScanResult>(request, signal));
    },

    async schema(rawCanister, rawMethod, options) {
      const request = Object.freeze({
        operation: "schema" as const,
        canister: assertExternalCanister(rawCanister),
        method: requiredBlastMethodName(rawMethod, "Canister method"),
      });
      return withDeadline(options?.signal, (signal) =>
        runLocalOperation<BlastSchemaResult>(request, signal));
    },

    async validateInput(rawCanister, rawMethod, rawArgs = [], options) {
      const request = Object.freeze({
        operation: "validate_input" as const,
        canister: assertExternalCanister(rawCanister),
        method: requiredBlastMethodName(rawMethod, "Canister method"),
        args: checkedIcblastArgs(rawArgs),
      });
      return withDeadline(options?.signal, (signal) =>
        runLocalOperation<BlastValidationResult>(request, signal));
    },

    async query(request, _kernel, options) {
      return withDeadline(options?.signal, async (signal) => {
        throwIfAborted(signal);
        if (assertIdentityMode(request.identityMode) === "kernel") {
          throw new Error(
            "Kernel identity is unavailable on the query route because the Kernel cannot atomically attest the live method kind",
          );
        }
        return runLocalOperation<IcblastCallResult>(
          localCallRequest(request, "query"),
          signal,
        );
      });
    },

    async update(request, kernel, options) {
      const identityMode = assertIdentityMode(request.identityMode);
      if (identityMode === "local") {
        return withDeadline(options?.signal, (signal) =>
          runLocalOperation<IcblastCallResult>(
            localCallRequest(request, "update"),
            signal,
          ));
      }
      if (!kernel) {
        throw new Error(
          "Kernel identity requires the handler-scoped Kernel client",
        );
      }
      const signal = options?.signal ?? new AbortController().signal;
      const canister = assertKernelIdentityTarget(
        request.canister,
        trustedRuntime.canisterId,
      );
      const method = requiredBlastMethodName(request.method, "Canister method");
      const args = checkedIcblastArgs(request.args);
      const callToolName = await selectKernelCallDialogTool(
        kernel,
        options?.agentMode === true,
        signal,
      );
      throwIfAborted(signal);
      // A synchronous throw is local. Once a Promise exists, every rejection
      // crossed the serialized Kernel boundary and has an unknown outcome.
      const pendingResult = kernel.callTool<JsonValue>({
        target: "kernel",
        name: callToolName,
        arguments: { canister, method, args },
      });
      let rawResult: JsonValue;
      try {
        rawResult = await pendingResult;
      } catch (cause) {
        throw dispatchedCallError({
          canister,
          method,
          kind: "update",
          identityMode: "kernel",
          resultStatus: "dispatched_result_unknown",
          resultBytes: null,
          dispatchStatus: "unknown",
          cause,
        });
      }
      let boundedResult: BoundedCallResult;
      try {
        boundedResult = normalizeCallResult(rawResult);
      } catch (cause) {
        throw dispatchedCallError({
          canister,
          method,
          kind: "update",
          identityMode: "kernel",
          resultStatus:
            cause instanceof ResultTooLargeError
              ? "result_exceeds_processing_limit"
              : "dispatched_result_unknown",
          resultBytes:
            cause instanceof ResultTooLargeError ? cause.resultBytes : null,
          dispatchStatus: "confirmed",
          cause,
        });
      }
      return Object.freeze({
        canister,
        method,
        kind: "update" as const,
        identityMode: "kernel" as const,
        result: boundedResult.result,
        resultBytes: boundedResult.resultBytes,
      });
    },
  });
}

export class BlastInputValidationError extends Error {
  readonly errors: JsonValue;

  constructor(method: string, errors: JsonValue) {
    super(`Arguments do not match the live schema for '${method}'`);
    this.name = "BlastInputValidationError";
    this.errors = errors;
  }
}

/** A closed outcome after Blast crossed a call invocation boundary. */
export class BlastDispatchedCallError extends Error {
  readonly canister: string;
  readonly method: string;
  readonly kind: BlastMethodKind;
  readonly identityMode: BlastIdentityMode;
  readonly resultStatus: BlastDispatchedResultStatus;
  readonly resultBytes: number | null;
  readonly dispatchStatus: BlastDispatchStatus;
  readonly retrySafe: boolean;

  constructor(
    details: Readonly<{
      canister: string;
      method: string;
      kind: BlastMethodKind;
      identityMode: BlastIdentityMode;
      resultStatus: BlastDispatchedResultStatus;
      resultBytes: number | null;
      dispatchStatus: BlastDispatchStatus;
      cause?: unknown;
    }>,
  ) {
    if (
      details.resultBytes !== null &&
      (!Number.isSafeInteger(details.resultBytes) || details.resultBytes < 0)
    ) {
      throw new Error("Blast call result byte evidence is invalid");
    }
    if (
      (details.resultStatus === "result_exceeds_processing_limit" &&
        (details.dispatchStatus !== "confirmed" ||
          details.resultBytes === null)) ||
      (details.resultStatus === "dispatched_result_unknown" &&
        details.resultBytes !== null) ||
      (details.dispatchStatus === "unknown" &&
        details.resultStatus !== "dispatched_result_unknown")
    ) {
      throw new Error("Blast call outcome evidence is inconsistent");
    }
    const outcome =
      details.resultStatus === "result_exceeds_processing_limit"
        ? `returned ${details.resultBytes ?? "an unknown number of"} bytes, exceeding Blast's result budget`
        : "did not produce a safely observable result";
    const boundary =
      details.dispatchStatus === "confirmed"
        ? `was dispatched but ${outcome}`
        : "crossed the Kernel or actor invocation boundary, but dispatch and result are unknown";
    const retrySafe =
      details.dispatchStatus === "confirmed" && details.kind === "query";
    super(
      `Canister ${details.kind} '${details.method}' ${boundary}; ${
        retrySafe
          ? "the live-attested query is side-effect-safe to repeat"
          : "do not retry automatically"
      }`,
      { cause: details.cause },
    );
    this.name = "BlastDispatchedCallError";
    this.canister = details.canister;
    this.method = details.method;
    this.kind = details.kind;
    this.identityMode = details.identityMode;
    this.resultStatus = details.resultStatus;
    this.resultBytes = details.resultBytes;
    this.dispatchStatus = details.dispatchStatus;
    this.retrySafe = retrySafe;
  }
}

function localCallRequest(
  request: BlastCallRequest,
  operation: "query" | "update",
): IcblastLocalOperationRequest {
  return Object.freeze({
    operation,
    canister: assertExternalCanister(request.canister),
    method: requiredBlastMethodName(request.method, "Canister method"),
    args: checkedIcblastArgs(request.args),
  });
}

function assertKernelIdentityTarget(
  value: string,
  neutronCanisterId: string,
): string {
  const canister = assertExternalCanister(value);
  if (canister === neutronCanisterId) {
    throw new Error(
      "Kernel identity cannot call the hosting Neutron canister through Blast",
    );
  }
  return canister;
}

async function selectKernelCallDialogTool(
  kernel: ScopedKernelClient,
  agentMode: boolean,
  signal: AbortSignal,
): Promise<typeof KERNEL_CALL_DIALOG_V2 | typeof KERNEL_CALL_DIALOG_LEGACY> {
  throwIfAborted(signal);
  const descriptors = await awaitAbortable(kernel.listTools("kernel"), signal);
  throwIfAborted(signal);
  const names = new Set(descriptors.map((descriptor) => descriptor.name));
  if (names.has(KERNEL_CALL_DIALOG_V2)) return KERNEL_CALL_DIALOG_V2;
  if (!agentMode && names.has(KERNEL_CALL_DIALOG_LEGACY)) {
    return KERNEL_CALL_DIALOG_LEGACY;
  }
  if (agentMode) {
    throw new Error(
      "Kernel identity in Agent Mode requires canister.call_dialog_v2",
    );
  }
  throw new Error(
    "The hosting Kernel does not expose a compatible canister call dialog",
  );
}

function assertIdentityMode(
  value: BlastIdentityMode | undefined,
): BlastIdentityMode {
  if (value === undefined || value === "local") return "local";
  if (value === "kernel") return "kernel";
  throw new Error("Identity mode is invalid");
}

type BoundedCallResult = Readonly<{
  result: JsonValue;
  resultBytes: number;
}>;

class ResultTooLargeError extends Error {
  constructor(readonly resultBytes: number) {
    super(`Canister result is ${resultBytes} bytes`);
    this.name = "ResultTooLargeError";
  }
}

function normalizeCallResult(value: JsonValue): BoundedCallResult {
  const resultBytes = boundedBlastJsonBytes(
    value,
    "Canister result",
    Number.MAX_SAFE_INTEGER,
  );
  if (resultBytes > BLAST_LIMITS.canisterResultBytes) {
    throw new ResultTooLargeError(resultBytes);
  }
  return Object.freeze({ result: value, resultBytes });
}

function dispatchedCallError(
  details: ConstructorParameters<typeof BlastDispatchedCallError>[0],
): BlastDispatchedCallError {
  return new BlastDispatchedCallError(details);
}

async function runWithOperationDeadline<T>(
  parentSignal: AbortSignal | undefined,
  schedule: (callback: () => void, delayMilliseconds: number) => () => void,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = (): void => {
    if (!controller.signal.aborted && parentSignal) {
      controller.abort(abortReason(parentSignal));
    }
  };
  if (parentSignal?.aborted) {
    forwardAbort();
  } else {
    parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  }
  const cancelDeadline = schedule(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        new BlastOperationDeadlineError(BLAST_LIMITS.canisterOperationTimeoutMs),
      );
    }
  }, BLAST_LIMITS.canisterOperationTimeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    cancelDeadline();
    parentSignal?.removeEventListener("abort", forwardAbort);
  }
}

class BlastOperationDeadlineError extends Error {
  constructor(delayMilliseconds: number) {
    super(`Blast canister operation exceeded its ${delayMilliseconds}ms deadline`);
    this.name = "BlastOperationDeadlineError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

async function awaitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation cancelled", "AbortError");
}
