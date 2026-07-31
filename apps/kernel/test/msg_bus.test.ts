import { afterEach, expect, mock, test } from "bun:test";
import { QueryResponseStatus, type Agent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import {
  isJsonObject,
  msgBusLocalActions,
  type ExecEnvelope,
  type JsonValue,
  type MsgBusToolDescriptor,
} from "neutron-tools/protocol";
import { executeExposedAction } from "neutron-tools/kernel";
import { disconnectMsgBus } from "neutron-tools/app";
import {
  connectFrameEndpoint,
  getRegisteredEndpoint,
  registerFrameContext,
} from "../src/frame_context.ts";
import type {
  AttachmentExecEnvelope,
  AttachmentResponseEnvelope,
} from "../src/attachment_bus.ts";
import { acquireAttachmentCapacity } from "../src/attachment_bus.ts";
import {
  clearFrontendToolSessionGrants,
  clearMsgBusAudit,
  grantFrontendToolSession,
  hasFrontendToolGrant,
  approveFrontendToolRequest,
  rejectFrontendToolRequest,
  requestFrontendToolPermission,
  removeFrontendAppState,
  recordMsgBusAudit,
  listMsgBusAudit,
  useMsgBusPermissionStore,
} from "../src/reducer/msg_bus.ts";
import {
  callApprove,
  removeAllCallRequests,
  useRequestStore,
} from "../src/reducer/request.ts";
import { resetUiAttentionState } from "../src/ui_attention/owner.ts";
import {
  approveInstallOffer,
  clearInstallOffer,
  rejectInstallOffer,
} from "../src/install_offers/service.ts";
import { useInstallOfferStore } from "../src/install_offers/store.ts";
import {
  approveAgentGrant,
  beginAgentRoot,
  clearAgentModeForAuth,
  completeInvocation,
  invocationMetadata,
  requestAgentGrant,
  resolveInvocation,
} from "../src/ui_attention/agent.ts";
import { registryApp } from "./app_registry_fixture.ts";

let validateMethodInputOverride:
  | ((
      target: unknown,
      method: string,
      args: unknown[],
    ) => { ok: boolean; errors?: unknown })
  | undefined;

const mockIcblast = Object.assign(
  () => async () => ({}),
  {
    explainMethodSchema: () => ({}),
    toState: (value: unknown) => value,
    validateMethodInput: (
      target: unknown,
      method: string,
      args: unknown[],
    ) =>
      validateMethodInputOverride?.(target, method, args) ?? { ok: true },
  },
);
mock.module("icblast", () => ({
  default: mockIcblast,
  InternetIdentity: {
    create: async () => undefined,
    getIdentity: () => ({
      getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    }),
    getPrincipal: () => ({ toText: () => "2vxsx-fae" }),
    isAuthenticated: async () => false,
    login: async () => undefined,
    logout: async () => undefined,
  },
}));

let selfCallTarget: any;
let selfCallAgent: Agent | undefined;
let submitSelfCallUpdate:
  | ((
      agent: Agent,
      canisterId: string,
      methodName: string,
      arg: Uint8Array,
    ) => Promise<Uint8Array>)
  | undefined;
mock.module("../src/self_call_transport.ts", () => ({
  getSelfCallTarget: async () => {
    if (!selfCallTarget) {
      throw new Error("Self-call transport target was not installed");
    }
    return selfCallTarget;
  },
  getSelfCallAgent: async () => {
    if (!selfCallAgent) {
      throw new Error("Self-call transport agent was not installed");
    }
    return selfCallAgent;
  },
  submitRawSelfUpdate: async (
    agent: Agent,
    canisterId: string,
    methodName: string,
    arg: Uint8Array,
  ) => {
    if (!submitSelfCallUpdate) {
      throw new Error("Self-call update transport was not installed");
    }
    return submitSelfCallUpdate(
      agent,
      canisterId,
      methodName,
      arg,
    );
  },
}));

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: {
      href: "http://4caro-hl777-77775-aaaba-cai.localhost:8000/",
    },
    parent: {},
    addEventListener() {},
  },
});

const { loadIcRuntimeFixture, TEST_KERNEL_CANISTER_ID } = await import(
  "./runtime_fixture.ts"
);
await loadIcRuntimeFixture();

const [
  {
    backendAccessAgentAction,
    listTargetTools,
    routeAttachmentToolCall,
    routeToolCall,
  },
  { useAppsStore },
  { useWorkspaceStore, workspaceIds },
  { useAuthStore },
] = await Promise.all([
  import("../src/expose.ts"),
  import("../src/reducer/apps.ts"),
  import("../src/workspace/store.ts"),
  import("../src/reducer/auth.ts"),
]);

type FakeWindow = {
  parent: object;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  dispatch(data: unknown, source: object, origin?: string): void;
};

const unregisters: Array<() => void> = [];

test("app uninstall clears grants, pending requests, and audit entries", async () => {
  const caller = {
    appId: "hello",
    endpoint: "app:hello:tile:main:instance:test",
    role: "tile" as const,
  };
  const target = "app:files:background";
  grantFrontendToolSession("hello", target, "read");
  recordMsgBusAudit({
    caller,
    target,
    tool: "read",
    status: "ok",
    durationMs: 1,
    arguments: {},
  });
  const pending = requestFrontendToolPermission({
    caller,
    target,
    tool: "write",
  });

  removeFrontendAppState("files");

  expect(
    hasFrontendToolGrant(caller, undefined, target, undefined, "read"),
  ).toBe(false);
  expect(listMsgBusAudit()).toEqual([]);
  await expect(pending).rejects.toThrow(/was uninstalled/);
});

function installFakeWindow(): FakeWindow {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const fakeWindow: FakeWindow = {
    parent: {},
    addEventListener(type, listener) {
      if (type === "message") listeners.push(listener);
    },
    dispatch(data, source, origin = "null") {
      for (const listener of listeners) {
        listener({
          data,
          source,
          origin,
          ports: [],
        } as unknown as MessageEvent);
      }
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: fakeWindow,
  });
  return fakeWindow;
}

function createToolEndpoint(
  _fakeWindow: FakeWindow,
  descriptor: MsgBusToolDescriptor,
  result: unknown,
): Window {
  const source = {
    postMessage(
      message: unknown,
      _origin: string,
      transfer: Transferable[] = [],
    ) {
      if (
        !isJsonObject(message) ||
        message.type !== "neutron:msgbus:connect"
      ) {
        return;
      }
      const port = transfer[0] as MessagePort | undefined;
      if (!port) return;
      port.addEventListener("message", (event) => {
        const request = event.data as ExecEnvelope;
        const action = request.payload.action;
        const ok =
          action === msgBusLocalActions.toolsList ? [descriptor] : result;
        port.postMessage({ type: "response", id: request.id, ok });
      });
      port.start();
    },
  } as unknown as Window;
  return source;
}

function registerTile(source: Window, appId: string, instanceId: string) {
  ensureTestApp(appId);
  const unregister = registerFrameContext(
    source,
    {
      role: "tile",
      appId,
      tileId: "main",
      instanceId,
      workspace: 1,
    },
    { origin: "null" },
  );
  unregisters.push(unregister);
  const endpoint = getRegisteredEndpoint(
    `app:${appId}:tile:main:instance:${instanceId}`,
  );
  if (!endpoint) throw new Error("Endpoint did not register");
  return endpoint;
}

function registerTray(source: Window, appId: string, instanceId: string) {
  ensureTestApp(appId);
  const unregister = registerFrameContext(
    source,
    { role: "tray", appId, instanceId },
    { origin: "null" },
  );
  unregisters.push(unregister);
  const endpoint = getRegisteredEndpoint(
    `app:${appId}:tray:instance:${instanceId}`,
  );
  if (!endpoint) throw new Error("Tray endpoint did not register");
  return endpoint;
}

function registerBackground(source: Window, appId: string): () => void {
  ensureTestApp(appId);
  const unregister = registerFrameContext(
    source,
    { role: "background", appId },
    { origin: "null" },
  );
  connectFrameEndpoint(source);
  return unregister;
}

function ensureTestApp(appId: string): void {
  const list = useAppsStore.getState().list;
  if (list[appId]) return;
  useAppsStore.setState({
    list: {
      ...list,
      [appId]: registryApp({ id: appId, name: appId }),
    },
  });
}

function setTransientUserActivation(active: boolean): void {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      userActivation: { isActive: active },
    },
  });
}

function authorizeTestOwner(principal = "owner-principal"): void {
  useAuthStore.setState({
    logged: true,
    authorized: true,
    principal,
    loading: false,
    authError: null,
  });
}

afterEach(() => {
  selfCallTarget = undefined;
  selfCallAgent = undefined;
  submitSelfCallUpdate = undefined;
  validateMethodInputOverride = undefined;
  clearInstallOffer("Test cleanup");
  removeAllCallRequests();
  while (unregisters.length) unregisters.pop()?.();
  clearFrontendToolSessionGrants();
  clearMsgBusAudit();
  resetUiAttentionState();
  clearAgentModeForAuth();
  useMsgBusPermissionStore.setState({ requests: {} });
  useRequestStore.setState({ calls: {} });
  useAppsStore.setState({
    list: {},
    appInstances: {},
    runtimeGenerations: {},
    operationBusy: false,
    operation: null,
    pendingInstallRecovery: null,
    runtimeAuthorityFence: null,
  });
  useAuthStore.setState({
    logged: false,
    authorized: false,
    principal: "2vxsx-fae",
    loading: true,
    authError: null,
  });
  useWorkspaceStore.setState((state) => ({
    activeWorkspaceId: 1,
    workspaceDropTargetId: null,
    workspaces: Object.fromEntries(
      workspaceIds.slice(0, 3).map((id) => [
        id,
        { id, layout: null, tiles: [], focusedTileId: null },
      ]),
    ) as unknown as ReturnType<
      typeof useWorkspaceStore.getState
    >["workspaces"],
  }));
  disconnectMsgBus();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: originalNavigator,
  });
  globalThis.fetch = originalFetch;
});

const echoDescriptor: MsgBusToolDescriptor = {
  name: "echo",
  title: "Echo",
  description: "Return the supplied value.",
  inputSchema: {
    type: "object",
    required: ["value"],
    properties: { value: { type: "string" } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["value"],
    properties: { value: { type: "string" } },
    additionalProperties: false,
  },
};

test("same-app tile and background-style endpoints call through the broker", async () => {
  const fakeWindow = installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");
  const targetSource = createToolEndpoint(fakeWindow, echoDescriptor, {
    value: "called",
  });
  const unregisterTarget = registerBackground(targetSource, "hello");
  unregisters.push(unregisterTarget);

  await expect(
    routeToolCall(
      {
        target: "app:hello:background",
        name: "echo",
        arguments: { value: "input" },
      },
      caller,
    ),
  ).resolves.toEqual({ value: "called" });
});

test("same-app tools are hidden and uncallable across apps", async () => {
  const fakeWindow = installFakeWindow();
  const privateDescriptor: MsgBusToolDescriptor = {
    ...echoDescriptor,
    name: "tile_control",
    annotations: { "neutron:visibility": "same_app" },
  };
  const targetSource = createToolEndpoint(fakeWindow, privateDescriptor, {
    value: "called",
  });
  unregisters.push(registerBackground(targetSource, "files"));

  const external = registerTile({} as Window, "agent", "external");
  grantFrontendToolSession(
    "agent",
    "app:files:background",
    "*",
  );
  await expect(
    listTargetTools("app:files:background", external),
  ).resolves.toEqual([]);
  await expect(
    routeToolCall(
      {
        target: "app:files:background",
        name: "tile_control",
        arguments: { value: "input" },
      },
      external,
    ),
  ).rejects.toThrow("Unknown tool 'tile_control'");

  const ownTile = registerTile({} as Window, "files", "own");
  await expect(
    listTargetTools("app:files:background", ownTile),
  ).resolves.toEqual([
    expect.objectContaining({ name: "tile_control" }),
  ]);
});

test("declared cancellation control remains available at ordinary lane saturation", async () => {
  const fakeWindow = installFakeWindow();
  const callerSource = {} as Window;
  registerTile(callerSource, "hello", "caller");
  const otherSource = {} as Window;
  registerTile(otherSource, "other", "caller");

  const workDescriptor: MsgBusToolDescriptor = {
    name: "verify",
    inputSchema: {
      type: "object",
      required: ["requestId"],
      properties: { requestId: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["done"],
      properties: { done: { type: "boolean" } },
      additionalProperties: false,
    },
  };
  const cancelDescriptor: MsgBusToolDescriptor = {
    name: "verify_cancel",
    inputSchema: {
      type: "object",
      required: ["requestId"],
      properties: { requestId: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["cancelled"],
      properties: { cancelled: { type: "boolean" } },
      additionalProperties: false,
    },
    annotations: { "neutron:control": "cancel" },
  };
  const pendingWork = new Map<string, number>();
  const forwardedCallers: string[] = [];
  let heldControlId: number | undefined;
  let workDispatches = 0;
  let targetPort: MessagePort | undefined;
  const targetSource = {
    postMessage(
      message: unknown,
      _origin: string,
      transfer: Transferable[] = [],
    ) {
      if (
        !isJsonObject(message) ||
        message.type !== "neutron:msgbus:connect"
      ) {
        return;
      }
      targetPort = transfer[0] as MessagePort | undefined;
      targetPort?.addEventListener("message", (event) => {
        const message = event.data as ExecEnvelope;
        if (message.payload.action === msgBusLocalActions.toolsList) {
          targetPort?.postMessage({
            type: "response",
            id: message.id,
            ok: [workDescriptor, cancelDescriptor],
          });
          return;
        }
        if (message.payload.action !== msgBusLocalActions.toolsCall) return;
        const payload = message.payload.payload;
        if (!isJsonObject(payload) || !isJsonObject(payload.arguments)) return;
        const requestId = String(payload.arguments.requestId ?? "");
        if (isJsonObject(payload.caller)) {
          forwardedCallers.push(String(payload.caller.endpoint ?? ""));
        }
        if (payload.name === "verify") {
          workDispatches += 1;
          pendingWork.set(requestId, message.id);
          return;
        }
        if (payload.name === "verify_cancel") {
          if (requestId === "hold-control") {
            heldControlId = message.id;
            return;
          }
          const pendingId = pendingWork.get(requestId);
          if (pendingId !== undefined) {
            pendingWork.delete(requestId);
            targetPort?.postMessage({
              type: "response",
              id: pendingId,
              ok: { done: true },
            });
          }
          targetPort?.postMessage({
            type: "response",
            id: message.id,
            ok: { cancelled: pendingId !== undefined },
          });
        }
      });
      targetPort?.start();
    },
  } as unknown as Window;
  unregisters.push(registerBackground(targetSource, "hello"));

  const callFrom = (
    source: Window,
    action: "tools.call" | "tools.call.control",
    name: string,
    requestId: string,
  ) =>
    Promise.resolve(
      executeExposedAction(
        action,
        {
          target: "app:hello:background",
          name,
          arguments: { requestId },
        },
        { source, origin: "null" },
      ),
    );

  const saturated = Array.from({ length: 8 }, (_, index) =>
    callFrom(callerSource, "tools.call", "verify", `request-${index}`),
  );
  for (let turn = 0; turn < 20 && workDispatches < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(workDispatches).toBe(8);

  await expect(
    callFrom(callerSource, "tools.call", "verify", "ordinary-overflow"),
  ).rejects.toThrow("Too many concurrent frontend tool calls");
  await expect(
    callFrom(callerSource, "tools.call.control", "verify", "request-0"),
  ).rejects.toThrow("is not declared as cancel control");
  await expect(
    callFrom(otherSource, "tools.call.control", "verify_cancel", "request-0"),
  ).rejects.toThrow("must remain within one app installation");

  const heldControl = callFrom(
    callerSource,
    "tools.call.control",
    "verify_cancel",
    "hold-control",
  );
  for (let turn = 0; turn < 20 && heldControlId === undefined; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(heldControlId).toBeDefined();
  await expect(
    callFrom(
      callerSource,
      "tools.call.control",
      "verify_cancel",
      "request-0",
    ),
  ).rejects.toThrow("Too many concurrent frontend control calls");
  targetPort?.postMessage({
    type: "response",
    id: heldControlId!,
    ok: { cancelled: false },
  });
  await expect(heldControl).resolves.toEqual({ cancelled: false });

  await expect(
    callFrom(
      callerSource,
      "tools.call.control",
      "verify_cancel",
      "request-0",
    ),
  ).resolves.toEqual({ cancelled: true });
  await expect(saturated[0]).resolves.toEqual({ done: true });
  expect(forwardedCallers.at(-1)).toBe(
    "app:hello:tile:main:instance:caller",
  );

  const replacement = callFrom(
    callerSource,
    "tools.call",
    "verify",
    "replacement",
  );
  for (let turn = 0; turn < 20 && workDispatches < 9; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(workDispatches).toBe(9);

  for (const pendingId of pendingWork.values()) {
    targetPort?.postMessage({
      type: "response",
      id: pendingId,
      ok: { done: true },
    });
  }
  pendingWork.clear();
  await expect(Promise.all([...saturated.slice(1), replacement])).resolves
    .toHaveLength(8);
});

test("a tray endpoint calls its own background without prompting", async () => {
  const fakeWindow = installFakeWindow();
  const caller = registerTray({} as Window, "hello", "panel-one");
  const targetSource = createToolEndpoint(fakeWindow, echoDescriptor, {
    value: "tray-called",
  });
  unregisters.push(
    registerBackground(targetSource, "hello"),
  );

  await expect(
    routeToolCall(
      {
        target: "app:hello:background",
        name: "echo",
        arguments: { value: "from tray" },
      },
      caller,
    ),
  ).resolves.toEqual({ value: "tray-called" });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("signed calls are cancelled when frontend authority becomes pending", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");

  const pending = routeToolCall(
    {
      target: "kernel",
      name: "canister.call_dialog",
      arguments: {
        canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
        method: "hello_world",
        args: ["Alice"],
      },
    },
    caller,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(Object.keys(useRequestStore.getState().calls)).toHaveLength(1);

  useAppsStore.getState().setRuntimeAuthorityFence({
    deploymentId: "replacement-deployment",
    reason: "runtime_changed",
  });

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(useRequestStore.getState().calls).toEqual({});
});

test("private self-call operations are not available as generic kernel tools", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");
  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "canister.query_self",
        arguments: { method: "1read", args: [] },
      },
      caller,
    ),
  ).rejects.toThrow();
});

test("generic call_dialog rejects self targets before any JSON call path", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");
  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "canister.call_dialog",
        arguments: {
          canister: TEST_KERNEL_CANISTER_ID,
          method: "hello_world",
          args: [{ nested: null }],
        },
      },
      caller,
    ),
  ).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    message: expect.stringContaining("attachment-aware API-1"),
  });
  expect(useRequestStore.getState().calls).toEqual({});
});

test("generic backend access tool rejects attached calls", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");
  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "backend_calls.request",
        arguments: {
          actions: [],
          call: { method: "hello_world", args: [] },
        },
      },
      caller,
    ),
  ).rejects.toThrow(/Invalid arguments/);
});

test("valid unified self queries and updates dispatch through the private binary port", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const appId = "attachment_live";
  const installed = registryApp({
    id: appId,
    name: "Attachment Live",
    capabilities: {
      preapproved_self_calls: {
        api: 1,
        methods: ["lookup", "put"],
      },
    },
    func: {
      lookup: { type: "query" },
      put: { type: "update", async: "async*" },
    },
  });
  useAppsStore.setState({ list: { [appId]: installed } });
  const lookupMethod = installed.functions.find(
    (candidate) => candidate.name === "lookup",
  )?.candid_name;
  const putMethod = installed.functions.find(
    (candidate) => candidate.name === "put",
  )?.candid_name;
  if (!lookupMethod || !putMethod) {
    throw new Error("Attachment test physical methods are unavailable");
  }

  const requestType = IDL.Record({ key: IDL.Text });
  const blobType = IDL.Vec(IDL.Nat8);
  const queryOutputType = IDL.Record({
    value: IDL.Record({ found: IDL.Bool }),
    body: blobType,
  });
  const updateRequestType = IDL.Record({
    key: IDL.Text,
    avatar: blobType,
    nested: IDL.Record({
      attachments: IDL.Vec(blobType),
    }),
  });
  const updateOutputType = IDL.Record({ stored: IDL.Bool });
  const idlFactory: IDL.InterfaceFactory = ({ IDL: FactoryIDL }) =>
    FactoryIDL.Service({
      [lookupMethod]: FactoryIDL.Func(
        [
          FactoryIDL.Record({ key: FactoryIDL.Text }),
          FactoryIDL.Vec(FactoryIDL.Nat8),
        ],
        [
          FactoryIDL.Record({
            value: FactoryIDL.Record({ found: FactoryIDL.Bool }),
            body: FactoryIDL.Vec(FactoryIDL.Nat8),
          }),
        ],
        ["query"],
      ),
      [putMethod]: FactoryIDL.Func(
        [
          FactoryIDL.Record({
            key: FactoryIDL.Text,
            avatar: FactoryIDL.Vec(FactoryIDL.Nat8),
            nested: FactoryIDL.Record({
              attachments: FactoryIDL.Vec(
                FactoryIDL.Vec(FactoryIDL.Nat8),
              ),
            }),
          }),
        ],
        [FactoryIDL.Record({ stored: FactoryIDL.Bool })],
        [],
      ),
    });
  selfCallTarget = {
    $idlFactory: idlFactory,
    [lookupMethod]: async () => undefined,
    [putMethod]: async () => undefined,
    [`${lookupMethod}$`]: async (
      request: { key: string },
      body: Uint8Array,
    ) => [...IDL.encode([requestType, blobType], [request, body])],
    [`${putMethod}$`]: async (request: {
      key: string;
      avatar: Uint8Array;
      nested: { attachments: Uint8Array[] };
    }) => [...IDL.encode([updateRequestType], [request])],
    [`$${putMethod}`]: (bytes: number[]) =>
      IDL.decode([updateOutputType], Uint8Array.from(bytes))[0],
  };

  let queryDispatches = 0;
  let updateDispatches = 0;
  const fakeAttachmentAgent = {
    rootKey: new Uint8Array(0),
    query: async (
      _canisterId: Parameters<Agent["query"]>[0],
      options: Parameters<Agent["query"]>[1],
    ) => {
      queryDispatches += 1;
      expect(options.methodName).toBe(lookupMethod);
      const [request, body] = IDL.decode(
        [requestType, blobType],
        options.arg,
      ) as [{ key: string }, Uint8Array];
      expect(request).toEqual({ key: "alpha" });
      expect([...body]).toEqual([0, 255, 7, 9]);
      return {
        status: QueryResponseStatus.Replied,
        reply: {
          arg: IDL.encode(
            [queryOutputType],
            [
              {
                value: { found: true },
                body: new Uint8Array([9, 255, 0]),
              } as never,
            ],
          ),
        },
        requestId: new Uint8Array(32),
        httpDetails: {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: [],
        },
      };
    },
  } as unknown as Agent;
  selfCallAgent = fakeAttachmentAgent;
  validateMethodInputOverride = (_target, method, args) => {
    if (method === putMethod) {
      // The generated icblast schema accepts its public blob shorthands, not
      // Uint8Array. Validation must see the live-Candid-derived shadow at
      // every nested/repeated blob leaf.
      expect(args).toEqual([
        {
          key: "beta",
          avatar: [],
          nested: { attachments: [[], []] },
        },
      ]);
      const containsTypedArray = (value: unknown): boolean =>
        value instanceof Uint8Array ||
        (Array.isArray(value)
          ? value.some(containsTypedArray)
          : typeof value === "object" && value !== null
            ? Object.values(value).some(containsTypedArray)
            : false);
      expect(containsTypedArray(args)).toBe(false);
    }
    return { ok: true };
  };
  submitSelfCallUpdate = async (
    agent,
    _canisterId,
    methodName,
    rawInput,
  ) => {
    updateDispatches += 1;
    expect(agent).toBe(fakeAttachmentAgent);
    expect(methodName).toBe(putMethod);
    const [request] = IDL.decode(
      [updateRequestType],
      rawInput,
    ) as unknown as [{
      key: string;
      avatar: Uint8Array;
      nested: { attachments: Uint8Array[] };
    }];
    expect(request.key).toBe("beta");
    expect([...request.avatar]).toEqual([1, 2, 3]);
    expect(request.nested.attachments.map((body) => [...body])).toEqual([
      [4, 5],
      [6, 7, 8],
    ]);
    return IDL.encode([updateOutputType], [{ stored: true }]);
  };

  let appPort: MessagePort | undefined;
  const source = {
    postMessage(
      _message: unknown,
      _targetOrigin: string,
      transfer: Transferable[] = [],
    ) {
      if (transfer[0]) appPort = transfer[0] as MessagePort;
    },
  } as unknown as Window;
  unregisters.push(
    registerFrameContext(
      source,
      {
        role: "tile",
        appId,
        tileId: "main",
        instanceId: "live",
        workspace: 1,
      },
      { origin: "null" },
    ),
  );
  expect(connectFrameEndpoint(source)).toBe(true);
  if (!appPort) throw new Error("Attachment test port was not transferred");
  appPort.start();

  const requestOverPort = <T>(
    id: number,
    request: unknown,
    transfer: Transferable[] = [],
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const listener = (event: MessageEvent) => {
        const response = event.data as {
          id?: number;
          ok?: T;
          error?: unknown;
        };
        if (response.id !== id) return;
        appPort!.removeEventListener("message", listener);
        if (response.error !== undefined) reject(response.error);
        else resolve(response as T);
      };
      appPort!.addEventListener("message", listener);
      appPort!.postMessage(request, transfer);
    });
  const queryInput = new Uint8Array([0, 255, 7, 9]).buffer;
  const queryResponse = await requestOverPort<{
    ok: { value: { found: boolean }; body: null };
    blobs: Array<{ data: ArrayBuffer }>;
  }>(
    501,
    {
      type: "neutron:self-call:exec",
      version: 1,
      id: 501,
      tool: "canister.query_self",
      method: "lookup",
      args: [{ key: "alpha" }, null],
      blobs: [
        {
          path: [1],
          byteLength: queryInput.byteLength,
          data: queryInput,
        },
      ],
    },
    [queryInput],
  );
  expect(queryInput.byteLength).toBe(0);
  expect(queryResponse.ok).toEqual({
    value: { found: true },
    body: null,
  });
  expect(queryResponse.blobs).toHaveLength(1);
  expect(
    [...new Uint8Array(queryResponse.blobs[0]!.data)],
  ).toEqual([9, 255, 0]);

  const updateAvatar = new Uint8Array([1, 2, 3]).buffer;
  const updateAttachmentOne = new Uint8Array([4, 5]).buffer;
  const updateAttachmentTwo = new Uint8Array([6, 7, 8]).buffer;
  const updateResponse = await requestOverPort<{
    ok: { stored: boolean };
    blobs: unknown[];
  }>(
    502,
    {
      type: "neutron:self-call:exec",
      version: 1,
      id: 502,
      tool: "canister.update_self",
      method: "put",
      args: [
        {
          key: "beta",
          avatar: null,
          nested: { attachments: [null, null] },
        },
      ],
      blobs: [
        {
          path: [0, "avatar"],
          byteLength: updateAvatar.byteLength,
          data: updateAvatar,
        },
        {
          path: [0, "nested", "attachments", 0],
          byteLength: updateAttachmentOne.byteLength,
          data: updateAttachmentOne,
        },
        {
          path: [0, "nested", "attachments", 1],
          byteLength: updateAttachmentTwo.byteLength,
          data: updateAttachmentTwo,
        },
      ],
    },
    [updateAvatar, updateAttachmentOne, updateAttachmentTwo],
  );
  expect(updateAvatar.byteLength).toBe(0);
  expect(updateAttachmentOne.byteLength).toBe(0);
  expect(updateAttachmentTwo.byteLength).toBe(0);
  expect(updateResponse.ok).toEqual({ stored: true });
  expect(updateResponse.blobs).toEqual([]);
  expect(queryDispatches).toBe(1);
  expect(updateDispatches).toBe(1);
});


test("scoped binary self calls bind invocation provenance and revoke closed", async () => {
  installFakeWindow();
  const appId = "scoped_binary";
  const installationUid = "301";
  const installed = registryApp({
    id: appId,
    name: "Scoped Binary",
    version: 100,
    background: { path: "background.html" },
    capabilities: {
      preapproved_self_calls: {
        api: 1,
        methods: ["store"],
      },
      agent_entrypoints: { api: 1, entrypoints: ["run"] },
    },
    func: {
      store: { type: "update", async: "async*" },
    },
  });
  useAppsStore.setState({
    list: { [appId]: installed },
    appInstances: {
      [appId]: {
        scope: { appId, installationUid },
        version: installed.version,
        deploymentId: "development",
        capabilityPlanFingerprint: installed.capability_plan_fingerprint,
        browserOriginNonce: installationUid.padStart(32, "0"),
        browserOriginAuthorityEpoch: "1",
        residentFrameSecurity: "credentialless_opaque_v1",
      },
    },
  });
  const connect = (
    context:
      | { role: "background"; appId: string }
      | {
          role: "tile";
          appId: string;
          tileId: string;
          instanceId: string;
          workspace: number;
        },
  ) => {
    let appPort: MessagePort | undefined;
    const source = {
      postMessage(
        _message: unknown,
        _targetOrigin: string,
        transfer: Transferable[] = [],
      ) {
        if (transfer[0]) appPort = transfer[0] as MessagePort;
      },
    } as unknown as Window;
    unregisters.push(
      registerFrameContext(source, context, {
        origin: "null",
        appScope: { appId, installationUid },
      }),
    );
    expect(connectFrameEndpoint(source)).toBe(true);
    if (!appPort) throw new Error("Scoped self-call port was not transferred");
    appPort.start();
    const endpointId =
      context.role === "background"
        ? `app:${appId}:background`
        : `app:${appId}:tile:${context.tileId}:instance:${context.instanceId}`;
    const endpoint = getRegisteredEndpoint(endpointId);
    if (!endpoint) throw new Error("Scoped endpoint did not register");
    return { appPort, endpoint };
  };
  const tile = connect({
    role: "tile",
    appId,
    tileId: "chat",
    instanceId: "root",
    workspace: 1,
  });
  const resident = connect({ role: "background", appId });
  const other = connect({
    role: "tile",
    appId,
    tileId: "chat",
    instanceId: "other",
    workspace: 1,
  });

  const grant = requestAgentGrant({
    appId,
    appName: installed.name,
    version: installed.version,
    installationUid,
    entrypoint: "run",
    ownerPrincipal: "aaaaa-aa",
  });
  approveAgentGrant();
  await grant;
  const root = beginAgentRoot({
    caller: tile.endpoint,
    target: resident.endpoint,
    tool: "run",
    ownerPrincipal: "aaaaa-aa",
    installedVersion: installed.version,
    activated: true,
  });
  if (!root) throw new Error("Scoped self-call root did not start");
  const metadata = invocationMetadata(root);

  const physicalMethod = installed.functions.find(
    ({ name }) => name === "store",
  )?.candid_name;
  if (!physicalMethod) {
    throw new Error("Missing scoped physical method");
  }
  const requestType = IDL.Record({
    left: IDL.Vec(IDL.Nat8),
    right: IDL.Vec(IDL.Nat8),
  });
  const outputType = IDL.Variant({
    ok: IDL.Record({ stored: IDL.Bool }),
    err: IDL.Record({
      proof: IDL.Vec(IDL.Nat8),
      nested: IDL.Record({ other: IDL.Vec(IDL.Nat8) }),
    }),
  });
  selfCallTarget = {
    $idlFactory: ({ IDL: FactoryIDL }: { IDL: typeof IDL }) =>
      FactoryIDL.Service({
        [physicalMethod]: FactoryIDL.Func(
          [
            FactoryIDL.Record({
              left: FactoryIDL.Vec(FactoryIDL.Nat8),
              right: FactoryIDL.Vec(FactoryIDL.Nat8),
            }),
          ],
          [
            FactoryIDL.Variant({
              ok: FactoryIDL.Record({ stored: FactoryIDL.Bool }),
              err: FactoryIDL.Record({
                proof: FactoryIDL.Vec(FactoryIDL.Nat8),
                nested: FactoryIDL.Record({
                  other: FactoryIDL.Vec(FactoryIDL.Nat8),
                }),
              }),
            }),
          ],
          [],
        ),
      }),
    [`${physicalMethod}$`]: async (value: {
      left: Uint8Array;
      right: Uint8Array;
    }) => [...IDL.encode([requestType], [value])],
  };
  let dispatches = 0;
  const fakeAgent = {
    rootKey: new Uint8Array(0),
  } as unknown as Agent;
  selfCallAgent = fakeAgent;
  let binaryErrorNext = false;
  submitSelfCallUpdate = async (_agent, _canister, method, bytes) => {
    dispatches += 1;
    expect(method).toBe(physicalMethod);
    const [value] = IDL.decode(
      [requestType],
      bytes,
    ) as unknown as [{ left: Uint8Array; right: Uint8Array }];
    expect([...value.left]).toEqual([1, 2]);
    expect([...value.right]).toEqual([3, 4, 5]);
    return IDL.encode(
      [outputType],
      [
        binaryErrorNext
          ? {
              err: {
                proof: Uint8Array.from([0, 255]),
                nested: { other: Uint8Array.from([17, 34, 51]) },
              },
            }
          : { ok: { stored: true } },
      ],
    );
  };

  const request = (
    port: MessagePort,
    id: number,
    context?: { invocation: typeof metadata },
  ): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        const response = event.data as Record<string, any>;
        if (response.id !== id) return;
        port.removeEventListener("message", listener);
        resolve(response);
      };
      port.addEventListener("message", listener);
      const left = Uint8Array.from([1, 2]).buffer;
      const right = Uint8Array.from([3, 4, 5]).buffer;
      port.postMessage(
        {
          type: "neutron:self-call:exec",
          version: 1,
          id,
          tool: "canister.update_self",
          method: "store",
          args: [{ left: null, right: null }],
          blobs: [
            { path: [0, "left"], byteLength: 2, data: left },
            { path: [0, "right"], byteLength: 3, data: right },
          ],
          ...(context ? { context } : {}),
        },
        [left, right],
      );
    });

  const success = await request(resident.appPort, 601, {
    invocation: metadata,
  });
  expect(success).toMatchObject({ ok: { stored: true }, blobs: [] });
  expect(dispatches).toBe(1);
  const scopedAudit = listMsgBusAudit().at(-1);
  expect(scopedAudit?.binaryFields).toEqual({
    input: { count: 2, bytes: 5 },
    output: { count: 0, bytes: 0 },
  });
  expect(JSON.stringify(scopedAudit)).not.toContain(metadata.id);
  expect(JSON.stringify(scopedAudit)).not.toContain(metadata.rootId);
  expect(JSON.stringify(success)).not.toContain(metadata.capability);

  const fabricated = await request(resident.appPort, 602, {
    invocation: { ...metadata, capability: "f".repeat(48) },
  });
  expect(fabricated.error).toMatchObject({ code: "INVOCATION_INVALID" });
  expect(dispatches).toBe(1);

  const crossEndpoint = await request(other.appPort, 603, {
    invocation: metadata,
  });
  expect(crossEndpoint.error).toMatchObject({ code: "INVOCATION_INVALID" });
  expect(dispatches).toBe(1);

  completeInvocation(root);
  const stale = await request(resident.appPort, 604, {
    invocation: metadata,
  });
  expect(stale.error).toMatchObject({ code: "INVOCATION_INVALID" });
  expect(dispatches).toBe(1);

  const direct = await request(resident.appPort, 605);
  expect(direct).toMatchObject({ ok: { stored: true }, blobs: [] });
  expect(dispatches).toBe(2);

  binaryErrorNext = true;
  const protectedError = await request(resident.appPort, 606);
  expect(protectedError).toMatchObject({
    error: {
      name: "CanisterResultError",
      code: "binary_domain_error",
    },
  });
  expect(protectedError.blobs).toBeUndefined();
  expect(JSON.stringify(protectedError)).not.toContain("00ff");
  expect(JSON.stringify(protectedError)).not.toContain("112233");
  expect(listMsgBusAudit().at(-1)?.binaryFields).toEqual({
    input: { count: 2, bytes: 5 },
    output: { count: 2, bytes: 5 },
  });
  expect(dispatches).toBe(3);
});

test("signed calls revalidate the exact source after approval before dispatch", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");

  const pending = routeToolCall(
    {
      target: "kernel",
      name: "canister.call_dialog",
      arguments: {
        canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
        method: "hello_world",
        args: ["Alice"],
      },
    },
    caller,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing signed-call approval request");

  callApprove({ cid });
  unregisters.push(
    registerFrameContext(
      {} as Window,
      caller.context,
      { origin: "null" },
    ),
  );

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
});

test("signed calls revalidate owner authorization after approval", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");
  useAuthStore.setState({
    logged: true,
    authorized: true,
    principal: "owner-principal",
    loading: false,
    authError: null,
  });

  const pending = routeToolCall(
    {
      target: "kernel",
      name: "canister.call_dialog",
      arguments: {
        canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
        method: "hello_world",
      },
    },
    caller,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing signed-call approval request");

  callApprove({ cid });
  useAuthStore.setState({
    logged: false,
    authorized: false,
    principal: "2vxsx-fae",
    loading: false,
    authError: null,
  });

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
});

test("private-port attachment calls transfer buffers through the broker", async () => {
  installFakeWindow();
  const descriptor: MsgBusToolDescriptor = {
    name: "binaryEcho",
    inputSchema: {
      type: "object",
      required: ["label"],
      properties: { label: { type: "string" } },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["label"],
      properties: { label: { type: "string" } },
      additionalProperties: false,
    },
    annotations: {
      "neutron:audit": "metadata_only",
      "neutron:attachments": {
        version: 1,
        input: {
          name: "data",
          mediaTypes: ["application/octet-stream"],
          maxBytes: 16,
          required: true,
        },
        output: {
          name: "data",
          mediaTypes: ["application/octet-stream"],
          maxBytes: 16,
          required: true,
        },
      },
    },
  };

  const connected = (
    context:
      | { role: "background"; appId: string }
      | {
          role: "tile";
          appId: string;
          tileId: string;
          instanceId: string;
          workspace: number;
        },
  ) => {
    ensureTestApp(context.appId);
    let appPort: MessagePort | undefined;
    const source = {
      postMessage(
        _message: unknown,
        _targetOrigin: string,
        transfer: Transferable[] = [],
      ) {
        if (transfer[0]) appPort = transfer[0] as MessagePort;
      },
    } as unknown as Window;
    unregisters.push(registerFrameContext(source, context, { origin: "null" }));
    expect(connectFrameEndpoint(source)).toBe(true);
    if (!appPort) throw new Error("app port was not transferred");
    const endpoint = getRegisteredEndpoint(
      context.role === "background"
        ? `app:${context.appId}:background`
        : `app:${context.appId}:tile:${context.tileId}:instance:${context.instanceId}`,
    );
    if (!endpoint) throw new Error("connected endpoint missing");
    return { appPort, endpoint };
  };

  const caller = connected({
    role: "tile",
    appId: "binary_caller",
    tileId: "main",
    instanceId: "caller",
    workspace: 1,
  });
  const target = connected({ role: "background", appId: "binary_target" });
  let targetOutputDetached = false;
  target.appPort.addEventListener("message", (event) => {
    const message = event.data as
      | ExecEnvelope
      | AttachmentExecEnvelope;
    if (message.type === "exec") {
      if (message.payload.action === msgBusLocalActions.toolsList) {
        target.appPort.postMessage({
          type: "response",
          id: message.id,
          ok: [descriptor],
        });
      }
      return;
    }
    expect(message.payload.action).toBe(msgBusLocalActions.toolsCall);
    expect(message.payload.payload).toMatchObject({
      name: "binaryEcho",
      arguments: { label: "round trip" },
      caller: {
        endpoint: caller.endpoint.endpointId,
        appId: "binary_caller",
        role: "tile",
      },
    });
    expect([...new Uint8Array(message.attachments[0]!.data)]).toEqual([
      1, 2, 3, 4,
    ]);
    const output = new Uint8Array([4, 3, 2, 1]).buffer;
    target.appPort.postMessage(
      {
        type: "neutron:msgbus:attachment:response",
        version: 1,
        id: message.id,
        ok: { label: "round trip" },
        attachments: [
          {
            name: "data",
            mediaType: "application/octet-stream",
            byteLength: output.byteLength,
            data: output,
          },
        ],
      } satisfies AttachmentResponseEnvelope,
      [output],
    );
    targetOutputDetached = output.byteLength === 0;
  });
  target.appPort.start();

  const input = new Uint8Array([1, 2, 3, 4]).buffer;
  const response = new Promise<AttachmentResponseEnvelope>((resolve, reject) => {
    caller.appPort.addEventListener("message", (event) => {
      const message = event.data as AttachmentResponseEnvelope;
      if (message.type !== "neutron:msgbus:attachment:response") return;
      if (message.error !== undefined) reject(message.error);
      else resolve(message);
    });
    caller.appPort.start();
  });
  caller.appPort.postMessage(
    {
      type: "neutron:msgbus:attachment:exec",
      version: 1,
      id: 91,
      payload: {
        action: "tools.call",
        payload: {
          target: target.endpoint.endpointId,
          name: "binaryEcho",
          arguments: { label: "round trip" },
        },
      },
      attachments: [
        {
          name: "data",
          mediaType: "application/octet-stream",
          byteLength: input.byteLength,
          data: input,
        },
      ],
    } satisfies AttachmentExecEnvelope,
    [input],
  );
  expect(input.byteLength).toBe(0);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const permission = Object.values(
    useMsgBusPermissionStore.getState().requests,
  )[0];
  expect(permission).toMatchObject({
    caller: { appId: "binary_caller", role: "tile" },
    target: target.endpoint.endpointId,
    tool: "binaryEcho",
    attachmentBytes: { input: 4, maximumOutput: 16 },
  });
  approveFrontendToolRequest(permission!.cid, "session");

  const result = await response;
  expect(result.ok).toEqual({ label: "round trip" });
  expect(
    [...new Uint8Array(result.attachments![0]!.data)],
  ).toEqual([4, 3, 2, 1]);
  expect(targetOutputDetached).toBe(true);
  expect(listMsgBusAudit().at(-1)).toMatchObject({
    target: target.endpoint.endpointId,
    tool: "binaryEcho",
    status: "ok",
    arguments: { metadataBytes: expect.any(Number) },
    metadataBytes: {
      input: expect.any(Number),
      output: expect.any(Number),
    },
    attachmentBytes: { input: 4, output: 4 },
  });
  expect(JSON.stringify(listMsgBusAudit().at(-1))).not.toContain(
    "round trip",
  );

  await expect(
    routeToolCall(
      {
        target: target.endpoint.endpointId as never,
        name: "binaryEcho",
        arguments: { label: "json call" },
      },
      caller.endpoint,
    ),
  ).rejects.toMatchObject({ code: "ATTACHMENT_API_REQUIRED" });
});

test("one-use delegation preserves scoped provenance for a nested attachment call", async () => {
  installFakeWindow();
  const connected = (
    context:
      | { role: "background"; appId: string }
      | {
          role: "tile";
          appId: string;
          tileId: string;
          instanceId: string;
          workspace: number;
        },
  ) => {
    ensureTestApp(context.appId);
    const installationUid =
      context.appId === "delegating_agent" ? "101" : "201";
    useAppsStore.setState((state) => ({
      appInstances: {
        ...state.appInstances,
        [context.appId]: {
          scope: { appId: context.appId, installationUid },
          version: 100,
          deploymentId: "development",
          capabilityPlanFingerprint:
            state.list[context.appId]!.capability_plan_fingerprint,
          browserOriginNonce: installationUid.padStart(32, "0"),
          browserOriginAuthorityEpoch: "1",
          residentFrameSecurity: "credentialless_opaque_v1",
        },
      },
    }));
    let appPort: MessagePort | undefined;
    const source = {
      postMessage(
        _message: unknown,
        _targetOrigin: string,
        transfer: Transferable[] = [],
      ) {
        if (transfer[0]) appPort = transfer[0] as MessagePort;
      },
    } as unknown as Window;
    unregisters.push(
      registerFrameContext(source, context, {
        origin: "null",
        appScope: { appId: context.appId, installationUid },
      }),
    );
    expect(connectFrameEndpoint(source)).toBe(true);
    if (!appPort) throw new Error("app port was not transferred");
    const endpoint = getRegisteredEndpoint(
      context.role === "background"
        ? `app:${context.appId}:background`
        : `app:${context.appId}:tile:${context.tileId}:instance:${context.instanceId}`,
    );
    if (!endpoint) throw new Error("connected endpoint missing");
    return { appPort, endpoint };
  };

  const rootTile = connected({
    role: "tile",
    appId: "delegating_agent",
    tileId: "chat",
    instanceId: "root",
    workspace: 1,
  });
  const rootResident = connected({
    role: "background",
    appId: "delegating_agent",
  });
  const target = connected({ role: "background", appId: "binary_nested" });
  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "attachments.delegate",
        arguments: {},
      },
      rootResident.endpoint,
    ),
  ).resolves.toEqual({ token: null, expiresAt: null });
  expect(listMsgBusAudit().at(-1)).toMatchObject({
    tool: "attachments.delegate",
    result: { delegationIssued: false },
  });
  const grant = requestAgentGrant({
    appId: "delegating_agent",
    appName: "Delegating Agent",
    version: 100,
    installationUid: "101",
    entrypoint: "run",
    ownerPrincipal: "aaaaa-aa",
  });
  approveAgentGrant();
  await grant;
  const root = beginAgentRoot({
    caller: rootTile.endpoint,
    target: rootResident.endpoint,
    tool: "run",
    ownerPrincipal: "aaaaa-aa",
    installedVersion: 100,
    activated: true,
  });
  if (!root) throw new Error("agent root did not start");

  const delegated = (await routeToolCall(
    {
      target: "kernel",
      name: "attachments.delegate",
      arguments: {},
    },
    rootResident.endpoint,
    undefined,
    invocationMetadata(root, true),
  )) as { token: string; expiresAt: number };
  expect(delegated.token).toMatch(/^[a-f0-9]{48}$/);
  expect(delegated.expiresAt).toBeGreaterThan(Date.now());
  const delegateAudit = listMsgBusAudit().at(-1);
  expect(delegateAudit).toMatchObject({
    tool: "attachments.delegate",
    result: { delegationIssued: true },
  });
  expect(JSON.stringify(delegateAudit)).not.toContain(delegated.token);

  const descriptor: MsgBusToolDescriptor = {
    name: "nestedBinary",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      required: ["accepted"],
      properties: { accepted: { type: "boolean" } },
      additionalProperties: false,
    },
    annotations: {
      "neutron:attachments": {
        version: 1,
        input: {
          name: "data",
          mediaTypes: ["application/octet-stream"],
          maxBytes: 8,
          required: true,
        },
      },
    },
  };
  let preservedDepth = -1;
  target.appPort.addEventListener("message", (event) => {
    const message = event.data as ExecEnvelope | AttachmentExecEnvelope;
    if (message.type === "exec") {
      if (message.payload.action === msgBusLocalActions.toolsList) {
        target.appPort.postMessage({
          type: "response",
          id: message.id,
          ok: [descriptor],
        });
      }
      return;
    }
    expect(message.delegationToken).toBeUndefined();
    const metadata = message.payload.context?.invocation;
    if (!metadata) throw new Error("nested invocation metadata missing");
    const child = resolveInvocation(target.endpoint, metadata);
    preservedDepth = child?.depth ?? -1;
    expect(child?.rootId).toBe(root.rootId);
    target.appPort.postMessage({
      type: "neutron:msgbus:attachment:response",
      version: 1,
      id: message.id,
      ok: { accepted: true },
    } satisfies AttachmentResponseEnvelope);
  });
  target.appPort.start();
  grantFrontendToolSession(
    "delegating_agent",
    target.endpoint.endpointId,
    "nestedBinary",
    {
      callerEndpoint: rootResident.endpoint.endpointId,
      callerSessionId: rootResident.endpoint.sessionId!,
      targetSessionId: target.endpoint.sessionId!,
    },
  );

  const callWithToken = (
    id: number,
    token: string,
  ): Promise<AttachmentResponseEnvelope> => {
    const response = new Promise<AttachmentResponseEnvelope>((resolve) => {
      const listener = (event: MessageEvent) => {
        const message = event.data as AttachmentResponseEnvelope;
        if (
          message.type !== "neutron:msgbus:attachment:response" ||
          message.id !== id
        ) {
          return;
        }
        rootResident.appPort.removeEventListener("message", listener);
        resolve(message);
      };
      rootResident.appPort.addEventListener("message", listener);
      rootResident.appPort.start();
    });
    const data = new Uint8Array([7]).buffer;
    rootResident.appPort.postMessage(
      {
        type: "neutron:msgbus:attachment:exec",
        version: 1,
        id,
        delegationToken: token,
        payload: {
          action: "tools.call",
          payload: {
            target: target.endpoint.endpointId,
            name: "nestedBinary",
            arguments: {},
          },
        },
        attachments: [
          {
            name: "data",
            mediaType: "application/octet-stream",
            byteLength: data.byteLength,
            data,
          },
        ],
      } satisfies AttachmentExecEnvelope,
      [data],
    );
    return response;
  };

  const first = await callWithToken(201, delegated.token);
  expect(first.ok).toEqual({ accepted: true });
  expect(preservedDepth).toBe(1);
  const replay = await callWithToken(202, delegated.token);
  expect(replay.error).toMatchObject({
    code: "ATTACHMENT_DELEGATION_INVALID",
  });
  completeInvocation(root);
});

test("app state changes stay source-bound and within one app", async () => {
  const messages = (source: Window) =>
    (source as unknown as { sent: unknown[] }).sent;
  const source = () => {
    const endpoint = {
      sent: [] as unknown[],
      postMessage(
        message: unknown,
        _origin: string,
        transfer: Transferable[] = [],
      ) {
        if (
          !isJsonObject(message) ||
          message.type !== "neutron:msgbus:connect"
        ) {
          return;
        }
        const port = transfer[0] as MessagePort | undefined;
        port?.addEventListener("message", (event) => {
          endpoint.sent.push(event.data);
        });
        port?.start();
      },
    };
    return endpoint as unknown as Window;
  };
  const publisher = source();
  const sameAppTile = source();
  const otherAppTile = source();
  unregisters.push(
    registerFrameContext(
      publisher,
      { role: "background", appId: "contacts" },
      { origin: "null" },
    ),
    registerFrameContext(
      sameAppTile,
      {
        role: "tile",
        appId: "contacts",
        tileId: "contacts",
        instanceId: "same",
        workspace: 1,
      },
      { origin: "null" },
    ),
    registerFrameContext(
      otherAppTile,
      {
        role: "tile",
        appId: "wallet",
        tileId: "wallet",
        instanceId: "other",
        workspace: 1,
      },
      { origin: "null" },
    ),
  );
  expect(connectFrameEndpoint(publisher)).toBe(true);
  expect(connectFrameEndpoint(sameAppTile)).toBe(true);
  expect(connectFrameEndpoint(otherAppTile)).toBe(true);

  expect(
    executeExposedAction(
      "app.state.publish",
      { topic: "contacts", revision: "9" },
      { source: publisher, origin: "null" },
    ),
  ).toEqual({ delivered: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(messages(publisher)).toEqual([]);
  expect(messages(sameAppTile)).toEqual([
    {
      type: "neutron:app:state",
      version: 1,
      topic: "contacts",
      revision: "9",
    },
  ]);
  expect(messages(otherAppTile)).toEqual([]);

  for (let revision = 10; revision < 50; revision += 1) {
    expect(
      executeExposedAction(
        "app.state.publish",
        { topic: "contacts", revision: String(revision) },
        { source: publisher, origin: "null" },
      ),
    ).toEqual({ delivered: 1 });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(messages(sameAppTile)).toHaveLength(41);
  expect(messages(sameAppTile).at(-1)).toMatchObject({ revision: "49" });
  expect(messages(otherAppTile)).toEqual([]);

  expect(() =>
    executeExposedAction(
      "app.state.publish",
      { topic: "contacts", revision: "10", appId: "wallet" },
      { source: publisher, origin: "null" },
    ),
  ).toThrow("Invalid app state change");
});

test("a retained tile receives the latest state invalidation when it reconnects", async () => {
  const publisher = { postMessage() {} } as unknown as Window;
  const replayed: unknown[] = [];
  const retainedTile = {
    postMessage(
      message: unknown,
      _targetOrigin: string,
      transfer: Transferable[] = [],
    ) {
      if (
        !isJsonObject(message) ||
        message.type !== "neutron:msgbus:connect"
      ) {
        return;
      }
      const port = transfer[0] as MessagePort | undefined;
      if (!port) return;
      port.addEventListener("message", (event) => replayed.push(event.data));
      port.start();
    },
  } as unknown as Window;
  const context = {
    role: "tile" as const,
    appId: "replay",
    tileId: "main",
    instanceId: "retained",
    workspace: 1,
  };
  unregisters.push(
    registerFrameContext(
      publisher,
      { role: "background", appId: "replay" },
      { origin: "null" },
    ),
  );
  const hide = registerFrameContext(retainedTile, context, { origin: "null" });
  hide();

  expect(
    executeExposedAction(
      "app.state.publish",
      { topic: "wallet_projection", revision: "42" },
      { source: publisher, origin: "null" },
    ),
  ).toEqual({ delivered: 0 });

  const firstReconnect = registerFrameContext(retainedTile, context, {
    origin: "null",
  });
  unregisters.push(firstReconnect);
  expect(connectFrameEndpoint(retainedTile)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(replayed).toContainEqual({
    type: "neutron:app:state",
    version: 1,
    topic: "wallet_projection",
    revision: "42",
  });

  firstReconnect();
  unregisters.push(
    registerFrameContext(retainedTile, context, { origin: "null" }),
  );
  expect(connectFrameEndpoint(retainedTile)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(
    replayed.filter(
      (message) =>
        isJsonObject(message) &&
        message.type === "neutron:app:state" &&
        message.topic === "wallet_projection" &&
        message.revision === "42",
    ),
  ).toHaveLength(1);
});

test("broker forwards bounded target progress to the exact active caller", async () => {
  const fakeWindow = installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");
  const targetSource = {
    postMessage(
      message: unknown,
      _origin: string,
      transfer: Transferable[] = [],
    ) {
      if (
        !isJsonObject(message) ||
        message.type !== "neutron:msgbus:connect"
      ) {
        return;
      }
      const port = transfer[0] as MessagePort | undefined;
      port?.addEventListener("message", (event) => {
        const request = event.data as ExecEnvelope;
        if (request.payload.action === msgBusLocalActions.toolsList) {
          port.postMessage({
            type: "response",
            id: request.id,
            ok: [echoDescriptor],
          });
          return;
        }
        port.postMessage({
          type: "progress",
          id: request.id,
          value: { delta: "one" },
        });
        port.postMessage({
          type: "response",
          id: request.id,
          ok: { value: "complete" },
        });
      });
      port?.start();
    },
  } as unknown as Window;
  unregisters.push(
    registerBackground(targetSource, "hello"),
  );
  const progress: JsonValue[] = [];

  await expect(
    routeToolCall(
      {
        target: "app:hello:background",
        name: "echo",
        arguments: { value: "input" },
      },
      caller,
      (value) => progress.push(value),
    ),
  ).resolves.toEqual({ value: "complete" });
  expect(progress).toEqual([{ delta: "one" }]);
});

test("a background endpoint can call a live tile tool in its own app", async () => {
  const fakeWindow = installFakeWindow();
  const callerSource = {} as Window;
  unregisters.push(
    registerBackground(callerSource, "hello"),
  );
  const caller = getRegisteredEndpoint("app:hello:background");
  if (!caller) throw new Error("Background endpoint did not register");
  const targetSource = createToolEndpoint(fakeWindow, echoDescriptor, {
    value: "tile-called",
  });
  registerTile(targetSource, "hello", "target");
  expect(connectFrameEndpoint(targetSource)).toBe(true);

  await expect(
    routeToolCall(
      {
        target: "app:hello:tile:main:instance:target",
        name: "echo",
        arguments: { value: "input" },
      },
      caller,
    ),
  ).resolves.toEqual({ value: "tile-called" });
});

test("cross-app calls require and honor an explicit session grant", async () => {
  const fakeWindow = installFakeWindow();
  const caller = registerTile({} as Window, "gemma", "caller");
  const targetSource = createToolEndpoint(fakeWindow, echoDescriptor, {
    value: "allowed",
  });
  unregisters.push(
    registerBackground(targetSource, "notes"),
  );
  const target = "app:notes:background" as const;
  const denied = routeToolCall(
    { target, name: "echo", arguments: { value: "private" } },
    caller,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = Object.values(
    useMsgBusPermissionStore.getState().requests,
  )[0];
  expect(request).toMatchObject({
    caller: { appId: "gemma" },
    target,
    tool: "echo",
    arguments: { value: "private" },
  });
  rejectFrontendToolRequest(request!.cid);
  await expect(denied).rejects.toThrow("User rejected frontend tool access");

  grantFrontendToolSession("gemma", target, "echo");
  await expect(
    routeToolCall(
      { target, name: "echo", arguments: { value: "private" } },
      caller,
    ),
  ).resolves.toEqual({ value: "allowed" });
});

test("a cross-app tray call retains tray provenance in explicit consent", async () => {
  const fakeWindow = installFakeWindow();
  const caller = registerTray({} as Window, "mail", "panel-one");
  const targetSource = createToolEndpoint(fakeWindow, echoDescriptor, {
    value: "approved",
  });
  unregisters.push(
    registerBackground(targetSource, "notes"),
  );
  const target = "app:notes:background" as const;
  const pending = routeToolCall(
    { target, name: "echo", arguments: { value: "cross app" } },
    caller,
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = Object.values(
    useMsgBusPermissionStore.getState().requests,
  )[0];
  expect(request).toMatchObject({
    caller: {
      endpoint: "app:mail:tray:instance:panel-one",
      appId: "mail",
      role: "tray",
    },
    target,
    tool: "echo",
    arguments: { value: "cross app" },
  });
  approveFrontendToolRequest(request!.cid, "once");
  await expect(pending).resolves.toEqual({ value: "approved" });
});

test("approved grants are invalidated when either endpoint reconnects", async () => {
  const caller = {
    endpoint: "app:gemma:background",
    appId: "gemma",
    role: "background" as const,
  };
  const pending = requestFrontendToolPermission({
    caller,
    callerSessionId: "caller-session-one",
    target: "app:notes:background",
    targetSessionId: "target-session-one",
    tool: "echo",
    sessionOnly: true,
  });
  const request = Object.values(
    useMsgBusPermissionStore.getState().requests,
  )[0];
  approveFrontendToolRequest(request!.cid, "session");
  await expect(pending).resolves.toBeUndefined();

  expect(
    hasFrontendToolGrant(
      caller,
      "caller-session-one",
      "app:notes:background",
      "target-session-one",
      "echo",
    ),
  ).toBe(true);
  expect(
    hasFrontendToolGrant(
      caller,
      "caller-session-two",
      "app:notes:background",
      "target-session-one",
      "echo",
    ),
  ).toBe(false);
  expect(
    hasFrontendToolGrant(
      caller,
      "caller-session-one",
      "app:notes:background",
      "target-session-two",
      "echo",
    ),
  ).toBe(false);
});

test("unknown windows cannot invoke kernel bus actions", async () => {
  await expect(
    executeExposedAction(
      "tools.call",
      { target: "kernel", name: "apps.list", arguments: {} },
      { source: {} as Window, origin: "null" },
    ),
  ).rejects.toThrow("Unknown app endpoint");
});

test("removed raw canister actions are not registered", () => {
  const context = { source: {} as Window, origin: "null" };
  expect(() =>
    executeExposedAction(
      "schema",
      { canister: "aaaaa-aa", method: "hello" },
      context,
    ),
  ).toThrow("Unknown action 'schema'");
  expect(() =>
    executeExposedAction(
      "call_dialog",
      { canister: "aaaaa-aa", method: "hello", args: [] },
      context,
    ),
  ).toThrow("Unknown action 'call_dialog'");
});

test("updated and uninstalled app versions invalidate their live endpoints", async () => {
  const source = {} as Window;
  const unregister = registerFrameContext(
    source,
    {
      role: "tile",
      appId: "hello",
      tileId: "main",
      instanceId: "old",
      workspace: 1,
    },
    { appVersion: 100, origin: "null" },
  );
  unregisters.push(unregister);
  useAppsStore.setState({
    list: {
      hello: registryApp({ id: "hello", name: "Hello", version: 101 }),
    },
  });

  await expect(
    executeExposedAction(
      "tools.call",
      { target: "kernel", name: "apps.list", arguments: {} },
      { source, origin: "null" },
    ),
  ).rejects.toThrow("version is no longer current");

  useAppsStore.setState({ list: {}, appInstances: {} });
  await expect(
    executeExposedAction(
      "tools.call",
      { target: "kernel", name: "apps.list", arguments: {} },
      { source, origin: "null" },
    ),
  ).rejects.toThrow("no longer installed");
});

test("same-version reinstalls invalidate their live endpoint generation", async () => {
  const app = registryApp({ id: "hello", name: "Hello", version: 100 });
  useAppsStore.getState().setApps({ hello: app });
  const generation =
    useAppsStore.getState().runtimeGenerations.hello ?? 0;
  const source = {} as Window;
  unregisters.push(
    registerFrameContext(
      source,
      {
        role: "tile",
        appId: "hello",
        tileId: "main",
        instanceId: "same-version",
        workspace: 1,
      },
      { appVersion: 100, appGeneration: generation, origin: "null" },
    ),
  );

  useAppsStore.getState().setApps({ hello: { ...app } });
  expect(useAppsStore.getState().runtimeGenerations.hello).toBe(generation);

  useAppsStore.getState().setApps(
    { hello: app },
    { invalidateAppIds: ["hello"] },
  );

  await expect(
    executeExposedAction(
      "tools.call",
      { target: "kernel", name: "apps.list", arguments: {} },
      { source, origin: "null" },
    ),
  ).rejects.toThrow("generation is no longer current");
});

test("private tray, connection, and browser-wallet actions are not model-visible", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "gemma", "caller");
  const names = (await listTargetTools("kernel", caller)).map(
    (tool) => tool.name,
  );

  expect(names.some((name) => name.startsWith("tray."))).toBe(false);
  expect(names).not.toContain("tray.set_state");
  expect(names).not.toContain("tray.dismiss");
  expect(names.some((name) => name.startsWith("connections."))).toBe(false);
  expect(names.some((name) => name.startsWith("ethereum_provider."))).toBe(
    false,
  );
  expect(names).not.toContain("canister.query_self");
  expect(names).not.toContain("canister.update_self");
});

test("install offers expose only the closed URL union and redact invalid-call audits", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "gemma", "caller");
  const descriptor = (await listTargetTools("kernel", caller)).find(
    (tool) => tool.name === "apps.install_offer",
  );
  if (!descriptor) throw new Error("Install-offer tool was not discoverable");
  const schema = descriptor.inputSchema as {
    oneOf?: Array<{
      required?: unknown;
      properties?: Record<string, { const?: unknown }>;
      additionalProperties?: unknown;
    }>;
  };
  expect(schema.oneOf).toHaveLength(2);
  expect(
    schema.oneOf?.map((option) => option.properties?.kind?.const),
  ).toEqual(["package_url", "repository_setup_url"]);
  for (const option of schema.oneOf ?? []) {
    expect(option.required).toEqual(["kind", "url"]);
    expect(Object.keys(option.properties ?? {}).sort()).toEqual([
      "kind",
      "url",
    ]);
    expect(option.additionalProperties).toBe(false);
  }
  expect(JSON.stringify(descriptor.inputSchema)).not.toContain("digest");

  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "apps.install_offer",
        arguments: {
          kind: "package_url",
          url: "https://packages.example/mail.neutron?token=audit-secret",
          digest: "caller-supplied-digest",
        },
      },
      caller,
    ),
  ).rejects.toThrow();
  const audit = listMsgBusAudit().at(-1);
  expect(audit).toMatchObject({
    tool: "apps.install_offer",
    status: "error",
    arguments: {
      kind: "package_url",
      source: "https://packages.example/mail.neutron",
    },
  });
  expect(JSON.stringify(audit)).not.toContain("audit-secret");
  expect(JSON.stringify(audit)).not.toContain("caller-supplied-digest");
});

test("direct install offers require focus and activation before presenting owner UI", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const source = {
    postMessage(
      _message: unknown,
      _targetOrigin: string,
      _transfer: Transferable[],
    ) {},
  } as unknown as Window;
  const caller = registerTile(source, "mail", "caller");
  expect(connectFrameEndpoint(source)).toBe(true);
  const offer = {
    target: "kernel" as const,
    name: "apps.install_offer",
    arguments: {
      kind: "package_url",
      url: "https://packages.example/mail.neutron?token=success-secret",
    },
  };

  setTransientUserActivation(true);
  await expect(routeToolCall(offer, caller)).rejects.toMatchObject({
    code: "USER_INTERACTION_REQUIRED",
  });

  useWorkspaceStore.setState((state) => ({
    workspaces: {
      ...state.workspaces,
      1: {
        ...state.workspaces[1],
        focusedTileId: "caller",
      },
    },
  }));
  setTransientUserActivation(false);
  await expect(routeToolCall(offer, caller)).rejects.toMatchObject({
    code: "USER_INTERACTION_REQUIRED",
  });

  setTransientUserActivation(true);
  const staleRouted = routeToolCall(offer, caller);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stalePending = useInstallOfferStore.getState().pending;
  expect(stalePending).toMatchObject({
    requester: {
      kind: "app",
      appId: "mail",
      appName: "mail",
      surface: "tile",
    },
    offer: {
      kind: "package_url",
      url: "https://packages.example/mail.neutron?token=success-secret",
    },
  });
  if (!stalePending) {
    throw new Error("Install-offer prompt was not presented");
  }

  expect(connectFrameEndpoint(source)).toBe(true);
  await expect(staleRouted).rejects.toMatchObject({
    code: "REQUEST_CANCELLED",
  });
  expect(useInstallOfferStore.getState().pending).toBeNull();

  const routed = routeToolCall(offer, caller);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = useInstallOfferStore.getState().pending;
  if (!pending) {
    throw new Error("Replacement install-offer prompt was not presented");
  }

  globalThis.fetch = Object.assign(
    async () => {
      throw new Error("Expected install-offer test transport stop");
    },
    { preconnect() {} },
  );
  approveInstallOffer(pending.requestId);
  await expect(routed).resolves.toEqual({
    presented: true,
    requestId: pending.requestId,
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!useAppsStore.getState().operationBusy) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(useAppsStore.getState().operationBusy).toBe(false);
  useAppsStore.getState().setInstallError(null);
  const audit = listMsgBusAudit().at(-1);
  expect(audit).toMatchObject({
    tool: "apps.install_offer",
    status: "ok",
    arguments: {
      kind: "package_url",
      source: "https://packages.example/mail.neutron",
    },
  });
  expect(JSON.stringify(audit)).not.toContain("success-secret");
});

test("a scoped agent invocation presents an owner-attributed install offer", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const appId = "install_agent";
  const installationUid = "101";
  const app = registryApp({
    id: appId,
    name: "Install Agent",
    version: 100,
  });
  useAppsStore.setState({
    list: { [appId]: app },
    appInstances: {
      [appId]: {
        scope: { appId, installationUid },
        version: app.version,
        deploymentId: "development",
        capabilityPlanFingerprint: app.capability_plan_fingerprint,
        browserOriginNonce: installationUid.padStart(32, "0"),
        browserOriginAuthorityEpoch: "1",
        residentFrameSecurity: "credentialless_opaque_v1",
      },
    },
  });

  const connectedSource = (): Window =>
    ({
      postMessage(
        _message: unknown,
        _targetOrigin: string,
        _transfer: Transferable[],
      ) {},
    }) as unknown as Window;
  const tileSource = connectedSource();
  const backgroundSource = connectedSource();
  unregisters.push(
    registerFrameContext(
      tileSource,
      {
        role: "tile",
        appId,
        tileId: "chat",
        instanceId: "root",
        workspace: 1,
      },
      {
        appScope: { appId, installationUid },
        origin: "null",
      },
    ),
  );
  unregisters.push(
    registerFrameContext(
      backgroundSource,
      { role: "background", appId },
      {
        appScope: { appId, installationUid },
        origin: "null",
      },
    ),
  );
  expect(connectFrameEndpoint(tileSource)).toBe(true);
  expect(connectFrameEndpoint(backgroundSource)).toBe(true);
  const tile = getRegisteredEndpoint(
    `app:${appId}:tile:chat:instance:root`,
  );
  const resident = getRegisteredEndpoint(`app:${appId}:background`);
  if (!tile || !resident) throw new Error("Agent endpoints did not register");

  const grant = requestAgentGrant({
    appId,
    appName: app.name,
    version: app.version,
    installationUid,
    entrypoint: "run",
    ownerPrincipal: "owner-principal",
  });
  approveAgentGrant();
  await grant;
  const root = beginAgentRoot({
    caller: tile,
    target: resident,
    tool: "run",
    ownerPrincipal: "owner-principal",
    installedVersion: app.version,
    activated: true,
  });
  if (!root) throw new Error("Agent root did not start");

  const routed = routeToolCall(
    {
      target: "kernel",
      name: "apps.install_offer",
      arguments: {
        kind: "package_url",
        url: "https://packages.example/agent-offer.neutron",
      },
    },
    resident,
    undefined,
    invocationMetadata(root, true),
  );
  void routed.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = useInstallOfferStore.getState().pending;
  expect(pending).toMatchObject({
    requester: {
      kind: "agent",
      appId,
      appName: "Install Agent",
      rootAppId: appId,
      rootAppName: "Install Agent",
      entrypoint: "run",
      tool: "run",
      rootId: root.rootId,
    },
    offer: {
      kind: "package_url",
      url: "https://packages.example/agent-offer.neutron",
    },
  });
  if (!pending) throw new Error("Agent install-offer prompt was not presented");
  expect(JSON.stringify(pending)).not.toContain(root.capability);
  rejectInstallOffer(pending.requestId);
  await expect(routed).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  completeInvocation(root);
});

test("endpoint discovery reports the exact transient tray instance", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "gemma", "caller");
  registerTray({} as Window, "mail", "panel-seven");

  const result = await routeToolCall(
    { target: "kernel", name: "endpoints.list", arguments: {} },
    caller,
  );
  expect(result).toMatchObject({
    endpoints: expect.arrayContaining([
      {
        endpoint: "app:mail:tray:instance:panel-seven",
        appId: "mail",
        role: "tray",
        connected: false,
        instanceId: "panel-seven",
      },
    ]),
  });
});

test("delegated tool discovery cannot target a transient tray endpoint", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "agent", "caller");
  const tray = registerTray({} as Window, "mail", "panel-one");

  await expect(
    listTargetTools(
      tray.endpointId as `app:${string}:tray:instance:${string}`,
      caller,
      {} as never,
    ),
  ).rejects.toMatchObject({ code: "INVOCATION_INVALID" });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("delegated backend consent includes source, reservation state, and complete call arguments", () => {
  expect(
    backendAccessAgentAction({
      endpoint: "app:chess:tile:chess:instance:game-one",
      source: {
        role: "tile",
        tileId: "chess",
        instanceId: "game-one",
        workspace: 2,
      },
      actions: [
        {
          kind: "reserve",
          scope: {
            kind: "exact",
            principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            method: "app_chess__chess_remote_exchange_v1",
          },
          reservationPresentAtRequest: false,
        },
      ],
      call: {
        method: "chess_remote_join_v1",
        args: [
          {
            tileId: "game-one",
            gameId: "game-7",
            host: "ryjl3-tyaaa-aaaaa-aaaba-cai",
          },
        ],
        binaryFields: [
          {
            path: "args[0].avatar",
            byteLength: 3,
            sha256: "a".repeat(64),
          },
        ],
      },
    }),
  ).toEqual({
    endpoint: "app:chess:tile:chess:instance:game-one",
    requestingSurface: {
      role: "tile",
      tileId: "chess",
      instanceId: "game-one",
      workspace: 2,
    },
    actions: [
      {
        kind: "reserve",
        scope: {
          kind: "exact",
          principal: "ryjl3-tyaaa-aaaaa-aaaba-cai",
          method: "app_chess__chess_remote_exchange_v1",
        },
        reservationPresentAtRequest: false,
      },
    ],
    thenCall: {
      method: "chess_remote_join_v1",
      args: [
        {
          tileId: "game-one",
          gameId: "game-7",
          host: "ryjl3-tyaaa-aaaaa-aaaba-cai",
        },
      ],
      binaryFields: [
        {
          path: "args[0].avatar",
          byteLength: 3,
          sha256: "a".repeat(64),
        },
      ],
    },
  });
});

test("kernel discovery fails closed on non-canonical installed app metadata", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "gemma", "caller");
  useAppsStore.setState({
    list: {
      notes: {
        ...registryApp({
          id: "notes",
          name: "Notes",
          version: 102,
          background: { path: "service.html" },
        }),
        description: "Search\u200b notes\u061c",
      },
    },
  });

  await expect(
    routeToolCall(
      { target: "kernel", name: "apps.list", arguments: {} },
      caller,
    ),
  ).rejects.toThrow("Invalid installed app metadata");
});

test("approved kernel tool calls open tiles only in the current workspace", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "gemma", "caller");
  useAppsStore.setState({
    list: {
      hello: registryApp({
        id: "hello",
        name: "Hello",
        tiles: [
          {
            id: "main",
            title: "Hello",
            path: "index.html",
            icon: "static/icon.png",
          },
        ],
      }),
    },
  });
  grantFrontendToolSession("gemma", "kernel", "workspace.open_tile");

  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "workspace.open_tile",
        arguments: { appId: "hello", tileId: "main", workspace: 1 },
      },
      caller,
    ),
  ).resolves.toMatchObject({ workspace: 1, opened: true });
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(1);
  expect(useWorkspaceStore.getState().workspaces[1].tiles).toHaveLength(1);
  expect(useWorkspaceStore.getState().workspaces[1].tiles[0]).toMatchObject({
    appId: "hello",
    tileId: "main",
  });
});

test("approved calls reuse an existing app tile in the current workspace", async () => {
  installFakeWindow();
  const callerInstance = useWorkspaceStore.getState().openTile({
    appId: "gemma",
    tileId: "main",
    title: "Gemma",
    path: "index.html",
    icon: "/app/gemma/static/icon.svg",
  });
  const caller = registerTile({} as Window, "gemma", callerInstance.id);
  useAppsStore.setState({
    list: {
      hello: registryApp({
        id: "hello",
        name: "Hello",
        tiles: [
          {
            id: "main",
            title: "Hello",
            path: "index.html",
            icon: "static/icon.png",
          },
        ],
      }),
    },
  });
  const existing = useWorkspaceStore.getState().openTile({
    appId: "hello",
    tileId: "main",
    title: "Hello",
    path: "index.html",
    icon: "/app/hello/static/icon.png",
  });
  useWorkspaceStore.getState().focusTile(callerInstance.id);
  grantFrontendToolSession("gemma", "kernel", "workspace.open_tile");

  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "workspace.open_tile",
        arguments: {
          appId: "hello",
          tileId: "main",
          reuseExisting: true,
        },
      },
      caller,
    ),
  ).resolves.toEqual({
    instanceId: existing.id,
    workspace: 1,
    opened: false,
  });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(1);
  expect(useWorkspaceStore.getState().workspaces[1].focusedTileId).toBe(
    existing.id,
  );
});

test("opening a missing reusable tile requires once-only consent", async () => {
  installFakeWindow();
  const callerInstance = useWorkspaceStore.getState().openTile({
    appId: "wallet",
    tileId: "wallet",
    title: "Wallet",
    path: "index.html",
    icon: "/app/wallet/static/icon.svg",
  });
  const caller = registerTile({} as Window, "wallet", callerInstance.id);
  useAppsStore.setState({
    list: {
      contacts: registryApp({
        id: "contacts",
        name: "Contacts",
        tiles: [
          {
            id: "contacts",
            title: "Contacts",
            path: "index.html",
            icon: "static/icon.svg",
          },
        ],
      }),
    },
  });

  const pending = routeToolCall(
    {
      target: "kernel",
      name: "workspace.open_tile",
      arguments: {
        appId: "contacts",
        tileId: "contacts",
        reuseExisting: true,
        view: "create",
      },
    },
    caller,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = Object.values(
    useMsgBusPermissionStore.getState().requests,
  )[0];
  expect(request).toMatchObject({
    tool: "workspace.open_tile",
    onceOnly: true,
    arguments: { appId: "contacts", tileId: "contacts", view: "create" },
  });
  approveFrontendToolRequest(request!.cid, "once");

  await expect(pending).resolves.toMatchObject({ opened: true, workspace: 1 });
  expect(useWorkspaceStore.getState().workspaces[1].tiles).toHaveLength(2);
});
