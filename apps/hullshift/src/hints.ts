import {
  DIRECTION_ORDER,
  cellAt,
  indexCoord,
  type Coord,
  type Direction,
  type EngineSnapshot,
  type FixtureDefinition,
  type LevelDefinition,
  type ObjectKind,
  type TransitionResult,
} from "./model.ts";
import {
  canonicalStateHash,
  canonicalStateKey,
  resolveDirectionalAction,
} from "./simulation.ts";
import {
  isMeaningfulDecisionTransition,
} from "./solver.ts";

export type HintTier = 1 | 2;

export type HintSubgoal =
  | "position-object"
  | "energize-channel"
  | "use-powered-window"
  | "toggle-relay"
  | "dock-cell"
  | "clear-obstruction"
  | "cross-commitment"
  | "evacuate"
  | "continue-plan";

export interface HintChannel {
  readonly id: string | null;
  readonly symbol: string;
}

/** The compact exact artifact a resident already retains for an active run. */
export interface HintAnalysisEvidence {
  readonly winningStateKeys: ReadonlySet<string>;
}

export interface HintHighlight {
  readonly kind: "player" | "object" | "fixture";
  /** Null when an unbounded/non-display-safe external id was deliberately omitted. */
  readonly id: string | null;
  readonly label: string;
  readonly position: Coord;
}

export interface HintPair {
  readonly first: HintHighlight;
  readonly second: HintHighlight;
}

export type HintResponse =
  | {
      readonly kind: "hint";
      readonly tier: HintTier;
      readonly stateHash: string;
      readonly subgoal: HintSubgoal;
      readonly channel: HintChannel | null;
      /** Tier 1 is always null; tier 2 contains exactly two board highlights. */
      readonly pair: HintPair | null;
      readonly highlights: readonly HintHighlight[];
      readonly message: string;
    }
  | {
      readonly kind: "rewind";
      readonly tier: null;
      readonly stateHash: string;
      readonly recommendedAction: "rewind";
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly tier: null;
      readonly stateHash: string;
      readonly reason: "victory" | "analysis-mismatch";
      readonly message: string;
    };

export interface HintProgress {
  readonly stage: "hint-search" | "hint-complete";
  readonly completed: number;
  readonly total: number;
}

export interface HintOptions {
  readonly maxStates?: number;
  readonly maxTransitions?: number;
  readonly cooperateEvery?: number;
  readonly shouldCancel?: () => boolean;
  readonly yieldControl?: () => Promise<void>;
  readonly onProgress?: (progress: HintProgress) => void;
}

export class HintSearchLimitError extends Error {
  readonly limit: "states" | "transitions";

  constructor(limit: HintSearchLimitError["limit"]) {
    super(`Hullshift hint search exceeded its exact ${limit} limit`);
    this.name = "HintSearchLimitError";
    this.limit = limit;
  }
}

export class HintCancelledError extends Error {
  constructor() {
    super("Hullshift hint search was cancelled");
    this.name = "HintCancelledError";
  }
}

interface HintSearchNode {
  readonly snapshot: EngineSnapshot;
  readonly previous: number;
  readonly action: Direction | null;
}

interface HintFocus {
  readonly subgoal: HintSubgoal;
  readonly channel: HintChannel | null;
  readonly pair: HintPair;
  readonly tierOneMessage: string;
  readonly tierTwoMessage: string;
}

const DEFAULT_MAX_STATES = 200_000;
const DEFAULT_MAX_TRANSITIONS = 800_000;
const DEFAULT_COOPERATE_EVERY = 512;
const MAX_DISPLAY_ID = 80;
const MAX_CHANNEL_TEXT = 24;
const MAX_MESSAGE_LENGTH = 180;

/**
 * Produce a non-directional hint from an exact winning-state certificate.
 * The input snapshot, analysis, and level are treated as immutable evidence.
 */
export async function createSolverHint(
  level: LevelDefinition,
  snapshot: EngineSnapshot,
  analysis: HintAnalysisEvidence,
  tier: HintTier,
  options: HintOptions = {},
): Promise<HintResponse> {
  if (tier !== 1 && tier !== 2) throw new RangeError("Hullshift hint tier must be 1 or 2");
  checkCancelled(options);
  const stateHash = canonicalStateHash(snapshot.state);
  if (snapshot.outcome.kind === "victory") {
    return freezeUnavailable(stateHash, "victory", "Evacuation is already complete.");
  }
  if (snapshot.outcome.kind !== "playing") return freezeRewind(stateHash);

  const stateKey = canonicalStateKey(snapshot.state);
  if (!analysis.winningStateKeys.has(stateKey)) return freezeRewind(stateHash);

  const continuation = await findExactWinningContinuation(level, snapshot, analysis, options);
  if (continuation === null) {
    return freezeUnavailable(
      stateHash,
      "analysis-mismatch",
      "The ship computer could not reproduce this certified position.",
    );
  }
  const transitions = replayContinuation(level, snapshot, analysis.winningStateKeys, continuation);
  const decisionIndex = transitions.findIndex((transition) => (
    isMeaningfulDecisionTransition(level, transition)
  ));
  if (decisionIndex < 0) {
    return freezeUnavailable(
      stateHash,
      "analysis-mismatch",
      "The ship computer found no relevant decision in this position.",
    );
  }
  const focus = deriveFocus(level, snapshot, transitions, decisionIndex);
  const response: Extract<HintResponse, { kind: "hint" }> = {
    kind: "hint",
    tier,
    stateHash,
    subgoal: focus.subgoal,
    channel: focus.channel,
    pair: tier === 2 ? focus.pair : null,
    highlights: tier === 2 ? Object.freeze([focus.pair.first, focus.pair.second]) : Object.freeze([]),
    message: boundedMessage(tier === 1 ? focus.tierOneMessage : focus.tierTwoMessage),
  };
  options.onProgress?.({ stage: "hint-complete", completed: 1, total: 1 });
  return Object.freeze(response);
}

async function findExactWinningContinuation(
  level: LevelDefinition,
  initial: EngineSnapshot,
  analysis: HintAnalysisEvidence,
  options: HintOptions,
): Promise<readonly Direction[] | null> {
  const maxStates = boundedLimit(options.maxStates, DEFAULT_MAX_STATES, "maxStates");
  const maxTransitions = boundedLimit(options.maxTransitions, DEFAULT_MAX_TRANSITIONS, "maxTransitions");
  const cooperateEvery = boundedLimit(
    options.cooperateEvery,
    DEFAULT_COOPERATE_EVERY,
    "cooperateEvery",
  );
  const nodes: HintSearchNode[] = [{ snapshot: initial, previous: -1, action: null }];
  const visited = new Set<string>([canonicalStateKey(initial.state)]);
  let transitions = 0;
  options.onProgress?.({ stage: "hint-search", completed: 0, total: analysis.winningStateKeys.size });

  for (let queueIndex = 0; queueIndex < nodes.length; queueIndex += 1) {
    const source = nodes[queueIndex]!;
    for (const action of DIRECTION_ORDER) {
      const result = resolveDirectionalAction(level, source.snapshot, action, {
        winningStateKeys: analysis.winningStateKeys,
      });
      if (!result.accepted) continue;
      transitions += 1;
      if (transitions > maxTransitions) throw new HintSearchLimitError("transitions");
      if (result.after.outcome.kind === "victory") {
        return Object.freeze([...reconstructActions(nodes, queueIndex), action]);
      }
      if (result.after.outcome.kind !== "playing") continue;
      const key = canonicalStateKey(result.after.state);
      if (!analysis.winningStateKeys.has(key) || visited.has(key)) continue;
      if (nodes.length >= maxStates) throw new HintSearchLimitError("states");
      visited.add(key);
      nodes.push({ snapshot: result.after, previous: queueIndex, action });
    }
    if ((queueIndex + 1) % cooperateEvery === 0) {
      options.onProgress?.({
        stage: "hint-search",
        completed: queueIndex + 1,
        total: analysis.winningStateKeys.size,
      });
      await cooperate(options);
    }
  }
  return null;
}

function reconstructActions(nodes: readonly HintSearchNode[], target: number): Direction[] {
  const actions: Direction[] = [];
  let cursor = target;
  while (cursor > 0) {
    const node = nodes[cursor]!;
    if (node.action === null || node.previous < 0) throw new Error("Hint path is incomplete");
    actions.push(node.action);
    cursor = node.previous;
  }
  actions.reverse();
  return actions;
}

function replayContinuation(
  level: LevelDefinition,
  initial: EngineSnapshot,
  winningStateKeys: ReadonlySet<string>,
  actions: readonly Direction[],
): readonly TransitionResult[] {
  const transitions: TransitionResult[] = [];
  let snapshot = initial;
  for (const action of actions) {
    const transition = resolveDirectionalAction(level, snapshot, action, { winningStateKeys });
    if (!transition.accepted) throw new Error("Exact hint continuation no longer replays");
    transitions.push(transition);
    snapshot = transition.after;
  }
  if (snapshot.outcome.kind !== "victory") throw new Error("Exact hint continuation did not win");
  return Object.freeze(transitions);
}

function deriveFocus(
  level: LevelDefinition,
  current: EngineSnapshot,
  transitions: readonly TransitionResult[],
  decisionIndex: number,
): HintFocus {
  const decision = transitions[decisionIndex]!;
  const pushed = decision.events.find((event) => event.type === "object-pushed");
  if (pushed?.type === "object-pushed") {
    const object = current.state.objects.find((candidate) => candidate.id === pushed.objectId)
      ?? decision.before.state.objects.find((candidate) => candidate.id === pushed.objectId);
    const objectHighlight = highlightObject(
      pushed.objectId,
      pushed.objectKind,
      object?.position ?? pushed.from,
    );
    const target = findObjectTarget(level, transitions.slice(decisionIndex), pushed.objectId);
    if (target !== null) {
      const fixtureHighlight = highlightFixture(target.fixture, target.position);
      const channel = hintChannel(level, target.fixture);
      const pair = frozenPair(objectHighlight, fixtureHighlight);
      if (target.fixture.kind === "plate") {
        return frozenFocus(
          "energize-channel",
          channel,
          pair,
          channel === null
            ? `Position the ${objectLabel(pushed.objectKind).toLowerCase()} to energize the linked system.`
            : `Position the ${objectLabel(pushed.objectKind).toLowerCase()} to energize channel ${channel.symbol}.`,
          `Connect ${objectHighlight.label} with ${fixtureHighlight.label}.`,
        );
      }
      if (target.fixture.kind === "socket") {
        return frozenFocus(
          "dock-cell",
          channel,
          pair,
          channel === null
            ? "Dock the reactor cell to establish permanent power."
            : `Dock the reactor cell to establish power on channel ${channel.symbol}.`,
          `Connect ${objectHighlight.label} with ${fixtureHighlight.label}.`,
        );
      }
      if (target.fixture.kind === "disposal") {
        return frozenFocus(
          "clear-obstruction",
          null,
          pair,
          "Clear the route by committing the obstructing object to disposal.",
          `Connect ${objectHighlight.label} with ${fixtureHighlight.label}.`,
        );
      }
    }
    const nearbyFixture = nextFixtureOnContinuation(level, transitions, decisionIndex);
    const second = nearbyFixture === null
      ? syntheticFixtureHighlight(current.state.player ?? pushed.from)
      : highlightFixture(nearbyFixture.fixture, nearbyFixture.position);
    return frozenFocus(
      "position-object",
      nearbyFixture === null ? null : hintChannel(level, nearbyFixture.fixture),
      frozenPair(objectHighlight, second),
      `Create useful space around the ${objectLabel(pushed.objectKind).toLowerCase()}.`,
      `Consider ${objectHighlight.label} together with ${second.label}.`,
    );
  }

  const fixtureEntry = fixtureForTransition(level, decision);
  if (fixtureEntry !== null) {
    const fixtureHighlight = highlightFixture(fixtureEntry.fixture, fixtureEntry.position);
    const player = highlightPlayer(decision.before.state.player ?? fixtureEntry.position);
    const pair = frozenPair(player, fixtureHighlight);
    const channel = hintChannel(level, fixtureEntry.fixture);
    switch (fixtureEntry.fixture.kind) {
      case "plate":
        return frozenFocus(
          "energize-channel",
          channel,
          pair,
          channel === null
            ? "Hold pressure on the relevant circuit source."
            : `Hold pressure on channel ${channel.symbol} long enough to use its linked system.`,
          `Consider ${player.label} together with ${fixtureHighlight.label}.`,
        );
      case "relay":
        return frozenFocus(
          "toggle-relay",
          channel,
          pair,
          channel === null
            ? "Change the relay state needed by the current system."
            : `Set the relay state needed on channel ${channel.symbol}.`,
          `Consider ${player.label} together with ${fixtureHighlight.label}.`,
        );
      case "socket":
        return frozenFocus(
          "continue-plan",
          channel,
          pair,
          "Keep the reactor socket available while advancing the current plan.",
          `Consider ${player.label} together with ${fixtureHighlight.label}.`,
        );
      case "door":
      case "bridge":
        return frozenFocus(
          "use-powered-window",
          channel,
          pair,
          channel === null
            ? "Use the current powered window before the system changes."
            : `Use the current channel ${channel.symbol} window before it changes.`,
          `Consider ${player.label} together with ${fixtureHighlight.label}.`,
        );
      case "gate":
        return frozenFocus(
          "evacuate",
          channel,
          pair,
          "The evacuation gate is ready; complete evacuation.",
          `Bring ${player.label} to ${fixtureHighlight.label}.`,
        );
      case "disposal":
        return frozenFocus(
          "clear-obstruction",
          null,
          pair,
          "A blocking object must be committed to disposal.",
          `Use ${fixtureHighlight.label} for the obstructing object.`,
        );
    }
  }

  const player = highlightPlayer(decision.before.state.player ?? { x: 0, y: 0 });
  const terrainPosition = decision.after.state.player ?? decision.before.state.player ?? { x: 0, y: 0 };
  const fromTerrain = decision.before.state.player === null
    ? undefined
    : cellAt(level, decision.before.state.player)?.terrain;
  const toTerrain = decision.after.state.player === null
    ? undefined
    : cellAt(level, decision.after.state.player)?.terrain;
  const fractureCommitment = fromTerrain === "fracture" || toTerrain === "fracture";
  const nextFixture = nextFixtureOnContinuation(level, transitions, decisionIndex);
  const generic = nextFixture === null
    ? syntheticFixtureHighlight(terrainPosition)
    : highlightFixture(nextFixture.fixture, nextFixture.position);
  return frozenFocus(
    fractureCommitment ? "cross-commitment" : "continue-plan",
    null,
    frozenPair(player, generic),
    fractureCommitment
      ? "Treat the marked fracture deck as a one-way commitment."
      : "Preserve the current winning route while advancing the next system interaction.",
    `Consider ${player.label} together with ${generic.label}.`,
  );
}

function findObjectTarget(
  level: LevelDefinition,
  transitions: readonly TransitionResult[],
  objectId: string,
): { fixture: FixtureDefinition; position: Coord } | null {
  for (const transition of transitions) {
    for (const event of transition.events) {
      if (event.type === "object-pushed" && event.objectId === objectId) {
        const fixture = cellAt(level, event.to)?.fixture;
        if (fixture?.kind === "plate" || fixture?.kind === "socket" || fixture?.kind === "disposal") {
          return { fixture, position: event.to };
        }
      }
      if (event.type === "socket-docked" && event.objectId === objectId) {
        const entry = fixtureById(level, event.fixtureId);
        if (entry !== null) return entry;
      }
      if (event.type === "object-removed" && event.objectId === objectId && event.fixtureId !== undefined) {
        const entry = fixtureById(level, event.fixtureId);
        if (entry !== null) return entry;
      }
    }
  }
  return null;
}

function fixtureForTransition(
  level: LevelDefinition,
  transition: TransitionResult,
): { fixture: FixtureDefinition; position: Coord } | null {
  const gateEvent = transition.events.find((event) => event.type === "gate-entered");
  if (gateEvent?.type === "gate-entered") {
    const entry = fixtureById(level, gateEvent.fixtureId);
    if (entry !== null) return entry;
  }
  const to = transition.after.state.player;
  if (to !== null) {
    const fixture = cellAt(level, to)?.fixture;
    if (fixture !== undefined) return { fixture, position: to };
  }
  const fixtureEvent = transition.events.find((event) => (
    event.type === "relay-toggled"
    || event.type === "socket-docked"
    || event.type === "consumer-changed"
    || event.type === "source-changed"
  ));
  if (fixtureEvent !== undefined && "fixtureId" in fixtureEvent) {
    const entry = fixtureById(level, fixtureEvent.fixtureId);
    if (entry !== null) return entry;
  }
  const from = transition.before.state.player;
  if (from !== null) {
    const fixture = cellAt(level, from)?.fixture;
    if (fixture !== undefined) return { fixture, position: from };
  }
  return null;
}

function nextFixtureOnContinuation(
  level: LevelDefinition,
  transitions: readonly TransitionResult[],
  start: number,
): { fixture: FixtureDefinition; position: Coord } | null {
  for (let index = start; index < transitions.length; index += 1) {
    const fixture = fixtureForTransition(level, transitions[index]!);
    if (fixture !== null) return fixture;
  }
  return null;
}

function fixtureById(
  level: LevelDefinition,
  fixtureId: string,
): { fixture: FixtureDefinition; position: Coord } | null {
  for (let index = 0; index < level.cells.length; index += 1) {
    const fixture = level.cells[index]?.fixture;
    if (fixture?.id === fixtureId) return { fixture, position: indexCoord(level, index) };
  }
  return null;
}

function syntheticFixtureHighlight(position: Coord): HintHighlight {
  return Object.freeze({
    kind: "fixture",
    id: null,
    label: "Relevant system",
    position: frozenCoord(position),
  });
}

function hintChannel(level: LevelDefinition, fixture: FixtureDefinition): HintChannel | null {
  if (fixture.kind === "disposal") return null;
  const channel = level.channels.find((candidate) => candidate.id === fixture.channel);
  if (channel === undefined) return null;
  const symbol = boundedText(channel.symbol, MAX_CHANNEL_TEXT);
  if (symbol.length === 0) return null;
  return Object.freeze({
    id: displayId(channel.id),
    symbol,
  });
}

function highlightObject(id: string, kind: ObjectKind, position: Coord): HintHighlight {
  return Object.freeze({
    kind: "object",
    id: displayId(id),
    label: objectLabel(kind),
    position: frozenCoord(position),
  });
}

function highlightPlayer(position: Coord): HintHighlight {
  return Object.freeze({
    kind: "player",
    id: null,
    label: "Maintenance droid",
    position: frozenCoord(position),
  });
}

function highlightFixture(fixture: FixtureDefinition, position: Coord): HintHighlight {
  const labels: Readonly<Record<FixtureDefinition["kind"], string>> = {
    plate: "Mass plate",
    relay: "Relay pad",
    socket: "Reactor socket",
    door: "Blast door",
    bridge: "Phase bridge",
    disposal: "Disposal airlock",
    gate: "Evacuation gate",
  };
  return Object.freeze({
    kind: "fixture",
    id: displayId(fixture.id),
    label: labels[fixture.kind],
    position: frozenCoord(position),
  });
}

function objectLabel(kind: ObjectKind): string {
  return kind === "cargo" ? "Cargo pod" : "Reactor cell";
}

function frozenPair(first: HintHighlight, second: HintHighlight): HintPair {
  return Object.freeze({ first, second });
}

function frozenFocus(
  subgoal: HintSubgoal,
  channel: HintChannel | null,
  pair: HintPair,
  tierOneMessage: string,
  tierTwoMessage: string,
): HintFocus {
  return Object.freeze({ subgoal, channel, pair, tierOneMessage, tierTwoMessage });
}

function freezeRewind(stateHash: string): Extract<HintResponse, { kind: "rewind" }> {
  return Object.freeze({
    kind: "rewind",
    tier: null,
    stateHash,
    recommendedAction: "rewind",
    message: "No evacuation route remains from this position. Rewind the last commitment.",
  });
}

function freezeUnavailable(
  stateHash: string,
  reason: Extract<HintResponse, { kind: "unavailable" }>["reason"],
  message: string,
): Extract<HintResponse, { kind: "unavailable" }> {
  return Object.freeze({ kind: "unavailable", tier: null, stateHash, reason, message: boundedMessage(message) });
}

function displayId(value: string): string | null {
  return value.length <= MAX_DISPLAY_ID && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : null;
}

function boundedText(value: string, maximum: number): string {
  const safe = [...value].filter((character) => {
    const code = character.codePointAt(0)!;
    return code >= 0x21 && code <= 0x7e;
  }).join("");
  return safe.slice(0, maximum);
}

function boundedMessage(message: string): string {
  return message.slice(0, MAX_MESSAGE_LENGTH);
}

function frozenCoord(position: Coord): Coord {
  return Object.freeze({ x: position.x, y: position.y });
}

function boundedLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > fallback) {
    throw new RangeError(`${name} must be a positive integer no greater than ${fallback}`);
  }
  return result;
}

async function cooperate(options: HintOptions): Promise<void> {
  checkCancelled(options);
  await options.yieldControl?.();
  checkCancelled(options);
}

function checkCancelled(options: HintOptions): void {
  if (options.shouldCancel?.() === true) throw new HintCancelledError();
}
