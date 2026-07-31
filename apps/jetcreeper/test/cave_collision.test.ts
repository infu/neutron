import { expect, test } from "bun:test";
import {
  CAVE_MAX_SWEEP_SAMPLES,
  CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
  caveWallClearance,
  sampleCaveCorridor,
  sweepCircleThroughCave,
} from "../src/cave.ts";

const PLAYER_RADIUS = 0.78;

test("wall clearance is signed, tangent at zero, and finite for hostile inputs", () => {
  const sample = sampleCaveCorridor(931.5, -7, 120);
  const leftTangent = sample.wallLeft + PLAYER_RADIUS + CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN;
  const rightTangent = sample.wallRight - PLAYER_RADIUS - CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN;

  expect(caveWallClearance(sample, sample.center, PLAYER_RADIUS)).toBeGreaterThan(0);
  expect(caveWallClearance(sample, leftTangent, PLAYER_RADIUS)).toBeCloseTo(0, 12);
  expect(caveWallClearance(sample, rightTangent, PLAYER_RADIUS)).toBeCloseTo(0, 12);
  expect(caveWallClearance(sample, leftTangent - 0.1, PLAYER_RADIUS)).toBeCloseTo(-0.1, 12);
  expect(caveWallClearance(sample, rightTangent + 0.1, PLAYER_RADIUS)).toBeCloseTo(-0.1, 12);

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(Number.isFinite(caveWallClearance(sample, value, value, value))).toBe(true);
  }
});

test("stationary and tangent sweeps distinguish safe space from immediate contact", () => {
  const sample = sampleCaveCorridor(500, -8, 90);
  const safe = sweepCircleThroughCave({
    startTravelDistance: 500,
    endTravelDistance: 500,
    start: { x: sample.center, y: -8 },
    end: { x: sample.center, y: -8 },
    sector: 90,
    radius: PLAYER_RADIUS,
  });
  expect(safe.collided).toBe(false);
  expect(safe.collisionRatio).toBeNull();
  expect(safe.side).toBeNull();
  expect(safe.minimumClearance).toBeGreaterThan(0);

  const tangentX = sample.wallLeft + PLAYER_RADIUS + CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN;
  const tangent = sweepCircleThroughCave({
    startTravelDistance: 500,
    endTravelDistance: 500,
    start: { x: tangentX, y: -8 },
    end: { x: tangentX, y: -8 },
    sector: 90,
    radius: PLAYER_RADIUS,
  });
  expect(tangent.collided).toBe(true);
  expect(tangent.collisionRatio).toBe(0);
  expect(tangent.side).toBe("left");
  expect(tangent.minimumClearance).toBeCloseTo(0, 12);
});

test("a long dash receives a refined first-contact ratio instead of tunnelling", () => {
  const travel = 1_275;
  const y = -4;
  const sample = sampleCaveCorridor(travel, y, 150);
  const rightLimit = sample.wallRight - PLAYER_RADIUS - CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN;
  const endX = sample.wallRight + 2;
  const expectedRatio = (rightLimit - sample.center) / (endX - sample.center);
  const result = sweepCircleThroughCave({
    startTravelDistance: travel,
    endTravelDistance: travel,
    start: { x: sample.center, y },
    end: { x: endX, y },
    sector: 150,
    radius: PLAYER_RADIUS,
  });

  expect(result.collided).toBe(true);
  expect(result.side).toBe("right");
  expect(result.collisionRatio).not.toBeNull();
  expect(result.collisionRatio ?? 0).toBeCloseTo(expectedRatio, 3);
  expect(result.minimumClearance).toBeLessThan(0);
  expect(result.collisionPosition?.x ?? 0).toBeCloseTo(rightLimit, 2);
});

test("adaptive midpoint samples catch a moving wall when both endpoints are clear", () => {
  // This fixed region has a right-wall shoulder between two open cross-sections.
  const result = sweepCircleThroughCave({
    startTravelDistance: 442.75,
    endTravelDistance: 474.75,
    start: { x: 7.3, y: 0 },
    end: { x: 7.3, y: 0 },
    sector: 60,
    radius: PLAYER_RADIUS,
  });
  const start = sampleCaveCorridor(442.75, 0, 60);
  const end = sampleCaveCorridor(474.75, 0, 60);

  expect(caveWallClearance(start, 7.3, PLAYER_RADIUS)).toBeGreaterThan(0);
  expect(caveWallClearance(end, 7.3, PLAYER_RADIUS)).toBeGreaterThan(0);
  expect(result.collided).toBe(true);
  expect(result.side).toBe("right");
  expect(result.collisionRatio ?? 0).toBeGreaterThan(0.1);
  expect(result.collisionRatio ?? 1).toBeLessThan(0.9);
  expect(result.minimumClearance).toBeLessThan(0);
  expect(result.sampleCount).toBe(CAVE_MAX_SWEEP_SAMPLES);
});

test("vertical movement and cave travel share the same collision field", () => {
  const travelSweep = sweepCircleThroughCave({
    startTravelDistance: 442.75,
    endTravelDistance: 474.75,
    start: { x: 7.3, y: 0 },
    end: { x: 7.3, y: 0 },
    sector: 60,
    radius: PLAYER_RADIUS,
  });
  const verticalSweep = sweepCircleThroughCave({
    startTravelDistance: 442.75,
    endTravelDistance: 442.75,
    start: { x: 7.3, y: 0 },
    end: { x: 7.3, y: 32 },
    sector: 60,
    radius: PLAYER_RADIUS,
  });

  expect(verticalSweep.collided).toBe(travelSweep.collided);
  expect(verticalSweep.collisionRatio).toBeCloseTo(travelSweep.collisionRatio ?? 0, 12);
  expect(verticalSweep.minimumClearance).toBeCloseTo(travelSweep.minimumClearance, 12);
  expect(verticalSweep.sample).toEqual(travelSweep.sample);
});

test("low-profile footprint can clear a route rejected by the normal jet", () => {
  let fixture: { travel: number; x: number } | null = null;

  for (let travel = 0; travel <= 10_000 && fixture === null; travel += 0.5) {
    const sample = sampleCaveCorridor(travel, -8, 200);
    const x = sample.wallLeft + 0.65 + CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN;
    if (
      caveWallClearance(sample, x, PLAYER_RADIUS) < -0.1
      && caveWallClearance(sample, x, 0.42) > 0.1
    ) {
      fixture = { travel, x };
    }
  }

  expect(fixture).not.toBeNull();
  const normal = sweepCircleThroughCave({
    startTravelDistance: fixture?.travel ?? 0,
    endTravelDistance: fixture?.travel ?? 0,
    start: { x: fixture?.x ?? 0, y: -8 },
    end: { x: fixture?.x ?? 0, y: -8 },
    sector: 200,
    radius: PLAYER_RADIUS,
  });
  const lowProfile = sweepCircleThroughCave({
    startTravelDistance: fixture?.travel ?? 0,
    endTravelDistance: fixture?.travel ?? 0,
    start: { x: fixture?.x ?? 0, y: -8 },
    end: { x: fixture?.x ?? 0, y: -8 },
    sector: 200,
    radius: 0.42,
  });

  expect(normal.collided).toBe(true);
  expect(lowProfile.collided).toBe(false);
});

test("sweep fallbacks stay finite, deterministic, and bounded", () => {
  const options = {
    startTravelDistance: Number.NaN,
    endTravelDistance: Number.POSITIVE_INFINITY,
    start: { x: Number.NaN, y: Number.NEGATIVE_INFINITY },
    end: { x: Number.POSITIVE_INFINITY, y: Number.NaN },
    sector: Number.NaN,
    radius: Number.NaN,
    clearanceMargin: Number.NaN,
    maximumSampleSpacing: Number.NaN,
    maximumSamples: Number.POSITIVE_INFINITY,
  } as const;
  const first = sweepCircleThroughCave(options);
  const replay = sweepCircleThroughCave(options);

  expect(replay).toEqual(first);
  expect(Number.isFinite(first.minimumClearance)).toBe(true);
  expect(Object.values(first.sample).every(Number.isFinite)).toBe(true);
  expect(first.sampleCount).toBeGreaterThanOrEqual(2);
  expect(first.sampleCount).toBeLessThanOrEqual(CAVE_MAX_SWEEP_SAMPLES);
});
