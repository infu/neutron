import { expect, test } from "bun:test";
import {
  selectWingmanCountermeasures,
  type CountermeasureWingObservation,
  type HostileProjectileObservation,
  type ProtectedCraftObservation,
  type WingmanCountermeasureObservation,
} from "../src/wingman_countermeasures.ts";

const player: ProtectedCraftObservation = {
  id: 0,
  x: 0,
  y: 0,
  velocityX: 0,
  velocityY: 0,
  radius: 0.8,
};

function wing(overrides: Partial<CountermeasureWingObservation> = {}): CountermeasureWingObservation {
  return { id: 1, x: -2, y: 0, ready: true, ...overrides };
}

function projectile(overrides: Partial<HostileProjectileObservation> = {}): HostileProjectileObservation {
  return {
    id: 10,
    x: 0,
    y: 6,
    velocityX: 0,
    velocityY: -8,
    radius: 0.2,
    rocket: false,
    ...overrides,
  };
}

function observation(
  overrides: Partial<WingmanCountermeasureObservation> = {},
): WingmanCountermeasureObservation {
  return {
    protectedCraft: [player],
    wings: [wing()],
    projectiles: [projectile()],
    responseRadius: 8,
    collisionHorizonSeconds: 1.5,
    ...overrides,
  };
}

test("an earlier craft collision outranks rocket and distance preferences", () => {
  const assignments = selectWingmanCountermeasures(observation({
    projectiles: [
      projectile({ id: 30, x: 0, y: 5, velocityY: -10 }),
      projectile({ id: 2, x: -1.8, y: 5, velocityX: 1.2, velocityY: -3, rocket: true }),
    ],
  }));

  expect(assignments).toHaveLength(1);
  expect(assignments[0]?.projectileId).toBe(30);
  expect(assignments[0]?.collisionSeconds).toBeCloseTo(0.4);
  expect(assignments[0]?.protectedCraftId).toBe(player.id);
});

test("collision prediction protects either companion rather than only the player", () => {
  const rightWingCraft: ProtectedCraftObservation = {
    id: 2,
    x: 2,
    y: 0,
    velocityX: 0,
    velocityY: 0,
    radius: 0.65,
  };
  const assignments = selectWingmanCountermeasures(observation({
    protectedCraft: [player, rightWingCraft],
    projectiles: [projectile({ id: 7, x: 2, y: 4, velocityY: -6 })],
  }));

  expect(assignments[0]).toMatchObject({
    projectileId: 7,
    protectedCraftId: rightWingCraft.id,
  });
  expect(assignments[0]?.collisionSeconds).not.toBeNull();
});

test("rockets outrank bolts, then distance and stable projectile id break ties", () => {
  const closingMiss = (id: number, x: number, rocket: boolean): HostileProjectileObservation => (
    projectile({ id, x, y: 5, velocityX: -x * 0.1, velocityY: -1, rocket })
  );
  const rocketFirst = selectWingmanCountermeasures(observation({
    projectiles: [closingMiss(1, -2.1, false), closingMiss(9, 2.2, true)],
  }));
  const closestFirst = selectWingmanCountermeasures(observation({
    projectiles: [closingMiss(8, 3.5, false), closingMiss(4, -2.1, false)],
  }));
  const lowerIdFirst = selectWingmanCountermeasures(observation({
    projectiles: [closingMiss(8, 0, false), closingMiss(4, 0, false)],
  }));

  expect(rocketFirst[0]?.projectileId).toBe(9);
  expect(closestFirst[0]?.projectileId).toBe(4);
  expect(lowerIdFirst[0]?.projectileId).toBe(4);
  expect(rocketFirst[0]?.collisionSeconds).toBeNull();
});

test("two ready wings receive unique targets independent of input order", () => {
  const wings = [wing({ id: 2, x: 2 }), wing({ id: 1, x: -2 })];
  const projectiles = [
    projectile({ id: 12, x: 2, y: 5 }),
    projectile({ id: 11, x: -2, y: 5 }),
  ];
  const forward = selectWingmanCountermeasures(observation({ wings, projectiles }));
  const reversed = selectWingmanCountermeasures(observation({
    wings: [...wings].reverse(),
    projectiles: [...projectiles].reverse(),
  }));

  expect(forward).toEqual(reversed);
  expect(new Set(forward.map(({ wingId }) => wingId)).size).toBe(2);
  expect(new Set(forward.map(({ projectileId }) => projectileId)).size).toBe(2);
  expect(forward.map(({ projectileId }) => projectileId)).toEqual([11, 12]);
});

test("receding, static, out-of-radius, and malformed threats are rejected", () => {
  const assignments = selectWingmanCountermeasures(observation({
    responseRadius: 6,
    projectiles: [
      projectile({ id: 1, y: 3, velocityY: 4 }),
      projectile({ id: 2, y: 3, velocityY: 0 }),
      projectile({ id: 3, x: 8, y: 8, velocityX: -1, velocityY: -1 }),
      projectile({ id: 4, x: Number.NaN }),
    ],
  }));

  expect(assignments).toEqual([]);
});

test("unready wings never consume a target and the response boundary is inclusive", () => {
  const atBoundary = projectile({ id: 3, x: -2, y: 6 });
  const assignments = selectWingmanCountermeasures(observation({
    wings: [wing({ id: 1, ready: false }), wing({ id: 2, x: 2, ready: true })],
    projectiles: [atBoundary],
    responseRadius: Math.hypot(atBoundary.x - 2, atBoundary.y),
  }));

  expect(assignments).toHaveLength(1);
  expect(assignments[0]?.wingId).toBe(2);
  expect(assignments[0]?.projectileId).toBe(atBoundary.id);
});
