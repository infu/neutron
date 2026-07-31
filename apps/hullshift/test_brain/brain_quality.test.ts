import { describe, expect, test } from "bun:test";
import {
  BRAIN_QUALITY_POLICY_VERSION,
  pilotBrainQualityViolations,
  qualityRelevantFixtureIds,
  releaseBrainQualityViolations,
  type BrainQualityCandidate,
} from "../src/brain_quality.ts";
import type { DecisionStructureMetrics, DifficultyFeatureVector } from "../src/difficulty.ts";
import type { CellDefinition, LevelDefinition } from "../src/model.ts";
import {
  MILESTONE_DSL_VERSION,
  type MilestoneSpec,
} from "../src/milestone_dsl.ts";
import {
  COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
  DEFAULT_ANALYSIS_LIMITS,
  type AnalysisReport,
  type InteractionMetrics,
  type MacroProjectionReport,
} from "../src/solver.ts";

function qualityLevel(options: { readonly extraFixture?: boolean; readonly fracture?: boolean } = {}): LevelDefinition {
  const width = 7;
  const height = 7;
  const cells: CellDefinition[] = Array.from({ length: width * height }, () => ({ terrain: "floor" }));
  cells[3 * width + 3] = {
    terrain: "floor",
    fixture: { kind: "plate", id: "plate-a", channel: "a" },
  };
  if (options.fracture) cells[4 * width + 3] = { terrain: "fracture" };
  cells[3 * width + 5] = {
    terrain: "floor",
    fixture: { kind: "gate", id: "gate-a", channel: "a" },
  };
  if (options.extraFixture) {
    cells[2 * width + 4] = {
      terrain: "floor",
      fixture: { kind: "door", id: "door-a", channel: "a" },
    };
  }
  return {
    generatorVersion: "g4",
    width,
    height,
    channels: [{ id: "a", symbol: "A" }],
    cells,
    playerStart: { x: 1, y: 3 },
    objects: [{ id: "cargo-a", kind: "cargo", position: { x: 2, y: 3 } }],
  };
}

function qualitySpecs(): readonly MilestoneSpec[] {
  return [
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "push-cargo",
      family: "pushing",
      trigger: { event: "object-pushed", objectId: "cargo-a" },
      occurrence: 1,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "activate-plate",
      family: "momentary-circuit",
      trigger: { event: "source-changed", fixtureId: "plate-a", active: true },
      occurrence: 1,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "evacuate",
      family: "evacuation",
      trigger: { event: "gate-entered", fixtureId: "gate-a" },
      occurrence: 1,
    },
  ];
}

const BASE_DECISION: DecisionStructureMetrics = Object.freeze({
  solutionDirectionChanges: 3,
  pushDirections: 2,
  pushAxes: 2,
  pushedObjects: 1,
  repositioningActions: 2,
  winningChoiceStates: 1,
  recoverableChoiceStates: 1,
  fatalChoiceStates: 0,
  pushRuns: 1,
  turningRegrips: 1,
  nonProgressPushes: 1,
  objectRevisits: 1,
  longestConsequenceFreeRun: 5,
  consequenceFreePermille: 500,
});

const BASE_FEATURES: DifficultyFeatureVector = Object.freeze({
  commitments: 8,
  dependencyDepth: 3,
  planningHorizon: 2,
  interleaving: 1,
  irreversibility: 1,
  decisionPressure: 0.5,
  crossMechanicCoupling: 2,
  stateSpaceComplexity: 4,
  fatalChoicePressure: 0,
  mechanicFamilies: 2,
  mechanicFamiliesPresent: 3,
  mechanicFamiliesMandatory: 2,
});

const BASE_MACRO: MacroProjectionReport = Object.freeze({
  schemaVersion: "neutral-scc-v1",
  rawStateCount: 10,
  macroStateCount: 4,
  winningMacroStateCount: 3,
  decisionTransitionCount: 8,
  preferredCommitments: 8,
  retainedMaterialSolutions: 2,
  retainedSolutionCap: 8,
  retainedSolutionCapReached: false,
  retainedMaterialSolutionCountExact: false,
});

const BASE_INTERACTION: InteractionMetrics = Object.freeze({
  schemaVersion: "interaction-metrics-v1",
  preferredCommitmentLabels: ["object:cargo-a", "fixture:plate-a", "object:cargo-a"],
  entityMechanicAlternations: 2,
  mechanicFamilyAlternations: 2,
  recurringResourceLabels: ["object:cargo-a", "fixture:plate-a"],
  preferredBalancedDecompositionCost: 4,
  balancedDecomposition: {
    supported: true,
    value: 4,
    commitmentBudget: 10,
    partitionsEvaluated: 1,
  },
  counterintuitiveCommitments: {
    schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
    supported: true,
    value: 4,
    commitmentBudget: 10,
    productStatesEvaluated: 20,
    modeledRecurringResourceLabels: ["object:cargo-a", "fixture:plate-a"],
  },
});

interface AnalysisOverrides {
  readonly features?: Partial<DifficultyFeatureVector>;
  readonly decision?: Partial<DecisionStructureMetrics> | null;
  readonly macro?: Partial<MacroProjectionReport> | null;
  readonly interaction?: Partial<InteractionMetrics> | null;
  readonly mandatoryIds?: readonly string[];
  readonly preferredPushes?: number;
  readonly preferredCommitments?: number;
}

function qualityAnalysis(overrides: AnalysisOverrides = {}): AnalysisReport {
  const commitments = overrides.preferredCommitments ?? 8;
  const pushes = overrides.preferredPushes ?? 2;
  const decision = overrides.decision === null
    ? undefined
    : { ...BASE_DECISION, ...overrides.decision };
  const macro = overrides.macro === null
    ? undefined
    : { ...BASE_MACRO, preferredCommitments: commitments, ...overrides.macro } as MacroProjectionReport;
  const interaction = overrides.interaction === null
    ? undefined
    : { ...BASE_INTERACTION, ...overrides.interaction } as InteractionMetrics;
  const mandatoryIds = overrides.mandatoryIds ?? ["push-cargo", "activate-plate", "evacuate"];
  return {
    solvable: true,
    initialStateKey: "state-0",
    winningStateKeys: new Set(["state-0"]),
    fatalFrontier: [],
    preferredSolution: {
      actions: ["E", "E", "N", "E"],
      commitments,
      pushes,
      totalActions: 4,
    },
    optimalActions: 4,
    optimalPushes: pushes,
    retainedNearOptimalSolutions: [],
    stateCount: 10,
    transitionCount: 20,
    physicalFailureTransitionCount: 0,
    victoryTransitionCount: 1,
    estimatedBytes: 1_000,
    limits: DEFAULT_ANALYSIS_LIMITS,
    milestones: {
      mandatoryIds,
      precedence: [
        { before: "push-cargo", after: "activate-plate" },
        { before: "activate-plate", after: "evacuate" },
      ],
      dependencyDepth: 3,
      planningHorizon: 2,
      crossMechanicCoupling: 2,
      mandatoryFamilies: ["momentary-circuit", "pushing"],
    },
    features: { ...BASE_FEATURES, commitments, ...overrides.features },
    difficulty: null,
    ...(decision === undefined ? {} : { decisionStructure: decision }),
    ...(macro === undefined ? {} : { macroProjection: macro }),
    ...(interaction === undefined ? {} : { interaction }),
  };
}

function candidate(
  difficulty: number,
  analysis: AnalysisReport = qualityAnalysis(),
  level: LevelDefinition = qualityLevel(),
  milestoneSpecs: readonly MilestoneSpec[] = qualitySpecs(),
): BrainQualityCandidate {
  return { difficulty, analysis, level, milestoneSpecs };
}

function codes(violations: ReturnType<typeof pilotBrainQualityViolations>): readonly string[] {
  return violations.map((violation) => violation.code);
}

describe("pure HullshiftBrain quality policy", () => {
  test("accepts a fully referenced difficulty-zero pilot and release report", () => {
    const analysis = qualityAnalysis({
      features: { interleaving: 0, crossMechanicCoupling: 0 },
      decision: {
        recoverableChoiceStates: 0,
        turningRegrips: 0,
        nonProgressPushes: 0,
        objectRevisits: 0,
      },
      interaction: {
        mechanicFamilyAlternations: 0,
        recurringResourceLabels: [],
        balancedDecomposition: {
          supported: true,
          value: 0,
          commitmentBudget: 10,
          partitionsEvaluated: 0,
        },
        counterintuitiveCommitments: {
          schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
          supported: true,
          value: 0,
          commitmentBudget: 10,
          productStatesEvaluated: 1,
          modeledRecurringResourceLabels: [],
        },
      },
    });
    expect(BRAIN_QUALITY_POLICY_VERSION).toBe("hullshiftbrain-quality-v1");
    expect(pilotBrainQualityViolations(candidate(0, analysis))).toEqual([]);
    expect(releaseBrainQualityViolations(candidate(0, analysis))).toEqual([]);
  });

  test("accepts a supported exact U which reaches the release minimum", () => {
    const high = candidate(4);
    expect(pilotBrainQualityViolations(high)).toEqual([]);
    expect(releaseBrainQualityViolations(high)).toEqual([]);
  });

  test("keeps pilot useful while blocking release when exact U exceeds its product budget", () => {
    const analysis = qualityAnalysis({
      interaction: {
        counterintuitiveCommitments: {
          schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
          supported: false,
          reason: "product-state-budget",
        },
      },
    });
    expect(pilotBrainQualityViolations(candidate(4, analysis))).toEqual([]);
    expect(codes(releaseBrainQualityViolations(candidate(4, analysis)))).toContain(
      "counterintuitive-metric-unsupported",
    );

    const belowMinimum = qualityAnalysis({
      interaction: {
        counterintuitiveCommitments: {
          schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
          supported: true,
          value: 1,
          commitmentBudget: 10,
          productStatesEvaluated: 20,
          modeledRecurringResourceLabels: ["fixture:plate-a"],
        },
      },
    });
    expect(codes(releaseBrainQualityViolations(candidate(4, belowMinimum)))).toContain(
      "counterintuitive-commitments-below-minimum",
    );
  });

  test("release enforces exact Z while pilot only requires exact support", () => {
    const analysis = qualityAnalysis({
      interaction: {
        balancedDecomposition: {
          supported: true,
          value: 0,
          commitmentBudget: 10,
          partitionsEvaluated: 1,
        },
      },
    });
    expect(codes(pilotBrainQualityViolations(candidate(1, analysis)))).not.toContain(
      "balanced-decomposition-below-minimum",
    );
    expect(codes(releaseBrainQualityViolations(candidate(1, analysis)))).toContain(
      "balanced-decomposition-below-minimum",
    );

    const unsupported = qualityAnalysis({
      interaction: {
        balancedDecomposition: { supported: false, reason: "product-state-budget" },
      },
    });
    expect(codes(pilotBrainQualityViolations(candidate(1, unsupported)))).toContain(
      "balanced-decomposition-unsupported",
    );
  });

  test("does not let duplicate labels fake the recurring-resource gate", () => {
    const analysis = qualityAnalysis({
      interaction: {
        recurringResourceLabels: ["object:cargo-a", "object:cargo-a"],
      },
    });
    const actual = codes(pilotBrainQualityViolations(candidate(4, analysis)));
    expect(actual).toContain("interaction-report-invalid");
    expect(actual).toContain("recurring-resources-below-minimum");
  });

  test("rejects fatal pressure, walking padding, straight pushes, and missing macro support", () => {
    const analysis = qualityAnalysis({
      features: { fatalChoicePressure: 0.1 },
      preferredPushes: 10,
      decision: {
        fatalChoiceStates: 1,
        pushRuns: 1,
        longestConsequenceFreeRun: 65,
        consequenceFreePermille: 1_000,
      },
      macro: null,
    });
    const actual = codes(pilotBrainQualityViolations(candidate(0, analysis)));
    expect(actual).toContain("fatal-pressure-excess");
    expect(actual).toContain("fatal-choice-in-orientation");
    expect(actual).toContain("walking-run-excess");
    expect(actual).toContain("straight-push-padding");
    expect(actual).toContain("macro-report-missing");
  });

  test("requires every serialized milestone and directly referenceable element to be mandatory", () => {
    const level = qualityLevel({ extraFixture: true, fracture: true });
    const onlyGate = qualitySpecs()[2]!;
    const analysis = qualityAnalysis({ mandatoryIds: ["evacuate"] });
    const actual = pilotBrainQualityViolations(candidate(
      0,
      analysis,
      level,
      [qualitySpecs()[0]!, onlyGate],
    ));
    const actualCodes = codes(actual);
    expect(actualCodes).toContain("milestone-not-mandatory");
    expect(actualCodes).toContain("object-without-mandatory-reference");
    expect(actualCodes).toContain("fixture-without-mandatory-reference");
    expect(actualCodes).toContain("fracture-without-mandatory-reference");
    expect(qualityRelevantFixtureIds(level)).toEqual(["door-a", "plate-a"]);
  });

  test("treats the bounded macro count only as a sound observed lower bound", () => {
    const tooMany = qualityAnalysis({
      macro: { retainedMaterialSolutions: 4 },
    });
    expect(codes(pilotBrainQualityViolations(candidate(8, tooMany)))).toContain(
      "macro-material-solution-excess",
    );
    const withinObservedBound = qualityAnalysis({
      macro: { retainedMaterialSolutions: 1, retainedSolutionCapReached: true },
    });
    expect(codes(pilotBrainQualityViolations(candidate(8, withinObservedBound)))).not.toContain(
      "macro-material-solution-excess",
    );
  });
});
