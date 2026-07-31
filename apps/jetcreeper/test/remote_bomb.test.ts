import { expect, test } from "bun:test";
import {
  REMOTE_BOMB_BLAST_RADIUS,
  REMOTE_BOMB_DAMAGE_MULTIPLIER,
  insideRemoteBombBlast,
  remoteBombDamage,
} from "../src/remote_bomb.ts";

test("remote bomb deals exactly 270x normal cannon damage", () => {
  expect(REMOTE_BOMB_DAMAGE_MULTIPLIER).toBe(270);
  expect(remoteBombDamage(1)).toBe(270);
  expect(remoteBombDamage(1.5)).toBe(405);
});

test("remote bomb has a 15.4-unit blast and includes target hull radius at its boundary", () => {
  expect(REMOTE_BOMB_BLAST_RADIUS).toBe(15.4);
  expect(insideRemoteBombBlast(0, 0, REMOTE_BOMB_BLAST_RADIUS, 0)).toBe(true);
  expect(insideRemoteBombBlast(0, 0, REMOTE_BOMB_BLAST_RADIUS + 0.5, 0, 0.5)).toBe(true);
  expect(insideRemoteBombBlast(0, 0, REMOTE_BOMB_BLAST_RADIUS + 0.51, 0, 0.5)).toBe(false);
});
