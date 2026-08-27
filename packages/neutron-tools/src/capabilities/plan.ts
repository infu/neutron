import {
  CAPABILITY_API_VERSION,
  type BackendCapabilityInterfaceId,
  type CapabilityApiVersion,
  type CapabilityId,
  type CapabilityProvenance,
  type NeutronAgentEntrypointsCapabilityConfig,
  type NeutronBackendCallsCapabilityConfig,
  type NeutronBackgroundUiRequestsCapabilityConfig,
  type NeutronBrowserPermissionsCapabilityConfig,
  type NeutronChainKeySigningCapabilityConfig,
  type NeutronEthereumProviderCapabilityConfig,
  type NeutronHttpRoutesCapabilityConfig,
  type NeutronHttpsOutcallsCapabilityConfig,
  type NeutronCertifiedAssetsCapabilityConfig,
  type NeutronCertifiedReadRoutesCapabilityConfig,
  type NeutronDedicatedResidentOriginCapabilityConfig,
  type NeutronPersistentBrowserStorageCapabilityConfig,
  type NeutronPublicIngressCapabilityConfig,
  type NeutronRandomnessCapabilityConfig,
  type NeutronScheduledTasksCapabilityConfig,
  type NeutronStableStoreCapabilityConfig,
  type NeutronVetKeysCapabilityConfig,
  type NormalizedNeutronConnectionsCapabilityConfig,
  type NeutronResidentFrameSecurityMode,
  deriveCertifiedReadRoutes,
} from "./catalog.ts";
import {
  assertManifestFunctionExports,
  normalizeManifestBackground,
  normalizeManifestBackend,
  normalizeManifestCapabilities,
  normalizeManifestDependencies,
  normalizeManifestTiles,
  normalizeManifestTray,
  MANIFEST_MAX_FUNCTIONS,
  MANIFEST_MAX_MEMORY_MIGRATIONS_TOTAL,
  MANIFEST_MAX_MEMORY_ROOTS,
  type NeutronManifest,
} from "../schema.ts";
import { compareCanonicalText } from "../canonical.ts";
import { assertAppVersion } from "../version.ts";

export const CAPABILITY_PLAN_VERSION = 1 as const;

export type DeclaredCapabilityPlanEntry =
  | DeclaredEntry<"backend_calls", NeutronBackendCallsCapabilityConfig>
  | DeclaredEntry<"randomness", NeutronRandomnessCapabilityConfig>
  | DeclaredEntry<"chain_key_signing", NeutronChainKeySigningCapabilityConfig>
  | DeclaredEntry<"stable_store", NeutronStableStoreCapabilityConfig>
  | DeclaredEntry<"https_outcalls", NeutronHttpsOutcallsCapabilityConfig>
  | DeclaredEntry<"vetkeys", NeutronVetKeysCapabilityConfig>
  | DeclaredEntry<"scheduled_tasks", NeutronScheduledTasksCapabilityConfig>
  | DeclaredEntry<"preapproved_self_calls", PreapprovedSelfCallsPlanConfig>
  | DeclaredEntry<"agent_entrypoints", NeutronAgentEntrypointsCapabilityConfig>
  | DeclaredEntry<
      "background_ui_requests",
      NeutronBackgroundUiRequestsCapabilityConfig
    >
  | DeclaredEntry<"ethereum_provider", NeutronEthereumProviderCapabilityConfig>
  | DeclaredEntry<"connections", NormalizedNeutronConnectionsCapabilityConfig>
  | DeclaredEntry<
      "persistent_browser_storage",
      NeutronPersistentBrowserStorageCapabilityConfig
    >
  | DeclaredEntry<
      "dedicated_resident_origin",
      NeutronDedicatedResidentOriginCapabilityConfig
    >
  | DeclaredEntry<"public_ingress", NeutronPublicIngressCapabilityConfig>
  | DeclaredEntry<"http_routes", NeutronHttpRoutesCapabilityConfig>
  | DeclaredEntry<"certified_assets", NeutronCertifiedAssetsCapabilityConfig>
  | DeclaredEntry<
      "browser_permissions",
      NeutronBrowserPermissionsCapabilityConfig
    >;

type DeclaredEntry<Id extends CapabilityId, Config> = {
  id: Id;
  api: CapabilityApiVersion;
  provenance: "declared";
  config: Config;
};

export type StableMemoryCapabilityConfig = {
  resources: Array<{ id: string; version: number }>;
};

export type MemoryLifecycleCapabilityConfig = {
  retirements: Array<{ id: string }>;
  consumptions: Array<{
    memory: string;
    from: number;
    to: number;
    retired_resources: string[];
  }>;
};

export type PreapprovedSelfCallsPlanConfig = {
  api: 1;
  methods: Array<{ method: string; mode: "query" | "update" }>;
};

export type AppCallsCapabilityConfig = {
  dependencies: Array<{
    alias: string;
    app: string;
    min_version: number;
    methods: string[];
  }>;
};

export type BackendEnvironmentCapabilityConfig = {
  interfaces: Array<{
    id: BackendCapabilityInterfaceId;
    api: CapabilityApiVersion;
  }>;
};

export type FunctionRegistrationCapabilityConfig = {
  methods: Array<{ method: string; mode: "query" | "update" }>;
};

export type FunctionResource =
  | { kind: "caller" }
  | { kind: "canister_principal" }
  | { kind: "public_ingress_cycles" }
  | { kind: "actor_self" }
  | { kind: "stable_memory"; id: string }
  | {
      kind: "task_capabilities";
      interfaces: Array<{ id: "backend_calls"; api: 1 }>;
    };

export type FunctionResourcesCapabilityConfig = {
  functions: Array<{
    method: string;
    mode: "query" | "update" | "internal";
    resources: FunctionResource[];
  }>;
};

export type TileEndpointsCapabilityConfig = {
  endpoints: Array<{ id: string; path: string }>;
};

export type BackgroundEndpointCapabilityConfig = {
  path: string;
  frame_security: NeutronResidentFrameSecurityMode;
};
export type TrayEndpointCapabilityConfig = { path: string };

export type DerivedCapabilityPlanEntry =
  | DerivedEntry<"stable_memory", StableMemoryCapabilityConfig>
  | DerivedEntry<"memory_lifecycle", MemoryLifecycleCapabilityConfig>
  | DerivedEntry<"app_calls", AppCallsCapabilityConfig>
  | DerivedEntry<"backend_environment", BackendEnvironmentCapabilityConfig>
  | DerivedEntry<
      "certified_read_routes",
      NeutronCertifiedReadRoutesCapabilityConfig
    >
  | DerivedEntry<"function_resources", FunctionResourcesCapabilityConfig>
  | DerivedEntry<"app_exports", FunctionRegistrationCapabilityConfig>
  | DerivedEntry<"tile_endpoints", TileEndpointsCapabilityConfig>
  | DerivedEntry<"background_endpoint", BackgroundEndpointCapabilityConfig>
  | DerivedEntry<"tray_endpoint", TrayEndpointCapabilityConfig>;

type DerivedEntry<Id extends CapabilityId, Config> = {
  id: Id;
  api: CapabilityApiVersion;
  provenance: "derived";
  config: Config;
};

export type CapabilityPlanEntry =
  DeclaredCapabilityPlanEntry | DerivedCapabilityPlanEntry;

export type CapabilityPlan = {
  version: typeof CAPABILITY_PLAN_VERSION;
  app: { id: string; version: number };
  entries: CapabilityPlanEntry[];
};

function declaredEntry<
  Id extends DeclaredCapabilityPlanEntry["id"],
  Config extends Extract<DeclaredCapabilityPlanEntry, { id: Id }>["config"],
>(id: Id, config: Config): Extract<DeclaredCapabilityPlanEntry, { id: Id }> {
  return {
    id,
    api: (config as { api: CapabilityApiVersion }).api,
    provenance: "declared",
    config,
  } as Extract<DeclaredCapabilityPlanEntry, { id: Id }>;
}

function derivedEntry<
  Id extends DerivedCapabilityPlanEntry["id"],
  Config extends Extract<DerivedCapabilityPlanEntry, { id: Id }>["config"],
>(id: Id, config: Config): Extract<DerivedCapabilityPlanEntry, { id: Id }> {
  return {
    id,
    api: CAPABILITY_API_VERSION,
    provenance: "derived",
    config,
  } as Extract<DerivedCapabilityPlanEntry, { id: Id }>;
}

function assertCanonicalManifestShape(manifest: NeutronManifest): void {
  const raw = manifest as unknown as Record<string, unknown>;
  if (manifest.format !== 3) {
    throw new Error(`Unsupported package format ${String(manifest.format)}`);
  }
  assertAppVersion(manifest.version, `${manifest.id} package version`);
  if (manifest.id !== "kernel" && manifest.init_arg !== undefined) {
    throw new Error(
      `${manifest.id} cannot declare init_arg; app backend resources are derived from its exact backend environment`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(raw, "connections")) {
    throw new Error(
      "Top-level connections are unsupported; use capabilities.connections",
    );
  }
  const background = raw.background;
  if (
    background &&
    typeof background === "object" &&
    Object.prototype.hasOwnProperty.call(background, "storage")
  ) {
    throw new Error(
      "background.storage is unsupported; use capabilities.persistent_browser_storage",
    );
  }
}

function validateCapabilityFunctionReferences(
  manifest: NeutronManifest,
  capabilities: ReturnType<typeof normalizeManifestCapabilities>,
): void {
  const functions = manifest.func ?? {};
  const selfCalls = capabilities.preapproved_self_calls;
  const validateSelfCall = (method: string): void => {
    const target = functions[method];
    if (
      !target ||
      target.type === "internal" ||
      target.allow === "unauthorized" ||
      target.arg?.includes("public_ingress_cycles")
    ) {
      throw new Error(
        `preapproved_self_calls method ${method} must name an owner-authorized query or update`,
      );
    }
  };
  if (selfCalls) {
    for (const method of selfCalls.methods) validateSelfCall(method);
  }
  for (const task of capabilities.scheduled_tasks?.tasks ?? []) {
    const target = functions[task.method];
    if (!target || target.type !== "internal") {
      throw new Error(
        `scheduled task ${task.id} must name an internal manifest function`,
      );
    }
  }
  for (const route of capabilities.public_ingress?.routes ?? []) {
    const target = functions[route.handler];
    const targetMode = target?.type === "query" ? "query" : "update";
    if (
      manifest.id === "kernel" ||
      !target ||
      target.type === "internal" ||
      targetMode !== route.mode ||
      target.async === true ||
      target.async === "async*"
    ) {
      throw new Error(
        `Public ingress route ${route.protocol}:${route.id} must name a synchronous ordinary ${route.mode} manifest function`,
      );
    }
  }
  for (const mount of capabilities.http_routes?.mounts ?? []) {
    if (mount.mode !== "http_post_update_handler") continue;
    const target = functions[mount.handler];
    if (
      !target ||
      target.type !== "internal" ||
      target.async !== false ||
      (target.arg?.length ?? 0) !== 0 ||
      target.expose !== undefined
    ) {
      throw new Error(
        `http_post_update_handler mount ${mount.id} must name a synchronous, unexposed internal manifest function without injected resources`,
      );
    }
  }
}

function functionMode(
  type: "update" | "query" | "internal" | undefined,
): "update" | "query" {
  return type === "query" ? "query" : "update";
}

function exactFunctionMode(
  type: "update" | "query" | "internal" | undefined,
): "query" | "update" | "internal" {
  return type ?? "update";
}

function functionResource(
  manifest: NeutronManifest,
  method: string,
  mode: "query" | "update" | "internal",
  resource: string,
  activeMemoryIds: ReadonlySet<string>,
  scheduledTaskMethods: ReadonlySet<string>,
  hasBackendCalls: boolean,
  publicIngressCyclesMethods: ReadonlySet<string>,
): FunctionResource {
  if (resource === "caller") {
    if (mode === "internal") {
      throw new Error(
        `${manifest.id}.${method} cannot inject caller internally`,
      );
    }
    return { kind: "caller" };
  }
  if (resource === "canister_principal") {
    return { kind: "canister_principal" };
  }
  if (resource === "public_ingress_cycles") {
    if (mode !== "update" || !publicIngressCyclesMethods.has(method)) {
      throw new Error(
        `${manifest.id}.${method} may request public_ingress_cycles only when every route using that handler is a synchronous caller:"canister" public-ingress update route`,
      );
    }
    return { kind: "public_ingress_cycles" };
  }
  if (resource === "this") {
    if (manifest.id !== "kernel" || mode === "internal") {
      throw new Error(
        `${manifest.id}.${method} cannot inject the Neutron actor`,
      );
    }
    return { kind: "actor_self" };
  }
  if (resource.startsWith("memory_")) {
    const id = resource.slice("memory_".length);
    if (mode === "internal" || !activeMemoryIds.has(id)) {
      throw new Error(
        `${manifest.id}.${method} cannot inject foreign memory ${id}`,
      );
    }
    return { kind: "stable_memory", id };
  }
  if (resource === "task_capabilities") {
    if (
      mode !== "internal" ||
      !hasBackendCalls ||
      !scheduledTaskMethods.has(method)
    ) {
      throw new Error(
        `${manifest.id}.${method} cannot inject task capabilities`,
      );
    }
    return {
      kind: "task_capabilities",
      interfaces: [{ id: "backend_calls", api: 1 }],
    };
  }
  if (resource.startsWith("module_")) {
    throw new Error(
      `${manifest.id}.${method} cannot inject raw module references`,
    );
  }
  if (resource === "app_caller") {
    throw new Error(
      `${manifest.id}.${method} cannot request the reserved app_caller argument`,
    );
  }
  throw new Error(
    `${manifest.id}.${method} requested unknown function resource '${resource}'`,
  );
}

/**
 * Build the complete, deterministic declaration ceiling for one app version.
 * This plan is not a runtime grant: brokers must still enforce live ownership,
 * grants, reservations, quotas, and revocation on each operation.
 */
export function buildCapabilityPlan(manifest: NeutronManifest): CapabilityPlan {
  assertCanonicalManifestShape(manifest);
  assertManifestFunctionExports(manifest);

  const capabilities = normalizeManifestCapabilities(manifest);
  validateCapabilityFunctionReferences(manifest, capabilities);
  const entries: CapabilityPlanEntry[] = [];

  if (capabilities.backend_calls) {
    entries.push(declaredEntry("backend_calls", capabilities.backend_calls));
  }
  if (capabilities.randomness) {
    entries.push(declaredEntry("randomness", capabilities.randomness));
  }
  if (capabilities.chain_key_signing) {
    entries.push(
      declaredEntry("chain_key_signing", capabilities.chain_key_signing),
    );
  }
  if (capabilities.stable_store) {
    entries.push(declaredEntry("stable_store", capabilities.stable_store));
  }
  if (capabilities.https_outcalls) {
    entries.push(declaredEntry("https_outcalls", capabilities.https_outcalls));
  }
  if (capabilities.vetkeys) {
    entries.push(declaredEntry("vetkeys", capabilities.vetkeys));
  }
  if (capabilities.scheduled_tasks) {
    entries.push(
      declaredEntry("scheduled_tasks", capabilities.scheduled_tasks),
    );
  }
  if (capabilities.preapproved_self_calls) {
    const selfCalls = capabilities.preapproved_self_calls;
    entries.push(
      declaredEntry("preapproved_self_calls", {
        api: 1,
        methods: selfCalls.methods.map((method) => ({
          method,
          mode: functionMode(manifest.func?.[method]?.type),
        })),
      }),
    );
  }
  if (capabilities.agent_entrypoints) {
    entries.push(
      declaredEntry("agent_entrypoints", capabilities.agent_entrypoints),
    );
  }
  if (capabilities.background_ui_requests) {
    entries.push(
      declaredEntry(
        "background_ui_requests",
        capabilities.background_ui_requests,
      ),
    );
  }
  if (capabilities.ethereum_provider) {
    entries.push(
      declaredEntry("ethereum_provider", capabilities.ethereum_provider),
    );
  }
  if (capabilities.connections) {
    entries.push(declaredEntry("connections", capabilities.connections));
  }
  if (capabilities.persistent_browser_storage) {
    entries.push(
      declaredEntry(
        "persistent_browser_storage",
        capabilities.persistent_browser_storage,
      ),
    );
  }
  if (capabilities.dedicated_resident_origin) {
    entries.push(
      declaredEntry(
        "dedicated_resident_origin",
        capabilities.dedicated_resident_origin,
      ),
    );
  }
  if (capabilities.public_ingress) {
    entries.push(declaredEntry("public_ingress", capabilities.public_ingress));
  }
  if (capabilities.http_routes) {
    entries.push(declaredEntry("http_routes", capabilities.http_routes));
  }
  if (capabilities.certified_assets) {
    entries.push(
      declaredEntry("certified_assets", capabilities.certified_assets),
    );
  }
  if (capabilities.browser_permissions) {
    entries.push(
      declaredEntry("browser_permissions", capabilities.browser_permissions),
    );
  }

  const memoryDeclarations = Object.entries(manifest.memory ?? {});
  if (memoryDeclarations.length > MANIFEST_MAX_MEMORY_ROOTS) {
    throw new Error(
      `${manifest.id} declares more than ${MANIFEST_MAX_MEMORY_ROOTS} memory roots`,
    );
  }
  const migrationCount = memoryDeclarations.reduce(
    (total, [, config]) => total + (config.migrations?.length ?? 0),
    0,
  );
  if (migrationCount > MANIFEST_MAX_MEMORY_MIGRATIONS_TOTAL) {
    throw new Error(
      `${manifest.id} declares more than ${MANIFEST_MAX_MEMORY_MIGRATIONS_TOTAL} memory migrations`,
    );
  }
  const retirements = memoryDeclarations
    .filter(([, config]) => config.retired === true)
    .map(([id]) => ({ id }))
    .sort((left, right) => compareCanonicalText(left.id, right.id));
  const retiredIds = new Set(retirements.map(({ id }) => id));
  const consumptions = memoryDeclarations
    .flatMap(([memoryId, config]) =>
      (config.migrations ?? [])
        .filter((migration) => (migration.consume?.length ?? 0) > 0)
        .map((migration) => ({
          memory: memoryId,
          from: migration.from,
          to: migration.to,
          retired_resources: [...(migration.consume ?? [])],
        })),
    )
    .sort(
      (left, right) =>
        compareCanonicalText(left.memory, right.memory) ||
        left.from - right.from ||
        left.to - right.to,
    );
  for (const consumption of consumptions) {
    for (const retiredId of consumption.retired_resources) {
      if (!retiredIds.has(retiredId)) {
        throw new Error(
          `${manifest.id}.${consumption.memory} consumes memory ${retiredId} that is not retired by the same app`,
        );
      }
    }
  }
  const memory = memoryDeclarations
    .filter(([, config]) => config.retired !== true)
    .map(([id, config]) => {
      if (!Number.isSafeInteger(config.version) || Number(config.version) < 1) {
        throw new Error(`memory.${id}.version must be a positive safe integer`);
      }
      return { id, version: Number(config.version) };
    })
    .sort((a, b) => compareCanonicalText(a.id, b.id));
  if (memory.length > 0) {
    entries.push(derivedEntry("stable_memory", { resources: memory }));
  }
  if (retirements.length > 0 || consumptions.length > 0) {
    entries.push(
      derivedEntry("memory_lifecycle", { retirements, consumptions }),
    );
  }

  const dependencies = Object.entries(normalizeManifestDependencies(manifest))
    .map(([alias, dependency]) => ({
      alias,
      app: dependency.app,
      min_version: dependency.min_version,
      methods: [...dependency.functions],
    }))
    .sort((a, b) => compareCanonicalText(a.alias, b.alias));
  if (dependencies.length > 0) {
    entries.push(derivedEntry("app_calls", { dependencies }));
  }

  const backend = normalizeManifestBackend(manifest);
  if (
    capabilities.certified_assets &&
    backend?.capabilities.certified_assets?.api !== 2
  ) {
    throw new Error(
      "certified_assets API 2 requires backend.capabilities.certified_assets API 2",
    );
  }
  if (backend) {
    const interfaces = (
      Object.keys(backend.capabilities) as BackendCapabilityInterfaceId[]
    )
      .sort(compareCanonicalText)
      .map((id) => ({ id, api: backend.capabilities[id]!.api }));
    entries.push(derivedEntry("backend_environment", { interfaces }));
  }
  if (capabilities.certified_assets) {
    entries.push(
      derivedEntry(
        "certified_read_routes",
        deriveCertifiedReadRoutes(capabilities.certified_assets),
      ),
    );
  }

  const scheduledTaskMethods = new Set(
    capabilities.scheduled_tasks?.tasks.map(({ method }) => method) ?? [],
  );
  const publicIngressRoutes = capabilities.public_ingress?.routes ?? [];
  const publicIngressCyclesMethods = new Set(
    Object.entries(manifest.func ?? {})
      .filter(([method, config]) => {
        const handlerRoutes = publicIngressRoutes.filter(
          (route) => route.handler === method,
        );
        return (
          config.type === "update" &&
          config.async === false &&
          handlerRoutes.length > 0 &&
          handlerRoutes.every(
            (route) => route.mode === "update" && route.caller === "canister",
          )
        );
      })
      .map(([method]) => method),
  );
  const activeMemoryIds = new Set(memory.map(({ id }) => id));
  const functionResources = Object.entries(manifest.func ?? {})
    .filter(([, config]) => (config.arg?.length ?? 0) > 0)
    .map(([method, config]) => {
      const mode = exactFunctionMode(config.type);
      return {
        method,
        mode,
        resources: (config.arg ?? []).map((resource) =>
          functionResource(
            manifest,
            method,
            mode,
            resource,
            activeMemoryIds,
            scheduledTaskMethods,
            capabilities.backend_calls !== undefined,
            publicIngressCyclesMethods,
          ),
        ),
      };
    })
    .sort((left, right) => compareCanonicalText(left.method, right.method));
  if (functionResources.length > MANIFEST_MAX_FUNCTIONS) {
    throw new Error(
      `${manifest.id} declares more than ${MANIFEST_MAX_FUNCTIONS} resource-bound functions`,
    );
  }
  if (functionResources.length > 0) {
    entries.push(
      derivedEntry("function_resources", { functions: functionResources }),
    );
  }

  const appExports = Object.entries(manifest.func ?? {})
    .filter(([, config]) => config.expose === "apps")
    .map(([method, config]) => ({ method, mode: functionMode(config.type) }))
    .sort((a, b) => compareCanonicalText(a.method, b.method));
  if (appExports.length > 0) {
    entries.push(derivedEntry("app_exports", { methods: appExports }));
  }

  // Kernel's root UI is a kernel surface, not an installed-app endpoint. The
  // ordinary manifest fallback tile therefore applies only to app manifests.
  const tiles = (
    manifest.id === "kernel" ? [] : normalizeManifestTiles(manifest)
  )
    .map(({ id, path }) => ({ id, path }))
    .sort((a, b) => compareCanonicalText(a.id, b.id));
  if (tiles.length > 0) {
    entries.push(derivedEntry("tile_endpoints", { endpoints: tiles }));
  }

  const background = normalizeManifestBackground(manifest);
  if (background) {
    const frameSecurity: NeutronResidentFrameSecurityMode =
      capabilities.persistent_browser_storage
        ? "persistent_dedicated_v1"
        : capabilities.dedicated_resident_origin
          ? "credentialless_ephemeral_dedicated_v1"
          : "credentialless_opaque_v1";
    entries.push(
      derivedEntry("background_endpoint", {
        path: background.path,
        frame_security: frameSecurity,
      }),
    );
  }
  const tray = normalizeManifestTray(manifest);
  if (tray) {
    entries.push(derivedEntry("tray_endpoint", { path: tray.path }));
  }

  return {
    version: CAPABILITY_PLAN_VERSION,
    app: { id: manifest.id, version: manifest.version },
    entries,
  };
}

export function getCapabilityPlanEntry<Id extends CapabilityId>(
  plan: CapabilityPlan,
  id: Id,
): Extract<CapabilityPlanEntry, { id: Id }> | undefined {
  return plan.entries.find((entry) => entry.id === id) as
    Extract<CapabilityPlanEntry, { id: Id }> | undefined;
}

export function hasCapabilityPlanEntry(
  plan: CapabilityPlan,
  id: CapabilityId,
): boolean {
  return plan.entries.some((entry) => entry.id === id);
}

export function assertCapabilityPlanEntryProvenance(
  entry: CapabilityPlanEntry,
  provenance: CapabilityProvenance,
): void {
  if (entry.provenance !== provenance) {
    throw new Error(`Capability ${entry.id} has invalid provenance`);
  }
}
