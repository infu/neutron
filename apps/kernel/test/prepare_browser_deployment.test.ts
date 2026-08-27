import { describe, expect, test } from "bun:test";
import {
  canonicalDeploymentBuildRecordJson,
  deploymentBuildRecordSha256,
  parseDeploymentBuildRecord,
  prepareDeterministicWasmTransport,
  type CompleteDeploymentBuildRecord,
  type DeploymentPackageArchiveRecord,
  type PackageInformationRecordIdentity,
} from "neutron-compiler/src/deployment_record.js";
import {
  appRegistryEntry,
  type AppRegistry,
  type CompileResult,
  type KernelPackageState,
  type KernelRuntimeInfo,
} from "neutron-compiler/src/install.js";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import {
  parseNeutronPackageRecordStructure,
  type NeutronPackageRecordV1,
} from "neutron-tools/package_record.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { prepareBrowserDeployment } from "../src/install_review/prepare_browser_deployment.ts";
import type { InstallProvenance } from "../src/repository/provenance.ts";
import {
  DEPLOYMENT_BUILD_RECORD_PATH,
  deploymentRecordExpectedModuleHash,
  type InstalledDeploymentBuildRecordInspection,
} from "../src/settings/deployment_build_record.ts";
import type {
  InstalledPackageRecordInspection,
  InstalledPackageRecordInventory,
} from "../src/settings/installed_package_record.ts";

const TARGET_CANISTER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const OTHER_CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const CURRENT_DEPLOYMENT = "a".repeat(32);
const NEXT_DEPLOYMENT = "b".repeat(32);
const CURRENT_COMPILER = "moc_fixture_current";
const CURRENT_ASSEMBLER = "neutron_actor_v25";
const WASM = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);

describe("prepareBrowserDeployment retained evidence", () => {
  test("missing legacy records remain explicit and provenance contributes only an outer digest", async () => {
    const state = stateFixture(["files", "kernel", "notes"]);
    const compiled = compileFixture(state.apps);
    const provenanceDigest = "d".repeat(64);

    const result = await prepareBrowserDeployment({
      compiled,
      expectedDeploymentId: CURRENT_DEPLOYMENT,
      packages: [],
      provenance: provenanceFixture({ notes: provenanceDigest }),
      readers: {
        loadDeploymentRecord: async () => legacyDeploymentInspection(),
        loadPackageRecords: async () => legacyPackageInventory(state.apps),
      },
      runtime: runtimeFixture(state.apps),
      state,
      targetCanisterId: TARGET_CANISTER,
    });

    expect(recordPackage(result.prepared.record, "files")).toMatchObject({
      version: 100,
      archive: { state: "legacy_unavailable" },
      package_information: { state: "legacy_unavailable" },
    });
    expect(recordPackage(result.prepared.record, "notes")).toMatchObject({
      version: 100,
      archive: {
        state: "outer_archive_digest_only",
        sha256: provenanceDigest,
      },
      package_information: { state: "legacy_unavailable" },
    });
    expect(result.review.retainedPackageRecords).toEqual({});
    expect(result.review.record).toBe(result.prepared.record);
  });

  test("a matching complete record carries exact versioned evidence bound to runtime and canister", async () => {
    const state = stateFixture(["kernel", "notes"]);
    const notesRecord = packageRecordFixture("notes", 100);
    const notesRecordSha256 = hashContent(notesRecord.bytes);
    const prior = priorRecordFixture(state.apps, {
      notes: {
        archive: {
          state: "verified",
          sha256: "c".repeat(64),
          bytes: 43_210,
        },
        packageInformation: {
          state: "verified",
          sha256: notesRecordSha256,
        },
      },
    });
    const installedRecords = packageInventory(state.apps, {
      notes: declaredPackageInspection(notesRecord),
    });
    const input = {
      compiled: compileFixture(state.apps),
      expectedDeploymentId: CURRENT_DEPLOYMENT,
      packages: [],
      provenance: provenanceFixture({ notes: "c".repeat(64) }),
      readers: {
        loadDeploymentRecord: async () => declaredDeploymentInspection(prior),
        loadPackageRecords: async () => installedRecords,
      },
      runtime: runtimeFixture(state.apps),
      state,
      targetCanisterId: TARGET_CANISTER,
    } as const;

    const result = await prepareBrowserDeployment(input);
    expect(recordPackage(result.prepared.record, "notes")).toMatchObject({
      version: 100,
      archive: {
        state: "verified",
        sha256: "c".repeat(64),
        bytes: 43_210,
      },
      package_information: {
        state: "verified",
        sha256: notesRecordSha256,
      },
    });
    expect(result.review.retainedPackageRecords?.notes).toMatchObject({
      record: notesRecord.record,
      sha256: notesRecordSha256,
    });
    expect(result.review.retainedPackageRecords?.notes?.recordBytes).not.toBe(
      notesRecord.bytes,
    );
    expect(result.prepared.record.previous.deployment_id).toBe(
      CURRENT_DEPLOYMENT,
    );

    await expect(
      prepareBrowserDeployment({ ...input, targetCanisterId: OTHER_CANISTER }),
    ).rejects.toThrow(/does not match the checked runtime and app registry/u);
    await expect(
      prepareBrowserDeployment({
        ...input,
        runtime: { ...input.runtime, compiler_id: "moc_fixture_other" },
      }),
    ).rejects.toThrow(/compiler/u);
  });

  test("invalid and stale installed deployment records fail before a review is returned", async () => {
    const state = stateFixture(["kernel"]);
    const common = {
      compiled: compileFixture(state.apps),
      expectedDeploymentId: CURRENT_DEPLOYMENT,
      packages: [],
      provenance: provenanceFixture(),
      runtime: runtimeFixture(state.apps),
      state,
      targetCanisterId: TARGET_CANISTER,
    } as const;

    await expect(
      prepareBrowserDeployment({
        ...common,
        readers: {
          loadDeploymentRecord: async () => ({
            status: "invalid",
            recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
            message: "present record was corrupt",
          }),
          loadPackageRecords: async () => legacyPackageInventory(state.apps),
        },
      }),
    ).rejects.toThrow(/is invalid: present record was corrupt/u);

    const stale = priorRecordFixture(state.apps, {}, "e".repeat(32));
    await expect(
      prepareBrowserDeployment({
        ...common,
        readers: {
          loadDeploymentRecord: async () => declaredDeploymentInspection(stale),
          loadPackageRecords: async () => legacyPackageInventory(state.apps),
        },
      }),
    ).rejects.toThrow(/describes e{32}, expected a{32}/u);
  });

  test("claimed retained-record digests are rechecked against the exact bytes", async () => {
    const state = stateFixture(["kernel", "notes"]);
    const notesRecord = packageRecordFixture("notes", 100);
    const forgedSha256 = "f".repeat(64);
    const prior = priorRecordFixture(state.apps, {
      notes: {
        packageInformation: { state: "verified", sha256: forgedSha256 },
      },
    });
    const forgedInspection: InstalledPackageRecordInspection = {
      ...declaredPackageInspection(notesRecord),
      recordSha256: forgedSha256,
    };

    await expect(
      prepareBrowserDeployment({
        compiled: compileFixture(state.apps),
        expectedDeploymentId: CURRENT_DEPLOYMENT,
        packages: [],
        provenance: provenanceFixture(),
        readers: {
          loadDeploymentRecord: async () => declaredDeploymentInspection(prior),
          loadPackageRecords: async () =>
            packageInventory(state.apps, { notes: forgedInspection }),
        },
        runtime: runtimeFixture(state.apps),
        state,
        targetCanisterId: TARGET_CANISTER,
      }),
    ).rejects.toThrow(/SHA-256 does not match its exact bytes/u);
  });
});

function stateFixture(ids: readonly string[]): KernelPackageState {
  const apps = Object.freeze(
    Object.fromEntries(
      [...ids].sort().map((id) => [
        id,
        appRegistryEntry({
          format: 3,
          id,
          name: id === "kernel" ? "Neutron" : `${id} App`,
          version: 100,
          entry: "0".repeat(64),
        }),
      ]),
    ),
  );
  return Object.freeze({
    registry: apps,
    apps,
    browserSurfaceOriginAppIds: [],
    browserSurfaceOriginsSidecarPresent: false,
    existingConfigs: Object.freeze({}),
    existingModules: [],
    previousStable: null,
    connectionProviderSupport: Object.freeze({
      schema: "neutron.connection-provider-support.v1" as const,
      providers: Object.freeze([]),
    }),
  });
}

function compileFixture(apps: AppRegistry): CompileResult {
  const ids = Object.keys(apps).sort(comparePackageOrder);
  const capabilityPlans = Object.fromEntries(
    ids.map((id) => {
      const entry = apps[id]!;
      return [
        id,
        {
          plan: entry.capability_plan,
          fingerprint: entry.capability_plan_fingerprint,
        },
      ];
    }),
  );
  return {
    wasm: WASM,
    candid: "service : () -> {}",
    stable: "// @neutron-managed-memory-retirements-v2 []\n",
    diagnostics: [],
    compatibilityDiagnostics: [],
    danger: {},
    dependencyPlan: {
      order: ids,
      dependenciesByConsumer: Object.fromEntries(ids.map((id) => [id, []])),
      dependentsByProvider: {},
    },
    migrationPlan: {
      upgrades: [],
      removedApps: [],
      destructiveMemoryRoots: [],
    },
    managedMemoryRetirements: [],
    capabilityPlans,
    appInstanceInventory: targetApps(apps),
    browserSurfaceOriginAppIds: [],
    previousManagedMemoryInventory: [],
    managedMemoryInventory: [],
    previousStableSignatureSha256: null,
    deploymentId: NEXT_DEPLOYMENT,
    deploymentNonce: "9".repeat(32),
    vetKeysEnvironment: "production",
    persistenceMode: "classical",
    compilerId: "moc_fixture_next",
    assemblerId: ASSEMBLER_ID,
    modulePaths: [],
  };
}

function runtimeFixture(apps: AppRegistry): KernelRuntimeInfo {
  return {
    deployment_id: CURRENT_DEPLOYMENT,
    compiler_id: CURRENT_COMPILER,
    assembler_id: CURRENT_ASSEMBLER,
    apps: targetApps(apps).map((app, index) => ({
      scope: { app_id: app.app_id, installation_uid: BigInt(index + 1) },
      version: BigInt(app.version),
      deployment_id: CURRENT_DEPLOYMENT,
      capability_plan_fingerprint: app.capability_plan_fingerprint,
      browser_origin_nonce: (index + 1).toString(16).padStart(32, "0"),
      browser_origin_authority_epoch: 1n,
      resident_frame_security: { credentialless_opaque_v1: null },
    })),
    memories: [],
  };
}

function targetApps(apps: AppRegistry) {
  return Object.entries(apps)
    .map(([app_id, entry]) => ({
      app_id,
      version: entry.version,
      capability_plan_fingerprint: entry.capability_plan_fingerprint,
      resident_frame_security: "credentialless_opaque_v1" as const,
    }))
    .sort((left, right) => left.app_id.localeCompare(right.app_id));
}

type PriorEvidence = Readonly<{
  archive?: DeploymentPackageArchiveRecord;
  packageInformation?: PackageInformationRecordIdentity;
}>;

function priorRecordFixture(
  apps: AppRegistry,
  evidence: Readonly<Record<string, PriorEvidence>> = {},
  deploymentId = CURRENT_DEPLOYMENT,
): CompleteDeploymentBuildRecord {
  const { wasmRecord } = prepareDeterministicWasmTransport(WASM);
  const record = parseDeploymentBuildRecord({
    format: 1,
    state: "complete",
    deployment_id: deploymentId,
    previous: {
      deployment_id: null,
      stable_signature_sha256: null,
      apps: [],
      memories: [],
    },
    build: {
      compiler_id: CURRENT_COMPILER,
      assembler_id: CURRENT_ASSEMBLER,
      environment: "production",
      deployment_nonce: null,
      reachable_module_sha256: [],
    },
    packages: Object.entries(apps)
      .map(([appId, entry]) => ({
        app_id: appId,
        version: entry.version,
        archive:
          evidence[appId]?.archive ??
          ({ state: "legacy_unavailable" } as const),
        package_information:
          evidence[appId]?.packageInformation ??
          ({ state: "legacy_unavailable" } as const),
        dependencies: [],
      }))
      .sort((left, right) => comparePackageOrder(left.app_id, right.app_id)),
    target: { apps: targetApps(apps), memories: [] },
    warnings: {
      diagnostics: [],
      compatibility_diagnostics: [],
      memory_changes: [],
      removed_apps: [],
      destructive_memory_roots: [],
    },
    installation: {
      target_canister: TARGET_CANISTER,
      mode: "upgrade",
      argument: { sha256: hashContent(new Uint8Array()), bytes: 0 },
      wasm_memory_persistence: "replace",
    },
    wasm: wasmRecord,
  });
  if (record.state !== "complete") throw new Error("unreachable fixture state");
  return record;
}

function declaredDeploymentInspection(
  record: CompleteDeploymentBuildRecord,
): InstalledDeploymentBuildRecordInspection {
  return {
    status: "declared",
    recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
    record,
    canonicalJson: canonicalDeploymentBuildRecordJson(record),
    recordSha256: deploymentBuildRecordSha256(record),
    expectedModuleHash: deploymentRecordExpectedModuleHash(record),
    targetCanister: record.installation.target_canister,
  };
}

function legacyDeploymentInspection(): InstalledDeploymentBuildRecordInspection {
  return {
    status: "legacy",
    recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
  };
}

function legacyPackageInventory(apps: AppRegistry): InstalledPackageRecordInventory {
  return packageInventory(apps);
}

function packageInventory(
  apps: AppRegistry,
  overrides: Readonly<Record<string, InstalledPackageRecordInspection>> = {},
): InstalledPackageRecordInventory {
  return Object.freeze(
    Object.fromEntries(
      Object.keys(apps).map((appId) => [
        appId,
        overrides[appId] ?? {
          status: "legacy" as const,
          recordPath:
            appId === "kernel"
              ? "/pkg/legal/neutron-package-record.json"
              : `/app/${appId}/pkg/legal/neutron-package-record.json`,
        },
      ]),
    ),
  );
}

function provenanceFixture(
  packageDigests: Readonly<Record<string, string>> = {},
): InstallProvenance {
  return {
    format: 1,
    apps: Object.fromEntries(
      Object.entries(packageDigests).map(([appId, package_digest]) => [
        appId,
        { kind: "manual" as const, acquisition: "file" as const, package_digest },
      ]),
    ),
  };
}

function packageRecordFixture(appId: string, version: number): Readonly<{
  bytes: Uint8Array;
  record: NeutronPackageRecordV1;
}> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      format: 1,
      package: {
        id: appId,
        version,
        manifest: {
          path: "neutron.json",
          sha256: "1".repeat(64),
          bytes: 100,
        },
      },
      license: {
        id: "MIT",
        texts: [
          {
            id: "MIT",
            path: "legal/LICENSE.txt",
            sha256: "2".repeat(64),
            bytes: 100,
          },
        ],
      },
      source: { kind: "status", status: "unknown" },
      dependencies: [],
      notices: [],
      memory: null,
      build: { inputs: [], commands: [] },
    }),
  );
  return { bytes, record: parseNeutronPackageRecordStructure(bytes) };
}

function declaredPackageInspection(
  fixture: Readonly<{ bytes: Uint8Array; record: NeutronPackageRecordV1 }>,
): Extract<InstalledPackageRecordInspection, { status: "declared" }> {
  return {
    status: "declared",
    assetBasePath: "/app/notes/pkg/",
    recordPath: "/app/notes/pkg/legal/neutron-package-record.json",
    recordBytes: fixture.bytes,
    recordSha256: hashContent(fixture.bytes),
    record: fixture.record,
  };
}

function recordPackage(record: CompleteDeploymentBuildRecord, appId: string) {
  const result = record.packages.find(({ app_id }) => app_id === appId);
  if (!result) throw new Error(`Missing deployment package ${appId}`);
  return result;
}

function comparePackageOrder(left: string, right: string): number {
  if (left === right) return 0;
  if (left === "kernel") return -1;
  if (right === "kernel") return 1;
  return left.localeCompare(right);
}
