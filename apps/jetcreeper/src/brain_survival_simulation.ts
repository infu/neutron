import {
  DEFAULT_SUPER_BRAIN_CONFIG,
  SUPER_BRAIN_DECISION_INTERVAL_SECONDS,
  SuperBrainController,
  type BrainObservation,
  type BrainPickup,
  type BrainTarget,
  type BrainThreat,
  type SuperBrainConfig,
  type Vec2,
} from "./autopilot";
import {
  JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS,
  activateJetAbility,
  tickJetAbilityState,
  type JetAbilityStates,
} from "./abilities";
import {
  BOSS_ESCORT_HEALTH_THRESHOLDS,
  bossEscortWavesForEncounter,
} from "./boss_escorts";
import { caveWallClearance, sampleCaveCorridor } from "./cave";
import {
  beginBossEncounter,
  createEncounterCadence,
  normalWaveSpawnCount,
  recordBossDefeat,
  recordNormalWaveClear,
  type EncounterCadenceState,
} from "./encounter_cadence";
import {
  BOSS_ARCHETYPES,
  bossHealthForSector,
  clampNumber,
  difficultyForSector,
  enemyArchetypeForKind,
  enemyKindForRoll,
  enemyKindsForSector,
  movingCirclesOverlap,
  type BossArchetype,
  type BossPhase,
  type EnemyKind,
  type EnemyMovementFamily,
} from "./game_rules";
import {
  LOW_PROFILE_HOSTILE_TIME_SCALE,
  LOW_PROFILE_PLAYER_SPEED_MULTIPLIER,
  LOW_PROFILE_TIME_WARP_SECONDS,
} from "./laser_rules";

/** Fixed corpus used for both tuning and the sector-50 acceptance. */
export const BRAIN_SURVIVAL_SEARCH_SEEDS = Object.freeze([
  0x5eed_0050,
  0x00c0_ffee,
  0xa11c_e55e,
  0x71a9_3d2b,
  0xd06d_9f41,
] as const);

export const BRAIN_SURVIVAL_TARGET_SECTOR = 50;

export interface BrainSurvivalSimulationOptions {
  readonly seed: number;
  readonly brainConfig?: Partial<SuperBrainConfig>;
  readonly targetSector?: number;
  /** Kept short enough for bounded search while resolving several volleys. */
  readonly secondsPerSector?: number;
}

export interface BrainSurvivalSimulationResult {
  readonly seed: number;
  readonly targetSector: number;
  readonly completedSector: number;
  readonly survived: boolean;
  readonly livesRemaining: number;
  readonly projectileHits: number;
  readonly enemyHits: number;
  readonly terrainHits: number;
  readonly repairsCollected: number;
  readonly abilityCoresCollected: number;
  readonly specialUses: number;
  readonly lowProfileUses: number;
  readonly lowProfileTimeWarpSeconds: number;
  readonly normalWavesCompleted: number;
  readonly bossesDefeated: number;
  readonly bossEscortWavesObserved: number;
  readonly normalWavesBetweenBosses: readonly number[];
  readonly bossArchetypesObserved: readonly BossArchetype[];
  readonly enemyKindsObserved: readonly EnemyKind[];
  readonly damageSectors: readonly number[];
  readonly peakObservedProjectiles: number;
  readonly peakObservedEnemies: number;
  readonly decisionCount: number;
  readonly plannerWorkUnits: number;
  readonly peakPlannerWorkPerDecision: number;
  readonly minimumPhysicalClearance: number;
  readonly fairnessDeferrals: number;
  readonly determinismHash: number;
}

export interface BrainSurvivalEvaluation {
  readonly config: Readonly<SuperBrainConfig>;
  readonly seeds: readonly number[];
  readonly survivedRuns: number;
  readonly completedSectorFloor: number;
  readonly totalHits: number;
  readonly terrainHits: number;
  readonly meanMinimumClearance: number;
  readonly plannerWorkUnits: number;
  readonly results: readonly BrainSurvivalSimulationResult[];
}

export interface BrainSurvivalSearchResult {
  readonly baseline: BrainSurvivalEvaluation;
  readonly winner: BrainSurvivalEvaluation;
  readonly evaluatedCandidates: number;
  readonly rejectedForPlannerBudget: number;
  readonly plannerBudgetUnits: number;
  readonly winnerIndex: number;
}

interface MutableThreat {
  readonly id: number;
  readonly kind: "projectile" | "rocket";
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  readonly radius: number;
  homingSecondsRemaining: number;
}

interface MutableEnemy {
  readonly id: number;
  readonly phase: number;
  readonly radius: number;
  readonly kind: EnemyKind;
  readonly movementFamily: EnemyMovementFamily;
  readonly priority: number;
  readonly health: number;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

interface MutableRepair {
  readonly id: number;
  x: number;
  y: number;
  readonly radius: number;
  readonly velocityY: number;
}

const BOUNDS = Object.freeze({ left: -10, right: 10, bottom: -16, top: 16 });
const PLAYER_SPEED = 11.5;
const PLAYER_RADIUS = 0.78;
const PLANNING_RADIUS = 1.2;
const LOW_PROFILE_RADIUS = 0.42;
const LOW_PROFILE_SECONDS = 1.35;
const LOW_PROFILE_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS["low-profile"];
// Production movement dash. Its longer motion trail and barrel roll are visual-only.
const DASH_SECONDS = 0.12;
const DASH_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS.dash;
const DASH_SPEED_MULTIPLIER = 4;
const DAMAGE_GRACE_SECONDS = 2.4;
const RESPAWN_PROJECTILE_CLEAR_RADIUS = 6.5;
const PHYSICS_STEP_SECONDS = 0.04;
const DEFAULT_SECONDS_PER_SECTOR = 0.72;
const EPSILON = 1e-9;
const COUNTERFLARE_RADIUS = 5.7;
const COUNTERFLARE_CAP = 12;
const GRAVITY_KNOT_RADIUS = 3.8;
const PHOENIX_LANE_RADIUS = 1.8;
const BOSS_RADIUS = 1.55;

/**
 * Public parity snapshot for focused tests. Values are references to the same
 * production constants rather than a second set of simulation-only tuning.
 */
export const BRAIN_SURVIVAL_MECHANICS = Object.freeze({
  lowProfileCooldownSeconds: LOW_PROFILE_COOLDOWN_SECONDS,
  lowProfileTimeWarpSeconds: LOW_PROFILE_TIME_WARP_SECONDS,
  hostileTimeScale: LOW_PROFILE_HOSTILE_TIME_SCALE,
  playerSpeedMultiplier: LOW_PROFILE_PLAYER_SPEED_MULTIPLIER,
  bossEscortHealthThresholds: BOSS_ESCORT_HEALTH_THRESHOLDS,
});

interface EnemyMovementTuning {
  readonly lateralAmplitude: number;
  readonly lateralRate: number;
  readonly descentScale: number;
  readonly pursuitWeight: number;
}

/** Compact kinematic proxies for the production roster's movement families. */
function enemyMovementTuning(family: EnemyMovementFamily): EnemyMovementTuning {
  switch (family) {
    case "intercept":
    case "siphon-pursuit":
    case "ram-charge":
      return { lateralAmplitude: 3.4, lateralRate: 1.5, descentScale: 1.28, pursuitWeight: 0.72 };
    case "phase-shift":
    case "strafe-dash":
    case "blink-ambush":
    case "cloak-stalk":
    case "chrono-zigzag":
      return { lateralAmplitude: 7.1, lateralRate: 1.72, descentScale: 1.02, pursuitWeight: 0.28 };
    case "drift":
    case "hold-lane":
    case "mine-drift":
    case "carrier-lane":
    case "shield-advance":
      return { lateralAmplitude: 2.6, lateralRate: 0.62, descentScale: 0.72, pursuitWeight: 0.08 };
    case "broadside":
    case "tether-orbit":
    case "command-weave":
      return { lateralAmplitude: 5.2, lateralRate: 0.84, descentScale: 0.82, pursuitWeight: 0.18 };
    case "bombing-run":
    case "split-flank":
      return { lateralAmplitude: 6.3, lateralRate: 1.12, descentScale: 1.18, pursuitWeight: 0.24 };
    case "orbit":
    case "tumble":
    default:
      return { lateralAmplitude: 5.5, lateralRate: 0.94, descentScale: 1, pursuitWeight: 0.12 };
  }
}

/** Pre-survival-tuning production values, retained for reproducible comparison. */
export const BASELINE_BRAIN_SURVIVAL_CONFIG: Readonly<SuperBrainConfig> = Object.freeze({
  ...DEFAULT_SUPER_BRAIN_CONFIG,
  planningHorizonSeconds: 1.675,
  simulationStepSeconds: 0.1,
  candidateHeadingCount: 32,
  lookaheadBeamWidth: 0,
  densePressurePartialSpeedScale: 0,
  densePressureHazardTolerance: -1,
  densePressureBoundaryReserve: 0,
  densePressureLowProfileExposureRatio: 0,
  safetyMargin: 0.18,
  safeClearanceRatio: 0.9,
  emergencyClearance: 0.62,
  targetLaneWeight: 0.0703,
});

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
  const magnitude = Math.hypot(x, y);
  return magnitude > EPSILON ? { x: x / magnitude, y: y / magnitude } : { x: 0, y: -1 };
}

function hashNumber(hash: number, value: number): number {
  const finite = Number.isFinite(value) ? value : value > 0 ? 1_000_000 : -1_000_000;
  return Math.imul(hash ^ Math.round(finite * 1_000), 16_777_619) >>> 0;
}

function asBrainThreat(threat: MutableThreat, hostileTimeScale: number): BrainThreat {
  const common = {
    id: `dense-projectile-${threat.id}`,
    kind: threat.kind,
    position: { x: threat.x, y: threat.y },
    velocity: {
      x: threat.velocityX * hostileTimeScale,
      y: threat.velocityY * hostileTimeScale,
    },
    radius: threat.radius,
  } as const;
  return threat.kind === "rocket"
    ? {
      ...common,
      motion: "homing",
      homingSecondsRemaining: threat.homingSecondsRemaining / hostileTimeScale,
      homingStrength: 1.15 * hostileTimeScale,
    }
    : common;
}

function asEnemyThreat(enemy: MutableEnemy, hostileTimeScale: number): BrainThreat {
  return {
    id: `dense-enemy-${enemy.id}`,
    kind: "enemy",
    position: { x: enemy.x, y: enemy.y },
    velocity: {
      x: enemy.velocityX * hostileTimeScale,
      y: enemy.velocityY * hostileTimeScale,
    },
    radius: enemy.radius,
  };
}

function asEnemyTarget(enemy: MutableEnemy, hostileTimeScale: number): BrainTarget {
  return {
    id: `dense-enemy-${enemy.id}`,
    kind: "enemy",
    position: { x: enemy.x, y: enemy.y },
    velocity: {
      x: enemy.velocityX * hostileTimeScale,
      y: enemy.velocityY * hostileTimeScale,
    },
    radius: enemy.radius,
    priority: enemy.priority,
    health: enemy.health,
    damageable: true,
    visible: true,
    weaponReachable: enemy.y >= BOUNDS.bottom && enemy.y <= BOUNDS.top,
    committedDamage: 0,
  };
}

function plannerWorkPerDecision(
  config: Readonly<SuperBrainConfig>,
  lowProfileReady: boolean,
  dashReady: boolean,
  lookaheadUsed: boolean,
): number {
  const partialHeadings = config.densePressurePartialSpeedScale > 0 ? 8 : 0;
  const headings = Math.max(8, Math.min(48, Math.floor(config.candidateHeadingCount)))
    + 1
    + partialHeadings;
  const steps = Math.max(1, Math.ceil(config.planningHorizonSeconds / Math.max(0.03, config.simulationStepSeconds)));
  const baseModeWork = headings * steps;
  let work = baseModeWork
    * (1 + Number(lowProfileReady) + Number(dashReady));

  if (lookaheadUsed && config.lookaheadBeamWidth > 0) {
    const beamWidth = Math.max(0, Math.min(headings, Math.floor(config.lookaheadBeamWidth)));
    const firstPlySteps = Math.max(1, Math.ceil(steps / 3));
    const secondPlySteps = Math.max(1, Math.ceil(steps * 2 / 3));
    work += headings * firstPlySteps
      + beamWidth * 3 * secondPlySteps
      + beamWidth * 3 * steps;
  }

  return work;
}

/**
 * Continuous renderer-free traversal through a moving cave. Normal waves use
 * the production 4, then alternating 3/4 cadence; bosses occupy three slices
 * at the 75/50/25 escort gates. Enemy pressure is roster-derived and bounded
 * by current global caps, while projectile pressure deliberately remains at
 * the hard cap as a deterministic worst case. The compressed sector clock
 * awards guaranteed cores at the director's current gates and assumes each
 * offered core is collected immediately. Low-profile uses the exact runtime
 * cooldown, five-second world/hostile dilation, and player speed multiplier.
 * This is a bounded controller regression, not a score/economy simulator.
 */
export function runBrainSurvivalSimulation(
  options: BrainSurvivalSimulationOptions,
): BrainSurvivalSimulationResult {
  const seed = Number.isFinite(options.seed) ? Math.floor(options.seed) >>> 0 : 0;
  const targetSector = Math.floor(clampNumber(options.targetSector ?? BRAIN_SURVIVAL_TARGET_SECTOR, 1, 200));
  const secondsPerSector = clampNumber(options.secondsPerSector ?? DEFAULT_SECONDS_PER_SECTOR, 0.3, 2);
  const config: SuperBrainConfig = { ...DEFAULT_SUPER_BRAIN_CONFIG, ...options.brainConfig };
  const random = seededRandom(seed);
  const controller = new SuperBrainController(config);
  const projectiles: MutableThreat[] = [];
  const enemies: MutableEnemy[] = [];
  const repairs: MutableRepair[] = [];
  let player = { x: 0, y: config.neutralY };
  let previousPlayer = { ...player };
  let playerVelocity = { x: 0, y: 0 };
  let movement: Vec2 = { x: 0, y: 0 };
  let dashDirection: Vec2 = { x: 0, y: 1 };
  let dashRemaining = 0;
  let dashCooldown = 0;
  let lowProfileRemaining = 0;
  let lowProfileCooldown = 0;
  let lowProfileTimeWarpRemaining = 0;
  let lowProfileUses = 0;
  let lowProfileTimeWarpSeconds = 0;
  let damageGraceRemaining = 0;
  let livesRemaining = 3;
  let projectileHits = 0;
  let enemyHits = 0;
  let terrainHits = 0;
  let repairsCollected = 0;
  let abilityCoresCollected = 0;
  let specialUses = 0;
  const damageSectors: number[] = [];
  let caveTravel = 0;
  let elapsedSeconds = 0;
  let nextDecisionSeconds = 0;
  let nextProjectileId = 1;
  let nextEnemyId = 1;
  let nextRepairId = 1;
  let lastRepairSector = 0;
  let peakObservedProjectiles = 0;
  let peakObservedEnemies = 0;
  let decisionCount = 0;
  let plannerWorkUnits = 0;
  let peakPlannerWorkPerDecision = 0;
  let minimumPhysicalClearance = Number.POSITIVE_INFINITY;
  let fairnessDeferrals = 0;
  let determinismHash = 2_166_136_261;
  let completedSector = 0;
  let specialStates: JetAbilityStates = {
    counterflare: { unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
    "gravity-knot": { unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
    "phoenix-squadron": { unlocked: false, cooldownSeconds: 0, activeSeconds: 0 },
  };
  let counterflareConversionsRemaining = 0;
  let gravityKnotX = 0;
  let gravityKnotY = 0;
  let phoenixStrikeCooldown = 0;
  let phoenixStrikeIndex = 0;
  let specialReliefSpawns = 0;
  let encounterCadence: EncounterCadenceState = createEncounterCadence();
  let encounterSliceSector = 1;
  let activeBossArchetype: BossArchetype | null = null;
  let activeBossSector = 0;
  let bossMotionSeconds = 0;
  let bossEscortWaveIndex = 0;
  let normalWavesCompleted = 0;
  let currentCycleNormalWaves = 0;
  let bossEscortWavesObserved = 0;
  const normalWavesBetweenBosses: number[] = [];
  const bossArchetypesObserved: BossArchetype[] = [];
  const enemyKindsObserved = new Set<EnemyKind>();

  const currentSector = (): number => Math.min(
    targetSector,
    1 + Math.floor(elapsedSeconds / secondsPerSector),
  );

  const hostileTimeScale = (): number => (
    lowProfileTimeWarpRemaining > 0 ? LOW_PROFILE_HOSTILE_TIME_SCALE : 1
  );

  const currentBossEscortWave = () => {
    if (encounterCadence.phase !== "boss" || activeBossArchetype === null) return null;
    return bossEscortWavesForEncounter(activeBossSector, activeBossArchetype)[bossEscortWaveIndex] ?? null;
  };

  const beginCurrentBossStage = (sector: number): void => {
    if (activeBossArchetype === null) {
      activeBossArchetype = BOSS_ARCHETYPES[
        encounterCadence.bossesDefeated % BOSS_ARCHETYPES.length
      ] ?? "ravager";
      activeBossSector = sector;
      bossMotionSeconds = 0;
      bossArchetypesObserved.push(activeBossArchetype);
    }
    bossEscortWavesObserved += 1;
  };

  const completeEncounterSlice = (nextSector: number | null): void => {
    // Production does not carry a cleared normal wave or a defeated boss's
    // hostile screen into the next encounter slice.
    enemies.length = 0;
    projectiles.length = 0;

    if (encounterCadence.phase === "normal-waves") {
      normalWavesCompleted += 1;
      currentCycleNormalWaves += 1;
      encounterCadence = recordNormalWaveClear(encounterCadence);
      if (encounterCadence.phase === "boss-pending" && nextSector !== null) {
        normalWavesBetweenBosses.push(currentCycleNormalWaves);
        currentCycleNormalWaves = 0;
        encounterCadence = beginBossEncounter(encounterCadence);
        bossEscortWaveIndex = 0;
        beginCurrentBossStage(nextSector);
      }
      return;
    }

    if (encounterCadence.phase !== "boss") return;
    if (bossEscortWaveIndex < BOSS_ESCORT_HEALTH_THRESHOLDS.length - 1) {
      if (nextSector !== null) {
        bossEscortWaveIndex += 1;
        beginCurrentBossStage(nextSector);
      }
      return;
    }

    encounterCadence = recordBossDefeat(encounterCadence);
    activeBossArchetype = null;
    activeBossSector = 0;
    bossMotionSeconds = 0;
    bossEscortWaveIndex = 0;
  };

  const advanceEncounterToSector = (sector: number): void => {
    while (encounterSliceSector < sector) {
      encounterSliceSector += 1;
      completeEncounterSlice(encounterSliceSector);
    }
  };

  const spawnEnemy = (slot: number): void => {
    const sector = currentSector();
    const difficulty = difficultyForSector(sector);
    const escortUnit = currentBossEscortWave()?.units[slot];
    const kind = escortUnit?.kind ?? enemyKindForRoll(sector, random());
    const rules = enemyArchetypeForKind(kind);
    const phase = random() * Math.PI * 2;
    const lane = slot % 7;
    const x = escortUnit
      ? escortUnit.normalizedLane * 8.2
      : -8.4 + lane / 6 * 16.8 + (random() - 0.5) * 0.7;
    const y = -1.5 + (slot % 6) * 3.15 + Math.floor(slot / 6) * 0.42;
    enemies.push({
      id: nextEnemyId,
      phase,
      radius: rules.radius,
      kind,
      movementFamily: rules.movementFamily,
      priority: rules.targetPriority,
      health: rules.baseHealth * difficulty.enemyHealthScale * (escortUnit?.elite ? 1.6 : 1),
      x,
      y,
      velocityX: 0,
      velocityY: -0.85,
    });
    enemyKindsObserved.add(kind);
    nextEnemyId += 1;
  };

  const projectileLeavesEscapeRoute = (candidate: MutableThreat): boolean => {
    const timeScale = hostileTimeScale();
    const routePlayerSpeed = PLAYER_SPEED
      * (lowProfileTimeWarpRemaining > 0 ? LOW_PROFILE_PLAYER_SPEED_MULTIPLIER : 1);
    const routePlayerRadius = lowProfileRemaining > 0 ? LOW_PROFILE_RADIUS : PLAYER_RADIUS;
    const routes = 16;
    for (let route = 0; route <= routes; route += 1) {
      const angle = route / routes * Math.PI * 2;
      const routeX = route === routes ? 0 : Math.cos(angle);
      const routeY = route === routes ? 0 : Math.sin(angle);
      let safe = true;
      for (let step = 1; step <= 10 && safe; step += 1) {
        const seconds = step * 0.08;
        const playerX = clampNumber(
          player.x + routeX * routePlayerSpeed * seconds,
          BOUNDS.left + routePlayerRadius,
          BOUNDS.right - routePlayerRadius,
        );
        const playerY = clampNumber(
          player.y + routeY * routePlayerSpeed * seconds,
          BOUNDS.bottom + routePlayerRadius,
          BOUNDS.top - routePlayerRadius,
        );
        const corridor = sampleCaveCorridor(
          caveTravel + difficultyForSector(currentSector()).scrollSpeed * timeScale * seconds,
          playerY,
          currentSector(),
        );
        if (caveWallClearance(corridor, playerX, routePlayerRadius + 0.12, 0) <= 0) {
          safe = false;
          break;
        }
        for (const threat of [...projectiles, candidate]) {
          const threatX = threat.x + threat.velocityX * timeScale * seconds;
          const threatY = threat.y + threat.velocityY * timeScale * seconds;
          const radius = routePlayerRadius + 0.12 + threat.radius;
          if ((playerX - threatX) ** 2 + (playerY - threatY) ** 2 <= radius ** 2) {
            safe = false;
            break;
          }
        }
      }
      if (safe) return true;
    }
    return false;
  };

  const spawnProjectile = (slot: number): void => {
    const difficulty = difficultyForSector(currentSector());
    const rocketCount = projectiles.reduce((count, threat) => count + Number(threat.kind === "rocket"), 0);
    const rocket = rocketCount < difficulty.maxEnemyRockets && slot % 7 === 0;
    const pattern = slot % 4;
    const speed = difficulty.enemyProjectileSpeed * (rocket ? 0.72 * 1.1 : pattern === 3 ? 1.08 : 0.78 + random() * 0.2);
    let x: number;
    let y: number;
    let targetX: number;
    let targetY: number;

    if (pattern === 1 || pattern === 2) {
      const fromLeft = pattern === 1;
      x = fromLeft ? BOUNDS.left - 1.2 : BOUNDS.right + 1.2;
      y = BOUNDS.bottom + 2 + random() * (BOUNDS.top - BOUNDS.bottom - 4);
      targetX = player.x + (fromLeft ? 7 : -7);
      targetY = player.y + (random() - 0.5) * 7;
    } else {
      x = -8.8 + random() * 17.6;
      // Slots are staggered above the playfield so a full cap is dense without
      // turning one frame into an impossible spawn-on-player event.
      y = BOUNDS.top + 1.2 + (slot % 9) * 1.15;
      targetX = player.x + playerVelocity.x * 0.1 + (random() - 0.5) * 2.1;
      targetY = player.y + playerVelocity.y * 0.08;
    }

    const direction = normalize(targetX - x, targetY - y);
    const candidate: MutableThreat = {
      id: nextProjectileId,
      kind: rocket ? "rocket" : "projectile",
      x,
      y,
      velocityX: direction.x * speed,
      velocityY: direction.y * speed,
      radius: rocket ? 0.3 : pattern === 3 ? 0.24 : 0.2,
      homingSecondsRemaining: rocket ? 3.6 : 0,
    };

    if (specialReliefSpawns > 0) {
      specialReliefSpawns -= 1;
      candidate.x = -8.8 + random() * 17.6;
      candidate.y = BOUNDS.top + 11 + slot % 4;
      const reliefDirection = normalize(player.x - candidate.x, player.y - candidate.y);
      candidate.velocityX = reliefDirection.x * speed;
      candidate.velocityY = reliefDirection.y * speed;
    } else if (!projectileLeavesEscapeRoute(candidate)) {
      fairnessDeferrals += 1;
      candidate.x = -8.8 + random() * 17.6;
      candidate.y = BOUNDS.top + 9 + slot % 5;
      const deferredDirection = normalize(player.x - candidate.x, player.y - candidate.y);
      candidate.velocityX = deferredDirection.x * speed;
      candidate.velocityY = deferredDirection.y * speed;
    }
    projectiles.push(candidate);
    nextProjectileId += 1;
  };

  const fillPressureCaps = (): void => {
    const difficulty = difficultyForSector(currentSector());
    const desiredEnemies = encounterCadence.phase === "boss"
      ? Math.min(difficulty.maxEnemies, currentBossEscortWave()?.plannedSize ?? 0)
      : encounterCadence.phase === "normal-waves"
        ? Math.min(difficulty.maxEnemies, normalWaveSpawnCount(encounterCadence))
        : 0;
    if (enemies.length > desiredEnemies) enemies.length = desiredEnemies;
    while (enemies.length < desiredEnemies) spawnEnemy(enemies.length);
    while (projectiles.length < difficulty.maxEnemyProjectiles) spawnProjectile(projectiles.length);
    peakObservedEnemies = Math.max(peakObservedEnemies, enemies.length);
    peakObservedProjectiles = Math.max(peakObservedProjectiles, projectiles.length);
  };

  const maybeSpawnRepair = (): void => {
    const sector = currentSector();
    if (sector < 10 || sector % 10 !== 0 || lastRepairSector === sector) return;
    const rowY = Math.min(BOUNDS.top - 2, player.y + 3.2);
    const corridor = sampleCaveCorridor(caveTravel, rowY, sector);
    repairs.push({
      id: nextRepairId,
      x: corridor.center,
      y: rowY,
      radius: 0.66,
      velocityY: -2,
    });
    nextRepairId += 1;
    lastRepairSector = sector;
  };

  const asBrainPickup = (repair: MutableRepair, worldTimeScale: number): BrainPickup => ({
    id: `survival-repair-${repair.id}`,
    kind: "pulse",
    position: { x: repair.x, y: repair.y },
    velocity: { x: 0, y: repair.velocityY * worldTimeScale },
    radius: repair.radius,
    value: 1,
    healthValue: (3 - livesRemaining) * 2.2,
    safety: 1,
  });

  const collectGuaranteedAbilityCores = (): void => {
    const sector = currentSector();
    const unlock = (kind: keyof JetAbilityStates): void => {
      if (specialStates[kind].unlocked) return;
      specialStates = {
        ...specialStates,
        [kind]: { unlocked: true, cooldownSeconds: 0, activeSeconds: 0 },
      };
      abilityCoresCollected += 1;
    };

    // Mirrors nextGuaranteedAbilityCore: Gravity is offered at sector 3,
    // Phoenix after the first cadence-driven boss, and Counterflare at 12 run
    // seconds. Bosses are no longer inferred from a fixed sector multiple.
    if (sector >= 3) unlock("gravity-knot");
    if (encounterCadence.bossesDefeated >= 1) unlock("phoenix-squadron");
    if (elapsedSeconds >= 12) unlock("counterflare");
  };

  const projectedPressureCounts = (): { nearProjectileCount: number; nearRocketCount: number } => {
    const timeScale = hostileTimeScale();
    let nearProjectileCount = 0;
    let nearRocketCount = 0;
    for (const threat of projectiles) {
      const relativeX = threat.x - player.x;
      const relativeY = threat.y - player.y;
      const relativeVelocityX = threat.velocityX * timeScale - playerVelocity.x;
      const relativeVelocityY = threat.velocityY * timeScale - playerVelocity.y;
      const speedSquared = relativeVelocityX ** 2 + relativeVelocityY ** 2;
      const closingDot = relativeX * relativeVelocityX + relativeY * relativeVelocityY;
      const closestSeconds = speedSquared > 0.001
        ? clampNumber(-closingDot / speedSquared, 0, 0.7)
        : 0;
      const distance = Math.hypot(
        relativeX + relativeVelocityX * closestSeconds,
        relativeY + relativeVelocityY * closestSeconds,
      );
      if (closingDot < 0 && distance <= PLANNING_RADIUS + threat.radius + 1.05) {
        nearProjectileCount += 1;
        if (threat.kind === "rocket") nearRocketCount += 1;
      }
    }
    return { nearProjectileCount, nearRocketCount };
  };

  const activateSpecial = (kind: keyof JetAbilityStates): void => {
    const current = specialStates[kind];
    const next = activateJetAbility(kind, current);
    if (next === current) return;
    specialStates = { ...specialStates, [kind]: next };
    specialUses += 1;
    if (kind === "counterflare") {
      counterflareConversionsRemaining = COUNTERFLARE_CAP;
    } else if (kind === "gravity-knot") {
      gravityKnotX = player.x;
      gravityKnotY = Math.min(BOUNDS.top - 2.5, player.y + 5.2);
    } else {
      phoenixStrikeCooldown = 0;
      phoenixStrikeIndex = 0;
    }
  };

  const applySpecialEffects = (deltaSeconds: number): void => {
    for (let index = projectiles.length - 1; index >= 0; index -= 1) {
      const threat = projectiles[index];
      if (!threat) continue;
      if (
        specialStates.counterflare.activeSeconds > 0
        && counterflareConversionsRemaining > 0
        && Math.hypot(threat.x - player.x, threat.y - player.y) <= COUNTERFLARE_RADIUS
      ) {
        projectiles.splice(index, 1);
        counterflareConversionsRemaining -= 1;
        specialReliefSpawns += 1;
        continue;
      }
      if (
        specialStates["gravity-knot"].activeSeconds > 0
        && Math.hypot(threat.x - gravityKnotX, threat.y - gravityKnotY) <= GRAVITY_KNOT_RADIUS
      ) {
        projectiles.splice(index, 1);
        specialReliefSpawns += 1;
      }
    }

    if (specialStates["phoenix-squadron"].activeSeconds > 0) {
      phoenixStrikeCooldown -= deltaSeconds;
      while (phoenixStrikeCooldown <= 0 && phoenixStrikeIndex < 8) {
        const enemy = enemies[phoenixStrikeIndex % Math.max(1, enemies.length)];
        const laneX = clampNumber(
          enemy?.x ?? player.x + (phoenixStrikeIndex % 3 - 1) * 3.2,
          BOUNDS.left + 1.2,
          BOUNDS.right - 1.2,
        );
        phoenixStrikeIndex += 1;
        phoenixStrikeCooldown += 0.68;
        for (let index = projectiles.length - 1; index >= 0; index -= 1) {
          const threat = projectiles[index];
          if (threat && Math.abs(threat.x - laneX) <= PHOENIX_LANE_RADIUS) {
            projectiles.splice(index, 1);
            specialReliefSpawns += 1;
          }
        }
      }
    }
  };

  const currentBossHealthRatio = (): number => (
    encounterCadence.phase === "boss"
      ? BOSS_ESCORT_HEALTH_THRESHOLDS[bossEscortWaveIndex] ?? 1
      : 1
  );

  const currentBossPhase = (): BossPhase => {
    const ratio = currentBossHealthRatio();
    return ratio > 2 / 3 ? 1 : ratio > 1 / 3 ? 2 : 3;
  };

  const bossPoseAt = (seconds: number): { x: number; y: number; velocityX: number; velocityY: number } => {
    if (activeBossArchetype === null) {
      return { x: 0, y: BOUNDS.top - 4.5, velocityX: 0, velocityY: 0 };
    }
    const archetypeIndex = Math.max(0, BOSS_ARCHETYPES.indexOf(activeBossArchetype));
    const frequency = 0.58 + archetypeIndex * 0.055;
    const phase = seconds * frequency + encounterCadence.bossesDefeated * 0.71;
    const amplitudeX = 4.7 + archetypeIndex * 0.18;
    const amplitudeY = 0.85 + (archetypeIndex % 3) * 0.22;
    return {
      x: Math.sin(phase) * amplitudeX,
      y: BOUNDS.top - 4.8 + Math.cos(phase * 1.37) * amplitudeY,
      velocityX: Math.cos(phase) * amplitudeX * frequency,
      velocityY: -Math.sin(phase * 1.37) * amplitudeY * frequency * 1.37,
    };
  };

  const observe = (): BrainObservation => {
    const counts = projectedPressureCounts();
    const difficulty = difficultyForSector(currentSector());
    const timeScale = hostileTimeScale();
    const bossActive = encounterCadence.phase === "boss" && activeBossArchetype !== null;
    const bossPose = bossPoseAt(bossMotionSeconds);
    const bossRatio = currentBossHealthRatio();
    const bossMaximumHealth = activeBossArchetype === null
      ? 0
      : bossHealthForSector(activeBossSector, activeBossArchetype);
    const bossThreat: BrainThreat[] = bossActive
      ? [{
          id: `dense-boss-${encounterCadence.bossesDefeated}`,
          kind: "boss",
          position: { x: bossPose.x, y: bossPose.y },
          velocity: {
            x: bossPose.velocityX * timeScale,
            y: bossPose.velocityY * timeScale,
          },
          radius: BOSS_RADIUS,
        }]
      : [];
    const bossTarget: BrainTarget[] = bossActive
      ? [{
          id: `dense-boss-${encounterCadence.bossesDefeated}`,
          kind: "boss",
          position: { x: bossPose.x, y: bossPose.y },
          velocity: {
            x: bossPose.velocityX * timeScale,
            y: bossPose.velocityY * timeScale,
          },
          radius: BOSS_RADIUS,
          priority: 15,
          health: bossMaximumHealth * bossRatio,
          damageable: true,
          visible: true,
          weaponReachable: true,
          committedDamage: 0,
        }]
      : [];
    return {
    player: {
      position: player,
      velocity: playerVelocity,
      radius: PLANNING_RADIUS,
      maxSpeed: PLAYER_SPEED
        * (lowProfileTimeWarpRemaining > 0 ? LOW_PROFILE_PLAYER_SPEED_MULTIPLIER : 1),
    },
    bounds: BOUNDS,
    terrain: {
      travelDistance: caveTravel,
      scrollSpeed: difficulty.scrollSpeed * timeScale,
      sector: currentSector(),
    },
    threats: [
      ...projectiles.map((threat) => asBrainThreat(threat, timeScale)),
      ...enemies.map((enemy) => asEnemyThreat(enemy, timeScale)),
      ...bossThreat,
    ],
    targets: [
      ...enemies.map((enemy) => asEnemyTarget(enemy, timeScale)),
      ...bossTarget,
    ],
    pickups: repairs.map((repair) => asBrainPickup(repair, timeScale)),
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
        totalProjectileCount: projectiles.length,
        gravityTargetCount: enemies.reduce((count, enemy) => (
          count + Number(Math.hypot(
            enemy.x - player.x,
            enemy.y - Math.min(BOUNDS.top - 2.5, player.y + 5.2),
          ) <= 4.6)
        ), 0),
        bossActive,
        bossEntering: false,
        bossPhase: currentBossPhase(),
        bossHealthRatio: bossRatio,
        bossDamageable: bossActive,
        escortCount: bossActive ? enemies.length : 0,
        terminalProgress: difficulty.terminalProgress,
        stasisActive: false,
        dashBurstActive: false,
      },
    },
  };
  };

  const takeDamage = (kind: "projectile" | "enemy" | "terrain"): void => {
    if (damageGraceRemaining > 0) return;
    livesRemaining -= 1;
    damageGraceRemaining = DAMAGE_GRACE_SECONDS;
    damageSectors.push(currentSector());
    // Production grants 2.4 seconds and clears a 6.5-unit projectile bubble
    // on respawn. Replacements remain at the exact cap but are deferred above
    // the arena, preserving both that breathing room and maximum observation.
    for (let index = projectiles.length - 1; index >= 0; index -= 1) {
      const threat = projectiles[index];
      if (threat && Math.hypot(threat.x - player.x, threat.y - player.y)
        <= RESPAWN_PROJECTILE_CLEAR_RADIUS) {
        projectiles.splice(index, 1);
        specialReliefSpawns += 1;
      }
    }
    if (kind === "projectile") projectileHits += 1;
    if (kind === "enemy") enemyHits += 1;
    if (kind === "terrain") terrainHits += 1;
  };

  const totalDuration = targetSector * secondsPerSector;
  while (elapsedSeconds < totalDuration - EPSILON && livesRemaining > 0) {
    const deltaSeconds = Math.min(PHYSICS_STEP_SECONDS, totalDuration - elapsedSeconds);
    const sector = currentSector();
    advanceEncounterToSector(sector);
    const difficulty = difficultyForSector(sector);
    fillPressureCaps();
    maybeSpawnRepair();
    collectGuaranteedAbilityCores();

    if (dashRemaining <= 0 && nextDecisionSeconds <= elapsedSeconds + EPSILON) {
      const observation = observe();
      const decision = controller.decide(observation);
      movement = decision.movement;
      decisionCount += 1;
      const decisionWork = plannerWorkPerDecision(
        config,
        observation.abilities.lowProfileReady,
        observation.abilities.dashReady,
        decision.lookaheadUsed,
      );
      plannerWorkUnits += decisionWork;
      peakPlannerWorkPerDecision = Math.max(peakPlannerWorkPerDecision, decisionWork);
      if (decision.useLowProfile && lowProfileCooldown <= 0) {
        lowProfileRemaining = LOW_PROFILE_SECONDS;
        lowProfileTimeWarpRemaining = LOW_PROFILE_TIME_WARP_SECONDS;
        lowProfileCooldown = LOW_PROFILE_COOLDOWN_SECONDS;
        lowProfileUses += 1;
      }
      if (decision.useDash && dashCooldown <= 0) {
        dashDirection = decision.movement;
        dashRemaining = DASH_SECONDS;
        dashCooldown = DASH_COOLDOWN_SECONDS;
      }
      if (decision.useCounterflare) activateSpecial("counterflare");
      if (decision.useGravityKnot) activateSpecial("gravity-knot");
      if (decision.usePhoenixSquadron) activateSpecial("phoenix-squadron");
      nextDecisionSeconds = elapsedSeconds + SUPER_BRAIN_DECISION_INTERVAL_SECONDS;
      determinismHash = hashNumber(determinismHash, decision.movement.x);
      determinismHash = hashNumber(determinismHash, decision.movement.y);
      determinismHash = hashNumber(determinismHash, decision.predictedClearance);
      determinismHash = hashNumber(
        determinismHash,
        ["evade", "stabilize", "recover", "collect", "engage"].indexOf(decision.regime),
      );
      for (const plannedMove of decision.plannedMoves) {
        determinismHash = hashNumber(determinismHash, plannedMove.x);
        determinismHash = hashNumber(determinismHash, plannedMove.y);
      }
    }

    applySpecialEffects(deltaSeconds);

    const timeScale = hostileTimeScale();
    const hostileDeltaSeconds = deltaSeconds * timeScale;
    const worldDeltaSeconds = hostileDeltaSeconds;
    if (lowProfileTimeWarpRemaining > 0) {
      lowProfileTimeWarpSeconds += Math.min(deltaSeconds, lowProfileTimeWarpRemaining);
    }
    previousPlayer = { ...player };
    const activeMovement = dashRemaining > 0 ? dashDirection : movement;
    const cruiseSpeed = PLAYER_SPEED
      * (lowProfileTimeWarpRemaining > 0 ? LOW_PROFILE_PLAYER_SPEED_MULTIPLIER : 1);
    const activeSpeed = dashRemaining > 0 ? cruiseSpeed * DASH_SPEED_MULTIPLIER : cruiseSpeed;
    const playerRadius = lowProfileRemaining > 0 ? LOW_PROFILE_RADIUS : PLAYER_RADIUS;
    player = {
      x: clampNumber(player.x + activeMovement.x * activeSpeed * deltaSeconds, BOUNDS.left + 1.2, BOUNDS.right - 1.2),
      y: clampNumber(player.y + activeMovement.y * activeSpeed * deltaSeconds, BOUNDS.bottom + 1.42, BOUNDS.top - 1.42),
    };
    playerVelocity = {
      x: (player.x - previousPlayer.x) / deltaSeconds,
      y: (player.y - previousPlayer.y) / deltaSeconds,
    };
    caveTravel += difficulty.scrollSpeed * worldDeltaSeconds;

    const corridor = sampleCaveCorridor(caveTravel, player.y, sector);
    const physicalClearance = caveWallClearance(corridor, player.x, playerRadius, 0);
    minimumPhysicalClearance = Math.min(minimumPhysicalClearance, physicalClearance);
    if (physicalClearance <= 0) {
      takeDamage("terrain");
      player = {
        x: clampNumber(player.x, corridor.wallLeft + playerRadius + 0.06, corridor.wallRight - playerRadius - 0.06),
        y: player.y,
      };
      movement = { x: 0, y: 0 };
      dashRemaining = 0;
    }

    for (let index = projectiles.length - 1; index >= 0; index -= 1) {
      const threat = projectiles[index];
      if (!threat) continue;
      const previousX = threat.x;
      const previousY = threat.y;
      if (threat.kind === "rocket" && threat.homingSecondsRemaining > 0) {
        const speed = Math.hypot(threat.velocityX, threat.velocityY);
        const target = normalize(player.x - threat.x, player.y - threat.y);
        const steering = Math.min(1, hostileDeltaSeconds * 1.15);
        const steered = normalize(
          threat.velocityX / Math.max(speed, EPSILON) * (1 - steering) + target.x * steering,
          threat.velocityY / Math.max(speed, EPSILON) * (1 - steering) + target.y * steering,
        );
        threat.velocityX = steered.x * speed;
        threat.velocityY = steered.y * speed;
        threat.homingSecondsRemaining = Math.max(
          0,
          threat.homingSecondsRemaining - hostileDeltaSeconds,
        );
      }
      threat.x += threat.velocityX * hostileDeltaSeconds;
      threat.y += threat.velocityY * hostileDeltaSeconds;
      if (movingCirclesOverlap(
        previousX,
        previousY,
        threat.x,
        threat.y,
        threat.radius,
        previousPlayer.x,
        previousPlayer.y,
        player.x,
        player.y,
        playerRadius,
      )) {
        projectiles.splice(index, 1);
        takeDamage("projectile");
        continue;
      }
      if (
        threat.x < BOUNDS.left - 4 || threat.x > BOUNDS.right + 4
        || threat.y < BOUNDS.bottom - 4 || threat.y > BOUNDS.top + 13
      ) {
        projectiles.splice(index, 1);
      }
    }

    for (let index = enemies.length - 1; index >= 0; index -= 1) {
      const enemy = enemies[index];
      if (!enemy) continue;
      const previousX = enemy.x;
      const previousY = enemy.y;
      const tuning = enemyMovementTuning(enemy.movementFamily);
      const phase = enemy.phase
        + elapsedSeconds * tuning.lateralRate * (0.9 + (enemy.id % 5) * 0.04);
      const desiredX = clampNumber(
        Math.sin(phase) * tuning.lateralAmplitude + player.x * tuning.pursuitWeight,
        -8.7,
        8.7,
      );
      const maximumLateralSpeed = (4.2 + tuning.lateralRate * 1.7)
        * difficulty.enemyMovementSpeedScale;
      enemy.velocityX = clampNumber(
        (desiredX - enemy.x) * (1.05 + tuning.lateralRate * 0.28),
        -maximumLateralSpeed,
        maximumLateralSpeed,
      );
      enemy.velocityY = -(0.68 + (enemy.id % 4) * 0.16)
        * tuning.descentScale
        * difficulty.enemyMovementSpeedScale;
      enemy.x += enemy.velocityX * hostileDeltaSeconds;
      enemy.y += enemy.velocityY * hostileDeltaSeconds;
      if (movingCirclesOverlap(
        previousX,
        previousY,
        enemy.x,
        enemy.y,
        enemy.radius,
        previousPlayer.x,
        previousPlayer.y,
        player.x,
        player.y,
        playerRadius,
      )) {
        enemies.splice(index, 1);
        takeDamage("enemy");
        continue;
      }
      if (enemy.y < BOUNDS.bottom - 2) enemies.splice(index, 1);
    }

    if (encounterCadence.phase === "boss" && activeBossArchetype !== null) {
      const previousBossPose = bossPoseAt(bossMotionSeconds);
      bossMotionSeconds += hostileDeltaSeconds;
      const currentBossPose = bossPoseAt(bossMotionSeconds);
      if (movingCirclesOverlap(
        previousBossPose.x,
        previousBossPose.y,
        currentBossPose.x,
        currentBossPose.y,
        BOSS_RADIUS,
        previousPlayer.x,
        previousPlayer.y,
        player.x,
        player.y,
        playerRadius,
      )) {
        takeDamage("enemy");
      }
    }

    for (let index = repairs.length - 1; index >= 0; index -= 1) {
      const repair = repairs[index];
      if (!repair) continue;
      repair.y += repair.velocityY * worldDeltaSeconds;
      if (Math.hypot(repair.x - player.x, repair.y - player.y) <= repair.radius + playerRadius) {
        repairs.splice(index, 1);
        livesRemaining = Math.min(3, livesRemaining + 1);
        repairsCollected += 1;
      } else if (repair.y < BOUNDS.bottom - 2) {
        repairs.splice(index, 1);
      }
    }

    dashRemaining = Math.max(0, dashRemaining - deltaSeconds);
    dashCooldown = Math.max(0, dashCooldown - deltaSeconds);
    lowProfileRemaining = Math.max(0, lowProfileRemaining - deltaSeconds);
    lowProfileCooldown = Math.max(0, lowProfileCooldown - deltaSeconds);
    lowProfileTimeWarpRemaining = Math.max(0, lowProfileTimeWarpRemaining - deltaSeconds);
    damageGraceRemaining = Math.max(0, damageGraceRemaining - deltaSeconds);
    specialStates = {
      counterflare: tickJetAbilityState(specialStates.counterflare, deltaSeconds),
      "gravity-knot": tickJetAbilityState(specialStates["gravity-knot"], deltaSeconds),
      "phoenix-squadron": tickJetAbilityState(specialStates["phoenix-squadron"], deltaSeconds),
    };
    elapsedSeconds += deltaSeconds;
    completedSector = Math.min(targetSector, Math.floor(elapsedSeconds / secondsPerSector));
    determinismHash = hashNumber(determinismHash, player.x);
    determinismHash = hashNumber(determinismHash, player.y);
  }

  const survived = livesRemaining > 0 && elapsedSeconds >= totalDuration - EPSILON;
  if (survived) completeEncounterSlice(null);
  return {
    seed,
    targetSector,
    completedSector: survived ? targetSector : Math.max(0, completedSector),
    survived,
    livesRemaining,
    projectileHits,
    enemyHits,
    terrainHits,
    repairsCollected,
    abilityCoresCollected,
    specialUses,
    lowProfileUses,
    lowProfileTimeWarpSeconds,
    normalWavesCompleted,
    bossesDefeated: encounterCadence.bossesDefeated,
    bossEscortWavesObserved,
    normalWavesBetweenBosses: Object.freeze(normalWavesBetweenBosses),
    bossArchetypesObserved: Object.freeze(bossArchetypesObserved),
    enemyKindsObserved: Object.freeze(
      enemyKindsForSector(targetSector).filter((kind) => enemyKindsObserved.has(kind)),
    ),
    damageSectors: Object.freeze(damageSectors),
    peakObservedProjectiles,
    peakObservedEnemies,
    decisionCount,
    plannerWorkUnits,
    peakPlannerWorkPerDecision,
    minimumPhysicalClearance,
    fairnessDeferrals,
    determinismHash,
  };
}

export function evaluateBrainSurvivalConfig(
  configOverrides: Partial<SuperBrainConfig> = {},
  seeds: readonly number[] = BRAIN_SURVIVAL_SEARCH_SEEDS,
): BrainSurvivalEvaluation {
  const config = Object.freeze({ ...DEFAULT_SUPER_BRAIN_CONFIG, ...configOverrides });
  const results = seeds.map((seed) => runBrainSurvivalSimulation({ seed, brainConfig: config }));
  const totalHits = results.reduce(
    (sum, result) => sum + result.projectileHits + result.enemyHits + result.terrainHits,
    0,
  );
  return {
    config,
    seeds: Object.freeze([...seeds]),
    survivedRuns: results.filter((result) => result.survived).length,
    completedSectorFloor: Math.min(...results.map((result) => result.completedSector)),
    totalHits,
    terrainHits: results.reduce((sum, result) => sum + result.terrainHits, 0),
    meanMinimumClearance: results.reduce((sum, result) => sum + result.minimumPhysicalClearance, 0)
      / Math.max(1, results.length),
    plannerWorkUnits: results.reduce((sum, result) => sum + result.plannerWorkUnits, 0),
    results: Object.freeze(results),
  };
}

function compareEvaluation(first: BrainSurvivalEvaluation, second: BrainSurvivalEvaluation): number {
  if (first.survivedRuns !== second.survivedRuns) return first.survivedRuns - second.survivedRuns;
  if (first.completedSectorFloor !== second.completedSectorFloor) {
    return first.completedSectorFloor - second.completedSectorFloor;
  }
  if (first.totalHits !== second.totalHits) return second.totalHits - first.totalHits;
  if (first.terrainHits !== second.terrainHits) return second.terrainHits - first.terrainHits;
  if (Math.abs(first.meanMinimumClearance - second.meanMinimumClearance) > EPSILON) {
    return first.meanMinimumClearance - second.meanMinimumClearance;
  }
  return second.plannerWorkUnits - first.plannerWorkUnits;
}

const SEARCH_CANDIDATES: readonly Partial<SuperBrainConfig>[] = Object.freeze([
  {},
  { densePressurePartialSpeedScale: 0.35 },
  { planningHorizonSeconds: 1.9, simulationStepSeconds: 0.1, candidateHeadingCount: 32, safeClearanceRatio: 0.98, densePressurePartialSpeedScale: 0.35 },
  { planningHorizonSeconds: 2.1, simulationStepSeconds: 0.1, candidateHeadingCount: 40, safeClearanceRatio: 0.99, densePressurePartialSpeedScale: 0.35 },
  { planningHorizonSeconds: 1.9, simulationStepSeconds: 0.1, candidateHeadingCount: 32, safeClearanceRatio: 0.96 },
  { planningHorizonSeconds: 2.1, simulationStepSeconds: 0.1, candidateHeadingCount: 32, safeClearanceRatio: 0.98 },
  { planningHorizonSeconds: 1.8, simulationStepSeconds: 0.08, candidateHeadingCount: 32, safeClearanceRatio: 0.98 },
  { planningHorizonSeconds: 1.9, simulationStepSeconds: 0.1, candidateHeadingCount: 40, safeClearanceRatio: 0.98 },
  { planningHorizonSeconds: 2.2, simulationStepSeconds: 0.12, candidateHeadingCount: 40, safeClearanceRatio: 0.99 },
  { planningHorizonSeconds: 1.9, simulationStepSeconds: 0.1, candidateHeadingCount: 32, safeClearanceRatio: 0.99, safetyMargin: 0.24 },
  { planningHorizonSeconds: 2.1, simulationStepSeconds: 0.12, candidateHeadingCount: 40, safeClearanceRatio: 0.98, emergencyClearance: 0.78 },
]);

/** Deterministic bounded search; it never expands beyond the fixed candidate table. */
export function hyperoptimizeBrainSurvival(
  seeds: readonly number[] = BRAIN_SURVIVAL_SEARCH_SEEDS,
  plannerBudgetMultiplier = 1.45,
): BrainSurvivalSearchResult {
  const baseline = evaluateBrainSurvivalConfig(BASELINE_BRAIN_SURVIVAL_CONFIG, seeds);
  const plannerBudgetUnits = baseline.plannerWorkUnits * clampNumber(plannerBudgetMultiplier, 1, 2);
  let winner = baseline;
  let winnerIndex = 0;
  let rejectedForPlannerBudget = 0;
  let evaluatedCandidates = 1;

  for (let index = 0; index < SEARCH_CANDIDATES.length; index += 1) {
    const candidate = SEARCH_CANDIDATES[index];
    if (!candidate) continue;
    const evaluation = evaluateBrainSurvivalConfig(candidate, seeds);
    if (evaluation.plannerWorkUnits > plannerBudgetUnits + EPSILON) {
      rejectedForPlannerBudget += 1;
      continue;
    }
    evaluatedCandidates += 1;
    if (compareEvaluation(evaluation, winner) > 0) {
      winner = evaluation;
      winnerIndex = index;
    }
  }

  return {
    baseline,
    winner,
    evaluatedCandidates,
    rejectedForPlannerBudget,
    plannerBudgetUnits,
    winnerIndex,
  };
}
