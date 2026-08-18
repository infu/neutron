import { createHash } from "node:crypto";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  assertNeutronAppSourceBuildInputs,
  decodeNeutronAppSourceSnapshot,
} from "neutron-compiler/src/source_snapshot.ts";
import {
  preparePackageInstall,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
} from "neutron-compiler/src/install.ts";
import {
  NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS,
  NEUTRON_APP_SOURCE_MEDIA_TYPE,
  NEUTRON_APP_SOURCE_TRANSPORT_LIMITS,
  neutronAppSourceArchiveFilename,
  neutronAppSourceRepositoryPath,
  type NeutronPackageBuildInputV1,
} from "neutron-tools/src/package_record.ts";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  REPOSITORY_LIMITS,
  parseRepositoryReleaseRecord,
  repositoryPackagePath,
  repositoryReleasePath,
  serializeRepositoryReleaseRecord,
  type RepositoryReleaseRecord,
} from "neutron-tools/src/repository.ts";

export const UPDATE_SOURCE_RECEIPT_PROTOCOL =
  "neutron-update-source-publish-v2" as const;
export const RELEASE_CONTENT_TYPE = "application/json; charset=utf-8";
export const PACKAGE_CONTENT_TYPE = "application/vnd.neutron.package";
export const SOURCE_CONTENT_TYPE = NEUTRON_APP_SOURCE_MEDIA_TYPE;
export const RELEASE_CACHE_CONTROL =
  "public, max-age=0, must-revalidate";
export const PACKAGE_CACHE_CONTROL =
  "public, max-age=31536000, immutable, no-transform";
export const SOURCE_CACHE_CONTROL = PACKAGE_CACHE_CONTROL;
export const PACKAGE_MAX_AGE_SECONDS = 31_536_000n;
export const SOURCE_MAX_AGE_SECONDS = PACKAGE_MAX_AGE_SECONDS;
export const RELEASE_MAX_AGE_SECONDS = 0n;
export const UPLOAD_CHUNK_BYTES = 1_800_000;
export const UPLOAD_CONCURRENCY = 4;
export const MAX_PACKAGES_PER_PUBLICATION = 20;
export const MAX_PUBLICATION_BYTES = 128 * 1024 * 1024;
export const SOURCE_UNCOMPRESSED_MAX_BYTES =
  NEUTRON_APP_SOURCE_SNAPSHOT_LIMITS.encodedBytes;
export const SOURCE_COMPRESSED_MAX_BYTES =
  NEUTRON_APP_SOURCE_TRANSPORT_LIMITS.compressedBytes;

export type HeaderField = [string, string];

export type DeclaredHostedSource = Readonly<{
  url: string;
  path: string;
  revision: string;
  sha256: string;
  size: number;
  package: Readonly<{ id: string; version: number }>;
  buildInputs: readonly NeutronPackageBuildInputV1[];
}>;

export type InspectedHostedSource = DeclaredHostedSource &
  Readonly<{
    file: string;
    bytes: Uint8Array;
  }>;

export type InspectedUpdatePackage = {
  file: string;
  bytes: Uint8Array;
  record: RepositoryReleaseRecord;
  releaseBytes: Uint8Array;
  packagePath: string;
  releasePath: string;
  hostedSource?: InspectedHostedSource;
};

export type InspectedPackageMetadata = Omit<
  InspectedUpdatePackage,
  "file" | "bytes" | "hostedSource"
> & {
  hostedSource?: DeclaredHostedSource;
};

export type PackageInspector = (
  file: string,
  bytes: Uint8Array,
) => InspectedPackageMetadata;

export function inspectUpdatePackage(
  file: string,
  bytes: Uint8Array,
): InspectedPackageMetadata {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`Package '${file}' did not contain bytes`);
  }
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > REPOSITORY_LIMITS.packageBytes
  ) {
    throw new Error(
      `Package '${file}' must be 1-${REPOSITORY_LIMITS.packageBytes} bytes`,
    );
  }

  let prepared: ReturnType<typeof preparePackageInstall>;
  try {
    prepared = preparePackageInstall(bytes, {
      limits: REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
    });
  } catch (cause) {
    throw new Error(`Package '${file}' is not a valid .neutron package`, {
      cause,
    });
  }

  const digest = sha256Hex(bytes);
  const record: RepositoryReleaseRecord = parseRepositoryReleaseRecord({
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    id: prepared.manifest.id,
    version: prepared.manifest.version,
    sha256: digest,
    size: bytes.byteLength,
  });
  const source = prepared.packageRecord?.source;
  const hostedSource =
    source?.kind === "https"
      ? declaredHostedSource({
          id: prepared.manifest.id,
          version: prepared.manifest.version,
          source,
          buildInputs: prepared.packageRecord?.build.inputs ?? [],
        })
      : undefined;
  return {
    record,
    releaseBytes: serializeRepositoryReleaseRecord(record),
    packagePath: repositoryPackagePath(digest),
    releasePath: repositoryReleasePath(record.id),
    ...(hostedSource ? { hostedSource } : {}),
  };
}

export async function inspectPackageFiles(
  files: readonly string[],
  options: {
    read?: (file: string) => Promise<Uint8Array>;
    readSource?: (file: string) => Promise<Uint8Array>;
    inspect?: PackageInspector;
  } = {},
): Promise<InspectedUpdatePackage[]> {
  if (files.length < 1) throw new Error("At least one .neutron file is required");
  if (files.length > MAX_PACKAGES_PER_PUBLICATION) {
    throw new Error(
      `One publication may contain at most ${MAX_PACKAGES_PER_PUBLICATION} packages`,
    );
  }
  const read = options.read ?? readBytes;
  const readSource =
    options.readSource ??
    ((file: string) => readBoundedBytes(file, SOURCE_COMPRESSED_MAX_BYTES));
  const inspect = options.inspect ?? inspectUpdatePackage;
  const seen = new Set<string>();
  const countedSourceDigests = new Set<string>();
  let totalBytes = 0;
  const result: InspectedUpdatePackage[] = [];

  for (const file of files) {
    if (!file.endsWith(".neutron")) {
      throw new Error(`Package '${file}' must use the .neutron extension`);
    }
    const bytes = await read(file);
    totalBytes = checkedAdd(totalBytes, bytes.byteLength);
    if (totalBytes > MAX_PUBLICATION_BYTES) {
      throw new Error(
        `Publication exceeds the ${MAX_PUBLICATION_BYTES}-byte upload limit`,
      );
    }
    const inspected = inspect(file, bytes);
    if (seen.has(inspected.record.id)) {
      throw new Error(
        `Publication repeats app id '${inspected.record.id}'`,
      );
    }
    seen.add(inspected.record.id);
    let hostedSource: InspectedHostedSource | undefined;
    if (inspected.hostedSource) {
      assertHostedSourceDeclaration(
        inspected.hostedSource,
        inspected.record.id,
        inspected.record.version,
      );
      const sourceFile = hostedSourceArtifactPath(
        file,
        inspected.hostedSource.sha256,
      );
      let sourceBytes: Uint8Array;
      try {
        sourceBytes = await readSource(sourceFile);
      } catch (cause) {
        throw new Error(
          `Unable to read Complete App Source artifact '${sourceFile}' for '${inspected.record.id}'`,
          { cause },
        );
      }
      if (!(sourceBytes instanceof Uint8Array)) {
        throw new Error(
          `Complete App Source artifact '${sourceFile}' did not contain bytes`,
        );
      }
      if (
        sourceBytes.byteLength < 1 ||
        sourceBytes.byteLength > SOURCE_COMPRESSED_MAX_BYTES
      ) {
        throw new Error(
          `Complete App Source artifact '${sourceFile}' must be 1-${SOURCE_COMPRESSED_MAX_BYTES} compressed bytes`,
        );
      }
      if (sourceBytes.byteLength !== inspected.hostedSource.size) {
        throw new Error(
          `Complete App Source artifact '${sourceFile}' has ${sourceBytes.byteLength} bytes; expected ${inspected.hostedSource.size}`,
        );
      }
      const sourceDigest = sha256Hex(sourceBytes);
      if (sourceDigest !== inspected.hostedSource.sha256) {
        throw new Error(
          `Complete App Source artifact '${sourceFile}' has digest ${sourceDigest}; expected ${inspected.hostedSource.sha256}`,
        );
      }
      if (!countedSourceDigests.has(sourceDigest)) {
        countedSourceDigests.add(sourceDigest);
        totalBytes = checkedAdd(totalBytes, sourceBytes.byteLength);
        if (totalBytes > MAX_PUBLICATION_BYTES) {
          throw new Error(
            `Publication exceeds the ${MAX_PUBLICATION_BYTES}-byte upload limit`,
          );
        }
      }
      try {
        const sourceSnapshot = new Uint8Array(
          gunzipSync(sourceBytes, {
            maxOutputLength: SOURCE_UNCOMPRESSED_MAX_BYTES,
          }),
        );
        if (
          sourceSnapshot.byteLength < 1 ||
          sourceSnapshot.byteLength > SOURCE_UNCOMPRESSED_MAX_BYTES
        ) {
          throw new Error(
            `uncompressed source must be 1-${SOURCE_UNCOMPRESSED_MAX_BYTES} bytes`,
          );
        }
        const snapshot = decodeNeutronAppSourceSnapshot(
          sourceSnapshot,
          inspected.hostedSource.package,
        );
        assertNeutronAppSourceBuildInputs(
          snapshot,
          inspected.hostedSource.buildInputs,
        );
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `Complete App Source artifact '${sourceFile}' is invalid for '${inspected.record.id}': ${detail}`,
          { cause },
        );
      }
      hostedSource = {
        ...inspected.hostedSource,
        file: sourceFile,
        bytes: sourceBytes,
      };
    }
    const { hostedSource: _declaredHostedSource, ...inspectedPackage } =
      inspected;
    result.push({
      file,
      bytes,
      ...inspectedPackage,
      ...(hostedSource ? { hostedSource } : {}),
    });
  }

  return result.sort((left, right) => left.record.id.localeCompare(right.record.id));
}

export function releaseHeaders(digest: string): HeaderField[] {
  return commonHeaders(RELEASE_CACHE_CONTROL, digest);
}

export function packageHeaders(digest: string): HeaderField[] {
  return commonHeaders(PACKAGE_CACHE_CONTROL, digest);
}

export function sourceHeaders(digest: string): HeaderField[] {
  return commonHeaders(SOURCE_CACHE_CONTROL, digest);
}

export function hostedSourceArtifactPath(
  packageFile: string,
  digest: string,
): string {
  return path.join(
    path.dirname(packageFile),
    ".neutron",
    "sources",
    neutronAppSourceArchiveFilename(digest),
  );
}

function commonHeaders(cacheControl: string, digest: string): HeaderField[] {
  hexBytes(digest);
  return [
    ["Cache-Control", cacheControl],
    ["Access-Control-Allow-Origin", "*"],
    [
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Type, ETag, IC-Certificate, IC-CertificateExpression",
    ],
    ["ETag", `"${digest}"`],
    ["X-Content-Type-Options", "nosniff"],
  ];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function hexBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Expected a lowercase SHA-256 digest");
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error("Publication size overflow");
  return sum;
}

function declaredHostedSource({
  id,
  version,
  source,
  buildInputs,
}: Readonly<{
  id: string;
  version: number;
  source: Readonly<{
    url: string;
    revision: string;
    sha256: string;
    bytes: number;
  }>;
  buildInputs: readonly NeutronPackageBuildInputV1[];
}>): DeclaredHostedSource {
  const declared: DeclaredHostedSource = {
    url: source.url,
    path: neutronAppSourceRepositoryPath(source.sha256),
    revision: source.revision,
    sha256: source.sha256,
    size: source.bytes,
    package: Object.freeze({ id, version }),
    buildInputs,
  };
  assertHostedSourceDeclaration(declared, id, version);
  return Object.freeze(declared);
}

function assertHostedSourceDeclaration(
  source: DeclaredHostedSource,
  id: string,
  version: number,
): void {
  if (source.package.id !== id || source.package.version !== version) {
    throw new Error(
      `Package '${id}' hosted Complete App Source identity does not match its release`,
    );
  }
  if (source.size < 1 || source.size > SOURCE_COMPRESSED_MAX_BYTES) {
    throw new Error(
      `Package '${id}' hosted Complete App Source must be 1-${SOURCE_COMPRESSED_MAX_BYTES} compressed bytes`,
    );
  }
  if (source.revision !== `source-sha256:${source.sha256}`) {
    throw new Error(
      `Package '${id}' hosted Complete App Source revision must bind its SHA-256`,
    );
  }
  const expectedPath = neutronAppSourceRepositoryPath(source.sha256);
  if (source.path !== expectedPath) {
    throw new Error(
      `Package '${id}' hosted Complete App Source path must be ${expectedPath}`,
    );
  }
}

async function readBytes(file: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(file));
}

async function readBoundedBytes(
  file: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const handle = await open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Source artifact is not a regular file: ${file}`);
    }
    if (stats.size < 1 || stats.size > maximumBytes) {
      throw new Error(
        `Source artifact '${file}' must be 1-${maximumBytes} bytes`,
      );
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}
