import {
  DIRECTION_ORDER,
  type ConsumerKind,
  type Coord,
  type Direction,
  type EngineEvent,
  type EngineSnapshot,
  type FixtureDefinition,
  type LevelDefinition,
  type ObjectKind,
  type RemovalReason,
  type SourceKind,
  cellAt,
  coordsEqual,
  isInside,
} from "./model.ts";
import { fixturesWithPositions } from "./mechanics.ts";
import type { MilestoneContext, MilestoneDefinition } from "./solver.ts";

export const MILESTONE_DSL_VERSION = "milestone-dsl-v1" as const;

/**
 * Closed families used by catalog certificates. Movement and evacuation are
 * deliberately universal families and do not contribute to g4 K_mandatory.
 */
export const MILESTONE_MECHANIC_FAMILIES = Object.freeze([
  "movement",
  "pushing",
  "power",
  "momentary-circuit",
  "permanent-sources",
  "consumers",
  "hazards",
  "irreversible-terrain",
  "evacuation",
] as const);

export type MilestoneMechanicFamily = (typeof MILESTONE_MECHANIC_FAMILIES)[number];

export const RATED_MILESTONE_FAMILIES: ReadonlySet<MilestoneMechanicFamily> = new Set([
  "pushing",
  "power",
  "momentary-circuit",
  "permanent-sources",
  "consumers",
  "hazards",
  "irreversible-terrain",
]);

export const MILESTONE_EVENT_TYPES = Object.freeze([
  "player-moved",
  "object-pushed",
  "relay-toggled",
  "socket-docked",
  "fracture-collapsed",
  "object-removed",
  "source-changed",
  "channel-changed",
  "consumer-changed",
  "gate-entered",
] as const);

export type MilestoneEventType = (typeof MILESTONE_EVENT_TYPES)[number];

/**
 * A deliberately flat, JSON-friendly event filter. Runtime validation rejects
 * fields which are meaningless for the selected event type.
 */
export interface MilestoneEventTrigger {
  readonly event: MilestoneEventType;
  readonly action?: Direction;
  readonly fixtureId?: string;
  readonly objectId?: string;
  readonly objectKind?: ObjectKind;
  readonly channel?: string;
  readonly position?: Coord;
  readonly from?: Coord;
  readonly to?: Coord;
  readonly active?: boolean;
  readonly sourceKind?: SourceKind;
  readonly consumerKind?: ConsumerKind;
  readonly powered?: boolean;
  readonly passable?: boolean;
  readonly jammed?: boolean;
  readonly reason?: RemovalReason;
}

export type MilestoneStatePredicate =
  | {
      readonly entityAt: {
        readonly entityId: "player" | string;
        readonly position: Coord;
      };
    }
  | {
      readonly relayState: {
        readonly fixtureId: string;
        readonly active: boolean;
      };
    }
  | {
      readonly socketInstallation: {
        readonly fixtureId: string;
        readonly installed: boolean;
        readonly objectId?: string;
      };
    }
  | {
      readonly fractureState: {
        readonly position: Coord;
        readonly collapsed: boolean;
      };
    }
  | {
      readonly objectRemoved: {
        readonly objectId: string;
        readonly removed: boolean;
      };
    }
  | { readonly channelActive: string }
  | { readonly channelInactive: string }
  | {
      readonly consumerState: {
        readonly fixtureId: string;
        readonly powered?: boolean;
        readonly passable?: boolean;
        readonly jammed?: boolean;
      };
    };

export type MilestoneGuardLeaf =
  | { readonly beforeState: MilestoneStatePredicate }
  | { readonly afterState: MilestoneStatePredicate };

export type MilestoneGuard =
  | MilestoneGuardLeaf
  | { readonly all: readonly MilestoneGuard[] }
  | { readonly any: readonly MilestoneGuard[] }
  | { readonly not: MilestoneGuardLeaf };

export type MilestoneTrigger =
  | MilestoneEventTrigger
  | {
      /** The predicate must change truth value across the transition. */
      readonly delta: {
        readonly predicate: MilestoneStatePredicate;
        readonly from: boolean;
        readonly to: boolean;
      };
    };

export interface MilestoneSpec {
  readonly schemaVersion: typeof MILESTONE_DSL_VERSION;
  readonly id: string;
  readonly family: MilestoneMechanicFamily;
  readonly trigger: MilestoneTrigger;
  readonly guard?: MilestoneGuard;
  /** The Nth matching transition since the initial state, in 1..16. */
  readonly occurrence: number;
  /** Reciprocal declaration required when two instances intentionally co-emit. */
  readonly coEmitsWith?: readonly string[];
}

export class InvalidMilestoneSpecError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InvalidMilestoneSpecError";
    this.path = path;
  }
}

interface ValidationIndex {
  readonly level: LevelDefinition;
  readonly fixtures: ReadonlyMap<string, Readonly<{ fixture: FixtureDefinition; position: Coord }>>;
  readonly objects: ReadonlyMap<string, ObjectKind>;
  readonly channels: ReadonlySet<string>;
}

const ID_PATTERN = /^[a-z][a-z0-9.-]{0,47}$/;
const EVENT_FIELDS: Readonly<Record<MilestoneEventType, ReadonlySet<string>>> = Object.freeze({
  "player-moved": new Set(["event", "action", "from", "to"]),
  "object-pushed": new Set(["event", "action", "objectId", "objectKind", "from", "to"]),
  "relay-toggled": new Set(["event", "action", "fixtureId", "channel", "position", "active"]),
  "socket-docked": new Set(["event", "action", "fixtureId", "objectId", "channel", "position"]),
  "fracture-collapsed": new Set(["event", "action", "position"]),
  "object-removed": new Set([
    "event", "action", "fixtureId", "objectId", "objectKind", "position", "reason",
  ]),
  "source-changed": new Set([
    "event", "action", "fixtureId", "channel", "position", "active", "sourceKind",
  ]),
  "channel-changed": new Set(["event", "action", "channel", "active"]),
  "consumer-changed": new Set([
    "event", "action", "fixtureId", "channel", "position", "consumerKind", "powered",
    "passable", "jammed",
  ]),
  "gate-entered": new Set(["event", "action", "fixtureId", "channel", "position"]),
});

/** Validate, clone, and deeply freeze untrusted data from a catalog. */
export function validateMilestoneSpecs(
  level: LevelDefinition,
  input: unknown,
): readonly MilestoneSpec[] {
  if (!Array.isArray(input)) {
    throw new InvalidMilestoneSpecError("milestones", "must be an array");
  }
  if (input.length > 16) {
    throw new InvalidMilestoneSpecError("milestones", "at most 16 instances are permitted");
  }
  const index = createValidationIndex(level);
  const normalized = input.map((entry, position) => validateSpec(entry, position, index));
  const byId = new Map<string, MilestoneSpec>();
  for (const spec of normalized) {
    if (byId.has(spec.id)) {
      throw new InvalidMilestoneSpecError(`milestones.${spec.id}`, "duplicate milestone id");
    }
    byId.set(spec.id, spec);
  }

  for (const spec of normalized) {
    for (const otherId of spec.coEmitsWith ?? []) {
      const other = byId.get(otherId);
      if (other === undefined) {
        throw new InvalidMilestoneSpecError(
          `milestones.${spec.id}.coEmitsWith`,
          `references unknown milestone '${otherId}'`,
        );
      }
      if (!(other.coEmitsWith ?? []).includes(spec.id)) {
        throw new InvalidMilestoneSpecError(
          `milestones.${spec.id}.coEmitsWith`,
          `co-emission with '${otherId}' must be declared reciprocally`,
        );
      }
    }
  }

  const byObservation = new Map<string, MilestoneSpec[]>();
  for (const spec of normalized) {
    const key = observationKey(spec);
    const group = byObservation.get(key) ?? [];
    group.push(spec);
    byObservation.set(key, group);
  }
  for (const group of byObservation.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const a = group[left]!;
        const b = group[right]!;
        if (a.occurrence !== b.occurrence) continue;
        if (!(a.coEmitsWith ?? []).includes(b.id)) {
          throw new InvalidMilestoneSpecError(
            `milestones.${a.id}`,
            `duplicates ${b.id}'s transition occurrence without reciprocal coEmitsWith`,
          );
        }
      }
    }
  }
  return Object.freeze(normalized);
}

/** Compile the closed language to the solver's predicate/monitor contract. */
export function compileMilestoneSpecs(
  level: LevelDefinition,
  input: unknown,
): readonly MilestoneDefinition[] {
  const specs = validateMilestoneSpecs(level, input);
  return Object.freeze(specs.map((spec) => Object.freeze({
    id: spec.id,
    family: spec.family,
    occurrence: spec.occurrence,
    observationKey: observationKey(spec),
    coEmitsWith: spec.coEmitsWith ?? Object.freeze([]),
    test: (context: MilestoneContext): boolean => (
      triggerMatches(spec.trigger, context)
      && (spec.guard === undefined || guardMatches(spec.guard, context))
    ),
  })));
}

function createValidationIndex(level: LevelDefinition): ValidationIndex {
  const fixtures = new Map<string, Readonly<{ fixture: FixtureDefinition; position: Coord }>>();
  for (const entry of fixturesWithPositions(level)) fixtures.set(entry.fixture.id, entry);
  return {
    level,
    fixtures,
    objects: new Map(level.objects.map((object) => [object.id, object.kind])),
    channels: new Set(level.channels.map((channel) => channel.id)),
  };
}

function validateSpec(value: unknown, position: number, index: ValidationIndex): MilestoneSpec {
  const path = `milestones[${position}]`;
  const record = requireRecord(value, path);
  requireKeys(record, path, [
    "schemaVersion", "id", "family", "trigger", "occurrence",
  ], ["guard", "coEmitsWith"]);
  if (record.schemaVersion !== MILESTONE_DSL_VERSION) {
    fail(`${path}.schemaVersion`, `must equal '${MILESTONE_DSL_VERSION}'`);
  }
  if (typeof record.id !== "string" || !ID_PATTERN.test(record.id)) {
    fail(`${path}.id`, "must match /^[a-z][a-z0-9.-]{0,47}$/");
  }
  if (
    typeof record.family !== "string"
    || !(MILESTONE_MECHANIC_FAMILIES as readonly string[]).includes(record.family)
  ) {
    fail(`${path}.family`, "is not a supported mechanic family");
  }
  if (!Number.isInteger(record.occurrence) || (record.occurrence as number) < 1 || (record.occurrence as number) > 16) {
    fail(`${path}.occurrence`, "must be an integer in 1..16");
  }
  const trigger = validateTrigger(record.trigger, `${path}.trigger`, index);
  validateFamilyCompatibility(
    record.family as MilestoneMechanicFamily,
    trigger,
    `${path}.family`,
    index,
  );
  const guard = record.guard === undefined
    ? undefined
    : validateGuard(record.guard, `${path}.guard`, index, 0, { count: 0 });
  const coEmitsWith = record.coEmitsWith === undefined
    ? undefined
    : validateStringArray(record.coEmitsWith, `${path}.coEmitsWith`, record.id as string);
  return deepFreeze({
    schemaVersion: MILESTONE_DSL_VERSION,
    id: record.id as string,
    family: record.family as MilestoneMechanicFamily,
    trigger,
    occurrence: record.occurrence as number,
    ...(guard === undefined ? {} : { guard }),
    ...(coEmitsWith === undefined ? {} : { coEmitsWith }),
  });
}

function validateFamilyCompatibility(
  family: MilestoneMechanicFamily,
  trigger: MilestoneTrigger,
  path: string,
  index: ValidationIndex,
): void {
  const expected = familyForTrigger(trigger, index);
  const compatible: readonly MilestoneMechanicFamily[] = (
    "event" in trigger && trigger.event === "socket-docked"
  )
    // Docking is both the permanent resource commitment and the production of
    // circuit power; this preserves the DSL's published socket/power example.
    ? ["permanent-sources", "power"]
    : [expected];
  if (!compatible.includes(family)) {
    fail(path, `must be ${compatible.map((entry) => `'${entry}'`).join(" or ")} for this trigger (received '${family}')`);
  }
}

function familyForTrigger(
  trigger: MilestoneTrigger,
  index: ValidationIndex,
): MilestoneMechanicFamily {
  if ("delta" in trigger) return familyForStatePredicate(trigger.delta.predicate, index);
  switch (trigger.event) {
    case "player-moved":
      return "movement";
    case "object-pushed":
      return "pushing";
    case "relay-toggled":
    case "socket-docked":
      return "permanent-sources";
    case "fracture-collapsed":
      return "irreversible-terrain";
    case "channel-changed":
      return "power";
    case "consumer-changed": {
      const fixtureKind = trigger.fixtureId === undefined
        ? undefined
        : index.fixtures.get(trigger.fixtureId)?.fixture.kind;
      const consumerKind = trigger.consumerKind ?? (
        fixtureKind === "door" || fixtureKind === "bridge" || fixtureKind === "gate"
          ? fixtureKind
          : undefined
      );
      if (consumerKind === undefined) {
        fail("trigger.consumerKind", "consumer-changed milestones must identify their consumer kind");
      }
      if (consumerKind === "gate") {
        fail("trigger.consumerKind", "gate state is universal; use gate-entered/evacuation");
      }
      return "consumers";
    }
    case "gate-entered":
      return "evacuation";
    case "source-changed": {
      const fixtureKind = trigger.fixtureId === undefined
        ? undefined
        : index.fixtures.get(trigger.fixtureId)?.fixture.kind;
      const sourceKind = trigger.sourceKind ?? (
        fixtureKind === "plate" || fixtureKind === "relay" || fixtureKind === "socket"
          ? fixtureKind
          : undefined
      );
      if (sourceKind === "plate") return "momentary-circuit";
      if (sourceKind === "relay" || sourceKind === "socket") return "permanent-sources";
      fail("trigger.sourceKind", "source-changed milestones must identify their source kind");
    }
    case "object-removed": {
      const fixtureKind = trigger.fixtureId === undefined
        ? undefined
        : index.fixtures.get(trigger.fixtureId)?.fixture.kind;
      if (trigger.reason === "disposal" || fixtureKind === "disposal") {
        return "irreversible-terrain";
      }
      if (trigger.reason === "vacuum" || trigger.reason === "bridge-lost" || fixtureKind === "bridge") {
        return "hazards";
      }
      fail("trigger.reason", "object-removed milestones must identify disposal or hazard removal");
    }
  }
}

function familyForStatePredicate(
  predicate: MilestoneStatePredicate,
  index: ValidationIndex,
): MilestoneMechanicFamily {
  if ("entityAt" in predicate) {
    return predicate.entityAt.entityId === "player" ? "movement" : "pushing";
  }
  if ("relayState" in predicate || "socketInstallation" in predicate) {
    return "permanent-sources";
  }
  if ("fractureState" in predicate) return "irreversible-terrain";
  if ("objectRemoved" in predicate) {
    const hasDisposal = index.level.cells.some((cell) => cell.fixture?.kind === "disposal");
    const hasHazardRemoval = index.level.cells.some((cell) => (
      cell.terrain === "vacuum" || cell.fixture?.kind === "bridge"
    ));
    if (hasDisposal !== hasHazardRemoval) {
      return hasDisposal ? "irreversible-terrain" : "hazards";
    }
    fail(
      "trigger.delta.predicate",
      "objectRemoved delta has an ambiguous cause; use object-removed with reason",
    );
  }
  if ("channelActive" in predicate || "channelInactive" in predicate) return "power";
  if ("consumerState" in predicate
    && index.fixtures.get(predicate.consumerState.fixtureId)?.fixture.kind === "gate") {
    fail("trigger.delta.predicate", "gate state is universal; use gate-entered/evacuation");
  }
  return "consumers";
}

function validateTrigger(value: unknown, path: string, index: ValidationIndex): MilestoneTrigger {
  const record = requireRecord(value, path);
  if (Object.hasOwn(record, "delta")) {
    requireKeys(record, path, ["delta"]);
    const delta = requireRecord(record.delta, `${path}.delta`);
    requireKeys(delta, `${path}.delta`, ["predicate", "from", "to"]);
    if (typeof delta.from !== "boolean" || typeof delta.to !== "boolean" || delta.from === delta.to) {
      fail(`${path}.delta`, "from and to must be different booleans");
    }
    return deepFreeze({
      delta: {
        predicate: validateStatePredicate(delta.predicate, `${path}.delta.predicate`, index),
        from: delta.from,
        to: delta.to,
      },
    });
  }
  if (
    typeof record.event !== "string"
    || !(MILESTONE_EVENT_TYPES as readonly string[]).includes(record.event)
  ) {
    fail(`${path}.event`, "is not a supported transition event");
  }
  const event = record.event as MilestoneEventType;
  requireKeys(record, path, ["event"], [...EVENT_FIELDS[event]!].filter((key) => key !== "event"));
  validateEventFields(record, path, event, index);
  return deepFreeze(cloneJson(record) as unknown as MilestoneEventTrigger);
}

function validateEventFields(
  record: Readonly<Record<string, unknown>>,
  path: string,
  event: MilestoneEventType,
  index: ValidationIndex,
): void {
  if (record.action !== undefined && !DIRECTION_ORDER.includes(record.action as Direction)) {
    fail(`${path}.action`, "must be N, E, S, or W");
  }
  for (const field of ["fixtureId", "objectId", "channel"] as const) {
    if (record[field] !== undefined && (typeof record[field] !== "string" || record[field].length === 0)) {
      fail(`${path}.${field}`, "must be a non-empty string");
    }
  }
  for (const field of ["position", "from", "to"] as const) {
    if (record[field] !== undefined) validateCoord(record[field], `${path}.${field}`, index.level);
  }
  for (const field of ["active", "powered", "passable", "jammed"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "boolean") {
      fail(`${path}.${field}`, "must be boolean");
    }
  }
  if (record.objectKind !== undefined && record.objectKind !== "cargo" && record.objectKind !== "reactor-cell") {
    fail(`${path}.objectKind`, "must be cargo or reactor-cell");
  }
  if (record.sourceKind !== undefined && !["plate", "relay", "socket"].includes(record.sourceKind as string)) {
    fail(`${path}.sourceKind`, "must be plate, relay, or socket");
  }
  if (record.consumerKind !== undefined && !["door", "bridge", "gate"].includes(record.consumerKind as string)) {
    fail(`${path}.consumerKind`, "must be door, bridge, or gate");
  }
  if (record.reason !== undefined && !["vacuum", "bridge-lost", "disposal"].includes(record.reason as string)) {
    fail(`${path}.reason`, "must be vacuum, bridge-lost, or disposal");
  }

  if (record.channel !== undefined && !index.channels.has(record.channel as string)) {
    fail(`${path}.channel`, `unknown channel '${String(record.channel)}'`);
  }
  if (record.objectId !== undefined) {
    const kind = index.objects.get(record.objectId as string);
    if (kind === undefined) fail(`${path}.objectId`, `unknown movable object '${String(record.objectId)}'`);
    if (record.objectKind !== undefined && record.objectKind !== kind) {
      fail(`${path}.objectKind`, `does not match object '${String(record.objectId)}'`);
    }
  }

  const fixtureEntry = record.fixtureId === undefined
    ? undefined
    : index.fixtures.get(record.fixtureId as string);
  if (record.fixtureId !== undefined && fixtureEntry === undefined) {
    fail(`${path}.fixtureId`, `unknown fixture '${String(record.fixtureId)}'`);
  }
  const requiredKinds: Partial<Record<MilestoneEventType, readonly FixtureDefinition["kind"][]>> = {
    "relay-toggled": ["relay"],
    "socket-docked": ["socket"],
    "source-changed": ["plate", "relay", "socket"],
    "consumer-changed": ["door", "bridge", "gate"],
    "gate-entered": ["gate"],
  };
  const compatibleKinds = requiredKinds[event];
  if (fixtureEntry !== undefined && compatibleKinds !== undefined
    && !compatibleKinds.includes(fixtureEntry.fixture.kind)) {
    fail(`${path}.fixtureId`, `fixture kind '${fixtureEntry.fixture.kind}' cannot emit ${event}`);
  }
  if (fixtureEntry !== undefined && record.position !== undefined
    && !coordsEqual(fixtureEntry.position, record.position as Coord)) {
    fail(`${path}.position`, `does not match fixture '${fixtureEntry.fixture.id}'`);
  }
  if (fixtureEntry !== undefined && record.channel !== undefined
    && fixtureEntry.fixture.kind !== "disposal"
    && fixtureEntry.fixture.channel !== record.channel) {
    fail(`${path}.channel`, `does not match fixture '${fixtureEntry.fixture.id}'`);
  }
  if (fixtureEntry !== undefined && record.sourceKind !== undefined
    && fixtureEntry.fixture.kind !== record.sourceKind) {
    fail(`${path}.sourceKind`, `does not match fixture '${fixtureEntry.fixture.id}'`);
  }
  if (fixtureEntry !== undefined && record.consumerKind !== undefined
    && fixtureEntry.fixture.kind !== record.consumerKind) {
    fail(`${path}.consumerKind`, `does not match fixture '${fixtureEntry.fixture.id}'`);
  }
  if (event === "object-removed" && fixtureEntry !== undefined
    && fixtureEntry.fixture.kind !== "bridge" && fixtureEntry.fixture.kind !== "disposal") {
    fail(`${path}.fixtureId`, "object removal fixtures must be a bridge or disposal");
  }
  if (event === "fracture-collapsed" && record.position !== undefined
    && cellAt(index.level, record.position as Coord)?.terrain !== "fracture") {
    fail(`${path}.position`, "must reference fracture terrain");
  }
  if (event === "socket-docked" && record.objectId !== undefined
    && index.objects.get(record.objectId as string) !== "reactor-cell") {
    fail(`${path}.objectId`, "socket docking requires a reactor-cell");
  }
}

function validateGuard(
  value: unknown,
  path: string,
  index: ValidationIndex,
  depth: number,
  budget: { count: number },
): MilestoneGuard {
  budget.count += 1;
  if (budget.count > 32) fail(path, "guard contains more than 32 nodes");
  if (depth > 4) fail(path, "guard nesting exceeds four levels");
  const record = requireRecord(value, path);
  const keys = Object.keys(record);
  if (keys.length !== 1) fail(path, "must contain exactly one guard operator");
  const operator = keys[0]!;
  if (operator === "beforeState" || operator === "afterState") {
    return deepFreeze({
      [operator]: validateStatePredicate(record[operator], `${path}.${operator}`, index),
    } as unknown as MilestoneGuardLeaf);
  }
  if (operator === "not") {
    const child = requireRecord(record.not, `${path}.not`);
    const childKeys = Object.keys(child);
    if (childKeys.length !== 1 || (childKeys[0] !== "beforeState" && childKeys[0] !== "afterState")) {
      fail(`${path}.not`, "may only wrap a beforeState or afterState leaf");
    }
    return deepFreeze({
      not: validateGuard(record.not, `${path}.not`, index, depth + 1, budget) as MilestoneGuardLeaf,
    });
  }
  if (operator !== "all" && operator !== "any") fail(path, `unknown guard operator '${operator}'`);
  const children = record[operator];
  if (!Array.isArray(children) || children.length < 1 || children.length > 8) {
    fail(`${path}.${operator}`, "must contain 1..8 guard nodes");
  }
  return deepFreeze({
    [operator]: children.map((child, childIndex) => validateGuard(
      child,
      `${path}.${operator}[${childIndex}]`,
      index,
      depth + 1,
      budget,
    )),
  } as unknown as MilestoneGuard);
}

function validateStatePredicate(
  value: unknown,
  path: string,
  index: ValidationIndex,
): MilestoneStatePredicate {
  const record = requireRecord(value, path);
  const keys = Object.keys(record);
  if (keys.length !== 1) fail(path, "must contain exactly one state predicate");
  const kind = keys[0]!;
  if (kind === "channelActive" || kind === "channelInactive") {
    if (typeof record[kind] !== "string" || !index.channels.has(record[kind] as string)) {
      fail(`${path}.${kind}`, "must reference an existing channel");
    }
    return deepFreeze({ [kind]: record[kind] } as unknown as MilestoneStatePredicate);
  }
  const detail = requireRecord(record[kind], `${path}.${kind}`);
  switch (kind) {
    case "entityAt": {
      requireKeys(detail, `${path}.${kind}`, ["entityId", "position"]);
      if (detail.entityId !== "player"
        && (typeof detail.entityId !== "string" || !index.objects.has(detail.entityId))) {
        fail(`${path}.${kind}.entityId`, "must be player or an existing movable object id");
      }
      validateCoord(detail.position, `${path}.${kind}.position`, index.level);
      break;
    }
    case "relayState": {
      requireKeys(detail, `${path}.${kind}`, ["fixtureId", "active"]);
      requireFixtureKind(detail.fixtureId, ["relay"], `${path}.${kind}.fixtureId`, index);
      if (typeof detail.active !== "boolean") fail(`${path}.${kind}.active`, "must be boolean");
      break;
    }
    case "socketInstallation": {
      requireKeys(detail, `${path}.${kind}`, ["fixtureId", "installed"], ["objectId"]);
      requireFixtureKind(detail.fixtureId, ["socket"], `${path}.${kind}.fixtureId`, index);
      if (typeof detail.installed !== "boolean") fail(`${path}.${kind}.installed`, "must be boolean");
      if (detail.objectId !== undefined
        && (typeof detail.objectId !== "string" || !index.objects.has(detail.objectId))) {
        fail(`${path}.${kind}.objectId`, "must reference an existing movable object");
      }
      if (detail.installed === false && detail.objectId !== undefined) {
        fail(`${path}.${kind}.objectId`, "cannot constrain an object when installed is false");
      }
      break;
    }
    case "fractureState": {
      requireKeys(detail, `${path}.${kind}`, ["position", "collapsed"]);
      const coordinate = validateCoord(detail.position, `${path}.${kind}.position`, index.level);
      if (cellAt(index.level, coordinate)?.terrain !== "fracture") {
        fail(`${path}.${kind}.position`, "must reference fracture terrain");
      }
      if (typeof detail.collapsed !== "boolean") fail(`${path}.${kind}.collapsed`, "must be boolean");
      break;
    }
    case "objectRemoved": {
      requireKeys(detail, `${path}.${kind}`, ["objectId", "removed"]);
      if (typeof detail.objectId !== "string" || !index.objects.has(detail.objectId)) {
        fail(`${path}.${kind}.objectId`, "must reference an existing movable object");
      }
      if (typeof detail.removed !== "boolean") fail(`${path}.${kind}.removed`, "must be boolean");
      break;
    }
    case "consumerState": {
      requireKeys(detail, `${path}.${kind}`, ["fixtureId"], ["powered", "passable", "jammed"]);
      const fixture = requireFixtureKind(
        detail.fixtureId,
        ["door", "bridge", "gate"],
        `${path}.${kind}.fixtureId`,
        index,
      );
      const constrained = ["powered", "passable", "jammed"].filter((field) => detail[field] !== undefined);
      if (constrained.length === 0) fail(`${path}.${kind}`, "must constrain powered, passable, or jammed");
      for (const field of constrained) {
        if (typeof detail[field] !== "boolean") fail(`${path}.${kind}.${field}`, "must be boolean");
      }
      if (detail.jammed !== undefined && fixture.kind !== "door") {
        fail(`${path}.${kind}.jammed`, "only a door can be jammed");
      }
      break;
    }
    default:
      fail(path, `unknown state predicate '${kind}'`);
  }
  return deepFreeze({ [kind]: cloneJson(detail) } as unknown as MilestoneStatePredicate);
}

function requireFixtureKind(
  value: unknown,
  kinds: readonly FixtureDefinition["kind"][],
  path: string,
  index: ValidationIndex,
): FixtureDefinition {
  if (typeof value !== "string") fail(path, "must be a fixture id");
  const entry = index.fixtures.get(value as string);
  if (entry === undefined) fail(path, `unknown fixture '${String(value)}'`);
  if (!kinds.includes(entry.fixture.kind)) {
    fail(path, `fixture '${String(value)}' has incompatible kind '${entry.fixture.kind}'`);
  }
  return entry.fixture;
}

function validateCoord(value: unknown, path: string, level: LevelDefinition): Coord {
  const record = requireRecord(value, path);
  requireKeys(record, path, ["x", "y"]);
  if (!Number.isInteger(record.x) || !Number.isInteger(record.y)) fail(path, "must contain integer x/y");
  const coordinate = { x: record.x as number, y: record.y as number };
  if (!isInside(level, coordinate)) fail(path, "is outside the board");
  return coordinate;
}

function validateStringArray(value: unknown, path: string, selfId: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 15) fail(path, "must be an array with at most 15 ids");
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index];
    if (typeof id !== "string" || !ID_PATTERN.test(id)) fail(`${path}[${index}]`, "is not a milestone id");
    if (id === selfId) fail(`${path}[${index}]`, "cannot reference itself");
    if (ids.has(id)) fail(`${path}[${index}]`, "is duplicated");
    ids.add(id);
  }
  return Object.freeze([...ids].sort());
}

function triggerMatches(trigger: MilestoneTrigger, context: MilestoneContext): boolean {
  if ("delta" in trigger) {
    const before = statePredicateMatches(trigger.delta.predicate, context.transition.before);
    const after = statePredicateMatches(trigger.delta.predicate, context.transition.after);
    return before === trigger.delta.from && after === trigger.delta.to;
  }
  if (trigger.action !== undefined && trigger.action !== context.action) return false;
  return context.transition.events.some((event) => eventMatches(trigger, event));
}

function eventMatches(trigger: MilestoneEventTrigger, event: EngineEvent): boolean {
  if (event.type !== trigger.event) return false;
  const candidate = event as unknown as Record<string, unknown>;
  for (const [key, expected] of Object.entries(trigger)) {
    if (key === "event" || key === "action") continue;
    const actual = candidate[key];
    if (key === "position" || key === "from" || key === "to") {
      if (!isCoord(actual) || !coordsEqual(actual, expected as Coord)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function guardMatches(guard: MilestoneGuard, context: MilestoneContext): boolean {
  if ("beforeState" in guard) return statePredicateMatches(guard.beforeState, context.transition.before);
  if ("afterState" in guard) return statePredicateMatches(guard.afterState, context.transition.after);
  if ("not" in guard) return !guardMatches(guard.not, context);
  if ("all" in guard) return guard.all.every((child) => guardMatches(child, context));
  return guard.any.some((child) => guardMatches(child, context));
}

function statePredicateMatches(predicate: MilestoneStatePredicate, snapshot: EngineSnapshot): boolean {
  if ("entityAt" in predicate) {
    if (predicate.entityAt.entityId === "player") {
      return snapshot.state.player !== null
        && coordsEqual(snapshot.state.player, predicate.entityAt.position);
    }
    return snapshot.state.objects.some((object) => (
      object.id === predicate.entityAt.entityId
      && coordsEqual(object.position, predicate.entityAt.position)
    ));
  }
  if ("relayState" in predicate) {
    return snapshot.state.activeRelayIds.includes(predicate.relayState.fixtureId)
      === predicate.relayState.active;
  }
  if ("socketInstallation" in predicate) {
    const installed = snapshot.state.installedCells.find((cell) => (
      cell.socketId === predicate.socketInstallation.fixtureId
    ));
    if (!predicate.socketInstallation.installed) return installed === undefined;
    return installed !== undefined
      && (predicate.socketInstallation.objectId === undefined
        || installed.objectId === predicate.socketInstallation.objectId);
  }
  if ("fractureState" in predicate) {
    return snapshot.state.collapsedFractures.some((position) => (
      coordsEqual(position, predicate.fractureState.position)
    )) === predicate.fractureState.collapsed;
  }
  if ("objectRemoved" in predicate) {
    return snapshot.state.removedObjectIds.includes(predicate.objectRemoved.objectId)
      === predicate.objectRemoved.removed;
  }
  if ("channelActive" in predicate) {
    return snapshot.derived.channels.some((channel) => (
      channel.id === predicate.channelActive && channel.active
    ));
  }
  if ("channelInactive" in predicate) {
    return snapshot.derived.channels.some((channel) => (
      channel.id === predicate.channelInactive && !channel.active
    ));
  }
  const consumer = snapshot.derived.consumers.find((candidate) => (
    candidate.fixtureId === predicate.consumerState.fixtureId
  ));
  return consumer !== undefined
    && (predicate.consumerState.powered === undefined
      || consumer.powered === predicate.consumerState.powered)
    && (predicate.consumerState.passable === undefined
      || consumer.passable === predicate.consumerState.passable)
    && (predicate.consumerState.jammed === undefined
      || consumer.jammed === predicate.consumerState.jammed);
}

function observationKey(spec: Pick<MilestoneSpec, "trigger" | "guard">): string {
  return canonicalJson({ trigger: spec.trigger, ...(spec.guard === undefined ? {} : { guard: spec.guard }) });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) fail(path, "must be an object");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoord(value: unknown): value is Coord {
  return isRecord(value) && Number.isInteger(value.x) && Number.isInteger(value.y);
}

function requireKeys(
  record: Readonly<Record<string, unknown>>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not allowed");
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail(`${path}.${key}`, "is required");
  }
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)]));
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function fail(path: string, message: string): never {
  throw new InvalidMilestoneSpecError(path, message);
}
