import {
  exposeTool,
  publishAppStateChange,
  type JsonObject,
  type JsonValue,
  type MsgBusToolContext,
} from "neutron-tools/app";
import { AgentRuntime } from "./agent_runtime.ts";

const emptyInput = { type: "object", additionalProperties: false };
const STATE_TOPIC = "agent";
let stateRevision = 0;
const snapshotSchema: JsonObject = {
  type: "object",
  required: [
    "ready",
    "connected",
    "selectedModelId",
    "models",
    "modelsLoading",
    "generating",
    "messages",
    "error",
  ],
  properties: {
    ready: { type: "boolean" },
    connected: { type: "boolean" },
    selectedModelId: { type: ["string", "null"] },
    models: { type: "array" },
    modelsLoading: { type: "boolean" },
    generating: { type: "boolean" },
    messages: { type: "array" },
    error: { type: ["string", "null"] },
  },
  additionalProperties: false,
};

const runtimePromise = AgentRuntime.create();

exposeTool(
  "agent_status",
  {
    title: "Agent Status",
    description: "Return connection, model, generation, and conversation state.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async (_args, context) => {
    requireOwnTile(context);
    return asJson((await runtimePromise).snapshot());
  }
);

exposeTool(
  "openrouter_connect",
  {
    title: "Connect OpenRouter",
    description: "Request the declared OpenRouter connection through Neutron.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["network", "user_visible_ui"] },
  },
  async (_args, context) => {
    requireOwnTile(context);
    return asJson(await mutate((runtime) => runtime.connect()));
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
    requireOwnTile(context);
    const runtime = await runtimePromise;
    return asJson(
      args.refresh === true
        ? await mutate((current) => current.refreshModels())
        : runtime.snapshot(),
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
    requireOwnTile(context);
    return asJson(
      await mutate((runtime) =>
        runtime.selectModel(requiredString(args.modelId)),
      ),
    );
  }
);

exposeTool(
  "agent_chat",
  {
    title: "Run Agent",
    description: "Stream one model-driven agent turn with Neutron tools.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 16_000 } },
      additionalProperties: false,
    },
    outputSchema: snapshotSchema,
    annotations: {
      "neutron:effects": ["network", "read", "write"],
      "neutron:longRunning": true,
    },
  },
  async (args, context) => {
    requireOwnTile(context);
    return asJson(
      await mutate((runtime) =>
        runtime.chat(
          requiredString(args.text),
          context.reportProgress,
          context.kernel,
          context.agentConsent,
        ),
      ),
    );
  }
);

exposeTool(
  "agent_stop",
  {
    title: "Stop Agent",
    description: "Abort the active model stream.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["network"] },
  },
  async (_args, context) => {
    requireOwnTile(context);
    return asJson(await mutate((runtime) => runtime.stop()));
  }
);

exposeTool(
  "openrouter_reset_chat",
  {
    title: "Reset OpenRouter Chat",
    description: "Clear conversation state without disconnecting OpenRouter.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["write"] },
  },
  async (_args, context) => {
    requireOwnTile(context);
    return asJson(
      await mutate((runtime) => runtime.resetChat()),
    );
  }
);

exposeTool(
  "openrouter_disconnect",
  {
    title: "Disconnect OpenRouter",
    description: "Clear the resident key and disconnect the kernel connection.",
    inputSchema: emptyInput,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["write", "user_visible_ui"] },
  },
  async (_args, context) => {
    requireOwnTile(context);
    return asJson(
      await mutate((runtime) => runtime.disconnect()),
    );
  }
);

async function mutate<T>(
  operation: (runtime: AgentRuntime) => Promise<T>,
): Promise<T> {
  const result = await operation(await runtimePromise);
  stateRevision += 1;
  try {
    await publishAppStateChange(STATE_TOPIC, stateRevision);
  } catch {
    // Mutation succeeded; a tile can always request a fresh snapshot.
  }
  return result;
}

function requireOwnTile(context: MsgBusToolContext): void {
  if (
    context.caller?.appId !== "agent" ||
    context.caller.role !== "tile"
  ) {
    throw new Error("Agent controls are available only to its own tile");
  }
}

function requiredString(value: JsonValue | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Expected a non-empty string");
  }
  return value;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
