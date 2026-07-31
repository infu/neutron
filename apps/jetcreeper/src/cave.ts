export const CAVE_WORLD_HALF_WIDTH = 10;
export const CAVE_WORLD_WIDTH = CAVE_WORLD_HALF_WIDTH * 2;
export const CAVE_WORLD_TOP = 16;
export const CAVE_MAX_WALL_INTRUSION_RATIO = 0.25;
export const CAVE_MAX_WALL_INTRUSION = CAVE_WORLD_WIDTH * CAVE_MAX_WALL_INTRUSION_RATIO;
export const CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN = 0.65;
export const CAVE_MAX_LONGITUDINAL_COORDINATE = 1_000_000;
export const CAVE_MAX_SWEEP_SAMPLES = 33;
export const CAVE_DIFFICULTY_EASING_RATE_SECTORS_PER_SECOND = 8;

const CAVE_MIN_WALL_INTRUSION = 0.35;
const DEFAULT_SWEEP_SAMPLE_SPACING = 0.75;
const COLLISION_REFINEMENT_STEPS = 9;
const COLLISION_EPSILON = 1e-9;
const UINT32_RANGE = 4_294_967_295;

const CAVE_NOISE_SEEDS = Object.freeze({
  bend: 0x1f12_bb5d,
  pinchWide: 0x5a31_7c29,
  pinchDetail: 0x72d6_820f,
  leftShoulder: 0x19c8_4e63,
  rightShoulder: 0x6e27_91a5,
  leftEdge: 0x3d58_a94b,
  rightEdge: 0x43b7_2fd1,
});

export interface CaveLayerSpec {
  readonly id: "deep-void" | "far-rock" | "mid-rock" | "near-rock" | "rim";
  /** Three.js Z position. More-negative values sit farther behind the play plane. */
  readonly depth: number;
  /** Fraction of ambient light removed from the layer, from zero to one. */
  readonly darkness: number;
  /** Travel multiplier reserved for surface-texture parallax. */
  readonly parallax: number;
  /** Perspective inset from the foreground rim; larger values sit deeper. */
  readonly apertureExpansion: number;
  /** Deterministic phase separation reserved for surface texture. */
  readonly phaseOffset: number;
}

export interface CaveCorridorSample {
  /** Longitudinal cave coordinate represented by this screen row. */
  readonly distance: number;
  readonly center: number;
  /** Navigable half-width after the fixed wall-clearance margin. */
  readonly halfWidth: number;
  readonly safeLeft: number;
  readonly safeRight: number;
  /** Physical foreground rock edges. */
  readonly wallLeft: number;
  readonly wallRight: number;
  /** Zero in open chambers and one at the strongest shared pinch. */
  readonly narrowing: number;
}

export interface CaveLayerCorridorSample {
  readonly center: number;
  readonly halfWidth: number;
  readonly left: number;
  readonly right: number;
}

export interface CaveSweepPoint {
  readonly x: number;
  readonly y: number;
}

export interface SweepCircleThroughCaveOptions {
  /** Cave travel at the beginning and end of the physics step. */
  readonly startTravelDistance: number;
  readonly endTravelDistance: number;
  readonly start: CaveSweepPoint;
  readonly end: CaveSweepPoint;
  readonly sector: number;
  readonly radius: number;
  /** Additional physical-wall clearance. Defaults to the gameplay-safe 0.65 units. */
  readonly clearanceMargin?: number;
  /** Desired maximum distance between broad-phase samples. */
  readonly maximumSampleSpacing?: number;
  /** Hard upper bound including both endpoints; clamped to 2..33. */
  readonly maximumSamples?: number;
}

export type CaveCollisionSide = "left" | "right" | null;

export interface CaveSweepResult {
  readonly collided: boolean;
  /** First contact along the sweep, or null when the complete route is clear. */
  readonly collisionRatio: number | null;
  readonly minimumClearance: number;
  readonly side: CaveCollisionSide;
  /** Corridor sample at minimum clearance. */
  readonly sample: CaveCorridorSample;
  readonly position: CaveSweepPoint;
  readonly collisionSample: CaveCorridorSample | null;
  readonly collisionPosition: CaveSweepPoint | null;
  readonly sampleCount: number;
}

interface ClearanceDetails {
  readonly clearance: number;
  readonly side: Exclude<CaveCollisionSide, null>;
}

interface EvaluatedSweepPoint {
  readonly ratio: number;
  readonly travelDistance: number;
  readonly position: CaveSweepPoint;
  readonly sample: CaveCorridorSample;
  readonly clearance: number;
  readonly side: Exclude<CaveCollisionSide, null>;
}

/**
 * Back-to-front cave strata. Values are deliberately unique so a renderer can
 * use them directly for depth shading and camera parallax without hidden state.
 */
export const CAVE_LAYER_SPECS: readonly CaveLayerSpec[] = Object.freeze([
  Object.freeze({
    id: "deep-void",
    depth: -9.5,
    darkness: 0.92,
    parallax: 0.16,
    apertureExpansion: 3.6,
    phaseOffset: 83,
  }),
  Object.freeze({
    id: "far-rock",
    depth: -7.1,
    darkness: 0.79,
    parallax: 0.34,
    apertureExpansion: 2.7,
    phaseOffset: 61,
  }),
  Object.freeze({
    id: "mid-rock",
    depth: -4.9,
    darkness: 0.65,
    parallax: 0.55,
    apertureExpansion: 1.8,
    phaseOffset: 37,
  }),
  Object.freeze({
    id: "near-rock",
    depth: -2.8,
    darkness: 0.5,
    parallax: 0.77,
    apertureExpansion: 0.9,
    phaseOffset: 17,
  }),
  Object.freeze({
    id: "rim",
    depth: -1.15,
    darkness: 0.36,
    parallax: 1,
    apertureExpansion: 0,
    phaseOffset: 0,
  }),
]);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteClamped(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}

function finiteNonNegative(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const ratio = clamp((value - edge0) / Math.max(Number.EPSILON, edge1 - edge0), 0, 1);
  return ratio * ratio * (3 - 2 * ratio);
}

function quintic(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function terminalProgressForSector(sector: number): number {
  // Keep this continuous so the runtime can ease cave pressure toward a new
  // sector without snapping the physical or visual wall profile in one frame.
  const safeSector = finiteClamped(sector, 1, 200, 1);
  return (safeSector - 1) / 199;
}

/**
 * Advances the continuous cave-pressure sector toward a gameplay-sector target.
 * The fixed rate prevents large score rewards from morphing the wall profile in
 * one frame, while clamping and invalid-input fallbacks keep every consumer on
 * the same deterministic 1..200 domain.
 */
export function advanceCaveDifficultySector(
  currentSector: number,
  targetSector: number,
  deltaSeconds: number,
): number {
  const current = finiteClamped(currentSector, 1, 200, 1);
  const target = finiteClamped(targetSector, 1, 200, current);
  const elapsed = finiteNonNegative(deltaSeconds, 0);
  const difference = target - current;
  const movement = Math.min(
    Math.abs(difference),
    CAVE_DIFFICULTY_EASING_RATE_SECTORS_PER_SECOND * elapsed,
  );

  return clamp(current + Math.sign(difference) * movement, 1, 200);
}

/** Stable integer hash used only for deterministic cave shape generation. */
function hashLattice(lattice: number, seed: number): number {
  let value = (Math.floor(lattice) | 0) ^ seed;
  value = Math.imul(value ^ value >>> 16, 0x7feb_352d);
  value = Math.imul(value ^ value >>> 15, 0x846c_a68b);
  value = (value ^ value >>> 16) >>> 0;
  return value / UINT32_RANGE * 2 - 1;
}

/** Fixed-seed C2-continuous value noise in the range -1..1. */
function valueNoise(distance: number, wavelength: number, seed: number): number {
  const coordinate = distance / wavelength;
  const lower = Math.floor(coordinate);
  const local = coordinate - lower;
  return mix(hashLattice(lower, seed), hashLattice(lower + 1, seed), quintic(local));
}

/** Three band-limited octaves; the shortest wavelength remains renderer-safe. */
function fractalNoise(distance: number, baseWavelength: number, seed: number): number {
  const first = valueNoise(distance, baseWavelength, seed);
  const second = valueNoise(distance, baseWavelength * 0.5, seed ^ 0x68bc_21eb);
  const third = valueNoise(distance, baseWavelength * 0.25, seed ^ 0x02e5_be93);
  return (first * 0.58 + second * 0.28 + third * 0.14);
}

function longitudinalCoordinate(travelDistance: number, screenY: number): number {
  const safeTravel = finiteClamped(
    travelDistance,
    -CAVE_MAX_LONGITUDINAL_COORDINATE,
    CAVE_MAX_LONGITUDINAL_COORDINATE,
    0,
  );
  const safeScreenY = finiteClamped(screenY, -64, 64, 0);
  return clamp(
    safeTravel + CAVE_WORLD_TOP + safeScreenY,
    -CAVE_MAX_LONGITUDINAL_COORDINATE,
    CAVE_MAX_LONGITUDINAL_COORDINATE,
  );
}

/**
 * Samples the gameplay-safe foreground tunnel at a row of the screen.
 *
 * `travelDistance` grows as the jet advances. `screenY` uses Jetcreeper world
 * coordinates (-16 at the bottom and 16 at the top). Combining them makes one
 * continuous cave: a feature entering at the top retains its exact shape while
 * it travels down the screen.
 */
export function sampleCaveCorridor(
  travelDistance: number,
  screenY: number,
  sector: number,
): CaveCorridorSample {
  const distance = longitudinalCoordinate(travelDistance, screenY);
  const terminalProgress = terminalProgressForSector(sector);

  const bend = fractalNoise(distance, 112, CAVE_NOISE_SEEDS.bend);
  const widePinch = 0.5 + valueNoise(distance, 126, CAVE_NOISE_SEEDS.pinchWide) * 0.5;
  const detailedPinch = 0.5 + valueNoise(distance, 52, CAVE_NOISE_SEEDS.pinchDetail) * 0.5;
  const pinchCarrier = clamp(widePinch * 0.7 + detailedPinch * 0.3, 0, 1);
  const narrowing = smoothstep(0.46, 0.73, pinchCarrier);

  const leftShoulder = smoothstep(
    0.38,
    0.84,
    0.5 + fractalNoise(distance + 19, 60, CAVE_NOISE_SEEDS.leftShoulder) * 0.5,
  );
  const rightShoulder = smoothstep(
    0.38,
    0.84,
    0.5 + fractalNoise(distance - 23, 60, CAVE_NOISE_SEEDS.rightShoulder) * 0.5,
  );
  const leftEdge = fractalNoise(distance, 48, CAVE_NOISE_SEEDS.leftEdge);
  const rightEdge = fractalNoise(distance, 48, CAVE_NOISE_SEEDS.rightEdge);

  const baseInset = mix(0.58, 1.18, terminalProgress);
  const pinchDepth = mix(1.12, 3.48, terminalProgress);
  // Bend is deliberately stronger than the edge chatter: over a chamber the
  // whole aperture visibly sweeps sideways, while the independent walls stay
  // inside their exact five-unit intrusion caps.
  const bendDepth = mix(1.1, 2.65, terminalProgress);
  const shoulderDepth = mix(0.2, 0.48, terminalProgress);
  const edgeDepth = mix(0.09, 0.22, terminalProgress);
  const sharedInset = baseInset + narrowing * pinchDepth;

  // Positive bend moves the corridor right: the left wall advances while the
  // right wall recedes. Independent shoulder and edge fields prevent mirrors.
  const leftInset = clamp(
    sharedInset
      + bend * bendDepth
      + leftShoulder * shoulderDepth
      + leftEdge * edgeDepth,
    CAVE_MIN_WALL_INTRUSION,
    CAVE_MAX_WALL_INTRUSION,
  );
  const rightInset = clamp(
    sharedInset
      - bend * bendDepth
      + rightShoulder * shoulderDepth
      + rightEdge * edgeDepth,
    CAVE_MIN_WALL_INTRUSION,
    CAVE_MAX_WALL_INTRUSION,
  );

  const wallLeft = -CAVE_WORLD_HALF_WIDTH + leftInset;
  const wallRight = CAVE_WORLD_HALF_WIDTH - rightInset;
  const safeLeft = wallLeft + CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN;
  const safeRight = wallRight - CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN;
  const center = (safeLeft + safeRight) * 0.5;
  const halfWidth = Math.max(0, (safeRight - safeLeft) * 0.5);

  return {
    distance,
    center,
    halfWidth,
    safeLeft,
    safeRight,
    wallLeft,
    wallRight,
    narrowing,
  };
}

/**
 * Samples a visual stratum. Every structural silhouette is a static inset of
 * the same longitudinal foreground field, so a feature can only travel down
 * the screen and can never rubber-band against a second parallax field. The
 * renderer applies `layer.parallax` to rock texture instead. Only the exact
 * foreground rim is a gameplay wall; deeper silhouettes are perspective.
 */
export function sampleCaveLayerCorridor(
  layer: CaveLayerSpec,
  travelDistance: number,
  screenY: number,
  sector: number,
): CaveLayerCorridorSample {
  const foreground = sampleCaveCorridor(travelDistance, screenY, sector);
  if (layer.id === "rim") {
    return {
      center: foreground.center,
      halfWidth: foreground.halfWidth + CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
      left: foreground.wallLeft,
      right: foreground.wallRight,
    };
  }

  const center = foreground.center;
  const foregroundHalfWidth = foreground.halfWidth + CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN;
  const halfWidth = Math.max(1.35, foregroundHalfWidth - layer.apertureExpansion);

  return {
    center,
    halfWidth,
    left: center - halfWidth,
    right: center + halfWidth,
  };
}

function clearanceDetails(
  sample: CaveCorridorSample,
  x: number,
  radius: number,
  clearanceMargin: number,
): ClearanceDetails {
  const wallLeft = finiteClamped(
    sample.wallLeft,
    -CAVE_WORLD_HALF_WIDTH,
    CAVE_WORLD_HALF_WIDTH,
    -CAVE_WORLD_HALF_WIDTH,
  );
  const wallRight = finiteClamped(
    sample.wallRight,
    -CAVE_WORLD_HALF_WIDTH,
    CAVE_WORLD_HALF_WIDTH,
    CAVE_WORLD_HALF_WIDTH,
  );
  const orderedLeft = Math.min(wallLeft, wallRight);
  const orderedRight = Math.max(wallLeft, wallRight);
  const fallbackX = Number.isFinite(sample.center)
    ? sample.center
    : (orderedLeft + orderedRight) * 0.5;
  const safeX = Number.isFinite(x) ? x : fallbackX;
  const inflatedRadius = finiteNonNegative(radius, 0) + finiteNonNegative(
    clearanceMargin,
    CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
  );
  const leftClearance = safeX - orderedLeft - inflatedRadius;
  const rightClearance = orderedRight - safeX - inflatedRadius;

  return leftClearance <= rightClearance
    ? { clearance: leftClearance, side: "left" }
    : { clearance: rightClearance, side: "right" };
}

/**
 * Signed clearance between a circle and the nearer physical foreground wall.
 * Positive is safe, zero is tangent, and negative penetrates rock.
 */
export function caveWallClearance(
  sample: CaveCorridorSample,
  x: number,
  radius: number,
  clearanceMargin = CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
): number {
  return clearanceDetails(sample, x, radius, clearanceMargin).clearance;
}

function evaluateSweepPoint(
  options: {
    readonly startTravelDistance: number;
    readonly endTravelDistance: number;
    readonly start: CaveSweepPoint;
    readonly end: CaveSweepPoint;
    readonly sector: number;
    readonly radius: number;
    readonly clearanceMargin: number;
  },
  ratio: number,
): EvaluatedSweepPoint {
  const safeRatio = clamp(ratio, 0, 1);
  const travelDistance = mix(options.startTravelDistance, options.endTravelDistance, safeRatio);
  const position = {
    x: mix(options.start.x, options.end.x, safeRatio),
    y: mix(options.start.y, options.end.y, safeRatio),
  };
  const sample = sampleCaveCorridor(travelDistance, position.y, options.sector);
  const details = clearanceDetails(sample, position.x, options.radius, options.clearanceMargin);
  return {
    ratio: safeRatio,
    travelDistance,
    position,
    sample,
    clearance: details.clearance,
    side: details.side,
  };
}

/**
 * Sweeps a circular player footprint through a moving cave. Broad-phase sample
 * count adapts to both XY motion and longitudinal wall travel, remains bounded,
 * and the first detected crossing is refined deterministically by bisection.
 */
export function sweepCircleThroughCave(options: SweepCircleThroughCaveOptions): CaveSweepResult {
  const startTravelDistance = finiteClamped(
    options.startTravelDistance,
    -CAVE_MAX_LONGITUDINAL_COORDINATE,
    CAVE_MAX_LONGITUDINAL_COORDINATE,
    0,
  );
  const endTravelDistance = finiteClamped(
    options.endTravelDistance,
    -CAVE_MAX_LONGITUDINAL_COORDINATE,
    CAVE_MAX_LONGITUDINAL_COORDINATE,
    startTravelDistance,
  );
  const start = {
    x: Number.isFinite(options.start.x) ? options.start.x : 0,
    y: Number.isFinite(options.start.y) ? options.start.y : 0,
  };
  const end = {
    x: Number.isFinite(options.end.x) ? options.end.x : start.x,
    y: Number.isFinite(options.end.y) ? options.end.y : start.y,
  };
  const radius = finiteNonNegative(options.radius, 0);
  const clearanceMargin = finiteNonNegative(
    options.clearanceMargin ?? CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
    CAVE_WALL_TO_SAFE_CORRIDOR_MARGIN,
  );
  const maximumSampleSpacing = finiteClamped(
    options.maximumSampleSpacing ?? DEFAULT_SWEEP_SAMPLE_SPACING,
    0.1,
    8,
    DEFAULT_SWEEP_SAMPLE_SPACING,
  );
  const maximumSamples = Math.floor(finiteClamped(
    options.maximumSamples ?? CAVE_MAX_SWEEP_SAMPLES,
    2,
    CAVE_MAX_SWEEP_SAMPLES,
    CAVE_MAX_SWEEP_SAMPLES,
  ));
  const pathDistance = Math.hypot(end.x - start.x, end.y - start.y);
  const longitudinalDistance = Math.abs(
    (endTravelDistance + end.y) - (startTravelDistance + start.y),
  );
  const segmentCount = clamp(
    Math.ceil(Math.max(pathDistance, longitudinalDistance) / maximumSampleSpacing),
    1,
    maximumSamples - 1,
  );
  const normalized = {
    startTravelDistance,
    endTravelDistance,
    start,
    end,
    sector: Number.isFinite(options.sector) ? options.sector : 1,
    radius,
    clearanceMargin,
  };

  let previous = evaluateSweepPoint(normalized, 0);
  let minimum = previous;
  let collision: EvaluatedSweepPoint | null = previous.clearance <= COLLISION_EPSILON ? previous : null;

  for (let index = 1; index <= segmentCount; index += 1) {
    const current = evaluateSweepPoint(normalized, index / segmentCount);

    if (current.clearance < minimum.clearance) {
      minimum = current;
    }

    if (collision === null && current.clearance <= COLLISION_EPSILON) {
      if (previous.clearance <= COLLISION_EPSILON) {
        collision = previous;
      } else {
        let clearPoint = previous;
        let collidingPoint = current;

        for (let refinement = 0; refinement < COLLISION_REFINEMENT_STEPS; refinement += 1) {
          const midpoint = evaluateSweepPoint(
            normalized,
            (clearPoint.ratio + collidingPoint.ratio) * 0.5,
          );
          if (midpoint.clearance <= COLLISION_EPSILON) {
            collidingPoint = midpoint;
          } else {
            clearPoint = midpoint;
          }
        }
        collision = collidingPoint;
      }
    }

    previous = current;
  }

  return {
    collided: collision !== null,
    collisionRatio: collision?.ratio ?? null,
    minimumClearance: minimum.clearance,
    side: collision?.side ?? null,
    sample: minimum.sample,
    position: minimum.position,
    collisionSample: collision?.sample ?? null,
    collisionPosition: collision?.position ?? null,
    sampleCount: segmentCount + 1,
  };
}
