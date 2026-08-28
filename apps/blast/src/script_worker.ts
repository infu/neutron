import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import {
  assertBoundedBlastJson,
  assertBoundedBlastJsonEnvelope,
  assertBoundedBlastStoredV1JsonEnvelope,
  boundedError,
  stringBytes,
} from "./json.ts";
import { SCRIPT_GUEST_LOCKDOWN } from "./guest_lockdown.ts";
import { BLAST_LIMITS } from "./limits.ts";
import {
  createGuestErrorExtractor,
  extractGuestError,
} from "./quickjs_error.ts";
import { newBlastQuickJSVariant } from "./quickjs_variant.ts";
import { scriptEvaluationSource } from "./script_guest.ts";
import {
  SCRIPT_PROTOCOL_VERSION,
  isScriptHostResponseMessage,
  isScriptObservedResponseIds,
  type ScriptHostRequestMessage,
  type ScriptHostResponseMessage,
  type ScriptResultMessage,
  type ScriptStartMessage,
} from "./script_protocol.ts";

type ScriptWorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(value: unknown): void;
};

const worker = self as unknown as ScriptWorkerScope;
let started = false;
let nextRequestId = 1;
const hostResponses = new Map<
  number,
  {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    operation: string;
  }
>();

worker.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (isScriptHostResponseMessage(event.data)) {
    settleHostResponse(event.data);
    return;
  }
  if (!isStartMessage(event.data) || started) {
    finish(false, undefined, "Invalid script-worker message");
    return;
  }
  started = true;
  void execute(event.data);
});

post({
  type: "blast:script:ready",
  version: SCRIPT_PROTOCOL_VERSION,
});

async function execute(message: ScriptStartMessage): Promise<void> {
  let runtime: QuickJSRuntime | null = null;
  let context: QuickJSContext | null = null;
  let errorExtractor: QuickJSHandle | null = null;
  let resultHandle: QuickJSHandle | null = null;
  let settledResult: QuickJSHandle | null = null;
  const deferred = new Set<QuickJSDeferredPromise>();
  try {
    const module = await newQuickJSWASMModuleFromVariant(
      newBlastQuickJSVariant(),
    );
    const deadline = Date.now() + message.limits.deadlineMs;
    runtime = module.newRuntime({
      memoryLimitBytes: message.limits.memoryBytes,
      maxStackSizeBytes: message.limits.stackBytes,
      interruptHandler: () => Date.now() >= deadline,
    });
    // The host C API cannot compile with the Eval intrinsic disabled. Keep it
    // enabled for host evaluation, then irreversibly remove guest-visible eval
    // and dynamic Function constructors before compiling supplied source.
    context = runtime.newContext();
    errorExtractor = createGuestErrorExtractor(context);
    evaluateLockdown(context, errorExtractor);
    installHostFunction(context, deferred);

    const evaluated = context.evalCode(
      scriptEvaluationSource(
        message.source,
        message.input,
        message.limits.resultBytes,
      ),
      `blast-script-${message.runId}.js`,
      { type: "global", strict: true, backtraceBarrier: true },
    );
    if (evaluated.error) {
      throw guestError(context, errorExtractor, evaluated.error);
    }
    resultHandle = evaluated.value;
    const nativeResult = context.resolvePromise(resultHandle);
    await pumpJobs(
      runtime,
      errorExtractor,
      nativeResult,
      message.limits.pendingJobs,
      deadline,
    );
    const result = await nativeResult;
    if (result.error) throw guestError(context, errorExtractor, result.error);
    settledResult = result.value;
    if (context.typeof(settledResult) !== "string") {
      throw new Error("Script result serialization failed");
    }
    const encodedResult = context.getString(settledResult);
    if (stringBytes(encodedResult) > message.limits.resultBytes) {
      throw new Error("Script result is too large");
    }
    const parsedResult: unknown = JSON.parse(encodedResult);
    assertBoundedBlastJson(
      parsedResult,
      "Script result",
      message.limits.resultBytes,
    );
    finish(true, parsedResult);
  } catch (error) {
    finish(false, undefined, boundedError(error));
  } finally {
    for (const pending of hostResponses.values()) {
      pending.reject(new Error("Script execution ended"));
    }
    hostResponses.clear();
    for (const promise of deferred) {
      if (promise.alive) promise.dispose();
    }
    if (settledResult?.alive) settledResult.dispose();
    if (resultHandle?.alive) resultHandle.dispose();
    if (errorExtractor?.alive) errorExtractor.dispose();
    if (context?.alive) context.dispose();
    // Guest code can catch allocator exhaustion, which makes runtime disposal
    // unsafe even after an apparently successful result. Each execution owns a
    // one-shot Worker and Wasm instance; mandatory parent termination reclaims
    // the runtime after this bounded result without trusting guest-visible state.
  }
}

function installHostFunction(
  context: QuickJSContext,
  deferred: Set<QuickJSDeferredPromise>,
): void {
  const host = context.newFunction(
    "__blastHost",
    (operationHandle, argumentsHandle, observedResponseIdsHandle) => {
      const operation = context.getString(operationHandle);
      const encodedArguments = context.getString(argumentsHandle);
      const encodedObservedResponseIds = context.getString(
        observedResponseIdsHandle,
      );
      if (!/^[a-z][a-z0-9_.]{0,63}$/u.test(operation)) {
        throw new Error("Invalid host operation");
      }
      if (encodedArguments.length > BLAST_LIMITS.scriptHostRequestBytes) {
        throw new Error("Host request is too large");
      }
      const request = requestHost(
        operation,
        encodedArguments,
        encodedObservedResponseIds,
      );
      // Do not use newPromise(executor) here. The executor's native Promise
      // retains a QuickJS handle after `consume()` has disposed it, so an
      // awaited host call can never safely settle. Keep the explicit deferred
      // and its resolver handles alive until the host response arrives.
      const promise = context.newPromise();
      deferred.add(promise);
      request.then(
        (encoded) => {
          if (!promise.alive || !context.alive) return;
          const value = context.newString(encoded);
          try {
            promise.resolve(value);
          } finally {
            if (value.alive) value.dispose();
          }
        },
        (error) => {
          if (!promise.alive || !context.alive) return;
          const value = context.newError(boundedError(error));
          try {
            promise.reject(value);
          } finally {
            if (value.alive) value.dispose();
          }
        },
      );
      void promise.settled.then(() => {
        deferred.delete(promise);
        if (promise.alive) promise.dispose();
      });
      return promise.handle;
    },
  );
  context.setProp(context.global, "__blastHost", host);
  host.dispose();
}

function evaluateLockdown(
  context: QuickJSContext,
  errorExtractor: QuickJSHandle,
): void {
  const evaluated = context.evalCode(
    SCRIPT_GUEST_LOCKDOWN,
    "blast-lockdown.js",
    { type: "global", strict: true, backtraceBarrier: true },
  );
  if (evaluated.error) {
    throw guestError(context, errorExtractor, evaluated.error);
  }
  evaluated.value.dispose();
}

async function requestHost(
  operation: string,
  encodedArguments: string,
  encodedObservedResponseIds: string,
): Promise<string> {
  if (nextRequestId > BLAST_LIMITS.scriptHostCalls) {
    throw new Error("Script host-call limit exceeded");
  }
  if (hostResponses.size >= BLAST_LIMITS.scriptConcurrentHostCalls) {
    throw new Error("Script concurrent host-call limit exceeded");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedArguments);
    assertBoundedBlastJsonEnvelope(
      parsed,
      "Script host request",
      BLAST_LIMITS.scriptHostRequestBytes,
    );
  } catch (error) {
    throw new Error(boundedError(error));
  }
  if (Array.isArray(parsed) || parsed === null || typeof parsed !== "object") {
    throw new Error("Script host arguments must be an object");
  }
  const observedResponseIds = parseObservedResponseIds(
    encodedObservedResponseIds,
    nextRequestId,
  );
  const requestId = nextRequestId++;
  const request: ScriptHostRequestMessage = {
    type: "blast:script:host-request",
    version: SCRIPT_PROTOCOL_VERSION,
    requestId,
    observedResponseIds,
    operation,
    arguments: parsed,
  };
  return new Promise<string>((resolve, reject) => {
    hostResponses.set(requestId, { resolve, reject, operation });
    post(request);
  });
}

function settleHostResponse(message: ScriptHostResponseMessage): void {
  const pending = hostResponses.get(message.requestId);
  if (!pending) {
    finish(false, undefined, "Unknown script host response");
    return;
  }
  hostResponses.delete(message.requestId);
  if (!message.ok) {
    pending.reject(new Error(message.error ?? "Host operation failed"));
    return;
  }
  try {
    if (pending.operation === "collections.pages") {
      assertBoundedBlastStoredV1JsonEnvelope(
        message.value,
        "Script host response",
        BLAST_LIMITS.scriptHostResponseBytes,
      );
    } else {
      assertBoundedBlastJsonEnvelope(
        message.value,
        "Script host response",
        BLAST_LIMITS.scriptHostResponseBytes,
      );
    }
    pending.resolve(
      JSON.stringify([message.requestId, JSON.stringify(message.value)]),
    );
  } catch (error) {
    pending.reject(new Error(boundedError(error)));
  }
}

function parseObservedResponseIds(
  encoded: string,
  requestId: number,
): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("Invalid Script host response receipts");
  }
  if (!isScriptObservedResponseIds(parsed, requestId)) {
    throw new Error("Invalid Script host response receipts");
  }
  return [...parsed];
}

async function pumpJobs(
  runtime: QuickJSRuntime,
  errorExtractor: QuickJSHandle,
  result: Promise<unknown>,
  maximumJobs: number,
  deadline: number,
): Promise<void> {
  let settled = false;
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let executed = 0;
  while (!settled) {
    if (Date.now() >= deadline) throw new Error("Script deadline exceeded");
    const jobs = runtime.executePendingJobs(100);
    if (jobs.error) {
      const context = jobs.error.context;
      throw guestError(context, errorExtractor, jobs.error);
    }
    executed += jobs.value;
    jobs.dispose();
    if (executed > maximumJobs) {
      throw new Error("Script pending-job limit exceeded");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function guestError(
  context: QuickJSContext,
  errorExtractor: QuickJSHandle,
  handle: QuickJSHandle,
): Error {
  try {
    const value = extractGuestError(context, errorExtractor, handle);
    const name = value.name ?? "Error";
    const message = value.message ?? "Script failed";
    const normalized = message.toLowerCase();
    if (/interrupted|deadline|timeout/u.test(normalized)) {
      return new Error("Script deadline exceeded");
    }
    if (/out of memory|allocation/u.test(normalized)) {
      return new Error("Script exceeded its memory limit");
    }
    return new Error(`${name}: ${message}`);
  } finally {
    if (handle.alive) handle.dispose();
  }
}

function isStartMessage(value: unknown): value is ScriptStartMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const limits = record.limits;
  return (
    record.type === "blast:script:start" &&
    record.version === SCRIPT_PROTOCOL_VERSION &&
    typeof record.runId === "string" &&
    typeof record.source === "string" &&
    typeof limits === "object" &&
    limits !== null &&
    !Array.isArray(limits)
  );
}

function finish(ok: boolean, value?: unknown, error?: string): void {
  const message: ScriptResultMessage = ok
    ? {
        type: "blast:script:result",
        version: SCRIPT_PROTOCOL_VERSION,
        ok: true,
        value: value as never,
      }
    : {
        type: "blast:script:result",
        version: SCRIPT_PROTOCOL_VERSION,
        ok: false,
        error: error ?? "Script failed",
      };
  post(message);
}

function post(message: unknown): void {
  worker.postMessage(message);
}
