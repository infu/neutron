import { expect, test } from "bun:test";
import { HullshiftResident, type ResidentSave } from "../src/resident.ts";
import { GeneratorWorkerClient } from "../src/generator_client.ts";
import { analyzeLevel } from "../src/solver.ts";
import { canonicalLevelHash, createInitialSnapshot, resolveDirectionalAction } from "../src/simulation.ts";
import { createMemoryPersistence, type PersistedEnvelope } from "../src/persistence.ts";
import { deserializeAnalysis, serializeAnalysis } from "../src/worker_protocol.ts";
import type { LevelDefinition } from "../src/model.ts";
import releasedSave from "./fixtures/released-g4-save.json";

class LegacyAnalysisWorker extends GeneratorWorkerClient {
  constructor() { super(""); }
  override async analyze(level: LevelDefinition) { return deserializeAnalysis(serializeAnalysis(await analyzeLevel(level))); }
}

test("a save written by released 0.2.6 restores its exact board, history and settings, then undoes and finishes", async () => {
  // Captured using unmodified production source at 5500eea, before g5 existed.
  const envelope = releasedSave as unknown as PersistedEnvelope<ResidentSave>;
  const persistence = createMemoryPersistence<ResidentSave>();
  await persistence.save(envelope);
  const resident = new HullshiftResident({ persistence, worker: new LegacyAnalysisWorker() });
  await resident.initialize();
  let run = resident.snapshot("legacy-test").activeRun!;
  expect(run.levelHash).toBe("2d23cefe0306b6328b8c521e6ff5517b00e728141e94e4009c32d44dd4ddac2b");
  expect(canonicalLevelHash(run.level)).toBe(run.levelHash);
  expect(run.snapshot).toEqual(envelope.payload.runs[0]!.snapshot);
  expect(run.cursor).toBe(3);
  expect(resident.snapshot("legacy-test").settings).toEqual(envelope.payload.settings);
  const result = await resident.undo("legacy-test", run.id, run.revision);
  expect(result.ok).toBe(true);
  run = result.snapshot.activeRun!;
  let replay = createInitialSnapshot(run.level);
  for (const action of run.analysis.preferredSolution!.actions.slice(0, 2)) replay = resolveDirectionalAction(run.level, replay, action).after;
  expect(run.snapshot).toEqual(replay);
  for (const direction of run.analysis.preferredSolution!.actions.slice(2)) {
    const result = await resident.action("legacy-test", run.id, run.revision, direction);
    expect(result.ok).toBe(true);
    run = result.snapshot.activeRun!;
  }
  expect(run.snapshot.outcome.kind).toBe("victory");
  const restored = new HullshiftResident({ persistence, worker: new LegacyAnalysisWorker() });
  await restored.initialize();
  expect(restored.snapshot("legacy-test").activeRun!.snapshot).toEqual(run.snapshot);
});
