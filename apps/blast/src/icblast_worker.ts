import { ECDSAKeyIdentity } from "@dfinity/identity";
import icblast, {
  explainMethodSchema,
  toState,
  validateMethodInputSchema,
} from "icblast";
import didcWasmUrl from "icblast/didc-wasm";
import { boundedError } from "./json.ts";
import {
  executeIcblastLocalOperation,
  IcblastLocalDispatchedCallError,
  IcblastLocalInputValidationError,
  type IcblastActor,
  type IcblastMethodKind,
} from "./icblast_operation.ts";
import {
  ICBLAST_WORKER_PROTOCOL_VERSION,
  isIcblastWorkerInvokeMessage,
  isIcblastWorkerStartMessage,
  type IcblastWorkerErrorMessage,
  type IcblastWorkerResponseMessage,
  type IcblastWorkerStartMessage,
} from "./icblast_worker_protocol.ts";
import { BLAST_LIMITS } from "./limits.ts";

type IcblastWorkerScope = Readonly<{
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(value: IcblastWorkerResponseMessage): void;
  close(): void;
}>;

const worker = self as unknown as IcblastWorkerScope;
let started = false;
let finished = false;
let invokeReady = false;
let resolveInvoke: (() => void) | null = null;

worker.addEventListener("message", (event) => {
  if (isIcblastWorkerStartMessage(event.data) && !started) {
    started = true;
    void execute(event.data);
    return;
  }
  if (isIcblastWorkerInvokeMessage(event.data) && invokeReady && resolveInvoke) {
    invokeReady = false;
    const resolve = resolveInvoke;
    resolveInvoke = null;
    resolve();
    return;
  }
  finishError({ kind: "error", error: "Invalid ICBlast Worker message" });
});

post({
  type: "blast:icblast:ready",
  version: ICBLAST_WORKER_PROTOCOL_VERSION,
});

async function execute(message: IcblastWorkerStartMessage): Promise<void> {
  try {
    const host = checkedHost(message.runtime.host);
    const identity = await ECDSAKeyIdentity.fromKeyPair(
      message.identity.keyPair,
      globalThis.crypto.subtle,
    );
    if (identity.getPrincipal().toText() !== message.identity.principal) {
      throw new Error("ICBlast Worker identity binding is invalid");
    }
    const controller = new AbortController();
    const requestOptions = Object.freeze({
      redirect: "error" as const,
      signal: controller.signal,
    });
    const browserApi = icblast as unknown as {
      ic(options: Readonly<Record<string, unknown>>): Promise<
        (canister: string) => Promise<IcblastActor>
      >;
    };
    const getActor = await browserApi.ic({
      host,
      local: message.runtime.local,
      identity,
      didcWasm: didcWasmUrl,
      maxCandidSourceBytes: BLAST_LIMITS.canisterSchemaBytes,
      maxGeneratedJavaScriptBytes: BLAST_LIMITS.canisterGeneratedBindingBytes,
      allowNumberedPrincipals: false,
      agentOptions: Object.freeze({
        host,
        verifyQuerySignatures: !message.runtime.local,
        fetchOptions: requestOptions,
        callOptions: requestOptions,
      }),
    });
    const actor = await getActor(message.request.canister);
    const value = await executeIcblastLocalOperation(
      actor,
      message.request,
      Object.freeze({
        explainSchema: (source: unknown, method: string) =>
          explainMethodSchema(source, method, { allowNumberedPrincipals: false }),
        validateInput: validateMethodInputSchema,
        normalize: toState,
      }),
      { beforeInvoke: awaitInvoke },
    );
    finish({
      type: "blast:icblast:result",
      version: ICBLAST_WORKER_PROTOCOL_VERSION,
      value,
    });
  } catch (error) {
    if (error instanceof IcblastLocalInputValidationError) {
      finishError({
        kind: "input_validation",
        method: error.method,
        errors: error.errors,
      });
      return;
    }
    if (error instanceof IcblastLocalDispatchedCallError) {
      finishError({
        kind: "dispatched",
        canister: error.details.canister,
        method: error.details.method,
        methodKind: error.details.kind,
        resultStatus: error.details.resultStatus,
        resultBytes: error.details.resultBytes,
        dispatchStatus: error.details.dispatchStatus,
        error: boundedError(error.cause ?? error),
      });
      return;
    }
    finishError({ kind: "error", error: boundedError(error) });
  }
}

function awaitInvoke(kind: IcblastMethodKind): Promise<void> {
  if (resolveInvoke !== null || finished) {
    throw new Error("ICBlast Worker invoke state is invalid");
  }
  return new Promise<void>((resolve) => {
    resolveInvoke = resolve;
    invokeReady = true;
    post({
      type: "blast:icblast:prepared",
      version: ICBLAST_WORKER_PROTOCOL_VERSION,
      kind,
    });
  });
}

function checkedHost(value: string): string {
  const host = new URL(value);
  if (
    (host.protocol !== "https:" && host.protocol !== "http:") ||
    host.username !== "" ||
    host.password !== "" ||
    host.hash !== ""
  ) {
    throw new Error("ICBlast Worker host is invalid");
  }
  return host.href;
}

function finishError(failure: IcblastWorkerErrorMessage["failure"]): void {
  finish({
    type: "blast:icblast:error",
    version: ICBLAST_WORKER_PROTOCOL_VERSION,
    failure,
  });
}

function finish(message: IcblastWorkerResponseMessage): void {
  if (finished) return;
  finished = true;
  resolveInvoke = null;
  try {
    post(message);
  } finally {
    worker.close();
  }
}

function post(message: IcblastWorkerResponseMessage): void {
  worker.postMessage(message);
}
