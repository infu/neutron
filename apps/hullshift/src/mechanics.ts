import {
  BOARD_LIMITS,
  type BlockedReason,
  type BridgeFixture,
  type CellDefinition,
  type ConsumerState,
  type Coord,
  type DerivedMechanics,
  type DoorFixture,
  type FixtureDefinition,
  type FixtureKind,
  type GateFixture,
  InvalidLevelError,
  type LevelDefinition,
  type ObjectKind,
  type ObjectState,
  type PuzzleState,
  type SourceOutput,
  type TerrainKind,
  type ValidationIssue,
  cellAt,
  cellIndex,
  compareCoordsRowMajor,
  compareStrings,
  coordsEqual,
  indexCoord,
  isInside,
} from "./model";

export type StaticEntryPolicy =
  | "occupy"
  | "requires-power"
  | "blocks-player"
  | "blocks-object"
  | "accepts-pushed-object"
  | "accepts-reactor";

export interface FixtureCompatibilityRule {
  readonly terrains: readonly TerrainKind[];
  readonly player: StaticEntryPolicy;
  readonly object: StaticEntryPolicy;
}

/**
 * The single static fixture/terrain/entity compatibility table. Dynamic power,
 * installation and hazard decisions are layered on it by classifyEntry().
 */
export const MECHANIC_COMPATIBILITY: Readonly<
  Record<FixtureKind, FixtureCompatibilityRule>
> = Object.freeze({
  plate: Object.freeze({
    terrains: Object.freeze(["floor"] as const),
    player: "occupy",
    object: "occupy",
  }),
  relay: Object.freeze({
    terrains: Object.freeze(["floor"] as const),
    player: "occupy",
    object: "occupy",
  }),
  socket: Object.freeze({
    terrains: Object.freeze(["floor"] as const),
    player: "occupy",
    object: "accepts-reactor",
  }),
  door: Object.freeze({
    terrains: Object.freeze(["floor"] as const),
    player: "requires-power",
    object: "requires-power",
  }),
  bridge: Object.freeze({
    terrains: Object.freeze(["vacuum"] as const),
    player: "requires-power",
    object: "requires-power",
  }),
  disposal: Object.freeze({
    terrains: Object.freeze(["floor"] as const),
    player: "blocks-player",
    object: "accepts-pushed-object",
  }),
  gate: Object.freeze({
    terrains: Object.freeze(["floor"] as const),
    player: "requires-power",
    object: "blocks-object",
  }),
});

export interface PositionedFixture {
  readonly position: Coord;
  readonly fixture: FixtureDefinition;
}

export type EntryAssessment =
  | { readonly kind: "stable" }
  | { readonly kind: "player-hazard"; readonly reason: "vacuum" | "bridge-lost" }
  | { readonly kind: "object-loss"; readonly reason: "vacuum" | "bridge-lost" | "disposal" }
  | { readonly kind: "dock" }
  | { readonly kind: "gate" }
  | { readonly kind: "blocked"; readonly reason: BlockedReason };

const TERRAIN_KINDS: readonly TerrainKind[] = [
  "floor",
  "bulkhead",
  "vacuum",
  "fracture",
];

const FIXTURE_KINDS: readonly FixtureKind[] = [
  "plate",
  "relay",
  "socket",
  "door",
  "bridge",
  "disposal",
  "gate",
];

const OBJECT_KINDS: readonly ObjectKind[] = ["cargo", "reactor-cell"];

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function issue(
  code: string,
  message: string,
  position?: Coord,
  id?: string,
): ValidationIssue {
  return { code, message, ...(position === undefined ? {} : { position }), ...(id === undefined ? {} : { id }) };
}

function nonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function fixturesWithPositions(level: LevelDefinition): readonly PositionedFixture[] {
  const result: PositionedFixture[] = [];
  for (let index = 0; index < level.cells.length; index += 1) {
    const fixture = level.cells[index]?.fixture;
    if (fixture !== undefined) {
      result.push({ position: indexCoord(level, index), fixture });
    }
  }
  return result;
}

export function fixtureAt(level: LevelDefinition, position: Coord): FixtureDefinition | undefined {
  return cellAt(level, position)?.fixture;
}

export function objectAt(state: PuzzleState, position: Coord): ObjectState | undefined {
  return state.objects.find((object) => coordsEqual(object.position, position));
}

export function entityOccupies(state: PuzzleState, position: Coord): boolean {
  return coordsEqual(state.player, position) || objectAt(state, position) !== undefined;
}

export function isFractureCollapsed(state: PuzzleState, position: Coord): boolean {
  return state.collapsedFractures.some((collapsed) => coordsEqual(collapsed, position));
}

export function effectiveTerrain(
  level: LevelDefinition,
  state: PuzzleState,
  position: Coord,
): TerrainKind | undefined {
  const cell = cellAt(level, position);
  if (cell === undefined) return undefined;
  return cell.terrain === "fracture" && isFractureCollapsed(state, position)
    ? "vacuum"
    : cell.terrain;
}

function initialInstalledCellId(fixture: Extract<FixtureDefinition, { kind: "socket" }>): string {
  return fixture.initialCellId ?? `installed:${fixture.id}`;
}

function createInitialStateUnchecked(level: LevelDefinition): PuzzleState {
  const activeRelayIds = fixturesWithPositions(level)
    .filter(
      (entry): entry is PositionedFixture & {
        readonly fixture: Extract<FixtureDefinition, { kind: "relay" }>;
      } => entry.fixture.kind === "relay" && entry.fixture.initialOn,
    )
    .map((entry) => entry.fixture.id)
    .sort(compareStrings);

  const installedCells = fixturesWithPositions(level)
    .filter(
      (entry): entry is PositionedFixture & {
        readonly fixture: Extract<FixtureDefinition, { kind: "socket" }>;
      } => entry.fixture.kind === "socket" && entry.fixture.initiallyInstalled,
    )
    .map((entry) => ({
      socketId: entry.fixture.id,
      objectId: initialInstalledCellId(entry.fixture),
    }))
    .sort((a, b) => compareStrings(a.socketId, b.socketId));

  const objects = level.objects
    .map((object) => ({
      id: object.id,
      kind: object.kind,
      position: { x: object.position.x, y: object.position.y },
    }))
    .sort((a, b) => compareStrings(a.id, b.id));

  return {
    player: { x: level.playerStart.x, y: level.playerStart.y },
    objects,
    activeRelayIds,
    installedCells,
    collapsedFractures: [],
    removedObjectIds: [],
  };
}

function channelActive(derived: DerivedMechanics, channel: string): boolean {
  return derived.channels.find((candidate) => candidate.id === channel)?.active ?? false;
}

export function consumerForFixture(
  derived: DerivedMechanics,
  fixtureId: string,
): ConsumerState | undefined {
  return derived.consumers.find((consumer) => consumer.fixtureId === fixtureId);
}

export function deriveMechanics(level: LevelDefinition, state: PuzzleState): DerivedMechanics {
  const activeRelays = new Set(state.activeRelayIds);
  const installedSockets = new Set(state.installedCells.map((cell) => cell.socketId));
  const sources: SourceOutput[] = [];

  for (const { position, fixture } of fixturesWithPositions(level)) {
    switch (fixture.kind) {
      case "plate":
        sources.push({
          fixtureId: fixture.id,
          kind: fixture.kind,
          channel: fixture.channel,
          position,
          active: entityOccupies(state, position),
        });
        break;
      case "relay":
        sources.push({
          fixtureId: fixture.id,
          kind: fixture.kind,
          channel: fixture.channel,
          position,
          active: activeRelays.has(fixture.id),
        });
        break;
      case "socket":
        sources.push({
          fixtureId: fixture.id,
          kind: fixture.kind,
          channel: fixture.channel,
          position,
          active: installedSockets.has(fixture.id),
        });
        break;
      default:
        break;
    }
  }

  const sortedChannels = [...level.channels].sort((a, b) => compareStrings(a.id, b.id));
  const channels = sortedChannels.map((channel) => ({
    id: channel.id,
    symbol: channel.symbol,
    active: sources.some((source) => source.channel === channel.id && source.active),
  }));
  const activeChannels = new Set(channels.filter((channel) => channel.active).map((channel) => channel.id));
  const consumers: ConsumerState[] = [];

  for (const { position, fixture } of fixturesWithPositions(level)) {
    if (fixture.kind !== "door" && fixture.kind !== "bridge" && fixture.kind !== "gate") {
      continue;
    }
    const powered = activeChannels.has(fixture.channel);
    const occupied = entityOccupies(state, position);
    const jammed = fixture.kind === "door" && !powered && occupied;
    consumers.push({
      fixtureId: fixture.id,
      kind: fixture.kind,
      channel: fixture.channel,
      position,
      powered,
      passable: fixture.kind === "door" ? powered || jammed : powered,
      jammed,
    });
  }

  return { sources, channels, consumers };
}

export function classifyPlayerEntry(
  level: LevelDefinition,
  state: PuzzleState,
  derived: DerivedMechanics,
  position: Coord,
): EntryAssessment {
  const cell = cellAt(level, position);
  if (cell === undefined) return { kind: "blocked", reason: "edge" };

  const terrain = effectiveTerrain(level, state, position);
  if (terrain === "bulkhead") return { kind: "blocked", reason: "bulkhead" };

  const fixture = cell.fixture;
  if (fixture?.kind === "bridge") {
    const bridge = consumerForFixture(derived, fixture.id);
    return bridge?.passable === true
      ? { kind: "stable" }
      : { kind: "player-hazard", reason: "bridge-lost" };
  }
  if (terrain === "vacuum") return { kind: "player-hazard", reason: "vacuum" };

  switch (fixture?.kind) {
    case undefined:
    case "plate":
    case "relay":
      return { kind: "stable" };
    case "socket":
      return state.installedCells.some((installed) => installed.socketId === fixture.id)
        ? { kind: "blocked", reason: "installed-socket" }
        : { kind: "stable" };
    case "door":
      return consumerForFixture(derived, fixture.id)?.passable === true
        ? { kind: "stable" }
        : { kind: "blocked", reason: "closed-door" };
    case "disposal":
      return { kind: "blocked", reason: "disposal-blocks-player" };
    case "gate":
      return consumerForFixture(derived, fixture.id)?.powered === true
        ? { kind: "gate" }
        : { kind: "blocked", reason: "inactive-gate" };
    default:
      return { kind: "blocked", reason: "unsupported-terrain" };
  }
}

export function classifyObjectEntry(
  level: LevelDefinition,
  state: PuzzleState,
  derived: DerivedMechanics,
  position: Coord,
  objectKind: ObjectKind,
): EntryAssessment {
  const cell = cellAt(level, position);
  if (cell === undefined) return { kind: "blocked", reason: "edge" };

  const terrain = effectiveTerrain(level, state, position);
  if (terrain === "bulkhead") return { kind: "blocked", reason: "bulkhead" };

  const fixture = cell.fixture;
  if (fixture?.kind === "bridge") {
    const bridge = consumerForFixture(derived, fixture.id);
    return bridge?.passable === true
      ? { kind: "stable" }
      : { kind: "object-loss", reason: "bridge-lost" };
  }
  if (terrain === "vacuum") return { kind: "object-loss", reason: "vacuum" };

  switch (fixture?.kind) {
    case undefined:
    case "plate":
    case "relay":
      return { kind: "stable" };
    case "socket":
      if (state.installedCells.some((installed) => installed.socketId === fixture.id)) {
        return { kind: "blocked", reason: "installed-socket" };
      }
      return objectKind === "reactor-cell" ? { kind: "dock" } : { kind: "stable" };
    case "door":
      return consumerForFixture(derived, fixture.id)?.passable === true
        ? { kind: "stable" }
        : { kind: "blocked", reason: "closed-door" };
    case "disposal":
      return { kind: "object-loss", reason: "disposal" };
    case "gate":
      return { kind: "blocked", reason: "gate-blocks-object" };
    default:
      return { kind: "blocked", reason: "unsupported-terrain" };
  }
}

function validateFixture(
  fixture: FixtureDefinition,
  cell: CellDefinition,
  position: Coord,
  channelIds: ReadonlySet<string>,
  usedFixtureIds: Set<string>,
  usedEntityIds: Set<string>,
  issues: ValidationIssue[],
): void {
  if (!isOneOf(FIXTURE_KINDS, fixture.kind)) {
    issues.push(issue("fixture-kind", `Unknown fixture kind at (${position.x},${position.y})`, position));
    return;
  }
  if (!nonEmptyId(fixture.id)) {
    issues.push(issue("fixture-id", `Fixture at (${position.x},${position.y}) has no stable id`, position));
  } else if (usedFixtureIds.has(fixture.id) || usedEntityIds.has(fixture.id)) {
    issues.push(issue("duplicate-id", `Duplicate gameplay id '${fixture.id}'`, position, fixture.id));
  } else {
    usedFixtureIds.add(fixture.id);
    usedEntityIds.add(fixture.id);
  }

  const compatibleTerrains = MECHANIC_COMPATIBILITY[fixture.kind].terrains;
  if (!compatibleTerrains.includes(cell.terrain)) {
    issues.push(
      issue(
        "fixture-terrain",
        `${fixture.kind} '${fixture.id}' is incompatible with ${cell.terrain}`,
        position,
        fixture.id,
      ),
    );
  }

  if (fixture.kind !== "disposal") {
    if (!nonEmptyId(fixture.channel) || !channelIds.has(fixture.channel)) {
      issues.push(
        issue(
          "fixture-channel",
          `${fixture.kind} '${fixture.id}' references an unknown channel`,
          position,
          fixture.id,
        ),
      );
    }
  }

  if (fixture.kind === "socket") {
    if (typeof fixture.initiallyInstalled !== "boolean") {
      issues.push(issue("socket-initial", `Socket '${fixture.id}' needs an initial installed flag`, position, fixture.id));
    }
    if (fixture.initialCellId !== undefined && !nonEmptyId(fixture.initialCellId)) {
      issues.push(issue("socket-cell-id", `Socket '${fixture.id}' has an invalid initial cell id`, position, fixture.id));
    }
    if (!fixture.initiallyInstalled && fixture.initialCellId !== undefined) {
      issues.push(issue("socket-cell-id", `Empty socket '${fixture.id}' cannot name an installed cell`, position, fixture.id));
    }
    if (fixture.initiallyInstalled) {
      const cellId = initialInstalledCellId(fixture);
      if (usedEntityIds.has(cellId)) {
        issues.push(issue("duplicate-id", `Duplicate gameplay id '${cellId}'`, position, cellId));
      } else {
        usedEntityIds.add(cellId);
      }
    }
  }
  if (fixture.kind === "relay" && typeof fixture.initialOn !== "boolean") {
    issues.push(issue("relay-initial", `Relay '${fixture.id}' needs an initial state`, position, fixture.id));
  }
}

function validateInitialPlacement(
  level: LevelDefinition,
  state: PuzzleState,
  derived: DerivedMechanics,
  issues: ValidationIssue[],
): void {
  if (state.player !== null) {
    const playerAssessment = classifyPlayerEntry(level, state, derived, state.player);
    const playerFixture = fixtureAt(level, state.player);
    const startsInUnpoweredDoor =
      playerFixture?.kind === "door" &&
      consumerForFixture(derived, playerFixture.id)?.powered !== true;
    if (
      playerAssessment.kind !== "stable" ||
      playerFixture?.kind === "gate" ||
      startsInUnpoweredDoor
    ) {
      issues.push(issue("initial-player", "Player starts on a blocked, hazardous, or terminal cell", state.player));
    }
  }

  for (const object of state.objects) {
    const assessment = classifyObjectEntry(level, state, derived, object.position, object.kind);
    const objectFixture = fixtureAt(level, object.position);
    // A reactor already resting on an empty socket is supported but does not
    // retroactively perform the push-entry docking effect during settlement.
    const restingOnEmptySocket =
      assessment.kind === "dock" && objectFixture?.kind === "socket";
    const startsInUnpoweredDoor =
      objectFixture?.kind === "door" &&
      consumerForFixture(derived, objectFixture.id)?.powered !== true;
    if ((assessment.kind !== "stable" && !restingOnEmptySocket) || startsInUnpoweredDoor) {
      issues.push(
        issue(
          "initial-object",
          `Object '${object.id}' starts on an unsupported or entry-effect cell`,
          object.position,
          object.id,
        ),
      );
    }
  }
}

export function validateLevel(level: LevelDefinition): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!nonEmptyId(level.generatorVersion)) {
    issues.push(issue("generator-version", "Level has no generator version"));
  }
  if (
    !Number.isInteger(level.width) ||
    !Number.isInteger(level.height) ||
    level.width < BOARD_LIMITS.minWidth ||
    level.height < BOARD_LIMITS.minHeight ||
    level.width > BOARD_LIMITS.maxWidth ||
    level.height > BOARD_LIMITS.maxHeight
  ) {
    issues.push(
      issue(
        "board-size",
        `Board must be ${BOARD_LIMITS.minWidth}..${BOARD_LIMITS.maxWidth} by ${BOARD_LIMITS.minHeight}..${BOARD_LIMITS.maxHeight}`,
      ),
    );
  }

  const expectedCells =
    Number.isInteger(level.width) && Number.isInteger(level.height) && level.width >= 0 && level.height >= 0
      ? level.width * level.height
      : -1;
  if (level.cells.length !== expectedCells) {
    issues.push(issue("cell-count", `Board has ${level.cells.length} cells; expected ${expectedCells}`));
  }

  if (level.channels.length > BOARD_LIMITS.maxChannels) {
    issues.push(issue("channel-limit", `Board exceeds the ${BOARD_LIMITS.maxChannels}-channel limit`));
  }
  const channelIds = new Set<string>();
  const channelSymbols = new Set<string>();
  for (const channel of level.channels) {
    if (!nonEmptyId(channel.id)) {
      issues.push(issue("channel-id", "Channel has no stable id"));
    } else if (channelIds.has(channel.id)) {
      issues.push(issue("duplicate-channel", `Duplicate channel id '${channel.id}'`, undefined, channel.id));
    } else {
      channelIds.add(channel.id);
    }
    if (!nonEmptyId(channel.symbol)) {
      issues.push(issue("channel-symbol", `Channel '${channel.id}' has no stable symbol`, undefined, channel.id));
    } else if (channelSymbols.has(channel.symbol)) {
      issues.push(issue("duplicate-symbol", `Duplicate channel symbol '${channel.symbol}'`, undefined, channel.id));
    } else {
      channelSymbols.add(channel.symbol);
    }
  }

  if (level.objects.length > BOARD_LIMITS.maxObjects) {
    issues.push(issue("object-limit", `Board exceeds the ${BOARD_LIMITS.maxObjects}-object limit`));
  }
  const usedEntityIds = new Set<string>();
  const objectPositions = new Map<number, string>();
  for (const object of level.objects) {
    if (!nonEmptyId(object.id)) {
      issues.push(issue("object-id", "Movable object has no stable id", object.position));
    } else if (usedEntityIds.has(object.id)) {
      issues.push(issue("duplicate-id", `Duplicate gameplay id '${object.id}'`, object.position, object.id));
    } else {
      usedEntityIds.add(object.id);
    }
    if (!isOneOf(OBJECT_KINDS, object.kind)) {
      issues.push(issue("object-kind", `Object '${object.id}' has an unknown kind`, object.position, object.id));
    }
    if (!isInside(level, object.position)) {
      issues.push(issue("object-position", `Object '${object.id}' is outside the board`, object.position, object.id));
      continue;
    }
    const index = cellIndex(level, object.position);
    const previous = objectPositions.get(index);
    if (previous !== undefined) {
      issues.push(
        issue(
          "overlapping-objects",
          `Objects '${previous}' and '${object.id}' overlap`,
          object.position,
          object.id,
        ),
      );
    } else {
      objectPositions.set(index, object.id);
    }
  }

  if (!isInside(level, level.playerStart)) {
    issues.push(issue("player-position", "Player starts outside the board", level.playerStart));
  } else {
    const overlap = objectPositions.get(cellIndex(level, level.playerStart));
    if (overlap !== undefined) {
      issues.push(issue("player-overlap", `Player overlaps object '${overlap}'`, level.playerStart, overlap));
    }
  }

  const usedFixtureIds = new Set<string>();
  let fixtureCount = 0;
  let gateCount = 0;
  let nonBulkheadCount = 0;
  const safeCellCount = Math.min(level.cells.length, Math.max(0, expectedCells));
  for (let index = 0; index < safeCellCount; index += 1) {
    const cell = level.cells[index];
    if (cell === undefined) continue;
    const position = indexCoord(level, index);
    if (!isOneOf(TERRAIN_KINDS, cell.terrain)) {
      issues.push(issue("terrain-kind", `Unknown terrain at (${position.x},${position.y})`, position));
      continue;
    }
    if (cell.terrain !== "bulkhead") nonBulkheadCount += 1;
    if (cell.fixture !== undefined) {
      fixtureCount += 1;
      if (cell.fixture.kind === "gate") gateCount += 1;
      validateFixture(
        cell.fixture,
        cell,
        position,
        channelIds,
        usedFixtureIds,
        usedEntityIds,
        issues,
      );
    }
  }

  if (nonBulkheadCount > BOARD_LIMITS.maxNonBulkheadCells) {
    issues.push(
      issue(
        "cell-limit",
        `Board exceeds the ${BOARD_LIMITS.maxNonBulkheadCells} non-bulkhead-cell limit`,
      ),
    );
  }
  if (fixtureCount > BOARD_LIMITS.maxStatefulFixtures) {
    issues.push(issue("fixture-limit", `Board exceeds the ${BOARD_LIMITS.maxStatefulFixtures}-fixture limit`));
  }
  if (gateCount !== 1) {
    issues.push(issue("gate-count", `Board must contain exactly one evacuation gate; found ${gateCount}`));
  }

  if (issues.length === 0) {
    const state = createInitialStateUnchecked(level);
    const derived = deriveMechanics(level, state);
    validateInitialPlacement(level, state, derived, issues);
  }

  return issues;
}

export function assertValidLevel(level: LevelDefinition): void {
  const issues = validateLevel(level);
  if (issues.length > 0) throw new InvalidLevelError(issues);
}

export interface InitialSettlement {
  readonly state: PuzzleState;
  readonly derived: DerivedMechanics;
}

/**
 * Builds the stable start without firing relay, docking, fracture, disposal,
 * hazard, or gate-entry effects and without consuming a turn.
 */
export function settleInitialState(level: LevelDefinition): InitialSettlement {
  assertValidLevel(level);
  const state = createInitialStateUnchecked(level);
  return { state, derived: deriveMechanics(level, state) };
}

export function compatibleFixtureTerrain(
  fixture: FixtureDefinition,
  terrain: TerrainKind,
): boolean {
  return MECHANIC_COMPATIBILITY[fixture.kind].terrains.includes(terrain);
}

export function fixtureChannel(
  fixture: FixtureDefinition,
): string | undefined {
  return fixture.kind === "disposal" ? undefined : fixture.channel;
}

export function isCircuitConsumer(
  fixture: FixtureDefinition,
): fixture is DoorFixture | BridgeFixture | GateFixture {
  return fixture.kind === "door" || fixture.kind === "bridge" || fixture.kind === "gate";
}

export function cellPositionsOfTerrain(
  level: LevelDefinition,
  terrain: TerrainKind,
): readonly Coord[] {
  return level.cells
    .map((cell, index) => ({ cell, position: indexCoord(level, index) }))
    .filter((entry) => entry.cell.terrain === terrain)
    .map((entry) => entry.position)
    .sort(compareCoordsRowMajor);
}

/** Used by tests and render assertions to inspect static combinations. */
export function compatibilityIssueForCell(cell: CellDefinition): string | null {
  if (cell.fixture === undefined) return cell.terrain === "bulkhead" || cell.terrain === "floor" || cell.terrain === "vacuum" || cell.terrain === "fracture"
    ? null
    : "unknown-terrain";
  return compatibleFixtureTerrain(cell.fixture, cell.terrain) ? null : "fixture-terrain";
}

// This helper makes the simultaneous OR rule explicit for analyzer tests.
export function derivedChannelActive(derived: DerivedMechanics, channel: string): boolean {
  return channelActive(derived, channel);
}
