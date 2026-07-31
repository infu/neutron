import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  JET_ABILITY_KINDS,
  JET_ABILITY_SPECS,
  activateJetAbility,
  createLockedJetAbilityStates,
  decideSpecialAbilities,
  jetAbilityReady,
  resolveAbilityCrate,
  type JetAbilityKind,
  type JetAbilityState,
  type JetAbilityStates,
  type SpecialAbilityDecision,
  type SpecialAbilityTacticalObservation,
} from "../src/abilities.ts";
import { ARCADE_PALETTE, ARCADE_PALETTE_ROLES } from "../src/palette.ts";

const EXPECTED_PALETTE = Object.freeze({
  void: 0x070611,
  deepPlum: 0x160c20,
  caveMauve: 0x42203f,
  ivory: 0xf6f2dc,
  aiCyan: 0x67dbef,
  playerMagenta: 0xff2f92,
  playerYellow: 0xffe45c,
  dangerCrimson: 0xff3158,
  telegraphOrange: 0xff8a3d,
  repairGreen: 0x78e66a,
  shieldAzure: 0x4cc9ff,
  plasmaCobalt: 0x597bff,
  stasisViolet: 0xa77bff,
  counterMint: 0x53f2c3,
  neutralSteel: 0x8590a8,
} as const);

function readyAbilityStates(): JetAbilityStates {
  return Object.fromEntries(JET_ABILITY_KINDS.map((kind) => [
    kind,
    { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
  ])) as unknown as JetAbilityStates;
}

function onlyAbilityState(kind: JetAbilityKind, state: JetAbilityState): JetAbilityStates {
  return {
    ...createLockedJetAbilityStates(),
    [kind]: state,
  };
}

function tactics(
  overrides: Partial<SpecialAbilityTacticalObservation> = {},
): SpecialAbilityTacticalObservation {
  return {
    abilities: readyAbilityStates(),
    nearProjectileCount: 0,
    nearRocketCount: 0,
    totalProjectileCount: 0,
    targetCount: 0,
    gravityTargetCount: 0,
    bossActive: false,
    bossEntering: false,
    bossPhase: 1,
    bossHealthRatio: 1,
    escortCount: 0,
    terminalProgress: 0,
    survivalSeconds: 2.4,
    predictedClearance: 2,
    stasisActive: false,
    dashBurstActive: false,
    ...overrides,
  };
}

function automaticUseCount(decision: SpecialAbilityDecision): number {
  return Object.values(decision).filter(Boolean).length;
}

test("automatic policy spends at most one special under overlapping critical pressure", () => {
  const decision = decideSpecialAbilities(tactics({
    nearProjectileCount: 7,
    nearRocketCount: 2,
    totalProjectileCount: 18,
    targetCount: 12,
    gravityTargetCount: 6,
    bossActive: true,
    bossPhase: 3,
    bossHealthRatio: 0.3,
    escortCount: 4,
    terminalProgress: 0.9,
    survivalSeconds: 0.4,
    predictedClearance: -0.25,
  }));

  expect(automaticUseCount(decision)).toBe(1);
  expect(decision).toEqual({
    useCounterflare: true,
    useGravityKnot: false,
    usePhoenixSquadron: false,
  });
});

test("explicit manual requests may activate every ready special together", () => {
  expect(decideSpecialAbilities(tactics({
    manualCounterflareRequested: true,
    manualGravityKnotRequested: true,
    manualPhoenixSquadronRequested: true,
  }))).toEqual({
    useCounterflare: true,
    useGravityKnot: true,
    usePhoenixSquadron: true,
  });
});

test("each automatic special owns a distinct tactical scenario", () => {
  const scenarios: Array<{
    name: string;
    observation: Partial<SpecialAbilityTacticalObservation>;
    expected: SpecialAbilityDecision;
  }> = [
    {
      name: "near-field rocket parry",
      observation: { nearRocketCount: 1 },
      expected: { useCounterflare: true, useGravityKnot: false, usePhoenixSquadron: false },
    },
    {
      name: "dense formation control",
      observation: {
        totalProjectileCount: 8,
        gravityTargetCount: 3,
        survivalSeconds: 1,
        predictedClearance: 0.45,
      },
      expected: { useCounterflare: false, useGravityKnot: true, usePhoenixSquadron: false },
    },
    {
      name: "urgent boss and escort spectacle",
      observation: {
        bossActive: true,
        bossPhase: 2,
        escortCount: 3,
        targetCount: 4,
        survivalSeconds: 1.1,
        predictedClearance: 0.4,
      },
      expected: { useCounterflare: false, useGravityKnot: false, usePhoenixSquadron: true },
    },
  ];

  for (const scenario of scenarios) {
    expect(decideSpecialAbilities(tactics(scenario.observation)), scenario.name).toEqual(scenario.expected);
  }
});

test("locked, cooling, and active systems cannot be reused", () => {
  const scenarios: Array<{
    kind: JetAbilityKind;
    decisionKey: keyof SpecialAbilityDecision;
    observation: Partial<SpecialAbilityTacticalObservation>;
  }> = [
    {
      kind: "counterflare",
      decisionKey: "useCounterflare",
      observation: { nearRocketCount: 1 },
    },
    {
      kind: "gravity-knot",
      decisionKey: "useGravityKnot",
      observation: {
        totalProjectileCount: 8,
        gravityTargetCount: 3,
        survivalSeconds: 1,
        predictedClearance: 0.45,
      },
    },
    {
      kind: "phoenix-squadron",
      decisionKey: "usePhoenixSquadron",
      observation: { bossActive: true, bossPhase: 3 },
    },
  ];

  for (const scenario of scenarios) {
    const lockedDecision = decideSpecialAbilities(tactics({
      ...scenario.observation,
      abilities: createLockedJetAbilityStates(),
    }));
    expect(lockedDecision[scenario.decisionKey], `${scenario.kind} locked`).toBe(false);

    for (const unavailableState of [
      { unlocked: true, cooldownSeconds: 1, activeSeconds: 0 },
      { unlocked: true, cooldownSeconds: 0, activeSeconds: 0.1 },
    ]) {
      const decision = decideSpecialAbilities(tactics({
        ...scenario.observation,
        abilities: onlyAbilityState(scenario.kind, unavailableState),
      }));
      expect(decision[scenario.decisionKey], `${scenario.kind} unavailable`).toBe(false);
    }
  }
});

test("crate unlocks are immediately ready and activation applies exact cooldown tiers", () => {
  expect(JET_ABILITY_KINDS.map((kind) => JET_ABILITY_SPECS[kind].cooldownSeconds)).toEqual([10, 30, 60]);

  const locked = createLockedJetAbilityStates();
  for (const kind of JET_ABILITY_KINDS) {
    const unlocked = resolveAbilityCrate(kind, locked[kind], false);
    expect(unlocked.outcome, kind).toBe("unlocked");
    expect(jetAbilityReady(unlocked.state), kind).toBe(true);

    const active = activateJetAbility(kind, unlocked.state);
    expect(active.cooldownSeconds, kind).toBe(JET_ABILITY_SPECS[kind].cooldownSeconds);
    expect(active.activeSeconds, kind).toBe(JET_ABILITY_SPECS[kind].activeSeconds);
    expect(activateJetAbility(kind, active), `${kind} cannot reactivate`).toBe(active);
  }
});

test("all 15 canonical colors are unique and materially used by visible game source", async () => {
  expect(ARCADE_PALETTE).toEqual(EXPECTED_PALETTE);
  expect(ARCADE_PALETTE_ROLES).toHaveLength(15);
  expect(new Set(Object.values(ARCADE_PALETTE)).size).toBe(15);

  const visibleSources = await Promise.all([
    readFile(new URL("../src/game.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/style.scss", import.meta.url), "utf8"),
  ]);
  const combined = visibleSources.join("\n");
  const combinedLowercase = combined.toLowerCase();

  for (const [role, color] of Object.entries(EXPECTED_PALETTE)) {
    const roleReference = new RegExp(
      `ARCADE_PALETTE\\s*(?:\\.${role}\\b|\\[\\s*["']${role}["']\\s*\\])`,
    );
    const canonicalCssHex = `#${color.toString(16).padStart(6, "0")}`;
    expect(
      roleReference.test(combined) || combinedLowercase.includes(canonicalCssHex),
      `${role} must be visible, not merely declared in palette.ts`,
    ).toBe(true);
  }
});
