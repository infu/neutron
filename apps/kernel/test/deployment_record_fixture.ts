import { hashContent } from "neutron-tools/src/hash.js";
import {
  DEPLOYMENT_BUILD_RECORD_FORMAT,
  parseDeploymentBuildRecord,
  prepareDeterministicWasmTransport,
  type CompleteDeploymentBuildRecord,
} from "neutron-compiler/src/deployment_record.js";

const digest = (byte: string): string => byte.repeat(64);
const deploymentId = (byte: string): string => byte.repeat(32);

export function uninstallDeploymentRecordFixture({
  appId = "files",
  memoryIds = ["files"],
}: Readonly<{
  appId?: string;
  memoryIds?: readonly string[];
}> = {}): CompleteDeploymentBuildRecord {
  const kernelApp = app("kernel", 100, "1");
  const removedApp = app(appId, 100, "2");
  const previousMemories = memoryIds.map((id) =>
    memory(appId, id, 1, "3"),
  );
  const { wasmRecord } = prepareDeterministicWasmTransport(
    Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0),
  );
  const record = parseDeploymentBuildRecord({
    format: DEPLOYMENT_BUILD_RECORD_FORMAT,
    state: "complete",
    deployment_id: deploymentId("a"),
    previous: {
      deployment_id: deploymentId("b"),
      stable_signature_sha256: null,
      apps: [kernelApp, removedApp],
      memories: previousMemories,
    },
    build: {
      compiler_id: "moc_deadbeef01234567",
      assembler_id: "neutron_actor_v25",
      environment: "production",
      deployment_nonce: deploymentId("c"),
      reachable_module_sha256: [],
    },
    packages: [
      {
        app_id: "kernel",
        version: kernelApp.version,
        archive: { state: "legacy_unavailable" },
        package_information: { state: "legacy_unavailable" },
        dependencies: [],
      },
    ],
    target: {
      apps: [kernelApp],
      memories: [],
    },
    warnings: {
      diagnostics: [],
      compatibility_diagnostics: [],
      memory_changes: previousMemories.map((item) => ({
        kind: "retire",
        reason: "app-uninstall",
        owner: item.owner,
        memory_id: item.id,
        from: item.version,
        old_schema_entry_sha256: item.schema,
      })),
      removed_apps: [appId],
      destructive_memory_roots: previousMemories.map((item) => ({
        owner: item.owner,
        memory_id: item.id,
      })),
    },
    installation: {
      target_canister: "ryjl3-tyaaa-aaaaa-aaaba-cai",
      mode: "upgrade",
      argument: {
        sha256: hashContent(new Uint8Array()),
        bytes: 0,
      },
      wasm_memory_persistence: "keep",
    },
    wasm: wasmRecord,
  });
  if (record.state !== "complete") throw new Error("Unreachable fixture state");
  return record;
}

function app(id: string, version: number, fingerprintByte: string) {
  return {
    app_id: id,
    version,
    capability_plan_fingerprint: digest(fingerprintByte),
    resident_frame_security: "credentialless_opaque_v1" as const,
  };
}

function memory(
  owner: string,
  id: string,
  version: number,
  schemaByte: string,
) {
  return { owner, id, version, schema: digest(schemaByte) };
}
