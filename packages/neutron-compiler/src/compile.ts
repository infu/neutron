import {
  disposeMotokoCompiler,
  loadMotoko,
  type Diagnostic,
  type Motoko,
  type MotokoInspection,
} from "neutron-motoko-wasm";
import {
  checkForDangerousASTCode,
  checkForDangerousSyntaxFacts,
  needsDangerousASTFallback,
} from "neutron-security";
import { hashContent } from "neutron-tools/src/hash.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { assertNeutronManifest } from "neutron-tools/src/memory.js";
import { withSupportedCertificateVersions } from "neutron-tools/src/wasm_metadata.js";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import {
  buildCapabilityPlan,
  getCapabilityPlanEntry,
} from "neutron-tools/src/capabilities/plan.js";
import {
  assertConnectionProvidersSupported,
  certifiedAssetsPhysicalReservation,
  type ConnectionProviderSupportCatalog,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  fingerprintCapabilityPlanWireV1,
  toCapabilityPlanWireV1,
  type CapabilityPlanWireV1,
} from "neutron-tools/src/capabilities/wire.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import { whitelist } from "../whitelist.ts";
import { ASSEMBLER_ID, assemble, type VetKeysEnvironment } from "./assemble.ts";
import {
  planAppDependencies,
  type AppDependencyPlan,
} from "./app_dependencies.ts";
import {
  assertMemoryMigrationPlan,
  planMemoryMigrations,
  type MemoryMigrationPlan,
} from "./memory_migrations.ts";
import {
  plannedManagedMemoryRetirements,
  readManagedMemoryRetirements,
  validateCommittedManagedMemoryRetirements,
  writeManagedMemoryRetirements,
  type ManagedMemoryRetirement,
} from "./memory_retirements.ts";
import {
  managedMemoryStoreName,
  MANAGED_MEMORY_STORE_NAME_PATTERN,
  retiredManagedMemoryStoreName,
} from "./memory_physical_names.ts";
import { assertCompiledSelfCallBindings } from "./candid_signatures.ts";
import {
  residentFrameSecurity,
  type ResidentFrameSecurity,
} from "./resident_frame_security.ts";
import {
  assertTrustedInstallationContext,
  mainnetTrustedInstallationContext,
  trustedInstallationNetworkIdHex,
  type TrustedInstallationContextV1,
} from "./installation_context.ts";

export type MotokoFile = {
  path: string;
  content: string;
};

export type CompileConfig = Record<string, PackagedNeutronManifest>;

export type CompileInput = {
  mofiles: MotokoFile[];
  configs: CompileConfig;
  previousConfigs?: CompileConfig;
  previousStable?: string | null;
  /** Exact support metadata shipped by the selected Kernel package. */
  connectionProviderSupport?: ConnectionProviderSupportCatalog;
  /** Unique per deployment attempt; omit for deterministic compile-only output. */
  deploymentNonce?: string;
  vetKeysEnvironment?: VetKeysEnvironment;
  /**
   * Trusted target context for a fresh local whole-canister install.
   * State-preserving upgrades reject this input and restore their existing
   * immutable current-format value. Predecessor actors require clean reinstall.
   */
  freshInstallationContext?: TrustedInstallationContextV1;
  /**
   * Offline qualification-only source binding. Normal install, update, and
   * cache paths leave this false so the assembled actor source is not retained
   * in their result.
   */
  includeGeneratedSource?: boolean;
  verbose?: boolean;
};

export type CompileDangerReport = Record<string, Record<string, string[]>>;

export type CompiledCapabilityPlan = {
  plan: CapabilityPlanWireV1;
  fingerprint: string;
};

/**
 * Complete identity-free target inventory emitted by the compiler. The
 * kernel reconciles these declarations to private installation identities at
 * install-begin; installation uids and browser-origin nonces are never chosen
 * by package or compiler input.
 */
export type CompiledAppInstance = {
  app_id: string;
  version: number;
  capability_plan_fingerprint: string;
  resident_frame_security: ResidentFrameSecurity;
};

export type CompiledManagedMemory = {
  owner: string;
  id: string;
  version: number;
  schema: string;
};

type InspectedModule = {
  imports: string[];
  findings: string[];
};

type ModuleGraph = Map<string, InspectedModule>;
type InspectionCache = Map<string, Promise<InspectedModule>>;

type InstallationContextIdentity =
  | { kind: "trusted_v1"; network_id_hex: string }
  | { kind: "preserved_stable_v1" };

type ResolvedInstallationContext = {
  assembly: TrustedInstallationContextV1 | null | undefined;
  identity: InstallationContextIdentity;
};

export type CompileResult = {
  wasm: Uint8Array;
  candid: string;
  stable: string;
  /** Exact assembled actor source, only when explicitly requested. */
  generatedSource?: string;
  diagnostics: Diagnostic[];
  compatibilityDiagnostics: Diagnostic[];
  danger: CompileDangerReport;
  dependencyPlan: AppDependencyPlan;
  migrationPlan: MemoryMigrationPlan;
  managedMemoryRetirements: ManagedMemoryRetirement[];
  capabilityPlans: Record<string, CompiledCapabilityPlan>;
  appInstanceInventory: CompiledAppInstance[];
  /** Exact predecessor inventory used for managed-memory planning. */
  previousManagedMemoryInventory: CompiledManagedMemory[];
  managedMemoryInventory: CompiledManagedMemory[];
  /** SHA-256 of the exact predecessor stable signature, when one exists. */
  previousStableSignatureSha256: string | null;
  deploymentId: string;
  /** Exact caller-supplied transaction nonce bound into deploymentId. */
  deploymentNonce: string | null;
  /** Exact compiler target environment bound into deploymentId. */
  vetKeysEnvironment: VetKeysEnvironment;
  compilerId: string;
  modulePaths: string[];
};

type AstNode = {
  name?: unknown;
  args?: unknown;
};

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null;

const astArgs = (value: unknown): unknown[] =>
  isAstNode(value) && Array.isArray(value.args) ? value.args : [];

// The vendored Motoko compiler owns one process-global virtual filesystem and
// retains internal state that removeFile cannot reliably reclaim. Concurrent
// resets are therefore unsafe, and a long sequence of compilations can wedge
// compileWasm on a later invalid program. Serialize callers around a fresh
// compiler lifecycles (and, in Bun, fresh service processes) for every compile.
// Inspection and final emission deliberately use separate runtimes.
let compileQueue: Promise<void> = Promise.resolve();

export function compile(input: CompileInput): Promise<CompileResult> {
  const result = compileQueue.then(() => compileIsolated(input));
  compileQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function compileIsolated(input: CompileInput): Promise<CompileResult> {
  await disposeMotokoCompiler();
  try {
    return await compileWithMotoko(input);
  } finally {
    await disposeMotokoCompiler();
  }
}

async function compileWithMotoko({
  mofiles,
  configs,
  previousConfigs = {},
  previousStable = null,
  connectionProviderSupport,
  deploymentNonce,
  vetKeysEnvironment = "production",
  freshInstallationContext,
  includeGeneratedSource = false,
  verbose = false,
}: CompileInput): Promise<CompileResult> {
  assertVetKeysEnvironment(vetKeysEnvironment);
  assertDeploymentNonce(deploymentNonce);
  const debug = (...args: unknown[]) => {
    if (verbose) console.log(...args);
  };
  validateConfigs(configs);
  validateConfigs(previousConfigs);
  assertStableStoreSchemaTransitions(previousConfigs, configs);
  assertCertifiedAssetsTransitions(previousConfigs, configs);
  const installationContext = resolveInstallationContext({
    previousStable,
    vetKeysEnvironment,
    freshInstallationContext,
  });
  const committedRetirements = readManagedMemoryRetirements(previousStable);
  validateCommittedManagedMemoryRetirements(
    committedRetirements,
    previousConfigs,
  );
  const dependencyPlan = planAppDependencies(configs);
  const migrationPlan = planMemoryMigrations(previousConfigs, configs);
  assertMemoryMigrationPlan(migrationPlan);
  const targetRetirements = plannedManagedMemoryRetirements(migrationPlan);
  const capabilityPlans = compileCapabilityPlans(
    configs,
    connectionProviderSupport,
  );
  const appInstanceInventory = compileAppInstanceInventory(capabilityPlans);
  const previousManagedMemoryInventory =
    compileManagedMemoryInventory(previousConfigs);
  const managedMemoryInventory = compileManagedMemoryInventory(configs);
  const inspectionCompiler = await loadMotoko();
  const compilerId = `moc_${hashContent(inspectionCompiler.version).slice(0, 16)}`;
  const deploymentId = createDeploymentId(
    configs,
    migrationPlan,
    committedRetirements,
    targetRetirements,
    capabilityPlans,
    appInstanceInventory,
    managedMemoryInventory,
    compilerId,
    vetKeysEnvironment,
    installationContext.identity,
    deploymentNonce,
  );
  const mofilesByPath = moduleMap(mofiles);
  const roots = targetCompileRoots(
    configs,
    migrationPlan,
    committedRetirements,
  );
  const inspectionCache: InspectionCache = new Map();
  const { files: reachableModules, graph: moduleGraph } =
    await inspectReachableMotokoFiles({
      configs,
      mofilesByPath,
      mo: inspectionCompiler,
      roots,
      inspectionCache,
    });

  // Inspection parses every reachable source into temporary compiler state.
  // Release that state before the substantially deeper whole-actor compile:
  // browser Workers have a smaller fixed Wasm call stack than page contexts,
  // and a fresh compiler also gives the final phase a compact, empty VFS.
  await disposeMotokoCompiler();
  const mo = await loadMotoko();
  await resetCompilerFiles(mo);
  for (const { path, content } of reachableModules)
    await mo.write(path, content);

  const dangers = scanDangerousModules({
    configs,
    roots,
    moduleGraph,
    debug,
  });
  const dangerousApps = Object.entries(dangers)
    .filter(([id]) => id !== "kernel")
    .flatMap(([id, modules]) =>
      Object.entries(modules)
        .filter(([, findings]) => findings.length > 0)
        .map(
          ([module, findings]) => `${id}:${module} (${findings.join(", ")})`,
        ),
    );
  if (dangerousApps.length > 0) {
    throw new Error(`Disallowed Motoko code: ${dangerousApps.join("; ")}`);
  }

  const neutronSource = assemble(configs, {
    migrationPlan,
    committedRetirements,
    dependencyPlan,
    deploymentId,
    compilerId,
    vetKeysEnvironment,
    ...(installationContext.assembly === undefined
      ? {}
      : { installationContext: installationContext.assembly }),
  });
  debug(neutronSource);
  await mo.write("neutron.mo", neutronSource);
  const compiled = await mo.wasm("neutron.mo", "ic");
  assertCompiledSelfCallBindings(compiled.candid, capabilityPlans);
  validateDataLossDiagnostics(
    compiled.diagnostics,
    migrationPlan,
    committedRetirements,
  );

  let compatibilityDiagnostics: Diagnostic[] = [];
  if (previousStable) {
    const compatibility = await mo.stableCompatible(
      previousStable,
      compiled.stable,
    );
    compatibilityDiagnostics = compatibility.diagnostics;
    if (!compatibility.compatible) {
      throw new Error(
        `Stable memory is incompatible: ${compatibility.diagnostics
          .map(({ code, message }) => `${code}: ${message}`)
          .join("; ")}`,
      );
    }
  }

  return {
    wasm: withSupportedCertificateVersions(compiled.wasm),
    candid: compiled.candid,
    stable: writeManagedMemoryRetirements(
      compiled.stable,
      targetRetirements,
    ),
    ...(includeGeneratedSource ? { generatedSource: neutronSource } : {}),
    diagnostics: compiled.diagnostics,
    compatibilityDiagnostics,
    danger: dangers,
    dependencyPlan,
    migrationPlan,
    managedMemoryRetirements: targetRetirements,
    capabilityPlans,
    appInstanceInventory,
    previousManagedMemoryInventory,
    managedMemoryInventory,
    previousStableSignatureSha256:
      previousStable === null ? null : hashContent(previousStable),
    deploymentId,
    deploymentNonce: deploymentNonce ?? null,
    vetKeysEnvironment,
    compilerId,
    modulePaths: reachableModules
      .map(({ path }) => path)
      .sort(compareCanonicalText),
  };
}

function compileCapabilityPlans(
  configs: CompileConfig,
  connectionProviderSupport?: ConnectionProviderSupportCatalog,
): Record<string, CompiledCapabilityPlan> {
  return Object.fromEntries(
    Object.values(configs)
      .sort((left, right) => compareCanonicalText(left.id, right.id))
      .map((manifest) => {
        const sourcePlan = buildCapabilityPlan(manifest);
        const connections =
          getCapabilityPlanEntry(sourcePlan, "connections")?.config.providers ??
          [];
        if (connections.length > 0) {
          if (!connectionProviderSupport) {
            throw new Error(
              `App ${manifest.id} declares connection providers but the selected Kernel package has no provider-support catalog`,
            );
          }
          assertConnectionProvidersSupported(
            connections,
            connectionProviderSupport,
            `App ${manifest.id}`,
          );
        }
        const plan = toCapabilityPlanWireV1(sourcePlan);
        return [
          manifest.id,
          { plan, fingerprint: fingerprintCapabilityPlanWireV1(plan) },
        ];
      }),
  );
}

export function assertCompileConnectionProviderSupport(
  configs: CompileConfig,
  connectionProviderSupport?: ConnectionProviderSupportCatalog,
): void {
  compileCapabilityPlans(configs, connectionProviderSupport);
}

/**
 * Return the fixed remote principals captured by backend-call install
 * reservations. Method-only reservations have no fixed target.
 *
 * Deployment paths that learn their target only after actor creation can bind
 * this canonical set to the prepared payload and apply the target check before
 * installing the actor.
 */
export function fixedBackendCallInstallReservationTargetPrincipals(
  configs: CompileConfig,
): string[] {
  const principals = new Set<string>();
  for (const appId of Object.keys(configs).sort(compareCanonicalText)) {
    const reservations =
      getCapabilityPlanEntry(
        buildCapabilityPlan(configs[appId]!),
        "backend_calls",
      )?.config.install_reservations ?? [];
    for (const reservation of reservations) {
      if (reservation.kind !== "method") {
        principals.add(reservation.principal);
      }
    }
  }
  return [...principals].sort(compareCanonicalText);
}

/**
 * A backend-call reservation for the target actor itself can never be
 * installed. The target principal is deployment context rather than package
 * input, so reject it at the last shared pre-I/O boundary.
 */
export function assertBackendCallInstallReservationsTarget(
  configs: CompileConfig,
  targetCanisterId: string,
): void {
  for (const appId of Object.keys(configs).sort(compareCanonicalText)) {
    const reservations =
      getCapabilityPlanEntry(
        buildCapabilityPlan(configs[appId]!),
        "backend_calls",
      )?.config.install_reservations ?? [];
    for (const reservation of reservations) {
      if (
        reservation.kind !== "method" &&
        reservation.principal === targetCanisterId
      ) {
        throw new Error(
          `App ${appId} backend_calls install reservation cannot target the Neutron canister itself`,
        );
      }
    }
  }
}

/**
 * The stable-store service never reinterprets retained records as an older
 * schema. Reject a target downgrade before actor construction instead of
 * deferring the invariant to install commit.
 */
export function assertStableStoreSchemaTransitions(
  previousConfigs: CompileConfig,
  configs: CompileConfig,
): void {
  for (const appId of Object.keys(previousConfigs).sort(compareCanonicalText)) {
    const target = configs[appId];
    if (!target) continue;
    const previousStores =
      getCapabilityPlanEntry(
        buildCapabilityPlan(previousConfigs[appId]!),
        "stable_store",
      )?.config.stores ?? [];
    if (previousStores.length === 0) continue;
    const targetStores = new Map(
      (
        getCapabilityPlanEntry(buildCapabilityPlan(target), "stable_store")
          ?.config.stores ?? []
      ).map((store) => [store.id, store]),
    );
    for (const previous of previousStores) {
      const next = targetStores.get(previous.id);
      if (next && next.schema_version < previous.schema_version) {
        throw new Error(
          `App ${appId} stable_store ${previous.id} cannot lower schema_version from ${previous.schema_version} to ${next.schema_version}`,
        );
      }
    }
  }
}

/**
 * Retained certified-assets scopes may only widen. Removing, adding, or
 * changing the storage/route shape requires an explicit uninstall/reinstall
 * so the Kernel can retire the old installation scope.
 */
export function assertCertifiedAssetsTransitions(
  previousConfigs: CompileConfig,
  configs: CompileConfig,
): void {
  const numericFields = [
    "max_entries",
    "max_committed_bytes",
    "max_object_bytes",
    "max_pending_stages",
    "max_staged_bytes",
    "max_batch_operations",
    "max_batch_bytes",
    "max_idempotency_receipts",
  ] as const;
  for (const appId of Object.keys(previousConfigs).sort(compareCanonicalText)) {
    const target = configs[appId];
    if (!target) continue;
    const previous =
      getCapabilityPlanEntry(
        buildCapabilityPlan(previousConfigs[appId]!),
        "certified_assets",
      )?.config;
    const next = getCapabilityPlanEntry(
      buildCapabilityPlan(target),
      "certified_assets",
    )?.config;
    if (!previous && !next) continue;
    if (!previous || !next) {
      throw new Error(
        `App ${appId} cannot add or remove certified_assets while retaining its installation scope`,
      );
    }
    for (const field of numericFields) {
      if (next[field] < previous[field]) {
        throw new Error(
          `App ${appId} certified_assets ${field} cannot decrease from ${previous[field]} to ${next[field]}`,
        );
      }
    }
    if (next.collections.length !== previous.collections.length) {
      throw new Error(
        `App ${appId} cannot add or remove certified_assets collections while retaining its installation scope`,
      );
    }
    for (let index = 0; index < previous.collections.length; index += 1) {
      const left = previous.collections[index]!;
      const right = next.collections[index]!;
      const leftPathPrefix =
        "path_prefix" in left ? left.path_prefix : undefined;
      const rightPathPrefix =
        "path_prefix" in right ? right.path_prefix : undefined;
      const leftExactPath =
        "exact_path" in left ? left.exact_path : undefined;
      const rightExactPath =
        "exact_path" in right ? right.exact_path : undefined;
      if (
        left.id !== right.id ||
        left.mount !== right.mount ||
        left.kind !== right.kind ||
        leftPathPrefix !== rightPathPrefix ||
        leftExactPath !== rightExactPath
      ) {
        throw new Error(
          `App ${appId} cannot change certified_assets collection ${left.id} semantics while retaining its installation scope`,
        );
      }
      const previousMaximum =
        left.max_object_bytes ?? previous.max_object_bytes;
      const nextMaximum =
        right.max_object_bytes ?? next.max_object_bytes;
      if (nextMaximum < previousMaximum) {
        throw new Error(
          `App ${appId} certified_assets collection ${left.id} max_object_bytes cannot decrease from ${previousMaximum} to ${nextMaximum}`,
        );
      }
    }
    const previousReservation = certifiedAssetsPhysicalReservation(
      previous,
      appId,
    );
    const nextReservation = certifiedAssetsPhysicalReservation(next, appId);
    if (
      nextReservation.chargedBytes < previousReservation.chargedBytes ||
      nextReservation.arenaBytes < previousReservation.arenaBytes ||
      nextReservation.arenaExtents < previousReservation.arenaExtents
    ) {
      throw new Error(
        `App ${appId} certified_assets physical reservation cannot decrease while retaining its installation scope`,
      );
    }
  }
}

function compileAppInstanceInventory(
  capabilityPlans: Record<string, CompiledCapabilityPlan>,
): CompiledAppInstance[] {
  return Object.entries(capabilityPlans)
    .map(([app_id, capability]) => ({
      app_id,
      version: capability.plan.app.version,
      capability_plan_fingerprint: capability.fingerprint,
      resident_frame_security: residentFrameSecurity(capability.plan),
    }))
    .sort((left, right) => compareCanonicalText(left.app_id, right.app_id));
}

export function compileManagedMemoryInventory(
  configs: CompileConfig,
): CompiledManagedMemory[] {
  return Object.values(configs)
    .flatMap((manifest) =>
      Object.entries(manifest.memory ?? {})
        .filter(([, memory]) => memory.retired !== true)
        .map(([id, memory]) => {
          const version = memory.version ?? 1;
          const schema = memory.schemas?.[String(version)];
          const schemaIdentity = schema?.hash ?? schema?.entry;
          if (!schemaIdentity) {
            throw new Error(
              `Memory ${manifest.id}.${id} is missing schema identity v${version}`,
            );
          }
          return {
            owner: manifest.id,
            id,
            version,
            schema: schemaIdentity,
          };
        }),
    )
    .sort(
      (left, right) =>
        compareCanonicalText(left.owner, right.owner) ||
        compareCanonicalText(left.id, right.id),
    );
}

function validateConfigs(configs: CompileConfig): void {
  for (const [id, config] of Object.entries(configs)) {
    if (
      Object.prototype.hasOwnProperty.call(
        config as unknown as Record<string, unknown>,
        "memory_requires",
      )
    ) {
      throw new Error(
        "memory_requires is unsupported; app memory cannot be shared",
      );
    }
    const { errors } = validate_neutron_conf(config);
    if (errors.length > 0) {
      throw new Error(JSON.stringify(errors.map((error) => error.stack)));
    }
    if (id !== config.id)
      throw new Error(`Config key ${id} does not match ${config.id}`);
    assertNeutronManifest(config, "package");
  }
}

function scanDangerousModules({
  configs,
  roots,
  moduleGraph,
  debug,
}: {
  configs: CompileConfig;
  roots: Map<string, Set<string>>;
  moduleGraph: ModuleGraph;
  debug: (...args: unknown[]) => void;
}): CompileDangerReport {
  const result: CompileDangerReport = {};
  for (const [id, appRoots] of roots) {
    result[id] = {};
    const pending = [...appRoots].reverse();
    while (pending.length > 0) {
      const moduleName = pending.pop()!;
      const appDangers = result[id]!;
      if (Object.prototype.hasOwnProperty.call(appDangers, moduleName))
        continue;
      const inspected = moduleGraph.get(moduleName);
      if (!inspected) throwMissingCompileModule(moduleName);
      if (whitelist[moduleName]) {
        appDangers[moduleName] = [];
        continue;
      }
      appDangers[moduleName] = [...inspected.findings];
      for (let index = inspected.imports.length - 1; index >= 0; index -= 1) {
        pending.push(inspected.imports[index]!);
      }
    }
  }
  for (const id of Object.keys(configs)) result[id] ??= {};
  debug(result);
  return result;
}

function targetCompileRoots(
  configs: CompileConfig,
  plan: MemoryMigrationPlan,
  committedRetirements: readonly ManagedMemoryRetirement[],
): Map<string, Set<string>> {
  const roots = new Map<string, Set<string>>();
  const add = (owner: string, entry: string): void => {
    const entries = roots.get(owner) ?? new Set<string>();
    entries.add(entry);
    roots.set(owner, entries);
  };
  for (const manifest of Object.values(configs)) {
    add(manifest.id, manifest.entry);
    for (const memory of Object.values(manifest.memory ?? {})) {
      if (memory.retired) continue;
      const entry = memory.schemas?.[String(memory.version ?? 1)]?.entry;
      if (entry) add(manifest.id, entry);
    }
  }
  for (const upgrade of plan.upgrades) {
    if (upgrade.kind === "migrate") {
      add(upgrade.owner, upgrade.oldSchemaEntry);
      for (const edge of upgrade.path) add(upgrade.owner, edge.entry);
    } else if (upgrade.kind === "retire") {
      add(upgrade.owner, upgrade.oldSchemaEntry);
    }
  }
  for (const retirement of committedRetirements) {
    add(retirement.owner, retirement.schemaEntry);
  }
  return roots;
}

function allRoots(roots: Map<string, Set<string>>): string[] {
  return [
    ...new Set([...roots.values()].flatMap((entries) => [...entries])),
  ].sort(compareCanonicalText);
}

function validateDataLossDiagnostics(
  diagnostics: Diagnostic[],
  plan: MemoryMigrationPlan,
  committedRetirements: readonly ManagedMemoryRetirement[],
): void {
  const dataLoss = diagnostics.filter(({ code }) => code === "M0207");
  if (dataLoss.length === 0) return;
  const allowed = new Set([
    ...plan.destructiveMemoryRoots.map(
      ({ owner, memoryId }) => managedMemoryStoreName(owner, memoryId),
    ),
    ...committedRetirements.map(
      ({ owner, memoryId }) =>
        retiredManagedMemoryStoreName(owner, memoryId),
    ),
  ]);
  for (const diagnostic of dataLoss) {
    const matches = [
      ...diagnostic.message.matchAll(MANAGED_MEMORY_STORE_NAME_PATTERN),
    ].map(([field]) => field);
    if (matches.length === 0 || matches.some((field) => !allowed.has(field))) {
      throw new Error(
        `Unplanned stable data loss (${diagnostic.code}): ${diagnostic.message}`,
      );
    }
  }
}

const TRUSTED_INSTALLATION_CONTEXT_STABLE_FIELD =
  "NeutronTrustedInstallationNetworkIdV1";

function resolveInstallationContext({
  previousStable,
  vetKeysEnvironment,
  freshInstallationContext,
}: {
  previousStable: string | null;
  vetKeysEnvironment: VetKeysEnvironment;
  freshInstallationContext: TrustedInstallationContextV1 | undefined;
}): ResolvedInstallationContext {
  const ownsPersistentContext = stableOwnsInstallationContext(previousStable);
  if (previousStable !== null && !ownsPersistentContext) {
    throw new Error(
      "The previous stable signature is not the current assembler format; clean reinstall is required",
    );
  }

  if (vetKeysEnvironment === "production") {
    if (freshInstallationContext !== undefined) {
      throw new Error(
        "Production compilation uses only the compiled IC mainnet root key",
      );
    }
    const context = mainnetTrustedInstallationContext();
    return {
      // The public assembler derives this value itself and rejects a
      // caller-supplied production context.
      assembly: undefined,
      identity: {
        kind: "trusted_v1",
        network_id_hex: trustedInstallationNetworkIdHex(context),
      },
    };
  }

  if (ownsPersistentContext) {
    if (freshInstallationContext !== undefined) {
      throw new Error(
        "A state-preserving upgrade cannot replace the trusted installation context",
      );
    }
    return {
      assembly: null,
      identity: { kind: "preserved_stable_v1" },
    };
  }

  if (freshInstallationContext === undefined) {
    throw new Error(
      "A fresh local installation requires trusted PocketIC root-key context",
    );
  }
  assertTrustedInstallationContext(freshInstallationContext);
  return {
    assembly: freshInstallationContext,
    identity: {
      kind: "trusted_v1",
      network_id_hex: trustedInstallationNetworkIdHex(
        freshInstallationContext,
      ),
    },
  };
}

function stableOwnsInstallationContext(previousStable: string | null): boolean {
  if (previousStable === null) return false;
  return new RegExp(
    `^\\s*stable ${TRUSTED_INSTALLATION_CONTEXT_STABLE_FIELD} : Blob;?$`,
    "mu",
  ).test(previousStable);
}

function createDeploymentId(
  configs: CompileConfig,
  plan: MemoryMigrationPlan,
  committedRetirements: readonly ManagedMemoryRetirement[],
  targetRetirements: readonly ManagedMemoryRetirement[],
  capabilityPlans: Record<string, CompiledCapabilityPlan>,
  appInstanceInventory: CompiledAppInstance[],
  managedMemoryInventory: CompiledManagedMemory[],
  compilerId: string,
  vetKeysEnvironment: VetKeysEnvironment,
  installationContext: InstallationContextIdentity,
  deploymentNonce: string | undefined,
): string {
  return hashContent(
    canonicalJson({
      assembler: ASSEMBLER_ID,
      compiler: compilerId,
      vetkeys_environment: vetKeysEnvironment,
      installation_context: installationContext,
      configs,
      plan,
      committed_memory_retirements: committedRetirements,
      target_memory_retirements: targetRetirements,
      capability_plans: capabilityPlans,
      app_instance_inventory: appInstanceInventory,
      managed_memory_inventory: managedMemoryInventory,
      ...(deploymentNonce === undefined
        ? {}
        : { deployment_nonce: deploymentNonce }),
    }),
  ).slice(0, 32);
}

function assertDeploymentNonce(
  value: string | undefined,
): asserts value is string | undefined {
  if (value !== undefined && !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(
      "deploymentNonce must be 16 bytes of lowercase hexadecimal",
    );
  }
}

function assertVetKeysEnvironment(
  value: unknown,
): asserts value is VetKeysEnvironment {
  if (value !== "production" && value !== "local") {
    throw new Error("vetKeys environment must be production or local");
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareCanonicalText(a, b))
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

export async function reachableMotokoFiles({
  configs,
  mofilesByPath,
  roots,
  mo,
}: {
  configs: CompileConfig;
  mofilesByPath: Map<string, string>;
  roots?: Map<string, Set<string>>;
  mo?: Motoko;
}): Promise<MotokoFile[]> {
  return (
    await inspectReachableMotokoFiles({
      configs,
      mofilesByPath,
      ...(roots ? { roots } : {}),
      ...(mo ? { mo } : {}),
    })
  ).files;
}

async function inspectReachableMotokoFiles({
  configs,
  mofilesByPath,
  roots,
  mo,
  inspectionCache = new Map(),
}: {
  configs: CompileConfig;
  mofilesByPath: Map<string, string>;
  roots?: Map<string, Set<string>>;
  mo?: Motoko;
  inspectionCache?: InspectionCache;
}): Promise<{ files: MotokoFile[]; graph: ModuleGraph }> {
  mo ??= await loadMotoko();
  const visited = new Set<string>();
  const graph: ModuleGraph = new Map();
  const entries = roots
    ? allRoots(roots)
    : Object.values(configs)
        .map((config) => config.entry)
        .sort(compareCanonicalText);
  const pending = [...entries].reverse();

  while (pending.length > 0) {
    const moduleName = pending.pop()!;
    const filePath = `${moduleName}.mo`;
    if (visited.has(filePath)) continue;
    const content = mofilesByPath.get(filePath);
    if (content === undefined) throwMissingCompileModule(moduleName);
    visited.add(filePath);
    let inspectedPromise = inspectionCache.get(filePath);
    if (!inspectedPromise) {
      inspectedPromise = inspectModule(mo, filePath, content);
      inspectionCache.set(filePath, inspectedPromise);
    }
    const inspected = await inspectedPromise;
    graph.set(moduleName, inspected);
    for (let index = inspected.imports.length - 1; index >= 0; index -= 1) {
      pending.push(inspected.imports[index]!);
    }
  }

  return {
    files: [...visited].map((path) => ({
      path,
      content: mofilesByPath.get(path)!,
    })),
    graph,
  };
}

async function inspectModule(
  mo: Motoko,
  filePath: string,
  content: string,
): Promise<InspectedModule> {
  const inspection: MotokoInspection = await mo.inspectMotoko(
    filePath,
    content,
  );
  const imports = filterCompilerImports(inspection.immediateImports);
  const findings = needsDangerousASTFallback(inspection, content)
    ? checkForDangerousASTCode(await mo.parseMotoko(content), content)
    : checkForDangerousSyntaxFacts(inspection, content);
  return {
    imports,
    findings,
  };
}

function filterCompilerImports(imports: readonly string[]): string[] {
  return imports.filter((path) => path !== "mo:⛔" && path !== "mo:prim");
}

function moduleMap(mofiles: MotokoFile[]): Map<string, string> {
  const modules = new Map<string, string>();
  for (const { path, content } of mofiles) modules.set(path, content);
  return modules;
}

async function resetCompilerFiles(mo: Motoko): Promise<void> {
  for (const path of await mo.list("")) await mo.delete(path);
}

function throwMissingCompileModule(moduleName: string): never {
  const filePath = `${moduleName}.mo`;
  throw new Error(
    `Motoko module ${filePath} is not in the current compile input`,
  );
}

export function extractImports(ast: unknown): string[] {
  let imports: string[] = [];
  function traverse(tree: unknown): void {
    if (isAstNode(tree) && tree.name === "ImportE") {
      const [importPath] = astArgs(tree);
      if (typeof importPath === "string") imports.push(importPath);
      return;
    }
    for (const node of astArgs(tree)) {
      if (typeof node !== "string") traverse(node);
    }
  }
  traverse(ast);
  return filterCompilerImports(imports);
}
