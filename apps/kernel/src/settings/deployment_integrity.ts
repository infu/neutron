import { CanisterStatus, HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { getNeutronId } from "../config.ts";

const SHA256_HEX = /^[a-f0-9]{64}$/u;

export type CertifiedInstalledModuleHash = Readonly<{
  sha256: string;
  source: "ic_certified_read_state_v1";
}>;

export type ExpectedInstalledModuleHash = Readonly<{
  deployment_id: string;
  sha256: string;
}>;

export type InstalledModuleHashComparison =
  | Readonly<{
      status: "build_record_unavailable";
      actual_sha256: string;
    }>
  | Readonly<{
      status: "deployment_mismatch";
      actual_sha256: string;
      expected_deployment_id: string;
      runtime_deployment_id: string;
    }>
  | Readonly<{
      status: "match" | "mismatch";
      actual_sha256: string;
      expected_sha256: string;
    }>;

type CertifiedModuleHashReader = (canisterId: Principal) => Promise<unknown>;

export async function loadCertifiedInstalledModuleHash({
  canisterId = getNeutronId(),
  readModuleHash = readCertifiedModuleHash,
}: {
  canisterId?: string;
  readModuleHash?: CertifiedModuleHashReader;
} = {}): Promise<CertifiedInstalledModuleHash> {
  const principal = Principal.fromText(canisterId);
  const value = await readModuleHash(principal);
  return Object.freeze({
    sha256: exactSha256(value, "Certified installed module hash"),
    source: "ic_certified_read_state_v1",
  });
}

/**
 * Compare only hashes for the same runtime deployment. A missing or stale
 * build record must never be presented as a successful verification or as a
 * hash mismatch.
 */
export function compareInstalledModuleHash(
  actual: CertifiedInstalledModuleHash,
  runtimeDeploymentId: string,
  expected: ExpectedInstalledModuleHash | null,
): InstalledModuleHashComparison {
  if (actual.source !== "ic_certified_read_state_v1") {
    throw new Error("Installed module hash is not certified IC state");
  }
  const actualSha256 = exactSha256(
    actual.sha256,
    "Certified installed module hash",
  );
  assertDeploymentId(runtimeDeploymentId, "Runtime deployment id");
  if (expected === null) {
    return Object.freeze({
      status: "build_record_unavailable",
      actual_sha256: actualSha256,
    });
  }

  assertDeploymentId(expected.deployment_id, "Expected deployment id");
  const expectedSha256 = exactSha256(
    expected.sha256,
    "Expected installed module hash",
  );
  if (expected.deployment_id !== runtimeDeploymentId) {
    return Object.freeze({
      status: "deployment_mismatch",
      actual_sha256: actualSha256,
      expected_deployment_id: expected.deployment_id,
      runtime_deployment_id: runtimeDeploymentId,
    });
  }

  return Object.freeze({
    status: actualSha256 === expectedSha256 ? "match" : "mismatch",
    actual_sha256: actualSha256,
    expected_sha256: expectedSha256,
  });
}

async function readCertifiedModuleHash(
  canisterId: Principal,
): Promise<unknown> {
  const { getSelfCallAgent } = await import("../self_call_transport.ts");
  const agent = await getSelfCallAgent();
  if (!(agent instanceof HttpAgent)) {
    throw new Error("Authenticated IC HTTP agent is unavailable");
  }
  const status = await CanisterStatus.request({
    agent,
    canisterId,
    paths: ["module_hash"],
  });
  return status.get("module_hash");
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertDeploymentId(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}
