import { expect, test } from "bun:test";
import {
  DEFAULT_SUPER_BRAIN_CONFIG,
  SuperBrainController,
  decideSuperBrain,
  type BrainObservation,
  type BrainThreat,
  type Vec2,
} from "../src/autopilot.ts";
import { JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS } from "../src/abilities.ts";
import { clampNumber, difficultyForSector, segmentCircleOverlap } from "../src/game_rules.ts";

interface HarnessThreat {
  id: number;
  kind: "projectile" | "rocket";
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  radius: number;
  homingRemaining: number;
}

interface HarnessResult {
  completedSector: number;
  acceptedThreats: number;
  damageTaken: number;
  hash: number;
}

const BOUNDS = { left: -10, right: 10, bottom: -16, top: 16 } as const;
const PLAYER_SPEED = 11.5;
const NORMAL_RADIUS = 0.78;
const LOW_PROFILE_RADIUS = 0.42;
const PLANNING_STEP = 0.12;
const PHYSICS_STEP = 0.06;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function hashNumber(hash: number, value: number): number {
  const quantized = Math.round(value * 1000);
  return Math.imul(hash ^ quantized, 16_777_619) >>> 0;
}

function normalize(x: number, y: number): Vec2 {
  const distance = Math.hypot(x, y) || 1;
  return { x: x / distance, y: y / distance };
}

function asBrainThreat(threat: HarnessThreat): BrainThreat {
  const common = {
    id: threat.id,
    kind: threat.kind,
    position: { x: threat.x, y: threat.y },
    velocity: { x: threat.velocityX, y: threat.velocityY },
    radius: threat.radius,
  } as const;

  return threat.kind === "rocket"
    ? {
      ...common,
      motion: "homing",
      homingSecondsRemaining: threat.homingRemaining,
      homingStrength: 0.82,
    }
    : common;
}

function runHarness(seed: number): HarnessResult {
  const random = seededRandom(seed);
  const controller = new SuperBrainController();
  const threats: HarnessThreat[] = [];
  let player = { x: 0, y: -12.4 };
  let playerVelocity = { x: 0, y: 0 };
  let playerRadius = NORMAL_RADIUS;
  let dashRemaining = 0;
  let dashCooldown = 0;
  let lowProfileRemaining = 0;
  let lowProfileCooldown = 0;
  let missileCooldown = 0;
  let dashDirection: Vec2 = { x: 0, y: 1 };
  let previousMovement: Vec2 = { x: 0, y: 0 };
  let nextThreatId = 1;
  let acceptedThreats = 0;
  let damageTaken = 0;
  let hash = 2_166_136_261;

  const observation = (extraThreat?: HarnessThreat): BrainObservation => {
    const nearest = threats.reduce<HarnessThreat | undefined>((selected, threat) => {
      if (!selected) {
        return threat;
      }

      return Math.hypot(threat.x - player.x, threat.y - player.y)
        < Math.hypot(selected.x - player.x, selected.y - player.y)
        ? threat
        : selected;
    }, undefined);
    // Deliberately request movement toward the nearest danger. The controller
    // may honor only the safe component of this 30% manual preference.
    const manualIntent = nearest ? normalize(nearest.x - player.x, nearest.y - player.y) : { x: 1, y: 0 };
    const observedThreats = extraThreat ? [...threats, extraThreat] : threats;

    return {
      player: {
        position: player,
        velocity: playerVelocity,
        radius: playerRadius,
        maxSpeed: PLAYER_SPEED,
      },
      bounds: BOUNDS,
      threats: observedThreats.map(asBrainThreat),
      targets: [{
        id: "flight-lane",
        kind: "enemy",
        position: { x: 0, y: 13 },
        velocity: { x: 0, y: -1.2 },
        radius: 0.7,
        priority: 1,
        health: 1,
        damageable: true,
      }],
      manualIntent,
      abilities: {
        dashReady: dashCooldown <= 0 && dashRemaining <= 0,
        lowProfileReady: lowProfileCooldown <= 0 && lowProfileRemaining <= 0,
        lowProfileActive: lowProfileRemaining > 0,
        missilesReady: missileCooldown <= 0,
        dashSpeedMultiplier: 4,
        dashDurationSeconds: 0.12,
        lowProfileRadius: LOW_PROFILE_RADIUS,
      },
    };
  };

  for (let sector = 1; sector <= 200; sector += 1) {
    const difficulty = difficultyForSector(sector);
    let acceptedThisSector = false;

    // This is a predictor regression for isolated, explicitly admitted fair
    // threats. Production pressure intentionally stops guaranteeing a route as
    // it approaches terminal sector 200.
    for (let attempt = 0; attempt < 12 && !acceptedThisSector; attempt += 1) {
      const rocket = sector % 5 === 0 && attempt % 3 === 0;
      const originX = BOUNDS.left + 1 + random() * (BOUNDS.right - BOUNDS.left - 2);
      const originY = BOUNDS.top + 1.5 + attempt * 0.18;
      const aim = normalize(player.x - originX + (random() - 0.5) * 3, player.y - originY);
      const speed = difficulty.enemyProjectileSpeed * (rocket ? 0.72 : 1);
      const candidate: HarnessThreat = {
        id: nextThreatId,
        kind: rocket ? "rocket" : "projectile",
        x: originX,
        y: originY,
        velocityX: aim.x * speed,
        velocityY: aim.y * speed,
        radius: rocket ? 0.3 : 0.2,
        homingRemaining: rocket ? 2.8 : 0,
      };
      const viability = decideSuperBrain(observation(candidate), previousMovement);

      if (
        viability.survivalSeconds >= DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds - 1e-9
        && viability.predictedClearance > 0.02
      ) {
        threats.push(candidate);
        nextThreatId += 1;
        acceptedThreats += 1;
        acceptedThisSector = true;
      }
    }

    expect(acceptedThisSector).toBe(true);

    for (let planningTick = 0; planningTick < 4; planningTick += 1) {
      const decision = controller.decide(observation());
      previousMovement = decision.movement;

      if (decision.useLowProfile && lowProfileCooldown <= 0) {
        lowProfileRemaining = 1.35;
        lowProfileCooldown = 5.5;
      }

      if (decision.useDash && dashCooldown <= 0) {
        dashRemaining = 0.12;
        dashCooldown = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS.dash;
        dashDirection = decision.movement;
      }

      if (decision.useMissiles && missileCooldown <= 0) {
        missileCooldown = 5;
      }

      for (let physicsTick = 0; physicsTick < PLANNING_STEP / PHYSICS_STEP; physicsTick += 1) {
        playerRadius = lowProfileRemaining > 0 ? LOW_PROFILE_RADIUS : NORMAL_RADIUS;
        const previousPlayer = player;
        const movement = dashRemaining > 0 ? dashDirection : decision.movement;
        const speed = dashRemaining > 0 ? PLAYER_SPEED * 4 : PLAYER_SPEED;
        player = {
          x: clampNumber(player.x + movement.x * speed * PHYSICS_STEP, BOUNDS.left + playerRadius, BOUNDS.right - playerRadius),
          y: clampNumber(player.y + movement.y * speed * PHYSICS_STEP, BOUNDS.bottom + playerRadius, BOUNDS.top - playerRadius),
        };
        playerVelocity = {
          x: (player.x - previousPlayer.x) / PHYSICS_STEP,
          y: (player.y - previousPlayer.y) / PHYSICS_STEP,
        };

        for (const threat of threats) {
          const previousThreatX = threat.x;
          const previousThreatY = threat.y;

          if (threat.kind === "rocket" && threat.homingRemaining > 0) {
            const currentSpeed = Math.hypot(threat.velocityX, threat.velocityY) || 1;
            const target = normalize(player.x - threat.x, player.y - threat.y);
            const steering = Math.min(1, PHYSICS_STEP * 0.82);
            const steered = normalize(
              threat.velocityX / currentSpeed * (1 - steering) + target.x * steering,
              threat.velocityY / currentSpeed * (1 - steering) + target.y * steering,
            );
            threat.velocityX = steered.x * currentSpeed;
            threat.velocityY = steered.y * currentSpeed;
            threat.homingRemaining = Math.max(0, threat.homingRemaining - PHYSICS_STEP);
          }

          threat.x += threat.velocityX * PHYSICS_STEP;
          threat.y += threat.velocityY * PHYSICS_STEP;
          const relativeStartX = previousPlayer.x - previousThreatX;
          const relativeStartY = previousPlayer.y - previousThreatY;
          const relativeEndX = player.x - threat.x;
          const relativeEndY = player.y - threat.y;

          if (segmentCircleOverlap(
            relativeStartX,
            relativeStartY,
            relativeEndX,
            relativeEndY,
            playerRadius + threat.radius,
            0,
            0,
            0,
          )) {
            damageTaken += 1;
          }
        }

        for (let index = threats.length - 1; index >= 0; index -= 1) {
          const threat = threats[index];

          if (threat && (
            threat.x < BOUNDS.left - 4 ||
            threat.x > BOUNDS.right + 4 ||
            threat.y < BOUNDS.bottom - 4 ||
            threat.y > BOUNDS.top + 6
          )) {
            threats.splice(index, 1);
          }
        }

        dashRemaining = Math.max(0, dashRemaining - PHYSICS_STEP);
        dashCooldown = Math.max(0, dashCooldown - PHYSICS_STEP);
        lowProfileRemaining = Math.max(0, lowProfileRemaining - PHYSICS_STEP);
        lowProfileCooldown = Math.max(0, lowProfileCooldown - PHYSICS_STEP);
        missileCooldown = Math.max(0, missileCooldown - PHYSICS_STEP);
        hash = hashNumber(hash, player.x);
        hash = hashNumber(hash, player.y);
        hash = hashNumber(hash, decision.movement.x);

        expect(Number.isFinite(player.x) && Number.isFinite(player.y)).toBe(true);
        expect(player.x).toBeGreaterThanOrEqual(BOUNDS.left + playerRadius - 1e-9);
        expect(player.x).toBeLessThanOrEqual(BOUNDS.right - playerRadius + 1e-9);
        expect(player.y).toBeGreaterThanOrEqual(BOUNDS.bottom + playerRadius - 1e-9);
        expect(player.y).toBeLessThanOrEqual(BOUNDS.top - playerRadius + 1e-9);
      }
    }
  }

  return { completedSector: 200, acceptedThreats, damageTaken, hash };
}

test("Super Brain predicts 200 isolated fair-threat fixtures reproducibly", () => {
  const first = runHarness(0x5eed_0200);
  const replay = runHarness(0x5eed_0200);

  expect(first).toEqual(replay);
  expect(first.completedSector).toBe(200);
  expect(first.acceptedThreats).toBe(200);
  expect(first.damageTaken).toBe(0);
  expect(difficultyForSector(200).enemyProjectileSpeed).toBeGreaterThan(difficultyForSector(30).enemyProjectileSpeed);
});
