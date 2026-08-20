import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import msgpack5 from "msgpack5";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { assertNeutronManifest } from "neutron-tools/src/memory.js";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
  NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS,
  NEUTRON_APP_SOURCE_TRANSPORT_LIMITS,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX,
  NEUTRON_PACKAGE_RECORD_LIMITS,
  NEUTRON_PACKAGE_RECORD_PATH,
  neutronAppSourceArchiveFilename,
  neutronAppSourceHttpsUrl,
  parseNeutronPackageRecord,
  type NeutronPackageEmbeddedFileV1,
  type NeutronPackageRecordV1,
} from "neutron-tools/package_record.js";
import {
  assertSafeRelativeAssetPath,
  normalizeManifestPackageFeatures,
  normalizeManifestDependencies,
  normalizeManifestUpdateSource,
  type NeutronManifest,
  type PackagedNeutronManifest,
} from "neutron-tools/src/schema.js";
import { canisterOrigin } from "neutron-tools/src/runtime.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import { assertAppVersion } from "neutron-tools/src/version.js";
import {
  buildThirdPartyNoticeBundle,
  type ThirdPartyNoticeBundle,
} from "./third_party_notices.ts";

const msgpack = msgpack5();
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });
const DETERMINISTIC_GZIP_OPTIONS = Object.freeze({
  level: 9 as const,
  mtime: 0,
});

export const NSAL_LICENSE_ID =
  "LicenseRef-Neutron-Sovereign-Application-License-1.1" as const;
export const LEGACY_NSAL_LICENSE_ID =
  "LicenseRef-Neutron-Sovereign-Application-License-1.0" as const;
export const NSAL_USE_LICENSE_ID =
  "LicenseRef-Neutron-Sovereign-Application-Use-License-1.0" as const;
export const APACHE_2_LICENSE_ID = "Apache-2.0" as const;
export const ORDINARY_APP_LICENSE_PATHS = Object.freeze({
  [NSAL_LICENSE_ID]: "legal/LICENSE.APP.txt",
  [LEGACY_NSAL_LICENSE_ID]: "legal/LICENSE.APP.txt",
  [NSAL_USE_LICENSE_ID]: "legal/LICENSE.APP.USE.txt",
  [APACHE_2_LICENSE_ID]: "legal/LICENSE.Apache-2.0.txt",
} as const);
export const ORDINARY_APP_ARCHIVE_ONLY_LICENSE_PATHS = Object.freeze({
  [NSAL_LICENSE_ID]:
    `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.APP.txt`,
  [LEGACY_NSAL_LICENSE_ID]:
    `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.APP.txt`,
  [NSAL_USE_LICENSE_ID]:
    `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.APP.USE.txt`,
  [APACHE_2_LICENSE_ID]:
    `${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}LICENSE.Apache-2.0.txt`,
} as const);
export const ORDINARY_APP_NOTICE_PATH =
  "legal/APPLICATION-NOTICE.txt" as const;

export const ORDINARY_APP_SOURCE_LIMITS = Object.freeze({
  files: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.files,
  pathBytes: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.pathBytes,
  fileBytes: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.fileBytes,
  totalBytes: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.totalFileBytes,
  snapshotBytes: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.encodedBytes,
  compressedArtifactBytes: NEUTRON_APP_SOURCE_TRANSPORT_LIMITS.compressedBytes,
} as const);

const ROOT_SOURCE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.browser.json",
  "tsconfig.bun.json",
  "tsconfig.json",
  "flake.nix",
  "flake.lock",
]);

const REQUIRED_ROOT_SOURCE_FILES = new Set(["package.json", "package-lock.json"]);
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  ".assetgen",
  ".cache",
  ".dfx",
  ".git",
  ".mops",
  ".neutron",
  "cache",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
  "tmp",
]);
const SENSITIVE_SOURCE_BASENAME =
  /^(?:\.env(?:\..+)?|credentials?(?:\..+)?|secrets?(?:\..+)?|id_ed25519(?:\.pub)?|id_rsa(?:\.pub)?)$/iu;
const SENSITIVE_SOURCE_EXTENSION = /\.(?:key|p12|pfx|pem)$/iu;
const GENERATED_SOURCE_BASENAME =
  /(?:\.neutron|\.source\.v1\.msgpack\.gz|\.tgz|\.tsbuildinfo|\.ndeploy\.session\.json(?:\..+)?)$/u;
const sourceCollectionBytes = new WeakMap<
  Map<string, OrdinaryAppSourceFile>,
  number
>();

export type OrdinaryAppLicenseId =
  | typeof NSAL_LICENSE_ID
  | typeof LEGACY_NSAL_LICENSE_ID
  | typeof NSAL_USE_LICENSE_ID
  | typeof APACHE_2_LICENSE_ID;

export type OrdinaryAppSourceFile = Readonly<{
  /** POSIX path relative to the repository root. */
  path: string;
  content: Uint8Array;
  mode: 0o644 | 0o755;
}>;

export type NeutronPackageSourceSnapshotV1 = Readonly<{
  format: 1;
  package: Readonly<{ id: string; version: number }>;
  files: readonly Readonly<{
    path: string;
    mode: 0o644 | 0o755;
    content: Uint8Array;
  }>[];
}>;

export type OrdinaryAppSourceSnapshotV1 = NeutronPackageSourceSnapshotV1;

export type NeutronPackageSourceArtifact = Readonly<{
  /** Absolute deterministic publisher input path outside dist/. */
  path: string;
  /** Exact gzip bytes bound by the package source offer. */
  content: Uint8Array;
  sha256: string;
  bytes: number;
}>;

export type OrdinaryAppSourceArtifact = NeutronPackageSourceArtifact;

export type GeneratedOrdinaryAppPackageMetadata = Readonly<{
  licenseId: OrdinaryAppLicenseId;
  license: Uint8Array;
  applicationNotice: Uint8Array;
  /** Canonical uncompressed MessagePack, retained for validation and tests. */
  sourceSnapshot: Uint8Array;
  /** Present only when source is delivered through the HTTPS offer. */
  sourceArtifact: OrdinaryAppSourceArtifact | null;
  sourceFiles: readonly OrdinaryAppSourceFile[];
  thirdPartyNotices: ThirdPartyNoticeBundle;
  record: NeutronPackageRecordV1;
  recordBytes: Uint8Array;
}>;

type NoticeBundleBuilder = typeof buildThirdPartyNoticeBundle;

export type GenerateOrdinaryAppPackageMetadataOptions = Readonly<{
  appRoot?: string;
  repositoryRoot?: string;
  /** Alternate generated dist tree used by deterministic custom packers. */
  distRoot?: string;
  /** Alternate source manifest for a second package built from the same source tree. */
  sourceManifestPath?: string;
  /** Alternate concise notice paired with an alternate source manifest. */
  applicationNoticePath?: string;
  /** Test seam only; production packaging uses the audited notice collector. */
  buildNotices?: NoticeBundleBuilder;
}>;

type ParsedPackageJson = Readonly<{
  name: string;
  license: string;
  dependencies: Readonly<Record<string, string>>;
  optionalDependencies: Readonly<Record<string, string>>;
}>;

type LicenseMaterial = Readonly<{
  id: OrdinaryAppLicenseId;
  path: string;
  content: Uint8Array;
  notice: Uint8Array;
}>;

/**
 * Generate an ordinary application's legal/source envelope. This function
 * owns dist/legal completely and retains HTTPS source artifacts below the
 * app-local .neutron/sources directory. It never edits neutron.json, a memory
 * lock, application source, or an already-created .neutron archive.
 */
export async function generateOrdinaryAppPackageMetadata(
  options: GenerateOrdinaryAppPackageMetadataOptions = {},
): Promise<GeneratedOrdinaryAppPackageMetadata> {
  const appRoot = path.resolve(options.appRoot ?? process.cwd());
  const repositoryRoot = path.resolve(
    options.repositoryRoot ?? path.join(appRoot, "../.."),
  );
  const appRelative = repositoryRelativePath(
    repositoryRoot,
    appRoot,
    "application root",
  );
  const distRoot = path.resolve(options.distRoot ?? path.join(appRoot, "dist"));
  const sourceManifestPath = path.resolve(
    options.sourceManifestPath ?? path.join(appRoot, "neutron.json"),
  );
  const applicationNoticePath = path.resolve(
    options.applicationNoticePath ?? path.join(appRoot, "NOTICE"),
  );

  await assertRealDirectory(repositoryRoot, "repository root");
  await assertRealDirectory(appRoot, "application root");
  await assertRealDirectory(distRoot, "application dist root");
  const sourceManifestRelative = repositoryRelativePath(
    repositoryRoot,
    sourceManifestPath,
    "source neutron.json",
  );
  const applicationNoticeRelative = repositoryRelativePath(
    repositoryRoot,
    applicationNoticePath,
    "application NOTICE",
  );

  const packagedManifestBytes = await readRequiredFile(
    path.join(distRoot, "neutron.json"),
    "packaged neutron.json",
  );
  const manifest = parsePackagedManifest(packagedManifestBytes);
  if (manifest.id === "kernel") {
    throw new Error(
      "Ordinary application metadata cannot be generated for the Kernel",
    );
  }

  const sourceManifest = parseJsonObject(
    await readRequiredFile(sourceManifestPath, "source neutron.json"),
    "source neutron.json",
  );
  const sourceValidation = validate_neutron_conf(sourceManifest);
  if (sourceValidation.errors.length > 0) {
    throw new Error(
      `Invalid source neutron.json: ${sourceValidation.errors
        .map((error) => error.stack)
        .join("; ")}`,
    );
  }
  const validatedSourceManifest = sourceManifest as NeutronManifest;
  assertNeutronManifest(validatedSourceManifest, "source");
  if (
    validatedSourceManifest.id !== manifest.id ||
    validatedSourceManifest.version !== manifest.version
  ) {
    throw new Error(
      "Source and packaged neutron.json must declare the same app id and version",
    );
  }
  const updateSource = normalizeManifestUpdateSource(manifest);
  if (normalizeManifestUpdateSource(validatedSourceManifest) !== updateSource) {
    throw new Error(
      "Source and packaged neutron.json must declare the same update_source",
    );
  }
  const packagedFeatures = normalizeManifestPackageFeatures(manifest);
  const usesEmbeddedSource = packagedFeatures.length > 0;
  if (
    usesEmbeddedSource &&
    (packagedFeatures.length !== 1 ||
      packagedFeatures[0] !== NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE)
  ) {
    throw new Error(
      `embedded source packages must declare package_features [${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE}]`,
    );
  }
  if (!usesEmbeddedSource && updateSource === undefined) {
    throw new Error(
      `A package without update_source must declare package_features [${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE}]`,
    );
  }

  const appPackageJsonBytes = await readRequiredFile(
    path.join(appRoot, "package.json"),
    "application package.json",
  );
  const appPackageJson = parsePackageJson(
    appPackageJsonBytes,
    `${appRelative}/package.json`,
  );
  const license = await resolveOrdinaryAppLicense({
    appRoot,
    repositoryRoot,
    packageJson: appPackageJson,
    applicationNoticePath,
    archiveOnly: usesEmbeddedSource,
  });
  const applicationNotice = license.notice;

  const sourceFiles = await collectOrdinaryAppSourceFiles({
    appRoot,
    repositoryRoot,
    manifest,
    applicationNoticeRelative,
    sourceManifestRelative,
  });
  const sourceSnapshot = encodeOrdinaryAppSourceSnapshot({
    format: 1,
    package: { id: manifest.id, version: manifest.version },
    files: sourceFiles,
  });
  if (
    sourceSnapshot.byteLength === 0 ||
    sourceSnapshot.byteLength > ORDINARY_APP_SOURCE_LIMITS.snapshotBytes
  ) {
    throw new Error(
      `Complete App Source snapshot must be 1-${ORDINARY_APP_SOURCE_LIMITS.snapshotBytes} bytes`,
    );
  }
  const sourceArtifact = usesEmbeddedSource
    ? null
    : createOrdinaryAppSourceArtifact(appRoot, sourceSnapshot);

  const buildNotices = options.buildNotices ?? buildThirdPartyNoticeBundle;
  const thirdPartyNotices = await buildNotices({
    appRoot,
    repositoryRoot,
  });
  const noticeFiles = normalizePackageThirdPartyNoticeBundle(
    thirdPartyNotices,
    usesEmbeddedSource,
  );

  const memoryLock = await readMemoryLock(distRoot, manifest);
  const dependencies = Object.entries(normalizeManifestDependencies(manifest))
    .sort(([left], [right]) => compareCanonicalText(left, right))
    .map(([alias, dependency]) => ({
      alias,
      app: dependency.app,
      min_version: dependency.min_version,
      functions: [...dependency.functions],
    }));

  const packageFiles: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  packageFiles["neutron.json"] = packagedManifestBytes;
  if (memoryLock !== null) packageFiles["neutron.lock.json"] = memoryLock;
  packageFiles[license.path] = license.content;
  packageFiles[ORDINARY_APP_NOTICE_PATH] = applicationNotice;
  if (usesEmbeddedSource) {
    packageFiles[NEUTRON_APP_SOURCE_SNAPSHOT_PATH] = sourceSnapshot;
  }
  for (const [noticePath, content] of noticeFiles) {
    if (Object.hasOwn(packageFiles, noticePath)) {
      throw new Error(`Third-party notice path collides with ${noticePath}`);
    }
    packageFiles[noticePath] = content;
  }

  const record = {
    format: 1 as const,
    ...(usesEmbeddedSource
      ? { features: [NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE] as const }
      : {}),
    package: {
      id: manifest.id,
      version: manifest.version,
      manifest: embeddedFile("neutron.json", packagedManifestBytes),
    },
    license: {
      id: license.id,
      texts: [{ id: license.id, ...embeddedFile(license.path, license.content) }],
    },
    source: usesEmbeddedSource
      ? {
          kind: "embedded" as const,
          revision: `source-sha256:${hashContent(sourceSnapshot)}`,
          ...embeddedFile(NEUTRON_APP_SOURCE_SNAPSHOT_PATH, sourceSnapshot),
        }
      : {
          kind: "https" as const,
          revision: `source-sha256:${sourceArtifact!.sha256}`,
          url: neutronAppSourceHttpsUrl(
            canisterOrigin({ canisterId: updateSource! }),
            sourceArtifact!.sha256,
          ),
          sha256: sourceArtifact!.sha256,
          bytes: sourceArtifact!.bytes,
        },
    dependencies,
    notices: [
      embeddedFile(ORDINARY_APP_NOTICE_PATH, applicationNotice),
      ...noticeFiles
        .map(([noticePath, content]) => embeddedFile(noticePath, content))
        .sort((left, right) => compareCanonicalText(left.path, right.path)),
    ],
    memory:
      memoryLock === null
        ? null
        : { lock: embeddedFile("neutron.lock.json", memoryLock) },
    build: {
      inputs: importantBuildInputs(sourceFiles, appRelative, {
        applicationNoticeRelative,
        sourceManifestRelative,
      }),
      commands: [
        {
          purpose: "package",
          cwd: ".",
          argv: [
            "npm",
            "--workspace",
            appPackageJson.name,
            "run",
            "package",
          ],
        },
      ],
    },
  } satisfies NeutronPackageRecordV1;
  const recordBytes = jsonBytes(record);
  packageFiles[NEUTRON_PACKAGE_RECORD_PATH] = recordBytes;
  const verifiedRecord = parseNeutronPackageRecord(recordBytes, {
    files: packageFiles,
    manifest,
  });

  if (sourceArtifact !== null) {
    await retainOrdinaryAppSourceArtifact(sourceArtifact);
  }
  await replacePackageDistLegalDirectory(distRoot, packageFiles);

  return Object.freeze({
    licenseId: license.id,
    license: license.content,
    applicationNotice,
    sourceSnapshot,
    sourceArtifact,
    sourceFiles,
    thirdPartyNotices,
    record: verifiedRecord,
    recordBytes,
  });
}

/** Encode the closed, canonically ordered retainable source snapshot. */
export function encodeOrdinaryAppSourceSnapshot(
  value: OrdinaryAppSourceSnapshotV1,
): Uint8Array {
  if (value.format !== 1) throw new Error("App source snapshot format must be 1");
  if (value.package.id === "kernel") {
    throw new Error("App source snapshots cannot describe the Kernel");
  }
  return encodeNeutronPackageSourceSnapshot(value);
}

/** Encode the shared closed source-snapshot shape for any package identity. */
export function encodeNeutronPackageSourceSnapshot(
  value: NeutronPackageSourceSnapshotV1,
): Uint8Array {
  if (value.format !== 1) {
    throw new Error("Package source snapshot format must be 1");
  }
  assertAppVersion(value.package.version, "source snapshot package version");
  const files = normalizeSourceFiles(value.files);
  const encoded = msgpack.encode({
    format: 1,
    package: { id: value.package.id, version: value.package.version },
    files: files.map((file) => ({
      path: file.path,
      mode: file.mode,
      content: file.content,
    })),
  }) as unknown as Uint8Array;
  return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

/** Bounded gzip transport encoding used by provider-hosted source offers. */
export function gzipOrdinaryAppSourceSnapshot(
  sourceSnapshot: Uint8Array,
): Uint8Array {
  return gzipNeutronPackageSourceSnapshot(sourceSnapshot);
}

/** Bounded deterministic transport shared by app and Kernel source offers. */
export function gzipNeutronPackageSourceSnapshot(
  sourceSnapshot: Uint8Array,
): Uint8Array {
  if (
    !(sourceSnapshot instanceof Uint8Array) ||
    sourceSnapshot.byteLength < 1 ||
    sourceSnapshot.byteLength > ORDINARY_APP_SOURCE_LIMITS.snapshotBytes
  ) {
    throw new Error(
      `Complete App Source snapshot must be 1-${ORDINARY_APP_SOURCE_LIMITS.snapshotBytes} bytes`,
    );
  }
  const compressed = gzipSync(sourceSnapshot, DETERMINISTIC_GZIP_OPTIONS);
  const artifact = new Uint8Array(
    compressed.buffer,
    compressed.byteOffset,
    compressed.byteLength,
  ).slice();
  if (
    artifact.byteLength < 1 ||
    artifact.byteLength > ORDINARY_APP_SOURCE_LIMITS.compressedArtifactBytes
  ) {
    throw new Error(
      `Compressed Complete App Source must be 1-${ORDINARY_APP_SOURCE_LIMITS.compressedArtifactBytes} bytes`,
    );
  }
  return artifact;
}

/** Exact local path consumed by the update-source publisher. */
export function ordinaryAppSourceArtifactPath(
  appRoot: string,
  sha256: string,
): string {
  return neutronPackageSourceArtifactPath(appRoot, sha256);
}

export function neutronPackageSourceArtifactPath(
  packageRoot: string,
  sha256: string,
): string {
  return path.join(
    path.resolve(packageRoot),
    ".neutron",
    "sources",
    neutronAppSourceArchiveFilename(sha256),
  );
}

export function createNeutronPackageSourceArtifact(
  packageRoot: string,
  sourceSnapshot: Uint8Array,
): NeutronPackageSourceArtifact {
  const content = gzipNeutronPackageSourceSnapshot(sourceSnapshot);
  const sha256 = hashContent(content);
  return Object.freeze({
    path: neutronPackageSourceArtifactPath(packageRoot, sha256),
    content,
    sha256,
    bytes: content.byteLength,
  });
}

function createOrdinaryAppSourceArtifact(
  appRoot: string,
  sourceSnapshot: Uint8Array,
): OrdinaryAppSourceArtifact {
  return createNeutronPackageSourceArtifact(appRoot, sourceSnapshot);
}

export async function retainNeutronPackageSourceArtifact(
  artifact: NeutronPackageSourceArtifact,
): Promise<void> {
  const sourcesRoot = path.dirname(artifact.path);
  const metadataRoot = path.dirname(sourcesRoot);
  await ensureRealDirectory(metadataRoot, "application .neutron directory", 0o700);
  await ensureRealDirectory(sourcesRoot, "application source-artifact directory", 0o755);

  const existing = await readOptionalFile(artifact.path);
  if (existing !== null) {
    if (!equalBytes(existing, artifact.content)) {
      throw new Error(
        `Digest-addressed source artifact has different bytes: ${artifact.path}`,
      );
    }
    return;
  }

  const stageRoot = await fs.mkdtemp(path.join(sourcesRoot, ".stage-"));
  const stagePath = path.join(stageRoot, path.basename(artifact.path));
  try {
    await fs.writeFile(stagePath, artifact.content, { flag: "wx", mode: 0o644 });
    try {
      await fs.link(stagePath, artifact.path);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const raced = await readRequiredFile(
        artifact.path,
        "concurrently retained source artifact",
      );
      if (!equalBytes(raced, artifact.content)) {
        throw new Error(
          `Digest-addressed source artifact has different bytes: ${artifact.path}`,
        );
      }
    }
  } finally {
    await fs.rm(stageRoot, { recursive: true, force: true });
  }
}

async function retainOrdinaryAppSourceArtifact(
  artifact: OrdinaryAppSourceArtifact,
): Promise<void> {
  await retainNeutronPackageSourceArtifact(artifact);
}

export async function collectOrdinaryAppSourceFiles({
  appRoot,
  repositoryRoot,
  manifest,
  applicationNoticeRelative,
  sourceManifestRelative,
}: Readonly<{
  appRoot: string;
  repositoryRoot: string;
  manifest: PackagedNeutronManifest;
  applicationNoticeRelative: string;
  sourceManifestRelative: string;
}>): Promise<readonly OrdinaryAppSourceFile[]> {
  const files = new Map<string, OrdinaryAppSourceFile>();
  for (const rootFile of ROOT_SOURCE_FILES) {
    const absolutePath = path.join(repositoryRoot, rootFile);
    const source = await readOptionalSourceFile(absolutePath, rootFile);
    if (source) {
      addSourceFile(files, source);
    } else if (REQUIRED_ROOT_SOURCE_FILES.has(rootFile)) {
      throw new Error(`Complete App Source is missing repository ${rootFile}`);
    }
  }
  const workspaceRoots = await resolveLocalSourceClosure(
    repositoryRoot,
    appRoot,
  );
  for (const workspaceRoot of workspaceRoots) {
    const relativeRoot = repositoryRelativePath(
      repositoryRoot,
      workspaceRoot,
      "workspace source root",
    );
    await collectSourceTree(files, workspaceRoot, relativeRoot);
  }

  const normalized = normalizeSourceFiles([...files.values()]);
  if (
    !normalized.some(
      ({ path: sourcePath, content }) =>
        sourcePath === sourceManifestRelative &&
        content.byteLength > 0,
    )
  ) {
    throw new Error("Complete App Source is missing the application manifest");
  }
  if (!normalized.some(({ path: sourcePath }) =>
    sourcePath === applicationNoticeRelative
  )) {
    throw new Error("Complete App Source is missing the application NOTICE");
  }
  if (!normalized.some(({ path: sourcePath }) => sourcePath === "package-lock.json")) {
    throw new Error("Complete App Source is missing package-lock.json");
  }
  if (manifest.id.length === 0) {
    throw new Error("Complete App Source has an invalid application identity");
  }
  return normalized;
}

async function resolveLocalSourceClosure(
  repositoryRoot: string,
  appRoot: string,
): Promise<readonly string[]> {
  const rootPackage = parseJsonObject(
    await readRequiredFile(path.join(repositoryRoot, "package.json"), "root package.json"),
    "root package.json",
  );
  const workspacePatterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : isRecord(rootPackage.workspaces) && Array.isArray(rootPackage.workspaces.packages)
      ? rootPackage.workspaces.packages
      : [];
  if (workspacePatterns.length === 0) {
    throw new Error("Root package.json must declare npm workspaces");
  }

  const byName = new Map<string, { root: string; packageJson: ParsedPackageJson }>();
  for (const pattern of workspacePatterns) {
    if (typeof pattern !== "string") {
      throw new Error("Root package.json workspace patterns must be strings");
    }
    for (const workspaceRoot of await expandWorkspacePattern(repositoryRoot, pattern)) {
      const packagePath = path.join(workspaceRoot, "package.json");
      const bytes = await readOptionalFile(packagePath);
      if (bytes === null) continue;
      const packageJson = parsePackageJson(
        bytes,
        `${repositoryRelativePath(repositoryRoot, workspaceRoot, "workspace")}/package.json`,
      );
      if (byName.has(packageJson.name)) {
        throw new Error(`Duplicate workspace package name ${packageJson.name}`);
      }
      byName.set(packageJson.name, { root: workspaceRoot, packageJson });
    }
  }

  const appPackage = [...byName.values()].find(
    ({ root }) => path.resolve(root) === path.resolve(appRoot),
  );
  if (!appPackage) {
    throw new Error("Application root is not a declared npm workspace");
  }
  const included = new Map<string, string>();
  const pending = [appPackage.root];
  while (pending.length > 0) {
    const currentRoot = path.resolve(pending.shift()!);
    const currentRelative = repositoryRelativePath(
      repositoryRoot,
      currentRoot,
      "local source root",
    );
    if (included.has(currentRelative)) continue;
    await assertRealDirectory(currentRoot, `local source root ${currentRelative}`);
    included.set(currentRelative, currentRoot);

    const currentPackageBytes = await readOptionalFile(
      path.join(currentRoot, "package.json"),
    );
    if (currentPackageBytes !== null) {
      const currentPackage = parsePackageJson(
        currentPackageBytes,
        `${currentRelative}/package.json`,
      );
      for (const dependencyName of localRuntimeDependencyNames(currentPackage)) {
        const dependency = byName.get(dependencyName);
        if (dependency) pending.push(dependency.root);
      }
    }

    for (const localMopsRoot of await localMopsDependencyRoots({
      repositoryRoot,
      sourceRoot: currentRoot,
      sourceRootRelative: currentRelative,
    })) {
      pending.push(localMopsRoot);
    }
  }
  return Object.freeze(
    [...included.values()].sort((left, right) =>
      compareCanonicalText(
        repositoryRelativePath(repositoryRoot, left, "workspace"),
        repositoryRelativePath(repositoryRoot, right, "workspace"),
      ),
    ),
  );
}

function localRuntimeDependencyNames(packageJson: ParsedPackageJson): string[] {
  return [
    ...Object.keys(packageJson.dependencies),
    ...Object.keys(packageJson.optionalDependencies),
  ].sort(compareCanonicalText);
}

async function localMopsDependencyRoots({
  repositoryRoot,
  sourceRoot,
  sourceRootRelative,
}: Readonly<{
  repositoryRoot: string;
  sourceRoot: string;
  sourceRootRelative: string;
}>): Promise<readonly string[]> {
  const mopsBytes = await readOptionalFile(path.join(sourceRoot, "mops.toml"));
  if (mopsBytes === null) return Object.freeze([]);
  let mopsText: string;
  try {
    mopsText = fatalTextDecoder.decode(mopsBytes);
  } catch (error) {
    throw new Error(`${sourceRootRelative}/mops.toml is not valid UTF-8`, {
      cause: error,
    });
  }

  const roots = new Set<string>();
  let inDependencies = false;
  for (const line of mopsText.split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (section) {
      inDependencies = section[1] === "dependencies";
      continue;
    }
    if (!inDependencies || /^\s*(?:#|$)/u.test(line)) continue;
    const assignment =
      /^\s*(?:"[^"]+"|[A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"\s*(?:#.*)?$/u.exec(
        line,
      );
    if (!assignment) continue;
    const dependencyPath = assignment[1]!;
    if (!dependencyPath.startsWith(".")) continue;
    const absolute = path.resolve(sourceRoot, dependencyPath);
    repositoryRelativePath(
      repositoryRoot,
      absolute,
      `${sourceRootRelative}/mops.toml local dependency`,
    );
    roots.add(absolute);
  }
  return Object.freeze(
    [...roots].sort((left, right) =>
      compareCanonicalText(
        repositoryRelativePath(repositoryRoot, left, "Mops dependency"),
        repositoryRelativePath(repositoryRoot, right, "Mops dependency"),
      ),
    ),
  );
}

async function expandWorkspacePattern(
  repositoryRoot: string,
  pattern: string,
): Promise<readonly string[]> {
  const normalized = pattern.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized.split("/").some((segment) => segment === "" || segment === ".")
  ) {
    throw new Error(`Unsafe workspace pattern ${pattern}`);
  }
  const wildcard = normalized.indexOf("*");
  if (wildcard === -1) {
    return [path.join(repositoryRoot, ...normalized.split("/"))];
  }
  if (
    !normalized.endsWith("/*") ||
    wildcard !== normalized.length - 1 ||
    normalized.slice(0, -2).includes("*")
  ) {
    throw new Error(`Unsupported workspace pattern ${pattern}`);
  }
  const parent = path.join(repositoryRoot, ...normalized.slice(0, -2).split("/"));
  const entries = (await fs.readdir(parent, { withFileTypes: true })).sort(
    (left, right) => compareCanonicalText(left.name, right.name),
  );
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(parent, entry.name));
}

async function collectSourceTree(
  files: Map<string, OrdinaryAppSourceFile>,
  sourceRoot: string,
  relativeRoot: string,
): Promise<void> {
  await assertRealDirectory(sourceRoot, `source root ${relativeRoot}`);
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort(
      (left, right) => compareCanonicalText(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Complete App Source rejects symbolic link ${relativePath}`);
      }
      if (stats.isDirectory()) {
        if (EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) continue;
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Complete App Source rejects non-file ${relativePath}`);
      }
      if (isExcludedSourceFile(relativePath)) continue;
      addSourceFile(
        files,
        await readSourceFile(absolutePath, relativePath, stats.mode, stats.size),
      );
    }
  };
  await visit(sourceRoot, relativeRoot);
}

function isExcludedSourceFile(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return (
    basename === ".DS_Store" ||
    basename === "meta.json" ||
    SENSITIVE_SOURCE_BASENAME.test(basename) ||
    SENSITIVE_SOURCE_EXTENSION.test(basename) ||
    GENERATED_SOURCE_BASENAME.test(basename)
  );
}

async function readOptionalSourceFile(
  absolutePath: string,
  relativePath: string,
): Promise<OrdinaryAppSourceFile | null> {
  let stats;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Complete App Source input is not a real file: ${relativePath}`);
  }
  return readSourceFile(absolutePath, relativePath, stats.mode, stats.size);
}

async function readSourceFile(
  absolutePath: string,
  relativePath: string,
  rawMode: number,
  expectedSize: number,
): Promise<OrdinaryAppSourceFile> {
  assertSafeSourcePath(relativePath);
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0 ||
    expectedSize > ORDINARY_APP_SOURCE_LIMITS.fileBytes
  ) {
    throw new Error(
      `Complete App Source file ${relativePath} exceeds ${ORDINARY_APP_SOURCE_LIMITS.fileBytes} bytes`,
    );
  }
  const handle = await fs.open(
    absolutePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== expectedSize) {
      throw new Error(`Complete App Source file changed while read: ${relativePath}`);
    }
    const content = new Uint8Array(await handle.readFile());
    if (content.byteLength !== expectedSize) {
      throw new Error(`Complete App Source file changed while read: ${relativePath}`);
    }
    return Object.freeze({
      path: relativePath,
      content,
      mode: rawMode & 0o111 ? 0o755 : 0o644,
    });
  } finally {
    await handle.close();
  }
}

function normalizeSourceFiles(
  input: readonly OrdinaryAppSourceFile[],
): readonly OrdinaryAppSourceFile[] {
  if (input.length < 1 || input.length > ORDINARY_APP_SOURCE_LIMITS.files) {
    throw new Error(
      `Complete App Source must contain 1-${ORDINARY_APP_SOURCE_LIMITS.files} files`,
    );
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = input.map((file) => {
    assertSafeSourcePath(file.path);
    if (seen.has(file.path)) {
      throw new Error(`Complete App Source repeats path ${file.path}`);
    }
    seen.add(file.path);
    if (!(file.content instanceof Uint8Array)) {
      throw new Error(`Complete App Source file ${file.path} is not bytes`);
    }
    if (file.content.byteLength > ORDINARY_APP_SOURCE_LIMITS.fileBytes) {
      throw new Error(
        `Complete App Source file ${file.path} exceeds ${ORDINARY_APP_SOURCE_LIMITS.fileBytes} bytes`,
      );
    }
    totalBytes += file.content.byteLength;
    if (
      !Number.isSafeInteger(totalBytes) ||
      totalBytes > ORDINARY_APP_SOURCE_LIMITS.totalBytes
    ) {
      throw new Error(
        `Complete App Source exceeds ${ORDINARY_APP_SOURCE_LIMITS.totalBytes} bytes`,
      );
    }
    if (file.mode !== 0o644 && file.mode !== 0o755) {
      throw new Error(`Complete App Source file ${file.path} has invalid mode`);
    }
    return Object.freeze({
      path: file.path,
      content: file.content,
      mode: file.mode,
    });
  });
  files.sort((left, right) => compareCanonicalText(left.path, right.path));
  return Object.freeze(files);
}

function addSourceFile(
  files: Map<string, OrdinaryAppSourceFile>,
  file: OrdinaryAppSourceFile,
): void {
  const existing = files.get(file.path);
  if (existing) {
    throw new Error(`Complete App Source repeats path ${file.path}`);
  }
  if (files.size >= ORDINARY_APP_SOURCE_LIMITS.files) {
    throw new Error(
      `Complete App Source exceeds ${ORDINARY_APP_SOURCE_LIMITS.files} files`,
    );
  }
  const nextBytes =
    (sourceCollectionBytes.get(files) ?? 0) + file.content.byteLength;
  if (
    !Number.isSafeInteger(nextBytes) ||
    nextBytes > ORDINARY_APP_SOURCE_LIMITS.totalBytes
  ) {
    throw new Error(
      `Complete App Source exceeds ${ORDINARY_APP_SOURCE_LIMITS.totalBytes} bytes`,
    );
  }
  files.set(file.path, file);
  sourceCollectionBytes.set(files, nextBytes);
}

async function resolveOrdinaryAppLicense({
  appRoot,
  repositoryRoot,
  packageJson,
  applicationNoticePath,
  archiveOnly,
}: Readonly<{
  appRoot: string;
  repositoryRoot: string;
  packageJson: ParsedPackageJson;
  applicationNoticePath: string;
  archiveOnly: boolean;
}>): Promise<LicenseMaterial> {
  const appLicense = await readOptionalFile(path.join(appRoot, "LICENSE"));
  const appNotice = await readRequiredFile(
    applicationNoticePath,
    "application NOTICE",
  );
  if (appNotice.byteLength > NEUTRON_PACKAGE_RECORD_LIMITS.noticeBytes) {
    throw new Error(
      `Application NOTICE exceeds ${NEUTRON_PACKAGE_RECORD_LIMITS.noticeBytes} bytes`,
    );
  }
  const nsal = await readRequiredFile(
    path.join(repositoryRoot, "LICENSE.APP"),
    "repository LICENSE.APP",
  );
  const legacyNsal = await readRequiredFile(
    path.join(repositoryRoot, "LICENSE.APP.1.0"),
    "repository LICENSE.APP.1.0",
  );
  const nsalUse = await readRequiredFile(
    path.join(repositoryRoot, "LICENSE.APP.USE"),
    "repository LICENSE.APP.USE",
  );
  const apache = await readRequiredFile(
    path.join(repositoryRoot, "packages/neutron-design-system/LICENSE"),
    "canonical Apache-2.0 license",
  );
  assertCanonicalNsal(nsal);
  assertCanonicalLegacyNsal(legacyNsal);
  assertCanonicalNsalUse(nsalUse);
  assertCanonicalApache(apache);

  if (packageJson.license === NSAL_LICENSE_ID) {
    if (appLicense !== null) {
      throw new Error(
        "NSAL applications must use the single repository LICENSE.APP and must not carry a duplicate application LICENSE",
      );
    }
    assertNsalApplicationNotice(appNotice);
    return Object.freeze({
      id: NSAL_LICENSE_ID,
      path: (archiveOnly
        ? ORDINARY_APP_ARCHIVE_ONLY_LICENSE_PATHS
        : ORDINARY_APP_LICENSE_PATHS)[NSAL_LICENSE_ID],
      content: nsal,
      notice: appNotice,
    });
  }
  if (packageJson.license === LEGACY_NSAL_LICENSE_ID) {
    if (appLicense !== null) {
      throw new Error(
        "legacy NSAL applications must use the repository LICENSE.APP.1.0 and must not carry a duplicate application LICENSE",
      );
    }
    assertLegacyNsalApplicationNotice(appNotice);
    return Object.freeze({
      id: LEGACY_NSAL_LICENSE_ID,
      path: (archiveOnly
        ? ORDINARY_APP_ARCHIVE_ONLY_LICENSE_PATHS
        : ORDINARY_APP_LICENSE_PATHS)[LEGACY_NSAL_LICENSE_ID],
      content: legacyNsal,
      notice: appNotice,
    });
  }
  if (packageJson.license === NSAL_USE_LICENSE_ID) {
    if (appLicense !== null) {
      throw new Error(
        "use-only applications must use the single repository LICENSE.APP.USE and must not carry a duplicate application LICENSE",
      );
    }
    assertNsalUseApplicationNotice(appNotice);
    return Object.freeze({
      id: NSAL_USE_LICENSE_ID,
      path: (archiveOnly
        ? ORDINARY_APP_ARCHIVE_ONLY_LICENSE_PATHS
        : ORDINARY_APP_LICENSE_PATHS)[NSAL_USE_LICENSE_ID],
      content: nsalUse,
      notice: appNotice,
    });
  }
  if (packageJson.license === APACHE_2_LICENSE_ID) {
    if (appLicense === null || !equalBytes(appLicense, apache)) {
      throw new Error(
        "Apache-2.0 applications must carry an application LICENSE exactly matching the canonical Apache-2.0 text",
      );
    }
    assertApacheApplicationNotice(appNotice);
    return Object.freeze({
      id: APACHE_2_LICENSE_ID,
      path: (archiveOnly
        ? ORDINARY_APP_ARCHIVE_ONLY_LICENSE_PATHS
        : ORDINARY_APP_LICENSE_PATHS)[APACHE_2_LICENSE_ID],
      content: apache,
      notice: appNotice,
    });
  }
  throw new Error(
    `Ordinary application package.json license must be exactly ${NSAL_LICENSE_ID}, ${LEGACY_NSAL_LICENSE_ID}, ${NSAL_USE_LICENSE_ID}, or ${APACHE_2_LICENSE_ID}`,
  );
}

function assertNsalApplicationNotice(content: Uint8Array): void {
  const text = decodeNotice(content, "NSAL application NOTICE");
  assertApplicationCopyrightLine(text, "NSAL application NOTICE");
  assertNoticeMarkers(text, "NSAL application NOTICE", [
    "Licensed under the Neutron Sovereign Application License, Version 1.1.",
    `SPDX-License-Identifier: ${NSAL_LICENSE_ID}`,
    "Production Use by any person is permitted only in a Qualifying Sovereign System.",
    "See LICENSE.APP.",
  ]);
}

function assertLegacyNsalApplicationNotice(content: Uint8Array): void {
  const text = decodeNotice(content, "legacy NSAL application NOTICE");
  assertApplicationCopyrightLine(text, "legacy NSAL application NOTICE");
  assertNoticeMarkers(text, "legacy NSAL application NOTICE", [
    "Licensed under the Neutron Sovereign Application License, Version 1.0.",
    `SPDX-License-Identifier: ${LEGACY_NSAL_LICENSE_ID}`,
    "Provider-operated Production Use is permitted only in a Qualifying Sovereign System.",
    "Private personal use is protected by sections 2 and 3. See LICENSE.APP.",
  ]);
}

function assertNsalUseApplicationNotice(content: Uint8Array): void {
  const text = decodeNotice(content, "use-only application NOTICE");
  assertApplicationCopyrightLine(text, "use-only application NOTICE");
  assertNoticeMarkers(text, "use-only application NOTICE", [
    "Licensed under the Neutron Sovereign Application Use License, Version 1.0.",
    `SPDX-License-Identifier: ${NSAL_USE_LICENSE_ID}`,
    "Production Use by any person is permitted only in a Qualifying Sovereign System.",
    "Source is provided for inspection; modification and redistribution are not licensed.",
    "All rights not expressly granted are reserved. See LICENSE.APP.USE.",
  ]);
}

function assertApacheApplicationNotice(content: Uint8Array): void {
  const text = decodeNotice(content, "Apache application NOTICE");
  assertApplicationCopyrightLine(text, "Apache application NOTICE");
  assertNoticeMarkers(text, "Apache application NOTICE", [
    "Licensed under the Apache License, Version 2.0.",
    "SPDX-License-Identifier: Apache-2.0",
  ]);
}

function assertApplicationCopyrightLine(text: string, label: string): void {
  if (!/^Copyright [0-9]{4}(?:-[0-9]{4})? [^\r\n\[\]]+$/mu.test(text)) {
    throw new Error(
      `${label} must contain a filled Copyright <year> <copyright holder> line`,
    );
  }
}

function assertNoticeMarkers(
  text: string,
  label: string,
  markers: readonly string[],
): void {
  for (const marker of markers) {
    if (!text.includes(marker)) {
      throw new Error(`${label} must contain ${JSON.stringify(marker)}`);
    }
  }
}

function decodeNotice(content: Uint8Array, label: string): string {
  try {
    return fatalTextDecoder.decode(content);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

/** Convert the collector's archive-neutral legal namespace to package paths. */
export function normalizePackageThirdPartyNoticeBundle(
  bundle: ThirdPartyNoticeBundle,
  archiveOnly: boolean,
): readonly (readonly [string, Uint8Array])[] {
  if (!bundle || !Array.isArray(bundle.noticePaths) || bundle.noticePaths.length < 1) {
    throw new Error("Third-party notice generation produced no notice artifact");
  }
  if (!bundle.files || typeof bundle.files !== "object") {
    throw new Error("Third-party notice generation produced no files");
  }
  const paths = [...bundle.noticePaths].sort(compareCanonicalText);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Third-party notice generation repeated a notice path");
  }
  const filePaths = Object.keys(bundle.files).sort(compareCanonicalText);
  if (
    filePaths.length !== paths.length ||
    filePaths.some((noticePath, index) => noticePath !== paths[index])
  ) {
    throw new Error(
      "Third-party notice bundle files must exactly match its notice paths",
    );
  }
  return Object.freeze(
    paths.map((noticePath) => {
      assertLegalPath(noticePath, "third-party notice path");
      if (!noticePath.startsWith(NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX)) {
        throw new Error(
          `Third-party notice ${noticePath} must be retained below ${NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX}`,
        );
      }
      const packagePath = archiveOnly
        ? noticePath
        : `legal/${noticePath.slice(NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX.length)}`;
      assertLegalPath(packagePath, "packaged third-party notice path");
      const content = bundle.files[noticePath];
      if (!(content instanceof Uint8Array) || content.byteLength < 1) {
        throw new Error(`Third-party notice ${noticePath} must be nonempty bytes`);
      }
      if (content.byteLength > NEUTRON_PACKAGE_RECORD_LIMITS.noticeBytes) {
        throw new Error(
          `Third-party notice ${noticePath} exceeds ${NEUTRON_PACKAGE_RECORD_LIMITS.noticeBytes} bytes`,
        );
      }
      return Object.freeze([packagePath, content] as const);
    }),
  );
}

async function readMemoryLock(
  distRoot: string,
  manifest: PackagedNeutronManifest,
): Promise<Uint8Array | null> {
  const hasMemory = Object.keys(manifest.memory ?? {}).length > 0;
  const lock = await readOptionalFile(path.join(distRoot, "neutron.lock.json"));
  if (hasMemory && lock === null) {
    throw new Error("Managed-memory application is missing dist/neutron.lock.json");
  }
  if (!hasMemory && lock !== null) {
    throw new Error("Memoryless application has a stale dist/neutron.lock.json");
  }
  return lock;
}

function importantBuildInputs(
  sourceFiles: readonly OrdinaryAppSourceFile[],
  appRelative: string,
  {
    applicationNoticeRelative,
    sourceManifestRelative,
  }: Readonly<{
    applicationNoticeRelative: string;
    sourceManifestRelative: string;
  }>,
): NeutronPackageRecordV1["build"]["inputs"] {
  const candidates = new Set([
    "package.json",
    "package-lock.json",
    `${appRelative}/LICENSE`,
    applicationNoticeRelative,
    `${appRelative}/build.ts`,
    `${appRelative}/mops.toml`,
    sourceManifestRelative,
    `${appRelative}/neutron.lock.json`,
    `${appRelative}/package.json`,
  ]);
  return Object.freeze(
    sourceFiles
      .filter(({ path: sourcePath }) => candidates.has(sourcePath))
      .map(({ path: sourcePath, content }) => ({
        path: sourcePath,
        sha256: hashContent(content),
        bytes: content.byteLength,
      })),
  );
}

/** Atomically replace the legal tree owned by a package metadata generator. */
export async function replacePackageDistLegalDirectory(
  distRoot: string,
  packageFiles: Readonly<Record<string, Uint8Array>>,
): Promise<void> {
  const legalRoot = path.join(distRoot, "legal");
  const stageRoot = await fs.mkdtemp(path.join(distRoot, ".legal-stage-"));
  let backupContainer: string | null = null;
  let backupRoot: string | null = null;
  let priorMoved = false;
  let promoted = false;
  try {
    const legalFiles = Object.entries(packageFiles)
      .filter(([packagePath]) => packagePath.startsWith("legal/"))
      .sort(([left], [right]) => compareCanonicalText(left, right));
    if (legalFiles.length < 3) {
      throw new Error("Package legal envelope is incomplete");
    }
    for (const [packagePath, content] of legalFiles) {
      assertLegalPath(packagePath, "generated legal path");
      const relativePath = packagePath.slice("legal/".length);
      const target = path.join(stageRoot, ...relativePath.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: "wx", mode: 0o644 });
    }

    const prior = await lstatOptional(legalRoot);
    if (prior !== null) {
      if (prior.isSymbolicLink() || !prior.isDirectory()) {
        throw new Error("Existing dist/legal is not a real directory");
      }
      backupContainer = await fs.mkdtemp(
        path.join(distRoot, ".legal-previous-"),
      );
      backupRoot = path.join(backupContainer, "legal");
      await fs.rename(legalRoot, backupRoot);
      priorMoved = true;
    }

    try {
      await fs.rename(stageRoot, legalRoot);
      promoted = true;
    } catch (promoteError) {
      if (priorMoved && backupRoot !== null) {
        try {
          await fs.rename(backupRoot, legalRoot);
          priorMoved = false;
        } catch (restoreError) {
          throw new AggregateError(
            [promoteError, restoreError],
            `Failed to promote generated legal metadata and restore the prior tree retained at ${backupRoot}`,
          );
        }
      }
      throw promoteError;
    }

    if (backupContainer !== null) {
      await fs.rm(backupContainer, { recursive: true, force: true });
      backupContainer = null;
      backupRoot = null;
      priorMoved = false;
    }
  } finally {
    if (!promoted) await fs.rm(stageRoot, { recursive: true, force: true });
    if (backupContainer !== null && !priorMoved) {
      await fs.rm(backupContainer, { recursive: true, force: true });
    }
  }
}

function parsePackagedManifest(content: Uint8Array): PackagedNeutronManifest {
  const value = parseJsonObject(content, "packaged neutron.json");
  const validation = validate_neutron_conf(value);
  if (validation.errors.length > 0) {
    throw new Error(
      `Invalid packaged neutron.json: ${validation.errors
        .map((error) => error.stack)
        .join("; ")}`,
    );
  }
  const manifest = value as unknown as PackagedNeutronManifest;
  assertNeutronManifest(manifest, "package");
  return manifest;
}

function parsePackageJson(content: Uint8Array, label: string): ParsedPackageJson {
  const value = parseJsonObject(content, label);
  if (typeof value.name !== "string" || value.name.length < 1 || value.name.length > 214) {
    throw new Error(`${label} must contain a bounded name`);
  }
  if (typeof value.license !== "string" || value.license.length < 1) {
    throw new Error(`${label} must contain a license`);
  }
  return Object.freeze({
    name: value.name,
    license: value.license,
    dependencies: parseDependencyMap(value.dependencies, `${label} dependencies`),
    optionalDependencies: parseDependencyMap(
      value.optionalDependencies,
      `${label} optionalDependencies`,
    ),
  });
}

function parseDependencyMap(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const name of Object.keys(value).sort(compareCanonicalText)) {
    const version = value[name];
    if (typeof version !== "string" || version.length < 1) {
      throw new Error(`${label}.${name} must be a version string`);
    }
    result[name] = version;
  }
  return Object.freeze(result);
}

function parseJsonObject(content: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(fatalTextDecoder.decode(content)) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function embeddedFile(
  packagePath: string,
  content: Uint8Array,
): NeutronPackageEmbeddedFileV1 {
  return Object.freeze({
    path: packagePath,
    sha256: hashContent(content),
    bytes: content.byteLength,
  });
}

function jsonBytes(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value)}\n`);
}

function assertCanonicalNsal(content: Uint8Array): void {
  const text = fatalTextDecoder.decode(content);
  if (
    !text.includes("# Neutron Sovereign Application License") ||
    !text.includes(`License reference: ${NSAL_LICENSE_ID}`) ||
    !text.includes("Version 1.1, 20 August 2026") ||
    !text.includes("## 12. Application notice")
  ) {
    throw new Error("Repository LICENSE.APP is not the expected exact NSAL text");
  }
}

function assertCanonicalLegacyNsal(content: Uint8Array): void {
  const text = fatalTextDecoder.decode(content);
  if (
    !text.includes("# Neutron Sovereign Application License") ||
    !text.includes(`License reference: ${LEGACY_NSAL_LICENSE_ID}`) ||
    !text.includes("Version 1.0, 15 August 2026") ||
    !text.includes("## 12. Application notice")
  ) {
    throw new Error(
      "Repository LICENSE.APP.1.0 is not the expected exact legacy NSAL text",
    );
  }
}

function assertCanonicalNsalUse(content: Uint8Array): void {
  const text = fatalTextDecoder.decode(content);
  if (
    !text.includes("# Neutron Sovereign Application Use License") ||
    !text.includes(`License reference: ${NSAL_USE_LICENSE_ID}`) ||
    !text.includes("Version 1.0, 20 August 2026") ||
    !text.includes("## 12. Application notice")
  ) {
    throw new Error(
      "Repository LICENSE.APP.USE is not the expected exact use-only text",
    );
  }
}

function assertCanonicalApache(content: Uint8Array): void {
  const text = fatalTextDecoder.decode(content);
  if (
    !text.includes("                                 Apache License\n") ||
    !text.includes("Version 2.0, January 2004") ||
    !text.includes("http://www.apache.org/licenses/")
  ) {
    throw new Error("Canonical Apache-2.0 license text is invalid");
  }
}

function assertSafeSourcePath(sourcePath: string): void {
  assertSafeRelativeAssetPath(sourcePath, "source snapshot path");
  if (Buffer.byteLength(sourcePath, "utf8") > ORDINARY_APP_SOURCE_LIMITS.pathBytes) {
    throw new Error(
      `Source snapshot path exceeds ${ORDINARY_APP_SOURCE_LIMITS.pathBytes} bytes`,
    );
  }
}

function assertLegalPath(packagePath: string, label: string): void {
  assertSafeRelativeAssetPath(packagePath, label);
  if (!packagePath.startsWith("legal/") || packagePath === "legal/") {
    throw new Error(`${label} must be below legal/`);
  }
}

function repositoryRelativePath(
  repositoryRoot: string,
  target: string,
  label: string,
): string {
  const relative = path.relative(repositoryRoot, target);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must remain inside the repository`);
  }
  const normalized = relative.split(path.sep).join("/");
  assertSafeSourcePath(normalized);
  return normalized;
}

async function assertRealDirectory(target: string, label: string): Promise<void> {
  const stats = await fs.lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function ensureRealDirectory(
  target: string,
  label: string,
  mode: number,
): Promise<void> {
  const prior = await lstatOptional(target);
  if (prior === null) {
    try {
      await fs.mkdir(target, { mode });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
  }
  await assertRealDirectory(target, label);
}

async function lstatOptional(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readRequiredFile(target: string, label: string): Promise<Uint8Array> {
  const content = await readOptionalFile(target);
  if (content === null) throw new Error(`Missing ${label}: ${target}`);
  if (content.byteLength === 0) throw new Error(`${label} must not be empty`);
  return content;
}

async function readOptionalFile(target: string): Promise<Uint8Array | null> {
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isMissingFile(error)) return null;
    if (isSymlinkLoop(error)) {
      throw new Error(`Package metadata input is a symbolic link: ${target}`);
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Package metadata input is not a file: ${target}`);
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isSymlinkLoop(error: unknown): boolean {
  return isNodeError(error, "ELOOP");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  generateOrdinaryAppPackageMetadata().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
