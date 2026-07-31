import { describe, expect, test } from "bun:test";
import {
  GUARDIAN_WING_ACTIVE_SECONDS,
  GUARDIAN_WING_FIRE_INTERVAL_SECONDS,
  GUARDIAN_WING_MAX_LOGICAL_SHOTS_PER_PACKET,
  GUARDIAN_WING_MIN_FIRE_INTERVAL_SECONDS,
  GUARDIAN_WING_PROJECTILE_DAMAGE,
  GUARDIAN_WING_PROJECTILE_SPEED,
  GUARDIAN_WING_RESERVED_PROJECTILE_SLOTS,
  GUARDIAN_WING_TRACER_INTERVAL_SECONDS,
  PLAYER_PRIMARY_FIRE_INTERVAL_SECONDS,
  PLAYER_RAPID_FIRE_INTERVAL_SECONDS,
  guardianWingLogicalFireInterval,
  initialGuardianWingFireCooldown,
  playerCannonFireInterval,
  stepGuardianWingCadence,
} from "../src/guardian_wing_fire.ts";

describe("Guardian Wing offensive cannons", () => {
  test("the formation remains active for exactly four seconds", () => {
    expect(GUARDIAN_WING_ACTIVE_SECONDS).toBe(4);
  });

  test("each wing fires faster than both normal and rapid player fire", () => {
    expect(GUARDIAN_WING_FIRE_INTERVAL_SECONDS).toBeLessThan(PLAYER_PRIMARY_FIRE_INTERVAL_SECONDS);
    expect(GUARDIAN_WING_FIRE_INTERVAL_SECONDS).toBeLessThan(PLAYER_RAPID_FIRE_INTERVAL_SECONDS);

    const perWingShotsPerSecond = 1 / GUARDIAN_WING_FIRE_INTERVAL_SECONDS;
    const rapidPlayerShotsPerSecond = 1 / PLAYER_RAPID_FIRE_INTERVAL_SECONDS;
    expect(perWingShotsPerSecond).toBeGreaterThan(rapidPlayerShotsPerSecond);
    expect(perWingShotsPerSecond * 2).toBeGreaterThan(30);
  });

  test("the pair starts immediately with alternating fire", () => {
    expect(initialGuardianWingFireCooldown(0)).toBe(0);
    expect(initialGuardianWingFireCooldown(1)).toBe(GUARDIAN_WING_TRACER_INTERVAL_SECONDS / 2);
  });

  test("wing rounds retain useful cannon speed and damage", () => {
    expect(GUARDIAN_WING_PROJECTILE_SPEED).toBeGreaterThan(18);
    expect(GUARDIAN_WING_PROJECTILE_DAMAGE).toBeGreaterThanOrEqual(1);
    expect(GUARDIAN_WING_RESERVED_PROJECTILE_SLOTS).toBe(32);
  });

  test("each wing remains logically faster through every player fire-rate stack", () => {
    for (const rapid of [false, true]) {
      for (const overdrive of [false, true]) {
        for (const burst of [false, true]) {
          const playerInterval = playerCannonFireInterval({ rapid, overdrive, burst });
          expect(guardianWingLogicalFireInterval(playerInterval)).toBeLessThan(playerInterval);
        }
      }
    }

    const fastestPlayer = playerCannonFireInterval({
      rapid: true,
      overdrive: true,
      burst: true,
    });
    expect(fastestPlayer).toBeCloseTo(0.00527, 8);
    expect(guardianWingLogicalFireInterval(fastestPlayer)).toBeCloseTo(0.004216, 8);
    expect(guardianWingLogicalFireInterval(fastestPlayer)).toBeGreaterThanOrEqual(
      GUARDIAN_WING_MIN_FIRE_INTERVAL_SECONDS,
    );
  });

  test("logical rounds packetize into bounded visible tracers without backlog", () => {
    const playerInterval = playerCannonFireInterval({
      rapid: true,
      overdrive: true,
      burst: true,
    });
    let state = { accumulatedShots: 0, tracerCooldownSeconds: 0 };
    let emittedShots = 0;

    for (let step = 0; step < 600; step += 1) {
      const next = stepGuardianWingCadence(state, 1 / 60, playerInterval);
      expect(next.logicalShots).toBeLessThanOrEqual(GUARDIAN_WING_MAX_LOGICAL_SHOTS_PER_PACKET);
      emittedShots += next.logicalShots;
      state = next;
    }

    expect(emittedShots / 10).toBeGreaterThan(1 / playerInterval);
    expect(state.accumulatedShots).toBeLessThan(GUARDIAN_WING_MAX_LOGICAL_SHOTS_PER_PACKET);

    const malformed = stepGuardianWingCadence(
      { accumulatedShots: Number.NaN, tracerCooldownSeconds: Number.NEGATIVE_INFINITY },
      Number.NaN,
      Number.NaN,
    );
    expect(malformed.logicalShots).toBe(0);
    expect(malformed.accumulatedShots).toBe(0);
    expect(malformed.logicalFireIntervalSeconds).toBe(GUARDIAN_WING_FIRE_INTERVAL_SECONDS);
  });
});
