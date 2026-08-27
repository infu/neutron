import { afterEach, expect, test } from "bun:test";
import { validate as validateJsonSchema } from "jsonschema";
import {
  callTool,
  callCanisterDialog,
  connectEthereumProvider,
  copyToClipboard,
  createCanisterClient,
  deriveVetKey,
  dismissTray,
  disconnectMsgBus,
  exec,
  exposeTool,
  installMessageListener,
  isExecEnvelope,
  isAppStateChangeEnvelope,
  isJsonValue,
  isProgressEnvelope,
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
  type VetKeyPublicInfo,
  type VetKeySlotSummary,
} from "../src/app_entry.ts";
import {
  kernelCallPayloadSchema,
  kernelSchemaPayloadSchema,
} from "../src/protocol.ts";
import {
  executeExposedAction,
  expose,
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
    ports?: MessagePort[]
  ): void;
};

type FakePort = {
  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  start(): void;
};

const originalWindow = globalThis.window;
const fakeCanisterId = "4caro-hl777-77775-aaaba-cai";
const fakeAppHref =
  `https://ahelloa--${fakeCanisterId}.icp0.io/app/hello/index.html`;
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
});

test("exec envelope guard rejects malformed postMessage data", () => {
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call_dialog", payload: { args: [] } },
    })
  ).toBe(true);

  expect(isExecEnvelope(null)).toBe(false);
  expect(isExecEnvelope({ type: "exec", id: 0 })).toBe(false);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "", payload: null },
    })
  ).toBe(false);
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call", payload: { bad: undefined } },
    })
  ).toBe(false);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() =>
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call", payload: cyclic },
    })
  ).not.toThrow();
  expect(
    isExecEnvelope({
      type: "exec",
      id: 1,
      payload: { action: "call", payload: cyclic },
    })
  ).toBe(false);
});

test("response envelope guard requires exactly one json result field", () => {
  expect(isResponseEnvelope({ type: "response", id: 1, ok: null })).toBe(true);
  expect(
    isResponseEnvelope({
      type: "response",
      id: 1,
      error: { message: "no" },
    })
  ).toBe(true);
  expect(isResponseEnvelope({ type: "response", id: 1 })).toBe(false);
  expect(
    isResponseEnvelope({ type: "response", id: 1, ok: null, error: "no" })
  ).toBe(false);
  expect(
    isResponseEnvelope({ type: "response", id: 1, error: new Error("no") })
  ).toBe(false);
});

test("progress envelope guard accepts bounded JSON-shaped events", () => {
  expect(
    isProgressEnvelope({ type: "progress", id: 1, value: { delta: "a" } })
  ).toBe(true);
  expect(isProgressEnvelope({ type: "progress", id: 0, value: null })).toBe(
    false
  );
  expect(
    isProgressEnvelope({ type: "progress", id: 1, value: { bad: undefined } })
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
  fakeWindow.dispatch({ type: "response", id: request.id, ok: { delivered: 2 } });
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
    "Nested failure"
  );
  expect(toError({ code: "unknown" }, "File operation failed").message).toBe(
    "File operation failed"
  );
});

test("variant response errors retain domain details", () => {
  expect(toError({ validation: "Name is required" }).message).toBe(
    "validation: Name is required"
  );
  expect(
    toError({ conflict: { expected: "2", actual: "3" } }).message
  ).toBe("conflict: expected 2, actual 3");
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
    executeExposedAction("validated", { value: 1 }, {
      source: appFrame as unknown as MessageEventSource,
      origin: "https://hello.example",
    }),
  ).toThrow("Invalid payload for action 'validated'");
  expect(
    await executeExposedAction("validated", { value: "ok" }, {
      source: appFrame as unknown as MessageEventSource,
      origin: "https://hello.example",
    }),
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
    (args) => ({ value: Number(args.value) * 2 })
  );

  expect(listExposedTools()).toContainEqual(
    expect.objectContaining({ name: "test_double", title: "Double" })
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
    kernel
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
    kernel
  );
  await nextTick();
  expect(kernel.messages[1]?.message).toEqual({
    type: "response",
    id: 52,
    ok: { value: 8 },
  });
  expect(removeExposedTool("test_double")).toBe(true);
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
        requester: { appId: "wallet", role: "tray" },
        chain: [
          { appId: "agent", tool: "agent_chat" },
          { appId: "wallet", tool: "send" },
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

test("endpoint-local tool actions ignore sibling windows", async () => {
  const fakeWindow = installFakeWindow();
  const sibling = createFakeSource();
  exposeTool(
    "sibling_private",
    { inputSchema: { type: "object", additionalProperties: false } },
    () => ({ exposed: true })
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
    sibling
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
        () => null
      )
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
      () => null
    )
  ).toThrow(/unsafe pattern/);

  expect(() =>
    exposeTool(
      "external_schema",
      {
        inputSchema: { $ref: "https://example.test/schema.json" },
      },
      () => null
    )
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
      () => null
    )
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
    listExposedTools().find(({ name }) => name === "cancel_work")
      ?.annotations,
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
    [channel.port1]
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
  fakeWindow.location.href =
    `https://ahelloa--${fakeCanisterId}.icp0.io/settings`;
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
    [channel.port1]
  );

  await expect(result).resolves.toBe("private-port");
  expect(fakeWindow.parent.messages).toHaveLength(0);
  channel.port2.close();
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
      kernelSchemaPayloadSchema
    ).valid
  ).toBe(true);
  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world", args: ["John"] },
      kernelCallPayloadSchema
    ).valid
  ).toBe(true);

  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world", args: "John" },
      kernelCallPayloadSchema
    ).valid
  ).toBe(false);
  expect(
    validateJsonSchema({ method: "hello_world" }, kernelCallPayloadSchema).valid
  ).toBe(false);
  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world", did: "service : {}" },
      kernelCallPayloadSchema
    ).valid
  ).toBe(false);
  expect(
    validateJsonSchema(
      { canister: "bad canister", method: "hello_world" },
      kernelCallPayloadSchema
    ).valid
  ).toBe(false);
  expect(
    validateJsonSchema(
      { canister: "aaaaa-aa", method: "hello_world", extra: true },
      kernelCallPayloadSchema
    ).valid
  ).toBe(false);
});

test("responses from unexpected sources are ignored", async () => {
  const fakeWindow = installFakeWindow();
  const wrongSource = createFakeSource();
  const pending = exec("call", null);
  const request = fakeWindow.parent.messages[0]?.message as { id: number };

  fakeWindow.dispatch({ type: "response", id: request.id, ok: "wrong" }, wrongSource);
  await expect(
    Promise.race([pending, nextTick().then(() => "still pending")])
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
    wrongSource
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

test("typed call dialog helper uses the unified kernel tool bus", async () => {
  const fakeWindow = installFakeWindow();
  const pending = callCanisterDialog(
    {
      canister: "aaaaa-aa",
      method: "hello_world",
      args: ["John"],
    },
    0.2
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
        name: "canister.call_dialog",
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
      ok:
        request.tool === "canister.query_self"
          ? "profile"
          : "fresh",
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
    requestVetKeys({ action: "reserve", slot: "mailbox", appId: "other" } as any),
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
  const schemaRequest = fakeWindow.parent.messages[0]?.message as {
    id: number;
    payload: unknown;
  };

  expect(schemaRequest).toMatchObject({
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
  const callRequest = fakeWindow.parent.messages[1]?.message as {
    id: number;
    payload: unknown;
  };

  expect(callRequest).toMatchObject({
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

  fakeWindow.dispatch({ type: "response", id: callRequest.id, ok: "Neutron" });
  await expect(callPending).resolves.toBe("Neutron");
});

test("canister client rejects malformed ids and schemas", async () => {
  expect(() => createCanisterClient("bad canister")).toThrow(
    "Invalid canister id"
  );

  const fakeWindow = installFakeWindow();
  const client = createCanisterClient("aaaaa-aa");
  const pending = client.methodSchema("hello_world");
  const request = fakeWindow.parent.messages[0]?.message as { id: number };

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
    "aaaaa-aa"
  );

  const badFetcher: JsonFetcher = async () =>
    new Response(JSON.stringify({ id: "bad canister" }), { status: 200 });

  await expect(
    loadNeutronCanisterId("/pkg/id.json", badFetcher)
  ).rejects.toThrow("Invalid canister id");

  const missingFetcher: JsonFetcher = async () =>
    new Response(JSON.stringify({}), { status: 200 });

  await expect(
    loadNeutronCanisterId("/pkg/id.json", missingFetcher)
  ).rejects.toThrow("Invalid Neutron canister id response");
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
      "https://ahelloa--4caro-hl777-77775-aaaba-cai.icp0.io/app/hello/index.html"
    )
  ).resolves.toBe("4caro-hl777-77775-aaaba-cai");
  expect(fetched).toBe(false);
});

test("overlapping request timeouts clean up the captured request id", async () => {
  const fakeWindow = installFakeWindow();
  const first = exec("first", null, 0.01);
  const second = exec("second", null, 0.2);
  const secondRequest = fakeWindow.parent.messages[1]?.message as { id: number };

  await expect(first).rejects.toThrow("Timeout after 0.01 seconds");

  fakeWindow.dispatch({ type: "response", id: secondRequest.id, ok: "second" });
  await expect(second).resolves.toBe("second");
});
