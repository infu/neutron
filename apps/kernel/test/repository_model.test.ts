import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { PreparedPackageInstall } from "neutron-compiler/src/install.js";
import type {
  NeutronFunctionConfig,
  PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";
import {
  availableRepositoryPackageIds,
  reconcileRepositoryPackages,
  resolveRepositorySelection,
  type VerifiedRepositoryPackage,
} from "../src/repository/model.ts";
import {
  parseInstallProvenance,
  withoutInstallProvenance,
  withInstallProvenance,
  withRepositoryInstallProvenance,
  withUpdateSourceInstallProvenance,
} from "../src/repository/provenance.ts";
import { prepareRepositoryLoadState } from "../src/repository/service.ts";
import { canStartRepositoryLoad } from "../src/repository/store.ts";
import { registryApp, runtimeApp } from "./app_registry_fixture.ts";

function pkg(
  id: string,
  version = 100,
  dependencies?: Record<string, { app: string; min_version: number; functions: string[] }>,
  func?: Record<string, NeutronFunctionConfig>,
): VerifiedRepositoryPackage {
  const manifest: PackagedNeutronManifest = {
    format: 3,
    entry: "0".repeat(64),
    id,
    name: id,
    version,
    ...(dependencies ? { dependencies } : {}),
    ...(func ? { func } : {}),
  };
  const registryEntry = registryApp(manifest);
  return {
    id,
    version,
    digest: "a".repeat(64),
    rawSize: 10,
    capabilityPlanFingerprint: registryEntry.capability_plan_fingerprint,
    capabilityDisclosures: [],
    permissions: [],
    appExplanations: [],
    preparedPackage: {
      appPrefix: `app/${id}/`,
      files: [],
      isKernel: false,
      manifest,
      capabilityPlan: registryEntry.capability_plan,
      capabilityPlanFingerprint: registryEntry.capability_plan_fingerprint,
    } satisfies PreparedPackageInstall,
  };
}

describe("repository reconciliation", () => {
  test("uses the union of registry, compiler, and runtime presence", () => {
    const packages = [pkg("hello")];
    const result = reconcileRepositoryPackages({
      packages,
      registry: { hello: registryApp({ id: "hello", name: "Hello" }) },
      configs: {},
      runtime: {
        deployment_id: "d",
        assembler_id: "a",
        compiler_id: "c",
        apps: [],
        memories: [],
      },
    });
    expect(result.hello?.installed).toBe(true);
    expect(result.hello?.consistent).toBe(false);
  });

  test("an overlapping manifest skips installed versions and leaves only missing apps", () => {
    const packages = [pkg("installed_app", 100), pkg("missing_app", 100)];
    const reconciliation = reconcileRepositoryPackages({
      packages,
      registry: {
        installed_app: registryApp({
          id: "installed_app",
          name: "Installed",
          version: 106,
        }),
      },
      configs: {
        installed_app: {
          format: 3,
          entry: "0".repeat(64),
          id: "installed_app",
          name: "Installed",
          version: 106,
        },
      },
      runtime: {
        deployment_id: "d",
        assembler_id: "a",
        compiler_id: "c",
        apps: [
          runtimeApp({
            id: "installed_app",
            version: 106,
            entry: registryApp({
              id: "installed_app",
              name: "Installed",
              version: 106,
            }),
          }),
        ],
        memories: [],
      },
    });

    expect(reconciliation.installed_app).toMatchObject({
      installed: true,
      consistent: true,
      version: 106,
    });
    expect(availableRepositoryPackageIds(packages, reconciliation)).toEqual([
      "missing_app",
    ]);

    const capabilityMismatch = reconcileRepositoryPackages({
      packages,
      registry: {
        installed_app: registryApp({
          id: "installed_app",
          name: "Installed",
          version: 106,
        }),
      },
      configs: {
        installed_app: {
          format: 3,
          entry: "0".repeat(64),
          id: "installed_app",
          name: "Installed",
          version: 106,
        },
      },
      runtime: {
        deployment_id: "d",
        assembler_id: "a",
        compiler_id: "c",
        apps: [
          {
            ...runtimeApp({
              id: "installed_app",
              version: 106,
              entry: registryApp({
                id: "installed_app",
                name: "Installed",
                version: 106,
              }),
            }),
            capability_plan_fingerprint: "f".repeat(64),
          },
        ],
        memories: [],
      },
    });
    expect(capabilityMismatch.installed_app?.issues).toContain(
      "installed_app has conflicting installed capability plans",
    );
  });

  test("an all-installed manifest has no selectable or deployable apps", () => {
    const packages = [pkg("first_app"), pkg("second_app")];
    const configs = Object.fromEntries(
      packages.map(({ id, preparedPackage }) => [
        id,
        preparedPackage.manifest,
      ]),
    );
    const registry = Object.fromEntries(
      packages.map(({ id, version, preparedPackage }) => [
        id,
        registryApp({
          id,
          name: id,
          version,
          ...(preparedPackage.manifest.dependencies
            ? {
                dependencies: preparedPackage.manifest.dependencies,
              }
            : {}),
        }),
      ]),
    );
    const reconciliation = reconcileRepositoryPackages({
      packages,
      registry,
      configs,
      runtime: {
        deployment_id: "d",
        assembler_id: "a",
        compiler_id: "c",
        apps: packages.map(({ id, version }, index) =>
          runtimeApp({
            id,
            version,
            entry: registry[id]!,
            installationUid: BigInt(index + 1),
          }),
        ),
        memories: [],
      },
    });

    expect(availableRepositoryPackageIds(packages, reconciliation)).toEqual(
      [],
    );
    const selection = resolveRepositorySelection({
      packages,
      reconciliation,
      roots: new Set(packages.map(({ id }) => id)),
    });
    expect([...selection.selected]).toEqual([]);
    expect(selection.blockers).toEqual([]);
  });
});

describe("repository selection", () => {
  test("auto-selects a missing dependency but keeps only roots editable", () => {
    const packages = [
      pkg("base_app"),
      pkg("uses_app", 100, {
        base: { app: "base_app", min_version: 100, functions: ["read"] },
      }),
    ];
    const reconciliation = Object.fromEntries(
      packages.map(({ id }) => [
        id,
        {
          installed: false,
          version: null,
          consistent: true,
          issues: [],
          sources: { registry: null, compiled: null, runtime: null },
        },
      ]),
    );
    const selected = resolveRepositorySelection({
      packages,
      reconciliation,
      roots: new Set(["uses_app"]),
    });
    expect([...selected.selected].sort()).toEqual(["base_app", "uses_app"]);
    expect([...selected.automatic]).toEqual(["base_app"]);
    expect(selected.requiredBy.base_app).toEqual(["uses_app"]);
  });

  test("blocks a dependency on an older installed provider", () => {
    const packages = [
      pkg("base_app", 101),
      pkg("uses_app", 100, {
        base: { app: "base_app", min_version: 101, functions: ["read"] },
      }),
    ];
    const selected = resolveRepositorySelection({
      packages,
      reconciliation: {
        base_app: {
          installed: true,
          version: 100,
          consistent: true,
          issues: [],
          sources: { registry: 1, compiled: 1, runtime: 1 },
        },
        uses_app: {
          installed: false,
          version: null,
          consistent: true,
          issues: [],
          sources: { registry: null, compiled: null, runtime: null },
        },
      },
      roots: new Set(["uses_app"]),
    });
    expect(selected.blockers.join(" ")).toContain("v0.1.1 or newer");
  });

  test("accepts a compatible installed dependency outside the setup", () => {
    const packages = [
      pkg("uses_app", 100, {
        base: { app: "base_app", min_version: 101, functions: ["read"] },
      }),
    ];
    const selected = resolveRepositorySelection({
      packages,
      reconciliation: {
        base_app: {
          installed: true,
          version: 101,
          consistent: true,
          issues: [],
          sources: { registry: 2, compiled: 2, runtime: 2 },
        },
        uses_app: {
          installed: false,
          version: null,
          consistent: true,
          issues: [],
          sources: { registry: null, compiled: null, runtime: null },
        },
      },
      roots: new Set(["uses_app"]),
    });
    expect([...selected.selected]).toEqual(["uses_app"]);
    expect(selected.blockers).toEqual([]);
  });

  test("loads unrelated choices when an advertised dependent cannot use an older installed provider", () => {
    const provider = pkg("base_app", 101, undefined, {
      read: { type: "internal", expose: "apps" },
    });
    const consumer = pkg("uses_app", 100, {
      base: { app: "base_app", min_version: 101, functions: ["read"] },
    });
    const unrelated = pkg("solo_app");
    const installedProvider = {
      ...provider.preparedPackage.manifest,
      version: 100,
      func: {
        ...provider.preparedPackage.manifest.func,
        legacy: { type: "internal" as const, expose: "apps" as const },
      },
    };
    const installedConsumer = {
      format: 3 as const,
      entry: "0".repeat(64),
      id: "legacy_app",
      name: "Legacy app",
      version: 100,
      dependencies: {
        base: {
          app: "base_app",
          min_version: 100,
          functions: ["legacy"],
        },
      },
    };
    const { reconciliation } = prepareRepositoryLoadState({
      packages: [provider, consumer, unrelated],
      baseline: {
        state: {
          apps: {
            base_app: registryApp({
              id: "base_app",
              name: "Base",
              version: 100,
              func: installedProvider.func,
            }),
            legacy_app: registryApp({
              id: "legacy_app",
              name: "Legacy app",
              version: 100,
              dependencies: installedConsumer.dependencies,
            }),
          },
          existingConfigs: {
            base_app: installedProvider,
            legacy_app: installedConsumer,
          },
        } as never,
        runtime: {
          deployment_id: "deployment",
          assembler_id: "assembler",
          compiler_id: "compiler",
          apps: [
            runtimeApp({
              id: "base_app",
              version: 100,
              installationUid: 1n,
              entry: registryApp({
                id: "base_app",
                name: "Base",
                version: 100,
                func: installedProvider.func,
              }),
            }),
            runtimeApp({
              id: "legacy_app",
              version: 100,
              installationUid: 2n,
              entry: registryApp({
                id: "legacy_app",
                name: "Legacy app",
                version: 100,
                dependencies: installedConsumer.dependencies,
              }),
            }),
          ],
          memories: [],
        },
      },
    });

    expect(reconciliation.base_app?.installed).toBe(true);
    const unrelatedSelection = resolveRepositorySelection({
      packages: [provider, consumer, unrelated],
      reconciliation,
      roots: new Set(["solo_app"]),
    });
    expect([...unrelatedSelection.selected]).toEqual(["solo_app"]);
    expect(unrelatedSelection.blockers).toEqual([]);

    const blockedSelection = resolveRepositorySelection({
      packages: [provider, consumer, unrelated],
      reconciliation,
      roots: new Set(["uses_app"]),
    });
    expect(blockedSelection.blockers.join(" ")).toContain("v0.1.1 or newer");
  });
});

test("provenance is closed, merged, and removable", () => {
  const entry = {
    kind: "repository" as const,
    repository: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    manifest_id: "demo",
    manifest_digest: "a".repeat(64),
    package_digest: "b".repeat(64),
  };
  const merged = withRepositoryInstallProvenance(
    parseInstallProvenance({ format: 1, apps: {} }),
    { hello: entry },
  );
  expect(merged.apps.hello).toEqual(entry);
  expect(withoutInstallProvenance(merged, ["hello"]).apps).toEqual({});
  expect(() =>
    parseInstallProvenance({ format: 1, apps: {}, unexpected: true }),
  ).toThrow(/Invalid install provenance/);
  expect(() =>
    parseInstallProvenance({
      format: 1,
      apps: { __proto__: entry, constructor: entry },
    }),
  ).toThrow(/Invalid install provenance/);
  expect(() =>
    parseInstallProvenance({
      format: 1,
      apps: { hello: { ...entry, repository: "aaaaa-aa" } },
    }),
  ).toThrow(/Invalid install provenance/);

  const updated = withUpdateSourceInstallProvenance(merged, {
    hello: {
      kind: "update_source",
      source_canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
      release_digest: "c".repeat(64),
      package_digest: "d".repeat(64),
      checked_at: 1_700_000_000_000,
    },
  });
  expect(updated.apps.hello).toEqual({
    kind: "update_source",
    source_canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    release_digest: "c".repeat(64),
    package_digest: "d".repeat(64),
    checked_at: 1_700_000_000_000,
  });
  expect(() =>
    parseInstallProvenance({
      format: 1,
      apps: {
        hello: {
          ...(updated.apps.hello as object),
          checked_at: -1,
        },
      },
    }),
  ).toThrow(/Invalid install provenance/);
  expect(() =>
    parseInstallProvenance({
      format: 1,
      apps: {
        hello: {
          ...(updated.apps.hello as object),
          source_canister:
            "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe",
        },
      },
    }),
  ).toThrow(/Invalid install provenance/);

  const manual = withInstallProvenance(updated, {
    hello: {
      kind: "manual",
      acquisition: "url",
      package_digest: "e".repeat(64),
    },
  });
  expect(manual.apps.hello).toEqual({
    kind: "manual",
    acquisition: "url",
    package_digest: "e".repeat(64),
  });

  const provisioned = withInstallProvenance(manual, {
    hello: {
      kind: "provisioned",
      package_digest: "f".repeat(64),
    },
  });
  expect(provisioned.apps.hello).toEqual({
    kind: "provisioned",
    package_digest: "f".repeat(64),
  });
  expect(
    parseInstallProvenance({
      format: 1,
      apps: {
        hello: {
          kind: "provisioned",
          package_digest: "f".repeat(64),
        },
      },
    }).apps.hello,
  ).toEqual({
    kind: "provisioned",
    package_digest: "f".repeat(64),
  });
  expect(() =>
    parseInstallProvenance({
      format: 1,
      apps: {
        hello: {
          kind: "provisioned",
          package_digest: "not-a-sha256",
        },
      },
    }),
  ).toThrow(/Invalid install provenance/);
  expect(() =>
    parseInstallProvenance({
      format: 1,
      apps: {
        hello: {
          kind: "provisioned",
          package_digest: "f".repeat(64),
          acquisition: "file",
        },
      },
    }),
  ).toThrow(/Invalid install provenance/);
});

test("repository load accepts one pending action and only intentional retries", () => {
  expect(canStartRepositoryLoad("pending", null)).toBe(true);
  expect(canStartRepositoryLoad("error", "load")).toBe(true);
  expect(canStartRepositoryLoad("error", "install")).toBe(true);
  expect(canStartRepositoryLoad("loading", null)).toBe(false);
  expect(canStartRepositoryLoad("error", "compile")).toBe(false);
  expect(canStartRepositoryLoad("selecting", null)).toBe(false);
});

test("repository install owns focus for the whole attempt and reconciles the stored registry", async () => {
  const [dialog, apps] = await Promise.all([
    readFile(
      new URL("../src/repository/RepositorySetupDialog.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/reducer/apps.ts", import.meta.url), "utf8"),
  ]);

  const focusOwnership = dialog.slice(
    dialog.indexOf("if (!attemptActive) return;"),
    dialog.indexOf("if (!visible) return;"),
  );
  expect(focusOwnership).toContain("}, [attemptActive]);");
  expect(focusOwnership).not.toContain("[visible]");
  expect(focusOwnership).toContain("cancelAnimationFrame");
  expect(dialog).toContain("Neutron cannot");
  expect(dialog).toContain("personal, affiliate, or hidden tracking identifiers");
  expect(dialog).toContain("pkg.publisher.website");
  expect(dialog).toContain('referrerPolicy="no-referrer"');

  const session = apps.slice(
    apps.indexOf("export async function beginRepositoryInstallSession"),
    apps.indexOf("function packageBaselineFingerprint"),
  );
  expect(session).toContain("apps: state.registry");
  expect(session).toContain("state: reconciliationState");
  expect(session).toContain("existingApps: state.apps");

  const fingerprint = apps.slice(
    apps.indexOf("function packageBaselineFingerprint"),
    apps.indexOf("function canonicalValue"),
  );
  expect(fingerprint).toContain("registry: state.registry");
  expect(fingerprint).not.toContain("apps: state.apps");
});

test("fresh setup captures restart identical attempts and failed installs restore expiry", async () => {
  const [controller, service] = await Promise.all([
    readFile(
      new URL(
        "../src/repository/RepositorySetupController.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../src/repository/service.ts", import.meta.url), "utf8"),
  ]);

  expect(controller).toContain(
    "refreshPendingRepositorySetup({ freshCapture: true })",
  );
  expect(service).toMatch(
    /referencesEqual\(current, reference\) && !freshCapture/,
  );
  const install = service.slice(
    service.indexOf("export async function installRepositorySelection"),
    service.indexOf("export async function retryRepositorySetup"),
  );
  expect(install).toMatch(
    /catch \(error\)[\s\S]*?requireCurrentPendingReference\(reference\)[\s\S]*?repositorySetupState\.error\("install", error\)/,
  );
  expect(install).toContain("expireActiveSetup(pendingError)");
});
