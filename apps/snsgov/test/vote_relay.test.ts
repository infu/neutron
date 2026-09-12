import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import type { ScopedKernelClient } from "neutron-tools/app";
import { idlFactory } from "../src/candid/sns_governance.did.js";
import { voteWithNeurons } from "../src/data/relay";

const root = "extk7-gaaaa-aaaaq-aacda-cai";
const neuronIds = Array.from({ length: 25 }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
const ret = (idlFactory({ IDL }) as unknown as { _fields: [string, { retTypes: IDL.Type[] }][] })._fields.find(([name]) => name === "manage_neuron")![1].retTypes[0]!;
const accepted = new Uint8Array(IDL.encode([ret], [{ command: [{ RegisterVote: {} }] }]));
const denied = new Uint8Array(IDL.encode([ret], [{ command: [{ Error: { error_type: 3, error_message: "Not authorized" } }] }]));
function client(run: (method: string, args: unknown[]) => Promise<unknown>): Pick<ScopedKernelClient, "updateSelf"> {
  return { updateSelf: run } as Pick<ScopedKernelClient, "updateSelf">;
}
const input = { snsRootCanisterId: root, proposalId: 1066n, neuronIds, adopt: true, initiator: "agent" as const };
function success(count: number) {
  return { results: Array.from({ length: count }, () => ({ ok: accepted })), attempted: String(count), succeeded: String(count) };
}

test("a later refused chunk preserves earlier accepted votes", async () => {
  let calls = 0;
  const report = await voteWithNeurons(input, client(async () => ++calls === 1 ? success(20) : { results: [], attempted: "0", succeeded: "0", error: "SNS disabled" }));
  expect(calls).toBe(2);
  expect(report.attempted).toBe(20);
  expect(report.succeeded).toBe(20);
  expect(report.outcomes).toHaveLength(20);
  expect(report.error).toBe("SNS disabled");
});

test("a lost second reply retains earlier success and marks the uncertain neurons", async () => {
  let calls = 0;
  const report = await voteWithNeurons(input, client(async () => {
    if (++calls === 1) return success(20);
    throw new Error("Connection interrupted");
  }));
  expect(calls).toBe(2);
  expect(report.attempted).toBe(25);
  expect(report.succeeded).toBe(20);
  expect(report.outcomes.slice(20).map((row) => row.outcomeUnknown)).toEqual([true, true, true, true, true]);
  expect(report.error).toContain("ballots");
});

test("IC reply success is not counted as a governance command success", async () => {
  const report = await voteWithNeurons({ ...input, neuronIds: neuronIds.slice(0, 2) }, client(async () => ({ results: [{ ok: accepted }, { ok: denied }], attempted: "2", succeeded: "2" })));
  expect(report.attempted).toBe(2);
  expect(report.succeeded).toBe(1);
  expect(report.outcomes[1]).toMatchObject({ ok: false, error: "Not authorized" });
});

test("missing and undecodable replies remain unknown and are never retried", async () => {
  for (const results of [[], [{ ok: new Uint8Array([0, 1, 2]) }]]) {
    let calls = 0;
    const report = await voteWithNeurons(input, client(async () => { calls++; return { results, attempted: "20", succeeded: "20" }; }));
    expect(calls).toBe(1);
    expect(report.succeeded).toBe(0);
    expect(report.attempted).toBe(20);
    expect(report.outcomes.every((row) => row.outcomeUnknown)).toBe(true);
  }
});

test("current self-call projection keeps nested results and unwraps top-level results", async () => {
  const { convertBack, explainer } = await import(new URL("./icb_node.js", import.meta.resolve("icblast")).href);
  const types = explainer(({ IDL }: { IDL: typeof import("@dfinity/candid").IDL }) => {
    const result = IDL.Variant({ ok: IDL.Vec(IDL.Nat8), err: IDL.Text });
    return IDL.Service({ batch: IDL.Func([], [IDL.Record({ results: IDL.Vec(result) })], []), single: IDL.Func([], [result], []) });
  });
  const hex = Buffer.from(accepted).toString("hex");
  expect(convertBack({ results: [{ ok: accepted }, { err: "rejected" }] }, types.batch.output)).toEqual({ results: [{ ok: hex }, { err: "rejected" }] });
  expect(convertBack({ ok: accepted }, types.single.output)).toEqual(hex);
  // API 1 preserves binary leaves in a sidecar but retains the same variant rules.
  const { normalizeSelfCallResult } = await import(new URL("../../kernel/src/self_calls.ts", import.meta.url).href);
  const result = IDL.Variant({ ok: IDL.Vec(IDL.Nat8), err: IDL.Text });
  expect(normalizeSelfCallResult({ results: [{ ok: accepted }, { err: "rejected" }] }, IDL.Record({ results: IDL.Vec(result) }))).toEqual({ results: [{ ok: accepted }, { err: "rejected" }] });
  expect(normalizeSelfCallResult({ ok: accepted }, result)).toEqual(accepted);
});


test("an invalid neuron in a later chunk fails before any signed vote", async () => {
  let calls = 0;
  await expect(voteWithNeurons({ ...input, neuronIds: [...neuronIds.slice(0, 20), "bad"] }, client(async () => { calls++; return success(20); }))).rejects.toThrow();
  expect(calls).toBe(0);
});

test("already-voted responses never count as a new success and expose actual same/opposite ballots", async () => {
  const already = new Uint8Array(IDL.encode([ret], [{ command: [{ Error: { error_type: 10, error_message: "Neuron already voted on proposal" } }] }]));
  for (const actualVote of [1, 2]) {
    const report = await voteWithNeurons({ ...input, neuronIds: [neuronIds[0]!], readBallots: async () => [{ neuronId: neuronIds[0]!, vote: actualVote, votingPower: 100n, castAtSeconds: 5n }] }, client(async () => ({ results: [{ ok: already }], attempted: "1", succeeded: "1" })));
    expect(report.succeeded).toBe(0);
    expect(report.outcomes[0]).toMatchObject({ ok: false, alreadyVoted: true, actualVote, matchesRequestedVote: actualVote === 1 });
    expect(report.unattemptedNeuronIds).toEqual([]);
  }
});

test("refused and interrupted chunks identify every neuron never attempted", async () => {
  let calls = 0;
  const refused = await voteWithNeurons(input, client(async () => ++calls === 1 ? success(20) : { results: [], attempted: "0", succeeded: "0", error: "disabled" }));
  expect(refused.unattemptedNeuronIds).toEqual(neuronIds.slice(20));
  calls = 0;
  const interrupted = await voteWithNeurons(input, client(async () => { calls++; throw new Error("lost"); }));
  expect(interrupted.outcomeUnknownNeuronIds).toEqual(neuronIds.slice(0, 20));
  expect(interrupted.unattemptedNeuronIds).toEqual(neuronIds.slice(20));
  expect(calls).toBe(1);
});

test("unavailable ballot reconciliation preserves unknown direction without inventing success", async () => {
  const already = new Uint8Array(IDL.encode([ret], [{ command: [{ Error: { error_type: 10, error_message: "already voted" } }] }]));
  const report = await voteWithNeurons({ ...input, neuronIds: [neuronIds[0]!], readBallots: async () => { throw new Error("offline"); } }, client(async () => ({ results: [{ ok: already }], attempted: "1", succeeded: "1" })));
  expect(report.succeeded).toBe(0);
  expect(report.outcomes[0]?.actualVote).toBeUndefined();
  expect(report.outcomes[0]?.ballotReadError).toBe("offline");
});
