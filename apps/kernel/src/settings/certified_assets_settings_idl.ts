import type { IDL as CandidIDL } from "@dfinity/candid";

/**
 * Static authenticated-actor bindings for the owner Settings surface.
 *
 * Keep this pure so tests can compare the complete Candid shapes without
 * importing the browser authentication module. Scope retirement and
 * fresh-install entropy initialization are lifecycle/provision actions, not
 * Settings controls.
 */
export function certifiedAssetsSettingsIdl(
  IDL: Parameters<CandidIDL.InterfaceFactory>[0]["IDL"],
  AppScope: CandidIDL.Type,
) {
  const Limits = IDL.Record({
    entries: IDL.Nat,
    committed_bytes: IDL.Nat,
    object_bytes: IDL.Nat,
    staged_bytes: IDL.Nat,
    pending_stages: IDL.Nat,
    batch_operations: IDL.Nat,
    batch_bytes: IDL.Nat,
    general_receipts: IDL.Nat,
    revocation_lanes: IDL.Nat,
  });
  const CollectionKind = IDL.Variant({
    publication: IDL.Null,
    immutable_blob: IDL.Null,
    mutable_blob: IDL.Null,
  });
  const ServingState = IDL.Variant({
    enabled: IDL.Null,
    disabled: IDL.Null,
  });
  const WriteState = IDL.Variant({
    enabled: IDL.Null,
    frozen: IDL.Null,
  });
  const CollectionInfo = IDL.Record({
    id: IDL.Text,
    kind: CollectionKind,
    authority_epoch: IDL.Nat64,
    generation: IDL.Nat64,
    serving: ServingState,
    writes: WriteState,
    manifest_limits: Limits,
    effective_limits: Limits,
  });
  const ScopeInfo = IDL.Record({
    installation_generation: IDL.Nat64,
    store_authority_epoch: IDL.Nat64,
    collections: IDL.Vec(CollectionInfo),
  });
  const CasIdentity = IDL.Record({
    collection_generation: IDL.Nat64,
    kernel_revision: IDL.Nat64,
    content_tag: IDL.Vec(IDL.Nat8),
    body_bytes: IDL.Nat,
  });
  const Error = IDL.Variant({
    invalid: IDL.Null,
    stale_scope: IDL.Null,
    stale_generation: IDL.Record({ current: IDL.Nat64 }),
    disabled: IDL.Null,
    frozen: IDL.Null,
    not_found: IDL.Null,
    retired_key: IDL.Null,
    conflict: IDL.Record({ current: IDL.Opt(CasIdentity) }),
    quota: IDL.Null,
    receipt_full: IDL.Null,
    aborted: IDL.Null,
    expired: IDL.Null,
    incomplete: IDL.Record({
      missing_blocks: IDL.Vec(IDL.Nat32),
    }),
    not_ready: IDL.Null,
    generation_exhausted: IDL.Null,
    revision_exhausted: IDL.Null,
    low_cycles: IDL.Null,
    busy: IDL.Null,
  });
  const ScopeInfoResult = IDL.Variant({
    ok: ScopeInfo,
    err: Error,
  });
  const UsageCounters = IDL.Record({
    live_entries: IDL.Nat,
    occupied_entry_slots: IDL.Nat,
    committed_body_bytes: IDL.Nat,
    allocated_body_bytes: IDL.Nat,
    charged_metadata_bytes: IDL.Nat,
    accepted_staged_bytes: IDL.Nat,
    reserved_staged_bytes: IDL.Nat,
    detached_charged_bytes: IDL.Nat,
    active_stages: IDL.Nat,
    receipt_lanes: IDL.Nat,
    general_receipt_lanes: IDL.Nat,
    reserved_general_receipt_lanes: IDL.Nat,
    reserved_revocation_lanes: IDL.Nat,
    filled_revocation_lanes: IDL.Nat,
    receipt_nonce_indexes: IDL.Nat,
    receipt_expiry_indexes: IDL.Nat,
    cleanup_jobs: IDL.Nat,
  });
  const Usage = IDL.Record({
    current: UsageCounters,
    manifest_limits: Limits,
    effective_limits: Limits,
  });
  const UsageResult = IDL.Variant({
    ok: Usage,
    err: Error,
  });
  const UnitResult = IDL.Variant({
    ok: IDL.Null,
    err: Error,
  });
  const AdmissionCeilings = IDL.Record({
    entries: IDL.Nat,
    committed_bytes: IDL.Nat,
    staged_bytes: IDL.Nat,
    general_receipts: IDL.Nat,
  });
  const Reclaimed = IDL.Record({
    records: IDL.Nat,
    bodies: IDL.Nat,
    body_bytes: IDL.Nat,
    charged_bytes: IDL.Nat,
    authenticated_nodes: IDL.Nat,
    receipts: IDL.Nat,
  });
  const MaintenancePageOk = IDL.Record({
    page: Reclaimed,
    has_more: IDL.Bool,
    remaining_jobs: IDL.Nat,
  });

  const methods = {
    kernel_certified_assets_scope_info: IDL.Func(
      [AppScope],
      [ScopeInfoResult],
      ["query"],
    ),
    kernel_certified_assets_usage: IDL.Func(
      [AppScope],
      [UsageResult],
      ["query"],
    ),
    kernel_certified_assets_set_admission_ceilings: IDL.Func(
      [
        IDL.Record({
          scope: AppScope,
          ceilings: AdmissionCeilings,
        }),
      ],
      [UnitResult],
      [],
    ),
    kernel_certified_assets_set_writes_frozen: IDL.Func(
      [
        IDL.Record({
          scope: AppScope,
          frozen: IDL.Bool,
        }),
      ],
      [UnitResult],
      [],
    ),
    kernel_certified_assets_maintenance_page: IDL.Func(
      [AppScope],
      [MaintenancePageOk],
      [],
    ),
  } satisfies Record<string, CandidIDL.FuncClass>;

  return {
    methods,
    types: {
      Limits,
      ScopeInfo,
      ScopeInfoResult,
      Usage,
      UsageResult,
      UnitResult,
      AdmissionCeilings,
      MaintenancePageOk,
    },
  } as const;
}
