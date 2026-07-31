/** Normal and pickup-enhanced player cannon timings used by the runtime. */
export const PLAYER_PRIMARY_FIRE_INTERVAL_SECONDS = 0.16;
export const PLAYER_RAPID_FIRE_INTERVAL_SECONDS = 0.085;
export const PLAYER_OVERDRIVE_FIRE_INTERVAL_SCALE = 0.62;
export const PLAYER_DASH_BURST_FIRE_INTERVAL_SCALE = 0.1;

/**
 * Each Guardian starts faster than the player's rapid cannon. When temporary
 * jet buffs go beyond that cadence, bounded tracer packets accumulate multiple
 * logical wing rounds so every escort remains faster without flooding meshes.
 */
export const GUARDIAN_WING_FIRE_INTERVAL_SECONDS = 0.06;
export const GUARDIAN_WING_MIN_FIRE_INTERVAL_SECONDS = 1 / 240;
export const GUARDIAN_WING_PLAYER_INTERVAL_SCALE = 0.8;
export const GUARDIAN_WING_TRACER_INTERVAL_SECONDS = 0.04;
export const GUARDIAN_WING_MAX_LOGICAL_SHOTS_PER_PACKET = 12;
export const GUARDIAN_WING_RESERVED_PROJECTILE_SLOTS = 32;
export const GUARDIAN_WING_PROJECTILE_SPEED = 60;
export const GUARDIAN_WING_PROJECTILE_DAMAGE = 1;
export const GUARDIAN_WING_ACTIVE_SECONDS = 4;

export interface PlayerCannonCadenceState {
  readonly rapid: boolean;
  readonly overdrive: boolean;
  readonly burst: boolean;
}

export interface GuardianWingCadenceState {
  readonly accumulatedShots: number;
  readonly tracerCooldownSeconds: number;
}

export interface GuardianWingCadenceStep extends GuardianWingCadenceState {
  readonly logicalShots: number;
  readonly logicalFireIntervalSeconds: number;
}

export function playerCannonFireInterval(
  state: PlayerCannonCadenceState,
): number {
  return (state.rapid
    ? PLAYER_RAPID_FIRE_INTERVAL_SECONDS
    : PLAYER_PRIMARY_FIRE_INTERVAL_SECONDS)
    * (state.overdrive ? PLAYER_OVERDRIVE_FIRE_INTERVAL_SCALE : 1)
    * (state.burst ? PLAYER_DASH_BURST_FIRE_INTERVAL_SCALE : 1);
}

/** Every Guardian owns a logical cadence strictly faster than the current jet. */
export function guardianWingLogicalFireInterval(playerIntervalSeconds: number): number {
  const safePlayerInterval = Number.isFinite(playerIntervalSeconds) && playerIntervalSeconds > 0
    ? playerIntervalSeconds
    : PLAYER_PRIMARY_FIRE_INTERVAL_SECONDS;
  return Math.max(
    GUARDIAN_WING_MIN_FIRE_INTERVAL_SECONDS,
    Math.min(
      GUARDIAN_WING_FIRE_INTERVAL_SECONDS,
      safePlayerInterval * GUARDIAN_WING_PLAYER_INTERVAL_SCALE,
    ),
  );
}

/**
 * Accumulates high-rate logical rounds into one bounded tracer packet. This
 * keeps both escorts faster than a 10x dash burst without flooding the shared
 * projectile pool or running an unbounded catch-up loop after a slow frame.
 */
export function stepGuardianWingCadence(
  state: GuardianWingCadenceState,
  deltaSeconds: number,
  playerIntervalSeconds: number,
): GuardianWingCadenceStep {
  const safeDelta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
  const logicalFireIntervalSeconds = guardianWingLogicalFireInterval(playerIntervalSeconds);
  const previousShots = Number.isFinite(state.accumulatedShots)
    ? Math.max(0, state.accumulatedShots)
    : 0;
  const previousCooldown = Number.isFinite(state.tracerCooldownSeconds)
    ? Math.max(0, state.tracerCooldownSeconds)
    : 0;
  const accumulatedShots = Math.min(
    GUARDIAN_WING_MAX_LOGICAL_SHOTS_PER_PACKET,
    previousShots + safeDelta / logicalFireIntervalSeconds,
  );
  const tracerCooldownSeconds = Math.max(0, previousCooldown - safeDelta);
  const logicalShots = tracerCooldownSeconds <= 1e-9
    ? Math.min(
        GUARDIAN_WING_MAX_LOGICAL_SHOTS_PER_PACKET,
        Math.floor(accumulatedShots + 1e-9),
      )
    : 0;

  return Object.freeze({
    accumulatedShots: logicalShots > 0 ? accumulatedShots - logicalShots : accumulatedShots,
    tracerCooldownSeconds: logicalShots > 0
      ? GUARDIAN_WING_TRACER_INTERVAL_SECONDS
      : tracerCooldownSeconds,
    logicalShots,
    logicalFireIntervalSeconds,
  });
}

/** Stagger the pair so their rounds alternate instead of visually overlapping. */
export function initialGuardianWingFireCooldown(wingIndex: number): number {
  const safeIndex = Number.isFinite(wingIndex) ? Math.max(0, Math.floor(wingIndex)) : 0;
  return safeIndex * GUARDIAN_WING_TRACER_INTERVAL_SECONDS / 2;
}
