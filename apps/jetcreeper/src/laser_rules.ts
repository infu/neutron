export const LOW_PROFILE_LASER_DAMAGE_MULTIPLIER = 10;
export const LOW_PROFILE_LASER_CRITICAL_MULTIPLIER = 5;
export const LOW_PROFILE_BOSS_LASER_MAX_HEALTH_FRACTION = 0.2;
export const LOW_PROFILE_TIME_WARP_SECONDS = 5;
export const LOW_PROFILE_HOSTILE_TIME_SCALE = 1 / 3;
export const LOW_PROFILE_PLAYER_SPEED_MULTIPLIER = 1.5;

/** Damage is target-specific so the below-half-health critical cannot leak across targets. */
export function laserDamageForTarget(
  baseDamage: number,
  currentHealth: number,
  maximumHealth: number,
  lowProfileActive: boolean,
): number {
  const safeDamage = Number.isFinite(baseDamage) ? Math.max(0, baseDamage) : 0;
  if (!lowProfileActive) {
    return safeDamage;
  }

  const safeMaximum = Number.isFinite(maximumHealth) ? Math.max(0, maximumHealth) : 0;
  const belowHalfHealth = safeMaximum > 0
    && Number.isFinite(currentHealth)
    && currentHealth < safeMaximum * 0.5;
  return safeDamage
    * LOW_PROFILE_LASER_DAMAGE_MULTIPLIER
    * (belowHalfHealth ? LOW_PROFILE_LASER_CRITICAL_MULTIPLIER : 1);
}

/**
 * A low-profile laser strike against a boss is max-health based so it remains
 * equally decisive as boss health scales. Runtime owns the once-per-activation
 * latch; this helper defines the damage for that single intended strike.
 */
export function laserDamageForBoss(
  baseDamage: number,
  maximumHealth: number,
  lowProfileActive: boolean,
): number {
  const safeDamage = Number.isFinite(baseDamage) ? Math.max(0, baseDamage) : 0;

  if (!lowProfileActive) {
    return safeDamage;
  }

  const safeMaximum = Number.isFinite(maximumHealth) ? Math.max(0, maximumHealth) : 0;
  return safeMaximum * LOW_PROFILE_BOSS_LASER_MAX_HEALTH_FRACTION;
}

/** Keeps gate-deferred boss-strike credit finite and prevents damage loss. */
export function remainingBossLaserStrikeDamage(
  pendingDamage: number,
  appliedDamage: number,
): number {
  const safePending = Number.isFinite(pendingDamage) ? Math.max(0, pendingDamage) : 0;
  const safeApplied = Number.isFinite(appliedDamage) ? Math.max(0, appliedDamage) : 0;
  return Math.max(0, safePending - safeApplied);
}
