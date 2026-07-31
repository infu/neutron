import { expect, test } from "bun:test";
import { SUPER_BRAIN_DECISION_INTERVAL_SECONDS } from "../src/autopilot.ts";
import {
  PRESSURE_RESOURCES,
  PRESSURE_THREAT_PATTERNS,
  runPressureSimulation,
} from "../src/pressure_simulation.ts";
import { difficultyForSector } from "../src/game_rules.ts";
import { BASELINE_ENEMY_PRESSURE_TUNING } from "../src/game_rules.ts";

const PRIMARY_SEED = 0x5eed_0200;
const SECONDARY_SEED = 0x00c0_ffee;

test("mixed pressure simulation is deterministic and honors hard entity caps", () => {
  const first = runPressureSimulation({ sector: 150, seed: PRIMARY_SEED, durationSeconds: 4.8 });
  const replay = runPressureSimulation({ sector: 150, seed: PRIMARY_SEED, durationSeconds: 4.8 });
  const explicitProductionCadence = runPressureSimulation({
    sector: 150,
    seed: PRIMARY_SEED,
    durationSeconds: 4.8,
    decisionStepSeconds: SUPER_BRAIN_DECISION_INTERVAL_SECONDS,
  });
  const difficulty = difficultyForSector(150);

  expect(replay).toEqual(first);
  expect(explicitProductionCadence).toEqual(first);
  expect(replay.determinismHash).toBe(first.determinismHash);
  expect(first.peakConcurrentThreats).toBeLessThanOrEqual(difficulty.maxEnemyProjectiles);
  expect(first.peakConcurrentRockets).toBeLessThanOrEqual(difficulty.maxEnemyRockets);
  for (const pattern of PRESSURE_THREAT_PATTERNS) {
    expect(first.attemptedByPattern[pattern], pattern).toBeGreaterThan(0);
    expect(first.spawnedByPattern[pattern], pattern).toBeGreaterThan(0);
  }
});

test("current pressure curve stays readable early and becomes terminal around sector 200", () => {
  const opening = runPressureSimulation({ sector: 1, seed: PRIMARY_SEED, durationSeconds: 6 });
  const midgame = runPressureSimulation({ sector: 100, seed: PRIMARY_SEED, durationSeconds: 6 });
  const terminalRuns = [PRIMARY_SEED, SECONDARY_SEED].map((seed) => (
    runPressureSimulation({ sector: 200, seed, durationSeconds: 6 })
  ));

  expect(opening.gameOver).toBe(false);
  expect(opening.damageTaken).toBe(0);
  expect(midgame.gameOver).toBe(false);
  // Sector 1 remains fully protected. Under the intentionally harder curve,
  // sector 100 may land one late hit but must stay readable and non-terminal.
  expect(midgame.damageTaken).toBeLessThanOrEqual(1);
  expect(midgame.firstDamageSeconds ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(5);

  for (const resource of PRESSURE_RESOURCES) {
    expect(midgame.resourceUses[resource], `${resource} exercised by representative pressure`).toBeGreaterThan(0);
  }

  for (const terminal of terminalRuns) {
    expect(terminal.gameOver).toBe(true);
    expect(terminal.damageTaken).toBe(3);
    expect(terminal.survivedSeconds).toBeLessThan(4.2);
    expect(terminal.firstDamageSeconds ?? Number.POSITIVE_INFINITY).toBeLessThan(0.9);
    expect(terminal.minimumPredictedSurvivalSeconds).toBe(0);
    expect(terminal.minimumPredictedClearance).toBeLessThan(-1);
  }
});

test("resource accounting separates useful, wasted, and unfinished defense windows", () => {
  const measured = runPressureSimulation({ sector: 125, seed: 5, durationSeconds: 4.8 });

  expect(measured.resourceUses["low-profile"]).toBe(1);
  for (const resource of PRESSURE_RESOURCES) {
    expect(measured.resourceWaste[resource]).toBeLessThanOrEqual(measured.resourceUses[resource]);
    expect(measured.unresolvedResourceWindows[resource]).toBeLessThanOrEqual(measured.resourceUses[resource]);
  }
  for (const special of ["counterflare", "gravity-knot", "phoenix-squadron"] as const) {
    expect(measured.resourceUses[special]).toBe(1);
    expect(measured.threatsClearedByResource[special]).toBeGreaterThan(0);
    expect(measured.resourceWaste[special]).toBe(0);
  }
});

test("runtime admission throttles unsafe pre-terminal pressure but fully opens at sector 200", () => {
  const preterminalAdversarial = runPressureSimulation({
    sector: 150,
    seed: PRIMARY_SEED,
    durationSeconds: 6,
    admissionMode: "adversarial",
  });
  const preterminalRuntime = runPressureSimulation({
    sector: 150,
    seed: PRIMARY_SEED,
    durationSeconds: 6,
    admissionMode: "runtime",
  });
  const terminalAdversarial = runPressureSimulation({
    sector: 200,
    seed: PRIMARY_SEED,
    durationSeconds: 6,
    admissionMode: "adversarial",
  });
  const terminalRuntime = runPressureSimulation({
    sector: 200,
    seed: PRIMARY_SEED,
    durationSeconds: 6,
    admissionMode: "runtime",
  });
  const spawnedCount = (result: typeof preterminalRuntime): number => (
    Object.values(result.spawnedByPattern).reduce((total, count) => total + count, 0)
  );

  expect(preterminalRuntime.rejectedForGlobalPressureGate).toBeGreaterThan(0);
  expect(spawnedCount(preterminalRuntime)).toBeLessThan(spawnedCount(preterminalAdversarial));
  expect(preterminalRuntime.collisions).toBeLessThan(preterminalAdversarial.collisions);

  expect(terminalRuntime.rejectedForGlobalPressureGate).toBe(0);
  expect(terminalRuntime).toEqual({
    ...terminalAdversarial,
    admissionMode: "runtime",
  });
});

test("hostile tuning overrides are deterministic and remain behind hard caps", () => {
  const options = {
    sector: 150,
    seed: SECONDARY_SEED,
    durationSeconds: 4.8,
    admissionMode: "runtime" as const,
    hostileTuning: BASELINE_ENEMY_PRESSURE_TUNING,
  };
  const first = runPressureSimulation(options);
  const replay = runPressureSimulation(options);
  const production = runPressureSimulation({
    sector: options.sector,
    seed: options.seed,
    durationSeconds: options.durationSeconds,
    admissionMode: options.admissionMode,
  });
  const difficulty = difficultyForSector(options.sector);

  expect(replay).toEqual(first);
  expect(production.determinismHash).not.toBe(first.determinismHash);
  expect(first.peakConcurrentThreats).toBeLessThanOrEqual(difficulty.maxEnemyProjectiles);
  expect(first.peakConcurrentRockets).toBeLessThanOrEqual(difficulty.maxEnemyRockets);
  expect(production.peakConcurrentThreats).toBeLessThanOrEqual(difficulty.maxEnemyProjectiles);
  expect(production.peakConcurrentRockets).toBeLessThanOrEqual(difficulty.maxEnemyRockets);
});
