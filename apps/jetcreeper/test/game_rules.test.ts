import { expect, test } from "bun:test";
import { JET_ABILITY_KINDS } from "../src/abilities.ts";
import { JET_ATTACHMENT_KINDS } from "../src/attachments.ts";
import {
  BASELINE_ENEMY_PRESSURE_TUNING,
  BONUS_KINDS,
  BOSS_ARCHETYPES,
  CONSUMABLE_BONUS_KINDS,
  ENEMY_PRESSURE_TUNING,
  ENEMY_KINDS,
  bonusDurationSeconds,
  bonusLabel,
  bossArchetypeForSector,
  bossHealthForSector,
  bossMilestoneForSector,
  bossNameForArchetype,
  bossPhaseForHealth,
  bossRewardForSector,
  bossRulesForArchetype,
  bossWeaponForPhase,
  brainPressureAdmissionThresholds,
  canFireRocket,
  canSpawnTurret,
  circlesOverlap,
  difficultyForSector,
  enemyArchetypeForKind,
  enemyKindForRoll,
  enemyKindsForSector,
  fighterLoopPose,
  isProtectedOpening,
  isTerminalPressureUnbounded,
  movingCirclesOverlap,
  resolveDamage,
  resolveEnemyPressureTuning,
  scoreForEnemy,
  scaledEnemyVolleyCount,
  segmentCircleOverlap,
  sectorForScore,
  unsafeRouteAdmissionChance,
} from "../src/game_rules.ts";

test("Jetcreeper exposes one frozen, bounded enemy pressure profile", () => {
  expect(Object.isFrozen(BASELINE_ENEMY_PRESSURE_TUNING)).toBe(true);
  expect(Object.isFrozen(ENEMY_PRESSURE_TUNING)).toBe(true);
  expect(ENEMY_PRESSURE_TUNING.fireCadenceScale).toBeLessThan(1);
  expect(ENEMY_PRESSURE_TUNING.volleyDensityScale).toBeGreaterThan(1);
  expect(ENEMY_PRESSURE_TUNING.formationChanceAtTerminal).toBe(0.9);
  expect(scaledEnemyVolleyCount(7, ENEMY_PRESSURE_TUNING)).toBe(11);

  const bounded = resolveEnemyPressureTuning({
    horizontalAimLeadSeconds: Number.POSITIVE_INFINITY,
    aimJitterScale: -4,
    fireCadenceScale: 0,
    volleyDensityScale: 99,
    rocketHomingSeconds: Number.NaN,
  });
  expect(bounded.horizontalAimLeadSeconds).toBe(ENEMY_PRESSURE_TUNING.horizontalAimLeadSeconds);
  expect(bounded.aimJitterScale).toBe(0);
  expect(bounded.fireCadenceScale).toBe(0.6);
  expect(bounded.volleyDensityScale).toBe(1.6);
  expect(bounded.rocketHomingSeconds).toBe(ENEMY_PRESSURE_TUNING.rocketHomingSeconds);
});

test("Jetcreeper collision checks use combined radii", () => {
  expect(circlesOverlap(0, 0, 1, 1.9, 0, 1)).toBe(true);
  expect(circlesOverlap(0, 0, 1, 2.1, 0, 1)).toBe(false);
});

test("Jetcreeper swept collision catches fast crossings between frames", () => {
  expect(segmentCircleOverlap(-4, 0, 4, 0, 0.15, 0, 0.5, 0.4)).toBe(true);
  expect(segmentCircleOverlap(-4, 0, 4, 0, 0.15, 0, 0.7, 0.4)).toBe(false);
});

test("Jetcreeper relative sweep resolves two simultaneously moving circles", () => {
  expect(movingCirclesOverlap(-4, 0, 4, 0, 0.2, 4, 0, -4, 0, 0.2)).toBe(true);
  expect(movingCirclesOverlap(-4, 0, 4, 0, 0.2, -4, 1, 4, 1, 0.2)).toBe(false);
  expect(movingCirclesOverlap(-4, -4, 4, 4, 0.2, -4, 4, 4, -4, 0.2)).toBe(true);
});

test("Jetcreeper score and sector progression stay predictable", () => {
  expect(scoreForEnemy("asteroid")).toBeLessThan(scoreForEnemy("fighter"));
  expect(scoreForEnemy("turret")).toBeGreaterThan(scoreForEnemy("fighter"));
  expect(scoreForEnemy("carrier")).toBeGreaterThan(scoreForEnemy("gunship"));
  expect(sectorForScore(0)).toBe(1);
  expect(sectorForScore(1199)).toBe(1);
  expect(sectorForScore(1200)).toBe(2);
  expect(sectorForScore(3600)).toBe(4);
});

test("Jetcreeper exposes twenty progressively unlocked enemies with unique movement and guns", () => {
  expect(ENEMY_KINDS).toHaveLength(20);
  expect(new Set(ENEMY_KINDS).size).toBe(20);
  expect(enemyKindsForSector(1)).toEqual(["fighter", "asteroid"]);
  expect(enemyKindsForSector(12)).toContain("gunship");
  expect(enemyKindsForSector(35)).not.toContain("phantom");
  expect(enemyKindsForSector(36)).toEqual(ENEMY_KINDS.slice(0, 10));
  expect(enemyKindsForSector(43)).not.toContain("corsair");
  expect(enemyKindsForSector(44)).toContain("corsair");
  expect(enemyKindsForSector(183)).not.toContain("commander");
  expect(enemyKindsForSector(184)).toEqual(ENEMY_KINDS);

  const displayNames = new Set<string>();
  const movementFamilies = new Set<string>();
  const weaponFamilies = new Set<string>();

  for (const kind of ENEMY_KINDS) {
    const archetype = enemyArchetypeForKind(kind);
    expect(archetype.kind).toBe(kind);
    expect(archetype.baseHealth).toBeGreaterThan(0);
    expect(archetype.radius).toBeGreaterThan(0);
    expect(archetype.modelScale).toBeGreaterThan(0);
    expect(archetype.targetPriority).toBeGreaterThan(0);
    expect(archetype.spawnWeight).toBeGreaterThan(0);
    expect(archetype.score).toBeGreaterThan(0);
    displayNames.add(archetype.displayName);
    movementFamilies.add(archetype.movementFamily);
    weaponFamilies.add(archetype.weaponFamily);
  }

  expect(displayNames.size).toBe(20);
  expect(movementFamilies.size).toBe(20);
  expect(weaponFamilies.size).toBe(20);
  expect(ENEMY_KINDS.slice(10).map((kind) => enemyArchetypeForKind(kind).unlockSector)).toEqual([
    44, 52, 61, 72, 84, 98, 116, 137, 160, 184,
  ]);

  const sampledKinds = new Set(Array.from(
    { length: 4000 },
    (_, index) => enemyKindForRoll(200, (index + 0.5) / 4000),
  ));
  expect(sampledKinds).toEqual(new Set(ENEMY_KINDS));
  expect(enemyKindForRoll(1, 0)).toBe("fighter");
  expect(enemyKindForRoll(200, 1)).toBe("commander");
});

test("Jetcreeper ramps from a fair opening to terminal sector-200 pressure", () => {
  const round = (value: number): number => Math.round(value * 10_000) / 10_000;
  const sectors = [1, 5, 25, 75, 150, 200] as const;
  const samples = sectors.map((sector) => {
    const difficulty = difficultyForSector(sector);
    return {
      sector: difficulty.sector,
      scroll: round(difficulty.scrollSpeed),
      spawn: round(difficulty.enemySpawnInterval),
      projectileSpeed: round(difficulty.enemyProjectileSpeed),
      fireScale: round(difficulty.enemyFireCooldownScale),
      rocketScale: round(difficulty.rocketCooldownScale),
      bossFireScale: round(difficulty.bossAttackCooldownScale),
      healthScale: round(difficulty.enemyHealthScale),
      movementScale: round(difficulty.enemyMovementSpeedScale),
      eliteChance: round(difficulty.eliteChance),
      formationCap: difficulty.maxFormationSize,
      enemyCap: difficulty.maxEnemies,
      projectileCap: difficulty.maxEnemyProjectiles,
      rocketCap: difficulty.maxEnemyRockets,
      bossHealth: bossHealthForSector(sector),
    };
  });

  expect(samples).toEqual([
    { sector: 1, scroll: 3.5, spawn: 0.8, projectileSpeed: 6.4, fireScale: 0.72, rocketScale: 0.74, bossFireScale: 0.82, healthScale: 1, movementScale: 1, eliteChance: 0, formationCap: 1, enemyCap: 8, projectileCap: 20, rocketCap: 3, bossHealth: 250 },
    { sector: 5, scroll: 4.4992, spawn: 0.7546, projectileSpeed: 7.543, fireScale: 0.6845, rocketScale: 0.7004, bossFireScale: 0.7786, healthScale: 1.1488, movementScale: 1.0517, eliteChance: 0.0059, formationCap: 2, enemyCap: 10, projectileCap: 25, rocketCap: 4, bossHealth: 340 },
    { sector: 25, scroll: 7.2625, spawn: 0.6408, projectileSpeed: 12.3421, fireScale: 0.5862, rocketScale: 0.5961, bossFireScale: 0.6643, healthScale: 1.9765, movementScale: 1.2888, eliteChance: 0.0554, formationCap: 3, enemyCap: 15, projectileCap: 38, rocketCap: 6, bossHealth: 1020 },
    { sector: 75, scroll: 12.1567, spawn: 0.4498, projectileSpeed: 23.1433, fireScale: 0.4122, rocketScale: 0.4162, bossFireScale: 0.4617, healthScale: 4.1852, movementScale: 1.8511, eliteChance: 0.2265, formationCap: 5, enemyCap: 22, projectileCap: 60, rocketCap: 9, bossHealth: 3199 },
    { sector: 150, scroll: 18.0305, spawn: 0.2283, projectileSpeed: 38.2772, fireScale: 0.2034, rocketScale: 0.2041, bossFireScale: 0.2186, healthScale: 7.6419, movementScale: 2.6664, eliteChance: 0.5433, formationCap: 7, enemyCap: 29, projectileCap: 85, rocketCap: 13, bossHealth: 6047 },
    { sector: 200, scroll: 21.5, spawn: 0.1, projectileSpeed: 48, fireScale: 0.08, rocketScale: 0.08, bossFireScale: 0.075, healthScale: 10, movementScale: 3.2, eliteChance: 0.78, formationCap: 8, enemyCap: 34, projectileCap: 100, rocketCap: 16, bossHealth: 6987 },
  ]);

  const terminal = difficultyForSector(200);
  for (const sector of sectors) {
    const difficulty = difficultyForSector(sector);
    expect(Object.values(difficulty).every(Number.isFinite)).toBe(true);
    expect(difficulty.maxFormationSize).toBeLessThanOrEqual(terminal.maxFormationSize);
    expect(difficulty.maxEnemies).toBeLessThanOrEqual(terminal.maxEnemies);
    expect(difficulty.maxEnemyProjectiles).toBeLessThanOrEqual(terminal.maxEnemyProjectiles);
    expect(difficulty.maxEnemyRockets).toBeLessThanOrEqual(terminal.maxEnemyRockets);
  }

  expect(difficultyForSector(500)).toMatchObject({
    terminalProgress: 1,
    enemySpawnInterval: terminal.enemySpawnInterval,
    maxEnemies: terminal.maxEnemies,
    maxEnemyProjectiles: terminal.maxEnemyProjectiles,
    maxEnemyRockets: terminal.maxEnemyRockets,
  });
});

test("known-unsafe routes phase in only near terminal sector 200", () => {
  const chanceAt = (sector: number): number => unsafeRouteAdmissionChance(
    difficultyForSector(sector).terminalProgress,
  );

  expect(chanceAt(175)).toBe(0);
  expect(chanceAt(185)).toBeGreaterThan(0.35);
  expect(chanceAt(185)).toBeLessThan(0.4);
  expect(chanceAt(195)).toBeGreaterThan(0.75);
  expect(chanceAt(195)).toBeLessThan(0.85);
  expect(chanceAt(200)).toBe(1);
  expect(unsafeRouteAdmissionChance(Number.NaN)).toBe(0);
  expect(isTerminalPressureUnbounded(difficultyForSector(199).terminalProgress)).toBe(false);
  expect(isTerminalPressureUnbounded(difficultyForSector(200).terminalProgress)).toBe(true);
});

test("brain pressure admission scales with the active planning horizon", () => {
  const legacyOpening = brainPressureAdmissionThresholds(0, 2.4);
  expect(legacyOpening.survivalSeconds).toBeCloseTo(2.28, 8);
  expect(legacyOpening.clearance).toBeCloseTo(0.08, 8);
  expect(brainPressureAdmissionThresholds(1, 2.4)).toEqual({
    survivalSeconds: 0.35,
    clearance: -0.55,
  });

  const optimized = brainPressureAdmissionThresholds(0, 1.675);
  expect(optimized.survivalSeconds).toBeCloseTo(1.59125, 8);
  expect(optimized.survivalSeconds).toBeLessThan(1.675);
  expect(optimized.clearance).toBeCloseTo(0.08, 8);
  const invalidFallback = brainPressureAdmissionThresholds(Number.NaN, Number.NaN);
  expect(invalidFallback.survivalSeconds).toBeCloseTo(2.28, 8);
  expect(invalidFallback.clearance).toBeCloseTo(0.08, 8);
});

test("Jetcreeper shields absorb one hit before a life is lost", () => {
  expect(resolveDamage(3, true)).toEqual({
    lives: 3,
    shielded: false,
    lostLife: false,
    gameOver: false,
  });
  expect(resolveDamage(1, false)).toEqual({
    lives: 0,
    shielded: false,
    lostLife: true,
    gameOver: true,
  });
});

test("Jetcreeper protects the opening and delays turret pressure", () => {
  expect(isProtectedOpening(0)).toBe(true);
  expect(isProtectedOpening(9.99)).toBe(true);
  expect(isProtectedOpening(10)).toBe(false);
  expect(canSpawnTurret(7.99)).toBe(false);
  expect(canSpawnTurret(8)).toBe(true);
  expect(canFireRocket(11.99)).toBe(false);
  expect(canFireRocket(12)).toBe(true);
  expect(bonusDurationSeconds("rapid")).toBeGreaterThan(0);
  expect(bonusDurationSeconds("shield")).toBe(0);
  expect(bonusDurationSeconds("pulse")).toBe(0);
  expect(bonusLabel("pulse")).toBe("Repair");
});

test("Jetcreeper keeps twenty attachments separate from consumables and ability cores", () => {
  expect(CONSUMABLE_BONUS_KINDS).toEqual(["shield", "pulse", "missile"]);
  expect(BONUS_KINDS).toEqual([
    ...CONSUMABLE_BONUS_KINDS,
    ...JET_ATTACHMENT_KINDS,
    ...JET_ABILITY_KINDS,
  ]);
  expect(BONUS_KINDS).toHaveLength(26);
  expect(new Set(BONUS_KINDS).size).toBe(26);

  const labels = BONUS_KINDS.map(bonusLabel);
  expect(labels.every((label) => label.trim().length >= 4)).toBe(true);
  expect(new Set(labels).size).toBe(BONUS_KINDS.length);

  for (const kind of BONUS_KINDS) {
    const duration = bonusDurationSeconds(kind);
    expect(Number.isFinite(duration)).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(0);
  }

  expect(BONUS_KINDS.filter((kind) => bonusDurationSeconds(kind) === 0)).toEqual([
    "shield",
    "pulse",
    "missile",
    "counterflare",
    "gravity-knot",
    "phoenix-squadron",
  ]);
  expect(bonusDurationSeconds("rapid")).toBe(8);
  expect(bonusDurationSeconds("spread")).toBe(10);
  expect(bonusDurationSeconds("plasma")).toBe(8);
  expect(bonusDurationSeconds("beam")).toBe(6);
  expect(bonusDurationSeconds("drone")).toBe(12);
  expect(bonusDurationSeconds("overdrive")).toBe(7);
  expect(bonusDurationSeconds("stasis")).toBe(8);
});

test("Jetcreeper fighters follow a circular flight path and face its tangent", () => {
  const start = fighterLoopPose(10, 5, 0, 2, 1, 0, 0);
  const quarterTurn = fighterLoopPose(10, 5, Math.PI / 2, 2, 1, 0, 0);
  const descending = fighterLoopPose(0, 10, 0, 1, 1, 0, -4);

  expect(start.x).toBeCloseTo(12);
  expect(start.y).toBeCloseTo(5);
  expect(quarterTurn.x).toBeCloseTo(10);
  expect(quarterTurn.y).toBeCloseTo(7);
  expect(descending.rotation).toBeCloseTo(Math.PI);
});

test("Jetcreeper cycles six named bosses with eighteen distinct phase weapons", () => {
  expect(BOSS_ARCHETYPES).toHaveLength(6);
  expect(new Set(BOSS_ARCHETYPES).size).toBe(6);
  expect(bossMilestoneForSector(4)).toBeNull();
  expect(bossMilestoneForSector(5)).toBe(5);
  expect(bossMilestoneForSector(9)).toBe(5);
  expect(bossMilestoneForSector(10)).toBe(10);
  expect(bossArchetypeForSector(5)).toBe("ravager");
  expect(bossArchetypeForSector(10)).toBe("stormwing");
  expect(bossArchetypeForSector(15)).toBe("dreadnought");
  expect(bossArchetypeForSector(20)).toBe("prism");
  expect(bossArchetypeForSector(25)).toBe("harvester");
  expect(bossArchetypeForSector(30)).toBe("chronarch");
  expect(bossArchetypeForSector(35)).toBe("ravager");

  const names = new Set(BOSS_ARCHETYPES.map(bossNameForArchetype));
  const movements = new Set(BOSS_ARCHETYPES.map((archetype) => (
    bossRulesForArchetype(archetype).movementFamily
  )));
  const weapons = new Set(BOSS_ARCHETYPES.flatMap((archetype) => [
    bossWeaponForPhase(archetype, 1),
    bossWeaponForPhase(archetype, 2),
    bossWeaponForPhase(archetype, 3),
  ]));
  expect(names.size).toBe(6);
  expect(movements.size).toBe(6);
  expect(weapons.size).toBe(18);
  expect(bossRulesForArchetype("dreadnought").movementFamily).toBe("broadside");
  expect(bossRulesForArchetype("chronarch")).toMatchObject({
    displayName: "Chronarch Sovereign",
    movementFamily: "temporal-lattice",
    phaseWeapons: ["clock-hand-sweep", "rewind-barrage", "time-rift-collapse"],
  });
});

test("Jetcreeper bosses have durable, archetype-scaled hulls", () => {
  expect(bossHealthForSector(5)).toBeGreaterThan(250);
  expect(bossHealthForSector(10)).toBeGreaterThan(bossHealthForSector(5));
  expect(bossHealthForSector(20, "dreadnought")).toBeGreaterThan(bossHealthForSector(20, "stormwing"));
  expect(bossHealthForSector(200)).toBeGreaterThan(5000);
  expect(bossRewardForSector(10)).toBeGreaterThan(bossRewardForSector(5));
  expect(bossPhaseForHealth(48, 48)).toBe(1);
  expect(bossPhaseForHealth(32, 48)).toBe(2);
  expect(bossPhaseForHealth(16, 48)).toBe(3);
});
