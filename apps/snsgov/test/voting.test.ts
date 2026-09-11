import { expect, test } from "bun:test";
import { planVotes, selectVoteNeurons } from "../src/data/voting";
import type { NeuronSummary, ProposalDetail } from "../src/data/types";
const id = (index: number) => index.toString(16).padStart(64, "0");
const neuron = (index: number, permissions = [4]): NeuronSummary => ({ id: id(index), permissions: [{ principal: "aaaaa-aa", permissions }] } as NeuronSummary);
const proposal: ProposalDetail = {
  id: 1n, title: "Test", summary: "", url: "", status: "executed", actionKind: "Motion", createdAtSeconds: 50n, deadlineSeconds: 200n,
  ballots: [1, 2, 3, 4].map((index) => ({ neuronId: id(index), vote: index === 2 ? 1 : index === 3 ? 2 : 0, votingPower: 100n, castAtSeconds: 0n })),
};
const base = { rootCanisterId: "aaaaa-aa", governanceCanisterId: "aaaaa-aa", proposalId: 1n, votingPrincipal: "aaaaa-aa", canSign: true, votingEnabled: true, agentVotingEnabled: true, proposal, neurons: [neuron(1), neuron(2), neuron(3), neuron(4, [3]), neuron(5)], nowSeconds: 199n };

test("plans vote all eligible owned or shared actual ballots even after decision", () => {
  const plan = planVotes({ ...base, adopt: true });
  expect(plan.acceptsVotes).toBe(true);
  expect(plan.eligibleNeuronIds).toEqual([id(1)]);
  expect(plan.alreadyVoted).toEqual([{ neuronId: id(2), vote: 1, matchesRequestedVote: true }, { neuronId: id(3), vote: 2, matchesRequestedVote: false }]);
  expect(plan.excludedNeurons).toEqual([{ neuronId: id(4), reason: "no-vote-permission" }, { neuronId: id(5), reason: "no-ballot" }]);
  expect(plan.note).toContain("already decided");
});

test("deadline strictly closes voting regardless of decision status", () => {
  const plan = planVotes({ ...base, proposal: { ...proposal, status: "open" }, nowSeconds: 200n });
  expect(plan.acceptsVotes).toBe(false);
  expect(plan.eligibleNeuronIds).toEqual([]);
  expect(plan.note).toContain("deadline");
});

test("every explicit ID is validated and already cast votes remain separate from writes", () => {
  const plan = planVotes(base);
  expect(selectVoteNeurons(plan, [id(1), id(2)])).toEqual([id(1)]);
  expect(() => selectVoteNeurons(plan, [id(1), id(5)])).toThrow("no ballot");
  expect(() => selectVoteNeurons(plan, [id(4)])).toThrow("does not grant Vote");
  expect(() => selectVoteNeurons(plan, [id(1), id(1)])).toThrow("duplicates");
  expect(() => selectVoteNeurons(plan, [])).toThrow("Choose");
  expect(() => selectVoteNeurons(plan, ["bad"])).toThrow("Invalid neuron");
  expect(planVotes({ ...base, neuronIds: [id(2)], adopt: false })).toMatchObject({ eligibleNeuronIds: [], alreadyVotedNeuronIds: [id(2)], alreadyVoted: [{ neuronId: id(2), vote: 1, matchesRequestedVote: false }] });
});

test("partial discovery remains explicit without hiding known eligible ballots", () => {
  const failures = [{ scope: "aaaaa-aa", code: "UPSTREAM_UNAVAILABLE", message: "network" }];
  const plan = planVotes({ ...base, truncated: true, failures });
  expect(plan.discoveryComplete).toBe(false);
  expect(plan.failures).toEqual(failures);
  expect(plan.eligibleNeuronIds).toEqual([id(1)]);
  expect(plan.note).toContain("incomplete");
});
