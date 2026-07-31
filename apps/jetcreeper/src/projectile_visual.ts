function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Rotation for a projectile whose modeled nose points along local +Y.
 * Keeping this derived only from velocity prevents pooled comet meshes from
 * tumbling sideways or retaining a previous shot's pose.
 */
export function projectileHeadingRadians(
  velocityX: number,
  velocityY: number,
  fallback = 0,
): number {
  const safeFallback = finiteOr(fallback, 0);
  const safeVelocityX = finiteOr(velocityX, 0);
  const safeVelocityY = finiteOr(velocityY, 0);

  if (Math.hypot(safeVelocityX, safeVelocityY) <= Number.EPSILON) {
    return safeFallback;
  }

  return Math.atan2(-safeVelocityX, safeVelocityY);
}

/** Offsets a scaled tail so its leading point stays on the non-colliding head origin. */
export function cometTailOffsetY(frontY: number, lengthScale: number): number {
  const safeFrontY = Math.max(0, finiteOr(frontY, 0));
  const safeLengthScale = Math.max(0, finiteOr(lengthScale, 0));
  const offset = -safeFrontY * safeLengthScale;
  return offset === 0 ? 0 : offset;
}
