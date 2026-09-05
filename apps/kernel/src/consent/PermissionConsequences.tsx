import type { Permission, PermissionLevel } from "../lib/perm.ts";
import type { CapabilityPlanDiffV1 } from "neutron-tools/src/capabilities/wire.js";
import type { CapabilityId } from "neutron-tools/src/capabilities/catalog.js";
import {
  BROWSER_PERMISSION_PERSISTENCE_DISCLOSURE,
  browserPermissionFeaturesTitle,
  browserPermissionRequestDisclosure,
  permissionLevel,
} from "../lib/perm.ts";
import { formatBytes, formatCycles } from "../settings/format.ts";
import { useConsentUiMode } from "./ConsentPresentation.tsx";
import type { KernelUiMode } from "../ui_mode.ts";
import { compactPermissionConsequences } from "./compact_permission_summary.ts";

export type PermissionConsequence = Readonly<{
  id: string;
  level: PermissionLevel;
  title: string;
  description: string;
  facts: readonly string[];
}>;

export function PermissionConsequences({
  emptyCopy = "Uses standard app features.",
  mode,
  permissions,
}: {
  emptyCopy?: string;
  mode?: KernelUiMode;
  permissions: readonly Permission[];
}) {
  const uiMode = useConsentUiMode(mode);
  if (uiMode === "normal") {
    const rows = compactPermissionConsequences(permissions);
    if (rows.length === 0) {
      return (
        <p className="consent-compact-empty" data-tid="consent-no-unusual-access">
          {emptyCopy}
        </p>
      );
    }
    return (
      <section
        aria-label="App permissions"
        className="consent-consequences consent-consequences--compact"
        data-tid="consent-consequences"
      >
        <h3>App permissions</h3>
        <ul className="consent-permission-rows">
          {rows.map((row) => (
            <li
              className={`consent-permission-row perm-level-${row.level}`}
              data-consequence={row.id}
              data-level={row.level}
              key={row.id}
            >
              <strong>{row.title}</strong>{" "}
              <span>{row.description}</span>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  const consequences = permissionConsequences(permissions);
  if (consequences.length === 0) {
    return (
      <div className="consent-no-unusual-access" data-tid="consent-no-unusual-access">
        <strong>No unusual access</strong>
        <span>{emptyCopy}</span>
      </div>
    );
  }
  return (
    <section
      aria-label="What this app will be able to do"
      className="consent-consequences"
      data-tid="consent-consequences"
    >
      <h3>What this app will be able to do</h3>
      <div className="consent-consequence-list">
        {consequences.map((consequence) => (
          <article
            className={`consent-consequence perm-level-${consequence.level}`}
            data-consequence={consequence.id}
            data-level={consequence.level}
            key={consequence.id}
          >
            <header>
              <strong>{consequence.title}</strong>
              <span>{riskLabel(consequence.level)}</span>
            </header>
            <p>{consequence.description}</p>
            {consequence.facts.length > 0 ? (
              <ul>
                {consequence.facts.map((fact, index) => (
                  <li key={`${consequence.id}:${index}`}>{fact}</li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

const permissionCapabilityIds = {
  persistent_background_storage: "persistent_browser_storage",
  dedicated_resident_origin: "dedicated_resident_origin",
  browser_permissions: "browser_permissions",
  backend_calls: "backend_calls",
  randomness: "randomness",
  chain_key_signing: "chain_key_signing",
  stable_store: "stable_store",
  https_outcalls: "https_outcalls",
  public_ingress_route: "public_ingress",
  certified_assets: "certified_assets",
  vetkeys: "vetkeys",
  preapproved_self_call: "preapproved_self_calls",
  agent_entrypoint: "agent_entrypoints",
  scheduled_task: "scheduled_tasks",
  background_ui_request: "background_ui_requests",
  ethereum_provider: "ethereum_provider",
  app_dependency: "app_calls",
  connection: "connections",
  internal_app_function: "app_exports",
  function_resources: "function_resources",
} satisfies Record<
  Exclude<
    Permission["kind"],
    "kernel_replacement" | "kernel_memory_replacement" | "memory_retirement" | "http_route" | "public_method"
  >,
  CapabilityId
>;

/** Presentation only: spotlight changed access without changing approval scope. */
export function getPermissionChangesForReview(
  permissions: readonly Permission[],
  diff: CapabilityPlanDiffV1 | undefined,
): readonly Permission[] {
  if (!diff) return permissions;
  const changedIds = new Set(
    diff.entries.filter(({ after }) => after !== null).map(({ id }) => id),
  );
  return permissions.filter((permission) => {
    switch (permission.kind) {
      case "kernel_replacement":
      case "kernel_memory_replacement":
      case "memory_retirement":
      case "public_method":
        return true;
      case "http_route":
        return changedIds.has(
          permission.mode === "certified_store" ? "certified_read_routes" : "http_routes",
        );
      case "function_resources":
        return permission.resources.some(({ kind }) => kind === "actor_self") ||
          changedIds.has("function_resources");
      default:
        return changedIds.has(permissionCapabilityIds[permission.kind]);
    }
  });
}

export function permissionConsequences(
  permissions: readonly Permission[],
): PermissionConsequence[] {
  const consequences = [
    systemConsequences(permissions),
    delegatedConsequences(permissions),
    browserDeviceConsequences(permissions),
    networkConsequences(permissions),
    publicConsequences(permissions),
    automaticConsequences(permissions),
    dataConsequences(permissions),
    appInteractionConsequences(permissions),
    backendContextConsequences(permissions),
  ].filter((entry): entry is PermissionConsequence => entry !== null);
  return consequences.sort(
    (left, right) => right.level - left.level || left.title.localeCompare(right.title),
  );
}

function browserDeviceConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const browserPermissions = firstPermission(
    permissions,
    "browser_permissions",
  );
  if (!browserPermissions) return null;
  const browserPermissionTitle = browserPermissionFeaturesTitle(
    browserPermissions.tiles.flatMap(({ features }) => features),
  );
  return {
    id: "browser-device-access",
    level: permissionLevel(browserPermissions),
    title: `Request ${browserPermissionTitle.toLowerCase()} access`,
    description:
      "Declared open tiles can ask the browser for device access. Installing the app does not activate a device.",
    facts: [
      ...browserPermissions.tiles.flatMap(({ id, features }) =>
        features.map((feature) =>
          browserPermissionRequestDisclosure(id, feature),
        ),
      ),
      BROWSER_PERMISSION_PERSISTENCE_DISCLOSURE,
    ],
  };
}

function systemConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const relevant = permissions.filter((permission) =>
    permission.kind === "kernel_replacement" ||
    permission.kind === "kernel_memory_replacement" ||
    permission.kind === "memory_retirement" ||
    (permission.kind === "function_resources" &&
      permission.resources.some(({ kind }) => kind === "actor_self"))
  );
  if (relevant.length === 0) return null;
  const facts: string[] = [];
  if (relevant.some(({ kind }) => kind === "kernel_replacement")) {
    facts.push("Can replace the privileged Neutron code that enforces every app permission.");
  }
  if (relevant.some(({ kind }) => kind === "kernel_memory_replacement")) {
    facts.push("Can replace memory owned by the Neutron kernel.");
  }
  const retired = relevant.filter(
    (permission): permission is Extract<Permission, { kind: "memory_retirement" }> =>
      permission.kind === "memory_retirement",
  );
  if (retired.length > 0) {
    facts.push(
      `${countLabel(retired.length, "memory area")} will be permanently retired or deleted.`,
    );
  }
  if (
    relevant.some(
      (permission) =>
        permission.kind === "function_resources" &&
        permission.resources.some(({ kind }) => kind === "actor_self"),
    )
  ) {
    facts.push("Receives kernel-only authority over the complete Neutron backend.");
  }
  return {
    id: "system",
    level: 4,
    title: "Control Neutron itself",
    description:
      "This is system-level authority. A malicious or broken version could bypass ordinary app isolation.",
    facts,
  };
}

function delegatedConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const signing = permissions.filter(
    (permission): permission is Extract<Permission, { kind: "chain_key_signing" }> =>
      permission.kind === "chain_key_signing",
  );
  const agents = permissions.filter(
    (permission): permission is Extract<Permission, { kind: "agent_entrypoint" }> =>
      permission.kind === "agent_entrypoint",
  );
  if (signing.length === 0 && agents.length === 0) return null;
  const facts: string[] = [];
  const slotCount = signing.reduce((count, permission) => count + permission.slots.length, 0);
  if (slotCount > 0) {
    facts.push(
      `Can create assertions from ${countLabel(slotCount, "signing permission")} without asking each time; services may treat them as authorization and each signature spends Neutron cycles.`,
    );
  }
  if (agents.length > 0) {
    facts.push(
      `Offers ${countLabel(agents.length, "agent entrypoint")}. Agent control still requires a separate explicit approval.`,
    );
  }
  return {
    id: "delegated-control",
    level: maxLevel([...signing, ...agents]),
    title: "Sign or act with delegated authority",
    description:
      "These abilities can carry authority beyond a single visible app action.",
    facts,
  };
}

function networkConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const backend = firstPermission(permissions, "backend_calls");
  const https = firstPermission(permissions, "https_outcalls");
  const ethereum = firstPermission(permissions, "ethereum_provider");
  const randomness = firstPermission(permissions, "randomness");
  if (!backend && !https && !ethereum && !randomness) return null;
  const relevant: Permission[] = [];
  if (backend) relevant.push(backend);
  if (https) relevant.push(https);
  if (ethereum) relevant.push(ethereum);
  if (randomness) relevant.push(randomness);
  const facts: string[] = [];
  if (backend) {
    const broad = backend.reservationScopes.some(
      (scope) => scope === "principal" || scope === "method",
    );
    if (backend.installReservations?.length) {
      facts.push(
        `Installation creates ${countLabel(backend.installReservations.length, "persistent canister permission")}${broad ? ", including broad access" : ""}. They remain until revoked, made incompatible, or the app is removed.`,
      );
    } else {
      facts.push(
        `Can later ask for ${broad ? "broad or exact" : "exact"} persistent access to other canisters; installation alone approves no destination.`,
      );
    }
    if (backend.maxCyclesPerCall > 0) {
      facts.push(
        `Approved canister calls may transfer up to ${formatCycles(backend.maxCyclesPerCall)} per call and ${formatCycles(backend.maxCyclesPerDay)} per UTC day.`,
      );
    } else {
      facts.push("Approved canister calls cannot transfer cycles.");
    }
  }
  if (https) {
    const origins = uniqueOrigins(https.endpoints.map(({ urlPrefix }) => urlPrefix));
    const hasPost = https.endpoints.some(({ methods }) => methods.includes("post"));
    facts.push(
      `Can make paid single-node HTTPS requests to ${formatShortList(origins)}. Replies are not cross-checked by subnet consensus. Request and reply plaintext is visible to the destination and IC subnet replicas${hasPost ? ", and POST requests can send data or trigger remote changes" : ""}.`,
    );
  }
  if (ethereum) {
    facts.push(
      ethereum.methods.includes("eth_sendTransaction")
        ? "Can ask an Ethereum wallet to submit transactions; the wallet still confirms each transaction."
        : "Can request limited Ethereum wallet access but cannot submit transactions.",
    );
  }
  if (randomness) {
    facts.push("Can request consensus randomness; each request spends Neutron cycles.");
  }
  return {
    id: "outside-services",
    level: maxLevel(relevant),
    title: "Reach other canisters or services",
    description:
      "Data or cycles may leave this app's protected storage after the relevant access is active.",
    facts,
  };
}

function publicConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const ingress = permissionsOf(permissions, "public_ingress_route");
  const routes = permissionsOf(permissions, "http_route");
  const assets = firstPermission(permissions, "certified_assets");
  const publicMethods = permissionsOf(permissions, "public_method");
  const relevant: Permission[] = [...ingress, ...routes, ...publicMethods];
  if (assets) relevant.push(assets);
  if (relevant.length === 0) return null;
  const facts: string[] = [];
  const ingressUpdates = ingress.filter(({ mode }) => mode === "update");
  const ingressReads = ingress.length - ingressUpdates.length;
  if (ingressUpdates.length > 0) {
    const direct = ingressUpdates.filter(({ caller }) => caller === "authenticated").length;
    const paid = ingressUpdates.length - direct;
    facts.push(
      `${countLabel(ingressUpdates.length, "public protocol")} can change app state without opening a tile${direct ? `; ${direct} use owner-funded direct ingress` : ""}${paid ? `; ${paid} require a canister-paid base charge` : ""}.`,
    );
  }
  if (ingressReads > 0) {
    facts.push(`${countLabel(ingressReads, "public protocol")} exposes read-only data.`);
  }
  const activeRoutes = routes.filter(({ mode }) => mode === "http_post_update_handler");
  const readRoutes = routes.length - activeRoutes.length;
  if (activeRoutes.length > 0) {
    facts.push(
      `${countLabel(activeRoutes.length, "public web route")} can run app code, change state, and spend Neutron cycles.`,
    );
  }
  if (readRoutes > 0) {
    facts.push(`${countLabel(readRoutes, "public web route")} serves certified app data.`);
  }
  if (assets) {
    facts.push(
      `Can publish up to ${formatBytes(assets.maxCommittedBytes)} of public plaintext. Published bodies are not encrypted.`,
    );
  }
  if (publicMethods.length > 0) {
    facts.push(
      `${countLabel(publicMethods.length, "backend method")} is callable without owner authorization.`,
    );
  }
  return {
    id: "public-access",
    level: maxLevel(relevant),
    title: "Expose data or actions publicly",
    description:
      "Outside callers may reach these parts of the app without an open tile.",
    facts,
  };
}

function automaticConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const tasks = permissionsOf(permissions, "scheduled_task");
  const prompts = permissionsOf(permissions, "background_ui_request");
  const resident = firstPermission(permissions, "dedicated_resident_origin");
  const taskResources = permissionsOf(permissions, "function_resources").filter(
    (permission) =>
      permission.resources.some(({ kind }) => kind === "task_capabilities"),
  );
  const relevant: Permission[] = [...tasks, ...prompts, ...taskResources];
  if (resident) relevant.push(resident);
  if (relevant.length === 0) return null;
  const facts: string[] = [];
  if (tasks.length > 0) {
    const shortest = Math.min(...tasks.map(({ intervalSeconds }) => intervalSeconds));
    const calls = tasks.reduce(
      (count, task) => count + task.maxBackendCalls,
      0,
    );
    facts.push(
      `${countLabel(tasks.length, "scheduled task")} can run without an open tile, as often as ${formatInterval(shortest)}${calls > 0 ? `, with up to ${calls} declared backend calls across one run of each task` : ""}.`,
    );
  }
  if (resident) {
    facts.push(
      "Can stay active while Neutron is open in an isolated temporary browser partition.",
    );
  }
  if (prompts.length > 0) {
    facts.push(
      `Its background can request ${countLabel(prompts.length, "kind of owner prompt")}; each requested action still needs its normal approval.`,
    );
  }
  if (taskResources.length > 0 && tasks.length === 0) {
    facts.push("Receives backend capabilities intended for autonomous task work.");
  }
  return {
    id: "automatic-work",
    level: maxLevel(relevant),
    title: "Run without an open tile",
    description:
      "The app can remain active or perform declared work in the background.",
    facts,
  };
}

function dataConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const stores = firstPermission(permissions, "stable_store");
  const keys = firstPermission(permissions, "vetkeys");
  const browserStorage = firstPermission(
    permissions,
    "persistent_background_storage",
  );
  const connections = permissionsOf(permissions, "connection");
  const memoryFunctions = permissionsOf(
    permissions,
    "function_resources",
  ).filter((permission) =>
    permission.resources.some(({ kind }) => kind === "stable_memory"),
  );
  const relevant: Permission[] = [...connections];
  if (stores) relevant.push(stores);
  if (keys) relevant.push(keys);
  if (browserStorage) relevant.push(browserStorage);
  relevant.push(...memoryFunctions);
  if (relevant.length === 0) return null;
  const facts: string[] = [];
  if (stores) {
    facts.push(
      `Can keep data in ${countLabel(stores.stores.length, "isolated backend store")}. The data survives compatible updates but is ordinary, unencrypted canister state.`,
    );
  }
  if (keys) {
    facts.push(
      `Declares ${countLabel(keys.slots.length, "private-key slot")}. Installation creates no key; later lifecycle changes require approval, and disabling cannot erase a key already held by a browser.`,
    );
  }
  if (browserStorage) {
    facts.push(
      "Its background can stay active while Neutron is open and keep data in this installation's isolated browser storage.",
    );
  }
  if (connections.length > 0) {
    facts.push(
      `${countLabel(connections.length, "service connection")} can be requested separately and can deliver a credential to the app's background process.`,
    );
  }
  if (memoryFunctions.length > 0) {
    facts.push(
      `${countLabel(memoryFunctions.length, "backend function")} can use isolated stable memory owned by this app.`,
    );
  }
  return {
    id: "data-and-keys",
    level: maxLevel(relevant),
    title: "Keep app data, keys, or connections",
    description:
      "These resources are isolated to this installation, but isolation does not always mean encryption.",
    facts,
  };
}

function backendContextConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const contextFunctions = permissionsOf(
    permissions,
    "function_resources",
  ).filter((permission) =>
    permission.resources.some(
      ({ kind }) =>
        kind === "caller" ||
        kind === "canister_principal" ||
        kind === "public_ingress_cycles",
    ),
  );
  if (contextFunctions.length === 0) return null;
  const context = new Set(
    contextFunctions.flatMap(({ resources }) =>
      resources.map(({ kind }) => kind),
    ),
  );
  const facts = [
    context.has("caller")
      ? "Can receive the authenticated or canister caller identity."
      : "",
    context.has("canister_principal")
      ? "Can receive this Neutron's canister address."
      : "",
    context.has("public_ingress_cycles")
      ? "Can receive the cycles attached to an approved public ingress call."
      : "",
  ].filter(Boolean);
  return {
    id: "backend-context",
    level: maxLevel(contextFunctions),
    title: "Use verified backend request context",
    description:
      "Neutron supplies limited request facts to declared backend functions.",
    facts,
  };
}

function appInteractionConsequences(
  permissions: readonly Permission[],
): PermissionConsequence | null {
  const preapproved = permissionsOf(permissions, "preapproved_self_call");
  const dependencies = permissionsOf(permissions, "app_dependency");
  const exports = permissionsOf(permissions, "internal_app_function");
  const relevant: Permission[] = [...preapproved, ...dependencies, ...exports];
  if (relevant.length === 0) return null;
  const facts: string[] = [];
  if (preapproved.length > 0) {
    const updates = preapproved.filter(({ mode }) => mode === "update").length;
    facts.push(
      `Its own live surfaces can call ${countLabel(preapproved.length, "backend method")} without another prompt${updates ? `; ${updates} can change app state` : ""}.`,
    );
  }
  if (dependencies.length > 0) {
    facts.push(
      `Uses backend functions from ${formatShortList(
        [...new Set(dependencies.map(({ app }) => app))],
      )}.`,
    );
  }
  if (exports.length > 0) {
    facts.push(
      `Exposes ${countLabel(exports.length, "internal backend function")} to declared installed-app consumers.`,
    );
  }
  return {
    id: "app-interactions",
    level: maxLevel(relevant),
    title: "Work with its own or other installed apps",
    description:
      "These calls stay inside the installed Neutron app system but may occur without a prompt for every use.",
    facts,
  };
}

function permissionsOf<K extends Permission["kind"]>(
  permissions: readonly Permission[],
  kind: K,
): Array<Extract<Permission, { kind: K }>> {
  return permissions.filter(
    (permission): permission is Extract<Permission, { kind: K }> =>
      permission.kind === kind,
  );
}

function firstPermission<K extends Permission["kind"]>(
  permissions: readonly Permission[],
  kind: K,
): Extract<Permission, { kind: K }> | undefined {
  return permissionsOf(permissions, kind)[0];
}

function maxLevel(permissions: readonly Permission[]): PermissionLevel {
  return permissions.reduce<PermissionLevel>(
    (level, permission) =>
      Math.max(level, permissionLevel(permission)) as PermissionLevel,
    1,
  );
}

function riskLabel(level: PermissionLevel): string {
  if (level === 4) return "Critical";
  if (level === 3) return "High impact";
  if (level === 2) return "Additional access";
  return "Reviewed interface";
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function uniqueOrigins(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return value;
    }
  }))];
}

function formatShortList(values: readonly string[]): string {
  if (values.length === 0) return "the declared destination";
  if (values.length <= 3) return values.join(", ");
  return `${values.slice(0, 3).join(", ")} and ${values.length - 3} more`;
}

function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
}
