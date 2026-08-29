import jsonataGuestSource from "jsonata/jsonata.min.js";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten-core";
import {
  assertBoundedBlastJson,
  boundedError,
  isUnicodeScalarText,
  stringBytes,
  unicodeScalarLength,
} from "./json.ts";
import { SCRIPT_GUEST_LOCKDOWN } from "./guest_lockdown.ts";
import { BLAST_LIMITS } from "./limits.ts";
import {
  createGuestErrorExtractor,
  extractGuestError,
  isQuickJSMemoryFailure,
} from "./quickjs_error.ts";
import { newBlastQuickJSVariant } from "./quickjs_variant.ts";
import {
  QUERY_PROTOCOL_VERSION,
  isQueryRequest,
  type QueryResponse,
} from "./query_protocol.ts";

type QueryWorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(value: QueryResponse): void;
  close(): void;
};

const JSONATA_STACK_DEPTH = 256;

const worker = self as unknown as QueryWorkerScope;
let started = false;

worker.addEventListener("message", (event) => {
  if (started || !isQueryRequest(event.data)) {
    respond({
      type: "blast:query:result",
      version: QUERY_PROTOCOL_VERSION,
      ok: false,
      error: "Invalid query-worker message",
    });
    return;
  }
  started = true;
  void run(event.data.expression, event.data.input, event.data.timeoutMs);
});

async function run(
  expressionSource: string,
  input: unknown,
  timeoutMs: number,
): Promise<void> {
  let runtime: QuickJSRuntime | null = null;
  let context: QuickJSContext | null = null;
  let errorExtractor: QuickJSHandle | null = null;
  let evaluationHandle: QuickJSHandle | null = null;
  let resultHandle: QuickJSHandle | null = null;
  let queryPromisePending = false;
  let runtimeUnsafe = false;
  let deadline = 0;
  let response: QueryResponse;
  try {
    if (
      expressionSource.length < 1 ||
      !isUnicodeScalarText(expressionSource) ||
      unicodeScalarLength(expressionSource) >
        BLAST_LIMITS.jsonataExpressionCharacters
    ) {
      throw new Error("JSONata expression size is invalid");
    }
    if (timeoutMs > BLAST_LIMITS.jsonataTimeoutMs) {
      throw new Error("JSONata query timeout is invalid");
    }
    assertBoundedBlastJson(
      input,
      "JSONata input",
      BLAST_LIMITS.jsonataInputBytes,
    );

    const encodedInput = JSON.stringify(input);
    deadline = Date.now() + timeoutMs;
    const module = await newQuickJSWASMModuleFromVariant(
      newBlastQuickJSVariant(),
    );
    if (Date.now() >= deadline) throw new Error("JSONata query deadline exceeded");

    runtime = module.newRuntime({
      memoryLimitBytes: BLAST_LIMITS.scriptHeapBytes,
      maxStackSizeBytes: BLAST_LIMITS.scriptStackBytes,
      interruptHandler: () => Date.now() >= deadline,
    });
    context = runtime.newContext();
    errorExtractor = createGuestErrorExtractor(context);
    evaluateJsonataLibrary(context, errorExtractor);

    setStringProperty(context, "__blastQueryExpression", expressionSource);
    setStringProperty(context, "__blastQueryInput", encodedInput);

    const evaluated = context.evalCode(
      queryEvaluationSource(timeoutMs),
      "blast-jsonata-query.js",
      { type: "global", strict: true, backtraceBarrier: true },
    );
    if (evaluated.error) {
      throw guestError(context, errorExtractor, evaluated.error);
    }
    evaluationHandle = evaluated.value;
    queryPromisePending = true;

    resultHandle = await settleQueryPromise(
      runtime,
      context,
      errorExtractor,
      evaluationHandle,
      BLAST_LIMITS.scriptPendingJobs,
      deadline,
      () => {
        queryPromisePending = false;
      },
    );
    if (context.typeof(resultHandle) !== "string") {
      throw new Error("JSONata result serialization failed");
    }

    const encodedResult = context.getString(resultHandle);
    if (stringBytes(encodedResult) > BLAST_LIMITS.jsonataOutputBytes) {
      throw new Error("JSONata result is too large");
    }
    const value: unknown = JSON.parse(encodedResult);
    assertBoundedBlastJson(
      value,
      "JSONata result",
      BLAST_LIMITS.jsonataOutputBytes,
    );
    response = {
      type: "blast:query:result",
      version: QUERY_PROTOCOL_VERSION,
      ok: true,
      value,
    };
  } catch (error) {
    const deadlineReached = deadline > 0 && Date.now() >= deadline;
    const failure = boundedError(error);
    const memoryLimitReached = isQuickJSMemoryFailure(failure);
    const message = deadlineReached
      ? "JSONata query deadline exceeded"
      : memoryLimitReached
        ? "JSONata query exceeded its memory limit"
        : failure;
    runtimeUnsafe = deadlineReached || memoryLimitReached ||
      /deadline exceeded|exceeded its memory limit/u.test(
        message.toLowerCase(),
      );
    response = {
      type: "blast:query:result",
      version: QUERY_PROTOCOL_VERSION,
      ok: false,
      error: message,
    };
  } finally {
    // The release QuickJS build aborts in JS_FreeRuntime after allocator OOM or
    // when an interrupted Promise is torn down. In the latter case even freeing
    // the Promise handle or its context can trip QuickJS refcount assertions, so
    // leave the whole runtime tree to this one-shot Worker's termination.
    if (!queryPromisePending && !runtimeUnsafe) {
      if (resultHandle?.alive) resultHandle.dispose();
      if (evaluationHandle?.alive) evaluationHandle.dispose();
      if (errorExtractor?.alive) errorExtractor.dispose();
      if (context?.alive) context.dispose();
      if (runtime?.alive) runtime.dispose();
    }
  }
  respond(response);
}

function evaluateJsonataLibrary(
  context: QuickJSContext,
  errorExtractor: QuickJSHandle,
): void {
  const loaded = context.evalCode(
    jsonataGuestSource,
    "jsonata.min.js",
    { type: "global", strict: false, backtraceBarrier: true },
  );
  if (loaded.error) throw guestError(context, errorExtractor, loaded.error);
  loaded.value.dispose();

  const bootstrapped = context.evalCode(
    jsonataQueryBootstrapSource,
    "blast-jsonata-bootstrap.js",
    { type: "global", strict: true, backtraceBarrier: true },
  );
  if (bootstrapped.error) {
    throw guestError(context, errorExtractor, bootstrapped.error);
  }
  bootstrapped.value.dispose();

  const locked = context.evalCode(
    SCRIPT_GUEST_LOCKDOWN,
    "blast-jsonata-lockdown.js",
    { type: "global", strict: true, backtraceBarrier: true },
  );
  if (locked.error) throw guestError(context, errorExtractor, locked.error);
  locked.value.dispose();
}

function queryEvaluationSource(timeoutMs: number): string {
  return `
globalThis.__blastRunJsonata(
  globalThis.__blastQueryExpression,
  globalThis.__blastQueryInput,
  {
    timeout: ${timeoutMs},
    stack: ${JSONATA_STACK_DEPTH},
    maximumBytes: ${BLAST_LIMITS.jsonataOutputBytes},
    maximumDepth: ${BLAST_LIMITS.jsonDepth},
    maximumNodes: ${BLAST_LIMITS.jsonNodes},
    sequence: ${BLAST_LIMITS.jsonNodes}
  }
)
`;
}

const jsonataQueryBootstrapSource = String.raw`
(() => {
const jsonataFactory = globalThis.jsonata;
const parseJson = JSON.parse;
const stringifyJson = JSON.stringify;
const arrayIsArray = Array.isArray;
const isFiniteNumber = Number.isFinite;
const getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const getOwnPropertySymbols = Object.getOwnPropertySymbols;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const arrayMetadata = new Set([
  "sequence",
  "outerWrapper",
  "keepSingleton",
  "tupleStream"
]);

function strictJsonEncode(value, limits) {
  const ancestors = new WeakSet();
  const stack = [{ value, depth: 0, exit: false }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.exit) {
      ancestors.delete(current.value);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maximumNodes) {
      throw new Error("JSONata result contains too many values");
    }
    if (current.depth > limits.maximumDepth) {
      throw new Error("JSONata result is nested too deeply");
    }
    const item = current.value;
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && isFiniteNumber(item))
    ) {
      continue;
    }
    if (typeof item !== "object") {
      throw new Error("JSONata result must be JSON-compatible");
    }
    if (ancestors.has(item)) {
      throw new Error("JSONata result must not contain cycles");
    }
    ancestors.add(item);
    stack.push({ value: item, depth: current.depth, exit: true });
    if (getOwnPropertySymbols(item).length > 0) {
      throw new Error("JSONata result must not contain symbol properties");
    }
    if (arrayIsArray(item)) {
      const descriptors = getOwnPropertyDescriptors(item);
      const jsonataSequence = descriptors.sequence?.value === true;
      for (let index = item.length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[index];
        if (
          !hasOwnProperty.call(item, index) ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          throw new Error("JSONata result must not contain array holes");
        }
        stack.push({
          value: descriptor.value,
          depth: current.depth + 1,
          exit: false
        });
      }
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        const index = Number(key);
        if (Number.isSafeInteger(index) && index >= 0 && String(index) === key) {
          continue;
        }
        const descriptor = descriptors[key];
        if (
          key === "push" &&
          jsonataSequence &&
          "value" in descriptor &&
          typeof descriptor.value === "function" &&
          descriptor.enumerable
        ) {
          continue;
        }
        if (
          !arrayMetadata.has(key) ||
          !("value" in descriptor) ||
          descriptor.value !== true ||
          !descriptor.enumerable
        ) {
          throw new Error("JSONata result arrays must not contain extra properties");
        }
      }
      continue;
    }
    const prototype = getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("JSONata result must be a plain JSON value");
    }
    const descriptors = getOwnPropertyDescriptors(item);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("JSONata result must contain plain enumerable values");
      }
      stack.push({
        value: descriptor.value,
        depth: current.depth + 1,
        exit: false
      });
    }
  }
  const encoded = stringifyJson(value);
  if (typeof encoded !== "string") {
    throw new Error("JSONata result must be JSON-compatible");
  }
  let bytes = 0;
  for (let index = 0; index < encoded.length; index += 1) {
    const unit = encoded.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < encoded.length) {
      const next = encoded.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limits.maximumBytes) {
      throw new Error("JSONata result is too large");
    }
  }
  return encoded;
}

const runJsonata = async (encodedExpression, encodedInput, limits) => {
  const value = await jsonataFactory(encodedExpression, {
    timeout: limits.timeout,
    stack: limits.stack,
    sequence: limits.sequence
  }).evaluate(parseJson(encodedInput));
  return strictJsonEncode(value, limits);
};
Object.defineProperty(globalThis, "__blastRunJsonata", {
  value: runJsonata,
  writable: false,
  enumerable: false,
  configurable: false
});
delete globalThis.jsonata;
})();
`;

async function settleQueryPromise(
  runtime: QuickJSRuntime,
  context: QuickJSContext,
  errorExtractor: QuickJSHandle,
  promise: QuickJSHandle,
  maximumJobs: number,
  deadline: number,
  markSettled: () => void,
): Promise<QuickJSHandle> {
  let executed = 0;
  while (true) {
    const state = context.getPromiseState(promise);
    if (state.type === "fulfilled") {
      markSettled();
      return state.value;
    }
    if (state.type === "rejected") {
      throw guestError(context, errorExtractor, state.error);
    }
    if (Date.now() >= deadline) throw new Error("JSONata query deadline exceeded");
    const jobs = runtime.executePendingJobs(100);
    if (jobs.error) {
      const context = jobs.error.context;
      throw guestError(context, errorExtractor, jobs.error);
    }
    const executedNow = jobs.value;
    executed += executedNow;
    jobs.dispose();
    if (executed > maximumJobs) {
      throw new Error("JSONata pending-job limit exceeded");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (executedNow === 0) {
      const idleState = context.getPromiseState(promise);
      if (idleState.type === "fulfilled") {
        markSettled();
        return idleState.value;
      }
      if (idleState.type === "rejected") {
        throw guestError(context, errorExtractor, idleState.error);
      }
      throw new Error("JSONata query became idle before producing a result");
    }
  }
}

function setStringProperty(
  context: QuickJSContext,
  name: string,
  value: string,
): void {
  const handle = context.newString(value);
  try {
    context.setProp(context.global, name, handle);
  } finally {
    handle.dispose();
  }
}

function guestError(
  context: QuickJSContext,
  errorExtractor: QuickJSHandle,
  handle: QuickJSHandle,
): Error {
  let disposeHandle = true;
  try {
    const value = extractGuestError(context, errorExtractor, handle);
    const code = value.code;
    const position = value.position;
    const message = value.message ?? "";
    if (
      value.name === null &&
      value.message === null &&
      code === null &&
      position === null
    ) {
      // An interrupted QuickJS runtime can reject the trusted extractor too.
      // Do not misreport that unsafe state as an ordinary query failure.
      disposeHandle = false;
      return new Error("JSONata query deadline exceeded");
    }
    if (
      code === "D1012" ||
      /interrupted|deadline|timeout/u.test(message.toLowerCase())
    ) {
      disposeHandle = false;
      return new Error("JSONata query deadline exceeded");
    }
    if (isQuickJSMemoryFailure(message)) {
      disposeHandle = false;
      return new Error("JSONata query exceeded its memory limit");
    }
    if (code && /^[A-Z][0-9]{4}$/u.test(code)) {
      return new Error(
        position === null
          ? `JSONata ${code}`
          : `JSONata ${code} at position ${position}`,
      );
    }
    if (message.startsWith("JSONata ")) return new Error(message);
    return new Error("JSONata query failed");
  } finally {
    if (disposeHandle && handle.alive) handle.dispose();
  }
}

function respond(message: QueryResponse): void {
  worker.postMessage(message);
  worker.close();
}
