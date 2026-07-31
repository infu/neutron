import { expect, test } from "bun:test";
import { hashContent } from "neutron-tools/src/hash.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import {
  appRegistryEntry,
  buildPackagesInstallAssets,
  KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT,
  KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT,
  normalizeAppRegistry,
  preparePackageInstall,
  type AppRegistry,
  type KernelRuntimeInfo,
  type UnpackedNeutronPackage,
} from "neutron-compiler/src/install.js";
import {
  assemble,
  type AssemblyManifest,
} from "neutron-compiler/src/assemble.js";
import { normalizeAppInstanceInventory } from "../src/app_scope.ts";
import {
  assertAppSurfaceInventoryCapacity,
  assertTargetAppSurfaceCapacity,
  MAX_INSTALLED_APP_INSTANCES,
} from "../src/runtime_limits.ts";
import {
  reconcileAppRegistry,
  settingsAppRows,
} from "../src/settings/model.ts";
import { runtimeApp } from "./app_registry_fixture.ts";

const encoder = new TextEncoder();
const DEPLOYMENT_ID = "scale-acceptance";
const ORDINARY_APP_COUNT = 200;
const HEADLESS_MODULE = encoder.encode("module { public class Init() {} }");
const HEADLESS_MODULE_HASH = hashContent(HEADLESS_MODULE);

test("two hundred neutral headless apps cross install, runtime, Settings, and batched removal boundaries", () => {
  const kernelManifest: AssemblyManifest = {
    format: 3,
    id: "kernel",
    name: "Kernel",
    version: 100,
    entry: "kernel",
  };
  const ordinaryIds = Array.from(
    { length: ORDINARY_APP_COUNT },
    (_, index) => `headless_${index.toString().padStart(3, "0")}`,
  );
  const prepared = ordinaryIds.map((id) =>
    preparePackageInstall(headlessPackage(id)),
  );
  const installationUids = new Map<string, bigint>([
    ["kernel", 1n],
    ...ordinaryIds.map(
      (id, index) => [id, BigInt(index + 2)] as const,
    ),
  ]);

  let registry: AppRegistry = {
    kernel: appRegistryEntry(kernelManifest),
  };
  let manifests: Record<string, AssemblyManifest> = {
    kernel: kernelManifest,
  };
  const installBatchSizes: number[] = [];

  for (
    let offset = 0;
    offset < prepared.length;
    offset += KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT
  ) {
    const batch = prepared.slice(
      offset,
      offset + KERNEL_INSTALL_MAX_CLEAR_PREFIXES_PER_COMMIT,
    );
    installBatchSizes.push(batch.length);
    assertTargetAppSurfaceCapacity(
      registry,
      batch.map(({ manifest }) => manifest),
    );
    registry = buildPackagesInstallAssets({
      existingApps: registry,
      packages: batch,
      candid: "service : {}",
    }).apps;
    manifests = {
      ...manifests,
      ...Object.fromEntries(
        batch.map(({ manifest }) => [manifest.id, manifest]),
      ),
    };
    expect(assemble(manifests)).toContain(
      `app_instances = ${Object.keys(registry).length};`,
    );
  }

  expect(installBatchSizes).toEqual([128, 72]);
  expect(Object.keys(registry)).toHaveLength(ORDINARY_APP_COUNT + 1);
  projectRuntimeAndSettings(registry, installationUids);

  const boundaryAppCount =
    MAX_INSTALLED_APP_INSTANCES - Object.keys(registry).length;
  const boundaryManifests = Array.from(
    { length: boundaryAppCount },
    (_, index) =>
      syntheticManifest(`boundary_${index.toString().padStart(3, "0")}`),
  );
  assertTargetAppSurfaceCapacity(registry, boundaryManifests);
  const atLimitRegistry = normalizeAppRegistry({
    ...registry,
    ...Object.fromEntries(
      boundaryManifests.map((manifest) => [
        manifest.id,
        appRegistryEntry(manifest),
      ]),
    ),
  });
  const atLimitManifests = {
    ...manifests,
    ...Object.fromEntries(
      boundaryManifests.map((manifest) => [manifest.id, manifest]),
    ),
  };
  for (const [index, manifest] of boundaryManifests.entries()) {
    installationUids.set(
      manifest.id,
      BigInt(ORDINARY_APP_COUNT + index + 2),
    );
  }
  expect(Object.keys(atLimitRegistry)).toHaveLength(
    MAX_INSTALLED_APP_INSTANCES,
  );
  expect(assemble(atLimitManifests)).toContain(
    `app_instances = ${MAX_INSTALLED_APP_INSTANCES};`,
  );
  projectRuntimeAndSettings(atLimitRegistry, installationUids);

  const overflowManifest = syntheticManifest("boundary_overflow");
  const overflowRegistry = {
    ...atLimitRegistry,
    [overflowManifest.id]: appRegistryEntry(overflowManifest),
  };
  const overflowManifests = {
    ...atLimitManifests,
    [overflowManifest.id]: overflowManifest,
  };
  installationUids.set(
    overflowManifest.id,
    BigInt(MAX_INSTALLED_APP_INSTANCES + 1),
  );
  expect(() =>
    assertTargetAppSurfaceCapacity(atLimitRegistry, [overflowManifest]),
  ).toThrow(`maximum is ${MAX_INSTALLED_APP_INSTANCES} including Kernel`);
  expect(() => normalizeAppRegistry(overflowRegistry)).toThrow(
    "App registry exceeds the installed app limit",
  );
  expect(() => assemble(overflowManifests)).toThrow(
    `maximum is ${MAX_INSTALLED_APP_INSTANCES} including Kernel`,
  );
  expect(() =>
    normalizeAppInstanceInventory(
      runtimeFor(overflowRegistry, installationUids).apps,
      DEPLOYMENT_ID,
    ),
  ).toThrow("Runtime app-instance inventory is invalid");
  expect(() =>
    settingsAppRows(
      overflowRegistry,
      runtimeFor(overflowRegistry, installationUids),
    ),
  ).toThrow(`maximum is ${MAX_INSTALLED_APP_INSTANCES} including Kernel`);

  const removalBatchSizes: number[] = [];
  for (
    let offset = 0;
    offset < ordinaryIds.length;
    offset += KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT
  ) {
    const removedApps = ordinaryIds.slice(
      offset,
      offset + KERNEL_INSTALL_MAX_APP_REMOVALS_PER_COMMIT,
    );
    removalBatchSizes.push(removedApps.length);
    registry = buildPackagesInstallAssets({
      existingApps: registry,
      packages: [],
      candid: "service : {}",
      removedApps,
    }).apps;
    const removed = new Set(removedApps);
    manifests = Object.fromEntries(
      Object.entries(manifests).filter(([id]) => !removed.has(id)),
    );
    expect(assemble(manifests)).toContain(
      `app_instances = ${Object.keys(registry).length};`,
    );
    projectRuntimeAndSettings(registry, installationUids);
  }

  expect(removalBatchSizes).toEqual([64, 64, 64, 8]);
  expect(Object.keys(registry)).toEqual(["kernel"]);
});

function headlessPackage(id: string): UnpackedNeutronPackage {
  return {
    "neutron.json": encoder.encode(JSON.stringify(syntheticManifest(id))),
    [`mo/${HEADLESS_MODULE_HASH}.mo`]: HEADLESS_MODULE,
  };
}

function syntheticManifest(id: string): AssemblyManifest {
  return {
    format: 3,
    id,
    name: `Headless ${id.slice(id.lastIndexOf("_") + 1)}`,
    version: 100,
    entry: HEADLESS_MODULE_HASH,
  };
}

function runtimeFor(
  registry: AppRegistry,
  installationUids: ReadonlyMap<string, bigint>,
): KernelRuntimeInfo {
  return {
    deployment_id: DEPLOYMENT_ID,
    assembler_id: "neutron_actor_v25",
    compiler_id: "synthetic",
    apps: Object.entries(registry)
      .sort(([left], [right]) => compareCanonicalText(left, right))
      .map(([id, entry]) =>
        runtimeApp({
          id,
          entry,
          deploymentId: DEPLOYMENT_ID,
          installationUid: requiredUid(installationUids, id),
        }),
      ),
    memories: [],
  };
}

function projectRuntimeAndSettings(
  registry: AppRegistry,
  installationUids: ReadonlyMap<string, bigint>,
): void {
  assertAppSurfaceInventoryCapacity(registry);
  const runtime = runtimeFor(registry, installationUids);
  const projection = normalizeAppInstanceInventory(
    runtime.apps,
    runtime.deployment_id,
  );
  const expectedIds = Object.keys(registry).sort(compareCanonicalText);
  expect(Object.keys(projection)).toEqual(expectedIds);
  expect(reconcileAppRegistry(registry, runtime)).toEqual({
    ok: true,
    issues: [],
  });
  const rows = settingsAppRows(registry, runtime);
  expect(rows).toHaveLength(expectedIds.length);
  expect(rows[0]?.id).toBe("kernel");
  expect(new Set(rows.map(({ id }) => id))).toEqual(new Set(expectedIds));
  expect(
    rows
      .filter(({ id }) => id !== "kernel")
      .every(({ entry }) => entry.tiles.length === 0),
  ).toBe(true);
}

function requiredUid(
  installationUids: ReadonlyMap<string, bigint>,
  id: string,
): bigint {
  const uid = installationUids.get(id);
  if (uid === undefined) {
    throw new Error(`Missing test installation uid for ${id}`);
  }
  return uid;
}
