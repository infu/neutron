import { expect, test } from "bun:test";
import { BOSS_ARCHETYPES, bossHealthForSector } from "../src/game_rules.ts";
import {
  DEFAULT_RUN_DIFFICULTY,
  RUN_DIFFICULTY_LEVELS,
  RUN_DIFFICULTY_PROFILES,
  enemyImpactShardCount,
  scaledBossHealth,
  scaledCrateSpawnDelay,
  scaledHostileFireDelay,
  scaledHostileProjectileCap,
  scaledHostileProjectileSpeed,
  scaledHostileVolleyCount,
} from "../src/run_difficulty.ts";

test("Hard preserves current balance while Medium and Easy expose exact modifiers", () => {
  expect(DEFAULT_RUN_DIFFICULTY).toBe("hard");
  expect(RUN_DIFFICULTY_LEVELS).toEqual(["easy", "medium", "hard"]);
  expect(RUN_DIFFICULTY_PROFILES.hard).toMatchObject({
    enemyParticleMultiplier: 1,
    hostileFireCadenceMultiplier: 1,
    hostileVolleyMultiplier: 1,
    hostileProjectileSpeedMultiplier: 1,
    hostileProjectileCapMultiplier: 1,
    bossHealthMultiplier: 1,
    crateSpawnRateMultiplier: 1,
  });
  expect(RUN_DIFFICULTY_PROFILES.medium).toMatchObject({
    enemyParticleMultiplier: 0.8,
    hostileFireCadenceMultiplier: 0.9,
    hostileVolleyMultiplier: 0.9,
    hostileProjectileSpeedMultiplier: 0.9,
    hostileProjectileCapMultiplier: 0.8,
    bossHealthMultiplier: 0.8,
    crateSpawnRateMultiplier: 1.1,
  });
  expect(RUN_DIFFICULTY_PROFILES.easy).toMatchObject({
    enemyParticleMultiplier: 0.5,
    hostileFireCadenceMultiplier: 0.7,
    hostileVolleyMultiplier: 0.65,
    hostileProjectileSpeedMultiplier: 0.75,
    hostileProjectileCapMultiplier: 0.5,
    bossHealthMultiplier: 0.7,
    crateSpawnRateMultiplier: 1.15,
  });
  expect(Object.isFrozen(RUN_DIFFICULTY_PROFILES)).toBe(true);
  expect(RUN_DIFFICULTY_LEVELS.every((level) => Object.isFrozen(RUN_DIFFICULTY_PROFILES[level]))).toBe(true);
});

test("boss hull scaling stays integral and exact through sector 200", () => {
  for (let sector = 5; sector <= 200; sector += 5) {
    for (const archetype of BOSS_ARCHETYPES) {
      const base = bossHealthForSector(sector, archetype);
      expect(scaledBossHealth(base, "hard")).toBe(base);
      expect(scaledBossHealth(base, "medium")).toBe(Math.round(base * 0.8));
      expect(scaledBossHealth(base, "easy")).toBe(Math.round(base * 0.7));
    }
  }
});

test("crate bonuses increase spawn rate instead of approximating interval percentages", () => {
  expect(scaledCrateSpawnDelay(10, "hard")).toBe(10);
  expect(scaledCrateSpawnDelay(10, "medium")).toBeCloseTo(10 / 1.1, 12);
  expect(scaledCrateSpawnDelay(10, "easy")).toBeCloseTo(10 / 1.15, 12);
});

test("only hostile impact shard budgets reduce to ten, eight, and five", () => {
  expect(RUN_DIFFICULTY_LEVELS.map((level) => enemyImpactShardCount(10, level)))
    .toEqual([5, 8, 10]);
  expect(enemyImpactShardCount(0, "easy")).toBe(0);
  expect(enemyImpactShardCount(Number.NaN, "medium")).toBe(0);
});

test("Easy halves damaging hostile fire while Medium trims it by about twenty percent", () => {
  expect(scaledHostileFireDelay(7, "hard")).toBe(7);
  expect(scaledHostileFireDelay(7, "medium")).toBeCloseTo(7 / 0.9, 12);
  expect(scaledHostileFireDelay(7, "easy")).toBe(10);

  expect(RUN_DIFFICULTY_LEVELS.map((level) => scaledHostileVolleyCount(20, level)))
    .toEqual([13, 18, 20]);
  expect(RUN_DIFFICULTY_LEVELS.map((level) => scaledHostileProjectileCap(20, level)))
    .toEqual([10, 16, 20]);
  expect(RUN_DIFFICULTY_LEVELS.map((level) => scaledHostileProjectileSpeed(10, level)))
    .toEqual([7.5, 9, 10]);

  expect(
    RUN_DIFFICULTY_PROFILES.easy.hostileFireCadenceMultiplier
      * RUN_DIFFICULTY_PROFILES.easy.hostileVolleyMultiplier,
  ).toBeCloseTo(0.455, 12);
  expect(
    RUN_DIFFICULTY_PROFILES.medium.hostileFireCadenceMultiplier
      * RUN_DIFFICULTY_PROFILES.medium.hostileVolleyMultiplier,
  ).toBeCloseTo(0.81, 12);
});
