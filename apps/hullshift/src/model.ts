/**
 * Canonical, renderer-independent Hullshift puzzle records.
 *
 * Coordinates use a top-left origin. Cells are stored in row-major order and
 * every collection which is part of puzzle state is canonicalized before it is
 * compared or serialized.
 */

export const BOARD_LIMITS = Object.freeze({
  minWidth: 7,
  minHeight: 7,
  maxWidth: 16,
  maxHeight: 16,
  maxNonBulkheadCells: 160,
  maxObjects: 8,
  maxChannels: 4,
  maxStatefulFixtures: 24,
  maxCascadePasses: 32,
} as const);

export const DIRECTION_ORDER = ["N", "E", "S", "W"] as const;
export type Direction = (typeof DIRECTION_ORDER)[number];

export const DIRECTION_DELTAS: Readonly<Record<Direction, Readonly<Coord>>> =
  Object.freeze({
    N: Object.freeze({ x: 0, y: -1 }),
    E: Object.freeze({ x: 1, y: 0 }),
    S: Object.freeze({ x: 0, y: 1 }),
    W: Object.freeze({ x: -1, y: 0 }),
  });

export interface Coord {
  readonly x: number;
  readonly y: number;
}

export type TerrainKind = "floor" | "bulkhead" | "vacuum" | "fracture";
export type ObjectKind = "cargo" | "reactor-cell";
export type FixtureKind =
  | "plate"
  | "relay"
  | "socket"
  | "door"
  | "bridge"
  | "disposal"
  | "gate";

export interface ChannelDefinition {
  /** Stable logical identifier referenced by sources and consumers. */
  readonly id: string;
  /** Stable, non-color-only symbol shown on every linked mechanism. */
  readonly symbol: string;
}

interface FixtureBase {
  readonly id: string;
  readonly kind: FixtureKind;
}

interface CircuitFixtureBase extends FixtureBase {
  readonly channel: string;
}

export interface PlateFixture extends CircuitFixtureBase {
  readonly kind: "plate";
}

export interface RelayFixture extends CircuitFixtureBase {
  readonly kind: "relay";
  readonly initialOn: boolean;
}

export interface SocketFixture extends CircuitFixtureBase {
  readonly kind: "socket";
  readonly initiallyInstalled: boolean;
  /**
   * Optional stable id for a cell which starts installed. If omitted, the
   * canonical id `installed:<socket id>` is used.
   */
  readonly initialCellId?: string;
}

export interface DoorFixture extends CircuitFixtureBase {
  readonly kind: "door";
}

export interface BridgeFixture extends CircuitFixtureBase {
  readonly kind: "bridge";
}

export interface DisposalFixture extends FixtureBase {
  readonly kind: "disposal";
}

export interface GateFixture extends CircuitFixtureBase {
  readonly kind: "gate";
}

export type FixtureDefinition =
  | PlateFixture
  | RelayFixture
  | SocketFixture
  | DoorFixture
  | BridgeFixture
  | DisposalFixture
  | GateFixture;

export interface CellDefinition {
  readonly terrain: TerrainKind;
  readonly fixture?: FixtureDefinition;
}

export interface ObjectDefinition {
  readonly id: string;
  readonly kind: ObjectKind;
  readonly position: Coord;
}

export interface LevelDefinition {
  readonly generatorVersion: string;
  readonly width: number;
  readonly height: number;
  /** Canonically serialized by id, irrespective of the input array order. */
  readonly channels: readonly ChannelDefinition[];
  /** Exactly width * height entries, already addressed in row-major order. */
  readonly cells: readonly CellDefinition[];
  readonly playerStart: Coord;
  /** Canonically serialized and settled by stable object id. */
  readonly objects: readonly ObjectDefinition[];
}

export interface ObjectState {
  readonly id: string;
  readonly kind: ObjectKind;
  readonly position: Coord;
}

export interface InstalledCellState {
  readonly socketId: string;
  readonly objectId: string;
}

/**
 * The complete canonical puzzle configuration q. Derived circuit and consumer
 * values intentionally do not live here.
 */
export interface PuzzleState {
  /** Null only in a classified physical-failure transition result. */
  readonly player: Coord | null;
  readonly objects: readonly ObjectState[];
  readonly activeRelayIds: readonly string[];
  readonly installedCells: readonly InstalledCellState[];
  readonly collapsedFractures: readonly Coord[];
  readonly removedObjectIds: readonly string[];
}

export type SourceKind = "plate" | "relay" | "socket";
export type ConsumerKind = "door" | "bridge" | "gate";

export interface SourceOutput {
  readonly fixtureId: string;
  readonly kind: SourceKind;
  readonly channel: string;
  readonly position: Coord;
  readonly active: boolean;
}

export interface ChannelValue {
  readonly id: string;
  readonly symbol: string;
  readonly active: boolean;
}

export interface ConsumerState {
  readonly fixtureId: string;
  readonly kind: ConsumerKind;
  readonly channel: string;
  readonly position: Coord;
  /** Raw simultaneous channel value. */
  readonly powered: boolean;
  /** Whether an entity is currently supported/allowed on this consumer. */
  readonly passable: boolean;
  /** Only doors can be jammed; false for bridge and gate records. */
  readonly jammed: boolean;
}

export interface DerivedMechanics {
  readonly sources: readonly SourceOutput[];
  readonly channels: readonly ChannelValue[];
  readonly consumers: readonly ConsumerState[];
}

export type PhysicalFailureReason = "vacuum" | "bridge-lost";
export type CausalFailureReason = "no-evacuation-route";

export type Outcome =
  | { readonly kind: "playing" }
  | {
      readonly kind: "physical-failure";
      readonly reason: PhysicalFailureReason;
      readonly position: Coord;
      readonly fixtureId?: string;
    }
  | {
      readonly kind: "causal-failure";
      readonly reason: CausalFailureReason;
    }
  | {
      readonly kind: "victory";
      readonly gateId: string;
      readonly position: Coord;
    };

export interface EngineSnapshot {
  readonly state: PuzzleState;
  readonly derived: DerivedMechanics;
  readonly outcome: Outcome;
}

export type EntityRef =
  | { readonly kind: "player" }
  | {
      readonly kind: "object";
      readonly objectId: string;
      readonly objectKind: ObjectKind;
    };

export type RemovalReason = "vacuum" | "bridge-lost" | "disposal";

export type BlockedReason =
  | "terminal"
  | "edge"
  | "bulkhead"
  | "closed-door"
  | "inactive-gate"
  | "installed-socket"
  | "disposal-blocks-player"
  | "gate-blocks-object"
  | "occupied"
  | "chain-push"
  | "unsupported-terrain";

export type EngineEvent =
  | {
      readonly type: "blocked";
      readonly action: Direction;
      readonly attempt: "walk" | "push";
      readonly reason: BlockedReason;
      readonly at: Coord;
    }
  | {
      readonly type: "player-moved";
      readonly from: Coord;
      readonly to: Coord;
    }
  | {
      readonly type: "object-pushed";
      readonly objectId: string;
      readonly objectKind: ObjectKind;
      readonly from: Coord;
      readonly to: Coord;
    }
  | {
      readonly type: "entity-exited";
      readonly entity: EntityRef;
      readonly position: Coord;
    }
  | {
      readonly type: "entity-entered";
      readonly entity: EntityRef;
      readonly position: Coord;
    }
  | {
      readonly type: "relay-toggled";
      readonly fixtureId: string;
      readonly channel: string;
      readonly position: Coord;
      readonly active: boolean;
    }
  | {
      readonly type: "socket-docked";
      readonly fixtureId: string;
      readonly channel: string;
      readonly objectId: string;
      readonly position: Coord;
    }
  | {
      readonly type: "fracture-collapsed";
      readonly position: Coord;
    }
  | {
      readonly type: "object-removed";
      readonly objectId: string;
      readonly objectKind: ObjectKind;
      readonly position: Coord;
      readonly reason: RemovalReason;
      readonly fixtureId?: string;
    }
  | {
      readonly type: "source-changed";
      readonly fixtureId: string;
      readonly sourceKind: SourceKind;
      readonly channel: string;
      readonly position: Coord;
      readonly active: boolean;
    }
  | {
      readonly type: "channel-changed";
      readonly channel: string;
      readonly active: boolean;
    }
  | {
      readonly type: "consumer-changed";
      readonly fixtureId: string;
      readonly consumerKind: ConsumerKind;
      readonly channel: string;
      readonly position: Coord;
      readonly powered: boolean;
      readonly passable: boolean;
      readonly jammed: boolean;
    }
  | {
      readonly type: "gate-entered";
      readonly fixtureId: string;
      readonly channel: string;
      readonly position: Coord;
    }
  | {
      readonly type: "physical-failure";
      readonly reason: PhysicalFailureReason;
      readonly position: Coord;
      readonly fixtureId?: string;
    }
  | {
      readonly type: "causal-failure";
      readonly reason: CausalFailureReason;
    }
  | {
      readonly type: "victory";
      readonly gateId: string;
      readonly position: Coord;
    };

export interface TransitionOptions {
  /**
   * Exact canonical keys in the certified winning set. When omitted, causal
   * classification is deliberately skipped for solver enumeration.
   */
  readonly winningStateKeys?: ReadonlySet<string>;
}

export interface TransitionResult {
  readonly accepted: boolean;
  readonly pushed: boolean;
  readonly action: Direction;
  readonly before: EngineSnapshot;
  readonly after: EngineSnapshot;
  readonly blockedReason?: BlockedReason;
  readonly events: readonly EngineEvent[];
  readonly internalPasses: number;
}

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly position?: Coord;
  readonly id?: string;
}

export class InvalidLevelError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "InvalidLevelError";
    this.issues = issues;
  }
}

export class CascadeLimitError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Turn resolution exceeded the ${limit}-pass cascade limit`);
    this.name = "CascadeLimitError";
    this.limit = limit;
  }
}

export function coordsEqual(a: Coord | null, b: Coord | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y);
}

export function addDirection(position: Coord, direction: Direction): Coord {
  const delta = DIRECTION_DELTAS[direction];
  return { x: position.x + delta.x, y: position.y + delta.y };
}

export function isInside(level: Pick<LevelDefinition, "width" | "height">, position: Coord): boolean {
  return (
    Number.isInteger(position.x) &&
    Number.isInteger(position.y) &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < level.width &&
    position.y < level.height
  );
}

export function cellIndex(level: Pick<LevelDefinition, "width" | "height">, position: Coord): number {
  return isInside(level, position) ? position.y * level.width + position.x : -1;
}

export function indexCoord(level: Pick<LevelDefinition, "width">, index: number): Coord {
  return { x: index % level.width, y: Math.floor(index / level.width) };
}

export function cellAt(level: LevelDefinition, position: Coord): CellDefinition | undefined {
  const index = cellIndex(level, position);
  return index < 0 ? undefined : level.cells[index];
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareCoordsRowMajor(a: Coord, b: Coord): number {
  return a.y - b.y || a.x - b.x;
}
