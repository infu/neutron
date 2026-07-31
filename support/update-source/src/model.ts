import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  preparePackageInstall,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
} from "neutron-compiler/src/install.ts";
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
  "neutron-update-source-publish-v1" as const;
export const RELEASE_CONTENT_TYPE = "application/json; charset=utf-8";
export const PACKAGE_CONTENT_TYPE = "application/vnd.neutron.package";
export const RELEASE_CACHE_CONTROL =
  "public, max-age=0, must-revalidate";
export const PACKAGE_CACHE_CONTROL =
  "public, max-age=31536000, immutable, no-transform";
export const PACKAGE_MAX_AGE_SECONDS = 31_536_000n;
export const RELEASE_MAX_AGE_SECONDS = 0n;
export const UPLOAD_CHUNK_BYTES = 1_800_000;
export const UPLOAD_CONCURRENCY = 4;
export const MAX_PACKAGES_PER_PUBLICATION = 20;
export const MAX_PUBLICATION_BYTES = 128 * 1024 * 1024;

export type HeaderField = [string, string];

export type InspectedUpdatePackage = {
  file: string;
  bytes: Uint8Array;
  record: RepositoryReleaseRecord;
  releaseBytes: Uint8Array;
  packagePath: string;
  releasePath: string;
};

export type PackageInspector = (
  file: string,
  bytes: Uint8Array,
) => Omit<InspectedUpdatePackage, "file" | "bytes">;

export function inspectUpdatePackage(
  file: string,
  bytes: Uint8Array,
): Omit<InspectedUpdatePackage, "file" | "bytes"> {
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
  return {
    record,
    releaseBytes: serializeRepositoryReleaseRecord(record),
    packagePath: repositoryPackagePath(digest),
    releasePath: repositoryReleasePath(record.id),
  };
}

export async function inspectPackageFiles(
  files: readonly string[],
  options: {
    read?: (file: string) => Promise<Uint8Array>;
    inspect?: PackageInspector;
  } = {},
): Promise<InspectedUpdatePackage[]> {
  if (files.length < 1) throw new Error("At least one .neutron file is required");
  if (files.length > MAX_PACKAGES_PER_PUBLICATION) {
    throw new Error(
      `One publication may contain at most ${MAX_PACKAGES_PER_PUBLICATION} packages`,
    );
  }
  const read = options.read ?? (async (file: string) => new Uint8Array(await readFile(file)));
  const inspect = options.inspect ?? inspectUpdatePackage;
  const seen = new Set<string>();
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
    result.push({ file, bytes, ...inspected });
  }

  return result.sort((left, right) => left.record.id.localeCompare(right.record.id));
}

export function releaseHeaders(digest: string): HeaderField[] {
  return commonHeaders(RELEASE_CACHE_CONTROL, digest);
}

export function packageHeaders(digest: string): HeaderField[] {
  return commonHeaders(PACKAGE_CACHE_CONTROL, digest);
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
