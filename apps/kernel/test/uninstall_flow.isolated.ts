// This file is launched by uninstall_flow.test.ts in a separate Bun process.
// Bun module mocks are process-global and cannot be restored safely.
import { beforeEach, expect, mock, test } from "bun:test";
import type {
  CompileResult,
  DeployPreparedPackagesInput,
  KernelPackageState,
} from "neutron-compiler/src/install.js";
import type { CompleteDeploymentBuildRecord } from "neutron-compiler/src/deployment_record.js";

const BASELINE_DEPLOYMENT_ID = "11".repeat(16);
const TARGET_DEPLOYMENT_ID = "22".repeat(16);
const DEPLOYMENT_NONCE = "33".repeat(16);
const TARGET_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const BASELINE_PROVENANCE = Object.freeze({
  format: 1 as const,
  apps: Object.freeze({
    mail: Object.freeze({
      kind: "manual" as const,
      acquisition: "file" as const,
      package_digest: "aa".repeat(32),
    }),
  }),
});

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

type CompileCall = Readonly<{
  state: KernelPackageState;
  appId: string;
  deploymentNonce: string;
  vetKeysEnvironment: "local" | "production";
  persistenceMode: "classical" | "enhanced";
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let compilerState: KernelPackageState;
let observedCompilerState: KernelPackageState;
let compiled: CompileResult;
let compileGate = deferred<CompileResult>();
let compileStarted = deferred<void>();
let deployGate = deferred<never>();
let deployStarted = deferred<void>();
let compileCalls: CompileCall[] = [];
let deployCalls: DeployPreparedPackagesInput[] = [];
let recordPreparationCalls: Array<Record<string, unknown>> = [];
let provenanceReads: string[] = [];
let resetCalls = 0;
let baselineAssertions = 0;
let baselineMismatch: Error | null = null;
let provenanceValue: unknown = BASELINE_PROVENANCE;
let preparedRecordBytes = new Uint8Array([1]);
let operationPhases: string[] = [];
let deploymentRecord: CompleteDeploymentBuildRecord;
let runtimeDeploymentId = BASELINE_DEPLOYMENT_ID;
let runtimeCompilerId = "moc_classical_test";

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

mock.module("neutron-compiler/src/install.js", () => ({
  appDependencyImpact: () => ({ direct: [], transitive: [] }),
  assertPreparedPackageArchiveIdentity: () => undefined,
  assertPreparedPackageBatch: () => undefined,
  assertKernelPackageBaselineMatchesRuntime: (
    state: KernelPackageState,
    runtime: { deployment_id: string },
  ) => {
    baselineAssertions += 1;
    expect(state).toBe(observedCompilerState);
    expect(runtime.deployment_id).toBe(runtimeDeploymentId);
    if (baselineMismatch) throw baselineMismatch;
  },
  compileAppUninstall: (input: CompileCall) => {
    compileCalls.push(input);
    compileStarted.resolve(undefined);
    return compileGate.promise;
  },
  compilePackages: () => {
    throw new Error("Unexpected package-batch compilation");
  },
  compilePackageInstall: () => {
    throw new Error("Unexpected package compilation");
  },
  createDeploymentNonce: () => DEPLOYMENT_NONCE,
  deployPreparedPackages: (input: DeployPreparedPackagesInput) => {
    deployCalls.push(input);
    deployStarted.resolve(undefined);
    return deployGate.promise;
  },
  normalizeAppRegistry: (registry: unknown) => registry,
  planAppRegistryDependencies: () => ({}),
  preparePackageInstall: () => {
    throw new Error("Unexpected package preparation");
  },
  recoverPendingInstall: async () => ({ status: "none" }),
  readKernelPackageState: async () => observedCompilerState,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS: {},
}));

mock.module("neutron-compiler/src/deployment_record.js", () => ({
  DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES: 4 * 1024 * 1024,
  DEPLOYMENT_BUILD_RECORD_PATH: "/system/deployment-build-record.json",
  parseDeploymentBuildRecord: (value: unknown) => value,
}));

mock.module(
  new URL(
    "../src/install_review/deployment_build_review.ts",
    import.meta.url,
  ).pathname,
  () => ({
    createDeploymentBuildReviewModel: (input: unknown) => input,
  }),
);

mock.module(
  new URL(
    "../src/install_review/prepare_browser_deployment.ts",
    import.meta.url,
  ).pathname,
  () => ({
    prepareBrowserDeployment: async (input: Record<string, unknown>) => {
      recordPreparationCalls.push(input);
      const review = Object.freeze({
        record: deploymentRecord,
        suppliedPackages: Object.freeze([]),
        retainedPackageRecords: Object.freeze({}),
      });
      return Object.freeze({
        prepared: Object.freeze({
          record: deploymentRecord,
          recordBytes: preparedRecordBytes.slice(),
          transportWasm: new Uint8Array([2]),
        }),
        review,
      });
    },
  }),
);

const actor = {
  kernel_runtime_info: async () => ({
    deployment_id: runtimeDeploymentId,
    assembler_id: "neutron-assembler/test",
    compiler_id: runtimeCompilerId,
    apps: [],
    memories: [],
  }),
};

mock.module(
  new URL("../src/reducer/auth.ts", import.meta.url).pathname,
  () => ({
    getNeutronCan: async () => actor,
    readKernelAssetJson: async (path: string) => {
      provenanceReads.push(path);
      return provenanceValue;
    },
    readKernelAssetTextIfExists: async () => undefined,
    resetNeutronCan: () => {
      resetCalls += 1;
    },
  }),
);

mock.module(
  new URL("../src/runtime_deployment.ts", import.meta.url).pathname,
  () => ({
    getRuntimeDeployment: () => ({
      canisterId: TARGET_CANISTER_ID,
      target: "pocketic",
    }),
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
  resolveAppUninstall,
  uninstall_app,
  useAppsStore,
} = await import("../src/reducer/apps.ts");
const { useWorkspaceStore } = await import("../src/workspace/store.ts");
useAppsStore.subscribe((state, previous) => {
  if (state.operation !== previous.operation && state.operation?.phase) {
    operationPhases.push(state.operation.phase);
  }
});

const baselineKernel = Object.freeze({
  name: "Neutron",
  version: 307,
});
const baselineMail = Object.freeze({
  name: "Mail from authenticated baseline",
  version: 100,
});
const staleUiMail = Object.freeze({
  name: "Mail from stale UI state",
  version: 99,
});
const mailInstance = Object.freeze({
  scope: { appId: "mail", installationUid: "7" },
  version: 99,
  deploymentId: "stale-ui-deployment",
  capabilityPlanFingerprint: "a".repeat(64),
  browserOriginNonce: "01".repeat(16),
  browserOriginAuthorityEpoch: "1",
  residentFrameSecurity: "credentialless_opaque_v1" as const,
});
const mailTile = Object.freeze({
  id: "mail-main-test",
  appId: "mail",
  tileId: "main",
  title: "Mail",
  path: "/",
  icon: "mail",
});

function createCompilerState(): KernelPackageState {
  const apps = Object.freeze({
    kernel: baselineKernel,
    mail: baselineMail,
  });
  return Object.freeze({
    registry: apps,
    apps,
    existingConfigs: Object.freeze({
      kernel: { name: "Neutron" },
      mail: { name: "Mail from authenticated baseline" },
    }),
    existingModules: Object.freeze([
      Object.freeze({ path: "mo/retained.mo", content: "module {}" }),
    ]),
    previousStable: "actor { stable let retained : Nat = 1 }",
    connectionProviderSupport: Object.freeze({}),
  }) as unknown as KernelPackageState;
}

function createDriftedCompilerState(): KernelPackageState {
  return Object.freeze({
    ...compilerState,
    existingModules: Object.freeze([
      Object.freeze({ path: "mo/retained.mo", content: "module { let changed = true }" }),
    ]),
  }) as unknown as KernelPackageState;
}

function createConnectionProviderDriftedState(): KernelPackageState {
  return Object.freeze({
    ...compilerState,
    connectionProviderSupport: Object.freeze({
      mail: Object.freeze({ changed_during_review: true }),
    }),
  }) as unknown as KernelPackageState;
}

function createCompiledResult(): CompileResult {
  return Object.freeze({
    deploymentId: TARGET_DEPLOYMENT_ID,
    dependencyPlan: Object.freeze({ order: Object.freeze(["kernel"]) }),
    migrationPlan: Object.freeze({
      destructiveMemoryRoots: Object.freeze([
        // Deliberately differs from the normalized record returned by the
        // preparation mock. Consent must render the sealed record, not rebuild
        // warnings from mutable compiler-facing fields.
        Object.freeze({ owner: "mail", memoryId: "compiler_unreviewed" }),
        Object.freeze({ owner: "kernel", memoryId: "kernel_retained" }),
      ]),
    }),
  }) as unknown as CompileResult;
}

function createDeploymentRecord(): CompleteDeploymentBuildRecord {
  return Object.freeze({
    format: 1,
    state: "complete",
    deployment_id: TARGET_DEPLOYMENT_ID,
    warnings: Object.freeze({
      removed_apps: Object.freeze(["mail"]),
      destructive_memory_roots: Object.freeze([
        Object.freeze({ owner: "mail", memory_id: "mail_primary" }),
        Object.freeze({ owner: "mail", memory_id: "mail_archive" }),
      ]),
    }),
  }) as unknown as CompleteDeploymentBuildRecord;
}

function resetWorkspace(): void {
  useWorkspaceStore.setState({
    activeWorkspaceId: 1,
    workspaceDropTargetId: null,
    workspaces: {
      1: {
        id: 1,
        layout: { id: "mail-node", type: "tile", tileId: mailTile.id },
        tiles: [mailTile],
        focusedTileId: mailTile.id,
      },
      2: { id: 2, layout: null, tiles: [], focusedTileId: null },
      3: { id: 3, layout: null, tiles: [], focusedTileId: null },
    },
  });
}

function workspaceSnapshot(): string {
  return JSON.stringify(useWorkspaceStore.getState().workspaces);
}

async function waitForUninstallRequest(): Promise<NonNullable<
  ReturnType<typeof useAppsStore.getState>["uninstallRequest"]
>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const request = useAppsStore.getState().uninstallRequest;
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the final uninstall review");
}

async function startReviewedUninstall(): Promise<{
  request: NonNullable<ReturnType<typeof useAppsStore.getState>["uninstallRequest"]>;
  result: ReturnType<typeof uninstall_app>;
}> {
  const result = uninstall_app("mail");
  await compileStarted.promise;
  compileGate.resolve(compiled);
  const request = await waitForUninstallRequest();
  return { request, result };
}

beforeEach(() => {
  resolveAppUninstall(false);
  compilerState = createCompilerState();
  observedCompilerState = compilerState;
  compiled = createCompiledResult();
  deploymentRecord = createDeploymentRecord();
  compileGate = deferred<CompileResult>();
  compileStarted = deferred<void>();
  deployGate = deferred<never>();
  deployStarted = deferred<void>();
  compileCalls = [];
  deployCalls = [];
  recordPreparationCalls = [];
  provenanceReads = [];
  resetCalls = 0;
  baselineAssertions = 0;
  baselineMismatch = null;
  provenanceValue = BASELINE_PROVENANCE;
  preparedRecordBytes = new Uint8Array([1]);
  runtimeDeploymentId = BASELINE_DEPLOYMENT_ID;
  runtimeCompilerId = "moc_classical_test";
  useAppsStore.setState({
    list: {
      kernel: baselineKernel,
      mail: staleUiMail,
    } as never,
    appInstances: { mail: mailInstance },
    runtimeGenerations: { mail: 12 },
    registryStatus: "ready",
    registryError: null,
    registryUpdatedAt: 123,
    request: null,
    uninstallRequest: null,
    compiled: null,
    operation: null,
    operationBusy: false,
    installError: null,
    pendingInstallRecovery: null,
    runtimeAuthorityFence: null,
  });
  resetWorkspace();
  operationPhases = [];
});

test("uninstall compilation completes before the final confirmation is exposed", async () => {
  const result = uninstall_app("mail");
  await compileStarted.promise;

  expect(compileCalls).toHaveLength(1);
  expect(compileCalls[0]).toEqual({
    state: compilerState,
    appId: "mail",
    deploymentNonce: DEPLOYMENT_NONCE,
    vetKeysEnvironment: "local",
    persistenceMode: "classical",
  });
  expect(baselineAssertions).toBe(1);
  expect(useAppsStore.getState()).toMatchObject({
    operation: { kind: "uninstall", appId: "mail", phase: "preparing" },
    operationBusy: true,
    uninstallRequest: null,
  });
  expect(deployCalls).toHaveLength(0);

  compileGate.resolve(compiled);
  const request = await waitForUninstallRequest();

  expect(request).toMatchObject({
    appId: "mail",
    appName: "Mail from authenticated baseline",
    memoryIds: ["mail_primary", "mail_archive"],
    deploymentReview: { record: deploymentRecord, suppliedPackages: [] },
  });
  expect(request.deploymentReview.record).toBe(deploymentRecord);
  expect(recordPreparationCalls).toHaveLength(1);
  expect(recordPreparationCalls[0]).toMatchObject({
    targetCanisterId: TARGET_CANISTER_ID,
    packages: [],
    state: compilerState,
    compiled,
    expectedDeploymentId: BASELINE_DEPLOYMENT_ID,
    removedApps: ["mail"],
    provenance: BASELINE_PROVENANCE,
  });
  expect(useAppsStore.getState().operation).toBeNull();
  expect(useAppsStore.getState().operationBusy).toBe(true);
  expect(deployCalls).toHaveLength(0);

  resolveAppUninstall(false);
  await expect(result).resolves.toBeNull();
});

test("cancelling the prepared uninstall preserves state and performs no deployment work", async () => {
  const before = {
    list: useAppsStore.getState().list,
    appInstances: useAppsStore.getState().appInstances,
    runtimeGenerations: useAppsStore.getState().runtimeGenerations,
    pendingInstallRecovery: useAppsStore.getState().pendingInstallRecovery,
    runtimeAuthorityFence: useAppsStore.getState().runtimeAuthorityFence,
    workspace: workspaceSnapshot(),
  };
  const { result } = await startReviewedUninstall();

  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toEqual(["/system/install-provenance.json"]);
  expect(operationPhases).not.toContain("staging");
  resolveAppUninstall(false);

  await expect(result).resolves.toBeNull();
  const state = useAppsStore.getState();
  expect(state.list).toBe(before.list);
  expect(state.appInstances).toBe(before.appInstances);
  expect(state.runtimeGenerations).toBe(before.runtimeGenerations);
  expect(state.pendingInstallRecovery).toBe(before.pendingInstallRecovery);
  expect(state.runtimeAuthorityFence).toBe(before.runtimeAuthorityFence);
  expect(workspaceSnapshot()).toBe(before.workspace);
  expect(state.uninstallRequest).toBeNull();
  expect(state.operation).toBeNull();
  expect(state.operationBusy).toBe(false);
  expect(state.installError).toBeNull();
  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toEqual(["/system/install-provenance.json"]);
  expect(operationPhases).not.toContain("staging");
  expect(resetCalls).toBe(0);
});

test("a changed runtime after review is rejected before staging or deployment", async () => {
  const { result } = await startReviewedUninstall();
  runtimeDeploymentId = "44".repeat(16);

  resolveAppUninstall(true);

  await expect(result).rejects.toThrow(
    "Installed app state changed during uninstall review",
  );
  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toEqual([
    "/system/install-provenance.json",
    "/system/install-provenance.json",
  ]);
  expect(operationPhases).not.toContain("staging");
  expect(useAppsStore.getState()).toMatchObject({
    uninstallRequest: null,
    operation: null,
    operationBusy: false,
    installError: {
      kind: "uninstall",
      message: expect.stringContaining(
        "Installed app state changed during uninstall review",
      ),
    },
  });
  expect(resetCalls).toBe(0);
});

test("compiler state drift during review is rejected before staging", async () => {
  const { result } = await startReviewedUninstall();
  observedCompilerState = createDriftedCompilerState();

  resolveAppUninstall(true);

  await expect(result).rejects.toThrow(
    "Installed app state changed during uninstall review",
  );
  expect(recordPreparationCalls).toHaveLength(1);
  expect(deployCalls).toHaveLength(0);
  expect(operationPhases).not.toContain("staging");
  expect(provenanceReads).toEqual([
    "/system/install-provenance.json",
    "/system/install-provenance.json",
  ]);
});

test("connection-provider compiler input drift is rejected before staging", async () => {
  const { result } = await startReviewedUninstall();
  observedCompilerState = createConnectionProviderDriftedState();

  resolveAppUninstall(true);

  await expect(result).rejects.toThrow(
    "Installed app state changed during uninstall review",
  );
  expect(recordPreparationCalls).toHaveLength(1);
  expect(deployCalls).toHaveLength(0);
  expect(operationPhases).not.toContain("staging");
});

test("same-deployment compiler identity drift is rejected before staging", async () => {
  const { result } = await startReviewedUninstall();
  runtimeCompilerId = "moc_classical_changed";

  resolveAppUninstall(true);

  await expect(result).rejects.toThrow(
    "Installed app state changed during uninstall review",
  );
  expect(recordPreparationCalls).toHaveLength(1);
  expect(deployCalls).toHaveLength(0);
  expect(operationPhases).not.toContain("staging");
});

test("raw provenance drift during review is rejected before staging", async () => {
  const { result } = await startReviewedUninstall();
  provenanceValue = {
    format: 1,
    apps: {
      mail: {
        kind: "manual",
        acquisition: "file",
        package_digest: "bb".repeat(32),
      },
    },
  };

  resolveAppUninstall(true);

  await expect(result).rejects.toThrow(
    "Installed app state changed during uninstall review",
  );
  expect(recordPreparationCalls).toHaveLength(1);
  expect(deployCalls).toHaveLength(0);
  expect(operationPhases).not.toContain("staging");
  expect(provenanceReads).toEqual([
    "/system/install-provenance.json",
    "/system/install-provenance.json",
  ]);
});

test("certified package evidence drift is rejected before staging", async () => {
  const { result } = await startReviewedUninstall();
  preparedRecordBytes = new Uint8Array([9]);

  resolveAppUninstall(true);

  await expect(result).rejects.toThrow(
    "Installed package evidence changed during uninstall review",
  );
  expect(recordPreparationCalls).toHaveLength(2);
  expect(deployCalls).toHaveLength(0);
  expect(operationPhases).not.toContain("staging");
  expect(provenanceReads).toEqual([
    "/system/install-provenance.json",
    "/system/install-provenance.json",
  ]);
});

test("a changed runtime inventory with the same deployment id is rejected before staging", async () => {
  const { result } = await startReviewedUninstall();
  baselineMismatch = new Error(
    "Installed runtime app inventory changed during uninstall review",
  );

  resolveAppUninstall(true);

  await expect(result).rejects.toThrow(
    "Installed runtime app inventory changed during uninstall review",
  );
  expect(baselineAssertions).toBe(2);
  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toEqual([
    "/system/install-provenance.json",
    "/system/install-provenance.json",
  ]);
  expect(operationPhases).not.toContain("staging");
  expect(useAppsStore.getState()).toMatchObject({
    uninstallRequest: null,
    operation: null,
    operationBusy: false,
    installError: {
      kind: "uninstall",
      message: "Installed runtime app inventory changed during uninstall review",
    },
  });
  expect(resetCalls).toBe(0);
});

test("approval is the only boundary that deploys the reviewed uninstall artifact", async () => {
  const { result } = await startReviewedUninstall();

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toEqual(["/system/install-provenance.json"]);

  resolveAppUninstall(true);
  await deployStarted.promise;

  expect(baselineAssertions).toBe(2);

  expect(provenanceReads).toEqual([
    "/system/install-provenance.json",
    "/system/install-provenance.json",
  ]);
  expect(recordPreparationCalls).toHaveLength(2);
  expect(recordPreparationCalls[1]).toMatchObject({
    targetCanisterId: TARGET_CANISTER_ID,
    packages: [],
    state: compilerState,
    compiled,
    expectedDeploymentId: BASELINE_DEPLOYMENT_ID,
    removedApps: ["mail"],
    provenance: BASELINE_PROVENANCE,
  });
  expect(deployCalls).toHaveLength(1);
  expect(deployCalls[0]).toMatchObject({
    actor,
    targetCanisterId: TARGET_CANISTER_ID,
    packages: [],
    compiled,
    existingApps: compilerState.apps,
    previousModulePaths: ["mo/retained.mo"],
    removedApps: ["mail"],
    deploymentBuildRecord: deploymentRecord,
    expectedDeploymentId: BASELINE_DEPLOYMENT_ID,
  });
  expect(deployCalls[0]?.compiled).toBe(compiled);
  expect(deployCalls[0]?.deploymentBuildRecord).toBe(deploymentRecord);
  expect(operationPhases).toContain("staging");
  expect(deployCalls[0]?.stagedAssets).toHaveLength(1);
  const provenanceAsset = deployCalls[0]?.stagedAssets?.[0];
  expect(provenanceAsset?.target).toBe("/system/install-provenance.json");
  expect(
    JSON.parse(new TextDecoder().decode(provenanceAsset?.content)),
  ).toEqual({ format: 1, apps: {} });

  deployGate.reject(new Error("stop after deployment boundary"));
  await expect(result).rejects.toThrow("stop after deployment boundary");
  expect(useAppsStore.getState()).toMatchObject({
    operation: null,
    operationBusy: false,
    installError: {
      kind: "uninstall",
      message: "stop after deployment boundary",
    },
  });
  expect(resetCalls).toBe(0);
});
