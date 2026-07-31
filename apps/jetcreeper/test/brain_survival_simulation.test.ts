import { expect, test } from "bun:test";
import {
  BRAIN_SURVIVAL_MECHANICS,
  BRAIN_SURVIVAL_SEARCH_SEEDS,
  BRAIN_SURVIVAL_TARGET_SECTOR,
  evaluateBrainSurvivalConfig,
  runBrainSurvivalSimulation,
} from "../src/brain_survival_simulation.ts";
import { JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS } from "../src/abilities.ts";
import { BOSS_ESCORT_HEALTH_THRESHOLDS } from "../src/boss_escorts.ts";
import {
  BOSS_ARCHETYPES,
  difficultyForSector,
  enemyKindsForSector,
} from "../src/game_rules.ts";
import {
  LOW_PROFILE_HOSTILE_TIME_SCALE,
  LOW_PROFILE_PLAYER_SPEED_MULTIPLIER,
  LOW_PROFILE_TIME_WARP_SECONDS,
} from "../src/laser_rules.ts";

const WINNER = evaluateBrainSurvivalConfig();

test("dense cave survival benchmark is deterministic at current hostile caps and roster", () => {
  const first = WINNER.results[0];
  expect(first).toBeDefined();
  const replay = runBrainSurvivalSimulation({ seed: BRAIN_SURVIVAL_SEARCH_SEEDS[0] });
  const terminal = difficultyForSector(BRAIN_SURVIVAL_TARGET_SECTOR);

  expect(replay).toEqual(first!);
  for (const result of WINNER.results) {
    expect(result.peakObservedProjectiles).toBe(terminal.maxEnemyProjectiles);
    expect(result.peakObservedEnemies).toBe(terminal.maxEnemies);
    expect(result.abilityCoresCollected).toBe(3);
    expect(result.specialUses).toBeGreaterThan(0);
    expect(result.enemyKindsObserved).toEqual(enemyKindsForSector(BRAIN_SURVIVAL_TARGET_SECTOR));
  }
});

test("simulation mechanics stay linked to production low-profile and escort rules", () => {
  expect(BRAIN_SURVIVAL_MECHANICS).toEqual({
    lowProfileCooldownSeconds: JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS["low-profile"],
    lowProfileTimeWarpSeconds: LOW_PROFILE_TIME_WARP_SECONDS,
    hostileTimeScale: LOW_PROFILE_HOSTILE_TIME_SCALE,
    playerSpeedMultiplier: LOW_PROFILE_PLAYER_SPEED_MULTIPLIER,
    bossEscortHealthThresholds: BOSS_ESCORT_HEALTH_THRESHOLDS,
  });

  for (const result of WINNER.results) {
    expect(result.normalWavesCompleted).toBe(28);
    expect(result.bossesDefeated).toBe(7);
    expect(result.bossEscortWavesObserved).toBe(22);
    expect(result.normalWavesBetweenBosses).toEqual([4, 3, 4, 3, 4, 3, 4, 3]);
    expect(result.bossArchetypesObserved).toEqual([
      ...BOSS_ARCHETYPES,
      "ravager",
      "stormwing",
    ]);
    expect(result.lowProfileUses).toBeGreaterThanOrEqual(14);
    expect(result.lowProfileTimeWarpSeconds).toBeGreaterThan(35);
    expect(result.lowProfileTimeWarpSeconds).toBeLessThanOrEqual(36);
  }
});

test("bounded survival controller completes sector 50 on every fixed seed", () => {
  expect(BRAIN_SURVIVAL_SEARCH_SEEDS).toHaveLength(5);
  expect(WINNER.survivedRuns).toBe(BRAIN_SURVIVAL_SEARCH_SEEDS.length);
  expect(WINNER.completedSectorFloor).toBe(BRAIN_SURVIVAL_TARGET_SECTOR);
  expect(WINNER.results.every((result) => result.survived)).toBe(true);
  expect(WINNER.results.every((result) => result.livesRemaining === 3)).toBe(true);
  expect(WINNER.totalHits).toBe(0);
  expect(WINNER.terrainHits).toBe(0);

  // Five fixed runs stay below an explicit bounded-search budget. The peak
  // per decision also guards accidental multiplication of route branches.
  expect(WINNER.plannerWorkUnits).toBeLessThanOrEqual(3_250_000);
  for (const result of WINNER.results) {
    expect(result.decisionCount).toBeLessThanOrEqual(525);
    expect(result.peakPlannerWorkPerDecision).toBeLessThanOrEqual(2_400);
    expect(result.plannerWorkUnits).toBeLessThanOrEqual(
      result.decisionCount * result.peakPlannerWorkPerDecision,
    );
  }
});
