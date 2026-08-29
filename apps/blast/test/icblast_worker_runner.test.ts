import { describe, expect, test } from "bun:test";
import type { BlastLocalIdentity } from "../src/identity.ts";
import {
  IcblastLocalDispatchedCallError,
  type IcblastLocalOperationRequest,
} from "../src/icblast_operation.ts";
import { runIcblastWorkerOperation } from "../src/icblast_worker_runner.ts";
import {
  ICBLAST_WORKER_PROTOCOL_VERSION,
  isIcblastWorkerResponseMessage,
} from "../src/icblast_worker_protocol.ts";
import { BLAST_LIMITS } from "../src/limits.ts";
import type { BlastTrustedRuntime } from "../src/runtime_config.ts";

const CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const RUNTIME = {
  agentHost: "https://icp-api.io/",
  local: false,
} as BlastTrustedRuntime;
const IDENTITY = {
  principal: "2vxsx-fae",
  identity: {
    getKeyPair: () => ({ privateKey: {}, publicKey: {} }),
  },
} as unknown as BlastLocalIdentity;

describe("Blast ICBlast Worker runner", () => {
  test("terminates a discovery/conversion Worker when its deadline signal aborts", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const request = scanRequest();
    const pending = run(request, controller.signal, worker);

    worker.message(ready());
    await worker.waitForPost("blast:icblast:start");
    const deadline = new Error("operation deadline elapsed");
    controller.abort(deadline);

    expect(await pending.catch((error: unknown) => error)).toBe(deadline);
    expect(worker.terminateCalls).toBe(1);
  });

  test("terminates an invoked update and reports cancellation as outcome-unknown", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const request = callRequest("update");
    const pending = run(request, controller.signal, worker);

    worker.message(ready());
    await worker.waitForPost("blast:icblast:start");
    worker.message(prepared("update"));
    await worker.waitForPost("blast:icblast:invoke");
    controller.abort(new Error("cancelled after invoke"));

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IcblastLocalDispatchedCallError);
    expect(error).toMatchObject({
      details: {
        canister: CANISTER,
        method: "write",
        kind: "update",
        resultStatus: "dispatched_result_unknown",
        resultBytes: null,
        dispatchStatus: "unknown",
      },
    });
    expect(worker.terminateCalls).toBe(1);
  });

  test("does not accept caller cancellation as forged dispatch evidence", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const request = scanRequest();
    const pending = run(request, controller.signal, worker);

    worker.message(ready());
    await worker.waitForPost("blast:icblast:start");
    const forged = new IcblastLocalDispatchedCallError({
      canister: CANISTER,
      method: "write",
      kind: "update",
      resultStatus: "result_exceeds_processing_limit",
      resultBytes: BLAST_LIMITS.canisterResultBytes + 3,
      dispatchStatus: "confirmed",
    });
    controller.abort(forged);

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IcblastLocalDispatchedCallError);
    expect((error as Error).cause).toBe(forged);
    expect(worker.terminateCalls).toBe(1);
  });

  test("rejects and terminates on an oversized call-result envelope", async () => {
    const worker = new FakeWorker();
    const request = callRequest("query");
    const pending = run(request, new AbortController().signal, worker);

    worker.message(ready());
    await worker.waitForPost("blast:icblast:start");
    worker.message(prepared("query"));
    await worker.waitForPost("blast:icblast:invoke");
    const result = "x".repeat(BLAST_LIMITS.canisterResultBytes + 1);
    worker.message({
      type: "blast:icblast:result",
      version: ICBLAST_WORKER_PROTOCOL_VERSION,
      value: {
        canister: CANISTER,
        method: "write",
        kind: "query",
        identityMode: "local",
        result,
        resultBytes: BLAST_LIMITS.canisterResultBytes + 3,
      },
    });

    await expect(pending).rejects.toThrow("too large");
    expect(worker.terminateCalls).toBe(1);
  });

  test("preserves confirmed oversized-result evidence after update invoke", async () => {
    const worker = new FakeWorker();
    const request = callRequest("update");
    const pending = run(request, new AbortController().signal, worker);

    worker.message(ready());
    await worker.waitForPost("blast:icblast:start");
    worker.message(prepared("update"));
    await worker.waitForPost("blast:icblast:invoke");
    worker.message({
      type: "blast:icblast:error",
      version: ICBLAST_WORKER_PROTOCOL_VERSION,
      failure: {
        kind: "dispatched",
        canister: CANISTER,
        method: "write",
        methodKind: "update",
        resultStatus: "result_exceeds_processing_limit",
        resultBytes: BLAST_LIMITS.canisterResultBytes + 3,
        dispatchStatus: "confirmed",
        error: "Canister result exceeds the processing limit",
      },
    });

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(IcblastLocalDispatchedCallError);
    expect(error).toMatchObject({
      details: {
        resultStatus: "result_exceeds_processing_limit",
        resultBytes: BLAST_LIMITS.canisterResultBytes + 3,
        dispatchStatus: "confirmed",
      },
    });
    expect(worker.terminateCalls).toBe(1);
  });

  test("binds result and failure kinds to the exact prepared method", async () => {
    const resultWorker = new FakeWorker();
    const resultPending = run(
      callRequest("update"),
      new AbortController().signal,
      resultWorker,
    );
    resultWorker.message(ready());
    await resultWorker.waitForPost("blast:icblast:start");
    resultWorker.message(prepared("update"));
    await resultWorker.waitForPost("blast:icblast:invoke");
    resultWorker.message({
      type: "blast:icblast:result",
      version: ICBLAST_WORKER_PROTOCOL_VERSION,
      value: {
        canister: CANISTER,
        method: "write",
        kind: "oneway",
        identityMode: "local",
        result: null,
        resultBytes: 4,
      },
    });
    expect(await resultPending.catch((error: unknown) => error)).toMatchObject({
      details: { kind: "update", dispatchStatus: "unknown" },
    });

    const failureWorker = new FakeWorker();
    const failurePending = run(
      callRequest("update"),
      new AbortController().signal,
      failureWorker,
    );
    failureWorker.message(ready());
    await failureWorker.waitForPost("blast:icblast:start");
    failureWorker.message(prepared("update"));
    await failureWorker.waitForPost("blast:icblast:invoke");
    failureWorker.message({
      type: "blast:icblast:error",
      version: ICBLAST_WORKER_PROTOCOL_VERSION,
      failure: {
        kind: "dispatched",
        canister: CANISTER,
        method: "write",
        methodKind: "oneway",
        resultStatus: "dispatched_result_unknown",
        resultBytes: null,
        dispatchStatus: "unknown",
        error: "wrong kind",
      },
    });
    expect(await failurePending.catch((error: unknown) => error)).toMatchObject({
      details: { kind: "update", dispatchStatus: "unknown" },
    });
    expect(resultWorker.terminateCalls).toBe(1);
    expect(failureWorker.terminateCalls).toBe(1);
  });

  test("rejects result bytes on an outcome-unknown failure envelope", () => {
    expect(isIcblastWorkerResponseMessage({
      type: "blast:icblast:error",
      version: ICBLAST_WORKER_PROTOCOL_VERSION,
      failure: {
        kind: "dispatched",
        canister: CANISTER,
        method: "write",
        methodKind: "update",
        resultStatus: "dispatched_result_unknown",
        resultBytes: 1,
        dispatchStatus: "confirmed",
        error: "unknown result",
      },
    })).toBe(false);
  });

  test("settles a primitive call-result protocol violation", async () => {
    const worker = new FakeWorker();
    const pending = run(
      callRequest("query"),
      new AbortController().signal,
      worker,
    );
    worker.message(ready());
    await worker.waitForPost("blast:icblast:start");
    worker.message(prepared("query"));
    await worker.waitForPost("blast:icblast:invoke");
    worker.message({
      type: "blast:icblast:result",
      version: ICBLAST_WORKER_PROTOCOL_VERSION,
      value: null,
    });

    await expect(pending).rejects.toThrow("invalid canister binding");
    expect(worker.terminateCalls).toBe(1);
  });

  test("accepts maximum-depth and maximum-node results inside its envelope", async () => {
    let deepest: unknown = null;
    for (let index = 0; index < BLAST_LIMITS.jsonDepth; index += 1) {
      deepest = [deepest];
    }
    await expect(runQueryResult(deepest)).resolves.toMatchObject({
      result: deepest,
    });

    const densest = Array.from(
      { length: BLAST_LIMITS.jsonNodes - 1 },
      () => null,
    );
    await expect(runQueryResult(densest)).resolves.toMatchObject({
      result: densest,
    });
  });
});

function run(
  request: IcblastLocalOperationRequest,
  signal: AbortSignal,
  worker: FakeWorker,
) {
  return runIcblastWorkerOperation(RUNTIME, IDENTITY, request, signal, {
    createWorker: () => worker as unknown as Worker,
  });
}

function scanRequest(): IcblastLocalOperationRequest {
  return Object.freeze({ operation: "scan", canister: CANISTER });
}

function callRequest(
  operation: "query" | "update",
): IcblastLocalOperationRequest {
  return Object.freeze({
    operation,
    canister: CANISTER,
    method: "write",
    args: [],
  });
}

function ready() {
  return {
    type: "blast:icblast:ready",
    version: ICBLAST_WORKER_PROTOCOL_VERSION,
  } as const;
}

function prepared(kind: "query" | "update") {
  return {
    type: "blast:icblast:prepared",
    version: ICBLAST_WORKER_PROTOCOL_VERSION,
    kind,
  } as const;
}

async function runQueryResult(result: unknown) {
  const worker = new FakeWorker();
  const pending = run(
    callRequest("query"),
    new AbortController().signal,
    worker,
  );
  worker.message(ready());
  await worker.waitForPost("blast:icblast:start");
  worker.message(prepared("query"));
  await worker.waitForPost("blast:icblast:invoke");
  worker.message({
    type: "blast:icblast:result",
    version: ICBLAST_WORKER_PROTOCOL_VERSION,
    value: {
      canister: CANISTER,
      method: "write",
      kind: "query",
      identityMode: "local",
      result,
      resultBytes: new TextEncoder().encode(JSON.stringify(result)).byteLength,
    },
  });
  return await pending;
}

class FakeWorker {
  readonly posts: unknown[] = [];
  terminateCalls = 0;
  readonly #listeners = new Map<string, Array<(event: any) => void>>();
  readonly #postWaiters = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  postMessage(value: unknown): void {
    this.posts.push(value);
    const type = messageType(value);
    for (const resolve of this.#postWaiters.get(type) ?? []) resolve();
    this.#postWaiters.delete(type);
  }

  terminate(): void {
    this.terminateCalls += 1;
  }

  message(data: unknown): void {
    for (const listener of this.#listeners.get("message") ?? []) {
      listener({ data });
    }
  }

  async waitForPost(type: string): Promise<void> {
    if (this.posts.some((value) => messageType(value) === type)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.#postWaiters.get(type) ?? [];
      waiters.push(resolve);
      this.#postWaiters.set(type, waiters);
    });
  }
}

function messageType(value: unknown): string {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return "";
  }
  return typeof value.type === "string" ? value.type : "";
}
