import { expect, test } from "bun:test";
import {
  beginBossEncounter,
  createEncounterCadence,
  normalWaveSpawnCount,
  recordBossDefeat,
  recordNormalWaveClear,
} from "../src/encounter_cadence.ts";

test("the first boss requires four complete normal waves", () => {
  let cadence = createEncounterCadence();
  expect(cadence.requiredNormalWaves).toBe(4);
  expect(normalWaveSpawnCount(cadence)).toBe(7);

  for (const expectedClears of [1, 2, 3]) {
    cadence = recordNormalWaveClear(cadence);
    expect(cadence.phase).toBe("normal-waves");
    expect(cadence.clearedNormalWaves).toBe(expectedClears);
  }

  cadence = recordNormalWaveClear(cadence);
  expect(cadence.phase).toBe("boss-pending");
  expect(recordNormalWaveClear(cadence)).toBe(cadence);
});

test("normal gaps alternate between three and four waves without adjacent bosses", () => {
  let cadence = createEncounterCadence();
  const gaps: number[] = [];

  for (let encounter = 0; encounter < 100; encounter += 1) {
    let clears = 0;
    while (cadence.phase === "normal-waves") {
      cadence = recordNormalWaveClear(cadence);
      clears += 1;
    }
    gaps.push(clears);
    expect(cadence.phase).toBe("boss-pending");
    cadence = beginBossEncounter(cadence);
    expect(beginBossEncounter(cadence)).toBe(cadence);
    cadence = recordBossDefeat(cadence);
    expect(cadence.phase).toBe("normal-waves");
  }

  expect(gaps.slice(0, 6)).toEqual([4, 3, 4, 3, 4, 3]);
  expect(gaps.every((gap) => gap === 3 || gap === 4)).toBe(true);
  expect(cadence.bossesDefeated).toBe(100);
});

test("invalid duplicate transitions are idempotent", () => {
  const initial = createEncounterCadence();
  expect(beginBossEncounter(initial)).toBe(initial);
  expect(recordBossDefeat(initial)).toBe(initial);
});
