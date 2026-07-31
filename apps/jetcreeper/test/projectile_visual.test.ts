import { describe, expect, test } from "bun:test";
import {
  cometTailOffsetY,
  projectileHeadingRadians,
} from "../src/projectile_visual.ts";

describe("directional comet projectiles", () => {
  test("aligns the modeled nose with all cardinal travel directions", () => {
    expect(projectileHeadingRadians(0, 12)).toBeCloseTo(0);
    expect(projectileHeadingRadians(12, 0)).toBeCloseTo(-Math.PI / 2);
    expect(Math.abs(projectileHeadingRadians(0, -12))).toBeCloseTo(Math.PI);
    expect(projectileHeadingRadians(-12, 0)).toBeCloseTo(Math.PI / 2);
  });

  test("tracks diagonal steering and retains a finite fallback at rest", () => {
    expect(projectileHeadingRadians(5, 5)).toBeCloseTo(-Math.PI / 4);
    expect(projectileHeadingRadians(-5, 5)).toBeCloseTo(Math.PI / 4);
    expect(projectileHeadingRadians(0, 0, 0.37)).toBe(0.37);
    expect(projectileHeadingRadians(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)).toBe(0);
  });

  test("keeps every decorative tail behind the bright-head hitbox origin", () => {
    for (const frontY of [0.24, 0.28]) {
      for (const lengthScale of [0.65, 0.8, 1, 1.1, 1.25, 1.75]) {
        const offsetY = cometTailOffsetY(frontY, lengthScale);
        expect(offsetY + frontY * lengthScale).toBeCloseTo(0, 12);
        expect(offsetY).toBeLessThanOrEqual(0);
      }
    }
    expect(cometTailOffsetY(Number.NaN, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
