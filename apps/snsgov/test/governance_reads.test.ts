import { expect, test } from "bun:test";
import { Principal } from "@dfinity/principal";
import type { Neuron, NervousSystemParameters, ProposalData } from "../src/candid/sns_governance.did";
import { collectNeurons, deriveStatus, projectNeuronPage, projectParameters, projectProposalDetail, proposalAcceptsVotes, proposalPayloadProvenance, proposalThresholds, toNeuronSummary } from "../src/data/governance";
import { fromHex } from "../src/data/format";

const principal = "aaaaa-aa";
function proposal(overrides: Partial<ProposalData> = {}): ProposalData {
  return {
    id: [{ id: 12n }], proposal: [{ title: "Thresholds", summary: "", url: "", action: [{ Motion: { motion_text: "motion" } }] }],
    proposal_creation_timestamp_seconds: 100n, initial_voting_period_seconds: 100n,
    decided_timestamp_seconds: 150n, executed_timestamp_seconds: 0n, failed_timestamp_seconds: 0n,
    latest_tally: [{ yes: 60n, no: 40n, total: 100n, timestamp_seconds: 150n }],
    minimum_yes_proportion_of_total: [], minimum_yes_proportion_of_exercised: [], wait_for_quiet_state: [],
    proposer: [], ballots: [], payload_text_rendering: [], reward_event_round: 0n, topic: [], reject_cost_e8s: 1000n,
    ...overrides,
  } as ProposalData;
}
function neuron(index: number, ours = true): Neuron {
  return {
    id: [{ id: fromHex(index.toString(16).padStart(64, "0")) }],
    permissions: [{ principal: [Principal.fromText(ours ? principal : "2vxsx-fae")], permission_type: Int32Array.of(2, 4) }],
    cached_neuron_stake_e8s: 100n, neuron_fees_e8s: 3n,
    maturity_e8s_equivalent: 12n, staked_maturity_e8s_equivalent: [6n], voting_power_percentage_multiplier: 100n,
    created_timestamp_seconds: 20n, aging_since_timestamp_seconds: 30n,
    dissolve_state: [{ DissolveDelaySeconds: 40n }], vesting_period_seconds: [],
    auto_stake_maturity: [true], source_nns_neuron_id: [55n], followees: [], topic_followees: [], disburse_maturity_in_progress: [],
  };
}

test("decided status applies both proposal thresholds with exact strict/inclusive boundaries", () => {
  expect(deriveStatus(proposal({ minimum_yes_proportion_of_exercised: [{ basis_points: [6667n] }] }))).toBe("rejected");
  expect(deriveStatus(proposal({ latest_tally: [{ yes: 2n, no: 1n, total: 100n, timestamp_seconds: 150n }] }))).toBe("rejected");
  expect(deriveStatus(proposal({ latest_tally: [{ yes: 3n, no: 1n, total: 100n, timestamp_seconds: 150n }] }))).toBe("adopted");
  expect(deriveStatus(proposal({ minimum_yes_proportion_of_exercised: [{ basis_points: [6000n] }] }))).toBe("rejected");
  expect(deriveStatus(proposal({ latest_tally: [{ yes: 6n, no: 0n, total: 10n, timestamp_seconds: 150n }], minimum_yes_proportion_of_total: [{ basis_points: [6000n] }] }))).toBe("adopted");
  const large = 2n ** 63n;
  expect(deriveStatus(proposal({ latest_tally: [{ yes: large + 1n, no: large, total: 2n * large + 1n, timestamp_seconds: 150n }] }))).toBe("adopted");
  expect(deriveStatus(proposal({ latest_tally: [] }))).toBe("unknown");
  expect(deriveStatus(proposal({ decided_timestamp_seconds: 0n }))).toBe("open");
  expect(deriveStatus(proposal({ executed_timestamp_seconds: 151n }))).toBe("executed");
  expect(deriveStatus(proposal({ failed_timestamp_seconds: 151n }))).toBe("failed");
});

test("legacy absent Percentage and present empty Percentage preserve distinct upstream defaults", () => {
  expect(proposalThresholds(proposal())).toEqual({ minimumYesProportionOfTotal: 300n, minimumYesProportionOfExercised: 5000n });
  expect(proposalThresholds(proposal({ minimum_yes_proportion_of_total: [{ basis_points: [] }], minimum_yes_proportion_of_exercised: [{ basis_points: [] }] }))).toEqual({ minimumYesProportionOfTotal: 5000n, minimumYesProportionOfExercised: 5000n });
});

test("get_proposal keeps all ballots and decisions accept reward votes strictly before deadline", () => {
  const detail = projectProposalDetail(proposal({ executed_timestamp_seconds: 151n, ballots: [["01", { vote: 1, voting_power: 300n, cast_timestamp_seconds: 120n }], ["02", { vote: 0, voting_power: 500n, cast_timestamp_seconds: 0n }]] }));
  expect(detail.status).toBe("executed");
  expect(detail.ballots).toHaveLength(2);
  expect(detail.deadlineSeconds).toBe(200n);
  expect(proposalAcceptsVotes(detail, 199n)).toBe(true);
  expect(proposalAcceptsVotes(detail, 200n)).toBe(false);
  expect(projectProposalDetail(proposal({ wait_for_quiet_state: [{ current_deadline_timestamp_seconds: 300n }] })).deadlineSeconds).toBe(300n);
});

test("returned action blobs explicitly distinguish original 64 bytes from summarized larger fields", () => {
  expect(proposalPayloadProvenance({ ExecuteGenericNervousSystemFunction: { function_id: 1000n, payload: new Uint8Array(64) } })[0]).toMatchObject({ provenance: "original", reusable: true });
  const summarized = new TextEncoder().encode("⚠️ NOT THE ORIGINAL CONTENTS OF THIS FIELD ⚠️\n" + "metadata".repeat(20));
  const fields = proposalPayloadProvenance({ UpgradeSnsControlledCanister: { canister_id: [], new_canister_wasm: summarized, canister_upgrade_arg: [summarized], mode: [], chunked_canister_wasm: [], canister_upgrade_options: [] } });
  expect(fields).toHaveLength(2);
  expect(fields.every((field) => !field.reusable && field.provenance === "summarized")).toBe(true);
  const detail = projectProposalDetail(proposal({ proposal: [{ title: "x", summary: "", url: "", action: [{ ExecuteGenericNervousSystemFunction: { function_id: 1000n, payload: summarized } }] }] }));
  expect(detail.actionReusable).toBe(false);
  expect(detail.action).toBeDefined();
});

test("both filtered and unfiltered full small pages are incomplete; only public pages offer cursors", () => {
  const rows = Array.from({ length: 10 }, (_, index) => neuron(index + 1));
  expect(projectNeuronPage(rows, 10, true)).toMatchObject({ truncated: true });
  expect(projectNeuronPage(rows, 10, true).nextStartPageAt).toBeUndefined();
  expect(projectNeuronPage(rows, 10, false).nextStartPageAt).toEqual(rows.at(-1)!.id[0]!.id);
  expect(projectNeuronPage(rows.slice(0, 9), 10, false).truncated).toBe(false);
});

test("principal discovery past 100 switches to public pagination and filters without duplicate neurons", async () => {
  const all = Array.from({ length: 231 }, (_, index) => neuron(index + 1, index % 2 === 0));
  const filtered = all.filter((_, index) => index % 2 === 0).slice(0, 100);
  const cursors: string[] = [];
  const found = await collectNeurons(async (params) => {
    if (params.ofPrincipal) return projectNeuronPage(filtered, params.limit, true);
    const start = params.startPageAt ? Number(BigInt(`0x${Buffer.from(params.startPageAt).toString("hex")}`)) : 0;
    cursors.push(String(start));
    return projectNeuronPage(all.slice(start, start + params.limit), params.limit, false);
  }, principal);
  expect(cursors).toEqual(["0", "100", "200"]);
  expect(found.truncated).toBe(false);
  expect(found.neurons).toHaveLength(116);
  expect(new Set(found.neurons.map((entry) => entry.id)).size).toBe(116);
  expect(found.failures).toEqual([]);
});

test("mid-pagination errors preserve partial neurons, cursor and explicit failure", async () => {
  let calls = 0;
  const found = await collectNeurons(async (params) => {
    if (++calls === 2) throw new Error("network unavailable");
    return projectNeuronPage(Array.from({ length: 100 }, (_, index) => neuron(index + 1)), params.limit, false);
  });
  expect(found.neurons).toHaveLength(100);
  expect(found.truncated).toBe(true);
  expect(found.nextStartPageAt).toBeDefined();
  expect(found.failures[0]?.message).toContain("network unavailable");
});

test("a stalled full page yields partial evidence instead of a loop or complete result", async () => {
  const page = projectNeuronPage([neuron(1)], 1, false);
  const found = await collectNeurons(async () => page);
  expect(found.truncated).toBe(true);
  expect(found.neurons).toHaveLength(1);
  expect(found.failures[0]?.message).toContain("advancing cursor");
});

test("full neuron projection preserves fees, maturity queue, followees, aliases and permission data", () => {
  const raw = neuron(1);
  raw.followees = [[1000n, { followees: [{ id: fromHex("02".repeat(32)) }] }]];
  raw.topic_followees = [{ topic_id_to_followees: [[2, { topic: [{ Governance: null }], followees: [{ neuron_id: [{ id: fromHex("03".repeat(32)) }], alias: ["delegate"] }] }]] }];
  raw.disburse_maturity_in_progress = [{ amount_e8s: 5n, timestamp_of_disbursement_seconds: 10n, finalize_disbursement_timestamp_seconds: [20n], account_to_disburse_to: [{ owner: [Principal.fromText(principal)], subaccount: [{ subaccount: fromHex("04".repeat(32)) }] }] }];
  expect(toNeuronSummary(raw)).toMatchObject({ feesE8s: 3n, effectiveStakeE8s: 97n, autoStakeMaturity: true, sourceNnsNeuronId: 55n, followees: [{ functionId: 1000n, neuronIds: ["02".repeat(32)] }], topicFollowees: [{ topicId: 2, topic: "Governance", neuronIds: ["03".repeat(32)], aliases: ["delegate"] }], disburseMaturityInProgress: [{ amountE8s: 5n, timestampSeconds: 10n, finalizeDisbursementTimestampSeconds: 20n, account: { owner: principal, subaccountHex: "04".repeat(32) } }] });
  raw.neuron_fees_e8s = 101n;
  expect(toNeuronSummary(raw).effectiveStakeE8s).toBe(0n);
});

test("optional newer parameter fields can be absent without discarding older replies", () => {
  const absent: NervousSystemParameters = {
    default_followees: [], max_dissolve_delay_seconds: [], max_dissolve_delay_bonus_percentage: [],
    max_followees_per_function: [], automatically_advance_target_version: [], neuron_claimer_permissions: [],
    neuron_minimum_stake_e8s: [], max_neuron_age_for_age_bonus: [], initial_voting_period_seconds: [],
    neuron_minimum_dissolve_delay_to_vote_seconds: [], reject_cost_e8s: [], max_proposals_to_keep_per_action: [],
    wait_for_quiet_deadline_increase_seconds: [], max_number_of_neurons: [], transaction_fee_e8s: [],
    custom_proposal_criticality: [], max_number_of_proposals_with_ballots: [], max_age_bonus_percentage: [],
    neuron_grantable_permissions: [], voting_rewards_parameters: [], maturity_modulation_disabled: [],
    max_number_of_principals_per_neuron: [],
  };
  expect(projectParameters(absent)).toEqual({ raw: absent });
  const parameters = projectParameters({ ...absent, neuron_claimer_permissions: [{ permissions: Int32Array.of(1, 2, 4) }], neuron_grantable_permissions: [{ permissions: Int32Array.of(3, 4) }], max_followees_per_function: [15n], automatically_advance_target_version: [false] });
  expect(parameters).toMatchObject({ neuronClaimerPermissions: [1, 2, 4], neuronGrantablePermissions: [3, 4], maxFolloweesPerFunction: 15n, automaticallyAdvanceTargetVersion: false });
});
