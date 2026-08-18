// This file runs in a child Bun process because its module mocks are global.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { gzipSync } from "fflate";
import msgpack from "tiny-msgpack";
import type {
  CompleteDeploymentBuildRecord,
  PreparedCompleteDeploymentBuild,
} from "neutron-compiler/src/deployment_record.js";
import {
  KERNEL_INSTALL_MAX_COPIES,
  preparePackageInstall,
  type CompileResult,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import {
  stagePendingRepositorySetup,
  type RepositorySetupReference,
  type RepositoryStorage,
} from "neutron-tools/repository";
import { hashContent } from "neutron-tools/src/hash.js";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";

const FIXED_NOW = 1_800_000_000_000;
const reference: RepositorySetupReference = {
  repo: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  manifest: "review-suite",
  digest: "a".repeat(64),
};

class MemoryStorage implements RepositoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

type PackageFixture = Readonly<{
  metadata: Readonly<{
    id: string;
    version: number;
    sha256: string;
    size: number;
  }>;
  bytes: Uint8Array;
  details: Readonly<{
    files: PreparedPackageInstall["files"];
    lib: readonly [];
    neutronConfig: PackagedNeutronManifest;
    preparedPackage: PreparedPackageInstall;
  }>;
}>;

type DeployInput = Readonly<{
  packages: readonly PreparedPackageInstall[];
  compiled: CompileResult;
  deploymentBuildRecord: object;
  provenance: Readonly<Record<string, { package_digest: string }>>;
}>;

type FakePreparedDeployment = Readonly<{
  prepared: PreparedCompleteDeploymentBuild;
  review: Readonly<{
    record: CompleteDeploymentBuildRecord;
    suppliedPackages: readonly PreparedPackageInstall[];
    retainedPackageRecords: Readonly<Record<string, never>>;
  }>;
}>;

const storage = new MemoryStorage();
let fetchedSetup: unknown = null;
let detailsByDigest = new Map<string, PackageFixture["details"]>();
let capabilityFingerprintById = new Map<string, string>();
let compileCalls: (readonly PreparedPackageInstall[])[] = [];
let preparedCalls: Array<{
  packages: readonly PreparedPackageInstall[];
  compiled: CompileResult;
  deployment: FakePreparedDeployment;
}> = [];
let deployCalls: DeployInput[] = [];
let preparedByCompiled = new Map<CompileResult, FakePreparedDeployment>();

const originalNow = Date.now;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
Date.now = () => FIXED_NOW;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  callback(0);
  return 1;
}) as typeof requestAnimationFrame;

mock.module(new URL("../src/bootstrap.ts", import.meta.url).pathname, () => ({
  kernelSetupStorage: storage,
}));

mock.module(new URL("../src/lib/perm.ts", import.meta.url).pathname, () => ({
  configInstallDisclosures: (manifest: PackagedNeutronManifest) => {
    const planFingerprint = capabilityFingerprintById.get(manifest.id);
    if (!planFingerprint) {
      throw new Error(`Missing capability fingerprint for ${manifest.id}`);
    }
    return {
      appExplanations: [],
      capabilityDisclosures: [],
      permissions: [],
      planFingerprint,
    };
  },
}));

mock.module(
  new URL("../src/reducer/apps.ts", import.meta.url).pathname,
  () => ({
    beginRepositoryInstallSession: async () => ({
      baseline: {
        state: { apps: {}, existingConfigs: {} },
        runtime: {
          deployment_id: "deployment",
          assembler_id: "assembler",
          compiler_id: "compiler",
          apps: [],
          memories: [],
        },
      },
      compile: async (packages: readonly PreparedPackageInstall[]) => {
        compileCalls.push(Object.freeze([...packages]));
        return Object.freeze({
          wasm: new Uint8Array([compileCalls.length]),
        }) as CompileResult;
      },
      getPreparedDeployment: (
        packages: readonly PreparedPackageInstall[],
        compiled: CompileResult,
      ) => {
        const deployment = fakePreparedDeployment(packages, preparedCalls.length + 1);
        preparedCalls.push({
          packages: Object.freeze([...packages]),
          compiled,
          deployment,
        });
        preparedByCompiled.set(compiled, deployment);
        return deployment;
      },
      deploy: async (input: DeployInput) => {
        const prepared = preparedByCompiled.get(input.compiled);
        if (!prepared || prepared.prepared.record !== input.deploymentBuildRecord) {
          throw new Error("Unexpected unreviewed deployment record");
        }
        deployCalls.push(input);
        return {};
      },
      cancel: () => undefined,
    }),
  }),
);

mock.module(
  new URL("../src/repository/client.ts", import.meta.url).pathname,
  () => ({
    loadRepositorySetupBytes: async () => {
      if (!fetchedSetup) throw new Error("Repository fixture was not prepared");
      return fetchedSetup;
    },
  }),
);

mock.module(new URL("../src/tools/app.ts", import.meta.url).pathname, () => ({
  get_app_details: async (_neutron: unknown, bytes: Uint8Array) => {
    const details = detailsByDigest.get(hashContent(bytes));
    if (!details) throw new Error("Unexpected repository package bytes");
    return details;
  },
}));

const [service, { repositorySetupState, useRepositorySetupStore }] =
  await Promise.all([
    import("../src/repository/service.ts"),
    import("../src/repository/store.ts"),
  ]);

beforeEach(async () => {
  await service.dismissRepositorySetup();
  storage.values.clear();
  fetchedSetup = null;
  detailsByDigest = new Map();
  capabilityFingerprintById = new Map();
  compileCalls = [];
  preparedCalls = [];
  deployCalls = [];
  preparedByCompiled = new Map();
});

afterEach(async () => {
  await service.dismissRepositorySetup();
  storage.values.clear();
});

afterAll(() => {
  Date.now = originalNow;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
});

test("reviews selected exact archives before dispatch and deploys the same record", async () => {
  const base = packageFixture("base_app");
  const uses = packageFixture("uses_app", {
    base: {
      app: "base_app",
      min_version: 100,
      functions: ["read"],
    },
  });
  const other = packageFixture("other_app");
  await loadFixture([base, uses, other]);

  service.toggleRepositoryPackage("uses_app");
  expect(
    [...useRepositorySetupStore.getState().selection!.selected].sort(),
  ).toEqual(["base_app", "uses_app"]);

  await service.reviewRepositorySelection();
  const firstReview = useRepositorySetupStore.getState().deploymentReview!;
  expect(useRepositorySetupStore.getState().phase).toBe("review");
  expect(compileCalls).toHaveLength(1);
  expect(
    firstReview.suppliedPackages.map(({ manifest }) => manifest.id),
  ).toEqual(["base_app", "uses_app"]);
  expect(deployCalls).toEqual([]);

  service.backToRepositorySelection();
  expect(useRepositorySetupStore.getState().deploymentReview).toBeNull();
  await service.installRepositorySelection();
  expect(deployCalls).toEqual([]);

  await service.reviewRepositorySelection();
  const secondReview = useRepositorySetupStore.getState().deploymentReview!;
  expect(secondReview).not.toBe(firstReview);
  expect(compileCalls).toHaveLength(2);
  expect(preparedCalls).toHaveLength(2);

  await service.installRepositorySelection();
  expect(deployCalls).toHaveLength(1);
  const deployed = deployCalls[0]!;
  expect(deployed.deploymentBuildRecord).toBe(secondReview.record);
  expect(deployed.packages.map(({ manifest }) => manifest.id)).toEqual([
    "base_app",
    "uses_app",
  ]);
  expect(Object.keys(deployed.provenance).sort()).toEqual([
    "base_app",
    "uses_app",
  ]);
  for (const preparedPackage of deployed.packages) {
    expect(
      deployed.provenance[preparedPackage.manifest.id]?.package_digest,
    ).toBe(preparedPackage.archiveIdentity?.sha256);
  }
  expect(useRepositorySetupStore.getState().phase).toBe("success");
  expect(useRepositorySetupStore.getState().deploymentReview).toBeNull();
});

test("copy preflight reserves the fifth fixed slot for the build record", async () => {
  const fileCount = KERNEL_INSTALL_MAX_COPIES - 4;
  const large = packageFixture("large_app", undefined, fileCount);
  await loadFixture([large]);
  service.toggleRepositoryPackage("large_app");

  await service.reviewRepositorySelection();

  expect(compileCalls).toEqual([]);
  expect(useRepositorySetupStore.getState()).toMatchObject({
    phase: "error",
    errorStage: "compile",
    error: `Selected applications require ${KERNEL_INSTALL_MAX_COPIES + 1} asset copies; this kernel supports ${KERNEL_INSTALL_MAX_COPIES}`,
    deploymentReview: null,
  });
});

async function loadFixture(packages: readonly PackageFixture[]): Promise<void> {
  detailsByDigest = new Map(
    packages.map(({ metadata, details }) => [metadata.sha256, details]),
  );
  fetchedSetup = Object.freeze({
    info: Object.freeze({
      name: "Review repository",
      provider: Object.freeze({ name: "Unverified provider" }),
    }),
    manifest: Object.freeze({
      id: reference.manifest,
      name: "Review suite",
      revision: 1,
      packages: Object.freeze(packages.map(({ metadata }) => metadata)),
    }),
    manifestBytes: new Uint8Array([1]),
    packages: Object.freeze(
      packages.map(({ metadata, bytes }) =>
        Object.freeze({ metadata, bytes }),
      ),
    ),
  });
  stagePendingRepositorySetup(storage, reference, FIXED_NOW);
  repositorySetupState.pending(reference);
  await service.loadRepositorySetup();
  const state = useRepositorySetupStore.getState();
  expect(state.phase, state.error ?? undefined).toBe("selecting");
}

function packageFixture(
  id: string,
  dependencies?: PackagedNeutronManifest["dependencies"],
  fileCount = 0,
): PackageFixture {
  const version = 100;
  const moduleContent = new TextEncoder().encode(
    `module { public let package_id = "${id}" }`,
  );
  const entry = hashContent(moduleContent);
  const manifest: PackagedNeutronManifest = {
    format: 3,
    entry,
    id,
    name: id.replaceAll("_", " "),
    version,
    func: {
      read: { type: "internal", async: "async*", expose: "apps" },
    },
    ...(dependencies ? { dependencies } : {}),
  };
  const requestedMutableFiles = Math.max(1, fileCount);
  const unpacked = Object.fromEntries([
    ["neutron.json", new TextEncoder().encode(JSON.stringify(manifest))],
    [`mo/${entry}.mo`, moduleContent],
    ...Array.from({ length: requestedMutableFiles - 1 }, (_, index) => [
      `asset-${index}.txt`,
      new Uint8Array(),
    ] as const),
  ]);
  const bytes = msgpack.encode(
    Object.fromEntries(
      Object.entries(unpacked).map(([path, content]) => [
        path,
        gzipSync(content),
      ]),
    ),
  );
  const preparedPackage = preparePackageInstall(bytes);
  const archiveIdentity = preparedPackage.archiveIdentity;
  if (!archiveIdentity) {
    throw new Error(`Prepared repository fixture ${id} lost archive identity`);
  }
  capabilityFingerprintById.set(
    id,
    preparedPackage.capabilityPlanFingerprint,
  );
  return Object.freeze({
    metadata: Object.freeze({
      id,
      version,
      sha256: archiveIdentity.sha256,
      size: archiveIdentity.size,
    }),
    bytes,
    details: Object.freeze({
      files: preparedPackage.files,
      lib: [] as const,
      neutronConfig: preparedPackage.manifest,
      preparedPackage,
    }),
  });
}

function fakePreparedDeployment(
  packages: readonly PreparedPackageInstall[],
  attempt: number,
): FakePreparedDeployment {
  const record = Object.freeze({
    format: 1,
    state: "complete",
    deployment: Object.freeze({
      target_canister_id: "aaaaa-aa",
      deployment_id: `deployment-${attempt}`,
    }),
    packages: Object.freeze([]),
    memories: Object.freeze([]),
    permissions: Object.freeze([]),
    diagnostics: Object.freeze({}),
    warnings: Object.freeze({}),
  }) as unknown as CompleteDeploymentBuildRecord;
  const review = Object.freeze({
    record,
    suppliedPackages: Object.freeze([...packages]),
    retainedPackageRecords: Object.freeze({}),
  });
  return Object.freeze({
    prepared: Object.freeze({
      record,
      recordBytes: new Uint8Array([attempt]),
      transportWasm: new Uint8Array([attempt]),
    }),
    review,
  });
}
