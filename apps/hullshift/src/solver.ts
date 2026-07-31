import {
  DIRECTION_ORDER,
  cellAt,
  indexCoord,
  type Coord,
  type Direction,
  type EngineSnapshot,
  type LevelDefinition,
  type TransitionResult,
} from "./model.ts";
import {
  createInitialSnapshot,
  resolveDirectionalAction,
  canonicalStateKey,
} from "./simulation.ts";
import {
  type DecisionStructureMetrics,
  type DifficultyFeatureVector,
  evaluateDifficulty,
  type DifficultyRating,
} from "./difficulty.ts";
import {
  RATED_MILESTONE_FAMILIES,
  compileMilestoneSpecs,
  validateMilestoneSpecs,
  type MilestoneGuard,
  type MilestoneSpec,
  type MilestoneStatePredicate,
  type MilestoneTrigger,
} from "./milestone_dsl.ts";

export const DEFAULT_ANALYSIS_LIMITS = Object.freeze({
  maxStates: 200_000,
  maxTransitions: 800_000,
  maxEstimatedBytes: 128 * 1024 * 1024,
  cooperateEvery: 512,
} as const);

export interface AnalysisLimits {
  readonly maxStates?: number;
  readonly maxTransitions?: number;
  readonly maxEstimatedBytes?: number;
  readonly cooperateEvery?: number;
}

export interface SolverProgress {
  readonly stage:
    | "analysis-enumeration"
    | "analysis-winning-set"
    | "analysis-optimal-solution"
    | "analysis-milestones"
    | "analysis-complete";
  readonly completed: number;
  readonly total: number;
  readonly detail?: string;
}

export interface SolverHooks {
  readonly onProgress?: (progress: SolverProgress) => void;
  readonly shouldCancel?: () => boolean;
  /** A scheduling yield only. It never participates in solver decisions. */
  readonly yieldControl?: () => Promise<void>;
}

export interface MilestoneContext {
  readonly level: LevelDefinition;
  readonly sourceStateKey: string;
  readonly targetStateKey: string | undefined;
  readonly action: Direction;
  readonly transition: TransitionResult;
}

export interface MilestoneDefinition {
  readonly id: string;
  readonly family: string;
  readonly test: (context: MilestoneContext) => boolean;
  /**
   * Compiled DSL definitions emit only on their Nth matching transition.
   * Omitted for the legacy stateless callback contract.
   */
  readonly occurrence?: number;
  /** Canonical trigger+guard identity supplied by milestone-dsl-v1. */
  readonly observationKey?: string;
  /** Reciprocal allow-list for deliberately simultaneous instances. */
  readonly coEmitsWith?: readonly string[];
}

export interface AnalyzeLevelOptions extends SolverHooks {
  readonly limits?: AnalysisLimits;
  /** Legacy executable callback API, retained for g1-g3 callers. */
  readonly milestones?: readonly MilestoneDefinition[];
  /** Strict data-only catalog API. Mutually exclusive with milestones. */
  readonly milestoneSpecs?: readonly MilestoneSpec[];
  readonly requestedDifficulty?: number;
  readonly mechanicFamilies?: number;
}

export type FatalFrontierKind = "physical" | "causal";

export interface FatalFrontierEntry {
  readonly stateKey: string;
  readonly action: Direction;
  readonly kind: FatalFrontierKind;
  readonly reason: "physical-hazard" | "no-evacuation-route";
}

export interface SolutionMetrics {
  readonly commitments: number;
  readonly pushes: number;
  readonly totalActions: number;
}

export interface RetainedSolution extends SolutionMetrics {
  readonly actions: readonly Direction[];
}

export interface MilestoneReport {
  readonly mandatoryIds: readonly string[];
  readonly precedence: readonly Readonly<{ before: string; after: string }>[];
  readonly dependencyDepth: number;
  readonly planningHorizon: number;
  readonly crossMechanicCoupling: number;
  /** g4 diagnostic: rated non-universal families in proven dependency edges. */
  readonly mandatoryFamilies?: readonly string[];
}

export interface MacroProjectionReport {
  readonly schemaVersion: "neutral-scc-v1";
  /** Raw states remain authoritative and remain in winningStateKeys. */
  readonly rawStateCount: number;
  /** SCCs connected only by reversible, consequence-free movement. */
  readonly macroStateCount: number;
  readonly winningMacroStateCount: number;
  readonly decisionTransitionCount: number;
  readonly preferredCommitments: number;
  /** Distinct commitment signatures among the bounded retained solutions. */
  readonly retainedMaterialSolutions: number;
  readonly retainedSolutionCap: 8;
  readonly retainedSolutionCapReached: boolean;
  /** False: only the bounded retained paths are deduplicated here. */
  readonly retainedMaterialSolutionCountExact: false;
}

export type ExactBalancedDecomposition =
  | Readonly<{
      supported: true;
      value: number;
      commitmentBudget: number;
      partitionsEvaluated: number;
    }>
  | Readonly<{
      supported: false;
      reason: "too-many-recurring-labels" | "product-state-budget" | "unsolved";
    }>;

export const COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION =
  "counterintuitive-commitments-v1" as const;

export type ExactCounterintuitiveCommitments =
  | Readonly<{
      readonly schemaVersion: typeof COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION;
      readonly supported: true;
      /** Exact minimum marked edges among bounded winning traces. */
      readonly value: number;
      readonly commitmentBudget: number;
      readonly productStatesEvaluated: number;
      /** Recurring labels for which v1 had a conservative mark model. */
      readonly modeledRecurringResourceLabels: readonly string[];
    }>
  | Readonly<{
      readonly schemaVersion: typeof COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION;
      readonly supported: false;
      readonly reason: "unsolved" | "product-state-budget";
    }>;

export interface InteractionMetrics {
  readonly schemaVersion: "interaction-metrics-v1";
  readonly preferredCommitmentLabels: readonly string[];
  readonly entityMechanicAlternations: number;
  readonly mechanicFamilyAlternations: number;
  readonly recurringResourceLabels: readonly string[];
  /** Preferred-trace scaffold; final catalog Z must minimize over winning traces. */
  readonly preferredBalancedDecompositionCost: number;
  /** Exact min-over-winning-traces Z when the bounded product fits certification limits. */
  readonly balancedDecomposition: ExactBalancedDecomposition;
  /** Exact bounded U under counterintuitive-commitments-v1's frozen relaxation. */
  readonly counterintuitiveCommitments: ExactCounterintuitiveCommitments;
}

export interface AnalysisReport {
  readonly solvable: boolean;
  readonly initialStateKey: string;
  readonly winningStateKeys: ReadonlySet<string>;
  readonly fatalFrontier: readonly FatalFrontierEntry[];
  readonly preferredSolution: RetainedSolution | null;
  /** Flat transport conveniences used by the resident mission summary. */
  readonly optimalActions: number | null;
  readonly optimalPushes: number | null;
  readonly retainedNearOptimalSolutions: readonly RetainedSolution[];
  readonly stateCount: number;
  readonly transitionCount: number;
  readonly physicalFailureTransitionCount: number;
  readonly victoryTransitionCount: number;
  readonly estimatedBytes: number;
  readonly limits: Readonly<Required<AnalysisLimits>>;
  readonly milestones: MilestoneReport;
  readonly features: DifficultyFeatureVector;
  readonly difficulty: DifficultyRating | null;
  /** Present only for g2+ analysis; omitted from frozen legacy g1 payloads. */
  readonly decisionStructure?: DecisionStructureMetrics;
  /** g4-only zero-cost neutral-region rating projection. Raw graph APIs are unchanged. */
  readonly macroProjection?: MacroProjectionReport;
  /** g4-only interaction scaffold used by the offline certifier. */
  readonly interaction?: InteractionMetrics;
}

export type AnalysisReportJSON = Omit<AnalysisReport, "winningStateKeys"> & {
  readonly winningStateKeys: readonly string[];
};

export class AnalysisLimitError extends Error {
  readonly limit: "states" | "transitions" | "memory";
  readonly maximum: number;

  constructor(limit: AnalysisLimitError["limit"], maximum: number) {
    super(`Hullshift analysis exceeded the exact ${limit} limit (${maximum})`);
    this.name = "AnalysisLimitError";
    this.limit = limit;
    this.maximum = maximum;
  }
}

export class AnalysisCancelledError extends Error {
  constructor() {
    super("Hullshift analysis was cancelled");
    this.name = "AnalysisCancelledError";
  }
}

export class InvalidMilestoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMilestoneError";
  }
}

interface GraphNode {
  readonly key: string;
  readonly snapshot: EngineSnapshot;
  readonly edges: GraphEdge[];
}

interface GraphEdge {
  readonly action: Direction;
  readonly actionRank: number;
  readonly pushed: boolean;
  readonly pushedObjectId: string | undefined;
  readonly pushedFrom: Coord | undefined;
  readonly pushedTo: Coord | undefined;
  readonly persistentConsequence: boolean | undefined;
  readonly meaningful: boolean;
  readonly target: number | undefined;
  readonly terminal: "physical-failure" | "victory" | undefined;
  readonly milestoneIds: readonly string[];
  readonly interactionLabels: readonly string[];
  /** Deterministic primary label retained for compact preferred-trace metrics. */
  readonly interactionLabel: string | undefined;
}

interface ResolvedLimits {
  readonly maxStates: number;
  readonly maxTransitions: number;
  readonly maxEstimatedBytes: number;
  readonly cooperateEvery: number;
}

interface PathCost {
  readonly commitments: number;
  readonly pushes: number;
  readonly totalActions: number;
  readonly sequence: string;
}

interface SearchResult {
  readonly preferred: RetainedSolution | null;
  readonly retained: readonly RetainedSolution[];
  readonly pathEdges: readonly GraphEdge[];
}

interface AnalyzedMilestones {
  readonly report: MilestoneReport;
  readonly interleaving: number;
  readonly preferredEmissions: readonly (readonly string[])[];
}

const EMPTY_MILESTONE_REPORT: MilestoneReport = Object.freeze({
  mandatoryIds: Object.freeze([]),
  precedence: Object.freeze([]),
  dependencyDepth: 0,
  planningHorizon: 0,
  crossMechanicCoupling: 0,
});

export async function analyzeLevel(
  level: LevelDefinition,
  options: AnalyzeLevelOptions = {},
): Promise<AnalysisReport> {
  const limits = resolveLimits(options.limits);
  if (options.milestones !== undefined && options.milestoneSpecs !== undefined) {
    throw new InvalidMilestoneError("Use milestoneSpecs or legacy milestones, not both");
  }
  const normalizedMilestoneSpecs = options.milestoneSpecs === undefined
    ? undefined
    : validateMilestoneSpecs(level, options.milestoneSpecs);
  const milestones = validateMilestones(
    normalizedMilestoneSpecs === undefined
      ? options.milestones ?? []
      : compileMilestoneSpecs(level, normalizedMilestoneSpecs),
  );
  const occurrenceAwareMilestones = milestones.some((milestone) => (
    milestone.occurrence !== undefined
  ));
  checkCancelled(options);

  const initial = createInitialSnapshot(level);
  if (initial.outcome.kind !== "playing") {
    throw new Error(`Hullshift analysis requires a non-terminal initial state (${initial.outcome.kind})`);
  }
  const initialStateKey = canonicalStateKey(initial.state);
  const nodes: GraphNode[] = [{ key: initialStateKey, snapshot: initial, edges: [] }];
  const nodeByKey = new Map<string, number>([[initialStateKey, 0]]);
  let transitionCount = 0;
  let physicalFailureTransitionCount = 0;
  let victoryTransitionCount = 0;
  let estimatedBytes = estimateNodeBytes(initialStateKey);

  options.onProgress?.({
    stage: "analysis-enumeration",
    completed: 0,
    total: limits.maxStates,
  });

  for (let queueIndex = 0; queueIndex < nodes.length; queueIndex += 1) {
    const source = nodes[queueIndex]!;
    const successorByIdentity = new Map<string, GraphEdge>();
    for (let actionRank = 0; actionRank < DIRECTION_ORDER.length; actionRank += 1) {
      const action = DIRECTION_ORDER[actionRank]!;
      const result = resolveDirectionalAction(level, source.snapshot, action);
      if (!result.accepted) continue;
      if (result.internalPasses > 32) {
        throw new Error("A transition exceeded the frozen 32-pass cascade bound");
      }

      const outcome = result.after.outcome.kind;
      let identity: string;
      let target: number | undefined;
      let terminal: GraphEdge["terminal"];
      let targetStateKey: string | undefined;
      if (outcome === "playing") {
        targetStateKey = canonicalStateKey(result.after.state);
        identity = `state:${targetStateKey}`;
        const known = nodeByKey.get(targetStateKey);
        if (known === undefined) {
          if (nodes.length >= limits.maxStates) {
            throw new AnalysisLimitError("states", limits.maxStates);
          }
          target = nodes.length;
          nodeByKey.set(targetStateKey, target);
          nodes.push({ key: targetStateKey, snapshot: result.after, edges: [] });
          estimatedBytes += estimateNodeBytes(targetStateKey);
        } else {
          target = known;
        }
      } else if (outcome === "victory") {
        identity = "terminal:victory";
        terminal = "victory";
      } else if (outcome === "physical-failure") {
        identity = `terminal:physical:${action}`;
        terminal = "physical-failure";
      } else {
        throw new Error("Raw solver expansion unexpectedly produced a causal-failure outcome");
      }

      const emitted = milestones
        .filter((milestone) => milestone.test({
          level,
          sourceStateKey: source.key,
          targetStateKey,
          action,
          transition: result,
        }))
        .map((milestone) => milestone.id);
      const pushEvent = usesModernAnalysis(level.generatorVersion)
        ? result.events.find((event) => event.type === "object-pushed")
        : undefined;
      const interactionLabels = level.generatorVersion === "g4"
        ? interactionLabelsForTransition(level, result)
        : Object.freeze([] as string[]);
      const edge: GraphEdge = {
        action,
        actionRank,
        pushed: result.pushed,
        pushedObjectId: pushEvent?.objectId,
        pushedFrom: pushEvent?.from,
        pushedTo: pushEvent?.to,
        persistentConsequence: usesModernAnalysis(level.generatorVersion)
          ? hasPersistentPreferredPathConsequence(result)
          : undefined,
        meaningful: isMeaningfulDecisionTransition(level, result),
        target,
        terminal,
        milestoneIds: Object.freeze(emitted),
        interactionLabels,
        interactionLabel: interactionLabels[0],
      };
      // Decision compression merges equivalent successors and retains the
      // first action in frozen N,E,S,W order. Milestone-observably distinct
      // transitions must remain distinct or occurrence proofs would be lossy.
      const edgeIdentity = emitted.length === 0
        || !occurrenceAwareMilestones
        ? identity
        : `${identity}|milestones:${[...emitted].sort().join(",")}`;
      if (!successorByIdentity.has(edgeIdentity)) successorByIdentity.set(edgeIdentity, edge);
    }

    source.edges.push(...successorByIdentity.values());
    transitionCount += source.edges.length;
    for (const edge of source.edges) {
      if (edge.terminal === "physical-failure") physicalFailureTransitionCount += 1;
      if (edge.terminal === "victory") victoryTransitionCount += 1;
      estimatedBytes += estimateEdgeBytes(edge);
    }
    if (transitionCount > limits.maxTransitions) {
      throw new AnalysisLimitError("transitions", limits.maxTransitions);
    }
    if (estimatedBytes > limits.maxEstimatedBytes) {
      throw new AnalysisLimitError("memory", limits.maxEstimatedBytes);
    }

    if ((queueIndex + 1) % limits.cooperateEvery === 0) {
      options.onProgress?.({
        stage: "analysis-enumeration",
        completed: queueIndex + 1,
        total: limits.maxStates,
        detail: `${nodes.length} states, ${transitionCount} transitions`,
      });
      await cooperate(options);
    }
  }

  options.onProgress?.({
    stage: "analysis-winning-set",
    completed: 0,
    total: nodes.length,
  });
  const reverse = buildReverseEdges(nodes);
  const winning = exactWinningSet(nodes, reverse);
  const winningStateKeys = new Set<string>();
  for (let index = 0; index < nodes.length; index += 1) {
    if (winning[index] === 1) winningStateKeys.add(nodes[index]!.key);
  }
  await cooperate(options);

  const fatalFrontier = buildFatalFrontier(nodes, winning);
  const components = stronglyConnectedComponents(nodes, reverse);
  await cooperate(options);
  options.onProgress?.({
    stage: "analysis-optimal-solution",
    completed: 0,
    total: nodes.length,
  });
  const search = preferredSolutions(nodes);
  await cooperate(options);

  let milestoneReport = EMPTY_MILESTONE_REPORT;
  let milestoneInterleaving = 0;
  let preferredMilestoneEmissions: readonly (readonly string[])[] = Object.freeze(
    search.pathEdges.map(() => Object.freeze([] as string[])),
  );
  if (milestones.length > 0 && search.preferred !== null) {
    options.onProgress?.({
      stage: "analysis-milestones",
      completed: 0,
      total: milestones.length,
    });
    const analyzedMilestones = await analyzeMilestones(
      nodes,
      winning,
      milestones,
      search.pathEdges,
      options,
    );
    milestoneReport = analyzedMilestones.report;
    milestoneInterleaving = analyzedMilestones.interleaving;
    preferredMilestoneEmissions = analyzedMilestones.preferredEmissions;
  }

  const macroProjection = level.generatorVersion === "g4"
    ? buildMacroProjection(nodes, winning, search)
    : undefined;

  const features = buildFeatureVector(
    level,
    nodes,
    winning,
    fatalFrontier,
    search.preferred,
    search.pathEdges,
    components,
    milestoneReport,
    usesModernAnalysis(level.generatorVersion) ? milestoneInterleaving : 0,
    options.mechanicFamilies,
    milestones,
    macroProjection,
  );
  const decisionStructure = usesModernAnalysis(level.generatorVersion)
    ? buildDecisionStructureMetrics(nodes, winning, search.pathEdges)
    : undefined;
  const difficulty = options.requestedDifficulty === undefined
    ? null
    : evaluateDifficulty(features, options.requestedDifficulty);
  const interaction = level.generatorVersion === "g4"
    ? buildInteractionMetrics(
        level,
        nodes,
        winning,
        search.preferred,
        search.pathEdges,
        preferredMilestoneEmissions,
        milestones,
        normalizedMilestoneSpecs ?? Object.freeze([]),
        milestoneReport,
      )
    : undefined;

  checkCancelled(options);
  options.onProgress?.({
    stage: "analysis-complete",
    completed: nodes.length,
    total: nodes.length,
    detail: `${winningStateKeys.size} winning states`,
  });
  return Object.freeze({
    solvable: winning[0] === 1,
    initialStateKey,
    winningStateKeys,
    fatalFrontier: Object.freeze(fatalFrontier),
    preferredSolution: search.preferred,
    optimalActions: search.preferred?.totalActions ?? null,
    optimalPushes: search.preferred?.pushes ?? null,
    retainedNearOptimalSolutions: search.retained,
    stateCount: nodes.length,
    transitionCount,
    physicalFailureTransitionCount,
    victoryTransitionCount,
    estimatedBytes,
    limits,
    milestones: milestoneReport,
    features,
    difficulty,
    ...(decisionStructure === undefined ? {} : { decisionStructure }),
    ...(macroProjection === undefined ? {} : { macroProjection }),
    ...(interaction === undefined ? {} : { interaction }),
  });
}

export function solverAnalysisToJSON(analysis: AnalysisReport): AnalysisReportJSON {
  return {
    ...analysis,
    winningStateKeys: Object.freeze([...analysis.winningStateKeys].sort()),
  };
}

export interface WitnessReplay {
  readonly finalSnapshot: EngineSnapshot;
  readonly acceptedActions: number;
  readonly pushes: number;
}

export function replayWitness(
  level: LevelDefinition,
  witness: readonly Direction[],
): WitnessReplay {
  let snapshot = createInitialSnapshot(level);
  let pushes = 0;
  for (let index = 0; index < witness.length; index += 1) {
    if (snapshot.outcome.kind !== "playing") {
      throw new Error(`Witness continued after terminal action ${index}`);
    }
    const result = resolveDirectionalAction(level, snapshot, witness[index]!);
    if (!result.accepted) {
      throw new Error(`Witness action ${index} (${witness[index]}) was blocked`);
    }
    snapshot = result.after;
    if (result.pushed) pushes += 1;
    if (snapshot.outcome.kind === "physical-failure" || snapshot.outcome.kind === "causal-failure") {
      throw new Error(`Witness action ${index} ended in ${snapshot.outcome.kind}`);
    }
    if (snapshot.outcome.kind === "victory" && index !== witness.length - 1) {
      throw new Error(`Witness reached victory before its final action at ${index}`);
    }
  }
  if (snapshot.outcome.kind !== "victory") {
    throw new Error("Witness did not end in victory");
  }
  return Object.freeze({ finalSnapshot: snapshot, acceptedActions: witness.length, pushes });
}

function resolveLimits(input: AnalysisLimits | undefined): Readonly<ResolvedLimits> {
  const resolved = {
    maxStates: input?.maxStates ?? DEFAULT_ANALYSIS_LIMITS.maxStates,
    maxTransitions: input?.maxTransitions ?? DEFAULT_ANALYSIS_LIMITS.maxTransitions,
    maxEstimatedBytes: input?.maxEstimatedBytes ?? DEFAULT_ANALYSIS_LIMITS.maxEstimatedBytes,
    cooperateEvery: input?.cooperateEvery ?? DEFAULT_ANALYSIS_LIMITS.cooperateEvery,
  };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Analysis limit ${key} must be a positive safe integer`);
    }
  }
  if (resolved.maxStates > DEFAULT_ANALYSIS_LIMITS.maxStates) {
    throw new RangeError("Analysis cannot exceed the g1 state cap");
  }
  if (resolved.maxTransitions > DEFAULT_ANALYSIS_LIMITS.maxTransitions) {
    throw new RangeError("Analysis cannot exceed the g1 transition cap");
  }
  return Object.freeze(resolved);
}

function validateMilestones(input: readonly MilestoneDefinition[]): readonly MilestoneDefinition[] {
  if (input.length > 16) throw new InvalidMilestoneError("Hullshift permits at most 16 milestones");
  const ids = new Set<string>();
  for (const milestone of input) {
    if (!/^[a-z][a-z0-9.-]{0,47}$/.test(milestone.id) || ids.has(milestone.id)) {
      throw new InvalidMilestoneError(`Invalid or duplicate milestone id: ${milestone.id}`);
    }
    if (!/^[a-z][a-z0-9.-]{0,31}$/.test(milestone.family)) {
      throw new InvalidMilestoneError(`Invalid milestone family: ${milestone.family}`);
    }
    if (typeof milestone.test !== "function") {
      throw new InvalidMilestoneError(`Milestone ${milestone.id} has no predicate`);
    }
    if (milestone.occurrence !== undefined) {
      if (!Number.isInteger(milestone.occurrence)
        || milestone.occurrence < 1
        || milestone.occurrence > 16) {
        throw new InvalidMilestoneError(`Milestone ${milestone.id} occurrence must be 1..16`);
      }
      if (typeof milestone.observationKey !== "string" || milestone.observationKey.length === 0) {
        throw new InvalidMilestoneError(`Milestone ${milestone.id} has no observation key`);
      }
    } else if (milestone.observationKey !== undefined || milestone.coEmitsWith !== undefined) {
      throw new InvalidMilestoneError(
        `Legacy milestone ${milestone.id} cannot declare DSL monitor fields`,
      );
    }
    ids.add(milestone.id);
  }
  for (const milestone of input) {
    for (const otherId of milestone.coEmitsWith ?? []) {
      const other = input.find((candidate) => candidate.id === otherId);
      if (other === undefined || !(other.coEmitsWith ?? []).includes(milestone.id)) {
        throw new InvalidMilestoneError(
          `Milestone ${milestone.id} has a non-reciprocal co-emission declaration`,
        );
      }
    }
  }
  return Object.freeze([...input]);
}

function estimateNodeBytes(key: string): number {
  return 384 + key.length * 2;
}

function estimateEdgeBytes(edge: GraphEdge): number {
  return 96
    + (edge.pushedObjectId?.length ?? 0) * 2
    + edge.interactionLabels.reduce((sum, label) => sum + label.length * 2, 0)
    + (edge.pushedFrom === undefined ? 0 : 32)
    + edge.milestoneIds.reduce((sum, id) => sum + id.length * 2, 0);
}

function hasPersistentPreferredPathConsequence(result: TransitionResult): boolean {
  if (result.pushed || result.after.outcome.kind !== "playing") return true;
  return result.events.some((event) => (
    event.type === "relay-toggled"
    || event.type === "socket-docked"
    || event.type === "fracture-collapsed"
    || event.type === "object-removed"
    || event.type === "source-changed"
    || event.type === "channel-changed"
    || event.type === "consumer-changed"
    || event.type === "gate-entered"
  ));
}

/** A stable recurring-resource label, excluding universal gate entry. */
function interactionLabelsForTransition(
  level: LevelDefinition,
  result: TransitionResult,
): readonly string[] {
  const labels: string[] = [];
  const add = (label: string): void => {
    if (!labels.includes(label)) labels.push(label);
  };
  const push = result.events.find((event) => event.type === "object-pushed");
  if (push?.type === "object-pushed") add(`object:${push.objectId}`);
  const relay = result.events.find((event) => event.type === "relay-toggled");
  if (relay?.type === "relay-toggled") add(`fixture:${relay.fixtureId}`);
  const dock = result.events.find((event) => event.type === "socket-docked");
  if (dock?.type === "socket-docked") {
    add(`object:${dock.objectId}`);
    add(`fixture:${dock.fixtureId}`);
  }
  const removal = result.events.find((event) => event.type === "object-removed");
  if (removal?.type === "object-removed") {
    add(`object:${removal.objectId}`);
    if (removal.fixtureId !== undefined) add(`fixture:${removal.fixtureId}`);
  }
  const fracture = result.events.find((event) => event.type === "fracture-collapsed");
  if (fracture?.type === "fracture-collapsed") {
    add(`fracture:${fracture.position.x},${fracture.position.y}`);
  }
  for (const source of result.events.filter((event) => event.type === "source-changed")) {
    add(`fixture:${source.fixtureId}`);
  }
  for (const consumer of result.events.filter((event) => event.type === "consumer-changed")) {
    if (consumer.consumerKind !== "gate") add(`fixture:${consumer.fixtureId}`);
  }

  const from = result.before.state.player;
  const to = result.after.state.player;
  if (labels.length === 0 && from !== null && to !== null) {
    const fixture = cellAt(level, to)?.fixture ?? cellAt(level, from)?.fixture;
    if (fixture !== undefined && fixture.kind !== "gate") add(`fixture:${fixture.id}`);
  }
  return Object.freeze(labels);
}

/** Shared decision-edge classifier for solver costs and resident run metrics. */
/**
 * Generator versions measured with the modern decision-structure pipeline.
 * Frozen g1 analysis payloads intentionally omit these fields.
 */
const MODERN_ANALYSIS_VERSIONS: ReadonlySet<string> = new Set(["g2", "g3", "g4"]);

export function usesModernAnalysis(generatorVersion: string): boolean {
  return MODERN_ANALYSIS_VERSIONS.has(generatorVersion);
}

export function isMeaningfulDecisionTransition(
  level: LevelDefinition,
  result: TransitionResult,
): boolean {
  if (result.pushed || result.after.outcome.kind !== "playing") return true;
  if (result.events.some((event) => (
    event.type === "relay-toggled"
    || event.type === "socket-docked"
    || event.type === "fracture-collapsed"
    || event.type === "object-removed"
    || event.type === "source-changed"
    || event.type === "channel-changed"
    || event.type === "consumer-changed"
    || event.type === "gate-entered"
  ))) return true;
  const from = result.before.state.player;
  const to = result.after.state.player;
  if (from === null || to === null) return true;
  const fromCell = cellAt(level, from);
  const toCell = cellAt(level, to);
  return (
    fromCell?.fixture !== undefined
    || toCell?.fixture !== undefined
    || fromCell?.terrain === "fracture"
    || toCell?.terrain === "fracture"
  );
}

function buildReverseEdges(nodes: readonly GraphNode[]): number[][] {
  const reverse = Array.from({ length: nodes.length }, () => [] as number[]);
  for (let source = 0; source < nodes.length; source += 1) {
    for (const edge of nodes[source]!.edges) {
      if (edge.target !== undefined) reverse[edge.target]!.push(source);
    }
  }
  return reverse;
}

function exactWinningSet(nodes: readonly GraphNode[], reverse: readonly number[][]): Uint8Array {
  const winning = new Uint8Array(nodes.length);
  const queue: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index]!.edges.some((edge) => edge.terminal === "victory")) {
      winning[index] = 1;
      queue.push(index);
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const target = queue[cursor]!;
    for (const source of reverse[target]!) {
      if (winning[source] === 1) continue;
      winning[source] = 1;
      queue.push(source);
    }
  }
  return winning;
}

function buildFatalFrontier(
  nodes: readonly GraphNode[],
  winning: Uint8Array,
): FatalFrontierEntry[] {
  const frontier: FatalFrontierEntry[] = [];
  for (let source = 0; source < nodes.length; source += 1) {
    if (winning[source] !== 1) continue;
    for (const edge of nodes[source]!.edges) {
      if (edge.terminal === "physical-failure") {
        frontier.push(Object.freeze({
          stateKey: nodes[source]!.key,
          action: edge.action,
          kind: "physical",
          reason: "physical-hazard",
        }));
      } else if (edge.target !== undefined && winning[edge.target] !== 1) {
        frontier.push(Object.freeze({
          stateKey: nodes[source]!.key,
          action: edge.action,
          kind: "causal",
          reason: "no-evacuation-route",
        }));
      }
    }
  }
  return frontier;
}

function stronglyConnectedComponents(
  nodes: readonly GraphNode[],
  reverse: readonly number[][],
): Int32Array {
  const visited = new Uint8Array(nodes.length);
  const finishOrder: number[] = [];
  for (let root = 0; root < nodes.length; root += 1) {
    if (visited[root] === 1) continue;
    visited[root] = 1;
    const stack: { node: number; next: number }[] = [{ node: root, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = nodes[frame.node]!.edges;
      let advanced = false;
      while (frame.next < edges.length) {
        const target = edges[frame.next++]!.target;
        if (target === undefined || visited[target] === 1) continue;
        visited[target] = 1;
        stack.push({ node: target, next: 0 });
        advanced = true;
        break;
      }
      if (!advanced) {
        finishOrder.push(frame.node);
        stack.pop();
      }
    }
  }

  const component = new Int32Array(nodes.length);
  component.fill(-1);
  let nextComponent = 0;
  for (let orderIndex = finishOrder.length - 1; orderIndex >= 0; orderIndex -= 1) {
    const root = finishOrder[orderIndex]!;
    if (component[root] !== -1) continue;
    component[root] = nextComponent;
    const stack = [root];
    while (stack.length > 0) {
      const target = stack.pop()!;
      for (const source of reverse[target]!) {
        if (component[source] !== -1) continue;
        component[source] = nextComponent;
        stack.push(source);
      }
    }
    nextComponent += 1;
  }
  return component;
}

function compareCost(a: PathCost, b: PathCost): number {
  return (
    a.commitments - b.commitments
    || a.pushes - b.pushes
    || a.totalActions - b.totalActions
    || (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0)
  );
}

function addEdgeCost(cost: PathCost, edge: GraphEdge): PathCost {
  return {
    commitments: cost.commitments + (edge.meaningful ? 1 : 0),
    pushes: cost.pushes + (edge.pushed ? 1 : 0),
    totalActions: cost.totalActions + 1,
    sequence: cost.sequence + String(edge.actionRank),
  };
}

interface HeapEntry {
  readonly node: number;
  readonly cost: PathCost;
}

function preferredSolutions(nodes: readonly GraphNode[]): SearchResult {
  const best: (PathCost | undefined)[] = Array(nodes.length);
  const previous: ({ source: number; edge: GraphEdge } | undefined)[] = Array(nodes.length);
  const start: PathCost = { commitments: 0, pushes: 0, totalActions: 0, sequence: "" };
  best[0] = start;
  const heap = new MinHeap<HeapEntry>((a, b) => compareCost(a.cost, b.cost) || a.node - b.node);
  heap.push({ node: 0, cost: start });
  let bestVictory: { source: number; edge: GraphEdge; cost: PathCost } | undefined;

  while (heap.size > 0) {
    const current = heap.pop()!;
    if (best[current.node] !== current.cost) continue;
    if (bestVictory !== undefined && compareCost(current.cost, bestVictory.cost) > 0) continue;
    for (const edge of nodes[current.node]!.edges) {
      const cost = addEdgeCost(current.cost, edge);
      if (edge.terminal === "victory") {
        if (bestVictory === undefined || compareCost(cost, bestVictory.cost) < 0) {
          bestVictory = { source: current.node, edge, cost };
        }
        continue;
      }
      if (edge.target === undefined) continue;
      const known = best[edge.target];
      if (known === undefined || compareCost(cost, known) < 0) {
        best[edge.target] = cost;
        previous[edge.target] = { source: current.node, edge };
        heap.push({ node: edge.target, cost });
      }
    }
  }

  if (bestVictory === undefined) {
    return Object.freeze({ preferred: null, retained: Object.freeze([]), pathEdges: Object.freeze([]) });
  }
  const pathEdges: GraphEdge[] = [bestVictory.edge];
  let cursor = bestVictory.source;
  while (cursor !== 0) {
    const step = previous[cursor];
    if (step === undefined) throw new Error("Optimal path predecessor chain is incomplete");
    pathEdges.push(step.edge);
    cursor = step.source;
  }
  pathEdges.reverse();
  const preferred = solutionFromEdges(pathEdges);

  const retainedBySequence = new Map<string, RetainedSolution>();
  retainedBySequence.set(bestVictory.cost.sequence, preferred);
  for (let source = 0; source < nodes.length; source += 1) {
    const sourceCost = best[source];
    if (sourceCost === undefined) continue;
    for (const edge of nodes[source]!.edges) {
      if (edge.terminal !== "victory") continue;
      const cost = addEdgeCost(sourceCost, edge);
      if (cost.commitments > preferred.commitments + 2) continue;
      const actions = reconstructActions(source, previous);
      actions.push(edge.action);
      retainedBySequence.set(cost.sequence, Object.freeze({
        actions: Object.freeze(actions),
        commitments: cost.commitments,
        pushes: cost.pushes,
        totalActions: cost.totalActions,
      }));
    }
  }
  const retained = [...retainedBySequence.values()]
    .sort((a, b) => compareRetainedSolutions(a, b))
    .slice(0, 8);
  return Object.freeze({ preferred, retained: Object.freeze(retained), pathEdges: Object.freeze(pathEdges) });
}

function solutionFromEdges(edges: readonly GraphEdge[]): RetainedSolution {
  return Object.freeze({
    actions: Object.freeze(edges.map((edge) => edge.action)),
    commitments: edges.reduce((sum, edge) => sum + (edge.meaningful ? 1 : 0), 0),
    pushes: edges.reduce((sum, edge) => sum + (edge.pushed ? 1 : 0), 0),
    totalActions: edges.length,
  });
}

function reconstructActions(
  target: number,
  previous: readonly ({ source: number; edge: GraphEdge } | undefined)[],
): Direction[] {
  const actions: Direction[] = [];
  let cursor = target;
  while (cursor !== 0) {
    const step = previous[cursor];
    if (step === undefined) throw new Error("Path predecessor chain is incomplete");
    actions.push(step.edge.action);
    cursor = step.source;
  }
  actions.reverse();
  return actions;
}

function compareRetainedSolutions(a: RetainedSolution, b: RetainedSolution): number {
  return (
    a.commitments - b.commitments
    || a.pushes - b.pushes
    || a.totalActions - b.totalActions
    || compareActionArrays(a.actions, b.actions)
  );
}

function compareActionArrays(a: readonly Direction[], b: readonly Direction[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = DIRECTION_ORDER.indexOf(a[index]!) - DIRECTION_ORDER.indexOf(b[index]!);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

async function analyzeMilestones(
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  definitions: readonly MilestoneDefinition[],
  preferredPath: readonly GraphEdge[],
  options: SolverHooks,
): Promise<AnalyzedMilestones> {
  for (const definition of definitions) {
    if (definition.occurrence !== undefined && !hasReachableMilestoneEmission(nodes, definition)) {
      throw new InvalidMilestoneError(
        `Milestone ${definition.id} occurrence ${definition.occurrence} is not reachable`,
      );
    }
  }
  rejectUndeclaredCoEmission(nodes, definitions);

  const mandatory = definitions.filter((milestone) => (
    !canReachVictoryWithoutMilestone(nodes, milestone)
  ));
  const precedence: { before: string; after: string }[] = [];
  for (let beforeIndex = 0; beforeIndex < mandatory.length; beforeIndex += 1) {
    checkCancelled(options);
    for (let afterIndex = 0; afterIndex < mandatory.length; afterIndex += 1) {
      if (beforeIndex === afterIndex) continue;
      const before = mandatory[beforeIndex]!;
      const after = mandatory[afterIndex]!;
      if (!hasWinningPrecedenceViolation(nodes, winning, before, after)) {
        precedence.push({ before: before.id, after: after.id });
      }
    }
    options.onProgress?.({
      stage: "analysis-milestones",
      completed: beforeIndex + 1,
      total: mandatory.length,
    });
    await cooperate(options);
  }

  const dependencyDepth = longestPrecedenceChain(mandatory, precedence);
  const preferredEmissions = milestoneEmissionsAlongPath(definitions, preferredPath);
  const preferredPositions = new Map<string, number>();
  for (let edgeIndex = 0; edgeIndex < preferredPath.length; edgeIndex += 1) {
    for (const id of preferredEmissions[edgeIndex]!) {
      if (!preferredPositions.has(id)) preferredPositions.set(id, edgeIndex);
    }
  }
  const reduced = transitiveReduction(precedence);
  let planningHorizon = 0;
  let crossMechanicCoupling = 0;
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const relation of reduced) {
    const beforePosition = preferredPositions.get(relation.before);
    const afterPosition = preferredPositions.get(relation.after);
    if (beforePosition !== undefined && afterPosition !== undefined) {
      let interveningCommitments = 0;
      for (let edgeIndex = beforePosition + 1; edgeIndex < afterPosition; edgeIndex += 1) {
        if (preferredPath[edgeIndex]!.meaningful) interveningCommitments += 1;
      }
      planningHorizon = Math.max(planningHorizon, interveningCommitments);
    }
    if (byId.get(relation.before)?.family !== byId.get(relation.after)?.family) {
      crossMechanicCoupling += 1;
    }
  }
  const dependencyIds = new Set(precedence.flatMap((relation) => [relation.before, relation.after]));
  const mandatoryFamilies = [...new Set(mandatory
    .filter((definition) => (
      definition.occurrence !== undefined
      && dependencyIds.has(definition.id)
      && (RATED_MILESTONE_FAMILIES as ReadonlySet<string>).has(definition.family)
    ))
    .map((definition) => definition.family))]
    .sort();
  const occurrenceAware = definitions.some((definition) => definition.occurrence !== undefined);
  return Object.freeze({
    report: Object.freeze({
      mandatoryIds: Object.freeze(mandatory.map((milestone) => milestone.id)),
      precedence: Object.freeze(precedence.map((relation) => Object.freeze(relation))),
      dependencyDepth,
      planningHorizon,
      crossMechanicCoupling,
      ...(occurrenceAware ? { mandatoryFamilies: Object.freeze(mandatoryFamilies) } : {}),
    }),
    interleaving: milestoneInterleaving(mandatory, precedence, preferredEmissions),
    preferredEmissions,
  });
}

/**
 * The exact precedence graph exposes how many mandatory obligations can be
 * pursued in more than one order. A total chain has a one-item frontier and
 * therefore I=0; three simultaneously available mandatory milestones yield
 * I=2. The V1 feature domain remains capped at three.
 */
function milestoneInterleaving(
  mandatory: readonly MilestoneDefinition[],
  precedence: readonly { before: string; after: string }[],
  preferredEmissions: readonly (readonly string[])[],
): number {
  const representative = new Map(mandatory.map((definition) => [definition.id, definition.id]));
  for (const definition of mandatory) {
    for (const otherId of definition.coEmitsWith ?? []) {
      if (!representative.has(otherId)) continue;
      const first = representative.get(definition.id)!;
      const second = representative.get(otherId)!;
      const chosen = first < second ? first : second;
      const replaced = first < second ? second : first;
      for (const [id, value] of representative) {
        if (value === replaced) representative.set(id, chosen);
      }
    }
  }
  const ids = [...new Set(mandatory.map((milestone) => representative.get(milestone.id)!))];
  const mappedPrecedence = [...new Map(precedence
    .map((relation) => ({
      before: representative.get(relation.before)!,
      after: representative.get(relation.after)!,
    }))
    .filter((relation) => relation.before !== relation.after)
    .map((relation) => [`${relation.before}\0${relation.after}`, relation])).values()];
  return measureMilestoneInterleaving(
    ids,
    mappedPrecedence,
    preferredEmissions.map((emissions) => (
      [...new Set(emissions.map((id) => representative.get(id) ?? id))]
    )),
  );
}

export function measureMilestoneInterleaving(
  mandatoryIdsInput: readonly string[],
  precedence: readonly { before: string; after: string }[],
  preferredEmissions: readonly (readonly string[])[],
): number {
  if (mandatoryIdsInput.length === 0) return 0;
  const mandatoryIds = new Set(mandatoryIdsInput);
  const predecessors = new Map(mandatoryIdsInput.map((id) => [id, new Set<string>()]));
  for (const relation of precedence) predecessors.get(relation.after)?.add(relation.before);
  const seen = new Set<string>();
  let maximumFrontier = 0;
  const sampleFrontier = (): void => {
    let available = 0;
    for (const id of mandatoryIdsInput) {
      if (seen.has(id)) continue;
      if ([...(predecessors.get(id) ?? [])].every((predecessor) => seen.has(predecessor))) {
        available += 1;
      }
    }
    maximumFrontier = Math.max(maximumFrontier, available);
  };
  sampleFrontier();
  for (const emissions of preferredEmissions) {
    for (const id of emissions) {
      if (mandatoryIds.has(id)) seen.add(id);
    }
    sampleFrontier();
  }
  return Math.min(3, Math.max(0, maximumFrontier - 1));
}

function canReachVictoryWithoutMilestone(
  nodes: readonly GraphNode[],
  definition: MilestoneDefinition,
): boolean {
  const occurrence = definition.occurrence ?? 1;
  // The forbidden occurrence itself is never enqueued, so counts are 0..N-1.
  const visited = new Uint8Array(nodes.length * occurrence);
  const queue: number[] = [0];
  visited[0] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const identity = queue[cursor]!;
    const node = Math.floor(identity / occurrence);
    const count = identity % occurrence;
    for (const edge of nodes[node]!.edges) {
      const matches = edge.milestoneIds.includes(definition.id);
      const nextCount = matches ? count + 1 : count;
      if (nextCount >= occurrence) continue;
      if (edge.terminal === "victory") return true;
      if (edge.target === undefined) continue;
      const nextIdentity = edge.target * occurrence + nextCount;
      if (visited[nextIdentity] === 1) continue;
      visited[nextIdentity] = 1;
      queue.push(nextIdentity);
    }
  }
  return false;
}

/** True when some winning trace emits `after` before `before`. */
function hasWinningPrecedenceViolation(
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  before: MilestoneDefinition,
  after: MilestoneDefinition,
): boolean {
  const beforeOccurrence = before.occurrence ?? 1;
  const afterOccurrence = after.occurrence ?? 1;
  if (
    before.observationKey !== undefined
    && before.observationKey === after.observationKey
  ) {
    // Identical match streams have an order determined solely by occurrence.
    return afterOccurrence <= beforeOccurrence;
  }
  const stride = beforeOccurrence * afterOccurrence;
  const visited = new Uint8Array(nodes.length * stride);
  const queue: number[] = [0];
  visited[0] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const identity = queue[cursor]!;
    const node = Math.floor(identity / stride);
    const history = identity % stride;
    const beforeCount = Math.floor(history / afterOccurrence);
    const afterCount = history % afterOccurrence;
    for (const edge of nodes[node]!.edges) {
      const beforeMatches = edge.milestoneIds.includes(before.id);
      const afterMatches = edge.milestoneIds.includes(after.id);
      const emitsBefore = beforeMatches && beforeCount + 1 >= beforeOccurrence;
      const emitsAfter = afterMatches && afterCount + 1 >= afterOccurrence;
      // Co-emission is not strict precedence: `after` was not previously
      // preceded by `before` on this trace.
      if (emitsAfter && (edge.terminal === "victory"
        || (edge.target !== undefined && winning[edge.target] === 1))) {
        return true;
      }
      // Once before emits, this trace can no longer witness an order violation.
      if (emitsBefore || edge.terminal !== undefined || edge.target === undefined) continue;
      const nextBeforeCount = beforeMatches ? beforeCount + 1 : beforeCount;
      const nextAfterCount = afterMatches ? afterCount + 1 : afterCount;
      if (nextBeforeCount >= beforeOccurrence || nextAfterCount >= afterOccurrence) continue;
      const nextHistory = nextBeforeCount * afterOccurrence + nextAfterCount;
      const nextIdentity = edge.target * stride + nextHistory;
      if (visited[nextIdentity] === 1) continue;
      visited[nextIdentity] = 1;
      queue.push(nextIdentity);
    }
  }
  return false;
}

function hasReachableMilestoneEmission(
  nodes: readonly GraphNode[],
  definition: MilestoneDefinition,
): boolean {
  const occurrence = definition.occurrence ?? 1;
  const visited = new Uint8Array(nodes.length * occurrence);
  const queue: number[] = [0];
  visited[0] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const identity = queue[cursor]!;
    const node = Math.floor(identity / occurrence);
    const count = identity % occurrence;
    for (const edge of nodes[node]!.edges) {
      const matches = edge.milestoneIds.includes(definition.id);
      if (matches && count + 1 >= occurrence) return true;
      if (edge.target === undefined) continue;
      const nextCount = matches ? count + 1 : count;
      const nextIdentity = edge.target * occurrence + nextCount;
      if (visited[nextIdentity] === 1) continue;
      visited[nextIdentity] = 1;
      queue.push(nextIdentity);
    }
  }
  return false;
}

function rejectUndeclaredCoEmission(
  nodes: readonly GraphNode[],
  definitions: readonly MilestoneDefinition[],
): void {
  const strict = definitions.filter((definition) => definition.occurrence !== undefined);
  for (let left = 0; left < strict.length; left += 1) {
    for (let right = left + 1; right < strict.length; right += 1) {
      const a = strict[left]!;
      const b = strict[right]!;
      if ((a.coEmitsWith ?? []).includes(b.id)) continue;
      if (hasReachableCoEmission(nodes, a, b)) {
        throw new InvalidMilestoneError(
          `Milestones ${a.id} and ${b.id} can co-emit without reciprocal coEmitsWith`,
        );
      }
    }
  }
}

function hasReachableCoEmission(
  nodes: readonly GraphNode[],
  a: MilestoneDefinition,
  b: MilestoneDefinition,
): boolean {
  if (!nodes.some((node) => node.edges.some((edge) => (
    edge.milestoneIds.includes(a.id) && edge.milestoneIds.includes(b.id)
  )))) return false;
  const aOccurrence = a.occurrence ?? 1;
  const bOccurrence = b.occurrence ?? 1;
  if (a.observationKey !== undefined && a.observationKey === b.observationKey) {
    return aOccurrence === bOccurrence && hasReachableMilestoneEmission(nodes, a);
  }
  const stride = aOccurrence * bOccurrence;
  const visited = new Uint8Array(nodes.length * stride);
  const queue: number[] = [0];
  visited[0] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const identity = queue[cursor]!;
    const node = Math.floor(identity / stride);
    const history = identity % stride;
    const aCount = Math.floor(history / bOccurrence);
    const bCount = history % bOccurrence;
    for (const edge of nodes[node]!.edges) {
      const aMatches = edge.milestoneIds.includes(a.id);
      const bMatches = edge.milestoneIds.includes(b.id);
      const emitsA = aMatches && aCount + 1 >= aOccurrence;
      const emitsB = bMatches && bCount + 1 >= bOccurrence;
      if (emitsA && emitsB) return true;
      // An instance emits once. If only one emits now, this path can never
      // produce a later simultaneous emission of the same pair.
      if (emitsA || emitsB || edge.target === undefined) continue;
      const nextACount = aMatches ? aCount + 1 : aCount;
      const nextBCount = bMatches ? bCount + 1 : bCount;
      const nextHistory = nextACount * bOccurrence + nextBCount;
      const nextIdentity = edge.target * stride + nextHistory;
      if (visited[nextIdentity] === 1) continue;
      visited[nextIdentity] = 1;
      queue.push(nextIdentity);
    }
  }
  return false;
}

function milestoneEmissionsAlongPath(
  definitions: readonly MilestoneDefinition[],
  path: readonly GraphEdge[],
): readonly (readonly string[])[] {
  const counts = new Map<string, number>();
  return Object.freeze(path.map((edge) => {
    const emitted: string[] = [];
    for (const definition of definitions) {
      if (!edge.milestoneIds.includes(definition.id)) continue;
      if (definition.occurrence === undefined) {
        emitted.push(definition.id);
        continue;
      }
      const count = counts.get(definition.id) ?? 0;
      const next = Math.min(definition.occurrence, count + 1);
      counts.set(definition.id, next);
      if (count < definition.occurrence && next === definition.occurrence) {
        emitted.push(definition.id);
      }
    }
    return Object.freeze(emitted);
  }));
}

function longestPrecedenceChain(
  mandatory: readonly MilestoneDefinition[],
  precedence: readonly { before: string; after: string }[],
): number {
  if (mandatory.length === 0) return 0;
  const indexById = new Map(mandatory.map((milestone, index) => [milestone.id, index]));
  const outgoing = Array.from({ length: mandatory.length }, () => [] as number[]);
  const indegree = new Uint16Array(mandatory.length);
  for (const relation of precedence) {
    const before = indexById.get(relation.before)!;
    const after = indexById.get(relation.after)!;
    outgoing[before]!.push(after);
    indegree[after] = indegree[after]! + 1;
  }
  const queue: number[] = [];
  const depth = new Uint16Array(mandatory.length);
  depth.fill(1);
  for (let index = 0; index < mandatory.length; index += 1) {
    if (indegree[index] === 0) queue.push(index);
  }
  let visited = 0;
  let longest = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor]!;
    visited += 1;
    for (const target of outgoing[source]!) {
      depth[target] = Math.max(depth[target]!, depth[source]! + 1);
      longest = Math.max(longest, depth[target]!);
      indegree[target] = indegree[target]! - 1;
      if (indegree[target] === 0) queue.push(target);
    }
  }
  if (visited !== mandatory.length) {
    throw new InvalidMilestoneError("Proven milestone precedence relation contains a cycle");
  }
  return longest;
}

function transitiveReduction(
  precedence: readonly { before: string; after: string }[],
): readonly { before: string; after: string }[] {
  const pairs = new Set(precedence.map((relation) => `${relation.before}\0${relation.after}`));
  return precedence.filter((relation) => !precedence.some((middle) => (
    middle.before === relation.before
    && middle.after !== relation.after
    && pairs.has(`${middle.after}\0${relation.after}`)
  )));
}

/**
 * Exact zero-cost projection used only for g4 rating diagnostics. It contracts
 * SCCs of non-meaningful transitions; it never replaces raw graph nodes or raw
 * winningStateKeys, so hints and resident failure classification stay intact.
 */
function buildMacroProjection(
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  search: SearchResult,
): MacroProjectionReport {
  const component = neutralComponents(nodes);
  let macroStateCount = 0;
  for (const value of component) macroStateCount = Math.max(macroStateCount, value + 1);
  const winningComponents = new Set<number>();
  for (let index = 0; index < nodes.length; index += 1) {
    if (winning[index] === 1) winningComponents.add(component[index]!);
  }
  const decisionTransitions = new Set<string>();
  for (let source = 0; source < nodes.length; source += 1) {
    for (const edge of nodes[source]!.edges) {
      const sourceComponent = component[source]!;
      const targetComponent = edge.target === undefined ? undefined : component[edge.target]!;
      if (!edge.meaningful && targetComponent === sourceComponent) continue;
      decisionTransitions.add([
        sourceComponent,
        edge.terminal ?? targetComponent,
        edge.interactionLabels.length > 0 ? edge.interactionLabels.join("+") : edge.action,
      ].join("|"));
    }
  }
  const materialSignatures = new Set<string>();
  for (const solution of search.retained) {
    const edges = edgesForActions(nodes, solution.actions);
    materialSignatures.add(edges
      .filter((edge) => edge.meaningful)
      .map((edge) => (edge.interactionLabels.length > 0 ? edge.interactionLabels.join("+") : undefined)
        ?? (edge.milestoneIds.length > 0
          ? `milestone:${[...edge.milestoneIds].sort().join("+")}`
          : `action:${edge.action}`))
      .join("\0"));
  }
  return Object.freeze({
    schemaVersion: "neutral-scc-v1",
    rawStateCount: nodes.length,
    macroStateCount,
    winningMacroStateCount: winningComponents.size,
    decisionTransitionCount: decisionTransitions.size,
    preferredCommitments: search.preferred?.commitments ?? 0,
    retainedMaterialSolutions: materialSignatures.size,
    retainedSolutionCap: 8,
    retainedSolutionCapReached: search.retained.length >= 8,
    retainedMaterialSolutionCountExact: false,
  });
}

function neutralComponents(nodes: readonly GraphNode[]): Int32Array {
  const forward = nodes.map((node) => node.edges
    .filter((edge) => !edge.meaningful && edge.target !== undefined)
    .map((edge) => edge.target!));
  const reverse = Array.from({ length: nodes.length }, () => [] as number[]);
  for (let source = 0; source < forward.length; source += 1) {
    for (const target of forward[source]!) reverse[target]!.push(source);
  }
  const visited = new Uint8Array(nodes.length);
  const finish: number[] = [];
  for (let root = 0; root < nodes.length; root += 1) {
    if (visited[root] === 1) continue;
    visited[root] = 1;
    const stack: { node: number; next: number }[] = [{ node: root, next: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const targets = forward[frame.node]!;
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        if (visited[target] === 0) {
          visited[target] = 1;
          stack.push({ node: target, next: 0 });
        }
      } else {
        finish.push(frame.node);
        stack.pop();
      }
    }
  }
  const component = new Int32Array(nodes.length);
  component.fill(-1);
  let nextComponent = 0;
  for (let index = finish.length - 1; index >= 0; index -= 1) {
    const root = finish[index]!;
    if (component[root] !== -1) continue;
    component[root] = nextComponent;
    const stack = [root];
    while (stack.length > 0) {
      const target = stack.pop()!;
      for (const source of reverse[target]!) {
        if (component[source] !== -1) continue;
        component[source] = nextComponent;
        stack.push(source);
      }
    }
    nextComponent += 1;
  }
  return component;
}

function edgesForActions(
  nodes: readonly GraphNode[],
  actions: readonly Direction[],
): readonly GraphEdge[] {
  const edges: GraphEdge[] = [];
  let node = 0;
  for (const action of actions) {
    const edge = nodes[node]!.edges.find((candidate) => candidate.action === action);
    if (edge === undefined) break;
    edges.push(edge);
    if (edge.target === undefined) break;
    node = edge.target;
  }
  return edges;
}

function buildInteractionMetrics(
  level: LevelDefinition,
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  preferred: RetainedSolution | null,
  preferredEdges: readonly GraphEdge[],
  preferredEmissions: readonly (readonly string[])[],
  definitions: readonly MilestoneDefinition[],
  specs: readonly MilestoneSpec[],
  milestoneReport: MilestoneReport,
): InteractionMetrics {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const labels: string[] = [];
  const families: string[] = [];
  for (let index = 0; index < preferredEdges.length; index += 1) {
    const edge = preferredEdges[index]!;
    if (!edge.meaningful) continue;
    const emissions = preferredEmissions[index] ?? [];
    const family = emissions
      .map((id) => byId.get(id)?.family)
      .find((candidate): candidate is string => candidate !== undefined);
    labels.push(edge.interactionLabel
      ?? (emissions[0] === undefined ? `decision:${edge.action}` : `milestone:${emissions[0]}`));
    families.push(family ?? inferredFamily(edge));
  }
  const candidates = [...new Set(nodes.flatMap((node) => node.edges
    .filter((edge) => edge.meaningful)
    .flatMap((edge) => edge.interactionLabels.filter(isResourceLabel))))].sort();
  const recurring = candidates.filter((label) => requiredRecurringResource(nodes, label));
  const balancedDecomposition = exactBalancedDecomposition(
    nodes,
    winning,
    preferred,
    recurring,
  );
  const counterintuitiveCommitments = exactCounterintuitiveCommitments(
    level,
    nodes,
    winning,
    preferred,
    recurring,
    definitions,
    specs,
    milestoneReport,
  );
  return Object.freeze({
    schemaVersion: "interaction-metrics-v1",
    preferredCommitmentLabels: Object.freeze(labels),
    entityMechanicAlternations: countAlternations(labels),
    mechanicFamilyAlternations: countAlternations(families),
    recurringResourceLabels: Object.freeze(recurring),
    preferredBalancedDecompositionCost: balancedDecompositionCost(labels, recurring),
    balancedDecomposition,
    counterintuitiveCommitments,
  });
}

function isResourceLabel(label: string | undefined): label is string {
  return label?.startsWith("object:") === true
    || label?.startsWith("fixture:") === true
    || label?.startsWith("fracture:") === true;
}

/** True only when every victory trace contains two separated runs of label. */
function requiredRecurringResource(nodes: readonly GraphNode[], label: string): boolean {
  // 0: unseen, 1: first run seen, 2: another resource followed it. Reaching
  // the target label from phase 2 proves the required second separated run.
  const visited = new Uint8Array(nodes.length * 3);
  const queue: number[] = [0];
  visited[0] = 1;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const identity = queue[cursor]!;
    const node = Math.floor(identity / 3);
    const phase = identity % 3;
    for (const edge of nodes[node]!.edges) {
      let nextPhase = phase;
      if (edge.meaningful && edge.interactionLabels.includes(label)) {
        if (phase === 0) nextPhase = 1;
        else if (phase === 2) continue; // Do not allow the proven second run.
      } else if (edge.meaningful
        && edge.interactionLabels.some(isResourceLabel)
        && phase === 1) {
        nextPhase = 2;
      }
      if (edge.terminal === "victory") return false;
      if (edge.target === undefined) continue;
      const nextIdentity = edge.target * 3 + nextPhase;
      if (visited[nextIdentity] === 1) continue;
      visited[nextIdentity] = 1;
      queue.push(nextIdentity);
    }
  }
  return true;
}

interface CounterintuitiveObjectGoal {
  readonly objectId: string;
  readonly position: Coord;
}

interface CounterintuitiveUseModel {
  readonly definition: MilestoneDefinition;
  readonly occurrence: number;
  readonly objectGoals: readonly CounterintuitiveObjectGoal[];
  readonly fixtureIds: readonly string[];
}

interface CounterintuitiveSearchEntry {
  readonly key: string;
  readonly node: number;
  readonly commitments: number;
  readonly history: readonly number[];
  readonly marked: number;
}

// Sparse product states carry a string key and a heap entry, so this bound is
// intentionally lower than Z's packed-array bound to keep peak memory bounded.
const EXACT_U_MAX_PRODUCT_STATES = 250_000;

/**
 * Exact bounded U over a deliberately conservative relaxed model.
 *
 * V1 tracks only resources which are both solver-proven recurring and named by
 * a mandatory milestone participating in the exact precedence graph. For a
 * movable object with a positional future use, its independent relaxed cost is
 * Manhattan distance to the nearest still-unemitted use. Walls, other objects,
 * hazards, and player routing are ignored. A meaningful edge is marked when
 * any modeled resource's component increases, evaluated against the
 * obligations remaining *after* the edge, or when it turns off an active
 * recurring source which a remaining dependency milestone must use again in a
 * transition-anchored event. Opaque callback milestones,
 * disjunctive/negated guards, non-positional object uses, and consumers add no
 * marks. A future superset of these independent predicates can only preserve
 * or increase U, so v1 remains a lower bound. Milestone occurrence counters
 * and exact source/permanent state stay in the product state.
 *
 * The search minimizes marked edges over every exact winning trace with at
 * most optimal commitments + 2. Raw neutral states are retained, but neutral
 * motion has zero commitment/mark cost, making this equivalent to a bounded
 * macro search without relying on the preferred witness.
 */
function exactCounterintuitiveCommitments(
  level: LevelDefinition,
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  preferred: RetainedSolution | null,
  recurringLabels: readonly string[],
  definitions: readonly MilestoneDefinition[],
  specs: readonly MilestoneSpec[],
  report: MilestoneReport,
): ExactCounterintuitiveCommitments {
  if (preferred === null || winning[0] !== 1) {
    return Object.freeze({
      schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
      supported: false,
      reason: "unsolved",
    });
  }
  const commitmentBudget = preferred.commitments + 2;
  const models = counterintuitiveUseModels(level, recurringLabels, definitions, specs, report);
  const modeledRecurringResourceLabels = Object.freeze([...new Set(models.flatMap((model) => [
    ...model.objectGoals.map((goal) => `object:${goal.objectId}`),
    ...model.fixtureIds.map((id) => `fixture:${id}`),
  ]))].sort());
  if (models.length === 0) {
    return Object.freeze({
      schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
      supported: true,
      value: 0,
      commitmentBudget,
      productStatesEvaluated: 1,
      modeledRecurringResourceLabels,
    });
  }

  const initialHistory = Object.freeze(models.map(() => 0));
  const initialKey = counterintuitiveProductKey(0, 0, initialHistory);
  const best = new Map<string, number>([[initialKey, 0]]);
  const heap = new MinHeap<CounterintuitiveSearchEntry>((a, b) => (
    a.marked - b.marked
    || a.commitments - b.commitments
    || a.node - b.node
    || compareNumberArrays(a.history, b.history)
  ));
  heap.push({
    key: initialKey,
    node: 0,
    commitments: 0,
    history: initialHistory,
    marked: 0,
  });
  let bestVictory = Number.POSITIVE_INFINITY;
  while (heap.size > 0) {
    const current = heap.pop()!;
    if (best.get(current.key) !== current.marked) continue;
    if (current.marked >= bestVictory) break;
    for (const edge of nodes[current.node]!.edges) {
      const commitments = current.commitments + (edge.meaningful ? 1 : 0);
      if (commitments > commitmentBudget) continue;
      const history = advanceCounterintuitiveHistory(current.history, edge, models);
      if (edge.terminal === "victory") {
        bestVictory = Math.min(bestVictory, current.marked);
        continue;
      }
      if (edge.target === undefined || winning[edge.target] !== 1) continue;
      const marked = current.marked + (
        counterintuitiveEdgeIsMarked(
          nodes[current.node]!,
          nodes[edge.target]!,
          edge,
          history,
          models,
        ) ? 1 : 0
      );
      const key = counterintuitiveProductKey(edge.target, commitments, history);
      const known = best.get(key);
      if (known !== undefined && known <= marked) continue;
      if (known === undefined && best.size >= EXACT_U_MAX_PRODUCT_STATES) {
        return Object.freeze({
          schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
          supported: false,
          reason: "product-state-budget",
        });
      }
      best.set(key, marked);
      heap.push({ key, node: edge.target, commitments, history, marked });
    }
  }
  if (!Number.isFinite(bestVictory)) {
    return Object.freeze({
      schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
      supported: false,
      reason: "unsolved",
    });
  }
  return Object.freeze({
    schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
    supported: true,
    value: bestVictory,
    commitmentBudget,
    productStatesEvaluated: best.size,
    modeledRecurringResourceLabels,
  });
}

function counterintuitiveUseModels(
  level: LevelDefinition,
  recurringLabels: readonly string[],
  definitions: readonly MilestoneDefinition[],
  specs: readonly MilestoneSpec[],
  report: MilestoneReport,
): readonly CounterintuitiveUseModel[] {
  const recurring = new Set(recurringLabels);
  const mandatory = new Set(report.mandatoryIds);
  const specById = new Map(specs.map((spec) => [spec.id, spec]));
  const dependencyIds = new Set(report.precedence.flatMap((relation) => [
    relation.before,
    relation.after,
  ]));
  const fixturePositions = new Map<string, Coord>();
  for (let index = 0; index < level.cells.length; index += 1) {
    const fixture = level.cells[index]?.fixture;
    if (fixture !== undefined) fixturePositions.set(fixture.id, indexCoord(level, index));
  }
  const models: CounterintuitiveUseModel[] = [];
  for (const definition of definitions) {
    const spec = specById.get(definition.id);
    if (!mandatory.has(definition.id) || !dependencyIds.has(definition.id) || spec === undefined) {
      continue;
    }
    const objectGoals: CounterintuitiveObjectGoal[] = [];
    const fixtureIds = new Set<string>();
    collectCounterintuitiveTriggerReferences(
      spec.trigger,
      fixturePositions,
      objectGoals,
      fixtureIds,
    );
    if (spec.guard !== undefined) {
      collectCounterintuitiveGuardReferences(
        spec.guard,
        fixturePositions,
        objectGoals,
        fixtureIds,
      );
    }
    const relevantGoals = objectGoals.filter((goal) => recurring.has(`object:${goal.objectId}`));
    const relevantFixtures = [...fixtureIds]
      .filter((id) => recurring.has(`fixture:${id}`))
      .sort();
    if (relevantGoals.length === 0 && relevantFixtures.length === 0) continue;
    models.push(Object.freeze({
      definition,
      occurrence: definition.occurrence ?? 1,
      objectGoals: Object.freeze(relevantGoals),
      fixtureIds: Object.freeze(relevantFixtures),
    }));
  }
  return Object.freeze(models);
}

function collectCounterintuitiveTriggerReferences(
  trigger: MilestoneTrigger,
  fixturePositions: ReadonlyMap<string, Coord>,
  objectGoals: CounterintuitiveObjectGoal[],
  fixtureIds: Set<string>,
): void {
  if ("delta" in trigger) {
    collectCounterintuitivePredicateReferences(
      trigger.delta.predicate,
      fixturePositions,
      objectGoals,
      fixtureIds,
      true,
    );
    return;
  }
  if (trigger.fixtureId !== undefined) fixtureIds.add(trigger.fixtureId);
  if (trigger.objectId === undefined) return;
  const position = trigger.event === "object-pushed"
    ? trigger.to ?? trigger.from
    : trigger.event === "socket-docked" || trigger.event === "object-removed"
    ? trigger.position ?? (
        trigger.fixtureId === undefined ? undefined : fixturePositions.get(trigger.fixtureId)
      )
    : undefined;
  if (position !== undefined) objectGoals.push({ objectId: trigger.objectId, position });
}

function collectCounterintuitiveGuardReferences(
  guard: MilestoneGuard,
  fixturePositions: ReadonlyMap<string, Coord>,
  objectGoals: CounterintuitiveObjectGoal[],
  fixtureIds: Set<string>,
): void {
  if ("beforeState" in guard) {
    collectCounterintuitivePredicateReferences(
      guard.beforeState,
      fixturePositions,
      objectGoals,
      fixtureIds,
      false,
    );
  } else if ("afterState" in guard) {
    collectCounterintuitivePredicateReferences(
      guard.afterState,
      fixturePositions,
      objectGoals,
      fixtureIds,
      false,
    );
  } else if ("not" in guard) {
    // Negated availability/position is not a relaxed future-use target.
    return;
  } else if ("all" in guard) {
    for (const child of guard.all) {
      collectCounterintuitiveGuardReferences(
        child,
        fixturePositions,
        objectGoals,
        fixtureIds,
      );
    }
  } else {
    // V1 does not attempt logical intersection across disjunctive guards.
    // Ignoring them is conservative and prevents an optional branch from
    // becoming a claimed mandatory resource use.
    return;
  }
}

function collectCounterintuitivePredicateReferences(
  predicate: MilestoneStatePredicate,
  fixturePositions: ReadonlyMap<string, Coord>,
  objectGoals: CounterintuitiveObjectGoal[],
  fixtureIds: Set<string>,
  includeFixtureUse: boolean,
): void {
  if ("entityAt" in predicate) {
    if (predicate.entityAt.entityId !== "player") {
      objectGoals.push({
        objectId: predicate.entityAt.entityId,
        position: predicate.entityAt.position,
      });
    }
  } else if ("relayState" in predicate) {
    if (includeFixtureUse) fixtureIds.add(predicate.relayState.fixtureId);
  } else if ("socketInstallation" in predicate) {
    if (includeFixtureUse) fixtureIds.add(predicate.socketInstallation.fixtureId);
    const position = fixturePositions.get(predicate.socketInstallation.fixtureId);
    if (predicate.socketInstallation.objectId !== undefined && position !== undefined) {
      objectGoals.push({ objectId: predicate.socketInstallation.objectId, position });
    }
  } else if ("consumerState" in predicate) {
    if (includeFixtureUse) fixtureIds.add(predicate.consumerState.fixtureId);
  }
}

function advanceCounterintuitiveHistory(
  history: readonly number[],
  edge: GraphEdge,
  models: readonly CounterintuitiveUseModel[],
): readonly number[] {
  let changed = false;
  const next = history.map((count, index) => {
    const model = models[index]!;
    if (count >= model.occurrence || !edge.milestoneIds.includes(model.definition.id)) return count;
    changed = true;
    return Math.min(model.occurrence, count + 1);
  });
  return changed ? Object.freeze(next) : history;
}

function counterintuitiveEdgeIsMarked(
  before: GraphNode,
  after: GraphNode,
  edge: GraphEdge,
  afterHistory: readonly number[],
  models: readonly CounterintuitiveUseModel[],
): boolean {
  if (!edge.meaningful) return false;
  const objectGoals = relaxedRemainingObjectGoals(afterHistory, models);
  for (const [objectId, positions] of objectGoals) {
    const beforeDistance = relaxedObjectDistance(before, objectId, positions);
    const afterDistance = relaxedObjectDistance(after, objectId, positions);
    if (
      beforeDistance !== undefined
      && afterDistance !== undefined
      && afterDistance > beforeDistance
    ) return true;
  }
  const remainingFixtures = new Set<string>();
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    if (afterHistory[index]! >= model.occurrence) continue;
    for (const fixtureId of model.fixtureIds) remainingFixtures.add(fixtureId);
  }
  for (const fixtureId of remainingFixtures) {
    const beforeSource = before.snapshot.derived.sources.find((source) => source.fixtureId === fixtureId);
    const afterSource = after.snapshot.derived.sources.find((source) => source.fixtureId === fixtureId);
    if (beforeSource?.active === true && afterSource?.active === false) return true;
  }
  return false;
}

function relaxedRemainingObjectGoals(
  history: readonly number[],
  models: readonly CounterintuitiveUseModel[],
): ReadonlyMap<string, readonly Coord[]> {
  const goals = new Map<string, Coord[]>();
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    if (history[index]! >= model.occurrence) continue;
    for (const goal of model.objectGoals) {
      const positions = goals.get(goal.objectId) ?? [];
      positions.push(goal.position);
      goals.set(goal.objectId, positions);
    }
  }
  return goals;
}

function relaxedObjectDistance(
  node: GraphNode,
  objectId: string,
  positions: readonly Coord[],
): number | undefined {
  const object = node.snapshot.state.objects.find((candidate) => candidate.id === objectId);
  if (object === undefined || positions.length === 0) return undefined;
  let minimum = Number.POSITIVE_INFINITY;
  for (const position of positions) {
    minimum = Math.min(
      minimum,
      Math.abs(object.position.x - position.x) + Math.abs(object.position.y - position.y),
    );
  }
  return Number.isFinite(minimum) ? minimum : undefined;
}

function counterintuitiveProductKey(
  node: number,
  commitments: number,
  history: readonly number[],
): string {
  return `${node}|${commitments}|${history.join(",")}`;
}

function compareNumberArrays(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

const EXACT_Z_MAX_LABELS = 8;
// Exact Z evaluates one bounded partition at a time, so this is a work cap,
// not a resident-memory allocation.  Ten million covers the compact d6
// interchange proof while keeping certification predictably bounded.
const EXACT_Z_MAX_TOTAL_PRODUCT_STATES = 10_000_000;

function exactBalancedDecomposition(
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  preferred: RetainedSolution | null,
  labels: readonly string[],
): ExactBalancedDecomposition {
  if (preferred === null || winning[0] !== 1) {
    return Object.freeze({ supported: false, reason: "unsolved" });
  }
  if (labels.length < 2) {
    return Object.freeze({
      supported: true,
      value: 0,
      commitmentBudget: preferred.commitments + 2,
      partitionsEvaluated: 0,
    });
  }
  if (labels.length > EXACT_Z_MAX_LABELS) {
    return Object.freeze({ supported: false, reason: "too-many-recurring-labels" });
  }
  const partitions = balancedPartitions(labels);
  const commitmentBudget = preferred.commitments + 2;
  const productStates = nodes.length * (commitmentBudget + 1) * 3;
  if (productStates * partitions.length > EXACT_Z_MAX_TOTAL_PRODUCT_STATES) {
    return Object.freeze({ supported: false, reason: "product-state-budget" });
  }
  let value = Number.POSITIVE_INFINITY;
  for (const partition of partitions) {
    value = Math.min(value, minimumPartitionAlternations(
      nodes,
      winning,
      commitmentBudget,
      partition,
    ));
  }
  return Object.freeze({
    supported: true,
    value: Number.isFinite(value) ? value : 0,
    commitmentBudget,
    partitionsEvaluated: partitions.length,
  });
}

function balancedPartitions(labels: readonly string[]): readonly ReadonlyMap<string, 0 | 1>[] {
  const minimumGroupSize = Math.floor(labels.length / 2);
  const maximumGroupSize = Math.ceil(labels.length / 2);
  const result: ReadonlyMap<string, 0 | 1>[] = [];
  const combinations = 2 ** Math.max(0, labels.length - 1);
  // Label zero is fixed in group zero; complementary partitions are identical.
  for (let suffixMask = 0; suffixMask < combinations; suffixMask += 1) {
    const mask = suffixMask << 1;
    let groupOneSize = 0;
    for (let bit = 0; bit < labels.length; bit += 1) groupOneSize += (mask >> bit) & 1;
    if (groupOneSize < minimumGroupSize || groupOneSize > maximumGroupSize) continue;
    result.push(new Map(labels.map((label, index) => (
      [label, ((mask >> index) & 1) as 0 | 1]
    ))));
  }
  return Object.freeze(result);
}

interface PartitionSearchEntry {
  readonly identity: number;
  readonly node: number;
  readonly commitments: number;
  /** -1 means no recurring resource group has been encountered. */
  readonly lastGroup: -1 | 0 | 1;
  readonly alternations: number;
}

function minimumPartitionAlternations(
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  commitmentBudget: number,
  partition: ReadonlyMap<string, 0 | 1>,
): number {
  const statesPerNode = (commitmentBudget + 1) * 3;
  const distances = new Uint16Array(nodes.length * statesPerNode);
  distances.fill(0xffff);
  distances[0] = 0;
  const heap = new MinHeap<PartitionSearchEntry>((a, b) => (
    a.alternations - b.alternations
    || a.commitments - b.commitments
    || a.node - b.node
    || a.lastGroup - b.lastGroup
  ));
  heap.push({ identity: 0, node: 0, commitments: 0, lastGroup: -1, alternations: 0 });
  let bestVictory = Number.POSITIVE_INFINITY;
  while (heap.size > 0) {
    const current = heap.pop()!;
    if (distances[current.identity] !== current.alternations) continue;
    if (current.alternations >= bestVictory) return bestVictory;
    for (const edge of nodes[current.node]!.edges) {
      const commitments = current.commitments + (edge.meaningful ? 1 : 0);
      if (commitments > commitmentBudget) continue;
      const groups = [...new Set(edge.interactionLabels
        .map((label) => partition.get(label))
        .filter((group): group is 0 | 1 => group !== undefined))];
      const groupChoices: readonly (0 | 1 | undefined)[] = groups.length === 0
        ? [undefined]
        : groups;
      for (const group of groupChoices) {
        // A simultaneous edge touching both partitions may be attributed to
        // either group. Taking the minimum avoids inventing an event order.
        const lastGroup = group ?? current.lastGroup;
        const alternations = current.alternations + (
          group !== undefined && current.lastGroup !== -1 && group !== current.lastGroup ? 1 : 0
        );
        if (edge.terminal === "victory") {
          bestVictory = Math.min(bestVictory, alternations);
          continue;
        }
        if (edge.target === undefined || winning[edge.target] !== 1) continue;
        const lastGroupIndex = lastGroup + 1;
        const identity = edge.target * statesPerNode + commitments * 3 + lastGroupIndex;
        if (alternations >= distances[identity]!) continue;
        distances[identity] = alternations;
        heap.push({ identity, node: edge.target, commitments, lastGroup, alternations });
      }
    }
  }
  return bestVictory;
}

function inferredFamily(edge: GraphEdge): string {
  if (edge.pushedObjectId !== undefined) return "pushing";
  if (edge.interactionLabel?.startsWith("fracture:") === true) return "irreversible-terrain";
  if (edge.interactionLabel?.startsWith("fixture:") === true) return "power";
  return "movement";
}

function collapseRuns(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (result[result.length - 1] !== value) result.push(value);
  }
  return result;
}

function countAlternations(values: readonly string[]): number {
  return Math.max(0, collapseRuns(values).length - 1);
}

function balancedDecompositionCost(
  labels: readonly string[],
  recurringLabels: readonly string[],
): number {
  if (recurringLabels.length < 2) return 0;
  if (recurringLabels.length > EXACT_Z_MAX_LABELS) return 0;
  const relevant = labels.filter((label) => recurringLabels.includes(label));
  const count = recurringLabels.length;
  const minimumGroupSize = Math.floor(count / 2);
  const maximumGroupSize = Math.ceil(count / 2);
  let best = Number.POSITIVE_INFINITY;
  // Fix label zero in group zero to eliminate complementary duplicates.
  const combinations = 2 ** Math.max(0, count - 1);
  for (let suffixMask = 0; suffixMask < combinations; suffixMask += 1) {
    const mask = suffixMask << 1;
    let groupOneSize = 0;
    for (let bit = 0; bit < count; bit += 1) groupOneSize += (mask >> bit) & 1;
    if (groupOneSize < minimumGroupSize || groupOneSize > maximumGroupSize) continue;
    const groupSequence = relevant.map((label) => (
      (mask >> recurringLabels.indexOf(label)) & 1
    ).toString());
    best = Math.min(best, countAlternations(groupSequence));
  }
  return Number.isFinite(best) ? best : 0;
}

function buildDecisionStructureMetrics(
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  preferredEdges: readonly GraphEdge[],
): DecisionStructureMetrics {
  let solutionDirectionChanges = 0;
  for (let index = 1; index < preferredEdges.length; index += 1) {
    if (preferredEdges[index]!.action !== preferredEdges[index - 1]!.action) {
      solutionDirectionChanges += 1;
    }
  }

  const pushedEdges = preferredEdges.filter((edge) => edge.pushed);
  const pushDirections = new Set(pushedEdges.map((edge) => edge.action));
  const pushAxes = new Set(pushedEdges.map((edge) => (
    edge.action === "E" || edge.action === "W" ? "horizontal" : "vertical"
  )));
  const pushedObjects = new Set<string>();
  for (const edge of pushedEdges) {
    if (edge.pushedObjectId !== undefined) pushedObjects.add(edge.pushedObjectId);
  }
  const firstPush = preferredEdges.findIndex((edge) => edge.pushed);
  let lastPush = -1;
  for (let index = preferredEdges.length - 1; index >= 0; index -= 1) {
    if (preferredEdges[index]!.pushed) {
      lastPush = index;
      break;
    }
  }
  let repositioningActions = 0;
  if (firstPush >= 0 && lastPush > firstPush) {
    for (let index = firstPush + 1; index < lastPush; index += 1) {
      if (!preferredEdges[index]!.pushed) repositioningActions += 1;
    }
  }

  let winningChoiceStates = 0;
  let recoverableChoiceStates = 0;
  let fatalChoiceStates = 0;
  let source = 0;
  let previousSource: number | undefined;
  let previousAction: Direction | undefined;
  for (const selected of preferredEdges) {
    const meaningfulSuccessors = nodes[source]!.edges.filter((edge) => (
      edge.meaningful
      && (previousSource === undefined || edge.target !== previousSource)
      && (previousAction === undefined || edge.action !== oppositeDirection(previousAction))
    ));
    if (meaningfulSuccessors.length >= 2) {
      winningChoiceStates += 1;
      const alternatives = meaningfulSuccessors.filter((edge) => edge !== selected);
      if (alternatives.some((edge) => (
        edge.terminal === "victory"
        || (edge.target !== undefined && winning[edge.target] === 1)
      ))) {
        recoverableChoiceStates += 1;
      }
      if (alternatives.some((edge) => (
        edge.terminal === "physical-failure"
        || (edge.target !== undefined && winning[edge.target] !== 1)
      ))) {
        fatalChoiceStates += 1;
      }
    }
    if (selected.target === undefined) break;
    previousSource = source;
    previousAction = selected.action;
    source = selected.target;
  }

  let pushRuns = 0;
  let turningRegrips = 0;
  let objectRevisits = 0;
  let activeRunObject: string | undefined;
  let activeRunDirection: Direction | undefined;
  let previousRunObject: string | undefined;
  const previousDirectionByObject = new Map<string, Direction>();
  const seenRunObjects = new Set<string>();
  for (const edge of preferredEdges) {
    if (!edge.pushed || edge.pushedObjectId === undefined) {
      activeRunObject = undefined;
      activeRunDirection = undefined;
      continue;
    }
    if (activeRunObject === edge.pushedObjectId && activeRunDirection === edge.action) continue;

    pushRuns += 1;
    const priorDirection = previousDirectionByObject.get(edge.pushedObjectId);
    if (priorDirection !== undefined && priorDirection !== edge.action) turningRegrips += 1;
    if (previousRunObject !== edge.pushedObjectId && seenRunObjects.has(edge.pushedObjectId)) {
      objectRevisits += 1;
    }
    previousDirectionByObject.set(edge.pushedObjectId, edge.action);
    seenRunObjects.add(edge.pushedObjectId);
    previousRunObject = edge.pushedObjectId;
    activeRunObject = edge.pushedObjectId;
    activeRunDirection = edge.action;
  }

  const finalLandingByObject = new Map<string, Coord>();
  for (const edge of preferredEdges) {
    if (edge.pushedObjectId !== undefined && edge.pushedTo !== undefined) {
      finalLandingByObject.set(edge.pushedObjectId, edge.pushedTo);
    }
  }
  let nonProgressPushes = 0;
  for (const edge of preferredEdges) {
    if (
      edge.pushedObjectId === undefined
      || edge.pushedFrom === undefined
      || edge.pushedTo === undefined
    ) continue;
    const finalLanding = finalLandingByObject.get(edge.pushedObjectId);
    if (finalLanding === undefined) continue;
    if (
      manhattanDistance(edge.pushedTo, finalLanding)
      >= manhattanDistance(edge.pushedFrom, finalLanding)
    ) {
      nonProgressPushes += 1;
    }
  }

  let consequenceFreeActions = 0;
  let consequenceFreeRun = 0;
  let longestConsequenceFreeRun = 0;
  for (const edge of preferredEdges) {
    if (edge.persistentConsequence === false) {
      consequenceFreeActions += 1;
      consequenceFreeRun += 1;
      longestConsequenceFreeRun = Math.max(longestConsequenceFreeRun, consequenceFreeRun);
    } else {
      consequenceFreeRun = 0;
    }
  }
  const consequenceFreePermille = preferredEdges.length === 0
    ? 0
    : Math.floor((consequenceFreeActions * 1_000) / preferredEdges.length);

  return Object.freeze({
    solutionDirectionChanges,
    pushDirections: pushDirections.size,
    pushAxes: pushAxes.size,
    pushedObjects: pushedObjects.size,
    repositioningActions,
    winningChoiceStates,
    recoverableChoiceStates,
    fatalChoiceStates,
    pushRuns,
    turningRegrips,
    nonProgressPushes,
    objectRevisits,
    longestConsequenceFreeRun,
    consequenceFreePermille,
  });
}

function manhattanDistance(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function oppositeDirection(direction: Direction): Direction {
  switch (direction) {
    case "N": return "S";
    case "E": return "W";
    case "S": return "N";
    case "W": return "E";
  }
}

function buildFeatureVector(
  level: LevelDefinition,
  nodes: readonly GraphNode[],
  winning: Uint8Array,
  fatalFrontier: readonly FatalFrontierEntry[],
  preferred: RetainedSolution | null,
  preferredEdges: readonly GraphEdge[],
  components: Int32Array,
  milestones: MilestoneReport,
  interleaving: number,
  suppliedMechanicFamilies: number | undefined,
  definitions: readonly MilestoneDefinition[],
  macroProjection: MacroProjectionReport | undefined,
): DifficultyFeatureVector {
  let pressureSum = 0;
  let pressureStates = 0;
  let meaningfulWinningEdges = 0;
  const choiceStateKeys = new Set<string>();
  for (let index = 0; index < nodes.length; index += 1) {
    if (winning[index] !== 1) continue;
    const meaningful = nodes[index]!.edges.filter((edge) => edge.meaningful);
    if (meaningful.length > 0) {
      pressureSum += Math.log2(1 + meaningful.length);
      pressureStates += 1;
      if (meaningful.length > 1) {
        meaningfulWinningEdges += meaningful.length;
        choiceStateKeys.add(nodes[index]!.key);
      }
    }
  }
  let irreversibility = 0;
  let source = 0;
  for (const edge of preferredEdges) {
    if (edge.target === undefined) break;
    if (edge.meaningful && components[source] !== components[edge.target]) irreversibility += 1;
    source = edge.target;
  }
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const fatalMeaningful = fatalFrontier.reduce((count, fatal) => {
    if (!choiceStateKeys.has(fatal.stateKey)) return count;
    const edge = nodeByKey.get(fatal.stateKey)?.edges.find((candidate) => candidate.action === fatal.action);
    return count + (edge?.meaningful ? 1 : 0);
  }, 0);
  const mechanicFamiliesPresent = level.generatorVersion === "g4"
    ? countG4MechanicFamiliesPresent(level)
    : countG2MechanicFamilies(level);
  const mechanicFamiliesMandatory = level.generatorVersion === "g4"
    ? countMandatoryMechanicFamilies(milestones, definitions)
    : undefined;
  return Object.freeze({
    commitments: preferred?.commitments ?? 0,
    dependencyDepth: milestones.dependencyDepth,
    planningHorizon: milestones.planningHorizon,
    interleaving,
    irreversibility,
    decisionPressure: pressureStates === 0 ? 0 : pressureSum / pressureStates,
    crossMechanicCoupling: milestones.crossMechanicCoupling,
    stateSpaceComplexity: Math.log2(1 + (macroProjection?.macroStateCount ?? nodes.length)),
    fatalChoicePressure: meaningfulWinningEdges === 0 ? 0 : fatalMeaningful / meaningfulWinningEdges,
    mechanicFamilies: level.generatorVersion === "g4"
      ? mechanicFamiliesMandatory ?? 0
      : usesModernAnalysis(level.generatorVersion)
      ? mechanicFamiliesPresent
      : suppliedMechanicFamilies ?? countMechanicFamilies(level),
    ...(level.generatorVersion === "g4"
      ? { mechanicFamiliesPresent, mechanicFamiliesMandatory: mechanicFamiliesMandatory ?? 0 }
      : {}),
  });
}

function countMandatoryMechanicFamilies(
  milestones: MilestoneReport,
  definitions: readonly MilestoneDefinition[],
): number {
  if (milestones.mandatoryFamilies !== undefined) return milestones.mandatoryFamilies.length;
  const dependencyIds = new Set(milestones.precedence.flatMap((relation) => (
    [relation.before, relation.after]
  )));
  return new Set(definitions
    .filter((definition) => (
      dependencyIds.has(definition.id)
      && (RATED_MILESTONE_FAMILIES as ReadonlySet<string>).has(definition.family)
    ))
    .map((definition) => definition.family)).size;
}

/** g4 K_present uses the same closed families as milestone-dsl-v1. */
export function countG4MechanicFamiliesPresent(level: LevelDefinition): number {
  const families = new Set<string>();
  const fixtures = level.cells
    .map((cell) => cell.fixture)
    .filter((fixture): fixture is NonNullable<typeof fixture> => fixture !== undefined);
  if (level.objects.length > 0) families.add("pushing");
  if (fixtures.some((fixture) => fixture.kind === "plate")) {
    families.add("momentary-circuit");
  }
  if (fixtures.some((fixture) => fixture.kind === "relay" || fixture.kind === "socket")) {
    families.add("permanent-sources");
  }
  const hasSource = fixtures.some((fixture) => (
    fixture.kind === "plate" || fixture.kind === "relay" || fixture.kind === "socket"
  ));
  const hasNonGateConsumer = fixtures.some((fixture) => (
    fixture.kind === "door" || fixture.kind === "bridge"
  ));
  if (hasSource || hasNonGateConsumer) families.add("power");
  if (hasNonGateConsumer) families.add("consumers");
  if (level.cells.some((cell) => cell.terrain === "vacuum" || cell.fixture?.kind === "bridge")) {
    families.add("hazards");
  }
  if (level.cells.some((cell) => (
    cell.terrain === "fracture" || cell.fixture?.kind === "disposal"
  ))) {
    families.add("irreversible-terrain");
  }
  return families.size;
}

/** Versioned K grouping from the g2 mission grammar; always remains in 1..6. */
export function countG2MechanicFamilies(level: LevelDefinition): number {
  const families = new Set<string>();
  if (level.objects.length > 0) families.add("pushing");
  if (level.cells.some((cell) => cell.fixture?.kind === "plate")) {
    families.add("momentary-circuit");
  }
  if (
    level.objects.some((object) => object.kind === "reactor-cell")
    || level.cells.some((cell) => (
      cell.fixture?.kind === "relay" || cell.fixture?.kind === "socket"
    ))
  ) {
    families.add("permanent-sources");
  }
  if (level.cells.some((cell) => (
    cell.fixture?.kind === "door"
    || cell.fixture?.kind === "bridge"
    || cell.fixture?.kind === "gate"
  ))) {
    families.add("consumers");
  }
  if (level.cells.some((cell) => (
    cell.terrain === "vacuum" || cell.fixture?.kind === "bridge"
  ))) {
    families.add("hazards");
  }
  if (level.cells.some((cell) => (
    cell.terrain === "fracture"
    || cell.fixture?.kind === "disposal"
    || cell.fixture?.kind === "socket"
  ))) {
    families.add("irreversible-terrain");
  }
  return Math.max(1, families.size);
}

function countMechanicFamilies(level: LevelDefinition): number {
  const families = new Set<string>();
  for (const object of level.objects) families.add(object.kind);
  for (const cell of level.cells) {
    if (cell.fixture !== undefined) families.add(cell.fixture.kind);
    if (cell.terrain === "fracture" || cell.terrain === "vacuum") families.add(cell.terrain);
  }
  return Math.max(1, families.size);
}

async function cooperate(options: SolverHooks): Promise<void> {
  checkCancelled(options);
  await options.yieldControl?.();
  checkCancelled(options);
}

function checkCancelled(options: SolverHooks): void {
  if (options.shouldCancel?.() === true) throw new AnalysisCancelledError();
}

class MinHeap<T> {
  readonly #compare: (a: T, b: T) => number;
  readonly #items: T[] = [];

  constructor(compare: (a: T, b: T) => number) {
    this.#compare = compare;
  }

  get size(): number {
    return this.#items.length;
  }

  push(item: T): void {
    let index = this.#items.length;
    this.#items.push(item);
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.#compare(this.#items[parent]!, item) <= 0) break;
      this.#items[index] = this.#items[parent]!;
      index = parent;
    }
    this.#items[index] = item;
  }

  pop(): T | undefined {
    if (this.#items.length === 0) return undefined;
    const root = this.#items[0]!;
    const tail = this.#items.pop()!;
    if (this.#items.length === 0) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.#items.length) break;
      const right = left + 1;
      const child = right < this.#items.length
        && this.#compare(this.#items[right]!, this.#items[left]!) < 0
        ? right
        : left;
      if (this.#compare(this.#items[child]!, tail) >= 0) break;
      this.#items[index] = this.#items[child]!;
      index = child;
    }
    this.#items[index] = tail;
    return root;
  }
}
