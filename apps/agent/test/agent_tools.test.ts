import { expect, test } from "bun:test";
import type {
  JsonValue,
  MsgBusCallOptions,
  MsgBusClient,
  MsgBusEndpointId,
  MsgBusToolCall,
  MsgBusToolDescriptor,
} from "neutron-tools/app";
import { KernelPolicyError } from "neutron-tools/app";
import {
  createNeutronAgentTools,
  type AgentToolEvent,
} from "../src/neutron_agent_tools.ts";

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
  input: Record<string, unknown>,
  abortSignal = new AbortController().signal,
): Promise<JsonValue> {
  const runnable = definition as {
    execute: (input: Record<string, unknown>, options: unknown) => Promise<JsonValue>;
  };
  return runnable.execute(input, {
    toolCallId: "test",
    messages: [],
    abortSignal,
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
  await expect(
    execute(tools.get_tool_schema, {
      target: `app:files:tile:files:instance:${"a".repeat(240)}`,
      name: "read",
    }),
  ).rejects.toThrow("Invalid endpoint target");
});

test("discovery includes apps after 128 and exposes undisplayed endpoint representatives", async () => {
  const { bus } = fakeBus();
  bus.listApps = async () => ({ apps: Array.from({ length: 129 }, (_, index) => ({ id: `app${index}` })) });
  bus.listEndpoints = async () => ({ endpoints: Array.from({ length: 17 }, (_, index) => ({
    appId: "files", role: "tile", tileId: `view${index}`, connected: true,
    endpoint: `app:files:tile:view${index}:instance:one`,
  })) });
  const tools = createNeutronAgentTools({ bus, onEvent: () => undefined });
  expect(await execute(tools.list_apps, {})).toMatchObject({ apps: expect.arrayContaining([{ id: "app128" }]) });
  const listed = await execute(tools.list_app_tools, { appId: "files" });
  expect(listed).toMatchObject({ additionalInstances: ["app:files:tile:view16:instance:one"] });
  const exact = await execute(tools.list_app_tools, { appId: "files", target: "app:files:tile:view16:instance:one" });
  expect(JSON.stringify(exact)).toContain('"target":"app:files:tile:view16:instance:one"');
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

test("agent honors long-running app tools and forwards turn cancellation", async () => {
  const { bus, timeouts } = fakeBus();
  const longRunning = {
    ...readDescriptor,
    annotations: {
      ...readDescriptor.annotations,
      "neutron:longRunning": true,
    },
  };
  const listTools = bus.listTools.bind(bus);
  bus.listTools = async (target, timeout) => {
    await listTools(target, timeout);
    return [longRunning];
  };
  const controller = new AbortController();
  let forwardedSignal: AbortSignal | undefined;
  let reportProgress: ((value: JsonValue) => void) | undefined;
  bus.callTool = async <T extends JsonValue = JsonValue>(
    _call: MsgBusToolCall,
    options?: number | MsgBusCallOptions,
  ): Promise<T> => {
    if (typeof options !== "number") {
      forwardedSignal = options?.signal;
      reportProgress = options?.onProgress;
    }
    timeouts.push([
      "callTool",
      typeof options === "number" ? options : options?.timeout,
    ]);
    reportProgress?.({ phase: "started", runId: "run_1" });
    return { complete: true } as unknown as T;
  };
  const events: AgentToolEvent[] = [];
  const tools = createNeutronAgentTools({
    bus,
    onEvent: (event) => events.push(event),
  });

  await expect(execute(
    tools.call_app_tool,
    {
      target: "app:files:background",
      name: "read",
      arguments: { path: "/large-job" },
    },
    controller.signal,
  )).resolves.toMatchObject({ ok: true, result: { complete: true } });
  expect(forwardedSignal).toBe(controller.signal);
  expect(events).toContainEqual(expect.objectContaining({
    name: "call_app_tool",
    status: "running",
    summary: "read: started (run_1)",
  }));
  expect(timeouts).toEqual([
    ["listTools", 60],
    ["callTool", 300],
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
    192 * 1024
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
  const events: AgentToolEvent[] = [];
  const tools = createNeutronAgentTools({
    bus,
    onEvent: (event) => events.push(event),
  });
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
  expect(events.at(-1)).toMatchObject({
    name: "call_app_tool",
    status: "error",
    summary: "App requests are paused",
  });
});

test("agent marks every declared state-changing effect as unsafe to retry", async () => {
  const cases = [
    { name: "write", effects: ["network", "write"] },
    {
      name: "signed_call",
      effects: ["signature_request", "network"],
    },
    {
      name: "backend_access",
      effects: ["persistent_permission", "network", "user_visible_ui"],
    },
  ] as const;

  for (const { name, effects } of cases) {
    const { bus } = fakeBus();
    bus.listTools = async () => [{
      ...readDescriptor,
      name,
      annotations: { "neutron:effects": [...effects] },
    }];
    bus.callTool = async () => {
      throw new Error("Request cancelled before its outcome was known");
    };
    const attempts: JsonValue[] = [];
    const tools = createNeutronAgentTools({
      bus,
      onEvent: () => undefined,
      beforeStateChangingDispatch: (attempt) => {
        attempts.push(attempt);
      },
    });

    const result = await execute(tools.call_app_tool, {
      target: "app:files:background",
      name,
      arguments: { path: "/README.md" },
    });

    expect(result).toEqual({
      ok: false,
      error: { message: "Request cancelled before its outcome was known" },
      retrySafe: false,
    });
    expect(attempts).toEqual([
      { target: "app:files:background", name },
    ]);
  }
});

test("agent commits the state-change journal before dispatch", async () => {
  const { bus } = fakeBus({ updated: true });
  bus.listTools = async () => [{
    ...readDescriptor,
    name: "update",
    annotations: { "neutron:effects": ["write"] },
  }];
  let dispatched = false;
  bus.callTool = async <T extends JsonValue = JsonValue>() => {
    dispatched = true;
    return { updated: true } as unknown as T;
  };
  let journalStartedResolve!: () => void;
  const journalStarted = new Promise<void>((resolve) => {
    journalStartedResolve = resolve;
  });
  let releaseJournalResolve!: () => void;
  const releaseJournal = new Promise<void>((resolve) => {
    releaseJournalResolve = resolve;
  });
  const tools = createNeutronAgentTools({
    bus,
    onEvent: () => undefined,
    beforeStateChangingDispatch: async () => {
      journalStartedResolve();
      await releaseJournal;
    },
  });

  const pending = execute(tools.call_app_tool, {
    target: "app:files:background",
    name: "update",
    arguments: { path: "/README.md" },
  });
  await journalStarted;
  expect(dispatched).toBe(false);
  releaseJournalResolve();

  await expect(pending).resolves.toEqual({
    ok: true,
    result: { updated: true },
  });
  expect(dispatched).toBe(true);
});

test("agent does not dispatch when the state-change journal cannot commit", async () => {
  const { bus } = fakeBus();
  bus.listTools = async () => [{
    ...readDescriptor,
    name: "update",
    annotations: { "neutron:effects": ["write"] },
  }];
  let dispatched = false;
  bus.callTool = async <T extends JsonValue = JsonValue>() => {
    dispatched = true;
    return {} as T;
  };
  const tools = createNeutronAgentTools({
    bus,
    onEvent: () => undefined,
    beforeStateChangingDispatch: async () => {
      throw new Error("Recovery journal unavailable");
    },
  });

  await expect(execute(tools.call_app_tool, {
    target: "app:files:background",
    name: "update",
    arguments: { path: "/README.md" },
  })).resolves.toEqual({
    ok: false,
    error: { message: "Recovery journal unavailable" },
    retrySafe: true,
  });
  expect(dispatched).toBe(false);

  const withoutJournal = createNeutronAgentTools({
    bus,
    onEvent: () => undefined,
  });
  await expect(execute(withoutJournal.call_app_tool, {
    target: "app:files:background",
    name: "update",
    arguments: { path: "/README.md" },
  })).resolves.toEqual({
    ok: false,
    error: { message: "State-change recovery journal is unavailable" },
    retrySafe: true,
  });
  expect(dispatched).toBe(false);
});

test("agent does not mark a declared network read as state-changing", async () => {
  const { bus } = fakeBus();
  bus.listTools = async () => [{
    ...readDescriptor,
    annotations: { "neutron:effects": ["read", "network"] },
  }];
  bus.callTool = async () => {
    throw new Error("Read failed");
  };
  const attempts: JsonValue[] = [];
  const tools = createNeutronAgentTools({
    bus,
    onEvent: () => undefined,
    beforeStateChangingDispatch: (attempt) => {
      attempts.push(attempt);
    },
  });

  const result = await execute(tools.call_app_tool, {
    target: "app:files:background",
    name: "read",
    arguments: { path: "/README.md" },
  });

  expect(result).toEqual({
    ok: false,
    error: { message: "Read failed" },
  });
  expect(attempts).toEqual([]);
});

test("agent journals tools without an explicit read-only effect contract", async () => {
  const { annotations: _readEffects, ...descriptorWithoutEffects } =
    readDescriptor;
  const cases: MsgBusToolDescriptor[] = [
    { ...descriptorWithoutEffects, name: "missing_effects" },
    {
      ...readDescriptor,
      name: "unknown_effect",
      annotations: { "neutron:effects": ["read", "future_effect"] },
    },
  ];

  for (const descriptor of cases) {
    const { name } = descriptor;
    const { bus } = fakeBus();
    bus.listTools = async () => [descriptor];
    bus.callTool = async () => {
      throw new Error("Outcome unknown");
    };
    const attempts: JsonValue[] = [];
    const tools = createNeutronAgentTools({
      bus,
      onEvent: () => undefined,
      beforeStateChangingDispatch: (attempt) => {
        attempts.push(attempt);
      },
    });

    await expect(execute(tools.call_app_tool, {
      target: "app:files:background",
      name,
      arguments: {},
    })).resolves.toEqual({
      ok: false,
      error: { message: "Outcome unknown" },
      retrySafe: false,
    });
    expect(attempts).toEqual([
      { target: "app:files:background", name },
    ]);
  }
});

test("agent marks an actually aborted state-changing call as unsafe", async () => {
  const { bus } = fakeBus();
  bus.listTools = async () => [{
    ...readDescriptor,
    name: "signed_call",
    annotations: { "neutron:effects": ["signature_request", "network"] },
  }];
  const controller = new AbortController();
  let forwardedSignal: AbortSignal | undefined;
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  bus.callTool = <T extends JsonValue = JsonValue>(
    _call: MsgBusToolCall,
    options?: number | MsgBusCallOptions,
  ): Promise<T> =>
    new Promise<T>((_resolve, reject) => {
      forwardedSignal = typeof options === "number" ? undefined : options?.signal;
      if (!forwardedSignal) {
        reject(new Error("Missing cancellation signal"));
        return;
      }
      const abort = (): void => {
        reject(
          forwardedSignal?.reason instanceof Error
            ? forwardedSignal.reason
            : new Error("Call aborted"),
        );
      };
      forwardedSignal.addEventListener("abort", abort, { once: true });
      startedResolve();
      if (forwardedSignal.aborted) abort();
    });
  const attempts: JsonValue[] = [];
  const events: AgentToolEvent[] = [];
  const tools = createNeutronAgentTools({
    bus,
    onEvent: (event) => events.push(event),
    beforeStateChangingDispatch: (attempt) => {
      attempts.push(attempt);
    },
  });

  const pending = execute(
    tools.call_app_tool,
    {
      target: "app:files:background",
      name: "signed_call",
      arguments: { path: "/README.md" },
    },
    controller.signal,
  );
  await started;
  controller.abort(new Error("Owner stopped the turn"));

  await expect(pending).resolves.toEqual({
    ok: false,
    error: { message: "Owner stopped the turn" },
    retrySafe: false,
  });
  expect(forwardedSignal).toBe(controller.signal);
  expect(attempts).toEqual([
    { target: "app:files:background", name: "signed_call" },
  ]);
  expect(events.at(-1)).toMatchObject({
    name: "call_app_tool",
    status: "error",
    summary: "Owner stopped the turn",
  });
});

test("agent retains a successful state-changing attempt for turn interruption", async () => {
  const { bus } = fakeBus({ reservations: [] });
  bus.listTools = async () => [{
    ...readDescriptor,
    name: "backend_access",
    annotations: { "neutron:effects": ["persistent_permission"] },
  }];
  const attempts: JsonValue[] = [];
  const tools = createNeutronAgentTools({
    bus,
    onEvent: () => undefined,
    beforeStateChangingDispatch: (attempt) => {
      attempts.push(attempt);
    },
  });

  await expect(execute(tools.call_app_tool, {
    target: "app:files:background",
    name: "backend_access",
    arguments: { path: "/README.md" },
  })).resolves.toEqual({ ok: true, result: { reservations: [] } });
  expect(attempts).toEqual([
    { target: "app:files:background", name: "backend_access" },
  ]);
});
