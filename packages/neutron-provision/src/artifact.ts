import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  compileFreshPackages,
  DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS,
  browserSurfaceOriginAppIdsForSelectedPackages,
  preparePackageInstall,
  type CompileResult,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import { assertBackendCallInstallReservationsTarget } from "neutron-compiler/src/compile.js";
import { assemblerForFreshKernelVersion } from "neutron-compiler/src/assemble.js";
import {
  trustedInstallationNetworkIdHex,
  type TrustedInstallationContextV1,
} from "neutron-compiler/src/installation_context.js";
import {
  assertSupportedCertificateVersions,
  assertSupportedCertificateVersionsMetadata,
  type SupportedCertificateVersionsMetadataV1,
} from "neutron-tools/src/wasm_metadata.js";
import {
  resolveLocalCompiledActor,
  type LocalCompiledActorCacheOptions,
} from "./compiled_cache.ts";

export const MANAGEMENT_CHUNK_BYTES = 1024 * 1024;
export const IC_MAX_WASM_BYTES = 100 * 1024 * 1024;
export const IC_MAX_CHUNK_STORE_BYTES = 100 * 1024 * 1024;
export const IC_MAX_WASM_CHUNKS = 100;
export const MAX_PACKAGE_ARCHIVES = 256;
export const MAX_PACKAGE_ARCHIVES_BYTES = 256 * 1024 * 1024;

export type PackageArtifact = {
  path: string;
  id: string;
  version: number;
  sha256: string;
  bytes: number;
};

/**
 * Immutable package identity declared by a format-3 deployment config.
 *
 * Paths are provenance; every other field is re-derived from the exact archive
 * before compilation. The provisioner never invokes a package workspace or
 * executable hook to satisfy one of these records.
 */
export type PinnedPackageArtifact = PackageArtifact;

type LoadedPackageArchive = {
  archive: Uint8Array;
  prepared: PreparedPackageInstall;
  artifact: PackageArtifact;
};

export type WasmChunk = {
  bytes: Uint8Array;
  hash: Uint8Array;
  hashHex: string;
};

export type PreparedDeployment = {
  packages: PreparedPackageInstall[];
  /** Exact outer `.neutron` bytes, in the same order as `packages`. */
  packageArchives: Uint8Array[];
  packageArtifacts: PackageArtifact[];
  compiled: Pick<
    CompileResult,
    | "wasm"
    | "candid"
    | "stable"
    | "deploymentId"
    | "compilerId"
    | "assemblerId"
    | "browserSurfaceOriginAppIds"
  >;
  /** Exact public Wasm metadata proven from `compiled.wasm`. */
  wasmMetadata: SupportedCertificateVersionsMetadataV1;
  transportWasm: Uint8Array;
  rawWasmSha256: string;
  transportWasmSha256: string;
  candidSha256: string;
  stableSha256: string;
  chunks: WasmChunk[];
};

export type ProvisionedPackageProvenanceV1 = Readonly<{
  kind: "provisioned";
  package_digest: string;
}>;

export type FreshInstallProvenanceV1 = Readonly<{
  format: 1;
  apps: Readonly<Record<string, ProvisionedPackageProvenanceV1>>;
}>;

/**
 * Build the certified provenance journal for a fresh combined deployment.
 *
 * Package artifacts are derived from the exact outer `.neutron` bytes during
 * preparation. Positional reconciliation prevents a caller from pairing one
 * package's digest with another package's manifest.
 */
export function buildFreshInstallProvenance(
  deployment: Pick<PreparedDeployment, "packages" | "packageArtifacts">,
): FreshInstallProvenanceV1 {
  if (
    deployment.packages.length === 0 ||
    deployment.packages.length !== deployment.packageArtifacts.length
  ) {
    throw new Error(
      "Fresh install provenance requires aligned prepared packages and package artifacts",
    );
  }

  const entries = deployment.packages.map((prepared, index) => {
    const artifact = deployment.packageArtifacts[index]!;
    if (
      prepared.manifest.id !== artifact.id ||
      prepared.manifest.version !== artifact.version
    ) {
      throw new Error(
        `Fresh install provenance package ${index} does not match its package artifact`,
      );
    }
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
      throw new Error(
        `Fresh install provenance package ${index} has an invalid archive digest`,
      );
    }
    return {
      id: artifact.id,
      provenance: Object.freeze({
        kind: "provisioned" as const,
        package_digest: artifact.sha256,
      }),
    };
  });

  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error("Fresh install provenance contains duplicate package IDs");
  }
  if (
    new Set(entries.map(({ provenance }) => provenance.package_digest)).size !==
    entries.length
  ) {
    throw new Error(
      "Fresh install provenance contains duplicate package archive digests",
    );
  }

  entries.sort(({ id: left }, { id: right }) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return Object.freeze({
    format: 1,
    apps: Object.freeze(
      Object.fromEntries(
        entries.map(({ id, provenance }) => [id, provenance]),
      ),
    ),
  });
}

export function assertPreparedDeploymentTarget(
  deployment: Pick<PreparedDeployment, "packages">,
  targetCanisterId: string,
): void {
  assertBackendCallInstallReservationsTarget(
    Object.fromEntries(
      deployment.packages.map(({ manifest }) => [manifest.id, manifest]),
    ),
    targetCanisterId,
  );
}

export async function prepareDeployment(
  packagePaths: string[],
  options: {
    deploymentNonce?: string;
    target?: "production" | "local";
    localCompileCache?: LocalCompiledActorCacheOptions;
    expectedArtifacts?: readonly PinnedPackageArtifact[];
    freshInstallationContext?: TrustedInstallationContextV1;
  } = {},
): Promise<PreparedDeployment> {
  const target = options.target ?? "production";
  assertPreparationContextPolicy(options, target);
  if (target !== "local" && options.expectedArtifacts === undefined) {
    throw new Error(
      "IC deployment preparation requires exact expectedArtifacts from a format-3 config",
    );
  }
  const expectedArtifacts =
    options.expectedArtifacts === undefined
      ? undefined
      : snapshotExpectedPackageArtifacts(options.expectedArtifacts);
  if (packagePaths.length === 0) {
    throw new Error("At least one package archive is required");
  }
  const loaded = await loadPackageArchives(
    packagePaths,
    expectedArtifacts,
  );
  const packages = loaded.map(({ prepared }) => prepared);
  assertFreshPackageRoles(packages);
  const kernelVersion = packages[0]!.manifest.version;
  const assemblerId = assemblerForFreshKernelVersion(kernelVersion);
  const compile = () =>
    compileFreshPackages({
      packages,
      vetKeysEnvironment: target === "local" ? "local" : "production",
      ...(options.deploymentNonce
        ? { deploymentNonce: options.deploymentNonce }
        : {}),
      ...(options.freshInstallationContext
        ? { freshInstallationContext: options.freshInstallationContext }
        : {}),
    });
  const compiled = options.localCompileCache
    ? await resolveLocalCompiledActor({
        cache: options.localCompileCache,
        packageArchiveSha256: loaded.map(({ artifact }) => artifact.sha256),
        compile,
    })
    : await compile();
  if (compiled.assemblerId !== assemblerId) {
    throw new Error("Fresh deployment compiler used the wrong assembler generation");
  }
  const expectedBrowserSurfaceOriginAppIds =
    browserSurfaceOriginAppIdsForSelectedPackages(packages, assemblerId);
  if (
    JSON.stringify(compiled.browserSurfaceOriginAppIds) !==
    JSON.stringify(expectedBrowserSurfaceOriginAppIds)
  ) {
    throw new Error(
      "Fresh deployment compiler browser-surface origins do not match the selected packages",
    );
  }
  const wasmMetadata = assertSupportedCertificateVersions(compiled.wasm);
  const transportWasm = new Uint8Array(gzipSync(compiled.wasm));
  const chunks = chunkWasm(transportWasm);
  assertWasmDeploymentLimits({
    rawWasmBytes: compiled.wasm.byteLength,
    transportWasmBytes: transportWasm.byteLength,
    chunkCount: chunks.length,
  });

  return {
    packages,
    packageArchives: loaded.map(({ archive }) => archive),
    packageArtifacts: loaded.map(({ artifact }) => artifact),
    compiled,
    wasmMetadata,
    transportWasm,
    rawWasmSha256: sha256Hex(compiled.wasm),
    transportWasmSha256: sha256Hex(transportWasm),
    candidSha256: sha256Hex(new TextEncoder().encode(compiled.candid)),
    stableSha256: sha256Hex(new TextEncoder().encode(compiled.stable)),
    chunks,
  };
}

function assertPreparationContextPolicy(
  options: {
    deploymentNonce?: string;
    localCompileCache?: LocalCompiledActorCacheOptions;
    freshInstallationContext?: TrustedInstallationContextV1;
  },
  target: "production" | "local",
): void {
  if (target !== "local" && target !== "production") {
    throw new Error("Deployment preparation target is unsupported");
  }
  if (options.localCompileCache && target !== "local") {
    throw new Error("The compiled actor cache is local-only");
  }
  if (options.localCompileCache && options.deploymentNonce) {
    throw new Error("A nonce-bound deployment cannot use the local compile cache");
  }
  if (target === "local" && options.freshInstallationContext === undefined) {
    throw new Error(
      "A fresh local deployment requires trusted installation context",
    );
  }
  if (options.localCompileCache) {
    const networkIdHex = trustedInstallationNetworkIdHex(
      options.freshInstallationContext!,
    );
    if (
      options.localCompileCache.installationNetworkIdHex !== networkIdHex
    ) {
      throw new Error(
        "The local compiled-actor cache network ID does not match trusted installation context",
      );
    }
  }
  if (target !== "local" && options.freshInstallationContext !== undefined) {
    throw new Error(
      "Production deployment cannot accept a caller-supplied installation context",
    );
  }
}

/**
 * Read and authenticate an immutable package set without compiling it.
 *
 * Config loading uses this boundary so even non-deployment commands cannot
 * silently reinterpret a changed archive. Deployment preparation calls the
 * same loader again immediately before compilation to close the
 * check/use window.
 */
export async function inspectPinnedPackageArchives(
  expectedArtifacts: readonly PinnedPackageArtifact[],
): Promise<{
  packages: PreparedPackageInstall[];
  artifacts: PackageArtifact[];
}> {
  const expected = snapshotExpectedPackageArtifacts(expectedArtifacts);
  const loaded = await loadPackageArchives(
    expected.map(({ path: artifactPath }) => artifactPath),
    expected,
  );
  const packages = loaded.map(({ prepared }) => prepared);
  assertFreshPackageRoles(packages);
  return {
    packages,
    artifacts: loaded.map(({ artifact }) => artifact),
  };
}

/**
 * Validate and copy the closed pin declaration before any identity, archive,
 * session, compiler, or network work. The copy prevents a programmatic caller
 * from changing deployment intent while an asynchronous operation is active.
 */
export function snapshotExpectedPackageArtifacts(
  value: unknown,
): readonly PinnedPackageArtifact[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_PACKAGE_ARCHIVES
  ) {
    throw new Error(
      `Expected package artifacts must contain 1 through ${MAX_PACKAGE_ARCHIVES} exact format-3 pins`,
    );
  }
  const expected = value.map((entry, index): PinnedPackageArtifact => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      throw new Error(`Expected package artifact ${index} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const required = ["bytes", "id", "path", "sha256", "version"];
    if (
      keys.length !== required.length ||
      keys.some((key, keyIndex) => key !== required[keyIndex])
    ) {
      throw new Error(
        `Expected package artifact ${index} must contain exactly path, sha256, bytes, id, and version`,
      );
    }
    if (
      typeof record.path !== "string" ||
      record.path.length === 0 ||
      record.path.includes("\0") ||
      !path.isAbsolute(record.path)
    ) {
      throw new Error(
        `Expected package artifact ${index}.path must be a non-empty absolute path`,
      );
    }
    if (
      typeof record.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(record.sha256)
    ) {
      throw new Error(
        `Expected package artifact ${index}.sha256 must be a lowercase SHA-256 digest`,
      );
    }
    if (
      typeof record.bytes !== "number" ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes < 1 ||
      record.bytes > DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS.maxRawBytes
    ) {
      throw new Error(
        `Expected package artifact ${index}.bytes must be a positive bounded safe integer`,
      );
    }
    if (
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      record.id.length > 128
    ) {
      throw new Error(
        `Expected package artifact ${index}.id must be a non-empty bounded string`,
      );
    }
    if (
      typeof record.version !== "number" ||
      !Number.isSafeInteger(record.version) ||
      record.version < 0
    ) {
      throw new Error(
        `Expected package artifact ${index}.version must be a non-negative safe integer`,
      );
    }
    return Object.freeze({
      path: path.resolve(record.path),
      sha256: record.sha256,
      bytes: record.bytes,
      id: record.id,
      version: record.version,
    });
  });
  if (expected[0]!.id !== "kernel") {
    throw new Error(
      "Expected package artifact 0 identity mismatch: first artifact must be the kernel",
    );
  }
  if (expected.slice(1).some(({ id }) => id === "kernel")) {
    throw new Error("Expected package artifacts contain more than one kernel");
  }
  if (new Set(expected.map(({ path: artifactPath }) => artifactPath)).size !== expected.length) {
    throw new Error("Expected package artifacts contain duplicate paths");
  }
  if (new Set(expected.map(({ id }) => id)).size !== expected.length) {
    throw new Error("Expected package artifacts contain duplicate package IDs");
  }
  return Object.freeze(expected);
}

/**
 * Reconcile a prepared result with the immutable declarations supplied at the
 * public API boundary. This keeps the explicit test seam from weakening the
 * production default.
 */
export function assertPreparedDeploymentMatchesExpectedArtifacts(
  deployment: Pick<
    PreparedDeployment,
    "packages" | "packageArchives" | "packageArtifacts"
  >,
  expectedArtifacts: readonly PinnedPackageArtifact[],
): void {
  const expected = snapshotExpectedPackageArtifacts(expectedArtifacts);
  if (
    deployment.packages.length !== expected.length ||
    deployment.packageArchives.length !== expected.length ||
    deployment.packageArtifacts.length !== expected.length
  ) {
    throw new Error(
      "Prepared deployment package count does not match expectedArtifacts",
    );
  }
  assertPackageArtifactsMatchExpectedArtifacts(
    deployment.packageArtifacts,
    expected,
  );
  expected.forEach((pin, index) => {
    const archive = deployment.packageArchives[index]!;
    if (
      archive.byteLength !== pin.bytes ||
      sha256Hex(archive) !== pin.sha256
    ) {
      throw new Error(
        `Prepared deployment archive ${index} does not match expectedArtifacts`,
      );
    }
    const manifest = deployment.packages[index]!.manifest;
    if (manifest.id !== pin.id || manifest.version !== pin.version) {
      throw new Error(
        `Prepared deployment package ${index} manifest does not match expectedArtifacts`,
      );
    }
  });
}

export function assertPackageArtifactsMatchExpectedArtifacts(
  actualArtifacts: readonly PackageArtifact[],
  expectedArtifacts: readonly PinnedPackageArtifact[],
): void {
  const expected = snapshotExpectedPackageArtifacts(expectedArtifacts);
  if (actualArtifacts.length !== expected.length) {
    throw new Error(
      "Recorded package count does not match expectedArtifacts",
    );
  }
  expected.forEach((pin, index) => {
    assertPinnedPackageArtifact(pin, actualArtifacts[index]!, index);
  });
}

async function loadPackageArchives(
  packagePaths: readonly string[],
  expectedArtifacts?: readonly PinnedPackageArtifact[],
): Promise<LoadedPackageArchive[]> {
  if (packagePaths.length < 1 || packagePaths.length > MAX_PACKAGE_ARCHIVES) {
    throw new Error(
      `Pinned package set must contain 1 through ${MAX_PACKAGE_ARCHIVES} archives`,
    );
  }
  if (
    expectedArtifacts !== undefined &&
    expectedArtifacts.length !== packagePaths.length
  ) {
    throw new Error(
      `Pinned package count ${expectedArtifacts.length} does not match archive count ${packagePaths.length}`,
    );
  }
  const resolvedPaths = packagePaths.map((packagePath) =>
    path.resolve(packagePath),
  );
  if (new Set(resolvedPaths).size !== resolvedPaths.length) {
    throw new Error("Pinned package set contains duplicate archive paths");
  }
  expectedArtifacts?.forEach((expected, index) => {
    if (path.resolve(expected.path) !== resolvedPaths[index]) {
      throw new Error(
        `Pinned package ${index} (${expected.id}@${expected.version}) resolved to an unexpected archive path`,
      );
    }
  });

  const packageBytes = await readBoundedPackageArchives(
    resolvedPaths,
    expectedArtifacts,
  );
  const loaded = packageBytes.map((bytes, index) => {
    const resolved = resolvedPaths[index]!;
    const expected = expectedArtifacts?.[index];
    const archiveSha256 = sha256Hex(bytes);
    if (expected !== undefined && archiveSha256 !== expected.sha256) {
      throw new Error(
        `Pinned package ${index} (${expected.id}@${expected.version}) SHA-256 mismatch: expected ${expected.sha256}, found ${archiveSha256}`,
      );
    }
    // Authenticate the exact outer bytes before the compiler decodes
    // MessagePack or decompresses any package entry. The derived manifest
    // identity is compared with the pin immediately after decoding.
    const prepared = preparePackageInstall(bytes);
    const artifact: PackageArtifact = {
      path: resolved,
      id: prepared.manifest.id,
      version: prepared.manifest.version,
      sha256: archiveSha256,
      bytes: bytes.byteLength,
    };
    if (expected !== undefined) {
      assertPinnedPackageArtifact(expected, artifact, index);
    }
    return { archive: bytes, prepared, artifact };
  });
  const ids = loaded.map(({ artifact }) => artifact.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Pinned package set contains duplicate package IDs");
  }
  return loaded;
}

async function readBoundedPackageArchives(
  resolvedPaths: readonly string[],
  expectedArtifacts?: readonly PinnedPackageArtifact[],
): Promise<Uint8Array[]> {
  const handles: FileHandle[] = [];
  try {
    for (const resolved of resolvedPaths) {
      handles.push(
        await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW),
      );
    }
    const metadata = await Promise.all(handles.map((handle) => handle.stat()));
    let aggregateBytes = 0;
    for (const [index, entry] of metadata.entries()) {
      if (!entry.isFile()) {
        throw new Error(
          `Pinned package ${index} must resolve to a regular file`,
        );
      }
      if (
        entry.size < 1 ||
        entry.size > DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS.maxRawBytes
      ) {
        throw new Error(
          `Pinned package ${index} must contain 1 through ${DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS.maxRawBytes} bytes`,
        );
      }
      const expected = expectedArtifacts?.[index];
      if (expected !== undefined && expected.bytes !== entry.size) {
        throw new Error(
          `Pinned package ${index} (${expected.id}@${expected.version}) byte length mismatch: expected ${expected.bytes}, found ${entry.size}`,
        );
      }
      aggregateBytes += entry.size;
      if (aggregateBytes > MAX_PACKAGE_ARCHIVES_BYTES) {
        throw new Error(
          `Pinned package set exceeds the ${MAX_PACKAGE_ARCHIVES_BYTES}-byte aggregate limit`,
        );
      }
    }
    const bytes = await Promise.all(
      handles.map(async (handle, index) => {
        const archive = new Uint8Array(await handle.readFile());
        if (archive.byteLength !== metadata[index]!.size) {
          throw new Error(
            `Pinned package ${index} changed while it was being read`,
          );
        }
        return archive;
      }),
    );
    return bytes;
  } finally {
    await Promise.all(
      handles.map((handle) => handle.close().catch(() => undefined)),
    );
  }
}

function assertPinnedPackageArtifact(
  expected: PinnedPackageArtifact,
  actual: PackageArtifact,
  index: number,
): void {
  const label = `Pinned package ${index} (${expected.id}@${expected.version})`;
  if (path.resolve(expected.path) !== actual.path) {
    throw new Error(`${label} resolved to an unexpected archive path`);
  }
  if (expected.bytes !== actual.bytes) {
    throw new Error(
      `${label} byte length mismatch: expected ${expected.bytes}, found ${actual.bytes}`,
    );
  }
  if (expected.sha256 !== actual.sha256) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected.sha256}, found ${actual.sha256}`,
    );
  }
  if (expected.id !== actual.id || expected.version !== actual.version) {
    throw new Error(
      `${label} manifest identity mismatch: archive contains ${actual.id}@${actual.version}`,
    );
  }
}

/**
 * Revalidates rather than trusts the metadata copied into a prepared artifact.
 * Production callers invoke this before serializing a transaction or making
 * any external mutation.
 */
export function assertPreparedDeploymentWasmMetadata(
  deployment: Pick<PreparedDeployment, "compiled" | "wasmMetadata">,
): SupportedCertificateVersionsMetadataV1 {
  const actual = assertSupportedCertificateVersions(deployment.compiled.wasm);
  const recorded = assertSupportedCertificateVersionsMetadata(
    deployment.wasmMetadata,
    "prepared deployment Wasm metadata",
  );
  if (
    recorded.sectionName !== actual.sectionName ||
    recorded.sectionCount !== actual.sectionCount ||
    recorded.value !== actual.value
  ) {
    throw new Error(
      "Prepared deployment Wasm metadata evidence does not match the final Wasm",
    );
  }
  return actual;
}

export function assertFreshPackageRoles(
  packages: readonly { isKernel: boolean }[],
): void {
  const kernels = packages.filter(({ isKernel }) => isKernel);
  if (kernels.length !== 1) {
    throw new Error(
      `Fresh provisioning requires exactly one kernel package; found ${kernels.length}`,
    );
  }
  if (!packages[0]?.isKernel) {
    throw new Error(
      "Fresh provisioning requires the config kernel archive to be the first package archive",
    );
  }
}

export function assertWasmDeploymentLimits({
  rawWasmBytes,
  transportWasmBytes,
  chunkCount,
}: {
  rawWasmBytes: number;
  transportWasmBytes: number;
  chunkCount: number;
}): void {
  for (const [label, value] of [
    ["Raw Wasm bytes", rawWasmBytes],
    ["Transport Wasm bytes", transportWasmBytes],
    ["Wasm chunk count", chunkCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive safe integer`);
    }
  }
  if (rawWasmBytes > IC_MAX_WASM_BYTES) {
    throw new Error(
      `Compiled Wasm is ${rawWasmBytes} bytes; the IC limit is ${IC_MAX_WASM_BYTES} bytes`,
    );
  }
  if (transportWasmBytes > IC_MAX_CHUNK_STORE_BYTES) {
    throw new Error(
      `Compressed Wasm is ${transportWasmBytes} bytes; the IC chunk-store limit is ${IC_MAX_CHUNK_STORE_BYTES} bytes`,
    );
  }
  if (chunkCount > IC_MAX_WASM_CHUNKS) {
    throw new Error(
      `Compressed Wasm needs ${chunkCount} chunks; the IC limit is ${IC_MAX_WASM_CHUNKS} chunks`,
    );
  }
}

export function chunkWasm(
  wasm: Uint8Array,
  chunkBytes = MANAGEMENT_CHUNK_BYTES,
): WasmChunk[] {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error("Chunk size must be a positive integer");
  }
  if (wasm.byteLength === 0) throw new Error("Compiled Wasm is empty");
  const chunks: WasmChunk[] = [];
  for (let start = 0; start < wasm.byteLength; start += chunkBytes) {
    const bytes = wasm.slice(start, Math.min(start + chunkBytes, wasm.byteLength));
    const hash = sha256(bytes);
    chunks.push({ bytes, hash, hashHex: toHex(hash) });
  }
  return chunks;
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function toHex(bytes: Uint8Array | number[]): string {
  return Buffer.from(bytes).toString("hex");
}
