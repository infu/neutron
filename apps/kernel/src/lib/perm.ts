import type {
  NeutronBackendCallReservation,
  NeutronBackendCallReservationScope,
  NeutronBackgroundUiRequest,
  NeutronCertifiedAssetsCollectionConfig,
  NeutronCertifiedReadAuthorityMode,
  NeutronCertifiedReadRouteMountConfig,
  NeutronChainKeySigningAlgorithmV1,
  NeutronEthereumProviderMethod,
  NeutronHttpRouteMethod,
  NeutronHttpRouteMountConfig,
  NeutronHttpRouteSurface,
  NeutronHttpsOutcallMethodV1,
} from "neutron-tools/src/capabilities/catalog.js";
import type { NeutronManifest } from "neutron-tools/src/schema.js";
import {
  buildCapabilityPlan,
  type CapabilityPlan,
  type FunctionResource,
} from "neutron-tools/src/capabilities/plan.js";
import {
  projectCapabilityInstallDisclosures,
  type CapabilityInstallDisclosureWireV1,
  type CapabilityPlanWireV1,
} from "neutron-tools/src/capabilities/wire.js";

export type PermissionLevel = 1 | 2 | 3 | 4;
export type FunctionMode = "query" | "update" | "internal";

export const BACKEND_RESERVATION_SCOPE_DISCLOSURES = {
  exact: {
    label: "Exact canister method",
    meaning: "One method on one canister",
    broad: false,
  },
  principal: {
    label: "Canister-wide",
    meaning: "Every current and future method on one canister",
    broad: true,
  },
  method: {
    label: "Method-wide",
    meaning: "One method name on any eligible non-system canister",
    broad: true,
  },
} as const satisfies Record<
  NeutronBackendCallReservationScope,
  { readonly label: string; readonly meaning: string; readonly broad: boolean }
>;

export const BACKEND_CALL_PERSISTENCE_DISCLOSURE =
  "A grant remains until explicit revocation, incompatible capability removal, or app uninstall.";

export const DEDICATED_RESIDENT_ORIGIN_DISCLOSURE =
  "isolated resident origin with ephemeral credential partition";

/**
 * Closed set of facts that the kernel can derive from the normalized package.
 * No app-authored prose is representable in this union.
 */
export type Permission =
  | { readonly source: "kernel"; readonly kind: "kernel_replacement" }
  | {
      readonly source: "kernel";
      readonly kind: "persistent_background_storage";
    }
  | {
      readonly source: "kernel";
      readonly kind: "dedicated_resident_origin";
    }
  | {
      readonly source: "kernel";
      readonly kind: "backend_calls";
      readonly reservationScopes: readonly NeutronBackendCallReservationScope[];
      readonly installReservations?: readonly NeutronBackendCallReservation[];
      readonly maxConcurrency: number;
      readonly maxCyclesPerCall: number;
      readonly maxCyclesPerDay: number;
    }
  | {
      readonly source: "kernel";
      readonly kind: "randomness";
    }
  | {
      readonly source: "kernel";
      readonly kind: "chain_key_signing";
      readonly slots: readonly {
        readonly id: string;
        readonly algorithm: NeutronChainKeySigningAlgorithmV1;
        readonly maxAssertionBytes: number;
      }[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "stable_store";
      readonly stores: readonly {
        readonly id: string;
        readonly schemaVersion: number;
        readonly maxEntries: number;
        readonly maxKeyBytes: number;
        readonly maxValueBytes: number;
        readonly maxBytes: number;
      }[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "https_outcalls";
      readonly endpoints: readonly {
        readonly id: string;
        readonly urlPrefix: string;
        readonly methods: readonly NeutronHttpsOutcallMethodV1[];
        readonly requestHeaders: readonly string[];
        readonly maxRequestBytes: number;
        readonly maxResponseBytes: number;
        readonly transform: "strip_headers";
      }[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "public_ingress_route";
      readonly protocol: string;
      readonly method: string;
      readonly handler: string;
      readonly mode: "query";
      readonly caller: "any" | "authenticated" | "canister";
      readonly maxRequestBytes: number;
      readonly maxResponseBytes: number;
    }
  | {
      readonly source: "kernel";
      readonly kind: "public_ingress_route";
      readonly protocol: string;
      readonly method: string;
      readonly handler: string;
      readonly mode: "update";
      readonly caller: "authenticated";
      readonly maxRequestBytes: number;
      readonly maxResponseBytes: number;
      readonly maxCallsPerHour: number;
      readonly maxCallsPerCallerPerHour?: number;
    }
  | {
      readonly source: "kernel";
      readonly kind: "public_ingress_route";
      readonly protocol: string;
      readonly method: string;
      readonly handler: string;
      readonly mode: "update";
      readonly caller: "canister";
      readonly maxRequestBytes: number;
      readonly maxResponseBytes: number;
      readonly maxCallsPerHour: number;
      readonly maxCallsPerCallerPerHour?: number;
      readonly requiredCycles: number;
    }
  | {
      readonly source: "kernel";
      readonly kind: "http_route";
      readonly id: string;
      readonly surface: NeutronHttpRouteSurface;
      readonly publicPath: string;
      readonly methods: readonly ("GET" | "HEAD")[];
      readonly mode: "certified_store";
      readonly authorityMode: NeutronCertifiedReadAuthorityMode;
      readonly store: "certified_assets";
      readonly maxRequestBytes: 0;
    }
  | {
      readonly source: "kernel";
      readonly kind: "http_route";
      readonly id: string;
      readonly surface: NeutronHttpRouteSurface;
      readonly publicPath: string;
      readonly methods: readonly NeutronHttpRouteMethod[];
      readonly mode: "http_post_update_handler";
      readonly handler: string;
      readonly maxRequestBytes: number;
      readonly maxResponseBytes: number;
      readonly maxCallsPerHour: number;
      readonly forwardHeaders: readonly string[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "certified_assets";
      readonly maxEntries: number;
      readonly maxCommittedBytes: number;
      readonly maxObjectBytes: number;
      readonly maxPendingStages: number;
      readonly maxStagedBytes: number;
      readonly maxBatchOperations: number;
      readonly maxBatchBytes: number;
      readonly maxIdempotencyReceipts: number;
      readonly collections: readonly NeutronCertifiedAssetsCollectionConfig[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "vetkeys";
      readonly slots: readonly {
        readonly id: string;
      }[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "preapproved_self_call";
      readonly method: string;
      readonly mode: "query" | "update";
    }
  | {
      readonly source: "kernel";
      readonly kind: "agent_entrypoint";
      readonly entrypoint: string;
    }
  | {
      readonly source: "kernel";
      readonly kind: "scheduled_task";
      readonly id: string;
      readonly method: string;
      readonly intervalSeconds: number;
      readonly runOnStart: boolean;
      readonly maxBackendCalls: number;
    }
  | {
      readonly source: "kernel";
      readonly kind: "background_ui_request";
      readonly category: NeutronBackgroundUiRequest;
    }
  | {
      readonly source: "kernel";
      readonly kind: "ethereum_provider";
      readonly chains: readonly number[];
      readonly methods: readonly NeutronEthereumProviderMethod[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "app_dependency";
      readonly app: string;
      readonly minVersion: number;
      readonly functions: readonly string[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "connection";
      readonly provider: string;
      readonly scopes: readonly string[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "internal_app_function";
      readonly method: string;
    }
  | {
      readonly source: "kernel";
      readonly kind: "function_resources";
      readonly method: string;
      readonly mode: "query" | "update" | "internal";
      readonly resources: readonly FunctionResource[];
    }
  | {
      readonly source: "kernel";
      readonly kind: "public_method";
      readonly method: string;
      readonly mode: FunctionMode;
      readonly allow: "unauthorized";
    }
  | {
      readonly source: "kernel";
      readonly kind: "kernel_memory_replacement";
    }
  | {
      readonly source: "kernel";
      readonly kind: "memory_retirement";
      readonly memoryId: string;
      readonly consolidation: boolean;
    };

/** App prose is optional context and can never be used as a permission fact. */
export type AppPermissionExplanation = {
  readonly source: "app";
  readonly kind:
    | "backend_calls_explanation"
    | "chain_key_signing_slot_purpose"
    | "stable_store_purpose"
    | "vetkeys_explanation"
    | "vetkeys_slot_purpose";
  readonly text: string;
};

export type InstallDisclosures = {
  readonly planFingerprint: string;
  readonly capabilityDisclosures: readonly CapabilityInstallDisclosureWireV1[];
  readonly permissions: readonly Permission[];
  readonly appExplanations: readonly AppPermissionExplanation[];
};

export function functionResourceLabel(resource: FunctionResource): string {
  switch (resource.kind) {
    case "stable_memory":
      return `${resource.kind}:${resource.id}`;
    case "task_capabilities":
      return `${resource.kind}:${resource.interfaces
        .map(({ id, api }) => `${id}@${api}`)
        .sort()
        .join("+")}`;
    default:
      return resource.kind;
  }
}

export function permissionLevel(permission: Permission): PermissionLevel {
  switch (permission.kind) {
    case "public_method":
      return 1;
    case "persistent_background_storage":
    case "dedicated_resident_origin":
    case "preapproved_self_call":
    case "background_ui_request":
    case "app_dependency":
    case "internal_app_function":
      return 2;
    case "function_resources":
      return permission.resources.reduce<PermissionLevel>(
        (level, resource) =>
          Math.max(
            level,
            resource.kind === "actor_self"
              ? 4
              : resource.kind === "task_capabilities"
                ? 3
                : resource.kind === "stable_memory"
                  ? 2
                  : 1,
          ) as PermissionLevel,
        1,
      );
    case "backend_calls":
      return permission.maxCyclesPerCall > 0 ||
        permission.reservationScopes.some(
          (scope) => scope === "principal" || scope === "method",
        )
        ? 3
        : 2;
    case "randomness":
      return 2;
    case "chain_key_signing":
      return 4;
    case "stable_store":
      return 3;
    case "https_outcalls":
      return permission.endpoints.some(({ methods }) => methods.includes("post"))
        ? 3
        : 2;
    case "public_ingress_route":
      return permission.mode === "update" ? 3 : 2;
    case "http_route":
    case "certified_assets":
      return 3;
    case "agent_entrypoint":
    case "vetkeys":
    case "scheduled_task":
      return 3;
    case "ethereum_provider":
      return permission.methods.includes("eth_sendTransaction") ? 3 : 2;
    case "connection":
      return 3;
    case "kernel_replacement":
    case "kernel_memory_replacement":
    case "memory_retirement":
      return 4;
  }
}

export function permissionKey(permission: Permission): string {
  switch (permission.kind) {
   case "backend_calls":
     return `${permission.kind}:${permission.reservationScopes.join(",")}:${
       permission.maxConcurrency
      }:${permission.maxCyclesPerCall}:${permission.maxCyclesPerDay}:${
        JSON.stringify(permission.installReservations ?? [])
      }`;
    case "randomness":
      return permission.kind;
    case "chain_key_signing":
      return `${permission.kind}:${JSON.stringify(
        permission.slots.map((slot) => [
          slot.id,
          slot.algorithm,
          slot.maxAssertionBytes,
        ]),
      )}`;
    case "stable_store":
      return `${permission.kind}:${JSON.stringify(
        permission.stores.map((store) => [
          store.id,
          store.schemaVersion,
          store.maxEntries,
          store.maxKeyBytes,
          store.maxValueBytes,
          store.maxBytes,
        ]),
      )}`;
    case "https_outcalls":
      return `${permission.kind}:${JSON.stringify(
        permission.endpoints.map((endpoint) => [
          endpoint.id,
          endpoint.urlPrefix,
          endpoint.methods,
          endpoint.requestHeaders,
          endpoint.maxRequestBytes,
          endpoint.maxResponseBytes,
          endpoint.transform,
        ]),
      )}`;
    case "public_ingress_route":
      return `${permission.kind}:${permission.protocol}:${permission.method}:${permission.handler}:${permission.mode}:${permission.caller}:${permission.maxRequestBytes}:${permission.maxResponseBytes}:${
        permission.mode === "update"
          ? permission.caller === "canister"
            ? `${permission.maxCallsPerHour}:${permission.requiredCycles}`
            : `${permission.maxCallsPerHour}:direct_ingress`
          : "query"
      }${
        permission.mode === "update" &&
        permission.maxCallsPerCallerPerHour !== undefined
          ? `:caller:${permission.maxCallsPerCallerPerHour}`
          : ""
      }`;
    case "http_route":
      return permission.mode === "certified_store"
        ? `${permission.kind}:${permission.surface}:${permission.mode}:${permission.authorityMode}:${permission.id}:${permission.publicPath}:${permission.methods.join(",")}:${permission.store}:${permission.maxRequestBytes}`
        : `${permission.kind}:${permission.surface}:${permission.mode}:${permission.id}:${permission.publicPath}:${permission.methods.join(",")}:${permission.handler}:${permission.maxRequestBytes}:${permission.maxResponseBytes}:${permission.maxCallsPerHour}:${permission.forwardHeaders.join(",")}`;
    case "certified_assets":
      return `${permission.kind}:${permission.maxEntries}:${permission.maxCommittedBytes}:${permission.maxObjectBytes}:${permission.maxPendingStages}:${permission.maxStagedBytes}:${permission.maxBatchOperations}:${permission.maxBatchBytes}:${permission.maxIdempotencyReceipts}:${JSON.stringify(
        permission.collections.map((collection) => [
          collection.id,
          collection.mount,
          collection.kind,
          collection.path_prefix ?? null,
          collection.exact_path ?? null,
          collection.max_object_bytes ?? null,
        ]),
      )}`;
    case "vetkeys":
      return `${permission.kind}:${permission.slots
        .map(({ id }) => id)
        .join(",")}`;
    case "preapproved_self_call":
      return `${permission.kind}:${permission.method}:${permission.mode}:api1`;
    case "agent_entrypoint":
      return `${permission.kind}:${permission.entrypoint}`;
    case "scheduled_task":
      return `${permission.kind}:${permission.id}:${permission.method}:${permission.intervalSeconds}:${permission.runOnStart}:${permission.maxBackendCalls}`;
    case "background_ui_request":
      return `${permission.kind}:${permission.category}`;
    case "ethereum_provider":
      return `${permission.kind}:${permission.chains.join(",")}:${permission.methods.join(",")}`;
    case "app_dependency":
      return `${permission.kind}:${permission.app}:${permission.minVersion}:${
        permission.functions.join(",")
      }`;
    case "connection":
      return `${permission.kind}:${permission.provider}:${
        permission.scopes.join(",")
      }`;
    case "internal_app_function":
      return `${permission.kind}:${permission.method}`;
    case "function_resources":
      return `${permission.kind}:${permission.method}:${permission.mode}:${permission.resources
        .map(functionResourceLabel)
        .join(",")}`;
    case "public_method":
      return `${permission.kind}:${permission.method}:${permission.mode}:${permission.allow}`;
    case "memory_retirement":
      return `${permission.kind}:${permission.memoryId}:${permission.consolidation}`;
    case "kernel_replacement":
    case "persistent_background_storage":
    case "dedicated_resident_origin":
    case "kernel_memory_replacement":
      return permission.kind;
  }
}

/** Resolve only the public base the normalized route plan owns. */
export function httpRoutePublicPath(
  appId: string,
  mount: NeutronHttpRouteMountConfig | NeutronCertifiedReadRouteMountConfig,
): string {
  return mount.surface === "shared_app_path"
    ? `/app/${appId}/_route/${mount.id}`
    : mount.prefix;
}

export type CertifiedAssetsCollectionDisclosure = Readonly<{
  title: string;
  locator: string;
  mutation: string;
  bodySource: string;
  delivery: string;
  absence: string;
}>;

export function certifiedAssetsCollectionDisclosure(
  collection: NeutronCertifiedAssetsCollectionConfig,
): CertifiedAssetsCollectionDisclosure {
  switch (collection.kind) {
    case "publication":
      return {
        title: "Publication",
        locator: "Kernel-allocated opaque path plus a safe filename",
        mutation:
          "Staged create-once publication with conditional delete; a deleted locator is never reused",
        bodySource: "Staged upload",
        delivery:
          "Host-bound GET and HEAD with bounded ranges; each record is inert inline text or a forced-download attachment; no-store; no CORS",
        absence:
          "Host-bound, no-store certified 404 without CORS",
      };
    case "immutable_blob":
      return {
        title: "Immutable blob",
        locator: `${collection.path_prefix}<64 lowercase body SHA-256 hex>`,
        mutation:
          "Create only when absent; delete only with the exact current revision and content tag",
        bodySource: "Inline or staged body",
        delivery:
          "Portable full-body GET as passive application/octet-stream; immutable public cache; anonymous wildcard CORS without credentials",
        absence:
          "Portable, no-store certified 404 with anonymous wildcard CORS and no credentials",
      };
    case "mutable_blob":
      return {
        title: "Mutable blob",
        locator:
          collection.exact_path !== undefined
            ? collection.exact_path
            : `${collection.path_prefix}<64 lowercase key hex>`,
        mutation:
          "Create, replace, or delete only with exact revision and content-tag compare-and-swap",
        bodySource: "Inline body",
        delivery:
          "Portable full-body GET as passive application/octet-stream; revalidation cache; anonymous wildcard CORS without credentials",
        absence:
          "Portable, no-store certified 404 with anonymous wildcard CORS and no credentials",
      };
  }
}

function cloneCertifiedAssetsCollection(
  collection: NeutronCertifiedAssetsCollectionConfig,
): NeutronCertifiedAssetsCollectionConfig {
  return { ...collection };
}

type CapabilityPermissionDisclosures = Omit<
  InstallDisclosures,
  "capabilityDisclosures"
> & {
  readonly capabilityDisclosures: readonly CapabilityInstallDisclosureWireV1[];
};

/**
 * Project the same kernel-derived permission facts from an already-normalized
 * capability plan that installation review uses for a manifest.
 */
export function capabilityPlanPermissionDisclosures(
  plan: CapabilityPlan | CapabilityPlanWireV1,
): CapabilityPermissionDisclosures {
  const permissions: Permission[] = [];
  const appExplanations: AppPermissionExplanation[] = [];
  const seen = new Set<string>();
  const add = (permission: Permission) => {
    const key = permissionKey(permission);
    if (seen.has(key)) return;
    seen.add(key);
    permissions.push(permission);
  };

  const capabilityProjection = projectCapabilityInstallDisclosures(plan);
  for (const { entry } of capabilityProjection.entries) {
    switch (entry.id) {
      case "persistent_browser_storage":
        add({ source: "kernel", kind: "persistent_background_storage" });
        break;
      case "dedicated_resident_origin":
        add({ source: "kernel", kind: "dedicated_resident_origin" });
        break;
      case "backend_calls":
        add({
          source: "kernel",
          kind: "backend_calls",
          reservationScopes: [...entry.config.reservation_scopes],
          ...(entry.config.install_reservations
            ? {
                installReservations: entry.config.install_reservations.map(
                  (reservation) => ({ ...reservation }),
                ),
              }
            : {}),
          maxConcurrency: entry.config.max_concurrency,
          maxCyclesPerCall: entry.config.max_cycles_per_call,
          maxCyclesPerDay: entry.config.max_cycles_per_day,
        });
        appExplanations.push({
          source: "app",
          kind: "backend_calls_explanation",
          text: entry.config.description,
        });
        break;
      case "randomness":
        add({
          source: "kernel",
          kind: "randomness",
        });
        break;
      case "chain_key_signing":
        add({
          source: "kernel",
          kind: "chain_key_signing",
          slots: entry.config.slots.map((slot) => ({
            id: slot.id,
            algorithm: slot.algorithm,
            maxAssertionBytes: slot.max_assertion_bytes,
          })),
        });
        for (const slot of entry.config.slots) {
          appExplanations.push({
            source: "app",
            kind: "chain_key_signing_slot_purpose",
            text: `${slot.id} — ${slot.purpose}`,
          });
        }
        break;
      case "stable_store":
        add({
          source: "kernel",
          kind: "stable_store",
          stores: entry.config.stores.map((store) => ({
            id: store.id,
            schemaVersion: store.schema_version,
            maxEntries: store.max_entries,
            maxKeyBytes: store.max_key_bytes,
            maxValueBytes: store.max_value_bytes,
            maxBytes: store.max_bytes,
          })),
        });
        for (const store of entry.config.stores) {
          appExplanations.push({
            source: "app",
            kind: "stable_store_purpose",
            text: `${store.id} — ${store.purpose}`,
          });
        }
        break;
      case "https_outcalls":
        add({
          source: "kernel",
          kind: "https_outcalls",
          endpoints: entry.config.endpoints.map((endpoint) => ({
            id: endpoint.id,
            urlPrefix: endpoint.url_prefix,
            methods: [...endpoint.methods],
            requestHeaders: [...endpoint.request_headers],
            maxRequestBytes: endpoint.max_request_bytes,
            maxResponseBytes: endpoint.max_response_bytes,
            transform: endpoint.transform,
          })),
        });
        break;
      case "certified_read_routes":
        for (const mount of entry.config.mounts) {
          const publicPath = httpRoutePublicPath(plan.app.id, mount);
          add({
            source: "kernel",
            kind: "http_route",
            id: mount.id,
            surface: mount.surface,
            publicPath,
            methods: [...mount.methods],
            mode: mount.mode,
            authorityMode: mount.authority_mode,
            store: mount.store,
            maxRequestBytes: mount.max_request_bytes,
          });
        }
        break;
      case "http_routes":
        for (const mount of entry.config.mounts) {
          const publicPath = httpRoutePublicPath(plan.app.id, mount);
          add({
            source: "kernel",
            kind: "http_route",
            id: mount.id,
            surface: mount.surface,
            publicPath,
            methods: [...mount.methods],
            mode: mount.mode,
            handler: mount.handler,
            maxRequestBytes: mount.max_request_bytes,
            maxResponseBytes: mount.max_response_bytes,
            maxCallsPerHour: mount.max_calls_per_hour,
            forwardHeaders: [...mount.forward_headers],
          });
        }
        break;
      case "certified_assets":
        add({
          source: "kernel",
          kind: "certified_assets",
          maxEntries: entry.config.max_entries,
          maxCommittedBytes: entry.config.max_committed_bytes,
          maxObjectBytes: entry.config.max_object_bytes,
          maxPendingStages: entry.config.max_pending_stages,
          maxStagedBytes: entry.config.max_staged_bytes,
          maxBatchOperations: entry.config.max_batch_operations,
          maxBatchBytes: entry.config.max_batch_bytes,
          maxIdempotencyReceipts:
            entry.config.max_idempotency_receipts,
          collections: entry.config.collections.map(
            cloneCertifiedAssetsCollection,
          ),
        });
        break;
      case "vetkeys":
        add({
          source: "kernel",
          kind: "vetkeys",
          slots: entry.config.slots.map(({ id }) => ({ id })),
        });
        appExplanations.push({
          source: "app",
          kind: "vetkeys_explanation",
          text: entry.config.description,
        });
        for (const slot of entry.config.slots) {
          appExplanations.push({
            source: "app",
            kind: "vetkeys_slot_purpose",
            text: `${slot.id} — ${slot.purpose}`,
          });
        }
        break;
      case "scheduled_tasks":
        for (const task of entry.config.tasks) {
          add({
            source: "kernel",
            kind: "scheduled_task",
            id: task.id,
            method: task.method,
            intervalSeconds: task.interval_seconds,
            runOnStart: task.run_on_start,
            maxBackendCalls: task.max_backend_calls,
          });
        }
        break;
      case "preapproved_self_calls":
        for (const configured of entry.config.methods) {
          add({
            source: "kernel",
            kind: "preapproved_self_call",
            method: configured.method,
            mode: configured.mode,
          });
        }
        break;
      case "agent_entrypoints":
        for (const entrypoint of entry.config.entrypoints) {
          add({ source: "kernel", kind: "agent_entrypoint", entrypoint });
        }
        break;
      case "background_ui_requests":
        for (const category of entry.config.categories) {
          add({ source: "kernel", kind: "background_ui_request", category });
        }
        break;
      case "ethereum_provider":
        add({
          source: "kernel",
          kind: "ethereum_provider",
          chains: [...entry.config.chains],
          methods: [...entry.config.methods],
        });
        break;
      case "connections":
        for (const connection of entry.config.providers) {
          add({
            source: "kernel",
            kind: "connection",
            provider: connection.provider,
            scopes: [...(connection.scopes ?? [])],
          });
        }
        break;
      case "app_calls":
        for (const dependency of entry.config.dependencies) {
          add({
            source: "kernel",
            kind: "app_dependency",
            app: dependency.app,
            minVersion: dependency.min_version,
            functions: [...dependency.methods],
          });
        }
        break;
      case "app_exports":
        for (const { method } of entry.config.methods) {
          add({ source: "kernel", kind: "internal_app_function", method });
        }
        break;
      case "function_resources":
        for (const binding of entry.config.functions) {
          add({
            source: "kernel",
            kind: "function_resources",
            method: binding.method,
            mode: binding.mode,
            resources: binding.resources.map((resource) => ({ ...resource })),
          });
        }
        break;
      case "public_ingress":
        for (const route of entry.config.routes) {
          if (route.mode === "update" && route.caller === "canister") {
            add({
              source: "kernel",
              kind: "public_ingress_route",
              protocol: route.protocol,
              method: route.id,
              handler: route.handler,
              mode: route.mode,
              caller: route.caller,
              maxRequestBytes: route.max_request_bytes,
              maxResponseBytes: route.max_response_bytes,
              maxCallsPerHour: route.max_calls_per_hour,
              ...(route.max_calls_per_caller_per_hour === undefined
                ? {}
                : {
                    maxCallsPerCallerPerHour:
                      route.max_calls_per_caller_per_hour,
                  }),
              requiredCycles: route.required_cycles,
            });
          } else if (route.mode === "update") {
            add({
              source: "kernel",
              kind: "public_ingress_route",
              protocol: route.protocol,
              method: route.id,
              handler: route.handler,
              mode: route.mode,
              caller: route.caller,
              maxRequestBytes: route.max_request_bytes,
              maxResponseBytes: route.max_response_bytes,
              maxCallsPerHour: route.max_calls_per_hour,
              ...(route.max_calls_per_caller_per_hour === undefined
                ? {}
                : {
                    maxCallsPerCallerPerHour:
                      route.max_calls_per_caller_per_hour,
                  }),
            });
          } else {
            add({
              source: "kernel",
              kind: "public_ingress_route",
              protocol: route.protocol,
              method: route.id,
              handler: route.handler,
              mode: route.mode,
              caller: route.caller,
              maxRequestBytes: route.max_request_bytes,
              maxResponseBytes: route.max_response_bytes,
            });
          }
        }
        break;
      case "stable_memory":
        if (
          plan.app.id === "kernel" &&
          entry.config.resources.some(({ id }) => id === "kernel")
        ) {
          add({ source: "kernel", kind: "kernel_memory_replacement" });
        }
        break;
      case "memory_lifecycle":
        for (const retirement of entry.config.retirements) {
          add({
            source: "kernel",
            kind: "memory_retirement",
            memoryId: retirement.id,
            consolidation: entry.config.consumptions.some((consumption) =>
              consumption.retired_resources.includes(retirement.id),
            ),
          });
        }
        break;
      case "tile_endpoints":
      case "background_endpoint":
      case "tray_endpoint":
      case "backend_environment":
        break;
      default: {
        const unsupported: never = entry;
        throw new Error(
          `Unsupported capability install disclosure ${String(unsupported)}`,
        );
      }
    }
  }

  return {
    planFingerprint: capabilityProjection.plan_fingerprint,
    capabilityDisclosures: capabilityProjection.entries,
    permissions,
    appExplanations,
  };
}

export function configInstallDisclosures(
  config: NeutronManifest,
): InstallDisclosures {
  const projected = capabilityPlanPermissionDisclosures(
    buildCapabilityPlan(config),
  );
  return {
    ...projected,
    permissions:
      config.id === "kernel"
        ? [
            { source: "kernel", kind: "kernel_replacement" },
            ...projected.permissions,
          ]
        : projected.permissions,
  };
}

/** Canonical permission facts for an installed app's verified capability plan. */
export function capabilityPlanPermissions(
  plan: CapabilityPlan | CapabilityPlanWireV1,
): Permission[] {
  return [...capabilityPlanPermissionDisclosures(plan).permissions];
}

/** Canonical convenience projection for callers that need authoritative facts. */
export function configPermissions(config: NeutronManifest): Permission[] {
  return [...configInstallDisclosures(config).permissions];
}
