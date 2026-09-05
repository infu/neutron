import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { AgentProgress } from "../src/chat_types.ts";
import { AgentRuntime, modelMessages } from "../src/agent_runtime.ts";
import { sleepUntil } from "../src/agent_work.ts";
import { assertBoundedJson, MSG_BUS_MAX_PROGRESS_BYTES } from "neutron-tools/protocol";

import { historyId, finish, call, response, answer, fixture, usage } from "./runtime_fixture.ts";

test("a fresh reviewer rejects early completion and the worker continues with actual evidence", async () => {
  let review = 0;
  const model = new MockLanguageModelV4({
    doStream: [
      response([call("list_apps", {}), finish("tool-calls")]),
      answer("I have finished."),
      response([call("call_app_tool", { target: "app:records:background", name: "create", arguments: {} }), finish("tool-calls")]),
      answer("Created saved-record-42."),
    ],
    doGenerate: async () => ({
      content: [{ type: "tool-call", toolCallId: "review", toolName: "goal_review", input: JSON.stringify(++review === 1
        ? { status: "continue", checkpoint: "The record has not been created. Create it and verify its identifier." }
        : { status: "complete", checkpoint: "Verified creation of saved-record-42 in the successful tool result." }) }],
      finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [],
    }),
  });
  const { runtime, storage } = await fixture(model);
  const result = await runtime.chat(historyId, "/goal Create a record and report its identifier.", () => undefined);
  expect(model.doStreamCalls).toHaveLength(4);
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("saved-record-42");
  expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain("The record has not been created");
  expect(result.work?.goal?.status).toBe("complete");
  expect((await storage.loadConversation(historyId)).modelTurns).toHaveLength(1);
});

for (const ending of ["abort", "error", "length"] as const) {
  test(`a ${ending} after a completed write never becomes a successful empty answer`, async () => {
    let runtime: AgentRuntime;
    let requests = 0;
    const model = new MockLanguageModelV4({ doStream: async () => {
      if (++requests === 1) return response([call("call_app_tool", {
        target: "app:records:background", name: "create", arguments: {},
      }), finish("tool-calls")]);
      if (ending === "abort") {
        await runtime.stop(historyId);
        return answer("Should be ignored");
      }
      return ending === "length" ? response([finish("length")])
        : response([{ type: "error", error: new Error("Provider stream failed") }]);
    } });
    const state = await fixture(model);
    runtime = state.runtime;
    const run = runtime.chat(historyId, "Create one record.", () => undefined);
    if (ending === "abort") await run;
    else await expect(run).rejects.toThrow(ending === "length" ? "before completion" : "Provider stream failed");
    const saved = await state.storage.loadConversation(historyId);
    expect(JSON.stringify(saved.modelTurns)).toContain("saved-record-42");
    expect(JSON.stringify(saved.messages)).not.toContain("completed without a text response");
    expect(JSON.stringify(saved.messages)).not.toContain("Should be ignored");
    expect(runtime.snapshot(historyId).generatingHere).toBe(false);
  });
}

test("steering wakes a day-long sleep and arrives as an owner message at the next step", async () => {
  const model = new MockLanguageModelV4({ doStream: [
    response([call("sleep", { seconds: 86_400 }), finish("tool-calls")]),
    answer("I woke for your correction."),
  ] });
  const { runtime, storage } = await fixture(model);
  let sleeping!: () => void;
  const asleep = new Promise<void>((resolve) => { sleeping = resolve; });
  const run = runtime.chat(historyId, "Wait until tomorrow.", (value) => {
    const event = value as AgentProgress;
    if (event.type === "work" && event.work.wakeAt) sleeping();
  });
  await asleep;
  await runtime.enqueue(historyId, "Change of plan: finish now.", "steer");
  await run;
  expect(model.doStreamCalls).toHaveLength(2);
  const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
  expect(prompt).toContain('"wakeReason":"steering"');
  expect(prompt).toContain("Change of plan: finish now.");
  expect((await storage.loadWork(historyId)).queue).toHaveLength(0);
  const saved = await storage.loadConversation(historyId);
  expect(saved.modelTurns[0]?.filter((entry) => entry.role === "user")).toHaveLength(2);
});

test("Stop cancels sleep and durably pauses the goal", async () => {
  const model = new MockLanguageModelV4({ doStream: response([call("sleep", { seconds: 86_400 }), finish("tool-calls")]) });
  const { runtime, storage } = await fixture(model);
  let sleeping!: () => void;
  const asleep = new Promise<void>((resolve) => { sleeping = resolve; });
  const run = runtime.chat(historyId, "/goal Monitor until tomorrow.", (value) => {
    const event = value as AgentProgress;
    if (event.type === "work" && event.work.wakeAt) sleeping();
  });
  await asleep;
  await runtime.stop(historyId);
  await run;
  expect((await storage.loadWork(historyId)).goal?.status).toBe("paused");
  expect(JSON.stringify((await storage.loadConversation(historyId)).modelTurns)).toContain("interrupted");
  expect(model.doStreamCalls).toHaveLength(1);
});

test("queued messages wait for a work-cycle boundary and run in order", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let called!: () => void;
  const entered = new Promise<void>((resolve) => { called = resolve; });
  let count = 0;
  const model = new MockLanguageModelV4({ doStream: async () => {
    if (++count === 1) { called(); await gate; }
    return answer(`Answer ${count}`);
  } });
  const { runtime } = await fixture(model);
  const run = runtime.chat(historyId, "First request.", () => undefined);
  await entered;
  await runtime.enqueue(historyId, "Second request.", "queue");
  await runtime.enqueue(historyId, "Third request.", "queue");
  expect(model.doStreamCalls).toHaveLength(1);
  release();
  await run;
  expect(model.doStreamCalls).toHaveLength(3);
  expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("Second request.");
  expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).not.toContain("Third request.");
  expect(JSON.stringify(model.doStreamCalls[2]!.prompt)).toContain("Third request.");
});

test("oversized tool history retains the task and recent evidence", () => {
  const turn: ModelMessage[] = [
    { role: "user", content: "Original task: inspect all four records." },
    ...Array.from({ length: 4 }, (_, index): ModelMessage => ({ role: "assistant", content: `record-${index}: ` + "x".repeat(160_000) })),
    { role: "assistant", content: "Latest verified identifier: record-3" },
  ];
  const context = modelMessages([turn], { role: "user", content: "Continue." }, 200_000);
  expect(JSON.stringify(context)).toContain("Original task");
  expect(JSON.stringify(context)).toContain("record-3");
  expect(context.length).toBeGreaterThan(1);
  expect(JSON.stringify(context).length).toBeLessThan(600_000);
});

test("sleep validates durations and handles pre-existing cancellation", async () => {
  const controller = new AbortController();
  const steering = new AbortController();
  await expect(sleepUntil(-1, controller.signal, steering.signal)).rejects.toThrow("non-negative");
  controller.abort(new Error("Stopped"));
  await expect(sleepUntil(30, controller.signal, steering.signal)).rejects.toThrow("Stopped");
});

test("an ordinary task continues beyond 32 tool steps without forcing a final answer", async () => {
  let count = 0;
  const model = new MockLanguageModelV4({ doStream: async () => ++count <= 35
    ? response([call("list_apps", {}), finish("tool-calls")]) : answer("Verified every record.") });
  const { runtime } = await fixture(model);
  const result = await runtime.chat(historyId, "Inspect all records.", () => undefined);
  expect(model.doStreamCalls).toHaveLength(36);
  expect(result.messages.at(-1)?.text).toBe("Verified every record.");
});

test("steering waits for an in-flight mutation and updates the permission judge's owner instructions", async () => {
  let finishWrite!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const write = new Promise<void>((resolve) => { finishWrite = resolve; });
  let decide!: (challenge: unknown) => Promise<unknown>;
  let judgedGoal = "";
  let steps = 0;
  const model = new MockLanguageModelV4({ doStream: async () => {
    if (++steps === 1) return response([call("call_app_tool", { target: "app:records:background", name: "create", arguments: {} }), finish("tool-calls")]);
    await decide({ id: "challenge" });
    return answer("Applied your correction after the write settled.");
  } });
  const { runtime, storage } = await fixture(model, { callTool: async () => { entered(); await write; return { id: "known-result" }; } });
  Object.assign(runtime, { decidePermission: async (goal: string) => { judgedGoal = goal; return { decision: "deny", reason: "No more writes" }; } });
  const run = runtime.chat(historyId, "Create one record.", () => undefined, undefined, {
    register: (handler) => { decide = handler as typeof decide; return () => {}; },
    onCancel: () => () => {},
  });
  await writing;
  await runtime.enqueue(historyId, "Do not create any more records.", "steer");
  expect(model.doStreamCalls).toHaveLength(1);
  finishWrite();
  await run;
  const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
  expect(prompt).toContain("known-result");
  expect(prompt).toContain("Do not create any more records.");
  expect(judgedGoal).toContain("Create one record.");
  expect(judgedGoal).toContain("Do not create any more records.");
  expect(judgedGoal).not.toContain("known-result");
  expect((await storage.loadWork(historyId)).queue).toHaveLength(0);
});

test("cancellation during a write retains the uncertainty warning before another turn", async () => {
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const model = new MockLanguageModelV4({ doStream: response([
    call("call_app_tool", { target: "app:records:background", name: "create", arguments: {} }), finish("tool-calls"),
  ]) });
  const { runtime, storage } = await fixture(model, {
    callTool: async (_call: unknown, options: { signal: AbortSignal }) => {
      entered();
      await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("Write outcome unknown")), { once: true }));
    },
  });
  const run = runtime.chat(historyId, "/goal Create one record.", () => undefined);
  await writing;
  await runtime.stop(historyId);
  await run;
  const saved = await storage.loadConversation(historyId);
  expect(saved.messages.at(-1)?.text).toContain("outcome may be unknown");
  expect(JSON.stringify(saved.modelTurns)).toContain("records:background");
  expect((await storage.loadWork(historyId)).goal?.status).toBe("paused");
});

test("large completed text refreshes status without exceeding the progress envelope", async () => {
  const model = new MockLanguageModelV4({ doStream: answer("文".repeat(64_000)) });
  const { runtime } = await fixture(model);
  const progress: AgentProgress[] = [];
  await runtime.chat(historyId, "Read the result.", (value) => {
    assertBoundedJson(value, "progress", MSG_BUS_MAX_PROGRESS_BYTES);
    progress.push(value as AgentProgress);
  });
  expect(progress.some((event) => event.type === "refresh")).toBe(true);
  expect(runtime.snapshot(historyId).messages.at(-1)?.text).toHaveLength(64_000);
});
