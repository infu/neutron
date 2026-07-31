import {
  MAX_COMMANDS_PER_RUN,
  MAX_COMPLETION_SUMMARIES,
  MAX_SAVED_RUNS,
  assertEnvelope,
  createEnvelope,
  createIndexedDbPersistence,
  createMemoryPersistence,
  type HullshiftPersistence,
} from "./persistence.ts";
import {
  canonicalLevelHash,
  createInitialSnapshot,
  resolveDirectionalAction,
} from "./simulation.ts";
import { validateLevel } from "./mechanics.ts";
import type {
  Direction,
  EngineEvent,
  EngineSnapshot,
  LevelDefinition,
} from "./model.ts";
import {
  GenerationCancelledError,
  GeneratorWorkerClient,
} from "./generator_client.ts";
import type {
  SerializedAnalysis,
  SerializedGeneratedLevel,
} from "./worker_protocol.ts";
import type { GenerationProgress } from "./generator.ts";
import { isMeaningfulDecisionTransition } from "./solver.ts";
import { encodeShareCode } from "./share_code.ts";
import { parseCanonicalSeed } from "./prng.ts";
import { mechanicReferencesForLevel } from "./mechanic_reference.ts";
import { createSolverHint, type HintResponse, type HintTier } from "./hints.ts";
import { evaluateDifficulty } from "./difficulty.ts";
import {
  getTrainingDefinition,
  TRAINING_IDS,
  type TrainingId,
} from "./training.ts";

export const HULLSHIFT_STATE_TOPIC = "hullshift.state";
export const CHECKPOINT_INTERVAL = 32;

export type HullshiftSettings = {
  sound: boolean;
  reducedMotion: "system" | "on" | "off";
  skipKnownBriefings: boolean;
};

export type RunStatistics = {
  acceptedActions: number;
  pushes: number;
  commitments: number;
  rewinds: number;
  restarts: number;
  hints: number;
};

export type AnalysisSummary = Omit<SerializedAnalysis, "winningStateKeys">;

export type RunCheckpoint = {
  cursor: number;
  snapshot: EngineSnapshot;
  pushes: number;
  commitments: number;
  lastEvents: readonly EngineEvent[];
};

export type SavedRun = {
  saveVersion: 1;
  id: string;
  trainingId: TrainingId | null;
  revision: number;
  identity: SerializedGeneratedLevel["identity"];
  levelHash: string;
  shareCode: string;
  level: LevelDefinition;
  analysis: AnalysisSummary;
  difficulty: SerializedGeneratedLevel["difficulty"];
  initialSnapshot: EngineSnapshot;
  snapshot: EngineSnapshot;
  commands: Direction[];
  cursor: number;
  checkpoints: RunCheckpoint[];
  statistics: RunStatistics;
  lastEvents: readonly EngineEvent[];
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type CompletionSummary = {
  runId: string;
  levelHash: string;
  shareCode: string;
  difficulty: number;
  acceptedActions: number;
  pushes: number;
  rewinds: number;
  completedAt: number;
};

export type ResidentSave = {
  serviceRevision: number;
  runs: SavedRun[];
  tileBindings: Record<string, string>;
  settings: HullshiftSettings;
  learnedMechanics: string[];
  completions: CompletionSummary[];
};

export type GenerationJob = {
  id: string;
  ownerTileId: string;
  seed: string;
  difficulty: number;
  state: "running" | "cancelling" | "complete" | "cancelled" | "error";
  progress: GenerationProgress | null;
  error: string | null;
  runId: string | null;
};

export type RunSummary = {
  id: string;
  trainingId: TrainingId | null;
  revision: number;
  seed: string;
  difficulty: number;
  ratedDifficulty: number;
  outcome: EngineSnapshot["outcome"];
  acceptedActions: number;
  pushes: number;
  updatedAt: number;
  completedAt: number | null;
};

export type RunView = Omit<SavedRun, "commands" | "checkpoints"> & {
  canUndo: boolean;
  optimalActions: number | null;
  optimalPushes: number | null;
};

export type ResidentSnapshot = {
  serviceRevision: number;
  storage: {
    mode: "persistent" | "volatile";
    error: string | null;
  };
  settings: HullshiftSettings;
  learnedMechanics: readonly string[];
  runs: readonly RunSummary[];
  activeRunId: string | null;
  activeRun: RunView | null;
  generation: GenerationJob | null;
};

export type Conflict = {
  scope: "service" | "run";
  expectedRevision: number;
  actualRevision: number;
};

export type ResidentResult =
  | {
      ok: true;
      snapshot: ResidentSnapshot;
      accepted?: boolean;
      pushed?: boolean;
      events?: readonly EngineEvent[];
      hint?: HintResponse;
    }
  | {
      ok: false;
      conflict: Conflict;
      snapshot: ResidentSnapshot;
    };

type ResidentOptions = {
  persistence?: HullshiftPersistence<ResidentSave>;
  worker?: GeneratorWorkerClient;
  now?: () => number;
  onInvalidate?: (revision: number) => void | Promise<void>;
};

const DEFAULT_SETTINGS: HullshiftSettings = {
  sound: true,
  reducedMotion: "system",
  skipKnownBriefings: false,
};

export class HullshiftResident {
  #persistence: HullshiftPersistence<ResidentSave>;
  readonly #worker: GeneratorWorkerClient;
  readonly #now: () => number;
  readonly #onInvalidate: (revision: number) => void | Promise<void>;
  #save: ResidentSave = emptySave();
  #initialized = false;
  #storageMode: "persistent" | "volatile" = "persistent";
  #storageError: string | null = null;
  #generation: GenerationJob | null = null;
  #winningSets = new Map<string, ReadonlySet<string>>();
  #lastProgressPublish = 0;

  constructor(options: ResidentOptions = {}) {
    this.#persistence = options.persistence ?? createIndexedDbPersistence<ResidentSave>();
    this.#worker = options.worker ?? new GeneratorWorkerClient("");
    this.#now = options.now ?? (() => Date.now());
    this.#onInvalidate = options.onInvalidate ?? (() => undefined);
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    if (this.#persistence.kind === "memory") {
      this.#storageMode = "volatile";
      this.#storageError = "Persistent browser storage is unavailable";
    }
    try {
      const loaded = await this.#persistence.load();
      if (loaded !== null) this.#save = validateSave(assertEnvelope<ResidentSave>(loaded).payload);
    } catch (reason) {
      this.#storageMode = "volatile";
      this.#storageError = errorMessage(reason);
      this.#persistence = createMemoryPersistence<ResidentSave>();
      await this.#persistence.save(createEnvelope(this.#save, this.#now()));
    }
  }

  snapshot(tileId: string): ResidentSnapshot {
    assertTileId(tileId);
    const activeRunId = this.#save.tileBindings[tileId] ?? null;
    const activeRun = activeRunId === null
      ? null
      : this.#save.runs.find((run) => run.id === activeRunId) ?? null;
    return {
      serviceRevision: this.#save.serviceRevision,
      storage: { mode: this.#storageMode, error: this.#storageError },
      settings: { ...this.#save.settings },
      learnedMechanics: [...this.#save.learnedMechanics],
      runs: [...this.#save.runs]
        .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
        .map(runSummary),
      activeRunId: activeRun?.id ?? null,
      activeRun: activeRun === null ? null : runView(activeRun),
      generation: this.#generation === null || this.#generation.ownerTileId !== tileId
        ? null
        : structuredClone(this.#generation),
    };
  }

  async startGeneration(
    tileId: string,
    expectedServiceRevision: number,
    seed: string,
    difficulty: number,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    parseCanonicalSeed(seed);
    if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 8) {
      throw new RangeError("Hullshift supports difficulty 0 through 8");
    }
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    if (this.#generation?.state === "running" || this.#generation?.state === "cancelling") {
      throw new Error("Another Hullshift generation job is already active");
    }
    const job: GenerationJob = {
      id: randomIdentifier("gen"),
      ownerTileId: tileId,
      seed,
      difficulty,
      state: "running",
      progress: { stage: "starting", completed: 0, total: 1 },
      error: null,
      runId: null,
    };
    this.#generation = job;
    await this.#commit();
    void this.#performGeneration(job);
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async cancelGeneration(
    tileId: string,
    expectedServiceRevision: number,
    jobId: string,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    const job = this.#generation;
    if (job === null || job.id !== jobId || job.ownerTileId !== tileId) {
      throw new Error("The requested Hullshift generation job is not active for this tile");
    }
    if (job.state !== "running") return { ok: true, snapshot: this.snapshot(tileId) };
    job.state = "cancelling";
    this.#worker.cancel();
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async dismissGeneration(
    tileId: string,
    expectedServiceRevision: number,
    jobId: string,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    const job = this.#generation;
    if (job === null || job.id !== jobId || job.ownerTileId !== tileId) {
      throw new Error("The requested Hullshift generation result is not owned by this tile");
    }
    if (job.state === "running" || job.state === "cancelling") {
      throw new Error("Cancel the active Hullshift generation job before dismissing it");
    }
    this.#generation = null;
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async openRun(
    tileId: string,
    expectedServiceRevision: number,
    runId: string,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    requireRun(this.#save, runId);
    this.#save.tileBindings[tileId] = runId;
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async closeRun(tileId: string, expectedServiceRevision: number): Promise<ResidentResult> {
    assertTileId(tileId);
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    delete this.#save.tileBindings[tileId];
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async startTraining(
    tileId: string,
    expectedServiceRevision: number,
    trainingId: TrainingId,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    const training = getTrainingDefinition(trainingId);
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    if (this.#generation?.state === "running" || this.#generation?.state === "cancelling") {
      throw new Error(this.#generation.ownerTileId === tileId
        ? "Cancel mission generation before opening training"
        : "Another tile is generating a mission; wait for it to finish");
    }

    const existing = this.#save.runs.find((run) => run.trainingId === trainingId);
    if (existing !== undefined) {
      if (existing.snapshot.outcome.kind === "victory") {
        existing.snapshot = structuredClone(existing.initialSnapshot);
        existing.commands = [];
        existing.cursor = 0;
        existing.checkpoints = [{
          cursor: 0,
          snapshot: structuredClone(existing.initialSnapshot),
          pushes: 0,
          commitments: 0,
          lastEvents: [],
        }];
        existing.statistics = { ...emptyStatistics(), restarts: existing.statistics.restarts + 1 };
        existing.lastEvents = [];
        existing.completedAt = null;
        existing.revision += 1;
        existing.updatedAt = this.#now();
      }
      this.#save.tileBindings[tileId] = existing.id;
      await this.#commit();
      return { ok: true, snapshot: this.snapshot(tileId) };
    }
    const serializedAnalysis = await this.#worker.analyze(training.level);
    const lateConflict = this.#serviceConflict(expectedServiceRevision);
    if (lateConflict !== null) return this.#conflict(tileId, lateConflict);
    if (!serializedAnalysis.solvable || !serializedAnalysis.winningStateKeys.includes(serializedAnalysis.initialStateKey)) {
      throw new Error(`${trainingId} failed its exact resident certification`);
    }
    const requestedDifficulty = Math.min(8, Math.max(0, training.order - 1));
    const difficulty = serializedAnalysis.difficulty
      ?? evaluateDifficulty(serializedAnalysis.features, requestedDifficulty);
    const generated: SerializedGeneratedLevel = {
      identity: {
        generatorVersion: "g1",
        seed: training.levelHash.slice(0, 16),
        difficulty: requestedDifficulty,
      },
      level: training.level,
      levelHash: training.levelHash,
      shareCode: "",
      analysis: serializedAnalysis,
      difficulty,
    };
    const run = this.#createRun(generated);
    run.trainingId = trainingId;
    run.shareCode = "";
    this.#pruneForIncomingRun(tileId, trainingId);
    this.#save.runs.push(run);
    this.#save.tileBindings[tileId] = run.id;
    this.#winningSets.set(run.levelHash, new Set(serializedAnalysis.winningStateKeys));
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async action(
    tileId: string,
    runId: string,
    expectedRevision: number,
    direction: Direction,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    assertDirection(direction);
    let run = requireRun(this.#save, runId);
    const conflict = runConflict(run, expectedRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    if (run.snapshot.outcome.kind !== "playing") {
      throw new Error("Undo or restart this mission before moving again");
    }

    const winningStateKeys = await this.#winningSet(run);
    // Analysis yielded to the resident event loop. Re-check the optimistic lock.
    run = requireRun(this.#save, runId);
    const lateConflict = runConflict(run, expectedRevision);
    if (lateConflict !== null) return this.#conflict(tileId, lateConflict);
    const transition = resolveDirectionalAction(run.level, run.snapshot, direction, { winningStateKeys });
    if (!transition.accepted) {
      return {
        ok: true,
        snapshot: this.snapshot(tileId),
        accepted: false,
        pushed: false,
        events: transition.events,
      };
    }
    if (run.cursor >= MAX_COMMANDS_PER_RUN) {
      throw new Error("This mission reached Hullshift's accepted-command safety limit");
    }

    if (run.cursor < run.commands.length) {
      run.commands.splice(run.cursor);
      run.checkpoints = run.checkpoints.filter((checkpoint) => checkpoint.cursor <= run.cursor);
    }
    run.commands.push(direction);
    run.cursor += 1;
    run.snapshot = transition.after;
    run.lastEvents = [...transition.events];
    run.statistics.acceptedActions += 1;
    if (transition.pushed) run.statistics.pushes += 1;
    if (isMeaningfulDecisionTransition(run.level, transition)) run.statistics.commitments += 1;
    if (run.cursor % CHECKPOINT_INTERVAL === 0) {
      run.checkpoints.push({
        cursor: run.cursor,
        snapshot: structuredClone(run.snapshot),
        pushes: run.statistics.pushes,
        commitments: run.statistics.commitments,
        lastEvents: structuredClone(run.lastEvents),
      });
    }
    run.revision += 1;
    run.updatedAt = this.#now();
    if (run.snapshot.outcome.kind === "victory" && run.completedAt === null) {
      run.completedAt = run.updatedAt;
      this.#recordCompletion(run);
    }
    await this.#commit();
    return {
      ok: true,
      snapshot: this.snapshot(tileId),
      accepted: true,
      pushed: transition.pushed,
      events: transition.events,
    };
  }

  async undo(tileId: string, runId: string, expectedRevision: number): Promise<ResidentResult> {
    assertTileId(tileId);
    const run = requireRun(this.#save, runId);
    const conflict = runConflict(run, expectedRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    if (run.cursor === 0) return { ok: true, snapshot: this.snapshot(tileId), accepted: false };
    const abandonedVictoryAt = run.snapshot.outcome.kind === "victory" ? run.completedAt : null;
    run.cursor -= 1;
    const replayed = await this.#replay(run, run.cursor);
    run.snapshot = replayed.snapshot;
    run.lastEvents = replayed.lastEvents;
    run.statistics.acceptedActions = run.cursor;
    run.statistics.pushes = replayed.pushes;
    run.statistics.commitments = replayed.commitments;
    run.statistics.rewinds += 1;
    if (abandonedVictoryAt !== null) {
      run.completedAt = null;
      this.#save.completions = this.#save.completions.filter(
        (completion) => completion.runId !== run.id || completion.completedAt !== abandonedVictoryAt,
      );
    }
    run.revision += 1;
    run.updatedAt = this.#now();
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId), accepted: true, events: [] };
  }

  async restart(tileId: string, runId: string, expectedRevision: number): Promise<ResidentResult> {
    assertTileId(tileId);
    const run = requireRun(this.#save, runId);
    const conflict = runConflict(run, expectedRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    const restarts = run.statistics.restarts + 1;
    run.snapshot = structuredClone(run.initialSnapshot);
    run.commands = [];
    run.cursor = 0;
    run.checkpoints = [{
      cursor: 0,
      snapshot: structuredClone(run.initialSnapshot),
      pushes: 0,
      commitments: 0,
      lastEvents: [],
    }];
    run.statistics = emptyStatistics();
    run.statistics.restarts = restarts;
    run.lastEvents = [];
    run.revision += 1;
    run.updatedAt = this.#now();
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId), accepted: true, events: [] };
  }

  async acknowledgeBriefing(
    tileId: string,
    runId: string,
    expectedRevision: number,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    const run = requireRun(this.#save, runId);
    const conflict = runConflict(run, expectedRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    const learned = new Set(this.#save.learnedMechanics);
    if (run.trainingId === null) {
      for (const mechanic of mechanicReferencesForLevel(run.level)) learned.add(mechanic.key);
    } else {
      for (const card of getTrainingDefinition(run.trainingId).briefing.cards) {
        const referenceKey = trainingMechanicReferenceKey(card.mechanic);
        if (referenceKey !== null) learned.add(referenceKey);
      }
    }
    const next = [...learned].sort();
    if (next.length !== this.#save.learnedMechanics.length) {
      this.#save.learnedMechanics = next;
      await this.#commit();
    }
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async hint(
    tileId: string,
    runId: string,
    expectedRevision: number,
    tier: HintTier,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    if (tier !== 1 && tier !== 2) throw new RangeError("Hullshift hint tier must be 1 or 2");
    let run = requireRun(this.#save, runId);
    const conflict = runConflict(run, expectedRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    const winningStateKeys = await this.#winningSet(run);
    const hint = await createSolverHint(
      run.level,
      run.snapshot,
      { winningStateKeys },
      tier,
    );
    run = requireRun(this.#save, runId);
    const lateConflict = runConflict(run, expectedRevision);
    if (lateConflict !== null) return this.#conflict(tileId, lateConflict);
    if (hint.kind !== "unavailable") {
      run.statistics.hints += 1;
      run.revision += 1;
      run.updatedAt = this.#now();
      await this.#commit();
    }
    return { ok: true, snapshot: this.snapshot(tileId), hint };
  }

  async deleteRun(
    tileId: string,
    runId: string,
    expectedRevision: number,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    const run = requireRun(this.#save, runId);
    const conflict = runConflict(run, expectedRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    this.#save.runs = this.#save.runs.filter((candidate) => candidate.id !== runId);
    for (const [boundTileId, boundRunId] of Object.entries(this.#save.tileBindings)) {
      if (boundRunId === runId) delete this.#save.tileBindings[boundTileId];
    }
    this.#winningSets.delete(run.levelHash);
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async updateSettings(
    tileId: string,
    expectedServiceRevision: number,
    patch: Partial<HullshiftSettings>,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    this.#save.settings = validateSettings({ ...this.#save.settings, ...patch });
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async retryStorage(tileId: string, expectedServiceRevision: number): Promise<ResidentResult> {
    assertTileId(tileId);
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    const persistent = createIndexedDbPersistence<ResidentSave>();
    if (persistent.kind === "memory") throw new Error("Persistent browser storage is unavailable");
    await persistent.save(createEnvelope(this.#save, this.#now()));
    this.#persistence = persistent;
    this.#storageMode = "persistent";
    this.#storageError = null;
    await this.#commit();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  async clearData(
    tileId: string,
    expectedServiceRevision: number,
    confirmation: string,
  ): Promise<ResidentResult> {
    assertTileId(tileId);
    const conflict = this.#serviceConflict(expectedServiceRevision);
    if (conflict !== null) return this.#conflict(tileId, conflict);
    if (confirmation !== "CLEAR HULLSHIFT") throw new Error("Clear-data confirmation did not match");
    this.#worker.cancel();
    this.#generation = null;
    this.#winningSets.clear();
    await this.#persistence.clear();
    const nextRevision = this.#save.serviceRevision + 1;
    this.#save = emptySave();
    this.#save.serviceRevision = nextRevision;
    await this.#persist();
    await this.#notify();
    return { ok: true, snapshot: this.snapshot(tileId) };
  }

  dispose(): void {
    this.#worker.dispose();
  }

  async #performGeneration(job: GenerationJob): Promise<void> {
    try {
      const generated = await this.#worker.generate(job.seed, job.difficulty, (progress) => {
        if (this.#generation !== job || job.state !== "running") return;
        job.progress = progress;
        const now = this.#now();
        if (now - this.#lastProgressPublish >= 200) {
          this.#lastProgressPublish = now;
          this.#save.serviceRevision += 1;
          void this.#notify();
        }
      });
      if (this.#generation !== job) return;
      const run = this.#createRun(generated);
      this.#pruneForIncomingRun(job.ownerTileId, null);
      this.#save.runs.push(run);
      this.#save.tileBindings[job.ownerTileId] = run.id;
      this.#winningSets.set(run.levelHash, new Set(generated.analysis.winningStateKeys));
      job.state = "complete";
      job.progress = { stage: "complete", completed: 1, total: 1 };
      job.runId = run.id;
      await this.#commit();
    } catch (reason) {
      if (this.#generation !== job) return;
      if (reason instanceof GenerationCancelledError) {
        job.state = "cancelled";
        job.error = null;
      } else {
        job.state = "error";
        job.error = "The installed HullshiftBrain catalog failed exact certification. Your current mission is unchanged.";
      }
      await this.#commit();
    }
  }

  /**
   * Starting a mission is never blocked by archive maintenance. Generated
   * missions use last-game retention: an unbound predecessor is replaced only
   * after the new mission has been successfully generated and certified.
   * Runs actively owned by another tile are retained whenever possible.
   */
  #pruneForIncomingRun(ownerTileId: string, trainingId: TrainingId | null): void {
    const protectedRunIds = new Set(
      Object.entries(this.#save.tileBindings)
        .filter(([tileId]) => tileId !== ownerTileId)
        .map(([, runId]) => runId),
    );

    if (trainingId === null) {
      const superseded = this.#save.runs.filter((run) => (
        run.trainingId === null && !protectedRunIds.has(run.id)
      ));
      for (const run of superseded) this.#removeSavedRun(run);
    }

    while (this.#save.runs.length >= MAX_SAVED_RUNS) {
      const oldest = [...this.#save.runs]
        .sort((left, right) => (
          Number(protectedRunIds.has(left.id)) - Number(protectedRunIds.has(right.id))
          || left.updatedAt - right.updatedAt
          || left.createdAt - right.createdAt
          || left.id.localeCompare(right.id)
        ))[0];
      if (oldest === undefined) break;
      this.#removeSavedRun(oldest);
      protectedRunIds.delete(oldest.id);
    }
  }

  #removeSavedRun(run: SavedRun): void {
    this.#save.runs = this.#save.runs.filter((candidate) => candidate.id !== run.id);
    for (const [tileId, runId] of Object.entries(this.#save.tileBindings)) {
      if (runId === run.id) delete this.#save.tileBindings[tileId];
    }
    this.#winningSets.delete(run.levelHash);
  }

  #createRun(generated: SerializedGeneratedLevel): SavedRun {
    const initialSnapshot = createInitialSnapshot(generated.level);
    if (initialSnapshot.outcome.kind !== "playing") {
      throw new Error("Generator returned a terminal initial Hullshift state");
    }
    const { winningStateKeys: _winningStateKeys, ...analysis } = generated.analysis;
    const now = this.#now();
    return {
      saveVersion: 1,
      id: randomIdentifier("run"),
      trainingId: null,
      revision: 0,
      identity: structuredClone(generated.identity),
      levelHash: generated.levelHash,
      shareCode: generated.shareCode || encodeShareCode({
        generatorVersion: generated.identity.generatorVersion,
        seed: parseCanonicalSeed(generated.identity.seed),
        difficulty: generated.identity.difficulty,
      }),
      level: structuredClone(generated.level),
      analysis: structuredClone(analysis),
      difficulty: structuredClone(generated.difficulty),
      initialSnapshot: structuredClone(initialSnapshot),
      snapshot: structuredClone(initialSnapshot),
      commands: [],
      cursor: 0,
      checkpoints: [{
        cursor: 0,
        snapshot: structuredClone(initialSnapshot),
        pushes: 0,
        commitments: 0,
        lastEvents: [],
      }],
      statistics: emptyStatistics(),
      lastEvents: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
  }

  async #winningSet(run: SavedRun): Promise<ReadonlySet<string>> {
    const cached = this.#winningSets.get(run.levelHash);
    if (cached !== undefined) return cached;
    const analysis = await this.#worker.analyze(run.level);
    const winning = new Set(analysis.winningStateKeys);
    this.#winningSets.set(run.levelHash, winning);
    return winning;
  }

  async #replay(run: SavedRun, cursor: number): Promise<{
    snapshot: EngineSnapshot;
    pushes: number;
    commitments: number;
    lastEvents: readonly EngineEvent[];
  }> {
    const winningStateKeys = await this.#winningSet(run);
    const checkpoint = [...run.checkpoints]
      .filter((candidate) => candidate.cursor <= cursor)
      .sort((left, right) => right.cursor - left.cursor)[0] ?? {
        cursor: 0,
        snapshot: run.initialSnapshot,
        pushes: 0,
        commitments: 0,
        lastEvents: [],
      };
    let snapshot = structuredClone(checkpoint.snapshot);
    let pushes = checkpoint.pushes;
    let commitments = checkpoint.commitments;
    let lastEvents = structuredClone(checkpoint.lastEvents);
    for (let index = checkpoint.cursor; index < cursor; index += 1) {
      const direction = run.commands[index];
      if (direction === undefined) throw new Error("Hullshift command history is corrupt");
      const transition = resolveDirectionalAction(run.level, snapshot, direction, { winningStateKeys });
      if (!transition.accepted) throw new Error("Hullshift command history no longer replays exactly");
      snapshot = transition.after;
      if (transition.pushed) pushes += 1;
      if (isMeaningfulDecisionTransition(run.level, transition)) commitments += 1;
      lastEvents = structuredClone(transition.events);
    }
    return { snapshot, pushes, commitments, lastEvents };
  }

  #recordCompletion(run: SavedRun): void {
    this.#save.completions.unshift({
      runId: run.id,
      levelHash: run.levelHash,
      shareCode: run.shareCode,
      difficulty: run.identity.difficulty,
      acceptedActions: run.statistics.acceptedActions,
      pushes: run.statistics.pushes,
      rewinds: run.statistics.rewinds,
      completedAt: run.completedAt!,
    });
    this.#save.completions = this.#save.completions.slice(0, MAX_COMPLETION_SUMMARIES);
    if (run.trainingId !== null) {
      const learned = new Set(this.#save.learnedMechanics);
      for (const mechanic of getTrainingDefinition(run.trainingId).learnedMechanics) {
        learned.add(mechanic);
        const referenceKey = trainingMechanicReferenceKey(mechanic);
        if (referenceKey !== null) learned.add(referenceKey);
      }
      this.#save.learnedMechanics = [...learned].sort();
    }
  }

  #serviceConflict(expectedRevision: number): Conflict | null {
    assertRevision(expectedRevision);
    return expectedRevision === this.#save.serviceRevision
      ? null
      : {
          scope: "service",
          expectedRevision,
          actualRevision: this.#save.serviceRevision,
        };
  }

  #conflict(tileId: string, conflict: Conflict): ResidentResult {
    return { ok: false, conflict, snapshot: this.snapshot(tileId) };
  }

  async #commit(): Promise<void> {
    this.#save.serviceRevision += 1;
    await this.#persist();
    await this.#notify();
  }

  async #persist(): Promise<void> {
    try {
      await this.#persistence.save(createEnvelope(this.#save, this.#now()));
    } catch (reason) {
      const memory = createMemoryPersistence<ResidentSave>();
      await memory.save(createEnvelope(this.#save, this.#now()));
      this.#persistence = memory;
      this.#storageMode = "volatile";
      this.#storageError = errorMessage(reason);
    }
  }

  async #notify(): Promise<void> {
    try {
      await this.#onInvalidate(this.#save.serviceRevision);
    } catch {
      // The authoritative state is committed. Tiles also refresh on mount and poll
      // while a generation job is visible, so an invalidation transport failure
      // must not roll back a valid game turn.
    }
  }
}

function emptySave(): ResidentSave {
  return {
    serviceRevision: 0,
    runs: [],
    tileBindings: {},
    settings: { ...DEFAULT_SETTINGS },
    learnedMechanics: [],
    completions: [],
  };
}

function validateSave(value: ResidentSave): ResidentSave {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.serviceRevision) ||
    value.serviceRevision < 0 ||
    !Array.isArray(value.runs) ||
    value.runs.length > MAX_SAVED_RUNS ||
    typeof value.tileBindings !== "object" ||
    value.tileBindings === null ||
    !Array.isArray(value.learnedMechanics) ||
    !Array.isArray(value.completions) ||
    value.completions.length > MAX_COMPLETION_SUMMARIES
  ) {
    throw new Error("Hullshift local data is corrupt");
  }
  value.settings = validateSettings(value.settings);
  for (const run of value.runs) {
    if (
      typeof run !== "object" || run === null || run.saveVersion !== 1 ||
      typeof run.id !== "string" || !Number.isSafeInteger(run.revision) || run.revision < 0 ||
      !Array.isArray(run.commands) || run.commands.length > MAX_COMMANDS_PER_RUN ||
      !Number.isSafeInteger(run.cursor) || run.cursor < 0 || run.cursor > run.commands.length
    ) {
      throw new Error("A Hullshift mission save is corrupt");
    }
    if ((run as SavedRun).trainingId === undefined) (run as SavedRun).trainingId = null;
    if (run.trainingId !== null && !(TRAINING_IDS as readonly string[]).includes(run.trainingId)) {
      throw new Error("A Hullshift training identity is corrupt");
    }
    if (run.trainingId !== null && run.levelHash !== getTrainingDefinition(run.trainingId).levelHash) {
      throw new Error("A Hullshift training level no longer matches its fixed identity");
    }
    if (validateLevel(run.level).length > 0 || canonicalLevelHash(run.level) !== run.levelHash) {
      throw new Error("A Hullshift mission level failed its canonical hash check");
    }
    if (!run.commands.every((direction) => (["N", "E", "S", "W"] as readonly string[]).includes(direction))) {
      throw new Error("A Hullshift mission command log is corrupt");
    }
  }
  return structuredClone(value);
}

function validateSettings(value: HullshiftSettings): HullshiftSettings {
  if (
    typeof value !== "object" || value === null ||
    typeof value.sound !== "boolean" ||
    !["system", "on", "off"].includes(value.reducedMotion) ||
    typeof value.skipKnownBriefings !== "boolean"
  ) {
    throw new Error("Hullshift settings are invalid");
  }
  return { ...value };
}

function runSummary(run: SavedRun): RunSummary {
  return {
    id: run.id,
    trainingId: run.trainingId,
    revision: run.revision,
    seed: run.identity.seed,
    difficulty: run.identity.difficulty,
    ratedDifficulty: run.difficulty.ratedDifficulty,
    outcome: structuredClone(run.snapshot.outcome),
    acceptedActions: run.statistics.acceptedActions,
    pushes: run.statistics.pushes,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function runView(run: SavedRun): RunView {
  return {
    saveVersion: run.saveVersion,
    id: run.id,
    trainingId: run.trainingId,
    revision: run.revision,
    identity: structuredClone(run.identity),
    levelHash: run.levelHash,
    shareCode: run.shareCode,
    level: structuredClone(run.level),
    analysis: structuredClone(run.analysis),
    difficulty: structuredClone(run.difficulty),
    initialSnapshot: structuredClone(run.initialSnapshot),
    snapshot: structuredClone(run.snapshot),
    cursor: run.cursor,
    statistics: { ...run.statistics },
    lastEvents: structuredClone(run.lastEvents),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    canUndo: run.cursor > 0,
    optimalActions: numericAnalysisValue(run.analysis, "optimalActions"),
    optimalPushes: numericAnalysisValue(run.analysis, "optimalPushes"),
  };
}

function numericAnalysisValue(analysis: AnalysisSummary, key: string): number | null {
  const value = (analysis as unknown as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireRun(save: ResidentSave, runId: string): SavedRun {
  if (!/^[a-z0-9_-]{1,80}$/i.test(runId)) throw new Error("Hullshift run id is invalid");
  const run = save.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) throw new Error("Hullshift mission was not found");
  return run;
}

function runConflict(run: SavedRun, expectedRevision: number): Conflict | null {
  assertRevision(expectedRevision);
  return expectedRevision === run.revision
    ? null
    : { scope: "run", expectedRevision, actualRevision: run.revision };
}

function emptyStatistics(): RunStatistics {
  return { acceptedActions: 0, pushes: 0, commitments: 0, rewinds: 0, restarts: 0, hints: 0 };
}

function trainingMechanicReferenceKey(mechanic: string): string | null {
  if (mechanic === "reactor-cell") return "reactor";
  if (mechanic === "pushing" || mechanic === "blocked-push") return "cargo";
  return ([
    "cargo", "plate", "door", "relay", "socket", "bridge",
    "vacuum", "fracture", "disposal", "gate",
  ] as readonly string[]).includes(mechanic) ? mechanic : null;
}

function randomIdentifier(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function assertTileId(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !/^[a-zA-Z0-9_.:-]+$/.test(value)) {
    throw new Error("Hullshift tile id is invalid");
  }
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Hullshift revision is invalid");
}

function assertDirection(value: Direction): void {
  if (!(["N", "E", "S", "W"] as readonly string[]).includes(value)) {
    throw new Error("Hullshift direction is invalid");
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message.slice(0, 500) : "Hullshift local operation failed";
}
