import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparedDeployment } from "neutron-provision/src/artifact.js";

const STARTER_CONFIG_FORMAT = 1;
const MAX_STARTER_CONFIG_BYTES = 256 * 1024;
const MAX_STARTER_APPS = 255;
const APP_ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

export const starterConfigPath = fileURLToPath(
  new URL("./starter-packages.json", import.meta.url),
);

export type StarterPackageEntry = {
  id: string;
  path: string;
};

export type StarterSelection = {
  configPath: string;
  kernel: StarterPackageEntry;
  apps: StarterPackageEntry[];
  packageIds: string[];
  packagePaths: string[];
};

export async function loadStarterSelection(
  filename = starterConfigPath,
): Promise<StarterSelection> {
  const configPath = path.resolve(filename);
  const source = await readFile(configPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_STARTER_CONFIG_BYTES) {
    throw new Error(
      `Starter package list exceeds ${MAX_STARTER_CONFIG_BYTES} bytes`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (cause) {
    throw new Error(`Starter package list is not valid JSON: ${configPath}`, {
      cause,
    });
  }
  if (!isRecord(value)) {
    throw new Error("Starter package list must be an object");
  }
  assertExactFields(
    value,
    ["apps", "format", "kernel"],
    "starter package list",
  );
  if (value.format !== STARTER_CONFIG_FORMAT) {
    throw new Error(
      `Starter package list format must be ${STARTER_CONFIG_FORMAT}`,
    );
  }
  if (!Array.isArray(value.apps) || value.apps.length > MAX_STARTER_APPS) {
    throw new Error(
      `Starter package list apps must be an array of at most ${MAX_STARTER_APPS} entries`,
    );
  }

  const configDirectory = path.dirname(configPath);
  const repositoryRoot = path.resolve(configDirectory, "../..");
  const kernel = parseEntry(value.kernel, "kernel", {
    configDirectory,
    repositoryRoot,
  });
  if (kernel.id !== "kernel") {
    throw new Error("Starter kernel entry must have id 'kernel'");
  }
  const apps = value.apps.map((entry, index) => {
    const parsed = parseEntry(entry, `apps[${index}]`, {
      configDirectory,
      repositoryRoot,
    });
    if (parsed.id === "kernel") {
      throw new Error(`Starter apps[${index}] cannot declare the kernel`);
    }
    return parsed;
  });
  const entries = [kernel, ...apps];
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error("Starter package list contains duplicate package ids");
  }
  if (
    new Set(entries.map(({ path: archivePath }) => archivePath)).size !==
    entries.length
  ) {
    throw new Error("Starter package list contains duplicate archive paths");
  }

  return {
    configPath,
    kernel,
    apps,
    packageIds: entries.map(({ id }) => id),
    packagePaths: entries.map(({ path: archivePath }) => archivePath),
  };
}

export function assertStarterSelectionMatchesDeployment(
  selection: StarterSelection,
  deployment: Pick<PreparedDeployment, "packageArtifacts">,
): void {
  if (deployment.packageArtifacts.length !== selection.packageIds.length) {
    throw new Error(
      "Compiled starter package count does not match starter-packages.json",
    );
  }
  selection.packageIds.forEach((expectedId, index) => {
    const artifact = deployment.packageArtifacts[index]!;
    if (
      artifact.id !== expectedId ||
      path.resolve(artifact.path) !== selection.packagePaths[index]
    ) {
      throw new Error(
        `Starter package ${index} does not match configured ${expectedId}`,
      );
    }
  });
}

function parseEntry(
  value: unknown,
  label: string,
  {
    configDirectory,
    repositoryRoot,
  }: { configDirectory: string; repositoryRoot: string },
): StarterPackageEntry {
  if (!isRecord(value)) {
    throw new Error(`Starter ${label} must be an object`);
  }
  assertExactFields(value, ["id", "path"], `starter ${label}`);
  if (typeof value.id !== "string" || !APP_ID_PATTERN.test(value.id)) {
    throw new Error(`Starter ${label}.id is invalid`);
  }
  if (
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    value.path.length > 4096 ||
    value.path.includes("\0") ||
    path.isAbsolute(value.path) ||
    !value.path.endsWith(".neutron")
  ) {
    throw new Error(
      `Starter ${label}.path must be a bounded relative .neutron path`,
    );
  }
  const archivePath = path.resolve(configDirectory, value.path);
  const relativeToRepository = path.relative(repositoryRoot, archivePath);
  if (
    relativeToRepository === "" ||
    relativeToRepository === ".." ||
    relativeToRepository.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRepository)
  ) {
    throw new Error(`Starter ${label}.path must remain inside the repository`);
  }
  return { id: value.id, path: archivePath };
}

function assertExactFields(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const fields = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    fields.length !== required.length ||
    fields.some((field, index) => field !== required[index])
  ) {
    throw new Error(`${label} must contain exactly ${required.join(", ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
