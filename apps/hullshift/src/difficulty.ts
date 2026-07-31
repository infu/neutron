export const DIFFICULTY_MIN = 0 as const;
export const DIFFICULTY_MAX = 8 as const;

export interface NumericRange {
  readonly min: number;
  readonly max: number;
}

export interface DifficultyFeatureVector {
  /** A: exact preferred-solution meaningful edge count. */
  readonly commitments: number;
  /** D: longest proven strict chain of mandatory milestones. */
  readonly dependencyDepth: number;
  /** P: greatest mandatory enable-to-use commitment distance. */
  readonly planningHorizon: number;
  /** I: maximum simultaneously open obligations on the accepted trace. */
  readonly interleaving: number;
  /** R: required forward-irreversible transitions on the preferred trace. */
  readonly irreversibility: number;
  /** B: mean log2(1 + meaningful non-equivalent successors). */
  readonly decisionPressure: number;
  /** X: mandatory dependencies joining different mechanic families. */
  readonly crossMechanicCoupling: number;
  /** E: log2(1 + reachable decision states). */
  readonly stateSpaceComplexity: number;
  /** F: exact fatal-frontier pressure at winning choice states. */
  readonly fatalChoicePressure: number;
  /** K: distinct mechanic families participating in the puzzle. */
  readonly mechanicFamilies: number;
  /** g4 K_present: statically present families, diagnostic only. */
  readonly mechanicFamiliesPresent?: number;
  /** g4 K_mandatory: families in solver-proven milestone dependencies. */
  readonly mechanicFamiliesMandatory?: number;
}

export interface DifficultyProfile {
  readonly difficulty: number;
  readonly label: string;
  readonly target: Readonly<DifficultyFeatureVector>;
  /** Frozen hard gates. Heuristic features are scored, not used as proof. */
  readonly hard: Readonly<{
    commitments: NumericRange;
    dependencyDepth: NumericRange;
    mechanicFamilies: NumericRange;
    interleaving: NumericRange;
    irreversibility: NumericRange;
    fatalChoicePressure: NumericRange;
  }>;
}

export interface DifficultyRating {
  readonly requestedDifficulty: number;
  readonly ratedDifficulty: number;
  readonly profileMatch: boolean;
  readonly hardViolations: readonly string[];
  readonly targetDistance: number;
  readonly challengeScore: number;
}

/**
 * Exact structure measured from the preferred solution and the winning graph.
 *
 * These fields remain part of modern level analysis and runtime decision
 * classification. They are independent of the removed map generator.
 */
export interface DecisionStructureMetrics {
  /** Direction changes across the preferred action sequence. */
  readonly solutionDirectionChanges: number;
  /** Distinct cardinal directions used by preferred-solution pushes. */
  readonly pushDirections: number;
  /** Distinct horizontal/vertical axes used by preferred-solution pushes. */
  readonly pushAxes: number;
  /** Distinct movable object ids pushed by the preferred solution. */
  readonly pushedObjects: number;
  /** Non-push actions strictly between the first and last preferred push. */
  readonly repositioningActions: number;
  /** Preferred-path states offering a non-backtracking, meaningful choice. */
  readonly winningChoiceStates: number;
  /** Such states with an unchosen successor that remains in the exact winning set. */
  readonly recoverableChoiceStates: number;
  /** Such states with an unchosen physical or exact causal losing successor. */
  readonly fatalChoiceStates: number;
  /** Contiguous preferred pushes of one object in one direction. */
  readonly pushRuns: number;
  /** Push runs which resume an object along a different cardinal direction. */
  readonly turningRegrips: number;
  /** Pushes which do not reduce distance to that object's final preferred landing cell. */
  readonly nonProgressPushes: number;
  /** A -> B -> A object returns across preferred push runs. */
  readonly objectRevisits: number;
  /** Longest preferred span with no push, terminal, or persistent mechanic change. */
  readonly longestConsequenceFreeRun: number;
  /** Share of preferred actions without such a consequence, in integer thousandths. */
  readonly consequenceFreePermille: number;
}

const LABELS = [
  "Orientation",
  "Cadet",
  "Technician",
  "Systems",
  "Hazard",
  "Specialist",
  "Veteran",
  "Architect",
  "Hullshifter",
] as const;

/** The provisional curves from specification section 8, represented exactly. */
export function provisionalTargets(difficulty: number): Readonly<{
  commitments: number;
  dependencyDepth: number;
  mechanicFamilies: number;
  interleaving: number;
}> {
  assertDifficulty(difficulty);
  return Object.freeze({
    commitments: 4 + 2 * difficulty + Math.floor(difficulty ** 1.2),
    dependencyDepth: 2 + Math.floor(1.2 * difficulty),
    mechanicFamilies: Math.min(1 + Math.floor((difficulty + 1) / 2), 6),
    interleaving: Math.min(Math.floor(difficulty / 3), 3),
  });
}

function frozenRange(min: number, max: number): NumericRange {
  return Object.freeze({ min, max });
}

function makeProfile(difficulty: number): DifficultyProfile {
  const provisional = provisionalTargets(difficulty);
  const aSlack = Math.max(1, Math.ceil(provisional.commitments * 0.2));
  const dSlack = Math.max(1, Math.ceil(provisional.dependencyDepth * 0.2));
  const fatalMaximum = difficulty === 0 ? 0 : difficulty <= 2 ? 0.15 : 1 / 3;
  const target: DifficultyFeatureVector = Object.freeze({
    commitments: provisional.commitments,
    dependencyDepth: provisional.dependencyDepth,
    planningHorizon: Math.max(1, Math.floor(provisional.dependencyDepth / 2)),
    interleaving: provisional.interleaving,
    irreversibility: Math.max(0, Math.floor(difficulty / 2)),
    decisionPressure: 0.45 + difficulty * 0.08,
    crossMechanicCoupling: Math.max(0, provisional.mechanicFamilies - 1),
    stateSpaceComplexity: 3.5 + difficulty * 0.6,
    fatalChoicePressure: difficulty === 0 ? 0 : Math.min(0.05 + difficulty * 0.02, 0.2),
    mechanicFamilies: provisional.mechanicFamilies,
  });
  return Object.freeze({
    difficulty,
    label: LABELS[difficulty]!,
    target,
    hard: Object.freeze({
      commitments: frozenRange(
        Math.max(1, provisional.commitments - aSlack),
        provisional.commitments + aSlack,
      ),
      dependencyDepth: frozenRange(
        Math.max(1, provisional.dependencyDepth - dSlack),
        provisional.dependencyDepth + dSlack,
      ),
      mechanicFamilies: frozenRange(Math.max(1, provisional.mechanicFamilies - 1), 6),
      // Interleaving remains a scored quality feature in g1. A strict chain is
      // still a valid high-difficulty puzzle when its proven A/D/R gates hold.
      interleaving: frozenRange(0, 3),
      irreversibility: frozenRange(Math.max(0, Math.floor(difficulty / 3) - 1), 16),
      fatalChoicePressure: frozenRange(0, fatalMaximum),
    }),
  });
}

export const DIFFICULTY_PROFILES: readonly DifficultyProfile[] = Object.freeze(
  Array.from({ length: DIFFICULTY_MAX + 1 }, (_, difficulty) => makeProfile(difficulty)),
);

export function assertDifficulty(difficulty: number): void {
  if (!Number.isInteger(difficulty) || difficulty < DIFFICULTY_MIN || difficulty > DIFFICULTY_MAX) {
    throw new RangeError(`Hullshift difficulty must be ${DIFFICULTY_MIN} through ${DIFFICULTY_MAX}`);
  }
}

export function profileForDifficulty(difficulty: number): DifficultyProfile {
  assertDifficulty(difficulty);
  return DIFFICULTY_PROFILES[difficulty]!;
}

function violation(name: string, value: number, range: NumericRange): string | undefined {
  if (!Number.isFinite(value) || value < range.min || value > range.max) {
    return `${name}=${Number.isFinite(value) ? value : "invalid"} outside ${range.min}..${range.max}`;
  }
  return undefined;
}

export function hardProfileViolations(
  features: DifficultyFeatureVector,
  difficulty: number,
): readonly string[] {
  const hard = profileForDifficulty(difficulty).hard;
  return Object.freeze([
    violation("A", features.commitments, hard.commitments),
    violation("D", features.dependencyDepth, hard.dependencyDepth),
    violation("K", features.mechanicFamilies, hard.mechanicFamilies),
    violation("I", features.interleaving, hard.interleaving),
    violation("R", features.irreversibility, hard.irreversibility),
    violation("F", features.fatalChoicePressure, hard.fatalChoicePressure),
  ].filter((entry): entry is string => entry !== undefined));
}

export function challengeScore(features: DifficultyFeatureVector): number {
  return (
    0.7 * features.commitments
    + 1.8 * features.dependencyDepth
    + 1.1 * features.planningHorizon
    + 1.3 * features.interleaving
    + features.irreversibility
    + 0.8 * features.decisionPressure
    + features.crossMechanicCoupling
    + 0.35 * features.stateSpaceComplexity
  );
}

type ScoredDifficultyFeature = Exclude<
  keyof DifficultyFeatureVector,
  "mechanicFamiliesPresent" | "mechanicFamiliesMandatory"
>;

const DISTANCE_WEIGHTS: Readonly<Record<ScoredDifficultyFeature, number>> = Object.freeze({
  // Proven decision/dependency structure dominates ordinal assignment. The
  // remaining features break close calls and support later calibration.
  commitments: 10,
  dependencyDepth: 10,
  planningHorizon: 0.2,
  interleaving: 0.2,
  irreversibility: 0.25,
  decisionPressure: 0.1,
  crossMechanicCoupling: 0.2,
  stateSpaceComplexity: 0.1,
  fatalChoicePressure: 0.1,
  mechanicFamilies: 0.2,
});

export function targetDistance(
  features: DifficultyFeatureVector,
  difficulty: number,
): number {
  const target = profileForDifficulty(difficulty).target;
  let distance = 0;
  for (const key of Object.keys(DISTANCE_WEIGHTS) as ScoredDifficultyFeature[]) {
    const scale = Math.max(1, Math.abs(target[key]));
    distance += DISTANCE_WEIGHTS[key] * Math.abs(features[key] - target[key]) / scale;
  }
  return distance;
}

/** Nearest full profile, with the required deterministic lower-difficulty tie break. */
export function rateDifficulty(features: DifficultyFeatureVector): number {
  let bestDifficulty = DIFFICULTY_MIN;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let difficulty = DIFFICULTY_MIN; difficulty <= DIFFICULTY_MAX; difficulty += 1) {
    const distance = targetDistance(features, difficulty);
    if (distance < bestDistance) {
      bestDifficulty = difficulty;
      bestDistance = distance;
    }
  }
  return bestDifficulty;
}

export function evaluateDifficulty(
  features: DifficultyFeatureVector,
  requestedDifficulty: number,
): DifficultyRating {
  const hardViolations = hardProfileViolations(features, requestedDifficulty);
  return Object.freeze({
    requestedDifficulty,
    ratedDifficulty: rateDifficulty(features),
    profileMatch: hardViolations.length === 0,
    hardViolations,
    targetDistance: targetDistance(features, requestedDifficulty),
    challengeScore: challengeScore(features),
  });
}
