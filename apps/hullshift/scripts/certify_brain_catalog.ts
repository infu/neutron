import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BRAIN_CATALOG_SCHEMA_VERSION,
  MAX_BRAIN_CATALOG_BYTES,
  MAX_BRAIN_WITNESS_ACTIONS,
  createBrainCertificate,
  normalizeBrainLevel,
  parseBrainCatalog,
  type BrainCatalog,
  type BrainCatalogEntry,
  type BrainProvenance,
  type BrainRequiredPrecedence,
} from "../src/brain_catalog.ts";
import { validateLevel } from "../src/mechanics.ts";
import {
  brainQualityViolations,
  type BrainQualityMode,
} from "../src/brain_quality.ts";
import type { Direction, LevelDefinition } from "../src/model.ts";
import {
  InvalidMilestoneSpecError,
  validateMilestoneSpecs,
  type MilestoneSpec,
} from "../src/milestone_dsl.ts";
import { canonicalLevelHash, encodeUtf8, sha256Hex } from "../src/simulation.ts";
import {
  AnalysisLimitError,
  DEFAULT_ANALYSIS_LIMITS,
  analyzeLevel,
  replayWitness,
} from "../src/solver.ts";
import { encodeShareCode } from "../src/share_code.ts";
import {
  MAX_WORKER_MESSAGE_BYTES,
  WORKER_PROTOCOL_VERSION,
  serializeAnalysis,
  workerMessageBytes,
} from "../src/worker_protocol.ts";

interface CandidateCatalog {
  readonly schemaVersion?: string;
  readonly generatorVersion?: string;
  readonly brainVersion?: string;
  readonly entries?: readonly unknown[];
}

interface CandidateEntry {
  readonly id: string;
  readonly difficulty: number;
  readonly level: LevelDefinition;
  readonly witness: readonly Direction[];
  readonly milestones: readonly MilestoneSpec[];
  readonly requiredPrecedence: readonly BrainRequiredPrecedence[];
  readonly topologySignature: string;
  readonly semanticSignature: string;
  readonly provenance: BrainProvenance;
}

export interface CertifyCatalogOptions {
  readonly allowPartial?: boolean;
  /** Require the input to already be the byte-content-equivalent shipped form. */
  readonly checkStored?: boolean;
  readonly qualityMode?: BrainQualityMode;
  readonly onProgress?: (message: string) => void;
}

export interface ReleaseAblationLimits {
  readonly maxRounds: number;
  readonly maxProposals: number;
  readonly maxExactAnalyses: number;
  readonly maxTotalStates: number;
  readonly maxTotalTransitions: number;
}

export const RELEASE_ABLATION_LIMITS: Readonly<ReleaseAblationLimits> = Object.freeze({
  /** Greedy accepted simplifications before the diagnostic fixed-point walk stops. */
  maxRounds: 32,
  /** Includes proposals rejected by static or milestone validation. */
  maxProposals: 256,
  /** Exact solver invocations; structurally impossible proposals do not consume this. */
  maxExactAnalyses: 96,
  /** Deterministic cumulative work bounds across all exact ablation analyses. */
  maxTotalStates: 2_000_000,
  maxTotalTransitions: 8_000_000,
} as const);

export type ReleaseAblationKind =
  | "object-remove"
  | "fixture-neutralize"
  | "channel-remove"
  | "channel-merge"
  | "hazard-neutralize"
  | "interior-wall-open";

export interface ReleaseAblationProposal {
  readonly id: string;
  readonly kind: ReleaseAblationKind;
  readonly subject: string;
  readonly level: LevelDefinition;
  /** Present only when a channel merge also has to rename contract references. */
  readonly channelRewrite?: Readonly<{ readonly from: string; readonly to: string }>;
}

export interface ReleaseAblationInventory {
  readonly proposals: readonly ReleaseAblationProposal[];
  /**
   * Frozen structural exemptions: the unique evacuation gate, perimeter hull
   * shell, and a sole gate channel which has no type-compatible merge target.
   */
  readonly structuralExemptions: readonly string[];
}

export interface ReleaseAblationCandidate {
  readonly level: LevelDefinition;
  readonly difficulty: number;
  readonly milestoneSpecs: readonly MilestoneSpec[];
  readonly requiredPrecedence: readonly BrainRequiredPrecedence[];
}

export interface ReleaseAblationEvaluation {
  readonly preservesContract: boolean;
  readonly reason: string;
  readonly states: number;
  readonly transitions: number;
}

export interface ReleaseAblationEvaluationContext {
  readonly proposal: ReleaseAblationProposal;
  readonly candidate: ReleaseAblationCandidate;
  readonly remainingStates: number;
  readonly remainingTransitions: number;
}

export interface ReleaseAblationOptions {
  readonly limits?: Partial<ReleaseAblationLimits>;
  readonly onProgress?: (message: string) => void;
  /** Test seam; production certification always uses the exact evaluator. */
  readonly evaluate?: (
    context: ReleaseAblationEvaluationContext,
  ) => Promise<ReleaseAblationEvaluation>;
}

export interface ReleaseAblationReport {
  readonly essential: boolean;
  readonly fixedPointReached: boolean;
  readonly rounds: number;
  readonly proposalsExamined: number;
  readonly exactAnalyses: number;
  readonly totalStates: number;
  readonly totalTransitions: number;
  readonly accepted: readonly Readonly<{
    id: string;
    kind: ReleaseAblationKind;
    subject: string;
  }>[];
  readonly structuralRejections: number;
  readonly structuralExemptions: readonly string[];
}

export class ReleaseAblationIncompleteError extends Error {
  constructor(message: string) {
    super(`Release fixed-point ablation proof is incomplete: ${message}`);
    this.name = "ReleaseAblationIncompleteError";
  }
}

export async function certifyBrainCatalogValue(
  input: unknown,
  options: CertifyCatalogOptions = {},
): Promise<BrainCatalog> {
  if (!isRecord(input)) throw new Error("HullshiftBrain candidate catalog root must be an object");
  const candidate = input as CandidateCatalog;
  if (candidate.schemaVersion !== BRAIN_CATALOG_SCHEMA_VERSION) {
    throw new Error(`Candidate catalog schemaVersion must be ${BRAIN_CATALOG_SCHEMA_VERSION}`);
  }
  if (candidate.generatorVersion !== "g4") throw new Error("Candidate catalog must target g4");
  if (!validToken(candidate.brainVersion, 80)) throw new Error("Candidate catalog brainVersion is invalid");
  if (!Array.isArray(candidate.entries)) throw new Error("Candidate catalog entries must be an array");

  const certified: BrainCatalogEntry[] = [];
  const qualityMode = options.qualityMode ?? "pilot";
  const hashes = new Set<string>();
  const equivalenceSignatures = new Set<string>();
  const ids = new Set<string>();
  const ordered = [...candidate.entries].map(parseCandidateEntry).sort((a, b) => compareAscii(a.id, b.id));
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index]!;
    options.onProgress?.(`[${index + 1}/${ordered.length}] ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate candidate id: ${entry.id}`);
    ids.add(entry.id);
    const issues = validateLevel(entry.level);
    if (issues.length > 0) {
      throw new Error(`${entry.id}: invalid level: ${issues.map((issue) => issue.code).join(", ")}`);
    }
    if (entry.level.generatorVersion !== "g4") throw new Error(`${entry.id}: level is not g4`);
    assertPrecedenceContract(entry);
    replayWitness(entry.level, entry.witness);
    const levelHash = canonicalLevelHash(entry.level);
    if (hashes.has(levelHash)) throw new Error(`${entry.id}: duplicate canonical level ${levelHash}`);
    hashes.add(levelHash);
    const equivalenceSignature = deriveEquivalenceSignature(entry.level);
    if (equivalenceSignatures.has(equivalenceSignature)) {
      throw new Error(`${entry.id}: duplicate level after symmetry and id normalization`);
    }
    equivalenceSignatures.add(equivalenceSignature);
    const topologySignature = deriveTopologySignature(entry.level);
    const semanticSignature = deriveSemanticSignature(levelHash);
    if (entry.topologySignature !== topologySignature) {
      throw new Error(`${entry.id}: stale topology signature`);
    }
    if (entry.semanticSignature !== semanticSignature) {
      throw new Error(`${entry.id}: stale semantic signature`);
    }

    const analysis = await analyzeLevel(entry.level, {
      milestoneSpecs: entry.milestones,
      requestedDifficulty: entry.difficulty,
    });
    if (!analysis.solvable || analysis.preferredSolution === null || analysis.difficulty === null) {
      throw new Error(`${entry.id}: exact analysis found no solution`);
    }
    if (!analysis.difficulty.profileMatch || analysis.difficulty.ratedDifficulty !== entry.difficulty) {
      throw new Error(
        `${entry.id}: difficulty mismatch: rated ${analysis.difficulty.ratedDifficulty}; ${analysis.difficulty.hardViolations.join(", ")}`,
      );
    }
    const mandatory = new Set(analysis.milestones.mandatoryIds);
    for (const milestone of entry.milestones) {
      if (!mandatory.has(milestone.id)) throw new Error(`${entry.id}: bypassable milestone ${milestone.id}`);
    }
    const provenPrecedence = new Set(
      analysis.milestones.precedence.map((relation) => `${relation.before}\0${relation.after}`),
    );
    for (const relation of entry.requiredPrecedence) {
      if (!provenPrecedence.has(`${relation.before}\0${relation.after}`)) {
        throw new Error(`${entry.id}: bypassable dependency ${relation.before} -> ${relation.after}`);
      }
    }
    const qualityViolations = brainQualityViolations({
      level: entry.level,
      difficulty: entry.difficulty,
      analysis,
      milestoneSpecs: entry.milestones,
    }, qualityMode);
    if (qualityViolations.length > 0) {
      throw new Error(
        `${entry.id}: quality policy failed: ${qualityViolations.map((violation) => (
          violation.subject === undefined
            ? `${violation.code} (${violation.message})`
            : `${violation.code}:${violation.subject} (${violation.message})`
        )).join("; ")}`,
      );
    }

    // Pilot certification intentionally stops at the fast pure quality gate.
    // Release additionally proves that no supported one-step simplification
    // preserves the exact band, milestone, precedence, and quality contract.
    if (qualityMode === "release") {
      const ablation = await certifyReleaseFixedPointEssentiality({
        level: entry.level,
        difficulty: entry.difficulty,
        milestoneSpecs: entry.milestones,
        requiredPrecedence: entry.requiredPrecedence,
      }, {
        onProgress: (message) => options.onProgress?.(`${entry.id}: ${message}`),
      });
      if (!ablation.essential) {
        const first = ablation.accepted[0]!;
        const suffix = ablation.fixedPointReached
          ? `; diagnostic minimization reached a fixed point after ${ablation.accepted.length} changes`
          : "; one passing simplification is already sufficient to reject release";
        throw new Error(
          `${entry.id}: release essentiality failed: ${first.kind}:${first.subject} preserves the full contract${suffix}`,
        );
      }
      options.onProgress?.(
        `${entry.id}: release essentiality proved across ${ablation.proposalsExamined} proposals and ${ablation.exactAnalyses} exact analyses`,
      );
    }

    const responseBytes = workerMessageBytes({
      protocol: WORKER_PROTOCOL_VERSION,
      type: "generated",
      jobId: "catalog_check",
      result: {
        identity: {
          generatorVersion: "g4",
          seed: "0000000000000000",
          difficulty: entry.difficulty,
        },
        level: entry.level,
        levelHash,
        shareCode: encodeShareCode({
          generatorVersion: "g4",
          seed: 0n,
          difficulty: entry.difficulty,
        }),
        analysis: serializeAnalysis(analysis),
        difficulty: analysis.difficulty,
      },
    });
    if (responseBytes > MAX_WORKER_MESSAGE_BYTES) {
      throw new Error(
        `${entry.id}: serialized worker response is ${responseBytes} bytes (limit ${MAX_WORKER_MESSAGE_BYTES})`,
      );
    }

    certified.push(Object.freeze({
      id: entry.id,
      difficulty: entry.difficulty,
      level: entry.level,
      levelHash,
      witness: entry.witness,
      milestones: entry.milestones,
      requiredPrecedence: entry.requiredPrecedence,
      topologySignature,
      semanticSignature,
      provenance: entry.provenance,
      certificate: createBrainCertificate(levelHash, analysis, qualityMode),
    }));
  }

  if (!options.allowPartial) {
    for (let difficulty = 0; difficulty <= 8; difficulty += 1) {
      if (!certified.some((entry) => entry.difficulty === difficulty)) {
        throw new Error(`Certified catalog has no difficulty-${difficulty} entry`);
      }
    }
  }

  const result = parseBrainCatalog({
    schemaVersion: BRAIN_CATALOG_SCHEMA_VERSION,
    generatorVersion: "g4",
    brainVersion: candidate.brainVersion,
    entries: certified,
  });
  const catalogBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (catalogBytes > MAX_BRAIN_CATALOG_BYTES) {
    throw new Error(
      `Certified catalog is ${catalogBytes} bytes (limit ${MAX_BRAIN_CATALOG_BYTES})`,
    );
  }
  if (options.checkStored) {
    let stored: BrainCatalog;
    try {
      stored = parseBrainCatalog(input);
    } catch (reason) {
      throw new Error(
        `Stored catalog is not in certified shipped form: ${reason instanceof Error ? reason.message : "invalid catalog"}`,
      );
    }
    if (!isDeepStrictEqual(stored, result)) {
      throw new Error("Stored HullshiftBrain catalog differs from fresh exact certification");
    }
  }
  return result;
}

export async function certifyBrainCatalogFile(
  inputPath: string,
  outputPath: string | undefined,
  options: CertifyCatalogOptions = {},
): Promise<BrainCatalog> {
  const source = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  const catalog = await certifyBrainCatalogValue(source, options);
  if (outputPath !== undefined) {
    const temporaryPath = `${outputPath}.tmp-${process.pid}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporaryPath, outputPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
  return catalog;
}

/**
 * Enumerate every supported release simplification in a stable order.
 *
 * The gate fixture itself and perimeter bulkheads are structural, not puzzle
 * content. A sole channel used by that gate is likewise exempt because the
 * level schema has no channel-less gate and there is no merge target. All
 * other movable objects, non-gate fixtures, channels, hazards, and maximal
 * interior horizontal/vertical wall segments receive proposals.
 */
export function enumerateReleaseAblations(
  level: LevelDefinition,
): ReleaseAblationInventory {
  const proposals: ReleaseAblationProposal[] = [];
  const structuralExemptions: string[] = [];

  for (const object of [...level.objects].sort((left, right) => compareAscii(left.id, right.id))) {
    proposals.push(Object.freeze({
      id: `object-remove:${object.id}`,
      kind: "object-remove",
      subject: object.id,
      level: rebuildAblationLevel(level, {
        objects: level.objects.filter((candidate) => candidate.id !== object.id),
      }),
    }));
  }

  const fixtures = level.cells
    .map((cell, index) => ({ cell, index, fixture: cell.fixture }))
    .filter((entry): entry is typeof entry & { fixture: NonNullable<typeof entry.fixture> } => (
      entry.fixture !== undefined
    ))
    .sort((left, right) => compareAscii(left.fixture.id, right.fixture.id));
  for (const entry of fixtures) {
    if (entry.fixture.kind === "gate") {
      structuralExemptions.push(`evacuation-gate:${entry.fixture.id}`);
      continue;
    }
    const cells = [...level.cells];
    // A bridge is support over vacuum. Neutralizing the fixture without also
    // neutralizing the underlying hazard would make the board harder, not
    // simpler, so its canonical fixture proposal becomes ordinary floor.
    cells[entry.index] = entry.fixture.kind === "bridge"
      ? { terrain: "floor" }
      : { terrain: entry.cell.terrain };
    proposals.push(Object.freeze({
      id: `fixture-neutralize:${entry.fixture.id}`,
      kind: "fixture-neutralize",
      subject: entry.fixture.id,
      level: rebuildAblationLevel(level, { cells }),
    }));
  }

  const channels = [...level.channels].sort((left, right) => compareAscii(left.id, right.id));
  for (const channel of channels) {
    const referenced = level.cells.some((cell) => (
      cell.fixture !== undefined
      && cell.fixture.kind !== "disposal"
      && cell.fixture.channel === channel.id
    ));
    if (!referenced) {
      proposals.push(Object.freeze({
        id: `channel-remove:${channel.id}`,
        kind: "channel-remove",
        subject: channel.id,
        level: rebuildAblationLevel(level, {
          channels: level.channels.filter((candidate) => candidate.id !== channel.id),
        }),
      }));
      continue;
    }
    const targets = channels.filter((candidate) => candidate.id !== channel.id);
    if (targets.length === 0) {
      structuralExemptions.push(`sole-gate-channel:${channel.id}`);
      continue;
    }
    for (const target of targets) {
      const cells = level.cells.map((cell) => {
        const fixture = cell.fixture;
        if (
          fixture === undefined
          || fixture.kind === "disposal"
          || fixture.channel !== channel.id
        ) return cell;
        return { terrain: cell.terrain, fixture: { ...fixture, channel: target.id } };
      });
      proposals.push(Object.freeze({
        id: `channel-merge:${channel.id}->${target.id}`,
        kind: "channel-merge",
        subject: `${channel.id}->${target.id}`,
        level: rebuildAblationLevel(level, {
          channels: level.channels.filter((candidate) => candidate.id !== channel.id),
          cells,
        }),
        channelRewrite: Object.freeze({ from: channel.id, to: target.id }),
      }));
    }
  }

  for (let index = 0; index < level.cells.length; index += 1) {
    const cell = level.cells[index]!;
    if (cell.terrain !== "vacuum" && cell.terrain !== "fracture") continue;
    const position = { x: index % level.width, y: Math.floor(index / level.width) };
    const cells = [...level.cells];
    cells[index] = { terrain: "floor" };
    proposals.push(Object.freeze({
      id: `hazard-neutralize:${position.x},${position.y}`,
      kind: "hazard-neutralize",
      subject: `${position.x},${position.y}`,
      level: rebuildAblationLevel(level, { cells }),
    }));
  }

  const perimeterBulkheads = level.cells.filter((cell, index) => {
    if (cell.terrain !== "bulkhead") return false;
    const x = index % level.width;
    const y = Math.floor(index / level.width);
    return x === 0 || y === 0 || x === level.width - 1 || y === level.height - 1;
  }).length;
  if (perimeterBulkheads > 0) {
    structuralExemptions.push(`exterior-hull-shell:${perimeterBulkheads}-cells`);
  }
  for (const segment of interiorWallSegments(level)) {
    const cells = [...level.cells];
    for (const index of segment.indices) cells[index] = { terrain: "floor" };
    proposals.push(Object.freeze({
      id: `interior-wall-open:${segment.id}`,
      kind: "interior-wall-open",
      subject: segment.id,
      level: rebuildAblationLevel(level, { cells }),
    }));
  }

  return Object.freeze({
    proposals: Object.freeze(proposals),
    structuralExemptions: Object.freeze([...new Set(structuralExemptions)].sort(compareAscii)),
  });
}

/**
 * Greedily retain the first stable simplification which still passes, then
 * enumerate again. A release pass is possible only when the original level is
 * already the fixed point (zero accepted transformations). If a deterministic
 * work bound is exhausted before that exhaustive no-change pass, certification
 * fails closed instead of calling the level essential.
 */
export async function certifyReleaseFixedPointEssentiality(
  initial: ReleaseAblationCandidate,
  options: ReleaseAblationOptions = {},
): Promise<ReleaseAblationReport> {
  const limits = resolveReleaseAblationLimits(options.limits);
  const evaluate = options.evaluate ?? exactReleaseAblationEvaluation;
  let working: ReleaseAblationCandidate = Object.freeze({
    ...initial,
    milestoneSpecs: validateMilestoneSpecs(initial.level, initial.milestoneSpecs),
  });
  let proposalsExamined = 0;
  let exactAnalyses = 0;
  let totalStates = 0;
  let totalTransitions = 0;
  let structuralRejections = 0;
  let rounds = 0;
  const accepted: Array<{ id: string; kind: ReleaseAblationKind; subject: string }> = [];
  const structuralExemptions = new Set<string>();

  const partialReport = (fixedPointReached: boolean): ReleaseAblationReport => Object.freeze({
    essential: accepted.length === 0 && fixedPointReached,
    fixedPointReached,
    rounds,
    proposalsExamined,
    exactAnalyses,
    totalStates,
    totalTransitions,
    accepted: Object.freeze(accepted.map((entry) => Object.freeze({ ...entry }))),
    structuralRejections,
    structuralExemptions: Object.freeze([...structuralExemptions].sort(compareAscii)),
  });
  const exhaust = (reason: string): ReleaseAblationReport => {
    // Once a passing simplification exists the original level is conclusively
    // nonessential, even if the diagnostic walk cannot finish minimizing it.
    if (accepted.length > 0) return partialReport(false);
    throw new ReleaseAblationIncompleteError(reason);
  };

  while (rounds < limits.maxRounds) {
    rounds += 1;
    const inventory = enumerateReleaseAblations(working.level);
    for (const exemption of inventory.structuralExemptions) structuralExemptions.add(exemption);
    let retained: ReleaseAblationCandidate | undefined;
    let retainedProposal: ReleaseAblationProposal | undefined;

    for (const proposal of inventory.proposals) {
      if (proposalsExamined >= limits.maxProposals) {
        return exhaust(`proposal bound ${limits.maxProposals} was reached`);
      }
      proposalsExamined += 1;
      options.onProgress?.(
        `ablation round ${rounds}: ${proposal.kind}:${proposal.subject}`,
      );

      let milestoneSpecs: readonly MilestoneSpec[];
      const levelIssues = validateLevel(proposal.level);
      if (levelIssues.length > 0) {
        structuralRejections += 1;
        continue;
      }
      try {
        milestoneSpecs = validateMilestoneSpecs(
          proposal.level,
          rewriteMilestoneChannels(working.milestoneSpecs, proposal.channelRewrite),
        );
      } catch (reason) {
        // Losing or corrupting an original milestone is a causal-contract
        // failure, not evidence that the simplified puzzle passes.
        if (reason instanceof InvalidMilestoneSpecError) {
          structuralRejections += 1;
          continue;
        }
        throw reason;
      }

      if (exactAnalyses >= limits.maxExactAnalyses) {
        return exhaust(`exact-analysis bound ${limits.maxExactAnalyses} was reached`);
      }
      const remainingStates = limits.maxTotalStates - totalStates;
      const remainingTransitions = limits.maxTotalTransitions - totalTransitions;
      if (remainingStates < 1 || remainingTransitions < 1) {
        return exhaust("cumulative exact state/transition budget was exhausted");
      }
      const candidate: ReleaseAblationCandidate = Object.freeze({
        level: proposal.level,
        difficulty: working.difficulty,
        milestoneSpecs,
        requiredPrecedence: working.requiredPrecedence,
      });
      let evaluation: ReleaseAblationEvaluation;
      try {
        evaluation = await evaluate({
          proposal,
          candidate,
          remainingStates,
          remainingTransitions,
        });
      } catch (reason) {
        if (reason instanceof ReleaseAblationIncompleteError) throw reason;
        throw new ReleaseAblationIncompleteError(
          `${proposal.id} could not be exactly analyzed: ${reason instanceof Error ? reason.message : "unknown error"}`,
        );
      }
      assertAblationEvaluation(evaluation, proposal.id);
      exactAnalyses += 1;
      totalStates += evaluation.states;
      totalTransitions += evaluation.transitions;
      if (totalStates > limits.maxTotalStates || totalTransitions > limits.maxTotalTransitions) {
        return exhaust("an evaluator exceeded the cumulative exact work budget");
      }
      if (evaluation.preservesContract) {
        retained = candidate;
        retainedProposal = proposal;
        accepted.push({ id: proposal.id, kind: proposal.kind, subject: proposal.subject });
        break;
      }
    }

    if (retained === undefined || retainedProposal === undefined) return partialReport(true);
    working = retained;
  }

  return exhaust(`round bound ${limits.maxRounds} was reached`);
}

async function exactReleaseAblationEvaluation(
  context: ReleaseAblationEvaluationContext,
): Promise<ReleaseAblationEvaluation> {
  let analysis;
  try {
    analysis = await analyzeLevel(context.candidate.level, {
      milestoneSpecs: context.candidate.milestoneSpecs,
      requestedDifficulty: context.candidate.difficulty,
      limits: {
        maxStates: Math.min(DEFAULT_ANALYSIS_LIMITS.maxStates, context.remainingStates),
        maxTransitions: Math.min(DEFAULT_ANALYSIS_LIMITS.maxTransitions, context.remainingTransitions),
        maxEstimatedBytes: DEFAULT_ANALYSIS_LIMITS.maxEstimatedBytes,
        cooperateEvery: DEFAULT_ANALYSIS_LIMITS.cooperateEvery,
      },
    });
  } catch (reason) {
    if (reason instanceof AnalysisLimitError) {
      throw new ReleaseAblationIncompleteError(
        `${context.proposal.id} exceeded its exact ${reason.limit} bound`,
      );
    }
    throw reason;
  }

  const fail = (reason: string): ReleaseAblationEvaluation => Object.freeze({
    preservesContract: false,
    reason,
    states: analysis.stateCount,
    transitions: analysis.transitionCount,
  });
  if (!analysis.solvable || analysis.preferredSolution === null || analysis.difficulty === null) {
    return fail("unsolved");
  }
  if (
    !analysis.difficulty.profileMatch
    || analysis.difficulty.ratedDifficulty !== context.candidate.difficulty
  ) {
    return fail("difficulty-band");
  }
  const mandatory = new Set(analysis.milestones.mandatoryIds);
  for (const milestone of context.candidate.milestoneSpecs) {
    if (!mandatory.has(milestone.id)) return fail(`milestone:${milestone.id}`);
  }
  const precedence = new Set(
    analysis.milestones.precedence.map((relation) => `${relation.before}\0${relation.after}`),
  );
  for (const relation of context.candidate.requiredPrecedence) {
    if (!precedence.has(`${relation.before}\0${relation.after}`)) {
      return fail(`precedence:${relation.before}->${relation.after}`);
    }
  }
  const violations = brainQualityViolations({
    level: context.candidate.level,
    difficulty: context.candidate.difficulty,
    analysis,
    milestoneSpecs: context.candidate.milestoneSpecs,
  }, "release");
  if (violations.length > 0) return fail(`quality:${violations[0]!.code}`);
  return Object.freeze({
    preservesContract: true,
    reason: "full-contract-preserved",
    states: analysis.stateCount,
    transitions: analysis.transitionCount,
  });
}

function resolveReleaseAblationLimits(
  input: Partial<ReleaseAblationLimits> | undefined,
): Readonly<ReleaseAblationLimits> {
  const limits: ReleaseAblationLimits = {
    ...RELEASE_ABLATION_LIMITS,
    ...input,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Release ablation limit ${name} must be a nonnegative safe integer`);
    }
  }
  if (limits.maxRounds < 1) {
    throw new RangeError("Release ablation maxRounds must be at least one");
  }
  return Object.freeze(limits);
}

function assertAblationEvaluation(
  evaluation: ReleaseAblationEvaluation,
  proposalId: string,
): void {
  if (
    typeof evaluation.preservesContract !== "boolean"
    || typeof evaluation.reason !== "string"
    || evaluation.reason.length === 0
    || !Number.isSafeInteger(evaluation.states)
    || evaluation.states < 0
    || !Number.isSafeInteger(evaluation.transitions)
    || evaluation.transitions < 0
  ) {
    throw new ReleaseAblationIncompleteError(`${proposalId} returned an invalid evaluation`);
  }
}

function rebuildAblationLevel(
  level: LevelDefinition,
  replacement: Readonly<{
    channels?: LevelDefinition["channels"];
    cells?: LevelDefinition["cells"];
    objects?: LevelDefinition["objects"];
  }>,
): LevelDefinition {
  return normalizeBrainLevel({
    generatorVersion: level.generatorVersion,
    width: level.width,
    height: level.height,
    channels: replacement.channels ?? level.channels,
    cells: replacement.cells ?? level.cells,
    playerStart: level.playerStart,
    objects: replacement.objects ?? level.objects,
  }, "releaseAblation.level");
}

function rewriteMilestoneChannels(
  specs: readonly MilestoneSpec[],
  rewrite: ReleaseAblationProposal["channelRewrite"],
): readonly MilestoneSpec[] {
  if (rewrite === undefined) return specs;
  return specs.map((spec) => rewriteChannelJson(spec, rewrite) as unknown as MilestoneSpec);
}

function rewriteChannelJson(
  value: unknown,
  rewrite: Readonly<{ from: string; to: string }>,
  parentKey?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => rewriteChannelJson(child, rewrite));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      rewriteChannelJson(child, rewrite, key),
    ]));
  }
  if (
    typeof value === "string"
    && value === rewrite.from
    && (parentKey === "channel" || parentKey === "channelActive" || parentKey === "channelInactive")
  ) return rewrite.to;
  return value;
}

function interiorWallSegments(
  level: LevelDefinition,
): readonly Readonly<{ id: string; indices: readonly number[] }>[] {
  const horizontal: Array<{ id: string; indices: number[] }> = [];
  const vertical: Array<{ id: string; indices: number[] }> = [];
  const covered = new Set<number>();
  for (let y = 1; y < level.height - 1; y += 1) {
    let x = 1;
    while (x < level.width - 1) {
      if (level.cells[y * level.width + x]?.terrain !== "bulkhead") {
        x += 1;
        continue;
      }
      const start = x;
      const indices: number[] = [];
      while (x < level.width - 1 && level.cells[y * level.width + x]?.terrain === "bulkhead") {
        indices.push(y * level.width + x);
        x += 1;
      }
      if (indices.length > 1) {
        for (const index of indices) covered.add(index);
        horizontal.push({ id: `h:${start},${y}-${x - 1},${y}`, indices });
      }
    }
  }
  for (let x = 1; x < level.width - 1; x += 1) {
    let y = 1;
    while (y < level.height - 1) {
      if (level.cells[y * level.width + x]?.terrain !== "bulkhead") {
        y += 1;
        continue;
      }
      const start = y;
      const indices: number[] = [];
      while (y < level.height - 1 && level.cells[y * level.width + x]?.terrain === "bulkhead") {
        indices.push(y * level.width + x);
        y += 1;
      }
      if (indices.length > 1) {
        for (const index of indices) covered.add(index);
        vertical.push({ id: `v:${x},${start}-${x},${y - 1}`, indices });
      }
    }
  }
  const singletons: Array<{ id: string; indices: number[] }> = [];
  for (let y = 1; y < level.height - 1; y += 1) {
    for (let x = 1; x < level.width - 1; x += 1) {
      const index = y * level.width + x;
      if (level.cells[index]?.terrain === "bulkhead" && !covered.has(index)) {
        singletons.push({ id: `cell:${x},${y}`, indices: [index] });
      }
    }
  }
  return Object.freeze([...horizontal, ...vertical, ...singletons].map((segment) => Object.freeze({
    id: segment.id,
    indices: Object.freeze(segment.indices),
  })));
}

function parseCandidateEntry(value: unknown, index: number): CandidateEntry {
  if (!isRecord(value)) throw new Error(`Candidate entry ${index} must be an object`);
  if (!isBrainEntryId(value.id)) throw new Error(`Candidate entry ${index} has invalid id`);
  if (!Number.isInteger(value.difficulty) || (value.difficulty as number) < 0 || (value.difficulty as number) > 8) {
    throw new Error(`${value.id}: invalid difficulty`);
  }
  if (!isRecord(value.level)) throw new Error(`${value.id}: missing level`);
  if (
    !Array.isArray(value.witness)
    || value.witness.length > MAX_BRAIN_WITNESS_ACTIONS
    || !value.witness.every(isDirection)
  ) {
    throw new Error(`${value.id}: invalid witness`);
  }
  if (!Array.isArray(value.milestones)) throw new Error(`${value.id}: invalid milestones`);
  const requiredPrecedence = value.requiredPrecedence;
  if (!Array.isArray(requiredPrecedence)) throw new Error(`${value.id}: invalid requiredPrecedence`);
  const parsedPrecedence = requiredPrecedence.map((relation) => {
    if (!isRecord(relation) || !validToken(relation.before, 48) || !validToken(relation.after, 48)) {
      throw new Error(`${value.id}: invalid precedence relation`);
    }
    return Object.freeze({ before: relation.before, after: relation.after });
  });
  if (!validToken(value.topologySignature, 160)) {
    throw new Error(`${value.id}: invalid topology signature`);
  }
  if (!validToken(value.semanticSignature, 160)) {
    throw new Error(`${value.id}: invalid semantic signature`);
  }
  if (!isRecord(value.provenance)) {
    throw new Error(`${value.id}: invalid provenance`);
  }
  return {
    id: value.id,
    difficulty: value.difficulty as number,
    level: normalizeBrainLevel(value.level, `${value.id}.level`),
    witness: Object.freeze([...(value.witness as Direction[])]),
    milestones: Object.freeze([...(value.milestones as MilestoneSpec[])]),
    requiredPrecedence: Object.freeze(parsedPrecedence),
    topologySignature: value.topologySignature,
    semanticSignature: value.semanticSignature,
    provenance: parseCandidateProvenance(value.provenance, value.id),
  };
}

function parseCandidateProvenance(value: Readonly<Record<string, unknown>>, id: string): BrainProvenance {
  const masterSeed = value.masterSeed;
  const candidateId = value.candidateId;
  const algorithmVersion = value.algorithmVersion;
  const reverseDepth = value.reverseDepth;
  if (
    typeof masterSeed !== "string"
    || !/^[0-9a-f]{16,64}$/.test(masterSeed)
    || !validToken(candidateId, 80)
    || !/^[a-zA-Z0-9._-]+$/.test(candidateId)
    || !validToken(algorithmVersion, 80)
    || !/^[a-zA-Z0-9._-]+$/.test(algorithmVersion)
    || !Number.isSafeInteger(reverseDepth)
    || (reverseDepth as number) < 0
    || (value.generatedAt !== undefined && typeof value.generatedAt !== "string")
  ) {
    throw new Error(`${id}: invalid provenance fields`);
  }
  return Object.freeze({
    masterSeed,
    candidateId,
    algorithmVersion,
    reverseDepth: reverseDepth as number,
    ...(typeof value.generatedAt === "string" ? { generatedAt: value.generatedAt } : {}),
  });
}

function assertPrecedenceContract(entry: CandidateEntry): void {
  if (entry.requiredPrecedence.length === 0) {
    throw new Error(`${entry.id}: requiredPrecedence must contain the intended causal edges`);
  }
  const milestoneIds = new Set(entry.milestones.map((milestone) => milestone.id));
  const outgoing = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const relation of entry.requiredPrecedence) {
    if (!milestoneIds.has(relation.before) || !milestoneIds.has(relation.after)) {
      throw new Error(`${entry.id}: precedence references an unknown milestone`);
    }
    if (relation.before === relation.after) throw new Error(`${entry.id}: precedence contains a self edge`);
    const key = `${relation.before}\0${relation.after}`;
    if (seen.has(key)) throw new Error(`${entry.id}: precedence contains a duplicate edge`);
    seen.add(key);
    const targets = outgoing.get(relation.before) ?? [];
    targets.push(relation.after);
    outgoing.set(relation.before, targets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`${entry.id}: requiredPrecedence is cyclic`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of outgoing.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of milestoneIds) visit(id);
}

function deriveTopologySignature(level: LevelDefinition): string {
  return sha256Hex(encodeUtf8(JSON.stringify([
    level.width,
    level.height,
    level.cells.map((cell) => cell.terrain),
    level.cells.map((cell) => cell.fixture?.kind ?? null),
  ]))).slice(0, 20);
}

function deriveSemanticSignature(levelHash: string): string {
  return levelHash.slice(0, 20);
}

/** Dihedral-board canonicalization with channel and gameplay-id renaming. */
function deriveEquivalenceSignature(level: LevelDefinition): string {
  const channelIds = level.channels.map((channel) => channel.id).sort(compareAscii);
  const channelOrders = permutations(channelIds);
  const forms: string[] = [];
  for (let symmetry = 0; symmetry < 8; symmetry += 1) {
    for (const channelOrder of channelOrders) {
      const channelIndex = new Map(channelOrder.map((id, index) => [id, index]));
      const transformedCells = level.cells.map((cell, index) => {
        const position = { x: index % level.width, y: Math.floor(index / level.width) };
        const transformed = transformCoord(position.x, position.y, level.width, level.height, symmetry);
        const fixture = cell.fixture;
        const fixtureValue = fixture === undefined
          ? null
          : fixture.kind === "disposal"
          ? [fixture.kind]
          : fixture.kind === "relay"
          ? [fixture.kind, channelIndex.get(fixture.channel), fixture.initialOn ? 1 : 0]
          : fixture.kind === "socket"
          ? [fixture.kind, channelIndex.get(fixture.channel), fixture.initiallyInstalled ? 1 : 0]
          : [fixture.kind, channelIndex.get(fixture.channel)];
        return [transformed.y, transformed.x, cell.terrain, fixtureValue] as const;
      }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
      const player = transformCoord(
        level.playerStart.x,
        level.playerStart.y,
        level.width,
        level.height,
        symmetry,
      );
      const objects = level.objects.map((object) => {
        const position = transformCoord(
          object.position.x,
          object.position.y,
          level.width,
          level.height,
          symmetry,
        );
        return [object.kind, position.y, position.x] as const;
      }).sort((left, right) => (
        compareAscii(left[0], right[0]) || left[1] - right[1] || left[2] - right[2]
      ));
      const dimensions = transformedDimensions(level.width, level.height, symmetry);
      forms.push(JSON.stringify([
        dimensions.width,
        dimensions.height,
        transformedCells.map((entry) => [entry[2], entry[3]]),
        [player.x, player.y],
        objects,
      ]));
    }
  }
  forms.sort(compareAscii);
  return sha256Hex(encodeUtf8(forms[0]!));
}

function transformCoord(
  x: number,
  y: number,
  width: number,
  height: number,
  symmetry: number,
): Readonly<{ x: number; y: number }> {
  const reflectedX = symmetry >= 4 ? width - 1 - x : x;
  switch (symmetry % 4) {
    case 0: return { x: reflectedX, y };
    case 1: return { x: height - 1 - y, y: reflectedX };
    case 2: return { x: width - 1 - reflectedX, y: height - 1 - y };
    default: return { x: y, y: width - 1 - reflectedX };
  }
}

function transformedDimensions(
  width: number,
  height: number,
  symmetry: number,
): Readonly<{ width: number; height: number }> {
  return symmetry % 2 === 0 ? { width, height } : { width: height, height: width };
}

function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length < 2) return [Object.freeze([...values])];
  const result: T[][] = [];
  const visit = (prefix: T[], remaining: T[]): void => {
    if (remaining.length === 0) {
      result.push(prefix);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      visit(
        [...prefix, remaining[index]!],
        [...remaining.slice(0, index), ...remaining.slice(index + 1)],
      );
    }
  };
  visit([], [...values]);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validToken(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBrainEntryId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(value);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDirection(value: unknown): value is Direction {
  return value === "N" || value === "E" || value === "S" || value === "W";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const release = args.includes("--release");
  const allowPartial = args.includes("--allow-partial");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const inputPath = resolve(positional[0] ?? "./src/generated/hullshiftbrain.g4.catalog.json");
  const outputPath = check
    ? undefined
    : resolve(positional[1] ?? "./src/generated/hullshiftbrain.g4.catalog.json");
  const productionCatalogPath = resolve("./src/generated/hullshiftbrain.g4.catalog.json");
  if (allowPartial && outputPath === productionCatalogPath) {
    throw new Error("--allow-partial requires an explicit non-production output path");
  }
  const catalog = await certifyBrainCatalogFile(inputPath, outputPath, {
    allowPartial,
    checkStored: check,
    qualityMode: release ? "release" : "pilot",
    onProgress: (message) => console.log(message),
  });
  console.log(
    `Certified ${catalog.entries.length} HullshiftBrain entries across ${new Set(catalog.entries.map((entry) => entry.difficulty)).size} bands`,
  );
}

if (import.meta.main) {
  await main();
}
