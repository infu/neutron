import { isValidAppId } from "./app_ids.ts";
import { compareCanonicalText } from "./canonical.ts";
import { hashContent } from "./hash.ts";
import {
  assertSafeRelativeAssetPath,
  NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE,
  normalizeManifestDependencies,
  normalizeUntrustedText,
  type PackagedNeutronManifest,
} from "./schema.ts";
export { NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE } from "./schema.ts";
import { assertAppVersion } from "./version.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", { fatal: true });
const DEPENDENCY_ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,29}$/u;
const METHOD_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/u;
const DEPLOYMENT_PRINCIPAL_PATTERN = /^(?:[a-z2-7]{5}-)+[a-z2-7]{1,5}$/u;
const PRIVATE_METADATA_PATTERN =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:basic|bearer)\s+[a-z0-9+/=._~-]{8,}|\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|credential|private[_-]?key)\s*(?:=|:))/iu;
const DEPLOYMENT_ARGUMENT_PATTERN =
  /^--?(?:api[-_]?key|canister(?:-id)?|controller|controllers|credential|identity|network|password|principal|secret|token|wallet)(?:=|$)/iu;
const LOCAL_ABSOLUTE_PATH_PATTERN = /^(?:\/|~(?:\/|$)|[a-z]:[\\/]|\\\\|file:)/iu;

/** The one reserved archive path for the target-neutral v1 legal record. */
export const NEUTRON_PACKAGE_RECORD_PATH =
  "legal/package-record.v1.json" as const;

/**
 * Reserved retainable Complete App Source snapshot carried only by an ordinary
 * app archive. Install preparation verifies this object through the package
 * record but deliberately does not stage it into the canister's public assets.
 */
export const NEUTRON_APP_SOURCE_SNAPSHOT_PATH =
  "legal/source/app-source.v1.msgpack" as const;

/** Media type for the deterministic gzip bytes offered over HTTPS. */
export const NEUTRON_APP_SOURCE_MEDIA_TYPE =
  "application/gzip" as const;

/** Certified update-source namespace for digest-addressed source objects. */
export const NEUTRON_APP_SOURCE_REPOSITORY_PREFIX =
  "/repo/v1/sources/" as const;

/** Canonical filename shared by packagers, publishers, and download UIs. */
export function neutronAppSourceArchiveFilename(sha256: string): string {
  const digest = parseSha256(sha256, "app source SHA-256");
  return `${digest}.source.v1.msgpack.gz`;
}

/** Canonical certified path for one immutable Complete App Source object. */
export function neutronAppSourceRepositoryPath(sha256: string): string {
  return `${NEUTRON_APP_SOURCE_REPOSITORY_PREFIX}${neutronAppSourceArchiveFilename(sha256)}`;
}

/** Build the public source-offer URL from a clean HTTPS origin and digest. */
export function neutronAppSourceHttpsUrl(
  origin: string,
  sha256: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch (error) {
    throw new Error("App source origin is invalid", { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "App source origin must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  return `${parsed.origin}${neutronAppSourceRepositoryPath(sha256)}`;
}

/**
 * Bulk legal materials below this prefix are verified from the original
 * package archive but are deliberately not copied into public canister assets.
 */
export const NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX =
  "legal/archive-only/" as const;

/** Closed decoded limits for the v1 archive-only Complete App Source object. */
export const NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS = Object.freeze({
  encodedBytes: 16 * MIB,
  files: 8_192,
  pathBytes: 4_096,
  fileBytes: 16 * MIB,
  totalFileBytes: 32 * MIB,
});

/** Bound for the deterministic gzip transport of a valid v1 source snapshot. */
export const NEUTRON_APP_SOURCE_TRANSPORT_LIMITS = Object.freeze({
  compressedBytes: 17 * MIB,
});

export function isNeutronPackageArchiveOnlyPath(packagePath: string): boolean {
  return (
    packagePath === NEUTRON_APP_SOURCE_SNAPSHOT_PATH ||
    packagePath.startsWith(NEUTRON_PACKAGE_ARCHIVE_ONLY_LEGAL_PREFIX)
  );
}

/** Backward-friendly name for consumers that describe this as package information. */
export const PACKAGE_INFORMATION_RECORD_PATH = NEUTRON_PACKAGE_RECORD_PATH;

/**
 * Parsing bounds are part of the v1 package-record contract. They keep an
 * untrusted package record cheap to review and prevent it from becoming a
 * second, effectively unbounded package manifest.
 */
export const NEUTRON_PACKAGE_RECORD_LIMITS = Object.freeze({
  jsonBytes: 64 * KIB,
  pathBytes: 512,
  licenseIdCodePoints: 128,
  licenseTexts: 8,
  licenseTextBytes: 2 * MIB,
  notices: 64,
  noticeBytes: 4 * MIB,
  dependencies: 32,
  dependencyFunctions: 64,
  sourceUrlCharacters: 2048,
  sourceRevisionCodePoints: 256,
  embeddedSourceBytes: 64 * MIB,
  declaredSourceBytes: 4 * GIB,
  features: 8,
  buildInputs: 256,
  buildCommands: 32,
  commandArguments: 64,
  commandPurposeCodePoints: 32,
  commandArgumentCodePoints: 512,
} as const);

export type NeutronPackageEmbeddedFileV1 = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
}>;

export type NeutronPackageLicenseTextV1 = NeutronPackageEmbeddedFileV1 &
  Readonly<{
    id: string;
  }>;

export type NeutronPackageLicenseV1 = Readonly<{
  /** License reference governing this package, for example a SPDX LicenseRef. */
  id: string;
  /** Exact embedded texts for the governing and any required companion licenses. */
  texts: readonly NeutronPackageLicenseTextV1[];
}>;

export type NeutronPackageEmbeddedSourceOfferV1 = Readonly<{
  kind: "embedded";
  revision: string;
  path: string;
  sha256: string;
  bytes: number;
}>;

export type NeutronPackageHttpsSourceOfferV1 = Readonly<{
  kind: "https";
  revision: string;
  url: string;
  sha256: string;
  bytes: number;
}>;

export type NeutronPackageSourceStatusV1 = Readonly<{
  kind: "status";
  /** A factual no-offer status; license-specific release policy is separate. */
  status: "not-provided" | "not-required" | "unknown";
}>;

export type NeutronPackageSourceOfferV1 =
  | NeutronPackageEmbeddedSourceOfferV1
  | NeutronPackageHttpsSourceOfferV1
  | NeutronPackageSourceStatusV1;

export type NeutronPackageDependencyV1 = Readonly<{
  alias: string;
  app: string;
  min_version: number;
  functions: readonly string[];
}>;

/** A digest-bound path inside the offered corresponding-source archive. */
export type NeutronPackageBuildInputV1 = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
}>;

/** An informational argv vector. Package-record commands are never executed. */
export type NeutronPackageBuildCommandV1 = Readonly<{
  purpose: string;
  cwd: string;
  argv: readonly string[];
}>;

export type NeutronPackageRecordFeatureV1 =
  typeof NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE;

export type NeutronPackageRecordV1 = Readonly<{
  format: 1;
  /**
   * Closed opt-in features. Absent on legacy v1 records; archive-only records
   * must declare the exact feature understood by the installing Kernel.
   */
  features?: readonly NeutronPackageRecordFeatureV1[];
  package: Readonly<{
    id: string;
    version: number;
    manifest: NeutronPackageEmbeddedFileV1;
  }>;
  license: NeutronPackageLicenseV1;
  source: NeutronPackageSourceOfferV1;
  /** Exact copy of the packaged manifest's application dependency contract. */
  dependencies: readonly NeutronPackageDependencyV1[];
  notices: readonly NeutronPackageEmbeddedFileV1[];
  /** Null exactly when the packaged manifest has no managed-memory roots. */
  memory: Readonly<{ lock: NeutronPackageEmbeddedFileV1 }> | null;
  build: Readonly<{
    /** Important inputs within the offered source, not paths in this package. */
    inputs: readonly NeutronPackageBuildInputV1[];
    commands: readonly NeutronPackageBuildCommandV1[];
  }>;
}>;

/** Exact package paths verified from, but intentionally retained only in, the archive. */
export function neutronPackageRecordArchiveOnlyPaths(
  record: NeutronPackageRecordV1,
): readonly string[] {
  const paths = [
    ...record.license.texts.map(({ path }) => path),
    ...(record.source.kind === "embedded" ? [record.source.path] : []),
    ...record.notices.map(({ path }) => path),
  ].filter(isNeutronPackageArchiveOnlyPath);
  paths.sort(compareCanonicalText);
  return Object.freeze(paths);
}

export type NeutronPackageRecordContext = Readonly<{
  files: Readonly<Record<string, Uint8Array>>;
  manifest: Pick<
    PackagedNeutronManifest,
    "id" | "version" | "dependencies" | "memory"
  >;
}>;

/**
 * Read the reserved record when present. Absence deliberately means
 * legacy/undeclared and remains installable; a present invalid record fails.
 */
export function readNeutronPackageRecord(
  context: NeutronPackageRecordContext,
): NeutronPackageRecordV1 | undefined {
  if (!Object.hasOwn(context.files, NEUTRON_PACKAGE_RECORD_PATH)) {
    return undefined;
  }
  const content = context.files[NEUTRON_PACKAGE_RECORD_PATH];
  if (!(content instanceof Uint8Array)) {
    throw invalidRecord("record content must be bytes");
  }
  return parseNeutronPackageRecord(content, context);
}

/** Parse and verify a present v1 record against its exact package contents. */
export function parseNeutronPackageRecord(
  content: Uint8Array,
  context: NeutronPackageRecordContext,
): NeutronPackageRecordV1 {
  try {
    return parseNeutronPackageRecordInner(content, context);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`Invalid ${NEUTRON_PACKAGE_RECORD_PATH}:`)
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw invalidRecord(message, error);
  }
}

/**
 * Parse the bounded, closed record declaration without claiming that any
 * referenced package bytes were fetched or digest-verified. Installed UIs use
 * this to render metadata immediately and verify large source/notices lazily.
 */
export function parseNeutronPackageRecordStructure(
  content: Uint8Array,
): NeutronPackageRecordV1 {
  try {
    return parseNeutronPackageRecordInner(content);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`Invalid ${NEUTRON_PACKAGE_RECORD_PATH}:`)
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw invalidRecord(message, error);
  }
}

export type NeutronPackageRecordEmbeddedRole =
  | "manifest"
  | "license"
  | "source"
  | "notice"
  | "memory";

export type DiscoverNeutronPackageRecordPathsOptions = Readonly<{
  /** Defaults to every embedded role. An empty list discovers no paths. */
  include?: readonly NeutronPackageRecordEmbeddedRole[];
}>;

/**
 * Perform bounded structural validation before an installed-package reader
 * fetches referenced assets. The returned package-relative paths never include
 * HTTPS offers or arbitrary fields and have not yet been digest-verified.
 * Call parseNeutronPackageRecord after fetching them to establish authenticity.
 */
export function discoverNeutronPackageRecordEmbeddedPaths(
  content: Uint8Array,
  options: DiscoverNeutronPackageRecordPathsOptions = {},
): readonly string[] {
  try {
    const record = parseNeutronPackageRecordInner(content);
    const included = new Set<NeutronPackageRecordEmbeddedRole>(
      options.include ?? ["manifest", "license", "source", "notice", "memory"],
    );
    const paths = [
      ...(included.has("manifest") ? [record.package.manifest.path] : []),
      ...(included.has("license")
        ? record.license.texts.map(({ path }) => path)
        : []),
      ...(included.has("source") && record.source.kind === "embedded"
        ? [record.source.path]
        : []),
      ...(included.has("notice")
        ? record.notices.map(({ path }) => path)
        : []),
      ...(included.has("memory") && record.memory !== null
        ? [record.memory.lock.path]
        : []),
    ];
    return Object.freeze(paths);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`Invalid ${NEUTRON_PACKAGE_RECORD_PATH}:`)
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw invalidRecord(message, error);
  }
}

/**
 * Verify the small manifest-dependent portion of a structurally parsed record.
 * This checks exact neutron.json bytes plus id/version/dependencies/memory
 * presence without fetching license, notice, lock, or source payloads.
 */
export function assertNeutronPackageRecordManifestContext(
  record: NeutronPackageRecordV1,
  context: NeutronPackageRecordContext,
): void {
  try {
    if (record.package.id !== context.manifest.id) {
      throw new Error(
        `package.id ${record.package.id} does not match neutron.json id ${context.manifest.id}`,
      );
    }
    if (record.package.version !== context.manifest.version) {
      throw new Error(
        `package.version ${record.package.version} does not match neutron.json version ${context.manifest.version}`,
      );
    }
    parseEmbeddedFile(
      record.package.manifest,
      "package.manifest",
      context.files,
      new Set([NEUTRON_PACKAGE_RECORD_PATH]),
      {
        exactPath: "neutron.json",
        maximumBytes: NEUTRON_PACKAGE_RECORD_LIMITS.jsonBytes * 4,
      },
    );
    parseDependencies(record.dependencies, context.manifest);
    const hasManagedMemory =
      Object.keys(context.manifest.memory ?? {}).length > 0;
    if (hasManagedMemory !== (record.memory !== null)) {
      throw new Error(
        hasManagedMemory
          ? "memory must bind neutron.lock.json when neutron.json declares managed-memory roots"
          : "memory must be null when neutron.json declares no managed-memory roots",
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(`Invalid ${NEUTRON_PACKAGE_RECORD_PATH}:`)
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw invalidRecord(message, error);
  }
}

function parseNeutronPackageRecordInner(
  content: Uint8Array,
  context?: NeutronPackageRecordContext,
): NeutronPackageRecordV1 {
  if (!(content instanceof Uint8Array)) {
    throw new Error("record content must be bytes");
  }
  if (content.byteLength === 0) {
    throw new Error("record must not be empty");
  }
  if (content.byteLength > NEUTRON_PACKAGE_RECORD_LIMITS.jsonBytes) {
    throw new Error(
      `record exceeds the ${NEUTRON_PACKAGE_RECORD_LIMITS.jsonBytes}-byte limit`,
    );
  }

  let text: string;
  try {
    text = fatalTextDecoder.decode(content);
  } catch (error) {
    throw new Error("record is not valid UTF-8", { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("record is not valid JSON", { cause: error });
  }
  assertNoDuplicateJsonObjectKeys(text);

  const record = expectObject(parsed, "record");
  const recordKeys = [
    "build",
    "dependencies",
    "format",
    "license",
    "memory",
    "notices",
    "package",
    "source",
  ];
  const hasFeatures = Object.hasOwn(record, "features");
  expectExactKeys(
    record,
    hasFeatures ? [...recordKeys, "features"] : recordKeys,
    "record",
  );
  if (record.format !== 1) {
    throw new Error("format must be 1");
  }

  const features = hasFeatures ? parseFeatures(record.features) : undefined;

  const claimedPaths = new Set<string>([NEUTRON_PACKAGE_RECORD_PATH]);
  const packageIdentity = parsePackageIdentity(
    record.package,
    context,
    claimedPaths,
  );
  const license = parseLicense(record.license, context?.files, claimedPaths);
  const source = parseSource(record.source, context?.files, claimedPaths);
  const dependencies = parseDependencies(
    record.dependencies,
    context?.manifest,
  );
  const notices = parseNotices(record.notices, context?.files, claimedPaths);
  const memory = parseMemory(record.memory, context, claimedPaths);
  const build = parseBuild(record.build);

  const result: NeutronPackageRecordV1 = Object.freeze({
    format: 1 as const,
    ...(features === undefined ? {} : { features }),
    package: packageIdentity,
    license,
    source,
    dependencies,
    notices,
    memory,
    build,
  });
  if (
    neutronPackageRecordArchiveOnlyPaths(result).length > 0 &&
    !features?.includes(NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE)
  ) {
    throw new Error(
      `features must include ${NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE} when the record references archive-only paths`,
    );
  }
  return result;
}

function parseFeatures(
  value: unknown,
): readonly NeutronPackageRecordFeatureV1[] {
  const rawFeatures = expectBoundedArray(
    value,
    "features",
    1,
    NEUTRON_PACKAGE_RECORD_LIMITS.features,
  );
  const features = rawFeatures.map((feature, index) => {
    if (feature !== NEUTRON_PACKAGE_ARCHIVE_ONLY_FEATURE) {
      throw new Error(`features[${index}] is unknown`);
    }
    return feature;
  });
  for (let index = 1; index < features.length; index += 1) {
    if (
      compareCanonicalText(features[index - 1]!, features[index]!) >= 0
    ) {
      throw new Error("features must be unique and canonically ordered");
    }
  }
  return Object.freeze(features);
}

function parsePackageIdentity(
  value: unknown,
  context: NeutronPackageRecordContext | undefined,
  claimedPaths: Set<string>,
): NeutronPackageRecordV1["package"] {
  const object = expectObject(value, "package");
  expectExactKeys(object, ["id", "manifest", "version"], "package");
  if (!isValidAppId(object.id)) {
    throw new Error("package.id is invalid");
  }
  assertAppVersion(object.version, "package.version");
  if (context !== undefined && object.id !== context.manifest.id) {
    throw new Error(
      `package.id ${object.id} does not match neutron.json id ${context.manifest.id}`,
    );
  }
  if (context !== undefined && object.version !== context.manifest.version) {
    throw new Error(
      `package.version ${object.version} does not match neutron.json version ${context.manifest.version}`,
    );
  }
  const manifest = parseEmbeddedFile(
    object.manifest,
    "package.manifest",
    context?.files,
    claimedPaths,
    {
      exactPath: "neutron.json",
      maximumBytes: NEUTRON_PACKAGE_RECORD_LIMITS.jsonBytes * 4,
    },
  );
  return Object.freeze({
    id: object.id,
    version: object.version,
    manifest,
  });
}

function parseLicense(
  value: unknown,
  files: Readonly<Record<string, Uint8Array>> | undefined,
  claimedPaths: Set<string>,
): NeutronPackageLicenseV1 {
  const object = expectObject(value, "license");
  expectExactKeys(object, ["id", "texts"], "license");
  const id = parseLicenseId(object.id, "license.id");
  const rawTexts = expectBoundedArray(
    object.texts,
    "license.texts",
    1,
    NEUTRON_PACKAGE_RECORD_LIMITS.licenseTexts,
  );
  const licenseIds = new Set<string>();
  const texts = rawTexts.map((rawText, index) => {
    const objectText = expectObject(rawText, `license.texts[${index}]`);
    expectExactKeys(
      objectText,
      ["bytes", "id", "path", "sha256"],
      `license.texts[${index}]`,
    );
    const textId = parseLicenseId(
      objectText.id,
      `license.texts[${index}].id`,
    );
    if (licenseIds.has(textId)) {
      throw new Error(`license.texts contains duplicate id ${textId}`);
    }
    licenseIds.add(textId);
    const file = parseEmbeddedFile(
      objectText,
      `license.texts[${index}]`,
      files,
      claimedPaths,
      {
        requiredPrefix: "legal/",
        allowedExtraKeys: ["id"],
        maximumBytes: NEUTRON_PACKAGE_RECORD_LIMITS.licenseTextBytes,
      },
    );
    return Object.freeze({ id: textId, ...file });
  });
  if (!licenseIds.has(id)) {
    throw new Error("license.texts does not include the governing license.id");
  }
  return Object.freeze({ id, texts: Object.freeze(texts) });
}

function parseSource(
  value: unknown,
  files: Readonly<Record<string, Uint8Array>> | undefined,
  claimedPaths: Set<string>,
): NeutronPackageSourceOfferV1 {
  const object = expectObject(value, "source");
  if (object.kind === "status") {
    expectExactKeys(object, ["kind", "status"], "source");
    if (
      object.status !== "not-provided" &&
      object.status !== "not-required" &&
      object.status !== "unknown"
    ) {
      throw new Error(
        "source.status must be not-provided, not-required, or unknown",
      );
    }
    return Object.freeze({
      kind: "status" as const,
      status: object.status,
    });
  }
  const revision = parseUntrustedText(
    object.revision,
    "source.revision",
    NEUTRON_PACKAGE_RECORD_LIMITS.sourceRevisionCodePoints,
  );
  assertPublicMetadataText(revision, "source.revision");
  if (object.kind === "embedded") {
    expectExactKeys(
      object,
      ["bytes", "kind", "path", "revision", "sha256"],
      "source",
    );
    const file = parseEmbeddedFile(object, "source", files, claimedPaths, {
      exactPath: NEUTRON_APP_SOURCE_SNAPSHOT_PATH,
      allowedExtraKeys: ["kind", "revision"],
      maximumBytes: NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.encodedBytes,
    });
    return Object.freeze({ kind: "embedded" as const, revision, ...file });
  }
  if (object.kind === "https") {
    expectExactKeys(
      object,
      ["bytes", "kind", "revision", "sha256", "url"],
      "source",
    );
    const url = parseHttpsUrl(object.url, "source.url");
    const sha256 = parseSha256(object.sha256, "source.sha256");
    const bytes = parsePositiveSafeInteger(
      object.bytes,
      "source.bytes",
      NEUTRON_PACKAGE_RECORD_LIMITS.declaredSourceBytes,
    );
    return Object.freeze({
      kind: "https" as const,
      revision,
      url,
      sha256,
      bytes,
    });
  }
  throw new Error("source.kind must be embedded, https, or status");
}

function parseDependencies(
  value: unknown,
  manifest: NeutronPackageRecordContext["manifest"] | undefined,
): readonly NeutronPackageDependencyV1[] {
  const values = expectBoundedArray(
    value,
    "dependencies",
    0,
    NEUTRON_PACKAGE_RECORD_LIMITS.dependencies,
  );
  let previousAlias: string | undefined;
  const dependencies = values.map((rawDependency, index) => {
    const label = `dependencies[${index}]`;
    const object = expectObject(rawDependency, label);
    expectExactKeys(
      object,
      ["alias", "app", "functions", "min_version"],
      label,
    );
    if (
      typeof object.alias !== "string" ||
      !DEPENDENCY_ALIAS_PATTERN.test(object.alias)
    ) {
      throw new Error(`${label}.alias is invalid`);
    }
    if (
      previousAlias !== undefined &&
      compareCanonicalText(previousAlias, object.alias) >= 0
    ) {
      throw new Error(
        "dependencies aliases must be unique and canonically ordered",
      );
    }
    previousAlias = object.alias;
    if (!isValidAppId(object.app)) {
      throw new Error(`${label}.app is invalid`);
    }
    assertAppVersion(object.min_version, `${label}.min_version`);
    const functions = expectBoundedArray(
      object.functions,
      `${label}.functions`,
      1,
      NEUTRON_PACKAGE_RECORD_LIMITS.dependencyFunctions,
    );
    let previousMethod: string | undefined;
    const normalizedFunctions = functions.map((method, methodIndex) => {
      if (typeof method !== "string" || !METHOD_NAME_PATTERN.test(method)) {
        throw new Error(`${label}.functions[${methodIndex}] is invalid`);
      }
      if (
        previousMethod !== undefined &&
        compareCanonicalText(previousMethod, method) >= 0
      ) {
        throw new Error(
          `${label}.functions must be unique and canonically ordered`,
        );
      }
      previousMethod = method;
      return method;
    });
    return Object.freeze({
      alias: object.alias,
      app: object.app,
      min_version: object.min_version,
      functions: Object.freeze(normalizedFunctions),
    });
  });

  if (manifest !== undefined) {
    const expectedDependencies = normalizeManifestDependencies(manifest);
    const expectedAliases = Object.keys(expectedDependencies).sort(
      compareCanonicalText,
    );
    if (dependencies.length !== expectedAliases.length) {
      throw new Error("dependencies do not match neutron.json");
    }
    for (let index = 0; index < dependencies.length; index += 1) {
      const dependency = dependencies[index]!;
      const expectedAlias = expectedAliases[index]!;
      const expected = expectedDependencies[expectedAlias]!;
      if (
        dependency.alias !== expectedAlias ||
        dependency.app !== expected.app ||
        dependency.min_version !== expected.min_version ||
        dependency.functions.length !== expected.functions.length ||
        dependency.functions.some(
          (method, methodIndex) => method !== expected.functions[methodIndex],
        )
      ) {
        throw new Error("dependencies do not match neutron.json");
      }
    }
  }
  return Object.freeze(dependencies);
}

function parseNotices(
  value: unknown,
  files: Readonly<Record<string, Uint8Array>> | undefined,
  claimedPaths: Set<string>,
): readonly NeutronPackageEmbeddedFileV1[] {
  const values = expectBoundedArray(
    value,
    "notices",
    0,
    NEUTRON_PACKAGE_RECORD_LIMITS.notices,
  );
  const notices = values.map((notice, index) => {
    return parseEmbeddedFile(
      notice,
      `notices[${index}]`,
      files,
      claimedPaths,
      {
        requiredPrefix: "legal/",
        maximumBytes: NEUTRON_PACKAGE_RECORD_LIMITS.noticeBytes,
      },
    );
  });
  assertCanonicalPathOrder(notices, "notices");
  return Object.freeze(notices);
}

function parseMemory(
  value: unknown,
  context: NeutronPackageRecordContext | undefined,
  claimedPaths: Set<string>,
): NeutronPackageRecordV1["memory"] {
  const hasManagedMemory =
    context === undefined
      ? undefined
      : Object.keys(context.manifest.memory ?? {}).length > 0;
  if (hasManagedMemory === false) {
    if (value !== null) {
      throw new Error(
        "memory must be null when neutron.json declares no managed-memory roots",
      );
    }
    return null;
  }
  if (value === null) {
    if (hasManagedMemory === undefined) return null;
    throw new Error(
      "memory must bind neutron.lock.json when neutron.json declares managed-memory roots",
    );
  }
  const object = expectObject(value, "memory");
  expectExactKeys(object, ["lock"], "memory");
  const lock = parseEmbeddedFile(
    object.lock,
    "memory.lock",
    context?.files,
    claimedPaths,
    {
      exactPath: "neutron.lock.json",
      maximumBytes: NEUTRON_PACKAGE_RECORD_LIMITS.jsonBytes * 4,
    },
  );
  return Object.freeze({ lock });
}

function parseBuild(value: unknown): NeutronPackageRecordV1["build"] {
  const object = expectObject(value, "build");
  expectExactKeys(object, ["commands", "inputs"], "build");
  const rawInputs = expectBoundedArray(
    object.inputs,
    "build.inputs",
    0,
    NEUTRON_PACKAGE_RECORD_LIMITS.buildInputs,
  );
  const inputPaths = new Set<string>();
  const inputs = rawInputs.map((rawInput, index) => {
    const label = `build.inputs[${index}]`;
    const input = expectObject(rawInput, label);
    expectExactKeys(input, ["bytes", "path", "sha256"], label);
    const path = parseSafeSourcePath(input.path, `${label}.path`);
    if (inputPaths.has(path)) {
      throw new Error(`build.inputs contains duplicate path ${path}`);
    }
    inputPaths.add(path);
    const sha256 = parseSha256(input.sha256, `${label}.sha256`);
    const bytes = parsePositiveSafeInteger(
      input.bytes,
      `${label}.bytes`,
      NEUTRON_PACKAGE_RECORD_LIMITS.declaredSourceBytes,
    );
    return Object.freeze({ path, sha256, bytes });
  });
  assertCanonicalPathOrder(inputs, "build.inputs");

  const rawCommands = expectBoundedArray(
    object.commands,
    "build.commands",
    0,
    NEUTRON_PACKAGE_RECORD_LIMITS.buildCommands,
  );
  const commands = rawCommands.map((rawCommand, index) => {
    const label = `build.commands[${index}]`;
    const command = expectObject(rawCommand, label);
    expectExactKeys(command, ["argv", "cwd", "purpose"], label);
    const purpose = parseCommandPurpose(
      command.purpose,
      `${label}.purpose`,
    );
    const cwd = parseSourceCwd(command.cwd, `${label}.cwd`);
    const rawArgv = expectBoundedArray(
      command.argv,
      `${label}.argv`,
      1,
      NEUTRON_PACKAGE_RECORD_LIMITS.commandArguments,
    );
    const argv = rawArgv.map((argument, argumentIndex) => {
      const argumentLabel = `${label}.argv[${argumentIndex}]`;
      const parsed = parseUntrustedText(
        argument,
        argumentLabel,
        NEUTRON_PACKAGE_RECORD_LIMITS.commandArgumentCodePoints,
      );
      assertPublicCommandArgument(parsed, argumentLabel);
      return parsed;
    });
    return Object.freeze({ purpose, cwd, argv: Object.freeze(argv) });
  });
  return Object.freeze({
    inputs: Object.freeze(inputs),
    commands: Object.freeze(commands),
  });
}

type EmbeddedFileOptions = Readonly<{
  exactPath?: string;
  requiredPrefix?: string;
  allowedExtraKeys?: readonly string[];
  maximumBytes: number;
}>;

function parseEmbeddedFile(
  value: unknown,
  label: string,
  files: Readonly<Record<string, Uint8Array>> | undefined,
  claimedPaths: Set<string>,
  options: EmbeddedFileOptions,
): NeutronPackageEmbeddedFileV1 {
  const object = expectObject(value, label);
  expectExactKeys(
    object,
    ["bytes", "path", "sha256", ...(options.allowedExtraKeys ?? [])],
    label,
  );
  const path = parseSafePackagePath(object.path, `${label}.path`);
  if (options.exactPath !== undefined && path !== options.exactPath) {
    throw new Error(`${label}.path must be ${options.exactPath}`);
  }
  if (
    options.requiredPrefix !== undefined &&
    !path.startsWith(options.requiredPrefix)
  ) {
    throw new Error(`${label}.path must be under ${options.requiredPrefix}`);
  }
  if (path === NEUTRON_PACKAGE_RECORD_PATH) {
    throw new Error(`${label}.path cannot reference the package record itself`);
  }
  if (claimedPaths.has(path)) {
    throw new Error(`embedded file path ${path} is referenced more than once`);
  }
  claimedPaths.add(path);
  const sha256 = parseSha256(object.sha256, `${label}.sha256`);
  const bytes = parsePositiveSafeInteger(
    object.bytes,
    `${label}.bytes`,
    options.maximumBytes,
  );
  if (files === undefined) {
    return Object.freeze({ path, sha256, bytes });
  }
  if (!Object.hasOwn(files, path)) {
    throw new Error(`${label}.path ${path} is missing from the package`);
  }
  const content = files[path];
  if (!(content instanceof Uint8Array)) {
    throw new Error(`${label}.path ${path} is not stored as bytes`);
  }
  if (content.byteLength !== bytes) {
    throw new Error(
      `${label}.bytes ${bytes} does not match ${path} byte length ${content.byteLength}`,
    );
  }
  const actualSha256 = hashContent(content);
  if (actualSha256 !== sha256) {
    throw new Error(`${label}.sha256 does not match ${path}`);
  }
  return Object.freeze({ path, sha256, bytes });
}

function parseSafePackagePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const path = parseUntrustedText(value, label, Number.MAX_SAFE_INTEGER);
  if (textEncoder.encode(path).byteLength > NEUTRON_PACKAGE_RECORD_LIMITS.pathBytes) {
    throw new Error(
      `${label} exceeds the ${NEUTRON_PACKAGE_RECORD_LIMITS.pathBytes}-byte limit`,
    );
  }
  assertSafeRelativeAssetPath(path, label);
  if (/[\s%?#]/u.test(path)) {
    throw new Error(`${label} contains an HTTP-ambiguous character`);
  }
  return path;
}

function parseSafeSourcePath(value: unknown, label: string): string {
  return parseSafePackagePath(value, label);
}

function parseSourceCwd(value: unknown, label: string): string {
  if (value === ".") return ".";
  return parseSafeSourcePath(value, label);
}

function parseLicenseId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length >
      NEUTRON_PACKAGE_RECORD_LIMITS.licenseIdCodePoints ||
    !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseCommandPurpose(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    Array.from(value).length >
      NEUTRON_PACKAGE_RECORD_LIMITS.commandPurposeCodePoints ||
    !/^[a-z][a-z0-9_-]*$/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseHttpsUrl(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length >
      NEUTRON_PACKAGE_RECORD_LIMITS.sourceUrlCharacters
  ) {
    throw new Error(`${label} is invalid`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `${label} must be an HTTPS URL without credentials, query, or fragment`,
    );
  }
  assertPublicMetadataText(value, label);
  return value;
}

function assertPublicCommandArgument(value: string, label: string): void {
  assertPublicMetadataText(value, label);
  if (LOCAL_ABSOLUTE_PATH_PATTERN.test(value)) {
    throw new Error(`${label} must not contain a machine-local absolute path`);
  }
  if (
    DEPLOYMENT_ARGUMENT_PATTERN.test(value) ||
    DEPLOYMENT_PRINCIPAL_PATTERN.test(value)
  ) {
    throw new Error(`${label} must not contain deployment authority or identity`);
  }
}

function assertPublicMetadataText(value: string, label: string): void {
  if (PRIVATE_METADATA_PATTERN.test(value)) {
    throw new Error(`${label} must not contain credentials or private material`);
  }
}

function parseSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function parsePositiveSafeInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function parseUntrustedText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  const normalized = normalizeUntrustedText(value, label, {
    maximumLength,
  });
  if (normalized !== value) {
    throw new Error(`${label} must use Unicode NFC`);
  }
  return normalized;
}

function expectObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new Error(`${label} has unknown field ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} is missing field ${key}`);
    }
  }
}

function expectBoundedArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new Error(`${label} must contain ${minimum}-${maximum} entries`);
  }
  return value;
}

function assertCanonicalPathOrder(
  values: readonly Readonly<{ path: string }>[],
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (
      compareCanonicalText(values[index - 1]!.path, values[index]!.path) >= 0
    ) {
      throw new Error(`${label} paths must be unique and canonically ordered`);
    }
  }
}

/**
 * JSON.parse keeps the last duplicate member. Reject duplicates first so every
 * implementation sees one unambiguous signed/digest-bound record.
 */
function assertNoDuplicateJsonObjectKeys(text: string): void {
  let index = 0;

  const skipWhitespace = (): void => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };

  const parseStringToken = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        return JSON.parse(text.slice(start, index)) as string;
      }
    }
    throw new Error("record contains an unterminated JSON string");
  };

  const parseValue = (): void => {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      parseObject();
      return;
    }
    if (character === "[") {
      parseArray();
      return;
    }
    if (character === '"') {
      parseStringToken();
      return;
    }
    while (
      index < text.length &&
      !/[\s,\]}]/u.test(text[index] ?? "")
    ) {
      index += 1;
    }
  };

  const parseObject = (): void => {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = parseStringToken();
      if (keys.has(key)) {
        throw new Error(`record contains duplicate JSON field ${key}`);
      }
      keys.add(key);
      skipWhitespace();
      index += 1; // JSON.parse already proved this is a colon.
      parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      index += 1; // JSON.parse already proved this is a comma.
    }
  };

  const parseArray = (): void => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      index += 1; // JSON.parse already proved this is a comma.
    }
  };

  parseValue();
}

function invalidRecord(message: string, cause?: unknown): Error {
  return new Error(`Invalid ${NEUTRON_PACKAGE_RECORD_PATH}: ${message}`, {
    ...(cause === undefined ? {} : { cause }),
  });
}
