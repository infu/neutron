import { IDL } from "@dfinity/candid";

const Error = IDL.Variant({
  invalid: IDL.Null,
  stale_scope: IDL.Null,
  stale_generation: IDL.Record({ current: IDL.Nat64 }),
  disabled: IDL.Null,
  frozen: IDL.Null,
  not_found: IDL.Null,
  retired_key: IDL.Null,
  conflict: IDL.Record({
    current: IDL.Opt(
      IDL.Record({
        collection_generation: IDL.Nat64,
        kernel_revision: IDL.Nat64,
        content_tag: IDL.Vec(IDL.Nat8),
        body_bytes: IDL.Nat,
      }),
    ),
  }),
  quota: IDL.Null,
  receipt_full: IDL.Null,
  aborted: IDL.Null,
  expired: IDL.Null,
  incomplete: IDL.Record({ missing_blocks: IDL.Vec(IDL.Nat32) }),
  not_ready: IDL.Null,
  generation_exhausted: IDL.Null,
  revision_exhausted: IDL.Null,
  low_cycles: IDL.Null,
  busy: IDL.Null,
});

const Locator = IDL.Variant({
  publication: IDL.Record({
    publication_id: IDL.Vec(IDL.Nat8),
    filename: IDL.Text,
  }),
  body_sha256: IDL.Record({ digest: IDL.Vec(IDL.Nat8) }),
  key32: IDL.Record({ key: IDL.Vec(IDL.Nat8) }),
  exact_path: IDL.Null,
});

export const Target = IDL.Record({
  collection: IDL.Text,
  collection_generation: IDL.Nat64,
  locator: Locator,
});

const Condition = IDL.Variant({
  absent: IDL.Null,
  match: IDL.Record({
    revision: IDL.Nat64,
    content_tag: IDL.Vec(IDL.Nat8),
  }),
});

const StageTarget = IDL.Variant({
  allocate_publication: IDL.Record({
    collection: IDL.Text,
    collection_generation: IDL.Nat64,
    filename: IDL.Text,
    presentation: IDL.Variant({
      inline_text: IDL.Null,
      attachment: IDL.Null,
    }),
  }),
  derive_body_sha256: IDL.Record({
    collection: IDL.Text,
    collection_generation: IDL.Nat64,
  }),
});

const BodySource = IDL.Variant({
  inline: IDL.Vec(IDL.Nat8),
  stage: IDL.Nat64,
});

const BatchOperation = IDL.Variant({
  put: IDL.Record({
    target: Target,
    condition: Condition,
    body: BodySource,
  }),
  delete: IDL.Record({
    target: Target,
    condition: IDL.Record({
      revision: IDL.Nat64,
      content_tag: IDL.Vec(IDL.Nat8),
    }),
  }),
});

const PresentRequirement = IDL.Record({
  target: Target,
  content_tag: IDL.Vec(IDL.Nat8),
  revision: IDL.Opt(IDL.Nat64),
});

export const CommitBatchInput = IDL.Record({
  nonce: IDL.Vec(IDL.Nat8),
  operations: IDL.Vec(BatchOperation),
  requires_present_after: IDL.Vec(PresentRequirement),
});

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

const CollectionInfo = IDL.Record({
  id: IDL.Text,
  kind: IDL.Variant({
    publication: IDL.Null,
    immutable_blob: IDL.Null,
    mutable_blob: IDL.Null,
  }),
  authority_epoch: IDL.Nat64,
  generation: IDL.Nat64,
  serving: IDL.Variant({ enabled: IDL.Null, disabled: IDL.Null }),
  writes: IDL.Variant({ enabled: IDL.Null, frozen: IDL.Null }),
  manifest_limits: Limits,
  effective_limits: Limits,
});

const ScopeInfo = IDL.Record({
  installation_generation: IDL.Nat64,
  store_authority_epoch: IDL.Nat64,
  collections: IDL.Vec(CollectionInfo),
});

const StageGeometry = IDL.Record({
  block_bytes: IDL.Nat,
  block_count: IDL.Nat32,
  expected_bytes: IDL.Nat,
});

const RecordIdentity = IDL.Record({
  target: Target,
  kernel_revision: IDL.Nat64,
  content_tag: IDL.Vec(IDL.Nat8),
  body_bytes: IDL.Nat,
  geometry: StageGeometry,
  block_hashes: IDL.Vec(IDL.Vec(IDL.Nat8)),
});

const DeletedIdentity = IDL.Record({
  target: Target,
  kernel_revision: IDL.Nat64,
  prior_content_tag: IDL.Vec(IDL.Nat8),
});

const StageIdentity = IDL.Record({
  collection: IDL.Text,
  collection_generation: IDL.Nat64,
  computed_target: IDL.Opt(Target),
});

const BeginStageOk = IDL.Record({
  stage_id: IDL.Nat64,
  identity: StageIdentity,
  geometry: StageGeometry,
  expires_at_ns: IDL.Nat64,
});

const StageTerminal = IDL.Record({
  stage_id: IDL.Nat64,
  identity: StageIdentity,
  geometry: StageGeometry,
  terminal_at_ns: IDL.Nat64,
  reconcile_until_ns: IDL.Nat64,
});

const Lifecycle = IDL.Record({ committed: RecordIdentity });
const StageStatus = IDL.Variant({
  active: IDL.Record({
    stage_id: IDL.Nat64,
    identity: StageIdentity,
    geometry: StageGeometry,
    progress: IDL.Record({
      next_block_index: IDL.Nat32,
      block_hashes: IDL.Vec(IDL.Vec(IDL.Nat8)),
    }),
    raw_sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
    expires_at_ns: IDL.Nat64,
  }),
  consumed: IDL.Record({
    stage: StageTerminal,
    lifecycle: Lifecycle,
  }),
  aborted: StageTerminal,
  expired: StageTerminal,
  unknown: IDL.Null,
});

const ChunkOk = IDL.Record({
  stage_id: IDL.Nat64,
  index: IDL.Nat32,
  block_sha256: IDL.Vec(IDL.Nat8),
  accepted: IDL.Variant({ new: IDL.Null, replayed: IDL.Null }),
  complete: IDL.Bool,
  raw_sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
  computed_target: IDL.Opt(Target),
});

const OperationReceipt = IDL.Variant({
  put: IDL.Record({
    request_index: IDL.Nat32,
    lifecycle: Lifecycle,
  }),
  delete: IDL.Record({
    request_index: IDL.Nat32,
    identity: DeletedIdentity,
  }),
});

const BatchReceipt = IDL.Record({
  operations: IDL.Vec(OperationReceipt),
});

const RecordStatus = IDL.Variant({
  present: RecordIdentity,
  absent: IDL.Record({ collection_generation: IDL.Nat64 }),
  recently_deleted: DeletedIdentity,
  deleted_high_water: DeletedIdentity,
});

const Reclaimed = IDL.Record({
  records: IDL.Nat,
  bodies: IDL.Nat,
  body_bytes: IDL.Nat,
  charged_bytes: IDL.Nat,
  authenticated_nodes: IDL.Nat,
  receipts: IDL.Nat,
});

const MaintenancePage = IDL.Record({
  page: Reclaimed,
  has_more: IDL.Bool,
  remaining_jobs: IDL.Nat,
});

export const UsageCounters = IDL.Record({
  live_entries: IDL.Nat,
  occupied_entry_slots: IDL.Nat,
  committed_body_bytes: IDL.Nat,
  reserved_committed_body_bytes: IDL.Nat,
  allocated_body_bytes: IDL.Nat,
  charged_metadata_bytes: IDL.Nat,
  accepted_staged_bytes: IDL.Nat,
  reserved_staged_bytes: IDL.Nat,
  detached_charged_bytes: IDL.Nat,
  active_stages: IDL.Nat,
  reserved_entry_slots: IDL.Nat,
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

export const QualificationMethods = {
  qualification_scope_info: IDL.Func(
    [IDL.Null],
    [IDL.Variant({ ok: ScopeInfo, err: Error })],
    ["query"],
  ),
  qualification_begin_stage: IDL.Func(
    [
      IDL.Record({
        nonce: IDL.Vec(IDL.Nat8),
        target: StageTarget,
        expected_bytes: IDL.Nat,
      }),
    ],
    [IDL.Variant({ ok: BeginStageOk, err: Error })],
    [],
  ),
  qualification_put_chunk: IDL.Func(
    [
      IDL.Record({
        stage_id: IDL.Nat64,
        index: IDL.Nat32,
        body: IDL.Vec(IDL.Nat8),
      }),
    ],
    [IDL.Variant({ ok: ChunkOk, err: Error })],
    [],
  ),
  qualification_stage_status: IDL.Func(
    [IDL.Nat64],
    [IDL.Variant({ ok: StageStatus, err: Error })],
    ["query"],
  ),
  qualification_abort_stage: IDL.Func(
    [IDL.Nat64],
    [IDL.Variant({ ok: IDL.Null, err: Error })],
    [],
  ),
  qualification_commit_batch: IDL.Func(
    [CommitBatchInput],
    [IDL.Variant({ ok: BatchReceipt, err: Error })],
    [],
  ),
  qualification_record_status: IDL.Func(
    [Target],
    [IDL.Variant({ ok: RecordStatus, err: Error })],
    ["query"],
  ),
  qualification_maintenance_page: IDL.Func(
    [IDL.Null],
    [IDL.Variant({ ok: MaintenancePage, err: Error })],
    [],
  ),
  qualification_usage: IDL.Func(
    [IDL.Null],
    [IDL.Variant({ ok: Usage, err: Error })],
    ["query"],
  ),
} as const;

const ForestDiagnostics = IDL.Record({
  healthy: IDL.Bool,
  dirty: IDL.Bool,
  commit_sequence: IDL.Nat64,
  live_nodes: IDL.Nat,
  allocated_nodes: IDL.Nat,
  free_nodes: IDL.Nat,
  node_capacity: IDL.Nat,
  live_maps: IDL.Nat,
  allocated_maps: IDL.Nat,
  free_maps: IDL.Nat,
  map_capacity: IDL.Nat,
});

export const KernelDiagnosticsMethod = IDL.Func(
  [IDL.Null],
  [
    IDL.Record({
      implementation_binding: IDL.Record({
        allocator_layout_fingerprint: IDL.Vec(IDL.Nat8),
        response_policy_fingerprint: IDL.Vec(IDL.Nat8),
      }),
      allocator: IDL.Record({
        header_valid: IDL.Bool,
        mutation_epoch: IDL.Nat64,
        committed_high_water_bytes: IDL.Nat64,
        allocated_bytes: IDL.Nat64,
        allocated_extents: IDL.Nat,
        free_extents: IDL.Nat,
        descriptor_count: IDL.Nat,
        descriptor_limit: IDL.Nat,
        capacity_limit_bytes: IDL.Nat64,
        allocatable_limit_bytes: IDL.Nat64,
        allocatable_headroom_bytes: IDL.Nat64,
        metadata_charge_bytes: IDL.Nat,
      }),
      authenticated_forest: ForestDiagnostics,
      charging: IDL.Record({
        total_charged_bytes: IDL.Nat,
        total_installed_reservation_bytes: IDL.Nat,
        reserved_headroom_bytes: IDL.Nat,
        allocator_metadata_charge_bytes: IDL.Nat,
        envelope_used_bytes: IDL.Nat,
        envelope_limit_bytes: IDL.Nat,
        total_installed_arena_reservation_bytes: IDL.Nat,
        reserved_arena_headroom_bytes: IDL.Nat,
        arena_envelope_used_bytes: IDL.Nat,
        arena_envelope_limit_bytes: IDL.Nat,
        total_installed_arena_extent_reservation: IDL.Nat,
        reserved_arena_extent_headroom: IDL.Nat,
        arena_extent_envelope_used: IDL.Nat,
        arena_extent_envelope_limit: IDL.Nat,
      }),
    }),
  ],
  ["query"],
);

export const KernelAppUsageMethod = IDL.Func(
  [IDL.Null],
  [
    IDL.Record({
      snapshot_version: IDL.Nat,
      current_day: IDL.Nat64,
      apps: IDL.Vec(
        IDL.Record({
          app_id: IDL.Text,
          installation_uid: IDL.Nat64,
          lifetime_instructions: IDL.Nat64,
          lifetime_executions: IDL.Nat64,
          lifetime_outgoing_cycles: IDL.Nat,
          lifetime_incoming_cycles_accepted: IDL.Nat,
          window_instructions: IDL.Nat64,
          window_executions: IDL.Nat64,
          window_outgoing_cycles: IDL.Nat,
          window_incoming_cycles_accepted: IDL.Nat,
          days: IDL.Vec(
            IDL.Record({
              day: IDL.Nat64,
              instructions: IDL.Nat64,
              executions: IDL.Nat64,
              outgoing_cycles: IDL.Nat,
              incoming_cycles_accepted: IDL.Nat,
            }),
          ),
        }),
      ),
    }),
  ],
  ["query"],
);

const HttpHeaderField = IDL.Tuple(IDL.Text, IDL.Text);
const HttpStreamingToken = IDL.Record({
  key: IDL.Text,
  sha256: IDL.Opt(IDL.Vec(IDL.Nat8)),
  index: IDL.Nat,
  content_encoding: IDL.Text,
});
const HttpStreamingCallbackResponse = IDL.Record({
  token: IDL.Opt(HttpStreamingToken),
  body: IDL.Vec(IDL.Nat8),
});
const HttpStreamingStrategy = IDL.Variant({
  Callback: IDL.Record({
    token: HttpStreamingToken,
    callback: IDL.Func(
      [HttpStreamingToken],
      [HttpStreamingCallbackResponse],
      ["query"],
    ),
  }),
});

/**
 * Exact standard canister-HTTP query interface implemented by the Kernel.
 * Qualification uses this raw boundary instead of allowing a gateway to hide
 * an upgrade flag or streaming callback.
 */
export const HttpRequestMethod = IDL.Func(
  [
    IDL.Record({
      method: IDL.Text,
      url: IDL.Text,
      headers: IDL.Vec(HttpHeaderField),
      body: IDL.Vec(IDL.Nat8),
      certificate_version: IDL.Opt(IDL.Nat16),
    }),
  ],
  [
    IDL.Record({
      body: IDL.Vec(IDL.Nat8),
      headers: IDL.Vec(HttpHeaderField),
      streaming_strategy: IDL.Opt(HttpStreamingStrategy),
      status_code: IDL.Nat16,
      upgrade: IDL.Opt(IDL.Bool),
    }),
  ],
  ["query"],
);

export type QualificationMethodName = keyof typeof QualificationMethods;
