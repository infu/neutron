import {
  enemyArchetypeForKind,
  enemyKindsForSector,
  type BossArchetype,
  type BossPhase,
  type EnemyKind,
} from "./game_rules.ts";

export const BOSS_ESCORT_HEALTH_THRESHOLDS = Object.freeze([0.75, 0.5, 0.25] as const);
export const BOSS_ESCORT_WAVE_COUNT = BOSS_ESCORT_HEALTH_THRESHOLDS.length;
export const BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION = 7.5;

export type BossEscortWaveNumber = 1 | 2 | 3;
export type BossEscortFormation = "split-vanguard" | "staggered-pincer" | "closing-diamond";

export interface BossEscortUnitPlan {
  readonly kind: EnemyKind;
  readonly elite: boolean;
  /** Horizontal position within the foreground cave aperture, from -1 to 1. */
  readonly normalizedLane: number;
  /** Delay after the wave announcement, keeping the entrance readable. */
  readonly entryDelaySeconds: number;
}

export interface BossEscortWavePlan {
  readonly number: BossEscortWaveNumber;
  readonly formation: BossEscortFormation;
  readonly announcement: string;
  readonly triggerHealthRatio: number;
  readonly minEncounterSeconds: number;
  readonly minSecondsAfterPreviousWave: number;
  readonly minimumPlayerSeparation: number;
  readonly plannedSize: number;
  readonly units: readonly BossEscortUnitPlan[];
}

export interface BossEscortProgress {
  readonly launchedWaves: 0 | 1 | 2 | 3;
  readonly lastLaunchAtSeconds: number;
}

export interface BossEscortEncounterState {
  readonly sector: number;
  readonly archetype: BossArchetype;
  readonly entering: boolean;
  readonly encounterSeconds: number;
  readonly bossHealth: number;
  readonly bossMaxHealth: number;
  readonly bossPhase: BossPhase;
  readonly availableEnemySlots: number;
}

export interface BossEscortDamageGateState {
  readonly launchedWaves: 0 | 1 | 2 | 3;
  readonly pendingEscortUnits: number;
}

export interface BossEscortDamageOutcome {
  readonly health: number;
  readonly minimumHealth: number;
  readonly gated: boolean;
}

export interface BossEscortDamageBudget {
  readonly minimumHealth: number;
  readonly damageBudget: number;
  readonly damageable: boolean;
}

const ESCORT_KINDS = Object.freeze([
  "fighter",
  "interceptor",
  "bomber",
  "gunship",
  "carrier",
  "phantom",
  "corsair",
  "bulwark",
  "shifter",
  "leech",
  "splitter",
  "warden",
  "rammer",
  "stalker",
  "chronodrone",
  "commander",
] as const satisfies readonly EnemyKind[]);

const WAVE_PREFERENCES: Readonly<
  Record<BossArchetype, readonly [readonly EnemyKind[], readonly EnemyKind[], readonly EnemyKind[]]>
> = Object.freeze({
  ravager: [
    ["corsair", "fighter", "interceptor", "bomber", "gunship"],
    ["splitter", "interceptor", "fighter", "gunship", "phantom"],
    ["rammer", "gunship", "bomber", "interceptor", "fighter", "phantom"],
  ],
  stormwing: [
    ["shifter", "interceptor", "fighter", "bomber", "phantom"],
    ["stalker", "bomber", "interceptor", "gunship", "fighter"],
    ["chronodrone", "phantom", "gunship", "fighter", "interceptor", "bomber"],
  ],
  dreadnought: [
    ["bulwark", "bomber", "fighter", "gunship", "interceptor"],
    ["warden", "gunship", "bomber", "carrier", "fighter"],
    ["rammer", "commander", "carrier", "gunship", "bomber", "interceptor", "fighter"],
  ],
  prism: [
    ["shifter", "interceptor", "gunship", "fighter", "phantom"],
    ["stalker", "phantom", "gunship", "interceptor", "bomber"],
    ["chronodrone", "gunship", "phantom", "bomber", "fighter", "interceptor"],
  ],
  harvester: [
    ["leech", "bomber", "interceptor", "carrier", "fighter"],
    ["warden", "carrier", "gunship", "phantom", "interceptor"],
    ["commander", "leech", "phantom", "carrier", "gunship", "bomber", "fighter"],
  ],
  chronarch: [
    ["chronodrone", "shifter", "corsair", "interceptor", "fighter"],
    ["warden", "stalker", "leech", "gunship", "bomber"],
    ["commander", "chronodrone", "shifter", "phantom", "carrier", "fighter"],
  ],
});

const WAVE_LANES: Readonly<Record<BossEscortWaveNumber, readonly number[]>> = Object.freeze({
  1: [-0.58, 0.58, -0.2, 0.2],
  2: [-0.72, 0, 0.72, -0.36, 0.36],
  3: [0, -0.48, 0.48, -0.78, 0.78, 0.24],
});

function normalizedSector(sector: number): number {
  return Number.isFinite(sector) ? Math.max(1, Math.floor(sector)) : 1;
}

function waveSize(sector: number, wave: BossEscortWaveNumber): number {
  const bossProgress = Math.max(0, normalizedSector(sector) - 5);

  if (wave === 1) {
    return Math.min(4, 2 + Math.floor(bossProgress / 40));
  }

  if (wave === 2) {
    return Math.min(5, 3 + Math.floor(bossProgress / 32));
  }

  return Math.min(6, 4 + Math.floor(bossProgress / 28));
}

function availablePreference(
  sector: number,
  archetype: BossArchetype,
  wave: BossEscortWaveNumber,
): readonly EnemyKind[] {
  const unlocked = new Set(enemyKindsForSector(sector));
  const preferences = WAVE_PREFERENCES[archetype];
  const preference = preferences[wave - 1] ?? [];
  const candidates = preference.filter((kind) => unlocked.has(kind));

  if (candidates.length > 0) {
    return candidates;
  }

  // Every boss sector has the fighter unlocked, but retaining this fallback
  // makes malformed/non-finite inputs deterministic and safe as well.
  return ESCORT_KINDS.filter((kind) => unlocked.has(kind)).slice(0, 1).length > 0
    ? ESCORT_KINDS.filter((kind) => unlocked.has(kind))
    : ["fighter"];
}

function eliteCount(sector: number, wave: BossEscortWaveNumber, size: number): number {
  if (wave === 1) {
    return Math.min(size - 1, Math.floor(Math.max(0, normalizedSector(sector) - 45) / 65));
  }

  if (wave === 2) {
    return Math.min(size - 1, 1 + Math.floor(Math.max(0, normalizedSector(sector) - 70) / 65));
  }

  return Math.min(size - 1, 1 + Math.floor(Math.max(0, normalizedSector(sector) - 40) / 55));
}

function buildUnits(
  sector: number,
  archetype: BossArchetype,
  wave: BossEscortWaveNumber,
): readonly BossEscortUnitPlan[] {
  const size = waveSize(sector, wave);
  const candidates = availablePreference(sector, archetype, wave);
  const lanes = WAVE_LANES[wave];
  const elites = eliteCount(sector, wave, size);

  return Object.freeze(Array.from({ length: size }, (_, index) => {
    const kind = candidates[index % candidates.length] ?? "fighter";
    return Object.freeze({
      kind,
      elite: index < elites,
      normalizedLane: lanes[index] ?? 0,
      entryDelaySeconds: index * (wave === 1 ? 0.3 : wave === 2 ? 0.24 : 0.2),
    });
  }));
}

export function bossEscortWavesForEncounter(
  sector: number,
  archetype: BossArchetype,
): readonly [BossEscortWavePlan, BossEscortWavePlan, BossEscortWavePlan] {
  const firstUnits = buildUnits(sector, archetype, 1);
  const secondUnits = buildUnits(sector, archetype, 2);
  const thirdUnits = buildUnits(sector, archetype, 3);

  return Object.freeze([
    Object.freeze({
      number: 1,
      formation: "split-vanguard",
      announcement: "Escort wave 1 · flankers inbound",
      triggerHealthRatio: BOSS_ESCORT_HEALTH_THRESHOLDS[0],
      minEncounterSeconds: 2.4,
      minSecondsAfterPreviousWave: 0,
      minimumPlayerSeparation: BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION,
      plannedSize: firstUnits.length,
      units: firstUnits,
    }),
    Object.freeze({
      number: 2,
      formation: "staggered-pincer",
      announcement: "Escort wave 2 · pincer inbound",
      triggerHealthRatio: BOSS_ESCORT_HEALTH_THRESHOLDS[1],
      minEncounterSeconds: 6.5,
      minSecondsAfterPreviousWave: 4,
      minimumPlayerSeparation: BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION,
      plannedSize: secondUnits.length,
      units: secondUnits,
    }),
    Object.freeze({
      number: 3,
      formation: "closing-diamond",
      announcement: "Escort wave 3 · final guard inbound",
      triggerHealthRatio: BOSS_ESCORT_HEALTH_THRESHOLDS[2],
      minEncounterSeconds: 10.5,
      minSecondsAfterPreviousWave: 4,
      minimumPlayerSeparation: BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION,
      plannedSize: thirdUnits.length,
      units: thirdUnits,
    }),
  ]);
}

export function createBossEscortProgress(): BossEscortProgress {
  return Object.freeze({ launchedWaves: 0, lastLaunchAtSeconds: Number.NEGATIVE_INFINITY });
}

/**
 * Returns the next staged wave only. A later health threshold can never skip
 * wave one, and a capacity pinch defers a wave rather than overflowing the
 * global enemy cap or turning it into a one-unit trickle.
 */
export function nextBossEscortWave(
  progress: BossEscortProgress,
  encounter: BossEscortEncounterState,
): BossEscortWavePlan | null {
  if (encounter.entering || progress.launchedWaves === BOSS_ESCORT_WAVE_COUNT) {
    return null;
  }

  const waves = bossEscortWavesForEncounter(encounter.sector, encounter.archetype);
  const wave = waves[progress.launchedWaves];

  if (!wave) {
    return null;
  }
  const encounterSeconds = Number.isFinite(encounter.encounterSeconds)
    ? Math.max(0, encounter.encounterSeconds)
    : 0;
  const maximumHealth = Number.isFinite(encounter.bossMaxHealth)
    ? Math.max(1, encounter.bossMaxHealth)
    : 1;
  const health = Number.isFinite(encounter.bossHealth)
    ? Math.max(0, encounter.bossHealth)
    : maximumHealth;
  // Damage gates clamp to this exact product. Comparing a divided ratio back
  // to the decimal trigger can round one ULP high (for example 0.42 becomes
  // 0.42000000000000004), permanently preventing the matching wave. Compare
  // in health space so every gate produced by applyBossEscortDamageGate is
  // guaranteed to release its wave.
  const triggerHealth = maximumHealth * wave.triggerHealthRatio;
  const elapsedSincePrevious = encounterSeconds - progress.lastLaunchAtSeconds;
  const availableSlots = Number.isFinite(encounter.availableEnemySlots)
    ? Math.max(0, Math.floor(encounter.availableEnemySlots))
    : 0;
  const minimumReadableFormation = Math.min(2, wave.units.length);

  if (
    encounterSeconds < wave.minEncounterSeconds ||
    health > triggerHealth ||
    elapsedSincePrevious < wave.minSecondsAfterPreviousWave ||
    availableSlots < minimumReadableFormation
  ) {
    return null;
  }

  const fittedUnits = Object.freeze(wave.units.slice(0, availableSlots));
  return Object.freeze({ ...wave, units: fittedUnits });
}

export function recordBossEscortWaveLaunch(
  progress: BossEscortProgress,
  wave: BossEscortWavePlan,
  encounterSeconds: number,
): BossEscortProgress {
  const expectedWave = progress.launchedWaves + 1;

  if (wave.number !== expectedWave || progress.launchedWaves >= BOSS_ESCORT_WAVE_COUNT) {
    return progress;
  }

  return Object.freeze({
    launchedWaves: wave.number,
    lastLaunchAtSeconds: Number.isFinite(encounterSeconds) ? Math.max(0, encounterSeconds) : 0,
  });
}

export function isBossEscortKind(kind: EnemyKind): boolean {
  return ESCORT_KINDS.includes(kind as typeof ESCORT_KINDS[number]);
}

export function isBossEscortKindUnlocked(kind: EnemyKind, sector: number): boolean {
  return isBossEscortKind(kind) && enemyArchetypeForKind(kind).unlockSector <= normalizedSector(sector);
}

export function bossEscortSafeEntryY(
  playerY: number,
  worldTop: number,
  unitRadius: number,
  minimumPlayerSeparation = BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION,
): number {
  const safeWorldTop = Number.isFinite(worldTop) ? worldTop : 0;
  const safePlayerY = Number.isFinite(playerY) ? playerY : safeWorldTop;
  const safeRadius = Number.isFinite(unitRadius) ? Math.max(0, unitRadius) : 0;
  const safeSeparation = Number.isFinite(minimumPlayerSeparation)
    ? Math.max(0, minimumPlayerSeparation)
    : BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION;

  return Math.max(
    safeWorldTop + 3.5 + safeRadius,
    safePlayerY + safeSeparation + safeRadius,
  );
}

/**
 * Keeps burst damage from skipping any readable escort beat. The final
 * one-percent floor exists only while wave three's staggered entrants are still
 * queued; once their entrance cues have played, escorts never gate the kill.
 */
export function applyBossEscortDamageGate(
  currentHealth: number,
  maximumHealth: number,
  damage: number,
  state: BossEscortDamageGateState,
): BossEscortDamageOutcome {
  const safeMaximum = Number.isFinite(maximumHealth) ? Math.max(1, maximumHealth) : 1;
  const safeCurrent = Number.isFinite(currentHealth)
    ? Math.min(safeMaximum, Math.max(0, currentHealth))
    : safeMaximum;
  const safeDamage = Number.isFinite(damage) ? Math.max(0, damage) : 0;
  const pendingUnits = Number.isFinite(state.pendingEscortUnits)
    ? Math.max(0, Math.floor(state.pendingEscortUnits))
    : 0;
  const nextWaveThreshold = state.launchedWaves < BOSS_ESCORT_WAVE_COUNT
    ? (BOSS_ESCORT_HEALTH_THRESHOLDS as readonly number[])[state.launchedWaves]
    : undefined;
  const minimumHealth = nextWaveThreshold === undefined
    ? pendingUnits > 0
      ? Math.max(1, safeMaximum * 0.01)
      : 0
    : safeMaximum * nextWaveThreshold;
  const rawHealth = Math.max(0, safeCurrent - safeDamage);
  const health = Math.max(minimumHealth, rawHealth);

  return Object.freeze({
    health,
    minimumHealth,
    gated: health > rawHealth,
  });
}

/**
 * Returns only the health currently available to player weapons. A zero budget
 * means targeting should move to escorts until the encounter advances its gate.
 */
export function bossEscortDamageBudget(
  currentHealth: number,
  maximumHealth: number,
  state: BossEscortDamageGateState,
): BossEscortDamageBudget {
  const safeMaximum = Number.isFinite(maximumHealth) ? Math.max(1, maximumHealth) : 1;
  const safeCurrent = Number.isFinite(currentHealth)
    ? Math.min(safeMaximum, Math.max(0, currentHealth))
    : safeMaximum;
  const gate = applyBossEscortDamageGate(safeCurrent, safeMaximum, 0, state);
  const damageBudget = Math.max(0, safeCurrent - gate.minimumHealth);

  return Object.freeze({
    minimumHealth: gate.minimumHealth,
    damageBudget,
    damageable: damageBudget > 0,
  });
}
