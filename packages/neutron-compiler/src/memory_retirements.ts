import { isValidAppId } from "neutron-tools/src/app_ids.js";
import { compareCanonicalText } from "neutron-tools/src/canonical.js";
import type { PackagedNeutronManifest } from "neutron-tools/src/schema.js";
import type { MemoryMigrationPlan, MemoryUpgrade } from "./memory_migrations.ts";

const METADATA_PREFIX = "// @neutron-managed-memory-retirements-v2 ";
const MAX_RETIREMENTS = 16_384;
const MEMORY_ID_PATTERN = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const ENTRY_PATTERN = /^[a-f0-9]{64}$/;

export type ManagedMemoryRetirement = {
  memoryId: string;
  owner: string;
  version: number;
  schemaEntry: string;
};

type ManagedMemoryRetirementWire = {
  memory_id: string;
  owner: string;
  version: number;
  schema_entry: string;
};

export function plannedManagedMemoryRetirements(
  plan: MemoryMigrationPlan,
): ManagedMemoryRetirement[] {
  return normalizeManagedMemoryRetirements(
    plan.upgrades
      .filter(
        (upgrade): upgrade is Extract<MemoryUpgrade, { kind: "retire" }> =>
          upgrade.kind === "retire",
      )
      .map((upgrade) => ({
        memoryId: upgrade.memoryId,
        owner: upgrade.owner,
        version: upgrade.from,
        schemaEntry: upgrade.oldSchemaEntry,
      })),
    "planned managed-memory retirement",
  );
}

export function readManagedMemoryRetirements(
  stableSignature: string | null | undefined,
): ManagedMemoryRetirement[] {
  if (stableSignature == null) return [];
  const records = stableSignature
    .split("\n")
    .filter((line) => line.startsWith(METADATA_PREFIX));
  if (records.length !== 1) {
    throw new Error(
      "V2 stable signature must contain exactly one managed-memory retirement marker",
    );
  }
  const encoded = records[0]!.slice(METADATA_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw new Error("Stable signature has invalid managed-memory metadata", {
      cause: error,
    });
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RETIREMENTS) {
    throw new Error("Stable signature has invalid managed-memory metadata");
  }
  const wires = parsed.map((candidate) => {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).length !== 4 ||
      typeof candidate.memory_id !== "string" ||
      typeof candidate.owner !== "string" ||
      typeof candidate.version !== "number" ||
      typeof candidate.schema_entry !== "string"
    ) {
      throw new Error("Stable signature has invalid managed-memory metadata");
    }
    return {
      memory_id: candidate.memory_id,
      owner: candidate.owner,
      version: candidate.version,
      schema_entry: candidate.schema_entry,
    } satisfies ManagedMemoryRetirementWire;
  });
  if (JSON.stringify(wires) !== encoded) {
    throw new Error("Stable signature has non-canonical managed-memory metadata");
  }
  return normalizeManagedMemoryRetirements(
    wires.map((wire) => ({
      memoryId: wire.memory_id,
      owner: wire.owner,
      version: wire.version,
      schemaEntry: wire.schema_entry,
    })),
    "stable managed-memory retirement",
  );
}

export function writeManagedMemoryRetirements(
  stableSignature: string,
  retirements: readonly ManagedMemoryRetirement[],
): string {
  if (
    stableSignature
      .split("\n")
      .some((line) => line.startsWith(METADATA_PREFIX))
  ) {
    throw new Error("Compiler stable signature already has retirement metadata");
  }
  const canonical = normalizeManagedMemoryRetirements(
    retirements,
    "target managed-memory retirement",
  );
  const wire = canonical.map(
    ({ memoryId, owner, version, schemaEntry }) => ({
      memory_id: memoryId,
      owner,
      version,
      schema_entry: schemaEntry,
    }),
  );
  return `${stableSignature.trimEnd()}\n${METADATA_PREFIX}${JSON.stringify(wire)}\n`;
}

export function validateCommittedManagedMemoryRetirements(
  retirements: readonly ManagedMemoryRetirement[],
  installed: Record<string, PackagedNeutronManifest>,
): void {
  const canonical = normalizeManagedMemoryRetirements(
    retirements,
    "committed managed-memory retirement",
  );
  for (const retirement of canonical) {
    validateRetiredOwnership(retirement, installed, "installed");
  }
}

function validateRetiredOwnership(
  retirement: ManagedMemoryRetirement,
  manifests: Record<string, PackagedNeutronManifest>,
  label: string,
): void {
  const manifest = manifests[retirement.owner];
  const memory = manifest?.memory?.[retirement.memoryId];
  if (
    memory &&
    (memory.retired !== true ||
      (memory.version ?? 1) !== retirement.version ||
      memory.schemas?.[String(retirement.version)]?.entry !==
        retirement.schemaEntry)
  ) {
    throw new Error(
      `${label} memory ${retirement.owner}.${retirement.memoryId} conflicts with its committed retirement`,
    );
  }
}

export function normalizeManagedMemoryRetirements(
  values: readonly ManagedMemoryRetirement[],
  label: string,
): ManagedMemoryRetirement[] {
  if (values.length > MAX_RETIREMENTS) {
    throw new Error(`${label} exceeds the retirement limit`);
  }
  const result = values
    .map((value) => {
      if (
        !MEMORY_ID_PATTERN.test(value.memoryId) ||
        !isValidAppId(value.owner) ||
        !Number.isSafeInteger(value.version) ||
        value.version < 1 ||
        !ENTRY_PATTERN.test(value.schemaEntry)
      ) {
        throw new Error(`Invalid ${label}`);
      }
      return { ...value };
    })
    .sort(
      (left, right) =>
        compareCanonicalText(left.owner, right.owner) ||
        compareCanonicalText(left.memoryId, right.memoryId),
    );
  for (let index = 1; index < result.length; index += 1) {
    if (
      result[index - 1]!.owner === result[index]!.owner &&
      result[index - 1]!.memoryId === result[index]!.memoryId
    ) {
      throw new Error(
        `Duplicate ${label} ${result[index]!.owner}.${result[index]!.memoryId}`,
      );
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
