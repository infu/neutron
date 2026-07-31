/**
 * Runtime tuning for Jetcreeper's thirteen advanced timed attachments.
 *
 * Keeping these values and the small state transitions pure makes it possible
 * to verify the contracts without constructing a WebGL scene. Projectile
 * flags are captured when a round is fired, so an in-flight round retains the
 * hardware that produced it even when the attachment timer expires.
 */

export const PIERCING_EXTRA_TARGETS = 1;
export const RICOCHET_REDIRECTS = 1;

export const CHAIN_LIGHTNING_MAX_SECONDARY_TARGETS = 3;
export const CHAIN_LIGHTNING_RADIUS = 4.4;
export const CHAIN_LIGHTNING_DAMAGE_MULTIPLIER = 0.7;
export const CHAIN_LIGHTNING_DAMAGE_FALLOFF = 0.72;

export const EXPLOSIVE_SPLASH_RADIUS = 2.6;
export const EXPLOSIVE_SPLASH_DAMAGE_MULTIPLIER = 0.65;

export const CRYO_SLOW_SECONDS = 3.5;
export const CRYO_TIME_SCALE = 0.45;

export const TARGETING_MAXIMUM_LEAD_SECONDS = 3.5;
export const TARGETING_MAXIMUM_AIM_ANGLE_RADIANS = Math.PI / 6;
export const TARGETING_STEERING_PER_SECOND = 9;

export const ACCELERATOR_PROJECTILE_SPEED_MULTIPLIER = 1.7;
export const AFTERBURNER_FLIGHT_MULTIPLIER = 1.45;
export const PHASE_HULL_RADIUS_MULTIPLIER = 0.55;

export const MAGNET_ATTRACTION_RADIUS = 10;
export const MAGNET_ATTRACTION_SPEED = 13;
export const MAGNET_COLLECTION_RADIUS_BONUS = 1.5;

export const NANOREPAIR_MAX_CHARGED_KILLS = 5;
export const NANOREPAIR_KILLS_PER_REPAIR = 3;

export const MISSILE_RACK_SALVO_COUNT = 8;
export const MISSILE_RACK_DAMAGE_MULTIPLIER = 2;

export const BOMB_AMPLIFIER_DAMAGE_MULTIPLIER = 2;
export const BOMB_AMPLIFIER_RADIUS_MULTIPLIER = 1.5;

export interface NanorepairState {
  readonly killsRemaining: number;
  readonly charge: number;
}

export interface NanorepairKillOutcome extends NanorepairState {
  readonly repairedHull: boolean;
}

export interface BombPayload {
  readonly damage: number;
  readonly radius: number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** One attachment can restore at most one hull point from five credited kills. */
export function applyNanorepairKill(
  state: Readonly<NanorepairState>,
  lives: number,
  maximumLives: number,
): Readonly<NanorepairKillOutcome> {
  const killsRemaining = Math.max(0, Math.floor(finiteNonNegative(state.killsRemaining)));
  const charge = Math.max(0, Math.floor(finiteNonNegative(state.charge)));

  if (killsRemaining === 0) {
    return Object.freeze({ killsRemaining: 0, charge, repairedHull: false });
  }

  const nextCharge = charge + 1;
  const canRepair = finiteNonNegative(lives) < finiteNonNegative(maximumLives);
  const repairedHull = canRepair && nextCharge >= NANOREPAIR_KILLS_PER_REPAIR;

  return Object.freeze({
    killsRemaining: killsRemaining - 1,
    charge: repairedHull ? nextCharge - NANOREPAIR_KILLS_PER_REPAIR : nextCharge,
    repairedHull,
  });
}

export function amplifiedBombPayload(
  baseDamage: number,
  baseRadius: number,
  amplifierActive: boolean,
): Readonly<BombPayload> {
  const multiplier = amplifierActive ? BOMB_AMPLIFIER_DAMAGE_MULTIPLIER : 1;
  const radiusMultiplier = amplifierActive ? BOMB_AMPLIFIER_RADIUS_MULTIPLIER : 1;

  return Object.freeze({
    damage: finiteNonNegative(baseDamage) * multiplier,
    radius: finiteNonNegative(baseRadius) * radiusMultiplier,
  });
}

export function phaseHullCollisionRadius(baseRadius: number, phaseHullActive: boolean): number {
  return finiteNonNegative(baseRadius) * (phaseHullActive ? PHASE_HULL_RADIUS_MULTIPLIER : 1);
}

/** Attraction accelerates smoothly toward the crate instead of snapping it. */
export function magnetAttractionSpeed(distance: number): number {
  const safeDistance = finiteNonNegative(distance);

  if (safeDistance <= 0 || safeDistance > MAGNET_ATTRACTION_RADIUS) {
    return 0;
  }

  return MAGNET_ATTRACTION_SPEED
    * (0.35 + 0.65 * (1 - safeDistance / MAGNET_ATTRACTION_RADIUS));
}
