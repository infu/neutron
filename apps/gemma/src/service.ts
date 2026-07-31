import { exposeTool, type JsonValue } from "neutron-tools/app";
import type { ChatSnapshot } from "./chat_types.ts";
import {
  createRuntimeBridge,
  RuntimeBridgeManager,
} from "./runtime_bridge.ts";

const snapshotSchema = {
  type: "object",
  required: [
    "stage",
    "statusText",
    "modelId",
    "modelLoaded",
    "loadProgress",
    "webGpuAvailable",
    "messages",
  ],
  properties: {
    stage: {
      type: "string",
      enum: ["idle", "loading", "ready", "generating", "error"],
    },
    statusText: { type: "string" },
    modelId: { type: "string" },
    modelLoaded: { type: "boolean" },
    loadProgress: { type: ["number", "null"], minimum: 0, maximum: 1 },
    webGpuAvailable: { type: "boolean" },
    messages: { type: "array" },
  },
  additionalProperties: false,
};

const emptyInputSchema = { type: "object", additionalProperties: false };
const bridgeManager = new RuntimeBridgeManager(createRuntimeBridge);

void bridgeManager.status().then(
  (snapshot) => {
    if (
      snapshot.webGpuAvailable &&
      !snapshot.modelLoaded &&
      snapshot.stage !== "loading"
    ) {
      void bridgeManager.call("load").catch(() => undefined);
    }
  },
  (error) => {
    console.error("[Gemma] resident runtime failed to start", error);
  }
);

exposeTool(
  "gemma_status",
  {
    title: "Gemma Status",
    description: "Return resident model, generation, and conversation state.",
    inputSchema: emptyInputSchema,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["read"] },
  },
  async () => asJson(await bridgeManager.status())
);

exposeTool(
  "gemma_load",
  {
    title: "Load Gemma",
    description: "Load and warm the resident Gemma WebGPU model.",
    inputSchema: emptyInputSchema,
    outputSchema: snapshotSchema,
    annotations: {
      "neutron:effects": ["gpu", "network"],
      "neutron:longRunning": true,
    },
  },
  async () => asJson(await bridgeManager.call("load"))
);

exposeTool(
  "gemma_generate",
  {
    title: "Chat with Gemma",
    description: "Generate a chat response with the resident Gemma model.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 16000 } },
      additionalProperties: false,
    },
    outputSchema: snapshotSchema,
    annotations: {
      "neutron:effects": ["gpu", "read", "write"],
      "neutron:longRunning": true,
    },
  },
  async (args) =>
    asJson(await bridgeManager.call("generate", { text: String(args.text) }))
);

exposeTool(
  "gemma_stop",
  {
    title: "Stop Gemma",
    description: "Cancel the current model load or response.",
    inputSchema: emptyInputSchema,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["gpu"] },
  },
  async () => asJson(await bridgeManager.call("stop"))
);

exposeTool(
  "gemma_reset",
  {
    title: "Reset Gemma",
    description: "Dispose the model and clear the shared conversation.",
    inputSchema: emptyInputSchema,
    outputSchema: snapshotSchema,
    annotations: { "neutron:effects": ["gpu", "write"] },
  },
  async () => asJson(await bridgeManager.call("reset"))
);

function asJson(snapshot: ChatSnapshot): JsonValue {
  return snapshot as unknown as JsonValue;
}
