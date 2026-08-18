import {
  deploymentBuildRecordSha256,
  parseDeploymentBuildRecord,
  serializeDeploymentBuildRecord,
  type CompleteDeploymentBuildRecord,
  type DeploymentDiagnosticRecord,
  type DeploymentMemoryChange,
  type DeploymentPackageBuildInput,
  type DeploymentWarningsRecord,
} from "neutron-compiler/src/deployment_record.js";
import {
  assertPreparedPackageBatch,
  assertPreparedPackageArchiveIdentity,
  unpackNeutronPackage,
  type PreparedPackageInstall,
} from "neutron-compiler/src/install.js";
import {
  NEUTRON_PACKAGE_RECORD_PATH,
  neutronPackageRecordArchiveOnlyPaths,
  parseNeutronPackageRecord,
  parseNeutronPackageRecordStructure,
  type NeutronPackageRecordV1,
} from "neutron-tools/package_record.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.js";
import { formatAppVersion } from "neutron-tools/src/version.js";

/** Evidence returned by a loader that hashed the exact retained record JSON. */
export type RetainedPackageRecordReviewEvidence = Readonly<{
  record: NeutronPackageRecordV1;
  recordBytes: Uint8Array;
  sha256: string;
}>;

export type DeploymentBuildReviewInput = Readonly<{
  /** A parsed complete record. It is parsed again at each review boundary. */
  record: CompleteDeploymentBuildRecord;
  /** Only packages newly supplied for this deployment, never retained apps. */
  suppliedPackages: readonly PreparedPackageInstall[];
  /** Optional exact Package Information Record evidence for retained targets. */
  retainedPackageRecords?: Readonly<
    Record<string, RetainedPackageRecordReviewEvidence>
  >;
}>;

export type DeploymentBuildReviewDistribution =
  | Readonly<{
      state: "declared_update_source";
      updateSource: string;
    }>
  | Readonly<{ state: "manual_unofficial" }>
  | Readonly<{ state: "retained_unknown" }>;

export type DeploymentBuildReviewArchive = Readonly<{
  recordState: DeploymentPackageBuildInput["archive"]["state"];
  recordSha256: string | null;
  recordedBytes: number | null;
  suppliedIdentity: Readonly<{ sha256: string; bytes: number }> | null;
  reconciliation:
    | "exact_match"
    | "digest_match"
    | "supplied_but_record_unavailable"
    | "record_only"
    | "not_retained";
  downloadFilename: string | null;
}>;

export type DeploymentBuildReviewPackageRecordDetails = Readonly<{
  origin: "supplied_verified" | "retained_record_verified";
  record: NeutronPackageRecordV1;
}>;

export type DeploymentBuildReviewPackageInformation = Readonly<{
  state: "verified" | "not_supplied" | "legacy_unavailable";
  sha256: string | null;
  details: DeploymentBuildReviewPackageRecordDetails | null;
}>;

export type DeploymentBuildReviewPackage = Readonly<{
  appId: string;
  displayName: string;
  version: number;
  versionLabel: string;
  input: "newly_supplied" | "retained";
  distribution: DeploymentBuildReviewDistribution;
  archive: DeploymentBuildReviewArchive;
  packageInformation: DeploymentBuildReviewPackageInformation;
  dependencies: DeploymentPackageBuildInput["dependencies"];
}>;

export type DeploymentBuildReviewWarnings = DeploymentWarningsRecord &
  Readonly<{
    materialCount: number;
    hasMaterialWarnings: boolean;
  }>;

export type DeploymentBuildReviewModel = Readonly<{
  record: Readonly<{
    format: 1;
    state: "complete";
    deploymentId: string;
    canonicalJsonBytes: number;
    canonicalJsonSha256: string;
    domainSeparatedSha256: string;
    downloadFilename: string;
  }>;
  build: CompleteDeploymentBuildRecord["build"];
  previous: CompleteDeploymentBuildRecord["previous"];
  target: CompleteDeploymentBuildRecord["target"];
  installation: CompleteDeploymentBuildRecord["installation"];
  wasm: CompleteDeploymentBuildRecord["wasm"];
  packages: readonly DeploymentBuildReviewPackage[];
  warnings: DeploymentBuildReviewWarnings;
}>;

export type DeploymentBuildRecordArtifact = Readonly<{
  kind: "build_record";
  filename: string;
  mediaType: "application/json;charset=utf-8";
  bytes: Uint8Array;
  expectedSha256: string;
  expectedBytes: number;
}>;

export type DeploymentPackageArchiveArtifact = Readonly<{
  kind: "package_archive";
  appId: string;
  version: number;
  filename: string;
  mediaType: "application/octet-stream";
  bytes: Uint8Array;
  expectedSha256: string;
  expectedBytes: number;
}>;

export type DeploymentReviewArtifact =
  | DeploymentBuildRecordArtifact
  | DeploymentPackageArchiveArtifact;

export type DeploymentReviewArtifactSelection =
  | Readonly<{ kind: "build_record" }>
  | Readonly<{ kind: "package_archive"; appId: string }>;

export type DeploymentReviewDownloadEnvironment = Readonly<{
  createObjectUrl(bytes: Uint8Array, mediaType: string): string;
  triggerDownload(objectUrl: string, filename: string): void;
  revokeObjectUrl(objectUrl: string): void;
}>;

/**
 * Build the immutable, display-only review model. This function performs no
 * I/O: it neither fetches retained metadata nor dispatches an installation.
 */
export function createDeploymentBuildReviewModel(
  input: DeploymentBuildReviewInput,
): DeploymentBuildReviewModel {
  const parsed = parseDeploymentBuildRecord(input.record);
  if (parsed.state !== "complete") {
    throw new Error("Pre-dispatch review requires a complete deployment record");
  }

  const suppliedPackages = [...input.suppliedPackages];
  assertPreparedPackageBatch(suppliedPackages);

  const recordPackages = new Map(
    parsed.packages.map((pkg) => [pkg.app_id, pkg] as const),
  );
  const targetApps = new Map(
    parsed.target.apps.map((app) => [app.app_id, app] as const),
  );
  const suppliedByApp = new Map<string, PreparedPackageInstall>();
  for (const supplied of suppliedPackages) {
    const appId = supplied.manifest.id;
    const recorded = recordPackages.get(appId);
    if (!recorded) {
      throw new Error(
        `Supplied package ${appId} is absent from the deployment build record`,
      );
    }
    if (recorded.version !== supplied.manifest.version) {
      throw new Error(
        `Supplied package ${appId} version ${supplied.manifest.version} does not match recorded version ${recorded.version}`,
      );
    }
    const target = targetApps.get(appId);
    if (
      !target ||
      target.capability_plan_fingerprint !==
        supplied.capabilityPlanFingerprint
    ) {
      throw new Error(
        `Supplied package ${appId} capability plan does not match the deployment target`,
      );
    }
    if (supplied.isKernel !== (appId === "kernel")) {
      throw new Error(`Supplied package ${appId} has an invalid Kernel identity`);
    }
    suppliedByApp.set(appId, supplied);
  }

  const retainedRecords = normalizeRetainedPackageRecords(
    input.retainedPackageRecords,
    recordPackages,
    suppliedByApp,
  );

  const packages = parsed.packages.map((recorded) => {
    const supplied = suppliedByApp.get(recorded.app_id);
    const retained = retainedRecords.get(recorded.app_id);
    const packageRecord = reconcilePackageInformation({
      recorded,
      supplied,
      retained,
    });
    return Object.freeze({
      appId: recorded.app_id,
      displayName: supplied?.manifest.name ?? recorded.app_id,
      version: recorded.version,
      versionLabel: `v${formatAppVersion(recorded.version)}`,
      input: supplied ? ("newly_supplied" as const) : ("retained" as const),
      distribution: distributionFor(supplied),
      archive: reconcileArchive(recorded, supplied),
      packageInformation: packageRecord,
      dependencies: recorded.dependencies,
    });
  });

  const recordBytes = serializeDeploymentBuildRecord(parsed);
  const warnings = reviewWarnings(parsed.warnings);
  return Object.freeze({
    record: Object.freeze({
      format: 1 as const,
      state: "complete" as const,
      deploymentId: parsed.deployment_id,
      canonicalJsonBytes: recordBytes.byteLength,
      canonicalJsonSha256: hashContent(recordBytes),
      domainSeparatedSha256: deploymentBuildRecordSha256(parsed),
      downloadFilename: buildRecordFilename(),
    }),
    build: parsed.build,
    previous: parsed.previous,
    target: parsed.target,
    installation: parsed.installation,
    wasm: parsed.wasm,
    packages: Object.freeze(packages),
    warnings,
  });
}

/**
 * Revalidate and snapshot every downloadable byte sequence. No package is
 * rebuilt: archive artifacts are byte-for-byte copies of retained input.
 */
export function buildDeploymentReviewArtifacts(
  input: DeploymentBuildReviewInput,
): readonly DeploymentReviewArtifact[] {
  const model = createDeploymentBuildReviewModel(input);
  const recordBytes = serializeDeploymentBuildRecord(input.record);
  if (
    recordBytes.byteLength !== model.record.canonicalJsonBytes ||
    hashContent(recordBytes) !== model.record.canonicalJsonSha256
  ) {
    throw new Error("Deployment build record changed during review export");
  }

  const artifacts: DeploymentReviewArtifact[] = [
    Object.freeze({
      kind: "build_record" as const,
      filename: model.record.downloadFilename,
      mediaType: "application/json;charset=utf-8" as const,
      bytes: recordBytes,
      expectedSha256: model.record.canonicalJsonSha256,
      expectedBytes: model.record.canonicalJsonBytes,
    }),
  ];
  const suppliedByApp = new Map(
    input.suppliedPackages.map((pkg) => [pkg.manifest.id, pkg] as const),
  );
  for (const pkg of model.packages) {
    const supplied = suppliedByApp.get(pkg.appId);
    if (!supplied) continue;
    if (supplied.archiveBytes === undefined) {
      throw new Error(`Prepared package ${pkg.appId} archive bytes are unavailable`);
    }
    assertPreparedPackageArchiveIdentity(supplied);
    const identity = supplied.archiveIdentity;
    if (!identity) {
      throw new Error(
        `Prepared package ${pkg.appId} archive identity is unavailable`,
      );
    }
    const bytes = supplied.archiveBytes.slice();
    if (
      bytes.byteLength !== identity.size ||
      hashContent(bytes) !== identity.sha256
    ) {
      throw new Error(
        `Prepared package ${pkg.appId} archive changed during review export`,
      );
    }
    artifacts.push(
      Object.freeze({
        kind: "package_archive" as const,
        appId: pkg.appId,
        version: pkg.version,
        filename: archiveFilename(pkg.appId, pkg.version),
        mediaType: "application/octet-stream" as const,
        bytes,
        expectedSha256: identity.sha256,
        expectedBytes: identity.size,
      }),
    );
  }
  return Object.freeze(artifacts);
}

/** Build only the artifact selected by a user, avoiding unrelated byte copies. */
export function buildDeploymentReviewArtifact(
  input: DeploymentBuildReviewInput,
  selection: DeploymentReviewArtifactSelection,
): DeploymentReviewArtifact {
  const model = createDeploymentBuildReviewModel(input);
  if (selection.kind === "build_record") {
    const bytes = serializeDeploymentBuildRecord(input.record);
    if (
      bytes.byteLength !== model.record.canonicalJsonBytes ||
      hashContent(bytes) !== model.record.canonicalJsonSha256
    ) {
      throw new Error("Deployment build record changed during review export");
    }
    return Object.freeze({
      kind: "build_record" as const,
      filename: model.record.downloadFilename,
      mediaType: "application/json;charset=utf-8" as const,
      bytes,
      expectedSha256: model.record.canonicalJsonSha256,
      expectedBytes: model.record.canonicalJsonBytes,
    });
  }

  const reviewed = model.packages.find(({ appId }) => appId === selection.appId);
  const supplied = input.suppliedPackages.find(
    ({ manifest }) => manifest.id === selection.appId,
  );
  if (!reviewed || !supplied || supplied.archiveBytes === undefined) {
    throw new Error(
      `Reviewed package archive ${selection.appId} is unavailable`,
    );
  }
  assertPreparedPackageArchiveIdentity(supplied);
  const identity = supplied.archiveIdentity;
  if (!identity) {
    throw new Error(
      `Prepared package ${selection.appId} archive identity is unavailable`,
    );
  }
  const bytes = supplied.archiveBytes.slice();
  if (
    bytes.byteLength !== identity.size ||
    hashContent(bytes) !== identity.sha256
  ) {
    throw new Error(
      `Prepared package ${selection.appId} archive changed during review export`,
    );
  }
  return Object.freeze({
    kind: "package_archive" as const,
    appId: selection.appId,
    version: reviewed.version,
    filename: archiveFilename(selection.appId, reviewed.version),
    mediaType: "application/octet-stream" as const,
    bytes,
    expectedSha256: identity.sha256,
    expectedBytes: identity.size,
  });
}

/** Trigger one inert object-URL download. The caller must invoke this from UI. */
export function downloadDeploymentReviewArtifact(
  artifact: DeploymentReviewArtifact,
  environment: DeploymentReviewDownloadEnvironment =
    browserDeploymentReviewDownloadEnvironment,
): void {
  if (
    artifact.bytes.byteLength !== artifact.expectedBytes ||
    hashContent(artifact.bytes) !== artifact.expectedSha256
  ) {
    throw new Error(`${artifact.filename} changed after review export`);
  }
  const objectUrl = environment.createObjectUrl(
    artifact.bytes,
    artifact.mediaType,
  );
  try {
    environment.triggerDownload(objectUrl, artifact.filename);
  } finally {
    environment.revokeObjectUrl(objectUrl);
  }
}

type NormalizedRetainedPackageRecord = Readonly<{
  record: NeutronPackageRecordV1;
  origin: "retained_record_verified";
}>;

function normalizeRetainedPackageRecords(
  values: DeploymentBuildReviewInput["retainedPackageRecords"],
  recordPackages: ReadonlyMap<string, DeploymentPackageBuildInput>,
  suppliedByApp: ReadonlyMap<string, PreparedPackageInstall>,
): ReadonlyMap<string, NormalizedRetainedPackageRecord> {
  const normalized = new Map<string, NormalizedRetainedPackageRecord>();
  for (const [appId, value] of Object.entries(values ?? {})) {
    const recorded = recordPackages.get(appId);
    if (!recorded) {
      throw new Error(
        `Retained package record ${appId} is absent from the deployment build record`,
      );
    }
    if (!(value.recordBytes instanceof Uint8Array)) {
      throw new Error(`Retained package record ${appId} bytes are invalid`);
    }
    const record = parseNeutronPackageRecordStructure(value.recordBytes);
    if (record.package.id !== appId || record.package.version !== recorded.version) {
      throw new Error(
        `Retained package record ${appId} does not match the recorded package identity`,
      );
    }
    if (recorded.package_information.state !== "verified") {
      throw new Error(
        `Retained package record ${appId} conflicts with unavailable package information`,
      );
    }
    const actualSha256 = hashContent(value.recordBytes);
    if (
      value.sha256 !== actualSha256 ||
      actualSha256 !== recorded.package_information.sha256
    ) {
      throw new Error(
        `Retained package record ${appId} SHA-256 does not match the deployment build record`,
      );
    }
    if (stableJson(record) !== stableJson(value.record)) {
      throw new Error(`Retained package record ${appId} changed after parsing`);
    }
    // Newly supplied package bytes remain authoritative when both are present.
    if (!suppliedByApp.has(appId)) {
      normalized.set(
        appId,
        Object.freeze({
          record,
          origin: "retained_record_verified" as const,
        }),
      );
    }
  }
  return normalized;
}

function reconcileArchive(
  recorded: DeploymentPackageBuildInput,
  supplied: PreparedPackageInstall | undefined,
): DeploymentBuildReviewArchive {
  if (!supplied) {
    return Object.freeze({
      recordState: recorded.archive.state,
      recordSha256:
        recorded.archive.state === "legacy_unavailable"
          ? null
          : recorded.archive.sha256,
      recordedBytes:
        recorded.archive.state === "verified" ? recorded.archive.bytes : null,
      suppliedIdentity: null,
      reconciliation: "record_only" as const,
      downloadFilename: null,
    });
  }

  assertPreparedPackageArchiveIdentity(supplied);
  const identity = supplied.archiveIdentity;
  if (!identity || supplied.archiveBytes === undefined) {
    throw new Error(
      `Supplied package ${recorded.app_id} requires exact retained archive bytes and identity`,
    );
  }
  if (recorded.archive.state !== "verified") {
    throw new Error(
      `Supplied package ${recorded.app_id} requires a verified archive entry in the deployment build record`,
    );
  }

  if (recorded.archive.sha256 !== identity.sha256) {
    throw new Error(
      `Supplied package ${recorded.app_id} archive SHA-256 does not match the deployment build record`,
    );
  }
  if (recorded.archive.bytes !== identity.size) {
    throw new Error(
      `Supplied package ${recorded.app_id} archive size does not match the deployment build record`,
    );
  }

  return Object.freeze({
    recordState: recorded.archive.state,
    recordSha256: recorded.archive.sha256,
    recordedBytes: recorded.archive.bytes,
    suppliedIdentity: Object.freeze({
      sha256: identity.sha256,
      bytes: identity.size,
    }),
    reconciliation: "exact_match" as const,
    downloadFilename: archiveFilename(recorded.app_id, recorded.version),
  });
}

function reconcilePackageInformation({
  recorded,
  retained,
  supplied,
}: Readonly<{
  recorded: DeploymentPackageBuildInput;
  supplied: PreparedPackageInstall | undefined;
  retained: NormalizedRetainedPackageRecord | undefined;
}>): DeploymentBuildReviewPackageInformation {
  if (supplied) {
    const packageFiles = packageRelativeFiles(supplied);
    const recordBytes = packageFiles[NEUTRON_PACKAGE_RECORD_PATH];
    if (recorded.package_information.state === "legacy_unavailable") {
      throw new Error(
        `Supplied package ${recorded.app_id} cannot use retained legacy package-information state`,
      );
    }
    if (recorded.package_information.state === "not_supplied") {
      if (supplied.packageRecord !== undefined || recordBytes !== undefined) {
        throw new Error(
          `Supplied package ${recorded.app_id} has a Package Information Record that the deployment record marks not supplied`,
        );
      }
      return Object.freeze({
        state: "not_supplied" as const,
        sha256: null,
        details: null,
      });
    }
    if (supplied.packageRecord === undefined || recordBytes === undefined) {
      throw new Error(
        `Supplied package ${recorded.app_id} is missing its recorded Package Information Record`,
      );
    }
    if (hashContent(recordBytes) !== recorded.package_information.sha256) {
      throw new Error(
        `Supplied package ${recorded.app_id} Package Information Record SHA-256 does not match the deployment build record`,
      );
    }
    const parsed = parseNeutronPackageRecord(recordBytes, {
      files: packageFiles,
      manifest: supplied.manifest,
    });
    if (stableJson(parsed) !== stableJson(supplied.packageRecord)) {
      throw new Error(
        `Supplied package ${recorded.app_id} Package Information Record changed after preparation`,
      );
    }
    assertPackageRecordDependencies(recorded, parsed);
    return Object.freeze({
      state: "verified" as const,
      sha256: recorded.package_information.sha256,
      details: Object.freeze({
        origin: "supplied_verified" as const,
        record: parsed,
      }),
    });
  }

  if (recorded.package_information.state === "legacy_unavailable") {
    return Object.freeze({
      state: "legacy_unavailable" as const,
      sha256: null,
      details: null,
    });
  }
  if (recorded.package_information.state === "not_supplied") {
    return Object.freeze({
      state: "not_supplied" as const,
      sha256: null,
      details: null,
    });
  }
  if (!retained) {
    return Object.freeze({
      state: "verified" as const,
      sha256: recorded.package_information.sha256,
      details: null,
    });
  }
  assertPackageRecordDependencies(recorded, retained.record);
  return Object.freeze({
    state: "verified" as const,
    sha256: recorded.package_information.sha256,
    details: Object.freeze({
      origin: retained.origin,
      record: retained.record,
    }),
  });
}

function packageRelativeFiles(
  prepared: PreparedPackageInstall,
): Record<string, Uint8Array> {
  const prefix = `${prepared.appPrefix}pkg/`;
  const files: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  for (const file of prepared.files) {
    if (!file.path.startsWith(prefix)) continue;
    const relative = file.path.slice(prefix.length);
    if (Object.hasOwn(files, relative)) {
      throw new Error(
        `Supplied package ${prepared.manifest.id} repeats package file ${relative}`,
      );
    }
    files[relative] = file.content;
  }
  const archiveOnlyPaths = prepared.packageRecord === undefined
    ? []
    : neutronPackageRecordArchiveOnlyPaths(prepared.packageRecord);
  if (archiveOnlyPaths.length > 0) {
    assertPreparedPackageArchiveIdentity(prepared);
    if (prepared.archiveBytes === undefined) {
      throw new Error(
        `Supplied package ${prepared.manifest.id} archive-only legal/source material requires its original archive bytes`,
      );
    }
    const archived = unpackNeutronPackage(prepared.archiveBytes);
    for (const archiveOnlyPath of archiveOnlyPaths) {
      const content = archived[archiveOnlyPath];
      if (content === undefined) {
        throw new Error(
          `Supplied package ${prepared.manifest.id} archive is missing ${archiveOnlyPath}`,
        );
      }
      files[archiveOnlyPath] = content;
    }
  }
  return files;
}

function assertPackageRecordDependencies(
  recorded: DeploymentPackageBuildInput,
  packageRecord: NeutronPackageRecordV1,
): void {
  const expected = recorded.dependencies.map((dependency) => ({
    alias: dependency.alias,
    app: dependency.provider_app_id,
    min_version: dependency.minimum_version,
    functions: dependency.functions,
  }));
  if (stableJson(expected) !== stableJson(packageRecord.dependencies)) {
    throw new Error(
      `Package Information Record dependencies for ${recorded.app_id} do not match the deployment build record`,
    );
  }
}

function distributionFor(
  supplied: PreparedPackageInstall | undefined,
): DeploymentBuildReviewDistribution {
  if (!supplied) return Object.freeze({ state: "retained_unknown" as const });
  const updateSource = supplied.manifest.update_source;
  return updateSource === undefined
    ? Object.freeze({ state: "manual_unofficial" as const })
    : Object.freeze({
        state: "declared_update_source" as const,
        updateSource,
      });
}

function reviewWarnings(
  warnings: DeploymentWarningsRecord,
): DeploymentBuildReviewWarnings {
  const materialMemoryChanges = warnings.memory_changes.filter(
    (change) => change.kind !== "keep",
  ).length;
  const materialCount =
    warnings.diagnostics.length +
    warnings.compatibility_diagnostics.length +
    materialMemoryChanges +
    warnings.removed_apps.length +
    warnings.destructive_memory_roots.length;
  return Object.freeze({
    diagnostics: warnings.diagnostics,
    compatibility_diagnostics: warnings.compatibility_diagnostics,
    memory_changes: warnings.memory_changes,
    removed_apps: warnings.removed_apps,
    destructive_memory_roots: warnings.destructive_memory_roots,
    materialCount,
    hasMaterialWarnings: materialCount > 0,
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function buildRecordFilename(): string {
  return "neutron-deployment-build-record.json";
}

function archiveFilename(appId: string, version: number): string {
  return packageArchiveFilename(appId, version);
}

const browserDeploymentReviewDownloadEnvironment: DeploymentReviewDownloadEnvironment =
  Object.freeze({
    createObjectUrl(bytes: Uint8Array, mediaType: string): string {
      return URL.createObjectURL(
        new Blob([bytes.slice().buffer], { type: mediaType }),
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

export function deploymentDiagnosticLocation(
  diagnostic: DeploymentDiagnosticRecord,
): string {
  const { start, end } = diagnostic.range;
  return `${diagnostic.source}:${start.line + 1}:${start.character + 1}-${
    end.line + 1
  }:${end.character + 1}`;
}

export function deploymentMemoryChangeLabel(
  change: DeploymentMemoryChange,
): string {
  const root = `${change.owner}/${change.memory_id}`;
  if (change.kind === "initialize") return `${root}: initialize v${change.to}`;
  if (change.kind === "keep") return `${root}: keep v${change.version}`;
  if (change.kind === "migrate") {
    return `${root}: migrate v${change.from} to v${change.to}`;
  }
  return `${root}: retire v${change.from} (${change.reason})`;
}
