import { expect, test } from "bun:test";
import {
  EMERGENCY_ASSIST_HANDOFF_SECONDS,
  EMERGENCY_ASSIST_MAX_SECONDS,
  INITIAL_EMERGENCY_ASSIST_STATE,
  emergencyRescueObservation,
  evaluateEmergencyAssist,
  manualRouteIsSafeForHandoff,
  manualRouteIsSafeForRearm,
  manualRouteNeedsEmergencyAssist,
  rescueRouteIsMeaningfullySafer,
  tickEmergencyAssist,
} from "../src/emergency_assist.ts";
import { createLockedJetAbilityStates } from "../src/abilities.ts";
import {
  decideSuperBrain,
  type BrainObservation,
  type BrainRouteAssessment,
} from "../src/autopilot.ts";

const horizon = 1.5;

function route(
  survivalSeconds: number,
  predictedClearance: number,
): BrainRouteAssessment {
  return {
    survivalSeconds,
    predictedClearance,
    hazardExposure: 0,
    terminalBoundaryClearance: 3,
  };
}

test("safe manual flight never triggers an emergency takeover", () => {
  const safe = route(horizon, 1.2);
  const transition = evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    safe,
    safe,
    horizon,
  );

  expect(manualRouteNeedsEmergencyAssist(safe, horizon)).toBe(false);
  expect(transition.event).toBe("none");
  expect(transition.state.active).toBe(false);
});

test("an open route with infinite clearance remains safe and can rearm", () => {
  const open = route(horizon, Number.POSITIVE_INFINITY);
  const timedOut = {
    active: false,
    armed: false,
    remainingSeconds: 0,
    safeSamples: 0,
  } as const;

  expect(manualRouteNeedsEmergencyAssist(open, horizon)).toBe(false);
  expect(manualRouteIsSafeForHandoff(open, horizon)).toBe(true);
  expect(manualRouteIsSafeForRearm(open, horizon)).toBe(true);
  expect(evaluateEmergencyAssist(timedOut, open, open, horizon)).toMatchObject({
    event: "rearmed",
    state: { active: false, armed: true },
  });
});

test("rescue planning keeps ready skills while removing pickup and manual-request bias", () => {
  const observation: BrainObservation = {
    player: {
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      radius: 0.5,
      maxSpeed: 4,
    },
    bounds: { left: -3, right: 3, bottom: -3, top: 3 },
    threats: [],
    targets: [{
      id: "target",
      kind: "enemy",
      position: { x: 1, y: 1 },
      velocity: { x: 0, y: 0 },
      radius: 0.4,
      priority: 1,
      health: 1,
    }],
    pickups: [{
      id: "crate",
      kind: "pulse",
      position: { x: -1, y: 1 },
      radius: 0.3,
    }],
    manualIntent: { x: 1, y: -1 },
    abilities: {
      dashReady: true,
      lowProfileReady: true,
      lowProfileActive: false,
      missilesReady: true,
      dashRequested: true,
      lowProfileRequested: true,
      missilesRequested: true,
      specials: {
        states: createLockedJetAbilityStates(),
        manualCounterflareRequested: true,
        manualGravityKnotRequested: true,
        manualPhoenixSquadronRequested: true,
        nearProjectileCount: 3,
        nearRocketCount: 1,
        totalProjectileCount: 8,
        gravityTargetCount: 3,
        bossActive: false,
        bossEntering: false,
        bossPhase: 1,
        bossHealthRatio: 1,
        escortCount: 0,
        terminalProgress: 0,
        stasisActive: false,
        dashBurstActive: false,
      },
    },
  };

  const rescue = emergencyRescueObservation(observation);

  expect(rescue.threats).toBe(observation.threats);
  expect(rescue.targets).toBe(observation.targets);
  expect(rescue.pickups).toEqual([]);
  expect(rescue.manualIntent).toEqual({ x: 0, y: 0 });
  expect(rescue.abilities).toMatchObject({
    dashReady: true,
    lowProfileReady: true,
    missilesReady: true,
    dashRequested: false,
    lowProfileRequested: false,
    missilesRequested: false,
    specials: {
      manualCounterflareRequested: false,
      manualGravityKnotRequested: false,
      manualPhoenixSquadronRequested: false,
      nearRocketCount: 1,
    },
  });
});

test("a critical rescue uses mobility, weapons, and a defensive special through real policy", () => {
  const lockedStates = createLockedJetAbilityStates();
  const critical = emergencyRescueObservation({
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
    targets: [{
      id: "hostile",
      kind: "enemy",
      position: { x: 0, y: 3.5 },
      velocity: { x: 0, y: 0 },
      radius: 0.4,
      priority: 3,
      health: 8,
      damageable: true,
    }],
    pickups: [],
    manualIntent: { x: 1, y: 0 },
    abilities: {
      dashReady: true,
      dashSpeedMultiplier: 10,
      dashDurationSeconds: 0.35,
      lowProfileReady: false,
      lowProfileActive: false,
      missilesReady: true,
      specials: {
        states: {
          ...lockedStates,
          counterflare: { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
        },
        nearProjectileCount: 3,
        nearRocketCount: 1,
        totalProjectileCount: 8,
        gravityTargetCount: 1,
        bossActive: false,
        bossEntering: false,
        bossPhase: 1,
        bossHealthRatio: 1,
        escortCount: 0,
        terminalProgress: 0,
        stasisActive: false,
        dashBurstActive: false,
      },
    },
  });

  const decision = decideSuperBrain(critical);

  expect(decision.useDash).toBe(true);
  expect(decision.useMissiles).toBe(true);
  expect(decision.useCounterflare).toBe(true);
});

test("a safe near-pass does not override Manual Flight", () => {
  const safeNearPass = route(horizon, 0.01);

  expect(manualRouteNeedsEmergencyAssist(safeNearPass, horizon)).toBe(false);
  expect(evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    safeNearPass,
    route(horizon, 1),
    horizon,
  ).state.active).toBe(false);
});

test("takeover waits for the last-moment impact window", () => {
  expect(manualRouteNeedsEmergencyAssist(route(0.2, -0.1), horizon)).toBe(false);
  expect(manualRouteNeedsEmergencyAssist(route(0.08, -0.1), horizon)).toBe(true);
});

test("the fixed-tick physical sentinel wakes a safer rescue inside its fast alarm window", () => {
  const earlyPhysicalCollision = route(0.18, -0.1);
  const saferRescue = route(horizon, 0.8);

  expect(manualRouteNeedsEmergencyAssist(earlyPhysicalCollision, horizon)).toBe(false);
  expect(evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    earlyPhysicalCollision,
    saferRescue,
    horizon,
    true,
  )).toMatchObject({
    event: "started",
    state: { active: true, armed: true },
  });
});

test("an imminent collision starts only when the rescue route is safer", () => {
  const danger = route(0.08, -0.2);
  const weakRescue = route(0.1, -0.1);
  const rescue = route(horizon, 0.84);

  expect(rescueRouteIsMeaningfullySafer(danger, weakRescue)).toBe(false);
  expect(evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    danger,
    weakRescue,
    horizon,
  ).state.active).toBe(false);

  const started = evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    danger,
    rescue,
    horizon,
  );
  expect(started.event).toBe("started");
  expect(started.state).toMatchObject({
    active: true,
    armed: true,
    remainingSeconds: EMERGENCY_ASSIST_MAX_SECONDS,
  });
});

test("two safe handoff samples release control before the hard limit", () => {
  const danger = route(0.08, -0.3);
  const rescue = route(horizon, 1);
  const started = evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    danger,
    rescue,
    horizon,
  ).state;
  const firstSafe = evaluateEmergencyAssist(started, rescue, rescue, horizon);
  const released = evaluateEmergencyAssist(firstSafe.state, rescue, rescue, horizon);

  expect(manualRouteIsSafeForHandoff(rescue, horizon)).toBe(true);
  expect(firstSafe.state.active).toBe(true);
  expect(firstSafe.state.safeSamples).toBe(1);
  expect(released.event).toBe("released-safe");
  expect(released.state.active).toBe(false);
  expect(released.state.armed).toBe(true);
});

test("handoff does not wait for a distant fireball in the full planning horizon", () => {
  const danger = route(0.08, -0.3);
  const rescue = route(horizon, 1);
  const laterFireball = route(0.7, -0.4);
  const approachingFireball = route(0.62, -0.4);
  const started = evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    danger,
    rescue,
    horizon,
  ).state;

  expect(laterFireball.survivalSeconds).toBeLessThan(horizon);
  expect(manualRouteIsSafeForHandoff(laterFireball, horizon)).toBe(true);
  expect(manualRouteIsSafeForRearm(laterFireball, horizon)).toBe(false);

  const firstSafe = evaluateEmergencyAssist(started, laterFireball, rescue, horizon);
  const released = evaluateEmergencyAssist(
    firstSafe.state,
    approachingFireball,
    rescue,
    horizon,
  );

  expect(firstSafe.state).toMatchObject({ active: true, safeSamples: 1 });
  expect(released.event).toBe("released-safe");
  expect(released.state.active).toBe(false);

  const retriggered = evaluateEmergencyAssist(released.state, danger, rescue, horizon);
  expect(retriggered.event).toBe("started");
  expect(retriggered.state.active).toBe(true);
});

test("danger inside the handoff window resets the safe-sample streak", () => {
  const danger = route(0.08, -0.3);
  const rescue = route(horizon, 1);
  const started = evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    danger,
    rescue,
    horizon,
  ).state;
  const firstSafe = evaluateEmergencyAssist(
    started,
    route(EMERGENCY_ASSIST_HANDOFF_SECONDS + 0.2, -0.2),
    rescue,
    horizon,
  ).state;
  const dangerReturned = evaluateEmergencyAssist(
    firstSafe,
    route(EMERGENCY_ASSIST_HANDOFF_SECONDS - 0.01, -0.2),
    rescue,
    horizon,
  );

  expect(firstSafe.safeSamples).toBe(1);
  expect(dangerReturned.event).toBe("none");
  expect(dangerReturned.state).toMatchObject({ active: true, safeSamples: 0 });
});

test("the ten-second limit suppresses chained takeovers until a safe route rearms", () => {
  const danger = route(0.08, -0.3);
  const distantDanger = route(0.7, -0.3);
  const rescue = route(horizon, 1);
  const started = evaluateEmergencyAssist(
    INITIAL_EMERGENCY_ASSIST_STATE,
    danger,
    rescue,
    horizon,
  ).state;
  const timedOut = tickEmergencyAssist(started, EMERGENCY_ASSIST_MAX_SECONDS);

  expect(timedOut.event).toBe("released-timeout");
  expect(timedOut.state).toMatchObject({ active: false, armed: false });
  expect(evaluateEmergencyAssist(timedOut.state, danger, rescue, horizon).state.active).toBe(false);
  expect(manualRouteIsSafeForHandoff(distantDanger, horizon)).toBe(true);
  expect(evaluateEmergencyAssist(
    timedOut.state,
    distantDanger,
    rescue,
    horizon,
  )).toMatchObject({ event: "none", state: { active: false, armed: false } });

  const rearmed = evaluateEmergencyAssist(timedOut.state, rescue, rescue, horizon);
  expect(rearmed.event).toBe("rearmed");
  expect(rearmed.state.armed).toBe(true);
});
