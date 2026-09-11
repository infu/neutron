import assert from "node:assert/strict";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { PocketIcRestClient } from "neutron-provision/src/pocketic_rest.ts";
import { idlFactory as governanceIdl } from "../src/candid/sns_governance.did.js";
import { idlFactory as ledgerIdl } from "../src/candid/icrc_ledger.did.js";
import { encodeManageNeuronCommand, encodeMakeProposal, encodeRegisterVote, decodeManageNeuronResponse } from "../src/data/manage_neuron";
import { buildProposalAction } from "../src/data/proposal_actions";
import { neuronStakingSubaccount } from "../src/data/staking";
import { toHex } from "../src/data/format";

type Environment = {
  client: PocketIcRestClient; base: string; instance: number;
  govId: Principal; ledgerId: Principal; neutron: Principal; secondNeutron: Principal;
  bootstrapId: string; secondId: string;
  forward(target: Principal, method: string, args: Uint8Array, proxy?: Principal): Promise<Uint8Array>;
  query(target: Principal, method: string, args: Uint8Array): Promise<Uint8Array>;
};
const encoded = (types: IDL.Type[], values: unknown[]) => new Uint8Array(IDL.encode(types, values));
const raw = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const account = (owner: Principal, subaccount: Uint8Array[] = []) => ({ owner, subaccount });

export async function verifyLifecycle(env: Environment): Promise<string[]> {
  const { govId, ledgerId, neutron, secondNeutron, bootstrapId } = env;
  const checks: string[] = [];
  const record = (label: string) => { checks.push(label); console.log(`PASS ${label}`); };
  const gov = new Map((governanceIdl({ IDL }) as any)._fields), ledger = new Map((ledgerIdl({ IDL }) as any)._fields);
  const gf = (name: string): any => gov.get(name), lf = (name: string): any => ledger.get(name);
  async function readGov(name: string, values: unknown[]): Promise<any> {
    return IDL.decode(gf(name).retTypes, await env.query(govId, name, encoded(gf(name).argTypes, values)))[0];
  }
  async function neuron(id: string): Promise<any> {
    const found = (await readGov("get_neuron", [{ neuron_id: [{ id: raw(id) }] }])).result[0];
    assert(found?.Neuron, `Neuron ${id} unavailable: ${JSON.stringify(found, (_, value) => typeof value === "bigint" ? String(value) : value)}`);
    return found.Neuron;
  }
  async function balance(owner: Principal, subaccount: Uint8Array[] = []): Promise<bigint> {
    return IDL.decode(lf("icrc1_balance_of").retTypes, await env.query(ledgerId, "icrc1_balance_of", encoded(lf("icrc1_balance_of").argTypes, [account(owner, subaccount)])))[0] as bigint;
  }
  async function command(kind: string, input: unknown, id = bootstrapId, proxy = neutron): Promise<any> {
    const result = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeManageNeuronCommand(id, kind, input), proxy));
    assert(result.ok, `${kind}: ${result.errorType} ${result.errorMessage}`);
    assert.equal(result.command, kind === "AddNeuronPermissions" ? "AddNeuronPermission" : kind === "RemoveNeuronPermissions" ? "RemoveNeuronPermission" : kind);
    return result.response!.command[0];
  }
  async function icTime(): Promise<bigint> {
    const response = await fetch(`${env.base}/instances/${env.instance}/read/get_time`);
    assert(response.ok);
    const text = await response.text();
    const ns = /"nanos_since_epoch"\s*:\s*(\d+)/.exec(text)?.[1];
    assert(ns, `Invalid PocketIC time: ${text}`);
    return BigInt(ns) / 1_000_000_000n;
  }
  async function advance(seconds: bigint): Promise<void> {
    await env.client.stopAutoProgress(env.instance);
    const now = await icTime();
    const response = await fetch(`${env.base}/instances/${env.instance}/update/set_time`, { method: "POST", headers: { "content-type": "application/json" }, body: `{"nanos_since_epoch":${(now + seconds) * 1_000_000_000n}}` });
    assert(response.ok, await response.text());
    const tick = await fetch(`${env.base}/instances/${env.instance}/update/tick`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"blockmakers":null}' });
    assert(tick.ok, await tick.text());
    const start = await fetch(`${env.base}/instances/${env.instance}/auto_progress`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"artificial_delay_ms":null}' });
    assert(start.ok, await start.text());
  }

  // This fixture proposal is already adopted by the first neuron's yes vote.
  // An uncast ballot remains votable until the actual voting deadline.
  const beforeLateVote = (await readGov("get_proposal", [{ proposal_id: [{ id: 1n }] }])).result[0].Proposal;
  assert(beforeLateVote.decided_timestamp_seconds > 0n);
  assert(beforeLateVote.wait_for_quiet_state[0].current_deadline_timestamp_seconds > await icTime());
  const late = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeRegisterVote(env.secondId, 1n, false), secondNeutron));
  assert(late.ok, late.errorMessage ?? "Late vote was rejected");
  const afterLateVote = (await readGov("get_proposal", [{ proposal_id: [{ id: 1n }] }])).result[0].Proposal;
  assert.equal(afterLateVote.ballots.find(([id]: [string]) => id === env.secondId)[1].vote, 2);
  record("voting remains available after adoption and before the voting deadline");

  const nonce = 99n;
  const subaccount = await neuronStakingSubaccount(neutron.toText(), nonce);
  const id = toHex(subaccount), stake = 2_000_000_000n;
  const transfer = { from_subaccount: [], to: account(govId, [subaccount]), amount: stake, fee: [10_000n], memo: [encoded([IDL.Nat64], [nonce])], created_at_time: [] };
  const transferResult = IDL.decode(lf("icrc1_transfer").retTypes, await env.forward(ledgerId, "icrc1_transfer", encoded(lf("icrc1_transfer").argTypes, [transfer])))[0] as any;
  assert("Ok" in transferResult, "The real SNS ledger must accept stake funding");
  assert.equal(await balance(govId, [subaccount]), stake);
  await command("ClaimOrRefresh", { by: { MemoAndController: { memo: String(nonce), controller: neutron.toText() } } }, id);
  let observed = await neuron(id);
  assert.equal(observed.cached_neuron_stake_e8s, stake);
  assert(observed.permissions.some((permission: any) => permission.principal[0]?.toText() === neutron.toText() && permission.permission_type.includes(2)));
  const beforeRefresh = await balance(neutron);
  await command("ClaimOrRefresh", { by: { MemoAndController: { memo: String(nonce), controller: neutron.toText() } } }, id);
  assert.equal(await balance(neutron), beforeRefresh, "Refreshing the same claimed neuron must not fund again");
  record("ledger funding and idempotent ClaimOrRefresh use the Neutron-derived staking account");

  await command("Configure", { operation: { IncreaseDissolveDelay: { additional_dissolve_delay_seconds: "100" } } }, id);
  assert.equal((await neuron(id)).dissolve_state[0].DissolveDelaySeconds, 100n);
  await command("Configure", { operation: { StartDissolving: {} } }, id);
  assert("WhenDissolvedTimestampSeconds" in (await neuron(id)).dissolve_state[0]);
  await command("Configure", { operation: { StopDissolving: {} } }, id);
  assert("DissolveDelaySeconds" in (await neuron(id)).dissolve_state[0]);
  await command("Configure", { operation: { SetDissolveTimestamp: { dissolve_timestamp_seconds: String((await icTime()) + 200n) } } }, id);
  await command("Configure", { operation: { ChangeAutoStakeMaturity: { requested_setting_for_auto_stake_maturity: true } } }, id);
  assert.equal((await neuron(id)).auto_stake_maturity[0], true);
  record("configure delay, start/stop dissolving, absolute timestamp and auto-stake maturity");

  await command("AddNeuronPermissions", { principal_id: secondNeutron.toText(), permissions_to_add: { permissions: [3,4] } }, id);
  assert((await neuron(id)).permissions.some((p: any) => p.principal[0]?.toText() === secondNeutron.toText() && p.permission_type.includes(4)));
  await command("RemoveNeuronPermissions", { principal_id: secondNeutron.toText(), permissions_to_remove: { permissions: [3,4] } }, id);
  assert(!(await neuron(id)).permissions.some((p: any) => p.principal[0]?.toText() === secondNeutron.toText()));
  record("grant and revoke shared proposal/voting permissions");
  await command("Follow", { function_id: "1", followees: [{ id: { hex: bootstrapId } }] }, id);
  assert((await neuron(id)).followees.some(([fn]: [bigint]) => fn === 1n));
  await command("SetFollowing", { topic_following: [{ topic: { Governance: null }, followees: [{ neuron_id: { id: { hex: bootstrapId } }, alias: "Primary" }] }] }, id);
  assert((await neuron(id)).topic_followees.length > 0);
  record("legacy per-function following and topic following");

  const split = await command("Split", { memo: "100", amount_e8s: "500000000" }, id);
  const child = toHex(split.Split.created_neuron_id[0].id);
  assert.equal(child, toHex(await neuronStakingSubaccount(neutron.toText(), 100n)));
  assert.equal((await neuron(child)).cached_neuron_stake_e8s, 500_000_000n - 10_000n);
  assert.equal((await neuron(id)).cached_neuron_stake_e8s, stake - 500_000_000n);
  record("split transfers real ledger stake into the derived child account");

  const allPermissions = [1,2,3,4,5,6,7,8,9,10];
  await command("AddNeuronPermissions", { principal_id: secondNeutron.toText(), permissions_to_add: { permissions: allPermissions } }, child);
  await command("RemoveNeuronPermissions", { principal_id: neutron.toText(), permissions_to_remove: { permissions: allPermissions } }, child, secondNeutron);
  const handed = await neuron(child);
  assert(!handed.permissions.some((p: any) => p.principal[0]?.toText() === neutron.toText()));
  const denied = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeManageNeuronCommand(child, "Configure", { operation: { StartDissolving: {} } })));
  assert(!denied.ok, "A removed principal must not retain control");
  await command("Configure", { operation: { StartDissolving: {} } }, child, secondNeutron);
  await command("Configure", { operation: { StartDissolving: {} } }, id);
  record("ordered control handover removes former controller authority");

  await command("StakeMaturity", { percentage_to_stake: 50 });
  observed = await neuron(bootstrapId);
  assert.equal(observed.staked_maturity_e8s_equivalent[0], 1_000_000_000n);
  assert.equal(observed.maturity_e8s_equivalent, 1_000_000_000n);
  await command("DisburseMaturity", { percentage_to_disburse: 25, to_account: { owner: neutron.toText() } });
  observed = await neuron(bootstrapId);
  assert.equal(observed.disburse_maturity_in_progress.length, 1);
  assert.equal(observed.disburse_maturity_in_progress[0].amount_e8s, 250_000_000n);
  record("stake maturity and queue a real delayed maturity payout");

  async function proposal(kind: string, input: unknown): Promise<any> {
    const result = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeMakeProposal({ neuronId: bootstrapId, title: `Local ${kind}`, summary: "Genuine SNS integration verification in an isolated PocketIC instance.", url: "", action: buildProposalAction(kind, input) })));
    assert(result.ok && result.proposalId !== undefined, `${kind}: ${result.errorMessage}`);
    if (kind === "AddGenericNervousSystemFunction") {
      const undecided = (await readGov("get_proposal", [{ proposal_id: [{ id: result.proposalId }] }])).result[0].Proposal;
      const threshold = undecided.minimum_yes_proportion_of_exercised[0]?.basis_points[0];
      assert(threshold > 5_000n, "Critical custom registration must use its stricter live threshold");
      assert.equal(undecided.decided_timestamp_seconds, 0n, "The proposer alone must not satisfy this critical fixture's threshold");
      record("critical proposal threshold prevents premature adoption by a simple majority");
    }
    const vote = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeRegisterVote(env.secondId, result.proposalId, true), secondNeutron));
    assert(vote.ok, `${kind} secondary vote: ${vote.errorMessage}`);
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = (await readGov("get_proposal", [{ proposal_id: [{ id: result.proposalId }] }])).result[0].Proposal;
      if (value.failed_timestamp_seconds > 0n) assert.fail(`${kind}: ${value.failure_reason[0]?.error_message}`);
      if (value.executed_timestamp_seconds > 0n) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`${kind} did not execute`);
  }
  await proposal("Motion", { motion_text: "The app encoder reached genuine SNS Governance." });
  record("submit, adopt and execute a Motion using actual canister-controlled neurons");
  await proposal("ManageSnsMetadata", { description: "Updated through the real proposal execution path." });
  assert.equal((await readGov("get_metadata", [{}])).description[0], "Updated through the real proposal execution path.");
  record("metadata proposal execution changes live SNS metadata");
  await proposal("ManageNervousSystemParameters", { max_followees_per_function: "14" });
  assert.equal((await readGov("get_nervous_system_parameters", [null])).max_followees_per_function[0], 14n);
  record("governance-parameter proposal execution changes live parameters");
  await proposal("AddGenericNervousSystemFunction", { id: "1000", name: "Fixture value", function_type: { GenericNervousSystemFunction: { target_canister_id: neutron.toText(), target_method_name: "execute", validator_canister_id: neutron.toText(), validator_method_name: "validate", topic: { ApplicationBusinessLogic: null } } } });
  const payload = encoded([IDL.Nat], [7n]);
  const generic = await proposal("ExecuteGenericNervousSystemFunction", { function_id: "1000", payload: { hex: toHex(payload) } });
  assert(generic.payload_text_rendering[0].includes("7"));
  assert.deepEqual(IDL.decode([IDL.Vec(IDL.Nat)], await env.query(neutron, "values", encoded([], [])))[0], [7n]);
  const invalid = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeMakeProposal({ neuronId: bootstrapId, title: "Invalid custom payload", summary: "The validator must reject zero.", url: "", action: buildProposalAction("ExecuteGenericNervousSystemFunction", { function_id: "1000", payload: { hex: toHex(encoded([IDL.Nat], [0n])) } }) })));
  assert(!invalid.ok && invalid.errorMessage?.includes("Zero"));
  record("register custom function, validate exact payload, execute target and reject invalid payload");
  await proposal("SetTopicsForCustomProposals", { custom_function_id_to_topic: [["1000", { DaoCommunitySettings: null }]] });
  await proposal("RemoveGenericNervousSystemFunction", "1000");
  const removed = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeMakeProposal({ neuronId: bootstrapId, title: "Removed function", summary: "Removed IDs must not execute.", url: "", action: buildProposalAction("ExecuteGenericNervousSystemFunction", { function_id: "1000", payload: { hex: toHex(payload) } }) })));
  assert(!removed.ok);
  record("change a custom function topic and remove the function without reusing its ID");

  await advance(400n);
  const childBalance = await balance(neutron);
  const childBefore = (await neuron(child)).cached_neuron_stake_e8s;
  await command("Disburse", { to_account: { owner: neutron.toText() } }, child, secondNeutron);
  assert.equal(await balance(neutron) - childBalance, childBefore - 10_000n);
  assert.equal((await neuron(child)).cached_neuron_stake_e8s, 0n);
  await command("Disburse", { to_account: { owner: neutron.toText() }, amount: { e8s: "100000000" } }, id);
  assert((await neuron(id)).cached_neuron_stake_e8s < stake - 500_000_000n);
  record("full child and partial parent disbursement transfer real ledger tokens after dissolution");

  const deadlineProposal = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeMakeProposal({ neuronId: bootstrapId, title: "Deadline verification", summary: "Keep the second neuron's ballot uncast until the voting deadline passes.", url: "", action: buildProposalAction("Motion", { motion_text: "An adopted proposal still has a distinct voting deadline." }) })));
  assert(deadlineProposal.ok && deadlineProposal.proposalId !== undefined, deadlineProposal.errorMessage ?? "Deadline fixture proposal was rejected");
  const beforeMaturity = await balance(neutron);
  await advance(8n * 86_400n);
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await neuron(bootstrapId)).disburse_maturity_in_progress.length === 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await neuron(bootstrapId)).disburse_maturity_in_progress.length, 0);
  assert.equal(await balance(neutron) - beforeMaturity, 250_000_000n);
  const history = IDL.decode(lf("get_transactions").retTypes, await env.query(ledgerId, "get_transactions", encoded(lf("get_transactions").argTypes, [{ start: 0n, length: 100n }])))[0] as any;
  const payoutIndex = history.transactions.findIndex((tx: any) => tx.mint[0]?.to.owner.toText() === neutron.toText() && tx.mint[0]?.amount === 250_000_000n);
  assert(payoutIndex >= 0, "The genuine ledger must retain the finalized maturity mint");
  console.log(`maturity payout ledger block=${history.first_index + BigInt(payoutIndex)}`);
  record("delayed maturity finalization mints the queued amount through the real SNS ledger");
  const expired = (await readGov("get_proposal", [{ proposal_id: [{ id: deadlineProposal.proposalId }] }])).result[0].Proposal;
  assert(expired.wait_for_quiet_state[0].current_deadline_timestamp_seconds < await icTime());
  const tooLate = decodeManageNeuronResponse(await env.forward(govId, "manage_neuron", encodeRegisterVote(env.secondId, deadlineProposal.proposalId, true), secondNeutron));
  assert(!tooLate.ok, "An uncast ballot must be rejected after the actual deadline");
  record("uncast vote is rejected after the voting deadline");
  return checks;
}
