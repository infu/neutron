import { describe, expect, test } from "bun:test";
import type { QualificationSampleRuntime } from "./sample_runtime.ts";
import { lowSideCycleEstimate } from "./run.ts";

const APP_ID = "ca_qualification_aux_1" as const;
const CANISTER_ID = "rrkah-fqaaa-aaaaa-aaaaq-cai";

type Counters = Readonly<{
  instructions: bigint;
  executions: bigint;
  outgoingCycles: bigint;
}>;

describe("Certified Assets per-update low-side cycle metric", () => {
  test("takes the maximum update cost instead of the multi-update case total", () => {
    const aggregate = 109_410_758_230n;
    const executions = 40n;
    const aggregateInstructions =
      aggregate - 5_000_000n * executions;
    const quotient = aggregateInstructions / executions;
    const remainder = aggregateInstructions % executions;
    const instructionDeltas = Array.from(
      { length: Number(executions) },
      (_, index) => quotient + (BigInt(index) < remainder ? 1n : 0n),
    );

    expect(lowSideCycleEstimate([
      bracket(instructionDeltas),
    ])).toBe(2_735_268_956n);
  });

  test("does not average away one hot update", () => {
    expect(lowSideCycleEstimate([
      bracket([40_000_000_001n, 1n]),
    ])).toBe(40_005_000_001n);
  });

  test("includes outgoing cycles when selecting the maximum update", () => {
    expect(lowSideCycleEstimate([
      bracket([100n, 200n], {
        outgoingCycleDeltas: [1_000n, 0n],
      }),
    ])).toBe(5_001_100n);
  });

  test("requires per-update deltas to reconcile exactly with the outer case bracket", () => {
    expect(() => lowSideCycleEstimate([
      bracket([31n, 47n], { outerOutgoingCycles: 1n }),
    ])).toThrow(
      "does not reconcile with its outer case bracket",
    );
  });

  test("requires exactly one positive-instruction execution in each bracket", () => {
    expect(() => lowSideCycleEstimate([
      bracket([31n, 47n], { executionDeltas: [0n, 2n] }),
    ])).toThrow(
      "does not contain exactly one positive-instruction execution",
    );
  });

  test("binds each usage bracket to the matching observed update method", () => {
    const measured = bracket([31n]);
    const runtime = measured.runtime as QualificationSampleRuntime;
    const mismatched = {
      ...measured,
      runtime: {
        ...runtime,
        updateUsageBrackets: [{
          ...runtime.updateUsageBrackets[0]!,
          method: "foreign_update",
        }],
      } as QualificationSampleRuntime,
    };
    expect(() => lowSideCycleEstimate([mismatched])).toThrow(
      "does not match observed update",
    );
  });

  test("rejects a cycle metric sample with no measured update", () => {
    expect(() => lowSideCycleEstimate([
      bracket([]),
    ])).toThrow("has no metered update");
  });
});

function bracket(
  instructionDeltas: readonly bigint[],
  options: Readonly<{
    executionDeltas?: readonly bigint[];
    outgoingCycleDeltas?: readonly bigint[];
    outerOutgoingCycles?: bigint;
  }> = {},
): Parameters<typeof lowSideCycleEstimate>[0][number] {
  const executionDeltas = options.executionDeltas ??
    instructionDeltas.map(() => 1n);
  const outgoingCycleDeltas = options.outgoingCycleDeltas ??
    instructionDeltas.map(() => 0n);
  if (
    executionDeltas.length !== instructionDeltas.length ||
    outgoingCycleDeltas.length !== instructionDeltas.length
  ) {
    throw new Error("Test fixture counter count mismatch");
  }
  let counters: Counters = {
    instructions: 0n,
    executions: 0n,
    outgoingCycles: 0n,
  };
  const updateUsageBrackets = instructionDeltas.map(
    (instructions, index) => {
      const before = counters;
      counters = {
        instructions: counters.instructions + instructions,
        executions: counters.executions + executionDeltas[index]!,
        outgoingCycles:
          counters.outgoingCycles + outgoingCycleDeltas[index]!,
      };
      return {
        method: `update_${index}`,
        before: usageSnapshot(before),
        after: usageSnapshot(counters),
      };
    },
  );
  const outerAfter: Counters = {
    ...counters,
    outgoingCycles:
      counters.outgoingCycles + (options.outerOutgoingCycles ?? 0n),
  };
  const runtime = {
    appId: APP_ID,
    canisterId: CANISTER_ID,
    observations: {
      candid: instructionDeltas.map((_, index) => ({
        mode: "update",
        method: `update_${index}`,
      })),
      http: [],
    },
    updateUsageBrackets,
  } as unknown as QualificationSampleRuntime;
  return {
    appId: APP_ID,
    runtime,
    before: diagnosticsSnapshot(usageSnapshot({
      instructions: 0n,
      executions: 0n,
      outgoingCycles: 0n,
    })),
    after: diagnosticsSnapshot(usageSnapshot(outerAfter)),
  };
}

function diagnosticsSnapshot(kernelAppUsage: unknown) {
  return {
    scope_usage: null,
    kernel_diagnostics: null,
    kernel_app_usage: kernelAppUsage,
  };
}

function usageSnapshot(counters: Counters) {
  return {
    snapshot_version: 2n,
    current_day: 0n,
    apps: [{
      app_id: APP_ID,
      installation_uid: 1n,
      lifetime_instructions: counters.instructions,
      lifetime_executions: counters.executions,
      lifetime_outgoing_cycles: counters.outgoingCycles,
    }],
  };
}
