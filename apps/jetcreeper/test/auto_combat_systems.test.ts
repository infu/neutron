import { expect, test } from "bun:test";
import {
  decideAutoCombatSystems,
  type AutoCombatSystemObservation,
} from "../src/auto_combat_systems.ts";

function observation(
  overrides: Partial<AutoCombatSystemObservation> = {},
): AutoCombatSystemObservation {
  return {
    remoteBombReady: false,
    remoteBombActive: false,
    remoteBombAgeSeconds: 0,
    bombEnemyTargetsInBlast: 0,
    bombBossInBlast: false,
    availableEnemyTargets: 0,
    bossActive: false,
    guardianWingReady: false,
    guardianWingActive: false,
    nearbyProjectileCount: 0,
    nearbyRocketCount: 0,
    ...overrides,
  };
}

test("Auto holds its bomb but cycles Guardian Wing on an empty or calm screen", () => {
  expect(decideAutoCombatSystems(observation({
    remoteBombReady: true,
    guardianWingReady: true,
    availableEnemyTargets: 2,
    nearbyProjectileCount: 2,
  }))).toEqual({
    launchRemoteBomb: false,
    detonateRemoteBomb: false,
    deployGuardianWing: true,
  });
});

test("Auto launches a bomb for a crowd or boss and detonates on valuable overlap", () => {
  expect(decideAutoCombatSystems(observation({
    remoteBombReady: true,
    availableEnemyTargets: 4,
  })).launchRemoteBomb).toBe(true);
  expect(decideAutoCombatSystems(observation({
    remoteBombReady: true,
    bossActive: true,
  })).launchRemoteBomb).toBe(true);
  expect(decideAutoCombatSystems(observation({
    remoteBombActive: true,
    bombEnemyTargetsInBlast: 3,
  })).detonateRemoteBomb).toBe(true);
  expect(decideAutoCombatSystems(observation({
    remoteBombActive: true,
    bombBossInBlast: true,
  })).detonateRemoteBomb).toBe(true);
});

test("Auto never strands an armed bomb after targets disperse", () => {
  expect(decideAutoCombatSystems(observation({
    remoteBombActive: true,
    remoteBombAgeSeconds: 3.8,
    bombEnemyTargetsInBlast: 1,
  })).detonateRemoteBomb).toBe(true);
  expect(decideAutoCombatSystems(observation({
    remoteBombActive: true,
    remoteBombAgeSeconds: 4.75,
  })).detonateRemoteBomb).toBe(true);
});

test("Auto deploys Guardian Wing whenever it is ready and inactive", () => {
  expect(decideAutoCombatSystems(observation({
    guardianWingReady: true,
  })).deployGuardianWing).toBe(true);
  expect(decideAutoCombatSystems(observation({
    guardianWingReady: true,
    nearbyProjectileCount: 0,
    nearbyRocketCount: 0,
  })).deployGuardianWing).toBe(true);
  expect(decideAutoCombatSystems(observation({
    guardianWingReady: false,
    bossActive: true,
    nearbyProjectileCount: 20,
    nearbyRocketCount: 5,
  })).deployGuardianWing).toBe(false);
  expect(decideAutoCombatSystems(observation({
    guardianWingReady: true,
    guardianWingActive: true,
  })).deployGuardianWing).toBe(false);
});
