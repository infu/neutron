import { Principal } from "@dfinity/principal";
import type { AppRegistry } from "neutron-compiler/src/install.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import {
  RUNTIME_CAPABILITY_KINDS,
  type RuntimeCapabilityGrantMode,
  type RuntimeCapabilityKind,
} from "neutron-tools/src/capabilities/runtime.js";
import type { CapabilityApiVersion } from "neutron-tools/src/capabilities/catalog.js";
import type { AppInstanceProjection } from "../app_scope.ts";
import {
  capabilitySettings,
  runtimeCapabilityRegistrations,
} from "../capabilities/plan.ts";

export const CAPABILITY_REGISTRY_PAGE_LIMIT = 100n;
export const CAPABILITY_REGISTRY_MAX_ENTRIES = 8_192;
export const CAPABILITY_REGISTRY_MAX_PER_APP = 64;
export const CAPABILITY_REGISTRY_MAX_CURSOR_CHARS = 160;
const CAPABILITY_REGISTRY_MAX_PAGES =
  Math.ceil(CAPABILITY_REGISTRY_MAX_ENTRIES / Number(CAPABILITY_REGISTRY_PAGE_LIMIT)) + 1;
const U64_MAX = 18_446_744_073_709_551_615n;

export type CapabilityKindWire = {
  [Kind in RuntimeCapabilityKind]: { [Key in Kind]: null };
}[RuntimeCapabilityKind];

export type CapabilityGrantModeWire =
  | { declaration: null }
  | { owner_runtime_grant: null };

export type CapabilityOutcome =
  | "ok"
  | "denied"
  | "failed"
  | "rate_limited"
  | "busy"
  | "revoked";

export type CapabilityOutcomeWire =
  | { ok: null }
  | { denied: null }
  | { failed: null }
  | { rate_limited: null }
  | { busy: null }
  | { revoked: null };

export type CapabilityUsageWire = {
  total: bigint | number;
  succeeded: bigint | number;
  denied: bigint | number;
  failed: bigint | number;
  rate_limited: bigint | number;
  busy: bigint | number;
  revoked: bigint | number;
  last_at: [] | [bigint | number];
  last_operation: [] | [string];
  last_outcome: [] | [CapabilityOutcomeWire];
};

export type CapabilitySummaryWire = {
  scope: { app_id: string; installation_uid: bigint | number };
  plan_fingerprint: string;
  kind: CapabilityKindWire;
  resource_id: string;
  api: bigint | number;
  declaration_fingerprint: string;
  grant: CapabilityGrantModeWire;
  toggleable: boolean;
  enabled: boolean;
  created_at: bigint | number;
  created_by: Principal | string | { toText(): string };
  updated_at: bigint | number;
  updated_by: Principal | string | { toText(): string };
  usage: CapabilityUsageWire;
};

export type CapabilityPageWire = {
  entries: CapabilitySummaryWire[];
  next: [] | [string];
};

export type CapabilityPageInputWire = {
  after: [] | [string];
  limit: bigint | number;
};

export type CapabilitySetEnabledInputWire = {
  app_id: string;
  installation_uid: bigint | number;
  kind: CapabilityKindWire;
  resource_id: string;
  enabled: boolean;
};

export type CapabilityUsageSummary = Readonly<{
  total: bigint;
  succeeded: bigint;
  denied: bigint;
  failed: bigint;
  rateLimited: bigint;
  busy: bigint;
  revoked: bigint;
  lastAt: bigint | null;
  lastOperation: string | null;
  lastOutcome: CapabilityOutcome | null;
}>;

export type CapabilitySummary = Readonly<{
  appId: string;
  installationUid: string;
  planFingerprint: string;
  kind: RuntimeCapabilityKind;
  resourceId: string;
  api: CapabilityApiVersion;
  declarationFingerprint: string;
  grant: RuntimeCapabilityGrantMode;
  toggleable: boolean;
  enabled: boolean;
  createdAt: bigint;
  createdBy: string;
  updatedAt: bigint;
  updatedBy: string;
  usage: CapabilityUsageSummary;
}>;

export type ReconciledCapabilityInventory = Readonly<{
  entries: readonly CapabilitySummary[];
  byApp: Readonly<Record<string, readonly CapabilitySummary[]>>;
}>;

export type CapabilityRegistryActor = {
  kernel_capabilities_page(input: CapabilityPageInputWire): Promise<unknown>;
  kernel_capability_set_enabled(
    input: CapabilitySetEnabledInputWire,
  ): Promise<unknown>;
};

export async function loadCapabilityRegistry(
  actor: Pick<CapabilityRegistryActor, "kernel_capabilities_page">,
): Promise<readonly CapabilitySummary[]> {
  const entries: CapabilitySummary[] = [];
  const keys = new Set<string>();
  const cursors = new Set<string>();
  const countsByScope = new Map<string, number>();
  const plansByScope = new Map<string, string>();
  let after: string | null = null;
  let previousKey: string | null = null;

  for (let pageIndex = 0; pageIndex < CAPABILITY_REGISTRY_MAX_PAGES; pageIndex += 1) {
    const page = parseCapabilityPage(
      await actor.kernel_capabilities_page({
        after: after === null ? [] : [after],
        limit: CAPABILITY_REGISTRY_PAGE_LIMIT,
      }),
    );
    if (page.entries.length > Number(CAPABILITY_REGISTRY_PAGE_LIMIT)) {
      throw new Error("Capability registry page exceeds its requested limit");
    }
    for (const entry of page.entries) {
      const key = capabilitySummaryKey(entry);
      if (keys.has(key)) {
        throw new Error(`Duplicate capability registry resource ${displayKey(entry)}`);
      }
      if (previousKey !== null && compareCanonicalText(previousKey, key) >= 0) {
        throw new Error("Capability registry inventory is not canonical");
      }
      keys.add(key);
      previousKey = key;
      const scopeKey = `${entry.appId}\0${entry.installationUid}`;
      const count = (countsByScope.get(scopeKey) ?? 0) + 1;
      if (count > CAPABILITY_REGISTRY_MAX_PER_APP) {
        throw new Error("Capability registry app inventory exceeds its bound");
      }
      countsByScope.set(scopeKey, count);
      const plan = plansByScope.get(scopeKey);
      if (plan !== undefined && plan !== entry.planFingerprint) {
        throw new Error("Capability registry app inventory mixes plan fingerprints");
      }
      plansByScope.set(scopeKey, entry.planFingerprint);
      entries.push(entry);
      if (entries.length > CAPABILITY_REGISTRY_MAX_ENTRIES) {
        throw new Error("Capability registry inventory exceeds its bound");
      }
    }

    if (page.next === null) return Object.freeze(entries);
    if (page.entries.length === 0) {
      throw new Error("Capability registry returned an empty continuation page");
    }
    const lastEntry = page.entries[page.entries.length - 1]!;
    if (page.next !== capabilitySummaryKey(lastEntry)) {
      throw new Error("Capability registry cursor does not match its page");
    }
    if (cursors.has(page.next) || page.next === after) {
      throw new Error("Capability registry cursor did not advance");
    }
    cursors.add(page.next);
    after = page.next;
  }
  throw new Error("Capability registry pagination exceeded its bound");
}

export async function setCapabilityRegistryEnabled(
  actor: Pick<CapabilityRegistryActor, "kernel_capability_set_enabled">,
  current: CapabilitySummary,
  enabled: boolean,
): Promise<CapabilitySummary> {
  if (!current.toggleable) {
    throw new Error("This capability resource cannot be toggled");
  }
  const updated = parseCapabilitySummary(
    await actor.kernel_capability_set_enabled({
      app_id: current.appId,
      installation_uid: BigInt(current.installationUid),
      kind: capabilityKindWire(current.kind),
      resource_id: current.resourceId,
      enabled,
    }),
  );
  if (
    capabilitySummaryKey(updated) !== capabilitySummaryKey(current) ||
    updated.planFingerprint !== current.planFingerprint ||
    updated.declarationFingerprint !== current.declarationFingerprint ||
    updated.api !== current.api ||
    updated.grant !== current.grant ||
    updated.toggleable !== current.toggleable
  ) {
    throw new Error("Capability toggle returned a different resource");
  }
  if (updated.enabled !== enabled) {
    throw new Error("Capability toggle did not reach the requested state");
  }
  return updated;
}

export function replaceCapabilitySummary(
  inventory: readonly CapabilitySummary[],
  updated: CapabilitySummary,
): readonly CapabilitySummary[] {
  const key = capabilitySummaryKey(updated);
  const index = inventory.findIndex(
    (candidate) => capabilitySummaryKey(candidate) === key,
  );
  if (index < 0) throw new Error("Capability toggle returned an unknown resource");
  const next = [...inventory];
  next[index] = updated;
  return Object.freeze(next);
}

export function reconcileCapabilityRegistry(
  apps: AppRegistry,
  appInstances: Readonly<Record<string, AppInstanceProjection>>,
  inventory: readonly CapabilitySummary[],
): ReconciledCapabilityInventory {
  const expected = new Map<
    string,
    ReturnType<typeof runtimeCapabilityRegistrations>[number]
  >();
  const appIds = Object.keys(apps).sort(compareCanonicalText);
  const instanceIds = Object.keys(appInstances).sort(compareCanonicalText);
  if (
    appIds.length !== instanceIds.length ||
    appIds.some((appId, index) => appId !== instanceIds[index])
  ) {
    throw new Error("Capability registry cannot reconcile an incomplete app-instance inventory");
  }

  for (const appId of appIds) {
    const app = apps[appId]!;
    const instance = appInstances[appId]!;
    const settings = capabilitySettings(app);
    if (
      settings.app.id !== appId ||
      settings.app.version !== app.version ||
      instance.scope.appId !== appId ||
      instance.version !== app.version
    ) {
      throw new Error(`${appId} capability registry version or identity is stale`);
    }
    if (
      instance.capabilityPlanFingerprint !== app.capability_plan_fingerprint ||
      settings.plan_fingerprint !== app.capability_plan_fingerprint
    ) {
      throw new Error(`${appId} capability registry plan fingerprint is stale`);
    }
    for (const registration of runtimeCapabilityRegistrations(app)) {
      const key = expectedResourceKey(
        appId,
        instance.scope.installationUid,
        registration.kind,
        registration.resource_id,
      );
      if (expected.has(key)) {
        throw new Error(`Duplicate projected capability resource ${appId}/${registration.kind}/${registration.resource_id}`);
      }
      expected.set(key, registration);
    }
  }

  const seen = new Set<string>();
  const byApp: Record<string, CapabilitySummary[]> = Object.fromEntries(
    appIds.map((appId) => [appId, []]),
  );
  for (const summary of inventory) {
    const key = capabilitySummaryKey(summary);
    if (seen.has(key)) {
      throw new Error(`Duplicate capability registry resource ${displayKey(summary)}`);
    }
    seen.add(key);
    const app = apps[summary.appId];
    const instance = appInstances[summary.appId];
    if (!app || !instance) {
      throw new Error(`Unknown active capability resource ${displayKey(summary)}`);
    }
    if (summary.installationUid !== instance.scope.installationUid) {
      throw new Error(`${displayKey(summary)} belongs to a stale installation`);
    }
    if (
      summary.planFingerprint !== instance.capabilityPlanFingerprint ||
      summary.planFingerprint !== app.capability_plan_fingerprint
    ) {
      throw new Error(`${displayKey(summary)} has a mismatched plan fingerprint`);
    }
    const registration = expected.get(key);
    if (!registration) {
      throw new Error(`Unknown active capability resource ${displayKey(summary)}`);
    }
    if (
      summary.api !== registration.api ||
      summary.declarationFingerprint !== registration.declaration_fingerprint ||
      summary.grant !== registration.grant ||
      summary.toggleable !== registration.toggleable
    ) {
      throw new Error(`${displayKey(summary)} does not match its verified plan`);
    }
    byApp[summary.appId]!.push(summary);
  }

  for (const key of expected.keys()) {
    if (!seen.has(key)) {
      const [appId, , kind, resourceId] = key.split("\0");
      throw new Error(`Missing capability registry resource ${appId}/${kind}/${resourceId}`);
    }
  }
  for (const appId of appIds) Object.freeze(byApp[appId]!);
  return Object.freeze({
    entries: Object.freeze([...inventory]),
    byApp: Object.freeze(byApp),
  });
}

export function parseCapabilityPage(value: unknown): Readonly<{
  entries: readonly CapabilitySummary[];
  next: string | null;
}> {
  const page = exactRecord(value, ["entries", "next"], "capability registry page");
  if (!Array.isArray(page.entries)) {
    throw new Error("Capability registry page entries are invalid");
  }
  if (page.entries.length > Number(CAPABILITY_REGISTRY_PAGE_LIMIT)) {
    throw new Error("Capability registry page exceeds its requested limit");
  }
  const next = parseOption(page.next, "capability registry cursor", (cursor) => {
    if (
      typeof cursor !== "string" ||
      cursor.length < 1 ||
      cursor.length > CAPABILITY_REGISTRY_MAX_CURSOR_CHARS
    ) {
      throw new Error("Capability registry cursor is invalid");
    }
    return cursor;
  });
  return Object.freeze({
    entries: Object.freeze(page.entries.map(parseCapabilitySummary)),
    next,
  });
}

export function parseCapabilitySummary(value: unknown): CapabilitySummary {
  const record = exactRecord(
    value,
    [
      "scope",
      "plan_fingerprint",
      "kind",
      "resource_id",
      "api",
      "declaration_fingerprint",
      "grant",
      "toggleable",
      "enabled",
      "created_at",
      "created_by",
      "updated_at",
      "updated_by",
      "usage",
    ],
    "capability registry summary",
  );
  const scope = exactRecord(
    record.scope,
    ["app_id", "installation_uid"],
    "capability registry scope",
  );
  if (!isValidAppId(scope.app_id)) {
    throw new Error("Capability registry app id is invalid");
  }
  const installationUid = nat64(scope.installation_uid, "installation uid");
  if (installationUid === 0n) {
    throw new Error("Capability registry installation uid must be positive");
  }
  const planFingerprint = fingerprint(record.plan_fingerprint, "plan fingerprint");
  const declarationFingerprint = fingerprint(
    record.declaration_fingerprint,
    "declaration fingerprint",
  );
  const kind = parseNullVariant<RuntimeCapabilityKind>(
    record.kind,
    RUNTIME_CAPABILITY_KINDS,
    "capability kind",
  );
  const resourceId = resourceText(record.resource_id, kind);
  const api = capabilityApi(record.api, kind);
  if (api === null) {
    throw new Error("Capability registry API is unsupported");
  }
  const grant = parseNullVariant<RuntimeCapabilityGrantMode>(
    record.grant,
    ["declaration", "owner_runtime_grant"],
    "capability grant",
  );
  const expectedGrant =
    kind === "backend_calls" || kind === "connections"
      ? "owner_runtime_grant"
      : "declaration";
  if (grant !== expectedGrant) {
    throw new Error("Capability registry grant does not match its kind");
  }
  if (typeof record.toggleable !== "boolean" || typeof record.enabled !== "boolean") {
    throw new Error("Capability registry flags are invalid");
  }
  const createdAt = nat64(record.created_at, "created timestamp");
  const updatedAt = nat64(record.updated_at, "updated timestamp");
  if (updatedAt < createdAt) {
    throw new Error("Capability registry timestamps are invalid");
  }

  return Object.freeze({
    appId: scope.app_id,
    installationUid: installationUid.toString(),
    planFingerprint,
    kind,
    resourceId,
    api,
    declarationFingerprint,
    grant,
    toggleable: record.toggleable,
    enabled: record.enabled,
    createdAt,
    createdBy: principalText(record.created_by, "creator"),
    updatedAt,
    updatedBy: principalText(record.updated_by, "updater"),
    usage: parseUsage(record.usage),
  });
}

export function capabilitySummaryKey(summary: CapabilitySummary): string {
  return expectedResourceKey(
    summary.appId,
    summary.installationUid,
    summary.kind,
    summary.resourceId,
  );
}

function expectedResourceKey(
  appId: string,
  installationUid: string,
  kind: RuntimeCapabilityKind,
  resourceId: string,
): string {
  return `${appId}\0${installationUid}\0${kind}\0${resourceId}`;
}

function displayKey(summary: CapabilitySummary): string {
  return `${summary.appId}/${summary.kind}/${summary.resourceId}`;
}

function capabilityKindWire(kind: RuntimeCapabilityKind): CapabilityKindWire {
  return { [kind]: null } as CapabilityKindWire;
}

function capabilityApi(
  value: unknown,
  kind: RuntimeCapabilityKind,
): CapabilityApiVersion | null {
  const api = nat(value, "capability API");
  if (kind === "certified_assets") return api === 2n ? 2 : null;
  return api === 1n ? 1 : null;
}

function parseUsage(value: unknown): CapabilityUsageSummary {
  const usage = exactRecord(
    value,
    [
      "total",
      "succeeded",
      "denied",
      "failed",
      "rate_limited",
      "busy",
      "revoked",
      "last_at",
      "last_operation",
      "last_outcome",
    ],
    "capability usage",
  );
  const total = nat64(usage.total, "usage total");
  const succeeded = nat64(usage.succeeded, "success count");
  const denied = nat64(usage.denied, "denied count");
  const failed = nat64(usage.failed, "failed count");
  const rateLimited = nat64(usage.rate_limited, "rate-limited count");
  const busy = nat64(usage.busy, "busy count");
  const revoked = nat64(usage.revoked, "revoked count");
  const sum = succeeded + denied + failed + rateLimited + busy + revoked;
  if ((sum > U64_MAX ? U64_MAX : sum) !== total) {
    throw new Error("Capability registry usage counters are invalid");
  }
  const lastAt = parseOption(usage.last_at, "last timestamp", (candidate) =>
    nat64(candidate, "last timestamp"),
  );
  const lastOperation = parseOption(
    usage.last_operation,
    "last operation",
    (candidate) => boundedText(candidate, "last operation", 64),
  );
  const lastOutcome = parseOption(
    usage.last_outcome,
    "last outcome",
    (candidate) =>
      parseNullVariant<CapabilityOutcome>(
        candidate,
        ["ok", "denied", "failed", "rate_limited", "busy", "revoked"],
        "last outcome",
      ),
  );
  const populated = [lastAt, lastOperation, lastOutcome].filter(
    (candidate) => candidate !== null,
  ).length;
  if (populated !== 0 && populated !== 3) {
    throw new Error("Capability registry last-operation fields are inconsistent");
  }
  if ((total === 0n) !== (populated === 0)) {
    throw new Error("Capability registry last operation does not match usage total");
  }
  return Object.freeze({
    total,
    succeeded,
    denied,
    failed,
    rateLimited,
    busy,
    revoked,
    lastAt,
    lastOperation,
    lastOutcome,
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort(compareCanonicalText);
  const expected = [...keys].sort(compareCanonicalText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return record;
}

function parseNullVariant<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  const variant = value as Record<string, unknown>;
  const keys = Object.keys(variant);
  if (
    keys.length !== 1 ||
    !allowed.includes(keys[0] as T) ||
    variant[keys[0]!] !== null
  ) {
    throw new Error(`${label} is invalid`);
  }
  return keys[0] as T;
}

function parseOption<T>(
  value: unknown,
  label: string,
  parse: (candidate: unknown) => T,
): T | null {
  if (!Array.isArray(value) || value.length > 1) {
    throw new Error(`${label} option is invalid`);
  }
  return value.length === 0 ? null : parse(value[0]);
}

function nat(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} is invalid`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${label} is not a safe Nat`);
}

function nat64(value: unknown, label: string): bigint {
  const normalized = nat(value, label);
  if (normalized > U64_MAX) throw new Error(`${label} exceeds Nat64`);
  return normalized;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`Capability registry ${label} is invalid`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Capability registry ${label} is invalid`);
  }
  return value;
}

function resourceText(value: unknown, kind: RuntimeCapabilityKind): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,64}$/u.test(value)
  ) {
    throw new Error("Capability registry resource id is invalid");
  }
  if (
    ((kind === "backend_calls" || kind === "randomness") &&
      value !== "default") ||
    (kind === "chain_key_signing" &&
      !/^[a-z][a-z0-9_]{0,39}$/u.test(value)) ||
    (kind === "stable_store" &&
      !/^[a-z][a-z0-9_]{0,39}$/u.test(value)) ||
    (kind === "https_outcalls" &&
      !/^[a-z][a-z0-9_]{0,39}$/u.test(value)) ||
    (kind === "persistent_browser_storage" && value !== "background") ||
    (kind === "dedicated_resident_origin" && value !== "background") ||
    ((kind === "http_routes" || kind === "certified_read_routes") &&
      !/^[a-z][a-z0-9_]{0,39}$/u.test(value)) ||
    (kind === "certified_assets" && value !== "default") ||
    (kind === "public_ingress" &&
      !/^[a-z][a-z0-9_]{0,62}:[a-z][a-z0-9_]{0,62}$/u.test(value))
  ) {
    throw new Error("Capability registry resource id does not match its kind");
  }
  return value;
}

function principalText(value: unknown, label: string): string {
  try {
    const text = typeof value === "string"
      ? value
      : (value as { toText(): string }).toText();
    return Principal.fromText(text).toText();
  } catch {
    throw new Error(`Capability registry ${label} principal is invalid`);
  }
}
