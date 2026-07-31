import { jsonSchema, tool } from "ai";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MsgBusClient,
  type MsgBusEndpointId,
  type MsgBusToolDescriptor,
} from "neutron-tools/app";
import {
  APP_ID_MAX_LENGTH,
  APP_ID_MIN_LENGTH,
  APP_ID_REPEATED_SEPARATOR_PATTERN,
  APP_ID_SAFE_SCHEMA_PATTERN,
  isValidAppId,
} from "neutron-tools/src/app_ids.js";

const MAX_TOOL_RESULT_BYTES = 128 * 1024;
const AGENT_TOOL_TIMEOUT_SECONDS = 60;

export type AgentToolEvent = {
  id: string;
  name: string;
  status: "running" | "ok" | "error";
  summary: string;
};

export function createNeutronAgentTools({
  bus,
  onEvent,
}: {
  bus: MsgBusClient;
  onEvent: (event: AgentToolEvent) => void;
}) {
  let callQueue: Promise<void> = Promise.resolve();

  const run = async <T>(
    name: string,
    summary: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const id = randomId();
    onEvent({ id, name, status: "running", summary });
    try {
      const value = await operation();
      onEvent({ id, name, status: "ok", summary });
      return value;
    } catch (error) {
      onEvent({
        id,
        name,
        status: "error",
        summary: safeError(error),
      });
      throw error;
    }
  };

  const serializeCall = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = callQueue.then(operation, operation);
    callQueue = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  };

  return {
    list_apps: tool({
      description: "List installed Neutron app ids and short descriptions.",
      inputSchema: jsonSchema<Record<string, never>>({
        type: "object",
        additionalProperties: false,
      }),
      execute: async () =>
        run("list_apps", "List installed apps", async () => {
          const value = await bus.listApps(AGENT_TOOL_TIMEOUT_SECONDS);
          if (!isJsonObject(value) || !Array.isArray(value.apps)) {
            throw new Error("Invalid installed app list");
          }
          return boundResult({ apps: value.apps.slice(0, 128) });
        }),
    }),

    list_app_tools: tool({
      description:
        "List compact method names and targets for one installed app. Schemas are returned separately.",
      inputSchema: jsonSchema<{ appId: string; target?: string }>({
        type: "object",
        required: ["appId"],
        properties: {
          appId: {
            type: "string",
            minLength: APP_ID_MIN_LENGTH,
            maxLength: APP_ID_MAX_LENGTH,
            pattern: APP_ID_SAFE_SCHEMA_PATTERN,
            not: { pattern: APP_ID_REPEATED_SEPARATOR_PATTERN },
          },
          target: { type: "string", minLength: 1, maxLength: 240 },
        },
        additionalProperties: false,
      }),
      execute: async ({ appId, target }) =>
        run("list_app_tools", `Inspect ${appId} methods`, async () =>
          boundResult(await listAppTools(bus, appId, target))
        ),
    }),

    get_tool_schema: tool({
      description:
        "Get the input and output JSON Schema for one exact app method before calling it.",
      inputSchema: jsonSchema<{ target: string; name: string }>({
        type: "object",
        required: ["target", "name"],
        properties: {
          target: { type: "string", minLength: 1, maxLength: 240 },
          name: { type: "string", minLength: 1, maxLength: 128 },
        },
        additionalProperties: false,
      }),
      execute: async ({ target, name }) =>
        run("get_tool_schema", `Inspect ${name} schema`, async () => {
          const endpoint = endpointId(target);
          const descriptor = await readDescriptor(bus, endpoint, name);
          return boundResult({
            target: endpoint,
            name: descriptor.name,
            description: descriptor.description ?? "",
            inputSchema: descriptor.inputSchema,
            outputSchema: descriptor.outputSchema ?? null,
            annotations: descriptor.annotations ?? {},
          });
        }),
    }),

    call_app_tool: tool({
      description:
        "Call one exact Neutron app method after inspecting its schema. Existing kernel permissions apply.",
      inputSchema: jsonSchema<{
        target: string;
        name: string;
        arguments: Record<string, unknown>;
      }>({
        type: "object",
        required: ["target", "name", "arguments"],
        properties: {
          target: { type: "string", minLength: 1, maxLength: 240 },
          name: { type: "string", minLength: 1, maxLength: 128 },
          arguments: { type: "object" },
        },
        additionalProperties: false,
      }),
      execute: async ({ target, name, arguments: arguments_ }) =>
        run("call_app_tool", `Call ${name}`, async () =>
          serializeCall(async () => {
            const endpoint = endpointId(target);
            await readDescriptor(bus, endpoint, name);
            const args = jsonObject(arguments_);
            try {
              return boundResult({
                ok: true,
                result: await bus.callTool(
                  {
                    target: endpoint,
                    name,
                    arguments: args,
                  },
                  AGENT_TOOL_TIMEOUT_SECONDS
                ),
              });
            } catch (error) {
              return {
                ok: false,
                error: safeToolError(error),
              };
            }
          })
        ),
    }),
  };
}

async function listAppTools(
  bus: MsgBusClient,
  appId: string,
  requestedTarget?: string
): Promise<JsonValue> {
  if (!isValidAppId(appId)) {
    throw new Error("Invalid app id");
  }
  if (appId === "kernel") {
    const descriptors = await bus.listTools(
      "kernel",
      AGENT_TOOL_TIMEOUT_SECONDS
    );
    return {
      appId,
      tools: compactDescriptors("kernel", "kernel", descriptors),
      additionalInstances: [],
    };
  }

  const value = await bus.listEndpoints(AGENT_TOOL_TIMEOUT_SECONDS);
  if (!isJsonObject(value) || !Array.isArray(value.endpoints)) {
    throw new Error("Invalid endpoint list");
  }
  const endpoints = value.endpoints.filter(
    (item): item is JsonObject =>
      isJsonObject(item) &&
      item.appId === appId &&
      item.connected === true &&
      (item.role === "background" || item.role === "tile") &&
      typeof item.endpoint === "string"
  );

  let selected: JsonObject[];
  if (requestedTarget) {
    const exact = endpoints.find((item) => item.endpoint === requestedTarget);
    if (!exact) throw new Error("Requested app endpoint is not live");
    selected = [exact];
  } else {
    const representativeByRole = new Map<string, JsonObject>();
    for (const endpoint of endpoints) {
      const key =
        endpoint.role === "background"
          ? "background"
          : `tile:${String(endpoint.tileId ?? "")}`;
      if (!representativeByRole.has(key)) representativeByRole.set(key, endpoint);
    }
    selected = [...representativeByRole.values()];
  }

  const tools: JsonValue[] = [];
  for (const endpoint of selected.slice(0, 16)) {
    const target = endpointId(String(endpoint.endpoint));
    const descriptors = await bus.listTools(
      target,
      AGENT_TOOL_TIMEOUT_SECONDS
    );
    tools.push(
      ...compactDescriptors(target, String(endpoint.role ?? "unknown"), descriptors, endpoint)
    );
  }

  const selectedIds = new Set(selected.map((item) => String(item.endpoint)));
  return {
    appId,
    tools,
    additionalInstances: endpoints
      .filter((endpoint) => !selectedIds.has(String(endpoint.endpoint)))
      .slice(0, 64)
      .map((endpoint) => String(endpoint.endpoint)),
  };
}

function compactDescriptors(
  target: MsgBusEndpointId,
  role: string,
  descriptors: MsgBusToolDescriptor[],
  endpoint: JsonObject = {}
): JsonValue[] {
  return descriptors.slice(0, 64).map((descriptor) => ({
    target,
    role,
    ...(typeof endpoint.tileId === "string" ? { tileId: endpoint.tileId } : {}),
    ...(typeof endpoint.workspace === "number"
      ? { workspace: endpoint.workspace }
      : {}),
    name: descriptor.name,
    description: descriptor.description ?? "",
    annotations: descriptor.annotations ?? {},
  }));
}

async function readDescriptor(
  bus: MsgBusClient,
  target: MsgBusEndpointId,
  name: string
): Promise<MsgBusToolDescriptor> {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name)) {
    throw new Error("Invalid method name");
  }
  const descriptor = (
    await bus.listTools(target, AGENT_TOOL_TIMEOUT_SECONDS)
  ).find(
    (candidate) => candidate.name === name
  );
  if (!descriptor) throw new Error("Method is not available on this endpoint");
  return descriptor;
}

function endpointId(value: string): MsgBusEndpointId {
  if (value === "kernel") return value;
  const match = /^app:([^:]+):(?:background|tile:[a-z_0-9]+:instance:[a-zA-Z0-9_-]+)$/.exec(
    value,
  );
  if (match === null || !isValidAppId(match[1])) {
    throw new Error("Invalid endpoint target");
  }
  return value as MsgBusEndpointId;
}

function jsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("Tool arguments must be an object");
  return value as JsonObject;
}

function boundResult(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value);
  const encoder = new TextEncoder();
  if (encoder.encode(serialized).byteLength <= MAX_TOOL_RESULT_BYTES) {
    return value;
  }
  let lower = 0;
  let upper = serialized.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const candidate = {
      truncated: true,
      preview: serialized.slice(0, middle),
    };
    if (encoder.encode(JSON.stringify(candidate)).byteLength <= MAX_TOOL_RESULT_BYTES) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return {
    truncated: true,
    preview: serialized.slice(0, lower),
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function safeToolError(error: unknown): JsonObject {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null;
  return {
    message: safeError(error),
    ...(typeof record?.code === "string"
      ? { code: record.code.slice(0, 64) }
      : {}),
    ...(typeof record?.retryAfterMs === "number" &&
    Number.isFinite(record.retryAfterMs)
      ? { retryAfterMs: Math.max(0, Math.floor(record.retryAfterMs)) }
      : {}),
  };
}

function randomId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
