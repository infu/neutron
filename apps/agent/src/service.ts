import {
  exposeTool,
  publishAppStateChange,
  type JsonObject,
  type JsonValue,
  type MsgBusToolContext,
} from "neutron-tools/app";
import {
  AgentRuntime,
  assertAgentRequestActive,
} from "./agent_runtime.ts";
import type { AgentChatTileEndpointId } from "./chat_types.ts";
import { requireAgentChatTileEndpoint } from "./storage.ts";

const emptyInput = { type: "object", additionalProperties: false };
const STATE_TOPIC = "agent";
const STATE_REVISION_PREFIX = createStateRevisionPrefix();
const CROSS_TAB_CHANNEL = openCrossTabChannel();
let stateRevision = 0;
const snapshotSchema: JsonObject = {
  type: "object",
  required: [
    "ready",
    "connected",
    "webToolsAvailable",
    "selectedModelId",
    "models",
    "modelsLoading",
    "generating",
    "generatingHere",
    "conversationRevision",
    "hiddenMessageCount",
    "messages",
    "error",
  ],
  properties: {
    ready: { type: "boolean" },
    connected: { type: "boolean" },
    webToolsAvailable: { type: "boolean" },
    selectedModelId: { type: ["string", "null"] },
    models: { type: "array" },
    modelsLoading: { type: "boolean" },
    generating: { type: "boolean" },
    generatingHere: { type: "boolean" },
    conversationRevision: { type: "string" },
    hiddenMessageCount: { type: "integer", minimum: 0 },
    messages: { type: "array" },
    error: { type: ["string", "null"] },
    work: { type: "object" },
  },
  additionalProperties: false,
};

const runtimePromise = AgentRuntime.create();
let crossTabRelay = Promise.resolve();

CROSS_TAB_CHANNEL?.addEventListener("message", (event) => {
  if (event.data?.type === "input" && typeof event.data.historyId === "string") {
    try {
      const historyId = requireAgentChatTileEndpoint(event.data.historyId);
      void runtimePromise.then((runtime) => runtime.wakeForInput(historyId));
    } catch { /* Ignore malformed relay messages. */ }
    return;
  }
  if (
    typeof event.data === "object" &&
    event.data !== null &&
    event.data.type === "stop" &&
    typeof event.data.historyId === "string" &&
    typeof event.data.issuedAt === "number" &&
    Number.isFinite(event.data.issuedAt)
  ) {
    try {
      const historyId = requireAgentChatTileEndpoint(event.data.historyId);
      void runtimePromise.then((runtime) => {
        runtime.abortExternalTurn(historyId, event.data.issuedAt);
      });
    } catch {
      // Ignore malformed same-origin relay messages.
    }
    return;
  }
  if (event.data === "turn-started") {
    void publishStateChange();
    return;
  }
  if (event.data !== "state-changed" && event.data !== "connection-changed") {
    return;
  }
  const eventType = event.data;
  crossTabRelay = crossTabRelay
    .then(async () => {
      const runtime = await runtimePromise;
      if (eventType === "state-changed") {
        await runtime.refreshExternalState();
      } else {
        await runtime.applyExternalConnectionChange();
      }
      await publishStateChange();
    })
    .catch(() => undefined);
});

exposeTool(
  "agent_status",
  {
    title: "Agent Status",
    description:
      "Return shared connection/model state and this calling tile's conversation.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async (_args, context) => {
    return asJson(
      await withOwnTile(context, (runtime, historyId) =>
        runtime.status(historyId)
      ),
    );
  }
);

exposeTool(
  "openrouter_connect",
  {
    title: "Connect OpenRouter",
    description:
      "Request the declared OpenRouter connection through Neutron. Once its owner dialog opens, an approved change completes even if this tile closes.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["network", "user_visible_ui"] },
  },
  async (_args, context) => {
    return asJson(
      await mutate(context, (runtime, historyId) =>
        runtime.connect(
          historyId,
          broadcastConnectionChanged,
          context.signal,
        )
      ),
    );
  }
);

exposeTool(
  "openrouter_models",
  {
    title: "OpenRouter Models",
    description: "Return or refresh the current tool-capable model catalog.",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean" } },
      additionalProperties: false,
    },
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  },
  async (args, context) => {
    return asJson(
      args.refresh === true
        ? await mutate(context, (runtime, historyId) =>
            runtime.refreshModels(historyId, context.signal)
          )
        : await withOwnTile(context, (runtime, historyId) =>
            runtime.status(historyId)
          ),
    );
  }
);

exposeTool(
  "openrouter_select_model",
  {
    title: "Select OpenRouter Model",
    description: "Select one current tool-capable OpenRouter model.",
    inputSchema: {
      type: "object",
      required: ["modelId"],
      properties: { modelId: { type: "string", minLength: 1, maxLength: 240 } },
      additionalProperties: false,
    },
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (args, context) => {
    return asJson(
      await mutate(context, (runtime, historyId) =>
        runtime.selectModel(
          historyId,
          requiredString(args.modelId),
          context.signal,
        ),
      ),
    );
  }
);

exposeTool(
  "agent_chat",
  {
    title: "Run Agent",
    description:
      "Stream one model-driven Agent turn in this calling tile's conversation.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 16_000 },
        modelId: { type: "string", minLength: 1, maxLength: 240 },
        conversationRevision: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
        webEnabled: {
          type: "boolean",
          description:
            "Allow bounded OpenRouter server-side public web search and page reading for this turn.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: snapshotSchema,
    annotations: {
      "neutron:effects": ["network", "read", "write"],
      "neutron:longRunning": true,
    },
  },
  async (args, context) => {
    return asJson(
      await mutate(context, (runtime, historyId) =>
        runtime.chat(
          historyId,
          requiredString(args.text),
          context.reportProgress,
          context.kernel,
          context.agentConsent,
          context.signal,
          publishTurnStarted,
          optionalString(args.modelId),
          optionalString(args.conversationRevision),
          args.webEnabled === true,
        ),
      ),
    );
  }
);

exposeTool(
  "agent_enqueue",
  {
    title: "Steer or Queue Agent",
    description: "Save an owner message for this tile. Steering applies after the current tool call and wakes sleep; queued requests run after the current work cycle.",
    inputSchema: {
      type: "object", required: ["text", "mode"], additionalProperties: false,
      properties: {
        text: { type: "string", minLength: 1, maxLength: 16_000 },
        mode: { type: "string", enum: ["steer", "queue"] },
      },
    },
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (args, context) => asJson(await mutate(context, async (runtime, historyId) => {
    const result = await runtime.enqueue(historyId, requiredString(args.text), args.mode === "queue" ? "queue" : "steer");
    if (args.mode !== "queue") CROSS_TAB_CHANNEL?.postMessage({ type: "input", historyId });
    return result;
  })),
);

exposeTool(
  "agent_clear_goal",
  {
    title: "Clear Agent Goal",
    description: "Stop this tile's work and clear its goal, keeping chat history and queued messages.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (_args, context) => asJson(await mutate(context, async (runtime, historyId) => {
    await runtime.stop(historyId, broadcastStopRequested);
    return runtime.clearGoal(historyId);
  })),
);

exposeTool(
  "agent_stop",
  {
    title: "Stop Agent",
    description: "Abort the model stream only when this tile started it.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["network"] },
  },
  async (_args, context) => {
    try {
      return asJson(
        await withOwnTile(context, (runtime, historyId) =>
          runtime.stop(historyId, broadcastStopRequested)
        ),
      );
    } finally {
      broadcastStateChanged();
      await publishStateChange();
    }
  }
);

exposeTool(
  "openrouter_reset_chat",
  {
    title: "Reset OpenRouter Chat",
    description:
      "Clear only this calling tile's conversation without disconnecting OpenRouter.",
    inputSchema: {
      type: "object",
      properties: {
        conversationRevision: {
          type: "string",
          minLength: 1,
          maxLength: 256,
        },
      },
      additionalProperties: false,
    },
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (args, context) => {
    return asJson(
      await mutate(context, (runtime, historyId) =>
        runtime.resetChat(
          historyId,
          context.signal,
          optionalString(args.conversationRevision),
        )
      ),
    );
  }
);

exposeTool(
  "openrouter_reset_all_chats",
  {
    title: "Reset All OpenRouter Chats",
    description:
      "Clear conversation history for every Agent tile without disconnecting OpenRouter.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (_args, context) => {
    if (!CROSS_TAB_CHANNEL) {
      throw new Error(
        "This browser cannot clear Agent conversations across open tabs",
      );
    }
    return asJson(
      await mutate(context, (runtime, historyId) =>
        runtime.resetAllChats(historyId, context.signal)
      ),
    );
  }
);

exposeTool(
  "openrouter_disconnect",
  {
    title: "Disconnect OpenRouter",
    description:
      "Clear the resident key and disconnect the Kernel connection. Once its owner dialog opens, an approved change completes even if this tile closes.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["write", "user_visible_ui"] },
  },
  async (_args, context) => {
    return asJson(
      await mutate(context, (runtime, historyId) =>
        runtime.disconnect(
          historyId,
          broadcastConnectionChanged,
          context.signal,
        )
      ),
    );
  }
);

async function mutate<T>(
  context: MsgBusToolContext,
  operation: (
    runtime: AgentRuntime,
    historyId: AgentChatTileEndpointId,
  ) => Promise<T>,
): Promise<T> {
  const historyId = requireOwnTile(context);
  const runtime = await runtimePromise;
  await runtime.activateConversation(historyId);
  assertAgentRequestActive(context.signal);
  try {
    return await operation(runtime, historyId);
  } finally {
    broadcastStateChanged();
    await publishStateChange();
  }
}

async function publishStateChange(): Promise<void> {
  stateRevision += 1;
  try {
    await publishAppStateChange(
      STATE_TOPIC,
      `${STATE_REVISION_PREFIX}${String(stateRevision).padStart(10, "0")}`,
    );
  } catch {
    // Mutation succeeded; a tile can always request a fresh snapshot.
  }
}

function createStateRevisionPrefix(): string {
  const nonce = new Uint32Array(2);
  crypto.getRandomValues(nonce);
  return `${Date.now()}${Array.from(nonce, (part) =>
    String(part).padStart(10, "0")
  ).join("")}`;
}

function openCrossTabChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel("neutron-agent:cross-tab:v1");
  } catch {
    return null;
  }
}

function broadcastConnectionChanged(): void {
  try {
    CROSS_TAB_CHANNEL?.postMessage("connection-changed");
  } catch {
    // Every chat still verifies the live Kernel connection before model work.
  }
}

function broadcastStateChanged(): void {
  try {
    CROSS_TAB_CHANNEL?.postMessage("state-changed");
  } catch {
    // The invoking tile already has the authoritative mutation result.
  }
}

function broadcastStopRequested(
  historyId: AgentChatTileEndpointId,
  issuedAt: number,
): void {
  try {
    CROSS_TAB_CHANNEL?.postMessage({ type: "stop", historyId, issuedAt });
  } catch {
    // The local resident still stops its matching turn.
  }
}

async function publishTurnStarted(): Promise<void> {
  try {
    CROSS_TAB_CHANNEL?.postMessage("turn-started");
  } catch {
    // The originating tile still receives streamed progress directly.
  }
  await publishStateChange();
}

async function withOwnTile<T>(
  context: MsgBusToolContext,
  operation: (
    runtime: AgentRuntime,
    historyId: AgentChatTileEndpointId,
  ) => T | Promise<T>,
): Promise<T> {
  const historyId = requireOwnTile(context);
  const runtime = await runtimePromise;
  await runtime.activateConversation(historyId);
  return operation(runtime, historyId);
}

function requireOwnTile(
  context: MsgBusToolContext,
): AgentChatTileEndpointId {
  if (
    context.caller?.appId !== "agent" ||
    context.caller.role !== "tile"
  ) {
    throw new Error("Agent controls are available only to its own tile");
  }
  return requireAgentChatTileEndpoint(context.caller.endpoint);
}

function requiredString(value: JsonValue | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a non-empty string");
  }
  return value;
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : requiredString(value);
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
