import { expect, test } from "bun:test";
import {
  BOSS_ESCORT_HEALTH_THRESHOLDS,
  BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION,
  BOSS_ESCORT_WAVE_COUNT,
  applyBossEscortDamageGate,
  bossEscortDamageBudget,
  bossEscortSafeEntryY,
  bossEscortWavesForEncounter,
  createBossEscortProgress,
  isBossEscortKind,
  isBossEscortKindUnlocked,
  nextBossEscortWave,
  recordBossEscortWaveLaunch,
} from "../src/boss_escorts.ts";
import {
  BOSS_ARCHETYPES,
  bossArchetypeForSector,
  bossHealthForSector,
  difficultyForSector,
  enemyArchetypeForKind,
} from "../src/game_rules.ts";
import {
  RUN_DIFFICULTY_LEVELS,
  scaledBossHealth,
} from "../src/run_difficulty.ts";

test("boss encounters define exactly three deterministic, readable escort waves", () => {
  expect(BOSS_ESCORT_WAVE_COUNT).toBe(3);
  expect(BOSS_ESCORT_HEALTH_THRESHOLDS).toEqual([0.75, 0.5, 0.25]);

  for (const sector of [5, 10, 25, 40, 100, 200]) {
    const archetype = bossArchetypeForSector(sector);
    const first = bossEscortWavesForEncounter(sector, archetype);
    const second = bossEscortWavesForEncounter(sector, archetype);

    expect(first).toEqual(second);
    expect(first).toHaveLength(3);
    expect(first.map((wave) => wave.number)).toEqual([1, 2, 3]);
    expect(new Set(first.map((wave) => wave.formation)).size).toBe(3);
    expect(new Set(first.map((wave) => (
      JSON.stringify(wave.units.map((unit) => unit.kind))
    ))).size).toBe(3);
    expect(first.map((wave) => wave.announcement)).toEqual([
      expect.stringContaining("wave 1"),
      expect.stringContaining("wave 2"),
      expect.stringContaining("wave 3"),
    ]);
    expect(first.map((wave) => wave.triggerHealthRatio)).toEqual([...BOSS_ESCORT_HEALTH_THRESHOLDS]);
    expect(first[0].minEncounterSeconds).toBeLessThan(first[1].minEncounterSeconds);
    expect(first[1].minEncounterSeconds).toBeLessThan(first[2].minEncounterSeconds);
  }
});

test("escort compositions use only unlocked flying archetypes and stay bounded", () => {
  for (let sector = 5; sector <= 200; sector += 5) {
    for (const archetype of BOSS_ARCHETYPES) {
      const waves = bossEscortWavesForEncounter(sector, archetype);
      const difficulty = difficultyForSector(sector);

      expect(waves[0].units.length).toBeGreaterThanOrEqual(2);
      expect(waves[0].units.length).toBeLessThanOrEqual(4);
      expect(waves[1].units.length).toBeGreaterThanOrEqual(3);
      expect(waves[1].units.length).toBeLessThanOrEqual(5);
      expect(waves[2].units.length).toBeGreaterThanOrEqual(4);
      expect(waves[2].units.length).toBeLessThanOrEqual(6);
      expect(waves.reduce((total, wave) => total + wave.units.length, 0))
        .toBeLessThanOrEqual(difficulty.maxEnemies);

      for (const wave of waves) {
        expect(wave.minimumPlayerSeparation).toBe(BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION);
        expect(wave.units.filter((unit) => unit.elite).length).toBeLessThan(wave.units.length);

        for (const [index, unit] of wave.units.entries()) {
          expect(isBossEscortKind(unit.kind)).toBe(true);
          expect(isBossEscortKindUnlocked(unit.kind, sector)).toBe(true);
          expect(enemyArchetypeForKind(unit.kind).unlockSector).toBeLessThanOrEqual(sector);
          expect(unit.normalizedLane).toBeGreaterThanOrEqual(-0.8);
          expect(unit.normalizedLane).toBeLessThanOrEqual(0.8);
          if (index === 0) {
            expect(unit.entryDelaySeconds).toBe(0);
          } else {
            expect(Number.isFinite(unit.entryDelaySeconds)).toBe(true);
            expect(unit.entryDelaySeconds).toBeGreaterThan(wave.units[index - 1]!.entryDelaySeconds);
          }
        }
      }
    }
  }
});

test("escort schedule follows health beats, preserves ordering, and never emits a fourth wave", () => {
  let progress = createBossEscortProgress();
  const baseEncounter = {
    sector: 25,
    archetype: "harvester" as const,
    entering: false,
    bossHealth: 740,
    bossMaxHealth: 1_000,
    bossPhase: 1 as const,
    availableEnemySlots: 8,
  };

  expect(nextBossEscortWave(progress, { ...baseEncounter, entering: true, encounterSeconds: 5 })).toBeNull();
  expect(nextBossEscortWave(progress, { ...baseEncounter, encounterSeconds: 2 })).toBeNull();

  const firstWave = nextBossEscortWave(progress, { ...baseEncounter, encounterSeconds: 2.5 });
  expect(firstWave?.number).toBe(1);
  progress = recordBossEscortWaveLaunch(progress, firstWave!, 2.5);

  // Crossing the second threshold immediately cannot collapse both beats into spam.
  expect(nextBossEscortWave(progress, {
    ...baseEncounter,
    encounterSeconds: 4,
    bossHealth: 400,
    bossPhase: 3,
  })).toBeNull();

  const secondWave = nextBossEscortWave(progress, {
    ...baseEncounter,
    encounterSeconds: 7,
    bossHealth: 400,
    bossPhase: 2,
  });
  expect(secondWave?.number).toBe(2);
  progress = recordBossEscortWaveLaunch(progress, secondWave!, 7);

  expect(nextBossEscortWave(progress, {
    ...baseEncounter,
    encounterSeconds: 9,
    bossHealth: 200,
    bossPhase: 3,
  })).toBeNull();

  const thirdWave = nextBossEscortWave(progress, {
    ...baseEncounter,
    encounterSeconds: 11,
    bossHealth: 200,
    bossPhase: 3,
  });
  expect(thirdWave?.number).toBe(3);
  progress = recordBossEscortWaveLaunch(progress, thirdWave!, 11);

  expect(nextBossEscortWave(progress, {
    ...baseEncounter,
    encounterSeconds: 100,
    bossHealth: 1,
    bossPhase: 3,
  })).toBeNull();
});

test("escort waves defer under cap pressure and fit without overflowing global limits", () => {
  const progress = createBossEscortProgress();
  const encounter = {
    sector: 200,
    archetype: "harvester" as const,
    entering: false,
    encounterSeconds: 20,
    bossHealth: 700,
    bossMaxHealth: 1_000,
    bossPhase: 1 as const,
  };

  expect(nextBossEscortWave(progress, { ...encounter, availableEnemySlots: 0 })).toBeNull();
  expect(nextBossEscortWave(progress, { ...encounter, availableEnemySlots: 1 })).toBeNull();

  const fitted = nextBossEscortWave(progress, { ...encounter, availableEnemySlots: 3 });
  expect(fitted?.plannedSize).toBe(4);
  expect(fitted?.units).toHaveLength(3);
});

test("out-of-order launch records cannot skip a boss escort wave", () => {
  const progress = createBossEscortProgress();
  const [, , thirdWave] = bossEscortWavesForEncounter(50, "harvester");
  expect(recordBossEscortWaveLaunch(progress, thirdWave, 10)).toBe(progress);
});

test("escort entry stays above the cave mouth and safely separated from the player", () => {
  for (const playerY of [-12, 0, 10, 16]) {
    const radius = 0.8;
    const entryY = bossEscortSafeEntryY(
      playerY,
      16,
      radius,
      BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION,
    );
    expect(entryY).toBeGreaterThan(16 + radius);
    expect(entryY - playerY - radius).toBeGreaterThanOrEqual(BOSS_ESCORT_MINIMUM_PLAYER_SEPARATION);
  }
});

test("lethal burst damage cannot bypass any escort health beat", () => {
  const beforeFirstWave = applyBossEscortDamageGate(1_000, 1_000, 50_000, {
    launchedWaves: 0,
    pendingEscortUnits: 0,
  });
  expect(beforeFirstWave).toEqual({
    health: 750,
    minimumHealth: 750,
    gated: true,
  });

  const beforeSecondWave = applyBossEscortDamageGate(beforeFirstWave.health, 1_000, 50_000, {
    launchedWaves: 1,
    pendingEscortUnits: 0,
  });
  expect(beforeSecondWave).toEqual({
    health: 500,
    minimumHealth: 500,
    gated: true,
  });

  const beforeThirdWave = applyBossEscortDamageGate(beforeSecondWave.health, 1_000, 50_000, {
    launchedWaves: 2,
    pendingEscortUnits: 0,
  });
  expect(beforeThirdWave).toEqual({
    health: 250,
    minimumHealth: 250,
    gated: true,
  });
});

test("boss becomes lethally damageable as soon as wave three finishes deploying", () => {
  const whileStaggeredUnitsEnter = applyBossEscortDamageGate(250, 1_000, 50_000, {
    launchedWaves: 3,
    pendingEscortUnits: 2,
  });
  expect(whileStaggeredUnitsEnter.health).toBe(10);
  expect(whileStaggeredUnitsEnter.gated).toBe(true);

  const visiblyDeployed = applyBossEscortDamageGate(whileStaggeredUnitsEnter.health, 1_000, 50_000, {
    launchedWaves: 3,
    pendingEscortUnits: 0,
  });
  expect(visiblyDeployed).toEqual({
    health: 0,
    minimumHealth: 0,
    gated: false,
  });
});

test("boss damage budget follows the 75, 50, 25, and temporary 1 percent gates", () => {
  expect(bossEscortDamageBudget(1_000, 1_000, {
    launchedWaves: 0,
    pendingEscortUnits: 0,
  })).toEqual({ minimumHealth: 750, damageBudget: 250, damageable: true });
  expect(bossEscortDamageBudget(750, 1_000, {
    launchedWaves: 0,
    pendingEscortUnits: 0,
  })).toEqual({ minimumHealth: 750, damageBudget: 0, damageable: false });

  expect(bossEscortDamageBudget(750, 1_000, {
    launchedWaves: 1,
    pendingEscortUnits: 0,
  })).toEqual({ minimumHealth: 500, damageBudget: 250, damageable: true });
  expect(bossEscortDamageBudget(500, 1_000, {
    launchedWaves: 1,
    pendingEscortUnits: 0,
  })).toEqual({ minimumHealth: 500, damageBudget: 0, damageable: false });

  expect(bossEscortDamageBudget(500, 1_000, {
    launchedWaves: 2,
    pendingEscortUnits: 0,
  })).toEqual({ minimumHealth: 250, damageBudget: 250, damageable: true });
  expect(bossEscortDamageBudget(250, 1_000, {
    launchedWaves: 2,
    pendingEscortUnits: 2,
  })).toEqual({ minimumHealth: 250, damageBudget: 0, damageable: false });

  expect(bossEscortDamageBudget(250, 1_000, {
    launchedWaves: 3,
    pendingEscortUnits: 2,
  })).toEqual({ minimumHealth: 10, damageBudget: 240, damageable: true });
  expect(bossEscortDamageBudget(10, 1_000, {
    launchedWaves: 3,
    pendingEscortUnits: 1,
  })).toEqual({ minimumHealth: 10, damageBudget: 0, damageable: false });
  expect(bossEscortDamageBudget(10, 1_000, {
    launchedWaves: 3,
    pendingEscortUnits: 0,
  })).toEqual({ minimumHealth: 0, damageBudget: 10, damageable: true });
});

test("every boss health gate releases all three waves and remains lethal through sector 200", () => {
  for (let sector = 5; sector <= 200; sector += 5) {
    for (const archetype of BOSS_ARCHETYPES) {
      for (const difficultyLevel of RUN_DIFFICULTY_LEVELS) {
        const maximumHealth = scaledBossHealth(
          bossHealthForSector(sector, archetype),
          difficultyLevel,
        );
        const [firstPlan, secondPlan, thirdPlan] = bossEscortWavesForEncounter(sector, archetype);
        const availableEnemySlots = difficultyForSector(sector).maxEnemies;
        let progress = createBossEscortProgress();

        const firstGate = applyBossEscortDamageGate(maximumHealth, maximumHealth, Number.MAX_VALUE, {
          launchedWaves: 0,
          pendingEscortUnits: 0,
        });
        const firstWave = nextBossEscortWave(progress, {
          sector,
          archetype,
          entering: false,
          encounterSeconds: firstPlan.minEncounterSeconds + 0.1,
          bossHealth: firstGate.health,
          bossMaxHealth: maximumHealth,
          bossPhase: 1,
          availableEnemySlots,
        });
        expect(firstWave?.number).toBe(1);
        progress = recordBossEscortWaveLaunch(
          progress,
          firstWave!,
          firstPlan.minEncounterSeconds + 0.1,
        );

        const secondGate = applyBossEscortDamageGate(firstGate.health, maximumHealth, Number.MAX_VALUE, {
          launchedWaves: 1,
          pendingEscortUnits: 0,
        });
        const secondLaunchSeconds = Math.max(
          secondPlan.minEncounterSeconds,
          progress.lastLaunchAtSeconds + secondPlan.minSecondsAfterPreviousWave,
        ) + 0.1;
        const secondWave = nextBossEscortWave(progress, {
          sector,
          archetype,
          entering: false,
          encounterSeconds: secondLaunchSeconds,
          bossHealth: secondGate.health,
          bossMaxHealth: maximumHealth,
          bossPhase: 3,
          availableEnemySlots,
        });
        expect(secondWave?.number).toBe(2);
        progress = recordBossEscortWaveLaunch(progress, secondWave!, secondLaunchSeconds);

        const thirdGate = applyBossEscortDamageGate(secondGate.health, maximumHealth, Number.MAX_VALUE, {
          launchedWaves: 2,
          pendingEscortUnits: 0,
        });
        const thirdLaunchSeconds = Math.max(
          thirdPlan.minEncounterSeconds,
          progress.lastLaunchAtSeconds + thirdPlan.minSecondsAfterPreviousWave,
        ) + 0.1;
        const thirdWave = nextBossEscortWave(progress, {
          sector,
          archetype,
          entering: false,
          encounterSeconds: thirdLaunchSeconds,
          bossHealth: thirdGate.health,
          bossMaxHealth: maximumHealth,
          bossPhase: 3,
          availableEnemySlots,
        });
        expect(thirdWave?.number).toBe(3);
        progress = recordBossEscortWaveLaunch(progress, thirdWave!, thirdLaunchSeconds);
        expect(progress.launchedWaves).toBe(3);

        const lethal = applyBossEscortDamageGate(thirdGate.health, maximumHealth, Number.MAX_VALUE, {
          launchedWaves: progress.launchedWaves,
          pendingEscortUnits: 0,
        });
        expect(lethal.health).toBe(0);
        expect(lethal.gated).toBe(false);
      }
    }
  }
});
