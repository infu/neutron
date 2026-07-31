import type {
  AppRegistry,
  AppRegistryEntry,
  KernelRuntimeInfo,
} from "neutron-compiler/src/install.js";
import { Principal } from "@dfinity/principal";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import {
  assertAppSurfaceInventoryCapacity,
  MAX_INSTALLED_APP_INSTANCES,
} from "../runtime_limits.ts";
import { normalizeNat } from "./format.ts";

export type KernelSettingsSnapshot = {
  snapshot_version: bigint | number;
  cycles_balance: bigint | number;
  rts_version: string;
  wasm_memory_bytes: bigint | number;
  heap_size_bytes: bigint | number;
  total_allocation_bytes: bigint | number;
  reclaimed_bytes: bigint | number;
  max_live_size_bytes: bigint | number;
  stable_memory_bytes: bigint | number;
  logical_stable_memory_bytes: bigint | number;
};

export type KernelMemorySnapshot = {
  snapshot_version: bigint | number;
  wasm_memory_bytes: bigint | number;
  stable_memory_bytes: bigint | number;
  wasm_memory_limit_bytes: bigint | number;
  stable_memory_limit_bytes: bigint | number;
};

export const APP_USAGE_WINDOW_DAYS = 30;
const U64_MAX = 18_446_744_073_709_551_615n;
const CYCLE_COUNTER_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n;

export type KernelAppUsageDayWire = {
  day: bigint | number;
  instructions: bigint | number;
  executions: bigint | number;
  outgoing_cycles: bigint | number;
  incoming_cycles_accepted: bigint | number;
};

export type KernelAppUsageWire = {
  app_id: string;
  installation_uid: bigint | number;
  lifetime_instructions: bigint | number;
  lifetime_executions: bigint | number;
  lifetime_outgoing_cycles: bigint | number;
  lifetime_incoming_cycles_accepted: bigint | number;
  window_instructions: bigint | number;
  window_executions: bigint | number;
  window_outgoing_cycles: bigint | number;
  window_incoming_cycles_accepted: bigint | number;
  days: KernelAppUsageDayWire[];
};

export type KernelAppUsageSnapshotWire = {
  snapshot_version: bigint | number;
  current_day: bigint | number;
  apps: KernelAppUsageWire[];
};

export type AppUsageDay = Readonly<{
  day: bigint;
  instructions: bigint;
  executions: bigint;
  outgoingCycles: bigint;
  incomingCyclesAccepted: bigint;
}>;

export type AppUsage = Readonly<{
  appId: string;
  installationUid: bigint;
  lifetimeInstructions: bigint;
  lifetimeExecutions: bigint;
  lifetimeOutgoingCycles: bigint;
  lifetimeIncomingCyclesAccepted: bigint;
  windowInstructions: bigint;
  windowExecutions: bigint;
  windowOutgoingCycles: bigint;
  windowIncomingCyclesAccepted: bigint;
  days: readonly AppUsageDay[];
}>;

export type KernelAppUsageSnapshot = Readonly<{
  snapshotVersion: 2n;
  currentDay: bigint;
  apps: readonly AppUsage[];
}>;

export type PrincipalValue = string | { toText(): string };

export type KernelAccessSnapshotWire = {
  snapshot_version: bigint | number;
  authorized_principals: PrincipalValue[];
  controllers: PrincipalValue[];
  self_principal: PrincipalValue;
  controller_limit: bigint | number;
};

export type KernelAccessSnapshot = {
  snapshot_version: bigint;
  authorized_principals: string[];
  controllers: string[];
  self_principal: string;
  controller_limit: bigint;
};

export type SettingsAppRow = {
  id: string;
  entry: AppRegistryEntry;
  memories: KernelRuntimeInfo["memories"];
  runtimeVersion: bigint | number | undefined;
};

export type ScheduledTaskSummary = {
  app_id: string;
  installation_uid: bigint | number;
  id: string;
  method: string;
  interval_seconds: bigint | number;
  run_on_start: boolean;
  max_backend_calls: bigint | number;
  enabled: boolean;
  running: boolean;
};

export type RegistryReconciliation = {
  ok: boolean;
  issues: string[];
};

export function validateSettingsSnapshot(
  snapshot: KernelSettingsSnapshot,
): KernelSettingsSnapshot {
  normalizeNat(snapshot.snapshot_version, "snapshot version");
  normalizeNat(snapshot.cycles_balance, "cycle balance");
  normalizeNat(snapshot.wasm_memory_bytes, "Wasm memory");
  normalizeNat(snapshot.heap_size_bytes, "heap size");
  normalizeNat(snapshot.total_allocation_bytes, "total allocation");
  normalizeNat(snapshot.reclaimed_bytes, "reclaimed bytes");
  normalizeNat(snapshot.max_live_size_bytes, "max live size");
  normalizeNat(snapshot.stable_memory_bytes, "stable memory");
  normalizeNat(
    snapshot.logical_stable_memory_bytes,
    "logical stable memory",
  );
  if (typeof snapshot.rts_version !== "string") {
    throw new Error("Invalid runtime-system version");
  }
  return snapshot;
}

export function validateMemorySnapshot(
  snapshot: KernelMemorySnapshot,
): KernelMemorySnapshot {
  normalizeNat(snapshot.snapshot_version, "memory snapshot version");
  normalizeNat(snapshot.wasm_memory_bytes, "main memory");
  normalizeNat(snapshot.stable_memory_bytes, "stable memory");
  const wasmLimit = normalizeNat(
    snapshot.wasm_memory_limit_bytes,
    "main-memory limit",
  );
  const stableLimit = normalizeNat(
    snapshot.stable_memory_limit_bytes,
    "stable-memory limit",
  );
  if (wasmLimit === 0n || stableLimit === 0n) {
    throw new Error("Memory limits must be positive");
  }
  return snapshot;
}

export function validateAppUsageSnapshot(
  value: unknown,
): KernelAppUsageSnapshot {
  const snapshot = exactRecord(
    value,
    ["snapshot_version", "current_day", "apps"],
    "app-usage snapshot",
  );
  const snapshotVersion = natural(
    snapshot.snapshot_version,
    "app-usage snapshot version",
  );
  if (snapshotVersion !== 2n) {
    throw new Error("Unsupported app-usage snapshot version");
  }
  const currentDay = natural64(
    snapshot.current_day,
    "app-usage current day",
  );
  if (!Array.isArray(snapshot.apps)) {
    throw new Error("Invalid app-usage inventory");
  }
  if (snapshot.apps.length > MAX_INSTALLED_APP_INSTANCES) {
    throw new Error("App-usage inventory exceeds its bound");
  }

  const scopeKeys = new Set<string>();
  const apps = snapshot.apps.map((candidate) => {
    const app = exactRecord(
      candidate,
      [
        "app_id",
        "installation_uid",
        "lifetime_instructions",
        "lifetime_executions",
        "lifetime_outgoing_cycles",
        "lifetime_incoming_cycles_accepted",
        "window_instructions",
        "window_executions",
        "window_outgoing_cycles",
        "window_incoming_cycles_accepted",
        "days",
      ],
      "app-usage app",
    );
    if (
      !isValidAppId(app.app_id)
    ) {
      throw new Error("Invalid app-usage app id");
    }
    const installationUid = natural64(
      app.installation_uid,
      "app-usage installation uid",
    );
    if (installationUid === 0n) {
      throw new Error("App-usage installation uid must be positive");
    }
    const scopeKey = appUsageScopeKey(app.app_id, installationUid);
    if (scopeKeys.has(scopeKey)) {
      throw new Error("Duplicate app-usage scope");
    }
    scopeKeys.add(scopeKey);

    const lifetimeInstructions = natural64(
      app.lifetime_instructions,
      "lifetime instructions",
    );
    const lifetimeExecutions = natural64(
      app.lifetime_executions,
      "lifetime executions",
    );
    const lifetimeOutgoingCycles = cycleCounter(
      app.lifetime_outgoing_cycles,
      "lifetime outgoing cycles",
    );
    const lifetimeIncomingCyclesAccepted = cycleCounter(
      app.lifetime_incoming_cycles_accepted,
      "lifetime incoming cycles accepted",
    );
    const windowInstructions = natural64(
      app.window_instructions,
      "30-day instructions",
    );
    const windowExecutions = natural64(
      app.window_executions,
      "30-day executions",
    );
    const windowOutgoingCycles = cycleCounter(
      app.window_outgoing_cycles,
      "30-day outgoing cycles",
    );
    const windowIncomingCyclesAccepted = cycleCounter(
      app.window_incoming_cycles_accepted,
      "30-day incoming cycles accepted",
    );
    if (
      windowInstructions > lifetimeInstructions ||
      windowExecutions > lifetimeExecutions ||
      windowOutgoingCycles > lifetimeOutgoingCycles ||
      windowIncomingCyclesAccepted > lifetimeIncomingCyclesAccepted
    ) {
      throw new Error("App-usage window exceeds its lifetime total");
    }
    if (
      !Array.isArray(app.days) ||
      app.days.length > APP_USAGE_WINDOW_DAYS
    ) {
      throw new Error("Invalid app-usage daily window");
    }

    const earliestDay =
      currentDay >= BigInt(APP_USAGE_WINDOW_DAYS - 1)
        ? currentDay - BigInt(APP_USAGE_WINDOW_DAYS - 1)
        : 0n;
    const dayKeys = new Set<string>();
    let summedInstructions = 0n;
    let summedExecutions = 0n;
    let summedOutgoingCycles = 0n;
    let summedIncomingCyclesAccepted = 0n;
    const days = app.days
      .map((dayCandidate) => {
        const dayRecord = exactRecord(
          dayCandidate,
          [
            "day",
            "instructions",
            "executions",
            "outgoing_cycles",
            "incoming_cycles_accepted",
          ],
          "app-usage day",
        );
        const day = natural64(dayRecord.day, "app-usage day");
        if (day < earliestDay || day > currentDay) {
          throw new Error("App-usage day is outside the 30-day window");
        }
        if (dayKeys.has(day.toString())) {
          throw new Error("Duplicate app-usage day");
        }
        dayKeys.add(day.toString());
        const instructions = natural64(
          dayRecord.instructions,
          "daily instructions",
        );
        const executions = natural64(
          dayRecord.executions,
          "daily executions",
        );
        const outgoingCycles = cycleCounter(
          dayRecord.outgoing_cycles,
          "daily outgoing cycles",
        );
        const incomingCyclesAccepted = cycleCounter(
          dayRecord.incoming_cycles_accepted,
          "daily incoming cycles accepted",
        );
        summedInstructions = saturatingAdd64(summedInstructions, instructions);
        summedExecutions = saturatingAdd64(summedExecutions, executions);
        summedOutgoingCycles = saturatingAddCycles(
          summedOutgoingCycles,
          outgoingCycles,
        );
        summedIncomingCyclesAccepted = saturatingAddCycles(
          summedIncomingCyclesAccepted,
          incomingCyclesAccepted,
        );
        return Object.freeze({
          day,
          instructions,
          executions,
          outgoingCycles,
          incomingCyclesAccepted,
        });
      })
      .sort((left, right) =>
        left.day < right.day ? -1 : left.day > right.day ? 1 : 0,
      );

    if (
      summedInstructions !== windowInstructions ||
      summedExecutions !== windowExecutions ||
      summedOutgoingCycles !== windowOutgoingCycles ||
      summedIncomingCyclesAccepted !== windowIncomingCyclesAccepted
    ) {
      throw new Error("App-usage daily window does not match its totals");
    }

    return Object.freeze({
      appId: app.app_id,
      installationUid,
      lifetimeInstructions,
      lifetimeExecutions,
      lifetimeOutgoingCycles,
      lifetimeIncomingCyclesAccepted,
      windowInstructions,
      windowExecutions,
      windowOutgoingCycles,
      windowIncomingCyclesAccepted,
      days: Object.freeze(days),
    });
  });

  return Object.freeze({
    snapshotVersion: 2n,
    currentDay,
    apps: Object.freeze(apps),
  });
}

export function appUsageScopeKey(
  appId: string,
  installationUid: bigint | number | string,
): string {
  let normalized: bigint;
  try {
    normalized =
      typeof installationUid === "string"
        ? BigInt(installationUid)
        : natural64(installationUid, "app-usage installation uid");
  } catch {
    throw new Error("Invalid app-usage installation uid");
  }
  if (normalized < 0n || normalized > U64_MAX) {
    throw new Error("Invalid app-usage installation uid");
  }
  return `${appId}\0${normalized}`;
}

export function validateScheduledTasks(value: unknown): ScheduledTaskSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid scheduled-task snapshot");
  const keys = new Set<string>();
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Invalid scheduled task");
    }
    const task = candidate as Partial<ScheduledTaskSummary>;
    if (
      !isValidAppId(task.app_id) ||
      typeof task.id !== "string" ||
      typeof task.method !== "string" ||
      typeof task.run_on_start !== "boolean" ||
      typeof task.enabled !== "boolean" ||
      typeof task.running !== "boolean" ||
      task.interval_seconds === undefined ||
      task.installation_uid === undefined ||
      task.max_backend_calls === undefined
    ) {
      throw new Error("Invalid scheduled task");
    }
    normalizeNat(task.interval_seconds, "scheduled-task interval");
    if (
      normalizeNat(task.installation_uid, "scheduled-task installation uid") ===
      0n
    ) {
      throw new Error("Scheduled-task installation uid must be positive");
    }
    normalizeNat(task.max_backend_calls, "scheduled-task call budget");
    const key = `${task.app_id}:${String(task.installation_uid)}:${task.id}`;
    if (keys.has(key)) throw new Error("Duplicate scheduled task");
    keys.add(key);
    return task as ScheduledTaskSummary;
  });
}

export function validateAccessSnapshot(
  snapshot: KernelAccessSnapshotWire,
): KernelAccessSnapshot {
  const snapshotVersion = normalizeNat(
    snapshot.snapshot_version,
    "access snapshot version",
  );
  const controllerLimit = normalizeNat(
    snapshot.controller_limit,
    "controller limit",
  );
  const authorizedPrincipals = normalizePrincipalList(
    snapshot.authorized_principals,
    "authorized principals",
  );
  const controllers = normalizePrincipalList(
    snapshot.controllers,
    "controllers",
  );
  if (BigInt(controllers.length) > controllerLimit) {
    throw new Error("Controller list exceeds its reported limit");
  }

  return {
    snapshot_version: snapshotVersion,
    authorized_principals: authorizedPrincipals,
    controllers,
    self_principal: normalizePrincipalValue(
      snapshot.self_principal,
      "Neutron principal",
    ),
    controller_limit: controllerLimit,
  };
}

export function parsePrincipalInput(value: string): Principal {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a principal");
  let principal: Principal;
  try {
    principal = Principal.fromText(trimmed);
  } catch {
    throw new Error("Enter a valid principal");
  }
  if (principal.isAnonymous()) {
    throw new Error("The anonymous principal cannot be granted access");
  }
  return principal;
}

function normalizePrincipalList(
  values: PrincipalValue[],
  label: string,
): string[] {
  if (!Array.isArray(values)) throw new Error(`Invalid ${label}`);
  const normalized = values.map((value) =>
    normalizePrincipalValue(value, label),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Duplicate ${label}`);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function normalizePrincipalValue(value: PrincipalValue, label: string): string {
  try {
    const text = typeof value === "string" ? value : value.toText();
    return Principal.fromText(text).toText();
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

export function settingsAppRows(
  apps: AppRegistry,
  runtime: KernelRuntimeInfo | null,
): SettingsAppRow[] {
  assertAppSurfaceInventoryCapacity(apps);
  const memoriesByOwner = new Map<string, KernelRuntimeInfo["memories"]>();
  const runtimeVersions = new Map(
    (runtime?.apps ?? []).map((app) => [app.scope.app_id, app.version]),
  );
  for (const memory of runtime?.memories ?? []) {
    const owned = memoriesByOwner.get(memory.owner) ?? [];
    owned.push(memory);
    memoriesByOwner.set(memory.owner, owned);
  }

  return Object.entries(apps)
    .map(([id, entry]) => ({
      id,
      entry,
      memories: [...(memoriesByOwner.get(id) ?? [])].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      runtimeVersion: runtimeVersions.get(id),
    }))
    .sort((left, right) => {
      if (left.id === "kernel") return -1;
      if (right.id === "kernel") return 1;
      const nameOrder = left.entry.name.localeCompare(right.entry.name, "en", {
        sensitivity: "base",
      });
      return nameOrder || left.id.localeCompare(right.id);
    });
}

export function reconcileAppRegistry(
  apps: AppRegistry,
  runtime: KernelRuntimeInfo,
): RegistryReconciliation {
  const issues: string[] = [];
  const runtimeApps = new Map(
    runtime.apps.map((app) => [app.scope.app_id, app]),
  );

  for (const [id, entry] of Object.entries(apps)) {
    const runtimeApp = runtimeApps.get(id);
    if (runtimeApp === undefined) {
      issues.push(`${id} is present in the registry but not the active runtime`);
      continue;
    }
    if (
      normalizeNat(runtimeApp.version, `${id} runtime version`) !==
      normalizeNat(entry.version, `${id} registry version`)
    ) {
      issues.push(`${id} has different registry and runtime versions`);
    }
    if (
      runtimeApp.capability_plan_fingerprint !==
      entry.capability_plan_fingerprint
    ) {
      issues.push(
        `${id} has different registry and runtime capability plans`,
      );
    }
  }

  for (const app of runtime.apps) {
    if (!apps[app.scope.app_id]) {
      issues.push(`${app.scope.app_id} is active but missing from the registry`);
    }
  }

  return { ok: issues.length === 0, issues };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return record;
}

function natural(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error(`${label} must be non-negative`);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error(`${label} is not a safe Nat`);
}

function natural64(value: unknown, label: string): bigint {
  const normalized = natural(value, label);
  if (normalized > U64_MAX) throw new Error(`${label} exceeds Nat64`);
  return normalized;
}

function cycleCounter(value: unknown, label: string): bigint {
  const normalized = natural(value, label);
  if (normalized > CYCLE_COUNTER_MAX) {
    throw new Error(`${label} exceeds the cycle counter bound`);
  }
  return normalized;
}

function saturatingAdd64(left: bigint, right: bigint): bigint {
  return left > U64_MAX - right ? U64_MAX : left + right;
}

function saturatingAddCycles(left: bigint, right: bigint): bigint {
  return left > CYCLE_COUNTER_MAX - right
    ? CYCLE_COUNTER_MAX
    : left + right;
}
