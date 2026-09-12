import type { Direction, LevelDefinition, PuzzleState } from "./model.ts";
import { DIRECTION_ORDER } from "./model.ts";
import { canonicalStateKey, createInitialSnapshot, resolveDirectionalAction } from "./simulation.ts";
import { DEFAULT_ANALYSIS_LIMITS, type AnalysisReport, type SolverHooks } from "./solver.ts";

/** Procedural Sokoban: random architecture, reverse play, then push-space search. */
export const CARGO_DIFFICULTIES = [
  { name: "First shift", description: "One pod. Learn to get on the right side.", boxes: 1, width: 7, height: 7, pushes: 3, lines: 2 },
  { name: "Finding space", description: "Two pods and room to experiment.", boxes: 2, width: 7, height: 7, pushes: 5, lines: 3 },
  { name: "Around the bend", description: "Turn corners and plan your approach.", boxes: 2, width: 8, height: 7, pushes: 8, lines: 4 },
  { name: "Shared quarters", description: "Three pods compete for the same space.", boxes: 3, width: 8, height: 8, pushes: 11, lines: 5 },
  { name: "Working backwards", description: "Think about the last push before the first.", boxes: 3, width: 9, height: 8, pushes: 14, lines: 7 },
  { name: "Traffic control", description: "Park, make room, and come back later.", boxes: 4, width: 9, height: 9, pushes: 18, lines: 8 },
  { name: "Tight squeeze", description: "Small passages. Carefully ordered moves.", boxes: 4, width: 10, height: 9, pushes: 22, lines: 10 },
  { name: "Deep thought", description: "Five pods and overlapping plans.", boxes: 5, width: 10, height: 10, pushes: 26, lines: 12 },
  { name: "Master shift", description: "Six pods. Find room for the whole plan.", boxes: 6, width: 11, height: 10, pushes: 30, lines: 14 },
] as const;

type Grid = { width: number; height: number; floor: Uint8Array; goals: number[]; layout: string };
type Position = { boxes: number[]; player: number };
type SearchNode = Position & { cost: number; heuristic: number; parent: SearchNode | null; from: number; direction: number };
export type CargoSolution = { actions: Direction[] | null; pushes: number | null; complete: boolean; explored: number };
export type CargoRoute = { pushes: number; boxLines: number; turns: number; revisits: number; detours: number; movedBoxes: number };
type Candidate = { level: LevelDefinition; witness: Direction[]; layout: string };
const OPPOSITE = [2, 3, 0, 1] as const;

class Random {
  private a: number;
  private b: number;
  private c = 0x9e3779b9;
  private d = 1;
  constructor(seed: bigint) {
    this.a = Number(seed & 0xffffffffn) ^ 0x85ebca6b;
    this.b = Number(seed >> 32n) ^ 0xc2b2ae35;
    for (let i = 0; i < 20; i++) this.next();
  }
  next(): number {
    const t = ((this.a + this.b) | 0) + this.d | 0;
    this.d = this.d + 1 | 0;
    this.a = this.b ^ this.b >>> 9;
    this.b = this.c + (this.c << 3) | 0;
    this.c = (this.c << 21 | this.c >>> 11) + t | 0;
    return (t >>> 0) / 4294967296;
  }
  int(max: number): number { return Math.floor(this.next() * max); }
  shuffle<T>(input: readonly T[]): T[] {
    const result = [...input];
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  }
}

function offsets(grid: Grid): readonly number[] { return [-grid.width, 1, grid.width, -1]; }
function onFloor(grid: Grid, at: number): boolean { return grid.floor[at] === 1; }

function flood(grid: Grid, player: number, boxes: readonly number[]): { seen: Uint8Array; min: number; previous: Int16Array } {
  const seen = new Uint8Array(grid.floor.length);
  const blocked = new Set(boxes);
  const previous = new Int16Array(grid.floor.length).fill(-1);
  const queue = [player];
  const steps = offsets(grid);
  seen[player] = 1;
  let min = player;
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!;
    if (at < min) min = at;
    for (let dir = 0; dir < 4; dir++) {
      const next = at + steps[dir]!;
      if (!onFloor(grid, next) || seen[next] || blocked.has(next)) continue;
      seen[next] = 1;
      previous[next] = dir;
      queue.push(next);
    }
  }
  return { seen, min, previous };
}

function walk(grid: Grid, player: number, target: number, boxes: readonly number[]): Direction[] {
  if (player === target) return [];
  const { seen, previous } = flood(grid, player, boxes);
  if (!seen[target]) throw new Error("Cargo route has an unreachable walking segment");
  const path: Direction[] = [];
  const steps = offsets(grid);
  for (let at = target; at !== player;) {
    const dir = previous[at]!;
    path.push(DIRECTION_ORDER[dir]!);
    at -= steps[dir]!;
  }
  return path.reverse();
}

function fromLevel(level: LevelDefinition): Grid {
  return {
    width: level.width, height: level.height,
    floor: Uint8Array.from(level.cells, (cell) => cell.terrain === "floor" ? 1 : 0),
    goals: level.cells.flatMap((cell, i) => cell.fixture?.kind === "plate" ? [i] : []),
    layout: "Cargo deck",
  };
}

function createLevel(grid: Grid, position: Position): LevelDefinition {
  const coord = (at: number) => ({ x: at % grid.width, y: Math.floor(at / grid.width) });
  return {
    generatorVersion: "g5", objective: "cargo", width: grid.width, height: grid.height,
    channels: [{ id: "cargo", symbol: "◇" }],
    cells: Array.from(grid.floor, (floor, i) => ({
      terrain: floor ? "floor" as const : "bulkhead" as const,
      ...(grid.goals.includes(i) ? { fixture: { kind: "plate" as const, id: `bay-${grid.goals.indexOf(i) + 1}`, channel: "cargo" } } : {}),
    })),
    playerStart: coord(position.player),
    objects: position.boxes.map((at, i) => ({ id: `cargo-${i + 1}`, kind: "cargo", position: coord(at) })),
  };
}

/** Layouts vary their actual walkable graph; no completed puzzle templates. */
function architecture(random: Random, difficulty: number): Grid | null {
  const profile = CARGO_DIFFICULTIES[difficulty]!;
  const transpose = random.int(2) === 0;
  const width = (transpose ? profile.height : profile.width) + (difficulty > 1 ? random.int(2) : 0);
  const height = transpose ? profile.width : profile.height;
  const floor = new Uint8Array(width * height);
  const style = random.int(4);
  const labels = ["Freight quarters", "Split-level depot", "Service passages", "Orbital workshop"];
  const grid: Grid = { width, height, floor, goals: [], layout: labels[style]! };
  const density = 0.14 + random.next() * 0.15;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) floor[y * width + x] = random.next() > density ? 1 : 0;
  }
  if (style === 1) {
    // A dividing wall with separately placed passages creates ordering choices.
    const x = 2 + random.int(width - 4);
    for (let y = 1; y < height - 1; y++) floor[y * width + x] = 0;
    for (const y of random.shuffle(Array.from({ length: height - 2 }, (_, i) => i + 1)).slice(0, 2)) {
      floor[y * width + x] = 1;
      floor[y * width + x - 1] = 1;
      floor[y * width + x + 1] = 1;
    }
  } else if (style === 2) {
    // Staggered wall fingers make narrow turning areas without a fixed route.
    for (let y = 2; y < height - 2; y += 2) {
      const left = random.int(2) === 0;
      const length = 1 + random.int(Math.max(1, width - 5));
      for (let j = 0; j < length; j++) floor[y * width + (left ? j + 1 : width - j - 2)] = 0;
    }
  } else if (style === 3 && width > 7) {
    const x = 2 + random.int(width - 5);
    const y = 2 + random.int(height - 4);
    floor[y * width + x] = 0;
    floor[y * width + x + 1] = 0;
  }
  // Keep the largest connected floor component, not isolated decorative rooms.
  let largest: number[] = [];
  const examined = new Set<number>();
  for (let i = 0; i < floor.length; i++) {
    if (!floor[i] || examined.has(i)) continue;
    const reached = flood(grid, i, []).seen;
    const component: number[] = [];
    for (let j = 0; j < reached.length; j++) if (reached[j]) { examined.add(j); component.push(j); }
    if (component.length > largest.length) largest = component;
  }
  floor.fill(0);
  for (const i of largest) floor[i] = 1;
  if (largest.length < profile.boxes * 5 + 8) return null;
  const steps = offsets(grid);
  const pullable = largest.filter((at) => steps.some((step) => onFloor(grid, at + step) && onFloor(grid, at + step * 2)));
  if (pullable.length < profile.boxes + 3) return null;
  const nearWall = random.next() < 0.45;
  const ordered = random.shuffle(pullable).sort((a, b) => nearWall
    ? steps.filter((step) => !onFloor(grid, b + step)).length - steps.filter((step) => !onFloor(grid, a + step)).length
    : 0);
  grid.goals = ordered.slice(0, profile.boxes).sort((a, b) => a - b);
  return grid;
}

function goalDistances(grid: Grid): Int16Array[] {
  const steps = offsets(grid);
  return grid.goals.map((goal) => {
    const distances = new Int16Array(grid.floor.length).fill(-1);
    const queue = [goal];
    distances[goal] = 0;
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      for (const step of steps) {
        const next = at + step;
        if (distances[next] !== -1 || !onFloor(grid, next) || !onFloor(grid, next + step)) continue;
        distances[next] = distances[at]! + 1;
        queue.push(next);
      }
    }
    return distances;
  });
}

function assignmentDistance(boxes: readonly number[], distances: readonly Int16Array[]): number {
  const size = 1 << boxes.length;
  const costs = new Float64Array(size).fill(Infinity);
  costs[0] = 0;
  for (let mask = 0; mask < size; mask++) {
    if (!Number.isFinite(costs[mask])) continue;
    let box = 0;
    for (let n = mask; n; n &= n - 1) box++;
    if (box >= boxes.length) continue;
    for (let goal = 0; goal < boxes.length; goal++) {
      if (mask & (1 << goal)) continue;
      const distance = distances[goal]![boxes[box]!]!;
      if (distance < 0) continue;
      const next = mask | (1 << goal);
      costs[next] = Math.min(costs[next]!, costs[mask]! + distance);
    }
  }
  return costs[size - 1]!;
}

function reversePlay(grid: Grid, random: Random, difficulty: number): Candidate | null {
  const free = Array.from(grid.floor.keys()).filter((i) => grid.floor[i] && !grid.goals.includes(i));
  const steps = offsets(grid);
  const distances = goalDistances(grid);
  let best: { position: Position; actions: Direction[]; score: number } | null = null;
  for (let trial = 0; trial < 5; trial++) {
    let position: Position = { boxes: [...grid.goals], player: free[random.int(free.length)]! };
    const actions: Direction[] = [];
    const visited = new Set<string>();
    let lastBox = -1;
    for (let turn = 0; turn < 35 + difficulty * 14; turn++) {
      const reach = flood(grid, position.player, position.boxes);
      const choices: { position: Position; box: number; direction: number; stand: number; key: string; score: number }[] = [];
      for (let box = 0; box < position.boxes.length; box++) {
        const at = position.boxes[box]!;
        for (let direction = 0; direction < 4; direction++) {
          const stand = at + steps[direction]!;
          const player = stand + steps[direction]!;
          if (!reach.seen[stand] || !onFloor(grid, player) || position.boxes.includes(player)) continue;
          const boxes = [...position.boxes];
          boxes[box] = stand;
          const nextReach = flood(grid, player, boxes);
          const key = [...boxes].sort((a, b) => a - b).join(",") + ":" + nextReach.min;
          if (visited.has(key)) continue;
          const distance = assignmentDistance(boxes, distances);
          choices.push({ position: { boxes, player }, box, direction, stand, key,
            score: distance * 0.35 + random.next() * (5 + difficulty) + (lastBox !== box ? 0.7 : 0) });
        }
      }
      if (choices.length === 0) break;
      choices.sort((a, b) => b.score - a.score);
      const choice = choices[0]!;
      actions.push(...walk(grid, position.player, choice.stand, position.boxes), DIRECTION_ORDER[choice.direction]!);
      position = choice.position;
      lastBox = choice.box;
      visited.add(choice.key);
      const offGoals = position.boxes.filter((at) => !grid.goals.includes(at)).length;
      const distance = assignmentDistance(position.boxes, distances);
      const score = distance * 2 + offGoals * 4;
      if (offGoals === grid.goals.length && score > (best?.score ?? -1)) {
        best = { position: { boxes: [...position.boxes], player: position.player }, actions: [...actions], score };
      }
    }
  }
  if (best === null) return null;
  const witness = best.actions.reverse().map((action) => DIRECTION_ORDER[OPPOSITE[DIRECTION_ORDER.indexOf(action)]!]!);
  return { level: createLevel(grid, best.position), witness, layout: grid.layout };
}

class Heap {
  private nodes: SearchNode[] = [];
  get size(): number { return this.nodes.length; }
  private before(a: SearchNode, b: SearchNode): boolean {
    return a.cost + a.heuristic < b.cost + b.heuristic
      || (a.cost + a.heuristic === b.cost + b.heuristic && a.heuristic < b.heuristic);
  }
  push(node: SearchNode): void {
    let at = this.nodes.length;
    this.nodes.push(node);
    while (at > 0) {
      const parent = (at - 1) >>> 1;
      if (!this.before(node, this.nodes[parent]!)) break;
      this.nodes[at] = this.nodes[parent]!; at = parent;
    }
    this.nodes[at] = node;
  }
  pop(): SearchNode {
    const first = this.nodes[0]!;
    const last = this.nodes.pop()!;
    if (!this.nodes.length) return first;
    let at = 0;
    while (at * 2 + 1 < this.nodes.length) {
      let child = at * 2 + 1;
      if (child + 1 < this.nodes.length && this.before(this.nodes[child + 1]!, this.nodes[child]!)) child++;
      if (!this.before(this.nodes[child]!, last)) break;
      this.nodes[at] = this.nodes[child]!; at = child;
    }
    this.nodes[at] = last;
    return first;
  }
}

/** A* in push space. Walking regions and indistinguishable crates share a key. */
export async function solveCargo(level: LevelDefinition, hooks: SolverHooks = {}, maxStates: number = DEFAULT_ANALYSIS_LIMITS.maxStates): Promise<CargoSolution> {
  const grid = fromLevel(level);
  const steps = offsets(grid);
  const distances = goalDistances(grid);
  const goals = new Set(grid.goals);
  const dead = grid.floor.map((floor, at) => floor && distances.every((distance) => distance[at]! < 0) ? 1 : 0);
  const start: SearchNode = {
    boxes: level.objects.map((object) => object.position.y * grid.width + object.position.x).sort((a, b) => a - b),
    player: level.playerStart.y * grid.width + level.playerStart.x,
    cost: 0, heuristic: 0, parent: null, from: -1, direction: -1,
  };
  start.heuristic = assignmentDistance(start.boxes, distances);
  if (!Number.isFinite(start.heuristic)) return { actions: null, pushes: null, complete: true, explored: 0 };
  const heap = new Heap(); heap.push(start);
  const visited = new Map<string, number>();
  let explored = 0;
  while (heap.size && explored < maxStates) {
    if (hooks.shouldCancel?.()) throw new Error("Cargo puzzle search cancelled");
    const node = heap.pop();
    const reach = flood(grid, node.player, node.boxes);
    const key = node.boxes.join(",") + ":" + reach.min;
    if ((visited.get(key) ?? Infinity) <= node.cost) continue;
    visited.set(key, node.cost); explored++;
    if (node.heuristic === 0) {
      const path: SearchNode[] = [];
      for (let cursor: SearchNode | null = node; cursor.parent; cursor = cursor.parent) path.push(cursor);
      const actions: Direction[] = [];
      for (const step of path.reverse()) {
        const parent = step.parent!;
        actions.push(...walk(grid, parent.player, step.from - steps[step.direction]!, parent.boxes), DIRECTION_ORDER[step.direction]!);
      }
      return { actions, pushes: node.cost, complete: true, explored };
    }
    for (let box = 0; box < node.boxes.length; box++) {
      const at = node.boxes[box]!;
      for (let direction = 0; direction < 4; direction++) {
        const next = at + steps[direction]!;
        if (!reach.seen[at - steps[direction]!] || !onFloor(grid, next) || dead[next] || node.boxes.includes(next)) continue;
        const boxes = [...node.boxes]; boxes[box] = next; boxes.sort((a, b) => a - b);
        // A filled 2x2 square with an undocked crate cannot be moved again.
        const occupied = (p: number) => !onFloor(grid, p) || boxes.includes(p);
        if ([0, -1, -grid.width, -grid.width - 1].some((offset) => {
          const square = [next + offset, next + offset + 1, next + offset + grid.width, next + offset + grid.width + 1];
          return square.every(occupied) && square.some((p) => boxes.includes(p) && !goals.has(p));
        })) continue;
        const heuristic = assignmentDistance(boxes, distances);
        if (!Number.isFinite(heuristic)) continue;
        heap.push({ boxes, player: at, cost: node.cost + 1, heuristic, parent: node, from: at, direction });
      }
    }
    if (explored % DEFAULT_ANALYSIS_LIMITS.cooperateEvery === 0) await hooks.yieldControl?.();
  }
  return { actions: null, pushes: null, complete: heap.size === 0, explored };
}

/** Measure the actual forward route, not the length of the reverse scramble. */
export function measureCargoRoute(level: LevelDefinition, actions: readonly Direction[]): CargoRoute {
  let state = createInitialSnapshot(level);
  const grid = fromLevel(level);
  const distances = goalDistances(grid);
  const moved = new Set<string>();
  const directions = new Map<string, Direction>();
  let lastBox = ""; let lastDirection: Direction | null = null;
  let pushes = 0; let boxLines = 0; let turns = 0; let revisits = 0; let detours = 0;
  const distance = (snapshot: typeof state) => assignmentDistance(snapshot.state.objects.map((o) => o.position.y * level.width + o.position.x), distances);
  for (const action of actions) {
    const result = resolveDirectionalAction(level, state, action);
    if (!result.accepted) throw new Error("Generated cargo solution does not replay");
    const pushed = result.events.find((event) => event.type === "object-pushed");
    if (pushed?.type === "object-pushed") {
      pushes++;
      if (pushed.objectId !== lastBox || action !== lastDirection) boxLines++;
      if (pushed.objectId !== lastBox && moved.has(pushed.objectId)) revisits++;
      if (directions.has(pushed.objectId) && directions.get(pushed.objectId) !== action) turns++;
      if (distance(result.after) >= distance(state)) detours++;
      moved.add(pushed.objectId); directions.set(pushed.objectId, action);
      lastBox = pushed.objectId; lastDirection = action;
    }
    state = result.after;
    // Reverse walks can have a harmless tail after the last cargo delivery.
    if (state.outcome.kind === "victory") break;
  }
  if (state.outcome.kind !== "victory") throw new Error("Generated cargo route does not finish the puzzle");
  return { pushes, boxLines, turns, revisits, detours, movedBoxes: moved.size };
}

function trimVictory(level: LevelDefinition, actions: readonly Direction[]): Direction[] {
  let snapshot = createInitialSnapshot(level);
  const result: Direction[] = [];
  for (const action of actions) {
    const transition = resolveDirectionalAction(level, snapshot, action);
    if (!transition.accepted) throw new Error("Reverse-generated route is invalid");
    result.push(action); snapshot = transition.after;
    if (snapshot.outcome.kind === "victory") return result;
  }
  throw new Error("Reverse-generated route has no victory");
}

export function cargoAnalysis(level: LevelDefinition, solution: CargoSolution, difficulty: number, layout = "Cargo deck", witness?: readonly Direction[]): AnalysisReport {
  const actions = solution.actions ?? (witness ? trimVictory(level, witness) : null);
  const metrics = actions ? measureCargoRoute(level, actions) : { pushes: 0, boxLines: 0, turns: 0, revisits: 0, detours: 0, movedBoxes: 0 };
  const rating = { requestedDifficulty: difficulty, ratedDifficulty: difficulty, profileMatch: true, hardViolations: [], targetDistance: 0,
    challengeScore: metrics.boxLines + metrics.turns * 2 + metrics.revisits * 3 + metrics.detours * 2 };
  return {
    cargo: { layout, boxLines: metrics.boxLines, turns: metrics.turns, revisits: metrics.revisits, detours: metrics.detours, searchComplete: solution.complete },
    solvable: actions !== null, initialStateKey: canonicalStateKey(createInitialSnapshot(level).state),
    winningStateKeys: new Set(), fatalFrontier: [],
    preferredSolution: actions ? { actions, pushes: metrics.pushes, totalActions: actions.length, commitments: metrics.boxLines } : null,
    optimalActions: null, optimalPushes: solution.actions ? solution.pushes : null,
    retainedNearOptimalSolutions: [], stateCount: solution.explored, transitionCount: 0,
    physicalFailureTransitionCount: 0, victoryTransitionCount: actions ? 1 : 0, estimatedBytes: 0,
    limits: DEFAULT_ANALYSIS_LIMITS,
    milestones: { mandatoryIds: [], precedence: [], dependencyDepth: 0, planningHorizon: 0, crossMechanicCoupling: 0 },
    features: { commitments: metrics.boxLines, dependencyDepth: 0, planningHorizon: 0, interleaving: metrics.revisits,
      irreversibility: 0, decisionPressure: 0, crossMechanicCoupling: 0, stateSpaceComplexity: 0, fatalChoicePressure: 0, mechanicFamilies: 1 },
    difficulty: rating,
  };
}

export async function generateCargoPuzzle(seed: bigint, difficulty: number, hooks: SolverHooks = {}): Promise<{ level: LevelDefinition; analysis: AnalysisReport }> {
  const random = new Random(seed ^ (BigInt(difficulty) << 48n));
  const profile = CARGO_DIFFICULTIES[difficulty]!;
  let best: { level: LevelDefinition; analysis: AnalysisReport; score: number } | null = null;
  for (let attempt = 0; attempt < (difficulty < 3 ? 64 : 280); attempt++) {
    if (hooks.shouldCancel?.()) throw new Error("Cargo puzzle generation cancelled");
    await hooks.yieldControl?.();
    const grid = architecture(random, difficulty);
    if (!grid) continue;
    const candidate = reversePlay(grid, random, difficulty);
    if (!candidate) continue;
    const solution = await solveCargo(candidate.level, hooks, 1200 + difficulty * 1500);
    if (!solution.actions) continue;
    const analysis = cargoAnalysis(candidate.level, solution, difficulty, candidate.layout, candidate.witness);
    const metrics = analysis.cargo!;
    // A long corridor or a long random scramble is not a difficult puzzle.
    // Prefer real changes of side, crate ordering, and temporary displacement.
    const pushes = analysis.preferredSolution!.pushes;
    const score = Math.min(pushes / profile.pushes, 1.5) * 2
      + Math.min(metrics.boxLines / profile.lines, 1.5) * 3
      + Math.min(metrics.turns, 6) * 0.4 + Math.min(metrics.revisits, 6) * 0.3
      + Math.min(metrics.detours, 2 + difficulty) * 3 + Math.log2(1 + solution.explored) * 0.7;
    if (best === null || score > best.score) best = { level: candidate.level, analysis, score };
    if (solution.actions && pushes >= profile.pushes && metrics.boxLines >= profile.lines
      && metrics.turns >= Math.min(2, difficulty + 1)
      && metrics.detours >= Math.max(0, Math.floor((difficulty - 1) / 2))) break;
  }
  if (!best) throw new Error("Could not build this cargo deck. Try another seed.");
  return { level: best.level, analysis: best.analysis };
}

export function cargoLevelAtState(level: LevelDefinition, state: PuzzleState): LevelDefinition {
  if (state.player === null) throw new Error("Cannot solve a puzzle without a player");
  return { ...level, playerStart: state.player, objects: state.objects };
}
