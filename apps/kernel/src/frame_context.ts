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
  | TileFrameContext
  | BackgroundFrameContext
  | TrayFrameContext;

export type RegisteredEndpoint = {
  endpointId: string;
  source: Window;
  context: FrameContext;
  appVersion?: number;
  appGeneration?: number;
  appScope?: AppScope;
  origin?: string;
  residentSecurityBinding?: ResidentFrameSecurityBinding;
  isAuthorityCurrent?: () => boolean;
  port?: MessagePort;
  sessionId?: string;
};

export type EndpointPortMessage = {
  endpoint: RegisteredEndpoint;
  event: MessageEvent;
};

type EndpointPortListener = (message: EndpointPortMessage) => void;
type EndpointChangeListener = () => void;

const frames = new WeakMap<object, RegisteredEndpoint>();
const endpoints = new Map<string, RegisteredEndpoint>();
const portListeners = new Set<EndpointPortListener>();
const changeListeners = new Set<EndpointChangeListener>();
const handshakeWindows = new WeakSet<object>();

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
    ...(options.residentSecurityBinding
      ? {
          residentSecurityBinding: Object.freeze({
            ...options.residentSecurityBinding,
          }),
        }
      : {}),
    ...(options.isAuthorityCurrent
      ? { isAuthorityCurrent: options.isAuthorityCurrent }
      : {}),
  };
  if (!endpointAuthorityCurrent(endpoint)) {
    throw new Error("App frame authority is no longer current");
  }
  const previousSourceEndpoint = frames.get(source);
  const previousIdEndpoint = endpoints.get(endpoint.endpointId);
  previousSourceEndpoint?.port?.close();
  if (previousIdEndpoint !== previousSourceEndpoint) {
    previousIdEndpoint?.port?.close();
  }
  if (
    previousSourceEndpoint &&
    endpoints.get(previousSourceEndpoint.endpointId) === previousSourceEndpoint
  ) {
    endpoints.delete(previousSourceEndpoint.endpointId);
  }
  if (
    previousIdEndpoint &&
    frames.get(previousIdEndpoint.source) === previousIdEndpoint
  ) {
    frames.delete(previousIdEndpoint.source);
  }
  frames.set(source, endpoint);
  endpoints.set(endpoint.endpointId, endpoint);
  notifyEndpointChange();
  requestFrameEndpointConnection(endpoint);
  return () => {
    endpoint.port?.close();
    if (frames.get(source) === endpoint) frames.delete(source);
    if (endpoints.get(endpoint.endpointId) === endpoint) {
      endpoints.delete(endpoint.endpointId);
      notifyEndpointChange();
    }
  };
}

export function waitForFrameEndpointPort(
  endpoint: RegisteredEndpoint,
  timeoutSeconds: number,
): Promise<MessagePort> {
  if (!endpointAuthorityCurrent(endpoint)) {
    return Promise.reject(
      new Error(`Endpoint '${endpoint.endpointId}' authority is no longer current`),
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
  if (endpoint.residentSecurityBinding && !authenticatedFrameReady) {
    return false;
  }
  if (!endpointAuthorityCurrent(endpoint)) {
    disconnectEndpointPort(endpoint);
    return false;
  }
  if (hasKnownDifferentOrigin(source, endpoint.origin)) return false;

  endpoint.port?.close();
  const channel = new MessageChannel();
  const sessionId = createSessionId();
  endpoint.port = channel.port1;
  endpoint.sessionId = sessionId;
  channel.port1.addEventListener("message", (event) => {
    if (endpoint.port !== channel.port1 || endpoint.sessionId !== sessionId) {
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
    [channel.port2]
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

export function isFrameEndpointReady(source: Window | null): boolean {
  if (!source) return false;
  const endpoint = frames.get(source);
  return Boolean(endpoint?.port && endpointAuthorityCurrent(endpoint));
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
    ensureFrameEndpointConnected(endpoint.source, true);
  });
  handshakeWindows.add(targetWindow);
}

function requestFrameEndpointConnection(endpoint: RegisteredEndpoint): void {
  if (!endpointAuthorityCurrent(endpoint)) return;
  if (typeof endpoint.source.postMessage !== "function") return;
  // A newly-created iframe still contains an about:blank document inherited
  // from the Kernel. Dedicated and opaque app origins must not be probed until
  // navigation has replaced that document: targeting the future origin here
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

function disconnectEndpointPort(endpoint: RegisteredEndpoint): void {
  const hadPort = endpoint.port !== undefined || endpoint.sessionId !== undefined;
  endpoint.port?.close();
  delete endpoint.port;
  delete endpoint.sessionId;
  if (hadPort) notifyEndpointChange();
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
  listener: EndpointPortListener
): () => void {
  portListeners.add(listener);
  return () => portListeners.delete(listener);
}

export function subscribeEndpointChanges(
  listener: EndpointChangeListener
): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
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
  source: MessageEventSource | null
): FrameContext | null {
  return resolveRegisteredEndpoint(source)?.context ?? null;
}

export function resolveRegisteredEndpoint(
  source: MessageEventSource | null
): RegisteredEndpoint | null {
  if (!source || typeof source !== "object") return null;
  return frames.get(source) ?? null;
}

export function getRegisteredEndpoint(
  endpointId: string
): RegisteredEndpoint | null {
  return endpoints.get(endpointId) ?? null;
}

export function listRegisteredEndpoints(): RegisteredEndpoint[] {
  return [...endpoints.values()];
}
