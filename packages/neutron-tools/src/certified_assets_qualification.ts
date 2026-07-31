import { sha256 } from "js-sha256";
import {
  assertSupportedCertificateVersions,
  assertSupportedCertificateVersionsMetadata,
  type SupportedCertificateVersionsMetadataV1,
} from "./wasm_metadata.js";

export const CERTIFIED_ASSETS_QUALIFICATION_SCHEMA =
  "neutron.kernel.certified-assets-qualification.v1" as const;
export const CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA =
  "neutron.kernel.certified-assets-candidate-binding.v3" as const;

export const CERTIFIED_ASSETS_COLLECTION_KINDS = [
  "publication",
  "immutable_blob",
  "mutable_blob",
] as const;

export type CertifiedAssetsCollectionKind =
  (typeof CERTIFIED_ASSETS_COLLECTION_KINDS)[number];

/**
 * One neutral plan exercises all three closed behaviors. Mutable blobs need
 * two collections because keyed and exact-path locators are intentionally
 * different closed forms of the same mutation policy.
 */
export const CERTIFIED_ASSETS_SYNTHETIC_PLAN = {
  schema: "neutron.kernel.certified-assets-synthetic-plan.v1",
  limits: {
    max_entries: 64,
    max_committed_bytes: 134_217_728,
    max_object_bytes: 67_108_864,
    max_pending_stages: 1,
    max_staged_bytes: 67_108_864,
    max_batch_operations: 16,
    max_batch_bytes: 67_108_864,
    max_idempotency_receipts: 128,
  },
  collections: [
    {
      id: "publication",
      mount: "download",
      kind: "publication",
      max_object_bytes: 67_108_864,
    },
    {
      id: "immutable",
      mount: "portable",
      kind: "immutable_blob",
      path_prefix: "/objects/",
      max_object_bytes: 1_048_576,
    },
    {
      id: "mutable_key",
      mount: "portable",
      kind: "mutable_blob",
      path_prefix: "/heads/",
      max_object_bytes: 1_048_576,
    },
    {
      id: "mutable_exact",
      mount: "portable",
      kind: "mutable_blob",
      exact_path: "/profile",
      max_object_bytes: 1_048_576,
    },
  ],
} as const;

export const CERTIFIED_ASSETS_SYNTHETIC_PLAN_SHA256 =
  certifiedAssetsCanonicalSha256(CERTIFIED_ASSETS_SYNTHETIC_PLAN);

export const CERTIFIED_ASSETS_METRIC_DEFINITIONS = [
  {
    metric: "request_candid_bytes",
    unit: "bytes",
    release_limit: "2000000",
    measurement:
      "largest exact encoded Candid request issued during one case sample",
  },
  {
    metric: "reply_candid_bytes",
    unit: "bytes",
    release_limit: "3145728",
    measurement:
      "largest exact encoded Candid reply received during one case sample",
  },
  {
    metric: "low_side_cycle_estimate",
    unit: "cycles",
    release_limit: "40000000000",
    measurement:
      "non-negative app-usage delta: instructions plus 5000000 cycles per execution plus lifetime outgoing cycles",
  },
  {
    metric: "allocator_high_water_growth_bytes",
    unit: "bytes",
    release_limit: "2147483648",
    measurement:
      "non-negative delta of the Certified Assets allocator committed high-water mark",
  },
  {
    metric: "proof_bytes",
    unit: "bytes",
    release_limit: "65536",
    measurement:
      "sum of decoded certificate CBOR, witness CBOR, and expression-path CBOR bytes on one certified HTTP response",
  },
] as const;

export type CertifiedAssetsMetricName =
  (typeof CERTIFIED_ASSETS_METRIC_DEFINITIONS)[number]["metric"];

const UPDATE_METRICS = [
  "request_candid_bytes",
  "reply_candid_bytes",
  "low_side_cycle_estimate",
  "allocator_high_water_growth_bytes",
] as const satisfies readonly CertifiedAssetsMetricName[];

const READ_METRICS = [
  "reply_candid_bytes",
  "proof_bytes",
] as const satisfies readonly CertifiedAssetsMetricName[];

const INTERNAL_METRICS = [
  "low_side_cycle_estimate",
  "allocator_high_water_growth_bytes",
] as const satisfies readonly CertifiedAssetsMetricName[];

export const CERTIFIED_ASSETS_QUALIFICATION_CASES = [
  {
    id: "publication_lifecycle",
    behavior: "publication",
    operation:
      "allocate, stage, retry a chunk, commit, GET, HEAD, range, and conditionally delete",
    checkpoints: [
      "stage_allocated",
      "chunk_replay_idempotent",
      "commit_present",
      "get_body_exact",
      "head_body_empty",
      "range_body_exact",
      "conditional_delete_absent",
    ],
    metrics: UPDATE_METRICS,
  },
  {
    id: "publication_certified_reads",
    behavior: "publication",
    operation:
      "verify host-bound 200, 206, HEAD, and current certified absence",
    checkpoints: [
      "host_bound_200",
      "host_bound_206",
      "host_bound_head",
      "current_absence",
    ],
    metrics: READ_METRICS,
  },
  {
    id: "immutable_inline_lifecycle",
    behavior: "immutable_blob",
    operation:
      "commit an inline digest-addressed body, replay idempotently, read, and delete conditionally",
    checkpoints: [
      "digest_derived",
      "commit_replay_idempotent",
      "portable_read_exact",
      "conditional_delete_absent",
    ],
    metrics: UPDATE_METRICS,
  },
  {
    id: "immutable_staged_lifecycle",
    behavior: "immutable_blob",
    operation:
      "stage a maximum portable body, commit its derived digest, read, and reject a mismatched digest",
    checkpoints: [
      "ordered_stage_complete",
      "digest_derived",
      "portable_read_exact",
      "mismatched_digest_rejected",
    ],
    metrics: UPDATE_METRICS,
  },
  {
    id: "mutable_key_cas",
    behavior: "mutable_blob_keyed",
    operation:
      "create, replace by exact revision/tag, reject stale CAS, read, and delete",
    checkpoints: [
      "create_absent",
      "replace_exact",
      "stale_cas_rejected",
      "portable_read_exact",
      "conditional_delete_absent",
    ],
    metrics: UPDATE_METRICS,
  },
  {
    id: "mutable_exact_cas",
    behavior: "mutable_blob_exact",
    operation:
      "create, replace by exact revision/tag, reject stale CAS, read, and delete",
    checkpoints: [
      "create_absent",
      "replace_exact",
      "stale_cas_rejected",
      "portable_read_exact",
      "conditional_delete_absent",
    ],
    metrics: UPDATE_METRICS,
  },
  {
    id: "portable_certified_reads",
    behavior: "portable",
    operation:
      "verify digest, CORS, membership, exact-path and wildcard-absence proofs",
    checkpoints: [
      "content_digest_exact",
      "cors_policy_exact",
      "membership_verified",
      "exact_absence_verified",
      "wildcard_absence_verified",
    ],
    metrics: READ_METRICS,
  },
  {
    id: "global_stage_admission",
    behavior: "actor_wide_admission",
    operation:
      "begin one stage in each of five neutral scopes, admit the first four, reject the fifth without state drift, then prove an aborted stage releases the shared slot",
    checkpoints: [
      "four_scopes_admitted",
      "fifth_scope_quota_rejected",
      "rejected_scope_unchanged",
      "released_slot_reused",
    ],
    metrics: UPDATE_METRICS,
  },
  {
    id: "scope_isolation",
    behavior: "scope_isolation",
    operation:
      "prove a foreign stage is hidden and immutable content committed in one neutral scope is absent and cannot be conditionally deleted through another",
    checkpoints: [
      "foreign_stage_hidden",
      "foreign_stage_mutation_rejected",
      "owning_scope_record_present",
      "same_locator_absent_in_other_scope",
      "foreign_identity_delete_rejected",
    ],
    metrics: UPDATE_METRICS,
  },
  {
    id: "idempotency_conflict",
    behavior: "all",
    operation:
      "replay an identical nonce and reject changed operations under that nonce",
    checkpoints: [
      "identical_replay_same_receipt",
      "changed_replay_rejected",
      "state_unchanged_after_conflict",
    ],
    metrics: UPDATE_METRICS,
  },
  {
    id: "logical_quota_rejection",
    behavior: "all",
    operation:
      "reach the entry, committed-byte, pending-stage, and receipt quotas and reject the first operation beyond each without state drift",
    checkpoints: [
      "entry_quota_rejected",
      "committed_byte_quota_rejected",
      "stage_quota_rejected",
      "receipt_quota_rejected",
      "state_unchanged_after_rejection",
    ],
    metrics: INTERNAL_METRICS,
  },
  {
    id: "allocator_churn",
    behavior: "all",
    operation:
      "repeat fixed-size CAS replacement and reclamation cycles; prove exact live body allocation and allocator high-water plateau, bounded free-list descriptors, authenticated forest usage plateau, and exactly one retained charged receipt per nonexpired round",
    checkpoints: [
      "body_allocation_plateau",
      "receipt_retention_exact",
      "allocator_high_water_plateau",
      "allocator_descriptor_bound",
      "authenticated_node_plateau",
    ],
    metrics: INTERNAL_METRICS,
  },
] as const;

export type CertifiedAssetsQualificationCaseId =
  (typeof CERTIFIED_ASSETS_QUALIFICATION_CASES)[number]["id"];

export const CERTIFIED_ASSETS_ENVIRONMENT_CHECKS = [
  "gateway_publication_range_reassembly",
  "gateway_browser_cors_body_delivery",
] as const;

export type CertifiedAssetsEnvironmentCheckId =
  (typeof CERTIFIED_ASSETS_ENVIRONMENT_CHECKS)[number];

export const CERTIFIED_ASSETS_QUALIFICATION_CONTRACT = {
  schema: CERTIFIED_ASSETS_QUALIFICATION_SCHEMA,
  synthetic_plan: CERTIFIED_ASSETS_SYNTHETIC_PLAN,
  cases: CERTIFIED_ASSETS_QUALIFICATION_CASES,
  metrics: CERTIFIED_ASSETS_METRIC_DEFINITIONS,
  environment_checks: CERTIFIED_ASSETS_ENVIRONMENT_CHECKS,
  minimum_samples_per_case: 1,
  workload: {
    schema: "neutron.kernel.certified-assets-workload.v1",
    seed_domain: "neutron.kernel.certified-assets-workload.v1",
    derivation:
      "sha256(domain_nul_case_id_nul_sample_u32be_nul_step_u32be_nul_block_u32be)",
    nonce_bytes: 16,
    keyed_locator_bytes: 32,
    publication_body_bytes: 67_108_864,
    portable_body_bytes: 1_048_576,
    churn_body_bytes: 65_536,
    churn_warmup_rounds: 1,
    churn_measured_rounds: 3,
    churn_receipt_growth: {
      receipts_per_round: 1,
      charged_metadata_bytes_per_round: 1_024,
    },
    measurement:
      "one clean canister per sample; usage and allocator snapshots bracket the case; Candid byte metrics are the largest exact request and reply in the bracket",
  },
  certification: {
    section_name: "icp:public supported_certificate_versions",
    section_count: 1,
    value: "2",
  },
} as const;

export const CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256 =
  certifiedAssetsCanonicalSha256(CERTIFIED_ASSETS_QUALIFICATION_CONTRACT);

export type CertifiedAssetsCandidateBinding = Readonly<{
  schema: typeof CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA;
  qualification_contract_sha256: string;
  synthetic_plan_sha256: string;
  qualification_profile_sha256: string;
  implementation_fingerprint_sha256: string;
  compiler_source_fingerprint_sha256: string;
  compiler_id: string;
  assembler_id: string;
  synthetic_actor_source_sha256: string;
  synthetic_actor_manifest_set_sha256: string;
  qualification_runner_source_sha256: string;
  motoko_package_source_set_sha256: string;
  qualified_raw_wasm_sha256: string;
  qualified_transport_wasm_sha256: string;
  package_lock_sha256: string;
  supported_certificate_versions: SupportedCertificateVersionsMetadataV1;
}>;

export function assertFinalAssembledWasmCertification(
  wasm: Uint8Array,
): SupportedCertificateVersionsMetadataV1 {
  return assertSupportedCertificateVersions(wasm);
}

export function assertCertifiedAssetsCandidateBinding(
  value: unknown,
  label = "Certified Assets qualification candidate",
): CertifiedAssetsCandidateBinding {
  const binding = record(value, label);
  exactKeys(
    binding,
    [
      "schema",
      "qualification_contract_sha256",
      "synthetic_plan_sha256",
      "qualification_profile_sha256",
      "implementation_fingerprint_sha256",
      "compiler_source_fingerprint_sha256",
      "compiler_id",
      "assembler_id",
      "synthetic_actor_source_sha256",
      "synthetic_actor_manifest_set_sha256",
      "qualification_runner_source_sha256",
      "motoko_package_source_set_sha256",
      "qualified_raw_wasm_sha256",
      "qualified_transport_wasm_sha256",
      "package_lock_sha256",
      "supported_certificate_versions",
    ],
    label,
  );
  if (binding.schema !== CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA) {
    throw new Error(`${label}.schema is invalid`);
  }
  const implementationFingerprint = digest(
    binding.implementation_fingerprint_sha256,
    `${label}.implementation_fingerprint_sha256`,
  );
  const qualificationProfile = digest(
    binding.qualification_profile_sha256,
    `${label}.qualification_profile_sha256`,
  );
  const compilerSourceFingerprint = digest(
    binding.compiler_source_fingerprint_sha256,
    `${label}.compiler_source_fingerprint_sha256`,
  );
  const compilerId = boundedIdentifier(
    binding.compiler_id,
    `${label}.compiler_id`,
  );
  const assemblerId = boundedIdentifier(
    binding.assembler_id,
    `${label}.assembler_id`,
  );
  const syntheticActorSource = digest(
    binding.synthetic_actor_source_sha256,
    `${label}.synthetic_actor_source_sha256`,
  );
  const syntheticActorManifestSet = digest(
    binding.synthetic_actor_manifest_set_sha256,
    `${label}.synthetic_actor_manifest_set_sha256`,
  );
  const qualificationRunnerSource = digest(
    binding.qualification_runner_source_sha256,
    `${label}.qualification_runner_source_sha256`,
  );
  const motokoPackageSourceSet = digest(
    binding.motoko_package_source_set_sha256,
    `${label}.motoko_package_source_set_sha256`,
  );
  const qualifiedRawWasm = digest(
    binding.qualified_raw_wasm_sha256,
    `${label}.qualified_raw_wasm_sha256`,
  );
  const qualifiedTransportWasm = digest(
    binding.qualified_transport_wasm_sha256,
    `${label}.qualified_transport_wasm_sha256`,
  );
  const packageLock = digest(
    binding.package_lock_sha256,
    `${label}.package_lock_sha256`,
  );
  digest(
    binding.qualification_contract_sha256,
    `${label}.qualification_contract_sha256`,
  );
  digest(
    binding.synthetic_plan_sha256,
    `${label}.synthetic_plan_sha256`,
  );
  if (
    binding.qualification_contract_sha256 !==
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256
  ) {
    throw new Error(`${label} does not bind the current qualification contract`);
  }
  if (
    binding.synthetic_plan_sha256 !==
    CERTIFIED_ASSETS_SYNTHETIC_PLAN_SHA256
  ) {
    throw new Error(`${label} does not bind the current synthetic plan`);
  }
  const supported = assertSupportedCertificateVersionsMetadata(
    binding.supported_certificate_versions,
    `${label}.supported_certificate_versions`,
  );
  return {
    schema: CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA,
    qualification_contract_sha256:
      binding.qualification_contract_sha256,
    synthetic_plan_sha256: binding.synthetic_plan_sha256,
    qualification_profile_sha256: qualificationProfile,
    implementation_fingerprint_sha256:
      implementationFingerprint,
    compiler_source_fingerprint_sha256:
      compilerSourceFingerprint,
    compiler_id: compilerId,
    assembler_id: assemblerId,
    synthetic_actor_source_sha256:
      syntheticActorSource,
    synthetic_actor_manifest_set_sha256:
      syntheticActorManifestSet,
    qualification_runner_source_sha256:
      qualificationRunnerSource,
    motoko_package_source_set_sha256:
      motokoPackageSourceSet,
    qualified_raw_wasm_sha256:
      qualifiedRawWasm,
    qualified_transport_wasm_sha256:
      qualifiedTransportWasm,
    package_lock_sha256: packageLock,
    supported_certificate_versions: supported,
  };
}

export function certifiedAssetsCanonicalSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[a-zA-Z0-9._-]+$/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical evidence accepts only safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical evidence contains an unsupported value");
}
