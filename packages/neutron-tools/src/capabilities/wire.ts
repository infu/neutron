import { sha256 } from "js-sha256";
import { isValidAppId } from "../app_ids.ts";
import {
  BACKEND_CAPABILITY_INTERFACES,
  CAPABILITY_CATALOG,
  CAPABILITY_IDS,
  HTTP_ROUTES_MAX_MOUNTS,
  assertCapabilityComposition,
  deriveCertifiedReadRoutes,
  normalizeDeclaredCapability,
  type BackendCapabilityInterfaceId,
  type CapabilityApiVersion,
  type CapabilityCatalogEntry,
  type CapabilityId,
  type NeutronCertifiedReadRouteMountConfig,
  type NeutronCertifiedReadRoutesCapabilityConfig,
  type NormalizedNeutronCapabilitiesConfig,
} from "./catalog.ts";
import {
  CAPABILITY_PLAN_VERSION,
  type CapabilityPlan,
  type CapabilityPlanEntry,
} from "./plan.ts";
import {
  assertSafeRelativeAssetPath,
  MANIFEST_MAX_FUNCTION_ARGS,
  MANIFEST_MAX_FUNCTIONS,
  MANIFEST_MAX_MEMORY_MIGRATIONS_TOTAL,
  MANIFEST_MAX_MEMORY_ROOTS,
  MANIFEST_MAX_TILES,
  normalizeUntrustedText,
} from "../schema.ts";
import { compareCanonicalText } from "../canonical.ts";
import { assertAppVersion } from "../version.ts";
import { isValidTileId } from "../tile_ids.ts";

export const CAPABILITY_PLAN_WIRE_VERSION = 1 as const;
export const CAPABILITY_PLAN_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export type CapabilityPlanWireV1 = {
  format: typeof CAPABILITY_PLAN_WIRE_VERSION;
  app: { id: string; version: number };
  entries: CapabilityPlanEntry[];
};

export type CapabilityInstallDisclosureWireV1 = {
  id: CapabilityId;
  api: CapabilityApiVersion;
  provenance: "declared" | "derived";
  title: string;
  summary: string;
  entry: CapabilityPlanEntry;
};

export type CapabilityInstallDisclosuresWireV1 = {
  format: 1;
  plan_fingerprint: string;
  entries: CapabilityInstallDisclosureWireV1[];
};

export type CapabilitySettingsEntryWireV1 =
  CapabilityInstallDisclosureWireV1 & {
    delivery: readonly (
      | "backend_environment"
      | "frontend_endpoint"
      | "invocation"
      | "compiler_registration"
    )[];
    namespace: "app_installation";
    grant: CapabilityCatalogEntry["grant"];
    escalation: CapabilityCatalogEntry["escalation"];
    disable: CapabilityCatalogEntry["disable"];
    revocation: CapabilityCatalogEntry["revocation"];
    quota: string;
    audit: string;
  };

export type CapabilitySettingsWireV1 = {
  format: 1;
  app: { id: string; version: number };
  plan_fingerprint: string;
  entries: CapabilitySettingsEntryWireV1[];
};

export const CAPABILITY_PLAN_DIFF_VERSION = 1 as const;

export type CapabilityPlanDiffEntryV1 =
  | {
      change: "added";
      id: CapabilityId;
      before: null;
      after: CapabilityPlanEntry;
    }
  | {
      change: "removed";
      id: CapabilityId;
      before: CapabilityPlanEntry;
      after: null;
    }
  | {
      change: "changed";
      id: CapabilityId;
      before: CapabilityPlanEntry;
      after: CapabilityPlanEntry;
    };

export type CapabilityPlanDiffV1 = {
  format: typeof CAPABILITY_PLAN_DIFF_VERSION;
  app_id: string;
  previous: { version: number; plan_fingerprint: string };
  target: { version: number; plan_fingerprint: string };
  entries: CapabilityPlanDiffEntryV1[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertClosed(
  value: unknown,
  label: string,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined)
    throw new Error(`Unknown ${label} field ${unknown}`);
}

function assertPositiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertMethod(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(value)
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function parseDeclaredEntry(
  id: Extract<CapabilityId, keyof NormalizedNeutronCapabilitiesConfig>,
  config: unknown,
  appId: string,
  hasBackground: boolean,
): CapabilityPlanEntry {
  if (id === "preapproved_self_calls") {
    return parsePreapprovedSelfCalls(config);
  }
  const normalizedConfig = normalizeDeclaredCapability(id, config, {
    appId,
    hasBackground,
    normalizeText: normalizeUntrustedText,
  });
  if (!normalizedConfig) throw new Error(`Invalid ${id} capability`);
  return {
    id,
    api: (normalizedConfig as { api: CapabilityApiVersion }).api,
    provenance: "declared",
    config: normalizedConfig,
  } as CapabilityPlanEntry;
}

function parsePreapprovedSelfCalls(config: unknown): CapabilityPlanEntry {
  assertClosed(config, "preapproved_self_calls plan config", [
    "api",
    "methods",
  ]);
  if (
    config.api !== 1 ||
    !Array.isArray(config.methods) ||
    config.methods.length < 1 ||
    config.methods.length > 32
  ) {
    throw new Error("Invalid preapproved_self_calls plan config");
  }
  const names = new Set<string>();
  const methods = config.methods.map((candidate) => {
    assertClosed(candidate, "preapproved_self_calls plan method", [
      "method",
      "mode",
    ]);
    assertMethod(candidate.method, "preapproved_self_calls plan method name");
    if (candidate.mode !== "query" && candidate.mode !== "update") {
      throw new Error("Invalid preapproved_self_calls plan method mode");
    }
    if (names.has(candidate.method)) {
      throw new Error(
        `Duplicate preapproved_self_calls plan method ${candidate.method}`,
      );
    }
    names.add(candidate.method);
    return {
      method: candidate.method,
      mode: candidate.mode as "query" | "update",
    };
  });
  methods.sort((left, right) =>
    compareCanonicalText(left.method, right.method),
  );
  return {
    id: "preapproved_self_calls",
    api: 1,
    provenance: "declared",
    config: { api: 1, methods },
  } as CapabilityPlanEntry;
}

function parseStableMemory(config: unknown): CapabilityPlanEntry {
  assertClosed(config, "stable_memory config", ["resources"]);
  if (
    !Array.isArray(config.resources) ||
    config.resources.length < 1 ||
    config.resources.length > MANIFEST_MAX_MEMORY_ROOTS
  ) {
    throw new Error("Invalid stable_memory resources");
  }
  const ids = new Set<string>();
  const resources = config.resources.map((resource) => {
    assertClosed(resource, "stable_memory resource", ["id", "version"]);
    assertIdentifier(resource.id, "stable_memory resource id");
    assertPositiveInteger(resource.version, "stable_memory resource version");
    if (ids.has(resource.id)) {
      throw new Error(`Duplicate stable_memory resource ${resource.id}`);
    }
    ids.add(resource.id);
    return { id: resource.id, version: resource.version };
  });
  resources.sort((a, b) => compareCanonicalText(a.id, b.id));
  return {
    id: "stable_memory",
    api: 1,
    provenance: "derived",
    config: { resources },
  };
}

function parseMemoryLifecycle(config: unknown): CapabilityPlanEntry {
  assertClosed(config, "memory_lifecycle config", [
    "retirements",
    "consumptions",
  ]);
  if (
    !Array.isArray(config.retirements) ||
    config.retirements.length > MANIFEST_MAX_MEMORY_ROOTS ||
    !Array.isArray(config.consumptions) ||
    config.consumptions.length > MANIFEST_MAX_MEMORY_MIGRATIONS_TOTAL ||
    (config.retirements.length === 0 && config.consumptions.length === 0)
  ) {
    throw new Error("Invalid memory_lifecycle config");
  }
  const retiredIds = new Set<string>();
  const retirements = config.retirements.map((retirement) => {
    assertClosed(retirement, "memory retirement", ["id"]);
    assertIdentifier(retirement.id, "retired memory id");
    if (retiredIds.has(retirement.id)) {
      throw new Error(`Duplicate retired memory ${retirement.id}`);
    }
    retiredIds.add(retirement.id);
    return { id: retirement.id };
  });
  retirements.sort((left, right) => compareCanonicalText(left.id, right.id));

  const edges = new Set<string>();
  const consumptions = config.consumptions.map((consumption) => {
    assertClosed(consumption, "memory consumption", [
      "memory",
      "from",
      "to",
      "retired_resources",
    ]);
    assertIdentifier(consumption.memory, "memory consumption target");
    assertPositiveInteger(consumption.from, "memory consumption from version");
    assertPositiveInteger(consumption.to, "memory consumption to version");
    if (consumption.from >= consumption.to) {
      throw new Error("Memory consumption must be forward-only");
    }
    const edge = `${consumption.memory}:${consumption.from}->${consumption.to}`;
    if (edges.has(edge))
      throw new Error(`Duplicate memory consumption ${edge}`);
    edges.add(edge);
    if (
      !Array.isArray(consumption.retired_resources) ||
      consumption.retired_resources.length < 1 ||
      consumption.retired_resources.length > 16
    ) {
      throw new Error("Invalid consumed retired resources");
    }
    const seen = new Set<string>();
    const retiredResources = consumption.retired_resources.map((id) => {
      assertIdentifier(id, "consumed retired memory id");
      if (!retiredIds.has(id)) {
        throw new Error(
          `Memory consumption references non-retired memory ${id}`,
        );
      }
      if (seen.has(id))
        throw new Error(`Duplicate consumed retired memory ${id}`);
      seen.add(id);
      return id;
    });
    return {
      memory: consumption.memory,
      from: consumption.from,
      to: consumption.to,
      retired_resources: retiredResources,
    };
  });
  consumptions.sort(
    (left, right) =>
      compareCanonicalText(left.memory, right.memory) ||
      left.from - right.from ||
      left.to - right.to,
  );
  return {
    id: "memory_lifecycle",
    api: 1,
    provenance: "derived",
    config: { retirements, consumptions },
  };
}

function parseAppCalls(config: unknown, appId: string): CapabilityPlanEntry {
  assertClosed(config, "app_calls config", ["dependencies"]);
  if (
    !Array.isArray(config.dependencies) ||
    config.dependencies.length < 1 ||
    config.dependencies.length > 32
  ) {
    throw new Error("Invalid app_calls dependencies");
  }
  const aliases = new Set<string>();
  const dependencies = config.dependencies.map((dependency) => {
    assertClosed(dependency, "app_calls dependency", [
      "alias",
      "app",
      "min_version",
      "methods",
    ]);
    if (
      typeof dependency.alias !== "string" ||
      !/^[a-z][a-z0-9_]{0,29}$/.test(dependency.alias) ||
      !isValidAppId(dependency.app)
    ) {
      throw new Error("Invalid app_calls dependency");
    }
    if (dependency.app === appId || dependency.app === "kernel") {
      throw new Error("Invalid app_calls dependency target");
    }
    assertAppVersion(dependency.min_version, "app_calls minimum version");
    if (
      !Array.isArray(dependency.methods) ||
      dependency.methods.length < 1 ||
      dependency.methods.length > 64
    ) {
      throw new Error("Invalid app_calls methods");
    }
    if (aliases.has(dependency.alias)) {
      throw new Error(`Duplicate app_calls dependency ${dependency.alias}`);
    }
    aliases.add(dependency.alias);
    const methods = new Set<string>();
    for (const method of dependency.methods) {
      assertMethod(method, "app_calls method");
      if (methods.has(method))
        throw new Error(`Duplicate app_calls method ${method}`);
      methods.add(method);
    }
    return {
      alias: dependency.alias,
      app: dependency.app,
      min_version: dependency.min_version,
      methods: [...methods].sort(compareCanonicalText),
    };
  });
  dependencies.sort((a, b) => compareCanonicalText(a.alias, b.alias));
  return {
    id: "app_calls",
    api: 1,
    provenance: "derived",
    config: { dependencies },
  };
}

function parseBackendEnvironment(config: unknown): CapabilityPlanEntry {
  assertClosed(config, "backend_environment config", ["interfaces"]);
  if (
    !Array.isArray(config.interfaces) ||
    config.interfaces.length < 1 ||
    config.interfaces.length > Object.keys(BACKEND_CAPABILITY_INTERFACES).length
  ) {
    throw new Error("Invalid backend_environment interfaces");
  }
  const ids = new Set<BackendCapabilityInterfaceId>();
  const interfaces = config.interfaces.map((candidate) => {
    assertClosed(candidate, "backend_environment interface", ["id", "api"]);
    if (
      typeof candidate.id !== "string" ||
      !Object.prototype.hasOwnProperty.call(
        BACKEND_CAPABILITY_INTERFACES,
        candidate.id,
      )
    ) {
      throw new Error(
        `Unknown backend_environment interface ${String(candidate.id)}`,
      );
    }
    const id = candidate.id as BackendCapabilityInterfaceId;
    const definition = BACKEND_CAPABILITY_INTERFACES[id];
    if (candidate.api !== definition.api) {
      throw new Error(`Unsupported backend_environment interface ${id} API`);
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate backend_environment interface ${id}`);
    }
    ids.add(id);
    return { id, api: definition.api };
  });
  interfaces.sort((left, right) => compareCanonicalText(left.id, right.id));
  return {
    id: "backend_environment",
    api: 1,
    provenance: "derived",
    config: { interfaces },
  };
}

function parseCertifiedReadRoutes(config: unknown): CapabilityPlanEntry {
  assertClosed(config, "certified_read_routes config", ["mounts"]);
  if (
    !Array.isArray(config.mounts) ||
    config.mounts.length < 1 ||
    config.mounts.length > HTTP_ROUTES_MAX_MOUNTS
  ) {
    throw new Error("Invalid certified_read_routes mounts");
  }
  const ids = new Set<string>();
  const mounts: NeutronCertifiedReadRouteMountConfig[] = config.mounts.map(
    (mount) => {
      assertClosed(mount, "certified read route mount", [
        "id",
        "surface",
        "authority_mode",
        "methods",
        "mode",
        "store",
        "max_request_bytes",
      ]);
      if (
        typeof mount.id !== "string" ||
        !/^[a-z][a-z0-9_]{0,39}$/.test(mount.id) ||
        mount.surface !== "shared_app_path" ||
        (mount.authority_mode !== "exact_neutron_host_v1" &&
          mount.authority_mode !== "canister_gateway_v1") ||
        mount.mode !== "certified_store" ||
        mount.store !== "certified_assets" ||
        mount.max_request_bytes !== 0 ||
        !Array.isArray(mount.methods)
      ) {
        throw new Error("Invalid certified read route mount");
      }
      const methods =
        mount.authority_mode === "exact_neutron_host_v1"
          ? (["GET", "HEAD"] as ["GET", "HEAD"])
          : (["GET"] as ["GET"]);
      if (
        mount.methods.length !== methods.length ||
        mount.methods.some((method, index) => method !== methods[index])
      ) {
        throw new Error("Invalid certified read route methods");
      }
      if (ids.has(mount.id)) {
        throw new Error(`Duplicate certified read route mount ${mount.id}`);
      }
      ids.add(mount.id);
      return {
        id: mount.id,
        surface: "shared_app_path" as const,
        authority_mode: mount.authority_mode as
          "exact_neutron_host_v1" | "canister_gateway_v1",
        methods,
        mode: "certified_store" as const,
        store: "certified_assets" as const,
        max_request_bytes: 0 as const,
      };
    },
  );
  mounts.sort((left, right) => compareCanonicalText(left.id, right.id));
  const normalized: NeutronCertifiedReadRoutesCapabilityConfig = { mounts };
  return {
    id: "certified_read_routes",
    api: 1,
    provenance: "derived",
    config: normalized,
  };
}

function parseFunctionResources(
  config: unknown,
  appId: string,
): CapabilityPlanEntry {
  assertClosed(config, "function_resources config", ["functions"]);
  if (
    !Array.isArray(config.functions) ||
    config.functions.length < 1 ||
    config.functions.length > MANIFEST_MAX_FUNCTIONS
  ) {
    throw new Error("Invalid function_resources functions");
  }
  const names = new Set<string>();
  const functions = config.functions.map((binding) => {
    assertClosed(binding, "function_resources function", [
      "method",
      "mode",
      "resources",
    ]);
    assertMethod(binding.method, "function_resources method");
    if (
      binding.mode !== "query" &&
      binding.mode !== "update" &&
      binding.mode !== "internal"
    ) {
      throw new Error("Invalid function_resources function mode");
    }
    if (names.has(binding.method)) {
      throw new Error(`Duplicate function_resources method ${binding.method}`);
    }
    names.add(binding.method);
    if (
      !Array.isArray(binding.resources) ||
      binding.resources.length < 1 ||
      binding.resources.length > MANIFEST_MAX_FUNCTION_ARGS
    ) {
      throw new Error("Invalid function_resources resources");
    }
    const seen = new Set<string>();
    const resources = binding.resources.map((resource) => {
      assertClosed(resource, "function resource", ["kind", "id", "interfaces"]);
      let parsed:
        | { kind: "caller" }
        | { kind: "canister_principal" }
        | { kind: "public_ingress_cycles" }
        | { kind: "actor_self" }
        | { kind: "stable_memory"; id: string }
        | {
            kind: "task_capabilities";
            interfaces: Array<{ id: "backend_calls"; api: 1 }>;
          };
      switch (resource.kind) {
        case "caller":
        case "canister_principal":
        case "public_ingress_cycles":
          if (
            Object.prototype.hasOwnProperty.call(resource, "id") ||
            Object.prototype.hasOwnProperty.call(resource, "interfaces")
          ) {
            throw new Error(`Invalid ${resource.kind} function resource`);
          }
          parsed = { kind: resource.kind };
          break;
        case "task_capabilities": {
          if (
            Object.prototype.hasOwnProperty.call(resource, "id") ||
            !Array.isArray(resource.interfaces) ||
            resource.interfaces.length !== 1
          ) {
            throw new Error("Invalid task_capabilities function resource");
          }
          const [taskInterface] = resource.interfaces;
          assertClosed(taskInterface, "task capability interface", [
            "id",
            "api",
          ]);
          if (taskInterface.id !== "backend_calls" || taskInterface.api !== 1) {
            throw new Error("Invalid task capability interface");
          }
          parsed = {
            kind: "task_capabilities",
            interfaces: [{ id: "backend_calls", api: 1 }],
          };
          break;
        }
        case "actor_self":
          if (
            appId !== "kernel" ||
            Object.prototype.hasOwnProperty.call(resource, "id") ||
            Object.prototype.hasOwnProperty.call(resource, "interfaces")
          ) {
            throw new Error("Invalid actor_self function resource");
          }
          parsed = { kind: "actor_self" };
          break;
        case "stable_memory":
          if (Object.prototype.hasOwnProperty.call(resource, "interfaces")) {
            throw new Error("Invalid stable_memory function resource");
          }
          assertIdentifier(resource.id, "function resource memory id");
          parsed = { kind: "stable_memory", id: resource.id };
          break;
        default:
          throw new Error(`Unknown function resource ${String(resource.kind)}`);
      }
      const key =
        parsed.kind === "stable_memory"
          ? `${parsed.kind}:${parsed.id}`
          : parsed.kind;
      if (seen.has(key)) throw new Error(`Duplicate function resource ${key}`);
      seen.add(key);
      return parsed;
    });
    return {
      method: binding.method,
      mode: binding.mode as "query" | "update" | "internal",
      resources,
    };
  });
  functions.sort((left, right) =>
    compareCanonicalText(left.method, right.method),
  );
  return {
    id: "function_resources",
    api: 1,
    provenance: "derived",
    config: { functions },
  };
}

function parseFunctionRegistration(
  id: "app_exports",
  config: unknown,
): CapabilityPlanEntry {
  assertClosed(config, `${id} config`, ["methods"]);
  if (
    !Array.isArray(config.methods) ||
    config.methods.length < 1 ||
    config.methods.length > MANIFEST_MAX_FUNCTIONS
  ) {
    throw new Error(`Invalid ${id} methods`);
  }
  const names = new Set<string>();
  const methods = config.methods.map((method) => {
    assertClosed(method, `${id} method`, ["method", "mode"]);
    assertMethod(method.method, `${id} method name`);
    if (method.mode !== "query" && method.mode !== "update") {
      throw new Error(`Invalid ${id} method mode`);
    }
    if (names.has(method.method))
      throw new Error(`Duplicate ${id} method ${method.method}`);
    names.add(method.method);
    return { method: method.method, mode: method.mode };
  });
  methods.sort((a, b) => compareCanonicalText(a.method, b.method));
  return {
    id,
    api: 1,
    provenance: "derived",
    config: { methods },
  } as CapabilityPlanEntry;
}

function parseTileEndpoints(config: unknown): CapabilityPlanEntry {
  assertClosed(config, "tile_endpoints config", ["endpoints"]);
  if (
    !Array.isArray(config.endpoints) ||
    config.endpoints.length < 1 ||
    config.endpoints.length > MANIFEST_MAX_TILES
  ) {
    throw new Error("Invalid tile_endpoints endpoints");
  }
  const ids = new Set<string>();
  const endpoints = config.endpoints.map((endpoint) => {
    assertClosed(endpoint, "tile endpoint", ["id", "path"]);
    if (!isValidTileId(endpoint.id)) {
      throw new Error("Invalid tile endpoint id");
    }
    assertSafeRelativeAssetPath(endpoint.path, "tile endpoint path");
    if (ids.has(endpoint.id))
      throw new Error(`Duplicate tile endpoint ${endpoint.id}`);
    ids.add(endpoint.id);
    return { id: endpoint.id, path: endpoint.path };
  });
  endpoints.sort((a, b) => compareCanonicalText(a.id, b.id));
  return {
    id: "tile_endpoints",
    api: 1,
    provenance: "derived",
    config: { endpoints },
  };
}

function parseSingleEndpoint(
  id: "background_endpoint" | "tray_endpoint",
  config: unknown,
): CapabilityPlanEntry {
  assertClosed(
    config,
    `${id} config`,
    id === "background_endpoint" ? ["path", "frame_security"] : ["path"],
  );
  assertSafeRelativeAssetPath(config.path, `${id} path`);
  if (id === "background_endpoint") {
    if (
      config.frame_security !== "credentialless_opaque_v1" &&
      config.frame_security !== "credentialless_ephemeral_dedicated_v1" &&
      config.frame_security !== "persistent_dedicated_v1"
    ) {
      throw new Error("Invalid background_endpoint frame security");
    }
    return {
      id,
      api: 1,
      provenance: "derived",
      config: {
        path: config.path,
        frame_security: config.frame_security,
      },
    };
  }
  return { id, api: 1, provenance: "derived", config: { path: config.path } };
}

function parseEntry(
  value: unknown,
  appId: string,
  hasBackground: boolean,
): CapabilityPlanEntry {
  assertClosed(value, "capability plan entry", [
    "id",
    "api",
    "provenance",
    "config",
  ]);
  if (typeof value.id !== "string" || !(value.id in CAPABILITY_CATALOG)) {
    throw new Error(`Unknown capability plan entry ${String(value.id)}`);
  }
  const id = value.id as CapabilityId;
  const definition = CAPABILITY_CATALOG[id];
  if (value.provenance !== definition.provenance) {
    throw new Error(`Invalid ${id} capability provenance`);
  }
  let parsed: CapabilityPlanEntry;
  if (definition.provenance === "declared") {
    parsed = parseDeclaredEntry(
      id as Extract<CapabilityId, keyof NormalizedNeutronCapabilitiesConfig>,
      value.config,
      appId,
      hasBackground,
    );
  } else {
    switch (id) {
      case "stable_memory":
        parsed = parseStableMemory(value.config);
        break;
      case "memory_lifecycle":
        parsed = parseMemoryLifecycle(value.config);
        break;
      case "app_calls":
        parsed = parseAppCalls(value.config, appId);
        break;
      case "backend_environment":
        parsed = parseBackendEnvironment(value.config);
        break;
      case "certified_read_routes":
        parsed = parseCertifiedReadRoutes(value.config);
        break;
      case "function_resources":
        parsed = parseFunctionResources(value.config, appId);
        break;
      case "app_exports":
        parsed = parseFunctionRegistration(id, value.config);
        break;
      case "tile_endpoints":
        parsed = parseTileEndpoints(value.config);
        break;
      case "background_endpoint":
      case "tray_endpoint":
        parsed = parseSingleEndpoint(id, value.config);
        break;
      default:
        throw new Error(`Unknown derived capability ${id}`);
    }
  }
  if (value.api !== parsed.api) {
    throw new Error(`Unsupported ${id} capability API`);
  }
  return parsed;
}

/** Parse, close, and canonicalize an untrusted plan-wire value. */
export function parseCapabilityPlanWireV1(
  value: unknown,
): CapabilityPlanWireV1 {
  assertClosed(value, "capability plan wire", ["format", "app", "entries"]);
  if (value.format !== 1)
    throw new Error("Unsupported capability plan wire format");
  assertClosed(value.app, "capability plan app", ["id", "version"]);
  if (!isValidAppId(value.app.id)) {
    throw new Error("Invalid capability plan app id");
  }
  assertAppVersion(value.app.version, "capability plan app version");
  const appId = value.app.id;
  const appVersion = value.app.version;
  if (
    !Array.isArray(value.entries) ||
    value.entries.length > CAPABILITY_IDS.length
  ) {
    throw new Error("Invalid capability plan entries");
  }
  const hasBackground = value.entries.some(
    (entry) => isRecord(entry) && entry.id === "background_endpoint",
  );
  const ids = new Set<CapabilityId>();
  const entries = value.entries.map((entry) => {
    const parsed = parseEntry(entry, appId, hasBackground);
    if (ids.has(parsed.id))
      throw new Error(`Duplicate capability plan entry ${parsed.id}`);
    ids.add(parsed.id);
    return parsed;
  });
  if (ids.has("tray_endpoint") && !ids.has("background_endpoint")) {
    throw new Error("Tray capability requires a background endpoint");
  }
  const declarations = Object.fromEntries(
    entries
      .filter((entry) => entry.provenance === "declared")
      .map((entry) => [entry.id, entry.config]),
  ) as NormalizedNeutronCapabilitiesConfig;
  const tileEndpoints = entries.find(
    (entry) => entry.id === "tile_endpoints",
  );
  assertCapabilityComposition(declarations, {
    tileIds:
      tileEndpoints?.id === "tile_endpoints"
        ? tileEndpoints.config.endpoints.map(({ id }) => id)
        : [],
  });
  const certifiedAssets = entries.find(
    (entry) => entry.id === "certified_assets",
  );
  const certifiedReadRoutes = entries.find(
    (entry) => entry.id === "certified_read_routes",
  );
  if (
    (certifiedAssets?.id === "certified_assets") !==
    (certifiedReadRoutes?.id === "certified_read_routes")
  ) {
    throw new Error(
      "certified_assets requires its exact derived certified_read_routes entry",
    );
  }
  if (
    certifiedAssets?.id === "certified_assets" &&
    certifiedReadRoutes?.id === "certified_read_routes" &&
    canonicalJson(certifiedReadRoutes.config) !==
      canonicalJson(deriveCertifiedReadRoutes(certifiedAssets.config))
  ) {
    throw new Error(
      "certified_read_routes does not match the certified_assets declaration",
    );
  }
  const background = entries.find(
    (entry) => entry.id === "background_endpoint",
  );
  const expectedFrameSecurity = ids.has("persistent_browser_storage")
    ? "persistent_dedicated_v1"
    : ids.has("dedicated_resident_origin")
      ? "credentialless_ephemeral_dedicated_v1"
      : "credentialless_opaque_v1";
  if (
    (ids.has("persistent_browser_storage") ||
      ids.has("dedicated_resident_origin")) &&
    background?.id !== "background_endpoint"
  ) {
    throw new Error("Dedicated resident capabilities require a background");
  }
  if (
    background?.id === "background_endpoint" &&
    background.config.frame_security !== expectedFrameSecurity
  ) {
    throw new Error(
      "Background frame security is inconsistent with resident capabilities",
    );
  }
  const backendEnvironment = entries.find(
    (entry) => entry.id === "backend_environment",
  );
  if (backendEnvironment?.id === "backend_environment") {
    if (appId === "kernel") {
      throw new Error("Kernel cannot receive an app backend environment");
    }
    for (const backendInterface of backendEnvironment.config.interfaces) {
      const declaration =
        BACKEND_CAPABILITY_INTERFACES[backendInterface.id].declaration;
      if (declaration !== null && !ids.has(declaration)) {
        throw new Error(
          `Backend interface ${backendInterface.id} requires ${declaration} declaration`,
        );
      }
    }
  }
  if (ids.has("certified_assets")) {
    const certifiedInterface =
      backendEnvironment?.id === "backend_environment"
        ? backendEnvironment.config.interfaces.find(
            ({ id }) => id === "certified_assets",
          )
        : undefined;
    if (certifiedInterface?.api !== 2) {
      throw new Error(
        "certified_assets API 2 requires backend_environment certified_assets API 2",
      );
    }
  }
  const functionResources = entries.find(
    (entry) => entry.id === "function_resources",
  );
  if (functionResources?.id === "function_resources") {
    const publicIngress = entries.find(
      (entry) => entry.id === "public_ingress",
    );
    const stableMemory = entries.find((entry) => entry.id === "stable_memory");
    const memoryIds = new Set(
      stableMemory?.id === "stable_memory"
        ? stableMemory.config.resources.map(({ id }) => id)
        : [],
    );
    const scheduledTasks = entries.find(
      (entry) => entry.id === "scheduled_tasks",
    );
    const scheduledMethods = new Set(
      scheduledTasks?.id === "scheduled_tasks"
        ? scheduledTasks.config.tasks.map(({ method }) => method)
        : [],
    );
    const hasBackendCalls = ids.has("backend_calls");
    for (const binding of functionResources.config.functions) {
      for (const resource of binding.resources) {
        if (resource.kind === "stable_memory" && !memoryIds.has(resource.id)) {
          throw new Error(
            `Function resource references unknown memory ${resource.id}`,
          );
        }
        if (
          resource.kind === "task_capabilities" &&
          (!hasBackendCalls ||
            binding.mode !== "internal" ||
            !scheduledMethods.has(binding.method))
        ) {
          throw new Error(
            `Invalid task capabilities resource for ${binding.method}`,
          );
        }
        if (resource.kind === "public_ingress_cycles") {
          const handlerRoutes =
            publicIngress?.id === "public_ingress"
              ? publicIngress.config.routes.filter(
                  (route) => route.handler === binding.method,
                )
              : [];
          if (
            binding.mode !== "update" ||
            handlerRoutes.length === 0 ||
            handlerRoutes.some(
              (route) => route.mode !== "update" || route.caller !== "canister",
            )
          ) {
            throw new Error(
              `Invalid public_ingress_cycles resource for ${binding.method}`,
            );
          }
        }
        if (resource.kind === "caller" && binding.mode === "internal") {
          throw new Error(
            `Internal function ${binding.method} cannot receive caller`,
          );
        }
        if (
          (resource.kind === "actor_self" ||
            resource.kind === "stable_memory") &&
          binding.mode === "internal"
        ) {
          throw new Error(
            `Internal function ${binding.method} cannot receive ${resource.kind}`,
          );
        }
      }
    }
  }
  const memoryLifecycle = entries.find(
    (entry) => entry.id === "memory_lifecycle",
  );
  if (memoryLifecycle?.id === "memory_lifecycle") {
    const stableMemory = entries.find((entry) => entry.id === "stable_memory");
    const activeMemoryIds = new Set(
      stableMemory?.id === "stable_memory"
        ? stableMemory.config.resources.map(({ id }) => id)
        : [],
    );
    const activeMemoryVersions = new Map(
      stableMemory?.id === "stable_memory"
        ? stableMemory.config.resources.map(({ id, version }) => [id, version])
        : [],
    );
    for (const { id } of memoryLifecycle.config.retirements) {
      if (activeMemoryIds.has(id)) {
        throw new Error(`Memory ${id} cannot be both active and retired`);
      }
    }
    for (const consumption of memoryLifecycle.config.consumptions) {
      if (!activeMemoryIds.has(consumption.memory)) {
        throw new Error(
          `Memory consumption target ${consumption.memory} is not active`,
        );
      }
      if (
        consumption.to > (activeMemoryVersions.get(consumption.memory) ?? 0)
      ) {
        throw new Error(
          `Memory consumption exceeds ${consumption.memory}'s active version`,
        );
      }
    }
  }
  const order = new Map(CAPABILITY_IDS.map((id, index) => [id, index]));
  entries.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return {
    format: CAPABILITY_PLAN_WIRE_VERSION,
    app: { id: appId, version: appVersion },
    entries,
  };
}

export function toCapabilityPlanWireV1(
  plan: CapabilityPlan,
): CapabilityPlanWireV1 {
  if (plan.version !== CAPABILITY_PLAN_VERSION) {
    throw new Error("Unsupported capability plan version");
  }
  return parseCapabilityPlanWireV1({
    format: CAPABILITY_PLAN_WIRE_VERSION,
    app: plan.app,
    entries: plan.entries,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCanonicalText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function serializeCapabilityPlanWireV1(
  wire: CapabilityPlanWireV1,
): string {
  return canonicalJson(parseCapabilityPlanWireV1(wire));
}

export function fingerprintCapabilityPlanWireV1(
  wire: CapabilityPlanWireV1,
): string {
  return sha256(serializeCapabilityPlanWireV1(wire));
}

export function verifyCapabilityPlanFingerprint(
  wire: CapabilityPlanWireV1,
  expected: string,
): boolean {
  return (
    CAPABILITY_PLAN_FINGERPRINT_PATTERN.test(expected) &&
    fingerprintCapabilityPlanWireV1(wire) === expected
  );
}

export function assertCapabilityPlanFingerprint(
  wire: CapabilityPlanWireV1,
  expected: string,
): void {
  if (!verifyCapabilityPlanFingerprint(wire, expected)) {
    throw new Error("Capability plan fingerprint mismatch");
  }
}

function asWire(
  plan: CapabilityPlan | CapabilityPlanWireV1,
): CapabilityPlanWireV1 {
  return "format" in plan
    ? parseCapabilityPlanWireV1(plan)
    : toCapabilityPlanWireV1(plan);
}

/**
 * Compare two independently validated plans for the same app.
 *
 * The result is deterministic catalogue order and retains the complete closed
 * entries on both sides. It deliberately does not guess whether a changed
 * entry is broader or narrower: capability-specific compatibility policy must
 * make that decision.
 */
export function diffCapabilityPlans(
  previousPlan: CapabilityPlan | CapabilityPlanWireV1,
  targetPlan: CapabilityPlan | CapabilityPlanWireV1,
): CapabilityPlanDiffV1 {
  const previous = asWire(previousPlan);
  const target = asWire(targetPlan);
  if (previous.app.id !== target.app.id) {
    throw new Error("Cannot diff capability plans for different apps");
  }

  const previousEntries = new Map(
    previous.entries.map((entry) => [entry.id, entry] as const),
  );
  const targetEntries = new Map(
    target.entries.map((entry) => [entry.id, entry] as const),
  );
  const entries: CapabilityPlanDiffEntryV1[] = [];
  for (const id of CAPABILITY_IDS) {
    const before = previousEntries.get(id);
    const after = targetEntries.get(id);
    if (!before && after) {
      entries.push({ change: "added", id, before: null, after });
    } else if (before && !after) {
      entries.push({ change: "removed", id, before, after: null });
    } else if (
      before &&
      after &&
      canonicalJson(before) !== canonicalJson(after)
    ) {
      entries.push({ change: "changed", id, before, after });
    }
  }

  return {
    format: CAPABILITY_PLAN_DIFF_VERSION,
    app_id: previous.app.id,
    previous: {
      version: previous.app.version,
      plan_fingerprint: fingerprintCapabilityPlanWireV1(previous),
    },
    target: {
      version: target.app.version,
      plan_fingerprint: fingerprintCapabilityPlanWireV1(target),
    },
    entries,
  };
}

export function getCapabilityPlanEntry<Id extends CapabilityId>(
  plan: CapabilityPlan | CapabilityPlanWireV1,
  id: Id,
): Extract<CapabilityPlanEntry, { id: Id }> | undefined {
  return asWire(plan).entries.find((entry) => entry.id === id) as
    Extract<CapabilityPlanEntry, { id: Id }> | undefined;
}

export function projectCapabilityInstallDisclosures(
  plan: CapabilityPlan | CapabilityPlanWireV1,
): CapabilityInstallDisclosuresWireV1 {
  const wire = asWire(plan);
  return {
    format: 1,
    plan_fingerprint: fingerprintCapabilityPlanWireV1(wire),
    entries: wire.entries.map((entry) => {
      const definition = CAPABILITY_CATALOG[entry.id];
      return {
        id: entry.id,
        api: entry.api,
        provenance: entry.provenance,
        title: definition.title,
        summary: definition.summary,
        entry,
      };
    }),
  };
}

export function projectCapabilitySettingsWireV1(
  plan: CapabilityPlan | CapabilityPlanWireV1,
): CapabilitySettingsWireV1 {
  const wire = asWire(plan);
  const disclosure = projectCapabilityInstallDisclosures(wire);
  return {
    format: 1,
    app: wire.app,
    plan_fingerprint: disclosure.plan_fingerprint,
    entries: disclosure.entries.map((entry) => {
      const definition = CAPABILITY_CATALOG[entry.id];
      return {
        ...entry,
        delivery: definition.delivery,
        namespace: definition.namespace,
        grant: definition.grant,
        escalation: definition.escalation,
        disable: definition.disable,
        revocation: definition.revocation,
        quota: definition.quota,
        audit: definition.audit,
      };
    }),
  };
}
