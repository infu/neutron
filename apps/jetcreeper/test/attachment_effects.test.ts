import { expect, test } from "bun:test";
import {
  BOMB_AMPLIFIER_DAMAGE_MULTIPLIER,
  BOMB_AMPLIFIER_RADIUS_MULTIPLIER,
  MAGNET_ATTRACTION_RADIUS,
  NANOREPAIR_MAX_CHARGED_KILLS,
  TARGETING_MAXIMUM_LEAD_SECONDS,
  amplifiedBombPayload,
  applyNanorepairKill,
  magnetAttractionSpeed,
  phaseHullCollisionRadius,
} from "../src/attachment_effects.ts";
import { PLAYER_AIM_TUNING } from "../src/combat_targeting.ts";
import {
  REMOTE_BOMB_BLAST_RADIUS,
  REMOTE_BOMB_DAMAGE_MULTIPLIER,
} from "../src/remote_bomb.ts";

test("predictive optics extends rather than weakens the base lead window", () => {
  expect(TARGETING_MAXIMUM_LEAD_SECONDS).toBeGreaterThan(PLAYER_AIM_TUNING.maximumLeadSeconds);
});

test("bomb amplifier scales damage and radius independently", () => {
  expect(amplifiedBombPayload(90, 11, false)).toEqual({ damage: 90, radius: 11 });
  expect(amplifiedBombPayload(90, 11, true)).toEqual({
    damage: 90 * BOMB_AMPLIFIER_DAMAGE_MULTIPLIER,
    radius: 11 * BOMB_AMPLIFIER_RADIUS_MULTIPLIER,
  });
  expect(amplifiedBombPayload(
    REMOTE_BOMB_DAMAGE_MULTIPLIER,
    REMOTE_BOMB_BLAST_RADIUS,
    true,
  )).toEqual({ damage: 540, radius: 23.1 });
});

test("phase hull shrinks physics without mutating the base radius", () => {
  expect(phaseHullCollisionRadius(0.78, false)).toBe(0.78);
  expect(phaseHullCollisionRadius(0.78, true)).toBeCloseTo(0.429, 8);
});

test("magnet attraction is bounded and accelerates as a crate gets closer", () => {
  expect(magnetAttractionSpeed(MAGNET_ATTRACTION_RADIUS + 0.01)).toBe(0);
  expect(magnetAttractionSpeed(8)).toBeGreaterThan(0);
  expect(magnetAttractionSpeed(2)).toBeGreaterThan(magnetAttractionSpeed(8));
});

test("nanorepair consumes a bounded kill budget and restores one missing hull", () => {
  let state = { killsRemaining: NANOREPAIR_MAX_CHARGED_KILLS, charge: 0 };
  let lives = 2;
  let repairs = 0;

  for (let index = 0; index < 8; index += 1) {
    const outcome = applyNanorepairKill(state, lives, 3);
    state = { killsRemaining: outcome.killsRemaining, charge: outcome.charge };
    if (outcome.repairedHull) {
      lives += 1;
      repairs += 1;
    }
  }

  expect(repairs).toBe(1);
  expect(lives).toBe(3);
  expect(state.killsRemaining).toBe(0);
});

test("nanorepair holds charge while hull is full so a later kill can repair", () => {
  let state = { killsRemaining: 5, charge: 0 };
  for (let index = 0; index < 3; index += 1) {
    const outcome = applyNanorepairKill(state, 3, 3);
    state = { killsRemaining: outcome.killsRemaining, charge: outcome.charge };
    expect(outcome.repairedHull).toBe(false);
  }

  const repaired = applyNanorepairKill(state, 2, 3);
  expect(repaired.repairedHull).toBe(true);
  expect(repaired.charge).toBe(1);
});
