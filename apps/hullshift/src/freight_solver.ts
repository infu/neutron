import { deriveMechanics } from "./mechanics.ts";
import { DIRECTION_ORDER, type Direction, type EngineSnapshot, type LevelDefinition } from "./model.ts";
import { canonicalStateKey, createInitialSnapshot, resolveDirectionalAction } from "./simulation.ts";
import { DEFAULT_ANALYSIS_LIMITS, type SolverHooks } from "./solver.ts";
import type { FreightSolution } from "./freight_puzzles.ts";

type Node = { snapshot: EngineSnapshot; parent: Node | null; action: Direction | null; cost: number; priority: number };
class Queue {
  nodes: Node[] = [];
  push(node: Node): void {
    let i = this.nodes.length; this.nodes.push(node);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.nodes[parent]!.priority <= node.priority) break;
      this.nodes[i] = this.nodes[parent]!; i = parent;
    }
    this.nodes[i] = node;
  }
  pop(): Node {
    const first = this.nodes[0]!, last = this.nodes.pop()!;
    if (this.nodes.length) {
      let i = 0;
      while (i * 2 + 1 < this.nodes.length) {
        let next = i * 2 + 1;
        if (next + 1 < this.nodes.length && this.nodes[next + 1]!.priority < this.nodes[next]!.priority) next++;
        if (last.priority <= this.nodes[next]!.priority) break;
        this.nodes[i] = this.nodes[next]!; i = next;
      }
      this.nodes[i] = last;
    }
    return first;
  }
}

/** Full-state search: relay parity, installed cells, lost objects and collapsed
 * floors are part of each node. Rejoining a replayed route accelerates hints
 * without assuming the player's different arrangement has the same solution.
 * Weighted search returns a usable route, never a claim of an optimal one.
 */
export async function solveFreight(level: LevelDefinition, start: EngineSnapshot = createInitialSnapshot(level), knownRoute: readonly Direction[] = [], hooks: SolverHooks = {}, maxStates: number = DEFAULT_ANALYSIS_LIMITS.maxStates): Promise<FreightSolution> {
  if (start.outcome.kind !== "playing") return { actions: start.outcome.kind === "victory" ? [] : null, complete: true, explored: 0 };
  start = { ...start, derived: deriveMechanics(level, start.state) };
  const routes = new Map<string, readonly Direction[]>();
  let replay = createInitialSnapshot(level);
  for (let i = 0; i < knownRoute.length; i++) {
    routes.set(canonicalStateKey(replay.state), knownRoute.slice(i));
    const step = resolveDirectionalAction(level, replay, knownRoute[i]!);
    if (!step.accepted) { routes.clear(); break; }
    replay = step.after;
  }
  if (replay.outcome.kind !== "victory") routes.clear();
  const goals = level.cells.flatMap((cell, i) => cell.fixture?.kind === "bay" ? [i] : []);
  const steps = [-level.width, 1, level.width, -1];
  const floor = (i: number) => i >= 0 && i < level.cells.length && level.cells[i]!.terrain !== "bulkhead"
    && (level.cells[i]!.terrain !== "vacuum" || level.cells[i]!.fixture?.kind === "bridge") && level.cells[i]!.fixture?.kind !== "disposal";
  // Relax circuits and one-way floors, but retain walls and required space
  // behind a pod. This catches permanent dead corners even with spare cargo.
  const distances = goals.map((goal) => {
    const distance = new Int16Array(level.cells.length).fill(-1), queue = [goal]; distance[goal] = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const p = queue[cursor]!;
      for (const delta of steps) {
        const next = p + delta;
        if (floor(next) && floor(next + delta) && distance[next] === -1) { distance[next] = distance[p]! + 1; queue.push(next); }
      }
    }
    return distance;
  });
  function estimate(snapshot: EngineSnapshot): number {
    const boxes = snapshot.state.objects.filter((o) => o.kind === "cargo").map((o) => o.position.y * level.width + o.position.x);
    if (boxes.length < goals.length) return Infinity;
    let costs = new Map<number, number>([[0, 0]]);
    for (const distance of distances) {
      const next = new Map<number, number>();
      for (const [mask, cost] of costs) for (let b = 0; b < boxes.length; b++) {
        const d = distance[boxes[b]!]!;
        if ((mask & (1 << b)) || d < 0) continue;
        const key = mask | (1 << b), value = cost + d;
        if (value < (next.get(key) ?? Infinity)) next.set(key, value);
      }
      costs = next;
    }
    return Math.min(...costs.values());
  }
  const heuristic = estimate(start);
  if (!Number.isFinite(heuristic)) return { actions: null, complete: true, explored: 0 };
  const queue = new Queue(), seen = new Map<string, number>();
  const scheduled = new Map<string, number>([[canonicalStateKey(start.state), 0]]);
  queue.push({ snapshot: start, parent: null, action: null, cost: 0, priority: heuristic * 3 });
  let explored = 0, transitions = 0, bytes = canonicalStateKey(start.state).length * 2 + 1024;
  while (queue.nodes.length && explored < maxStates && transitions < DEFAULT_ANALYSIS_LIMITS.maxTransitions && bytes < DEFAULT_ANALYSIS_LIMITS.maxEstimatedBytes) {
    if (hooks.shouldCancel?.()) throw new Error("Freight hint search cancelled");
    const node = queue.pop(), key = canonicalStateKey(node.snapshot.state);
    if ((seen.get(key) ?? Infinity) <= node.cost) continue;
    seen.set(key, node.cost); explored++;
    const tail = routes.get(key);
    if (node.snapshot.outcome.kind === "victory" || tail) {
      const actions: Direction[] = [];
      for (let n = node; n.action !== null; n = n.parent!) actions.push(n.action);
      return { actions: [...actions.reverse(), ...(tail ?? [])], complete: true, explored };
    }
    for (const direction of DIRECTION_ORDER) {
      const result = resolveDirectionalAction(level, node.snapshot, direction); transitions++;
      if (!result.accepted || (result.after.outcome.kind !== "playing" && result.after.outcome.kind !== "victory")) continue;
      const after = result.after;
      const afterKey = canonicalStateKey(after.state);
      if ((scheduled.get(afterKey) ?? Infinity) <= node.cost + 1) continue;
      const h = result.pushed ? estimate(after) : estimate(node.snapshot);
      if (!Number.isFinite(h)) continue;
      // Apply the existing search budget to allocations, including queued
      // snapshots, rather than counting only nodes already expanded.
      bytes += afterKey.length * 2 + 1024;
      if (bytes >= DEFAULT_ANALYSIS_LIMITS.maxEstimatedBytes || scheduled.size >= maxStates) return { actions: null, complete: false, explored };
      scheduled.set(afterKey, node.cost + 1);
      queue.push({ snapshot: after, parent: node, action: direction, cost: node.cost + 1, priority: node.cost + 1 + h * 3 });
    }
    if (explored % DEFAULT_ANALYSIS_LIMITS.cooperateEvery === 0) {
      hooks.onProgress?.({ stage: "analysis-enumeration", completed: explored, total: maxStates, detail: "Looking for a route from your current deck" });
      await hooks.yieldControl?.();
    }
  }
  return { actions: null, complete: queue.nodes.length === 0, explored };
}
