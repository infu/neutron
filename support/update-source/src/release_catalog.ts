import path from "node:path";
import { readFile } from "node:fs/promises";
import { preparePackageInstall } from "neutron-compiler/src/install.ts";
import { isValidAppId } from "neutron-tools/src/app_ids.ts";
import { packageArchiveFilename } from "neutron-tools/src/package_archive.ts";
import { normalizeUpdateSourcePrincipal } from "neutron-tools/src/schema.ts";
import { MAX_PACKAGES_PER_PUBLICATION } from "./model.ts";

const RELEASE_CATALOG_FORMAT = 1;
const MAX_RELEASE_CATALOG_BYTES = 256 * 1024;
const MAX_DIRECTORY_LENGTH = 4_096;

const repositoryRoot = path.resolve(import.meta.dir, "../../..");

export const productionReleaseCatalogPath = path.resolve(
  import.meta.dir,
  "../release-catalog.json",
);

export type ReleaseCatalogPackage = {
  id: string;
  directory: string;
};

export type ReleaseCatalog = {
  configPath: string;
  updateSource: string;
  packages: ReleaseCatalogPackage[];
};

export async function loadReleaseCatalog(
  filename: string,
  options: { repositoryRoot?: string } = {},
): Promise<ReleaseCatalog> {
  const configPath = path.resolve(filename);
  const source = await readFile(configPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_RELEASE_CATALOG_BYTES) {
    throw new Error(
      `Release catalog exceeds ${MAX_RELEASE_CATALOG_BYTES} bytes`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (cause) {
    throw new Error(`Release catalog is not valid JSON: ${configPath}`, {
      cause,
    });
  }
  if (!isRecord(value)) {
    throw new Error("Release catalog must be an object");
  }
  assertExactFields(
    value,
    ["format", "packages", "update_source"],
    "release catalog",
  );
  if (value.format !== RELEASE_CATALOG_FORMAT) {
    throw new Error(`Release catalog format must be ${RELEASE_CATALOG_FORMAT}`);
  }
  if (
    !Array.isArray(value.packages) ||
    value.packages.length < 1 ||
    value.packages.length > MAX_PACKAGES_PER_PUBLICATION
  ) {
    throw new Error(
      `Release catalog packages must contain 1-${MAX_PACKAGES_PER_PUBLICATION} entries`,
    );
  }

  const catalogDirectory = path.dirname(configPath);
  const allowedRoot = path.resolve(options.repositoryRoot ?? repositoryRoot);
  const packages = value.packages.map((entry, index) =>
    parsePackage(entry, `packages[${index}]`, {
      allowedRoot,
      catalogDirectory,
    }),
  );
  if (new Set(packages.map(({ id }) => id)).size !== packages.length) {
    throw new Error("Release catalog contains duplicate package ids");
  }
  if (
    new Set(packages.map(({ directory }) => directory)).size !== packages.length
  ) {
    throw new Error("Release catalog contains duplicate package directories");
  }

  return {
    configPath,
    updateSource: normalizeUpdateSourcePrincipal(
      value.update_source,
      "release catalog update_source",
    ),
    packages,
  };
}

export async function resolveReleaseCatalogPackageFiles(
  catalog: ReleaseCatalog,
): Promise<string[]> {
  return Promise.all(
    catalog.packages.map(async ({ directory, id }) => {
      const manifestPath = path.join(directory, "neutron.json");
      let manifest: {
        id?: unknown;
        version?: unknown;
        update_source?: unknown;
      };
      try {
        manifest = JSON.parse(
          await readFile(manifestPath, "utf8"),
        ) as typeof manifest;
      } catch (cause) {
        throw new Error(`Unable to read release manifest ${manifestPath}`, {
          cause,
        });
      }
      if (manifest.id !== id) {
        throw new Error(
          `Release manifest ${manifestPath} must declare app id '${id}'`,
        );
      }
      if (
        typeof manifest.version !== "number" ||
        !Number.isSafeInteger(manifest.version)
      ) {
        throw new Error(
          `Release manifest ${manifestPath} has an invalid version`,
        );
      }
      if (manifest.update_source !== catalog.updateSource) {
        throw new Error(
          `Release manifest ${manifestPath} must use update source ${catalog.updateSource}`,
        );
      }

      const archivePath = path.join(
        directory,
        packageArchiveFilename(id, manifest.version),
      );
      const archive = new Uint8Array(await readFile(archivePath));
      const prepared = preparePackageInstall(archive);
      if (
        prepared.manifest.id !== id ||
        prepared.manifest.version !== manifest.version ||
        prepared.manifest.update_source !== catalog.updateSource
      ) {
        throw new Error(
          `Release archive ${archivePath} does not match its source manifest`,
        );
      }
      return archivePath;
    }),
  );
}

function parsePackage(
  value: unknown,
  label: string,
  {
    allowedRoot,
    catalogDirectory,
  }: { allowedRoot: string; catalogDirectory: string },
): ReleaseCatalogPackage {
  if (!isRecord(value)) {
    throw new Error(`Release catalog ${label} must be an object`);
  }
  assertExactFields(value, ["directory", "id"], `release catalog ${label}`);
  if (!isValidAppId(value.id)) {
    throw new Error(`Release catalog ${label}.id is invalid`);
  }
  if (
    typeof value.directory !== "string" ||
    value.directory.length < 1 ||
    value.directory.length > MAX_DIRECTORY_LENGTH ||
    value.directory.includes("\0") ||
    path.isAbsolute(value.directory)
  ) {
    throw new Error(
      `Release catalog ${label}.directory must be a bounded relative path`,
    );
  }

  const directory = path.resolve(catalogDirectory, value.directory);
  const relativeToRoot = path.relative(allowedRoot, directory);
  if (
    relativeToRoot === "" ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(
      `Release catalog ${label}.directory must remain inside the repository`,
    );
  }
  return { id: value.id, directory };
}

function assertExactFields(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((field, index) => field !== required[index])
  ) {
    throw new Error(`${label} must contain exactly ${required.join(", ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
