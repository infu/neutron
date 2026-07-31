import { describe, expect, test } from "bun:test";
import {
  MILESTONE_DSL_VERSION,
  InvalidMilestoneSpecError,
  compileMilestoneSpecs,
  validateMilestoneSpecs,
  type MilestoneSpec,
} from "../src/milestone_dsl.ts";
import type { CellDefinition, LevelDefinition } from "../src/model.ts";
import {
  COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
  analyzeLevel,
} from "../src/solver.ts";

function brainLevel(): LevelDefinition {
  const width = 7;
  const height = 7;
  const cells: CellDefinition[] = Array.from(
    { length: width * height },
    () => ({ terrain: "bulkhead" }),
  );
  const floor = (x: number, y: number, fixture?: CellDefinition["fixture"]): void => {
    cells[y * width + x] = {
      terrain: "floor",
      ...(fixture === undefined ? {} : { fixture }),
    };
  };
  for (let x = 1; x <= 5; x += 1) floor(x, 2);
  for (let x = 1; x <= 5; x += 1) floor(x, 3);
  floor(4, 3, { kind: "plate", id: "plate-a", channel: "a" });
  floor(5, 2, { kind: "gate", id: "gate-a", channel: "a" });
  return {
    generatorVersion: "g4",
    width,
    height,
    channels: [{ id: "a", symbol: "A" }],
    cells,
    playerStart: { x: 1, y: 3 },
    objects: [{ id: "cargo-a", kind: "cargo", position: { x: 2, y: 3 } }],
  };
}

function occurrenceSpecs(): readonly MilestoneSpec[] {
  const trigger = { event: "object-pushed", objectId: "cargo-a" } as const;
  return [
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "cargo-phase-1",
      family: "pushing",
      trigger,
      occurrence: 1,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "cargo-phase-2",
      family: "pushing",
      trigger,
      occurrence: 2,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "evacuate",
      family: "evacuation",
      trigger: { event: "gate-entered", fixtureId: "gate-a" },
      occurrence: 1,
    },
  ];
}

function intertwinedLevel(withEarlyRelayBypass = false): LevelDefinition {
  const width = 7;
  const height = 7;
  const cells: CellDefinition[] = Array.from(
    { length: width * height },
    () => ({ terrain: "bulkhead" }),
  );
  const floor = (x: number, y: number, fixture?: CellDefinition["fixture"]): void => {
    cells[y * width + x] = {
      terrain: "floor",
      ...(fixture === undefined ? {} : { fixture }),
    };
  };
  floor(1, 3);
  for (let x = 2; x <= 5; x += 1) floor(x, 3);
  for (let x = 2; x <= 5; x += 1) floor(x, 2);
  if (withEarlyRelayBypass) floor(1, 2);
  floor(2, 2, { kind: "relay", id: "relay-door", channel: "door", initialOn: false });
  floor(4, 3, { kind: "door", id: "door-a", channel: "door" });
  floor(5, 3, { kind: "plate", id: "plate-gate", channel: "gate" });
  floor(2, 1, { kind: "gate", id: "gate-b", channel: "gate" });
  return {
    generatorVersion: "g4",
    width,
    height,
    channels: [{ id: "door", symbol: "D" }, { id: "gate", symbol: "G" }],
    cells,
    playerStart: { x: 1, y: 3 },
    objects: [{ id: "cargo-a", kind: "cargo", position: { x: 2, y: 3 } }],
  };
}

function intertwinedSpecs(): readonly MilestoneSpec[] {
  const push = { event: "object-pushed", objectId: "cargo-a" } as const;
  return [
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "cargo-a-1",
      family: "pushing",
      trigger: push,
      occurrence: 1,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "door-power",
      family: "permanent-sources",
      trigger: { event: "relay-toggled", fixtureId: "relay-door", active: true },
      occurrence: 1,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "cargo-a-2",
      family: "pushing",
      trigger: push,
      occurrence: 2,
    },
  ];
}

function counterintuitiveSourceLevel(): LevelDefinition {
  const width = 7;
  const height = 7;
  const cells: CellDefinition[] = Array.from(
    { length: width * height },
    () => ({ terrain: "bulkhead" }),
  );
  cells[3 * width + 1] = { terrain: "fracture" };
  cells[3 * width + 2] = {
    terrain: "floor",
    fixture: { kind: "relay", id: "relay-a", channel: "a", initialOn: true },
  };
  cells[2 * width + 2] = {
    terrain: "floor",
    fixture: { kind: "relay", id: "relay-b", channel: "b", initialOn: false },
  };
  cells[3 * width + 3] = {
    terrain: "floor",
    fixture: { kind: "gate", id: "gate-a", channel: "a" },
  };
  return {
    generatorVersion: "g4",
    width,
    height,
    channels: [{ id: "a", symbol: "A" }, { id: "b", symbol: "B" }],
    cells,
    playerStart: { x: 1, y: 3 },
    objects: [],
  };
}

function counterintuitiveSourceSpecs(): readonly MilestoneSpec[] {
  return [
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "relay-b-on",
      family: "permanent-sources",
      trigger: { event: "relay-toggled", fixtureId: "relay-b", active: true },
      occurrence: 1,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "relay-a-on",
      family: "permanent-sources",
      trigger: { event: "relay-toggled", fixtureId: "relay-a", active: true },
      occurrence: 1,
    },
    {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "evacuate",
      family: "evacuation",
      trigger: { event: "gate-entered", fixtureId: "gate-a" },
      occurrence: 1,
    },
  ];
}

describe("milestone-dsl-v1", () => {
  test("validates references and compiles only event/delta-anchored predicates", () => {
    const level = brainLevel();
    const guarded: MilestoneSpec = {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "powered-push",
      family: "pushing",
      trigger: { event: "object-pushed", objectId: "cargo-a", to: { x: 4, y: 3 } },
      guard: { afterState: { channelActive: "a" } },
      occurrence: 1,
    };
    const normalized = validateMilestoneSpecs(level, [guarded]);
    expect(normalized).toEqual([guarded]);
    expect(Object.isFrozen(normalized[0])).toBe(true);
    expect(compileMilestoneSpecs(level, normalized)[0]).toMatchObject({
      id: "powered-push",
      occurrence: 1,
    });

    expect(() => validateMilestoneSpecs(level, [{
      ...guarded,
      trigger: { event: "socket-docked", fixtureId: "plate-a" },
    }])).toThrow(InvalidMilestoneSpecError);
    expect(() => validateMilestoneSpecs(level, [{
      ...guarded,
      family: "movement",
      trigger: { event: "player-moved" },
      guard: { afterState: { channelActive: "missing" } },
    }])).toThrow(/existing channel/);
    expect(() => validateMilestoneSpecs(level, [{
      ...guarded,
      trigger: { delta: { predicate: { channelActive: "a" }, from: true, to: true } },
    }])).toThrow(/different booleans/);
    expect(() => validateMilestoneSpecs(level, [{
      ...guarded,
      family: "hazards",
    }])).toThrow(/must be 'pushing'/);
  });

  test("rejects duplicate observations unless phases or reciprocal co-emission distinguish them", () => {
    const first = occurrenceSpecs()[0]!;
    expect(() => validateMilestoneSpecs(brainLevel(), [
      first,
      { ...first, id: "same-transition" },
    ])).toThrow(/duplicates/);
    expect(validateMilestoneSpecs(brainLevel(), occurrenceSpecs())).toHaveLength(3);

    const coA: MilestoneSpec = {
      ...first,
      id: "co-a",
      coEmitsWith: ["co-b"],
    };
    const coB: MilestoneSpec = {
      ...first,
      id: "co-b",
      coEmitsWith: ["co-a"],
    };
    expect(validateMilestoneSpecs(brainLevel(), [coA, coB])).toHaveLength(2);
  });
});

describe("occurrence-aware exact milestone proof", () => {
  test("requires explicit co-emission even when trigger occurrence numbers differ", async () => {
    const pushTwo: MilestoneSpec = {
      ...occurrenceSpecs()[1]!,
      id: "second-push",
    };
    const plateOn: MilestoneSpec = {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "plate-on",
      family: "momentary-circuit",
      trigger: { event: "source-changed", fixtureId: "plate-a", active: true },
      occurrence: 1,
    };
    await expect(analyzeLevel(brainLevel(), { milestoneSpecs: [pushTwo, plateOn] }))
      .rejects.toThrow(/can co-emit/);

    const declared = await analyzeLevel(brainLevel(), {
      milestoneSpecs: [
        { ...pushTwo, coEmitsWith: ["plate-on"] },
        { ...plateOn, coEmitsWith: ["second-push"] },
      ],
    });
    expect(declared.milestones.mandatoryIds).toEqual(["second-push", "plate-on"]);
    expect(declared.milestones.precedence).toEqual([]);
    expect(declared.features.interleaving).toBe(0);
  });

  test("proves A -> B -> A phases from mechanics and rejects a real bypass", async () => {
    const exact = await analyzeLevel(intertwinedLevel(), { milestoneSpecs: intertwinedSpecs() });
    expect(exact.milestones.mandatoryIds).toEqual(["cargo-a-1", "door-power", "cargo-a-2"]);
    expect(exact.milestones.precedence).toContainEqual({ before: "cargo-a-1", after: "door-power" });
    expect(exact.milestones.precedence).toContainEqual({ before: "door-power", after: "cargo-a-2" });
    expect(exact.milestones.dependencyDepth).toBe(3);
    expect(exact.features.mechanicFamiliesMandatory).toBe(2);
    expect(exact.interaction?.recurringResourceLabels).toContain("object:cargo-a");

    const bypass = await analyzeLevel(intertwinedLevel(true), { milestoneSpecs: intertwinedSpecs() });
    expect(bypass.milestones.mandatoryIds).toEqual(["cargo-a-1", "door-power", "cargo-a-2"]);
    expect(bypass.milestones.precedence).not.toContainEqual({
      before: "cargo-a-1",
      after: "door-power",
    });
  });

  test("proves repeated A -> A -> gate phases without declared prerequisites", async () => {
    const analysis = await analyzeLevel(brainLevel(), {
      milestoneSpecs: occurrenceSpecs(),
      requestedDifficulty: 0,
    });
    expect(analysis.solvable).toBe(true);
    expect(analysis.milestones.mandatoryIds).toEqual([
      "cargo-phase-1",
      "cargo-phase-2",
      "evacuate",
    ]);
    expect(analysis.milestones.precedence).toContainEqual({
      before: "cargo-phase-1",
      after: "cargo-phase-2",
    });
    expect(analysis.milestones.precedence).toContainEqual({
      before: "cargo-phase-2",
      after: "evacuate",
    });
    expect(analysis.milestones.dependencyDepth).toBe(3);
    expect(analysis.milestones.mandatoryFamilies).toEqual(["pushing"]);
  });

  test("splits K_present from proven K_mandatory and preserves raw winning keys", async () => {
    const analysis = await analyzeLevel(brainLevel(), { milestoneSpecs: occurrenceSpecs() });
    expect(analysis.features).toMatchObject({
      mechanicFamilies: 1,
      mechanicFamiliesMandatory: 1,
      mechanicFamiliesPresent: 3,
    });
    expect(analysis.macroProjection).toMatchObject({
      schemaVersion: "neutral-scc-v1",
      rawStateCount: analysis.stateCount,
      retainedSolutionCap: 8,
      retainedMaterialSolutionCountExact: false,
    });
    expect(analysis.macroProjection!.macroStateCount).toBeLessThan(analysis.stateCount);
    expect(analysis.winningStateKeys.has(analysis.initialStateKey)).toBe(true);
    expect(analysis.interaction?.preferredCommitmentLabels).toContain("object:cargo-a");
    expect(analysis.interaction?.balancedDecomposition).toMatchObject({
      supported: true,
      value: 0,
    });
    expect(analysis.interaction?.counterintuitiveCommitments).toMatchObject({
      schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
      supported: true,
      value: 0,
      modeledRecurringResourceLabels: [],
    });
  });

  test("proves a forced temporary source disable across every bounded winning trace", async () => {
    const analysis = await analyzeLevel(counterintuitiveSourceLevel(), {
      milestoneSpecs: counterintuitiveSourceSpecs(),
    });
    const repeated = await analyzeLevel(counterintuitiveSourceLevel(), {
      milestoneSpecs: counterintuitiveSourceSpecs(),
    });
    expect(analysis.preferredSolution?.actions).toEqual(["E", "N", "S", "E"]);
    expect(analysis.milestones.precedence).toContainEqual({
      before: "relay-b-on",
      after: "relay-a-on",
    });
    expect(analysis.interaction?.recurringResourceLabels).toContain("fixture:relay-a");
    expect(analysis.interaction?.counterintuitiveCommitments).toMatchObject({
      schemaVersion: COUNTERINTUITIVE_COMMITMENT_METRIC_VERSION,
      supported: true,
      value: 1,
      modeledRecurringResourceLabels: ["fixture:relay-a"],
    });
    expect(repeated.interaction?.counterintuitiveCommitments).toEqual(
      analysis.interaction?.counterintuitiveCommitments,
    );
  });

  test("does not charge the edge which completes a positional future use", async () => {
    const [first, relay] = intertwinedSpecs();
    const positionalFinal: MilestoneSpec = {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "cargo-final",
      family: "pushing",
      trigger: {
        event: "object-pushed",
        objectId: "cargo-a",
        to: { x: 5, y: 3 },
      },
      occurrence: 1,
    };
    const analysis = await analyzeLevel(intertwinedLevel(), {
      milestoneSpecs: [first!, relay!, positionalFinal],
    });
    expect(analysis.interaction?.recurringResourceLabels).toContain("object:cargo-a");
    const counterintuitive = analysis.interaction?.counterintuitiveCommitments;
    expect(counterintuitive).toMatchObject({
      supported: true,
      value: 0,
    });
    expect(counterintuitive?.supported && counterintuitive.modeledRecurringResourceLabels)
      .toContain("object:cargo-a");
  });

  test("rejects an intended occurrence that no reachable trace can emit", async () => {
    const unreachable: MilestoneSpec = {
      ...occurrenceSpecs()[2]!,
      id: "evacuate-twice",
      occurrence: 2,
    };
    await expect(analyzeLevel(brainLevel(), { milestoneSpecs: [unreachable] }))
      .rejects.toThrow(/occurrence 2 is not reachable/);
  });

  test("keeps the executable legacy milestone API stateless", async () => {
    const legacy = await analyzeLevel({ ...brainLevel(), generatorVersion: "g3" }, {
      milestones: [{
        id: "any-push",
        family: "cargo",
        test: ({ transition }) => transition.pushed,
      }],
    });
    expect(legacy.milestones.mandatoryIds).toEqual(["any-push"]);
    expect(legacy.features.mechanicFamiliesPresent).toBeUndefined();
    expect(legacy.macroProjection).toBeUndefined();
  });
});
