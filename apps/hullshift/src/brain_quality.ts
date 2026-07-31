import { assertDifficulty, type DecisionStructureMetrics } from "./difficulty.ts";
import {
  type Coord,
  type FixtureDefinition,
  type LevelDefinition,
  indexCoord,
} from "./model.ts";
import type {
  MilestoneGuard,
  MilestoneSpec,
  MilestoneStatePredicate,
  MilestoneTrigger,
} from "./milestone_dsl.ts";
import {
  COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
  type AnalysisReport,
} from "./solver.ts";

export const BRAIN_QUALITY_POLICY_VERSION = "hullshiftbrain-quality-v1" as const;

export type BrainQualityMode = "pilot" | "release";

export interface BrainQualityCandidate {
  readonly level: LevelDefinition;
  readonly difficulty: number;
  readonly analysis: AnalysisReport;
  readonly milestoneSpecs: readonly MilestoneSpec[];
}

export type BrainQualityViolationCode =
  | "not-g4"
  | "unsolved"
  | "decision-report-missing"
  | "decision-report-invalid"
  | "decision-complexity-below-minimum"
  | "walking-run-excess"
  | "walking-ratio-excess"
  | "straight-push-padding"
  | "fatal-pressure-excess"
  | "fatal-choice-in-orientation"
  | "macro-report-missing"
  | "macro-report-invalid"
  | "macro-material-solution-excess"
  | "interaction-report-missing"
  | "interaction-report-invalid"
  | "balanced-decomposition-unsupported"
  | "balanced-decomposition-below-minimum"
  | "recurring-resources-below-minimum"
  | "counterintuitive-metric-unsupported"
  | "counterintuitive-commitments-below-minimum"
  | "milestone-not-mandatory"
  | "mandatory-milestone-without-spec"
  | "milestone-report-invalid"
  | "object-without-mandatory-reference"
  | "fixture-without-mandatory-reference"
  | "fracture-without-mandatory-reference";

export interface BrainQualityViolation {
  readonly code: BrainQualityViolationCode;
  readonly message: string;
  readonly subject?: string;
  readonly actual?: number | string;
  readonly required?: number | string;
}

export interface BrainQualityTarget {
  readonly difficulty: number;
  readonly maximumFatalPressure: number;
  readonly maximumConsequenceFreeRun: number;
  readonly maximumConsequenceFreePermille: number;
  /** Twice the maximum allowed mean pushes per preferred push run. */
  readonly maximumMeanPushRunTwice: number;
  readonly minimumDecisionSignalKinds: number;
  readonly minimumRecurringResources: number;
  readonly minimumBalancedDecomposition: number;
  readonly minimumCounterintuitiveCommitments: number;
  /** A definite reject only when the bounded observed lower count exceeds this. */
  readonly maximumMaterialMacroSolutions: number;
}

const FATAL_MAXIMUMS = [0, 0.10, 0.15, 0.20, 0.25, 0.25, 0.30, 1 / 3, 1 / 3] as const;
const WALK_RUN_MAXIMUMS = [64, 40, 30, 24, 20, 16, 16, 18, 16] as const;
const WALK_PERMILLE_MAXIMUMS = [1_000, 975, 925, 900, 850, 825, 825, 825, 780] as const;
const PUSH_RUN_TWICE_MAXIMUMS = [8, 8, 8, 7, 7, 6, 6, 6, 6] as const;
const DECISION_SIGNAL_MINIMUMS = [0, 0, 1, 1, 2, 2, 3, 3, 4] as const;
const RECURRING_RESOURCE_MINIMUMS = [0, 0, 1, 1, 2, 2, 2, 2, 2] as const;
const BALANCED_DECOMPOSITION_MINIMUMS = [0, 1, 2, 3, 4, 5, 6, 8, 10] as const;
const COUNTERINTUITIVE_MINIMUMS = [0, 0, 1, 1, 2, 2, 3, 4, 5] as const;
const MATERIAL_MACRO_MAXIMUMS = [8, 8, 6, 4, 3, 3, 3, 2, 2] as const;

/**
 * Versioned pilot targets. These are deterministic screening bounds, not a
 * claim of human calibration. Changing them requires a policy version bump.
 */
export const BRAIN_QUALITY_TARGETS: readonly BrainQualityTarget[] = Object.freeze(
  Array.from({ length: 9 }, (_, difficulty) => Object.freeze({
    difficulty,
    maximumFatalPressure: FATAL_MAXIMUMS[difficulty]!,
    maximumConsequenceFreeRun: WALK_RUN_MAXIMUMS[difficulty]!,
    maximumConsequenceFreePermille: WALK_PERMILLE_MAXIMUMS[difficulty]!,
    maximumMeanPushRunTwice: PUSH_RUN_TWICE_MAXIMUMS[difficulty]!,
    minimumDecisionSignalKinds: DECISION_SIGNAL_MINIMUMS[difficulty]!,
    minimumRecurringResources: RECURRING_RESOURCE_MINIMUMS[difficulty]!,
    minimumBalancedDecomposition: BALANCED_DECOMPOSITION_MINIMUMS[difficulty]!,
    minimumCounterintuitiveCommitments: COUNTERINTUITIVE_MINIMUMS[difficulty]!,
    maximumMaterialMacroSolutions: MATERIAL_MACRO_MAXIMUMS[difficulty]!,
  })),
);

export function pilotBrainQualityViolations(
  candidate: BrainQualityCandidate,
): readonly BrainQualityViolation[] {
  return brainQualityViolations(candidate, "pilot");
}

export function releaseBrainQualityViolations(
  candidate: BrainQualityCandidate,
): readonly BrainQualityViolation[] {
  return brainQualityViolations(candidate, "release");
}

/**
 * Pure O(level + specs) quality policy over an already exact analysis report.
 * It does not rerun search, mutate a catalog, or pretend that a reference is a
 * fixed-point ablation proof.
 */
export function brainQualityViolations(
  candidate: BrainQualityCandidate,
  mode: BrainQualityMode,
): readonly BrainQualityViolation[] {
  assertDifficulty(candidate.difficulty);
  const target = BRAIN_QUALITY_TARGETS[candidate.difficulty]!;
  const violations: BrainQualityViolation[] = [];
  if (candidate.level.generatorVersion !== "g4") {
    add(violations, "not-g4", "Quality policy applies only to g4 levels", {
      actual: candidate.level.generatorVersion,
      required: "g4",
    });
  }
  if (!candidate.analysis.solvable || candidate.analysis.preferredSolution === null) {
    add(violations, "unsolved", "Exact analysis has no preferred winning solution");
  }

  checkMilestoneContract(candidate, violations);
  checkMandatoryElementReferences(candidate, violations);
  checkDecisionAndWalking(candidate, target, violations);
  checkFatalPressure(candidate, target, violations);
  checkMacroProjection(candidate, target, violations);
  checkInteraction(candidate, target, mode, violations);
  return Object.freeze(violations);
}

function checkDecisionAndWalking(
  candidate: BrainQualityCandidate,
  target: BrainQualityTarget,
  violations: BrainQualityViolation[],
): void {
  const decision = candidate.analysis.decisionStructure;
  if (decision === undefined) {
    add(violations, "decision-report-missing", "g4 analysis lacks decision-structure metrics");
    return;
  }
  const preferred = candidate.analysis.preferredSolution;
  if (!validDecisionReport(decision, candidate)) {
    add(violations, "decision-report-invalid", "Decision-structure counts are internally inconsistent");
  }
  const signals = decisionSignalKinds(candidate, decision);
  if (signals < target.minimumDecisionSignalKinds) {
    add(
      violations,
      "decision-complexity-below-minimum",
      `Only ${signals} independent decision-complexity signals are present`,
      { actual: signals, required: target.minimumDecisionSignalKinds },
    );
  }
  if (decision.longestConsequenceFreeRun > target.maximumConsequenceFreeRun) {
    add(violations, "walking-run-excess", "Preferred solution contains too long a consequence-free run", {
      actual: decision.longestConsequenceFreeRun,
      required: `<=${target.maximumConsequenceFreeRun}`,
    });
  }
  if (decision.consequenceFreePermille > target.maximumConsequenceFreePermille) {
    add(violations, "walking-ratio-excess", "Preferred solution contains too much consequence-free walking", {
      actual: decision.consequenceFreePermille,
      required: `<=${target.maximumConsequenceFreePermille}`,
    });
  }
  if (
    preferred !== null
    && preferred.pushes > 0
    && decision.pushRuns > 0
    && preferred.pushes * 2 > decision.pushRuns * target.maximumMeanPushRunTwice
  ) {
    add(violations, "straight-push-padding", "Preferred pushes are concentrated in long straight runs", {
      actual: `${preferred.pushes}/${decision.pushRuns} pushes per run`,
      required: `<=${target.maximumMeanPushRunTwice}/2 mean`,
    });
  }
}

function validDecisionReport(
  decision: DecisionStructureMetrics,
  candidate: BrainQualityCandidate,
): boolean {
  const values = Object.values(decision);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return false;
  const preferred = candidate.analysis.preferredSolution;
  if (decision.consequenceFreePermille > 1_000) return false;
  if (decision.recoverableChoiceStates > decision.winningChoiceStates) return false;
  if (decision.fatalChoiceStates > decision.winningChoiceStates) return false;
  if (decision.pushedObjects > candidate.level.objects.length) return false;
  if (preferred === null) return true;
  if (decision.pushRuns > preferred.pushes) return false;
  if ((preferred.pushes === 0) !== (decision.pushRuns === 0)) return false;
  return true;
}

function decisionSignalKinds(
  candidate: BrainQualityCandidate,
  decision: DecisionStructureMetrics,
): number {
  const interaction = candidate.analysis.interaction;
  return [
    decision.turningRegrips > 0,
    decision.nonProgressPushes > 0,
    decision.objectRevisits > 0,
    decision.recoverableChoiceStates > 0,
    candidate.analysis.features.interleaving > 0,
    candidate.analysis.features.crossMechanicCoupling > 0,
    (interaction?.mechanicFamilyAlternations ?? 0) > 0,
  ].filter(Boolean).length;
}

function checkFatalPressure(
  candidate: BrainQualityCandidate,
  target: BrainQualityTarget,
  violations: BrainQualityViolation[],
): void {
  const pressure = candidate.analysis.features.fatalChoicePressure;
  if (!Number.isFinite(pressure) || pressure < 0 || pressure > target.maximumFatalPressure) {
    add(violations, "fatal-pressure-excess", "Exact fatal-choice pressure exceeds the band cap", {
      actual: Number.isFinite(pressure) ? pressure : "invalid",
      required: `<=${target.maximumFatalPressure}`,
    });
  }
  if (candidate.difficulty === 0 && (candidate.analysis.decisionStructure?.fatalChoiceStates ?? 0) > 0) {
    add(violations, "fatal-choice-in-orientation", "Difficulty 0 cannot contain a fatal winning-frontier choice");
  }
}

function checkMacroProjection(
  candidate: BrainQualityCandidate,
  target: BrainQualityTarget,
  violations: BrainQualityViolation[],
): void {
  const macro = candidate.analysis.macroProjection;
  if (macro === undefined) {
    add(violations, "macro-report-missing", "g4 analysis lacks the neutral-region macro projection");
    return;
  }
  const preferred = candidate.analysis.preferredSolution;
  if (
    macro.schemaVersion !== "neutral-scc-v1"
    || macro.rawStateCount !== candidate.analysis.stateCount
    || !Number.isSafeInteger(macro.macroStateCount)
    || macro.macroStateCount < 1
    || macro.macroStateCount > macro.rawStateCount
    || !Number.isSafeInteger(macro.winningMacroStateCount)
    || macro.winningMacroStateCount < 1
    || macro.winningMacroStateCount > macro.macroStateCount
    || !Number.isSafeInteger(macro.decisionTransitionCount)
    || macro.decisionTransitionCount < 1
    || macro.preferredCommitments !== (preferred?.commitments ?? 0)
    || !Number.isSafeInteger(macro.retainedMaterialSolutions)
    || macro.retainedMaterialSolutions < 1
    || macro.retainedMaterialSolutions > macro.retainedSolutionCap
  ) {
    add(violations, "macro-report-invalid", "Macro projection is missing or inconsistent with the raw report");
    return;
  }
  // The retained count is explicitly non-exact. It is nevertheless a sound
  // lower bound: observing more than the band maximum proves multiplicity is
  // already too high; observing fewer does not prove the maximum is met.
  if (macro.retainedMaterialSolutions > target.maximumMaterialMacroSolutions) {
    add(violations, "macro-material-solution-excess", "Observed material macro solutions exceed the band maximum", {
      actual: macro.retainedMaterialSolutions,
      required: `<=${target.maximumMaterialMacroSolutions}`,
    });
  }
}

function checkInteraction(
  candidate: BrainQualityCandidate,
  target: BrainQualityTarget,
  mode: BrainQualityMode,
  violations: BrainQualityViolation[],
): void {
  const interaction = candidate.analysis.interaction;
  if (interaction === undefined || interaction.schemaVersion !== "interaction-metrics-v1") {
    add(violations, "interaction-report-missing", "g4 analysis lacks interaction metrics");
    return;
  }
  const recurringResources = new Set(interaction.recurringResourceLabels);
  const decomposition = interaction.balancedDecomposition;
  const counterintuitive = interaction.counterintuitiveCommitments;
  const modeledResources = counterintuitive.supported
    ? new Set(counterintuitive.modeledRecurringResourceLabels)
    : new Set<string>();
  const interactionInvalid = (
    recurringResources.size !== interaction.recurringResourceLabels.length
    || interaction.recurringResourceLabels.some((label) => !isResourceLabel(label))
    || !isNonNegativeInteger(interaction.entityMechanicAlternations)
    || !isNonNegativeInteger(interaction.mechanicFamilyAlternations)
    || !isNonNegativeInteger(interaction.preferredBalancedDecompositionCost)
    || (decomposition.supported && (
      !isNonNegativeInteger(decomposition.value)
      || !isNonNegativeInteger(decomposition.commitmentBudget)
      || !isNonNegativeInteger(decomposition.partitionsEvaluated)
      || decomposition.commitmentBudget !== (candidate.analysis.preferredSolution?.commitments ?? 0) + 2
      || (recurringResources.size < 2
        ? decomposition.value !== 0 || decomposition.partitionsEvaluated !== 0
        : decomposition.partitionsEvaluated < 1)
    ))
    || counterintuitive.schemaVersion !== COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION
    || (counterintuitive.supported && (
      !isNonNegativeInteger(counterintuitive.value)
      || counterintuitive.commitmentBudget !== (candidate.analysis.preferredSolution?.commitments ?? 0) + 2
      || counterintuitive.value > counterintuitive.commitmentBudget
      || !Number.isSafeInteger(counterintuitive.productStatesEvaluated)
      || counterintuitive.productStatesEvaluated < 1
      || modeledResources.size !== counterintuitive.modeledRecurringResourceLabels.length
      || counterintuitive.modeledRecurringResourceLabels.some((label) => (
        !isResourceLabel(label) || !recurringResources.has(label)
      ))
    ))
    || (!counterintuitive.supported
      && counterintuitive.reason !== "unsolved"
      && counterintuitive.reason !== "product-state-budget")
  );
  if (interactionInvalid) {
    add(violations, "interaction-report-invalid", "Interaction metrics are internally inconsistent");
  }
  if (recurringResources.size < target.minimumRecurringResources) {
    add(violations, "recurring-resources-below-minimum", "Too few solver-proven recurring resources", {
      actual: recurringResources.size,
      required: target.minimumRecurringResources,
    });
  }
  if (!decomposition.supported) {
    add(
      violations,
      "balanced-decomposition-unsupported",
      `Exact balanced decomposition is unavailable: ${decomposition.reason}`,
      { actual: decomposition.reason, required: "supported" },
    );
  } else if (mode === "release" && decomposition.value < target.minimumBalancedDecomposition) {
    add(violations, "balanced-decomposition-below-minimum", "Exact Z is below the release target", {
      actual: decomposition.value,
      required: target.minimumBalancedDecomposition,
    });
  }

  if (mode !== "release" || target.minimumCounterintuitiveCommitments === 0) return;
  if (!counterintuitive.supported) {
    add(
      violations,
      "counterintuitive-metric-unsupported",
      "Required exact U exceeded its bounded product-state support",
      { actual: counterintuitive.reason, required: target.minimumCounterintuitiveCommitments },
    );
  } else if (counterintuitive.value < target.minimumCounterintuitiveCommitments) {
    add(violations, "counterintuitive-commitments-below-minimum", "Exact U is below the release target", {
      actual: counterintuitive.value,
      required: target.minimumCounterintuitiveCommitments,
    });
  }
}

function checkMilestoneContract(
  candidate: BrainQualityCandidate,
  violations: BrainQualityViolation[],
): void {
  const specIds = new Set(candidate.milestoneSpecs.map((spec) => spec.id));
  const mandatory = new Set(candidate.analysis.milestones.mandatoryIds);
  for (const spec of candidate.milestoneSpecs) {
    if (!mandatory.has(spec.id)) {
      add(violations, "milestone-not-mandatory", "Intended milestone is bypassable", {
        subject: spec.id,
      });
    }
  }
  for (const id of mandatory) {
    if (!specIds.has(id)) {
      add(violations, "mandatory-milestone-without-spec", "Mandatory report id has no serialized specification", {
        subject: id,
      });
    }
  }
  for (const relation of candidate.analysis.milestones.precedence) {
    if (!mandatory.has(relation.before) || !mandatory.has(relation.after)) {
      add(violations, "milestone-report-invalid", "Precedence endpoint is not a mandatory milestone", {
        subject: `${relation.before}->${relation.after}`,
      });
    }
  }
}

interface MilestoneReferences {
  readonly objects: Set<string>;
  readonly fixtures: Set<string>;
  readonly positions: Set<string>;
}

function checkMandatoryElementReferences(
  candidate: BrainQualityCandidate,
  violations: BrainQualityViolation[],
): void {
  const mandatory = new Set(candidate.analysis.milestones.mandatoryIds);
  const references: MilestoneReferences = {
    objects: new Set<string>(),
    fixtures: new Set<string>(),
    positions: new Set<string>(),
  };
  for (const spec of candidate.milestoneSpecs) {
    if (!mandatory.has(spec.id)) continue;
    collectTriggerReferences(spec.trigger, references);
    if (spec.guard !== undefined) collectGuardReferences(spec.guard, references);
  }
  for (const object of candidate.level.objects) {
    if (!references.objects.has(object.id)) {
      add(violations, "object-without-mandatory-reference", "Movable object has no mandatory milestone reference", {
        subject: object.id,
      });
    }
  }
  for (const cell of candidate.level.cells) {
    const fixture = cell.fixture;
    if (fixture === undefined || fixture.kind === "gate") continue;
    if (!references.fixtures.has(fixture.id)) {
      add(violations, "fixture-without-mandatory-reference", "Interactive fixture has no mandatory milestone reference", {
        subject: fixture.id,
      });
    }
  }
  for (let index = 0; index < candidate.level.cells.length; index += 1) {
    if (candidate.level.cells[index]?.terrain !== "fracture") continue;
    const position = indexCoord(candidate.level, index);
    const key = coordKey(position);
    if (!references.positions.has(key)) {
      add(violations, "fracture-without-mandatory-reference", "Fracture has no mandatory milestone reference", {
        subject: key,
      });
    }
  }
}

function collectTriggerReferences(trigger: MilestoneTrigger, references: MilestoneReferences): void {
  if ("delta" in trigger) {
    collectStatePredicateReferences(trigger.delta.predicate, references);
    return;
  }
  if (trigger.objectId !== undefined) references.objects.add(trigger.objectId);
  if (trigger.fixtureId !== undefined) references.fixtures.add(trigger.fixtureId);
  // A coordinate-only movement/push milestone does not prove the terrain at
  // that coordinate matters. Fracture events do: their DSL validation requires
  // the referenced cell to be fracture terrain.
  if (trigger.event === "fracture-collapsed" && trigger.position !== undefined) {
    references.positions.add(coordKey(trigger.position));
  }
}

function collectGuardReferences(guard: MilestoneGuard, references: MilestoneReferences): void {
  if ("beforeState" in guard) {
    collectStatePredicateReferences(guard.beforeState, references);
  } else if ("afterState" in guard) {
    collectStatePredicateReferences(guard.afterState, references);
  } else if ("not" in guard) {
    collectGuardReferences(guard.not, references);
  } else {
    for (const child of "all" in guard ? guard.all : guard.any) {
      collectGuardReferences(child, references);
    }
  }
}

function collectStatePredicateReferences(
  predicate: MilestoneStatePredicate,
  references: MilestoneReferences,
): void {
  if ("entityAt" in predicate) {
    if (predicate.entityAt.entityId !== "player") references.objects.add(predicate.entityAt.entityId);
    references.positions.add(coordKey(predicate.entityAt.position));
  } else if ("relayState" in predicate) {
    references.fixtures.add(predicate.relayState.fixtureId);
  } else if ("socketInstallation" in predicate) {
    references.fixtures.add(predicate.socketInstallation.fixtureId);
    if (predicate.socketInstallation.objectId !== undefined) {
      references.objects.add(predicate.socketInstallation.objectId);
    }
  } else if ("fractureState" in predicate) {
    references.positions.add(coordKey(predicate.fractureState.position));
  } else if ("objectRemoved" in predicate) {
    references.objects.add(predicate.objectRemoved.objectId);
  } else if ("consumerState" in predicate) {
    references.fixtures.add(predicate.consumerState.fixtureId);
  }
}

function coordKey(position: Coord): string {
  return `${position.x},${position.y}`;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isResourceLabel(label: string): boolean {
  return label.startsWith("object:")
    || label.startsWith("fixture:")
    || label.startsWith("fracture:");
}

function add(
  violations: BrainQualityViolation[],
  code: BrainQualityViolationCode,
  message: string,
  detail: Readonly<{
    subject?: string;
    actual?: number | string;
    required?: number | string;
  }> = {},
): void {
  violations.push(Object.freeze({ code, message, ...detail }));
}

/** Used by policy tests and offline reports to enumerate exempt/non-exempt fixtures. */
export function qualityRelevantFixtureIds(level: LevelDefinition): readonly string[] {
  return Object.freeze(level.cells
    .map((cell) => cell.fixture)
    .filter((fixture): fixture is FixtureDefinition => fixture !== undefined && fixture.kind !== "gate")
    .map((fixture) => fixture.id)
    .sort());
}
