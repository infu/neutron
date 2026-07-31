import { expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import * as React from "react";
import type { NeutronCertifiedAssetsCapabilityConfig } from "neutron-tools/src/capabilities/catalog.js";
import {
  loadCertifiedAssetsSettings,
  parseAdmissionCeilings,
  runCertifiedAssetsMaintenancePage,
  setCertifiedAssetsAdmissionCeilings,
  setCertifiedAssetsWritesFrozen,
  type CertifiedAssetsSettingsActor,
} from "../src/settings/certified_assets_settings.ts";

const manifest = {
  api: 2,
  max_entries: 10,
  max_committed_bytes: 1_000,
  max_object_bytes: 100,
  max_pending_stages: 1,
  max_staged_bytes: 200,
  max_batch_operations: 2,
  max_batch_bytes: 200,
  max_idempotency_receipts: 4,
  collections: [
    {
      id: "shares",
      mount: "shares",
      kind: "publication",
      max_object_bytes: 50,
    },
  ],
} satisfies NeutronCertifiedAssetsCapabilityConfig;

const scope = { app_id: "publisher", installation_uid: 7n };

function limits({
  entries = 10n,
  committedBytes = 1_000n,
  objectBytes = 100n,
  stagedBytes = 200n,
  pendingStages = 1n,
  batchOperations = 2n,
  batchBytes = 200n,
  generalReceipts = 4n,
  revocationLanes = 10n,
}: {
  entries?: bigint;
  committedBytes?: bigint;
  objectBytes?: bigint;
  stagedBytes?: bigint;
  pendingStages?: bigint;
  batchOperations?: bigint;
  batchBytes?: bigint;
  generalReceipts?: bigint;
  revocationLanes?: bigint;
} = {}) {
  return {
    entries,
    committed_bytes: committedBytes,
    object_bytes: objectBytes,
    staged_bytes: stagedBytes,
    pending_stages: pendingStages,
    batch_operations: batchOperations,
    batch_bytes: batchBytes,
    general_receipts: generalReceipts,
    revocation_lanes: revocationLanes,
  };
}

function scopeInfo() {
  return {
    ok: {
      installation_generation: 3n,
      store_authority_epoch: 9n,
      collections: [
        {
          id: "shares",
          kind: { publication: null },
          authority_epoch: 10n,
          generation: 4n,
          serving: { enabled: null },
          writes: { enabled: null },
          manifest_limits: limits({ objectBytes: 50n }),
          effective_limits: limits({
            entries: 8n,
            committedBytes: 800n,
            objectBytes: 50n,
            stagedBytes: 150n,
            generalReceipts: 3n,
          }),
        },
      ],
    },
  };
}

function usage() {
  return {
    ok: {
      current: {
        live_entries: 2n,
        occupied_entry_slots: 3n,
        committed_body_bytes: 120n,
        allocated_body_bytes: 160n,
        charged_metadata_bytes: 80n,
        accepted_staged_bytes: 20n,
        reserved_staged_bytes: 40n,
        detached_charged_bytes: 10n,
        active_stages: 1n,
        receipt_lanes: 4n,
        general_receipt_lanes: 1n,
        reserved_general_receipt_lanes: 1n,
        reserved_revocation_lanes: 1n,
        filled_revocation_lanes: 1n,
        receipt_nonce_indexes: 2n,
        receipt_expiry_indexes: 2n,
        cleanup_jobs: 1n,
      },
      manifest_limits: limits(),
      effective_limits: limits({
        entries: 8n,
        committedBytes: 800n,
        stagedBytes: 150n,
        generalReceipts: 3n,
      }),
    },
  };
}

test("Certified Assets Settings loads scoped usage and rejects plan drift", async () => {
  const actor = {
    async kernel_certified_assets_scope_info(candidate: unknown) {
      expect(candidate).toEqual(scope);
      return scopeInfo();
    },
    async kernel_certified_assets_usage(candidate: unknown) {
      expect(candidate).toEqual(scope);
      return usage();
    },
  } as unknown as CertifiedAssetsSettingsActor;
  const snapshot = await loadCertifiedAssetsSettings(actor, scope, manifest);
  expect(snapshot.usage.current.liveEntries).toBe(2n);
  expect(snapshot.usage.effectiveLimits.entries).toBe(8n);
  expect(snapshot.scopeInfo.collections[0]?.writes).toBe("enabled");
  expect(Object.isFrozen(snapshot)).toBe(true);

  const dynamicActor = {
    async kernel_certified_assets_scope_info() {
      return stringifyNats(scopeInfo().ok);
    },
    async kernel_certified_assets_usage() {
      return stringifyNats(usage().ok);
    },
  } as unknown as CertifiedAssetsSettingsActor;
  const dynamicSnapshot = await loadCertifiedAssetsSettings(
    dynamicActor,
    scope,
    manifest,
  );
  expect(dynamicSnapshot.usage.current.liveEntries).toBe(2n);

  const drifted = {
    ...actor,
    async kernel_certified_assets_usage() {
      return {
        ...usage(),
        ok: {
          ...usage().ok,
          manifest_limits: limits({ entries: 11n }),
        },
      };
    },
  } as CertifiedAssetsSettingsActor;
  await expect(
    loadCertifiedAssetsSettings(drifted, scope, manifest),
  ).rejects.toThrow("do not match the installed plan");
});

test("admission ceilings are canonical, manifest-bounded, and response-checked", async () => {
  expect(
    parseAdmissionCeilings(
      {
        entries: "8",
        committedBytes: "800",
        stagedBytes: "150",
        generalReceipts: "3",
      },
      manifest,
    ),
  ).toEqual({
    entries: 8n,
    committedBytes: 800n,
    stagedBytes: 150n,
    generalReceipts: 3n,
  });
  expect(() =>
    parseAdmissionCeilings(
      {
        entries: "011",
        committedBytes: "800",
        stagedBytes: "150",
        generalReceipts: "3",
      },
      manifest,
    ),
  ).toThrow("whole non-negative number");
  expect(() =>
    parseAdmissionCeilings(
      {
        entries: "11",
        committedBytes: "800",
        stagedBytes: "150",
        generalReceipts: "3",
      },
      manifest,
    ),
  ).toThrow("manifest maximum");

  let received: unknown;
  const actor = {
    async kernel_certified_assets_set_admission_ceilings(input: unknown) {
      received = input;
      return { ok: null };
    },
  } as unknown as CertifiedAssetsSettingsActor;
  await setCertifiedAssetsAdmissionCeilings(actor, scope, manifest, {
    entries: 8n,
    committedBytes: 800n,
    stagedBytes: 150n,
    generalReceipts: 3n,
  });
  expect(received).toEqual({
    scope,
    ceilings: {
      entries: 8n,
      committed_bytes: 800n,
      staged_bytes: 150n,
      general_receipts: 3n,
    },
  });

  const dynamicActor = {
    async kernel_certified_assets_set_admission_ceilings() {
      return null;
    },
  } as unknown as CertifiedAssetsSettingsActor;
  await setCertifiedAssetsAdmissionCeilings(dynamicActor, scope, manifest, {
    entries: 8n,
    committedBytes: 800n,
    stagedBytes: 150n,
    generalReceipts: 3n,
  });

  const malformed = {
    async kernel_certified_assets_set_admission_ceilings() {
      return { ok: null, err: { invalid: null } };
    },
  } as unknown as CertifiedAssetsSettingsActor;
  await expect(
    setCertifiedAssetsAdmissionCeilings(malformed, scope, manifest, {
      entries: 8n,
      committedBytes: 800n,
      stagedBytes: 150n,
      generalReceipts: 3n,
    }),
  ).rejects.toThrow("result is invalid");
});

test("write freeze and one-page maintenance use only the captured scope", async () => {
  const requests: unknown[] = [];
  const actor = {
    async kernel_certified_assets_set_writes_frozen(input: unknown) {
      requests.push(input);
      return { ok: null };
    },
    async kernel_certified_assets_maintenance_page(input: unknown) {
      requests.push(input);
      return {
        page: {
          records: 1n,
          bodies: 1n,
          body_bytes: 20n,
          charged_bytes: "40",
          authenticated_nodes: 2n,
          receipts: 1n,
        },
        has_more: true,
        remaining_jobs: "2",
      };
    },
  } as unknown as CertifiedAssetsSettingsActor;

  await setCertifiedAssetsWritesFrozen(actor, scope, true);
  const page = await runCertifiedAssetsMaintenancePage(actor, scope);
  expect(requests).toEqual([{ scope, frozen: true }, scope]);
  expect(page.page.chargedBytes).toBe(40n);
  expect(page.remainingJobs).toBe(2n);
  expect(page.hasMore).toBe(true);
});

test("Kernel Certified Assets Settings expose no app-owned cleanup hook", async () => {
  const sources = await Promise.all([
    readFile(
      new URL(
        "../src/settings/certified_assets_settings.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../src/settings/CertifiedAssetsSettingsControls.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  for (const source of sources) {
    expect(source).not.toContain("files_cleanup_v2");
    expect(source).not.toContain("runFilesCleanupPage");
    expect(source).not.toContain("Files-private cleanup");
  }
});

test("Certified Assets controls load once per generic installation scope", async () => {
  const requests: unknown[] = [];
  const actor = {
    async kernel_certified_assets_scope_info(candidate: unknown) {
      requests.push(candidate);
      throw new Error("temporary query failure");
    },
    async kernel_certified_assets_usage() {
      return null;
    },
  };
  const authModule = new URL("../src/reducer/auth.ts", import.meta.url).href;
  mock.module(authModule, () => ({
    getNeutronCan: async () => actor,
  }));

  const internals = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
        H: unknown;
      };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const dependencies: Array<readonly unknown[] | undefined> = [];
  const cleanups: Array<undefined | (() => void)> = [];
  let cursor = 0;
  let dirty = false;
  let effects: Array<() => void> = [];

  const dispatcher = {
    useCallback<T extends (...args: never[]) => unknown>(
      callback: T,
      deps: readonly unknown[],
    ): T {
      const index = cursor++;
      if (!sameDependencies(dependencies[index], deps)) {
        slots[index] = callback;
        dependencies[index] = deps;
      }
      return slots[index] as T;
    },
    useEffect(
      create: () => void | (() => void),
      deps: readonly unknown[],
    ): void {
      const index = cursor++;
      if (sameDependencies(dependencies[index], deps)) return;
      dependencies[index] = deps;
      effects.push(() => {
        cleanups[index]?.();
        const cleanup = create();
        cleanups[index] = typeof cleanup === "function" ? cleanup : undefined;
      });
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initialValue };
      return slots[index] as { current: T };
    },
    useState<T>(
      initialValue: T | (() => T),
    ): [T, (next: T | ((current: T) => T)) => void] {
      const index = cursor++;
      if (!(index in slots)) {
        slots[index] =
          typeof initialValue === "function"
            ? (initialValue as () => T)()
            : initialValue;
      }
      return [
        slots[index] as T,
        (next) => {
          const current = slots[index] as T;
          slots[index] =
            typeof next === "function"
              ? (next as (value: T) => T)(current)
              : next;
          dirty = true;
        },
      ];
    },
  };

  try {
    const { CertifiedAssetsSettingsControls } = await import(
      "../src/settings/CertifiedAssetsSettingsControls.tsx"
    );
    const baseProps = {
      actionsDisabled: false,
      appId: "example_app",
      appName: "Example app",
      manifest,
      open: true,
      routeSummaries: [],
    };
    let installationUid = "7";
    const render = () => {
      cursor = 0;
      effects = [];
      const previousDispatcher = internals.H;
      internals.H = dispatcher;
      try {
        CertifiedAssetsSettingsControls({
          ...baseProps,
          capabilitySummary: {
            enabled: true,
            installationUid,
            declarationFingerprint: "a".repeat(64),
          } as Parameters<
            typeof CertifiedAssetsSettingsControls
          >[0]["capabilitySummary"],
        });
      } finally {
        internals.H = previousDispatcher;
      }
      for (const effect of effects) effect();
    };
    const settle = async (expectedCalls: number) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await Bun.sleep(0);
        if (dirty) {
          dirty = false;
          render();
        }
        if (requests.length === expectedCalls && !dirty) {
          await Bun.sleep(0);
          if (!dirty) return;
        }
      }
      throw new Error(`Timed out waiting for ${expectedCalls} scoped loads`);
    };

    render();
    await settle(1);
    render();
    render();
    await settle(1);
    expect(requests).toEqual([{ app_id: "example_app", installation_uid: 7n }]);

    installationUid = "8";
    render();
    await settle(2);
    render();
    await settle(2);
    expect(requests).toEqual([
      { app_id: "example_app", installation_uid: 7n },
      { app_id: "example_app", installation_uid: 8n },
    ]);
  } finally {
    for (const cleanup of cleanups) cleanup?.();
    mock.restore();
  }
});

function stringifyNats(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringifyNats);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, candidate]) => [
        key,
        stringifyNats(candidate),
      ]),
    );
  }
  return value;
}

function sameDependencies(
  left: readonly unknown[] | undefined,
  right: readonly unknown[],
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  );
}
