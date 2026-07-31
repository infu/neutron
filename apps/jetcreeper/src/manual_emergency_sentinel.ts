export const MANUAL_EMERGENCY_SENTINEL_HORIZON_SECONDS = 0.2;

export type ManualEmergencyThreatKind = "projectile" | "rocket" | "enemy";

export interface ManualEmergencyPoint {
  readonly x: number;
  readonly y: number;
}

export interface ManualEmergencyBody {
  readonly position: ManualEmergencyPoint;
  readonly velocity: ManualEmergencyPoint;
  readonly radius: number;
}

export interface ManualEmergencyThreat extends ManualEmergencyBody {
  readonly id: string | number;
  readonly kind: ManualEmergencyThreatKind;
}

export interface ManualEmergencySentinelObservation {
  readonly player: ManualEmergencyBody;
  readonly threats: ReadonlyArray<ManualEmergencyThreat>;
  /** Defaults to the production fast-alarm window of 0.2 seconds. */
  readonly horizonSeconds?: number;
  /** Optional extra collision radius; physical contact remains the default. */
  readonly clearanceMargin?: number;
}

export interface ManualEmergencySentinelResult {
  readonly needsAssist: boolean;
  readonly earliestCollisionSeconds: number | null;
  readonly threatId: string | number | null;
  readonly threatKind: ManualEmergencyThreatKind | null;
}

const EPSILON = 1e-9;

const NO_IMMINENT_COLLISION: Readonly<ManualEmergencySentinelResult> = Object.freeze({
  needsAssist: false,
  earliestCollisionSeconds: null,
  threatId: null,
  threatKind: null,
});

function finitePoint(point: ManualEmergencyPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

function validBody(body: ManualEmergencyBody): boolean {
  return finitePoint(body.position)
    && finitePoint(body.velocity)
    && Number.isFinite(body.radius)
    && body.radius >= 0;
}

function validThreatKind(kind: ManualEmergencyThreatKind): boolean {
  return kind === "projectile" || kind === "rocket" || kind === "enemy";
}

function stableThreatKey(threat: ManualEmergencyThreat): string {
  const stableId = typeof threat.id === "number"
    ? Number.isFinite(threat.id)
      ? `0:${Math.trunc(threat.id).toString().padStart(16, "0")}`
      : "0:invalid"
    : `1:${threat.id}`;
  return `${threat.kind}:${stableId}`;
}

function collisionEntrySeconds(
  player: ManualEmergencyBody,
  threat: ManualEmergencyThreat,
  horizonSeconds: number,
  clearanceMargin: number,
): number | null {
  const relativeX = threat.position.x - player.position.x;
  const relativeY = threat.position.y - player.position.y;
  const relativeVelocityX = threat.velocity.x - player.velocity.x;
  const relativeVelocityY = threat.velocity.y - player.velocity.y;
  const collisionRadius = player.radius + threat.radius + clearanceMargin;
  const constant = relativeX * relativeX + relativeY * relativeY
    - collisionRadius * collisionRadius;

  if (constant <= EPSILON) {
    return 0;
  }

  const quadratic = relativeVelocityX * relativeVelocityX
    + relativeVelocityY * relativeVelocityY;
  if (quadratic <= EPSILON) {
    return null;
  }

  const linear = 2 * (
    relativeX * relativeVelocityX
    + relativeY * relativeVelocityY
  );
  // Outside and no longer closing: a close static/receding object is not an alarm.
  if (linear >= 0) {
    return null;
  }

  const discriminant = linear * linear - 4 * quadratic * constant;
  if (discriminant < -EPSILON) {
    return null;
  }

  const entry = (-linear - Math.sqrt(Math.max(0, discriminant))) / (2 * quadratic);
  if (!Number.isFinite(entry) || entry < -EPSILON || entry > horizonSeconds + EPSILON) {
    return null;
  }

  return Math.max(0, Math.min(horizonSeconds, entry));
}

/** Exact constant-velocity circle sweep intended to run once per fixed tick. */
export function evaluateManualEmergencySentinel(
  observation: ManualEmergencySentinelObservation,
): ManualEmergencySentinelResult {
  if (!validBody(observation.player)) {
    return NO_IMMINENT_COLLISION;
  }

  const requestedHorizon = observation.horizonSeconds;
  const horizonSeconds = Number.isFinite(requestedHorizon)
    ? Math.max(0, requestedHorizon ?? 0)
    : MANUAL_EMERGENCY_SENTINEL_HORIZON_SECONDS;
  const requestedMargin = observation.clearanceMargin;
  const clearanceMargin = Number.isFinite(requestedMargin)
    ? Math.max(0, requestedMargin ?? 0)
    : 0;
  let earliestCollisionSeconds = Number.POSITIVE_INFINITY;
  let selectedThreat: ManualEmergencyThreat | null = null;
  let selectedKey = "";

  for (const threat of observation.threats) {
    if (!validThreatKind(threat.kind) || !validBody(threat)) {
      continue;
    }

    const collisionSeconds = collisionEntrySeconds(
      observation.player,
      threat,
      horizonSeconds,
      clearanceMargin,
    );
    if (collisionSeconds === null) {
      continue;
    }

    const key = stableThreatKey(threat);
    if (
      collisionSeconds < earliestCollisionSeconds - EPSILON
      || (
        Math.abs(collisionSeconds - earliestCollisionSeconds) <= EPSILON
        && (!selectedThreat || key < selectedKey)
      )
    ) {
      earliestCollisionSeconds = collisionSeconds;
      selectedThreat = threat;
      selectedKey = key;
    }
  }

  if (!selectedThreat) {
    return NO_IMMINENT_COLLISION;
  }

  return Object.freeze({
    needsAssist: true,
    earliestCollisionSeconds,
    threatId: selectedThreat.id,
    threatKind: selectedThreat.kind,
  });
}

export function manualEmergencySentinelNeedsAssist(
  observation: ManualEmergencySentinelObservation,
): boolean {
  return evaluateManualEmergencySentinel(observation).needsAssist;
}
