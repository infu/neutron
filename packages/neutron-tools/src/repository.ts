import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { isValidAppId } from "./app_ids.ts";
import { normalizeUntrustedText } from "./schema.ts";
import { assertAppVersion } from "./version.ts";

const KIB = 1024;
const MIB = 1024 * KIB;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const NEUTRON_REPOSITORY_PROTOCOL = "neutron-repo-v1" as const;
export const REPOSITORY_PENDING_STORAGE_KEY =
  "neutron.repository-setup.v1" as const;

export const REPOSITORY_LIMITS = Object.freeze({
  providerFragmentBytes: 512,
  internalFragmentBytes: 768,
  pendingSetupLifetimeMs: 60 * 60 * 1000,
  repositoryNameCodePoints: 120,
  providerNameCodePoints: 120,
  manifestNameCodePoints: 120,
  publisherNameCodePoints: 120,
  descriptionCodePoints: 1000,
  externalUrlCharacters: 2048,
  releaseJsonBytes: 16 * KIB,
  metadataJsonBytes: 256 * KIB,
  manifestJsonBytes: 256 * KIB,
  manifestsPerIndex: 256,
  packagesPerManifest: 64,
  queryChunkBytes: MIB,
  packageBytes: 32 * MIB,
  packageChunks: 32,
  manifestPackageBytes: 64 * MIB,
  concurrentReads: 4,
  archiveEntries: 4096,
  manifestArchiveEntries: 16384,
  decodedArchiveEntryBytes: 16 * MIB,
  decodedPackageBytes: 64 * MIB,
  decodedManifestBytes: 128 * MIB,
  archivePathBytes: 512,
} as const);

export type RepositoryCertifiedBlob =
  | Uint8Array
  | ArrayBuffer
  | ArrayLike<number>;

export type RepositoryCertifiedValue = {
  content: RepositoryCertifiedBlob;
  chunks: bigint | number;
};

export type RepositoryCertifiedRead = {
  certificate: RepositoryCertifiedBlob;
  witness: RepositoryCertifiedBlob;
  asset: readonly RepositoryCertifiedValue[];
};

export type RepositoryReadRequest = { index: bigint };
export type RepositoryManifestReadRequest = {
  id: string;
  index: bigint;
};
export type RepositoryPackageReadRequest = {
  sha256: string;
  index: bigint;
};

export type RepositoryActor = {
  repo_info(input: RepositoryReadRequest): Promise<RepositoryCertifiedRead>;
  repo_manifests(
    input: RepositoryReadRequest,
  ): Promise<RepositoryCertifiedRead>;
  repo_manifest(
    input: RepositoryManifestReadRequest,
  ): Promise<RepositoryCertifiedRead>;
  repo_package(
    input: RepositoryPackageReadRequest,
  ): Promise<RepositoryCertifiedRead>;
};

/** Fixed v1 interface. Repository data never supplies method names or Candid. */
export const repositoryIdlFactory = ({ IDL: candid }: { IDL: typeof IDL }) => {
  const CertifiedValue = candid.Record({
    content: candid.Vec(candid.Nat8),
    chunks: candid.Nat,
  });
  const CertifiedRead = candid.Record({
    certificate: candid.Vec(candid.Nat8),
    witness: candid.Vec(candid.Nat8),
    asset: candid.Opt(CertifiedValue),
  });
  return candid.Service({
    repo_info: candid.Func(
      [candid.Record({ index: candid.Nat })],
      [CertifiedRead],
      ["query"],
    ),
    repo_manifests: candid.Func(
      [candid.Record({ index: candid.Nat })],
      [CertifiedRead],
      ["query"],
    ),
    repo_manifest: candid.Func(
      [candid.Record({ id: candid.Text, index: candid.Nat })],
      [CertifiedRead],
      ["query"],
    ),
    repo_package: candid.Func(
      [candid.Record({ sha256: candid.Text, index: candid.Nat })],
      [CertifiedRead],
      ["query"],
    ),
  });
};

export type RepositoryProvider = {
  name: string;
  description?: string;
  website?: string;
  terms?: string;
  privacy?: string;
  support?: string;
};

export type RepositoryInfo = {
  protocol: typeof NEUTRON_REPOSITORY_PROTOCOL;
  name: string;
  description?: string;
  provider: RepositoryProvider;
};

export type RepositoryPublisher = {
  name: string;
  website?: string;
};

export type RepositoryManifestPackage = {
  id: string;
  version: number;
  sha256: string;
  size: number;
  publisher?: RepositoryPublisher;
  source?: string;
};

export type RepositoryManifest = {
  protocol: typeof NEUTRON_REPOSITORY_PROTOCOL;
  id: string;
  revision: number;
  name: string;
  description?: string;
  packages: RepositoryManifestPackage[];
};

export type RepositoryManifestSummary = {
  id: string;
  revision: number;
  name: string;
  description?: string;
  digest: string;
  package_count: number;
};

export type RepositoryManifestIndex = {
  protocol: typeof NEUTRON_REPOSITORY_PROTOCOL;
  manifests: RepositoryManifestSummary[];
};

/** The latest immutable package advertised for one app by an update source. */
export type RepositoryReleaseRecord = {
  protocol: typeof NEUTRON_REPOSITORY_PROTOCOL;
  id: string;
  version: number;
  sha256: string;
  size: number;
};

export type RepositorySetupReference = {
  repo: string;
  manifest: string;
  digest: string;
};

export type ParseRepositorySetupUrlOptions = {
  allowLoopbackHttp?: boolean;
};

export type PendingRepositorySetup = {
  reference: RepositorySetupReference;
  capturedAt: number;
};

export type RepositoryStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type RepositoryLocation = { href: string; hash: string };

export type RepositoryHistory = {
  readonly state?: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
};

export type CaptureRepositorySetupInput = {
  mode: "provider" | "internal";
  location: RepositoryLocation;
  storage: RepositoryStorage;
  history: RepositoryHistory;
  now?: number;
};

export type CaptureRepositorySetupResult =
  | { status: "none" }
  | {
      status: "captured";
      reference: RepositorySetupReference;
      cleanUrl: string;
      stripped: boolean;
      stripError?: unknown;
    }
  | {
      status: "invalid";
      error: RepositoryProtocolError;
      cleanUrl: string;
      stripped: boolean;
      stripError?: unknown;
      retireError?: unknown;
    }
  | {
      status: "storage_error";
      reference: RepositorySetupReference;
      error: unknown;
    };

export type RepositoryProtocolErrorCode =
  | "invalid_fragment"
  | "invalid_principal"
  | "invalid_manifest_id"
  | "invalid_digest"
  | "invalid_schema"
  | "size_limit"
  | "invalid_storage"
  | "invalid_url";

export class RepositoryProtocolError extends Error {
  readonly code: RepositoryProtocolErrorCode;

  constructor(
    code: RepositoryProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryProtocolError";
    this.code = code;
  }
}

const MANIFEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RESERVED_APP_IDS = new Set(["__proto__", "constructor", "prototype"]);
const SETUP_KEYS = new Set(["repo", "manifest", "digest"]);
// The removed bearer key remains reserved only so stale links are rejected and
// stripped instead of leaving obsolete secret material in the address bar.
const RESERVED_FRAGMENT_KEYS = new Set([...SETUP_KEYS, "claim"]);
const MANAGEMENT_CANISTER = "aaaaa-aa";
const ANONYMOUS_PRINCIPAL = "2vxsx-fae";

export function repositoryInfoPath(): "/repo/v1/info.json" {
  return "/repo/v1/info.json";
}

export function repositoryManifestIndexPath(): "/repo/v1/manifests.json" {
  return "/repo/v1/manifests.json";
}

export function repositoryManifestPath(manifestId: string): string {
  return `/repo/v1/manifests/${validateManifestId(manifestId)}.json`;
}

export function repositoryReleasePath(appId: string): string {
  return `/repo/v1/releases/${validateAppId(appId, true)}.json`;
}

export function repositoryPackagePath(digest: string): string {
  return `/repo/v1/packages/${validateDigest(digest)}.neutron`;
}

export function parseRepositoryReleaseRecord(
  value: unknown,
): RepositoryReleaseRecord {
  const input = parseBoundedJson(
    value,
    "repository release record",
    REPOSITORY_LIMITS.releaseJsonBytes,
  );
  assertNoDuplicateTopLevelJsonKeys(value, "repository release record");
  const record = exactRecord(
    input,
    "repository release record",
    ["protocol", "id", "version", "sha256", "size"],
    [],
  );
  assertProtocol(record.protocol, "repository release record");
  const id = validateAppId(record.id, true);
  let version: number;
  try {
    assertAppVersion(record.version, `Release '${id}' version`);
    version = record.version;
  } catch (cause) {
    schemaError(`Release '${id}' has an invalid version`, cause);
  }
  return {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id,
    version,
    sha256: validateDigest(record.sha256),
    size: safeInteger(
      record.size,
      `release '${id}' size`,
      1,
      REPOSITORY_LIMITS.packageBytes,
    ),
  };
}

export function parseRepositoryInfo(value: unknown): RepositoryInfo {
  const input = parseBoundedJson(
    value,
    "repository info",
    REPOSITORY_LIMITS.metadataJsonBytes,
  );
  const record = exactRecord(
    input,
    "repository info",
    ["protocol", "name", "provider"],
    ["description"],
  );
  assertProtocol(record.protocol, "repository info");
  const providerRecord = exactRecord(
    record.provider,
    "repository provider",
    ["name"],
    ["description", "website", "terms", "privacy", "support"],
  );
  const provider: RepositoryProvider = {
    name: displayText(
      providerRecord.name,
      "repository provider name",
      REPOSITORY_LIMITS.providerNameCodePoints,
    ),
  };
  assignOptionalDescription(provider, providerRecord.description, "provider");
  for (const field of ["website", "terms", "privacy", "support"] as const) {
    const normalized = optionalHttpsUrl(
      providerRecord[field],
      `repository provider ${field}`,
    );
    if (normalized !== undefined) provider[field] = normalized;
  }
  const result: RepositoryInfo = {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    name: displayText(
      record.name,
      "repository name",
      REPOSITORY_LIMITS.repositoryNameCodePoints,
    ),
    provider,
  };
  assignOptionalDescription(result, record.description, "repository");
  return result;
}

export function parseRepositoryManifest(value: unknown): RepositoryManifest {
  const input = parseBoundedJson(
    value,
    "repository setup manifest",
    REPOSITORY_LIMITS.manifestJsonBytes,
  );
  const record = exactRecord(
    input,
    "repository setup manifest",
    ["protocol", "id", "revision", "name", "packages"],
    ["description"],
  );
  assertProtocol(record.protocol, "repository setup manifest");
  const id = validateManifestId(record.id);
  const packagesInput = boundedArray(
    record.packages,
    "repository setup manifest packages",
    1,
    REPOSITORY_LIMITS.packagesPerManifest,
  );
  const ids = new Set<string>();
  const digests = new Set<string>();
  let totalBytes = 0;
  const packages = packagesInput.map((entry, index) => {
    const parsed = parseManifestPackage(entry, index);
    if (ids.has(parsed.id)) {
      schemaError(`Repository setup manifest repeats app id '${parsed.id}'`);
    }
    if (digests.has(parsed.sha256)) {
      schemaError(
        `Repository setup manifest repeats package digest '${parsed.sha256}'`,
      );
    }
    ids.add(parsed.id);
    digests.add(parsed.sha256);
    if (totalBytes > REPOSITORY_LIMITS.manifestPackageBytes - parsed.size) {
      throw new RepositoryProtocolError(
        "size_limit",
        `Repository setup manifest exceeds ${REPOSITORY_LIMITS.manifestPackageBytes} package bytes`,
      );
    }
    totalBytes += parsed.size;
    return parsed;
  });
  const result: RepositoryManifest = {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id,
    revision: safeInteger(record.revision, "manifest revision", 0),
    name: displayText(
      record.name,
      "manifest name",
      REPOSITORY_LIMITS.manifestNameCodePoints,
    ),
    packages,
  };
  assignOptionalDescription(result, record.description, "manifest");
  return result;
}

export function parseRepositoryManifestIndex(
  value: unknown,
): RepositoryManifestIndex {
  const input = parseBoundedJson(
    value,
    "repository manifest index",
    REPOSITORY_LIMITS.metadataJsonBytes,
  );
  const record = exactRecord(
    input,
    "repository manifest index",
    ["protocol", "manifests"],
    [],
  );
  assertProtocol(record.protocol, "repository manifest index");
  const values = boundedArray(
    record.manifests,
    "repository manifest index entries",
    0,
    REPOSITORY_LIMITS.manifestsPerIndex,
  );
  const seen = new Set<string>();
  let previous = "";
  const manifests = values.map((entry, index) => {
    const item = exactRecord(
      entry,
      `repository manifest index entry ${index}`,
      ["id", "revision", "name", "digest", "package_count"],
      ["description"],
    );
    const id = validateManifestId(item.id);
    if (seen.has(id)) schemaError(`Repository manifest index repeats '${id}'`);
    if (index > 0 && id <= previous) {
      schemaError("Repository manifest index must be sorted by manifest id");
    }
    seen.add(id);
    previous = id;
    const summary: RepositoryManifestSummary = {
      id,
      revision: safeInteger(item.revision, "manifest revision", 0),
      name: displayText(
        item.name,
        "manifest name",
        REPOSITORY_LIMITS.manifestNameCodePoints,
      ),
      digest: validateDigest(item.digest),
      package_count: safeInteger(
        item.package_count,
        "manifest package count",
        1,
        REPOSITORY_LIMITS.packagesPerManifest,
      ),
    };
    assignOptionalDescription(summary, item.description, "manifest");
    return summary;
  });
  return { protocol: NEUTRON_REPOSITORY_PROTOCOL, manifests };
}

export function serializeRepositoryInfo(value: RepositoryInfo): Uint8Array {
  return serializeValidatedJson(parseRepositoryInfo(value));
}

export function serializeRepositoryManifest(
  value: RepositoryManifest,
): Uint8Array {
  return serializeValidatedJson(parseRepositoryManifest(value));
}

export function serializeRepositoryManifestIndex(
  value: RepositoryManifestIndex,
): Uint8Array {
  return serializeValidatedJson(parseRepositoryManifestIndex(value));
}

export function serializeRepositoryReleaseRecord(
  value: RepositoryReleaseRecord,
): Uint8Array {
  return serializeValidatedJson(parseRepositoryReleaseRecord(value));
}

export function parseProviderSetupFragment(
  fragment: string,
): RepositorySetupReference {
  const params = parseFragment(
    fragment,
    SETUP_KEYS,
    REPOSITORY_LIMITS.providerFragmentBytes,
    "provider setup",
  );
  return parseSetupParameters(params);
}

/**
 * Parses a complete, untrusted repository-setup carrier URL without contacting
 * its outer web origin. HTTPS is required except for an explicitly enabled
 * loopback HTTP carrier used by local deployments.
 */
export function parseRepositorySetupUrl(
  rawUrl: string,
  {
    allowLoopbackHttp = false,
  }: ParseRepositorySetupUrlOptions = {},
): RepositorySetupReference {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    rawUrl.length > REPOSITORY_LIMITS.externalUrlCharacters
  ) {
    throw new RepositoryProtocolError(
      "invalid_url",
      `Repository setup URL must contain at most ${REPOSITORY_LIMITS.externalUrlCharacters} characters`,
    );
  }
  const value = rawUrl.trim();
  if (value === "") {
    throw new RepositoryProtocolError(
      "invalid_url",
      "Repository setup URL is empty",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new RepositoryProtocolError(
      "invalid_url",
      "Repository setup URL must be absolute",
      { cause },
    );
  }
  if (url.href.length > REPOSITORY_LIMITS.externalUrlCharacters) {
    throw new RepositoryProtocolError(
      "invalid_url",
      `Repository setup URL must contain at most ${REPOSITORY_LIMITS.externalUrlCharacters} characters`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new RepositoryProtocolError(
      "invalid_url",
      "Repository setup URL cannot contain credentials",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      allowLoopbackHttp &&
      isLoopbackHostname(url.hostname)
    )
  ) {
    throw new RepositoryProtocolError(
      "invalid_url",
      "Repository setup URL must use HTTPS",
    );
  }
  for (const key of RESERVED_FRAGMENT_KEYS) {
    if (url.searchParams.has(key)) {
      throw new RepositoryProtocolError(
        "invalid_url",
        `Repository setup URL must keep '${key}' in its fragment`,
      );
    }
  }
  return parseProviderSetupFragment(url.hash);
}

export function serializeProviderSetupFragment(
  reference: RepositorySetupReference,
): string {
  const normalized = normalizeSetupReference(reference);
  const params = new URLSearchParams();
  params.set("repo", normalized.repo);
  params.set("manifest", normalized.manifest);
  params.set("digest", normalized.digest);
  const fragment = `#${params.toString()}`;
  assertUtf8Limit(
    fragment,
    REPOSITORY_LIMITS.providerFragmentBytes,
    "Provider setup fragment",
  );
  return fragment;
}

export function parseInternalSetupFragment(
  fragment: string,
): RepositorySetupReference {
  const params = parseFragment(
    fragment,
    SETUP_KEYS,
    REPOSITORY_LIMITS.internalFragmentBytes,
    "internal setup handoff",
  );
  return parseSetupParameters(params);
}

export function serializeInternalSetupFragment(
  reference: RepositorySetupReference,
): string {
  const setup = normalizeSetupReference(reference);
  const params = new URLSearchParams();
  params.set("repo", setup.repo);
  params.set("manifest", setup.manifest);
  params.set("digest", setup.digest);
  const fragment = `#${params.toString()}`;
  assertUtf8Limit(
    fragment,
    REPOSITORY_LIMITS.internalFragmentBytes,
    "Internal setup handoff fragment",
  );
  return fragment;
}

export function captureRepositorySetupFragment({
  mode,
  location,
  storage,
  history,
  now = Date.now(),
}: CaptureRepositorySetupInput): CaptureRepositorySetupResult {
  const fragment = location.hash;
  if (!fragment || !hasReservedFragmentKey(fragment)) return { status: "none" };
  const cleanUrl = withoutFragment(location.href);
  let reference: RepositorySetupReference;
  try {
    reference =
      mode === "provider"
        ? parseProviderSetupFragment(fragment)
        : parseInternalSetupFragment(fragment);
  } catch (error) {
    const protocolError = asProtocolError(error, "invalid_fragment");
    const stripped = tryStrip(history, cleanUrl);
    let retireError: unknown;
    if (stripped.ok) {
      try {
        removePendingRepositorySetup(storage);
      } catch (error) {
        retireError = error;
      }
    }
    return {
      status: "invalid",
      error: protocolError,
      cleanUrl,
      stripped: stripped.ok,
      ...("error" in stripped ? { stripError: stripped.error } : {}),
      ...(retireError === undefined ? {} : { retireError }),
    };
  }

  try {
    writePendingRepositorySetup(storage, { reference, capturedAt: now });
  } catch (error) {
    return { status: "storage_error", reference, error };
  }
  const stripped = tryStrip(history, cleanUrl);
  return {
    status: "captured",
    reference,
    cleanUrl,
    stripped: stripped.ok,
    ...("error" in stripped ? { stripError: stripped.error } : {}),
  };
}

export function readPendingRepositorySetup(
  storage: RepositoryStorage,
  now = Date.now(),
): PendingRepositorySetup | null {
  let raw: string | null;
  try {
    raw = storage.getItem(REPOSITORY_PENDING_STORAGE_KEY);
  } catch (cause) {
    throw new RepositoryProtocolError(
      "invalid_storage",
      "Unable to read pending repository setup",
      { cause },
    );
  }
  if (raw === null) return null;
  let pending: PendingRepositorySetup;
  try {
    pending = parsePendingRecord(JSON.parse(raw));
  } catch (cause) {
    safeRemovePending(storage);
    throw new RepositoryProtocolError(
      "invalid_storage",
      "Pending repository setup is invalid",
      { cause },
    );
  }
  if (!validAge(pending.capturedAt, now, REPOSITORY_LIMITS.pendingSetupLifetimeMs)) {
    safeRemovePending(storage);
    return null;
  }
  return pending;
}

/**
 * Trusted Kernel admission path for a setup reference that did not arrive via
 * address-bar capture. It uses the same canonical validation and storage
 * format as captureRepositorySetupFragment.
 */
export function stagePendingRepositorySetup(
  storage: RepositoryStorage,
  reference: RepositorySetupReference,
  now = Date.now(),
): PendingRepositorySetup {
  const pending = {
    reference: parseInternalSetupFragment(
      serializeInternalSetupFragment(reference),
    ),
    capturedAt: safeInteger(now, "capture time", 0),
  };
  writePendingRepositorySetup(storage, pending);
  return pending;
}

export function clearPendingRepositorySetup(storage: RepositoryStorage): void {
  removePendingRepositorySetup(storage);
}

export function appendRepositorySetupFragment(
  url: string,
  reference: RepositorySetupReference,
): string {
  return appendFragment(url, serializeProviderSetupFragment(reference));
}

export function appendInternalHandoffFragment(
  url: string,
  reference: RepositorySetupReference,
): string {
  return appendFragment(url, serializeInternalSetupFragment(reference));
}

export function validateManifestId(value: unknown): string {
  if (typeof value !== "string" || !MANIFEST_ID_PATTERN.test(value)) {
    throw new RepositoryProtocolError(
      "invalid_manifest_id",
      "Repository manifest id must match ^[a-z0-9][a-z0-9_-]{0,63}$",
    );
  }
  return value;
}

export function validateDigest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new RepositoryProtocolError(
      "invalid_digest",
      "Repository SHA-256 digest must be 64 lowercase hexadecimal characters",
    );
  }
  return value;
}

function parseManifestPackage(
  value: unknown,
  index: number,
): RepositoryManifestPackage {
  const record = exactRecord(
    value,
    `repository manifest package ${index}`,
    ["id", "version", "sha256", "size"],
    ["publisher", "source"],
  );
  const id = validateAppId(record.id);
  assertAppVersion(record.version, `Package '${id}' version`);
  const result: RepositoryManifestPackage = {
    id,
    version: record.version,
    sha256: validateDigest(record.sha256),
    size: safeInteger(
      record.size,
      `package '${id}' size`,
      1,
      REPOSITORY_LIMITS.packageBytes,
    ),
  };
  if (record.publisher !== undefined) {
    const publisherRecord = exactRecord(
      record.publisher,
      `package '${id}' publisher`,
      ["name"],
      ["website"],
    );
    const publisher: RepositoryPublisher = {
      name: displayText(
        publisherRecord.name,
        `package '${id}' publisher name`,
        REPOSITORY_LIMITS.publisherNameCodePoints,
      ),
    };
    const website = optionalHttpsUrl(
      publisherRecord.website,
      `package '${id}' publisher website`,
    );
    if (website !== undefined) publisher.website = website;
    result.publisher = publisher;
  }
  const source = optionalHttpsUrl(record.source, `package '${id}' source`);
  if (source !== undefined) result.source = source;
  return result;
}

function validateAppId(value: unknown, allowKernel = false): string {
  if (
    typeof value !== "string" ||
    !isValidAppId(value) ||
    RESERVED_APP_IDS.has(value)
  ) {
    schemaError("Repository app id is invalid");
  }
  if (!allowKernel && value === "kernel") {
    schemaError("Repository setup manifests cannot contain kernel");
  }
  return value;
}

function parseSetupParameters(params: URLSearchParams): RepositorySetupReference {
  for (const key of SETUP_KEYS) {
    if (!params.has(key)) fragmentError(`Provider setup is missing '${key}'`);
  }
  return normalizeSetupReference({
    repo: params.get("repo")!,
    manifest: params.get("manifest")!,
    digest: params.get("digest")!,
  });
}

function normalizeSetupReference(
  value: RepositorySetupReference,
): RepositorySetupReference {
  if (!isRecord(value)) fragmentError("Repository setup reference is invalid");
  exactOwnKeys(value, "repository setup reference", [...SETUP_KEYS]);
  if (typeof value.repo !== "string") {
    throw new RepositoryProtocolError(
      "invalid_principal",
      "Repository principal is invalid",
    );
  }
  let principal: Principal;
  try {
    principal = Principal.fromText(value.repo);
  } catch (cause) {
    throw new RepositoryProtocolError(
      "invalid_principal",
      "Repository principal is invalid",
      { cause },
    );
  }
  const repo = principal.toText();
  if (
    repo !== value.repo ||
    repo === MANAGEMENT_CANISTER ||
    repo === ANONYMOUS_PRINCIPAL
  ) {
    throw new RepositoryProtocolError(
      "invalid_principal",
      "Repository principal must be canonical, non-anonymous, and non-management",
    );
  }
  return {
    repo,
    manifest: validateManifestId(value.manifest),
    digest: validateDigest(value.digest),
  };
}

function parseFragment(
  fragment: string,
  allowedKeys: ReadonlySet<string>,
  maximumBytes: number,
  label: string,
): URLSearchParams {
  if (typeof fragment !== "string" || fragment === "" || fragment === "#") {
    fragmentError(`${label} fragment is empty`);
  }
  assertUtf8Limit(fragment, maximumBytes, `${label} fragment`);
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  const params = new URLSearchParams(text);
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!allowedKeys.has(key)) fragmentError(`${label} has unknown key '${key}'`);
    if (seen.has(key)) fragmentError(`${label} repeats key '${key}'`);
    seen.add(key);
  }
  if (seen.size === 0) fragmentError(`${label} fragment is empty`);
  return params;
}

function hasReservedFragmentKey(fragment: string): boolean {
  const text = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  try {
    for (const [key] of new URLSearchParams(text)) {
      if (RESERVED_FRAGMENT_KEYS.has(key)) return true;
    }
  } catch {
    return /(?:^|&)(?:repo|manifest|digest|claim)=/.test(text);
  }
  return false;
}

function parsePendingRecord(value: unknown): PendingRepositorySetup {
  const record = exactRecord(
    value,
    "pending repository setup",
    ["format", "captured_at_ms", "reference"],
    [],
  );
  if (record.format !== 1) schemaError("Pending repository setup format is invalid");
  const capturedAt = safeInteger(record.captured_at_ms, "capture time", 0);
  const referenceRecord = exactRecord(
    record.reference,
    "pending repository setup reference",
    ["repo", "manifest", "digest"],
    [],
  );
  const params = new URLSearchParams();
  for (const key of ["repo", "manifest", "digest"] as const) {
    const value = referenceRecord[key];
    if (value !== undefined) {
      if (typeof value !== "string") schemaError(`Pending '${key}' is invalid`);
      params.set(key, value);
    }
  }
  return {
    capturedAt,
    reference: parseInternalSetupFragment(`#${params.toString()}`),
  };
}

function writePendingRepositorySetup(
  storage: RepositoryStorage,
  pending: PendingRepositorySetup,
): void {
  const reference = parseInternalSetupFragment(
    serializeInternalSetupFragment(pending.reference),
  );
  const storedReference = {
    repo: reference.repo,
    manifest: reference.manifest,
    digest: reference.digest,
  };
  const capturedAt = safeInteger(pending.capturedAt, "capture time", 0);
  try {
    storage.setItem(
      REPOSITORY_PENDING_STORAGE_KEY,
      JSON.stringify({
        format: 1,
        captured_at_ms: capturedAt,
        reference: storedReference,
      }),
    );
  } catch (cause) {
    throw new RepositoryProtocolError(
      "invalid_storage",
      "Unable to store pending repository setup",
      { cause },
    );
  }
}

function removePendingRepositorySetup(storage: RepositoryStorage): void {
  try {
    storage.removeItem(REPOSITORY_PENDING_STORAGE_KEY);
  } catch (cause) {
    throw new RepositoryProtocolError(
      "invalid_storage",
      "Unable to clear pending repository setup",
      { cause },
    );
  }
}

function safeRemovePending(storage: RepositoryStorage): void {
  try {
    storage.removeItem(REPOSITORY_PENDING_STORAGE_KEY);
  } catch {
    // The original parse/read failure is more useful than a cleanup failure.
  }
}

function validAge(capturedAt: number, now: number, maximumAge: number): boolean {
  return (
    Number.isSafeInteger(now) &&
    now >= capturedAt &&
    now - capturedAt <= maximumAge
  );
}

function tryStrip(
  history: RepositoryHistory,
  cleanUrl: string,
): { ok: true } | { ok: false; error: unknown } {
  try {
    history.replaceState(history.state ?? null, "", cleanUrl);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function withoutFragment(href: string): string {
  try {
    const url = new URL(href);
    url.hash = "";
    return url.href;
  } catch (cause) {
    throw new RepositoryProtocolError(
      "invalid_url",
      "Repository setup page URL is invalid",
      { cause },
    );
  }
}

function appendFragment(urlText: string, fragment: string): string {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch (cause) {
    throw new RepositoryProtocolError("invalid_url", "Setup target URL is invalid", {
      cause,
    });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new RepositoryProtocolError(
      "invalid_url",
      "Setup target must be an HTTP(S) URL without credentials",
    );
  }
  if (url.hash !== "") {
    throw new RepositoryProtocolError(
      "invalid_url",
      "Setup target already has a fragment",
    );
  }
  for (const key of RESERVED_FRAGMENT_KEYS) {
    if (url.searchParams.has(key)) {
      throw new RepositoryProtocolError(
        "invalid_url",
        `Setup target must not contain '${key}' in its query`,
      );
    }
  }
  url.hash = fragment.slice(1);
  return url.href;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized) ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}

function parseBoundedJson(
  value: unknown,
  label: string,
  maximumBytes: number,
): unknown {
  if (value instanceof Uint8Array) {
    if (value.byteLength > maximumBytes) sizeError(label, maximumBytes);
    try {
      return JSON.parse(textDecoder.decode(value));
    } catch (cause) {
      schemaError(`${label} is not valid UTF-8 JSON`, cause);
    }
  }
  if (typeof value === "string") {
    assertUtf8Limit(value, maximumBytes, label);
    try {
      return JSON.parse(value);
    } catch (cause) {
      schemaError(`${label} is not valid JSON`, cause);
    }
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    schemaError(`${label} cannot be serialized`, cause);
  }
  if (encoded === undefined) schemaError(`${label} is invalid`);
  assertUtf8Limit(encoded!, maximumBytes, label);
  return value;
}

/**
 * JSON.parse silently keeps only the last duplicate property. Release records
 * are security-sensitive identity pointers, so reject duplicate top-level
 * fields before accepting the parsed object. Nested values are rejected by the
 * closed scalar schema, but tracking array/object depth keeps this scan exact.
 */
function assertNoDuplicateTopLevelJsonKeys(
  value: unknown,
  label: string,
): void {
  let source: string;
  if (value instanceof Uint8Array) {
    try {
      source = textDecoder.decode(value);
    } catch (cause) {
      schemaError(`${label} is not valid UTF-8 JSON`, cause);
    }
  } else if (typeof value === "string") {
    source = value;
  } else {
    return;
  }

  let objectDepth = 0;
  let arrayDepth = 0;
  let expectsKey = false;
  const keys = new Set<string>();
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') {
      const start = index;
      for (index += 1; index < source.length; index += 1) {
        const stringCharacter = source[index]!;
        if (stringCharacter === "\\") {
          index += 1;
          continue;
        }
        if (stringCharacter === '"') break;
      }
      if (objectDepth === 1 && arrayDepth === 0 && expectsKey) {
        let key: string;
        try {
          key = JSON.parse(source.slice(start, index + 1)) as string;
        } catch (cause) {
          schemaError(`${label} is not valid JSON`, cause);
        }
        if (keys.has(key)) {
          schemaError(`${label} repeats property '${key}'`);
        }
        keys.add(key);
        expectsKey = false;
      }
      continue;
    }
    if (character === "{") {
      objectDepth += 1;
      if (objectDepth === 1 && arrayDepth === 0) expectsKey = true;
    } else if (character === "}") {
      objectDepth -= 1;
    } else if (character === "[") {
      arrayDepth += 1;
    } else if (character === "]") {
      arrayDepth -= 1;
    } else if (
      character === "," &&
      objectDepth === 1 &&
      arrayDepth === 0
    ) {
      expectsKey = true;
    }
  }
}

function serializeValidatedJson(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) schemaError(`${label} must be an object`);
  exactOwnKeys(value, label, [...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      schemaError(`${label} is missing '${key}'`);
    }
  }
  return value;
}

function exactOwnKeys(
  value: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) schemaError(`${label} has unknown property '${key}'`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    schemaError(`${label} must contain between ${minimum} and ${maximum} entries`);
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
    schemaError(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function displayText(value: unknown, label: string, maximum: number): string {
  try {
    return normalizeUntrustedText(value, label, {
      minimumLength: 1,
      maximumLength: maximum,
    });
  } catch (cause) {
    schemaError(`Invalid ${label}`, cause);
  }
}

function assignOptionalDescription<T extends { description?: string }>(
  target: T,
  value: unknown,
  label: string,
): void {
  if (value === undefined) return;
  target.description = displayText(
    value,
    `${label} description`,
    REPOSITORY_LIMITS.descriptionCodePoints,
  );
}

function optionalHttpsUrl(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > REPOSITORY_LIMITS.externalUrlCharacters) {
    schemaError(`${label} is too long or not a string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    schemaError(`${label} is not an absolute URL`, cause);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.href.length > REPOSITORY_LIMITS.externalUrlCharacters
  ) {
    schemaError(`${label} must be an absolute HTTPS URL without credentials`);
  }
  return url.href;
}

function assertProtocol(value: unknown, label: string): void {
  if (value !== NEUTRON_REPOSITORY_PROTOCOL) {
    schemaError(`${label} protocol must be '${NEUTRON_REPOSITORY_PROTOCOL}'`);
  }
}

function assertUtf8Limit(value: string, maximum: number, label: string): void {
  if (textEncoder.encode(value).byteLength > maximum) sizeError(label, maximum);
}

function sizeError(label: string, maximum: number): never {
  throw new RepositoryProtocolError(
    "size_limit",
    `${label} exceeds ${maximum} UTF-8 bytes`,
  );
}

function schemaError(message: string, cause?: unknown): never {
  throw new RepositoryProtocolError("invalid_schema", message, { cause });
}

function fragmentError(message: string): never {
  throw new RepositoryProtocolError("invalid_fragment", message);
}

function asProtocolError(
  value: unknown,
  fallback: RepositoryProtocolErrorCode,
): RepositoryProtocolError {
  return value instanceof RepositoryProtocolError
    ? value
    : new RepositoryProtocolError(fallback, "Repository setup is invalid", {
        cause: value,
      });
}
