import type { Schema } from "jsonschema";
import { Principal } from "@icp-sdk/core/principal";
import {
  BACKEND_CAPABILITY_INTERFACES,
  createCapabilityDeclarationsSchema,
  normalizeCapabilityDeclarations,
  type BackendCapabilityInterfaceId,
  type CapabilityApiVersion,
  type NeutronCapabilitiesConfig,
  type NormalizedNeutronCapabilitiesConfig,
} from "./capabilities/catalog.ts";
import {
  APP_ID_MAX_LENGTH,
  APP_ID_MIN_LENGTH,
  APP_ID_SCHEMA_PATTERN,
  isValidAppId,
} from "./app_ids.ts";
import { compareCanonicalText } from "./canonical.ts";
import { APP_VERSION_MIN, isAppVersion } from "./version.ts";

export const MANIFEST_MAX_FUNCTIONS = 256;
export const MANIFEST_MAX_FUNCTION_ARGS = 16;
export const MANIFEST_MAX_MEMORY_ROOTS = 64;
export const MANIFEST_MAX_MEMORY_MIGRATIONS_TOTAL = 256;
export const MANIFEST_MAX_TILES = 32;
export const MANIFEST_MAX_INIT_ARGS = 64;

const MANAGEMENT_CANISTER_PRINCIPAL = "aaaaa-aa";
const ANONYMOUS_PRINCIPAL = "2vxsx-fae";

export {
  CAPABILITY_API_VERSION,
  BACKEND_CAPABILITY_INTERFACES,
  CHAIN_KEY_SIGNING_ALGORITHMS,
  CHAIN_KEY_SIGNING_MAX_ASSERTION_BYTES,
  CHAIN_KEY_SIGNING_MAX_SLOTS_GLOBAL,
  CHAIN_KEY_SIGNING_MAX_SLOTS_PER_APP,
  CHAIN_KEY_SIGNING_SLOT_ID_PATTERN,
  CERTIFIED_ASSETS_GLOBAL_ACTIVE_STAGES_MAX,
  CERTIFIED_ASSETS_GLOBAL_CHARGED_BYTES_MAX,
  CERTIFIED_ASSETS_GLOBAL_CHARGED_HEADROOM_BYTES,
  CERTIFIED_ASSETS_PHYSICAL_RESERVATION_POLICY_V1,
  CERTIFIED_ASSETS_MAX_BATCH_BYTES,
  CERTIFIED_ASSETS_MAX_BATCH_OPERATIONS,
  CERTIFIED_ASSETS_MAX_COLLECTIONS,
  CERTIFIED_ASSETS_MAX_COMMITTED_BYTES,
  CERTIFIED_ASSETS_MAX_ENTRIES,
  CERTIFIED_ASSETS_MAX_IDEMPOTENCY_RECEIPTS,
  CERTIFIED_ASSETS_MIN_IDEMPOTENCY_RECEIPTS,
  CERTIFIED_ASSETS_MAX_OBJECT_BYTES,
  CERTIFIED_ASSETS_MAX_PENDING_STAGES,
  CERTIFIED_ASSETS_MAX_STAGED_BYTES,
  ETHEREUM_PROVIDER_METHODS,
  HTTP_ROUTES_MAX_MOUNTS,
  HTTP_ROUTE_MAX_RESPONSE_BYTES,
  HTTP_POST_UPDATE_HANDLERS_MAX_CALLS_PER_HOUR,
  HTTP_POST_UPDATE_HANDLERS_MAX_REPLAY_BYTES_PER_HOUR,
  HTTP_POST_UPDATE_HANDLER_MAX_CALLS_PER_HOUR,
  HTTP_POST_UPDATE_HANDLER_MAX_FORWARD_HEADERS,
  HTTP_POST_UPDATE_HANDLER_MAX_REQUEST_BYTES,
  HTTP_POST_UPDATE_HANDLER_MAX_RESPONSE_BYTES,
  HTTPS_OUTCALLS_MAX_ENDPOINTS_PER_APP,
  HTTPS_OUTCALLS_MAX_ENDPOINTS_GLOBAL,
  HTTPS_OUTCALL_MAX_REQUEST_BYTES,
  HTTPS_OUTCALL_MAX_REQUEST_HEADERS,
  HTTPS_OUTCALL_MAX_RESPONSE_BYTES,
  HTTPS_OUTCALL_MAX_URL_BYTES,
  STABLE_STORE_ID_PATTERN,
  STABLE_STORE_MAX_BYTES_PER_APP,
  STABLE_STORE_MAX_BYTES_PER_STORE,
  STABLE_STORE_MAX_BYTES_GLOBAL,
  STABLE_STORE_MAX_ENTRIES_PER_APP,
  STABLE_STORE_MAX_ENTRIES_PER_STORE,
  STABLE_STORE_MAX_ENTRIES_GLOBAL,
  STABLE_STORE_MAX_KEY_BYTES,
  STABLE_STORE_MAX_SCHEMA_VERSION,
  STABLE_STORE_MAX_STORES_GLOBAL,
  STABLE_STORE_MAX_STORES_PER_APP,
  STABLE_STORE_MAX_VALUE_BYTES,
  VETKEYS_MAX_SLOTS_PER_APP,
  VETKEYS_SLOT_ID_PATTERN,
  type CapabilityApiVersion,
  type NeutronAgentEntrypointsCapabilityConfig,
  type BackendCapabilityInterfaceId,
  type NeutronBackendCallReservationScope,
  type NeutronBackendCallsCapabilityConfig,
  type NeutronBackgroundUiRequest,
  type NeutronBackgroundUiRequestsCapabilityConfig,
  type NeutronCapabilitiesConfig,
  type NeutronChainKeySigningAlgorithmV1,
  type NeutronChainKeySigningCapabilityConfig,
  type NeutronChainKeySigningCapabilityV1,
  type NeutronChainKeySigningSlotV1,
  type NeutronConnectionConfig,
  type NeutronConnectionsCapabilityConfig,
  type NeutronEthereumProviderCapabilityConfig,
  type NeutronEthereumProviderMethod,
  type NeutronCertifiedAssetsCapabilityConfig,
  type NeutronCertifiedAssetsCapabilityV2,
  type NeutronCertifiedAssetsCollectionConfig,
  type NeutronCertifiedAssetsImmutableBlobCollectionConfig,
  type NeutronCertifiedAssetsMutableBlobCollectionConfig,
  type NeutronCertifiedAssetsPublicationCollectionConfig,
  type NeutronDedicatedResidentOriginCapabilityConfig,
  type NeutronResidentFrameSecurityMode,
  type NeutronCertifiedReadAuthorityMode,
  type NeutronCertifiedReadRouteMountConfig,
  type NeutronCertifiedReadRoutesCapabilityConfig,
  type NeutronAppHostHttpRouteLocationConfig,
  type NeutronHttpRouteMethod,
  type NeutronHttpRouteLocationConfig,
  type NeutronHttpRouteMountConfig,
  type NeutronHttpRouteSurface,
  type NeutronHttpRoutesCapabilityConfig,
  type NeutronHttpRoutesCapabilityV1,
  type NeutronHttpsOutcallEndpointV1,
  type NeutronHttpsOutcallMethodV1,
  type NeutronHttpsOutcallsCapabilityConfig,
  type NeutronHttpsOutcallsCapabilityV1,
  type NeutronPersistentBrowserStorageCapabilityConfig,
  type NeutronPublicIngressCallerV1,
  type NeutronPublicIngressCapabilityConfig,
  type NeutronPublicIngressCapabilityV1,
  type NeutronPublicIngressQueryRouteV1,
  type NeutronPublicIngressRouteV1,
  type NeutronPublicIngressUpdateRouteV1,
  type NeutronPreapprovedSelfCallsCapabilityConfig,
  type NeutronPreapprovedSelfCallsCapabilityV1,
  type NormalizedNeutronPreapprovedSelfCallsCapabilityConfig,
  type NeutronRandomnessCapabilityConfig,
  type NeutronScheduledTaskConfig,
  type NeutronScheduledTasksCapabilityConfig,
  type NeutronStableStoreCapabilityConfig,
  type NeutronStableStoreCapabilityV1,
  type NeutronStableStoreV1,
  type NeutronSharedAppPathHttpRouteLocationConfig,
  type NeutronHttpPostUpdateHandlerRouteMethod,
  type NeutronHttpPostUpdateHandlerRouteMountConfig,
  type NeutronVetKeysCapabilityConfig,
  type NeutronVetKeysSlotConfig,
  type NormalizedNeutronCapabilitiesConfig,
  type NormalizedNeutronConnectionConfig,
  type NormalizedNeutronConnectionsCapabilityConfig,
} from "./capabilities/catalog.ts";

export type NeutronBackendCapabilityInterfaceConfig = {
  api: CapabilityApiVersion;
};

export type NeutronBackendCapabilitiesConfig = Partial<
  Record<BackendCapabilityInterfaceId, NeutronBackendCapabilityInterfaceConfig>
>;

export type NeutronBackendConfig = {
  capabilities: NeutronBackendCapabilitiesConfig;
};

export type NormalizedNeutronBackendConfig = NeutronBackendConfig;

export type NeutronFunctionConfig = {
  type?: "update" | "query" | "internal";
  allow?: "unauthorized";
  async?: boolean | "async*";
  arg?: string[];
  expose?: "apps";
};

export type NeutronMemoryConfig = {
  version?: number;
  schemas?: Record<string, NeutronMemorySchemaConfig>;
  migrations?: NeutronMemoryMigrationConfig[];
  retired?: boolean;
};

export type NeutronMemorySchemaConfig = {
  src?: string;
  entry?: string;
  hash?: string;
};

export type NeutronMemoryMigrationConfig = {
  from: number;
  to: number;
  consume?: string[];
  src?: string;
  entry?: string;
};

export type NeutronAppDependencyConfig = {
  app: string;
  min_version: number;
  functions: string[];
};

export type NormalizedNeutronAppDependencyConfig = NeutronAppDependencyConfig;

export type NeutronTileConfig = {
  id: string;
  title: string;
  path?: string;
  icon?: string;
  description?: string;
};

export type NormalizedNeutronTileConfig = {
  id: string;
  title: string;
  path: string;
  icon: string;
  description?: string;
};

export type NeutronBackgroundConfig = {
  path: string;
  description?: string;
};

export type NormalizedNeutronBackgroundConfig = {
  path: string;
  description?: string;
};

export type NeutronTrayConfig = {
  title: string;
  path: string;
  icon: string;
};

export type NormalizedNeutronTrayConfig = NeutronTrayConfig;

export type NeutronManifest = {
  format: 3;
  id: string;
  name: string;
  version: number;
  update_source?: string;
  description?: string;
  src?: string;
  entry?: string;
  init_arg?: string[];
  func?: Record<string, NeutronFunctionConfig>;
  memory?: Record<string, NeutronMemoryConfig>;
  dependencies?: Record<string, NeutronAppDependencyConfig>;
  tiles?: NeutronTileConfig[];
  background?: NeutronBackgroundConfig;
  tray?: NeutronTrayConfig;
  backend?: NeutronBackendConfig;
  capabilities?: NeutronCapabilitiesConfig;
};

export type PackagedNeutronManifest = NeutronManifest & {
  entry: string;
};

const TILE_ID_PATTERN = /^[a-z_0-9]+$/;
const DEPENDENCY_ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;
const METHOD_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;

// App-authored text is displayed inside trusted kernel and agent surfaces. Keep
// this source in sync with the runtime check below so JSON Schema and callers
// reject the same control, invisible-formatting, bidi, and line-separator
// characters. Unicode category Cf includes zero-width characters, bidi marks,
// embeddings, overrides and isolates, word joiners, and byte-order marks. The
// default-ignorable property also covers non-Cf invisibles such as variation
// selectors, combining grapheme joiners, and Hangul fillers.
export const UNTRUSTED_TEXT_SCHEMA_PATTERN =
  "^[^\\u0000-\\u001f\\u007f-\\u009f\\p{Cf}\\p{Default_Ignorable_Code_Point}\\p{Zl}\\p{Zp}]*$";

const PROHIBITED_UNTRUSTED_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;

export type UntrustedTextLimits = {
  minimumLength?: number;
  maximumLength: number;
};

/**
 * Normalize an app-authored update source to its one canonical IC principal
 * spelling. The principal is only source metadata; it does not grant the app
 * or publisher any kernel authority.
 */
export function normalizeUpdateSourcePrincipal(
  value: unknown,
  label = "update source",
): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${label} principal`);
  }
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch (cause) {
    throw new Error(`Invalid ${label} principal`, { cause });
  }
  const normalized = principal.toText();
  const principalBytes = principal.toUint8Array();
  if (
    normalized !== value ||
    normalized === MANAGEMENT_CANISTER_PRINCIPAL ||
    normalized === ANONYMOUS_PRINCIPAL ||
    principalBytes.length < 1 ||
    principalBytes.length > 29 ||
    principalBytes.at(-1) !== 0x01
  ) {
    throw new Error(
      `${label} principal must be a canonical canister principal`,
    );
  }
  return normalized;
}

export function normalizeManifestUpdateSource(
  manifest: Pick<NeutronManifest, "update_source">,
): string | undefined {
  return manifest.update_source === undefined
    ? undefined
    : normalizeUpdateSourcePrincipal(
        manifest.update_source,
        "manifest update_source",
      );
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

/**
 * Normalize newly supplied app-authored display text and reject characters
 * that could conceal or reorder it. Length bounds are checked both before and
 * after NFC normalization: the first check stays aligned with JSON Schema,
 * while the second makes the returned normalized value explicitly bounded.
 */
export function normalizeUntrustedText(
  value: unknown,
  label: string,
  { minimumLength = 1, maximumLength }: UntrustedTextLimits,
): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}`);

  const sourceLength = unicodeLength(value);
  const normalized = value.normalize("NFC");
  const normalizedLength = unicodeLength(normalized);
  if (
    sourceLength < minimumLength ||
    sourceLength > maximumLength ||
    normalizedLength < minimumLength ||
    normalizedLength > maximumLength ||
    PROHIBITED_UNTRUSTED_TEXT_PATTERN.test(normalized)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

export function normalizeManifestDisplayMetadata(
  manifest: Pick<NeutronManifest, "name" | "description">,
): Pick<NeutronManifest, "name" | "description"> {
  const name = normalizeUntrustedText(manifest.name, "manifest name", {
    minimumLength: 3,
    maximumLength: 20,
  });
  if (!/^[a-zA-Z0-9 ]*$/.test(name)) {
    throw new Error("Invalid manifest name");
  }
  const description =
    manifest.description === undefined
      ? undefined
      : normalizeUntrustedText(manifest.description, "manifest description", {
          maximumLength: 280,
        });
  return { name, ...(description === undefined ? {} : { description }) };
}

export function normalizeManifestDependencies(
  manifest: Pick<NeutronManifest, "id" | "dependencies">,
): Record<string, NormalizedNeutronAppDependencyConfig> {
  const declaration = manifest.dependencies;
  if (declaration === undefined) return {};
  if (manifest.id === "kernel") {
    throw new Error("Kernel cannot declare app dependencies");
  }
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  ) {
    throw new Error("Invalid dependencies declaration");
  }

  const aliases = Object.keys(declaration).sort(compareCanonicalText);
  if (aliases.length === 0) {
    throw new Error(`${manifest.id} dependencies declaration cannot be empty`);
  }
  if (aliases.length > 32) {
    throw new Error(`${manifest.id} declares more than 32 app dependencies`);
  }

  const normalized: Record<string, NormalizedNeutronAppDependencyConfig> = {};
  for (const alias of aliases) {
    if (!DEPENDENCY_ALIAS_PATTERN.test(alias)) {
      throw new Error(`Invalid dependency alias ${alias} in ${manifest.id}`);
    }

    const dependency = declaration[alias];
    if (
      !dependency ||
      typeof dependency !== "object" ||
      Array.isArray(dependency)
    ) {
      throw new Error(`Invalid dependency ${alias} in ${manifest.id}`);
    }
    for (const key of Object.keys(dependency)) {
      if (key !== "app" && key !== "min_version" && key !== "functions") {
        throw new Error(
          `Unknown dependency field ${key} in ${manifest.id}.${alias}`,
        );
      }
    }
    if (!isValidAppId(dependency.app)) {
      throw new Error(`Invalid dependency app in ${manifest.id}.${alias}`);
    }
    if (dependency.app === manifest.id) {
      throw new Error(`${manifest.id} cannot depend on itself`);
    }
    if (dependency.app === "kernel") {
      throw new Error(`${manifest.id} cannot depend on kernel`);
    }
    if (!isAppVersion(dependency.min_version)) {
      throw new Error(`Invalid minimum version in ${manifest.id}.${alias}`);
    }
    if (
      !Array.isArray(dependency.functions) ||
      dependency.functions.length < 1 ||
      dependency.functions.length > 64
    ) {
      throw new Error(`Invalid function list in ${manifest.id}.${alias}`);
    }

    const functions = new Set<string>();
    for (const method of dependency.functions) {
      if (typeof method !== "string" || !METHOD_NAME_PATTERN.test(method)) {
        throw new Error(`Invalid function name in ${manifest.id}.${alias}`);
      }
      if (functions.has(method)) {
        throw new Error(
          `Duplicate function ${method} in ${manifest.id}.${alias}`,
        );
      }
      functions.add(method);
    }

    normalized[alias] = {
      app: dependency.app,
      min_version: dependency.min_version,
      functions: [...functions].sort(compareCanonicalText),
    };
  }
  return normalized;
}

export function assertManifestFunctionExports(
  manifest: Pick<NeutronManifest, "id" | "func">,
): void {
  const functions = Object.entries(manifest.func ?? {});
  if (functions.length > MANIFEST_MAX_FUNCTIONS) {
    throw new Error(
      `${manifest.id} declares more than ${MANIFEST_MAX_FUNCTIONS} functions`,
    );
  }
  for (const [name, config] of functions) {
    if (!METHOD_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid function name in ${manifest.id}`);
    }
    if (
      config.arg !== undefined &&
      (!Array.isArray(config.arg) ||
        config.arg.length > MANIFEST_MAX_FUNCTION_ARGS ||
        new Set(config.arg).size !== config.arg.length)
    ) {
      throw new Error(
        `${manifest.id}.${name} has invalid or duplicate function resources`,
      );
    }
    const allow = (config as { allow?: unknown }).allow;
    if (allow === "any") {
      throw new Error(
        `${manifest.id}.${name} uses unsupported allow value any`,
      );
    }
    if (allow !== undefined && allow !== "unauthorized") {
      throw new Error(`Invalid allow value for ${manifest.id}.${name}`);
    }
    if (config.type === "internal" && allow !== undefined) {
      throw new Error(
        `${manifest.id}.${name} is internal and cannot declare public access`,
      );
    }
    if (allow === "unauthorized" && manifest.id !== "kernel") {
      throw new Error(
        `${manifest.id}.${name} cannot bypass public_ingress; declare capabilities.public_ingress instead`,
      );
    }
    if (config.expose !== undefined && config.expose !== "apps") {
      throw new Error(`Invalid expose value for ${manifest.id}.${name}`);
    }
    if (config.expose === "apps" && config.type !== "internal") {
      throw new Error(
        `${manifest.id}.${name} can be exposed to apps only when it is internal`,
      );
    }
  }
}

export function assertSafeRelativeAssetPath(
  value: unknown,
  label = "asset path",
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  if (value.startsWith("/") || value.includes("\\")) {
    throw new Error(`Unsafe ${label} ${value}`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Unsafe ${label} ${value}`);
  }
}

export function normalizeManifestTiles(
  manifest: Pick<NeutronManifest, "tiles">,
): NormalizedNeutronTileConfig[] {
  if ((manifest.tiles?.length ?? 0) > MANIFEST_MAX_TILES) {
    throw new Error(`Manifest declares more than ${MANIFEST_MAX_TILES} tiles`);
  }
  const declaredTiles = manifest.tiles ?? [];

  const ids = new Set<string>();
  return declaredTiles.map((tile) => {
    if (
      typeof tile.id !== "string" ||
      tile.id.length < 1 ||
      tile.id.length > 30 ||
      !TILE_ID_PATTERN.test(tile.id)
    ) {
      throw new Error(`Invalid tile id ${String(tile.id)}`);
    }
    if (ids.has(tile.id)) {
      throw new Error(`Duplicate tile id ${tile.id}`);
    }
    ids.add(tile.id);

    const title = normalizeUntrustedText(
      tile.title,
      `tile title for ${tile.id}`,
      { maximumLength: 40 },
    );

    const path = tile.path ?? "index.html";
    const icon = tile.icon ?? "static/icon.png";
    assertSafeRelativeAssetPath(path, `tile path for ${tile.id}`);
    assertSafeRelativeAssetPath(icon, `tile icon for ${tile.id}`);

    return {
      id: tile.id,
      title,
      path,
      icon,
      ...(tile.description === undefined
        ? {}
        : {
            description: normalizeUntrustedText(
              tile.description,
              `tile description for ${tile.id}`,
              { maximumLength: 280 },
            ),
          }),
    };
  });
}

export function normalizeManifestBackground(
  manifest: Pick<NeutronManifest, "background">,
): NormalizedNeutronBackgroundConfig | null {
  if (manifest.background === undefined) return null;
  if (!manifest.background || typeof manifest.background !== "object") {
    throw new Error("Invalid background process");
  }
  const { path } = manifest.background;
  assertSafeRelativeAssetPath(path, "background path");
  return {
    path,
    ...(manifest.background.description === undefined
      ? {}
      : {
          description: normalizeUntrustedText(
            manifest.background.description,
            "background description",
            { maximumLength: 280 },
          ),
        }),
  };
}

export function normalizeManifestTray(
  manifest: Pick<NeutronManifest, "background" | "tray">,
): NormalizedNeutronTrayConfig | null {
  if (manifest.tray === undefined) return null;
  if (!manifest.tray || typeof manifest.tray !== "object") {
    throw new Error("Invalid tray");
  }
  if (!manifest.background) {
    throw new Error("Tray requires a background process");
  }

  const title = normalizeUntrustedText(manifest.tray.title, "tray title", {
    maximumLength: 40,
  });
  const { path, icon } = manifest.tray;
  assertSafeRelativeAssetPath(path, "tray path");
  assertSafeRelativeAssetPath(icon, "tray icon");
  return { title, path, icon };
}

export function normalizeManifestCapabilities(
  manifest: Pick<NeutronManifest, "capabilities"> &
    Partial<Pick<NeutronManifest, "background" | "id">>,
): NormalizedNeutronCapabilitiesConfig {
  return normalizeCapabilityDeclarations(manifest.capabilities, {
    ...(manifest.id === undefined ? {} : { appId: manifest.id }),
    hasBackground: manifest.background !== undefined,
    normalizeText: normalizeUntrustedText,
  });
}

function manifestRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function assertClosedManifestRecord(
  value: Record<string, unknown>,
  label: string,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new Error(`Unknown ${label} field ${unknown}`);
  }
}

/**
 * Parse and canonicalize the exact long-lived broker interfaces selected for
 * an app backend. Selection is delivery, not declaration: every interface
 * must map to an independently valid authored capability declaration.
 */
export function normalizeManifestBackend(
  manifest: Pick<NeutronManifest, "id" | "backend" | "capabilities"> &
    Partial<Pick<NeutronManifest, "background">>,
): NormalizedNeutronBackendConfig | null {
  if (manifest.backend === undefined) return null;
  if (manifest.id === "kernel") {
    throw new Error("Kernel cannot declare an app backend environment");
  }

  const backend = manifestRecord(manifest.backend, "backend");
  assertClosedManifestRecord(backend, "backend", new Set(["capabilities"]));
  const selected = manifestRecord(backend.capabilities, "backend capabilities");
  const interfaceIds = Object.keys(selected).sort(compareCanonicalText);
  if (interfaceIds.length === 0) {
    throw new Error("Backend capabilities selection cannot be empty");
  }
  const knownInterfaces = new Set<string>(
    Object.keys(BACKEND_CAPABILITY_INTERFACES),
  );
  assertClosedManifestRecord(selected, "backend capabilities", knownInterfaces);

  const declarations = normalizeManifestCapabilities(manifest);
  const capabilities: NeutronBackendCapabilitiesConfig = {};
  for (const interfaceId of interfaceIds) {
    const id = interfaceId as BackendCapabilityInterfaceId;
    const definition = BACKEND_CAPABILITY_INTERFACES[id];
    const config = manifestRecord(selected[id], `backend capability ${id}`);
    assertClosedManifestRecord(
      config,
      `backend capability ${id}`,
      new Set(["api"]),
    );
    if (config.api !== definition.api) {
      throw new Error(`Unsupported backend capability ${id} API`);
    }
    if (
      definition.declaration !== null &&
      declarations[definition.declaration] === undefined
    ) {
      throw new Error(
        `Backend capability ${id} requires capabilities.${definition.declaration}`,
      );
    }
    capabilities[id] = { api: definition.api };
  }
  return { capabilities };
}

const backendCapabilitySelectionProperties = Object.fromEntries(
  Object.entries(BACKEND_CAPABILITY_INTERFACES).map(([id, definition]) => [
    id,
    {
      type: "object",
      properties: {
        api: { type: "integer", enum: [definition.api] },
      },
      required: ["api"],
      additionalProperties: false,
    },
  ]),
);

const backendSelectionDeclarationRules: Schema[] = Object.entries(
  BACKEND_CAPABILITY_INTERFACES,
).flatMap(([id, { declaration }]) =>
  declaration === null
    ? []
    : [
        {
          if: {
            required: ["backend"],
            properties: {
              backend: {
                required: ["capabilities"],
                properties: {
                  capabilities: { required: [id] },
                },
              },
            },
          },
          then: {
            required: ["capabilities"],
            properties: {
              capabilities: { required: [declaration] },
            },
          },
        },
      ],
);

export const schema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    format: {
      type: "integer",
      enum: [3],
    },
    id: {
      type: "string",
      minLength: APP_ID_MIN_LENGTH,
      maxLength: APP_ID_MAX_LENGTH,
      pattern: APP_ID_SCHEMA_PATTERN,
    },
    name: {
      type: "string",
      minLength: 3,
      maxLength: 20,
      pattern: "^[a-zA-Z0-9 ]*$",
    },
    version: {
      type: "integer",
      minimum: APP_VERSION_MIN,
    },
    update_source: {
      type: "string",
      minLength: 8,
      maxLength: 63,
      pattern: "^(?:[a-z2-7]{5}-)+[a-z2-7]{1,5}$",
      not: {
        enum: [MANAGEMENT_CANISTER_PRINCIPAL, ANONYMOUS_PRINCIPAL],
      },
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: 280,
      pattern: UNTRUSTED_TEXT_SCHEMA_PATTERN,
    },
    src: {
      type: "string",
      minLength: 2,
      maxLength: 30,
    },
    entry: {
      type: "string",
      pattern: "^[a-zA-Z0-9]*$",
    },
    init_arg: {
      type: "array",
      maxItems: MANIFEST_MAX_INIT_ARGS,
      uniqueItems: true,
      items: {
        type: "string",
        pattern: "^[a-zA-Z_0-9.]*$",
      },
    },
    func: {
      type: "object",
      maxProperties: MANIFEST_MAX_FUNCTIONS,
      patternProperties: {
        "^[a-zA-Z_][a-zA-Z0-9_]{0,127}$": {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["update", "query", "internal"],
            },
            allow: {
              type: "string",
              enum: ["unauthorized"],
            },
            async: {
              oneOf: [
                { type: "boolean" },
                { type: "string", enum: ["async*"] },
              ],
            },
            arg: {
              type: "array",
              maxItems: MANIFEST_MAX_FUNCTION_ARGS,
              uniqueItems: true,
              items: {
                type: "string",
                pattern: "^[a-zA-Z_0-9.]*$",
              },
            },
            expose: {
              type: "string",
              enum: ["apps"],
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    memory: {
      type: "object",
      maxProperties: MANIFEST_MAX_MEMORY_ROOTS,
      patternProperties: {
        "^[a-zA-Z_][a-zA-Z_0-9]{0,127}$": {
          type: "object",
          properties: {
            version: {
              type: "integer",
              minimum: 1,
            },
            schemas: {
              type: "object",
              maxProperties: 64,
              patternProperties: {
                "^[1-9][0-9]*$": {
                  type: "object",
                  properties: {
                    src: {
                      type: "string",
                      minLength: 1,
                      maxLength: 240,
                    },
                    entry: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                    hash: {
                      type: "string",
                      pattern: "^[a-f0-9]{64}$",
                    },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
            migrations: {
              type: "array",
              maxItems: 128,
              items: {
                type: "object",
                properties: {
                  from: {
                    type: "integer",
                    minimum: 1,
                  },
                  to: {
                    type: "integer",
                    minimum: 1,
                  },
                  consume: {
                    type: "array",
                    maxItems: 16,
                    uniqueItems: true,
                    items: {
                      type: "string",
                      pattern: "^[a-zA-Z_][a-zA-Z_0-9]*$",
                    },
                  },
                  src: {
                    type: "string",
                    minLength: 1,
                    maxLength: 240,
                  },
                  entry: {
                    type: "string",
                    pattern: "^[a-f0-9]{64}$",
                  },
                },
                required: ["from", "to"],
                additionalProperties: false,
              },
            },
            retired: {
              type: "boolean",
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    dependencies: {
      type: "object",
      minProperties: 1,
      maxProperties: 32,
      patternProperties: {
        "^[a-z][a-z0-9_]{0,29}$": {
          type: "object",
          properties: {
            app: {
              type: "string",
              minLength: APP_ID_MIN_LENGTH,
              maxLength: APP_ID_MAX_LENGTH,
              pattern: APP_ID_SCHEMA_PATTERN,
            },
            min_version: {
              type: "integer",
              minimum: APP_VERSION_MIN,
            },
            functions: {
              type: "array",
              minItems: 1,
              maxItems: 64,
              uniqueItems: true,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 128,
                pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$",
              },
            },
          },
          required: ["app", "min_version", "functions"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    tiles: {
      type: "array",
      maxItems: MANIFEST_MAX_TILES,
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            minLength: 1,
            maxLength: 30,
            pattern: "^[a-z_0-9]+$",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: 40,
            pattern: UNTRUSTED_TEXT_SCHEMA_PATTERN,
          },
          path: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            pattern: "^[a-zA-Z0-9_./-]+$",
          },
          icon: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            pattern: "^[a-zA-Z0-9_./-]+$",
          },
          description: {
            type: "string",
            minLength: 1,
            maxLength: 280,
            pattern: UNTRUSTED_TEXT_SCHEMA_PATTERN,
          },
        },
        required: ["id", "title"],
        additionalProperties: false,
      },
    },
    background: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          pattern: "^[a-zA-Z0-9_./-]+$",
        },
        description: {
          type: "string",
          minLength: 1,
          maxLength: 280,
          pattern: UNTRUSTED_TEXT_SCHEMA_PATTERN,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    tray: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 40,
          pattern: UNTRUSTED_TEXT_SCHEMA_PATTERN,
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          pattern: "^[a-zA-Z0-9_./-]+$",
        },
        icon: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          pattern: "^[a-zA-Z0-9_./-]+$",
        },
      },
      required: ["title", "path", "icon"],
      additionalProperties: false,
    },
    backend: {
      type: "object",
      properties: {
        capabilities: {
          type: "object",
          minProperties: 1,
          properties: backendCapabilitySelectionProperties,
          additionalProperties: false,
        },
      },
      required: ["capabilities"],
      additionalProperties: false,
    },
    capabilities: createCapabilityDeclarationsSchema(
      UNTRUSTED_TEXT_SCHEMA_PATTERN,
    ),
  },
  allOf: [
    {
      if: {
        required: ["id"],
        properties: { id: { const: "kernel" } },
      },
      then: {
        allOf: [
          { not: { required: ["backend"] } },
          {
            properties: {
              capabilities: {
                not: { required: ["public_ingress"] },
              },
            },
          },
        ],
      },
    },
    {
      if: {
        required: ["id"],
        properties: { id: { not: { const: "kernel" } } },
      },
      then: {
        allOf: [
          { not: { required: ["init_arg"] } },
          {
            properties: {
              func: {
                patternProperties: {
                  "^[a-zA-Z_][a-zA-Z0-9_]{0,127}$": {
                    not: { required: ["allow"] },
                  },
                },
              },
            },
          },
        ],
      },
    },
    {
      if: {
        required: ["capabilities"],
        properties: {
          capabilities: { required: ["dedicated_resident_origin"] },
        },
      },
      then: { required: ["background"] },
    },
    {
      if: {
        required: ["capabilities"],
        properties: {
          capabilities: { required: ["connections"] },
        },
      },
      then: { required: ["background"] },
    },
    {
      if: {
        required: ["capabilities"],
        properties: {
          capabilities: { required: ["certified_assets"] },
        },
      },
      then: {
        required: ["backend"],
        properties: {
          backend: {
            required: ["capabilities"],
            properties: {
              capabilities: { required: ["certified_assets"] },
            },
          },
        },
      },
    },
    ...backendSelectionDeclarationRules,
  ],
  dependencies: {
    tray: ["background"],
  },
  required: ["format", "id", "name", "version"],
  additionalProperties: false,
};
