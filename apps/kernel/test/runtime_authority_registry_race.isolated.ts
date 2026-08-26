// This file is launched by runtime_authority_registry_race.test.ts in a
// separate Bun process. Bun module mocks are process-global and cannot be
// restored safely.
import { beforeEach, expect, mock, test } from "bun:test";
import {
  registryApp,
  runtimeApp,
} from "./app_registry_fixture.ts";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const oldApp = registryApp({ id: "hello", name: "Hello", version: 100 });
const newApp = registryApp({ id: "hello", name: "Hello", version: 101 });
const oldDeploymentId = "deploy-old";
const newDeploymentId = "deploy-new";
const oldRuntime = {
  deployment_id: oldDeploymentId,
  assembler_id: "neutron_actor_v26",
  compiler_id: "neutron-compiler/test",
  capability_authority_revision: [1n] as [bigint],
  apps: [
    runtimeApp({
      id: "hello",
      entry: oldApp,
      deploymentId: oldDeploymentId,
      installationUid: 7n,
    }),
  ],
  memories: [],
};

let sidecar: unknown = { format: 1, app_ids: ["hello"] };
let registryGate: Deferred<void> | null = null;
let registryReadStarted = deferred<void>();

const actor = {
  kernel_install_status: async () => [],
  kernel_runtime_info: async () => oldRuntime,
};

mock.module("icblast", () => ({
  default: () => async () => ({}),
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

mock.module(
  new URL("../src/reducer/auth.ts", import.meta.url).pathname,
  () => ({
    getNeutronCan: async () => actor,
    readKernelAssetJson: async (path: string) => {
      if (path === "/system/apps.json") {
        registryReadStarted.resolve(undefined);
        await registryGate?.promise;
        return { hello: oldApp };
      }
      if (path === "/system/browser-surface-origins.json") return sidecar;
      return undefined;
    },
    readKernelAssetTextIfExists: async () => undefined,
    resetNeutronCan: () => undefined,
  }),
);

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: {
      href: "http://aaaaa-aa.localhost:8000/",
    },
  },
});

const {
  getApps,
  isAuthorityPendingState,
  useAppsStore,
} = await import("../src/reducer/apps.ts");

function appInstance(
  app: typeof oldApp,
  deploymentId: string,
) {
  return {
    scope: { appId: "hello", installationUid: "7" },
    version: app.version,
    deploymentId,
    capabilityPlanFingerprint: app.capability_plan_fingerprint,
    browserOriginNonce: "7".padStart(32, "0"),
    browserOriginAuthorityEpoch: "1",
    residentFrameSecurity: "credentialless_opaque_v1" as const,
  };
}

function installCurrentState(): void {
  useAppsStore.getState().setApps(
    { hello: oldApp },
    {
      appInstances: { hello: appInstance(oldApp, oldDeploymentId) },
      runtimeAssemblerId: "neutron_actor_v26",
      runtimeCapabilityAuthorityRevision: "1",
      browserSurfaceOriginAppIds: ["hello"],
    },
  );
}

beforeEach(() => {
  sidecar = { format: 1, app_ids: ["hello"] };
  registryGate = null;
  registryReadStarted = deferred<void>();
  useAppsStore.setState({
    list: {},
    appInstances: {},
    runtimeGenerations: {},
    runtimeAssemblerId: null,
    runtimeCapabilityAuthorityRevision: null,
    authorityRevision: 0,
    browserSurfaceOriginAppIds: [],
    registryStatus: "idle",
    registryError: null,
    registryUpdatedAt: null,
    operation: null,
    pendingInstallRecovery: null,
    runtimeAuthorityFence: null,
  });
  installCurrentState();
});

test("a stale deferred load cannot poison newer committed authority", async () => {
  registryGate = deferred<void>();
  const staleLoad = getApps();
  await registryReadStarted.promise;

  useAppsStore.getState().setApps(
    { hello: newApp },
    {
      appInstances: { hello: appInstance(newApp, newDeploymentId) },
      runtimeAssemblerId: "neutron_actor_v26",
      runtimeCapabilityAuthorityRevision: "2",
      browserSurfaceOriginAppIds: ["hello"],
    },
  );
  const committedList = useAppsStore.getState().list;
  registryGate.resolve(undefined);

  await expect(staleLoad).rejects.toThrow(
    "Runtime authority changed while installed app state was being verified",
  );
  const current = useAppsStore.getState();
  expect(current.list).toBe(committedList);
  expect(current.list.hello?.version).toBe(101);
  expect(current.registryStatus).toBe("ready");
  expect(current.registryError).toBeNull();
  expect(current.runtimeAuthorityFence).toBeNull();
  expect(isAuthorityPendingState(current)).toBe(false);
});

test("a genuine current v26 sidecar failure remains fenced", async () => {
  sidecar = undefined;

  await expect(getApps()).rejects.toThrow(
    "The v26 browser-surface origins sidecar is missing",
  );
  const current = useAppsStore.getState();
  expect(current.registryStatus).toBe("error");
  expect(current.registryError).toContain("sidecar is missing");
  expect(current.runtimeAuthorityFence).toEqual({
    deploymentId: null,
    reason: "observation_failed",
  });
  expect(isAuthorityPendingState(current)).toBe(true);
});
