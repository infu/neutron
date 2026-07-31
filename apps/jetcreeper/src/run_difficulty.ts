export const RUN_DIFFICULTY_LEVELS = Object.freeze([
  "easy",
  "medium",
  "hard",
] as const);

export type RunDifficultyLevel = typeof RUN_DIFFICULTY_LEVELS[number];

export interface RunDifficultyProfile {
  readonly level: RunDifficultyLevel;
  readonly label: string;
  readonly summary: string;
  readonly enemyParticleMultiplier: number;
  readonly hostileFireCadenceMultiplier: number;
  readonly hostileVolleyMultiplier: number;
  readonly hostileProjectileSpeedMultiplier: number;
  readonly hostileProjectileCapMultiplier: number;
  readonly bossHealthMultiplier: number;
  readonly crateSpawnRateMultiplier: number;
}

export const DEFAULT_RUN_DIFFICULTY: RunDifficultyLevel = "hard";

export const RUN_DIFFICULTY_PROFILES: Readonly<Record<RunDifficultyLevel, Readonly<RunDifficultyProfile>>> = Object.freeze({
  easy: Object.freeze({
    level: "easy",
    label: "Easy",
    summary: "−55% hostile shots · −25% speed · −30% boss hull · +15% crates",
    enemyParticleMultiplier: 0.5,
    hostileFireCadenceMultiplier: 0.7,
    hostileVolleyMultiplier: 0.65,
    hostileProjectileSpeedMultiplier: 0.75,
    hostileProjectileCapMultiplier: 0.5,
    bossHealthMultiplier: 0.7,
    crateSpawnRateMultiplier: 1.15,
  }),
  medium: Object.freeze({
    level: "medium",
    label: "Medium",
    summary: "−20% hostile shots · −10% speed · −20% boss hull · +10% crates",
    enemyParticleMultiplier: 0.8,
    hostileFireCadenceMultiplier: 0.9,
    hostileVolleyMultiplier: 0.9,
    hostileProjectileSpeedMultiplier: 0.9,
    hostileProjectileCapMultiplier: 0.8,
    bossHealthMultiplier: 0.8,
    crateSpawnRateMultiplier: 1.1,
  }),
  hard: Object.freeze({
    level: "hard",
    label: "Hard",
    summary: "Current balance",
    enemyParticleMultiplier: 1,
    hostileFireCadenceMultiplier: 1,
    hostileVolleyMultiplier: 1,
    hostileProjectileSpeedMultiplier: 1,
    hostileProjectileCapMultiplier: 1,
    bossHealthMultiplier: 1,
    crateSpawnRateMultiplier: 1,
  }),
});

export function runDifficultyProfile(
  level: RunDifficultyLevel,
): Readonly<RunDifficultyProfile> {
  return RUN_DIFFICULTY_PROFILES[level];
}

export function scaledBossHealth(
  baseHealth: number,
  level: RunDifficultyLevel,
): number {
  const safeHealth = Number.isFinite(baseHealth) ? Math.max(1, baseHealth) : 1;
  return Math.max(1, Math.round(
    safeHealth * runDifficultyProfile(level).bossHealthMultiplier,
  ));
}

/** A higher crate rate means a proportionally shorter interval. */
export function scaledCrateSpawnDelay(
  baseDelaySeconds: number,
  level: RunDifficultyLevel,
): number {
  const safeDelay = Number.isFinite(baseDelaySeconds) ? Math.max(0, baseDelaySeconds) : 0;
  return safeDelay / runDifficultyProfile(level).crateSpawnRateMultiplier;
}

/** A lower fire cadence produces proportionally longer pauses between volleys. */
export function scaledHostileFireDelay(
  baseDelaySeconds: number,
  level: RunDifficultyLevel,
): number {
  const safeDelay = Number.isFinite(baseDelaySeconds) ? Math.max(0, baseDelaySeconds) : 0;
  return safeDelay / runDifficultyProfile(level).hostileFireCadenceMultiplier;
}

/** Keeps each fan/ring coherent while reducing how many damaging shots it contains. */
export function scaledHostileVolleyCount(
  baseCount: number,
  level: RunDifficultyLevel,
): number {
  const safeCount = Number.isFinite(baseCount) ? Math.max(0, Math.floor(baseCount)) : 0;
  if (safeCount === 0) return 0;
  return Math.max(1, Math.round(
    safeCount * runDifficultyProfile(level).hostileVolleyMultiplier,
  ));
}

export function scaledHostileProjectileSpeed(
  baseSpeed: number,
  level: RunDifficultyLevel,
): number {
  const safeSpeed = Number.isFinite(baseSpeed) ? Math.max(0, baseSpeed) : 0;
  return safeSpeed * runDifficultyProfile(level).hostileProjectileSpeedMultiplier;
}

/** Active-shot and rocket limits share this multiplier; live shots are never removed. */
export function scaledHostileProjectileCap(
  baseCap: number,
  level: RunDifficultyLevel,
): number {
  const safeCap = Number.isFinite(baseCap) ? Math.max(0, Math.floor(baseCap)) : 0;
  if (safeCap === 0) return 0;
  return Math.max(1, Math.floor(
    safeCap * runDifficultyProfile(level).hostileProjectileCapMultiplier,
  ));
}

/** Scales only hostile impact shards; telegraph rings and friendly effects stay readable. */
export function enemyImpactShardCount(
  baseCount: number,
  level: RunDifficultyLevel,
): number {
  const safeCount = Number.isFinite(baseCount) ? Math.max(0, Math.floor(baseCount)) : 0;
  if (safeCount === 0) return 0;
  return Math.max(1, Math.round(
    safeCount * runDifficultyProfile(level).enemyParticleMultiplier,
  ));
}
