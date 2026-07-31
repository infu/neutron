import { expect, test } from "bun:test";
import {
  AGENT_LOOP_STOP_WHEN,
  agentModelOptions,
  browserFetch,
  modelMessages,
  parseModelCatalog,
  permissionJudgePayload,
} from "../src/agent_runtime.ts";
import {
  normalizeModelTurns,
  normalizePersistedState,
} from "../src/storage.ts";
import {
  applyToolProgress,
  applyTranscriptProgress,
} from "../src/chat_progress.ts";
import type {
  AgentProgress,
  AgentSnapshot,
} from "../src/chat_types.ts";

test("agent loop has no artificial step-count ceiling", async () => {
  const steps = Array.from({ length: 1_000 }, () => ({}));
  expect(
    await AGENT_LOOP_STOP_WHEN({
      steps: steps as Parameters<typeof AGENT_LOOP_STOP_WHEN>[0]["steps"],
    }),
  ).toBe(false);
});

test("browser fetch keeps its required global receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiver: unknown;
  globalThis.fetch = function (this: unknown) {
    receiver = this;
    return Promise.resolve(new Response("ok"));
  } as unknown as typeof fetch;

  try {
    const response = await browserFetch("https://example.test");
    expect(await response.text()).toBe("ok");
    expect(receiver).toBe(globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog keeps only unique tool-capable models", () => {
  expect(
    parseModelCatalog({
      data: [
        {
          id: "provider/no-tools",
          name: "No tools",
          context_length: 8_000,
          supported_parameters: ["temperature"],
          pricing: { prompt: "0", completion: "0" },
        },
        {
          id: "provider/tools",
          name: "Tools",
          context_length: 32_000,
          supported_parameters: ["tools", "tool_choice", "reasoning", "temperature"],
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
        {
          id: "provider/tools",
          name: "Duplicate",
          context_length: 1,
          supported_parameters: ["tools", "tool_choice"],
        },
      ],
    })
  ).toEqual([
    {
      id: "provider/tools",
      name: "Tools",
      contextLength: 32_000,
      promptPrice: "0.000001",
      completionPrice: "0.000002",
      supportsToolChoice: true,
      supportsReasoning: true,
    },
  ]);
});

test("model catalog excludes models that cannot require a tool call", () => {
  expect(
    parseModelCatalog({
      data: [
        {
          id: "provider/auto-tools-only",
          supported_parameters: ["tools"],
        },
      ],
    }),
  ).toEqual([]);
});

test("agent routing does not require one provider to support every option", () => {
  expect(agentModelOptions({ supportsReasoning: true })).toEqual({
    parallelToolCalls: false,
    reasoning: { effort: "high" },
  });
  expect(agentModelOptions({ supportsReasoning: false })).toEqual({
    parallelToolCalls: false,
  });
});

test("model history preserves complete tool-call turns", () => {
  const turn = [
    { role: "user", content: "Read README" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "call_app_tool",
          input: { target: "app:files:background", name: "read", arguments: {} },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "call_app_tool",
          output: { type: "json", value: { ok: true } },
        },
      ],
    },
    { role: "assistant", content: "README was read." },
  ];
  const normalized = normalizeModelTurns([turn]);
  const messages = modelMessages(
    normalized,
    { role: "user", content: "Now update it" },
    32_000,
  );

  expect(messages).toHaveLength(5);
  expect(messages[1]).toMatchObject({ role: "assistant" });
  expect(messages[2]).toMatchObject({ role: "tool" });
  expect(messages.at(-1)).toEqual({ role: "user", content: "Now update it" });
});

test("model history rejects incomplete and malformed turns", () => {
  expect(
    normalizeModelTurns([
      [{ role: "assistant", content: "missing user" }],
      [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
      ],
    ]),
  ).toEqual([]);
});

test("legacy tool and unfinished rows are removed from the visible transcript", () => {
  const state = normalizePersistedState({
    selectedModelId: "deepseek/deepseek-v4-flash",
    models: [],
    modelsFetchedAt: 0,
    messages: [
      { id: "user-1", role: "user", text: "Create the contact" },
      {
        id: "tool-1",
        role: "tool",
        text: "Calling contacts",
        toolName: "call_app_tool",
        toolStatus: "running",
      },
      { id: "assistant-empty", role: "assistant", text: "" },
      { id: "assistant-1", role: "assistant", text: "Done." },
    ],
  });

  expect(state.messages).toHaveLength(2);
  expect(state.modelTurns).toEqual([]);
});

test("progress keeps the latest tool visible until the turn result arrives", () => {
  const snapshot: AgentSnapshot = {
    ready: true,
    connected: true,
    selectedModelId: "provider/model",
    models: [],
    modelsLoading: false,
    generating: false,
    messages: [],
    error: "old error",
  };
  const start: AgentProgress = {
    type: "turn_start",
    user: { id: "user-1", role: "user", text: "Do it" },
  };
  const started = applyTranscriptProgress(snapshot, start);
  expect(started?.messages).toEqual([start.user]);
  expect(started?.generating).toBe(true);
  expect(started?.error).toBeNull();

  const first: AgentProgress = {
    type: "tool",
    activity: {
      id: "tool-1",
      name: "list_apps",
      text: "List installed apps",
      status: "running",
    },
  };
  const second: AgentProgress = {
    type: "tool",
    activity: {
      id: "tool-2",
      name: "call_app_tool",
      text: "Update the contact",
      status: "running",
    },
  };
  let activity = applyToolProgress(null, first);
  activity = applyToolProgress(activity, second);
  expect(activity?.id).toBe("tool-2");
  expect(applyTranscriptProgress(started, second)?.messages).toEqual([start.user]);

  activity = applyToolProgress(activity, {
    ...second,
    activity: { ...second.activity, status: "ok" },
  });
  expect(activity).toMatchObject({
    id: "tool-2",
    status: "ok",
  });
});

test("model catalog rejects malformed provider responses", () => {
  expect(() => parseModelCatalog({ models: [] })).toThrow(
    "Invalid OpenRouter model catalog"
  );
});

test("permission judge input excludes transport identifiers", () => {
  const payload = permissionJudgePayload("Send the token", {
    version: 1,
    id: "challenge-secret",
    rootId: "root-secret",
    expiresAt: Date.now() + 30_000,
    requester: { appId: "wallet", role: "background" },
    chain: [
      { appId: "agent", tool: "agent_chat" },
      { appId: "wallet", tool: "send" },
    ],
    kind: "signed_canister_call",
    persistence: "none",
    risk: "high",
    action: { canister: "ryjl3-tyaaa-aaaaa-aaaba-cai", method: "icrc1_transfer" },
  });
  const encoded = JSON.stringify(payload);
  expect(encoded).toContain("Send the token");
  expect(encoded).toContain("icrc1_transfer");
  expect(encoded).not.toContain("challenge-secret");
  expect(encoded).not.toContain("root-secret");
  expect(encoded).not.toContain("expiresAt");
});
