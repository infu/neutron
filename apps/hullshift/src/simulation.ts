import {
  BOARD_LIMITS,
  CascadeLimitError,
  type BlockedReason,
  type ConsumerState,
  type Coord,
  type DerivedMechanics,
  type Direction,
  type EngineEvent,
  type EngineSnapshot,
  type EntityRef,
  type FixtureDefinition,
  type LevelDefinition,
  type ObjectState,
  type Outcome,
  type PhysicalFailureReason,
  type PuzzleState,
  type SourceOutput,
  type TransitionOptions,
  type TransitionResult,
  addDirection,
  cellAt,
  compareCoordsRowMajor,
  compareStrings,
  coordsEqual,
  indexCoord,
} from "./model";
import {
  classifyObjectEntry,
  classifyPlayerEntry,
  consumerForFixture,
  deriveMechanics,
  effectiveTerrain,
  entityOccupies,
  fixtureAt,
  fixturesWithPositions,
  objectAt,
  settleInitialState,
} from "./mechanics";

const PLAYING: Outcome = Object.freeze({ kind: "playing" } as const);

interface EntityMovement {
  readonly entity: EntityRef;
  readonly from: Coord;
  readonly to: Coord;
}

interface PhysicalFailureFact {
  readonly reason: PhysicalFailureReason;
  readonly position: Coord;
  readonly fixtureId?: string;
}

interface GateEntryFact {
  readonly fixture: Extract<FixtureDefinition, { kind: "gate" }>;
  readonly position: Coord;
}

function cloneCoord(position: Coord): Coord {
  return { x: position.x, y: position.y };
}

function uniqueSortedStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

function uniqueSortedCoords(values: readonly Coord[]): readonly Coord[] {
  const byCoordinate = new Map<string, Coord>();
  for (const value of values) byCoordinate.set(`${value.x},${value.y}`, cloneCoord(value));
  return [...byCoordinate.values()].sort(compareCoordsRowMajor);
}

/** Returns a fresh, deterministically ordered representation of q. */
export function canonicalizePuzzleState(state: PuzzleState): PuzzleState {
  const objects = state.objects
    .map((object) => ({
      id: object.id,
      kind: object.kind,
      position: cloneCoord(object.position),
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const installedCells = state.installedCells
    .map((cell) => ({ socketId: cell.socketId, objectId: cell.objectId }))
    .sort(
      (a, b) =>
        compareStrings(a.socketId, b.socketId) || compareStrings(a.objectId, b.objectId),
    );
  return {
    player: state.player === null ? null : cloneCoord(state.player),
    objects,
    activeRelayIds: uniqueSortedStrings(state.activeRelayIds),
    installedCells,
    collapsedFractures: uniqueSortedCoords(state.collapsedFractures),
    removedObjectIds: uniqueSortedStrings(state.removedObjectIds),
  };
}

function canonicalStateValue(state: PuzzleState): readonly unknown[] {
  const canonical = canonicalizePuzzleState(state);
  return [
    "hullshift-state",
    1,
    canonical.player === null ? null : [canonical.player.x, canonical.player.y],
    canonical.objects.map((object) => [
      object.id,
      object.kind,
      object.position.x,
      object.position.y,
    ]),
    canonical.activeRelayIds,
    canonical.installedCells.map((cell) => [cell.socketId, cell.objectId]),
    canonical.collapsedFractures.map((position) => [position.x, position.y]),
    canonical.removedObjectIds,
  ];
}

/** Collision-free canonical key used by exact graph and winning-set indexes. */
export function canonicalStateKey(state: PuzzleState): string {
  return JSON.stringify(canonicalStateValue(state));
}

export function canonicalStateBytes(state: PuzzleState): Uint8Array {
  return encodeUtf8(canonicalStateKey(state));
}

function canonicalFixtureValue(fixture: FixtureDefinition): readonly unknown[] {
  switch (fixture.kind) {
    case "plate":
    case "door":
    case "bridge":
    case "gate":
      return [fixture.kind, fixture.id, fixture.channel];
    case "relay":
      return [fixture.kind, fixture.id, fixture.channel, fixture.initialOn ? 1 : 0];
    case "socket":
      return [
        fixture.kind,
        fixture.id,
        fixture.channel,
        fixture.initiallyInstalled ? 1 : 0,
        fixture.initialCellId ?? null,
      ];
    case "disposal":
      return [fixture.kind, fixture.id];
  }
}

function canonicalLevelValue(level: LevelDefinition): readonly unknown[] {
  const channels = [...level.channels]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((channel) => [channel.id, channel.symbol]);
  const objects = [...level.objects]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((object) => [
      object.id,
      object.kind,
      object.position.x,
      object.position.y,
    ]);
  const cells = level.cells.map((cell) => [
    cell.terrain,
    cell.fixture === undefined ? null : canonicalFixtureValue(cell.fixture),
  ]);
  return [
    "hullshift-level",
    1,
    level.generatorVersion,
    level.width,
    level.height,
    channels,
    cells,
    [level.playerStart.x, level.playerStart.y],
    objects,
  ];
}

export function canonicalLevelBytes(level: LevelDefinition): Uint8Array {
  return encodeUtf8(JSON.stringify(canonicalLevelValue(level)));
}

export function canonicalLevelKey(level: LevelDefinition): string {
  return JSON.stringify(canonicalLevelValue(level));
}

export function canonicalStateHash(state: PuzzleState): string {
  return sha256Hex(canonicalStateBytes(state));
}

export function canonicalLevelHash(level: LevelDefinition): string {
  return sha256Hex(canonicalLevelBytes(level));
}

export function statesEqual(a: PuzzleState, b: PuzzleState): boolean {
  return canonicalStateKey(a) === canonicalStateKey(b);
}

export function createSnapshot(
  level: LevelDefinition,
  state: PuzzleState,
  outcome: Outcome = PLAYING,
): EngineSnapshot {
  const canonical = canonicalizePuzzleState(state);
  return { state: canonical, derived: deriveMechanics(level, canonical), outcome };
}

export function createInitialSnapshot(level: LevelDefinition): EngineSnapshot {
  const settled = settleInitialState(level);
  return { state: canonicalizePuzzleState(settled.state), derived: settled.derived, outcome: PLAYING };
}

function entityOrderKey(entity: EntityRef): string {
  return entity.kind === "player" ? "\u0000player" : `\u0001${entity.objectId}`;
}

function compareMovements(a: EntityMovement, b: EntityMovement): number {
  return compareStrings(entityOrderKey(a.entity), entityOrderKey(b.entity));
}

function blockedResult(
  before: EngineSnapshot,
  action: Direction,
  attempt: "walk" | "push",
  reason: BlockedReason,
  at: Coord,
): TransitionResult {
  const event: EngineEvent = { type: "blocked", action, attempt, reason, at: cloneCoord(at) };
  return {
    accepted: false,
    pushed: false,
    action,
    before,
    after: before,
    blockedReason: reason,
    events: [event],
    internalPasses: 0,
  };
}

function sourceChanged(a: SourceOutput | undefined, b: SourceOutput): boolean {
  return a === undefined || a.active !== b.active;
}

function consumerChanged(a: ConsumerState | undefined, b: ConsumerState): boolean {
  return (
    a === undefined ||
    a.powered !== b.powered ||
    a.passable !== b.passable ||
    a.jammed !== b.jammed
  );
}

function appendDerivedChanges(
  previous: DerivedMechanics,
  next: DerivedMechanics,
  events: EngineEvent[],
): void {
  const oldSources = new Map(previous.sources.map((source) => [source.fixtureId, source]));
  for (const source of next.sources) {
    if (!sourceChanged(oldSources.get(source.fixtureId), source)) continue;
    events.push({
      type: "source-changed",
      fixtureId: source.fixtureId,
      sourceKind: source.kind,
      channel: source.channel,
      position: cloneCoord(source.position),
      active: source.active,
    });
  }

  const oldChannels = new Map(previous.channels.map((channel) => [channel.id, channel.active]));
  for (const channel of next.channels) {
    if (oldChannels.get(channel.id) === channel.active) continue;
    events.push({ type: "channel-changed", channel: channel.id, active: channel.active });
  }

  const oldConsumers = new Map(
    previous.consumers.map((consumer) => [consumer.fixtureId, consumer]),
  );
  for (const consumer of next.consumers) {
    if (!consumerChanged(oldConsumers.get(consumer.fixtureId), consumer)) continue;
    events.push({
      type: "consumer-changed",
      fixtureId: consumer.fixtureId,
      consumerKind: consumer.kind,
      channel: consumer.channel,
      position: cloneCoord(consumer.position),
      powered: consumer.powered,
      passable: consumer.passable,
      jammed: consumer.jammed,
    });
  }
}

function removeObjectFromState(
  state: PuzzleState,
  object: ObjectState,
  removed: boolean,
): PuzzleState {
  return {
    ...state,
    objects: state.objects.filter((candidate) => candidate.id !== object.id),
    removedObjectIds: removed
      ? uniqueSortedStrings([...state.removedObjectIds, object.id])
      : state.removedObjectIds,
  };
}

function toggleRelay(state: PuzzleState, fixtureId: string): PuzzleState {
  const active = new Set(state.activeRelayIds);
  if (active.has(fixtureId)) active.delete(fixtureId);
  else active.add(fixtureId);
  return { ...state, activeRelayIds: [...active].sort(compareStrings) };
}

function positionOccupiedInAtomicState(state: PuzzleState, position: Coord): boolean {
  return entityOccupies(state, position);
}

function collapseDepartedFractures(
  level: LevelDefinition,
  before: PuzzleState,
  atomic: PuzzleState,
  state: PuzzleState,
  events: EngineEvent[],
): PuzzleState {
  const collapsed = [...state.collapsedFractures];
  for (let index = 0; index < level.cells.length; index += 1) {
    if (level.cells[index]?.terrain !== "fracture") continue;
    const position = indexCoord(level, index);
    const alreadyCollapsed = before.collapsedFractures.some((candidate) =>
      coordsEqual(candidate, position),
    );
    if (
      !alreadyCollapsed &&
      positionOccupiedInAtomicState(before, position) &&
      !positionOccupiedInAtomicState(atomic, position)
    ) {
      collapsed.push(position);
      events.push({ type: "fracture-collapsed", position: cloneCoord(position) });
    }
  }
  return { ...state, collapsedFractures: uniqueSortedCoords(collapsed) };
}

function fixtureForBridgeLoss(
  level: LevelDefinition,
  derived: DerivedMechanics,
  position: Coord,
): Extract<FixtureDefinition, { kind: "bridge" }> | undefined {
  const fixture = fixtureAt(level, position);
  if (fixture?.kind !== "bridge") return undefined;
  return consumerForFixture(derived, fixture.id)?.passable === false ? fixture : undefined;
}

interface CascadeLosses {
  readonly objects: readonly {
    readonly object: ObjectState;
    readonly fixture: Extract<FixtureDefinition, { kind: "bridge" }>;
  }[];
  readonly player?: {
    readonly position: Coord;
    readonly fixture: Extract<FixtureDefinition, { kind: "bridge" }>;
  };
}

function findBridgeLosses(
  level: LevelDefinition,
  state: PuzzleState,
  derived: DerivedMechanics,
): CascadeLosses {
  const objects = state.objects
    .map((object) => {
      const fixture = fixtureForBridgeLoss(level, derived, object.position);
      return fixture === undefined ? undefined : { object, fixture };
    })
    .filter(
      (
        value,
      ): value is {
        readonly object: ObjectState;
        readonly fixture: Extract<FixtureDefinition, { kind: "bridge" }>;
      } => value !== undefined,
    )
    .sort((a, b) => compareStrings(a.object.id, b.object.id));
  if (state.player === null) return { objects };
  const playerFixture = fixtureForBridgeLoss(level, derived, state.player);
  return playerFixture === undefined
    ? { objects }
    : { objects, player: { position: state.player, fixture: playerFixture } };
}

function snapshotForInput(level: LevelDefinition, snapshot: EngineSnapshot): EngineSnapshot {
  const state = canonicalizePuzzleState(snapshot.state);
  // Derived presentation input is intentionally ignored and recomputed.
  return { state, derived: deriveMechanics(level, state), outcome: snapshot.outcome };
}

/**
 * Applies exactly one N/E/S/W action and resolves it completely to a stable
 * result. The input snapshot and all nested records remain untouched.
 */
export function resolveDirectionalAction(
  level: LevelDefinition,
  snapshot: EngineSnapshot,
  action: Direction,
  options: TransitionOptions = {},
): TransitionResult {
  const before = snapshotForInput(level, snapshot);
  const player = before.state.player;
  if (before.outcome.kind !== "playing" || player === null) {
    return blockedResult(before, action, "walk", "terminal", player ?? { x: 0, y: 0 });
  }

  const adjacent = addDirection(player, action);
  const pushedObject = objectAt(before.state, adjacent);
  let destination = adjacent;
  let entryAssessment;

  if (pushedObject === undefined) {
    entryAssessment = classifyPlayerEntry(
      level,
      before.state,
      before.derived,
      adjacent,
    );
    if (entryAssessment.kind === "blocked") {
      return blockedResult(before, action, "walk", entryAssessment.reason, adjacent);
    }
  } else {
    destination = addDirection(adjacent, action);
    if (objectAt(before.state, destination) !== undefined) {
      return blockedResult(before, action, "push", "chain-push", destination);
    }
    entryAssessment = classifyObjectEntry(
      level,
      before.state,
      before.derived,
      destination,
      pushedObject.kind,
    );
    if (entryAssessment.kind === "blocked") {
      return blockedResult(before, action, "push", entryAssessment.reason, destination);
    }
  }

  const movedObjects =
    pushedObject === undefined
      ? before.state.objects
      : before.state.objects.map((object) =>
          object.id === pushedObject.id ? { ...object, position: cloneCoord(destination) } : object,
        );
  const atomicState: PuzzleState = {
    ...before.state,
    player: cloneCoord(adjacent),
    objects: movedObjects,
  };
  let nextState = atomicState;
  const movements: EntityMovement[] = [
    { entity: { kind: "player" }, from: cloneCoord(player), to: cloneCoord(adjacent) },
  ];
  if (pushedObject !== undefined) {
    movements.push({
      entity: {
        kind: "object",
        objectId: pushedObject.id,
        objectKind: pushedObject.kind,
      },
      from: cloneCoord(adjacent),
      to: cloneCoord(destination),
    });
  }
  movements.sort(compareMovements);

  const events: EngineEvent[] = [];
  for (const movement of movements) {
    events.push({ type: "entity-exited", entity: movement.entity, position: movement.from });
  }
  events.push({ type: "player-moved", from: cloneCoord(player), to: cloneCoord(adjacent) });
  if (pushedObject !== undefined) {
    events.push({
      type: "object-pushed",
      objectId: pushedObject.id,
      objectKind: pushedObject.kind,
      from: cloneCoord(adjacent),
      to: cloneCoord(destination),
    });
  }
  for (const movement of movements) {
    events.push({ type: "entity-entered", entity: movement.entity, position: movement.to });
  }

  let physicalFailure: PhysicalFailureFact | undefined;
  let gateEntry: GateEntryFact | undefined;

  // Entry effects are applied in the same stable entity order as the trace.
  for (const movement of movements) {
    const enteredFixture = fixtureAt(level, movement.to);
    if (movement.entity.kind === "player") {
      if (enteredFixture?.kind === "relay") {
        nextState = toggleRelay(nextState, enteredFixture.id);
        events.push({
          type: "relay-toggled",
          fixtureId: enteredFixture.id,
          channel: enteredFixture.channel,
          position: cloneCoord(movement.to),
          active: nextState.activeRelayIds.includes(enteredFixture.id),
        });
      }
      if (entryAssessment.kind === "gate" && enteredFixture?.kind === "gate") {
        gateEntry = { fixture: enteredFixture, position: cloneCoord(movement.to) };
        events.push({
          type: "gate-entered",
          fixtureId: enteredFixture.id,
          channel: enteredFixture.channel,
          position: cloneCoord(movement.to),
        });
      } else if (entryAssessment.kind === "player-hazard") {
        nextState = { ...nextState, player: null };
        physicalFailure = {
          reason: entryAssessment.reason,
          position: cloneCoord(movement.to),
          ...(enteredFixture?.kind === "bridge" ? { fixtureId: enteredFixture.id } : {}),
        };
      }
      continue;
    }

    if (pushedObject === undefined || movement.entity.objectId !== pushedObject.id) continue;
    const movedObject = nextState.objects.find((object) => object.id === pushedObject.id);
    if (movedObject === undefined) continue;
    if (entryAssessment.kind === "dock" && enteredFixture?.kind === "socket") {
      nextState = removeObjectFromState(nextState, movedObject, false);
      nextState = {
        ...nextState,
        installedCells: [
          ...nextState.installedCells,
          { socketId: enteredFixture.id, objectId: movedObject.id },
        ].sort((a, b) => compareStrings(a.socketId, b.socketId)),
      };
      events.push({
        type: "socket-docked",
        fixtureId: enteredFixture.id,
        channel: enteredFixture.channel,
        objectId: movedObject.id,
        position: cloneCoord(movement.to),
      });
    } else if (entryAssessment.kind === "object-loss") {
      nextState = removeObjectFromState(nextState, movedObject, true);
      events.push({
        type: "object-removed",
        objectId: movedObject.id,
        objectKind: movedObject.kind,
        position: cloneCoord(movement.to),
        reason: entryAssessment.reason,
        ...(enteredFixture?.kind === "bridge" || enteredFixture?.kind === "disposal"
          ? { fixtureId: enteredFixture.id }
          : {}),
      });
    }
  }

  nextState = collapseDepartedFractures(
    level,
    before.state,
    atomicState,
    nextState,
    events,
  );

  let previousDerived = before.derived;
  let finalDerived = previousDerived;
  let internalPasses = 0;
  const cascadeKeys = new Set<string>();

  while (true) {
    internalPasses += 1;
    if (internalPasses > BOARD_LIMITS.maxCascadePasses) {
      throw new CascadeLimitError(BOARD_LIMITS.maxCascadePasses);
    }
    const passKey = canonicalStateKey(nextState);
    if (cascadeKeys.has(passKey)) {
      // Removal-only V1 cascades cannot legitimately revisit a base state.
      throw new CascadeLimitError(BOARD_LIMITS.maxCascadePasses);
    }
    cascadeKeys.add(passKey);

    finalDerived = deriveMechanics(level, nextState);
    appendDerivedChanges(previousDerived, finalDerived, events);
    const losses = findBridgeLosses(level, nextState, finalDerived);
    if (losses.objects.length === 0 && losses.player === undefined) break;

    // Losses are logically simultaneous, with stable id ordering only for trace.
    for (const loss of losses.objects) {
      nextState = removeObjectFromState(nextState, loss.object, true);
      events.push({
        type: "object-removed",
        objectId: loss.object.id,
        objectKind: loss.object.kind,
        position: cloneCoord(loss.object.position),
        reason: "bridge-lost",
        fixtureId: loss.fixture.id,
      });
    }
    if (losses.player !== undefined) {
      nextState = { ...nextState, player: null };
      physicalFailure = {
        reason: "bridge-lost",
        position: cloneCoord(losses.player.position),
        fixtureId: losses.player.fixture.id,
      };
    }
    previousDerived = finalDerived;
  }

  const canonicalState = canonicalizePuzzleState(nextState);
  // Re-derive after canonical ordering so no input/presentation object leaks out.
  finalDerived = deriveMechanics(level, canonicalState);
  let outcome: Outcome = PLAYING;
  if (physicalFailure !== undefined) {
    outcome = {
      kind: "physical-failure",
      reason: physicalFailure.reason,
      position: physicalFailure.position,
      ...(physicalFailure.fixtureId === undefined
        ? {}
        : { fixtureId: physicalFailure.fixtureId }),
    };
    events.push({
      type: "physical-failure",
      reason: physicalFailure.reason,
      position: physicalFailure.position,
      ...(physicalFailure.fixtureId === undefined
        ? {}
        : { fixtureId: physicalFailure.fixtureId }),
    });
  } else if (gateEntry !== undefined) {
    outcome = {
      kind: "victory",
      gateId: gateEntry.fixture.id,
      position: gateEntry.position,
    };
    events.push({
      type: "victory",
      gateId: gateEntry.fixture.id,
      position: gateEntry.position,
    });
  } else if (
    options.winningStateKeys !== undefined &&
    !options.winningStateKeys.has(canonicalStateKey(canonicalState))
  ) {
    outcome = { kind: "causal-failure", reason: "no-evacuation-route" };
    events.push({ type: "causal-failure", reason: "no-evacuation-route" });
  }

  const after: EngineSnapshot = { state: canonicalState, derived: finalDerived, outcome };
  return {
    accepted: true,
    pushed: pushedObject !== undefined,
    action,
    before,
    after,
    events,
    internalPasses,
  };
}

/** Familiar short alias for solver and resident call sites. */
export const transition = resolveDirectionalAction;

export function isPushTransition(result: TransitionResult): boolean {
  return result.accepted && result.pushed;
}

export function eventIsPush(event: EngineEvent): event is Extract<EngineEvent, { type: "object-pushed" }> {
  return event.type === "object-pushed";
}

/** Deterministic UTF-8 without TextEncoder, DOM, Node, or browser dependencies. */
export function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.codePointAt(index);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) index += 1;
    // JSON.stringify may preserve lone surrogates only as escapes; this branch
    // still gives deterministic replacement behavior for direct callers.
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

const SHA256_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** Synchronous lowercase SHA-256 for canonical puzzle artifacts. */
export function sha256Hex(input: Uint8Array): string {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const highBits = Math.floor(bitLength / 0x1_0000_0000);
  const lowBits = bitLength >>> 0;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, highBits, false);
  view.setUint32(paddedLength - 4, lowBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15] ?? 0;
      const y = words[index - 2] ?? 0;
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + bigSigma1 + choose + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const bigSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((value) => value.toString(16).padStart(8, "0"))
    .join("");
}
