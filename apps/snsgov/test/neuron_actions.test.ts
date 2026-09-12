import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import type { ScopedKernelClient } from "neutron-tools/app";
import type { Command } from "../src/candid/sns_governance.did";
import { idlFactory } from "../src/candid/sns_governance.did.js";
import { encodeManageNeuron, decodeManageNeuronRequest } from "../src/data/manage_neuron";
import {
  commandPostcondition, dissolveDelay, executeNeuronOperation, neuronCapabilities, neuronPermissions,
  operationResult, prepareNeuronAction, previewNeuronAction, validateNeuronCommand,
  retryNeuronStep,
  type NeuronActionInput, type NeuronActionServices, type NeuronActionSnapshot,
} from "../src/data/neuron_actions";
import { OPERATION_METHODS, operationJsonText, type OperationDetail, type OperationPrepare } from "../src/data/operations";
import type { NeuronSummary, ProposalDetail } from "../src/data/types";

const principal = "3rurp-vyaaa-aaaay-aacua-cai";
const recipient = "xevnm-gaaaa-aaaar-qafnq-cai";
const governance = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const sns = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const neuronId = "00".repeat(31) + "07";
const allPermissions = [1,2,3,4,5,6,7,8,9,10];
const start: Command = { Configure: { operation: [{ StartDissolving: {} }] } };
const stop: Command = { Configure: { operation: [{ StopDissolving: {} }] } };
const disburse: Command = { Disburse: { amount: [], to_account: [] } };
const split = (amount: bigint): Command => ({ Split: { amount_e8s: amount, memo: 17n } });
const vote = (value = 1): Command => ({ RegisterVote: { vote: value, proposal: [{ id: 42n }] } });
const add = (permissions: number[], target = recipient): Command => ({ AddNeuronPermissions: {
  principal_id: [Principal.fromText(target)], permissions_to_add: [{ permissions: Int32Array.from(permissions) }],
} });
const remove = (permissions: number[], target = recipient): Command => ({ RemoveNeuronPermissions: {
  principal_id: [Principal.fromText(target)], permissions_to_remove: [{ permissions: Int32Array.from(permissions) }],
} });
const autoStake = (enabled: boolean): Command => ({ Configure: { operation: [{ ChangeAutoStakeMaturity: { requested_setting_for_auto_stake_maturity: enabled } }] } });

function neuron(changes: Partial<NeuronSummary> = {}): NeuronSummary {
  return { id: neuronId, stakeE8s: 1000n, feesE8s: 0n, maturityE8s: 2000n, stakedMaturityE8s: 0n,
    votingPowerMultiplierPercent: 100n, createdAtSeconds: 10n, agingSinceSeconds: 10n,
    dissolveState: { kind: "delay", value: 1000n }, permissions: [{ principal, permissions: allPermissions }], ...changes };
}
function proposal(changes: Partial<ProposalDetail> = {}): ProposalDetail {
  return { id: 42n, title: "Proposal", summary: "", url: "", status: "executed", createdAtSeconds: 10n,
    deadlineSeconds: 200n, actionKind: "Motion", ballots: [{ neuronId, vote: 0, votingPower: 100n, castAtSeconds: 0n }], ...changes };
}
function snapshot(changes: Partial<NeuronActionSnapshot> = {}): NeuronActionSnapshot {
  return { neuron: neuron(), parameters: { neuronGrantablePermissions: allPermissions, transactionFeeE8s: 10n,
    neuronMinimumStakeE8s: 100n, neuronMinimumDissolveDelayToVoteSeconds: 30n, rejectCostE8s: 20n,
    maxFolloweesPerFunction: 3n, maxNumberOfPrincipalsPerNeuron: 15n }, mode: 1, nowSeconds: 100n, ...changes };
}
function action(command: Command = start): NeuronActionInput {
  return { operationId: "neuron-action-1", sns, governance, neuronId, command };
}
function response(command: unknown): Uint8Array {
  const service = idlFactory({ IDL }) as unknown as { _fields: [string, { retTypes: IDL.Type[] }][] };
  const type = service._fields.find(([name]) => name === "manage_neuron")![1].retTypes[0]!;
  return new Uint8Array(IDL.encode([type], [{ command: command === undefined ? [] : [command] }]));
}
function operation(command: Command = start, changes: Partial<OperationDetail> = {}): OperationDetail {
  return { operation_id: "neuron-action-1", sns, governance, input_json: operationJsonText({ principal }),
    review_json: operationJsonText({ title: "Review neuron action" }), state_json: operationJsonText({ version: 1, completedSteps: [] }),
    initiator: "user", seq: "1", revision: "0", created_at_seconds: "100", updated_at_seconds: "100",
    steps: [{ step_id: "command", args: encodeManageNeuron({ subaccount: Uint8Array.from(Buffer.from(neuronId, "hex")), command: [command] }), status: "prepared" }],
    ...changes };
}

function harness(initial: OperationDetail | null = null, initialSnapshot = snapshot()) {
  let saved = initial === null ? null : structuredClone(initial);
  let currentSnapshot = initialSnapshot;
  let dispatchReply: Uint8Array | undefined = response({ Configure: {} });
  let dispatchError: Error | undefined;
  let approvalError: Error | undefined;
  const events: string[] = [];
  const reads: Array<{ governance: string; neuronId: string; command: Command }> = [];
  const updates: Array<{ method: string; args: unknown[] }> = [];
  const view = () => saved === null ? null : structuredClone(saved);
  const kernel = {
    async querySelf(method: string, args: unknown[] = []) {
      events.push("get");
      expect(method).toBe(OPERATION_METHODS.get);
      expect(args).toEqual(["neuron-action-1"]);
      return view();
    },
    async updateSelf(method: string, args: unknown[] = []) {
      updates.push({ method, args });
      if (method === OPERATION_METHODS.prepare) {
        events.push("prepare");
        const input = args[0] as OperationPrepare;
        expect(saved).toBeNull();
        saved = { ...input, seq: "1", revision: "0", created_at_seconds: "100", updated_at_seconds: "100",
          steps: input.steps.map(step => ({ ...step, status: "prepared" })) };
      } else if (method === OPERATION_METHODS.dispatch) {
        events.push("dispatch");
        expect(saved).not.toBeNull();
        const dispatch = args[0] as { operation_id: string; step_id: string };
        expect(dispatch.operation_id).toBe(saved!.operation_id);
        const step = saved!.steps.find(value => value.step_id === dispatch.step_id)!;
        expect(step.status).toBe("prepared");
        step.status = dispatchReply ? "replied" : "unknown";
        if (dispatchReply) step.reply = dispatchReply;
        else step.error = "SNS outcome remains unknown";
        saved!.revision = (BigInt(saved!.revision) + 1n).toString();
        if (dispatchError) throw dispatchError;
      } else if (method === OPERATION_METHODS.update) {
        events.push("update");
        const update = args[0] as { operation_id: string; expected_revision: string; state_json: string };
        expect(update.operation_id).toBe(saved!.operation_id);
        expect(update.expected_revision).toBe(saved!.revision);
        saved!.state_json = update.state_json;
        saved!.revision = (BigInt(saved!.revision) + 1n).toString();
      } else throw new Error(`Unexpected update: ${method}`);
      return view();
    },
  } as unknown as ScopedKernelClient;
  const services: NeuronActionServices = {
    kernel, principal,
    async authorize() { events.push("authorize"); if (approvalError) throw approvalError; },
    reads: { async snapshot(governance, neuronId, command) {
      events.push("snapshot"); reads.push({ governance, neuronId, command }); return structuredClone(currentSnapshot);
    } },
  };
  return { services, events, reads, updates, view,
    setSnapshot(value: NeuronActionSnapshot) { currentSnapshot = value; },
    setReply(value: Uint8Array | undefined, error?: Error) { dispatchReply = value; dispatchError = error; },
    deny(error: Error) { approvalError = error; },
    dispatches: () => updates.filter(update => update.method === OPERATION_METHODS.dispatch),
  };
}

test("permission labels reflect the actual principal and do not infer full control from management", () => {
  const record = neuron({ permissions: [
    { principal, permissions: [4,3,4,10] }, { principal: recipient, permissions: allPermissions },
    { principal, permissions: [3] }, { principal: null, permissions: [2] },
  ] });
  expect(neuronPermissions(record, principal)).toEqual([3,4,10]);
  expect(neuronCapabilities(record, principal)).toMatchObject({ label: "Voting access", canVote: true, fullControl: false, canManagePrincipals: false });
  expect(neuronCapabilities(neuron({ permissions: [{ principal, permissions: [2] }] }), principal)).toMatchObject({
    fullControl: false, label: "Custom access", canManagePrincipals: true, canVote: false, canDisburse: false,
  });
  expect(neuronCapabilities(neuron(), principal).fullControl).toBe(true);
});

test("ManageVotingPermission grants only permissions 3, 4, and 10; ManagePrincipals honors SNS grantability", () => {
  const voting = snapshot({ neuron: neuron({ permissions: [{ principal, permissions: [10] }, { principal: recipient, permissions: [3,4,10] }] }) });
  expect(neuronCapabilities(voting.neuron!, principal, voting.parameters).grantablePermissions).toEqual([3,4,10]);
  expect(() => validateNeuronCommand(add([3,4,10]), voting, principal)).not.toThrow();
  expect(() => validateNeuronCommand(remove([3,4,10]), voting, principal)).not.toThrow();
  for (const permission of [1,2,5,6,7,8,9]) expect(() => validateNeuronCommand(add([permission]), voting, principal)).toThrow(/permission/);
  const manager = snapshot({ neuron: neuron({ permissions: [{ principal, permissions: [2] }] }) });
  expect(() => validateNeuronCommand(add([1,2,5,6,7,8,9,10]), manager, principal)).not.toThrow();
  expect(() => validateNeuronCommand(add([5]), { ...manager, parameters: { neuronGrantablePermissions: [3,4,10] } }, principal)).toThrow(/does not allow/);
});

test("voting uses the original ballot and live deadline even after proposal execution", () => {
  const eligible = snapshot({ neuron: neuron({ dissolveState: { kind: "delay", value: 0n } }), proposal: proposal() });
  expect(() => validateNeuronCommand(vote(), eligible, principal)).not.toThrow();
  expect(() => validateNeuronCommand(vote(), { ...eligible, proposal: proposal({ ballots: [] }) }, principal)).toThrow(/did not have a ballot/);
  for (const already of [1,2]) expect(() => validateNeuronCommand(vote(), {
    ...eligible, proposal: proposal({ ballots: [{ neuronId, vote: already, votingPower: 100n, castAtSeconds: 50n }] }),
  }, principal)).toThrow(/already cast/);
  expect(() => validateNeuronCommand(vote(), { ...eligible, nowSeconds: 201n }, principal)).toThrow(/deadline/);
  expect(() => validateNeuronCommand(vote(0), eligible, principal)).toThrow(/Yes or No/);
});

test("dissolution and disbursement distinguish locked, dissolving, and dissolved neurons", () => {
  expect(dissolveDelay(neuron(), 100n)).toBe(1000n);
  expect(dissolveDelay(neuron({ dissolveState: { kind: "dissolving", value: 150n } }), 100n)).toBe(50n);
  const dissolved = snapshot({ neuron: neuron({ dissolveState: { kind: "dissolving", value: 99n } }) });
  expect(dissolveDelay(dissolved.neuron!, 100n)).toBe(0n);
  expect(() => validateNeuronCommand(disburse, snapshot(), principal)).toThrow(/dissolved/);
  expect(() => validateNeuronCommand(disburse, dissolved, principal)).not.toThrow();
  expect(() => validateNeuronCommand(start, snapshot(), principal)).not.toThrow();
  expect(() => validateNeuronCommand(start, dissolved, principal)).toThrow(/locked/);
  expect(() => validateNeuronCommand(stop, dissolved, principal)).toThrow(/not currently dissolving/);
});

test("split checks the child transfer fee and effective parent stake after neuron fees", () => {
  const small = snapshot({ neuron: neuron({ stakeE8s: 300n, feesE8s: 90n }) });
  expect(() => validateNeuronCommand(split(109n), small, principal)).toThrow(/minimum stake plus/);
  expect(() => validateNeuronCommand(split(110n), small, principal)).not.toThrow();
  expect(() => validateNeuronCommand(split(111n), small, principal)).toThrow(/parent below/);
  expect(() => validateNeuronCommand(split(110n), snapshot({ neuron: neuron({ stakeE8s: 1000n, effectiveStakeE8s: 209n }) }), principal)).toThrow(/parent below/);
  expect(() => validateNeuronCommand(split(110n), snapshot({ neuron: neuron({ stakeE8s: 1n, feesE8s: 2n }) }), principal)).toThrow(/parent below/);
});

test("vesting blocks stake movements and dissolution changes through its exact end time", () => {
  const vesting = snapshot({ neuron: neuron({ createdAtSeconds: 10n, vestingPeriodSeconds: 90n, dissolveState: { kind: "delay", value: 0n } }) });
  for (const command of [split(110n), disburse, start]) expect(() => validateNeuronCommand(command, vesting, principal)).toThrow(/vesting/);
  expect(() => validateNeuronCommand(autoStake(true), vesting, principal)).not.toThrow();
  expect(() => validateNeuronCommand(disburse, { ...vesting, nowSeconds: 101n }, principal)).not.toThrow();
});

test("maturity commands enforce percentage and fee thresholds without treating staking as a payout", () => {
  const small = snapshot({ neuron: neuron({ maturityE8s: 10n }) });
  expect(() => validateNeuronCommand({ MergeMaturity: { percentage_to_merge: 100 } }, small, principal)).toThrow(/exceed/);
  expect(() => validateNeuronCommand({ DisburseMaturity: { percentage_to_disburse: 100, to_account: [] } }, small, principal)).toThrow(/worst-case/);
  expect(() => validateNeuronCommand({ StakeMaturity: { percentage_to_stake: [] } }, small, principal)).not.toThrow();
  for (const value of [0,101,1.5]) expect(() => validateNeuronCommand({ StakeMaturity: { percentage_to_stake: [value] } }, snapshot(), principal)).toThrow(/between 1 and 100/);
});

test("postconditions match exact permissions, ballots, and function followees", () => {
  const state = snapshot({ neuron: neuron({ permissions: [{ principal, permissions: [2] }, { principal: recipient, permissions: [3,4] }] }),
    proposal: proposal({ ballots: [{ neuronId, vote: 1, votingPower: 100n, castAtSeconds: 50n }] }) });
  expect(commandPostcondition(add([3,4]), state, principal)).toBe(true);
  expect(commandPostcondition(add([3,4,10]), state, principal)).toBe(false);
  expect(commandPostcondition(remove([10]), state, principal)).toBe(true);
  expect(commandPostcondition(remove([4]), state, principal)).toBe(false);
  expect(commandPostcondition(vote(1), state, principal)).toBe(true);
  expect(commandPostcondition(vote(2), state, principal)).toBe(false);
  const follow: Command = { Follow: { function_id: 42n, followees: [{ id: new Uint8Array(32).fill(7) }] } };
  expect(commandPostcondition(follow, snapshot({ neuron: neuron({ followees: [{ functionId: 42n, neuronIds: ["07".repeat(32)] }] }) }), principal)).toBe(true);
  expect(commandPostcondition(follow, snapshot({ neuron: neuron({ followees: [{ functionId: 43n, neuronIds: ["07".repeat(32)] }] }) }), principal)).toBe(false);
});

test("ambiguous financial changes never reconcile from a neuron balance alone", () => {
  for (const command of [disburse, split(110n), { MergeMaturity: { percentage_to_merge: 100 } },
    { StakeMaturity: { percentage_to_stake: [] } }, { ClaimOrRefresh: { by: [] } }] as Command[]) {
    expect(commandPostcondition(command, snapshot(), principal)).toBe(false);
  }
});

test("invalid vote and omitted ACL options cannot masquerade as satisfied postconditions", () => {
  expect(commandPostcondition(vote(0), snapshot({ proposal: proposal() }), principal)).toBe(false);
  expect(commandPostcondition({ AddNeuronPermissions: { principal_id: [Principal.fromText(recipient)], permissions_to_add: [] } }, snapshot(), principal)).toBe(false);
  expect(commandPostcondition({ RemoveNeuronPermissions: { principal_id: [Principal.fromText(recipient)], permissions_to_remove: [] } }, snapshot(), principal)).toBe(false);
});

test("empty permission additions require an existing ACL; empty removals need an authoritative reply", () => {
  expect(commandPostcondition(add([]), snapshot(), principal)).toBe(false);
  expect(commandPostcondition(remove([]), snapshot(), principal)).toBe(false);
  const existing = snapshot({ neuron: neuron({ permissions: [{ principal, permissions: [2] }, { principal: recipient, permissions: [] }] }) });
  expect(commandPostcondition(add([]), existing, principal)).toBe(true);
  // SNS removes an already-empty ACL entry; its presence is not the completed
  // removal, while absence alone cannot establish that the target ever existed.
  expect(commandPostcondition(remove([]), existing, principal)).toBe(false);
});

test("an expired dissolve timestamp is not an observed StartDissolving postcondition", () => {
  for (const value of [0n,99n,100n]) expect(commandPostcondition(start, snapshot({ neuron: neuron({ dissolveState: { kind: "dissolving", value } }) }), principal)).toBe(false);
  expect(commandPostcondition(start, snapshot({ neuron: neuron({ dissolveState: { kind: "dissolving", value: 101n } }) }), principal)).toBe(true);
});

test("operation results require a matching reply variant and retain malformed replies as pending", () => {
  const base = operation();
  const withReply = (reply: Uint8Array) => ({ ...base, steps: [{ ...base.steps[0]!, status: "replied" as const, reply }] });
  expect(operationResult(withReply(response({ Configure: {} }))).status).toBe("completed");
  expect(operationResult(withReply(response({ RegisterVote: {} }))).status).toBe("pending");
  expect(operationResult(withReply(response(undefined))).status).toBe("pending");
  expect(operationResult(withReply(new Uint8Array([1,2,3]))).status).toBe("pending");
  const denied = operationResult(withReply(response({ Error: { error_type: 10, error_message: "Permission denied" } })));
  expect(denied.status).toBe("rejected");
  expect(denied.outcomes[0]?.outcome).toMatchObject({ ok: false, errorType: 10 });
});

test("permission-change reply variants use the SNS singular response names", () => {
  for (const [command, reply] of [[add([4]), { AddNeuronPermission: {} }], [remove([4]), { RemoveNeuronPermission: {} }]] as const) {
    const base = operation(command);
    expect(operationResult({ ...base, steps: [{ ...base.steps[0]!, status: "replied", reply: response(reply) }] }).status).toBe("completed");
  }
});

test("preview uses injected snapshot reads without persistence, consent, or dispatch", async () => {
  const h = harness();
  const review = await previewNeuronAction(action(), h.services);
  expect(review).toMatchObject({ governance, neuronId, principal });
  expect(h.reads).toHaveLength(1);
  expect(h.reads[0]).toEqual({ governance, neuronId, command: start });
  expect(h.updates).toHaveLength(0);
  expect(h.events).toEqual(["snapshot"]);
});

test("preparation saves exact command bytes once and restored identical requests reuse that operation", async () => {
  const h = harness();
  const prepared = await prepareNeuronAction(action(), h.services);
  expect(prepared.status).toBe("prepared");
  expect(h.events).toEqual(["get", "snapshot", "prepare"]);
  expect(decodeManageNeuronRequest(h.view()!.steps[0]!.args).command[0]).toEqual(start);
  const restored = await prepareNeuronAction(action(), h.services);
  expect(restored.operation.input_json).toBe(prepared.operation.input_json);
  expect(h.updates).toHaveLength(1);
  expect(h.reads).toHaveLength(1);
  await expect(prepareNeuronAction(action(stop), h.services)).rejects.toThrow(/another SNS action/);
  expect(h.updates).toHaveLength(1);
});

test("execution persists before dispatch, uses a fresh injected snapshot, and dispatches once", async () => {
  const h = harness();
  await prepareNeuronAction(action(), h.services);
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("completed");
  expect(h.events).toEqual(["get", "snapshot", "prepare", "get", "authorize", "snapshot", "dispatch"]);
  expect(h.dispatches()).toHaveLength(1);
  expect(h.reads).toHaveLength(2);
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("completed");
  expect(h.dispatches()).toHaveLength(1);
});

test("current permissions are checked again after preparation and before dispatch", async () => {
  const h = harness();
  await prepareNeuronAction(action(), h.services);
  h.setSnapshot(snapshot({ neuron: neuron({ permissions: [{ principal, permissions: [3,4] }] }) }));
  await expect(executeNeuronOperation("neuron-action-1", h.services)).rejects.toThrow(/lacks permission/);
  expect(h.dispatches()).toHaveLength(0);
  expect(h.reads).toHaveLength(2);
});

test("authorization failure and a mismatched Neutron principal never dispatch", async () => {
  const denied = harness(operation());
  denied.deny(new Error("Owner declined"));
  await expect(executeNeuronOperation("neuron-action-1", denied.services)).rejects.toThrow(/Owner declined/);
  expect(denied.dispatches()).toHaveLength(0);
  expect(denied.reads).toHaveLength(0);
  const foreign = harness(operation());
  await expect(executeNeuronOperation("neuron-action-1", { ...foreign.services, principal: recipient })).rejects.toThrow(/another Neutron/);
  expect(foreign.events).toEqual(["get"]);
});

test("lost dispatch reply reloads retained unknown state and never replays the command", async () => {
  const h = harness(operation());
  h.setReply(undefined, new Error("Lost after dispatch"));
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("pending");
  expect(h.dispatches()).toHaveLength(1);
  expect(h.view()!.steps[0]!.status).toBe("unknown");
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("pending");
  expect(h.dispatches()).toHaveLength(1);
  expect(h.reads).toHaveLength(2);
});

test("a deterministic observed postcondition resolves unknown work without redispatch", async () => {
  const base = operation();
  const h = harness({ ...base, steps: [{ ...base.steps[0]!, status: "unknown", error: "Lost reply" }] },
    snapshot({ neuron: neuron({ dissolveState: { kind: "dissolving", value: 1100n } }) }));
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("completed");
  expect(h.dispatches()).toHaveLength(0);
  expect(JSON.parse(h.view()!.state_json).completedSteps).toEqual(["command"]);
  expect(h.updates[0]?.method).toBe(OPERATION_METHODS.update);
});

test("a definitive SNS rejection is not overwritten by someone else satisfying its postcondition", async () => {
  const base = operation(add([4]));
  const h = harness({ ...base, steps: [{ ...base.steps[0]!, status: "replied",
    reply: response({ Error: { error_type: 10, error_message: "SNS refused this grant" } }) }] },
    snapshot({ neuron: neuron({ permissions: [{ principal, permissions: [2] }, { principal: recipient, permissions: [4] }] }) }));
  const result = await executeNeuronOperation("neuron-action-1", h.services);
  expect(result.status).toBe("rejected");
  expect(h.updates).toHaveLength(0);
});

test("stored malformed and mismatched replies remain pending without new approval or snapshot reads", async () => {
  const base = operation();
  for (const reply of [new Uint8Array([1,2,3]), response({ RegisterVote: {} })]) {
    const h = harness({ ...base, steps: [{ ...base.steps[0]!, status: "replied", reply }] });
    expect((await executeNeuronOperation(base.operation_id, h.services)).status).toBe("pending");
    expect(h.events).toEqual(["get"]);
    expect(h.reads).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  }
});

test("retained Wallet funding status takes precedence over otherwise completed neuron steps", () => {
  const base = operation();
  const steps: OperationDetail["steps"] = [{ ...base.steps[0]!, status: "replied", reply: response({ Configure: {} }) }];
  for (const [fundingStatus, expected] of [["requested", "pending"], ["pending", "pending"], ["rejected", "rejected"], ["transferred", "completed"]] as const) {
    expect(operationResult({ ...base, steps, state_json: operationJsonText({ completedSteps: [], fundingStatus }) }).status).toBe(expected);
  }
});

test("an explicit linked ClaimOrRefresh retry keeps exact args and funding, then merges success without replacing the rejected reply", async () => {
  const claim: Command = { ClaimOrRefresh: { by: [{ NeuronId: {} }] } };
  const rawRejection = response({ Error: { error_type: 11, error_message: "Ledger balance read failed" } });
  const funding = { requestId: "ab".repeat(16), validUntilNs: "1800000000000000000", amountAtoms: "1000" };
  const original = operation(claim, {
    input_json: operationJsonText({ version: 1, kind: "stake", principal, nonce: "7", funding }),
    state_json: operationJsonText({ version: 1, completedSteps: [], fundingStatus: "transferred" }),
  });
  original.steps[0] = { ...original.steps[0]!, status: "replied", reply: rawRejection };
  const retryId = "explicit-retry-1";
  const records = new Map<string, OperationDetail>([[original.operation_id, structuredClone(original)]]);
  const updates: string[] = [], casRevisions: string[] = [], reads: string[] = [];
  let approvals = 0, walletCalls = 0;
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      expect(method).toBe(OPERATION_METHODS.get);
      return structuredClone(records.get(args[0] as string) ?? null);
    },
    async updateSelf(method: string, args: unknown[]) {
      updates.push(method);
      if (method === OPERATION_METHODS.prepare) {
        const input = args[0] as OperationPrepare;
        expect(input.operation_id).toBe(retryId);
        expect(input.steps).toHaveLength(1);
        expect(input.steps[0]!.args).toEqual(original.steps[0]!.args);
        expect(JSON.parse(input.input_json)).toMatchObject({ kind: "retry", originalOperationId: original.operation_id, originalStepId: "command" });
        const attempt: OperationDetail = { ...input, seq: "2", revision: "0", created_at_seconds: "100", updated_at_seconds: "100",
          steps: input.steps.map(step => ({ ...step, status: "prepared" })) };
        records.set(retryId, attempt);
        return structuredClone(attempt);
      }
      if (method === OPERATION_METHODS.dispatch) {
        expect(args[0]).toEqual({ operation_id: retryId, step_id: "retry" });
        const attempt = records.get(retryId)!;
        expect(attempt.steps[0]!.status).toBe("prepared");
        attempt.steps[0] = { ...attempt.steps[0]!, status: "replied", reply: response({ ClaimOrRefresh: {
          refreshed_neuron_id: [{ id: Uint8Array.from(Buffer.from(neuronId, "hex")) }],
        } }) };
        attempt.revision = "1";
        // Another continuation records evidence while this SNS call is awaited.
        const concurrent = records.get(original.operation_id)!;
        concurrent.revision = "1";
        concurrent.state_json = operationJsonText({ ...JSON.parse(concurrent.state_json), fundingBlock: "42" });
        return structuredClone(attempt);
      }
      if (method === OPERATION_METHODS.update) {
        const input = args[0] as { operation_id: string; expected_revision: string; state_json: string };
        expect(input.operation_id).toBe(original.operation_id);
        casRevisions.push(input.expected_revision);
        const current = records.get(input.operation_id)!;
        if (current.revision !== input.expected_revision) throw new Error("Operation revision changed");
        current.state_json = input.state_json;
        current.revision = (BigInt(current.revision) + 1n).toString();
        return structuredClone(current);
      }
      throw new Error(`Unexpected retry mutation: ${method}`);
    },
    async callTool() { walletCalls++; throw new Error("A neuron retry must not invoke Wallet"); },
  } as unknown as ScopedKernelClient;
  const services: NeuronActionServices = { kernel, principal,
    async authorize() { approvals++; },
    reads: { async snapshot(target, id, command) {
      expect(target).toBe(governance); expect(id).toBe(neuronId);
      expect(command).toEqual(claim); reads.push(id); return snapshot();
    } },
  };
  const result = await retryNeuronStep(original.operation_id, "command", retryId, services);
  expect(result.status).toBe("completed");
  expect(approvals).toBe(1);
  expect(reads).toHaveLength(2);
  expect(walletCalls).toBe(0);
  expect(updates.filter(method => method === OPERATION_METHODS.dispatch)).toHaveLength(1);
  expect(casRevisions).toEqual(["0", "1"]);
  const retained = records.get(original.operation_id)!;
  expect(retained.input_json).toBe(original.input_json);
  expect(retained.steps[0]!.status).toBe("replied");
  expect(retained.steps[0]!.reply).toEqual(rawRejection);
  expect(retained.steps[0]!.args).toEqual(original.steps[0]!.args);
  expect(JSON.parse(retained.state_json)).toMatchObject({ fundingStatus: "transferred", fundingBlock: "42",
    completedSteps: ["command"], retryOperations: { command: retryId } });
  expect((await retryNeuronStep(original.operation_id, "command", retryId, services)).status).toBe("completed");
  expect(updates.filter(method => method === OPERATION_METHODS.dispatch)).toHaveLength(1);
  expect(walletCalls).toBe(0);
});

test("ambiguous steps and reused original operation IDs cannot create retry attempts", async () => {
  const base = operation({ ClaimOrRefresh: { by: [{ NeuronId: {} }] } });
  for (const status of ["unknown", "dispatching"] as const) {
    const h = harness({ ...base, steps: [{ ...base.steps[0]!, status, error: "Outcome uncertain" }] });
    await expect(retryNeuronStep(base.operation_id, "command", "explicit-retry-1", h.services)).rejects.toThrow(/no definite SNS rejection/);
    expect(h.events).toEqual(["get"]);
    expect(h.updates).toHaveLength(0);
  }
  const h = harness(base);
  await expect(retryNeuronStep(base.operation_id, "command", base.operation_id, h.services)).rejects.toThrow(/distinct attempt ID/);
  expect(h.events).toHaveLength(0);
});

test("Disburse external failures cannot be explicitly retried because they can include partial effects", async () => {
  const base = operation(disburse);
  const h = harness({ ...base, steps: [{ ...base.steps[0]!, status: "replied",
    reply: response({ Error: { error_type: 11, error_message: "Ledger error after a financial substep" } }) }] });
  await expect(retryNeuronStep(base.operation_id, "command", "explicit-retry-1", h.services)).rejects.toThrow(/partial effects/);
  expect(h.events).toEqual(["get"]);
  expect(h.reads).toHaveLength(0);
  expect(h.updates).toHaveLength(0);
});

function voteBatch() {
  const first = operation(vote()), secondId = "00".repeat(31) + "08";
  const batch: OperationDetail = { ...first, input_json: operationJsonText({ version: 1, kind: "vote", principal }), steps: [
    { ...first.steps[0]!, step_id: "vote_first" },
    { step_id: "vote_second", args: encodeManageNeuron({ subaccount: Uint8Array.from(Buffer.from(secondId, "hex")), command: [vote()] }), status: "prepared" },
  ] };
  return { batch, secondId };
}

function independentVoteHarness(firstReply: Uint8Array | undefined, firstStatus: "prepared" | "unknown" = "prepared") {
  const { batch, secondId } = voteBatch();
  if (firstStatus === "unknown") batch.steps[0] = { ...batch.steps[0]!, status: "unknown", error: "Original vote reply lost" };
  const h = harness(batch);
  const update = h.services.kernel.updateSelf;
  h.services.kernel.updateSelf = (async (...args: Parameters<ScopedKernelClient["updateSelf"]>) => {
    if (args[0] === OPERATION_METHODS.dispatch) {
      const { step_id } = args[1]![0] as { step_id: string };
      h.setReply(step_id === "vote_first" ? firstReply : response({ RegisterVote: {} }));
    }
    return update(...args);
  }) as ScopedKernelClient["updateSelf"];
  const read = h.services.reads!.snapshot;
  let firstBallot = 0, firstReadFailure = false;
  h.services.reads!.snapshot = async (...args) => {
    const value = await read(...args), id = args[1];
    if (id === neuronId && firstReadFailure) throw new Error("First neuron temporarily unavailable");
    return { ...value, neuron: { ...value.neuron!, id }, proposal: proposal({ ballots: [
      { neuronId: id, vote: id === neuronId ? firstBallot : 0, votingPower: 100n, castAtSeconds: 0n },
    ] }) };
  };
  return { ...h, secondId,
    observeFirstVote() { firstBallot = 1; },
    failFirstRead() { firstReadFailure = true; },
  };
}

test("an SNS vote rejection does not block another reviewed neuron and a resolved mixed batch never redispatches", async () => {
  const rejection = response({ Error: { error_type: 10, error_message: "First neuron ballot was refused" } });
  const h = independentVoteHarness(rejection);
  const result = await executeNeuronOperation("neuron-action-1", h.services);
  expect(result.status).toBe("rejected");
  expect(result.outcomes.map(value => ({ stepId: value.stepId, ok: value.outcome?.ok }))).toEqual([
    { stepId: "vote_first", ok: false }, { stepId: "vote_second", ok: true },
  ]);
  expect(h.dispatches().map(value => value.args[0])).toEqual([
    { operation_id: "neuron-action-1", step_id: "vote_first" }, { operation_id: "neuron-action-1", step_id: "vote_second" },
  ]);
  expect(h.view()!.steps[0]!.reply).toEqual(rejection);
  const eventsBeforeRetry = h.events.length, readsBeforeRetry = h.reads.length;
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("rejected");
  expect(h.events.slice(eventsBeforeRetry)).toEqual(["get"]);
  expect(h.reads).toHaveLength(readsBeforeRetry);
  expect(h.dispatches()).toHaveLength(2);
});

test("an unknown vote does not block its sibling, is never replayed, and can later reconcile its ballot", async () => {
  const h = independentVoteHarness(undefined);
  const result = await executeNeuronOperation("neuron-action-1", h.services);
  expect(result.status).toBe("pending");
  expect(result.outcomes.find(value => value.stepId === "vote_second")?.outcome?.ok).toBe(true);
  expect(h.view()!.steps[0]!.status).toBe("unknown");
  expect(h.dispatches()).toHaveLength(2);
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("pending");
  expect(h.dispatches()).toHaveLength(2);
  h.observeFirstVote();
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("completed");
  expect(h.dispatches()).toHaveLength(2);
  expect(h.view()!.steps[0]!.status).toBe("unknown");
  expect(JSON.parse(h.view()!.state_json).completedSteps).toEqual(["vote_first"]);
  const events = h.events.length;
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("completed");
  expect(h.events.slice(events)).toEqual(["get"]);
});

test("an unavailable reconciliation read for a saved unknown vote does not block a prepared sibling", async () => {
  const h = independentVoteHarness(undefined, "unknown");
  h.failFirstRead();
  const result = await executeNeuronOperation("neuron-action-1", h.services);
  expect(result.status).toBe("pending");
  expect(h.dispatches().map(value => value.args[0])).toEqual([{ operation_id: "neuron-action-1", step_id: "vote_second" }]);
  expect(h.view()!.steps[0]!.error).toBe("Original vote reply lost");
  expect(result.outcomes.find(value => value.stepId === "vote_second")?.outcome?.ok).toBe(true);
});

test("saved rejection can resume remaining votes, while a vote label cannot bypass non-vote sequencing", async () => {
  const { batch } = voteBatch();
  const rejection = response({ Error: { error_type: 10, error_message: "Original vote refused" } });
  batch.steps[0] = { ...batch.steps[0]!, status: "replied", reply: rejection };
  const h = harness(batch, snapshot({ neuron: neuron({ id: "00".repeat(31) + "08" }), proposal: proposal({ ballots: [
    { neuronId: "00".repeat(31) + "08", vote: 0, votingPower: 100n, castAtSeconds: 0n },
  ] }) }));
  h.setReply(response({ RegisterVote: {} }));
  expect((await executeNeuronOperation("neuron-action-1", h.services)).outcomes.find(value => value.stepId === "vote_second")?.outcome?.ok).toBe(true);
  expect(h.dispatches()).toHaveLength(1);
  const mixed = { ...batch, steps: [batch.steps[0]!, { ...operation(start).steps[0]!, step_id: "configure" }] };
  const protectedBatch = harness(mixed);
  expect((await executeNeuronOperation("neuron-action-1", protectedBatch.services)).status).toBe("rejected");
  expect(protectedBatch.events).toEqual(["get"]);
  expect(protectedBatch.dispatches()).toHaveLength(0);
  const ordinaryBatch = harness({ ...batch, input_json: operationJsonText({ kind: "manage_batch", principal }) });
  expect((await executeNeuronOperation("neuron-action-1", ordinaryBatch.services)).status).toBe("rejected");
  expect(ordinaryBatch.events).toEqual(["get"]);
});

test("a fully replied vote batch with malformed evidence stays pending without another review or read", async () => {
  const { batch } = voteBatch();
  const h = harness({ ...batch, steps: batch.steps.map((step, index) => ({ ...step, status: "replied",
    reply: index === 0 ? new Uint8Array([1,2,3]) : response({ RegisterVote: {} }),
  })) });
  expect((await executeNeuronOperation("neuron-action-1", h.services)).status).toBe("pending");
  expect(h.events).toEqual(["get"]);
  expect(h.reads).toHaveLength(0);
  expect(h.updates).toHaveLength(0);
});
