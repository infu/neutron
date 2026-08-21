import { Principal } from "@dfinity/principal";
import {
  canisterIdFromUrl,
  kernelParentOriginFromAppUrl,
} from "./runtime.js";
import { normalizeUntrustedText } from "./schema.js";
import {
  isMsgBusFrameProbe,
  MSG_BUS_FRAME_READY,
} from "./frame_handshake.js";
import {
  MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
  MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
  MSG_BUS_MAX_PAYLOAD_BYTES,
  MSG_BUS_MAX_PROGRESS_BYTES,
  MSG_BUS_MAX_PROGRESS_EVENTS,
  NEUTRON_TOOL_CONTROL_CANCEL,
  SELF_CALL_BINARY_MAX_BYTES,
  SELF_CALL_BINARY_MAX_COUNT,
  SELF_CALL_METADATA_MAX_BYTES,
  SELF_CALL_VALUE_MAX_CONTAINER_ELEMENTS,
  SELF_CALL_VALUE_MAX_DEPTH,
  VET_KEYS_ERROR_CODES,
  assertBoundedJson,
  assertToolName,
  isAppStateChangeEnvelope,
  isExecEnvelope,
  isJsonObject,
  isJsonValue,
  isProgressEnvelope,
  isRecord,
  isResponseEnvelope,
  msgBusLocalActions,
  normalizeToolDescriptor,
  serializeError,
  toError,
  validateToolArguments,
  validateToolResult,
} from "./protocol.js";
import type {
  AgentConsentChallenge,
  AgentConsentDecision,
  AgentConsentHandler,
  AgentConsentRegistration,
  AgentModeStatus,
  AppInstallOfferRequest,
  AppInstallOfferResult,
  AppStateChange,
  AppStateChangeEnvelope,
  AppStateChangeListener,
  BackendCallReservationAction,
  BackendCallReservationsRequest,
  EthereumProviderConnection,
  EthereumProviderRequestArguments,
  EthereumProviderProxy,
  ExecEnvelope,
  ExposedToolOptions,
  JsonFetcher,
  JsonObject,
  JsonValue,
  KernelCallPayload,
  KernelSchemaPayload,
  MethodSchemaJson,
  MsgBusCallOptions,
  MsgBusCallerContext,
  MsgBusClient,
  MsgBusConnectEnvelope,
  MsgBusEndpointId,
  MsgBusInvocationMetadata,
  MsgBusToolCall,
  MsgBusToolContext,
  MsgBusToolDescriptor,
  MsgBusToolHandler,
  MsgBusTransportContext,
  NeutronCanisterClient,
  OpenAppTileRequest,
  OpenAppTileResult,
  ProgressEnvelope,
  ResponseEnvelope,
  ScopedKernelClient,
  SelfCallBlobPathSegment,
  SelfCallExecEnvelope,
  SelfCallObject,
  SelfCallResponseEnvelope,
  SelfCallValue,
  SelfCallWireBlob,
  TileViewEnvelope,
  TrayState,
  VetKeyDeriveChallenge,
  VetKeyDeriveOptions,
  VetKeyDeriveRequest,
  VetKeyDeriveResult,
  VetKeyPublicInfo,
  VetKeysError,
  VetKeysErrorCode,
  VetKeysLifecycleRequest,
  VetKeysLifecycleResult,
  VetKeysListResult,
  VetKeySlotSummary,
} from "./protocol.js";

export * from "./protocol.js";

const canisterIdPattern = /^[a-z0-9-]+$/;
const isMessageId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

type Callback = {
  resolve: (value: JsonValue) => void;
  reject: (reason?: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  source: MessagePort;
  onProgress?: (value: JsonValue) => void;
  progressCount: number;
};

type SelfCallCallback = {
  resolve: (value: SelfCallValue) => void;
  reject: (reason?: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
  source: MessagePort;
};

let nextId = 0;
const callbacks = new Map<number, Callback>();
const selfCallCallbacks = new Map<number, SelfCallCallback>();
let installedWindow: Window | undefined;
let kernelPort: MessagePort | undefined;
const kernelPortWaiters = new Set<{
  resolve: (port: MessagePort) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}>();
const installedPorts = new WeakSet<MessagePort>();
const localTools = new Map<
  string,
  { descriptor: MsgBusToolDescriptor; handler: MsgBusToolHandler }
>();
const tileViewListeners = new Set<(view: string) => void>();
const pendingTileViews: string[] = [];
const appStateListeners = new Map<string, Set<AppStateChangeListener>>();
const agentConsentHandlers = new Map<
  string,
  {
    capability: string;
    handler?: AgentConsentHandler;
    cancelHandler?: () => void;
  }
>();
const invocationAbortControllers = new Map<
  string,
  Map<string, AbortController>
>();

function getWindow(): Window {
  if (typeof window === "undefined") {
    throw new Error("neutron-tools exec requires a browser window");
  }
  return window;
}

function postPortMessage(
  target: MessagePort,
  message:
    | ExecEnvelope
    | ResponseEnvelope
    | ProgressEnvelope
    | AppStateChangeEnvelope
): void {
  target.postMessage(message);
}

function handleMessage(event: MessageEvent): void {
  if (!isAuthenticatedParentMessage(event)) return;
  if (isMsgBusFrameProbe(event.data)) {
    announceFrameReady();
    return;
  }
  if (isMsgBusConnectEnvelope(event.data)) {
    acceptKernelPort(event);
  }
}

function handlePortMessage(event: MessageEvent, port: MessagePort): void {
  handlePeerMessage(event.data, port);
}

function handlePeerMessage(
  data: unknown,
  source: MessagePort
): void {
  if (isTileViewEnvelope(data) && isKernelPeer(source)) {
    dispatchTileView(data.view);
    return;
  }
  if (isAppStateChangeEnvelope(data) && isKernelPeer(source)) {
    dispatchAppStateChange(data);
    return;
  }
  if (
    isRecord(data) &&
    data.type === "neutron:self-call:response"
  ) {
    handleSelfCallResponseMessage(data, source);
    return;
  }
  if (isProgressEnvelope(data)) {
    handleProgressMessage(data, source);
    return;
  }
  if (isResponseEnvelope(data)) {
    handleResponseMessage(data, source);
    return;
  }

  if (isExecEnvelope(data)) {
    void handleLocalToolMessage(data, source);
  }
}

function isKernelPeer(source: MessagePort): boolean {
  return kernelPort === source;
}

function isAuthenticatedParentMessage(event: MessageEvent): boolean {
  const currentWindow = getWindow();
  if (event.source !== currentWindow.parent) return false;
  const expectedOrigin = expectedKernelParentOrigin();
  return expectedOrigin !== null && event.origin === expectedOrigin;
}

function dispatchTileView(view: string): void {
  if (tileViewListeners.size === 0) {
    if (pendingTileViews.length >= 8) pendingTileViews.shift();
    pendingTileViews.push(view);
    return;
  }
  for (const listener of tileViewListeners) {
    try {
      listener(view);
    } catch {
      // A view listener cannot interfere with the message bus transport.
    }
  }
}

function dispatchAppStateChange(change: AppStateChangeEnvelope): void {
  const listeners = appStateListeners.get(change.topic);
  if (!listeners) return;
  const value: AppStateChange = {
    topic: change.topic,
    revision: change.revision,
  };
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // A state listener cannot interfere with message-bus transport.
    }
  }
}

function handleProgressMessage(
  progress: ProgressEnvelope,
  source: MessagePort
): void {
  const callback = callbacks.get(progress.id);
  if (!callback || callback.source !== source || !callback.onProgress) return;
  if (callback.progressCount >= MSG_BUS_MAX_PROGRESS_EVENTS) return;
  try {
    assertBoundedJson(
      progress.value,
      "Progress payload",
      MSG_BUS_MAX_PROGRESS_BYTES
    );
  } catch {
    return;
  }

  callback.progressCount += 1;
  try {
    callback.onProgress(progress.value);
  } catch {
    // Consumer progress handlers cannot affect final request completion.
  }
}

function handleResponseMessage(
  response: ResponseEnvelope,
  source: MessagePort
): void {
  const callback = callbacks.get(response.id);
  if (!callback || callback.source !== source) return;

  if (callback.timeout) clearTimeout(callback.timeout);
  callbacks.delete(response.id);

  if (Object.hasOwn(response, "error")) {
    callback.reject(toError(response.error));
  } else {
    callback.resolve(response.ok ?? null);
  }
}

async function handleLocalToolMessage(
  request: ExecEnvelope,
  responseTarget: MessagePort
): Promise<void> {
  const action = request.payload.action;
  if (
    action !== msgBusLocalActions.toolsList &&
    action !== msgBusLocalActions.toolsCall &&
    action !== msgBusLocalActions.agentConsentDecide &&
    action !== msgBusLocalActions.agentTurnCancel
  ) {
    return;
  }
  if (
    (action === msgBusLocalActions.agentConsentDecide ||
      action === msgBusLocalActions.agentTurnCancel) &&
    responseTarget !== kernelPort
  ) {
    return;
  }

  try {
    let progressCount = 0;
    const reportProgress = (value: JsonValue): void => {
      if (progressCount >= MSG_BUS_MAX_PROGRESS_EVENTS) return;
      assertBoundedJson(value, "Progress payload", MSG_BUS_MAX_PROGRESS_BYTES);
      progressCount += 1;
      postPortMessage(
        responseTarget,
        { type: "progress", id: request.id, value }
      );
    };
    const ok =
      action === msgBusLocalActions.toolsList
        ? listExposedTools()
        : action === msgBusLocalActions.agentConsentDecide
          ? await decideAgentConsent(request.payload.payload)
          : action === msgBusLocalActions.agentTurnCancel
            ? cancelAgentTurn(request.payload.payload)
          : await callExposedTool(
              request.payload.payload,
              reportProgress,
              request.payload.context?.invocation,
            );
    assertBoundedJson(ok, "Tool result");
    postPortMessage(responseTarget, {
      type: "response",
      id: request.id,
      ok,
    });
  } catch (error) {
    postPortMessage(responseTarget, {
      type: "response",
      id: request.id,
      error: serializeError(error),
    });
  }
}

async function decideAgentConsent(payload: JsonValue): Promise<JsonValue> {
  if (!isJsonObject(payload) || !isAgentConsentChallenge(payload)) {
    throw new Error("Invalid agent consent challenge");
  }
  const registered = agentConsentHandlers.get(payload.rootId);
  if (!registered?.handler) throw new Error("Agent consent handler is not active");
  const decision = await registered.handler(payload);
  if (
    !isJsonObject(decision) ||
    (decision.decision !== "allow" && decision.decision !== "deny") ||
    typeof decision.reason !== "string" ||
    decision.reason.length > 240 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(decision.reason)
  ) {
    throw new Error("Invalid agent consent decision");
  }
  return {
    decision: decision.decision,
    reason: decision.reason,
  };
}

function cancelAgentTurn(payload: JsonValue): JsonValue {
  if (!isJsonObject(payload) || typeof payload.rootId !== "string") {
    throw new Error("Invalid agent cancellation");
  }
  const registered = agentConsentHandlers.get(payload.rootId);
  registered?.cancelHandler?.();
  agentConsentHandlers.delete(payload.rootId);
  const controllers = invocationAbortControllers.get(payload.rootId);
  if (controllers) {
    for (const controller of controllers.values()) controller.abort();
    invocationAbortControllers.delete(payload.rootId);
  }
  return {};
}

function isAgentConsentChallenge(
  value: JsonObject,
): value is AgentConsentChallenge {
  return (
    value.version === 1 &&
    typeof value.id === "string" &&
    typeof value.rootId === "string" &&
    typeof value.expiresAt === "number" &&
    isJsonObject(value.requester) &&
    typeof value.requester.appId === "string" &&
    (value.requester.role === "tile" ||
      value.requester.role === "background" ||
      value.requester.role === "tray") &&
    Array.isArray(value.chain) &&
    value.chain.every(
      (entry) =>
        isJsonObject(entry) &&
        typeof entry.appId === "string" &&
        typeof entry.tool === "string",
    ) &&
    [
      "frontend_tool",
      "signed_canister_call",
      "backend_access",
      "connection",
      "workspace_open",
    ].includes(String(value.kind)) &&
    ["none", "session", "durable"].includes(String(value.persistence)) &&
    ["low", "medium", "high"].includes(String(value.risk)) &&
    isJsonObject(value.action)
  );
}

function isMsgBusConnectEnvelope(value: unknown): value is MsgBusConnectEnvelope {
  return (
    isRecord(value) &&
    value.type === "neutron:msgbus:connect" &&
    value.version === 1 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length >= 16
  );
}

function isTileViewEnvelope(value: unknown): value is TileViewEnvelope {
  return (
    isRecord(value) &&
    value.type === "neutron:tile:view" &&
    value.version === 1 &&
    typeof value.view === "string" &&
    /^[a-z][a-z0-9_/-]{0,63}$/u.test(value.view)
  );
}

function acceptKernelPort(event: MessageEvent<MsgBusConnectEnvelope>): void {
  const currentWindow = getWindow();
  if (event.source !== currentWindow.parent) return;
  const port = event.ports[0];
  if (!port) return;

  if (kernelPort) {
    rejectCallbacksForPeer(kernelPort, "Message bus connection replaced");
    kernelPort.close();
  }
  kernelPort = port;
  installPortListener(port);
  for (const waiter of kernelPortWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve(port);
  }
  kernelPortWaiters.clear();
}

function installPortListener(port: MessagePort): void {
  if (installedPorts.has(port)) return;
  port.addEventListener("message", (event) => handlePortMessage(event, port));
  port.start();
  installedPorts.add(port);
}

export function installMessageListener(targetWindow = getWindow()): void {
  if (installedWindow === targetWindow) return;
  targetWindow.addEventListener("message", handleMessage);
  installedWindow = targetWindow;
}

export function disconnectMsgBus(): void {
  if (kernelPort) {
    rejectCallbacksForPeer(kernelPort, "Message bus disconnected");
    kernelPort.close();
  }
  kernelPort = undefined;
  for (const [id, callback] of selfCallCallbacks) {
    if (callback.timeout) clearTimeout(callback.timeout);
    callback.reject(new Error("Message bus disconnected"));
    selfCallCallbacks.delete(id);
  }
  agentConsentHandlers.clear();
  for (const controllers of invocationAbortControllers.values()) {
    for (const controller of controllers.values()) controller.abort();
  }
  invocationAbortControllers.clear();
  for (const waiter of kernelPortWaiters) {
    clearTimeout(waiter.timeout);
    waiter.reject(new Error("Message bus disconnected"));
  }
  kernelPortWaiters.clear();
}

function rejectCallbacksForPeer(
  peer: MessagePort,
  message: string
): void {
  for (const [id, callback] of callbacks) {
    if (callback.source !== peer) continue;
    if (callback.timeout) clearTimeout(callback.timeout);
    callbacks.delete(id);
    callback.reject(new Error(message));
  }
  for (const [id, callback] of selfCallCallbacks) {
    if (callback.source !== peer) continue;
    if (callback.timeout) clearTimeout(callback.timeout);
    selfCallCallbacks.delete(id);
    callback.reject(new Error(message));
  }
}

export function execPort<T extends JsonValue = JsonValue>(
  target: MessagePort,
  action: string,
  payload: JsonValue = null,
  options: number | MsgBusCallOptions = 0
): Promise<T> {
  installPortListener(target);
  return execPeer<T>(target, action, payload, options);
}

function execPeer<T extends JsonValue = JsonValue>(
  target: MessagePort,
  action: string,
  payload: JsonValue,
  options: number | MsgBusCallOptions,
  context?: MsgBusTransportContext,
): Promise<T> {
  if (!action) throw new Error("Action is required");
  assertBoundedJson(payload);

  const id = ++nextId;
  const normalizedOptions =
    typeof options === "number" ? { timeout: options } : options;
  const timeout = normalizedOptions.timeout ?? 0;

  return new Promise<T>((resolve, reject) => {
    const timeoutCallback = timeout
      ? setTimeout(() => {
          callbacks.delete(id);
          reject(new Error("Timeout after " + timeout + " seconds"));
        }, 1000 * timeout)
      : undefined;

    callbacks.set(id, {
      resolve: resolve as (value: JsonValue) => void,
      reject,
      source: target,
      ...(normalizedOptions.onProgress
        ? { onProgress: normalizedOptions.onProgress }
        : {}),
      progressCount: 0,
      ...(timeoutCallback ? { timeout: timeoutCallback } : {}),
    });

    postPortMessage(
      target,
      {
        type: "exec",
        id,
        payload: {
          action,
          payload,
          ...(context ?? normalizedOptions.transportContext
            ? { context: context ?? normalizedOptions.transportContext }
            : {}),
        },
      } satisfies ExecEnvelope
    );
  });
}

export function exec<T extends JsonValue = JsonValue>(
  action: string,
  payload: JsonValue = null,
  options: number | MsgBusCallOptions = 0
): Promise<T> {
  if (kernelPort) {
    return execPort<T>(kernelPort, action, payload, options);
  }
  return waitForKernelPort().then((port) =>
    execPort<T>(port, action, payload, options)
  );
}

function waitForKernelPort(): Promise<MessagePort> {
  if (kernelPort) return Promise.resolve(kernelPort);
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        kernelPortWaiters.delete(waiter);
        reject(new Error("Message bus connection timed out"));
      }, 2_000),
    };
    kernelPortWaiters.add(waiter);
  });
}

function expectedKernelParentOrigin(): string | null {
  try {
    return kernelParentOriginFromAppUrl(getWindow().location.href);
  } catch {
    return null;
  }
}

function announceFrameReady(): void {
  const currentWindow = getWindow();
  if (currentWindow.parent === currentWindow) return;
  const origin = expectedKernelParentOrigin();
  if (
    !origin ||
    typeof (currentWindow.parent as Window).postMessage !== "function"
  ) {
    return;
  }
  currentWindow.parent.postMessage(MSG_BUS_FRAME_READY, origin);
}

export function exposeTool(
  name: string,
  options: ExposedToolOptions,
  handler: MsgBusToolHandler
): void {
  if (typeof handler !== "function") {
    throw new Error("Tool handler must be a function");
  }

  const descriptor = normalizeToolDescriptor({ name, ...options });
  localTools.set(name, {
    descriptor,
    handler,
  });
}

export function removeExposedTool(name: string): boolean {
  return localTools.delete(name);
}

export function listExposedTools(): MsgBusToolDescriptor[] {
  return [...localTools.values()].map(({ descriptor }) => descriptor);
}

async function callExposedTool(
  payload: JsonValue,
  reportProgress: (value: JsonValue) => void,
  invocation?: MsgBusInvocationMetadata,
): Promise<JsonValue> {
  if (!isJsonObject(payload) || typeof payload.name !== "string") {
    throw new Error("Invalid tool call payload");
  }
  const registered = localTools.get(payload.name);
  if (!registered) throw new Error(`Unknown tool '${payload.name}'`);

  if (
    "arguments" in payload &&
    payload.arguments !== undefined &&
    !isJsonObject(payload.arguments)
  ) {
    throw new Error("Tool arguments must be a JSON object");
  }
  const args = isJsonObject(payload.arguments) ? payload.arguments : {};
  const caller =
    "caller" in payload && isJsonObject(payload.caller)
      ? (payload.caller as MsgBusCallerContext)
      : undefined;
  validateToolArguments(registered.descriptor, args);
  const registration = invocation?.agentConsent
    ? createAgentConsentRegistration(invocation)
    : undefined;
  const abortRegistration = invocation
    ? createInvocationAbortRegistration(invocation)
    : undefined;
  try {
    const result = await registered.handler(args, {
      ...(caller ? { caller } : {}),
      reportProgress,
      kernel: invocation
        ? createScopedMsgBusClient(invocation)
        : createMsgBusClient(),
      agentMode: invocation !== undefined,
      ...(abortRegistration ? { signal: abortRegistration.signal } : {}),
      ...(registration ? { agentConsent: registration.api } : {}),
    });
    assertBoundedJson(result, `Tool '${payload.name}' result`);
    validateToolResult(registered.descriptor, result);
    return result;
  } finally {
    abortRegistration?.dispose();
    registration?.dispose();
  }
}

function createInvocationAbortRegistration(
  invocation: MsgBusInvocationMetadata,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const controllers =
    invocationAbortControllers.get(invocation.rootId) ??
    new Map<string, AbortController>();
  controllers.set(invocation.capability, controller);
  invocationAbortControllers.set(invocation.rootId, controllers);
  return {
    signal: controller.signal,
    dispose() {
      const active = invocationAbortControllers.get(invocation.rootId);
      if (active?.get(invocation.capability) !== controller) return;
      active.delete(invocation.capability);
      if (active.size === 0) {
        invocationAbortControllers.delete(invocation.rootId);
      }
    },
  };
}

function createAgentConsentRegistration(invocation: MsgBusInvocationMetadata): {
  api: AgentConsentRegistration;
  dispose(): void;
} {
  let current: AgentConsentHandler | null = null;
  let cancelHandler: (() => void) | null = null;
  const dispose = (): void => {
    const registered = agentConsentHandlers.get(invocation.rootId);
    if (registered?.capability === invocation.capability) {
      agentConsentHandlers.delete(invocation.rootId);
    }
    current = null;
    cancelHandler = null;
  };
  return {
    api: {
      register(handler) {
        if (typeof handler !== "function") {
          throw new Error("Agent consent handler must be a function");
        }
        if (current) throw new Error("Agent consent handler already registered");
        current = handler;
        agentConsentHandlers.set(invocation.rootId, {
          ...agentConsentHandlers.get(invocation.rootId),
          capability: invocation.capability,
          handler,
        });
        return dispose;
      },
      onCancel(handler) {
        if (typeof handler !== "function") {
          throw new Error("Agent cancellation handler must be a function");
        }
        cancelHandler = handler;
        agentConsentHandlers.set(invocation.rootId, {
          ...agentConsentHandlers.get(invocation.rootId),
          capability: invocation.capability,
          cancelHandler: handler,
        });
        return () => {
          if (cancelHandler === handler) cancelHandler = null;
          const registered = agentConsentHandlers.get(invocation.rootId);
          if (registered?.cancelHandler === handler) {
            delete registered.cancelHandler;
          }
        };
      },
    },
    dispose,
  };
}

export function callTool<T extends JsonValue = JsonValue>(
  call: MsgBusToolCall,
  options: number | MsgBusCallOptions = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS
): Promise<T> {
  return exec(toolCallAction(options), call, options);
}

function toolCallAction(
  options: number | MsgBusCallOptions,
): "tools.call" | "tools.call.control" {
  if (typeof options === "number" || options.control === undefined) {
    return "tools.call";
  }
  if (options.control === NEUTRON_TOOL_CONTROL_CANCEL) {
    return "tools.call.control";
  }
  throw new Error("Unsupported tool control mode");
}

export function listTools(
  target?: MsgBusEndpointId,
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS
): Promise<MsgBusToolDescriptor[]> {
  return exec<MsgBusToolDescriptor[]>(
    "tools.list",
    target ? { target } : {},
    timeout
  );
}

export function listApps(
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS
): Promise<JsonValue> {
  return callTool(
    { target: "kernel", name: "apps.list", arguments: {} },
    timeout
  );
}

export function describeApp(
  appId: string,
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS
): Promise<JsonValue> {
  return callTool(
    { target: "kernel", name: "apps.describe", arguments: { appId } },
    timeout
  );
}

export function listEndpoints(
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS
): Promise<JsonValue> {
  return callTool(
    { target: "kernel", name: "endpoints.list", arguments: {} },
    timeout
  );
}

export function createMsgBusClient(): ScopedKernelClient {
  return {
    listApps,
    describeApp,
    listEndpoints,
    listTools,
    callTool,
    querySelf,
    updateSelf,
  };
}

function createScopedMsgBusClient(
  invocation: MsgBusInvocationMetadata,
): ScopedKernelClient {
  const boundInvocation = Object.freeze({ ...invocation });
  const scopedCallTool = <T extends JsonValue = JsonValue>(
    call: MsgBusToolCall,
    options: number | MsgBusCallOptions = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
  ): Promise<T> =>
    execWithTransportContext<T>(
      toolCallAction(options),
      call,
      options,
      { invocation: boundInvocation },
    );

  return {
    listApps: (timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS) =>
      scopedCallTool(
        { target: "kernel", name: "apps.list", arguments: {} },
        timeout,
      ),
    describeApp: (appId, timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS) =>
      scopedCallTool(
        { target: "kernel", name: "apps.describe", arguments: { appId } },
        timeout,
      ),
    listEndpoints: (timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS) =>
      scopedCallTool(
        { target: "kernel", name: "endpoints.list", arguments: {} },
        timeout,
      ),
    listTools: (
      target,
      timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
    ) =>
      execWithTransportContext<MsgBusToolDescriptor[]>(
        "tools.list",
        target ? { target } : {},
        timeout,
        { invocation: boundInvocation },
      ),
    callTool: scopedCallTool,
    querySelf: <T extends SelfCallValue = JsonValue>(
      method: string,
      args: SelfCallValue[] = [],
      timeout = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
    ) =>
      execSelfCall<T>(
        "canister.query_self",
        method,
        args,
        timeout,
        boundInvocation,
      ),
    updateSelf: <T extends SelfCallValue = JsonValue>(
      method: string,
      args: SelfCallValue[] = [],
      timeout = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
    ) =>
      execSelfCall<T>(
        "canister.update_self",
        method,
        args,
        timeout,
        boundInvocation,
      ),
  };
}

function execWithTransportContext<T extends JsonValue = JsonValue>(
  action: string,
  payload: JsonValue,
  options: number | MsgBusCallOptions,
  context: MsgBusTransportContext,
): Promise<T> {
  if (kernelPort) {
    return execPeer<T>(kernelPort, action, payload, options, context);
  }
  return waitForKernelPort().then((port) =>
    execPeer<T>(port, action, payload, options, context)
  );
}

export function openAppTile(
  request: OpenAppTileRequest,
  timeout = 60
): Promise<OpenAppTileResult> {
  return callTool<OpenAppTileResult>(
    {
      target: "kernel",
      name: "workspace.open_tile",
      arguments: request,
    },
    timeout
  );
}

/**
 * Offers a package or repository setup URL for the owner to review.
 *
 * This only asks the Kernel to present the offer. The Kernel retains both the
 * initial owner consent prompt and the existing final installation approval.
 */
export function offerAppInstall(
  request: AppInstallOfferRequest,
  timeout = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS
): Promise<AppInstallOfferResult> {
  return callTool<AppInstallOfferResult>(
    {
      target: "kernel",
      name: "apps.install_offer",
      arguments: request,
    },
    timeout
  );
}

/**
 * Copies text through the trusted kernel page.
 *
 * Call this synchronously from a tile click handler, before any `await`. The
 * kernel rejects background, unfocused, and non-user-activated requests.
 */
export function copyToClipboard(text: string, timeout = 5): Promise<void> {
  if (typeof text !== "string") {
    return Promise.reject(new Error("Clipboard text must be a string"));
  }
  return exec<null>("clipboard.write_text", { text }, timeout).then(
    () => undefined,
  );
}

export type MediaSessionFeature = "camera" | "microphone";

export type OpenMediaSessionRequest = {
  features: MediaSessionFeature[];
  purpose: string;
  durationSeconds?: number;
};

export type OpenMediaSessionResult = {
  sessionId: string;
  expiresAt: string;
  features: MediaSessionFeature[];
};

export function openMediaSession(
  request: OpenMediaSessionRequest,
  timeout = 90,
): Promise<OpenMediaSessionResult> {
  return exec<OpenMediaSessionResult>(
    "media_sessions.open",
    {
      features: request.features,
      purpose: request.purpose,
      ...(request.durationSeconds === undefined
        ? {}
        : { durationSeconds: request.durationSeconds }),
    },
    timeout,
  );
}

export function closeMediaSession(
  sessionId: string,
  timeout = 15,
): Promise<void> {
  return exec<null>("media_sessions.close", { sessionId }, timeout).then(
    () => undefined,
  );
}

export const capabilities = Object.freeze({
  media_sessions: Object.freeze({
    open: openMediaSession,
    close: closeMediaSession,
  }),
});

export function publishAppStateChange(
  topic: string,
  revision: string | number,
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
): Promise<void> {
  assertAppStateTopic(topic);
  const normalizedRevision = normalizeAppStateRevision(revision);
  return exec(
    "app.state.publish",
    { topic, revision: normalizedRevision },
    timeout,
  ).then(() => undefined);
}

export function setTrayState(
  state: TrayState,
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
): Promise<void> {
  if (
    !isJsonObject(state) ||
    !Object.prototype.hasOwnProperty.call(state, "badge") ||
    Object.keys(state).length !== 1 ||
    (state.badge !== null &&
      (!Number.isSafeInteger(state.badge) ||
        state.badge < 0 ||
        state.badge > 9999))
  ) {
    return Promise.reject(new Error("Invalid tray badge"));
  }
  return exec<null>("tray.set_state", { badge: state.badge }, timeout).then(
    () => undefined,
  );
}

export function dismissTray(
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
): Promise<void> {
  return exec<null>("tray.dismiss", {}, timeout).then(() => undefined);
}

/**
 * Requests a trusted lifecycle decision for one slot declared by this app.
 * App identity is derived from the live message-bus endpoint and is therefore
 * intentionally absent from every request type.
 */
export async function requestVetKeys(
  request: VetKeysLifecycleRequest,
  timeout = 0,
): Promise<VetKeysLifecycleResult> {
  const payload = encodeVetKeysLifecycleRequest(request);
  const result = assertVetKeysLifecycleResult(
    await exec("vetkeys.request", payload, timeout),
  );
  if (
    (request.action === "retireSlot") !== result.retired ||
    (result.slot !== null && result.slot.slot !== request.slot)
  ) {
    throw new Error("Invalid vetKeys lifecycle response");
  }
  return result;
}

export async function listVetKeys(
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
): Promise<VetKeysListResult> {
  return assertVetKeysListResult(await exec("vetkeys.list", {}, timeout));
}

export async function getVetKeyPublicKey(
  request: { slot: string; generation: string | bigint },
  timeout = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
): Promise<VetKeyPublicInfo> {
  assertExactKeys(request, ["slot", "generation"], "vetKeys public-key request");
  const slot = normalizeVetKeySlot(request.slot);
  const generation = normalizeVetKeyGeneration(request.generation);
  const result = assertVetKeyPublicInfo(
    await exec(
      "vetkeys.publicKey",
      {
        slot,
        generation,
      },
      timeout,
    ),
  );
  if (result.slot !== slot || result.generation !== generation) {
    throw new Error("Invalid vetKeys public-key response");
  }
  return result;
}

/**
 * Begins a single-use derivation handshake. The returned promise remains
 * pending after `onChallenge`. That callback must immediately confirm the
 * challenge from this same originating endpoint with
 * `approveVetKeyDerivation()`. This is protocol plumbing, not user approval:
 * it requires no focus, transient activation, or extra consent. Only this
 * originating endpoint receives the final response.
 */
export async function deriveVetKey(
  request: VetKeyDeriveRequest,
  options: VetKeyDeriveOptions,
): Promise<VetKeyDeriveResult> {
  assertExactKeys(
    request,
    ["slot", "generation", "transportPublicKey", "requestNonce"],
    "vetKeys derive request",
  );
  if (!options || typeof options.onChallenge !== "function") {
    throw new Error("vetKeys derivation requires an onChallenge handler");
  }
  const slot = normalizeVetKeySlot(request.slot);
  const generation = normalizeVetKeyGeneration(request.generation);
  let challengeCount = 0;
  let challengeError: Error | null = null;
  const result = await exec(
    "vetkeys.derive.begin",
    {
      slot,
      generation,
      transportPublicKey: normalizeVetKeyBytes(
        request.transportPublicKey,
        48,
        "transport public key",
      ),
      requestNonce: normalizeVetKeyBytes(
        request.requestNonce,
        32,
        "request nonce",
      ),
    },
    {
      timeout: options.timeout ?? 90,
      onProgress(value) {
        try {
          challengeCount += 1;
          if (challengeCount !== 1) {
            throw new Error("Invalid vetKeys derive challenge sequence");
          }
          options.onChallenge(assertVetKeyDeriveChallenge(value));
        } catch (error) {
          challengeError =
            error instanceof Error
              ? error
              : new Error("Invalid vetKeys derive challenge");
        }
      },
    },
  );
  if (challengeError) throw challengeError;
  if (challengeCount !== 1) {
    throw new Error("Invalid vetKeys derive challenge sequence");
  }
  const normalized = assertVetKeyDeriveResult(result);
  if (
    normalized.publicInfo.slot !== slot ||
    normalized.publicInfo.generation !== generation
  ) {
    throw new Error("Invalid vetKeys derive response");
  }
  return normalized;
}

/**
 * Confirm this exact originating endpoint's own derivation challenge. Call
 * from `deriveVetKey()`'s `onChallenge`; no focus or user activation is needed.
 */
export async function approveVetKeyDerivation(
  request: { challengeId: string },
  timeout = 10,
): Promise<void> {
  assertExactKeys(request, ["challengeId"], "vetKeys approval request");
  const challengeId = normalizeVetKeyChallengeId(request.challengeId);
  const result = await exec("vetkeys.derive.approve", { challengeId }, timeout);
  if (
    !isJsonObject(result) ||
    Object.keys(result).length !== 1 ||
    result.approved !== true
  ) {
    throw new Error("Invalid vetKeys approval response");
  }
}

function encodeVetKeysLifecycleRequest(
  request: VetKeysLifecycleRequest,
): JsonObject {
  if (!isJsonObject(request)) {
    throw new Error("Invalid vetKeys lifecycle request");
  }
  const slot = normalizeVetKeySlot(request.slot);
  switch (request.action) {
    case "reserve":
    case "enable":
    case "disable":
    case "rotate":
    case "retireSlot":
      assertExactKeys(request, ["action", "slot"], "vetKeys lifecycle request");
      return { action: request.action, slot };
    case "retireGeneration":
      assertExactKeys(
        request,
        ["action", "slot", "generation"],
        "vetKeys lifecycle request",
      );
      return {
        action: request.action,
        slot,
        generation: normalizeVetKeyGeneration(request.generation),
      };
    case "transfer":
      assertExactKeys(
        request,
        ["action", "slot", "newHolder"],
        "vetKeys lifecycle request",
      );
      return {
        action: request.action,
        slot,
        newHolder: normalizeVetKeyPrincipal(request.newHolder, "new holder"),
      };
    default:
      throw new Error("Invalid vetKeys lifecycle action");
  }
}

function normalizeVetKeySlot(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9_]{0,39}$/u.test(value)
  ) {
    throw new Error("Invalid vetKeys slot");
  }
  return value;
}

function normalizeVetKeyGeneration(value: unknown): string {
  const text = typeof value === "bigint" ? value.toString() : value;
  if (
    typeof text !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/u.test(text)
  ) {
    throw new Error("Invalid vetKeys generation");
  }
  const generation = BigInt(text);
  if (generation < 1n || generation > 18_446_744_073_709_551_615n) {
    throw new Error("Invalid vetKeys generation");
  }
  return text;
}

function normalizeVetKeyBytes(
  value: unknown,
  length: number,
  label: string,
): number[] {
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  const bytes = Array.from(value as ArrayLike<unknown>);
  if (
    bytes.length !== length ||
    bytes.some(
      (byte) =>
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255,
    )
  ) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  return bytes as number[];
}

function normalizeVetKeyPrincipal(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 80) {
    throw new Error(`Invalid vetKeys ${label}`);
  }
  try {
    const principal = Principal.fromText(value);
    if (principal.isAnonymous()) throw new Error("anonymous");
    return principal.toText();
  } catch {
    throw new Error(`Invalid vetKeys ${label}`);
  }
}

function normalizeVetKeyChallengeId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 128 ||
    !/^[a-zA-Z0-9_-]+$/u.test(value)
  ) {
    throw new Error("Invalid vetKeys challenge id");
  }
  return value;
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function isCanonicalNat(value: unknown, maximumDigits = 128): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumDigits &&
    /^(0|[1-9][0-9]*)$/u.test(value)
  );
}

function isVetKeyGeneration(value: unknown): value is string {
  if (!isCanonicalNat(value, 20)) return false;
  const generation = BigInt(value);
  return generation >= 1n && generation <= 18_446_744_073_709_551_615n;
}

function isVetKeyTime(value: unknown): value is string {
  return (
    isCanonicalNat(value, 20) &&
    BigInt(value) <= 18_446_744_073_709_551_615n
  );
}

function isVetKeyPrincipal(value: unknown): value is string {
  try {
    return (
      typeof value === "string" &&
      value.length <= 80 &&
      !Principal.fromText(value).isAnonymous()
    );
  } catch {
    return false;
  }
}

function isVetKeyByteArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(
      (byte) =>
        typeof byte === "number" &&
        Number.isInteger(byte) &&
        byte >= 0 &&
        byte <= 255,
    )
  );
}

function isVetKeySlotSummary(value: unknown): value is VetKeySlotSummary {
  if (!isJsonObject(value)) return false;
  const expected = [
    "slot",
    "purpose",
    "keyHolder",
    "status",
    "environment",
    "currentGeneration",
    "previousGeneration",
    "generations",
    "createdAt",
    "updatedAt",
    "lastUsedAt",
    "totalDerivations",
    "approximateCycleSpend",
  ];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    return false;
  }
  if (
    typeof value.slot !== "string" ||
    !/^[a-z][a-z0-9_]{0,39}$/u.test(value.slot) ||
    typeof value.purpose !== "string" ||
    Array.from(value.purpose).length < 1 ||
    Array.from(value.purpose).length > 280 ||
    !isVetKeyPrincipal(value.keyHolder) ||
    !["enabled", "disabled", "manifest_suspended"].includes(
      String(value.status),
    ) ||
    (value.environment !== "production" && value.environment !== "local") ||
    !isVetKeyGeneration(value.currentGeneration) ||
    (value.previousGeneration !== null &&
      !isVetKeyGeneration(value.previousGeneration)) ||
    !Array.isArray(value.generations) ||
    value.generations.length < 1 ||
    value.generations.length > 2 ||
    !isVetKeyTime(value.createdAt) ||
    !isVetKeyTime(value.updatedAt) ||
    (value.lastUsedAt !== null && !isVetKeyTime(value.lastUsedAt)) ||
    !isCanonicalNat(value.totalDerivations) ||
    !isCanonicalNat(value.approximateCycleSpend)
  ) {
    return false;
  }
  try {
    if (
      normalizeUntrustedText(value.purpose, "vetKeys purpose", {
        maximumLength: 280,
      }) !== value.purpose
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const requiredKeyName =
    value.environment === "production" ? "key_1" : "test_key_1";
  const generationsValid = value.generations.every((generation) => {
    if (!isJsonObject(generation)) return false;
    return (
      Object.keys(generation).length === 4 &&
      isVetKeyGeneration(generation.generation) &&
      (generation.status === "current" || generation.status === "previous") &&
      generation.keyName === requiredKeyName &&
      (generation.publicFingerprint === null ||
        isVetKeyByteArray(generation.publicFingerprint, 32))
    );
  });
  if (!generationsValid) return false;
  const generationIds = new Set(
    value.generations.map((generation) => String(generation.generation)),
  );
  const current = value.generations.filter(
    (generation) => generation.status === "current",
  );
  const previous = value.generations.filter(
    (generation) => generation.status === "previous",
  );
  return (
    generationIds.size === value.generations.length &&
    current.length === 1 &&
    current[0]?.generation === value.currentGeneration &&
    (value.previousGeneration === null
      ? previous.length === 0
      : previous.length === 1 &&
        previous[0]?.generation === value.previousGeneration)
  );
}

function assertVetKeysLifecycleResult(value: unknown): VetKeysLifecycleResult {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.retired !== "boolean" ||
    (value.slot !== null && !isVetKeySlotSummary(value.slot)) ||
    (value.retired !== (value.slot === null))
  ) {
    throw new Error("Invalid vetKeys lifecycle response");
  }
  return value as VetKeysLifecycleResult;
}

function assertVetKeysListResult(value: unknown): VetKeysListResult {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.slots) ||
    value.slots.length > 4 ||
    !value.slots.every(isVetKeySlotSummary)
  ) {
    throw new Error("Invalid vetKeys list response");
  }
  const slotIds = new Set(value.slots.map((slot) => slot.slot));
  if (slotIds.size !== value.slots.length) {
    throw new Error("Invalid vetKeys list response");
  }
  return value as VetKeysListResult;
}

function assertVetKeyPublicInfo(value: unknown): VetKeyPublicInfo {
  if (!isJsonObject(value)) throw new Error("Invalid vetKeys public-key response");
  const expected = [
    "canisterPrincipal",
    "slot",
    "generation",
    "suite",
    "keyName",
    "publicKey",
    "publicFingerprint",
    "derivationInput",
  ];
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    !isVetKeyPrincipal(value.canisterPrincipal) ||
    typeof value.slot !== "string" ||
    !/^[a-z][a-z0-9_]{0,39}$/u.test(value.slot) ||
    !isVetKeyGeneration(value.generation) ||
    value.suite !== "bls12_381_g2" ||
    (value.keyName !== "key_1" && value.keyName !== "test_key_1") ||
    !isVetKeyByteArray(value.publicKey, 96) ||
    !isVetKeyByteArray(value.publicFingerprint, 32) ||
    !isVetKeyByteArray(value.derivationInput, 32)
  ) {
    throw new Error("Invalid vetKeys public-key response");
  }
  return value as VetKeyPublicInfo;
}

function assertVetKeyDeriveChallenge(value: unknown): VetKeyDeriveChallenge {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 3 ||
    value.type !== "challenge" ||
    !isVetKeyTime(value.expiresAt)
  ) {
    throw new Error("Invalid vetKeys derive challenge");
  }
  normalizeVetKeyChallengeId(value.challengeId);
  return value as VetKeyDeriveChallenge;
}

function assertVetKeyDeriveResult(value: unknown): VetKeyDeriveResult {
  if (
    !isJsonObject(value) ||
    Object.keys(value).length !== 2 ||
    !isVetKeyByteArray(value.encryptedKey, 192)
  ) {
    throw new Error("Invalid vetKeys derive response");
  }
  return {
    encryptedKey: value.encryptedKey,
    publicInfo: assertVetKeyPublicInfo(value.publicInfo),
  };
}

export function onAppStateChange(
  topic: string,
  listener: AppStateChangeListener,
): () => void {
  assertAppStateTopic(topic);
  if (typeof listener !== "function") {
    throw new Error("App state listener must be a function");
  }
  installMessageListener(getWindow());
  const listeners = appStateListeners.get(topic) ?? new Set();
  listeners.add(listener);
  appStateListeners.set(topic, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) appStateListeners.delete(topic);
  };
}

function assertAppStateTopic(topic: string): void {
  if (!isAppStateTopic(topic)) {
    throw new Error("Invalid app state topic");
  }
}

function isAppStateTopic(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-z][a-z0-9_.-]{0,63}$/u.test(value)
  );
}

function normalizeAppStateRevision(revision: string | number): string {
  const value = typeof revision === "number" ? String(revision) : revision;
  if (
    typeof revision === "number" &&
    (!Number.isSafeInteger(revision) || revision < 0)
  ) {
    throw new Error("Invalid app state revision");
  }
  if (!isAppStateRevision(value)) {
    throw new Error("Invalid app state revision");
  }
  return value;
}

function isAppStateRevision(value: unknown): value is string {
  return (
    typeof value === "string" && /^(0|[1-9][0-9]{0,127})$/u.test(value)
  );
}

export function requestAgentMode(
  entrypoint: string,
  timeout = 0,
): Promise<AgentModeStatus> {
  assertToolName(entrypoint);
  return exec<AgentModeStatus>(
    "agent.mode.request",
    { entrypoint },
    timeout,
  );
}

export function getAgentModeStatus(
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
): Promise<AgentModeStatus> {
  return exec<AgentModeStatus>("agent.mode.status", {}, timeout);
}

export function disableAgentMode(
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
): Promise<AgentModeStatus> {
  return exec<AgentModeStatus>("agent.mode.disable", {}, timeout);
}

export function onTileViewRequest(listener: (view: string) => void): () => void {
  tileViewListeners.add(listener);
  if (pendingTileViews.length > 0) {
    const queued = pendingTileViews.splice(0);
    queueMicrotask(() => {
      if (!tileViewListeners.has(listener)) return;
      for (const view of queued) listener(view);
    });
  }
  return () => tileViewListeners.delete(listener);
}

export function requestMethodSchema(
  payload: KernelSchemaPayload,
  timeout = 0
): Promise<JsonValue> {
  return callTool(
    {
      target: "kernel",
      name: "canister.schema",
      arguments: payload,
    },
    timeout
  );
}

export function callCanisterDialog<T extends SelfCallValue = JsonValue>(
  payload: KernelCallPayload,
  timeout = 0
): Promise<T> {
  const currentHref = currentWindowHref();
  const currentCanister = currentHref
    ? canisterIdFromUrl(currentHref, false)
    : false;
  if (currentCanister === payload.canister) {
    return callSelfDialog<T>(payload.method, payload.args ?? [], timeout);
  }
  const args = payload.args ?? [];
  if (!isJsonValue(args)) {
    throw new Error(
      "Binary values are supported only for calls to this Neutron"
    );
  }
  return callTool(
    {
      target: "kernel",
      name: "canister.call_dialog",
      arguments: {
        canister: payload.canister,
        method: payload.method,
        args,
      },
    },
    timeout
  ) as Promise<T>;
}

export function callSelfDialog<T extends SelfCallValue = JsonValue>(
  method: string,
  args: SelfCallValue[] = [],
  timeout = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS
): Promise<T> {
  return execSelfCall<T>("canister.call_dialog", method, args, timeout);
}

export function querySelf<T extends SelfCallValue = JsonValue>(
  method: string,
  args: SelfCallValue[] = [],
  timeout = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS
): Promise<T> {
  return execSelfCall<T>("canister.query_self", method, args, timeout);
}

export function updateSelf<T extends SelfCallValue = JsonValue>(
  method: string,
  args: SelfCallValue[] = [],
  timeout = MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS
): Promise<T> {
  return execSelfCall<T>("canister.update_self", method, args, timeout);
}

async function execSelfCall<T extends SelfCallValue>(
  tool:
    | "canister.query_self"
    | "canister.update_self"
    | "canister.call_dialog"
    | "backend_calls.request",
  method: string,
  args: SelfCallValue[],
  timeout: number,
  invocation?: MsgBusInvocationMetadata,
  actions?: BackendCallReservationAction[],
): Promise<T> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/u.test(method)) {
    throw new Error("Invalid self-call method");
  }
  if (!Array.isArray(args)) throw new Error("Self-call arguments must be an array");
  if (
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    timeout > MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS
  ) {
    throw new Error("Invalid self-call timeout");
  }

  const encoded = encodeSelfCallValues(args);
  const currentWindow = getWindow();
  installMessageListener(currentWindow);
  const port = kernelPort ?? (await waitForKernelPort());
  const id = ++nextId;
  const envelope: SelfCallExecEnvelope =
    tool === "backend_calls.request"
      ? {
          type: "neutron:self-call:exec",
          version: 1,
          id,
          tool,
          method,
          args: encoded.value as JsonValue[],
          blobs: encoded.blobs,
          actions: actions ?? [],
          ...(invocation ? { context: { invocation } } : {}),
        }
      : {
          type: "neutron:self-call:exec",
          version: 1,
          id,
          tool,
          method,
          args: encoded.value as JsonValue[],
          blobs: encoded.blobs,
          ...(invocation ? { context: { invocation } } : {}),
        };

  return new Promise<T>((resolve, reject) => {
    const timeoutHandle = timeout
      ? setTimeout(() => {
          selfCallCallbacks.delete(id);
          reject(new Error(`Timeout after ${timeout} seconds`));
        }, timeout * 1_000)
      : undefined;
    selfCallCallbacks.set(id, {
      resolve: resolve as (value: SelfCallValue) => void,
      reject,
      source: port,
      ...(timeoutHandle ? { timeout: timeoutHandle } : {}),
    });
    try {
      port.postMessage(
        envelope,
        encoded.blobs.map((blob) => blob.data),
      );
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      selfCallCallbacks.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function encodeSelfCallValues(
  value: SelfCallValue,
): { value: JsonValue; blobs: SelfCallWireBlob[] };
export function encodeSelfCallValues(
  value: SelfCallValue[],
): { value: JsonValue[]; blobs: SelfCallWireBlob[] };
export function encodeSelfCallValues(
  value: SelfCallValue | SelfCallValue[],
): { value: JsonValue | JsonValue[]; blobs: SelfCallWireBlob[] } {
  const blobs: SelfCallWireBlob[] = [];
  const active = new WeakSet<object>();
  let elements = 0;
  let binaryBytes = 0;

  const visit = (
    candidate: SelfCallValue,
    path: SelfCallBlobPathSegment[],
    depth: number,
  ): JsonValue => {
    if (depth > SELF_CALL_VALUE_MAX_DEPTH) {
      throw new Error("Self-call value exceeds the nesting depth limit");
    }
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error("Self-call numbers must be finite");
      }
      return candidate;
    }
    if (candidate instanceof Uint8Array || candidate instanceof ArrayBuffer) {
      if (blobs.length >= SELF_CALL_BINARY_MAX_COUNT) {
        throw new Error("Self-call value exceeds the binary field count limit");
      }
      const source =
        candidate instanceof Uint8Array
          ? candidate
          : new Uint8Array(candidate);
      const snapshot = Uint8Array.from(source);
      binaryBytes += snapshot.byteLength;
      if (binaryBytes > SELF_CALL_BINARY_MAX_BYTES) {
        throw new Error("Self-call value exceeds the aggregate binary byte limit");
      }
      const data = snapshot.buffer as ArrayBuffer;
      blobs.push({
        path: [...path],
        byteLength: data.byteLength,
        data,
      });
      // A Candid blob can never be null. The live-Candid walker replaces this
      // private placeholder only after it proves the path is `vec nat8`.
      return null;
    }
    if (typeof candidate !== "object") {
      throw new Error("Self-call value is not supported");
    }
    if (active.has(candidate)) {
      throw new Error("Self-call value contains a cycle");
    }
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (!isDenseDataArray(candidate)) {
          throw new Error(
            "Self-call arrays require dense enumerable data properties",
          );
        }
        elements += candidate.length;
        if (elements > SELF_CALL_VALUE_MAX_CONTAINER_ELEMENTS) {
          throw new Error("Self-call value exceeds the container element limit");
        }
        return Array.from({ length: candidate.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            candidate,
            String(index),
          )!;
          return visit(
            descriptor.value as SelfCallValue,
            [...path, index],
            depth + 1,
          );
        });
      }
      if (!isJsonObject(candidate)) {
        throw new Error("Self-call records must be plain objects");
      }
      const keys = Reflect.ownKeys(candidate);
      if (keys.some((key) => typeof key !== "string")) {
        throw new Error("Self-call records cannot contain symbol keys");
      }
      elements += keys.length;
      if (elements > SELF_CALL_VALUE_MAX_CONTAINER_ELEMENTS) {
        throw new Error("Self-call value exceeds the container element limit");
      }
      const output: Array<[string, JsonValue]> = [];
      for (const key of keys as string[]) {
        if (key.length === 0 || key.length > 256) {
          throw new Error("Self-call record field name is invalid");
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new Error(
            "Self-call records require enumerable data properties",
          );
        }
        output.push([
          key,
          visit(
            descriptor.value as SelfCallValue,
            [...path, key],
            depth + 1,
          ),
        ]);
      }
      return Object.fromEntries(output);
    } finally {
      active.delete(candidate);
    }
  };

  const encoded = visit(value, [], 0);
  assertBoundedJson(
    encoded,
    "Self-call metadata",
    SELF_CALL_METADATA_MAX_BYTES,
  );
  return {
    value: encoded,
    blobs,
  };
}

function handleSelfCallResponseMessage(
  raw: Record<string, unknown>,
  source: MessagePort,
): void {
  if (!isMessageId(raw.id)) return;
  const callback = selfCallCallbacks.get(raw.id);
  if (!callback || callback.source !== source) return;
  if (callback.timeout) clearTimeout(callback.timeout);
  selfCallCallbacks.delete(raw.id);

  try {
    if (
      !hasExactSelfCallResponseKeys(raw) ||
      raw.type !== "neutron:self-call:response" ||
      raw.version !== 1 ||
      (Object.hasOwn(raw, "ok") === Object.hasOwn(raw, "error"))
    ) {
      throw new Error("Invalid self-call response envelope");
    }
    if (Object.hasOwn(raw, "error")) {
      if (!isJsonValue(raw.error) || raw.blobs !== undefined) {
        throw new Error("Invalid self-call error response");
      }
      callback.reject(toError(raw.error));
      return;
    }
    if (!isJsonValue(raw.ok)) {
      throw new Error("Invalid self-call response metadata");
    }
    const blobs = parseSelfCallWireBlobs(raw.blobs ?? []);
    const decoded = decodeSelfCallValue(raw.ok, blobs);
    callback.resolve(decoded);
  } catch (error) {
    callback.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export function parseSelfCallWireBlobs(value: unknown): SelfCallWireBlob[] {
  if (
    !isDenseDataArray(value) ||
    value.length > SELF_CALL_BINARY_MAX_COUNT
  ) {
    throw new Error("Invalid self-call binary field list");
  }
  let aggregateBytes = 0;
  const paths = new Set<string>();
  return value.map((candidate) => {
    if (
      !isJsonObject(candidate) ||
      !hasExactEnumerableDataKeys(candidate, ["path", "byteLength", "data"]) ||
      !isDenseDataArray(candidate.path) ||
      candidate.path.length > SELF_CALL_VALUE_MAX_DEPTH ||
      !candidate.path.every(
        (part) =>
          (typeof part === "string" &&
            part.length > 0 &&
            part.length <= 256) ||
          (typeof part === "number" &&
            Number.isSafeInteger(part) &&
            part >= 0 &&
            part < SELF_CALL_VALUE_MAX_CONTAINER_ELEMENTS),
      ) ||
      !Number.isSafeInteger(candidate.byteLength) ||
      Number(candidate.byteLength) < 0 ||
      !(candidate.data instanceof ArrayBuffer) ||
      candidate.data.byteLength !== candidate.byteLength
    ) {
      throw new Error("Invalid self-call binary field");
    }
    aggregateBytes += Number(candidate.byteLength);
    if (aggregateBytes > SELF_CALL_BINARY_MAX_BYTES) {
      throw new Error("Self-call value exceeds the aggregate binary byte limit");
    }
    const pathKey = JSON.stringify(candidate.path);
    if (paths.has(pathKey)) {
      throw new Error("Self-call binary field paths must be unique");
    }
    paths.add(pathKey);
    return candidate as SelfCallWireBlob;
  });
}

function isDenseDataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      return false;
    }
  }
  return true;
}

function hasExactEnumerableDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every(
      (key) => typeof key === "string" && expected.includes(key),
    ) &&
    expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        "value" in descriptor
      );
    })
  );
}

function hasExactSelfCallResponseKeys(
  value: Record<string, unknown>,
): boolean {
  const expected = Object.hasOwn(value, "error")
    ? ["type", "version", "id", "error"]
    : ["type", "version", "id", "ok", "blobs"];
  return hasExactEnumerableDataKeys(value, expected);
}

export function decodeSelfCallValue(
  value: JsonValue,
  blobs: readonly SelfCallWireBlob[],
): SelfCallValue {
  const byPath = new Map(
    blobs.map((blob) => [JSON.stringify(blob.path), blob] as const),
  );
  const used = new Set<string>();
  let elements = 0;

  const visit = (
    candidate: JsonValue,
    path: SelfCallBlobPathSegment[],
    depth: number,
  ): SelfCallValue => {
    if (depth > SELF_CALL_VALUE_MAX_DEPTH) {
      throw new Error("Self-call response exceeds the nesting depth limit");
    }
    const pathKey = JSON.stringify(path);
    const blob = byPath.get(pathKey);
    if (blob) {
      if (candidate !== null) {
        throw new Error("Self-call binary placeholder is invalid");
      }
      used.add(pathKey);
      return new Uint8Array(blob.data);
    }
    if (Array.isArray(candidate)) {
      elements += candidate.length;
      if (elements > SELF_CALL_VALUE_MAX_CONTAINER_ELEMENTS) {
        throw new Error("Self-call response exceeds the container element limit");
      }
      return candidate.map((entry, index) =>
        visit(entry, [...path, index], depth + 1),
      );
    }
    if (isJsonObject(candidate)) {
      const entries = Object.entries(candidate);
      elements += entries.length;
      if (elements > SELF_CALL_VALUE_MAX_CONTAINER_ELEMENTS) {
        throw new Error("Self-call response exceeds the container element limit");
      }
      return Object.fromEntries(
        entries.map(([key, entry]) => [
          key,
          visit(entry as JsonValue, [...path, key], depth + 1),
        ]),
      );
    }
    return candidate;
  };

  const decoded = visit(value, [], 0);
  if (used.size !== blobs.length) {
    throw new Error("Self-call response contains an unbound binary field");
  }
  return decoded;
}

export function requestBackendCallReservations<
  T extends SelfCallValue = JsonValue,
>(request: BackendCallReservationsRequest): Promise<T> {
  if (request.call) {
    return execSelfCall<T>(
      "backend_calls.request",
      request.call.method,
      request.call.args ?? [],
      0,
      undefined,
      request.actions,
    );
  }
  return callTool<JsonValue>(
    {
      target: "kernel",
      name: "backend_calls.request",
      arguments: { actions: request.actions },
    },
    0
  ) as Promise<T>;
}

export function listBackendCallReservations(
  timeout = MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS
): Promise<JsonValue> {
  return callTool(
    {
      target: "kernel",
      name: "backend_calls.list",
      arguments: {},
    },
    timeout
  );
}

export async function connectEthereumProvider(
  timeout = 30,
): Promise<EthereumProviderConnection> {
  const opened = await exec("ethereum_provider.begin", {}, timeout);
  if (
    !isJsonObject(opened) ||
    typeof opened.sessionId !== "string" ||
    !/^[a-f0-9]{32}$/.test(opened.sessionId) ||
    !isJsonObject(opened.provider) ||
    typeof opened.provider.name !== "string" ||
    opened.provider.name.length < 1 ||
    opened.provider.name.length > 80 ||
    (opened.provider.rdns !== null &&
      typeof opened.provider.rdns !== "string")
  ) {
    throw new Error("Invalid Ethereum provider session");
  }
  const sessionId = opened.sessionId;
  const info = {
    name: opened.provider.name,
    rdns: opened.provider.rdns,
  };
  let closed = false;
  return {
    info,
    provider: {
      request: async ({ method, params }: EthereumProviderRequestArguments) => {
        if (closed) throw new Error("Ethereum provider session is closed");
        if (typeof method !== "string" || method.length > 80) {
          throw new Error("Invalid Ethereum provider method");
        }
        if (params !== undefined) {
          assertBoundedJson(params, "Ethereum provider parameters");
        }
        return exec(
          "ethereum_provider.request",
          {
            sessionId,
            method,
            ...(params === undefined ? {} : { params }),
          },
          MSG_BUS_DEFAULT_CALL_TIMEOUT_SECONDS,
        );
      },
    },
    async close() {
      if (closed) return;
      closed = true;
      await exec(
        "ethereum_provider.end",
        { sessionId },
        MSG_BUS_DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
      );
    },
  };
}

export function assertCanisterId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !canisterIdPattern.test(value)
  ) {
    throw new Error("Invalid canister id");
  }
  return value;
}

export function assertMethodSchema(value: JsonValue): MethodSchemaJson {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.input) ||
    !isJsonObject(value.output)
  ) {
    throw new Error("Invalid method schema");
  }
  return value as MethodSchemaJson;
}

export async function loadNeutronCanisterId(
  path = "/pkg/id.json",
  fetcher: JsonFetcher = fetch,
  href = currentWindowHref()
): Promise<string> {
  if (href) {
    const fromUrl = canisterIdFromUrl(href);
    if (fromUrl) return assertCanisterId(fromUrl);
  }

  const response = await fetcher(path);
  if (!response.ok) {
    throw new Error(
      `Failed to load Neutron canister id: HTTP ${response.status}`
    );
  }

  const body: unknown = await response.json();
  if (!isRecord(body) || !Object.hasOwn(body, "id")) {
    throw new Error("Invalid Neutron canister id response");
  }

  return assertCanisterId(body.id);
}

function currentWindowHref(): string | null {
  if (typeof window === "undefined" || !window.location?.href) return null;
  return window.location.href;
}

export type TileContext = {
  app: string | null;
  tile: string | null;
  instance: string | null;
  workspace: number | null;
};

export function loadTileContext(href = getWindow().location.href): TileContext {
  const url = new URL(href);
  const workspace = Number(url.searchParams.get("workspace"));
  return {
    app: url.searchParams.get("app"),
    tile: url.searchParams.get("tile"),
    instance: url.searchParams.get("instance"),
    workspace:
      Number.isInteger(workspace) && workspace >= 1 && workspace <= 20
        ? workspace
        : null,
  };
}

export function createCanisterClient(canister: string): NeutronCanisterClient {
  const checkedCanister = assertCanisterId(canister);

  return {
    canister: checkedCanister,
    async methodSchema(method, timeout = 0) {
      const schema = await requestMethodSchema(
        { canister: checkedCanister, method },
        timeout
      );
      return assertMethodSchema(schema);
    },
    callDialog(method, args: JsonValue[] = [], timeout = 0) {
      return callCanisterDialog(
        { canister: checkedCanister, method, args },
        timeout
      );
    },
  };
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  installMessageListener(window);
  globalThis.queueMicrotask(() => announceFrameReady());
}
