import {
  createLockedJetAbilityStates,
  decideSpecialAbilities,
  type JetAbilityStates,
} from "./abilities";
import { caveWallClearance, sampleCaveCorridor } from "./cave";

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface BrainBounds {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

/** Numeric cave state needed to predict the moving foreground walls. */
export interface BrainTerrainObservation {
  readonly travelDistance: number;
  readonly scrollSpeed: number;
  readonly sector: number;
}

export type BrainThreatKind = "projectile" | "rocket" | "enemy" | "boss";
export type BrainThreatMotion = "linear" | "homing";
export type BrainStrategyRegime = "evade" | "stabilize" | "recover" | "collect" | "engage";

/**
 * Numeric collision information for a hostile object. The controller never
 * reads renderer objects or future random values.
 */
export interface BrainThreat {
  readonly id: string | number;
  readonly kind: BrainThreatKind;
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly radius: number;
  readonly motion?: BrainThreatMotion;
  /** Seconds for which a homing threat will continue steering. */
  readonly homingSecondsRemaining?: number;
  /** Direction blend per second. Jetcreeper's enemy rockets currently use 0.82. */
  readonly homingStrength?: number;
  /** Ignore a short-lived threat after this many seconds. */
  readonly activeForSeconds?: number;
}

export type BrainTargetKind = "enemy" | "boss";

export type BrainPickupKind = BonusKind;

export interface BrainTarget {
  readonly id: string | number;
  readonly kind: BrainTargetKind;
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly radius: number;
  /** Values above one identify targets worth spending missiles on early. */
  readonly priority?: number;
  /** Remaining hull used only for safe offensive flight-system timing. */
  readonly health?: number;
  /** Explicitly true only while player damage can affect this target. */
  readonly damageable?: boolean;
  /** Explicitly false while the target is outside the rendered combat view. */
  readonly visible?: boolean;
  /** False when forward weapons cannot reach this target from the combat lane. */
  readonly weaponReachable?: boolean;
  /** Damage already assigned to projectiles in flight or another guaranteed strike. */
  readonly committedDamage?: number;
}

/** A collectible crate the controller may pursue after safety planning. */
export interface BrainPickup {
  readonly id: string | number;
  readonly kind: BrainPickupKind;
  readonly position: Vec2;
  readonly velocity?: Vec2;
  readonly radius: number;
  /** General usefulness. Callers may raise this for loadout-aware choices. */
  readonly value?: number;
  /** Additional repair value, normally raised for pulse crates when hurt. */
  readonly healthValue?: number;
  /** Caller-estimated availability in the range 0..1. Zero is not pursued. */
  readonly safety?: number;
}

export interface BrainPlayerObservation {
  readonly position: Vec2;
  readonly velocity: Vec2;
  readonly radius: number;
  readonly maxSpeed: number;
}

export interface BrainAbilityObservation {
  readonly dashReady: boolean;
  readonly lowProfileReady: boolean;
  readonly lowProfileActive: boolean;
  readonly missilesReady: boolean;
  readonly dashSpeedMultiplier?: number;
  readonly dashDurationSeconds?: number;
  readonly lowProfileRadius?: number;
  readonly dashRequested?: boolean;
  readonly lowProfileRequested?: boolean;
  readonly missilesRequested?: boolean;
  readonly specials?: BrainSpecialAbilityObservation;
}

export interface BrainSpecialAbilityObservation {
  readonly states: JetAbilityStates;
  readonly manualCounterflareRequested?: boolean;
  readonly manualGravityKnotRequested?: boolean;
  readonly manualPhoenixSquadronRequested?: boolean;
  readonly nearProjectileCount: number;
  readonly nearRocketCount: number;
  readonly totalProjectileCount: number;
  readonly gravityTargetCount: number;
  readonly bossActive: boolean;
  readonly bossEntering: boolean;
  readonly bossPhase: 1 | 2 | 3;
  readonly bossHealthRatio: number;
  /** False/omitted while entry shields or escort damage gates clamp the boss. */
  readonly bossDamageable?: boolean;
  readonly escortCount: number;
  readonly terminalProgress: number;
  readonly stasisActive: boolean;
  readonly dashBurstActive: boolean;
}

export interface BrainObservation {
  readonly player: BrainPlayerObservation;
  readonly bounds: BrainBounds;
  readonly threats: ReadonlyArray<BrainThreat>;
  readonly targets: ReadonlyArray<BrainTarget>;
  /** Optional for backwards compatibility with observations without crates. */
  readonly pickups?: ReadonlyArray<BrainPickup>;
  /** Optional moving cave state. Omission preserves rectangular-world planning. */
  readonly terrain?: BrainTerrainObservation;
  /** WASD/arrow intent in the range -1..1. It is a preference, not direct control. */
  readonly manualIntent: Vec2;
  readonly abilities: BrainAbilityObservation;
}

export interface SuperBrainConfig {
  readonly planningHorizonSeconds: number;
  readonly simulationStepSeconds: number;
  readonly candidateHeadingCount: number;
  /** Number of safest opening headings expanded into three-step maneuver plans. */
  readonly lookaheadBeamWidth: number;
  /** Radians applied at each future turn in the bounded left/right branches. */
  readonly lookaheadTurnRadians: number;
  /** Adds eight low-speed escape headings only under dense hostile pressure. */
  readonly densePressurePartialSpeedScale: number;
  /** Relative integrated-hazard slack; negative disables the dense filter. */
  readonly densePressureHazardTolerance: number;
  /** Fraction of the best terminal edge clearance reserved after a dodge. */
  readonly densePressureBoundaryReserve: number;
  /** Low-profile is proactive when its exposure falls below this ratio. */
  readonly densePressureLowProfileExposureRatio: number;
  readonly safetyMargin: number;
  /** Safety choices within this fraction of the best clearance may honor input. */
  readonly safeClearanceRatio: number;
  readonly manualIntentAuthority: number;
  readonly emergencyClearance: number;
  readonly defaultDashSpeedMultiplier: number;
  readonly defaultDashDurationSeconds: number;
  readonly defaultLowProfileRadiusScale: number;
  /** Short curved-target prediction used for cannon-lane positioning. */
  readonly targetLeadSeconds: number;
  readonly targetLaneWeight: number;
  readonly missileMinimumTargets: number;
  readonly missilePriorityThreshold: number;
  readonly offensiveLaneAlignmentThreshold: number;
  readonly offensiveDashMinimumTargetHealth: number;
  readonly offensiveLowProfileMinimumAlignedTargets: number;
  readonly offensiveLowProfileMinimumAlignedHealth: number;
  /** Calm-state vertical home position in world coordinates. */
  readonly neutralY: number;
}

export interface BrainDecision {
  /** Desired movement clamped to a maximum magnitude of one. */
  readonly movement: Vec2;
  readonly useDash: boolean;
  readonly useLowProfile: boolean;
  readonly useMissiles: boolean;
  readonly useCounterflare: boolean;
  readonly useGravityKnot: boolean;
  readonly usePhoenixSquadron: boolean;
  readonly survivalSeconds: number;
  readonly predictedClearance: number;
  readonly mode: "cruise" | "dash" | "low-profile";
  /** Survival-first tactical posture chosen before secondary objectives. */
  readonly regime: BrainStrategyRegime;
  /** Current move followed by the two bounded continuation moves it evaluated. */
  readonly plannedMoves: readonly [Vec2, Vec2, Vec2];
  readonly lookaheadUsed: boolean;
  /** The useful crate currently guiding safe movement, if any. */
  readonly pickupTargetId: string | number | null;
}

/** Exact production cadence selected by the bounded combat search (9 / 130s). */
export const SUPER_BRAIN_DECISION_INTERVAL_SECONDS = 9 / 130;

export const DEFAULT_SUPER_BRAIN_CONFIG: Readonly<SuperBrainConfig> = Object.freeze({
  planningHorizonSeconds: 1.5,
  simulationStepSeconds: 0.12,
  candidateHeadingCount: 40,
  lookaheadBeamWidth: 3,
  lookaheadTurnRadians: 0.196,
  densePressurePartialSpeedScale: 0.65,
  densePressureHazardTolerance: 0,
  densePressureBoundaryReserve: 0,
  densePressureLowProfileExposureRatio: 0.72,
  safetyMargin: 0.18,
  safeClearanceRatio: 0.98,
  manualIntentAuthority: 0.3,
  emergencyClearance: 0.62,
  defaultDashSpeedMultiplier: 4,
  defaultDashDurationSeconds: 0.12,
  defaultLowProfileRadiusScale: 0.54,
  targetLeadSeconds: 0.5206,
  targetLaneWeight: 0.0703,
  missileMinimumTargets: 1,
  missilePriorityThreshold: 1.203,
  offensiveLaneAlignmentThreshold: 0.564,
  offensiveDashMinimumTargetHealth: 7.54,
  offensiveLowProfileMinimumAlignedTargets: 1,
  offensiveLowProfileMinimumAlignedHealth: 6.08,
  neutralY: -10.29,
});

interface MutableThreat {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  radius: number;
  motion: BrainThreatMotion;
  homingSecondsRemaining: number;
  homingStrength: number;
  activeForSeconds: number;
}

interface CandidateEvaluation {
  readonly index: number;
  readonly movement: Vec2;
  readonly maneuver: CandidateManeuver;
  readonly lookaheadUsed: boolean;
  readonly survivalSeconds: number;
  readonly minimumClearance: number;
  /** Time-integrated proximity to all hazards; lower preserves escape space. */
  readonly hazardExposure: number;
  readonly terminalBoundaryClearance: number;
  readonly terminalPosition: Vec2;
}

interface CandidateManeuver {
  readonly movements: readonly [Vec2, Vec2, Vec2];
}

interface DecisionContext {
  readonly observation: BrainObservation;
  readonly config: SuperBrainConfig;
  readonly previousMovement: Vec2;
  readonly pickup: SelectedPickup | undefined;
  readonly regime: BrainStrategyRegime;
}

interface SelectedPickup {
  readonly pickup: BrainPickup;
  readonly desirability: number;
}

const EPSILON = 1e-9;
const MIN_TERRAIN_SWEEP_SUBDIVISIONS = 2;
const MAX_TERRAIN_SWEEP_SUBDIVISIONS = 12;
const TERRAIN_DASH_SAMPLE_SPACING = 0.55;
const DENSE_PRESSURE_OFFENSIVE_THREAT_LIMIT = 12;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) {
    return (minimum + maximum) / 2;
  }

  return Math.min(maximum, Math.max(minimum, value));
}

function length(vector: Vec2): number {
  return Math.hypot(vector.x, vector.y);
}

export function normalizeMovement(vector: Vec2): Vec2 {
  const vectorLength = length(vector);

  if (!Number.isFinite(vectorLength) || vectorLength <= EPSILON) {
    return { x: 0, y: 0 };
  }

  return {
    x: vector.x / Math.max(1, vectorLength),
    y: vector.y / Math.max(1, vectorLength),
  };
}

function dot(first: Vec2, second: Vec2): number {
  return first.x * second.x + first.y * second.y;
}

function stableId(id: string | number): string {
  return typeof id === "number" ? `0:${id.toString().padStart(16, "0")}` : `1:${id}`;
}

function targetHealth(target: BrainTarget): number {
  return Math.max(0, finiteOr(target.health ?? 0, 0));
}

function targetUsefulHealth(target: BrainTarget): number {
  const committedDamage = Math.max(0, finiteOr(target.committedDamage ?? 0, 0));
  return Math.max(0, targetHealth(target) - committedDamage);
}

function targetIsDamageable(target: BrainTarget): boolean {
  return target.damageable === true && targetUsefulHealth(target) > EPSILON;
}

function targetIsOffensivelyReachable(target: BrainTarget): boolean {
  return targetIsDamageable(target)
    && target.visible !== false
    && target.weaponReachable !== false;
}

function predictedTargetPosition(target: BrainTarget, config: SuperBrainConfig): Vec2 {
  const leadSeconds = clamp(
    finiteOr(config.targetLeadSeconds, 0.5206),
    0,
    Math.max(0, finiteOr(config.planningHorizonSeconds, 1.675)),
  );
  return {
    x: finiteOr(target.position.x, 0) + finiteOr(target.velocity.x, 0) * leadSeconds,
    y: finiteOr(target.position.y, 0) + finiteOr(target.velocity.y, 0) * leadSeconds,
  };
}

function targetLaneAlignment(
  evaluation: CandidateEvaluation,
  target: BrainTarget,
  config: SuperBrainConfig,
): number {
  const predicted = predictedTargetPosition(target, config);
  const laneRadius = Math.max(0.2, finiteOr(target.radius, 0) + 0.16);
  return 1 - clamp(Math.abs(evaluation.terminalPosition.x - predicted.x) / laneRadius, 0, 1);
}

function primaryTarget(targets: ReadonlyArray<BrainTarget>): BrainTarget | undefined {
  let selected: BrainTarget | undefined;

  for (const target of targets) {
    if (!selected) {
      selected = target;
      continue;
    }

    const priority = finiteOr(target.priority ?? 1, 1);
    const selectedPriority = finiteOr(selected.priority ?? 1, 1);

    if (
      priority > selectedPriority + EPSILON ||
      (Math.abs(priority - selectedPriority) <= EPSILON && stableId(target.id) < stableId(selected.id))
    ) {
      selected = target;
    }
  }

  return selected;
}

function pickupKindBias(kind: BrainPickupKind): number {
  switch (kind) {
    case "pulse":
      return 1.18;
    case "shield":
    case "stasis":
      return 1.1;
    default:
      return 1;
  }
}

function primaryPickup(observation: BrainObservation): SelectedPickup | undefined {
  const pickups = observation.pickups ?? [];
  const worldDiagonal = Math.max(1, Math.hypot(
    observation.bounds.right - observation.bounds.left,
    observation.bounds.top - observation.bounds.bottom,
  ));
  let selected: SelectedPickup | undefined;

  for (const pickup of pickups) {
    const safety = clamp(finiteOr(pickup.safety ?? 1, 1), 0, 1);

    if (safety <= EPSILON) {
      continue;
    }

    const value = clamp(finiteOr(pickup.value ?? 1, 1), 0, 12);
    const healthValue = clamp(finiteOr(pickup.healthValue ?? 0, 0), 0, 12);
    const distance = Math.hypot(
      finiteOr(pickup.position.x, 0) - finiteOr(observation.player.position.x, 0),
      finiteOr(pickup.position.y, 0) - finiteOr(observation.player.position.y, 0),
    );
    // Health is intentionally worth more than another weapon while damaged.
    // Safety and reachability still prevent a valuable crate from dominating
    // a safer, nearby option.
    const utility = (0.4 + value + healthValue * 1.8)
      * pickupKindBias(pickup.kind)
      * safety
      / (1 + distance / worldDiagonal);
    const candidate: SelectedPickup = { pickup, desirability: utility };

    if (
      !selected ||
      candidate.desirability > selected.desirability + EPSILON ||
      (
        Math.abs(candidate.desirability - selected.desirability) <= EPSILON &&
        stableId(candidate.pickup.id) < stableId(selected.pickup.id)
      )
    ) {
      selected = candidate;
    }
  }

  return selected;
}

function candidateMovements(headingCount: number, partialSpeedScale = 0): Vec2[] {
  const safeHeadingCount = Math.max(8, Math.min(48, Math.floor(finiteOr(headingCount, 24))));
  const candidates: Vec2[] = [{ x: 0, y: 0 }];

  for (let index = 0; index < safeHeadingCount; index += 1) {
    const angle = index / safeHeadingCount * Math.PI * 2;
    candidates.push({ x: Math.cos(angle), y: Math.sin(angle) });
  }

  const safePartialScale = clamp(finiteOr(partialSpeedScale, 0), 0, 0.9);
  if (safePartialScale > EPSILON) {
    for (let index = 0; index < 8; index += 1) {
      const angle = (index + 0.5) / 8 * Math.PI * 2;
      candidates.push({
        x: Math.cos(angle) * safePartialScale,
        y: Math.sin(angle) * safePartialScale,
      });
    }
  }

  return candidates;
}

function rotateMovement(movement: Vec2, radians: number): Vec2 {
  const safeRadians = finiteOr(radians, 0);
  const cosine = Math.cos(safeRadians);
  const sine = Math.sin(safeRadians);
  return normalizeMovement({
    x: movement.x * cosine - movement.y * sine,
    y: movement.x * sine + movement.y * cosine,
  });
}

function constantManeuver(movement: Vec2): CandidateManeuver {
  return { movements: [movement, movement, movement] };
}

/**
 * Two bounded continuations turn the safest opening headings into a shallow
 * three-ply model-predictive search. Only the first move is executed; every
 * decision replans the later moves against the newly observed battlefield.
 */
function secondPlyManeuver(
  movement: Vec2,
  direction: -1 | 1,
  turnRadians: number,
): CandidateManeuver {
  const speedScale = clamp(length(movement), 0, 1);

  if (speedScale <= EPSILON) {
    return constantManeuver(movement);
  }

  const firstTurn = rotateMovement(movement, direction * turnRadians);
  return {
    movements: [
      movement,
      { x: firstTurn.x * speedScale, y: firstTurn.y * speedScale },
      { x: firstTurn.x * speedScale, y: firstTurn.y * speedScale },
    ],
  };
}

function thirdPlyManeuver(
  maneuver: CandidateManeuver,
  direction: -1 | 1,
  turnRadians: number,
): CandidateManeuver {
  const secondMovement = maneuver.movements[1];
  const speedScale = clamp(length(secondMovement), 0, 1);
  const thirdTurn = rotateMovement(secondMovement, direction * turnRadians * 0.72);
  return {
    movements: [
      maneuver.movements[0],
      secondMovement,
      { x: thirdTurn.x * speedScale, y: thirdTurn.y * speedScale },
    ],
  };
}

function maneuverMovementAt(
  maneuver: CandidateManeuver,
  elapsedSeconds: number,
  horizonSeconds: number,
): Vec2 {
  const safeHorizon = Math.max(EPSILON, finiteOr(horizonSeconds, 0));
  const progress = clamp(finiteOr(elapsedSeconds, 0) / safeHorizon, 0, 1);
  return progress < 1 / 3
    ? maneuver.movements[0]
    : progress < 2 / 3
      ? maneuver.movements[1]
      : maneuver.movements[2];
}

function copyThreats(threats: ReadonlyArray<BrainThreat>): MutableThreat[] {
  return threats.map((threat) => ({
    x: finiteOr(threat.position.x, 0),
    y: finiteOr(threat.position.y, 0),
    velocityX: finiteOr(threat.velocity.x, 0),
    velocityY: finiteOr(threat.velocity.y, 0),
    radius: Math.max(0, finiteOr(threat.radius, 0)),
    motion: threat.motion === "homing" ? "homing" : "linear",
    homingSecondsRemaining: Math.max(0, finiteOr(threat.homingSecondsRemaining ?? 0, 0)),
    homingStrength: Math.max(0, finiteOr(threat.homingStrength ?? 0.82, 0.82)),
    activeForSeconds: Math.max(0, finiteOr(threat.activeForSeconds ?? Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)),
  }));
}

function playableLimits(bounds: BrainBounds, radius: number): BrainBounds {
  const left = finiteOr(bounds.left, -10);
  const right = finiteOr(bounds.right, 10);
  const bottom = finiteOr(bounds.bottom, -16);
  const top = finiteOr(bounds.top, 16);
  const safeRadius = Math.max(0, finiteOr(radius, 0));

  return {
    left: Math.min(left, right) + safeRadius,
    right: Math.max(left, right) - safeRadius,
    bottom: Math.min(bottom, top) + safeRadius,
    top: Math.max(bottom, top) - safeRadius,
  };
}

function boundaryClearance(position: Vec2, limits: BrainBounds): number {
  return Math.max(0, Math.min(
    position.x - limits.left,
    limits.right - position.x,
    position.y - limits.bottom,
    limits.top - position.y,
  ));
}

interface TerrainSweepEvaluation {
  readonly minimumClearance: number;
  readonly endClearance: number;
  readonly collisionSeconds: number | null;
}

function terrainClearanceAt(
  observation: BrainObservation,
  position: Vec2,
  playerRadius: number,
  elapsedSeconds: number,
  clearanceMargin: number,
): number {
  const terrain = observation.terrain;

  if (!terrain) {
    return Number.POSITIVE_INFINITY;
  }

  const elapsed = Math.max(0, finiteOr(elapsedSeconds, 0));
  const travelDistance = finiteOr(terrain.travelDistance, 0)
    + finiteOr(terrain.scrollSpeed, 0) * elapsed;
  const sample = sampleCaveCorridor(
    travelDistance,
    finiteOr(position.y, 0),
    finiteOr(terrain.sector, 1),
  );
  return caveWallClearance(
    sample,
    finiteOr(position.x, sample.center),
    Math.max(0, finiteOr(playerRadius, 0)),
    Math.max(0, finiteOr(clearanceMargin, 0)),
  );
}

/**
 * Samples both halves of every planning step. Dashes add bounded adaptive
 * subdivisions so their long GPU-visible leap cannot tunnel through a bend.
 */
function evaluateTerrainSweep(
  observation: BrainObservation,
  start: Vec2,
  end: Vec2,
  playerRadius: number,
  startSeconds: number,
  stepSeconds: number,
  dash: boolean,
  startClearance: number,
  clearanceMargin: number,
): TerrainSweepEvaluation {
  if (!observation.terrain) {
    return {
      minimumClearance: Number.POSITIVE_INFINITY,
      endClearance: Number.POSITIVE_INFINITY,
      collisionSeconds: null,
    };
  }

  const pathDistance = Math.hypot(end.x - start.x, end.y - start.y);
  const longitudinalDistance = Math.abs(
    finiteOr(observation.terrain.scrollSpeed, 0) * stepSeconds + end.y - start.y,
  );
  const requestedSubdivisions = dash
    ? Math.ceil(Math.max(pathDistance, longitudinalDistance) / TERRAIN_DASH_SAMPLE_SPACING)
    : MIN_TERRAIN_SWEEP_SUBDIVISIONS;
  // Keep an exact midpoint in addition to both endpoints.
  const adaptiveSubdivisions = requestedSubdivisions % 2 === 0
    ? requestedSubdivisions
    : requestedSubdivisions + 1;
  const subdivisions = Math.max(
    MIN_TERRAIN_SWEEP_SUBDIVISIONS,
    Math.min(MAX_TERRAIN_SWEEP_SUBDIVISIONS, adaptiveSubdivisions),
  );
  let previousClearance = startClearance;
  let minimumClearance = startClearance;
  let collisionSeconds: number | null = previousClearance <= 0 ? startSeconds : null;

  for (let subdivision = 1; subdivision <= subdivisions; subdivision += 1) {
    const ratio = subdivision / subdivisions;
    const position = {
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    };
    const elapsedSeconds = startSeconds + stepSeconds * ratio;
    const clearance = terrainClearanceAt(
      observation,
      position,
      playerRadius,
      elapsedSeconds,
      clearanceMargin,
    );
    minimumClearance = Math.min(minimumClearance, clearance);

    if (collisionSeconds === null && clearance <= 0) {
      const previousRatio = (subdivision - 1) / subdivisions;
      const interpolation = previousClearance > 0 && previousClearance !== clearance
        ? clamp(previousClearance / (previousClearance - clearance), 0, 1)
        : 0;
      collisionSeconds = startSeconds
        + stepSeconds * (previousRatio + interpolation / subdivisions);
    }

    previousClearance = clearance;
  }

  return {
    minimumClearance,
    endClearance: previousClearance,
    collisionSeconds,
  };
}

function advanceThreat(threat: MutableThreat, playerPosition: Vec2, stepSeconds: number): void {
  if (threat.motion === "homing" && threat.homingSecondsRemaining > 0) {
    const speed = Math.hypot(threat.velocityX, threat.velocityY);
    const targetX = playerPosition.x - threat.x;
    const targetY = playerPosition.y - threat.y;
    const targetDistance = Math.hypot(targetX, targetY);

    if (speed > EPSILON && targetDistance > EPSILON) {
      const steering = Math.min(1, stepSeconds * threat.homingStrength);
      const steeredX = threat.velocityX / speed * (1 - steering) + targetX / targetDistance * steering;
      const steeredY = threat.velocityY / speed * (1 - steering) + targetY / targetDistance * steering;
      const steeredLength = Math.hypot(steeredX, steeredY);

      if (steeredLength > EPSILON) {
        threat.velocityX = steeredX / steeredLength * speed;
        threat.velocityY = steeredY / steeredLength * speed;
      }
    }

    threat.homingSecondsRemaining = Math.max(0, threat.homingSecondsRemaining - stepSeconds);
  }

  threat.x += threat.velocityX * stepSeconds;
  threat.y += threat.velocityY * stepSeconds;
}

function collisionEntryRatio(
  relativeStartX: number,
  relativeStartY: number,
  relativeDeltaX: number,
  relativeDeltaY: number,
  collisionRadius: number,
): number | null {
  const constant = relativeStartX * relativeStartX
    + relativeStartY * relativeStartY
    - collisionRadius * collisionRadius;

  if (constant <= 0) {
    return 0;
  }

  const quadratic = relativeDeltaX * relativeDeltaX + relativeDeltaY * relativeDeltaY;

  if (quadratic <= EPSILON) {
    return null;
  }

  const linear = 2 * (relativeStartX * relativeDeltaX + relativeStartY * relativeDeltaY);
  const discriminant = linear * linear - 4 * quadratic * constant;

  if (discriminant < 0) {
    return null;
  }

  const entry = (-linear - Math.sqrt(discriminant)) / (2 * quadratic);
  return entry >= 0 && entry <= 1 ? entry : null;
}

function hazardExposureForStep(
  clearance: number,
  stepSeconds: number,
  config: SuperBrainConfig,
): number {
  if (!Number.isFinite(clearance)) {
    return 0;
  }

  const scale = Math.max(0.2, finiteOr(config.emergencyClearance, 0.62));
  const boundedClearance = clamp(clearance, -scale * 2, scale * 10);
  return Math.exp(-boundedClearance / scale) * Math.max(0, stepSeconds);
}

function evaluateCandidate(
  context: DecisionContext,
  maneuver: CandidateManeuver,
  index: number,
  playerRadius: number,
  dash: boolean,
  evaluationHorizonSeconds?: number,
): CandidateEvaluation {
  const { observation, config } = context;
  const limits = playableLimits(observation.bounds, playerRadius);
  const maximumSpeed = Math.max(0, finiteOr(observation.player.maxSpeed, 0));
  const dashMultiplier = Math.max(1, finiteOr(
    observation.abilities.dashSpeedMultiplier ?? config.defaultDashSpeedMultiplier,
    config.defaultDashSpeedMultiplier,
  ));
  const dashDuration = Math.max(0, finiteOr(
    observation.abilities.dashDurationSeconds ?? config.defaultDashDurationSeconds,
    config.defaultDashDurationSeconds,
  ));
  const stepSeconds = Math.max(0.03, finiteOr(config.simulationStepSeconds, 0.12));
  const maneuverHorizon = Math.max(stepSeconds, finiteOr(config.planningHorizonSeconds, 2.4));
  const horizon = Math.max(
    stepSeconds,
    Math.min(
      maneuverHorizon,
      finiteOr(evaluationHorizonSeconds ?? maneuverHorizon, maneuverHorizon),
    ),
  );
  const sampleCount = Math.max(1, Math.ceil(horizon / stepSeconds));
  const openingMovement = maneuver.movements[0];
  const maneuverChanges = maneuver.movements.slice(1).some((movement) => (
    Math.abs(movement.x - openingMovement.x) > EPSILON
    || Math.abs(movement.y - openingMovement.y) > EPSILON
  ));
  const threats = copyThreats(observation.threats);
  let positionX = clamp(finiteOr(observation.player.position.x, 0), limits.left, limits.right);
  let positionY = clamp(finiteOr(observation.player.position.y, 0), limits.bottom, limits.top);
  let minimumClearance = Number.POSITIVE_INFINITY;
  let hazardExposure = 0;
  let survivalSeconds = horizon;
  let terrainClearance = terrainClearanceAt(
    observation,
    { x: positionX, y: positionY },
    playerRadius,
    0,
    config.safetyMargin,
  );
  minimumClearance = Math.min(minimumClearance, terrainClearance);

  if (terrainClearance <= 0) {
    survivalSeconds = 0;
  }

  for (const threat of threats) {
    const initialClearance = Math.hypot(positionX - threat.x, positionY - threat.y)
      - playerRadius
      - threat.radius
      - config.safetyMargin;
    minimumClearance = Math.min(minimumClearance, initialClearance);

    if (initialClearance <= 0) {
      survivalSeconds = 0;
    }
  }

  for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
    const previousElapsed = (sampleIndex - 1) * stepSeconds;
    const currentStep = Math.min(stepSeconds, horizon - previousElapsed);
    const stepEnd = previousElapsed + currentStep;
    const maneuverBoundaries = maneuverChanges
      ? [maneuverHorizon / 3, maneuverHorizon * 2 / 3]
      : [];
    let segmentElapsed = previousElapsed;

    while (segmentElapsed < stepEnd - EPSILON) {
      let segmentEnd = stepEnd;

      if (dash && dashDuration > segmentElapsed + EPSILON) {
        segmentEnd = Math.min(segmentEnd, dashDuration);
      }

      for (const boundary of maneuverBoundaries) {
        if (boundary > segmentElapsed + EPSILON) {
          segmentEnd = Math.min(segmentEnd, boundary);
        }
      }

      const segmentSeconds = Math.max(0, segmentEnd - segmentElapsed);
      const dashActive = dash && segmentElapsed < dashDuration - EPSILON;
      const movement = maneuverMovementAt(
        maneuver,
        segmentElapsed + Math.min(EPSILON, segmentSeconds * 0.5),
        maneuverHorizon,
      );
      const previousPlayerX = positionX;
      const previousPlayerY = positionY;
      const speed = maximumSpeed * (dashActive ? dashMultiplier : 1);
      positionX = clamp(positionX + movement.x * speed * segmentSeconds, limits.left, limits.right);
      positionY = clamp(positionY + movement.y * speed * segmentSeconds, limits.bottom, limits.top);
      const terrainSweep = evaluateTerrainSweep(
        observation,
        { x: previousPlayerX, y: previousPlayerY },
        { x: positionX, y: positionY },
        playerRadius,
        segmentElapsed,
        segmentSeconds,
        dashActive,
        terrainClearance,
        config.safetyMargin,
      );
      terrainClearance = terrainSweep.endClearance;
      minimumClearance = Math.min(minimumClearance, terrainSweep.minimumClearance);
      hazardExposure += hazardExposureForStep(
        terrainSweep.minimumClearance,
        segmentSeconds,
        config,
      );

      if (terrainSweep.collisionSeconds !== null) {
        survivalSeconds = Math.min(survivalSeconds, terrainSweep.collisionSeconds);
      }

      for (const threat of threats) {
        const previousThreatX = threat.x;
        const previousThreatY = threat.y;
        advanceThreat(threat, { x: positionX, y: positionY }, segmentSeconds);

        if (segmentElapsed > threat.activeForSeconds + EPSILON) {
          continue;
        }

        // Evaluate the closest relative position over this constant-speed
        // segment. Splitting at dash end keeps both projectile and cave sweeps
        // on the exact piecewise-linear route.
        const relativeStartX = previousPlayerX - previousThreatX;
        const relativeStartY = previousPlayerY - previousThreatY;
        const relativeDeltaX = (positionX - previousPlayerX) - (threat.x - previousThreatX);
        const relativeDeltaY = (positionY - previousPlayerY) - (threat.y - previousThreatY);
        const relativeDeltaLengthSquared = relativeDeltaX * relativeDeltaX + relativeDeltaY * relativeDeltaY;
        const closestRatio = relativeDeltaLengthSquared > EPSILON
          ? clamp(
            -(relativeStartX * relativeDeltaX + relativeStartY * relativeDeltaY) / relativeDeltaLengthSquared,
            0,
            1,
          )
          : 0;
        const closestX = relativeStartX + relativeDeltaX * closestRatio;
        const closestY = relativeStartY + relativeDeltaY * closestRatio;
        const collisionRadius = playerRadius + threat.radius + config.safetyMargin;
        const clearance = Math.hypot(closestX, closestY) - collisionRadius;
        minimumClearance = Math.min(minimumClearance, clearance);
        hazardExposure += hazardExposureForStep(clearance, segmentSeconds, config);
        if (clearance <= 0) {
          const entryRatio = collisionEntryRatio(
            relativeStartX,
            relativeStartY,
            relativeDeltaX,
            relativeDeltaY,
            collisionRadius,
          );

          if (entryRatio !== null) {
            survivalSeconds = Math.min(
              survivalSeconds,
              segmentElapsed + entryRatio * segmentSeconds,
            );
          }
        }
      }

      segmentElapsed = segmentEnd;
    }
  }

  const terminalPosition = { x: positionX, y: positionY };

  return {
    index,
    movement: openingMovement,
    maneuver,
    lookaheadUsed: maneuverChanges,
    survivalSeconds,
    minimumClearance,
    hazardExposure,
    terminalBoundaryClearance: boundaryClearance(terminalPosition, limits),
    terminalPosition,
  };
}

function safetyCompare(first: CandidateEvaluation, second: CandidateEvaluation): number {
  if (Math.abs(first.survivalSeconds - second.survivalSeconds) > EPSILON) {
    return first.survivalSeconds > second.survivalSeconds ? 1 : -1;
  }

  if (Math.abs(first.minimumClearance - second.minimumClearance) > EPSILON) {
    return first.minimumClearance > second.minimumClearance ? 1 : -1;
  }

  if (Math.abs(first.hazardExposure - second.hazardExposure) > EPSILON) {
    return first.hazardExposure < second.hazardExposure ? 1 : -1;
  }

  if (Math.abs(first.terminalBoundaryClearance - second.terminalBoundaryClearance) > EPSILON) {
    return first.terminalBoundaryClearance > second.terminalBoundaryClearance ? 1 : -1;
  }

  return second.index - first.index;
}

function selectDiverseSafetyBeam(
  evaluations: ReadonlyArray<CandidateEvaluation>,
  width: number,
  bounds: BrainBounds,
): CandidateEvaluation[] {
  const safeWidth = Math.max(0, Math.min(evaluations.length, Math.floor(finiteOr(width, 0))));

  if (safeWidth === 0) {
    return [];
  }

  const sorted = [...evaluations].sort((first, second) => -safetyCompare(first, second));
  const left = Math.min(finiteOr(bounds.left, -10), finiteOr(bounds.right, 10));
  const right = Math.max(finiteOr(bounds.left, -10), finiteOr(bounds.right, 10));
  const laneWidth = Math.max(EPSILON, (right - left) / 5);
  const selected: CandidateEvaluation[] = [];
  const selectedIndices = new Set<number>();
  const lanes = new Set<number>();

  for (const evaluation of sorted) {
    const lane = Math.min(4, Math.max(0, Math.floor(
      (evaluation.terminalPosition.x - left) / laneWidth,
    )));

    if (lanes.has(lane)) {
      continue;
    }

    lanes.add(lane);
    selected.push(evaluation);
    selectedIndices.add(evaluation.index);
    if (selected.length >= safeWidth) {
      return selected;
    }
  }

  for (const evaluation of sorted) {
    if (selectedIndices.has(evaluation.index)) {
      continue;
    }

    selected.push(evaluation);
    if (selected.length >= safeWidth) {
      break;
    }
  }

  return selected;
}

function safeCandidatePool(
  evaluations: ReadonlyArray<CandidateEvaluation>,
  context: DecisionContext,
): CandidateEvaluation[] {
  const { config } = context;
  let best = evaluations[0];

  for (const evaluation of evaluations.slice(1)) {
    if (best && safetyCompare(evaluation, best) > 0) {
      best = evaluation;
    }
  }

  if (!best) {
    return [];
  }

  const horizon = config.planningHorizonSeconds;
  const hasFullHorizon = evaluations.some((evaluation) => evaluation.survivalSeconds >= horizon - EPSILON);
  const survivalFloor = hasFullHorizon
    ? horizon - EPSILON
    : best.survivalSeconds - config.simulationStepSeconds * 0.25;
  const survivalCandidates = evaluations.filter((evaluation) => evaluation.survivalSeconds >= survivalFloor);
  let bestClearance = Number.NEGATIVE_INFINITY;

  for (const evaluation of survivalCandidates) {
    bestClearance = Math.max(bestClearance, evaluation.minimumClearance);
  }

  const clearanceFloor = Number.isFinite(bestClearance)
    ? bestClearance >= 0
      ? bestClearance * config.safeClearanceRatio
      : bestClearance - config.safetyMargin * 0.25
    : Number.NEGATIVE_INFINITY;

  const clearanceCandidates = survivalCandidates.filter(
    (evaluation) => evaluation.minimumClearance >= clearanceFloor - EPSILON,
  );

  if (context.observation.threats.length <= DENSE_PRESSURE_OFFENSIVE_THREAT_LIMIT) {
    return clearanceCandidates;
  }

  const hazardTolerance = finiteOr(config.densePressureHazardTolerance, 0.32);
  if (hazardTolerance < 0) {
    return clearanceCandidates;
  }

  let bestExposure = Number.POSITIVE_INFINITY;

  for (const evaluation of clearanceCandidates) {
    bestExposure = Math.min(bestExposure, evaluation.hazardExposure);
  }

  // A minimum-clearance score cannot distinguish routes whose closest point
  // is the same threat at t=0. Integrated exposure resolves that dense-volley
  // blind spot while never admitting a lower-survival route.
  const exposureCeiling = Number.isFinite(bestExposure)
    ? bestExposure + Math.max(0.06, bestExposure * Math.max(0, hazardTolerance))
    : Number.POSITIVE_INFINITY;
  const exposureCandidates = clearanceCandidates.filter(
    (evaluation) => evaluation.hazardExposure <= exposureCeiling + EPSILON,
  );
  let bestBoundaryClearance = 0;

  for (const evaluation of exposureCandidates) {
    bestBoundaryClearance = Math.max(
      bestBoundaryClearance,
      evaluation.terminalBoundaryClearance,
    );
  }

  // Repeated full-speed evasions can otherwise select a geometrically safe
  // corner and leave the next decision with no lateral escape. Preserve at
  // least a modest terminal maneuvering pocket whenever a full-horizon route
  // offers one; emergency pools with no room remain untouched.
  const boundaryReserve = clamp(
    finiteOr(config.densePressureBoundaryReserve, 0.58),
    0,
    1,
  );
  const boundaryFloor = Math.min(1.35, bestBoundaryClearance * boundaryReserve);
  return exposureCandidates.filter(
    (evaluation) => evaluation.terminalBoundaryClearance >= boundaryFloor - EPSILON,
  );
}

function strategyRegimeForRoute(
  observation: BrainObservation,
  route: CandidateEvaluation,
  pickup: SelectedPickup | undefined,
  config: SuperBrainConfig,
): BrainStrategyRegime {
  if (
    route.survivalSeconds < config.planningHorizonSeconds - EPSILON
    || route.minimumClearance < config.emergencyClearance
  ) {
    return "evade";
  }

  if (
    observation.threats.length > DENSE_PRESSURE_OFFENSIVE_THREAT_LIMIT
    || route.minimumClearance < config.emergencyClearance * 2.25
  ) {
    return "stabilize";
  }

  if (pickup) {
    return "collect";
  }

  if (observation.targets.some(targetIsOffensivelyReachable)) {
    return "engage";
  }

  return "recover";
}

function pickupPreference(evaluation: CandidateEvaluation, context: DecisionContext): number {
  const selected = context.pickup;

  if (!selected) {
    return 0;
  }

  const { observation, config } = context;
  const pickup = selected.pickup;
  const playerPosition = observation.player.position;
  const velocity = pickup.velocity ?? { x: 0, y: 0 };
  const delta = {
    x: finiteOr(pickup.position.x, 0) - finiteOr(playerPosition.x, 0),
    y: finiteOr(pickup.position.y, 0) - finiteOr(playerPosition.y, 0),
  };
  const distanceNow = length(delta);
  const maximumSpeed = Math.max(EPSILON, finiteOr(observation.player.maxSpeed, 0));
  const interceptSeconds = clamp(
    distanceNow / maximumSpeed,
    Math.max(0.03, config.simulationStepSeconds),
    config.planningHorizonSeconds,
  );
  const limits = playableLimits(observation.bounds, observation.player.radius);
  const playerX = finiteOr(playerPosition.x, 0);
  const playerY = finiteOr(playerPosition.y, 0);
  const predictedPlayer = {
    x: clamp(playerX + evaluation.movement.x * maximumSpeed * interceptSeconds, limits.left, limits.right),
    y: clamp(playerY + evaluation.movement.y * maximumSpeed * interceptSeconds, limits.bottom, limits.top),
  };
  const predictedPickup = {
    x: finiteOr(pickup.position.x, 0) + finiteOr(velocity.x, 0) * interceptSeconds,
    y: finiteOr(pickup.position.y, 0) + finiteOr(velocity.y, 0) * interceptSeconds,
  };
  const distanceAfter = Math.hypot(
    predictedPlayer.x - predictedPickup.x,
    predictedPlayer.y - predictedPickup.y,
  );
  const worldDiagonal = Math.max(1, Math.hypot(
    observation.bounds.right - observation.bounds.left,
    observation.bounds.top - observation.bounds.bottom,
  ));
  const pickupDirection = normalizeMovement(delta);
  const heading = dot(evaluation.movement, pickupDirection);
  const approach = clamp((distanceNow - distanceAfter) / worldDiagonal, -1, 1);
  const captureRadius = Math.max(0, observation.player.radius) + Math.max(0, finiteOr(pickup.radius, 0));
  const arrival = 1 - clamp((distanceAfter - captureRadius) / (worldDiagonal * 0.32), 0, 1);
  const desirabilityScale = clamp(Math.log1p(selected.desirability) / Math.log(5), 0.28, 1.35);

  return (heading * 0.075 + approach * 0.15 + arrival * 0.13) * desirabilityScale;
}

function neutralPreference(evaluation: CandidateEvaluation, context: DecisionContext): number {
  const { observation, config } = context;

  if (
    observation.threats.length > 0
    || observation.targets.some(targetIsOffensivelyReachable)
    || context.pickup
    || length(observation.manualIntent) > EPSILON
  ) {
    return 0;
  }

  const limits = playableLimits(observation.bounds, observation.player.radius);
  const neutralY = clamp(finiteOr(config.neutralY, -8), limits.bottom, limits.top);
  const futureCaveCenter = observation.terrain
    ? sampleCaveCorridor(
      finiteOr(observation.terrain.travelDistance, 0)
        + finiteOr(observation.terrain.scrollSpeed, 0) * config.planningHorizonSeconds,
      neutralY,
      finiteOr(observation.terrain.sector, 1),
    ).center
    : 0;
  const neutral = {
    x: clamp(futureCaveCenter, limits.left, limits.right),
    y: neutralY,
  };
  const playerX = finiteOr(observation.player.position.x, 0);
  const playerY = finiteOr(observation.player.position.y, 0);
  const delta = {
    x: neutral.x - playerX,
    y: neutral.y - playerY,
  };
  const distanceNow = length(delta);

  if (distanceNow <= 1.1) {
    return length(evaluation.movement) <= EPSILON ? 0.06 : 0;
  }

  const maximumSpeed = Math.max(EPSILON, finiteOr(observation.player.maxSpeed, 0));
  const lookAheadSeconds = Math.min(config.planningHorizonSeconds, distanceNow / maximumSpeed);
  const predicted = {
    x: clamp(
      playerX + evaluation.movement.x * maximumSpeed * lookAheadSeconds,
      limits.left,
      limits.right,
    ),
    y: clamp(
      playerY + evaluation.movement.y * maximumSpeed * lookAheadSeconds,
      limits.bottom,
      limits.top,
    ),
  };
  const distanceAfter = Math.hypot(predicted.x - neutral.x, predicted.y - neutral.y);
  const heading = dot(evaluation.movement, normalizeMovement(delta));
  const arrival = 1 - clamp(distanceAfter / Math.max(distanceNow, 1), 0, 1);

  return heading * 0.11 + arrival * 0.15;
}

function evasivePreference(evaluation: CandidateEvaluation, context: DecisionContext): number {
  if (
    context.observation.threats.length === 0
    || !Number.isFinite(evaluation.minimumClearance)
  ) {
    return 0;
  }

  const clearanceScale = Math.max(1, context.config.emergencyClearance * 4);
  return clamp(evaluation.minimumClearance / clearanceScale, -1, 1) * 0.11;
}

function preferenceScore(evaluation: CandidateEvaluation, context: DecisionContext): number {
  const manual = normalizeMovement(context.observation.manualIntent);
  const previous = normalizeMovement(context.previousMovement);
  // Encounter-gated bosses remain in `threats` for collision avoidance, but
  // must not pull the jet into a firing lane until damage can actually land.
  const target = primaryTarget(context.observation.targets.filter(targetIsOffensivelyReachable));
  const worldWidth = Math.max(1, Math.abs(context.observation.bounds.right - context.observation.bounds.left));
  const manualPreference = dot(evaluation.movement, manual) * context.config.manualIntentAuthority;
  const smoothnessPreference = dot(evaluation.movement, previous) * 0.045;
  const boundaryPreference = Math.min(1, evaluation.terminalBoundaryClearance / 3) * 0.035;
  let targetPreference = 0;

  if (target && context.observation.threats.length <= DENSE_PRESSURE_OFFENSIVE_THREAT_LIMIT) {
    const predictedTarget = predictedTargetPosition(target, context.config);
    const predictedTargetX = predictedTarget.x;
    const predictedTargetY = predictedTarget.y;
    const horizontalAlignment = 1 - Math.min(1, Math.abs(evaluation.terminalPosition.x - predictedTargetX) / worldWidth);
    const firingLaneOffset = Math.max(2.4, target.radius + context.observation.player.radius + 1.2);
    const belowTarget = evaluation.terminalPosition.y <= predictedTargetY - firingLaneOffset;
    const verticalAlignment = belowTarget
      ? 1
      : 1 - Math.min(1, (evaluation.terminalPosition.y - predictedTargetY + firingLaneOffset) / 6);
    targetPreference = horizontalAlignment * context.config.targetLaneWeight + verticalAlignment * 0.035;
  }

  return manualPreference
    + smoothnessPreference
    + boundaryPreference
    + targetPreference
    + pickupPreference(evaluation, context)
    + neutralPreference(evaluation, context)
    + evasivePreference(evaluation, context);
}

function selectCandidate(evaluations: ReadonlyArray<CandidateEvaluation>, context: DecisionContext): CandidateEvaluation {
  const pool = safeCandidatePool(evaluations, context);
  let selected = pool[0] ?? evaluations[0];

  if (!selected) {
    return {
      index: 0,
      movement: { x: 0, y: 0 },
      maneuver: constantManeuver({ x: 0, y: 0 }),
      lookaheadUsed: false,
      survivalSeconds: 0,
      minimumClearance: Number.NEGATIVE_INFINITY,
      hazardExposure: Number.POSITIVE_INFINITY,
      terminalBoundaryClearance: 0,
      terminalPosition: context.observation.player.position,
    };
  }

  let selectedPreference = preferenceScore(selected, context);

  for (const evaluation of pool.slice(1)) {
    const preference = preferenceScore(evaluation, context);

    if (
      preference > selectedPreference + EPSILON ||
      (Math.abs(preference - selectedPreference) <= EPSILON && evaluation.index < selected.index)
    ) {
      selected = evaluation;
      selectedPreference = preference;
    }
  }

  return selected;
}

function evaluateMode(
  context: DecisionContext,
  playerRadius: number,
  dash: boolean,
  allowLookahead = false,
): CandidateEvaluation {
  const partialSpeedScale = context.observation.threats.length > DENSE_PRESSURE_OFFENSIVE_THREAT_LIMIT
    ? context.config.densePressurePartialSpeedScale
    : 0;
  const movements = candidateMovements(
    context.config.candidateHeadingCount,
    partialSpeedScale,
  );
  const beamWidth = Math.min(
    movements.length,
    Math.max(0, Math.floor(finiteOr(context.config.lookaheadBeamWidth, 0))),
  );
  const turnRadians = clamp(
    Math.abs(finiteOr(context.config.lookaheadTurnRadians, 0.58)),
    0,
    Math.PI * 0.75,
  );
  const constantEvaluations = movements.map((movement, index) => (
    evaluateCandidate(context, constantManeuver(movement), index, playerRadius, dash)
  ));
  const constantChoice = selectCandidate(constantEvaluations, context);

  if (!allowLookahead || dash || beamWidth === 0 || turnRadians <= EPSILON) {
    return constantChoice;
  }

  const lookaheadNeeded = constantChoice.survivalSeconds
    < Math.min(context.config.planningHorizonSeconds, 0.72);

  if (!lookaheadNeeded) {
    return constantChoice;
  }

  const horizon = Math.max(
    Math.max(0.03, finiteOr(context.config.simulationStepSeconds, 0.12)),
    finiteOr(context.config.planningHorizonSeconds, 1.5),
  );
  let nextIndex = 0;
  const firstPly = movements.map((movement) => evaluateCandidate(
    context,
    constantManeuver(movement),
    nextIndex++,
    playerRadius,
    false,
    horizon / 3,
  ));
  const firstBeam = selectDiverseSafetyBeam(
    firstPly,
    beamWidth,
    context.observation.bounds,
  );
  const secondPly: CandidateEvaluation[] = [];

  for (const opening of firstBeam) {
    const maneuvers = [
      constantManeuver(opening.movement),
      secondPlyManeuver(opening.movement, -1, turnRadians),
      secondPlyManeuver(opening.movement, 1, turnRadians),
    ];

    for (const maneuver of maneuvers) {
      secondPly.push(evaluateCandidate(
        context,
        maneuver,
        nextIndex++,
        playerRadius,
        false,
        horizon * 2 / 3,
      ));
    }
  }

  const secondBeam = selectDiverseSafetyBeam(
    secondPly,
    beamWidth,
    context.observation.bounds,
  );
  const finalPly: CandidateEvaluation[] = [];

  for (const branch of secondBeam) {
    const maneuvers = [
      branch.maneuver,
      thirdPlyManeuver(branch.maneuver, -1, turnRadians),
      thirdPlyManeuver(branch.maneuver, 1, turnRadians),
    ];

    for (const maneuver of maneuvers) {
      finalPly.push(evaluateCandidate(
        context,
        maneuver,
        nextIndex++,
        playerRadius,
        false,
      ));
    }
  }

  const lookaheadChoice = selectCandidate(finalPly, context);
  return lookaheadChoice.survivalSeconds >= context.config.planningHorizonSeconds - EPSILON
    && meaningfullySafer(lookaheadChoice, constantChoice, context.config)
    ? lookaheadChoice
    : constantChoice;
}

function meaningfullySafer(candidate: CandidateEvaluation, current: CandidateEvaluation, config: SuperBrainConfig): boolean {
  if (candidate.survivalSeconds > current.survivalSeconds + config.simulationStepSeconds * 0.5) {
    return true;
  }

  return candidate.survivalSeconds >= current.survivalSeconds - EPSILON
    && candidate.minimumClearance > current.minimumClearance + config.safetyMargin * 0.5;
}

function fullHorizonOffensiveSafety(
  evaluation: CandidateEvaluation,
  config: SuperBrainConfig,
): boolean {
  return evaluation.survivalSeconds >= config.planningHorizonSeconds - EPSILON
    && evaluation.minimumClearance >= config.emergencyClearance - EPSILON;
}

function offensiveLowProfileOpportunity(
  observation: BrainObservation,
  evaluation: CandidateEvaluation,
  config: SuperBrainConfig,
): boolean {
  if (observation.threats.length > DENSE_PRESSURE_OFFENSIVE_THREAT_LIMIT) {
    return false;
  }

  let alignedTargetCount = 0;
  let alignedTargetHealth = 0;

  for (const target of observation.targets) {
    if (
      targetIsOffensivelyReachable(target)
      && targetLaneAlignment(evaluation, target, config) >= config.offensiveLaneAlignmentThreshold
    ) {
      alignedTargetCount += 1;
      alignedTargetHealth += targetUsefulHealth(target);
    }
  }

  return alignedTargetCount >= Math.max(1, Math.ceil(config.offensiveLowProfileMinimumAlignedTargets))
    && alignedTargetHealth >= config.offensiveLowProfileMinimumAlignedHealth;
}

function highValueMissileSituation(
  observation: BrainObservation,
  urgent: boolean,
  config: SuperBrainConfig,
): boolean {
  const damageableTargets = observation.targets.filter(targetIsDamageable);

  if (damageableTargets.length === 0) {
    return false;
  }

  if (urgent) {
    return true;
  }

  return damageableTargets.length >= Math.max(1, Math.ceil(config.missileMinimumTargets))
    && damageableTargets.some((target) => (
      finiteOr(target.priority ?? 1, 1) >= config.missilePriorityThreshold
    ));
}

function resolvedConfig(configOverrides: Partial<SuperBrainConfig>): SuperBrainConfig {
  return {
    ...DEFAULT_SUPER_BRAIN_CONFIG,
    ...configOverrides,
  };
}

function baseDecisionContext(
  observation: BrainObservation,
  previousMovement: Vec2,
  config: SuperBrainConfig,
): DecisionContext {
  const pickup = primaryPickup(observation);
  return {
    observation,
    config,
    previousMovement,
    pickup,
    regime: "recover",
  };
}

function decisionContext(
  observation: BrainObservation,
  previousMovement: Vec2,
  config: SuperBrainConfig,
  regimeOverride?: BrainStrategyRegime,
): DecisionContext {
  const provisional = baseDecisionContext(observation, previousMovement, config);
  const routeMovement = length(previousMovement) > EPSILON
    ? normalizeMovement(previousMovement)
    : normalizeMovement(observation.manualIntent);
  const route = evaluateCandidate(
    provisional,
    constantManeuver(routeMovement),
    -1,
    Math.max(0.05, finiteOr(observation.player.radius, 0.78)),
    false,
  );
  const measuredRegime = strategyRegimeForRoute(
    observation,
    route,
    provisional.pickup,
    config,
  );
  return {
    ...provisional,
    regime: measuredRegime === "evade" ? "evade" : regimeOverride ?? measuredRegime,
  };
}

export interface BrainRouteAssessment {
  readonly survivalSeconds: number;
  readonly predictedClearance: number;
  readonly hazardExposure: number;
  readonly terminalBoundaryClearance: number;
}

/** Exact production-physics viability for a requested constant heading. */
export function assessSuperBrainRoute(
  observation: BrainObservation,
  movement: Vec2,
  configOverrides: Partial<SuperBrainConfig> = {},
): BrainRouteAssessment {
  const config = resolvedConfig(configOverrides);
  const context = baseDecisionContext(observation, movement, config);
  const evaluation = evaluateCandidate(
    context,
    constantManeuver(normalizeMovement(movement)),
    -1,
    Math.max(0.05, finiteOr(observation.player.radius, 0.78)),
    false,
  );
  return {
    survivalSeconds: evaluation.survivalSeconds,
    predictedClearance: evaluation.minimumClearance,
    hazardExposure: evaluation.hazardExposure,
    terminalBoundaryClearance: evaluation.terminalBoundaryClearance,
  };
}

/** Pure decision helper. Pass the prior decision's movement to add hysteresis. */
export function decideSuperBrain(
  observation: BrainObservation,
  previousMovement: Vec2 = { x: 0, y: 0 },
  configOverrides: Partial<SuperBrainConfig> = {},
  regimeOverride?: BrainStrategyRegime,
): BrainDecision {
  const config = resolvedConfig(configOverrides);
  const context = decisionContext(observation, previousMovement, config, regimeOverride);
  const playerRadius = Math.max(0.05, finiteOr(observation.player.radius, 0.78));
  const cruise = evaluateMode(
    context,
    playerRadius,
    false,
    observation.threats.length > 0,
  );
  let chosen = cruise;
  let mode: BrainDecision["mode"] = "cruise";
  const cruiseUrgent = cruise.survivalSeconds < config.planningHorizonSeconds - EPSILON
    || cruise.minimumClearance < config.emergencyClearance;

  if (observation.abilities.lowProfileReady && !observation.abilities.lowProfileActive) {
    const lowProfileRadius = Math.max(0.05, Math.min(playerRadius, finiteOr(
      observation.abilities.lowProfileRadius ?? playerRadius * config.defaultLowProfileRadiusScale,
      playerRadius * config.defaultLowProfileRadiusScale,
    )));
    const lowProfile = evaluateMode(context, lowProfileRadius, false);
    const requestedAndSafe = observation.abilities.lowProfileRequested === true
      && lowProfile.survivalSeconds >= config.planningHorizonSeconds - EPSILON;
    const offensiveAndSafe = fullHorizonOffensiveSafety(lowProfile, config)
      && offensiveLowProfileOpportunity(observation, lowProfile, config);
    const denseExposureRatio = clamp(
      finiteOr(config.densePressureLowProfileExposureRatio, 0.72),
      0,
      1,
    );
    const denseDefenseOpportunity = denseExposureRatio > 0
      && observation.threats.length > DENSE_PRESSURE_OFFENSIVE_THREAT_LIMIT
      && lowProfile.survivalSeconds >= cruise.survivalSeconds - EPSILON
      && lowProfile.minimumClearance >= Math.min(0, cruise.minimumClearance)
      && lowProfile.hazardExposure < cruise.hazardExposure * denseExposureRatio;

    if (
      requestedAndSafe
      || (cruiseUrgent && meaningfullySafer(lowProfile, chosen, config))
      || denseDefenseOpportunity
      || offensiveAndSafe
    ) {
      chosen = lowProfile;
      mode = "low-profile";
    }
  }

  if (observation.abilities.dashReady) {
    const dash = evaluateMode(context, playerRadius, true);
    const requestedAndSafe = observation.abilities.dashRequested === true
      && dash.survivalSeconds >= config.planningHorizonSeconds - EPSILON
      && dash.minimumClearance >= Math.min(0, cruise.minimumClearance)
      && length(dash.movement) > EPSILON;

    if (
      requestedAndSafe
      || (cruiseUrgent && meaningfullySafer(dash, chosen, config))
    ) {
      chosen = dash;
      mode = "dash";
    }
  }

  const urgent = chosen.survivalSeconds < config.planningHorizonSeconds - EPSILON
    || chosen.minimumClearance < config.emergencyClearance;
  const measuredRegime = strategyRegimeForRoute(observation, chosen, context.pickup, config);
  const regime = measuredRegime === "evade"
    ? "evade"
    : regimeOverride ?? measuredRegime;
  const useMissiles = observation.abilities.missilesReady
    && (
      observation.abilities.missilesRequested === true
      || highValueMissileSituation(observation, urgent, config)
    )
    && observation.targets.length > 0;
  const specials = observation.abilities.specials;
  const damageableTargets = observation.targets.filter(targetIsDamageable);
  const highValueTargetCount = damageableTargets.filter((target) => (
    finiteOr(target.priority ?? 1, 1) >= config.missilePriorityThreshold
  )).length;
  const specialDecision = decideSpecialAbilities({
    abilities: specials?.states ?? createLockedJetAbilityStates(),
    manualCounterflareRequested: specials?.manualCounterflareRequested ?? false,
    manualGravityKnotRequested: specials?.manualGravityKnotRequested ?? false,
    manualPhoenixSquadronRequested: specials?.manualPhoenixSquadronRequested ?? false,
    nearProjectileCount: specials?.nearProjectileCount ?? 0,
    nearRocketCount: specials?.nearRocketCount ?? 0,
    totalProjectileCount: specials?.totalProjectileCount ?? 0,
    targetCount: observation.targets.length,
    gravityTargetCount: specials?.gravityTargetCount ?? 0,
    bossActive: specials?.bossActive ?? false,
    bossEntering: specials?.bossEntering ?? false,
    bossPhase: specials?.bossPhase ?? 1,
    bossHealthRatio: specials?.bossHealthRatio ?? 1,
    bossDamageable: specials?.bossDamageable ?? false,
    escortCount: specials?.escortCount ?? 0,
    damageableTargetCount: damageableTargets.length,
    highValueTargetCount,
    terminalProgress: specials?.terminalProgress ?? 0,
    survivalSeconds: chosen.survivalSeconds,
    predictedClearance: chosen.minimumClearance,
    planningHorizonSeconds: config.planningHorizonSeconds,
    offensiveClearanceFloor: config.emergencyClearance,
    stasisActive: specials?.stasisActive ?? false,
    dashBurstActive: specials?.dashBurstActive ?? false,
  });

  return {
    movement: normalizeMovement(chosen.movement),
    useDash: mode === "dash",
    useLowProfile: mode === "low-profile",
    useMissiles,
    ...specialDecision,
    survivalSeconds: chosen.survivalSeconds,
    predictedClearance: chosen.minimumClearance,
    mode,
    regime,
    plannedMoves: chosen.maneuver.movements,
    lookaheadUsed: chosen.lookaheadUsed,
    pickupTargetId: context.pickup?.pickup.id ?? null,
  };
}

export class SuperBrainController {
  private previousMovement: Vec2 = { x: 0, y: 0 };
  private regime: BrainStrategyRegime = "recover";
  private stabilizationDecisionsRemaining = 0;
  private readonly config: Partial<SuperBrainConfig>;

  public constructor(config: Partial<SuperBrainConfig> = {}) {
    this.config = { ...config };
  }

  public decide(observation: BrainObservation): BrainDecision {
    const stabilizationOverride = this.regime === "evade"
      || this.stabilizationDecisionsRemaining > 0
      ? "stabilize"
      : undefined;
    const decision = decideSuperBrain(
      observation,
      this.previousMovement,
      this.config,
      stabilizationOverride,
    );
    // Replanning stays reactive, while the predicted second leg supplies
    // hysteresis so a safe S-turn is not abandoned one tick after choosing it.
    this.previousMovement = decision.plannedMoves[1];

    if (decision.regime === "evade") {
      this.regime = "evade";
      this.stabilizationDecisionsRemaining = 0;
    } else if (this.regime === "evade") {
      this.regime = "stabilize";
      this.stabilizationDecisionsRemaining = 3;
    } else if (this.stabilizationDecisionsRemaining > 0) {
      this.regime = "stabilize";
      this.stabilizationDecisionsRemaining -= 1;
    } else {
      this.regime = decision.regime;
    }

    return decision;
  }

  public reset(): void {
    this.previousMovement = { x: 0, y: 0 };
    this.regime = "recover";
    this.stabilizationDecisionsRemaining = 0;
  }
}
import type { BonusKind } from "./game_rules";
