import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { CompileResult } from "neutron-compiler/src/compile.js";
import {
  ASSEMBLER_ID,
  LEGACY_V25_ASSEMBLER_ID,
} from "neutron-compiler/src/assemble.js";
import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";

const CACHE_FORMAT = 3;
const CACHE_DOMAIN = "neutron-compiled-actor-cache-v3";
const CACHE_FILES = [
  "metadata.json",
  "neutron.did",
  "neutron.most",
  "neutron.wasm",
] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_WASM_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 4096;

export type CacheableCompileResult = Pick<
  CompileResult,
  | "wasm"
  | "candid"
  | "stable"
  | "deploymentId"
  | "compilerId"
  | "assemblerId"
  | "browserSurfaceOriginAppIds"
>;

export type LocalCompiledActorCacheOptions = {
  directory: string;
  compilerFingerprint: string;
  installationNetworkIdHex: string;
  logger?: Pick<Console, "log">;
};

type CacheInputs = {
  target: "local" | "production";
  compilerFingerprint: string;
  packageArchiveSha256: string[];
  installationNetworkIdHex: string;
};

type CachedFileMetadata = {
  file: string;
  bytes: number;
  sha256: string;
};

type CompiledCacheMetadata = {
  format: 3;
  cacheKey: string;
  target: "local";
  compilerFingerprint: string;
  packageArchiveSha256: string[];
  installationNetworkIdHex: string;
  compilerId: string;
  assemblerId: typeof ASSEMBLER_ID | typeof LEGACY_V25_ASSEMBLER_ID;
  deploymentId: string;
  browserSurfaceOriginAppIds: string[];
  wasm: CachedFileMetadata;
  candid: CachedFileMetadata;
  stable: CachedFileMetadata;
};

/**
 * Resolve a deterministic local compile from the rebuildable provision cache.
 * Package parsing remains outside this boundary because the caller still needs
 * every package's certified files for the destructive reinstall.
 */
export async function resolveLocalCompiledActor({
  cache,
  packageArchiveSha256,
  compile,
}: {
  cache: LocalCompiledActorCacheOptions;
  packageArchiveSha256: string[];
  compile: () => Promise<CacheableCompileResult>;
}): Promise<CacheableCompileResult> {
  const inputs: CacheInputs = {
    target: "local",
    compilerFingerprint: cache.compilerFingerprint,
    packageArchiveSha256,
    installationNetworkIdHex: cache.installationNetworkIdHex,
  };
  validateCacheInputs(inputs);
  if (cache.directory.length === 0) {
    throw new Error("Compiled actor cache directory is required");
  }

  const logger = cache.logger ?? console;
  const cacheRoot = path.resolve(cache.directory);
  await ensureRealDirectory(cacheRoot);
  const versionDirectory = path.join(cacheRoot, `v${CACHE_FORMAT}`);
  await ensureRealDirectory(versionDirectory);
  const cacheKey = compiledActorCacheKey(inputs);
  const entryDirectory = path.join(versionDirectory, cacheKey);
  const expected = { ...inputs, cacheKey } as const;

  const cached = await readCacheEntry(entryDirectory, expected, logger);
  if (cached) {
    logger.log(`Using cached compiled local actor ${cacheKey.slice(0, 12)}`);
    return cached;
  }

  logger.log("Compiling complete local actor");
  const compiled = await compile();
  assertCompileResult(compiled);
  const stored = await writeCacheEntry({
    versionDirectory,
    entryDirectory,
    expected,
    compiled,
    logger,
  });
  return stored ?? compiled;
}

/** Content key for tests, diagnostics, and the on-disk entry name. */
export function compiledActorCacheKey(inputs: CacheInputs): string {
  validateCacheInputs(inputs);
  return createHash("sha256")
    .update(CACHE_DOMAIN)
    .update("\0")
    .update(
      JSON.stringify({
        target: inputs.target,
        compilerFingerprint: inputs.compilerFingerprint,
        packageArchiveSha256: inputs.packageArchiveSha256,
        installationNetworkIdHex: inputs.installationNetworkIdHex,
      }),
    )
    .digest("hex");
}

async function readCacheEntry(
  entryDirectory: string,
  expected: CacheInputs & { cacheKey: string },
  logger: Pick<Console, "log">,
): Promise<CacheableCompileResult | null> {
  try {
    const entry = await lstat(entryDirectory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("entry is not a real directory");
    }
  } catch (error) {
    if (isMissingFileError(error)) return null;
    await discardInvalidEntry(entryDirectory, error, logger);
    return null;
  }

  try {
    const entries = (await readdir(entryDirectory, { withFileTypes: true }))
      .map(({ name }) => name)
      .sort();
    if (JSON.stringify(entries) !== JSON.stringify(CACHE_FILES)) {
      throw new Error("entry does not contain exactly the compiled cache files");
    }

    const metadataBytes = await readRegularFile(
      path.join(entryDirectory, "metadata.json"),
      MAX_METADATA_BYTES,
    );
    const metadata = parseMetadata(decodeUtf8(metadataBytes, "cache metadata"));
    assertMetadataInputs(metadata, expected);

    const [wasm, candidBytes, stableBytes] = await Promise.all([
      readVerifiedOutput(entryDirectory, metadata.wasm, MAX_WASM_BYTES),
      readVerifiedOutput(entryDirectory, metadata.candid, MAX_TEXT_BYTES),
      readVerifiedOutput(entryDirectory, metadata.stable, MAX_TEXT_BYTES),
    ]);
    return {
      wasm,
      candid: decodeUtf8(candidBytes, "cached Candid"),
      stable: decodeUtf8(stableBytes, "cached stable schema"),
      compilerId: metadata.compilerId,
      assemblerId: metadata.assemblerId,
      deploymentId: metadata.deploymentId,
      browserSurfaceOriginAppIds: metadata.browserSurfaceOriginAppIds,
    };
  } catch (error) {
    await discardInvalidEntry(entryDirectory, error, logger);
    return null;
  }
}

async function writeCacheEntry({
  versionDirectory,
  entryDirectory,
  expected,
  compiled,
  logger,
}: {
  versionDirectory: string;
  entryDirectory: string;
  expected: CacheInputs & { cacheKey: string };
  compiled: CacheableCompileResult;
  logger: Pick<Console, "log">;
}): Promise<CacheableCompileResult | null> {
  const candid = new TextEncoder().encode(compiled.candid);
  const stable = new TextEncoder().encode(compiled.stable);
  const metadata: CompiledCacheMetadata = {
    format: CACHE_FORMAT,
    cacheKey: expected.cacheKey,
    target: "local",
    compilerFingerprint: expected.compilerFingerprint,
    packageArchiveSha256: [...expected.packageArchiveSha256],
    installationNetworkIdHex: expected.installationNetworkIdHex,
    compilerId: compiled.compilerId,
    assemblerId: compiled.assemblerId,
    deploymentId: compiled.deploymentId,
    browserSurfaceOriginAppIds: [...compiled.browserSurfaceOriginAppIds],
    wasm: fileMetadata("neutron.wasm", compiled.wasm),
    candid: fileMetadata("neutron.did", candid),
    stable: fileMetadata("neutron.most", stable),
  };
  const temporary = path.join(
    versionDirectory,
    `.${expected.cacheKey}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    await Promise.all([
      writeFile(path.join(temporary, "neutron.wasm"), compiled.wasm, {
        mode: 0o600,
        flag: "wx",
      }),
      writeFile(path.join(temporary, "neutron.did"), candid, {
        mode: 0o600,
        flag: "wx",
      }),
      writeFile(path.join(temporary, "neutron.most"), stable, {
        mode: 0o600,
        flag: "wx",
      }),
    ]);
    await writeFile(
      path.join(temporary, "metadata.json"),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    try {
      await rename(temporary, entryDirectory);
      return null;
    } catch (error) {
      if (!isDestinationExistsError(error)) throw error;
      const concurrent = await readCacheEntry(entryDirectory, expected, logger);
      if (!concurrent) {
        await rename(temporary, entryDirectory);
        return null;
      }
      if (!equalCompileOutputs(concurrent, compiled)) {
        throw new Error(
          `Compiled actor cache produced different outputs for ${expected.cacheKey}`,
        );
      }
      return concurrent;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function fileMetadata(file: string, bytes: Uint8Array): CachedFileMetadata {
  return {
    file,
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
}

async function readVerifiedOutput(
  entryDirectory: string,
  metadata: CachedFileMetadata,
  maximumBytes: number,
): Promise<Uint8Array> {
  const bytes = await readRegularFile(
    path.join(entryDirectory, metadata.file),
    maximumBytes,
  );
  if (bytes.byteLength !== metadata.bytes) {
    throw new Error(`${metadata.file} byte length does not match metadata`);
  }
  if (sha256Hex(bytes) !== metadata.sha256) {
    throw new Error(`${metadata.file} SHA-256 does not match metadata`);
  }
  return new Uint8Array(bytes);
}

async function readRegularFile(
  filename: string,
  maximumBytes: number,
): Promise<Buffer> {
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${path.basename(filename)} is not a regular file`);
  }
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(`${path.basename(filename)} has an invalid byte length`);
  }
  return readFile(filename);
}

function parseMetadata(source: string): CompiledCacheMetadata {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error("Compiled actor cache metadata is not valid JSON", {
      cause: error,
    });
  }
  if (!isPlainRecord(value)) {
    throw new Error("Compiled actor cache metadata must be an object");
  }
  assertExactFields(
    value,
    [
      "format",
      "cacheKey",
      "target",
      "compilerFingerprint",
      "packageArchiveSha256",
      "installationNetworkIdHex",
      "compilerId",
      "assemblerId",
      "deploymentId",
      "browserSurfaceOriginAppIds",
      "wasm",
      "candid",
      "stable",
    ],
    "Compiled actor cache metadata",
  );
  if (value.format !== CACHE_FORMAT) {
    throw new Error(`Compiled actor cache format must be ${CACHE_FORMAT}`);
  }
  if (value.target !== "local") {
    throw new Error("Compiled actor cache target must be local");
  }
  const packageArchiveSha256 = requiredDigestArray(
    value.packageArchiveSha256,
    "packageArchiveSha256",
  );
  const result: CompiledCacheMetadata = {
    format: CACHE_FORMAT,
    cacheKey: requiredDigest(value.cacheKey, "cacheKey"),
    target: "local",
    compilerFingerprint: requiredDigest(
      value.compilerFingerprint,
      "compilerFingerprint",
    ),
    packageArchiveSha256,
    installationNetworkIdHex: requiredDigest(
      value.installationNetworkIdHex,
      "installationNetworkIdHex",
    ),
    compilerId: requiredIdentifier(value.compilerId, "compilerId"),
    assemblerId: requiredAssemblerId(value.assemblerId),
    deploymentId: requiredIdentifier(value.deploymentId, "deploymentId"),
    browserSurfaceOriginAppIds: requiredBrowserSurfaceOriginAppIds(
      value.browserSurfaceOriginAppIds,
    ),
    wasm: requiredFileMetadata(value.wasm, "wasm", "neutron.wasm"),
    candid: requiredFileMetadata(value.candid, "candid", "neutron.did"),
    stable: requiredFileMetadata(value.stable, "stable", "neutron.most"),
  };
  return result;
}

function requiredFileMetadata(
  value: unknown,
  label: string,
  expectedFile: string,
): CachedFileMetadata {
  if (!isPlainRecord(value)) {
    throw new Error(`${label} metadata must be an object`);
  }
  assertExactFields(value, ["file", "bytes", "sha256"], `${label} metadata`);
  if (value.file !== expectedFile) {
    throw new Error(`${label} metadata file must be ${expectedFile}`);
  }
  if (
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1
  ) {
    throw new Error(`${label} metadata bytes must be a positive safe integer`);
  }
  return {
    file: expectedFile,
    bytes: value.bytes,
    sha256: requiredDigest(value.sha256, `${label}.sha256`),
  };
}

function assertMetadataInputs(
  metadata: CompiledCacheMetadata,
  expected: CacheInputs & { cacheKey: string },
): void {
  if (
    metadata.cacheKey !== expected.cacheKey ||
    metadata.target !== expected.target ||
    metadata.compilerFingerprint !== expected.compilerFingerprint ||
    metadata.installationNetworkIdHex !==
      expected.installationNetworkIdHex ||
    JSON.stringify(metadata.packageArchiveSha256) !==
      JSON.stringify(expected.packageArchiveSha256)
  ) {
    throw new Error("Compiled actor cache metadata does not match its inputs");
  }
}

function validateCacheInputs(inputs: CacheInputs): void {
  if (inputs.target !== "local" && inputs.target !== "production") {
    throw new Error("Compiled actor cache target is invalid");
  }
  requiredDigest(inputs.compilerFingerprint, "Compiler fingerprint");
  requiredDigestArray(inputs.packageArchiveSha256, "Package archive hashes");
  requiredDigest(
    inputs.installationNetworkIdHex,
    "Installation network ID",
  );
}

function requiredDigestArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a non-empty array of at most 256 hashes`);
  }
  return value.map((entry, index) =>
    requiredDigest(entry, `${label}[${index}]`),
  );
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase hexadecimal SHA-256`);
  }
  return value;
}

function requiredIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function requiredAssemblerId(
  value: unknown,
): typeof ASSEMBLER_ID | typeof LEGACY_V25_ASSEMBLER_ID {
  if (value !== ASSEMBLER_ID && value !== LEGACY_V25_ASSEMBLER_ID) {
    throw new Error("assemblerId is not a supported compiler generation");
  }
  return value;
}

function requiredBrowserSurfaceOriginAppIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("browserSurfaceOriginAppIds must be a bounded array");
  }
  const ids = value.map((appId) => {
    if (
      typeof appId !== "string" ||
      appId === "kernel" ||
      !isValidAppId(appId)
    ) {
      throw new Error("browserSurfaceOriginAppIds contains an invalid app id");
    }
    return appId;
  });
  const canonical = [...ids].sort(compareCanonicalText);
  if (
    new Set(ids).size !== ids.length ||
    JSON.stringify(ids) !== JSON.stringify(canonical)
  ) {
    throw new Error("browserSurfaceOriginAppIds must be unique and canonical");
  }
  return ids;
}

function assertCompileResult(compiled: CacheableCompileResult): void {
  if (!(compiled.wasm instanceof Uint8Array) || compiled.wasm.byteLength < 1) {
    throw new Error("Compiled actor Wasm is empty");
  }
  if (compiled.wasm.byteLength > MAX_WASM_BYTES) {
    throw new Error("Compiled actor Wasm exceeds the cache limit");
  }
  for (const [label, value] of [
    ["Candid", compiled.candid],
    ["stable schema", compiled.stable],
  ] as const) {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes < 1 || bytes > MAX_TEXT_BYTES) {
      throw new Error(`Compiled actor ${label} has an invalid byte length`);
    }
  }
  requiredIdentifier(compiled.compilerId, "compilerId");
  requiredAssemblerId(compiled.assemblerId);
  requiredIdentifier(compiled.deploymentId, "deploymentId");
  requiredBrowserSurfaceOriginAppIds(compiled.browserSurfaceOriginAppIds);
}

function equalCompileOutputs(
  left: CacheableCompileResult,
  right: CacheableCompileResult,
): boolean {
  return (
    sha256Hex(left.wasm) === sha256Hex(right.wasm) &&
    left.candid === right.candid &&
    left.stable === right.stable &&
    left.compilerId === right.compilerId &&
    left.assemblerId === right.assemblerId &&
    left.deploymentId === right.deploymentId &&
    JSON.stringify(left.browserSurfaceOriginAppIds) ===
      JSON.stringify(right.browserSurfaceOriginAppIds)
  );
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Compiled actor cache path is not a real directory: ${directory}`);
  }
}

async function discardInvalidEntry(
  entryDirectory: string,
  cause: unknown,
  logger: Pick<Console, "log">,
): Promise<void> {
  const reason = cause instanceof Error ? cause.message : String(cause);
  logger.log(`Discarding invalid compiled actor cache: ${reason}`);
  await rm(entryDirectory, { recursive: true, force: true });
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).filter((field) => !expectedSet.has(field));
  const missing = expected.filter(
    (field) => !Object.prototype.hasOwnProperty.call(value, field),
  );
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}`);
  }
  if (missing.length > 0) {
    throw new Error(`${label} is missing field(s): ${missing.join(", ")}`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function isDestinationExistsError(error: unknown): boolean {
  return hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
