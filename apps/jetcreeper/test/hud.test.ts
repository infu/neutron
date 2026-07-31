import { expect, test } from "bun:test";
import {
  brainButtonHudReadout,
  circularCooldownProgress,
  cooldownCounterLabel,
  flightModeHudReadout,
  skillActionHudReadouts,
  visibleWeaponEffects,
} from "../src/hud.ts";
import { JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS } from "../src/abilities.ts";

function skillSnapshot() {
  return {
    dashActiveSeconds: 0,
    dashCooldownSeconds: 0,
    burstSeconds: 0,
    lowProfileSeconds: 0,
    lowProfileCooldownSeconds: 0,
    missileCooldownSeconds: 0,
    remoteBombActive: false,
    remoteBombArmedSeconds: 0,
    remoteBombCooldownSeconds: 0,
    guardianWingSeconds: 0,
    guardianWingCooldownSeconds: 0,
    jetAbilities: [
      { kind: "counterflare" as const, unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
      { kind: "gravity-knot" as const, unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
      { kind: "phoenix-squadron" as const, unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
    ],
  };
}

test("automatic flight HUD keeps human input framed as an optional nudge", () => {
  expect(flightModeHudReadout(true)).toEqual({
    title: "Super Brain",
    toggleLabel: "Auto",
    statusFallback: "Standby",
    guidance: "WASD / arrows nudge the route · auto cannon stays on",
    toggleHint: "Press Q for Manual Flight",
  });
});

test("manual flight HUD explains direct steering without implying manual weapons", () => {
  expect(flightModeHudReadout(false)).toEqual({
    title: "Manual Flight",
    toggleLabel: "Manual",
    statusFallback: "Direct steering",
    guidance: "WASD / arrows steer directly · auto cannon stays on",
    toggleHint: "Press Q for Super Brain automatic flight",
  });
});

test("brain button exposes emergency authority without pretending Auto is selected", () => {
  expect(brainButtonHudReadout(false, true, 7.2)).toEqual({
    active: true,
    pressed: "mixed",
    mode: "Emergency assist controlling movement; Manual returns in at most 8 seconds",
  });
  expect(brainButtonHudReadout(false, false, Number.NaN)).toEqual({
    active: false,
    pressed: false,
    mode: "Manual flight enabled",
  });
});

test("skill action bar always exposes eight ordered icon states with number shortcuts", () => {
  const readouts = skillActionHudReadouts(skillSnapshot());

  expect(readouts.map(({ kind, key }) => [kind, key])).toEqual([
    ["dash", "1"],
    ["low-profile", "2"],
    ["missiles", "3"],
    ["counterflare", "4"],
    ["gravity-knot", "5"],
    ["phoenix-squadron", "6"],
    ["remote-bomb", "7"],
    ["guardian-wing", "8"],
  ]);
  expect(readouts.map(({ phase }) => phase)).toEqual([
    "ready",
    "ready",
    "ready",
    "locked",
    "locked",
    "locked",
    "ready",
    "ready",
  ]);
});

test("remote bomb advertises second-press detonation and Guardian Wing reports active fire and defense", () => {
  const readouts = skillActionHudReadouts({
    ...skillSnapshot(),
    remoteBombActive: true,
    remoteBombArmedSeconds: 3.4,
    guardianWingSeconds: 3.2,
    guardianWingCooldownSeconds: 7.2,
  });

  expect(readouts.find(({ kind }) => kind === "remote-bomb")).toMatchObject({
    phase: "active",
    status: "Press 7 · Detonate · 3.4s",
  });
  expect(readouts.find(({ kind }) => kind === "guardian-wing")).toMatchObject({
    phase: "active",
    status: "Wingmen firing + defending 3.2s",
    cooldownProgress: 0.9,
  });
});

test("skill cooldown rings clamp progress and keep active state ahead of cooldown", () => {
  const snapshot = skillSnapshot();
  const readouts = skillActionHudReadouts({
    ...snapshot,
    dashActiveSeconds: 0.2,
    dashCooldownSeconds: JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS.dash / 2,
    jetAbilities: snapshot.jetAbilities.map((ability) => ability.kind === "counterflare"
      ? { ...ability, unlocked: true, cooldownSeconds: 9, activeSeconds: 0.4 }
      : ability),
  });

  expect(readouts[0]).toMatchObject({ phase: "active", cooldownProgress: 0.5 });
  expect(readouts[3]).toMatchObject({ phase: "active", cooldownProgress: 0.9 });
  expect(circularCooldownProgress(-3, 5)).toBe(0);
  expect(circularCooldownProgress(8, 5)).toBe(1);
  expect(circularCooldownProgress(Number.NaN, 5)).toBe(0);
  expect(circularCooldownProgress(2, 0)).toBe(0);
});

test("skill countdown labels use whole seconds then tenths without noisy ready text", () => {
  expect(cooldownCounterLabel(10)).toBe("10");
  expect(cooldownCounterLabel(1.01)).toBe("2");
  expect(cooldownCounterLabel(0.94)).toBe("0.9");
  expect(cooldownCounterLabel(0.04)).toBe("");
  expect(cooldownCounterLabel(Number.NaN)).toBe("");
});

test("active arsenal effects are deduplicated by gameplay id", () => {
  const effects = visibleWeaponEffects({
    activeWeaponEffects: [
      { id: "rapid", label: "Rapid fire", seconds: 2.4 },
      { id: "shield", label: "Shield", seconds: null },
    ],
    rapidFireSeconds: 2.4,
    shielded: true,
  });

  expect(effects).toEqual([
    { id: "rapid", label: "Rapid fire 3s" },
    { id: "shield", label: "Shield ready" },
  ]);
});

test("legacy rapid and shield state still produce one readable chip each", () => {
  const effects = visibleWeaponEffects({
    activeWeaponEffects: [],
    rapidFireSeconds: 1.2,
    shielded: true,
  });

  expect(effects).toEqual([
    { id: "shield", label: "Shield ready" },
    { id: "rapid", label: "Rapid fire 2s" },
  ]);
});
