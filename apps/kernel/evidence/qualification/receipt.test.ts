import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Principal } from "@dfinity/principal";
import { ASSEMBLER_ID } from "neutron-compiler/src/assemble.js";
import { compilerSourceFingerprint } from "neutron-provision/src/compiler_fingerprint.js";
import {
  POCKET_IC_ARTIFACTS,
  POCKET_IC_SERVER_VERSION,
} from "neutron-provision/src/pocketic_binary.js";
import { physicalAppMethodName } from "neutron-tools/src/physical_names.js";
import {
  CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_CASES,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
  CERTIFIED_ASSETS_SYNTHETIC_PLAN_SHA256,
  type CertifiedAssetsCandidateBinding,
} from "neutron-tools/src/certified_assets_qualification.js";
import {
  SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
} from "neutron-tools/src/wasm_metadata.js";
import {
  buildCertifiedAssetsCandidateBindingInput,
} from "../certified_assets_candidate_binding.ts";
import {
  CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
  PHYSICAL_ABSENCE_WITNESS_CANDIDATES,
  PHYSICAL_POPULATION_APP_ID,
  PHYSICAL_POPULATION_BATCHES,
  PHYSICAL_POPULATION_ENTRIES,
  PHYSICAL_POPULATION_FINAL_USAGE,
  PHYSICAL_POPULATION_RECEIPT_LIMIT,
  PHYSICAL_PRESENT_WITNESS_CANDIDATES,
  physicalReceiptReclaimedChargedBytes,
  physicalPopulationReceiptRollovers,
  type PhysicalPopulationUsageExpectation,
} from "./physical_population.ts";
import {
  CERTIFIED_ASSETS_BROWSER_CORS_SCHEMA,
} from "./browser_cors.ts";
import {
  CERTIFIED_ASSETS_HOSTILE_HTTP_GATE_SCHEMA,
  CERTIFIED_ASSETS_HTTP_OBSERVATION_SCHEMA,
  CERTIFIED_ASSETS_MOTOKO_GATES_SCHEMA,
  CERTIFIED_ASSETS_ONE_OVER_GATE_SCHEMA,
  CERTIFIED_ASSETS_BOUNDED_PHYSICAL_OBSERVATION_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_GATES_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA,
  CERTIFIED_ASSETS_QUALIFICATION_SAMPLE_SCHEMA,
  CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA,
  CERTIFIED_ASSETS_UPGRADE_GATE_SCHEMA,
  assertCertifiedAssetsQualificationReceipt,
  certifiedAssetsQualificationRunnerSourceSha256,
  parseCertifiedAssetsQualificationReceipt,
  qualificationPhysicalBatchTranscriptSha256,
  qualificationReceiptBytes,
  qualificationReceiptSha256,
  type CertifiedAssetsQualificationReceipt,
  type ExactBytes,
  type QualificationSample,
} from "./receipt.ts";

const HASH = "ab".repeat(32);
const TRANSPORT_WASM_HASH = "cd".repeat(32);
const POCKET_IC_BINARY_SHA256 = POCKET_IC_ARTIFACTS[0]!.binarySha256;
const REPLICA_TIME_START_NS = 1_735_689_600_000_000_000n;
const MANUAL_REPLICA_TIME_END_NS =
  physicalPopulationReceiptRollovers().reduce(
    (time, rollover) => time + rollover.advance_time_ns,
    REPLICA_TIME_START_NS,
  );
const TARGET_HOST_WALL_NS =
  MANUAL_REPLICA_TIME_END_NS + 1_000_000_000n;
const WALL_NORMALIZATION_AFTER_NS = TARGET_HOST_WALL_NS;
const GATEWAY_PHASE_START_NS = WALL_NORMALIZATION_AFTER_NS;
const GATEWAY_PHASE_END_NS =
  GATEWAY_PHASE_START_NS + 10_000_000_000n;
const REPLICA_TIME_END_NS = GATEWAY_PHASE_END_NS + 1_000_000_000n;
const CERTIFICATE_TIME_NS = GATEWAY_PHASE_START_NS + 1n;
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../../..");
const COMPILER_SOURCE_FINGERPRINT =
  await compilerSourceFingerprint(REPOSITORY_ROOT);
const CURRENT_BINDING_INPUT = buildCertifiedAssetsCandidateBindingInput();

type DeepMutable<T> =
  T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;

const CANDID_BYTES = exactBytes(new Uint8Array([0x44, 0x49, 0x44, 0x4c]));
const HTTP_BODY = exactBytes(new TextEncoder().encode("qualified"));
const EMPTY_BODY = exactBytes(new Uint8Array());
const EXPRESSION_PATH = exactBytes(new Uint8Array([0x80]));
const WASMTIME_BINARY = exactBytes(
  new TextEncoder().encode("pinned wasmtime test binary"),
);

const CANDID_OBSERVATION = {
  schema: CERTIFIED_ASSETS_RAW_CANDID_OBSERVATION_SCHEMA,
  mode: "query" as const,
  method: "kernel_ca_scope_usage",
  request: CANDID_BYTES,
  reply: CANDID_BYTES,
};

const CANDIDATE: CertifiedAssetsCandidateBinding = {
  schema: CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA,
  qualification_contract_sha256:
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
  synthetic_plan_sha256: CERTIFIED_ASSETS_SYNTHETIC_PLAN_SHA256,
  qualification_profile_sha256:
    CURRENT_BINDING_INPUT.qualification.profile_sha256,
  implementation_fingerprint_sha256:
    CURRENT_BINDING_INPUT.implementation.fingerprint_sha256,
  compiler_source_fingerprint_sha256: COMPILER_SOURCE_FINGERPRINT,
  compiler_id: "moc_test",
  assembler_id: ASSEMBLER_ID,
  synthetic_actor_source_sha256:
    CURRENT_BINDING_INPUT.synthetic_actor.source_sha256,
  synthetic_actor_manifest_set_sha256:
    CURRENT_BINDING_INPUT.synthetic_actor.manifest_set.sha256,
  qualification_runner_source_sha256:
    CURRENT_BINDING_INPUT.runner.source_set_sha256,
  motoko_package_source_set_sha256:
    CURRENT_BINDING_INPUT.motoko_packages.source_set_sha256,
  qualified_raw_wasm_sha256: HASH,
  qualified_transport_wasm_sha256: TRANSPORT_WASM_HASH,
  package_lock_sha256: CURRENT_BINDING_INPUT.package_lock.sha256,
  supported_certificate_versions:
    SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
};

describe("Certified Assets qualification receipt", () => {
  test("accepts and canonically serializes a complete pass receipt", async () => {
    const receipt = validReceipt();

    expect(
      await assertCertifiedAssetsQualificationReceipt(receipt),
    ).toEqual(receipt);
    expect(
      Object.keys(receipt.samples[0]!.http[0]!.body).sort(),
    ).toEqual(["bytes", "sha256"]);
    const bytes = await qualificationReceiptBytes(receipt);
    expect(bytes.at(-1)).toBe(10);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(receipt);
    expect(
      qualificationReceiptSha256(
        {} as Omit<
          CertifiedAssetsQualificationReceipt,
          "receipt_sha256"
        >,
      ),
    ).toBe(
      "6c07c6b8b132350c099f4b0ca34921653cc1308c45bc3e858b392398a09f83b3",
    );
  });

  test("rejects schema and non-canonical sample ordering even with a recomputed digest", async () => {
    const schema = tamperedReceipt((receipt) => {
      (receipt as unknown as { schema: string }).schema =
        "neutron.kernel.certified-assets-qualification-receipt.v1";
    });
    await expect(assertCertifiedAssetsQualificationReceipt(schema)).rejects.toThrow(
      "receipt schema is invalid",
    );

    const sample = tamperedReceipt((receipt) => {
      [receipt.samples[0], receipt.samples[1]] = [
        receipt.samples[1]!,
        receipt.samples[0]!,
      ];
    });
    await expect(assertCertifiedAssetsQualificationReceipt(sample)).rejects.toThrow(
      "not in canonical case/sample order",
    );
  });

  test("rejects checkpoint and byte-descriptor tampering even with a recomputed digest", async () => {
    const checkpoint = tamperedReceipt((receipt) => {
      receipt.samples[0]!.checkpoints[0] = "claimed_without_execution";
    });
    await expect(assertCertifiedAssetsQualificationReceipt(checkpoint)).rejects.toThrow(
      "does not prove every ordered checkpoint",
    );

    const rawBytes = tamperedReceipt((receipt) => {
      (
        receipt.samples[0]!.candid[0]!.request as unknown as Record<
          string,
          unknown
        >
      ).base64 = Buffer.from("embedded bytes are forbidden").toString(
        "base64",
      );
    });
    await expect(assertCertifiedAssetsQualificationReceipt(rawBytes)).rejects.toThrow(
      "has an invalid field set",
    );
  });

  test("rejects module and metric tampering even with a recomputed digest", async () => {
    const module = tamperedReceipt((receipt) => {
      receipt.samples[0]!.installed_transport_wasm_sha256 = HASH;
    });
    await expect(assertCertifiedAssetsQualificationReceipt(module)).rejects.toThrow(
      "used a different module",
    );

    const metric = tamperedReceipt((receipt) => {
      receipt.samples[0]!.metrics.low_side_cycle_estimate = "40000000001";
    });
    await expect(assertCertifiedAssetsQualificationReceipt(metric)).rejects.toThrow(
      "low_side_cycle_estimate measured 40000000001, exceeding release limit 40000000000",
    );
  });

  test("rejects a stale receipt digest", async () => {
    const receipt = clone(validReceipt());
    receipt.environment.topology_sha256 = TRANSPORT_WASM_HASH;

    await expect(assertCertifiedAssetsQualificationReceipt(receipt)).rejects.toThrow(
      "receipt digest does not match its contents",
    );
  });

  test("rejects a caller-selected runner digest even with a valid receipt digest", async () => {
    const receipt = tamperedReceipt((candidate) => {
      candidate.runner.source_sha256 = HASH;
      candidate.candidate.qualification_runner_source_sha256 = HASH;
    });

    expect(
      parseCertifiedAssetsQualificationReceipt(receipt as unknown).runner
        .source_sha256,
    ).toBe(HASH);
    await expect(assertCertifiedAssetsQualificationReceipt(receipt)).rejects.toThrow(
      "does not bind the current checked-out runner source",
    );
  });

  test("rejects observation summaries that disagree with their metrics", async () => {
    const receipt = tamperedReceipt((candidate) => {
      candidate.samples[0]!.metrics.request_candid_bytes = "5";
    });
    await expect(assertCertifiedAssetsQualificationReceipt(receipt)).rejects.toThrow(
      "does not match its observation transcript",
    );
  });

  test("rejects duplicate canisters and certificates outside the run window", async () => {
    const duplicate = tamperedReceipt((receipt) => {
      receipt.samples[1]!.canister_id = receipt.samples[0]!.canister_id;
      receipt.samples[1]!.http[0]!.url =
        receipt.samples[0]!.http[0]!.url;
    });
    await expect(assertCertifiedAssetsQualificationReceipt(duplicate)).rejects.toThrow(
      "reuses canister",
    );

    const staleCertificate = tamperedReceipt((receipt) => {
      receipt.samples[0]!.http[0]!.certificate_time_ns = "11";
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(staleCertificate),
    ).rejects.toThrow("outside the measured replica-time window");
  });

  test("rejects tampered manual and wall-clock timelines", async () => {
    const start = tamperedReceipt((receipt) => {
      receipt.environment.replica_time_start_ns =
        (REPLICA_TIME_START_NS + 1n).toString();
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(start),
    ).rejects.toThrow("replica time must start");

    const requested = tamperedReceipt((receipt) => {
      receipt.bounded_physical_sample.receipt_rollovers[0]!.clock
        .requested_delta_ns = "86400000000000";
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(requested),
    ).rejects.toThrow("does not bind the exact manual advance");

    const after = tamperedReceipt((receipt) => {
      const clock =
        receipt.bounded_physical_sample.receipt_rollovers[0]!.clock;
      clock.after_ns = (BigInt(clock.after_ns) + 1n).toString();
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(after),
    ).rejects.toThrow("does not bind the exact manual advance");

    const normalizationStart = tamperedReceipt((receipt) => {
      receipt.environment.timeline.wall_normalization.before_ns =
        (MANUAL_REPLICA_TIME_END_NS + 1n).toString();
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(normalizationStart),
    ).rejects.toThrow(
      "does not continue the physical manual-clock timeline",
    );

    const normalizationTarget = tamperedReceipt((receipt) => {
      receipt.environment.timeline.wall_normalization
        .target_host_wall_ns =
          receipt.environment.timeline.wall_normalization.before_ns;
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(normalizationTarget),
    ).rejects.toThrow("wall normalization timeline is invalid");

    const historicalAutoProgress = tamperedReceipt((receipt) => {
      (
        receipt.environment.timeline as unknown as {
          historical_auto_progress: boolean;
        }
      ).historical_auto_progress = true;
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(
        historicalAutoProgress,
      ),
    ).rejects.toThrow(
      "historical automatic progress must be false",
    );

    const autoProgress = tamperedReceipt((receipt) => {
      (
        receipt.environment.timeline
          .wall_normalization as unknown as {
          auto_progress_before: boolean;
        }
      ).auto_progress_before = true;
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(autoProgress),
    ).rejects.toThrow(
      "must transition automatic progress from false to true",
    );

    const gatewayOrder = tamperedReceipt((receipt) => {
      receipt.environment.timeline.gateway_phase.start_ns =
        (WALL_NORMALIZATION_AFTER_NS - 1n).toString();
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(gatewayOrder),
    ).rejects.toThrow("gateway phase timeline is invalid");

    const lateGatewayStart = tamperedReceipt((receipt) => {
      receipt.environment.timeline.gateway_phase.start_ns =
        (WALL_NORMALIZATION_AFTER_NS + 1n).toString();
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(lateGatewayStart),
    ).rejects.toThrow("gateway phase timeline is invalid");
  });

  test("brackets every gateway certificate in the gateway phase", async () => {
    const before = tamperedReceipt((receipt) => {
      const observation = receipt.samples
        .flatMap(({ http }) => http)
        .find(({ boundary }) => boundary === "gateway")!;
      observation.certificate_time_ns =
        (GATEWAY_PHASE_START_NS - 1n).toString();
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(before),
    ).rejects.toThrow("outside the measured gateway phase");

    const after = tamperedReceipt((receipt) => {
      const observation = receipt.samples
        .flatMap(({ http }) => http)
        .find(({ boundary }) => boundary === "gateway")!;
      observation.certificate_time_ns =
        (GATEWAY_PHASE_END_NS + 1n).toString();
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(after),
    ).rejects.toThrow("outside the measured gateway phase");

    const missingPublicationGateway = tamperedReceipt((receipt) => {
      const publication = receipt.samples.find(
        ({ case_id: caseId }) =>
          caseId === "publication_lifecycle",
      )!;
      publication.http.splice(1, 1);
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(
        missingPublicationGateway,
      ),
    ).rejects.toThrow("does not contain exact raw/gateway pairs");

    const changedSampleGatewayWitness = tamperedReceipt((receipt) => {
      const gatewaySample = receipt.samples.find(
        ({ http }) =>
          http.some(({ boundary }) => boundary === "gateway"),
      )!;
      const gateway = gatewaySample.http[1]!;
      gateway.witness = {
        ...gateway.witness,
        sha256: "ef".repeat(32),
      };
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(
        changedSampleGatewayWitness,
      ),
    ).rejects.toThrow("does not have one exact gateway counterpart");
  });

  test("requires the deterministic bounded physical sample evidence", async () => {
    const schema = tamperedReceipt((receipt) => {
      (
        receipt.bounded_physical_sample as unknown as {
          schema: string;
        }
      ).schema =
        "neutron.kernel.certified-assets-bounded-physical-sample.v0";
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(schema),
    ).rejects.toThrow("bounded-physical-sample schema is invalid");

    const count = tamperedReceipt((receipt) => {
      receipt.bounded_physical_sample.final_entry_count =
        PHYSICAL_POPULATION_ENTRIES - 1;
    });
    await expect(assertCertifiedAssetsQualificationReceipt(count)).rejects.toThrow(
      `must contain exactly ${PHYSICAL_POPULATION_ENTRIES} entries`,
    );

    const proof = tamperedReceipt((receipt) => {
      receipt.bounded_physical_sample.absence_proof_bytes = "10";
    });
    await expect(assertCertifiedAssetsQualificationReceipt(proof)).rejects.toThrow(
      "does not match its observation transcript",
    );

    const missingGateway = tamperedReceipt((receipt) => {
      receipt.bounded_physical_sample.present_candidate_observations.splice(
        1,
        1,
      );
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(missingGateway),
    ).rejects.toThrow("does not bind every paired present witness");

    const changedGatewayWitness = tamperedReceipt((receipt) => {
      const gateway =
        receipt.bounded_physical_sample.present_candidate_observations[1]!;
      gateway.witness = {
        ...gateway.witness,
        sha256: "ef".repeat(32),
      };
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(
        changedGatewayWitness,
      ),
    ).rejects.toThrow("is not the exact gateway counterpart");

    const unbracketedGateway = tamperedReceipt((receipt) => {
      receipt.bounded_physical_sample.present_candidate_observations[1]!
        .certificate_time_ns =
          (GATEWAY_PHASE_START_NS - 1n).toString();
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(
        unbracketedGateway,
      ),
    ).rejects.toThrow("outside the measured gateway phase");
  });

  test("rejects privileged-gate and browser-boundary tampering", async () => {
    const upgrade = tamperedReceipt((receipt) => {
      receipt.gates.same_wasm_upgrade.canister_version_after = "10";
    });
    await expect(assertCertifiedAssetsQualificationReceipt(upgrade)).rejects.toThrow(
      "did not advance canister_version",
    );

    const focusedSource = tamperedReceipt((receipt) => {
      receipt.gates.focused_motoko.test_files[0]!.source_sha256 = HASH;
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(focusedSource),
    ).rejects.toThrow("does not bind current source");

    const wasmtimeVersion = tamperedReceipt((receipt) => {
      receipt.gates.focused_motoko.wasmtime.version =
        "caller-selected wasmtime";
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(wasmtimeVersion),
    ).rejects.toThrow("Wasmtime version is invalid");

    const wasmtimeBinary = tamperedReceipt((receipt) => {
      receipt.gates.focused_motoko.wasmtime.binary.sha256 = "not-a-digest";
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(wasmtimeBinary),
    ).rejects.toThrow("must be a lowercase SHA-256 digest");

    const hostileHeaders = tamperedReceipt((receipt) => {
      receipt.gates.hostile_raw_http.request_headers.push([
        "x-extra",
        "not-allowed",
      ]);
    });
    await expect(
      assertCertifiedAssetsQualificationReceipt(hostileHeaders),
    ).rejects.toThrow("exact fixed request headers");

    const remote = tamperedReceipt((receipt) => {
      (
        receipt.gates.browser_cors.request.remote_address as unknown as {
          ip: string;
        }
      ).ip = "127.0.0.1";
    });
    await expect(assertCertifiedAssetsQualificationReceipt(remote)).rejects.toThrow(
      "did not bind the isolated gateway socket",
    );
  });
});

function validReceipt(): CertifiedAssetsQualificationReceipt {
  const samplesPerCase =
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.minimum_samples_per_case;
  const samples = CERTIFIED_ASSETS_QUALIFICATION_CASES.flatMap((definition) =>
    Array.from({ length: samplesPerCase }, (_, index) => index).map(
      (sample, sampleIndex): QualificationSample => {
        const caseIndex = CERTIFIED_ASSETS_QUALIFICATION_CASES.indexOf(
          definition,
        );
        const canisterId = canisterPrincipal(
          caseIndex * samplesPerCase + sampleIndex + 1,
        );
        const gatewayEnabled =
          definition.id === "publication_lifecycle" ||
          definition.metrics.some(
            (metric) => metric === "proof_bytes",
          );
        return {
          schema: CERTIFIED_ASSETS_QUALIFICATION_SAMPLE_SCHEMA,
          case_id: definition.id,
          sample,
          canister_id: canisterId,
          installed_transport_wasm_sha256: TRANSPORT_WASM_HASH,
          checkpoints: [...definition.checkpoints],
          metrics: Object.fromEntries(
            definition.metrics.map((metric) => [
              metric,
              metric === "request_candid_bytes" ||
                metric === "reply_candid_bytes"
                ? String(CANDID_BYTES.bytes)
                : metric === "proof_bytes"
                  ? String(
                      CANDID_BYTES.bytes * 2 + EXPRESSION_PATH.bytes,
                    )
                  : "0",
            ]),
          ),
          candid: [CANDID_OBSERVATION],
          http: gatewayEnabled
            ? [
                httpObservation(canisterId, "raw_query"),
                httpObservation(canisterId, "gateway"),
              ]
            : [httpObservation(canisterId, "raw_query")],
        };
      },
    ),
  );
  const unsigned: Omit<
    CertifiedAssetsQualificationReceipt,
    "receipt_sha256"
  > = {
    schema: CERTIFIED_ASSETS_QUALIFICATION_RECEIPT_SCHEMA,
    status: "passed",
    candidate: CANDIDATE,
    environment: {
      profile: "minimal",
      isolation: "fresh_temporary_pocketic_v1",
      pocketic_version: POCKET_IC_SERVER_VERSION,
      pocketic_binary_sha256: POCKET_IC_BINARY_SHA256,
      instance_config_sha256: HASH,
      topology_sha256: HASH,
      root_key_sha256: HASH,
      replica_time_start_ns: REPLICA_TIME_START_NS.toString(),
      replica_time_end_ns: REPLICA_TIME_END_NS.toString(),
      timeline: {
        historical_auto_progress: false,
        wall_normalization: {
          before_ns: MANUAL_REPLICA_TIME_END_NS.toString(),
          target_host_wall_ns: TARGET_HOST_WALL_NS.toString(),
          after_ns: WALL_NORMALIZATION_AFTER_NS.toString(),
          auto_progress_before: false,
          auto_progress_after: true,
        },
        gateway_phase: {
          start_ns: GATEWAY_PHASE_START_NS.toString(),
          end_ns: GATEWAY_PHASE_END_NS.toString(),
        },
      },
    },
    runner: {
      contract_sha256: CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
      source_sha256: certifiedAssetsQualificationRunnerSourceSha256(),
    },
    samples,
    bounded_physical_sample: boundedPhysicalSampleObservation(),
    gates: gateObservations(samples),
  };
  return {
    ...unsigned,
    receipt_sha256: qualificationReceiptSha256(unsigned),
  };
}

function tamperedReceipt(
  mutate: (receipt: DeepMutable<CertifiedAssetsQualificationReceipt>) => void,
): DeepMutable<CertifiedAssetsQualificationReceipt> {
  const receipt = clone(validReceipt());
  mutate(receipt);
  const { receipt_sha256: _previous, ...unsigned } = receipt;
  receipt.receipt_sha256 = qualificationReceiptSha256(
    unsigned as unknown as Omit<
      CertifiedAssetsQualificationReceipt,
      "receipt_sha256"
    >,
  );
  return receipt;
}

function clone<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function exactBytes(bytes: Uint8Array): ExactBytes {
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function httpObservation(
  canisterId: string,
  boundary: "raw_query" | "gateway" = "raw_query",
) {
  return {
    schema: CERTIFIED_ASSETS_HTTP_OBSERVATION_SCHEMA,
    boundary,
    method: "GET" as const,
    url: `http://${canisterId}.localhost:8000/qualified`,
    status: 200 as const,
    request_headers: [] as const,
    response_headers: [
      ["content-digest", "content-digest-value"],
      ["content-length", "content-length-value"],
      ["content-type", "application/octet-stream"],
      ["etag", "etag-value"],
      [
        "ic-certificateexpression",
        "ic-certificateexpression-value",
      ],
    ] as const,
    body: HTTP_BODY,
    certificate: CANDID_BYTES,
    witness: CANDID_BYTES,
    expression_path: EXPRESSION_PATH,
    certificate_time_ns: CERTIFICATE_TIME_NS.toString(),
  };
}

function boundedPhysicalSampleObservation() {
  const samplesPerCase =
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.minimum_samples_per_case;
  const canisterId = canisterPrincipal(
    CERTIFIED_ASSETS_QUALIFICATION_CASES.length * samplesPerCase + 1,
  );
  const presentCandidate = PHYSICAL_PRESENT_WITNESS_CANDIDATES[0]!;
  const absenceCandidate = PHYSICAL_ABSENCE_WITNESS_CANDIDATES[0]!;
  const present = {
    ...httpObservation(canisterId),
    url: `http://${canisterId}.localhost:8000${presentCandidate.path}`,
    body: exactBytes(presentCandidate.body),
  };
  const absence = {
    ...httpObservation(canisterId),
    url: `http://${canisterId}.localhost:8000${absenceCandidate.path}`,
    status: 404 as const,
    body: EMPTY_BODY,
  };
  const proofBytes =
    CANDID_BYTES.bytes * 2 + EXPRESSION_PATH.bytes;
  let clockBeforeNs = REPLICA_TIME_START_NS;
  const receiptRollovers = physicalPopulationReceiptRollovers().map(
    (rollover) => {
      const clockAfterNs = clockBeforeNs + rollover.advance_time_ns;
      const observation = {
        after_batch_count: rollover.after_batch_count,
        clock: {
          before_ns: clockBeforeNs.toString(),
          requested_delta_ns: rollover.advance_time_ns.toString(),
          after_ns: clockAfterNs.toString(),
        },
        maintenance_pages: Array.from(
          { length: rollover.expected_maintenance_pages },
          (_, pageIndex) => ({
            page_index: pageIndex,
            call: {
              ...CANDID_OBSERVATION,
              mode: "update" as const,
              method: physicalAppMethodName(
                PHYSICAL_POPULATION_APP_ID,
                "qualification_maintenance_page",
              ),
            },
            reclaimed: {
              records: "0",
              bodies: "0",
              body_bytes: "0",
              charged_bytes:
                physicalReceiptReclaimedChargedBytes(
                  Math.min(
                    CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
                    rollover.expected_receipts_reclaimed -
                      pageIndex *
                        CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
                  ),
                ).toString(),
            authenticated_nodes: "0",
              receipts: Math.min(
                CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
                rollover.expected_receipts_reclaimed -
                  pageIndex *
                    CERTIFIED_ASSETS_MAINTENANCE_RECEIPTS_PER_PAGE,
              ).toString(),
            },
            has_more:
              pageIndex + 1 < rollover.expected_maintenance_pages,
            remaining_jobs: "0",
          }),
        ),
        usage_before: {
          ...CANDID_OBSERVATION,
          method: physicalAppMethodName(
            PHYSICAL_POPULATION_APP_ID,
            "qualification_usage",
          ),
        },
        usage_before_decoded: usageSummary(rollover.usage_before),
        usage_after: {
          ...CANDID_OBSERVATION,
          method: physicalAppMethodName(
            PHYSICAL_POPULATION_APP_ID,
            "qualification_usage",
          ),
        },
        usage_after_decoded: usageSummary(rollover.usage_after),
        reclaimed_receipts_total:
          PHYSICAL_POPULATION_RECEIPT_LIMIT.toString(),
        checkpoint: "general_receipt_ceiling_reclaimed" as const,
      };
      clockBeforeNs = clockAfterNs;
      return observation;
    },
  );
  const fullUsage = usageSummary(PHYSICAL_POPULATION_FINAL_USAGE);
  const batchCall = {
    ...CANDID_OBSERVATION,
    mode: "update" as const,
    method: physicalAppMethodName(
      PHYSICAL_POPULATION_APP_ID,
      "qualification_commit_batch",
    ),
  };
  const batchTranscriptSha256 =
    qualificationPhysicalBatchTranscriptSha256(
      Array.from({ length: PHYSICAL_POPULATION_BATCHES }, () => batchCall),
    );
  const presentCandidateObservations =
    PHYSICAL_PRESENT_WITNESS_CANDIDATES.flatMap((candidate) => {
      const raw = {
        ...httpObservation(canisterId),
        url: `http://${canisterId}.localhost:8000${candidate.path}`,
        body: exactBytes(candidate.body),
      };
      return [
        raw,
        {
          ...raw,
          boundary: "gateway" as const,
        },
      ];
    });
  const absenceCandidateObservations =
    PHYSICAL_ABSENCE_WITNESS_CANDIDATES.flatMap((candidate) => {
      const raw = {
        ...httpObservation(canisterId),
        url: `http://${canisterId}.localhost:8000${candidate.path}`,
        status: 404 as const,
        body: EMPTY_BODY,
      };
      return [
        raw,
        {
          ...raw,
          boundary: "gateway" as const,
        },
      ];
    });
  return {
    schema: CERTIFIED_ASSETS_BOUNDED_PHYSICAL_OBSERVATION_SCHEMA,
    canister_id: canisterId,
    installed_transport_wasm_sha256: TRANSPORT_WASM_HASH,
    batch_count: PHYSICAL_POPULATION_BATCHES,
    batch_transcript_sha256: batchTranscriptSha256,
    final_entry_count: PHYSICAL_POPULATION_ENTRIES,
    receipt_rollovers: receiptRollovers,
    usage_before_overflow: {
      ...CANDID_OBSERVATION,
      method: physicalAppMethodName(
        PHYSICAL_POPULATION_APP_ID,
        "qualification_usage",
      ),
    },
    usage_before_overflow_decoded: fullUsage,
    overflow_call: {
      ...CANDID_OBSERVATION,
      mode: "update" as const,
      method: physicalAppMethodName(
        PHYSICAL_POPULATION_APP_ID,
        "qualification_commit_batch",
      ),
    },
    usage_after_overflow: {
      ...CANDID_OBSERVATION,
      method: physicalAppMethodName(
        PHYSICAL_POPULATION_APP_ID,
        "qualification_usage",
      ),
    },
    usage_after_overflow_decoded: fullUsage,
    overflow_checkpoint:
      "entry_quota_rejected_without_state_drift" as const,
    present_candidates_queried:
      PHYSICAL_PRESENT_WITNESS_CANDIDATES.length,
    present_candidate_observations: presentCandidateObservations,
    present: presentCandidateObservations[0]!,
    present_proof_bytes: String(proofBytes),
    absence_candidates_queried:
      PHYSICAL_ABSENCE_WITNESS_CANDIDATES.length,
    absence_candidate_observations: absenceCandidateObservations,
    absence: absenceCandidateObservations[0]!,
    absence_proof_bytes: String(proofBytes),
  };
}

function usageSummary(
  usage: PhysicalPopulationUsageExpectation,
): Record<keyof PhysicalPopulationUsageExpectation, string> {
  return Object.fromEntries(
    Object.entries(usage).map(([key, value]) => [key, value.toString()]),
  ) as Record<keyof PhysicalPopulationUsageExpectation, string>;
}

function gateObservations(samples: readonly QualificationSample[]) {
  const samplesPerCase =
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.minimum_samples_per_case;
  const canisterId = canisterPrincipal(
    CERTIFIED_ASSETS_QUALIFICATION_CASES.length * samplesPerCase + 2,
  );
  const portableSample = samples.find(
    ({ case_id: caseId, sample }) =>
      caseId === "portable_certified_reads" && sample === 0,
  )!;
  const portableRead = portableSample.http.find(
    ({ boundary, status }) => boundary === "raw_query" && status === 200,
  )!;
  const controller = canisterPrincipal(10_000);
  const beforeRead = {
    ...httpObservation(canisterId, "raw_query"),
    url: `http://${canisterId}.localhost:8000/upgrade-record`,
  };
  const afterRead = {
    ...beforeRead,
    certificate_time_ns: (CERTIFICATE_TIME_NS + 1n).toString(),
  };
  const recordStatus = {
    ...CANDID_OBSERVATION,
    method: physicalAppMethodName(
      "ca_qualification_aux_1",
      "qualification_record_status",
    ),
  };
  const passLines = [
    "Motoko test passed: authenticated_forest_test.mo",
    "Motoko test passed: certified_assets_allocator_test.mo",
    "Motoko test passed: certified_assets_service_test.mo",
  ] as const;
  const focusedTests = [
    "apps/kernel/test/motoko/authenticated_forest_test.mo",
    "apps/kernel/test/motoko/certified_assets_allocator_test.mo",
    "apps/kernel/test/motoko/certified_assets_service_test.mo",
  ] as const;
  return {
    schema: CERTIFIED_ASSETS_QUALIFICATION_GATES_SCHEMA,
    focused_motoko: {
      schema: CERTIFIED_ASSETS_MOTOKO_GATES_SCHEMA,
      wasmtime: {
        version: "wasmtime 26.0.1",
        binary: WASMTIME_BINARY,
      },
      test_files: focusedTests.map((testPath) => ({
        path: testPath,
        source_sha256: createHash("sha256")
          .update(readFileSync(path.join(REPOSITORY_ROOT, testPath)))
          .digest("hex"),
      })),
      expected_pass_lines: passLines,
      stdout: exactBytes(
        new TextEncoder().encode(`${passLines.join("\n")}\n`),
      ),
    },
    same_wasm_upgrade: {
      schema: CERTIFIED_ASSETS_UPGRADE_GATE_SCHEMA,
      canister_id: canisterId,
      status_before: "running" as const,
      canister_version_before: "10",
      controllers_before: [controller],
      installed_transport_wasm_sha256_before: TRANSPORT_WASM_HASH,
      upgrade_call: {
        ...CANDID_OBSERVATION,
        mode: "update" as const,
        method: "install_chunked_code",
      },
      status_after: "running" as const,
      canister_version_after: "11",
      controllers_after: [controller],
      installed_transport_wasm_sha256_after: TRANSPORT_WASM_HASH,
      record_status_before: recordStatus,
      record_status_after: recordStatus,
      certified_read_before: beforeRead,
      certified_read_after: afterRead,
    },
    hostile_raw_http: {
      schema: CERTIFIED_ASSETS_HOSTILE_HTTP_GATE_SCHEMA,
      canister_id: canisterId,
      installed_transport_wasm_sha256: TRANSPORT_WASM_HASH,
      call: {
        ...CANDID_OBSERVATION,
        method: "http_request",
      },
      url: `http://${canisterId}.localhost:8000/upgrade-record`,
      request_headers: [
        ["host", `${canisterId}.localhost:8000`],
        ["range", "bytes=0-1,2-3"],
      ] as const,
      status_code: 400 as const,
      response_headers: [["cache-control", "no-store"]] as const,
      body: EMPTY_BODY,
      streaming_strategy_entries: 0 as const,
      upgrade_entries: 0 as const,
    },
    physical_one_over: {
      schema: CERTIFIED_ASSETS_ONE_OVER_GATE_SCHEMA,
      attempted_entries: 100_001 as const,
      maximum_entries: 100_000 as const,
      manifest: exactBytes(
        new TextEncoder().encode('{"max_entries":100001}\n'),
      ),
      validation_error: {
        instance_path: "/capabilities/certified_assets/max_entries",
        schema_path:
          "#/properties/capabilities/properties/certified_assets/properties/max_entries/maximum",
        keyword: "maximum" as const,
        canonical_sha256: HASH,
      },
    },
    browser_cors: {
      schema: CERTIFIED_ASSETS_BROWSER_CORS_SCHEMA,
      engine: {
        name: "chromium" as const,
        version: "145.0.0.0",
      },
      request: {
        harness_origin: "http://127.0.0.1:32123",
        target_origin: `http://${portableSample.canister_id}.localhost:8000`,
        url: portableRead.url,
        mode: "cors" as const,
        credentials: "omit" as const,
        origin_header_exact: true as const,
        remote_address: {
          ip: "127.0.0.2" as const,
          port: 8000 as const,
        },
      },
      response: {
        status: 200 as const,
        body: portableRead.body,
        headers: [
          "ic-certificate",
          "ic-certificateexpression",
          "content-length",
          "content-digest",
          "etag",
        ].map((name) => ({
          name,
          raw: exactBytes(new TextEncoder().encode(`${name}-value`)),
          browser: name === "content-length"
            ? exactBytes(new TextEncoder().encode(`${name}-value`))
            : null,
          disposition: name === "content-length"
            ? "visible_exactly" as const
            : "hidden" as const,
        })),
        cors_control_headers_hidden: true as const,
      },
    },
  };
}

function canisterPrincipal(index: number): string {
  const bytes = new Uint8Array(10);
  new DataView(bytes.buffer).setUint32(5, index);
  bytes[9] = 1;
  return Principal.fromUint8Array(bytes).toText();
}
