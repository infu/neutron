import { expect, test } from "bun:test";
import {
  JET_ATTACHMENT_KINDS,
  JET_ATTACHMENT_MODIFIER_FAMILIES,
  JET_ATTACHMENT_SPECS,
  isJetAttachmentKind,
  jetAttachmentSpec,
} from "../src/attachments.ts";

test("Jetcreeper exposes exactly twenty honest timed attachment modifiers", () => {
  expect(JET_ATTACHMENT_KINDS).toHaveLength(20);
  expect(new Set(JET_ATTACHMENT_KINDS).size).toBe(20);
  expect(JET_ATTACHMENT_MODIFIER_FAMILIES).toHaveLength(20);
  expect(new Set(JET_ATTACHMENT_MODIFIER_FAMILIES).size).toBe(20);
  expect(Object.keys(JET_ATTACHMENT_SPECS)).toEqual([...JET_ATTACHMENT_KINDS]);

  const specs = JET_ATTACHMENT_KINDS.map(jetAttachmentSpec);
  expect(specs.map((spec) => spec.kind)).toEqual([...JET_ATTACHMENT_KINDS]);
  expect(new Set(specs.map((spec) => spec.label)).size).toBe(20);
  expect(new Set(specs.map((spec) => spec.modifierFamily)).size).toBe(20);
  expect(new Set(specs.map((spec) => spec.effect)).size).toBe(20);

  for (const spec of specs) {
    expect(Number.isFinite(spec.durationSeconds)).toBe(true);
    expect(spec.durationSeconds).toBeGreaterThan(0);
    expect(spec.label.trim().length).toBeGreaterThanOrEqual(4);
    expect(spec.effect.trim().length).toBeGreaterThanOrEqual(24);
    expect(JET_ATTACHMENT_MODIFIER_FAMILIES).toContain(spec.modifierFamily);
  }
});

test("the seven existing timed modifiers seed the expanded attachment roster", () => {
  expect(JET_ATTACHMENT_KINDS.slice(0, 7)).toEqual([
    "rapid",
    "spread",
    "plasma",
    "beam",
    "drone",
    "overdrive",
    "stasis",
  ]);

  expect(JET_ATTACHMENT_KINDS.slice(7)).toEqual([
    "piercing",
    "ricochet",
    "chain-lightning",
    "explosive",
    "cryo",
    "targeting",
    "accelerator",
    "afterburner",
    "phase-hull",
    "magnet",
    "nanorepair",
    "missile-rack",
    "bomb-amplifier",
  ]);
});

test("attachment kind guards reject consumables and ability cores", () => {
  for (const kind of JET_ATTACHMENT_KINDS) {
    expect(isJetAttachmentKind(kind)).toBe(true);
  }

  for (const kind of ["shield", "pulse", "missile", "counterflare", "gravity-knot", "phoenix-squadron"]) {
    expect(isJetAttachmentKind(kind)).toBe(false);
  }
});
