import { expect, test } from "bun:test";
import {
  PILOT_LINE_NODE_COUNT,
  PILOT_SYNC_TARGET,
  nextPilotNodeAfterCrossing,
  pilotLanePattern,
  pilotLaneTarget,
  pilotNodeRemainingSeconds,
  resolvePilotLine,
} from "../src/pilot_lines.ts";

test("Pilot Lines trace a three-node side-to-side route inside safe cave bounds", () => {
  expect(pilotLanePattern(-1)).toEqual([-1, 0, 1]);
  expect(pilotLanePattern(1)).toEqual([1, 0, -1]);

  for (const lane of pilotLanePattern(-1)) {
    const target = pilotLaneTarget(-6.5, 5.5, lane);
    expect(target).toBeGreaterThanOrEqual(-4.5);
    expect(target).toBeLessThanOrEqual(3.5);
  }

  expect(pilotNodeRemainingSeconds(4, -5, -16)).toBe(4);
  expect(PILOT_LINE_NODE_COUNT).toBe(3);
});

test("Pilot Line nodes require recent human input and ordered crossings", () => {
  expect(nextPilotNodeAfterCrossing(0, 0, 0)).toBe(0);
  expect(nextPilotNodeAfterCrossing(0, 1, 1)).toBe(0);
  expect(nextPilotNodeAfterCrossing(0, 0, 0.8)).toBe(1);
  expect(nextPilotNodeAfterCrossing(1, 1, 0.2)).toBe(2);
  expect(nextPilotNodeAfterCrossing(2, 2, 0.2)).toBe(3);
  expect(nextPilotNodeAfterCrossing(3, 2, 1)).toBe(3);
});

test("missing a Pilot Line is neutral while every third success earns a bounded strike", () => {
  const missed = resolvePilotLine(2, 200, false);
  expect(missed).toEqual({
    completed: false,
    nextSync: 2,
    styleScore: 0,
    rapidFireSeconds: 0,
    burstSeconds: 0,
    syncStrike: false,
  });

  const normal = resolvePilotLine(0, 10, true);
  expect(normal.nextSync).toBe(1);
  expect(normal.styleScore).toBeGreaterThan(0);
  expect(normal.rapidFireSeconds).toBeLessThanOrEqual(2.25);
  expect(normal.burstSeconds).toBe(0);

  const strike = resolvePilotLine(PILOT_SYNC_TARGET - 1, 10, true);
  expect(strike.nextSync).toBe(0);
  expect(strike.syncStrike).toBe(true);
  expect(strike.burstSeconds).toBe(1);
});
