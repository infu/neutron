import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import {
  AGENT_COMPACTED_STATE_CHANGE_RECORD_PREFIX,
  AGENT_LOOP_STOP_WHEN,
  AGENT_MAX_STEPS,
  AGENT_INTERRUPTED_STATE_CHANGE_WARNING_PREFIX,
  AGENT_STREAM_TIMEOUT,
  AGENT_SYSTEM_PROMPT,
  AgentRuntime,
  agentToolChoiceForStep,
  agentModelOptions,
  browserFetch,
  commitCompletedModelTurn,
  interruptedStateChangeWarning,
  materializePendingStateChangeWarning,
  modelMessages,
  parseModelCatalog,
  permissionJudgePayload,
} from "../src/agent_runtime.ts";
import {
  MAX_PENDING_STATE_CHANGE_ATTEMPTS,
  normalizeModelTurns,
  normalizePersistedState,
} from "../src/storage.ts";
import {
  applyToolProgress,
  applyTranscriptProgress,
} from "../src/chat_progress.ts";
import type { AgentProgress, AgentSnapshot } from "../src/chat_types.ts";

test("agent loop has a finite tool-step ceiling", async () => {
  const belowLimit = Array.from({ length: AGENT_MAX_STEPS - 1 }, () => ({}));
  expect(
    await AGENT_LOOP_STOP_WHEN({
      steps: belowLimit as Parameters<typeof AGENT_LOOP_STOP_WHEN>[0]["steps"],
    }),
  ).toBe(false);
  const atLimit = [...belowLimit, {}];
  expect(
    await AGENT_LOOP_STOP_WHEN({
      steps: atLimit as Parameters<typeof AGENT_LOOP_STOP_WHEN>[0]["steps"],
    }),
  ).toBe(true);
});

test("agent loop reserves its final step for synthesis", () => {
  expect(agentToolChoiceForStep(0)).toBe("required");
  expect(agentToolChoiceForStep(1)).toBe("auto");
  expect(agentToolChoiceForStep(AGENT_MAX_STEPS - 2)).toBe("auto");
  expect(agentToolChoiceForStep(AGENT_MAX_STEPS - 1)).toBe("none");
});

test("agent stream timeout permits bounded long-running tools", () => {
  expect(AGENT_STREAM_TIMEOUT).toEqual({ stepMs: 360_000 });
  expect("chunkMs" in AGENT_STREAM_TIMEOUT).toBe(false);
});

test("agent never retries explicitly non-retryable app results", () => {
  expect(AGENT_SYSTEM_PROMPT).toContain(
    "Never retry an app tool when its live schema or result says retry is unsafe",
  );
});

test("an interrupted state-changing warning survives into the next model turn", () => {
  const warning = interruptedStateChangeWarning([
    { target: "app:records:background", name: "record.update" },
  ]);
  expect(warning).toStartWith(AGENT_INTERRUPTED_STATE_CHANGE_WARNING_PREFIX);
  expect(warning).toContain("app:records:background/record.update");
  expect(warning).toContain("reconcile");

  const turns = normalizeModelTurns([[
    { role: "user", content: "Submit the proposal" },
    { role: "assistant", content: warning },
  ]]);
  const messages = modelMessages(
    turns,
    { role: "user", content: "Try again" },
    32_000,
  );
  expect(messages.at(-2)).toEqual({ role: "assistant", content: warning });
});

test("the latest maximum recovery warning survives the minimum history budget", () => {
  const maximumTarget = `app:${"a".repeat(225)}:background`;
  const attempts = Array.from(
    { length: MAX_PENDING_STATE_CHANGE_ATTEMPTS },
    (_, index) => ({
      target: maximumTarget,
      name: `${"m".repeat(124)}${index.toString().padStart(4, "0")}`,
    }),
  );
  const warning = interruptedStateChangeWarning(attempts, true);
  const recoveryTurn = [
    { role: "user", content: "u".repeat(16_000) },
    { role: "assistant", content: warning },
  ] satisfies ModelMessage[];
  const messages = modelMessages(
    [recoveryTurn],
    { role: "user", content: "n".repeat(16_000) },
    1,
  );

  expect(JSON.stringify(recoveryTurn).length).toBeGreaterThan(8_000);
  expect(messages).toEqual([
    ...recoveryTurn,
    { role: "user", content: "n".repeat(16_000) },
  ]);
});

test("recovery materializes every recorded target and is idempotent", () => {
  const attempts = Array.from({ length: 12 }, (_, index) => ({
    target: "app:records:background",
    name: `record.update_${index}`,
  }));
  const state = normalizePersistedState({
    selectedModelId: null,
    models: [],
    modelsFetchedAt: 0,
    messages: [{ id: "user-1", role: "user", text: "Update the records" }],
    modelTurns: [],
    pendingStateChangeJournal: { attempts, overflow: false },
  });

  expect(materializePendingStateChangeWarning(state)).toBe(true);
  expect(state.pendingStateChangeJournal).toBeNull();
  const warning = state.messages.at(-1)?.text ?? "";
  for (const attempt of attempts) {
    expect(warning).toContain(`${attempt.target}/${attempt.name}`);
  }
  expect(warning).not.toContain("arguments");
  expect(state.modelTurns.at(-1)?.at(-1)).toEqual({
    role: "assistant",
    content: warning,
  });
  expect(state.modelTurns.at(-1)?.at(0)).toEqual({
    role: "user",
    content: "Update the records",
  });

  const recovered = normalizePersistedState(state);
  const messageCount = recovered.messages.length;
  const turnCount = recovered.modelTurns.length;
  expect(materializePendingStateChangeWarning(recovered)).toBe(false);
  expect(recovered.messages).toHaveLength(messageCount);
  expect(recovered.modelTurns).toHaveLength(turnCount);
});

test("startup recovery rejects an invalid durable owner prompt", () => {
  const state = normalizePersistedState({
    selectedModelId: null,
    models: [],
    modelsFetchedAt: 0,
    messages: [
      { id: "user-old", role: "user", text: "An unrelated older request" },
      {
        id: "user-1",
        role: "user",
        text: ` ${"x".repeat(16_000)}`,
      },
    ],
    modelTurns: [],
    pendingStateChangeJournal: {
      attempts: [{ target: "app:records:background", name: "record.update" }],
      overflow: false,
    },
  });

  expect(materializePendingStateChangeWarning(state)).toBe(true);
  expect(state.modelTurns.at(-1)?.at(0)).toEqual({
    role: "user",
    content: "A previous Agent turn was interrupted before it produced a durable result.",
  });
});

test("conversation reset cannot erase a journaled active turn prompt", async () => {
  const runtime = Object.create(AgentRuntime.prototype) as AgentRuntime;
  Object.assign(runtime, { generating: true });

  await expect(runtime.resetChat()).rejects.toThrow(
    "Stop the active Agent turn before clearing conversation",
  );
});

test("an oversized completed mutation turn retains compact reconciliation context", () => {
  const ownerPrompt = "Update every matching record once";
  const responseMessages: ModelMessage[] = [];
  for (let index = 0; index < 24; index += 1) {
    const toolCallId = `call-${index}`;
    responseMessages.push(
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId,
          toolName: "call_app_tool",
          input: {
            target: "app:records:background",
            name: "record.update",
            arguments: { index },
          },
        }],
      } as ModelMessage,
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId,
          toolName: "call_app_tool",
          output: {
            type: "json",
            value: { ok: true, preview: "x".repeat(190 * 1024) },
          },
        }],
      } as ModelMessage,
    );
  }
  responseMessages.push({
    role: "assistant",
    content: "All matching records were updated once.",
  });
  const completedTurn = [
    { role: "user", content: ownerPrompt } satisfies ModelMessage,
    ...responseMessages,
  ];
  expect(new TextEncoder().encode(JSON.stringify(completedTurn)).byteLength)
    .toBeGreaterThan(4 * 1024 * 1024);

  const state = normalizePersistedState({
    selectedModelId: null,
    models: [],
    modelsFetchedAt: 0,
    messages: [
      { id: "user-1", role: "user", text: ownerPrompt },
      {
        id: "assistant-1",
        role: "assistant",
        text: "All matching records were updated once.",
      },
    ],
    modelTurns: [],
    pendingStateChangeJournal: {
      attempts: [{ target: "app:records:background", name: "record.update" }],
      overflow: false,
    },
  });

  expect(commitCompletedModelTurn(
    state,
    completedTurn,
    ownerPrompt,
    "All matching records were updated once.",
  )).toBe("compact");
  expect(state.pendingStateChangeJournal).toBeNull();
  expect(state.modelTurns).toHaveLength(1);
  expect(state.modelTurns[0]?.[0]).toEqual({
    role: "user",
    content: ownerPrompt,
  });
  const compactRecord = state.modelTurns[0]?.at(-1);
  expect(compactRecord).toMatchObject({ role: "assistant" });
  expect(String(compactRecord?.content)).toStartWith(
    AGENT_COMPACTED_STATE_CHANGE_RECORD_PREFIX,
  );
  expect(String(compactRecord?.content)).toContain(
    "All matching records were updated once.",
  );
  expect(String(compactRecord?.content)).toContain(
    "app:records:background/record.update",
  );

  const next = modelMessages(
    state.modelTurns,
    { role: "user", content: "What changed?" },
    1,
  );
  expect(next.slice(0, 2)).toEqual(state.modelTurns[0]!);
});

test("legacy state has no pending state-change journal", () => {
  const state = normalizePersistedState({
    selectedModelId: null,
    models: [],
    modelsFetchedAt: 0,
    messages: [],
    modelTurns: [],
  });
  expect(state.pendingStateChangeJournal).toBeNull();
});

test("a malformed oversized journal records explicit overflow", () => {
  const attempts = Array.from(
    { length: MAX_PENDING_STATE_CHANGE_ATTEMPTS + 4 },
    (_, index) => ({
      target: "app:records:background",
      name: `record.update_${index}`,
    }),
  );
  const state = normalizePersistedState({
    selectedModelId: null,
    models: [],
    modelsFetchedAt: 0,
    messages: [],
    modelTurns: [],
    pendingStateChangeJournal: { attempts, overflow: false },
  });

  expect(state.pendingStateChangeJournal?.attempts).toHaveLength(
    MAX_PENDING_STATE_CHANGE_ATTEMPTS,
  );
  expect(state.pendingStateChangeJournal?.overflow).toBe(true);
  expect(
    interruptedStateChangeWarning(
      state.pendingStateChangeJournal?.attempts ?? [],
      state.pendingStateChangeJournal?.overflow,
    ),
  ).toContain("further distinct state-changing calls were blocked before dispatch");
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
          supported_parameters: [
            "tools",
            "tool_choice",
            "reasoning",
            "temperature",
          ],
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
        {
          id: "provider/tools",
          name: "Duplicate",
          context_length: 1,
          supported_parameters: ["tools", "tool_choice"],
        },
      ],
    }),
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
          input: {
            target: "app:files:background",
            name: "read",
            arguments: {},
          },
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
  expect(applyTranscriptProgress(started, second)?.messages).toEqual([
    start.user,
  ]);

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
    "Invalid OpenRouter model catalog",
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
    action: {
      canister: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      method: "icrc1_transfer",
    },
  });
  const encoded = JSON.stringify(payload);
  expect(encoded).toContain("Send the token");
  expect(encoded).toContain("icrc1_transfer");
  expect(encoded).not.toContain("challenge-secret");
  expect(encoded).not.toContain("root-secret");
  expect(encoded).not.toContain("expiresAt");
});
