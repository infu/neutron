import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS,
  preparePackageInstall,
  unpackNeutronPackage,
} from "neutron-compiler/src/install.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import {
  assertPreparedDeploymentWasmMetadata,
  assertWasmDeploymentLimits,
  chunkWasm,
  IC_MAX_CHUNK_STORE_BYTES,
  IC_MAX_WASM_BYTES,
  MAX_PACKAGE_ARCHIVES,
  sha256Hex,
  type PackageArtifact,
  type PreparedDeployment,
} from "./artifact.ts";
import { assertSupportedCertificateVersions } from "neutron-tools/src/wasm_metadata.js";

export const TRANSACTION_PAYLOAD_VERSION = 3;
const RETIRED_TRANSACTION_PAYLOAD_VERSIONS = [2] as const;

const SESSION_SUFFIX = ".ndeploy.session.json";
const MAGIC = new TextEncoder().encode("NEUTRON-PROVISION-PAYLOAD\0");
const LENGTH_BYTES = 4;
const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_ARCHIVE_BYTES =
  DEFAULT_NEUTRON_PACKAGE_DECODE_LIMITS.maxRawBytes;
const MAX_PACKAGE_ARCHIVES_BYTES = 256 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type TransactionPayloadHeader = {
  schema: typeof TRANSACTION_PAYLOAD_VERSION;
  packages: Array<{
    id: string;
    version: number;
    sha256: string;
    bytes: number;
  }>;
  compilerId: string;
  deploymentId: string;
  rawWasmSha256: string;
  rawWasmBytes: number;
  transportWasmSha256: string;
  transportWasmBytes: number;
  candidSha256: string;
  candidBytes: number;
  stableSha256: string;
  stableBytes: number;
};

export type SerializedTransactionPayload = {
  version: typeof TRANSACTION_PAYLOAD_VERSION;
  sha256: string;
  bytes: Uint8Array;
};

export function transactionPayloadPath(
  sessionPath: string,
  payloadSha256: string,
): string {
  assertSha256(payloadSha256, "transaction payload SHA-256");
  const resolved = path.resolve(sessionPath);
  if (!resolved.endsWith(SESSION_SUFFIX)) {
    throw new Error(
      `Deployment session path must end with ${SESSION_SUFFIX}: ${resolved}`,
    );
  }
  const stem = path.basename(resolved, SESSION_SUFFIX);
  return path.join(
    path.dirname(resolved),
    ".neutron",
    "provision",
    `${stem}-${payloadSha256}.payload-v${TRANSACTION_PAYLOAD_VERSION}`,
  );
}

export function serializeTransactionPayload(
  deployment: PreparedDeployment,
): SerializedTransactionPayload {
  // This is the last purely local gate before a payload can be persisted and
  // referenced by a paid or destructive production transaction.
  assertPreparedDeploymentWasmMetadata(deployment);
  if (
    deployment.packages.length !== deployment.packageArchives.length ||
    deployment.packages.length !== deployment.packageArtifacts.length
  ) {
    throw new Error(
      "Prepared deployment package archives, metadata, and installs are not aligned",
    );
  }
  const candid = new TextEncoder().encode(deployment.compiled.candid);
  const stable = new TextEncoder().encode(deployment.compiled.stable);
  const header: TransactionPayloadHeader = {
    schema: TRANSACTION_PAYLOAD_VERSION,
    packages: deployment.packageArtifacts.map((artifact) => ({
      id: artifact.id,
      version: artifact.version,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    })),
    compilerId: deployment.compiled.compilerId,
    deploymentId: deployment.compiled.deploymentId,
    rawWasmSha256: deployment.rawWasmSha256,
    rawWasmBytes: deployment.compiled.wasm.byteLength,
    transportWasmSha256: deployment.transportWasmSha256,
    transportWasmBytes: deployment.transportWasm.byteLength,
    candidSha256: deployment.candidSha256,
    candidBytes: candid.byteLength,
    stableSha256: deployment.stableSha256,
    stableBytes: stable.byteLength,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > 0xffff_ffff) {
    throw new Error("Transaction payload header is too large");
  }
  const total = checkedAdd(
    checkedAdd(MAGIC.byteLength, LENGTH_BYTES, "transaction payload bytes"),
    headerBytes.byteLength,
    "transaction payload bytes",
  );
  const blobBytes = [
    ...deployment.packageArchives,
    deployment.transportWasm,
    candid,
    stable,
  ].reduce(
    (sum, bytes) => checkedAdd(sum, bytes.byteLength, "transaction payload bytes"),
    total,
  );
  if (blobBytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Transaction payload is ${blobBytes} bytes; limit is ${MAX_PAYLOAD_BYTES}`,
    );
  }
  const bytes = new Uint8Array(blobBytes);
  let offset = 0;
  bytes.set(MAGIC, offset);
  offset += MAGIC.byteLength;
  new DataView(bytes.buffer, bytes.byteOffset + offset, LENGTH_BYTES).setUint32(
    0,
    headerBytes.byteLength,
    false,
  );
  offset += LENGTH_BYTES;
  bytes.set(headerBytes, offset);
  offset += headerBytes.byteLength;
  for (const blob of [
    ...deployment.packageArchives,
    deployment.transportWasm,
    candid,
    stable,
  ]) {
    bytes.set(blob, offset);
    offset += blob.byteLength;
  }
  if (offset !== bytes.byteLength) {
    throw new Error("Transaction payload serialization length mismatch");
  }

  // Validate our own output before it can become an external transaction journal.
  parseTransactionPayload(bytes, deployment.packageArtifacts);
  return {
    version: TRANSACTION_PAYLOAD_VERSION,
    sha256: sha256Hex(bytes),
    bytes,
  };
}

export async function readTransactionPayload({
  sessionPath,
  expectedSha256,
  packageProvenance,
}: {
  sessionPath: string;
  expectedSha256: string;
  packageProvenance: PackageArtifact[];
}): Promise<PreparedDeployment> {
  assertSha256(expectedSha256, "expected transaction payload SHA-256");
  const filename = transactionPayloadPath(sessionPath, expectedSha256);
  const bytes = await readPrivateFile(filename);
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Transaction payload digest mismatch: ${actualSha256} != ${expectedSha256}`,
    );
  }
  return parseTransactionPayload(bytes, packageProvenance);
}

/** Durably publish a validated, content-addressed payload without replacement. */
export async function persistTransactionPayload(
  sessionPath: string,
  payload: SerializedTransactionPayload,
): Promise<string> {
  if (payload.version !== TRANSACTION_PAYLOAD_VERSION) {
    throw new Error(`Unsupported transaction payload version ${payload.version}`);
  }
  if (sha256Hex(payload.bytes) !== payload.sha256) {
    throw new Error("Serialized transaction payload digest is invalid");
  }
  const filename = transactionPayloadPath(sessionPath, payload.sha256);
  const directory = path.dirname(filename);
  await ensureSecureDirectory(directory);
  const temporary = `${filename}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(payload.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, filename);
      await fsyncDirectory(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const existing = await readPrivateFile(filename);
      if (sha256Hex(existing) !== payload.sha256) {
        throw new Error(
          `Refusing to replace immutable transaction payload ${filename}`,
        );
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return filename;
}

export async function removeTransactionPayload(
  sessionPath: string,
  payloadSha256: string,
): Promise<void> {
  const filename = transactionPayloadPath(sessionPath, payloadSha256);
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing symlink transaction payload ${filename}`);
  }
  assertPrivateOwnedFile(metadata, `transaction payload ${filename}`);
  await rm(filename);
  await fsyncDirectory(path.dirname(filename));
}

/**
 * Remove transaction payloads which are not referenced by the active journal.
 *
 * A hard interruption can happen after an immutable payload is published but
 * before the journal publishes `active`. The payload directory is deliberately
 * private, so a later executing invocation can safely retire those orphans.
 * Only the exact final payload named by `preserveSha256` survives; abandoned
 * temporary files and every other final payload for this session are removed.
 */
export async function sweepUnreferencedTransactionPayloads(
  sessionPath: string,
  preserveSha256?: string,
): Promise<number> {
  if (preserveSha256 !== undefined) {
    assertSha256(preserveSha256, "preserved transaction payload SHA-256");
  }
  const location = transactionPayloadLocation(sessionPath);
  if (!(await secureDirectoryExists(location.directory))) return 0;

  const finalPattern = new RegExp(
    `^${escapeRegExp(location.stem)}-([0-9a-f]{64})\\.payload-v${TRANSACTION_PAYLOAD_VERSION}$`,
  );
  const temporaryPattern = new RegExp(
    `^${escapeRegExp(location.stem)}-([0-9a-f]{64})\\.payload-v${TRANSACTION_PAYLOAD_VERSION}\\.tmp-[1-9][0-9]*-[0-9a-f]{12}$`,
  );
  const retiredVersions = RETIRED_TRANSACTION_PAYLOAD_VERSIONS.join("|");
  const retiredPattern = new RegExp(
    `^${escapeRegExp(location.stem)}-[0-9a-f]{64}\\.payload-v(?:${retiredVersions})(?:\\.tmp-[1-9][0-9]*-[0-9a-f]{12})?$`,
  );
  let removed = 0;
  for (const entry of await readdir(location.directory, { withFileTypes: true })) {
    const final = finalPattern.exec(entry.name);
    const temporary = temporaryPattern.exec(entry.name);
    const retired = retiredPattern.test(entry.name);
    if (!final && !temporary && !retired) continue;
    const filename = path.join(location.directory, entry.name);
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing symlink transaction payload ${filename}`);
    }
    assertPrivateOwnedFile(metadata, `transaction payload ${filename}`);
    if (!retired && final?.[1] === preserveSha256) continue;
    await rm(filename);
    removed += 1;
  }
  if (removed > 0) await fsyncDirectory(location.directory);
  return removed;
}

export function parseTransactionPayload(
  bytes: Uint8Array,
  packageProvenance?: PackageArtifact[],
): PreparedDeployment {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("Transaction payload is empty");
  }
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Transaction payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  const minimum = MAGIC.byteLength + LENGTH_BYTES + 1;
  if (bytes.byteLength < minimum || !equalBytes(bytes.subarray(0, MAGIC.byteLength), MAGIC)) {
    throw new Error("Malformed transaction payload: invalid magic");
  }
  let offset = MAGIC.byteLength;
  const headerBytes = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    LENGTH_BYTES,
  ).getUint32(0, false);
  offset += LENGTH_BYTES;
  if (headerBytes < 2 || headerBytes > bytes.byteLength - offset) {
    throw new Error("Malformed transaction payload: invalid header length");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset, offset + headerBytes),
      ),
    ) as unknown;
  } catch (error) {
    throw new Error("Malformed transaction payload: invalid metadata header", {
      cause: error,
    });
  }
  offset += headerBytes;
  const header = record(parsed, "transaction payload header");
  exactKeys(
    header,
    [
      "schema",
      "packages",
      "compilerId",
      "deploymentId",
      "rawWasmSha256",
      "rawWasmBytes",
      "transportWasmSha256",
      "transportWasmBytes",
      "candidSha256",
      "candidBytes",
      "stableSha256",
      "stableBytes",
    ],
    "transaction payload header",
  );
  if (header.schema !== TRANSACTION_PAYLOAD_VERSION) {
    throw new Error(`Unsupported transaction payload schema ${String(header.schema)}`);
  }
  if (
    !Array.isArray(header.packages) ||
    header.packages.length === 0 ||
    header.packages.length > MAX_PACKAGE_ARCHIVES
  ) {
    invalid("transaction payload header.packages", "must be a non-empty bounded array");
  }
  if (
    packageProvenance !== undefined &&
    packageProvenance.length !== header.packages.length
  ) {
    invalid("transaction payload header.packages", "does not match session provenance");
  }

  const packageIds = new Set<string>();
  let totalArchiveBytes = 0;
  const packageArchives: Uint8Array[] = [];
  const packageArtifacts: PackageArtifact[] = [];
  const packages = header.packages.map((raw, index) => {
    const label = `transaction payload header.packages[${index}]`;
    const entry = record(raw, label);
    exactKeys(entry, ["id", "version", "sha256", "bytes"], label);
    if (!isValidAppId(entry.id)) invalid(label, "has an invalid package id");
    if (packageIds.has(entry.id)) invalid(label, `duplicates ${entry.id}`);
    packageIds.add(entry.id);
    const version = safeInteger(entry.version, `${label}.version`, 0);
    const archiveBytes = boundedInteger(
      entry.bytes,
      `${label}.bytes`,
      1,
      MAX_PACKAGE_ARCHIVE_BYTES,
    );
    totalArchiveBytes = checkedAdd(
      totalArchiveBytes,
      archiveBytes,
      "transaction payload package archive bytes",
    );
    if (totalArchiveBytes > MAX_PACKAGE_ARCHIVES_BYTES) {
      invalid(
        "transaction payload header.packages",
        `archives exceed ${MAX_PACKAGE_ARCHIVES_BYTES} aggregate bytes`,
      );
    }
    const digest = assertSha256(entry.sha256, `${label}.sha256`);
    const archive = takeBytes(bytes, offset, archiveBytes, `${label} archive`);
    offset += archiveBytes;
    if (sha256Hex(archive) !== digest) invalid(label, "archive digest is invalid");
    const provenance = packageProvenance?.[index];
    if (
      provenance &&
      (provenance.id !== entry.id ||
        provenance.version !== version ||
        provenance.sha256 !== digest ||
        provenance.bytes !== archiveBytes)
    ) {
      invalid(label, "does not match session package provenance");
    }
    const artifact: PackageArtifact = {
      path:
        provenance?.path ??
        path.resolve("/transaction-payload", `${index}-${entry.id}.neutron`),
      id: entry.id,
      version,
      sha256: digest,
      bytes: archiveBytes,
    };
    const unpacked = unpackNeutronPackage(archive);
    const prepared = preparePackageInstall(unpacked, {
      expectedIdentity: { id: artifact.id, version: artifact.version },
    });
    packageArchives.push(archive);
    packageArtifacts.push(artifact);
    return prepared;
  });
  if (packages.filter(({ isKernel }) => isKernel).length !== 1) {
    invalid("transaction payload header.packages", "must contain exactly one kernel");
  }
  const compilerId = boundedString(
    header.compilerId,
    "transaction payload header.compilerId",
    512,
  );
  const deploymentId = boundedString(
    header.deploymentId,
    "transaction payload header.deploymentId",
    512,
  );
  const rawWasmBytes = boundedInteger(
    header.rawWasmBytes,
    "transaction payload header.rawWasmBytes",
    1,
    IC_MAX_WASM_BYTES,
  );
  const rawWasmSha256 = assertSha256(
    header.rawWasmSha256,
    "transaction payload header.rawWasmSha256",
  );
  const transportWasmBytes = boundedInteger(
    header.transportWasmBytes,
    "transaction payload header.transportWasmBytes",
    1,
    IC_MAX_CHUNK_STORE_BYTES,
  );
  const transportWasm = takeBytes(
    bytes,
    offset,
    transportWasmBytes,
    "transport Wasm",
  );
  offset += transportWasmBytes;
  const transportWasmSha256 = assertSha256(
    header.transportWasmSha256,
    "transaction payload header.transportWasmSha256",
  );
  if (sha256Hex(transportWasm) !== transportWasmSha256) {
    invalid("transaction payload transport Wasm", "digest is invalid");
  }
  let rawWasm: Uint8Array;
  try {
    rawWasm = new Uint8Array(
      gunzipSync(transportWasm, { maxOutputLength: IC_MAX_WASM_BYTES }),
    );
  } catch (error) {
    throw new Error("Malformed transaction payload: transport Wasm is not bounded gzip", {
      cause: error,
    });
  }
  if (rawWasm.byteLength !== rawWasmBytes || sha256Hex(rawWasm) !== rawWasmSha256) {
    invalid("transaction payload transport Wasm", "expanded Wasm is invalid");
  }
  const wasmMetadata = assertSupportedCertificateVersions(rawWasm);

  const candidBytes = boundedInteger(
    header.candidBytes,
    "transaction payload header.candidBytes",
    1,
    MAX_TEXT_BYTES,
  );
  const candidRaw = takeBytes(bytes, offset, candidBytes, "Candid");
  offset += candidBytes;
  const candid = decodeText(candidRaw, "Candid");
  const candidSha256 = assertSha256(
    header.candidSha256,
    "transaction payload header.candidSha256",
  );
  if (sha256Hex(candidRaw) !== candidSha256) {
    invalid("transaction payload Candid", "digest is invalid");
  }
  const stableBytes = boundedInteger(
    header.stableBytes,
    "transaction payload header.stableBytes",
    1,
    MAX_TEXT_BYTES,
  );
  const stableRaw = takeBytes(bytes, offset, stableBytes, "stable schema");
  offset += stableBytes;
  const stable = decodeText(stableRaw, "stable schema");
  const stableSha256 = assertSha256(
    header.stableSha256,
    "transaction payload header.stableSha256",
  );
  if (sha256Hex(stableRaw) !== stableSha256) {
    invalid("transaction payload stable schema", "digest is invalid");
  }
  if (offset !== bytes.byteLength) {
    invalid("transaction payload", "contains trailing bytes");
  }
  const chunks = chunkWasm(transportWasm);
  assertWasmDeploymentLimits({
    rawWasmBytes,
    transportWasmBytes,
    chunkCount: chunks.length,
  });
  return {
    packages,
    packageArchives,
    packageArtifacts,
    compiled: {
      wasm: rawWasm,
      candid,
      stable,
      compilerId,
      deploymentId,
    },
    wasmMetadata,
    transportWasm,
    rawWasmSha256,
    transportWasmSha256,
    candidSha256,
    stableSha256,
    chunks,
  };
}

async function readPrivateFile(filename: string): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ELOOP")) {
      throw new Error(`Transaction payload is missing or unsafe: ${filename}`);
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    assertPrivateOwnedFile(metadata, `transaction payload ${filename}`);
    if (metadata.size > MAX_PAYLOAD_BYTES) {
      throw new Error(`Transaction payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function ensureSecureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSecureDirectory(directory);
}

async function secureDirectoryExists(directory: string): Promise<boolean> {
  try {
    await assertSecureDirectory(directory);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertSecureDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Provision payload directory must be a real directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`Provision payload directory is not owned by the current user: ${directory}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Provision payload directory must be private: ${directory}`);
  }
}

function transactionPayloadLocation(sessionPath: string): {
  directory: string;
  stem: string;
} {
  const resolved = path.resolve(sessionPath);
  if (!resolved.endsWith(SESSION_SUFFIX)) {
    throw new Error(
      `Deployment session path must end with ${SESSION_SUFFIX}: ${resolved}`,
    );
  }
  return {
    directory: path.join(path.dirname(resolved), ".neutron", "provision"),
    stem: path.basename(resolved, SESSION_SUFFIX),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPrivateOwnedFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  const uid = process.getuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new Error(`${label} is not owned by the current user`);
  }
  if ((Number(metadata.mode) & 0o077) !== 0) {
    throw new Error(`${label} must have mode 0600 or stricter`);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function takeBytes(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
): Uint8Array {
  if (offset < 0 || length < 0 || offset > bytes.byteLength - length) {
    invalid(`transaction payload ${label}`, "is truncated");
  }
  return bytes.slice(offset, offset + length);
}

function decodeText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Malformed transaction payload: ${label} is not UTF-8`, {
      cause: error,
    });
  }
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(label, "must be a lowercase SHA-256 digest");
  }
  return value;
}

function boundedString(value: unknown, label: string, maxUtf8Bytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(label, "must be a non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > maxUtf8Bytes) {
    invalid(label, `exceeds ${maxUtf8Bytes} UTF-8 bytes`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(label, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  return safeInteger(value, label, minimum, maximum);
}

function checkedAdd(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) invalid(label, "overflowed");
  return sum;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(label, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const expectedSet = new Set(expected);
  const unknown = keys.filter((key) => !expectedSet.has(key));
  const missing = expected.filter(
    (key) => !Object.prototype.hasOwnProperty.call(value, key),
  );
  if (unknown.length > 0) invalid(label, `has unknown field(s): ${unknown.join(", ")}`);
  if (missing.length > 0) invalid(label, `is missing field(s): ${missing.join(", ")}`);
}

function invalid(label: string, message: string): never {
  throw new Error(`Malformed ${label}: ${message}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
