import { expect, test } from "bun:test";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  parseRepositoryManifest,
} from "neutron-tools/repository";
import { buildCapabilityPlan } from "neutron-tools/src/capabilities/plan.js";
import {
  projectRuntimeCapabilityRegistrationsV1,
} from "neutron-tools/src/capabilities/runtime.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { NEUTRON_PACKAGE_RECORD_PATH } from "neutron-tools/src/package_record.js";
import {
  appRegistryEntry,
  buildAppUninstallCompileInput,
  buildPackageCompileInput,
  buildPackagesInstallAssets,
  preparePackageInstall,
  type UnpackedNeutronPackage,
} from "../src/install.ts";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function unofficialPackageFiles(): UnpackedNeutronPackage {
  const source = "module { public class Init() {} }";
  const content = bytes(source);
  const entry = hashContent(content);
  return {
    "neutron.json": bytes(
      JSON.stringify({
        format: 3,
        id: "community_notes",
        name: "Community Notes",
        version: 100,
        entry,
      }),
    ),
    [`mo/${entry}.mo`]: content,
  };
}

function capabilityPackageFiles(
  id: string,
  updateSource?: string,
): UnpackedNeutronPackage {
  const source = "module { public class Init() {} }";
  const content = bytes(source);
  const entry = hashContent(content);
  return {
    "neutron.json": bytes(
      JSON.stringify({
        format: 3,
        id,
        name: "Equivalent App",
        version: 100,
        entry,
        ...(updateSource ? { update_source: updateSource } : {}),
        capabilities: {
          backend_calls: {
            api: 1,
            description: "Call an owner-approved canister method",
            reservation_scopes: ["exact"],
            max_concurrency: 2,
            max_cycles_per_call: 1_000,
            max_cycles_per_day: 10_000,
          },
          randomness: { api: 1 },
          vetkeys: {
            api: 1,
            description: "Derive private application keys",
            slots: [{ id: "private", purpose: "Application encryption" }],
          },
        },
      }),
    ),
    [`mo/${entry}.mo`]: content,
  };
}

test("legacy packages without a legal record remain on the ordinary install and removal path", () => {
  const files = unofficialPackageFiles();
  const rawManifest = JSON.parse(
    new TextDecoder().decode(files["neutron.json"]),
  );

  expect(rawManifest.format).toBe(3);
  expect(rawManifest).not.toHaveProperty("update_source");
  expect(files).not.toHaveProperty(NEUTRON_PACKAGE_RECORD_PATH);

  const prepared = preparePackageInstall(files);
  expect(prepared.packageRecord).toBeUndefined();
  expect(prepared.manifest).not.toHaveProperty("update_source");

  const kernelSource = "module {}";
  const kernelEntry = hashContent(bytes(kernelSource));
  const kernel = {
    format: 3 as const,
    id: "kernel",
    name: "Kernel",
    version: 306,
    entry: kernelEntry,
  };
  const existingModules = [
    { path: `${kernelEntry}.mo`, content: kernelSource },
  ];
  const installCompile = buildPackageCompileInput({
    existingModules,
    existingConfigs: { kernel },
    existingStable: null,
    preparedPackage: prepared,
  });

  expect(Object.keys(installCompile.configs)).toEqual([
    "kernel",
    "community_notes",
  ]);
  expect(installCompile.configs.community_notes).toEqual(prepared.manifest);
  expect(installCompile.mofiles.map(({ path }) => path)).toContain(
    `${prepared.manifest.entry}.mo`,
  );

  const kernelApps = { kernel: appRegistryEntry(kernel) };
  const installed = buildPackagesInstallAssets({
    existingApps: kernelApps,
    packages: [prepared],
    candid: "service : {}",
  });
  expect(Object.keys(installed.apps)).toEqual(["kernel", "community_notes"]);
  expect(installed.apps.community_notes).not.toHaveProperty("update_source");

  const uninstallCompile = buildAppUninstallCompileInput({
    state: {
      registry: installed.apps,
      apps: installed.apps,
      existingConfigs: installCompile.configs,
      existingModules: installCompile.mofiles,
      previousStable: null,
      connectionProviderSupport: {
        schema: "neutron.connection-provider-support.v1",
        providers: [],
      },
    },
    appId: "community_notes",
  });
  expect(uninstallCompile.configs).toEqual({ kernel });

  const removed = buildPackagesInstallAssets({
    existingApps: installed.apps,
    packages: [],
    candid: "service : {}",
    removedApps: ["community_notes"],
  });
  expect(removed.apps).toEqual(kernelApps);
});

test("app identity, update source, and publisher claims do not change capability admission", () => {
  const productionSource = "233tv-xiaaa-aaaay-aacta-cai";
  const repositoryClaims = parseRepositoryManifest({
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id: "capability_equality",
    revision: 1,
    name: "Capability Equality",
    packages: [
      {
        id: "claimed_source_app",
        version: 100,
        sha256: "a".repeat(64),
        size: 1,
        publisher: {
          name: "Claimed Publisher",
          website: "https://publisher.example/",
        },
      },
      {
        id: "independent_app",
        version: 100,
        sha256: "b".repeat(64),
        size: 1,
        publisher: { name: "Independent Publisher" },
      },
    ],
  }).packages;

  const admitted = repositoryClaims.map((claim, index) => {
    const prepared = preparePackageInstall(
      capabilityPackageFiles(
        claim.id,
        index === 0 ? productionSource : undefined,
      ),
      { expectedIdentity: { id: claim.id, version: claim.version } },
    );
    return {
      claim,
      prepared,
      registrations: projectRuntimeCapabilityRegistrationsV1(
        buildCapabilityPlan(prepared.manifest),
      ),
    };
  });
  const [claimed, independent] = admitted;
  if (!claimed || !independent) throw new Error("Invalid test fixture");

  expect(claimed.claim.publisher).not.toEqual(independent.claim.publisher);
  expect(claimed.prepared.manifest.update_source).toBe(productionSource);
  expect(independent.prepared.manifest).not.toHaveProperty("update_source");

  expect(claimed.prepared.capabilityPlan.entries).toEqual(
    independent.prepared.capabilityPlan.entries,
  );
  expect(claimed.registrations).toEqual(independent.registrations);
  expect(claimed.registrations.map(({ kind }) => kind)).toEqual([
    "backend_calls",
    "randomness",
    "vetkeys",
  ]);

  // Whole-plan fingerprints remain app-scoped to prevent cross-app
  // substitution even though both apps receive equal authority resources.
  expect(claimed.prepared.capabilityPlanFingerprint).not.toBe(
    independent.prepared.capabilityPlanFingerprint,
  );
});
