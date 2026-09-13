import { expect, test } from "bun:test";
import { FREIGHT_DIFFICULTIES, FREIGHT_MECHANISMS, generateFreightPuzzle, traceFreight } from "../src/freight_puzzles.ts";
import { solveFreight } from "../src/freight_solver.ts";
import { createFreightHint } from "../src/freight_hints.ts";
import { bayProgress, validateLevel } from "../src/mechanics.ts";
import { canonicalLevelHash, canonicalStateKey, createInitialSnapshot, resolveDirectionalAction } from "../src/simulation.ts";
import { DIRECTION_ORDER, type LevelDefinition } from "../src/model.ts";
import { generateLevel } from "../src/generator.ts";
import { parseShareCode } from "../src/share_code.ts";
import { HullshiftResident, type ResidentSave } from "../src/resident.ts";
import { GeneratorWorkerClient } from "../src/generator_client.ts";
import { createMemoryPersistence } from "../src/persistence.ts";
import { deserializeAnalysis, serializeAnalysis } from "../src/worker_protocol.ts";

function architecture(level: LevelDefinition): string {
  let grid = Array.from({ length: level.height }, (_, y) => level.cells.slice(y * level.width, (y + 1) * level.width).map((cell) => cell.terrain === "bulkhead" ? "#" : " "));
  const forms: string[] = [];
  for (let i = 0; i < 4; i++) {
    forms.push(grid.map((r) => r.join("")).join("\n"), grid.map((r) => [...r].reverse().join("")).join("\n"));
    grid = Array.from({ length: grid[0]!.length }, (_, x) => grid.map((r) => r[x]!).reverse());
  }
  return forms.sort()[0]!;
}

test("108 procedural systems decks vary geometry and combinations; every requested mechanism participates in a winning route", async () => {
  const means: number[] = [], combinations = new Set<string>();
  for (let difficulty = 0; difficulty <= 8; difficulty++) {
    const shapes = new Set<string>(), hashes = new Set<string>();
    let pushes = 0;
    for (let seed = 300; seed < 312; seed++) {
      const { level, analysis } = await generateFreightPuzzle(BigInt(seed), difficulty);
      expect(validateLevel(level)).toEqual([]);
      const trace = traceFreight(level, analysis.preferredSolution!.actions)!;
      expect(trace).not.toBeNull();
      expect(trace.used.size).toBe(FREIGHT_DIFFICULTIES[difficulty]!.mechanisms);
      expect([...trace.used].sort()).toEqual([...analysis.freight!.mechanisms].sort());
      const final = trace.snapshots.at(-1)!;
      expect(bayProgress(level, final).filled).toBe(bayProgress(level, final).total);
      // Sources start off and power actual crossings. They cannot be decorative
      // switches attached to already-open doors or unreachable spare bridges.
      for (const channel of level.channels) {
        expect(trace.snapshots[0]!.derived.channels.find((c) => c.id === channel.id)?.active).toBe(false);
        const disabled = { ...level, cells: level.cells.map((cell) => cell.fixture && "channel" in cell.fixture && cell.fixture.channel === channel.id && ["plate", "relay", "socket"].includes(cell.fixture.kind) ? { terrain: cell.terrain } : cell) };
        expect(traceFreight(disabled, analysis.preferredSolution!.actions)).toBeNull();
      }
      if (difficulty >= 7) expect([...trace.used].sort()).toEqual([...FREIGHT_MECHANISMS].sort());
      shapes.add(architecture(level)); hashes.add(canonicalLevelHash(level));
      combinations.add([...trace.used].sort().join("+")); pushes += trace.pushes;
    }
    expect(hashes.size).toBe(12); expect(shapes.size).toBeGreaterThanOrEqual(11);
    means.push(pushes / 12);
  }
  expect(combinations.size).toBeGreaterThan(15);
  expect(means[8]!).toBeGreaterThan(means[2]! * 1.5);
  console.log("Systems corpus: 108 solved boards, combinations", combinations.size, "mean pushes", means);
}, 240000);

test("g6 shares reproduce the complete systems layout across schedules and all seed bits", async () => {
  const request = { seed: "ffffffffabcd1234", difficulty: 2 };
  const first = await generateLevel(request);
  const second = await generateLevel(request, { yieldControl: async () => { await Promise.resolve(); } });
  expect(first.identity.generatorVersion).toBe("g6");
  expect(first.levelHash).toBe("de0e4cd5c3fc14caa2c65b733d26fcc80592c6272451ce7238657fe8747c08b7");
  expect(first.shareCode).toBe("HS1-G6-D2-Sffffffffabcd1234-Cf9b48525");
  expect(first.levelHash).toBe(second.levelHash);
  expect(first.analysis.preferredSolution).toEqual(second.analysis.preferredSolution);
  expect(parseShareCode(first.shareCode).generatorVersion).toBe("g6");
  expect((await generateLevel({ ...request, seed: "00000000abcd1234" })).levelHash).not.toBe(first.levelHash);
  let cancel = false;
  await expect(generateLevel(request, { shouldCancel: () => cancel, yieldControl: async () => { cancel = true; } })).rejects.toThrow(/cancelled/);
});

test("full-state hints preserve installed reactors, relay parity, fractures and removals when the player leaves the known route", async () => {
  const { level, analysis } = await generateFreightPuzzle(123n, 7);
  const route = analysis.preferredSolution!.actions;
  const trace = traceFreight(level, route)!;
  const keys = new Set(trace.snapshots.map((s) => canonicalStateKey(s.state)));
  const tested = new Set<string>();
  for (const snapshot of trace.snapshots) {
    const features = [snapshot.state.installedCells.length ? "reactor" : "", snapshot.state.activeRelayIds.length ? "relay" : "", snapshot.state.collapsedFractures.length ? "fracture" : "", snapshot.state.removedObjectIds.length ? "disposal" : ""].filter((f) => f && !tested.has(f));
    if (!features.length || snapshot.outcome.kind !== "playing") continue;
    for (const direction of DIRECTION_ORDER) {
      const detour = resolveDirectionalAction(level, snapshot, direction);
      if (!detour.accepted || detour.pushed || detour.after.outcome.kind !== "playing" || keys.has(canonicalStateKey(detour.after.state))) continue;
      const opposite = DIRECTION_ORDER[(DIRECTION_ORDER.indexOf(direction) + 2) % 4]!;
      if (canonicalStateKey(resolveDirectionalAction(level, detour.after, opposite).after.state) !== canonicalStateKey(snapshot.state)) continue;
      const before = structuredClone(detour.after);
      const solved = await solveFreight(level, detour.after, route, {}, 5000);
      expect(solved.actions).not.toBeNull();
      expect(traceFreight(level, solved.actions!, detour.after)).not.toBeNull();
      const hint = await createFreightHint(level, detour.after, route, 2, async () => solved);
      expect(hint.kind).toBe("hint");
      expect(detour.after).toEqual(before);
      features.forEach((f) => tested.add(f)); break;
    }
  }
  expect([...tested].sort()).toEqual(["disposal", "fracture", "reactor", "relay"]);
  const initial = createInitialSnapshot(level);
  const unfinished = await solveFreight(level, initial, [], {}, 0);
  expect(unfinished).toMatchObject({ actions: null, complete: false });
  expect((await createFreightHint(level, initial, [], 1, async () => unfinished)).kind).toBe("unavailable");
}, 60000);

test("new saves and undo restore every mechanism's state, then finish after a reload", async () => {
  const generated = await generateLevel({ seed: "000000000000007b", difficulty: 7 });
  class Worker extends GeneratorWorkerClient {
    constructor() { super(""); }
    override async generate() { return { ...generated, analysis: deserializeAnalysis(serializeAnalysis(generated.analysis)) }; }
  }
  const persistence = createMemoryPersistence<ResidentSave>();
  let resident = new HullshiftResident({ persistence, worker: new Worker() });
  await resident.initialize();
  await resident.startGeneration("systems-test", 0, generated.identity.seed, 7);
  while (!resident.snapshot("systems-test").activeRun) await new Promise((r) => setTimeout(r, 1));
  let run = resident.snapshot("systems-test").activeRun!;
  const checked = new Set<string>();
  for (const direction of generated.analysis.preferredSolution!.actions) {
    const before = run.snapshot;
    const result = await resident.action("systems-test", run.id, run.revision, direction);
    expect(result.ok).toBe(true); run = result.snapshot.activeRun!;
    const effects = result.ok ? result.events?.filter((e) => ["relay-toggled", "socket-docked", "fracture-collapsed", "object-removed", "channel-changed"].includes(e.type)) ?? [] : [];
    if (effects.some((e) => !checked.has(e.type))) {
      const after = run.snapshot;
      const undo = await resident.undo("systems-test", run.id, run.revision);
      expect(undo.snapshot.activeRun!.snapshot).toEqual(before);
      run = undo.snapshot.activeRun!;
      run = (await resident.action("systems-test", run.id, run.revision, direction)).snapshot.activeRun!;
      expect(run.snapshot).toEqual(after);
      resident = new HullshiftResident({ persistence, worker: new Worker() });
      await resident.initialize(); run = resident.snapshot("systems-test").activeRun!;
      expect(run.snapshot).toEqual(after);
      effects.forEach((e) => checked.add(e.type));
    }
  }
  expect(checked.size).toBe(5); expect(run.snapshot.outcome.kind).toBe("victory");
}, 30000);
