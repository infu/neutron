import type {
  NeutronFunctionConfig,
  NeutronHttpPostUpdateHandlerRouteMountConfig,
  NeutronMemoryConfig,
  NeutronManifest,
} from "neutron-tools/src/schema.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import {
  buildCapabilityPlan,
  getCapabilityPlanEntry,
  type CapabilityPlan,
} from "neutron-tools/src/capabilities/plan.js";
import {
  BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_GLOBAL,
  CHAIN_KEY_SIGNING_MAX_SLOTS_GLOBAL,
  CONNECTIONS_MAX_PROVIDERS_GLOBAL,
  CERTIFIED_ASSETS_GLOBAL_CHARGED_BYTES_MAX,
  CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1,
  HTTP_POST_UPDATE_HANDLERS_GLOBAL_MAX_CALLS_PER_HOUR,
  HTTP_POST_UPDATE_HANDLERS_GLOBAL_MAX_REPLAY_BYTES_PER_HOUR,
  HTTPS_OUTCALLS_MAX_ENDPOINTS_GLOBAL,
  PUBLIC_INGRESS_MAX_CALLS_GLOBAL_PER_HOUR,
  PUBLIC_INGRESS_MAX_ROUTES_GLOBAL,
  STABLE_STORE_MAX_BYTES_GLOBAL,
  STABLE_STORE_MAX_ENTRIES_GLOBAL,
  STABLE_STORE_MAX_STORES_GLOBAL,
  VETKEYS_MAX_SLOTS_GLOBAL,
  backendCallInstallReservationKey,
  certifiedAssetsPhysicalReservation,
  publicIngressResourceId,
  type NeutronBackendCallReservation,
  type NeutronPublicIngressRouteV1,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  fingerprintCapabilityPlanWireV1,
  toCapabilityPlanWireV1,
} from "neutron-tools/src/capabilities/wire.js";
import {
  RUNTIME_CAPABILITY_MAX_TOTAL,
  projectRuntimeCapabilityRegistrationsV1,
} from "neutron-tools/src/capabilities/runtime.js";
import {
  appPhysicalStem,
  physicalAppMethodName,
  physicalPublicIngressMethodName,
  scopedPhysicalStem,
} from "neutron-tools/src/physical_names.js";
import {
  planAppDependencies,
  type AppDependencyPlan,
  type ResolvedAppDependency,
} from "./app_dependencies.ts";
import {
  assertMemoryMigrationPlan,
  type MemoryMigrationPlan,
  type MemoryUpgrade,
} from "./memory_migrations.ts";
import {
  normalizeManagedMemoryRetirements,
  type ManagedMemoryRetirement,
} from "./memory_retirements.ts";
import {
  managedMemoryPhysicalStem,
  managedMemoryStoreName,
  retiredManagedMemoryStoreName,
} from "./memory_physical_names.ts";
import {
  residentFrameSecurity,
  type ResidentFrameSecurity,
} from "./resident_frame_security.ts";
import {
  assertTrustedInstallationContext,
  mainnetTrustedInstallationContext,
  type TrustedInstallationContextV1,
} from "./installation_context.ts";

export type AssemblyManifest = NeutronManifest & {
  entry: string;
};

export type AssemblyConfig =
  Record<string, AssemblyManifest> | AssemblyManifest[];

export type AssembleOptions = {
  migrationPlan?: MemoryMigrationPlan;
  committedRetirements?: readonly ManagedMemoryRetirement[];
  dependencyPlan?: AppDependencyPlan;
  deploymentId?: string;
  compilerId?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  /**
   * Exact context for a fresh installation. `null` emits a preservation-only
   * initializer for an actor that already owns the persistent v1 field.
   */
  installationContext?: TrustedInstallationContextV1 | null;
  /** Apps whose installed asset subtrees own browser-surface origins. */
  browserSurfaceOriginAppIds?: readonly string[];
};

export type VetKeysEnvironment = "production" | "local";

/** Exact generation that introduced the browser-surface origin contract. */
export const BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID = "neutron_actor_v26";
export const ASSEMBLER_ID = BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID;
export const LEGACY_V25_ASSEMBLER_ID = "neutron_actor_v25";
export const V26_FRESH_KERNEL_MIN_VERSION = 316;

export function assemblerForFreshKernelVersion(
  kernelVersion: number,
):
  | typeof BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID
  | typeof LEGACY_V25_ASSEMBLER_ID {
  return kernelVersion < V26_FRESH_KERNEL_MIN_VERSION
    ? LEGACY_V25_ASSEMBLER_ID
    : BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID;
}

/** Enforce the one manifest feature that cannot be represented by v25. */
export function assertAssemblerSupportsBrowserPermissions(
  assemblerId: typeof ASSEMBLER_ID | typeof LEGACY_V25_ASSEMBLER_ID,
  manifests: readonly Pick<NeutronManifest, "id" | "capabilities">[],
): void {
  if (assemblerId !== LEGACY_V25_ASSEMBLER_ID) return;
  const declared = manifests.find(
    ({ capabilities }) => capabilities?.browser_permissions !== undefined,
  );
  if (declared !== undefined) {
    throw new Error(
      `App ${declared.id} declares browser_permissions, which requires Kernel ${V26_FRESH_KERNEL_MIN_VERSION} or newer with assembler ${BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID}`,
    );
  }
}

export function supportsBrowserSurfaceOrigins(assemblerId: string): boolean {
  return assemblerId === BROWSER_SURFACE_ORIGIN_ASSEMBLER_ID;
}

/** One actor-wide ceiling, including the Kernel app. */
export const NEUTRON_INSTALLED_APP_LIMIT = 256;
/** Browser and backend admission both reserve at most this many residents. */
export const NEUTRON_RESIDENT_BACKGROUND_LIMIT = 32;
/** Must match the Kernel scheduler's actor-wide configured-task ceiling. */
export const NEUTRON_SCHEDULED_TASK_LIMIT = 64;

type MemoryOwner = {
  manifest: AssemblyManifest;
  memoryId: string;
  memory: NeutronMemoryConfig;
};

type RuntimeApp = {
  id: string;
  version: number;
  capabilityPlanFingerprint: string;
  residentFrameSecurity: ResidentFrameSecurity;
};

const ACTIVE_APP_INSTANCE_INVENTORY = "active_app_instance_inventory";
const ACTIVE_APP_INSTANCE_INVENTORY_BINDING =
  "NeutronActiveAppInstanceInventory";
const ACTOR_SELF = "NeutronActor";
const INSTALLER = "NeutronInstaller";
const KERNEL_INIT = "NeutronKernel";
const COMMIT_MEMORY_RETIREMENTS = "NeutronCommitManagedMemoryRetirements";
const PUBLIC_INGRESS_UPDATE_HANDLER = "NeutronPublicIngressUpdateHandlerV1";
const PUBLIC_INGRESS_CYCLES_ARGUMENT = "public_ingress_cycles";
const INGRESS_MESSAGE_BASE_CYCLES_13_NODE = "1_200_000";
const INTERCANISTER_CALL_BASE_CYCLES_13_NODE = "260_000";

export function assemble(
  confs: AssemblyConfig,
  options: AssembleOptions = {},
): string {
  return assembleGeneration(confs, options, ASSEMBLER_ID);
}

/**
 * Reproduce the exact predecessor assembler contract for a fresh deployment
 * targeting a pre-v316 Kernel. This intentionally has no browser-origin input:
 * v25 Kernel packages do not expose the v26 configuration initializer.
 */
export function assembleLegacyV25(
  confs: AssemblyConfig,
  options: Omit<AssembleOptions, "browserSurfaceOriginAppIds"> = {},
): string {
  return assembleGeneration(confs, options, LEGACY_V25_ASSEMBLER_ID);
}

function assembleGeneration(
  confs: AssemblyConfig,
  options: AssembleOptions,
  assemblerId: typeof ASSEMBLER_ID | typeof LEGACY_V25_ASSEMBLER_ID,
): string {
  if (options.migrationPlan) {
    assertMemoryMigrationPlan(options.migrationPlan);
  }
  const committedRetirements = normalizeManagedMemoryRetirements(
    options.committedRetirements ?? [],
    "assembler committed managed-memory retirement",
  );
  const validatedDependencyPlan = validate_config(confs);
  const unorderedManifests = get_manifests(confs);
  assertAssemblerSupportsBrowserPermissions(assemblerId, unorderedManifests);
  const dependencyPlan = options.dependencyPlan ?? validatedDependencyPlan;
  if (
    options.dependencyPlan &&
    JSON.stringify(options.dependencyPlan) !==
      JSON.stringify(validatedDependencyPlan)
  ) {
    throw new Error("Dependency plan does not match the assembly manifests");
  }
  const manifests = orderManifests(unorderedManifests, dependencyPlan.order);
  const browserSurfaceOriginAppIds =
    assemblerId === ASSEMBLER_ID
      ? normalizeBrowserSurfaceOriginAppIds(
          options.browserSurfaceOriginAppIds ?? [],
          manifests.map(({ id }) => id),
        )
      : [];
  const runtimeApps = createRuntimeApps(manifests);
  const memories = activeMemories(manifests);
  const migrationPlan = options.migrationPlan ?? {
    upgrades: [],
    removedApps: [],
    destructiveMemoryRoots: [],
  };
  const imports = collectImports(
    manifests,
    memories,
    migrationPlan,
    committedRetirements,
  );
  const kernelManifest = manifests.find(
    (manifest) => manifest.id === "kernel",
  )!;
  const appManifests = manifests.filter((manifest) => manifest.id !== "kernel");
  const deploymentId = options.deploymentId ?? "development";
  const vetKeysEnvironment = options.vetKeysEnvironment ?? "production";
  if (
    vetKeysEnvironment === "production" &&
    options.installationContext !== undefined
  ) {
    throw new Error(
      "Production assembly derives only the compiled IC mainnet installation context",
    );
  }
  const installationContext =
    vetKeysEnvironment === "production"
      ? mainnetTrustedInstallationContext()
      : options.installationContext ?? null;
  const backendReservationUsesPrincipal = manifests.some((manifest) =>
    (
      getCapabilityPlanEntry(
        buildCapabilityPlan(manifest),
        "backend_calls",
      )?.config.install_reservations ?? []
    ).some(
      (reservation) =>
        reservation.kind === "principal" || reservation.kind === "exact",
    ),
  );
  const principalImport = manifests.some(
    (manifest) =>
      manifest.init_arg?.includes("canister_principal") ||
      Object.values(manifest.func ?? {}).some((func) =>
        func.arg?.includes("canister_principal"),
      ) ||
      httpPostUpdateHandlerMounts(manifest).length > 0 ||
      publicIngressRoutes(manifest).length > 0,
  ) || backendReservationUsesPrincipal
    ? 'import NeutronPrim "mo:prim";'
    : "";

  return `

// THIS FILE IS AUTOGENERATED
// YOU WILL GET TYPECHECK ERRORS HERE. DON'T EDIT IT
// INSTEAD EDIT YOUR MODULE OR neutron.json

${principalImport}
${imports.map(({ alias, entry }) => `import ${alias} "${entry}";`).join("\n")}

${createMigrationExpression(migrationPlan, committedRetirements)}
shared({caller = ${INSTALLER}}) persistent actor class Class<system>() = ${ACTOR_SELF} {

${createTrustedInstallationContext(installationContext)}

${memories.map(createMemoryStore).join("\n")}

${createStagedRetiredMemoryStores(migrationPlan)}

${createManagedMemoryRetirementCommit(migrationPlan, deploymentId)}

${createActiveAppInstanceInventory(runtimeApps)}

${createModule(kernelManifest, [], deploymentId)}

${createAppScopes(runtimeApps, deploymentId)}

${createFrontendSurfaceCounts(manifests)}

${assemblerId === ASSEMBLER_ID ? `${createBrowserSurfaceConfiguration(manifests, browserSurfaceOriginAppIds)}\n\n` : ""}${createCapabilityConfiguration(
  appManifests,
  vetKeysEnvironment,
)}

${appManifests
  .map((manifest) =>
    createModule(
      manifest,
      dependencyPlan.dependenciesByConsumer[manifest.id] ?? [],
      deploymentId,
    ),
  )
  .join("\n")}

${createCapabilityRegistryConfiguration(appManifests)}

${createHttpPostUpdateHandlerConfiguration(appManifests)}

${createPublicIngressConfiguration(appManifests)}

${createScheduledTaskConfiguration(appManifests)}

${createRuntimeInfo(
  memories,
  deploymentId,
  options.compilerId ?? "unknown",
  assemblerId,
  kernelManifest.func?.capability_authority_revision?.type === "internal",
)}

    ${KERNEL_INIT}.kernel_authorized_add(${INSTALLER});
}
`;
}

function createTrustedInstallationContext(
  context: TrustedInstallationContextV1 | null,
): string {
  if (context !== null) assertTrustedInstallationContext(context);
  const bytes = context?.networkId ?? [];
  const literal = motokoBlobLiteral(bytes);
  return `
    // Compiler-owned public identity context. This persistent immutable value
    // is initialized only by a trusted fresh-install compile and restored by
    // Motoko before transient actor initialization on every compatible upgrade.
    let NeutronTrustedInstallationNetworkIdV1 : Blob = ${literal};
    transient let NeutronCompiledInstallationNetworkIdV1 : Blob = ${literal};
    transient let NeutronTrustedInstallationContextV1 = do {
        assert(NeutronTrustedInstallationNetworkIdV1.size() == 32);
        var NeutronInstallationNetworkIdNonzeroV1 = false;
        for (NeutronInstallationNetworkIdByteV1 in NeutronTrustedInstallationNetworkIdV1.vals()) {
            if (NeutronInstallationNetworkIdByteV1 != 0) {
                NeutronInstallationNetworkIdNonzeroV1 := true;
            };
        };
        assert(NeutronInstallationNetworkIdNonzeroV1);
        if (NeutronCompiledInstallationNetworkIdV1.size() != 0) {
            assert(NeutronCompiledInstallationNetworkIdV1.size() == 32);
            let NeutronCompiledInstallationNetworkIdValuesV1 =
                NeutronCompiledInstallationNetworkIdV1.vals();
            for (NeutronRetainedInstallationNetworkIdByteV1 in NeutronTrustedInstallationNetworkIdV1.vals()) {
                switch (NeutronCompiledInstallationNetworkIdValuesV1.next()) {
                    case (?NeutronCompiledInstallationNetworkIdByteV1) {
                        assert(
                            NeutronRetainedInstallationNetworkIdByteV1 ==
                            NeutronCompiledInstallationNetworkIdByteV1
                        );
                    };
                    case null assert(false);
                };
            };
            assert(NeutronCompiledInstallationNetworkIdValuesV1.next() == null);
        };
        { network_id = NeutronTrustedInstallationNetworkIdV1 };
    };
`;
}

function collectImports(
  manifests: AssemblyManifest[],
  memories: MemoryOwner[],
  plan: MemoryMigrationPlan,
  committedRetirements: readonly ManagedMemoryRetirement[],
): { alias: string; entry: string }[] {
  const imports = new Map<string, string>();
  for (const manifest of manifests)
    addImport(imports, moduleName(manifest.id), manifest.entry);
  for (const owner of memories) {
    addImport(
      imports,
      schemaAlias(
        owner.manifest.id,
        owner.memoryId,
        owner.memory.version ?? 1,
      ),
      schemaEntry(owner),
    );
  }
  for (const upgrade of plan.upgrades) {
    if (upgrade.kind === "migrate") {
      addImport(
        imports,
        schemaAlias(upgrade.owner, upgrade.memoryId, upgrade.from),
        upgrade.oldSchemaEntry,
      );
      for (const edge of upgrade.path) {
        addImport(
          imports,
          migrationAlias(
            upgrade.owner,
            upgrade.memoryId,
            edge.from,
            edge.to,
          ),
          edge.entry,
        );
      }
    }
    if (upgrade.kind === "retire") {
      addImport(
        imports,
        retiredSchemaAlias(upgrade.owner, upgrade.memoryId, upgrade.from),
        upgrade.oldSchemaEntry,
      );
    }
  }
  for (const retirement of committedRetirements) {
    addImport(
      imports,
      retiredSchemaAlias(
        retirement.owner,
        retirement.memoryId,
        retirement.version,
      ),
      retirement.schemaEntry,
    );
  }
  return [...imports].map(([alias, entry]) => ({ alias, entry }));
}

function addImport(
  imports: Map<string, string>,
  alias: string,
  entry: string,
): void {
  no_inject(alias);
  no_module_path(entry);
  const existing = imports.get(alias);
  if (existing && existing !== entry) {
    throw new Error(`Import alias ${alias} resolves to multiple modules`);
  }
  imports.set(alias, entry);
}

function createMigrationExpression(
  plan: MemoryMigrationPlan,
  committedRetirements: readonly ManagedMemoryRetirement[],
): string {
  const changed = plan.upgrades.filter(
    (upgrade) => upgrade.kind === "migrate" || upgrade.kind === "retire",
  );
  if (changed.length === 0 && committedRetirements.length === 0) return "";

  const input = [
    ...changed.map(
      (upgrade) =>
        `    ${managedMemoryStoreName(upgrade.owner, upgrade.memoryId)} : ${oldStoreType(upgrade)};`,
    ),
    ...committedRetirements.map(
      (retirement) =>
        `    ${retiredManagedMemoryStoreName(retirement.owner, retirement.memoryId)} : ?${retiredDescriptorStoreType(retirement)};`,
    ),
  ].join("\n");
  const migrated = changed.filter(
    (upgrade): upgrade is Extract<MemoryUpgrade, { kind: "migrate" }> =>
      upgrade.kind === "migrate",
  );
  const retiring = changed.filter(
    (upgrade): upgrade is Extract<MemoryUpgrade, { kind: "retire" }> =>
      upgrade.kind === "retire",
  );
  const output = [
    ...migrated.map(
      (upgrade) =>
        `    ${managedMemoryStoreName(upgrade.owner, upgrade.memoryId)} : ${managedStoreType(upgrade.owner, upgrade.memoryId, upgrade.to)};`,
    ),
    ...retiring.map(
      (upgrade) =>
        `    ${retiredManagedMemoryStoreName(upgrade.owner, upgrade.memoryId)} : ?${oldStoreType(upgrade)};`,
    ),
  ].join("\n");
  const values = [
    ...migrated.map(
      (upgrade) =>
        `    ${managedMemoryStoreName(upgrade.owner, upgrade.memoryId)} = #v${upgrade.to}(${migrationValue(upgrade, changed)});`,
    ),
    ...retiring.map(
      (upgrade) =>
        `    ${retiredManagedMemoryStoreName(upgrade.owner, upgrade.memoryId)} = ?NeutronOld.${managedMemoryStoreName(upgrade.owner, upgrade.memoryId)};`,
    ),
  ].join("\n");
  const finalizationGuards = committedRetirements
    .map(
      (retirement) => `  switch (NeutronOld.${retiredManagedMemoryStoreName(retirement.owner, retirement.memoryId)}) {
    case (null) {};
    case (?_) assert false;
  };`,
    )
    .join("\n");

  return `(with migration = func(NeutronOld : {\n${input}\n}) : {\n${output}\n} {\n${finalizationGuards}\n  {\n${values}\n  }\n})`;
}

function oldStoreType(
  upgrade: Extract<MemoryUpgrade, { kind: "migrate" | "retire" }>,
): string {
  if (upgrade.kind === "retire") {
    return `{ #v${upgrade.from} : ${retiredSchemaAlias(upgrade.owner, upgrade.memoryId, upgrade.from)}.Mem }`;
  }
  return managedStoreType(upgrade.owner, upgrade.memoryId, upgrade.from);
}

function migrationValue(
  upgrade: Extract<MemoryUpgrade, { kind: "migrate" }>,
  changed: Array<Extract<MemoryUpgrade, { kind: "migrate" | "retire" }>>,
): string {
  let value = `(switch (NeutronOld.${managedMemoryStoreName(upgrade.owner, upgrade.memoryId)}) { case (#v${upgrade.from}(NeutronValue)) NeutronValue })`;
  for (const edge of upgrade.path) {
    const consumed = (edge.consume ?? []).map((memoryId) => {
      const retirement = changed.find(
        (candidate) =>
          candidate.kind === "retire" &&
          candidate.owner === upgrade.owner &&
          candidate.memoryId === memoryId,
      );
      if (!retirement) {
        throw new Error(
          `Migration ${upgrade.memoryId} ${edge.from}->${edge.to} is missing consumed root ${memoryId}`,
        );
      }
      return `(switch (NeutronOld.${managedMemoryStoreName(upgrade.owner, memoryId)}) { case (#v${retirement.from}(NeutronValue)) NeutronValue })`;
    });
    value = `${migrationAlias(upgrade.owner, upgrade.memoryId, edge.from, edge.to)}.migrate(${[value, ...consumed].join(", ")})`;
  }
  return value;
}

function createMemoryStore({
  manifest,
  memoryId,
  memory,
}: MemoryOwner): string {
  const version = no_inject(memory.version ?? 1);
  no_inject(memoryId);
  const owner = manifest.id;
  const physicalStem = managedMemoryPhysicalStem(owner, memoryId);
  const store = managedMemoryStoreName(owner, memoryId);
  const binding = managedMemoryBindingName(owner, memoryId);
  const type = `${schemaAlias(owner, memoryId, Number(version))}.Mem`;
  const initializer = `${schemaAlias(owner, memoryId, Number(version))}.init()`;

  return `
    type NeutronMemoryType_${physicalStem} = {
        #v${version} : ${type};
    };

    let ${store}:NeutronMemoryType_${physicalStem} = #v${version}(${initializer});

    transient let #v${version}(${binding}) = ${store};
`;
}

function createStagedRetiredMemoryStores(plan: MemoryMigrationPlan): string {
  return plan.upgrades
    .filter(
      (upgrade): upgrade is Extract<MemoryUpgrade, { kind: "retire" }> =>
        upgrade.kind === "retire",
    )
    .map(
      (upgrade) => `
    var ${retiredManagedMemoryStoreName(upgrade.owner, upgrade.memoryId)} : ?${oldStoreType(upgrade)} = null;
`,
    )
    .join("\n");
}

function createManagedMemoryRetirementCommit(
  plan: MemoryMigrationPlan,
  deploymentId: string,
): string {
  no_inject(deploymentId);
  const clears = plan.upgrades
    .filter(
      (upgrade): upgrade is Extract<MemoryUpgrade, { kind: "retire" }> =>
        upgrade.kind === "retire",
    )
    .map(
      (upgrade) =>
        `        ${retiredManagedMemoryStoreName(upgrade.owner, upgrade.memoryId)} := null;`,
    )
    .join("\n");
  return `
    func ${COMMIT_MEMORY_RETIREMENTS}(NeutronCommitDeploymentId : Text) : () {
        assert(NeutronCommitDeploymentId == ${motokoTextLiteral(deploymentId)});
${clears}
    };
`;
}

function createModule(
  conf: AssemblyManifest,
  dependencies: ResolvedAppDependency[],
  deploymentId: string,
): string {
  const modname = conf.id;
  const importedModule = moduleName(modname);
  no_inject(modname);
  if (modname.length < 3) {
    throw new Error(`Invalid module name (at least 3 characters: ${modname}`);
  }
  const capabilityPlan = buildCapabilityPlan(conf);

  const backendEnvironment =
    conf.id === "kernel"
      ? null
      : createBackendEnvironment(conf, dependencies, capabilityPlan);
  const initArgs =
    conf.id === "kernel"
      ? (conf.init_arg ?? []).map((arg) =>
          resolveKernelInitArgument(conf, arg, deploymentId),
        )
      : backendEnvironment
        ? [backendEnvironmentName(modname)]
        : [];
  const moduleInit = `
${backendEnvironment?.source ?? ""}
    transient let ${appInitName(modname)} = ${importedModule}.Init(${initArgs.join(",")});
`;

  return `
${moduleInit}

${
  conf.func
    ? Object.keys(conf.func)
        .map((name) => {
          const func = conf.func?.[name];
          if (!func) throw new Error(`Missing function ${name}`);
          return create_func(name, func, modname);
        })
        .join("\n")
    : ""
}
`;
}

function moduleName(appId: string): string {
  return `NeutronModule_${appPhysicalStem(appId)}`;
}

function appInitName(appId: string): string {
  return appId === "kernel"
    ? KERNEL_INIT
    : `NeutronAppInit_${appPhysicalStem(appId)}`;
}

function backendEnvironmentName(appId: string): string {
  return `NeutronAppEnvironment_${appPhysicalStem(appId)}`;
}

function appScopeName(appId: string): string {
  return `NeutronAppScope_${appPhysicalStem(appId)}`;
}

function createAppScopes(
  runtimeApps: RuntimeApp[],
  deploymentId: string,
): string {
  no_inject(deploymentId);
  return runtimeApps
    .map(
      (app) =>
        `    transient let ${appScopeName(app.id)} = ${KERNEL_INIT}.app_scope(${motokoTextLiteral(app.id)}, ${motokoTextLiteral(deploymentId)});`,
    )
    .join("\n");
}

function createFrontendSurfaceCounts(manifests: AssemblyManifest[]): string {
  const residentFrames = manifests.filter((manifest) =>
    getCapabilityPlanEntry(buildCapabilityPlan(manifest), "background_endpoint")
  ).length;
  return `    ${KERNEL_INIT}.configure_frontend_surface_counts({
      app_instances = ${manifests.length};
      resident_frames = ${residentFrames};
    });`;
}

export function normalizeBrowserSurfaceOriginAppIds(
  appIds: readonly string[],
  manifestIds: Iterable<string>,
): string[] {
  const available = new Set(manifestIds);
  const normalized = new Set<string>();
  for (const appId of appIds) {
    if (appId === "kernel") {
      throw new Error("The Kernel cannot use an app browser-surface origin");
    }
    if (!available.has(appId)) {
      throw new Error(`Browser-surface origin app ${appId} is not assembled`);
    }
    if (normalized.has(appId)) {
      throw new Error(`Duplicate browser-surface origin app ${appId}`);
    }
    normalized.add(appId);
  }
  return [...normalized].sort(compareCanonicalText);
}

function createBrowserSurfaceConfiguration(
  manifests: AssemblyManifest[],
  browserSurfaceOriginAppIds: readonly string[],
): string {
  // The empty target is also the exact v25 compatibility shape. Omitting the
  // additive initializer lets the current compiler reconstruct a released
  // predecessor actor without pretending that it adopted v26 origins.
  if (browserSurfaceOriginAppIds.length === 0) return "";
  const originApps = new Set(browserSurfaceOriginAppIds);
  const declarations = [...manifests]
    .sort((left, right) => compareCanonicalText(left.id, right.id))
    .map((manifest) => {
      const plan = buildCapabilityPlan(manifest);
      const tiles = (
        getCapabilityPlanEntry(plan, "tile_endpoints")?.config.endpoints ?? []
      )
        .map(({ id }) => `{
          id = ${motokoTextLiteral(id)};
        }`)
        .join(", ");
      const ordinaryBackground =
        getCapabilityPlanEntry(plan, "background_endpoint")?.config
          .frame_security === "credentialless_opaque_v1";
      const tray = getCapabilityPlanEntry(plan, "tray_endpoint") !== undefined;
      return `{
        app_scope = ${appScopeName(manifest.id)};
        surface_origins = ${originApps.has(manifest.id)};
        tiles = [${tiles}];
        tray = ${tray};
        ordinary_background = ${ordinaryBackground};
      }`;
    });
  return `    ${KERNEL_INIT}.configure_app_browser_surfaces([${declarations.join(",\n")}]);`;
}

function createAppCallsEnvironmentGroup(
  dependencies: ResolvedAppDependency[],
): string {
  if (dependencies.length === 0) return "";
  const fields = dependencies
    .map((dependency) => {
      no_inject(dependency.alias);
      no_inject(dependency.provider);
      const functions = dependency.functions
        .map((name) => {
          no_inject(name);
          return `        ${name} = ${privateFunctionName(dependency.provider, name)};`;
        })
        .join("\n");
      return `      ${dependency.alias} = {\n${functions}\n      };`;
    })
    .join("\n");
  return `      app_calls = {\n${fields}\n      };`;
}

function createCapabilityConfiguration(
  manifests: AssemblyManifest[],
  environment: VetKeysEnvironment,
): string {
  const declarations = manifests
    .filter(
      (manifest) =>
        getCapabilityPlanEntry(
          buildCapabilityPlan(manifest),
          "backend_calls",
        ) ||
        getCapabilityPlanEntry(buildCapabilityPlan(manifest), "randomness") ||
        getCapabilityPlanEntry(
          buildCapabilityPlan(manifest),
          "chain_key_signing",
        ) ||
        getCapabilityPlanEntry(buildCapabilityPlan(manifest), "stable_store") ||
        getCapabilityPlanEntry(buildCapabilityPlan(manifest), "https_outcalls") ||
        getCapabilityPlanEntry(buildCapabilityPlan(manifest), "vetkeys") ||
        getCapabilityPlanEntry(buildCapabilityPlan(manifest), "connections") ||
        getCapabilityPlanEntry(
          buildCapabilityPlan(manifest),
          "persistent_browser_storage",
        ) ||
        getCapabilityPlanEntry(
          buildCapabilityPlan(manifest),
          "dedicated_resident_origin",
        ) ||
        getCapabilityPlanEntry(
          buildCapabilityPlan(manifest),
          "background_endpoint",
        ) ||
        getCapabilityPlanEntry(
          buildCapabilityPlan(manifest),
          "public_ingress",
        ) ||
        getCapabilityPlanEntry(buildCapabilityPlan(manifest), "http_routes") ||
        getCapabilityPlanEntry(
          buildCapabilityPlan(manifest),
          "certified_assets",
        ),
    )
    // Module initialization follows dependency order, but capability brokers
    // consume one canonical declaration inventory. Keep that inventory sorted
    // by app id so dependency topology cannot trip the kernel's duplicate/order
    // invariant or make actor initialization order-dependent.
    .sort((left, right) => compareCanonicalText(left.id, right.id))
    .map((manifest) => {
      const plan = buildCapabilityPlan(manifest);
      const backendCalls = getCapabilityPlanEntry(
        plan,
        "backend_calls",
      )?.config;
      const randomness = getCapabilityPlanEntry(plan, "randomness")?.config;
      const chainKeySigning = getCapabilityPlanEntry(
        plan,
        "chain_key_signing",
      )?.config;
      const stableStore = getCapabilityPlanEntry(plan, "stable_store")?.config;
      const httpsOutcalls = getCapabilityPlanEntry(
        plan,
        "https_outcalls",
      )?.config;
      const vetkeys = getCapabilityPlanEntry(plan, "vetkeys")?.config;
      const connections = getCapabilityPlanEntry(
        plan,
        "connections",
      )?.config;
      const backgroundEndpoint = getCapabilityPlanEntry(
        plan,
        "background_endpoint",
      )?.config;
      const frameSecurity =
        backgroundEndpoint?.frame_security ?? "credentialless_opaque_v1";
      const residentBackgroundPath = backgroundEndpoint
        ? `?${motokoTextLiteral(
            `/app/${manifest.id}/${backgroundEndpoint.path}`,
          )}`
        : "null";
      const publicIngress = getCapabilityPlanEntry(
        plan,
        "public_ingress",
      )?.config;
      const httpRoutes = getCapabilityPlanEntry(plan, "http_routes")?.config;
      const certifiedAssets = getCapabilityPlanEntry(
        plan,
        "certified_assets",
      )?.config;
      const scopes = (backendCalls?.reservation_scopes ?? [])
        .map((scope) => motokoTextLiteral(scope))
        .join(", ");
      return `{
        app_scope = ${appScopeName(manifest.id)};
        backend_calls = ${
          backendCalls
            ? `?{
          reservation_scopes = [${scopes}];
          install_reservations = [${(backendCalls.install_reservations ?? [])
            .map(motokoBackendCallInstallReservation)
            .join(", ")}];
          max_concurrency = ${backendCalls.max_concurrency};
          max_cycles_per_call = ${backendCalls.max_cycles_per_call};
          max_cycles_per_day = ${backendCalls.max_cycles_per_day};
        }`
            : "null"
        };
        randomness = ${
          randomness
            ? "?{}"
            : "null"
        };
        chain_key_signing = ${
          chainKeySigning
            ? `?{
          slots = [${chainKeySigning.slots
            .map(
              (slot) => `{
            id = ${motokoTextLiteral(slot.id)};
            algorithm = #${slot.algorithm};
            purpose = ${motokoTextLiteral(slot.purpose)};
            max_assertion_bytes = ${slot.max_assertion_bytes};
          }`,
            )
            .join(", ")}];
        }`
            : "null"
        };
        stable_store = ${
          stableStore
            ? `?{
          stores = [${stableStore.stores
            .map(
              (store) => `{
            id = ${motokoTextLiteral(store.id)};
            purpose = ${motokoTextLiteral(store.purpose)};
            schema_version = ${store.schema_version};
            max_entries = ${store.max_entries};
            max_key_bytes = ${store.max_key_bytes};
            max_value_bytes = ${store.max_value_bytes};
            max_bytes = ${store.max_bytes};
          }`,
            )
            .join(", ")}];
        }`
            : "null"
        };
        https_outcalls = ${
          httpsOutcalls
            ? `?{
          endpoints = [${httpsOutcalls.endpoints
            .map(
              (endpoint) => `{
            id = ${motokoTextLiteral(endpoint.id)};
            url_prefix = ${motokoTextLiteral(endpoint.url_prefix)};
            methods = [${endpoint.methods.map((method) => `#${method}`).join(", ")}];
            request_headers = [${endpoint.request_headers.map(motokoTextLiteral).join(", ")}];
            max_request_bytes = ${endpoint.max_request_bytes};
            max_response_bytes = ${endpoint.max_response_bytes};
            transform = #strip_headers;
          }`,
            )
            .join(", ")}];
        }`
            : "null"
        };
        vetkeys = ${
          vetkeys
            ? `?{
          description = ${motokoTextLiteral(vetkeys.description)};
          slots = [${vetkeys.slots
            .map(
              (slot) =>
                `{ id = ${motokoTextLiteral(slot.id)}; purpose = ${motokoTextLiteral(slot.purpose)} }`,
            )
            .join(", ")}];
        }`
            : "null"
        };
        connections = ${
          connections
            ? `?{
          providers = [${connections.providers
            .map(
              (provider) =>
                `{ provider = ${motokoTextLiteral(provider.provider)}; scopes = [${provider.scopes
                  .map((scope) => motokoTextLiteral(scope))
                  .join(", ")}] }`,
            )
            .join(", ")}];
        }`
            : "null"
        };
        resident_frame_security = #${frameSecurity};
        resident_background_path = ${residentBackgroundPath};
        public_ingress = ${
          publicIngress
            ? `?{
          routes = [${publicIngress.routes
            .map((route) =>
              createPublicIngressRouteDeclaration(manifest, route),
            )
            .join(", ")}];
        }`
            : "null"
        };
        http_routes_v1 = ${
          httpRoutes?.api === 1
            ? `?{
          api = 1;
          mounts = [${httpRoutes.mounts
            .map((mount) => createHttpRouteMountDeclaration(mount))
            .join(", ")}];
        }`
            : "null"
        };
        certified_assets = ${
          certifiedAssets
            ? createCertifiedAssetsDeclaration(certifiedAssets)
            : "null"
        };
      }`;
    });
  const environmentVariant =
    environment === "production" ? "#production" : "#local";
  const chainKeyNames = environment === "production"
    ? `{
      ecdsa_secp256k1 = ?"key_1";
      schnorr_bip340secp256k1 = ?"key_1";
      schnorr_ed25519 = ?"key_1";
    }`
    : `{
      ecdsa_secp256k1 = ?"dfx_test_key";
      schnorr_bip340secp256k1 = null;
      schnorr_ed25519 = null;
    }`;
  return `    ${KERNEL_INIT}.configure_app_capabilities([${declarations.join(",\n")}], {
      vetkeys_environment = ${environmentVariant};
      chain_key_signing_keys = ${chainKeyNames};
    });`;
}

function createPublicIngressRouteDeclaration(
  manifest: AssemblyManifest,
  route: NeutronPublicIngressRouteV1,
): string {
  const fingerprint = publicIngressRouteFingerprint(manifest, route);
  const maxCallsPerHour =
    route.mode === "update" ? `?${route.max_calls_per_hour}` : "null";
  const maxCallsPerCallerPerHour =
    route.mode === "update" &&
    route.max_calls_per_caller_per_hour !== undefined
      ? `?${route.max_calls_per_caller_per_hour}`
      : "null";
  const requiredCycles =
    route.mode === "update" && route.caller === "canister"
      ? `?${route.required_cycles}`
      : "null";
  return `{ protocol = ${motokoTextLiteral(route.protocol)}; id = ${motokoTextLiteral(route.id)}; handler = ${motokoTextLiteral(route.handler)}; mode = #${route.mode}_; caller = #${route.caller}; max_request_bytes = ${route.max_request_bytes}; max_response_bytes = ${route.max_response_bytes}; max_calls_per_hour = ${maxCallsPerHour}; max_calls_per_caller_per_hour = ${maxCallsPerCallerPerHour}; required_cycles = ${requiredCycles}; fingerprint = ${motokoTextLiteral(fingerprint)} }`;
}

function publicIngressRouteFingerprint(
  manifest: AssemblyManifest,
  route: NeutronPublicIngressRouteV1,
): string {
  const resourceId = publicIngressResourceId(route.protocol, route.id);
  const registration = projectRuntimeCapabilityRegistrationsV1(
    buildCapabilityPlan(manifest),
  ).find(
    (candidate) =>
      candidate.kind === "public_ingress" &&
      candidate.resource_id === resourceId,
  );
  if (!registration) {
    throw new Error(
      `Missing public_ingress runtime registration for ${manifest.id}.${route.protocol}.${route.id}`,
    );
  }
  return registration.declaration_fingerprint;
}

function createHttpRouteMountDeclaration(
  mount: NeutronHttpPostUpdateHandlerRouteMountConfig,
): string {
  const prefix =
    mount.surface === "app_host"
      ? `?${motokoTextLiteral(mount.prefix)}`
      : "null";
  const handler = `?${motokoTextLiteral(
    requireHttpPostUpdateHandlerText(mount.handler, mount.id, "handler"),
  )}`;
  const maxCallsPerHour = `?${requireHttpPostUpdateHandlerNat(
    mount.max_calls_per_hour,
    mount.id,
    "max_calls_per_hour",
  )}`;
  const forwardHeaders = (mount.forward_headers ?? [])
    .map(motokoTextLiteral)
    .join(", ");
  return `{ id = ${motokoTextLiteral(mount.id)}; surface = ${motokoTextLiteral(mount.surface)}; prefix = ${prefix}; methods = [${mount.methods.map(motokoTextLiteral).join(", ")}]; mode = ${motokoTextLiteral(mount.mode)}; max_request_bytes = ${mount.max_request_bytes}; max_response_bytes = ${mount.max_response_bytes}; handler = ${handler}; max_calls_per_hour = ${maxCallsPerHour}; forward_headers = [${forwardHeaders}] }`;
}

function createCertifiedAssetsDeclaration(
  certifiedAssets: NonNullable<
    NonNullable<AssemblyManifest["capabilities"]>["certified_assets"]
  >,
): string {
  const collections = certifiedAssets.collections
    .map((collection) => {
      const pathPrefix =
        "path_prefix" in collection && collection.path_prefix !== undefined
          ? `?${motokoTextLiteral(collection.path_prefix)}`
          : "null";
      const exactPath =
        "exact_path" in collection && collection.exact_path !== undefined
          ? `?${motokoTextLiteral(collection.exact_path)}`
          : "null";
      const maxObjectBytes =
        collection.max_object_bytes === undefined
          ? "null"
          : `?${collection.max_object_bytes}`;
      return `{
            id = ${motokoTextLiteral(collection.id)};
            mount = ${motokoTextLiteral(collection.mount)};
            kind = ${motokoTextLiteral(collection.kind)};
            path_prefix = ${pathPrefix};
            exact_path = ${exactPath};
            max_object_bytes = ${maxObjectBytes};
          }`;
    })
    .join(", ");
  return `?{
          api = ${certifiedAssets.api};
          max_entries = ${certifiedAssets.max_entries};
          max_committed_bytes = ${certifiedAssets.max_committed_bytes};
          max_object_bytes = ${certifiedAssets.max_object_bytes};
          max_pending_stages = ${certifiedAssets.max_pending_stages};
          max_staged_bytes = ${certifiedAssets.max_staged_bytes};
          max_batch_operations = ${certifiedAssets.max_batch_operations};
          max_batch_bytes = ${certifiedAssets.max_batch_bytes};
          max_idempotency_receipts = ${certifiedAssets.max_idempotency_receipts};
          collections = [${collections}];
        }`;
}

function requireHttpPostUpdateHandlerText(
  value: unknown,
  mountId: string,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`http_post_update_handler mount ${mountId} is missing ${field}`);
  }
  return value;
}

function requireHttpPostUpdateHandlerNat(
  value: unknown,
  mountId: string,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`http_post_update_handler mount ${mountId} is missing ${field}`);
  }
  return Number(value);
}

function createCapabilityRegistryConfiguration(
  manifests: AssemblyManifest[],
): string {
  const registrations = manifests
    .flatMap((manifest) => {
      const plan = buildCapabilityPlan(manifest);
      const planFingerprint = fingerprintCapabilityPlanWireV1(
        toCapabilityPlanWireV1(plan),
      );
      return projectRuntimeCapabilityRegistrationsV1(plan).map(
        (registration) => ({
          appId: manifest.id,
          planFingerprint,
          registration,
        }),
      );
    })
    .sort((left, right) => {
      const app = compareCanonicalText(left.appId, right.appId);
      if (app !== 0) return app;
      const kind = compareCanonicalText(
        left.registration.kind,
        right.registration.kind,
      );
      return (
        kind ||
        compareCanonicalText(
          left.registration.resource_id,
          right.registration.resource_id,
        )
      );
    });

  const records = registrations.map(
    ({ appId, planFingerprint, registration }) => {
      no_inject(appId);
      no_inject(registration.kind);
      no_inject(registration.declaration_fingerprint);
      return `{
        scope = ${appScopeName(appId)};
        plan_fingerprint = ${motokoTextLiteral(planFingerprint)};
        kind = #${registration.kind};
        resource_id = ${motokoTextLiteral(registration.resource_id)};
        api = ${registration.api};
        declaration_fingerprint = ${motokoTextLiteral(registration.declaration_fingerprint)};
        grant = #${registration.grant};
        toggleable = ${registration.toggleable};
      }`;
    },
  );

  return `    ${KERNEL_INIT}.configure_capability_registry([${records.join(",\n")}], ${ACTOR_SELF});`;
}

function createBackendCapabilitiesEnvironmentGroup(
  conf: AssemblyManifest,
  plan: CapabilityPlan,
): string {
  const backend = getCapabilityPlanEntry(plan, "backend_environment");
  const fields = (backend?.config.interfaces ?? []).map(({ id }) => {
    if (id === "deferred_timers") {
      return `        deferred_timers = ${KERNEL_INIT}.deferred_timers_capability(${appScopeName(conf.id)});`;
    }
    if (id === "backend_calls") {
      return `        backend_calls = ${KERNEL_INIT}.backend_calls_capability(${appScopeName(conf.id)}, ${ACTOR_SELF});`;
    }
    if (id === "randomness") {
      return `        randomness = ${KERNEL_INIT}.randomness_capability(${appScopeName(conf.id)});`;
    }
    if (id === "chain_key_signing") {
      return `        chain_key_signing = ${KERNEL_INIT}.chain_key_signing_capability(${appScopeName(conf.id)});`;
    }
    if (id === "stable_store") {
      return `        stable_store = ${KERNEL_INIT}.stable_store_capability(${appScopeName(conf.id)});`;
    }
    if (id === "https_outcalls") {
      return `        https_outcalls = ${KERNEL_INIT}.https_outcalls_capability(${appScopeName(conf.id)});`;
    }
    if (id === "vetkeys_public") {
      return `        vetkeys_public = ${KERNEL_INIT}.vetkeys_public_capability(${appScopeName(conf.id)}, ${ACTOR_SELF});`;
    }
    if (id === "certified_assets") {
      return `        certified_assets = ${KERNEL_INIT}.certified_assets_capability(${appScopeName(conf.id)});`;
    }
    const exhaustive: never = id;
    throw new Error(
      `App ${conf.id} selected unsupported backend interface ${String(exhaustive)}`,
    );
  });
  if (fields.length === 0) return "";
  return `      capabilities = {
${fields.join("\n")}
      };`;
}

function createStableMemoryEnvironmentGroup(
  conf: AssemblyManifest,
  plan: CapabilityPlan,
): string {
  const memory = getCapabilityPlanEntry(
    plan,
    "stable_memory",
  )?.config.resources;
  if (!memory || memory.length === 0) return "";
  const fields = memory.map(({ id }) => {
    no_inject(id);
    return `        ${id} = ${managedMemoryBindingName(conf.id, id)};`;
  });
  return `      stable_memory = {
${fields.join("\n")}
      };`;
}

function createBackendEnvironment(
  conf: AssemblyManifest,
  dependencies: ResolvedAppDependency[],
  plan = buildCapabilityPlan(conf),
): { source: string } | null {
  if (conf.id === "kernel") {
    throw new Error("Kernel cannot receive an ordinary app backend environment");
  }
  const groups = [
    createStableMemoryEnvironmentGroup(conf, plan),
    createAppCallsEnvironmentGroup(dependencies),
    createBackendCapabilitiesEnvironmentGroup(conf, plan),
  ].filter(Boolean);
  if (groups.length === 0) return null;
  groups.unshift(
    "      installation = NeutronTrustedInstallationContextV1;",
  );
  return {
    source: `    transient let ${backendEnvironmentName(conf.id)} = {
${groups.join("\n")}
    };`,
  };
}

function createHttpPostUpdateHandlerConfiguration(
  manifests: AssemblyManifest[],
): string {
  const handlers = manifests.flatMap((manifest) =>
    httpPostUpdateHandlerMounts(manifest).map((mount) => ({ manifest, mount })),
  );
  if (handlers.length === 0) return "";

  const wrappers = handlers
    .map(({ manifest, mount }) => {
      const wrapper = httpPostUpdateHandlerName(manifest.id, mount.id);
      const responseType = `${moduleName("kernel")}.HttpPostUpdateHandlerResponseV1`;
      return `
    public shared({ caller = NeutronHttpPostUpdateHandlerCaller }) func ${wrapper}(NeutronDispatch : ${moduleName("kernel")}.HttpPostUpdateHandlerDispatchV1) : async ${responseType} {
        assert(NeutronHttpPostUpdateHandlerCaller == NeutronPrim.principalOfActor(${ACTOR_SELF}));
        ${KERNEL_INIT}.http_post_update_handler_dispatch_begin(${appScopeName(manifest.id)}, ${motokoTextLiteral(mount.id)}, NeutronDispatch);
        let NeutronAppUsageMeasurement = ${KERNEL_INIT}.app_usage_instruction_begin(${appScopeName(manifest.id)}, ${INTERCANISTER_CALL_BASE_CYCLES_13_NODE});
        let NeutronHttpPostUpdateHandlerResponse : ${responseType} = try {
            ${privateFunctionName(manifest.id, mount.handler)}(NeutronDispatch.request)
        } catch (NeutronHandlerError) {
            ${KERNEL_INIT}.app_usage_instruction_finish(NeutronAppUsageMeasurement);
            throw NeutronHandlerError;
        };
        ${KERNEL_INIT}.app_usage_instruction_finish(NeutronAppUsageMeasurement);
        ${KERNEL_INIT}.http_post_update_handler_dispatch_finish(${appScopeName(manifest.id)}, ${motokoTextLiteral(mount.id)}, NeutronDispatch, NeutronHttpPostUpdateHandlerResponse);
        NeutronHttpPostUpdateHandlerResponse
    };`;
    })
    .join("\n");

  const registrations = handlers
    .map(({ manifest, mount }) => {
      const wrapper = httpPostUpdateHandlerName(manifest.id, mount.id);
      return `{
        app_scope = ${appScopeName(manifest.id)};
        mount_id = ${motokoTextLiteral(mount.id)};
        handler = ${ACTOR_SELF}.${wrapper};
      }`;
    })
    .join(",\n");

  return `${wrappers}

    ${KERNEL_INIT}.configure_http_post_update_handlers([${registrations}]);`;
}

function httpPostUpdateHandlerMounts(
  manifest: AssemblyManifest,
): NeutronHttpPostUpdateHandlerRouteMountConfig[] {
  const mounts = getCapabilityPlanEntry(
    buildCapabilityPlan(manifest),
    "http_routes",
  )?.config.mounts;
  return (mounts ?? []).filter(
    (
      mount,
    ): mount is NeutronHttpPostUpdateHandlerRouteMountConfig =>
      mount.mode === "http_post_update_handler",
  );
}

function httpPostUpdateHandlerName(appId: string, mountId: string): string {
  return physicalAppMethodName(appId, `http_post_update_${mountId}`);
}

function publicIngressRoutes(
  manifest: AssemblyManifest,
): NeutronPublicIngressRouteV1[] {
  return (
    getCapabilityPlanEntry(
      buildCapabilityPlan(manifest),
      "public_ingress",
    )?.config.routes ?? []
  );
}

function createPublicIngressConfiguration(
  manifests: AssemblyManifest[],
): string {
  const bindings = manifests
    .flatMap((manifest) =>
      publicIngressRoutes(manifest).map((route) => ({ manifest, route })),
    )
    .sort(
      (left, right) =>
        compareCanonicalText(left.manifest.id, right.manifest.id) ||
        compareCanonicalText(left.route.protocol, right.route.protocol) ||
        compareCanonicalText(left.route.id, right.route.id),
    );
  if (bindings.length === 0) return "";

  const groups = new Map<
    string,
    {
      manifest: AssemblyManifest;
      protocol: string;
      mode: "query" | "update";
    }
  >();
  for (const { manifest, route } of bindings) {
    const key = `${manifest.id}\u0000${route.protocol}\u0000${route.mode}`;
    groups.set(key, {
      manifest,
      protocol: route.protocol,
      mode: route.mode,
    });
  }
  const dispatchers = [...groups.values()]
    .sort(
      (left, right) =>
        compareCanonicalText(left.manifest.id, right.manifest.id) ||
        compareCanonicalText(left.protocol, right.protocol) ||
        compareCanonicalText(left.mode, right.mode),
    )
    .map(createPublicIngressDispatcher)
    .join("\n");

  const updateBindings = bindings.filter(
    ({ route }) => route.mode === "update",
  );
  const updateDispatcher = createPublicIngressUpdateHandler(updateBindings);
  const registrations = bindings
    .map(({ manifest, route }) => {
      const handler =
        route.mode === "query"
          ? `#query_(func (NeutronIngressRequest : ${moduleName("kernel")}.PublicIngressHandlerRequestV1) : Blob {\n${createPublicIngressHandlerInvocation(
              manifest,
              route,
              "NeutronIngressRequest",
              "          ",
            )}\n        })`
          : `#update_(${ACTOR_SELF}.${PUBLIC_INGRESS_UPDATE_HANDLER})`;
      return `{
        app_scope = ${appScopeName(manifest.id)};
        protocol = ${motokoTextLiteral(route.protocol)};
        method = ${motokoTextLiteral(route.id)};
        handler = ${handler};
      }`;
    })
    .join(",\n");

  return `${dispatchers}
${updateDispatcher}
    ${KERNEL_INIT}.configure_public_ingress_handlers([${registrations}]);`;
}

function createPublicIngressDispatcher({
  manifest,
  protocol,
  mode,
}: {
  manifest: AssemblyManifest;
  protocol: string;
  mode: "query" | "update";
}): string {
  const method = physicalPublicIngressMethodName(manifest.id, protocol, mode);
  const systemInstantiation = mode === "update" ? "<system>" : "";
  const call = `${KERNEL_INIT}.public_ingress_${mode}${systemInstantiation}(${appScopeName(manifest.id)}, ${motokoTextLiteral(protocol)}, NeutronIngressCaller, NeutronIngressRequest)`;
  if (mode === "query") {
    return `
    public query({ caller = NeutronIngressCaller }) func ${method}(NeutronIngressRequest : ${moduleName("kernel")}.PublicIngressRequestV1) : async ${moduleName("kernel")}.PublicIngressResultV1 {
        ${call}
    };`;
  }
  return `
    public shared({ caller = NeutronIngressCaller }) func ${method}(NeutronIngressRequest : ${moduleName("kernel")}.PublicIngressRequestV1) : async ${moduleName("kernel")}.PublicIngressResultV1 {
        await* ${call}
    };`;
}

function createPublicIngressUpdateHandler(
  bindings: Array<{
    manifest: AssemblyManifest;
    route: NeutronPublicIngressRouteV1;
  }>,
): string {
  if (bindings.length === 0) return "";
  const branches = bindings
    .map(({ manifest, route }, index) => {
      const condition = `NeutronDispatch.app_scope == ${appScopeName(manifest.id)} and NeutronDispatch.protocol == ${motokoTextLiteral(route.protocol)} and NeutronDispatch.method == ${motokoTextLiteral(route.id)}`;
      return `${index === 0 ? "if" : "else if"} (${condition}) {
            ${KERNEL_INIT}.public_ingress_dispatch_begin(${appScopeName(manifest.id)}, ${motokoTextLiteral(route.protocol)}, ${motokoTextLiteral(route.id)}, NeutronDispatch);
            let NeutronAppUsageMeasurement = ${KERNEL_INIT}.app_usage_instruction_begin(${appScopeName(manifest.id)}, ${INTERCANISTER_CALL_BASE_CYCLES_13_NODE});
            let NeutronIngressResponse : Blob = try {
${createPublicIngressHandlerInvocation(
  manifest,
  route,
  "NeutronDispatch.request",
  "                ",
)}
            } catch (NeutronHandlerError) {
                ${KERNEL_INIT}.app_usage_instruction_finish(NeutronAppUsageMeasurement);
                throw NeutronHandlerError;
            };
            ${KERNEL_INIT}.app_usage_instruction_finish(NeutronAppUsageMeasurement);
            ${KERNEL_INIT}.public_ingress_dispatch_finish(${appScopeName(manifest.id)}, ${motokoTextLiteral(route.protocol)}, ${motokoTextLiteral(route.id)}, NeutronDispatch, NeutronIngressResponse);
            NeutronIngressResponse
        }`;
    })
    .join(" ");
  return `
    public shared({ caller = NeutronIngressDispatchCaller }) func ${PUBLIC_INGRESS_UPDATE_HANDLER}(NeutronDispatch : ${moduleName("kernel")}.PublicIngressDispatchV1) : async Blob {
        assert(NeutronIngressDispatchCaller == NeutronPrim.principalOfActor(${ACTOR_SELF}));
        ${branches} else {
            NeutronPrim.trap("Unknown public ingress update dispatch")
        }
    };`;
}

function createPublicIngressHandlerInvocation(
  manifest: AssemblyManifest,
  route: NeutronPublicIngressRouteV1,
  handlerRequest: string,
  indent: string,
  resultName?: string,
): string {
  const target = manifest.func?.[route.handler];
  if (!target) {
    throw new Error(
      `Public ingress route ${manifest.id}.${route.protocol}.${route.id} has no handler ${route.handler}`,
    );
  }
  const importedModule = moduleName(manifest.id);
  const decodedName = "NeutronDecodedIngressRequest";
  const requestName = "NeutronIngressAppRequest";
  const responseName = "NeutronIngressAppResponse";
  const injected = (target.arg ?? []).map((value) =>
    value === PUBLIC_INGRESS_CYCLES_ARGUMENT
      ? `${KERNEL_INIT}.public_ingress_cycles_capability(${appScopeName(manifest.id)})`
      : resolveFunctionArgument(
          manifest.id,
          value,
          `${handlerRequest}.caller`,
        ),
  );
  const invocation = `${appInitName(manifest.id)}.${route.handler}(${requestName}${
    injected.length > 0 ? `,${injected.join(",")}` : ""
  })`;
  const lines = [
    `assert(${KERNEL_INIT}.scope_active(${appScopeName(manifest.id)}));`,
    `let ${decodedName} : ?${importedModule}.${route.handler}_Input = from_candid ${handlerRequest}.payload;`,
    `let ?${requestName} = ${decodedName} else { NeutronPrim.trap("Invalid public ingress payload") };`,
    `let ${responseName} : ${importedModule}.${route.handler}_Output = ${invocation};`,
    `let ${resultName ?? "NeutronIngressResponse"} = to_candid (${responseName});`,
  ];
  if (resultName === undefined) lines.push("NeutronIngressResponse");
  return lines.map((line) => `${indent}${line}`).join("\n");
}

function createScheduledTaskConfiguration(
  manifests: AssemblyManifest[],
): string {
  const tasks = manifests.flatMap((manifest) =>
    (
      getCapabilityPlanEntry(buildCapabilityPlan(manifest), "scheduled_tasks")
        ?.config.tasks ?? []
    ).map((task) => {
      no_inject(manifest.id);
      no_inject(task.id);
      no_inject(task.method);
      const hasBackendCalls = Boolean(
        getCapabilityPlanEntry(buildCapabilityPlan(manifest), "backend_calls"),
      );
      const callback = hasBackendCalls
        ? `let NeutronTaskCapabilities = {
            backend_calls = ${KERNEL_INIT}.task_backend_calls_capability(
              ${appScopeName(manifest.id)},
              "${task.id}",
              ${task.max_backend_calls},
              NeutronTaskLease,
              ${ACTOR_SELF},
            );
          };
          await* ${privateFunctionName(manifest.id, task.method)}((), NeutronTaskCapabilities)`
        : `await* ${privateFunctionName(manifest.id, task.method)}(())`;
      return `{
        app_scope = ${appScopeName(manifest.id)};
        id = "${task.id}";
        method = "${task.method}";
        interval_seconds = ${task.interval_seconds};
        run_on_start = ${task.run_on_start};
        max_backend_calls = ${task.max_backend_calls};
        callback = func (${hasBackendCalls ? "NeutronTaskLease" : "_NeutronTaskLease"} : ${moduleName("kernel")}.TaskInvocationLease) : async () {
          let NeutronAppUsageMeasurement = ${KERNEL_INIT}.app_usage_instruction_begin(${appScopeName(manifest.id)}, ${INTERCANISTER_CALL_BASE_CYCLES_13_NODE});
          try {
            ${callback};
            ${KERNEL_INIT}.app_usage_instruction_finish(NeutronAppUsageMeasurement);
          } catch (NeutronTaskError) {
            ${KERNEL_INIT}.app_usage_instruction_finish(NeutronAppUsageMeasurement);
            throw NeutronTaskError;
          }
        };
      }`;
    }),
  );
  if (tasks.length === 0) return "";
  return `    ${KERNEL_INIT}.configure_scheduled_tasks<system>([${tasks.join(",\n")}]);`;
}

function resolveKernelInitArgument(
  conf: AssemblyManifest,
  value: string,
  deploymentId = "development",
): string {
  no_inject(value);
  if (conf.id !== "kernel") {
    throw new Error(
      `App ${conf.id} cannot use the kernel-only positional initializer ABI`,
    );
  }
  if (value === "deployment_id") {
    return motokoTextLiteral(deploymentId);
  }
  if (value === ACTIVE_APP_INSTANCE_INVENTORY) {
    return ACTIVE_APP_INSTANCE_INVENTORY_BINDING;
  }
  if (value === "canister_principal") {
    return `NeutronPrim.principalOfActor(${ACTOR_SELF})`;
  }
  if (value.startsWith("memory_")) {
    const memoryId = value.slice("memory_".length);
    const ownedMemory = conf.memory?.[memoryId];
    const ownsActiveMemory =
      ownedMemory !== undefined && ownedMemory.retired !== true;
    if (ownsActiveMemory) return managedMemoryBindingName(conf.id, memoryId);
    throw new Error(`Kernel cannot receive memory ${memoryId}`);
  }

  throw new Error(`Kernel requested unknown init resource '${value}'`);
}

function createRuntimeInfo(
  memories: MemoryOwner[],
  deploymentId: string,
  compilerId: string,
  assemblerId: typeof ASSEMBLER_ID | typeof LEGACY_V25_ASSEMBLER_ID,
  exposesCapabilityAuthorityRevision: boolean,
): string {
  no_inject(deploymentId);
  no_inject(compilerId);
  no_inject(assemblerId);
  const memoryEntries = memories
    .map(
      ({ manifest, memoryId, memory }) =>
        `{ id = "${memoryId}"; owner = "${manifest.id}"; version = ${memory.version ?? 1}; schema = "${schemaHash({ manifest, memoryId, memory })}" }`,
    )
    .join(", ");
  return `
    public query({ caller = NeutronCaller }) func kernel_runtime_info() : async {
      deployment_id : Text;
      assembler_id : Text;
      compiler_id : Text;
      ${assemblerId === ASSEMBLER_ID ? "capability_authority_revision : ?Nat64;" : ""}
      apps : [{
        scope : { app_id : Text; installation_uid : Nat64 };
        version : Nat;
        deployment_id : Text;
        capability_plan_fingerprint : Text;
        resident_frame_security : {
          #credentialless_opaque_v1;
          #credentialless_ephemeral_dedicated_v1;
          #persistent_dedicated_v1;
        };
        browser_origin_nonce : Text;
        browser_origin_authority_epoch : Nat64;
      }];
      memories : [{ id : Text; owner : Text; version : Nat; schema : Text }];
    } {
      assert(${KERNEL_INIT}.is_authorized(NeutronCaller));
      {
        deployment_id = "${deploymentId}";
        assembler_id = "${assemblerId}";
        compiler_id = "${compilerId}";
        ${assemblerId === ASSEMBLER_ID ? `capability_authority_revision = ${exposesCapabilityAuthorityRevision ? `?${KERNEL_INIT}.capability_authority_revision()` : "null"};` : ""}
        apps = ${KERNEL_INIT}.runtime_app_instances(${motokoTextLiteral(deploymentId)});
        memories = [${memoryEntries}];
      }
    };
`;
}

function createRuntimeApps(manifests: AssemblyManifest[]): RuntimeApp[] {
  return manifests
    .map((manifest) => {
      const plan = toCapabilityPlanWireV1(buildCapabilityPlan(manifest));
      return {
        id: manifest.id,
        version: manifest.version,
        capabilityPlanFingerprint: fingerprintCapabilityPlanWireV1(plan),
        residentFrameSecurity: residentFrameSecurity(plan),
      };
    })
    .sort((left, right) => compareCanonicalText(left.id, right.id));
}

function createActiveAppInstanceInventory(runtimeApps: RuntimeApp[]): string {
  const records = runtimeApps
    .map(
      (app) =>
        `{ app_id = ${motokoTextLiteral(app.id)}; version = ${app.version}; capability_plan_fingerprint = ${motokoTextLiteral(app.capabilityPlanFingerprint)}; resident_frame_security = #${app.residentFrameSecurity} }`,
    )
    .join(", ");
  return `    transient let ${ACTIVE_APP_INSTANCE_INVENTORY_BINDING} = [${records}];`;
}

function create_internal_func(
  name: string,
  conf: NeutronFunctionConfig,
  modname: string,
): string {
  no_inject(name);
  const taskCapabilities = conf.arg?.includes("task_capabilities");
  const injectedParameter = taskCapabilities
    ? `, NeutronTaskCapabilities : { backend_calls : ${moduleName("kernel")}.BackendCallsCapability }`
    : "";
  const injectedArgument = taskCapabilities
    ? ",NeutronTaskCapabilities"
    : "";
  const canisterPrincipalArgument = conf.arg?.includes("canister_principal")
    ? `,NeutronPrim.principalOfActor(${ACTOR_SELF})`
    : "";
  const scopeGuard = appScopeGuard(modname, "        ");
  const importedModule = moduleName(modname);

  return `
      private func ${privateFunctionName(modname, name)}(NeutronRequest: ${importedModule}.${name}_Input${injectedParameter}) : ${asyncType(conf)} ${importedModule}.${name}_Output {
${scopeGuard}        ${awaitType(conf)} ${appInitName(modname)}.${name}(NeutronRequest${injectedArgument}${canisterPrincipalArgument})
      };
`;
}

function create_func(
  name: string,
  conf: NeutronFunctionConfig,
  modname: string,
): string {
  if (conf.type === "internal")
    return create_internal_func(name, conf, modname);
  if (conf.arg?.includes(PUBLIC_INGRESS_CYCLES_ARGUMENT)) {
    // This resource exists only while the paid public-ingress dispatcher is
    // invoking the handler. Do not create an ordinary owner method that would
    // need an ambient or inert substitute.
    return "";
  }
  no_inject(name);
  const authorization =
    conf.allow !== "unauthorized"
      ? `        assert(${KERNEL_INIT}.is_authorized(NeutronCaller));\n`
      : "";
  const scopeGuard = appScopeGuard(modname, "        ");
  const systemInstantiation = kernelSystemInstantiation(modname, name);
  const lifecycleArguments = kernelLifecycleArguments(modname, name);
  const physicalName = publicFunctionName(modname, name);
  const importedModule = moduleName(modname);
  const meterAppUpdate = modname !== "kernel" && conf.type !== "query";
  const fixedMessageCycles =
    conf.allow !== "unauthorized"
      ? INGRESS_MESSAGE_BASE_CYCLES_13_NODE
      : "0";
  const candidParameters = `NeutronRequest: ${importedModule}.${name}_Input`;
  const invocation = `${awaitType(conf)} ${appInitName(modname)}.${name}${systemInstantiation}(NeutronRequest ${conf.arg?.length ? "," + conf.arg.map((value) => resolveFunctionArgument(modname, value)).join(",") : ""}${lifecycleArguments})`;

  if (meterAppUpdate) {
    return `
    public shared({ caller = NeutronCaller }) func ${physicalName}(${candidParameters}) : async ${importedModule}.${name}_Output {
${scopeGuard}${authorization}        let NeutronAppUsageMeasurement = ${KERNEL_INIT}.app_usage_instruction_begin(${appScopeName(modname)}, ${fixedMessageCycles});
        try {
            let NeutronAppResponse : ${importedModule}.${name}_Output = ${invocation};
            ${KERNEL_INIT}.app_usage_instruction_finish(NeutronAppUsageMeasurement);
            NeutronAppResponse
        } catch (NeutronAppError) {
            ${KERNEL_INIT}.app_usage_instruction_finish(NeutronAppUsageMeasurement);
            throw NeutronAppError
        }
    };
`;
  }

  return `
    public ${conf.type === "query" ? "query" : "shared"}({ caller = NeutronCaller }) func ${physicalName}(${candidParameters}) : async ${importedModule}.${name}_Output {
${scopeGuard}${authorization}        ${invocation}
    };
`;
}

function publicFunctionName(appId: string, localMethod: string): string {
  return appId === "kernel"
    ? localMethod
    : physicalAppMethodName(appId, localMethod);
}

function privateFunctionName(appId: string, localMethod: string): string {
  return `NeutronAppFunction_${scopedPhysicalStem(appId, localMethod)}`;
}

function kernelSystemInstantiation(appId: string, method: string): string {
  // This is an assembler-owned kernel lifecycle edge, never app-authored
  // authority. The one current commit needs the actor's system capability
  // solely to register target run_on_start timers after journal promotion.
  return appId === "kernel" && method === "kernel_install_commit"
    ? "<system>"
    : "";
}

function kernelLifecycleArguments(appId: string, method: string): string {
  // Managed-memory retirement is an assembler-owned lifecycle edge, not a
  // manifest capability resource. Only the exact install commit wrapper gets
  // the generated synchronous callback.
  return appId === "kernel" && method === "kernel_install_commit"
    ? `,${COMMIT_MEMORY_RETIREMENTS}`
    : "";
}

function appScopeGuard(appId: string, indent: string): string {
  if (appId === "kernel") return "";
  return `${indent}assert(${KERNEL_INIT}.scope_active(${appScopeName(appId)}));\n`;
}

function resolveFunctionArgument(
  appId: string,
  value: string,
  callerExpression = "NeutronCaller",
): string {
  no_inject(value);
  if (value === "canister_principal") {
    // Deliberately expose only the immutable Principal scalar. The actor `this`
    // value never crosses the generated wrapper into application code.
    return `NeutronPrim.principalOfActor(${ACTOR_SELF})`;
  }
  if (value === "caller") {
    return callerExpression;
  }
  if (value === "this") {
    return ACTOR_SELF;
  }
  if (value.startsWith("memory_")) {
    return managedMemoryBindingName(appId, value.slice("memory_".length));
  }
  return value;
}

function no_inject(inp: unknown): string | number | boolean {
  if (typeof inp === "boolean") return inp;
  if (typeof inp === "number") return inp;
  if (typeof inp !== "string" || /[^a-zA-Z0-9_.]/.test(inp)) {
    throw new Error(`Invalid neutron.json value: ${inp}`);
  }
  return inp;
}

function motokoTextLiteral(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function motokoBackendCallInstallReservation(
  reservation: NeutronBackendCallReservation,
): string {
  if (reservation.kind === "method") {
    return `#method(${motokoTextLiteral(reservation.method)})`;
  }
  const principal =
    `NeutronPrim.principalOfActor(actor (${motokoTextLiteral(reservation.principal)}))`;
  if (reservation.kind === "principal") {
    return `#principal(${principal})`;
  }
  return `#exact({ principal = ${principal}; method = ${motokoTextLiteral(
    reservation.method,
  )} })`;
}

function motokoBlobLiteral(value: readonly number[]): string {
  if (
    value.some(
      (byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff,
    )
  ) {
    throw new Error("Invalid compiler-owned Blob literal");
  }
  return `"${value
    .map((byte) => `\\${byte.toString(16).padStart(2, "0")}`)
    .join("")}"`;
}

function no_module_path(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes('"') ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    !/^[a-zA-Z0-9_./-]+$/.test(value)
  ) {
    throw new Error(`Invalid Motoko module path: ${String(value)}`);
  }
}

function validate_config(confs: AssemblyConfig): AppDependencyPlan {
  const manifests = get_manifests(confs);
  if (manifests.length > NEUTRON_INSTALLED_APP_LIMIT) {
    throw new Error(
      `Assembly declares ${manifests.length} apps; maximum is ${NEUTRON_INSTALLED_APP_LIMIT} including Kernel`,
    );
  }
  let scheduledTaskCount = 0;
  let httpPostUpdateHandlerCallsPerHour = 0;
  let httpPostUpdateHandlerReplayBytesPerHour = 0;
  let publicIngressRouteCount = 0;
  let publicIngressUpdateCallsPerHour = 0;
  let chainKeySigningSlotCount = 0;
  let vetKeysSlotCount = 0;
  let backendCallInstallReservationCount = 0;
  let stableStoreCount = 0;
  let stableStoreEntryCount = 0;
  let stableStoreBytes = 0;
  let httpsOutcallEndpointCount = 0;
  let certifiedAssetsChargedBytes = 0n;
  let certifiedAssetsArenaBytes = 0n;
  let certifiedAssetsArenaExtents = 0n;
  let connectionProviderCount = 0;
  let residentBackgroundCount = 0;
  let runtimeCapabilityRegistrationCount = 0;
  const moduleIds = new Set<string>();
  const backendCallInstallReservationOwners = new Map<string, string>();
  const physicalMemorySymbols = new Map<string, string>();
  const publicFunctions = new Map<string, string>([
    ["kernel_runtime_info", "generated runtime"],
    [PUBLIC_INGRESS_UPDATE_HANDLER, "generated public ingress dispatcher"],
  ]);
  for (const conf of manifests) {
    no_inject(conf.id);
    no_inject(conf.entry);
    if (conf.src !== undefined) no_inject(conf.src);
    const initArgs = conf.init_arg ?? [];
    if (conf.id === "kernel") {
      if (new Set(initArgs).size !== initArgs.length) {
        throw new Error("Kernel has duplicate init resources");
      }
      for (const initArg of initArgs) {
        resolveKernelInitArgument(conf, initArg);
      }
    } else if (conf.init_arg !== undefined) {
      throw new Error(
        `App ${conf.id} cannot use init_arg; ordinary apps receive one exact backend environment`,
      );
    }
    const capabilityPlan = buildCapabilityPlan(conf);
    const backendCalls = getCapabilityPlanEntry(
      capabilityPlan,
      "backend_calls",
    )?.config;
    for (const reservation of backendCalls?.install_reservations ?? []) {
      backendCallInstallReservationCount += 1;
      const key = backendCallInstallReservationKey(reservation);
      const owner = backendCallInstallReservationOwners.get(key);
      if (owner !== undefined && owner !== conf.id) {
        throw new Error(
          `Assembly backend_calls install reservation ${key} is declared by both ${owner} and ${conf.id}`,
        );
      }
      backendCallInstallReservationOwners.set(key, conf.id);
    }
    if (getCapabilityPlanEntry(capabilityPlan, "background_endpoint")) {
      residentBackgroundCount += 1;
    }
    connectionProviderCount +=
      getCapabilityPlanEntry(capabilityPlan, "connections")?.config.providers
        .length ?? 0;

    const scheduledTasks =
      getCapabilityPlanEntry(capabilityPlan, "scheduled_tasks")?.config.tasks ??
      [];
    const hasBackendCalls = backendCalls !== undefined;
    const appHttpPostUpdateHandlerMounts = httpPostUpdateHandlerMounts(conf);
    const publicIngress =
      getCapabilityPlanEntry(capabilityPlan, "public_ingress")?.config.routes ??
      [];
    const chainKeySigning = getCapabilityPlanEntry(
      capabilityPlan,
      "chain_key_signing",
    )?.config;
    if (chainKeySigning) {
      chainKeySigningSlotCount += chainKeySigning.slots.length;
    }
    vetKeysSlotCount +=
      getCapabilityPlanEntry(capabilityPlan, "vetkeys")?.config.slots.length ??
      0;
    const stableStore = getCapabilityPlanEntry(
      capabilityPlan,
      "stable_store",
    )?.config;
    stableStoreCount += stableStore?.stores.length ?? 0;
    for (const store of stableStore?.stores ?? []) {
      stableStoreEntryCount += store.max_entries;
      stableStoreBytes += store.max_bytes;
    }
    const httpsOutcalls = getCapabilityPlanEntry(
      capabilityPlan,
      "https_outcalls",
    )?.config;
    if (httpsOutcalls) {
      httpsOutcallEndpointCount += httpsOutcalls.endpoints.length;
    }
    const certifiedAssets = getCapabilityPlanEntry(
      capabilityPlan,
      "certified_assets",
    )?.config;
    if (certifiedAssets) {
      const reservation = certifiedAssetsPhysicalReservation(
        certifiedAssets,
        conf.id,
      );
      certifiedAssetsChargedBytes += reservation.chargedBytes;
      certifiedAssetsArenaBytes += reservation.arenaBytes;
      certifiedAssetsArenaExtents += reservation.arenaExtents;
    }
    runtimeCapabilityRegistrationCount +=
      projectRuntimeCapabilityRegistrationsV1(capabilityPlan).length;
    publicIngressRouteCount += publicIngress.length;
    for (const route of publicIngress) {
      if (route.mode === "update") {
        publicIngressUpdateCallsPerHour += route.max_calls_per_hour;
      }
    }
    if (conf.id !== "kernel") {
      for (const mount of appHttpPostUpdateHandlerMounts) {
        httpPostUpdateHandlerCallsPerHour += mount.max_calls_per_hour;
        httpPostUpdateHandlerReplayBytesPerHour +=
          mount.max_calls_per_hour * mount.max_response_bytes;
      }
    }
    if (conf.id === "kernel" && scheduledTasks.length > 0) {
      throw new Error("Kernel cannot declare app scheduled tasks");
    }
    if (scheduledTasks.length > 2) {
      throw new Error(`App ${conf.id} declares too many scheduled tasks`);
    }
    scheduledTaskCount += scheduledTasks.length;
    for (const task of scheduledTasks) {
      no_inject(task.id);
      no_inject(task.method);
      const target = conf.func?.[task.method];
      const expectedArgs = hasBackendCalls ? ["task_capabilities"] : [];
      if (
        !target ||
        target.type !== "internal" ||
        target.async !== "async*" ||
        JSON.stringify(target.arg ?? []) !== JSON.stringify(expectedArgs) ||
        target.expose !== undefined
      ) {
        throw new Error(
          `Scheduled task ${conf.id}.${task.id} must target a same-app internal async* function with the required task-scoped resources`,
        );
      }
    }
    for (const mount of appHttpPostUpdateHandlerMounts) {
      no_inject(mount.id);
      no_inject(mount.handler);
      const target = conf.func?.[mount.handler];
      if (
        !target ||
        target.type !== "internal" ||
        target.async !== false ||
        (target.arg?.length ?? 0) !== 0 ||
        target.expose !== undefined
      ) {
        throw new Error(
          `http_post_update_handler mount ${conf.id}.${mount.id} must target a same-app internal synchronous async:false function with no injected arguments or app exposure`,
        );
      }
    }
    for (const route of publicIngress) {
      no_inject(route.protocol);
      no_inject(route.id);
      no_inject(route.handler);
      const target = conf.func?.[route.handler];
      if (
        !target ||
        target.type !== route.mode ||
        target.async !== false ||
        target.allow !== undefined ||
        target.expose !== undefined
      ) {
        throw new Error(
          `Public ingress route ${conf.id}.${route.protocol}.${route.id} must target a same-app synchronous owner-authorized ${route.mode} function without app exposure`,
        );
      }
    }

    if (moduleIds.has(conf.id))
      throw new Error(`Duplicate module id '${conf.id}'`);
    moduleIds.add(conf.id);

    for (const [name, func] of Object.entries(conf.func ?? {})) {
      no_inject(name);
      no_inject(func.type ?? "update");
      if (func.allow !== undefined) no_inject(func.allow);
      if (
        func.async !== undefined &&
        typeof func.async !== "boolean" &&
        func.async !== "async*"
      ) {
        throw new Error(`Invalid async mode for '${name}'`);
      }
      const functionArgs = func.arg ?? [];
      for (const arg of functionArgs) no_inject(arg);
      if (functionArgs.includes(PUBLIC_INGRESS_CYCLES_ARGUMENT)) {
        const handlerRoutes = publicIngress.filter(
          (route) => route.handler === name,
        );
        if (
          conf.id === "kernel" ||
          func.type !== "update" ||
          func.async !== false ||
          handlerRoutes.length === 0 ||
          handlerRoutes.some(
            (route) =>
              route.mode !== "update" || route.caller !== "canister",
          )
        ) {
          throw new Error(
            `App ${conf.id}.${name} may request ${PUBLIC_INGRESS_CYCLES_ARGUMENT} only when every route using that handler is a synchronous caller:"canister" public-ingress update route`,
          );
        }
      }
      if (conf.id !== "kernel") {
        const scheduledTask = scheduledTasks.find(
          (task) => task.method === name,
        );
        for (const arg of functionArgs) {
          if (arg === PUBLIC_INGRESS_CYCLES_ARGUMENT) continue;
          if (
            arg === "task_capabilities" &&
            scheduledTask &&
            hasBackendCalls
          ) {
            continue;
          }
          if (arg === "caller" || arg === "canister_principal") continue;
          if (arg.startsWith("module_")) {
            throw new Error(
              `App ${conf.id}.${name} cannot inject raw module references`,
            );
          }
          if (arg === "this" || arg.startsWith("this.")) {
            throw new Error(
              `App ${conf.id}.${name} cannot inject the Neutron actor`,
            );
          }
          if (arg === "app_caller") {
            throw new Error(
              `App ${conf.id}.${name} cannot request the reserved app_caller argument`,
            );
          }
          if (arg.startsWith("memory_")) {
            const memoryId = arg.slice("memory_".length);
            const memory = conf.memory?.[memoryId];
            if (!memory || memory.retired === true) {
              throw new Error(
                `App ${conf.id}.${name} cannot inject foreign memory ${memoryId}`,
              );
            }
            continue;
          }
          throw new Error(
            `App ${conf.id}.${name} requested unknown function resource '${arg}'`,
          );
        }
      }

      if (func.type === "internal") continue;
      if (functionArgs.includes(PUBLIC_INGRESS_CYCLES_ARGUMENT)) continue;
      const physicalName = publicFunctionName(conf.id, name);
      const existing = publicFunctions.get(physicalName);
      if (existing) {
        throw new Error(
          `Duplicate physical public function '${physicalName}' in ${existing} and ${conf.id}`,
        );
      }
      publicFunctions.set(physicalName, conf.id);
    }

    for (const mount of appHttpPostUpdateHandlerMounts) {
      const physicalName = httpPostUpdateHandlerName(conf.id, mount.id);
      const existing = publicFunctions.get(physicalName);
      if (existing) {
        throw new Error(
          `Duplicate physical public function '${physicalName}' in ${existing} and generated http_post_update_handler ${conf.id}.${mount.id}`,
        );
      }
      publicFunctions.set(
        physicalName,
        `generated http_post_update_handler ${conf.id}.${mount.id}`,
      );
    }

    const ingressDispatchers = new Set<string>();
    for (const route of publicIngress) {
      const physicalName = physicalPublicIngressMethodName(
        conf.id,
        route.protocol,
        route.mode,
      );
      if (ingressDispatchers.has(physicalName)) continue;
      ingressDispatchers.add(physicalName);
      const existing = publicFunctions.get(physicalName);
      if (existing) {
        throw new Error(
          `Duplicate physical public function '${physicalName}' in ${existing} and generated public ingress dispatcher ${conf.id}.${route.protocol}:${route.mode}`,
        );
      }
      publicFunctions.set(
        physicalName,
        `generated public ingress dispatcher ${conf.id}.${route.protocol}:${route.mode}`,
      );
    }

    for (const [memoryId, memory] of Object.entries(conf.memory ?? {})) {
      no_inject(memoryId);
      no_inject(memory.version ?? 1);
      const physical = managedMemoryPhysicalStem(conf.id, memoryId);
      const existing = physicalMemorySymbols.get(physical);
      if (existing) {
        throw new Error(
          `Physical managed-memory collision '${physical}' in ${existing} and ${conf.id}.${memoryId}`,
        );
      }
      physicalMemorySymbols.set(physical, `${conf.id}.${memoryId}`);
    }
  }
  if (scheduledTaskCount > NEUTRON_SCHEDULED_TASK_LIMIT) {
    throw new Error(
      `Assembly declares ${scheduledTaskCount} scheduled tasks; maximum is ${NEUTRON_SCHEDULED_TASK_LIMIT}`,
    );
  }
  if (connectionProviderCount > CONNECTIONS_MAX_PROVIDERS_GLOBAL) {
    throw new Error(
      `Assembly connections declarations exceed the global limit: ${connectionProviderCount} providers (maximum ${CONNECTIONS_MAX_PROVIDERS_GLOBAL})`,
    );
  }
  if (residentBackgroundCount > NEUTRON_RESIDENT_BACKGROUND_LIMIT) {
    throw new Error(
      `Assembly declares ${residentBackgroundCount} resident backgrounds; maximum is ${NEUTRON_RESIDENT_BACKGROUND_LIMIT}`,
    );
  }
  if (
    httpPostUpdateHandlerCallsPerHour >
      HTTP_POST_UPDATE_HANDLERS_GLOBAL_MAX_CALLS_PER_HOUR ||
    httpPostUpdateHandlerReplayBytesPerHour >
      HTTP_POST_UPDATE_HANDLERS_GLOBAL_MAX_REPLAY_BYTES_PER_HOUR
  ) {
    throw new Error(
      `Assembly http_post_update_handler declarations exceed global limits: ${httpPostUpdateHandlerCallsPerHour} calls/hour (maximum ${HTTP_POST_UPDATE_HANDLERS_GLOBAL_MAX_CALLS_PER_HOUR}) and ${httpPostUpdateHandlerReplayBytesPerHour} replay bytes/hour (maximum ${HTTP_POST_UPDATE_HANDLERS_GLOBAL_MAX_REPLAY_BYTES_PER_HOUR})`,
    );
  }
  if (
    publicIngressRouteCount > PUBLIC_INGRESS_MAX_ROUTES_GLOBAL ||
    publicIngressUpdateCallsPerHour >
      PUBLIC_INGRESS_MAX_CALLS_GLOBAL_PER_HOUR
  ) {
    throw new Error(
      `Assembly public ingress declarations exceed global limits: ${publicIngressRouteCount} routes (maximum ${PUBLIC_INGRESS_MAX_ROUTES_GLOBAL}) and ${publicIngressUpdateCallsPerHour} update calls/hour (maximum ${PUBLIC_INGRESS_MAX_CALLS_GLOBAL_PER_HOUR})`,
    );
  }
  if (chainKeySigningSlotCount > CHAIN_KEY_SIGNING_MAX_SLOTS_GLOBAL) {
    throw new Error(
      `Assembly chain-key signing declarations exceed the global slot limit: ${chainKeySigningSlotCount} slots (maximum ${CHAIN_KEY_SIGNING_MAX_SLOTS_GLOBAL})`,
    );
  }
  if (vetKeysSlotCount > VETKEYS_MAX_SLOTS_GLOBAL) {
    throw new Error(
      `Assembly vetkeys declarations exceed the global slot limit: ${vetKeysSlotCount} slots (maximum ${VETKEYS_MAX_SLOTS_GLOBAL})`,
    );
  }
  if (
    backendCallInstallReservationCount >
    BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_GLOBAL
  ) {
    throw new Error(
      `Assembly backend_calls install reservations exceed the global limit: ${backendCallInstallReservationCount} reservations (maximum ${BACKEND_CALLS_MAX_INSTALL_RESERVATIONS_GLOBAL})`,
    );
  }
  if (
    stableStoreCount > STABLE_STORE_MAX_STORES_GLOBAL ||
    stableStoreEntryCount > STABLE_STORE_MAX_ENTRIES_GLOBAL ||
    stableStoreBytes > STABLE_STORE_MAX_BYTES_GLOBAL
  ) {
    throw new Error(
      `Assembly stable_store declarations exceed global limits: ${stableStoreCount} stores (maximum ${STABLE_STORE_MAX_STORES_GLOBAL}), ${stableStoreEntryCount} entries (maximum ${STABLE_STORE_MAX_ENTRIES_GLOBAL}), and ${stableStoreBytes} bytes (maximum ${STABLE_STORE_MAX_BYTES_GLOBAL})`,
    );
  }
  if (httpsOutcallEndpointCount > HTTPS_OUTCALLS_MAX_ENDPOINTS_GLOBAL) {
    throw new Error(
      `Assembly HTTPS outcall declarations exceed the global endpoint limit: ${httpsOutcallEndpointCount} endpoints (maximum ${HTTPS_OUTCALLS_MAX_ENDPOINTS_GLOBAL})`,
    );
  }
  const certifiedAssetsPolicy =
    CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1;
  if (
    certifiedAssetsChargedBytes +
      certifiedAssetsPolicy.arenaMetadataReserveBytes >
      CERTIFIED_ASSETS_GLOBAL_CHARGED_BYTES_MAX ||
    certifiedAssetsArenaBytes >
      certifiedAssetsPolicy.arenaAllocatableBytesMax ||
    2n * certifiedAssetsArenaExtents + 1n >
      certifiedAssetsPolicy.arenaExtentsMax
  ) {
    throw new Error(
      `Assembly certified_assets declarations exceed physical admission: ${certifiedAssetsChargedBytes} charged bytes plus ${certifiedAssetsPolicy.arenaMetadataReserveBytes} allocator metadata bytes (maximum ${CERTIFIED_ASSETS_GLOBAL_CHARGED_BYTES_MAX}), ${certifiedAssetsArenaBytes} arena bytes (maximum ${certifiedAssetsPolicy.arenaAllocatableBytesMax}), and ${certifiedAssetsArenaExtents} arena extents (2x+1 maximum ${certifiedAssetsPolicy.arenaExtentsMax})`,
    );
  }
  if (runtimeCapabilityRegistrationCount > RUNTIME_CAPABILITY_MAX_TOTAL) {
    throw new Error(
      `Assembly projects ${runtimeCapabilityRegistrationCount} runtime capability resources; global maximum is ${RUNTIME_CAPABILITY_MAX_TOTAL}`,
    );
  }

  if (!manifests.some((conf) => conf.id === "kernel")) {
    throw new Error("kernel module config is required");
  }
  return planAppDependencies(toManifestRecord(manifests));
}

function activeMemories(manifests: AssemblyManifest[]): MemoryOwner[] {
  return manifests
    .flatMap((manifest) =>
      Object.entries(manifest.memory ?? {})
        .filter(([, memory]) => memory.retired !== true)
        .map(([memoryId, memory]) => ({ manifest, memoryId, memory })),
    )
    .sort(
      (a, b) =>
        compareCanonicalText(a.manifest.id, b.manifest.id) ||
        compareCanonicalText(a.memoryId, b.memoryId),
    );
}

function schemaEntry(owner: MemoryOwner): string {
  const version = String(owner.memory.version ?? 1);
  const schema = owner.memory.schemas?.[version];
  const entry = schema?.entry ?? schema?.src?.replace(/\.mo$/, "");
  if (!entry)
    throw new Error(
      `Memory ${owner.memoryId} is missing packaged schema v${version}`,
    );
  return entry;
}

function schemaHash(owner: MemoryOwner): string {
  const version = String(owner.memory.version ?? 1);
  const schema = owner.memory.schemas?.[version];
  const hash = schema?.hash ?? schema?.src?.replace(/\.mo$/, "");
  if (!hash) {
    throw new Error(
      `Memory ${owner.memoryId} is missing schema identity v${version}`,
    );
  }
  return hash;
}

function managedStoreType(
  owner: string,
  memoryId: string,
  version: number,
): string {
  return `{ #v${version} : ${schemaAlias(owner, memoryId, version)}.Mem }`;
}

function retiredDescriptorStoreType(
  retirement: ManagedMemoryRetirement,
): string {
  return `{ #v${retirement.version} : ${retiredSchemaAlias(retirement.owner, retirement.memoryId, retirement.version)}.Mem }`;
}

function managedMemoryBindingName(owner: string, memoryId: string): string {
  return `NeutronMemory_${managedMemoryPhysicalStem(owner, memoryId)}`;
}

function schemaAlias(
  owner: string,
  memoryId: string,
  version: number,
): string {
  return `NeutronMemorySchema_${managedMemoryPhysicalStem(owner, memoryId)}_v${version}`;
}

function retiredSchemaAlias(
  owner: string,
  memoryId: string,
  version: number,
): string {
  return `NeutronRetiredMemorySchema_${managedMemoryPhysicalStem(owner, memoryId)}_v${version}`;
}

function migrationAlias(
  owner: string,
  memoryId: string,
  from: number,
  to: number,
): string {
  return `NeutronMemoryMigration_${managedMemoryPhysicalStem(owner, memoryId)}_v${from}_to_v${to}`;
}

function asyncType(conf: NeutronFunctionConfig): string {
  if (conf.async === "async*") return "async*";
  return conf.async === true ? "async" : "";
}

function awaitType(conf: NeutronFunctionConfig): string {
  if (conf.async === "async*") return "await*";
  return conf.async === true ? "await" : "";
}

function get_manifests(confs: AssemblyConfig): AssemblyManifest[] {
  return (Array.isArray(confs) ? confs : Object.values(confs)).sort((a, b) => {
    if (a.id === "kernel") return -1;
    if (b.id === "kernel") return 1;
    return compareCanonicalText(a.id, b.id);
  });
}

function toManifestRecord(
  manifests: AssemblyManifest[],
): Record<string, AssemblyManifest> {
  return Object.fromEntries(
    manifests.map((manifest) => [manifest.id, manifest]),
  );
}

function orderManifests(
  manifests: AssemblyManifest[],
  order: string[],
): AssemblyManifest[] {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const ordered = order.map((id) => {
    const manifest = byId.get(id);
    if (!manifest) {
      throw new Error(`Dependency plan references missing app ${id}`);
    }
    byId.delete(id);
    return manifest;
  });
  if (byId.size > 0) {
    throw new Error(
      `Dependency plan omits apps: ${[...byId.keys()].sort(compareCanonicalText).join(", ")}`,
    );
  }
  return ordered;
}
