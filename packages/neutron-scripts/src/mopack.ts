import { exec as callbackExec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { disposeMotokoCompiler } from "neutron-motoko-wasm";
import {
  assertNeutronManifest,
  createMemoryLock,
  mergeMemoryLock,
  type NeutronMemoryLock,
} from "neutron-tools/src/memory.js";
import type {
  NeutronManifest,
  NeutronMemoryMigrationConfig,
  NeutronMemorySchemaConfig,
} from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";
import {
  type DependencyCache,
  type HashFiles,
  type PackageMap,
  getDependencies,
  hashContent,
  parsePackageString,
  parseImports,
  removeCommentsAndEmptyLines,
  walkReplace,
} from "./walk.ts";

const exec = promisify(callbackExec);

export type PackageMotokoOptions = {
  cwd?: string;
  packages?: PackageMap;
};

type PackageRoot = {
  label: string;
  src: string;
  schema?: { memoryId: string; version: string };
  setEntry: (entry: string) => void;
  setHash?: (hash: string) => void;
};

function collectRoots(manifest: NeutronManifest): PackageRoot[] {
  if (!manifest.src)
    throw new Error("neutron.json must include a string src field");
  const roots: PackageRoot[] = [
    {
      label: "app entry",
      src: manifest.src,
      setEntry: (entry) => {
        manifest.entry = entry;
      },
    },
  ];

  for (const [memoryId, memory] of Object.entries(manifest.memory ?? {})) {
    for (const [version, schema] of Object.entries(memory.schemas ?? {})) {
      roots.push(rootForSchema(memoryId, version, schema));
    }
    for (const migration of memory.migrations ?? []) {
      roots.push(rootForMigration(memoryId, migration));
    }
  }
  return roots;
}

function rootForSchema(
  memoryId: string,
  version: string,
  schema: NeutronMemorySchemaConfig,
): PackageRoot {
  if (!schema.src)
    throw new Error(`Missing source for memory ${memoryId} schema v${version}`);
  return {
    label: `memory ${memoryId} schema v${version}`,
    src: schema.src,
    schema: { memoryId, version },
    setEntry: (entry) => {
      schema.entry = entry;
    },
    setHash: (hash) => {
      schema.hash = hash;
    },
  };
}

function rootForMigration(
  memoryId: string,
  migration: NeutronMemoryMigrationConfig,
): PackageRoot {
  if (!migration.src) {
    throw new Error(
      `Missing source for memory ${memoryId} migration ${migration.from}->${migration.to}`,
    );
  }
  return {
    label: `memory ${memoryId} migration ${migration.from}->${migration.to}`,
    src: migration.src,
    setEntry: (entry) => {
      migration.entry = entry;
    },
  };
}

async function readPreviousLock(
  file: string,
): Promise<NeutronMemoryLock | null> {
  try {
    return JSON.parse(
      await fs.readFile(file, "utf8"),
    ) as NeutronMemoryLock;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function resolvePackages(cwd: string): Promise<PackageMap> {
  const result = await exec("mops sources", { cwd });
  return parsePackageString(result.stdout.replace(/\n/g, " ").trim());
}

export async function packageMotoko(
  options: PackageMotokoOptions = {},
): Promise<NeutronManifest> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifestPath = path.join(cwd, "neutron.json");
  const parsedManifest: unknown = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  );
  const validation = validate_neutron_conf(parsedManifest);
  if (validation.errors.length > 0) {
    throw new Error(
      `Invalid neutron.json: ${validation.errors
        .map((error) => error.stack)
        .join("; ")}`,
    );
  }
  const manifest = parsedManifest as NeutronManifest;
  assertNeutronManifest(manifest, "source");
  const lockPath = path.join(cwd, "neutron.lock.json");
  const distLockPath = path.join(cwd, "dist", "neutron.lock.json");
  const hasManagedMemory = Object.keys(manifest.memory ?? {}).length > 0;
  const previousLock = hasManagedMemory
    ? await readPreviousLock(lockPath)
    : null;
  if (!hasManagedMemory) {
    await fs.rm(distLockPath, { force: true });
  }

  const packages = options.packages ?? (await resolvePackages(cwd));
  const hashfiles: HashFiles = {};
  const dependencyCache: DependencyCache = {};
  const usedHashes = new Set<string>();

  console.log("Processing Motoko package roots...");
  for (const root of collectRoots(manifest)) {
    const sourcePath = path.join(cwd, "backend", root.src);
    if (root.schema) {
      const schemaSource = removeCommentsAndEmptyLines(
        await fs.readFile(sourcePath, "utf8"),
      );
      assertPackageOnlySchemaImports(
        schemaSource,
        packages,
        root.label,
      );
      root.setHash?.(hashContent(schemaSource));
    }
    const dependencies = await getDependencies(
      null,
      sourcePath,
      packages,
      hashfiles,
      dependencyCache,
    );
    const rootHashes: string[] = [];
    const [, entry] = walkReplace(dependencies, hashfiles, rootHashes, {
      allowDangerous: manifest.id === "kernel",
    });
    root.setEntry(entry);
    for (const hash of rootHashes) usedHashes.add(hash);
    console.log(`${root.label}: ${entry}`);
  }

  assertNeutronManifest(manifest, "package");
  const distMo = path.join(cwd, "dist", "mo");
  await fs.rm(distMo, { recursive: true, force: true });
  await fs.mkdir(distMo, { recursive: true });
  for (const hash of [...usedHashes].sort()) {
    const hashfile = hashfiles[hash];
    if (!hashfile) throw new Error(`Missing packaged Motoko hash ${hash}`);
    if (hashContent(hashfile.content) !== hash)
      throw new Error(`Hash mismatch for ${hash}`);
    await fs.writeFile(
      path.join(distMo, `${hash}.mo`),
      hashfile.content,
      "utf8",
    );
  }

  await fs.mkdir(path.join(cwd, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "dist", "neutron.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  if (hasManagedMemory) {
    const lock = mergeMemoryLock(
      previousLock,
      createMemoryLock(manifest),
    );
    const lockJson = `${JSON.stringify(lock, null, 2)}\n`;
    await fs.writeFile(lockPath, lockJson, "utf8");
    await fs.writeFile(
      distLockPath,
      lockJson,
      "utf8",
    );
  }

  return manifest;
}

function assertPackageOnlySchemaImports(
  source: string,
  packages: PackageMap,
  label: string,
): void {
  const imports = Object.values(parseImports(source));
  for (const imported of imports) {
    if (!imported.startsWith("mo:") || imported === "mo:prim") {
      throw new Error(
        `${label} may import declared Motoko packages but cannot import local module ${imported}`,
      );
    }
    const packageName = imported.slice(3).split("/")[0];
    if (!packageName || !packages[packageName]) {
      throw new Error(
        `${label} imports undeclared package ${imported}`,
      );
    }
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    await packageMotoko();
  } finally {
    await disposeMotokoCompiler();
  }
}
