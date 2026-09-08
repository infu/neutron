import { expect, spyOn, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { browserExtension } from "neutron-tools/app";
import type { AgentChatTileEndpointId, OpenRouterModel } from "../src/chat_types.ts";
import type { ChatGptCredentials } from "../src/chatgpt_auth.ts";
import { AgentStorage } from "../src/storage.ts";
import { answer, call, finish, fixture, historyId, response } from "./runtime_fixture.ts";

const credentials: ChatGptCredentials = {
  accessToken: "private-access-token", refreshToken: "private-refresh-token",
  accountId: "account", expiresAt: null, email: "owner@example.com",
};
const subscriptionModel: OpenRouterModel = {
  id: "chatgpt/test-subscription", name: "Subscription model", contextLength: 32_000,
  promptPrice: "", completionPrice: "", supportsToolChoice: true, supportsReasoning: false,
};
const secondTile: AgentChatTileEndpointId = "app:agent:tile:chat:instance:provider-two";

test("provider and credential keys survive released history writes and conversation resets", async () => {
  const databaseName = `agent-provider-preservation-${crypto.randomUUID()}`;
  const storage = await AgentStorage.open(databaseName);
  expect(await storage.loadProvider(historyId)).toBeNull();
  expect(await storage.loadChatGptCredentials()).toBeNull();
  await storage.saveProvider(historyId, "chatgpt");
  await storage.saveProvider(secondTile, "openrouter");
  await storage.saveChatGptCredentials(credentials);
  // Released residents know only these original shared/conversation records.
  await storage.saveShared({ selectedModelId: "openai/old", models: [], modelsFetchedAt: 1 });
  await storage.saveConversation(historyId, {
    selectedModelId: "openai/old", messages: [{ id: "evidence", role: "assistant", text: "Transfer verified" }],
    modelTurns: [], pendingStateChangeJournal: null,
  });
  const reopened = await AgentStorage.open(databaseName);
  expect(await reopened.loadProvider(historyId)).toBe("chatgpt");
  expect((await reopened.loadConversation(historyId)).messages[0]?.text).toBe("Transfer verified");
  expect(await reopened.loadChatGptCredentials()).toEqual(credentials);
  await reopened.deleteAllConversations();
  expect(await reopened.loadProvider(historyId)).toBe("chatgpt");
  expect(await reopened.loadChatGptCredentials()).toEqual(credentials);
  await reopened.deleteConversation(historyId);
  expect(await reopened.loadProvider(historyId)).toBeNull();
  expect(await reopened.loadProvider(secondTile)).toBe("openrouter");
  expect(await reopened.loadChatGptCredentials()).toEqual(credentials);
});

test("a late device login cannot overwrite a newer login or reconnect after disconnect", async () => {
  const storage = await AgentStorage.open(`agent-login-revision-${crypto.randomUUID()}`);
  const first = await storage.beginChatGptLogin();
  const second = await storage.beginChatGptLogin();
  expect(await storage.completeChatGptLogin(first, credentials)).toBe(false);
  expect(await storage.loadChatGptCredentials()).toBeNull();
  expect(await storage.completeChatGptLogin(second, credentials)).toBe(true);
  expect(await storage.completeChatGptLogin(second, { ...credentials, accountId: "replay" })).toBe(false);
  const pending = await storage.beginChatGptLogin();
  await storage.clearChatGptConnection();
  expect(await storage.completeChatGptLogin(pending, credentials)).toBe(false);
  expect(await storage.loadChatGptCredentials()).toBeNull();
});

test("refresh commits cannot restore a disconnected credential or overwrite a different account", async () => {
  const storage = await AgentStorage.open(`agent-refresh-race-${crypto.randomUUID()}`);
  await storage.saveChatGptCredentials(credentials);
  const refreshed = { ...credentials, accessToken: "next-access", refreshToken: "next-refresh" };
  expect(await storage.replaceChatGptCredentials(credentials, refreshed)).toBe(true);
  expect(await storage.replaceChatGptCredentials(credentials, { ...refreshed, accessToken: "stale" })).toBe(false);
  await storage.clearChatGptConnection();
  expect(await storage.replaceChatGptCredentials(refreshed, credentials)).toBe(false);
  await storage.saveChatGptCredentials({ ...credentials, accountId: "another-account" });
  expect(await storage.replaceChatGptCredentials(credentials, refreshed)).toBe(false);
  expect((await storage.loadChatGptCredentials())?.accountId).toBe("another-account");
});

test("subscription selection is tile scoped, survives reload, and excludes OpenRouter models and credentials", async () => {
  const { runtime, storage } = await fixture(new MockLanguageModelV4({ doStream: async () => answer("done") }));
  const shared = await storage.loadShared();
  shared.models.push(subscriptionModel);
  await storage.saveShared(shared);
  await runtime.activateConversation(secondTile);
  Object.assign(runtime, {
    refreshChatGptStatus: async () => {}, chatGptCredentials: credentials,
    chatGptExtension: { available: true, paired: true, granted: true },
  });
  const selected = await runtime.selectProvider(historyId, "chatgpt");
  expect(selected.provider).toBe("chatgpt");
  expect(selected.selectedModelId).toBe(subscriptionModel.id);
  expect(selected.models.map((model) => model.id)).toEqual([subscriptionModel.id]);
  expect(selected.connected).toBe(true);
  expect(selected.webToolsAvailable).toBe(false);
  expect(JSON.stringify(selected)).not.toContain(credentials.accessToken);
  expect(JSON.stringify(selected)).not.toContain(credentials.refreshToken);
  expect(runtime.snapshot(secondTile).provider).toBe("openrouter");
  expect(runtime.snapshot(secondTile).selectedModelId).toBe("test/model");
  await expect(runtime.selectModel(historyId, "test/model")).rejects.toThrow("connection provider first");
  Object.assign(runtime, { providerPreferences: new Map() });
  await runtime.activateConversation(historyId);
  expect(runtime.snapshot(historyId).provider).toBe("chatgpt");
  expect(await storage.loadProvider(secondTile)).toBeNull();
});

test("subscription turns use their selected model and never acquire or bill OpenRouter", async () => {
  let streamed = 0;
  const model = new MockLanguageModelV4({ doStream: async () => { streamed += 1; return answer("Subscription response"); } });
  const { runtime, storage } = await fixture(model);
  const shared = await storage.loadShared();
  shared.models.push(subscriptionModel);
  await storage.saveShared(shared);
  Object.assign(runtime, {
    refreshChatGptStatus: async () => {}, chatGptCredentials: credentials,
    chatGptExtension: { available: true, paired: true, granted: true },
    chatGptProvider: { chat: (id: string) => { expect(id).toBe(subscriptionModel.id); return model; } },
    connectionLister: async () => { throw new Error("OpenRouter must not be consulted"); },
    provider: { chat: () => { throw new Error("OpenRouter must not be billed"); } },
  });
  await runtime.selectProvider(historyId, "chatgpt");
  const result = await runtime.chat(historyId, "Use the subscription", () => {});
  expect(streamed).toBe(1);
  expect(result.messages.at(-1)?.text).toBe("Subscription response");
});

test("an existing extension grant reconnects without another permission request", async () => {
  const { runtime, storage } = await fixture(new MockLanguageModelV4({ doStream: async () => answer("done") }));
  await storage.saveChatGptCredentials(credentials);
  let requests = 0;
  const request = spyOn(browserExtension, "request").mockImplementation(async () => {
    requests += 1;
    return { available: true, paired: true, granted: true };
  });
  Object.assign(runtime, {
    refreshChatGptStatus: async () => {}, chatGptCredentials: credentials,
    chatGptExtension: { available: true, paired: true, granted: true },
    chatGptProvider: { listModels: async () => [subscriptionModel] },
    providerPreferences: new Map([[historyId, "chatgpt"]]),
  });
  try {
    await runtime.connectChatGpt(historyId, () => {});
    await runtime.connectChatGpt(historyId, () => {});
    expect(requests).toBe(0);
  } finally { request.mockRestore(); }
});

test("a provider selection saved by another resident is loaded before checking the connection", async () => {
  let calls = 0;
  const model = new MockLanguageModelV4({ doStream: async () => { calls += 1; return answer("Current provider"); } });
  const { runtime, storage } = await fixture(model);
  const shared = await storage.loadShared();
  shared.models.push(subscriptionModel);
  await storage.saveShared(shared);
  await storage.saveProvider(historyId, "chatgpt");
  await storage.saveModelSelection(historyId, subscriptionModel.id, shared);
  Object.assign(runtime, {
    refreshChatGptStatus: async () => {}, chatGptCredentials: credentials,
    chatGptExtension: { available: true, paired: true, granted: true },
    chatGptProvider: { chat: () => model },
    connectionLister: async () => { throw new Error("Stale OpenRouter selection must not be verified"); },
  });
  const result = await runtime.chat(historyId, "Use my current selection", () => {});
  expect(result.provider).toBe("chatgpt");
  expect(calls).toBe(1);
});

test("worker model prices are checked again after an asynchronous spawn save", async () => {
  let rootStep = 0;
  const requestedModels: string[] = [];
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    if (options.prompt.some((entry) => entry.role === "system" && entry.content.includes("You are an internal worker"))) return answer("Worker done");
    return ++rootStep === 1
      ? response([call("spawn_agent", { task: "Review prices", modelId: "test/child" }), finish("tool-calls")])
      : answer("Root done");
  } });
  const { runtime, storage } = await fixture(model);
  const shared = await storage.loadShared();
  shared.models[0] = { ...shared.models[0]!, promptPrice: "0.000003", completionPrice: "0.000015" };
  const child = { ...shared.models[0]!, id: "test/child", promptPrice: "0.000001", completionPrice: "0.000005" };
  shared.models.push(child);
  await storage.saveShared(shared);
  Object.assign(runtime, { provider: { chat: (id: string) => { requestedModels.push(id); return model; } } });
  const save = storage.saveWorkers.bind(storage);
  const saveSpy = spyOn(storage, "saveWorkers").mockImplementation(async (id, records, ...rest) => {
    await save(id, records, ...rest);
    if (records.length) {
      const refreshed = { ...shared, models: [shared.models[0]!, { ...child, promptPrice: "0.00003", completionPrice: "0.00015" }] };
      Object.assign(runtime, { persisted: refreshed });
    }
  });
  try {
    const result = await runtime.chat(historyId, "Delegate a review", () => {}, undefined, { register: () => () => {}, onCancel: () => () => {} });
    expect(result.workers?.items[0]?.modelId).toBe("test/model");
    expect(result.workers?.items[0]?.status).toBe("completed");
    expect(requestedModels).not.toContain("test/child");
  } finally { saveSpy.mockRestore(); }
});
