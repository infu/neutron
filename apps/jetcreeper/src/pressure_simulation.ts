import {
  JET_ABILITY_KINDS,
  JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS,
  activateJetAbility,
  tickJetAbilityState,
  type JetAbilityKind,
  type JetAbilityStates,
} from "./abilities";
import {
  DEFAULT_SUPER_BRAIN_CONFIG,
  SUPER_BRAIN_DECISION_INTERVAL_SECONDS,
  SuperBrainController,
  decideSuperBrain,
  type BrainObservation,
  type SuperBrainConfig,
  type BrainTarget,
  type BrainThreat,
  type Vec2,
} from "./autopilot";
import {
  ENEMY_PRESSURE_TUNING,
  brainPressureAdmissionThresholds,
  clampNumber,
  difficultyForSector,
  isTerminalPressureUnbounded,
  movingCirclesOverlap,
  resolveEnemyPressureTuning,
  scaledEnemyVolleyCount,
  unsafeRouteAdmissionChance,
  type Difficulty,
  type EnemyPressureTuning,
} from "./game_rules";

export const PRESSURE_THREAT_PATTERNS = Object.freeze([
  "aimed-bolt",
  "cross-lane-spread",
  "homing-rocket",
  "closing-projectile",
] as const);

export type PressureThreatPattern = typeof PRESSURE_THREAT_PATTERNS[number];

export const PRESSURE_RESOURCES = Object.freeze([
  "dash",
  "low-profile",
  "counterflare",
  "gravity-knot",
  "phoenix-squadron",
] as const);

export type PressureResource = typeof PRESSURE_RESOURCES[number];
export type PressureAdmissionMode = "adversarial" | "runtime";

export interface PressureSimulationOptions {
  readonly sector: number;
  readonly seed: number;
  /** Six seconds is long enough to resolve all three life-loss grace windows. */
  readonly durationSeconds?: number;
  /** Measurement-only planner overrides; production defaults remain untouched. */
  readonly brainConfig?: Partial<SuperBrainConfig>;
  /** Runtime mode mirrors the global brain safety gate; adversarial omits it. */
  readonly admissionMode?: PressureAdmissionMode;
  /** Measurement-only replan cadence; omitted values use the production cadence. */
  readonly decisionStepSeconds?: number;
  /** Measurement-only hostile profile; omitted values use production tuning. */
  readonly hostileTuning?: Partial<EnemyPressureTuning>;
}

export interface PressureSimulationResult {
  readonly sector: number;
  readonly seed: number;
  readonly admissionMode: PressureAdmissionMode;
  readonly requestedDurationSeconds: number;
  readonly simulatedSeconds: number;
  readonly survivedSeconds: number;
  readonly gameOver: boolean;
  readonly damageTaken: number;
  readonly collisions: number;
  readonly invulnerabilityCollisions: number;
  readonly livesRemaining: number;
  readonly firstDamageSeconds: number | null;
  readonly minimumPredictedSurvivalSeconds: number;
  readonly minimumPredictedClearance: number;
  readonly pressuredDecisions: number;
  readonly decisionCount: number;
  readonly attemptedByPattern: Readonly<Record<PressureThreatPattern, number>>;
  readonly spawnedByPattern: Readonly<Record<PressureThreatPattern, number>>;
  readonly rejectedForFairness: number;
  readonly rejectedForProjectileCap: number;
  readonly rejectedForRocketCap: number;
  readonly rejectedForGlobalPressureGate: number;
  readonly peakConcurrentThreats: number;
  readonly peakConcurrentRockets: number;
  readonly resourceUses: Readonly<Record<PressureResource, number>>;
  /** Completed uses that produced no modeled defensive benefit. */
  readonly resourceWaste: Readonly<Record<PressureResource, number>>;
  /** Active effects whose benefit window had not completed when measurement stopped. */
  readonly unresolvedResourceWindows: Readonly<Record<PressureResource, number>>;
  readonly threatsClearedByResource: Readonly<Record<PressureResource, number>>;
  readonly determinismHash: number;
}

interface MutablePressureThreat {
  readonly id: number;
  readonly pattern: PressureThreatPattern;
  readonly kind: "projectile" | "rocket";
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  readonly radius: number;
  homingSecondsRemaining: number;
}

interface SpecialBenefitWindow {
  benefitCount: number;
  open: boolean;
}

const BOUNDS = Object.freeze({ left: -10, right: 10, bottom: -16, top: 16 });
const PLAYER_START_Y = -12.4;
const PLAYER_SPEED = 11.5;
const NORMAL_RADIUS = 0.78;
const PLANNING_RADIUS = 1.2;
const LOW_PROFILE_RADIUS = 0.42;
const LOW_PROFILE_SECONDS = 1.35;
const LOW_PROFILE_COOLDOWN_SECONDS = 5.5;
const DASH_SECONDS = 0.38;
const DASH_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS.dash;
const DASH_SPEED_MULTIPLIER = 4;
const DASH_BURST_SECONDS = 1;
/** 20 ms keeps collision measurement finer than every tested replan cadence. */
const PHYSICS_STEP_SECONDS = 0.02;
const COUNTERFLARE_RADIUS = 5.7;
const COUNTERFLARE_CONVERSION_CAP = 12;
const GRAVITY_KNOT_RADIUS = 3.8;
const GRAVITY_KNOT_OFFSET_Y = 5.2;
const PHOENIX_LANE_RADIUS = 1.8;
const PHOENIX_STRIKE_INTERVAL_SECONDS = 0.68;
const PHOENIX_STRIKE_CAP = 8;
const LIFE_LOSS_GRACE_SECONDS = 1.55;
const EPSILON = 1e-9;

function emptyPatternCounts(): Record<PressureThreatPattern, number> {
  return {
    "aimed-bolt": 0,
    "cross-lane-spread": 0,
    "homing-rocket": 0,
    "closing-projectile": 0,
  };
}

function emptyResourceCounts(): Record<PressureResource, number> {
  return {
    dash: 0,
    "low-profile": 0,
    counterflare: 0,
    "gravity-knot": 0,
    "phoenix-squadron": 0,
  };
}

function unlockedAbilityStates(): JetAbilityStates {
  return {
    counterflare: { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
    "gravity-knot": { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
    "phoenix-squadron": { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function normalize(x: number, y: number): Vec2 {
  const vectorLength = Math.hypot(x, y);
  return vectorLength > EPSILON
    ? { x: x / vectorLength, y: y / vectorLength }
    : { x: 0, y: -1 };
}

function hashNumber(hash: number, value: number): number {
  const finiteValue = Number.isFinite(value) ? value : value > 0 ? 1_000_000 : -1_000_000;
  return Math.imul(hash ^ Math.round(finiteValue * 1_000), 16_777_619) >>> 0;
}

function asBrainThreat(
  threat: MutablePressureThreat,
  tuning: Readonly<EnemyPressureTuning>,
): BrainThreat {
  const shared = {
    id: threat.id,
    kind: threat.kind,
    position: { x: threat.x, y: threat.y },
    velocity: { x: threat.velocityX, y: threat.velocityY },
    radius: threat.radius,
  } as const;

  return threat.kind === "rocket"
    ? {
      ...shared,
      motion: "homing",
      homingSecondsRemaining: threat.homingSecondsRemaining,
      homingStrength: tuning.rocketHomingStrength,
    }
    : shared;
}

function targetFixtures(difficulty: Difficulty): BrainTarget[] {
  const bossActive = difficulty.sector >= 5 && difficulty.sector % 5 === 0;
  const targetCount = Math.min(12, Math.max(1, difficulty.maxFormationSize + 2));
  const targets: BrainTarget[] = [];

  for (let index = 0; index < targetCount; index += 1) {
    const boss = bossActive && index === 0;
    targets.push({
      id: boss ? "pressure-boss" : `pressure-emitter-${index}`,
      kind: boss ? "boss" : "enemy",
      position: {
        x: boss ? 0 : ((index * 5.3) % 17) - 8.5,
        y: boss ? 10.2 : -3.2 + index % 3 * 4.1,
      },
      velocity: { x: 0, y: 0 },
      radius: boss ? 2.6 : 0.72,
      priority: boss ? 6 : 1 + index % 4,
      health: boss
        ? Math.max(8, difficulty.enemyHealthScale * 20)
        : Math.max(1, difficulty.enemyHealthScale * (1 + index % 4)),
      damageable: true,
    });
  }

  return targets;
}

function projectedPressureCounts(
  threats: ReadonlyArray<MutablePressureThreat>,
  player: Vec2,
  playerVelocity: Vec2,
  playerRadius: number,
): { nearProjectileCount: number; nearRocketCount: number } {
  let nearProjectileCount = 0;
  let nearRocketCount = 0;

  for (const threat of threats) {
    const relativeX = threat.x - player.x;
    const relativeY = threat.y - player.y;
    const relativeVelocityX = threat.velocityX - playerVelocity.x;
    const relativeVelocityY = threat.velocityY - playerVelocity.y;
    const speedSquared = relativeVelocityX ** 2 + relativeVelocityY ** 2;
    const closingDot = relativeX * relativeVelocityX + relativeY * relativeVelocityY;
    const closestSeconds = speedSquared > 0.001
      ? clampNumber(-closingDot / speedSquared, 0, 0.7)
      : 0;
    const projectedDistance = Math.hypot(
      relativeX + relativeVelocityX * closestSeconds,
      relativeY + relativeVelocityY * closestSeconds,
    );

    if (
      closingDot < 0
      && projectedDistance <= playerRadius + threat.radius + 1.05
    ) {
      nearProjectileCount += 1;
      if (threat.kind === "rocket") {
        nearRocketCount += 1;
      }
    }
  }

  return { nearProjectileCount, nearRocketCount };
}

/**
 * Mirrors the runtime's bounded pre-terminal spawn admission. Only terminal
 * sector 200 turns the safety valve fully off; unsafe fallback admission ramps
 * from 88% progress through the final approach.
 */
function leavesEscapeRoute(
  difficulty: Difficulty,
  candidate: MutablePressureThreat,
  existingThreats: ReadonlyArray<MutablePressureThreat>,
  player: Vec2,
  playerRadius: number,
  random: () => number,
): boolean {
  if (isTerminalPressureUnbounded(difficulty.terminalProgress)) {
    return true;
  }

  const projectileSpeed = Math.hypot(candidate.velocityX, candidate.velocityY);
  const distanceToPlayer = Math.hypot(player.x - candidate.x, player.y - candidate.y);
  const reactionWindow = 0.38 - difficulty.terminalProgress * 0.3;

  if (distanceToPlayer - playerRadius - candidate.radius < projectileSpeed * reactionWindow) {
    return false;
  }

  const threats = [...existingThreats, candidate];
  const limits = {
    left: BOUNDS.left + playerRadius,
    right: BOUNDS.right - playerRadius,
    bottom: BOUNDS.bottom + playerRadius,
    top: BOUNDS.top - playerRadius,
  };

  for (let candidateIndex = 0; candidateIndex <= 16; candidateIndex += 1) {
    const angle = candidateIndex / 16 * Math.PI * 2;
    const movementX = candidateIndex === 16 ? 0 : Math.cos(angle);
    const movementY = candidateIndex === 16 ? 0 : Math.sin(angle);
    let safe = true;

    for (let step = 1; step <= 10 && safe; step += 1) {
      const elapsed = step * 0.08;
      const playerX = clampNumber(player.x + movementX * PLAYER_SPEED * elapsed, limits.left, limits.right);
      const playerY = clampNumber(player.y + movementY * PLAYER_SPEED * elapsed, limits.bottom, limits.top);

      for (const threat of threats) {
        const threatX = threat.x + threat.velocityX * elapsed;
        const threatY = threat.y + threat.velocityY * elapsed;
        const collisionRadius = playerRadius + 0.12 + threat.radius;
        if ((playerX - threatX) ** 2 + (playerY - threatY) ** 2 <= collisionRadius ** 2) {
          safe = false;
          break;
        }
      }
    }

    if (safe) {
      return true;
    }
  }

  const unsafeChance = unsafeRouteAdmissionChance(difficulty.terminalProgress);
  return unsafeChance > 0 && random() < unsafeChance;
}

/**
 * Deterministic, renderer-free pressure measurement for the current Super
 * Brain. It intentionally models defense effects, not offensive damage, so a
 * result answers one narrow question: how long can today's movement policy
 * survive the current hostile curve when all three crate systems are online?
 */
export function runPressureSimulation(options: PressureSimulationOptions): PressureSimulationResult {
  const difficulty = difficultyForSector(options.sector);
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) >>> 0 : 0;
  const requestedDurationSeconds = clampNumber(
    Number.isFinite(options.durationSeconds) ? options.durationSeconds ?? 6 : 6,
    0.6,
    20,
  );
  const admissionMode: PressureAdmissionMode = options.admissionMode === "runtime"
    ? "runtime"
    : "adversarial";
  const decisionStepSeconds = clampNumber(
    Number.isFinite(options.decisionStepSeconds)
      ? options.decisionStepSeconds ?? SUPER_BRAIN_DECISION_INTERVAL_SECONDS
      : SUPER_BRAIN_DECISION_INTERVAL_SECONDS,
    0.04,
    0.2,
  );
  const random = seededRandom(seed);
  const brainConfig: SuperBrainConfig = {
    ...DEFAULT_SUPER_BRAIN_CONFIG,
    ...options.brainConfig,
  };
  const hostileTuning = options.hostileTuning
    ? resolveEnemyPressureTuning(options.hostileTuning)
    : ENEMY_PRESSURE_TUNING;
  const controller = new SuperBrainController(brainConfig);
  const threats: MutablePressureThreat[] = [];
  const targets = targetFixtures(difficulty);
  const attemptedByPattern = emptyPatternCounts();
  const spawnedByPattern = emptyPatternCounts();
  const resourceUses = emptyResourceCounts();
  const resourceWaste = emptyResourceCounts();
  const unresolvedResourceWindows = emptyResourceCounts();
  const threatsClearedByResource = emptyResourceCounts();
  const specialWindows: Record<JetAbilityKind, SpecialBenefitWindow> = {
    counterflare: { benefitCount: 0, open: false },
    "gravity-knot": { benefitCount: 0, open: false },
    "phoenix-squadron": { benefitCount: 0, open: false },
  };
  let specialStates = unlockedAbilityStates();
  let player = { x: 0, y: PLAYER_START_Y };
  let previousPlayer = { ...player };
  let playerVelocity = { x: 0, y: 0 };
  let currentMovement: Vec2 = { x: 0, y: 0 };
  let dashDirection: Vec2 = { x: 0, y: 1 };
  let dashRemaining = 0;
  let dashCooldown = 0;
  let dashBurstRemaining = 0;
  let lowProfileRemaining = 0;
  let lowProfileCooldown = 0;
  let invulnerabilityRemaining = 0;
  let counterflareConversionsRemaining = 0;
  let gravityKnotX = 0;
  let gravityKnotY = 0;
  let phoenixStrikeCooldown = 0;
  let phoenixStrikeIndex = 0;
  let nextThreatId = 1;
  let nextWaveSeconds = 0;
  let nextRocketSeconds = 0.42;
  let nextDecisionSeconds = 0;
  let waveIndex = 0;
  let elapsedSeconds = 0;
  let livesRemaining = 3;
  let damageTaken = 0;
  let collisions = 0;
  let invulnerabilityCollisions = 0;
  let firstDamageSeconds: number | null = null;
  let minimumPredictedSurvivalSeconds = brainConfig.planningHorizonSeconds;
  let minimumPredictedClearance = Number.POSITIVE_INFINITY;
  let pressuredDecisions = 0;
  let decisionCount = 0;
  let rejectedForFairness = 0;
  let rejectedForProjectileCap = 0;
  let rejectedForRocketCap = 0;
  let rejectedForGlobalPressureGate = 0;
  let peakConcurrentThreats = 0;
  let peakConcurrentRockets = 0;
  let determinismHash = 2_166_136_261;
  let gameOver = false;
  let latestBrainSurvivalSeconds = brainConfig.planningHorizonSeconds;
  let latestBrainClearance = Number.POSITIVE_INFINITY;

  const activeRocketCount = (): number => threats.reduce(
    (count, threat) => count + (threat.kind === "rocket" ? 1 : 0),
    0,
  );

  const canAddRuntimePressure = (): boolean => {
    if (
      admissionMode === "adversarial"
      || isTerminalPressureUnbounded(difficulty.terminalProgress)
    ) {
      return true;
    }

    const required = brainPressureAdmissionThresholds(
      difficulty.terminalProgress,
      brainConfig.planningHorizonSeconds,
    );
    return latestBrainSurvivalSeconds >= required.survivalSeconds
      && latestBrainClearance > required.clearance;
  };

  const acceptThreat = (threat: MutablePressureThreat): boolean => {
    attemptedByPattern[threat.pattern] += 1;

    if (threats.length >= difficulty.maxEnemyProjectiles) {
      rejectedForProjectileCap += 1;
      return false;
    }
    if (threat.kind === "rocket" && activeRocketCount() >= difficulty.maxEnemyRockets) {
      rejectedForRocketCap += 1;
      return false;
    }
    if (!leavesEscapeRoute(difficulty, threat, threats, player, NORMAL_RADIUS, random)) {
      rejectedForFairness += 1;
      return false;
    }

    threats.push(threat);
    spawnedByPattern[threat.pattern] += 1;
    nextThreatId += 1;
    peakConcurrentThreats = Math.max(peakConcurrentThreats, threats.length);
    peakConcurrentRockets = Math.max(peakConcurrentRockets, activeRocketCount());
    determinismHash = hashNumber(determinismHash, threat.id);
    determinismHash = hashNumber(determinismHash, threat.x);
    determinismHash = hashNumber(determinismHash, threat.velocityY);
    return true;
  };

  const spawnAimedBolt = (index: number, count: number): void => {
    const originX = -8.8 + random() * 17.6;
    const originY = BOUNDS.top + 1.3 + random() * 1.2;
    const predictedX = player.x
      + playerVelocity.x * hostileTuning.horizontalAimLeadSeconds
      + (random() - 0.5)
        * (2.8 - difficulty.terminalProgress * 1.4)
        * hostileTuning.aimJitterScale;
    const predictedY = player.y + playerVelocity.y * hostileTuning.verticalAimLeadSeconds;
    const fanOffset = (index - (count - 1) / 2) * 0.07 * hostileTuning.volleySpreadScale;
    const baseAngle = Math.atan2(predictedY - originY, predictedX - originX) + fanOffset;
    const speed = difficulty.enemyProjectileSpeed * (0.88 + random() * 0.12);
    acceptThreat({
      id: nextThreatId,
      pattern: "aimed-bolt",
      kind: "projectile",
      x: originX,
      y: originY,
      velocityX: Math.cos(baseAngle) * speed,
      velocityY: Math.sin(baseAngle) * speed,
      radius: 0.2,
      homingSecondsRemaining: 0,
    });
  };

  const spawnCrossLaneSpread = (index: number, count: number): void => {
    const fromLeft = (waveIndex + index) % 2 === 0;
    const originX = fromLeft ? BOUNDS.left - 1.2 : BOUNDS.right + 1.2;
    const originY = clampNumber(player.y + (random() - 0.5) * 11, BOUNDS.bottom + 1, BOUNDS.top - 1);
    const targetY = player.y
      + (index - (count - 1) / 2) * 1.15 * hostileTuning.volleySpreadScale;
    const direction = normalize((fromLeft ? 1 : -1) * 20, targetY - originY);
    const speed = difficulty.enemyProjectileSpeed * (0.68 + random() * 0.1);
    acceptThreat({
      id: nextThreatId,
      pattern: "cross-lane-spread",
      kind: "projectile",
      x: originX,
      y: originY,
      velocityX: direction.x * speed,
      velocityY: direction.y * speed,
      radius: 0.18,
      homingSecondsRemaining: 0,
    });
  };

  const spawnClosingProjectile = (index: number): void => {
    const angle = Math.PI * (0.08 + random() * 0.84) + (index % 2 === 0 ? 0 : Math.PI);
    const distance = 9.8 - difficulty.terminalProgress * 2.5 + random() * 2.2;
    const originX = clampNumber(player.x + Math.cos(angle) * distance, BOUNDS.left - 1.5, BOUNDS.right + 1.5);
    const originY = clampNumber(player.y + Math.sin(angle) * distance, BOUNDS.bottom - 1.5, BOUNDS.top + 1.5);
    const targetX = player.x + playerVelocity.x * hostileTuning.horizontalAimLeadSeconds;
    const targetY = player.y + playerVelocity.y * hostileTuning.verticalAimLeadSeconds;
    const direction = normalize(targetX - originX, targetY - originY);
    const speed = difficulty.enemyProjectileSpeed * (1.08 + difficulty.terminalProgress * 0.12);
    acceptThreat({
      id: nextThreatId,
      pattern: "closing-projectile",
      kind: "projectile",
      x: originX,
      y: originY,
      velocityX: direction.x * speed,
      velocityY: direction.y * speed,
      radius: 0.24,
      homingSecondsRemaining: 0,
    });
  };

  const spawnHomingRocket = (): void => {
    const originX = -8.6 + random() * 17.2;
    const originY = BOUNDS.top + 1.5;
    const direction = normalize(player.x - originX, player.y - originY);
    const speed = Math.max(
      4.5,
      difficulty.enemyProjectileSpeed * 0.72 * hostileTuning.rocketSpeedScale,
    );
    acceptThreat({
      id: nextThreatId,
      pattern: "homing-rocket",
      kind: "rocket",
      x: originX,
      y: originY,
      velocityX: direction.x * speed,
      velocityY: direction.y * speed,
      radius: 0.3,
      homingSecondsRemaining: hostileTuning.rocketHomingSeconds,
    });
  };

  const spawnWave = (): void => {
    const aimedCount = scaledEnemyVolleyCount(
      1 + Math.floor((difficulty.maxFormationSize - 1) / 3),
      hostileTuning,
    );
    for (let index = 0; index < aimedCount; index += 1) {
      spawnAimedBolt(index, aimedCount);
    }

    const spreadPeriod = difficulty.terminalProgress < 0.2
      ? 3
      : difficulty.terminalProgress < 0.62 ? 2 : 1;
    if (waveIndex % spreadPeriod === 0) {
      const spreadCount = scaledEnemyVolleyCount(
        Math.min(4, 2 + Math.floor((difficulty.maxFormationSize - 1) / 3)),
        hostileTuning,
      );
      for (let index = 0; index < spreadCount; index += 1) {
        spawnCrossLaneSpread(index, spreadCount);
      }
    }

    if (difficulty.terminalProgress >= 0.18) {
      const closingPeriod = difficulty.terminalProgress < 0.65 ? 3 : 1;
      if (waveIndex % closingPeriod === 0) {
        const closingCount = scaledEnemyVolleyCount(
          difficulty.terminalProgress >= 0.78 ? 2 : 1,
          hostileTuning,
        );
        for (let index = 0; index < closingCount; index += 1) {
          spawnClosingProjectile(index);
        }
      }
    }

    waveIndex += 1;
  };

  const finishSpecialWindow = (kind: JetAbilityKind, unresolved: boolean): void => {
    const window = specialWindows[kind];
    if (!window.open) {
      return;
    }
    if (unresolved) {
      unresolvedResourceWindows[kind] += 1;
    } else if (window.benefitCount === 0) {
      resourceWaste[kind] += 1;
    }
    window.open = false;
    window.benefitCount = 0;
  };

  const activateSpecial = (kind: JetAbilityKind): boolean => {
    const current = specialStates[kind];
    const next = activateJetAbility(kind, current);
    if (next === current) {
      return false;
    }

    specialStates = { ...specialStates, [kind]: next };
    resourceUses[kind] += 1;
    specialWindows[kind] = { benefitCount: 0, open: true };

    if (kind === "counterflare") {
      counterflareConversionsRemaining = COUNTERFLARE_CONVERSION_CAP;
    } else if (kind === "gravity-knot") {
      gravityKnotX = player.x;
      gravityKnotY = Math.min(BOUNDS.top - 2.5, player.y + GRAVITY_KNOT_OFFSET_Y);
    } else {
      phoenixStrikeCooldown = 0;
      phoenixStrikeIndex = 0;
    }

    determinismHash = hashNumber(determinismHash, PRESSURE_RESOURCES.indexOf(kind) + 101);
    return true;
  };

  const clearThreat = (index: number, resource: JetAbilityKind): void => {
    threats.splice(index, 1);
    threatsClearedByResource[resource] += 1;
    specialWindows[resource].benefitCount += 1;
  };

  const applySpecialEffects = (deltaSeconds: number): void => {
    for (let index = threats.length - 1; index >= 0; index -= 1) {
      const threat = threats[index];
      if (!threat) continue;

      if (
        specialStates.counterflare.activeSeconds > 0
        && counterflareConversionsRemaining > 0
        && Math.hypot(threat.x - player.x, threat.y - player.y) <= COUNTERFLARE_RADIUS
      ) {
        clearThreat(index, "counterflare");
        counterflareConversionsRemaining -= 1;
        continue;
      }

      if (
        specialStates["gravity-knot"].activeSeconds > 0
        && Math.hypot(threat.x - gravityKnotX, threat.y - gravityKnotY) <= GRAVITY_KNOT_RADIUS
      ) {
        clearThreat(index, "gravity-knot");
      }
    }

    if (specialStates["phoenix-squadron"].activeSeconds > 0) {
      phoenixStrikeCooldown -= deltaSeconds;
      while (phoenixStrikeCooldown <= 0 && phoenixStrikeIndex < PHOENIX_STRIKE_CAP) {
        const target = targets[phoenixStrikeIndex % Math.max(1, targets.length)];
        const laneX = clampNumber(
          target?.position.x ?? player.x + (phoenixStrikeIndex % 3 - 1) * 3.2,
          BOUNDS.left + 1.2,
          BOUNDS.right - 1.2,
        );
        phoenixStrikeIndex += 1;
        phoenixStrikeCooldown += PHOENIX_STRIKE_INTERVAL_SECONDS;

        for (let index = threats.length - 1; index >= 0; index -= 1) {
          const threat = threats[index];
          if (threat && Math.abs(threat.x - laneX) <= PHOENIX_LANE_RADIUS) {
            clearThreat(index, "phoenix-squadron");
          }
        }
      }
    }
  };

  const tickSpecialStates = (deltaSeconds: number): void => {
    const previousStates = specialStates;
    specialStates = {
      counterflare: tickJetAbilityState(previousStates.counterflare, deltaSeconds),
      "gravity-knot": tickJetAbilityState(previousStates["gravity-knot"], deltaSeconds),
      "phoenix-squadron": tickJetAbilityState(previousStates["phoenix-squadron"], deltaSeconds),
    };

    for (const kind of JET_ABILITY_KINDS) {
      if (previousStates[kind].activeSeconds > 0 && specialStates[kind].activeSeconds <= 0) {
        finishSpecialWindow(kind, false);
      }
    }
  };

  const gravityTargetCount = (): number => {
    const knotX = player.x;
    const knotY = Math.min(BOUNDS.top - 2.5, player.y + GRAVITY_KNOT_OFFSET_Y);
    return targets.reduce((count, target) => (
      count + (Math.hypot(target.position.x - knotX, target.position.y - knotY) <= 4.6 ? 1 : 0)
    ), 0);
  };

  const observe = (): BrainObservation => {
    const counts = projectedPressureCounts(threats, player, playerVelocity, PLANNING_RADIUS);
    const bossTarget = targets.find((target) => target.kind === "boss");
    const bossActive = bossTarget !== undefined;
    const bossPhase = difficulty.terminalProgress >= 0.68 ? 3 : difficulty.terminalProgress >= 0.3 ? 2 : 1;

    return {
      player: {
        position: player,
        velocity: playerVelocity,
        radius: PLANNING_RADIUS,
        maxSpeed: PLAYER_SPEED,
      },
      bounds: BOUNDS,
      threats: threats.map((threat) => asBrainThreat(threat, hostileTuning)),
      targets,
      manualIntent: { x: 0, y: 0 },
      abilities: {
        dashReady: dashCooldown <= 0 && dashRemaining <= 0,
        lowProfileReady: lowProfileCooldown <= 0 && lowProfileRemaining <= 0,
        lowProfileActive: lowProfileRemaining > 0,
        missilesReady: false,
        dashSpeedMultiplier: DASH_SPEED_MULTIPLIER,
        dashDurationSeconds: DASH_SECONDS,
        lowProfileRadius: LOW_PROFILE_RADIUS,
        specials: {
          states: specialStates,
          nearProjectileCount: counts.nearProjectileCount,
          nearRocketCount: counts.nearRocketCount,
          totalProjectileCount: threats.length,
          gravityTargetCount: gravityTargetCount(),
          bossActive,
          bossEntering: false,
          bossDamageable: true,
          bossPhase,
          bossHealthRatio: Math.max(0.2, 1 - difficulty.terminalProgress * 0.7),
          escortCount: bossActive ? Math.min(4, Math.max(0, targets.length - 1)) : 0,
          terminalProgress: difficulty.terminalProgress,
          stasisActive: false,
          dashBurstActive: dashBurstRemaining > 0,
        },
      },
    };
  };

  const decide = (): void => {
    const observation = observe();
    const previousMovement = currentMovement;
    const decision = controller.decide(observation);
    currentMovement = decision.movement;
    decisionCount += 1;
    minimumPredictedSurvivalSeconds = Math.min(minimumPredictedSurvivalSeconds, decision.survivalSeconds);
    minimumPredictedClearance = Math.min(minimumPredictedClearance, decision.predictedClearance);
    latestBrainSurvivalSeconds = decision.survivalSeconds;
    latestBrainClearance = decision.predictedClearance;
    const urgent = decision.survivalSeconds < brainConfig.planningHorizonSeconds - EPSILON
      || decision.predictedClearance < brainConfig.emergencyClearance;
    if (urgent) {
      pressuredDecisions += 1;
    }

    if (decision.useLowProfile && lowProfileCooldown <= 0 && lowProfileRemaining <= 0) {
      const withoutLowProfile = decideSuperBrain({
        ...observation,
        abilities: { ...observation.abilities, lowProfileReady: false },
      }, previousMovement, brainConfig);
      const addedSafety = decision.survivalSeconds
        > withoutLowProfile.survivalSeconds + brainConfig.simulationStepSeconds * 0.5
        || (
          decision.survivalSeconds >= withoutLowProfile.survivalSeconds - EPSILON
          && decision.predictedClearance
            > withoutLowProfile.predictedClearance + brainConfig.safetyMargin * 0.5
        );
      lowProfileRemaining = LOW_PROFILE_SECONDS;
      lowProfileCooldown = LOW_PROFILE_COOLDOWN_SECONDS;
      resourceUses["low-profile"] += 1;
      if (!addedSafety) {
        resourceWaste["low-profile"] += 1;
      }
    }

    if (decision.useDash && dashCooldown <= 0 && dashRemaining <= 0) {
      const withoutDash = decideSuperBrain({
        ...observation,
        abilities: { ...observation.abilities, dashReady: false },
      }, previousMovement, brainConfig);
      const addedSafety = decision.survivalSeconds
        > withoutDash.survivalSeconds + brainConfig.simulationStepSeconds * 0.5
        || (
          decision.survivalSeconds >= withoutDash.survivalSeconds - EPSILON
          && decision.predictedClearance
            > withoutDash.predictedClearance + brainConfig.safetyMargin * 0.5
        );
      dashRemaining = DASH_SECONDS;
      dashCooldown = DASH_COOLDOWN_SECONDS;
      dashDirection = decision.movement;
      resourceUses.dash += 1;
      if (!addedSafety) {
        resourceWaste.dash += 1;
      }
    }

    if (decision.useCounterflare) activateSpecial("counterflare");
    if (decision.useGravityKnot) activateSpecial("gravity-knot");
    if (decision.usePhoenixSquadron) activateSpecial("phoenix-squadron");

    determinismHash = hashNumber(determinismHash, decision.movement.x);
    determinismHash = hashNumber(determinismHash, decision.movement.y);
    determinismHash = hashNumber(determinismHash, decision.predictedClearance);
  };

  while (elapsedSeconds < requestedDurationSeconds - EPSILON && !gameOver) {
    const deltaSeconds = Math.min(PHYSICS_STEP_SECONDS, requestedDurationSeconds - elapsedSeconds);
    const waveInterval = Math.max(
      0.1,
      difficulty.enemySpawnInterval
        * (0.95 + difficulty.enemyFireCooldownScale * 0.45)
        * hostileTuning.fireCadenceScale,
    );
    const rocketInterval = Math.max(
      0.18,
      difficulty.rocketCooldownScale * 2.4 * hostileTuning.rocketCadenceScale,
    );

    while (nextWaveSeconds <= elapsedSeconds + EPSILON) {
      if (canAddRuntimePressure()) {
        spawnWave();
      } else {
        rejectedForGlobalPressureGate += 1;
      }
      nextWaveSeconds += waveInterval;
    }
    while (nextRocketSeconds <= elapsedSeconds + EPSILON) {
      if (canAddRuntimePressure()) {
        spawnHomingRocket();
      } else {
        rejectedForGlobalPressureGate += 1;
      }
      nextRocketSeconds += rocketInterval;
    }

    if (dashRemaining <= 0 && nextDecisionSeconds <= elapsedSeconds + EPSILON) {
      decide();
      nextDecisionSeconds = elapsedSeconds + decisionStepSeconds;
    }

    applySpecialEffects(deltaSeconds);
    previousPlayer = { ...player };
    const movement = dashRemaining > 0 ? dashDirection : currentMovement;
    const speed = dashRemaining > 0 ? PLAYER_SPEED * DASH_SPEED_MULTIPLIER : PLAYER_SPEED;
    const playerRadius = lowProfileRemaining > 0 ? LOW_PROFILE_RADIUS : NORMAL_RADIUS;
    player = {
      x: clampNumber(player.x + movement.x * speed * deltaSeconds, BOUNDS.left + playerRadius, BOUNDS.right - playerRadius),
      y: clampNumber(player.y + movement.y * speed * deltaSeconds, BOUNDS.bottom + playerRadius, BOUNDS.top - playerRadius),
    };
    playerVelocity = {
      x: (player.x - previousPlayer.x) / deltaSeconds,
      y: (player.y - previousPlayer.y) / deltaSeconds,
    };

    for (let index = threats.length - 1; index >= 0; index -= 1) {
      const threat = threats[index];
      if (!threat) continue;
      const previousThreatX = threat.x;
      const previousThreatY = threat.y;

      if (threat.kind === "rocket" && threat.homingSecondsRemaining > 0) {
        const speed = Math.hypot(threat.velocityX, threat.velocityY);
        const target = normalize(player.x - threat.x, player.y - threat.y);
        const steering = Math.min(1, deltaSeconds * hostileTuning.rocketHomingStrength);
        const steered = normalize(
          threat.velocityX / Math.max(speed, EPSILON) * (1 - steering) + target.x * steering,
          threat.velocityY / Math.max(speed, EPSILON) * (1 - steering) + target.y * steering,
        );
        threat.velocityX = steered.x * speed;
        threat.velocityY = steered.y * speed;
        threat.homingSecondsRemaining = Math.max(0, threat.homingSecondsRemaining - deltaSeconds);
      }

      threat.x += threat.velocityX * deltaSeconds;
      threat.y += threat.velocityY * deltaSeconds;
      if (movingCirclesOverlap(
        previousPlayer.x,
        previousPlayer.y,
        player.x,
        player.y,
        playerRadius,
        previousThreatX,
        previousThreatY,
        threat.x,
        threat.y,
        threat.radius,
      )) {
        threats.splice(index, 1);
        collisions += 1;

        if (invulnerabilityRemaining > 0) {
          invulnerabilityCollisions += 1;
        } else {
          damageTaken += 1;
          livesRemaining -= 1;
          firstDamageSeconds ??= elapsedSeconds + deltaSeconds;
          invulnerabilityRemaining = LIFE_LOSS_GRACE_SECONDS;
          player = { x: 0, y: PLAYER_START_Y };
          previousPlayer = { ...player };
          playerVelocity = { x: 0, y: 0 };
          if (livesRemaining <= 0) {
            gameOver = true;
            break;
          }
        }
        continue;
      }

      if (
        threat.x < BOUNDS.left - 5
        || threat.x > BOUNDS.right + 5
        || threat.y < BOUNDS.bottom - 5
        || threat.y > BOUNDS.top + 7
      ) {
        threats.splice(index, 1);
      }
    }

    const dashWasActive = dashRemaining > 0;
    dashRemaining = Math.max(0, dashRemaining - deltaSeconds);
    dashCooldown = Math.max(0, dashCooldown - deltaSeconds);
    if (dashWasActive && dashRemaining <= 0) {
      dashBurstRemaining = DASH_BURST_SECONDS;
    }
    dashBurstRemaining = Math.max(0, dashBurstRemaining - deltaSeconds);
    lowProfileRemaining = Math.max(0, lowProfileRemaining - deltaSeconds);
    lowProfileCooldown = Math.max(0, lowProfileCooldown - deltaSeconds);
    invulnerabilityRemaining = Math.max(0, invulnerabilityRemaining - deltaSeconds);
    tickSpecialStates(deltaSeconds);
    elapsedSeconds += deltaSeconds;
    determinismHash = hashNumber(determinismHash, player.x);
    determinismHash = hashNumber(determinismHash, player.y);
    determinismHash = hashNumber(determinismHash, threats.length);
    determinismHash = hashNumber(determinismHash, damageTaken);
  }

  for (const kind of JET_ABILITY_KINDS) {
    if (specialWindows[kind].open) {
      finishSpecialWindow(kind, !gameOver && specialStates[kind].activeSeconds > 0);
    }
  }

  if (!Number.isFinite(minimumPredictedClearance)) {
    minimumPredictedClearance = 0;
  }

  return {
    sector: difficulty.sector,
    seed,
    admissionMode,
    requestedDurationSeconds,
    simulatedSeconds: elapsedSeconds,
    survivedSeconds: gameOver ? elapsedSeconds : requestedDurationSeconds,
    gameOver,
    damageTaken,
    collisions,
    invulnerabilityCollisions,
    livesRemaining,
    firstDamageSeconds,
    minimumPredictedSurvivalSeconds,
    minimumPredictedClearance,
    pressuredDecisions,
    decisionCount,
    attemptedByPattern,
    spawnedByPattern,
    rejectedForFairness,
    rejectedForProjectileCap,
    rejectedForRocketCap,
    rejectedForGlobalPressureGate,
    peakConcurrentThreats,
    peakConcurrentRockets,
    resourceUses,
    resourceWaste,
    unresolvedResourceWindows,
    threatsClearedByResource,
    determinismHash,
  };
}
