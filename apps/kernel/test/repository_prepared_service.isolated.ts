// Module mocks are process-global, so repository_prepared_service.test.ts runs
// this fixture in a separate Bun process.
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { gzipSync } from "fflate";
import type { CompleteDeploymentBuildRecord } from "neutron-compiler/src/deployment_record.js";
import type { PreparedBrowserDeployment } from "../src/install_review/prepare_browser_deployment.ts";
import msgpack from "tiny-msgpack";
import {
  preparePackageInstall,
  type CompileResult,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import {
  readPendingRepositorySetup,
  type RepositorySetupReference,
  type RepositoryStorage,
} from "neutron-tools/repository";
import { hashContent } from "neutron-tools/src/hash.js";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import type { AttestedInstallOfferRequester } from "../src/install_offers/types.ts";
import type { RepositoryClientOptions } from "../src/repository/client.ts";
import type { RepositoryPreparedAccess } from "../src/repository_access/client.ts";
import { registryApp, runtimeApp } from "./app_registry_fixture.ts";

const NOW = 1_800_000_000_000;
const reference: RepositorySetupReference = {
  repo: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  manifest: "prepared-suite",
  digest: "a".repeat(64),
};
const requester: AttestedInstallOfferRequester = {
  kind: "app",
  appId: "catalog_app",
  appName: "Catalog App",
  surface: "tile",
};
const bearer = "private-download-credential-never-persist";
const privateAccess: RepositoryPreparedAccess = {
  source: reference.repo,
  token: bearer,
  paths: ["/repo/manifests/prepared-suite.json", "/repo/packages/provider.neutron"],
};

class MemoryStorage implements RepositoryStorage {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
    this.writes.push(value);
  }
  removeItem(key: string): void { this.values.delete(key); }
}

type PackageFixture = ReturnType<typeof packageFixture>;
type DeployInput = {
  packages: readonly PreparedPackageInstall[];
  compiled: CompileResult;
  deploymentBuildRecord: object;
  provenance: Record<string, object>;
};

const storage = new MemoryStorage();
let packages: PackageFixture[] = [];
let installedManifests: PackagedNeutronManifest[] = [];
let loadCalls: Array<{ reference: RepositorySetupReference; options: RepositoryClientOptions }> = [];
let compileCalls: Array<readonly PreparedPackageInstall[]> = [];
let deployCalls: DeployInput[] = [];
let decodedPackages: PreparedPackageInstall[] = [];
let canceledSessions = 0;
let failedLoads = 0;
let loadGate: ReturnType<typeof deferred> | null = null;
let compileGate: ReturnType<typeof deferred> | null = null;
let deploymentByCompiled = new Map<CompileResult, ReturnType<typeof preparedDeployment>>();
let stateHistory: string[] = [];

const originalNow = Date.now;
const originalAnimationFrame = globalThis.requestAnimationFrame;
Date.now = () => NOW;
globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  callback(0);
  return 1;
}) as typeof requestAnimationFrame;

mock.module(new URL("../src/bootstrap.ts", import.meta.url).pathname, () => ({ kernelSetupStorage: storage }));
mock.module(new URL("../src/reducer/apps.ts", import.meta.url).pathname, () => ({
  beginRepositoryInstallSession: async () => {
    let canceled = false;
    const registry = Object.fromEntries(installedManifests.map((manifest) => [manifest.id, registryApp(manifest)]));
    return {
      baseline: {
        state: {
          apps: registry,
          existingConfigs: Object.fromEntries(installedManifests.map((manifest) => [manifest.id, manifest])),
        },
        runtime: {
          deployment_id: "deployment", assembler_id: "assembler", compiler_id: "compiler", memories: [],
          apps: installedManifests.map((manifest, index) => runtimeApp({
            id: manifest.id, version: manifest.version, entry: registry[manifest.id]!, installationUid: index + 1,
          })),
        },
      },
      compile: async (selected: readonly PreparedPackageInstall[]) => {
        if (canceled) throw new Error("Session canceled");
        compileCalls.push([...selected]);
        const compiled = Object.freeze({ wasm: new Uint8Array([compileCalls.length]) }) as CompileResult;
        deploymentByCompiled.set(compiled, preparedDeployment(selected));
        if (compileGate) await compileGate.promise;
        return compiled;
      },
      getPreparedDeployment: (selected: readonly PreparedPackageInstall[], compiled: CompileResult) => {
        if (canceled) throw new Error("Session canceled");
        const deployment = deploymentByCompiled.get(compiled);
        if (!deployment || selected.some((pkg, index) => pkg !== deployment.review.suppliedPackages[index])) {
          throw new Error("The review does not match the compiled packages");
        }
        return deployment;
      },
      deploy: async (input: DeployInput) => {
        if (canceled) throw new Error("Session canceled");
        const deployment = deploymentByCompiled.get(input.compiled);
        if (input.deploymentBuildRecord !== deployment?.prepared.record) {
          throw new Error("Only the reviewed deployment may be installed");
        }
        deployCalls.push(input);
      },
      cancel: () => { if (!canceled) canceledSessions += 1; canceled = true; },
    };
  },
}));
mock.module(new URL("../src/repository/client.ts", import.meta.url).pathname, () => ({
  loadRepositorySetupBytes: async (ref: RepositorySetupReference, options: RepositoryClientOptions) => {
    loadCalls.push({ reference: { ...ref }, options });
    if (loadGate) await loadGate.promise;
    if (failedLoads > 0) { failedLoads -= 1; throw new Error("Temporary certified download failure"); }
    return {
      info: { name: "Prepared repository", provider: { name: "Unverified provider" } },
      manifest: { id: reference.manifest, name: "Prepared suite", revision: 1, packages: packages.map(({ metadata }) => metadata) },
      manifestBytes: new Uint8Array([1]),
      packages: packages.map(({ metadata, bytes }) => ({ metadata, bytes })),
    };
  },
}));
mock.module(new URL("../src/tools/app.ts", import.meta.url).pathname, () => ({
  get_app_details: async (_neutron: unknown, bytes: Uint8Array, options: { expectedIdentity: object }) => {
    // Decode real package archives; preserve the exact manifest/capability and
    // archive identity checks performed by the service under test.
    const preparedPackage = preparePackageInstall(bytes);
    expect(options.expectedIdentity).toEqual({
      id: preparedPackage.manifest.id,
      version: preparedPackage.manifest.version,
      ...preparedPackage.archiveIdentity,
    });
    decodedPackages.push(preparedPackage);
    return { neutronConfig: preparedPackage.manifest, preparedPackage };
  },
}));

const [service, { useRepositorySetupStore }] = await Promise.all([
  import("../src/repository/service.ts"),
  import("../src/repository/store.ts"),
]);
const unsubscribe = useRepositorySetupStore.subscribe((state) => stateHistory.push(JSON.stringify(state)));

beforeEach(async () => {
  await service.dismissRepositorySetup();
  storage.values.clear();
  storage.writes.length = 0;
  packages = [packageFixture("provider"), packageFixture("consumer", {
    provider: { app: "provider", min_version: 100, functions: ["read"] },
  }), packageFixture("unrelated")];
  installedManifests = [];
  loadCalls = [];
  compileCalls = [];
  deployCalls = [];
  decodedPackages = [];
  canceledSessions = 0;
  failedLoads = 0;
  loadGate = null;
  compileGate = null;
  deploymentByCompiled = new Map();
  stateHistory = [];
});
afterEach(async () => {
  await service.dismissRepositorySetup();
  loadGate?.resolve();
  compileGate?.resolve();
  await Promise.resolve();
});
afterAll(() => {
  unsubscribe();
  Date.now = originalNow;
  globalThis.requestAnimationFrame = originalAnimationFrame;
});

test("prepared roots and dependencies compile directly to the final review without deploying", async () => {
  loadGate = deferred();
  const roots = ["consumer"];
  const mutableRequester = { ...requester };
  service.startPreparedRepositorySetup(reference, mutableRequester, roots, privateAccess);
  roots.push("unrelated");
  mutableRequester.appName = "Changed caller claim";
  loadGate.resolve();
  await phase("review");

  const state = useRepositorySetupStore.getState();
  expect(state.rootIds).toEqual(["consumer"]);
  expect([...state.selection!.selected].sort()).toEqual(["consumer", "provider"]);
  expect([...state.selection!.automatic]).toEqual(["provider"]);
  expect(state.offeredBy).toEqual(requester);
  expect(state.prepared).toBe(true);
  expect(compileCalls).toHaveLength(1);
  expect(compileCalls[0]!.map(({ manifest }) => manifest.id).sort()).toEqual(["consumer", "provider"]);
  expect(decodedPackages).toHaveLength(3);
  expect(state.deploymentReview).toBe([...deploymentByCompiled.values()][0]!.review);
  expect(deployCalls).toEqual([]);
});

test("one explicit final approval deploys the exact reviewed group once and excludes bearer from stored state and provenance", async () => {
  service.startPreparedRepositorySetup(reference, requester, ["consumer"], privateAccess);
  await phase("review");
  expect(deployCalls).toEqual([]);
  expect(readPendingRepositorySetup(storage, NOW)).toBeNull();
  expect(storage.writes).toEqual([]);

  await Promise.all([service.installRepositorySelection(), service.installRepositorySelection()]);
  expect(useRepositorySetupStore.getState().phase).toBe("success");
  expect(deployCalls).toHaveLength(1);
  expect(deployCalls[0]!.packages).toEqual(compileCalls[0]!);
  expect(deployCalls[0]!.deploymentBuildRecord).toBe([...deploymentByCompiled.values()][0]!.prepared.record);
  expect(Object.keys(deployCalls[0]!.provenance).sort()).toEqual(["consumer", "provider"]);
  expect(deployCalls[0]!.provenance.consumer).toEqual({
    kind: "repository", repository: reference.repo, manifest_id: reference.manifest,
    manifest_digest: reference.digest, package_digest: packages[1]!.metadata.sha256,
  });
  expect(readPendingRepositorySetup(storage, NOW)).toBeNull();
  expect(JSON.stringify(storage.writes)).not.toContain(bearer);
  expect(JSON.stringify(stateHistory)).not.toContain(bearer);
  expect(JSON.stringify(deployCalls[0]!.provenance)).not.toContain(bearer);
  expect(loadCalls[0]!.options.preparedAccess?.token).toBe(bearer);
});

test("canceling final review installs nothing and clears the private handoff for the next setup", async () => {
  service.startPreparedRepositorySetup(reference, requester, ["consumer"], privateAccess);
  await phase("review");
  const aborted = loadCalls[0]!.options.signal;
  await service.dismissRepositorySetup();
  await service.installRepositorySelection();
  expect(useRepositorySetupStore.getState().phase).toBe("idle");
  expect(deployCalls).toEqual([]);
  expect(canceledSessions).toBe(1);
  expect(readPendingRepositorySetup(storage, NOW)).toBeNull();

  service.startPreparedRepositorySetup(reference, requester, ["unrelated"]);
  await phase("review");
  expect(loadCalls[1]!.options.preparedAccess).toBeUndefined();
  expect(loadCalls[1]!.options.approvedAccess).toEqual([]);
  expect(compileCalls[1]!.map(({ manifest }) => manifest.id)).toEqual(["unrelated"]);
  expect(deployCalls).toEqual([]);
  // The first download has finished; cancellation still closes its install
  // session without affecting the next session's independent signal.
  expect(loadCalls[1]!.options.signal).not.toBe(aborted);
});

test("canceling during compilation cannot later resurrect a review or deploy", async () => {
  compileGate = deferred();
  service.startPreparedRepositorySetup(reference, requester, ["consumer"], privateAccess);
  await phase("compiling");
  await service.dismissRepositorySetup();
  compileGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await service.installRepositorySelection();
  expect(useRepositorySetupStore.getState().phase).toBe("idle");
  expect(deployCalls).toEqual([]);
  expect(canceledSessions).toBe(1);
});

test("a private download retry retains exact access without asking Kernel to buy a new grant", async () => {
  failedLoads = 1;
  const mutableAccess = { ...privateAccess, paths: [...privateAccess.paths] };
  service.startPreparedRepositorySetup(reference, requester, ["consumer"], mutableAccess);
  mutableAccess.token = "different-token";
  mutableAccess.paths.push("/repo/packages/different.neutron");
  await phase("error");
  expect(useRepositorySetupStore.getState().errorStage).toBe("load");
  expect(compileCalls).toEqual([]);

  await service.retryRepositorySetup("load", {
    approvedAccess: [{ source: reference.repo, descriptor: { protocol: "neutron-repo-access-v1", fee_version: "1", cycles: "250000000" } }],
  });
  expect(useRepositorySetupStore.getState().phase).toBe("review");
  expect(loadCalls).toHaveLength(2);
  for (const { options } of loadCalls) {
    expect(options.preparedAccess).toEqual(privateAccess);
    expect(options.approvedAccess).toEqual([]);
    expect(Object.isFrozen(options.preparedAccess)).toBe(true);
    expect(Object.isFrozen(options.preparedAccess!.paths)).toBe(true);
  }
  expect(compileCalls).toHaveLength(1);
  expect(deployCalls).toEqual([]);
  expect(JSON.stringify(storage.writes)).not.toContain(bearer);
  expect(JSON.stringify(stateHistory)).not.toContain(bearer);
});

test("a root absent from the verified manifest never compiles or deploys", async () => {
  service.startPreparedRepositorySetup(reference, requester, ["unadvertised"], privateAccess);
  await phase("error");
  expect(useRepositorySetupStore.getState()).toMatchObject({
    errorStage: "load", error: "The prepared app selection differs from its verified repository manifest.",
  });
  expect(compileCalls).toEqual([]);
  expect(deployCalls).toEqual([]);
  expect(canceledSessions).toBe(1);
});

test("ordinary repository offers retain their app selection step and supplied cost approval", async () => {
  const approvals = [{ source: reference.repo, descriptor: { protocol: "neutron-repo-access-v1" as const, fee_version: "1", cycles: "250000000" } }];
  service.startRepositorySetupFromOffer(reference, requester, approvals);
  await phase("selecting");
  expect(useRepositorySetupStore.getState().prepared).toBe(false);
  expect(useRepositorySetupStore.getState().rootIds).toEqual([]);
  expect(loadCalls[0]!.options.approvedAccess).toEqual(approvals);
  expect(loadCalls[0]!.options.preparedAccess).toBeUndefined();
  expect(compileCalls).toEqual([]);
  expect(deployCalls).toEqual([]);
});

test("already-installed requested apps finish without offering unrelated optional packages", async () => {
  installedManifests = packages.slice(0, 2).map(({ bytes }) => preparePackageInstall(bytes).manifest);
  service.startPreparedRepositorySetup(reference, requester, ["consumer"], privateAccess);
  await phase("nothing");
  const state = useRepositorySetupStore.getState();
  expect(state.rootIds).toEqual(["consumer"]);
  expect(state.selection!.selected.size).toBe(0);
  expect(state.selection!.blockers).toEqual([]);
  expect(state.loaded?.reconciliation.consumer).toMatchObject({ installed: true, consistent: true });
  expect(state.loaded?.reconciliation.unrelated?.installed).toBe(false);
  expect(state.deploymentReview).toBeNull();
  expect(canceledSessions).toBe(1);
  service.selectAllRepositoryPackages(true);
  service.toggleRepositoryPackage("unrelated");
  await service.reviewRepositorySelection();
  await service.installRepositorySelection();
  expect(useRepositorySetupStore.getState().phase).toBe("nothing");
  expect(useRepositorySetupStore.getState().selection!.selected.size).toBe(0);
  expect(compileCalls).toEqual([]);
  expect(deployCalls).toEqual([]);
  await service.finishRepositorySetup();
  expect(useRepositorySetupStore.getState().phase).toBe("idle");
});

test("an ordinary offer with all apps installed retains the existing nothing-to-install review state", async () => {
  installedManifests = packages.map(({ bytes }) => preparePackageInstall(bytes).manifest);
  service.startRepositorySetupFromOffer(reference, requester);
  await phase("selecting");
  const state = useRepositorySetupStore.getState();
  expect(state.prepared).toBe(false);
  expect(state.selection!.selected.size).toBe(0);
  // RepositoryReview renders its existing Nothing to install/Done branch for
  // this state: every verified package reconciles to an installed app.
  expect(state.loaded!.packages.filter(({ id }) => !state.loaded!.reconciliation[id]?.installed)).toEqual([]);
  expect(canceledSessions).toBe(1);
  await service.reviewRepositorySelection();
  await service.installRepositorySelection();
  expect(compileCalls).toEqual([]);
  expect(deployCalls).toEqual([]);
  await service.finishRepositorySetup();
  expect(useRepositorySetupStore.getState().phase).toBe("idle");
});

test("a missing dependency reports the unavailable app without compiling or deploying", async () => {
  packages = [packages[1]!, packages[2]!];
  service.startPreparedRepositorySetup(reference, requester, ["consumer"]);
  await phase("error");
  expect(useRepositorySetupStore.getState().errorStage).toBe("load");
  expect(useRepositorySetupStore.getState().error).toContain("Provider");
  expect(useRepositorySetupStore.getState().error).toContain("not installed");
  expect(compileCalls).toEqual([]);
  expect(deployCalls).toEqual([]);
  expect(canceledSessions).toBe(1);
});

test("an older installed dependency is a clear prepared-setup error, never an implicit upgrade", async () => {
  installedManifests = [preparePackageInstall(packages[0]!.bytes).manifest];
  packages = [packageFixture("provider", undefined, 101), packageFixture("consumer", {
    provider: { app: "provider", min_version: 101, functions: ["read"] },
  }), packages[2]!];
  service.startPreparedRepositorySetup(reference, requester, ["consumer"]);
  await phase("error");
  const state = useRepositorySetupStore.getState();
  expect(state.errorStage).toBe("load");
  expect(state.error).toContain("requires provider v0.1.1 or newer");
  expect(state.error).toContain("v0.1.0 is installed");
  expect(state.loaded?.reconciliation.provider).toMatchObject({ installed: true, consistent: true, version: 100 });
  expect(compileCalls).toEqual([]);
  expect(deployCalls).toEqual([]);
  expect(canceledSessions).toBe(1);
});

function packageFixture(id: string, dependencies?: PackagedNeutronManifest["dependencies"], version = 100) {
  const moduleBytes = new TextEncoder().encode(`module { public let name = "${id}" }`);
  const entry = hashContent(moduleBytes);
  const manifest: PackagedNeutronManifest = {
    format: 3, entry, id, name: id, version,
    func: { read: { type: "internal", async: "async*", expose: "apps" } },
    ...(dependencies ? { dependencies } : {}),
  };
  const bytes = msgpack.encode({
    "neutron.json": gzipSync(new TextEncoder().encode(JSON.stringify(manifest))),
    [`mo/${entry}.mo`]: gzipSync(moduleBytes),
  });
  const prepared = preparePackageInstall(bytes);
  expect(prepared.capabilityPlanFingerprint).toBe(registryApp(manifest).capability_plan_fingerprint);
  return { metadata: { id, version, sha256: hashContent(bytes), size: bytes.byteLength }, bytes };
}

function preparedDeployment(selected: readonly PreparedPackageInstall[]): PreparedBrowserDeployment {
  const record = Object.freeze({ format: 1, state: "complete", marker: "reviewed-deployment" }) as unknown as CompleteDeploymentBuildRecord;
  return Object.freeze({
    prepared: Object.freeze({ record, recordBytes: new Uint8Array([1]), transportWasm: new Uint8Array([1]) }),
    review: Object.freeze({ record, suppliedPackages: Object.freeze([...selected]), retainedPackageRecords: Object.freeze({}) }),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function phase(expected: string): Promise<void> {
  if (useRepositorySetupStore.getState().phase === expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      const state = useRepositorySetupStore.getState();
      reject(new Error(`Expected ${expected}, got ${state.phase}: ${state.error ?? "no error"}`));
    }, 2_000);
    const stop = useRepositorySetupStore.subscribe((state) => {
      if (state.phase === expected) { clearTimeout(timeout); stop(); resolve(); }
    });
  });
}
