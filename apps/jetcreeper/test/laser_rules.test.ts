import { expect, test } from "bun:test";
import {
  LOW_PROFILE_BOSS_LASER_MAX_HEALTH_FRACTION,
  LOW_PROFILE_HOSTILE_TIME_SCALE,
  LOW_PROFILE_PLAYER_SPEED_MULTIPLIER,
  LOW_PROFILE_TIME_WARP_SECONDS,
  laserDamageForBoss,
  laserDamageForTarget,
  remainingBossLaserStrikeDamage,
} from "../src/laser_rules.ts";
import { applyBossEscortDamageGate } from "../src/boss_escorts.ts";

test("low-profile laser deals 10x damage and a further 5x strictly below half health", () => {
  expect(laserDamageForTarget(1, 100, 100, true)).toBe(10);
  expect(laserDamageForTarget(1, 50, 100, true)).toBe(10);
  expect(laserDamageForTarget(1, 49.999, 100, true)).toBe(50);
  expect(laserDamageForTarget(2, 49, 100, true)).toBe(100);
  expect(laserDamageForTarget(2, 1, 100, false)).toBe(2);
});

test("one low-profile laser strike removes exactly 20% of boss maximum health", () => {
  expect(LOW_PROFILE_BOSS_LASER_MAX_HEALTH_FRACTION).toBe(0.2);
  expect(laserDamageForBoss(1, 1_000, true)).toBe(200);
  expect(laserDamageForBoss(99, 7_500, true)).toBe(1_500);

  // Ordinary beam hits retain their existing target-independent base damage.
  expect(laserDamageForBoss(2.25, 1_000, false)).toBe(2.25);
});

test("a 20% boss strike retains credit across every escort health gate", () => {
  const maximumHealth = 1_000;
  const strikeDamage = laserDamageForBoss(1, maximumHealth, true);
  const settle = (
    health: number,
    pending: number,
    launchedWaves: 0 | 1 | 2 | 3,
  ): { health: number; pending: number } => {
    const outcome = applyBossEscortDamageGate(health, maximumHealth, pending, {
      launchedWaves,
      pendingEscortUnits: 0,
    });
    const applied = health - outcome.health;
    return {
      health: outcome.health,
      pending: remainingBossLaserStrikeDamage(pending, applied),
    };
  };

  const firstGate = settle(800, strikeDamage, 0);
  expect(firstGate).toEqual({ health: 750, pending: 150 });
  expect(settle(firstGate.health, firstGate.pending, 1)).toEqual({
    health: 600,
    pending: 0,
  });

  const exactGate = settle(750, strikeDamage, 0);
  expect(exactGate).toEqual({ health: 750, pending: 200 });
  expect(settle(exactGate.health, exactGate.pending, 1)).toEqual({
    health: 550,
    pending: 0,
  });

  const secondGate = settle(560, strikeDamage, 1);
  expect(secondGate).toEqual({ health: 500, pending: 140 });
  expect(settle(secondGate.health, secondGate.pending, 2)).toEqual({
    health: 360,
    pending: 0,
  });
});

test("boss strike credit rejects malformed values and never underflows", () => {
  expect(remainingBossLaserStrikeDamage(200, 50)).toBe(150);
  expect(remainingBossLaserStrikeDamage(200, 250)).toBe(0);
  expect(remainingBossLaserStrikeDamage(Number.NaN, 10)).toBe(0);
  expect(remainingBossLaserStrikeDamage(200, Number.POSITIVE_INFINITY)).toBe(200);
});

test("boss laser damage rejects malformed inputs without producing NaN", () => {
  expect(laserDamageForBoss(Number.NaN, 1_000, false)).toBe(0);
  expect(laserDamageForBoss(1, Number.NaN, true)).toBe(0);
  expect(laserDamageForBoss(1, Number.POSITIVE_INFINITY, true)).toBe(0);
  expect(laserDamageForBoss(1, -100, true)).toBe(0);
});

test("low-profile time warp is exact and keeps the jet fast", () => {
  expect(LOW_PROFILE_TIME_WARP_SECONDS).toBe(5);
  expect(LOW_PROFILE_HOSTILE_TIME_SCALE).toBeCloseTo(1 / 3);
  expect(LOW_PROFILE_PLAYER_SPEED_MULTIPLIER).toBe(1.5);
});
