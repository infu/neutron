import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import { compilerSourceFingerprint } from "neutron-provision/src/compiler_fingerprint.js";
import {
  CERTIFIED_ASSETS_MAX_ENTRIES,
} from "neutron-tools/src/capabilities/catalog.js";
import {
  POCKET_IC_ARTIFACTS,
  POCKET_IC_SERVER_VERSION,
} from "neutron-provision/src/pocketic_binary.js";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  CERTIFIED_ASSETS_QUALIFICATION_CASES,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
  CERTIFIED_ASSETS_METRIC_DEFINITIONS,
  assertCertifiedAssetsCandidateBinding,
  type CertifiedAssetsCandidateBinding,
  type CertifiedAssetsMetricName,
  type CertifiedAssetsQualificationCaseId,
} from "neutron-tools/src/certified_assets_qualification.js";
import {
  buildCertifiedAssetsCandidateBindingInput,
} from "../certified_assets_candidate_binding.ts";
import {
  CERTIFIED_ASSETS_BROWSER_CORS_SCHEMA,
  type CertifiedAssetsBrowserCorsEvidence,
} from "./browser_cors.ts";
import {
  QUALIFICATION_INITIAL_TIME_NS,
} from "./environment.ts";
import {
  CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
  CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS,
  PHYSICAL_ABSENCE_WITNESS_CANDIDATES,
  PHYSICAL_POPULATION_BATCHES,
  PHYSICAL_POPULATION_APP_ID,
  PHYSICAL_POPULATION_ENTRIES,
  PHYSICAL_POPULATION_FINAL_USAGE,
  PHYSICAL_POPULATION_RECEIPT_LIMIT,
  PHYSICAL_POPULATION_ROUTE_PREFIX,
  PHYSICAL_PRESENT_WITNESS_CANDIDATES,
  physicalReceiptReclaimedChargedBytes,
  physicalPopulationReceiptRollovers,
  type PhysicalPopulationUsageExpectation,
} from "./physical_population.ts";

export const CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA =
  "neutron.kernel.certified-assets-qualification-receipt.v3" as const;
export const CERTIFIED_ASSETS_QUALIFICATION_SAMPLE_SCHEMA =
  "neutron.kernel.certified-assets-qualification-sample.v1" as const;
export const CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA =
  "neutron.kernel.certified-assets-raw-candid.v1" as const;
export const CERTIFIED_ASSETS_HTTP_OBSERVATION_SCHEMA =
  "neutron.kernel.certified-assets-http-v2.v1" as const;
export const CERTIFIED_ASSETS_BOUNDED_PHYSICAL_OBSERVATION_SCHEMA =
  "neutron.kernel.certified-assets-bounded-physical-sample.v1" as const;
export const CERTIFIED_ASSETS_QUALIFICATION_GATES_SCHEMA =
  "neutron.kernel.certified-assets-qualification-gates.v1" as const;
export const CERTIFIED_ASSETS_MOTOKO_GATES_SCHEMA =
  "neutron.kernel.certified-assets-motoko-gates.v2" as const;
export const CERTIFIED_ASSETS_UPGRADE_GATE_SCHEMA =
  "neutron.kernel.certified-assets-upgrade-gate.v1" as const;
export const CERTIFIED_ASSETS_HOSTILE_HTTP_GATE_SCHEMA =
  "neutron.kernel.certified-assets-hostile-http-gate.v1" as const;
export const CERTIFIED_ASSETS_ONE_OVER_GATE_SCHEMA =
  "neutron.kernel.certified-assets-one-over-gate.v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/u;
const WASMTIME_VERSION_PATTERN =
  /^wasmtime [0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const MAX_CANDID_OBSERVATIONS_PER_SAMPLE = 256;
const MAX_HTTP_OBSERVATIONS_PER_SAMPLE = 96;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_TRANSCRIPT_BYTES = 128 * 1024;
const MAX_HEADER_VALUE_BYTES = 96 * 1024;
const MAX_CANDID_REQUEST_BYTES = metricReleaseLimit("request_candid_bytes");
const MAX_CANDID_REPLY_BYTES = metricReleaseLimit("reply_candid_bytes");
const MAX_PROOF_BYTES = metricReleaseLimit("proof_bytes");
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../../..");
const PINNED_POCKET_IC_BINARY_SHA256 = new Set(
  POCKET_IC_ARTIFACTS.map(({ binarySha256 }) => binarySha256),
);
const FOCUSED_MOTOKO_TESTS = [
  "apps/kernel/test/motoko/authenticated_forest_test.mo",
  "apps/kernel/test/motoko/certified_assets_allocator_test.mo",
  "apps/kernel/test/motoko/certified_assets_service_test.mo",
] as const;
const FOCUSED_MOTOKO_PASS_LINES = [
  "Motoko test passed: authenticated_forest_test.mo",
  "Motoko test passed: certified_assets_allocator_test.mo",
  "Motoko test passed: certified_assets_service_test.mo",
] as const;
const BROWSER_CERTIFIED_HEADERS = [
  "ic-certificate",
  "ic-certificateexpression",
  "content-length",
  "content-digest",
  "etag",
] as const;
const BROWSER_VISIBLE_CERTIFIED_HEADERS = new Set(["content-length"]);
const PHYSICAL_USAGE_METHOD = physicalAppMethodName(
  PHYSICAL_POPULATION_APP_ID,
  "qualification_usage",
);
const PHYSICAL_COMMIT_METHOD = physicalAppMethodName(
  PHYSICAL_POPULATION_APP_ID,
  "qualification_commit_batch",
);
const PHYSICAL_MAINTENANCE_METHOD = physicalAppMethodName(
  PHYSICAL_POPULATION_APP_ID,
  "qualification_maintenance_page",
);
const UPGRADE_RECORD_STATUS_METHOD = physicalAppMethodName(
  "ca_qualification_aux_1",
  "qualification_record_status",
);

export type RawCandidObservation = Readonly<{
  schema: typeof CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA;
  mode: "query" | "update";
  method: string;
  request: ExactBytes;
  reply: ExactBytes;
}>;

export type CertifiedHttpObservation = Readonly<{
  schema: typeof CERTIFIED_ASSETS_HTTP_OBSERVATION_SCHEMA;
  boundary: "raw_query" | "gateway";
  method: "GET" | "HEAD";
  url: string;
  status: 200 | 206 | 404;
  request_headers: readonly (readonly [string, string])[];
  response_headers: readonly (readonly [string, string])[];
  body: ExactBytes;
  certificate: ExactBytes;
  witness: ExactBytes;
  expression_path: ExactBytes;
  certificate_time_ns: string;
}>;

export type ExactBytes = Readonly<{
  bytes: number;
  sha256: string;
}>;

export type QualificationSample = Readonly<{
  schema: typeof CERTIFIED_ASSETS_QUALIFICATION_SAMPLE_SCHEMA;
  case_id: CertifiedAssetsQualificationCaseId;
  sample: number;
  canister_id: string;
  installed_transport_wasm_sha256: string;
  checkpoints: readonly string[];
  metrics: Readonly<Partial<Record<CertifiedAssetsMetricName, string>>>;
  candid: readonly RawCandidObservation[];
  http: readonly CertifiedHttpObservation[];
}>;

export type BoundedPhysicalObservation = Readonly<{
  schema: typeof CERTIFIED_ASSETS_BOUNDED_PHYSICAL_OBSERVATION_SCHEMA;
  canister_id: string;
  installed_transport_wasm_sha256: string;
  batch_count: number;
  batch_transcript_sha256: string;
  final_entry_count: number;
  receipt_rollovers: readonly PhysicalReceiptRolloverObservation[];
  usage_before_overflow: RawCandidObservation;
  usage_before_overflow_decoded: PhysicalUsageSummary;
  overflow_call: RawCandidObservation;
  usage_after_overflow: RawCandidObservation;
  usage_after_overflow_decoded: PhysicalUsageSummary;
  overflow_checkpoint: "entry_quota_rejected_without_state_drift";
  present_candidates_queried: number;
  present_candidate_observations: readonly CertifiedHttpObservation[];
  present: CertifiedHttpObservation;
  present_proof_bytes: string;
  absence_candidates_queried: number;
  absence_candidate_observations: readonly CertifiedHttpObservation[];
  absence: CertifiedHttpObservation;
  absence_proof_bytes: string;
}>;

export type PhysicalUsageSummary = Readonly<{
  [Key in keyof PhysicalPopulationUsageExpectation]: string;
}>;

export type PhysicalMaintenancePageObservation = Readonly<{
  page_index: number;
  call: RawCandidObservation;
  reclaimed: Readonly<{
    records: string;
    bodies: string;
    body_bytes: string;
    charged_bytes: string;
    authenticated_nodes: string;
    receipts: string;
  }>;
  has_more: boolean;
  remaining_jobs: string;
}>;

export type PhysicalReceiptRolloverObservation = Readonly<{
  after_batch_count: number;
  clock: Readonly<{
    before_ns: string;
    requested_delta_ns: string;
    after_ns: string;
  }>;
  usage_before: RawCandidObservation;
  usage_before_decoded: PhysicalUsageSummary;
  maintenance_pages: readonly PhysicalMaintenancePageObservation[];
  usage_after: RawCandidObservation;
  usage_after_decoded: PhysicalUsageSummary;
  reclaimed_receipts_total: string;
  checkpoint: "general_receipt_ceiling_reclaimed";
}>;

export type FocusedMotokoGateObservation = Readonly<{
  schema: typeof CERTIFIED_ASSETS_MOTOKO_GATES_SCHEMA;
  wasmtime: Readonly<{
    version: string;
    binary: ExactBytes;
  }>;
  test_files: readonly Readonly<{
    path: (typeof FOCUSED_MOTOKO_TESTS)[number];
    source_sha256: string;
  }>[];
  expected_pass_lines: typeof FOCUSED_MOTOKO_PASS_LINES;
  stdout: ExactBytes;
}>;

export type SameWasmUpgradeGateObservation = Readonly<{
  schema: typeof CERTIFIED_ASSETS_UPGRADE_GATE_SCHEMA;
  canister_id: string;
  status_before: "running";
  canister_version_before: string;
  controllers_before: readonly string[];
  installed_transport_wasm_sha256_before: string;
  upgrade_call: RawCandidObservation;
  status_after: "running";
  canister_version_after: string;
  controllers_after: readonly string[];
  installed_transport_wasm_sha256_after: string;
  record_status_before: RawCandidObservation;
  record_status_after: RawCandidObservation;
  certified_read_before: CertifiedHttpObservation;
  certified_read_after: CertifiedHttpObservation;
}>;

export type HostileRawHttpGateObservation = Readonly<{
  schema: typeof CERTIFIED_ASSETS_HOSTILE_HTTP_GATE_SCHEMA;
  canister_id: string;
  installed_transport_wasm_sha256: string;
  call: RawCandidObservation;
  url: string;
  request_headers: readonly (readonly [string, string])[];
  status_code: 400;
  response_headers: readonly (readonly [string, string])[];
  body: ExactBytes;
  streaming_strategy_entries: 0;
  upgrade_entries: 0;
}>;

export type PhysicalOneOverGateObservation = Readonly<{
  schema: typeof CERTIFIED_ASSETS_ONE_OVER_GATE_SCHEMA;
  attempted_entries: 100_001;
  maximum_entries: 100_000;
  manifest: ExactBytes;
  validation_error: Readonly<{
    instance_path: string;
    schema_path: string;
    keyword: "maximum";
    canonical_sha256: string;
  }>;
}>;

export type QualificationGateObservations = Readonly<{
  schema: typeof CERTIFIED_ASSETS_QUALIFICATION_GATES_SCHEMA;
  focused_motoko: FocusedMotokoGateObservation;
  same_wasm_upgrade: SameWasmUpgradeGateObservation;
  hostile_raw_http: HostileRawHttpGateObservation;
  physical_one_over: PhysicalOneOverGateObservation;
  browser_cors: CertifiedAssetsBrowserCorsEvidence;
}>;

export type CertifiedAssetsQualificationReceipt = Readonly<{
  schema: typeof CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA;
  status: "passed";
  candidate: CertifiedAssetsCandidateBinding;
  environment: {
    profile: "minimal";
    isolation: "fresh_temporary_pocketic_v1";
    pocketic_version: typeof POCKET_IC_SERVER_VERSION;
    pocketic_binary_sha256: string;
    instance_config_sha256: string;
    topology_sha256: string;
    root_key_sha256: string;
    replica_time_start_ns: string;
    replica_time_end_ns: string;
    timeline: Readonly<{
      historical_auto_progress: false;
      wall_normalization: Readonly<{
        before_ns: string;
        target_host_wall_ns: string;
        after_ns: string;
        auto_progress_before: false;
        auto_progress_after: true;
      }>;
      gateway_phase: Readonly<{
        start_ns: string;
        end_ns: string;
      }>;
    }>;
  };
  runner: {
    contract_sha256: string;
    source_sha256: string;
  };
  samples: readonly QualificationSample[];
  bounded_physical_sample: BoundedPhysicalObservation;
  gates: QualificationGateObservations;
  receipt_sha256: string;
}>;

/**
 * Parse the exact pass-only receipt shape and verify its internal digest and
 * measurement summaries. This does not prove that the recorded calls happened
 * or that their replies had the claimed meaning. Release code must use
 * `assertCertifiedAssetsQualificationReceipt`, which additionally binds this
 * record to the current checked-out runner and candidate sources.
 */
export function parseCertifiedAssetsQualificationReceipt(
  value: unknown,
): CertifiedAssetsQualificationReceipt {
  const root = exactRecord(
    value,
    [
      "candidate",
      "environment",
      "gates",
      "bounded_physical_sample",
      "receipt_sha256",
      "runner",
      "samples",
      "schema",
      "status",
    ],
    "qualification receipt",
  );
  if (root.schema !== CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA) {
    throw new Error("Qualification receipt schema is invalid");
  }
  if (root.status !== "passed") {
    throw new Error("Qualification receipt is pass-only");
  }
  const candidate = assertCertifiedAssetsCandidateBinding(root.candidate);
  const environment = parseEnvironment(root.environment);
  const runner = parseRunner(root.runner);
  if (
    runner.source_sha256 !== candidate.qualification_runner_source_sha256
  ) {
    throw new Error(
      "Qualification receipt runner source differs from its candidate binding",
    );
  }
  const samples = parseSamples(root.samples, candidate, environment);
  const boundedPhysicalSample = parseBoundedPhysicalSample(
    root.bounded_physical_sample,
    candidate,
    environment,
  );
  const gates = parseQualificationGates(
    root.gates,
    candidate,
    environment,
    samples,
  );
  if (
    samples.some(
      ({ canister_id: canisterId }) =>
        canisterId === boundedPhysicalSample.canister_id,
    )
  ) {
    throw new Error(
      "Qualification bounded-physical-sample observation reuses an operational sample canister",
    );
  }
  const dedicatedCanisters = new Set(
    samples.map(({ canister_id: canisterId }) => canisterId),
  );
  dedicatedCanisters.add(boundedPhysicalSample.canister_id);
  if (dedicatedCanisters.has(gates.same_wasm_upgrade.canister_id)) {
    throw new Error(
      "Qualification same-Wasm upgrade gate reuses another evidence canister",
    );
  }
  if (
    gates.hostile_raw_http.canister_id !==
    gates.same_wasm_upgrade.canister_id
  ) {
    throw new Error(
      "Qualification hostile raw HTTP gate did not probe the upgraded canister",
    );
  }
  const receiptSha256 = digest(
    root.receipt_sha256,
    "qualification receipt.receipt_sha256",
  );
  const expected = qualificationReceiptSha256({
    schema: CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA,
    status: "passed",
    candidate,
    environment,
    runner,
    samples,
    bounded_physical_sample: boundedPhysicalSample,
    gates,
  });
  if (receiptSha256 !== expected) {
    throw new Error("Qualification receipt digest does not match its contents");
  }
  return {
    schema: CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA,
    status: "passed",
    candidate,
    environment,
    runner,
    samples,
    bounded_physical_sample: boundedPhysicalSample,
    gates,
    receipt_sha256: receiptSha256,
  };
}

/**
 * Validate the receipt against the exact qualification runner, contract,
 * fixture, implementation, profile, and package lock in this checkout.
 *
 * This closes stale-source and caller-selected-source gaps. It is still not an
 * authenticity primitive: only the non-pluggable runner can establish that
 * the summarized runtime observations were actually executed and interpreted.
 */
export async function assertCertifiedAssetsQualificationReceipt(
  value: unknown,
): Promise<CertifiedAssetsQualificationReceipt> {
  const repositoryRoot = REPOSITORY_ROOT;
  const receipt = parseCertifiedAssetsQualificationReceipt(value);
  const currentRunnerSource =
    certifiedAssetsQualificationRunnerSourceSha256();
  if (receipt.runner.source_sha256 !== currentRunnerSource) {
    throw new Error(
      "Qualification receipt does not bind the current checked-out runner source",
    );
  }
  assertCandidateMatchesCurrentRepository(receipt.candidate, repositoryRoot);
  assertFocusedMotokoSourcesCurrent(
    receipt.gates.focused_motoko,
    repositoryRoot,
  );
  const currentCompilerSource = await compilerSourceFingerprint(repositoryRoot);
  if (
    receipt.candidate.compiler_source_fingerprint_sha256 !==
    currentCompilerSource
  ) {
    throw new Error(
      "Qualification receipt candidate does not bind the current compiler source",
    );
  }
  return receipt;
}

export function qualificationReceiptSha256(
  value: Omit<CertifiedAssetsQualificationReceipt, "receipt_sha256">,
): string {
  return createHash("sha256")
    .update("neutron.kernel.certified-assets-qualification-receipt.v3\0")
    .update(canonicalJson(value))
    .digest("hex");
}

export async function qualificationReceiptBytes(
  value: unknown,
): Promise<Uint8Array> {
  const receipt = await assertCertifiedAssetsQualificationReceipt(value);
  return new TextEncoder().encode(`${canonicalJson(receipt)}\n`);
}

export function certifiedAssetsQualificationRunnerSourceSha256(
): string {
  return buildCertifiedAssetsCandidateBindingInput(REPOSITORY_ROOT).runner
    .source_set_sha256;
}

/**
 * Bind the full ordered 256-entry bounded sample without embedding its 16
 * Candid transcripts in the receipt.
 */
export function qualificationPhysicalBatchTranscriptSha256(
  calls: readonly RawCandidObservation[],
): string {
  if (calls.length !== PHYSICAL_POPULATION_BATCHES) {
    throw new Error(
      `Physical population transcript must contain ${PHYSICAL_POPULATION_BATCHES} calls`,
    );
  }
  const hash = createHash("sha256").update(
    "neutron.kernel.certified-assets-physical-batch-transcript.v1\0",
  );
  for (const [index, value] of calls.entries()) {
    const call = parseCandid(value, `physical population batch ${index}`);
    if (call.mode !== "update" || call.method !== PHYSICAL_COMMIT_METHOD) {
      throw new Error(
        `Physical population batch ${index} is not the fixed commit method`,
      );
    }
    hash.update(index.toString()).update("\0");
    hash.update(canonicalJson(call)).update("\0");
  }
  return hash.digest("hex");
}

function parseEnvironment(
  value: unknown,
): CertifiedAssetsQualificationReceipt["environment"] {
  const record = exactRecord(
    value,
    [
      "instance_config_sha256",
      "isolation",
      "pocketic_binary_sha256",
      "pocketic_version",
      "profile",
      "replica_time_end_ns",
      "replica_time_start_ns",
      "root_key_sha256",
      "timeline",
      "topology_sha256",
    ],
    "qualification environment",
  );
  if (
    record.profile !== "minimal" ||
    record.isolation !== "fresh_temporary_pocketic_v1"
  ) {
    throw new Error("Qualification environment is not the isolated minimal profile");
  }
  if (record.pocketic_version !== POCKET_IC_SERVER_VERSION) {
    throw new Error(
      `Qualification requires PocketIC ${POCKET_IC_SERVER_VERSION}`,
    );
  }
  const pocketIcBinarySha256 = digest(
    record.pocketic_binary_sha256,
    "qualification environment.pocketic_binary_sha256",
  );
  if (!PINNED_POCKET_IC_BINARY_SHA256.has(pocketIcBinarySha256)) {
    throw new Error(
      "Qualification PocketIC binary is not a pinned artifact",
    );
  }
  const replicaTimeStart = positiveDecimal(
    record.replica_time_start_ns,
    "qualification environment.replica_time_start_ns",
  );
  if (replicaTimeStart !== QUALIFICATION_INITIAL_TIME_NS.toString()) {
    throw new Error(
      `Qualification environment replica time must start at ${QUALIFICATION_INITIAL_TIME_NS}ns`,
    );
  }
  const replicaTimeEnd = positiveDecimal(
    record.replica_time_end_ns,
    "qualification environment.replica_time_end_ns",
  );
  const timelineRecord = exactRecord(
    record.timeline,
    [
      "gateway_phase",
      "historical_auto_progress",
      "wall_normalization",
    ],
    "qualification environment.timeline",
  );
  if (timelineRecord.historical_auto_progress !== false) {
    throw new Error(
      "Qualification environment historical automatic progress must be false",
    );
  }
  const wallRecord = exactRecord(
    timelineRecord.wall_normalization,
    [
      "after_ns",
      "auto_progress_after",
      "auto_progress_before",
      "before_ns",
      "target_host_wall_ns",
    ],
    "qualification environment.timeline.wall_normalization",
  );
  const wallBefore = positiveDecimal(
    wallRecord.before_ns,
    "qualification environment.timeline.wall_normalization.before_ns",
  );
  const targetHostWall = positiveDecimal(
    wallRecord.target_host_wall_ns,
    "qualification environment.timeline.wall_normalization.target_host_wall_ns",
  );
  const wallAfter = positiveDecimal(
    wallRecord.after_ns,
    "qualification environment.timeline.wall_normalization.after_ns",
  );
  if (
    wallRecord.auto_progress_before !== false ||
    wallRecord.auto_progress_after !== true
  ) {
    throw new Error(
      "Qualification environment wall normalization must transition automatic progress from false to true",
    );
  }
  if (
    BigInt(wallBefore) < BigInt(replicaTimeStart) ||
    BigInt(targetHostWall) <= BigInt(wallBefore) ||
    BigInt(wallAfter) < BigInt(targetHostWall)
  ) {
    throw new Error(
      "Qualification environment wall normalization timeline is invalid",
    );
  }
  const gatewayRecord = exactRecord(
    timelineRecord.gateway_phase,
    ["end_ns", "start_ns"],
    "qualification environment.timeline.gateway_phase",
  );
  const gatewayStart = positiveDecimal(
    gatewayRecord.start_ns,
    "qualification environment.timeline.gateway_phase.start_ns",
  );
  const gatewayEnd = positiveDecimal(
    gatewayRecord.end_ns,
    "qualification environment.timeline.gateway_phase.end_ns",
  );
  if (BigInt(replicaTimeEnd) < BigInt(replicaTimeStart)) {
    throw new Error(
      "Qualification environment replica time ends before it starts",
    );
  }
  if (
    gatewayStart !== wallAfter ||
    BigInt(gatewayEnd) < BigInt(gatewayStart) ||
    BigInt(replicaTimeEnd) < BigInt(gatewayEnd)
  ) {
    throw new Error(
      "Qualification environment gateway phase timeline is invalid",
    );
  }
  return {
    profile: "minimal",
    isolation: "fresh_temporary_pocketic_v1",
    pocketic_version: POCKET_IC_SERVER_VERSION,
    pocketic_binary_sha256: pocketIcBinarySha256,
    instance_config_sha256: digest(
      record.instance_config_sha256,
      "qualification environment.instance_config_sha256",
    ),
    topology_sha256: digest(
      record.topology_sha256,
      "qualification environment.topology_sha256",
    ),
    root_key_sha256: digest(
      record.root_key_sha256,
      "qualification environment.root_key_sha256",
    ),
    replica_time_start_ns: replicaTimeStart,
    replica_time_end_ns: replicaTimeEnd,
    timeline: {
      historical_auto_progress: false,
      wall_normalization: {
        before_ns: wallBefore,
        target_host_wall_ns: targetHostWall,
        after_ns: wallAfter,
        auto_progress_before: false,
        auto_progress_after: true,
      },
      gateway_phase: {
        start_ns: gatewayStart,
        end_ns: gatewayEnd,
      },
    },
  };
}

function parseRunner(
  value: unknown,
): CertifiedAssetsQualificationReceipt["runner"] {
  const record = exactRecord(
    value,
    ["contract_sha256", "source_sha256"],
    "qualification runner",
  );
  const contract = digest(
    record.contract_sha256,
    "qualification runner.contract_sha256",
  );
  if (contract !== CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256) {
    throw new Error("Qualification runner does not bind the current contract");
  }
  return {
    contract_sha256: contract,
    source_sha256: digest(
      record.source_sha256,
      "qualification runner.source_sha256",
    ),
  };
}

function parseSamples(
  value: unknown,
  candidate: CertifiedAssetsCandidateBinding,
  environment: CertifiedAssetsQualificationReceipt["environment"],
): QualificationSample[] {
  if (!Array.isArray(value)) {
    throw new Error("Qualification receipt.samples must be an array");
  }
  const required = new Map(
    CERTIFIED_ASSETS_QUALIFICATION_CASES.map((entry) => [
      entry.id,
      entry,
    ]),
  );
  const wantedCount =
    required.size *
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.minimum_samples_per_case;
  if (value.length !== wantedCount) {
    throw new Error(
      `Qualification receipt must contain exactly ${wantedCount} samples`,
    );
  }
  const seenCanisters = new Set<string>();
  const samples = value.map((entry, index) => {
    let phase = "record shape";
    try {
    const record = exactRecord(
      entry,
      [
        "candid",
        "canister_id",
        "case_id",
        "checkpoints",
        "http",
        "installed_transport_wasm_sha256",
        "metrics",
        "sample",
        "schema",
      ],
      `qualification sample ${index}`,
    );
    if (record.schema !== CERTIFIED_ASSETS_QUALIFICATION_SAMPLE_SCHEMA) {
      throw new Error(`Qualification sample ${index}.schema is invalid`);
    }
    const expectedDefinition =
      CERTIFIED_ASSETS_QUALIFICATION_CASES[
        Math.floor(
          index /
            CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.minimum_samples_per_case,
        )
      ]!;
    const expectedSample =
      index % CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.minimum_samples_per_case;
    if (
      record.case_id !== expectedDefinition.id ||
      record.sample !== expectedSample
    ) {
      throw new Error(
        `Qualification sample ${index} is not in canonical case/sample order`,
      );
    }
    const caseId = expectedDefinition.id;
    const definition = required.get(caseId)!;
    phase = "canister identity";
    const canisterId = canonicalCanisterId(
      record.canister_id,
      `qualification sample ${index}.canister_id`,
    );
    if (seenCanisters.has(canisterId)) {
      throw new Error(
        `Qualification receipt reuses canister ${canisterId} across samples`,
      );
    }
    seenCanisters.add(canisterId);
    const installed = digest(
      record.installed_transport_wasm_sha256,
      `qualification sample ${index}.installed_transport_wasm_sha256`,
    );
    if (installed !== candidate.qualified_transport_wasm_sha256) {
      throw new Error(`Qualification sample ${index} used a different module`);
    }
    if (
      !Array.isArray(record.checkpoints) ||
      record.checkpoints.length !== definition.checkpoints.length ||
      record.checkpoints.some(
        (checkpoint, checkpointIndex) =>
          checkpoint !== definition.checkpoints[checkpointIndex],
      )
    ) {
      throw new Error(
        `Qualification sample ${index} does not prove every ordered checkpoint`,
      );
    }
    phase = "metrics";
    const metrics = parseMetrics(
      record.metrics,
      definition.metrics,
      `qualification sample ${index}.metrics`,
    );
    if (
      !Array.isArray(record.candid) ||
      record.candid.length === 0 ||
      record.candid.length > MAX_CANDID_OBSERVATIONS_PER_SAMPLE
    ) {
      throw new Error(`Qualification sample ${index} has no raw Candid observations`);
    }
    phase = "Candid observations";
    const candid = record.candid.map((observation, observationIndex) =>
      parseCandid(
        observation,
        `qualification sample ${index}.candid[${observationIndex}]`,
      ),
    );
    if (
      !Array.isArray(record.http) ||
      record.http.length > MAX_HTTP_OBSERVATIONS_PER_SAMPLE
    ) {
      throw new Error(
        `Qualification sample ${index}.http must be a bounded array`,
      );
    }
    phase = "HTTP observations";
    const http = record.http.map((observation, observationIndex) =>
      parseHttp(
        observation,
        `qualification sample ${index}.http[${observationIndex}]`,
        canisterId,
        environment,
      ),
    );
    const gatewayEnabled =
      definition.id === "publication_lifecycle" ||
      definition.metrics.some((metric) => metric === "proof_bytes");
    phase = "gateway pairing";
    if (gatewayEnabled) {
      assertExactGatewayPairs(
        http,
        `qualification sample ${index}.http`,
      );
    } else if (
      http.some(({ boundary }) => boundary === "gateway")
    ) {
      throw new Error(
        `Qualification sample ${index} unexpectedly records a gateway observation`,
      );
    }
    phase = "observation metrics";
    assertObservationMetrics(
      metrics,
      candid,
      http,
      `qualification sample ${index}`,
    );
    for (const metricName of definition.metrics) {
      const measured = BigInt(metrics[metricName]!);
      const limit = BigInt(
        CERTIFIED_ASSETS_METRIC_DEFINITIONS.find(
          ({ metric }) => metric === metricName,
        )!.release_limit,
      );
      if (measured > limit) {
        throw new Error(
          `Qualification sample ${index}.${metricName} measured ${measured}, exceeding release limit ${limit}`,
        );
      }
    }
    return {
      schema: CERTIFIED_ASSETS_QUALIFICATION_SAMPLE_SCHEMA,
      case_id: caseId,
      sample: expectedSample,
      canister_id: canisterId,
      installed_transport_wasm_sha256: installed,
      checkpoints: [...definition.checkpoints],
      metrics,
      candid,
      http,
    };
    } catch (error) {
      const detail =
        error instanceof Error && error.message.length > 0
          ? `: ${error.message}`
          : "";
      throw new Error(
        `Qualification sample ${index} failed during ${phase}${detail}`,
        { cause: error },
      );
    }
  });
  return samples;
}

export function debugParseQualificationSamples(
  value: unknown,
  candidate: CertifiedAssetsCandidateBinding,
  environment: CertifiedAssetsQualificationReceipt["environment"],
): QualificationSample[] {
  return parseSamples(value, candidate, environment);
}

function parseBoundedPhysicalSample(
  value: unknown,
  candidate: CertifiedAssetsCandidateBinding,
  environment: CertifiedAssetsQualificationReceipt["environment"],
): BoundedPhysicalObservation {
  const record = exactRecord(
    value,
    [
      "absence",
      "absence_candidate_observations",
      "absence_candidates_queried",
      "absence_proof_bytes",
      "batch_count",
      "batch_transcript_sha256",
      "canister_id",
      "final_entry_count",
      "installed_transport_wasm_sha256",
      "overflow_call",
      "overflow_checkpoint",
      "present",
      "present_candidate_observations",
      "present_candidates_queried",
      "present_proof_bytes",
      "receipt_rollovers",
      "schema",
      "usage_after_overflow",
      "usage_after_overflow_decoded",
      "usage_before_overflow",
      "usage_before_overflow_decoded",
    ],
    "qualification bounded physical sample",
  );
  if (
    record.schema !==
    CERTIFIED_ASSETS_BOUNDED_PHYSICAL_OBSERVATION_SCHEMA
  ) {
    throw new Error("Qualification bounded-physical-sample schema is invalid");
  }
  if (record.batch_count !== PHYSICAL_POPULATION_BATCHES) {
    throw new Error(
      `Qualification bounded physical sample must contain exactly ${PHYSICAL_POPULATION_BATCHES} batches`,
    );
  }
  const batchTranscriptSha256 = digest(
    record.batch_transcript_sha256,
    "qualification bounded physical sample.batch_transcript_sha256",
  );
  if (record.final_entry_count !== PHYSICAL_POPULATION_ENTRIES) {
    throw new Error(
      `Qualification bounded physical sample must contain exactly ${PHYSICAL_POPULATION_ENTRIES} entries`,
    );
  }
  if (
    record.present_candidates_queried !==
      PHYSICAL_PRESENT_WITNESS_CANDIDATES.length ||
    record.absence_candidates_queried !==
      PHYSICAL_ABSENCE_WITNESS_CANDIDATES.length
  ) {
    throw new Error(
      "Qualification bounded physical sample did not query every fixed worst-witness candidate",
    );
  }
  const canisterId = canonicalCanisterId(
    record.canister_id,
    "qualification bounded physical sample.canister_id",
  );
  const installed = digest(
    record.installed_transport_wasm_sha256,
    "qualification bounded physical sample.installed_transport_wasm_sha256",
  );
  if (installed !== candidate.qualified_transport_wasm_sha256) {
    throw new Error(
      "Qualification bounded physical sample used a different module",
    );
  }
  const usageBeforeOverflow = parseCandid(
    record.usage_before_overflow,
    "qualification bounded physical sample.usage_before_overflow",
  );
  const overflowCall = parseCandid(
    record.overflow_call,
    "qualification bounded physical sample.overflow_call",
  );
  const usageAfterOverflow = parseCandid(
    record.usage_after_overflow,
    "qualification bounded physical sample.usage_after_overflow",
  );
  const usageBeforeOverflowDecoded = parsePhysicalUsageSummary(
    record.usage_before_overflow_decoded,
    "qualification bounded physical sample.usage_before_overflow_decoded",
    PHYSICAL_POPULATION_FINAL_USAGE,
  );
  const usageAfterOverflowDecoded = parsePhysicalUsageSummary(
    record.usage_after_overflow_decoded,
    "qualification bounded physical sample.usage_after_overflow_decoded",
    PHYSICAL_POPULATION_FINAL_USAGE,
  );
  const receiptRollovers = parsePhysicalReceiptRollovers(
    record.receipt_rollovers,
    environment.replica_time_start_ns,
  );
  const manualReplicaTime =
    receiptRollovers.at(-1)?.clock.after_ns ??
      environment.replica_time_start_ns;
  if (
    environment.timeline.wall_normalization.before_ns !==
      manualReplicaTime
  ) {
    throw new Error(
      "Qualification wall normalization does not continue the physical manual-clock timeline",
    );
  }
  if (
    usageBeforeOverflow.mode !== "query" ||
    usageBeforeOverflow.method !== PHYSICAL_USAGE_METHOD ||
    usageAfterOverflow.mode !== "query" ||
    usageAfterOverflow.method !== PHYSICAL_USAGE_METHOD ||
    overflowCall.mode !== "update" ||
    overflowCall.method !== PHYSICAL_COMMIT_METHOD ||
    record.overflow_checkpoint !==
      "entry_quota_rejected_without_state_drift" ||
    !sameExactBytes(
      usageBeforeOverflow.request,
      usageAfterOverflow.request,
    ) ||
    !sameExactBytes(usageBeforeOverflow.reply, usageAfterOverflow.reply)
  ) {
    throw new Error(
      "Qualification bounded physical sample does not bind the exact one-over rejection without state drift",
    );
  }
  const present = parseHttp(
    record.present,
    "qualification bounded physical sample.present",
    canisterId,
    environment,
  );
  const absence = parseHttp(
    record.absence,
    "qualification bounded physical sample.absence",
    canisterId,
    environment,
  );
  const presentCandidateObservations =
    parsePhysicalWitnessCandidateObservations(
      record.present_candidate_observations,
      "present",
      canisterId,
      environment,
    );
  const absenceCandidateObservations =
    parsePhysicalWitnessCandidateObservations(
      record.absence_candidate_observations,
      "absence",
      canisterId,
      environment,
    );
  const presentRawCandidateObservations =
    presentCandidateObservations.filter(
      ({ boundary }) => boundary === "raw_query",
    );
  const absenceRawCandidateObservations =
    absenceCandidateObservations.filter(
      ({ boundary }) => boundary === "raw_query",
    );
  if (
    canonicalJson(present) !==
      canonicalJson(
        largestProofObservation(presentRawCandidateObservations),
      ) ||
    canonicalJson(absence) !==
      canonicalJson(
        largestProofObservation(absenceRawCandidateObservations),
      )
  ) {
    throw new Error(
      "Qualification bounded physical sample did not select the largest fixed candidate proof",
    );
  }
  const presentUrl = new URL(present.url);
  const absenceUrl = new URL(absence.url);
  if (
    present.boundary !== "raw_query" ||
    absence.boundary !== "raw_query" ||
    present.method !== "GET" ||
    present.status !== 200 ||
    absence.method !== "GET" ||
    absence.status !== 404 ||
    present.body.bytes !== 1 ||
    absence.body.bytes !== 0
  ) {
    throw new Error(
      "Qualification bounded physical sample must bind one present 200 and one absent 404 GET",
    );
  }
  if (
    !presentUrl.pathname.startsWith(PHYSICAL_POPULATION_ROUTE_PREFIX) ||
    !absenceUrl.pathname.startsWith(PHYSICAL_POPULATION_ROUTE_PREFIX) ||
    presentUrl.href === absenceUrl.href
  ) {
    throw new Error(
      "Qualification bounded physical sample does not bind distinct physical-record routes",
    );
  }
  const presentCandidate = PHYSICAL_PRESENT_WITNESS_CANDIDATES.find(
    ({ path: candidatePath }) => candidatePath === presentUrl.pathname,
  );
  const absenceCandidate = PHYSICAL_ABSENCE_WITNESS_CANDIDATES.find(
    ({ path: candidatePath }) => candidatePath === absenceUrl.pathname,
  );
  if (
    presentCandidate === undefined ||
    absenceCandidate === undefined ||
    present.body.sha256 !==
      createHash("sha256").update(presentCandidate.body).digest("hex")
  ) {
    throw new Error(
      "Qualification bounded physical sample does not bind a fixed worst-witness candidate",
    );
  }
  const presentProofBytes = positiveDecimal(
    record.present_proof_bytes,
    "qualification bounded physical sample.present_proof_bytes",
  );
  const absenceProofBytes = positiveDecimal(
    record.absence_proof_bytes,
    "qualification bounded physical sample.absence_proof_bytes",
  );
  assertMetricEquals(
    presentProofBytes,
    proofBytes(present),
    "qualification bounded physical sample.present_proof_bytes",
  );
  assertMetricEquals(
    absenceProofBytes,
    proofBytes(absence),
    "qualification bounded physical sample.absence_proof_bytes",
  );
  return {
    schema: CERTIFIED_ASSETS_BOUNDED_PHYSICAL_OBSERVATION_SCHEMA,
    canister_id: canisterId,
    installed_transport_wasm_sha256: installed,
    batch_count: PHYSICAL_POPULATION_BATCHES,
    batch_transcript_sha256: batchTranscriptSha256,
    final_entry_count: PHYSICAL_POPULATION_ENTRIES,
    receipt_rollovers: receiptRollovers,
    usage_before_overflow: usageBeforeOverflow,
    usage_before_overflow_decoded: usageBeforeOverflowDecoded,
    overflow_call: overflowCall,
    usage_after_overflow: usageAfterOverflow,
    usage_after_overflow_decoded: usageAfterOverflowDecoded,
    overflow_checkpoint: "entry_quota_rejected_without_state_drift",
    present_candidates_queried:
      PHYSICAL_PRESENT_WITNESS_CANDIDATES.length,
    present_candidate_observations: presentCandidateObservations,
    present,
    present_proof_bytes: presentProofBytes,
    absence_candidates_queried:
      PHYSICAL_ABSENCE_WITNESS_CANDIDATES.length,
    absence_candidate_observations: absenceCandidateObservations,
    absence,
    absence_proof_bytes: absenceProofBytes,
  };
}

function parsePhysicalUsageSummary(
  value: unknown,
  label: string,
  expected: PhysicalPopulationUsageExpectation,
): PhysicalUsageSummary {
  const keys = [
    "accepted_staged_bytes",
    "active_stages",
    "cleanup_jobs",
    "committed_body_bytes",
    "detached_charged_bytes",
    "filled_revocation_lanes",
    "general_receipt_lanes",
    "live_entries",
    "occupied_entry_slots",
    "receipt_expiry_indexes",
    "receipt_lanes",
    "receipt_nonce_indexes",
    "reserved_committed_body_bytes",
    "reserved_entry_slots",
    "reserved_general_receipt_lanes",
    "reserved_revocation_lanes",
    "reserved_staged_bytes",
  ] as const satisfies readonly (keyof PhysicalPopulationUsageExpectation)[];
  const record = exactRecord(
    value,
    keys,
    label,
  );
  const result = {} as Record<
    keyof PhysicalPopulationUsageExpectation,
    string
  >;
  for (const key of keys) {
    const actual = decimal(record[key], `${label}.${key}`);
    if (actual !== expected[key].toString()) {
      throw new Error(`${label}.${key} does not match the fixed workload`);
    }
    result[key] = actual;
  }
  return result;
}

function parsePhysicalWitnessCandidateObservations(
  value: unknown,
  kind: "present" | "absence",
  canisterId: string,
  environment: CertifiedAssetsQualificationReceipt["environment"],
): readonly CertifiedHttpObservation[] {
  const candidates = kind === "present"
    ? PHYSICAL_PRESENT_WITNESS_CANDIDATES
    : PHYSICAL_ABSENCE_WITNESS_CANDIDATES;
  if (
    !Array.isArray(value) ||
    value.length !== candidates.length * 2
  ) {
    throw new Error(
      `Qualification bounded physical sample does not bind every paired ${kind} witness candidate`,
    );
  }
  const result: CertifiedHttpObservation[] = [];
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const rawIndex = candidateIndex * 2;
    const gatewayIndex = rawIndex + 1;
    const rawLabel =
      `qualification bounded physical sample.${kind}_candidate_observations[${rawIndex}]`;
    const gatewayLabel =
      `qualification bounded physical sample.${kind}_candidate_observations[${gatewayIndex}]`;
    const raw = parseHttp(
      value[rawIndex],
      rawLabel,
      canisterId,
      environment,
    );
    const gateway = parseHttp(
      value[gatewayIndex],
      gatewayLabel,
      canisterId,
      environment,
    );
    const wantedStatus = "body" in candidate ? 200 : 404;
    const wantedBody = "body" in candidate
      ? exactUtf8OrBinaryBytes(candidate.body)
      : { bytes: 0, sha256: EMPTY_SHA256 };
    if (
      raw.boundary !== "raw_query" ||
      raw.method !== "GET" ||
      raw.status !== wantedStatus ||
      new URL(raw.url).pathname !== candidate.path ||
      !sameExactBytes(raw.body, wantedBody)
    ) {
      throw new Error(
        `${rawLabel} does not match its canonical fixed candidate`,
      );
    }
    if (
      gateway.boundary !== "gateway" ||
      !isExactGatewayCounterpart(raw, gateway)
    ) {
      throw new Error(
        `${gatewayLabel} is not the exact gateway counterpart for its raw candidate`,
      );
    }
    result.push(raw, gateway);
  }
  return result;
}

function assertExactGatewayPairs(
  observations: readonly CertifiedHttpObservation[],
  label: string,
): void {
  if (
    observations.length === 0 ||
    observations.length % 2 !== 0
  ) {
    throw new Error(`${label} does not contain exact raw/gateway pairs`);
  }
  for (let index = 0; index < observations.length; index += 2) {
    const raw = observations[index]!;
    const gateway = observations[index + 1]!;
    if (
      raw.boundary !== "raw_query" ||
      gateway.boundary !== "gateway" ||
      !isExactGatewayCounterpart(raw, gateway)
    ) {
      throw new Error(
        `${label}[${index}] does not have one exact gateway counterpart`,
      );
    }
  }
}

function isExactGatewayCounterpart(
  raw: CertifiedHttpObservation,
  gateway: CertifiedHttpObservation,
): boolean {
  return (
    gateway.url === raw.url &&
    gateway.method === raw.method &&
    gateway.status === raw.status &&
    sameExactBytes(gateway.body, raw.body) &&
    sameExactBytes(gateway.witness, raw.witness)
  );
}

function largestProofObservation(
  observations: readonly CertifiedHttpObservation[],
): CertifiedHttpObservation {
  const first = observations[0];
  if (first === undefined) {
    throw new Error("Qualification physical witness candidate set is empty");
  }
  let largest = first;
  for (const observation of observations.slice(1)) {
    if (proofBytes(observation) > proofBytes(largest)) {
      largest = observation;
    }
  }
  return largest;
}

function exactUtf8OrBinaryBytes(value: Uint8Array): ExactBytes {
  return {
    bytes: value.byteLength,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function parsePhysicalReceiptRollovers(
  value: unknown,
  replicaTimeStartNs: string,
): readonly PhysicalReceiptRolloverObservation[] {
  const expected = physicalPopulationReceiptRollovers();
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(
      "Qualification bounded physical sample does not bind every fixed receipt rollover",
    );
  }
  let expectedBeforeNs = BigInt(replicaTimeStartNs);
  return value.map((entry, rolloverIndex) => {
    const label =
      `qualification bounded physical sample.receipt_rollovers[${rolloverIndex}]`;
    const record = exactRecord(
      entry,
      [
        "after_batch_count",
        "checkpoint",
        "clock",
        "maintenance_pages",
        "reclaimed_receipts_total",
        "usage_after",
        "usage_after_decoded",
        "usage_before",
        "usage_before_decoded",
      ],
      label,
    );
    const wanted = expected[rolloverIndex]!;
    if (record.after_batch_count !== wanted.after_batch_count) {
      throw new Error(`${label} does not bind the fixed expiry boundary`);
    }
    const clockRecord = exactRecord(
      record.clock,
      ["after_ns", "before_ns", "requested_delta_ns"],
      `${label}.clock`,
    );
    const clockBefore = positiveDecimal(
      clockRecord.before_ns,
      `${label}.clock.before_ns`,
    );
    const requestedDelta = positiveDecimal(
      clockRecord.requested_delta_ns,
      `${label}.clock.requested_delta_ns`,
    );
    const clockAfter = positiveDecimal(
      clockRecord.after_ns,
      `${label}.clock.after_ns`,
    );
    if (
      BigInt(clockBefore) !== expectedBeforeNs ||
      requestedDelta !== wanted.advance_time_ns.toString() ||
      BigInt(clockAfter) !==
        BigInt(clockBefore) + wanted.advance_time_ns
    ) {
      throw new Error(`${label}.clock does not bind the exact manual advance`);
    }
    expectedBeforeNs = BigInt(clockAfter);
    const usageBefore = parseCandid(
      record.usage_before,
      `${label}.usage_before`,
    );
    const usageAfter = parseCandid(
      record.usage_after,
      `${label}.usage_after`,
    );
    if (
      usageBefore.mode !== "query" ||
      usageBefore.method !== PHYSICAL_USAGE_METHOD ||
      usageAfter.mode !== "query" ||
      usageAfter.method !== PHYSICAL_USAGE_METHOD ||
      !sameExactBytes(usageBefore.request, usageAfter.request) ||
      record.checkpoint !== "general_receipt_ceiling_reclaimed"
    ) {
      throw new Error(
        `${label} does not bind usage around the fixed receipt reclamation`,
      );
    }
    const usageBeforeDecoded = parsePhysicalUsageSummary(
      record.usage_before_decoded,
      `${label}.usage_before_decoded`,
      wanted.usage_before,
    );
    const usageAfterDecoded = parsePhysicalUsageSummary(
      record.usage_after_decoded,
      `${label}.usage_after_decoded`,
      wanted.usage_after,
    );
    if (
      !Array.isArray(record.maintenance_pages) ||
      record.maintenance_pages.length !== wanted.expected_maintenance_pages
    ) {
      throw new Error(
        `${label} does not bind every bounded maintenance page`,
      );
    }
    let reclaimedTotal = 0;
    let firstRequest: ExactBytes | undefined;
    const pages = record.maintenance_pages.map((pageValue, pageIndex) => {
      const pageLabel = `${label}.maintenance_pages[${pageIndex}]`;
      const pageRecord = exactRecord(
        pageValue,
        [
          "call",
          "has_more",
          "page_index",
          "reclaimed",
          "remaining_jobs",
        ],
        pageLabel,
      );
      const call = parseCandid(pageRecord.call, `${pageLabel}.call`);
      const hasMore = pageIndex + 1 < wanted.expected_maintenance_pages;
      const reclaimed = exactRecord(
        pageRecord.reclaimed,
        [
          "authenticated_nodes",
          "bodies",
          "body_bytes",
          "charged_bytes",
          "receipts",
          "records",
        ],
        `${pageLabel}.reclaimed`,
      );
      const reclaimedReceipts = decimal(
        reclaimed.receipts,
        `${pageLabel}.reclaimed.receipts`,
      );
      const expectedReclaimedReceipts = Math.min(
        CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
        wanted.expected_receipts_reclaimed -
          pageIndex * CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
      ).toString();
      const expectedReclaimedChargedBytes =
        physicalReceiptReclaimedChargedBytes(
          Number(expectedReclaimedReceipts),
        ).toString();
      if (
        pageRecord.page_index !== pageIndex ||
        call.mode !== "update" ||
        call.method !== PHYSICAL_MAINTENANCE_METHOD ||
        reclaimedReceipts !== expectedReclaimedReceipts ||
        decimal(reclaimed.records, `${pageLabel}.reclaimed.records`) !== "0" ||
        decimal(reclaimed.bodies, `${pageLabel}.reclaimed.bodies`) !== "0" ||
        decimal(reclaimed.body_bytes, `${pageLabel}.reclaimed.body_bytes`) !==
          "0" ||
        decimal(
            reclaimed.authenticated_nodes,
            `${pageLabel}.reclaimed.authenticated_nodes`,
          ) !== "0" ||
        decimal(
            reclaimed.charged_bytes,
            `${pageLabel}.reclaimed.charged_bytes`,
          ) !== expectedReclaimedChargedBytes ||
        pageRecord.has_more !== hasMore ||
        decimal(pageRecord.remaining_jobs, `${pageLabel}.remaining_jobs`) !==
          "0"
      ) {
        throw new Error(
          `${pageLabel} does not bind the fixed receipt-reclamation page`,
        );
      }
      if (
        firstRequest !== undefined &&
        !sameExactBytes(firstRequest, call.request)
      ) {
        throw new Error(
          `${pageLabel} does not use the same empty maintenance request`,
        );
      }
      firstRequest ??= call.request;
      reclaimedTotal += Number(reclaimedReceipts);
      return {
        page_index: pageIndex,
        call,
        reclaimed: {
          records: "0",
          bodies: "0",
          body_bytes: "0",
          charged_bytes: expectedReclaimedChargedBytes,
          authenticated_nodes: "0",
          receipts: expectedReclaimedReceipts,
        },
        has_more: hasMore,
        remaining_jobs: "0",
      };
    });
    if (
      reclaimedTotal !== wanted.expected_receipts_reclaimed ||
      decimal(
        record.reclaimed_receipts_total,
        `${label}.reclaimed_receipts_total`,
      ) !== reclaimedTotal.toString()
    ) {
      throw new Error(
        `${label} does not reclaim the complete fixed receipt ceiling`,
      );
    }
    return {
      after_batch_count: wanted.after_batch_count,
      clock: {
        before_ns: clockBefore,
        requested_delta_ns:
          (CERTIFIED_ASSETS_RECEIPT_RECONCILE_NS + 1n).toString(),
        after_ns: clockAfter,
      },
      usage_before: usageBefore,
      usage_before_decoded: usageBeforeDecoded,
      maintenance_pages: pages,
      usage_after: usageAfter,
      usage_after_decoded: usageAfterDecoded,
      reclaimed_receipts_total: PHYSICAL_POPULATION_RECEIPT_LIMIT.toString(),
      checkpoint: "general_receipt_ceiling_reclaimed",
    };
  });
}

function parseQualificationGates(
  value: unknown,
  candidate: CertifiedAssetsCandidateBinding,
  environment: CertifiedAssetsQualificationReceipt["environment"],
  samples: readonly QualificationSample[],
): QualificationGateObservations {
  const record = exactRecord(
    value,
    [
      "browser_cors",
      "focused_motoko",
      "hostile_raw_http",
      "physical_one_over",
      "same_wasm_upgrade",
      "schema",
    ],
    "qualification gates",
  );
  if (record.schema !== CERTIFIED_ASSETS_QUALIFICATION_GATES_SCHEMA) {
    throw new Error("Qualification gates schema is invalid");
  }
  const browserCors = parseBrowserCorsGate(record.browser_cors);
  assertBrowserCorsBindsPortableSample(browserCors, samples);
  return {
    schema: CERTIFIED_ASSETS_QUALIFICATION_GATES_SCHEMA,
    focused_motoko: parseFocusedMotokoGate(record.focused_motoko),
    same_wasm_upgrade: parseUpgradeGate(
      record.same_wasm_upgrade,
      candidate,
      environment,
    ),
    hostile_raw_http: parseHostileHttpGate(
      record.hostile_raw_http,
      candidate,
    ),
    physical_one_over: parseOneOverGate(record.physical_one_over),
    browser_cors: browserCors,
  };
}

function parseFocusedMotokoGate(
  value: unknown,
): FocusedMotokoGateObservation {
  const record = exactRecord(
    value,
    [
      "expected_pass_lines",
      "schema",
      "stdout",
      "test_files",
      "wasmtime",
    ],
    "qualification focused Motoko gates",
  );
  if (record.schema !== CERTIFIED_ASSETS_MOTOKO_GATES_SCHEMA) {
    throw new Error("Qualification focused Motoko gates schema is invalid");
  }
  const wasmtimeRecord = exactRecord(
    record.wasmtime,
    ["binary", "version"],
    "qualification focused Motoko gates.wasmtime",
  );
  if (
    typeof wasmtimeRecord.version !== "string" ||
    !WASMTIME_VERSION_PATTERN.test(wasmtimeRecord.version)
  ) {
    throw new Error(
      "Qualification focused Motoko gates Wasmtime version is invalid",
    );
  }
  const wasmtime = {
    version: wasmtimeRecord.version,
    binary: parseExactBytes(
      wasmtimeRecord.binary,
      "qualification focused Motoko gates.wasmtime.binary",
      1,
      512 * 1024 * 1024,
    ),
  };
  if (
    !Array.isArray(record.test_files) ||
    record.test_files.length !== FOCUSED_MOTOKO_TESTS.length
  ) {
    throw new Error(
      "Qualification focused Motoko gates must bind every fixed test file",
    );
  }
  const testFiles = record.test_files.map((entry, index) => {
    const file = exactRecord(
      entry,
      ["path", "source_sha256"],
      `qualification focused Motoko test ${index}`,
    );
    if (file.path !== FOCUSED_MOTOKO_TESTS[index]) {
      throw new Error(
        "Qualification focused Motoko test files are not in canonical order",
      );
    }
    return {
      path: FOCUSED_MOTOKO_TESTS[index]!,
      source_sha256: digest(
        file.source_sha256,
        `qualification focused Motoko test ${index}.source_sha256`,
      ),
    };
  });
  if (
    !Array.isArray(record.expected_pass_lines) ||
    record.expected_pass_lines.length !== FOCUSED_MOTOKO_PASS_LINES.length ||
    record.expected_pass_lines.some(
      (line, index) => line !== FOCUSED_MOTOKO_PASS_LINES[index],
    )
  ) {
    throw new Error(
      "Qualification focused Motoko gates do not bind the exact pass lines",
    );
  }
  const stdout = parseExactBytes(
    record.stdout,
    "qualification focused Motoko gates.stdout",
    1,
    64 * 1024,
  );
  const expectedStdout = new TextEncoder().encode(
    `${FOCUSED_MOTOKO_PASS_LINES.join("\n")}\n`,
  );
  if (
    stdout.bytes !== expectedStdout.byteLength ||
    stdout.sha256 !==
      createHash("sha256").update(expectedStdout).digest("hex")
  ) {
    throw new Error(
      "Qualification focused Motoko stdout is not the exact fixed pass transcript",
    );
  }
  return {
    schema: CERTIFIED_ASSETS_MOTOKO_GATES_SCHEMA,
    wasmtime,
    test_files: testFiles,
    expected_pass_lines: FOCUSED_MOTOKO_PASS_LINES,
    stdout,
  };
}

function parseUpgradeGate(
  value: unknown,
  candidate: CertifiedAssetsCandidateBinding,
  environment: CertifiedAssetsQualificationReceipt["environment"],
): SameWasmUpgradeGateObservation {
  const record = exactRecord(
    value,
    [
      "canister_id",
      "canister_version_after",
      "canister_version_before",
      "certified_read_after",
      "certified_read_before",
      "controllers_after",
      "controllers_before",
      "installed_transport_wasm_sha256_after",
      "installed_transport_wasm_sha256_before",
      "record_status_after",
      "record_status_before",
      "schema",
      "status_after",
      "status_before",
      "upgrade_call",
    ],
    "qualification same-Wasm upgrade gate",
  );
  if (record.schema !== CERTIFIED_ASSETS_UPGRADE_GATE_SCHEMA) {
    throw new Error("Qualification same-Wasm upgrade gate schema is invalid");
  }
  const canisterId = canonicalCanisterId(
    record.canister_id,
    "qualification same-Wasm upgrade gate.canister_id",
  );
  const beforeModule = digest(
    record.installed_transport_wasm_sha256_before,
    "qualification same-Wasm upgrade gate.installed_transport_wasm_sha256_before",
  );
  const afterModule = digest(
    record.installed_transport_wasm_sha256_after,
    "qualification same-Wasm upgrade gate.installed_transport_wasm_sha256_after",
  );
  if (
    record.status_before !== "running" ||
    record.status_after !== "running" ||
    beforeModule !== candidate.qualified_transport_wasm_sha256 ||
    afterModule !== candidate.qualified_transport_wasm_sha256
  ) {
    throw new Error(
      "Qualification same-Wasm upgrade gate used a different module",
    );
  }
  const versionBefore = decimal(
    record.canister_version_before,
    "qualification same-Wasm upgrade gate.canister_version_before",
  );
  const versionAfter = decimal(
    record.canister_version_after,
    "qualification same-Wasm upgrade gate.canister_version_after",
  );
  if (BigInt(versionAfter) <= BigInt(versionBefore)) {
    throw new Error(
      "Qualification same-Wasm upgrade gate did not advance canister_version",
    );
  }
  const controllersBefore = parsePrincipals(
    record.controllers_before,
    "qualification same-Wasm upgrade gate.controllers_before",
  );
  const controllersAfter = parsePrincipals(
    record.controllers_after,
    "qualification same-Wasm upgrade gate.controllers_after",
  );
  if (
    controllersBefore.length === 0 ||
    canonicalJson(controllersBefore) !== canonicalJson(controllersAfter)
  ) {
    throw new Error(
      "Qualification same-Wasm upgrade gate changed its controller set",
    );
  }
  const upgradeCall = parseCandid(
    record.upgrade_call,
    "qualification same-Wasm upgrade gate.upgrade_call",
  );
  if (
    upgradeCall.mode !== "update" ||
    upgradeCall.method !== "install_chunked_code"
  ) {
    throw new Error(
      "Qualification same-Wasm upgrade gate did not bind install_chunked_code",
    );
  }
  const beforeStatus = parseCandid(
    record.record_status_before,
    "qualification same-Wasm upgrade gate.record_status_before",
  );
  const afterStatus = parseCandid(
    record.record_status_after,
    "qualification same-Wasm upgrade gate.record_status_after",
  );
  if (
    beforeStatus.mode !== "query" ||
    beforeStatus.method !== UPGRADE_RECORD_STATUS_METHOD ||
    afterStatus.mode !== "query" ||
    afterStatus.method !== UPGRADE_RECORD_STATUS_METHOD ||
    !sameExactBytes(beforeStatus.request, afterStatus.request) ||
    !sameExactBytes(beforeStatus.reply, afterStatus.reply)
  ) {
    throw new Error(
      "Qualification same-Wasm upgrade gate did not preserve the exact record status",
    );
  }
  const beforeRead = parseHttp(
    record.certified_read_before,
    "qualification same-Wasm upgrade gate.certified_read_before",
    canisterId,
    environment,
  );
  const afterRead = parseHttp(
    record.certified_read_after,
    "qualification same-Wasm upgrade gate.certified_read_after",
    canisterId,
    environment,
  );
  if (
    beforeRead.boundary !== "raw_query" ||
    afterRead.boundary !== "raw_query" ||
    beforeRead.method !== "GET" ||
    afterRead.method !== "GET" ||
    beforeRead.status !== 200 ||
    afterRead.status !== 200 ||
    beforeRead.url !== afterRead.url ||
    !sameExactBytes(beforeRead.body, afterRead.body) ||
    !sameExactBytes(
      beforeRead.expression_path,
      afterRead.expression_path,
    ) ||
    canonicalJson(beforeRead.response_headers) !==
      canonicalJson(afterRead.response_headers) ||
    BigInt(afterRead.certificate_time_ns) <
      BigInt(beforeRead.certificate_time_ns)
  ) {
    throw new Error(
      "Qualification same-Wasm upgrade gate did not preserve the certified record",
    );
  }
  return {
    schema: CERTIFIED_ASSETS_UPGRADE_GATE_SCHEMA,
    canister_id: canisterId,
    status_before: "running",
    canister_version_before: versionBefore,
    controllers_before: controllersBefore,
    installed_transport_wasm_sha256_before: beforeModule,
    upgrade_call: upgradeCall,
    status_after: "running",
    canister_version_after: versionAfter,
    controllers_after: controllersAfter,
    installed_transport_wasm_sha256_after: afterModule,
    record_status_before: beforeStatus,
    record_status_after: afterStatus,
    certified_read_before: beforeRead,
    certified_read_after: afterRead,
  };
}

function parseHostileHttpGate(
  value: unknown,
  candidate: CertifiedAssetsCandidateBinding,
): HostileRawHttpGateObservation {
  const record = exactRecord(
    value,
    [
      "body",
      "call",
      "canister_id",
      "installed_transport_wasm_sha256",
      "request_headers",
      "response_headers",
      "schema",
      "status_code",
      "streaming_strategy_entries",
      "upgrade_entries",
      "url",
    ],
    "qualification hostile raw HTTP gate",
  );
  if (record.schema !== CERTIFIED_ASSETS_HOSTILE_HTTP_GATE_SCHEMA) {
    throw new Error("Qualification hostile raw HTTP gate schema is invalid");
  }
  const canisterId = canonicalCanisterId(
    record.canister_id,
    "qualification hostile raw HTTP gate.canister_id",
  );
  const installed = digest(
    record.installed_transport_wasm_sha256,
    "qualification hostile raw HTTP gate.installed_transport_wasm_sha256",
  );
  if (installed !== candidate.qualified_transport_wasm_sha256) {
    throw new Error(
      "Qualification hostile raw HTTP gate used a different module",
    );
  }
  const call = parseCandid(
    record.call,
    "qualification hostile raw HTTP gate.call",
  );
  if (call.mode !== "query" || call.method !== "http_request") {
    throw new Error(
      "Qualification hostile raw HTTP gate did not bind a raw http_request query",
    );
  }
  const url = isolatedCanisterUrl(
    record.url,
    canisterId,
    "qualification hostile raw HTTP gate.url",
  );
  const requestHeaders = parseHeaders(
    record.request_headers,
    "qualification hostile raw HTTP gate.request_headers",
  );
  if (
    canonicalJson(requestHeaders) !==
    canonicalJson([
      ["host", `${canisterId}.localhost:8000`],
      ["range", "bytes=0-1,2-3"],
    ])
  ) {
    throw new Error(
      "Qualification hostile raw HTTP gate does not bind the exact fixed request headers",
    );
  }
  const responseHeaders = parseHeaders(
    record.response_headers,
    "qualification hostile raw HTTP gate.response_headers",
  );
  if (
    canonicalJson(responseHeaders) !==
    canonicalJson([["cache-control", "no-store"]])
  ) {
    throw new Error(
      "Qualification hostile raw HTTP gate has the wrong fail-closed headers",
    );
  }
  const body = parseExactBytes(
    record.body,
    "qualification hostile raw HTTP gate.body",
    0,
    0,
  );
  if (
    body.sha256 !== EMPTY_SHA256 ||
    record.status_code !== 400 ||
    record.streaming_strategy_entries !== 0 ||
    record.upgrade_entries !== 0
  ) {
    throw new Error(
      "Qualification hostile raw HTTP gate is not the closed empty 400 response",
    );
  }
  return {
    schema: CERTIFIED_ASSETS_HOSTILE_HTTP_GATE_SCHEMA,
    canister_id: canisterId,
    installed_transport_wasm_sha256: installed,
    call,
    url: url.href,
    request_headers: requestHeaders,
    status_code: 400,
    response_headers: responseHeaders,
    body,
    streaming_strategy_entries: 0,
    upgrade_entries: 0,
  };
}

function parseOneOverGate(
  value: unknown,
): PhysicalOneOverGateObservation {
  const record = exactRecord(
    value,
    [
      "attempted_entries",
      "manifest",
      "maximum_entries",
      "schema",
      "validation_error",
    ],
    "qualification physical one-over gate",
  );
  if (record.schema !== CERTIFIED_ASSETS_ONE_OVER_GATE_SCHEMA) {
    throw new Error("Qualification physical one-over gate schema is invalid");
  }
  if (
    record.attempted_entries !==
      CERTIFIED_ASSETS_MAX_ENTRIES + 1 ||
    record.maximum_entries !==
      CERTIFIED_ASSETS_MAX_ENTRIES
  ) {
    throw new Error(
      "Qualification physical one-over gate does not bind the exact entry boundary",
    );
  }
  const manifest = parseExactBytes(
    record.manifest,
    "qualification physical one-over gate.manifest",
    1,
    1024 * 1024,
  );
  const error = exactRecord(
    record.validation_error,
    ["canonical_sha256", "instance_path", "keyword", "schema_path"],
    "qualification physical one-over gate.validation_error",
  );
  if (
    error.instance_path !== "/capabilities/certified_assets/max_entries" ||
    error.keyword !== "maximum" ||
    typeof error.schema_path !== "string" ||
    !/max_entries(?:\/properties)?\/maximum$/u.test(error.schema_path)
  ) {
    throw new Error(
      "Qualification physical one-over gate did not bind the max_entries maximum error",
    );
  }
  return {
    schema: CERTIFIED_ASSETS_ONE_OVER_GATE_SCHEMA,
    attempted_entries: 100_001,
    maximum_entries: 100_000,
    manifest,
    validation_error: {
      instance_path: error.instance_path,
      schema_path: error.schema_path,
      keyword: "maximum",
      canonical_sha256: digest(
        error.canonical_sha256,
        "qualification physical one-over gate.validation_error.canonical_sha256",
      ),
    },
  };
}

function parseBrowserCorsGate(
  value: unknown,
): CertifiedAssetsBrowserCorsEvidence {
  const record = exactRecord(
    value,
    ["engine", "request", "response", "schema"],
    "qualification browser CORS gate",
  );
  if (record.schema !== CERTIFIED_ASSETS_BROWSER_CORS_SCHEMA) {
    throw new Error("Qualification browser CORS gate schema is invalid");
  }
  const engine = exactRecord(
    record.engine,
    ["name", "version"],
    "qualification browser CORS gate.engine",
  );
  if (
    engine.name !== "chromium" ||
    typeof engine.version !== "string" ||
    !/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(engine.version)
  ) {
    throw new Error("Qualification browser CORS gate engine is invalid");
  }
  const request = exactRecord(
    record.request,
    [
      "credentials",
      "harness_origin",
      "mode",
      "origin_header_exact",
      "remote_address",
      "target_origin",
      "url",
    ],
    "qualification browser CORS gate.request",
  );
  if (
    request.mode !== "cors" ||
    request.credentials !== "omit" ||
    request.origin_header_exact !== true ||
    typeof request.harness_origin !== "string" ||
    typeof request.target_origin !== "string" ||
    typeof request.url !== "string"
  ) {
    throw new Error("Qualification browser CORS request is invalid");
  }
  const remoteAddress = exactRecord(
    request.remote_address,
    ["ip", "port"],
    "qualification browser CORS gate.request.remote_address",
  );
  if (remoteAddress.ip !== "127.0.0.2" || remoteAddress.port !== 8000) {
    throw new Error(
      "Qualification browser CORS gate did not bind the isolated gateway socket",
    );
  }
  const harness = new URL(request.harness_origin);
  const target = new URL(request.url);
  if (
    harness.origin !== request.harness_origin ||
    harness.protocol !== "http:" ||
    harness.hostname !== "127.0.0.1" ||
    harness.port === "" ||
    target.origin !== request.target_origin ||
    target.protocol !== "http:" ||
    !target.hostname.endsWith(".localhost") ||
    target.port !== "8000" ||
    harness.origin === target.origin
  ) {
    throw new Error(
      "Qualification browser CORS gate did not bind two isolated loopback origins",
    );
  }
  canonicalCanisterId(
    target.hostname.slice(0, -".localhost".length),
    "qualification browser CORS target canister",
  );
  const response = exactRecord(
    record.response,
    ["body", "cors_control_headers_hidden", "headers", "status"],
    "qualification browser CORS gate.response",
  );
  if (
    response.status !== 200 ||
    response.cors_control_headers_hidden !== true ||
    !Array.isArray(response.headers) ||
    response.headers.length !== BROWSER_CERTIFIED_HEADERS.length
  ) {
    throw new Error("Qualification browser CORS response is invalid");
  }
  const body = parseExactBytes(
    response.body,
    "qualification browser CORS gate.response.body",
    0,
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.synthetic_plan.limits
      .max_object_bytes,
  );
  const headers = response.headers.map((entry, index) => {
    const header = exactRecord(
      entry,
      ["browser", "disposition", "name", "raw"],
      `qualification browser CORS gate.response.headers[${index}]`,
    );
    const expectedName = BROWSER_CERTIFIED_HEADERS[index]!;
    const expectedVisible = BROWSER_VISIBLE_CERTIFIED_HEADERS.has(
      expectedName,
    );
    if (
      header.name !== expectedName ||
      header.disposition !==
        (expectedVisible ? "visible_exactly" : "hidden")
    ) {
      throw new Error(
        "Qualification browser CORS gate does not bind the fixed header visibility boundary",
      );
    }
    const raw = parseExactBytes(
      header.raw,
      `qualification browser CORS gate.response.headers[${index}].raw`,
      1,
      MAX_HEADER_VALUE_BYTES,
    );
    const browser = expectedVisible
      ? parseExactBytes(
        header.browser,
        `qualification browser CORS gate.response.headers[${index}].browser`,
        1,
        MAX_HEADER_VALUE_BYTES,
      )
      : null;
    if (
      (expectedVisible && !sameExactBytes(raw, browser!)) ||
      (!expectedVisible && header.browser !== null)
    ) {
      throw new Error(
        "Qualification browser CORS gate changed the fixed renderer visibility boundary",
      );
    }
    return {
      name: expectedName,
      raw,
      browser,
      disposition: expectedVisible
        ? "visible_exactly" as const
        : "hidden" as const,
    };
  });
  return {
    schema: CERTIFIED_ASSETS_BROWSER_CORS_SCHEMA,
    engine: { name: "chromium", version: engine.version },
    request: {
      harness_origin: request.harness_origin,
      target_origin: request.target_origin,
      url: target.href,
      mode: "cors",
      credentials: "omit",
      origin_header_exact: true,
      remote_address: {
        ip: "127.0.0.2",
        port: 8000,
      },
    },
    response: {
      status: 200,
      body,
      headers,
      cors_control_headers_hidden: true,
    },
  };
}

function parseMetrics(
  value: unknown,
  names: readonly CertifiedAssetsMetricName[],
  label: string,
): Partial<Record<CertifiedAssetsMetricName, string>> {
  const record = exactRecord(value, [...names], label);
  return Object.fromEntries(
    names.map((name) => [name, decimal(record[name], `${label}.${name}`)]),
  );
}

function parseCandid(value: unknown, label: string): RawCandidObservation {
  const record = exactRecord(
    value,
    ["method", "mode", "reply", "request", "schema"],
    label,
  );
  if (record.schema !== CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA) {
    throw new Error(`${label}.schema is invalid`);
  }
  if (record.mode !== "query" && record.mode !== "update") {
    throw new Error(`${label}.mode is invalid`);
  }
  if (
    typeof record.method !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,191}$/u.test(record.method)
  ) {
    throw new Error(`${label}.method is invalid`);
  }
  return {
    schema: CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA,
    mode: record.mode,
    method: record.method,
    request: parseExactBytes(
      record.request,
      `${label}.request`,
      1,
      MAX_CANDID_REQUEST_BYTES,
    ),
    reply: parseExactBytes(
      record.reply,
      `${label}.reply`,
      1,
      MAX_CANDID_REPLY_BYTES,
    ),
  };
}

function assertBrowserCorsBindsPortableSample(
  browser: CertifiedAssetsBrowserCorsEvidence,
  samples: readonly QualificationSample[],
): void {
  const sample = samples.find(
    ({ case_id: caseId, sample: sampleIndex }) =>
      caseId === "portable_certified_reads" && sampleIndex === 0,
  );
  if (sample === undefined) {
    throw new Error(
      "Qualification browser CORS gate has no portable sample zero",
    );
  }
  const target = new URL(browser.request.url);
  if (target.hostname !== `${sample.canister_id}.localhost`) {
    throw new Error(
      "Qualification browser CORS gate targets a different canister than portable sample zero",
    );
  }
  const matchingRaw = sample.http.filter(
    (observation) =>
      observation.boundary === "raw_query" &&
      observation.method === "GET" &&
      observation.status === 200 &&
      observation.url === browser.request.url &&
      sameExactBytes(observation.body, browser.response.body),
  );
  const matchingGateway = sample.http.filter(
    (observation) =>
      observation.boundary === "gateway" &&
      observation.method === "GET" &&
      observation.status === 200 &&
      observation.url === browser.request.url &&
      sameExactBytes(observation.body, browser.response.body),
  );
  if (matchingRaw.length !== 1 || matchingGateway.length !== 1) {
    throw new Error(
      "Qualification browser CORS gate does not bind one exact verified portable read",
    );
  }
  const rawHeaders = new Map(matchingRaw[0]!.response_headers);
  for (const header of browser.response.headers) {
    // The certificate changes between the raw query and later browser fetch.
    // Its two proofs are verified independently; all fixed policy headers must
    // remain byte-for-byte identical across those boundaries.
    if (header.name === "ic-certificate") continue;
    const value = rawHeaders.get(header.name);
    if (
      value === undefined ||
      !sameExactBytes(header.raw, exactUtf8Bytes(value))
    ) {
      throw new Error(
        `Qualification browser CORS gate changed ${header.name} from its verified portable read`,
      );
    }
  }
}

function exactUtf8Bytes(value: string): ExactBytes {
  const bytes = new TextEncoder().encode(value);
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function parseHttp(
  value: unknown,
  label: string,
  canisterId: string,
  environment: CertifiedAssetsQualificationReceipt["environment"],
): CertifiedHttpObservation {
  const record = exactRecord(
    value,
    [
      "body",
      "boundary",
      "certificate",
      "certificate_time_ns",
      "expression_path",
      "method",
      "request_headers",
      "response_headers",
      "schema",
      "status",
      "url",
      "witness",
    ],
    label,
  );
  if (record.schema !== CERTIFIED_ASSETS_HTTP_OBSERVATION_SCHEMA) {
    throw new Error(`${label}.schema is invalid`);
  }
  if (record.boundary !== "raw_query" && record.boundary !== "gateway") {
    throw new Error(`${label}.boundary is invalid`);
  }
  if (record.method !== "GET" && record.method !== "HEAD") {
    throw new Error(`${label}.method is invalid`);
  }
  if (
    record.status !== 200 &&
    record.status !== 206 &&
    record.status !== 404
  ) {
    throw new Error(`${label}.status is invalid`);
  }
  const url = isolatedCanisterUrl(record.url, canisterId, `${label}.url`);
  const requestHeaders = parseHeaders(
    record.request_headers,
    `${label}.request_headers`,
  );
  const responseHeaders = parseHeaders(
    record.response_headers,
    `${label}.response_headers`,
  );
  const body = parseExactBytes(
    record.body,
    `${label}.body`,
    0,
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.synthetic_plan.limits
      .max_object_bytes,
  );
  if (record.method === "HEAD" && body.bytes !== 0) {
    throw new Error(`${label} records a non-empty HEAD body`);
  }
  if (record.status === 404 && body.bytes !== 0) {
    throw new Error(`${label} records a non-empty certified absence body`);
  }
  const certificate = parseExactBytes(
    record.certificate,
    `${label}.certificate`,
    1,
    MAX_PROOF_BYTES,
  );
  const witness = parseExactBytes(
    record.witness,
    `${label}.witness`,
    1,
    MAX_PROOF_BYTES,
  );
  const expressionPath = parseExactBytes(
    record.expression_path,
    `${label}.expression_path`,
    1,
    MAX_PROOF_BYTES,
  );
  if (
    certificate.bytes + witness.bytes + expressionPath.bytes >
    MAX_PROOF_BYTES
  ) {
    throw new Error(`${label} proof transcript exceeds the release limit`);
  }
  const certificateTime = positiveDecimal(
    record.certificate_time_ns,
    `${label}.certificate_time_ns`,
  );
  const certificateTimeNs = BigInt(certificateTime);
  if (
    certificateTimeNs < BigInt(environment.replica_time_start_ns) ||
    certificateTimeNs > BigInt(environment.replica_time_end_ns)
  ) {
    throw new Error(
      `${label}.certificate_time_ns is outside the measured replica-time window`,
    );
  }
  if (
    record.boundary === "gateway" &&
    (
      certificateTimeNs <
        BigInt(environment.timeline.gateway_phase.start_ns) ||
      certificateTimeNs >
        BigInt(environment.timeline.gateway_phase.end_ns)
    )
  ) {
    throw new Error(
      `${label}.certificate_time_ns is outside the measured gateway phase`,
    );
  }
  return {
    schema: CERTIFIED_ASSETS_HTTP_OBSERVATION_SCHEMA,
    boundary: record.boundary,
    method: record.method,
    url: url.href,
    status: record.status,
    request_headers: requestHeaders,
    response_headers: responseHeaders,
    body,
    certificate,
    witness,
    expression_path: expressionPath,
    certificate_time_ns: certificateTime,
  };
}

function parseHeaders(
  value: unknown,
  label: string,
): readonly (readonly [string, string])[] {
  if (!Array.isArray(value) || value.length > MAX_HEADER_COUNT) {
    throw new Error(`${label} must be a bounded header array`);
  }
  let transcriptBytes = 0;
  const seenNames = new Set<string>();
  const result = value.map((entry, index) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      !HEADER_NAME_PATTERN.test(entry[0]) ||
      entry[0] !== entry[0].toLowerCase() ||
      Buffer.byteLength(entry[0], "utf8") > 128 ||
      Buffer.byteLength(entry[1], "utf8") > MAX_HEADER_VALUE_BYTES ||
      /[\r\n]/u.test(entry[1])
    ) {
      throw new Error(`${label}[${index}] is invalid`);
    }
    if (seenNames.has(entry[0])) {
      throw new Error(`${label} repeats header ${entry[0]}`);
    }
    seenNames.add(entry[0]);
    transcriptBytes +=
      Buffer.byteLength(entry[0], "utf8") +
      Buffer.byteLength(entry[1], "utf8");
    return [entry[0], entry[1]] as const;
  });
  if (transcriptBytes > MAX_HEADER_TRANSCRIPT_BYTES) {
    throw new Error(`${label} exceeds its transcript byte bound`);
  }
  for (let index = 1; index < result.length; index += 1) {
    if (compareHeader(result[index - 1]!, result[index]!) > 0) {
      throw new Error(`${label} is not canonically ordered`);
    }
  }
  return result;
}

function parseExactBytes(
  value: unknown,
  label: string,
  minimumBytes: number,
  maximumBytes: number,
): ExactBytes {
  const record = exactRecord(value, ["bytes", "sha256"], label);
  if (
    typeof record.bytes !== "number" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < minimumBytes ||
    record.bytes > maximumBytes
  ) {
    throw new Error(`${label}.bytes is invalid`);
  }
  const hash = digest(record.sha256, `${label}.sha256`);
  return { bytes: record.bytes, sha256: hash };
}

function assertObservationMetrics(
  metrics: Readonly<Partial<Record<CertifiedAssetsMetricName, string>>>,
  candid: readonly RawCandidObservation[],
  http: readonly CertifiedHttpObservation[],
  label: string,
): void {
  if (metrics.request_candid_bytes !== undefined) {
    assertMetricEquals(
      metrics.request_candid_bytes,
      Math.max(...candid.map(({ request }) => request.bytes)),
      `${label}.metrics.request_candid_bytes`,
    );
  }
  if (metrics.reply_candid_bytes !== undefined) {
    assertMetricEquals(
      metrics.reply_candid_bytes,
      Math.max(...candid.map(({ reply }) => reply.bytes)),
      `${label}.metrics.reply_candid_bytes`,
    );
  }
  if (metrics.proof_bytes !== undefined) {
    if (http.length === 0) {
      throw new Error(`${label}.metrics.proof_bytes has no HTTP observation`);
    }
    assertMetricEquals(
      metrics.proof_bytes,
      Math.max(
        ...http.map(proofBytes),
      ),
      `${label}.metrics.proof_bytes`,
    );
  }
}

function proofBytes(observation: CertifiedHttpObservation): number {
  return (
    observation.certificate.bytes +
    observation.expression_path.bytes +
    observation.witness.bytes
  );
}

function sameExactBytes(left: ExactBytes, right: ExactBytes): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function isolatedCanisterUrl(
  value: unknown,
  canisterId: string,
  label: string,
): URL {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error(`${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== `${canisterId}.localhost` ||
    url.port !== "8000" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    url.href !== value
  ) {
    throw new Error(`${label} is not the isolated PocketIC gateway`);
  }
  return url;
}

function assertMetricEquals(
  actual: string,
  expected: number,
  label: string,
): void {
  if (BigInt(actual) !== BigInt(expected)) {
    throw new Error(`${label} does not match its observation transcript`);
  }
}

function compareHeader(
  left: readonly [string, string],
  right: readonly [string, string],
): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] === right[1]) return 0;
  return left[1] < right[1] ? -1 : 1;
}

function canonicalCanisterId(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is invalid`);
  }
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  const bytes = principal.toUint8Array();
  if (
    principal.toText() !== value ||
    bytes.length < 2 ||
    bytes[bytes.length - 1] !== 1
  ) {
    throw new Error(`${label} is not a canonical canister principal`);
  }
  return value;
}

function parsePrincipals(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error(`${label} must be a bounded principal array`);
  }
  const principals = value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${label}[${index}] is invalid`);
    }
    let principal: Principal;
    try {
      principal = Principal.fromText(entry);
    } catch {
      throw new Error(`${label}[${index}] is invalid`);
    }
    if (principal.toText() !== entry) {
      throw new Error(`${label}[${index}] is not canonical`);
    }
    return entry;
  });
  if (
    new Set(principals).size !== principals.length ||
    principals.some(
      (principal, index) =>
        index > 0 && principals[index - 1]! >= principal,
    )
  ) {
    throw new Error(`${label} must be unique and canonically ordered`);
  }
  return principals;
}

function assertCandidateMatchesCurrentRepository(
  candidate: CertifiedAssetsCandidateBinding,
  repositoryRoot: string,
): void {
  const current = buildCertifiedAssetsCandidateBindingInput(repositoryRoot);
  if (candidate.assembler_id !== ASSEMBLER_ID) {
    throw new Error(
      "Qualification receipt candidate does not bind the current assembler ID",
    );
  }
  const expected: readonly [string, string, string][] = [
    [
      "qualification profile",
      candidate.qualification_profile_sha256,
      current.qualification.profile_sha256,
    ],
    [
      "implementation",
      candidate.implementation_fingerprint_sha256,
      current.implementation.fingerprint_sha256,
    ],
    [
      "synthetic actor source",
      candidate.synthetic_actor_source_sha256,
      current.synthetic_actor.source_sha256,
    ],
    [
      "synthetic actor manifest set",
      candidate.synthetic_actor_manifest_set_sha256,
      current.synthetic_actor.manifest_set.sha256,
    ],
    [
      "qualification runner source",
      candidate.qualification_runner_source_sha256,
      current.runner.source_set_sha256,
    ],
    [
      "Motoko package source set",
      candidate.motoko_package_source_set_sha256,
      current.motoko_packages.source_set_sha256,
    ],
    [
      "package lock",
      candidate.package_lock_sha256,
      current.package_lock.sha256,
    ],
  ];
  for (const [label, observed, wanted] of expected) {
    if (observed !== wanted) {
      throw new Error(
        `Qualification receipt candidate does not bind the current ${label}`,
      );
    }
  }
}

function assertFocusedMotokoSourcesCurrent(
  gate: FocusedMotokoGateObservation,
  repositoryRoot: string,
): void {
  for (const testFile of gate.test_files) {
    const current = createHash("sha256")
      .update(readFileSync(path.join(repositoryRoot, testFile.path)))
      .digest("hex");
    if (testFile.source_sha256 !== current) {
      throw new Error(
        `Qualification focused Motoko gate does not bind current source ${testFile.path}`,
      );
    }
  }
}

function metricReleaseLimit(metric: CertifiedAssetsMetricName): number {
  const value = Number(
    CERTIFIED_ASSETS_METRIC_DEFINITIONS.find(
      (definition) => definition.metric === metric,
    )!.release_limit,
  );
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Qualification metric ${metric} has an unsafe release limit`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has an invalid field set`);
  }
  return record;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function decimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical decimal integer`);
  }
  return value;
}

function positiveDecimal(value: unknown, label: string): string {
  const result = decimal(value, label);
  if (result === "0") throw new Error(`${label} must be positive`);
  return result;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Canonical qualification JSON accepts only safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("Canonical qualification JSON contains an unsupported value");
}
