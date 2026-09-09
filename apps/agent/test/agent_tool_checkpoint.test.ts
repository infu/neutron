import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { jsonSchema, tool, type ModelMessage, type Tool, type ToolCallPart, type ToolResultPart } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { PersistedConversationState } from "../src/chat_types.ts";
import { AgentToolCheckpoint, checkpointToolModelTurn, compactToolModelContext } from "../src/agent_tool_checkpoint.ts";
import { modelMessages, materializePendingStateChangeWarning } from "../src/agent_runtime.ts";
import { AgentStorage, emptyConversationState } from "../src/storage.ts";
import { checkpointModelTurn, excerpt } from "../src/agent_context.ts";
import { answer, call, finish, fixture, historyId, response } from "./runtime_fixture.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function execute(definition: Tool<any, any>, input: unknown, toolCallId: string, signal?: AbortSignal) {
  const output = definition.execute!(input, { toolCallId, messages: [], context: undefined, ...(signal ? { abortSignal: signal } : {}) });
  if (output && typeof output === "object" && Symbol.asyncIterator in output) {
    let last: unknown;
    for await (const value of output) last = value;
    return last;
  }
  return await output;
}

function records(state: PersistedConversationState): Array<ToolCallPart | ToolResultPart> {
  const found: Array<ToolCallPart | ToolResultPart> = [];
  for (const entry of state.modelTurns.flat()) {
    if (typeof entry.content === "string") continue;
    for (const part of entry.content) if (part.type === "tool-call" || part.type === "tool-result") found.push(part);
  }
  return found;
}

async function waitFor(test: () => Promise<boolean>) {
  for (let tries = 0; tries < 250; tries += 1) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Checkpoint did not become durable");
}

test("reopening storage before a response finishes retains exact completed and unfinished tool records", async () => {
  const database = `tool-checkpoint-${crypto.randomUUID()}`;
  const storage = await AgentStorage.open(database);
  const state = emptyConversationState();
  const signal = new AbortController();
  const held = deferred<object>();
  const entered = deferred();
  const checkpoint = new AgentToolCheckpoint({ signal: signal.signal, persist: async (partial) => {
    state.modelTurns = [checkpointModelTurn([{ role: "user", content: "Supply and then inspect the operation." }, ...partial])];
    await storage.saveConversation(historyId, state);
  } });
  const tools = checkpoint.wrap({
    call_app_tool: tool({ inputSchema: jsonSchema<object>({ type: "object" }), execute: async (input) => {
      if ((input as { name: string }).name === "status") { entered.resolve(); return held.promise; }
      return { ok: true, result: { operationId: "20260909001300000000000000000001", receipt: "confirmed-42" } };
    } }),
  });
  const input = { target: "app:aave:background", name: "supply", arguments: {
    operationId: "20260909001300000000000000000001", amount: "3000000", chainId: 1,
  } };
  await execute(tools.call_app_tool, input, "supply-call");
  const pending = execute(tools.call_app_tool, { ...input, name: "status" }, "status-call");
  const pendingCheck = pending.catch((error: unknown) => error);
  await entered.promise;
  // Simulate losing the runtime with no response finish, catch, or final save.
  const reopened = await AgentStorage.open(database);
  const saved = await reopened.loadConversation(historyId);
  expect(records(saved)).toHaveLength(4);
  expect(records(saved)[0]).toEqual({ type: "tool-call", toolCallId: "supply-call", toolName: "call_app_tool", input });
  expect(JSON.stringify(records(saved)[1])).toContain("confirmed-42");
  expect(JSON.stringify(records(saved)[3])).toContain('"outcome":"unknown"');
  expect(JSON.stringify(saved.modelTurns)).toContain("exact saved arguments and operation/request ID");
  await checkpoint.seal();
  const before = JSON.stringify(saved.modelTurns);
  held.resolve({ receipt: "late-result" });
  expect(String(await pendingCheck)).toContain("model step has ended");
  expect(JSON.stringify((await reopened.loadConversation(historyId)).modelTurns)).toBe(before);
});

test("a failed pre-tool checkpoint blocks dispatch", async () => {
  let dispatched = 0;
  const checkpoint = new AgentToolCheckpoint({ signal: new AbortController().signal, persist: async () => {
    throw new Error("IndexedDB transaction failed");
  } });
  const tools = checkpoint.wrap({ write: tool({ inputSchema: jsonSchema<object>({ type: "object" }), execute: async () => { dispatched += 1; return {}; } }) });
  await expect(execute(tools.write, { requestId: "original" }, "write")).rejects.toThrow("IndexedDB transaction failed");
  expect(dispatched).toBe(0);
  await checkpoint.seal();
});

test("Stop during checkpoint persistence never dispatches when that save later finishes", async () => {
  const saved = deferred();
  const started = deferred();
  const controller = new AbortController();
  let dispatched = 0;
  const checkpoint = new AgentToolCheckpoint({ signal: controller.signal, persist: async () => { started.resolve(); await saved.promise; } });
  const tools = checkpoint.wrap({ write: tool({ inputSchema: jsonSchema<object>({ type: "object" }), execute: async () => { dispatched += 1; return {}; } }) });
  const run = execute(tools.write, {}, "write");
  const rejection = run.catch((error: unknown) => error);
  await started.promise;
  controller.abort(new Error("Stopped"));
  const sealing = checkpoint.seal();
  saved.resolve();
  expect(String(await rejection)).toContain("Stopped");
  await sealing;
  expect(dispatched).toBe(0);
});

test("concurrent tool settlements preserve invocation order and never overwrite another result", async () => {
  const left = deferred<string>();
  const right = deferred<string>();
  let saved: ModelMessage[] = [];
  let activeSaves = 0;
  const checkpoint = new AgentToolCheckpoint({ signal: new AbortController().signal, persist: async (partial) => {
    expect(++activeSaves).toBe(1);
    await Promise.resolve();
    saved = structuredClone(partial);
    activeSaves -= 1;
  } });
  const tools = checkpoint.wrap({ read: tool({ inputSchema: jsonSchema<{ id: string }>({ type: "object" }), execute: ({ id }) => id === "left" ? left.promise : right.promise }) });
  const one = execute(tools.read, { id: "left" }, "first");
  const two = execute(tools.read, { id: "right" }, "second");
  right.resolve("right-receipt");
  await two;
  left.resolve("left-receipt");
  await one;
  const state = { ...emptyConversationState(), modelTurns: [saved] };
  expect(records(state).map((record) => record.toolCallId)).toEqual(["first", "first", "second", "second"]);
  expect(JSON.stringify(records(state)[1])).toContain("left-receipt");
  expect(JSON.stringify(records(state)[3])).toContain("right-receipt");
  await checkpoint.seal();
});

test("tool errors are persisted with their matching exact call", async () => {
  let saved: ModelMessage[] = [];
  const checkpoint = new AgentToolCheckpoint({ signal: new AbortController().signal, persist: async (partial) => { saved = structuredClone(partial); } });
  const tools = checkpoint.wrap({ read: tool({ inputSchema: jsonSchema<object>({ type: "object" }), execute: async (): Promise<object> => { throw new Error("Provider unavailable; outcome not established"); } }) });
  await expect(execute(tools.read, { operationId: "retain-this-id" }, "failed-read")).rejects.toThrow("Provider unavailable");
  expect(JSON.stringify(saved)).toContain("retain-this-id");
  expect(JSON.stringify(saved)).toContain('"type":"error-text"');
  expect(JSON.stringify(saved)).toContain("Provider unavailable; outcome not established");
  await checkpoint.seal();
});

test("checkpoint output matches SDK string and undefined output semantics", async () => {
  let saved: ModelMessage[] = [];
  const checkpoint = new AgentToolCheckpoint({ signal: new AbortController().signal, persist: async (partial) => { saved = structuredClone(partial); } });
  const tools = checkpoint.wrap({
    text: tool({ inputSchema: jsonSchema<object>({ type: "object" }), execute: async () => "receipt-text" }),
    empty: tool({ inputSchema: jsonSchema<object>({ type: "object" }), execute: async () => undefined }),
  });
  await execute(tools.text, {}, "text");
  await execute(tools.empty, {}, "empty");
  const results = records({ ...emptyConversationState(), modelTurns: [saved] }).filter((part) => part.type === "tool-result");
  expect(results.map((part) => part.output)).toEqual([{ type: "text", value: "receipt-text" }, { type: "json", value: null }]);
  await checkpoint.seal();
});

test("sealing during asynchronous output conversion prevents a late checkpoint overwrite", async () => {
  let saved: ModelMessage[] = [];
  const converting = deferred();
  const converted = deferred();
  const checkpoint = new AgentToolCheckpoint({ signal: new AbortController().signal, persist: async (partial) => { saved = structuredClone(partial); } });
  const tools = checkpoint.wrap({ read: tool({
    inputSchema: jsonSchema<object>({ type: "object" }), execute: async () => "original-result",
    toModelOutput: async () => { converting.resolve(); await converted.promise; return { type: "text", value: "converted-result" }; },
  }) });
  const run = execute(tools.read, {}, "converting").catch((error: unknown) => error);
  await converting.promise;
  // Sealing waits for storage only, never a converter or remote tool.
  await checkpoint.seal();
  converted.resolve();
  expect(String(await run)).toContain("model step has ended");
  expect(JSON.stringify(saved)).not.toContain("converted-result");
  expect(JSON.stringify(saved)).toContain('"outcome":"unknown"');
});

test("large result compaction preserves every current-step call ID and exact arguments", () => {
  const partial: ModelMessage[] = [];
  for (let index = 0; index < 8; index += 1) partial.push(
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `call-${index}`, toolName: "call_app_tool", input: {
      target: "app:uniswap:background", name: "uniswap_manage_liquidity_v1",
      arguments: { operationId: `exact-original-operation-${index}`, amount: "12345678901234567890", tokenId: "1362749" },
    } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `call-${index}`, toolName: "call_app_tool", output: {
      type: "json", value: { status: "pending", receipt: `receipt-${index}`, details: '"'.repeat(120_000), operationId: `exact-original-operation-${index}` },
    } }] },
  );
  const saved = checkpointToolModelTurn([{ role: "user", content: "Continue using exact saved operations; do not recreate them." }], partial);
  expect(JSON.stringify(saved).length).toBeLessThanOrEqual(600_000);
  const calls = records({ ...emptyConversationState(), modelTurns: [saved] }).filter((part) => part.type === "tool-call");
  expect(calls).toEqual(records({ ...emptyConversationState(), modelTurns: [partial] }).filter((entry) => entry.type === "tool-call"));
  expect(JSON.stringify(saved)).toContain("Compacted tool result");
  expect(JSON.stringify(saved)).toContain("Some fields are omitted");
});

test("a trailing interruption warning does not hide the saved tool evidence on model resume", () => {
  const state = emptyConversationState();
  const partial: ModelMessage[] = [];
  for (let index = 0; index < 4; index += 1) partial.push(
    { role: "assistant", content: [{ type: "tool-call", toolCallId: `recover-${index}`, toolName: "call_app_tool", input: {
      target: "app:aave:background", name: "aave_execute_v1", arguments: { operationId: `original-recovery-id-${index}`, amount: "3000000" },
    } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `recover-${index}`, toolName: "call_app_tool", output: {
      type: "json", value: { state: index === 3 ? "unknown" : "complete", receipt: `exact-receipt-${index}`, data: "x".repeat(70_000) },
    } }] },
  );
  state.modelTurns = [checkpointToolModelTurn([{ role: "user", content: "Review saved operations." }], partial)];
  state.pendingStateChangeJournal = { attempts: [{ target: "app:aave:background", name: "aave_execute_v1" }], overflow: false };
  materializePendingStateChangeWarning(state);
  expect(state.modelTurns).toHaveLength(2);
  const resumed = modelMessages(state.modelTurns, { role: "user", content: "Resume from saved evidence without repeating a mutation." }, 8_000);
  expect(JSON.stringify(resumed).length).toBeLessThanOrEqual(24_000);
  const calls = records({ ...emptyConversationState(), modelTurns: [resumed] }).filter((entry) => entry.type === "tool-call");
  expect(calls).toEqual(records({ ...emptyConversationState(), modelTurns: [partial] }).filter((entry) => entry.type === "tool-call"));
  expect(JSON.stringify(resumed)).toContain("exact-receipt-0");
  expect(JSON.stringify(resumed)).toContain("outcome may be unknown");
  // Worker contexts flatten the same persisted turns before model submission.
  const workerResume = compactToolModelContext(state.modelTurns.flat(), 24_000);
  expect(JSON.stringify(workerResume).length).toBeLessThanOrEqual(24_000);
  expect(records({ ...emptyConversationState(), modelTurns: [workerResume] }).filter((entry) => entry.type === "tool-call")).toEqual(calls);
});

test("tiny excerpt budgets stay bounded instead of returning all omitted input", () => {
  for (const budget of [0, 1, 20, 52, 53, 54, 55, 56, 57, 58]) {
    const result = excerpt("secret-omitted-body".repeat(100), budget);
    expect(result.length).toBeLessThanOrEqual(budget);
    expect(result).not.toContain("secret-omitted-body".repeat(100));
  }
});

test("inputs exceeding the existing context window explicitly report lost detail", () => {
  const partial: ModelMessage[] = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "oversized", toolName: "call_app_tool", input: { arguments: { data: "x".repeat(40_000) } } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "oversized", toolName: "call_app_tool", output: { type: "json", value: { outcome: "unknown" } } }] },
  ];
  const result = checkpointToolModelTurn([{ role: "user", content: "Resume safely." }], partial, 8_000);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(8_000);
  expect(JSON.stringify(result)).toContain("Some older details were omitted");
  expect(JSON.stringify(result)).toContain("reconcile uncertain changes before retrying");
});

test("a successful complete response replaces its partial checkpoint without duplicate tool calls", async () => {
  const model = new MockLanguageModelV4({ doStream: [
    response([call("call_app_tool", { target: "app:records:background", name: "create", arguments: { operationId: "one-intent" } }, "11111111-1111-1111-1111-111111111111"), finish("tool-calls")]),
    answer("Created the record."),
  ] });
  const { runtime, storage } = await fixture(model);
  await runtime.chat(historyId, "Create one record.", () => {});
  const saved = await storage.loadConversation(historyId);
  expect(records(saved).filter((entry) => entry.type === "tool-call" && entry.toolCallId === "11111111-1111-1111-1111-111111111111")).toHaveLength(1);
  expect(records(saved).filter((entry) => entry.type === "tool-result" && entry.toolCallId === "11111111-1111-1111-1111-111111111111")).toHaveLength(1);
  expect(JSON.stringify(saved.modelTurns)).not.toContain("interrupted_or_in_progress");
});

for (const worker of [false, true]) {
  test(`${worker ? "worker" : "main"} preserves completed tools when interrupted during a later call in the same response`, async () => {
    let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
    const ready = deferred();
    const held = deferred<object>();
    const secondEntered = deferred();
    let mainRequests = 0;
    let effects = 0;
    const model = new MockLanguageModelV4({ doStream: async (options) => {
      const isWorker = options.prompt.some((entry) => entry.role === "system" && entry.content.includes("You are an internal worker"));
      if (worker && !isWorker) {
        return ++mainRequests === 1 ? response([call("spawn_agent", { task: "Create and inspect the record" }), finish("tool-calls")]) : answer("Worker evidence reviewed.");
      }
      if (!worker && ++mainRequests > 1) return answer("Resumed using saved results.");
      return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(stream) {
        controller = stream;
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue(call("call_app_tool", { target: "app:records:background", name: "create", arguments: { operationId: "saved-original-operation" } }, "22222222-2222-2222-2222-222222222222"));
        controller.enqueue(call("call_app_tool", { target: "app:records:background", name: "create", arguments: { operationId: "unfinished-original-operation" } }, "33333333-3333-3333-3333-333333333333"));
        controller.enqueue(finish("tool-calls"));
        controller.close();
        ready.resolve();
      } }) };
    } });
    const { runtime, storage } = await fixture(model, { callTool: async (input: { arguments: { operationId: string } }) => {
      if (input.arguments.operationId === "unfinished-original-operation") { secondEntered.resolve(); return held.promise; }
      effects += 1;
      return { id: "durable-receipt-before-crash" };
    } });
    const mode = worker ? { register: () => () => {}, onCancel: () => () => {} } : undefined;
    const run = runtime.chat(historyId, "Create and inspect one record.", () => {}, undefined, mode);
    const finished = run.catch((error: unknown) => error);
    await ready.promise;
    const load = async () => worker ? (await storage.loadWorkers(historyId))[0]!.conversation : storage.loadConversation(historyId);
    await waitFor(async () => JSON.stringify((await load()).modelTurns).includes("durable-receipt-before-crash"));
    await secondEntered.promise;
    await runtime.stop(historyId);
    await finished;
    const saved = await load();
    expect(JSON.stringify(saved.modelTurns)).toContain("durable-receipt-before-crash");
    expect(JSON.stringify(saved.modelTurns)).toContain("saved-original-operation");
    expect(JSON.stringify(saved.modelTurns)).toContain("unfinished-original-operation");
    expect(JSON.stringify(saved.modelTurns)).toContain('"outcome":"unknown"');
    expect(effects).toBe(1);
    if (!worker) {
      await runtime.chat(historyId, "Resume using status reads; do not repeat the effect.", () => {});
      expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt)).toContain("durable-receipt-before-crash");
      expect(JSON.stringify(model.doStreamCalls.at(-1)!.prompt)).toContain("unfinished-original-operation");
    }
    const beforeLate = JSON.stringify((await load()).modelTurns);
    held.resolve({ id: "late-tool-result" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(JSON.stringify((await load()).modelTurns)).toBe(beforeLate);
  });
}
