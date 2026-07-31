import {
  brainCertificatesEqual,
  BrainCatalogError,
  createBrainCertificate,
  selectBrainCatalogEntry,
} from "./brain_catalog.ts";
import type { DifficultyRating } from "./difficulty.ts";
import { assertValidLevel } from "./mechanics.ts";
import type { LevelDefinition } from "./model.ts";
import { formatCanonicalSeed, parseCanonicalSeed } from "./prng.ts";
import {
  encodeShareCode,
  GENERATOR_VERSION,
  type GeneratorVersion,
} from "./share_code.ts";
import { canonicalLevelHash } from "./simulation.ts";
import {
  analyzeLevel,
  replayWitness,
  type AnalysisReport,
  type SolverProgress,
} from "./solver.ts";

export const MAP_GENERATION_UNAVAILABLE_MESSAGE =
  "No certified HullshiftBrain map is available for this difficulty";

export interface GenerationProgress {
  readonly stage: "starting" | SolverProgress["stage"] | "complete";
  readonly completed: number;
  readonly total: number;
  readonly detail?: string;
}

export interface GenerationHooks {
  readonly onProgress?: (progress: GenerationProgress) => void;
  readonly shouldCancel?: () => boolean;
  readonly yieldControl?: () => Promise<void>;
}

export interface GenerateLevelRequest {
  readonly generatorVersion?: GeneratorVersion;
  readonly seed: bigint | string;
  readonly difficulty: number;
}

export interface GeneratedIdentity {
  readonly generatorVersion: GeneratorVersion;
  readonly seed: string;
  readonly difficulty: number;
}

export interface GeneratedLevel {
  readonly identity: GeneratedIdentity;
  readonly level: LevelDefinition;
  readonly levelHash: string;
  readonly shareCode: string;
  readonly analysis: AnalysisReport;
  readonly difficulty: DifficultyRating;
}

export class MapGenerationUnavailableError extends Error {
  constructor(message = MAP_GENERATION_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "MapGenerationUnavailableError";
  }
}

export class GenerationCertificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationCertificationError";
  }
}

export class GenerationCancelledError extends Error {
  constructor() {
    super("Hullshift map generation was cancelled");
    this.name = "GenerationCancelledError";
  }
}

/**
 * Deterministically select and independently re-certify a frozen offline
 * HullshiftBrain level. Python performs expensive content search offline; this
 * browser boundary continues to trust only production mechanics and analysis.
 */
export async function generateLevel(
  request: GenerateLevelRequest,
  hooks: GenerationHooks = {},
): Promise<GeneratedLevel> {
  checkCancelled(hooks);
  const generatorVersion = request.generatorVersion ?? GENERATOR_VERSION;
  if (generatorVersion !== GENERATOR_VERSION || generatorVersion !== "g4") {
    throw new GenerationCertificationError(
      `Generator ${generatorVersion} is frozen and cannot create new missions`,
    );
  }
  const seed = normalizeSeed(request.seed);
  const canonicalSeed = formatCanonicalSeed(seed);
  if (!Number.isInteger(request.difficulty) || request.difficulty < 0 || request.difficulty > 8) {
    throw new RangeError("Hullshift difficulty must be 0 through 8");
  }

  hooks.onProgress?.({
    stage: "starting",
    completed: 0,
    total: 1,
    detail: "Selecting a certified HullshiftBrain mission",
  });
  await hooks.yieldControl?.();
  checkCancelled(hooks);

  let entry;
  try {
    entry = selectBrainCatalogEntry(canonicalSeed, request.difficulty);
  } catch (reason) {
    if (reason instanceof BrainCatalogError) {
      throw new MapGenerationUnavailableError(reason.message);
    }
    throw reason;
  }
  const level = structuredClone(entry.level);
  if (level.generatorVersion !== generatorVersion) {
    throw new GenerationCertificationError("Catalog level has the wrong generator version");
  }
  assertValidLevel(level);
  const levelHash = canonicalLevelHash(level);
  if (levelHash !== entry.levelHash || entry.certificate.levelHash !== levelHash) {
    throw new GenerationCertificationError("Catalog level failed its canonical hash certificate");
  }
  replayWitness(level, entry.witness);
  checkCancelled(hooks);

  const analysis = await analyzeLevel(level, {
    milestoneSpecs: entry.milestones,
    requestedDifficulty: request.difficulty,
    ...(hooks.onProgress === undefined ? {} : { onProgress: hooks.onProgress }),
    ...(hooks.shouldCancel === undefined ? {} : { shouldCancel: hooks.shouldCancel }),
    ...(hooks.yieldControl === undefined ? {} : { yieldControl: hooks.yieldControl }),
  });
  checkCancelled(hooks);
  if (!analysis.solvable || analysis.preferredSolution === null || analysis.difficulty === null) {
    throw new GenerationCertificationError("Catalog level is not exactly solvable");
  }
  if (!analysis.difficulty.profileMatch || analysis.difficulty.ratedDifficulty !== request.difficulty) {
    throw new GenerationCertificationError(
      `Catalog level no longer matches difficulty ${request.difficulty}: ${analysis.difficulty.hardViolations.join(", ")}`,
    );
  }

  const mandatory = new Set(analysis.milestones.mandatoryIds);
  for (const milestone of entry.milestones) {
    if (!mandatory.has(milestone.id)) {
      throw new GenerationCertificationError(`Catalog milestone is bypassable: ${milestone.id}`);
    }
  }
  const precedence = new Set(
    analysis.milestones.precedence.map((relation) => `${relation.before}\0${relation.after}`),
  );
  for (const relation of entry.requiredPrecedence) {
    if (!precedence.has(`${relation.before}\0${relation.after}`)) {
      throw new GenerationCertificationError(
        `Catalog dependency is bypassable: ${relation.before} -> ${relation.after}`,
      );
    }
  }

  const actualCertificate = createBrainCertificate(
    levelHash,
    analysis,
    entry.certificate.qualityMode,
  );
  if (!brainCertificatesEqual(entry.certificate, actualCertificate)) {
    throw new GenerationCertificationError("Catalog exact-analysis certificate is stale");
  }

  const identity = Object.freeze({
    generatorVersion,
    seed: canonicalSeed,
    difficulty: request.difficulty,
  });
  hooks.onProgress?.({
    stage: "complete",
    completed: 1,
    total: 1,
    detail: `Certified catalog mission ${entry.id}`,
  });
  return Object.freeze({
    identity,
    level,
    levelHash,
    shareCode: encodeShareCode({ generatorVersion, seed, difficulty: request.difficulty }),
    analysis,
    difficulty: analysis.difficulty,
  });
}

function normalizeSeed(seed: bigint | string): bigint {
  if (typeof seed !== "bigint") return parseCanonicalSeed(seed);
  // Validate the UInt64 range without reparsing the canonical hexadecimal text
  // as a decimal bigint (or rejecting seeds containing a-f).
  formatCanonicalSeed(seed);
  return seed;
}

function checkCancelled(hooks: GenerationHooks): void {
  if (hooks.shouldCancel?.() === true) throw new GenerationCancelledError();
}
