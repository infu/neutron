import { sha256 } from "js-sha256";
import { compareCanonicalText } from "../canonical.ts";
import {
  publicIngressResourceId,
  type CapabilityApiVersion,
} from "./catalog.ts";
import type { CapabilityPlan, CapabilityPlanEntry } from "./plan.ts";

export const RUNTIME_CAPABILITY_REGISTRATION_VERSION = 1 as const;
// Mirrored by the kernel registry and Settings parser. Keep this preflight at
// the projection boundary so a composition of individually valid capability
// maxima cannot survive compilation only to trap actor initialization.
export const RUNTIME_CAPABILITY_MAX_PER_APP = 64;
export const RUNTIME_CAPABILITY_MAX_TOTAL = 8_192;

export const RUNTIME_CAPABILITY_KINDS = Object.freeze([
  "backend_calls",
  "randomness",
  "chain_key_signing",
  "stable_store",
  "https_outcalls",
  "vetkeys",
  "scheduled_tasks",
  "connections",
  "persistent_browser_storage",
  "dedicated_resident_origin",
  "public_ingress",
  "certified_assets",
  "certified_read_routes",
  "http_routes",
] as const);

export type RuntimeCapabilityKind = (typeof RUNTIME_CAPABILITY_KINDS)[number];

export type RuntimeCapabilityGrantMode = "declaration" | "owner_runtime_grant";

export type RuntimeCapabilityRegistrationV1 = {
  format: typeof RUNTIME_CAPABILITY_REGISTRATION_VERSION;
  kind: RuntimeCapabilityKind;
  resource_id: string;
  /** API of the capability resource, not the registration wire format. */
  api: CapabilityApiVersion;
  declaration_fingerprint: string;
  grant: RuntimeCapabilityGrantMode;
  toggleable: boolean;
};

type RuntimeResource = Omit<
  RuntimeCapabilityRegistrationV1,
  "format" | "declaration_fingerprint"
> & {
  authority: unknown;
};

/**
 * Project only resources whose live use is enforced by a runtime broker.
 *
 * Structural plan entries remain in the canonical CapabilityPlan and do not
 * acquire a second registry representation. Each returned fingerprint covers
 * one exact runtime resource rather than the entire app plan, so an unrelated
 * plan change cannot revive or erase that resource's owner-disabled state.
 */
export function projectRuntimeCapabilityRegistrationsV1(
  plan: CapabilityPlan,
): RuntimeCapabilityRegistrationV1[] {
  if (plan.version !== 1) {
    throw new Error(
      `Unsupported capability plan version ${String(plan.version)}`,
    );
  }

  const resources = plan.entries.flatMap(runtimeResources);
  if (resources.length > RUNTIME_CAPABILITY_MAX_PER_APP) {
    throw new Error(
      `Capability plan projects ${resources.length} runtime resources; maximum is ${RUNTIME_CAPABILITY_MAX_PER_APP}`,
    );
  }
  resources.sort((left, right) => {
    const kind = compareCanonicalText(left.kind, right.kind);
    return kind || compareCanonicalText(left.resource_id, right.resource_id);
  });

  for (let index = 1; index < resources.length; index += 1) {
    const previous = resources[index - 1]!;
    const current = resources[index]!;
    if (
      previous.kind === current.kind &&
      previous.resource_id === current.resource_id
    ) {
      throw new Error(
        `Duplicate runtime capability resource ${current.kind}/${current.resource_id}`,
      );
    }
  }

  return resources.map((resource) => {
    const registration = {
      format: RUNTIME_CAPABILITY_REGISTRATION_VERSION,
      kind: resource.kind,
      resource_id: resource.resource_id,
      api: resource.api,
      grant: resource.grant,
      toggleable: resource.toggleable,
    };
    return {
      ...registration,
      declaration_fingerprint: sha256(
        canonicalJson({ ...registration, authority: resource.authority }),
      ),
    };
  });
}

function runtimeResources(entry: CapabilityPlanEntry): RuntimeResource[] {
  switch (entry.id) {
    case "backend_calls":
      return [
        rootResource("backend_calls", entry.api, "owner_runtime_grant", {
          api: entry.config.api,
          reservation_scopes: entry.config.reservation_scopes,
          max_concurrency: entry.config.max_concurrency,
          max_cycles_per_call: entry.config.max_cycles_per_call,
          max_cycles_per_day: entry.config.max_cycles_per_day,
        }),
      ];
    case "randomness":
      return [
        rootResource("randomness", entry.api, "declaration", entry.config),
      ];
    case "chain_key_signing":
      return entry.config.slots.map((slot) => ({
        kind: "chain_key_signing",
        resource_id: slot.id,
        api: entry.api,
        grant: "declaration",
        toggleable: true,
        // Purpose is app-authored presentation text, never signing authority.
        authority: {
          slot: {
            id: slot.id,
            algorithm: slot.algorithm,
            max_assertion_bytes: slot.max_assertion_bytes,
          },
        },
      }));
    case "stable_store":
      return entry.config.stores.map((store) => ({
        kind: "stable_store",
        resource_id: store.id,
        api: entry.api,
        grant: "declaration",
        toggleable: true,
        // Purpose is presentation text. Schema version describes the opaque
        // value codec and does not broaden the store's storage authority.
        authority: {
          max_entries: store.max_entries,
          max_key_bytes: store.max_key_bytes,
          max_value_bytes: store.max_value_bytes,
          max_bytes: store.max_bytes,
        },
      }));
    case "https_outcalls":
      return entry.config.endpoints.map((endpoint) => ({
        kind: "https_outcalls",
        resource_id: endpoint.id,
        api: entry.api,
        grant: "declaration",
        toggleable: true,
        authority: { endpoint },
      }));
    case "vetkeys":
      return entry.config.slots.map((slot) => ({
        kind: "vetkeys",
        resource_id: slot.id,
        api: entry.api,
        grant: "declaration",
        toggleable: true,
        // Purpose and description are presentation text, not authority.
        authority: { slot: slot.id },
      }));
    case "scheduled_tasks":
      return entry.config.tasks.map((task) => ({
        kind: "scheduled_tasks",
        resource_id: task.id,
        api: entry.api,
        grant: "declaration",
        toggleable: true,
        authority: task,
      }));
    case "connections":
      return entry.config.providers.map((provider) => ({
        kind: "connections",
        resource_id: provider.provider,
        api: entry.api,
        grant: "owner_runtime_grant",
        toggleable: true,
        authority: provider,
      }));
    case "persistent_browser_storage":
      return [
        {
          kind: "persistent_browser_storage",
          resource_id: entry.config.surface,
          api: entry.api,
          grant: "declaration",
          toggleable: true,
          authority: {
            ...entry.config,
            frame_security: "persistent_dedicated_v1",
          },
        },
      ];
    case "dedicated_resident_origin":
      return [
        {
          kind: "dedicated_resident_origin",
          resource_id: entry.config.surface,
          api: entry.api,
          grant: "declaration",
          toggleable: true,
          authority: {
            ...entry.config,
            frame_security: "credentialless_ephemeral_dedicated_v1",
          },
        },
      ];
    case "public_ingress":
      return entry.config.routes.map((route) => ({
        kind: "public_ingress",
        resource_id: publicIngressResourceId(route.protocol, route.id),
        api: entry.api,
        grant: "declaration",
        toggleable: true,
        authority: route,
      }));
    case "certified_assets":
      return [
        rootResource(
          "certified_assets",
          entry.api,
          "declaration",
          entry.config,
        ),
      ];
    case "http_routes":
      return entry.config.mounts.map((mount) => ({
        kind: "http_routes",
        resource_id: mount.id,
        api: entry.api,
        grant: "declaration",
        toggleable: true,
        authority: mount,
      }));
    case "certified_read_routes":
      return entry.config.mounts.map((mount) => ({
        kind: "certified_read_routes",
        resource_id: mount.id,
        api: entry.api,
        grant: "declaration",
        toggleable: true,
        authority: mount,
      }));
    default:
      return [];
  }
}

function rootResource(
  kind: "backend_calls" | "randomness" | "certified_assets",
  api: CapabilityApiVersion,
  grant: RuntimeCapabilityGrantMode,
  authority: unknown,
): RuntimeResource {
  return {
    kind,
    resource_id: "default",
    api,
    grant,
    toggleable: true,
    authority,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCanonicalText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
