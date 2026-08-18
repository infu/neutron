import type {
  NeutronManifest,
  NeutronMemoryConfig,
  NeutronMemoryMigrationConfig,
} from "./schema.ts";
import {
  normalizeManifestPackageFeatures,
  normalizeManifestUpdateSource,
} from "./schema.ts";
import { buildCapabilityPlan } from "./capabilities/plan.ts";
import { compareCanonicalText } from "./canonical.ts";
import { assertAppVersion } from "./version.ts";

export const MEMORY_SCHEMA_LIMIT = 64;
export const MEMORY_MIGRATION_LIMIT = 128;
export const MOTOKO_ENTRY_PATTERN = /^[a-f0-9]{64}$/;
const MEMORY_ID_PATTERN = /^[a-zA-Z_][a-zA-Z_0-9]{0,127}$/;

export type ManifestContext = "source" | "package";

export type NeutronMemorySchemaLock = {
  hash: string;
  entry: string;
};

export type NeutronMemoryLockEntry = {
  schemas: Record<string, NeutronMemorySchemaLock>;
  migrations: Record<string, string>;
};

export type NeutronMemoryLock = {
  format: 2;
  app: string;
  memory: Record<string, NeutronMemoryLockEntry>;
};

function assertPositiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

export function assertSafeMotokoSourcePath(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (value.startsWith("/") || value.includes("\\")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  if (
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  if (!value.endsWith(".mo")) {
    throw new Error(`${label} must reference a .mo file`);
  }
}

export function assertMotokoEntry(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !MOTOKO_ENTRY_PATTERN.test(value)) {
    throw new Error(`${label} must be a 64-character SHA-256 hash`);
  }
}

function assertRoot(
  root: { src?: string; entry?: string },
  context: ManifestContext,
  label: string,
): void {
  if (context === "source") {
    assertSafeMotokoSourcePath(root.src, `${label}.src`);
    if (root.entry !== undefined) {
      throw new Error(
        `${label}.entry is generated and is not allowed in a source manifest`,
      );
    }
    return;
  }
  assertMotokoEntry(root.entry, `${label}.entry`);
}

function validateManagedMemory(
  memoryId: string,
  memory: NeutronMemoryConfig,
  context: ManifestContext,
): void {
  if (!MEMORY_ID_PATTERN.test(memoryId)) {
    throw new Error(`Invalid memory id ${memoryId}`);
  }
  assertPositiveInteger(memory.version, `memory.${memoryId}.version`);

  const schemas = memory.schemas;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) {
    throw new Error(`memory.${memoryId}.schemas is required`);
  }
  const schemaEntries = Object.entries(schemas);
  if (
    schemaEntries.length === 0 ||
    schemaEntries.length > MEMORY_SCHEMA_LIMIT
  ) {
    throw new Error(
      `memory.${memoryId}.schemas must contain 1-${MEMORY_SCHEMA_LIMIT} schemas`,
    );
  }

  const versions = new Set<number>();
  for (const [versionText, schema] of schemaEntries) {
    if (!/^[1-9][0-9]*$/.test(versionText)) {
      throw new Error(
        `Invalid schema version ${versionText} for memory ${memoryId}`,
      );
    }
    const version = Number(versionText);
    assertPositiveInteger(version, `memory.${memoryId}.schemas.${versionText}`);
    versions.add(version);
    assertRoot(schema, context, `memory.${memoryId}.schemas.${versionText}`);
    if (context === "source") {
      if (schema.hash !== undefined) {
        throw new Error(
          `memory.${memoryId}.schemas.${versionText}.hash is generated and is not allowed in a source manifest`,
        );
      }
    } else {
      assertMotokoEntry(
        schema.hash,
        `memory.${memoryId}.schemas.${versionText}.hash`,
      );
    }
  }
  if (!versions.has(memory.version!)) {
    throw new Error(
      `memory.${memoryId} is missing its declared v${memory.version} schema`,
    );
  }

  const migrations = memory.migrations ?? [];
  if (
    !Array.isArray(migrations) ||
    migrations.length > MEMORY_MIGRATION_LIMIT
  ) {
    throw new Error(
      `memory.${memoryId}.migrations exceeds the ${MEMORY_MIGRATION_LIMIT}-edge limit`,
    );
  }
  const edges = new Set<string>();
  for (const migration of migrations) {
    validateMigration(
      memoryId,
      memory.version!,
      versions,
      migration,
      context,
      edges,
    );
  }
}

function validateMigration(
  memoryId: string,
  targetVersion: number,
  versions: Set<number>,
  migration: NeutronMemoryMigrationConfig,
  context: ManifestContext,
  edges: Set<string>,
): void {
  assertPositiveInteger(migration.from, `memory.${memoryId}.migration.from`);
  assertPositiveInteger(migration.to, `memory.${memoryId}.migration.to`);
  if (migration.from >= migration.to) {
    throw new Error(
      `Memory ${memoryId} migration ${migration.from}->${migration.to} is not forward-only`,
    );
  }
  if (migration.to > targetVersion) {
    throw new Error(
      `Memory ${memoryId} migration ${migration.from}->${migration.to} exceeds v${targetVersion}`,
    );
  }
  if (!versions.has(migration.from) || !versions.has(migration.to)) {
    throw new Error(
      `Memory ${memoryId} migration ${migration.from}->${migration.to} references a missing schema`,
    );
  }
  const key = `${migration.from}->${migration.to}`;
  if (edges.has(key)) {
    throw new Error(`Duplicate memory ${memoryId} migration ${key}`);
  }
  edges.add(key);
  const consumed = migration.consume ?? [];
  if (!Array.isArray(consumed) || consumed.length > 16) {
    throw new Error(
      `Memory ${memoryId} migration ${key} consumes too many roots`,
    );
  }
  const consumedIds = new Set<string>();
  for (const consumedId of consumed) {
    if (
      !MEMORY_ID_PATTERN.test(consumedId) ||
      consumedId === memoryId ||
      consumedIds.has(consumedId)
    ) {
      throw new Error(
        `Invalid consumed memory ${consumedId} in ${memoryId} migration ${key}`,
      );
    }
    consumedIds.add(consumedId);
  }
  assertRoot(migration, context, `memory.${memoryId}.migrations.${key}`);
}

export function assertNeutronManifest(
  manifest: NeutronManifest,
  context: ManifestContext,
): void {
  if (
    Object.prototype.hasOwnProperty.call(
      manifest as unknown as Record<string, unknown>,
      "memory_requires",
    )
  ) {
    throw new Error(
      "memory_requires is unsupported; app memory cannot be shared",
    );
  }

  if (manifest.format !== 3) {
    throw new Error(`Unsupported package format ${String(manifest.format)}`);
  }
  assertAppVersion(manifest.version, `${manifest.id} package version`);
  normalizeManifestPackageFeatures(manifest);
  normalizeManifestUpdateSource(manifest);

  if (manifest.id !== "kernel" && manifest.init_arg !== undefined) {
    throw new Error(
      `${manifest.id} cannot declare init_arg; app backend resources are derived from its exact backend environment`,
    );
  }

  const raw = manifest as unknown as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(raw, "connections")) {
    throw new Error(
      "Top-level connections are unsupported; use capabilities.connections",
    );
  }
  const background = raw.background;
  if (
    background &&
    typeof background === "object" &&
    Object.prototype.hasOwnProperty.call(background, "storage")
  ) {
    throw new Error(
      "background.storage is unsupported; use capabilities.persistent_browser_storage",
    );
  }

  if (context === "source") {
    if (manifest.package_features !== undefined) {
      throw new Error(
        "package_features is generated by packaging and is not allowed in a source manifest",
      );
    }
    if (manifest.src !== undefined) {
      assertSafeMotokoSourcePath(manifest.src, "src");
    }
    if (manifest.entry !== undefined) {
      throw new Error(
        "entry is generated and is not allowed in a source manifest",
      );
    }
  } else if (manifest.src !== undefined) {
    assertMotokoEntry(manifest.entry, "entry");
  }

  for (const [memoryId, memory] of Object.entries(manifest.memory ?? {})) {
    validateManagedMemory(memoryId, memory, context);
  }
  buildCapabilityPlan(manifest);
}

export function createMemoryLock(manifest: NeutronManifest): NeutronMemoryLock {
  if (manifest.format !== 3)
    throw new Error("Memory locks require package format 3 manifests");
  const memory: Record<string, NeutronMemoryLockEntry> = {};
  for (const [memoryId, config] of Object.entries(manifest.memory ?? {}).sort(
    ([a], [b]) => compareCanonicalText(a, b),
  )) {
    const schemas: Record<string, NeutronMemorySchemaLock> = {};
    for (const [version, schema] of Object.entries(config.schemas ?? {}).sort(
      ([a], [b]) => Number(a) - Number(b),
    )) {
      assertMotokoEntry(
        schema.entry,
        `memory.${memoryId}.schemas.${version}.entry`,
      );
      assertMotokoEntry(
        schema.hash,
        `memory.${memoryId}.schemas.${version}.hash`,
      );
      schemas[version] = { hash: schema.hash, entry: schema.entry };
    }
    const migrations: Record<string, string> = {};
    for (const edge of config.migrations ?? []) {
      assertMotokoEntry(
        edge.entry,
        `memory.${memoryId}.migrations.${edge.from}->${edge.to}.entry`,
      );
      migrations[`${edge.from}->${edge.to}`] =
        edge.consume && edge.consume.length > 0
          ? `${edge.entry}:${edge.consume.join(",")}`
          : edge.entry;
    }
    memory[memoryId] = { schemas, migrations };
  }
  return { format: 2, app: manifest.id, memory };
}

export function mergeMemoryLock(
  previous: NeutronMemoryLock | null,
  current: NeutronMemoryLock,
): NeutronMemoryLock {
  if (
    previous &&
    (previous.format !== 2 ||
      !previous.memory ||
      typeof previous.memory !== "object" ||
      previous.app !== current.app)
  ) {
    throw new Error("neutron.lock.json belongs to a different app or format");
  }
  const merged: NeutronMemoryLock =
    previous === null
      ? { format: 2, app: current.app, memory: {} }
      : structuredClone(previous);
  for (const [memoryId, prior] of Object.entries(previous?.memory ?? {})) {
    const next = current.memory[memoryId];
    for (const [version, locked] of Object.entries(prior.schemas)) {
      const candidate = next?.schemas[version];
      if (!candidate) continue;
      const changed =
        !locked ||
        typeof locked !== "object" ||
        !("hash" in locked) ||
        candidate.hash !== locked.hash;
      if (changed) {
        throw new Error(
          `Locked schema ${memoryId} v${version} changed content hash`,
        );
      }
    }
    for (const [edge, hash] of Object.entries(prior.migrations)) {
      if (
        next?.migrations[edge] !== undefined &&
        next.migrations[edge] !== hash
      ) {
        throw new Error(
          `Locked migration ${memoryId} ${edge} changed content hash`,
        );
      }
    }
  }
  merged.format = 2;
  merged.app = current.app;
  for (const [memoryId, entry] of Object.entries(current.memory)) {
    const target = (merged.memory[memoryId] ??= {
      schemas: {},
      migrations: {},
    });
    Object.assign(target.schemas, entry.schemas);
    Object.assign(target.migrations, entry.migrations);
  }
  return merged;
}
