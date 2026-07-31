const EPSILON = 1e-9;

export interface ProtectedCraftObservation {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly radius: number;
}

export interface CountermeasureWingObservation {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly ready: boolean;
}

export interface HostileProjectileObservation {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly velocityX: number;
  readonly velocityY: number;
  readonly radius: number;
  readonly rocket: boolean;
}

export interface WingmanCountermeasureObservation {
  readonly protectedCraft: readonly ProtectedCraftObservation[];
  readonly wings: readonly CountermeasureWingObservation[];
  readonly projectiles: readonly HostileProjectileObservation[];
  readonly responseRadius: number;
  readonly collisionHorizonSeconds: number;
}

export interface WingmanCountermeasureAssignment {
  readonly wingId: number;
  readonly projectileId: number;
  readonly protectedCraftId: number;
  readonly collisionSeconds: number | null;
  readonly distance: number;
}

interface ProjectileThreat {
  readonly projectile: HostileProjectileObservation;
  readonly protectedCraftId: number;
  readonly collisionSeconds: number | null;
  readonly closestClearance: number;
  readonly currentDistance: number;
}

interface CandidateAssignment extends WingmanCountermeasureAssignment {
  readonly rocket: boolean;
}

function finiteObservation(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

function compareNumber(first: number, second: number): number {
  if (Math.abs(first - second) <= EPSILON) {
    return 0;
  }

  return first < second ? -1 : 1;
}

function compareThreatCraft(first: ProjectileThreat, second: ProjectileThreat): number {
  const firstCollides = first.collisionSeconds !== null;
  const secondCollides = second.collisionSeconds !== null;

  if (firstCollides !== secondCollides) {
    return firstCollides ? -1 : 1;
  }

  if (first.collisionSeconds !== null && second.collisionSeconds !== null) {
    const collisionOrder = compareNumber(first.collisionSeconds, second.collisionSeconds);
    if (collisionOrder !== 0) return collisionOrder;
  }

  const clearanceOrder = compareNumber(first.closestClearance, second.closestClearance);
  if (clearanceOrder !== 0) return clearanceOrder;

  const distanceOrder = compareNumber(first.currentDistance, second.currentDistance);
  if (distanceOrder !== 0) return distanceOrder;

  return compareNumber(first.protectedCraftId, second.protectedCraftId);
}

function collisionSeconds(
  relativeX: number,
  relativeY: number,
  relativeVelocityX: number,
  relativeVelocityY: number,
  combinedRadius: number,
  horizonSeconds: number,
): number | null {
  const distanceSquared = relativeX * relativeX + relativeY * relativeY;
  const radiusSquared = combinedRadius * combinedRadius;

  if (distanceSquared <= radiusSquared + EPSILON) {
    return 0;
  }

  const speedSquared = relativeVelocityX * relativeVelocityX
    + relativeVelocityY * relativeVelocityY;
  const closingDot = relativeX * relativeVelocityX + relativeY * relativeVelocityY;
  const linear = 2 * closingDot;
  const constant = distanceSquared - radiusSquared;
  const discriminant = linear * linear - 4 * speedSquared * constant;

  if (discriminant < 0) {
    return null;
  }

  const entrySeconds = (-linear - Math.sqrt(discriminant)) / (2 * speedSquared);
  return entrySeconds >= -EPSILON && entrySeconds <= horizonSeconds + EPSILON
    ? Math.max(0, entrySeconds)
    : null;
}

function projectileThreat(
  projectile: HostileProjectileObservation,
  protectedCraft: readonly ProtectedCraftObservation[],
  collisionHorizonSeconds: number,
): ProjectileThreat | null {
  if (!finiteObservation([
    projectile.id,
    projectile.x,
    projectile.y,
    projectile.velocityX,
    projectile.velocityY,
    projectile.radius,
  ])) {
    return null;
  }

  let bestThreat: ProjectileThreat | null = null;

  for (const craft of protectedCraft) {
    if (!finiteObservation([
      craft.id,
      craft.x,
      craft.y,
      craft.velocityX,
      craft.velocityY,
      craft.radius,
    ])) {
      continue;
    }

    const relativeX = projectile.x - craft.x;
    const relativeY = projectile.y - craft.y;
    const relativeVelocityX = projectile.velocityX - craft.velocityX;
    const relativeVelocityY = projectile.velocityY - craft.velocityY;
    const speedSquared = relativeVelocityX * relativeVelocityX
      + relativeVelocityY * relativeVelocityY;
    const closingDot = relativeX * relativeVelocityX + relativeY * relativeVelocityY;

    // Only projectiles whose relative motion is reducing separation are useful
    // countermeasure targets. Static and receding clutter stays untouched.
    if (speedSquared <= EPSILON || closingDot >= -EPSILON) {
      continue;
    }

    const closestSeconds = Math.min(
      collisionHorizonSeconds,
      Math.max(0, -closingDot / speedSquared),
    );
    const closestX = relativeX + relativeVelocityX * closestSeconds;
    const closestY = relativeY + relativeVelocityY * closestSeconds;
    const combinedRadius = Math.max(0, projectile.radius) + Math.max(0, craft.radius);
    const currentDistance = Math.hypot(relativeX, relativeY);
    const threat: ProjectileThreat = {
      projectile,
      protectedCraftId: craft.id,
      collisionSeconds: collisionSeconds(
        relativeX,
        relativeY,
        relativeVelocityX,
        relativeVelocityY,
        combinedRadius,
        collisionHorizonSeconds,
      ),
      closestClearance: Math.hypot(closestX, closestY) - combinedRadius,
      currentDistance,
    };

    if (bestThreat === null || compareThreatCraft(threat, bestThreat) < 0) {
      bestThreat = threat;
    }
  }

  return bestThreat;
}

function compareCandidate(first: CandidateAssignment, second: CandidateAssignment): number {
  const firstCollides = first.collisionSeconds !== null;
  const secondCollides = second.collisionSeconds !== null;

  if (firstCollides !== secondCollides) {
    return firstCollides ? -1 : 1;
  }

  if (first.collisionSeconds !== null && second.collisionSeconds !== null) {
    const collisionOrder = compareNumber(first.collisionSeconds, second.collisionSeconds);
    if (collisionOrder !== 0) return collisionOrder;
  }

  if (first.rocket !== second.rocket) {
    return first.rocket ? -1 : 1;
  }

  const distanceOrder = compareNumber(first.distance, second.distance);
  if (distanceOrder !== 0) return distanceOrder;

  const projectileOrder = compareNumber(first.projectileId, second.projectileId);
  if (projectileOrder !== 0) return projectileOrder;

  return compareNumber(first.wingId, second.wingId);
}

/**
 * Assigns at most one unique incoming projectile to each ready wing. Results
 * are returned in threat-priority order and do not depend on input ordering.
 */
export function selectWingmanCountermeasures(
  observation: WingmanCountermeasureObservation,
): readonly WingmanCountermeasureAssignment[] {
  const responseRadius = Number.isFinite(observation.responseRadius)
    ? Math.max(0, observation.responseRadius)
    : 0;
  const collisionHorizonSeconds = Number.isFinite(observation.collisionHorizonSeconds)
    ? Math.max(0, observation.collisionHorizonSeconds)
    : 0;

  if (responseRadius <= EPSILON || observation.protectedCraft.length === 0) {
    return [];
  }

  const readyWings = observation.wings.filter((wing) => (
    wing.ready && finiteObservation([wing.id, wing.x, wing.y])
  ));

  if (readyWings.length === 0) {
    return [];
  }

  const threats = observation.projectiles
    .map((projectile) => projectileThreat(
      projectile,
      observation.protectedCraft,
      collisionHorizonSeconds,
    ))
    .filter((threat): threat is ProjectileThreat => threat !== null);
  const candidates: CandidateAssignment[] = [];

  for (const threat of threats) {
    for (const wing of readyWings) {
      const distance = Math.hypot(
        threat.projectile.x - wing.x,
        threat.projectile.y - wing.y,
      );

      if (distance > responseRadius + EPSILON) {
        continue;
      }

      candidates.push({
        wingId: wing.id,
        projectileId: threat.projectile.id,
        protectedCraftId: threat.protectedCraftId,
        collisionSeconds: threat.collisionSeconds,
        distance,
        rocket: threat.projectile.rocket,
      });
    }
  }

  candidates.sort(compareCandidate);

  const usedWings = new Set<number>();
  const usedProjectiles = new Set<number>();
  const assignments: WingmanCountermeasureAssignment[] = [];

  for (const candidate of candidates) {
    if (usedWings.has(candidate.wingId) || usedProjectiles.has(candidate.projectileId)) {
      continue;
    }

    usedWings.add(candidate.wingId);
    usedProjectiles.add(candidate.projectileId);
    assignments.push({
      wingId: candidate.wingId,
      projectileId: candidate.projectileId,
      protectedCraftId: candidate.protectedCraftId,
      collisionSeconds: candidate.collisionSeconds,
      distance: candidate.distance,
    });

    if (usedWings.size >= readyWings.length) {
      break;
    }
  }

  return assignments;
}
