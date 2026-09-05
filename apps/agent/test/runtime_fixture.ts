import "fake-indexeddb/auto";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentChatTileEndpointId } from "../src/chat_types.ts";
import { AgentRuntime } from "../src/agent_runtime.ts";
import { AgentStorage } from "../src/storage.ts";

export const historyId: AgentChatTileEndpointId = "app:agent:tile:chat:instance:long-task";
export const usage = { inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 8, text: 8, reasoning: 0 } };
export const finish = (unified: "stop" | "tool-calls" | "length" = "stop"): LanguageModelV4StreamPart => ({
  type: "finish", finishReason: { unified, raw: unified }, usage,
});
export const call = (toolName: string, input: object, id = crypto.randomUUID()): LanguageModelV4StreamPart => ({
  type: "tool-call", toolCallId: id, toolName, input: JSON.stringify(input),
});
export function response(parts: LanguageModelV4StreamPart[]) {
  return { stream: new ReadableStream<LanguageModelV4StreamPart>({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] });
    for (const part of parts) controller.enqueue(part);
    controller.close();
  } }) };
}
export const answer = (text: string) => response([
  { type: "text-start", id: "text" }, { type: "text-delta", id: "text", delta: text },
  { type: "text-end", id: "text" }, finish(),
]);

export async function fixture(model: MockLanguageModelV4, busOverrides: object = {}) {
  const storage = await AgentStorage.open(`agent-long-task-${crypto.randomUUID()}`);
  const selected = { id: "test/model", name: "Test", contextLength: 32_000,
    promptPrice: "0", completionPrice: "0", supportsToolChoice: true, supportsReasoning: false };
  const shared = { selectedModelId: selected.id, models: [selected], modelsFetchedAt: 1 };
  await storage.saveShared(shared);
  const connection = { appId: "agent", installationUid: "test", provider: "openrouter", createdAt: "1" };
  const runtime = Object.create(AgentRuntime.prototype) as AgentRuntime;
  const bus = {
    listApps: async () => ({ apps: [{ id: "records", description: "Records" }] }),
    listTools: async () => [{ name: "create", inputSchema: { type: "object" }, annotations: { "neutron:effects": ["write"] } }],
    callTool: async () => ({ id: "saved-record-42" }),
    ...busOverrides,
  };
  Object.assign(runtime, {
    storage, bus, fetcher: fetch, connectionLister: async () => [connection],
    persisted: shared, provider: { chat: () => model }, connection,
    conversations: new Map(), conversationLoads: new Map(), workStates: new Map(),
    errors: new Map(), activeTurns: new Map(), startupError: null,
    modelCatalogRequestsInFlight: 0, mutationActive: false,
    stream: (options: Parameters<typeof streamText>[0]) => streamText(options), generate: generateText,
  });
  await runtime.activateConversation(historyId);
  return { runtime, storage };
}
