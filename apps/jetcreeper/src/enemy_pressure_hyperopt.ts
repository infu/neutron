import {
  BASELINE_ENEMY_PRESSURE_TUNING,
  ENEMY_PRESSURE_TUNING,
  difficultyForSector,
  resolveEnemyPressureTuning,
  type EnemyPressureTuning,
} from "./game_rules";
import {
  runPressureSimulation,
  type PressureAdmissionMode,
  type PressureSimulationResult,
} from "./pressure_simulation";

export const ENEMY_PRESSURE_OPTIMIZATION_SECTORS = Object.freeze([
  75,
  100,
  125,
  150,
  175,
  185,
  195,
] as const);

export const ENEMY_PRESSURE_SEARCH_SEEDS = Object.freeze([
  0x5eed_0200,
  0xfd24_7bb1,
  0x9b5b_f562,
  0x3993_6f13,
  0xd7ca_e8c4,
  0x7602_6275,
  0x1439_dc26,
  0xb271_55d7,
] as const);

const SECTOR_WEIGHTS: Readonly<Record<number, number>> = Object.freeze({
  75: 0.7,
  100: 0.85,
  125: 1,
  150: 1.15,
  175: 1.3,
  185: 1.4,
  195: 1.5,
});

export interface EnemyPressureSectorMeasurement {
  readonly sector: number;
  readonly runs: number;
  readonly hitRuns: number;
  readonly deaths: number;
  readonly hitRate: number;
  readonly deathRate: number;
  readonly meanDamage: number;
  readonly meanSurvivalSeconds: number;
  readonly meanCollisions: number;
  readonly meanSpawnedThreats: number;
  readonly meanFairnessRejections: number;
  readonly meanGlobalGateRejections: number;
}

export interface EnemyPressureEvaluation {
  readonly tuning: Readonly<EnemyPressureTuning>;
  readonly objectiveScore: number;
  readonly eligible: boolean;
  readonly openingDamage: number;
  readonly terminalDeaths: number;
  readonly capViolations: number;
  readonly measurements: readonly EnemyPressureSectorMeasurement[];
}

export interface EnemyPressureEvaluationOptions {
  readonly seeds?: readonly number[];
  readonly sectors?: readonly number[];
  readonly durationSeconds?: number;
  readonly admissionMode?: PressureAdmissionMode;
}

export interface EnemyPressureSearchProgress {
  readonly index: number;
  readonly total: number;
  readonly evaluation: EnemyPressureEvaluation;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function interpolate(minimum: number, maximum: number, ratio: number): number {
  return minimum + (maximum - minimum) * ratio;
}

function spawnedThreatCount(result: PressureSimulationResult): number {
  return Object.values(result.spawnedByPattern).reduce((total, count) => total + count, 0);
}

function mean(results: readonly PressureSimulationResult[], select: (result: PressureSimulationResult) => number): number {
  return results.reduce((total, result) => total + select(result), 0) / Math.max(1, results.length);
}

function measureSector(
  sector: number,
  results: readonly PressureSimulationResult[],
): EnemyPressureSectorMeasurement {
  const hitRuns = results.filter((result) => result.damageTaken > 0).length;
  const deaths = results.filter((result) => result.gameOver).length;

  return {
    sector,
    runs: results.length,
    hitRuns,
    deaths,
    hitRate: hitRuns / Math.max(1, results.length),
    deathRate: deaths / Math.max(1, results.length),
    meanDamage: mean(results, (result) => result.damageTaken),
    meanSurvivalSeconds: mean(results, (result) => result.survivedSeconds),
    meanCollisions: mean(results, (result) => result.collisions),
    meanSpawnedThreats: mean(results, spawnedThreatCount),
    meanFairnessRejections: mean(results, (result) => result.rejectedForFairness),
    meanGlobalGateRejections: mean(results, (result) => result.rejectedForGlobalPressureGate),
  };
}

function countCapViolations(results: readonly PressureSimulationResult[]): number {
  return results.reduce((violations, result) => {
    const difficulty = difficultyForSector(result.sector);
    return violations
      + Number(result.peakConcurrentThreats > difficulty.maxEnemyProjectiles)
      + Number(result.peakConcurrentRockets > difficulty.maxEnemyRockets);
  }, 0);
}

function scoreMeasurements(
  measurements: readonly EnemyPressureSectorMeasurement[],
  durationSeconds: number,
): number {
  let weightedScore = 0;
  let totalWeight = 0;

  for (const measurement of measurements) {
    const weight = SECTOR_WEIGHTS[measurement.sector] ?? 1;
    const damageRatio = Math.min(1, measurement.meanDamage / 3);
    const survivalPressure = Math.min(
      1,
      Math.max(0, durationSeconds - measurement.meanSurvivalSeconds) / durationSeconds,
    );
    // Hit incidence is the primary target. Damage, deaths, and time-to-loss
    // break ties without rewarding raw spawn count or bypassing fairness.
    const sectorScore = measurement.hitRate * 50
      + damageRatio * 28
      + measurement.deathRate * 17
      + survivalPressure * 5;
    weightedScore += sectorScore * weight;
    totalWeight += weight;
  }

  return weightedScore / Math.max(1, totalWeight);
}

export function evaluateEnemyPressureTuning(
  tuningOverrides: Partial<EnemyPressureTuning>,
  options: EnemyPressureEvaluationOptions = {},
): EnemyPressureEvaluation {
  const tuning = Object.freeze(resolveEnemyPressureTuning(tuningOverrides));
  const seeds = options.seeds ?? ENEMY_PRESSURE_SEARCH_SEEDS;
  const sectors = options.sectors ?? ENEMY_PRESSURE_OPTIMIZATION_SECTORS;
  const durationSeconds = options.durationSeconds ?? 6;
  const admissionMode = options.admissionMode ?? "runtime";
  const allResults: PressureSimulationResult[] = [];
  const measurements = sectors.map((sector) => {
    const results = seeds.map((seed) => runPressureSimulation({
      sector,
      seed,
      durationSeconds,
      admissionMode,
      hostileTuning: tuning,
    }));
    allResults.push(...results);
    return measureSector(sector, results);
  });
  const opening = seeds.map((seed) => runPressureSimulation({
    sector: 1,
    seed,
    durationSeconds,
    admissionMode: "runtime",
    hostileTuning: tuning,
  }));
  const terminal = seeds.map((seed) => runPressureSimulation({
    sector: 200,
    seed,
    durationSeconds,
    admissionMode: "runtime",
    hostileTuning: tuning,
  }));
  allResults.push(...opening, ...terminal);
  const openingDamage = opening.reduce((total, result) => total + result.damageTaken, 0);
  const terminalDeaths = terminal.filter((result) => result.gameOver).length;
  const capViolations = countCapViolations(allResults);
  const eligible = openingDamage === 0
    && terminalDeaths === seeds.length
    && capViolations === 0;

  return {
    tuning,
    objectiveScore: eligible
      ? scoreMeasurements(measurements, durationSeconds)
      : Number.NEGATIVE_INFINITY,
    eligible,
    openingDamage,
    terminalDeaths,
    capViolations,
    measurements,
  };
}

/**
 * Generates a deterministic bounded random search. Baseline, installed
 * winner, and a high-pressure boundary candidate are always included for
 * comparability and exact reproduction of the refinement pass.
 */
export function generateEnemyPressureCandidates(
  randomCandidateCount = 24,
  seed = 0x0bad_5eed,
): readonly Readonly<EnemyPressureTuning>[] {
  const count = Math.max(0, Math.min(96, Math.floor(randomCandidateCount)));
  const random = seededRandom(seed);
  const candidates: EnemyPressureTuning[] = [
    { ...BASELINE_ENEMY_PRESSURE_TUNING },
    { ...ENEMY_PRESSURE_TUNING },
    {
      horizontalAimLeadSeconds: 0.25,
      verticalAimLeadSeconds: 0.2,
      aimJitterScale: 0.35,
      volleySpreadScale: 0.72,
      fireCadenceScale: 0.75,
      volleyDensityScale: 1.5,
      rocketCadenceScale: 0.65,
      rocketSpeedScale: 1.1,
      rocketHomingStrength: 1.15,
      rocketHomingSeconds: 3.6,
      formationChanceAtTerminal: 0.9,
    },
  ];

  for (let index = 0; index < count; index += 1) {
    candidates.push({
      horizontalAimLeadSeconds: interpolate(0.1, 0.4, random()),
      verticalAimLeadSeconds: interpolate(0.08, 0.34, random()),
      aimJitterScale: interpolate(0.35, 1, random()),
      volleySpreadScale: interpolate(0.5, 1.28, random()),
      fireCadenceScale: interpolate(0.75, 1, random()),
      volleyDensityScale: interpolate(1, 1.5, random()),
      rocketCadenceScale: interpolate(0.65, 1, random()),
      rocketSpeedScale: interpolate(0.94, 1.12, random()),
      rocketHomingStrength: interpolate(0.82, 1.15, random()),
      rocketHomingSeconds: interpolate(2.8, 3.6, random()),
      formationChanceAtTerminal: interpolate(0.8, 0.9, random()),
    });
  }

  return Object.freeze(candidates.map((candidate) => Object.freeze(candidate)));
}

export function searchEnemyPressureTuning(
  candidates: readonly Partial<EnemyPressureTuning>[],
  options: EnemyPressureEvaluationOptions = {},
  onProgress?: (progress: EnemyPressureSearchProgress) => void,
): readonly EnemyPressureEvaluation[] {
  const evaluations = candidates.map((candidate, index) => {
    const evaluation = evaluateEnemyPressureTuning(candidate, options);
    onProgress?.({ index, total: candidates.length, evaluation });
    return evaluation;
  });

  return evaluations.sort((first, second) => (
    Number(second.eligible) - Number(first.eligible)
    || second.objectiveScore - first.objectiveScore
  ));
}
