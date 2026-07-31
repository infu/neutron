import { expect, test } from "bun:test";
import {
  JET_ABILITY_KINDS,
  JET_ABILITY_SPECS,
  JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS,
  JET_FLIGHT_SYSTEM_KEYS,
  JET_FLIGHT_SYSTEM_KINDS,
  activateJetAbility,
  createLockedJetAbilityStates,
  decideSpecialAbilities,
  jetAbilityReady,
  jetFlightSystemForKeyboardCode,
  nextGuaranteedAbilityCore,
  resolveAbilityCrate,
  tickJetAbilityState,
  type SpecialAbilityTacticalObservation,
} from "../src/abilities.ts";
import { ARCADE_PALETTE, ARCADE_PALETTE_ROLES } from "../src/palette.ts";

function tactics(
  overrides: Partial<SpecialAbilityTacticalObservation> = {},
): SpecialAbilityTacticalObservation {
  const unlocked = Object.fromEntries(JET_ABILITY_KINDS.map((kind) => [
    kind,
    { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
  ])) as unknown as SpecialAbilityTacticalObservation["abilities"];

  return {
    abilities: unlocked,
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

test("crate systems have exact 10, 30, and 60 second base cooldowns", () => {
  expect(JET_ABILITY_KINDS).toEqual(["counterflare", "gravity-knot", "phoenix-squadron"]);
  expect(JET_ABILITY_KINDS.map((kind) => JET_ABILITY_SPECS[kind].cooldownSeconds)).toEqual([10, 30, 60]);
  expect(JET_ABILITY_KINDS.map((kind) => JET_ABILITY_SPECS[kind].key)).toEqual(["4", "5", "6"]);
});

test("all eight flight systems use one memorable number sequence", () => {
  expect(JET_FLIGHT_SYSTEM_KINDS).toEqual([
    "dash",
    "low-profile",
    "missiles",
    "counterflare",
    "gravity-knot",
    "phoenix-squadron",
    "remote-bomb",
    "guardian-wing",
  ]);
  expect(Object.values(JET_FLIGHT_SYSTEM_KEYS)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  expect(Object.values(JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS)).toEqual([3, 2, 5, 10, 30, 60, 4, 8]);

  for (let key = 1; key <= 8; key += 1) {
    expect(jetFlightSystemForKeyboardCode(`Digit${key}`)).toBe(
      jetFlightSystemForKeyboardCode(`Numpad${key}`),
    );
  }

  expect(jetFlightSystemForKeyboardCode("Space")).toBeNull();
  expect(jetFlightSystemForKeyboardCode("ShiftLeft")).toBeNull();
  expect(jetFlightSystemForKeyboardCode("KeyX")).toBeNull();
  expect(jetFlightSystemForKeyboardCode("KeyB")).toBeNull();
});

test("abilities begin locked, unlock ready, activate, and tick without underflow", () => {
  const locked = createLockedJetAbilityStates();
  expect(JET_ABILITY_KINDS.every((kind) => !locked[kind].unlocked)).toBe(true);

  const unlocked = resolveAbilityCrate("counterflare", locked.counterflare, false);
  expect(unlocked.outcome).toBe("unlocked");
  expect(jetAbilityReady(unlocked.state)).toBe(true);

  const active = activateJetAbility("counterflare", unlocked.state);
  expect(active.cooldownSeconds).toBe(10);
  expect(active.activeSeconds).toBe(0.7);
  expect(tickJetAbilityState(active, 20)).toEqual({ unlocked: true, cooldownSeconds: 0, activeSeconds: 0 });
});

test("duplicate ability crates recharge or produce one bounded reserve benefit", () => {
  const cooling = { unlocked: true, cooldownSeconds: 44, activeSeconds: 0 };
  expect(resolveAbilityCrate("phoenix-squadron", cooling, false)).toEqual({
    state: { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
    outcome: "recharged",
    grantShield: false,
    score: 0,
  });

  const active = { unlocked: true, cooldownSeconds: 58, activeSeconds: 3 };
  expect(resolveAbilityCrate("phoenix-squadron", active, false).state).toEqual({
    unlocked: true,
    cooldownSeconds: 3,
    activeSeconds: 3,
  });

  const ready = { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 };
  expect(resolveAbilityCrate("gravity-knot", ready, false).grantShield).toBe(true);
  expect(resolveAbilityCrate("gravity-knot", ready, true).score).toBe(500);
});

test("ability cores use a guaranteed schedule outside the weapon shuffle", () => {
  const offered = { counterflare: false, "gravity-knot": false, "phoenix-squadron": false };
  const base = {
    runSeconds: 0,
    sector: 1,
    lastBossSector: 0,
    bossActive: false,
    bossPending: false,
    availablePickupSlot: true,
    offered,
  };
  expect(nextGuaranteedAbilityCore({ ...base, runSeconds: 11.99 })).toBeNull();
  expect(nextGuaranteedAbilityCore({ ...base, runSeconds: 12 })).toBe("counterflare");
  expect(nextGuaranteedAbilityCore({
    ...base,
    runSeconds: 38,
    offered: { ...offered, counterflare: true },
  })).toBe("gravity-knot");
  expect(nextGuaranteedAbilityCore({
    ...base,
    runSeconds: 60,
    lastBossSector: 5,
    offered: { ...offered, counterflare: true, "gravity-knot": true },
  })).toBe("phoenix-squadron");
  expect(nextGuaranteedAbilityCore({ ...base, runSeconds: 200, bossActive: true })).toBeNull();
});

test("Super Brain spends Counterflare on immediate close pressure", () => {
  const decision = decideSpecialAbilities(tactics({
    nearProjectileCount: 2,
    totalProjectileCount: 4,
    survivalSeconds: 1.2,
  }));
  expect(decision.useCounterflare).toBe(true);
  expect(decision.useGravityKnot).toBe(false);
  expect(decision.usePhoenixSquadron).toBe(false);
  expect(decideSpecialAbilities(tactics({ nearProjectileCount: 1 })).useCounterflare).toBe(false);
});

test("Super Brain uses Gravity Knot for dense danger but avoids redundant stasis", () => {
  const pressure = tactics({
    nearProjectileCount: 0,
    totalProjectileCount: 9,
    gravityTargetCount: 3,
    survivalSeconds: 1.1,
    predictedClearance: 0.4,
  });
  expect(decideSpecialAbilities(pressure).useGravityKnot).toBe(true);
  expect(decideSpecialAbilities({ ...pressure, stasisActive: true, survivalSeconds: 1.1 }).useGravityKnot).toBe(false);
  expect(decideSpecialAbilities({ ...pressure, stasisActive: true, survivalSeconds: 0.5 }).useGravityKnot).toBe(true);
});

test("Super Brain reserves Phoenix for boss spectacle or terminal overload", () => {
  expect(decideSpecialAbilities(tactics({ targetCount: 7 })).usePhoenixSquadron).toBe(false);
  const bossMoment = tactics({
    bossActive: true,
    bossPhase: 2,
    escortCount: 3,
    targetCount: 4,
  });
  expect(decideSpecialAbilities(bossMoment).usePhoenixSquadron).toBe(false);
  expect(decideSpecialAbilities({
    ...bossMoment,
    survivalSeconds: 1.1,
    predictedClearance: 0.4,
  }).usePhoenixSquadron).toBe(true);
  const terminal = tactics({
    terminalProgress: 0.8,
    targetCount: 10,
    totalProjectileCount: 14,
    survivalSeconds: 1,
  });
  expect(decideSpecialAbilities({
    ...terminal,
    abilities: {
      ...terminal.abilities,
      "gravity-knot": { unlocked: true, cooldownSeconds: 8, activeSeconds: 0 },
    },
  }).usePhoenixSquadron).toBe(true);
});

test("Phoenix executes only a damageable low-health boss on a full safe horizon", () => {
  const safeExecution = tactics({
    bossActive: true,
    bossDamageable: true,
    bossHealthRatio: 0.315,
    planningHorizonSeconds: 1.675,
    survivalSeconds: 1.675,
    predictedClearance: 0.62,
  });
  expect(decideSpecialAbilities(safeExecution).usePhoenixSquadron).toBe(true);

  const { bossDamageable, ...withoutDamageability } = safeExecution;
  const { planningHorizonSeconds, ...withoutPlanningHorizon } = safeExecution;
  void bossDamageable;
  void planningHorizonSeconds;

  for (const unsafe of [
    { bossDamageable: false },
    { bossHealthRatio: 0.316 },
    { bossEntering: true },
    { survivalSeconds: 1.674 },
    { predictedClearance: 0.619 },
  ]) {
    expect(decideSpecialAbilities({ ...safeExecution, ...unsafe }).usePhoenixSquadron).toBe(false);
  }
  expect(decideSpecialAbilities(withoutDamageability).usePhoenixSquadron).toBe(false);
  expect(decideSpecialAbilities(withoutPlanningHorizon).usePhoenixSquadron).toBe(false);
});

test("Phoenix accepts only a genuinely dense high-value formation on a safe route", () => {
  const safeFormation = tactics({
    targetCount: 6,
    damageableTargetCount: 6,
    highValueTargetCount: 4,
    planningHorizonSeconds: 1.675,
    survivalSeconds: 1.675,
    predictedClearance: 0.62,
  });
  expect(decideSpecialAbilities(safeFormation).usePhoenixSquadron).toBe(true);

  const { damageableTargetCount, ...withoutDamageableCount } = safeFormation;
  const { highValueTargetCount, ...withoutHighValueCount } = safeFormation;
  void damageableTargetCount;
  void highValueTargetCount;

  for (const insufficient of [
    { damageableTargetCount: 5 },
    { highValueTargetCount: 3 },
    { survivalSeconds: 1.674 },
    { predictedClearance: 0.619 },
  ]) {
    expect(decideSpecialAbilities({ ...safeFormation, ...insufficient }).usePhoenixSquadron).toBe(false);
  }
  expect(decideSpecialAbilities(withoutDamageableCount).usePhoenixSquadron).toBe(false);
  expect(decideSpecialAbilities(withoutHighValueCount).usePhoenixSquadron).toBe(false);
});

test("safe Phoenix offense respects dash burst and automatic one-special ordering", () => {
  const safeExecution = tactics({
    bossActive: true,
    bossDamageable: true,
    bossHealthRatio: 0.3,
    planningHorizonSeconds: 1.675,
    survivalSeconds: 1.675,
    predictedClearance: 2,
  });
  expect(decideSpecialAbilities({
    ...safeExecution,
    dashBurstActive: true,
  }).usePhoenixSquadron).toBe(false);

  const overlapping = decideSpecialAbilities({
    ...safeExecution,
    nearProjectileCount: 2,
  });
  expect(overlapping).toEqual({
    useCounterflare: true,
    useGravityKnot: false,
    usePhoenixSquadron: false,
  });
});

test("manual requests use an unlocked ready system immediately", () => {
  const manual = decideSpecialAbilities(tactics({
    manualCounterflareRequested: true,
    manualGravityKnotRequested: true,
    manualPhoenixSquadronRequested: true,
  }));
  expect(manual).toEqual({
    useCounterflare: true,
    useGravityKnot: true,
    usePhoenixSquadron: true,
  });
});

test("automatic specials spend at most one system per decision", () => {
  const decision = decideSpecialAbilities(tactics({
    nearProjectileCount: 6,
    totalProjectileCount: 16,
    gravityTargetCount: 5,
    targetCount: 10,
    terminalProgress: 0.9,
    survivalSeconds: 0.5,
    predictedClearance: -0.2,
  }));
  expect(decision).toEqual({
    useCounterflare: true,
    useGravityKnot: false,
    usePhoenixSquadron: false,
  });
});

test("the canonical arcade palette contains exactly 15 unique semantic colors", () => {
  expect(ARCADE_PALETTE_ROLES).toHaveLength(15);
  expect(new Set(Object.values(ARCADE_PALETTE)).size).toBe(15);
  expect(ARCADE_PALETTE.counterMint).toBe(0x53f2c3);
  expect(ARCADE_PALETTE.playerMagenta).toBe(0xff2f92);
  expect(ARCADE_PALETTE.playerYellow).toBe(0xffe45c);
});
