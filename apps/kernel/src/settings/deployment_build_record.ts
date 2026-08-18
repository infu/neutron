import {
  DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES,
  DEPLOYMENT_BUILD_RECORD_PATH,
  canonicalDeploymentBuildRecordJson,
  deploymentBuildRecordSha256,
  parseDeploymentBuildRecordJson,
  type DeploymentBuildRecord,
} from "neutron-compiler/src/deployment_record.js";
import type { KernelRuntimeInfo } from "neutron-compiler/src/install.js";
import { getNeutronId } from "../config.ts";
import type { ExpectedInstalledModuleHash } from "./deployment_integrity.ts";

export { DEPLOYMENT_BUILD_RECORD_PATH };

export type InstalledDeploymentBuildRecordInspection =
  | Readonly<{
      status: "legacy";
      recordPath: typeof DEPLOYMENT_BUILD_RECORD_PATH;
    }>
  | Readonly<{
      status: "invalid";
      recordPath: typeof DEPLOYMENT_BUILD_RECORD_PATH;
      message: string;
    }>
  | Readonly<{
      status: "unavailable";
      recordPath: typeof DEPLOYMENT_BUILD_RECORD_PATH;
      message: string;
    }>
  | Readonly<{
      status: "declared";
      recordPath: typeof DEPLOYMENT_BUILD_RECORD_PATH;
      record: DeploymentBuildRecord;
      canonicalJson: string;
      recordSha256: string;
      expectedModuleHash: ExpectedInstalledModuleHash;
      targetCanister: string;
    }>;

export type DeploymentBuildRecordAssetReader = (
  path: typeof DEPLOYMENT_BUILD_RECORD_PATH,
  maximumBytes: number,
) => Promise<Uint8Array | undefined>;

export type DeploymentBuildRecordDownloadEnvironment = Readonly<{
  createObjectUrl(content: Uint8Array): string;
  triggerDownload(objectUrl: string, filename: string): void;
  revokeObjectUrl(objectUrl: string): void;
}>;

export type DeploymentBuildRecordFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Load the one whole-canister deployment record. Missing is an ordinary legacy
 * state; an unreadable response and an invalid present record stay distinct.
 */
export async function loadInstalledDeploymentBuildRecord({
  canisterId = getNeutronId(),
  readAsset = readDeploymentBuildRecordAsset,
}: Readonly<{
  canisterId?: string;
  readAsset?: DeploymentBuildRecordAssetReader;
}> = {}): Promise<InstalledDeploymentBuildRecordInspection> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readAsset(
      DEPLOYMENT_BUILD_RECORD_PATH,
      DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES,
    );
  } catch (error) {
    return Object.freeze({
      status: "unavailable" as const,
      recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
      message: boundedErrorMessage(error),
    });
  }

  if (bytes === undefined) {
    return Object.freeze({
      status: "legacy" as const,
      recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
    });
  }

  try {
    const record = parseDeploymentBuildRecordJson(bytes);
    const targetCanister = deploymentRecordTargetCanister(record);
    if (targetCanister !== canisterId) {
      throw new Error(
        `Deployment record target ${targetCanister} does not match this Neutron ${canisterId}`,
      );
    }
    return Object.freeze({
      status: "declared" as const,
      recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
      record,
      canonicalJson: canonicalDeploymentBuildRecordJson(record),
      recordSha256: deploymentBuildRecordSha256(record),
      expectedModuleHash: deploymentRecordExpectedModuleHash(record),
      targetCanister,
    });
  } catch (error) {
    return Object.freeze({
      status: "invalid" as const,
      recordPath: DEPLOYMENT_BUILD_RECORD_PATH,
      message: boundedErrorMessage(error),
    });
  }
}

export function deploymentRecordExpectedModuleHash(
  record: DeploymentBuildRecord,
): ExpectedInstalledModuleHash {
  return record.state === "complete"
    ? Object.freeze({
        deployment_id: record.deployment_id,
        sha256: record.wasm.transport.sha256,
      })
    : Object.freeze({
        deployment_id: record.observation.deployment_id,
        sha256: record.observation.installed_module.sha256,
      });
}

export function deploymentRecordTargetCanister(
  record: DeploymentBuildRecord,
): string {
  return record.state === "complete"
    ? record.installation.target_canister
    : record.observation.target_canister;
}

/**
 * A same-deployment record must describe the runtime inventory exactly. An
 * older deployment is stale, not malformed, so callers compare deployment ids
 * before using this result.
 */
export function deploymentRecordRuntimeInconsistency(
  record: DeploymentBuildRecord,
  runtime: KernelRuntimeInfo,
): string | null {
  const expected = deploymentRecordExpectedModuleHash(record);
  if (expected.deployment_id !== runtime.deployment_id) return null;

  const recorded =
    record.state === "complete" ? record.target : record.observation;
  const recordedCompiler =
    record.state === "complete"
      ? record.build.compiler_id
      : record.observation.compiler_id;
  const recordedAssembler =
    record.state === "complete"
      ? record.build.assembler_id
      : record.observation.assembler_id;
  if (recordedCompiler !== runtime.compiler_id) {
    return "Build record compiler does not match the same-deployment runtime";
  }
  if (recordedAssembler !== runtime.assembler_id) {
    return "Build record assembler does not match the same-deployment runtime";
  }

  try {
    const runtimeApps = runtime.apps
      .map((app) => {
        if (app.deployment_id !== runtime.deployment_id) {
          throw new Error(
            `Runtime app ${app.scope.app_id} is bound to another deployment`,
          );
        }
        return {
          app_id: app.scope.app_id,
          version: exactRuntimeVersion(app.version, `app ${app.scope.app_id}`),
          capability_plan_fingerprint: app.capability_plan_fingerprint,
          resident_frame_security: runtimeFrameSecurity(
            app.resident_frame_security,
          ),
        };
      })
      .sort((left, right) => compareText(left.app_id, right.app_id));
    if (JSON.stringify(recorded.apps) !== JSON.stringify(runtimeApps)) {
      return "Build record app inventory does not match the same-deployment runtime";
    }

    const runtimeMemories = runtime.memories
      .map((memory) => ({
        owner: memory.owner,
        id: memory.id,
        version: exactRuntimeVersion(
          memory.version,
          `memory ${memory.owner}/${memory.id}`,
        ),
        schema: memory.schema,
      }))
      .sort((left, right) => {
        const owner = compareText(left.owner, right.owner);
        return owner === 0 ? compareText(left.id, right.id) : owner;
      });
    if (JSON.stringify(recorded.memories) !== JSON.stringify(runtimeMemories)) {
      return "Build record memory inventory does not match the same-deployment runtime";
    }
  } catch (error) {
    return boundedErrorMessage(error);
  }
  return null;
}

/**
 * Download only the canonical, already-validated JSON through an inert object
 * URL. The fixed filename cannot be influenced by record contents.
 */
export function downloadDeploymentBuildRecordJson(
  canonicalJson: string,
  environment: DeploymentBuildRecordDownloadEnvironment =
    browserDownloadEnvironment,
): void {
  const bytes = new TextEncoder().encode(canonicalJson);
  if (bytes.byteLength > DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES) {
    throw new Error("Deployment build record JSON exceeds its byte limit");
  }
  // Re-parse at this boundary so callers cannot download unchecked JSON via
  // this evidence-specific helper.
  const record = parseDeploymentBuildRecordJson(bytes);
  if (canonicalDeploymentBuildRecordJson(record) !== canonicalJson) {
    throw new Error("Deployment build record JSON is not canonical");
  }
  const objectUrl = environment.createObjectUrl(bytes);
  try {
    environment.triggerDownload(
      objectUrl,
      "neutron-deployment-build-record.json",
    );
  } finally {
    environment.revokeObjectUrl(objectUrl);
  }
}

export async function readDeploymentBuildRecordAsset(
  path: typeof DEPLOYMENT_BUILD_RECORD_PATH,
  maximumBytes: number,
  fetchAsset: DeploymentBuildRecordFetch = globalThis.fetch,
): Promise<Uint8Array | undefined> {
  if (
    path !== DEPLOYMENT_BUILD_RECORD_PATH ||
    maximumBytes !== DEPLOYMENT_BUILD_RECORD_MAX_JSON_BYTES
  ) {
    throw new Error("Invalid deployment build record asset request");
  }

  const response = await fetchAsset(path, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `Could not fetch deployment build record: HTTP ${response.status}`,
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (
      !Number.isSafeInteger(declared) ||
      declared < 0 ||
      declared > maximumBytes
    ) {
      throw new Error(
        `Deployment build record exceeds the ${maximumBytes}-byte read limit`,
      );
    }
  }

  if (!response.body) {
    const content = new Uint8Array(await response.arrayBuffer());
    assertReadLimit(content.byteLength, maximumBytes);
    return content;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        assertReadLimit(total, maximumBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

const browserDownloadEnvironment: DeploymentBuildRecordDownloadEnvironment =
  Object.freeze({
    createObjectUrl(content: Uint8Array): string {
      const bytes = content.slice().buffer;
      return URL.createObjectURL(
        new Blob([bytes], { type: "application/json;charset=utf-8" }),
      );
    },
    triggerDownload(objectUrl: string, filename: string): void {
      const anchor = document.createElement("a");
      anchor.download = filename;
      anchor.href = objectUrl;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
      }
    },
    revokeObjectUrl(objectUrl: string): void {
      URL.revokeObjectURL(objectUrl);
    },
  });

function assertReadLimit(actualBytes: number, maximumBytes: number): void {
  if (actualBytes > maximumBytes) {
    throw new Error(
      `Deployment build record exceeds the ${maximumBytes}-byte read limit`,
    );
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  return Array.from(normalized).slice(0, 500).join("") || "Unknown error";
}

function exactRuntimeVersion(value: bigint | number, label: string): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    (typeof value === "bigint" && BigInt(normalized) !== value)
  ) {
    throw new Error(`Runtime ${label} version is invalid`);
  }
  return normalized;
}

function runtimeFrameSecurity(value: object): string {
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new Error("Runtime resident-frame security is invalid");
  }
  const mode = keys[0];
  if (
    mode !== "credentialless_opaque_v1" &&
    mode !== "credentialless_ephemeral_dedicated_v1" &&
    mode !== "persistent_dedicated_v1"
  ) {
    throw new Error("Runtime resident-frame security is invalid");
  }
  if ((value as Record<string, unknown>)[mode] !== null) {
    throw new Error("Runtime resident-frame security is invalid");
  }
  return mode;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
