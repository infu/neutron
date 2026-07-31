import { expect, spyOn, test } from "bun:test";
import {
  GemmaChatRuntime,
  MODEL_ID,
  MODEL_REVISION,
  type GemmaModel,
  type GemmaModule,
} from "../src/gemma_runtime.ts";

test("resident runtime keeps one model and conversation across clients", async () => {
  let loadCount = 0;
  let disposed = false;
  let now = 100;
  const prompts: string[][] = [];
  const model: GemmaModel = {
    async warmup() {},
    async *generate(messages, options) {
      prompts.push(messages.map((message) => `${message.role}:${message.content}`));
      expect(options.maxNewTokens).toBe(4096);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const prompt = messages.at(-1)?.content ?? "";
      yield { delta: "Local response: " };
      yield { delta: prompt };
    },
    reset() {},
    dispose() {
      disposed = true;
    },
  };
  const module: GemmaModule = {
    Gemma4Mobile: {
      async load() {
        loadCount++;
        return model;
      },
    },
  };
  const runtime = new GemmaChatRuntime(() => {}, {
    hasWebGpu: () => true,
    assertWebGpuSupport: async () => {},
    loadModule: async () => module,
    now: () => (now += 25),
  });

  await runtime.load();
  await runtime.load();
  expect(loadCount).toBe(1);
  await runtime.generate("Hi");

  const secondClient = runtime.snapshot();
  expect(secondClient.modelLoaded).toBe(true);
  expect(secondClient.messages.map((message) => message.content)).toEqual([
    "Hi",
    "Local response: Hi",
  ]);
  expect(prompts[0]).toEqual([
    expect.stringMatching(/^system:You are Gemma/),
    "user:Hi",
  ]);

  await runtime.generate("Still there?");
  expect(prompts[1]).toEqual([
    expect.stringMatching(/^system:You are Gemma/),
    "user:Hi",
    "assistant:Local response: Hi",
    "user:Still there?",
  ]);

  runtime.reset();
  expect(disposed).toBe(true);
  expect(runtime.snapshot()).toMatchObject({
    stage: "idle",
    modelLoaded: false,
    loadProgress: null,
    messages: [],
  });
});

test("resident runtime pins the model and enables persistent caching", async () => {
  const updates = [] as ReturnType<GemmaChatRuntime["snapshot"]>[];
  let loadedModelId: string | null | undefined;
  let cacheOption: boolean | undefined;
  let revisionOption: string | undefined;
  const model: GemmaModel = {
    async warmup() {},
    async *generate() {},
    reset() {},
  };
  const module: GemmaModule = {
    Gemma4Mobile: {
      async load(modelId, options) {
        loadedModelId = modelId;
        cacheOption = options?.cache;
        revisionOption = options?.revision;
        options?.onProgress?.({ status: "Downloading", fraction: 0.5 });
        return model;
      },
    },
  };
  const runtime = new GemmaChatRuntime((snapshot) => updates.push(snapshot), {
    hasWebGpu: () => true,
    assertWebGpuSupport: async () => {},
    loadModule: async () => module,
  });

  await runtime.load();

  expect(MODEL_ID).toBe("Vzmoi/gemma-4-expr-tst");
  expect(MODEL_REVISION).toBe(
    "3c4e8ad4641c69e754e5f22e8fdf9275eb2c6408"
  );
  expect(loadedModelId).toBe(MODEL_ID);
  expect(revisionOption).toBe(MODEL_REVISION);
  expect(cacheOption).toBe(true);
  expect(updates.some((snapshot) => snapshot.loadProgress === 0.5)).toBe(true);
  expect(runtime.snapshot().loadProgress).toBe(1);
});

test("a failed Heretic load never retries with the upstream default model", async () => {
  const calls: Array<{
    modelId: string | null | undefined;
    revision: string | undefined;
  }> = [];
  const module: GemmaModule = {
    Gemma4Mobile: {
      async load(modelId, options) {
        calls.push({ modelId, revision: options?.revision });
        throw new Error("simulated model load failure");
      },
    },
  };
  const runtime = new GemmaChatRuntime(() => {}, {
    hasWebGpu: () => true,
    assertWebGpuSupport: async () => {},
    loadModule: async () => module,
  });

  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(runtime.load()).rejects.toThrow("simulated model load failure");
  } finally {
    consoleError.mockRestore();
  }
  expect(calls).toEqual([
    { modelId: MODEL_ID, revision: MODEL_REVISION },
  ]);
  expect(runtime.snapshot()).toMatchObject({
    stage: "error",
    modelLoaded: false,
  });
});

test("tensor processing does not advance byte download progress", async () => {
  const updates = [] as ReturnType<GemmaChatRuntime["snapshot"]>[];
  const model: GemmaModel = {
    async warmup() {},
    async *generate() {},
    reset() {},
  };
  const module: GemmaModule = {
    Gemma4Mobile: {
      async load(_modelId, options) {
        options?.onProgress?.({
          status: "weights",
          kind: "bytes",
          message: "Downloading weights",
          fraction: 0.2,
        });
        options?.onProgress?.({
          status: "weights",
          kind: "tensors",
          message: "Processing tensor",
          fraction: 0.8,
        });
        options?.onProgress?.({
          status: "weights",
          kind: "bytes",
          message: "Downloading more weights",
          fraction: 0.25,
        });
        return model;
      },
    },
  };
  const runtime = new GemmaChatRuntime((snapshot) => updates.push(snapshot), {
    hasWebGpu: () => true,
    assertWebGpuSupport: async () => {},
    loadModule: async () => module,
  });

  await runtime.load();

  const byteUpdate = updates.find(
    (snapshot) => snapshot.statusText === "Downloading weights"
  );
  const tensorUpdate = updates.find(
    (snapshot) => snapshot.statusText === "Processing tensor"
  );
  const laterByteUpdate = updates.find(
    (snapshot) => snapshot.statusText === "Downloading more weights"
  );
  expect(byteUpdate?.loadProgress).toBeCloseTo(0.26);
  expect(tensorUpdate?.loadProgress).toBeCloseTo(0.26);
  expect(laterByteUpdate?.loadProgress).toBeCloseTo(0.3);
});
