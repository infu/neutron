export const FIRST_NORMAL_WAVE_COUNT = 4 as const;
export const MINIMUM_NORMAL_WAVE_COUNT = 3 as const;
export const MAXIMUM_NORMAL_WAVE_COUNT = 4 as const;

export type NormalWaveCount = typeof MINIMUM_NORMAL_WAVE_COUNT | typeof MAXIMUM_NORMAL_WAVE_COUNT;
export type EncounterPhase = "normal-waves" | "boss-pending" | "boss";

export interface EncounterCadenceState {
  readonly phase: EncounterPhase;
  readonly bossesDefeated: number;
  readonly clearedNormalWaves: number;
  readonly requiredNormalWaves: NormalWaveCount;
}

export function normalWaveCountAfterBosses(bossesDefeated: number): NormalWaveCount {
  const safeDefeats = Number.isFinite(bossesDefeated)
    ? Math.max(0, Math.floor(bossesDefeated))
    : 0;
  return safeDefeats % 2 === 0 ? MAXIMUM_NORMAL_WAVE_COUNT : MINIMUM_NORMAL_WAVE_COUNT;
}

export function createEncounterCadence(): EncounterCadenceState {
  return {
    phase: "normal-waves",
    bossesDefeated: 0,
    clearedNormalWaves: 0,
    requiredNormalWaves: FIRST_NORMAL_WAVE_COUNT,
  };
}

export function recordNormalWaveClear(state: EncounterCadenceState): EncounterCadenceState {
  if (state.phase !== "normal-waves") {
    return state;
  }

  const clearedNormalWaves = Math.min(
    state.requiredNormalWaves,
    state.clearedNormalWaves + 1,
  );
  return {
    ...state,
    phase: clearedNormalWaves >= state.requiredNormalWaves ? "boss-pending" : "normal-waves",
    clearedNormalWaves,
  };
}

export function beginBossEncounter(state: EncounterCadenceState): EncounterCadenceState {
  return state.phase === "boss-pending" ? { ...state, phase: "boss" } : state;
}

export function recordBossDefeat(state: EncounterCadenceState): EncounterCadenceState {
  if (state.phase !== "boss") {
    return state;
  }

  const bossesDefeated = state.bossesDefeated + 1;
  return {
    phase: "normal-waves",
    bossesDefeated,
    clearedNormalWaves: 0,
    requiredNormalWaves: normalWaveCountAfterBosses(bossesDefeated),
  };
}

/** Later waves deliberately contain more units while staying below boss pressure. */
export function normalWaveSpawnCount(state: EncounterCadenceState): number {
  const waveNumber = Math.min(
    state.requiredNormalWaves,
    Math.max(1, state.clearedNormalWaves + 1),
  );
  return 7 + (waveNumber - 1) * 3 + Math.min(6, state.bossesDefeated);
}
