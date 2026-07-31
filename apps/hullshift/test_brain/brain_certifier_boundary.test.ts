import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BRAIN_CATALOG_SCHEMA_VERSION,
  MAX_BRAIN_WITNESS_ACTIONS,
  parseBrainCatalog,
  type BrainCatalog,
} from "../src/brain_catalog.ts";
import type { CellDefinition, Direction, LevelDefinition } from "../src/model.ts";
import {
  MILESTONE_DSL_VERSION,
  type MilestoneSpec,
} from "../src/milestone_dsl.ts";
import { canonicalLevelHash, encodeUtf8, sha256Hex } from "../src/simulation.ts";
import { certifyBrainCatalogValue } from "../scripts/certify_brain_catalog.ts";

type JsonRecord = Record<string, unknown>;

function boundaryLevel(suffix = "a", mirrored = false): LevelDefinition {
  const width = 7;
  const height = 7;
  const cells: CellDefinition[] = Array.from(
    { length: width * height },
    () => ({ terrain: "bulkhead" }),
  );
  const reflectX = (x: number): number => mirrored ? width - 1 - x : x;
  const floor = (x: number, y: number, fixture?: CellDefinition["fixture"]): void => {
    cells[y * width + reflectX(x)] = {
      terrain: "floor",
      ...(fixture === undefined ? {} : { fixture }),
    };
  };
  floor(1, 3);
  floor(2, 2);
  floor(2, 3, {
    kind: "relay",
    id: `relay-${suffix}`,
    channel: suffix,
    initialOn: true,
  });
  floor(3, 3, { kind: "gate", id: `gate-${suffix}`, channel: suffix });
  return {
    generatorVersion: "g4",
    width,
    height,
    channels: [{ id: suffix, symbol: suffix.toUpperCase() }],
    cells,
    playerStart: { x: reflectX(1), y: 3 },
    objects: [],
  };
}

function boundaryMilestones(suffix = "a"): readonly MilestoneSpec[] {
  const second = `relay-${suffix}-on`;
  return [
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: second,
      family: "permanent-sources",
      trigger: { event: "relay-toggled", fixtureId: `relay-${suffix}`, active: true },
      occurrence: 1,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: `evacuate-${suffix}`,
      family: "evacuation",
      trigger: { event: "gate-entered", fixtureId: `gate-${suffix}` },
      occurrence: 1,
    },
  ];
}

function topologySignature(level: LevelDefinition): string {
  return sha256Hex(encodeUtf8(JSON.stringify([
    level.width,
    level.height,
    level.cells.map((cell) => cell.terrain),
    level.cells.map((cell) => cell.fixture?.kind ?? null),
  ]))).slice(0, 20);
}

function candidateEntry(
  id = "boundary-a",
  suffix = "a",
  mirrored = false,
): JsonRecord {
  const level = boundaryLevel(suffix, mirrored);
  const levelHash = canonicalLevelHash(level);
  const witness: readonly Direction[] = mirrored
    ? ["W", "N", "S", "W"]
    : ["E", "N", "S", "E"];
  return {
    id,
    difficulty: 0,
    level,
    witness,
    milestones: boundaryMilestones(suffix),
    requiredPrecedence: [
      { before: `relay-${suffix}-on`, after: `evacuate-${suffix}` },
    ],
    topologySignature: topologySignature(level),
    semanticSignature: levelHash.slice(0, 20),
    provenance: {
      masterSeed: "0123456789abcdef",
      candidateId: id,
      algorithmVersion: "boundary-test-v1",
      reverseDepth: witness.length,
    },
  };
}

function candidateCatalog(entries: readonly unknown[]): JsonRecord {
  return {
    schemaVersion: BRAIN_CATALOG_SCHEMA_VERSION,
    generatorVersion: "g4",
    brainVersion: "boundary-test-v1",
    entries,
  };
}

function mutableClone(value: unknown): JsonRecord {
  return structuredClone(value) as JsonRecord;
}

describe("HullshiftBrain catalog/certifier trust boundary", () => {
  let certified: BrainCatalog;

  beforeAll(async () => {
    certified = await certifyBrainCatalogValue(candidateCatalog([candidateEntry()]), {
      allowPartial: true,
      qualityMode: "pilot",
    });
  });

  test("rejects a valid-shaped but stale or tampered certificate", async () => {
    const tampered = mutableClone(certified);
    const entries = tampered.entries as JsonRecord[];
    const certificate = entries[0]!.certificate as JsonRecord;
    certificate.stateCount = (certificate.stateCount as number) + 1;

    await expect(certifyBrainCatalogValue(tampered, {
      allowPartial: true,
      checkStored: true,
      qualityMode: "pilot",
    })).rejects.toThrow(/differs from fresh exact certification/);
  });

  test("rejects unknown fields below both the level and certificate envelopes", async () => {
    const unknownLevelField = mutableClone(certified);
    const levelEntries = unknownLevelField.entries as JsonRecord[];
    const level = levelEntries[0]!.level as JsonRecord;
    (level.playerStart as JsonRecord).z = 0;
    expect(() => parseBrainCatalog(unknownLevelField)).toThrow(/unknown field 'z'/);

    const unknownCertificateField = mutableClone(certified);
    const certificateEntries = unknownCertificateField.entries as JsonRecord[];
    const certificate = certificateEntries[0]!.certificate as JsonRecord;
    (certificate.features as JsonRecord).untrustedMetric = 1;
    await expect(certifyBrainCatalogValue(unknownCertificateField, {
      allowPartial: true,
      checkStored: true,
      qualityMode: "pilot",
    })).rejects.toThrow(/differs from fresh exact certification/);
  });

  test("rejects witnesses beyond the frozen action bound before replay", async () => {
    const oversized = candidateEntry();
    oversized.witness = Array.from(
      { length: MAX_BRAIN_WITNESS_ACTIONS + 1 },
      () => "E",
    );
    await expect(certifyBrainCatalogValue(candidateCatalog([oversized]), {
      allowPartial: true,
    })).rejects.toThrow(/invalid witness/);
  });

  test("rejects malformed provenance and Unicode identity tokens", async () => {
    const malformed = candidateEntry();
    malformed.provenance = {
      masterSeed: "not-hex",
      candidateId: "boundary-a",
      algorithmVersion: "boundary-test-v1",
      reverseDepth: -1,
    };
    await expect(certifyBrainCatalogValue(candidateCatalog([malformed]), {
      allowPartial: true,
    })).rejects.toThrow(/invalid provenance fields/);

    const unicodeEntryId = candidateEntry("bräin-a");
    await expect(certifyBrainCatalogValue(candidateCatalog([unicodeEntryId]), {
      allowPartial: true,
    })).rejects.toThrow(/invalid id/);

    const unicodeProvenanceId = candidateEntry();
    unicodeProvenanceId.provenance = {
      masterSeed: "0123456789abcdef",
      candidateId: "candidate-λ",
      algorithmVersion: "boundary-test-v1",
      reverseDepth: 5,
    };
    await expect(certifyBrainCatalogValue(candidateCatalog([unicodeProvenanceId]), {
      allowPartial: true,
    })).rejects.toThrow(/invalid provenance fields/);
  });

  test("refuses partial certification over the production catalog path", async () => {
    const appDirectory = resolve(import.meta.dir, "..");
    const productionPath = resolve(
      appDirectory,
      "src/generated/hullshiftbrain.g4.catalog.json",
    );
    const before = await readFile(productionPath, "utf8");
    const child = Bun.spawn([
      process.execPath,
      "scripts/certify_brain_catalog.ts",
      "--allow-partial",
    ], {
      cwd: appDirectory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--allow-partial requires an explicit non-production output path");
    expect(await readFile(productionPath, "utf8")).toBe(before);
  });

  test("rejects mirrored levels after gameplay-id and channel normalization", async () => {
    const original = candidateEntry("boundary-a", "a", false);
    const mirroredAndRenamed = candidateEntry("boundary-b", "b", true);
    expect(canonicalLevelHash(original.level as LevelDefinition)).not.toBe(
      canonicalLevelHash(mirroredAndRenamed.level as LevelDefinition),
    );
    await expect(certifyBrainCatalogValue(candidateCatalog([
      original,
      mirroredAndRenamed,
    ]), {
      allowPartial: true,
      qualityMode: "pilot",
    })).rejects.toThrow(/duplicate level after symmetry and id normalization/);
  });
});
