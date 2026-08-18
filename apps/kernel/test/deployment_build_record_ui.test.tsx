import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEPLOYMENT_BUILD_RECORD_PATH,
  DEPLOYMENT_WASM_TRANSPORT_ENCODER,
  canonicalDeploymentBuildRecordJson,
  deploymentBuildRecordSha256,
  parseDeploymentBuildRecord,
} from "neutron-compiler/src/deployment_record.js";
import { DeploymentBuildRecordDetails } from "../src/settings/DeploymentBuildRecordDetails.tsx";
import type { InstalledDeploymentBuildRecordInspection } from "../src/settings/deployment_build_record.ts";

const CANISTER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const DEPLOYMENT = "a".repeat(32);
const EXPECTED = "2".repeat(64);
const ACTUAL = "3".repeat(64);

test("deployment record UI distinguishes legacy, unavailable, and invalid", () => {
  const legacy = render({
    inspection: {
      status: "legacy",
      recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
    },
  });
  expect(legacy).toContain('data-status="legacy"');
  expect(legacy).toContain("Legacy / build record unavailable");
  expect(legacy).toContain("does not infer");
  expect(legacy).not.toContain("Download canonical");

  const unavailable = render({
    inspection: {
      status: "unavailable",
      recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
      message: "HTTP 503",
    },
  });
  expect(unavailable).toContain('data-status="unavailable"');
  expect(unavailable).toContain("Record unavailable");
  expect(unavailable).toContain("HTTP 503");

  const invalid = render({
    inspection: {
      status: "invalid",
      recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
      message: '<img src=x onerror="owned">',
    },
  });
  expect(invalid).toContain('data-status="invalid"');
  expect(invalid).toContain("Invalid installed record");
  expect(invalid).toContain("&lt;img src=x onerror=&quot;owned&quot;&gt;");
  expect(invalid).not.toContain('<img src=x onerror="owned">');
});

test("complete record UI shows a whole-canister verified transport match", () => {
  const inspection = declared(completeRecord());
  const html = render({
    inspection,
    comparison: {
      status: "match",
      actual_sha256: EXPECTED,
      expected_sha256: EXPECTED,
    },
  });

  expect(html).toContain('data-status="match"');
  expect(html).toContain("Verified hash match");
  expect(html).toContain("whole-canister module hash");
  expect(html).toContain("deterministic install transport");
  expect(html).toContain("Recorded install transport SHA-256");
  expect(html).toContain("Recorded raw compiler Wasm SHA-256");
  expect(html).toContain("1".repeat(64));
  expect(html).toContain("Build-record identity (domain-separated SHA-256)");
  expect(html).toContain(
    'aria-label="Copy canonical deployment build record JSON"',
  );
  expect(html).toContain(
    'aria-label="Download canonical deployment build record JSON"',
  );
  // The full record is retained for explicit copy/download, not expanded into
  // the Settings DOM.
  expect(html).not.toContain("neutron_compile_result_wasm");
});

test("legacy observed match is not presented as pre-dispatch verification", () => {
  const record = legacyRecord();
  const html = render({
    inspection: declared(record),
    comparison: {
      status: "match",
      actual_sha256: EXPECTED,
      expected_sha256: EXPECTED,
    },
  });
  expect(html).toContain("Observed hash match");
  expect(html).toContain("legacy observation");
  expect(html).toContain("not a complete pre-dispatch build record");
  expect(html).not.toContain("Verified hash match");
});

test("stale and same-deployment mismatch are visibly distinct", () => {
  const inspection = declared(completeRecord());
  const stale = render({
    inspection,
    comparison: {
      status: "deployment_mismatch",
      actual_sha256: ACTUAL,
      expected_deployment_id: "old-deployment",
      runtime_deployment_id: "new-deployment",
    },
  });
  expect(stale).toContain('data-status="stale"');
  expect(stale).toContain("Stale build record");
  expect(stale).toContain("No hash match is claimed");
  expect(stale).not.toContain("Module hash mismatch");

  const mismatch = render({
    inspection,
    comparison: {
      status: "mismatch",
      actual_sha256: ACTUAL,
      expected_sha256: EXPECTED,
    },
  });
  expect(mismatch).toContain('data-status="mismatch"');
  expect(mismatch).toContain("Module hash mismatch");
  expect(mismatch).toContain(ACTUAL);
  expect(mismatch).toContain(EXPECTED);
});

test("refresh races, runtime inconsistency, and hash failure preserve the record", () => {
  const inspection = declared(completeRecord());
  const raced = render({
    inspection,
    refreshRace: {
      beforeDeploymentId: "before",
      afterDeploymentId: "after",
    },
  });
  expect(raced).toContain('data-status="refresh-raced"');
  expect(raced).toContain("Deployment changed during inspection");
  expect(raced).toContain("no hash comparison is claimed");

  const inconsistent = render({
    inspection,
    comparison: {
      status: "match",
      actual_sha256: EXPECTED,
      expected_sha256: EXPECTED,
    },
    runtimeInconsistency: "Build record app inventory does not match",
  });
  expect(inconsistent).toContain('data-status="invalid"');
  expect(inconsistent).toContain("Record and runtime are inconsistent");
  expect(inconsistent).not.toContain("Verified hash match");

  const hashFailure = render({
    inspection,
    comparisonUnavailableMessage:
      "Certified live module hash is unavailable: certificate expired",
  });
  expect(hashFailure).toContain('data-status="unavailable"');
  expect(hashFailure).toContain("Hash comparison unavailable");
  expect(hashFailure).toContain(EXPECTED);
  expect(hashFailure).toContain("Copy canonical deployment build record JSON");
});

function render({
  comparison = null,
  comparisonUnavailableMessage = null,
  inspection,
  refreshRace = null,
  runtimeInconsistency = null,
}: Parameters<typeof DeploymentBuildRecordDetails>[0]): string {
  return renderToStaticMarkup(
    <DeploymentBuildRecordDetails
      comparison={comparison}
      comparisonUnavailableMessage={comparisonUnavailableMessage}
      inspection={inspection}
      refreshRace={refreshRace}
      runtimeInconsistency={runtimeInconsistency}
    />,
  );
}

function declared(
  value: ReturnType<typeof completeRecord> | ReturnType<typeof legacyRecord>,
): Extract<InstalledDeploymentBuildRecordInspection, { status: "declared" }> {
  const record = parseDeploymentBuildRecord(value);
  const expectedModuleHash =
    record.state === "complete"
      ? {
          deployment_id: record.deployment_id,
          sha256: record.wasm.transport.sha256,
        }
      : {
          deployment_id: record.observation.deployment_id,
          sha256: record.observation.installed_module.sha256,
        };
  return {
    status: "declared",
    recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
    record,
    canonicalJson: canonicalDeploymentBuildRecordJson(record),
    recordSha256: deploymentBuildRecordSha256(record),
    expectedModuleHash,
    targetCanister: CANISTER,
  };
}

function completeRecord() {
  return {
    format: 1 as const,
    state: "complete" as const,
    deployment_id: DEPLOYMENT,
    previous: {
      deployment_id: null,
      stable_signature_sha256: null,
      apps: [],
      memories: [],
    },
    build: {
      compiler_id: "moc_test",
      assembler_id: "neutron_actor_test",
      environment: "production" as const,
      deployment_nonce: null,
      reachable_module_sha256: [],
    },
    packages: [
      {
        app_id: "kernel",
        version: 307,
        archive: {
          state: "verified" as const,
          sha256: "7".repeat(64),
          bytes: 100,
        },
        package_information: { state: "not_supplied" as const },
        dependencies: [],
      },
    ],
    target: { apps: [app(307)], memories: [] },
    warnings: {
      diagnostics: [],
      compatibility_diagnostics: [],
      memory_changes: [],
      removed_apps: [],
      destructive_memory_roots: [],
    },
    installation: {
      target_canister: CANISTER,
      mode: "upgrade" as const,
      argument: { sha256: "5".repeat(64), bytes: 0 },
      wasm_memory_persistence: "keep" as const,
    },
    wasm: {
      raw: {
        sha256: "1".repeat(64),
        bytes: 8,
        representation: "neutron_compile_result_wasm" as const,
        content_encoding: "identity" as const,
      },
      transport: {
        sha256: EXPECTED,
        bytes: 28,
        representation: "ic_install_wasm_payload" as const,
        content_encoding: "gzip" as const,
        encoder: DEPLOYMENT_WASM_TRANSPORT_ENCODER,
      },
    },
  };
}

function legacyRecord() {
  return {
    format: 1 as const,
    state: "legacy_observed" as const,
    observation: {
      target_canister: CANISTER,
      deployment_id: "legacy-deployment",
      compiler_id: "moc_legacy",
      assembler_id: "neutron_actor_legacy",
      apps: [app(306)],
      memories: [],
      installed_module: {
        sha256: EXPECTED,
        representation: "ic_canister_status.module_hash" as const,
        source: "ic_certified_read_state_v1" as const,
      },
    },
    packages: [
      {
        app_id: "kernel",
        version: 306,
        outer_archive_sha256: null,
        package_information_sha256: null,
      },
    ],
    unavailable: [
      "ordered_package_digests" as const,
      "package_archive_bytes" as const,
      "source_and_license_record" as const,
      "raw_compiler_output" as const,
      "gzip_transport_details" as const,
      "pre_dispatch_warnings" as const,
      "installation_inputs" as const,
      "prior_state" as const,
    ],
  };
}

function app(version: number) {
  return {
    app_id: "kernel",
    version,
    capability_plan_fingerprint: "4".repeat(64),
    resident_frame_security: "credentialless_opaque_v1" as const,
  };
}
