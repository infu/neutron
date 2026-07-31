import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { IDL } from "@dfinity/candid";
import { certifiedAssetsSettingsIdl } from "../src/settings/certified_assets_settings_idl.ts";

const AppScope = IDL.Record({
  app_id: IDL.Text,
  installation_uid: IDL.Nat64,
});
const binding = certifiedAssetsSettingsIdl(IDL, AppScope);

test("static kernel actor includes the five exact Certified Assets Settings methods", async () => {
  expect(Object.keys(binding.methods).sort()).toEqual([
    "kernel_certified_assets_maintenance_page",
    "kernel_certified_assets_scope_info",
    "kernel_certified_assets_set_admission_ceilings",
    "kernel_certified_assets_set_writes_frozen",
    "kernel_certified_assets_usage",
  ]);
  expect(
    binding.methods.kernel_certified_assets_scope_info.annotations,
  ).toEqual(["query"]);
  expect(binding.methods.kernel_certified_assets_usage.annotations).toEqual([
    "query",
  ]);
  expect(
    binding.methods.kernel_certified_assets_set_admission_ceilings.annotations,
  ).toEqual([]);
  expect(
    binding.methods.kernel_certified_assets_set_writes_frozen.annotations,
  ).toEqual([]);
  expect(
    binding.methods.kernel_certified_assets_maintenance_page.annotations,
  ).toEqual([]);
  for (const method of Object.values(binding.methods)) {
    expect(method.argTypes).toHaveLength(1);
    expect(method.retTypes).toHaveLength(1);
  }

  const authSource = await readFile(
    new URL("../src/reducer/auth.ts", import.meta.url),
    "utf8",
  );
  expect(authSource).toContain(
    "const CertifiedAssetsSettings = certifiedAssetsSettingsIdl(IDL, AppScope);",
  );
  expect(authSource).toContain("...CertifiedAssetsSettings.methods,");
});

test("static scope and usage results round-trip every semantic field", () => {
  const scopeResult = {
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
          writes: { frozen: null },
          manifest_limits: limits(),
          effective_limits: limits({
            entries: 8n,
            committedBytes: 800n,
            stagedBytes: 150n,
            generalReceipts: 3n,
          }),
        },
      ],
    },
  };
  expect(roundTrip(binding.types.ScopeInfoResult, scopeResult)).toEqual(
    scopeResult,
  );

  const usageResult = {
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
  expect(roundTrip(binding.types.UsageResult, usageResult)).toEqual(
    usageResult,
  );
});

test("static mutation inputs, full errors, and direct maintenance output are generated-compatible", () => {
  const scope = { app_id: "publisher", installation_uid: 7n };
  const ceilingsInput = {
    scope,
    ceilings: {
      entries: 8n,
      committed_bytes: 800n,
      staged_bytes: 150n,
      general_receipts: 3n,
    },
  };
  const ceilingsMethod =
    binding.methods.kernel_certified_assets_set_admission_ceilings;
  expect(
    IDL.decode(
      ceilingsMethod.argTypes,
      IDL.encode(ceilingsMethod.argTypes, [ceilingsInput]),
    ),
  ).toEqual([ceilingsInput]);

  const freezeInput = { scope, frozen: true };
  const freezeMethod =
    binding.methods.kernel_certified_assets_set_writes_frozen;
  expect(
    IDL.decode(
      freezeMethod.argTypes,
      IDL.encode(freezeMethod.argTypes, [freezeInput]),
    ),
  ).toEqual([freezeInput]);

  const conflict = {
    err: {
      conflict: {
        current: [
          {
            collection_generation: 4n,
            kernel_revision: 12n,
            content_tag: Uint8Array.from({ length: 32 }, (_, index) => index),
            body_bytes: 50n,
          },
        ],
      },
    },
  };
  expect(roundTrip(binding.types.UnitResult, conflict)).toEqual(conflict);
  expect(
    roundTrip(binding.types.UnitResult, {
      err: { incomplete: { missing_blocks: [0, 15, 4_294_967_295] } },
    }),
  ).toEqual({
    err: {
      incomplete: {
        missing_blocks: Uint32Array.from([0, 15, 4_294_967_295]),
      },
    },
  });

  const errorType = variantField(
    binding.types.UnitResult,
    "err",
  ) as IDL.VariantClass;
  expect(errorType._fields.map(([label]) => label).sort()).toEqual([
    "aborted",
    "busy",
    "conflict",
    "disabled",
    "expired",
    "frozen",
    "generation_exhausted",
    "incomplete",
    "invalid",
    "low_cycles",
    "not_found",
    "not_ready",
    "quota",
    "receipt_full",
    "retired_key",
    "revision_exhausted",
    "stale_generation",
    "stale_scope",
  ]);

  const maintenance = {
    page: {
      records: 1n,
      bodies: 1n,
      body_bytes: 20n,
      charged_bytes: 40n,
      authenticated_nodes: 2n,
      receipts: 1n,
    },
    has_more: true,
    remaining_jobs: 2n,
  };
  expect(roundTrip(binding.types.MaintenancePageOk, maintenance)).toEqual(
    maintenance,
  );
});

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

function roundTrip(type: IDL.Type, value: unknown): unknown {
  return IDL.decode([type], IDL.encode([type], [value]))[0];
}

function variantField(type: IDL.Type, label: string): IDL.Type {
  if (!(type instanceof IDL.VariantClass)) {
    throw new Error("Expected a Candid variant");
  }
  const field = type._fields.find(([candidate]) => candidate === label);
  if (!field) throw new Error(`Missing Candid variant field ${label}`);
  return field[1];
}
