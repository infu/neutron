import { expect, test } from "bun:test";
import {
  BOSS_ARCHETYPES,
  bossArchetypeForSector,
  bossHealthForSector,
  bossRewardForSector,
  difficultyForSector,
  enemyArchetypeForKind,
  scoreForEnemy,
} from "../src/game_rules.ts";
import {
  COMBAT_SAMPLE_SECTORS,
  combatLowProfileHostileTimeScale,
  combatLowProfileLaserDamage,
  combatLowProfilePlayerSpeedMultiplier,
  combatPlannerWorkUnitsPerSecond,
  createBossCombatScenarioFixture,
  createCombatScenarioFixtures,
  evaluateCombatProgression,
  hyperoptimizeCombatProgression,
  runCombatScenario,
} from "../src/combat_progression_simulation.ts";

const SEARCH_RESULT = hyperoptimizeCombatProgression({ maximumCandidates: 8 });

test("combat progression matrix covers every sampled sector and boss archetype", () => {
  const fixtures = createCombatScenarioFixtures();

  expect(fixtures).toHaveLength(COMBAT_SAMPLE_SECTORS.length * (BOSS_ARCHETYPES.length + 1));
  expect(fixtures.filter((fixture) => fixture.kind === "formation").map((fixture) => fixture.sector))
    .toEqual([...COMBAT_SAMPLE_SECTORS]);

  for (const sector of COMBAT_SAMPLE_SECTORS) {
    const bossFixtures = fixtures.filter((fixture) => fixture.kind === "boss" && fixture.sector === sector);
    expect(bossFixtures.map((fixture) => fixture.bossArchetype)).toEqual([...BOSS_ARCHETYPES]);
  }
});

test("surrogate fixtures use production enemy and boss durability and score rules", () => {
  const fixtures = createCombatScenarioFixtures();

  for (const fixture of fixtures) {
    const difficulty = difficultyForSector(fixture.sector);
    expect(fixture.difficulty).toEqual(difficulty);

    for (const target of fixture.initialTargets) {
      if (target.kind === "boss") {
        expect(target.bossArchetype).not.toBeNull();
        expect(target.health).toBe(bossHealthForSector(fixture.sector, target.bossArchetype!));
        expect(target.score).toBe(bossRewardForSector(fixture.sector, target.bossArchetype!));
        continue;
      }

      const rules = enemyArchetypeForKind(target.kind);
      expect(target.health).toBe(Math.max(
        1,
        Math.ceil(rules.baseHealth * difficulty.enemyHealthScale * (target.elite ? 1.75 : 1)),
      ));
      expect(target.score).toBe(scoreForEnemy(target.kind) * (target.elite ? 2 : 1));
    }
  }
});

test("low-profile parity applies base, critical, time-warp, and speed multipliers exactly", () => {
  expect(combatLowProfileLaserDamage(110, 110)).toBe(10);
  expect(combatLowProfileLaserDamage(55, 110)).toBe(10);
  expect(combatLowProfileLaserDamage(54.999, 110)).toBe(50);
  expect(combatLowProfileHostileTimeScale(5)).toBeCloseTo(1 / 3);
  expect(combatLowProfileHostileTimeScale(Number.EPSILON)).toBeCloseTo(1 / 3);
  expect(combatLowProfileHostileTimeScale(0)).toBe(1);
  expect(combatLowProfilePlayerSpeedMultiplier(5)).toBe(1.5);
  expect(combatLowProfilePlayerSpeedMultiplier(0)).toBe(1);

  const result = runCombatScenario({
    id: "low-profile-critical",
    kind: "formation",
    sector: 1,
    bossArchetype: null,
    difficulty: difficultyForSector(1),
    initialTargets: [{
      id: "critical-target",
      kind: "fighter",
      bossArchetype: null,
      elite: false,
      baseX: 0,
      baseY: 0,
      radius: 1,
      health: 110,
      score: 1,
      targetPriority: 1,
      descentSpeed: 0.1,
      movementAmplitude: 0,
      movementFrequency: 0,
      movementPhase: 0,
    }],
    maximumSeconds: 3,
    weight: 1,
  }, {
    decisionStepSeconds: 0.08,
    offense: {
      laserMinimumAlignedTargets: 1,
      laserMinimumAlignedHealth: 1,
    },
  });

  expect(result.timedOut).toBe(false);
  expect(result.clearSeconds).toBe(0.64);
  expect(result.cannonShots).toBe(0);
  expect(result.damageBySource["low-profile"]).toBe(110);
  expect(result.abilityValue["low-profile"]).toMatchObject({
    uses: 1,
    potentialValue: 110,
    realizedValue: 110,
    efficiency: 1,
  });
});

test("scenario replay is deterministic and accounts for cannon, missiles, and numbered-system value", () => {
  const fixture = createCombatScenarioFixtures().find((candidate) => (
    candidate.id === "formation-200"
  ));
  expect(fixture).toBeDefined();
  const tuning = SEARCH_RESULT.winner.tuning;
  const first = runCombatScenario(fixture!, tuning);
  const replay = runCombatScenario(fixture!, tuning);

  expect(replay).toEqual(first);
  expect(first.cannonShots).toBeGreaterThan(0);
  expect(SEARCH_RESULT.winner.scenarios.some((scenario) => scenario.cannonHits > 0)).toBe(true);
  expect(first.abilityValue.missile.uses).toBeGreaterThan(0);
  expect(first.abilityValue.counterflare.uses).toBeGreaterThan(0);
  expect(first.abilityValue["phoenix-squadron"].uses).toBeGreaterThan(0);

  // The much stronger laser can make Gravity unnecessary for the optimizer's
  // winner, so exercise its target-seconds control value in a dedicated run.
  const gravityControl = runCombatScenario(fixture!, {
    offense: {
      counterflareMinimumConversions: 99,
      gravityMinimumTargets: 1,
    },
  });
  expect(gravityControl.abilityValue["gravity-knot"].uses).toBeGreaterThan(0);
  expect(gravityControl.abilityValue["gravity-knot"].realizedValue).toBeGreaterThan(0);
});

test("optimized systems clear every real boss milestone through sector 200 in bounded time", () => {
  for (let sector = 5; sector <= 200; sector += 5) {
    const fixture = createBossCombatScenarioFixture(
      sector,
      bossArchetypeForSector(sector),
      210,
    );
    const result = runCombatScenario(fixture, SEARCH_RESULT.winner.tuning);

    expect(result.timedOut).toBe(false);
    expect(result.clearSeconds).toBeLessThan(210);
    if (sector === 50) {
      expect(result.clearSeconds).toBeLessThan(90);
    }
  }
});

test("bounded deterministic search improves progression without exceeding planner work budget", () => {
  const { baseline, winner } = SEARCH_RESULT;
  const replay = evaluateCombatProgression(winner.tuning);

  expect(replay).toEqual(winner);
  expect(SEARCH_RESULT.evaluatedCandidates).toBe(8);
  expect(SEARCH_RESULT.rejectedForPlannerBudget).toBeGreaterThanOrEqual(0);
  expect(winner.objective.timedOutScenarios).toBeLessThanOrEqual(baseline.objective.timedOutScenarios);
  expect(winner.objective.estimatedSecondsToSector200)
    .toBeLessThan(baseline.objective.estimatedSecondsToSector200 * 0.5);
  expect(winner.objective.weightedScoreRate).toBeGreaterThan(baseline.objective.weightedScoreRate * 2);
  expect(combatPlannerWorkUnitsPerSecond(winner.tuning))
    .toBeLessThanOrEqual(SEARCH_RESULT.plannerWorkBudgetPerSecond);
  expect(winner.objective.plannerWorkUnitsPerSecond)
    .toBeLessThanOrEqual(SEARCH_RESULT.plannerWorkBudgetPerSecond);
});
