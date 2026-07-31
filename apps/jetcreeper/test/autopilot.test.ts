import { expect, test } from "bun:test";
import {
  DEFAULT_SUPER_BRAIN_CONFIG,
  SuperBrainController,
  assessSuperBrainRoute,
  decideSuperBrain,
  normalizeMovement,
  type BrainObservation,
  type BrainTarget,
  type BrainTerrainObservation,
  type BrainThreat,
} from "../src/autopilot.ts";
import { caveWallClearance, sampleCaveCorridor } from "../src/cave.ts";

test("movement clamping preserves executable partial-speed intent", () => {
  expect(normalizeMovement({ x: 0.6, y: 0 })).toEqual({ x: 0.6, y: 0 });
  expect(normalizeMovement({ x: 3, y: 4 })).toEqual({ x: 0.6, y: 0.8 });
});

function observation(overrides: Partial<BrainObservation> = {}): BrainObservation {
  return {
    player: {
      position: { x: 0, y: -8 },
      velocity: { x: 0, y: 0 },
      radius: 0.78,
      maxSpeed: 11.5,
    },
    bounds: { left: -10, right: 10, bottom: -16, top: 16 },
    threats: [],
    targets: [],
    manualIntent: { x: 0, y: 0 },
    abilities: {
      dashReady: false,
      lowProfileReady: false,
      lowProfileActive: false,
      missilesReady: false,
    },
    ...overrides,
  };
}

const TERMINAL_CAVE: BrainTerrainObservation = Object.freeze({
  travelDistance: 1525,
  scrollSpeed: 21.5,
  sector: 200,
});

function offensiveTarget(overrides: Partial<BrainTarget> = {}): BrainTarget {
  return {
    id: "offensive-target",
    kind: "enemy",
    position: { x: 0, y: 8 },
    velocity: { x: 0, y: 0 },
    radius: 1,
    priority: 2,
    health: 10,
    damageable: true,
    ...overrides,
  };
}

function offensiveTargetWithoutDamageability(): BrainTarget {
  const { damageable, ...target } = offensiveTarget();
  void damageable;
  return target;
}

test("runtime defaults exactly promote the bounded-search winner", () => {
  expect(DEFAULT_SUPER_BRAIN_CONFIG).toMatchObject({
    planningHorizonSeconds: 1.5,
    simulationStepSeconds: 0.12,
    candidateHeadingCount: 40,
    lookaheadBeamWidth: 3,
    lookaheadTurnRadians: 0.196,
    densePressurePartialSpeedScale: 0.65,
    densePressureHazardTolerance: 0,
    densePressureBoundaryReserve: 0,
    densePressureLowProfileExposureRatio: 0.72,
    safeClearanceRatio: 0.98,
    defaultDashDurationSeconds: 0.12,
    neutralY: -10.29,
    targetLeadSeconds: 0.5206,
    targetLaneWeight: 0.0703,
    missileMinimumTargets: 1,
    missilePriorityThreshold: 1.203,
    offensiveLaneAlignmentThreshold: 0.564,
    offensiveDashMinimumTargetHealth: 7.54,
    offensiveLowProfileMinimumAlignedTargets: 1,
    offensiveLowProfileMinimumAlignedHealth: 6.08,
  });
});

test("Super Brain deterministically avoids a predicted linear interception", () => {
  const incoming: BrainThreat = {
    id: "cannon-1",
    kind: "projectile",
    position: { x: 0, y: 2 },
    velocity: { x: 0, y: -8 },
    radius: 0.2,
  };
  const state = observation({ threats: [incoming] });
  const first = decideSuperBrain(state);
  const second = decideSuperBrain(state);

  expect(first).toEqual(second);
  expect(first.survivalSeconds).toBeCloseTo(DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds);
  expect(Math.abs(first.movement.x)).toBeGreaterThan(0.2);
  expect(first.predictedClearance).toBeGreaterThan(0);
});

test("three-ply lookahead escapes a constant-heading crossfire trap", () => {
  const threatData = [
    [-0.678, 2.822, 3.054, -2.14],
    [0.918, -3.13, -0.983, 4.245],
    [0.537, -1.208, 1.137, 3.881],
    [-0.933, -1.706, 0.931, 2.479],
    [3.204, 1.131, -0.916, 0.422],
    [-0.613, 1.083, 2.821, -1.583],
    [-1.913, -1.295, 0.55, 1.882],
    [0.452, 1.193, -2.969, -3.113],
    [-0.502, -1.367, -1.071, 4.229],
    [-2.322, 0.329, 2.716, 0.49],
  ] as const;
  const state = observation({
    player: {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      radius: 0.35,
      maxSpeed: 4,
    },
    bounds: { left: -3, right: 3, bottom: -3, top: 3 },
    threats: threatData.map(([x, y, velocityX, velocityY], index) => ({
      id: `beam-${index}`,
      kind: "projectile" as const,
      position: { x, y },
      velocity: { x: velocityX, y: velocityY },
      radius: 0.2,
    })),
  });
  const config = {
    planningHorizonSeconds: 1.2,
    simulationStepSeconds: 0.06,
    safetyMargin: 0,
    candidateHeadingCount: 40,
    lookaheadBeamWidth: 3,
    lookaheadTurnRadians: 0.196,
  };
  const constant = decideSuperBrain(state, { x: 0, y: 0 }, {
    ...config,
    lookaheadBeamWidth: 0,
  });
  const lookahead = decideSuperBrain(state, { x: 0, y: 0 }, config);

  expect(constant.survivalSeconds).toBeLessThan(0.7);
  expect(constant.predictedClearance).toBeLessThan(0);
  expect(lookahead.survivalSeconds).toBeCloseTo(1.2);
  expect(lookahead.predictedClearance).toBeGreaterThan(0);
  expect(lookahead.plannedMoves).toHaveLength(3);
  expect(lookahead.plannedMoves[1]).not.toEqual(lookahead.plannedMoves[0]);
});

test("exact arbitrary-route assessment shares swept projectile physics", () => {
  const state = observation({
    threats: [{
      id: "manual-lane",
      kind: "projectile",
      position: { x: 4, y: -8 },
      velocity: { x: 0, y: 0 },
      radius: 0.3,
    }],
  });
  const intoDanger = assessSuperBrainRoute(state, { x: 1, y: 0 });
  const away = assessSuperBrainRoute(state, { x: -1, y: 0 });

  expect(intoDanger.survivalSeconds).toBeLessThan(away.survivalSeconds);
  expect(intoDanger.predictedClearance).toBeLessThan(away.predictedClearance);
});

test("controller holds a stabilize regime after an emergency before resuming recovery", () => {
  const controller = new SuperBrainController({ lookaheadBeamWidth: 0 });
  const danger = observation({
    player: { ...observation().player, maxSpeed: 0 },
    threats: [{
      id: "regime-hit",
      kind: "projectile",
      position: { x: 0, y: -6.5 },
      velocity: { x: 0, y: -8 },
      radius: 0.3,
    }],
  });

  expect(controller.decide(danger).regime).toBe("evade");
  expect(controller.decide(observation()).regime).toBe("stabilize");
  expect(controller.decide(observation()).regime).toBe("stabilize");
  expect(controller.decide(observation()).regime).toBe("stabilize");
  expect(controller.decide(observation()).regime).toBe("stabilize");
  expect(controller.decide(observation()).regime).toBe("recover");
});

test("manual intent nudges safe flight but cannot select an unsafe route", () => {
  const neutralDecision = decideSuperBrain(observation());
  const clearDecision = decideSuperBrain(observation({
    manualIntent: { x: 1, y: 0 },
  }));
  const blockedDecision = decideSuperBrain(observation({
    manualIntent: { x: 1, y: 0 },
    threats: [{
      id: "right-lane",
      kind: "projectile",
      position: { x: 2.2, y: -8 },
      velocity: { x: -7, y: 0 },
      radius: 0.3,
    }],
  }));

  expect(neutralDecision.movement.x).toBeCloseTo(0);
  expect(clearDecision.movement.x).toBeGreaterThan(0.8);
  expect(clearDecision.movement.x - neutralDecision.movement.x).toBeGreaterThan(0.8);
  expect(blockedDecision.survivalSeconds).toBeCloseTo(DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds);
  expect(blockedDecision.predictedClearance).toBeGreaterThan(0);
  expect(blockedDecision.movement.x).toBeLessThan(0.8);
});

test("calm flight returns to the lower-middle home position", () => {
  const decision = decideSuperBrain(observation({
    player: {
      position: { x: 7, y: 6 },
      velocity: { x: 0, y: 0 },
      radius: 0.78,
      maxSpeed: 11.5,
    },
  }));

  expect(decision.pickupTargetId).toBeNull();
  expect(decision.movement.x).toBeLessThan(-0.2);
  expect(decision.movement.y).toBeLessThan(-0.5);
});

test("cannon-lane movement leads a fast crossing target instead of chasing its old position", () => {
  const state = observation({
    bounds: { left: -30, right: 30, bottom: -30, top: 30 },
    targets: [offensiveTarget({
      position: { x: -8, y: 8 },
      velocity: { x: 30, y: 0 },
    })],
  });
  const led = decideSuperBrain(state);
  const unled = decideSuperBrain(state, { x: 0, y: 0 }, { targetLeadSeconds: 0 });

  expect(led.movement.x).toBeGreaterThan(0.2);
  expect(unled.movement.x).toBeLessThan(-0.2);
});

test("lane positioning ignores invisible, unreachable, and fully committed targets", () => {
  const bounds = { left: -30, right: 30, bottom: -30, top: 30 };
  const crossingTarget = {
    position: { x: -8, y: 8 },
    velocity: { x: 30, y: 0 },
  } as const;
  const baseline = decideSuperBrain(observation({ bounds }));
  const actionable = decideSuperBrain(observation({
    bounds,
    targets: [offensiveTarget(crossingTarget)],
  }));

  expect(actionable.movement.x).toBeGreaterThan(0.2);
  expect(actionable.regime).toBe("engage");

  for (const ignored of [
    offensiveTarget({ ...crossingTarget, visible: false }),
    offensiveTarget({ ...crossingTarget, weaponReachable: false }),
    offensiveTarget({ ...crossingTarget, committedDamage: 10 }),
  ]) {
    const decision = decideSuperBrain(observation({ bounds, targets: [ignored] }));
    expect(decision.movement.x).toBeCloseTo(baseline.movement.x);
    expect(decision.movement.y).toBeCloseTo(baseline.movement.y);
    expect(decision.regime).toBe("recover");
  }
});

test("an invulnerable boss remains a collision threat without biasing the offensive lane", () => {
  const bossThreat: BrainThreat = {
    id: "gated-boss",
    kind: "boss",
    position: { x: 8, y: 8 },
    velocity: { x: 0, y: 0 },
    radius: 2.6,
  };
  const threatOnly = decideSuperBrain(observation({ threats: [bossThreat] }));
  const gatedBoss = decideSuperBrain(observation({
    threats: [bossThreat],
    targets: [offensiveTarget({
      id: "gated-boss",
      kind: "boss",
      position: { x: 8, y: 8 },
      radius: 2.6,
      priority: 10,
      health: 100,
      damageable: false,
    })],
  }));

  expect(gatedBoss.movement.x).toBeCloseTo(threatOnly.movement.x);
  expect(gatedBoss.movement.y).toBeCloseTo(threatOnly.movement.y);
  expect(gatedBoss.predictedClearance).toBe(threatOnly.predictedClearance);
});

test("Super Brain seeks a valuable repair crate over a less useful weapon", () => {
  const decision = decideSuperBrain(observation({
    pickups: [{
      id: "spread-crate",
      kind: "spread",
      position: { x: -5, y: -2 },
      velocity: { x: 0, y: -1.2 },
      radius: 0.72,
      value: 3,
      safety: 1,
    }, {
      id: "repair-crate",
      kind: "pulse",
      position: { x: 5, y: -2 },
      velocity: { x: 0, y: -1.2 },
      radius: 0.72,
      value: 1,
      healthValue: 4,
      safety: 1,
    }],
  }));

  expect(decision.pickupTargetId).toBe("repair-crate");
  expect(decision.movement.x).toBeGreaterThan(0.2);
  expect(decision.movement.y).toBeGreaterThan(0.2);
});

test("pickup safety outweighs raw crate value", () => {
  const decision = decideSuperBrain(observation({
    pickups: [{
      id: "unsafe-overdrive",
      kind: "overdrive",
      position: { x: 5, y: -5 },
      radius: 0.72,
      value: 12,
      safety: 0.04,
    }, {
      id: "safe-rapid",
      kind: "rapid",
      position: { x: -4, y: -5 },
      radius: 0.72,
      value: 2,
      safety: 1,
    }],
  }));

  expect(decision.pickupTargetId).toBe("safe-rapid");
  expect(decision.movement.x).toBeLessThan(-0.2);
});

test("a valuable crate cannot lure Super Brain through a live projectile lane", () => {
  const decision = decideSuperBrain(observation({
    threats: [{
      id: "crate-lane-shot",
      kind: "projectile",
      position: { x: 2.1, y: -8 },
      velocity: { x: -8, y: 0 },
      radius: 0.3,
    }],
    pickups: [{
      id: "plasma-bait",
      kind: "plasma",
      position: { x: 6, y: -8 },
      radius: 0.72,
      value: 12,
      safety: 1,
    }],
    manualIntent: { x: 1, y: 0 },
  }));

  expect(decision.pickupTargetId).toBe("plasma-bait");
  expect(decision.survivalSeconds).toBeCloseTo(DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds);
  expect(decision.predictedClearance).toBeGreaterThan(0);
  expect(decision.movement.x).toBeLessThan(0);
  expect(Math.abs(decision.movement.y)).toBeGreaterThan(0.5);
});

test("Super Brain approximates a rocket steering toward each candidate route", () => {
  const rocket: BrainThreat = {
    id: "rocket-1",
    kind: "rocket",
    motion: "homing",
    position: { x: -5, y: -2 },
    velocity: { x: 2, y: -5 },
    radius: 0.3,
    homingSecondsRemaining: 2.2,
    homingStrength: 0.82,
  };
  const decision = decideSuperBrain(observation({
    threats: [rocket],
    manualIntent: { x: -1, y: 0 },
  }));

  expect(decision.survivalSeconds).toBeCloseTo(DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds);
  expect(decision.predictedClearance).toBeGreaterThan(0);
  expect(decision.movement.x).toBeGreaterThan(-0.9);
});

test("prediction catches fast threats crossing between planning samples", () => {
  const decision = decideSuperBrain(observation({
    player: {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      radius: 0.5,
      maxSpeed: 0,
    },
    threats: [{
      id: "tunnelling-shot",
      kind: "projectile",
      position: { x: -1.5, y: 0 },
      velocity: { x: 25, y: 0 },
      radius: 0.1,
    }],
  }));

  expect(decision.survivalSeconds).toBeLessThan(0.12);
  expect(decision.predictedClearance).toBeLessThan(0);
});

test("low profile is selected when its smaller radius creates the safe route", () => {
  const decision = decideSuperBrain(observation({
    player: {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      radius: 0.78,
      maxSpeed: 0,
    },
    bounds: { left: -1, right: 1, bottom: -1, top: 1 },
    threats: [{
      id: "near-miss",
      kind: "projectile",
      position: { x: 0.72, y: 0.9 },
      velocity: { x: 0, y: -1 },
      radius: 0.12,
    }],
    abilities: {
      dashReady: false,
      lowProfileReady: true,
      lowProfileActive: false,
      lowProfileRadius: 0.3,
      missilesReady: false,
    },
  }));

  expect(decision.useLowProfile).toBe(true);
  expect(decision.mode).toBe("low-profile");
  expect(decision.survivalSeconds).toBeCloseTo(DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds);
});

test("dash is reserved for a materially safer emergency trajectory", () => {
  const decision = decideSuperBrain(observation({
    player: {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      radius: 0.5,
      maxSpeed: 1,
    },
    bounds: { left: -5, right: 5, bottom: -5, top: 5 },
    threats: [{
      id: "fast-shot",
      kind: "projectile",
      position: { x: 0, y: 1.8 },
      velocity: { x: 0, y: -7 },
      radius: 0.22,
    }],
    abilities: {
      dashReady: true,
      dashSpeedMultiplier: 10,
      dashDurationSeconds: 0.35,
      lowProfileReady: false,
      lowProfileActive: false,
      missilesReady: false,
    },
  }));

  expect(decision.useDash).toBe(true);
  expect(decision.mode).toBe("dash");
  expect(decision.survivalSeconds).toBeCloseTo(DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds);
});

test("offensive low profile requires a full safe horizon and an aligned damageable target", () => {
  const abilities = {
    dashReady: false,
    lowProfileReady: true,
    lowProfileActive: false,
    missilesReady: false,
  };
  const safe = decideSuperBrain(observation({
    targets: [offensiveTarget()],
    abilities,
  }));

  expect(safe.useLowProfile).toBe(true);
  expect(safe.survivalSeconds).toBe(DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds);

  for (const target of [
    offensiveTarget({ damageable: false }),
    offensiveTargetWithoutDamageability(),
    offensiveTarget({ health: 6.079 }),
    offensiveTarget({ visible: false }),
    offensiveTarget({ weaponReachable: false }),
    offensiveTarget({ committedDamage: 10 }),
    offensiveTarget({ committedDamage: 4 }),
  ]) {
    expect(decideSuperBrain(observation({ targets: [target], abilities })).useLowProfile).toBe(false);
  }

  const belowClearanceFloor = decideSuperBrain(observation({
    threats: [{
      id: "clearance-floor",
      kind: "projectile",
      position: { x: 1.66, y: -8 },
      velocity: { x: 0, y: 0 },
      radius: 0.2,
    }],
    targets: [offensiveTarget()],
    abilities: { ...abilities, lowProfileRadius: 0.78 },
  }));
  expect(belowClearanceFloor.survivalSeconds).toBe(DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds);
  expect(belowClearanceFloor.predictedClearance).toBeLessThan(DEFAULT_SUPER_BRAIN_CONFIG.emergencyClearance);
  expect(belowClearanceFloor.useLowProfile).toBe(false);
});

test("a safe aligned healthy target alone never spends the survival dash", () => {
  const abilities = {
    dashReady: true,
    lowProfileReady: false,
    lowProfileActive: false,
    missilesReady: false,
  };
  const wideObservation = {
    bounds: { left: -30, right: 30, bottom: -30, top: 30 },
    targets: [offensiveTarget({ position: { x: 23, y: 8 }, radius: 3 })],
    abilities,
  };

  expect(decideSuperBrain(observation(wideObservation)).useDash).toBe(false);
  expect(decideSuperBrain(observation({
    ...wideObservation,
    targets: [offensiveTarget({ position: { x: 23, y: 8 }, radius: 3, health: 100 })],
  })).useDash).toBe(false);

  const pressuredButNotImproved = decideSuperBrain(observation({
    ...wideObservation,
    threats: [{
      id: "unsafe-offense",
      kind: "projectile",
      position: { x: 1.66, y: -8 },
      velocity: { x: 0, y: 0 },
      radius: 0.2,
    }],
    abilities: { ...abilities, dashSpeedMultiplier: 1 },
  }));
  expect(pressuredButNotImproved.predictedClearance).toBeLessThan(
    DEFAULT_SUPER_BRAIN_CONFIG.emergencyClearance,
  );
  expect(pressuredButNotImproved.useDash).toBe(false);
});

test("missiles fire for a request or high-value target, never without a target", () => {
  const controller = new SuperBrainController();
  const bossTarget = {
    id: "ravager",
    kind: "boss" as const,
    position: { x: 0, y: 10 },
    velocity: { x: 0, y: 0 },
    radius: 2.7,
    priority: 4,
    health: 100,
    damageable: true,
  };
  const bossDecision = controller.decide(observation({
    targets: [bossTarget],
    abilities: {
      dashReady: false,
      lowProfileReady: false,
      lowProfileActive: false,
      missilesReady: true,
    },
  }));
  const emptyDecision = decideSuperBrain(observation({
    abilities: {
      dashReady: false,
      lowProfileReady: false,
      lowProfileActive: false,
      missilesReady: true,
      missilesRequested: true,
    },
  }));

  expect(bossDecision.useMissiles).toBe(true);
  expect(emptyDecision.useMissiles).toBe(false);
});

test("automatic missiles require explicit damageability and tuned priority, while manual requests remain", () => {
  const abilities = {
    dashReady: false,
    lowProfileReady: false,
    lowProfileActive: false,
    missilesReady: true,
  };

  expect(decideSuperBrain(observation({
    targets: [offensiveTarget({ priority: 1.202 })],
    abilities,
  })).useMissiles).toBe(false);
  expect(decideSuperBrain(observation({
    targets: [offensiveTarget({ priority: 1.203 })],
    abilities,
  })).useMissiles).toBe(true);
  expect(decideSuperBrain(observation({
    targets: [offensiveTarget({ priority: 9, damageable: false })],
    abilities,
  })).useMissiles).toBe(false);
  expect(decideSuperBrain(observation({
    targets: [offensiveTarget({ damageable: false })],
    abilities: { ...abilities, missilesRequested: true },
  })).useMissiles).toBe(true);
  expect(decideSuperBrain(observation({
    threats: [{
      id: "urgent-missile-pressure",
      kind: "projectile",
      position: { x: 1.66, y: -8 },
      velocity: { x: 0, y: 0 },
      radius: 0.2,
    }],
    targets: [offensiveTarget({ damageable: false })],
    abilities,
  })).useMissiles).toBe(false);
});

test("automatic missiles count only health not already covered by committed damage", () => {
  const abilities = {
    dashReady: false,
    lowProfileReady: false,
    lowProfileActive: false,
    missilesReady: true,
  };
  const useful = offensiveTarget({ priority: 5, health: 10, committedDamage: 9.5 });
  const fullyCommitted = offensiveTarget({ priority: 9, health: 10, committedDamage: 10 });

  expect(decideSuperBrain(observation({
    targets: [useful],
    abilities,
  })).useMissiles).toBe(true);
  expect(decideSuperBrain(observation({
    targets: [fullyCommitted],
    abilities,
  })).useMissiles).toBe(false);
  expect(decideSuperBrain(observation({
    targets: [useful, fullyCommitted],
    abilities,
  }), { x: 0, y: 0 }, {
    missileMinimumTargets: 2,
  }).useMissiles).toBe(false);

  // Omitting all new metadata preserves the original automatic decision.
  expect(decideSuperBrain(observation({
    targets: [offensiveTarget({ priority: 5 })],
    abilities,
  })).useMissiles).toBe(true);
});

test("manual flight-system requests retain their ready-and-safe behavior", () => {
  const baseAbilities = observation().abilities;
  expect(decideSuperBrain(observation({
    abilities: { ...baseAbilities, lowProfileReady: true, lowProfileRequested: true },
  })).useLowProfile).toBe(true);
  expect(decideSuperBrain(observation({
    abilities: { ...baseAbilities, dashReady: true, dashRequested: true },
  })).useDash).toBe(true);
});

test("controller reset makes stateful smoothing reproducible", () => {
  const controller = new SuperBrainController();
  const state = observation({ manualIntent: { x: 1, y: 0 } });
  const first = controller.decide(state);
  controller.decide(observation({ manualIntent: { x: 0, y: 1 } }));
  controller.reset();

  expect(controller.decide(state)).toEqual(first);
});

test("calm terrain-aware flight follows the future cave center", () => {
  const player = {
    ...observation().player,
    position: { x: 0, y: DEFAULT_SUPER_BRAIN_CONFIG.neutralY },
  };
  const futureCorridor = sampleCaveCorridor(
    TERMINAL_CAVE.travelDistance
      + TERMINAL_CAVE.scrollSpeed * DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
    DEFAULT_SUPER_BRAIN_CONFIG.neutralY,
    TERMINAL_CAVE.sector,
  );
  const terrainDecision = decideSuperBrain(observation({ player, terrain: TERMINAL_CAVE }));
  const rectangularDecision = decideSuperBrain(observation({ player }));

  expect(futureCorridor.center).toBeGreaterThan(1);
  expect(terrainDecision.movement.x).toBeGreaterThan(0.1);
  expect(terrainDecision.survivalSeconds).toBeCloseTo(
    DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
  );
  expect(rectangularDecision.movement.x).toBeCloseTo(0);
  expect(rectangularDecision.movement.y).toBeCloseTo(0);
});

test("terrain safety overrides manual intent aimed through a cave wall", () => {
  const corridor = sampleCaveCorridor(
    TERMINAL_CAVE.travelDistance,
    -8,
    TERMINAL_CAVE.sector,
  );
  const player = {
    ...observation().player,
    position: {
      x: corridor.wallLeft
        + observation().player.radius
        + DEFAULT_SUPER_BRAIN_CONFIG.safetyMargin
        + 0.54,
      y: -8,
    },
  };
  const directLeftClearance = caveWallClearance(
    sampleCaveCorridor(
      TERMINAL_CAVE.travelDistance + TERMINAL_CAVE.scrollSpeed * 0.1,
      player.position.y,
      TERMINAL_CAVE.sector,
    ),
    player.position.x - player.maxSpeed * 0.1,
    player.radius,
    DEFAULT_SUPER_BRAIN_CONFIG.safetyMargin,
  );
  const terrainDecision = decideSuperBrain(observation({
    player,
    terrain: TERMINAL_CAVE,
    manualIntent: { x: -1, y: 0 },
  }));
  const rectangularDecision = decideSuperBrain(observation({
    player,
    manualIntent: { x: -1, y: 0 },
  }));

  expect(directLeftClearance).toBeLessThan(0);
  expect(terrainDecision.movement.x).toBeGreaterThan(-0.1);
  expect(terrainDecision.survivalSeconds).toBeCloseTo(
    DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
  );
  expect(terrainDecision.predictedClearance).toBeGreaterThan(0);
  expect(rectangularDecision.movement.x).toBeLessThan(-0.8);
});

test("planning predicts a cave wall moving into a stationary jet", () => {
  const corridor = sampleCaveCorridor(0, -8, TERMINAL_CAVE.sector);
  const player = {
    ...observation().player,
    position: {
      x: corridor.wallLeft
        + observation().player.radius
        + DEFAULT_SUPER_BRAIN_CONFIG.safetyMargin
        + 0.12,
      y: -8,
    },
    maxSpeed: 0,
  };
  const movingDecision = decideSuperBrain(observation({
    player,
    terrain: { travelDistance: 0, scrollSpeed: 21.5, sector: TERMINAL_CAVE.sector },
  }));
  const frozenDecision = decideSuperBrain(observation({
    player,
    terrain: { travelDistance: 0, scrollSpeed: 0, sector: TERMINAL_CAVE.sector },
  }));

  expect(movingDecision.survivalSeconds).toBeLessThan(
    DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
  );
  expect(movingDecision.predictedClearance).toBeLessThan(0);
  expect(frozenDecision.survivalSeconds).toBeCloseTo(
    DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
  );
  expect(frozenDecision.predictedClearance).toBeGreaterThan(0);
});

test("a requested dash is rerouted when its midpoint crosses rock", () => {
  const terrain: BrainTerrainObservation = {
    travelDistance: 9.5,
    scrollSpeed: 21.5,
    sector: TERMINAL_CAVE.sector,
  };
  const player = {
    ...observation().player,
    position: { x: 7.434, y: -8 },
  };
  const dashSpeed = player.maxSpeed * 4;
  const directClearanceAt = (elapsedSeconds: number): number => caveWallClearance(
    sampleCaveCorridor(
      terrain.travelDistance + terrain.scrollSpeed * elapsedSeconds,
      player.position.y + dashSpeed * elapsedSeconds,
      terrain.sector,
    ),
    player.position.x,
    player.radius,
    DEFAULT_SUPER_BRAIN_CONFIG.safetyMargin,
  );
  const decision = decideSuperBrain(observation({
    player,
    terrain,
    manualIntent: { x: 0, y: 1 },
    abilities: {
      dashReady: true,
      dashSpeedMultiplier: 4,
      dashDurationSeconds: 0.12,
      dashRequested: true,
      lowProfileReady: false,
      lowProfileActive: false,
      missilesReady: false,
    },
  }));

  expect(directClearanceAt(0)).toBeGreaterThan(0);
  expect(directClearanceAt(0.05)).toBeLessThan(0);
  expect(directClearanceAt(0.1)).toBeGreaterThan(0);
  expect(decision.useDash).toBe(true);
  expect(decision.movement.x).toBeLessThan(-0.1);
  expect(decision.survivalSeconds).toBeCloseTo(
    DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
  );
  expect(decision.predictedClearance).toBeGreaterThan(0);
});

test("a requested dash stays direct when the complete cave route is safe", () => {
  const decision = decideSuperBrain(observation({
    terrain: { travelDistance: 0, scrollSpeed: 3.5, sector: 1 },
    manualIntent: { x: 0, y: 1 },
    abilities: {
      dashReady: true,
      dashSpeedMultiplier: 4,
      dashDurationSeconds: 0.12,
      dashRequested: true,
      lowProfileReady: false,
      lowProfileActive: false,
      missilesReady: false,
    },
  }));

  expect(decision.useDash).toBe(true);
  expect(decision.movement.x).toBeCloseTo(0);
  expect(decision.movement.y).toBeGreaterThan(0.9);
  expect(decision.survivalSeconds).toBeCloseTo(
    DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
  );
  expect(decision.predictedClearance).toBeGreaterThan(0);
});

test("short dash prediction integrates the partial final planning step exactly", () => {
  const decision = decideSuperBrain(observation({
    player: {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      radius: 0.2,
      maxSpeed: 10,
    },
    bounds: { left: -20, right: 20, bottom: -20, top: 20 },
    threats: [{
      id: "beyond-exact-dash",
      kind: "projectile",
      position: { x: 7, y: 0 },
      velocity: { x: 0, y: 0 },
      radius: 0.1,
    }],
    manualIntent: { x: 1, y: 0 },
    abilities: {
      dashReady: true,
      dashRequested: true,
      dashSpeedMultiplier: 4,
      dashDurationSeconds: 0.12,
      lowProfileReady: false,
      lowProfileActive: false,
      missilesReady: false,
    },
  }), { x: 0, y: 0 }, {
    planningHorizonSeconds: 0.2,
    simulationStepSeconds: 0.1,
    safetyMargin: 0,
    safeClearanceRatio: 0,
    manualIntentAuthority: 1,
    emergencyClearance: 0,
  });

  // Exact movement is 4.0 units in step one, then 0.8 at dash speed plus
  // 0.8 at cruise speed in step two: 5.6 total. The former whole-step model
  // predicted 8.0 and falsely rerouted around this projectile at x=7.
  expect(decision.useDash).toBe(true);
  expect(decision.movement.x).toBeCloseTo(1);
  expect(decision.movement.y).toBeCloseTo(0);
  expect(decision.survivalSeconds).toBeCloseTo(0.2);
  expect(decision.predictedClearance).toBeCloseTo(1.1);
});

test("low profile is selected when its smaller radius clears cave rock", () => {
  const terrain: BrainTerrainObservation = {
    travelDistance: TERMINAL_CAVE.travelDistance,
    scrollSpeed: 0,
    sector: TERMINAL_CAVE.sector,
  };
  const corridor = sampleCaveCorridor(terrain.travelDistance, -8, terrain.sector);
  const player = {
    ...observation().player,
    position: {
      x: corridor.wallLeft + DEFAULT_SUPER_BRAIN_CONFIG.safetyMargin + 0.6,
      y: -8,
    },
    maxSpeed: 0,
  };
  const normalDecision = decideSuperBrain(observation({ player, terrain }));
  const lowProfileDecision = decideSuperBrain(observation({
    player,
    terrain,
    abilities: {
      ...observation().abilities,
      lowProfileReady: true,
      lowProfileRadius: 0.42,
    },
  }));

  expect(normalDecision.survivalSeconds).toBe(0);
  expect(normalDecision.predictedClearance).toBeLessThan(0);
  expect(lowProfileDecision.useLowProfile).toBe(true);
  expect(lowProfileDecision.mode).toBe("low-profile");
  expect(lowProfileDecision.survivalSeconds).toBeCloseTo(
    DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
  );
  expect(lowProfileDecision.predictedClearance).toBeGreaterThan(0);
});

test("omitting terrain preserves legacy rectangular-world decisions", () => {
  const state = observation({ manualIntent: { x: 1, y: 0 } });
  const decision = decideSuperBrain(state);

  expect("terrain" in state).toBe(false);
  expect(decision.movement.x).toBeGreaterThan(0.8);
  expect(decision.survivalSeconds).toBeCloseTo(
    DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
  );
  expect(decision.predictedClearance).toBe(Number.POSITIVE_INFINITY);
});
