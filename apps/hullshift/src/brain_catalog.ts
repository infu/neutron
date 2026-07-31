import rawCatalog from "./generated/hullshiftbrain.g4.catalog.json";
import {
  BRAIN_QUALITY_POLICY_VERSION,
  type BrainQualityMode,
} from "./brain_quality.ts";
import type { DifficultyFeatureVector, DifficultyRating } from "./difficulty.ts";
import type { Direction, LevelDefinition } from "./model.ts";
import { validateMilestoneSpecs, type MilestoneSpec } from "./milestone_dsl.ts";
import { encodeUtf8, sha256Hex } from "./simulation.ts";
import type {
  AnalysisReport,
  InteractionMetrics,
  MacroProjectionReport,
  MilestoneReport,
  RetainedSolution,
} from "./solver.ts";

export const BRAIN_CATALOG_SCHEMA_VERSION = "hullshiftbrain-catalog-v1" as const;
export const BRAIN_CERTIFICATE_SCHEMA_VERSION = "hullshiftbrain-certificate-v1" as const;
export const BRAIN_SOLVER_VERSION = "hullshift-exact-g4-v1" as const;
export const MAX_BRAIN_WITNESS_ACTIONS = 512 as const;
export const MAX_BRAIN_CATALOG_BYTES = 8 * 1024 * 1024;

export interface BrainRequiredPrecedence {
  readonly before: string;
  readonly after: string;
}

export interface BrainProvenance {
  readonly masterSeed: string;
  readonly candidateId: string;
  readonly algorithmVersion: string;
  readonly reverseDepth: number;
  readonly generatedAt?: string;
}

export interface BrainCertificate {
  readonly schemaVersion: typeof BRAIN_CERTIFICATE_SCHEMA_VERSION;
  readonly solverVersion: typeof BRAIN_SOLVER_VERSION;
  readonly qualityPolicyVersion: typeof BRAIN_QUALITY_POLICY_VERSION;
  readonly qualityMode: BrainQualityMode;
  readonly levelHash: string;
  readonly stateCount: number;
  readonly transitionCount: number;
  readonly preferredSolution: RetainedSolution;
  readonly features: DifficultyFeatureVector;
  readonly difficulty: DifficultyRating;
  readonly milestones: MilestoneReport;
  readonly macroProjection: MacroProjectionReport;
  readonly interaction: InteractionMetrics;
}

export interface BrainCatalogEntry {
  readonly id: string;
  readonly difficulty: number;
  readonly level: LevelDefinition;
  readonly levelHash: string;
  readonly witness: readonly Direction[];
  readonly milestones: readonly MilestoneSpec[];
  readonly requiredPrecedence: readonly BrainRequiredPrecedence[];
  readonly topologySignature: string;
  readonly semanticSignature: string;
  readonly provenance: BrainProvenance;
  readonly certificate: BrainCertificate;
}

export interface BrainCatalog {
  readonly schemaVersion: typeof BRAIN_CATALOG_SCHEMA_VERSION;
  readonly generatorVersion: "g4";
  readonly brainVersion: string;
  readonly entries: readonly BrainCatalogEntry[];
}

let parsedCatalog: BrainCatalog | undefined;

export function bundledBrainCatalog(): BrainCatalog {
  parsedCatalog ??= parseBrainCatalog(rawCatalog);
  return parsedCatalog;
}

export function parseBrainCatalog(value: unknown): BrainCatalog {
  if (!isRecord(value)) throw new BrainCatalogError("Catalog root must be an object");
  assertExactKeys(value, ["schemaVersion", "generatorVersion", "brainVersion", "entries"], "Catalog root");
  if (value.schemaVersion !== BRAIN_CATALOG_SCHEMA_VERSION) {
    throw new BrainCatalogError("Unsupported HullshiftBrain catalog schema");
  }
  if (value.generatorVersion !== "g4") {
    throw new BrainCatalogError("HullshiftBrain catalog must target g4");
  }
  if (!validToken(value.brainVersion, 80) || !Array.isArray(value.entries)) {
    throw new BrainCatalogError("HullshiftBrain catalog metadata is invalid");
  }

  const ids = new Set<string>();
  const entries = value.entries.map((entry, index) => parseEntry(entry, index));
  entries.sort((left, right) => compareAscii(left.id, right.id));
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new BrainCatalogError(`Duplicate catalog entry id: ${entry.id}`);
    ids.add(entry.id);
  }
  return Object.freeze({
    schemaVersion: BRAIN_CATALOG_SCHEMA_VERSION,
    generatorVersion: "g4",
    brainVersion: value.brainVersion,
    entries: Object.freeze(entries),
  });
}

export function selectBrainCatalogEntry(
  canonicalSeed: string,
  difficulty: number,
  catalog: BrainCatalog = bundledBrainCatalog(),
): BrainCatalogEntry {
  if (!/^[0-9a-f]{16}$/.test(canonicalSeed)) {
    throw new BrainCatalogError("Catalog selection requires a canonical UInt64 seed");
  }
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 8) {
    throw new BrainCatalogError("Catalog selection difficulty must be 0 through 8");
  }
  const band = catalog.entries.filter((entry) => entry.difficulty === difficulty);
  if (band.length === 0) {
    throw new BrainCatalogError(`HullshiftBrain catalog has no difficulty-${difficulty} entries`);
  }
  return band[unbiasedCatalogIndex(canonicalSeed, difficulty, band.length)]!;
}

export function unbiasedCatalogIndex(
  canonicalSeed: string,
  difficulty: number,
  size: number,
): number {
  if (!/^[0-9a-f]{16}$/.test(canonicalSeed)) throw new RangeError("Invalid catalog seed");
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 8) {
    throw new RangeError("Invalid catalog difficulty");
  }
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("Catalog band is empty");
  const space = 1n << 256n;
  const modulus = BigInt(size);
  const limit = space - space % modulus;
  for (let counter = 0; counter < 1_000; counter += 1) {
    const input = `HullshiftBrain/g4/${difficulty}/${canonicalSeed}/${counter}`;
    const value = BigInt(`0x${sha256Hex(encodeUtf8(input))}`);
    if (value < limit) return Number(value % modulus);
  }
  throw new BrainCatalogError("Catalog selection rejection sampling did not terminate");
}

export function createBrainCertificate(
  levelHash: string,
  analysis: AnalysisReport,
  qualityMode: BrainQualityMode = "pilot",
): BrainCertificate {
  if (
    analysis.preferredSolution === null
    || analysis.difficulty === null
    || analysis.macroProjection === undefined
    || analysis.interaction === undefined
  ) {
    throw new BrainCatalogError("Certified g4 analysis lacks proof or interaction data");
  }
  return Object.freeze({
    schemaVersion: BRAIN_CERTIFICATE_SCHEMA_VERSION,
    solverVersion: BRAIN_SOLVER_VERSION,
    qualityPolicyVersion: BRAIN_QUALITY_POLICY_VERSION,
    qualityMode,
    levelHash,
    stateCount: analysis.stateCount,
    transitionCount: analysis.transitionCount,
    preferredSolution: analysis.preferredSolution,
    // Math.log2 and floating division are permitted to differ in their final
    // machine bits across Bun/JSC and browser engines. Certificates bind a
    // frozen 1e-9 representation while all proof-bearing counts remain exact.
    features: quantizeFeatureVector(analysis.features),
    difficulty: Object.freeze({
      ...analysis.difficulty,
      targetDistance: quantizeFloat(analysis.difficulty.targetDistance),
      challengeScore: quantizeFloat(analysis.difficulty.challengeScore),
    }),
    milestones: analysis.milestones,
    macroProjection: analysis.macroProjection,
    interaction: analysis.interaction,
  });
}

export function brainCertificatesEqual(
  expected: BrainCertificate,
  actual: BrainCertificate,
): boolean {
  return stableJson(expected) === stableJson(actual);
}

export class BrainCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainCatalogError";
  }
}

function parseEntry(value: unknown, index: number): BrainCatalogEntry {
  if (!isRecord(value)) throw new BrainCatalogError(`Catalog entry ${index} must be an object`);
  assertExactKeys(value, [
    "id",
    "difficulty",
    "level",
    "levelHash",
    "witness",
    "milestones",
    "requiredPrecedence",
    "topologySignature",
    "semanticSignature",
    "provenance",
    "certificate",
  ], `Catalog entry ${index}`);
  if (!isBrainEntryId(value.id)) throw new BrainCatalogError(`Catalog entry ${index} has invalid id`);
  if (!Number.isInteger(value.difficulty) || (value.difficulty as number) < 0 || (value.difficulty as number) > 8) {
    throw new BrainCatalogError(`Catalog entry ${value.id} has invalid difficulty`);
  }
  if (!isRecord(value.level)) throw new BrainCatalogError(`Catalog entry ${value.id} lacks a level`);
  const level = normalizeBrainLevel(value.level, `Catalog entry ${value.id}.level`);
  if (typeof value.levelHash !== "string" || !/^[0-9a-f]{64}$/.test(value.levelHash)) {
    throw new BrainCatalogError(`Catalog entry ${value.id} has invalid level hash`);
  }
  if (
    !Array.isArray(value.witness)
    || value.witness.length > MAX_BRAIN_WITNESS_ACTIONS
    || !value.witness.every(isDirection)
  ) {
    throw new BrainCatalogError(`Catalog entry ${value.id} has invalid witness`);
  }
  if (!Array.isArray(value.milestones) || !Array.isArray(value.requiredPrecedence)) {
    throw new BrainCatalogError(`Catalog entry ${value.id} has invalid causal contract`);
  }
  const milestones = validateMilestoneSpecs(level, value.milestones);
  const requiredPrecedence = value.requiredPrecedence.map((relation) => {
    if (!isRecord(relation) || !validToken(relation.before, 48) || !validToken(relation.after, 48)) {
      throw new BrainCatalogError(`Catalog entry ${value.id} has invalid precedence relation`);
    }
    return Object.freeze({ before: relation.before, after: relation.after });
  });
  if (!validToken(value.topologySignature, 160) || !validToken(value.semanticSignature, 160)) {
    throw new BrainCatalogError(`Catalog entry ${value.id} has invalid diversity signatures`);
  }
  const provenance = parseProvenance(value.provenance, value.id);
  const certificate = parseCertificate(value.certificate, value.id);
  return Object.freeze({
    id: value.id,
    difficulty: value.difficulty as number,
    level,
    levelHash: value.levelHash,
    witness: Object.freeze([...(value.witness as Direction[])]),
    milestones,
    requiredPrecedence: Object.freeze(requiredPrecedence),
    topologySignature: value.topologySignature,
    semanticSignature: value.semanticSignature,
    provenance,
    certificate,
  });
}

function parseProvenance(value: unknown, id: unknown): BrainProvenance {
  if (isRecord(value)) {
    assertExactKeys(
      value,
      ["masterSeed", "candidateId", "algorithmVersion", "reverseDepth"],
      `Catalog entry ${String(id)}.provenance`,
      ["generatedAt"],
    );
  }
  if (
    !isRecord(value)
    || !validToken(value.masterSeed, 64)
    || !validToken(value.candidateId, 80)
    || !validToken(value.algorithmVersion, 80)
    || !Number.isSafeInteger(value.reverseDepth)
    || (value.reverseDepth as number) < 0
    || (value.generatedAt !== undefined && typeof value.generatedAt !== "string")
  ) {
    throw new BrainCatalogError(`Catalog entry ${String(id)} has invalid provenance`);
  }
  return Object.freeze({
    masterSeed: value.masterSeed,
    candidateId: value.candidateId,
    algorithmVersion: value.algorithmVersion,
    reverseDepth: value.reverseDepth as number,
    ...(value.generatedAt === undefined ? {} : { generatedAt: value.generatedAt }),
  });
}

function parseCertificate(value: unknown, id: unknown): BrainCertificate {
  if (isRecord(value)) {
    assertExactKeys(value, [
      "schemaVersion",
      "solverVersion",
      "qualityPolicyVersion",
      "qualityMode",
      "levelHash",
      "stateCount",
      "transitionCount",
      "preferredSolution",
      "features",
      "difficulty",
      "milestones",
      "macroProjection",
      "interaction",
    ], `Catalog entry ${String(id)}.certificate`);
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== BRAIN_CERTIFICATE_SCHEMA_VERSION
    || value.solverVersion !== BRAIN_SOLVER_VERSION
    || value.qualityPolicyVersion !== BRAIN_QUALITY_POLICY_VERSION
    || (value.qualityMode !== "pilot" && value.qualityMode !== "release")
    || typeof value.levelHash !== "string"
    || !/^[0-9a-f]{64}$/.test(value.levelHash)
    || !Number.isSafeInteger(value.stateCount)
    || (value.stateCount as number) < 1
    || !Number.isSafeInteger(value.transitionCount)
    || (value.transitionCount as number) < 1
    || !isRecord(value.preferredSolution)
    || !isRecord(value.features)
    || !isRecord(value.difficulty)
    || !isRecord(value.milestones)
    || !isRecord(value.macroProjection)
    || !isRecord(value.interaction)
  ) {
    throw new BrainCatalogError(`Catalog entry ${String(id)} has invalid certificate`);
  }
  return cloneAndFreezeJson(value) as unknown as BrainCertificate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirection(value: unknown): value is Direction {
  return value === "N" || value === "E" || value === "S" || value === "W";
}

function validToken(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBrainEntryId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Reject extension fields and rebuild a deeply frozen exact LevelDefinition. */
export function normalizeBrainLevel(value: unknown, path = "level"): LevelDefinition {
  const level = requireRecord(value, path);
  assertExactKeys(
    level,
    ["generatorVersion", "width", "height", "channels", "cells", "playerStart", "objects"],
    path,
  );
  if (!Array.isArray(level.channels) || !Array.isArray(level.cells) || !Array.isArray(level.objects)) {
    throw new BrainCatalogError(`${path} collections must be arrays`);
  }
  const channels = level.channels.map((entry, index) => {
    const channel = requireRecord(entry, `${path}.channels[${index}]`);
    assertExactKeys(channel, ["id", "symbol"], `${path}.channels[${index}]`);
    return Object.freeze({ id: channel.id as string, symbol: channel.symbol as string });
  });
  const cells: LevelDefinition["cells"][number][] = level.cells.map((entry, index) => {
    const cell = requireRecord(entry, `${path}.cells[${index}]`);
    assertExactKeys(cell, ["terrain"], `${path}.cells[${index}]`, ["fixture"]);
    const terrain = cell.terrain as LevelDefinition["cells"][number]["terrain"];
    return cell.fixture === undefined
      ? Object.freeze({ terrain })
      : Object.freeze({
          terrain,
          fixture: normalizeFixture(cell.fixture, `${path}.cells[${index}].fixture`),
        });
  });
  const objects = level.objects.map((entry, index) => {
    const object = requireRecord(entry, `${path}.objects[${index}]`);
    assertExactKeys(object, ["id", "kind", "position"], `${path}.objects[${index}]`);
    return Object.freeze({
      id: object.id as string,
      kind: object.kind as LevelDefinition["objects"][number]["kind"],
      position: normalizeCoord(object.position, `${path}.objects[${index}].position`),
    });
  });
  return Object.freeze({
    generatorVersion: level.generatorVersion as string,
    width: level.width as number,
    height: level.height as number,
    channels: Object.freeze(channels),
    cells: Object.freeze(cells),
    playerStart: normalizeCoord(level.playerStart, `${path}.playerStart`),
    objects: Object.freeze(objects),
  });
}

function normalizeFixture(
  value: unknown,
  path: string,
): NonNullable<LevelDefinition["cells"][number]["fixture"]> {
  const fixture = requireRecord(value, path);
  if (typeof fixture.kind !== "string") throw new BrainCatalogError(`${path}.kind must be a string`);
  const base = ["id", "kind"];
  switch (fixture.kind) {
    case "disposal":
      assertExactKeys(fixture, base, path);
      return Object.freeze({ id: fixture.id as string, kind: "disposal" });
    case "relay":
      assertExactKeys(fixture, [...base, "channel", "initialOn"], path);
      return Object.freeze({
        id: fixture.id as string,
        kind: "relay",
        channel: fixture.channel as string,
        initialOn: fixture.initialOn as boolean,
      });
    case "socket":
      assertExactKeys(fixture, [...base, "channel", "initiallyInstalled"], path, ["initialCellId"]);
      return Object.freeze({
        id: fixture.id as string,
        kind: "socket",
        channel: fixture.channel as string,
        initiallyInstalled: fixture.initiallyInstalled as boolean,
        ...(fixture.initialCellId === undefined ? {} : { initialCellId: fixture.initialCellId as string }),
      });
    case "plate":
    case "door":
    case "bridge":
    case "gate":
      assertExactKeys(fixture, [...base, "channel"], path);
      return Object.freeze({
        id: fixture.id as string,
        kind: fixture.kind,
        channel: fixture.channel as string,
      });
    default:
      throw new BrainCatalogError(`${path}.kind is unsupported`);
  }
}

function normalizeCoord(value: unknown, path: string): Readonly<{ x: number; y: number }> {
  const coord = requireRecord(value, path);
  assertExactKeys(coord, ["x", "y"], path);
  return Object.freeze({ x: coord.x as number, y: coord.y as number });
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BrainCatalogError(`${path} must be an object`);
  return value;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  const extra = keys.find((key) => !allowed.has(key));
  if (missing !== undefined) throw new BrainCatalogError(`${path} is missing '${missing}'`);
  if (extra !== undefined) throw new BrainCatalogError(`${path} has unknown field '${extra}'`);
}

function cloneAndFreezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreezeJson));
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneAndFreezeJson(child)]),
    ));
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function quantizeFeatureVector(features: DifficultyFeatureVector): DifficultyFeatureVector {
  return Object.freeze({
    ...features,
    decisionPressure: quantizeFloat(features.decisionPressure),
    stateSpaceComplexity: quantizeFloat(features.stateSpaceComplexity),
    fatalChoicePressure: quantizeFloat(features.fatalChoicePressure),
  });
}

function quantizeFloat(value: number): number {
  if (!Number.isFinite(value)) throw new BrainCatalogError("Certificate contains a non-finite metric");
  const quantized = Math.round(value * 1_000_000_000) / 1_000_000_000;
  return Object.is(quantized, -0) ? 0 : quantized;
}
