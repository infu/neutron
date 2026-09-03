import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { QueryResponseStatus, type Agent } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import {
  isJsonObject,
  msgBusLocalActions,
  NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
  NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
  NEUTRON_TOOL_VISIBILITY_SAME_APP,
  type ExecEnvelope,
  type JsonObject,
  type JsonValue,
  type MsgBusToolDescriptor,
} from "neutron-tools/protocol";
import { executeExposedAction } from "neutron-tools/kernel";
import { disconnectMsgBus } from "neutron-tools/app";
import {
  connectFrameEndpoint,
  getRegisteredEndpoint,
  installFrameEndpointHandshake,
  isFrameEndpointReady,
  markFrameEndpointLoaded,
  registerFrameContext,
  type RegisteredEndpoint,
} from "../src/frame_context.ts";
import { MSG_BUS_FRAME_READY } from "neutron-tools/src/frame_handshake.js";
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
  callReject,
  removeAllCallRequests,
  useRequestStore,
} from "../src/reducer/request.ts";
import {
  rejectBackendCallRequest,
  useBackendCallConsentStore,
} from "../src/reducer/backend_calls.ts";
import {
  resetUiAttentionState,
  useUiAttentionStore,
} from "../src/ui_attention/owner.ts";
import {
  approveInstallOffer,
  clearInstallOffer,
  rejectInstallOffer,
} from "../src/install_offers/service.ts";
import { useInstallOfferStore } from "../src/install_offers/store.ts";
import {
  approveAgentGrant,
  beginAgentRoot,
  cancelAgentRoot,
  clearAgentModeForAuth,
  completeInvocation,
  createChildInvocation,
  invocationMetadata,
  requestAgentGrant,
  resolveInvocation,
  useAgentModeStore,
} from "../src/ui_attention/agent.ts";
import { registryApp } from "./app_registry_fixture.ts";

const MSG_BUS_ISOLATED_SUCCESS_SENTINEL = "NEUTRON_MSG_BUS_ISOLATED_SUCCESS";

afterAll(() => {
  console.log(MSG_BUS_ISOLATED_SUCCESS_SENTINEL);
});

let validateMethodInputOverride:
  | ((
      target: unknown,
      method: string,
      args: unknown[],
      options?: Record<string, unknown>,
    ) => { ok: boolean; errors?: unknown })
  | undefined;
let explainMethodOptions: Record<string, unknown> | undefined;
let icblastClientCallOverride:
  | ((
      options: Record<string, unknown>,
      canister: string,
      preset: unknown,
    ) => Promise<unknown>)
  | undefined;
const defaultExternalIdlFactory: IDL.InterfaceFactory = ({ IDL: FactoryIDL }) =>
  FactoryIDL.Service({
    hello_world: FactoryIDL.Func(
      [FactoryIDL.Text],
      [FactoryIDL.Null],
      ["query"],
    ),
  });
const defaultExternalMethod = async () => null;

const mockIcblast = Object.assign(
  (options: Record<string, unknown> = {}) =>
    async (canister: string, preset?: unknown) =>
      icblastClientCallOverride
        ? icblastClientCallOverride(options, canister, preset)
        : {
            $idlFactory:
              typeof preset === "function" ? preset : defaultExternalIdlFactory,
            $methods: {
              get: (method: string) =>
                method === "hello_world" ? defaultExternalMethod : undefined,
            },
            hello_world: defaultExternalMethod,
          },
  {
    explainMethodSchema: (
      _target: unknown,
      _method: string,
      options?: Record<string, unknown>,
    ) => {
      explainMethodOptions = options;
      return {};
    },
    toState: (value: unknown) => value,
    validateMethodInput: (
      target: unknown,
      method: string,
      args: unknown[],
      options?: Record<string, unknown>,
    ) =>
      validateMethodInputOverride?.(target, method, args, options) ?? {
        ok: true,
      },
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
    return submitSelfCallUpdate(agent, canisterId, methodName, arg);
  },
}));

type SourceInspectionOperation = "list" | "search" | "read";
type SourceInspectionCall = Readonly<{
  operation: SourceInspectionOperation;
  args: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}>;

const SOURCE_INSPECTION_REVISION = "a".repeat(64);
const sourceInspectionCalls: SourceInspectionCall[] = [];
let sourceInspectionOverride:
  ((call: SourceInspectionCall) => JsonValue | Promise<JsonValue>) | undefined;

function invokeSourceInspection(
  operation: SourceInspectionOperation,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): JsonValue | Promise<JsonValue> {
  const call: SourceInspectionCall = Object.freeze({
    operation,
    args: { ...args },
    ...(signal ? { signal } : {}),
  });
  sourceInspectionCalls.push(call);
  if (sourceInspectionOverride) return sourceInspectionOverride(call);
  if (operation !== "list") {
    throw new Error(`Unexpected mock source inspection operation ${operation}`);
  }
  return {
    appId: String(args.appId),
    appVersion: 100,
    installationUid: "401",
    sourceRevision: SOURCE_INSPECTION_REVISION,
    artifacts: [
      {
        path: "/app/signed_call_agent/source-secret.js",
        area: "frontend",
        readability: "text",
        bytes: 18,
        sha256: "b".repeat(64),
      },
    ],
    complete: true,
    nextCursor: null,
  };
}

mock.module("../src/source_inspection/runtime.ts", () => ({
  installedArtifactInspector: {
    list: (args: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
      invokeSourceInspection("list", args, signal),
    search: (args: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
      invokeSourceInspection("search", args, signal),
    read: (args: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
      invokeSourceInspection("read", args, signal),
  },
}));

const originalWindow = globalThis.window;
const originalNavigator = globalThis.navigator;
const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
const originalHTMLIFrameElement = globalThis.HTMLIFrameElement;
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

const { loadIcRuntimeFixture, TEST_KERNEL_CANISTER_ID } =
  await import("./runtime_fixture.ts");
await loadIcRuntimeFixture();

const [
  {
    backendAccessAgentAction,
    listTargetTools,
    preparedCanisterCallAgentAction,
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
const TEST_FRAME_ORIGIN = "https://installed-app.example";
let activeFakeWindow: FakeWindow | null = null;

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
  installFrameEndpointHandshake(
    fakeWindow as unknown as Pick<Window, "addEventListener">,
  );
  activeFakeWindow = fakeWindow;
  return fakeWindow;
}

type TestTileFrameConfig = Readonly<{
  appId: string;
  tileId: string;
  instanceId: string;
  source: Window;
}>;

type TestFocusDocument = {
  activeElement: TestTileFrame | object | null;
  addFrame(config: TestTileFrameConfig): TestTileFrame;
  querySelectorAll(selector: string): TestTileFrame[];
};

class TestTileFrame {
  readonly dataset: DOMStringMap;
  readonly contentWindow: Window;
  focusCalls = 0;
  blurCalls = 0;
  scrollIntoViewCalls = 0;

  constructor(
    private readonly ownerDocument: TestFocusDocument,
    config: TestTileFrameConfig,
  ) {
    this.dataset = {
      appId: config.appId,
      tileId: config.tileId,
      instanceId: config.instanceId,
    };
    this.contentWindow = config.source;
  }

  focus(): void {
    this.focusCalls += 1;
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    this.blurCalls += 1;
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  scrollIntoView(): void {
    this.scrollIntoViewCalls += 1;
  }
}

function installTestFocusDocument(): TestFocusDocument {
  const frames: TestTileFrame[] = [];
  const focusDocument: TestFocusDocument = {
    activeElement: null,
    addFrame(config) {
      const frame = new TestTileFrame(this, config);
      frames.push(frame);
      return frame;
    },
    querySelectorAll(selector) {
      return selector === "iframe.tile-iframe" ? frames : [];
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: focusDocument,
  });
  Object.defineProperty(globalThis, "HTMLIFrameElement", {
    configurable: true,
    value: TestTileFrame,
  });
  return focusDocument;
}

function authenticateLoadedTestFrame(
  source: Window,
  origin = TEST_FRAME_ORIGIN,
): void {
  const fakeWindow = activeFakeWindow;
  if (!fakeWindow) throw new Error("Test frame window was not installed");
  if (typeof source.postMessage !== "function") {
    Object.defineProperty(source, "postMessage", {
      configurable: true,
      value: () => undefined,
    });
  }
  expect(markFrameEndpointLoaded(source)).toBe("retired");
  fakeWindow.dispatch(MSG_BUS_FRAME_READY, source, origin);
  expect(isFrameEndpointReady(source)).toBe(true);
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
      if (!isJsonObject(message) || message.type !== "neutron:msgbus:connect") {
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

function createCapturingToolEndpoint(
  descriptor: MsgBusToolDescriptor,
  result: JsonValue,
  options: {
    descriptorGate?: Promise<void>;
    resultGate?: Promise<void>;
    resultGates?: readonly Promise<void>[];
  } = {},
): {
  source: Window;
  state: { descriptorRequests: number; calls: number; payloads: JsonValue[] };
} {
  const state = {
    descriptorRequests: 0,
    calls: 0,
    payloads: [] as JsonValue[],
  };
  const source = {
    postMessage(
      message: unknown,
      _origin: string,
      transfer: Transferable[] = [],
    ) {
      if (!isJsonObject(message) || message.type !== "neutron:msgbus:connect") {
        return;
      }
      const port = transfer[0] as MessagePort | undefined;
      if (!port) return;
      port.addEventListener("message", (event) => {
        const request = event.data as ExecEnvelope;
        if (request.type !== "exec") return;
        if (request.payload.action === msgBusLocalActions.toolsList) {
          state.descriptorRequests += 1;
          const respond = () =>
            port.postMessage({
              type: "response",
              id: request.id,
              ok: [descriptor],
            });
          if (options.descriptorGate) void options.descriptorGate.then(respond);
          else respond();
          return;
        }
        if (request.payload.action !== msgBusLocalActions.toolsCall) return;
        state.calls += 1;
        state.payloads.push(request.payload.payload);
        const respond = () =>
          port.postMessage({ type: "response", id: request.id, ok: result });
        const resultGate =
          options.resultGates?.[state.calls - 1] ?? options.resultGate;
        if (resultGate) void resultGate.then(respond);
        else respond();
      });
      port.start();
    },
  } as unknown as Window;
  return { source, state };
}

function createProviderToolEndpoint(
  descriptor: MsgBusToolDescriptor,
  review: Record<string, JsonValue>,
  result: JsonValue,
  options: {
    requestApproval?: boolean;
    catchApprovalError?: boolean;
    approvalExtra?: JsonObject;
    holdAfterApproval?: Promise<void>;
    presentation?: (capability: string) => JsonObject;
    startGate?: Promise<void>;
    secondCallback?: "approval" | "presentation";
  } = {},
): {
  source: Window;
  state: {
    calls: number;
    capability: string | null;
    providerUi: boolean;
    approvalRequests: number;
    cancelled: boolean;
    caughtApprovalError: boolean;
    approvalSucceeded: boolean;
    presentationRequests: number;
    interactionResults: JsonValue[];
    interactionErrors: JsonValue[];
  };
} {
  const state = {
    calls: 0,
    capability: null as string | null,
    providerUi: false,
    approvalRequests: 0,
    cancelled: false,
    caughtApprovalError: false,
    approvalSucceeded: false,
    presentationRequests: 0,
    interactionResults: [] as JsonValue[],
    interactionErrors: [] as JsonValue[],
  };
  let nextRequestId = 10_000;
  type ProviderRequest = {
    outerId: number;
    port: MessagePort;
    context?: ExecEnvelope["payload"]["context"];
    capability: string;
    action: "approval" | "presentation";
    second: boolean;
  };
  const pending = new Map<number, ProviderRequest>();
  const sendInteraction = (request: ProviderRequest): void => {
    const id = ++nextRequestId;
    pending.set(id, request);
    if (request.action === "approval") state.approvalRequests += 1;
    else state.presentationRequests += 1;
    request.port.postMessage({
      type: "exec",
      id,
      payload: {
        action:
          request.action === "approval"
            ? "provider_approval.request"
            : "provider_ui.present",
        payload:
          request.action === "approval"
            ? {
                ...(options.approvalExtra ?? {}),
                capability: request.capability,
                review,
              }
            : options.presentation!(request.capability),
        ...(request.context ? { context: request.context } : {}),
      },
    } satisfies ExecEnvelope);
  };
  const source = {
    postMessage(
      message: unknown,
      _origin: string,
      transfer: Transferable[] = [],
    ) {
      if (!isJsonObject(message) || message.type !== "neutron:msgbus:connect") {
        return;
      }
      const port = transfer[0] as MessagePort | undefined;
      if (!port) return;
      port.addEventListener("message", (event) => {
        const incoming = event.data as {
          type?: unknown;
          id?: unknown;
          ok?: JsonValue;
          error?: JsonValue;
          payload?: {
            action?: unknown;
            payload?: JsonValue;
            context?: ExecEnvelope["payload"]["context"];
          };
        };
        if (incoming.type === "neutron:msgbus:cancel") {
          state.cancelled = true;
          return;
        }
        if (incoming.type === "response" && typeof incoming.id === "number") {
          const request = pending.get(incoming.id);
          if (!request) return;
          pending.delete(incoming.id);
          const failed = Object.hasOwn(incoming, "error");
          if (failed) state.interactionErrors.push(incoming.error ?? null);
          else state.interactionResults.push(incoming.ok ?? null);
          if (failed && options.catchApprovalError) {
            state.caughtApprovalError = true;
          }
          const settleHandler = () =>
            request.port.postMessage({
              type: "response",
              id: request.outerId,
              ...(failed && !request.second && !options.catchApprovalError
                ? { error: incoming.error ?? null }
                : { ok: result }),
            });
          if (!failed) {
            state.approvalSucceeded = true;
            if (!request.second && options.secondCallback) {
              sendInteraction({
                ...request,
                action: options.secondCallback,
                second: true,
              });
              return;
            }
            if (options.holdAfterApproval) {
              void options.holdAfterApproval.then(settleHandler);
              return;
            }
          }
          settleHandler();
          return;
        }
        if (
          incoming.type !== "exec" ||
          typeof incoming.id !== "number" ||
          !incoming.payload
        ) {
          return;
        }
        if (incoming.payload.action === msgBusLocalActions.toolsList) {
          port.postMessage({
            type: "response",
            id: incoming.id,
            ok: [descriptor],
          });
          return;
        }
        if (incoming.payload.action !== msgBusLocalActions.toolsCall) return;
        state.calls += 1;
        const callPayload = incoming.payload.payload;
        state.providerUi =
          isJsonObject(callPayload) && callPayload.providerUi === true;
        const providerApproval =
          isJsonObject(callPayload) && isJsonObject(callPayload.providerApproval)
            ? callPayload.providerApproval
            : null;
        state.capability =
          providerApproval && typeof providerApproval.capability === "string"
            ? providerApproval.capability
            : null;
        if (options.requestApproval === false) {
          port.postMessage({ type: "response", id: incoming.id, ok: result });
          return;
        }
        if (!state.capability) {
          port.postMessage({
            type: "response",
            id: incoming.id,
            error: { name: "Error", message: "Approval callback unavailable" },
          });
          return;
        }
        const request: ProviderRequest = {
          outerId: incoming.id,
          port,
          ...(incoming.payload.context
            ? { context: incoming.payload.context }
            : {}),
          capability: state.capability,
          action: options.presentation ? "presentation" : "approval",
          second: false,
        };
        if (options.startGate) {
          void options.startGate.then(() => sendInteraction(request));
        } else {
          sendInteraction(request);
        }
      });
      port.start();
    },
  } as unknown as Window;
  return { source, state };
}

function createAgentConsentEndpoint(
  decision: "allow" | "deny" = "allow",
  options: { decisionGate?: Promise<void> } = {},
): {
  source: Window;
  challenges: JsonValue[];
} {
  const challenges: JsonValue[] = [];
  const source = {
    postMessage(
      message: unknown,
      _origin: string,
      transfer: Transferable[] = [],
    ) {
      if (!isJsonObject(message) || message.type !== "neutron:msgbus:connect") {
        return;
      }
      const port = transfer[0] as MessagePort | undefined;
      if (!port) return;
      port.addEventListener("message", (event) => {
        const request = event.data as ExecEnvelope;
        if (
          request.type !== "exec" ||
          request.payload.action !== msgBusLocalActions.agentConsentDecide
        ) {
          return;
        }
        challenges.push(request.payload.payload);
        const respond = () =>
          port.postMessage({
            type: "response",
            id: request.id,
            ok: {
              decision,
              reason:
                decision === "allow"
                  ? "Exact provider action accepted"
                  : "Exact provider action denied",
            },
          });
        if (options.decisionGate) void options.decisionGate.then(respond);
        else respond();
      });
      port.start();
    },
  } as unknown as Window;
  return { source, challenges };
}

function focusTestTile(instanceId: string): void {
  useWorkspaceStore.setState((state) => ({
    workspaces: {
      ...state.workspaces,
      1: {
        ...state.workspaces[1],
        focusedTileId: instanceId,
      },
    },
  }));
}

function installWorkspaceOpenTarget() {
  useAppsStore.setState((state) => ({
    list: {
      ...state.list,
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
  }));
  return useWorkspaceStore.getState().openTile({
    appId: "hello",
    tileId: "main",
    title: "Hello",
    path: "index.html",
    icon: "static/icon.png",
  });
}

function openWorkspaceTarget(caller: RegisteredEndpoint): Promise<JsonValue> {
  return routeToolCall(
    {
      target: "kernel",
      name: "workspace.open_tile",
      arguments: { appId: "hello", tileId: "main", reuseExisting: true },
    },
    caller,
  );
}

function registerScopedBackgroundEndpoint(
  source: Window,
  appId: string,
  installationUid: string,
  tileId?: string,
) {
  const app = registryApp({
    id: appId,
    name: appId,
    version: 100,
    background: { path: "service.html" },
    ...(tileId
      ? {
          tiles: [
            {
              id: tileId,
              title: `${appId} review`,
              path: "index.html",
              icon: "static/icon.svg",
            },
          ],
        }
      : {}),
  });
  const appScope = { appId, installationUid };
  useAppsStore.setState((state) => ({
    list: { ...state.list, [appId]: app },
    appInstances: {
      ...state.appInstances,
      [appId]: {
        scope: appScope,
        version: app.version,
        deploymentId: "development",
        capabilityPlanFingerprint: app.capability_plan_fingerprint,
        browserOriginNonce: installationUid.padStart(32, "0"),
        browserOriginAuthorityEpoch: "1",
        residentFrameSecurity: "credentialless_opaque_v1",
      },
    },
  }));
  unregisters.push(
    registerFrameContext(
      source,
      { role: "background", appId },
      {
        appVersion: app.version,
        appScope,
        origin: TEST_FRAME_ORIGIN,
      },
    ),
  );
  authenticateLoadedTestFrame(source);
  const endpoint = getRegisteredEndpoint(`app:${appId}:background`);
  if (!endpoint) throw new Error(`${appId} endpoint did not register`);
  return endpoint as typeof endpoint & { appScope: typeof appScope };
}

function registerScopedTileEndpoint(
  source: Window,
  appId: string,
  tileId: string,
  instanceId: string,
  appScope: { appId: string; installationUid: string },
  options: { connect?: boolean } = {},
) {
  const app = useAppsStore.getState().list[appId];
  if (!app) throw new Error(`${appId} is not installed`);
  unregisters.push(
    registerFrameContext(
      source,
      { role: "tile", appId, tileId, instanceId, workspace: 1 },
      {
        appVersion: app.version,
        appScope,
        origin: TEST_FRAME_ORIGIN,
      },
    ),
  );
  if (options.connect !== false) authenticateLoadedTestFrame(source);
  const endpoint = getRegisteredEndpoint(
    `app:${appId}:tile:${tileId}:instance:${instanceId}`,
  );
  if (!endpoint) throw new Error(`${appId} tile endpoint did not register`);
  return endpoint;
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
    { origin: TEST_FRAME_ORIGIN },
  );
  unregisters.push(unregister);
  authenticateLoadedTestFrame(source);
  const endpoint = getRegisteredEndpoint(
    `app:${appId}:tile:main:instance:${instanceId}`,
  );
  if (!endpoint) throw new Error("Endpoint did not register");
  return endpoint;
}

function registerDirectTilePort(
  appId: string,
  instanceId: string,
): MessagePort {
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
  registerTile(source, appId, instanceId);
  if (!appPort) throw new Error("App port was not transferred");
  appPort.start();
  return appPort;
}

function registerTray(source: Window, appId: string, instanceId: string) {
  ensureTestApp(appId);
  const unregister = registerFrameContext(
    source,
    { role: "tray", appId, instanceId },
    { origin: TEST_FRAME_ORIGIN },
  );
  unregisters.push(unregister);
  authenticateLoadedTestFrame(source);
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
    { origin: TEST_FRAME_ORIGIN },
  );
  authenticateLoadedTestFrame(source);
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

const EXTERNAL_CALL_TEST_CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";

function installExternalCallTarget(
  method = "hello_world",
  ownerBindingGate?: Promise<void>,
  includeMethodRegistry = true,
  canonicalize = (args: unknown[]): unknown[] => args,
): {
  discoveryCalls: number;
  anonymousDiscoveryCalls: number;
  ownerDiscoveryCalls: number;
  ownerActorBindings: number;
  prepareCalls: number;
  ownerMethodCalls: number;
  ownerMethodArgs: unknown[][];
} {
  const counts = {
    discoveryCalls: 0,
    anonymousDiscoveryCalls: 0,
    ownerDiscoveryCalls: 0,
    ownerActorBindings: 0,
    prepareCalls: 0,
    ownerMethodCalls: 0,
    ownerMethodArgs: [] as unknown[][],
  };
  const idlFactory: IDL.InterfaceFactory = ({ IDL: FactoryIDL }) =>
    FactoryIDL.Service({
      [method]: FactoryIDL.Func(
        [FactoryIDL.Text],
        [FactoryIDL.Text],
        ["query"],
      ),
    });
  icblastClientCallOverride = async (options, canister, preset) => {
    expect(canister).toBe(EXTERNAL_CALL_TEST_CANISTER);
    if (preset === undefined) {
      counts.discoveryCalls += 1;
      if (options.allowNumberedPrincipals === false) {
        counts.anonymousDiscoveryCalls += 1;
        return { $idlFactory: idlFactory };
      }
      counts.ownerDiscoveryCalls += 1;
    }
    if (preset !== undefined) expect(preset).toBe(idlFactory);
    counts.ownerActorBindings += 1;
    if (ownerBindingGate) await ownerBindingGate;
    const ownerMethod = async (...methodArgs: unknown[]) => {
      counts.ownerMethodCalls += 1;
      counts.ownerMethodArgs.push(methodArgs);
      return `Hello, ${String(methodArgs[0])}`;
    };
    Object.defineProperty(ownerMethod, "prepare", {
      value: async (...methodArgs: unknown[]) => {
        counts.prepareCalls += 1;
        const canonicalArgs = Object.freeze(canonicalize(methodArgs));
        return Object.freeze({
          args: canonicalArgs,
          invoke: () => ownerMethod(...canonicalArgs),
        });
      },
    });
    const methods = new Map([[method, ownerMethod]]);
    return {
      $idlFactory: idlFactory,
      ...(includeMethodRegistry
        ? { $methods: { get: methods.get.bind(methods) } }
        : {}),
      ...(method === "then" ? {} : { [method]: ownerMethod }),
    };
  };
  return counts;
}

async function beginExternalSignedCall(
  caller: Parameters<typeof routeToolCall>[1],
  method = "hello_world",
  tool = "canister.call_dialog",
  args: JsonValue[] = ["Alice"],
): Promise<{ cid: string; result: Promise<JsonValue> }> {
  const result = routeToolCall(
    {
      target: "kernel",
      name: tool,
      arguments: {
        canister: EXTERNAL_CALL_TEST_CANISTER,
        method,
        args,
      },
    },
    caller,
  );
  for (
    let turn = 0;
    turn < 20 && Object.keys(useRequestStore.getState().calls).length === 0;
    turn += 1
  ) {
    await Promise.resolve();
  }
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing signed-call approval request");
  return { cid, result };
}

async function beginSignedCallAgentInvocation(
  backgroundSource: Window = {} as Window,
) {
  const appId = "signed_call_agent";
  const installationUid = "401";
  const installed = registryApp({
    id: appId,
    name: "Signed Call Agent",
    version: 100,
    background: { path: "background.html" },
    capabilities: {
      agent_entrypoints: { api: 1, entrypoints: ["run"] },
    },
  });
  const appScope = { appId, installationUid };
  useAppsStore.setState({
    list: { [appId]: installed },
    appInstances: {
      [appId]: {
        scope: appScope,
        version: installed.version,
        deploymentId: "development",
        capabilityPlanFingerprint: installed.capability_plan_fingerprint,
        browserOriginNonce: installationUid.padStart(32, "0"),
        browserOriginAuthorityEpoch: "1",
        residentFrameSecurity: "credentialless_opaque_v1",
      },
    },
  });

  const tileSource = {} as Window;
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
      { appScope, origin: TEST_FRAME_ORIGIN },
    ),
    registerFrameContext(
      backgroundSource,
      { role: "background", appId },
      { appScope, origin: TEST_FRAME_ORIGIN },
    ),
  );
  authenticateLoadedTestFrame(tileSource);
  authenticateLoadedTestFrame(backgroundSource);
  const tile = getRegisteredEndpoint(`app:${appId}:tile:chat:instance:root`);
  const resident = getRegisteredEndpoint(`app:${appId}:background`);
  if (!tile || !resident) throw new Error("Agent endpoints did not register");

  const grant = requestAgentGrant({
    appId,
    appName: installed.name,
    version: installed.version,
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
    installedVersion: installed.version,
  });
  if (!root) throw new Error("Agent root did not start");
  return { resident, root };
}

test.each([
  {
    transition: "logout",
    auth: {
      logged: false,
      authorized: false,
      principal: "2vxsx-fae",
    },
  },
  {
    transition: "identity switch",
    auth: {
      logged: true,
      authorized: true,
      principal: "other-owner-principal",
    },
  },
  {
    transition: "same-principal relogin",
    auth: {
      logged: true,
      authorized: true,
      principal: "owner-principal",
    },
  },
])("an auth $transition synchronously revokes Agent authority", async ({ auth }) => {
  installFakeWindow();
  authorizeTestOwner("owner-principal");
  const { resident, root } = await beginSignedCallAgentInvocation();
  expect(useAgentModeStore.getState().grant).not.toBeNull();
  expect(useAgentModeStore.getState().activeRoot).not.toBeNull();

  const generation = useAuthStore.getState().sessionGeneration;
  useAuthStore.getState().setAuth(auth);

  expect(useAuthStore.getState().sessionGeneration).toBe(generation + 1);
  expect(useAgentModeStore.getState().grant).toBeNull();
  expect(useAgentModeStore.getState().activeRoot).toBeNull();
  expect(() =>
    resolveInvocation(resident, invocationMetadata(root, true)),
  ).toThrow("Invalid invocation context");
});

afterEach(() => {
  selfCallTarget = undefined;
  selfCallAgent = undefined;
  submitSelfCallUpdate = undefined;
  validateMethodInputOverride = undefined;
  explainMethodOptions = undefined;
  icblastClientCallOverride = undefined;
  sourceInspectionCalls.length = 0;
  sourceInspectionOverride = undefined;
  activeFakeWindow = null;
  clearInstallOffer("Test cleanup");
  removeAllCallRequests();
  for (const request of Object.values(
    useBackendCallConsentStore.getState().requests,
  )) {
    rejectBackendCallRequest(request.id);
  }
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
      workspaceIds
        .slice(0, 3)
        .map((id) => [
          id,
          { id, layout: null, tiles: [], focusedTileId: null },
        ]),
    ) as unknown as ReturnType<typeof useWorkspaceStore.getState>["workspaces"],
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
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  Object.defineProperty(globalThis, "HTMLIFrameElement", {
    configurable: true,
    value: originalHTMLIFrameElement,
  });
  globalThis.fetch = originalFetch;
});

test("installed source tool descriptors stay bounded, read-only, and metadata-only", async () => {
  installFakeWindow();
  const caller = registerTile(
    {} as Window,
    "gemma",
    "source-descriptor-caller",
  );
  const descriptors = new Map(
    (await listTargetTools("kernel", caller))
      .filter(({ name }) => name.startsWith("source."))
      .map((descriptor) => [descriptor.name, descriptor]),
  );

  expect([...descriptors.keys()].sort()).toEqual([
    "source.files",
    "source.read",
    "source.search",
  ]);
  for (const name of ["source.files", "source.search"] as const) {
    const descriptor = descriptors.get(name);
    if (!descriptor) throw new Error(`Missing ${name} descriptor`);
    expect(descriptor.annotations).toEqual({
      "neutron:audit": "metadata_only",
      "neutron:effects": ["read", "network"],
      "neutron:longRunning": true,
    });
    expect(descriptor.description).toContain("untrusted");
  }

  const read = descriptors.get("source.read");
  if (!read) throw new Error("Missing source.read descriptor");
  expect(read.annotations).toEqual({
    "neutron:audit": "metadata_only",
    "neutron:effects": ["read", "network"],
    "neutron:longRunning": true,
  });
  expect(read.description).toContain("untrusted");

  const expectedRequired = {
    "source.files": ["appId", "sourceRevision", "cursor"],
    "source.search": ["appId", "sourceRevision", "query", "cursor"],
    "source.read": ["appId", "sourceRevision", "path", "cursor"],
  } as const;
  for (const [name, required] of Object.entries(expectedRequired)) {
    const descriptor = descriptors.get(name);
    if (!descriptor) throw new Error(`Missing ${name} descriptor`);
    expect(descriptor.inputSchema).toMatchObject({
      type: "object",
      required: [...required],
      additionalProperties: false,
    });
  }
  const readVariants = (read.outputSchema as { oneOf?: unknown }).oneOf;
  expect(Array.isArray(readVariants)).toBe(true);
  if (!Array.isArray(readVariants)) {
    throw new Error("source.read output schema is not a closed variant union");
  }
  expect(readVariants).toHaveLength(3);
});

test("installed source inspection admits only the active direct Agent root", async () => {
  installFakeWindow();
  const { resident, root } = await beginSignedCallAgentInvocation();
  const call = {
    target: "kernel" as const,
    name: "source.files",
    arguments: {
      appId: "signed_call_agent",
      sourceRevision: null,
      cursor: null,
    },
  };

  await expect(routeToolCall(call, resident)).rejects.toMatchObject({
    code: "INVOCATION_INVALID",
  });
  expect(sourceInspectionCalls).toHaveLength(0);

  const child = createChildInvocation(
    root,
    resident,
    "nested_source_inspection",
  );
  await expect(
    routeToolCall(call, resident, undefined, invocationMetadata(child, true)),
  ).rejects.toMatchObject({ code: "INVOCATION_INVALID" });
  expect(sourceInspectionCalls).toHaveLength(0);
  completeInvocation(child);

  await expect(
    routeToolCall(call, resident, undefined, invocationMetadata(root, true)),
  ).resolves.toMatchObject({
    appId: "signed_call_agent",
    appVersion: 100,
    installationUid: "401",
    sourceRevision: SOURCE_INSPECTION_REVISION,
    complete: true,
    nextCursor: null,
  });
  expect(sourceInspectionCalls).toHaveLength(1);
  expect(sourceInspectionCalls[0]).toMatchObject({
    operation: "list",
    args: call.arguments,
  });

  const audit = listMsgBusAudit().at(-1);
  expect(audit).toMatchObject({
    target: "kernel",
    tool: "source.files",
    status: "ok",
    arguments: { metadataBytes: expect.any(Number) },
    metadataBytes: {
      input: expect.any(Number),
      output: expect.any(Number),
    },
  });
  expect(audit).not.toHaveProperty("result");
  expect(JSON.stringify(audit)).not.toContain("source-secret.js");
  completeInvocation(root);
});

test("installed source inspection withholds a result after its Agent root ends", async () => {
  installFakeWindow();
  const { resident, root } = await beginSignedCallAgentInvocation();
  let markStarted!: () => void;
  let release!: (value: JsonValue) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<JsonValue>((resolve) => {
    release = resolve;
  });
  sourceInspectionOverride = () => {
    markStarted();
    return gate;
  };
  const pending = routeToolCall(
    {
      target: "kernel",
      name: "source.files",
      arguments: {
        appId: "signed_call_agent",
        sourceRevision: null,
        cursor: null,
      },
    },
    resident,
    undefined,
    invocationMetadata(root, true),
  );
  void pending.catch(() => undefined);
  await started;
  cancelAgentRoot(root.id, "Test cancellation");
  release({});
  await expect(pending).rejects.toMatchObject({
    code: "INVOCATION_INVALID",
  });
});

test("every installed source tool receives request cancellation", async () => {
  installFakeWindow();
  const { resident, root } = await beginSignedCallAgentInvocation();
  const calls = [
    {
      operation: "list" as const,
      name: "source.files",
      arguments: {
        appId: "signed_call_agent",
        sourceRevision: null,
        cursor: null,
      },
    },
    {
      operation: "search" as const,
      name: "source.search",
      arguments: {
        appId: "signed_call_agent",
        sourceRevision: SOURCE_INSPECTION_REVISION,
        query: "needle",
        cursor: null,
      },
    },
    {
      operation: "read" as const,
      name: "source.read",
      arguments: {
        appId: "signed_call_agent",
        sourceRevision: SOURCE_INSPECTION_REVISION,
        path: "/app/signed_call_agent/main.js",
        cursor: null,
      },
    },
  ];

  for (const expected of calls) {
    let release!: (value: JsonValue) => void;
    const gate = new Promise<JsonValue>((resolve) => {
      release = resolve;
    });
    sourceInspectionOverride = () => gate;
    const controller = new AbortController();
    const previousCalls = sourceInspectionCalls.length;
    const pending = routeToolCall(
      {
        target: "kernel",
        name: expected.name,
        arguments: expected.arguments,
      },
      resident,
      undefined,
      invocationMetadata(root, true),
      undefined,
      controller.signal,
    );
    void pending.catch(() => undefined);
    for (
      let turn = 0;
      turn < 20 && sourceInspectionCalls.length === previousCalls;
      turn += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const observed = sourceInspectionCalls.at(-1);
    expect(observed).toMatchObject({ operation: expected.operation });
    expect(observed?.signal).toBe(controller.signal);

    controller.abort();
    release({});
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  }
  completeInvocation(root);
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

const providerActionDescriptor: MsgBusToolDescriptor = {
  name: "provider_action",
  title: "Perform Provider Action",
  description: "Prepare and perform one provider-owned action.",
  inputSchema: {
    type: "object",
    required: ["value"],
    properties: { value: { type: "string" } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["receipt"],
    properties: { receipt: { type: "string" } },
    additionalProperties: false,
  },
  annotations: { "neutron:consent": "provider_once" },
};

const providerPresentationDescriptor: MsgBusToolDescriptor = {
  name: "provider_review_action",
  title: "Review Provider Action",
  inputSchema: {
    type: "object",
    required: ["detail"],
    properties: { detail: { type: "string" } },
    additionalProperties: false,
  },
  outputSchema: providerActionDescriptor.outputSchema!,
  annotations: {
    "neutron:visibility": NEUTRON_TOOL_VISIBILITY_SAME_APP,
    "neutron:audience": NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
  },
};

const agentRootActionDescriptor: MsgBusToolDescriptor = {
  ...providerActionDescriptor,
  name: "provider_action_agent",
  title: "Perform Provider Action For Agent",
  annotations: {
    "neutron:visibility": NEUTRON_TOOL_VISIBILITY_SAME_APP,
    "neutron:audience": NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
  },
};

function providerPresentationRequest(
  capability: string,
  tool = providerPresentationDescriptor.name,
): JsonObject {
  return {
    capability,
    tileId: "review",
    tool,
    arguments: { detail: "Review the requested action" },
  };
}

function createPresentationProvider(
  result: JsonValue,
  tool = providerPresentationDescriptor.name,
  options: {
    startGate?: Promise<void>;
    secondCallback?: "approval" | "presentation";
    review?: JsonObject;
  } = {},
) {
  return createProviderToolEndpoint(
    providerActionDescriptor,
    options.review ?? {},
    result,
    {
      presentation: (capability) =>
        providerPresentationRequest(capability, tool),
      ...(options.startGate ? { startGate: options.startGate } : {}),
      ...(options.secondCallback
        ? { secondCallback: options.secondCallback }
        : {}),
    },
  );
}

function providerActionCall(appId = "provider") {
  return {
    target: `app:${appId}:background` as const,
    name: providerActionDescriptor.name,
    arguments: { value: "requested" },
  };
}

function openProviderTile(appId = "provider") {
  return useWorkspaceStore.getState().openTile({
    appId,
    tileId: "review",
    title: `${appId} review`,
    path: "index.html",
    icon: "static/icon.svg",
  });
}

function createProviderFocusFixture(options: {
  key: string;
  callerCount?: number;
  descriptorGate?: Promise<void>;
  resultGates?: readonly Promise<void>[];
  connectProviderTile?: boolean;
}) {
  installFakeWindow();
  authorizeTestOwner();
  setTransientUserActivation(false);
  const callerCount = options.callerCount ?? 1;
  const callerRecords = Array.from({ length: callerCount }, (_, index) => {
    const appId = `focus_${options.key}_requester_${index}`;
    const instanceId = `focus-${options.key}-caller-${index}`;
    const source = {} as Window;
    return {
      appId,
      instanceId,
      source,
      endpoint: registerTile(source, appId, instanceId),
    };
  });
  const appId = `focus_${options.key}_provider`;
  const result = { receipt: `${options.key}-ok` };
  const provider = createPresentationProvider(result);
  const { appScope } = registerScopedBackgroundEndpoint(
    provider.source,
    appId,
    "821",
    "review",
  );
  const tile = openProviderTile(appId);
  const presentation = createCapturingToolEndpoint(
    providerPresentationDescriptor,
    result,
    {
      ...(options.descriptorGate
        ? { descriptorGate: options.descriptorGate }
        : {}),
      ...(options.resultGates ? { resultGates: options.resultGates } : {}),
    },
  );
  registerScopedTileEndpoint(
    presentation.source,
    appId,
    "review",
    tile.id,
    appScope,
    { connect: options.connectProviderTile !== false },
  );
  const focusDocument = installTestFocusDocument();
  const callers = callerRecords.map((record) => ({
    ...record,
    frame: focusDocument.addFrame({
      appId: record.appId,
      tileId: "main",
      instanceId: record.instanceId,
      source: record.source,
    }),
  }));
  const providerFrame = focusDocument.addFrame({
    appId,
    tileId: "review",
    instanceId: tile.id,
    source: presentation.source,
  });
  const activateCaller = (index = 0): void => {
    const caller = callers[index];
    if (!caller) throw new Error("Missing focus-test caller");
    focusTestTile(caller.instanceId);
    focusDocument.activeElement = caller.frame;
  };
  const call = (index = 0): Promise<JsonValue> => {
    const caller = callers[index];
    if (!caller) throw new Error("Missing focus-test caller");
    return routeToolCall(providerActionCall(appId), caller.endpoint);
  };
  const start = (index = 0): Promise<JsonValue> => {
    activateCaller(index);
    const pending = call(index);
    void pending.catch(() => undefined);
    return pending;
  };
  const waitForCalls = async (count: number): Promise<void> => {
    for (
      let turn = 0;
      turn < 50 && presentation.state.calls < count;
      turn += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(presentation.state.calls).toBe(count);
  };
  return {
    appId,
    appScope,
    call,
    callers,
    focusDocument,
    presentation,
    providerFrame,
    result,
    start,
    tile,
    waitForCalls,
  };
}

test("a new Kernel keeps a released provider surface and fails closed for an absent successor tool", async () => {
  const fakeWindow = installFakeWindow();
  const caller = registerTile({} as Window, "consumer", "caller");
  const target = "app:provider:background" as const;
  const releasedProviderTool: MsgBusToolDescriptor = {
    name: "status",
    title: "Read provider status",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["revision"],
      properties: { revision: { type: "string" } },
      additionalProperties: false,
    },
  };
  const releasedProvider = createToolEndpoint(fakeWindow, releasedProviderTool, {
    revision: "released-provider",
  });
  unregisters.push(registerBackground(releasedProvider, "provider"));
  grantFrontendToolSession("consumer", target, "*");

  await expect(
    routeToolCall(
      { target, name: "status", arguments: {} },
      caller,
    ),
  ).resolves.toEqual({ revision: "released-provider" });
  await expect(
    routeToolCall(
      {
        target,
        name: "successor_action",
        arguments: { value: "requested" },
      },
      caller,
    ),
  ).rejects.toThrow("Unknown tool 'successor_action'");
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
});

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
  grantFrontendToolSession("agent", "app:files:background", "*");
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
  ).resolves.toEqual([expect.objectContaining({ name: "tile_control" })]);
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
      if (!isJsonObject(message) || message.type !== "neutron:msgbus:connect") {
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
        { source, origin: TEST_FRAME_ORIGIN },
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
    callFrom(callerSource, "tools.call.control", "verify_cancel", "request-0"),
  ).rejects.toThrow("Too many concurrent frontend control calls");
  targetPort?.postMessage({
    type: "response",
    id: heldControlId!,
    ok: { cancelled: false },
  });
  await expect(heldControl).resolves.toEqual({ cancelled: false });

  await expect(
    callFrom(callerSource, "tools.call.control", "verify_cancel", "request-0"),
  ).resolves.toEqual({ cancelled: true });
  await expect(saturated[0]).resolves.toEqual({ done: true });
  expect(forwardedCallers.at(-1)).toBe("app:hello:tile:main:instance:caller");

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
  await expect(
    Promise.all([...saturated.slice(1), replacement]),
  ).resolves.toHaveLength(8);
});

test("a tray endpoint calls its own background without prompting", async () => {
  const fakeWindow = installFakeWindow();
  const caller = registerTray({} as Window, "hello", "panel-one");
  const targetSource = createToolEndpoint(fakeWindow, echoDescriptor, {
    value: "tray-called",
  });
  unregisters.push(registerBackground(targetSource, "hello"));

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

test("legacy call rejection retains owner discovery but sends no method call", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  const counts = installExternalCallTarget();
  const { cid, result } = await beginExternalSignedCall(caller);

  expect(counts.discoveryCalls).toBe(1);
  expect(counts.ownerDiscoveryCalls).toBe(1);
  expect(counts.anonymousDiscoveryCalls).toBe(0);
  expect(counts.ownerActorBindings).toBe(1);
  expect(counts.prepareCalls).toBe(0);
  expect(counts.ownerMethodCalls).toBe(0);
  expect(useRequestStore.getState().calls[Number(cid)]?.canonicalArgs).toBe(
    false,
  );
  callReject({ cid });
  await expect(result).rejects.toThrow("User rejected");
  expect(counts.ownerMethodCalls).toBe(0);
});

test("legacy call approval retains default conversion and sends one method call", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  const counts = installExternalCallTarget();
  const { cid, result } = await beginExternalSignedCall(caller);

  expect(counts.discoveryCalls).toBe(1);
  expect(counts.ownerDiscoveryCalls).toBe(1);
  expect(counts.anonymousDiscoveryCalls).toBe(0);
  expect(counts.ownerActorBindings).toBe(1);
  expect(counts.prepareCalls).toBe(0);
  expect(counts.ownerMethodCalls).toBe(0);
  callApprove({ cid });
  await expect(result).resolves.toBe("Hello, Alice");
  expect(counts.ownerMethodCalls).toBe(1);
});

test("request cancellation leaves the compatible v1 call lifecycle unchanged", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  const counts = installExternalCallTarget();
  const controller = new AbortController();
  const result = routeToolCall(
    {
      target: "kernel",
      name: "canister.call_dialog",
      arguments: {
        canister: EXTERNAL_CALL_TEST_CANISTER,
        method: "hello_world",
        args: ["Alice"],
      },
    },
    caller,
    undefined,
    undefined,
    undefined,
    controller.signal,
  );
  for (
    let turn = 0;
    turn < 20 && Object.keys(useRequestStore.getState().calls).length === 0;
    turn += 1
  ) {
    await Promise.resolve();
  }
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing signed-call approval request");

  controller.abort();
  await Promise.resolve();
  expect(useRequestStore.getState().calls).toHaveProperty(cid);
  callApprove({ cid });
  await expect(result).resolves.toBe("Hello, Alice");
  expect(counts.ownerMethodCalls).toBe(1);
});

test("call_dialog_v2 is registered and resolves a Candid then method privately", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  await expect(listTargetTools("kernel", caller)).resolves.toContainEqual(
    expect.objectContaining({
      name: "canister.call_dialog_v2",
      annotations: expect.objectContaining({
        "neutron:effects": expect.arrayContaining([
          "signature_request",
          "network",
          "write",
        ]),
      }),
    }),
  );
  validateMethodInputOverride = (_target, _method, _args, options) => {
    expect(options).toEqual({ allowNumberedPrincipals: false });
    return { ok: true };
  };
  const counts = installExternalCallTarget("then");
  const { cid, result } = await beginExternalSignedCall(
    caller,
    "then",
    "canister.call_dialog_v2",
  );

  expect(counts.discoveryCalls).toBe(1);
  expect(counts.anonymousDiscoveryCalls).toBe(1);
  expect(counts.ownerDiscoveryCalls).toBe(0);
  expect(counts.ownerActorBindings).toBe(1);
  expect(counts.prepareCalls).toBe(1);
  expect(counts.ownerMethodCalls).toBe(0);
  callApprove({ cid });
  await expect(result).resolves.toBe("Hello, Alice");
  expect(counts.ownerMethodCalls).toBe(1);
});

test("call_dialog_v2 reviews and dispatches the same prepared arguments", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  const counts = installExternalCallTarget(
    "hello_world",
    undefined,
    true,
    () => ["16"],
  );
  const { cid, result } = await beginExternalSignedCall(
    caller,
    "hello_world",
    "canister.call_dialog_v2",
    ["0x10"],
  );

  expect(useRequestStore.getState().calls[Number(cid)]).toMatchObject({
    args: ["16"],
    canonicalArgs: true,
  });
  expect(counts.ownerMethodCalls).toBe(0);
  callApprove({ cid });
  await expect(result).resolves.toBe("Hello, 16");
  expect(counts.ownerMethodArgs).toEqual([["16"]]);
});

test("v2 agent consent includes the complete prepared arguments", () => {
  const canonicalArgs: JsonValue[] = [
    {
      amount: "16",
      note: "line\nbreak\u202e",
      flags: [true, null],
    },
  ];
  expect(
    preparedCanisterCallAgentAction(
      EXTERNAL_CALL_TEST_CANISTER,
      "hello_world",
      canonicalArgs,
      true,
    ),
  ).toEqual({
    canister: EXTERNAL_CALL_TEST_CANISTER,
    method: "hello_world",
    argumentCount: 1,
    argumentBytes: new TextEncoder().encode(JSON.stringify(canonicalArgs))
      .byteLength,
    arguments: canonicalArgs,
  });
  expect(
    preparedCanisterCallAgentAction(
      EXTERNAL_CALL_TEST_CANISTER,
      "hello_world",
      canonicalArgs,
      false,
    ),
  ).not.toHaveProperty("arguments");
});

test("agent-scoped legacy call_dialog fails before discovery or dispatch", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const { resident, root } = await beginSignedCallAgentInvocation();
  const counts = installExternalCallTarget();

  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "canister.call_dialog",
        arguments: {
          canister: EXTERNAL_CALL_TEST_CANISTER,
          method: "hello_world",
          args: ["Alice"],
        },
      },
      resident,
      undefined,
      invocationMetadata(root, true),
    ),
  ).rejects.toMatchObject({
    code: "INVALID_REQUEST",
    message: expect.stringContaining("canister.call_dialog_v2"),
  });
  expect(counts.discoveryCalls).toBe(0);
  expect(counts.ownerActorBindings).toBe(0);
  expect(counts.prepareCalls).toBe(0);
  expect(counts.ownerMethodCalls).toBe(0);
  expect(useRequestStore.getState().calls).toEqual({});
  completeInvocation(root);
});

test("agent-scoped call_dialog_v2 dispatches its exact prepared arguments", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const { resident, root } = await beginSignedCallAgentInvocation();
  const counts = installExternalCallTarget(
    "hello_world",
    undefined,
    true,
    () => ["16"],
  );

  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "canister.call_dialog_v2",
        arguments: {
          canister: EXTERNAL_CALL_TEST_CANISTER,
          method: "hello_world",
          args: ["0x10"],
        },
      },
      resident,
      undefined,
      invocationMetadata(root, true),
    ),
  ).resolves.toBe("Hello, 16");
  expect(counts.discoveryCalls).toBe(1);
  expect(counts.anonymousDiscoveryCalls).toBe(1);
  expect(counts.ownerDiscoveryCalls).toBe(0);
  expect(counts.ownerActorBindings).toBe(1);
  expect(counts.prepareCalls).toBe(1);
  expect(counts.ownerMethodArgs).toEqual([["16"]]);
  expect(useRequestStore.getState().calls).toEqual({});
  completeInvocation(root);
});

test("source-bound request cancellation removes consent and prevents later dispatch", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const connect = (instanceId: string) => {
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
    registerTile(source, "hello", instanceId);
    if (!appPort) throw new Error("App port was not transferred");
    appPort.start();
    return appPort;
  };
  const callerPort = connect("cancel-caller");
  const siblingPort = connect("cancel-sibling");
  const counts = installExternalCallTarget();
  const response = new Promise<Record<string, unknown>>((resolve) => {
    callerPort.addEventListener("message", (event) => {
      const message = event.data as Record<string, unknown>;
      if (message.type === "response" && message.id === 701) resolve(message);
    });
  });

  callerPort.postMessage({
    type: "exec",
    id: 701,
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "canister.call_dialog_v2",
        arguments: {
          canister: EXTERNAL_CALL_TEST_CANISTER,
          method: "hello_world",
          args: ["Alice"],
        },
      },
    },
  } satisfies ExecEnvelope);
  for (
    let turn = 0;
    turn < 20 && Object.keys(useRequestStore.getState().calls).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing signed-call approval request");

  siblingPort.postMessage({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 701,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(useRequestStore.getState().calls).toHaveProperty(cid);

  callerPort.postMessage({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 701,
  });
  await expect(response).resolves.toMatchObject({
    error: { code: "REQUEST_CANCELLED" },
  });
  expect(useRequestStore.getState().calls).toEqual({});
  callApprove({ cid });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(counts.ownerMethodCalls).toBe(0);
});

test("cancelling a dispatched v2 update aborts its native fetch and preserves outcome unknown", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const appPort = registerDirectTilePort("hello", "cancel-dispatched-update");
  let nativeSignal: AbortSignal | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    nativeSignal = init?.signal ?? undefined;
    if (!nativeSignal) {
      return Promise.reject(new Error("Strict fetch did not receive a signal"));
    }
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(nativeSignal?.reason);
      nativeSignal!.addEventListener("abort", abort, { once: true });
      if (nativeSignal!.aborted) abort();
    });
  }) as typeof fetch;

  const method = "store";
  const idlFactory: IDL.InterfaceFactory = ({ IDL: FactoryIDL }) =>
    FactoryIDL.Service({
      [method]: FactoryIDL.Func([FactoryIDL.Text], [FactoryIDL.Text], []),
    });
  icblastClientCallOverride = async (options, canister, preset) => {
    expect(canister).toBe(EXTERNAL_CALL_TEST_CANISTER);
    if (preset === undefined) return { $idlFactory: idlFactory };
    const guardedFetch = (
      options.agentOptions as { fetch?: typeof fetch } | undefined
    )?.fetch;
    if (!guardedFetch) throw new Error("Missing strict guarded fetch");
    const ownerMethod = async () =>
      guardedFetch("https://icp-api.io/hanging-update");
    Object.defineProperty(ownerMethod, "prepare", {
      value: async (...args: unknown[]) => ({
        args: Object.freeze(args),
        invoke: () => ownerMethod(),
      }),
    });
    const methods = new Map([[method, ownerMethod]]);
    return {
      $idlFactory: idlFactory,
      $methods: { get: methods.get.bind(methods) },
    };
  };

  const response = new Promise<Record<string, unknown>>((resolve) => {
    appPort.addEventListener("message", (event) => {
      const message = event.data as Record<string, unknown>;
      if (message.type === "response" && message.id === 702) resolve(message);
    });
  });
  appPort.postMessage({
    type: "exec",
    id: 702,
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "canister.call_dialog_v2",
        arguments: {
          canister: EXTERNAL_CALL_TEST_CANISTER,
          method,
          args: ["value"],
        },
      },
    },
  } satisfies ExecEnvelope);
  for (
    let turn = 0;
    turn < 20 && Object.keys(useRequestStore.getState().calls).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing signed-call approval request");
  callApprove({ cid });
  for (let turn = 0; turn < 20 && !nativeSignal; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(nativeSignal).toBeInstanceOf(AbortSignal);

  appPort.postMessage({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 702,
  });
  await expect(response).resolves.toMatchObject({
    error: {
      code: "REQUEST_CANCELLED",
      message: expect.stringContaining("outcome is unknown"),
    },
  });
  expect(nativeSignal?.aborted).toBe(true);
});

test("replacing an app endpoint aborts its outstanding v2 discovery fetch", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const appPort = registerDirectTilePort("hello", "disconnect-discovery");
  let nativeSignal: AbortSignal | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    nativeSignal = init?.signal ?? undefined;
    if (!nativeSignal) {
      return Promise.reject(new Error("Strict fetch did not receive a signal"));
    }
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => reject(nativeSignal?.reason);
      nativeSignal!.addEventListener("abort", abort, { once: true });
      if (nativeSignal!.aborted) abort();
    });
  }) as typeof fetch;
  icblastClientCallOverride = async (options, canister, preset) => {
    expect(canister).toBe(EXTERNAL_CALL_TEST_CANISTER);
    expect(preset).toBeUndefined();
    const guardedFetch = (
      options.agentOptions as { fetch?: typeof fetch } | undefined
    )?.fetch;
    if (!guardedFetch) throw new Error("Missing strict guarded fetch");
    await guardedFetch("https://icp-api.io/hanging-discovery");
    return { $idlFactory: defaultExternalIdlFactory };
  };

  appPort.postMessage({
    type: "exec",
    id: 703,
    payload: {
      action: "tools.call",
      payload: {
        target: "kernel",
        name: "canister.schema_v2",
        arguments: {
          canister: EXTERNAL_CALL_TEST_CANISTER,
          method: "hello_world",
        },
      },
    },
  } satisfies ExecEnvelope);
  for (let turn = 0; turn < 20 && !nativeSignal; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(nativeSignal).toBeInstanceOf(AbortSignal);

  registerTile({} as Window, "hello", "disconnect-discovery");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(nativeSignal?.aborted).toBe(true);
});

test("direct app ports preserve released v1 shapes while enforcing byte and JSON bounds", async () => {
  installFakeWindow();
  const appPort = registerDirectTilePort("hello", "bounded-request");
  const request = (
    id: number,
    payload: unknown,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        const response = event.data as Record<string, unknown>;
        if (response.type !== "response" || response.id !== id) return;
        appPort.removeEventListener("message", listener);
        resolve(response);
      };
      appPort.addEventListener("message", listener);
      appPort.postMessage(payload);
    });
  const envelope = (id: number, payload: unknown) => ({
    type: "exec",
    id,
    payload: { action: "agent.mode.status", payload },
  });

  const ignoredIds = new Set([803]);
  const ignoredResponses: number[] = [];
  const ignoredListener = (event: MessageEvent) => {
    const response = event.data as { type?: unknown; id?: unknown };
    if (
      response.type === "response" &&
      typeof response.id === "number" &&
      ignoredIds.has(response.id)
    ) {
      ignoredResponses.push(response.id);
    }
  };
  appPort.addEventListener("message", ignoredListener);

  let deeplyNested: unknown = null;
  for (let depth = 0; depth < 65; depth += 1) {
    deeplyNested = [deeplyNested];
  }
  // Released v1 senders could use deep JSON, more than 100,000 aggregate
  // elements, sparse arrays, extension fields, and any nonempty action.
  // Receivers must route those envelopes rather than silently dropping them
  // after a Kernel upgrade.
  const compatibleResponses = await Promise.all([
    request(801, envelope(801, deeplyNested)),
    request(802, envelope(802, new Array(100_001).fill(null))),
    request(804, envelope(804, new Array(2))),
    request(805, {
      ...envelope(805, null),
      ignored: true,
    }),
    request(806, {
      type: "exec",
      id: 806,
      payload: { action: "x".repeat(129), payload: null },
    }),
  ]);
  expect(compatibleResponses.map((response) => response.id)).toEqual([
    801, 802, 804, 805, 806,
  ]);

  appPort.postMessage(envelope(803, "x".repeat(1024 * 1024 + 1)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  appPort.removeEventListener("message", ignoredListener);
  expect(ignoredResponses).toEqual([]);

  await expect(request(807, envelope(807, null))).resolves.toMatchObject({
    ok: { eligible: expect.any(Boolean) },
  });
});

test("schema_v2 uses anonymous discovery and disables principal shorthand", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  const counts = installExternalCallTarget();

  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "canister.schema_v2",
        arguments: {
          canister: EXTERNAL_CALL_TEST_CANISTER,
          method: "hello_world",
        },
      },
      caller,
    ),
  ).resolves.toEqual({});
  expect(explainMethodOptions).toEqual({ allowNumberedPrincipals: false });
  expect(counts.discoveryCalls).toBe(1);
  expect(counts.anonymousDiscoveryCalls).toBe(1);
  expect(counts.ownerDiscoveryCalls).toBe(0);
  expect(counts.ownerActorBindings).toBe(0);
  expect(counts.ownerMethodCalls).toBe(0);
});

test("canister tools reject noncanonical principals before discovery", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  const counts = installExternalCallTarget();
  const noncanonical = EXTERNAL_CALL_TEST_CANISTER.replaceAll("-", "");

  for (const name of [
    "canister.schema_v2",
    "canister.call_dialog_v2",
  ] as const) {
    await expect(
      routeToolCall(
        {
          target: "kernel",
          name,
          arguments: {
            canister: noncanonical,
            method: "hello_world",
            ...(name === "canister.call_dialog_v2" ? { args: ["Alice"] } : {}),
          },
        },
        caller,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "Canister principal must be canonical",
    });
  }
  expect(counts.discoveryCalls).toBe(0);
  expect(counts.ownerMethodCalls).toBe(0);
});

test("legacy schema retains owner discovery and default principal conversion", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  const counts = installExternalCallTarget();

  await expect(
    routeToolCall(
      {
        target: "kernel",
        name: "canister.schema",
        arguments: {
          canister: EXTERNAL_CALL_TEST_CANISTER,
          method: "hello_world",
        },
      },
      caller,
    ),
  ).resolves.toEqual({});
  expect(explainMethodOptions).toBeUndefined();
  expect(counts.discoveryCalls).toBe(1);
  expect(counts.ownerDiscoveryCalls).toBe(1);
  expect(counts.anonymousDiscoveryCalls).toBe(0);
  expect(counts.ownerActorBindings).toBe(1);
  expect(counts.ownerMethodCalls).toBe(0);
});

test("call_dialog_v2 never dispatches a legacy collision-prone actor property", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "hello", "caller");
  const counts = installExternalCallTarget("hello_world", undefined, false);
  const result = routeToolCall(
    {
      target: "kernel",
      name: "canister.call_dialog_v2",
      arguments: {
        canister: EXTERNAL_CALL_TEST_CANISTER,
        method: "hello_world",
        args: ["Alice"],
      },
    },
    caller,
  );

  await expect(result).rejects.toThrow("closed method registry");
  expect(counts.discoveryCalls).toBe(1);
  expect(counts.ownerActorBindings).toBe(1);
  expect(counts.ownerMethodCalls).toBe(0);
  expect(useRequestStore.getState().calls).toEqual({});
});

test("agent stop during external discovery prevents signed-call dispatch", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const { resident, root } = await beginSignedCallAgentInvocation();

  let releaseOwnerBinding!: () => void;
  const ownerBindingGate = new Promise<void>((resolve) => {
    releaseOwnerBinding = resolve;
  });
  const counts = installExternalCallTarget("hello_world", ownerBindingGate);
  const pending = routeToolCall(
    {
      target: "kernel",
      name: "canister.call_dialog_v2",
      arguments: {
        canister: EXTERNAL_CALL_TEST_CANISTER,
        method: "hello_world",
        args: ["Alice"],
      },
    },
    resident,
    undefined,
    invocationMetadata(root, true),
  );
  void pending.catch(() => undefined);
  for (let turn = 0; turn < 20 && counts.ownerActorBindings === 0; turn += 1) {
    await Promise.resolve();
  }
  expect(counts.discoveryCalls).toBe(1);
  expect(counts.ownerActorBindings).toBe(1);

  completeInvocation(root);
  releaseOwnerBinding();
  await expect(pending).rejects.toMatchObject({ code: "INVOCATION_INVALID" });
  expect(counts.ownerMethodCalls).toBe(0);
});

test("generic backend access tool rejects attached calls", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "hello", "caller");
  await expect(listTargetTools("kernel", caller)).resolves.toContainEqual(
    expect.objectContaining({
      name: "backend_calls.request",
      annotations: expect.objectContaining({
        "neutron:effects": expect.arrayContaining([
          "persistent_permission",
          "network",
          "user_visible_ui",
          "write",
        ]),
      }),
    }),
  );
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

test("self-call cancellation dismisses its pending backend consent", async () => {
  installFakeWindow();
  const appId = "backend_cancel";
  const installed = registryApp({
    id: appId,
    name: "Backend Cancel",
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Approved targets",
        reservation_scopes: ["principal"],
        max_concurrency: 1,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
    },
    func: { prepare_remote: { type: "update" } },
  });
  useAppsStore.setState({ list: { [appId]: installed } });
  const physicalMethod = installed.functions.find(
    ({ name }) => name === "prepare_remote",
  )?.candid_name;
  if (!physicalMethod) throw new Error("Missing backend test method");
  selfCallTarget = {
    $idlFactory: ({ IDL: FactoryIDL }: { IDL: typeof IDL }) =>
      FactoryIDL.Service({
        [physicalMethod]: FactoryIDL.Func(
          [FactoryIDL.Text],
          [FactoryIDL.Null],
          [],
        ),
      }),
    [`${physicalMethod}$`]: async (value: string) => [
      ...IDL.encode([IDL.Text], [value]),
    ],
  };
  const port = registerDirectTilePort(appId, "owner");
  const response = new Promise<Record<string, any>>((resolve) => {
    const listener = (event: MessageEvent) => {
      const value = event.data as Record<string, any>;
      if (value.id !== 174) return;
      port.removeEventListener("message", listener);
      resolve(value);
    };
    port.addEventListener("message", listener);
  });
  port.postMessage({
    type: "neutron:self-call:exec",
    version: 1,
    id: 174,
    tool: "backend_calls.request",
    method: "prepare_remote",
    args: ["target"],
    blobs: [],
    actions: [],
  });
  for (
    let turn = 0;
    turn < 20 &&
    Object.keys(useBackendCallConsentStore.getState().requests).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(
    Object.values(useBackendCallConsentStore.getState().requests),
  ).toHaveLength(1);

  port.postMessage({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 174,
  });
  for (
    let turn = 0;
    turn < 20 &&
    Object.keys(useBackendCallConsentStore.getState().requests).length > 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(useBackendCallConsentStore.getState().requests).toEqual({});
  expect(await response).toMatchObject({
    error: { code: "REQUEST_CANCELLED" },
  });
});

test("self-call cancellation dismisses its pending owner signature dialog", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const appId = "self_dialog_cancel";
  const installed = registryApp({
    id: appId,
    name: "Self Dialog Cancel",
    func: { save: { type: "update", async: "async*" } },
  });
  useAppsStore.setState({ list: { [appId]: installed } });
  const physicalMethod = installed.functions.find(
    ({ name }) => name === "save",
  )?.candid_name;
  if (!physicalMethod) throw new Error("Missing self-dialog test method");
  selfCallTarget = {
    $idlFactory: ({ IDL: FactoryIDL }: { IDL: typeof IDL }) =>
      FactoryIDL.Service({
        [physicalMethod]: FactoryIDL.Func(
          [FactoryIDL.Text],
          [FactoryIDL.Null],
          [],
        ),
      }),
    [`${physicalMethod}$`]: async (value: string) => [
      ...IDL.encode([IDL.Text], [value]),
    ],
  };

  const port = registerDirectTilePort(appId, "owner");
  const response = new Promise<Record<string, any>>((resolve) => {
    const listener = (event: MessageEvent) => {
      const value = event.data as Record<string, any>;
      if (value.id !== 175) return;
      port.removeEventListener("message", listener);
      resolve(value);
    };
    port.addEventListener("message", listener);
  });
  port.postMessage({
    type: "neutron:self-call:exec",
    version: 1,
    id: 175,
    tool: "canister.call_dialog",
    method: "save",
    args: ["value"],
    blobs: [],
  });
  for (
    let turn = 0;
    turn < 20 && Object.keys(useRequestStore.getState().calls).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(Object.values(useRequestStore.getState().calls)).toHaveLength(1);

  port.postMessage({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 175,
  });
  for (
    let turn = 0;
    turn < 20 && Object.keys(useRequestStore.getState().calls).length > 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(useRequestStore.getState().calls).toEqual({});
  expect(await response).toMatchObject({
    error: { code: "REQUEST_CANCELLED" },
  });
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
              attachments: FactoryIDL.Vec(FactoryIDL.Vec(FactoryIDL.Nat8)),
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
  validateMethodInputOverride = () => {
    throw new Error(
      "Private self calls must not run the generated public-schema validator",
    );
  };
  submitSelfCallUpdate = async (agent, _canisterId, methodName, rawInput) => {
    updateDispatches += 1;
    expect(agent).toBe(fakeAttachmentAgent);
    expect(methodName).toBe(putMethod);
    const [request] = IDL.decode([updateRequestType], rawInput) as unknown as [
      {
        key: string;
        avatar: Uint8Array;
        nested: { attachments: Uint8Array[] };
      },
    ];
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
  expect([...new Uint8Array(queryResponse.blobs[0]!.data)]).toEqual([
    9, 255, 0,
  ]);

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

test("routed self dialogs require invocation provenance during an active agent call", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const appId = "self_dialog_agent";
  const installationUid = "302";
  const installed = registryApp({
    id: appId,
    name: "Self Dialog Agent",
    version: 100,
    background: { path: "background.html" },
    capabilities: {
      agent_entrypoints: { api: 1, entrypoints: ["run"] },
    },
    func: {
      save: { type: "update", async: "async*" },
    },
  });
  const appScope = { appId, installationUid };
  useAppsStore.setState({
    list: { [appId]: installed },
    appInstances: {
      [appId]: {
        scope: appScope,
        version: installed.version,
        deploymentId: "development",
        capabilityPlanFingerprint: installed.capability_plan_fingerprint,
        browserOriginNonce: installationUid.padStart(32, "0"),
        browserOriginAuthorityEpoch: "1",
        residentFrameSecurity: "credentialless_opaque_v1",
      },
    },
  });

  const tileSource = {} as Window;
  let appPort: MessagePort | undefined;
  const backgroundSource = {
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
      tileSource,
      {
        role: "tile",
        appId,
        tileId: "chat",
        instanceId: "root",
        workspace: 1,
      },
      { appScope, origin: TEST_FRAME_ORIGIN },
    ),
    registerFrameContext(
      backgroundSource,
      { role: "background", appId },
      { appScope, origin: TEST_FRAME_ORIGIN },
    ),
  );
  authenticateLoadedTestFrame(tileSource);
  authenticateLoadedTestFrame(backgroundSource);
  const tile = getRegisteredEndpoint(
    `app:${appId}:tile:chat:instance:root`,
  );
  const resident = getRegisteredEndpoint(`app:${appId}:background`);
  if (!tile || !resident || !appPort) {
    throw new Error("Self-dialog agent endpoints did not register");
  }
  const residentPort = appPort;
  residentPort.start();

  const grant = requestAgentGrant({
    appId,
    appName: installed.name,
    version: installed.version,
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
    installedVersion: installed.version,
  });
  if (!root) throw new Error("Self-dialog agent root did not start");

  const physicalMethod = installed.functions.find(
    ({ name }) => name === "save",
  )?.candid_name;
  if (!physicalMethod) throw new Error("Missing self-dialog physical method");
  const outputType = IDL.Record({ saved: IDL.Bool });
  let candidPreparations = 0;
  let dispatches = 0;
  selfCallTarget = {
    $idlFactory: ({ IDL: FactoryIDL }: { IDL: typeof IDL }) => {
      candidPreparations += 1;
      return FactoryIDL.Service({
        [physicalMethod]: FactoryIDL.Func(
          [FactoryIDL.Text],
          [FactoryIDL.Record({ saved: FactoryIDL.Bool })],
          [],
        ),
      });
    },
    [`${physicalMethod}$`]: async (value: string) => [
      ...IDL.encode([IDL.Text], [value]),
    ],
  };
  selfCallAgent = { rootKey: new Uint8Array(0) } as unknown as Agent;
  submitSelfCallUpdate = async (_agent, _canister, method, rawInput) => {
    dispatches += 1;
    expect(method).toBe(physicalMethod);
    expect(IDL.decode([IDL.Text], rawInput)).toEqual(["payload"]);
    return IDL.encode([outputType], [{ saved: true }]);
  };

  const request = (
    id: number,
    context?: { invocation: ReturnType<typeof invocationMetadata> },
  ): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      const listener = (event: MessageEvent) => {
        const response = event.data as Record<string, any>;
        if (response.id !== id) return;
        residentPort.removeEventListener("message", listener);
        resolve(response);
      };
      residentPort.addEventListener("message", listener);
      residentPort.postMessage({
        type: "neutron:self-call:exec",
        version: 1,
        id,
        tool: "canister.call_dialog",
        method: "save",
        args: ["payload"],
        blobs: [],
        ...(context ? { context } : {}),
      });
    });

  const unscoped = await request(551);
  expect(unscoped.error).toMatchObject({ code: "SCOPED_CONTEXT_REQUIRED" });
  expect(candidPreparations).toBe(0);
  expect(dispatches).toBe(0);
  expect(useRequestStore.getState().calls).toEqual({});

  const scoped = await request(552, {
    invocation: invocationMetadata(root),
  });
  expect(scoped.error).toMatchObject({ code: "USER_INTERACTION_REQUIRED" });
  expect(dispatches).toBe(0);
  expect(useRequestStore.getState().calls).toEqual({});

  completeInvocation(root);
  const ownerCall = request(553);
  for (
    let turn = 0;
    turn < 20 && Object.keys(useRequestStore.getState().calls).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const cid = Object.keys(useRequestStore.getState().calls)[0];
  if (!cid) throw new Error("Missing self-dialog owner approval request");
  callApprove({ cid });
  expect(await ownerCall).toMatchObject({
    ok: { saved: true },
    blobs: [],
  });
  expect(dispatches).toBe(1);
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
        origin: TEST_FRAME_ORIGIN,
        appScope: { appId, installationUid },
      }),
    );
    authenticateLoadedTestFrame(source);
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
  const submitUpdate = async (
    _agent: Agent,
    _canister: string,
    method: string,
    bytes: Uint8Array,
  ) => {
    dispatches += 1;
    expect(method).toBe(physicalMethod);
    const [value] = IDL.decode([requestType], bytes) as unknown as [
      { left: Uint8Array; right: Uint8Array },
    ];
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
  submitSelfCallUpdate = submitUpdate;

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

  binaryErrorNext = false;
  let markDispatched!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  submitSelfCallUpdate = async () => {
    dispatches += 1;
    markDispatched();
    await replyGate;
    return IDL.encode([outputType], [{ ok: { stored: true } }]);
  };
  const cancelledAfterDispatch = request(resident.appPort, 607);
  await dispatched;
  resident.appPort.postMessage({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 607,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  releaseReply();
  expect(await cancelledAfterDispatch).toMatchObject({
    error: {
      code: "REQUEST_CANCELLED",
      message: expect.stringContaining("outcome is unknown"),
    },
  });
  expect(dispatches).toBe(4);

  submitSelfCallUpdate = submitUpdate;
  const encodeSelfCall = selfCallTarget[`${physicalMethod}$`];
  let markPreparing!: () => void;
  const preparing = new Promise<void>((resolve) => {
    markPreparing = resolve;
  });
  let releasePreparation!: () => void;
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  selfCallTarget[`${physicalMethod}$`] = async (value: unknown) => {
    markPreparing();
    await preparationGate;
    return encodeSelfCall(value);
  };
  const cancelledBeforeDispatch = request(resident.appPort, 608);
  await preparing;
  resident.appPort.postMessage({
    type: "neutron:msgbus:cancel",
    version: 1,
    id: 608,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  releasePreparation();
  expect(await cancelledBeforeDispatch).toMatchObject({
    error: { code: "REQUEST_CANCELLED" },
  });
  expect(dispatches).toBe(4);
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
    registerFrameContext({} as Window, caller.context, { origin: "null" }),
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
    unregisters.push(
      registerFrameContext(source, context, {
        origin: TEST_FRAME_ORIGIN,
      }),
    );
    authenticateLoadedTestFrame(source);
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
  const response = new Promise<AttachmentResponseEnvelope>(
    (resolve, reject) => {
      caller.appPort.addEventListener("message", (event) => {
        const message = event.data as AttachmentResponseEnvelope;
        if (message.type !== "neutron:msgbus:attachment:response") return;
        if (message.error !== undefined) reject(message.error);
        else resolve(message);
      });
      caller.appPort.start();
    },
  );
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
  expect([...new Uint8Array(result.attachments![0]!.data)]).toEqual([
    4, 3, 2, 1,
  ]);
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
  expect(JSON.stringify(listMsgBusAudit().at(-1))).not.toContain("round trip");

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
        origin: TEST_FRAME_ORIGIN,
        appScope: { appId: context.appId, installationUid },
      }),
    );
    authenticateLoadedTestFrame(source);
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
  installFakeWindow();
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
      { origin: TEST_FRAME_ORIGIN },
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
      { origin: TEST_FRAME_ORIGIN },
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
      { origin: TEST_FRAME_ORIGIN },
    ),
  );
  authenticateLoadedTestFrame(publisher);
  authenticateLoadedTestFrame(sameAppTile);
  authenticateLoadedTestFrame(otherAppTile);

  expect(
    executeExposedAction(
      "app.state.publish",
      { topic: "contacts", revision: "9" },
      { source: publisher, origin: TEST_FRAME_ORIGIN },
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
        { source: publisher, origin: TEST_FRAME_ORIGIN },
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
      { source: publisher, origin: TEST_FRAME_ORIGIN },
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
      if (!isJsonObject(message) || message.type !== "neutron:msgbus:connect") {
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
      if (!isJsonObject(message) || message.type !== "neutron:msgbus:connect") {
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
  unregisters.push(registerBackground(targetSource, "hello"));
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
  unregisters.push(registerBackground(callerSource, "hello"));
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
  unregisters.push(registerBackground(targetSource, "notes"));
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

test("a nested Agent call cannot reuse an ordinary frontend session grant", async () => {
  const fakeWindow = installFakeWindow();
  authorizeTestOwner("owner-principal");
  const agent = createAgentConsentEndpoint();
  const { root } = await beginSignedCallAgentInvocation(agent.source);
  const intermediarySource = createToolEndpoint(
    fakeWindow,
    echoDescriptor,
    { value: "unused" },
  );
  const intermediary = registerScopedBackgroundEndpoint(
    intermediarySource,
    "requester",
    "821",
  );
  const target = createCapturingToolEndpoint(echoDescriptor, {
    value: "agent-approved",
  });
  const targetEndpoint = registerScopedBackgroundEndpoint(
    target.source,
    "provider",
    "822",
  );
  grantFrontendToolSession("requester", targetEndpoint.endpointId, "echo");
  const child = createChildInvocation(root, intermediary, "requester_execute");

  await expect(
    routeToolCall(
      {
        target: targetEndpoint.endpointId as "app:provider:background",
        name: "echo",
        arguments: { value: "delegated" },
      },
      intermediary,
      undefined,
      invocationMetadata(child),
    ),
  ).resolves.toEqual({ value: "agent-approved" });
  expect(agent.challenges).toHaveLength(1);
  expect(agent.challenges[0]).toMatchObject({
    kind: "frontend_tool",
    requester: { appId: "requester", role: "background" },
    action: {
      targetAppId: "provider",
      targetRole: "background",
      tool: "echo",
    },
  });
  expect(target.state.calls).toBe(1);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
  completeInvocation(child);
  completeInvocation(root);
});

test("a grant cannot dispatch after the caller session changes during descriptor discovery", async () => {
  installFakeWindow();
  let releaseDescriptor!: () => void;
  const descriptorGate = new Promise<void>((resolve) => {
    releaseDescriptor = resolve;
  });
  const callerSource = {} as Window;
  const caller = registerTile(callerSource, "requester", "caller");
  const originalSession = caller.sessionId;
  const target = createCapturingToolEndpoint(
    echoDescriptor,
    { value: "must-not-dispatch" },
    { descriptorGate },
  );
  unregisters.push(registerBackground(target.source, "provider"));
  const targetId = "app:provider:background" as const;
  grantFrontendToolSession("requester", targetId, "echo");

  const pending = routeToolCall(
    {
      target: targetId,
      name: "echo",
      arguments: { value: "stale caller" },
    },
    caller,
  );
  void pending.catch(() => undefined);
  for (
    let turn = 0;
    turn < 50 && target.state.descriptorRequests === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(target.state.descriptorRequests).toBe(1);

  expect(connectFrameEndpoint(callerSource)).toBe(true);
  expect(caller.sessionId).not.toBe(originalSession);
  releaseDescriptor();

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(target.state.calls).toBe(0);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
});

test("a target session change during Agent consent cancels before dispatch", async () => {
  const fakeWindow = installFakeWindow();
  authorizeTestOwner("owner-principal");
  let releaseDecision!: () => void;
  const decisionGate = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  const agent = createAgentConsentEndpoint("allow", { decisionGate });
  const { root } = await beginSignedCallAgentInvocation(agent.source);
  const intermediarySource = createToolEndpoint(
    fakeWindow,
    echoDescriptor,
    { value: "unused" },
  );
  const intermediary = registerScopedBackgroundEndpoint(
    intermediarySource,
    "requester",
    "823",
  );
  const target = createCapturingToolEndpoint(echoDescriptor, {
    value: "must-not-dispatch",
  });
  const targetEndpoint = registerScopedBackgroundEndpoint(
    target.source,
    "provider",
    "824",
  );
  const originalSession = targetEndpoint.sessionId;
  const child = createChildInvocation(root, intermediary, "requester_execute");

  const pending = routeToolCall(
    {
      target: targetEndpoint.endpointId as "app:provider:background",
      name: "echo",
      arguments: { value: "delegated" },
    },
    intermediary,
    undefined,
    invocationMetadata(child),
  );
  void pending.catch(() => undefined);
  for (
    let turn = 0;
    turn < 50 && agent.challenges.length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(agent.challenges).toHaveLength(1);

  expect(connectFrameEndpoint(target.source, true)).toBe(true);
  expect(targetEndpoint.sessionId).not.toBe(originalSession);
  releaseDecision();

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(target.state.calls).toBe(0);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
  completeInvocation(child);
  completeInvocation(root);
});

test("provider presentation opens then reuses the exact provider tile with caller and audience attestation", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  setTransientUserActivation(false);
  const provider = createPresentationProvider({ receipt: "ui-77" });
  const { appScope } = registerScopedBackgroundEndpoint(
    provider.source,
    "provider",
    "801",
    "review",
  );

  const pending = routeToolCall(providerActionCall(), caller);
  void pending.catch(() => undefined);
  let opened = useWorkspaceStore
    .getState()
    .workspaces[1].tiles.find(
      (tile) => tile.appId === "provider" && tile.tileId === "review",
    );
  for (let turn = 0; turn < 50 && !opened; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    opened = useWorkspaceStore
      .getState()
      .workspaces[1].tiles.find(
        (tile) => tile.appId === "provider" && tile.tileId === "review",
      );
  }
  if (!opened) throw new Error("Provider tile was not opened");
  expect(useWorkspaceStore.getState().workspaces[1].focusedTileId).toBe(
    opened.id,
  );
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  const presentation = createCapturingToolEndpoint(
    providerPresentationDescriptor,
    { receipt: "ui-77" },
  );
  const tileEndpoint = registerScopedTileEndpoint(
    presentation.source,
    "provider",
    "review",
    opened.id,
    appScope,
  );

  await expect(pending).resolves.toEqual({ receipt: "ui-77" });
  expect(tileEndpoint.endpointId).toBe(
    `app:provider:tile:review:instance:${opened.id}`,
  );
  expect(provider.state.providerUi).toBe(true);
  expect(presentation.state.calls).toBe(1);
  expect(presentation.state.payloads[0]).toMatchObject({
    name: providerPresentationDescriptor.name,
    arguments: { detail: "Review the requested action" },
    caller: {
      endpoint: "app:requester:tile:main:instance:caller",
      appId: "requester",
      role: "tile",
    },
    audience: NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
  });
  await expect(
    routeToolCall(providerActionCall(), caller),
  ).resolves.toEqual({ receipt: "ui-77" });
  const providerTiles = useWorkspaceStore
    .getState()
    .workspaces[1].tiles.filter(
      (tile) => tile.appId === "provider" && tile.tileId === "review",
    );
  expect(providerTiles).toHaveLength(1);
  expect(providerTiles[0]?.id).toBe(opened.id);
  expect(useWorkspaceStore.getState().workspaces[1].focusedTileId).toBe(
    opened.id,
  );
  expect(presentation.state.calls).toBe(2);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
});

test("provider presentation stays valid when focus moves and leaves the new focus alone", async () => {
  let releaseResult!: () => void;
  const resultGate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const fixture = createProviderFocusFixture({
    key: "focus_moved",
    resultGates: [resultGate],
  });
  const caller = fixture.callers[0];
  const providerFrame = fixture.providerFrame;
  if (!caller || !providerFrame) throw new Error("Missing test frame");

  const pending = fixture.start();
  await fixture.waitForCalls(1);
  expect(fixture.focusDocument.activeElement).toBe(providerFrame);

  focusTestTile(caller.instanceId);
  fixture.focusDocument.activeElement = caller.frame;
  releaseResult();

  await expect(pending).resolves.toEqual(fixture.result);
  expect(fixture.focusDocument.activeElement).toBe(caller.frame);
  expect(useWorkspaceStore.getState().workspaces[1].focusedTileId).toBe(
    caller.instanceId,
  );
  expect(providerFrame.blurCalls).toBe(0);
});

test("a background app can request provider UI without focus or transient activation", async () => {
  const fixture = createProviderFocusFixture({ key: "bg" });
  setTransientUserActivation(false);
  const source = {} as Window;
  unregisters.push(registerBackground(source, "background_requester"));
  const caller = getRegisteredEndpoint("app:background_requester:background");
  if (!caller) throw new Error("Background caller did not register");

  await expect(
    routeToolCall(providerActionCall(fixture.appId), caller),
  ).resolves.toEqual(fixture.result);
  expect(fixture.presentation.state.calls).toBe(1);
  expect(fixture.presentation.state.payloads[0]).toMatchObject({
    caller: {
      endpoint: "app:background_requester:background",
      appId: "background_requester",
      role: "background",
    },
    audience: NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
  });
});

test("a tray app can request provider UI without focus or transient activation", async () => {
  const fixture = createProviderFocusFixture({ key: "tray" });
  setTransientUserActivation(false);
  const caller = registerTray({} as Window, "tray_requester", "panel-one");

  await expect(
    routeToolCall(providerActionCall(fixture.appId), caller),
  ).resolves.toEqual(fixture.result);
  expect(fixture.presentation.state.calls).toBe(1);
  expect(fixture.presentation.state.payloads[0]).toMatchObject({
    caller: {
      endpoint: "app:tray_requester:tray:instance:panel-one",
      appId: "tray_requester",
      role: "tray",
    },
    audience: NEUTRON_TOOL_AUDIENCE_FOREGROUND_TILE,
  });
});

test.each([
  { phase: "descriptor" as const },
  { phase: "result" as const },
])(
  "provider presentation rejects a reconnected endpoint during $phase dispatch",
  async ({ phase }) => {
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const fixture = createProviderFocusFixture({
      key: phase === "descriptor" ? "rd" : "rr",
      ...(phase === "descriptor"
        ? { descriptorGate: resultGate }
        : { resultGates: [resultGate] }),
    });
    const providerFrame = fixture.providerFrame;
    if (!providerFrame) throw new Error("Missing provider focus test frame");

    const pending = fixture.start();
    if (phase === "result") {
      await fixture.waitForCalls(1);
    } else {
      for (
        let turn = 0;
        turn < 50 && fixture.presentation.state.descriptorRequests < 1;
        turn += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(fixture.presentation.state.descriptorRequests).toBe(1);
    }
    expect(fixture.focusDocument.activeElement).toBe(providerFrame);
    const endpoint = getRegisteredEndpoint(
      `app:${fixture.appId}:tile:review:instance:${fixture.tile.id}`,
    );
    if (!endpoint?.sessionId) {
      throw new Error("Missing provider endpoint session");
    }
    const originalSessionId = endpoint.sessionId;

    expect(connectFrameEndpoint(fixture.presentation.source)).toBe(true);
    expect(endpoint.sessionId).not.toBe(originalSessionId);
    releaseResult();

    await expect(pending).rejects.toThrow();
    expect(fixture.focusDocument.activeElement).toBe(providerFrame);
  },
);

test("concurrent provider presentations reuse the provider tile without post-settlement focus changes", async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstResultGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondResultGate = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const fixture = createProviderFocusFixture({
    key: "concurrent",
    callerCount: 2,
    resultGates: [firstResultGate, secondResultGate],
  });
  const firstCallerFrame = fixture.callers[0]?.frame;
  const secondCallerFrame = fixture.callers[1]?.frame;
  const providerFrame = fixture.providerFrame;
  if (!firstCallerFrame || !secondCallerFrame || !providerFrame) {
    throw new Error("Missing concurrent focus test frame");
  }
  const firstPending = fixture.start(0);
  await fixture.waitForCalls(1);

  const secondPending = fixture.start(1);
  await fixture.waitForCalls(2);
  expect(providerFrame.focusCalls).toBe(2);
  expect(providerFrame.scrollIntoViewCalls).toBe(2);
  expect(fixture.focusDocument.activeElement).toBe(providerFrame);

  releaseSecond();

  await expect(secondPending).resolves.toEqual(fixture.result);
  expect(providerFrame.blurCalls).toBe(0);
  expect(fixture.focusDocument.activeElement).toBe(providerFrame);

  releaseFirst();

  await expect(firstPending).resolves.toEqual(fixture.result);
  expect(providerFrame.blurCalls).toBe(0);
  expect(fixture.focusDocument.activeElement).toBe(providerFrame);
  expect(firstCallerFrame.focusCalls).toBe(0);
  expect(secondCallerFrame.focusCalls).toBe(0);
});

test("provider presentation leaves normal tile focus unchanged when port connection is cancelled", async () => {
  const fixture = createProviderFocusFixture({
    key: "unconnected",
    connectProviderTile: false,
  });
  const callerFrame = fixture.callers[0]?.frame;
  const providerFrame = fixture.providerFrame;
  if (!callerFrame || !providerFrame) {
    throw new Error("Missing unconnected focus test frame");
  }

  const pending = fixture.start();
  for (
    let turn = 0;
    turn < 50 && fixture.focusDocument.activeElement !== providerFrame;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(fixture.focusDocument.activeElement).toBe(providerFrame);
  expect(fixture.presentation.state.descriptorRequests).toBe(0);

  useAuthStore.setState((state) => ({
    sessionGeneration: state.sessionGeneration + 1,
  }));

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(providerFrame.blurCalls).toBe(0);
  expect(fixture.focusDocument.activeElement).toBe(providerFrame);
  expect(callerFrame.focusCalls).toBe(0);
  expect(fixture.presentation.state.calls).toBe(0);
});

test("provider presentation rejects a replaced tile during descriptor and result waits", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");

  for (const [phase, appId, installationUid] of [
    ["descriptor", "providerdescriptor", "812"],
    ["result", "providerresult", "813"],
  ] as const) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = createPresentationProvider({ receipt: `stale-${phase}` });
    const { appScope } = registerScopedBackgroundEndpoint(
      provider.source,
      appId,
      installationUid,
      "review",
    );
    const tile = openProviderTile(appId);
    const stale = createCapturingToolEndpoint(
      providerPresentationDescriptor,
      { receipt: `stale-${phase}` },
      phase === "descriptor"
        ? { descriptorGate: gate }
        : { resultGate: gate },
    );
    registerScopedTileEndpoint(
      stale.source,
      appId,
      "review",
      tile.id,
      appScope,
    );
    const pending = routeToolCall(providerActionCall(appId), caller);
    void pending.catch(() => undefined);
    for (let turn = 0; turn < 50; turn += 1) {
      const reachedWait =
        phase === "descriptor"
          ? stale.state.descriptorRequests === 1
          : stale.state.calls === 1;
      if (reachedWait) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(
      phase === "descriptor"
        ? stale.state.descriptorRequests
        : stale.state.calls,
    ).toBe(1);

    const replacement = createCapturingToolEndpoint(
      providerPresentationDescriptor,
      { receipt: `replacement-${phase}` },
    );
    registerScopedTileEndpoint(
      replacement.source,
      appId,
      "review",
      tile.id,
      appScope,
    );
    release();

    await expect(pending).rejects.toThrow("Message bus endpoint retired");
    expect(provider.state.interactionResults).toEqual([]);
    expect(provider.state.interactionErrors).toHaveLength(1);
    expect(replacement.state.descriptorRequests).toBe(0);
    expect(replacement.state.calls).toBe(0);
    const audit = listMsgBusAudit().at(-1);
    expect(audit).toMatchObject({ status: "error" });
    expect(JSON.stringify(audit)).not.toContain(`stale-${phase}`);
    expect(useMsgBusPermissionStore.getState().requests).toEqual({});
    expect(useRequestStore.getState().calls).toEqual({});
  }
});

test("provider presentation allows focus and workspace changes but rejects a closed provider tile", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");

  for (const [change, appId, installationUid] of [
    ["focus", "providerfocus", "814"],
    ["membership", "providermembership", "815"],
    ["workspace", "providerworkspace", "816"],
  ] as const) {
    let release!: () => void;
    const descriptorGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = createPresentationProvider({ receipt: "must-not-return" });
    const { appScope } = registerScopedBackgroundEndpoint(
      provider.source,
      appId,
      installationUid,
      "review",
    );
    const tile = openProviderTile(appId);
    const presentation = createCapturingToolEndpoint(
      providerPresentationDescriptor,
      { receipt: "must-not-dispatch" },
      { descriptorGate },
    );
    registerScopedTileEndpoint(
      presentation.source,
      appId,
      "review",
      tile.id,
      appScope,
    );
    const pending = routeToolCall(providerActionCall(appId), caller);
    void pending.catch(() => undefined);
    for (
      let turn = 0;
      turn < 50 && presentation.state.descriptorRequests === 0;
      turn += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(presentation.state.descriptorRequests).toBe(1);

    if (change === "focus") focusTestTile("caller");
    else if (change === "membership") {
      useWorkspaceStore.getState().closeTile(tile.id);
    } else {
      useWorkspaceStore.setState({ activeWorkspaceId: 2 });
    }
    release();

    if (change === "membership") {
      await expect(pending).rejects.toMatchObject({
        code: "REQUEST_CANCELLED",
      });
      expect(presentation.state.calls).toBe(0);
      expect(provider.state.interactionResults).toEqual([]);
      expect(provider.state.interactionErrors).toHaveLength(1);
    } else {
      await expect(pending).resolves.toEqual({ receipt: "must-not-return" });
      expect(presentation.state.calls).toBe(1);
      expect(provider.state.interactionResults).toEqual([
        { receipt: "must-not-dispatch" },
      ]);
      expect(provider.state.interactionErrors).toEqual([]);
    }
    useWorkspaceStore.setState({ activeWorkspaceId: 1 });
  }
});

test("provider presentation cancels immediately when the owner session rotates", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  let release!: () => void;
  const resultGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = createPresentationProvider({ receipt: "must-not-return" });
  const { appScope } = registerScopedBackgroundEndpoint(
    provider.source,
    "providersession",
    "817",
    "review",
  );
  const tile = openProviderTile("providersession");
  const presentation = createCapturingToolEndpoint(
    providerPresentationDescriptor,
    { receipt: "must-not-return" },
    { resultGate },
  );
  registerScopedTileEndpoint(
    presentation.source,
    "providersession",
    "review",
    tile.id,
    appScope,
  );
  const pending = routeToolCall(providerActionCall("providersession"), caller);
  void pending.catch(() => undefined);
  for (
    let turn = 0;
    turn < 50 && presentation.state.calls === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(presentation.state.calls).toBe(1);

  useAuthStore.setState((state) => ({
    sessionGeneration: state.sessionGeneration + 1,
  }));
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(provider.state.interactionResults).toEqual([]);
  expect(provider.state.interactionErrors).toHaveLength(1);
  release();
});

test("provider presentation rejects forged and wrong-app capabilities without consuming the real provider request", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  let releasePresentation!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releasePresentation = resolve;
  });
  const provider = createPresentationProvider(
    { receipt: "ui-79" },
    providerPresentationDescriptor.name,
    { startGate },
  );
  const { appScope } = registerScopedBackgroundEndpoint(
    provider.source,
    "provider",
    "803",
    "review",
  );
  const existing = openProviderTile();
  const presentation = createCapturingToolEndpoint(
    providerPresentationDescriptor,
    { receipt: "ui-79" },
  );
  registerScopedTileEndpoint(
    presentation.source,
    "provider",
    "review",
    existing.id,
    appScope,
  );
  const attackerSource = createToolEndpoint(
    activeFakeWindow!,
    echoDescriptor,
    { value: "unused" },
  );
  registerScopedBackgroundEndpoint(attackerSource, "attacker", "804");
  const forgedPayload = providerPresentationRequest("0".repeat(64));
  await expect(
    Promise.resolve(
      executeExposedAction("provider_ui.present", forgedPayload, {
        source: provider.source,
        origin: TEST_FRAME_ORIGIN,
      }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

  const pending = routeToolCall(providerActionCall(), caller);
  void pending.catch(() => undefined);
  for (let turn = 0; turn < 50 && !provider.state.capability; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!provider.state.capability) throw new Error("Missing provider capability");
  await expect(
    Promise.resolve(
      executeExposedAction(
        "provider_ui.present",
        { ...forgedPayload, capability: provider.state.capability },
        { source: attackerSource, origin: TEST_FRAME_ORIGIN },
      ),
    ),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(presentation.state.calls).toBe(0);

  releasePresentation();
  await expect(pending).resolves.toEqual({ receipt: "ui-79" });
  expect(presentation.state.calls).toBe(1);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider presentation rejects wrong tools and wrong audiences before tile dispatch", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const cases: Array<{
    appId: string;
    installationUid: string;
    requestedTool: string;
    descriptor: MsgBusToolDescriptor;
  }> = [
    {
      appId: "providerwrongtool",
      installationUid: "805",
      requestedTool: "provider_missing_review",
      descriptor: providerPresentationDescriptor,
    },
    {
      appId: "providerwrongaudience",
      installationUid: "806",
      requestedTool: providerPresentationDescriptor.name,
      descriptor: {
        ...providerPresentationDescriptor,
        annotations: {
          "neutron:visibility": NEUTRON_TOOL_VISIBILITY_SAME_APP,
          "neutron:audience": NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
        },
      },
    },
  ];

  for (const entry of cases) {
    const provider = createPresentationProvider(
      { receipt: "must-not-return" },
      entry.requestedTool,
    );
    const { appScope } = registerScopedBackgroundEndpoint(
      provider.source,
      entry.appId,
      entry.installationUid,
      "review",
    );
    const existing = openProviderTile(entry.appId);
    const presentation = createCapturingToolEndpoint(entry.descriptor, {
      receipt: "must-not-dispatch",
    });
    registerScopedTileEndpoint(
      presentation.source,
      entry.appId,
      "review",
      existing.id,
      appScope,
    );
    await expect(
      routeToolCall(providerActionCall(entry.appId), caller),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(presentation.state.calls).toBe(0);
    expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  }
});

test("provider presentation capability is shared and consumed by exactly one callback", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const provider = createPresentationProvider(
    { receipt: "ui-once" },
    providerPresentationDescriptor.name,
    {
      review: { detail: "must-not-open-kernel-dialog" },
      secondCallback: "approval",
    },
  );
  const { appScope } = registerScopedBackgroundEndpoint(
    provider.source,
    "provider",
    "807",
    "review",
  );
  const existing = openProviderTile();
  const presentation = createCapturingToolEndpoint(
    providerPresentationDescriptor,
    { receipt: "ui-once" },
  );
  registerScopedTileEndpoint(
    presentation.source,
    "provider",
    "review",
    existing.id,
    appScope,
  );
  await expect(
    routeToolCall(providerActionCall(), caller),
  ).resolves.toEqual({ receipt: "ui-once" });
  expect(provider.state.presentationRequests).toBe(1);
  expect(provider.state.approvalRequests).toBe(1);
  expect(provider.state.interactionResults).toEqual([{ receipt: "ui-once" }]);
  expect(provider.state.interactionErrors).toHaveLength(1);
  expect(JSON.stringify(provider.state.interactionErrors[0])).toContain(
    "already consumed",
  );
  expect(presentation.state.calls).toBe(1);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider presentation rejects Agent invocations before opening a tile or dispatching", async () => {
  installFakeWindow();
  authorizeTestOwner("owner-principal");
  const { resident, root } = await beginSignedCallAgentInvocation();
  const provider = createPresentationProvider({ receipt: "must-not-return" });
  registerScopedBackgroundEndpoint(provider.source, "provider", "808", "review");
  const presentation = createCapturingToolEndpoint(
    providerPresentationDescriptor,
    { receipt: "must-not-dispatch" },
  );

  await expect(
    routeToolCall(
      providerActionCall(),
      resident,
      undefined,
      invocationMetadata(root, true),
    ),
  ).rejects.toMatchObject({ code: "INVOCATION_INVALID" });
  expect(
    useWorkspaceStore
      .getState()
      .workspaces[1].tiles.some((tile) => tile.appId === "provider"),
  ).toBe(false);
  expect(provider.state.calls).toBe(0);
  expect(provider.state.approvalRequests).toBe(0);
  expect(provider.state.presentationRequests).toBe(0);
  expect(provider.state.interactionResults).toEqual([]);
  expect(provider.state.interactionErrors).toEqual([]);
  expect(presentation.state.calls).toBe(0);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
  completeInvocation(root);
});

test("agent-root tools stay hidden and reject forged human audience before dispatch", async () => {
  installFakeWindow();
  const caller = registerTile({} as Window, "requester", "caller");
  const target = createCapturingToolEndpoint(agentRootActionDescriptor, {
    receipt: "must-not-dispatch",
  });
  registerScopedBackgroundEndpoint(target.source, "provider", "809");
  const endpoint = "app:provider:background" as const;

  await expect(listTargetTools(endpoint, caller)).resolves.toEqual([]);
  expect(target.state.descriptorRequests).toBe(1);
  expect(target.state.calls).toBe(0);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
  await expect(
    routeToolCall(
      {
        target: endpoint,
        name: agentRootActionDescriptor.name,
        arguments: { value: "requested" },
        audience: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
      },
      caller,
    ),
  ).rejects.toThrow(`Unknown tool '${agentRootActionDescriptor.name}'`);
  expect(target.state.calls).toBe(0);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
});

test("agent-root tools reject nested invocations but attest and dispatch a direct active root", async () => {
  installFakeWindow();
  authorizeTestOwner("owner-principal");
  const { resident, root } = await beginSignedCallAgentInvocation();
  const intermediarySource = createToolEndpoint(
    activeFakeWindow!,
    echoDescriptor,
    { value: "unused" },
  );
  const intermediary = registerScopedBackgroundEndpoint(
    intermediarySource,
    "requester",
    "810",
  );
  const target = createCapturingToolEndpoint(agentRootActionDescriptor, {
    receipt: "agent-81",
  });
  const providerEndpoint = registerScopedBackgroundEndpoint(
    target.source,
    "provider",
    "811",
  );
  const child = createChildInvocation(root, intermediary, "requester_execute");
  const call = {
    target: "app:provider:background" as const,
    name: agentRootActionDescriptor.name,
    arguments: { value: "requested" },
  };

  await expect(
    routeToolCall(
      call,
      intermediary,
      undefined,
      invocationMetadata(child),
    ),
  ).rejects.toThrow(`Unknown tool '${agentRootActionDescriptor.name}'`);
  expect(target.state.calls).toBe(0);
  completeInvocation(child);

  await expect(
    listTargetTools(
      providerEndpoint.endpointId as typeof call.target,
      resident,
      root,
    ),
  ).resolves.toEqual([agentRootActionDescriptor]);
  await expect(
    routeToolCall(
      call,
      resident,
      undefined,
      invocationMetadata(root, true),
    ),
  ).resolves.toEqual({ receipt: "agent-81" });
  expect(target.state.calls).toBe(1);
  expect(target.state.payloads[0]).toMatchObject({
    name: agentRootActionDescriptor.name,
    arguments: { value: "requested" },
    caller: {
      endpoint: "app:signed_call_agent:background",
      appId: "signed_call_agent",
      role: "background",
    },
    audience: NEUTRON_TOOL_AUDIENCE_AGENT_ROOT,
  });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
  completeInvocation(root);
});

test("provider-owned consent validates arguments without focus or activation", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action" },
    { receipt: "1" },
  );
  unregisters.push(registerBackground(provider.source, "provider"));
  setTransientUserActivation(false);
  await expect(
    routeToolCall(
      { ...providerActionCall(), arguments: {} },
      caller,
    ),
  ).rejects.toThrow("Invalid arguments");
  expect(provider.state.calls).toBe(0);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider-owned consent rejects control and attachment tool combinations", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const cases: Array<[string, JsonObject]> = [
    ["providercontrol", { "neutron:control": "cancel" }],
    [
      "providerbinary",
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
    ],
  ];

  for (const [appId, incompatible] of cases) {
    const provider = createProviderToolEndpoint(
      {
        ...providerActionDescriptor,
        annotations: {
          ...providerActionDescriptor.annotations,
          ...incompatible,
        },
      },
      { detail: "one action" },
      { receipt: "never" },
    );
    unregisters.push(registerBackground(provider.source, appId));
    await expect(
      routeToolCall(
        {
          target: `app:${appId}:background`,
          name: providerActionDescriptor.name,
          arguments: { value: "requested" },
        },
        caller,
      ),
    ).rejects.toThrow(/cannot be combined with control or attachment/);
    expect(provider.state.calls).toBe(0);
    expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  }
});

test("provider-owned consent shows one canonical provider review and ignores grants", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const review = {
    action: "create entry",
    cost: "one credit",
    destination: "example target",
  };
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    review,
    { receipt: "77" },
  );
  unregisters.push(registerBackground(provider.source, "provider"));
  const target = "app:provider:background" as const;
  grantFrontendToolSession("requester", target, providerActionDescriptor.name);

  const pending = routeToolCall(
    {
      target,
      name: providerActionDescriptor.name,
      arguments: { value: "requested" },
    },
    caller,
  );
  for (
    let turn = 0;
    turn < 20 &&
    Object.keys(useMsgBusPermissionStore.getState().requests).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const requests = Object.values(
    useMsgBusPermissionStore.getState().requests,
  );
  expect(provider.state.calls).toBe(1);
  expect(provider.state.approvalRequests).toBe(1);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    caller: { appId: "requester", role: "tile" },
    target,
    tool: providerActionDescriptor.name,
    arguments: {},
    providerReview: review,
    onceOnly: true,
  });
  expect(JSON.stringify(requests[0])).not.toContain("requested");

  await expect(
    routeToolCall(
      {
        target,
        name: providerActionDescriptor.name,
        arguments: { value: "second request" },
      },
      caller,
    ),
  ).rejects.toMatchObject({ code: "UI_BUSY" });
  expect(provider.state.calls).toBe(1);

  if (!provider.state.capability || !requests[0]) {
    throw new Error("Missing provider approval fixture state");
  }
  await expect(
    executeExposedAction(
      "provider_approval.request",
      { capability: provider.state.capability, review },
      { source: provider.source, origin: TEST_FRAME_ORIGIN },
    ),
  ).rejects.toThrow("already consumed");

  approveFrontendToolRequest(requests[0].cid, "once");
  await expect(pending).resolves.toEqual({ receipt: "77" });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider-owned consent fails closed when the handler omits its callback", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action" },
    { receipt: "never" },
    { requestApproval: false },
  );
  unregisters.push(registerBackground(provider.source, "provider"));

  await expect(
    routeToolCall(
      providerActionCall(),
      caller,
    ),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(provider.state.calls).toBe(1);
  expect(provider.state.approvalRequests).toBe(0);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider-owned consent rejects oversized reviews and aborts the handler", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "x".repeat(17 * 1024) },
    { receipt: "never" },
    { catchApprovalError: true },
  );
  unregisters.push(registerBackground(provider.source, "provider"));

  await expect(
    routeToolCall(
      providerActionCall(),
      caller,
    ),
  ).rejects.toThrow("Provider approval review exceeds 16384 bytes");
  expect(provider.state.approvalRequests).toBe(1);
  expect(provider.state.cancelled).toBe(true);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider-owned consent rejects extended approval payloads and aborts the handler", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action" },
    { receipt: "never" },
    {
      catchApprovalError: true,
      approvalExtra: { approved: true },
    },
  );
  unregisters.push(registerBackground(provider.source, "provider"));

  await expect(
    routeToolCall(
      providerActionCall(),
      caller,
    ),
  ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  expect(provider.state.approvalRequests).toBe(1);
  expect(provider.state.caughtApprovalError).toBe(true);
  expect(provider.state.cancelled).toBe(true);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider-owned consent cancels when the provider endpoint is replaced", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action" },
    { receipt: "never" },
  );
  unregisters.push(registerBackground(provider.source, "provider"));
  const pending = routeToolCall(providerActionCall(), caller);
  for (
    let turn = 0;
    turn < 20 &&
    Object.keys(useMsgBusPermissionStore.getState().requests).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(
    Object.values(useMsgBusPermissionStore.getState().requests),
  ).toHaveLength(1);

  const replacement = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "replacement" },
    { receipt: "replacement" },
  );
  unregisters.push(registerBackground(replacement.source, "provider"));
  await expect(pending).rejects.toThrow("Message bus endpoint retired");
  expect(provider.state.cancelled).toBe(true);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider-owned consent cancels when the caller session is replaced", async () => {
  installFakeWindow();
  authorizeTestOwner();
  const caller = registerTile({} as Window, "requester", "caller");
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action" },
    { receipt: "never" },
  );
  unregisters.push(registerBackground(provider.source, "provider"));
  const pending = routeToolCall(providerActionCall(), caller);
  for (
    let turn = 0;
    turn < 20 &&
    Object.keys(useMsgBusPermissionStore.getState().requests).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(
    Object.values(useMsgBusPermissionStore.getState().requests),
  ).toHaveLength(1);

  registerTile({} as Window, "requester", "caller");
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(provider.state.cancelled).toBe(true);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("provider-owned consent rechecks the authorized owner after review", async () => {
  installFakeWindow();
  authorizeTestOwner("owner-one");
  const caller = registerTile({} as Window, "requester", "caller");
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action" },
    { receipt: "never" },
  );
  unregisters.push(registerBackground(provider.source, "provider"));
  const pending = routeToolCall(providerActionCall(), caller);
  for (
    let turn = 0;
    turn < 20 &&
    Object.keys(useMsgBusPermissionStore.getState().requests).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const request = Object.values(
    useMsgBusPermissionStore.getState().requests,
  )[0];
  if (!request) throw new Error("Missing provider review request");
  authorizeTestOwner("owner-two");
  approveFrontendToolRequest(request.cid, "once");
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
});

test("provider-owned consent rechecks owner authority after the approved handler returns", async () => {
  installFakeWindow();
  authorizeTestOwner("owner-one");
  const caller = registerTile({} as Window, "requester", "caller");
  let releaseHandler!: () => void;
  const holdAfterApproval = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action" },
    { receipt: "must-not-return" },
    { holdAfterApproval },
  );
  unregisters.push(registerBackground(provider.source, "provider"));
  const pending = routeToolCall(providerActionCall(), caller);
  for (
    let turn = 0;
    turn < 20 &&
    Object.keys(useMsgBusPermissionStore.getState().requests).length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const request = Object.values(
    useMsgBusPermissionStore.getState().requests,
  )[0];
  if (!request) throw new Error("Missing provider review request");
  approveFrontendToolRequest(request.cid, "once");
  for (
    let turn = 0;
    turn < 20 && !provider.state.approvalSucceeded;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(provider.state.approvalSucceeded).toBe(true);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});

  authorizeTestOwner("owner-two");
  releaseHandler();
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
});

test("a direct Agent root cannot use a public legacy provider tool", async () => {
  installFakeWindow();
  authorizeTestOwner("owner-principal");
  const { resident, root } = await beginSignedCallAgentInvocation();
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action", cost: "one credit" },
    { receipt: "must-not-return" },
  );
  registerScopedBackgroundEndpoint(provider.source, "provider", "501");

  await expect(
    routeToolCall(
      providerActionCall(),
      resident,
      undefined,
      invocationMetadata(root, true),
    ),
  ).rejects.toMatchObject({ code: "INVOCATION_INVALID" });
  expect(provider.state.calls).toBe(0);
  expect(provider.state.approvalRequests).toBe(0);
  expect(provider.state.presentationRequests).toBe(0);
  expect(provider.state.interactionResults).toEqual([]);
  expect(provider.state.interactionErrors).toEqual([]);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
  completeInvocation(root);
});

test("a nested Agent call cannot dispatch a public legacy provider tool", async () => {
  const fakeWindow = installFakeWindow();
  authorizeTestOwner("owner-principal");
  const agent = createAgentConsentEndpoint();
  const { root } = await beginSignedCallAgentInvocation(agent.source);
  const requesterSource = createToolEndpoint(fakeWindow, echoDescriptor, {
    value: "unused",
  });
  const requesterEndpoint = registerScopedBackgroundEndpoint(
    requesterSource,
    "requester",
    "601",
  );
  const provider = createProviderToolEndpoint(
    providerActionDescriptor,
    { detail: "one action", cost: "one credit" },
    { receipt: "must-not-return" },
  );
  registerScopedBackgroundEndpoint(provider.source, "provider", "602");
  const requesterInvocation = createChildInvocation(
    root,
    requesterEndpoint,
    "requester_execute",
  );

  await expect(
    routeToolCall(
      providerActionCall(),
      requesterEndpoint,
      undefined,
      invocationMetadata(requesterInvocation),
    ),
  ).rejects.toMatchObject({ code: "INVOCATION_INVALID" });
  expect(agent.challenges).toEqual([]);
  expect(provider.state.calls).toBe(0);
  expect(provider.state.approvalRequests).toBe(0);
  expect(provider.state.presentationRequests).toBe(0);
  expect(provider.state.interactionResults).toEqual([]);
  expect(provider.state.interactionErrors).toEqual([]);
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useRequestStore.getState().calls).toEqual({});
  completeInvocation(requesterInvocation);
  completeInvocation(root);
});

test("permission requests cancel through tool and direct action routes", async () => {
  installFakeWindow();
  const callerSource = {} as Window;
  const caller = registerTile(callerSource, "gemma", "caller");
  unregisters.push(registerBackground({} as Window, "notes"));
  const target = "app:notes:background" as const;

  for (const direct of [false, true]) {
    const controller = new AbortController();
    const argumentsPayload = { target, tool: "echo", arguments: {} };
    const pending = direct
      ? Promise.resolve(
          executeExposedAction("permissions.request", argumentsPayload, {
            source: callerSource,
            origin: TEST_FRAME_ORIGIN,
            signal: controller.signal,
          }),
        )
      : routeToolCall(
          {
            target: "kernel",
            name: "permissions.request",
            arguments: argumentsPayload,
          },
          caller,
          undefined,
          undefined,
          undefined,
          controller.signal,
        );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      Object.values(useMsgBusPermissionStore.getState().requests),
    ).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  }
});

test("an app tool named workspace.open_tile keeps generic owner attention", async () => {
  const pending = requestFrontendToolPermission({
    caller: {
      endpoint: "app:requester:background",
      appId: "requester",
      role: "background",
    },
    target: "app:provider:background",
    tool: "workspace.open_tile",
  });
  expect(useUiAttentionStore.getState().active).toMatchObject({
    appId: "requester",
    kind: "frontend_tool",
  });
  const request = Object.values(
    useMsgBusPermissionStore.getState().requests,
  )[0];
  if (!request) throw new Error("Missing generic tool-name collision request");
  rejectFrontendToolRequest(request.cid);
  await expect(pending).rejects.toThrow("User rejected frontend tool access");
});

test("a cross-app tray call retains tray provenance in explicit consent", async () => {
  const fakeWindow = installFakeWindow();
  const caller = registerTray({} as Window, "mail", "panel-one");
  const targetSource = createToolEndpoint(fakeWindow, echoDescriptor, {
    value: "approved",
  });
  unregisters.push(registerBackground(targetSource, "notes"));
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
  const generation = useAppsStore.getState().runtimeGenerations.hello ?? 0;
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

  useAppsStore
    .getState()
    .setApps({ hello: app }, { invalidateAppIds: ["hello"] });

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
  expect(schema.oneOf?.map((option) => option.properties?.kind?.const)).toEqual(
    ["package_url", "repository_setup_url"],
  );
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
        origin: TEST_FRAME_ORIGIN,
      },
    ),
  );
  unregisters.push(
    registerFrameContext(
      backgroundSource,
      { role: "background", appId },
      {
        appScope: { appId, installationUid },
        origin: TEST_FRAME_ORIGIN,
      },
    ),
  );
  authenticateLoadedTestFrame(tileSource);
  authenticateLoadedTestFrame(backgroundSource);
  const tile = getRegisteredEndpoint(`app:${appId}:tile:chat:instance:root`);
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
        connected: true,
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

test("direct app calls open tiles only in the current workspace", async () => {
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

test("workspace.open_tile does not depend on direct tile focus or activation", async () => {
  installFakeWindow();
  setTransientUserActivation(false);
  const target = installWorkspaceOpenTarget();
  const callerInstance = useWorkspaceStore.getState().openTile({
    appId: "kitchensink",
    tileId: "main",
    title: "Kitchen Sink",
    path: "index.html",
    icon: "static/icon.svg",
  });
  const callerSource = {} as Window;
  const caller = registerTile(
    callerSource,
    "kitchensink",
    callerInstance.id,
  );
  const focusDocument = installTestFocusDocument();
  focusDocument.addFrame({
    appId: "kitchensink",
    tileId: "main",
    instanceId: callerInstance.id,
    source: callerSource,
  });
  const targetFrame = focusDocument.addFrame({
    appId: "hello",
    tileId: "main",
    instanceId: target.id,
    source: {} as Window,
  });
  focusDocument.activeElement = null;

  await expect(openWorkspaceTarget(caller)).resolves.toEqual({
    instanceId: target.id,
    workspace: 1,
    opened: false,
  });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(focusDocument.activeElement as unknown).toBe(targetFrame);
});

test("workspace.open_tile lets a live background open an installed tile", async () => {
  installFakeWindow();
  setTransientUserActivation(false);
  const target = installWorkspaceOpenTarget();
  const focusDocument = installTestFocusDocument();
  const targetFrame = focusDocument.addFrame({
    appId: "hello",
    tileId: "main",
    instanceId: target.id,
    source: {} as Window,
  });
  const source = {} as Window;
  unregisters.push(registerBackground(source, "kitchensink"));
  const caller = getRegisteredEndpoint("app:kitchensink:background");
  if (!caller) throw new Error("Background caller did not register");

  await expect(openWorkspaceTarget(caller)).resolves.toEqual({
    instanceId: target.id,
    workspace: 1,
    opened: false,
  });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(focusDocument.activeElement as unknown).toBe(targetFrame);
});

test("workspace.open_tile lets a live tray open another app's tile", async () => {
  installFakeWindow();
  setTransientUserActivation(false);
  const target = installWorkspaceOpenTarget();
  const caller = registerTray({} as Window, "kitchensink", "panel-one");

  await expect(openWorkspaceTarget(caller)).resolves.toEqual({
    instanceId: target.id,
    workspace: 1,
    opened: false,
  });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
});

test("direct calls reuse an existing app tile in the current workspace", async () => {
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

test("a challenged Agent reuse cannot become a new tile after approval", async () => {
  installFakeWindow();
  authorizeTestOwner("owner-principal");
  let releaseDecision!: () => void;
  const decisionGate = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  const agent = createAgentConsentEndpoint("allow", { decisionGate });
  const { resident, root } = await beginSignedCallAgentInvocation(agent.source);
  useAppsStore.setState((state) => ({
    list: {
      ...state.list,
      targetapp: registryApp({
        id: "targetapp",
        name: "Target App",
        tiles: [
          {
            id: "main",
            title: "Target",
            path: "index.html",
            icon: "static/icon.svg",
          },
        ],
      }),
    },
  }));
  const existing = useWorkspaceStore.getState().openTile({
    appId: "targetapp",
    tileId: "main",
    title: "Target",
    path: "index.html",
    icon: "static/icon.svg",
  });
  const child = createChildInvocation(root, resident, "focus_target");

  const pending = routeToolCall(
    {
      target: "kernel",
      name: "workspace.open_tile",
      arguments: { appId: "targetapp", tileId: "main" },
    },
    resident,
    undefined,
    invocationMetadata(child),
  );
  void pending.catch(() => undefined);
  for (
    let turn = 0;
    turn < 50 && agent.challenges.length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(agent.challenges).toHaveLength(1);
  expect(agent.challenges[0]).toMatchObject({
    kind: "workspace_open",
    action: { appId: "targetapp", tileId: "main", createsTile: false },
  });

  useWorkspaceStore.getState().closeTile(existing.id);
  releaseDecision();

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(
    useWorkspaceStore
      .getState()
      .workspaces[1].tiles.some((tile) => tile.appId === "targetapp"),
  ).toBe(false);
  completeInvocation(child);
  completeInvocation(root);
});

test("a challenged Agent navigation cannot restore a stale workspace", async () => {
  installFakeWindow();
  authorizeTestOwner("owner-principal");
  let releaseDecision!: () => void;
  const decisionGate = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  const agent = createAgentConsentEndpoint("allow", { decisionGate });
  const { resident, root } = await beginSignedCallAgentInvocation(agent.source);
  useAppsStore.setState((state) => ({
    list: {
      ...state.list,
      targetapp: registryApp({
        id: "targetapp",
        name: "Target App",
        tiles: [
          {
            id: "main",
            title: "Target",
            path: "index.html",
            icon: "static/icon.svg",
          },
        ],
      }),
    },
  }));
  useWorkspaceStore.getState().openTile({
    appId: "targetapp",
    tileId: "main",
    title: "Target",
    path: "index.html",
    icon: "static/icon.svg",
  });
  const ownerTile = useWorkspaceStore.getState().openTile({
    appId: "owner",
    tileId: "main",
    title: "Owner",
    path: "index.html",
    icon: "static/icon.svg",
  });
  const child = createChildInvocation(root, resident, "focus_target");

  const pending = routeToolCall(
    {
      target: "kernel",
      name: "workspace.open_tile",
      arguments: { appId: "targetapp", tileId: "main" },
    },
    resident,
    undefined,
    invocationMetadata(child),
  );
  void pending.catch(() => undefined);
  for (
    let turn = 0;
    turn < 50 && agent.challenges.length === 0;
    turn += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(agent.challenges[0]).toMatchObject({
    kind: "workspace_open",
    action: { appId: "targetapp", tileId: "main", workspace: 1 },
  });

  useWorkspaceStore.getState().switchWorkspace(2);
  releaseDecision();

  await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(2);
  expect(useWorkspaceStore.getState().workspaces[1].focusedTileId).toBe(
    ownerTile.id,
  );
  completeInvocation(child);
  completeInvocation(root);
});

test("an unfocused direct caller opens a missing tile without consent", async () => {
  installFakeWindow();
  const callerInstance = useWorkspaceStore.getState().openTile({
    appId: "wallet",
    tileId: "wallet",
    title: "Wallet",
    path: "index.html",
    icon: "/app/wallet/static/icon.svg",
  });
  const caller = registerTile({} as Window, "wallet", callerInstance.id);
  useWorkspaceStore.getState().openTile({
    appId: "notes",
    tileId: "main",
    title: "Notes",
    path: "index.html",
    icon: "/app/notes/static/icon.svg",
  });
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

  await expect(
    routeToolCall(
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
    ),
  ).resolves.toMatchObject({ opened: true, workspace: 1 });
  expect(useMsgBusPermissionStore.getState().requests).toEqual({});
  expect(useWorkspaceStore.getState().workspaces[1].tiles).toHaveLength(3);
});

test("a delayed tile mount follows the canonical workspace focus", async () => {
  installFakeWindow();
  const callerSource = {} as Window;
  const callerInstance = useWorkspaceStore.getState().openTile({
    appId: "requester",
    tileId: "main",
    title: "Requester",
    path: "index.html",
    icon: "static/icon.svg",
  });
  const caller = registerTile(
    callerSource,
    "requester",
    callerInstance.id,
  );
  useAppsStore.setState({
    list: {
      target: registryApp({
        id: "target",
        name: "Target",
        tiles: [
          {
            id: "main",
            title: "Target",
            path: "index.html",
            icon: "static/icon.svg",
          },
        ],
      }),
    },
  });
  const focusDocument = installTestFocusDocument();
  const callerFrame = focusDocument.addFrame({
    appId: "requester",
    tileId: "main",
    instanceId: callerInstance.id,
    source: callerSource,
  });

  await routeToolCall(
    {
      target: "kernel",
      name: "workspace.open_tile",
      arguments: { appId: "target", tileId: "main" },
    },
    caller,
  );
  const targetInstance = useWorkspaceStore
    .getState()
    .workspaces[1].tiles.find((tile) => tile.appId === "target");
  if (!targetInstance) throw new Error("Target tile did not open");

  focusTestTile(callerInstance.id);
  focusDocument.activeElement = callerFrame;
  const targetFrame = focusDocument.addFrame({
    appId: "target",
    tileId: "main",
    instanceId: targetInstance.id,
    source: {} as Window,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  expect(targetFrame.focusCalls).toBe(0);
  expect(focusDocument.activeElement).toBe(callerFrame);
});
