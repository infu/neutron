export const REMOTE_BOMB_DAMAGE_MULTIPLIER = 270;
export const REMOTE_BOMB_BLAST_RADIUS = 15.4;
export const REMOTE_BOMB_LAUNCH_SPEED = 24;
export const REMOTE_BOMB_FORWARD_DISTANCE = 10;
export const REMOTE_BOMB_MAX_ARMED_SECONDS = 5;

export function remoteBombDamage(normalDamage: number): number {
  return (Number.isFinite(normalDamage) ? Math.max(0, normalDamage) : 0)
    * REMOTE_BOMB_DAMAGE_MULTIPLIER;
}

export function insideRemoteBombBlast(
  blastX: number,
  blastY: number,
  targetX: number,
  targetY: number,
  targetRadius = 0,
): boolean {
  const safeTargetRadius = Number.isFinite(targetRadius) ? Math.max(0, targetRadius) : 0;
  return Math.hypot(targetX - blastX, targetY - blastY)
    <= REMOTE_BOMB_BLAST_RADIUS + safeTargetRadius;
}
