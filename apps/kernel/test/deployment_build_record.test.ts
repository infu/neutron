import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES,
  DEPLOYMENT_WASM_TRANSPORT_ENCODER,
  canonicalDeploymentBuildRecordJson,
  parseDeploymentBuildRecord,
} from "neutron-compiler/src/deployment_record.js";
import type { KernelRuntimeInfo } from "neutron-compiler/src/install.js";
import {
  DEPLOYMENT_BUILD_RECORD_PATH,
  deploymentRecordRuntimeInconsistency,
  downloadDeploymentBuildRecordJson,
  loadInstalledDeploymentBuildRecord,
  readDeploymentBuildRecordAsset,
} from "../src/settings/deployment_build_record.ts";

const CANISTER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const OTHER_CANISTER = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const COMPLETE_DEPLOYMENT = "a".repeat(32);
const LEGACY_DEPLOYMENT = "pre-record-deployment-v036";
const RAW_HASH = "1".repeat(64);
const TRANSPORT_HASH = "2".repeat(64);
const LEGACY_HASH = "3".repeat(64);
const FINGERPRINT = "4".repeat(64);

test("deployment-record inspection treats only a missing fixed path as legacy", async () => {
  const requests: Array<{ path: string; maximumBytes: number }> = [];
  const inspection = await loadInstalledDeploymentBuildRecord({
    canisterId: CANISTER,
    readAsset: async (path, maximumBytes) => {
      requests.push({ path, maximumBytes });
      return undefined;
    },
  });

  expect(requests).toEqual([
    {
      path: DEPLOYMENT_BUILD_RECORD_PATH,
      maximumBytes: DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES,
    },
  ]);
  expect(inspection).toEqual({
    status: "legacy",
    recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
  });
});

test("Settings fences the certified hash and record between runtime reads", async () => {
  const source = await readFile(
    new URL("../src/settings/KernelSettingsPage.tsx", import.meta.url),
    "utf8",
  );
  const before = source.indexOf("const runtimeBeforeRefresh");
  const hash = source.indexOf(
    "const installedModuleHashRefresh = runtimeBeforeRefresh.then",
  );
  const record = source.indexOf(
    "const deploymentBuildRecordRefresh = runtimeBeforeRefresh.then",
  );
  const after = source.indexOf("const runtimeAfterRefresh");
  expect(before).toBeGreaterThan(-1);
  expect(hash).toBeGreaterThan(before);
  expect(record).toBeGreaterThan(before);
  expect(after).toBeGreaterThan(hash);
  expect(after).toBeGreaterThan(record);
  expect(source).toMatch(
    /runtimeBeforeResult\.value\.deployment_id\s*!==\s*runtimeAfterResult\.value\.deployment_id/u,
  );
  expect(source).toContain('status: "raced"');
});

test("deployment-record inspection separates transport failure and invalid content", async () => {
  const unavailable = await loadInstalledDeploymentBuildRecord({
    canisterId: CANISTER,
    readAsset: async () => {
      throw new Error("network\nfailed");
    },
  });
  expect(unavailable).toEqual({
    status: "unavailable",
    recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
    message: "network failed",
  });

  const invalid = await loadInstalledDeploymentBuildRecord({
    canisterId: CANISTER,
    readAsset: async () => new TextEncoder().encode('{"state":"complete"}'),
  });
  expect(invalid.status).toBe("invalid");
  if (invalid.status !== "invalid") throw new Error("unreachable");
  expect(invalid.message).toContain("unknown or missing fields");
});

test("complete records compare the deterministic gzip transport, never raw Wasm", async () => {
  const source = completeRecord();
  const inspection = await loadInstalledDeploymentBuildRecord({
    canisterId: CANISTER,
    readAsset: async () =>
      new TextEncoder().encode(JSON.stringify(source)),
  });

  expect(inspection.status).toBe("declared");
  if (inspection.status !== "declared") throw new Error("unreachable");
  expect(inspection.expectedModuleHash).toEqual({
    deployment_id: COMPLETE_DEPLOYMENT,
    sha256: TRANSPORT_HASH,
  });
  expect(inspection.expectedModuleHash.sha256).not.toBe(RAW_HASH);
  expect(inspection.canonicalJson).toBe(
    canonicalDeploymentBuildRecordJson(source),
  );
  expect(inspection.recordSha256).toMatch(/^[a-f0-9]{64}$/u);
});

test("legacy observed records retain only their certified observation", async () => {
  const inspection = await loadInstalledDeploymentBuildRecord({
    canisterId: CANISTER,
    readAsset: async () =>
      new TextEncoder().encode(JSON.stringify(legacyRecord())),
  });

  expect(inspection.status).toBe("declared");
  if (inspection.status !== "declared") throw new Error("unreachable");
  expect(inspection.record.state).toBe("legacy_observed");
  expect(inspection.expectedModuleHash).toEqual({
    deployment_id: LEGACY_DEPLOYMENT,
    sha256: LEGACY_HASH,
  });
});

test("a valid record for another canister is invalid here", async () => {
  const source = completeRecord();
  source.installation.target_canister = OTHER_CANISTER;
  const inspection = await loadInstalledDeploymentBuildRecord({
    canisterId: CANISTER,
    readAsset: async () =>
      new TextEncoder().encode(JSON.stringify(source)),
  });

  expect(inspection.status).toBe("invalid");
  if (inspection.status !== "invalid") throw new Error("unreachable");
  expect(inspection.message).toContain("does not match this Neutron");
});

test("same-deployment records must match the runtime inventory", () => {
  const record = parseDeploymentBuildRecord(completeRecord());
  const runtime = completeRuntime();
  expect(deploymentRecordRuntimeInconsistency(record, runtime)).toBeNull();

  const wrongCompiler = { ...runtime, compiler_id: "moc_other" };
  expect(deploymentRecordRuntimeInconsistency(record, wrongCompiler)).toContain(
    "compiler",
  );

  const wrongAssembler = { ...runtime, assembler_id: "neutron_actor_other" };
  expect(
    deploymentRecordRuntimeInconsistency(record, wrongAssembler),
  ).toContain("assembler");

  const wrongVersion = structuredClone(runtime);
  wrongVersion.apps[0]!.version = 308n;
  expect(deploymentRecordRuntimeInconsistency(record, wrongVersion)).toContain(
    "app inventory",
  );

  const wrongMemory = structuredClone(runtime);
  wrongMemory.memories.push({
    owner: "kernel",
    id: "unexpected",
    version: 1n,
    schema: "8".repeat(64),
  });
  expect(deploymentRecordRuntimeInconsistency(record, wrongMemory)).toContain(
    "memory inventory",
  );

  const wrongAppDeployment = structuredClone(runtime);
  wrongAppDeployment.apps[0]!.deployment_id = "another-deployment";
  expect(
    deploymentRecordRuntimeInconsistency(record, wrongAppDeployment),
  ).toContain("bound to another deployment");

  const staleRuntime = { ...wrongCompiler, deployment_id: "older-deployment" };
  expect(deploymentRecordRuntimeInconsistency(record, staleRuntime)).toBeNull();
});

test("the fixed asset reader rejects redirects and oversized declared bodies", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  const missing = await readDeploymentBuildRecordAsset(
    DEPLOYMENT_BUILD_RECORD_PATH,
    DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES,
    async (input, init) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return new Response(null, { status: 404 });
    },
  );
  expect(missing).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.input).toBe(DEPLOYMENT_BUILD_RECORD_PATH);
  expect(requests[0]!.init).toMatchObject({
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });

  await expect(
    readDeploymentBuildRecordAsset(
      DEPLOYMENT_BUILD_RECORD_PATH,
      DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES,
      async () =>
        new Response("{}", {
          headers: {
            "content-length": String(
              DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES + 1,
            ),
          },
        }),
    ),
  ).rejects.toThrow("read limit");

  await expect(
    readDeploymentBuildRecordAsset(
      DEPLOYMENT_BUILD_RECORD_PATH,
      DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES,
      async () =>
        new Response(
          new Uint8Array(DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES + 1),
        ),
    ),
  ).rejects.toThrow("read limit");
});

test("record download uses validated canonical JSON, a fixed name, and revokes", () => {
  const canonicalJson = canonicalDeploymentBuildRecordJson(completeRecord());
  const actions: string[] = [];
  let downloaded = "";
  downloadDeploymentBuildRecordJson(canonicalJson, {
    createObjectUrl(content) {
      downloaded = new TextDecoder().decode(content);
      actions.push("create");
      return "blob:safe";
    },
    triggerDownload(objectUrl, filename) {
      expect(objectUrl).toBe("blob:safe");
      expect(filename).toBe("neutron-deployment-build-record.json");
      actions.push("download");
    },
    revokeObjectUrl(objectUrl) {
      expect(objectUrl).toBe("blob:safe");
      actions.push("revoke");
    },
  });
  expect(downloaded).toBe(canonicalJson);
  expect(actions).toEqual(["create", "download", "revoke"]);

  expect(() =>
    downloadDeploymentBuildRecordJson(canonicalJson, {
      createObjectUrl: () => "blob:safe",
      triggerDownload: () => {
        throw new Error("blocked");
      },
      revokeObjectUrl: () => actions.push("revoke-after-error"),
    }),
  ).toThrow("blocked");
  expect(actions.at(-1)).toBe("revoke-after-error");
  expect(() =>
    downloadDeploymentBuildRecordJson('{"unsafe":true}', {
      createObjectUrl: () => {
        throw new Error("must not create");
      },
      triggerDownload: () => undefined,
      revokeObjectUrl: () => undefined,
    }),
  ).toThrow("unknown field");
  expect(() =>
    downloadDeploymentBuildRecordJson(canonicalJson.trim(), {
      createObjectUrl: () => {
        throw new Error("must not create");
      },
      triggerDownload: () => undefined,
      revokeObjectUrl: () => undefined,
    }),
  ).toThrow("not canonical");
});

function completeRecord() {
  return {
    format: 1 as const,
    state: "complete" as const,
    deployment_id: COMPLETE_DEPLOYMENT,
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
        sha256: RAW_HASH,
        bytes: 8,
        representation: "neutron_compile_result_wasm" as const,
        content_encoding: "identity" as const,
      },
      transport: {
        sha256: TRANSPORT_HASH,
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
      deployment_id: LEGACY_DEPLOYMENT,
      compiler_id: "moc_legacy",
      assembler_id: "neutron_actor_legacy",
      apps: [app(306)],
      memories: [],
      installed_module: {
        sha256: LEGACY_HASH,
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
    capability_plan_fingerprint: FINGERPRINT,
    resident_frame_security: "credentialless_opaque_v1" as const,
  };
}

function completeRuntime(): KernelRuntimeInfo {
  return {
    deployment_id: COMPLETE_DEPLOYMENT,
    compiler_id: "moc_test",
    assembler_id: "neutron_actor_test",
    apps: [
      {
        scope: { app_id: "kernel", installation_uid: 1n },
        version: 307n,
        deployment_id: COMPLETE_DEPLOYMENT,
        capability_plan_fingerprint: FINGERPRINT,
        browser_origin_nonce: "6".repeat(32),
        browser_origin_authority_epoch: 1n,
        resident_frame_security: { credentialless_opaque_v1: null },
      },
    ],
    memories: [],
  };
}
