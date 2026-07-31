import { describe, expect, test } from "bun:test";
import {
  DASH_BARREL_ROLL_SECONDS,
  RESTING_FLIGHT_MOTION,
  dashBarrelRollAngle,
  stepFlightMotion,
  targetFlightMotion,
} from "../src/flight_motion.ts";

const BASE_INPUT = {
  velocityX: 0,
  velocityY: 0,
  accelerationX: 0,
  accelerationY: 0,
  maximumSpeed: 12,
  manualInfluence: 0,
  dashActive: false,
  reducedMotion: false,
} as const;

describe("visual flight motion", () => {
  test("dash performs one deterministic longitudinal turn with reduced-motion safety", () => {
    expect(DASH_BARREL_ROLL_SECONDS).toBe(0.42);
    expect(dashBarrelRollAngle(0, 1, false)).toBe(0);
    expect(dashBarrelRollAngle(0.5, 1, false)).toBeCloseTo(Math.PI, 12);
    expect(dashBarrelRollAngle(1, 1, false)).toBeCloseTo(Math.PI * 2, 12);
    expect(dashBarrelRollAngle(0.5, -1, false)).toBeCloseTo(-Math.PI, 12);
    expect(dashBarrelRollAngle(Number.NaN, Number.NaN, false)).toBe(0);
    expect(dashBarrelRollAngle(0.5, 1, true)).toBe(0);
  });

  test("rests level with compact, balanced exhaust", () => {
    expect(targetFlightMotion(BASE_INPUT)).toEqual(RESTING_FLIGHT_MOTION);
  });

  test("banks, yaws, and feathers the engines from real lateral motion", () => {
    const target = targetFlightMotion({
      ...BASE_INPUT,
      velocityX: 9,
      velocityY: 5,
      accelerationX: 48,
      manualInfluence: 1,
    });

    expect(target.bank).toBeLessThan(-0.4);
    expect(target.yaw).toBeLessThan(-0.07);
    expect(target.rightExhaust).toBeGreaterThan(target.leftExhaust);
    expect(target.leftExhaust).toBeGreaterThan(RESTING_FLIGHT_MOTION.leftExhaust);
  });

  test("dash produces a long, narrow plume without unbounded angles", () => {
    const target = targetFlightMotion({
      ...BASE_INPUT,
      velocityX: Number.POSITIVE_INFINITY,
      velocityY: 46,
      accelerationX: Number.NaN,
      accelerationY: 800,
      dashActive: true,
    });

    expect(Number.isFinite(target.bank)).toBe(true);
    expect(Math.abs(target.pitch)).toBeLessThanOrEqual(0.16);
    expect(target.leftExhaust).toBeGreaterThan(2);
    expect(target.exhaustWidth).toBeLessThan(RESTING_FLIGHT_MOTION.exhaustWidth);
  });

  test("reduced motion preserves direction cues at substantially lower angles", () => {
    const standard = targetFlightMotion({
      ...BASE_INPUT,
      velocityX: -10,
      accelerationX: -60,
    });
    const reduced = targetFlightMotion({
      ...BASE_INPUT,
      velocityX: -10,
      accelerationX: -60,
      reducedMotion: true,
    });

    expect(reduced.bank).toBeGreaterThan(0);
    expect(Math.abs(reduced.bank)).toBeLessThan(Math.abs(standard.bank) * 0.4);
    expect(Math.abs(reduced.yaw)).toBeLessThan(Math.abs(standard.yaw) * 0.4);
  });

  test("recovers smoothly toward level without overshoot", () => {
    const banked = targetFlightMotion({
      ...BASE_INPUT,
      velocityX: 11,
      accelerationX: 60,
    });
    let state = banked;

    for (let frame = 0; frame < 90; frame += 1) {
      const next = stepFlightMotion(state, BASE_INPUT, 1 / 60);
      expect(Math.abs(next.bank)).toBeLessThanOrEqual(Math.abs(state.bank));
      state = next;
    }

    expect(Math.abs(state.bank)).toBeLessThan(0.001);
    expect(Math.abs(state.yaw)).toBeLessThan(0.001);
  });

  test("manual influence makes visual steering respond sooner", () => {
    const input = {
      ...BASE_INPUT,
      velocityX: 8,
      accelerationX: 40,
    };
    const autonomous = stepFlightMotion(RESTING_FLIGHT_MOTION, input, 1 / 60);
    const manual = stepFlightMotion(
      RESTING_FLIGHT_MOTION,
      { ...input, manualInfluence: 1 },
      1 / 60,
    );

    expect(Math.abs(manual.bank)).toBeGreaterThan(Math.abs(autonomous.bank));
  });
});
