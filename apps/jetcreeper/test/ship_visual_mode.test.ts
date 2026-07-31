import { expect, test } from "bun:test";
import {
  SHIP_VISUAL_PROFILES,
  emergencyHullScan,
  shipVisualMode,
} from "../src/ship_visual_mode.ts";

test("control authority selects exactly one of three ship visual modes", () => {
  expect(shipVisualMode(false, false)).toBe("manual");
  expect(shipVisualMode(false, true)).toBe("emergency");
  expect(shipVisualMode(true, false)).toBe("auto");
  expect(shipVisualMode(true, true)).toBe("emergency");
});

test("emergency keeps the Manual hull while Auto is a blue wireframe profile", () => {
  expect(SHIP_VISUAL_PROFILES.emergency).toEqual(SHIP_VISUAL_PROFILES.manual);
  expect(SHIP_VISUAL_PROFILES.manual.wireframe).toBe(false);
  expect(SHIP_VISUAL_PROFILES.auto.wireframe).toBe(true);
  expect(SHIP_VISUAL_PROFILES.auto.hullColor).not.toBe(SHIP_VISUAL_PROFILES.manual.hullColor);
  expect(SHIP_VISUAL_PROFILES.manual.engineOuterColor).toBe(0xff3b24);
  expect(SHIP_VISUAL_PROFILES.manual.engineCoreColor).toBe(0xffdf52);
});

test("emergency neon bands loop from the nose to the tail", () => {
  const first = emergencyHullScan(0, 0, 5);
  const later = emergencyHullScan(0.25, 0, 5);
  const looped = emergencyHullScan(1 / 0.92, 0, 5);

  expect(first.y).toBeCloseTo(1.42);
  expect(later.y).toBeLessThan(first.y);
  expect(looped.y).toBeCloseTo(first.y);
  expect(first.width).toBeGreaterThan(0.3);
  expect(later.opacity).toBeGreaterThan(0);
});

test("reduced motion freezes distinct emergency bands", () => {
  expect(emergencyHullScan(1, 2, 5, true)).toEqual(
    emergencyHullScan(99, 2, 5, true),
  );
  expect(emergencyHullScan(0, 0, 5, true).y).not.toBe(
    emergencyHullScan(0, 1, 5, true).y,
  );
});
