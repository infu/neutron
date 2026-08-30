// This file is launched by manual_install_review_flow.test.ts in a separate
// Bun process. Bun module mocks are process-global and cannot be restored
// safely.
import { beforeEach, expect, mock, test } from "bun:test";
import { hashContent } from "neutron-tools/src/hash.js";
import type {
  CompileResult,
  DeployPreparedPackagesInput,
  KernelPackageState,
  KernelRuntimeInfo,
  PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import type { CompleteDeploymentBuildRecord } from "neutron-compiler/src/deployment_record.js";

const BASELINE_DEPLOYMENT_ID = "11".repeat(16);
const TARGET_DEPLOYMENT_ID = "22".repeat(16);
const TARGET_CANISTER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const APP_ID = "notes";
const CAPABILITY_PLAN_FINGERPRINT = "aa".repeat(32);
const PACKAGE_BYTES = new Uint8Array([1, 3, 3, 7, 9]);
const PACKAGE_DIGEST = hashContent(PACKAGE_BYTES);

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
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
let runtime: KernelRuntimeInfo;
let rawProvenance: unknown;
let compiled: CompileResult;
let preparedPackage: PreparedPackageInstall;
let reviewedRecord: CompleteDeploymentBuildRecord;
let retainedEvidenceRecordBytes: Uint8Array;
let deployGate = deferred<never>();
let deployStarted = deferred<void>();
let deployCalls: DeployPreparedPackagesInput[] = [];
let packageStateReads = 0;
let provenanceReads = 0;
let baselineAssertions = 0;
let filePickerCalls = 0;
let fileReadCalls = 0;
let stagingTransitions = 0;

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

mock.module("neutron-motoko-wasm", () => ({
  disposeMotokoCompiler: async () => undefined,
}));

mock.module("neutron-compiler/src/compile.js", () => ({
  persistenceModeFromCompilerId: () => "classical",
}));

mock.module("neutron-compiler/src/install.js", () => ({
  BROWSER_SURFACE_ORIGINS_PATH: "/system/browser-surface-origins.json",
  appDependencyImpact: () => ({ direct: [], transitive: [] }),
  assertPreparedPackageArchiveIdentity: (value: PreparedPackageInstall) => {
    if (
      !value.archiveBytes ||
      !value.archiveIdentity ||
      value.archiveIdentity.size !== value.archiveBytes.byteLength ||
      value.archiveIdentity.sha256 !== hashContent(value.archiveBytes)
    ) {
      throw new Error("Prepared package archive identity changed after review");
    }
  },
  assertPreparedPackageBatch: () => undefined,
  assertKernelPackageBaselineMatchesRuntime: () => {
    baselineAssertions += 1;
  },
  compileAppsUninstall: () => {
    throw new Error("Unexpected uninstall compilation");
  },
  compilePackages: async () => compiled,
  compilePackageInstall: () => compiled,
  createDeploymentNonce: () => "33".repeat(16),
  deployPreparedPackages: (input: DeployPreparedPackagesInput) => {
    deployCalls.push(input);
    deployStarted.resolve(undefined);
    return deployGate.promise;
  },
  normalizeAppRegistry: (registry: unknown) => registry,
  parseBrowserSurfaceOriginsSidecar: () => [],
  planAppRegistryDependencies: () => ({}),
  preparePackageInstall: () => {
    throw new Error("Unexpected package preparation");
  },
  recoverPendingInstall: async () => ({ status: "none" }),
  readKernelPackageState: async () => {
    packageStateReads += 1;
    return compilerState;
  },
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS: {},
}));

mock.module(
  new URL(
    "../src/install_review/prepare_browser_deployment.ts",
    import.meta.url,
  ).pathname,
  () => ({
    prepareBrowserDeployment: async ({
      packages,
    }: {
      packages: readonly PreparedPackageInstall[];
    }) =>
      Object.freeze({
        prepared: Object.freeze({
          record: reviewedRecord,
          recordBytes: retainedEvidenceRecordBytes.slice(),
          transportWasm: new Uint8Array([2]),
        }),
        review: Object.freeze({
          record: reviewedRecord,
          suppliedPackages: packages,
          retainedPackageRecords: Object.freeze({}),
        }),
      }),
  }),
);

mock.module(
  new URL("../src/install_review/deployment_build_review.ts", import.meta.url)
    .pathname,
  () => ({
    createDeploymentBuildReviewModel: (input: unknown) => input,
  }),
);

mock.module(
  new URL("../src/tools/package_url.ts", import.meta.url).pathname,
  () => ({
    fetchPackageFromUrl: async () => PACKAGE_BYTES,
  }),
);

mock.module(
  new URL("../src/tools/file_picker.ts", import.meta.url).pathname,
  () => ({
    pickFile: async () => {
      filePickerCalls += 1;
      return Object.freeze({ name: "notes.neutron" });
    },
    readFile: async () => {
      fileReadCalls += 1;
      return PACKAGE_BYTES.buffer.slice(0);
    },
  }),
);

mock.module(new URL("../src/tools/app.ts", import.meta.url).pathname, () => ({
  get_app_details: async () => ({
    neutronConfig: {
      id: APP_ID,
      name: "Notes",
      version: 7,
    },
    preparedPackage,
  }),
}));

mock.module(new URL("../src/lib/perm.ts", import.meta.url).pathname, () => ({
  configInstallDisclosures: () => ({
    capabilityDisclosures: [],
    permissions: [],
    appExplanations: [],
    planFingerprint: CAPABILITY_PLAN_FINGERPRINT,
  }),
}));

mock.module(
  new URL("../src/runtime_limits.ts", import.meta.url).pathname,
  () => ({
    MAX_INSTALLED_APP_INSTANCES: 256,
    MAX_RESIDENT_APP_FRAMES: 32,
    assertAppSurfaceInventoryCapacity: () => undefined,
    assertTargetAppSurfaceCapacity: () => undefined,
  }),
);

const actor = {
  kernel_runtime_info: async () => runtime,
};

mock.module(
  new URL("../src/reducer/auth.ts", import.meta.url).pathname,
  () => ({
    getNeutronCan: async () => actor,
    readKernelAssetJson: async (path: string) => {
      if (path === "/system/install-provenance.json") {
        provenanceReads += 1;
        return rawProvenance;
      }
      return undefined;
    },
    readKernelAssetTextIfExists: async () => undefined,
    resetNeutronCan: () => undefined,
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
  appApprove,
  appReject,
  beginPackageInstallSession,
  install_app,
  useAppsStore,
} = await import("../src/reducer/apps.ts");

useAppsStore.subscribe((state) => {
  if (state.operation?.phase === "staging") stagingTransitions += 1;
});

function createCompilerState(stable = "actor {}"): KernelPackageState {
  return Object.freeze({
    registry: Object.freeze({}),
    apps: Object.freeze({}),
    browserSurfaceOriginAppIds: Object.freeze([]),
    browserSurfaceOriginsSidecarPresent: true,
    existingConfigs: Object.freeze({}),
    existingModules: Object.freeze([
      Object.freeze({ path: "mo/retained.mo", content: "module {}" }),
    ]),
    previousStable: stable,
    connectionProviderSupport: Object.freeze({}),
  }) as unknown as KernelPackageState;
}

function createRuntime(
  deploymentId = BASELINE_DEPLOYMENT_ID,
): KernelRuntimeInfo {
  return {
    deployment_id: deploymentId,
    assembler_id: "neutron-assembler/test",
    compiler_id: "moc_classical_test",
    apps: [],
    memories: [],
  };
}

function createPreparedPackage(): PreparedPackageInstall {
  return Object.freeze({
    manifest: Object.freeze({ id: APP_ID, name: "Notes", version: 7 }),
    archiveBytes: PACKAGE_BYTES,
    archiveIdentity: Object.freeze({
      sha256: PACKAGE_DIGEST,
      size: PACKAGE_BYTES.byteLength,
    }),
    capabilityPlan: Object.freeze({}),
    capabilityPlanFingerprint: CAPABILITY_PLAN_FINGERPRINT,
    files: Object.freeze([]),
    appPrefix: "/apps/notes/",
    isKernel: false,
  }) as unknown as PreparedPackageInstall;
}

function createCompiledResult(): CompileResult {
  return Object.freeze({
    wasm: new Uint8Array([0, 97, 115, 109]),
    deploymentId: TARGET_DEPLOYMENT_ID,
  }) as unknown as CompileResult;
}

function createDeploymentRecord(): CompleteDeploymentBuildRecord {
  return Object.freeze({
    format: 1,
    state: "complete",
    deployment_id: TARGET_DEPLOYMENT_ID,
  }) as unknown as CompleteDeploymentBuildRecord;
}

async function waitForReview(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = useAppsStore.getState();
    if (state.request && state.compiled?.deploymentReview) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for manual deployment review");
}

async function startReviewedInstall(
  acquisition: "file" | "url" = "url",
): Promise<{
  result: ReturnType<typeof install_app>;
}> {
  const result = install_app(
    acquisition === "file"
      ? { kind: "file" }
      : {
          kind: "url",
          url: "https://packages.example/notes.neutron",
        },
  );
  await waitForReview();
  return { result };
}

beforeEach(() => {
  appReject(new Error("test reset"));
  compilerState = createCompilerState();
  runtime = createRuntime();
  rawProvenance = Object.freeze({ format: 1, apps: Object.freeze({}) });
  compiled = createCompiledResult();
  preparedPackage = createPreparedPackage();
  reviewedRecord = createDeploymentRecord();
  retainedEvidenceRecordBytes = new Uint8Array([1]);
  deployGate = deferred<never>();
  deployStarted = deferred<void>();
  deployCalls = [];
  packageStateReads = 0;
  provenanceReads = 0;
  baselineAssertions = 0;
  filePickerCalls = 0;
  fileReadCalls = 0;
  stagingTransitions = 0;
  useAppsStore.setState({
    list: {},
    appInstances: {},
    runtimeGenerations: {},
    registryStatus: "ready",
    registryError: null,
    registryUpdatedAt: 1,
    request: null,
    uninstallRequest: null,
    compiled: null,
    operation: null,
    operationBusy: false,
    installError: null,
    pendingInstallRecovery: null,
    runtimeAuthorityFence: null,
  });
});

test("rejecting the final manual review performs no staging or deployment", async () => {
  const { result } = await startReviewedInstall("file");

  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toBe(1);
  expect(filePickerCalls).toBe(1);
  expect(fileReadCalls).toBe(1);
  appReject();

  await expect(result).rejects.toThrow("User rejected");
  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toBe(1);
  expect(stagingTransitions).toBe(0);
  expect(useAppsStore.getState()).toMatchObject({
    request: null,
    compiled: null,
    operation: null,
  });
});

test("runtime drift after review is rejected before provenance staging", async () => {
  const { result } = await startReviewedInstall();
  runtime = createRuntime("44".repeat(16));

  appApprove();
  await expect(result).rejects.toThrow(/changed .*review|another tab/iu);

  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toBeLessThan(3);
  expect(stagingTransitions).toBe(0);
  expect(useAppsStore.getState().operation).toBeNull();
});

test("package-state drift after review is rejected before provenance staging", async () => {
  const { result } = await startReviewedInstall();
  compilerState = createCompilerState("actor { stable let changed : Nat = 1 }");

  appApprove();
  await expect(result).rejects.toThrow(/changed .*review|another tab/iu);

  expect(packageStateReads).toBeGreaterThanOrEqual(2);
  expect(deployCalls).toHaveLength(0);
  expect(provenanceReads).toBeLessThan(3);
  expect(stagingTransitions).toBe(0);
  expect(useAppsStore.getState().operation).toBeNull();
});

test("connection-provider compiler input drift is rejected before provenance staging", async () => {
  const { result } = await startReviewedInstall();
  compilerState = Object.freeze({
    ...compilerState,
    connectionProviderSupport: Object.freeze({
      notes: Object.freeze({ changed_during_review: true }),
    }),
  }) as unknown as KernelPackageState;

  appApprove();
  await expect(result).rejects.toThrow(/changed .*review|another tab/iu);

  expect(packageStateReads).toBeGreaterThanOrEqual(2);
  expect(deployCalls).toHaveLength(0);
  expect(stagingTransitions).toBe(0);
});

test("same-deployment compiler identity drift is rejected before provenance staging", async () => {
  const { result } = await startReviewedInstall();
  runtime = { ...runtime, compiler_id: "moc_classical_changed" };

  appApprove();
  await expect(result).rejects.toThrow(/changed .*review|another tab/iu);

  expect(deployCalls).toHaveLength(0);
  expect(stagingTransitions).toBe(0);
});

test("raw provenance drift after review is rejected before provenance staging", async () => {
  const { result } = await startReviewedInstall();
  rawProvenance = Object.freeze({
    format: 1,
    apps: Object.freeze({
      legacy: Object.freeze({
        kind: "manual",
        acquisition: "file",
        package_digest: "55".repeat(32),
      }),
    }),
  });

  appApprove();
  await expect(result).rejects.toThrow(/changed .*review|another tab/iu);

  expect(provenanceReads).toBe(2);
  expect(deployCalls).toHaveLength(0);
  expect(stagingTransitions).toBe(0);
  expect(useAppsStore.getState().operation).toBeNull();
});

test("approval dispatches the exact record exposed by the final review", async () => {
  const { result } = await startReviewedInstall();
  const review = useAppsStore.getState().compiled!.deploymentReview!;
  expect(review.record).toBe(reviewedRecord);
  expect(deployCalls).toHaveLength(0);

  appApprove();
  await deployStarted.promise;

  expect(baselineAssertions).toBeGreaterThanOrEqual(2);
  expect(provenanceReads).toBe(2);
  expect(deployCalls).toHaveLength(1);
  expect(stagingTransitions).toBe(1);
  expect(deployCalls[0]?.deploymentBuildRecord).toBe(review.record);
  expect(deployCalls[0]?.compiled).toBe(compiled);
  expect(deployCalls[0]?.packages[0]).toBe(preparedPackage);
  expect(deployCalls[0]?.existingBrowserSurfaceOriginAppIds).toBe(
    compilerState.browserSurfaceOriginAppIds,
  );
  expect(deployCalls[0]?.stagedAssets).toHaveLength(1);

  deployGate.reject(new Error("stop after deployment boundary"));
  await expect(result).rejects.toThrow("stop after deployment boundary");
});

test("package session rejects retained legal-record evidence drift before staging", async () => {
  const session = await beginPackageInstallSession({ mode: "setup" });
  const sessionCompiled = await session.compile([preparedPackage]);
  const deployment = session.getPreparedDeployment(
    [preparedPackage],
    sessionCompiled,
  );

  // State, runtime, and provenance stay fixed; only the freshly loaded
  // installed legal-record evidence changes after review.
  retainedEvidenceRecordBytes = new Uint8Array([9]);

  await expect(
    session.deploy({
      packages: [preparedPackage],
      compiled: sessionCompiled,
      deploymentBuildRecord: deployment.prepared.record,
      provenance: {
        [APP_ID]: {
          kind: "manual",
          acquisition: "url",
          package_digest: PACKAGE_DIGEST,
        },
      },
    }),
  ).rejects.toThrow("Installed package evidence changed during review");

  expect(deployCalls).toHaveLength(0);
  expect(stagingTransitions).toBe(0);
  expect(useAppsStore.getState().operation).toBeNull();
});

test("package session dispatches the exact reviewed record after evidence identity", async () => {
  const session = await beginPackageInstallSession({ mode: "setup" });
  const sessionCompiled = await session.compile([preparedPackage]);
  const deployment = session.getPreparedDeployment(
    [preparedPackage],
    sessionCompiled,
  );

  const result = session.deploy({
    packages: [preparedPackage],
    compiled: sessionCompiled,
    deploymentBuildRecord: deployment.prepared.record,
    provenance: {
      [APP_ID]: {
        kind: "manual",
        acquisition: "url",
        package_digest: PACKAGE_DIGEST,
      },
    },
  });
  await deployStarted.promise;

  expect(deployCalls).toHaveLength(1);
  expect(stagingTransitions).toBe(1);
  expect(deployCalls[0]?.deploymentBuildRecord).toBe(
    deployment.prepared.record,
  );
  expect(deployCalls[0]?.existingBrowserSurfaceOriginAppIds).toBe(
    compilerState.browserSurfaceOriginAppIds,
  );

  deployGate.reject(new Error("stop after package-session dispatch boundary"));
  await expect(result).rejects.toThrow(
    "stop after package-session dispatch boundary",
  );
});
