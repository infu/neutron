import {
  browserPermissionFeaturesTitle,
  permissionLevel,
  type Permission,
  type PermissionLevel,
} from "../lib/perm.ts";
import { formatCycles } from "../settings/format.ts";

export type CompactPermissionConsequence = Readonly<{
  id: string;
  level: PermissionLevel;
  title: string;
  description: string;
}>;

/** Everyday review; the full permission inventory remains available in Pro. */
export function compactPermissionConsequences(
  permissions: readonly Permission[],
): readonly CompactPermissionConsequence[] {
  const groups = new Map<string, {
    id: string;
    level: PermissionLevel;
    title: string;
    facts: Set<string>;
  }>();
  const add = (permission: Permission, id: string, title: string, fact: string) => {
    const group = groups.get(id) ?? {
      id, title, level: permissionLevel(permission), facts: new Set<string>(),
    };
    group.level = Math.max(group.level, permissionLevel(permission)) as PermissionLevel;
    group.facts.add(fact);
    groups.set(id, group);
  };
  const providers = shortList(permissions.flatMap((permission) =>
    permission.kind === "connection" ? [permission.provider] : []));
  const dependencies = shortList(permissions.flatMap((permission) =>
    permission.kind === "app_dependency" ? [permission.app] : []));

  for (const permission of permissions) {
    switch (permission.kind) {
      case "kernel_replacement":
        add(permission, "system", "Full Neutron control", "Can change how Neutron works, including other apps and their permissions.");
        break;
      case "kernel_memory_replacement":
        if (!permissions.some(({ kind }) => kind === "kernel_replacement")) {
          add(permission, "system-data", "System data", "Can replace Neutron's stored system data.");
        }
        break;
      case "memory_retirement":
        // Declarations can retain historical retirements. The build review
        // identifies which existing roots this installation actually removes.
        add(permission, "data-retirement", "Permanent deletion", permission.consolidation
          ? "Can move app data and permanently remove its old storage."
          : "Can permanently delete stored app data.");
        break;
      case "chain_key_signing":
        if (permission.slots.length > 0) {
          add(permission, "signing", "Digital signatures", "Can sign requests that services may accept as approval, without asking each time. Signing uses Neutron's running balance.");
        }
        break;
      case "agent_entrypoint":
        add(permission, "agent-control", "Agent control", "Can ask to run an agent; this needs your separate approval.");
        break;
      case "browser_permissions": {
        const features = permission.tiles.flatMap(({ features }) => features);
        if (features.length > 0) {
          add(permission, "browser-device-access", browserPermissionFeaturesTitle(features), "Can ask your browser for access. Installing does not turn a device on. Once allowed, use can continue while the app view is open, even when hidden.");
        }
        break;
      }
      case "backend_calls": {
        const reservations = permission.installReservations ?? [];
        // Allowed future scope tiers are not permissions granted by this install.
        const broad = reservations.some(({ kind }) => kind !== "exact");
        add(permission, "outside-services", "Other services", reservations.length > 0
          ? `Gets ${broad ? "broad" : "specific"} ongoing access to other services. Access stays until revoked, removed by an update, or the app is uninstalled.`
          : "Can ask for ongoing access to other services; no destination is approved here.");
        if (permission.maxCyclesPerCall > 0) {
          add(permission, "outside-services", "Other services", `Approved calls can transfer Neutron's running balance: up to ${formatCycles(permission.maxCyclesPerCall)} per call and ${formatCycles(permission.maxCyclesPerDay)} per UTC day.`);
        }
        break;
      }
      case "https_outcalls": {
        const origins = permission.endpoints.map(({ urlPrefix }) => {
          try { return new URL(urlPrefix).origin; } catch { return urlPrefix; }
        });
        if (origins.length > 0) {
          add(permission, "web-requests", "External websites", `Can contact ${shortList(origins)}. Sites and the servers handling these requests can see the data sent. Requests use Neutron's running balance.`);
          if (permission.endpoints.some(({ methods }) => methods.includes("post"))) {
            add(permission, "web-requests", "External websites", "Can submit data or make changes on those sites.");
          }
        }
        break;
      }
      case "ethereum_provider":
        add(permission, "wallet", "Ethereum wallet", permission.methods.includes("eth_sendTransaction")
          ? "Can request wallet transactions; your wallet asks you to confirm each one."
          : "Can request wallet access; it cannot submit transactions.");
        break;
      case "public_ingress_route":
      case "public_method":
        add(permission, "public-access", "Public access", permission.mode === "query"
          ? "Others can read the data this app makes public without your permission."
          : "Others can run app actions, change app data and use Neutron's running balance without your permission.");
        break;
      case "http_route":
        add(permission, "public-access", "Public access", permission.mode === "http_post_update_handler"
          ? "Others can run app actions, change app data and use Neutron's running balance without your permission."
          : "Published data is public and not encrypted.");
        break;
      case "certified_assets":
        add(permission, "public-access", "Public access", "Published data is public and not encrypted.");
        break;
      case "scheduled_task":
        add(permission, "background", "Background activity", "Scheduled work can run even when Neutron is closed, using its running balance.");
        break;
      case "dedicated_resident_origin":
        add(permission, "background", "Background activity", "Can stay active while Neutron is open.");
        break;
      case "persistent_background_storage":
        add(permission, "background", "Background activity", "Can stay active while Neutron is open.");
        add(permission, "browser-data", "Saved browser data", "Keeps data in this app's separate browser storage; it is not automatically encrypted.");
        break;
      case "background_ui_request":
        add(permission, "background", "Background activity", "Can ask for your attention in the background; actions still need their usual approval.");
        break;
      case "stable_store":
        if (permission.stores.length > 0) {
          add(permission, "app-data", "App data", "Keeps its own data across updates; it is not automatically encrypted.");
        }
        break;
      case "vetkeys":
        if (permission.slots.length > 0) {
          add(permission, "private-keys", "Private keys", "Can ask separately to set up app keys. Once enabled, the app can recover them; disabling access cannot erase copies it already has.");
        }
        break;
      case "connection":
        add(permission, "connections", "Service sign-in", `Can ask you to connect ${providers}. After approval, the app gets account access using the permissions you approve.`);
        break;
      case "preapproved_self_call":
        if (permission.mode === "update") {
          add(permission, "app-data", "App data", "Can change its own data without asking each time.");
        }
        break;
      case "app_dependency":
        add(permission, "other-apps", "Other apps", `Uses functions provided by ${dependencies}.`);
        break;
      case "internal_app_function":
        add(permission, "other-apps", "Other apps", "Makes some app functions available to other installed apps.");
        break;
      case "function_resources":
        if (permission.resources.some(({ kind }) => kind === "actor_self")) {
          add(permission, "system", "Full Neutron control", "Can change how Neutron works, including other apps and their permissions.");
        }
        // Request context, own memory and task interfaces add no separate access.
        break;
      case "randomness":
        // Routine app computation; its technical details remain in Pro.
        break;
      default: {
        const exhaustive: never = permission;
        throw new Error(`Unknown permission: ${String(exhaustive)}`);
      }
    }
  }

  return [...groups.values()]
    .map(({ facts, ...group }) => ({ ...group, description: [...facts].join(" ") }))
    .sort((left, right) => right.level - left.level || left.title.localeCompare(right.title));
}

function shortList(values: readonly string[]): string {
  const unique = [...new Set(values)];
  return unique.length <= 3
    ? unique.join(", ")
    : `${unique.slice(0, 3).join(", ")} and ${unique.length - 3} more`;
}
