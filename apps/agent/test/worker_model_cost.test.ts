import "fake-indexeddb/auto";
import { expect, test } from "bun:test";
import { AgentWorkers } from "../src/agent_workers.ts";
import type { AgentWorkerRecord, OpenRouterModel } from "../src/chat_types.ts";
import { AgentStorage, emptyConversationState } from "../src/storage.ts";
import { isWorkerModelAllowed } from "../src/worker_model_cost.ts";

const model = (id: string, promptPrice = "0.000003", completionPrice = "0.000015"): OpenRouterModel => ({
  id, name: id, promptPrice, completionPrice, contextLength: 32_000,
  supportsToolChoice: true, supportsReasoning: false,
});

test("worker alternatives cannot increase either input or output token prices", () => {
  const parent = model("openai/parent");
  for (const [candidate, allowed] of [
    [model("google/cheaper", "0.000001", "0.000005"), true],
    [model("google/equal"), true],
    [model("google/more-input", "0.000004", "0.000001"), false],
    [model("google/more-output", "0.000001", "0.000016"), false],
  ] as const) {
    expect(isWorkerModelAllowed(parent.id, candidate, [parent, candidate])).toBe(allowed);
  }
});

test("unknown or invalid prices permit only the exact parent model", () => {
  for (const unknown of ["", " ", "unknown", "-1", "Infinity", "NaN"]) {
    const parent = model("openai/parent", unknown);
    const other = model("openai/other", "0", "0");
    expect(isWorkerModelAllowed(parent.id, parent, [parent, other])).toBe(true);
    expect(isWorkerModelAllowed(parent.id, other, [parent, other])).toBe(false);
    expect(isWorkerModelAllowed(other.id, parent, [parent, other])).toBe(false);
  }
  const missingOutput = model("openai/missing-output", "0", "");
  const parent = model("openai/parent");
  expect(isWorkerModelAllowed(parent.id, missingOutput, [parent, missingOutput])).toBe(false);
  expect(isWorkerModelAllowed(parent.id, missingOutput, [missingOutput])).toBe(false);
});

test("free parents can delegate only to another known free model", () => {
  const parent = model("openai/free", "0", "0");
  const free = model("google/free", "0.0", "0e0");
  const paid = model("google/paid", "0", "0.0000001");
  expect(isWorkerModelAllowed(parent.id, free, [parent, free, paid])).toBe(true);
  expect(isWorkerModelAllowed(parent.id, paid, [parent, free, paid])).toBe(false);
});

test("subscription delegation inherits its model and never crosses to API billing", () => {
  const subscription = model("chatgpt/gpt-5.3-codex", "", "");
  const alternate = model("chatgpt/gpt-5.2-codex", "", "");
  const api = model("openai/gpt-5.3-codex", "0", "0");
  const catalog = [subscription, alternate, api];
  expect(isWorkerModelAllowed(subscription.id, subscription, catalog)).toBe(true);
  expect(isWorkerModelAllowed(subscription.id, alternate, catalog)).toBe(false);
  expect(isWorkerModelAllowed(subscription.id, api, catalog)).toBe(false);
  // Even if a catalog mistakenly labels the subscription free, its billing
  // source remains distinct from OpenRouter.
  subscription.promptPrice = subscription.completionPrice = "0";
  expect(isWorkerModelAllowed(subscription.id, api, catalog)).toBe(false);
  expect(isWorkerModelAllowed(api.id, subscription, catalog)).toBe(false);
});

const historyId = "app:agent:tile:chat:instance:model-cost" as const;
const execution = { toolCallId: "test", messages: [], context: {} };

async function manager(models: OpenRouterModel[], records: AgentWorkerRecord[] = []) {
  const storage = await AgentStorage.open(`worker-model-cost-${crypto.randomUUID()}`);
  const used: Array<{ modelId: string; context: string; selectedModelId: string | null }> = [];
  const workers = new AgentWorkers({
    historyId, storage, records, signal: new AbortController().signal,
    modelId: models[0]!.id, models,
    run: async ({ record, takeMessages }) => {
      const turn = record.conversation.modelTurns.flat();
      await takeMessages(turn);
      used.push({ modelId: record.modelId, context: JSON.stringify(turn), selectedModelId: record.conversation.selectedModelId });
      record.result = "Saved findings.";
    },
    recover: () => {}, onChange: () => {}, onFailure: (error) => { throw error; },
  });
  return { storage, workers, used };
}

async function settle(workers: AgentWorkers) {
  while (workers.active) await workers.wait(undefined, new AbortController().signal, new AbortController().signal);
  await workers.close();
}

test("spawn rejects expensive overrides before saving or running and exposes only eligible models", async () => {
  const parent = model("openai/parent");
  const cheaper = model("google/cheaper", "0.000001", "0.000005");
  const expensive = model("openai/expensive", "0.000030", "0.000150");
  const { workers, storage, used } = await manager([parent, cheaper, expensive]);
  const tools = workers.tools();
  const schema = await (tools.spawn_agent.inputSchema as { jsonSchema: unknown }).jsonSchema;
  expect(schema).toMatchObject({ properties: { modelId: { enum: [parent.id, cheaper.id] } } });
  await expect(tools.spawn_agent.execute!({ task: "Inspect records", modelId: expensive.id }, execution)).rejects.toThrow("no higher than the parent model");
  expect(used).toEqual([]);
  expect(await storage.loadWorkers(historyId)).toEqual([]);
  await tools.spawn_agent.execute!({ task: "Inspect records" }, execution);
  await tools.spawn_agent.execute!({ task: "Inspect related records", modelId: cheaper.id }, execution);
  await settle(workers);
  expect(used.map((worker) => worker.modelId)).toEqual([parent.id, cheaper.id]);
});

for (const previousModel of [
  model("openai/expensive", "0.000030", "0.000150"),
  model("openai/unknown", "", ""),
  model("chatgpt/previous", "", ""),
  null,
]) {
  test(`resuming a saved ${previousModel?.id ?? "unavailable"} worker inherits the parent and keeps evidence`, async () => {
    const parent = model("openai/parent");
    const oldId = previousModel?.id ?? "openai/removed";
    const conversation = emptyConversationState(oldId);
    conversation.modelTurns = [[
      { role: "user", content: "Create the requested record" },
      { role: "assistant", content: "Saved mutation evidence: created record-42. Do not create it twice." },
    ]];
    const records: AgentWorkerRecord[] = [{
      id: "saved-worker", task: "Create the requested record", modelId: oldId,
      status: "completed", result: "Created record-42.", error: null, messages: [],
      conversation, steps: 2, inputTokens: 100, outputTokens: 20, reported: true,
    }];
    const { workers, storage, used } = await manager([parent, ...(previousModel ? [previousModel] : [])], records);
    await workers.tools().send_message.execute!({ id: "saved-worker", message: "Read record-42 and verify its fields." }, execution);
    await settle(workers);
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ modelId: parent.id, selectedModelId: parent.id });
    expect(used[0]!.context).toContain("created record-42");
    expect(used[0]!.context).toContain("Read record-42 and verify its fields");
    expect((await storage.loadWorkers(historyId))[0]).toMatchObject({ modelId: parent.id, steps: 2, inputTokens: 100, outputTokens: 20 });
  });
}

test("resuming an eligible cheaper worker preserves its model", async () => {
  const parent = model("openai/parent");
  const cheaper = model("google/cheaper", "0.000001", "0.000005");
  const records: AgentWorkerRecord[] = [{
    id: "saved-worker", task: "Inspect a record", modelId: cheaper.id,
    status: "paused", result: "", error: null, messages: [],
    conversation: emptyConversationState(cheaper.id), steps: 1, inputTokens: 10, outputTokens: 5, reported: true,
  }];
  const { workers, used } = await manager([parent, cheaper], records);
  await workers.tools().send_message.execute!({ id: "saved-worker", message: "Continue." }, execution);
  await settle(workers);
  expect(used[0]).toMatchObject({ modelId: cheaper.id, selectedModelId: cheaper.id });
});
