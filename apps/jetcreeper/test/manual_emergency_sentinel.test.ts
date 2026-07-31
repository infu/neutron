import { expect, test } from "bun:test";
import {
  MANUAL_EMERGENCY_SENTINEL_HORIZON_SECONDS,
  evaluateManualEmergencySentinel,
  manualEmergencySentinelNeedsAssist,
  type ManualEmergencyBody,
  type ManualEmergencyThreat,
  type ManualEmergencyThreatKind,
} from "../src/manual_emergency_sentinel.ts";

const PLAYER: ManualEmergencyBody = Object.freeze({
  position: { x: 0, y: 0 },
  velocity: { x: 2, y: 0 },
  radius: 0.78,
});

function threat(overrides: Partial<ManualEmergencyThreat> = {}): ManualEmergencyThreat {
  return {
    id: "threat",
    kind: "projectile",
    position: { x: 2.5, y: 0 },
    velocity: { x: -10, y: 0 },
    radius: 0.2,
    ...overrides,
  };
}

test("sentinel reports the deterministic earliest swept collision", () => {
  const later = threat({
    id: "later",
    kind: "enemy",
    position: { x: 3.02, y: 0 },
  });
  const earlier = threat({ id: "earlier", kind: "rocket" });
  const first = evaluateManualEmergencySentinel({ player: PLAYER, threats: [later, earlier] });
  const replay = evaluateManualEmergencySentinel({ player: PLAYER, threats: [earlier, later] });

  expect(first).toEqual(replay);
  expect(first).toEqual({
    needsAssist: true,
    earliestCollisionSeconds: (2.5 - PLAYER.radius - earlier.radius) / 12,
    threatId: "earlier",
    threatKind: "rocket",
  });
  expect(manualEmergencySentinelNeedsAssist({ player: PLAYER, threats: [earlier] })).toBe(true);
});

test("equal-time collision ties resolve by stable identity, not input order", () => {
  const alpha = threat({ id: "alpha", kind: "rocket" });
  const zulu = threat({ id: "zulu", kind: "rocket" });
  const forward = evaluateManualEmergencySentinel({ player: PLAYER, threats: [zulu, alpha] });
  const reversed = evaluateManualEmergencySentinel({ player: PLAYER, threats: [alpha, zulu] });

  expect(forward).toEqual(reversed);
  expect(forward.threatId).toBe("alpha");
});

test("sentinel rejects receding, static, and swept safe near-passes", () => {
  const safeThreats = [
    threat({
      id: "receding",
      position: { x: 1.01, y: 0 },
      velocity: { x: 8, y: 0 },
    }),
    threat({
      id: "relative-static",
      position: { x: 1.01, y: 0 },
      velocity: PLAYER.velocity,
    }),
    threat({
      id: "near-pass",
      position: { x: 1.01, y: 2 },
      velocity: { x: 2, y: -20 },
    }),
  ];
  const result = evaluateManualEmergencySentinel({ player: PLAYER, threats: safeThreats });

  expect(result).toEqual({
    needsAssist: false,
    earliestCollisionSeconds: null,
    threatId: null,
    threatKind: null,
  });
});

test("horizon override excludes a later collision without changing the default", () => {
  const incoming = threat();
  const collisionSeconds = (2.5 - PLAYER.radius - incoming.radius) / 12;

  expect(collisionSeconds).toBeGreaterThan(0.1);
  expect(collisionSeconds).toBeLessThan(MANUAL_EMERGENCY_SENTINEL_HORIZON_SECONDS);
  expect(evaluateManualEmergencySentinel({
    player: PLAYER,
    threats: [incoming],
    horizonSeconds: 0.1,
  }).needsAssist).toBe(false);
  expect(evaluateManualEmergencySentinel({
    player: PLAYER,
    threats: [incoming],
  }).earliestCollisionSeconds).toBeCloseTo(collisionSeconds);
});

test("malformed bodies are ignored safely and overlapping valid bodies still alarm", () => {
  const malformed = [
    threat({ id: "nan-position", position: { x: Number.NaN, y: 0 } }),
    threat({ id: "infinite-velocity", velocity: { x: Number.POSITIVE_INFINITY, y: 0 } }),
    threat({ id: "negative-radius", radius: -1 }),
  ];

  expect(evaluateManualEmergencySentinel({
    player: PLAYER,
    threats: malformed,
    horizonSeconds: Number.NaN,
    clearanceMargin: Number.NaN,
  }).needsAssist).toBe(false);
  expect(evaluateManualEmergencySentinel({
    player: { ...PLAYER, position: { x: Number.NaN, y: 0 } },
    threats: [threat()],
  }).needsAssist).toBe(false);
  expect(evaluateManualEmergencySentinel({
    player: PLAYER,
    threats: [threat({ position: { x: 0.5, y: 0 }, velocity: PLAYER.velocity })],
  }).earliestCollisionSeconds).toBe(0);
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function generatedBody(random: () => number): ManualEmergencyBody {
  return {
    position: { x: random() * 12 - 6, y: random() * 20 - 10 },
    velocity: { x: random() * 8 - 4, y: random() * 8 - 4 },
    radius: 0.4 + random() * 0.55,
  };
}

function generatedCollision(
  random: () => number,
  player: ManualEmergencyBody,
  index: number,
): { readonly threat: ManualEmergencyThreat; readonly entrySeconds: number } {
  const angle = random() * Math.PI * 2;
  const normal = { x: Math.cos(angle), y: Math.sin(angle) };
  const perpendicular = { x: -normal.y, y: normal.x };
  const radius = 0.12 + random() * 0.48;
  const collisionRadius = player.radius + radius;
  const speed = 8 + random() * 22;
  const entrySeconds = 0.04 + random() * 0.145;
  const impactOffset = (random() * 2 - 1) * collisionRadius * 0.82;
  const entryToClosestSeconds = Math.sqrt(
    collisionRadius * collisionRadius - impactOffset * impactOffset,
  ) / speed;
  const closestSeconds = entrySeconds + entryToClosestSeconds;
  const relativePosition = {
    x: normal.x * speed * closestSeconds + perpendicular.x * impactOffset,
    y: normal.y * speed * closestSeconds + perpendicular.y * impactOffset,
  };
  const relativeVelocity = { x: -normal.x * speed, y: -normal.y * speed };
  const kinds: readonly ManualEmergencyThreatKind[] = ["projectile", "rocket", "enemy"];
  return {
    entrySeconds,
    threat: {
      id: `generated-hit-${index}`,
      kind: kinds[index % kinds.length] ?? "projectile",
      position: {
        x: player.position.x + relativePosition.x,
        y: player.position.y + relativePosition.y,
      },
      velocity: {
        x: player.velocity.x + relativeVelocity.x,
        y: player.velocity.y + relativeVelocity.y,
      },
      radius,
    },
  };
}

test("generated fair collision fixtures have 100% sentinel recall", () => {
  const random = seededRandom(0x5e17_1e1);
  const fixtureCount = 300;
  let recalled = 0;

  for (let index = 0; index < fixtureCount; index += 1) {
    const player = generatedBody(random);
    const fixture = generatedCollision(random, player, index);
    const result = evaluateManualEmergencySentinel({ player, threats: [fixture.threat] });
    recalled += Number(result.needsAssist);
    expect(result.earliestCollisionSeconds).toBeCloseTo(fixture.entrySeconds, 7);
  }

  expect(recalled).toBe(fixtureCount);
});

test("generated receding, static, near-pass, and post-horizon fixtures stay below 1% false alarms", () => {
  const random = seededRandom(0xfa15_e001);
  const fixtureCount = 600;
  let falseAlarms = 0;

  for (let index = 0; index < fixtureCount; index += 1) {
    const player = generatedBody(random);
    const angle = random() * Math.PI * 2;
    const normal = { x: Math.cos(angle), y: Math.sin(angle) };
    const perpendicular = { x: -normal.y, y: normal.x };
    const radius = 0.12 + random() * 0.48;
    const collisionRadius = player.radius + radius;
    const speed = 8 + random() * 22;
    const fixtureKind = index % 4;
    let relativePosition: { x: number; y: number };
    let relativeVelocity: { x: number; y: number };

    if (fixtureKind === 0 || fixtureKind === 1) {
      const distance = collisionRadius + 0.02 + random() * 1.5;
      relativePosition = { x: normal.x * distance, y: normal.y * distance };
      relativeVelocity = fixtureKind === 0
        ? { x: normal.x * speed, y: normal.y * speed }
        : { x: 0, y: 0 };
    } else {
      const impactOffset = fixtureKind === 2
        ? collisionRadius + 0.02 + random() * 0.75
        : (random() * 2 - 1) * collisionRadius * 0.75;
      const entrySeconds = fixtureKind === 2 ? random() * 0.19 : 0.22 + random() * 0.16;
      const entryToClosestSeconds = fixtureKind === 2
        ? 0
        : Math.sqrt(collisionRadius * collisionRadius - impactOffset * impactOffset) / speed;
      const closestSeconds = entrySeconds + entryToClosestSeconds;
      relativePosition = {
        x: normal.x * speed * closestSeconds + perpendicular.x * impactOffset,
        y: normal.y * speed * closestSeconds + perpendicular.y * impactOffset,
      };
      relativeVelocity = { x: -normal.x * speed, y: -normal.y * speed };
    }

    const candidate: ManualEmergencyThreat = {
      id: `generated-safe-${index}`,
      kind: index % 2 === 0 ? "projectile" : "rocket",
      position: {
        x: player.position.x + relativePosition.x,
        y: player.position.y + relativePosition.y,
      },
      velocity: {
        x: player.velocity.x + relativeVelocity.x,
        y: player.velocity.y + relativeVelocity.y,
      },
      radius,
    };
    falseAlarms += Number(evaluateManualEmergencySentinel({
      player,
      threats: [candidate],
    }).needsAssist);
  }

  expect(falseAlarms).toBe(0);
  expect(falseAlarms / fixtureCount).toBeLessThanOrEqual(0.01);
});
