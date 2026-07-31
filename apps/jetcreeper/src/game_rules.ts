import { JET_ABILITY_KINDS } from "./abilities";
import {
  JET_ATTACHMENT_KINDS,
  JET_ATTACHMENT_SPECS,
  type JetAttachmentKind,
} from "./attachments";

export const ENEMY_KINDS = Object.freeze([
  "fighter",
  "turret",
  "asteroid",
  "interceptor",
  "bomber",
  "gunship",
  "sniper",
  "mine",
  "carrier",
  "phantom",
  "corsair",
  "bulwark",
  "shifter",
  "leech",
  "splitter",
  "warden",
  "rammer",
  "stalker",
  "chronodrone",
  "commander",
] as const);

export type EnemyKind = typeof ENEMY_KINDS[number];
export type EnemyMovementFamily =
  | "orbit"
  | "drift"
  | "tumble"
  | "intercept"
  | "bombing-run"
  | "broadside"
  | "hold-lane"
  | "mine-drift"
  | "carrier-lane"
  | "phase-shift"
  | "strafe-dash"
  | "shield-advance"
  | "blink-ambush"
  | "siphon-pursuit"
  | "split-flank"
  | "tether-orbit"
  | "ram-charge"
  | "cloak-stalk"
  | "chrono-zigzag"
  | "command-weave";
export type EnemyWeaponFamily =
  | "twin-cannon"
  | "aimed-bolt"
  | "collision"
  | "burst-cannon"
  | "gravity-bomb"
  | "spread-cannon"
  | "rail-shot"
  | "proximity-blast"
  | "drone-swarm"
  | "phase-bolt"
  | "arc-burst"
  | "shield-barrage"
  | "blink-volley"
  | "siphon-beam"
  | "fork-missiles"
  | "tether-shot"
  | "shockwave-cannon"
  | "cloak-torpedo"
  | "time-shard"
  | "support-drones";

export const CONSUMABLE_BONUS_KINDS = Object.freeze([
  "shield",
  "pulse",
  "missile",
] as const);

export type ConsumableBonusKind = typeof CONSUMABLE_BONUS_KINDS[number];

export const BONUS_KINDS = Object.freeze([
  ...CONSUMABLE_BONUS_KINDS,
  ...JET_ATTACHMENT_KINDS,
  ...JET_ABILITY_KINDS,
] as const);

export type BonusKind = typeof BONUS_KINDS[number];
export type BossPhase = 1 | 2 | 3;

export const BOSS_ARCHETYPES = Object.freeze([
  "ravager",
  "stormwing",
  "dreadnought",
  "prism",
  "harvester",
  "chronarch",
] as const);

export type BossArchetype = typeof BOSS_ARCHETYPES[number];
export type BossMovementFamily =
  | "figure-eight"
  | "dive-loop"
  | "broadside"
  | "orbit"
  | "pursuit"
  | "temporal-lattice";
export type BossWeaponPattern =
  | "aimed-fan"
  | "lane-volley"
  | "homing-salvo"
  | "spiral-burst"
  | "lightning-lanes"
  | "seeker-swarm"
  | "broadside-barrage"
  | "mine-wall"
  | "rail-cannon"
  | "laser-sweep"
  | "ricochet-grid"
  | "prism-burst"
  | "tractor-ring"
  | "drone-swarm"
  | "plasma-lance"
  | "clock-hand-sweep"
  | "rewind-barrage"
  | "time-rift-collapse";

export interface EnemyArchetypeRules {
  readonly kind: EnemyKind;
  readonly displayName: string;
  readonly unlockSector: number;
  readonly score: number;
  readonly baseHealth: number;
  readonly radius: number;
  readonly modelScale: number;
  readonly movementFamily: EnemyMovementFamily;
  readonly weaponFamily: EnemyWeaponFamily;
  readonly fireCooldownSeconds: number | null;
  readonly targetPriority: number;
  readonly spawnWeight: number;
}

export interface BossArchetypeRules {
  readonly id: BossArchetype;
  readonly displayName: string;
  readonly movementFamily: BossMovementFamily;
  readonly phaseWeapons: readonly [BossWeaponPattern, BossWeaponPattern, BossWeaponPattern];
  readonly healthMultiplier: number;
  readonly rewardMultiplier: number;
  readonly attackCooldownScale: number;
}

export interface Difficulty {
  sector: number;
  terminalProgress: number;
  scrollSpeed: number;
  enemySpawnInterval: number;
  enemyProjectileSpeed: number;
  enemyFireCooldownScale: number;
  rocketCooldownScale: number;
  bossAttackCooldownScale: number;
  enemyHealthScale: number;
  enemyMovementSpeedScale: number;
  eliteChance: number;
  maxFormationSize: number;
  maxEnemies: number;
  maxEnemyProjectiles: number;
  maxEnemyRockets: number;
}

/**
 * Shared offensive-pressure knobs used by both the renderer-backed game and
 * the deterministic pressure simulator. Values below one for cadence scales
 * mean more frequent attacks; density is always applied through existing
 * entity caps and route-admission checks.
 */
export interface EnemyPressureTuning {
  readonly horizontalAimLeadSeconds: number;
  readonly verticalAimLeadSeconds: number;
  readonly aimJitterScale: number;
  readonly volleySpreadScale: number;
  readonly fireCadenceScale: number;
  readonly volleyDensityScale: number;
  readonly rocketCadenceScale: number;
  readonly rocketSpeedScale: number;
  readonly rocketHomingStrength: number;
  readonly rocketHomingSeconds: number;
  readonly formationChanceAtTerminal: number;
}

export interface BrainPressureAdmissionThresholds {
  readonly survivalSeconds: number;
  readonly clearance: number;
}

export interface DamageOutcome {
  lives: number;
  shielded: boolean;
  lostLife: boolean;
  gameOver: boolean;
}

export interface FighterLoopPose {
  x: number;
  y: number;
  rotation: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export const ENEMY_ARCHETYPES: Readonly<Record<EnemyKind, Readonly<EnemyArchetypeRules>>> = Object.freeze({
  fighter: Object.freeze({
    kind: "fighter",
    displayName: "Loop Fighter",
    unlockSector: 1,
    score: 125,
    baseHealth: 1,
    radius: 0.68,
    modelScale: 1,
    movementFamily: "orbit",
    weaponFamily: "twin-cannon",
    fireCooldownSeconds: 2.2,
    targetPriority: 3,
    spawnWeight: 1.3,
  }),
  turret: Object.freeze({
    kind: "turret",
    displayName: "Siege Turret",
    unlockSector: 2,
    score: 225,
    baseHealth: 2,
    radius: 0.78,
    modelScale: 1,
    movementFamily: "drift",
    weaponFamily: "aimed-bolt",
    fireCooldownSeconds: 1.8,
    targetPriority: 4,
    spawnWeight: 0.75,
  }),
  asteroid: Object.freeze({
    kind: "asteroid",
    displayName: "Tumbling Asteroid",
    unlockSector: 1,
    score: 80,
    baseHealth: 1,
    radius: 0.72,
    modelScale: 1,
    movementFamily: "tumble",
    weaponFamily: "collision",
    fireCooldownSeconds: null,
    targetPriority: 1,
    spawnWeight: 1.05,
  }),
  interceptor: Object.freeze({
    kind: "interceptor",
    displayName: "Needle Interceptor",
    unlockSector: 4,
    score: 175,
    baseHealth: 2,
    radius: 0.58,
    modelScale: 0.9,
    movementFamily: "intercept",
    weaponFamily: "burst-cannon",
    fireCooldownSeconds: 1.35,
    targetPriority: 5,
    spawnWeight: 0.8,
  }),
  bomber: Object.freeze({
    kind: "bomber",
    displayName: "Gravity Bomber",
    unlockSector: 7,
    score: 275,
    baseHealth: 4,
    radius: 0.88,
    modelScale: 1.18,
    movementFamily: "bombing-run",
    weaponFamily: "gravity-bomb",
    fireCooldownSeconds: 2.8,
    targetPriority: 4,
    spawnWeight: 0.62,
  }),
  gunship: Object.freeze({
    kind: "gunship",
    displayName: "Broadside Gunship",
    unlockSector: 12,
    score: 375,
    baseHealth: 6,
    radius: 1.02,
    modelScale: 1.28,
    movementFamily: "broadside",
    weaponFamily: "spread-cannon",
    fireCooldownSeconds: 1.65,
    targetPriority: 6,
    spawnWeight: 0.5,
  }),
  sniper: Object.freeze({
    kind: "sniper",
    displayName: "Rail Sniper",
    unlockSector: 17,
    score: 325,
    baseHealth: 3,
    radius: 0.72,
    modelScale: 1.04,
    movementFamily: "hold-lane",
    weaponFamily: "rail-shot",
    fireCooldownSeconds: 3.4,
    targetPriority: 7,
    spawnWeight: 0.46,
  }),
  mine: Object.freeze({
    kind: "mine",
    displayName: "Proximity Mine",
    unlockSector: 22,
    score: 150,
    baseHealth: 2,
    radius: 0.58,
    modelScale: 0.84,
    movementFamily: "mine-drift",
    weaponFamily: "proximity-blast",
    fireCooldownSeconds: null,
    targetPriority: 5,
    spawnWeight: 0.55,
  }),
  carrier: Object.freeze({
    kind: "carrier",
    displayName: "Drone Carrier",
    unlockSector: 28,
    score: 475,
    baseHealth: 8,
    radius: 1.15,
    modelScale: 1.42,
    movementFamily: "carrier-lane",
    weaponFamily: "drone-swarm",
    fireCooldownSeconds: 4,
    targetPriority: 8,
    spawnWeight: 0.3,
  }),
  phantom: Object.freeze({
    kind: "phantom",
    displayName: "Phase Phantom",
    unlockSector: 36,
    score: 425,
    baseHealth: 4,
    radius: 0.62,
    modelScale: 0.96,
    movementFamily: "phase-shift",
    weaponFamily: "phase-bolt",
    fireCooldownSeconds: 1.9,
    targetPriority: 9,
    spawnWeight: 0.35,
  }),
  corsair: Object.freeze({
    kind: "corsair",
    displayName: "Razor Corsair",
    unlockSector: 44,
    score: 360,
    baseHealth: 3,
    radius: 0.6,
    modelScale: 0.94,
    movementFamily: "strafe-dash",
    weaponFamily: "arc-burst",
    fireCooldownSeconds: 1.1,
    targetPriority: 7,
    spawnWeight: 0.52,
  }),
  bulwark: Object.freeze({
    kind: "bulwark",
    displayName: "Aegis Bulwark",
    unlockSector: 52,
    score: 520,
    baseHealth: 10,
    radius: 1.08,
    modelScale: 1.34,
    movementFamily: "shield-advance",
    weaponFamily: "shield-barrage",
    fireCooldownSeconds: 2.2,
    targetPriority: 9,
    spawnWeight: 0.26,
  }),
  shifter: Object.freeze({
    kind: "shifter",
    displayName: "Blink Shifter",
    unlockSector: 61,
    score: 440,
    baseHealth: 4,
    radius: 0.62,
    modelScale: 0.92,
    movementFamily: "blink-ambush",
    weaponFamily: "blink-volley",
    fireCooldownSeconds: 1.75,
    targetPriority: 10,
    spawnWeight: 0.34,
  }),
  leech: Object.freeze({
    kind: "leech",
    displayName: "Siphon Leech",
    unlockSector: 72,
    score: 495,
    baseHealth: 5,
    radius: 0.7,
    modelScale: 1,
    movementFamily: "siphon-pursuit",
    weaponFamily: "siphon-beam",
    fireCooldownSeconds: 2.35,
    targetPriority: 11,
    spawnWeight: 0.29,
  }),
  splitter: Object.freeze({
    kind: "splitter",
    displayName: "Forkwing Splitter",
    unlockSector: 84,
    score: 410,
    baseHealth: 3,
    radius: 0.64,
    modelScale: 0.96,
    movementFamily: "split-flank",
    weaponFamily: "fork-missiles",
    fireCooldownSeconds: 2.6,
    targetPriority: 8,
    spawnWeight: 0.4,
  }),
  warden: Object.freeze({
    kind: "warden",
    displayName: "Tether Warden",
    unlockSector: 98,
    score: 575,
    baseHealth: 9,
    radius: 1,
    modelScale: 1.24,
    movementFamily: "tether-orbit",
    weaponFamily: "tether-shot",
    fireCooldownSeconds: 2.9,
    targetPriority: 11,
    spawnWeight: 0.24,
  }),
  rammer: Object.freeze({
    kind: "rammer",
    displayName: "Shock Rammer",
    unlockSector: 116,
    score: 385,
    baseHealth: 7,
    radius: 0.82,
    modelScale: 1.18,
    movementFamily: "ram-charge",
    weaponFamily: "shockwave-cannon",
    fireCooldownSeconds: 3.1,
    targetPriority: 9,
    spawnWeight: 0.32,
  }),
  stalker: Object.freeze({
    kind: "stalker",
    displayName: "Cloak Stalker",
    unlockSector: 137,
    score: 540,
    baseHealth: 5,
    radius: 0.65,
    modelScale: 0.98,
    movementFamily: "cloak-stalk",
    weaponFamily: "cloak-torpedo",
    fireCooldownSeconds: 2.7,
    targetPriority: 12,
    spawnWeight: 0.22,
  }),
  chronodrone: Object.freeze({
    kind: "chronodrone",
    displayName: "Chrono Drone",
    unlockSector: 160,
    score: 600,
    baseHealth: 6,
    radius: 0.72,
    modelScale: 1.02,
    movementFamily: "chrono-zigzag",
    weaponFamily: "time-shard",
    fireCooldownSeconds: 1.6,
    targetPriority: 13,
    spawnWeight: 0.2,
  }),
  commander: Object.freeze({
    kind: "commander",
    displayName: "Swarm Commander",
    unlockSector: 184,
    score: 750,
    baseHealth: 12,
    radius: 1.22,
    modelScale: 1.46,
    movementFamily: "command-weave",
    weaponFamily: "support-drones",
    fireCooldownSeconds: 4.4,
    targetPriority: 14,
    spawnWeight: 0.15,
  }),
});

export const BOSS_ARCHETYPE_RULES: Readonly<Record<BossArchetype, Readonly<BossArchetypeRules>>> = Object.freeze({
  ravager: Object.freeze({
    id: "ravager",
    displayName: "Ravager Ace",
    movementFamily: "figure-eight",
    phaseWeapons: ["aimed-fan", "lane-volley", "homing-salvo"] as const,
    healthMultiplier: 1,
    rewardMultiplier: 1,
    attackCooldownScale: 1,
  }),
  stormwing: Object.freeze({
    id: "stormwing",
    displayName: "Stormwing Tempest",
    movementFamily: "dive-loop",
    phaseWeapons: ["spiral-burst", "lightning-lanes", "seeker-swarm"] as const,
    healthMultiplier: 0.92,
    rewardMultiplier: 1.08,
    attackCooldownScale: 0.82,
  }),
  dreadnought: Object.freeze({
    id: "dreadnought",
    displayName: "Iron Dreadnought",
    movementFamily: "broadside",
    phaseWeapons: ["broadside-barrage", "mine-wall", "rail-cannon"] as const,
    healthMultiplier: 1.35,
    rewardMultiplier: 1.28,
    attackCooldownScale: 1.18,
  }),
  prism: Object.freeze({
    id: "prism",
    displayName: "Prism Warden",
    movementFamily: "orbit",
    phaseWeapons: ["laser-sweep", "ricochet-grid", "prism-burst"] as const,
    healthMultiplier: 1.05,
    rewardMultiplier: 1.18,
    attackCooldownScale: 0.78,
  }),
  harvester: Object.freeze({
    id: "harvester",
    displayName: "Void Harvester",
    movementFamily: "pursuit",
    phaseWeapons: ["tractor-ring", "drone-swarm", "plasma-lance"] as const,
    healthMultiplier: 1.18,
    rewardMultiplier: 1.34,
    attackCooldownScale: 0.9,
  }),
  chronarch: Object.freeze({
    id: "chronarch",
    displayName: "Chronarch Sovereign",
    movementFamily: "temporal-lattice",
    phaseWeapons: ["clock-hand-sweep", "rewind-barrage", "time-rift-collapse"] as const,
    healthMultiplier: 1.24,
    rewardMultiplier: 1.42,
    attackCooldownScale: 0.86,
  }),
});

const ATTACHMENT_DURATION_SECONDS = Object.fromEntries(
  JET_ATTACHMENT_KINDS.map((kind) => [kind, JET_ATTACHMENT_SPECS[kind].durationSeconds]),
) as Record<JetAttachmentKind, number>;

const ATTACHMENT_LABELS = Object.fromEntries(
  JET_ATTACHMENT_KINDS.map((kind) => [kind, JET_ATTACHMENT_SPECS[kind].label]),
) as Record<JetAttachmentKind, string>;

const BONUS_DURATION_SECONDS: Readonly<Record<BonusKind, number>> = Object.freeze({
  shield: 0,
  pulse: 0,
  missile: 0,
  ...ATTACHMENT_DURATION_SECONDS,
  counterflare: 0,
  "gravity-knot": 0,
  "phoenix-squadron": 0,
});

const BONUS_LABELS: Readonly<Record<BonusKind, string>> = Object.freeze({
  shield: "Shield",
  pulse: "Repair",
  missile: "Homing salvo",
  ...ATTACHMENT_LABELS,
  counterflare: "Counterflare core",
  "gravity-knot": "Gravity Knot core",
  "phoenix-squadron": "Phoenix command core",
});

const TERMINAL_DIFFICULTY_SECTOR = 200;
const UNSAFE_ROUTE_RAMP_START = 0.88;

/** Pre-hyperopt simulator profile, retained as a reproducible benchmark. */
export const BASELINE_ENEMY_PRESSURE_TUNING: Readonly<EnemyPressureTuning> = Object.freeze({
  horizontalAimLeadSeconds: 0.18,
  verticalAimLeadSeconds: 0.12,
  aimJitterScale: 1,
  volleySpreadScale: 1,
  fireCadenceScale: 1,
  volleyDensityScale: 1,
  rocketCadenceScale: 1,
  rocketSpeedScale: 1,
  rocketHomingStrength: 0.82,
  rocketHomingSeconds: 2.8,
  formationChanceAtTerminal: 0.8,
});

/**
 * Production profile. The deterministic optimizer owns changes to these
 * values so browser pressure and headless measurements cannot drift apart.
 */
export const ENEMY_PRESSURE_TUNING: Readonly<EnemyPressureTuning> = Object.freeze({
  horizontalAimLeadSeconds: 0.1,
  verticalAimLeadSeconds: 0.08,
  aimJitterScale: 0.35,
  volleySpreadScale: 0.72,
  fireCadenceScale: 0.74625,
  volleyDensityScale: 1.5,
  rocketCadenceScale: 0.65,
  rocketSpeedScale: 1.1,
  rocketHomingStrength: 1.15,
  rocketHomingSeconds: 3.6,
  formationChanceAtTerminal: 0.9,
});

export function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function resolveEnemyPressureTuning(
  overrides: Partial<EnemyPressureTuning> = {},
): EnemyPressureTuning {
  const finite = <Key extends keyof EnemyPressureTuning>(
    key: Key,
    minimum: number,
    maximum: number,
  ): number => {
    const candidate = overrides[key];
    return clampNumber(
      typeof candidate === "number" && Number.isFinite(candidate)
        ? candidate
        : ENEMY_PRESSURE_TUNING[key],
      minimum,
      maximum,
    );
  };

  return {
    horizontalAimLeadSeconds: finite("horizontalAimLeadSeconds", 0, 0.6),
    verticalAimLeadSeconds: finite("verticalAimLeadSeconds", 0, 0.6),
    aimJitterScale: finite("aimJitterScale", 0, 1.5),
    volleySpreadScale: finite("volleySpreadScale", 0.45, 1.6),
    fireCadenceScale: finite("fireCadenceScale", 0.6, 1.25),
    volleyDensityScale: finite("volleyDensityScale", 1, 1.6),
    rocketCadenceScale: finite("rocketCadenceScale", 0.55, 1.3),
    rocketSpeedScale: finite("rocketSpeedScale", 0.75, 1.35),
    rocketHomingStrength: finite("rocketHomingStrength", 0.5, 1.5),
    rocketHomingSeconds: finite("rocketHomingSeconds", 2, 4.5),
    formationChanceAtTerminal: finite("formationChanceAtTerminal", 0.5, 1),
  };
}

export function scaledEnemyVolleyCount(
  baseCount: number,
  tuning: Readonly<EnemyPressureTuning> = ENEMY_PRESSURE_TUNING,
): number {
  const safeBase = Number.isFinite(baseCount) ? Math.max(1, Math.floor(baseCount)) : 1;
  return Math.max(1, Math.round(safeBase * tuning.volleyDensityScale));
}

/**
 * Runtime spawn admission expressed relative to the active planning horizon.
 * At the legacy 2.4s horizon this exactly reproduces the old 2.28s opening
 * threshold; shorter hyperoptimized horizons therefore do not deadlock spawns.
 */
export function brainPressureAdmissionThresholds(
  terminalProgress: number,
  planningHorizonSeconds: number,
): BrainPressureAdmissionThresholds {
  const progress = Number.isFinite(terminalProgress)
    ? clampNumber(terminalProgress, 0, 1)
    : 0;
  const horizon = Number.isFinite(planningHorizonSeconds)
    ? clampNumber(planningHorizonSeconds, 0.2, 10)
    : 2.4;
  const safetyWeight = 1 - progress;
  const terminalSurvivalFloor = Math.min(0.35, horizon * 0.5);

  return Object.freeze({
    survivalSeconds: terminalSurvivalFloor
      + safetyWeight * Math.max(0, horizon * 0.95 - terminalSurvivalFloor),
    clearance: -0.55 + safetyWeight * 0.63,
  });
}

/**
 * Chance that a late-game shot may bypass the normal escape-route check.
 * Speed, density, and durability still rise throughout the run; deliberately
 * unsolvable combinations are reserved for the final approach to sector 200.
 */
export function unsafeRouteAdmissionChance(terminalProgress: number): number {
  const progress = Number.isFinite(terminalProgress)
    ? clampNumber(terminalProgress, 0, 1)
    : 0;
  return clampNumber(
    (progress - UNSAFE_ROUTE_RAMP_START) / (1 - UNSAFE_ROUTE_RAMP_START),
    0,
    1,
  );
}

/** Sector 200 and beyond intentionally stop guaranteeing fresh safe pressure. */
export function isTerminalPressureUnbounded(terminalProgress: number): boolean {
  return Number.isFinite(terminalProgress) && terminalProgress >= 1;
}

export function circlesOverlap(
  firstX: number,
  firstY: number,
  firstRadius: number,
  secondX: number,
  secondY: number,
  secondRadius: number,
): boolean {
  const horizontalDistance = firstX - secondX;
  const verticalDistance = firstY - secondY;
  const combinedRadius = firstRadius + secondRadius;

  return horizontalDistance * horizontalDistance + verticalDistance * verticalDistance <= combinedRadius * combinedRadius;
}

export function segmentCircleOverlap(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  segmentRadius: number,
  circleX: number,
  circleY: number,
  circleRadius: number,
): boolean {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
  const projection = segmentLengthSquared > 0
    ? clampNumber(((circleX - startX) * segmentX + (circleY - startY) * segmentY) / segmentLengthSquared, 0, 1)
    : 0;
  const closestX = startX + segmentX * projection;
  const closestY = startY + segmentY * projection;

  return circlesOverlap(closestX, closestY, segmentRadius, circleX, circleY, circleRadius);
}

/** Exact swept overlap for two circles that both move linearly during a tick. */
export function movingCirclesOverlap(
  firstStartX: number,
  firstStartY: number,
  firstEndX: number,
  firstEndY: number,
  firstRadius: number,
  secondStartX: number,
  secondStartY: number,
  secondEndX: number,
  secondEndY: number,
  secondRadius: number,
): boolean {
  return segmentCircleOverlap(
    firstStartX - secondStartX,
    firstStartY - secondStartY,
    firstEndX - secondEndX,
    firstEndY - secondEndY,
    firstRadius,
    0,
    0,
    secondRadius,
  );
}

function normalizedSectorValue(sector: number): number {
  return Number.isFinite(sector) ? Math.max(1, Math.floor(sector)) : 1;
}

export function enemyArchetypeForKind(kind: EnemyKind): Readonly<EnemyArchetypeRules> {
  return ENEMY_ARCHETYPES[kind];
}

export function enemyKindsForSector(sector: number): readonly EnemyKind[] {
  const normalizedSector = normalizedSectorValue(sector);
  return ENEMY_KINDS.filter((kind) => ENEMY_ARCHETYPES[kind].unlockSector <= normalizedSector);
}

export function enemyKindForRoll(sector: number, roll: number): EnemyKind {
  const availableKinds = enemyKindsForSector(sector);
  const normalizedRoll = Number.isFinite(roll) ? clampNumber(roll, 0, 1 - Number.EPSILON) : 0;
  const totalWeight = availableKinds.reduce(
    (sum, kind) => sum + ENEMY_ARCHETYPES[kind].spawnWeight,
    0,
  );
  let weightedRoll = normalizedRoll * totalWeight;

  for (const kind of availableKinds) {
    weightedRoll -= ENEMY_ARCHETYPES[kind].spawnWeight;

    if (weightedRoll < 0) {
      return kind;
    }
  }

  return availableKinds.at(-1) ?? "fighter";
}

export function scoreForEnemy(kind: EnemyKind): number {
  return enemyArchetypeForKind(kind).score;
}

export function sectorForScore(score: number): number {
  return 1 + Math.floor(Math.max(0, score) / 1200);
}

export function difficultyForSector(sector: number): Difficulty {
  const normalizedSector = normalizedSectorValue(sector);
  const terminalProgress = clampNumber(
    (normalizedSector - 1) / (TERMINAL_DIFFICULTY_SECTOR - 1),
    0,
    1,
  );
  const cadenceProgress = Math.pow(terminalProgress, 0.7);
  const speedProgress = Math.pow(terminalProgress, 0.92);
  const cooldownProgress = Math.pow(terminalProgress, 0.74);
  const durabilityProgress = Math.pow(terminalProgress, 1.05);
  const populationProgress = Math.pow(terminalProgress, 0.62);

  return {
    sector: normalizedSector,
    terminalProgress,
    // The opening retains its protected, readable pressure. Every axis then
    // continues climbing instead of flattening at sector 30; by sector 200,
    // density, velocity, durability, formations, and elite odds compound into
    // an intentionally terminal challenge while keeping hard entity caps.
    scrollSpeed: 3.5 + cooldownProgress * 18,
    enemySpawnInterval: 0.8 - cadenceProgress * 0.7,
    enemyProjectileSpeed: 6.4 + speedProgress * 41.6,
    enemyFireCooldownScale: 0.72 - cooldownProgress * 0.64,
    rocketCooldownScale: 0.74 - Math.pow(terminalProgress, 0.72) * 0.66,
    bossAttackCooldownScale: 0.82 - cooldownProgress * 0.745,
    enemyHealthScale: 1 + durabilityProgress * 9,
    enemyMovementSpeedScale: 1 + Math.pow(terminalProgress, 0.96) * 2.2,
    eliteChance: Math.pow(terminalProgress, 1.25) * 0.78,
    maxFormationSize: 1 + Math.round(Math.pow(terminalProgress, 0.56) * 7),
    maxEnemies: 8 + Math.floor(populationProgress * 26),
    maxEnemyProjectiles: 20 + Math.floor(Math.pow(terminalProgress, 0.68) * 80),
    maxEnemyRockets: 3 + Math.floor(Math.pow(terminalProgress, 0.65) * 13),
  };
}

export function resolveDamage(lives: number, shielded: boolean): DamageOutcome {
  const safeLives = Math.max(0, Math.floor(lives));

  if (shielded) {
    return {
      lives: safeLives,
      shielded: false,
      lostLife: false,
      gameOver: false,
    };
  }

  const remainingLives = Math.max(0, safeLives - 1);

  return {
    lives: remainingLives,
    shielded: false,
    lostLife: safeLives > 0,
    gameOver: remainingLives === 0,
  };
}

export function bonusDurationSeconds(kind: BonusKind): number {
  return BONUS_DURATION_SECONDS[kind];
}

export function bonusLabel(kind: BonusKind): string {
  return BONUS_LABELS[kind];
}

export function isProtectedOpening(elapsedSeconds: number): boolean {
  return elapsedSeconds < 10;
}

export function canSpawnTurret(elapsedSeconds: number): boolean {
  return elapsedSeconds >= 8;
}

export function canFireRocket(elapsedSeconds: number): boolean {
  return elapsedSeconds >= 12;
}

export function fighterLoopPose(
  centerX: number,
  startY: number,
  ageSeconds: number,
  orbitRadius: number,
  orbitSpeed: number,
  orbitPhase: number,
  descentVelocity: number,
): FighterLoopPose {
  const angle = orbitPhase + ageSeconds * orbitSpeed;
  const velocityX = -Math.sin(angle) * orbitRadius * orbitSpeed;
  const velocityY = descentVelocity + Math.cos(angle) * orbitRadius * orbitSpeed;

  return {
    x: centerX + Math.cos(angle) * orbitRadius,
    y: startY + descentVelocity * ageSeconds + Math.sin(angle) * orbitRadius,
    rotation: Math.atan2(-velocityX, velocityY),
  };
}

export function bossMilestoneForSector(sector: number): number | null {
  const milestone = Math.floor(normalizedSectorValue(sector) / 5) * 5;
  return milestone >= 5 ? milestone : null;
}

export function bossArchetypeForSector(sector: number): BossArchetype {
  const milestone = bossMilestoneForSector(sector);
  const encounterIndex = milestone === null ? 0 : Math.max(0, milestone / 5 - 1);
  return BOSS_ARCHETYPES[encounterIndex % BOSS_ARCHETYPES.length] ?? "ravager";
}

export function bossRulesForArchetype(archetype: BossArchetype): Readonly<BossArchetypeRules> {
  return BOSS_ARCHETYPE_RULES[archetype];
}

export function bossRulesForSector(sector: number): Readonly<BossArchetypeRules> {
  return bossRulesForArchetype(bossArchetypeForSector(sector));
}

export function bossNameForArchetype(archetype: BossArchetype): string {
  return bossRulesForArchetype(archetype).displayName;
}

export function bossWeaponForPhase(archetype: BossArchetype, phase: BossPhase): BossWeaponPattern {
  const weapons = bossRulesForArchetype(archetype).phaseWeapons;

  if (phase === 1) {
    return weapons[0];
  }

  if (phase === 2) {
    return weapons[1];
  }

  return weapons[2];
}

export function bossHealthForSector(
  sector: number,
  archetype: BossArchetype = bossArchetypeForSector(sector),
): number {
  const terminalSector = Math.min(TERMINAL_DIFFICULTY_SECTOR, normalizedSectorValue(sector));
  const baseHealth = 230 + terminalSector * 15 + Math.pow(terminalSector, 1.24) * 4.8;
  return Math.round(baseHealth * bossRulesForArchetype(archetype).healthMultiplier);
}

export function bossRewardForSector(
  sector: number,
  archetype: BossArchetype = bossArchetypeForSector(sector),
): number {
  const baseReward = 1000 + normalizedSectorValue(sector) * 100;
  return Math.round(baseReward * bossRulesForArchetype(archetype).rewardMultiplier);
}

export function bossPhaseForHealth(health: number, maximumHealth: number): BossPhase {
  const ratio = maximumHealth > 0 ? Math.max(0, health) / maximumHealth : 0;

  if (ratio > 2 / 3) {
    return 1;
  }

  if (ratio > 1 / 3) {
    return 2;
  }

  return 3;
}
