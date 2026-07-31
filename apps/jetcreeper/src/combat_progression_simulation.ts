import {
  JET_ABILITY_SPECS,
  JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS,
} from "./abilities";
import {
  applyBossEscortDamageGate,
  createBossEscortProgress,
  nextBossEscortWave,
  recordBossEscortWaveLaunch,
  type BossEscortProgress,
} from "./boss_escorts";
import {
  DEFAULT_SUPER_BRAIN_CONFIG,
  type SuperBrainConfig,
  type Vec2,
} from "./autopilot";
import {
  BOSS_ARCHETYPES,
  bossHealthForSector,
  bossPhaseForHealth,
  bossRewardForSector,
  bossRulesForArchetype,
  clampNumber,
  difficultyForSector,
  enemyArchetypeForKind,
  enemyKindForRoll,
  scoreForEnemy,
  type BossArchetype,
  type Difficulty,
  type EnemyKind,
} from "./game_rules";
import {
  LOW_PROFILE_HOSTILE_TIME_SCALE,
  LOW_PROFILE_PLAYER_SPEED_MULTIPLIER,
  LOW_PROFILE_TIME_WARP_SECONDS,
  laserDamageForTarget,
} from "./laser_rules";

/**
 * This is an offensive surrogate, not a second game engine. It deliberately
 * leaves hostile collision pressure to pressure_simulation.ts and measures
 * whether a tuning can turn safe flight time into score efficiently.
 */

export const COMBAT_SAMPLE_SECTORS = Object.freeze([
  1,
  25,
  75,
  150,
  185,
  199,
  200,
] as const);

export type CombatSampleSector = typeof COMBAT_SAMPLE_SECTORS[number];
export type CombatScenarioKind = "formation" | "boss";
export type CombatDamageSource =
  | "cannon"
  | "dash-burst"
  | "low-profile"
  | "missile"
  | "counterflare"
  | "gravity-knot"
  | "phoenix-squadron";

export interface OffensiveBrainTuning {
  /** Seconds of target motion used when choosing the cannon lane. */
  readonly aimLeadSeconds: number;
  readonly targetPriorityWeight: number;
  readonly targetScoreWeight: number;
  readonly targetEfficiencyWeight: number;
  readonly targetExitUrgencyWeight: number;
  readonly targetLaneWeight: number;
  readonly bossFocusWeight: number;
  readonly eliteFocusWeight: number;
  /** Avoid spending damage while an escort health gate clamps the boss. */
  readonly bossGateAvoidanceWeight: number;
  readonly missileMinimumTargets: number;
  readonly missilePriorityThreshold: number;
  readonly dashBurstAlignmentThreshold: number;
  readonly dashBurstMinimumTargetHealth: number;
  readonly laserMinimumAlignedTargets: number;
  readonly laserMinimumAlignedHealth: number;
  readonly counterflareMinimumConversions: number;
  readonly gravityMinimumTargets: number;
  readonly phoenixMinimumTargets: number;
  readonly phoenixBossHealthRatio: number;
}

export interface CombatProgressionTuning {
  readonly route: Readonly<SuperBrainConfig>;
  /** Runtime currently replans every 80 ms. */
  readonly decisionStepSeconds: number;
  readonly offense: Readonly<OffensiveBrainTuning>;
}

export interface CombatProgressionTuningOverrides {
  readonly route?: Partial<SuperBrainConfig>;
  readonly decisionStepSeconds?: number;
  readonly offense?: Partial<OffensiveBrainTuning>;
}

export interface CombatTargetFixture {
  readonly id: string;
  readonly kind: EnemyKind | "boss";
  readonly bossArchetype: BossArchetype | null;
  readonly elite: boolean;
  readonly baseX: number;
  readonly baseY: number;
  readonly radius: number;
  readonly health: number;
  readonly score: number;
  readonly targetPriority: number;
  readonly descentSpeed: number;
  readonly movementAmplitude: number;
  readonly movementFrequency: number;
  readonly movementPhase: number;
}

export interface CombatScenarioFixture {
  readonly id: string;
  readonly kind: CombatScenarioKind;
  readonly sector: number;
  readonly bossArchetype: BossArchetype | null;
  readonly difficulty: Difficulty;
  readonly initialTargets: readonly CombatTargetFixture[];
  readonly maximumSeconds: number;
  readonly weight: number;
}

export interface AbilityValueMeasurement {
  readonly uses: number;
  readonly potentialValue: number;
  readonly realizedValue: number;
  readonly efficiency: number;
}

export interface CombatScenarioResult {
  readonly id: string;
  readonly kind: CombatScenarioKind;
  readonly sector: number;
  readonly bossArchetype: BossArchetype | null;
  readonly clearSeconds: number;
  readonly timedOut: boolean;
  readonly score: number;
  readonly availableScore: number;
  readonly scoreRate: number;
  readonly kills: number;
  readonly escapedTargets: number;
  readonly cannonShots: number;
  readonly cannonHits: number;
  readonly cannonAccuracy: number;
  readonly damageBySource: Readonly<Record<CombatDamageSource, number>>;
  readonly abilityValue: Readonly<Record<CombatDamageSource, AbilityValueMeasurement>>;
  readonly decisionCount: number;
  readonly plannerWorkUnits: number;
  readonly determinismHash: number;
}

export interface CombatProgressionObjective {
  /** Higher is better; comparison remains lexicographic to avoid scale tricks. */
  readonly objectiveScore: number;
  readonly timedOutScenarios: number;
  readonly weightedClearSeconds: number;
  readonly weightedScoreRate: number;
  readonly estimatedSecondsToSector200: number;
  readonly abilityEfficiency: number;
  readonly cannonAccuracy: number;
  readonly plannerWorkUnitsPerSecond: number;
}

export interface CombatProgressionEvaluation {
  readonly tuning: CombatProgressionTuning;
  readonly scenarios: readonly CombatScenarioResult[];
  readonly objective: CombatProgressionObjective;
  readonly determinismHash: number;
}

export interface CombatHyperoptOptions {
  /** Includes the baseline. Values are clamped to 2..96. */
  readonly maximumCandidates?: number;
  /** Deterministic proxy budget relative to production planner work. */
  readonly plannerBudgetMultiplier?: number;
}

export interface CombatHyperoptResult {
  readonly baseline: CombatProgressionEvaluation;
  readonly winner: CombatProgressionEvaluation;
  readonly evaluatedCandidates: number;
  readonly rejectedForPlannerBudget: number;
  readonly plannerWorkBudgetPerSecond: number;
  readonly winnerIndex: number;
}

const WORLD_LEFT = -10;
const WORLD_RIGHT = 10;
const WORLD_BOTTOM = -16;
const WORLD_TOP = 16;
const PLAYER_START_Y = -12.4;
const PLAYER_SPEED = 11.5;
const PLAYER_RADIUS = 0.78;
const CANNON_PROJECTILE_RADIUS = 0.16;
const CANNON_PROJECTILE_SPEED = 18;
const CANNON_INTERVAL_SECONDS = 0.16;
const DASH_SECONDS = 0.38;
const DASH_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS.dash;
const DASH_SPEED_MULTIPLIER = 4;
const DASH_BURST_SECONDS = 1;
const DASH_BURST_INTERVAL_SCALE = 0.1;
const DASH_SCATTER_RADIANS = 5 / 180 * Math.PI;
const LOW_PROFILE_SECONDS = 1.35;
const LOW_PROFILE_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS["low-profile"];
const LASER_DAMAGE_INTERVAL_SECONDS = 0.1;
const MISSILE_COOLDOWN_SECONDS = 5;
const MISSILE_DAMAGE = 5;
const MISSILE_SALVO_SIZE = 4;
const COUNTERFLARE_DAMAGE = 2.2;
const COUNTERFLARE_CONVERSION_CAP = 12;
const GRAVITY_KNOT_RADIUS = 4.45;
const GRAVITY_KNOT_OFFSET_Y = 5.2;
const PHOENIX_STRIKE_INTERVAL_SECONDS = 0.68;
const PHOENIX_STRIKE_CAP = 8;
const PHOENIX_ENEMY_LANE_PADDING = 1.55;
const SECTOR_200_SCORE = 199 * 1_200;
const EPSILON = 1e-9;

export const BASELINE_OFFENSIVE_BRAIN_TUNING: Readonly<OffensiveBrainTuning> = Object.freeze({
  // The current planner predicts targets at its full 2.4 second horizon.
  aimLeadSeconds: 2.4,
  targetPriorityWeight: 1,
  targetScoreWeight: 0,
  targetEfficiencyWeight: 0,
  targetExitUrgencyWeight: 0,
  targetLaneWeight: 0.04,
  bossFocusWeight: 0,
  eliteFocusWeight: 0,
  bossGateAvoidanceWeight: 0,
  missileMinimumTargets: 4,
  missilePriorityThreshold: 2.5,
  // Auto dash/laser/Gravity/Phoenix are currently survival-triggered, so the
  // offense-only baseline leaves them disabled unless a future pressure gate
  // explicitly proves the maneuver safe.
  dashBurstAlignmentThreshold: 1.01,
  dashBurstMinimumTargetHealth: 1_000_000,
  laserMinimumAlignedTargets: 99,
  laserMinimumAlignedHealth: 1_000_000,
  counterflareMinimumConversions: 3,
  gravityMinimumTargets: 99,
  phoenixMinimumTargets: 99,
  phoenixBossHealthRatio: 0,
});

export const BASELINE_COMBAT_PROGRESSION_TUNING: Readonly<CombatProgressionTuning> = Object.freeze({
  route: DEFAULT_SUPER_BRAIN_CONFIG,
  decisionStepSeconds: 0.08,
  offense: BASELINE_OFFENSIVE_BRAIN_TUNING,
});

interface MutableTarget extends CombatTargetFixture {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  currentHealth: number;
  alive: boolean;
}

interface MutableAbilityValue {
  uses: number;
  potentialValue: number;
  realizedValue: number;
}

interface ScenarioState {
  readonly fixture: CombatScenarioFixture;
  readonly tuning: CombatProgressionTuning;
  readonly targets: MutableTarget[];
  readonly damageBySource: Record<CombatDamageSource, number>;
  readonly abilityValue: Record<CombatDamageSource, MutableAbilityValue>;
  bossEscortProgress: BossEscortProgress;
  playerX: number;
  playerY: number;
  movement: Vec2;
  dashDirection: Vec2;
  dashRemaining: number;
  dashCooldown: number;
  burstRemaining: number;
  lowProfileRemaining: number;
  lowProfileCooldown: number;
  lowProfileWarpRemaining: number;
  missileCooldown: number;
  counterflareCooldown: number;
  gravityCooldown: number;
  gravityRemaining: number;
  gravityX: number;
  gravityY: number;
  phoenixCooldown: number;
  phoenixRemaining: number;
  phoenixStrikeCooldown: number;
  phoenixStrikeIndex: number;
  cannonCooldown: number;
  laserCooldown: number;
  nextDecisionSeconds: number;
  selectedTargetId: string | null;
  elapsedSeconds: number;
  hostileElapsedSeconds: number;
  score: number;
  availableScore: number;
  kills: number;
  cannonShots: number;
  cannonHits: number;
  decisionCount: number;
  plannerWorkUnits: number;
  determinismHash: number;
  lastEscortLaunchSeconds: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Production-parity damage for one low-profile laser tick. */
export function combatLowProfileLaserDamage(
  currentHealth: number,
  maximumHealth: number,
): number {
  return laserDamageForTarget(1, currentHealth, maximumHealth, true);
}

/** Hostile clocks advance at one third speed throughout the five-second warp. */
export function combatLowProfileHostileTimeScale(warpRemainingSeconds: number): number {
  return warpRemainingSeconds > 0 ? LOW_PROFILE_HOSTILE_TIME_SCALE : 1;
}

/** Dash keeps its dedicated speed; ordinary flight receives the warp boost. */
export function combatLowProfilePlayerSpeedMultiplier(warpRemainingSeconds: number): number {
  return warpRemainingSeconds > 0 ? LOW_PROFILE_PLAYER_SPEED_MULTIPLIER : 1;
}

function emptyDamageRecord(): Record<CombatDamageSource, number> {
  return {
    cannon: 0,
    "dash-burst": 0,
    "low-profile": 0,
    missile: 0,
    counterflare: 0,
    "gravity-knot": 0,
    "phoenix-squadron": 0,
  };
}

function emptyAbilityValueRecord(): Record<CombatDamageSource, MutableAbilityValue> {
  return Object.fromEntries(Object.keys(emptyDamageRecord()).map((source) => [
    source,
    { uses: 0, potentialValue: 0, realizedValue: 0 },
  ])) as Record<CombatDamageSource, MutableAbilityValue>;
}

function hashNumber(hash: number, value: number): number {
  const finiteValue = Number.isFinite(value) ? value : value > 0 ? 1_000_000 : -1_000_000;
  return Math.imul(hash ^ Math.round(finiteValue * 1_000), 16_777_619) >>> 0;
}

function hashString(hash: number, value: string): number {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next = Math.imul(next ^ value.charCodeAt(index), 16_777_619) >>> 0;
  }
  return next;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function resolveCombatProgressionTuning(
  overrides: CombatProgressionTuningOverrides = {},
): CombatProgressionTuning {
  return {
    route: {
      ...DEFAULT_SUPER_BRAIN_CONFIG,
      ...overrides.route,
    },
    decisionStepSeconds: clampNumber(
      finiteOr(overrides.decisionStepSeconds ?? 0.08, 0.08),
      0.04,
      0.2,
    ),
    offense: {
      ...BASELINE_OFFENSIVE_BRAIN_TUNING,
      ...overrides.offense,
    },
  };
}

function enemyMovementShape(kind: EnemyKind, difficulty: Difficulty): {
  amplitude: number;
  frequency: number;
  descentFactor: number;
} {
  const rules = enemyArchetypeForKind(kind);
  const speed = difficulty.enemyMovementSpeedScale;
  const movementFamily = rules.movementFamily;
  switch (movementFamily) {
    case "orbit":
      return { amplitude: 1.6, frequency: 1.25 * speed, descentFactor: 0.38 };
    case "intercept":
      return { amplitude: 3.6, frequency: 0.82 * speed, descentFactor: 0.38 };
    case "bombing-run":
      return { amplitude: 2.7, frequency: 0.72 * speed, descentFactor: 0.38 };
    case "broadside":
      return { amplitude: 4.2, frequency: 0.42 * speed, descentFactor: 0.18 };
    case "hold-lane":
      return { amplitude: 1.1, frequency: 0.65, descentFactor: 0.035 };
    case "mine-drift":
      return { amplitude: 0.9, frequency: 1.8, descentFactor: 0.28 };
    case "carrier-lane":
      return { amplitude: 3.2, frequency: 0.42, descentFactor: 0.22 };
    case "phase-shift":
      return { amplitude: 4.2, frequency: 1.05 * speed, descentFactor: 0.38 };
    case "strafe-dash":
      return { amplitude: 5.2, frequency: 1.6 * speed, descentFactor: 0.32 };
    case "shield-advance":
      return { amplitude: 0.8, frequency: 0.34 * speed, descentFactor: 0.22 };
    case "blink-ambush":
      return { amplitude: 5.8, frequency: 0.95 * speed, descentFactor: 0.3 };
    case "siphon-pursuit":
      return { amplitude: 3, frequency: 0.9 * speed, descentFactor: 0.34 };
    case "split-flank":
      return { amplitude: 5, frequency: 0.72 * speed, descentFactor: 0.4 };
    case "tether-orbit":
      return { amplitude: 2.5, frequency: 0.58 * speed, descentFactor: 0.14 };
    case "ram-charge":
      return { amplitude: 2, frequency: 1.4 * speed, descentFactor: 0.62 };
    case "cloak-stalk":
      return { amplitude: 4, frequency: 0.5 * speed, descentFactor: 0.25 };
    case "chrono-zigzag":
      return { amplitude: 4.8, frequency: 1.85 * speed, descentFactor: 0.3 };
    case "command-weave":
      return { amplitude: 3.8, frequency: 0.38 * speed, descentFactor: 0.16 };
    case "drift":
      return { amplitude: 0.45, frequency: 0.5, descentFactor: 1 };
    case "tumble":
      return { amplitude: 0.65, frequency: 0.7, descentFactor: 0.38 };
  }

  const exhaustiveMovement: never = movementFamily;
  return exhaustiveMovement;
}

function enemyFixture(
  sector: number,
  index: number,
  count: number,
  kind: EnemyKind,
  elite: boolean,
  prefix: string,
): CombatTargetFixture {
  const difficulty = difficultyForSector(sector);
  const rules = enemyArchetypeForKind(kind);
  const movement = enemyMovementShape(kind, difficulty);
  const lane = count <= 1 ? 0 : index / (count - 1) * 2 - 1;
  const baseX = clampNumber(lane * 7.4 + Math.sin(index * 2.13) * 0.45, -8.2, 8.2);
  // The first row crosses the production Gravity Knot anchor (player Y + 5.2)
  // so the matrix measures V as control rather than declaring it valueless by
  // fixture construction. Later rows still exercise long cannon flight lead.
  const baseY = -2.4 + index % 4 * 3.35;
  const health = Math.max(
    1,
    Math.ceil(rules.baseHealth * difficulty.enemyHealthScale * (elite ? 1.75 : 1)),
  );
  return {
    id: `${prefix}-${kind}-${index}`,
    kind,
    bossArchetype: null,
    elite,
    baseX,
    baseY,
    radius: rules.radius * rules.modelScale * (elite ? 1.12 : 1),
    health,
    score: scoreForEnemy(kind) * (elite ? 2 : 1),
    targetPriority: rules.targetPriority * (elite ? 1.2 : 1),
    descentSpeed: Math.max(
      0.1,
      difficulty.scrollSpeed * movement.descentFactor * difficulty.enemyMovementSpeedScale,
    ),
    movementAmplitude: movement.amplitude,
    movementFrequency: movement.frequency,
    movementPhase: index * 1.61803398875,
  };
}

const BOSS_COMBAT_SHAPES: Readonly<Record<BossArchetype, Readonly<{
  radius: number;
  movementAmplitude: number;
  movementFrequency: number;
}>>> = Object.freeze({
  ravager: Object.freeze({ radius: 2.7, movementAmplitude: 6.25, movementFrequency: 0.48 }),
  stormwing: Object.freeze({ radius: 2.55, movementAmplitude: 6.9, movementFrequency: 0.62 }),
  dreadnought: Object.freeze({ radius: 3.25, movementAmplitude: 6.7, movementFrequency: 0.33 }),
  prism: Object.freeze({ radius: 2.85, movementAmplitude: 5.25, movementFrequency: 0.52 }),
  harvester: Object.freeze({ radius: 3.05, movementAmplitude: 4.5, movementFrequency: 0.6 }),
  chronarch: Object.freeze({ radius: 3.15, movementAmplitude: 5.8, movementFrequency: 0.72 }),
});

function bossFixture(
  sector: number,
  archetype: BossArchetype,
): CombatTargetFixture {
  const health = bossHealthForSector(sector, archetype);
  const combatShape = BOSS_COMBAT_SHAPES[archetype];
  return {
    id: `boss-${sector}-${archetype}`,
    kind: "boss",
    bossArchetype: archetype,
    elite: false,
    baseX: 0,
    baseY: WORLD_TOP - 5.4,
    radius: combatShape.radius,
    health,
    score: bossRewardForSector(sector, archetype),
    targetPriority: 6,
    descentSpeed: 0,
    movementAmplitude: combatShape.movementAmplitude,
    movementFrequency: combatShape.movementFrequency,
    movementPhase: 0,
  };
}

/**
 * Builds one production-scaled boss encounter for milestone acceptance tests.
 * The optimizer's broad matrix keeps a generous timeout, while callers can
 * use a tighter ceiling to prove that a real progression boss stays playable.
 */
export function createBossCombatScenarioFixture(
  sector: number,
  archetype: BossArchetype,
  maximumSeconds = 210,
): CombatScenarioFixture {
  const normalizedSector = Number.isFinite(sector) ? Math.max(1, Math.floor(sector)) : 1;
  const difficulty = difficultyForSector(normalizedSector);
  const safeMaximumSeconds = Number.isFinite(maximumSeconds)
    ? Math.max(1, maximumSeconds)
    : 210;

  return Object.freeze({
    id: `boss-${normalizedSector}-${archetype}`,
    kind: "boss",
    sector: normalizedSector,
    bossArchetype: archetype,
    difficulty,
    initialTargets: Object.freeze([bossFixture(normalizedSector, archetype)]),
    maximumSeconds: safeMaximumSeconds,
    weight: (0.9 + Math.pow(difficulty.terminalProgress, 1.4) * 2.6)
      * bossRulesForArchetype(archetype).rewardMultiplier,
  });
}

export function createCombatScenarioFixtures(): readonly CombatScenarioFixture[] {
  const fixtures: CombatScenarioFixture[] = [];

  for (const sector of COMBAT_SAMPLE_SECTORS) {
    const difficulty = difficultyForSector(sector);
    const targetCount = Math.min(12, Math.max(4, difficulty.maxFormationSize + 3));
    const targets = Array.from({ length: targetCount }, (_, index) => {
      const kind = enemyKindForRoll(sector, (index + 0.5) / targetCount);
      const elite = (index + 0.5) / targetCount <= difficulty.eliteChance;
      return enemyFixture(sector, index, targetCount, kind, elite, `formation-${sector}`);
    });
    fixtures.push(Object.freeze({
      id: `formation-${sector}`,
      kind: "formation",
      sector,
      bossArchetype: null,
      difficulty,
      initialTargets: Object.freeze(targets),
      maximumSeconds: 180,
      weight: 0.8 + Math.pow(difficulty.terminalProgress, 1.4) * 2.2,
    }));

    for (const archetype of BOSS_ARCHETYPES) {
      fixtures.push(createBossCombatScenarioFixture(sector, archetype, 900));
    }
  }

  return Object.freeze(fixtures);
}

const COMBAT_SCENARIO_FIXTURES = createCombatScenarioFixtures();

function mutableTarget(fixture: CombatTargetFixture): MutableTarget {
  return {
    ...fixture,
    x: fixture.baseX,
    y: fixture.baseY,
    velocityX: 0,
    velocityY: 0,
    currentHealth: fixture.health,
    alive: true,
  };
}

function livingTargets(state: ScenarioState): MutableTarget[] {
  return state.targets.filter((target) => target.alive);
}

function activeBoss(state: ScenarioState): MutableTarget | undefined {
  return state.targets.find((target) => target.alive && target.kind === "boss");
}

function bossIsDamageGated(state: ScenarioState, target: MutableTarget): boolean {
  if (target.kind !== "boss") return false;
  if (state.bossEscortProgress.launchedWaves === 0) {
    return target.currentHealth <= target.health * 0.78 + EPSILON;
  }
  if (state.bossEscortProgress.launchedWaves === 1) {
    return target.currentHealth <= target.health * 0.42 + EPSILON;
  }
  return false;
}

function targetScore(state: ScenarioState, target: MutableTarget): number {
  const offense = state.tuning.offense;
  const priority = clampNumber(target.targetPriority / 9, 0, 1.4);
  const score = clampNumber(Math.log1p(target.score) / Math.log1p(22_000), 0, 1.2);
  const efficiency = clampNumber(target.score / Math.max(1, target.currentHealth) / 125, 0, 1.4);
  const exitSeconds = target.descentSpeed > EPSILON
    ? (target.y - WORLD_BOTTOM + target.radius) / target.descentSpeed
    : 60;
  const urgency = 1 - clampNumber(exitSeconds / 18, 0, 1);
  const lane = 1 - clampNumber(Math.abs(target.x - state.playerX) / 10, 0, 1);
  const boss = target.kind === "boss" ? 1 : 0;
  const elite = target.elite ? 1 : 0;
  const gated = bossIsDamageGated(state, target) ? 1 : 0;
  return priority * offense.targetPriorityWeight
    + score * offense.targetScoreWeight
    + efficiency * offense.targetEfficiencyWeight
    + urgency * offense.targetExitUrgencyWeight
    + lane * offense.targetLaneWeight
    + boss * offense.bossFocusWeight
    + elite * offense.eliteFocusWeight
    - gated * offense.bossGateAvoidanceWeight;
}

function selectTarget(state: ScenarioState): MutableTarget | undefined {
  let selected: MutableTarget | undefined;
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (const target of state.targets) {
    if (!target.alive) continue;
    const score = targetScore(state, target);
    if (
      score > selectedScore + EPSILON
      || (Math.abs(score - selectedScore) <= EPSILON && target.id < (selected?.id ?? "~"))
    ) {
      selected = target;
      selectedScore = score;
    }
  }
  return selected;
}

function predictedTargetX(target: MutableTarget, seconds: number): number {
  return clampNumber(target.x + target.velocityX * seconds, WORLD_LEFT + target.radius, WORLD_RIGHT - target.radius);
}

function routeDecision(state: ScenarioState, target: MutableTarget | undefined): Vec2 {
  if (!target) return { x: 0, y: 0 };
  const route = state.tuning.route;
  const aimX = predictedTargetX(target, clampNumber(state.tuning.offense.aimLeadSeconds, 0, 4));
  const deltaX = aimX - state.playerX;
  const deltaY = clampNumber(route.neutralY, WORLD_BOTTOM + PLAYER_RADIUS, WORLD_TOP - PLAYER_RADIUS)
    - state.playerY;
  const angle = Math.atan2(deltaY * 0.18, deltaX);
  const headingCount = Math.max(8, Math.min(48, Math.floor(route.candidateHeadingCount)));
  const headingStep = Math.PI * 2 / headingCount;
  const quantizedAngle = Math.round(angle / headingStep) * headingStep;
  const horizon = Math.max(0.4, route.planningHorizonSeconds);
  const cruiseSpeed = PLAYER_SPEED
    * combatLowProfilePlayerSpeedMultiplier(state.lowProfileWarpRemaining);
  const magnitude = clampNumber(Math.hypot(deltaX, deltaY * 0.18) / (cruiseSpeed * horizon), 0, 1);
  return {
    x: Math.cos(quantizedAngle) * magnitude,
    y: Math.sin(quantizedAngle) * magnitude,
  };
}

function bossDesiredPosition(target: MutableTarget, seconds: number): { x: number; y: number } {
  const phase = bossPhaseForHealth(target.currentHealth, target.health);
  const movementSpeed = 0.48 + (phase - 1) * 0.08;
  const movementTime = seconds * movementSpeed;
  switch (target.bossArchetype) {
    case "stormwing":
      return {
        x: Math.sin(movementTime * 1.3) * 6.9,
        y: WORLD_TOP - 5.4 - Math.max(0, Math.sin(movementTime * 0.72)) * (2.3 + phase * 0.65),
      };
    case "dreadnought":
      return {
        x: Math.sin(movementTime * 0.68) * 6.7,
        y: WORLD_TOP - 5.4 + Math.sin(movementTime * 1.25) * 0.48,
      };
    case "prism":
      return {
        x: Math.cos(movementTime * 1.08) * 5.25,
        y: WORLD_TOP - 6.1 + Math.sin(movementTime * 1.08) * 1.9,
      };
    case "harvester": {
      const pursuitStep = clampNumber(stateFreePursuitX(target) - target.x, -0.24, 0.24);
      return {
        x: clampNumber(target.x + pursuitStep, -7.2, 7.2),
        y: WORLD_TOP - 6.5 + Math.sin(movementTime * 1.55) * 1.15,
      };
    }
    case "ravager":
    default:
      return {
        x: Math.sin(movementTime) * 6.25,
        y: WORLD_TOP - 5.4 + Math.sin(movementTime * 2) * 1.05,
      };
  }
}

// Harvester pursuit depends on the player in production. The surrogate keeps
// this helper deterministic and replaces the target in updateTargetPositions.
function stateFreePursuitX(target: MutableTarget): number {
  return target.baseX;
}

function updateTargetPositions(
  state: ScenarioState,
  deltaSeconds: number,
  hostileDeltaSeconds: number,
): void {
  for (const target of state.targets) {
    if (!target.alive) continue;
    const previousX = target.x;
    const previousY = target.y;
    let desiredX: number;
    let desiredY: number;

    if (target.kind === "boss") {
      const desired = bossDesiredPosition(target, state.hostileElapsedSeconds);
      desiredX = target.bossArchetype === "harvester"
        ? target.x + clampNumber(
            state.playerX - target.x,
            -hostileDeltaSeconds * 4.2,
            hostileDeltaSeconds * 4.2,
          )
        : desired.x;
      desiredY = desired.y;
    } else {
      const phase = target.movementPhase
        + state.hostileElapsedSeconds * target.movementFrequency;
      desiredX = clampNumber(
        target.baseX + Math.sin(phase) * target.movementAmplitude,
        WORLD_LEFT + target.radius,
        WORLD_RIGHT - target.radius,
      );
      desiredY = target.baseY + Math.sin(phase * 0.43) * 0.42;
    }

    const held = state.gravityRemaining > 0
      && Math.hypot(target.x - state.gravityX, target.y - state.gravityY) <= GRAVITY_KNOT_RADIUS;
    const movementScale = held ? 0.14 : 1;
    target.x += (desiredX - target.x) * movementScale;
    target.y += (desiredY - target.y) * movementScale;
    target.velocityX = (target.x - previousX) / Math.max(deltaSeconds, EPSILON);
    target.velocityY = (target.y - previousY) / Math.max(deltaSeconds, EPSILON);

    if (held) {
      state.abilityValue["gravity-knot"].realizedValue += deltaSeconds;
      state.damageBySource["gravity-knot"] += deltaSeconds;
    }
  }
}

function addTarget(state: ScenarioState, target: CombatTargetFixture): void {
  state.targets.push(mutableTarget(target));
  state.availableScore += target.score;
  state.determinismHash = hashString(state.determinismHash, target.id);
}

function launchDueEscortWave(state: ScenarioState): void {
  const boss = activeBoss(state);
  const archetype = state.fixture.bossArchetype;
  if (!boss || !archetype) return;
  const wave = nextBossEscortWave(state.bossEscortProgress, {
    sector: state.fixture.sector,
    archetype,
    entering: false,
    encounterSeconds: state.elapsedSeconds,
    // Production compares this exact gated health in health space, so the
    // surrogate must use the unmodified value and catch any future deadlock.
    bossHealth: boss.currentHealth,
    bossMaxHealth: boss.health,
    bossPhase: bossPhaseForHealth(boss.currentHealth, boss.health),
    availableEnemySlots: state.fixture.difficulty.maxEnemies,
  });
  if (!wave) return;

  state.bossEscortProgress = recordBossEscortWaveLaunch(
    state.bossEscortProgress,
    wave,
    state.elapsedSeconds,
  );
  state.lastEscortLaunchSeconds = state.elapsedSeconds;
  for (const [index, unit] of wave.units.entries()) {
    const fixture = enemyFixture(
      state.fixture.sector,
      index,
      wave.units.length,
      unit.kind,
      unit.elite,
      `${state.fixture.id}-escort-${wave.number}`,
    );
    addTarget(state, {
      ...fixture,
      baseX: unit.normalizedLane * 7.4,
      baseY: 1.4 + index % 3 * 3,
      movementPhase: fixture.movementPhase + wave.number * 0.73,
    });
  }
}

function dealDamage(
  state: ScenarioState,
  target: MutableTarget,
  requestedDamage: number,
  source: CombatDamageSource,
): number {
  if (!target.alive || requestedDamage <= 0) return 0;
  const previousHealth = target.currentHealth;
  if (target.kind === "boss") {
    const outcome = applyBossEscortDamageGate(
      target.currentHealth,
      target.health,
      requestedDamage,
      {
        launchedWaves: state.bossEscortProgress.launchedWaves,
        pendingEscortUnits: 0,
      },
    );
    target.currentHealth = outcome.health;
  } else {
    target.currentHealth = Math.max(0, target.currentHealth - requestedDamage);
  }
  const applied = Math.max(0, previousHealth - target.currentHealth);
  state.damageBySource[source] += applied;
  state.abilityValue[source].realizedValue += applied;

  if (target.currentHealth <= EPSILON && target.alive) {
    target.alive = false;
    state.score += target.score;
    state.kills += 1;
    state.determinismHash = hashString(state.determinismHash, target.id);
    state.determinismHash = hashNumber(state.determinismHash, state.elapsedSeconds);
  }
  return applied;
}

function bestTargetInLane(
  state: ScenarioState,
  laneX: number,
  projectileRadius: number,
): MutableTarget | undefined {
  return livingTargets(state)
    .filter((target) => Math.abs(predictedTargetX(target, 0.12) - laneX) <= target.radius + projectileRadius)
    .sort((first, second) => (
      first.y - second.y
      || targetScore(state, second) - targetScore(state, first)
      || first.id.localeCompare(second.id)
    ))[0];
}

function fireCannon(state: ScenarioState): void {
  const burst = state.burstRemaining > 0;
  const source: CombatDamageSource = burst ? "dash-burst" : "cannon";
  const hardpoint = state.cannonShots % 2 === 0 ? -0.5 : 0.5;
  const scatterIndex = state.cannonShots % 9 - 4;
  const scatterAngle = burst ? scatterIndex / 4 * DASH_SCATTER_RADIANS : 0;
  state.cannonShots += 1;
  state.abilityValue[source].potentialValue += 1;
  const selected = state.targets.find((target) => target.alive && target.id === state.selectedTargetId)
    ?? selectTarget(state);
  if (!selected) return;
  const verticalDistance = Math.max(0.6, selected.y - state.playerY - 0.74);
  const flightSeconds = verticalDistance / CANNON_PROJECTILE_SPEED;
  const laneX = state.playerX + hardpoint + Math.tan(scatterAngle) * verticalDistance;
  const selectedFutureX = predictedTargetX(selected, flightSeconds);
  const target = Math.abs(selectedFutureX - laneX) <= selected.radius + CANNON_PROJECTILE_RADIUS
    ? selected
    : bestTargetInLane(state, laneX, CANNON_PROJECTILE_RADIUS);
  if (!target) return;
  state.cannonHits += 1;
  dealDamage(state, target, 1, source);
}

function fireLaser(state: ScenarioState): void {
  for (const target of livingTargets(state)) {
    const damage = combatLowProfileLaserDamage(target.currentHealth, target.health);
    state.abilityValue["low-profile"].potentialValue += damage;
    if (Math.abs(target.x - state.playerX) <= target.radius + CANNON_PROJECTILE_RADIUS) {
      dealDamage(state, target, damage, "low-profile");
    }
  }
}

function missileTargets(state: ScenarioState): MutableTarget[] {
  return livingTargets(state).sort((first, second) => (
    targetScore(state, second) - targetScore(state, first)
    || second.y - first.y
    || first.id.localeCompare(second.id)
  ));
}

function tryMissiles(state: ScenarioState): void {
  if (state.missileCooldown > 0) return;
  const targets = missileTargets(state);
  const primary = targets[0];
  if (!primary) return;
  const use = primary.kind === "boss"
    || targets.length >= Math.max(1, Math.round(state.tuning.offense.missileMinimumTargets))
    || primary.targetPriority >= state.tuning.offense.missilePriorityThreshold;
  if (!use) return;
  state.missileCooldown = MISSILE_COOLDOWN_SECONDS;
  const measurement = state.abilityValue.missile;
  measurement.uses += 1;
  for (let index = 0; index < MISSILE_SALVO_SIZE; index += 1) {
    const refreshedTargets = missileTargets(state);
    const target = refreshedTargets[index % Math.max(1, refreshedTargets.length)];
    if (!target) break;
    measurement.potentialValue += MISSILE_DAMAGE;
    dealDamage(state, target, MISSILE_DAMAGE, "missile");
  }
}

function projectedCounterflareConversions(state: ScenarioState): number {
  const difficulty = state.fixture.difficulty;
  return Math.min(
    COUNTERFLARE_CONVERSION_CAP,
    Math.max(1, Math.floor(
      1
      + difficulty.terminalProgress * 9.5
      + Math.min(4, livingTargets(state).length * 0.35),
    )),
  );
}

function tryCounterflare(state: ScenarioState): boolean {
  if (state.counterflareCooldown > 0) return false;
  const conversions = projectedCounterflareConversions(state);
  if (conversions < state.tuning.offense.counterflareMinimumConversions) return false;
  state.counterflareCooldown = JET_ABILITY_SPECS.counterflare.cooldownSeconds;
  const measurement = state.abilityValue.counterflare;
  measurement.uses += 1;
  for (let index = 0; index < conversions; index += 1) {
    const target = selectTarget(state);
    if (!target) break;
    measurement.potentialValue += COUNTERFLARE_DAMAGE;
    dealDamage(state, target, COUNTERFLARE_DAMAGE, "counterflare");
  }
  return true;
}

function targetsNearGravityAnchor(state: ScenarioState): MutableTarget[] {
  const anchorX = state.playerX;
  const anchorY = Math.min(WORLD_TOP - 2.5, state.playerY + GRAVITY_KNOT_OFFSET_Y);
  return livingTargets(state).filter((target) => (
    Math.hypot(target.x - anchorX, target.y - anchorY) <= GRAVITY_KNOT_RADIUS
  ));
}

function tryGravityKnot(state: ScenarioState): boolean {
  if (state.gravityCooldown > 0 || state.gravityRemaining > 0) return false;
  const held = targetsNearGravityAnchor(state);
  if (held.length < Math.max(1, Math.round(state.tuning.offense.gravityMinimumTargets))) return false;
  state.gravityCooldown = JET_ABILITY_SPECS["gravity-knot"].cooldownSeconds;
  state.gravityRemaining = JET_ABILITY_SPECS["gravity-knot"].activeSeconds;
  state.gravityX = state.playerX;
  state.gravityY = Math.min(WORLD_TOP - 2.5, state.playerY + GRAVITY_KNOT_OFFSET_Y);
  const measurement = state.abilityValue["gravity-knot"];
  measurement.uses += 1;
  measurement.potentialValue += held.length * state.gravityRemaining;
  return true;
}

function tryPhoenixSquadron(state: ScenarioState): boolean {
  if (state.phoenixCooldown > 0 || state.phoenixRemaining > 0) return false;
  const targets = livingTargets(state);
  const boss = activeBoss(state);
  const bossRatio = boss ? boss.currentHealth / Math.max(1, boss.health) : 1;
  if (
    targets.length < Math.max(1, Math.round(state.tuning.offense.phoenixMinimumTargets))
    && (!boss || bossRatio > state.tuning.offense.phoenixBossHealthRatio)
  ) {
    return false;
  }
  state.phoenixCooldown = JET_ABILITY_SPECS["phoenix-squadron"].cooldownSeconds;
  state.phoenixRemaining = JET_ABILITY_SPECS["phoenix-squadron"].activeSeconds;
  state.phoenixStrikeCooldown = 0;
  state.phoenixStrikeIndex = 0;
  state.abilityValue["phoenix-squadron"].uses += 1;
  return true;
}

function launchPhoenixStrike(state: ScenarioState): void {
  const enemies = livingTargets(state)
    .filter((target) => target.kind !== "boss")
    .sort((first, second) => (
      second.currentHealth - first.currentHealth
      || second.y - first.y
      || first.id.localeCompare(second.id)
    ));
  const boss = activeBoss(state);
  const primaryEnemy = enemies[state.phoenixStrikeIndex % Math.max(1, enemies.length)];
  const laneX = clampNumber(
    boss && state.phoenixStrikeIndex % 2 === 0
      ? boss.x
      : primaryEnemy?.x ?? state.playerX + (state.phoenixStrikeIndex % 3 - 1) * 3.2,
    WORLD_LEFT + 1.2,
    WORLD_RIGHT - 1.2,
  );
  state.phoenixStrikeIndex += 1;
  const measurement = state.abilityValue["phoenix-squadron"];
  const enemyDamage = Math.max(12, state.fixture.difficulty.enemyHealthScale * 5);
  for (const target of livingTargets(state)) {
    if (target.kind === "boss") continue;
    if (Math.abs(target.x - laneX) <= target.radius + PHOENIX_ENEMY_LANE_PADDING) {
      measurement.potentialValue += enemyDamage;
      dealDamage(state, target, enemyDamage, "phoenix-squadron");
    }
  }
  if (boss && Math.abs(boss.x - laneX) <= boss.radius + PHOENIX_ENEMY_LANE_PADDING) {
    const bossDamage = 10 + boss.health * 0.025;
    measurement.potentialValue += bossDamage;
    dealDamage(state, boss, bossDamage, "phoenix-squadron");
  }
}

function alignmentQuality(state: ScenarioState, target: MutableTarget): number {
  const verticalDistance = Math.max(0.6, target.y - state.playerY);
  const flightSeconds = verticalDistance / CANNON_PROJECTILE_SPEED;
  const error = Math.abs(predictedTargetX(target, flightSeconds) - state.playerX);
  return 1 - clampNumber(error / Math.max(0.2, target.radius + CANNON_PROJECTILE_RADIUS), 0, 1);
}

function tryOffensiveFlightMode(state: ScenarioState, target: MutableTarget | undefined): void {
  if (!target) return;
  const offense = state.tuning.offense;
  const quality = alignmentQuality(state, target);
  if (
    state.dashCooldown <= 0
    && state.dashRemaining <= 0
    && quality >= offense.dashBurstAlignmentThreshold
    && target.currentHealth >= offense.dashBurstMinimumTargetHealth
  ) {
    state.dashRemaining = DASH_SECONDS;
    state.dashCooldown = DASH_COOLDOWN_SECONDS;
    state.dashDirection = state.movement;
    state.abilityValue["dash-burst"].uses += 1;
    return;
  }

  if (state.lowProfileCooldown > 0 || state.lowProfileRemaining > 0) return;
  const alignedTargets = livingTargets(state).filter((candidate) => (
    Math.abs(candidate.x - state.playerX) <= candidate.radius + CANNON_PROJECTILE_RADIUS
  ));
  const alignedHealth = alignedTargets.reduce((sum, candidate) => sum + candidate.currentHealth, 0);
  if (
    alignedTargets.length >= Math.max(1, Math.round(offense.laserMinimumAlignedTargets))
    && alignedHealth >= offense.laserMinimumAlignedHealth
  ) {
    state.lowProfileRemaining = LOW_PROFILE_SECONDS;
    state.lowProfileCooldown = LOW_PROFILE_COOLDOWN_SECONDS;
    state.lowProfileWarpRemaining = Math.max(
      state.lowProfileWarpRemaining,
      LOW_PROFILE_TIME_WARP_SECONDS,
    );
    state.laserCooldown = 0;
    state.abilityValue["low-profile"].uses += 1;
  }
}

function decide(state: ScenarioState): void {
  const selected = selectTarget(state);
  state.selectedTargetId = selected?.id ?? null;
  state.movement = routeDecision(state, selected);
  state.decisionCount += 1;
  const route = state.tuning.route;
  state.plannerWorkUnits += (Math.max(8, Math.min(48, Math.floor(route.candidateHeadingCount))) + 1)
    * Math.max(1, Math.ceil(route.planningHorizonSeconds / Math.max(0.03, route.simulationStepSeconds)));

  tryOffensiveFlightMode(state, selected);
  tryMissiles(state);
  // Preserve the production policy's "at most one special per decision" rule.
  if (!tryCounterflare(state) && !tryGravityKnot(state)) {
    tryPhoenixSquadron(state);
  }

  state.determinismHash = hashString(state.determinismHash, selected?.id ?? "idle");
  state.determinismHash = hashNumber(state.determinismHash, state.movement.x);
  state.determinismHash = hashNumber(state.determinismHash, state.movement.y);
}

function tickCooldowns(state: ScenarioState, deltaSeconds: number): void {
  const dashWasActive = state.dashRemaining > 0;
  state.dashRemaining = Math.max(0, state.dashRemaining - deltaSeconds);
  if (dashWasActive && state.dashRemaining <= 0) {
    state.burstRemaining = DASH_BURST_SECONDS;
    state.cannonCooldown = Math.min(0, state.cannonCooldown);
  }
  state.dashCooldown = Math.max(0, state.dashCooldown - deltaSeconds);
  state.burstRemaining = Math.max(0, state.burstRemaining - deltaSeconds);
  state.lowProfileRemaining = Math.max(0, state.lowProfileRemaining - deltaSeconds);
  state.lowProfileCooldown = Math.max(0, state.lowProfileCooldown - deltaSeconds);
  state.lowProfileWarpRemaining = Math.max(0, state.lowProfileWarpRemaining - deltaSeconds);
  state.missileCooldown = Math.max(0, state.missileCooldown - deltaSeconds);
  state.counterflareCooldown = Math.max(0, state.counterflareCooldown - deltaSeconds);
  state.gravityRemaining = Math.max(0, state.gravityRemaining - deltaSeconds);
  state.gravityCooldown = Math.max(0, state.gravityCooldown - deltaSeconds);
  state.phoenixRemaining = Math.max(0, state.phoenixRemaining - deltaSeconds);
  state.phoenixCooldown = Math.max(0, state.phoenixCooldown - deltaSeconds);
}

function movePlayer(state: ScenarioState, deltaSeconds: number): void {
  const dashing = state.dashRemaining > 0;
  const movement = dashing ? state.dashDirection : state.movement;
  const speed = PLAYER_SPEED * (dashing
    ? DASH_SPEED_MULTIPLIER
    : combatLowProfilePlayerSpeedMultiplier(state.lowProfileWarpRemaining));
  state.playerX = clampNumber(
    state.playerX + movement.x * speed * deltaSeconds,
    WORLD_LEFT + PLAYER_RADIUS,
    WORLD_RIGHT - PLAYER_RADIUS,
  );
  state.playerY = clampNumber(
    state.playerY + movement.y * speed * deltaSeconds,
    WORLD_BOTTOM + PLAYER_RADIUS,
    WORLD_TOP - PLAYER_RADIUS,
  );
}

function tickWeapons(state: ScenarioState, deltaSeconds: number): void {
  if (state.phoenixRemaining > 0) {
    state.phoenixStrikeCooldown -= deltaSeconds;
    while (
      state.phoenixStrikeCooldown <= 0
      && state.phoenixStrikeIndex < PHOENIX_STRIKE_CAP
    ) {
      launchPhoenixStrike(state);
      state.phoenixStrikeCooldown += PHOENIX_STRIKE_INTERVAL_SECONDS;
    }
  }

  if (state.lowProfileRemaining > 0) {
    state.laserCooldown -= deltaSeconds;
    while (state.laserCooldown <= 0) {
      fireLaser(state);
      state.laserCooldown += LASER_DAMAGE_INTERVAL_SECONDS;
    }
    return;
  }

  state.cannonCooldown -= deltaSeconds;
  const interval = state.burstRemaining > 0
    ? CANNON_INTERVAL_SECONDS * DASH_BURST_INTERVAL_SCALE
    : CANNON_INTERVAL_SECONDS;
  while (state.cannonCooldown <= 0) {
    fireCannon(state);
    state.cannonCooldown += interval;
  }
}

function abilityValueResult(value: MutableAbilityValue): AbilityValueMeasurement {
  return {
    uses: value.uses,
    potentialValue: roundMetric(value.potentialValue),
    realizedValue: roundMetric(value.realizedValue),
    efficiency: value.potentialValue > EPSILON
      ? roundMetric(clampNumber(value.realizedValue / value.potentialValue, 0, 1))
      : value.uses > 0 ? 0 : 1,
  };
}

export function runCombatScenario(
  fixture: CombatScenarioFixture,
  tuningOverrides: CombatProgressionTuningOverrides = {},
): CombatScenarioResult {
  const tuning = resolveCombatProgressionTuning(tuningOverrides);
  const initialTargets = fixture.initialTargets.map(mutableTarget);
  const state: ScenarioState = {
    fixture,
    tuning,
    targets: initialTargets,
    damageBySource: emptyDamageRecord(),
    abilityValue: emptyAbilityValueRecord(),
    bossEscortProgress: createBossEscortProgress(),
    playerX: 0,
    playerY: PLAYER_START_Y,
    movement: { x: 0, y: 0 },
    dashDirection: { x: 0, y: 1 },
    dashRemaining: 0,
    dashCooldown: 0,
    burstRemaining: 0,
    lowProfileRemaining: 0,
    lowProfileCooldown: 0,
    lowProfileWarpRemaining: 0,
    missileCooldown: 0,
    counterflareCooldown: 0,
    gravityCooldown: 0,
    gravityRemaining: 0,
    gravityX: 0,
    gravityY: 0,
    phoenixCooldown: 0,
    phoenixRemaining: 0,
    phoenixStrikeCooldown: 0,
    phoenixStrikeIndex: 0,
    cannonCooldown: 0,
    laserCooldown: 0,
    nextDecisionSeconds: 0,
    selectedTargetId: null,
    elapsedSeconds: 0,
    hostileElapsedSeconds: 0,
    score: 0,
    availableScore: initialTargets.reduce((sum, target) => sum + target.score, 0),
    kills: 0,
    cannonShots: 0,
    cannonHits: 0,
    decisionCount: 0,
    plannerWorkUnits: 0,
    determinismHash: hashString(2_166_136_261, fixture.id),
    lastEscortLaunchSeconds: Number.NEGATIVE_INFINITY,
  };

  while (state.elapsedSeconds < fixture.maximumSeconds - EPSILON) {
    launchDueEscortWave(state);
    const bossScenarioIncomplete = fixture.kind === "boss"
      && state.bossEscortProgress.launchedWaves < 2;
    if (livingTargets(state).length === 0 && !bossScenarioIncomplete) break;

    const deltaSeconds = Math.min(
      tuning.decisionStepSeconds,
      fixture.maximumSeconds - state.elapsedSeconds,
    );
    const hostileDeltaSeconds = deltaSeconds
      * combatLowProfileHostileTimeScale(state.lowProfileWarpRemaining);
    updateTargetPositions(state, deltaSeconds, hostileDeltaSeconds);
    if (state.elapsedSeconds + EPSILON >= state.nextDecisionSeconds) {
      decide(state);
      state.nextDecisionSeconds = state.elapsedSeconds + tuning.decisionStepSeconds;
    }
    movePlayer(state, deltaSeconds);
    tickWeapons(state, deltaSeconds);
    tickCooldowns(state, deltaSeconds);
    state.elapsedSeconds += deltaSeconds;
    state.hostileElapsedSeconds += hostileDeltaSeconds;
    state.determinismHash = hashNumber(state.determinismHash, state.playerX);
    state.determinismHash = hashNumber(state.determinismHash, state.score);
  }

  const living = livingTargets(state);
  const timedOut = living.length > 0
    || (fixture.kind === "boss" && state.bossEscortProgress.launchedWaves < 2);
  const clearSeconds = timedOut ? fixture.maximumSeconds : state.elapsedSeconds;
  const damageBySource = Object.fromEntries(Object.entries(state.damageBySource).map(([source, damage]) => [
    source,
    roundMetric(damage),
  ])) as Record<CombatDamageSource, number>;
  const abilityValue = Object.fromEntries(Object.entries(state.abilityValue).map(([source, value]) => [
    source,
    abilityValueResult(value),
  ])) as Record<CombatDamageSource, AbilityValueMeasurement>;

  return {
    id: fixture.id,
    kind: fixture.kind,
    sector: fixture.sector,
    bossArchetype: fixture.bossArchetype,
    clearSeconds: roundMetric(clearSeconds),
    timedOut,
    score: state.score,
    availableScore: state.availableScore,
    scoreRate: roundMetric(state.score / Math.max(clearSeconds, EPSILON)),
    kills: state.kills,
    escapedTargets: living.length,
    cannonShots: state.cannonShots,
    cannonHits: state.cannonHits,
    cannonAccuracy: state.cannonShots > 0
      ? roundMetric(state.cannonHits / state.cannonShots)
      : 0,
    damageBySource,
    abilityValue,
    decisionCount: state.decisionCount,
    plannerWorkUnits: state.plannerWorkUnits,
    determinismHash: state.determinismHash,
  };
}

function aggregateAbilityEfficiency(results: readonly CombatScenarioResult[]): number {
  let potential = 0;
  let realized = 0;
  for (const result of results) {
    for (const source of [
      "dash-burst",
      "low-profile",
      "missile",
      "counterflare",
      "gravity-knot",
      "phoenix-squadron",
    ] as const) {
      potential += result.abilityValue[source].potentialValue;
      realized += result.abilityValue[source].realizedValue;
    }
  }
  return potential > EPSILON ? clampNumber(realized / potential, 0, 1) : 0;
}

export function evaluateCombatProgression(
  tuningOverrides: CombatProgressionTuningOverrides = {},
  fixtures: readonly CombatScenarioFixture[] = COMBAT_SCENARIO_FIXTURES,
): CombatProgressionEvaluation {
  const tuning = resolveCombatProgressionTuning(tuningOverrides);
  const scenarios = fixtures.map((fixture) => runCombatScenario(fixture, tuning));
  const totalWeight = fixtures.reduce((sum, fixture) => sum + fixture.weight, 0);
  let weightedClearSeconds = 0;
  let weightedScoreRate = 0;
  let weightedAccuracy = 0;
  let totalSimulatedSeconds = 0;
  let plannerWorkUnits = 0;
  let determinismHash = 2_166_136_261;

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    const fixture = fixtures[index];
    if (!scenario || !fixture) continue;
    weightedClearSeconds += scenario.clearSeconds * fixture.weight;
    weightedScoreRate += scenario.scoreRate * fixture.weight;
    weightedAccuracy += scenario.cannonAccuracy * fixture.weight;
    totalSimulatedSeconds += scenario.clearSeconds;
    plannerWorkUnits += scenario.plannerWorkUnits;
    determinismHash = hashNumber(determinismHash, scenario.determinismHash);
  }

  const timedOutScenarios = scenarios.filter((scenario) => scenario.timedOut).length;
  const meanClearSeconds = weightedClearSeconds / Math.max(totalWeight, EPSILON);
  const meanScoreRate = weightedScoreRate / Math.max(totalWeight, EPSILON);
  const abilityEfficiency = aggregateAbilityEfficiency(scenarios);
  const cannonAccuracy = weightedAccuracy / Math.max(totalWeight, EPSILON);
  const estimatedSecondsToSector200 = meanScoreRate > EPSILON
    ? SECTOR_200_SCORE / meanScoreRate
    : Number.POSITIVE_INFINITY;
  const plannerWorkUnitsPerSecond = plannerWorkUnits / Math.max(totalSimulatedSeconds, EPSILON);
  const objectiveScore = -timedOutScenarios * 1_000_000
    - estimatedSecondsToSector200
    - meanClearSeconds * 0.35
    + abilityEfficiency * 18
    + cannonAccuracy * 12;

  return {
    tuning,
    scenarios,
    objective: {
      objectiveScore: roundMetric(objectiveScore),
      timedOutScenarios,
      weightedClearSeconds: roundMetric(meanClearSeconds),
      weightedScoreRate: roundMetric(meanScoreRate),
      estimatedSecondsToSector200: roundMetric(estimatedSecondsToSector200),
      abilityEfficiency: roundMetric(abilityEfficiency),
      cannonAccuracy: roundMetric(cannonAccuracy),
      plannerWorkUnitsPerSecond: roundMetric(plannerWorkUnitsPerSecond),
    },
    determinismHash,
  };
}

export function compareCombatProgressionEvaluations(
  first: CombatProgressionEvaluation,
  second: CombatProgressionEvaluation,
): number {
  const a = first.objective;
  const b = second.objective;
  if (a.timedOutScenarios !== b.timedOutScenarios) {
    return a.timedOutScenarios < b.timedOutScenarios ? 1 : -1;
  }
  if (Math.abs(a.estimatedSecondsToSector200 - b.estimatedSecondsToSector200) > EPSILON) {
    return a.estimatedSecondsToSector200 < b.estimatedSecondsToSector200 ? 1 : -1;
  }
  if (Math.abs(a.weightedClearSeconds - b.weightedClearSeconds) > EPSILON) {
    return a.weightedClearSeconds < b.weightedClearSeconds ? 1 : -1;
  }
  if (Math.abs(a.abilityEfficiency - b.abilityEfficiency) > EPSILON) {
    return a.abilityEfficiency > b.abilityEfficiency ? 1 : -1;
  }
  if (Math.abs(a.cannonAccuracy - b.cannonAccuracy) > EPSILON) {
    return a.cannonAccuracy > b.cannonAccuracy ? 1 : -1;
  }
  if (Math.abs(a.plannerWorkUnitsPerSecond - b.plannerWorkUnitsPerSecond) > EPSILON) {
    return a.plannerWorkUnitsPerSecond < b.plannerWorkUnitsPerSecond ? 1 : -1;
  }
  return 0;
}

function halton(index: number, base: number): number {
  let fraction = 1;
  let result = 0;
  let remaining = index;
  while (remaining > 0) {
    fraction /= base;
    result += fraction * (remaining % base);
    remaining = Math.floor(remaining / base);
  }
  return result;
}

function ranged(index: number, base: number, minimum: number, maximum: number): number {
  return minimum + halton(index, base) * (maximum - minimum);
}

function choice<T>(index: number, base: number, values: readonly T[]): T {
  const selected = Math.min(values.length - 1, Math.floor(halton(index, base) * values.length));
  return values[selected] ?? values[0]!;
}

export function combatPlannerWorkUnitsPerSecond(tuning: CombatProgressionTuning): number {
  const route = tuning.route;
  return (Math.max(8, Math.min(48, Math.floor(route.candidateHeadingCount))) + 1)
    * Math.max(1, Math.ceil(route.planningHorizonSeconds / Math.max(0.03, route.simulationStepSeconds)))
    / Math.max(0.04, tuning.decisionStepSeconds);
}

function searchCandidate(index: number): CombatProgressionTuningOverrides {
  const headings = choice(index, 5, [16, 24, 32, 40, 48] as const);
  const simulationStep = choice(index, 7, [0.08, 0.1, 0.12, 0.16] as const);
  return {
    route: {
      planningHorizonSeconds: ranged(index, 2, 1.2, 3.1),
      simulationStepSeconds: simulationStep,
      candidateHeadingCount: headings,
      neutralY: ranged(index, 11, -11.2, -6.2),
    },
    decisionStepSeconds: ranged(index, 13, 0.06, 0.12),
    offense: {
      aimLeadSeconds: ranged(index, 17, 0.35, 1.8),
      targetPriorityWeight: ranged(index, 19, 0.35, 1.8),
      targetScoreWeight: ranged(index, 23, 0, 2.2),
      targetEfficiencyWeight: ranged(index, 29, 0, 2.2),
      targetExitUrgencyWeight: ranged(index, 31, 0, 1.8),
      targetLaneWeight: ranged(index, 37, 0, 1.3),
      bossFocusWeight: ranged(index, 41, 0, 2.5),
      eliteFocusWeight: ranged(index, 43, 0, 1.4),
      bossGateAvoidanceWeight: ranged(index, 47, 0.5, 4),
      missileMinimumTargets: choice(index, 53, [1, 2, 3, 4, 5] as const),
      missilePriorityThreshold: ranged(index, 59, 1, 7),
      dashBurstAlignmentThreshold: ranged(index, 61, 0.55, 0.98),
      dashBurstMinimumTargetHealth: ranged(index, 67, 5, 90),
      laserMinimumAlignedTargets: choice(index, 71, [1, 2, 3, 4] as const),
      laserMinimumAlignedHealth: ranged(index, 73, 4, 80),
      counterflareMinimumConversions: choice(index, 79, [2, 3, 4, 5, 6, 7, 8] as const),
      gravityMinimumTargets: choice(index, 83, [1, 2, 3, 4, 5] as const),
      phoenixMinimumTargets: choice(index, 89, [1, 2, 3, 4, 5, 6, 7, 8] as const),
      phoenixBossHealthRatio: ranged(index, 97, 0.3, 1),
    },
  };
}

export function hyperoptimizeCombatProgression(
  options: CombatHyperoptOptions = {},
): CombatHyperoptResult {
  const maximumCandidates = Math.floor(clampNumber(
    finiteOr(options.maximumCandidates ?? 32, 32),
    2,
    96,
  ));
  const budgetMultiplier = clampNumber(
    finiteOr(options.plannerBudgetMultiplier ?? 1.35, 1.35),
    0.75,
    3,
  );
  const baselineTuning = resolveCombatProgressionTuning();
  const plannerWorkBudgetPerSecond = combatPlannerWorkUnitsPerSecond(baselineTuning) * budgetMultiplier;
  const baseline = evaluateCombatProgression();
  let winner = baseline;
  let winnerIndex = 0;
  let evaluatedCandidates = 1;
  let rejectedForPlannerBudget = 0;
  let sampleIndex = 1;

  while (evaluatedCandidates < maximumCandidates && sampleIndex <= maximumCandidates * 24) {
    const overrides = searchCandidate(sampleIndex);
    const tuning = resolveCombatProgressionTuning(overrides);
    if (combatPlannerWorkUnitsPerSecond(tuning) > plannerWorkBudgetPerSecond + EPSILON) {
      rejectedForPlannerBudget += 1;
      sampleIndex += 1;
      continue;
    }
    const evaluation = evaluateCombatProgression(overrides);
    if (compareCombatProgressionEvaluations(evaluation, winner) > 0) {
      winner = evaluation;
      winnerIndex = sampleIndex;
    }
    evaluatedCandidates += 1;
    sampleIndex += 1;
  }

  return {
    baseline,
    winner,
    evaluatedCandidates,
    rejectedForPlannerBudget,
    plannerWorkBudgetPerSecond: roundMetric(plannerWorkBudgetPerSecond),
    winnerIndex,
  };
}
