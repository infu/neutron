export type PlayerAimTargetKind = "enemy" | "boss";

export interface PlayerAimPoint {
  readonly x: number;
  readonly y: number;
}

export interface PlayerAimTarget {
  readonly id: string | number;
  readonly kind: PlayerAimTargetKind;
  readonly position: PlayerAimPoint;
  readonly velocity: PlayerAimPoint;
  readonly radius: number;
  readonly priority: number;
  readonly visible: boolean;
  readonly damageable: boolean;
}

export interface PlayerMissileTarget {
  readonly id: string | number;
  readonly kind: PlayerAimTargetKind;
  readonly health: number;
  /** Damage that can land before an encounter gate absorbs further damage. */
  readonly damageBudget: number;
  readonly priority: number;
  readonly damageable: boolean;
}

export interface PlayerMissileAssignment {
  readonly targetId: string | number;
  readonly targetKind: PlayerAimTargetKind;
}

export interface PlayerAimTuning {
  /** Linear velocity prediction is deliberately short for curved enemy paths. */
  readonly maximumLeadSeconds: number;
  /** Cannon steering is bounded around the fighter's forward (+Y) axis. */
  readonly maximumAimAngleRadians: number;
  readonly minimumForwardDistance: number;
  readonly travelTimePenalty: number;
  readonly anglePenalty: number;
  readonly bossValueMultiplier: number;
}

export interface PlayerAimObservation {
  readonly origin: PlayerAimPoint;
  readonly projectileSpeed: number;
  readonly targets: ReadonlyArray<PlayerAimTarget>;
  /**
   * Converts target velocity from hostile-simulation seconds to real projectile
   * seconds. Runtime should pass its current hostile time scale; omission keeps
   * the existing real-time velocity contract.
   */
  readonly targetTimeScale?: number;
}

export interface PlayerAimDecision {
  readonly angleRadians: number;
  readonly targetId: string | number | null;
  readonly targetKind: PlayerAimTargetKind | null;
  readonly leadSeconds: number;
  readonly predictedPosition: PlayerAimPoint | null;
  readonly value: number;
}

export const PLAYER_AIM_TUNING: Readonly<PlayerAimTuning> = Object.freeze({
  maximumLeadSeconds: 2.25,
  maximumAimAngleRadians: Math.PI / 10,
  minimumForwardDistance: 0.35,
  travelTimePenalty: 0.24,
  anglePenalty: 0.32,
  bossValueMultiplier: 1.18,
});

export const MAX_PLAYER_MISSILES_PER_SALVO = 4;

const EPSILON = 1e-9;

const STRAIGHT_AIM: Readonly<PlayerAimDecision> = Object.freeze({
  angleRadians: 0,
  targetId: null,
  targetKind: null,
  leadSeconds: 0,
  predictedPosition: null,
  value: 0,
});

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Converts a velocity observed in target-local time into projectile/world time. */
export function scaleObservedTargetVelocity(
  velocity: PlayerAimPoint,
  targetTimeScale = 1,
): PlayerAimPoint {
  const scale = Math.max(0, finiteOr(targetTimeScale, 1));
  return Object.freeze({
    x: finiteOr(velocity.x, 0) * scale,
    y: finiteOr(velocity.y, 0) * scale,
  });
}

function stableTargetId(target: PlayerAimTarget): string {
  const id = typeof target.id === "number"
    ? `0:${Math.trunc(target.id).toString().padStart(16, "0")}`
    : `1:${target.id}`;
  return `${target.kind}:${id}`;
}

function stableMissileTargetId(target: PlayerMissileTarget): string {
  const id = typeof target.id === "number"
    ? `0:${Math.trunc(target.id).toString().padStart(16, "0")}`
    : `1:${target.id}`;
  return `${target.kind}:${id}`;
}

/**
 * Returns the earliest non-negative linear intercept inside the prediction
 * window. An intercept beyond the window is rejected instead of being truncated:
 * a truncated time is not a ballistic solution and produces a guaranteed miss
 * for a constant-velocity target. Null means no valid bounded intercept exists.
 */
export function ballisticInterceptSeconds(
  origin: PlayerAimPoint,
  targetPosition: PlayerAimPoint,
  targetVelocity: PlayerAimPoint,
  projectileSpeed: number,
  maximumLeadSeconds = PLAYER_AIM_TUNING.maximumLeadSeconds,
): number | null {
  const speed = finiteOr(projectileSpeed, 0);
  const maximumLead = Math.max(0, finiteOr(maximumLeadSeconds, 0));

  if (speed <= EPSILON || maximumLead <= EPSILON) {
    return null;
  }

  const relativeX = finiteOr(targetPosition.x, 0) - finiteOr(origin.x, 0);
  const relativeY = finiteOr(targetPosition.y, 0) - finiteOr(origin.y, 0);
  const velocityX = finiteOr(targetVelocity.x, 0);
  const velocityY = finiteOr(targetVelocity.y, 0);
  const constant = relativeX * relativeX + relativeY * relativeY;

  if (constant <= EPSILON) {
    return 0;
  }

  const quadratic = velocityX * velocityX + velocityY * velocityY - speed * speed;
  const linear = 2 * (relativeX * velocityX + relativeY * velocityY);
  let intercept = Number.POSITIVE_INFINITY;

  if (Math.abs(quadratic) <= EPSILON) {
    if (Math.abs(linear) > EPSILON) {
      const candidate = -constant / linear;
      if (candidate >= 0) {
        intercept = candidate;
      }
    }
  } else {
    const discriminant = linear * linear - 4 * quadratic * constant;

    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const first = (-linear - root) / (2 * quadratic);
      const second = (-linear + root) / (2 * quadratic);

      if (first >= 0) intercept = Math.min(intercept, first);
      if (second >= 0) intercept = Math.min(intercept, second);
    }
  }

  return Number.isFinite(intercept) && intercept <= maximumLead + EPSILON
    ? Math.max(0, intercept)
    : null;
}

/** Stable marginal value used only after a target has a valid firing solution. */
export function playerAimTargetValue(
  target: PlayerAimTarget,
  leadSeconds: number,
  aimAngleRadians: number,
  tuning: Readonly<PlayerAimTuning> = PLAYER_AIM_TUNING,
): number {
  const priority = clamp(finiteOr(target.priority, 1), 0.05, 24);
  const radius = clamp(finiteOr(target.radius, 0), 0, 4);
  const lead = Math.max(0, finiteOr(leadSeconds, 0));
  const angle = Math.abs(finiteOr(aimAngleRadians, 0));
  const kindMultiplier = target.kind === "boss"
    ? Math.max(0.1, finiteOr(tuning.bossValueMultiplier, 1))
    : 1;
  const sizeMultiplier = 1 + radius * 0.055;
  const travelDivisor = 1 + lead * Math.max(0, finiteOr(tuning.travelTimePenalty, 0));
  const angleDivisor = 1 + angle * Math.max(0, finiteOr(tuning.anglePenalty, 0));

  return priority * kindMultiplier * sizeMultiplier / (travelDivisor * angleDivisor);
}

/**
 * Assigns at most four missiles by useful marginal damage. Each assignment
 * consumes virtual health, so later missiles move to another target instead
 * of being knowingly spent beyond a health or boss-gate budget.
 */
export function allocatePlayerMissileTargets(
  targets: ReadonlyArray<PlayerMissileTarget>,
  missileDamage: number,
  requestedCount = MAX_PLAYER_MISSILES_PER_SALVO,
): readonly PlayerMissileAssignment[] {
  const damage = Math.max(0, finiteOr(missileDamage, 0));
  const count = clamp(
    Math.floor(finiteOr(requestedCount, 0)),
    0,
    MAX_PLAYER_MISSILES_PER_SALVO,
  );

  if (damage <= EPSILON || count === 0) {
    return Object.freeze([]);
  }

  const candidates = targets.flatMap((target) => {
    const health = Math.max(0, finiteOr(target.health, 0));
    const budget = Math.max(0, finiteOr(target.damageBudget, 0));
    const remaining = Math.min(health, budget);

    if (!target.damageable || remaining <= EPSILON) {
      return [];
    }

    return [{
      target,
      remaining,
      priority: clamp(finiteOr(target.priority, 1), 0.05, 24),
      stableId: stableMissileTargetId(target),
    }];
  });
  const assignments: PlayerMissileAssignment[] = [];

  for (let index = 0; index < count; index += 1) {
    let selected = candidates[0];
    let selectedValue = selected
      ? Math.min(damage, selected.remaining) * selected.priority
      : Number.NEGATIVE_INFINITY;

    for (const candidate of candidates.slice(1)) {
      const value = Math.min(damage, candidate.remaining) * candidate.priority;

      if (
        !selected
        || value > selectedValue + EPSILON
        || (
          Math.abs(value - selectedValue) <= EPSILON
          && candidate.stableId < selected.stableId
        )
      ) {
        selected = candidate;
        selectedValue = value;
      }
    }

    if (!selected || selected.remaining <= EPSILON) {
      break;
    }

    assignments.push(Object.freeze({
      targetId: selected.target.id,
      targetKind: selected.target.kind,
    }));
    selected.remaining = Math.max(0, selected.remaining - damage);

    if (selected.remaining <= EPSILON) {
      const selectedIndex = candidates.indexOf(selected);
      if (selectedIndex >= 0) {
        candidates.splice(selectedIndex, 1);
      }
    }
  }

  return Object.freeze(assignments);
}

/**
 * Selects one visible forward target deterministically. A target whose center
 * is just outside the steering cone may still be chosen when its hit radius
 * overlaps the cone; the returned cannon angle itself is always clamped.
 */
export function selectPlayerCannonAim(
  observation: PlayerAimObservation,
  tuning: Readonly<PlayerAimTuning> = PLAYER_AIM_TUNING,
): PlayerAimDecision {
  const origin = {
    x: finiteOr(observation.origin.x, 0),
    y: finiteOr(observation.origin.y, 0),
  };
  const maximumAimAngle = clamp(
    finiteOr(tuning.maximumAimAngleRadians, PLAYER_AIM_TUNING.maximumAimAngleRadians),
    0,
    Math.PI / 2 - 0.01,
  );
  const minimumForwardDistance = Math.max(0, finiteOr(tuning.minimumForwardDistance, 0));
  const targetTimeScale = Math.max(0, finiteOr(observation.targetTimeScale ?? 1, 1));
  let selected: PlayerAimDecision | null = null;
  let selectedStableId = "";

  for (const target of observation.targets) {
    if (!target.visible || !target.damageable) {
      continue;
    }

    const targetX = finiteOr(target.position.x, 0);
    const targetY = finiteOr(target.position.y, 0);

    if (targetY - origin.y < minimumForwardDistance) {
      continue;
    }

    const targetVelocity = scaleObservedTargetVelocity(target.velocity, targetTimeScale);
    const leadSeconds = ballisticInterceptSeconds(
      origin,
      { x: targetX, y: targetY },
      targetVelocity,
      observation.projectileSpeed,
      tuning.maximumLeadSeconds,
    );

    if (leadSeconds === null) {
      continue;
    }

    const predictedPosition = {
      x: targetX + targetVelocity.x * leadSeconds,
      y: targetY + targetVelocity.y * leadSeconds,
    };
    const forwardDistance = predictedPosition.y - origin.y;

    if (forwardDistance < minimumForwardDistance) {
      continue;
    }

    const lateralDistance = predictedPosition.x - origin.x;
    const rawAngle = Math.atan2(lateralDistance, forwardDistance);
    const distance = Math.hypot(lateralDistance, forwardDistance);
    const angularRadius = distance > EPSILON
      ? Math.asin(clamp(Math.max(0, finiteOr(target.radius, 0)) / distance, 0, 0.95))
      : Math.PI / 2;

    if (Math.abs(rawAngle) > maximumAimAngle + angularRadius + EPSILON) {
      continue;
    }

    const angleRadians = clamp(rawAngle, -maximumAimAngle, maximumAimAngle);
    const value = playerAimTargetValue(target, leadSeconds, angleRadians, tuning);
    const stableId = stableTargetId(target);
    const candidate: PlayerAimDecision = {
      angleRadians,
      targetId: target.id,
      targetKind: target.kind,
      leadSeconds,
      predictedPosition,
      value,
    };

    if (
      !selected
      || value > selected.value + EPSILON
      || (Math.abs(value - selected.value) <= EPSILON && stableId < selectedStableId)
    ) {
      selected = candidate;
      selectedStableId = stableId;
    }
  }

  return selected ?? STRAIGHT_AIM;
}
