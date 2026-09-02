import { afterEach, expect, test } from "bun:test";
import { validate as validateJsonSchema } from "jsonschema";
import {
  callTool,
  callCanisterDialog,
  callSelfDialog,
  connectEthereumProvider,
  copyToClipboard,
  createCanisterClient,
  deriveVetKey,
  dismissTray,
  disconnectMsgBus,
  exec,
  execPort as execAppPort,
  exposeTool,
  installMessageListener,
  isExecEnvelope,
  isAppStateChangeEnvelope,
  isJsonValue,
  isProgressEnvelope,
  isRequestCancelEnvelope,
  isResponseEnvelope,
  isVetKeysError,
  getVetKeyPublicKey,
  listExposedTools,
  listVetKeys,
  msgBusLocalActions,
  onAppStateChange,
  onTileViewRequest,
  offerAppInstall,
  openAppTile,
  publishAppStateChange,
  removeExposedTool,
  toError,
  type JsonFetcher,
  loadNeutronCanisterId,
  querySelf,
  requestVetKeys,
  requestBackendCallReservations,
  setTrayState,
  updateSelf,
  approveVetKeyDerivation,
  type JsonObject,
  type MsgBusToolCall,
  type VetKeyPublicInfo,
  type VetKeySlotSummary,
} from "../src/app_entry.ts";
import {
  MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
  MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
  MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES,
  NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
  NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
  NEUTRON_TOOL_CONSENT_PROVIDER_ONCE,
  kernelCallPayloadSchema,
  kernelSchemaPayloadSchema,
  normalizeToolDescriptor,
} from "../src/protocol.ts";
import {
  executeExposedAction,
  execPort as execKernelPort,
  expose,
  retireExecPort,
} from "../src/kernel.ts";

type PostedMessage = {
  message: unknown;
  targetOrigin: string;
};

type FakeSource = {
  messages: PostedMessage[];
  postMessage(message: unknown, targetOrigin: string): void;
};

type FakeWindow = {
  parent: FakeSource;
  origin?: string;
  location: { href: string };
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  dispatch(
    data: unknown,
    source?: FakeSource,
    origin?: string,
    ports?: MessagePort[],
  ): void;
};

type FakePort = {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  start(): void;
};

const originalWindow = globalThis.window;
const fakeCanisterId = "4caro-hl777-77775-aaaba-cai";
const fakeAppHref = `https://ahelloa--${fakeCanisterId}.icp0.io/app/hello/index.html`;
const fakeKernelOrigin = `https://${fakeCanisterId}.icp0.io`;

function createFakeSource(): FakeSource {
  return {
    messages: [],
    postMessage(message, targetOrigin) {
      this.messages.push({ message, targetOrigin });
    },
  };
}

function installFakeWindow(origin?: string, connect = true): FakeWindow {
  const parent = createFakeSource();
  const messageListeners: Array<(event: MessageEvent) => void> = [];
  const appPortListeners: Array<(event: MessageEvent) => void> = [];
  let portsClosed = false;
  const appPort: FakePort = {
    addEventListener(type, listener) {
      if (type === "message") appPortListeners.push(listener);
    },
    close() {
      portsClosed = true;
    },
    postMessage(message) {
      if (!portsClosed) parent.messages.push({ message, targetOrigin: "port" });
    },
    start() {},
  };
  const kernelPort: FakePort = {
    addEventListener() {},
    close() {
      portsClosed = true;
    },
    postMessage(message) {
      if (portsClosed) return;
      for (const listener of appPortListeners) {
        listener({ data: message } as MessageEvent);
      }
    },
    start() {},
  };
  const fakeWindow: FakeWindow = {
    parent,
    location: { href: fakeAppHref },
    ...(origin ? { origin } : {}),
    addEventListener(type, listener) {
      if (type === "message") messageListeners.push(listener);
    },
    dispatch(
      data,
      source = parent,
      origin = source === parent ? fakeKernelOrigin : "https://app.example",
      ports = [],
    ) {
      if (
        source === parent &&
        origin === fakeKernelOrigin &&
        !ports.length &&
        (data as { type?: unknown })?.type !== "neutron:msgbus:connect" &&
        (data as { type?: unknown })?.type !== "neutron:msgbus:probe"
      ) {
        kernelPort.postMessage(data);
        return;
      }
      for (const listener of messageListeners) {
        listener({ data, source, origin, ports } as unknown as MessageEvent);
      }
    },
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  installMessageListener(fakeWindow as unknown as Window);
  if (connect) {
    fakeWindow.dispatch(
      {
        type: "neutron:msgbus:connect",
        version: 1,
        sessionId: "test-session-0001",
      },
      parent,
      fakeKernelOrigin,
      [appPort as unknown as MessagePort],
    );
  }
  return fakeWindow;
}

function restoreWindow(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function replyWithKernelTools(
  fakeWindow: FakeWindow,
  requestId: number,
  names: string[],
): void {
  fakeWindow.dispatch({
    type: "response",
    id: requestId,
    ok: names.map((name) => ({
      name,
      inputSchema: { type: "object" },
    })),
  });
}

function vetKeySlotSummary(): VetKeySlotSummary {
  return {
    slot: "mailbox",
    purpose: "Encrypt and decrypt private Mail",
    keyHolder: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    status: "enabled",
    environment: "local",
    currentGeneration: "1",
    previousGeneration: null,
    generations: [
      {
        generation: "1",
        status: "current",
        keyName: "test_key_1",
        publicFingerprint: new Array(32).fill(3),
      },
    ],
    createdAt: "1",
    updatedAt: "2",
    lastUsedAt: null,
    totalDerivations: "1",
    approximateCycleSpend: "10000000000",
  };
}

function vetKeyPublicInfo(): VetKeyPublicInfo {
  return {
    canisterPrincipal: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    slot: "mailbox",
    generation: "1",
    suite: "bls12_381_g2",
    keyName: "test_key_1",
    publicKey: new Array(96).fill(5),
    publicFingerprint: new Array(32).fill(3),
    derivationInput: new Array(32).fill(4),
  };
}

afterEach(() => {
  disconnectMsgBus();
  restoreWindow();
});

test("json value guard accepts structured JSON only", () => {
  expect(isJsonValue(null)).toBe(true);
  expect(isJsonValue({ args: ["hello", 1, true, null] })).toBe(true);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(isJsonValue(cyclic)).toBe(false);
  expect(isJsonValue(Number.NaN)).toBe(false);
  expect(isJsonValue({ bad: undefined })).toBe(false);
  expect(isJsonValue({ bad: () => undefined })).toBe(false);
  expect(isJsonValue(new Array(2))).toBe(false);
  expect(
    isJsonValue(
      Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => "not data",
      }),
    ),
  ).toBe(false);
  let deeplyNested: unknown = null;
  for (let depth = 0; depth < 10_000; depth += 1) {
    deeplyNested = [deeplyNested];
  }
  expect(isJsonValue(deeplyNested)).toBe(true);
});

test("exec envelope guard rejects malformed postMessage data", () => {
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call_dialog", payload: { args: [] } },
    }),
  ).toBe(true);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: {
        action: "call",
        payload: null,
        context: {
          invocation: {
            id: "i".repeat(129),
            rootId: "r".repeat(16),
            capability: "c".repeat(32),
          },
        },
      },
    }),
  ).toBe(true);

  const inheritedInvocationFields = [
    "id",
    "rootId",
    "capability",
    "agentConsent",
  ] as const;
  const previousInvocationFields = new Map(
    inheritedInvocationFields.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(Object.prototype, name),
    ]),
  );
  try {
    Object.defineProperties(Object.prototype, {
      id: { configurable: true, value: "i".repeat(16) },
      rootId: { configurable: true, value: "r".repeat(16) },
      capability: { configurable: true, value: "c".repeat(64) },
      agentConsent: { configurable: true, value: true },
    });
    expect(
      isExecEnvelope({
        type: "exec",
        id: 5,
        payload: {
          action: "call",
          payload: null,
          context: { invocation: {} },
        },
      }),
    ).toBe(false);
  } finally {
    for (const name of inheritedInvocationFields) {
      const descriptor = previousInvocationFields.get(name);
      if (descriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, name);
      } else {
        Object.defineProperty(Object.prototype, name, descriptor);
      }
    }
  }

  expect(isExecEnvelope(null)).toBe(false);
  expect(isExecEnvelope({ type: "exec", id: 0 })).toBe(false);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "valid", payload: null },
      ignored: true,
    }),
  ).toBe(true);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: {
        action: "call",
        payload: "x".repeat(1024 * 1024 - 2),
      },
    }),
  ).toBe(true);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "x".repeat(129), payload: null },
    }),
  ).toBe(true);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "legacy action/route", payload: null },
    }),
  ).toBe(true);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "", payload: null },
    }),
  ).toBe(false);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call", payload: { bad: undefined } },
    }),
  ).toBe(false);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call", payload: null, context: undefined },
    }),
  ).toBe(true);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() =>
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call", payload: cyclic },
    }),
  ).not.toThrow();
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call", payload: cyclic },
    }),
  ).toBe(false);

  let deeplyNested: unknown = null;
  for (let depth = 0; depth < 128; depth += 1) {
    deeplyNested = [deeplyNested];
  }
  expect(
    isExecEnvelope({
      type: "exec",
      id: 2,
      payload: { action: "legacy", payload: deeplyNested },
    }),
  ).toBe(true);

  const manyNodes = Array.from({ length: 100_001 }, () => null);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 3,
      payload: { action: "legacy", payload: manyNodes },
    }),
  ).toBe(true);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 4,
      payload: { action: "legacy", payload: new Array(2) },
    }),
  ).toBe(true);
});

test("request cancellation envelopes are closed and versioned", () => {
  expect(
    isRequestCancelEnvelope({
      type: "neutron:msgbus:cancel",
      version: 1,
      id: 1,
    }),
  ).toBe(true);
  expect(
    isRequestCancelEnvelope({
      type: "neutron:msgbus:cancel",
      version: 2,
      id: 1,
    }),
  ).toBe(false);
  expect(
    isRequestCancelEnvelope({
      type: "neutron:msgbus:cancel",
      version: 1,
      id: 1,
      target: 2,
    }),
  ).toBe(false);

  const inherited = Object.create({ type: "neutron:msgbus:cancel" }) as Record<
    string,
    unknown
  >;
  inherited.version = 1;
  inherited.id = 1;
  expect(isRequestCancelEnvelope(inherited)).toBe(false);

  let getterRead = false;
  const accessor = { version: 1, id: 1 } as Record<string, unknown>;
  Object.defineProperty(accessor, "type", {
    enumerable: true,
    get() {
      getterRead = true;
      return "neutron:msgbus:cancel";
    },
  });
  expect(isRequestCancelEnvelope(accessor)).toBe(false);
  expect(getterRead).toBe(false);

  const nonEnumerableExtra = {
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 1,
  };
  Object.defineProperty(nonEnumerableExtra, "hidden", { value: true });
  expect(isRequestCancelEnvelope(nonEnumerableExtra)).toBe(false);

  const symbolExtra = {
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 1,
    [Symbol("hidden")]: true,
  };
  expect(isRequestCancelEnvelope(symbolExtra)).toBe(false);

  const nullPrototype = Object.assign(Object.create(null), {
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 1,
  });
  expect(isRequestCancelEnvelope(nullPrototype)).toBe(true);
});

test("response envelope guard requires exactly one json result field", () => {
  expect(isResponseEnvelope({ type: "response", id: 1, ok: null })).toBe(true);
  expect(
    isResponseEnvelope({
      type: "response",
      id: 1,
      error: { message: "no" },
    }),
  ).toBe(true);
  expect(isResponseEnvelope({ type: "response", id: 1 })).toBe(false);
  expect(
    isResponseEnvelope({ type: "response", id: 1, ok: null, error: "no" }),
  ).toBe(false);
  expect(
    isResponseEnvelope({ type: "response", id: 1, error: new Error("no") }),
  ).toBe(false);
  expect(
    isResponseEnvelope({ type: "response", id: 1, ok: null, extra: true }),
  ).toBe(true);
  expect(
    isResponseEnvelope({
      type: "response",
      id: 1,
      ok: "x".repeat(1024 * 1024 + 1),
    }),
  ).toBe(false);
});

test("progress envelope guard accepts bounded JSON-shaped events", () => {
  expect(
    isProgressEnvelope({ type: "progress", id: 1, value: { delta: "a" } }),
  ).toBe(true);
  expect(isProgressEnvelope({ type: "progress", id: 0, value: null })).toBe(
    false,
  );
  expect(
    isProgressEnvelope({ type: "progress", id: 1, value: { bad: undefined } }),
  ).toBe(false);
  expect(
    isProgressEnvelope({ type: "progress", id: 1, value: null, extra: true }),
  ).toBe(true);
  expect(
    isProgressEnvelope({
      type: "progress",
      id: 1,
      value: "x".repeat(64 * 1024 + 1),
    }),
  ).toBe(false);
});

test("app state envelopes require one bounded revisioned topic", () => {
  expect(
    isAppStateChangeEnvelope({
      type: "neutron:app:state",
      version: 1,
      topic: "contacts",
      revision: "42",
    }),
  ).toBe(true);
  expect(
    isAppStateChangeEnvelope({
      type: "neutron:app:state",
      version: 1,
      topic: "contacts",
      revision: "042",
    }),
  ).toBe(false);
  expect(
    isAppStateChangeEnvelope({
      type: "neutron:app:state",
      version: 1,
      topic: "../contacts",
      revision: "1",
    }),
  ).toBe(false);
});

test("app state listeners accept events only from the kernel peer", () => {
  const fakeWindow = installFakeWindow();
  const untrusted = createFakeSource();
  const revisions: string[] = [];
  const unsubscribe = onAppStateChange("contacts", (change) =>
    revisions.push(change.revision),
  );
  const event = {
    type: "neutron:app:state",
    version: 1,
    topic: "contacts",
    revision: "3",
  };

  fakeWindow.dispatch(event, untrusted);
  fakeWindow.dispatch(event);
  unsubscribe();
  fakeWindow.dispatch({ ...event, revision: "4" });

  expect(revisions).toEqual(["3"]);
});

test("app state publishing uses the source-bound kernel action", async () => {
  const fakeWindow = installFakeWindow();
  const pending = publishAppStateChange("filesystem", 7);
  const request = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(request.payload).toEqual({
    action: "app.state.publish",
    payload: { topic: "filesystem", revision: "7" },
  });
  fakeWindow.dispatch({
    type: "response",
    id: request.id,
    ok: { delivered: 2 },
  });
  await expect(pending).resolves.toBeUndefined();
  expect(() => publishAppStateChange("bad/topic", 1)).toThrow(
    "Invalid app state topic",
  );
});

test("structured response errors become Error instances", async () => {
  const fakeWindow = installFakeWindow();
  const pending = exec("files.write", null);
  const request = fakeWindow.parent.messages[0]?.message as { id: number };

  fakeWindow.dispatch({
    type: "response",
    id: request.id,
    error: {
      name: "VfsError",
      message: "File already exists: /README.md",
      stack: "VfsError: File already exists: /README.md",
    },
  });

  const error = await pending.catch((reason) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    name: "VfsError",
    message: "File already exists: /README.md",
  });
  expect(toError({ error: { message: "Nested failure" } }).message).toBe(
    "Nested failure",
  );
  expect(toError({ code: "unknown" }, "File operation failed").message).toBe(
    "File operation failed",
  );
});

test("variant response errors retain domain details", () => {
  expect(toError({ validation: "Name is required" }).message).toBe(
    "validation: Name is required",
  );
  expect(toError({ conflict: { expected: "2", actual: "3" } }).message).toBe(
    "conflict: expected 2, actual 3",
  );
});

test("kernel host actions are explicit and never installed on window", async () => {
  const fakeWindow = installFakeWindow();
  const appFrame = createFakeSource();
  let calls = 0;
  expose(
    "validated",
    (_payload, context) => {
      calls += 1;
      return {
        sameSource:
          context.source === (appFrame as unknown as MessageEventSource),
        origin: context.origin,
      };
    },
    {
      schema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } },
        additionalProperties: false,
      },
    },
  );

  expect(() =>
    executeExposedAction(
      "validated",
      { value: 1 },
      {
        source: appFrame as unknown as MessageEventSource,
        origin: "https://hello.example",
      },
    ),
  ).toThrow("Invalid payload for action 'validated'");
  expect(
    await executeExposedAction(
      "validated",
      { value: "ok" },
      {
        source: appFrame as unknown as MessageEventSource,
        origin: "https://hello.example",
      },
    ),
  ).toEqual({
    sameSource: true,
    origin: "https://hello.example",
  });
  expect(calls).toBe(1);

  fakeWindow.dispatch(
    {
      type: "exec",
      id: 1,
      payload: { action: "validated", payload: { value: "window" } },
    },
    appFrame,
  );
  await nextTick();
  expect(appFrame.messages).toEqual([]);
  expect(calls).toBe(1);
});

test("current message-bus senders enforce the closed action-name rule", async () => {
  const channel = new MessageChannel();
  const messages: unknown[] = [];
  channel.port2.addEventListener("message", (event) => {
    messages.push(event.data);
  });
  channel.port2.start();

  for (const action of [
    "",
    "1starts_with_a_number",
    "contains whitespace",
    "contains/slash",
    "x".repeat(129),
  ]) {
    expect(() => execAppPort(channel.port1, action)).toThrow(
      "Invalid message-bus action name",
    );
    expect(() => execKernelPort(channel.port1, action)).toThrow(
      "Invalid message-bus action name",
    );
  }

  await nextTick();
  expect(messages).toEqual([]);
  channel.port1.close();
  channel.port2.close();
});

test("retiring a Kernel exec port cancels only that port's requests", async () => {
  const retired = new MessageChannel();
  const active = new MessageChannel();
  const retiredMessages: unknown[] = [];
  const activeMessages: unknown[] = [];
  retired.port2.addEventListener("message", (event) => {
    retiredMessages.push(event.data);
  });
  active.port2.addEventListener("message", (event) => {
    activeMessages.push(event.data);
  });
  retired.port2.start();
  active.port2.start();

  const retiredPending = execKernelPort(retired.port1, "retired", null, 1);
  const activePending = execKernelPort<string>(active.port1, "active", null, 1);
  await nextTick();
  const retiredRequest = retiredMessages[0] as { id: number };
  const activeRequest = activeMessages[0] as { id: number };

  retireExecPort(retired.port1, new Error("Old app document retired"));
  await expect(retiredPending).rejects.toThrow("Old app document retired");
  await nextTick();
  expect(retiredMessages[1]).toEqual({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: retiredRequest.id,
  });
  expect(activeMessages).toHaveLength(1);

  active.port2.postMessage({
    type: "response",
    id: activeRequest.id,
    ok: "still active",
  });
  await expect(activePending).resolves.toBe("still active");

  retired.port1.close();
  retired.port2.close();
  active.port1.close();
  active.port2.close();
});

test("Kernel port clients ignore oversized v1 response envelopes", async () => {
  const channel = new MessageChannel();
  let requestId: number | undefined;
  const receivedRequest = new Promise<void>((resolve) => {
    channel.port2.addEventListener("message", (event) => {
      const request = event.data as { type?: unknown; id?: unknown };
      if (request.type !== "exec" || typeof request.id !== "number") return;
      requestId = request.id;
      resolve();
    });
  });
  channel.port2.start();
  const progress: unknown[] = [];
  let settled = false;
  const pending = execKernelPort<string>(channel.port1, "bounded_reply", null, {
    timeout: 1,
    onProgress: (value) => progress.push(value),
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await receivedRequest;
  if (requestId === undefined) throw new Error("Missing request id");

  channel.port2.postMessage({
    type: "progress",
    id: requestId,
    value: "x".repeat(64 * 1024 + 1),
  });
  channel.port2.postMessage({
    type: "response",
    id: requestId,
    ok: "x".repeat(1024 * 1024 + 1),
  });
  await nextTick();
  await nextTick();
  expect(progress).toEqual([]);
  expect(settled).toBe(false);

  channel.port2.postMessage({
    type: "progress",
    id: requestId,
    value: { step: 1 },
  });
  channel.port2.postMessage({
    type: "response",
    id: requestId,
    ok: "bounded",
  });
  await expect(pending).resolves.toBe("bounded");
  expect(progress).toEqual([{ step: 1 }]);
  channel.port1.close();
  channel.port2.close();
});

test("Kernel port clients accept released open and deep v1 replies", async () => {
  const channel = new MessageChannel();
  let requestId: number | undefined;
  channel.port2.addEventListener("message", (event) => {
    const request = event.data as { type?: unknown; id?: unknown };
    if (request.type === "exec" && typeof request.id === "number") {
      requestId = request.id;
    }
  });
  channel.port2.start();

  const progress: unknown[] = [];
  const pending = execKernelPort<string>(channel.port1, "legacy_reply", null, {
    timeout: 1,
    onProgress: (value) => progress.push(value),
  });
  await nextTick();
  if (requestId === undefined) throw new Error("Missing request id");

  let deeplyNested: unknown = null;
  for (let depth = 0; depth < 128; depth += 1) {
    deeplyNested = [deeplyNested];
  }
  channel.port2.postMessage({
    type: "progress",
    id: requestId,
    value: deeplyNested,
    legacyExtension: true,
  });
  channel.port2.postMessage({
    type: "response",
    id: requestId,
    ok: "legacy",
    legacyExtension: true,
  });

  await expect(pending).resolves.toBe("legacy");
  expect(progress).toEqual([deeplyNested]);
  channel.port1.close();
  channel.port2.close();
});

test("endpoint tools publish schemas and validate inputs and outputs", async () => {
  const fakeWindow = installFakeWindow();
  const kernel = fakeWindow.parent;
  exposeTool(
    "test_double",
    {
      title: "Double",
      description: "Double a number.",
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "number" } },
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "number" } },
        additionalProperties: false,
      },
    },
    (args) => ({ value: Number(args.value) * 2 }),
  );

  expect(listExposedTools()).toContainEqual(
    expect.objectContaining({ name: "test_double", title: "Double" }),
  );

  fakeWindow.dispatch(
    {
      type: "exec",
      id: 51,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: { name: "test_double", arguments: { value: "bad" } },
      },
    },
    kernel,
  );
  await nextTick();
  expect(kernel.messages[0]?.message).toMatchObject({
    type: "response",
    id: 51,
    error: { message: expect.stringContaining("Invalid arguments") },
  });

  fakeWindow.dispatch(
    {
      type: "exec",
      id: 52,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: {
          name: "test_double",
          arguments: { value: 4 },
          caller: { endpoint: "kernel", role: "kernel" },
        },
      },
    },
    kernel,
  );
  await nextTick();
  expect(kernel.messages[1]?.message).toEqual({
    type: "response",
    id: 52,
    ok: { value: 8 },
  });
  expect(removeExposedTool("test_double")).toBe(true);
});

test("provider-reviewed handlers receive one private approval callback", async () => {
  const fakeWindow = installFakeWindow();
  const capability = "a".repeat(64);
  let secondApprovalError = "";
  const review = {
    amount: "10.00000000 TEST",
    fee: "0.00010000 TEST",
    recipient: "aaaaa-aa",
  };
  exposeTool(
    "provider_transfer",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        required: ["sent"],
        properties: { sent: { type: "boolean" } },
        additionalProperties: false,
      },
      annotations: { "neutron:consent": "provider_once" },
    },
    async (_args, context) => {
      if (!context.requestApproval) {
        throw new Error("Provider approval is unavailable");
      }
      expect(context.presentUserInterface).toBeUndefined();
      await context.requestApproval(review);
      try {
        await context.requestApproval(review);
      } catch (error) {
        secondApprovalError = (error as Error).message;
      }
      return { sent: true };
    },
  );

  const invocation = {
    id: "1".repeat(16),
    rootId: "2".repeat(16),
    capability: "3".repeat(64),
  };
  fakeWindow.dispatch({
    type: "exec",
    id: 61,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "provider_transfer",
        arguments: {},
        providerApproval: { capability },
      },
      context: { invocation },
    },
  });
  await nextTick();
  const approval = fakeWindow.parent.messages.find(
    ({ message }) =>
      (message as { type?: unknown }).type === "exec" &&
      (message as { payload?: { action?: unknown } }).payload?.action ===
        "provider_approval.request",
  )?.message as
    | {
        id: number;
        payload: {
          payload: unknown;
          context?: { invocation?: unknown };
        };
      }
    | undefined;
  expect(approval).toMatchObject({
    payload: {
      action: "provider_approval.request",
      payload: { capability, review },
      context: { invocation },
    },
  });
  if (!approval) throw new Error("Missing provider approval request");
  fakeWindow.dispatch({
    type: "response",
    id: approval.id,
    ok: { approved: true },
  });
  await nextTick();
  expect(fakeWindow.parent.messages).toContainEqual({
    message: { type: "response", id: 61, ok: { sent: true } },
    targetOrigin: "port",
  });
  expect(secondApprovalError).toBe(
    "Provider interaction callback was already used",
  );
  expect(
    fakeWindow.parent.messages.filter(
      ({ message }) =>
        (message as { payload?: { action?: unknown } }).payload?.action ===
        "provider_approval.request",
    ),
  ).toHaveLength(1);
  removeExposedTool("provider_transfer");
});

test("provider approval accepts only one own decision field", async () => {
  const fakeWindow = installFakeWindow();
  const capability = "2".repeat(64);
  exposeTool(
    "provider_exact_decision",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:consent": "provider_once" },
    },
    async (_args, context) => {
      if (!context.requestApproval) {
        throw new Error("Provider approval is unavailable");
      }
      await context.requestApproval({ summary: "One bounded operation" });
      return null;
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 610,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "provider_exact_decision",
        arguments: {},
        providerApproval: { capability },
      },
    },
  });
  await nextTick();
  const approval = fakeWindow.parent.messages.find(
    ({ message }) =>
      (message as { payload?: { action?: unknown } }).payload?.action ===
      "provider_approval.request",
  )?.message as { id?: unknown } | undefined;
  if (typeof approval?.id !== "number") {
    throw new Error("Missing provider approval request");
  }
  const inheritedApproved = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "approved",
  );
  try {
    Object.defineProperty(Object.prototype, "approved", {
      configurable: true,
      value: true,
    });
    fakeWindow.dispatch({
      type: "response",
      id: approval.id,
      ok: { unrelated: null },
    });
    await nextTick();
  } finally {
    if (inheritedApproved === undefined) {
      Reflect.deleteProperty(Object.prototype, "approved");
    } else {
      Object.defineProperty(Object.prototype, "approved", inheritedApproved);
    }
  }
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 610,
    error: { message: "Invalid provider approval response" },
  });
  removeExposedTool("provider_exact_decision");
});

test("provider presentation sends one exact closed request and shares the approval gate", async () => {
  const fakeWindow = installFakeWindow();
  const capability = "c".repeat(64);
  const presentation = {
    tileId: "approval_panel",
    tool: "review_request_v1",
    arguments: {
      requestId: "00112233445566778899aabbccddeeff",
      amountAtoms: "1000000",
    },
  };
  let secondInteractionError = "";
  exposeTool(
    "provider_present",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        required: ["decision"],
        properties: { decision: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { "neutron:consent": "provider_once" },
    },
    async (_args, context) => {
      if (!context.presentUserInterface || !context.requestApproval) {
        throw new Error("Provider interaction is unavailable");
      }
      const result = await context.presentUserInterface<{ decision: string }>(
        presentation,
      );
      try {
        await context.requestApproval({ amount: "must not be requested" });
      } catch (error) {
        secondInteractionError = (error as Error).message;
      }
      return result;
    },
  );

  const invocation = {
    id: "4".repeat(16),
    rootId: "5".repeat(16),
    capability: "6".repeat(64),
  };
  fakeWindow.dispatch({
    type: "exec",
    id: 64,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "provider_present",
        arguments: {},
        providerApproval: { capability },
        providerUi: true,
      },
      context: { invocation },
    },
  });
  await nextTick();
  const request = fakeWindow.parent.messages.find(
    ({ message }) =>
      (message as { type?: unknown }).type === "exec" &&
      (message as { payload?: { action?: unknown } }).payload?.action ===
        "provider_ui.present",
  )?.message as
    | {
        type: "exec";
        id: number;
        payload: {
          action: string;
          payload: unknown;
          context?: { invocation?: unknown };
        };
      }
    | undefined;
  expect(request).toEqual({
    type: "exec",
    id: expect.any(Number),
    payload: {
      action: "provider_ui.present",
      payload: { capability, ...presentation },
      context: { invocation },
    },
  });
  if (!request) throw new Error("Missing provider presentation request");
  fakeWindow.dispatch({
    type: "response",
    id: request.id,
    ok: { decision: "approved" },
  });
  await nextTick();

  expect(fakeWindow.parent.messages).toContainEqual({
    message: {
      type: "response",
      id: 64,
      ok: { decision: "approved" },
    },
    targetOrigin: "port",
  });
  expect(secondInteractionError).toBe(
    "Provider interaction callback was already used",
  );
  expect(
    fakeWindow.parent.messages.some(
      ({ message }) =>
        (message as { payload?: { action?: unknown } }).payload?.action ===
        "provider_approval.request",
    ),
  ).toBe(false);
  removeExposedTool("provider_present");
});

test("provider presentation requires own routing fields", async () => {
  const fakeWindow = installFakeWindow();
  const capability = "7".repeat(64);
  exposeTool(
    "provider_inherited_present",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:consent": "provider_once" },
    },
    async (_args, context) => {
      if (!context.presentUserInterface) {
        throw new Error("Provider UI is unavailable");
      }
      const inheritedRequest = {} as {
        tileId: string;
        tool: string;
        arguments: JsonObject;
      };
      return context.presentUserInterface(inheritedRequest);
    },
  );
  const names = ["tileId", "tool", "arguments"] as const;
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(Object.prototype, name),
    ]),
  );
  try {
    Object.defineProperties(Object.prototype, {
      tileId: { configurable: true, value: "approval_panel" },
      tool: { configurable: true, value: "review_request_v1" },
      arguments: { configurable: true, value: { inherited: true } },
    });
    fakeWindow.dispatch({
      type: "exec",
      id: 65,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: {
          name: "provider_inherited_present",
          arguments: {},
          providerApproval: { capability },
          providerUi: true,
        },
      },
    });
    await nextTick();
    const unexpected = fakeWindow.parent.messages.find(
      ({ message }) =>
        (message as { payload?: { action?: unknown } }).payload?.action ===
        "provider_ui.present",
    )?.message as { id?: unknown } | undefined;
    if (typeof unexpected?.id === "number") {
      fakeWindow.dispatch({ type: "response", id: unexpected.id, ok: null });
      await nextTick();
    }
    expect(unexpected).toBeUndefined();
    expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
      type: "response",
      id: 65,
      error: { message: "Invalid provider presentation request" },
    });
  } finally {
    removeExposedTool("provider_inherited_present");
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, name);
      } else {
        Object.defineProperty(Object.prototype, name, descriptor);
      }
    }
  }
});

test("provider-reviewed handlers receive no callbacks from a pre-provider Kernel", async () => {
  const fakeWindow = installFakeWindow();
  let callbackPresent = true;
  exposeTool(
    "provider_compatibility",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:consent": "provider_once" },
    },
    (_args, context) => {
      callbackPresent = context.requestApproval !== undefined;
      if (!context.requestApproval) {
        throw new Error("Provider approval is unavailable");
      }
      return null;
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 62,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "provider_compatibility", arguments: {} },
    },
  });
  await nextTick();
  expect(callbackPresent).toBe(false);
  expect(fakeWindow.parent.messages[0]?.message).toMatchObject({
    type: "response",
    id: 62,
    error: { message: "Provider approval is unavailable" },
  });
  removeExposedTool("provider_compatibility");
});

test("a legacy provider capability does not claim provider UI support", async () => {
  const fakeWindow = installFakeWindow();
  let approvalPresent = false;
  let presentationPresent = true;
  exposeTool(
    "provider_legacy_compatibility",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:consent": "provider_once" },
    },
    (_args, context) => {
      approvalPresent = context.requestApproval !== undefined;
      presentationPresent = context.presentUserInterface !== undefined;
      return null;
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 69,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "provider_legacy_compatibility",
        arguments: {},
        providerApproval: { capability: "d".repeat(64) },
      },
    },
  });
  await nextTick();
  expect(approvalPresent).toBe(true);
  expect(presentationPresent).toBe(false);
  expect(fakeWindow.parent.messages[0]?.message).toEqual({
    type: "response",
    id: 69,
    ok: null,
  });
  removeExposedTool("provider_legacy_compatibility");
});

test("provider UI support markers are closed and capability-bound", async () => {
  const fakeWindow = installFakeWindow();
  let handlerCalls = 0;
  exposeTool(
    "provider_ui_marker",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:consent": "provider_once" },
    },
    () => {
      handlerCalls += 1;
      return null;
    },
  );

  const dispatch = (id: number, metadata: Record<string, unknown>) => {
    fakeWindow.dispatch({
      type: "exec",
      id,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: {
          name: "provider_ui_marker",
          arguments: {},
          ...metadata,
        },
      },
    });
  };
  dispatch(70, { providerUi: true });
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 70,
    error: { message: "Provider UI support requires an approval capability" },
  });
  dispatch(71, {
    providerApproval: { capability: "e".repeat(64) },
    providerUi: false,
  });
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 71,
    error: { message: "Invalid provider UI support marker" },
  });
  expect(handlerCalls).toBe(0);
  removeExposedTool("provider_ui_marker");
});

test("provider presentation bounds the exact normalized wire payload", async () => {
  const fakeWindow = installFakeWindow();
  const capability = "f".repeat(64);
  const wireWithoutPadding = {
    capability,
    tileId: "approval_panel",
    tool: "review_request_v1",
    arguments: { padding: "" },
  };
  const fixedBytes = new TextEncoder().encode(
    JSON.stringify(wireWithoutPadding),
  ).byteLength;
  const padding = "x".repeat(
    MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES - fixedBytes + 1,
  );
  exposeTool(
    "provider_wire_bound",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:consent": "provider_once" },
    },
    async (_args, context) => {
      if (!context.presentUserInterface) {
        throw new Error("Provider UI is unavailable");
      }
      return context.presentUserInterface({
        tileId: "approval_panel",
        tool: "review_request_v1",
        arguments: { padding },
      });
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 72,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "provider_wire_bound",
        arguments: {},
        providerApproval: { capability },
        providerUi: true,
      },
    },
  });
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 72,
    error: {
      message: `Provider presentation request exceeds ${MSG_BUS_PROVIDER_APPROVAL_MAX_BYTES} bytes`,
    },
  });
  expect(
    fakeWindow.parent.messages.some(
      ({ message }) =>
        (message as { payload?: { action?: unknown } }).payload?.action ===
        "provider_ui.present",
    ),
  ).toBe(false);
  removeExposedTool("provider_wire_bound");
});

test("ordinary handlers reject injected provider approval capabilities", async () => {
  const fakeWindow = installFakeWindow();
  let handlerCalled = false;
  exposeTool(
    "ordinary_tool",
    { inputSchema: { type: "object", additionalProperties: false } },
    (_args, context) => {
      handlerCalled = true;
      expect(context.requestApproval).toBeUndefined();
      return null;
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 63,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "ordinary_tool",
        arguments: {},
        providerApproval: { capability: "b".repeat(64) },
      },
    },
  });
  await nextTick();
  expect(handlerCalled).toBe(false);
  expect(fakeWindow.parent.messages[0]?.message).toMatchObject({
    type: "response",
    id: 63,
    error: { message: "Unexpected provider approval capability" },
  });
  removeExposedTool("ordinary_tool");
});

test("endpoint tools settle oversized errors with a bounded fallback", async () => {
  const fakeWindow = installFakeWindow();
  exposeTool(
    "oversized_error",
    { inputSchema: { type: "object", additionalProperties: false } },
    () => {
      throw new Error("x".repeat(2 * 1024 * 1024));
    },
  );

  fakeWindow.dispatch({
    type: "exec",
    id: 53,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "oversized_error", arguments: {} },
    },
  });
  await nextTick();
  const response = fakeWindow.parent.messages[0]?.message;
  expect(isResponseEnvelope(response)).toBe(true);
  expect(response).toEqual({
    type: "response",
    id: 53,
    error: {
      name: "Error",
      message: "Request failed with an oversized error",
    },
  });
  removeExposedTool("oversized_error");
});

test("agent consent uses a private invocation-bound control action", async () => {
  const fakeWindow = installFakeWindow();
  let entered = false;
  let agentMode = false;
  let cancelled = false;
  let aborted = false;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  exposeTool(
    "agent_control_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async (_args, context) => {
      entered = true;
      agentMode = context.agentMode === true;
      context.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      context.agentConsent?.register(async () => ({
        decision: "allow",
        reason: "Matches the current goal",
      }));
      context.agentConsent?.onCancel(() => {
        cancelled = true;
        release();
      });
      await hold;
      return {};
    },
  );
  const invocation = {
    id: "1111111111111111",
    rootId: "2222222222222222",
    capability: "3".repeat(64),
    agentConsent: true,
  };
  fakeWindow.dispatch({
    type: "exec",
    id: 201,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "agent_control_fixture", arguments: {} },
      context: { invocation },
    },
  });
  await nextTick();
  expect(entered).toBe(true);
  expect(agentMode).toBe(true);

  fakeWindow.dispatch({
    type: "exec",
    id: 202,
    payload: {
      action: msgBusLocalActions.agentConsentDecide,
      payload: {
        version: 1,
        id: "challenge-0000001",
        rootId: invocation.rootId,
        expiresAt: Date.now() + 30_000,
        requester: { appId: "records", role: "tray" },
        chain: [
          { appId: "agent", tool: "agent_chat" },
          { appId: "records", tool: "records_write" },
        ],
        kind: "backend_access",
        persistence: "durable",
        risk: "high",
        action: { principal: "ryjl3-tyaaa-aaaaa-aaaba-cai" },
      },
    },
  });
  await nextTick();
  expect(
    fakeWindow.parent.messages.find(
      ({ message }) => (message as { id?: number }).id === 202,
    )?.message,
  ).toMatchObject({
    type: "response",
    ok: { decision: "allow", reason: "Matches the current goal" },
  });

  fakeWindow.dispatch({
    type: "exec",
    id: 203,
    payload: {
      action: msgBusLocalActions.agentTurnCancel,
      payload: { rootId: invocation.rootId },
    },
  });
  await nextTick();
  expect(cancelled).toBe(true);
  expect(aborted).toBe(true);
  removeExposedTool("agent_control_fixture");
});

test("agent consent request cancellation aborts its handler and releases the local request id", async () => {
  const fakeWindow = installFakeWindow();
  let releaseTool!: () => void;
  const toolHold = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  let decisionCalls = 0;
  let firstSignal: AbortSignal | undefined;
  let firstEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  exposeTool(
    "agent_consent_cancel_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async (_args, context) => {
      context.agentConsent?.register(async (_challenge, signal) => {
        decisionCalls += 1;
        if (decisionCalls === 1) {
          firstSignal = signal;
          firstEntered();
          return new Promise<never>(() => undefined);
        }
        return { decision: "allow", reason: "Fresh request" };
      });
      await toolHold;
      return {};
    },
  );
  const invocation = {
    id: "4111111111111111",
    rootId: "4222222222222222",
    capability: "5".repeat(64),
    agentConsent: true,
  };
  fakeWindow.dispatch({
    type: "exec",
    id: 211,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "agent_consent_cancel_fixture", arguments: {} },
      context: { invocation },
    },
  });
  await nextTick();

  const challenge = {
    version: 1,
    id: "challenge-0000002",
    rootId: invocation.rootId,
    expiresAt: Date.now() + 30_000,
    requester: { appId: "records", role: "background" },
    chain: [
      { appId: "agent", tool: "agent_chat" },
      { appId: "records", tool: "records_write" },
    ],
    kind: "connection",
    persistence: "durable",
    risk: "high",
    action: { provider: "records" },
  };
  fakeWindow.dispatch({
    type: "exec",
    id: 212,
    payload: {
      action: msgBusLocalActions.agentConsentDecide,
      payload: challenge,
    },
  });
  await entered;
  fakeWindow.dispatch({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 212,
  });
  await nextTick();
  expect(firstSignal?.aborted).toBe(true);
  expect(
    fakeWindow.parent.messages.find(
      ({ message }) =>
        (message as { type?: string; id?: number }).type === "response" &&
        (message as { id?: number }).id === 212,
    )?.message,
  ).toMatchObject({ type: "response", id: 212, error: {} });

  fakeWindow.dispatch({
    type: "exec",
    id: 212,
    payload: {
      action: msgBusLocalActions.agentConsentDecide,
      payload: challenge,
    },
  });
  await nextTick();
  expect(decisionCalls).toBe(2);
  expect(
    fakeWindow.parent.messages
      .filter(
        ({ message }) =>
          (message as { type?: string; id?: number }).type === "response" &&
          (message as { id?: number }).id === 212,
      )
      .at(-1)?.message,
  ).toMatchObject({
    type: "response",
    id: 212,
    ok: { decision: "allow", reason: "Fresh request" },
  });

  releaseTool();
  await nextTick();
  removeExposedTool("agent_consent_cancel_fixture");
});

test("endpoint-local tool actions ignore sibling windows", async () => {
  const fakeWindow = installFakeWindow();
  const sibling = createFakeSource();
  exposeTool(
    "sibling_private",
    { inputSchema: { type: "object", additionalProperties: false } },
    () => ({ exposed: true }),
  );

  fakeWindow.dispatch(
    {
      type: "exec",
      id: 61,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: { name: "sibling_private", arguments: {} },
      },
    },
    sibling,
  );
  await nextTick();
  expect(sibling.messages).toEqual([]);
  removeExposedTool("sibling_private");
});

test("tool descriptors reject unsafe model-visible metadata", () => {
  for (const character of [
    "\u034f",
    "\u061c",
    "\u200b",
    "\u200c",
    "\u200d",
    "\u202e",
    "\u2066",
    "\u2069",
    "\ufeff",
    "\ufe0f",
    "\u2028",
  ]) {
    expect(() =>
      exposeTool(
        "unsafe_metadata",
        {
          title: `Hidden${character}text`,
          inputSchema: { type: "object" },
        },
        () => null,
      ),
    ).toThrow(/Invalid tool title/);
  }

  expect(() =>
    exposeTool(
      "unsafe_pattern",
      {
        inputSchema: {
          type: "object",
          properties: {
            value: { type: "string", pattern: "^(a+)+$" },
          },
        },
      },
      () => null,
    ),
  ).toThrow(/unsafe pattern/);

  expect(() =>
    exposeTool(
      "external_schema",
      {
        inputSchema: { $ref: "https://example.test/schema.json" },
      },
      () => null,
    ),
  ).toThrow(/external reference/);

  expect(() =>
    exposeTool(
      "unsafe_schema_metadata",
      {
        inputSchema: {
          type: "object",
          description: "Hidden\u200binstructions",
        },
      },
      () => null,
    ),
  ).toThrow(/unsafe string metadata/);

  expect(() =>
    exposeTool(
      "unsafe_annotations",
      {
        inputSchema: { type: "object" },
        annotations: { warning: "Safe\u2060claim" },
      },
      () => null,
    ),
  ).toThrow(/annotation metadata/);

  exposeTool(
    "normalized_metadata",
    {
      title: "Cafe\u0301",
      inputSchema: { type: "object" },
    },
    () => null,
  );
  expect(
    listExposedTools().find(({ name }) => name === "normalized_metadata")
      ?.title,
  ).toBe("Caf\u00e9");
  removeExposedTool("normalized_metadata");
});

test("tool descriptors expose only the closed metadata-only audit profile", () => {
  exposeTool(
    "private_metadata",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: {
        "neutron:effects": ["read"],
        "neutron:audit": "metadata_only",
      },
    },
    () => null,
  );
  expect(
    listExposedTools().find(({ name }) => name === "private_metadata")
      ?.annotations,
  ).toEqual({
    "neutron:effects": ["read"],
    "neutron:audit": "metadata_only",
  });
  removeExposedTool("private_metadata");

  for (const audit of ["none", "full", "", null, 1, false]) {
    expect(() =>
      exposeTool(
        "invalid_audit",
        {
          inputSchema: { type: "object" },
          annotations: { "neutron:audit": audit } as any,
        },
        () => null,
      ),
    ).toThrow(/Unsupported neutron:audit/);
  }
});

test("tool descriptors expose only provider-owned one-shot consent", () => {
  exposeTool(
    "provider_reviewed",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: {
        "neutron:consent": NEUTRON_TOOL_CONSENT_PROVIDER_ONCE,
      },
    },
    () => null,
  );
  expect(
    listExposedTools().find(({ name }) => name === "provider_reviewed")
      ?.annotations,
  ).toEqual({ "neutron:consent": "provider_once" });
  removeExposedTool("provider_reviewed");

  for (const consent of ["provider_session", "once", "", null, 1, false]) {
    expect(() =>
      exposeTool(
        "invalid_provider_consent",
        {
          inputSchema: { type: "object" },
          annotations: { "neutron:consent": consent } as any,
        },
        () => null,
      ),
    ).toThrow(/Unsupported neutron:consent/);
  }

  for (const incompatible of [
    { "neutron:control": "cancel" },
    {
      "neutron:attachments": {
        version: 1,
        input: {
          name: "payload",
          mediaTypes: ["application/octet-stream"],
          maxBytes: 1,
          required: true,
        },
      },
    },
  ]) {
    expect(() =>
      exposeTool(
        "incompatible_provider_consent",
        {
          inputSchema: { type: "object" },
          annotations: {
            "neutron:consent": NEUTRON_TOOL_CONSENT_PROVIDER_ONCE,
            ...incompatible,
          },
        },
        () => null,
      ),
    ).toThrow(/cannot be combined with control or attachment/);
  }
});

test("tool descriptors expose only the closed same-app visibility profile", () => {
  exposeTool(
    "same_app_private",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:visibility": "same_app" },
    },
    () => null,
  );
  expect(
    listExposedTools().find(({ name }) => name === "same_app_private")
      ?.annotations,
  ).toEqual({ "neutron:visibility": "same_app" });
  removeExposedTool("same_app_private");

  for (const visibility of ["private", "agent", "", null, 1, false]) {
    expect(() =>
      exposeTool(
        "invalid_visibility",
        {
          inputSchema: { type: "object" },
          annotations: { "neutron:visibility": visibility } as any,
        },
        () => null,
      ),
    ).toThrow(/Unsupported neutron:visibility/);
  }
});

test("tool descriptors accept only closed same-app audience profiles", () => {
  for (const audience of [
    NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
    NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
  ] as const) {
    const name = `audience_${audience}`;
    exposeTool(
      name,
      {
        inputSchema: { type: "object", additionalProperties: false },
        annotations: {
          "neutron:visibility": "same_app",
          "neutron:audience": audience,
        },
      },
      () => null,
    );
    expect(
      listExposedTools().find((descriptor) => descriptor.name === name)
        ?.annotations,
    ).toEqual({
      "neutron:visibility": "same_app",
      "neutron:audience": audience,
    });
    removeExposedTool(name);
  }

  expect(() =>
    exposeTool(
      "audience_without_visibility",
      {
        inputSchema: { type: "object", additionalProperties: false },
        annotations: {
          "neutron:audience": NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
        },
      },
      () => null,
    ),
  ).toThrow(/must also use same-app visibility/);

  for (const audience of [
    "foreground",
    "root",
    "same_app",
    "",
    null,
    1,
    false,
  ]) {
    expect(() =>
      exposeTool(
        "invalid_audience",
        {
          inputSchema: { type: "object", additionalProperties: false },
          annotations: {
            "neutron:visibility": "same_app",
            "neutron:audience": audience,
          } as any,
        },
        () => null,
      ),
    ).toThrow(/Unsupported neutron:audience/);
  }
});

test("audience profiles reject incompatible tool annotations", () => {
  const incompatibleAnnotations = [
    {
      "neutron:attachments": {
        version: 1,
        input: {
          name: "payload",
          mediaTypes: ["application/octet-stream"],
          maxBytes: 1,
          required: true,
        },
      },
    },
    { "neutron:control": "cancel" },
    { "neutron:consent": NEUTRON_TOOL_CONSENT_PROVIDER_ONCE },
  ];

  for (const audience of [
    NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
    NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
  ] as const) {
    for (const incompatible of incompatibleAnnotations) {
      expect(() =>
        normalizeToolDescriptor({
          name: `incompatible_${audience}`,
          inputSchema: { type: "object", additionalProperties: false },
          annotations: {
            "neutron:visibility": "same_app",
            "neutron:audience": audience,
            ...incompatible,
          },
        }),
      ).toThrow(
        /Audience-restricted tools cannot use attachments, control, or provider consent/,
      );
    }
  }
});

test("audience-restricted handlers require the exact Kernel attestation", async () => {
  const fakeWindow = installFakeWindow();
  let handlerCalls = 0;
  exposeTool(
    "foreground_only",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        required: ["audience"],
        properties: { audience: { type: "string" } },
        additionalProperties: false,
      },
      annotations: {
        "neutron:visibility": "same_app",
        "neutron:audience": NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
      },
    },
    (_args, context) => {
      handlerCalls += 1;
      return { audience: context.audience ?? "missing" };
    },
  );

  const dispatch = (id: number, audience?: unknown) => {
    fakeWindow.dispatch({
      type: "exec",
      id,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: {
          name: "foreground_only",
          arguments: {},
          ...(audience === undefined ? {} : { audience }),
        },
      },
    });
  };

  dispatch(65);
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 65,
    error: {
      message: "Tool audience attestation is missing or invalid",
    },
  });
  expect(handlerCalls).toBe(0);

  dispatch(66, NEUTRON_TOOL_AUDIENCE_AGENT_ROOT);
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 66,
    error: {
      message: "Tool audience attestation is missing or invalid",
    },
  });
  expect(handlerCalls).toBe(0);

  dispatch(67, "forged_root");
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 67,
    error: { message: "Invalid tool audience attestation" },
  });
  expect(handlerCalls).toBe(0);

  dispatch(68, NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE);
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toEqual({
    type: "response",
    id: 68,
    ok: { audience: NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE },
  });
  expect(handlerCalls).toBe(1);
  removeExposedTool("foreground_only");
});

test("agent-root handlers require invocation metadata from the active Kernel port", async () => {
  const fakeWindow = installFakeWindow();
  const observedContexts: Array<{ audience?: string; agentMode: boolean }> = [];
  exposeTool(
    "root_only",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: {
        type: "object",
        required: ["accepted"],
        properties: { accepted: { type: "boolean" } },
        additionalProperties: false,
      },
      annotations: {
        "neutron:visibility": "same_app",
        "neutron:audience": NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      },
    },
    (_args, context) => {
      observedContexts.push({
        ...(context.audience ? { audience: context.audience } : {}),
        agentMode: context.agentMode === true,
      });
      return { accepted: true };
    },
  );

  fakeWindow.dispatch({
    type: "exec",
    id: 81,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "root_only",
        arguments: {},
        audience: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      },
    },
  });
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 81,
    error: { message: "Root-agent audience requires invocation metadata" },
  });
  expect(observedContexts).toEqual([]);

  const inheritedInvocation = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "invocation",
  );
  try {
    Object.defineProperty(Object.prototype, "invocation", {
      configurable: true,
      value: {
        id: "inherited1111111",
        rootId: "inherited2222222",
        capability: "7".repeat(64),
      },
    });
    fakeWindow.dispatch({
      type: "exec",
      id: 810,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: {
          name: "root_only",
          arguments: {},
          audience: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
        },
        context: {},
      },
    });
    await nextTick();
  } finally {
    if (inheritedInvocation === undefined) {
      Reflect.deleteProperty(Object.prototype, "invocation");
    } else {
      Object.defineProperty(
        Object.prototype,
        "invocation",
        inheritedInvocation,
      );
    }
  }
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 810,
    error: { message: "Root-agent audience requires invocation metadata" },
  });
  expect(observedContexts).toEqual([]);

  const invocation = {
    id: "8111111111111111",
    rootId: "8222222222222222",
    capability: "8".repeat(64),
  };
  fakeWindow.dispatch({
    type: "exec",
    id: 82,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "root_only",
        arguments: {},
        audience: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      },
      context: { invocation },
    },
  });
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toEqual({
    type: "response",
    id: 82,
    ok: { accepted: true },
  });
  expect(observedContexts).toEqual([
    {
      audience: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      agentMode: true,
    },
  ]);
  removeExposedTool("root_only");
});

test("alternate peer ports cannot invoke local tool or control actions", async () => {
  installFakeWindow();
  let handlerCalls = 0;
  exposeTool(
    "alternate_port_root_only",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: {
        "neutron:visibility": "same_app",
        "neutron:audience": NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      },
    },
    () => {
      handlerCalls += 1;
      return null;
    },
  );

  const alternate = new MessageChannel();
  const replies: unknown[] = [];
  alternate.port2.addEventListener("message", (event) => {
    const message = event.data;
    if (
      isExecEnvelope(message) &&
      message.payload.action === "install_listener_probe"
    ) {
      alternate.port2.postMessage({
        type: "response",
        id: message.id,
        ok: null,
      });
      return;
    }
    replies.push(message);
  });
  alternate.port2.start();
  await execAppPort(alternate.port1, "install_listener_probe", null, 1);

  alternate.port2.postMessage({
    type: "exec",
    id: 83,
    payload: { action: msgBusLocalActions.toolsList, payload: null },
  });
  alternate.port2.postMessage({
    type: "exec",
    id: 84,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "alternate_port_root_only",
        arguments: {},
        audience: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      },
      context: {
        invocation: {
          id: "8311111111111111",
          rootId: "8322222222222222",
          capability: "8".repeat(64),
        },
      },
    },
  });
  alternate.port2.postMessage({
    type: "exec",
    id: 86,
    payload: {
      action: msgBusLocalActions.agentConsentDecide,
      payload: null,
    },
  });
  alternate.port2.postMessage({
    type: "exec",
    id: 87,
    payload: {
      action: msgBusLocalActions.agentTurnCancel,
      payload: null,
    },
  });
  await nextTick();
  await nextTick();

  expect(handlerCalls).toBe(0);
  expect(replies).toEqual([]);
  removeExposedTool("alternate_port_root_only");
  alternate.port1.close();
  alternate.port2.close();
});

test("inherited tool call fields and security metadata are ignored", async () => {
  const fakeWindow = installFakeWindow();
  const observations: Array<{
    audience: boolean;
    approval: boolean;
    presentation: boolean;
    caller: boolean;
    callerAppId: boolean | null;
    callerRole: boolean | null;
    callerSession: boolean | null;
    arguments: string[];
  }> = [];
  exposeTool(
    "own_metadata_only",
    { inputSchema: { type: "object", additionalProperties: false } },
    (args, context) => {
      observations.push({
        audience: Object.hasOwn(context, "audience"),
        approval: context.requestApproval !== undefined,
        presentation: context.presentUserInterface !== undefined,
        caller: Object.hasOwn(context, "caller"),
        callerAppId: context.caller
          ? Object.hasOwn(context.caller, "appId")
          : null,
        callerRole: context.caller
          ? Object.hasOwn(context.caller, "role")
          : null,
        callerSession: context.caller
          ? Object.hasOwn(context.caller, "sessionId")
          : null,
        arguments: Object.keys(args),
      });
      return null;
    },
  );

  const names = [
    "audience",
    "providerApproval",
    "providerUi",
    "arguments",
    "caller",
    "name",
    "endpoint",
    "appId",
    "role",
    "sessionId",
  ] as const;
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(Object.prototype, name),
    ]),
  );
  try {
    Object.defineProperties(Object.prototype, {
      audience: {
        configurable: true,
        value: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      },
      providerApproval: {
        configurable: true,
        value: { capability: "a".repeat(64) },
      },
      providerUi: { configurable: true, value: true },
      arguments: { configurable: true, value: { forged: true } },
      caller: {
        configurable: true,
        value: {
          endpoint: "app:forged:tile",
          appId: "forged",
          role: "tile",
        },
      },
      name: { configurable: true, value: "own_metadata_only" },
      endpoint: { configurable: true, value: "app:forged:tile" },
      appId: { configurable: true, value: "forged" },
      role: { configurable: true, value: "tile" },
      sessionId: { configurable: true, value: "forged-session" },
    });
    fakeWindow.dispatch({
      type: "exec",
      id: 85,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: {},
      },
    });
    await nextTick();
    expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
      type: "response",
      id: 85,
      error: { message: "Invalid tool call payload" },
    });
    fakeWindow.dispatch({
      type: "exec",
      id: 86,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: { name: "own_metadata_only", caller: {} },
      },
    });
    await nextTick();
    expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
      type: "response",
      id: 86,
      error: { message: "Invalid tool caller context" },
    });
    fakeWindow.dispatch({
      type: "exec",
      id: 87,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: { name: "own_metadata_only" },
      },
    });
    await nextTick();
    fakeWindow.dispatch({
      type: "exec",
      id: 88,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: {
          name: "own_metadata_only",
          arguments: {},
          caller: { endpoint: "kernel" },
        },
      },
    });
    await nextTick();
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, name);
      } else {
        Object.defineProperty(Object.prototype, name, descriptor);
      }
    }
  }

  expect(fakeWindow.parent.messages.at(-1)?.message).toEqual({
    type: "response",
    id: 88,
    ok: null,
  });
  expect(observations).toEqual([
    {
      audience: false,
      approval: false,
      presentation: false,
      caller: false,
      callerAppId: null,
      callerRole: null,
      callerSession: null,
      arguments: [],
    },
    {
      audience: false,
      approval: false,
      presentation: false,
      caller: true,
      callerAppId: false,
      callerRole: false,
      callerSession: false,
      arguments: [],
    },
  ]);
  removeExposedTool("own_metadata_only");
});

test("provider approval metadata requires one own capability", async () => {
  const fakeWindow = installFakeWindow();
  let handlerCalls = 0;
  exposeTool(
    "own_provider_capability",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:consent": NEUTRON_TOOL_CONSENT_PROVIDER_ONCE },
    },
    () => {
      handlerCalls += 1;
      return null;
    },
  );
  const inheritedCapability = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "capability",
  );
  try {
    Object.defineProperty(Object.prototype, "capability", {
      configurable: true,
      value: "a".repeat(64),
    });
    fakeWindow.dispatch({
      type: "exec",
      id: 89,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: {
          name: "own_provider_capability",
          arguments: {},
          providerApproval: {},
        },
      },
    });
    await nextTick();
  } finally {
    if (inheritedCapability === undefined) {
      Reflect.deleteProperty(Object.prototype, "capability");
    } else {
      Object.defineProperty(
        Object.prototype,
        "capability",
        inheritedCapability,
      );
    }
    removeExposedTool("own_provider_capability");
  }
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 89,
    error: { message: "Invalid provider approval capability" },
  });
  expect(handlerCalls).toBe(0);
});

test("provider approval metadata is one exact enumerable data property", async () => {
  const fakeWindow = installFakeWindow();
  let handlerCalls = 0;
  exposeTool(
    "exact_provider_capability",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:consent": NEUTRON_TOOL_CONSENT_PROVIDER_ONCE },
    },
    () => {
      handlerCalls += 1;
      return null;
    },
  );
  const providerApproval = { capability: "9".repeat(64) };
  Object.defineProperty(providerApproval, "hidden", {
    value: true,
    enumerable: false,
  });
  fakeWindow.dispatch({
    type: "exec",
    id: 90,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "exact_provider_capability",
        arguments: {},
        providerApproval,
      },
    },
  });
  await nextTick();
  expect(fakeWindow.parent.messages.at(-1)?.message).toMatchObject({
    type: "response",
    id: 90,
    error: { message: "Invalid provider approval capability" },
  });
  expect(handlerCalls).toBe(0);
  removeExposedTool("exact_provider_capability");
});

test("inherited descriptor security annotations are ignored", async () => {
  const fakeWindow = installFakeWindow();
  const names = [
    "annotations",
    "neutron:consent",
    "neutron:audience",
    "neutron:visibility",
  ] as const;
  const previous = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(Object.prototype, name),
    ]),
  );
  try {
    Object.defineProperties(Object.prototype, {
      annotations: {
        configurable: true,
        value: {
          "neutron:visibility": "same_app",
          "neutron:audience": NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
        },
      },
      "neutron:consent": {
        configurable: true,
        value: NEUTRON_TOOL_CONSENT_PROVIDER_ONCE,
      },
      "neutron:audience": {
        configurable: true,
        value: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      },
      "neutron:visibility": { configurable: true, value: "same_app" },
    });

    expect(() =>
      normalizeToolDescriptor({
        name: "inherited_consent",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { "neutron:control": "cancel" },
      }),
    ).not.toThrow();
    const withoutOwnAnnotations = normalizeToolDescriptor({
      name: "inherited_annotations_descriptor",
      inputSchema: { type: "object", additionalProperties: false },
    });
    expect(Object.hasOwn(withoutOwnAnnotations, "annotations")).toBe(false);
    expect(() =>
      normalizeToolDescriptor({
        name: "own_audience_without_own_visibility",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: {
          "neutron:audience": NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
        },
      }),
    ).toThrow("Audience-restricted tools must also use same-app visibility");

    exposeTool(
      "inherited_annotations",
      {
        inputSchema: { type: "object", additionalProperties: false },
        annotations: {},
      },
      (_args, context) => ({
        audience: Object.hasOwn(context, "audience"),
        approval: context.requestApproval !== undefined,
      }),
    );
    fakeWindow.dispatch({
      type: "exec",
      id: 88,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: { name: "inherited_annotations", arguments: {} },
      },
    });
    await nextTick();
    expect(fakeWindow.parent.messages.at(-1)?.message).toEqual({
      type: "response",
      id: 88,
      ok: { audience: false, approval: false },
    });
  } finally {
    removeExposedTool("inherited_annotations");
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, name);
      } else {
        Object.defineProperty(Object.prototype, name, descriptor);
      }
    }
  }
});

test("tool cancellation control is declared and uses its reserved action", async () => {
  exposeTool(
    "cancel_work",
    {
      inputSchema: { type: "object", additionalProperties: false },
      annotations: { "neutron:control": "cancel" },
    },
    () => ({ cancelled: true }),
  );
  expect(
    listExposedTools().find(({ name }) => name === "cancel_work")?.annotations,
  ).toEqual({ "neutron:control": "cancel" });
  removeExposedTool("cancel_work");

  for (const control of ["abort", "", null, 1, false]) {
    expect(() =>
      exposeTool(
        "invalid_control",
        {
          inputSchema: { type: "object" },
          annotations: { "neutron:control": control } as any,
        },
        () => null,
      ),
    ).toThrow(/Unsupported neutron:control/);
  }

  const fakeWindow = installFakeWindow();
  const pending = callTool(
    {
      target: "app:wagyu:background",
      name: "wagyu_resident_verify_cancel",
      arguments: { requestId: "session:1" },
    },
    { timeout: 0.2, control: "cancel" },
  );
  const request = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: unknown;
  };
  expect(request).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call.control",
      payload: {
        target: "app:wagyu:background",
        name: "wagyu_resident_verify_cancel",
        arguments: { requestId: "session:1" },
      },
    },
  });
  fakeWindow.dispatch({
    type: "response",
    id: request.id,
    ok: { cancelled: true },
  });
  await expect(pending).resolves.toEqual({ cancelled: true });
});

test("message-channel handshake moves requests onto the kernel port", async () => {
  const fakeWindow = installFakeWindow();
  const channel = new MessageChannel();
  const requestPromise = new Promise<unknown>((resolve) => {
    channel.port2.addEventListener("message", (event) => {
      resolve(event.data);
      channel.port2.postMessage({
        type: "response",
        id: event.data.id,
        ok: "from-port",
      });
    });
    channel.port2.start();
  });

  fakeWindow.dispatch(
    {
      type: "neutron:msgbus:connect",
      version: 1,
      sessionId: "1234567890abcdef",
    },
    fakeWindow.parent,
    fakeKernelOrigin,
    [channel.port1],
  );
  const result = exec("port_action", { value: true }, 0.2);

  await expect(requestPromise).resolves.toMatchObject({
    type: "exec",
    payload: { action: "port_action", payload: { value: true } },
  });
  await expect(result).resolves.toBe("from-port");
  expect(fakeWindow.parent.messages).toHaveLength(0);
  channel.port2.close();
});

test("SPA route changes preserve the authenticated Kernel parent", async () => {
  const fakeWindow = installFakeWindow(undefined, false);
  fakeWindow.location.href = `https://ahelloa--${fakeCanisterId}.icp0.io/settings`;
  const channel = new MessageChannel();
  channel.port2.addEventListener("message", (event) => {
    channel.port2.postMessage({
      type: "response",
      id: event.data.id,
      ok: "kernel-after-route-change",
    });
  });
  channel.port2.start();

  fakeWindow.dispatch(
    {
      type: "neutron:msgbus:connect",
      version: 1,
      sessionId: "routechange123456",
    },
    fakeWindow.parent,
    fakeKernelOrigin,
    [channel.port1],
  );

  await expect(exec("routed_action", {}, 0.2)).resolves.toBe(
    "kernel-after-route-change",
  );
  channel.port2.close();
});

test("app calls wait for the private kernel port", async () => {
  const fakeWindow = installFakeWindow(undefined, false);
  const channel = new MessageChannel();
  const result = exec("opaque_action", { value: true }, 0.2);

  expect(fakeWindow.parent.messages).toHaveLength(0);
  channel.port2.addEventListener("message", (event) => {
    channel.port2.postMessage({
      type: "response",
      id: event.data.id,
      ok: "private-port",
    });
  });
  channel.port2.start();
  fakeWindow.dispatch(
    {
      type: "neutron:msgbus:connect",
      version: 1,
      sessionId: "opaque1234567890",
    },
    fakeWindow.parent,
    fakeKernelOrigin,
    [channel.port1],
  );

  await expect(result).resolves.toBe("private-port");
  expect(fakeWindow.parent.messages).toHaveLength(0);
  channel.port2.close();
});

test("request cancellation removes a private kernel-port waiter", async () => {
  const fakeWindow = installFakeWindow(undefined, false);
  const controller = new AbortController();
  const pending = exec(
    "waiting_action",
    {},
    {
      timeout: 10,
      signal: controller.signal,
    },
  );
  expect(fakeWindow.parent.messages).toHaveLength(0);

  controller.abort();
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(fakeWindow.parent.messages).toHaveLength(0);
});

test("hostile parents cannot install a fake kernel port", async () => {
  const fakeWindow = installFakeWindow(undefined, false);
  const hostile = new MessageChannel();
  const legitimate = new MessageChannel();
  const hostileMessages: unknown[] = [];
  hostile.port2.addEventListener("message", (event) =>
    hostileMessages.push(event.data),
  );
  hostile.port2.start();

  fakeWindow.dispatch(
    {
      type: "neutron:msgbus:connect",
      version: 1,
      sessionId: "hostile123456789",
    },
    fakeWindow.parent,
    "https://attacker.example",
    [hostile.port1],
  );

  const result = exec("authenticated_action", {}, 0.2);
  await nextTick();
  expect(hostileMessages).toEqual([]);

  legitimate.port2.addEventListener("message", (event) => {
    legitimate.port2.postMessage({
      type: "response",
      id: event.data.id,
      ok: "kernel",
    });
  });
  legitimate.port2.start();
  fakeWindow.dispatch(
    {
      type: "neutron:msgbus:connect",
      version: 1,
      sessionId: "legitimate123456",
    },
    fakeWindow.parent,
    fakeKernelOrigin,
    [legitimate.port1],
  );

  await expect(result).resolves.toBe("kernel");
  hostile.port2.close();
  legitimate.port2.close();
});

test("hostile parent messages cannot invoke resident tools", async () => {
  const fakeWindow = installFakeWindow();
  let calls = 0;
  exposeTool(
    "parent_private",
    { inputSchema: { type: "object", additionalProperties: false } },
    () => {
      calls += 1;
      return { exposed: true };
    },
  );

  fakeWindow.dispatch(
    {
      type: "exec",
      id: 91,
      payload: {
        action: msgBusLocalActions.toolsCall,
        payload: { name: "parent_private", arguments: {} },
      },
    },
    fakeWindow.parent,
    "https://attacker.example",
  );
  await nextTick();

  expect(calls).toBe(0);
  expect(fakeWindow.parent.messages).toEqual([]);
  removeExposedTool("parent_private");
});

test("kernel action payload schemas reject untrusted DID and malformed input", () => {
  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world" },
      kernelSchemaPayloadSchema,
    ).valid,
  ).toBe(true);
  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world", args: ["John"] },
      kernelCallPayloadSchema,
    ).valid,
  ).toBe(true);

  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world", args: "John" },
      kernelCallPayloadSchema,
    ).valid,
  ).toBe(false);
  expect(
    validateJsonSchema({ method: "hello_world" }, kernelCallPayloadSchema)
      .valid,
  ).toBe(false);
  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world", did: "service : {}" },
      kernelCallPayloadSchema,
    ).valid,
  ).toBe(false);
  expect(
    validateJsonSchema(
      { canister: "bad canister", method: "hello_world" },
      kernelCallPayloadSchema,
    ).valid,
  ).toBe(false);
  expect(
    validateJsonSchema(
      { canister: "a".repeat(64), method: "hello_world" },
      kernelSchemaPayloadSchema,
    ).valid,
  ).toBe(false);
  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world", extra: true },
      kernelCallPayloadSchema,
    ).valid,
  ).toBe(false);
});

test("responses from unexpected sources are ignored", async () => {
  const fakeWindow = installFakeWindow();
  const wrongSource = createFakeSource();
  const pending = exec("call", null);
  const request = fakeWindow.parent.messages[0]?.message as { id: number };

  fakeWindow.dispatch(
    { type: "response", id: request.id, ok: "wrong" },
    wrongSource,
  );
  await expect(
    Promise.race([pending, nextTick().then(() => "still pending")]),
  ).resolves.toBe("still pending");

  fakeWindow.dispatch({ type: "response", id: request.id, ok: "right" });
  await expect(pending).resolves.toBe("right");
});

test("request progress is source-bound and final responses remain authoritative", async () => {
  const fakeWindow = installFakeWindow();
  const wrongSource = createFakeSource();
  const progress: unknown[] = [];
  const pending = exec("stream", null, {
    timeout: 0.2,
    onProgress: (value) => progress.push(value),
  });
  const request = fakeWindow.parent.messages[0]?.message as { id: number };

  fakeWindow.dispatch(
    { type: "progress", id: request.id, value: { delta: "wrong" } },
    wrongSource,
  );
  for (let index = 0; index < 40; index += 1) {
    fakeWindow.dispatch({
      type: "progress",
      id: request.id,
      value: { delta: index },
    });
  }
  expect(progress).toEqual(
    Array.from({ length: 40 }, (_, index) => ({ delta: index })),
  );

  fakeWindow.dispatch({ type: "response", id: request.id, ok: "complete" });
  await expect(pending).resolves.toBe("complete");
  fakeWindow.dispatch({
    type: "progress",
    id: request.id,
    value: { delta: "late" },
  });
  expect(progress).toHaveLength(40);
});

test("app clients accept released open and deep v1 replies", async () => {
  const fakeWindow = installFakeWindow();
  const progress: unknown[] = [];
  const pending = exec("legacy_reply", null, {
    timeout: 0.2,
    onProgress: (value) => progress.push(value),
  });
  const request = fakeWindow.parent.messages[0]?.message as { id: number };

  let deeplyNested: unknown = null;
  for (let depth = 0; depth < 128; depth += 1) {
    deeplyNested = [deeplyNested];
  }
  fakeWindow.dispatch({
    type: "progress",
    id: request.id,
    value: deeplyNested,
    legacyExtension: true,
  });
  fakeWindow.dispatch({
    type: "response",
    id: request.id,
    ok: "legacy",
    legacyExtension: true,
  });

  await expect(pending).resolves.toBe("legacy");
  expect(progress).toEqual([deeplyNested]);
});

test("ordinary call dialog prefers the descriptor-advertised v2 tool", async () => {
  const fakeWindow = installFakeWindow();
  const pending = callCanisterDialog(
    {
      canister: "aaaaa-aa",
      method: "hello_world",
      args: ["John"],
    },
    0.2,
  );
  const discovery = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: unknown;
  };

  expect(discovery).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.list",
      payload: { target: "kernel" },
    },
  });
  replyWithKernelTools(fakeWindow, discovery.id, [
    "canister.call_dialog",
    "canister.call_dialog_v2",
  ]);
  await nextTick();

  const request = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: unknown;
  };

  expect(request).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "canister.call_dialog_v2",
        arguments: {
          canister: "aaaaa-aa",
          method: "hello_world",
          args: ["John"],
        },
      },
    },
  });

  fakeWindow.dispatch({ type: "response", id: request.id, ok: "called" });
  await expect(pending).resolves.toBe("called");
});

test("ordinary call dialog retains released-Kernel legacy behavior when v2 is absent", async () => {
  const fakeWindow = installFakeWindow();
  const pending = callCanisterDialog(
    {
      canister: "aaaaa-aa",
      method: "hello_world",
      args: ["John"],
    },
    0.2,
  );
  const discovery = fakeWindow.parent.messages[0]?.message as { id: number };
  replyWithKernelTools(fakeWindow, discovery.id, [
    "canister.schema",
    "canister.call_dialog",
  ]);
  await nextTick();

  const request = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: unknown;
  };
  expect(request).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "canister.call_dialog",
        arguments: {
          canister: "aaaaa-aa",
          method: "hello_world",
          args: ["John"],
        },
      },
    },
  });

  fakeWindow.dispatch({ type: "response", id: request.id, ok: "legacy" });
  await expect(pending).resolves.toBe("legacy");
});

test("preapproved self-call helpers use one private binary-capable API1 transport", async () => {
  const fakeWindow = installFakeWindow();
  const channel = new MessageChannel();
  const requests: Array<Record<string, any>> = [];
  channel.port2.addEventListener("message", (event) => {
    const request = event.data as Record<string, any>;
    if (request.type !== "neutron:self-call:exec") return;
    requests.push(request);
    channel.port2.postMessage({
      type: "neutron:self-call:response",
      version: 1,
      id: request.id,
      ok: request.tool === "canister.query_self" ? "profile" : "fresh",
      blobs: [],
    });
  });
  channel.port2.start();
  fakeWindow.dispatch(
    {
      type: "neutron:msgbus:connect",
      version: 1,
      sessionId: "0123456789abcdef0123456789abcdef",
    },
    fakeWindow.parent,
    fakeKernelOrigin,
    [channel.port1],
  );

  const queryPending = querySelf("read_profile", [null], 0.2);
  await expect(queryPending).resolves.toBe("profile");
  expect(requests[0]).toMatchObject({
    type: "neutron:self-call:exec",
    version: 1,
    tool: "canister.query_self",
    method: "read_profile",
    args: [null],
    blobs: [],
  });

  const updatePending = updateSelf("refresh_profile", [null], 0.2);
  await expect(updatePending).resolves.toBe("fresh");
  expect(requests[1]).toMatchObject({
    type: "neutron:self-call:exec",
    version: 1,
    tool: "canister.update_self",
    method: "refresh_profile",
    args: [null],
    blobs: [],
  });
  expect(fakeWindow.parent.messages).toEqual([]);
  channel.port2.close();
});

test("actions-only backend reservation helper stays on the JSON tool path", async () => {
  const fakeWindow = installFakeWindow();
  const pending = requestBackendCallReservations({
    actions: [
      {
        kind: "reserve",
        scope: {
          kind: "principal",
          principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        },
      },
    ],
  });
  const request = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: unknown;
  };

  expect(request).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "backend_calls.request",
        arguments: {
          actions: [
            {
              kind: "reserve",
              scope: {
                kind: "principal",
                principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
              },
            },
          ],
        },
      },
    },
  });

  fakeWindow.dispatch({ type: "response", id: request.id, ok: {} });
  await expect(pending).resolves.toEqual({});
});

test("ethereum provider proxy uses private endpoint-bound actions", async () => {
  const fakeWindow = installFakeWindow();
  const connecting = connectEthereumProvider(0.2);
  const begin = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(begin.payload).toEqual({
    action: "ethereum_provider.begin",
    payload: {},
  });
  fakeWindow.dispatch({
    type: "response",
    id: begin.id,
    ok: {
      sessionId: "0123456789abcdef0123456789abcdef",
      provider: { name: "MetaMask", rdns: "io.metamask" },
    },
  });
  const connection = await connecting;

  const requesting = connection.provider.request({
    method: "eth_chainId",
  });
  const request = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(request.payload).toEqual({
    action: "ethereum_provider.request",
    payload: {
      sessionId: "0123456789abcdef0123456789abcdef",
      method: "eth_chainId",
    },
  });
  fakeWindow.dispatch({ type: "response", id: request.id, ok: "0x1" });
  await expect(requesting).resolves.toBe("0x1");

  const closing = connection.close();
  const end = fakeWindow.parent.messages[2]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(end.payload).toEqual({
    action: "ethereum_provider.end",
    payload: { sessionId: "0123456789abcdef0123456789abcdef" },
  });
  fakeWindow.dispatch({ type: "response", id: end.id, ok: null });
  await closing;
  await expect(
    connection.provider.request({ method: "eth_chainId" }),
  ).rejects.toThrow("session is closed");
});

test("clipboard helper uses the private endpoint-bound action", async () => {
  const fakeWindow = installFakeWindow();
  const pending = copyToClipboard("Neutron", 0.2);
  const request = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };

  expect(request.payload).toEqual({
    action: "clipboard.write_text",
    payload: { text: "Neutron" },
  });
  fakeWindow.dispatch({ type: "response", id: request.id, ok: null });
  await expect(pending).resolves.toBeUndefined();
});

test("tray helpers use bounded private endpoint actions", async () => {
  const fakeWindow = installFakeWindow();
  const setting = setTrayState({ badge: 4 }, 0.2);
  const setRequest = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };

  expect(setRequest.payload).toEqual({
    action: "tray.set_state",
    payload: { badge: 4 },
  });
  fakeWindow.dispatch({ type: "response", id: setRequest.id, ok: null });
  await expect(setting).resolves.toBeUndefined();

  const clearing = setTrayState({ badge: null }, 0.2);
  const clearRequest = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(clearRequest.payload).toEqual({
    action: "tray.set_state",
    payload: { badge: null },
  });
  fakeWindow.dispatch({ type: "response", id: clearRequest.id, ok: null });
  await expect(clearing).resolves.toBeUndefined();

  const dismissing = dismissTray(0.2);
  const dismissRequest = fakeWindow.parent.messages[2]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(dismissRequest.payload).toEqual({
    action: "tray.dismiss",
    payload: {},
  });
  fakeWindow.dispatch({ type: "response", id: dismissRequest.id, ok: null });
  await expect(dismissing).resolves.toBeUndefined();
});

test("tray state helper rejects invalid or extensible decorations", async () => {
  installFakeWindow();
  for (const state of [
    { badge: -1 },
    { badge: 10_000 },
    { badge: 1.5 },
    { badge: Number.NaN },
    { badge: 4, html: "<b>4</b>" },
    Object.assign([], { badge: 4 }),
    {},
  ]) {
    await expect(setTrayState(state as any, 0.2)).rejects.toThrow(
      "Invalid tray badge",
    );
  }
});

test("vetKeys SDK keeps lifecycle and public operations source-bound", async () => {
  const fakeWindow = installFakeWindow();
  const lifecycle = requestVetKeys(
    { action: "retireGeneration", slot: "mailbox", generation: 2n },
    0.2,
  );
  const lifecycleRequest = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(lifecycleRequest.payload).toEqual({
    action: "vetkeys.request",
    payload: {
      action: "retireGeneration",
      slot: "mailbox",
      generation: "2",
    },
  });
  expect(JSON.stringify(lifecycleRequest.payload)).not.toContain("appId");
  fakeWindow.dispatch({
    type: "response",
    id: lifecycleRequest.id,
    ok: { slot: vetKeySlotSummary(), retired: false },
  });
  await expect(lifecycle).resolves.toEqual({
    slot: vetKeySlotSummary(),
    retired: false,
  });

  const listing = listVetKeys(0.2);
  const listRequest = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(listRequest.payload).toEqual({
    action: "vetkeys.list",
    payload: {},
  });
  fakeWindow.dispatch({
    type: "response",
    id: listRequest.id,
    ok: { slots: [vetKeySlotSummary()] },
  });
  await expect(listing).resolves.toEqual({ slots: [vetKeySlotSummary()] });

  const publicKey = getVetKeyPublicKey(
    { slot: "mailbox", generation: "1" },
    0.2,
  );
  const publicRequest = fakeWindow.parent.messages[2]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(publicRequest.payload).toEqual({
    action: "vetkeys.publicKey",
    payload: { slot: "mailbox", generation: "1" },
  });
  fakeWindow.dispatch({
    type: "response",
    id: publicRequest.id,
    ok: vetKeyPublicInfo(),
  });
  await expect(publicKey).resolves.toEqual(vetKeyPublicInfo());
});

test("vetKeys derive uses one progress challenge and exact requester result", async () => {
  const fakeWindow = installFakeWindow();
  const challenges: unknown[] = [];
  const deriving = deriveVetKey(
    {
      slot: "mailbox",
      generation: 1n,
      transportPublicKey: new Uint8Array(48).fill(7),
      requestNonce: new Uint8Array(32).fill(9),
    },
    {
      timeout: 0.2,
      onChallenge(challenge) {
        challenges.push(challenge);
      },
    },
  );
  const begin = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: { action: string; payload: any };
  };
  expect(begin.payload.action).toBe("vetkeys.derive.begin");
  expect(begin.payload.payload).toEqual({
    slot: "mailbox",
    generation: "1",
    transportPublicKey: new Array(48).fill(7),
    requestNonce: new Array(32).fill(9),
  });
  expect(begin.payload.payload.appId).toBeUndefined();

  const challenge = {
    type: "challenge",
    challengeId: "challenge_0123456789abcdef",
    expiresAt: "18446744073709551615",
  };
  fakeWindow.dispatch({
    type: "progress",
    id: begin.id,
    value: challenge,
  });
  expect(challenges).toEqual([challenge]);

  const final = {
    encryptedKey: new Array(192).fill(11),
    publicInfo: vetKeyPublicInfo(),
  };
  fakeWindow.dispatch({ type: "response", id: begin.id, ok: final });
  await expect(deriving).resolves.toEqual(final);

  const approving = approveVetKeyDerivation(
    { challengeId: challenge.challengeId },
    0.2,
  );
  const approval = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: { action: string; payload: unknown };
  };
  expect(approval.payload).toEqual({
    action: "vetkeys.derive.approve",
    payload: { challengeId: challenge.challengeId },
  });
  fakeWindow.dispatch({
    type: "response",
    id: approval.id,
    ok: { approved: true },
  });
  await expect(approving).resolves.toBeUndefined();
});

test("vetKeys SDK rejects caller authority fields and malformed crypto sizes", async () => {
  installFakeWindow();
  await expect(
    requestVetKeys({
      action: "reserve",
      slot: "mailbox",
      appId: "other",
    } as any),
  ).rejects.toThrow("Invalid vetKeys lifecycle request");
  await expect(
    getVetKeyPublicKey({
      slot: "mailbox",
      generation: "1",
      keyName: "test_key_1",
    } as any),
  ).rejects.toThrow("Invalid vetKeys public-key request");
  await expect(
    deriveVetKey(
      {
        slot: "mailbox",
        generation: "1",
        transportPublicKey: new Uint8Array(47),
        requestNonce: new Uint8Array(32),
      },
      { onChallenge() {} },
    ),
  ).rejects.toThrow("Invalid vetKeys transport public key");
  await expect(
    requestVetKeys({
      action: "transfer",
      slot: "mailbox",
      newHolder: "2vxsx-fae",
    }),
  ).rejects.toThrow("Invalid vetKeys new holder");
});

test("vetKeys closed errors reject removed rate-limit details", () => {
  const error = toError({
    code: "busy",
    message: "Try again later",
    retryAfterSeconds: "42",
  });
  expect(isVetKeysError(error)).toBe(false);
  expect(isVetKeysError(toError({ code: "busy", message: "Try again" }))).toBe(
    true,
  );
  expect(
    isVetKeysError(
      toError({
        code: "raw_management_reject",
        retryAfterSeconds: "42",
      }),
    ),
  ).toBe(false);
});

test("app tile helper requests reuse and receives the navigation result", async () => {
  const fakeWindow = installFakeWindow();
  const pending = openAppTile(
    {
      appId: "contacts",
      tileId: "contacts",
      reuseExisting: true,
      view: "create",
    },
    0.2,
  );
  const request = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: unknown;
  };

  expect(request).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "workspace.open_tile",
        arguments: {
          appId: "contacts",
          tileId: "contacts",
          reuseExisting: true,
          view: "create",
        },
      },
    },
  });

  fakeWindow.dispatch({
    type: "response",
    id: request.id,
    ok: { instanceId: "contacts-1", workspace: 2, opened: false },
  });
  await expect(pending).resolves.toEqual({
    instanceId: "contacts-1",
    workspace: 2,
    opened: false,
  });
});

test("app install offer helper uses the discoverable kernel tool", async () => {
  const fakeWindow = installFakeWindow();

  const packagePending = offerAppInstall(
    {
      kind: "package_url",
      url: "https://apps.example/mail.neutron",
    },
    0.2,
  );
  const packageRequest = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: unknown;
  };
  expect(packageRequest).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "apps.install_offer",
        arguments: {
          kind: "package_url",
          url: "https://apps.example/mail.neutron",
        },
      },
    },
  });
  fakeWindow.dispatch({
    type: "response",
    id: packageRequest.id,
    ok: { presented: true, requestId: "offer-package" },
  });
  await expect(packagePending).resolves.toEqual({
    presented: true,
    requestId: "offer-package",
  });

  const repositoryPending = offerAppInstall(
    {
      kind: "repository_setup_url",
      url: "https://neutron.example/#repo=aaaaa-aa&manifest=starter&digest=abc",
    },
    0.2,
  );
  const repositoryRequest = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: unknown;
  };
  expect(repositoryRequest).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "apps.install_offer",
        arguments: {
          kind: "repository_setup_url",
          url: "https://neutron.example/#repo=aaaaa-aa&manifest=starter&digest=abc",
        },
      },
    },
  });
  fakeWindow.dispatch({
    type: "response",
    id: repositoryRequest.id,
    ok: { presented: true, requestId: "offer-repository" },
  });
  await expect(repositoryPending).resolves.toEqual({
    presented: true,
    requestId: "offer-repository",
  });
});

test("tile view requests are accepted only from the kernel peer", async () => {
  const fakeWindow = installFakeWindow();
  const views: string[] = [];
  const stop = onTileViewRequest((view) => views.push(view));

  fakeWindow.dispatch({
    type: "neutron:tile:view",
    version: 1,
    view: "create",
  });
  fakeWindow.dispatch(
    { type: "neutron:tile:view", version: 1, view: "delete" },
    createFakeSource(),
  );
  await nextTick();

  expect(views).toEqual(["create"]);
  stop();
});

test("canister client requests kernel-derived schemas and approved calls", async () => {
  const fakeWindow = installFakeWindow();
  const client = createCanisterClient("aaaaa-aa");

  const schemaPending = client.methodSchema("hello_world", 0.2);
  const discovery = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: unknown;
  };
  expect(discovery).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.list",
      payload: { target: "kernel" },
    },
  });
  replyWithKernelTools(fakeWindow, discovery.id, [
    "canister.schema",
    "canister.schema_v2",
    "canister.call_dialog",
    "canister.call_dialog_v2",
  ]);
  await nextTick();

  const schemaRequest = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: unknown;
  };

  expect(schemaRequest).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "canister.schema_v2",
        arguments: {
          canister: "aaaaa-aa",
          method: "hello_world",
        },
      },
    },
  });

  fakeWindow.dispatch({
    type: "response",
    id: schemaRequest.id,
    ok: {
      input: { type: "array", prefixItems: [{ type: "string" }] },
      output: { type: "string" },
    },
  });
  await expect(schemaPending).resolves.toMatchObject({
    input: { type: "array" },
    output: { type: "string" },
  });

  const callPending = client.callDialog("hello_world", ["John"], 0.2);
  await nextTick();
  const callRequest = fakeWindow.parent.messages[2]?.message as {
    id: number;
    payload: unknown;
  };

  expect(callRequest).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "canister.call_dialog_v2",
        arguments: {
          canister: "aaaaa-aa",
          method: "hello_world",
          args: ["John"],
        },
      },
    },
  });

  fakeWindow.dispatch({ type: "response", id: callRequest.id, ok: "Neutron" });
  await expect(callPending).resolves.toBe("Neutron");
});

test("ordinary schema discovery retains the released Kernel route", async () => {
  const fakeWindow = installFakeWindow();
  const client = createCanisterClient("aaaaa-aa");
  const pending = client.methodSchema("hello_world", 0.2);
  const discovery = fakeWindow.parent.messages[0]?.message as { id: number };
  replyWithKernelTools(fakeWindow, discovery.id, [
    "canister.schema",
    "canister.call_dialog",
  ]);
  await nextTick();

  const request = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: unknown;
  };
  expect(request).toMatchObject({
    type: "exec",
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "canister.schema",
        arguments: {
          canister: "aaaaa-aa",
          method: "hello_world",
        },
      },
    },
  });
  fakeWindow.dispatch({
    type: "response",
    id: request.id,
    ok: { input: { type: "array" }, output: { type: "string" } },
  });
  await expect(pending).resolves.toMatchObject({
    input: { type: "array" },
    output: { type: "string" },
  });
});

test("typed canister helpers use bounded discovery and call defaults", async () => {
  const fakeWindow = installFakeWindow();
  const scheduledDelays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    scheduledDelays.push(timeout ?? 0);
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  try {
    const client = createCanisterClient("aaaaa-aa");
    const schemaPending = client.methodSchema("hello_world");
    const discovery = fakeWindow.parent.messages[0]?.message as {
      id: number;
    };
    replyWithKernelTools(fakeWindow, discovery.id, [
      "canister.schema_v2",
      "canister.call_dialog_v2",
    ]);
    await nextTick();
    const schemaRequest = fakeWindow.parent.messages[1]?.message as {
      id: number;
    };
    fakeWindow.dispatch({
      type: "response",
      id: schemaRequest.id,
      ok: { input: {}, output: {} },
    });
    await schemaPending;

    const callPending = client.callDialog("hello_world", ["John"]);
    await nextTick();
    const callRequest = fakeWindow.parent.messages[2]?.message as {
      id: number;
    };
    fakeWindow.dispatch({
      type: "response",
      id: callRequest.id,
      ok: "Neutron",
    });
    await callPending;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  expect(scheduledDelays).toContain(
    MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS * 1_000,
  );
  expect(scheduledDelays).toContain(
    MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS * 1_000,
  );
});

test("canister client rejects malformed ids and schemas", async () => {
  expect(() => createCanisterClient("bad canister")).toThrow(
    "Invalid canister id",
  );

  const fakeWindow = installFakeWindow();
  const client = createCanisterClient("aaaaa-aa");
  const pending = client.methodSchema("hello_world");
  const discovery = fakeWindow.parent.messages[0]?.message as { id: number };
  replyWithKernelTools(fakeWindow, discovery.id, ["canister.schema_v2"]);
  await nextTick();
  const request = fakeWindow.parent.messages[1]?.message as { id: number };

  fakeWindow.dispatch({
    type: "response",
    id: request.id,
    ok: { input: { type: "array" } },
  });

  await expect(pending).rejects.toThrow("Invalid method schema");
});

test("loadNeutronCanisterId validates the package id response", async () => {
  const fetcher: JsonFetcher = async () =>
    new Response(JSON.stringify({ id: "aaaaa-aa" }), { status: 200 });

  await expect(loadNeutronCanisterId("/pkg/id.json", fetcher)).resolves.toBe(
    "aaaaa-aa",
  );

  const badFetcher: JsonFetcher = async () =>
    new Response(JSON.stringify({ id: "bad canister" }), { status: 200 });

  await expect(
    loadNeutronCanisterId("/pkg/id.json", badFetcher),
  ).rejects.toThrow("Invalid canister id");

  const missingFetcher: JsonFetcher = async () =>
    new Response(JSON.stringify({}), { status: 200 });

  await expect(
    loadNeutronCanisterId("/pkg/id.json", missingFetcher),
  ).rejects.toThrow("Invalid Neutron canister id response");

  const nonPrincipalFetcher: JsonFetcher = async () =>
    new Response(JSON.stringify({ id: "abc" }), { status: 200 });
  await expect(
    loadNeutronCanisterId("/pkg/id.json", nonPrincipalFetcher),
  ).rejects.toThrow("Invalid canister id");
});

test("loadNeutronCanisterId reads dedicated app hostnames without fetching", async () => {
  let fetched = false;
  const fetcher: JsonFetcher = async () => {
    fetched = true;
    return new Response(null, { status: 500 });
  };

  await expect(
    loadNeutronCanisterId(
      "/pkg/id.json",
      fetcher,
      "https://ahelloa--4caro-hl777-77775-aaaba-cai.icp0.io/app/hello/index.html",
    ),
  ).resolves.toBe("4caro-hl777-77775-aaaba-cai");
  expect(fetched).toBe(false);
});

test("a validated proxy-host Neutron id keeps its client on the private self-call wire", async () => {
  const fakeWindow = installFakeWindow();
  fakeWindow.location.href = "https://apps.example/app/hello/index.html";
  const fetcher: JsonFetcher = async () =>
    new Response(JSON.stringify({ id: fakeCanisterId }), { status: 200 });
  const canister = await loadNeutronCanisterId(
    "/pkg/id.json",
    fetcher,
    fakeWindow.location.href,
  );
  const channel = new MessageChannel();
  let request: Record<string, unknown> | null = null;
  channel.port2.addEventListener("message", (event) => {
    request = event.data as Record<string, unknown>;
    channel.port2.postMessage({
      type: "neutron:self-call:response",
      version: 1,
      id: request.id,
      ok: "proxy self reply",
      blobs: [],
    });
  });
  channel.port2.start();
  fakeWindow.dispatch(
    {
      type: "neutron:msgbus:connect",
      version: 1,
      sessionId: "0123456789abcdef0123456789abcdef",
    },
    fakeWindow.parent,
    fakeKernelOrigin,
    [channel.port1],
  );

  const client = createCanisterClient(canister);
  await expect(client.callDialog("hello_world", ["John"], 0.2)).resolves.toBe(
    "proxy self reply",
  );
  expect(request).toMatchObject({
    type: "neutron:self-call:exec",
    version: 1,
    tool: "canister.call_dialog",
    method: "hello_world",
  });
  channel.port2.close();
});

test("overlapping request timeouts clean up the captured request id", async () => {
  const fakeWindow = installFakeWindow();
  const first = exec("first", null, 0.01);
  const second = exec("second", null, 0.2);
  const firstRequest = fakeWindow.parent.messages[0]?.message as { id: number };
  const secondRequest = fakeWindow.parent.messages[1]?.message as {
    id: number;
  };

  await expect(first).rejects.toThrow("Timeout after 0.01 seconds");
  expect(fakeWindow.parent.messages[2]?.message).toEqual({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: firstRequest.id,
  });

  fakeWindow.dispatch({ type: "response", id: secondRequest.id, ok: "second" });
  await expect(second).resolves.toBe("second");
});

test("an AbortSignal cancels the exact in-flight peer request", async () => {
  const fakeWindow = installFakeWindow();
  const controller = new AbortController();
  const pending = exec("blocked", null, {
    timeout: 0.2,
    signal: controller.signal,
  });
  const request = fakeWindow.parent.messages[0]?.message as { id: number };

  controller.abort(new Error("Stopped by caller"));

  await expect(pending).rejects.toThrow("Stopped by caller");
  expect(fakeWindow.parent.messages[1]?.message).toEqual({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: request.id,
  });
});

test("signed canister call cancellation preserves the Kernel outcome", async () => {
  for (const name of [
    "canister.call_dialog_v2",
    "canister.call_dialog",
  ] as const) {
    const fakeWindow = installFakeWindow();
    const call: MsgBusToolCall = {
      target: "kernel",
      name,
      arguments: {
        canister: "aaaaa-aa",
        method: "store",
        args: ["value"],
      },
    };
    const controller = new AbortController();
    const aborted = callTool(call, {
      timeout: 0.2,
      signal: controller.signal,
    });
    const abortRequest = fakeWindow.parent.messages[0]?.message as {
      id: number;
    };
    let abortSettled = false;
    void aborted.then(
      () => {
        abortSettled = true;
      },
      () => {
        abortSettled = true;
      },
    );

    controller.abort(new Error("Stopped by caller"));
    await nextTick();
    expect(abortSettled).toBe(false);
    expect(fakeWindow.parent.messages[1]?.message).toEqual({
      type: "neutron:msgbus:cancel",
      version: 1,
      id: abortRequest.id,
    });
    fakeWindow.dispatch({
      type: "response",
      id: abortRequest.id,
      error: {
        name: "KernelPolicyError",
        code: "REQUEST_CANCELLED",
        message:
          "Canister call authority changed after dispatch; the outcome is unknown and the reply was withheld",
      },
    });
    await expect(aborted).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
      message: expect.stringContaining("outcome is unknown"),
    });

    const timedOut = callTool(call, 0.01);
    const timeoutRequest = fakeWindow.parent.messages[2]?.message as {
      id: number;
    };
    let timeoutSettled = false;
    void timedOut.then(
      () => {
        timeoutSettled = true;
      },
      () => {
        timeoutSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timeoutSettled).toBe(false);
    expect(fakeWindow.parent.messages[3]?.message).toEqual({
      type: "neutron:msgbus:cancel",
      version: 1,
      id: timeoutRequest.id,
    });
    fakeWindow.dispatch({
      type: "response",
      id: timeoutRequest.id,
      error: {
        name: "KernelPolicyError",
        code: "REQUEST_CANCELLED",
        message:
          "Canister call authority changed after dispatch; the outcome is unknown and the reply was withheld",
      },
    });
    await expect(timedOut).rejects.toMatchObject({
      code: "REQUEST_CANCELLED",
      message: expect.stringContaining("outcome is unknown"),
    });
    disconnectMsgBus();
  }
});

test("disconnect cancels every outstanding Kernel request", async () => {
  const fakeWindow = installFakeWindow();
  const schemaPending = callTool(
    {
      target: "kernel",
      name: "canister.schema_v2",
      arguments: { canister: "aaaaa-aa", method: "store" },
    },
    0,
  );
  const callPending = callTool(
    {
      target: "kernel",
      name: "canister.call_dialog_v2",
      arguments: { canister: "aaaaa-aa", method: "store", args: ["value"] },
    },
    0,
  );
  const legacyCallPending = callTool(
    {
      target: "kernel",
      name: "canister.call_dialog",
      arguments: { canister: "aaaaa-aa", method: "store", args: ["value"] },
    },
    0,
  );
  const selfUpdatePending = updateSelf("save_fixture", [], 0);
  const schemaRequest = fakeWindow.parent.messages[0]?.message as {
    id: number;
  };
  const callRequest = fakeWindow.parent.messages[1]?.message as { id: number };
  const legacyCallRequest = fakeWindow.parent.messages[2]?.message as {
    id: number;
  };
  const selfUpdateRequest = fakeWindow.parent.messages[3]?.message as {
    id: number;
  };
  void schemaPending.catch(() => undefined);
  void callPending.catch(() => undefined);
  void legacyCallPending.catch(() => undefined);
  void selfUpdatePending.catch(() => undefined);

  disconnectMsgBus();

  expect(
    fakeWindow.parent.messages.slice(4).map(({ message }) => message),
  ).toEqual([
    { type: "neutron:msgbus:cancel", version: 1, id: schemaRequest.id },
    { type: "neutron:msgbus:cancel", version: 1, id: callRequest.id },
    { type: "neutron:msgbus:cancel", version: 1, id: legacyCallRequest.id },
    {
      type: "neutron:msgbus:cancel",
      version: 1,
      id: selfUpdateRequest.id,
    },
  ]);
  await expect(schemaPending).rejects.toThrow("Message bus disconnected");
  await expect(callPending).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
    message: expect.stringContaining("outcome is unknown"),
  });
  await expect(legacyCallPending).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
    message: expect.stringContaining("outcome is unknown"),
  });
  await expect(selfUpdatePending).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
    message: expect.stringContaining("outcome is unknown"),
  });
});

test("an abort observed while registering never posts the request", async () => {
  const fakeWindow = installFakeWindow();
  const reason = new Error("Registration-race abort");
  let reads = 0;
  const signal = {
    get aborted() {
      reads += 1;
      return reads >= 2;
    },
    get reason() {
      return reason;
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;

  await expect(
    exec("must_not_post", null, { timeout: 0.2, signal }),
  ).rejects.toThrow("Registration-race abort");
  expect(fakeWindow.parent.messages).toEqual([]);
});

test("cancelling an exposed request aborts its scoped nested kernel call", async () => {
  const fakeWindow = installFakeWindow();
  let handlerSignalAborted = false;
  exposeTool(
    "nested_cancel_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async (_args, context) => {
      context.signal?.addEventListener("abort", () => {
        handlerSignalAborted = true;
      });
      await context.kernel.callTool({
        target: "kernel",
        name: "apps.list",
        arguments: {},
      });
      return {};
    },
  );
  const invocation = {
    id: "1111111111111111",
    rootId: "2222222222222222",
    capability: "3".repeat(64),
  };
  fakeWindow.dispatch({
    type: "exec",
    id: 301,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "nested_cancel_fixture", arguments: {} },
      context: { invocation },
    },
  });
  await nextTick();
  const nested = fakeWindow.parent.messages.find(
    ({ message }) =>
      (message as { type?: unknown }).type === "exec" &&
      (message as { id?: unknown }).id !== 301,
  )?.message as { id: number } | undefined;
  if (!nested) throw new Error("Missing nested request");

  fakeWindow.dispatch({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 301,
  });
  await nextTick();

  expect(handlerSignalAborted).toBe(true);
  expect(
    fakeWindow.parent.messages.some(
      ({ message }) =>
        isRequestCancelEnvelope(message) && message.id === nested.id,
    ),
  ).toBe(true);
  removeExposedTool("nested_cancel_fixture");
});

test("cancelling an exposed request fences its scoped self update", async () => {
  const fakeWindow = installFakeWindow();
  exposeTool(
    "nested_self_cancel_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async (_args, context) => {
      await context.kernel.updateSelf("save_fixture", [], 0.2);
      return {};
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 302,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "nested_self_cancel_fixture", arguments: {} },
    },
  });
  await nextTick();
  const nested = fakeWindow.parent.messages.find(
    ({ message }) =>
      (message as { type?: unknown }).type === "neutron:self-call:exec",
  )?.message as { id: number } | undefined;
  if (!nested) throw new Error("Missing nested self-call request");

  fakeWindow.dispatch({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 302,
  });
  await nextTick();

  expect(
    fakeWindow.parent.messages.some(
      ({ message }) =>
        isRequestCancelEnvelope(message) && message.id === nested.id,
    ),
  ).toBe(true);
  expect(
    fakeWindow.parent.messages.some(
      ({ message }) =>
        (message as { type?: unknown; id?: unknown }).type === "response" &&
        (message as { id?: unknown }).id === 302,
    ),
  ).toBe(false);

  fakeWindow.dispatch({
    type: "neutron:self-call:response",
    version: 1,
    id: nested.id,
    error: {
      name: "KernelPolicyError",
      code: "REQUEST_CANCELLED",
      message:
        "Canister call authority changed after dispatch; the outcome is unknown and the reply was withheld",
    },
  });
  await nextTick();

  expect(
    fakeWindow.parent.messages.find(
      ({ message }) =>
        (message as { type?: unknown; id?: unknown }).type === "response" &&
        (message as { id?: unknown }).id === 302,
    )?.message,
  ).toMatchObject({
    error: {
      code: "REQUEST_CANCELLED",
      message: expect.stringContaining("outcome is unknown"),
    },
  });
  removeExposedTool("nested_self_cancel_fixture");
});

test("an exposed handler cannot use the unscoped self-call dialog", async () => {
  const fakeWindow = installFakeWindow();
  exposeTool(
    "unscoped_dialog_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async () => {
      await callCanisterDialog({
        canister: fakeCanisterId,
        method: "save_fixture",
        args: [],
      });
      return {};
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 303,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "unscoped_dialog_fixture", arguments: {} },
      context: {
        invocation: {
          id: "5111111111111111",
          rootId: "5222222222222222",
          capability: "6".repeat(64),
        },
      },
    },
  });
  await nextTick();

  expect(fakeWindow.parent.messages).toHaveLength(1);
  expect(fakeWindow.parent.messages[0]?.message).toMatchObject({
    type: "response",
    id: 303,
    error: {
      name: "KernelPolicyError",
      code: "SCOPED_CONTEXT_REQUIRED",
      message: "Nested app calls must use context.kernel",
    },
  });
  removeExposedTool("unscoped_dialog_fixture");
});

test("the direct self-call dialog also rejects an unscoped invocation", async () => {
  const fakeWindow = installFakeWindow();
  exposeTool(
    "direct_unscoped_dialog_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async () => {
      await callSelfDialog("save_fixture", []);
      return {};
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 306,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "direct_unscoped_dialog_fixture", arguments: {} },
      context: {
        invocation: {
          id: "8111111111111111",
          rootId: "8222222222222222",
          capability: "9".repeat(64),
        },
      },
    },
  });
  await nextTick();

  expect(fakeWindow.parent.messages).toHaveLength(1);
  expect(fakeWindow.parent.messages[0]?.message).toMatchObject({
    type: "response",
    id: 306,
    error: {
      name: "KernelPolicyError",
      code: "SCOPED_CONTEXT_REQUIRED",
      message: "Nested app calls must use context.kernel",
    },
  });
  removeExposedTool("direct_unscoped_dialog_fixture");
});

test("an exposed handler never negotiates an unscoped external call down to legacy", async () => {
  const fakeWindow = installFakeWindow();
  exposeTool(
    "unscoped_external_dialog_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async () => {
      await callCanisterDialog({
        canister: "aaaaa-aa",
        method: "save_fixture",
        args: [],
      });
      return {};
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 304,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: {
        name: "unscoped_external_dialog_fixture",
        arguments: {},
      },
      context: {
        invocation: {
          id: "6111111111111111",
          rootId: "6222222222222222",
          capability: "7".repeat(64),
        },
      },
    },
  });
  await nextTick();

  expect(fakeWindow.parent.messages).toHaveLength(1);
  expect(fakeWindow.parent.messages[0]?.message).toMatchObject({
    type: "response",
    id: 304,
    error: { code: "SCOPED_CONTEXT_REQUIRED" },
  });
  removeExposedTool("unscoped_external_dialog_fixture");
});

test("ordinary legacy negotiation rechecks invocation scope before dispatch", async () => {
  const fakeWindow = installFakeWindow();
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  exposeTool(
    "negotiation_scope_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async () => {
      await handlerGate;
      return {};
    },
  );

  const pending = callCanisterDialog(
    { canister: "aaaaa-aa", method: "save_fixture", args: [] },
    0.2,
  );
  const discovery = fakeWindow.parent.messages[0]?.message as { id: number };
  fakeWindow.dispatch({
    type: "exec",
    id: 305,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "negotiation_scope_fixture", arguments: {} },
      context: {
        invocation: {
          id: "7111111111111111",
          rootId: "7222222222222222",
          capability: "8".repeat(64),
        },
      },
    },
  });
  await nextTick();
  replyWithKernelTools(fakeWindow, discovery.id, ["canister.call_dialog"]);

  await expect(pending).rejects.toMatchObject({
    code: "SCOPED_CONTEXT_REQUIRED",
  });
  expect(
    fakeWindow.parent.messages.some(
      ({ message }) =>
        (message as { payload?: { action?: unknown } }).payload?.action ===
        "tools.call",
    ),
  ).toBe(false);

  releaseHandler();
  await nextTick();
  removeExposedTool("negotiation_scope_fixture");
});

test("an already-cancelled exposed request does not post a scoped self call", async () => {
  const fakeWindow = installFakeWindow();
  let continueHandler!: () => void;
  const gate = new Promise<void>((resolve) => {
    continueHandler = resolve;
  });
  exposeTool(
    "nested_self_pre_cancel_fixture",
    {
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", additionalProperties: false },
    },
    async (_args, context) => {
      await gate;
      await context.kernel.updateSelf("must_not_dispatch", [], 0.2);
      return {};
    },
  );
  fakeWindow.dispatch({
    type: "exec",
    id: 303,
    payload: {
      action: msgBusLocalActions.toolsCall,
      payload: { name: "nested_self_pre_cancel_fixture", arguments: {} },
    },
  });
  await nextTick();
  fakeWindow.dispatch({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 303,
  });
  continueHandler();
  await nextTick();

  expect(
    fakeWindow.parent.messages.some(
      ({ message }) =>
        (message as { type?: unknown }).type === "neutron:self-call:exec",
    ),
  ).toBe(false);
  removeExposedTool("nested_self_pre_cancel_fixture");
});
