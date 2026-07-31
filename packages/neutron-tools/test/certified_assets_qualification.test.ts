import { describe, expect, test } from "bun:test";
import {
  CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA,
  CERTIFIED_ASSETS_COLLECTION_KINDS,
  CERTIFIED_ASSETS_ENVIRONMENT_CHECKS,
  CERTIFIED_ASSETS_METRIC_DEFINITIONS,
  CERTIFIED_ASSETS_QUALIFICATION_CASES,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT,
  CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
  CERTIFIED_ASSETS_SYNTHETIC_PLAN,
  CERTIFIED_ASSETS_SYNTHETIC_PLAN_SHA256,
  assertCertifiedAssetsCandidateBinding,
  assertFinalAssembledWasmCertification,
  type CertifiedAssetsCandidateBinding,
} from "../src/certified_assets_qualification.ts";
import {
  SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
  withSupportedCertificateVersions,
} from "../src/wasm_metadata.ts";

const HASH = "ab".repeat(32);
const EMPTY_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

const BINDING: CertifiedAssetsCandidateBinding = {
  schema: CERTIFIED_ASSETS_CANDIDATE_BINDING_SCHEMA,
  qualification_contract_sha256:
    CERTIFIED_ASSETS_QUALIFICATION_CONTRACT_SHA256,
  synthetic_plan_sha256: CERTIFIED_ASSETS_SYNTHETIC_PLAN_SHA256,
  qualification_profile_sha256: HASH,
  implementation_fingerprint_sha256: HASH,
  compiler_source_fingerprint_sha256: HASH,
  compiler_id: "moc_test",
  assembler_id: "neutron_actor_test",
  synthetic_actor_source_sha256: HASH,
  synthetic_actor_manifest_set_sha256: HASH,
  qualification_runner_source_sha256: HASH,
  motoko_package_source_set_sha256: HASH,
  qualified_raw_wasm_sha256: HASH,
  qualified_transport_wasm_sha256: HASH,
  package_lock_sha256: HASH,
  supported_certificate_versions:
    SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1,
};

describe("generic Certified Assets qualification contract", () => {
  test("uses only the three closed collection behaviors", () => {
    expect(CERTIFIED_ASSETS_COLLECTION_KINDS).toEqual([
      "publication",
      "immutable_blob",
      "mutable_blob",
    ]);
    expect(CERTIFIED_ASSETS_SYNTHETIC_PLAN.collections).toHaveLength(4);
    expect(
      JSON.stringify({
        plan: CERTIFIED_ASSETS_SYNTHETIC_PLAN,
        cases: CERTIFIED_ASSETS_QUALIFICATION_CASES,
      }),
    ).not.toMatch(/wagyu|files|kitchensink|contacts/iu);
  });

  test("requires only honestly observable metrics and applicable gateway checks", () => {
    expect(
      CERTIFIED_ASSETS_METRIC_DEFINITIONS.map(({ metric }) => metric),
    ).toEqual([
      "request_candid_bytes",
      "reply_candid_bytes",
      "low_side_cycle_estimate",
      "allocator_high_water_growth_bytes",
      "proof_bytes",
    ]);
    expect(CERTIFIED_ASSETS_ENVIRONMENT_CHECKS).toEqual([
      "gateway_publication_range_reassembly",
      "gateway_browser_cors_body_delivery",
    ]);
    const churn = CERTIFIED_ASSETS_QUALIFICATION_CASES.find(
      ({ id }) => id === "allocator_churn",
    )!;
    expect(churn.checkpoints).toEqual([
      "body_allocation_plateau",
      "receipt_retention_exact",
      "allocator_high_water_plateau",
      "allocator_descriptor_bound",
      "authenticated_node_plateau",
    ]);
    expect(churn.operation).not.toContain("charged usage");
    expect(
      CERTIFIED_ASSETS_QUALIFICATION_CONTRACT.workload
        .churn_receipt_growth,
    ).toEqual({
      receipts_per_round: 1,
      charged_metadata_bytes_per_round: 1_024,
    });
  });

  test("validates the exact candidate binding", () => {
    expect(assertCertifiedAssetsCandidateBinding(BINDING)).toEqual(BINDING);
    expect(() =>
      assertCertifiedAssetsCandidateBinding({
        ...BINDING,
        qualification_contract_sha256: "cd".repeat(32),
      }),
    ).toThrow("does not bind the current qualification contract");
  });

  test("inspects the final assembled Wasm instead of trusting metadata", () => {
    expect(
      assertFinalAssembledWasmCertification(
        withSupportedCertificateVersions(EMPTY_WASM),
      ),
    ).toEqual(SUPPORTED_CERTIFICATE_VERSIONS_METADATA_V1);
    expect(() =>
      assertFinalAssembledWasmCertification(EMPTY_WASM),
    ).toThrow("Missing Wasm custom section");
  });
});
