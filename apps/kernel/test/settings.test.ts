import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import type {
  AppRegistry,
  KernelRuntimeInfo,
} from "neutron-compiler/src/install.js";
import {
  formatBytes,
  formatExactNat,
  formatTrillionCycles,
  normalizeNat,
} from "../src/settings/format.ts";
import {
  formatMemoryPressure,
  summarizeHeapMemory,
} from "../src/settings/memory.ts";
import {
  parsePrincipalInput,
  reconcileAppRegistry,
  settingsAppRows,
  validateAccessSnapshot,
  validateMemorySnapshot,
  validateSettingsSnapshot,
  validateScheduledTasks,
} from "../src/settings/model.ts";
import {
  capabilitySettings,
  declaredCapability,
} from "../src/capabilities/plan.ts";
import { registryApp, runtimeApp } from "./app_registry_fixture.ts";

const apps: AppRegistry = {
  files: registryApp({ id: "files", name: "Files", version: 102 }),
  kernel: registryApp({ id: "kernel", name: "Neutron", version: 100 }),
  alpha: registryApp({ id: "alpha", name: "Alpha", version: 106 }),
};

const runtime: KernelRuntimeInfo = {
  deployment_id: "deployment",
  assembler_id: "assembler",
  compiler_id: "compiler",
  apps: [
    runtimeApp({ id: "kernel", entry: apps.kernel!, installationUid: 1n }),
    runtimeApp({ id: "alpha", entry: apps.alpha!, installationUid: 2n }),
    runtimeApp({ id: "files", entry: apps.files!, installationUid: 3n }),
  ],
  memories: [
    { id: "files", owner: "files", version: 3n, schema: "files-v3" },
    { id: "kernel", owner: "kernel", version: 2n, schema: "kernel-v2" },
  ],
};

test("settings format large Nat values without Number conversion", () => {
  expect(formatTrillionCycles(99_840_000_000_000n)).toBe("99.8400TC");
  expect(formatTrillionCycles(100_000_000_000n)).toBe("0.1000TC");
  expect(formatTrillionCycles(0n)).toBe("0.0000TC");
  expect(formatBytes(1_610_612_736n)).toBe("1.5 GiB");
  expect(formatExactNat(9_007_199_254_740_993n)).toBe(
    "9,007,199,254,740,993",
  );
  expect(normalizeNat(Number.MAX_SAFE_INTEGER)).toBe(9_007_199_254_740_991n);
  expect(() => normalizeNat(Number.MAX_SAFE_INTEGER + 1)).toThrow(
    "not a safe Nat",
  );
});

test("heap memory pressure stays bounded and formats compactly", () => {
  expect(summarizeHeapMemory(1_536n, 8_192n)).toEqual({
    limitBytes: 8_192n,
    pressureBasisPoints: 1_875,
    pressurePercent: 18.75,
    usedBytes: 1_536n,
  });
  expect(summarizeHeapMemory(2_000n, 1_000n).pressurePercent).toBe(100);
  const overLimit = summarizeHeapMemory(10n ** 1_000n, 1n);
  expect(overLimit.pressureBasisPoints).toBe(10_000);
  expect(overLimit.pressurePercent).toBe(100);
  expect(() => summarizeHeapMemory(1n, 0n)).toThrow(
    "canister-memory limit must be positive",
  );
  expect(formatMemoryPressure(0)).toBe("0%");
  expect(formatMemoryPressure(1)).toBe("<0.1%");
  expect(formatMemoryPressure(850)).toBe("8.5%");
  expect(formatMemoryPressure(1_000)).toBe("10%");
});

test("memory snapshot validation requires usable limits", () => {
  const snapshot = {
    snapshot_version: 1n,
    wasm_memory_bytes: 100n,
    stable_memory_bytes: 200n,
    wasm_memory_limit_bytes: 3_221_225_472n,
    stable_memory_limit_bytes: 536_870_912_000n,
  };
  expect(validateMemorySnapshot(snapshot)).toBe(snapshot);
  for (const field of [
    "wasm_memory_limit_bytes",
    "stable_memory_limit_bytes",
  ] as const) {
    expect(() =>
      validateMemorySnapshot({ ...snapshot, [field]: 0n }),
    ).toThrow("Memory limits must be positive");
  }
  expect(() =>
    validateMemorySnapshot({
      ...snapshot,
      wasm_memory_bytes: Number.MAX_SAFE_INTEGER + 1,
    }),
  ).toThrow("main memory is not a safe Nat");
});

test("settings app rows put the kernel first and project owned memory", () => {
  const rows = settingsAppRows(apps, runtime);

  expect(rows.map((row) => row.id)).toEqual(["kernel", "alpha", "files"]);
  expect(rows.find((row) => row.id === "files")?.memories).toEqual([
    runtime.memories[0]!,
  ]);
  expect(rows.find((row) => row.id === "files")?.runtimeVersion).toBe(102n);
});

test("settings projects two hundred arbitrary headless apps without app knowledge", () => {
  const ordinary = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => {
      const suffix = index.toString().padStart(3, "0");
      const id = `app_${suffix}`;
      return [
        id,
        registryApp({
          id,
          name: `App ${suffix}`,
          tiles: [],
        }),
      ];
    }),
  );
  const scaleApps: AppRegistry = {
    ...ordinary,
    kernel: registryApp({ id: "kernel", name: "Neutron" }),
  };
  const scaleRuntime: KernelRuntimeInfo = {
    deployment_id: "scale-deployment",
    assembler_id: "assembler",
    compiler_id: "compiler",
    apps: Object.entries(scaleApps).map(([id, entry], index) =>
      runtimeApp({
        id,
        entry,
        deploymentId: "scale-deployment",
        installationUid: BigInt(index + 1),
      }),
    ),
    memories: [],
  };

  const rows = settingsAppRows(scaleApps, scaleRuntime);
  expect(rows).toHaveLength(201);
  expect(rows[0]?.id).toBe("kernel");
  expect(rows.slice(1).every(({ entry }) => entry.tiles.length === 0)).toBe(
    true,
  );
  expect(new Set(rows.map(({ id }) => id)).size).toBe(201);
});

test("settings keeps equal app-local memory ids under their owners", () => {
  const rows = settingsAppRows(apps, {
    ...runtime,
    memories: [
      { id: "state", owner: "files", version: 3n, schema: "files-v3" },
      { id: "state", owner: "kernel", version: 2n, schema: "kernel-v2" },
    ],
  });

  expect(rows.find((row) => row.id === "files")?.memories).toEqual([
    expect.objectContaining({ id: "state", owner: "files" }),
  ]);
  expect(rows.find((row) => row.id === "kernel")?.memories).toEqual([
    expect.objectContaining({ id: "state", owner: "kernel" }),
  ]);
});

test("capability accessors verify the canonical plan fingerprint", () => {
  const wallet = registryApp({
    id: "wallet",
    name: "Wallet",
    capabilities: {
      backend_calls: {
        api: 1,
        description: "Approved ledgers",
        reservation_scopes: ["exact"],
        max_concurrency: 4,
        max_cycles_per_call: 0,
        max_cycles_per_day: 0,
      },
    },
  });
  expect(declaredCapability(wallet, "backend_calls")?.max_concurrency).toBe(4);
  expect(capabilitySettings(wallet).plan_fingerprint).toBe(
    wallet.capability_plan_fingerprint,
  );
  expect(() =>
    declaredCapability(
      { ...wallet, capability_plan_fingerprint: "f".repeat(64) },
      "backend_calls",
    ),
  ).toThrow("Capability plan fingerprint mismatch");
});

test("registry reconciliation compares ids and declared versions", () => {
  expect(reconcileAppRegistry(apps, runtime)).toEqual({ ok: true, issues: [] });

  const mismatch = reconcileAppRegistry(apps, {
    ...runtime,
    apps: runtime.apps.filter((app) => app.scope.app_id !== "files"),
  });
  expect(mismatch.ok).toBe(false);
  expect(mismatch.issues.join(" ")).toContain("files");

  const versionMismatch = reconcileAppRegistry(apps, {
    ...runtime,
    apps: runtime.apps.map((app) =>
      app.scope.app_id === "files" ? { ...app, version: 103n } : app,
    ),
  });
  expect(versionMismatch.issues).toContain(
    "files has different registry and runtime versions",
  );

  const planMismatch = reconcileAppRegistry(apps, {
    ...runtime,
    apps: runtime.apps.map((app) =>
      app.scope.app_id === "files"
        ? { ...app, capability_plan_fingerprint: "f".repeat(64) }
        : app,
    ),
  });
  expect(planMismatch.issues).toContain(
    "files has different registry and runtime capability plans",
  );
});

test("snapshot validation rejects unsafe browser numbers", () => {
  const snapshot = {
    snapshot_version: 1n,
    cycles_balance: 100_000n,
    rts_version: "rts",
    wasm_memory_bytes: 1_024n,
    heap_size_bytes: 512n,
    total_allocation_bytes: 2_048n,
    reclaimed_bytes: 256n,
    max_live_size_bytes: 768n,
    stable_memory_bytes: 65_536n,
    logical_stable_memory_bytes: 65_536n,
  };

  expect(validateSettingsSnapshot(snapshot)).toBe(snapshot);
  expect(() =>
    validateSettingsSnapshot({
      ...snapshot,
      cycles_balance: Number.MAX_SAFE_INTEGER + 1,
    }),
  ).toThrow("cycle balance is not a safe Nat");
});

test("scheduled-task snapshots validate exact limits and unique ids", () => {
  const tasks = [
    {
      app_id: "wallet",
      installation_uid: 7n,
      id: "ledger_history",
      method: "wallet_history_tick",
      interval_seconds: 43_200n,
      run_on_start: true,
      max_backend_calls: 100n,
      enabled: true,
      running: false,
    },
  ];
  expect(validateScheduledTasks(tasks)).toEqual(tasks);
  expect(() => validateScheduledTasks([...tasks, ...tasks])).toThrow(
    "Duplicate scheduled task",
  );
  expect(() =>
    validateScheduledTasks([
      { ...tasks[0]!, interval_seconds: Number.MAX_SAFE_INTEGER + 1 },
    ]),
  ).toThrow("scheduled-task interval is not a safe Nat");
  expect(() =>
    validateScheduledTasks([{ ...tasks[0]!, installation_uid: 0n }]),
  ).toThrow("installation uid must be positive");
});

test("access snapshots canonicalize, sort, and validate principals", () => {
  const self = Principal.fromText("aaaaa-aa");
  const owner = Principal.selfAuthenticating(new Uint8Array(32).fill(1));
  const snapshot = validateAccessSnapshot({
    snapshot_version: 1n,
    authorized_principals: [owner, self],
    controllers: [owner, self],
    self_principal: self,
    controller_limit: 10n,
  });

  expect(snapshot.authorized_principals).toEqual(
    [owner.toText(), self.toText()].sort(),
  );
  expect(snapshot.controllers).toEqual([owner.toText(), self.toText()].sort());
  expect(snapshot.self_principal).toBe("aaaaa-aa");
  expect(snapshot.controller_limit).toBe(10n);

  expect(() =>
    validateAccessSnapshot({
      ...snapshot,
      authorized_principals: [self, self],
    }),
  ).toThrow("Duplicate authorized principals");
  expect(() =>
    validateAccessSnapshot({
      ...snapshot,
      controllers: Array.from({ length: 11 }, (_, index) =>
        Principal.selfAuthenticating(new Uint8Array(32).fill(index + 1)),
      ),
    }),
  ).toThrow("Controller list exceeds");
});

test("principal input rejects malformed and anonymous identities", () => {
  expect(parsePrincipalInput("  aaaaa-aa ").toText()).toBe("aaaaa-aa");
  expect(() => parsePrincipalInput("")).toThrow("Enter a principal");
  expect(() => parsePrincipalInput("not a principal")).toThrow(
    "Enter a valid principal",
  );
  expect(() => parsePrincipalInput("2vxsx-fae")).toThrow(
    "anonymous principal",
  );
});
