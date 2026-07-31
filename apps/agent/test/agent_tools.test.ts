import { expect, test } from "bun:test";
import type {
  JsonValue,
  MsgBusClient,
  MsgBusEndpointId,
  MsgBusToolCall,
  MsgBusToolDescriptor,
} from "neutron-tools/app";
import { KernelPolicyError } from "neutron-tools/app";
import { createNeutronAgentTools } from "../src/neutron_agent_tools.ts";

const readDescriptor: MsgBusToolDescriptor = {
  name: "read",
  description: "Read one file.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" } },
    additionalProperties: false,
  },
  outputSchema: { type: "object" },
  annotations: { "neutron:effects": ["read"] },
};

function fakeBus(callResult?: JsonValue) {
  const calls: string[] = [];
  const timeouts: Array<[string, number | undefined]> = [];
  const bus: MsgBusClient = {
    async listApps(timeout) {
      timeouts.push(["listApps", timeout]);
      return {
        apps: [
          { id: "files", description: "Workspace files" },
          { id: "agent", description: "Agent" },
        ],
      };
    },
    async describeApp() {
      return {};
    },
    async listEndpoints(timeout) {
      timeouts.push(["listEndpoints", timeout]);
      return {
        endpoints: [
          {
            endpoint: "app:files:background",
            appId: "files",
            role: "background",
            connected: true,
          },
          {
            endpoint: "app:files:tile:files:instance:one",
            appId: "files",
            role: "tile",
            tileId: "files",
            workspace: 1,
            connected: true,
          },
          {
            endpoint: "app:files:tile:files:instance:two",
            appId: "files",
            role: "tile",
            tileId: "files",
            workspace: 2,
            connected: true,
          },
          {
            endpoint: "app:files:tray:instance:tray-one",
            appId: "files",
            role: "tray",
            instanceId: "tray-one",
            connected: true,
          },
        ],
      };
    },
    async listTools(target: MsgBusEndpointId = "kernel", timeout) {
      calls.push(`list:${target}`);
      timeouts.push(["listTools", timeout]);
      return [readDescriptor];
    },
    async callTool<T extends JsonValue = JsonValue>(
      call: MsgBusToolCall,
      options?: number | { timeout?: number }
    ) {
      calls.push(`call:${call.target}:${call.name}`);
      timeouts.push([
        "callTool",
        typeof options === "number" ? options : options?.timeout,
      ]);
      return (callResult ?? {
        path: String(call.arguments?.path),
        content: "# Workspace",
      }) as T;
    },
  };
  return { bus, calls, timeouts };
}

async function execute(
  definition: unknown,
  input: Record<string, unknown>
): Promise<JsonValue> {
  const runnable = definition as {
    execute: (input: Record<string, unknown>, options: unknown) => Promise<JsonValue>;
  };
  return runnable.execute(input, {
    toolCallId: "test",
    messages: [],
    abortSignal: new AbortController().signal,
  });
}

test("agent app discovery stays compact and gives permission dialogs one minute", async () => {
  const { bus, timeouts } = fakeBus();
  const tools = createNeutronAgentTools({ bus, onEvent: () => undefined });
  const apps = await execute(tools.list_apps, {});
  expect(apps).toEqual({
    apps: [
      { id: "files", description: "Workspace files" },
      { id: "agent", description: "Agent" },
    ],
  });

  const listed = await execute(tools.list_app_tools, { appId: "files" });
  expect(JSON.stringify(listed)).not.toContain("inputSchema");
  expect(JSON.stringify(listed)).not.toContain(":tray:");
  expect(listed).toMatchObject({
    appId: "files",
    additionalInstances: ["app:files:tile:files:instance:two"],
  });
  expect(timeouts).toEqual([
    ["listApps", 60],
    ["listEndpoints", 60],
    ["listTools", 60],
    ["listTools", 60],
  ]);
});

test("agent tool routing rejects non-canonical app ids", async () => {
  const { bus } = fakeBus();
  const tools = createNeutronAgentTools({ bus, onEvent: () => undefined });

  await expect(
    execute(tools.list_app_tools, { appId: "files__admin" }),
  ).rejects.toThrow("Invalid app id");
  await expect(
    execute(tools.get_tool_schema, {
      target: "app:files__admin:background",
      name: "read",
    }),
  ).rejects.toThrow("Invalid endpoint target");
});

test("agent reads one current schema and re-reads before a call", async () => {
  const { bus, calls, timeouts } = fakeBus();
  const events: string[] = [];
  const tools = createNeutronAgentTools({
    bus,
    onEvent: (event) => events.push(`${event.name}:${event.status}`),
  });
  const target = "app:files:background";

  const schema = await execute(tools.get_tool_schema, {
    target,
    name: "read",
  });
  expect(schema).toMatchObject({
    target,
    name: "read",
    inputSchema: { type: "object" },
  });

  const result = await execute(tools.call_app_tool, {
    target,
    name: "read",
    arguments: { path: "/README.md" },
  });
  expect(result).toEqual({
    ok: true,
    result: { path: "/README.md", content: "# Workspace" },
  });
  expect(calls).toEqual([
    `list:${target}`,
    `list:${target}`,
    `call:${target}:read`,
  ]);
  expect(events).toContain("call_app_tool:running");
  expect(events).toContain("call_app_tool:ok");
  expect(timeouts).toEqual([
    ["listTools", 60],
    ["listTools", 60],
    ["callTool", 60],
  ]);
});

test("agent tool results stay within the byte bound after Unicode escaping", async () => {
  const { bus } = fakeBus({ content: '😀\\'.repeat(100_000) });
  const tools = createNeutronAgentTools({ bus, onEvent: () => undefined });
  const result = await execute(tools.call_app_tool, {
    target: "app:files:background",
    name: "read",
    arguments: { path: "/large.txt" },
  });

  expect(result).toMatchObject({ truncated: true });
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
    128 * 1024
  );
});

test("agent tool failures preserve kernel policy details", async () => {
  const { bus } = fakeBus();
  bus.callTool = async () => {
    throw new KernelPolicyError(
      "APP_PAUSED",
      "App requests are paused",
      { retryAfterMs: 20_000 },
    );
  };
  const tools = createNeutronAgentTools({ bus, onEvent: () => undefined });
  const result = await execute(tools.call_app_tool, {
    target: "app:files:background",
    name: "read",
    arguments: { path: "/README.md" },
  });
  expect(result).toEqual({
    ok: false,
    error: {
      code: "APP_PAUSED",
      message: "App requests are paused",
      retryAfterMs: 20_000,
    },
  });
});
