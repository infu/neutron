import { expect, test } from "bun:test";
import {
  advanceCaveDifficultySector,
  CAVE_DIFFICULTY_EASING_RATE_SECTORS_PER_SECOND,
  CAVE_LAYER_SPECS,
  CAVE_MAX_WALL_INTRUSION,
  CAVE_MAX_WALL_INTRUSION_RATIO,
  CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
  CAVE_WORLD_HALF_WIDTH,
  CAVE_WORLD_WIDTH,
  sampleCaveCorridor,
  sampleCaveLayerCorridor,
} from "../src/cave.ts";
import { bossRewardForSector, sectorForScore } from "../src/game_rules.ts";

test("Jetcreeper exposes exactly five distinct cave depth layers", () => {
  expect(CAVE_LAYER_SPECS).toHaveLength(5);
  expect(new Set(CAVE_LAYER_SPECS.map((layer) => layer.id)).size).toBe(5);
  expect(new Set(CAVE_LAYER_SPECS.map((layer) => layer.depth)).size).toBe(5);
  expect(new Set(CAVE_LAYER_SPECS.map((layer) => layer.darkness)).size).toBe(5);
  expect(new Set(CAVE_LAYER_SPECS.map((layer) => layer.parallax)).size).toBe(5);
  expect(CAVE_LAYER_SPECS.map((layer) => layer.parallax)).toEqual([
    0.16,
    0.34,
    0.55,
    0.77,
    1,
  ]);
});

test("Jetcreeper cave samples are deterministic, finite, and preserve longitudinal identity", () => {
  const first = sampleCaveCorridor(827.25, -7.5, 83);
  const second = sampleCaveCorridor(827.25, -7.5, 83);
  expect(first).toEqual(second);
  expect(Object.values(first).every(Number.isFinite)).toBe(true);

  for (const input of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const sample = sampleCaveCorridor(input, input, input);
    expect(Object.values(sample).every(Number.isFinite)).toBe(true);
    expect(sample.safeLeft).toBeLessThan(sample.safeRight);
  }

  // Travel and screen Y contribute to exactly one continuous longitudinal
  // coordinate, so a descending feature never changes shape between frames.
  for (const travel of [0, 250, 8_275.5]) {
    for (const delta of [0.125, 1, 7.75]) {
      expect(sampleCaveCorridor(travel, 16, 40)).toEqual(
        sampleCaveCorridor(travel + delta, 16 - delta, 40),
      );
    }
  }
});

test("fractional sectors interpolate cave pressure continuously", () => {
  const travelDistance = 1_337.25;
  const screenY = -3.5;
  const sector = 120;
  const start = sampleCaveCorridor(travelDistance, screenY, sector);
  const midpoint = sampleCaveCorridor(travelDistance, screenY, sector + 0.5);
  const end = sampleCaveCorridor(travelDistance, screenY, sector + 1);

  expect(midpoint).not.toEqual(start);
  expect(midpoint.wallLeft).toBeCloseTo((start.wallLeft + end.wallLeft) * 0.5, 10);
  expect(midpoint.wallRight).toBeCloseTo((start.wallRight + end.wallRight) * 0.5, 10);
  expect(midpoint.safeLeft).toBeCloseTo((start.safeLeft + end.safeLeft) * 0.5, 10);
  expect(midpoint.safeRight).toBeCloseTo((start.safeRight + end.safeRight) * 0.5, 10);

  let previous = start;
  for (let step = 1; step <= 10; step += 1) {
    const current = sampleCaveCorridor(
      travelDistance,
      screenY,
      sector + step / 10,
    );
    expect(Math.abs(current.wallLeft - previous.wallLeft)).toBeLessThan(0.003);
    expect(Math.abs(current.wallRight - previous.wallRight)).toBeLessThan(0.003);
    previous = current;
  }
});

test("cave difficulty eases a real boss-reward sector jump without a frame pop", () => {
  const startingSector = 175;
  const scoreBeforeBossReward = (startingSector - 1) * 1_200;
  const targetSector = sectorForScore(
    scoreBeforeBossReward + bossRewardForSector(startingSector),
  );
  const fixedDeltaSeconds = 1 / 60;
  const maximumFrameStep = CAVE_DIFFICULTY_EASING_RATE_SECTORS_PER_SECOND
    * fixedDeltaSeconds;

  expect(CAVE_DIFFICULTY_EASING_RATE_SECTORS_PER_SECOND).toBe(8);
  expect(targetSector).toBe(195);

  let easedSector = startingSector;
  for (let frame = 0; frame < 180; frame += 1) {
    const previousSector = easedSector;
    easedSector = advanceCaveDifficultySector(
      easedSector,
      targetSector,
      fixedDeltaSeconds,
    );
    expect(easedSector).toBeGreaterThanOrEqual(previousSector);
    expect(easedSector - previousSector).toBeLessThanOrEqual(maximumFrameStep + 1e-12);
    expect(easedSector).toBeLessThanOrEqual(targetSector);
  }

  expect(easedSector).toBe(targetSector);
  expect(advanceCaveDifficultySector(195, 175, fixedDeltaSeconds)).toBeCloseTo(
    195 - maximumFrameStep,
    12,
  );
  expect(advanceCaveDifficultySector(195, 175, 10)).toBe(175);
});

test("cave difficulty easing keeps hostile inputs finite, clamped, and deterministic", () => {
  const hostileInputs = [
    [Number.NaN, Number.POSITIVE_INFINITY, Number.NaN],
    [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
    [250, -50, -1],
    [-50, 250, Number.NEGATIVE_INFINITY],
  ] as const;

  for (const [current, target, deltaSeconds] of hostileInputs) {
    const first = advanceCaveDifficultySector(current, target, deltaSeconds);
    const second = advanceCaveDifficultySector(current, target, deltaSeconds);
    expect(first).toBe(second);
    expect(Number.isFinite(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(200);
  }

  expect(advanceCaveDifficultySector(50, Number.NaN, 1)).toBe(50);
  expect(advanceCaveDifficultySector(50, 100, Number.NaN)).toBe(50);
  expect(advanceCaveDifficultySector(50, 100, -1)).toBe(50);
  expect(advanceCaveDifficultySector(1, 500, 100)).toBe(200);
});

test("both physical walls obey the exact 25 percent intrusion cap", () => {
  expect(CAVE_MAX_WALL_INTRUSION_RATIO).toBe(0.25);
  expect(CAVE_MAX_WALL_INTRUSION).toBe(CAVE_WORLD_WIDTH * 0.25);

  let minimumPhysicalWidth = Number.POSITIVE_INFINITY;
  let minimumSafeWidth = Number.POSITIVE_INFINITY;
  let minimumLeftInset = Number.POSITIVE_INFINITY;
  let minimumRightInset = Number.POSITIVE_INFINITY;
  let maximumLeftInset = 0;
  let maximumRightInset = 0;

  for (const sector of [1, 40, 100, 150, 200]) {
    for (let distance = 0; distance <= 10_000; distance += 0.5) {
      const sample = sampleCaveCorridor(distance, 0, sector);
      const leftInset = sample.wallLeft + CAVE_WORLD_HALF_WIDTH;
      const rightInset = CAVE_WORLD_HALF_WIDTH - sample.wallRight;
      minimumLeftInset = Math.min(minimumLeftInset, leftInset);
      minimumRightInset = Math.min(minimumRightInset, rightInset);
      maximumLeftInset = Math.max(maximumLeftInset, leftInset);
      maximumRightInset = Math.max(maximumRightInset, rightInset);
      minimumPhysicalWidth = Math.min(minimumPhysicalWidth, sample.wallRight - sample.wallLeft);
      minimumSafeWidth = Math.min(minimumSafeWidth, sample.safeRight - sample.safeLeft);
    }
  }

  expect(minimumLeftInset).toBeGreaterThanOrEqual(0);
  expect(minimumRightInset).toBeGreaterThanOrEqual(0);
  expect(maximumLeftInset).toBeLessThanOrEqual(CAVE_MAX_WALL_INTRUSION);
  expect(maximumRightInset).toBeLessThanOrEqual(CAVE_MAX_WALL_INTRUSION);
  expect(maximumLeftInset).toBe(CAVE_MAX_WALL_INTRUSION);
  expect(maximumRightInset).toBe(CAVE_MAX_WALL_INTRUSION);
  expect(minimumPhysicalWidth).toBeGreaterThanOrEqual(
    CAVE_WORLD_WIDTH - CAVE_MAX_WALL_INTRUSION * 2,
  );
  expect(minimumSafeWidth).toBeGreaterThanOrEqual(
    CAVE_WORLD_WIDTH
      - CAVE_MAX_WALL_INTRUSION * 2
      - CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN * 2,
  );
});

test("quintic cave edges remain smooth while features scroll", () => {
  for (const sector of [1, 80, 200]) {
    let previous = sampleCaveCorridor(120, 16, sector);
    let maximumLeftStep = 0;
    let maximumRightStep = 0;

    for (let step = 1; step <= 8_000; step += 1) {
      const current = sampleCaveCorridor(120 + step * 0.125, 16, sector);
      maximumLeftStep = Math.max(maximumLeftStep, Math.abs(current.wallLeft - previous.wallLeft));
      maximumRightStep = Math.max(maximumRightStep, Math.abs(current.wallRight - previous.wallRight));
      previous = current;
    }

    expect(maximumLeftStep).toBeLessThan(0.04);
    expect(maximumRightStep).toBeLessThan(0.04);
  }
});

test("opening sectors stay generous and terminal sectors tighten without collapse", () => {
  const distances = Array.from({ length: 10_001 }, (_, index) => index);
  const averageHalfWidth = (sector: number): number => distances.reduce(
    (total, distance) => total + sampleCaveCorridor(distance, 0, sector).halfWidth,
    0,
  ) / distances.length;

  expect(averageHalfWidth(40)).toBeLessThan(averageHalfWidth(1));
  expect(averageHalfWidth(100)).toBeLessThan(averageHalfWidth(40));
  expect(averageHalfWidth(200)).toBeLessThan(averageHalfWidth(100));

  let openingMinimum = Number.POSITIVE_INFINITY;
  let terminalMinimum = Number.POSITIVE_INFINITY;
  let terminalMaximum = Number.NEGATIVE_INFINITY;
  let minimumNarrowing = 1;
  let maximumNarrowing = 0;

  for (const distance of distances) {
    const opening = sampleCaveCorridor(distance, 0, 1);
    const terminal = sampleCaveCorridor(distance, 0, 200);
    openingMinimum = Math.min(openingMinimum, opening.halfWidth);
    terminalMinimum = Math.min(terminalMinimum, terminal.halfWidth);
    terminalMaximum = Math.max(terminalMaximum, terminal.halfWidth);
    minimumNarrowing = Math.min(minimumNarrowing, terminal.narrowing);
    maximumNarrowing = Math.max(maximumNarrowing, terminal.narrowing);
  }

  expect(openingMinimum).toBeGreaterThan(7.35);
  expect(terminalMinimum).toBeGreaterThanOrEqual(
    CAVE_WORLD_HALF_WIDTH
      - CAVE_MAX_WALL_INTRUSION
      - CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
  );
  expect(terminalMaximum - terminalMinimum).toBeGreaterThan(2.5);
  expect(minimumNarrowing).toBe(0);
  expect(maximumNarrowing).toBe(1);
});

test("left and right walls wind independently instead of mirroring", () => {
  const leftInsets: number[] = [];
  const rightInsets: number[] = [];
  const centers: number[] = [];

  for (let distance = 0; distance <= 10_000; distance += 0.5) {
    const sample = sampleCaveCorridor(distance, 0, 150);
    leftInsets.push(sample.wallLeft + CAVE_WORLD_HALF_WIDTH);
    rightInsets.push(CAVE_WORLD_HALF_WIDTH - sample.wallRight);
    centers.push(sample.center);
  }

  const leftMean = leftInsets.reduce((total, value) => total + value, 0) / leftInsets.length;
  const rightMean = rightInsets.reduce((total, value) => total + value, 0) / rightInsets.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;

  for (let index = 0; index < leftInsets.length; index += 1) {
    const leftDelta = (leftInsets[index] ?? leftMean) - leftMean;
    const rightDelta = (rightInsets[index] ?? rightMean) - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }

  const correlation = covariance / Math.sqrt(leftVariance * rightVariance);
  const differences = leftInsets.map((left, index) => left - (rightInsets[index] ?? left));
  expect(correlation).toBeGreaterThan(-0.95);
  expect(correlation).toBeLessThan(0.95);
  expect(Math.max(...differences) - Math.min(...differences)).toBeGreaterThan(3.5);
  expect(Math.max(...centers) - Math.min(...centers)).toBeGreaterThan(1.75);
  expect(differences.some((difference) => Math.abs(difference) > 0.1)).toBe(true);
});

test("sector progression changes amplitude without reshuffling or popping walls", () => {
  let maximumSectorStep = 0;

  for (let sector = 1; sector < 200; sector += 1) {
    for (let distance = 0; distance <= 5_000; distance += 5) {
      const current = sampleCaveCorridor(distance, 0, sector);
      const next = sampleCaveCorridor(distance, 0, sector + 1);
      maximumSectorStep = Math.max(
        maximumSectorStep,
        Math.abs(next.wallLeft - current.wallLeft),
        Math.abs(next.wallRight - current.wallRight),
      );
    }
  }

  expect(maximumSectorStep).toBeLessThan(0.025);
});

test("all structural cave layers preserve exact down-screen advection identity", () => {
  for (const layer of CAVE_LAYER_SPECS) {
    for (const sector of [1, 80.5, 200]) {
      for (const travelDistance of [0, 312.25, 8_275.5]) {
        for (const screenY of [-18.5, -8, 0, 9.25, 18.5]) {
          for (const delta of [0.125, 1, 7.75]) {
            expect(
              sampleCaveLayerCorridor(layer, travelDistance, screenY, sector),
            ).toEqual(
              sampleCaveLayerCorridor(
                layer,
                travelDistance + delta,
                screenY - delta,
                sector,
              ),
            );
          }
        }
      }
    }
  }
});

test("all 52 rendered rows keep five finite nested apertures with an exact rim", () => {
  const visualBottom = -18.5;
  const visualTop = 18.5;
  const rowCount = 52;

  for (const sector of [1, 80.5, 150, 200]) {
    for (const travelDistance of [0, 312.25, 1_337.5, 8_275.5]) {
      for (let row = 0; row < rowCount; row += 1) {
        const ratio = row / (rowCount - 1);
        const screenY = visualBottom + ratio * (visualTop - visualBottom);
        const foreground = sampleCaveCorridor(travelDistance, screenY, sector);
        const samples = CAVE_LAYER_SPECS.map((layer) => (
          sampleCaveLayerCorridor(layer, travelDistance, screenY, sector)
        ));

        for (const sample of samples) {
          expect(sample.left).toBeGreaterThanOrEqual(foreground.wallLeft);
          expect(sample.right).toBeLessThanOrEqual(foreground.wallRight);
          expect(Object.values(sample).every(Number.isFinite)).toBe(true);
        }

        for (let index = 1; index < samples.length; index += 1) {
          expect(samples[index]!.halfWidth).toBeGreaterThan(samples[index - 1]!.halfWidth);
        }

        expect(samples.at(-1)).toEqual({
          center: foreground.center,
          halfWidth: foreground.halfWidth + CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
          left: foreground.wallLeft,
          right: foreground.wallRight,
        });
        expect(new Set(samples.map((sample) => sample.left.toFixed(4))).size).toBe(5);
      }
    }
  }
});
