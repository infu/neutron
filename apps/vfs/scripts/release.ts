import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  unpackNeutronPackage,
} from "neutron-compiler/src/install.ts";
import {
  packageArchiveFilename,
} from "neutron-tools/src/package_archive.js";
import {
  hashContent,
  removeCommentsAndEmptyLines,
} from "neutron-scripts/src/walk.ts";
import {
  buildFilesInlineWorkerBundle,
} from "./worker_bundle.ts";

const RELEASE_EVIDENCE_PATH = ".neutron-release-evidence.json";
const RELEASE_EVIDENCE_SCHEMA = "neutron.files.release-evidence.v4";
const PACKAGE_VERIFICATION_SCHEMA = "neutron.files.package-verification.v2";
const HARD_CUT_ENV = "NEUTRON_FILES_V2_FRESH_REINSTALL";

const thisFile = fileURLToPath(import.meta.url);
export const DEFAULT_FILES_ROOT = resolve(dirname(thisFile), "..");
export const DEFAULT_WORKSPACE_ROOT = resolve(DEFAULT_FILES_ROOT, "../..");

const FILES_SOURCE_ROOT_FILES = [
  ".gitignore",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "build.ts",
  "mops.toml",
  "neutron.json",
  "neutron.lock.json",
  "package.json",
  "tsconfig.app.json",
  "tsconfig.json",
  "tsconfig.scripts.json",
] as const;

const FILES_SOURCE_DIRECTORIES = [
  "backend",
  "candid",
  "public",
  "scripts",
  "src",
  "test",
  "types",
] as const;

const REQUIRED_DIST_PATHS = new Set([
  "THIRD_PARTY_NOTICES.md",
  "neutron.json",
  "neutron.lock.json",
  "schema.json",
  "web/index.html",
  "web/main.css",
  "web/main.js",
  "web/service.html",
  "web/service.js",
  "web/static/icon.svg",
]);

export type TreeDigest = {
  algorithm: "sha256-length-prefixed-tree-v1";
  sha256: string;
  files: number;
  bytes: number;
};

type MemoryLockBinding = {
  path: "neutron.lock.json";
  sha256: string;
  bytes: number;
  schemas: {
    "1": {
      hash: string;
      entry: string;
    };
    "2": {
      hash: string;
      entry: string;
    };
  };
  migrations: {
    "1->2": string;
  };
};

export type FilesReleaseEvidence = {
  schema: typeof RELEASE_EVIDENCE_SCHEMA;
  package: {
    id: "files";
    version: number;
    archive: string;
  };
  memory_lineage: {
    install_mode: "managed_upgrade_or_fresh_install";
    imports_previous_files_memory: true;
    memory_id: "files";
    memory_version: 2;
    migration_path: ["1->2"];
  };
  source_binding: {
    files: TreeDigest;
    workspace_package_json: FileDigest;
    workspace_package_lock: FileDigest;
  };
  managed_memory: MemoryLockBinding;
  bundle_contract: {
    inline_worker_sha256: string;
    default_resident_port_methods: number;
    polling: false;
  };
  package_payload_without_evidence: TreeDigest;
};

export type FilesPackageVerification = {
  schema: typeof PACKAGE_VERIFICATION_SCHEMA;
  archive: {
    path: string;
    sha256: string;
    bytes: number;
  };
  evidence_sha256: string;
  files_source_sha256: string;
  memory_lock_sha256: string;
};

type FileDigest = {
  sha256: string;
  bytes: number;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return digest;
}

function requireNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value as number;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileDigest(bytes: Uint8Array): FileDigest {
  return { sha256: sha256(bytes), bytes: bytes.byteLength };
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedPath(path: string): string {
  return path.split(sep).join("/");
}

function u32be(value: number): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value);
  return result;
}

function u64be(value: number): Buffer {
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(BigInt(value));
  return result;
}

async function regularFile(path: string, label: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
}

async function collectDirectoryFiles(
  root: string,
  directory: string,
): Promise<string[]> {
  const absolute = join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release source cannot contain symlink ${child}`);
    }
    if (entry.isDirectory()) {
      paths.push(...await collectDirectoryFiles(root, child));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Release source contains unsupported entry ${child}`);
    }
    paths.push(normalizedPath(child));
  }
  return paths;
}

async function sourcePaths(
  root: string,
  rootFiles: readonly string[],
  directories: readonly string[],
): Promise<string[]> {
  const paths = [...rootFiles];
  for (const path of rootFiles) {
    await regularFile(join(root, path), `Release source ${path}`);
  }
  for (const directory of directories) {
    paths.push(...await collectDirectoryFiles(root, directory));
  }
  return [...new Set(paths)].sort();
}

export async function filesReleaseSourcePaths(
  filesRoot = DEFAULT_FILES_ROOT,
): Promise<string[]> {
  return sourcePaths(
    filesRoot,
    FILES_SOURCE_ROOT_FILES,
    FILES_SOURCE_DIRECTORIES,
  );
}

export async function digestTree(
  root: string,
  paths: readonly string[],
): Promise<TreeDigest> {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of [...paths].sort()) {
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`Tree digest path must stay relative: ${path}`);
    }
    const absolute = join(root, path);
    await regularFile(absolute, `Tree digest input ${path}`);
    const content = await readFile(absolute);
    const encodedPath = Buffer.from(normalizedPath(path), "utf8");
    const contentHash = Buffer.from(sha256(content), "hex");
    hash.update(u32be(encodedPath.byteLength));
    hash.update(encodedPath);
    hash.update(u64be(content.byteLength));
    hash.update(contentHash);
    bytes += content.byteLength;
  }
  return {
    algorithm: "sha256-length-prefixed-tree-v1",
    sha256: hash.digest("hex"),
    files: paths.length,
    bytes,
  };
}

async function collectDistPaths(distRoot: string): Promise<string[]> {
  return collectDirectoryFiles(dirname(distRoot), normalizedPath(
    relative(dirname(distRoot), distRoot),
  )).then((paths) =>
    paths.map((path) => normalizedPath(relative(
      distRoot,
      join(dirname(distRoot), path),
    )))
  );
}

function allowedDistPath(path: string): boolean {
  return (
    REQUIRED_DIST_PATHS.has(path) ||
    path === RELEASE_EVIDENCE_PATH ||
    /^mo\/[a-f0-9]{64}\.mo$/u.test(path)
  );
}

async function assertDistShape(
  distRoot: string,
  paths: readonly string[],
): Promise<void> {
  for (const required of REQUIRED_DIST_PATHS) {
    if (!paths.includes(required)) {
      throw new Error(`Files package payload is missing ${required}`);
    }
  }
  const packagedNotice = await readFile(
    join(distRoot, "THIRD_PARTY_NOTICES.md"),
  );
  const sourceNotice = await readFile(
    join(dirname(distRoot), "THIRD_PARTY_NOTICES.md"),
  );
  if (!Buffer.from(packagedNotice).equals(sourceNotice)) {
    throw new Error(
      "Files package Unicode third-party notice differs from source",
    );
  }
  for (const path of paths) {
    if (!allowedDistPath(path)) {
      throw new Error(`Files package payload contains unexpected path ${path}`);
    }
    const match = /^mo\/([a-f0-9]{64})\.mo$/u.exec(path);
    if (match) {
      const content = await readFile(join(distRoot, path), "utf8");
      if (hashContent(content) !== match[1]) {
        throw new Error(`Packaged Motoko module hash mismatch for ${path}`);
      }
    }
  }
}

const RESIDENT_PORT_METHODS = Object.freeze([
  "status",
  "initialize",
  "unlock",
  "lock",
  "rotate",
  "list",
  "stat",
  "read",
  "write",
  "writeMany",
  "mkdir",
  "move",
  "remove",
  "cancel",
  "retry",
  "beginUpload",
  "uploadChunk",
  "clearVolatile",
] as const);

const FORBIDDEN_BUNDLE_PATTERNS = Object.freeze([
  {
    label: "Files V1 browser store",
    pattern: /\b(?:vfs_store|neutron-vfs-db|files_v1_store)\b/iu,
  },
  {
    label: "periodic polling",
    // Bundled serializers may carry "setInterval" as inert data while
    // explicitly rejecting it. Match an executable call, plus the two
    // Files-owned polling handle names, rather than string literals.
    pattern: /(?:\bsetInterval\s*\(|\b(?:pollInterval|pollTimer)\b)/iu,
  },
] as const);

async function assertCleanBundleContract(filesRoot: string): Promise<{
  inlineWorkerSha256: string;
}> {
  const [mainJs, serviceJs, worker] = await Promise.all([
    readFile(join(filesRoot, "dist", "web", "main.js"), "utf8"),
    readFile(join(filesRoot, "dist", "web", "service.js"), "utf8"),
    buildFilesInlineWorkerBundle(filesRoot),
  ]);
  if (!serviceJs.includes(worker.marker)) {
    throw new Error(
      "Files service bundle does not inline the exact current crypto worker",
    );
  }
  if (
    !serviceJs.includes("neutron-files-crypto") ||
    !serviceJs.includes("initialize_vault") ||
    !serviceJs.includes("neutron.files.vault.v2")
  ) {
    throw new Error("Files service bundle is missing the runnable crypto worker");
  }
  const combined = `${mainJs}\n${serviceJs}`;
  for (const forbidden of FORBIDDEN_BUNDLE_PATTERNS) {
    if (forbidden.pattern.test(combined)) {
      throw new Error(
        `Files clean bundle contains forbidden ${forbidden.label} code`,
      );
    }
  }

  const vaultModuleUrl = pathToFileURL(
    join(filesRoot, "src", "vault", "index.ts"),
  );
  vaultModuleUrl.searchParams.set(
    "files-release-smoke",
    worker.sha256.slice(0, 16),
  );
  const vaultModule = await import(vaultModuleUrl.href) as Record<
    string,
    unknown
  >;
  const factory = vaultModule.createDefaultFilesResidentPort;
  if (typeof factory !== "function") {
    throw new Error(
      "Files vault does not export concrete createDefaultFilesResidentPort",
    );
  }
  const port = await factory();
  if (!isObject(port)) {
    throw new Error("Files default resident port factory returned no port");
  }
  for (const method of RESIDENT_PORT_METHODS) {
    if (typeof port[method] !== "function") {
      throw new Error(
        `Files default resident port is missing runnable method ${method}`,
      );
    }
  }
  (port.clearVolatile as () => void)();
  return {
    inlineWorkerSha256: worker.sha256,
  };
}

async function readCanonicalJson(
  path: string,
  label: string,
): Promise<{ bytes: Uint8Array; value: JsonObject }> {
  const bytes = await readFile(path);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = requireObject(JSON.parse(text) as unknown, label);
  if (text !== canonicalJson(value)) {
    throw new Error(`${label} must use canonical generated JSON bytes`);
  }
  return { bytes, value };
}

function requireOnlyKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(
      `${label} keys must be exactly ${wanted.join(", ") || "(empty)"}`,
    );
  }
}

export async function validateHardCutState(filesRoot: string): Promise<{
  manifest: JsonObject;
  version: number;
  lock: MemoryLockBinding;
}> {
  const sourceManifest = requireObject(
    JSON.parse(await readFile(join(filesRoot, "neutron.json"), "utf8")) as unknown,
    "Files source manifest",
  );
  if (sourceManifest.id !== "files") {
    throw new Error("Files release requires manifest id files");
  }
  const version = requireNumber(sourceManifest.version, "Files manifest version");
  if (version < 200) {
    throw new Error(
      "Files three-root release requires manifest version 200 or newer",
    );
  }
  const sourceMemory = requireObject(
    sourceManifest.memory,
    "Files source manifest memory",
  );
  requireOnlyKeys(sourceMemory, ["files"], "Files source memory roots");
  const sourceFilesMemory = requireObject(
    sourceMemory.files,
    "Files source memory files",
  );
  if (sourceFilesMemory.version !== 2) {
    throw new Error("Files three-root memory version must be 2");
  }
  const sourceSchemas = requireObject(
    sourceFilesMemory.schemas,
    "Files source memory schemas",
  );
  requireOnlyKeys(sourceSchemas, ["1", "2"], "Files source memory schemas");
  for (const [schemaVersion, schemaPath] of [
    ["1", "memory/files/v1.mo"],
    ["2", "memory/files/v2.mo"],
  ] as const) {
    const schema = requireObject(
      sourceSchemas[schemaVersion],
      `Files source memory schema ${schemaVersion}`,
    );
    requireOnlyKeys(
      schema,
      ["src"],
      `Files source memory schema ${schemaVersion}`,
    );
    if (schema.src !== schemaPath) {
      throw new Error(
        `Files source memory schema ${schemaVersion} must use ${schemaPath}`,
      );
    }
  }
  const sourceMigrations = sourceFilesMemory.migrations;
  if (!Array.isArray(sourceMigrations) || sourceMigrations.length !== 1) {
    throw new Error(
      "Files three-root release must declare exactly one memory migration",
    );
  }
  const sourceMigration = requireObject(
    sourceMigrations[0],
    "Files source memory migration 1->2",
  );
  requireOnlyKeys(
    sourceMigration,
    ["from", "to", "src"],
    "Files source memory migration 1->2",
  );
  if (
    sourceMigration.from !== 1 ||
    sourceMigration.to !== 2 ||
    sourceMigration.src !== "memory/files/v1_to_v2.mo"
  ) {
    throw new Error(
      "Files source memory migration must be exactly 1->2 via memory/files/v1_to_v2.mo",
    );
  }

  const sourceLock = await readCanonicalJson(
    join(filesRoot, "neutron.lock.json"),
    "Files source memory lock",
  );
  const packagedLock = await readCanonicalJson(
    join(filesRoot, "dist", "neutron.lock.json"),
    "Files packaged memory lock",
  );
  if (!Buffer.from(sourceLock.bytes).equals(Buffer.from(packagedLock.bytes))) {
    throw new Error("Files source and packaged memory locks differ");
  }
  if (sourceLock.value.format !== 2 || sourceLock.value.app !== "files") {
    throw new Error("Files memory lock identity must be format 2 for app files");
  }
  const lockMemory = requireObject(
    sourceLock.value.memory,
    "Files memory lock roots",
  );
  requireOnlyKeys(lockMemory, ["files"], "Files memory lock roots");
  const lockFiles = requireObject(lockMemory.files, "Files memory lock files");
  requireOnlyKeys(
    lockFiles,
    ["schemas", "migrations"],
    "Files memory lock files",
  );
  const lockSchemas = requireObject(
    lockFiles.schemas,
    "Files memory lock schemas",
  );
  requireOnlyKeys(lockSchemas, ["1", "2"], "Files memory lock schemas");
  const lockMigrations = requireObject(
    lockFiles.migrations,
    "Files memory lock migrations",
  );
  requireOnlyKeys(
    lockMigrations,
    ["1->2"],
    "Files memory lock migrations",
  );
  const lockedSchemaBindings = {} as MemoryLockBinding["schemas"];
  for (const schemaVersion of ["1", "2"] as const) {
    const lockedSchema = requireObject(
      lockSchemas[schemaVersion],
      `Files memory lock schema ${schemaVersion}`,
    );
    requireOnlyKeys(
      lockedSchema,
      ["hash", "entry"],
      `Files memory lock schema ${schemaVersion}`,
    );
    const hash = requireSha256(
      lockedSchema.hash,
      `Files memory lock schema ${schemaVersion} hash`,
    );
    const entry = requireSha256(
      lockedSchema.entry,
      `Files memory lock schema ${schemaVersion} entry`,
    );
    const schemaSource = removeCommentsAndEmptyLines(
      await readFile(
        join(
          filesRoot,
          "backend",
          "memory",
          "files",
          `v${schemaVersion}.mo`,
        ),
        "utf8",
      ),
    );
    if (hashContent(schemaSource) !== hash) {
      throw new Error(
        `Files memory lock does not bind schema ${schemaVersion} source`,
      );
    }
    lockedSchemaBindings[schemaVersion] = { hash, entry };
  }
  const migrationEntry = requireSha256(
    lockMigrations["1->2"],
    "Files memory lock migration 1->2 entry",
  );

  const packagedManifest = requireObject(
    JSON.parse(
      await readFile(join(filesRoot, "dist", "neutron.json"), "utf8"),
    ) as unknown,
    "Files packaged manifest",
  );
  if (
    packagedManifest.id !== "files" ||
    packagedManifest.version !== version
  ) {
    throw new Error("Files source and packaged manifest identity differ");
  }
  const appEntry = requireString(
    packagedManifest.entry,
    "Files packaged app entry",
  );
  if (!/^[a-f0-9]{64}$/u.test(appEntry)) {
    throw new Error("Files packaged app entry must be a lowercase SHA-256");
  }
  const packagedMemory = requireObject(
    packagedManifest.memory,
    "Files packaged manifest memory",
  );
  requireOnlyKeys(packagedMemory, ["files"], "Files packaged memory roots");
  const packagedFilesMemory = requireObject(
    packagedMemory.files,
    "Files packaged memory files",
  );
  if (packagedFilesMemory.version !== 2) {
    throw new Error("Files packaged memory version must be 2");
  }
  const packagedSchemas = requireObject(
    packagedFilesMemory.schemas,
    "Files packaged memory schemas",
  );
  requireOnlyKeys(
    packagedSchemas,
    ["1", "2"],
    "Files packaged memory schemas",
  );
  for (const schemaVersion of ["1", "2"] as const) {
    const packagedSchema = requireObject(
      packagedSchemas[schemaVersion],
      `Files packaged memory schema ${schemaVersion}`,
    );
    const lockedSchema = lockedSchemaBindings[schemaVersion];
    if (
      packagedSchema.src !== `memory/files/v${schemaVersion}.mo` ||
      packagedSchema.hash !== lockedSchema.hash ||
      packagedSchema.entry !== lockedSchema.entry
    ) {
      throw new Error(
        `Files packaged manifest and memory lock schema ${schemaVersion} differ`,
      );
    }
  }
  const packagedMigrations = packagedFilesMemory.migrations;
  if (!Array.isArray(packagedMigrations) || packagedMigrations.length !== 1) {
    throw new Error(
      "Files packaged manifest must contain exactly one memory migration",
    );
  }
  const packagedMigration = requireObject(
    packagedMigrations[0],
    "Files packaged memory migration 1->2",
  );
  if (
    packagedMigration.from !== 1 ||
    packagedMigration.to !== 2 ||
    packagedMigration.src !== "memory/files/v1_to_v2.mo" ||
    packagedMigration.entry !== migrationEntry
  ) {
    throw new Error(
      "Files packaged manifest and memory lock migration 1->2 differ",
    );
  }
  await Promise.all([
    regularFile(
      join(filesRoot, "dist", "mo", `${appEntry}.mo`),
      "Files packaged app entry module",
    ),
    ...Object.entries(lockedSchemaBindings).map(([schemaVersion, binding]) =>
      regularFile(
        join(filesRoot, "dist", "mo", `${binding.entry}.mo`),
        `Files packaged memory schema ${schemaVersion} module`,
      )
    ),
    regularFile(
      join(filesRoot, "dist", "mo", `${migrationEntry}.mo`),
      "Files packaged memory migration 1->2 module",
    ),
  ]);

  return {
    manifest: sourceManifest,
    version,
    lock: {
      path: "neutron.lock.json",
      ...fileDigest(sourceLock.bytes),
      schemas: lockedSchemaBindings,
      migrations: {
        "1->2": migrationEntry,
      },
    },
  };
}

async function filesSourceDigest(filesRoot: string): Promise<TreeDigest> {
  return digestTree(
    filesRoot,
    await filesReleaseSourcePaths(filesRoot),
  );
}

export async function buildFilesReleaseEvidence(
  filesRoot = DEFAULT_FILES_ROOT,
  workspaceRoot = resolve(filesRoot, "../.."),
): Promise<FilesReleaseEvidence> {
  const distRoot = join(filesRoot, "dist");
  const distPaths = await collectDistPaths(distRoot);
  await assertDistShape(distRoot, distPaths);
  const releaseState = await validateHardCutState(filesRoot);
  const bundleContract = await assertCleanBundleContract(filesRoot);
  const payloadPaths = distPaths.filter(
    (path) => path !== RELEASE_EVIDENCE_PATH,
  );
  const [files, workspacePackageJson, workspacePackageLock] =
    await Promise.all([
      filesSourceDigest(filesRoot),
      readFile(join(workspaceRoot, "package.json")).then(fileDigest),
      readFile(join(workspaceRoot, "package-lock.json")).then(fileDigest),
    ]);

  return {
    schema: RELEASE_EVIDENCE_SCHEMA,
    package: {
      id: "files",
      version: releaseState.version,
      archive: packageArchiveFilename("files", releaseState.version),
    },
    memory_lineage: {
      install_mode: "managed_upgrade_or_fresh_install",
      imports_previous_files_memory: true,
      memory_id: "files",
      memory_version: 2,
      migration_path: ["1->2"],
    },
    source_binding: {
      files,
      workspace_package_json: workspacePackageJson,
      workspace_package_lock: workspacePackageLock,
    },
    managed_memory: releaseState.lock,
    bundle_contract: {
      inline_worker_sha256: bundleContract.inlineWorkerSha256,
      default_resident_port_methods: RESIDENT_PORT_METHODS.length,
      polling: false,
    },
    package_payload_without_evidence: await digestTree(
      distRoot,
      payloadPaths,
    ),
  };
}

export async function writeFilesReleaseEvidence(
  filesRoot = DEFAULT_FILES_ROOT,
  workspaceRoot = resolve(filesRoot, "../.."),
): Promise<FilesReleaseEvidence> {
  const evidence = await buildFilesReleaseEvidence(filesRoot, workspaceRoot);
  await writeFile(
    join(filesRoot, "dist", RELEASE_EVIDENCE_PATH),
    canonicalJson(evidence),
    "utf8",
  );
  return evidence;
}

export async function assertArchiveMatchesDist(
  archiveBytes: Uint8Array,
  distRoot: string,
): Promise<void> {
  const unpacked = unpackNeutronPackage(archiveBytes);
  const archivePaths = Object.keys(unpacked).sort();
  const distPaths = (await collectDistPaths(distRoot)).sort();
  if (archivePaths.join("\0") !== distPaths.join("\0")) {
    throw new Error("Files archive path set differs from the current dist tree");
  }
  for (const path of distPaths) {
    const archived = unpacked[path];
    if (!archived) throw new Error(`Files archive is missing ${path}`);
    const current = await readFile(join(distRoot, path));
    if (!Buffer.from(archived).equals(current)) {
      throw new Error(`Files archive contains stale bytes for ${path}`);
    }
  }
}

function parseReleaseEvidence(value: unknown): FilesReleaseEvidence {
  const object = requireObject(value, "Files release evidence");
  if (object.schema !== RELEASE_EVIDENCE_SCHEMA) {
    throw new Error(`Unsupported Files release evidence schema ${String(object.schema)}`);
  }
  return object as FilesReleaseEvidence;
}

export function assertReleaseEvidenceCurrent(
  actual: unknown,
  expected: unknown,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      "Files release evidence is stale relative to current sources or dist",
    );
  }
}

export async function verifyFilesRelease(
  filesRoot = DEFAULT_FILES_ROOT,
  workspaceRoot = resolve(filesRoot, "../.."),
): Promise<FilesPackageVerification> {
  const evidencePath = join(filesRoot, "dist", RELEASE_EVIDENCE_PATH);
  const evidenceFile = await readCanonicalJson(
    evidencePath,
    "Files release evidence",
  );
  const evidence = parseReleaseEvidence(evidenceFile.value);
  const expected = await buildFilesReleaseEvidence(filesRoot, workspaceRoot);
  assertReleaseEvidenceCurrent(evidence, expected);
  const archivePath = join(filesRoot, evidence.package.archive);
  const archiveBytes = await readFile(archivePath);
  await assertArchiveMatchesDist(archiveBytes, join(filesRoot, "dist"));
  return {
    schema: PACKAGE_VERIFICATION_SCHEMA,
    archive: {
      path: normalizedPath(relative(workspaceRoot, archivePath)),
      ...fileDigest(archiveBytes),
    },
    evidence_sha256: sha256(evidenceFile.bytes),
    files_source_sha256: evidence.source_binding.files.sha256,
    memory_lock_sha256: evidence.managed_memory.sha256,
  };
}

async function cleanDist(filesRoot: string): Promise<void> {
  const distRoot = join(filesRoot, "dist");
  if (resolve(distRoot) !== resolve(filesRoot, "dist")) {
    throw new Error("Refusing to clean an unexpected dist path");
  }
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });
}

export async function assertFreshLockManifest(filesRoot: string): Promise<void> {
  const manifest = requireObject(
    JSON.parse(await readFile(join(filesRoot, "neutron.json"), "utf8")) as unknown,
    "Files source manifest",
  );
  if (manifest.id !== "files" || manifest.version !== 104) {
    throw new Error("Fresh lock reset is restricted to Files V2 manifest 104");
  }
  const memory = requireObject(manifest.memory, "Files source manifest memory");
  requireOnlyKeys(memory, ["files"], "Files source memory roots");
  const files = requireObject(memory.files, "Files source memory files");
  if (files.version !== 1) {
    throw new Error("Fresh lock reset requires Files memory version 1");
  }
  const schemas = requireObject(files.schemas, "Files source memory schemas");
  requireOnlyKeys(schemas, ["1"], "Files source memory schemas");
  if (!Array.isArray(files.migrations) || files.migrations.length !== 0) {
    throw new Error("Fresh lock reset refuses a manifest with migrations");
  }
}

export async function assertFreshLockResetNeeded(
  filesRoot: string,
): Promise<void> {
  const lockPath = join(filesRoot, "neutron.lock.json");
  let parsed: JsonObject;
  try {
    parsed = requireObject(
      JSON.parse(await readFile(lockPath, "utf8")) as unknown,
      "Files pre-cutover memory lock",
    );
  } catch (error) {
    if (
      isObject(error) &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  if (parsed.format !== 2 || parsed.app !== "files") {
    throw new Error(
      "Refusing to reset a memory lock that is not format 2 for Files",
    );
  }
  const memory = requireObject(
    parsed.memory,
    "Files pre-cutover memory lock roots",
  );
  const files = requireObject(
    memory.files,
    "Files pre-cutover memory lock files",
  );
  const schemas = requireObject(
    files.schemas,
    "Files pre-cutover memory lock schemas",
  );
  const schema = requireObject(
    schemas["1"],
    "Files pre-cutover memory lock schema 1",
  );
  const lockedHash = requireString(
    schema.hash,
    "Files pre-cutover memory lock schema hash",
  );
  const currentHash = hashContent(removeCommentsAndEmptyLines(
    await readFile(
      join(filesRoot, "backend", "memory", "files", "v1.mo"),
      "utf8",
    ),
  ));
  if (lockedHash === currentHash) {
    throw new Error(
      "Files memory lock already binds the current V2 schema; use npm run package",
    );
  }
}

async function resetFreshInstallLock(filesRoot: string): Promise<void> {
  if (process.env[HARD_CUT_ENV] !== "1") {
    throw new Error(
      `Refusing to reset neutron.lock.json without ${HARD_CUT_ENV}=1`,
    );
  }
  await assertFreshLockManifest(filesRoot);
  await assertFreshLockResetNeeded(filesRoot);
  const lockPath = join(filesRoot, "neutron.lock.json");
  if (resolve(lockPath) !== resolve(filesRoot, "neutron.lock.json")) {
    throw new Error("Refusing to reset an unexpected lock path");
  }
  await rm(lockPath, { force: true });
  console.log(
    "Removed the Files memory lock for the explicit V2 fresh-reinstall cutover.",
  );
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "clean") {
    await cleanDist(DEFAULT_FILES_ROOT);
    return;
  }
  if (command === "evidence") {
    const evidence = await writeFilesReleaseEvidence();
    console.log(canonicalJson(evidence).trimEnd());
    return;
  }
  if (command === "verify") {
    const receipt = await verifyFilesRelease();
    console.log(canonicalJson(receipt).trimEnd());
    return;
  }
  if (command === "reset-memory-lock") {
    await resetFreshInstallLock(DEFAULT_FILES_ROOT);
    return;
  }
  throw new Error(
    "Usage: bun scripts/release.ts <clean|evidence|verify|reset-memory-lock>",
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
