import { expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { AgentConsentRegistration } from "neutron-tools/app";
import type { AgentProgress } from "../src/chat_types.ts";
import { AgentRuntime } from "../src/agent_runtime.ts";
import { AgentWorkers, workersSnapshot } from "../src/agent_workers.ts";
import { assertBoundedJson, MSG_BUS_MAX_PAYLOAD_BYTES, MSG_BUS_MAX_PROGRESS_BYTES } from "neutron-tools/protocol";
import { answer, call, finish, fixture, historyId, response, usage } from "./runtime_fixture.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const workerRequest = (options: LanguageModelV4CallOptions) => options.prompt.some((entry) =>
  entry.role === "system" && entry.content.includes("You are an internal worker"));
const mode = (): AgentConsentRegistration => ({ register: () => () => {}, onCancel: () => () => {} });

test("worker tools are exposed only with a live Agent Mode permission registration", async () => {
  for (const enabled of [false, true]) {
    const model = new MockLanguageModelV4({ doStream: answer("Ready.") });
    const { runtime } = await fixture(model);
    await runtime.chat(historyId, "Explain this task.", () => {}, undefined, enabled ? mode() : undefined);
    const names = model.doStreamCalls[0]!.tools?.map((tool) => tool.name) ?? [];
    for (const name of ["spawn_agent", "send_message", "wait_agents", "stop_agent", "list_agents", "get_agent_result"]) {
      expect(names.includes(name)).toBe(enabled);
    }
  }
});

test("workers run model requests in parallel with isolated contexts and shared root consent", async () => {
  const bothStarted = deferred();
  const releaseModels = deferred();
  const firstWrite = deferred();
  const releaseWrites = deferred();
  let workerStarts = 0;
  let parentSteps = 0;
  let activeCalls = 0;
  let peakCalls = 0;
  let callCount = 0;
  const workerSteps = new Map<string, number>();
  const judged: string[] = [];
  let decide!: Parameters<AgentConsentRegistration["register"]>[0];
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (!workerRequest(options)) {
      if (++parentSteps === 1) return response([
        call("spawn_agent", { task: "Inspect record alpha" }),
        call("spawn_agent", { task: "Inspect record beta" }), finish("tool-calls"),
      ]);
      return answer("Compared the two records.");
    }
    const task = JSON.stringify(options.prompt).includes("Inspect record alpha") ? "alpha" : "beta";
    const step = (workerSteps.get(task) ?? 0) + 1;
    workerSteps.set(task, step);
    if (step === 1) {
      if (++workerStarts === 2) bothStarted.resolve();
      await releaseModels.promise;
      return response([call("call_app_tool", { target: "app:records:background", name: "create", arguments: { task } }), finish("tool-calls")]);
    }
    return answer(`Verified result-${task}.`);
  } });
  const { runtime, storage } = await fixture(model, { callTool: async (input: { arguments: { task: string } }) => {
    activeCalls += 1;
    peakCalls = Math.max(peakCalls, activeCalls);
    callCount += 1;
    await decide({ id: `permission-${callCount}` } as Parameters<typeof decide>[0]);
    firstWrite.resolve();
    await releaseWrites.promise;
    activeCalls -= 1;
    return { id: `result-${input.arguments.task}` };
  } });
  Object.assign(runtime, { decidePermission: async (owner: string) => {
    judged.push(owner); return { decision: "allow", reason: "Within owner request" };
  } });
  const run = runtime.chat(historyId, "Inspect two independent records.", (value) => {
    assertBoundedJson(value, "progress", MSG_BUS_MAX_PROGRESS_BYTES);
  }, undefined, { register: (handler) => { decide = handler; return () => {}; }, onCancel: () => () => {} });
  await bothStarted.promise;
  expect(runtime.snapshot(historyId).generatingHere).toBe(true);
  expect(runtime.snapshot(historyId).workers?.active).toBe(2);
  releaseModels.resolve();
  await firstWrite.promise;
  expect(activeCalls).toBe(1);
  releaseWrites.resolve();
  const result = await run;
  expect(peakCalls).toBe(1);
  expect(callCount).toBe(2);
  expect(judged).toEqual(["Inspect two independent records.", "Inspect two independent records."]);
  expect(result.workers?.items.map((worker) => worker.status)).toEqual(["completed", "completed"]);
  const parentRequests = model.doStreamCalls.filter((options) => !workerRequest(options));
  expect(JSON.stringify(parentRequests.at(-1)!.prompt)).toContain("result-alpha");
  expect(JSON.stringify(parentRequests.at(-1)!.prompt)).toContain("result-beta");
  const workers = await storage.loadWorkers(historyId);
  expect(workers).toHaveLength(2);
  for (const worker of workers) {
    const other = worker.task.includes("alpha") ? "beta" : "alpha";
    expect(JSON.stringify(worker.conversation.modelTurns)).not.toContain(`result-${other}`);
    expect(worker.conversation.pendingStateChangeJournal).toBeNull();
    expect(worker.reported).toBe(true);
  }
  assertBoundedJson(result, "snapshot", MSG_BUS_MAX_PAYLOAD_BYTES);
});

for (const cancellation of ["stop", "revoke"] as const) {
  test(`${cancellation} cancels sleeping workers and settles them before releasing the root`, async () => {
    let parentSteps = 0;
    let workerSteps = 0;
    const asleep = deferred();
    let cancel!: () => void;
    let released = false;
    const model = new MockLanguageModelV4({ doStream: async (options) => {
      if (workerRequest(options)) {
        workerSteps += 1;
        return response([call("sleep", { seconds: 86_400 }), finish("tool-calls")]);
      }
      return ++parentSteps === 1 ? response([
        call("spawn_agent", { task: "Monitor alpha" }), call("spawn_agent", { task: "Monitor beta" }), finish("tool-calls"),
      ]) : response([call("wait_agents", {}), finish("tool-calls")]);
    } });
    const { runtime, storage } = await fixture(model);
    const run = runtime.chat(historyId, "Monitor the records.", (value) => {
      const progress = value as AgentProgress;
      if (progress.type === "workers" && progress.workers.items.filter((worker) => worker.status === "waiting").length === 2) asleep.resolve();
    }, undefined, {
      register: () => () => { released = true; },
      onCancel: (handler) => { cancel = () => handler(); return () => {}; },
    });
    await asleep.promise;
    expect(released).toBe(false);
    if (cancellation === "stop") await runtime.stop(historyId);
    else cancel();
    await run;
    expect(released).toBe(true);
    expect(workerSteps).toBe(2);
    expect(runtime.snapshot(historyId).generatingHere).toBe(false);
    const saved = await storage.loadWorkers(historyId);
    expect(saved.map((worker) => worker.status)).toEqual(["stopped", "stopped"]);
    expect(saved.every((worker) => JSON.stringify(worker.conversation.modelTurns).includes("interrupted"))).toBe(true);
  });
}

test("owner steering wakes the parent and its sleeping worker and preserves permission scope", async () => {
  let parentSteps = 0;
  let workerSteps = 0;
  const asleep = deferred();
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (workerRequest(options)) return ++workerSteps === 1
      ? response([call("sleep", { seconds: 86_400 }), finish("tool-calls")])
      : answer("Applied the owner's changed instructions.");
    if (++parentSteps === 1) return response([call("spawn_agent", { task: "Monitor the original record" }), finish("tool-calls")]);
    if (parentSteps === 2) return response([call("wait_agents", {}), finish("tool-calls")]);
    return answer("The updated task is complete.");
  } });
  const { runtime } = await fixture(model);
  const run = runtime.chat(historyId, "Monitor a record.", (value) => {
    const progress = value as AgentProgress;
    if (progress.type === "workers" && progress.workers.items[0]?.status === "waiting") asleep.resolve();
  }, undefined, mode());
  await asleep.promise;
  await runtime.enqueue(historyId, "Change of plan: finish now without writing anything.", "steer");
  await run;
  const secondWorkerRequest = model.doStreamCalls.filter(workerRequest)[1]!;
  expect(JSON.stringify(secondWorkerRequest.prompt)).toContain("finish now without writing anything");
  expect(JSON.stringify(secondWorkerRequest.prompt)).toContain('"wakeReason":"steering"');
  expect(workerSteps).toBe(2);
});

test("completed worker writes survive reload and older residents saving their conversation shape", async () => {
  let root = 0;
  let child = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => workerRequest(options)
    ? ++child === 1 ? response([call("call_app_tool", { target: "app:records:background", name: "create", arguments: {} }), finish("tool-calls")]) : answer("Created saved-record-42.")
    : ++root === 1 ? response([call("spawn_agent", { task: "Create the requested record" }), finish("tool-calls")]) : answer("The record is ready.") });
  const { runtime, storage } = await fixture(model);
  await runtime.chat(historyId, "Create one record.", () => {}, undefined, mode());
  const workers = await storage.loadWorkers(historyId);
  const id = workers[0]!.id;
  const conversation = await storage.loadConversation(historyId);
  await storage.saveConversation(historyId, { ...conversation, messages: [], modelTurns: [] });
  await storage.updateWork(historyId, (work) => { work.steps = 0; });
  const restored = await storage.loadWorkers(historyId);
  expect(restored[0]!.id).toBe(id);
  expect(JSON.stringify(restored[0]!.conversation.modelTurns)).toContain("saved-record-42");
  expect(restored[0]!.conversation.pendingStateChangeJournal).toBeNull();
  await runtime.resetChat(historyId);
  expect(await storage.loadWorkers(historyId)).toEqual([]);
});

test("interrupted worker mutations retain their own reconciliation evidence", async () => {
  let root = 0;
  const writing = deferred();
  const model = new MockLanguageModelV4({ doStream: async (options) => workerRequest(options)
    ? response([call("call_app_tool", { target: "app:records:background", name: "create", arguments: {} }), finish("tool-calls")])
    : ++root === 1 ? response([call("spawn_agent", { task: "Create the requested record" }), finish("tool-calls")])
    : response([call("wait_agents", {}), finish("tool-calls")]) });
  const { runtime, storage } = await fixture(model, {
    callTool: async (_input: unknown, options: { signal: AbortSignal }) => {
      writing.resolve();
      await new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("Write outcome unknown")), { once: true });
      });
    },
  });
  const run = runtime.chat(historyId, "Create a record.", () => {}, undefined, mode());
  await writing.promise;
  await runtime.stop(historyId);
  await run;
  const saved = await storage.loadWorkers(historyId);
  expect(saved[0]!.status).toBe("stopped");
  expect(JSON.stringify(saved[0]!.conversation.modelTurns)).toContain("outcome may be unknown");
  expect(JSON.stringify(saved[0]!.conversation.modelTurns)).toContain("records:background");
});

test("stopping one worker leaves its sibling running", async () => {
  const sleeping = deferred();
  const releaseSibling = deferred();
  const stopped = deferred();
  let runtime: AgentRuntime;
  let root = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (workerRequest(options)) {
      if (JSON.stringify(options.prompt).includes("Slow monitor")) return response([call("sleep", { seconds: 86_400 }), finish("tool-calls")]);
      await releaseSibling.promise;
      return answer("Sibling finished its independent work.");
    }
    if (++root === 1) return response([
      call("spawn_agent", { task: "Slow monitor" }), call("spawn_agent", { task: "Independent check" }), finish("tool-calls"),
    ]);
    if (root === 2) {
      await sleeping.promise;
      const id = runtime.snapshot(historyId).workers!.items.find((worker) => worker.task === "Slow monitor")!.id;
      return response([call("stop_agent", { id, reason: "The independent check covers the requested scope; monitoring is no longer needed." }), finish("tool-calls")]);
    }
    return answer("Independent check finished; monitor stopped.");
  } });
  ({ runtime } = await fixture(model));
  const run = runtime.chat(historyId, "Check records and stop the monitor when unnecessary.", (value) => {
    const progress = value as AgentProgress;
    if (progress.type !== "workers") return;
    if (progress.workers.items.some((worker) => worker.task === "Slow monitor" && worker.status === "waiting")) sleeping.resolve();
    if (progress.workers.items.some((worker) => worker.task === "Slow monitor" && worker.status === "stopped")) stopped.resolve();
  }, undefined, mode());
  await stopped.promise;
  expect(runtime.snapshot(historyId).generatingHere).toBe(true);
  expect(runtime.snapshot(historyId).workers?.items.find((worker) => worker.task === "Independent check")?.status).toBe("running");
  releaseSibling.resolve();
  const result = await run;
  expect(result.workers?.items.map((worker) => worker.status)).toEqual(["stopped", "completed"]);
  expect(result.workers?.items[0]?.error).toBeNull();
  expect(result.workers?.items[0]?.lastStop).toEqual({ by: "coordinator", reason: "The independent check covers the requested scope; monitoring is no longer needed." });
  expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain("monitoring is no longer needed");
});

test("a message arriving during final persistence starts another worker cycle", async () => {
  const { storage } = await fixture(new MockLanguageModelV4({ doStream: answer("Unused") }));
  const savingFinal = deferred();
  const releaseFinal = deferred();
  const originalSave = storage.saveWorkers.bind(storage);
  let blockOnce = true;
  storage.saveWorkers = async (...args) => {
    if (blockOnce && args[1][0]?.status === "completed") {
      blockOnce = false;
      savingFinal.resolve();
      await releaseFinal.promise;
    }
    await originalSave(...args);
  };
  let cycles = 0;
  const applied: string[] = [];
  const workers = new AgentWorkers({
    historyId, storage, records: [], signal: new AbortController().signal,
    modelId: "test/model", models: (await storage.loadShared()).models,
    run: async (worker) => {
      const turn = worker.record.conversation.modelTurns.flat();
      await worker.takeMessages(turn);
      applied.push(JSON.stringify(turn));
      worker.record.result = `Cycle ${++cycles}`;
    },
    recover: () => {}, onChange: () => {}, onFailure: (error) => { throw error; },
  });
  const tools = workers.tools();
  const execution = { toolCallId: "test", messages: [], context: {} };
  const spawned = await tools.spawn_agent.execute!({ task: "Inspect one record" }, execution);
  if (!("id" in spawned)) throw new Error("Expected a worker id");
  await savingFinal.promise;
  const sent = tools.send_message.execute!({ id: spawned.id, message: "Also inspect the linked record." }, execution);
  releaseFinal.resolve();
  await sent;
  while (workers.active) await workers.wait(undefined, new AbortController().signal, new AbortController().signal);
  expect(cycles).toBe(2);
  expect(applied[1]).toContain("Also inspect the linked record");
  await workers.close();
});

test("a new root resumes a crashed worker with saved mutation evidence", async () => {
  const model = new MockLanguageModelV4({ doStream: answer("Initial request finished.") });
  const { runtime, storage } = await fixture(model);
  await storage.saveWorkers(historyId, [{
    id: "saved-worker", task: "Create the requested record", modelId: "test/model", status: "running",
    result: "", error: null, messages: [], steps: 1, inputTokens: 0, outputTokens: 0, reported: false,
    conversation: {
      selectedModelId: "test/model", messages: [],
      modelTurns: [[{ role: "user", content: "Create the requested record" }, { role: "assistant", content: "The create call started." }]],
      pendingStateChangeJournal: { attempts: [{ target: "app:records:background", name: "create" }], overflow: false },
    },
  }]);
  let root = 0;
  const resumed = new MockLanguageModelV4({ doStream: async (options) => workerRequest(options)
    ? answer("The previous create call needs reconciliation before any retry.")
    : ++root === 1 ? response([call("send_message", { id: "saved-worker", message: "Reconcile the previous attempt." }), finish("tool-calls")])
    : answer("Reconciliation is required.") });
  Object.assign(runtime, { provider: { chat: () => resumed } });
  await runtime.chat(historyId, "Resume the previous record task and reconcile any interrupted change.", () => {}, undefined, mode());
  expect(JSON.stringify(resumed.doStreamCalls.find(workerRequest)!.prompt)).toContain("outcome may be unknown");
  expect(JSON.stringify(resumed.doStreamCalls.find(workerRequest)!.prompt)).toContain("records:background");
  const saved = await storage.loadWorkers(historyId);
  expect(saved[0]!.status).toBe("completed");
  expect(saved[0]!.conversation.pendingStateChangeJournal).toBeNull();
});

test("worker status pages fit the existing transport envelope without losing saved workers", () => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    id: String(index), task: "文".repeat(16_000), modelId: "test/model", status: "completed" as const,
    result: "文".repeat(64_000), error: null, messages: [],
    conversation: { selectedModelId: "test/model", messages: [], modelTurns: [], pendingStateChangeJournal: null },
    steps: 1, inputTokens: 1, outputTokens: 1, reported: false,
  }));
  const first = workersSnapshot(records);
  assertBoundedJson(first, "workers", MSG_BUS_MAX_PAYLOAD_BYTES);
  expect(first.omitted).toBeGreaterThan(0);
  const next = workersSnapshot(records, first.items.length);
  expect(next.items[0]?.id).toBe(String(first.items.length));
  expect(first.total).toBe(100);
});

test("goal review waits for workers and receives their actual successful tool evidence", async () => {
  const started = deferred();
  const release = deferred();
  let root = 0;
  let child = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      if (workerRequest(options)) {
        if (++child === 1) {
          started.resolve();
          await release.promise;
          return response([call("call_app_tool", { target: "app:records:background", name: "create", arguments: {} }), finish("tool-calls")]);
        }
        return answer("Created saved-record-42.");
      }
      return ++root === 1 ? response([call("spawn_agent", { task: "Create one record" }), finish("tool-calls")]) : answer("The work is done.");
    },
    doGenerate: async (options) => {
      expect(JSON.stringify(options.prompt)).toContain("saved-record-42");
      expect(JSON.stringify(options.prompt)).toContain("call_app_tool");
      return {
        content: [{ type: "tool-call" as const, toolCallId: "review", toolName: "goal_review", input: JSON.stringify({ status: "complete", checkpoint: "Verified saved-record-42 in the worker's successful tool result." }) }],
        finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage, warnings: [],
      };
    },
  });
  const { runtime } = await fixture(model);
  const run = runtime.chat(historyId, "/goal Create a record.", () => {}, undefined, mode());
  await started.promise;
  expect(model.doGenerateCalls).toHaveLength(0);
  release.resolve();
  const result = await run;
  expect(result.work?.goal?.status).toBe("complete");
  expect(result.workers?.active).toBe(0);
  expect(model.doGenerateCalls).toHaveLength(1);
});

test("a parent stream failure cancels its active workers", async () => {
  const sleeping = deferred();
  let root = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (workerRequest(options)) return response([call("sleep", { seconds: 86_400 }), finish("tool-calls")]);
    if (++root === 1) return response([call("spawn_agent", { task: "Monitor records" }), finish("tool-calls")]);
    await sleeping.promise;
    return response([{ type: "error", error: new Error("Parent provider failed") }]);
  } });
  const { runtime, storage } = await fixture(model);
  const run = runtime.chat(historyId, "Monitor records.", (value) => {
    const progress = value as AgentProgress;
    if (progress.type === "workers" && progress.workers.items[0]?.status === "waiting") sleeping.resolve();
  }, undefined, mode());
  await expect(run).rejects.toThrow("Parent provider failed");
  expect((await storage.loadWorkers(historyId))[0]?.status).toBe("stopped");
  expect(runtime.snapshot(historyId).generatingHere).toBe(false);
});

test("a worker continues truncated synthesis with saved reads and same-step write evidence", async () => {
  let root = 0;
  let child = 0;
  const called: string[] = [];
  const recoveryStates: string[] = [];
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (!workerRequest(options)) return ++root === 1
      ? response([call("spawn_agent", { task: "Read the source messages, save the requested digest, and summarize." }), finish("tool-calls")])
      : answer("The worker completed the requested digest.");
    if (++child === 1) return response([call("call_app_tool", { target: "app:records:background", name: "read", arguments: {} }), finish("tool-calls")]);
    if (child === 2) return response([
      call("call_app_tool", { target: "app:records:background", name: "create", arguments: {} }),
      { type: "text-start", id: "partial" }, { type: "text-delta", id: "partial", delta: "Partial synthesis still missing its conclusion" },
      { type: "text-end", id: "partial" }, finish("length"),
    ]);
    const context = JSON.stringify(options.prompt);
    expect(context).toContain("source-message-81");
    expect(context).toContain("saved-digest-42");
    expect(context).toContain("Partial synthesis still missing its conclusion");
    expect(context).toContain("does not establish an input-context overflow");
    expect(context).toContain("Avoid repeating collection or completed actions");
    return answer("Saved digest saved-digest-42 from source-message-81. No gaps remain for the assigned scope.");
  } });
  const { runtime, storage } = await fixture(model, {
    listTools: async () => [
      { name: "read", inputSchema: { type: "object" }, annotations: { "neutron:effects": ["read"] } },
      { name: "create", inputSchema: { type: "object" }, annotations: { "neutron:effects": ["write"] } },
    ],
    callTool: async ({ name }: { name: string }) => {
      called.push(name);
      return name === "read" ? { id: "source-message-81", content: "Source information. ".repeat(2_000) } : { id: "saved-digest-42" };
    },
  });
  const result = await runtime.chat(historyId, "Read the source and save a digest.", (value) => {
    const progress = value as AgentProgress;
    if (progress.type !== "workers") return;
    for (const worker of progress.workers.items) {
      expect(worker.status).not.toBe("error");
      expect(worker.result).not.toContain("Partial synthesis");
      if (worker.lastRecovery) recoveryStates.push(worker.lastRecovery.state);
    }
  }, undefined, mode());
  expect(child).toBe(3);
  expect(called).toEqual(["read", "create"]);
  expect(recoveryStates).toContain("continuing");
  expect(recoveryStates).toContain("recovered");
  expect(result.workers?.items[0]).toMatchObject({ status: "completed", error: null, lastRecovery: { from: "length", state: "recovered" } });
  const record = (await storage.loadWorkers(historyId))[0]!;
  expect(record.lastRecovery?.state).toBe("recovered");
  expect(record.conversation.pendingStateChangeJournal).toBeNull();
  expect(JSON.stringify(record.conversation.modelTurns)).toContain("saved-digest-42");
  const parent = model.doStreamCalls.filter((options) => !workerRequest(options)).at(-1)!;
  const report = parent.prompt.flatMap((entry) => entry.role === "assistant"
    ? entry.content.flatMap((part) => part.type === "text" ? [part.text] : []) : [])
    .find((text) => text.startsWith("Worker reports and actual tool records"))!;
  expect(JSON.parse(report.slice(report.indexOf("\n") + 1))[0].lastRecovery).toMatchObject({ from: "length", state: "recovered" });
  expect(JSON.stringify(parent.prompt)).toContain("saved-digest-42");
});

test("a truncated malformed tool call is never dispatched and can be corrected on continuation", async () => {
  let root = 0;
  let child = 0;
  let calls = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (!workerRequest(options)) return ++root === 1
      ? response([call("spawn_agent", { task: "Create one requested record." }), finish("tool-calls")]) : answer("Created one record.");
    if (++child === 1) return response([
      { type: "tool-call", toolCallId: "incomplete", toolName: "call_app_tool", input: '{"target":"app:records:background","name":"create","arguments":{' },
      finish("length"),
    ]);
    if (child === 2) {
      expect(calls).toBe(0);
      return response([call("call_app_tool", { target: "app:records:background", name: "create", arguments: {} }), finish("tool-calls")]);
    }
    return answer("Created saved-record-42.");
  } });
  const { runtime } = await fixture(model, { callTool: async () => { calls += 1; return { id: "saved-record-42" }; } });
  const result = await runtime.chat(historyId, "Create one record.", () => {}, undefined, mode());
  expect(calls).toBe(1);
  expect(child).toBe(3);
  expect(result.workers?.items[0]).toMatchObject({ status: "completed", error: null, lastRecovery: { from: "length", state: "recovered" } });
});

test("resuming an errored worker retains its actual failure and marks recovery only after completion", async () => {
  const failed = deferred();
  let runtime: AgentRuntime;
  let root = 0;
  let child = 0;
  const states: string[] = [];
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (workerRequest(options)) return ++child === 1
      ? response([{ type: "error", error: new Error("Source provider temporarily unavailable") }])
      : answer("The source is readable again; here are the verified findings.");
    if (++root === 1) return response([call("spawn_agent", { task: "Inspect the source." }), finish("tool-calls")]);
    if (root === 2) {
      await failed.promise;
      const id = runtime.snapshot(historyId).workers!.items[0]!.id;
      return response([call("send_message", { id, message: "Retry the source read and report verified findings." }), finish("tool-calls")]);
    }
    return answer("The source check recovered.");
  } });
  const state = await fixture(model);
  runtime = state.runtime;
  const result = await runtime.chat(historyId, "Inspect the source.", (value) => {
    const progress = value as AgentProgress;
    if (progress.type !== "workers") return;
    const worker = progress.workers.items[0];
    if (worker?.status === "error") failed.resolve();
    if (worker?.lastRecovery) states.push(worker.lastRecovery.state);
  }, undefined, mode());
  expect(child).toBe(2);
  expect(states).toContain("continuing");
  expect(states.at(-1)).toBe("recovered");
  expect(result.workers?.items[0]).toMatchObject({
    status: "completed", error: null,
    lastRecovery: { from: "error", detail: "Source provider temporarily unavailable", state: "recovered" },
  });
  expect((await state.storage.loadWorkers(historyId))[0]?.lastRecovery).toEqual(result.workers?.items[0]?.lastRecovery);
});

test("repeated output-limit continuation accepts owner steering and Stop retains an interrupted recovery", async () => {
  const secondStarted = deferred();
  const releaseSecond = deferred();
  const steeringApplied = deferred();
  const thirdStarted = deferred();
  const releaseThird = deferred();
  let root = 0;
  let child = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (!workerRequest(options)) return ++root === 1
      ? response([call("spawn_agent", { task: "Summarize the source." }), finish("tool-calls")])
      : answer("Waiting for the worker's verified findings.");
    if (++child === 1) return response([finish("length")]);
    if (child === 2) {
      secondStarted.resolve();
      await releaseSecond.promise;
      return response([finish("length")]);
    }
    expect(JSON.stringify(options.prompt)).toContain("Focus only on the newest messages.");
    thirdStarted.resolve();
    await releaseThird.promise;
    return answer("This response must be ignored after Stop.");
  } });
  const { runtime, storage } = await fixture(model);
  const run = runtime.chat(historyId, "Summarize the source.", (value) => {
    const progress = value as AgentProgress;
    if (progress.type === "turn_start" && progress.user.text === "Focus only on the newest messages.") steeringApplied.resolve();
  }, undefined, mode());
  await secondStarted.promise;
  expect(runtime.snapshot(historyId).workers?.items[0]?.lastRecovery?.state).toBe("continuing");
  await runtime.enqueue(historyId, "Focus only on the newest messages.", "steer");
  await steeringApplied.promise;
  releaseSecond.resolve();
  await thirdStarted.promise;
  await runtime.stop(historyId);
  releaseThird.resolve();
  await run;
  expect(child).toBe(3);
  const worker = (await storage.loadWorkers(historyId))[0]!;
  expect(worker).toMatchObject({ status: "stopped", error: null, lastStop: { by: "parent" }, lastRecovery: { from: "length", state: "interrupted" } });
  expect(worker.result).not.toContain("must be ignored");
  expect(JSON.stringify(worker.conversation.modelTurns)).toContain("Focus only on the newest messages.");
  expect(runtime.snapshot(historyId).generatingHere).toBe(false);
});

test("released worker records preserve saved evidence and normalize intentional stop errors on upgrade", async () => {
  const { storage } = await fixture(new MockLanguageModelV4({ doStream: answer("Unused") }));
  const conversation = {
    selectedModelId: "test/model", messages: [], pendingStateChangeJournal: null,
    modelTurns: [[{ role: "user" as const, content: "Inspect the record." }, { role: "assistant" as const, content: "Saved evidence: source-message-81." }]],
  };
  await storage.saveWorkers(historyId, [{
    id: "released-worker", task: "Inspect the record.", modelId: "test/model", status: "stopped", result: "Saved findings.",
    error: "Worker stopped", messages: [], conversation, steps: 3, inputTokens: 100, outputTokens: 30, reported: true,
  }]);
  const [worker] = await storage.loadWorkers(historyId);
  expect(worker).toMatchObject({ id: "released-worker", status: "stopped", error: null, lastStop: { by: "coordinator" }, lastRecovery: null });
  expect(worker!.lastStop!.reason).toContain("did not record a stop reason");
  expect(worker!.conversation.modelTurns).toEqual(conversation.modelTurns);
  worker!.lastRecovery = { from: "stopped", detail: worker!.lastStop!.reason, state: "recovered" };
  worker!.status = "completed";
  await storage.saveWorkers(historyId, [worker!]);
  expect((await storage.loadWorkers(historyId))[0]).toEqual(worker!);
});
