import {
  NEUTRON_REPOSITORY_PROTOCOL,
  REPOSITORY_LIMITS,
  RepositoryProtocolError,
  parseRepositoryInfo,
  parseRepositoryManifest,
  validateManifestId,
  type RepositoryInfo,
  type RepositoryPublisher,
} from "neutron-tools/repository";

const textEncoder = new TextEncoder();

export type RepositoryBuildPackage = {
  file: string;
  publisher?: RepositoryPublisher;
  source?: string;
};

export type RepositoryBuildManifest = {
  id: string;
  revision: number;
  name: string;
  description?: string;
  packages: RepositoryBuildPackage[];
};

export type RepositoryBuildConfig = {
  info: RepositoryInfo;
  manifests: RepositoryBuildManifest[];
};

export function parseRepositoryBuildConfig(
  value: unknown,
): RepositoryBuildConfig {
  const record = exactRecord(value, "repository build config", [
    "info",
    "manifests",
  ]);
  const info = parseRepositoryInfo(record.info);
  if (!Array.isArray(record.manifests)) {
    invalid("Repository build config manifests must be an array");
  }
  if (
    record.manifests.length < 1 ||
    record.manifests.length > REPOSITORY_LIMITS.manifestsPerIndex
  ) {
    invalid(
      `Repository build config must contain 1-${REPOSITORY_LIMITS.manifestsPerIndex} manifests`,
    );
  }
  const ids = new Set<string>();
  const manifests = record.manifests.map((entry, manifestIndex) => {
    const manifest = exactRecord(
      entry,
      `repository build manifest ${manifestIndex}`,
      ["id", "revision", "name", "packages"],
      ["description"],
    );
    const id = validateManifestId(manifest.id);
    if (ids.has(id)) invalid(`Repository build config repeats manifest '${id}'`);
    ids.add(id);
    if (!Array.isArray(manifest.packages)) {
      invalid(`Repository build manifest '${id}' packages must be an array`);
    }
    if (
      manifest.packages.length < 1 ||
      manifest.packages.length > REPOSITORY_LIMITS.packagesPerManifest
    ) {
      invalid(
        `Repository build manifest '${id}' must contain 1-${REPOSITORY_LIMITS.packagesPerManifest} packages`,
      );
    }
    const buildPackages = manifest.packages.map((packageEntry, packageIndex) =>
      parseBuildPackage(packageEntry, id, packageIndex),
    );

    // Reuse the protocol parser for all display text, numeric metadata, and
    // optional publisher/source claims. Placeholder identities never reach the
    // generated repository; actual package identities replace them later.
    const checked = parseRepositoryManifest({
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id,
      revision: manifest.revision,
      name: manifest.name,
      ...(manifest.description === undefined
        ? {}
        : { description: manifest.description }),
      packages: buildPackages.map((pkg, index) => ({
        id: `pkg_${index}`,
        version: 100,
        sha256: (index + 1).toString(16).padStart(64, "0"),
        size: 1,
        ...(pkg.publisher === undefined ? {} : { publisher: pkg.publisher }),
        ...(pkg.source === undefined ? {} : { source: pkg.source }),
      })),
    });

    return {
      id: checked.id,
      revision: checked.revision,
      name: checked.name,
      ...(checked.description === undefined
        ? {}
        : { description: checked.description }),
      packages: buildPackages.map((pkg, index) => {
        const claims = checked.packages[index]!;
        return {
          file: pkg.file,
          ...(claims.publisher === undefined
            ? {}
            : { publisher: claims.publisher }),
          ...(claims.source === undefined ? {} : { source: claims.source }),
        };
      }),
    } satisfies RepositoryBuildManifest;
  });
  return { info, manifests };
}

function parseBuildPackage(
  value: unknown,
  manifestId: string,
  index: number,
): RepositoryBuildPackage {
  const record = exactRecord(
    value,
    `repository build manifest '${manifestId}' package ${index}`,
    ["file"],
    ["publisher", "source"],
  );
  if (
    typeof record.file !== "string" ||
    record.file === "" ||
    record.file.includes("\0") ||
    record.file.startsWith("/") ||
    !record.file.endsWith(".neutron") ||
    textEncoder.encode(record.file).byteLength > REPOSITORY_LIMITS.archivePathBytes
  ) {
    invalid(
      `Repository build manifest '${manifestId}' has an invalid relative .neutron path`,
    );
  }
  return {
    file: record.file,
    ...(record.publisher === undefined
      ? {}
      : { publisher: record.publisher as RepositoryPublisher }),
    ...(record.source === undefined ? {} : { source: record.source as string }),
  };
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    invalid(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`${label} has unknown property '${key}'`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      invalid(`${label} is missing '${key}'`);
    }
  }
  return record;
}

function invalid(message: string): never {
  throw new RepositoryProtocolError("invalid_schema", message);
}
