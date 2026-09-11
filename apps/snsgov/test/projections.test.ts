import { expect, test } from "bun:test";
import { governanceReadToJson, neuronRow, proposalDetail } from "../src/tools/projections";
import type { NeuronSummary, ProposalDetail } from "../src/data/types";

test("proposal tools keep the action label and expose lossless action inputs with payload provenance", () => {
  const raw: ProposalDetail = { id: 2n, title: "Custom", summary: "", url: "", status: "adopted", createdAtSeconds: 1n, deadlineSeconds: 9_999_999_999n, actionKind: "ExecuteGenericNervousSystemFunction", ballots: [],
    minimumYesProportionOfTotal: 300n, minimumYesProportionOfExercised: 5000n,
    action: { ExecuteGenericNervousSystemFunction: { function_id: 9_007_199_254_740_993n, payload: Uint8Array.of(0, 255) } },
    actionReusable: true, payloadProvenance: [{ path: "ExecuteGenericNervousSystemFunction.payload", provenance: "original", reusable: true, returnedBytes: 2 }],
  };
  const projected = proposalDetail(raw);
  expect(projected.action).toBe("ExecuteGenericNervousSystemFunction");
  expect(projected.actionPayload).toEqual({ ExecuteGenericNervousSystemFunction: { function_id: "9007199254740993", payload: { hex: "00ff" } } });
  expect(projected.payloadProvenance).toEqual(raw.payloadProvenance);
  expect(projected.minimumYesProportionOfTotalBasisPoints).toBe("300");
  expect(projected.acceptsVotes).toBe(true);
  expect(() => JSON.stringify(projected)).not.toThrow();
});

test("neuron projection exposes existing stake and maturity permissions with dissolved state", () => {
  const raw: NeuronSummary = { id: "01".repeat(32), stakeE8s: 1_000_000_000n, feesE8s: 1n, effectiveStakeE8s: 999_999_999n,
    maturityE8s: 20n, stakedMaturityE8s: 30n, votingPowerMultiplierPercent: 100n,
    createdAtSeconds: 1n, agingSinceSeconds: 2n, dissolveState: { kind: "dissolving", value: 1n },
    permissions: [{ principal: "aaaaa-aa", permissions: [2, 4, 8, 9] }],
    disburseMaturityInProgress: [{ amountE8s: 9007199254740993n, timestampSeconds: 3n }],
  };
  const projected = neuronRow(raw, 8, "SNS");
  expect(projected.dissolve).toMatchObject({ state: "dissolved" });
  expect(projected.principals).toEqual([expect.objectContaining({ canManagePrincipals: true, canVote: true, canMergeMaturity: false, canDisburseMaturity: true, canStakeMaturity: true })]);
  expect((projected.disburseMaturityInProgress as { amountE8s: string }[])[0]?.amountE8s).toBe("9007199254740993");
  expect(() => JSON.stringify(projected)).not.toThrow();
});

test("older absent topic and version responses stay lossless in read-tool JSON", () => {
  expect(governanceReadToJson("list_topics", { topics: [], uncategorized_functions: [] })).toEqual({ topics: null, uncategorized_functions: null });
  expect(governanceReadToJson("get_running_sns_version", { deployed_version: [], pending_version: [] })).toEqual({ deployed_version: null, pending_version: null });
});
