import { expect, test } from "bun:test";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { readAgentStep, type AgentStreamRunner } from "../src/agent_step.ts";
import { answer, call, finish, fixture, historyId, response } from "./runtime_fixture.ts";

type StepResult = ReturnType<AgentStreamRunner>;
type StreamPart = StepResult["fullStream"] extends AsyncIterable<infer Part> ? Part : never;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Test watchdog only; controlled resources are released in each finally. */
async function promptly<T>(pending: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Stream cleanup blocked the original failure")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const ending of ["error", "abort"] as const) {
  test(`${ending} stream chunk surfaces before stalled iterator cleanup and observes its late rejection`, async () => {
    const cleanup = deferred<IteratorResult<StreamPart>>();
    const lateFailure = new Error("Iterator cleanup failed after the turn ended");
    const failure = new Error("Original provider failure");
    let cleanupRequested = 0;
    let observedRejection: unknown;
    let responseRequested = false;
    // Observe the consumer's rejection handler without installing one for it.
    // An unhandled cleanup rejection must still fail this test.
    const then = cleanup.promise.then.bind(cleanup.promise);
    Object.defineProperty(cleanup.promise, "then", {
      value(
        fulfilled?: ((value: IteratorResult<StreamPart>) => unknown) | null,
        rejected?: ((reason: unknown) => unknown) | null,
      ) {
        return then(fulfilled, rejected ? (reason) => {
          observedRejection = reason;
          return rejected(reason);
        } : undefined);
      },
    });
    const part: StreamPart = ending === "error"
      ? { type: "error", error: failure }
      : { type: "abort", reason: failure.message };
    const iterator: AsyncIterableIterator<StreamPart> = {
      next: async () => ({ done: false, value: part }),
      return: () => { cleanupRequested += 1; return cleanup.promise; },
      [Symbol.asyncIterator]() { return this; },
    };
    const result: StepResult = {
      fullStream: Object.assign(new ReadableStream<StreamPart>(), {
        [Symbol.asyncIterator]: () => iterator,
      }),
      get responseMessages() { responseRequested = true; return Promise.resolve([]); },
    };
    const outcome = readAgentStep(result, new AbortController().signal)
      .then(() => ({ error: null }), (error: unknown) => ({ error }));
    try {
      const { error } = await promptly(outcome);
      if (ending === "error") expect(error).toBe(failure);
      else {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(failure.message);
      }
      expect(cleanupRequested).toBe(1);
      expect(responseRequested).toBe(false);

      cleanup.reject(lateFailure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(observedRejection).toBe(lateFailure);
      expect((await outcome).error).toBe(error);
    } finally {
      cleanup.resolve({ done: true, value: undefined });
      await outcome;
    }
  });
}

test("an actual SDK step timeout escapes a held tool, aborts runtime work and preserves its recovery identity", async () => {
  const entered = deferred<void>();
  const releaseTool = deferred<void>();
  const toolSettled = deferred<void>();
  const requestId = "existing-request-held-at-step-timeout";
  const testStepMs = 100;
  let invocationSignal: AbortSignal | undefined;
  let toolAbortReason: unknown;
  let calls = 0;
  let modelRequests = 0;
  let consentReleased = false;
  const model = new MockLanguageModelV4({ doStream: async () => ++modelRequests === 1
    ? response([
      call("call_app_tool", {
        target: "app:records:background", name: "create", arguments: { requestId },
      }), finish("tool-calls"),
    ]) : answer("The original request needs reconciliation; it was not repeated.") });
  const { runtime, storage } = await fixture(model, {
    callTool: async (_call: unknown, options: { signal?: AbortSignal }) => {
      calls += 1;
      const signal = options.signal!;
      const aborted = () => { toolAbortReason = signal.reason; releaseTool.resolve(); };
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
      entered.resolve();
      try {
        // Match the real bus contract: hold the tool until its supplied signal
        // aborts, without inventing a separate timeout or financial retry.
        await releaseTool.promise;
        throw new Error("The dispatched request outcome is unknown");
      } finally {
        signal.removeEventListener("abort", aborted);
        toolSettled.resolve();
      }
    },
  });
  Object.assign(runtime, {
    stream: ((options) => {
      invocationSignal = options.abortSignal;
      // Only this fixture uses a short deadline. Production timeout is unchanged.
      return streamText({ ...options, timeout: { stepMs: testStepMs } });
    }) satisfies AgentStreamRunner,
  });
  const run = runtime.chat(historyId, "Create one record with the original request identity.", () => {}, undefined, {
    register: () => () => { consentReleased = true; }, onCancel: () => () => {},
  });
  const outcome = run.then(() => ({ error: null }), (error: unknown) => ({ error }));
  try {
    await promptly(entered.promise);
    const { error } = await promptly(outcome);
    expect(error).toBeInstanceOf(Error);
    expect(toolAbortReason).toBeInstanceOf(Error);
    expect((toolAbortReason as Error).name).toBe("TimeoutError");
    expect((toolAbortReason as Error).message).toBe(`Step timeout of ${testStepMs}ms exceeded`);
    // The SDK's abort chunk carries the actual TimeoutError as reason text.
    expect((error as Error).message).toBe(`TimeoutError: Step timeout of ${testStepMs}ms exceeded`);
    expect(invocationSignal?.aborted).toBe(true);
    await promptly(toolSettled.promise);
    expect(consentReleased).toBe(true);
    expect(runtime.snapshot(historyId).generatingHere).toBe(false);
    const saved = await storage.loadConversation(historyId);
    expect(JSON.stringify(saved)).toContain(requestId);
    expect(saved.messages.at(-1)?.text).toContain("outcome may be unknown");

    const next = await promptly(runtime.chat(historyId, "Continue by reconciling the existing request.", () => {}));
    expect(next.error).toBeNull();
    expect(next.generatingHere).toBe(false);
    expect(calls).toBe(1);
    expect(modelRequests).toBe(2);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain(requestId);
  } finally {
    releaseTool.resolve();
    await outcome;
  }
});
