import { expect, test } from "bun:test";
import {
  BASELINE_ENEMY_PRESSURE_TUNING,
  ENEMY_PRESSURE_TUNING,
} from "../src/game_rules.ts";
import {
  ENEMY_PRESSURE_SEARCH_SEEDS,
  generateEnemyPressureCandidates,
  searchEnemyPressureTuning,
} from "../src/enemy_pressure_hyperopt.ts";

test("enemy pressure candidate generation is deterministic and bounded", () => {
  const first = generateEnemyPressureCandidates(6, 0x1234_5678);
  const replay = generateEnemyPressureCandidates(6, 0x1234_5678);

  expect(replay).toEqual(first);
  expect(first).toHaveLength(9);
  expect(first[0]).toEqual(BASELINE_ENEMY_PRESSURE_TUNING);
  expect(first[1]).toEqual(ENEMY_PRESSURE_TUNING);
  expect(first.every(Object.isFrozen)).toBe(true);

  for (const tuning of first) {
    expect(tuning.horizontalAimLeadSeconds).toBeGreaterThanOrEqual(0);
    expect(tuning.horizontalAimLeadSeconds).toBeLessThanOrEqual(0.6);
    expect(tuning.fireCadenceScale).toBeGreaterThanOrEqual(0.6);
    expect(tuning.volleyDensityScale).toBeLessThanOrEqual(1.6);
    expect(tuning.formationChanceAtTerminal).toBeLessThanOrEqual(1);
  }
});

test("measured production pressure beats the retained baseline without breaking constraints", () => {
  const options = {
    seeds: ENEMY_PRESSURE_SEARCH_SEEDS,
    durationSeconds: 6,
  } as const;
  const ranked = searchEnemyPressureTuning([
    BASELINE_ENEMY_PRESSURE_TUNING,
    ENEMY_PRESSURE_TUNING,
  ], options);
  const production = ranked.find((evaluation) => (
    evaluation.tuning.fireCadenceScale === ENEMY_PRESSURE_TUNING.fireCadenceScale
  ));
  const baseline = ranked.find((evaluation) => (
    evaluation.tuning.fireCadenceScale === BASELINE_ENEMY_PRESSURE_TUNING.fireCadenceScale
  ));

  expect(production?.eligible).toBe(true);
  expect(production?.openingDamage).toBe(0);
  expect(production?.terminalDeaths).toBe(options.seeds.length);
  expect(production?.capViolations).toBe(0);
  expect(production?.objectiveScore ?? 0).toBeGreaterThan((baseline?.objectiveScore ?? 0) + 8);
  for (const measurement of production?.measurements ?? []) {
    if (measurement.sector <= 150) {
      expect(measurement.deaths, `sector ${measurement.sector} stays non-terminal`).toBe(0);
    }
  }
  expect(production?.measurements.find(({ sector }) => sector === 195)?.deaths)
    .toBeGreaterThanOrEqual(options.seeds.length - 1);
  expect(ranked[0]?.tuning).toEqual(ENEMY_PRESSURE_TUNING);
}, 30_000);
