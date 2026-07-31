import { HttpAgent } from "@dfinity/agent";
import { equalBytes, lowerHex } from "../protocol/index.ts";
import {
  createWagyuVerifier,
  trustedWagyuNetworkConfig,
} from "../verifier/index.ts";
import {
  createCanisterHttpQueryFetch,
} from "../verifier/canister_http_query_fetch.ts";
import { WagyuVerificationEngineV1 } from "./engine.ts";
import { createBrowserImmutableResponseCache } from "./response_cache.ts";
import {
  createBrowserVerificationStore,
  createMemoryVerificationStore,
} from "./storage.ts";
import {
  WAGYU_VERIFICATION_WORKER_PROTOCOL,
  WAGYU_WORKER_MAX_TIMEOUT_MS,
  type WagyuWorkerRequestV1,
  type WagyuWorkerResponseV1,
  type WagyuWorkerResultV1,
  type WagyuWorkerTrustedConfigV1,
} from "./types.ts";

const MAX_IN_FLIGHT_TASKS = 32;
const MAX_ROOT_KEY_BYTES = 4_096;
const LOOPBACK_HOST = /^(?:localhost|[a-z0-9-]+\.localhost)$/iu;

export interface WagyuWorkerHostScopeV1 {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener?(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

export interface WagyuWorkerBootstrapScopeV1 {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

export interface WagyuVerificationEngineLikeV1 {
  readonly trustedNetworkIdHex: string;
  execute(
    task: Extract<WagyuWorkerRequestV1, { type: "task" }>["task"],
    signal: AbortSignal,
  ): Promise<WagyuWorkerResultV1<unknown>>;
}

export type WagyuVerificationEngineFactoryV1 = (
  trusted: WagyuWorkerTrustedConfigV1,
) =>
  | Promise<WagyuVerificationEngineLikeV1>
  | WagyuVerificationEngineLikeV1;

export function createDefaultVerificationEngine(
  trusted: WagyuWorkerTrustedConfigV1,
): WagyuVerificationEngineV1 {
  const rootKey = boundedBytes(
    trusted.rootKey,
    "Trusted root key",
    1,
    MAX_ROOT_KEY_BYTES,
  );
  const expectedNetworkId = boundedBytes(
    trusted.networkId,
    "Trusted network ID",
    32,
    32,
  );
  if (
    typeof trusted.gatewayOrigin !== "string" ||
    trusted.gatewayOrigin.length === 0 ||
    trusted.gatewayOrigin.length > 2_048
  ) {
    throw new Error("Trusted gateway origin is invalid");
  }
  const gateway = {
    origin: trusted.gatewayOrigin,
    ...(trusted.allowInsecureLocalhost === true
      ? { allowInsecureLocalhost: true as const }
      : {}),
  };
  const network = trustedWagyuNetworkConfig(rootKey, gateway);
  if (!equalBytes(network.networkId, expectedNetworkId)) {
    throw new Error(
      "Worker network ID is not derived from the trusted runtime root",
    );
  }
  const persistent = trusted.storageMode === "persistent-background";
  const localQueryFetch = trusted.allowInsecureLocalhost === true
    ? createCanisterHttpQueryFetch(
      new HttpAgent({
        host: requireLocalAgentHost(trusted.localAgentHost),
        rootKey,
        verifyQuerySignatures: false,
      }),
    )
    : undefined;
  const immutableResponses = persistent
    ? createBrowserImmutableResponseCache(
      lowerHex(network.networkId),
      localQueryFetch ?? globalThis.fetch,
    )
    : undefined;
  const certifiedFetch = immutableResponses?.fetch ?? localQueryFetch;
  const verifier = createWagyuVerifier({
    network,
    ...(certifiedFetch === undefined
      ? {}
      : { fetch: certifiedFetch }),
  });
  return new WagyuVerificationEngineV1({
    verifier,
    storage: persistent
      ? createBrowserVerificationStore()
      : createMemoryVerificationStore(),
    ...(immutableResponses === undefined ? {} : { immutableResponses }),
  });
}

export class WagyuVerificationWorkerHostV1 {
  private engine: WagyuVerificationEngineLikeV1 | null = null;
  private initializing = false;
  private closed = false;
  private readonly active = new Map<string, AbortController>();
  private readonly onMessage = (event: MessageEvent<unknown>) => {
    void this.receive(event.data);
  };

  constructor(
    private readonly scope: WagyuWorkerHostScopeV1,
    private readonly createEngine: WagyuVerificationEngineFactoryV1 =
      createDefaultVerificationEngine,
  ) {
    scope.addEventListener("message", this.onMessage);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.scope.removeEventListener?.("message", this.onMessage);
    for (const controller of this.active.values()) {
      controller.abort("cancel");
    }
    this.active.clear();
  }

  private async receive(value: unknown): Promise<void> {
    if (this.closed || !isWorkerRequest(value)) return;
    if (value.type === "cancel") {
      this.active.get(value.requestId)?.abort("cancel");
      return;
    }
    if (value.type === "init") {
      await this.initialize(value.requestId, value.trusted);
      return;
    }
    await this.runTask(value);
  }

  private async initialize(
    requestId: string,
    trusted: WagyuWorkerTrustedConfigV1,
  ): Promise<void> {
    if (this.engine !== null || this.initializing) {
      this.respond(
        requestId,
        invalid(
          "worker_already_initialized",
          "Verification Worker trust can be configured only once",
        ),
      );
      return;
    }
    this.initializing = true;
    try {
      const engine = await this.createEngine(cloneTrustedConfig(trusted));
      this.engine = engine;
      this.respond(requestId, {
        state: "verified",
        value: { networkId: engine.trustedNetworkIdHex },
      });
    } catch (error) {
      this.respond(
        requestId,
        invalid(
          "invalid_worker_trust",
          boundedError(error, "Worker trust initialization failed"),
        ),
      );
    } finally {
      this.initializing = false;
    }
  }

  private async runTask(
    request: Extract<WagyuWorkerRequestV1, { type: "task" }>,
  ): Promise<void> {
    if (this.engine === null) {
      this.respond(
        request.requestId,
        unavailable(
          "worker_not_initialized",
          "Verification Worker has no trusted runtime configuration",
        ),
      );
      return;
    }
    if (
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > WAGYU_WORKER_MAX_TIMEOUT_MS
    ) {
      this.respond(
        request.requestId,
        invalid(
          "invalid_worker_timeout",
          "Verification Worker timeout is outside its bounded range",
        ),
      );
      return;
    }
    if (
      this.active.has(request.requestId) ||
      this.active.size >= MAX_IN_FLIGHT_TASKS
    ) {
      this.respond(
        request.requestId,
        unavailable(
          "worker_busy",
          "Verification Worker has reached its in-flight task bound",
        ),
      );
      return;
    }

    const controller = new AbortController();
    this.active.set(request.requestId, controller);
    const timer = setTimeout(
      () => controller.abort("timeout"),
      request.timeoutMs,
    );
    try {
      const result = await Promise.race([
        this.engine.execute(request.task, controller.signal),
        interruptionResult(controller.signal),
      ]);
      this.respond(request.requestId, result);
    } catch (error) {
      this.respond(
        request.requestId,
        unavailable(
          "worker_execution_failed",
          boundedError(error, "Verification Worker execution failed"),
        ),
      );
    } finally {
      clearTimeout(timer);
      this.active.delete(request.requestId);
    }
  }

  private respond(
    requestId: string,
    result: WagyuWorkerResultV1<unknown>,
  ): void {
    if (this.closed) return;
    const response: WagyuWorkerResponseV1 = {
      protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
      type: "response",
      requestId,
      result,
    };
    this.scope.postMessage(response);
  }
}

export function installWagyuVerificationWorker(
  scope: WagyuWorkerHostScopeV1,
): WagyuVerificationWorkerHostV1 {
  return new WagyuVerificationWorkerHostV1(scope);
}

/**
 * Accept exactly one private MessagePort from the package-owned bootstrap.
 * The global Worker channel never receives trust configuration or tasks.
 */
export function installWagyuVerificationWorkerBootstrap(
  scope: WagyuWorkerBootstrapScopeV1,
  createEngine: WagyuVerificationEngineFactoryV1 =
    createDefaultVerificationEngine,
): { close(): void } {
  let host: WagyuVerificationWorkerHostV1 | null = null;
  let port: MessagePort | null = null;
  let closed = false;
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (closed || host !== null || !isBootstrapConnect(event.data)) return;
    if (event.ports.length !== 1) {
      for (const candidate of event.ports) candidate.close();
      return;
    }
    const nextPort = event.ports[0]!;
    const channelScope: WagyuWorkerHostScopeV1 = {
      postMessage(message) {
        nextPort.postMessage(message);
      },
      addEventListener(_type, listener) {
        nextPort.addEventListener("message", listener);
      },
      removeEventListener(_type, listener) {
        nextPort.removeEventListener("message", listener);
      },
    };
    scope.removeEventListener("message", onMessage);
    port = nextPort;
    host = new WagyuVerificationWorkerHostV1(
      channelScope,
      createEngine,
    );
    nextPort.start();
    nextPort.postMessage({
      protocol: WAGYU_VERIFICATION_WORKER_PROTOCOL,
      type: "connected",
      channelId: event.data.channelId,
    });
  };
  scope.addEventListener("message", onMessage);

  return {
    close() {
      if (closed) return;
      closed = true;
      scope.removeEventListener("message", onMessage);
      host?.close();
      port?.close();
      host = null;
      port = null;
    },
  };
}

function interruptionResult(
  signal: AbortSignal,
): Promise<WagyuWorkerResultV1<never>> {
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        const timedOut = signal.reason === "timeout";
        resolve(
          unavailable(
            timedOut ? "worker_timeout" : "worker_cancelled",
            timedOut
              ? "Verification exceeded its bounded Worker deadline"
              : "Verification was cancelled",
          ),
        );
      },
      { once: true },
    );
  });
}

function isWorkerRequest(value: unknown): value is WagyuWorkerRequestV1 {
  if (
    !isRecord(value) ||
    value.protocol !== WAGYU_VERIFICATION_WORKER_PROTOCOL ||
    typeof value.requestId !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/u.test(value.requestId)
  ) {
    return false;
  }
  if (value.type === "cancel") return true;
  if (value.type === "init") {
    return isRecord(value.trusted);
  }
  return (
    value.type === "task" &&
    typeof value.timeoutMs === "number" &&
    isRecord(value.task)
  );
}

function isBootstrapConnect(
  value: unknown,
): value is {
  readonly protocol: typeof WAGYU_VERIFICATION_WORKER_PROTOCOL;
  readonly type: "connect";
  readonly channelId: string;
} {
  return (
    isRecord(value) &&
    value.protocol === WAGYU_VERIFICATION_WORKER_PROTOCOL &&
    value.type === "connect" &&
    typeof value.channelId === "string" &&
    /^[a-f0-9]{64}$/u.test(value.channelId)
  );
}

function cloneTrustedConfig(
  value: WagyuWorkerTrustedConfigV1,
): WagyuWorkerTrustedConfigV1 {
  if (!isRecord(value)) throw new Error("Worker trust is malformed");
  return {
    rootKey: boundedBytes(
      value.rootKey,
      "Trusted root key",
      1,
      MAX_ROOT_KEY_BYTES,
    ),
    networkId: boundedBytes(
      value.networkId,
      "Trusted network ID",
      32,
      32,
    ),
    gatewayOrigin: value.gatewayOrigin,
    ...(value.allowInsecureLocalhost === true
      ? { allowInsecureLocalhost: true }
      : {}),
    ...(typeof value.localAgentHost === "string"
      ? { localAgentHost: value.localAgentHost }
      : {}),
    storageMode:
      value.storageMode === "persistent-background"
        ? "persistent-background"
        : "memory",
  };
}

function requireLocalAgentHost(value: string | undefined): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("Local Worker agent host is unavailable");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Local Worker agent host is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !LOOPBACK_HOST.test(parsed.hostname) ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("Local Worker agent host is not a closed loopback origin");
  }
  return parsed.origin;
}

function boundedBytes(
  value: Uint8Array,
  label: string,
  minimum: number,
  maximum: number,
): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength < minimum ||
    value.byteLength > maximum
  ) {
    throw new Error(`${label} has an invalid byte length`);
  }
  return value.slice();
}

function invalid(
  code: string,
  reason: string,
): Extract<WagyuWorkerResultV1<never>, { state: "invalid" }> {
  return { state: "invalid", code, reason };
}

function unavailable(
  code: string,
  reason: string,
): Extract<WagyuWorkerResultV1<never>, { state: "unavailable" }> {
  return { state: "unavailable", code, reason };
}

function boundedError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.length > 512 ? `${message.slice(0, 509)}...` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
