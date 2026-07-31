import { expect, test } from "bun:test";
import type {
  ChatRuntimeRequest,
  ChatSnapshot,
  ChatWorkerOutbound,
} from "../src/chat_types.ts";
import {
  createWorkerBridge,
  RuntimeBridgeManager,
} from "../src/runtime_bridge.ts";

class FakeWorker {
  readonly requests: ChatRuntimeRequest[] = [];
  terminated = false;

  private readonly listeners = new Map<
    string,
    Array<(event: MessageEvent<ChatWorkerOutbound> | Event) => void>
  >();

  addEventListener(
    type: string,
    listener: (event: MessageEvent<ChatWorkerOutbound> | Event) => void
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(request: ChatRuntimeRequest): void {
    if (this.terminated) throw new Error("Worker is terminated");
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  send(message: ChatWorkerOutbound): void {
    this.dispatch("message", new MessageEvent("message", { data: message }));
  }

  fail(): void {
    this.dispatch("error", new Event("error"));
  }

  private dispatch(
    type: string,
    event: MessageEvent<ChatWorkerOutbound> | Event
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("a worker failure rejects pending and future calls instead of hanging", async () => {
  const worker = new FakeWorker();
  const bridgePromise = createWorkerBridge(worker as unknown as Worker);
  worker.send({ type: "ready", snapshot: snapshot() });
  const bridge = await bridgePromise;

  const pendingLoad = bridge.call("load");
  expect(worker.requests).toHaveLength(1);
  worker.fail();

  await expect(pendingLoad).rejects.toThrow("Model worker failed to load");
  await expect(bridge.call("load")).rejects.toThrow(
    "Model worker failed to load"
  );
  expect(worker.terminated).toBe(true);
  expect(bridge.isAvailable()).toBe(false);
  expect(bridge.status()).toMatchObject({
    stage: "error",
    modelLoaded: false,
    statusText: "Model worker failed to load",
  });
});

test("retrying load replaces a failed worker bridge", async () => {
  const workers: FakeWorker[] = [];
  const manager = new RuntimeBridgeManager(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    const bridge = createWorkerBridge(worker as unknown as Worker);
    queueMicrotask(() => worker.send({ type: "ready", snapshot: snapshot() }));
    return bridge;
  });

  await manager.status();
  const failedLoad = manager.call("load");
  await waitFor(() => workers[0]?.requests.length === 1);
  workers[0]?.fail();
  await expect(failedLoad).rejects.toThrow("Model worker failed to load");

  expect(await manager.status()).toMatchObject({ stage: "error" });
  const retry = manager.call("load");
  await waitFor(() => workers[1]?.requests.length === 1);
  const request = workers[1]?.requests[0];
  expect(request?.method).toBe("load");
  workers[1]?.send({
    type: "response",
    id: request?.id ?? -1,
    ok: snapshot({
      stage: "ready",
      statusText: "Ready for local chat.",
      modelLoaded: true,
      loadProgress: 1,
    }),
  });

  expect(await retry).toMatchObject({ stage: "ready", modelLoaded: true });
  expect(workers).toHaveLength(2);
});

function snapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    stage: "idle",
    statusText: "Load gemma-4-expr-tst to begin.",
    modelId: "Vzmoi/gemma-4-expr-tst",
    modelLoaded: false,
    loadProgress: null,
    webGpuAvailable: true,
    messages: [],
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for worker request");
}
