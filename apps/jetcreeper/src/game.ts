import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPixelatedPass } from "three/addons/postprocessing/RenderPixelatedPass.js";
import {
  JET_ABILITY_KINDS,
  JET_ABILITY_SPECS,
  JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS,
  JET_FLIGHT_SYSTEM_KEYS,
  jetFlightSystemForKeyboardCode,
  activateJetAbility,
  createLockedJetAbilityStates,
  jetAbilityReady,
  nextGuaranteedAbilityCore,
  resolveAbilityCrate,
  tickJetAbilityState,
  type JetAbilityKind,
  type JetAbilityKey,
  type JetAbilityState,
  type JetAbilityStates,
  type JetFlightSystemKind,
} from "./abilities";
import {
  DEFAULT_SUPER_BRAIN_CONFIG,
  SUPER_BRAIN_DECISION_INTERVAL_SECONDS,
  SuperBrainController,
  assessSuperBrainRoute,
  type BrainDecision,
  type BrainObservation,
  type BrainPickup,
  type BrainRouteAssessment,
  type BrainTarget,
  type BrainThreat,
} from "./autopilot";
import { decideAutoCombatSystems } from "./auto_combat_systems";
import {
  INITIAL_EMERGENCY_ASSIST_STATE,
  emergencyRescueObservation,
  evaluateEmergencyAssist,
  manualRouteNeedsEmergencyAssist,
  tickEmergencyAssist,
  type EmergencyAssistState,
  type EmergencyAssistTransition,
} from "./emergency_assist";
import {
  MAX_PLAYER_MISSILES_PER_SALVO,
  PLAYER_AIM_TUNING,
  allocatePlayerMissileTargets,
  selectPlayerCannonAim,
  type PlayerAimTarget,
  type PlayerMissileTarget,
} from "./combat_targeting";
import {
  ACCELERATOR_PROJECTILE_SPEED_MULTIPLIER,
  AFTERBURNER_FLIGHT_MULTIPLIER,
  CHAIN_LIGHTNING_DAMAGE_FALLOFF,
  CHAIN_LIGHTNING_DAMAGE_MULTIPLIER,
  CHAIN_LIGHTNING_MAX_SECONDARY_TARGETS,
  CHAIN_LIGHTNING_RADIUS,
  CRYO_SLOW_SECONDS,
  CRYO_TIME_SCALE,
  EXPLOSIVE_SPLASH_DAMAGE_MULTIPLIER,
  EXPLOSIVE_SPLASH_RADIUS,
  MAGNET_ATTRACTION_RADIUS,
  MAGNET_COLLECTION_RADIUS_BONUS,
  MISSILE_RACK_DAMAGE_MULTIPLIER,
  MISSILE_RACK_SALVO_COUNT,
  NANOREPAIR_MAX_CHARGED_KILLS,
  PIERCING_EXTRA_TARGETS,
  RICOCHET_REDIRECTS,
  TARGETING_MAXIMUM_AIM_ANGLE_RADIANS,
  TARGETING_MAXIMUM_LEAD_SECONDS,
  TARGETING_STEERING_PER_SECOND,
  amplifiedBombPayload,
  applyNanorepairKill,
  magnetAttractionSpeed,
  phaseHullCollisionRadius,
} from "./attachment_effects";
import {
  JET_ATTACHMENT_KINDS,
  type JetAttachmentKind,
} from "./attachments";
import {
  CAVE_LAYER_SPECS,
  advanceCaveDifficultySector,
  caveWallClearance,
  sampleCaveCorridor,
  sampleCaveLayerCorridor,
  sweepCircleThroughCave,
  type CaveLayerSpec,
} from "./cave";
import {
  applyBossEscortDamageGate,
  bossEscortDamageBudget,
  bossEscortSafeEntryY,
  createBossEscortProgress,
  nextBossEscortWave,
  recordBossEscortWaveLaunch,
  type BossEscortProgress,
  type BossEscortUnitPlan,
  type BossEscortWaveNumber,
} from "./boss_escorts";
import {
  beginBossEncounter,
  createEncounterCadence,
  normalWaveSpawnCount,
  recordBossDefeat,
  recordNormalWaveClear,
  type EncounterCadenceState,
} from "./encounter_cadence";
import {
  DASH_BARREL_ROLL_SECONDS,
  RESTING_FLIGHT_MOTION,
  dashBarrelRollAngle,
  stepFlightMotion,
  type FlightMotionState,
} from "./flight_motion";
import {
  GUARDIAN_WING_ACTIVE_SECONDS,
  GUARDIAN_WING_PROJECTILE_DAMAGE,
  GUARDIAN_WING_PROJECTILE_SPEED,
  GUARDIAN_WING_RESERVED_PROJECTILE_SLOTS,
  initialGuardianWingFireCooldown,
  playerCannonFireInterval,
  stepGuardianWingCadence,
} from "./guardian_wing_fire";
import {
  PILOT_LINE_NODE_COUNT,
  PILOT_SYNC_TARGET,
  nextPilotNodeAfterCrossing,
  pilotLanePattern,
  pilotLaneTarget,
  pilotNodeRemainingSeconds,
  resolvePilotLine,
  type PilotLane,
} from "./pilot_lines";
import { ARCADE_PALETTE } from "./palette";
import {
  LOW_PROFILE_HOSTILE_TIME_SCALE,
  LOW_PROFILE_PLAYER_SPEED_MULTIPLIER,
  LOW_PROFILE_TIME_WARP_SECONDS,
  laserDamageForBoss,
  laserDamageForTarget,
  remainingBossLaserStrikeDamage,
} from "./laser_rules";
import {
  evaluateManualEmergencySentinel,
  type ManualEmergencyThreat,
} from "./manual_emergency_sentinel";
import {
  cometTailOffsetY,
  projectileHeadingRadians,
} from "./projectile_visual";
import {
  REMOTE_BOMB_BLAST_RADIUS,
  REMOTE_BOMB_DAMAGE_MULTIPLIER,
  REMOTE_BOMB_FORWARD_DISTANCE,
  REMOTE_BOMB_LAUNCH_SPEED,
  REMOTE_BOMB_MAX_ARMED_SECONDS,
  remoteBombDamage,
} from "./remote_bomb";
import {
  DEFAULT_RUN_DIFFICULTY,
  enemyImpactShardCount,
  runDifficultyProfile,
  scaledBossHealth,
  scaledCrateSpawnDelay,
  scaledHostileFireDelay,
  scaledHostileProjectileCap,
  scaledHostileProjectileSpeed,
  scaledHostileVolleyCount,
  type RunDifficultyLevel,
} from "./run_difficulty";
import {
  SHIP_VISUAL_PROFILES,
  emergencyHullScan,
  shipVisualMode,
  type ShipVisualMode,
} from "./ship_visual_mode";
import { selectWingmanCountermeasures } from "./wingman_countermeasures";
import {
  BOSS_ARCHETYPES,
  BONUS_KINDS,
  ENEMY_PRESSURE_TUNING,
  ENEMY_KINDS,
  bonusDurationSeconds,
  bonusLabel,
  bossHealthForSector,
  bossNameForArchetype,
  bossPhaseForHealth,
  bossRewardForSector,
  bossRulesForArchetype,
  bossWeaponForPhase,
  brainPressureAdmissionThresholds,
  canFireRocket,
  canSpawnTurret,
  circlesOverlap,
  clampNumber,
  difficultyForSector,
  enemyArchetypeForKind,
  enemyKindForRoll,
  fighterLoopPose,
  isProtectedOpening,
  isTerminalPressureUnbounded,
  movingCirclesOverlap,
  resolveDamage,
  scoreForEnemy,
  scaledEnemyVolleyCount,
  segmentCircleOverlap,
  sectorForScore,
  unsafeRouteAdmissionChance,
  type BonusKind,
  type BossArchetype,
  type BossPhase,
  type BossWeaponPattern,
  type Difficulty,
  type EnemyKind,
} from "./game_rules";

const WORLD_WIDTH = 20;
const WORLD_HEIGHT = 32;
const WORLD_LEFT = -WORLD_WIDTH / 2;
const WORLD_RIGHT = WORLD_WIDTH / 2;
const WORLD_TOP = WORLD_HEIGHT / 2;
const WORLD_BOTTOM = -WORLD_HEIGHT / 2;
const BACKGROUND_HALF_WIDTH = 30;
const PLAYER_START_Y = WORLD_BOTTOM + 3.6;
const PLAYER_RADIUS = 0.78;
const PLAYER_SPEED = 11.5;
const FIXED_STEP_SECONDS = 1 / 60;
const MAX_SIMULATION_STEPS_PER_FRAME = 8;
const LOW_PROFILE_SCALE = 0.55;
const LOW_PROFILE_RADIUS = 0.42;
const LOW_PROFILE_SECONDS = 1.35;
const LOW_PROFILE_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS["low-profile"];
// The exact 0.12-second 4× phase crosses 5.52 world units instead of 17.48.
// The independent 1.08-second motion trail keeps the dramatic long visual without
// locking movement across nearly the whole cave.
const DASH_TRAVEL_SECONDS = 0.12;
const DASH_EFFECT_SECONDS = 1.08;
const DASH_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS.dash;
const DASH_SPEED = PLAYER_SPEED * 4;
const BURST_SECONDS = 1;
const BURST_DAMAGE_MULTIPLIER = 10;
const BURST_SCATTER_RADIANS = THREE.MathUtils.degToRad(5);
const MISSILE_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS.missiles;
const MISSILE_SPEED = 15;
const MISSILE_DAMAGE = 5;
const MISSILE_LIFETIME_SECONDS = 5;
const LASER_DAMAGE_INTERVAL_SECONDS = 0.1;
const NORMAL_CANNON_DAMAGE = 1;
const REMOTE_BOMB_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS["remote-bomb"];
const GUARDIAN_WING_COOLDOWN_SECONDS = JET_FLIGHT_SYSTEM_COOLDOWN_SECONDS["guardian-wing"];
const GUARDIAN_WING_COUNTERMEASURE_INTERVAL_SECONDS = 0.48;
const GUARDIAN_WING_COUNTERMEASURE_RADIUS = 8;
const GUARDIAN_WING_COLLISION_HORIZON_SECONDS = 1.6;
const NORMAL_WAVE_INTERMISSION_SECONDS = 1.65;
const HUD_INTERVAL_SECONDS = 0.1;
const BEST_SCORE_KEY = "jetcreeper-best-score-v1";
const BOSS_RADIUS = 2.7;
const BOSS_TARGET_Y = WORLD_TOP - 5.4;
const PIXEL_BLOCK_CSS_PIXELS = 4;
const MAX_RENDER_PIXEL_RATIO = 2;
const CAVE_ROW_COUNT = 52;
// Nine depth samples keep the complete five-stratum cave below five thousand
// dynamic vertices while concentrating enough facets near the playable rim to
// read as top-down mountain relief after the whole-scene pixel pass.
const CAVE_MESH_COLUMN_COUNT = 9;
const CAVE_MESH_DEPTH_CURVE = 1.85;
const CAVE_RELIEF_LOGICAL_DEPTH = 26;
const CAVE_RELIEF_SEED = 0x2d71_9ac5;
const CAVE_VISUAL_BOTTOM = WORLD_BOTTOM - 2.5;
const CAVE_VISUAL_TOP = WORLD_TOP + 2.5;
const CAVE_CONTACT_RESOLUTION_CLEARANCE = 0.18;
const CAVE_CONTACT_RELEASE_CLEARANCE = 0.12;
const RESPAWN_INVULNERABILITY_SECONDS = 2.4;
const RESPAWN_PROJECTILE_CLEAR_RADIUS = 6.5;
const PILOT_LINE_INPUT_GRACE_SECONDS = 0.9;
const PILOT_LINE_RADIUS = 1.22;
const PILOT_LINE_FIRST_Y = -1;
const PILOT_LINE_NODE_SPACING = 7;
const PILOT_LINE_AUTO_RESUME_COOLDOWN_SECONDS = 4.5;
// One impact owns a ring, core, and ten shard meshes. Thirty-six concurrent
// bursts still produce 360 moving shards without allowing hit feedback alone
// to dominate the draw-call budget during a 10x boss burst.
const MAX_ACTIVE_IMPACTS = 36;
const REDUCED_MOTION_MAX_ACTIVE_IMPACTS = 12;
const IMPACT_SHARD_COUNT = 10;
// Denser muzzle flashes reuse the same bounded impact pool. The burst helper
// still collapses every reduced-motion request to one impact.
const ENEMY_MUZZLE_IMPACT_BASE = 2;
const BOSS_MUZZLE_IMPACT_BASE = 3;
const ROCKET_LAUNCH_IMPACT_COUNT = 3;
const IMPACT_HIGHLIGHT_COLOR = new THREE.Color(ARCADE_PALETTE.ivory);

const PLAYER_PINK = ARCADE_PALETTE.playerMagenta;
const PLAYER_YELLOW = ARCADE_PALETTE.playerYellow;
const PLAYER_FIRE_CYAN = ARCADE_PALETTE.aiCyan;
const PLAYER_FIRE_CORE = 0xd9fcff;
const PLAYER_LASER_CORE = 0xeaffff;
const PLAYER_MISSILE_BODY = 0xbaf8ff;
const PLAYER_MISSILE_EMISSIVE = 0x0b6674;
const ENEMY_FIRE_RED = 0xe43d30;
const ENEMY_FIRE_ORANGE = ARCADE_PALETTE.telegraphOrange;
const ENEMY_FIRE_CORE = 0xffb347;
const ENEMY_CHARGE_CORE = 0xffc06a;
const WORLD_CLEAR_COLOR = 0x060708;

const CAVE_LAYER_COLORS: Readonly<Record<CaveLayerSpec["id"], number>> = Object.freeze({
  "deep-void": 0x0d0f10,
  "far-rock": 0x161819,
  "mid-rock": 0x202325,
  "near-rock": 0x292d30,
  rim: 0x34393c,
});

const STARFIELD_COLORS = Object.freeze([
  0x464b4e,
  0x555b5f,
  0x656c70,
  0x383c3f,
] as const);

const CAVE_ROCK_TEXTURE_SIZE = 128;
const CAVE_ROCK_TEXTURE_NAME = "Jetcreeper.cave-rock";
const CAVE_ROCK_TEXTURE_SCALE_X = 0.06;
const CAVE_ROCK_TEXTURE_SCALE_Y = 0.045;
const CAVE_ROCK_LAYER_OFFSET = 0.173;
const CAVE_ROCK_SEED = 0x5a17_c4e3;
const CAVE_RELIEF_AMPLITUDE: Readonly<Record<CaveLayerSpec["id"], number>> = Object.freeze({
  "deep-void": 0.24,
  "far-rock": 0.34,
  "mid-rock": 0.44,
  "near-rock": 0.55,
  rim: 0.68,
});

const BONUS_COLORS: Readonly<Record<BonusKind, readonly [number, number]>> = Object.freeze({
  shield: [0x2588a4, ARCADE_PALETTE.shieldAzure],
  rapid: [0xc28c19, PLAYER_YELLOW],
  pulse: [0x3d913c, ARCADE_PALETTE.repairGreen],
  spread: [0xa51c68, 0xff71bb],
  plasma: [0x315bc2, ARCADE_PALETTE.plasmaCobalt],
  missile: [0xb94a35, 0xff9c6d],
  beam: [0xb31c70, 0xff69b5],
  drone: [0x5a6d92, 0xbfd3ff],
  overdrive: [0xc9196e, PLAYER_YELLOW],
  stasis: [0x6846b0, ARCADE_PALETTE.stasisViolet],
  piercing: [0x176c7c, 0x70e8ff],
  ricochet: [0x9a5b16, 0xffc062],
  "chain-lightning": [0x5f63a8, 0xe9e568],
  explosive: [0x9c2638, 0xff6758],
  cryo: [0x287fa5, 0x8feaff],
  targeting: [0x267955, 0x76f5ad],
  accelerator: [0x6f7686, 0xf5f1d0],
  afterburner: [0xb64b1d, 0xffa33d],
  "phase-hull": [0x6446a9, 0xb59aff],
  magnet: [0x217d70, 0x64ebd0],
  nanorepair: [0x3b843d, ARCADE_PALETTE.repairGreen],
  "missile-rack": [0x994338, 0xffa06e],
  "bomb-amplifier": [0x7f294a, 0xff5b9e],
  counterflare: [0x167a62, ARCADE_PALETTE.counterMint],
  "gravity-knot": [0x4e3a9e, ARCADE_PALETTE.stasisViolet],
  "phoenix-squadron": [0xb51f70, ARCADE_PALETTE.playerYellow],
});

type AdvancedAttachmentKind = Exclude<
  JetAttachmentKind,
  "rapid" | "spread" | "plasma" | "beam" | "drone" | "overdrive" | "stasis"
>;

const ADVANCED_ATTACHMENT_KINDS = JET_ATTACHMENT_KINDS.slice(7) as readonly AdvancedAttachmentKind[];

export type GameStatus = "ready" | "running" | "paused" | "game-over" | "unsupported";
export type JetMovementDirection = "up" | "down" | "left" | "right";

const MOVEMENT_CONTROL_CODES: Readonly<Record<JetMovementDirection, string>> =
  Object.freeze({
    up: "PointerUp",
    down: "PointerDown",
    left: "PointerLeft",
    right: "PointerRight",
  });
const LEFT_MOVEMENT_CODES = ["ArrowLeft", "KeyA", MOVEMENT_CONTROL_CODES.left] as const;
const RIGHT_MOVEMENT_CODES = ["ArrowRight", "KeyD", MOVEMENT_CONTROL_CODES.right] as const;
const DOWN_MOVEMENT_CODES = ["ArrowDown", "KeyS", MOVEMENT_CONTROL_CODES.down] as const;
const UP_MOVEMENT_CODES = ["ArrowUp", "KeyW", MOVEMENT_CONTROL_CODES.up] as const;

export type BrainTacticalMode =
  | "Manual control"
  | "Emergency evade"
  | "Cruising"
  | "Stabilizing"
  | "Following steer"
  | "Collecting crate"
  | "Engaging"
  | "Dodging"
  | "Dashing"
  | "Low-profile";

export interface ActiveWeaponEffect {
  readonly id: string;
  readonly label: string;
  readonly seconds: number | null;
}

export interface JetAbilitySnapshot {
  readonly kind: JetAbilityKind;
  readonly label: string;
  readonly key: JetAbilityKey;
  readonly unlocked: boolean;
  readonly cooldownSeconds: number;
  readonly activeSeconds: number;
}

export interface GameSnapshot {
  status: GameStatus;
  difficultyLevel: RunDifficultyLevel;
  score: number;
  bestScore: number;
  lives: number;
  sector: number;
  shielded: boolean;
  rapidFireSeconds: number;
  autoPilotEnabled: boolean;
  emergencyAssistActive: boolean;
  emergencyAssistSeconds: number;
  brainActive: boolean;
  brainMode: BrainTacticalMode;
  dashActiveSeconds: number;
  dashCooldownSeconds: number;
  burstSeconds: number;
  lowProfileSeconds: number;
  lowProfileCooldownSeconds: number;
  missileCooldownSeconds: number;
  remoteBombActive: boolean;
  remoteBombArmedSeconds: number;
  remoteBombCooldownSeconds: number;
  guardianWingSeconds: number;
  guardianWingCooldownSeconds: number;
  jetAbilities: readonly JetAbilitySnapshot[];
  activeWeaponEffects: readonly ActiveWeaponEffect[];
  bossActive: boolean;
  bossName: string;
  bossHealth: number;
  bossMaxHealth: number;
  bossPhase: BossPhase;
  bossPattern: BossWeaponPattern;
  pilotLineActive: boolean;
  pilotLineStep: number;
  pilotLineDirection: "left" | "center" | "right";
  pilotLineSeconds: number;
  pilotSync: number;
  pilotSyncTarget: number;
  pilotStyleScore: number;
  announcement: string | null;
}

export interface JetcreeperGameOptions {
  host: HTMLElement;
  onSnapshot: (snapshot: GameSnapshot) => void;
  randomSeed?: number;
}

interface Assets {
  star: THREE.PlaneGeometry;
  playerHull: THREE.ShapeGeometry;
  playerWing: THREE.ShapeGeometry;
  playerCockpit: THREE.SphereGeometry;
  engineGlow: THREE.CircleGeometry;
  gunPod: THREE.BoxGeometry;
  playerShieldSphere: THREE.SphereGeometry;
  shield: THREE.RingGeometry;
  fighterHull: THREE.ShapeGeometry;
  fighterWing: THREE.ShapeGeometry;
  bossHull: THREE.ShapeGeometry;
  bossWing: THREE.ShapeGeometry;
  bossCannon: THREE.BoxGeometry;
  bossCore: THREE.TorusGeometry;
  turretBase: THREE.CylinderGeometry;
  turretRing: THREE.TorusGeometry;
  turretBarrel: THREE.BoxGeometry;
  turretMuzzle: THREE.CircleGeometry;
  asteroid: THREE.IcosahedronGeometry;
  asteroidEdges: THREE.EdgesGeometry;
  bonusBox: THREE.BoxGeometry;
  bonusFrame: THREE.EdgesGeometry;
  bonusCore: THREE.CircleGeometry;
  bonusShield: THREE.RingGeometry;
  bonusRapid: THREE.ShapeGeometry;
  bonusPulse: THREE.ShapeGeometry;
  playerProjectile: THREE.SphereGeometry;
  playerProjectileGlow: THREE.ShapeGeometry;
  playerMissile: THREE.ShapeGeometry;
  playerMissileFins: THREE.BoxGeometry;
  playerMissileFlame: THREE.ShapeGeometry;
  playerMissileGlow: THREE.PlaneGeometry;
  playerLaserCore: THREE.PlaneGeometry;
  playerLaserGlow: THREE.PlaneGeometry;
  enemyProjectile: THREE.SphereGeometry;
  enemyProjectileGlow: THREE.ShapeGeometry;
  enemyRocket: THREE.ShapeGeometry;
  enemyRocketFins: THREE.BoxGeometry;
  enemyRocketFlame: THREE.ShapeGeometry;
  enemyRocketGlow: THREE.PlaneGeometry;
  impact: THREE.RingGeometry;
  impactShard: THREE.BoxGeometry;
  starMaterial: THREE.MeshBasicMaterial;
  playerMaterial: THREE.MeshStandardMaterial;
  playerWingMaterial: THREE.MeshStandardMaterial;
  playerAccentMaterial: THREE.MeshBasicMaterial;
  playerCockpitMaterial: THREE.MeshStandardMaterial;
  engineMaterial: THREE.MeshBasicMaterial;
  engineCoreMaterial: THREE.MeshBasicMaterial;
  playerShieldGlassMaterial: THREE.MeshPhysicalMaterial;
  playerShieldEnergyMaterial: THREE.ShaderMaterial;
  fighterMaterial: THREE.MeshStandardMaterial;
  fighterWingMaterial: THREE.MeshStandardMaterial;
  fighterAccentMaterial: THREE.MeshBasicMaterial;
  enemyEngineMaterial: THREE.MeshBasicMaterial;
  turretMaterial: THREE.MeshStandardMaterial;
  turretBarrelMaterial: THREE.MeshStandardMaterial;
  asteroidMaterial: THREE.MeshStandardMaterial;
  asteroidEdgeMaterial: THREE.LineBasicMaterial;
  playerProjectileMaterial: THREE.MeshBasicMaterial;
  playerProjectileGlowMaterial: THREE.MeshBasicMaterial;
  playerMissileMaterial: THREE.MeshStandardMaterial;
  playerMissileAccentMaterial: THREE.MeshBasicMaterial;
  playerMissileGlowMaterial: THREE.MeshBasicMaterial;
  playerLaserMaterial: THREE.MeshBasicMaterial;
  playerLaserGlowMaterial: THREE.MeshBasicMaterial;
  enemyProjectileMaterial: THREE.MeshStandardMaterial;
  enemyProjectileGlowMaterial: THREE.MeshBasicMaterial;
  enemyRocketMaterial: THREE.MeshStandardMaterial;
  enemyRocketAccentMaterial: THREE.MeshBasicMaterial;
  enemyRocketGlowMaterial: THREE.MeshBasicMaterial;
  bonusMaterials: Record<BonusKind, THREE.MeshStandardMaterial>;
  bonusFrameMaterials: Record<BonusKind, THREE.LineBasicMaterial>;
  bonusCoreMaterial: THREE.MeshBasicMaterial;
}

interface Star {
  x: number;
  y: number;
  speed: number;
  scale: number;
}

type ProjectileKind = "player" | "player-missile" | "enemy" | "rocket";
type AbilitySource = "auto" | "emergency" | "manual" | "crate";
type EnemyShotStyle = "bolt" | "heavy" | "rail" | "mine" | "phase" | "arc" | "tether" | "temporal";
type ImpactSource = "enemy" | "friendly" | "neutral";

interface Projectile {
  kind: ProjectileKind;
  mesh: THREE.Group;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  radius: number;
  age: number;
  speed: number;
  previousX: number;
  previousY: number;
  damage: number;
  targetId: number | null;
  targetBoss: boolean;
  style: EnemyShotStyle;
  piercingTargetsRemaining: number;
  ricochetsRemaining: number;
  chainLightning: boolean;
  explosive: boolean;
  cryo: boolean;
  targetingSteering: boolean;
  hitEnemyIds: number[];
  hitBoss: boolean;
  /** Positive until a temporal round reverses once; negative after rewinding. */
  rewindAtSeconds: number;
}

interface Enemy {
  id: number;
  kind: EnemyKind;
  mesh: THREE.Group;
  velocityY: number;
  radius: number;
  health: number;
  maxHealth: number;
  cooldown: number;
  age: number;
  baseX: number;
  baseY: number;
  orbitRadius: number;
  orbitSpeed: number;
  orbitPhase: number;
  rocketCooldown: number;
  rotationSpeed: number;
  chargeMaterial: THREE.MeshBasicMaterial | undefined;
  aimGroup: THREE.Group | undefined;
  chargeMesh: THREE.Mesh | undefined;
  elite: boolean;
  weaponIndex: number;
  observedVelocityX: number;
  observedVelocityY: number;
  wallSide: -1 | 0 | 1;
  bossEscort: boolean;
  cryoRemaining: number;
}

interface Boss {
  mesh: THREE.Group;
  active: boolean;
  entering: boolean;
  health: number;
  maxHealth: number;
  phase: BossPhase;
  age: number;
  attackCooldown: number;
  patternIndex: number;
  hitFlashRemaining: number;
  hullMaterial: THREE.MeshStandardMaterial;
  wingMaterial: THREE.MeshStandardMaterial;
  chargeMaterial: THREE.MeshBasicMaterial;
  chargeGlows: THREE.Mesh[];
  engineGlows: THREE.Mesh[];
  entryShield: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  archetype: BossArchetype;
  name: string;
  radius: number;
  observedVelocityX: number;
  observedVelocityY: number;
  cryoRemaining: number;
  variants: Record<BossArchetype, THREE.Group>;
}

interface EnemySpawnOptions {
  readonly elite?: boolean;
  readonly spawnY?: number;
  readonly bossEscort?: boolean;
}

interface PendingBossEscort {
  readonly unit: BossEscortUnitPlan;
  readonly spawnAtSeconds: number;
  readonly minimumPlayerSeparation: number;
  readonly waveNumber: BossEscortWaveNumber;
}

interface Bonus {
  id: number;
  kind: BonusKind;
  mesh: THREE.Group;
  velocityY: number;
  radius: number;
  age: number;
}

interface Impact {
  mesh: THREE.Group;
  material: THREE.MeshBasicMaterial;
  highlightMaterial: THREE.MeshBasicMaterial;
  ring: THREE.Mesh;
  core: THREE.Mesh;
  shards: THREE.Mesh[];
  shardAngles: Float32Array;
  shardSpeeds: Float32Array;
  shardSpins: Float32Array;
  age: number;
  duration: number;
  scale: number;
}

interface DashTrailVisual {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  material: THREE.ShaderMaterial;
}

interface AbilityFieldVisual {
  readonly group: THREE.Group;
  readonly rings: THREE.Mesh[];
  readonly particles: THREE.Mesh[];
  readonly primaryMaterial: THREE.MeshBasicMaterial;
  readonly secondaryMaterial: THREE.MeshBasicMaterial;
}

interface PlayerShieldVisual {
  readonly group: THREE.Group;
  readonly glass: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  readonly energy: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
}

interface ShipEngineVisuals {
  readonly glows: readonly THREE.Mesh[];
  readonly cores: readonly THREE.Mesh[];
}

interface PlayerModeVisual {
  readonly manualModel: THREE.Group;
  readonly autoModel: THREE.Group;
  readonly emergencyOverlay: THREE.Group;
  readonly emergencyScanners: readonly THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
  readonly emergencyCageMaterials: readonly THREE.MeshBasicMaterial[];
  readonly manualEngines: ShipEngineVisuals;
  readonly autoEngines: ShipEngineVisuals;
  readonly autoHullMaterial: THREE.MeshBasicMaterial;
  readonly autoWingMaterial: THREE.MeshBasicMaterial;
  readonly autoCoreMaterial: THREE.MeshBasicMaterial;
  readonly autoAccentMaterial: THREE.MeshBasicMaterial;
  readonly manualTrailMaterial: THREE.ShaderMaterial;
  readonly manualTrails: readonly THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>[];
  readonly autoCoreRings: readonly THREE.Mesh[];
  appliedMode: ShipVisualMode | null;
}

interface PhoenixWingVisual {
  readonly group: THREE.Group;
  readonly trailMaterial: THREE.MeshBasicMaterial;
  age: number;
  laneX: number;
}

interface RemoteBombVisual {
  readonly group: THREE.Group;
  readonly coreMaterial: THREE.MeshBasicMaterial;
  readonly ringMaterial: THREE.MeshBasicMaterial;
  readonly rings: readonly THREE.Mesh[];
}

interface GuardianWingVisual {
  readonly id: number;
  readonly side: -1 | 1;
  readonly group: THREE.Group;
  readonly countermeasureRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  readonly countermeasureMaterial: THREE.MeshBasicMaterial;
  countermeasureCooldown: number;
  offensiveFireCooldown: number;
  logicalShotsAccumulated: number;
  pulseSeconds: number;
}

interface CaveLayerVisual {
  readonly spec: CaveLayerSpec;
  readonly leftGeometry: THREE.BufferGeometry;
  readonly rightGeometry: THREE.BufferGeometry;
  readonly leftMesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly rightMesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

interface PilotLineNode {
  readonly mesh: THREE.Group;
  readonly ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  readonly core: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  readonly ringMaterial: THREE.MeshBasicMaterial;
  readonly coreMaterial: THREE.MeshBasicMaterial;
  lane: PilotLane;
}

interface PilotLine {
  readonly nodes: readonly PilotLineNode[];
  active: boolean;
  nextNode: number;
  velocityY: number;
  age: number;
}

function createSeededRandom(seed: number): () => number {
  let state = Math.floor(seed) >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function rockNoiseFade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function rockNoiseHash(x: number, y: number, seed: number): number {
  let value = Math.imul(x, 0x1f12_3bb5) ^ Math.imul(y, 0x5f35_6495) ^ seed;
  value = Math.imul(value ^ value >>> 16, 0x7feb_352d);
  value = Math.imul(value ^ value >>> 15, 0x846c_a68b);
  return ((value ^ value >>> 16) >>> 0) / 4_294_967_295 * 2 - 1;
}

/** Periodic value noise keeps the generated texture seamless on both axes. */
function tileableRockNoise(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);
  const x0 = positiveModulo(floorX, cells);
  const y0 = positiveModulo(floorY, cells);
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const blendX = rockNoiseFade(x - floorX);
  const blendY = rockNoiseFade(y - floorY);
  const top = THREE.MathUtils.lerp(
    rockNoiseHash(x0, y0, seed),
    rockNoiseHash(x1, y0, seed),
    blendX,
  );
  const bottom = THREE.MathUtils.lerp(
    rockNoiseHash(x0, y1, seed),
    rockNoiseHash(x1, y1, seed),
    blendX,
  );
  return THREE.MathUtils.lerp(top, bottom, blendY);
}

/** Infinite, deterministic C2 surface noise for the cave's actual Z relief. */
function caveSurfaceNoise(x: number, y: number, seed: number): number {
  const floorX = Math.floor(x);
  const floorY = Math.floor(y);
  const blendX = rockNoiseFade(x - floorX);
  const blendY = rockNoiseFade(y - floorY);
  const top = THREE.MathUtils.lerp(
    rockNoiseHash(floorX, floorY, seed),
    rockNoiseHash(floorX + 1, floorY, seed),
    blendX,
  );
  const bottom = THREE.MathUtils.lerp(
    rockNoiseHash(floorX, floorY + 1, seed),
    rockNoiseHash(floorX + 1, floorY + 1, seed),
    blendX,
  );
  return THREE.MathUtils.lerp(top, bottom, blendY);
}

/**
 * Stable mountain relief sampled in cave-local coordinates. Longitudinal
 * distance is always `caveTravel + WORLD_TOP + screenY`, exactly like the
 * physical wall sampler, so a ridge entering at the top keeps its shape while
 * moving down the screen. No clock or frame-random value participates.
 */
function caveMountainRelief(
  layer: CaveLayerSpec,
  layerIndex: number,
  side: -1 | 1,
  depthFromInnerEdge: number,
  longitudinalDistance: number,
): number {
  const logicalDepth = depthFromInnerEdge * CAVE_RELIEF_LOGICAL_DEPTH;
  const layerSeed = CAVE_RELIEF_SEED
    ^ Math.imul(layerIndex + 1, 0x1f12_3bb5)
    ^ (side < 0 ? 0x43b7_2fd1 : 0x72d6_820f);
  const sideOffset = side < 0 ? 11.7 : -19.3;
  const layerOffset = layerIndex * 7.1;
  const broad = caveSurfaceNoise(
    (logicalDepth + sideOffset) / 8.4,
    (longitudinalDistance + layerOffset) / 13.5,
    layerSeed,
  );
  const ridgeField = caveSurfaceNoise(
    (logicalDepth - layerOffset) / 4.9,
    (longitudinalDistance + sideOffset) / 8.2,
    layerSeed ^ 0x68bc_21eb,
  );
  const detail = caveSurfaceNoise(
    (logicalDepth + layerOffset) / 2.65,
    (longitudinalDistance - sideOffset) / 4.4,
    layerSeed ^ 0x02e5_be93,
  );
  const ridgedMountain = 1 - Math.abs(ridgeField);
  const brokenRim = Math.exp(-depthFromInnerEdge * 7.5) * (0.08 + Math.max(0, detail) * 0.08);
  const height = THREE.MathUtils.clamp(
    0.3 + broad * 0.22 + ridgedMountain * 0.34 + detail * 0.09 + brokenRim,
    0.08,
    0.98,
  );
  return height * CAVE_RELIEF_AMPLITUDE[layer.id];
}

function createCaveRockTexture(): THREE.DataTexture {
  const data = new Uint8Array(CAVE_ROCK_TEXTURE_SIZE * CAVE_ROCK_TEXTURE_SIZE * 4);

  for (let y = 0; y < CAVE_ROCK_TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < CAVE_ROCK_TEXTURE_SIZE; x += 1) {
      const u = x / CAVE_ROCK_TEXTURE_SIZE;
      const v = y / CAVE_ROCK_TEXTURE_SIZE;
      const warpX = tileableRockNoise(u, v, 2, CAVE_ROCK_SEED ^ 0x68bc_21eb) * 0.055;
      const warpY = tileableRockNoise(u, v, 2, CAVE_ROCK_SEED ^ 0x02e5_be93) * 0.055;
      const warpedU = u + warpX;
      const warpedV = v + warpY;
      const broad = tileableRockNoise(warpedU, warpedV, 2, CAVE_ROCK_SEED) * 0.56
        + tileableRockNoise(warpedU, warpedV, 4, CAVE_ROCK_SEED ^ 0x19c8_4e63) * 0.29
        + tileableRockNoise(warpedU, warpedV, 8, CAVE_ROCK_SEED ^ 0x43b7_2fd1) * 0.15;
      const grain = tileableRockNoise(warpedU, warpedV, 16, CAVE_ROCK_SEED ^ 0x3d58_a94b);
      const fractureDistance = Math.abs(
        tileableRockNoise(warpedU, warpedV, 7, CAVE_ROCK_SEED ^ 0x72d6_820f),
      );
      const crack = 1 - THREE.MathUtils.smoothstep(fractureDistance, 0.025, 0.115);
      const shade = THREE.MathUtils.clamp(0.78 + broad * 0.15 + grain * 0.055 - crack * 0.2, 0.42, 0.98);
      const channel = Math.round(shade * 255);
      const offset = (y * CAVE_ROCK_TEXTURE_SIZE + x) * 4;
      data[offset] = channel;
      data[offset + 1] = channel;
      data[offset + 2] = channel;
      data[offset + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(
    data,
    CAVE_ROCK_TEXTURE_SIZE,
    CAVE_ROCK_TEXTURE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.name = CAVE_ROCK_TEXTURE_NAME;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // The surface is pixel art before it reaches RenderPixelatedPass too: the
  // nearest texel and nearest mip preserve chunky grain instead of bilinear
  // stone blur while the deterministic UV motion remains continuous.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function createShapeGeometry(points: ReadonlyArray<readonly [number, number]>): THREE.ShapeGeometry {
  const firstPoint = points[0];

  if (!firstPoint) {
    return new THREE.ShapeGeometry();
  }

  const shape = new THREE.Shape();
  shape.moveTo(firstPoint[0], firstPoint[1]);

  for (const point of points.slice(1)) {
    shape.lineTo(point[0], point[1]);
  }

  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return target.closest("input, textarea, select, [contenteditable='true']") !== null;
}

export function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export class JetcreeperGame {
  private readonly host: HTMLElement;
  private readonly onSnapshot: (snapshot: GameSnapshot) => void;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-10, 10, 16, -16, 0.1, 100);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly pixelPass: RenderPixelatedPass;
  private readonly outputPass: OutputPass;
  private readonly assets: Assets;
  private readonly enemyKindMaterials: Record<EnemyKind, {
    readonly hull: THREE.MeshStandardMaterial;
    readonly accent: THREE.MeshBasicMaterial;
  }>;
  private readonly gameplayRandom: () => number;
  private readonly visualRandom: () => number;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly backgroundGroup = new THREE.Group();
  private readonly caveRockTexture: THREE.DataTexture;
  private readonly player: THREE.Group;
  private readonly playerShield: PlayerShieldVisual;
  private readonly dashTrail: DashTrailVisual;
  private readonly playerLaser: THREE.Group;
  private readonly counterflareVisual: AbilityFieldVisual;
  private readonly gravityKnotVisual: AbilityFieldVisual;
  private readonly phoenixWings: PhoenixWingVisual[];
  private readonly remoteBombVisual: RemoteBombVisual;
  private readonly guardianWingmen: GuardianWingVisual[];
  private readonly pilotLine: PilotLine;
  private readonly caveLayers: CaveLayerVisual[];
  private readonly boss: Boss;
  private readonly stars: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly starData: Star[] = [];
  private readonly starTransform = new THREE.Object3D();
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion: boolean;
  private readonly superBrain = new SuperBrainController();
  private readonly emergencySuperBrain = new SuperBrainController();
  private readonly pressedKeys = new Set<string>();
  private readonly playerProjectiles: Projectile[] = [];
  private readonly playerProjectilePool: Projectile[] = [];
  private readonly playerMissilePool: Projectile[] = [];
  private readonly enemyProjectiles: Projectile[] = [];
  private readonly enemyProjectilePool: Projectile[] = [];
  private readonly enemyRocketPool: Projectile[] = [];
  private readonly enemies: Enemy[] = [];
  private readonly enemyPools = Object.fromEntries(
    ENEMY_KINDS.map((kind) => [kind, [] as Enemy[]]),
  ) as Record<EnemyKind, Enemy[]>;
  private readonly bonuses: Bonus[] = [];
  private readonly bonusPools = Object.fromEntries(
    BONUS_KINDS.map((kind) => [kind, [] as Bonus[]]),
  ) as Record<BonusKind, Bonus[]>;
  private readonly impacts: Impact[] = [];
  private readonly impactPool: Impact[] = [];
  private appliedRenderPixelRatio: number;
  private backgroundVisualsDirty = true;
  private status: GameStatus = "ready";
  private nextDifficultyLevel: RunDifficultyLevel = DEFAULT_RUN_DIFFICULTY;
  private activeDifficultyLevel: RunDifficultyLevel = DEFAULT_RUN_DIFFICULTY;
  private animationFrame: number | null = null;
  private lastFrameTimestamp = 0;
  private simulationAccumulator = 0;
  private snapshotElapsed = 0;
  private runElapsed = 0;
  private worldElapsed = 0;
  private score = 0;
  private pilotStyleScore = 0;
  private pilotSync = 0;
  private pilotLineCooldown = 6.5;
  private recentHumanInputSeconds = 0;
  private bestScore = 0;
  private lives = 3;
  private sector = 1;
  private difficulty: Difficulty = difficultyForSector(1);
  private playerX = 0;
  private previousPlayerX = 0;
  private previousPlayerY = PLAYER_START_Y;
  private playerIntentX = 0;
  private playerIntentY = 0;
  private playerVelocityX = 0;
  private playerVelocityY = 0;
  private flightMotion: FlightMotionState = { ...RESTING_FLIGHT_MOTION };
  private brainDecisionCooldown = 0;
  private brainSurvivalSeconds = DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds;
  private brainClearance = Number.POSITIVE_INFINITY;
  private autoPilotEnabled = true;
  private emergencyAssistState: EmergencyAssistState = { ...INITIAL_EMERGENCY_ASSIST_STATE };
  private brainMode: BrainTacticalMode = "Cruising";
  private playerFireCooldown = 0;
  private playerShotSide = -1;
  private nextEnemyId = 1;
  private nextBonusId = 1;
  private spawnCooldown = 0.8;
  private bonusCooldown = 5.8;
  private bossPending = false;
  private bossSpawnDelay = 0;
  private lastBossSector = 0;
  private encounterCadence: EncounterCadenceState = createEncounterCadence();
  private normalWaveSpawnRemaining = 0;
  private normalWaveIntermissionRemaining = 0;
  private bossEscortProgress: BossEscortProgress = createBossEscortProgress();
  private readonly pendingBossEscorts: PendingBossEscort[] = [];
  private rapidFireRemaining = 0;
  private spreadRemaining = 0;
  private plasmaRemaining = 0;
  private beamRemaining = 0;
  private droneRemaining = 0;
  private overdriveRemaining = 0;
  private stasisRemaining = 0;
  private readonly advancedAttachmentRemaining = Object.fromEntries(
    ADVANCED_ATTACHMENT_KINDS.map((kind) => [kind, 0]),
  ) as Record<AdvancedAttachmentKind, number>;
  private nanorepairKillsRemaining = 0;
  private nanorepairCharge = 0;
  private bonusBag: BonusKind[] = [];
  private abilityCoreCollected: Record<JetAbilityKind, boolean> = {
    counterflare: false,
    "gravity-knot": false,
    "phoenix-squadron": false,
  };
  private nextAbilityCoreDuplicateAt = 105;
  private dashRemaining = 0;
  private dashEffectRemaining = 0;
  private dashCooldownRemaining = 0;
  private dashDirectionX = 0;
  private dashDirectionY = 1;
  private dashRollProgress = 1;
  private dashRollDirection = 1;
  private burstRemaining = 0;
  private syncStrikeRemaining = 0;
  private lowProfileRemaining = 0;
  private lowProfileTimeWarpRemaining = 0;
  private lowProfileCooldownRemaining = 0;
  private lowProfileBossLaserHitAvailable = false;
  private lowProfileBossDamagePending = 0;
  private missileCooldownRemaining = 0;
  private remoteBombActive = false;
  private remoteBombAge = 0;
  private remoteBombTargetY = 0;
  private remoteBombCooldownRemaining = 0;
  private guardianWingRemaining = 0;
  private guardianWingCooldownRemaining = 0;
  private laserDamageCooldown = 0;
  private manualDashRequested = false;
  private manualLowProfileRequested = false;
  private manualMissilesRequested = false;
  private manualCounterflareRequested = false;
  private manualGravityKnotRequested = false;
  private manualPhoenixSquadronRequested = false;
  private abilityStates: JetAbilityStates = createLockedJetAbilityStates();
  private counterflareConversionsRemaining = 0;
  private gravityKnotX = 0;
  private gravityKnotY = 0;
  private phoenixStrikeCooldown = 0;
  private phoenixStrikeIndex = 0;
  private invulnerabilityRemaining = 0;
  private shielded = false;
  private sectorAnnouncementRemaining = 0;
  private announcement = "Flight controls armed";
  private previousCaveTravel = 0;
  private caveTravel = 0;
  private caveDifficultySector = 1;
  private caveContactLatched = false;
  private screenShakeRemaining = 0;
  private disposed = false;

  public constructor(options: JetcreeperGameOptions) {
    if (!supportsWebGL()) {
      throw new Error("WebGL is unavailable in this browser.");
    }

    this.host = options.host;
    this.onSnapshot = options.onSnapshot;
    const randomSeed = options.randomSeed ?? (Date.now() ^ Math.floor(performance.now() * 1000));
    this.gameplayRandom = createSeededRandom(randomSeed);
    this.visualRandom = createSeededRandom(randomSeed ^ 0x9e3779b9);
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    const pixelRatio = this.renderPixelRatio();
    this.appliedRenderPixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setClearColor(WORLD_CLEAR_COLOR, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.domElement.className = "jetastn-canvas";
    this.renderer.domElement.setAttribute("aria-label", "Live Jetfreeper combat field");
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost, false);
    this.host.append(this.renderer.domElement);

    const postTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    postTarget.texture.generateMipmaps = false;
    postTarget.texture.name = "Jetcreeper.pixel-art";
    this.composer = new EffectComposer(this.renderer, postTarget);
    this.composer.setPixelRatio(1);
    this.pixelPass = new RenderPixelatedPass(
      1,
      this.scene,
      this.camera,
      {
        normalEdgeStrength: 0.35,
        depthEdgeStrength: 0.45,
      },
    );
    this.outputPass = new OutputPass();
    this.composer.addPass(this.pixelPass);
    this.composer.addPass(this.outputPass);

    this.assets = this.createAssets();
    this.enemyKindMaterials = this.createEnemyKindMaterials();
    this.camera.position.set(0, 0, 20);
    this.player = this.createPlayer();
    this.playerShield = this.player.userData.shield as PlayerShieldVisual;
    this.updatePlayerModeVisuals();
    this.pilotLine = this.createPilotLine();
    this.dashTrail = this.createDashTrail();
    this.playerLaser = this.createPlayerLaser();
    this.counterflareVisual = this.createAbilityFieldVisual("counterflare");
    this.gravityKnotVisual = this.createAbilityFieldVisual("gravity-knot");
    this.phoenixWings = this.createPhoenixWings();
    this.remoteBombVisual = this.createRemoteBombVisual();
    this.guardianWingmen = this.createGuardianWingmen();
    this.boss = this.createBoss();
    this.stars = this.createStarfield();
    this.caveRockTexture = createCaveRockTexture();
    this.caveLayers = this.createCaveLayers();
    this.backgroundGroup.name = "Jetcreeper.background";
    this.backgroundGroup.add(
      this.stars,
      ...this.caveLayers.flatMap((layer) => [layer.leftMesh, layer.rightMesh]),
    );
    const hemisphereLight = new THREE.HemisphereLight(ARCADE_PALETTE.ivory, ARCADE_PALETTE.deepPlum, 1.65);
    const keyLight = new THREE.DirectionalLight(ARCADE_PALETTE.playerYellow, 2.85);
    keyLight.position.set(-5, 7, 12);
    this.scene.add(
      hemisphereLight,
      keyLight,
      this.backgroundGroup,
      this.playerLaser,
      this.counterflareVisual.group,
      this.gravityKnotVisual.group,
      ...this.phoenixWings.map((wing) => wing.group),
      this.remoteBombVisual.group,
      ...this.guardianWingmen.map((wing) => wing.group),
      ...this.pilotLine.nodes.map((node) => node.mesh),
      this.dashTrail.mesh,
      this.player,
    );

    this.bestScore = this.loadBestScore();
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(this.host);
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.clearPressedKeys);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.host.addEventListener("pointerdown", this.focusHost);
    this.resize();
    this.publishSnapshot(true);
    this.renderOnce();
  }

  public setNextDifficulty(level: RunDifficultyLevel): void {
    if (
      this.disposed
      || (this.status !== "ready" && this.status !== "game-over")
    ) {
      return;
    }

    this.nextDifficultyLevel = level;
    this.publishSnapshot(true);
  }

  public start(level: RunDifficultyLevel = this.nextDifficultyLevel): void {
    if (this.status === "unsupported" || this.disposed) {
      return;
    }

    if (this.status === "paused") {
      this.resume();
      return;
    }

    if (this.status === "running") {
      return;
    }

    this.nextDifficultyLevel = level;
    this.activeDifficultyLevel = level;
    this.resetRun();
    this.status = "running";
    this.announcement = `${runDifficultyProfile(level).label} · Sector 1 engaged`;
    this.sectorAnnouncementRemaining = 1.3;
    this.focusHost();
    this.publishSnapshot(true);
    this.startLoop();
  }

  public restart(): void {
    this.start(this.nextDifficultyLevel);
  }

  public returnToReady(): void {
    if (
      (this.status !== "paused" && this.status !== "game-over")
      || this.disposed
    ) {
      return;
    }

    this.stopLoop();
    this.clearPressedKeys();
    this.resetRun();
    this.status = "ready";
    this.announcement = "Choose difficulty";
    this.sectorAnnouncementRemaining = 0;
    this.publishSnapshot(true);
    this.renderOnce();
    this.focusHost();
  }

  public togglePause(): void {
    if (this.status === "running") {
      this.pause();
    } else if (this.status === "paused") {
      this.resume();
    }
  }

  public requestDash(): void {
    if (this.status === "running") {
      if (this.dashCooldownRemaining > 0 || this.dashRemaining > 0) {
        this.announcement = `Dash recharging · ${this.dashCooldownRemaining.toFixed(1)}s`;
        this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.7);
        this.publishSnapshot(true);
        return;
      }

      this.manualDashRequested = true;
      this.brainDecisionCooldown = 0;
    }
  }

  public requestLowProfile(): void {
    if (this.status === "running") {
      if (this.lowProfileCooldownRemaining > 0 || this.lowProfileRemaining > 0) {
        this.announcement = `Sub-level recharging · ${this.lowProfileCooldownRemaining.toFixed(1)}s`;
        this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.7);
        this.publishSnapshot(true);
        return;
      }

      this.manualLowProfileRequested = true;
      this.brainDecisionCooldown = 0;
    }
  }

  public requestMissiles(): void {
    if (this.status === "running") {
      if (this.missileCooldownRemaining > 0) {
        this.announcement = `Missiles reloading · ${this.missileCooldownRemaining.toFixed(1)}s`;
        this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.7);
        this.publishSnapshot(true);
        return;
      }

      this.manualMissilesRequested = true;
      this.brainDecisionCooldown = 0;
    }
  }

  public requestRemoteBomb(): void {
    if (this.status !== "running") {
      return;
    }

    if (this.remoteBombActive) {
      this.detonateRemoteBomb("manual");
      return;
    }

    if (this.remoteBombCooldownRemaining > 0) {
      this.announcement = `Remote bomb rearming · ${this.remoteBombCooldownRemaining.toFixed(1)}s`;
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.7);
      this.publishSnapshot(true);
      return;
    }

    this.launchRemoteBomb();
  }

  public requestGuardianWing(): void {
    if (this.status !== "running") {
      return;
    }

    if (this.guardianWingRemaining > 0) {
      this.announcement = `Guardian Wing active · ${this.guardianWingRemaining.toFixed(1)}s`;
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.8);
      this.publishSnapshot(true);
      return;
    }

    if (this.guardianWingCooldownRemaining > 0) {
      this.announcement = `Guardian Wing recharging · ${this.guardianWingCooldownRemaining.toFixed(1)}s`;
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.8);
      this.publishSnapshot(true);
      return;
    }

    this.guardianWingRemaining = GUARDIAN_WING_ACTIVE_SECONDS;
    this.guardianWingCooldownRemaining = GUARDIAN_WING_COOLDOWN_SECONDS;
    for (const wing of this.guardianWingmen) {
      wing.countermeasureCooldown = Math.max(0, (wing.id - 1) * 0.12);
      wing.offensiveFireCooldown = initialGuardianWingFireCooldown(wing.id - 1);
      wing.logicalShotsAccumulated = wing.id === 1 ? 1 : 0;
      wing.pulseSeconds = 0;
      const target = this.guardianWingTarget(wing);
      wing.group.position.set(target.x, target.y, 2.2);
      wing.group.visible = true;
    }
    this.announcement = "Guardian Wing · rapid-fire escort formation";
    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 1.2);
    this.publishSnapshot(true);
  }

  public requestCounterflare(): void {
    this.requestSpecialAbility("counterflare");
  }

  public requestGravityKnot(): void {
    this.requestSpecialAbility("gravity-knot");
  }

  public requestPhoenixSquadron(): void {
    this.requestSpecialAbility("phoenix-squadron");
  }

  public requestAutoPilotToggle(): void {
    this.toggleAutoPilot();
  }

  public setMovementControl(
    direction: JetMovementDirection,
    pressed: boolean,
  ): void {
    if (this.disposed || (pressed && this.status !== "running")) {
      return;
    }

    this.setMovementCode(MOVEMENT_CONTROL_CODES[direction], pressed);
  }

  /** Shared dispatcher keeps keyboard shortcuts and pointer controls identical. */
  public requestFlightSystem(kind: JetFlightSystemKind): void {
    switch (kind) {
      case "dash":
        this.requestDash();
        return;
      case "low-profile":
        this.requestLowProfile();
        return;
      case "missiles":
        this.requestMissiles();
        return;
      case "counterflare":
        this.requestCounterflare();
        return;
      case "gravity-knot":
        this.requestGravityKnot();
        return;
      case "phoenix-squadron":
        this.requestPhoenixSquadron();
        return;
      case "remote-bomb":
        this.requestRemoteBomb();
        return;
      case "guardian-wing":
        this.requestGuardianWing();
    }
  }

  private requestSpecialAbility(kind: JetAbilityKind): void {
    if (this.status !== "running") {
      return;
    }

    const state = this.abilityStates[kind];
    const spec = JET_ABILITY_SPECS[kind];

    if (!state.unlocked) {
      this.announcement = `${spec.label} locked · collect its crate`;
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.9);
      this.publishSnapshot(true);
      return;
    }

    if (state.activeSeconds > 0) {
      this.announcement = `${spec.label} active · ${state.activeSeconds.toFixed(1)}s`;
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.7);
      this.publishSnapshot(true);
      return;
    }

    if (state.cooldownSeconds > 0) {
      this.announcement = `${spec.label} recharging · ${state.cooldownSeconds.toFixed(1)}s`;
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.8);
      this.publishSnapshot(true);
      return;
    }

    if (kind === "counterflare") {
      this.manualCounterflareRequested = true;
    } else if (kind === "gravity-knot") {
      this.manualGravityKnotRequested = true;
    } else {
      this.manualPhoenixSquadronRequested = true;
    }
    this.brainDecisionCooldown = 0;
  }

  private toggleAutoPilot(): void {
    if (this.status !== "running") {
      return;
    }

    this.autoPilotEnabled = !this.autoPilotEnabled;
    this.emergencyAssistState = { ...INITIAL_EMERGENCY_ASSIST_STATE };
    this.brainDecisionCooldown = 0;
    this.superBrain.reset();
    this.emergencySuperBrain.reset();

    if (this.autoPilotEnabled) {
      this.playerIntentX = 0;
      this.playerIntentY = 0;
      this.pilotLineCooldown = PILOT_LINE_AUTO_RESUME_COOLDOWN_SECONDS;
      this.brainMode = "Cruising";
      this.announcement = "Super Brain online";
    } else {
      this.suspendPilotLineForManualFlight();
      this.updateManualFlightControl();
      this.brainMode = "Manual control";
      this.announcement = "Manual flight · auto cannon online";
    }

    this.updatePlayerModeVisuals();
    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 1.1);
    this.publishSnapshot(true);
  }

  private clearManualAbilityRequests(): void {
    this.manualDashRequested = false;
    this.manualLowProfileRequested = false;
    this.manualMissilesRequested = false;
    this.manualCounterflareRequested = false;
    this.manualGravityKnotRequested = false;
    this.manualPhoenixSquadronRequested = false;
  }

  private applyEmergencyAssistTransition(
    transition: EmergencyAssistTransition,
  ): void {
    const visualModeChanged = this.emergencyAssistState.active !== transition.state.active;
    this.emergencyAssistState = transition.state;
    if (visualModeChanged) this.updatePlayerModeVisuals();

    if (transition.event === "started") {
      this.brainMode = "Emergency evade";
      this.announcement = "Emergency assist · taking controls";
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 1.05);
      this.brainDecisionCooldown = 0;
      this.publishSnapshot(true);
    } else if (transition.event === "released-safe") {
      this.brainMode = "Manual control";
      this.announcement = "Manual control restored";
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.9);
      this.emergencySuperBrain.reset();
      this.publishSnapshot(true);
    } else if (transition.event === "released-timeout") {
      this.brainMode = "Manual control";
      this.announcement = "Emergency assist limit · manual restored";
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 1.05);
      this.emergencySuperBrain.reset();
      this.publishSnapshot(true);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.stopLoop();
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.clearPressedKeys);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.host.removeEventListener("pointerdown", this.focusHost);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.scene.clear();

    for (const geometry of this.geometries) {
      geometry.dispose();
    }

    for (const material of this.materials) {
      material.dispose();
    }

    this.caveRockTexture.dispose();
    this.pixelPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly frame = (timestamp: number): void => {
    if (this.disposed || this.status !== "running") {
      return;
    }

    const elapsedWallSeconds = Math.max(0, (timestamp - this.lastFrameTimestamp) / 1000);
    const deltaSeconds = clampNumber(elapsedWallSeconds, 0, 0.14);
    this.lastFrameTimestamp = timestamp;

    this.simulationAccumulator += deltaSeconds;
    let simulationSteps = 0;

    while (
      this.simulationAccumulator >= FIXED_STEP_SECONDS &&
      simulationSteps < MAX_SIMULATION_STEPS_PER_FRAME &&
      this.status === "running"
    ) {
      this.update(FIXED_STEP_SECONDS);
      this.simulationAccumulator -= FIXED_STEP_SECONDS;
      simulationSteps += 1;
    }

    if (simulationSteps >= MAX_SIMULATION_STEPS_PER_FRAME) {
      this.simulationAccumulator = 0;
    }

    this.renderOnce();

    if (this.status === "running") {
      this.animationFrame = requestAnimationFrame(this.frame);
    }
  };

  private readonly resize = (): void => {
    if (this.disposed) {
      return;
    }

    const bounds = this.host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    const aspect = width / height;
    const halfHeight = WORLD_HEIGHT / 2;
    const halfWidth = halfHeight * aspect;

    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
    const pixelRatio = this.renderPixelRatio();

    if (pixelRatio !== this.appliedRenderPixelRatio) {
      this.appliedRenderPixelRatio = pixelRatio;
      this.renderer.setPixelRatio(pixelRatio);
    }

    this.renderer.setSize(width, height, false);
    this.composer.setSize(
      Math.max(1, Math.ceil(width / PIXEL_BLOCK_CSS_PIXELS)),
      Math.max(1, Math.ceil(height / PIXEL_BLOCK_CSS_PIXELS)),
    );
    this.renderOnce();
  };

  private renderPixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (isTextInputTarget(event.target)) {
      return;
    }

    const movementCodes = new Set([
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
    ]);

    if (movementCodes.has(event.code)) {
      this.setMovementCode(event.code, true);
      event.preventDefault();
      return;
    }

    if (this.status === "running" && !event.repeat) {
      if (event.code === "KeyQ") {
        if (event.ctrlKey || event.metaKey || event.altKey) {
          return;
        }

        event.preventDefault();
        this.toggleAutoPilot();
        return;
      }

      const flightSystem = jetFlightSystemForKeyboardCode(event.code);

      if (flightSystem !== null) {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
          return;
        }

        event.preventDefault();

        this.requestFlightSystem(flightSystem);
        return;
      }
    }

    if (
      event.code === "Enter"
      && (this.status === "ready" || this.status === "game-over")
    ) {
      event.preventDefault();
      this.start();
      return;
    }

    if (event.code === "KeyP" || event.code === "Escape") {
      event.preventDefault();
      this.togglePause();
    }
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.setMovementCode(event.code, false);
  };

  private setMovementCode(code: string, pressed: boolean): void {
    if (pressed) {
      this.pressedKeys.add(code);
      this.recentHumanInputSeconds = PILOT_LINE_INPUT_GRACE_SECONDS;
      this.brainDecisionCooldown = 0;
      return;
    }

    if (this.pressedKeys.delete(code)) {
      this.brainDecisionCooldown = 0;
    }
  }

  private readonly clearPressedKeys = (): void => {
    this.pressedKeys.clear();
    this.recentHumanInputSeconds = 0;
    this.brainDecisionCooldown = 0;
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden" && this.status === "running") {
      this.pause();
    }
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.status = "unsupported";
    this.announcement = "The GPU context was lost. Reload this tile to fly again.";
    this.stopLoop();
    this.publishSnapshot(true);
  };

  private readonly focusHost = (event?: Event): void => {
    if (
      event?.target instanceof Element
      && event.target.closest("button, a, input, select, textarea, [role='button']") !== null
    ) {
      return;
    }

    this.host.focus({ preventScroll: true });
  };

  private createAssets(): Assets {
    const star = this.trackGeometry(new THREE.PlaneGeometry(0.035, 0.18));
    const playerHull = this.trackGeometry(createShapeGeometry([
      [-0.16, -1.2], [-0.39, -0.58], [-0.34, 0.4], [0, 1.42],
      [0.34, 0.4], [0.39, -0.58], [0.16, -1.2],
    ]));
    const playerWing = this.trackGeometry(createShapeGeometry([
      [-0.25, 0.23], [-1.08, -0.4], [-1.18, -0.82], [-0.42, -0.62],
      [0, -1], [0.42, -0.62], [1.18, -0.82], [1.08, -0.4], [0.25, 0.23],
    ]));
    const playerCockpit = this.trackGeometry(new THREE.SphereGeometry(0.3, 16, 10));
    const engineGlow = this.trackGeometry(new THREE.CircleGeometry(0.25, 14));
    const gunPod = this.trackGeometry(new THREE.BoxGeometry(0.16, 0.68, 0.15));
    const playerShieldSphere = this.trackGeometry(new THREE.SphereGeometry(1.48, 24, 16));
    const shield = this.trackGeometry(new THREE.RingGeometry(0.95, 1.04, 36));
    const fighterHull = this.trackGeometry(createShapeGeometry([
      [-0.14, -0.9], [-0.34, -0.35], [-0.27, 0.32], [0, 1.12],
      [0.27, 0.32], [0.34, -0.35], [0.14, -0.9],
    ]));
    const fighterWing = this.trackGeometry(createShapeGeometry([
      [-0.2, 0.2], [-0.92, -0.18], [-1.02, -0.62], [-0.36, -0.48],
      [0, -0.82], [0.36, -0.48], [1.02, -0.62], [0.92, -0.18], [0.2, 0.2],
    ]));
    const bossHull = this.trackGeometry(createShapeGeometry([
      [-0.42, 1.45], [-0.82, 0.62], [-0.7, -0.88], [0, -1.92],
      [0.7, -0.88], [0.82, 0.62], [0.42, 1.45],
    ]));
    const bossWing = this.trackGeometry(createShapeGeometry([
      [-0.55, 0.82], [-2.35, 0.55], [-3.05, -0.38], [-2.72, -0.82],
      [-1.1, -0.46], [0, -1.18], [1.1, -0.46], [2.72, -0.82],
      [3.05, -0.38], [2.35, 0.55], [0.55, 0.82],
    ]));
    const bossCannon = this.trackGeometry(new THREE.BoxGeometry(0.3, 1.18, 0.24));
    const bossCore = this.trackGeometry(new THREE.TorusGeometry(0.46, 0.1, 8, 20));
    const turretBase = this.trackGeometry(new THREE.CylinderGeometry(0.68, 0.78, 0.28, 10));
    const turretRing = this.trackGeometry(new THREE.TorusGeometry(0.51, 0.09, 6, 12));
    const turretBarrel = this.trackGeometry(new THREE.BoxGeometry(0.22, 0.82, 0.2));
    const turretMuzzle = this.trackGeometry(new THREE.CircleGeometry(0.14, 12));
    const asteroid = this.trackGeometry(new THREE.IcosahedronGeometry(0.76, 1));
    const asteroidEdges = this.trackGeometry(new THREE.EdgesGeometry(asteroid, 28));
    const bonusBox = this.trackGeometry(new THREE.BoxGeometry(0.82, 0.82, 0.34));
    const bonusFrame = this.trackGeometry(new THREE.EdgesGeometry(bonusBox, 20));
    const bonusCore = this.trackGeometry(new THREE.CircleGeometry(0.13, 12));
    const bonusShield = this.trackGeometry(new THREE.RingGeometry(0.16, 0.23, 16));
    const bonusRapid = this.trackGeometry(createShapeGeometry([
      [-0.07, 0.28], [0.23, 0.28], [0.04, 0.02], [0.2, 0.02],
      [-0.2, -0.34], [-0.05, -0.08], [-0.23, -0.08],
    ]));
    const bonusPulse = this.trackGeometry(createShapeGeometry([
      [-0.08, 0.28], [0.08, 0.28], [0.08, 0.08], [0.28, 0.08],
      [0.28, -0.08], [0.08, -0.08], [0.08, -0.28], [-0.08, -0.28],
      [-0.08, -0.08], [-0.28, -0.08], [-0.28, 0.08], [-0.08, 0.08],
    ]));
    const playerProjectile = this.trackGeometry(new THREE.SphereGeometry(0.13, 10, 8));
    const playerProjectileGlow = this.trackGeometry(createShapeGeometry([
      [-0.14, 0.12], [0, 0.24], [0.14, 0.12], [0.08, -0.24],
      [0, -0.52], [-0.08, -0.24],
    ]));
    const playerMissile = this.trackGeometry(createShapeGeometry([
      [-0.12, -0.38], [-0.2, -0.22], [-0.12, 0.24], [0, 0.52],
      [0.12, 0.24], [0.2, -0.22], [0.12, -0.38],
    ]));
    const playerMissileFins = this.trackGeometry(new THREE.BoxGeometry(0.5, 0.12, 0.08));
    const playerMissileFlame = this.trackGeometry(createShapeGeometry([
      [-0.1, 0.02], [0, -0.4], [0.1, 0.02],
    ]));
    const playerMissileGlow = this.trackGeometry(new THREE.PlaneGeometry(0.48, 1.08));
    const playerLaserCore = this.trackGeometry(new THREE.PlaneGeometry(0.1, 1));
    const playerLaserGlow = this.trackGeometry(new THREE.PlaneGeometry(0.52, 1));
    const enemyProjectile = this.trackGeometry(new THREE.SphereGeometry(0.16, 10, 8));
    const enemyProjectileGlow = this.trackGeometry(createShapeGeometry([
      [-0.17, 0.14], [0, 0.28], [0.17, 0.14], [0.1, -0.28],
      [0, -0.6], [-0.1, -0.28],
    ]));
    const enemyRocket = this.trackGeometry(createShapeGeometry([
      [-0.12, -0.34], [-0.2, -0.45], [-0.14, 0.16], [0, 0.48],
      [0.14, 0.16], [0.2, -0.45], [0.12, -0.34],
    ]));
    const enemyRocketFins = this.trackGeometry(new THREE.BoxGeometry(0.46, 0.12, 0.08));
    const enemyRocketFlame = this.trackGeometry(createShapeGeometry([
      [-0.11, 0.02], [0, -0.38], [0.11, 0.02],
    ]));
    const enemyRocketGlow = this.trackGeometry(new THREE.PlaneGeometry(0.42, 0.92));
    const impact = this.trackGeometry(new THREE.RingGeometry(0.15, 0.31, 18));
    const impactShard = this.trackGeometry(new THREE.BoxGeometry(0.07, 0.28, 0.05));
    const starMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
    }));
    const playerMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: SHIP_VISUAL_PROFILES.manual.hullColor,
      emissive: SHIP_VISUAL_PROFILES.manual.hullEmissive,
      emissiveIntensity: 1.08,
      metalness: 0.76,
      roughness: 0.2,
      side: THREE.DoubleSide,
    }));
    const playerWingMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: SHIP_VISUAL_PROFILES.manual.wingColor,
      emissive: SHIP_VISUAL_PROFILES.manual.wingEmissive,
      emissiveIntensity: 0.94,
      metalness: 0.7,
      roughness: 0.3,
      side: THREE.DoubleSide,
    }));
    const playerAccentMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.aiCyan,
      side: THREE.DoubleSide,
    }));
    const playerCockpitMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: SHIP_VISUAL_PROFILES.manual.cockpitColor,
      emissive: SHIP_VISUAL_PROFILES.manual.cockpitEmissive,
      emissiveIntensity: 0.86,
      metalness: 0.84,
      roughness: 0.1,
    }));
    const engineMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: SHIP_VISUAL_PROFILES.manual.engineOuterColor,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const engineCoreMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: SHIP_VISUAL_PROFILES.manual.engineCoreColor,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const playerShieldGlassMaterial = this.trackMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xb9f5ff,
      emissive: 0x08384d,
      emissiveIntensity: 0.12,
      metalness: 0,
      roughness: 0.1,
      transparent: true,
      opacity: 0.075,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      iridescence: 0.48,
      iridescenceIOR: 1.28,
      iridescenceThicknessRange: [80, 230],
      specularIntensity: 0.86,
      specularColor: ARCADE_PALETTE.shieldAzure,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    }));
    const playerShieldEnergyMaterial = this.trackMaterial(new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 1 },
        uColor: { value: new THREE.Color(ARCADE_PALETTE.shieldAzure) },
        uAccent: { value: new THREE.Color(ARCADE_PALETTE.aiCyan) },
      },
      vertexShader: /* glsl */`
        uniform float uTime;
        varying vec3 vLocalPosition;
        varying vec3 vViewNormal;
        varying vec3 vViewDirection;

        void main() {
          float warp = sin(position.y * 8.0 - uTime * 1.7) * 0.018
            + sin((position.x + position.z) * 11.0 + uTime * 1.15) * 0.008;
          vec3 warpedPosition = position + normal * warp;
          vec4 viewPosition = modelViewMatrix * vec4(warpedPosition, 1.0);
          vLocalPosition = position;
          vViewNormal = normalize(normalMatrix * normal);
          vViewDirection = normalize(-viewPosition.xyz);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uColor;
        uniform vec3 uAccent;
        varying vec3 vLocalPosition;
        varying vec3 vViewNormal;
        varying vec3 vViewDirection;

        void main() {
          float facing = abs(dot(normalize(vViewNormal), normalize(vViewDirection)));
          float fresnel = pow(1.0 - clamp(facing, 0.0, 1.0), 2.35);
          float ripple = sin(
            vLocalPosition.y * 11.0
            - uTime * 2.4
            + sin(vLocalPosition.x * 7.0 + uTime * 1.3) * 0.9
          ) * 0.5 + 0.5;
          float crossWave = sin(
            (vLocalPosition.x + vLocalPosition.z) * 10.0 + uTime * 1.7
          ) * 0.5 + 0.5;
          float caustic = smoothstep(0.78, 1.0, ripple * crossWave);
          float chroma = 0.35 + sin(uTime * 0.8 + vLocalPosition.y * 2.7) * 0.18;
          vec3 energyColor = mix(uColor, uAccent, chroma);
          float alpha = (0.018 + fresnel * 0.48 + caustic * (0.04 + fresnel * 0.09)) * uOpacity;
          gl_FragColor = vec4(
            energyColor * (0.68 + fresnel * 1.72 + caustic * 0.55),
            alpha
          );
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    }));
    const fighterMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xc43a2f,
      emissive: 0x5b1713,
      emissiveIntensity: 0.8,
      metalness: 0.6,
      roughness: 0.3,
    }));
    const fighterWingMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x71241f,
      emissive: 0x32100d,
      emissiveIntensity: 0.65,
      metalness: 0.55,
      roughness: 0.4,
    }));
    const fighterAccentMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({ color: ENEMY_FIRE_ORANGE }));
    const enemyEngineMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ENEMY_FIRE_ORANGE,
      transparent: true,
      opacity: 0.78,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const turretMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x9e2f22,
      emissive: 0x42120d,
      emissiveIntensity: 0.65,
      metalness: 0.78,
      roughness: 0.32,
    }));
    const turretBarrelMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x5b1813,
      emissive: 0x250907,
      emissiveIntensity: 0.4,
      metalness: 0.72,
      roughness: 0.4,
    }));
    const asteroidMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x6b3026,
      emissive: 0x2b100c,
      emissiveIntensity: 0.32,
      flatShading: true,
      metalness: 0.18,
      roughness: 0.9,
    }));
    const asteroidEdgeMaterial = this.trackMaterial(new THREE.LineBasicMaterial({
      color: 0xdf6940,
      transparent: true,
      opacity: 0.3,
    }));
    const playerProjectileMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({ color: PLAYER_FIRE_CORE }));
    const playerProjectileGlowMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: PLAYER_FIRE_CYAN,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const playerMissileMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: PLAYER_MISSILE_BODY,
      emissive: PLAYER_MISSILE_EMISSIVE,
      emissiveIntensity: 1,
      metalness: 0.68,
      roughness: 0.24,
    }));
    const playerMissileAccentMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({ color: PLAYER_FIRE_CYAN }));
    const playerMissileGlowMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: PLAYER_FIRE_CYAN,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const playerLaserMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: PLAYER_LASER_CORE,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const playerLaserGlowMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: PLAYER_FIRE_CYAN,
      transparent: true,
      opacity: 0.44,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const enemyProjectileMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: ENEMY_FIRE_CORE,
      emissive: ENEMY_FIRE_RED,
      emissiveIntensity: 1.15,
      metalness: 0.38,
      roughness: 0.22,
      flatShading: true,
    }));
    const enemyProjectileGlowMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0xff3d2f,
      transparent: true,
      opacity: 0.58,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const enemyRocketMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xb72b22,
      emissive: 0x5b0d09,
      emissiveIntensity: 0.9,
      metalness: 0.62,
      roughness: 0.28,
    }));
    const enemyRocketAccentMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({ color: ENEMY_FIRE_ORANGE }));
    const enemyRocketGlowMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ENEMY_FIRE_ORANGE,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const bonusMaterials = Object.fromEntries(BONUS_KINDS.map((kind) => {
      const [baseColor] = BONUS_COLORS[kind];
      const color = new THREE.Color(baseColor);
      return [kind, this.trackMaterial(new THREE.MeshStandardMaterial({
        color,
        emissive: color.clone().multiplyScalar(0.42),
        emissiveIntensity: 0.85,
        metalness: 0.65,
        roughness: 0.3,
      }))];
    })) as Record<BonusKind, THREE.MeshStandardMaterial>;
    const bonusFrameMaterials = Object.fromEntries(BONUS_KINDS.map((kind) => [
      kind,
      this.trackMaterial(new THREE.LineBasicMaterial({ color: BONUS_COLORS[kind][1] })),
    ])) as Record<BonusKind, THREE.LineBasicMaterial>;
    const bonusCoreMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.neutralSteel,
    }));

    return {
      star,
      playerHull,
      playerWing,
      playerCockpit,
      engineGlow,
      gunPod,
      playerShieldSphere,
      shield,
      fighterHull,
      fighterWing,
      bossHull,
      bossWing,
      bossCannon,
      bossCore,
      turretBase,
      turretRing,
      turretBarrel,
      turretMuzzle,
      asteroid,
      asteroidEdges,
      bonusBox,
      bonusFrame,
      bonusCore,
      bonusShield,
      bonusRapid,
      bonusPulse,
      playerProjectile,
      playerProjectileGlow,
      playerMissile,
      playerMissileFins,
      playerMissileFlame,
      playerMissileGlow,
      playerLaserCore,
      playerLaserGlow,
      enemyProjectile,
      enemyProjectileGlow,
      enemyRocket,
      enemyRocketFins,
      enemyRocketFlame,
      enemyRocketGlow,
      impact,
      impactShard,
      starMaterial,
      playerMaterial,
      playerWingMaterial,
      playerAccentMaterial,
      playerCockpitMaterial,
      engineMaterial,
      engineCoreMaterial,
      playerShieldGlassMaterial,
      playerShieldEnergyMaterial,
      fighterMaterial,
      fighterWingMaterial,
      fighterAccentMaterial,
      enemyEngineMaterial,
      turretMaterial,
      turretBarrelMaterial,
      asteroidMaterial,
      asteroidEdgeMaterial,
      playerProjectileMaterial,
      playerProjectileGlowMaterial,
      playerMissileMaterial,
      playerMissileAccentMaterial,
      playerMissileGlowMaterial,
      playerLaserMaterial,
      playerLaserGlowMaterial,
      enemyProjectileMaterial,
      enemyProjectileGlowMaterial,
      enemyRocketMaterial,
      enemyRocketAccentMaterial,
      enemyRocketGlowMaterial,
      bonusMaterials,
      bonusFrameMaterials,
      bonusCoreMaterial,
    };
  }

  private createEnemyKindMaterials(): Record<EnemyKind, {
    readonly hull: THREE.MeshStandardMaterial;
    readonly accent: THREE.MeshBasicMaterial;
  }> {
    const colors: Readonly<Record<EnemyKind, readonly [number, number]>> = {
      fighter: [0xc43a2f, 0xff8a3d],
      turret: [0x9e2f22, 0xffad45],
      asteroid: [0x6b3026, 0xdf6940],
      interceptor: [0xe24a32, 0xffb04a],
      bomber: [0x8f2b21, 0xff7a32],
      gunship: [0x71241f, 0xef5b37],
      sniper: [0xaa2930, 0xff9a4a],
      mine: [0x7d211c, 0xffc14d],
      carrier: [0x61221d, 0xe65e35],
      phantom: [0x943a31, 0xff8e62],
      corsair: [0xc64a20, 0xffd166],
      bulwark: [0x354b63, 0x8be9fd],
      shifter: [0x6a2c91, 0xe0aaff],
      leech: [0x511c3d, 0xff4d8d],
      splitter: [0xa14320, 0xffc857],
      warden: [0x263b5a, 0x76c7ff],
      rammer: [0x7a301f, 0xffef70],
      stalker: [0x25213f, 0x9b8cff],
      chronodrone: [0x35406f, 0x66f7ff],
      commander: [0x3f235f, 0xff68d7],
    };

    return Object.fromEntries(ENEMY_KINDS.map((kind) => {
      const [baseColor, accentColor] = colors[kind];
      const hull = this.trackMaterial(new THREE.MeshStandardMaterial({
        color: baseColor,
        emissive: new THREE.Color(baseColor).multiplyScalar(0.28),
        emissiveIntensity: 0.78,
        flatShading: kind === "asteroid" || kind === "mine",
        metalness: kind === "asteroid" ? 0.18 : 0.64,
        roughness: kind === "asteroid" ? 0.88 : 0.34,
      }));
      const translucentAccent = kind === "phantom"
        || kind === "shifter"
        || kind === "stalker"
        || kind === "chronodrone";
      const accent = this.trackMaterial(new THREE.MeshBasicMaterial({
        color: accentColor,
        transparent: translucentAccent,
        opacity: translucentAccent ? 0.78 : 1,
      }));
      return [kind, { hull, accent }];
    })) as Record<EnemyKind, {
      readonly hull: THREE.MeshStandardMaterial;
      readonly accent: THREE.MeshBasicMaterial;
    }>;
  }

  private createPlayer(): THREE.Group {
    const group = new THREE.Group();
    const flightRig = new THREE.Group();
    const manualModel = new THREE.Group();
    const autoModel = new THREE.Group();
    const emergencyOverlay = new THREE.Group();
    const wings = new THREE.Mesh(this.assets.playerWing, this.assets.playerWingMaterial);
    const wingAccent = new THREE.Mesh(this.assets.playerWing, this.assets.playerAccentMaterial);
    const body = new THREE.Mesh(this.assets.playerHull, this.assets.playerMaterial);
    const cockpit = new THREE.Mesh(this.assets.playerCockpit, this.assets.playerCockpitMaterial);
    const leftEngine = new THREE.Mesh(this.assets.gunPod, this.assets.playerWingMaterial);
    const rightEngine = new THREE.Mesh(this.assets.gunPod, this.assets.playerWingMaterial);
    const leftGun = new THREE.Mesh(this.assets.gunPod, this.assets.playerMaterial);
    const rightGun = new THREE.Mesh(this.assets.gunPod, this.assets.playerMaterial);
    const leftGlow = new THREE.Mesh(this.assets.engineGlow, this.assets.engineMaterial);
    const rightGlow = new THREE.Mesh(this.assets.engineGlow, this.assets.engineMaterial);
    const leftCore = new THREE.Mesh(this.assets.playerMissileFlame, this.assets.engineCoreMaterial);
    const rightCore = new THREE.Mesh(this.assets.playerMissileFlame, this.assets.engineCoreMaterial);
    const leftWingtip = new THREE.Mesh(this.assets.engineGlow, this.assets.playerAccentMaterial);
    const rightWingtip = new THREE.Mesh(this.assets.engineGlow, this.assets.engineCoreMaterial);
    const manualTrailMaterial = this.trackMaterial(new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uOpacity: { value: 0.86 },
        uTailColor: { value: new THREE.Color(SHIP_VISUAL_PROFILES.manual.engineOuterColor) },
        uCoreColor: { value: new THREE.Color(SHIP_VISUAL_PROFILES.manual.engineCoreColor) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform float uOpacity;
        uniform vec3 uTailColor;
        uniform vec3 uCoreColor;
        varying vec2 vUv;

        void main() {
          float center = max(0.0, 1.0 - abs(vUv.x - 0.5) * 2.0);
          float outer = pow(center, 1.8);
          float core = pow(center, 5.5);
          float tailFade = smoothstep(0.0, 0.3, vUv.y);
          float flow = 0.9 + sin(vUv.y * 31.0 - uTime * 19.0) * 0.1;
          float alpha = (outer * 0.66 + core * 0.52) * tailFade * flow * uOpacity;
          vec3 color = mix(uTailColor, uCoreColor, smoothstep(0.28, 0.94, vUv.y) + core * 0.22);
          if (alpha < 0.008) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const manualTrailGeometry = this.trackGeometry(new THREE.PlaneGeometry(0.54, 1.72));
    const manualTrails = [-0.31, 0.31].map((x) => {
      const trail = new THREE.Mesh(manualTrailGeometry, manualTrailMaterial);
      trail.position.set(x, -1.83, 0.28);
      trail.renderOrder = 1;
      return trail;
    });
    const stripeGeometry = this.trackGeometry(new THREE.PlaneGeometry(0.78, 0.17));
    const stripeMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.void,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const stripeEdgeMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.caveMauve,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const manualStripes = [
      { x: -0.23, y: 0.12, rotation: 0.33, scale: 0.68 },
      { x: 0.23, y: 0.12, rotation: -0.33, scale: 0.68 },
      { x: -0.74, y: -0.49, rotation: 0.56, scale: 0.86 },
      { x: 0.74, y: -0.49, rotation: -0.56, scale: 0.86 },
    ].map((specification, index) => {
      const stripe = new THREE.Mesh(
        stripeGeometry,
        index < 2 ? stripeMaterial : stripeEdgeMaterial,
      );
      stripe.position.set(specification.x, specification.y, 0.43);
      stripe.rotation.z = specification.rotation;
      stripe.scale.x = specification.scale;
      stripe.renderOrder = 3;
      return stripe;
    });

    const autoHullGeometry = this.trackGeometry(createShapeGeometry([
      [-0.12, -1.18], [-0.42, -0.56], [-0.28, 0.56], [0, 1.52],
      [0.28, 0.56], [0.42, -0.56], [0.12, -1.18],
    ]));
    const autoWingGeometry = this.trackGeometry(createShapeGeometry([
      [-0.16, 0.38], [-0.72, 0.02], [-1.16, -0.58], [-0.58, -0.94],
      [0, -0.67], [0.58, -0.94], [1.16, -0.58], [0.72, 0.02], [0.16, 0.38],
    ]));
    const autoCockpitGeometry = this.trackGeometry(new THREE.OctahedronGeometry(0.34, 0));
    const autoHullMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: SHIP_VISUAL_PROFILES.auto.hullColor,
      wireframe: true,
      transparent: true,
      opacity: 0.76,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const autoWingMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: SHIP_VISUAL_PROFILES.auto.wingColor,
      wireframe: true,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const autoCoreMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: SHIP_VISUAL_PROFILES.auto.hullColor,
      transparent: true,
      opacity: 0.06,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const autoAccentMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: SHIP_VISUAL_PROFILES.auto.accentColor,
      wireframe: true,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const autoEngineMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: SHIP_VISUAL_PROFILES.auto.engineOuterColor,
      transparent: true,
      opacity: 0.82,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const autoEngineCoreMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: SHIP_VISUAL_PROFILES.auto.engineCoreColor,
      transparent: true,
      opacity: 0.98,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const autoWings = new THREE.Mesh(autoWingGeometry, autoWingMaterial);
    const autoHullCore = new THREE.Mesh(autoHullGeometry, autoCoreMaterial);
    const autoBody = new THREE.Mesh(autoHullGeometry, autoHullMaterial);
    const autoCockpit = new THREE.Mesh(autoCockpitGeometry, autoAccentMaterial);
    const autoLeftEngine = new THREE.Mesh(this.assets.gunPod, autoWingMaterial);
    const autoRightEngine = new THREE.Mesh(this.assets.gunPod, autoWingMaterial);
    const autoLeftGun = new THREE.Mesh(this.assets.gunPod, autoAccentMaterial);
    const autoRightGun = new THREE.Mesh(this.assets.gunPod, autoAccentMaterial);
    const autoLeftGlow = new THREE.Mesh(this.assets.engineGlow, autoEngineMaterial);
    const autoRightGlow = new THREE.Mesh(this.assets.engineGlow, autoEngineMaterial);
    const autoLeftCore = new THREE.Mesh(this.assets.playerMissileFlame, autoEngineCoreMaterial);
    const autoRightCore = new THREE.Mesh(this.assets.playerMissileFlame, autoEngineCoreMaterial);
    const autoRailGeometry = this.trackGeometry(new THREE.BoxGeometry(0.12, 1.18, 0.1));
    const autoLeftRail = new THREE.Mesh(autoRailGeometry, autoAccentMaterial);
    const autoRightRail = new THREE.Mesh(autoRailGeometry, autoAccentMaterial);
    const autoCoreRings = [-0.52, 0.05, 0.6].map((y, index) => {
      const ring = new THREE.Mesh(this.assets.bossCore, index % 2 === 0 ? autoAccentMaterial : autoHullMaterial);
      ring.position.set(0, y, 0.62);
      ring.scale.setScalar(0.24 + index * 0.035);
      ring.renderOrder = 4;
      return ring;
    });

    const emergencyPrimaryMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.playerMagenta,
      wireframe: true,
      transparent: true,
      opacity: 0.38,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const emergencySecondaryMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.stasisViolet,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const emergencyCageHull = new THREE.Mesh(this.assets.playerHull, emergencyPrimaryMaterial);
    const emergencyCageWing = new THREE.Mesh(this.assets.playerWing, emergencySecondaryMaterial);
    const scannerGeometry = this.trackGeometry(new THREE.PlaneGeometry(1, 0.12));
    const emergencyScanners = Array.from({ length: 3 }, (_, index) => {
      const material = this.trackMaterial(new THREE.MeshBasicMaterial({
        color: index % 2 === 0 ? ARCADE_PALETTE.playerMagenta : ARCADE_PALETTE.stasisViolet,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }));
      const scanner = new THREE.Mesh(scannerGeometry, material);
      scanner.position.z = 0.72 + index * 0.002;
      scanner.renderOrder = 6;
      return scanner;
    });
    const shieldGroup = new THREE.Group();
    const shieldGlass = new THREE.Mesh(
      this.assets.playerShieldSphere,
      this.assets.playerShieldGlassMaterial,
    );
    const shieldEnergy = new THREE.Mesh(
      this.assets.playerShieldSphere,
      this.assets.playerShieldEnergyMaterial,
    );
    const shield: PlayerShieldVisual = {
      group: shieldGroup,
      glass: shieldGlass,
      energy: shieldEnergy,
    };
    const leftDrone = new THREE.Group();
    const rightDrone = new THREE.Group();

    for (const drone of [leftDrone, rightDrone]) {
      const droneBody = new THREE.Mesh(this.assets.playerCockpit, this.assets.playerMaterial);
      const droneRing = new THREE.Mesh(this.assets.bossCore, this.assets.playerAccentMaterial);
      const droneGun = new THREE.Mesh(this.assets.gunPod, this.assets.playerWingMaterial);
      droneBody.scale.set(0.58, 0.88, 0.45);
      droneRing.scale.setScalar(0.55);
      droneRing.position.z = 0.2;
      droneGun.position.set(0, 0.42, 0.1);
      droneGun.scale.set(0.68, 0.58, 0.8);
      drone.add(droneBody, droneRing, droneGun);
      drone.visible = false;
    }

    wings.position.set(0, -0.02, 0.18);
    wingAccent.position.set(0, -0.11, 0.22);
    wingAccent.scale.set(0.78, 0.38, 1);
    body.position.z = 0.3;
    cockpit.position.set(0, 0.31, 0.53);
    cockpit.scale.set(0.62, 1.2, 0.42);
    leftEngine.position.set(-0.31, -0.78, 0.34);
    rightEngine.position.set(0.31, -0.78, 0.34);
    leftGun.position.set(-0.76, -0.28, 0.31);
    rightGun.position.set(0.76, -0.28, 0.31);
    leftGun.scale.set(0.62, 0.7, 1);
    rightGun.scale.copy(leftGun.scale);
    leftGlow.position.set(-0.31, -1.12, 0.4);
    rightGlow.position.set(0.31, -1.12, 0.4);
    leftGlow.scale.set(0.42, 0.86, 1);
    rightGlow.scale.copy(leftGlow.scale);
    leftCore.position.set(-0.31, -1.03, 0.44);
    rightCore.position.set(0.31, -1.03, 0.44);
    leftCore.scale.set(0.92, 1.2, 1);
    rightCore.scale.copy(leftCore.scale);
    leftWingtip.position.set(-1.05, -0.61, 0.34);
    rightWingtip.position.set(1.05, -0.61, 0.34);
    leftWingtip.scale.setScalar(0.2);
    rightWingtip.scale.copy(leftWingtip.scale);

    autoWings.position.set(0, -0.05, 0.2);
    autoHullCore.position.z = 0.28;
    autoHullCore.scale.set(0.86, 0.9, 1);
    autoBody.position.z = 0.34;
    autoCockpit.position.set(0, 0.36, 0.58);
    autoCockpit.scale.set(0.72, 1.28, 0.54);
    autoLeftEngine.position.set(-0.34, -0.8, 0.34);
    autoRightEngine.position.set(0.34, -0.8, 0.34);
    autoLeftGun.position.set(-0.78, -0.34, 0.35);
    autoRightGun.position.set(0.78, -0.34, 0.35);
    autoLeftGun.scale.set(0.48, 0.92, 1);
    autoRightGun.scale.copy(autoLeftGun.scale);
    autoLeftGlow.position.set(-0.34, -1.14, 0.4);
    autoRightGlow.position.set(0.34, -1.14, 0.4);
    autoLeftGlow.scale.set(0.42, 0.86, 1);
    autoRightGlow.scale.copy(autoLeftGlow.scale);
    autoLeftCore.position.set(-0.34, -1.05, 0.44);
    autoRightCore.position.set(0.34, -1.05, 0.44);
    autoLeftCore.scale.set(0.92, 1.2, 1);
    autoRightCore.scale.copy(autoLeftCore.scale);
    autoLeftRail.position.set(-1.03, -0.34, 0.4);
    autoRightRail.position.set(1.03, -0.34, 0.4);
    autoLeftRail.rotation.z = 0.12;
    autoRightRail.rotation.z = -0.12;

    emergencyCageHull.position.z = 0.57;
    emergencyCageHull.scale.set(1.06, 1.04, 1);
    emergencyCageHull.renderOrder = 5;
    emergencyCageWing.position.set(0, -0.02, 0.43);
    emergencyCageWing.scale.set(1.035, 1.045, 1);
    emergencyCageWing.renderOrder = 5;
    shieldGlass.renderOrder = 10;
    shieldEnergy.renderOrder = 11;
    shieldEnergy.scale.setScalar(1.025);
    shieldGroup.position.z = 0.26;
    shieldGroup.visible = false;
    shieldGroup.add(shieldGlass, shieldEnergy);
    leftDrone.position.set(-1.45, -0.12, 0.4);
    rightDrone.position.set(1.45, -0.12, 0.4);
    flightRig.rotation.order = "YXZ";
    manualModel.name = "Jetfreeper.ship.manual";
    autoModel.name = "Jetfreeper.ship.auto-wireframe";
    emergencyOverlay.name = "Jetfreeper.ship.emergency-neon";
    manualModel.add(
      wings,
      wingAccent,
      body,
      leftEngine,
      rightEngine,
      leftGun,
      rightGun,
      cockpit,
      leftGlow,
      rightGlow,
      leftCore,
      rightCore,
      leftWingtip,
      rightWingtip,
      ...manualTrails,
      ...manualStripes,
    );
    autoModel.add(
      autoWings,
      autoHullCore,
      autoBody,
      autoCockpit,
      autoLeftEngine,
      autoRightEngine,
      autoLeftGun,
      autoRightGun,
      autoLeftGlow,
      autoRightGlow,
      autoLeftCore,
      autoRightCore,
      autoLeftRail,
      autoRightRail,
      ...autoCoreRings,
    );
    emergencyOverlay.add(
      emergencyCageWing,
      emergencyCageHull,
      ...emergencyScanners,
    );
    manualModel.visible = false;
    autoModel.visible = true;
    emergencyOverlay.visible = false;
    group.userData.flightRig = flightRig;
    group.userData.modeVisual = {
      manualModel,
      autoModel,
      emergencyOverlay,
      emergencyScanners,
      emergencyCageMaterials: [emergencyPrimaryMaterial, emergencySecondaryMaterial],
      manualEngines: { glows: [leftGlow, rightGlow], cores: [leftCore, rightCore] },
      autoEngines: { glows: [autoLeftGlow, autoRightGlow], cores: [autoLeftCore, autoRightCore] },
      autoHullMaterial,
      autoWingMaterial,
      autoCoreMaterial,
      autoAccentMaterial,
      manualTrailMaterial,
      manualTrails,
      autoCoreRings,
      appliedMode: null,
    } satisfies PlayerModeVisual;
    group.userData.shield = shield;
    group.userData.drones = [leftDrone, rightDrone];
    flightRig.add(manualModel, autoModel, emergencyOverlay);
    group.add(flightRig, shieldGroup, leftDrone, rightDrone);
    group.position.set(0, PLAYER_START_Y, 2);

    return group;
  }

  private updatePlayerModeVisuals(dashActive = this.dashRemaining > 0): void {
    const visual = this.player.userData.modeVisual as PlayerModeVisual;
    const mode = shipVisualMode(this.autoPilotEnabled, this.emergencyAssistState.active);

    if (visual.appliedMode !== mode) {
      visual.manualModel.visible = mode !== "auto";
      visual.autoModel.visible = mode === "auto";
      visual.emergencyOverlay.visible = mode === "emergency";
      visual.appliedMode = mode;
      this.renderer.domElement.setAttribute("data-player-visual-mode", mode);
    }

    const thrustPulse = this.reducedMotion ? 1 : 1 + Math.sin(this.runElapsed * 24) * 0.08;
    const exhaustLengths = [this.flightMotion.leftExhaust, this.flightMotion.rightExhaust];

    for (const engines of [visual.manualEngines, visual.autoEngines]) {
      for (let index = 0; index < engines.glows.length; index += 1) {
        const engineGlow = engines.glows[index];
        const engineCore = engines.cores[index];
        const exhaustLength = exhaustLengths[index] ?? RESTING_FLIGHT_MOTION.leftExhaust;

        if (!engineGlow || !engineCore) continue;

        engineGlow.scale.set(this.flightMotion.exhaustWidth, exhaustLength * thrustPulse, 1);
        engineGlow.position.y = -1.12 - Math.max(0, exhaustLength - 0.82) * 0.08;
        engineCore.scale.set(
          this.flightMotion.exhaustWidth * 2.05,
          exhaustLength * 1.45 * thrustPulse,
          1,
        );
        (engineGlow.material as THREE.MeshBasicMaterial).opacity = dashActive ? 0.96 : 0.78;
        (engineCore.material as THREE.MeshBasicMaterial).opacity = dashActive ? 1 : 0.92;
      }
    }

    const trailTime = this.reducedMotion ? 0 : this.runElapsed;
    const trailTimeUniform = visual.manualTrailMaterial.uniforms.uTime;
    const trailOpacityUniform = visual.manualTrailMaterial.uniforms.uOpacity;
    if (trailTimeUniform) trailTimeUniform.value = trailTime;
    if (trailOpacityUniform) {
      trailOpacityUniform.value = this.reducedMotion ? 0.42 : dashActive ? 1 : 0.86;
    }
    for (let index = 0; index < visual.manualTrails.length; index += 1) {
      const trail = visual.manualTrails[index];
      if (!trail) continue;
      const exhaustLength = exhaustLengths[index] ?? RESTING_FLIGHT_MOTION.leftExhaust;
      const trailScale = exhaustLength * (this.reducedMotion ? 0.72 : 1.16);
      trail.scale.set(this.flightMotion.exhaustWidth * 1.28, trailScale, 1);
      trail.position.y = -1.28 - trailScale * 0.54;
    }

    const scanTime = this.reducedMotion ? 0 : this.runElapsed;
    for (let index = 0; index < visual.emergencyScanners.length; index += 1) {
      const scanner = visual.emergencyScanners[index];
      if (!scanner) continue;
      const scan = emergencyHullScan(
        scanTime,
        index,
        visual.emergencyScanners.length,
        this.reducedMotion,
      );
      scanner.position.y = scan.y;
      scanner.scale.set(scan.width, this.reducedMotion ? 1.35 : 0.86 + scan.opacity * 0.28, 1);
      scanner.material.opacity = scan.opacity;
    }

    const cagePulse = this.reducedMotion ? 0.3 : 0.3 + Math.sin(this.runElapsed * 7.2) * 0.06;
    for (let index = 0; index < visual.emergencyCageMaterials.length; index += 1) {
      const material = visual.emergencyCageMaterials[index];
      if (material) material.opacity = Math.max(0.16, cagePulse - index * 0.08);
    }

    for (let index = 0; index < visual.autoCoreRings.length; index += 1) {
      const ring = visual.autoCoreRings[index];
      if (!ring) continue;
      ring.rotation.z = (this.reducedMotion ? 0.18 : this.runElapsed * (index % 2 === 0 ? 1.4 : -1.15))
        + index * 0.62;
    }
  }

  private createPilotLine(): PilotLine {
    const nodes = Array.from({ length: PILOT_LINE_NODE_COUNT }, (_, index): PilotLineNode => {
      const ringMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
        color: index === PILOT_LINE_NODE_COUNT - 1
          ? PLAYER_YELLOW
          : index % 2 === 0
            ? PLAYER_PINK
            : 0xff7dbe,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      const coreMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
        color: 0xfff8c9,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      const mesh = new THREE.Group();
      const ring = new THREE.Mesh(this.assets.bossCore, ringMaterial);
      const core = new THREE.Mesh(this.assets.bossCore, coreMaterial);
      ring.scale.setScalar(2.45);
      core.scale.setScalar(1.72);
      core.position.z = 0.05;

      for (let tickIndex = 0; tickIndex < 4; tickIndex += 1) {
        const angle = tickIndex / 4 * Math.PI * 2;
        const tick = new THREE.Mesh(this.assets.gunPod, ringMaterial);
        tick.position.set(Math.cos(angle) * 1.42, Math.sin(angle) * 1.42, 0.03);
        tick.rotation.z = angle;
        tick.scale.set(0.42, 0.36, 1);
        mesh.add(tick);
      }

      mesh.add(ring, core);
      mesh.position.z = 1.28;
      mesh.visible = false;
      return { mesh, ring, core, ringMaterial, coreMaterial, lane: 0 };
    });

    return {
      nodes,
      active: false,
      nextNode: 0,
      velocityY: -4.5,
      age: 0,
    };
  }

  private createDashTrail(): DashTrailVisual {
    const geometry = this.trackGeometry(new THREE.PlaneGeometry(1, 1));
    const material = this.trackMaterial(new THREE.ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uTime: { value: 0 },
        uTailColor: { value: new THREE.Color(PLAYER_PINK) },
        uHeadColor: { value: new THREE.Color(PLAYER_FIRE_CYAN) },
        uAccentColor: { value: new THREE.Color(PLAYER_YELLOW) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform float uOpacity;
        uniform float uTime;
        uniform vec3 uTailColor;
        uniform vec3 uHeadColor;
        uniform vec3 uAccentColor;
        varying vec2 vUv;

        void main() {
          float lateral = max(0.0, 1.0 - abs(vUv.x - 0.5) * 2.0);
          float softEdge = pow(lateral, 2.6);
          float brightCore = pow(lateral, 7.0);
          float tailFade = pow(vUv.y, 1.35);
          float headFade = 1.0 - smoothstep(0.88, 1.0, vUv.y);
          float flow = 0.88 + sin(vUv.y * 42.0 - uTime * 21.0) * 0.12;
          float alpha = (softEdge * 0.68 + brightCore * 0.52)
            * tailFade * headFade * flow * uOpacity;
          vec3 color = mix(uTailColor, uHeadColor, smoothstep(0.2, 0.9, vUv.y));
          color = mix(color, uAccentColor, brightCore * (1.0 - vUv.y) * 0.34);
          if (alpha < 0.008) discard;
          gl_FragColor = vec4(color * (0.78 + brightCore * 0.92), alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = 1.35;
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    mesh.visible = false;
    return { mesh, material };
  }

  private createPlayerLaser(): THREE.Group {
    const group = new THREE.Group();
    const glow = new THREE.Mesh(this.assets.playerLaserGlow, this.assets.playerLaserGlowMaterial);
    const core = new THREE.Mesh(this.assets.playerLaserCore, this.assets.playerLaserMaterial);
    glow.position.z = 2.35;
    core.position.z = 2.4;
    group.userData.glow = glow;
    group.userData.core = core;
    group.add(glow, core);
    group.visible = false;
    return group;
  }

  private createAbilityFieldVisual(kind: "counterflare" | "gravity-knot"): AbilityFieldVisual {
    const primaryColor = kind === "counterflare"
      ? ARCADE_PALETTE.counterMint
      : ARCADE_PALETTE.stasisViolet;
    const secondaryColor = kind === "counterflare"
      ? ARCADE_PALETTE.ivory
      : ARCADE_PALETTE.plasmaCobalt;
    const primaryMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: primaryColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const secondaryMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: secondaryColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const group = new THREE.Group();
    const rings: THREE.Mesh[] = [];
    const particles: THREE.Mesh[] = [];

    for (let index = 0; index < 3; index += 1) {
      const ring = new THREE.Mesh(
        index === 1 ? this.assets.bossCore : this.assets.shield,
        index % 2 === 0 ? primaryMaterial : secondaryMaterial,
      );
      ring.position.z = index * 0.03;
      ring.scale.setScalar(kind === "counterflare" ? 1.4 + index * 0.72 : 2.1 + index * 0.9);
      ring.rotation.z = index * 0.48;
      rings.push(ring);
      group.add(ring);
    }

    const particleCount = kind === "counterflare" ? 12 : 16;
    for (let index = 0; index < particleCount; index += 1) {
      const particle = new THREE.Mesh(
        this.assets.impactShard,
        index % 3 === 0 ? secondaryMaterial : primaryMaterial,
      );
      const angle = index / particleCount * Math.PI * 2;
      const radius = kind === "counterflare" ? 1.45 : 2.45;
      particle.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.08);
      particle.rotation.z = angle;
      particle.scale.set(kind === "counterflare" ? 1.3 : 1.7, kind === "counterflare" ? 1.8 : 2.3, 1);
      particles.push(particle);
      group.add(particle);
    }

    group.position.z = 2.18;
    group.visible = false;
    return { group, rings, particles, primaryMaterial, secondaryMaterial };
  }

  private createPhoenixWings(): PhoenixWingVisual[] {
    const wingMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.playerMagenta,
      transparent: true,
      opacity: 0.94,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const hullMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.ivory,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const coreMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.playerYellow,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));

    return Array.from({ length: 3 }, () => {
      const group = new THREE.Group();
      const wings = new THREE.Mesh(this.assets.playerWing, wingMaterial);
      const hull = new THREE.Mesh(this.assets.playerHull, hullMaterial);
      const core = new THREE.Mesh(this.assets.playerCockpit, coreMaterial);
      const trailMaterial = this.trackMaterial(wingMaterial.clone());
      trailMaterial.opacity = 0.34;
      const trail = new THREE.Mesh(this.assets.playerLaserGlow, trailMaterial);
      wings.position.z = 0.03;
      hull.position.z = 0.08;
      core.position.set(0, 0.2, 0.13);
      core.scale.set(0.5, 0.72, 0.36);
      trail.position.set(0, -4.4, -0.03);
      trail.scale.set(3.4, 8.5, 1);
      group.add(trail, wings, hull, core);
      group.position.set(0, WORLD_BOTTOM - 3, 2.26);
      group.scale.setScalar(1.36);
      group.visible = false;
      return { group, trailMaterial, age: 99, laneX: 0 };
    });
  }

  private createRemoteBombVisual(): RemoteBombVisual {
    const group = new THREE.Group();
    const coreMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.telegraphOrange,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const ringMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.ivory,
      transparent: true,
      opacity: 0.76,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const core = new THREE.Mesh(this.assets.bonusBox, coreMaterial);
    const rings = [
      new THREE.Mesh(this.assets.bossCore, ringMaterial),
      new THREE.Mesh(this.assets.bossCore, coreMaterial),
    ];
    core.scale.set(0.76, 0.76, 0.76);
    core.rotation.set(0.45, 0.45, 0);
    rings[0]?.scale.setScalar(0.86);
    rings[1]?.scale.setScalar(1.18);
    rings[1]!.rotation.z = Math.PI / 4;
    rings[0]!.position.z = 0.52;
    rings[1]!.position.z = 0.5;
    group.add(core, ...rings);

    for (let index = 0; index < 4; index += 1) {
      const angle = index / 4 * Math.PI * 2;
      const fin = new THREE.Mesh(this.assets.impactShard, coreMaterial);
      fin.position.set(Math.cos(angle) * 0.9, Math.sin(angle) * 0.9, 0.3);
      fin.rotation.z = angle;
      fin.scale.set(1.4, 1.9, 1);
      group.add(fin);
    }

    group.position.z = 2.3;
    group.visible = false;
    return { group, coreMaterial, ringMaterial, rings };
  }

  private createGuardianWingmen(): GuardianWingVisual[] {
    const hullMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.counterMint,
      transparent: true,
      opacity: 0.94,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const wingMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.shieldAzure,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const coreMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.playerYellow,
      transparent: true,
      opacity: 0.98,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));

    return ([-1, 1] as const).map((side, index) => {
      const group = new THREE.Group();
      const wings = new THREE.Mesh(this.assets.playerWing, wingMaterial);
      const hull = new THREE.Mesh(this.assets.playerHull, hullMaterial);
      const core = new THREE.Mesh(this.assets.playerCockpit, coreMaterial);
      const countermeasureMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
        color: ARCADE_PALETTE.counterMint,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }));
      const countermeasureRing = new THREE.Mesh(this.assets.shield, countermeasureMaterial);
      wings.position.z = 0.02;
      hull.position.z = 0.07;
      core.position.set(0, 0.18, 0.12);
      core.scale.set(0.46, 0.65, 0.34);
      countermeasureRing.position.z = 0.16;
      countermeasureRing.scale.setScalar(1.35);
      group.add(wings, hull, core, countermeasureRing);
      group.scale.setScalar(0.72);
      group.position.set(side * 1.8, PLAYER_START_Y - 0.3, 2.2);
      group.visible = false;
      return {
        id: index + 1,
        side,
        group,
        countermeasureRing,
        countermeasureMaterial,
        countermeasureCooldown: index * 0.12,
        offensiveFireCooldown: initialGuardianWingFireCooldown(index),
        logicalShotsAccumulated: 0,
        pulseSeconds: 0,
      };
    });
  }

  private createBoss(): Boss {
    const mesh = new THREE.Group();
    const hullMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xb6382e,
      emissive: 0x4b120e,
      emissiveIntensity: 0.72,
      metalness: 0.76,
      roughness: 0.28,
    }));
    const wingMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0x4f1a18,
      emissive: 0x210908,
      emissiveIntensity: 0.52,
      metalness: 0.7,
      roughness: 0.38,
    }));
    const accentMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({ color: 0xff7140 }));
    const coreMaterial = this.trackMaterial(new THREE.MeshStandardMaterial({
      color: 0xffc06a,
      emissive: 0xb7351c,
      emissiveIntensity: 1.1,
      metalness: 0.64,
      roughness: 0.2,
    }));
    const chronarchMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0x72f4ff,
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    const chargeMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0xff9638,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const entryShieldMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0xff5f38,
      transparent: true,
      opacity: 0.56,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const wings = new THREE.Mesh(this.assets.bossWing, wingMaterial);
    const wingAccent = new THREE.Mesh(this.assets.bossWing, accentMaterial);
    const hull = new THREE.Mesh(this.assets.bossHull, hullMaterial);
    const cockpit = new THREE.Mesh(this.assets.playerCockpit, coreMaterial);
    const coreRing = new THREE.Mesh(this.assets.bossCore, accentMaterial);
    const leftCannon = new THREE.Mesh(this.assets.bossCannon, wingMaterial);
    const rightCannon = new THREE.Mesh(this.assets.bossCannon, wingMaterial);
    const leftEngine = new THREE.Mesh(this.assets.bossCannon, hullMaterial);
    const rightEngine = new THREE.Mesh(this.assets.bossCannon, hullMaterial);
    const leftEngineGlow = new THREE.Mesh(this.assets.engineGlow, this.assets.enemyEngineMaterial);
    const rightEngineGlow = new THREE.Mesh(this.assets.engineGlow, this.assets.enemyEngineMaterial);
    const leftCharge = new THREE.Mesh(this.assets.turretMuzzle, chargeMaterial);
    const rightCharge = new THREE.Mesh(this.assets.turretMuzzle, chargeMaterial);
    const entryShield = new THREE.Mesh(this.assets.shield, entryShieldMaterial);
    const variants = Object.fromEntries(BOSS_ARCHETYPES.map((archetype) => {
      const variant = new THREE.Group();
      variant.visible = false;
      return [archetype, variant];
    })) as Record<BossArchetype, THREE.Group>;

    const ravagerCrest = new THREE.Mesh(this.assets.bossCore, accentMaterial);
    ravagerCrest.position.set(0, 0.55, 0.75);
    ravagerCrest.scale.setScalar(0.72);
    variants.ravager.add(ravagerCrest);

    for (const side of [-1, 1]) {
      const stormBlade = new THREE.Mesh(this.assets.fighterWing, wingMaterial);
      stormBlade.position.set(side * 2.25, 0.28, 0.42);
      stormBlade.scale.set(side * 1.15, 0.78, 1);
      stormBlade.rotation.z = side * 0.34;
      variants.stormwing.add(stormBlade);

      const broadsideRing = new THREE.Mesh(this.assets.turretRing, accentMaterial);
      broadsideRing.position.set(side * 2.15, -0.12, 0.62);
      broadsideRing.scale.setScalar(1.35);
      variants.dreadnought.add(broadsideRing);

      const harvesterPod = new THREE.Mesh(this.assets.asteroid, hullMaterial);
      harvesterPod.position.set(side * 2.1, 0.18, 0.42);
      harvesterPod.scale.set(0.72, 1.1, 0.7);
      variants.harvester.add(harvesterPod);
    }

    for (let cannonIndex = 0; cannonIndex < 4; cannonIndex += 1) {
      const cannon = new THREE.Mesh(this.assets.bossCannon, wingMaterial);
      cannon.position.set((cannonIndex - 1.5) * 1.22, -1.18, 0.48);
      cannon.scale.set(1.08, 1.32, 1);
      variants.dreadnought.add(cannon);

      const prismBlade = new THREE.Mesh(this.assets.fighterWing, accentMaterial);
      const angle = cannonIndex / 4 * Math.PI * 2;
      prismBlade.position.set(Math.cos(angle) * 1.55, Math.sin(angle) * 1.1, 0.54);
      prismBlade.rotation.z = angle + Math.PI / 2;
      prismBlade.scale.set(0.58, 0.72, 1);
      variants.prism.add(prismBlade);
    }

    const prismCore = new THREE.Mesh(this.assets.bossCore, coreMaterial);
    prismCore.position.z = 0.84;
    prismCore.scale.setScalar(1.75);
    prismCore.rotation.x = 0.35;
    variants.prism.add(prismCore);

    const harvesterJaw = new THREE.Mesh(this.assets.bossHull, accentMaterial);
    harvesterJaw.position.set(0, -0.85, 0.48);
    harvesterJaw.rotation.z = Math.PI;
    harvesterJaw.scale.set(0.72, 0.68, 1);
    variants.harvester.add(harvesterJaw);

    // Chronarch reads as a clockwork halo instead of another winged hull. Two
    // counter-rotating rings, eight hour markers, and independently animated
    // hands make its silhouette recognizable even through the pixel pass.
    const chronarchOuterRing = new THREE.Mesh(this.assets.shield, chronarchMaterial);
    chronarchOuterRing.position.z = 0.82;
    chronarchOuterRing.scale.set(2.55, 1.92, 1);
    const chronarchInnerRing = new THREE.Mesh(this.assets.bossCore, chronarchMaterial);
    chronarchInnerRing.position.z = 0.88;
    chronarchInnerRing.scale.set(3.15, 2.45, 1);
    variants.chronarch.add(chronarchOuterRing, chronarchInnerRing);

    for (let markerIndex = 0; markerIndex < 8; markerIndex += 1) {
      const angle = markerIndex / 8 * Math.PI * 2;
      const marker = new THREE.Mesh(this.assets.bossCannon, chronarchMaterial);
      marker.position.set(Math.cos(angle) * 2.4, Math.sin(angle) * 1.78, 0.8);
      marker.rotation.z = angle + Math.PI / 2;
      marker.scale.set(0.38, markerIndex % 2 === 0 ? 0.62 : 0.4, 1);
      variants.chronarch.add(marker);
    }

    const chronarchLongHand = new THREE.Group();
    const longHandMesh = new THREE.Mesh(this.assets.bossCannon, chronarchMaterial);
    longHandMesh.position.set(0, -0.78, 0.96);
    longHandMesh.scale.set(0.44, 1.45, 1);
    chronarchLongHand.add(longHandMesh);
    const chronarchShortHand = new THREE.Group();
    const shortHandMesh = new THREE.Mesh(this.assets.bossCannon, coreMaterial);
    shortHandMesh.position.set(0, -0.5, 1);
    shortHandMesh.scale.set(0.62, 0.9, 1);
    chronarchShortHand.add(shortHandMesh);
    const chronarchHub = new THREE.Mesh(this.assets.playerCockpit, chronarchMaterial);
    chronarchHub.position.z = 1.02;
    chronarchHub.scale.set(0.82, 0.82, 0.38);
    variants.chronarch.add(chronarchLongHand, chronarchShortHand, chronarchHub);
    variants.chronarch.userData.outerRing = chronarchOuterRing;
    variants.chronarch.userData.innerRing = chronarchInnerRing;
    variants.chronarch.userData.longHand = chronarchLongHand;
    variants.chronarch.userData.shortHand = chronarchShortHand;

    wings.position.z = 0.18;
    wingAccent.position.set(0, -0.08, 0.22);
    wingAccent.scale.set(0.82, 0.76, 1);
    hull.position.z = 0.32;
    cockpit.position.set(0, -0.52, 0.56);
    cockpit.scale.set(0.9, 1.28, 0.5);
    coreRing.position.set(0, -0.48, 0.76);
    leftCannon.position.set(-1.58, -0.72, 0.34);
    rightCannon.position.set(1.58, -0.72, 0.34);
    leftEngine.position.set(-1.02, 0.86, 0.34);
    rightEngine.position.set(1.02, 0.86, 0.34);
    leftEngine.scale.set(1.28, 0.8, 1);
    rightEngine.scale.copy(leftEngine.scale);
    leftEngineGlow.position.set(-1.02, 1.46, 0.4);
    rightEngineGlow.position.set(1.02, 1.46, 0.4);
    leftEngineGlow.scale.set(0.72, 1.32, 1);
    rightEngineGlow.scale.copy(leftEngineGlow.scale);
    leftCharge.position.set(-1.58, -1.36, 0.52);
    rightCharge.position.set(1.58, -1.36, 0.52);
    leftCharge.scale.setScalar(1.45);
    rightCharge.scale.copy(leftCharge.scale);
    entryShield.position.z = 0.84;
    entryShield.scale.set(3.05, 2.35, 1);
    entryShield.visible = false;
    mesh.add(
      wings,
      wingAccent,
      hull,
      leftEngine,
      rightEngine,
      leftCannon,
      rightCannon,
      cockpit,
      coreRing,
      leftEngineGlow,
      rightEngineGlow,
      leftCharge,
      rightCharge,
      entryShield,
      ...BOSS_ARCHETYPES.map((archetype) => variants[archetype]),
    );
    mesh.position.set(0, WORLD_TOP + 4, 0.6);
    mesh.visible = false;

    return {
      mesh,
      active: false,
      entering: false,
      health: 0,
      maxHealth: 1,
      phase: 1,
      age: 0,
      attackCooldown: 0,
      patternIndex: 0,
      hitFlashRemaining: 0,
      hullMaterial,
      wingMaterial,
      chargeMaterial,
      chargeGlows: [leftCharge, rightCharge],
      engineGlows: [leftEngineGlow, rightEngineGlow],
      entryShield,
      archetype: "ravager",
      name: bossNameForArchetype("ravager"),
      radius: BOSS_RADIUS,
      observedVelocityX: 0,
      observedVelocityY: 0,
      cryoRemaining: 0,
      variants,
    };
  }

  private createCaveSideGeometry(): THREE.BufferGeometry {
    const geometry = this.trackGeometry(new THREE.BufferGeometry());
    const vertexCount = CAVE_ROW_COUNT * CAVE_MESH_COLUMN_COUNT;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const indices: number[] = [];

    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      normals[vertex * 3 + 2] = 1;
    }

    for (let row = 0; row < CAVE_ROW_COUNT - 1; row += 1) {
      for (let column = 0; column < CAVE_MESH_COLUMN_COUNT - 1; column += 1) {
        const current = row * CAVE_MESH_COLUMN_COUNT + column;
        const currentNextColumn = current + 1;
        const nextRow = current + CAVE_MESH_COLUMN_COUNT;
        const nextRowNextColumn = nextRow + 1;
        indices.push(
          current,
          currentNextColumn,
          nextRow,
          currentNextColumn,
          nextRowNextColumn,
          nextRow,
        );
      }
    }

    const positionAttribute = new THREE.BufferAttribute(positions, 3);
    const normalAttribute = new THREE.BufferAttribute(normals, 3);
    const uvAttribute = new THREE.BufferAttribute(uvs, 2);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    normalAttribute.setUsage(THREE.DynamicDrawUsage);
    uvAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positionAttribute);
    geometry.setAttribute("normal", normalAttribute);
    geometry.setAttribute("uv", uvAttribute);
    geometry.setIndex(indices);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 48);
    return geometry;
  }

  private createCaveLayers(): CaveLayerVisual[] {
    return CAVE_LAYER_SPECS.map((spec) => {
      const leftGeometry = this.createCaveSideGeometry();
      const rightGeometry = this.createCaveSideGeometry();
      leftGeometry.name = `Jetcreeper.cave-mountain-relief:${spec.id}:left`;
      rightGeometry.name = `Jetcreeper.cave-mountain-relief:${spec.id}:right`;
      // The cave owns a tiny neutral relief shader. Combat's deliberately
      // yellow/magenta lights therefore cannot tint charcoal stone, while
      // screen-space derivatives retain a hard facet normal for each Z-mesh
      // triangle before the whole scene enters RenderPixelatedPass.
      const material = this.trackMaterial(new THREE.ShaderMaterial({
        name: `Jetcreeper.cave-rock-neutral-shader:${spec.id}`,
        uniforms: {
          rockMap: { value: this.caveRockTexture },
          rockColor: { value: new THREE.Color(CAVE_LAYER_COLORS[spec.id]) },
        },
        vertexShader: /* glsl */`
          varying vec2 vRockUv;
          varying vec3 vViewPosition;

          void main() {
            vRockUv = uv;
            vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
            vViewPosition = viewPosition.xyz;
            gl_Position = projectionMatrix * viewPosition;
          }
        `,
        fragmentShader: /* glsl */`
          uniform sampler2D rockMap;
          uniform vec3 rockColor;
          varying vec2 vRockUv;
          varying vec3 vViewPosition;

          void main() {
            vec3 facetNormal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
            facetNormal *= facetNormal.z < 0.0 ? -1.0 : 1.0;
            vec2 neutralKey = normalize(vec2(-0.56, 0.83));
            float slopeLight = dot(facetNormal.xy, neutralKey);
            float ruggedness = clamp((1.0 - facetNormal.z) * 5.0, 0.0, 1.0);
            float reliefLight = clamp(0.68 + slopeLight * 2.2 + ruggedness * 0.12, 0.38, 1.08);
            float stone = texture2D(rockMap, vRockUv).r;
            float textureShade = mix(0.48, 1.08, stone);
            gl_FragColor = vec4(rockColor * reliefLight * textureShade, 1.0);
          }
        `,
        side: THREE.FrontSide,
        depthWrite: true,
        depthTest: true,
      }));
      material.name = `Jetcreeper.cave-rock-lit:${spec.id}`;
      const leftMesh = new THREE.Mesh(leftGeometry, material);
      const rightMesh = new THREE.Mesh(rightGeometry, material);
      leftMesh.position.z = spec.depth;
      rightMesh.position.z = spec.depth;
      leftMesh.frustumCulled = false;
      rightMesh.frustumCulled = false;
      leftMesh.renderOrder = CAVE_LAYER_SPECS.indexOf(spec);
      rightMesh.renderOrder = leftMesh.renderOrder;
      return { spec, leftGeometry, rightGeometry, leftMesh, rightMesh };
    });
  }

  private updateCaveLayers(): void {
    for (let layerIndex = 0; layerIndex < this.caveLayers.length; layerIndex += 1) {
      const layer = this.caveLayers[layerIndex];

      if (!layer) {
        continue;
      }

      const leftPositions = layer.leftGeometry.getAttribute("position") as THREE.BufferAttribute;
      const rightPositions = layer.rightGeometry.getAttribute("position") as THREE.BufferAttribute;
      const leftUvs = layer.leftGeometry.getAttribute("uv") as THREE.BufferAttribute;
      const rightUvs = layer.rightGeometry.getAttribute("uv") as THREE.BufferAttribute;
      const layerOffset = layerIndex * CAVE_ROCK_LAYER_OFFSET;

      for (let row = 0; row < CAVE_ROW_COUNT; row += 1) {
        const ratio = row / (CAVE_ROW_COUNT - 1);
        const y = CAVE_VISUAL_BOTTOM + ratio * (CAVE_VISUAL_TOP - CAVE_VISUAL_BOTTOM);
        const longitudinalDistance = this.caveTravel + WORLD_TOP + y;
        const sample = sampleCaveLayerCorridor(
          layer.spec,
          this.caveTravel,
          y,
          this.caveDifficultySector,
        );
        const textureV = (
          this.caveTravel * layer.spec.parallax
          + layer.spec.phaseOffset
          + y
        ) * CAVE_ROCK_TEXTURE_SCALE_Y + layerOffset;

        for (let column = 0; column < CAVE_MESH_COLUMN_COUNT; column += 1) {
          const columnRatio = column / (CAVE_MESH_COLUMN_COUNT - 1);
          // Left vertices remain ordered outer-to-inner, while right vertices
          // remain inner-to-outer. Easing toward the offscreen boundary puts
          // most of the facets in the visible five-unit collision-wall band.
          const leftDepth = 1 - columnRatio;
          const rightDepth = columnRatio;
          const curvedLeftDepth = leftDepth ** CAVE_MESH_DEPTH_CURVE;
          const curvedRightDepth = rightDepth ** CAVE_MESH_DEPTH_CURVE;
          const leftX = THREE.MathUtils.lerp(sample.left, -BACKGROUND_HALF_WIDTH, curvedLeftDepth);
          const rightX = THREE.MathUtils.lerp(sample.right, BACKGROUND_HALF_WIDTH, curvedRightDepth);
          const leftZ = caveMountainRelief(
            layer.spec,
            layerIndex,
            -1,
            leftDepth,
            longitudinalDistance,
          );
          const rightZ = caveMountainRelief(
            layer.spec,
            layerIndex,
            1,
            rightDepth,
            longitudinalDistance,
          );
          const vertexIndex = row * CAVE_MESH_COLUMN_COUNT + column;

          leftPositions.setXYZ(vertexIndex, leftX, y, leftZ);
          rightPositions.setXYZ(vertexIndex, rightX, y, rightZ);
          leftUvs.setXY(
            vertexIndex,
            leftX * CAVE_ROCK_TEXTURE_SCALE_X + layerOffset,
            textureV,
          );
          rightUvs.setXY(
            vertexIndex,
            rightX * CAVE_ROCK_TEXTURE_SCALE_X + layerOffset,
            textureV,
          );
        }
      }

      leftPositions.needsUpdate = true;
      rightPositions.needsUpdate = true;
      leftUvs.needsUpdate = true;
      rightUvs.needsUpdate = true;
      layer.leftGeometry.computeVertexNormals();
      layer.rightGeometry.computeVertexNormals();
    }
  }

  private createStarfield(): THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    const starCount = 145;
    const stars = new THREE.InstancedMesh(this.assets.star, this.assets.starMaterial, starCount);
    const starColor = new THREE.Color();
    stars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    stars.frustumCulled = false;

    for (let index = 0; index < starCount; index += 1) {
      this.starData.push({
        x: this.randomRange(-BACKGROUND_HALF_WIDTH, BACKGROUND_HALF_WIDTH),
        y: this.randomRange(WORLD_BOTTOM, WORLD_TOP),
        speed: this.randomRange(0.45, 1.9),
        scale: this.randomRange(0.45, 1.15),
      });
      stars.setColorAt(
        index,
        starColor.setHex(STARFIELD_COLORS[index % STARFIELD_COLORS.length] ?? STARFIELD_COLORS[0]),
      );
    }

    this.updateStarMatrices(stars);
    if (stars.instanceColor) {
      stars.instanceColor.needsUpdate = true;
    }
    return stars;
  }

  private update(deltaSeconds: number): void {
    this.runElapsed += deltaSeconds;
    this.snapshotElapsed += deltaSeconds;
    this.rapidFireRemaining = Math.max(0, this.rapidFireRemaining - deltaSeconds);
    this.spreadRemaining = Math.max(0, this.spreadRemaining - deltaSeconds);
    this.plasmaRemaining = Math.max(0, this.plasmaRemaining - deltaSeconds);
    this.beamRemaining = Math.max(0, this.beamRemaining - deltaSeconds);
    this.droneRemaining = Math.max(0, this.droneRemaining - deltaSeconds);
    this.overdriveRemaining = Math.max(0, this.overdriveRemaining - deltaSeconds);
    this.stasisRemaining = Math.max(0, this.stasisRemaining - deltaSeconds);
    const nanorepairWasActive = this.attachmentActive("nanorepair");
    for (const kind of ADVANCED_ATTACHMENT_KINDS) {
      this.advancedAttachmentRemaining[kind] = Math.max(
        0,
        this.advancedAttachmentRemaining[kind] - deltaSeconds,
      );
    }
    if (nanorepairWasActive && !this.attachmentActive("nanorepair")) {
      this.nanorepairKillsRemaining = 0;
      this.nanorepairCharge = 0;
    }
    this.dashCooldownRemaining = Math.max(0, this.dashCooldownRemaining - deltaSeconds);
    this.dashEffectRemaining = Math.max(0, this.dashEffectRemaining - deltaSeconds);
    this.burstRemaining = Math.max(0, this.burstRemaining - deltaSeconds);
    this.syncStrikeRemaining = Math.max(0, this.syncStrikeRemaining - deltaSeconds);
    this.lowProfileRemaining = Math.max(0, this.lowProfileRemaining - deltaSeconds);
    this.lowProfileTimeWarpRemaining = Math.max(0, this.lowProfileTimeWarpRemaining - deltaSeconds);
    this.lowProfileCooldownRemaining = Math.max(0, this.lowProfileCooldownRemaining - deltaSeconds);
    this.missileCooldownRemaining = Math.max(0, this.missileCooldownRemaining - deltaSeconds);
    this.remoteBombCooldownRemaining = Math.max(0, this.remoteBombCooldownRemaining - deltaSeconds);
    this.guardianWingRemaining = Math.max(0, this.guardianWingRemaining - deltaSeconds);
    this.guardianWingCooldownRemaining = Math.max(0, this.guardianWingCooldownRemaining - deltaSeconds);
    this.tickSpecialAbilityTimers(deltaSeconds);
    this.brainDecisionCooldown = Math.max(0, this.brainDecisionCooldown - deltaSeconds);
    this.recentHumanInputSeconds = Math.max(0, this.recentHumanInputSeconds - deltaSeconds);
    this.invulnerabilityRemaining = Math.max(0, this.invulnerabilityRemaining - deltaSeconds);
    this.sectorAnnouncementRemaining = Math.max(0, this.sectorAnnouncementRemaining - deltaSeconds);
    this.screenShakeRemaining = Math.max(0, this.screenShakeRemaining - deltaSeconds);
    this.difficulty = difficultyForSector(this.sector);

    if (this.emergencyAssistState.active) {
      this.applyEmergencyAssistTransition(tickEmergencyAssist(
        this.emergencyAssistState,
        deltaSeconds,
      ));
    }

    this.updateSuperBrain();
    const hostileTimeScale = this.currentHostileTimeScale();
    const hostileDeltaSeconds = deltaSeconds * hostileTimeScale;
    const worldDeltaSeconds = deltaSeconds * this.currentWorldTimeScale();
    this.worldElapsed += worldDeltaSeconds;
    this.updateBackground(worldDeltaSeconds);
    this.updatePlayer(deltaSeconds);
    this.drainLowProfileBossDamage();
    this.updateSpecialAbilityEffects(deltaSeconds);
    this.updateRemoteBomb(deltaSeconds);
    this.updateAutoCombatSystems();
    this.updateGuardianWingmen(deltaSeconds, hostileTimeScale);
    this.updatePilotLine(worldDeltaSeconds);
    this.updateSpawning(worldDeltaSeconds);
    this.updateEnemies(hostileDeltaSeconds);
    this.updateBoss(hostileDeltaSeconds);
    this.updateBossEscorts();
    this.drainLowProfileBossDamage();
    this.updateProjectiles(deltaSeconds, hostileTimeScale);
    this.updateBonuses(worldDeltaSeconds);
    this.resolveCollisions();
    this.updateImpacts(deltaSeconds);
    this.updateCameraShake();
    this.publishSnapshot(false);
  }

  private currentWorldTimeScale(): number {
    return this.lowProfileTimeWarpRemaining > 0 ? LOW_PROFILE_HOSTILE_TIME_SCALE : 1;
  }

  private currentHostileTimeScale(): number {
    const stasisScale = this.stasisRemaining > 0
      ? 0.5 + this.difficulty.terminalProgress * 0.22
      : 1;
    return Math.min(stasisScale, this.currentWorldTimeScale());
  }

  private currentPlayerCruiseSpeed(): number {
    return PLAYER_SPEED
      * (this.overdriveRemaining > 0 ? 1.28 : 1)
      * (this.attachmentActive("afterburner") ? AFTERBURNER_FLIGHT_MULTIPLIER : 1)
      * (this.lowProfileTimeWarpRemaining > 0 ? LOW_PROFILE_PLAYER_SPEED_MULTIPLIER : 1);
  }

  private updateBackground(deltaSeconds: number): void {
    const visualSpeed = this.difficulty.scrollSpeed * (this.reducedMotion ? 0.38 : 1);
    this.caveDifficultySector = advanceCaveDifficultySector(
      this.caveDifficultySector,
      this.sector,
      deltaSeconds,
    );
    this.previousCaveTravel = this.caveTravel;
    this.caveTravel += this.difficulty.scrollSpeed * deltaSeconds;

    for (const star of this.starData) {
      star.y -= (star.speed + visualSpeed * 0.52) * deltaSeconds;

      if (star.y < WORLD_BOTTOM - 0.4) {
        star.y = WORLD_TOP + this.randomRange(0, 1.4);
        star.x = this.randomRange(-BACKGROUND_HALF_WIDTH, BACKGROUND_HALF_WIDTH);
      }
    }

    // Physics owns only the analytic travel state. The comparatively expensive
    // relief vertices and normals are rebuilt once before the rendered frame,
    // never once for every fixed-step catch-up iteration.
    this.backgroundVisualsDirty = true;
  }

  private updateStarMatrices(stars: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>): void {
    for (let index = 0; index < this.starData.length; index += 1) {
      const star = this.starData[index];

      if (!star) {
        continue;
      }

      // Stars belong to the open aperture, behind even the deepest rock. They
      // can no longer draw over moving mountain facets and imitate shimmer.
      this.starTransform.position.set(star.x, star.y, -10.75);
      this.starTransform.rotation.set(0, 0, 0);
      this.starTransform.scale.set(star.scale, star.scale * (0.68 + star.speed * 0.12), 1);
      this.starTransform.updateMatrix();
      stars.setMatrixAt(index, this.starTransform.matrix);
    }

    stars.instanceMatrix.needsUpdate = true;
  }

  private updateManualFlightControl(): void {
    const horizontalDirection = this.directionFor(LEFT_MOVEMENT_CODES, RIGHT_MOVEMENT_CODES);
    const verticalDirection = this.directionFor(DOWN_MOVEMENT_CODES, UP_MOVEMENT_CODES);
    const directionLength = Math.hypot(horizontalDirection, verticalDirection);

    this.playerIntentX = directionLength > 0 ? horizontalDirection / directionLength : 0;
    this.playerIntentY = directionLength > 0 ? verticalDirection / directionLength : 0;
    this.brainMode = "Manual control";
    this.executeManualAbilityRequests();
  }

  private executeManualAbilityRequests(): void {
    if (this.manualDashRequested) {
      this.tryDash(this.playerIntentX, this.playerIntentY, "manual");
    }

    if (this.manualLowProfileRequested) {
      this.tryLowProfile("manual");
    }

    if (this.manualMissilesRequested) {
      this.tryMissiles("manual");
    }

    if (this.manualCounterflareRequested) {
      this.trySpecialAbility("counterflare", "manual");
    }

    if (this.manualGravityKnotRequested) {
      this.trySpecialAbility("gravity-knot", "manual");
    }

    if (this.manualPhoenixSquadronRequested) {
      this.trySpecialAbility("phoenix-squadron", "manual");
    }

    this.clearManualAbilityRequests();
  }

  private manualEmergencyCollisionImminent(): boolean {
    const hostileTimeScale = this.currentHostileTimeScale();
    const threats: ManualEmergencyThreat[] = [];

    for (let index = 0; index < this.enemyProjectiles.length; index += 1) {
      const projectile = this.enemyProjectiles[index];
      if (!projectile) continue;
      threats.push({
        id: `projectile-${index}`,
        kind: projectile.kind === "rocket" ? "rocket" : "projectile",
        position: {
          x: projectile.mesh.position.x,
          y: projectile.mesh.position.y,
        },
        velocity: {
          x: projectile.velocityX * hostileTimeScale,
          y: projectile.velocityY * hostileTimeScale,
        },
        radius: projectile.radius,
      });
    }

    for (const enemy of this.enemies) {
      if (enemy.health <= 0) continue;
      threats.push({
        id: `enemy-${enemy.id}`,
        kind: "enemy",
        position: { x: enemy.mesh.position.x, y: enemy.mesh.position.y },
        velocity: {
          x: enemy.observedVelocityX * hostileTimeScale,
          y: enemy.observedVelocityY * hostileTimeScale,
        },
        radius: enemy.radius,
      });
    }

    if (this.boss.active && !this.boss.entering) {
      threats.push({
        id: "boss",
        kind: "enemy",
        position: { x: this.boss.mesh.position.x, y: this.boss.mesh.position.y },
        velocity: {
          x: this.boss.observedVelocityX * hostileTimeScale,
          y: this.boss.observedVelocityY * hostileTimeScale,
        },
        radius: this.boss.radius,
      });
    }

    return evaluateManualEmergencySentinel({
      player: {
        position: { x: this.player.position.x, y: this.player.position.y },
        velocity: { x: this.playerVelocityX, y: this.playerVelocityY },
        radius: this.currentPlayerRadius(),
      },
      threats,
    }).needsAssist;
  }

  private combatTargetVisible(
    x: number,
    y: number,
    radius: number,
    meshVisible: boolean,
  ): boolean {
    return meshVisible
      && x + radius >= this.camera.left
      && x - radius <= this.camera.right
      && y + radius >= this.camera.bottom
      && y - radius <= this.camera.top;
  }

  private forwardWeaponCanReach(y: number, radius: number): boolean {
    return y + radius
      >= this.player.position.y + PLAYER_AIM_TUNING.minimumForwardDistance;
  }

  private committedProjectileDamageForEnemy(enemyId: number): number {
    return this.playerProjectiles.reduce((damage, projectile) => (
      projectile.targetId === enemyId && !projectile.hitEnemyIds.includes(enemyId)
        ? damage + Math.max(0, projectile.damage)
        : damage
    ), 0);
  }

  private committedProjectileDamageForBoss(): number {
    return this.playerProjectiles.reduce((damage, projectile) => (
      projectile.targetBoss && !projectile.hitBoss
        ? damage + Math.max(0, projectile.damage)
        : damage
    ), 0);
  }

  private updateSuperBrain(): void {
    if (this.dashRemaining > 0) {
      this.brainMode = this.autoPilotEnabled
        ? "Dashing"
        : this.emergencyAssistState.active
          ? "Emergency evade"
          : "Manual control";
      this.playerIntentX = this.dashDirectionX;
      this.playerIntentY = this.dashDirectionY;
      this.brainSurvivalSeconds = 0;
      this.brainClearance = -1;

      if (this.manualLowProfileRequested) {
        this.tryLowProfile("manual");
      }

      if (this.manualMissilesRequested) {
        this.tryMissiles("manual");
      }

      if (this.manualCounterflareRequested) {
        this.trySpecialAbility("counterflare", "manual");
      }

      if (this.manualGravityKnotRequested) {
        this.trySpecialAbility("gravity-knot", "manual");
      }

      if (this.manualPhoenixSquadronRequested) {
        this.trySpecialAbility("phoenix-squadron", "manual");
      }

      this.clearManualAbilityRequests();
      this.brainDecisionCooldown = 0.02;
      return;
    }

    if (!this.autoPilotEnabled && !this.emergencyAssistState.active) {
      this.updateManualFlightControl();
    }

    // This exact swept-collision sentinel runs before the planner throttle on
    // every fixed Manual tick. It only wakes the bounded route search; Auto
    // and already-active rescue control retain their existing cadence.
    const imminentManualCollision = !this.autoPilotEnabled
      && !this.emergencyAssistState.active
      && this.emergencyAssistState.armed
      && this.manualEmergencyCollisionImminent();
    if (imminentManualCollision) {
      this.brainDecisionCooldown = 0;
    }

    if (
      this.brainDecisionCooldown > 0 &&
      !this.manualDashRequested &&
      !this.manualLowProfileRequested &&
      !this.manualMissilesRequested &&
      !this.manualCounterflareRequested &&
      !this.manualGravityKnotRequested &&
      !this.manualPhoenixSquadronRequested
    ) {
      return;
    }

    const horizontalDirection = this.directionFor(LEFT_MOVEMENT_CODES, RIGHT_MOVEMENT_CODES);
    const verticalDirection = this.directionFor(DOWN_MOVEMENT_CODES, UP_MOVEMENT_CODES);
    const manualLength = Math.hypot(horizontalDirection, verticalDirection) || 1;

    if (!this.autoPilotEnabled && this.emergencyAssistState.active) {
      this.playerIntentX = horizontalDirection / manualLength;
      this.playerIntentY = verticalDirection / manualLength;
      this.executeManualAbilityRequests();

      if (this.dashRemaining > 0) {
        this.brainMode = "Emergency evade";
        this.brainDecisionCooldown = 0.02;
        return;
      }
    }

    const manualDashRequested = this.manualDashRequested;
    const manualLowProfileRequested = this.manualLowProfileRequested;
    const manualMissilesRequested = this.manualMissilesRequested;
    const manualCounterflareRequested = this.manualCounterflareRequested;
    const manualGravityKnotRequested = this.manualGravityKnotRequested;
    const manualPhoenixSquadronRequested = this.manualPhoenixSquadronRequested;
    const playerRadius = this.playerPlanningRadius();
    const bounds = this.worldBounds();
    const threats: BrainThreat[] = [];
    const targets: BrainTarget[] = [];
    const pickups: BrainPickup[] = [];
    let nearProjectileCount = 0;
    let nearRocketCount = 0;
    let gravityTargetCount = 0;
    const gravityCandidateX = this.player.position.x;
    const gravityCandidateY = Math.min(WORLD_TOP - 2.5, this.player.position.y + 5.2);
    const hostileTimeScale = this.currentHostileTimeScale();

    for (let index = 0; index < this.enemyProjectiles.length; index += 1) {
      const projectile = this.enemyProjectiles[index];

      if (!projectile) {
        continue;
      }

      threats.push({
        id: `projectile-${index}`,
        kind: projectile.kind === "rocket" ? "rocket" : "projectile",
        position: { x: projectile.mesh.position.x, y: projectile.mesh.position.y },
        velocity: {
          x: projectile.velocityX * hostileTimeScale,
          y: projectile.velocityY * hostileTimeScale,
        },
        radius: projectile.radius,
        motion: projectile.kind === "rocket"
          && projectile.age < ENEMY_PRESSURE_TUNING.rocketHomingSeconds
          ? "homing"
          : "linear",
        homingSecondsRemaining: projectile.kind === "rocket"
          ? Math.max(0, ENEMY_PRESSURE_TUNING.rocketHomingSeconds - projectile.age)
            / hostileTimeScale
          : 0,
        homingStrength: ENEMY_PRESSURE_TUNING.rocketHomingStrength * hostileTimeScale,
      });
      const relativeX = projectile.mesh.position.x - this.player.position.x;
      const relativeY = projectile.mesh.position.y - this.player.position.y;
      const relativeVelocityX = projectile.velocityX * hostileTimeScale - this.playerVelocityX;
      const relativeVelocityY = projectile.velocityY * hostileTimeScale - this.playerVelocityY;
      const relativeSpeedSquared = relativeVelocityX ** 2 + relativeVelocityY ** 2;
      const closingDot = relativeX * relativeVelocityX + relativeY * relativeVelocityY;
      const closestSeconds = relativeSpeedSquared > 0.001
        ? clampNumber(-closingDot / relativeSpeedSquared, 0, 0.7)
        : 0;
      const projectedDistance = Math.hypot(
        relativeX + relativeVelocityX * closestSeconds,
        relativeY + relativeVelocityY * closestSeconds,
      );
      const projectedOverlap = closingDot < 0
        && projectedDistance <= playerRadius + projectile.radius + 1.05;
      if (projectedOverlap) {
        nearProjectileCount += 1;
        if (projectile.kind === "rocket") {
          nearRocketCount += 1;
        }
      }
    }

    for (const enemy of this.enemies) {
      const visible = this.combatTargetVisible(
        enemy.mesh.position.x,
        enemy.mesh.position.y,
        enemy.radius,
        enemy.mesh.visible && enemy.health > 0,
      );
      const target = {
        id: enemy.id,
        position: { x: enemy.mesh.position.x, y: enemy.mesh.position.y },
        velocity: {
          x: enemy.observedVelocityX * hostileTimeScale,
          y: enemy.observedVelocityY * hostileTimeScale,
        },
        radius: enemy.radius,
      };
      threats.push({ ...target, kind: "enemy" });
      targets.push({
        ...target,
        kind: "enemy",
        priority: enemyArchetypeForKind(enemy.kind).targetPriority * (enemy.elite ? 1.2 : 1),
        health: enemy.health,
        damageable: enemy.health > 0,
        visible,
        weaponReachable: visible && this.forwardWeaponCanReach(
          enemy.mesh.position.y,
          enemy.radius,
        ),
        committedDamage: this.committedProjectileDamageForEnemy(enemy.id),
      });
      if (Math.hypot(
        enemy.mesh.position.x - gravityCandidateX,
        enemy.mesh.position.y - gravityCandidateY,
      ) <= 4.6) {
        gravityTargetCount += 1;
      }
    }

    for (const bonus of this.bonuses) {
      pickups.push({
        id: bonus.id,
        kind: bonus.kind,
        position: { x: bonus.mesh.position.x, y: bonus.mesh.position.y },
        velocity: { x: 0, y: bonus.velocityY * this.currentWorldTimeScale() },
        radius: bonus.radius,
        value: this.bonusPickupValue(bonus.kind),
        healthValue: bonus.kind === "pulse" ? (3 - this.lives) * 2.2 : 0,
        safety: clampNumber((bonus.mesh.position.y - WORLD_BOTTOM) / WORLD_HEIGHT + 0.25, 0, 1),
      });
    }

    if (this.boss.active && !this.boss.entering) {
      const bossDamageBudget = this.currentBossDamageBudget();
      const bossVisible = this.combatTargetVisible(
        this.boss.mesh.position.x,
        this.boss.mesh.position.y,
        this.boss.radius,
        this.boss.mesh.visible,
      );
      const movementSpeed = 0.48 + (this.boss.phase - 1) * 0.08;
      const movementTime = this.boss.age * movementSpeed;
      const bossVelocity = {
        x: Math.cos(movementTime) * 6.25 * movementSpeed,
        y: Math.cos(movementTime * 2) * 2.1 * movementSpeed,
      };
      const bossTarget = {
        id: "boss",
        position: { x: this.boss.mesh.position.x, y: this.boss.mesh.position.y },
        velocity: this.boss.observedVelocityX === 0 && this.boss.observedVelocityY === 0
          ? {
              x: bossVelocity.x * hostileTimeScale,
              y: bossVelocity.y * hostileTimeScale,
            }
          : {
              x: this.boss.observedVelocityX * hostileTimeScale,
              y: this.boss.observedVelocityY * hostileTimeScale,
            },
        radius: this.boss.radius,
      };
      threats.push({ ...bossTarget, kind: "boss" });
      targets.push({
        ...bossTarget,
        kind: "boss",
        priority: 6,
        health: Math.min(this.boss.health, bossDamageBudget.damageBudget),
        damageable: bossDamageBudget.damageable,
        visible: bossVisible,
        weaponReachable: bossVisible && this.forwardWeaponCanReach(
          this.boss.mesh.position.y,
          this.boss.radius,
        ),
        committedDamage: this.committedProjectileDamageForBoss(),
      });
    }

    const observation: BrainObservation = {
      player: {
        position: { x: this.player.position.x, y: this.player.position.y },
        velocity: { x: this.playerVelocityX, y: this.playerVelocityY },
        radius: playerRadius,
        maxSpeed: this.currentPlayerCruiseSpeed(),
      },
      bounds,
      terrain: {
        travelDistance: this.caveTravel,
        scrollSpeed: this.difficulty.scrollSpeed * this.currentWorldTimeScale(),
        sector: this.caveDifficultySector,
      },
      threats,
      targets,
      pickups,
      manualIntent: {
        x: horizontalDirection / manualLength,
        y: verticalDirection / manualLength,
      },
      abilities: {
        dashReady: this.dashCooldownRemaining <= 0 && this.dashRemaining <= 0,
        lowProfileReady: this.lowProfileCooldownRemaining <= 0 && this.lowProfileRemaining <= 0,
        lowProfileActive: this.lowProfileRemaining > 0,
        missilesReady: this.missileCooldownRemaining <= 0,
        dashSpeedMultiplier: DASH_SPEED / this.currentPlayerCruiseSpeed(),
        dashDurationSeconds: DASH_TRAVEL_SECONDS,
        lowProfileRadius: LOW_PROFILE_RADIUS,
        dashRequested: this.manualDashRequested,
        lowProfileRequested: this.manualLowProfileRequested,
        missilesRequested: this.manualMissilesRequested,
        specials: {
          states: this.abilityStates,
          manualCounterflareRequested: this.manualCounterflareRequested,
          manualGravityKnotRequested: this.manualGravityKnotRequested,
          manualPhoenixSquadronRequested: this.manualPhoenixSquadronRequested,
          nearProjectileCount,
          nearRocketCount,
          totalProjectileCount: this.enemyProjectiles.length,
          gravityTargetCount,
          bossActive: this.boss.active,
          bossEntering: this.boss.entering,
          bossPhase: this.boss.phase,
          bossHealthRatio: this.boss.active
            ? clampNumber(this.boss.health / Math.max(1, this.boss.maxHealth), 0, 1)
            : 1,
          bossDamageable: this.boss.active
            && !this.boss.entering
            && this.currentBossDamageBudget().damageable,
          escortCount: this.boss.active
            ? this.enemies.filter((enemy) => (
                enemy.bossEscort
                && enemy.age >= 0.85
                && enemy.mesh.position.y <= WORLD_TOP - 0.25
              )).length
            : 0,
          terminalProgress: this.difficulty.terminalProgress,
          stasisActive: this.stasisRemaining > 0,
          dashBurstActive: this.burstRemaining > 0,
        },
      },
    };

    let decision: BrainDecision;
    const emergencyControl = !this.autoPilotEnabled;

    if (emergencyControl) {
      const manualRoute = assessSuperBrainRoute(observation, observation.manualIntent);
      let rescueDecision: BrainDecision | null = null;
      let rescueRoute: BrainRouteAssessment = manualRoute;

      if (
        this.emergencyAssistState.active
        || imminentManualCollision
        || manualRouteNeedsEmergencyAssist(
          manualRoute,
          DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
        )
      ) {
        const rescueObservation = emergencyRescueObservation(observation);
        rescueDecision = this.emergencySuperBrain.decide(rescueObservation);
        rescueRoute = {
          survivalSeconds: rescueDecision.survivalSeconds,
          predictedClearance: rescueDecision.predictedClearance,
          hazardExposure: 0,
          terminalBoundaryClearance: 0,
        };
      }

      this.applyEmergencyAssistTransition(evaluateEmergencyAssist(
        this.emergencyAssistState,
        manualRoute,
        rescueRoute,
        DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
        imminentManualCollision,
      ));

      if (!this.emergencyAssistState.active || !rescueDecision) {
        this.brainSurvivalSeconds = manualRoute.survivalSeconds;
        this.brainClearance = manualRoute.predictedClearance;
        this.brainMode = "Manual control";
        this.brainDecisionCooldown = SUPER_BRAIN_DECISION_INTERVAL_SECONDS;
        return;
      }

      decision = rescueDecision;
    } else {
      decision = this.superBrain.decide(observation);
    }

    this.playerIntentX = decision.movement.x;
    this.playerIntentY = decision.movement.y;
    this.brainSurvivalSeconds = decision.survivalSeconds;
    this.brainClearance = decision.predictedClearance;

    if (emergencyControl) {
      this.brainMode = "Emergency evade";
    } else if (horizontalDirection !== 0 || verticalDirection !== 0) {
      this.brainMode = "Following steer";
    } else if (decision.mode === "dash") {
      this.brainMode = "Dashing";
    } else if (decision.mode === "low-profile" || this.lowProfileRemaining > 0) {
      this.brainMode = "Low-profile";
    } else if (decision.regime === "evade" || (
      decision.survivalSeconds
        < DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds
          - DEFAULT_SUPER_BRAIN_CONFIG.simulationStepSeconds * 0.5
      || decision.predictedClearance < 0.78
    )) {
      this.brainMode = "Dodging";
    } else if (decision.regime === "stabilize") {
      this.brainMode = "Stabilizing";
    } else if (decision.pickupTargetId !== null) {
      this.brainMode = "Collecting crate";
    } else if (targets.length > 0) {
      this.brainMode = "Engaging";
    } else {
      this.brainMode = "Cruising";
    }

    const brainHasSkillAuthority = this.autoPilotEnabled || this.emergencyAssistState.active;

    if (!brainHasSkillAuthority) {
      this.clearManualAbilityRequests();
      this.brainDecisionCooldown = SUPER_BRAIN_DECISION_INTERVAL_SECONDS;
      return;
    }

    const automaticSource: AbilitySource = emergencyControl ? "emergency" : "auto";

    if (decision.useLowProfile) {
      this.tryLowProfile(manualLowProfileRequested ? "manual" : automaticSource);
    }

    if (decision.useDash) {
      this.tryDash(
        decision.movement.x,
        decision.movement.y,
        manualDashRequested ? "manual" : automaticSource,
      );
    } else if (manualDashRequested) {
      this.announcement = "Dash held · no safe vector";
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.75);
      this.publishSnapshot(true);
    }

    if (decision.useMissiles || (manualMissilesRequested && this.missileCooldownRemaining <= 0)) {
      this.tryMissiles(manualMissilesRequested ? "manual" : automaticSource);
    }

    if (decision.useCounterflare) {
      this.trySpecialAbility("counterflare", manualCounterflareRequested ? "manual" : automaticSource);
    }

    if (decision.useGravityKnot) {
      this.trySpecialAbility("gravity-knot", manualGravityKnotRequested ? "manual" : automaticSource);
    }

    if (decision.usePhoenixSquadron) {
      this.trySpecialAbility("phoenix-squadron", manualPhoenixSquadronRequested ? "manual" : automaticSource);
    }

    if (manualLowProfileRequested && !decision.useLowProfile) {
      this.announcement = "Sub-level held · route already safe";
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.7);
      this.publishSnapshot(true);
    }

    this.clearManualAbilityRequests();
    this.brainDecisionCooldown = SUPER_BRAIN_DECISION_INTERVAL_SECONDS;
  }

  private attachmentActive(kind: AdvancedAttachmentKind): boolean {
    return this.advancedAttachmentRemaining[kind] > 0;
  }

  private activateAdvancedAttachment(kind: AdvancedAttachmentKind): void {
    const wasActive = this.attachmentActive(kind);
    this.advancedAttachmentRemaining[kind] = Math.max(
      this.advancedAttachmentRemaining[kind],
      bonusDurationSeconds(kind),
    );

    if (kind === "nanorepair" && !wasActive) {
      this.nanorepairKillsRemaining = NANOREPAIR_MAX_CHARGED_KILLS;
      this.nanorepairCharge = 0;
    }
  }

  private currentPlayerRadius(): number {
    const baseRadius = this.lowProfileRemaining > 0 ? LOW_PROFILE_RADIUS : PLAYER_RADIUS;
    return phaseHullCollisionRadius(baseRadius, this.attachmentActive("phase-hull"));
  }

  private playerPlanningRadius(): number {
    // Low profile lasts less than the prediction horizon, so planning with
    // the normal silhouette is conservative after it expires mid-route.
    // Phase hull receives a real route-planning benefit only while it is
    // guaranteed to outlive the full prediction horizon. The extra 0.29-unit
    // buffer remains more conservative than its 0.429-unit physical profile.
    return this.advancedAttachmentRemaining["phase-hull"]
      >= DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds
      ? Math.max(this.currentPlayerRadius(), 0.72)
      : Math.max(PLAYER_RADIUS, 1.2);
  }

  private playerBounds(radius: number): { left: number; right: number; bottom: number; top: number } {
    const horizontalMargin = Math.max(radius, 1.2 * this.player.scale.x);
    const verticalMargin = Math.max(radius, 1.42 * this.player.scale.y);

    return {
      left: Math.max(WORLD_LEFT + horizontalMargin, this.camera.left + horizontalMargin),
      right: Math.min(WORLD_RIGHT - horizontalMargin, this.camera.right - horizontalMargin),
      bottom: WORLD_BOTTOM + verticalMargin,
      top: WORLD_TOP - verticalMargin,
    };
  }

  private worldBounds(): { left: number; right: number; bottom: number; top: number } {
    return {
      left: Math.max(WORLD_LEFT, this.camera.left),
      right: Math.min(WORLD_RIGHT, this.camera.right),
      bottom: WORLD_BOTTOM,
      top: WORLD_TOP,
    };
  }

  private tryDash(directionX: number, directionY: number, source: AbilitySource = "auto"): boolean {
    if (this.dashCooldownRemaining > 0 || this.dashRemaining > 0) {
      return false;
    }

    const directionLength = Math.hypot(directionX, directionY);
    this.dashDirectionX = directionLength > 0.001 ? directionX / directionLength : 0;
    this.dashDirectionY = directionLength > 0.001 ? directionY / directionLength : 1;
    this.dashRemaining = DASH_TRAVEL_SECONDS;
    this.dashEffectRemaining = DASH_EFFECT_SECONDS;
    this.dashCooldownRemaining = DASH_COOLDOWN_SECONDS;
    this.dashRollProgress = 0;
    this.dashRollDirection = Math.abs(this.dashDirectionX) > 0.08
      ? (this.dashDirectionX < 0 ? 1 : -1)
      : (this.flightMotion.bank >= 0 ? 1 : -1);
    this.announcement = source === "manual"
      ? "Manual command · dash linked"
      : source === "emergency"
        ? "Emergency assist · dash"
        : "Auto evade · dash";
    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.55);
    return true;
  }

  private tryLowProfile(source: AbilitySource = "auto"): boolean {
    if (this.lowProfileCooldownRemaining > 0 || this.lowProfileRemaining > 0) {
      return false;
    }

    this.lowProfileRemaining = LOW_PROFILE_SECONDS;
    this.lowProfileTimeWarpRemaining = LOW_PROFILE_TIME_WARP_SECONDS;
    this.lowProfileCooldownRemaining = LOW_PROFILE_COOLDOWN_SECONDS;
    this.lowProfileBossLaserHitAvailable = true;
    this.laserDamageCooldown = 0;
    this.announcement = source === "manual"
      ? "Manual command · sub-level laser + time warp"
      : source === "emergency"
        ? "Emergency assist · sub-level laser + time warp"
        : "Auto evade · sub-level laser + time warp";
    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.65);
    return true;
  }

  private tryMissiles(source: AbilitySource = "auto"): boolean {
    if (this.missileCooldownRemaining > 0) {
      return false;
    }

    if (this.firePlayerMissileSalvo()) {
      this.missileCooldownRemaining = MISSILE_COOLDOWN_SECONDS;
      const salvoLabel = this.attachmentActive("missile-rack") ? "eight heavy missiles" : "four missiles";
      this.announcement = source === "manual"
        ? `Manual command · ${salvoLabel}`
        : source === "crate"
          ? `Missile crate · ${salvoLabel}`
          : source === "emergency"
            ? `Emergency assist · ${salvoLabel}`
            : `Auto attack · ${salvoLabel}`;
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.65);
      return true;
    }

    if (source === "manual") {
      this.announcement = "Missiles holding · no target lock";
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.7);
      this.publishSnapshot(true);
    }

    return false;
  }

  private setAbilityState(kind: JetAbilityKind, state: JetAbilityState): void {
    this.abilityStates = { ...this.abilityStates, [kind]: state };
  }

  private trySpecialAbility(kind: JetAbilityKind, source: AbilitySource = "auto"): boolean {
    const current = this.abilityStates[kind];

    if (!jetAbilityReady(current)) {
      return false;
    }

    this.setAbilityState(kind, activateJetAbility(kind, current));
    const manualPrefix = source === "manual"
      ? "Manual command"
      : source === "emergency"
        ? "Emergency assist"
        : "Super Brain";

    if (kind === "counterflare") {
      this.counterflareConversionsRemaining = 12;
      this.counterflareVisual.group.position.set(this.player.position.x, this.player.position.y, 2.18);
      this.announcement = `${manualPrefix} · Counterflare parry`;
      this.screenShakeRemaining = this.reducedMotion ? 0 : Math.max(this.screenShakeRemaining, 0.08);
    } else if (kind === "gravity-knot") {
      this.gravityKnotX = this.player.position.x;
      this.gravityKnotY = Math.min(WORLD_TOP - 2.5, this.player.position.y + 5.2);
      this.gravityKnotVisual.group.position.set(this.gravityKnotX, this.gravityKnotY, 1.82);
      this.announcement = `${manualPrefix} · Gravity Knot anchored`;
      this.screenShakeRemaining = this.reducedMotion ? 0 : Math.max(this.screenShakeRemaining, 0.12);
    } else {
      this.phoenixStrikeCooldown = 0;
      this.phoenixStrikeIndex = 0;
      this.announcement = `${manualPrefix} · Phoenix Squadron inbound`;
      this.screenShakeRemaining = this.reducedMotion ? 0 : Math.max(this.screenShakeRemaining, 0.22);
    }

    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, kind === "phoenix-squadron" ? 1.5 : 0.9);
    this.publishSnapshot(true);
    return true;
  }

  private tickSpecialAbilityTimers(deltaSeconds: number): void {
    this.abilityStates = {
      counterflare: tickJetAbilityState(this.abilityStates.counterflare, deltaSeconds),
      "gravity-knot": tickJetAbilityState(this.abilityStates["gravity-knot"], deltaSeconds),
      "phoenix-squadron": tickJetAbilityState(this.abilityStates["phoenix-squadron"], deltaSeconds),
    };
  }

  private updateSpecialAbilityEffects(deltaSeconds: number): void {
    const counterSeconds = this.abilityStates.counterflare.activeSeconds;
    const counterRatio = counterSeconds / JET_ABILITY_SPECS.counterflare.activeSeconds;
    this.counterflareVisual.group.visible = counterSeconds > 0;
    this.counterflareVisual.group.position.set(this.player.position.x, this.player.position.y, 2.18);
    this.counterflareVisual.primaryMaterial.opacity = counterSeconds > 0 ? 0.48 + counterRatio * 0.34 : 0;
    this.counterflareVisual.secondaryMaterial.opacity = counterSeconds > 0 ? 0.34 + counterRatio * 0.4 : 0;
    for (let index = 0; index < this.counterflareVisual.rings.length; index += 1) {
      const ring = this.counterflareVisual.rings[index];
      if (!ring) continue;
      ring.rotation.z += deltaSeconds * (index % 2 === 0 ? 4.8 : -3.9);
      ring.scale.setScalar((1.45 + index * 0.72) * (1.25 - counterRatio * 0.2));
    }
    for (let index = 0; index < this.counterflareVisual.particles.length; index += 1) {
      const particle = this.counterflareVisual.particles[index];
      if (!particle) continue;
      const angle = index / this.counterflareVisual.particles.length * Math.PI * 2 + this.runElapsed * 3.8;
      const radius = 1.3 + (1 - counterRatio) * 3.8;
      particle.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.08);
      particle.rotation.z = angle;
    }

    const gravitySeconds = this.abilityStates["gravity-knot"].activeSeconds;
    const gravityRatio = gravitySeconds / JET_ABILITY_SPECS["gravity-knot"].activeSeconds;
    this.gravityKnotVisual.group.visible = gravitySeconds > 0;
    this.gravityKnotVisual.primaryMaterial.opacity = gravitySeconds > 0 ? 0.44 + gravityRatio * 0.28 : 0;
    this.gravityKnotVisual.secondaryMaterial.opacity = gravitySeconds > 0 ? 0.32 + gravityRatio * 0.3 : 0;
    for (let index = 0; index < this.gravityKnotVisual.rings.length; index += 1) {
      const ring = this.gravityKnotVisual.rings[index];
      if (!ring) continue;
      ring.rotation.z += deltaSeconds * (index % 2 === 0 ? 1.9 : -2.6);
      const pulse = this.reducedMotion ? 1 : 1 + Math.sin(this.runElapsed * 7 + index) * 0.09;
      ring.scale.setScalar((2.05 + index * 0.86) * pulse);
    }
    for (let index = 0; index < this.gravityKnotVisual.particles.length; index += 1) {
      const particle = this.gravityKnotVisual.particles[index];
      if (!particle) continue;
      const angle = index / this.gravityKnotVisual.particles.length * Math.PI * 2 - this.runElapsed * (1.7 + index % 3 * 0.3);
      const radius = 1.05 + index % 4 * 0.7;
      particle.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.72, 0.08);
      particle.rotation.z = angle + Math.PI / 2;
    }

    const phoenixActive = this.abilityStates["phoenix-squadron"].activeSeconds > 0;
    if (phoenixActive) {
      this.phoenixStrikeCooldown -= deltaSeconds;
      while (this.phoenixStrikeCooldown <= 0 && this.phoenixStrikeIndex < 8) {
        this.launchPhoenixStrike();
        this.phoenixStrikeCooldown += 0.68;
      }
    }

    for (const wing of this.phoenixWings) {
      if (!wing.group.visible) continue;
      wing.age += deltaSeconds;
      wing.group.position.y = WORLD_BOTTOM - 2.5 + wing.age * 33;
      wing.group.position.x = wing.laneX + Math.sin(wing.age * 7) * 0.18;
      wing.group.rotation.z = Math.sin(wing.age * 8) * 0.05;
      wing.trailMaterial.opacity = Math.max(0, 0.42 * (1 - wing.age / 1.18));
      if (wing.age >= 1.18) {
        wing.group.visible = false;
      }
    }

  }

  private updateAutoCombatSystems(): void {
    if (!this.autoPilotEnabled) {
      return;
    }

    const bombAmplified = this.attachmentActive("bomb-amplifier");
    const bombPayload = amplifiedBombPayload(
      remoteBombDamage(NORMAL_CANNON_DAMAGE),
      REMOTE_BOMB_BLAST_RADIUS,
      bombAmplified,
    );
    const blastX = this.remoteBombVisual.group.position.x;
    const blastY = this.remoteBombVisual.group.position.y;
    const insideCurrentBlast = (x: number, y: number, radius: number): boolean => (
      this.remoteBombActive
      && Math.hypot(x - blastX, y - blastY) <= bombPayload.radius + Math.max(0, radius)
    );
    const bombEnemyTargetsInBlast = this.enemies.reduce((count, enemy) => (
      count + Number(
        enemy.health > 0
        && insideCurrentBlast(enemy.mesh.position.x, enemy.mesh.position.y, enemy.radius)
      )
    ), 0);
    const bossDamageable = this.boss.active
      && !this.boss.entering
      && this.currentBossDamageBudget().damageable;
    const bombBossInBlast = bossDamageable && insideCurrentBlast(
      this.boss.mesh.position.x,
      this.boss.mesh.position.y,
      this.boss.radius,
    );
    let nearbyProjectileCount = 0;
    let nearbyRocketCount = 0;

    for (const projectile of this.enemyProjectiles) {
      const nearby = Math.hypot(
        projectile.mesh.position.x - this.player.position.x,
        projectile.mesh.position.y - this.player.position.y,
      ) <= GUARDIAN_WING_COUNTERMEASURE_RADIUS
        + projectile.radius
        + this.currentPlayerRadius();
      if (!nearby) continue;
      if (projectile.kind === "rocket") {
        nearbyRocketCount += 1;
      } else {
        nearbyProjectileCount += 1;
      }
    }

    const decision = decideAutoCombatSystems({
      remoteBombReady: this.remoteBombCooldownRemaining <= 0,
      remoteBombActive: this.remoteBombActive,
      remoteBombAgeSeconds: this.remoteBombAge,
      bombEnemyTargetsInBlast,
      bombBossInBlast,
      availableEnemyTargets: this.enemies.reduce(
        (count, enemy) => count + Number(enemy.health > 0 && enemy.mesh.visible),
        0,
      ),
      bossActive: this.boss.active,
      guardianWingReady: this.guardianWingCooldownRemaining <= 0,
      guardianWingActive: this.guardianWingRemaining > 0,
      nearbyProjectileCount,
      nearbyRocketCount,
    });

    if (decision.detonateRemoteBomb) {
      this.detonateRemoteBomb("automatic");
    } else if (decision.launchRemoteBomb) {
      this.launchRemoteBomb("automatic");
    }

    if (decision.deployGuardianWing) {
      this.requestGuardianWing();
    }
  }

  private launchRemoteBomb(source: "manual" | "automatic" = "manual"): void {
    this.remoteBombActive = true;
    this.remoteBombAge = 0;
    this.remoteBombTargetY = Math.min(
      WORLD_TOP - 1.6,
      this.player.position.y + REMOTE_BOMB_FORWARD_DISTANCE,
    );
    this.remoteBombVisual.group.position.set(
      this.player.position.x,
      this.player.position.y + 0.8,
      2.3,
    );
    this.remoteBombVisual.group.rotation.set(0, 0, 0);
    this.remoteBombVisual.group.visible = true;
    this.announcement = source === "automatic"
      ? "Auto combat · remote bomb launched"
      : `Remote bomb launched · press ${JET_FLIGHT_SYSTEM_KEYS["remote-bomb"]} to detonate`;
    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 1);
    this.publishSnapshot(true);
  }

  private updateRemoteBomb(deltaSeconds: number): void {
    if (!this.remoteBombActive) {
      this.remoteBombVisual.group.visible = false;
      return;
    }

    this.remoteBombAge += deltaSeconds;
    const distanceRemaining = this.remoteBombTargetY - this.remoteBombVisual.group.position.y;
    if (distanceRemaining > 0) {
      this.remoteBombVisual.group.position.y += Math.min(
        distanceRemaining,
        REMOTE_BOMB_LAUNCH_SPEED * deltaSeconds,
      );
    }
    this.remoteBombVisual.group.rotation.z += deltaSeconds * 4.8;
    this.remoteBombVisual.group.rotation.x += deltaSeconds * 2.2;
    const pulse = this.reducedMotion ? 1 : 1 + Math.sin(this.runElapsed * 12) * 0.12;
    this.remoteBombVisual.group.scale.setScalar(pulse);
    this.remoteBombVisual.coreMaterial.opacity = 0.84 + pulse * 0.1;
    this.remoteBombVisual.ringMaterial.opacity = 0.52 + pulse * 0.18;
    for (let index = 0; index < this.remoteBombVisual.rings.length; index += 1) {
      const ring = this.remoteBombVisual.rings[index];
      if (ring) ring.rotation.z += deltaSeconds * (index === 0 ? 3.6 : -4.2);
    }

    if (this.remoteBombAge >= REMOTE_BOMB_MAX_ARMED_SECONDS) {
      this.detonateRemoteBomb("automatic");
    }
  }

  private detonateRemoteBomb(source: "manual" | "automatic"): void {
    if (!this.remoteBombActive) {
      return;
    }

    const blastX = this.remoteBombVisual.group.position.x;
    const blastY = this.remoteBombVisual.group.position.y;
    const bombAmplified = this.attachmentActive("bomb-amplifier");
    const payload = amplifiedBombPayload(
      remoteBombDamage(NORMAL_CANNON_DAMAGE),
      REMOTE_BOMB_BLAST_RADIUS,
      bombAmplified,
    );
    const insideBlast = (targetX: number, targetY: number, targetRadius = 0): boolean => (
      Math.hypot(targetX - blastX, targetY - blastY) <= payload.radius + Math.max(0, targetRadius)
    );
    this.remoteBombActive = false;
    this.remoteBombAge = 0;
    this.remoteBombCooldownRemaining = REMOTE_BOMB_COOLDOWN_SECONDS;
    this.remoteBombVisual.group.visible = false;

    for (let index = this.enemyProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.enemyProjectiles[index];
      if (!projectile || !insideBlast(
        projectile.mesh.position.x,
        projectile.mesh.position.y,
        projectile.radius,
      )) {
        continue;
      }
      const impactX = projectile.mesh.position.x;
      const impactY = projectile.mesh.position.y;
      this.releaseEnemyProjectile(index);
      if (index % 3 === 0) {
        this.spawnImpact(impactX, impactY, ARCADE_PALETTE.telegraphOrange, 0.5);
      }
    }

    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy || !insideBlast(
        enemy.mesh.position.x,
        enemy.mesh.position.y,
        enemy.radius,
      )) {
        continue;
      }
      enemy.health -= payload.damage;
      this.spawnImpact(enemy.mesh.position.x, enemy.mesh.position.y, PLAYER_YELLOW, 0.9);
      if (enemy.health <= 0) {
        this.destroyEnemy(index);
      }
    }

    if (
      this.boss.active
      && !this.boss.entering
      && insideBlast(
        this.boss.mesh.position.x,
        this.boss.mesh.position.y,
        this.boss.radius,
      )
    ) {
      this.damageBoss(payload.damage, this.boss.mesh.position.x, this.boss.mesh.position.y);
    }

    this.spawnImpactBurst(
      blastX,
      blastY,
      ARCADE_PALETTE.telegraphOrange,
      1.45,
      8,
      payload.radius * 0.65,
    );
    this.spawnImpactBurst(
      blastX,
      blastY,
      ARCADE_PALETTE.ivory,
      1.15,
      8,
      payload.radius * 0.44,
    );
    this.spawnImpact(
      blastX,
      blastY,
      ARCADE_PALETTE.dangerCrimson,
      payload.radius * 0.56,
    );
    this.screenShakeRemaining = this.reducedMotion ? 0 : Math.max(this.screenShakeRemaining, 0.24);
    this.announcement = source === "manual"
      ? `Remote bomb detonated · ${REMOTE_BOMB_DAMAGE_MULTIPLIER * (bombAmplified ? 2 : 1)}× blast`
      : `Remote bomb auto-detonated · ${REMOTE_BOMB_DAMAGE_MULTIPLIER * (bombAmplified ? 2 : 1)}× blast`;
    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 1.1);
    this.publishSnapshot(true);
  }

  private deactivateRemoteBomb(): void {
    this.remoteBombActive = false;
    this.remoteBombAge = 0;
    this.remoteBombVisual.group.visible = false;
    this.remoteBombVisual.group.scale.setScalar(1);
  }

  private updateGuardianWingmen(deltaSeconds: number, hostileTimeScale: number): void {
    const active = this.guardianWingRemaining > 0;
    const playerFireInterval = playerCannonFireInterval({
      rapid: this.rapidFireRemaining > 0,
      overdrive: this.overdriveRemaining > 0,
      burst: this.burstRemaining > 0,
    });
    for (const wing of this.guardianWingmen) {
      wing.group.visible = active;
      if (!active) {
        wing.countermeasureMaterial.opacity = 0;
        continue;
      }

      wing.countermeasureCooldown = Math.max(0, wing.countermeasureCooldown - deltaSeconds);
      wing.pulseSeconds = Math.max(0, wing.pulseSeconds - deltaSeconds);
      const target = this.guardianWingTarget(wing);
      const desiredX = target.x;
      const desiredY = target.y;
      wing.group.position.x += (desiredX - wing.group.position.x) * Math.min(1, deltaSeconds * 14);
      wing.group.position.y += (desiredY - wing.group.position.y) * Math.min(1, deltaSeconds * 14);
      wing.group.position.z = 2.2;
      wing.group.rotation.z = (desiredX - wing.group.position.x) * -0.08;
      const pulseRatio = wing.pulseSeconds / 0.32;
      wing.countermeasureMaterial.opacity = pulseRatio > 0 ? pulseRatio * 0.82 : 0;
      wing.countermeasureRing.scale.setScalar(1.2 + (1 - pulseRatio) * 2.8);
      wing.countermeasureRing.rotation.z += deltaSeconds * wing.side * 4.2;

      const cadence = stepGuardianWingCadence({
        accumulatedShots: wing.logicalShotsAccumulated,
        tracerCooldownSeconds: wing.offensiveFireCooldown,
      }, deltaSeconds, playerFireInterval);
      wing.logicalShotsAccumulated = cadence.accumulatedShots;
      wing.offensiveFireCooldown = cadence.tracerCooldownSeconds;
      if (cadence.logicalShots > 0) {
        this.fireGuardianWingProjectile(wing, cadence.logicalShots);
      }
    }

    if (!active || this.enemyProjectiles.length === 0) {
      return;
    }

    const assignments = selectWingmanCountermeasures({
      protectedCraft: [
        {
          id: 0,
          x: this.player.position.x,
          y: this.player.position.y,
          velocityX: this.playerVelocityX,
          velocityY: this.playerVelocityY,
          radius: this.currentPlayerRadius(),
        },
        ...this.guardianWingmen.map((wing) => ({
          id: wing.id,
          x: wing.group.position.x,
          y: wing.group.position.y,
          velocityX: this.playerVelocityX,
          velocityY: this.playerVelocityY,
          radius: 0.58,
        })),
      ],
      wings: this.guardianWingmen.map((wing) => ({
        id: wing.id,
        x: wing.group.position.x,
        y: wing.group.position.y,
        ready: wing.countermeasureCooldown <= 0,
      })),
      projectiles: this.enemyProjectiles.map((projectile, index) => ({
        id: index,
        x: projectile.mesh.position.x,
        y: projectile.mesh.position.y,
        velocityX: projectile.velocityX * hostileTimeScale,
        velocityY: projectile.velocityY * hostileTimeScale,
        radius: projectile.radius,
        rocket: projectile.kind === "rocket",
      })),
      responseRadius: GUARDIAN_WING_COUNTERMEASURE_RADIUS,
      collisionHorizonSeconds: GUARDIAN_WING_COLLISION_HORIZON_SECONDS,
    });

    for (const assignment of [...assignments].sort((first, second) => second.projectileId - first.projectileId)) {
      const projectile = this.enemyProjectiles[assignment.projectileId];
      const wing = this.guardianWingmen.find((candidate) => candidate.id === assignment.wingId);
      if (!projectile || !wing) {
        continue;
      }
      const impactX = projectile.mesh.position.x;
      const impactY = projectile.mesh.position.y;
      this.releaseEnemyProjectile(assignment.projectileId);
      wing.countermeasureCooldown = GUARDIAN_WING_COUNTERMEASURE_INTERVAL_SECONDS;
      wing.pulseSeconds = 0.32;
      this.spawnCounterfire(impactX, impactY, assignment.projectileId + wing.id);
      this.spawnImpact(impactX, impactY, ARCADE_PALETTE.counterMint, 0.72);
    }
  }

  private fireGuardianWingProjectile(
    wing: GuardianWingVisual,
    logicalShots = 1,
  ): boolean {
    if (this.playerProjectiles.length >= 84) {
      return false;
    }

    const origin = {
      x: wing.group.position.x,
      y: wing.group.position.y + 0.54,
    };
    const aimTargets: PlayerAimTarget[] = this.enemies.map((enemy) => ({
      id: enemy.id,
      kind: "enemy",
      position: { x: enemy.mesh.position.x, y: enemy.mesh.position.y },
      velocity: { x: enemy.observedVelocityX, y: enemy.observedVelocityY },
      radius: enemy.radius,
      priority: enemyArchetypeForKind(enemy.kind).targetPriority * (enemy.elite ? 1.2 : 1),
      damageable: true,
      visible: enemy.mesh.visible
        && enemy.health > 0
        && enemy.mesh.position.x + enemy.radius >= this.camera.left
        && enemy.mesh.position.x - enemy.radius <= this.camera.right
        && enemy.mesh.position.y + enemy.radius >= this.camera.bottom
        && enemy.mesh.position.y - enemy.radius <= this.camera.top,
    }));

    if (this.boss.active && !this.boss.entering && this.boss.mesh.visible) {
      const damageBudget = this.currentBossDamageBudget();
      aimTargets.push({
        id: "boss",
        kind: "boss",
        position: { x: this.boss.mesh.position.x, y: this.boss.mesh.position.y },
        velocity: { x: this.boss.observedVelocityX, y: this.boss.observedVelocityY },
        radius: this.boss.radius,
        priority: 10,
        damageable: damageBudget.damageable,
        visible: this.boss.mesh.position.x + this.boss.radius >= this.camera.left
          && this.boss.mesh.position.x - this.boss.radius <= this.camera.right
          && this.boss.mesh.position.y + this.boss.radius >= this.camera.bottom
          && this.boss.mesh.position.y - this.boss.radius <= this.camera.top,
      });
    }

    const aim = selectPlayerCannonAim({
      origin,
      projectileSpeed: GUARDIAN_WING_PROJECTILE_SPEED,
      targets: aimTargets,
      targetTimeScale: this.currentHostileTimeScale(),
    });
    if (aim.targetKind === null) {
      return false;
    }

    const projectile = this.checkoutProjectile("player");
    projectile.mesh.position.set(origin.x, origin.y, 1.96);
    projectile.velocityX = Math.sin(aim.angleRadians) * GUARDIAN_WING_PROJECTILE_SPEED;
    projectile.velocityY = Math.cos(aim.angleRadians) * GUARDIAN_WING_PROJECTILE_SPEED;
    projectile.velocityZ = 0;
    projectile.radius = 0.18;
    projectile.age = 0;
    projectile.speed = GUARDIAN_WING_PROJECTILE_SPEED;
    projectile.previousX = origin.x;
    projectile.previousY = origin.y;
    const packetShots = Math.max(1, Math.floor(logicalShots));
    projectile.damage = GUARDIAN_WING_PROJECTILE_DAMAGE * packetShots;
    projectile.targetId = aim.targetKind === "enemy" && typeof aim.targetId === "number"
      ? aim.targetId
      : null;
    projectile.targetBoss = aim.targetKind === "boss";
    this.orientProjectileToVelocity(projectile);
    const packetScale = 1 + Math.log2(packetShots) * 0.16;
    this.scaleCometVisual(
      projectile,
      1.12 * packetScale,
      0.9 * packetScale,
      1.2 + Math.min(0.8, packetShots * 0.05),
    );
    projectile.mesh.visible = true;
    this.playerProjectiles.push(projectile);
    this.scene.add(projectile.mesh);
    return true;
  }

  private guardianWingTarget(wing: GuardianWingVisual): { x: number; y: number } {
    const desiredY = clampNumber(
      this.player.position.y - 0.28 + Math.sin(this.runElapsed * 5 + wing.id * Math.PI) * 0.16,
      WORLD_BOTTOM + 0.8,
      WORLD_TOP - 0.8,
    );
    const cave = sampleCaveCorridor(this.caveTravel, desiredY, this.caveDifficultySector);
    const visualRadius = 0.58;
    return {
      x: clampNumber(
        this.player.position.x + wing.side * 1.8,
        Math.max(WORLD_LEFT + visualRadius, cave.safeLeft + visualRadius),
        Math.min(WORLD_RIGHT - visualRadius, cave.safeRight - visualRadius),
      ),
      y: desiredY,
    };
  }

  private deactivateGuardianWingmen(): void {
    this.guardianWingRemaining = 0;
    for (const wing of this.guardianWingmen) {
      wing.group.visible = false;
      wing.countermeasureMaterial.opacity = 0;
      wing.offensiveFireCooldown = initialGuardianWingFireCooldown(wing.id - 1);
      wing.logicalShotsAccumulated = 0;
      wing.pulseSeconds = 0;
    }
  }

  private launchPhoenixStrike(): void {
    const enemyTargets = [...this.enemies].sort((first, second) => (
      second.health - first.health || second.mesh.position.y - first.mesh.position.y || first.id - second.id
    ));
    const primaryEnemy = enemyTargets[this.phoenixStrikeIndex % Math.max(1, enemyTargets.length)];
    const rawLaneX = this.boss.active && this.phoenixStrikeIndex % 2 === 0
      ? this.boss.mesh.position.x
      : primaryEnemy?.mesh.position.x ?? (
          this.player.position.x + (this.phoenixStrikeIndex % 3 - 1) * 3.2
        );
    const laneX = clampNumber(rawLaneX, WORLD_LEFT + 1.2, WORLD_RIGHT - 1.2);
    const wing = this.phoenixWings[this.phoenixStrikeIndex % this.phoenixWings.length];
    this.phoenixStrikeIndex += 1;

    if (wing) {
      wing.age = 0;
      wing.laneX = laneX;
      wing.group.position.set(laneX, WORLD_BOTTOM - 2.5, 2.26);
      wing.group.visible = true;
      wing.trailMaterial.opacity = 0.42;
    }

    for (let index = this.enemyProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.enemyProjectiles[index];
      if (!projectile || Math.abs(projectile.mesh.position.x - laneX) > 1.8) continue;
      const impactX = projectile.mesh.position.x;
      const impactY = projectile.mesh.position.y;
      this.releaseEnemyProjectile(index);
      if (index % 3 === 0) {
        this.spawnImpact(impactX, impactY, ARCADE_PALETTE.playerMagenta, 0.5);
      }
    }

    const enemyDamage = Math.max(12, this.difficulty.enemyHealthScale * 5);
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy || Math.abs(enemy.mesh.position.x - laneX) > enemy.radius + 1.55) continue;
      if (
        this.boss.active
        && enemy.bossEscort
        && (enemy.age < 1.1 || enemy.mesh.position.y > WORLD_TOP - 0.5)
      ) {
        continue;
      }
      enemy.health -= enemyDamage;
      this.spawnImpact(enemy.mesh.position.x, enemy.mesh.position.y, ARCADE_PALETTE.playerYellow, 0.85);
      if (enemy.health <= 0) {
        this.destroyEnemy(index);
      }
    }

    if (
      this.boss.active
      && !this.boss.entering
      && this.currentBossDamageBudget().damageable
      && Math.abs(this.boss.mesh.position.x - laneX) <= this.boss.radius + 1.55
    ) {
      const bossDamage = 10 + this.boss.maxHealth * 0.025;
      // damageBoss is the single boss damage path and retains both escort gates.
      this.damageBoss(bossDamage, laneX, this.boss.mesh.position.y);
    }

    for (let index = 0; index < 5; index += 1) {
      this.spawnImpact(
        laneX,
        WORLD_BOTTOM + 3 + index * 6,
        index % 2 === 0 ? ARCADE_PALETTE.playerMagenta : ARCADE_PALETTE.ivory,
        0.75 + index * 0.06,
      );
    }
    this.screenShakeRemaining = this.reducedMotion ? 0 : Math.max(this.screenShakeRemaining, 0.055);
  }

  private updatePlayer(deltaSeconds: number): void {
    this.previousPlayerX = this.player.position.x;
    this.previousPlayerY = this.player.position.y;
    const previousVelocityX = this.playerVelocityX;
    const previousVelocityY = this.playerVelocityY;
    const dashWasActive = this.dashRemaining > 0;
    const horizontalVelocity = dashWasActive ? this.dashDirectionX : this.playerIntentX;
    const verticalVelocity = dashWasActive ? this.dashDirectionY : this.playerIntentY;
    const cruiseSpeed = this.currentPlayerCruiseSpeed();
    // A dash may end partway through the fixed physics tick. Integrate only
    // that exact fraction at 4×, then finish the tick at cruise speed along
    // the same route. This matches Super Brain's piecewise sweep and removes
    // the old one-tick wall overrun at the end of every dash.
    const dashTravelSeconds = dashWasActive
      ? Math.min(deltaSeconds, this.dashRemaining)
      : 0;
    const movementDistance = dashWasActive
      ? DASH_SPEED * dashTravelSeconds + cruiseSpeed * (deltaSeconds - dashTravelSeconds)
      : cruiseSpeed * deltaSeconds;
    const movementSpeed = movementDistance / Math.max(deltaSeconds, Number.EPSILON);
    const playerRadius = this.currentPlayerRadius();
    const bounds = this.playerBounds(playerRadius);
    const proposedY = clampNumber(
      this.player.position.y + verticalVelocity * movementDistance,
      bounds.bottom,
      bounds.top,
    );

    this.playerX = clampNumber(
      this.playerX + horizontalVelocity * movementDistance,
      bounds.left,
      bounds.right,
    );
    const playerY = clampNumber(proposedY, bounds.bottom, bounds.top);
    this.player.position.set(this.playerX, playerY, 2);
    this.playerVelocityX = (this.player.position.x - this.previousPlayerX) / deltaSeconds;
    this.playerVelocityY = (this.player.position.y - this.previousPlayerY) / deltaSeconds;
    const manualInfluence = this.pressedKeys.size > 0
      ? 1
      : clampNumber(this.recentHumanInputSeconds / PILOT_LINE_INPUT_GRACE_SECONDS * 0.55, 0, 0.55);
    this.flightMotion = stepFlightMotion(this.flightMotion, {
      velocityX: this.playerVelocityX,
      velocityY: this.playerVelocityY,
      accelerationX: (this.playerVelocityX - previousVelocityX) / deltaSeconds,
      accelerationY: (this.playerVelocityY - previousVelocityY) / deltaSeconds,
      maximumSpeed: movementSpeed,
      manualInfluence,
      dashActive: dashWasActive,
      reducedMotion: this.reducedMotion,
    }, deltaSeconds);
    const barrelRollWasActive = this.dashRollProgress < 1;
    if (barrelRollWasActive) {
      this.dashRollProgress = Math.min(
        1,
        this.dashRollProgress + deltaSeconds / DASH_BARREL_ROLL_SECONDS,
      );
    }
    const barrelRoll = barrelRollWasActive
      ? dashBarrelRollAngle(
          this.dashRollProgress,
          this.dashRollDirection,
          this.reducedMotion,
        )
      : 0;
    const flightRig = this.player.userData.flightRig as THREE.Group;
    flightRig.rotation.set(
      this.flightMotion.pitch,
      this.flightMotion.bank + barrelRoll,
      this.flightMotion.yaw,
      "YXZ",
    );
    flightRig.position.z = Math.abs(this.flightMotion.bank) * 0.11;
    this.player.visible = this.invulnerabilityRemaining <= 0 || Math.floor(this.runElapsed * 18) % 2 === 0;

    if (dashWasActive) {
      this.dashRemaining = Math.max(0, this.dashRemaining - deltaSeconds);

      if (this.dashRemaining <= 0) {
        this.burstRemaining = BURST_SECONDS;
        this.playerFireCooldown = Math.min(this.playerFireCooldown, 0);
        this.announcement = "Burst 10x";
        this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.75);
      }
    }

    this.updateDashTrail();

    const targetScale = this.lowProfileRemaining > 0 ? LOW_PROFILE_SCALE : 1;
    const currentScale = this.player.scale.x;
    const visualScale = currentScale + (targetScale - currentScale) * Math.min(1, deltaSeconds * 18);
    this.player.scale.setScalar(visualScale);

    this.updatePlayerModeVisuals(dashWasActive);

    const shield = this.playerShield;
    shield.group.visible = this.shielded;

    if (this.shielded) {
      const motionScale = this.reducedMotion ? 0.24 : 1;
      const shieldTime = this.runElapsed * motionScale;
      const pulse = this.reducedMotion ? 0 : Math.sin(this.runElapsed * 4.4);
      shield.glass.rotation.y += deltaSeconds * 0.18 * motionScale;
      shield.energy.rotation.x += deltaSeconds * 0.09 * motionScale;
      shield.energy.rotation.y -= deltaSeconds * 0.22 * motionScale;
      shield.energy.scale.setScalar(1.025 + pulse * 0.006);
      const shieldTimeUniform = shield.energy.material.uniforms.uTime;
      const shieldOpacityUniform = shield.energy.material.uniforms.uOpacity;
      if (shieldTimeUniform) shieldTimeUniform.value = shieldTime;
      if (shieldOpacityUniform) shieldOpacityUniform.value = 0.9 + pulse * 0.08;
      shield.glass.material.emissiveIntensity = 0.16 + pulse * 0.025;
    }
    const drones = this.player.userData.drones as THREE.Group[];

    for (let index = 0; index < drones.length; index += 1) {
      const drone = drones[index];

      if (!drone) {
        continue;
      }

      drone.visible = this.droneRemaining > 0;
      drone.position.y = -0.12 + Math.sin(this.runElapsed * 4.8 + index * Math.PI) * 0.16;
      drone.rotation.z += deltaSeconds * (index === 0 ? -1.8 : 1.8);
    }

    const burstActive = this.burstRemaining > 0;
    const weaponGlowActive = burstActive || this.overdriveRemaining > 0 || this.plasmaRemaining > 0;
    this.assets.playerMaterial.emissiveIntensity = burstActive ? 2.1 : weaponGlowActive ? 1.35 : 1.08;
    this.assets.playerWingMaterial.emissiveIntensity = burstActive ? 1.65 : weaponGlowActive ? 1.08 : 0.94;
    const modeVisual = this.player.userData.modeVisual as PlayerModeVisual;
    modeVisual.autoHullMaterial.opacity = burstActive ? 0.98 : weaponGlowActive ? 0.86 : 0.76;
    modeVisual.autoWingMaterial.opacity = burstActive ? 0.94 : weaponGlowActive ? 0.8 : 0.68;
    modeVisual.autoCoreMaterial.opacity = burstActive ? 0.2 : weaponGlowActive ? 0.12 : 0.06;
    modeVisual.autoAccentMaterial.opacity = burstActive ? 1 : weaponGlowActive ? 0.92 : 0.84;
    this.assets.playerProjectileGlowMaterial.opacity = burstActive ? 0.82 : 0.42;

    const laserActive = this.lowProfileRemaining > 0 || this.beamRemaining > 0;
    this.playerLaser.visible = laserActive;

    if (laserActive) {
      const laserStartY = this.player.position.y + playerRadius * 0.72;
      const laserLength = Math.max(0.2, WORLD_TOP - laserStartY + 0.6);
      this.playerLaser.position.set(this.player.position.x, laserStartY + laserLength / 2, 0);
      this.playerLaser.scale.set(1, laserLength, 1);
      this.laserDamageCooldown -= deltaSeconds;

      while (this.laserDamageCooldown <= 0) {
        this.applyPlayerLaserDamage(laserStartY, WORLD_TOP + 0.6);
        this.laserDamageCooldown += LASER_DAMAGE_INTERVAL_SECONDS;
      }
    } else {
      this.playerFireCooldown -= deltaSeconds;
      const fireInterval = playerCannonFireInterval({
        rapid: this.rapidFireRemaining > 0,
        overdrive: this.overdriveRemaining > 0,
        burst: burstActive,
      });

      while (this.playerFireCooldown <= 0) {
        this.firePlayerProjectile();
        this.playerFireCooldown += fireInterval;
      }
    }
  }

  private spawnPilotLine(): void {
    const openingCave = sampleCaveCorridor(
      this.caveTravel,
      PILOT_LINE_FIRST_Y,
      this.caveDifficultySector,
    );
    const playerOffset = this.player.position.x - openingCave.center;
    const startSide: -1 | 1 = Math.abs(playerOffset) > 0.8
      ? (playerOffset > 0 ? -1 : 1)
      : (this.randomSign() < 0 ? -1 : 1);
    const lanes = pilotLanePattern(startSide);
    this.pilotLine.active = true;
    this.pilotLine.nextNode = 0;
    this.pilotLine.age = 0;
    this.pilotLine.velocityY = -(4.5 + this.difficulty.terminalProgress * 2);

    for (let index = 0; index < this.pilotLine.nodes.length; index += 1) {
      const node = this.pilotLine.nodes[index];

      if (!node) {
        continue;
      }

      const y = PILOT_LINE_FIRST_Y + index * PILOT_LINE_NODE_SPACING;
      const cave = sampleCaveCorridor(this.caveTravel, y, this.caveDifficultySector);
      node.lane = lanes[index] ?? 0;
      node.mesh.position.set(pilotLaneTarget(cave.safeLeft, cave.safeRight, node.lane), y, 1.28);
      node.mesh.rotation.z = index * 0.42;
      node.mesh.visible = true;
      node.ringMaterial.opacity = index === 0 ? 0.92 : 0.3;
      node.coreMaterial.opacity = index === 0 ? 0.72 : 0.2;
    }

    this.publishSnapshot(true);
  }

  private updatePilotLine(deltaSeconds: number): void {
    // Manual is still the selected mode during a temporary emergency evade.
    // Keep optional Auto-only lines frozen and prevent hidden route rewards.
    if (!this.autoPilotEnabled) {
      return;
    }

    if (!this.pilotLine.active) {
      this.pilotLineCooldown -= deltaSeconds;

      if (this.pilotLineCooldown <= 0) {
        this.spawnPilotLine();
      }

      return;
    }

    this.pilotLine.age += deltaSeconds;

    for (let index = 0; index < this.pilotLine.nodes.length; index += 1) {
      const node = this.pilotLine.nodes[index];

      if (!node || !node.mesh.visible) {
        continue;
      }

      node.mesh.position.y += this.pilotLine.velocityY * deltaSeconds;
      const cave = sampleCaveCorridor(
        this.caveTravel,
        node.mesh.position.y,
        this.caveDifficultySector,
      );
      const targetX = pilotLaneTarget(cave.safeLeft, cave.safeRight, node.lane);
      node.mesh.position.x += (targetX - node.mesh.position.x) * Math.min(1, deltaSeconds * 3.2);
      node.mesh.rotation.z += deltaSeconds * (index % 2 === 0 ? 0.8 : -0.8);
      const isNext = index === this.pilotLine.nextNode;
      const pulse = 1 + Math.sin(this.pilotLine.age * 5.5 + index) * (isNext ? 0.08 : 0.035);
      node.ring.scale.setScalar(2.45 * pulse);
      node.core.scale.setScalar(1.72 * (2 - pulse));
      node.ringMaterial.opacity = isNext ? 0.78 + Math.sin(this.pilotLine.age * 6) * 0.14 : 0.26;
      node.coreMaterial.opacity = isNext ? 0.62 : 0.18;
    }

    const nextNode = this.pilotLine.nodes[this.pilotLine.nextNode];

    if (!nextNode || nextNode.mesh.position.y < WORLD_BOTTOM - 1.6) {
      this.dismissPilotLine();
      return;
    }

    const overlapsNextNode = circlesOverlap(
      nextNode.mesh.position.x,
      nextNode.mesh.position.y,
      PILOT_LINE_RADIUS,
      this.player.position.x,
      this.player.position.y,
      this.currentPlayerRadius(),
    );

    if (!overlapsNextNode) {
      return;
    }

    const humanInputSeconds = this.pressedKeys.size > 0
      ? Math.max(this.recentHumanInputSeconds, FIXED_STEP_SECONDS)
      : this.recentHumanInputSeconds;
    const advancedNode = nextPilotNodeAfterCrossing(
      this.pilotLine.nextNode,
      this.pilotLine.nextNode,
      humanInputSeconds,
    );

    if (advancedNode === this.pilotLine.nextNode) {
      return;
    }

    const completedX = nextNode.mesh.position.x;
    const completedY = nextNode.mesh.position.y;
    nextNode.mesh.visible = false;
    this.pilotLine.nextNode = advancedNode;
    this.spawnImpact(completedX, completedY, PLAYER_PINK, 1.45);

    if (advancedNode >= PILOT_LINE_NODE_COUNT) {
      this.completePilotLine(completedX, completedY);
      return;
    }

    const upcomingNode = this.pilotLine.nodes[advancedNode];

    if (upcomingNode) {
      upcomingNode.ringMaterial.opacity = 0.92;
      upcomingNode.coreMaterial.opacity = 0.72;
    }

    this.announcement = `Pilot line ${advancedNode}/${PILOT_LINE_NODE_COUNT}`;
    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.6);
    this.publishSnapshot(true);
  }

  private completePilotLine(x: number, y: number): void {
    const outcome = resolvePilotLine(this.pilotSync, this.sector, true);
    this.pilotSync = outcome.nextSync;
    this.pilotStyleScore += outcome.styleScore;
    this.rapidFireRemaining = Math.max(this.rapidFireRemaining, outcome.rapidFireSeconds);

    if (outcome.syncStrike) {
      this.burstRemaining = Math.max(this.burstRemaining, outcome.burstSeconds);
      this.syncStrikeRemaining = outcome.burstSeconds;
      this.playerFireCooldown = 0;
      this.screenShakeRemaining = this.reducedMotion ? 0 : Math.max(this.screenShakeRemaining, 0.12);

      for (let index = 0; index < 7; index += 1) {
        const angle = index / 7 * Math.PI * 2;
        this.spawnImpact(
          this.player.position.x + Math.cos(angle) * 1.8,
          this.player.position.y + Math.sin(angle) * 1.35,
          index % 2 === 0 ? PLAYER_YELLOW : PLAYER_PINK,
          0.72,
        );
      }

      this.announcement = `Sync strike · +${outcome.styleScore} style · 10× burst`;
      this.sectorAnnouncementRemaining = 1.5;
    } else {
      this.spawnImpact(x, y, PLAYER_YELLOW, 2.1);
      this.announcement = `Pilot line complete · +${outcome.styleScore} style · sync ${this.pilotSync}/${PILOT_SYNC_TARGET}`;
      this.sectorAnnouncementRemaining = 1.25;
    }

    this.persistBestScore();
    this.dismissPilotLine();
    this.publishSnapshot(true);
  }

  private dismissPilotLine(): void {
    // Missing is intentionally silent and neutral: no sync loss, score loss,
    // damage, threat spawn, or difficulty change.
    resolvePilotLine(this.pilotSync, this.sector, false);
    this.pilotLine.active = false;
    this.pilotLine.nextNode = 0;
    this.pilotLineCooldown = this.randomRange(8.5, 12.5);

    for (const node of this.pilotLine.nodes) {
      node.mesh.visible = false;
      node.ringMaterial.opacity = 0;
      node.coreMaterial.opacity = 0;
    }
  }

  private suspendPilotLineForManualFlight(): void {
    // Unlike a normal miss, changing flight mode must consume no gameplay RNG
    // and award no route result. Auto resumes from one fixed readable delay.
    this.pilotLine.active = false;
    this.pilotLine.nextNode = 0;
    this.pilotLine.age = 0;

    for (const node of this.pilotLine.nodes) {
      node.mesh.visible = false;
      node.ringMaterial.opacity = 0;
      node.coreMaterial.opacity = 0;
    }
  }

  private updateDashTrail(): void {
    const effectRatio = clampNumber(this.dashEffectRemaining / DASH_EFFECT_SECONDS, 0, 1);
    const visible = effectRatio > 0 && this.status === "running";
    this.dashTrail.mesh.visible = visible;

    const opacityUniform = this.dashTrail.material.uniforms.uOpacity;
    const timeUniform = this.dashTrail.material.uniforms.uTime;
    if (timeUniform) timeUniform.value = this.runElapsed;

    if (!visible) {
      if (opacityUniform) opacityUniform.value = 0;
      return;
    }

    const reducedMotionScale = this.reducedMotion ? 0.56 : 1;
    const trailLength = DASH_SPEED * DASH_TRAVEL_SECONDS
      * (0.78 + effectRatio * 0.56)
      * reducedMotionScale;
    const trailWidth = this.player.scale.x
      * (this.reducedMotion ? 0.72 : 1.08 + effectRatio * 0.42);
    this.dashTrail.mesh.position.set(
      this.player.position.x - this.dashDirectionX * trailLength * 0.48,
      this.player.position.y - this.dashDirectionY * trailLength * 0.48,
      1.35,
    );
    this.dashTrail.mesh.rotation.z = Math.atan2(-this.dashDirectionX, this.dashDirectionY);
    this.dashTrail.mesh.scale.set(trailWidth, trailLength, 1);
    if (opacityUniform) {
      opacityUniform.value = effectRatio * (this.reducedMotion ? 0.22 : 0.68);
    }
  }

  private directionFor(
    negativeCodes: readonly string[],
    positiveCodes: readonly string[],
  ): number {
    const negativePressed = negativeCodes.some((code) => this.pressedKeys.has(code));
    const positivePressed = positiveCodes.some((code) => this.pressedKeys.has(code));

    return Number(positivePressed) - Number(negativePressed);
  }

  private updateSpawning(deltaSeconds: number): void {
    if (this.bossPending) {
      this.bossSpawnDelay -= deltaSeconds;

      if (this.bossSpawnDelay <= 0) {
        this.spawnBoss();
      }

      return;
    }

    if (this.boss.active) {
      return;
    }

    const coreSpawned = this.updateAbilityCoreDirector();

    this.spawnCooldown -= deltaSeconds;
    this.bonusCooldown -= deltaSeconds;

    if (!coreSpawned && this.bonusCooldown <= 0 && this.bonuses.length < 4) {
      this.spawnBonus();
      this.bonusCooldown += scaledCrateSpawnDelay(
        this.randomRange(7, 11),
        this.activeDifficultyLevel,
      );
    }

    if (this.normalWaveIntermissionRemaining > 0) {
      this.normalWaveIntermissionRemaining = Math.max(
        0,
        this.normalWaveIntermissionRemaining - deltaSeconds,
      );
      if (this.normalWaveIntermissionRemaining <= 0) {
        this.beginNextNormalWave();
      }
      return;
    }

    if (this.normalWaveSpawnRemaining <= 0 && this.enemies.length === 0) {
      this.completeNormalWave();
      return;
    }

    if (this.spawnCooldown <= 0 && this.normalWaveSpawnRemaining > 0) {
      if (this.enemies.length < this.difficulty.maxEnemies && this.canAddHostilePressure()) {
        this.normalWaveSpawnRemaining = Math.max(
          0,
          this.normalWaveSpawnRemaining - this.spawnEnemy(),
        );
        this.spawnCooldown = this.difficulty.enemySpawnInterval * this.randomRange(0.75, 1.22);
      } else {
        this.spawnCooldown = 0.08;
      }
    }
  }

  private beginNextNormalWave(): void {
    if (this.encounterCadence.phase !== "normal-waves") {
      return;
    }

    this.normalWaveSpawnRemaining = normalWaveSpawnCount(this.encounterCadence);
    this.spawnCooldown = Math.min(this.spawnCooldown, 0.42);
    const waveNumber = this.encounterCadence.clearedNormalWaves + 1;
    this.announcement = `Normal wave ${waveNumber}/${this.encounterCadence.requiredNormalWaves} inbound`;
    this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 1.1);
    this.publishSnapshot(true);
  }

  private completeNormalWave(): void {
    if (this.encounterCadence.phase !== "normal-waves") {
      return;
    }

    for (let index = this.enemyProjectiles.length - 1; index >= 0; index -= 1) {
      this.releaseEnemyProjectile(index);
    }

    this.encounterCadence = recordNormalWaveClear(this.encounterCadence);
    this.normalWaveSpawnRemaining = 0;

    if (this.encounterCadence.phase === "boss-pending") {
      this.bossPending = true;
      this.bossSpawnDelay = 2.2;
      this.lastBossSector = Math.max(5, this.sector);
      const inboundArchetype = this.bossArchetypeForCurrentEncounter();
      this.announcement = `${bossNameForArchetype(inboundArchetype)} inbound · three escort waves`;
      this.sectorAnnouncementRemaining = 2;
    } else {
      this.normalWaveIntermissionRemaining = NORMAL_WAVE_INTERMISSION_SECONDS;
      this.announcement = `Wave ${this.encounterCadence.clearedNormalWaves} clear`;
      this.sectorAnnouncementRemaining = 1;
    }

    this.publishSnapshot(true);
  }

  private bossArchetypeForCurrentEncounter(): BossArchetype {
    return BOSS_ARCHETYPES[
      this.encounterCadence.bossesDefeated % BOSS_ARCHETYPES.length
    ] ?? "ravager";
  }

  private updateAbilityCoreDirector(): boolean {
    if (this.bonuses.length >= 4) {
      return false;
    }

    const dueKind = nextGuaranteedAbilityCore({
      runSeconds: this.runElapsed,
      sector: this.sector,
      lastBossSector: this.lastBossSector,
      bossActive: this.boss.active,
      bossPending: this.bossPending,
      availablePickupSlot: this.bonuses.length < 4,
      offered: this.abilityCoreCollected,
    });

    if (dueKind) {
      const alreadyVisible = this.bonuses.some((bonus) => bonus.kind === dueKind);
      if (alreadyVisible) {
        return false;
      }
      this.spawnBonusAt(dueKind, this.safeSpawnX(1.8), WORLD_TOP + 1.4);
      this.bonusCooldown = Math.max(
        this.bonusCooldown,
        scaledCrateSpawnDelay(3.5, this.activeDifficultyLevel),
      );
      return true;
    }

    if (
      JET_ABILITY_KINDS.every((kind) => this.abilityCoreCollected[kind])
      && this.runElapsed >= this.nextAbilityCoreDuplicateAt
    ) {
      const kind = [...JET_ABILITY_KINDS].sort((first, second) => (
        this.abilityStates[second].cooldownSeconds - this.abilityStates[first].cooldownSeconds
        || JET_ABILITY_KINDS.indexOf(first) - JET_ABILITY_KINDS.indexOf(second)
      ))[0] ?? "counterflare";
      this.spawnBonusAt(kind, this.safeSpawnX(1.8), WORLD_TOP + 1.4);
      this.nextAbilityCoreDuplicateAt += 48;
      this.bonusCooldown = Math.max(
        this.bonusCooldown,
        scaledCrateSpawnDelay(3.5, this.activeDifficultyLevel),
      );
      return true;
    }

    return false;
  }

  private spawnEnemy(): number {
    const opening = isProtectedOpening(this.worldElapsed);
    const wavesRemaining = this.encounterCadence.requiredNormalWaves
      - this.encounterCadence.clearedNormalWaves - 1;
    const pressureSector = Math.max(1, this.sector - wavesRemaining * 2);
    let kind = opening
      ? (this.gameplayRandom() < 0.58 ? "asteroid" : "fighter") satisfies EnemyKind
      : enemyKindForRoll(pressureSector, this.gameplayRandom());

    if (!canSpawnTurret(this.worldElapsed) && kind === "turret") {
      kind = this.gameplayRandom() < 0.5 ? "asteroid" : "fighter";
    }

    const formationEligible = kind === "fighter"
      || kind === "interceptor"
      || kind === "asteroid"
      || kind === "mine"
      || kind === "corsair"
      || kind === "splitter"
      || kind === "chronodrone";
    const formationChance = this.difficulty.terminalProgress
      * ENEMY_PRESSURE_TUNING.formationChanceAtTerminal;
    const formationCount = formationEligible && this.gameplayRandom() < formationChance
      ? Math.min(
          this.difficulty.maxFormationSize,
          this.difficulty.maxEnemies - this.enemies.length,
          this.normalWaveSpawnRemaining,
          2 + Math.floor(this.gameplayRandom() * Math.max(1, this.difficulty.maxFormationSize - 1)),
        )
      : 1;
    const baseSpawnX = this.safeSpawnX(opening ? 2.5 : 1.2);

    for (let formationIndex = 0; formationIndex < formationCount; formationIndex += 1) {
      this.spawnEnemyUnit(kind, formationIndex, formationCount, baseSpawnX);
    }

    return formationCount;
  }

  private spawnEnemyUnit(
    kind: EnemyKind,
    formationIndex: number,
    formationCount: number,
    baseSpawnX: number,
    options: EnemySpawnOptions = {},
  ): void {
    const rules = enemyArchetypeForKind(kind);
    const enemy = this.checkoutEnemy(kind);
    const playerInSpawnApproach = this.player.position.y > WORLD_TOP - 6;
    const formationOffset = (formationIndex - (formationCount - 1) / 2) * 1.45;
    let horizontalSpawn = clampNumber(
      baseSpawnX + formationOffset,
      WORLD_LEFT + rules.radius + 0.4,
      WORLD_RIGHT - rules.radius - 0.4,
    );
    const asteroidScale = kind === "asteroid" ? this.randomRange(0.84, 1.18) : 1;
    const orbitRadius = rules.movementFamily === "orbit" ? this.randomRange(1.25, 1.9) : this.randomRange(0.7, 1.4);
    const orbitSpeed = this.randomSign() * this.randomRange(1.05, 1.75) * this.difficulty.enemyMovementSpeedScale;
    const orbitPhase = this.randomRange(0, Math.PI * 2);
    let centerX = rules.movementFamily === "orbit"
      ? clampNumber(horizontalSpawn, WORLD_LEFT + orbitRadius + 0.85, WORLD_RIGHT - orbitRadius - 0.85)
      : horizontalSpawn;
    const spawnY = options.spawnY ?? (
      WORLD_TOP + orbitRadius + this.randomRange(0.8, 2.8)
        + formationIndex * 1.25
        + (playerInSpawnApproach ? 4.5 : 0)
    );
    const wallSide: -1 | 0 | 1 = kind === "turret" || kind === "sniper"
      ? (this.randomSign() < 0 ? -1 : 1)
      : 0;
    const spawnCave = sampleCaveCorridor(this.caveTravel, spawnY, this.caveDifficultySector);

    if (wallSide !== 0) {
      horizontalSpawn = wallSide < 0
        ? spawnCave.wallLeft + rules.radius * 0.15
        : spawnCave.wallRight - rules.radius * 0.15;
      centerX = horizontalSpawn;
    } else {
      horizontalSpawn = clampNumber(
        horizontalSpawn,
        spawnCave.safeLeft + rules.radius,
        spawnCave.safeRight - rules.radius,
      );
      centerX = clampNumber(centerX, spawnCave.safeLeft + rules.radius, spawnCave.safeRight - rules.radius);
    }
    const elite = options.elite ?? this.gameplayRandom() < this.difficulty.eliteChance;
    enemy.id = this.nextEnemyId;
    this.nextEnemyId += 1;
    enemy.baseX = centerX;
    enemy.baseY = spawnY;
    enemy.age = 0;
    enemy.orbitRadius = orbitRadius;
    enemy.orbitSpeed = orbitSpeed;
    enemy.orbitPhase = orbitPhase;
    const modelScale = rules.modelScale * asteroidScale * (elite ? 1.12 : 1);
    enemy.mesh.scale.setScalar(modelScale);
    enemy.mesh.visible = true;
    enemy.radius = rules.radius * modelScale;
    const maximumHealth = Math.max(
      1,
      Math.ceil(rules.baseHealth * this.difficulty.enemyHealthScale * (elite ? 1.75 : 1)),
    );
    enemy.maxHealth = maximumHealth;
    enemy.health = maximumHealth;
    let movementFactor = 0.38;
    switch (rules.movementFamily) {
      case "hold-lane":
        movementFactor = 0.2;
        break;
      case "mine-drift":
        movementFactor = 0.28;
        break;
      case "shield-advance":
        movementFactor = 0.22;
        break;
      case "tether-orbit":
        movementFactor = 0.14;
        break;
      case "ram-charge":
        movementFactor = 0.62;
        break;
      case "cloak-stalk":
        movementFactor = 0.25;
        break;
      case "command-weave":
        movementFactor = 0.16;
        break;
      default:
        break;
    }
    enemy.velocityY = wallSide === 0
      ? -(this.difficulty.scrollSpeed * movementFactor + this.randomRange(0.45, 1.35))
        * this.difficulty.enemyMovementSpeedScale
      : -this.difficulty.scrollSpeed;
    enemy.rotationSpeed = kind === "asteroid" ? this.randomSign() * this.randomRange(0.7, 1.8) : 0;
    enemy.rocketCooldown = rules.weaponFamily === "twin-cannon"
      ? this.hostileFireDelay(
          this.randomRange(3.8, 6.4)
            * this.difficulty.rocketCooldownScale
            * ENEMY_PRESSURE_TUNING.rocketCadenceScale,
        )
      : Number.POSITIVE_INFINITY;
    const initialFireCooldown = rules.fireCooldownSeconds === null
      ? Number.POSITIVE_INFINITY
      : rules.fireCooldownSeconds * this.randomRange(0.75, 1.25);
    enemy.cooldown = this.hostileFireDelay(
      initialFireCooldown
        * this.difficulty.enemyFireCooldownScale
        * ENEMY_PRESSURE_TUNING.fireCadenceScale,
    );
    enemy.elite = elite;
    enemy.weaponIndex = 0;
    enemy.observedVelocityX = 0;
    enemy.observedVelocityY = enemy.velocityY;
    enemy.wallSide = wallSide;
    enemy.bossEscort = options.bossEscort ?? false;
    enemy.cryoRemaining = 0;

    if (rules.movementFamily === "orbit") {
      const pose = fighterLoopPose(centerX, spawnY, 0, orbitRadius, orbitSpeed, orbitPhase, enemy.velocityY);
      enemy.mesh.position.set(pose.x, pose.y, 0);
      enemy.mesh.rotation.set(0, 0, pose.rotation);
    } else {
      enemy.mesh.position.set(horizontalSpawn, spawnY, wallSide === 0 ? 0 : -0.32);
      enemy.mesh.rotation.set(
        rules.movementFamily === "tumble" || rules.movementFamily === "mine-drift" ? this.randomRange(-0.7, 0.7) : 0,
        rules.movementFamily === "tumble" || rules.movementFamily === "mine-drift" ? this.randomRange(-0.7, 0.7) : 0,
        rules.movementFamily === "tumble" || rules.movementFamily === "mine-drift" ? this.randomRange(-0.5, 0.5) : 0,
      );
    }

    if (enemy.chargeMaterial) {
      enemy.chargeMaterial.opacity = 0.16;
    }

    enemy.chargeMesh?.scale.setScalar(1);
    this.enemies.push(enemy);
    this.scene.add(enemy.mesh);
  }

  private canAddHostilePressure(): boolean {
    if (isTerminalPressureUnbounded(this.difficulty.terminalProgress)) {
      return true;
    }

    const required = brainPressureAdmissionThresholds(
      this.difficulty.terminalProgress,
      DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds,
    );
    return this.brainSurvivalSeconds >= required.survivalSeconds
      && this.brainClearance > required.clearance;
  }

  private hostileProjectileCap(): number {
    return scaledHostileProjectileCap(
      this.difficulty.maxEnemyProjectiles,
      this.activeDifficultyLevel,
    );
  }

  private hostileRocketCap(): number {
    return scaledHostileProjectileCap(
      this.difficulty.maxEnemyRockets,
      this.activeDifficultyLevel,
    );
  }

  private hostileVolleyCount(baseCount: number): number {
    return scaledHostileVolleyCount(
      scaledEnemyVolleyCount(baseCount, ENEMY_PRESSURE_TUNING),
      this.activeDifficultyLevel,
    );
  }

  private hostileProjectileSpeed(baseSpeed: number): number {
    return scaledHostileProjectileSpeed(baseSpeed, this.activeDifficultyLevel);
  }

  private hostileFireDelay(baseDelaySeconds: number): number {
    return scaledHostileFireDelay(baseDelaySeconds, this.activeDifficultyLevel);
  }

  private spawnBonus(): void {
    const kind = this.chooseBonusKind();
    this.spawnBonusAt(kind, this.safeSpawnX(1.6), WORLD_TOP + this.randomRange(1.5, 3.5));
  }

  private spawnBonusAt(kind: BonusKind, x: number, y: number): void {
    if (this.bonuses.length >= 4) {
      return;
    }

    const bonus = this.checkoutBonus(kind);
    bonus.id = this.nextBonusId;
    this.nextBonusId += 1;
    bonus.mesh.position.set(clampNumber(x, WORLD_LEFT + 1, WORLD_RIGHT - 1), y, 0.4);
    bonus.mesh.rotation.set(0, 0, this.randomRange(0, Math.PI * 2));
    const crate = bonus.mesh.userData.crate as THREE.Group;
    const halo = bonus.mesh.userData.halo as THREE.Mesh;
    crate.rotation.set(this.randomRange(0.18, 0.48), this.randomRange(0.24, 0.56), 0);
    halo.scale.setScalar(0.68);
    bonus.velocityY = -(this.difficulty.scrollSpeed * 0.35 + 0.65);
    bonus.age = 0;
    bonus.mesh.visible = true;
    this.bonuses.push(bonus);
    this.scene.add(bonus.mesh);
  }

  private chooseBonusKind(): BonusKind {
    if (this.lives < 3 && this.gameplayRandom() < 0.42) {
      return "pulse";
    }

    if (!this.shielded && this.gameplayRandom() < 0.3) {
      return "shield";
    }

    if (this.bonusBag.length === 0) {
      this.bonusBag = BONUS_KINDS.filter((kind) => !JET_ABILITY_KINDS.includes(kind as JetAbilityKind));

      for (let index = this.bonusBag.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(this.gameplayRandom() * (index + 1));
        const current = this.bonusBag[index];
        this.bonusBag[index] = this.bonusBag[swapIndex] ?? "rapid";
        this.bonusBag[swapIndex] = current ?? "rapid";
      }
    }

    return this.bonusBag.shift() ?? "rapid";
  }

  private bonusPickupValue(kind: BonusKind): number {
    switch (kind) {
      case "pulse":
        return this.lives < 3 ? 3 : 0.65;
      case "shield":
        return this.shielded ? 0.75 : 2.4;
      case "missile":
        return this.enemies.length > 0 || this.boss.active ? 2.1 : 0.8;
      case "stasis":
        return 1.4 + this.difficulty.terminalProgress * 1.8;
      case "counterflare":
      case "gravity-knot":
      case "phoenix-squadron": {
        const state = this.abilityStates[kind];
        if (!state.unlocked) return 3.4;
        if (state.cooldownSeconds > 0 || state.activeSeconds > 0) return 2.35;
        return this.shielded ? 0.95 : 1.55;
      }
      case "beam":
      case "plasma":
      case "overdrive":
        return this.boss.active ? 1.9 : 1.35;
      default:
        return 1.2;
    }
  }

  private safeSpawnX(playerClearance: number): number {
    const cave = sampleCaveCorridor(
      this.caveTravel,
      WORLD_TOP + 1.5,
      this.caveDifficultySector,
    );
    const minimumX = Math.max(WORLD_LEFT + 1.1, cave.safeLeft + 1.1);
    const maximumX = Math.min(WORLD_RIGHT - 1.1, cave.safeRight - 1.1);
    let candidate = this.randomRange(minimumX, maximumX);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const nearPlayer = Math.abs(candidate - this.playerX) < playerClearance;
      const overlapsSpawn = this.enemies.some((enemy) => Math.abs(enemy.mesh.position.x - candidate) < 1.6 && enemy.mesh.position.y > WORLD_TOP - 2);

      if (!nearPlayer && !overlapsSpawn) {
        return candidate;
      }

      candidate = this.randomRange(minimumX, maximumX);
    }

    let bestCandidate = minimumX;
    let bestClearance = Number.NEGATIVE_INFINITY;

    for (let index = 0; index <= 8; index += 1) {
      const gridCandidate = minimumX + index / 8 * (maximumX - minimumX);
      const enemyClearance = this.enemies
        .filter((enemy) => enemy.mesh.position.y > WORLD_TOP - 2)
        .reduce((minimum, enemy) => Math.min(minimum, Math.abs(enemy.mesh.position.x - gridCandidate)), Number.POSITIVE_INFINITY);
      const clearance = Math.min(Math.abs(gridCandidate - this.playerX) - playerClearance, enemyClearance - 1.6);

      if (clearance > bestClearance) {
        bestClearance = clearance;
        bestCandidate = gridCandidate;
      }
    }

    return bestCandidate;
  }

  private updateEnemies(hostileDeltaSeconds: number): void {
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];

      if (!enemy) {
        continue;
      }

      const cryoActive = enemy.cryoRemaining > 0;
      enemy.cryoRemaining = Math.max(0, enemy.cryoRemaining - hostileDeltaSeconds);
      const deltaSeconds = hostileDeltaSeconds * (cryoActive ? CRYO_TIME_SCALE : 1);

      const rules = enemyArchetypeForKind(enemy.kind);
      const previousX = enemy.mesh.position.x;
      const previousY = enemy.mesh.position.y;
      const gravityHeld = this.abilityStates["gravity-knot"].activeSeconds > 0
        && Math.hypot(
          enemy.mesh.position.x - this.gravityKnotX,
          enemy.mesh.position.y - this.gravityKnotY,
        ) <= 4.45;
      enemy.age += deltaSeconds;

      const movementFamily = rules.movementFamily;
      switch (movementFamily) {
      case "orbit": {
        const pose = fighterLoopPose(
          enemy.baseX,
          enemy.baseY,
          enemy.age,
          enemy.orbitRadius,
          enemy.orbitSpeed,
          enemy.orbitPhase,
          enemy.velocityY,
        );
        enemy.mesh.position.set(pose.x, pose.y, enemy.mesh.position.z);
        enemy.mesh.rotation.z = pose.rotation;
        const engineGlows = enemy.mesh.userData.engineGlows as THREE.Mesh[];
        const enginePulse = 0.68 + Math.sin(enemy.age * 18) * 0.13;

        for (const engineGlow of engineGlows) {
          engineGlow.scale.set(0.32, enginePulse, 1);
        }
        break;
      }
      case "drift":
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds;
        if (enemy.wallSide !== 0) {
          const cave = sampleCaveCorridor(
            this.caveTravel,
            enemy.mesh.position.y,
            this.caveDifficultySector,
          );
          enemy.mesh.position.x = enemy.wallSide < 0
            ? cave.wallLeft + enemy.radius * 0.15
            : cave.wallRight - enemy.radius * 0.15;
        }
        break;
      case "tumble":
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds;
        enemy.mesh.rotation.x += enemy.rotationSpeed * deltaSeconds * 0.46;
        enemy.mesh.rotation.y += enemy.rotationSpeed * deltaSeconds * 0.72;
        enemy.mesh.rotation.z += enemy.rotationSpeed * deltaSeconds;
        break;
      case "intercept": {
        const interceptDirection = Math.sign(this.player.position.x - enemy.mesh.position.x);
        enemy.mesh.position.x = clampNumber(
          enemy.mesh.position.x + interceptDirection * 4.8 * this.difficulty.enemyMovementSpeedScale * deltaSeconds,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds;
        enemy.mesh.rotation.z = -interceptDirection * 0.34;
        break;
      }
      case "bombing-run":
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + Math.sin(enemy.age * enemy.orbitSpeed + enemy.orbitPhase) * enemy.orbitRadius * 1.8,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds;
        enemy.mesh.rotation.z = -Math.cos(enemy.age * enemy.orbitSpeed + enemy.orbitPhase) * 0.18;
        break;
      case "broadside":
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * (enemy.mesh.position.y > WORLD_TOP - 5 ? 1 : 0.18);
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + Math.sin(enemy.age * enemy.orbitSpeed * 0.52 + enemy.orbitPhase) * 4.2,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        break;
      case "hold-lane":
        if (enemy.mesh.position.y > WORLD_TOP - 5.5) {
          enemy.mesh.position.y += enemy.velocityY * deltaSeconds;
        } else {
          enemy.mesh.position.x = clampNumber(
            enemy.baseX + Math.sin(enemy.age * 0.65 + enemy.orbitPhase) * 1.1,
            WORLD_LEFT + enemy.radius,
            WORLD_RIGHT - enemy.radius,
          );
          enemy.mesh.position.y -= this.difficulty.scrollSpeed * 0.035 * deltaSeconds;
        }
        if (enemy.wallSide !== 0) {
          const cave = sampleCaveCorridor(
            this.caveTravel,
            enemy.mesh.position.y,
            this.caveDifficultySector,
          );
          enemy.mesh.position.x = enemy.wallSide < 0
            ? cave.wallLeft + enemy.radius * 0.12
            : cave.wallRight - enemy.radius * 0.12;
        }
        break;
      case "mine-drift": {
        const playerDistance = Math.hypot(
          this.player.position.x - enemy.mesh.position.x,
          this.player.position.y - enemy.mesh.position.y,
        );
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * (playerDistance < 4 ? 1.8 : 0.7);
        enemy.mesh.position.x += Math.sin(enemy.age * 1.8 + enemy.orbitPhase) * deltaSeconds * 0.9;
        enemy.mesh.rotation.z += deltaSeconds * 1.8;

        if (playerDistance < 3.2 && enemy.weaponIndex === 0 && !gravityHeld && this.canAddHostilePressure()) {
          this.fireEnemyProjectile(enemy);
          enemy.weaponIndex = 1;
        }
        break;
      }
      case "carrier-lane":
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.58;
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + Math.sin(enemy.age * 0.42 + enemy.orbitPhase) * 3.2,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        break;
      case "phase-shift": {
        const phase = enemy.age * enemy.orbitSpeed + enemy.orbitPhase;
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds;
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + Math.sin(phase) * 3.4 + Math.sin(phase * 2.7) * 0.8,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        const phaseScale = 0.82 + Math.abs(Math.sin(phase * 1.7)) * 0.28;
        const baseScale = rules.modelScale * (enemy.elite ? 1.12 : 1);
        enemy.mesh.scale.setScalar(baseScale * phaseScale);
        enemy.radius = rules.radius * baseScale * phaseScale;
        break;
      }
      case "strafe-dash": {
        const phase = enemy.age * 1.6 * this.difficulty.enemyMovementSpeedScale + enemy.orbitPhase;
        const wave = Math.sin(phase);
        const dashOffset = Math.sign(wave) * Math.pow(Math.abs(wave), 0.34) * 5.2;
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + dashOffset,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.84;
        enemy.mesh.rotation.z = -Math.cos(phase) * 0.48;
        break;
      }
      case "shield-advance": {
        const phase = enemy.age * 0.34 + enemy.orbitPhase;
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + Math.sin(phase) * 0.8,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.72;
        const shieldRing = enemy.mesh.userData.signatureRing as THREE.Mesh | undefined;
        if (shieldRing) {
          shieldRing.rotation.z -= deltaSeconds * 0.72;
          shieldRing.scale.setScalar(1.35 + Math.sin(enemy.age * 4.4) * 0.08);
        }
        break;
      }
      case "blink-ambush": {
        const blinkSeconds = 1.12;
        const blinkStep = Math.floor(enemy.age / blinkSeconds);
        const blinkProgress = enemy.age / blinkSeconds - blinkStep;
        const blinkLanes = [-1, 1, 0, -0.55, 0.55] as const;
        const lane = blinkLanes[blinkStep % blinkLanes.length] ?? 0;
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + lane * 4.6,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.78;
        const baseScale = rules.modelScale * (enemy.elite ? 1.12 : 1);
        const blinkScale = 0.86 + Math.sin(blinkProgress * Math.PI) * 0.2;
        enemy.mesh.scale.setScalar(baseScale * blinkScale);
        enemy.radius = rules.radius * baseScale * blinkScale;
        const blinkRing = enemy.mesh.userData.signatureRing as THREE.Mesh | undefined;
        if (blinkRing) blinkRing.rotation.z += deltaSeconds * 2.8;
        break;
      }
      case "siphon-pursuit": {
        const maximumHorizontalStep = deltaSeconds * 2.8 * this.difficulty.enemyMovementSpeedScale;
        enemy.mesh.position.x += clampNumber(
          this.player.position.x - enemy.mesh.position.x,
          -maximumHorizontalStep,
          maximumHorizontalStep,
        );
        const targetY = this.player.position.y + 5.4;
        const maximumVerticalStep = Math.max(0.4, Math.abs(enemy.velocityY)) * deltaSeconds;
        enemy.mesh.position.y += clampNumber(
          targetY - enemy.mesh.position.y,
          -maximumVerticalStep,
          maximumVerticalStep,
        );
        enemy.mesh.rotation.z = Math.sin(enemy.age * 1.8 + enemy.orbitPhase) * 0.16;
        const siphonMouth = enemy.mesh.userData.signatureRing as THREE.Mesh | undefined;
        if (siphonMouth) siphonMouth.scale.setScalar(0.82 + Math.sin(enemy.age * 6) * 0.12);
        break;
      }
      case "split-flank": {
        const flankSide = enemy.id % 2 === 0 ? -1 : 1;
        const flankDistance = 3.8 + Math.sin(enemy.age * 0.72 + enemy.orbitPhase) * 1.2;
        enemy.mesh.position.x = clampNumber(
          this.player.position.x + flankSide * flankDistance,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.9;
        enemy.mesh.rotation.z = -flankSide * 0.3;
        const splitterHalves = enemy.mesh.userData.signatureGroup as THREE.Group | undefined;
        if (splitterHalves) splitterHalves.scale.x = 1 + Math.sin(enemy.age * 3.8) * 0.12;
        break;
      }
      case "tether-orbit": {
        const phase = enemy.age * 0.58 * this.difficulty.enemyMovementSpeedScale + enemy.orbitPhase;
        const targetX = this.player.position.x + Math.cos(phase) * 2.5;
        const targetY = this.player.position.y + 6 + Math.sin(phase) * 1.2;
        const horizontalStep = deltaSeconds * 3.1 * this.difficulty.enemyMovementSpeedScale;
        const verticalStep = deltaSeconds * Math.max(0.5, Math.abs(enemy.velocityY));
        enemy.mesh.position.x += clampNumber(targetX - enemy.mesh.position.x, -horizontalStep, horizontalStep);
        enemy.mesh.position.y += clampNumber(targetY - enemy.mesh.position.y, -verticalStep, verticalStep);
        const tetherRings = enemy.mesh.userData.signatureGroup as THREE.Group | undefined;
        if (tetherRings) tetherRings.rotation.z = phase;
        break;
      }
      case "ram-charge": {
        const cycleSeconds = 3.2;
        const cycleProgress = enemy.age % cycleSeconds;
        if (cycleProgress < 1.22) {
          const alignmentStep = deltaSeconds * 4.2 * this.difficulty.enemyMovementSpeedScale;
          enemy.mesh.position.x += clampNumber(
            this.player.position.x - enemy.mesh.position.x,
            -alignmentStep,
            alignmentStep,
          );
          enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.22;
          enemy.mesh.rotation.z = 0;
        } else if (cycleProgress < 2.12) {
          enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 3.15;
          enemy.mesh.rotation.z = Math.sin(enemy.age * 18) * 0.06;
        } else {
          enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.54;
          enemy.mesh.rotation.z *= Math.max(0, 1 - deltaSeconds * 6);
        }
        const ramGlow = enemy.mesh.userData.signatureRing as THREE.Mesh | undefined;
        if (ramGlow) {
          const charge = cycleProgress < 1.22 ? cycleProgress / 1.22 : 0;
          ramGlow.scale.setScalar(0.75 + charge * 0.6);
          ramGlow.rotation.z += deltaSeconds * (2 + charge * 8);
        }
        break;
      }
      case "cloak-stalk": {
        const phase = enemy.age * 0.5 + enemy.orbitPhase;
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + Math.sin(phase) * 4,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.68;
        const baseScale = rules.modelScale * (enemy.elite ? 1.12 : 1);
        const cloakPulse = Math.abs(Math.sin(phase * 1.7));
        const cloakScale = 0.9 + cloakPulse * 0.1;
        enemy.mesh.scale.setScalar(baseScale * cloakScale);
        enemy.radius = rules.radius * baseScale * cloakScale;
        const cloakParts = enemy.mesh.userData.signatureGroup as THREE.Group | undefined;
        if (cloakParts) {
          cloakParts.visible = cloakPulse > 0.42;
          cloakParts.rotation.z = -phase * 0.7;
        }
        break;
      }
      case "chrono-zigzag": {
        const phase = enemy.age * 1.85 * this.difficulty.enemyMovementSpeedScale + enemy.orbitPhase;
        const quantizedLane = Math.round(Math.sin(phase) * 2) * 2.4;
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + quantizedLane,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        const stutter = Math.floor(enemy.age * 8) % 2 === 0 ? 0.26 : 1.45;
        enemy.mesh.position.y += enemy.velocityY * deltaSeconds * stutter;
        enemy.mesh.rotation.z = -Math.sign(Math.cos(phase)) * 0.24;
        const chronoRings = enemy.mesh.userData.signatureGroup as THREE.Group | undefined;
        if (chronoRings) chronoRings.rotation.z = -phase;
        break;
      }
      case "command-weave": {
        const phase = enemy.age * 0.38 + enemy.orbitPhase;
        if (enemy.mesh.position.y > WORLD_TOP - 5.2) {
          enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.72;
        } else {
          enemy.mesh.position.y += enemy.velocityY * deltaSeconds * 0.08;
        }
        enemy.mesh.position.x = clampNumber(
          enemy.baseX + Math.sin(phase) * 3.8,
          WORLD_LEFT + enemy.radius,
          WORLD_RIGHT - enemy.radius,
        );
        enemy.mesh.rotation.z = -Math.cos(phase) * 0.08;
        const commandSatellites = enemy.mesh.userData.signatureGroup as THREE.Group | undefined;
        if (commandSatellites) commandSatellites.rotation.z = phase * 1.8;
        break;
      }
      default: {
        const exhaustiveMovement: never = movementFamily;
        throw new Error(`Unsupported enemy movement family: ${exhaustiveMovement}`);
      }
      }

      if (gravityHeld) {
        enemy.mesh.position.x = previousX + (enemy.mesh.position.x - previousX) * 0.14;
        enemy.mesh.position.y = previousY + (enemy.mesh.position.y - previousY) * 0.14;
        enemy.mesh.rotation.z += deltaSeconds * 0.45;
      }

      if (enemy.aimGroup) {
        const horizontalDistance = this.player.position.x - enemy.mesh.position.x;
        const verticalDistance = this.player.position.y - enemy.mesh.position.y;
        enemy.aimGroup.rotation.z = Math.atan2(horizontalDistance, -verticalDistance);
        const armorRing = enemy.mesh.userData.armorRing as THREE.Mesh | undefined;
        if (armorRing) {
          armorRing.rotation.z -= deltaSeconds * 0.55;
        }
      }

      if (enemy.wallSide === 0) {
        const cave = sampleCaveCorridor(
          this.caveTravel,
          enemy.mesh.position.y,
          this.caveDifficultySector,
        );
        enemy.mesh.position.x = clampNumber(
          enemy.mesh.position.x,
          cave.safeLeft + enemy.radius * 0.35,
          cave.safeRight - enemy.radius * 0.35,
        );
      }

      const eliteHalo = enemy.mesh.userData.eliteHalo as THREE.Mesh | undefined;
      if (eliteHalo) {
        eliteHalo.visible = enemy.elite;
        eliteHalo.rotation.z += deltaSeconds * 1.4;
      }

      enemy.observedVelocityX = deltaSeconds > 0 ? (enemy.mesh.position.x - previousX) / deltaSeconds : 0;
      enemy.observedVelocityY = deltaSeconds > 0 ? (enemy.mesh.position.y - previousY) / deltaSeconds : enemy.velocityY;

      enemy.rocketCooldown -= deltaSeconds;
      if (
        rules.weaponFamily === "twin-cannon" &&
        !gravityHeld &&
        enemy.rocketCooldown <= 0 &&
        canFireRocket(this.worldElapsed) &&
        enemy.mesh.position.y < WORLD_TOP - 1 &&
        enemy.mesh.position.y > this.player.position.y + 4 &&
        this.canAddHostilePressure() &&
        this.activeRocketCount() < this.hostileRocketCap()
      ) {
        this.fireEnemyRocket(enemy);
        enemy.rocketCooldown = this.hostileFireDelay(
          this.randomRange(6.2, 9.4)
            * this.difficulty.rocketCooldownScale
            * ENEMY_PRESSURE_TUNING.rocketCadenceScale,
        );
      }

      if (rules.fireCooldownSeconds !== null) {
        enemy.cooldown -= deltaSeconds;

        if (enemy.chargeMaterial) {
          const chargeProgress = enemy.cooldown < 0.48 ? 1 - Math.max(0, enemy.cooldown) / 0.48 : 0;
          enemy.chargeMaterial.opacity = 0.16 + chargeProgress * 0.84;
          enemy.chargeMesh?.scale.setScalar(0.8 + chargeProgress * 1.1);
        }

        if (
          enemy.cooldown <= 0 &&
          !gravityHeld &&
          this.enemyProjectiles.length < this.hostileProjectileCap() &&
          this.canAddHostilePressure()
        ) {
          this.fireEnemyProjectile(enemy);
          enemy.weaponIndex += 1;
          enemy.cooldown = this.hostileFireDelay(
            rules.fireCooldownSeconds
              * this.randomRange(0.82, 1.18)
              * this.difficulty.enemyFireCooldownScale
              * ENEMY_PRESSURE_TUNING.fireCadenceScale
              * (enemy.elite ? 0.72 : 1),
          );
        }
      }

      if (enemy.mesh.position.y < WORLD_BOTTOM - 2.5) {
        this.releaseEnemy(index);
      }
    }
  }

  private spawnBoss(): void {
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      this.releaseEnemy(index);
    }

    this.bossPending = false;
    this.encounterCadence = beginBossEncounter(this.encounterCadence);
    this.boss.active = true;
    this.boss.entering = true;
    this.boss.archetype = this.bossArchetypeForCurrentEncounter();
    this.configureBossArchetype(this.boss.archetype);
    this.boss.maxHealth = scaledBossHealth(
      bossHealthForSector(this.lastBossSector, this.boss.archetype),
      this.activeDifficultyLevel,
    );
    this.boss.health = this.boss.maxHealth;
    this.boss.phase = 1;
    this.boss.age = 0;
    this.boss.attackCooldown = this.hostileFireDelay(1.8);
    this.boss.patternIndex = 0;
    this.boss.hitFlashRemaining = 0;
    this.boss.cryoRemaining = 0;
    this.lowProfileBossDamagePending = 0;
    this.lowProfileBossLaserHitAvailable = false;
    this.bossEscortProgress = createBossEscortProgress();
    this.pendingBossEscorts.length = 0;
    this.boss.mesh.position.set(0, WORLD_TOP + 4, 0.6);
    this.boss.mesh.rotation.set(0, 0, 0);
    this.boss.mesh.visible = true;
    this.boss.chargeMaterial.opacity = 0.15;
    this.boss.entryShield.visible = true;
    this.scene.add(this.boss.mesh);
    this.boss.observedVelocityX = 0;
    this.boss.observedVelocityY = 0;
    this.announcement = `${this.boss.name} engaged`;
    this.sectorAnnouncementRemaining = 1.8;
    this.screenShakeRemaining = this.reducedMotion ? 0 : 0.1;
    this.publishSnapshot(true);
  }

  private updateBossEscorts(): void {
    if (!this.boss.active) {
      this.pendingBossEscorts.length = 0;
      return;
    }

    const availableEnemySlots = Math.max(
      0,
      this.difficulty.maxEnemies - this.enemies.length - this.pendingBossEscorts.length,
    );
    const wave = nextBossEscortWave(this.bossEscortProgress, {
      sector: this.lastBossSector,
      archetype: this.boss.archetype,
      entering: this.boss.entering,
      encounterSeconds: this.boss.age,
      bossHealth: this.boss.health,
      bossMaxHealth: this.boss.maxHealth,
      bossPhase: this.boss.phase,
      availableEnemySlots,
    });

    if (wave) {
      this.bossEscortProgress = recordBossEscortWaveLaunch(
        this.bossEscortProgress,
        wave,
        this.boss.age,
      );

      for (const unit of wave.units) {
        this.pendingBossEscorts.push({
          unit,
          spawnAtSeconds: this.boss.age + unit.entryDelaySeconds,
          minimumPlayerSeparation: wave.minimumPlayerSeparation,
          waveNumber: wave.number,
        });
      }

      this.announcement = wave.announcement;
      this.sectorAnnouncementRemaining = 1.8;
      this.screenShakeRemaining = this.reducedMotion
        ? 0
        : Math.max(this.screenShakeRemaining, 0.08);
      this.publishSnapshot(true);
    }

    for (let index = 0; index < this.pendingBossEscorts.length;) {
      const pending = this.pendingBossEscorts[index];

      if (
        !pending ||
        pending.spawnAtSeconds > this.boss.age ||
        this.enemies.length >= this.difficulty.maxEnemies
      ) {
        index += 1;
        continue;
      }

      this.spawnBossEscortUnit(pending);
      this.pendingBossEscorts.splice(index, 1);
    }
  }

  private spawnBossEscortUnit(pending: PendingBossEscort): void {
    const rules = enemyArchetypeForKind(pending.unit.kind);
    const verticalEntryExtent = rules.radius * (pending.unit.elite ? 1.12 : 1)
      + (rules.movementFamily === "orbit" ? 2 : 0);
    const spawnY = bossEscortSafeEntryY(
      this.player.position.y,
      WORLD_TOP,
      verticalEntryExtent,
      pending.minimumPlayerSeparation,
    );
    const cave = sampleCaveCorridor(this.caveTravel, spawnY, this.caveDifficultySector);
    const minimumX = cave.safeLeft + rules.radius + 0.35;
    const maximumX = cave.safeRight - rules.radius - 0.35;
    const caveCenter = (minimumX + maximumX) / 2;
    const caveHalfWidth = Math.max(0, (maximumX - minimumX) / 2);
    const spawnX = clampNumber(
      caveCenter + pending.unit.normalizedLane * caveHalfWidth,
      minimumX,
      maximumX,
    );

    this.spawnEnemyUnit(pending.unit.kind, 0, 1, spawnX, {
      elite: pending.unit.elite,
      spawnY,
      bossEscort: true,
    });

    const cueColor = pending.waveNumber === 1 ? ENEMY_FIRE_RED : ENEMY_FIRE_ORANGE;
    this.spawnImpact(
      spawnX,
      WORLD_TOP - 0.65,
      cueColor,
      pending.unit.elite ? 1.3 : 0.9,
      "enemy",
    );
  }

  private configureBossArchetype(archetype: BossArchetype): void {
    const visualRules: Readonly<Record<BossArchetype, {
      readonly hull: number;
      readonly wing: number;
      readonly scale: number;
      readonly radius: number;
    }>> = {
      ravager: { hull: 0xb6382e, wing: 0x4f1a18, scale: 1, radius: 2.7 },
      stormwing: { hull: 0xd44a30, wing: 0x5a2019, scale: 0.92, radius: 2.55 },
      dreadnought: { hull: 0x92321f, wing: 0x421a16, scale: 1.14, radius: 3.25 },
      prism: { hull: 0xc42f39, wing: 0x521923, scale: 0.98, radius: 2.85 },
      harvester: { hull: 0x81301f, wing: 0x371612, scale: 1.06, radius: 3.05 },
      chronarch: { hull: 0x35266b, wing: 0x16143d, scale: 1.08, radius: 3.15 },
    };
    const visual = visualRules[archetype];
    this.boss.name = bossNameForArchetype(archetype);
    this.boss.radius = visual.radius;
    this.boss.mesh.scale.setScalar(visual.scale);
    this.boss.hullMaterial.color.setHex(visual.hull);
    this.boss.hullMaterial.emissive.setHex(visual.hull).multiplyScalar(0.42);
    this.boss.wingMaterial.color.setHex(visual.wing);
    this.boss.wingMaterial.emissive.setHex(visual.wing).multiplyScalar(0.38);

    for (const candidate of BOSS_ARCHETYPES) {
      this.boss.variants[candidate].visible = candidate === archetype;
    }
  }

  private updateBoss(hostileDeltaSeconds: number): void {
    if (!this.boss.active) {
      return;
    }

    const cryoActive = this.boss.cryoRemaining > 0;
    this.boss.cryoRemaining = Math.max(0, this.boss.cryoRemaining - hostileDeltaSeconds);
    const deltaSeconds = hostileDeltaSeconds * (cryoActive ? CRYO_TIME_SCALE : 1);

    const previousX = this.boss.mesh.position.x;
    const previousY = this.boss.mesh.position.y;
    this.boss.hitFlashRemaining = Math.max(0, this.boss.hitFlashRemaining - deltaSeconds);
    const phaseEnergy = (this.boss.phase - 1) * 0.2;
    const hitEnergy = this.boss.hitFlashRemaining > 0 ? 2.2 : 0;
    this.boss.hullMaterial.emissiveIntensity = 0.72 + phaseEnergy + hitEnergy;
    this.boss.wingMaterial.emissiveIntensity = 0.52 + phaseEnergy * 0.75 + hitEnergy * 0.55;
    const enginePulse = 1.18 + Math.sin(this.runElapsed * 19) * 0.18 + phaseEnergy;

    for (const engineGlow of this.boss.engineGlows) {
      engineGlow.scale.set(0.72, enginePulse, 1);
    }

    if (this.boss.entering) {
      this.boss.mesh.position.y = Math.max(BOSS_TARGET_Y, this.boss.mesh.position.y - deltaSeconds * 3.4);
      this.boss.chargeMaterial.opacity = 0.15;
      this.boss.entryShield.rotation.z -= deltaSeconds * 0.9;
      this.boss.entryShield.material.opacity = 0.5 + Math.sin(this.runElapsed * 5) * 0.12;

      if (this.boss.mesh.position.y <= BOSS_TARGET_Y) {
        this.boss.entering = false;
        this.boss.entryShield.visible = false;
        this.boss.age = 0;
        this.boss.attackCooldown = this.hostileFireDelay(1.25);
        this.announcement = "Break its armor";
        this.sectorAnnouncementRemaining = 1.2;
        this.spawnImpact(
          this.boss.mesh.position.x,
          this.boss.mesh.position.y,
          ARCADE_PALETTE.telegraphOrange,
          2.2,
          "enemy",
        );
      }

      this.boss.observedVelocityX = 0;
      this.boss.observedVelocityY = deltaSeconds > 0
        ? (this.boss.mesh.position.y - previousY) / deltaSeconds
        : 0;

      return;
    }

    this.boss.age += deltaSeconds;
    const movementSpeed = 0.48 + (this.boss.phase - 1) * 0.08;
    const movementTime = this.boss.age * movementSpeed;
    const movementFamily = bossRulesForArchetype(this.boss.archetype).movementFamily;

    switch (movementFamily) {
      case "figure-eight":
        this.boss.mesh.position.x = Math.sin(movementTime) * 6.25;
        this.boss.mesh.position.y = BOSS_TARGET_Y + Math.sin(movementTime * 2) * 1.05;
        this.boss.mesh.rotation.z = -Math.cos(movementTime) * (0.11 + this.boss.phase * 0.018);
        break;
      case "dive-loop":
        this.boss.mesh.position.x = Math.sin(movementTime * 1.3) * 6.9;
        this.boss.mesh.position.y = BOSS_TARGET_Y - Math.max(0, Math.sin(movementTime * 0.72)) * (2.3 + this.boss.phase * 0.65);
        this.boss.mesh.rotation.z = -Math.cos(movementTime * 1.3) * 0.28;
        break;
      case "broadside":
        this.boss.mesh.position.x = Math.sin(movementTime * 0.68) * 6.7;
        this.boss.mesh.position.y = BOSS_TARGET_Y + Math.sin(movementTime * 1.25) * 0.48;
        this.boss.mesh.rotation.z = -Math.cos(movementTime * 0.68) * 0.06;
        break;
      case "orbit":
        this.boss.mesh.position.x = Math.cos(movementTime * 1.08) * 5.25;
        this.boss.mesh.position.y = BOSS_TARGET_Y - 0.7 + Math.sin(movementTime * 1.08) * 1.9;
        this.boss.mesh.rotation.z = movementTime * 0.12;
        break;
      case "pursuit":
        this.boss.mesh.position.x += clampNumber(
          this.player.position.x - this.boss.mesh.position.x,
          -deltaSeconds * (2.4 + this.boss.phase * 0.6),
          deltaSeconds * (2.4 + this.boss.phase * 0.6),
        );
        this.boss.mesh.position.y = BOSS_TARGET_Y - 1.1 + Math.sin(movementTime * 1.55) * 1.15;
        this.boss.mesh.rotation.z = clampNumber((previousX - this.boss.mesh.position.x) * 0.12, -0.18, 0.18);
        break;
      case "temporal-lattice": {
        const stepSeconds = Math.max(0.72, 1.28 - this.boss.phase * 0.12);
        const latticeStep = Math.floor(this.boss.age / stepSeconds);
        const stepProgress = this.boss.age / stepSeconds - latticeStep;
        const easedProgress = stepProgress * stepProgress * (3 - 2 * stepProgress);
        const currentAngle = (latticeStep % 8) / 8 * Math.PI * 2 + Math.PI / 8;
        const nextAngle = ((latticeStep + 1) % 8) / 8 * Math.PI * 2 + Math.PI / 8;
        const currentX = Math.cos(currentAngle) * 5.8;
        const nextX = Math.cos(nextAngle) * 5.8;
        const currentY = BOSS_TARGET_Y - 0.55 + Math.sin(currentAngle) * 1.65;
        const nextY = BOSS_TARGET_Y - 0.55 + Math.sin(nextAngle) * 1.65;
        this.boss.mesh.position.x = THREE.MathUtils.lerp(currentX, nextX, easedProgress);
        this.boss.mesh.position.y = THREE.MathUtils.lerp(currentY, nextY, easedProgress);
        this.boss.mesh.rotation.z = Math.sin(stepProgress * Math.PI) * 0.08;

        const chronarchVariant = this.boss.variants.chronarch;
        const outerRing = chronarchVariant.userData.outerRing as THREE.Mesh;
        const innerRing = chronarchVariant.userData.innerRing as THREE.Mesh;
        const longHand = chronarchVariant.userData.longHand as THREE.Group;
        const shortHand = chronarchVariant.userData.shortHand as THREE.Group;
        outerRing.rotation.z = this.boss.age * (0.28 + this.boss.phase * 0.05);
        innerRing.rotation.z = -this.boss.age * (0.48 + this.boss.phase * 0.07);
        longHand.rotation.z = -this.boss.age * (1.35 + this.boss.phase * 0.22);
        shortHand.rotation.z = this.boss.age * (0.52 + this.boss.phase * 0.09);
        break;
      }
      default: {
        const exhaustiveMovement: never = movementFamily;
        throw new Error(`Unsupported boss movement family: ${exhaustiveMovement}`);
      }
    }

    this.boss.observedVelocityX = deltaSeconds > 0 ? (this.boss.mesh.position.x - previousX) / deltaSeconds : 0;
    this.boss.observedVelocityY = deltaSeconds > 0 ? (this.boss.mesh.position.y - previousY) / deltaSeconds : 0;
    this.boss.attackCooldown -= deltaSeconds;
    const chargeProgress = this.boss.attackCooldown < 0.72
      ? 1 - Math.max(0, this.boss.attackCooldown) / 0.72
      : 0;
    this.boss.chargeMaterial.opacity = 0.15 + chargeProgress * 0.85;

    for (const chargeGlow of this.boss.chargeGlows) {
      chargeGlow.scale.setScalar(1.2 + chargeProgress * 1.8);
    }

    if (this.boss.attackCooldown <= 0 && this.canAddHostilePressure()) {
      this.fireBossAttack();
      const baseCooldown = this.boss.phase === 1 ? 2.35 : this.boss.phase === 2 ? 1.85 : 1.4;
      this.boss.attackCooldown = this.hostileFireDelay(
        baseCooldown
          * this.difficulty.bossAttackCooldownScale
          * bossRulesForArchetype(this.boss.archetype).attackCooldownScale
          * ENEMY_PRESSURE_TUNING.fireCadenceScale
          * this.randomRange(0.92, 1.08),
      );
    }
  }

  private fireBossAttack(): void {
    const leftMuzzle = new THREE.Vector3(-1.58, -1.36, 0);
    const rightMuzzle = new THREE.Vector3(1.58, -1.36, 0);
    this.boss.mesh.localToWorld(leftMuzzle);
    this.boss.mesh.localToWorld(rightMuzzle);
    const attackPattern = bossWeaponForPhase(this.boss.archetype, this.boss.phase);
    const projectileSpeed = this.hostileProjectileSpeed(
      this.difficulty.enemyProjectileSpeed * (0.76 + this.boss.phase * 0.06),
    );
    const patternTier = Math.min(
      4,
      this.boss.phase - 1 + Math.floor(this.difficulty.terminalProgress * 3),
    );
    const bossAimJitter = this.hostileAimJitter();
    const targetAngle = (origin: THREE.Vector3, horizontalOffset = 0): number => (
      this.hostileTargetAngle(origin.x, origin.y, horizontalOffset, bossAimJitter)
    );
    const fireFan = (count: number, spread: number, speed: number, style: EnemyShotStyle = "bolt"): void => {
      const scaledCount = this.hostileVolleyCount(count);
      for (let index = 0; index < scaledCount; index += 1) {
        const ratio = scaledCount > 1 ? index / (scaledCount - 1) : 0.5;
        const origin = index % 2 === 0 ? leftMuzzle : rightMuzzle;
        this.fireEnemyProjectileAtAngle(
          origin.x,
          origin.y,
          targetAngle(origin)
            + (ratio - 0.5) * spread * ENEMY_PRESSURE_TUNING.volleySpreadScale,
          speed,
          style,
        );
      }
    };
    const fireRing = (count: number, offset: number, speed: number, style: EnemyShotStyle): void => {
      const scaledCount = this.hostileVolleyCount(count);
      for (let index = 0; index < scaledCount; index += 1) {
        this.fireEnemyProjectileAtAngle(
          this.boss.mesh.position.x,
          this.boss.mesh.position.y - 0.8,
          offset + index / scaledCount * Math.PI * 2,
          speed,
          style,
        );
      }
    };

    switch (attackPattern) {
      case "aimed-fan":
        fireFan(5 + patternTier * 2, 0.72 + patternTier * 0.08, projectileSpeed);
        break;
      case "lane-volley": {
        const laneCount = this.hostileVolleyCount(4 + Math.min(3, patternTier));
        for (let index = 0; index < laneCount; index += 1) {
          const targetOffset = -4.4 + index / (laneCount - 1) * 8.8;
          const origin = index % 2 === 0 ? leftMuzzle : rightMuzzle;
          this.fireEnemyProjectileAtAngle(origin.x, origin.y, targetAngle(origin, targetOffset), projectileSpeed, "heavy");
        }
        break;
      }
      case "homing-salvo":
        this.fireEnemyRocketFrom(leftMuzzle.x, leftMuzzle.y);
        this.fireEnemyRocketFrom(rightMuzzle.x, rightMuzzle.y);
        fireFan(3 + patternTier * 2, 0.34 + patternTier * 0.08, projectileSpeed * 1.12, "phase");
        break;
      case "spiral-burst":
        fireRing(9 + patternTier * 2, this.boss.patternIndex * 0.29, projectileSpeed * 0.82, "phase");
        break;
      case "lightning-lanes": {
        const laneCount = this.hostileVolleyCount(4 + Math.min(3, patternTier));
        for (let index = 0; index < laneCount; index += 1) {
          const offset = -4.5 + index / (laneCount - 1) * 9;
          this.fireEnemyProjectileAtAngle(
            clampNumber(this.boss.mesh.position.x + offset, WORLD_LEFT + 0.5, WORLD_RIGHT - 0.5),
            this.boss.mesh.position.y - 0.4,
            -Math.PI / 2
              + Math.sin(this.boss.patternIndex + offset)
                * 0.08
                * ENEMY_PRESSURE_TUNING.volleySpreadScale,
            projectileSpeed * 1.12,
            "rail",
          );
        }
        break;
      }
      case "seeker-swarm":
        this.fireEnemyRocketFrom(leftMuzzle.x, leftMuzzle.y);
        this.fireEnemyRocketFrom(rightMuzzle.x, rightMuzzle.y);
        fireFan(1 + patternTier * 2, 0.28 + patternTier * 0.08, projectileSpeed, "phase");
        break;
      case "broadside-barrage":
        fireFan(8 + patternTier * 2, 1.08 + patternTier * 0.08, projectileSpeed * 0.82, "heavy");
        break;
      case "mine-wall": {
        const mineCount = this.hostileVolleyCount(7 + patternTier * 2);
        for (let index = 0; index < mineCount; index += 1) {
          const x = WORLD_LEFT + 1.2 + index / (mineCount - 1) * (WORLD_WIDTH - 2.4);
          this.fireEnemyProjectileAtAngle(x, this.boss.mesh.position.y - 0.5, -Math.PI / 2, projectileSpeed * 0.28, "mine");
        }
        break;
      }
      case "rail-cannon":
        this.fireEnemyProjectileAtAngle(
          this.boss.mesh.position.x,
          this.boss.mesh.position.y - 1.6,
          targetAngle(new THREE.Vector3(this.boss.mesh.position.x, this.boss.mesh.position.y - 1.6, 0)),
          projectileSpeed * 1.75,
          "rail",
        );
        if (patternTier > 0) {
          fireFan(patternTier * 2, 0.24 + patternTier * 0.08, projectileSpeed * 1.1, "phase");
        }
        break;
      case "laser-sweep": {
        const sweepAngle = -Math.PI / 2 + Math.sin(this.boss.patternIndex * 0.72) * 0.68;
        const beamCount = this.hostileVolleyCount(3 + patternTier * 2);
        for (let index = 0; index < beamCount; index += 1) {
          const offset = (index - (beamCount - 1) / 2)
            * 0.08
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          this.fireEnemyProjectileAtAngle(this.boss.mesh.position.x, this.boss.mesh.position.y - 1, sweepAngle + offset, projectileSpeed * 1.5, "rail");
        }
        break;
      }
      case "ricochet-grid":
        for (const x of [WORLD_LEFT + 1, WORLD_RIGHT - 1]) {
          const direction = x < 0 ? -0.72 : -2.42;
          this.fireEnemyProjectileAtAngle(x, this.boss.mesh.position.y - 0.5, direction, projectileSpeed, "phase");
          this.fireEnemyProjectileAtAngle(x, this.boss.mesh.position.y - 2.2, -Math.PI / 2, projectileSpeed * 0.9, "phase");
        }
        if (patternTier > 1) {
          fireFan(patternTier * 2, 0.72, projectileSpeed * 0.86, "phase");
        }
        break;
      case "prism-burst":
        fireRing(12 + patternTier * 2, Math.PI / 12 + this.boss.patternIndex * 0.17, projectileSpeed * 0.92, "phase");
        break;
      case "tractor-ring": {
        const shotCount = this.hostileVolleyCount(9 + patternTier * 2);
        for (let index = 0; index < shotCount; index += 1) {
          const offset = (index - (shotCount - 1) / 2)
            * 0.14
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          this.fireEnemyProjectileAtAngle(this.boss.mesh.position.x, this.boss.mesh.position.y - 1, -Math.PI / 2 + offset, projectileSpeed * 0.65, "mine");
        }
        break;
      }
      case "drone-swarm":
        this.fireEnemyRocketFrom(leftMuzzle.x, leftMuzzle.y);
        this.fireEnemyRocketFrom(rightMuzzle.x, rightMuzzle.y);
        fireFan(6 + patternTier * 2, 0.94 + patternTier * 0.08, projectileSpeed * 0.9, "phase");
        break;
      case "plasma-lance":
        fireFan(3 + patternTier * 2, 0.16 + patternTier * 0.05, projectileSpeed * 1.42, "heavy");
        break;
      case "clock-hand-sweep": {
        const handCount = 3 + Math.min(2, patternTier);
        const handOffset = -Math.PI / 2 + this.boss.patternIndex * 0.31;
        for (let handIndex = 0; handIndex < handCount; handIndex += 1) {
          const handAngle = handOffset + handIndex / handCount * Math.PI * 2;
          for (let beadIndex = 0; beadIndex < 3; beadIndex += 1) {
            this.fireEnemyProjectileAtAngle(
              this.boss.mesh.position.x,
              this.boss.mesh.position.y - 0.45,
              handAngle,
              projectileSpeed * (0.62 + beadIndex * 0.2),
              "temporal",
            );
          }
        }
        break;
      }
      case "rewind-barrage": {
        const firstNewProjectile = this.enemyProjectiles.length;
        fireFan(7 + patternTier * 2, 0.92 + patternTier * 0.08, projectileSpeed * 0.92, "temporal");
        fireRing(5 + patternTier * 2, this.boss.patternIndex * 0.23, projectileSpeed * 0.68, "phase");
        for (let index = firstNewProjectile; index < this.enemyProjectiles.length; index += 1) {
          const projectile = this.enemyProjectiles[index];
          if (projectile?.kind === "enemy") {
            projectile.rewindAtSeconds = 0.58 + index % 3 * 0.1;
          }
        }
        break;
      }
      case "time-rift-collapse": {
        const riftCount = this.hostileVolleyCount(10 + patternTier * 2);
        const gapCenter = this.boss.patternIndex % Math.max(1, riftCount);
        const targetX = this.player.position.x;
        const targetY = this.player.position.y;
        const riftRadius = 5.8 + patternTier * 0.25;
        for (let index = 0; index < riftCount; index += 1) {
          const gapDistance = Math.min(
            Math.abs(index - gapCenter),
            riftCount - Math.abs(index - gapCenter),
          );
          if (gapDistance <= 1) continue;
          const originAngle = index / riftCount * Math.PI * 2;
          const originX = clampNumber(targetX + Math.cos(originAngle) * riftRadius, WORLD_LEFT + 0.6, WORLD_RIGHT - 0.6);
          const originY = clampNumber(targetY + Math.sin(originAngle) * riftRadius, WORLD_BOTTOM + 0.6, WORLD_TOP - 0.6);
          this.fireEnemyProjectileAtAngle(
            originX,
            originY,
            Math.atan2(targetY - originY, targetX - originX),
            projectileSpeed * 0.54,
            "tether",
          );
        }
        this.spawnImpact(targetX, targetY, 0x72f4ff, 1.35, "enemy");
        break;
      }
      default: {
        const exhaustivePattern: never = attackPattern;
        throw new Error(`Unsupported boss weapon pattern: ${exhaustivePattern}`);
      }
    }

    this.spawnImpactBurst(
      leftMuzzle.x,
      leftMuzzle.y,
      ARCADE_PALETTE.telegraphOrange,
      0.4 + patternTier * 0.04,
      BOSS_MUZZLE_IMPACT_BASE + Math.ceil(patternTier / 2),
      0.2,
      "enemy",
    );
    this.spawnImpactBurst(
      rightMuzzle.x,
      rightMuzzle.y,
      ARCADE_PALETTE.telegraphOrange,
      0.4 + patternTier * 0.04,
      BOSS_MUZZLE_IMPACT_BASE + Math.ceil(patternTier / 2),
      0.2,
      "enemy",
    );
    this.boss.patternIndex += 1;
  }

  private updateProjectiles(deltaSeconds: number, hostileTimeScale: number): void {
    this.refreshPlayerMissileTargets();

    for (let index = this.playerProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.playerProjectiles[index];

      if (!projectile) {
        continue;
      }

      projectile.previousX = projectile.mesh.position.x;
      projectile.previousY = projectile.mesh.position.y;
      projectile.age += deltaSeconds;

      if (projectile.kind === "player" && projectile.targetingSteering) {
        const target = this.resolvePlayerMissileTarget(projectile);

        if (target) {
          const horizontalDistance = target.x - projectile.mesh.position.x;
          const verticalDistance = target.y - projectile.mesh.position.y;
          const targetDistance = Math.hypot(horizontalDistance, verticalDistance) || 1;
          const currentSpeed = Math.hypot(projectile.velocityX, projectile.velocityY) || projectile.speed;
          const steering = Math.min(1, deltaSeconds * TARGETING_STEERING_PER_SECOND);
          const steeredX = projectile.velocityX / currentSpeed * (1 - steering)
            + horizontalDistance / targetDistance * steering;
          const steeredY = projectile.velocityY / currentSpeed * (1 - steering)
            + verticalDistance / targetDistance * steering;
          const steeredLength = Math.hypot(steeredX, steeredY) || 1;
          projectile.velocityX = steeredX / steeredLength * projectile.speed;
          projectile.velocityY = steeredY / steeredLength * projectile.speed;
        }
      } else if (projectile.kind === "player-missile") {
        const target = this.resolvePlayerMissileTarget(projectile);

        if (target) {
          const horizontalDistance = target.x - projectile.mesh.position.x;
          const verticalDistance = target.y - projectile.mesh.position.y;
          const targetDistance = Math.hypot(horizontalDistance, verticalDistance) || 1;
          const currentSpeed = Math.hypot(projectile.velocityX, projectile.velocityY) || projectile.speed;
          const steering = Math.min(1, deltaSeconds * 4.2);
          const steeredX = projectile.velocityX / currentSpeed * (1 - steering) + horizontalDistance / targetDistance * steering;
          const steeredY = projectile.velocityY / currentSpeed * (1 - steering) + verticalDistance / targetDistance * steering;
          const steeredLength = Math.hypot(steeredX, steeredY) || 1;
          projectile.velocityX = steeredX / steeredLength * projectile.speed;
          projectile.velocityY = steeredY / steeredLength * projectile.speed;
        }

        const flame = projectile.mesh.userData.flame as THREE.Mesh;
        flame.scale.set(1, 0.86 + Math.sin(projectile.age * 30) * 0.16, 1);
      }

      this.orientProjectileToVelocity(projectile);

      projectile.mesh.position.x += projectile.velocityX * deltaSeconds;
      projectile.mesh.position.y += projectile.velocityY * deltaSeconds;

      if (
        projectile.mesh.position.y > WORLD_TOP + 2 ||
        (projectile.kind === "player" && (
          projectile.mesh.position.y < WORLD_BOTTOM - 2
          || projectile.mesh.position.x < WORLD_LEFT - 2
          || projectile.mesh.position.x > WORLD_RIGHT + 2
        )) ||
        (projectile.kind === "player-missile" && (
          projectile.age > MISSILE_LIFETIME_SECONDS ||
          projectile.mesh.position.y < WORLD_BOTTOM - 2 ||
          projectile.mesh.position.x < WORLD_LEFT - 2 ||
          projectile.mesh.position.x > WORLD_RIGHT + 2
        ))
      ) {
        this.releasePlayerProjectile(index);
      }
    }

    for (let index = this.enemyProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.enemyProjectiles[index];

      if (!projectile) {
        continue;
      }

      const counterflareActive = this.abilityStates.counterflare.activeSeconds > 0;
      const distanceToPlayer = Math.hypot(
        projectile.mesh.position.x - this.player.position.x,
        projectile.mesh.position.y - this.player.position.y,
      );
      if (counterflareActive && this.counterflareConversionsRemaining > 0 && distanceToPlayer <= 5.7) {
        const impactX = projectile.mesh.position.x;
        const impactY = projectile.mesh.position.y;
        this.releaseEnemyProjectile(index);
        this.counterflareConversionsRemaining -= 1;
        this.spawnCounterfire(impactX, impactY, this.counterflareConversionsRemaining);
        this.spawnImpact(impactX, impactY, ARCADE_PALETTE.counterMint, 0.66);
        continue;
      }

      const gravityActive = this.abilityStates["gravity-knot"].activeSeconds > 0;
      const distanceToKnot = Math.hypot(
        projectile.mesh.position.x - this.gravityKnotX,
        projectile.mesh.position.y - this.gravityKnotY,
      );
      if (gravityActive && distanceToKnot <= 3.8) {
        const impactX = projectile.mesh.position.x;
        const impactY = projectile.mesh.position.y;
        this.releaseEnemyProjectile(index);
        if (index % 2 === 0) {
          this.spawnImpact(impactX, impactY, ARCADE_PALETTE.stasisViolet, 0.52);
        }
        continue;
      }

      const hostileDeltaSeconds = deltaSeconds * hostileTimeScale;
      projectile.previousX = projectile.mesh.position.x;
      projectile.previousY = projectile.mesh.position.y;
      projectile.age += hostileDeltaSeconds;

      if (projectile.rewindAtSeconds > 0 && projectile.age >= projectile.rewindAtSeconds) {
        projectile.velocityX *= -1;
        projectile.velocityY *= -1;
        projectile.velocityZ *= -1;
        projectile.rewindAtSeconds = -1;
        if (index % 2 === 0) {
          this.spawnImpact(projectile.mesh.position.x, projectile.mesh.position.y, 0x72f4ff, 0.46, "enemy");
        }
      }

      if (projectile.kind === "rocket") {
        const horizontalDistance = this.player.position.x - projectile.mesh.position.x;
        const verticalDistance = this.player.position.y - projectile.mesh.position.y;
        const targetDistance = Math.hypot(horizontalDistance, verticalDistance) || 1;

        if (projectile.age < ENEMY_PRESSURE_TUNING.rocketHomingSeconds) {
          const currentSpeed = Math.hypot(projectile.velocityX, projectile.velocityY) || projectile.speed;
          const steering = Math.min(
            1,
            hostileDeltaSeconds * ENEMY_PRESSURE_TUNING.rocketHomingStrength,
          );
          const steeredX = projectile.velocityX / currentSpeed * (1 - steering) + horizontalDistance / targetDistance * steering;
          const steeredY = projectile.velocityY / currentSpeed * (1 - steering) + verticalDistance / targetDistance * steering;
          const steeredLength = Math.hypot(steeredX, steeredY) || 1;
          projectile.velocityX = steeredX / steeredLength * projectile.speed;
          projectile.velocityY = steeredY / steeredLength * projectile.speed;
        }

        const flame = projectile.mesh.userData.flame as THREE.Mesh;
        flame.scale.set(1, 0.82 + Math.sin(projectile.age * 26) * 0.16, 1);
      } else if (projectile.style === "arc") {
        const curve = Math.sin(projectile.age * 6.4) * hostileDeltaSeconds * 0.72;
        const cosine = Math.cos(curve);
        const sine = Math.sin(curve);
        const nextVelocityX = projectile.velocityX * cosine - projectile.velocityY * sine;
        projectile.velocityY = projectile.velocityX * sine + projectile.velocityY * cosine;
        projectile.velocityX = nextVelocityX;
      } else if (projectile.style === "tether") {
        const horizontalDistance = this.player.position.x - projectile.mesh.position.x;
        const verticalDistance = this.player.position.y - projectile.mesh.position.y;
        const targetDistance = Math.hypot(horizontalDistance, verticalDistance) || 1;
        const currentSpeed = Math.hypot(projectile.velocityX, projectile.velocityY) || projectile.speed;
        const steering = Math.min(0.14, hostileDeltaSeconds * 0.7);
        const steeredX = projectile.velocityX / currentSpeed * (1 - steering)
          + horizontalDistance / targetDistance * steering;
        const steeredY = projectile.velocityY / currentSpeed * (1 - steering)
          + verticalDistance / targetDistance * steering;
        const steeredLength = Math.hypot(steeredX, steeredY) || 1;
        projectile.velocityX = steeredX / steeredLength * currentSpeed;
        projectile.velocityY = steeredY / steeredLength * currentSpeed;
      }

      this.orientProjectileToVelocity(projectile);

      const temporalTravelScale = projectile.style === "temporal"
        ? (Math.floor(projectile.age * 8) % 2 === 0 ? 0.36 : 1.55)
        : 1;
      projectile.mesh.position.x += projectile.velocityX * hostileDeltaSeconds * temporalTravelScale;
      projectile.mesh.position.y += projectile.velocityY * hostileDeltaSeconds * temporalTravelScale;
      projectile.mesh.position.z = Math.min(
        this.player.position.z + 0.15,
        projectile.mesh.position.z + projectile.velocityZ * hostileDeltaSeconds * temporalTravelScale,
      );

      if (
        projectile.mesh.position.y < WORLD_BOTTOM - 1 ||
        projectile.mesh.position.y > WORLD_TOP + 3 ||
        projectile.mesh.position.x < WORLD_LEFT - 1 ||
        projectile.mesh.position.x > WORLD_RIGHT + 1 ||
        projectile.age > 8
      ) {
        this.releaseEnemyProjectile(index);
      }
    }
  }

  private spawnCounterfire(x: number, y: number, sequence: number): void {
    if (this.playerProjectiles.length >= 84) {
      return;
    }

    const projectile = this.checkoutProjectile("player");
    const target = this.boss.active
      && !this.boss.entering
      && this.currentBossDamageBudget().damageable
      ? this.boss.mesh.position
      : [...this.enemies].sort((first, second) => (
          Math.hypot(first.mesh.position.x - x, first.mesh.position.y - y)
          - Math.hypot(second.mesh.position.x - x, second.mesh.position.y - y)
          || first.id - second.id
        ))[0]?.mesh.position;
    const targetX = target?.x ?? x + (sequence % 3 - 1) * 1.2;
    const targetY = target?.y ?? WORLD_TOP;
    const deltaX = targetX - x;
    const deltaY = Math.max(2, targetY - y);
    const distance = Math.hypot(deltaX, deltaY) || 1;
    const speed = 22;
    projectile.mesh.position.set(x, y, 1.92);
    projectile.velocityX = deltaX / distance * speed;
    projectile.velocityY = deltaY / distance * speed;
    projectile.velocityZ = 0;
    projectile.radius = 0.23;
    projectile.age = 0;
    projectile.speed = speed;
    projectile.previousX = x;
    projectile.previousY = y;
    projectile.damage = 2.2;
    projectile.targetId = null;
    projectile.targetBoss = false;
    this.orientProjectileToVelocity(projectile);
    this.scaleCometVisual(projectile, 1.45, 1.75, 1.1);
    projectile.mesh.visible = true;
    this.playerProjectiles.push(projectile);
    this.scene.add(projectile.mesh);
  }

  private resolvePlayerMissileTarget(projectile: Projectile): { x: number; y: number } | null {
    if (
      projectile.targetBoss
      && this.boss.active
      && !this.boss.entering
      && this.currentBossDamageBudget().damageable
    ) {
      return { x: this.boss.mesh.position.x, y: this.boss.mesh.position.y };
    }

    if (projectile.targetId !== null) {
      const assignedEnemy = this.enemies.find((enemy) => enemy.id === projectile.targetId);

      if (assignedEnemy && assignedEnemy.health > 0) {
        return { x: assignedEnemy.mesh.position.x, y: assignedEnemy.mesh.position.y };
      }
    }

    projectile.targetBoss = false;
    projectile.targetId = null;
    return null;
  }

  private currentBossDamageBudget(): ReturnType<typeof bossEscortDamageBudget> {
    return bossEscortDamageBudget(
      this.boss.health,
      this.boss.maxHealth,
      {
        launchedWaves: this.bossEscortProgress.launchedWaves,
        pendingEscortUnits: this.pendingBossEscorts.length,
      },
    );
  }

  private playerMissileTargets(): PlayerMissileTarget[] {
    const targets: PlayerMissileTarget[] = this.enemies
      .filter((enemy) => (
        enemy.mesh.visible
        && enemy.health > 0
        && enemy.mesh.position.y > WORLD_BOTTOM - 1
        && enemy.mesh.position.y < WORLD_TOP + 4
      ))
      .map((enemy) => ({
        id: enemy.id,
        kind: "enemy",
        health: enemy.health,
        damageBudget: enemy.health,
        priority: enemyArchetypeForKind(enemy.kind).targetPriority * (enemy.elite ? 1.2 : 1),
        damageable: true,
      }));

    if (this.boss.active && !this.boss.entering && this.boss.mesh.visible) {
      const budget = this.currentBossDamageBudget();
      targets.push({
        id: "boss",
        kind: "boss",
        health: this.boss.health,
        damageBudget: budget.damageBudget,
        priority: 10,
        damageable: budget.damageable,
      });
    }

    return targets;
  }

  private refreshPlayerMissileTargets(): void {
    const missiles = this.playerProjectiles.filter((projectile) => projectile.kind === "player-missile");

    if (missiles.length === 0) {
      return;
    }

    const missileDamage = missiles[0]?.damage ?? MISSILE_DAMAGE;
    const assignments = allocatePlayerMissileTargets(
      this.playerMissileTargets(),
      missileDamage,
      missiles.length,
    );

    for (let index = 0; index < missiles.length; index += 1) {
      const missile = missiles[index];
      const assignment = assignments.length > 0
        ? assignments[index % assignments.length]
        : undefined;

      if (!missile) {
        continue;
      }

      missile.targetBoss = assignment?.targetKind === "boss";
      missile.targetId = assignment?.targetKind === "enemy" && typeof assignment.targetId === "number"
        ? assignment.targetId
        : null;
    }
  }

  private updateBonuses(deltaSeconds: number): void {
    for (let index = this.bonuses.length - 1; index >= 0; index -= 1) {
      const bonus = this.bonuses[index];

      if (!bonus) {
        continue;
      }

      bonus.age += deltaSeconds;
      bonus.mesh.position.y += bonus.velocityY * deltaSeconds;
      bonus.mesh.rotation.z += deltaSeconds * 0.48;
      bonus.mesh.position.x += Math.sin(bonus.age * 2.1) * deltaSeconds * 0.5;
      if (this.attachmentActive("magnet")) {
        const deltaX = this.player.position.x - bonus.mesh.position.x;
        const deltaY = this.player.position.y - bonus.mesh.position.y;
        const distance = Math.hypot(deltaX, deltaY);
        if (distance > 0 && distance <= MAGNET_ATTRACTION_RADIUS) {
          const attractionDistance = Math.min(
            distance,
            magnetAttractionSpeed(distance) * deltaSeconds,
          );
          bonus.mesh.position.x += deltaX / distance * attractionDistance;
          bonus.mesh.position.y += deltaY / distance * attractionDistance;
        }
      }
      const cave = sampleCaveCorridor(
        this.caveTravel,
        bonus.mesh.position.y,
        this.caveDifficultySector,
      );
      bonus.mesh.position.x = clampNumber(
        bonus.mesh.position.x,
        cave.wallLeft + bonus.radius + 0.28,
        cave.wallRight - bonus.radius - 0.28,
      );
      const crate = bonus.mesh.userData.crate as THREE.Group;
      const halo = bonus.mesh.userData.halo as THREE.Mesh;
      crate.rotation.x += deltaSeconds * 0.72;
      crate.rotation.y += deltaSeconds * 1.05;
      halo.rotation.z -= deltaSeconds * 0.9;
      halo.scale.setScalar(0.68 + Math.sin(bonus.age * 4.2) * 0.06);

      if (bonus.mesh.position.y < WORLD_BOTTOM - 1.5) {
        this.releaseBonus(index);
      }
    }
  }

  private resolveCaveCollision(playerRadius: number): void {
    const sweep = sweepCircleThroughCave({
      startTravelDistance: this.previousCaveTravel,
      endTravelDistance: this.caveTravel,
      start: { x: this.previousPlayerX, y: this.previousPlayerY },
      end: { x: this.player.position.x, y: this.player.position.y },
      sector: this.caveDifficultySector,
      radius: playerRadius,
      // Wall damage is based on the physical jet silhouette. Super Brain adds
      // its own planning buffer before contact, while low profile really is
      // smaller and may thread a route the full-size jet cannot.
      clearanceMargin: 0,
      maximumSampleSpacing: 0.22,
    });

    if (!sweep.collided) {
      const currentCave = sampleCaveCorridor(
        this.caveTravel,
        this.player.position.y,
        this.caveDifficultySector,
      );
      const currentClearance = caveWallClearance(
        currentCave,
        this.player.position.x,
        playerRadius,
        0,
      );
      if (currentClearance > CAVE_CONTACT_RELEASE_CLEARANCE) {
        this.caveContactLatched = false;
      }
      return;
    }

    const contact = sweep.collisionPosition ?? sweep.position;
    const currentCave = sampleCaveCorridor(
      this.caveTravel,
      contact.y,
      this.caveDifficultySector,
    );
    const minimumX = currentCave.wallLeft + playerRadius + CAVE_CONTACT_RESOLUTION_CLEARANCE;
    const maximumX = currentCave.wallRight - playerRadius - CAVE_CONTACT_RESOLUTION_CLEARANCE;
    const resolvedX = minimumX <= maximumX
      ? clampNumber(contact.x, minimumX, maximumX)
      : currentCave.center;
    const resolvedY = clampNumber(
      contact.y,
      WORLD_BOTTOM + playerRadius,
      WORLD_TOP - playerRadius,
    );

    this.playerX = resolvedX;
    this.player.position.set(resolvedX, resolvedY, 2);
    this.previousPlayerX = resolvedX;
    this.previousPlayerY = resolvedY;
    this.playerVelocityX = 0;
    this.playerVelocityY = 0;
    this.dashRemaining = 0;
    this.dashEffectRemaining = 0;
    this.dashRollProgress = 1;
    this.dashTrail.mesh.visible = false;
    const dashTrailOpacity = this.dashTrail.material.uniforms.uOpacity;
    if (dashTrailOpacity) dashTrailOpacity.value = 0;

    if (!this.caveContactLatched) {
      this.caveContactLatched = true;
      this.spawnImpact(
        contact.x,
        contact.y,
        CAVE_LAYER_COLORS.rim,
        1.15,
      );
      this.takeDamage("terrain");
    }
  }

  private applyCannonSecondaryEffects(
    projectile: Projectile,
    impactX: number,
    impactY: number,
    primaryEnemyId: number | null,
    primaryWasBoss: boolean,
  ): void {
    if (projectile.chainLightning) {
      const visited = new Set(projectile.hitEnemyIds);
      if (primaryEnemyId !== null) visited.add(primaryEnemyId);
      let chainX = impactX;
      let chainY = impactY;

      for (let jump = 0; jump < CHAIN_LIGHTNING_MAX_SECONDARY_TARGETS; jump += 1) {
        const target = this.enemies
          .filter((enemy) => (
            enemy.health > 0
            && !visited.has(enemy.id)
            && Math.hypot(enemy.mesh.position.x - chainX, enemy.mesh.position.y - chainY)
              <= CHAIN_LIGHTNING_RADIUS + enemy.radius
          ))
          .sort((first, second) => (
            Math.hypot(first.mesh.position.x - chainX, first.mesh.position.y - chainY)
            - Math.hypot(second.mesh.position.x - chainX, second.mesh.position.y - chainY)
            || first.id - second.id
          ))[0];

        if (!target) break;
        visited.add(target.id);
        const targetX = target.mesh.position.x;
        const targetY = target.mesh.position.y;
        const damage = projectile.damage
          * CHAIN_LIGHTNING_DAMAGE_MULTIPLIER
          * CHAIN_LIGHTNING_DAMAGE_FALLOFF ** jump;
        target.health -= damage;
        this.spawnImpact(chainX, chainY, 0xe9e568, 0.34);
        this.spawnImpact(targetX, targetY, 0x8feaff, 0.58);
        chainX = targetX;
        chainY = targetY;

        if (target.health <= 0) {
          const targetIndex = this.enemies.findIndex((enemy) => enemy.id === target.id);
          if (targetIndex >= 0) this.destroyEnemy(targetIndex);
        }
      }
    }

    if (!projectile.explosive) return;

    this.spawnImpactBurst(
      impactX,
      impactY,
      0xff6758,
      0.72,
      5,
      EXPLOSIVE_SPLASH_RADIUS * 0.72,
      "friendly",
    );
    const splashDamage = projectile.damage * EXPLOSIVE_SPLASH_DAMAGE_MULTIPLIER;

    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (
        !enemy
        || enemy.id === primaryEnemyId
        || Math.hypot(enemy.mesh.position.x - impactX, enemy.mesh.position.y - impactY)
          > EXPLOSIVE_SPLASH_RADIUS + enemy.radius
      ) {
        continue;
      }

      enemy.health -= splashDamage;
      this.spawnImpact(enemy.mesh.position.x, enemy.mesh.position.y, 0xffa06e, 0.48);
      if (enemy.health <= 0) this.destroyEnemy(index);
    }

    if (
      !primaryWasBoss
      && this.boss.active
      && !this.boss.entering
      && Math.hypot(this.boss.mesh.position.x - impactX, this.boss.mesh.position.y - impactY)
        <= EXPLOSIVE_SPLASH_RADIUS + this.boss.radius
    ) {
      this.damageBoss(splashDamage, impactX, impactY);
    }
  }

  private redirectRicochetRound(projectile: Projectile): boolean {
    const originX = projectile.mesh.position.x;
    const originY = projectile.mesh.position.y;
    const candidates: Array<{
      readonly x: number;
      readonly y: number;
      readonly id: number | "boss";
      readonly boss: boolean;
      readonly distance: number;
    }> = this.enemies
      .filter((enemy) => enemy.health > 0 && !projectile.hitEnemyIds.includes(enemy.id))
      .map((enemy) => ({
        x: enemy.mesh.position.x,
        y: enemy.mesh.position.y,
        id: enemy.id,
        boss: false,
        distance: Math.hypot(enemy.mesh.position.x - originX, enemy.mesh.position.y - originY),
      }));

    if (
      !projectile.hitBoss
      && this.boss.active
      && !this.boss.entering
      && this.currentBossDamageBudget().damageable
    ) {
      candidates.push({
        x: this.boss.mesh.position.x,
        y: this.boss.mesh.position.y,
        id: "boss",
        boss: true,
        distance: Math.hypot(this.boss.mesh.position.x - originX, this.boss.mesh.position.y - originY),
      });
    }

    const target = candidates.sort((first, second) => (
      first.distance - second.distance
      || String(first.id).localeCompare(String(second.id))
    ))[0];
    if (!target) return false;

    const deltaX = target.x - originX;
    const deltaY = target.y - originY;
    const distance = Math.hypot(deltaX, deltaY) || 1;
    projectile.velocityX = deltaX / distance * projectile.speed;
    projectile.velocityY = deltaY / distance * projectile.speed;
    projectile.previousX = originX;
    projectile.previousY = originY;
    projectile.targetBoss = target.boss;
    projectile.targetId = typeof target.id === "number" ? target.id : null;
    projectile.ricochetsRemaining -= 1;
    this.orientProjectileToVelocity(projectile);
    this.spawnImpact(originX, originY, 0xffc062, 0.54);
    return true;
  }

  /** Returns true when the cannon round remains live after this impact. */
  private retainCannonRoundAfterHit(projectile: Projectile): boolean {
    if (projectile.kind !== "player") return false;

    if (projectile.piercingTargetsRemaining > 0) {
      projectile.piercingTargetsRemaining -= 1;
      return true;
    }

    return projectile.ricochetsRemaining > 0 && this.redirectRicochetRound(projectile);
  }

  private resolveCollisions(): void {
    const playerRadius = this.currentPlayerRadius();
    this.resolveCaveCollision(playerRadius);

    for (let projectileIndex = this.playerProjectiles.length - 1; projectileIndex >= 0; projectileIndex -= 1) {
      const projectile = this.playerProjectiles[projectileIndex];

      if (!projectile) {
        continue;
      }

      if (
        this.boss.active &&
        !this.boss.entering &&
        !projectile.hitBoss &&
        segmentCircleOverlap(
          projectile.previousX,
          projectile.previousY,
          projectile.mesh.position.x,
          projectile.mesh.position.y,
          projectile.radius,
          this.boss.mesh.position.x,
          this.boss.mesh.position.y,
          this.boss.radius,
        )
      ) {
        const impactX = projectile.mesh.position.x;
        const impactY = projectile.mesh.position.y;
        const damage = projectile.damage;
        projectile.hitBoss = true;
        projectile.targetBoss = false;
        if (projectile.cryo) {
          this.boss.cryoRemaining = Math.max(this.boss.cryoRemaining, CRYO_SLOW_SECONDS);
        }
        this.damageBoss(damage, impactX, impactY);
        this.applyCannonSecondaryEffects(projectile, impactX, impactY, null, true);
        if (!this.retainCannonRoundAfterHit(projectile)) {
          this.releasePlayerProjectile(projectileIndex);
        }
        continue;
      }

      for (let enemyIndex = this.enemies.length - 1; enemyIndex >= 0; enemyIndex -= 1) {
        const enemy = this.enemies[enemyIndex];

        if (!enemy || projectile.hitEnemyIds.includes(enemy.id)) {
          continue;
        }

        if (!segmentCircleOverlap(
          projectile.previousX,
          projectile.previousY,
          projectile.mesh.position.x,
          projectile.mesh.position.y,
          projectile.radius,
          enemy.mesh.position.x,
          enemy.mesh.position.y,
          enemy.radius,
        )) {
          continue;
        }

        const enemyId = enemy.id;
        const impactX = enemy.mesh.position.x;
        const impactY = enemy.mesh.position.y;
        projectile.hitEnemyIds.push(enemyId);
        projectile.targetId = null;
        enemy.health -= projectile.damage;
        if (projectile.cryo) {
          enemy.cryoRemaining = Math.max(enemy.cryoRemaining, CRYO_SLOW_SECONDS);
        }
        this.spawnImpact(
          impactX,
          impactY,
          PLAYER_FIRE_CYAN,
          0.62,
        );

        if (enemy.health <= 0) {
          this.destroyEnemy(enemyIndex);
        }

        this.applyCannonSecondaryEffects(projectile, impactX, impactY, enemyId, false);
        if (!this.retainCannonRoundAfterHit(projectile)) {
          this.releasePlayerProjectile(projectileIndex);
        }

        break;
      }
    }

    for (let projectileIndex = this.enemyProjectiles.length - 1; projectileIndex >= 0; projectileIndex -= 1) {
      const projectile = this.enemyProjectiles[projectileIndex];

      if (!projectile) {
        continue;
      }

      const projectileCrossedPlayer = movingCirclesOverlap(
        projectile.previousX,
        projectile.previousY,
        projectile.mesh.position.x,
        projectile.mesh.position.y,
        projectile.radius,
        this.previousPlayerX,
        this.previousPlayerY,
        this.player.position.x,
        this.player.position.y,
        playerRadius,
      );

      if (projectileCrossedPlayer) {
        this.releaseEnemyProjectile(projectileIndex);
        this.takeDamage();
      }
    }

    for (let enemyIndex = this.enemies.length - 1; enemyIndex >= 0; enemyIndex -= 1) {
      const enemy = this.enemies[enemyIndex];

      if (!enemy) {
        continue;
      }

      if (segmentCircleOverlap(
        this.previousPlayerX,
        this.previousPlayerY,
        this.player.position.x,
        this.player.position.y,
        playerRadius,
        enemy.mesh.position.x,
        enemy.mesh.position.y,
        enemy.radius,
      )) {
        this.spawnImpact(
          enemy.mesh.position.x,
          enemy.mesh.position.y,
          ARCADE_PALETTE.dangerCrimson,
          1.2,
          "enemy",
        );
        this.releaseEnemy(enemyIndex);
        this.takeDamage();
      }
    }

    if (
      this.boss.active &&
      !this.boss.entering &&
      segmentCircleOverlap(
        this.previousPlayerX,
        this.previousPlayerY,
        this.player.position.x,
        this.player.position.y,
        playerRadius,
        this.boss.mesh.position.x,
        this.boss.mesh.position.y,
        this.boss.radius,
      )
    ) {
      this.takeDamage();
    }

    for (let bonusIndex = this.bonuses.length - 1; bonusIndex >= 0; bonusIndex -= 1) {
      const bonus = this.bonuses[bonusIndex];

      if (!bonus) {
        continue;
      }

      if (circlesOverlap(
        bonus.mesh.position.x,
        bonus.mesh.position.y,
        bonus.radius + (this.attachmentActive("magnet") ? MAGNET_COLLECTION_RADIUS_BONUS : 0),
        this.player.position.x,
        this.player.position.y,
        playerRadius,
      )) {
        this.applyBonus(bonus.kind);
        this.releaseBonus(bonusIndex);
      }
    }
  }

  private firePlayerProjectile(): void {
    const burstActive = this.burstRemaining > 0;
    const plasmaActive = this.plasmaRemaining > 0;
    const targetingActive = this.attachmentActive("targeting");
    const acceleratorActive = this.attachmentActive("accelerator");
    const spreadAngles = this.spreadRemaining > 0 ? [-0.15, 0, 0.15] : [0];
    const volleys = spreadAngles.map((angle) => ({ angle, offset: 0 }));
    const aimTargets: PlayerAimTarget[] = this.enemies.map((enemy) => ({
      id: enemy.id,
      kind: "enemy",
      position: { x: enemy.mesh.position.x, y: enemy.mesh.position.y },
      velocity: { x: enemy.observedVelocityX, y: enemy.observedVelocityY },
      radius: enemy.radius,
      priority: enemyArchetypeForKind(enemy.kind).targetPriority * (enemy.elite ? 1.2 : 1),
      damageable: true,
      visible: enemy.mesh.visible
        && enemy.mesh.position.x + enemy.radius >= this.camera.left
        && enemy.mesh.position.x - enemy.radius <= this.camera.right
        && enemy.mesh.position.y + enemy.radius >= this.camera.bottom
        && enemy.mesh.position.y - enemy.radius <= this.camera.top,
    }));

    if (this.boss.active && !this.boss.entering && this.boss.mesh.visible) {
      const damageBudget = this.currentBossDamageBudget();
      aimTargets.push({
        id: "boss",
        kind: "boss",
        position: { x: this.boss.mesh.position.x, y: this.boss.mesh.position.y },
        velocity: { x: this.boss.observedVelocityX, y: this.boss.observedVelocityY },
        radius: this.boss.radius,
        priority: 10,
        damageable: damageBudget.damageable,
        visible: this.boss.mesh.position.x + this.boss.radius >= this.camera.left
          && this.boss.mesh.position.x - this.boss.radius <= this.camera.right
          && this.boss.mesh.position.y + this.boss.radius >= this.camera.bottom
          && this.boss.mesh.position.y - this.boss.radius <= this.camera.top,
      });
    }

    if (this.droneRemaining > 0) {
      volleys.push({ angle: -0.055, offset: -1.05 }, { angle: 0.055, offset: 1.05 });
    }

    const playerCannonProjectileCap = 84 - (
      this.guardianWingRemaining > 0 ? GUARDIAN_WING_RESERVED_PROJECTILE_SLOTS : 0
    );
    for (const volley of volleys) {
      if (this.playerProjectiles.length >= playerCannonProjectileCap) {
        break;
      }

      const projectile = this.checkoutProjectile("player");
      const hardpoint = volley.offset === 0 ? this.playerShotSide * 0.5 : volley.offset;
      projectile.mesh.position.set(this.player.position.x + hardpoint, this.player.position.y + 0.74, 1.8);
      const projectileSpeed = (this.rapidFireRemaining > 0 ? 23 : 18)
        * (burstActive ? 1.18 : 1)
        * (this.overdriveRemaining > 0 ? 1.12 : 1)
        * (acceleratorActive ? ACCELERATOR_PROJECTILE_SPEED_MULTIPLIER : 1);
      const aim = selectPlayerCannonAim({
        origin: { x: projectile.mesh.position.x, y: projectile.mesh.position.y },
        projectileSpeed,
        targets: aimTargets,
        targetTimeScale: this.currentHostileTimeScale(),
      }, targetingActive
        ? {
            ...PLAYER_AIM_TUNING,
            maximumLeadSeconds: TARGETING_MAXIMUM_LEAD_SECONDS,
            maximumAimAngleRadians: TARGETING_MAXIMUM_AIM_ANGLE_RADIANS,
          }
        : PLAYER_AIM_TUNING);
      const scatterAngle = burstActive
        ? this.randomRange(-BURST_SCATTER_RADIANS, BURST_SCATTER_RADIANS)
        : 0;
      const firingAngle = aim.angleRadians + volley.angle + scatterAngle;
      projectile.velocityX = Math.sin(firingAngle) * projectileSpeed;
      projectile.velocityY = Math.cos(firingAngle) * projectileSpeed;
      projectile.velocityZ = 0;
      projectile.radius = plasmaActive ? 0.31 : burstActive ? 0.22 : 0.16;
      projectile.age = 0;
      projectile.speed = projectileSpeed;
      projectile.previousX = projectile.mesh.position.x;
      projectile.previousY = projectile.mesh.position.y;
      // The dash buff is ten times the firing cadence. Keeping per-round damage
      // stable makes the advertised burst 10x overall instead of compounding
      // cadence and damage into an accidental 100x boss eraser.
      projectile.damage = (plasmaActive ? 3 : 1)
        * (this.overdriveRemaining > 0 ? 1.5 : 1);
      projectile.targetId = aim.targetKind === "enemy" && typeof aim.targetId === "number"
        ? aim.targetId
        : null;
      projectile.targetBoss = aim.targetKind === "boss";
      projectile.piercingTargetsRemaining = this.attachmentActive("piercing")
        ? PIERCING_EXTRA_TARGETS
        : 0;
      projectile.ricochetsRemaining = this.attachmentActive("ricochet")
        ? RICOCHET_REDIRECTS
        : 0;
      projectile.chainLightning = this.attachmentActive("chain-lightning");
      projectile.explosive = this.attachmentActive("explosive");
      projectile.cryo = this.attachmentActive("cryo");
      projectile.targetingSteering = targetingActive;
      const widthScale = (burstActive ? 2.35 : 1) * (plasmaActive ? 1.65 : 1);
      const lengthScale = (burstActive ? 1.25 : 1) * (plasmaActive ? 1.15 : 1);
      const headScale = (burstActive ? 1.35 : 1)
        * (plasmaActive ? 1.45 : 1)
        * (acceleratorActive ? 1.22 : 1);
      this.orientProjectileToVelocity(projectile);
      this.scaleCometVisual(projectile, headScale, widthScale, lengthScale);
      projectile.mesh.visible = true;
      this.playerProjectiles.push(projectile);
      this.scene.add(projectile.mesh);
    }

    this.playerShotSide *= -1;
  }

  private firePlayerMissileSalvo(): boolean {
    const activeMissiles = this.playerProjectiles.filter((projectile) => projectile.kind === "player-missile").length;
    const rackActive = this.attachmentActive("missile-rack");
    const salvoCount = rackActive ? MISSILE_RACK_SALVO_COUNT : MAX_PLAYER_MISSILES_PER_SALVO;

    if (activeMissiles > 0 || this.playerProjectiles.length > 84 - salvoCount) {
      return false;
    }

    const missileDamage = MISSILE_DAMAGE
      * (this.overdriveRemaining > 0 ? 1.5 : 1)
      * (rackActive ? MISSILE_RACK_DAMAGE_MULTIPLIER : 1);
    const assignments = allocatePlayerMissileTargets(
      this.playerMissileTargets(),
      missileDamage,
      Math.min(salvoCount, MAX_PLAYER_MISSILES_PER_SALVO),
    );

    if (assignments.length === 0) {
      return false;
    }

    for (let index = 0; index < salvoCount; index += 1) {
      const ratio = salvoCount <= 1 ? 0.5 : index / (salvoCount - 1);
      const assignment = assignments[index % assignments.length];

      const projectile = this.checkoutProjectile("player-missile");
      const angle = (ratio - 0.5) * (rackActive ? 0.82 : 0.6);
      projectile.mesh.position.set(
        this.player.position.x + (ratio - 0.5) * (rackActive ? 1.9 : 1.56) * this.player.scale.x,
        this.player.position.y + 0.55 * this.player.scale.y,
        1.9,
      );
      projectile.velocityX = Math.sin(angle) * MISSILE_SPEED;
      projectile.velocityY = Math.cos(angle) * MISSILE_SPEED;
      projectile.velocityZ = 0;
      projectile.radius = 0.28;
      projectile.age = 0;
      projectile.speed = MISSILE_SPEED;
      projectile.previousX = projectile.mesh.position.x;
      projectile.previousY = projectile.mesh.position.y;
      projectile.damage = missileDamage;
      projectile.targetBoss = assignment?.targetKind === "boss";
      projectile.targetId = assignment?.targetKind === "enemy" && typeof assignment.targetId === "number"
        ? assignment.targetId
        : null;
      this.orientProjectileToVelocity(projectile);
      projectile.mesh.scale.setScalar(1);
      projectile.mesh.visible = true;
      this.playerProjectiles.push(projectile);
      this.scene.add(projectile.mesh);
    }

    return true;
  }

  private applyPlayerLaserDamage(startY: number, endY: number): void {
    const baseDamage = (this.burstRemaining > 0 ? BURST_DAMAGE_MULTIPLIER : 1)
      * (this.beamRemaining > 0 ? 2 : 1)
      * (this.plasmaRemaining > 0 ? 1.5 : 1)
      * (this.overdriveRemaining > 0 ? 1.5 : 1);
    const lowProfileActive = this.lowProfileRemaining > 0;
    const laserX = this.player.position.x;

    if (
      this.boss.active &&
      !this.boss.entering &&
      segmentCircleOverlap(laserX, startY, laserX, endY, 0.16, this.boss.mesh.position.x, this.boss.mesh.position.y, this.boss.radius)
    ) {
      if (lowProfileActive && this.lowProfileBossLaserHitAvailable) {
        this.lowProfileBossDamagePending += laserDamageForBoss(
          baseDamage,
          this.boss.maxHealth,
          true,
        );
        this.lowProfileBossLaserHitAvailable = false;
      } else if (!lowProfileActive && this.lowProfileBossDamagePending <= 0) {
        this.damageBoss(
          laserDamageForBoss(baseDamage, this.boss.maxHealth, false),
          laserX,
          this.boss.mesh.position.y,
        );
      }
    }

    for (let enemyIndex = this.enemies.length - 1; enemyIndex >= 0; enemyIndex -= 1) {
      const enemy = this.enemies[enemyIndex];

      if (!enemy || !segmentCircleOverlap(
        laserX,
        startY,
        laserX,
        endY,
        0.16,
        enemy.mesh.position.x,
        enemy.mesh.position.y,
        enemy.radius,
      )) {
        continue;
      }

      enemy.health -= laserDamageForTarget(
        baseDamage,
        enemy.health,
        enemy.maxHealth,
        lowProfileActive,
      );
      this.spawnImpact(enemy.mesh.position.x, enemy.mesh.position.y, PLAYER_FIRE_CYAN, 0.42);

      if (enemy.health <= 0) {
        this.destroyEnemy(enemyIndex);
      }
    }
  }

  /**
   * Pays a shrink-laser strike through the currently open boss-health tranche.
   * Escort gates may defer credit, but can never erase it or let it skip a wave.
   */
  private drainLowProfileBossDamage(): void {
    if (this.lowProfileBossDamagePending <= 0) {
      return;
    }
    if (!this.boss.active) {
      this.lowProfileBossDamagePending = 0;
      return;
    }
    if (this.boss.entering) {
      return;
    }

    const budget = this.currentBossDamageBudget();
    const requestedDamage = Math.min(
      this.lowProfileBossDamagePending,
      budget.damageBudget,
    );
    if (requestedDamage <= 0) {
      return;
    }

    const appliedDamage = this.damageBoss(
      requestedDamage,
      this.boss.mesh.position.x,
      this.boss.mesh.position.y,
    );
    if (!this.boss.active) {
      this.lowProfileBossDamagePending = 0;
      return;
    }
    this.lowProfileBossDamagePending = remainingBossLaserStrikeDamage(
      this.lowProfileBossDamagePending,
      appliedDamage,
    );
  }

  private hostileAimJitter(): number {
    return (this.gameplayRandom() - 0.5)
      * (2.8 - this.difficulty.terminalProgress * 1.4)
      * ENEMY_PRESSURE_TUNING.aimJitterScale;
  }

  private hostileTargetAngle(
    originX: number,
    originY: number,
    horizontalOffset = 0,
    horizontalJitter = 0,
  ): number {
    const targetX = this.player.position.x
      + this.playerVelocityX * ENEMY_PRESSURE_TUNING.horizontalAimLeadSeconds
      + horizontalOffset
      + horizontalJitter;
    const targetY = this.player.position.y
      + this.playerVelocityY * ENEMY_PRESSURE_TUNING.verticalAimLeadSeconds;
    return Math.atan2(targetY - originY, targetX - originX);
  }

  private fireEnemyProjectile(enemy: Enemy): void {
    const rules = enemyArchetypeForKind(enemy.kind);
    const projectileSpeed = this.hostileProjectileSpeed(this.difficulty.enemyProjectileSpeed);
    const angle = this.hostileTargetAngle(
      enemy.mesh.position.x,
      enemy.mesh.position.y,
      0,
      this.hostileAimJitter(),
    );
    const progressTier = Math.min(3, Math.floor(this.difficulty.terminalProgress * 4));
    const patternTier = Math.min(3, progressTier + (enemy.elite ? 1 : 0));
    let fired = false;

    const weaponFamily = rules.weaponFamily;
    switch (weaponFamily) {
      case "twin-cannon": {
        const pairCount = this.hostileVolleyCount(1 + Math.ceil(patternTier / 2));
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
          const spread = (0.035 + pairIndex * 0.062)
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x - 0.24,
            enemy.mesh.position.y - 0.7,
            angle - spread,
            projectileSpeed * (0.92 + pairIndex * 0.035),
          ) || fired;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x + 0.24,
            enemy.mesh.position.y - 0.7,
            angle + spread,
            projectileSpeed * (0.92 + pairIndex * 0.035),
          ) || fired;
        }
        break;
      }
      case "aimed-bolt": {
        const shotCount = this.hostileVolleyCount(1 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          const offset = (shotIndex - (shotCount - 1) / 2)
            * 0.052
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.7,
            angle + offset,
            projectileSpeed * (1.08 + Math.abs(offset) * 0.12),
          ) || fired;
        }
        break;
      }
      case "burst-cannon": {
        const shotCount = this.hostileVolleyCount(3 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          const offset = (shotIndex - (shotCount - 1) / 2)
            * 0.11
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.65,
            angle + offset,
            projectileSpeed * 1.12,
            "phase",
          ) || fired;
        }
        break;
      }
      case "gravity-bomb": {
        const shotCount = this.hostileVolleyCount(1 + patternTier);
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          const offset = (shotIndex - (shotCount - 1) / 2)
            * 0.14
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.82,
            angle + offset,
            projectileSpeed * (0.48 + Math.abs(offset) * 0.08),
            "heavy",
          ) || fired;
        }
        break;
      }
      case "spread-cannon": {
        const shotCount = this.hostileVolleyCount(5 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          const ratio = shotCount > 1 ? shotIndex / (shotCount - 1) : 0.5;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.78,
            angle + (ratio - 0.5)
              * (0.76 + patternTier * 0.08)
              * ENEMY_PRESSURE_TUNING.volleySpreadScale,
            projectileSpeed * 0.88,
            "heavy",
          ) || fired;
        }
        break;
      }
      case "rail-shot":
        fired = this.fireEnemyProjectileAtAngle(
          enemy.mesh.position.x,
          enemy.mesh.position.y - 1.15,
          angle,
          projectileSpeed * 1.65,
          "rail",
        ) || fired;
        if (patternTier > 0) {
          const escortSpread = (0.1 + patternTier * 0.045)
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x - 0.28,
            enemy.mesh.position.y - 0.82,
            angle - escortSpread,
            projectileSpeed * 1.08,
            "phase",
          ) || fired;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x + 0.28,
            enemy.mesh.position.y - 0.82,
            angle + escortSpread,
            projectileSpeed * 1.08,
            "phase",
          ) || fired;
        }
        break;
      case "proximity-blast": {
        const shotCount = this.hostileVolleyCount(8 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y,
            shotIndex / shotCount * Math.PI * 2 + enemy.weaponIndex * 0.11,
            projectileSpeed * 0.55,
            "mine",
          ) || fired;
        }
        break;
      }
      case "drone-swarm":
        fired = this.fireEnemyRocketFrom(enemy.mesh.position.x - 0.48, enemy.mesh.position.y - 0.55) || fired;
        fired = this.fireEnemyRocketFrom(enemy.mesh.position.x + 0.48, enemy.mesh.position.y - 0.55) || fired;
        const droneShotCount = patternTier > 0
          ? this.hostileVolleyCount(patternTier * 2)
          : 0;
        for (let shotIndex = 0; shotIndex < droneShotCount; shotIndex += 1) {
          const offset = (shotIndex - (droneShotCount - 1) / 2)
            * 0.12
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.62,
            angle + offset,
            projectileSpeed * 0.86,
            "phase",
          ) || fired;
        }
        break;
      case "phase-bolt": {
        const shotCount = this.hostileVolleyCount(2 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          const offset = (shotIndex - (shotCount - 1) / 2)
            * 0.2
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.7,
            angle + offset * Math.sin(enemy.weaponIndex * 1.7),
            projectileSpeed * 1.18,
            "phase",
          ) || fired;
        }
        break;
      }
      case "arc-burst": {
        const shotCount = this.hostileVolleyCount(4 + patternTier * 2);
        const arcDirection = enemy.weaponIndex % 2 === 0 ? -1 : 1;
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          const ratio = shotCount > 1 ? shotIndex / (shotCount - 1) : 0.5;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.72,
            angle + (ratio - 0.5) * (0.74 + patternTier * 0.08) * arcDirection,
            projectileSpeed * (0.9 + ratio * 0.22),
            "arc",
          ) || fired;
        }
        break;
      }
      case "shield-barrage": {
        const shotCount = this.hostileVolleyCount(4 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          const ratio = shotCount > 1 ? shotIndex / (shotCount - 1) : 0.5;
          const originOffset = shotIndex % 2 === 0 ? -0.72 : 0.72;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x + originOffset,
            enemy.mesh.position.y - 0.42,
            angle + (ratio - 0.5) * 0.5 * ENEMY_PRESSURE_TUNING.volleySpreadScale,
            projectileSpeed * 0.72,
            "heavy",
          ) || fired;
        }
        fired = this.fireEnemyProjectileAtAngle(
          enemy.mesh.position.x,
          enemy.mesh.position.y - 0.68,
          angle,
          projectileSpeed * 0.48,
          "tether",
        ) || fired;
        break;
      }
      case "blink-volley": {
        const echoX = clampNumber(
          this.player.position.x * 2 - enemy.mesh.position.x,
          WORLD_LEFT + 0.6,
          WORLD_RIGHT - 0.6,
        );
        const shotCount = this.hostileVolleyCount(2 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < shotCount; shotIndex += 1) {
          const ratio = shotCount > 1 ? shotIndex / (shotCount - 1) : 0.5;
          const originX = shotIndex % 2 === 0 ? enemy.mesh.position.x : echoX;
          const originY = enemy.mesh.position.y - (shotIndex % 2 === 0 ? 0.65 : 0.2);
          fired = this.fireEnemyProjectileAtAngle(
            originX,
            originY,
            this.hostileTargetAngle(originX, originY) + (ratio - 0.5) * 0.36,
            projectileSpeed * 1.16,
            "phase",
          ) || fired;
        }
        break;
      }
      case "siphon-beam": {
        const beamCount = this.hostileVolleyCount(3 + patternTier);
        for (let shotIndex = 0; shotIndex < beamCount; shotIndex += 1) {
          const centerOffset = shotIndex - (beamCount - 1) / 2;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.86,
            angle + centerOffset * 0.025,
            projectileSpeed * (1.08 + shotIndex * 0.16),
            shotIndex === Math.floor(beamCount / 2) ? "tether" : "rail",
          ) || fired;
        }
        break;
      }
      case "fork-missiles":
        fired = this.fireEnemyRocketFrom(enemy.mesh.position.x - 0.62, enemy.mesh.position.y - 0.48) || fired;
        fired = this.fireEnemyRocketFrom(enemy.mesh.position.x + 0.62, enemy.mesh.position.y - 0.48) || fired;
        for (const forkOffset of [-0.38, 0.38]) {
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.66,
            angle + forkOffset,
            projectileSpeed * 0.94,
            "arc",
          ) || fired;
        }
        break;
      case "tether-shot": {
        const tetherCount = this.hostileVolleyCount(3 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < tetherCount; shotIndex += 1) {
          const offset = (shotIndex - (tetherCount - 1) / 2)
            * 0.13
            * ENEMY_PRESSURE_TUNING.volleySpreadScale;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.7,
            angle + offset,
            projectileSpeed * (0.58 + Math.abs(offset) * 0.1),
            "tether",
          ) || fired;
        }
        break;
      }
      case "shockwave-cannon": {
        const shockCount = this.hostileVolleyCount(8 + patternTier * 2);
        for (let shotIndex = 0; shotIndex < shockCount; shotIndex += 1) {
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.2,
            shotIndex / shockCount * Math.PI * 2 + enemy.weaponIndex * 0.16,
            projectileSpeed * 0.5,
            "mine",
          ) || fired;
        }
        fired = this.fireEnemyProjectileAtAngle(
          enemy.mesh.position.x,
          enemy.mesh.position.y - 0.95,
          angle,
          projectileSpeed * 1.36,
          "heavy",
        ) || fired;
        break;
      }
      case "cloak-torpedo":
        fired = this.fireEnemyRocketFrom(enemy.mesh.position.x, enemy.mesh.position.y - 0.76) || fired;
        fired = this.fireEnemyProjectileAtAngle(
          enemy.mesh.position.x - 0.38,
          enemy.mesh.position.y - 0.54,
          angle - 0.26,
          projectileSpeed * 1.28,
          "phase",
        ) || fired;
        fired = this.fireEnemyProjectileAtAngle(
          enemy.mesh.position.x + 0.38,
          enemy.mesh.position.y - 0.54,
          angle + 0.26,
          projectileSpeed * 1.28,
          "phase",
        ) || fired;
        break;
      case "time-shard": {
        const shardCount = this.hostileVolleyCount(3 + patternTier * 2);
        const direction = enemy.weaponIndex % 2 === 0 ? 1 : -1;
        for (let shotIndex = 0; shotIndex < shardCount; shotIndex += 1) {
          const ratio = shardCount > 1 ? shotIndex / (shardCount - 1) : 0.5;
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.62,
            angle + (ratio - 0.5) * 0.64 * direction,
            projectileSpeed * (0.82 + ratio * 0.38),
            "temporal",
          ) || fired;
        }
        break;
      }
      case "support-drones": {
        if (this.enemies.length + 2 <= this.difficulty.maxEnemies) {
          for (const side of [-1, 1]) {
            this.spawnEnemyUnit(
              "chronodrone",
              0,
              1,
              enemy.mesh.position.x + side * 1.15,
              {
                elite: false,
                spawnY: enemy.mesh.position.y + 0.45,
                bossEscort: enemy.bossEscort,
              },
            );
          }
        }
        for (const offset of [-0.18, 0.18]) {
          fired = this.fireEnemyProjectileAtAngle(
            enemy.mesh.position.x,
            enemy.mesh.position.y - 0.72,
            angle + offset,
            projectileSpeed * 0.9,
            "temporal",
          ) || fired;
        }
        break;
      }
      case "collision":
        return;
      default: {
        const exhaustiveWeapon: never = weaponFamily;
        throw new Error(`Unsupported enemy weapon family: ${exhaustiveWeapon}`);
      }
    }

    if (fired) {
      this.spawnImpactBurst(
        enemy.mesh.position.x,
        enemy.mesh.position.y - 0.7,
        ARCADE_PALETTE.telegraphOrange,
        0.32 + patternTier * 0.035,
        ENEMY_MUZZLE_IMPACT_BASE + Math.ceil(patternTier / 2),
        0.12 + patternTier * 0.035,
        "enemy",
      );
    }
  }

  private fireEnemyProjectileAtAngle(
    x: number,
    y: number,
    angle: number,
    projectileSpeed: number,
    style: EnemyShotStyle = "bolt",
  ): boolean {
    if (this.enemyProjectiles.length >= this.hostileProjectileCap()) {
      return false;
    }

    const velocityX = Math.cos(angle) * projectileSpeed;
    const velocityY = Math.sin(angle) * projectileSpeed;

    const radius = style === "heavy"
      ? 0.34
      : style === "rail"
        ? 0.14
        : style === "mine"
          ? 0.38
          : style === "phase"
            ? 0.24
            : style === "arc"
              ? 0.18
              : style === "tether"
                ? 0.32
                : style === "temporal"
                  ? 0.22
                  : 0.2;

    if (!this.hostileProjectileLeavesEscapeRoute(x, y, velocityX, velocityY, radius)) {
      return false;
    }

    const projectile = this.checkoutProjectile("enemy");
    const originZ = style === "rail"
      ? 0.82
      : style === "mine"
        ? 0.18
        : style === "tether"
          ? 0.3
          : style === "temporal"
            ? 0.72
            : 0.48;
    const distanceToPlayer = Math.hypot(this.player.position.x - x, this.player.position.y - y);
    const flightSeconds = Math.max(0.16, distanceToPlayer / Math.max(0.1, projectileSpeed));
    projectile.mesh.position.set(x, y, originZ);
    projectile.velocityX = velocityX;
    projectile.velocityY = velocityY;
    projectile.velocityZ = (this.player.position.z - originZ) / flightSeconds;
    projectile.radius = radius;
    projectile.age = 0;
    projectile.speed = projectileSpeed;
    projectile.previousX = x;
    projectile.previousY = y;
    projectile.damage = 1;
    projectile.targetId = null;
    projectile.targetBoss = false;
    projectile.style = style;
    this.orientProjectileToVelocity(projectile);
    if (style === "rail") {
      this.scaleCometVisual(projectile, 0.72, 0.62, 1.75);
    } else if (style === "heavy") {
      this.scaleCometVisual(projectile, 1.75, 1.75, 1.25);
    } else if (style === "mine") {
      this.scaleCometVisual(projectile, 1.9, 1.4, 0.65);
    } else if (style === "phase") {
      this.scaleCometVisual(projectile, 1.25, 1.25, 0.8);
    } else if (style === "arc") {
      this.scaleCometVisual(projectile, 0.9, 0.65, 1.4);
    } else if (style === "tether") {
      this.scaleCometVisual(projectile, 1.55, 2.1, 0.55);
    } else if (style === "temporal") {
      this.scaleCometVisual(projectile, 1.15, 0.85, 1.7);
    } else {
      this.scaleCometVisual(projectile, 1, 1, 1);
    }
    projectile.mesh.visible = true;
    this.enemyProjectiles.push(projectile);
    this.scene.add(projectile.mesh);
    return true;
  }

  private fireEnemyRocket(enemy: Enemy): void {
    this.fireEnemyRocketFrom(enemy.mesh.position.x, enemy.mesh.position.y - 0.65);
  }

  private fireEnemyRocketFrom(x: number, y: number): boolean {
    if (
      this.enemyProjectiles.length >= this.hostileProjectileCap() ||
      this.activeRocketCount() >= this.hostileRocketCap()
    ) {
      return false;
    }

    const horizontalDistance = this.player.position.x - x;
    const verticalDistance = this.player.position.y - y;
    const distance = Math.hypot(horizontalDistance, verticalDistance) || 1;
    const projectileSpeed = this.hostileProjectileSpeed(
      Math.max(
        4.5,
        this.difficulty.enemyProjectileSpeed
          * 0.72
          * ENEMY_PRESSURE_TUNING.rocketSpeedScale,
      ),
    );
    const velocityX = horizontalDistance / distance * projectileSpeed;
    const velocityY = verticalDistance / distance * projectileSpeed;

    if (!this.hostileProjectileLeavesEscapeRoute(x, y, velocityX, velocityY, 0.3)) {
      return false;
    }

    const projectile = this.checkoutProjectile("rocket");
    const originZ = 0.52;
    const flightSeconds = Math.max(0.25, distance / Math.max(0.1, projectileSpeed));
    projectile.mesh.position.set(x, y, originZ);
    projectile.velocityX = velocityX;
    projectile.velocityY = velocityY;
    projectile.velocityZ = (this.player.position.z - originZ) / flightSeconds;
    this.orientProjectileToVelocity(projectile);
    projectile.radius = 0.3;
    projectile.age = 0;
    projectile.speed = projectileSpeed;
    projectile.previousX = x;
    projectile.previousY = y;
    projectile.damage = 1;
    projectile.targetId = null;
    projectile.targetBoss = false;
    projectile.mesh.scale.setScalar(1);
    projectile.mesh.visible = true;
    const flame = projectile.mesh.userData.flame as THREE.Mesh;
    flame.scale.set(1, 1, 1);
    this.enemyProjectiles.push(projectile);
    this.scene.add(projectile.mesh);
    this.spawnImpactBurst(
      projectile.mesh.position.x,
      projectile.mesh.position.y,
      ARCADE_PALETTE.telegraphOrange,
      0.44,
      ROCKET_LAUNCH_IMPACT_COUNT,
      0.18,
      "enemy",
    );
    return true;
  }

  private hostileProjectileLeavesEscapeRoute(
    originX: number,
    originY: number,
    velocityX: number,
    velocityY: number,
    radius: number,
  ): boolean {
    if (isTerminalPressureUnbounded(this.difficulty.terminalProgress)) {
      return true;
    }

    const hostileTimeScale = this.currentHostileTimeScale();
    const projectileSpeed = Math.hypot(velocityX, velocityY) * hostileTimeScale;
    const playerRadius = this.currentPlayerRadius();
    const distanceToPlayer = Math.hypot(this.player.position.x - originX, this.player.position.y - originY);

    const reactionWindow = 0.38 - this.difficulty.terminalProgress * 0.3;

    if (distanceToPlayer - playerRadius - radius < projectileSpeed * reactionWindow) {
      return false;
    }

    const bounds = this.playerBounds(playerRadius);
    const candidateCount = 16;
    const threats = this.enemyProjectiles.map((projectile) => ({
      x: projectile.mesh.position.x,
      y: projectile.mesh.position.y,
      velocityX: projectile.velocityX * hostileTimeScale,
      velocityY: projectile.velocityY * hostileTimeScale,
      radius: projectile.radius,
    }));
    threats.push({
      x: originX,
      y: originY,
      velocityX: velocityX * hostileTimeScale,
      velocityY: velocityY * hostileTimeScale,
      radius,
    });

    for (let candidateIndex = 0; candidateIndex <= candidateCount; candidateIndex += 1) {
      const angle = candidateIndex / candidateCount * Math.PI * 2;
      const movementX = candidateIndex === candidateCount ? 0 : Math.cos(angle);
      const movementY = candidateIndex === candidateCount ? 0 : Math.sin(angle);
      let safe = true;

      for (let step = 1; step <= 10 && safe; step += 1) {
        const elapsed = step * 0.08;
        const playerX = clampNumber(
          this.player.position.x + movementX * this.currentPlayerCruiseSpeed() * elapsed,
          bounds.left,
          bounds.right,
        );
        const playerY = clampNumber(
          this.player.position.y + movementY * this.currentPlayerCruiseSpeed() * elapsed,
          bounds.bottom,
          bounds.top,
        );
        const cave = sampleCaveCorridor(
          this.caveTravel + this.difficulty.scrollSpeed * this.currentWorldTimeScale() * elapsed,
          playerY,
          this.caveDifficultySector,
        );
        if (caveWallClearance(cave, playerX, playerRadius + 0.12, 0) <= 0) {
          safe = false;
          break;
        }

        for (const threat of threats) {
          if (circlesOverlap(
            playerX,
            playerY,
            playerRadius + 0.12,
            threat.x + threat.velocityX * elapsed,
            threat.y + threat.velocityY * elapsed,
            threat.radius,
          )) {
            safe = false;
            break;
          }
        }
      }

      if (safe) {
        return true;
      }
    }

    const unsafeAdmissionChance = unsafeRouteAdmissionChance(
      this.difficulty.terminalProgress,
    );
    return unsafeAdmissionChance > 0
      && this.gameplayRandom() < unsafeAdmissionChance;
  }

  private activeRocketCount(): number {
    let count = 0;

    for (const projectile of this.enemyProjectiles) {
      if (projectile.kind === "rocket") {
        count += 1;
      }
    }

    return count;
  }

  private applyBonus(kind: BonusKind): void {
    this.spawnImpact(this.player.position.x, this.player.position.y + 0.4, this.bonusColor(kind), 1.25);

    switch (kind) {
      case "shield":
        this.shielded = true;
        this.announcement = "Shield online";
        break;
      case "rapid":
        this.rapidFireRemaining = Math.max(this.rapidFireRemaining, bonusDurationSeconds(kind));
        this.announcement = "Rapid fire engaged";
        break;
      case "pulse":
        if (this.lives < 3) {
          this.lives += 1;
          this.announcement = "Hull repaired";
        } else if (!this.shielded) {
          this.shielded = true;
          this.announcement = "Repair converted to shield";
        } else {
          this.rapidFireRemaining = Math.max(this.rapidFireRemaining, 4);
          this.announcement = "Repair energy boosted cannon";
        }
        break;
      case "spread":
        this.spreadRemaining = Math.max(this.spreadRemaining, bonusDurationSeconds(kind));
        this.announcement = "Three-way scatter cannon";
        break;
      case "plasma":
        this.plasmaRemaining = Math.max(this.plasmaRemaining, bonusDurationSeconds(kind));
        this.announcement = "Heavy plasma rounds";
        break;
      case "missile":
        this.missileCooldownRemaining = 0;
        this.tryMissiles("crate");
        break;
      case "beam":
        this.beamRemaining = Math.max(this.beamRemaining, bonusDurationSeconds(kind));
        this.laserDamageCooldown = 0;
        this.announcement = "Continuous laser beam";
        break;
      case "drone":
        this.droneRemaining = Math.max(this.droneRemaining, bonusDurationSeconds(kind));
        this.announcement = "Wing drones deployed";
        break;
      case "overdrive":
        this.overdriveRemaining = Math.max(this.overdriveRemaining, bonusDurationSeconds(kind));
        this.announcement = "Overdrive online";
        break;
      case "stasis":
        this.stasisRemaining = Math.max(this.stasisRemaining, bonusDurationSeconds(kind));
        this.announcement = "Hostile time stasis";
        break;
      case "piercing":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Piercing jacket · rounds pass through two targets";
        break;
      case "ricochet":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Ricochet matrix · spent rounds retarget once";
        break;
      case "chain-lightning":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Arc coupler · three-target lightning chains";
        break;
      case "explosive":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Blast warheads · cannon impacts splash";
        break;
      case "cryo":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Cryo injector · movement and guns frozen";
        break;
      case "targeting":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Predictive optics · extended lead and steering";
        break;
      case "accelerator":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Rail accelerator · 1.7× cannon velocity";
        break;
      case "afterburner":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Afterburner vanes · 1.45× flight authority";
        break;
      case "phase-hull":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Phase hull · collision profile reduced";
        break;
      case "magnet":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Magnet scoop · nearby crates pulled in";
        break;
      case "nanorepair":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Nanorepair loom · five kills feed hull charge";
        break;
      case "missile-rack":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Missile rack · eight double-damage missiles";
        break;
      case "bomb-amplifier":
        this.activateAdvancedAttachment(kind);
        this.announcement = "Bomb amplifier · 2× damage and 1.5× radius";
        break;
      case "counterflare":
      case "gravity-knot":
      case "phoenix-squadron":
        this.applyAbilityCore(kind);
        break;
    }

    this.sectorAnnouncementRemaining = 1.15;
    this.publishSnapshot(true);
  }

  private applyAbilityCore(kind: JetAbilityKind): void {
    const resolution = resolveAbilityCrate(kind, this.abilityStates[kind], this.shielded);
    this.setAbilityState(kind, resolution.state);
    // A core is guaranteed until it is actually collected. Merely scrolling a
    // spawned crate offscreen no longer marks the system as permanently seen.
    this.abilityCoreCollected[kind] = true;
    const label = JET_ABILITY_SPECS[kind].label;

    if (resolution.grantShield) {
      this.shielded = true;
    }
    if (resolution.score > 0) {
      this.score += resolution.score;
      this.persistBestScore();
    }

    switch (resolution.outcome) {
      case "unlocked":
        this.announcement = `${label} unlocked · ${JET_ABILITY_SPECS[kind].key} ready`;
        break;
      case "recharged":
        this.announcement = `${label} core · instant recharge`;
        break;
      case "reserve-shield":
        this.announcement = `${label} reserve · shield banked`;
        break;
      case "reserve-score":
        this.announcement = `${label} reserve · +${resolution.score}`;
        break;
    }

    for (let index = 0; index < 5; index += 1) {
      const angle = index / 5 * Math.PI * 2;
      this.spawnImpact(
        this.player.position.x + Math.cos(angle) * 1.1,
        this.player.position.y + Math.sin(angle) * 1.1,
        this.bonusColor(kind),
        0.55,
      );
    }
  }

  private bonusColor(kind: BonusKind): THREE.ColorRepresentation {
    return BONUS_COLORS[kind][1];
  }

  private clearRespawnProjectileBubble(x: number, y: number): void {
    for (let index = this.enemyProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.enemyProjectiles[index];

      if (
        projectile
        && Math.hypot(projectile.mesh.position.x - x, projectile.mesh.position.y - y)
          <= RESPAWN_PROJECTILE_CLEAR_RADIUS + projectile.radius
      ) {
        this.releaseEnemyProjectile(index);
      }
    }
  }

  private takeDamage(source: "combat" | "terrain" = "combat"): void {
    if (this.invulnerabilityRemaining > 0 || this.status !== "running") {
      return;
    }

    const outcome = resolveDamage(this.lives, this.shielded);
    this.lives = outcome.lives;
    this.shielded = outcome.shielded;
    this.invulnerabilityRemaining = outcome.lostLife
      ? RESPAWN_INVULNERABILITY_SECONDS
      : 0.78;
    this.spawnImpact(
      this.player.position.x,
      this.player.position.y,
      outcome.lostLife ? ARCADE_PALETTE.dangerCrimson : ARCADE_PALETTE.shieldAzure,
      1.75,
    );
    this.screenShakeRemaining = this.reducedMotion ? 0 : outcome.lostLife ? 0.14 : 0.07;

    if (outcome.lostLife) {
      this.emergencyAssistState = { ...INITIAL_EMERGENCY_ASSIST_STATE };
      this.updatePlayerModeVisuals();
      this.emergencySuperBrain.reset();
      this.brainDecisionCooldown = 0;
      if (!this.autoPilotEnabled) {
        this.brainMode = "Manual control";
      }
      const respawnX = sampleCaveCorridor(
        this.caveTravel,
        PLAYER_START_Y,
        this.caveDifficultySector,
      ).center;
      this.playerX = respawnX;
      this.previousPlayerX = respawnX;
      this.previousPlayerY = PLAYER_START_Y;
      this.playerVelocityX = 0;
      this.playerVelocityY = 0;
      this.player.position.set(respawnX, PLAYER_START_Y, 2);
      this.clearRespawnProjectileBubble(respawnX, PLAYER_START_Y);
      this.caveContactLatched = false;
      this.announcement = outcome.gameOver
        ? "Jet down"
        : source === "terrain"
          ? "Cave impact — respawning"
          : "Hull breach — respawning";
      this.bonusCooldown = Math.min(
        this.bonusCooldown,
        scaledCrateSpawnDelay(3.4, this.activeDifficultyLevel),
      );
    } else {
      this.announcement = source === "terrain"
        ? "Shield scraped the cave wall"
        : "Shield absorbed the hit";
    }

    if (outcome.gameOver) {
      this.status = "game-over";
      this.dashEffectRemaining = 0;
      this.dashRollProgress = 1;
      this.dashTrail.mesh.visible = false;
      this.dismissPilotLine();
      this.persistBestScore();
      this.stopLoop();
    }

    this.sectorAnnouncementRemaining = 1.3;
    this.publishSnapshot(true);
  }

  private recordNanorepairKill(): void {
    if (!this.attachmentActive("nanorepair") || this.nanorepairKillsRemaining <= 0) {
      return;
    }

    const outcome = applyNanorepairKill(
      {
        killsRemaining: this.nanorepairKillsRemaining,
        charge: this.nanorepairCharge,
      },
      this.lives,
      3,
    );
    this.nanorepairKillsRemaining = outcome.killsRemaining;
    this.nanorepairCharge = outcome.charge;

    if (outcome.repairedHull) {
      this.lives = Math.min(3, this.lives + 1);
      this.announcement = "Nanorepair charge restored one hull";
      this.sectorAnnouncementRemaining = Math.max(this.sectorAnnouncementRemaining, 0.95);
      this.spawnImpact(this.player.position.x, this.player.position.y, ARCADE_PALETTE.repairGreen, 1.15);
    }
  }

  private destroyEnemy(index: number): void {
    const enemy = this.enemies[index];

    if (!enemy) {
      return;
    }

    const color = this.enemyKindMaterials[enemy.kind].accent.color.getHex();
    const burstCount = 2
      + (enemy.elite ? 2 : 0)
      + Math.floor(this.difficulty.terminalProgress * 2);
    this.spawnImpactBurst(
      enemy.mesh.position.x,
      enemy.mesh.position.y,
      color,
      enemy.elite ? 1.28 : 1.02,
      burstCount,
      enemy.radius * 0.72,
      "enemy",
    );
    this.spawnImpact(
      enemy.mesh.position.x,
      enemy.mesh.position.y,
      ARCADE_PALETTE.dangerCrimson,
      enemy.elite ? 1.42 : 1.08,
      "enemy",
    );
    this.score += scoreForEnemy(enemy.kind) * (enemy.elite ? 2 : 1);
    this.recordNanorepairKill();
    this.updateSector();
    this.persistBestScore();
    this.screenShakeRemaining = this.reducedMotion ? 0 : Math.max(this.screenShakeRemaining, 0.045);
    this.releaseEnemy(index);
  }

  private damageBoss(damage: number, impactX: number, impactY: number): number {
    if (!this.boss.active || this.boss.entering) {
      return 0;
    }

    const healthBeforeDamage = this.boss.health;
    const damageOutcome = applyBossEscortDamageGate(
      this.boss.health,
      this.boss.maxHealth,
      damage,
      {
        launchedWaves: this.bossEscortProgress.launchedWaves,
        pendingEscortUnits: this.pendingBossEscorts.length,
      },
    );
    this.boss.health = damageOutcome.health;
    this.boss.hitFlashRemaining = 0.08;
    this.spawnImpact(impactX, impactY, PLAYER_FIRE_CYAN, 0.46);
    const nextPhase = bossPhaseForHealth(this.boss.health, this.boss.maxHealth);

    if (nextPhase > this.boss.phase && this.boss.health > 0) {
      this.boss.phase = nextPhase;
      this.boss.attackCooldown = Math.min(
        this.boss.attackCooldown,
        this.hostileFireDelay(0.9),
      );
      this.spawnImpactBurst(
        this.boss.mesh.position.x,
        this.boss.mesh.position.y,
        ARCADE_PALETTE.telegraphOrange,
        1.25 + nextPhase * 0.18,
        4 + nextPhase,
        this.boss.radius * 0.72,
        "enemy",
      );
      const recoveryKind: BonusKind = nextPhase === 2
        ? "rapid"
        : this.shielded
          ? "pulse"
          : "shield";
      this.spawnBonusAt(recoveryKind, this.boss.mesh.position.x, this.boss.mesh.position.y - 1.8);
      this.announcement = nextPhase === 2 ? "Armor broken · rapid crate" : "Final phase · recovery crate";
      this.sectorAnnouncementRemaining = 1.6;
      this.screenShakeRemaining = this.reducedMotion ? 0 : 0.12;
      this.publishSnapshot(true);
    }

    if (this.boss.health <= 0) {
      this.destroyBoss();
    }

    return Math.max(0, healthBeforeDamage - damageOutcome.health);
  }

  private destroyBoss(): void {
    const bossX = this.boss.mesh.position.x;
    const bossY = this.boss.mesh.position.y;
    const reward = bossRewardForSector(this.lastBossSector, this.boss.archetype);

    this.spawnImpactBurst(
      bossX,
      bossY,
      ARCADE_PALETTE.dangerCrimson,
      1.5,
      6,
      2.4,
      "enemy",
    );
    this.spawnImpactBurst(
      bossX,
      bossY,
      ARCADE_PALETTE.telegraphOrange,
      1.2,
      6,
      2.1,
      "enemy",
    );
    this.spawnImpact(bossX, bossY, ARCADE_PALETTE.ivory, 2.25, "enemy");

    this.boss.health = 0;
    this.deactivateBoss();
    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      const enemy = this.enemies[index];
      if (!enemy?.bossEscort) continue;
      this.spawnImpact(enemy.mesh.position.x, enemy.mesh.position.y, ARCADE_PALETTE.counterMint, 0.72);
      this.releaseEnemy(index);
    }
    for (let index = this.enemyProjectiles.length - 1; index >= 0; index -= 1) {
      this.releaseEnemyProjectile(index);
    }
    this.encounterCadence = recordBossDefeat(this.encounterCadence);
    this.normalWaveSpawnRemaining = 0;
    this.normalWaveIntermissionRemaining = 2.2;
    this.score += reward;
    this.updateSector();
    this.persistBestScore();
    this.spawnBonusAt("pulse", bossX, bossY - 1.4);
    this.announcement = `${this.boss.name} destroyed · +${reward}`;
    this.sectorAnnouncementRemaining = 2.2;
    this.screenShakeRemaining = this.reducedMotion ? 0 : 0.3;
    this.spawnCooldown = 2.2;
    this.publishSnapshot(true);
  }

  private updateSector(): void {
    const nextSector = sectorForScore(this.score);

    if (nextSector <= this.sector) {
      return;
    }

    this.sector = nextSector;
    this.difficulty = difficultyForSector(this.sector);
    if (!this.boss.active && !this.bossPending) {
      this.announcement = `Sector ${this.sector} engaged`;
      this.sectorAnnouncementRemaining = 1.3;
    }

    this.publishSnapshot(true);
  }

  private updateImpacts(deltaSeconds: number): void {
    for (let index = this.impacts.length - 1; index >= 0; index -= 1) {
      const impact = this.impacts[index];

      if (!impact) {
        continue;
      }

      impact.age += deltaSeconds;
      const progress = clampNumber(impact.age / impact.duration, 0, 1);
      const fade = (1 - progress) ** 1.35;
      const expansion = 0.4 + progress * (this.reducedMotion ? 1.05 : 1.85);
      impact.mesh.scale.setScalar(impact.scale);
      impact.ring.scale.setScalar(expansion);
      impact.core.scale.setScalar(Math.max(0.08, (1 - progress) * 0.7));
      impact.material.opacity = fade;
      impact.highlightMaterial.opacity = fade * 0.9;
      impact.mesh.rotation.z += deltaSeconds * (this.reducedMotion ? 1.2 : 3.8);

      for (let shardIndex = 0; shardIndex < impact.shards.length; shardIndex += 1) {
        const shard = impact.shards[shardIndex];

        if (!shard || !shard.visible) {
          continue;
        }

        const distance = 0.22
          + progress * (impact.shardSpeeds[shardIndex] ?? 1) * (this.reducedMotion ? 0.58 : 1.45);
        const angle = impact.shardAngles[shardIndex] ?? 0;
        shard.position.set(Math.cos(angle) * distance, Math.sin(angle) * distance, 0.02);
        shard.rotation.z = angle - Math.PI / 2 + progress * (impact.shardSpins[shardIndex] ?? 0);
        const shardScale = Math.max(0.12, 1 - progress * 0.76);
        shard.scale.set(shardScale, 0.7 + fade * 0.8, 1);
      }

      if (progress >= 1) {
        this.releaseImpact(index);
      }
    }
  }

  private updateCameraShake(): void {
    if (this.screenShakeRemaining <= 0 || this.reducedMotion) {
      this.camera.position.set(0, 0, 20);
      this.backgroundGroup.position.set(0, 0, 0);
      return;
    }

    const strength = this.screenShakeRemaining * 1.6;
    const shakeX = this.visualRandomRange(-strength, strength);
    const shakeY = this.visualRandomRange(-strength, strength);
    this.camera.position.set(shakeX, shakeY, 20);
    // The camera still shakes combat, but matching the background offset keeps
    // collidable terrain and its depth strata visually stable on screen.
    this.backgroundGroup.position.set(shakeX, shakeY, 0);
  }

  private spawnImpact(
    x: number,
    y: number,
    color: THREE.ColorRepresentation,
    scale: number,
    source: ImpactSource = "neutral",
  ): void {
    const activeImpactLimit = this.reducedMotion
      ? REDUCED_MOTION_MAX_ACTIVE_IMPACTS
      : MAX_ACTIVE_IMPACTS;

    if (this.impacts.length >= activeImpactLimit) {
      this.releaseImpact(0);
    }

    const impact = this.impactPool.pop() ?? this.createImpact();
    impact.age = 0;
    impact.duration = (this.reducedMotion ? 0.2 : 0.24) + Math.min(2.4, scale) * 0.055;
    impact.scale = scale;
    impact.mesh.position.set(x, y, 3);
    impact.mesh.rotation.z = this.visualRandomRange(0, Math.PI);
    impact.mesh.scale.setScalar(scale);
    impact.ring.scale.setScalar(0.4);
    impact.core.scale.setScalar(0.7);
    impact.material.color.set(color);
    impact.highlightMaterial.color.set(color).lerp(IMPACT_HIGHLIGHT_COLOR, 0.64);
    impact.material.opacity = 1;
    impact.highlightMaterial.opacity = 0.9;

    const sourceShardCount = source === "enemy"
      ? enemyImpactShardCount(impact.shards.length, this.activeDifficultyLevel)
      : impact.shards.length;
    const visibleShardCount = this.reducedMotion
      ? Math.min(4, sourceShardCount)
      : sourceShardCount;

    for (let shardIndex = 0; shardIndex < impact.shards.length; shardIndex += 1) {
      const shard = impact.shards[shardIndex];

      if (!shard) {
        continue;
      }

      const angle = shardIndex / impact.shards.length * Math.PI * 2
        + this.visualRandomRange(-0.18, 0.18);
      impact.shardAngles[shardIndex] = angle;
      impact.shardSpeeds[shardIndex] = this.visualRandomRange(0.76, 1.3);
      impact.shardSpins[shardIndex] = this.visualRandomRange(-1.8, 1.8);
      shard.position.set(Math.cos(angle) * 0.22, Math.sin(angle) * 0.22, 0.02);
      shard.rotation.z = angle - Math.PI / 2;
      shard.scale.set(1, 1.5, 1);
      shard.visible = shardIndex < visibleShardCount;
    }

    impact.mesh.visible = true;
    this.impacts.push(impact);
    this.scene.add(impact.mesh);
  }

  private spawnImpactBurst(
    x: number,
    y: number,
    color: THREE.ColorRepresentation,
    scale: number,
    count: number,
    spread: number,
    source: ImpactSource = "neutral",
  ): void {
    const boundedCount = Math.min(this.reducedMotion ? 1 : 6, Math.max(1, Math.floor(count)));

    for (let index = 0; index < boundedCount; index += 1) {
      const angle = this.visualRandomRange(0, Math.PI * 2);
      const distance = this.visualRandomRange(0, spread);
      this.spawnImpact(
        x + Math.cos(angle) * distance,
        y + Math.sin(angle) * distance,
        color,
        scale * this.visualRandomRange(0.72, 1.15),
        source,
      );
    }
  }

  private orientProjectileToVelocity(projectile: Projectile): void {
    projectile.mesh.rotation.set(
      0,
      0,
      projectileHeadingRadians(
        projectile.velocityX,
        projectile.velocityY,
        projectile.mesh.rotation.z,
      ),
    );
  }

  private scaleCometVisual(
    projectile: Projectile,
    headScale: number,
    tailWidth: number,
    tailLength: number,
  ): void {
    const head = projectile.mesh.userData.cometHead as THREE.Mesh | undefined;
    const tail = projectile.mesh.userData.cometTail as THREE.Mesh | undefined;
    const tailFrontY = projectile.mesh.userData.cometTailFrontY as number | undefined;
    projectile.mesh.scale.setScalar(1);
    head?.scale.setScalar(headScale);
    if (tail) {
      tail.scale.set(tailWidth, tailLength, 1);
      tail.position.y = cometTailOffsetY(tailFrontY ?? 0, tailLength);
    }
  }

  private checkoutProjectile(kind: ProjectileKind): Projectile {
    const pool = kind === "player"
      ? this.playerProjectilePool
      : kind === "player-missile"
        ? this.playerMissilePool
      : kind === "rocket"
        ? this.enemyRocketPool
        : this.enemyProjectilePool;
    const projectile = pool.pop() ?? this.createProjectile(kind);
    projectile.piercingTargetsRemaining = 0;
    projectile.ricochetsRemaining = 0;
    projectile.chainLightning = false;
    projectile.explosive = false;
    projectile.cryo = false;
    projectile.targetingSteering = false;
    projectile.style = "bolt";
    projectile.hitEnemyIds.length = 0;
    projectile.hitBoss = false;
    projectile.rewindAtSeconds = 0;
    return projectile;
  }

  private createProjectile(kind: ProjectileKind): Projectile {
    const mesh = new THREE.Group();

    if (kind === "player") {
      const glow = new THREE.Mesh(this.assets.playerProjectileGlow, this.assets.playerProjectileGlowMaterial);
      const core = new THREE.Mesh(this.assets.playerProjectile, this.assets.playerProjectileMaterial);
      glow.position.set(0, -0.24, -0.02);
      core.position.set(0, 0, 0.08);
      mesh.userData.cometTail = glow;
      mesh.userData.cometHead = core;
      mesh.userData.cometTailFrontY = 0.24;
      mesh.add(glow, core);
    } else if (kind === "player-missile") {
      const glow = new THREE.Mesh(this.assets.playerMissileGlow, this.assets.playerMissileGlowMaterial);
      const body = new THREE.Mesh(this.assets.playerMissile, this.assets.playerMissileMaterial);
      const fins = new THREE.Mesh(this.assets.playerMissileFins, this.assets.playerMissileAccentMaterial);
      const flame = new THREE.Mesh(this.assets.playerMissileFlame, this.assets.playerMissileGlowMaterial);
      glow.position.set(0, -0.24, -0.03);
      body.position.z = 0.08;
      fins.position.set(0, -0.3, 0.11);
      flame.position.set(0, -0.47, 0.1);
      mesh.userData.flame = flame;
      mesh.add(glow, body, fins, flame);
    } else if (kind === "enemy") {
      const glow = new THREE.Mesh(this.assets.enemyProjectileGlow, this.assets.enemyProjectileGlowMaterial);
      const core = new THREE.Mesh(this.assets.enemyProjectile, this.assets.enemyProjectileMaterial);
      glow.position.set(0, -0.28, -0.02);
      core.position.set(0, 0, 0.08);
      mesh.userData.cometTail = glow;
      mesh.userData.cometHead = core;
      mesh.userData.cometTailFrontY = 0.28;
      mesh.add(glow, core);
    } else {
      const glow = new THREE.Mesh(this.assets.enemyRocketGlow, this.assets.enemyRocketGlowMaterial);
      const body = new THREE.Mesh(this.assets.enemyRocket, this.assets.enemyRocketMaterial);
      const fins = new THREE.Mesh(this.assets.enemyRocketFins, this.assets.enemyRocketAccentMaterial);
      const band = new THREE.Mesh(this.assets.enemyRocketFins, this.assets.enemyRocketAccentMaterial);
      const flame = new THREE.Mesh(this.assets.enemyRocketFlame, this.assets.enemyRocketGlowMaterial);
      glow.position.set(0, -0.25, -0.03);
      body.position.z = 0.08;
      fins.position.set(0, -0.31, 0.11);
      band.position.set(0, 0.02, 0.12);
      band.scale.set(0.52, 0.48, 1);
      flame.position.set(0, -0.46, 0.1);
      mesh.userData.flame = flame;
      mesh.add(glow, body, fins, band, flame);
    }

    mesh.visible = false;

    return {
      kind,
      mesh,
      velocityX: 0,
      velocityY: 0,
      velocityZ: 0,
      radius: kind === "player" ? 0.16 : kind === "player-missile" ? 0.28 : kind === "rocket" ? 0.3 : 0.2,
      age: 0,
      speed: 0,
      previousX: 0,
      previousY: 0,
      damage: 1,
      targetId: null,
      targetBoss: false,
      style: "bolt",
      piercingTargetsRemaining: 0,
      ricochetsRemaining: 0,
      chainLightning: false,
      explosive: false,
      cryo: false,
      targetingSteering: false,
      hitEnemyIds: [],
      hitBoss: false,
      rewindAtSeconds: 0,
    };
  }

  private checkoutEnemy(kind: EnemyKind): Enemy {
    return this.enemyPools[kind].pop() ?? this.createEnemy(kind);
  }

  private createEnemy(kind: EnemyKind): Enemy {
    const mesh = new THREE.Group();
    const rules = enemyArchetypeForKind(kind);
    const kindMaterials = this.enemyKindMaterials[kind];
    let chargeMaterial: THREE.MeshBasicMaterial | undefined;
    let aimGroup: THREE.Group | undefined;
    let chargeMesh: THREE.Mesh | undefined;
    const eliteHalo = new THREE.Mesh(this.assets.shield, kindMaterials.accent);
    eliteHalo.position.z = 0.82;
    eliteHalo.scale.set(1.05, 1.3, 1);
    eliteHalo.visible = false;
    mesh.userData.eliteHalo = eliteHalo;

    if (kind === "fighter" || kind === "interceptor" || kind === "bomber" || kind === "phantom") {
      const wings = new THREE.Mesh(this.assets.fighterWing, kindMaterials.hull);
      const wingAccent = new THREE.Mesh(this.assets.fighterWing, kindMaterials.accent);
      const body = new THREE.Mesh(this.assets.fighterHull, kindMaterials.hull);
      const cockpit = new THREE.Mesh(this.assets.playerCockpit, kindMaterials.accent);
      const leftEngine = new THREE.Mesh(this.assets.gunPod, kindMaterials.hull);
      const rightEngine = new THREE.Mesh(this.assets.gunPod, kindMaterials.hull);
      const leftGlow = new THREE.Mesh(this.assets.engineGlow, this.assets.enemyEngineMaterial);
      const rightGlow = new THREE.Mesh(this.assets.engineGlow, this.assets.enemyEngineMaterial);
      wings.position.z = 0.16;
      wingAccent.position.set(0, -0.07, 0.2);
      wingAccent.scale.set(0.76, 0.7, 1);
      body.position.z = 0.28;
      cockpit.position.set(0, 0.26, 0.45);
      cockpit.scale.set(0.48, 0.88, 0.32);
      leftEngine.position.set(-0.27, -0.6, 0.3);
      rightEngine.position.set(0.27, -0.6, 0.3);
      leftEngine.scale.set(0.82, 0.64, 1);
      rightEngine.scale.copy(leftEngine.scale);
      leftGlow.position.set(-0.27, -0.93, 0.35);
      rightGlow.position.set(0.27, -0.93, 0.35);
      leftGlow.scale.set(0.32, 0.68, 1);
      rightGlow.scale.copy(leftGlow.scale);

      if (kind === "interceptor") {
        wings.scale.set(0.62, 1.18, 1);
        wingAccent.scale.set(0.48, 0.92, 1);
        body.scale.set(0.72, 1.24, 1);
      } else if (kind === "bomber") {
        wings.scale.set(1.3, 0.86, 1);
        wingAccent.scale.set(1.05, 0.62, 1);
        body.scale.set(1.15, 0.9, 1);
        const payload = new THREE.Mesh(this.assets.asteroid, kindMaterials.accent);
        payload.position.set(0, -0.22, 0.42);
        payload.scale.set(0.34, 0.5, 0.3);
        mesh.add(payload);
      } else if (kind === "phantom") {
        wings.scale.set(0.82, 1.08, 1);
        wingAccent.rotation.z = Math.PI / 4;
        wingAccent.scale.set(0.62, 0.62, 1);
        body.scale.set(0.74, 1.08, 1);
      }

      mesh.userData.engineGlows = [leftGlow, rightGlow];
      mesh.add(wings, wingAccent, body, leftEngine, rightEngine, cockpit, leftGlow, rightGlow, eliteHalo);
    } else if (kind === "turret" || kind === "gunship" || kind === "sniper") {
      const base = new THREE.Mesh(this.assets.turretBase, kindMaterials.hull);
      const armorRing = new THREE.Mesh(this.assets.turretRing, kindMaterials.accent);
      const hub = new THREE.Mesh(this.assets.playerCockpit, kindMaterials.hull);
      const weapon = new THREE.Group();
      const leftBarrel = new THREE.Mesh(this.assets.turretBarrel, kindMaterials.hull);
      const rightBarrel = new THREE.Mesh(this.assets.turretBarrel, kindMaterials.hull);
      const muzzle = new THREE.Mesh(
        this.assets.turretMuzzle,
        this.trackMaterial(new THREE.MeshBasicMaterial({
          color: ENEMY_CHARGE_CORE,
          transparent: true,
          opacity: 0.16,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })),
      );
      chargeMaterial = muzzle.material;
      chargeMesh = muzzle;
      aimGroup = weapon;
      base.rotation.x = Math.PI / 2;
      base.position.z = 0.08;
      armorRing.position.z = 0.28;
      hub.position.set(0, 0, 0.32);
      hub.scale.set(0.9, 0.9, 0.44);
      leftBarrel.position.set(-0.13, -0.42, 0.42);
      rightBarrel.position.set(0.13, -0.42, 0.42);
      muzzle.position.set(0, -0.88, 0.46);

      if (kind === "gunship") {
        base.scale.set(1.45, 1.1, 1);
        armorRing.scale.setScalar(1.28);
        leftBarrel.position.x = -0.34;
        rightBarrel.position.x = 0.34;
        leftBarrel.scale.set(1.1, 1.15, 1);
        rightBarrel.scale.copy(leftBarrel.scale);
      } else if (kind === "sniper") {
        base.scale.set(0.82, 0.82, 1);
        armorRing.scale.setScalar(0.76);
        leftBarrel.visible = false;
        rightBarrel.position.x = 0;
        rightBarrel.scale.set(0.72, 2.15, 0.72);
        muzzle.position.y = -1.38;
      }

      weapon.add(leftBarrel, rightBarrel, muzzle);
      mesh.userData.armorRing = armorRing;
      mesh.add(base, armorRing, hub, weapon, eliteHalo);
    } else if (kind === "asteroid") {
      const body = new THREE.Mesh(this.assets.asteroid, kindMaterials.hull);
      const edges = new THREE.LineSegments(this.assets.asteroidEdges, kindMaterials.accent);
      const crater = new THREE.Mesh(this.assets.turretMuzzle, kindMaterials.accent);
      body.position.z = 0.05;
      edges.position.z = 0.05;
      edges.scale.setScalar(1.012);
      crater.position.set(0.2, 0.16, 0.75);
      crater.scale.set(0.82, 0.54, 1);
      mesh.add(body, edges, crater, eliteHalo);
    } else if (kind === "mine") {
      const core = new THREE.Mesh(this.assets.asteroid, kindMaterials.hull);
      const ring = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      core.scale.setScalar(0.68);
      ring.position.z = 0.55;

      for (let spikeIndex = 0; spikeIndex < 4; spikeIndex += 1) {
        const spike = new THREE.Mesh(this.assets.gunPod, kindMaterials.hull);
        const angle = spikeIndex / 4 * Math.PI * 2;
        spike.position.set(Math.cos(angle) * 0.72, Math.sin(angle) * 0.72, 0.25);
        spike.rotation.z = angle - Math.PI / 2;
        spike.scale.set(0.8, 0.9, 1);
        mesh.add(spike);
      }

      mesh.add(core, ring, eliteHalo);
    } else if (kind === "carrier") {
      const body = new THREE.Mesh(this.assets.asteroid, kindMaterials.hull);
      const leftWing = new THREE.Mesh(this.assets.fighterWing, kindMaterials.hull);
      const rightWing = new THREE.Mesh(this.assets.fighterWing, kindMaterials.hull);
      const core = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      body.scale.set(0.78, 1.08, 0.72);
      leftWing.position.set(-0.74, 0, 0.12);
      leftWing.scale.set(0.62, 0.72, 1);
      rightWing.position.set(0.74, 0, 0.12);
      rightWing.scale.set(-0.62, 0.72, 1);
      core.position.z = 0.7;
      core.scale.setScalar(0.75);
      mesh.add(body, leftWing, rightWing, core, eliteHalo);
    } else if (kind === "corsair") {
      const body = new THREE.Mesh(this.assets.fighterHull, kindMaterials.hull);
      const sweptWing = new THREE.Mesh(this.assets.fighterWing, kindMaterials.hull);
      const blade = new THREE.Mesh(this.assets.fighterWing, kindMaterials.accent);
      const leftCannon = new THREE.Mesh(this.assets.gunPod, kindMaterials.hull);
      const rightCannon = new THREE.Mesh(this.assets.gunPod, kindMaterials.hull);
      body.position.z = 0.36;
      body.scale.set(0.66, 1.3, 1);
      sweptWing.position.z = 0.16;
      sweptWing.rotation.z = 0.18;
      sweptWing.scale.set(1.08, 0.56, 1);
      blade.position.set(0, -0.12, 0.28);
      blade.rotation.z = -0.22;
      blade.scale.set(0.76, 0.28, 1);
      leftCannon.position.set(-0.72, -0.5, 0.35);
      rightCannon.position.set(0.72, -0.5, 0.35);
      leftCannon.scale.set(0.8, 1.25, 1);
      rightCannon.scale.copy(leftCannon.scale);
      mesh.add(sweptWing, blade, body, leftCannon, rightCannon, eliteHalo);
    } else if (kind === "bulwark") {
      const body = new THREE.Mesh(this.assets.asteroid, kindMaterials.hull);
      const shieldRing = new THREE.Mesh(this.assets.shield, kindMaterials.accent);
      const hub = new THREE.Mesh(this.assets.playerCockpit, kindMaterials.hull);
      body.scale.set(1.18, 0.9, 0.62);
      body.position.z = 0.18;
      shieldRing.position.set(0, -0.28, 0.72);
      shieldRing.scale.setScalar(1.35);
      hub.position.z = 0.65;
      hub.scale.set(0.72, 0.72, 0.42);
      for (const x of [-0.72, 0, 0.72]) {
        const armor = new THREE.Mesh(this.assets.bossCannon, kindMaterials.hull);
        armor.position.set(x, 0.08 + Math.abs(x) * 0.18, 0.5);
        armor.rotation.z = x * 0.32;
        armor.scale.set(1.55, 0.58, 1);
        mesh.add(armor);
      }
      mesh.userData.signatureRing = shieldRing;
      mesh.add(body, shieldRing, hub, eliteHalo);
    } else if (kind === "shifter") {
      const echoes = new THREE.Group();
      const core = new THREE.Mesh(this.assets.playerCockpit, kindMaterials.hull);
      const blinkRing = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      core.position.z = 0.52;
      core.scale.set(0.68, 0.92, 0.42);
      blinkRing.position.z = 0.72;
      blinkRing.scale.setScalar(1.38);
      for (let echoIndex = 0; echoIndex < 3; echoIndex += 1) {
        const echo = new THREE.Mesh(this.assets.fighterHull, echoIndex === 1 ? kindMaterials.hull : kindMaterials.accent);
        const angle = echoIndex / 3 * Math.PI * 2 + Math.PI / 2;
        echo.position.set(Math.cos(angle) * 0.62, Math.sin(angle) * 0.5, 0.25);
        echo.rotation.z = angle - Math.PI / 2;
        echo.scale.set(0.48, 0.64, 1);
        echoes.add(echo);
      }
      mesh.userData.signatureRing = blinkRing;
      mesh.userData.signatureGroup = echoes;
      mesh.add(echoes, core, blinkRing, eliteHalo);
    } else if (kind === "leech") {
      const body = new THREE.Mesh(this.assets.fighterHull, kindMaterials.hull);
      const mouth = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      body.position.set(0, 0.12, 0.3);
      body.scale.set(0.72, 1.18, 1);
      mouth.position.set(0, -0.72, 0.62);
      mouth.scale.setScalar(0.82);
      for (const side of [-1, 1]) {
        for (let armIndex = 0; armIndex < 2; armIndex += 1) {
          const arm = new THREE.Mesh(this.assets.gunPod, kindMaterials.hull);
          arm.position.set(side * (0.42 + armIndex * 0.28), -0.28 + armIndex * 0.22, 0.34);
          arm.rotation.z = side * (0.55 + armIndex * 0.28);
          arm.scale.set(0.88, 1.18 - armIndex * 0.18, 1);
          mesh.add(arm);
        }
      }
      mesh.userData.signatureRing = mouth;
      mesh.add(body, mouth, eliteHalo);
    } else if (kind === "splitter") {
      const halves = new THREE.Group();
      const bridge = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      for (const side of [-1, 1]) {
        const halfBody = new THREE.Mesh(this.assets.fighterHull, kindMaterials.hull);
        const halfWing = new THREE.Mesh(this.assets.fighterWing, kindMaterials.accent);
        halfBody.position.set(side * 0.5, 0, 0.34);
        halfBody.scale.set(0.5, 0.9, 1);
        halfWing.position.set(side * 0.58, -0.08, 0.18);
        halfWing.scale.set(side * 0.52, 0.5, 1);
        halfWing.rotation.z = side * 0.22;
        halves.add(halfBody, halfWing);
      }
      bridge.position.z = 0.6;
      bridge.scale.set(1.25, 0.72, 1);
      mesh.userData.signatureGroup = halves;
      mesh.add(halves, bridge, eliteHalo);
    } else if (kind === "warden") {
      const body = new THREE.Mesh(this.assets.turretBase, kindMaterials.hull);
      const tetherRings = new THREE.Group();
      const horizontalRing = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      const verticalRing = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      body.rotation.x = Math.PI / 2;
      body.position.z = 0.2;
      body.scale.set(1.12, 1.12, 1);
      horizontalRing.position.z = 0.72;
      horizontalRing.scale.setScalar(1.75);
      verticalRing.position.z = 0.75;
      verticalRing.rotation.x = Math.PI / 2;
      verticalRing.scale.setScalar(1.45);
      tetherRings.add(horizontalRing, verticalRing);
      for (let pylonIndex = 0; pylonIndex < 4; pylonIndex += 1) {
        const pylon = new THREE.Mesh(this.assets.gunPod, kindMaterials.hull);
        const angle = pylonIndex / 4 * Math.PI * 2;
        pylon.position.set(Math.cos(angle) * 0.82, Math.sin(angle) * 0.82, 0.4);
        pylon.rotation.z = angle - Math.PI / 2;
        pylon.scale.set(0.8, 0.9, 1);
        mesh.add(pylon);
      }
      mesh.userData.signatureGroup = tetherRings;
      mesh.add(body, tetherRings, eliteHalo);
    } else if (kind === "rammer") {
      const body = new THREE.Mesh(this.assets.fighterHull, kindMaterials.hull);
      const nose = new THREE.Mesh(this.assets.asteroid, kindMaterials.hull);
      const ramGlow = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      body.position.set(0, 0.08, 0.3);
      body.scale.set(1.08, 1.45, 1);
      nose.position.set(0, -0.9, 0.45);
      nose.scale.set(0.42, 0.72, 0.42);
      ramGlow.position.set(0, -0.92, 0.72);
      ramGlow.scale.setScalar(0.8);
      for (const side of [-1, 1]) {
        const fin = new THREE.Mesh(this.assets.fighterWing, kindMaterials.accent);
        fin.position.set(side * 0.5, 0.48, 0.18);
        fin.scale.set(side * 0.5, 0.44, 1);
        fin.rotation.z = side * 0.4;
        mesh.add(fin);
      }
      mesh.userData.signatureRing = ramGlow;
      mesh.add(body, nose, ramGlow, eliteHalo);
    } else if (kind === "stalker") {
      const body = new THREE.Mesh(this.assets.fighterHull, kindMaterials.hull);
      const cloakParts = new THREE.Group();
      const cloakRing = new THREE.Mesh(this.assets.shield, kindMaterials.accent);
      body.position.z = 0.32;
      body.scale.set(0.72, 1.18, 1);
      cloakRing.position.z = 0.58;
      cloakRing.scale.set(1.08, 1.38, 1);
      cloakParts.add(cloakRing);
      for (const side of [-1, 1]) {
        const crescent = new THREE.Mesh(this.assets.fighterWing, kindMaterials.accent);
        crescent.position.set(side * 0.42, -0.05, 0.2);
        crescent.scale.set(side * 0.68, 0.74, 1);
        crescent.rotation.z = side * 0.58;
        cloakParts.add(crescent);
      }
      mesh.userData.signatureGroup = cloakParts;
      mesh.add(body, cloakParts, eliteHalo);
    } else if (kind === "chronodrone") {
      const core = new THREE.Mesh(this.assets.asteroid, kindMaterials.hull);
      const chronoRings = new THREE.Group();
      core.position.z = 0.24;
      core.scale.setScalar(0.58);
      for (let ringIndex = 0; ringIndex < 3; ringIndex += 1) {
        const ring = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
        ring.position.z = 0.62 + ringIndex * 0.03;
        ring.rotation.x = ringIndex === 1 ? Math.PI / 2 : 0;
        ring.rotation.y = ringIndex === 2 ? Math.PI / 2 : 0;
        ring.scale.setScalar(1.22 + ringIndex * 0.16);
        chronoRings.add(ring);
      }
      for (let spokeIndex = 0; spokeIndex < 4; spokeIndex += 1) {
        const spoke = new THREE.Mesh(this.assets.gunPod, kindMaterials.hull);
        const angle = spokeIndex / 4 * Math.PI * 2;
        spoke.position.set(Math.cos(angle) * 0.7, Math.sin(angle) * 0.7, 0.36);
        spoke.rotation.z = angle - Math.PI / 2;
        spoke.scale.set(0.62, 0.72, 1);
        mesh.add(spoke);
      }
      mesh.userData.signatureGroup = chronoRings;
      mesh.add(core, chronoRings, eliteHalo);
    } else if (kind === "commander") {
      const body = new THREE.Mesh(this.assets.asteroid, kindMaterials.hull);
      const commandWing = new THREE.Mesh(this.assets.bossWing, kindMaterials.hull);
      const core = new THREE.Mesh(this.assets.bossCore, kindMaterials.accent);
      const satellites = new THREE.Group();
      body.position.z = 0.22;
      body.scale.set(0.82, 1.02, 0.68);
      commandWing.position.z = 0.12;
      commandWing.scale.set(0.38, 0.42, 1);
      core.position.z = 0.76;
      core.scale.setScalar(1.12);
      for (let satelliteIndex = 0; satelliteIndex < 4; satelliteIndex += 1) {
        const satellite = new THREE.Mesh(this.assets.playerCockpit, kindMaterials.accent);
        const angle = satelliteIndex / 4 * Math.PI * 2;
        satellite.position.set(Math.cos(angle) * 1.05, Math.sin(angle) * 0.82, 0.54);
        satellite.scale.set(0.34, 0.34, 0.22);
        satellites.add(satellite);
      }
      mesh.userData.signatureGroup = satellites;
      mesh.add(commandWing, body, core, satellites, eliteHalo);
    } else {
      const exhaustiveKind: never = kind;
      throw new Error(`Unsupported enemy kind: ${exhaustiveKind}`);
    }

    if (rules.fireCooldownSeconds !== null && !chargeMaterial) {
      chargeMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
        color: ENEMY_FIRE_ORANGE,
        transparent: true,
        opacity: 0.16,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      chargeMesh = new THREE.Mesh(this.assets.turretMuzzle, chargeMaterial);
      chargeMesh.position.set(0, -0.82, 0.72);
      mesh.add(chargeMesh);
    }

    mesh.visible = false;

    return {
      id: 0,
      kind,
      mesh,
      velocityY: 0,
      radius: 0.7,
      health: 1,
      maxHealth: 1,
      cooldown: 0,
      age: 0,
      baseX: 0,
      baseY: 0,
      orbitRadius: 0,
      orbitSpeed: 0,
      orbitPhase: 0,
      rocketCooldown: Number.POSITIVE_INFINITY,
      rotationSpeed: 0,
      chargeMaterial,
      aimGroup,
      chargeMesh,
      elite: false,
      weaponIndex: 0,
      observedVelocityX: 0,
      observedVelocityY: 0,
      wallSide: 0,
      bossEscort: false,
      cryoRemaining: 0,
    };
  }

  private checkoutBonus(kind: BonusKind): Bonus {
    return this.bonusPools[kind].pop() ?? this.createBonus(kind);
  }

  private createBonusSymbol(kind: BonusKind): THREE.Group {
    const symbol = new THREE.Group();
    const add = (
      geometry: THREE.BufferGeometry,
      x = 0,
      y = 0,
      scaleX = 1,
      scaleY = scaleX,
      rotation = 0,
    ): void => {
      const part = new THREE.Mesh(geometry, this.assets.bonusCoreMaterial);
      part.position.set(x, y, 0);
      part.scale.set(scaleX, scaleY, 1);
      part.rotation.z = rotation;
      symbol.add(part);
    };

    switch (kind) {
      case "shield":
        add(this.assets.bonusShield);
        break;
      case "rapid":
        add(this.assets.bonusRapid, 0, 0, 0.9);
        break;
      case "pulse":
        add(this.assets.bonusPulse);
        break;
      case "spread":
        add(this.assets.gunPod, -0.16, 0, 0.5, 0.68, 0.34);
        add(this.assets.gunPod, 0, 0.04, 0.5, 0.68);
        add(this.assets.gunPod, 0.16, 0, 0.5, 0.68, -0.34);
        break;
      case "plasma":
        add(this.assets.bonusCore, 0, 0, 2.15);
        add(this.assets.bossCore, 0, 0, 0.42);
        break;
      case "missile":
        add(this.assets.playerMissile, 0, 0, 0.58, 0.58);
        break;
      case "beam":
        add(this.assets.playerLaserCore, 0, 0, 1.6, 0.62);
        break;
      case "drone":
        add(this.assets.playerCockpit, -0.17, 0, 0.52, 0.7);
        add(this.assets.playerCockpit, 0.17, 0, 0.52, 0.7);
        break;
      case "overdrive":
        add(this.assets.bonusRapid, -0.11, 0, 0.62, 0.72, -0.16);
        add(this.assets.bonusRapid, 0.11, 0, 0.62, 0.72, 0.16);
        break;
      case "stasis":
        add(this.assets.bossCore, 0, 0, 0.42);
        add(this.assets.gunPod, 0, 0.12, 0.38, 0.46, -0.42);
        add(this.assets.gunPod, 0.11, -0.04, 0.32, 0.4, 0.72);
        break;
      case "piercing":
        add(this.assets.gunPod, 0, -0.1, 0.34, 0.92);
        add(this.assets.bonusRapid, 0, 0.12, 0.42, 0.52);
        break;
      case "ricochet":
        add(this.assets.bossCore, 0, 0, 0.48);
        add(this.assets.bonusRapid, 0.13, 0.12, 0.4, 0.5, -0.78);
        break;
      case "chain-lightning":
        add(this.assets.bonusPulse, -0.15, 0.12, 0.42);
        add(this.assets.bonusPulse, 0.02, 0, 0.42);
        add(this.assets.bonusPulse, 0.17, -0.13, 0.42);
        break;
      case "explosive":
        add(this.assets.bonusCore, 0, 0, 2.05);
        add(this.assets.bossCore, 0, 0, 0.5);
        add(this.assets.gunPod, 0, 0.2, 0.3, 0.42);
        break;
      case "cryo":
        for (let index = 0; index < 4; index += 1) {
          const angle = index / 4 * Math.PI * 2;
          add(this.assets.gunPod, Math.cos(angle) * 0.14, Math.sin(angle) * 0.14, 0.28, 0.5, angle);
        }
        break;
      case "targeting":
        add(this.assets.bossCore, 0, 0, 0.52);
        add(this.assets.bonusCore, 0, 0, 1.2);
        add(this.assets.gunPod, 0, 0.16, 0.24, 0.36);
        break;
      case "accelerator":
        add(this.assets.playerLaserCore, 0, 0, 0.72, 1.45);
        add(this.assets.bonusRapid, 0, 0.15, 0.42, 0.5);
        break;
      case "afterburner":
        add(this.assets.bonusRapid, -0.11, 0, 0.5, 0.78);
        add(this.assets.bonusRapid, 0.11, -0.08, 0.5, 0.78);
        add(this.assets.bonusRapid, 0, 0.12, 0.5, 0.78);
        break;
      case "phase-hull":
        add(this.assets.bonusShield, 0, 0, 1.12);
        add(this.assets.playerHull, 0, 0, 0.3, 0.3);
        break;
      case "magnet":
        add(this.assets.bossCore, 0, 0, 0.48);
        add(this.assets.gunPod, -0.16, 0.06, 0.28, 0.52, -0.6);
        add(this.assets.gunPod, 0.16, 0.06, 0.28, 0.52, 0.6);
        break;
      case "nanorepair":
        add(this.assets.gunPod, 0, 0, 0.3, 0.92);
        add(this.assets.gunPod, 0, 0, 0.3, 0.92, Math.PI / 2);
        add(this.assets.bonusCore, 0, 0, 1.05);
        break;
      case "missile-rack":
        add(this.assets.playerMissile, -0.15, -0.02, 0.42);
        add(this.assets.playerMissile, 0, 0.08, 0.42);
        add(this.assets.playerMissile, 0.15, -0.02, 0.42);
        break;
      case "bomb-amplifier":
        add(this.assets.bonusCore, 0, 0, 2.2);
        add(this.assets.bossCore, 0, 0, 0.56);
        add(this.assets.bonusShield, 0, 0, 1.12);
        break;
      case "counterflare":
        add(this.assets.bonusShield, 0, 0, 1.18);
        add(this.assets.bonusRapid, 0, 0, 0.54, 0.72, Math.PI);
        break;
      case "gravity-knot":
        add(this.assets.bossCore, 0, 0, 0.52);
        add(this.assets.bonusCore, 0, 0, 1.85);
        break;
      case "phoenix-squadron":
        add(this.assets.playerWing, 0, -0.03, 0.34, 0.34);
        add(this.assets.playerHull, 0, 0.02, 0.3, 0.3);
        break;
    }

    return symbol;
  }

  private createBonus(kind: BonusKind): Bonus {
    const mesh = new THREE.Group();
    const crate = new THREE.Group();
    const box = new THREE.Mesh(this.assets.bonusBox, this.assets.bonusMaterials[kind]);
    const frame = new THREE.LineSegments(this.assets.bonusFrame, this.assets.bonusFrameMaterials[kind]);
    const core = new THREE.Mesh(this.assets.bonusCore, this.assets.bonusCoreMaterial);
    const symbol = this.createBonusSymbol(kind);
    const haloMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: this.bonusColor(kind),
      transparent: true,
      opacity: 0.46,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const halo = new THREE.Mesh(this.assets.shield, haloMaterial);
    box.position.z = 0.04;
    frame.position.z = 0.04;
    crate.rotation.set(0.34, 0.42, 0);
    core.position.z = 0.46;
    symbol.position.z = 0.47;
    symbol.scale.setScalar(kind === "rapid" ? 0.9 : 1);
    halo.position.z = 0.12;
    halo.scale.setScalar(0.7);
    crate.add(box, frame);
    mesh.userData.crate = crate;
    mesh.userData.halo = halo;
    mesh.add(crate, halo, core, symbol);
    // Pickups need to read at a glance through the pixel pass. The slightly
    // oversized silhouette also matches the forgiving collection radius.
    mesh.scale.setScalar(1.14);
    mesh.visible = false;

    return {
      id: 0,
      kind,
      mesh,
      velocityY: -2,
      radius: 0.66,
      age: 0,
    };
  }

  private createImpact(): Impact {
    const material = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const highlightMaterial = this.trackMaterial(new THREE.MeshBasicMaterial({
      color: ARCADE_PALETTE.ivory,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    const mesh = new THREE.Group();
    const ring = new THREE.Mesh(this.assets.impact, material);
    const core = new THREE.Mesh(this.assets.bonusCore, highlightMaterial);
    const shards: THREE.Mesh[] = [];
    const shardAngles = new Float32Array(IMPACT_SHARD_COUNT);
    const shardSpeeds = new Float32Array(IMPACT_SHARD_COUNT);
    const shardSpins = new Float32Array(IMPACT_SHARD_COUNT);
    core.position.z = 0.03;
    mesh.add(ring, core);

    for (let index = 0; index < IMPACT_SHARD_COUNT; index += 1) {
      const angle = index / IMPACT_SHARD_COUNT * Math.PI * 2;
      const shard = new THREE.Mesh(
        this.assets.impactShard,
        index % 3 === 0 ? highlightMaterial : material,
      );
      shard.position.set(Math.cos(angle) * 0.3, Math.sin(angle) * 0.3, 0.02);
      shard.rotation.z = angle - Math.PI / 2;
      shards.push(shard);
      mesh.add(shard);
    }

    mesh.visible = false;

    return {
      mesh,
      material,
      highlightMaterial,
      ring,
      core,
      shards,
      shardAngles,
      shardSpeeds,
      shardSpins,
      age: 0,
      duration: 0.28,
      scale: 1,
    };
  }

  private releaseProjectile(index: number, projectiles: Projectile[], pool: Projectile[]): void {
    const projectile = projectiles[index];

    if (!projectile) {
      return;
    }

    projectiles.splice(index, 1);
    projectile.mesh.visible = false;
    this.scene.remove(projectile.mesh);
    pool.push(projectile);
  }

  private releaseEnemyProjectile(index: number): void {
    const projectile = this.enemyProjectiles[index];

    if (!projectile) {
      return;
    }

    const pool = projectile.kind === "rocket" ? this.enemyRocketPool : this.enemyProjectilePool;
    this.releaseProjectile(index, this.enemyProjectiles, pool);
  }

  private releasePlayerProjectile(index: number): void {
    const projectile = this.playerProjectiles[index];

    if (!projectile) {
      return;
    }

    const pool = projectile.kind === "player-missile" ? this.playerMissilePool : this.playerProjectilePool;
    this.releaseProjectile(index, this.playerProjectiles, pool);
  }

  private releaseEnemy(index: number): void {
    const enemy = this.enemies[index];

    if (!enemy) {
      return;
    }

    this.enemies.splice(index, 1);
    enemy.mesh.visible = false;
    this.scene.remove(enemy.mesh);
    this.enemyPools[enemy.kind].push(enemy);
  }

  private releaseBonus(index: number): void {
    const bonus = this.bonuses[index];

    if (!bonus) {
      return;
    }

    this.bonuses.splice(index, 1);
    bonus.mesh.visible = false;
    this.scene.remove(bonus.mesh);
    this.bonusPools[bonus.kind].push(bonus);
  }

  private releaseImpact(index: number): void {
    const impact = this.impacts[index];

    if (!impact) {
      return;
    }

    this.impacts.splice(index, 1);
    impact.mesh.visible = false;
    this.scene.remove(impact.mesh);
    this.impactPool.push(impact);
  }

  private resetRun(): void {
    this.clearBattlefield();
    this.runElapsed = 0;
    this.worldElapsed = 0;
    this.snapshotElapsed = HUD_INTERVAL_SECONDS;
    this.score = 0;
    this.pilotStyleScore = 0;
    this.pilotSync = 0;
    this.pilotLineCooldown = 6.5;
    this.recentHumanInputSeconds = 0;
    this.lives = 3;
    this.sector = 1;
    this.difficulty = difficultyForSector(1);
    this.playerX = 0;
    this.previousPlayerX = 0;
    this.previousPlayerY = PLAYER_START_Y;
    this.playerIntentX = 0;
    this.playerIntentY = 0;
    this.playerVelocityX = 0;
    this.playerVelocityY = 0;
    this.flightMotion = { ...RESTING_FLIGHT_MOTION };
    this.player.position.set(0, PLAYER_START_Y, 2);
    this.player.rotation.set(0, 0, 0);
    const flightRig = this.player.userData.flightRig as THREE.Group;
    flightRig.position.set(0, 0, 0);
    flightRig.rotation.set(0, 0, 0, "YXZ");
    this.player.scale.setScalar(1);
    this.player.visible = true;
    this.playerLaser.visible = false;
    this.playerFireCooldown = 0;
    this.playerShotSide = -1;
    this.nextEnemyId = 1;
    this.nextBonusId = 1;
    this.spawnCooldown = 0.95;
    this.bonusCooldown = scaledCrateSpawnDelay(5.8, this.activeDifficultyLevel);
    this.bossPending = false;
    this.bossSpawnDelay = 0;
    this.lastBossSector = 0;
    this.encounterCadence = createEncounterCadence();
    this.normalWaveSpawnRemaining = normalWaveSpawnCount(this.encounterCadence);
    this.normalWaveIntermissionRemaining = 0;
    this.rapidFireRemaining = 0;
    this.spreadRemaining = 0;
    this.plasmaRemaining = 0;
    this.beamRemaining = 0;
    this.droneRemaining = 0;
    this.overdriveRemaining = 0;
    this.stasisRemaining = 0;
    for (const kind of ADVANCED_ATTACHMENT_KINDS) {
      this.advancedAttachmentRemaining[kind] = 0;
    }
    this.nanorepairKillsRemaining = 0;
    this.nanorepairCharge = 0;
    this.bonusBag = [];
    this.abilityStates = createLockedJetAbilityStates();
    this.abilityCoreCollected = {
      counterflare: false,
      "gravity-knot": false,
      "phoenix-squadron": false,
    };
    this.nextAbilityCoreDuplicateAt = 105;
    this.dashRemaining = 0;
    this.dashEffectRemaining = 0;
    this.dashCooldownRemaining = 0;
    this.dashDirectionX = 0;
    this.dashDirectionY = 1;
    this.dashRollProgress = 1;
    this.dashRollDirection = 1;
    this.burstRemaining = 0;
    this.syncStrikeRemaining = 0;
    this.lowProfileRemaining = 0;
    this.lowProfileTimeWarpRemaining = 0;
    this.lowProfileCooldownRemaining = 0;
    this.lowProfileBossLaserHitAvailable = false;
    this.lowProfileBossDamagePending = 0;
    this.missileCooldownRemaining = 0;
    this.remoteBombActive = false;
    this.remoteBombAge = 0;
    this.remoteBombTargetY = 0;
    this.remoteBombCooldownRemaining = 0;
    this.guardianWingRemaining = 0;
    this.guardianWingCooldownRemaining = 0;
    this.laserDamageCooldown = 0;
    this.manualDashRequested = false;
    this.manualLowProfileRequested = false;
    this.manualMissilesRequested = false;
    this.manualCounterflareRequested = false;
    this.manualGravityKnotRequested = false;
    this.manualPhoenixSquadronRequested = false;
    this.counterflareConversionsRemaining = 0;
    this.gravityKnotX = 0;
    this.gravityKnotY = 0;
    this.phoenixStrikeCooldown = 0;
    this.phoenixStrikeIndex = 0;
    this.brainDecisionCooldown = 0;
    this.brainSurvivalSeconds = DEFAULT_SUPER_BRAIN_CONFIG.planningHorizonSeconds;
    this.brainClearance = Number.POSITIVE_INFINITY;
    this.autoPilotEnabled = true;
    this.emergencyAssistState = { ...INITIAL_EMERGENCY_ASSIST_STATE };
    this.updatePlayerModeVisuals();
    this.brainMode = "Cruising";
    this.superBrain.reset();
    this.emergencySuperBrain.reset();
    this.invulnerabilityRemaining = 0;
    this.shielded = false;
    this.playerShield.group.visible = false;
    this.sectorAnnouncementRemaining = 0;
    this.screenShakeRemaining = 0;
    this.simulationAccumulator = 0;
    this.previousCaveTravel = 0;
    this.caveTravel = 0;
    this.caveDifficultySector = 1;
    this.caveContactLatched = false;
    this.camera.position.set(0, 0, 20);
    this.backgroundGroup.position.set(0, 0, 0);
    this.backgroundVisualsDirty = true;
    this.pilotLine.active = false;
    this.pilotLine.nextNode = 0;
    this.pilotLine.age = 0;

    for (const node of this.pilotLine.nodes) {
      node.mesh.visible = false;
      node.ringMaterial.opacity = 0;
      node.coreMaterial.opacity = 0;
    }

    this.dashTrail.mesh.visible = false;
    const dashTrailOpacity = this.dashTrail.material.uniforms.uOpacity;
    if (dashTrailOpacity) dashTrailOpacity.value = 0;

    for (const drone of this.player.userData.drones as THREE.Group[]) {
      drone.visible = false;
    }

    this.counterflareVisual.group.visible = false;
    this.counterflareVisual.primaryMaterial.opacity = 0;
    this.counterflareVisual.secondaryMaterial.opacity = 0;
    this.gravityKnotVisual.group.visible = false;
    this.gravityKnotVisual.primaryMaterial.opacity = 0;
    this.gravityKnotVisual.secondaryMaterial.opacity = 0;
    for (const wing of this.phoenixWings) {
      wing.group.visible = false;
      wing.age = 99;
      wing.trailMaterial.opacity = 0;
    }
    this.deactivateRemoteBomb();
    this.deactivateGuardianWingmen();
    for (const wing of this.guardianWingmen) {
      wing.countermeasureCooldown = Math.max(0, (wing.id - 1) * 0.12);
      wing.group.position.set(wing.side * 1.8, PLAYER_START_Y - 0.3, 2.2);
    }
  }

  private clearBattlefield(): void {
    for (let index = this.playerProjectiles.length - 1; index >= 0; index -= 1) {
      this.releasePlayerProjectile(index);
    }

    for (let index = this.enemyProjectiles.length - 1; index >= 0; index -= 1) {
      this.releaseEnemyProjectile(index);
    }

    for (let index = this.enemies.length - 1; index >= 0; index -= 1) {
      this.releaseEnemy(index);
    }

    for (let index = this.bonuses.length - 1; index >= 0; index -= 1) {
      this.releaseBonus(index);
    }

    for (let index = this.impacts.length - 1; index >= 0; index -= 1) {
      this.releaseImpact(index);
    }

    this.deactivateRemoteBomb();
    this.deactivateGuardianWingmen();
    this.deactivateBoss();
  }

  private deactivateBoss(): void {
    this.boss.active = false;
    this.boss.entering = false;
    this.boss.cryoRemaining = 0;
    this.lowProfileBossDamagePending = 0;
    this.lowProfileBossLaserHitAvailable = false;
    this.bossEscortProgress = createBossEscortProgress();
    this.pendingBossEscorts.length = 0;
    this.boss.mesh.visible = false;
    this.boss.chargeMaterial.opacity = 0.15;
    this.boss.entryShield.visible = false;
    this.scene.remove(this.boss.mesh);
  }

  private pause(): void {
    if (this.status !== "running") {
      return;
    }

    this.status = "paused";
    this.announcement = "Flight paused";
    this.stopLoop();
    this.renderOnce();
    this.publishSnapshot(true);
  }

  private resume(): void {
    if (this.status !== "paused") {
      return;
    }

    this.status = "running";
    this.announcement = "Flight resumed";
    this.sectorAnnouncementRemaining = 0.85;
    this.publishSnapshot(true);
    this.startLoop();
  }

  private startLoop(): void {
    if (this.animationFrame !== null || this.disposed) {
      return;
    }

    this.lastFrameTimestamp = performance.now();
    this.animationFrame = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  private renderOnce(): void {
    if (!this.disposed) {
      if (this.backgroundVisualsDirty) {
        this.updateStarMatrices(this.stars);
        this.updateCaveLayers();
        this.backgroundVisualsDirty = false;
      }
      this.composer.render();
    }
  }

  private activeWeaponEffects(): ActiveWeaponEffect[] {
    const effects: ActiveWeaponEffect[] = [];
    const addTimed = (kind: BonusKind, seconds: number): void => {
      if (seconds > 0) {
        effects.push({ id: kind, label: bonusLabel(kind), seconds });
      }
    };

    if (this.shielded) {
      effects.push({ id: "shield", label: bonusLabel("shield"), seconds: null });
    }

    addTimed("rapid", this.rapidFireRemaining);
    addTimed("spread", this.spreadRemaining);
    addTimed("plasma", this.plasmaRemaining);
    addTimed("beam", this.beamRemaining);
    addTimed("drone", this.droneRemaining);
    addTimed("overdrive", this.overdriveRemaining);
    addTimed("stasis", this.stasisRemaining);
    for (const kind of ADVANCED_ATTACHMENT_KINDS) {
      const seconds = this.advancedAttachmentRemaining[kind];
      if (seconds <= 0) continue;
      effects.push({
        id: kind,
        label: kind === "nanorepair"
          ? `${bonusLabel(kind)} · ${this.nanorepairCharge}/${3} charge · ${this.nanorepairKillsRemaining} kills left`
          : bonusLabel(kind),
        seconds,
      });
    }

    for (const kind of JET_ABILITY_KINDS) {
      const state = this.abilityStates[kind];
      if (state.activeSeconds > 0) {
        effects.push({
          id: kind,
          label: JET_ABILITY_SPECS[kind].label,
          seconds: state.activeSeconds,
        });
      }
    }

    if (this.lowProfileRemaining > 0) {
      effects.push({
        id: "low-profile",
        label: "Low-profile laser",
        seconds: this.lowProfileRemaining,
      });
    }

    if (this.lowProfileTimeWarpRemaining > 0) {
      effects.push({
        id: "time-warp",
        label: "3× time warp · 1.5× jet speed",
        seconds: this.lowProfileTimeWarpRemaining,
      });
    }

    if (this.remoteBombActive) {
      effects.push({
        id: "remote-bomb",
        label: `Remote bomb · press ${JET_FLIGHT_SYSTEM_KEYS["remote-bomb"]} to detonate`,
        seconds: Math.max(0, REMOTE_BOMB_MAX_ARMED_SECONDS - this.remoteBombAge),
      });
    }

    if (this.guardianWingRemaining > 0) {
      effects.push({
        id: "guardian-wing",
        label: "Guardian Wing · rapid cannons + countermeasures",
        seconds: this.guardianWingRemaining,
      });
    }

    if (this.burstRemaining > 0) {
      effects.push({
        id: this.syncStrikeRemaining > 0 ? "sync-strike" : "dash-burst",
        label: this.syncStrikeRemaining > 0 ? "10× sync strike" : "10× dash burst",
        seconds: this.burstRemaining,
      });
    }

    return effects;
  }

  private publishSnapshot(force: boolean): void {
    if (!force && this.snapshotElapsed < HUD_INTERVAL_SECONDS) {
      return;
    }

    this.snapshotElapsed = 0;
    const pilotNode = this.pilotLine.active
      ? this.pilotLine.nodes[this.pilotLine.nextNode]
      : undefined;
    const pilotDeltaX = pilotNode ? pilotNode.mesh.position.x - this.player.position.x : 0;
    const pilotLineDirection: GameSnapshot["pilotLineDirection"] = Math.abs(pilotDeltaX) < 1.2
      ? "center"
      : pilotDeltaX < 0
        ? "left"
        : "right";
    this.onSnapshot({
      status: this.status,
      difficultyLevel: this.status === "ready" || this.status === "game-over"
        ? this.nextDifficultyLevel
        : this.activeDifficultyLevel,
      score: this.score + this.pilotStyleScore,
      bestScore: this.bestScore,
      lives: this.lives,
      sector: this.sector,
      shielded: this.shielded,
      rapidFireSeconds: this.rapidFireRemaining,
      autoPilotEnabled: this.autoPilotEnabled,
      emergencyAssistActive: this.emergencyAssistState.active,
      emergencyAssistSeconds: this.emergencyAssistState.remainingSeconds,
      brainActive: this.status === "running"
        && (this.autoPilotEnabled || this.emergencyAssistState.active),
      brainMode: this.brainMode,
      dashActiveSeconds: this.dashRemaining,
      dashCooldownSeconds: this.dashCooldownRemaining,
      burstSeconds: this.burstRemaining,
      lowProfileSeconds: this.lowProfileRemaining,
      lowProfileCooldownSeconds: this.lowProfileCooldownRemaining,
      missileCooldownSeconds: this.missileCooldownRemaining,
      remoteBombActive: this.remoteBombActive,
      remoteBombArmedSeconds: this.remoteBombActive
        ? Math.max(0, REMOTE_BOMB_MAX_ARMED_SECONDS - this.remoteBombAge)
        : 0,
      remoteBombCooldownSeconds: this.remoteBombCooldownRemaining,
      guardianWingSeconds: this.guardianWingRemaining,
      guardianWingCooldownSeconds: this.guardianWingCooldownRemaining,
      jetAbilities: JET_ABILITY_KINDS.map((kind) => ({
        kind,
        label: JET_ABILITY_SPECS[kind].label,
        key: JET_ABILITY_SPECS[kind].key,
        unlocked: this.abilityStates[kind].unlocked,
        cooldownSeconds: this.abilityStates[kind].cooldownSeconds,
        activeSeconds: this.abilityStates[kind].activeSeconds,
      })),
      activeWeaponEffects: this.activeWeaponEffects(),
      bossActive: this.boss.active,
      bossName: this.boss.name,
      bossHealth: Math.max(0, this.boss.health),
      bossMaxHealth: this.boss.maxHealth,
      bossPhase: this.boss.phase,
      bossPattern: bossWeaponForPhase(this.boss.archetype, this.boss.phase),
      pilotLineActive: this.pilotLine.active,
      pilotLineStep: this.pilotLine.active ? this.pilotLine.nextNode : 0,
      pilotLineDirection,
      pilotLineSeconds: pilotNode
        ? pilotNodeRemainingSeconds(pilotNode.mesh.position.y, this.pilotLine.velocityY, WORLD_BOTTOM - 1.6)
        : 0,
      pilotSync: this.pilotSync,
      pilotSyncTarget: PILOT_SYNC_TARGET,
      pilotStyleScore: this.pilotStyleScore,
      announcement: this.sectorAnnouncementRemaining > 0 ? this.announcement : null,
    });
  }

  private loadBestScore(): number {
    try {
      const storedValue = window.localStorage.getItem(BEST_SCORE_KEY);
      const parsedValue = storedValue ? Number.parseInt(storedValue, 10) : 0;
      return Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
    } catch {
      return 0;
    }
  }

  private persistBestScore(): void {
    const displayScore = this.score + this.pilotStyleScore;

    if (displayScore <= this.bestScore) {
      return;
    }

    this.bestScore = displayScore;

    try {
      window.localStorage.setItem(BEST_SCORE_KEY, String(this.bestScore));
    } catch {
      return;
    }
  }

  private randomRange(minimum: number, maximum: number): number {
    return minimum + this.gameplayRandom() * (maximum - minimum);
  }

  private randomSign(): number {
    return this.gameplayRandom() < 0.5 ? -1 : 1;
  }

  private visualRandomRange(minimum: number, maximum: number): number {
    return minimum + this.visualRandom() * (maximum - minimum);
  }

  private trackGeometry<Geometry extends THREE.BufferGeometry>(geometry: Geometry): Geometry {
    this.geometries.push(geometry);
    return geometry;
  }

  private trackMaterial<Material extends THREE.Material>(material: Material): Material {
    this.materials.push(material);
    return material;
  }
}
