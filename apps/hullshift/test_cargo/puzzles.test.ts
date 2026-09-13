import { describe, expect, test } from "bun:test";
import { CARGO_DIFFICULTIES, cargoAnalysis, generateCargoPuzzle, measureCargoRoute, solveCargo } from "../src/cargo_puzzles.ts";
import { createCargoHint } from "../src/cargo_hints.ts";
import { generateLevel } from "../src/generator.ts";
import { analyzeLevel } from "../src/solver.ts";
import { validateLevel } from "../src/mechanics.ts";
import { canonicalLevelHash, createInitialSnapshot, resolveDirectionalAction } from "../src/simulation.ts";
import type { LevelDefinition } from "../src/model.ts";

function board(rows: string[]): LevelDefinition {
  const width = Math.max(7, rows[0]!.length);
  rows = rows.map((row) => row.padEnd(width, "#"));
  while (rows.length < 7) rows.push("#".repeat(width));
  const cells: LevelDefinition["cells"][number][] = [];
  const objects: LevelDefinition["objects"][number][] = [];
  let playerStart = { x: 0, y: 0 };
  rows.forEach((row, y) => [...row].forEach((char, x) => {
    if (char === "@") playerStart = { x, y };
    if (char === "$") objects.push({ id: `cargo-${objects.length + 1}`, kind: "cargo", position: { x, y } });
    cells.push({ terrain: char === "#" ? "bulkhead" : "floor", ...(char === "." ? { fixture: { kind: "plate", id: `bay-${x}-${y}`, channel: "cargo" } } : {}) });
  }));
  return { generatorVersion: "g5", objective: "cargo", width: rows[0]!.length, height: rows.length, cells, objects, playerStart, channels: [{ id: "cargo", symbol: "◇" }] };
}

/** Compare architecture after all rotations/reflections, ignoring occupants. */
function shape(level: LevelDefinition): string {
  let grid = Array.from({ length: level.height }, (_, y) => level.cells.slice(y * level.width, (y + 1) * level.width).map((c) => c.terrain === "bulkhead" ? "#" : " "));
  const keys: string[] = [];
  for (let turn = 0; turn < 4; turn++) {
    keys.push(grid.map((row) => row.join("")).join("\n"), grid.map((row) => [...row].reverse().join("")).join("\n"));
    grid = Array.from({ length: grid[0]!.length }, (_, x) => grid.map((row) => row[x]!).reverse());
  }
  return keys.sort()[0]!;
}

describe("procedural cargo puzzles", () => {
  test("different seeds change the puzzle architecture at every difficulty; all solutions replay", async () => {
    const means: { pushes: number; lines: number; detours: number; search: number }[] = [];
    for (let difficulty = 0; difficulty <= 8; difficulty++) {
      const shapes = new Set<string>(); const hashes = new Set<string>(); const styles = new Set<string>();
      let pushes = 0; let lines = 0; let detours = 0; let search = 0;
      for (let i = 0; i < 12; i++) {
        const { level, analysis } = await generateCargoPuzzle(BigInt(1001 + i), difficulty);
        expect(validateLevel(level)).toEqual([]);
        expect(level.objects.length).toBe(CARGO_DIFFICULTIES[difficulty]!.boxes);
        const route = measureCargoRoute(level, analysis.preferredSolution!.actions);
        expect(route.movedBoxes).toBe(level.objects.length);
        expect(route.pushes).toBe(analysis.optimalPushes!);
        expect(analysis.cargo?.searchComplete).toBe(true);
        expect(analysis.winningStateKeys.size).toBe(0);
        shapes.add(shape(level)); hashes.add(canonicalLevelHash(level)); styles.add(analysis.cargo!.layout);
        pushes += route.pushes; lines += route.boxLines; detours += route.detours; search += analysis.stateCount;
      }
      expect(hashes.size).toBe(12);
      expect(shapes.size).toBeGreaterThanOrEqual(11);
      expect(styles.size).toBeGreaterThanOrEqual(2);
      means.push({ pushes: pushes / 12, lines: lines / 12, detours: detours / 12, search: search / 12 });
    }
    expect(means[4]!.lines).toBeGreaterThan(means[1]!.lines * 1.5);
    expect(means[8]!.pushes).toBeGreaterThan(means[3]!.pushes * 1.4);
    expect(means[8]!.detours).toBeGreaterThan(0.8);
    expect(means[8]!.search).toBeGreaterThan(means[4]!.search * 2);
    console.log("Cargo corpus: 108 distinct puzzles; difficulty means", means);
  }, 180000);

  test("g5 identity is deterministic, uses all seed bits, and ignores scheduling", async () => {
    const request = { generatorVersion: "g5" as const, seed: "ffffffffabcd1234", difficulty: 2 };
    const first = await generateLevel(request);
    const second = await generateLevel(request, { yieldControl: async () => { await Promise.resolve(); } });
    expect(first.identity.generatorVersion).toBe("g5");
    expect(first.levelHash).toBe("e82f13df94aa38b0a745a0c663f568f7af548992e4c1515f457ed1861f80d84f");
    expect(first.shareCode).toBe("HS1-G5-D2-Sffffffffabcd1234-Cc0cc2865");
    expect(first.levelHash).toBe(second.levelHash);
    expect(first.shareCode).toBe(second.shareCode);
    expect(first.analysis.preferredSolution).toEqual(second.analysis.preferredSolution);
    const other = await generateLevel({ ...request, seed: "00000000abcd1234" });
    expect(other.levelHash).not.toBe(first.levelHash);
  });

  test("cancellation stops generation between candidates", async () => {
    let cancelled = false;
    await expect(generateCargoPuzzle(1n, 8, { shouldCancel: () => cancelled, yieldControl: async () => { cancelled = true; } })).rejects.toThrow(/cancelled/);
  });
});

test("a bay needs cargo, a push wins, and pushing into a corner remains undoable ordinary play", async () => {
  const level = board(["######", "#@ $.#", "#    #", "######"]);
  let snapshot = createInitialSnapshot(level);
  expect(snapshot.derived.sources.every((s) => !s.active)).toBe(true);
  snapshot = resolveDirectionalAction(level, snapshot, "E").after;
  snapshot = resolveDirectionalAction(level, snapshot, "E").after;
  expect(snapshot.outcome.kind).toBe("victory");
  const playerOnBay = { ...level, playerStart: { x: 4, y: 1 } };
  expect(createInitialSnapshot(playerOnBay).derived.sources[0]!.active).toBe(false);
  const stuck = board(["######", "# $@.#", "#    #", "######"]);
  const pushed = resolveDirectionalAction(stuck, createInitialSnapshot(stuck), "W");
  expect(pushed.after.outcome.kind).toBe("playing");
  const solution = await solveCargo({ ...stuck, objects: pushed.after.state.objects, playerStart: pushed.after.state.player! });
  expect(solution).toMatchObject({ actions: null, complete: true });
});

test("hints search the current arrangement, distinguish a dead end from unfinished search, and never change the board", async () => {
  const level = board(["#######", "#     #", "# @$ .#", "#     #", "#######"]);
  const initial = createInitialSnapshot(level);
  const snapshot = resolveDirectionalAction(level, initial, "S").after;
  const before = structuredClone(snapshot);
  const hint = await createCargoHint(level, snapshot, ["E", "E"], 2, (position) => solveCargo(position));
  expect(hint.kind).toBe("hint");
  if (hint.kind === "hint") { expect(hint.pair).not.toBeNull(); expect(hint.message).toContain("push"); }
  expect(snapshot).toEqual(before);
  const unknown = await createCargoHint(level, snapshot, [], 1, async () => ({ actions: null, pushes: null, complete: false, explored: 1 }));
  expect(unknown.kind).toBe("unavailable");
  const stuck = await createCargoHint(level, snapshot, [], 1, async () => ({ actions: null, pushes: null, complete: true, explored: 1 }));
  expect(stuck.kind).toBe("rewind");
});

test("search exhaustion is not advertised as an exact solution or a deadlock", async () => {
  const level = board(["######", "#@ $.#", "#    #", "######"]);
  const solution = await solveCargo(level, {}, 0);
  expect(solution).toMatchObject({ actions: null, complete: false });
  const analysis = cargoAnalysis(level, solution, 0);
  expect(analysis.solvable).toBe(false);
  expect(analysis.optimalPushes).toBeNull();
});

test("push-space search agrees with independent exhaustive engine analysis", async () => {
  for (const seed of [31n, 47n, 89n]) {
    const { level, analysis } = await generateCargoPuzzle(seed, 1);
    const exhaustive = await analyzeLevel(level);
    expect(exhaustive.solvable).toBe(true);
    expect(analysis.optimalPushes).toBe(exhaustive.optimalPushes);
  }
}, 30000);
