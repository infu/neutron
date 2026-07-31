export interface AutoCombatSystemObservation {
  readonly remoteBombReady: boolean;
  readonly remoteBombActive: boolean;
  readonly remoteBombAgeSeconds: number;
  readonly bombEnemyTargetsInBlast: number;
  readonly bombBossInBlast: boolean;
  readonly availableEnemyTargets: number;
  readonly bossActive: boolean;
  readonly guardianWingReady: boolean;
  readonly guardianWingActive: boolean;
  readonly nearbyProjectileCount: number;
  readonly nearbyRocketCount: number;
}

export interface AutoCombatSystemDecision {
  readonly launchRemoteBomb: boolean;
  readonly detonateRemoteBomb: boolean;
  readonly deployGuardianWing: boolean;
}

function finiteCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Lightweight policy for the two built-in systems that are not part of the
 * expensive route search. An armed bomb is evaluated independently so Auto
 * cannot strand it, while Guardian Wing cycles whenever Full Auto can deploy it.
 */
export function decideAutoCombatSystems(
  observation: AutoCombatSystemObservation,
): AutoCombatSystemDecision {
  const enemiesInBlast = finiteCount(observation.bombEnemyTargetsInBlast);
  const availableEnemies = finiteCount(observation.availableEnemyTargets);
  const bombAge = Number.isFinite(observation.remoteBombAgeSeconds)
    ? Math.max(0, observation.remoteBombAgeSeconds)
    : 0;

  const detonateRemoteBomb = observation.remoteBombActive && (
    observation.bombBossInBlast
    || enemiesInBlast >= 3
    || (enemiesInBlast >= 1 && bombAge >= 3.8)
    || bombAge >= 4.75
  );
  const launchRemoteBomb = !observation.remoteBombActive
    && observation.remoteBombReady
    && (observation.bossActive || availableEnemies >= 4);
  const deployGuardianWing = !observation.guardianWingActive
    && observation.guardianWingReady;

  return Object.freeze({
    launchRemoteBomb,
    detonateRemoteBomb,
    deployGuardianWing,
  });
}
