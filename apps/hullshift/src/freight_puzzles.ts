import { generateCargoPuzzle } from "./cargo_puzzles.ts";
import { objectAt, validateLevel } from "./mechanics.ts";
import { DIRECTION_DELTAS, DIRECTION_ORDER, type CellDefinition, type Coord, type Direction, type EngineSnapshot, type FixtureDefinition, type LevelDefinition } from "./model.ts";
import { canonicalStateKey, createInitialSnapshot, resolveDirectionalAction } from "./simulation.ts";
import { DEFAULT_ANALYSIS_LIMITS, type AnalysisReport, type SolverHooks } from "./solver.ts";

export const FREIGHT_MECHANISMS = ["plate", "relay", "reactor", "bridge", "fracture", "disposal"] as const;
export type FreightMechanism = typeof FREIGHT_MECHANISMS[number];
export const FREIGHT_DIFFICULTIES = [
  { name: "First contact", description: "One pod and a power system to discover.", cargo: 0, mechanisms: 1 },
  { name: "Making connections", description: "Two systems. Learn how they work together.", cargo: 1, mechanisms: 2 },
  { name: "Changing plans", description: "Three systems and more than one job for a pod.", cargo: 2, mechanisms: 3 },
  { name: "Shared space", description: "Three systems. Make room before committing.", cargo: 3, mechanisms: 3 },
  { name: "Chain reaction", description: "Four systems with overlapping routes.", cargo: 4, mechanisms: 4 },
  { name: "Working backwards", description: "Five systems. Think about what you will need later.", cargo: 5, mechanisms: 5 },
  { name: "Close quarters", description: "Five systems and carefully ordered cargo.", cargo: 6, mechanisms: 5 },
  { name: "Full spectrum", description: "All six systems in a new arrangement.", cargo: 7, mechanisms: 6 },
  { name: "Master shift", description: "Six pods, all six systems, and a plan to untangle.", cargo: 8, mechanisms: 6 },
] as const;

/** Seed-local generator. g5 remains byte-for-byte reproducible for old shares. */
class Random {
  constructor(private seed: bigint) {}
  next(): number {
    this.seed = BigInt.asUintN(64, this.seed + 0x9e3779b97f4a7c15n);
    let z = this.seed;
    z = BigInt.asUintN(64, (z ^ z >> 30n) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ z >> 27n) * 0x94d049bb133111ebn);
    return Number((z ^ z >> 31n) & 0xffffffffn) / 4294967296;
  }
  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  }
}

type Deck = { level: LevelDefinition; actions: Direction[] };
type Trace = { snapshots: EngineSnapshot[]; used: Set<FreightMechanism>; pushes: number };
const at = (level: LevelDefinition, p: Coord) => p.y * level.width + p.x;
const coord = (level: LevelDefinition, i: number): Coord => ({ x: i % level.width, y: Math.floor(i / level.width) });
const adjacent = (p: Coord, direction: Direction): Coord => ({ x: p.x + DIRECTION_DELTAS[direction].x, y: p.y + DIRECTION_DELTAS[direction].y });
const same = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;

/** Production transitions are the authority, including cascades and losses. */
export function traceFreight(level: LevelDefinition, actions: readonly Direction[], start?: EngineSnapshot): Trace | null {
  if (validateLevel(level).length) return null;
  let snapshot = start ?? createInitialSnapshot(level);
  const snapshots = [snapshot];
  const used = new Set<FreightMechanism>();
  let pushes = 0;
  for (const direction of actions) {
    const result = resolveDirectionalAction(level, snapshot, direction);
    if (!result.accepted || result.after.outcome.kind === "physical-failure") return null;
    if (result.pushed) pushes++;
    for (const event of result.events) {
      if (event.type === "relay-toggled") used.add("relay");
      if (event.type === "socket-docked") used.add("reactor");
      if (event.type === "fracture-collapsed") used.add("fracture");
      if (event.type === "object-removed" && event.reason === "disposal") used.add("disposal");
    }
    for (const source of result.after.derived.sources) {
      if (source.kind === "plate" && source.active && !snapshot.derived.sources.find((s) => s.fixtureId === source.fixtureId)?.active) used.add("plate");
    }
    const p = result.after.state.player;
    if (p && level.cells[at(level, p)]?.fixture?.kind === "bridge") used.add("bridge");
    snapshot = result.after;
    snapshots.push(snapshot);
    if (snapshot.outcome.kind === "victory") break;
  }
  return snapshot.outcome.kind === "victory" ? { snapshots, used, pushes } : null;
}

function edit(level: LevelDefinition, changes: readonly [number, CellDefinition][]): LevelDefinition {
  const cells = [...level.cells];
  for (const [index, cell] of changes) cells[index] = cell;
  return { ...level, cells };
}

function empty(level: LevelDefinition, index: number): boolean {
  const cell = level.cells[index];
  return cell?.terrain === "floor" && !cell.fixture;
}

/** Spare wall margin allows chutes and sockets without reusing fixed rooms. */
function freightBase(level: LevelDefinition): LevelDefinition {
  const width = level.width + 2, height = level.height + 2;
  const cells: CellDefinition[] = Array.from({ length: width * height }, () => ({ terrain: "bulkhead" }));
  level.cells.forEach((cell, i) => {
    const fixture = cell.fixture?.kind === "plate" ? { kind: "bay" as const, id: cell.fixture.id } : undefined;
    cells[(Math.floor(i / level.width) + 1) * width + i % level.width + 1] = fixture ? { terrain: cell.terrain, fixture } : { terrain: cell.terrain };
  });
  return { ...level, generatorVersion: "g6", objective: "freight", width, height, cells, channels: [],
    playerStart: { x: level.playerStart.x + 1, y: level.playerStart.y + 1 },
    objects: level.objects.map((o) => ({ ...o, position: { x: o.position.x + 1, y: o.position.y + 1 } })) };
}

/** Keep one wall around the used deck, without drawing unused construction margin. */
function trimDeck(level: LevelDefinition): LevelDefinition {
  const used = level.cells.flatMap((cell, i) => cell.terrain !== "bulkhead" ? [coord(level, i)] : []);
  const left = Math.max(0, Math.min(...used.map((p) => p.x)) - 1);
  const top = Math.max(0, Math.min(...used.map((p) => p.y)) - 1);
  const width = Math.max(7, Math.max(...used.map((p) => p.x)) - left + 2);
  const height = Math.max(7, Math.max(...used.map((p) => p.y)) - top + 2);
  const shift = (p: Coord) => ({ x: p.x - left, y: p.y - top });
  return { ...level, width, height, playerStart: shift(level.playerStart), objects: level.objects.map((o) => ({ ...o, position: shift(o.position) })),
    cells: Array.from({ length: width * height }, (_, i) => {
      const x = i % width + left, y = Math.floor(i / width) + top;
      return x < level.width && y < level.height ? level.cells[y * level.width + x]! : { terrain: "bulkhead" };
    }) };
}

/** Install a cell or obstruction along a walking segment of the solution.
 * Its terminal socket/chute is outside the cargo route; its approach is shared
 * with that route. Vary the side, location, and number of pushes independently.
 */
function insertObject(deck: Deck, kind: "reactor" | "disposal", random: Random): Deck | null {
  const { level, actions } = deck;
  const trace = traceFreight(level, actions)!;
  const everOccupied = new Set<number>();
  for (const s of trace.snapshots) {
    if (s.state.player) everOccupied.add(at(level, s.state.player));
    for (const o of s.state.objects) everOccupied.add(at(level, o.position));
  }
  const firstVisit = new Set<number>([at(level, level.playerStart), ...level.objects.map((o) => at(level, o.position))]);
  const candidates: { from: number; terminal: number; length: number }[] = [];
  for (let t = 0; t < actions.length; t++) {
    const before = trace.snapshots[t]!, after = trace.snapshots[t + 1];
    if (!before.state.player || !after?.state.player) continue;
    const target = at(level, after.state.player);
    if (!firstVisit.has(target) && empty(level, target) && !objectAt(before.state, after.state.player)) {
      let p = after.state.player;
      for (let length = 1; length <= 3; length++) {
        const terminal = adjacent(p, actions[t]!);
        const end = at(level, terminal);
        if (terminal.x <= 0 || terminal.y <= 0 || terminal.x >= level.width - 1 || terminal.y >= level.height - 1) break;
        if (!everOccupied.has(end) && !level.cells[end]?.fixture) candidates.push({ from: target, terminal: end, length });
        if (!empty(level, end) || actions[t + length] !== actions[t] || !trace.snapshots[t + length + 1]?.state.player
          || !same(trace.snapshots[t + length + 1]!.state.player!, terminal)) break;
        p = terminal;
      }
    }
    firstVisit.add(target);
    for (const o of after.state.objects) firstVisit.add(at(level, o.position));
  }
  for (const candidate of random.shuffle(candidates)) {
    const fixture: FixtureDefinition = kind === "reactor"
      ? { kind: "socket", id: "reactor-socket", channel: "reactor", initiallyInstalled: false }
      : { kind: "disposal", id: "disposal-chute" };
    const next = { ...edit(level, [[candidate.terminal, { terrain: "floor", fixture }]]),
      channels: kind === "reactor" ? [...level.channels, { id: "reactor", symbol: "C" }] : level.channels,
      objects: [...level.objects, { id: kind === "reactor" ? "power-cell" : "obstruction", kind: kind === "reactor" ? "reactor-cell" as const : "cargo" as const, position: coord(level, candidate.from) }] };
    const replay = traceFreight(next, actions);
    if (replay?.used.has(kind)) return { level: next, actions };
  }
  return null;
}

function addFracture(deck: Deck, random: Random, difficulty: number): Deck | null {
  let result: Deck | null = null;
  for (const i of random.shuffle(deck.level.cells.flatMap((cell, i) => cell.terrain === "floor" && !cell.fixture ? [i] : []))) {
    const source: Deck = result ?? deck;
    const level = edit(source.level, [[i, { terrain: "fracture" }]]);
    const trace = traceFreight(level, source.actions);
    if (!trace?.used.has("fracture")) continue;
    // It must actually collapse; unvisited cracked decoration is not a mechanic.
    if (!trace.snapshots.at(-1)!.state.collapsedFractures.some((p) => at(level, p) === i)) continue;
    result = { ...source, level };
    if (difficulty < 4 || level.cells.filter((cell) => cell.terrain === "fracture").length >= 2) break;
  }
  return result;
}

/** Prefer a complete cut around a bay, so restoring this circuit is required
 * to deliver cargo there. A single busy passage is the alternative. Every
 * consumer must be crossed, initially off, and supported for the whole route.
 */
function addConsumer(deck: Deck, channel: string, kind: "door" | "bridge", random: Random): Deck | null {
  const { level, actions } = deck;
  const trace = traceFreight(level, actions)!;
  if (trace.snapshots[0]!.derived.channels.find((c) => c.id === channel)?.active) return null;
  const possible = new Set<number>();
  for (let i = 0; i < level.cells.length; i++) {
    if (!empty(level, i) || same(level.playerStart, coord(level, i)) || level.objects.some((o) => at(level, o.position) === i)) continue;
    let crossed = false, valid = true;
    for (let t = 1; t < trace.snapshots.length; t++) {
      const previous = trace.snapshots[t - 1]!, snapshot = trace.snapshots[t]!;
      const occupied = snapshot.state.player && at(level, snapshot.state.player) === i || snapshot.state.objects.some((o) => at(level, o.position) === i);
      if (!occupied) continue;
      crossed = true;
      if (!previous.derived.channels.find((c) => c.id === channel)?.active
        || kind === "bridge" && !snapshot.derived.channels.find((c) => c.id === channel)?.active) { valid = false; break; }
    }
    if (valid && crossed) possible.add(i);
  }
  const cuts = level.cells.flatMap((cell, i) => {
    if (cell.fixture?.kind !== "bay") return [];
    const neighbours = DIRECTION_ORDER.map((d) => at(level, adjacent(coord(level, i), d))).filter((n) => level.cells[n]?.terrain !== "bulkhead");
    return neighbours.length && neighbours.every((n) => possible.has(n)) ? [neighbours] : [];
  });
  for (const positions of [...random.shuffle(cuts), ...random.shuffle([...possible]).map((i) => [i])]) {
    const next = edit(level, positions.map((i) => [i, { terrain: kind === "bridge" ? "vacuum" : "floor", fixture: { kind, id: `${channel}-${kind}-${i}`, channel } }]));
    if (traceFreight(next, actions)) return { level: next, actions };
  }
  return null;
}

function addControl(deck: Deck, kind: "plate" | "relay", random: Random): Deck | null {
  const { level, actions } = deck;
  const trace = traceFreight(level, actions)!;
  const candidates = new Set<number>();
  for (const snapshot of trace.snapshots.slice(1, -1)) {
    if (kind === "relay" && snapshot.state.player) candidates.add(at(level, snapshot.state.player));
    if (kind === "plate") for (const object of snapshot.state.objects) candidates.add(at(level, object.position));
  }
  for (const position of random.shuffle([...candidates])) {
    if (!empty(level, position) || same(level.playerStart, coord(level, position)) || level.objects.some((o) => at(level, o.position) === position)) continue;
    const fixture: FixtureDefinition = kind === "plate" ? { kind, id: "pressure-plate", channel: kind } : { kind, id: "toggle-relay", channel: kind, initialOn: false };
    const next = { ...edit(level, [[position, { terrain: "floor", fixture }]]), channels: [...level.channels, { id: kind, symbol: kind === "plate" ? "A" : "B" }] };
    if (!traceFreight(next, actions)?.used.has(kind)) continue;
    const powered = addConsumer({ level: next, actions }, kind, "door", random);
    if (powered) return powered;
  }
  return null;
}

function pickMechanisms(random: Random, count: number): FreightMechanism[] {
  const control = random.shuffle(["plate", "relay", "reactor"] as const)[0]!;
  return [control, ...random.shuffle(FREIGHT_MECHANISMS.filter((m) => m !== control)).slice(0, count - 1)];
}

export async function generateFreightPuzzle(seed: bigint, difficulty: number, hooks: SolverHooks = {}): Promise<{ level: LevelDefinition; analysis: AnalysisReport }> {
  const profile = FREIGHT_DIFFICULTIES[difficulty]!;
  const random = new Random(seed ^ BigInt(difficulty) << 40n);
  const requested = pickMechanisms(random, profile.mechanisms);
  // Retry different procedural cargo layouts, never substitute a catalog map
  // or silently omit a requested mechanism if placement does not work.
  for (let attempt = 0; attempt < 96; attempt++) {
    if (hooks.shouldCancel?.()) throw new Error("Freight puzzle generation cancelled");
    hooks.onProgress?.({ stage: "analysis-enumeration", completed: attempt, total: 96, detail: "Connecting machinery and checking a complete route" });
    await hooks.yieldControl?.();
    const base = await generateCargoPuzzle(BigInt.asUintN(64, seed + BigInt(attempt) * 0x9e3779b97f4a7c15n), profile.cargo, hooks);
    let deck: Deck | null = { level: freightBase(base.level), actions: [...base.analysis.preferredSolution!.actions] };
    const order = [...random.shuffle(requested.filter((m) => m === "reactor" || m === "disposal")),
      ...random.shuffle(requested.filter((m) => m === "plate" || m === "relay")),
      ...requested.filter((m) => m === "bridge" || m === "fracture")];
    for (const mechanic of order) {
      if (!deck) break;
      if (mechanic === "disposal" || mechanic === "reactor") {
        deck = insertObject(deck, mechanic, random);
        if (deck && mechanic === "reactor") deck = addConsumer(deck, "reactor", "door", random);
      } else if (mechanic === "plate" || mechanic === "relay") deck = addControl(deck, mechanic, random);
      else if (mechanic === "fracture") deck = addFracture(deck, random, difficulty);
      else {
        const source = deck;
        deck = null;
        for (const channel of random.shuffle(source.level.channels)) {
          deck = addConsumer(source, channel.id, "bridge", random);
          if (deck) break;
        }
      }
    }
    if (!deck) continue;
    const trace = traceFreight(deck.level, deck.actions)!;
    if (!requested.every((m) => trace.used.has(m))) continue;
    const level = trimDeck(deck.level);
    return { level, analysis: freightAnalysis(level, { actions: deck.actions, complete: false, explored: 0 }, difficulty, base.analysis.cargo!.layout) };
  }
  throw new Error("Could not connect this deck. Try a fresh puzzle.");
}

export type FreightSolution = { actions: readonly Direction[] | null; complete: boolean; explored: number };
export function freightAnalysis(level: LevelDefinition, solution: FreightSolution, difficulty: number, layout = "Systems deck", start = createInitialSnapshot(level)): AnalysisReport {
  const trace = solution.actions ? traceFreight(level, solution.actions, start) : null;
  const actions = trace ? solution.actions!.slice(0, trace.snapshots.length - 1) : null;
  const used = [...(trace?.used ?? [])];
  return {
    freight: { layout, mechanisms: used, searchComplete: solution.complete },
    solvable: actions !== null, initialStateKey: canonicalStateKey(start.state), winningStateKeys: new Set(), fatalFrontier: [],
    preferredSolution: actions ? { actions, pushes: trace!.pushes, totalActions: actions.length, commitments: trace!.pushes } : null,
    optimalActions: null, optimalPushes: null, retainedNearOptimalSolutions: [], stateCount: solution.explored, transitionCount: 0,
    physicalFailureTransitionCount: 0, victoryTransitionCount: actions ? 1 : 0, estimatedBytes: 0, limits: DEFAULT_ANALYSIS_LIMITS,
    milestones: { mandatoryIds: [], precedence: [], dependencyDepth: 0, planningHorizon: 0, crossMechanicCoupling: 0 },
    features: { commitments: trace?.pushes ?? 0, dependencyDepth: 0, planningHorizon: 0, interleaving: 0, irreversibility: 0,
      decisionPressure: 0, crossMechanicCoupling: 0, stateSpaceComplexity: 0, fatalChoicePressure: 0, mechanicFamilies: 1 + used.length },
    difficulty: { requestedDifficulty: difficulty, ratedDifficulty: difficulty, profileMatch: true, hardViolations: [], targetDistance: 0, challengeScore: trace?.pushes ?? 0 },
  };
}
