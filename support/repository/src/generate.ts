import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "js-sha256";
import {
  KERNEL_INSTALL_MAX_COPIES,
  REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
  preparePackageInstall,
} from "neutron-compiler/src/install.ts";
import {
  NEUTRON_REPOSITORY_PROTOCOL,
  REPOSITORY_LIMITS,
  appendRepositorySetupFragment,
  parseRepositoryManifest,
  serializeRepositoryInfo,
  serializeRepositoryManifest,
  serializeRepositoryManifestIndex,
  type RepositoryManifest,
  type RepositoryManifestIndex,
  type RepositoryManifestPackage,
  type RepositorySetupReference,
} from "neutron-tools/repository";
import {
  formatAppVersion,
  formatAppVersionLabel,
} from "neutron-tools/src/version.js";
import {
  parseRepositoryBuildConfig,
  type RepositoryBuildConfig,
  type RepositoryBuildPackage,
} from "./model.ts";

export type InspectedNeutronPackage = {
  id: string;
  version: number;
  archiveEntries: number;
  decodedBytes: number;
  mutableFiles: number;
};

export type RepositoryPackageInspector = (
  bytes: Uint8Array,
) => InspectedNeutronPackage | Promise<InspectedNeutronPackage>;

export type GeneratedRepositoryResource = {
  path: string;
  sha256: string;
  bytes: Uint8Array;
  chunks: Uint8Array[];
};

export type GeneratedRepository = {
  config: RepositoryBuildConfig;
  infoBytes: Uint8Array;
  index: RepositoryManifestIndex;
  indexBytes: Uint8Array;
  manifests: Map<string, { manifest: RepositoryManifest; bytes: Uint8Array; digest: string }>;
  packages: Map<string, Uint8Array>;
  resources: GeneratedRepositoryResource[];
  motokoSource: string;
};

export type GenerateRepositoryOptions = {
  config: unknown;
  configDir: string;
  workspaceRoot: string;
  readPackage?: (absolutePath: string) => Promise<Uint8Array>;
  inspectPackage?: RepositoryPackageInspector;
};

type PackageArtifact = {
  bytes: Uint8Array;
  digest: string;
  id: string;
  version: number;
  archiveEntries: number;
  decodedBytes: number;
  mutableFiles: number;
};

export async function generateRepository({
  config: rawConfig,
  configDir,
  workspaceRoot,
  readPackage = async (absolutePath) => new Uint8Array(await readFile(absolutePath)),
  inspectPackage = inspectNeutronPackage,
}: GenerateRepositoryOptions): Promise<GeneratedRepository> {
  const config = parseRepositoryBuildConfig(rawConfig);
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const artifactByPath = new Map<string, Promise<PackageArtifact>>();
  const packageBytesByDigest = new Map<string, Uint8Array>();
  const generatedManifests = new Map<
    string,
    { manifest: RepositoryManifest; bytes: Uint8Array; digest: string }
  >();

  for (const configuredManifest of [...config.manifests].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  )) {
    const packages: RepositoryManifestPackage[] = [];
    let archiveEntries = 0;
    let decodedBytes = 0;
    let mutableFiles = 0;
    for (const configuredPackage of configuredManifest.packages) {
      const absolutePath = resolveWorkspacePackagePath(
        configDir,
        normalizedWorkspace,
        configuredPackage.file,
      );
      let artifactPromise = artifactByPath.get(absolutePath);
      if (!artifactPromise) {
        artifactPromise = loadPackageArtifact(
          absolutePath,
          configuredPackage.file,
          readPackage,
          inspectPackage,
        );
        artifactByPath.set(absolutePath, artifactPromise);
      }
      const artifact = await artifactPromise;
      const previousBytes = packageBytesByDigest.get(artifact.digest);
      if (previousBytes && !equalBytes(previousBytes, artifact.bytes)) {
        throw new Error(`SHA-256 collision for package '${configuredPackage.file}'`);
      }
      if (!previousBytes) packageBytesByDigest.set(artifact.digest, artifact.bytes);
      archiveEntries = checkedAdd(
        archiveEntries,
        artifact.archiveEntries,
        "archive entries",
      );
      decodedBytes = checkedAdd(
        decodedBytes,
        artifact.decodedBytes,
        "decoded bytes",
      );
      mutableFiles = checkedAdd(
        mutableFiles,
        artifact.mutableFiles,
        "install journal copies",
      );
      if (archiveEntries > REPOSITORY_LIMITS.manifestArchiveEntries) {
        throw new Error(
          `Repository manifest '${configuredManifest.id}' exceeds the aggregate archive-entry limit`,
        );
      }
      if (decodedBytes > REPOSITORY_LIMITS.decodedManifestBytes) {
        throw new Error(
          `Repository manifest '${configuredManifest.id}' exceeds the aggregate decoded-byte limit`,
        );
      }
      // Three compiler-owned assets plus the repository provenance record are
      // committed with the package files in the same journal.
      if (mutableFiles + 4 > KERNEL_INSTALL_MAX_COPIES) {
        throw new Error(
          `Repository manifest '${configuredManifest.id}' requires more than ${KERNEL_INSTALL_MAX_COPIES} install-journal copies`,
        );
      }
      packages.push(packageDescriptor(artifact, configuredPackage));
    }
    const manifest = parseRepositoryManifest({
      protocol: NEUTRON_REPOSITORY_PROTOCOL,
      id: configuredManifest.id,
      revision: configuredManifest.revision,
      name: configuredManifest.name,
      ...(configuredManifest.description === undefined
        ? {}
        : { description: configuredManifest.description }),
      packages,
    });
    const bytes = serializeRepositoryManifest(manifest);
    generatedManifests.set(manifest.id, {
      manifest,
      bytes,
      digest: sha256(bytes),
    });
  }

  const index: RepositoryManifestIndex = {
    protocol: NEUTRON_REPOSITORY_PROTOCOL,
    manifests: [...generatedManifests.values()]
      .map(({ manifest, digest }) => ({
        id: manifest.id,
        revision: manifest.revision,
        name: manifest.name,
        ...(manifest.description === undefined
          ? {}
          : { description: manifest.description }),
        digest,
        package_count: manifest.packages.length,
      }))
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
  const infoBytes = serializeRepositoryInfo(config.info);
  const indexBytes = serializeRepositoryManifestIndex(index);
  const rawResources = [
    { path: "/repo/v1/info.json", bytes: infoBytes },
    { path: "/repo/v1/manifests.json", bytes: indexBytes },
    ...[...generatedManifests.values()].map(({ manifest, bytes }) => ({
      path: `/repo/v1/manifests/${manifest.id}.json`,
      bytes,
    })),
    ...[...packageBytesByDigest].map(([digest, bytes]) => ({
      path: `/repo/v1/packages/${digest}.neutron`,
      bytes,
    })),
  ].sort((left, right) => compareCodeUnits(left.path, right.path));
  const seenPaths = new Set<string>();
  const resources = rawResources.map(({ path: resourcePath, bytes }) => {
    if (seenPaths.has(resourcePath)) {
      throw new Error(`Duplicate generated repository path '${resourcePath}'`);
    }
    seenPaths.add(resourcePath);
    return {
      path: resourcePath,
      bytes,
      sha256: sha256(bytes),
      chunks: splitChunks(bytes, REPOSITORY_LIMITS.queryChunkBytes),
    };
  });
  return {
    config,
    infoBytes,
    index,
    indexBytes,
    manifests: generatedManifests,
    packages: packageBytesByDigest,
    resources,
    motokoSource: renderGeneratedRepository(resources),
  };
}

export function repositorySetupLinks(
  generated: GeneratedRepository,
  repositoryPrincipal: string,
  dispenserOrigin: string,
): { manifest: string; digest: string; url: string }[] {
  return generated.index.manifests.map((manifest) => {
    const reference: RepositorySetupReference = {
      repo: repositoryPrincipal,
      manifest: manifest.id,
      digest: manifest.digest,
    };
    return {
      manifest: manifest.id,
      digest: manifest.digest,
      url: appendRepositorySetupFragment(dispenserOrigin, reference),
    };
  });
}

export function renderGeneratedRepository(
  resources: readonly GeneratedRepositoryResource[],
): string {
  const rendered = resources.map((resource) => {
    const chunks = resource.chunks
      .map((chunk) => motokoBlobLiteral(chunk))
      .join(",\n");
    return [
      "    {",
      `      path = ${JSON.stringify(resource.path)};`,
      `      sha256 = ${motokoBlobLiteral(hexBytes(resource.sha256))};`,
      "      chunks = [",
      chunks,
      "      ];",
      "    }",
    ].join("\n");
  });
  return [
    "// THIS FILE IS AUTOGENERATED BY support/repository/build.ts.",
    "// Rebuild the repository instead of editing this module.",
    "module {",
    "  public type Resource = {",
    "    path : Text;",
    "    sha256 : Blob;",
    "    chunks : [Blob];",
    "  };",
    "",
    "  public let resources : [Resource] = [",
    rendered.join(",\n"),
    "  ];",
    "};",
    "",
  ].join("\n");
}

export function splitChunks(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("Repository chunk size must be a positive safe integer");
  }
  if (bytes.byteLength === 0) return [new Uint8Array()];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return chunks;
}

async function loadPackageArtifact(
  absolutePath: string,
  configuredPath: string,
  readPackage: (absolutePath: string) => Promise<Uint8Array>,
  inspectPackage: RepositoryPackageInspector,
): Promise<PackageArtifact> {
  let bytes: Uint8Array;
  try {
    bytes = await readPackage(absolutePath);
  } catch (cause) {
    throw new Error(`Unable to read repository package '${configuredPath}'`, {
      cause,
    });
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`Repository package '${configuredPath}' did not return bytes`);
  }
  if (bytes.byteLength < 1 || bytes.byteLength > REPOSITORY_LIMITS.packageBytes) {
    throw new Error(
      `Repository package '${configuredPath}' must be 1-${REPOSITORY_LIMITS.packageBytes} bytes`,
    );
  }
  let inspected: InspectedNeutronPackage;
  try {
    inspected = await inspectPackage(bytes);
  } catch (cause) {
    throw new Error(`Invalid repository package '${configuredPath}'`, { cause });
  }
  if (
    !Number.isSafeInteger(inspected.archiveEntries) ||
    inspected.archiveEntries < 1 ||
    !Number.isSafeInteger(inspected.decodedBytes) ||
    inspected.decodedBytes < 1 ||
    !Number.isSafeInteger(inspected.mutableFiles) ||
    inspected.mutableFiles < 1
  ) {
    throw new Error(
      `Repository package '${configuredPath}' returned invalid decoded-size metadata`,
    );
  }
  const expectedFilename = `${inspected.id}.v${formatAppVersion(inspected.version)}.neutron`;
  if (path.basename(configuredPath) !== expectedFilename) {
    throw new Error(
      `Repository package '${configuredPath}' identity is ${inspected.id} ${formatAppVersionLabel(inspected.version)}; expected filename '${expectedFilename}'`,
    );
  }
  return {
    bytes: bytes.slice(),
    digest: sha256(bytes),
    id: inspected.id,
    version: inspected.version,
    archiveEntries: inspected.archiveEntries,
    decodedBytes: inspected.decodedBytes,
    mutableFiles: inspected.mutableFiles,
  };
}

function inspectNeutronPackage(bytes: Uint8Array): InspectedNeutronPackage {
  const prepared = preparePackageInstall(bytes, {
    limits: REMOTE_NEUTRON_PACKAGE_DECODE_LIMITS,
  });
  return {
    id: prepared.manifest.id,
    version: prepared.manifest.version,
    archiveEntries: prepared.files.length,
    decodedBytes: prepared.files.reduce(
      (total, file) => checkedAdd(total, file.content.byteLength, "decoded bytes"),
      0,
    ),
    mutableFiles: prepared.files.filter(({ path }) => !path.startsWith("mo/"))
      .length,
  };
}

function packageDescriptor(
  artifact: PackageArtifact,
  configured: RepositoryBuildPackage,
): RepositoryManifestPackage {
  return {
    id: artifact.id,
    version: artifact.version,
    sha256: artifact.digest,
    size: artifact.bytes.byteLength,
    ...(configured.publisher === undefined
      ? {}
      : { publisher: configured.publisher }),
    ...(configured.source === undefined ? {} : { source: configured.source }),
  };
}

function resolveWorkspacePackagePath(
  configDir: string,
  workspaceRoot: string,
  configuredPath: string,
): string {
  const absolutePath = path.resolve(configDir, configuredPath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Repository package path '${configuredPath}' escapes the workspace`,
    );
  }
  return absolutePath;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function motokoBlobLiteral(bytes: Uint8Array): string {
  return `"${[...bytes]
    .map((byte) => `\\${byte.toString(16).padStart(2, "0")}`)
    .join("")}"`;
}

function checkedAdd(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new Error(`Repository ${label} overflow`);
  }
  return left + right;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
