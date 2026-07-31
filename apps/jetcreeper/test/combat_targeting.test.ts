import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  MAX_PLAYER_MISSILES_PER_SALVO,
  PLAYER_AIM_TUNING,
  allocatePlayerMissileTargets,
  ballisticInterceptSeconds,
  playerAimTargetValue,
  scaleObservedTargetVelocity,
  selectPlayerCannonAim,
  type PlayerAimTarget,
} from "../src/combat_targeting.ts";

function target(overrides: Partial<PlayerAimTarget> = {}): PlayerAimTarget {
  return {
    id: 1,
    kind: "enemy",
    position: { x: 0, y: 10 },
    velocity: { x: 0, y: 0 },
    radius: 0.7,
    priority: 3,
    visible: true,
    damageable: true,
    ...overrides,
  };
}

test("player cannon aim tuning is frozen and bounded around forward flight", () => {
  expect(Object.isFrozen(PLAYER_AIM_TUNING)).toBe(true);
  expect(PLAYER_AIM_TUNING.maximumLeadSeconds).toBeGreaterThan(0);
  expect(PLAYER_AIM_TUNING.maximumAimAngleRadians).toBeLessThan(Math.PI / 2);
});

test("ballistic interception leads a lateral target and rejects an out-of-window solution", () => {
  const stationary = ballisticInterceptSeconds(
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 0, y: 0 },
    10,
    2,
  );
  const lateral = ballisticInterceptSeconds(
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 2, y: 0 },
    10,
    2,
  );
  const outsideWindow = ballisticInterceptSeconds(
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 0, y: 0 },
    10,
    1.1,
  );

  expect(stationary).toBeCloseTo(1);
  expect(lateral).toBeCloseTo(Math.sqrt(100 / 96));
  expect(outsideWindow).toBeNull();
});

function segmentDistanceToOrigin(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): number {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const ratio = lengthSquared > 1e-12
    ? Math.max(0, Math.min(1, -(startX * deltaX + startY * deltaY) / lengthSquared))
    : 0;
  return Math.hypot(startX + deltaX * ratio, startY + deltaY * ratio);
}

function integratedAimHits(options: {
  readonly distance: number;
  readonly observedLateralSpeed: number;
  readonly targetTimeScale: number;
}): boolean {
  const targetRadius = 0.7;
  const projectileRadius = 0.16;
  const projectileSpeed = 18;
  const targetVelocity = scaleObservedTargetVelocity(
    { x: options.observedLateralSpeed, y: 0 },
    options.targetTimeScale,
  );
  const decision = selectPlayerCannonAim({
    origin: { x: 0, y: 0 },
    projectileSpeed,
    targetTimeScale: options.targetTimeScale,
    targets: [target({
      position: { x: 0, y: options.distance },
      velocity: { x: options.observedLateralSpeed, y: 0 },
      radius: targetRadius,
    })],
  });

  expect(decision.targetId).toBe(1);
  const projectileVelocity = {
    x: Math.sin(decision.angleRadians) * projectileSpeed,
    y: Math.cos(decision.angleRadians) * projectileSpeed,
  };
  const stepSeconds = 1 / 60;
  let projectile = { x: 0, y: 0 };
  let targetPosition = { x: 0, y: options.distance };

  for (let elapsed = 0; elapsed < 2.25; elapsed += stepSeconds) {
    const nextProjectile = {
      x: projectile.x + projectileVelocity.x * stepSeconds,
      y: projectile.y + projectileVelocity.y * stepSeconds,
    };
    const nextTarget = {
      x: targetPosition.x + targetVelocity.x * stepSeconds,
      y: targetPosition.y + targetVelocity.y * stepSeconds,
    };
    const relativeStartX = projectile.x - targetPosition.x;
    const relativeStartY = projectile.y - targetPosition.y;
    const relativeEndX = nextProjectile.x - nextTarget.x;
    const relativeEndY = nextProjectile.y - nextTarget.y;

    if (segmentDistanceToOrigin(
      relativeStartX,
      relativeStartY,
      relativeEndX,
      relativeEndY,
    ) <= projectileRadius + targetRadius) {
      return true;
    }

    projectile = nextProjectile;
    targetPosition = nextTarget;
  }

  return false;
}

test("selected cannon solutions hit across distance, lateral speed, and hostile time scales", () => {
  for (const distance of [10, 20, 26]) {
    for (const observedLateralSpeed of [2, 3, 5]) {
      for (const targetTimeScale of [1, 0.5, 1 / 3]) {
        expect(integratedAimHits({
          distance,
          observedLateralSpeed,
          targetTimeScale,
        }), `${distance}u, ${observedLateralSpeed}u/s, scale ${targetTimeScale}`).toBe(true);
      }
    }
  }
});

test("hostile time scale is applied once to observed target velocity", () => {
  expect(scaleObservedTargetVelocity({ x: 3, y: -6 }, 1 / 3)).toEqual({ x: 1, y: -2 });

  const warped = selectPlayerCannonAim({
    origin: { x: 0, y: 0 },
    projectileSpeed: 18,
    targetTimeScale: 1 / 3,
    targets: [target({ velocity: { x: 3, y: 0 } })],
  });
  const unwarped = selectPlayerCannonAim({
    origin: { x: 0, y: 0 },
    projectileSpeed: 18,
    targets: [target({ velocity: { x: 3, y: 0 } })],
  });

  expect(warped.angleRadians).toBeGreaterThan(0);
  expect(warped.angleRadians).toBeLessThan(unwarped.angleRadians);
  expect(warped.predictedPosition?.x).toBeCloseTo(10 / Math.sqrt(323));
});

test("ballistic interception rejects invalid speed and a faster escaping target", () => {
  expect(ballisticInterceptSeconds(
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 0, y: 0 },
    0,
  )).toBeNull();
  expect(ballisticInterceptSeconds(
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 0, y: 20 },
    10,
  )).toBeNull();
});

test("selection leads visible motion and clamps the cannon aim cone", () => {
  const moving = selectPlayerCannonAim({
    origin: { x: 0, y: 0 },
    projectileSpeed: 18,
    targets: [target({ velocity: { x: 3, y: 0 } })],
  });
  const edge = selectPlayerCannonAim({
    origin: { x: 0, y: 0 },
    projectileSpeed: 18,
    targets: [target({ position: { x: 3.5, y: 10 }, radius: 0.8 })],
  });

  expect(moving.targetId).toBe(1);
  expect(moving.predictedPosition?.x).toBeGreaterThan(0);
  expect(moving.angleRadians).toBeGreaterThan(0);
  expect(edge.targetId).toBe(1);
  expect(edge.angleRadians).toBeCloseTo(PLAYER_AIM_TUNING.maximumAimAngleRadians);
});

test("selection is deterministic by value then stable id", () => {
  const lowerId = target({ id: 2, position: { x: 1, y: 10 } });
  const higherId = target({ id: 1, position: { x: 1, y: 10 } });
  const decision = selectPlayerCannonAim({
    origin: { x: 0, y: 0 },
    projectileSpeed: 18,
    targets: [lowerId, higherId],
  });

  expect(decision.targetId).toBe(1);
  expect(playerAimTargetValue(
    target({ kind: "boss", priority: 3 }),
    0.5,
    0,
  )).toBeGreaterThan(playerAimTargetValue(target({ priority: 3 }), 0.5, 0));
});

test("a zero-budget boss is ineligible while a damageable escort remains targetable", () => {
  const decision = selectPlayerCannonAim({
    origin: { x: 0, y: 0 },
    projectileSpeed: 18,
    targets: [
      target({ id: "boss", kind: "boss", priority: 10, damageable: false }),
      target({ id: 7, kind: "enemy", priority: 4, position: { x: 0.5, y: 9 } }),
    ],
  });

  expect(decision.targetId).toBe(7);
  expect(decision.targetKind).toBe("enemy");
});

test("missile allocation is deterministic, bounded, and consumes virtual health", () => {
  const assignments = allocatePlayerMissileTargets([
    { id: 2, kind: "enemy", health: 10, damageBudget: 10, priority: 4, damageable: true },
    { id: 1, kind: "enemy", health: 6, damageBudget: 6, priority: 10, damageable: true },
  ], 5, 99);

  expect(assignments).toHaveLength(MAX_PLAYER_MISSILES_PER_SALVO);
  expect(assignments.map((assignment) => assignment.targetId)).toEqual([1, 2, 2, 1]);
  expect(Object.isFrozen(assignments)).toBe(true);
  expect(allocatePlayerMissileTargets([
    { id: 2, kind: "enemy", health: 5, damageBudget: 5, priority: 4, damageable: true },
    { id: 1, kind: "enemy", health: 5, damageBudget: 5, priority: 4, damageable: true },
  ], 5, 2).map((assignment) => assignment.targetId)).toEqual([1, 2]);
});

test("missile allocation avoids gated bosses and known overkill", () => {
  const assignments = allocatePlayerMissileTargets([
    { id: "boss", kind: "boss", health: 780, damageBudget: 0, priority: 10, damageable: false },
    { id: 4, kind: "enemy", health: 1, damageBudget: 1, priority: 5, damageable: true },
  ], 5, 4);

  expect(assignments).toEqual([{ targetId: 4, targetKind: "enemy" }]);
  expect(allocatePlayerMissileTargets([
    { id: "boss", kind: "boss", health: 790, damageBudget: 10, priority: 10, damageable: true },
  ], 5, 4)).toEqual([
    { targetId: "boss", targetKind: "boss" },
    { targetId: "boss", targetKind: "boss" },
  ]);
});

test("missile allocation returns an empty fallback without useful damage", () => {
  const targets = [
    { id: "gated", kind: "boss" as const, health: 780, damageBudget: 0, priority: 10, damageable: false },
  ];

  expect(allocatePlayerMissileTargets(targets, 5, 4)).toEqual([]);
  expect(allocatePlayerMissileTargets(targets, 0, 4)).toEqual([]);
});

test("missile actions launch four rockets by default and eight with Missile Rack", async () => {
  const source = await readFile(new URL("../src/game.ts", import.meta.url), "utf8");

  expect(source).toContain(
    "const salvoCount = rackActive ? MISSILE_RACK_SALVO_COUNT : MAX_PLAYER_MISSILES_PER_SALVO",
  );
  expect(source).toContain("for (let index = 0; index < salvoCount; index += 1)");
  expect(source).toContain("const assignment = assignments[index % assignments.length]");
  expect(source).toContain("projectile.targetBoss = assignment?.targetKind === \"boss\"");
});

test("invisible, behind, unreachable, and far-outside-cone targets keep straight fallback", () => {
  const decisions = [
    target({ visible: false }),
    target({ damageable: false }),
    target({ position: { x: 0, y: -2 } }),
    target({ velocity: { x: 0, y: 30 } }),
    target({ position: { x: 10, y: 2 }, radius: 0.2 }),
  ].map((candidate) => selectPlayerCannonAim({
    origin: { x: 0, y: 0 },
    projectileSpeed: 18,
    targets: [candidate],
  }));

  for (const decision of decisions) {
    expect(decision).toEqual({
      angleRadians: 0,
      targetId: null,
      targetKind: null,
      leadSeconds: 0,
      predictedPosition: null,
      value: 0,
    });
  }
});
