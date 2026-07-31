import { afterEach, expect, test } from "bun:test";
import {
  hasFrontendToolGrant,
  grantFrontendToolSession,
  clearFrontendToolSessionGrants,
} from "../src/reducer/msg_bus.ts";
import {
  observeRuntimeAuthority,
  retainFrontendAuthorityAfterDeployFailure,
  useAppsStore,
  type RuntimeAuthorityRefreshResult,
} from "../src/reducer/apps.ts";
import { assertFrontendAuthorityCommitted } from "../src/runtime_authority.ts";
import {
  startRuntimeAuthorityMonitor,
  type RuntimeAuthorityMonitorOptions,
} from "../src/runtime_authority_monitor.ts";
import {
  parseRuntimeAuthoritySignal,
  type RuntimeAuthoritySignal,
} from "../src/runtime_authority_signal.ts";
import { registryApp } from "./app_registry_fixture.ts";
import { ResidentFrameSecurityMode } from "../src/capabilities/plan.ts";

const app = registryApp({ id: "hello", name: "Hello", version: 100 });
const nonce = "1".repeat(32);

function instance(deploymentId: string) {
  return {
    scope: { appId: "hello", installationUid: "7" },
    version: 100,
    deploymentId,
    capabilityPlanFingerprint: app.capability_plan_fingerprint,
    browserOriginNonce: nonce,
    browserOriginAuthorityEpoch: "1",
    residentFrameSecurity:
      ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1,
  } as const;
}

function runtime(deploymentId: string) {
  return {
    deployment_id: deploymentId,
    assembler_id: "assembler",
    compiler_id: "compiler",
    apps: [
      {
        scope: { app_id: "hello", installation_uid: 7n },
        version: 100n,
        deployment_id: deploymentId,
        capability_plan_fingerprint: app.capability_plan_fingerprint,
        browser_origin_nonce: nonce,
        browser_origin_authority_epoch: 1n,
        resident_frame_security: {
          [ResidentFrameSecurityMode.CREDENTIALLESS_OPAQUE_V1]: null,
        },
      },
    ],
    memories: [],
  };
}

type AuthorityActor = Parameters<typeof observeRuntimeAuthority>[0];

function actor(input: {
  deploymentId?: string;
  pendingDeploymentId?: string;
  statusError?: Error;
} = {}): AuthorityActor {
  return {
    kernel_install_status: async () => {
      if (input.statusError) throw input.statusError;
      if (!input.pendingDeploymentId) return [];
      return [
        {
          deployment_id: input.pendingDeploymentId,
          copy_count: 0n,
          clear_count: 0n,
          removed_apps: [],
          committed_app_instances: [],
          target_app_instances: [],
        },
      ];
    },
    kernel_runtime_info: async () => runtime(input.deploymentId ?? "deploy-old"),
  };
}

afterEach(() => {
  clearFrontendToolSessionGrants();
  useAppsStore.setState({
    list: {},
    appInstances: {},
    runtimeGenerations: {},
    operation: null,
    pendingInstallRecovery: null,
    runtimeAuthorityFence: null,
  });
});

test("runtime observations distinguish current, changed, and pending authority", async () => {
  const current = { hello: instance("deploy-old") };
  await expect(
    observeRuntimeAuthority(actor(), current),
  ).resolves.toEqual({ status: "current", deploymentId: "deploy-old" });
  await expect(
    observeRuntimeAuthority(actor({ deploymentId: "deploy-next" }), current),
  ).resolves.toEqual({ status: "changed", deploymentId: "deploy-next" });
  await expect(
    observeRuntimeAuthority(
      actor({ pendingDeploymentId: "deploy-pending" }),
      current,
    ),
  ).resolves.toEqual({
    status: "pending",
    deploymentId: "deploy-pending",
  });
});

test("failed post-activation deploys retain a fail-closed recovery fence", async () => {
  useAppsStore.getState().setApps(
    { hello: app },
    { appInstances: { hello: instance("deploy-old") } },
  );
  useAppsStore.getState().setOperation({
    kind: "install",
    appId: "hello",
    phase: "activating",
  });
  await retainFrontendAuthorityAfterDeployFailure(
    actor({ pendingDeploymentId: "deploy-pending" }),
  );
  useAppsStore.getState().setOperation(null);

  expect(useAppsStore.getState().pendingInstallRecovery).toEqual({
    deploymentId: "deploy-pending",
  });
  expect(() => assertFrontendAuthorityCommitted()).toThrow(
    "pending installation",
  );

  useAppsStore.getState().setPendingInstallRecovery(null);
  useAppsStore.getState().setOperation({
    kind: "uninstall",
    appId: "hello",
    phase: "cleaning",
  });
  await retainFrontendAuthorityAfterDeployFailure(
    actor({ statusError: new Error("network unavailable") }),
  );
  useAppsStore.getState().setOperation(null);

  expect(useAppsStore.getState().runtimeAuthorityFence).toEqual({
    deploymentId: null,
    reason: "observation_failed",
  });
  expect(() => assertFrontendAuthorityCommitted()).toThrow(
    "pending installation",
  );
});

test("same-version actor changes advance generations and clear wildcard grants", () => {
  useAppsStore.getState().setApps(
    { hello: app },
    { appInstances: { hello: instance("deploy-old") } },
  );
  const generation = useAppsStore.getState().runtimeGenerations.hello ?? 0;
  grantFrontendToolSession("hello", "kernel", "apps.list");
  expect(
    hasFrontendToolGrant(
      {
        endpoint: "app:hello:background",
        appId: "hello",
        role: "background",
      },
      "session-a",
      "kernel",
      "kernel-session",
      "apps.list",
    ),
  ).toBe(true);

  useAppsStore.getState().setApps(
    { hello: app },
    { appInstances: { hello: instance("deploy-next") } },
  );

  expect(useAppsStore.getState().runtimeGenerations.hello).toBe(
    generation + 1,
  );
  expect(
    hasFrontendToolGrant(
      {
        endpoint: "app:hello:background",
        appId: "hello",
        role: "background",
      },
      "session-b",
      "kernel",
      "kernel-session",
      "apps.list",
    ),
  ).toBe(false);
});

test("monitor coalesces refreshes and signals stale authority while hidden", async () => {
  let visibilityState: DocumentVisibilityState = "visible";
  let intervalCallback: (() => void) | null = null;
  let signalListener: ((signal: RuntimeAuthoritySignal) => void) | null = null;
  let refreshCount = 0;
  let reloadCount = 0;
  let refreshResult: RuntimeAuthorityRefreshResult = {
    status: "current",
    deploymentId: "deploy-old",
  };
  const staleDeployments: string[] = [];
  const windowListeners = new Map<string, () => void>();
  const documentListeners = new Map<string, () => void>();
  const fakeWindow = {
    addEventListener: (name: string, listener: EventListenerOrEventListenerObject) =>
      windowListeners.set(name, listener as () => void),
    removeEventListener: (name: string) => windowListeners.delete(name),
    setInterval: (callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 17;
    },
    clearInterval: () => {
      intervalCallback = null;
    },
  } as unknown as NonNullable<RuntimeAuthorityMonitorOptions["window"]>;
  const fakeDocument = {
    addEventListener: (name: string, listener: EventListenerOrEventListenerObject) =>
      documentListeners.set(name, listener as () => void),
    removeEventListener: (name: string) => documentListeners.delete(name),
    get visibilityState() {
      return visibilityState;
    },
  } as unknown as NonNullable<RuntimeAuthorityMonitorOptions["document"]>;

  const stop = startRuntimeAuthorityMonitor({
    window: fakeWindow,
    document: fakeDocument,
    refresh: async () => {
      refreshCount += 1;
      return refreshResult;
    },
    reload: () => {
      reloadCount += 1;
    },
    authorityPending: () => false,
    markStale: (deploymentId) => staleDeployments.push(deploymentId),
    subscribe: (listener) => {
      signalListener = listener;
      return () => {
        signalListener = null;
      };
    },
  });
  await drainMicrotasks();
  expect(refreshCount).toBe(1);

  visibilityState = "hidden";
  (intervalCallback as (() => void) | null)?.();
  await drainMicrotasks();
  expect(refreshCount).toBe(1);

  refreshResult = { status: "pending", deploymentId: "deploy-next" };
  (signalListener as ((signal: RuntimeAuthoritySignal) => void) | null)?.(
    signal("deploy-next", "pending", true),
  );
  await drainMicrotasks();
  expect(staleDeployments).toEqual(["deploy-next"]);
  expect(refreshCount).toBe(2);
  expect(reloadCount).toBe(0);

  refreshResult = { status: "changed", deploymentId: "deploy-next" };
  (signalListener as ((signal: RuntimeAuthoritySignal) => void) | null)?.(
    signal("deploy-next", "committed", true),
  );
  await drainMicrotasks();
  expect(staleDeployments).toEqual(["deploy-next", "deploy-next"]);
  expect(refreshCount).toBe(3);
  expect(reloadCount).toBe(1);

  visibilityState = "visible";
  documentListeners.get("visibilitychange")?.();
  await drainMicrotasks();
  expect(refreshCount).toBe(4);

  stop();
  expect(intervalCallback).toBeNull();
  expect(signalListener).toBeNull();
});

test("monitor reloads once when an external deployment changes the live shell", async () => {
  let intervalCallback: (() => void) | null = null;
  let refreshResult: RuntimeAuthorityRefreshResult = {
    status: "current",
    deploymentId: "deploy-old",
  };
  let reloadCount = 0;
  const fakeWindow = {
    addEventListener() {},
    removeEventListener() {},
    setInterval(callback: TimerHandler) {
      intervalCallback = callback as () => void;
      return 17;
    },
    clearInterval() {
      intervalCallback = null;
    },
  } as unknown as NonNullable<RuntimeAuthorityMonitorOptions["window"]>;
  const fakeDocument = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible" as const,
  } as unknown as NonNullable<RuntimeAuthorityMonitorOptions["document"]>;

  const stop = startRuntimeAuthorityMonitor({
    window: fakeWindow,
    document: fakeDocument,
    refresh: async () => refreshResult,
    markStale: () => undefined,
    subscribe: () => () => undefined,
    authorityPending: () => false,
    reload: () => {
      reloadCount += 1;
    },
  });
  await drainMicrotasks();
  expect(reloadCount).toBe(0);

  refreshResult = { status: "changed", deploymentId: "deploy-external" };
  (intervalCallback as (() => void) | null)?.();
  await drainMicrotasks();
  expect(reloadCount).toBe(1);

  (intervalCallback as (() => void) | null)?.();
  await drainMicrotasks();
  expect(reloadCount).toBe(1);
  stop();
});

test("monitor keeps a shell live for a signaled app-only deployment", async () => {
  let signalListener: ((signal: RuntimeAuthoritySignal) => void) | null = null;
  let refreshResult: RuntimeAuthorityRefreshResult = {
    status: "current",
    deploymentId: "deploy-old",
  };
  let reloadCount = 0;
  const fakeWindow = {
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 17,
    clearInterval() {},
  } as unknown as NonNullable<RuntimeAuthorityMonitorOptions["window"]>;
  const fakeDocument = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: "visible" as const,
  } as unknown as NonNullable<RuntimeAuthorityMonitorOptions["document"]>;

  const stop = startRuntimeAuthorityMonitor({
    window: fakeWindow,
    document: fakeDocument,
    refresh: async () => refreshResult,
    markStale: () => undefined,
    subscribe: (listener) => {
      signalListener = listener;
      return () => {
        signalListener = null;
      };
    },
    authorityPending: () => false,
    reload: () => {
      reloadCount += 1;
    },
  });
  await drainMicrotasks();

  refreshResult = { status: "changed", deploymentId: "deploy-app-only" };
  (signalListener as ((signal: RuntimeAuthoritySignal) => void) | null)?.(
    signal("deploy-app-only", "committed", false),
  );
  await drainMicrotasks();
  expect(reloadCount).toBe(0);
  stop();
});

test("runtime authority signals are exact and canister-bound", () => {
  const value = signal("deploy-next");
  expect(parseRuntimeAuthoritySignal(value, "aaaaa-aa")).toEqual(value);
  expect(parseRuntimeAuthoritySignal(value, "bbbbb-bb")).toBeNull();
  expect(
    parseRuntimeAuthoritySignal({ ...value, unexpected: true }, "aaaaa-aa"),
  ).toBeNull();
});

function signal(
  deploymentId: string,
  phase: RuntimeAuthoritySignal["phase"] = "committed",
  kernelUpdated = false,
): RuntimeAuthoritySignal {
  return {
    version: 1,
    canisterId: "aaaaa-aa",
    deploymentId,
    phase,
    kernelUpdated,
    sentAt: 1,
    nonce: "1".repeat(32),
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
