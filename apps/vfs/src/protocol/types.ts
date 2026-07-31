import type {
  JsonObject,
  JsonValue,
  SelfCallObject,
} from "neutron-tools/app";

declare const canonicalNat64Brand: unique symbol;
declare const filesId128KeyBrand: unique symbol;

export type CanonicalNat64 = string & {
  readonly [canonicalNat64Brand]: true;
};

export type FilesId128Key = string & {
  readonly [filesId128KeyBrand]: true;
};

export type FilesId128V2 = Readonly<{
  hi: CanonicalNat64;
  lo: CanonicalNat64;
}>;

export type FilesDigest256V2 = Readonly<{
  a: CanonicalNat64;
  b: CanonicalNat64;
  c: CanonicalNat64;
  d: CanonicalNat64;
}>;

export type FilesEmptyRequestV2 = Record<string, never>;
export type FilesNormalizedRequestV2 = SelfCallObject;

export type FilesOptionalVariantV2<
  Tag extends string,
  Payload extends JsonValue = JsonValue,
> = null | Readonly<Record<Tag, Payload>>;

export type FilesRejectionReasonV2 =
  | "not_ready"
  | "invalid_request"
  | "not_found"
  | "not_file"
  | "not_folder"
  | "invalid_index"
  | "already_exists"
  | "stale_revision"
  | "stale_content"
  | "cursor_stale"
  | "id_collision"
  | "batch_structure_limit"
  | "conflict"
  | "quota"
  | "busy"
  | "aborted"
  | "expired"
  | "superseded"
  | "temporarily_unavailable"
  | "incompatible"
  | "corrupt_state";

export type FilesRejectedV2 = Readonly<{
  reason: null | Readonly<{ tag: FilesRejectionReasonV2; value: JsonValue }>;
  retryAfterNs: CanonicalNat64 | null;
  raw: JsonObject;
}>;

export type FilesOutcomeV2<T extends JsonValue = JsonValue> =
  | Readonly<{ kind: "ok"; value: T }>
  | Readonly<{ kind: "rejected"; rejection: FilesRejectedV2 }>
  | Readonly<{ kind: "unsupported" }>;

export type FilesAttachmentOutcomeV2<T extends JsonValue = JsonValue> =
  FilesOutcomeV2<T> & Readonly<{ body: ArrayBuffer }>;

export type FilesReadChunkRequestV2 = Readonly<{
  node_id: FilesId128V2;
  structural_revision: CanonicalNat64;
  content_id: FilesId128V2;
  index: number;
}>;

export type FilesReadFrameKindV2 = "first" | "continuation";

export type FilesReadChunkOkV2 = Readonly<{
  nodeId: FilesId128V2;
  structuralRevision: CanonicalNat64;
  metadataRevision: CanonicalNat64;
  contentId: FilesId128V2;
  index: number;
  blockCount: number;
  ciphertextBlockBytes: number;
  ciphertextTotalBytes: CanonicalNat64;
  frameKind: FilesReadFrameKindV2;
}>;

export type FilesReadChunkRejectionCodeV2 = FilesRejectionReasonV2;

export type FilesReadChunkOutcomeV2 =
  | Readonly<{ kind: "ok"; value: FilesReadChunkOkV2; body: ArrayBuffer }>
  | Readonly<{
      kind: "rejected";
      reason: FilesReadChunkRejectionCodeV2 | null;
      retryAfterNs: CanonicalNat64 | null;
      body: ArrayBuffer;
    }>
  | Readonly<{ kind: "unsupported"; body: ArrayBuffer }>;

export type FilesTransportResponseV2 = Readonly<{
  value: JsonValue;
  body?: ArrayBuffer;
}>;

export type FilesUnitVariantV2<Tag extends string> =
  Readonly<Record<Tag, null>>;

export type FilesNodeKindV2 =
  | FilesUnitVariantV2<"folder">
  | FilesUnitVariantV2<"file">;

export type FilesCleanupStateV2 =
  | FilesUnitVariantV2<"clean">
  | Readonly<{ pending: { remaining_jobs: number } }>;

export type FilesContentDescriptorV2 = Readonly<{
  content_id: FilesId128V2;
  block_count: number;
  ciphertext_bytes: CanonicalNat64;
  crypto_profile: null | FilesUnitVariantV2<"aes_256_gcm_files_v2">;
}>;

export type FilesNodeBindingV2 = Readonly<{
  node_id: FilesId128V2;
  parent_id: FilesId128V2;
  kind: null | FilesNodeKindV2;
  structural_revision: CanonicalNat64;
  metadata_revision: CanonicalNat64;
  children_revision: CanonicalNat64;
  declared_name_scalars: number;
  subtree_height: number;
  max_relative_path_scalars: number;
  subtree_plaintext_bytes: CanonicalNat64;
  encrypted_metadata_bytes: number;
  active: boolean;
}>;

export type FilesQuotaSnapshotV2 = Readonly<{
  nodes: CanonicalNat64;
  committed_private_plaintext_bytes: CanonicalNat64;
  committed_ciphertext_bytes: CanonicalNat64;
  staged_ciphertext_bytes: CanonicalNat64;
  physical_private_bytes: CanonicalNat64;
  cleanup_jobs: number;
}>;

export type FilesPublicUsageCountersV2 = Readonly<{
  live_entries: CanonicalNat64;
  occupied_entry_slots: CanonicalNat64;
  committed_body_bytes: CanonicalNat64;
  reserved_committed_body_bytes: CanonicalNat64;
  reserved_entry_slots: CanonicalNat64;
  allocated_body_bytes: CanonicalNat64;
  charged_metadata_bytes: CanonicalNat64;
  accepted_staged_bytes: CanonicalNat64;
  reserved_staged_bytes: CanonicalNat64;
  detached_charged_bytes: CanonicalNat64;
  active_stages: CanonicalNat64;
  receipt_lanes: CanonicalNat64;
  general_receipt_lanes: CanonicalNat64;
  reserved_general_receipt_lanes: CanonicalNat64;
  reserved_revocation_lanes: CanonicalNat64;
  filled_revocation_lanes: CanonicalNat64;
  receipt_nonce_indexes: CanonicalNat64;
  receipt_expiry_indexes: CanonicalNat64;
  cleanup_jobs: CanonicalNat64;
}>;

export type FilesPublicUsageLimitsV2 = Readonly<{
  entries: CanonicalNat64;
  committed_bytes: CanonicalNat64;
  object_bytes: CanonicalNat64;
  staged_bytes: CanonicalNat64;
  pending_stages: CanonicalNat64;
  batch_operations: CanonicalNat64;
  batch_bytes: CanonicalNat64;
  general_receipts: CanonicalNat64;
  revocation_lanes: CanonicalNat64;
}>;

export type FilesPublicUsageV2 = Readonly<{
  current: FilesPublicUsageCountersV2;
  manifest_limits: FilesPublicUsageLimitsV2;
  effective_limits: FilesPublicUsageLimitsV2;
}>;

export type FilesCleanupSummaryV2 = Readonly<{
  remaining_jobs: number;
  has_more: boolean;
  state: null | FilesCleanupStateV2;
}>;

export type FilesOperationKindV2 =
  | FilesUnitVariantV2<"vault">
  | FilesUnitVariantV2<"private_write">
  | FilesUnitVariantV2<"mutation">
  | FilesUnitVariantV2<"remove">
  | FilesUnitVariantV2<"abort">;

export type FilesOperationSummaryV2 = Readonly<{
  request_id: FilesId128V2;
  kind: null | FilesOperationKindV2;
  stage_id: CanonicalNat64 | null;
  expires_at_ns: CanonicalNat64 | null;
  target: FilesOperationTargetV2 | null;
}>;

export type FilesVaultStateV2 =
  | FilesUnitVariantV2<"absent">
  | Readonly<{
      present: {
        format: number;
        record_revision: CanonicalNat64;
        slot_generation: CanonicalNat64;
        public_key_fingerprint: FilesDigest256V2;
        wrapper_frame_bytes: number;
      };
    }>;

export type FilesBootstrapRequestV2 = FilesEmptyRequestV2;

export type FilesBootstrapOkV2 = Readonly<{
  vault: null | FilesVaultStateV2;
  quota: FilesQuotaSnapshotV2;
  public_usage: FilesPublicUsageV2;
  cleanup: FilesCleanupSummaryV2;
  active_operations: FilesOperationSummaryV2[];
  body_bytes: number;
}>;

export type FilesListCursorV2 = Readonly<{
  parent_id: FilesId128V2;
  children_revision: CanonicalNat64;
  last_name_tag: FilesDigest256V2;
}>;

export type FilesListRequestV2 = Readonly<{
  parent_id: FilesId128V2;
  expected_structural_revision: CanonicalNat64 | null;
  cursor: FilesListCursorV2 | null;
  limit: number;
}>;

export type FilesListOkV2 = Readonly<{
  parent_id: FilesId128V2;
  structural_revision: CanonicalNat64;
  children_revision: CanonicalNat64;
  total_children: number;
  loaded_count: number;
  next_cursor: FilesListCursorV2 | null;
  has_more: boolean;
  body_bytes: number;
}>;

export type FilesLookupLocatorV2 =
  | Readonly<{ node: { node_id: FilesId128V2 } }>
  | Readonly<{
      child: {
        parent_id: FilesId128V2;
        expected_children_revision: CanonicalNat64 | null;
      };
    }>;

export type FilesLookupRequestV2 = Readonly<{
  locator: FilesLookupLocatorV2 | null;
  body: Uint8Array;
}>;

export type FilesLookupOkV2 = Readonly<{
  node: FilesNodeBindingV2;
  content: FilesContentDescriptorV2 | null;
  body_bytes: number;
}>;

export type FilesOperationWriteTargetNodeV2 = Readonly<{
  node_id: FilesId128V2;
  content_id: FilesId128V2 | null;
}>;

export type FilesOperationTargetV2 =
  | Readonly<{
      vault: { expected_record_revision: CanonicalNat64 | null };
    }>
  | Readonly<{
      private_write: {
        nodes: FilesOperationWriteTargetNodeV2[];
      };
    }>
  | Readonly<{ mutation: { node_id: FilesId128V2 } }>
  | Readonly<{ remove: { node_id: FilesId128V2 } }>
  | Readonly<{
      abort: {
        stage_id: CanonicalNat64;
      };
    }>;

export type FilesOperationStatusRequestV2 = Readonly<{
  request_id: FilesId128V2;
  target: FilesOperationTargetV2 | null;
}>;

export type FilesFrameBlockMappingV2 = Readonly<{
  frame_ordinal: number;
  content_id: FilesId128V2;
  block_index: number;
}>;

export type FilesCommittedNodeV2 = Readonly<{
  node_id: FilesId128V2;
  content_id: FilesId128V2 | null;
  structural_revision: CanonicalNat64;
  metadata_revision: CanonicalNat64;
}>;

export type FilesCommittedDetailV2 =
  | Readonly<{ vault: FilesVaultWriteOkV2 }>
  | Readonly<{ private_write: FilesWriteBlockOkV2 }>
  | Readonly<{ mutation: FilesMutateOkV2 }>
  | Readonly<{ remove: FilesRemoveOkV2 }>
  | Readonly<{ abort: FilesAbortOkV2 }>;

export type FilesOperationStateV2 =
  | Readonly<{
      active: {
        stage_id: CanonicalNat64 | null;
        accepted_frames_bitmap: number;
        frame_block_mapping: FilesFrameBlockMappingV2[];
        staged_bytes: CanonicalNat64;
        expires_at_ns: CanonicalNat64 | null;
      };
    }>
  | Readonly<{
      committed: {
        detail: FilesCommittedDetailV2 | null;
      };
    }>
  | Readonly<{
      aborted: {
        terminal_at_ns: CanonicalNat64;
        reconcile_until_ns: CanonicalNat64;
      };
    }>
  | Readonly<{
      expired: {
        terminal_at_ns: CanonicalNat64;
        reconcile_until_ns: CanonicalNat64;
      };
    }>
  | Readonly<{ superseded: { revision: CanonicalNat64 | null } }>
  | FilesUnitVariantV2<"unknown">;

export type FilesOperationStatusOkV2 = Readonly<{
  request_id: FilesId128V2;
  target: FilesOperationTargetV2 | null;
  state: FilesOperationStateV2 | null;
  cleanup_state: FilesCleanupStateV2 | null;
}>;

export type FilesVaultWriteRequestV2 = Readonly<{
  request_id: FilesId128V2;
  operation:
    | FilesUnitVariantV2<"initialize">
    | FilesUnitVariantV2<"rewrap">
    | null;
  expected_record_revision: CanonicalNat64 | null;
  proposed_record_revision: CanonicalNat64;
  body_bytes: number;
  body: Uint8Array;
}>;

export type FilesVaultWriteOkV2 = Readonly<{
  request_id: FilesId128V2;
  record_revision: CanonicalNat64;
  initialized: boolean;
}>;

export type FilesWriteBlockRequestV2 = Readonly<{
  request_id: FilesId128V2;
  stage_id: CanonicalNat64 | null;
  frame_ordinal: number;
  final: boolean;
  body_bytes: number;
  body: Uint8Array;
}>;

export type FilesWriteBlockOkV2 = Readonly<{
  request_id: FilesId128V2;
  stage_id: CanonicalNat64 | null;
  frame_ordinal: number;
  accepted_frames_bitmap: number;
  committed_nodes: FilesCommittedNodeV2[];
  cleanup_state: FilesCleanupStateV2 | null;
}>;

export type FilesMutateRequestV2 = Readonly<{
  request_id: FilesId128V2;
  action:
    | FilesUnitVariantV2<"create_folder">
    | FilesUnitVariantV2<"rename">
    | FilesUnitVariantV2<"move">
    | null;
  body_bytes: number;
  body: Uint8Array;
}>;

export type FilesMutateOkV2 = Readonly<{
  request_id: FilesId128V2;
  node_id: FilesId128V2;
  parent_id: FilesId128V2;
  structural_revision: CanonicalNat64;
  metadata_revision: CanonicalNat64;
}>;

export type FilesRemoveRequestV2 = Readonly<{
  request_id: FilesId128V2;
  node_id: FilesId128V2;
  expected_structural_revision: CanonicalNat64;
  expected_parent_id: FilesId128V2;
  expected_parent_children_revision: CanonicalNat64;
  recursive: boolean;
}>;

export type FilesRemoveOkV2 = Readonly<{
  request_id: FilesId128V2;
  node_id: FilesId128V2;
  detached_plaintext_bytes: CanonicalNat64;
  reclaimed_entries: number;
  reclaimed_ciphertext_bytes: CanonicalNat64;
  cleanup_state: FilesCleanupStateV2 | null;
}>;

export type FilesAbortRequestV2 = Readonly<{
  request_id: FilesId128V2;
  stage_id: CanonicalNat64;
}>;

export type FilesAbortOkV2 = Readonly<{
  request_id: FilesId128V2;
  stage_id: CanonicalNat64;
  cleanup_state: FilesCleanupStateV2 | null;
}>;

export type FilesCleanupRequestV2 = FilesEmptyRequestV2;

export type FilesCleanupOkV2 = Readonly<{
  reclaimed_entries: number;
  reclaimed_ciphertext_bytes: CanonicalNat64;
  reclaimed_charged_bytes: CanonicalNat64;
  remaining_jobs: number;
  has_more: boolean;
}>;
