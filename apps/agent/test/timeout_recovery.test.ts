import { expect, test } from "bun:test";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentConsentRegistration } from "neutron-tools/app";
import type { AgentStreamRunner } from "../src/agent_step.ts";
import { answer, call, finish, fixture, historyId, response } from "./runtime_fixture.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A test watchdog, not an Agent execution deadline. Always release the
 * controlled provider in finally so a failing regression cannot strand it. */
async function promptly<T>(pending: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Agent did not settle after cancellation")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function consent() {
  let released = false;
  const registration: AgentConsentRegistration = {
    register: () => () => { released = true; },
    onCancel: () => () => {},
  };
  return { registration, get released() { return released; } };
}

function stalledProvider() {
  const started = deferred<void>();
  let controller!: ReadableStreamDefaultController<LanguageModelV4StreamPart>;
  const stream = new ReadableStream<LanguageModelV4StreamPart>({
    start(value) {
      controller = value;
      controller.enqueue({ type: "stream-start", warnings: [] });
    },
  });
  return {
    started: started.promise,
    response() { started.resolve(); return { stream }; },
    release() { controller.close(); },
  };
}

test("Stop releases a turn whose provider ignores abort, allowing the next prompt without reload", async () => {
  const provider = stalledProvider();
  let calls = 0;
  const model = new MockLanguageModelV4({ doStream: async () => ++calls === 1
    ? provider.response() : answer("The next prompt ran without reloading.") });
  const { runtime, storage } = await fixture(model);
  const mode = consent();
  const run = runtime.chat(historyId, "Inspect the existing records.", () => {}, undefined, mode.registration);
  // Observe rejection immediately even if an assertion fails before awaiting it.
  void run.catch(() => {});
  try {
    await promptly(provider.started);
    expect(runtime.snapshot(historyId).generatingHere).toBe(true);
    await promptly(runtime.stop(historyId));
    await promptly(run);
    expect(mode.released).toBe(true);
    expect(runtime.snapshot(historyId).generatingHere).toBe(false);
    expect((await storage.loadConversation(historyId)).messages.at(-1)?.text).toContain("Stopped");

    // The old provider is deliberately still open here.
    const next = await promptly(runtime.chat(historyId, "Continue from the saved progress.", () => {}));
    expect(next.messages.at(-1)?.text).toBe("The next prompt ran without reloading.");
    expect(next.generatingHere).toBe(false);
    expect(next.error).toBeNull();
    expect(calls).toBe(2);
  } finally {
    provider.release();
    await run.catch(() => {});
  }
});

test("Stop interrupts pending responseMessages and ignores its late result", async () => {
  const entered = deferred<void>();
  const messages = deferred<Awaited<ReturnType<AgentStreamRunner>["responseMessages"]>>();
  let streams = 0;
  const model = new MockLanguageModelV4({ doStream: async () => answer("A completed stream answer.") });
  const { runtime } = await fixture(model);
  Object.assign(runtime, {
    stream: ((options) => {
      const result = streamText(options);
      if (++streams > 1) return result;
      return {
        fullStream: result.fullStream,
        get responseMessages() { entered.resolve(); return messages.promise; },
      };
    }) satisfies AgentStreamRunner,
  });
  const mode = consent();
  const run = runtime.chat(historyId, "Read the available records.", () => {}, undefined, mode.registration);
  void run.catch(() => {});
  try {
    await promptly(entered.promise);
    await promptly(runtime.stop(historyId));
    await promptly(run);
    expect(mode.released).toBe(true);
    expect(runtime.snapshot(historyId).generatingHere).toBe(false);

    const next = await promptly(runtime.chat(historyId, "Continue after stopping.", () => {}));
    expect(next.error).toBeNull();
    expect(next.messages.at(-1)?.text).toBe("A completed stream answer.");
    messages.resolve([{ role: "assistant", content: "Late abandoned response." }]);
    await Promise.resolve();
    expect(JSON.stringify(runtime.snapshot(historyId).messages)).not.toContain("Late abandoned response");
    expect(streams).toBe(2);
  } finally {
    messages.resolve([]);
    await run.catch(() => {});
  }
});

test("a root timeout settles an abort-insensitive worker before releasing consent and permits a fresh prompt", async () => {
  const provider = stalledProvider();
  let parentRequests = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    const worker = options.prompt.some((entry) => entry.role === "system"
      && entry.content.includes("You are an internal worker"));
    if (worker) return provider.response();
    if (parentRequests === 1) return response([
      call("spawn_agent", { task: "Inspect a record and report its fields." }), finish("tool-calls"),
    ]);
    return answer("Resumed using the saved worker state.");
  } });
  const { runtime, storage } = await fixture(model);
  const timeout = new Error("Step timeout of 360000ms exceeded");
  timeout.name = "TimeoutError";
  Object.assign(runtime, {
    stream: ((options) => {
      if (typeof options.system === "string" && !options.system.includes("You are an internal worker")
        && ++parentRequests === 2) throw timeout;
      return streamText(options);
    }) satisfies AgentStreamRunner,
  });
  const mode = consent();
  const run = runtime.chat(historyId, "Inspect the records using one worker.", () => {}, undefined, mode.registration);
  const outcome = run.then(() => ({ error: null }), (error: unknown) => ({ error }));
  try {
    await promptly(provider.started);
    expect((await promptly(outcome)).error).toBe(timeout);
    expect(mode.released).toBe(true);
    const status = runtime.snapshot(historyId);
    expect(status.generatingHere).toBe(false);
    expect(status.error).toContain("Step timeout of 360000ms exceeded");
    expect(status.workers?.active).toBe(0);
    const workers = await storage.loadWorkers(historyId);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.status).toBe("stopped");
    expect(workers[0]?.lastStop?.by).toBe("parent");

    // A second prompt succeeds while the abandoned provider stream stays open.
    const next = await promptly(runtime.chat(historyId, "Continue from the saved findings.", () => {}));
    expect(next.error).toBeNull();
    expect(next.generatingHere).toBe(false);
    expect(next.messages.at(-1)?.text).toBe("Resumed using the saved worker state.");
  } finally {
    provider.release();
    await outcome;
  }
});
