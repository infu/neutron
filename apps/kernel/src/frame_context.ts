import type { AppScope } from "./app_scope.ts";
import {
  assertResidentFrameSecurityBinding,
  ResidentFrameSecurityMode,
  type ResidentFrameSecurityBinding,
} from "./capabilities/plan.ts";
import {
  isMsgBusFrameReady,
  MSG_BUS_FRAME_PROBE,
} from "neutron-tools/src/frame_handshake.js";
import { retireExecPort } from "neutron-tools/src/kernel.js";
import { requestCancellationError } from "./request_cancel.ts";

export type TileFrameContext = {
  role: "tile";
  appId: string;
  tileId: string;
  instanceId: string;
  workspace: number;
};

export type BackgroundFrameContext = {
  role: "background";
  appId: string;
};

export type TrayFrameContext = {
  role: "tray";
  appId: string;
  instanceId: string;
};

export type FrameContext =
  TileFrameContext | BackgroundFrameContext | TrayFrameContext;

export type RegisteredEndpoint = {
  endpointId: string;
  source: Window;
  context: FrameContext;
  appVersion?: number;
  appGeneration?: number;
  appScope?: AppScope;
  origin?: string;
  isAuthorityCurrent?: () => boolean;
  port?: MessagePort;
  sessionId?: string;
};

export type EndpointPortMessage = {
  endpoint: RegisteredEndpoint;
  event: MessageEvent;
};

type EndpointPortListener = (message: EndpointPortMessage) => void;
type EndpointPortRetirementListener = (port: MessagePort) => void;
type EndpointChangeListener = () => void;

const frames = new WeakMap<object, RegisteredEndpoint>();
const endpoints = new Map<string, RegisteredEndpoint>();
const portListeners = new Set<EndpointPortListener>();
const portRetirementListeners = new Set<EndpointPortRetirementListener>();
const changeListeners = new Set<EndpointChangeListener>();
const handshakeWindows = new WeakSet<object>();
const loadedFrames = new WeakSet<object>();

export function endpointIdForContext(context: FrameContext): string {
  if (context.role === "background") {
    return `app:${context.appId}:background`;
  }
  if (context.role === "tray") {
    return `app:${context.appId}:tray:instance:${context.instanceId}`;
  }
  return `app:${context.appId}:tile:${context.tileId}:instance:${context.instanceId}`;
}

export function registerFrameContext(
  source: Window | null,
  context: FrameContext,
  options: {
    appVersion?: number;
    appGeneration?: number;
    appScope?: AppScope;
    origin?: string;
    residentSecurityBinding?: ResidentFrameSecurityBinding;
    isAuthorityCurrent?: () => boolean;
  } = {},
): () => void {
  if (!source || typeof source !== "object") return () => {};
  if (options.residentSecurityBinding) {
    if (context.role !== "background") {
      throw new Error(
        "Resident frame security can bind only a background endpoint",
      );
    }
    assertResidentFrameSecurityBinding(options.residentSecurityBinding);
    const dedicated =
      options.residentSecurityBinding.mode !==
      ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1;
    if (
      dedicated
        ? !options.origin || options.origin === "null"
        : options.origin !== "null"
    ) {
      throw new Error(
        "Resident frame origin does not match its security binding",
      );
    }
  }
  const endpoint: RegisteredEndpoint = {
    endpointId: endpointIdForContext(context),
    source,
    context,
    ...(options.appVersion !== undefined
      ? { appVersion: options.appVersion }
      : {}),
    ...(options.appGeneration !== undefined
      ? { appGeneration: options.appGeneration }
      : {}),
    ...(options.appScope ? { appScope: options.appScope } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.isAuthorityCurrent
      ? { isAuthorityCurrent: options.isAuthorityCurrent }
      : {}),
  };
  if (!endpointAuthorityCurrent(endpoint)) {
    throw new Error("App frame authority is no longer current");
  }
  const previousSourceEndpoint = frames.get(source);
  const previousIdEndpoint = endpoints.get(endpoint.endpointId);
  const retiredEndpoints = new Set(
    [previousSourceEndpoint, previousIdEndpoint].filter(
      (candidate): candidate is RegisteredEndpoint => candidate !== undefined,
    ),
  );
  for (const retired of retiredEndpoints) {
    detachEndpointRegistration(retired);
    disconnectEndpointPort(retired, false);
  }
  frames.set(source, endpoint);
  endpoints.set(endpoint.endpointId, endpoint);
  notifyEndpointChange();
  requestFrameEndpointConnection(endpoint);
  return () => {
    const detached = detachEndpointRegistration(endpoint);
    disconnectEndpointPort(endpoint, false);
    if (detached) notifyEndpointChange();
  };
}

export function waitForFrameEndpointPort(
  endpoint: RegisteredEndpoint,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<MessagePort> {
  if (signal?.aborted) {
    return Promise.reject(
      requestCancellationError(signal, "Endpoint connection was cancelled"),
    );
  }
  if (!endpointRegistered(endpoint) || !endpointAuthorityCurrent(endpoint)) {
    return Promise.reject(
      new Error(
        `Endpoint '${endpoint.endpointId}' authority is no longer current`,
      ),
    );
  }
  if (endpoint.port) return Promise.resolve(endpoint.port);
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (result: { port: MessagePort } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      if ("port" in result) resolve(result.port);
      else reject(result.error);
    };
    const timeout = globalThis.setTimeout(
      () =>
        finish({
          error: new Error(
            `Endpoint '${endpoint.endpointId}' did not connect after ${timeoutSeconds} seconds`,
          ),
        }),
      timeoutSeconds * 1_000,
    );
    const abort = (): void =>
      finish({
        error: requestCancellationError(
          signal,
          "Endpoint connection was cancelled",
        ),
      });
    signal?.addEventListener("abort", abort, { once: true });
    const check = (): void => {
      const current = endpoints.get(endpoint.endpointId);
      if (current !== endpoint) {
        finish({
          error: new Error(
            `Endpoint '${endpoint.endpointId}' was replaced before connecting`,
          ),
        });
      } else if (!endpointAuthorityCurrent(endpoint)) {
        finish({
          error: new Error(
            `Endpoint '${endpoint.endpointId}' authority changed before connecting`,
          ),
        });
      } else if (endpoint.port) {
        finish({ port: endpoint.port });
      }
    };
    unsubscribe = subscribeEndpointChanges(check);
    if (signal?.aborted) abort();
    check();
  });
}

export function connectFrameEndpoint(
  source: Window | null,
  authenticatedFrameReady = false,
): boolean {
  if (!source) return false;
  const endpoint = frames.get(source);
  if (
    !endpoint ||
    typeof MessageChannel === "undefined" ||
    typeof endpoint.source.postMessage !== "function"
  ) {
    return false;
  }
  if (endpoint.context.role === "background" && !authenticatedFrameReady) {
    return false;
  }
  if (!endpointAuthorityCurrent(endpoint)) {
    disconnectEndpointPort(endpoint);
    return false;
  }
  if (hasKnownDifferentOrigin(source, endpoint.origin)) return false;

  disconnectEndpointPort(endpoint, false);
  const channel = new MessageChannel();
  const sessionId = createSessionId();
  endpoint.port = channel.port1;
  endpoint.sessionId = sessionId;
  channel.port1.addEventListener("message", (event) => {
    if (endpoint.port !== channel.port1 || endpoint.sessionId !== sessionId) {
      return;
    }
    if (!endpointRegistered(endpoint)) {
      disconnectEndpointPort(endpoint);
      return;
    }
    if (!endpointAuthorityCurrent(endpoint)) {
      disconnectEndpointPort(endpoint);
      return;
    }
    for (const listener of portListeners) listener({ endpoint, event });
  });
  channel.port1.start();
  source.postMessage(
    {
      type: "neutron:msgbus:connect",
      version: 1,
      sessionId,
    },
    endpoint.origin && endpoint.origin !== "null" ? endpoint.origin : "*",
    [channel.port2],
  );
  notifyEndpointChange();
  return true;
}

export function ensureFrameEndpointConnected(
  source: Window | null,
  authenticatedFrameReady = false,
): boolean {
  if (!source) return false;
  const endpoint = frames.get(source);
  if (endpoint?.port && endpointAuthorityCurrent(endpoint)) return true;
  return connectFrameEndpoint(source, authenticatedFrameReady);
}

/**
 * The first load preserves either READY/load ordering. Later loads retire the
 * old document's port: opaque tiles and trays reconnect directly, backgrounds
 * remain READY-gated, and exact-origin frames receive an exact-target probe.
 */
export type FrameEndpointLoadResult = "preserved" | "retired";

export function markFrameEndpointLoaded(
  source: Window | null,
): FrameEndpointLoadResult {
  if (!source) return "retired";
  const endpoint = frames.get(source);
  if (!endpoint) return "retired";
  const reloaded = loadedFrames.has(source);
  loadedFrames.add(source);
  if (!endpoint.origin || endpoint.origin === "null") {
    if (reloaded) disconnectEndpointPort(endpoint);
    const connected = ensureFrameEndpointConnected(source);
    if (!connected) requestFrameEndpointConnection(endpoint);
    return connected ? "preserved" : "retired";
  }
  if (reloaded) {
    disconnectEndpointPort(endpoint);
    requestFrameEndpointConnection(endpoint);
    return "retired";
  }
  if (endpoint.port && endpointAuthorityCurrent(endpoint)) {
    return "preserved";
  }
  disconnectEndpointPort(endpoint);
  requestFrameEndpointConnection(endpoint);
  return "retired";
}

export function isFrameEndpointReady(source: Window | null): boolean {
  if (!source) return false;
  const endpoint = frames.get(source);
  return Boolean(
    endpoint?.port &&
    endpointRegistered(endpoint) &&
    endpointAuthorityCurrent(endpoint),
  );
}

export function installFrameEndpointHandshake(
  targetWindow: Pick<Window, "addEventListener"> = window,
): void {
  if (handshakeWindows.has(targetWindow)) return;
  targetWindow.addEventListener("message", (event: Event) => {
    const message = event as MessageEvent<unknown>;
    if (!isMsgBusFrameReady(message.data)) return;
    const endpoint = resolveRegisteredEndpoint(message.source);
    if (!endpoint) return;
    if (endpoint.origin && message.origin !== endpoint.origin) return;
    acceptAuthenticatedFrameReady(endpoint);
  });
  handshakeWindows.add(targetWindow);
}

function acceptAuthenticatedFrameReady(endpoint: RegisteredEndpoint): boolean {
  if (!endpointRegistered(endpoint) || !endpointAuthorityCurrent(endpoint)) {
    disconnectEndpointPort(endpoint);
    return false;
  }
  return ensureFrameEndpointConnected(endpoint.source, true);
}

function requestFrameEndpointConnection(endpoint: RegisteredEndpoint): void {
  if (!endpointAuthorityCurrent(endpoint)) return;
  if (typeof endpoint.source.postMessage !== "function") return;
  // A newly-created iframe still contains an about:blank document inherited
  // from the Kernel. Cross-origin and opaque app documents must not be probed
  // until navigation has replaced it: targeting the future origin here
  // is rejected by the browser and can leave the resident without its private
  // message-bus port. The loaded app announces readiness proactively, while
  // retained frames whose location is already correct still receive a probe.
  if (hasKnownDifferentOrigin(endpoint.source, endpoint.origin)) return;
  endpoint.source.postMessage(
    MSG_BUS_FRAME_PROBE,
    endpoint.origin && endpoint.origin !== "null" ? endpoint.origin : "*",
  );
}

function endpointAuthorityCurrent(endpoint: RegisteredEndpoint): boolean {
  try {
    return endpoint.isAuthorityCurrent?.() ?? true;
  } catch {
    return false;
  }
}

function endpointRegistered(endpoint: RegisteredEndpoint): boolean {
  return (
    frames.get(endpoint.source) === endpoint &&
    endpoints.get(endpoint.endpointId) === endpoint
  );
}

function detachEndpointRegistration(endpoint: RegisteredEndpoint): boolean {
  let detached = false;
  if (frames.get(endpoint.source) === endpoint) {
    frames.delete(endpoint.source);
    detached = true;
  }
  if (endpoints.get(endpoint.endpointId) === endpoint) {
    endpoints.delete(endpoint.endpointId);
    detached = true;
  }
  return detached;
}

function disconnectEndpointPort(
  endpoint: RegisteredEndpoint,
  notify = true,
): void {
  const retiredPort = endpoint.port;
  const retiredSessionId = endpoint.sessionId;
  const hadPort = retiredPort !== undefined || retiredSessionId !== undefined;
  if (retiredPort) {
    retireExecPort(retiredPort);
    for (const listener of portRetirementListeners) {
      try {
        listener(retiredPort);
      } catch {
        // One teardown observer cannot keep the retired transport alive.
      }
    }
    retiredPort.close();
  }
  if (endpoint.port === retiredPort) delete endpoint.port;
  if (endpoint.sessionId === retiredSessionId) delete endpoint.sessionId;
  if (hadPort && notify) notifyEndpointChange();
}

function hasKnownDifferentOrigin(source: Window, expected?: string): boolean {
  if (!expected) return false;
  try {
    const current = source.location?.origin;
    if (expected === "null") {
      // A readable initial about:blank document belongs to the kernel and
      // must never receive an opaque resident's wildcard-targeted port.
      return typeof current === "string" && current !== "null";
    }
    return typeof current === "string" && current !== expected;
  } catch {
    // A loaded dedicated app is cross-origin from the kernel. The exact
    // postMessage target below remains the authoritative origin check.
    return false;
  }
}

export function subscribeEndpointPortMessages(
  listener: EndpointPortListener,
): () => void {
  portListeners.add(listener);
  return () => portListeners.delete(listener);
}

/** Register exact-port cleanup that must run before a retired port closes. */
export function subscribeEndpointPortRetirements(
  listener: EndpointPortRetirementListener,
): () => void {
  portRetirementListeners.add(listener);
  return () => portRetirementListeners.delete(listener);
}

export function subscribeEndpointChanges(
  listener: EndpointChangeListener,
): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function createSessionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID().replaceAll("-", "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

function notifyEndpointChange(): void {
  for (const listener of changeListeners) listener();
}

export function resolveFrameContext(
  source: MessageEventSource | null,
): FrameContext | null {
  return resolveRegisteredEndpoint(source)?.context ?? null;
}

export function resolveRegisteredEndpoint(
  source: MessageEventSource | null,
): RegisteredEndpoint | null {
  if (!source || typeof source !== "object") return null;
  return frames.get(source) ?? null;
}

export function getRegisteredEndpoint(
  endpointId: string,
): RegisteredEndpoint | null {
  return endpoints.get(endpointId) ?? null;
}

export function listRegisteredEndpoints(): RegisteredEndpoint[] {
  return [...endpoints.values()];
}
