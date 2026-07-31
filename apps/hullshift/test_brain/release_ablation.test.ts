import { describe, expect, test } from "bun:test";
import type { CellDefinition, LevelDefinition } from "../src/model.ts";
import {
  MILESTONE_DSL_VERSION,
  type MilestoneSpec,
} from "../src/milestone_dsl.ts";
import {
  ReleaseAblationIncompleteError,
  certifyReleaseFixedPointEssentiality,
  enumerateReleaseAblations,
} from "../scripts/certify_brain_catalog.ts";

function shellCells(width = 7, height = 7): CellDefinition[] {
  return Array.from({ length: width * height }, (_, index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    return {
      terrain: x === 0 || y === 0 || x === width - 1 || y === height - 1
        ? "bulkhead"
        : "floor",
    };
  });
}

function fixedPointLevel(objectIds: readonly string[] = []): LevelDefinition {
  const width = 7;
  const height = 7;
  const cells = shellCells(width, height);
  cells[3 * width + 5] = {
    terrain: "floor",
    fixture: { kind: "gate", id: "gate-a", channel: "a" },
  };
  return {
    generatorVersion: "g4",
    width,
    height,
    channels: [{ id: "a", symbol: "A" }],
    cells,
    playerStart: { x: 1, y: 1 },
    objects: objectIds.map((id, index) => ({
      id,
      kind: "cargo" as const,
      position: { x: 2 + index, y: 2 },
    })),
  };
}

describe("release fixed-point ablation", () => {
  test("covers every supported content class and records only structural exemptions", () => {
    const width = 7;
    const height = 7;
    const cells = shellCells(width, height);
    cells[2 * width + 1] = {
      terrain: "floor",
      fixture: { kind: "plate", id: "plate-a", channel: "a" },
    };
    cells[3 * width + 3] = {
      terrain: "vacuum",
      fixture: { kind: "bridge", id: "bridge-b", channel: "b" },
    };
    cells[3 * width + 5] = {
      terrain: "floor",
      fixture: { kind: "gate", id: "gate-a", channel: "a" },
    };
    cells[2 * width + 3] = { terrain: "bulkhead" };
    cells[2 * width + 4] = { terrain: "bulkhead" };
    const level: LevelDefinition = {
      generatorVersion: "g4",
      width,
      height,
      channels: [{ id: "a", symbol: "A" }, { id: "b", symbol: "B" }],
      cells,
      playerStart: { x: 1, y: 1 },
      objects: [{ id: "cargo-a", kind: "cargo", position: { x: 2, y: 3 } }],
    };

    const inventory = enumerateReleaseAblations(level);
    expect(inventory.proposals.map((proposal) => `${proposal.kind}:${proposal.subject}`)).toEqual([
      "object-remove:cargo-a",
      "fixture-neutralize:bridge-b",
      "fixture-neutralize:plate-a",
      "channel-merge:a->b",
      "channel-merge:b->a",
      "hazard-neutralize:3,3",
      "interior-wall-open:h:3,2-4,2",
    ]);
    expect(inventory.structuralExemptions).toEqual([
      "evacuation-gate:gate-a",
      "exterior-hull-shell:24-cells",
    ]);
    const bridgeProposal = inventory.proposals.find((proposal) => (
      proposal.id === "fixture-neutralize:bridge-b"
    ));
    expect(bridgeProposal?.level.cells[3 * width + 3]).toEqual({ terrain: "floor" });
  });

  test("retains passing simplifications and repeats until a no-change fixed point", async () => {
    const report = await certifyReleaseFixedPointEssentiality({
      level: fixedPointLevel(["cargo-a", "cargo-b"]),
      difficulty: 0,
      milestoneSpecs: [],
      requiredPrecedence: [],
    }, {
      evaluate: async ({ proposal }) => ({
        preservesContract: proposal.kind === "object-remove",
        reason: proposal.kind === "object-remove" ? "test-pass" : "test-reject",
        states: 1,
        transitions: 1,
      }),
    });

    expect(report.essential).toBe(false);
    expect(report.fixedPointReached).toBe(true);
    expect(report.accepted.map((entry) => entry.subject)).toEqual(["cargo-a", "cargo-b"]);
    expect(report.rounds).toBe(3);
    expect(report.exactAnalyses).toBe(2);
  });

  test("counts destruction of an original milestone as a causal-contract rejection", async () => {
    const milestone: MilestoneSpec = {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "push-cargo",
      family: "pushing",
      trigger: { event: "object-pushed", objectId: "cargo-a" },
      occurrence: 1,
    };
    let evaluatorCalls = 0;
    const report = await certifyReleaseFixedPointEssentiality({
      level: fixedPointLevel(["cargo-a"]),
      difficulty: 0,
      milestoneSpecs: [milestone],
      requiredPrecedence: [],
    }, {
      evaluate: async () => {
        evaluatorCalls += 1;
        return {
          preservesContract: true,
          reason: "must-not-run",
          states: 1,
          transitions: 1,
        };
      },
    });
    expect(report.essential).toBe(true);
    expect(report.structuralRejections).toBe(1);
    expect(report.exactAnalyses).toBe(0);
    expect(evaluatorCalls).toBe(0);
  });

  test("rewrites milestone channel references for a genuine channel merge", async () => {
    const level = fixedPointLevel();
    const cells = [...level.cells];
    cells[2 * level.width + 2] = {
      terrain: "floor",
      fixture: { kind: "plate", id: "plate-b", channel: "b" },
    };
    const twoChannels: LevelDefinition = {
      ...level,
      channels: [...level.channels, { id: "b", symbol: "B" }],
      cells,
    };
    const milestone: MilestoneSpec = {
      schemaVersion: MILESTONE_DSL_VERSION,
      id: "evacuate",
      family: "evacuation",
      trigger: {
        event: "gate-entered",
        fixtureId: "gate-a",
        channel: "a",
      },
      occurrence: 1,
    };
    let rewrittenChannel: string | undefined;
    await certifyReleaseFixedPointEssentiality({
      level: twoChannels,
      difficulty: 0,
      milestoneSpecs: [milestone],
      requiredPrecedence: [],
    }, {
      evaluate: async ({ proposal, candidate }) => {
        if (proposal.id === "channel-merge:a->b") {
          const trigger = candidate.milestoneSpecs[0]!.trigger;
          rewrittenChannel = "event" in trigger ? trigger.channel : undefined;
        }
        return {
          preservesContract: false,
          reason: "test-reject",
          states: 1,
          transitions: 1,
        };
      },
    });
    expect(rewrittenChannel).toBe("b");
  });

  test("fails closed when exhaustive exact work cannot fit the frozen bound", async () => {
    const proof = certifyReleaseFixedPointEssentiality({
      level: fixedPointLevel(["cargo-a"]),
      difficulty: 0,
      milestoneSpecs: [],
      requiredPrecedence: [],
    }, {
      limits: { maxExactAnalyses: 0 },
      evaluate: async () => ({
        preservesContract: false,
        reason: "unreachable",
        states: 0,
        transitions: 0,
      }),
    });
    await expect(proof).rejects.toBeInstanceOf(ReleaseAblationIncompleteError);
  });
});
