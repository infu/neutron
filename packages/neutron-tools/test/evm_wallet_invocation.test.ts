import { expect, test } from "bun:test";
import { createEvmWalletInvocationClient, EVM_WALLET_TOOLS } from "../src/evm_wallet.ts";
import { createQueuedInvocationToolClient } from "../src/invocation_tool_queue.ts";
import type { JsonValue, MsgBusCallOptions, MsgBusToolCall, MsgBusToolContext } from "../src/protocol.ts";

const address = `0x${"ab".repeat(20)}`;
const parallelReadTools = [EVM_WALLET_TOOLS.callContract];
const request = (index: number) => ({ accountId: "main" as const, chainId: "1", to: address, data: `0x${index.toString(16).padStart(2, "0")}` });
const readResult = (call: MsgBusToolCall): JsonValue => ({ ...call.arguments, address, result: "0x", blockNumber: "1", observedAtNs: "1" });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function context(dispatch: (call: MsgBusToolCall, options?: number | MsgBusCallOptions) => Promise<JsonValue>, signal?: AbortSignal): MsgBusToolContext {
  const kernel = { callTool(call: MsgBusToolCall, options?: number | MsgBusCallOptions) {
    expect(this).toBe(kernel);
    return dispatch(call, options);
  } };
  return { kernel: kernel as MsgBusToolContext["kernel"], agentMode: true, reportProgress() {}, ...(signal ? { signal } : {}) };
}

test("separate Wallet clients share the invocation's four nested-read slots and drain every candidate FIFO", async () => {
  const held = barrier(), calls: string[] = [];
  let active = 0, maximum = 0;
  const ctx = context(async (call) => {
    calls.push(String(call.arguments!.data));
    active++; maximum = Math.max(maximum, active);
    try {
      if (active > 4) throw new Error("Too many parallel agent calls");
      await held.promise;
      return readResult(call);
    } finally { active--; }
  });
  const clients = [createEvmWalletInvocationClient(ctx, { parallelReadTools }), createEvmWalletInvocationClient({ ...ctx }, { parallelReadTools })];
  const reads = Array.from({ length: 32 }, (_, index) => clients[index % 2]!.callContract(request(index)));
  expect(calls).toEqual([0, 1, 2, 3].map((index) => request(index).data));
  held.release();
  expect(await Promise.all(reads)).toHaveLength(32);
  expect(calls).toEqual(Array.from({ length: 32 }, (_, index) => request(index).data));
  expect(maximum).toBe(4);
});

test.each(["context", "request"])("queued reads reject immediately on %s cancellation without dispatch", async (source) => {
  const held = barrier(), controller = new AbortController(), calls: string[] = [];
  const ctx = context(async (call) => { calls.push(String(call.arguments!.data)); await held.promise; return readResult(call); }, source === "context" ? controller.signal : undefined);
  const client = createEvmWalletInvocationClient(ctx, { parallelReadTools });
  const active = Array.from({ length: 4 }, (_, index) => client.callContract(request(index)));
  const cancelled = client.callContract(request(4), source === "request" ? { signal: controller.signal } : undefined).catch((error: unknown) => error);
  const reason = new Error("Stop this invocation");
  controller.abort(reason);
  expect(await cancelled).toBe(reason);
  expect(calls).toHaveLength(4);
  held.release();
  await Promise.all(active);
  // The cancelled entry is gone; clients with a live context still use the queue.
  const live = createEvmWalletInvocationClient({ kernel: ctx.kernel, agentMode: true }, { parallelReadTools });
  await live.callContract(request(5));
  expect(calls).toEqual([0, 1, 2, 3, 5].map((index) => request(index).data));
});

test("synchronous transport throws and denied reads release capacity without poisoning queued candidates", async () => {
  const held = barrier();
  const ctx = context((call) => {
    if (call.arguments!.data === request(0).data) throw new Error("Synchronous transport error");
    return held.promise.then(() => {
      if (call.arguments!.data === request(1).data) throw new Error("Read denied");
      return readResult(call);
    });
  });
  const client = createEvmWalletInvocationClient(ctx, { parallelReadTools });
  const reads = Array.from({ length: 12 }, (_, index) => client.callContract(request(index)));
  const settled = Promise.allSettled(reads);
  held.release();
  const results = await settled;
  expect(results[0]).toMatchObject({ status: "rejected", reason: { message: "Synchronous transport error" } });
  expect(results[1]).toMatchObject({ status: "rejected", reason: { message: "Read denied" } });
  expect(results.slice(2).every((result) => result.status === "fulfilled")).toBe(true);
});

test("serial calls across clients do not overlap reviews, while reads use the remaining shared capacity", async () => {
  const firstEffect = barrier(), readsHeld = barrier(), secondEntered = barrier();
  let active = 0, serialActive = 0, maximum = 0, maximumSerial = 0;
  const seen: string[] = [];
  const ctx = context(async (call) => {
    active++; maximum = Math.max(maximum, active);
    seen.push(call.name);
    const serial = call.name !== "read";
    if (serial) { serialActive++; maximumSerial = Math.max(maximumSerial, serialActive); }
    try {
      if (call.name === "effect1") { await firstEffect.promise; throw new Error("Review declined"); }
      if (call.name === "effect2") secondEntered.release();
      if (!serial) await readsHeld.promise;
      return {};
    } finally { active--; if (serial) serialActive--; }
  });
  const one = createQueuedInvocationToolClient(ctx, (call) => call.name === "read");
  const two = createQueuedInvocationToolClient({ ...ctx }, (call) => call.name === "read");
  const first = one.callTool({ target: "app:evm_wallet:background", name: "effect1" }).catch((error: unknown) => error);
  const second = two.callTool({ target: "app:evm_wallet:background", name: "effect2" });
  const reads = Array.from({ length: 8 }, () => one.callTool({ target: "app:evm_wallet:background", name: "read" }));
  expect(seen).toEqual(["effect1", "read", "read", "read"]);
  firstEffect.release();
  await secondEntered.promise;
  expect(await first).toMatchObject({ message: "Review declined" });
  readsHeld.release();
  await Promise.all([second, ...reads]);
  expect(maximum).toBe(4);
  expect(maximumSerial).toBe(1);
});

test("the scheduler preserves the scoped receiver, exact call and transport options", async () => {
  const controller = new AbortController();
  const call: MsgBusToolCall = { target: "app:evm_wallet:background", name: "read", arguments: { accountId: "main" } };
  const options: MsgBusCallOptions = { timeout: 4321, signal: controller.signal, onProgress() {} };
  const ctx = context(async (received, transport) => {
    expect(received).toBe(call);
    expect(transport).toBe(options);
    return { scoped: true };
  });
  const client = createQueuedInvocationToolClient(ctx, () => true);
  expect(await client.callTool(call, options)).toEqual({ scoped: true });
});

test("different scoped invocations do not share capacity, and ordinary clients retain direct dispatch", async () => {
  const held = barrier();
  let calls = 0;
  const dispatch = async (call: MsgBusToolCall) => { calls++; await held.promise; return readResult(call); };
  const one = createEvmWalletInvocationClient(context(dispatch), { parallelReadTools });
  const two = createEvmWalletInvocationClient(context(dispatch), { parallelReadTools });
  const ordinary = createEvmWalletInvocationClient({ ...context(dispatch), agentMode: false }, { parallelReadTools });
  const pending = [one, two].flatMap((client) => Array.from({ length: 4 }, (_, index) => client.callContract(request(index))));
  pending.push(...Array.from({ length: 8 }, (_, index) => ordinary.callContract(request(index))));
  expect(calls).toBe(16);
  held.release();
  await Promise.all(pending);
});

test("an already cancelled invocation sends no call even with capacity available", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Cancelled before quoting"));
  let calls = 0;
  const client = createEvmWalletInvocationClient(context(async (call) => { calls++; return readResult(call); }, controller.signal), { parallelReadTools });
  await expect(client.callContract(request(0))).rejects.toThrow("Cancelled before quoting");
  expect(calls).toBe(0);
});
