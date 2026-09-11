import { expect, spyOn, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { createHash } from "node:crypto";
import type { ScopedKernelClient } from "neutron-tools/app";
import { decodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import type { Command_1 } from "../src/candid/sns_governance.did";
import { governanceMethodTypes } from "../src/data/governance_codec";
import { decodeManageNeuronRequest } from "../src/data/manage_neuron";
import type { NeuronActionServices, NeuronActionSnapshot } from "../src/data/neuron_actions";
import { createOperationClient, OPERATION_METHODS, type OperationDetail, type OperationPrepare } from "../src/data/operations";
import { continueStake, neuronStakingAccount, neuronStakingSubaccount, prepareStake, prepareTopUp, type StakeInput } from "../src/data/staking";
import { toHex } from "../src/data/format";
import type { NeuronSummary } from "../src/data/types";
import type { WalletFundingRequest } from "../src/data/wallet_funding";

const PRINCIPAL = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const GOVERNANCE = "r7inp-6aaaa-aaaaa-aaabq-cai";
const LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const REQUEST_ID = "1234567890abcdef1234567890abcdef";
const ROOT_APP = "agent";
const VECTOR_42 = "3cfe0c12f3f0c96010823ea1146a8e8df65b280d9c1887c9f13498f881853827";
const stakeInput = (extra: Partial<StakeInput> = {}): StakeInput => ({
  operationId: REQUEST_ID, sns: "aaaaa-aa", governance: GOVERNANCE, ledger: LEDGER,
  amountAtoms: "200000000", nonce: "42", validUntilNs: "1900000000000000000",
  dissolveDelaySeconds: "86400", autoStakeMaturity: true, ...extra,
});

function claimedNeuron(id: string, permissions = [1, 2, 3, 4]): NeuronSummary {
  return {
    id, stakeE8s: 200000000n, maturityE8s: 0n, stakedMaturityE8s: 0n,
    votingPowerMultiplierPercent: 100n, createdAtSeconds: 1n, agingSinceSeconds: 1n,
    dissolveState: { kind: "delay", value: 0n }, autoStakeMaturity: false,
    permissions: [{ principal: PRINCIPAL, permissions }],
  };
}

/** Emulates only the retained self-call contract; SNS effects occur on dispatch. */
function harness(options: { root?: boolean; claimerPermissions?: number[]; neuron?: NeuronSummary; balance?: bigint; selected?: boolean } = {}) {
  let operation: OperationDetail | null = null;
  let neuron = options.neuron;
  let balance = options.balance ?? neuron?.stakeE8s ?? 0n;
  let minimumStake = 100000000n;
  let mode = 1;
  let selected = options.selected ?? true;
  let fundingHandler: (() => Promise<unknown>) | undefined;
  let casConflicts = 0;
  const events: string[] = [];
  const dispatches: string[] = [];
  const walletCalls: { name: string; arguments: unknown }[] = [];
  const snapshots: NeuronActionSnapshot[] = [];
  let authorizations = 0;
  let fundingReply: unknown = {
    status: "transferred", commandId: `${options.root ? ROOT_APP : "snsgov"}:${REQUEST_ID}`,
    blockIndex: "77", duplicate: false, message: null,
  };
  let evidence: unknown = { version: 1, available: false };
  const copy = () => structuredClone(operation);
  function bump() {
    if (!operation) throw new Error("Missing journal entry");
    operation.revision = (BigInt(operation.revision) + 1n).toString();
    return copy();
  }
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      expect(method).toBe(OPERATION_METHODS.get);
      expect(args).toEqual([REQUEST_ID]);
      return copy();
    },
    async updateSelf(method: string, args: unknown[]) {
      events.push(method);
      if (method === OPERATION_METHODS.prepare) {
        const input = args[0] as OperationPrepare;
        expect(operation).toBeNull();
        operation = {
          ...structuredClone(input), seq: "1", revision: "1", created_at_seconds: "1", updated_at_seconds: "1",
          steps: input.steps.map(step => ({ ...step, method: step.method ?? "manage_neuron", args: Uint8Array.from(step.args), status: "prepared" })),
        };
        return copy();
      }
      if (!operation) throw new Error("Attempted effect before journal preparation");
      if (method === OPERATION_METHODS.update) {
        const update = args[0] as { operation_id: string; expected_revision: string; state_json: string };
        expect(update.operation_id).toBe(REQUEST_ID);
        if (update.expected_revision !== operation.revision) {
          casConflicts++;
          throw new Error("The operation changed; expected revision does not match");
        }
        operation.state_json = update.state_json;
        return bump();
      }
      if (method !== OPERATION_METHODS.dispatch) throw new Error(`Unexpected self-call ${method}`);
      const dispatch = args[0] as { operation_id: string; step_id: string };
      expect(JSON.parse(operation.state_json).fundingStatus).toBe("transferred");
      const step = operation.steps.find(step => step.step_id === dispatch.step_id)!;
      expect(step.status).toBe("prepared");
      dispatches.push(step.step_id);
      const command = decodeManageNeuronRequest(step.args).command[0]!;
      let response: Command_1;
      if ("ClaimOrRefresh" in command) {
        neuron ??= claimedNeuron(toHex(decodeManageNeuronRequest(step.args).subaccount), options.claimerPermissions);
        response = { ClaimOrRefresh: { refreshed_neuron_id: [{ id: Uint8Array.from(Buffer.from(neuron.id, "hex")) }] } };
      } else if ("AddNeuronPermissions" in command) {
        neuron!.permissions[0]!.permissions.push(...Array.from(command.AddNeuronPermissions.permissions_to_add[0]!.permissions));
        response = { AddNeuronPermission: {} };
      } else if ("Configure" in command) {
        const config = command.Configure.operation[0]!;
        if ("IncreaseDissolveDelay" in config) neuron!.dissolveState = { kind: "delay", value: BigInt(config.IncreaseDissolveDelay.additional_dissolve_delay_seconds) };
        if ("ChangeAutoStakeMaturity" in config) neuron!.autoStakeMaturity = config.ChangeAutoStakeMaturity.requested_setting_for_auto_stake_maturity;
        response = { Configure: {} };
      } else throw new Error("Unexpected staking command");
      step.status = "replied";
      step.reply = new Uint8Array(IDL.encode(governanceMethodTypes("manage_neuron").retTypes, [{ command: [response] }]));
      return bump();
    },
    async callTool(call: { name: string; arguments: unknown }) {
      walletCalls.push(structuredClone(call));
      events.push(call.name);
      if (call.name === "wallet_overview") {
        const ledgers = selected ? [GOVERNANCE, LEDGER] : [GOVERNANCE];
        return {
          revision: "1", capturedAt: 1800000000000, configured: true, assetCount: ledgers.length,
          assets: ledgers.map(principal => ({ principal, balance: null, issue: "Metadata unavailable" })),
          activity: [], historyError: "Index unavailable",
        };
      }
      expect(operation).not.toBeNull();
      expect(operation!.steps.length).toBeGreaterThan(0);
      expect(operation!.steps.every(step => step.args.length > 0)).toBe(true);
      if (call.name === "wallet_add_ledger_v1") {
        expect(authorizations).toBeGreaterThan(0);
        expect(call.arguments).toEqual({ ledger: LEDGER });
        const alreadySelected = selected;
        selected = true;
        return { ledger: LEDGER, selected: true, alreadySelected, metadataError: null };
      }
      if (call.name === "wallet_fund_v1" && fundingHandler) return fundingHandler();
      return call.name === "wallet_transaction_v1" ? structuredClone(evidence) : structuredClone(fundingReply);
    },
  } as unknown as ScopedKernelClient;
  const services: NeuronActionServices = {
    kernel, principal: PRINCIPAL, authorize: async () => { authorizations++; events.push("authorize"); },
    ...(options.root ? { funding: { root: true, callerAppId: ROOT_APP } } : {}),
    reads: { async balance(ledger, governance, _neuronId) {
      expect(ledger).toBe(LEDGER);
      expect(governance).toBe(GOVERNANCE);
      return balance;
    }, async snapshot(governance, _neuronId, _command) {
      expect(governance).toBe(GOVERNANCE);
      const snapshot: NeuronActionSnapshot = {
        ...(neuron ? { neuron: structuredClone(neuron) } : {}), mode, nowSeconds: 1000n,
        parameters: {
          neuronMinimumStakeE8s: minimumStake, maxDissolveDelaySeconds: 252288000n,
          neuronClaimerPermissions: options.claimerPermissions ?? [1, 2, 3, 4], neuronGrantablePermissions: [1, 2, 3, 4],
        },
      };
      snapshots.push(snapshot);
      return snapshot;
    } },
  };
  return {
    services, events, dispatches, walletCalls, snapshots,
    get operation() { return copy()!; },
    get neuron() { return structuredClone(neuron); },
    get authorizations() { return authorizations; },
    get fundingCalls() { return walletCalls.filter(call => call.name === "wallet_fund_v1" || call.name === "wallet_fund_root_v1"); },
    get casConflicts() { return casConflicts; },
    set fundingReply(value: unknown) { fundingReply = value; },
    set fundingHandler(value: () => Promise<unknown>) { fundingHandler = value; },
    set evidence(value: unknown) { evidence = value; },
    set balance(value: bigint) { balance = value; },
    set minimumStake(value: bigint) { minimumStake = value; },
    set mode(value: number) { mode = value; },
    set selected(value: boolean) { selected = value; },
  };
}

test("staking subaccounts match independently pinned SHA-256 domain and big-endian nonce vectors", async () => {
  // Python 3 hashlib: sha256(b'\x0cneuron-stake' + bytes.fromhex('00000000000000010101') + nonce.to_bytes(8, 'big')).
  for (const [nonce, expected] of [
    ["0", "ca061c70ccfc5841ff5c957d08ffb646f9f874febbdb7761f41328e5317a48d4"],
    ["1", "b82ddbe256d3febf7e8ea933def7f5cf3b36e5780f1db97e6639c1d7e9f0da88"],
    ["42", VECTOR_42],
    ["18446744073709551615", "3bf9b67a14e32c86fc511f8237cccae42c1f42f86d68f5de418c4d2593e7c8b5"],
  ]) expect(toHex(await neuronStakingSubaccount(PRINCIPAL, nonce!))).toBe(expected!);
  const account = await neuronStakingAccount(GOVERNANCE, PRINCIPAL, 42n);
  expect(account.owner.toText()).toBe(GOVERNANCE);
  expect(toHex(account.subaccount)).toBe(VECTOR_42);
});

test("preparation persists exact funding identity, memo and all claim/configuration bytes before funds move", async () => {
  const h = harness({ claimerPermissions: [2, 3, 4] });
  const result = await prepareStake(stakeInput(), h.services);
  expect(result.status).toBe("prepared");
  expect(h.fundingCalls).toEqual([]);
  expect(h.dispatches).toEqual([]);
  expect(h.authorizations).toBe(0);
  const saved = JSON.parse(h.operation.input_json);
  const funding = saved.funding as WalletFundingRequest;
  expect(saved.principal).toBe(PRINCIPAL);
  expect(saved.nonce).toBe("42");
  expect(saved.neuronId).toBe(VECTOR_42);
  expect(saved.fundingCallerAppId).toBe("snsgov");
  expect(funding).toMatchObject({ requestId: REQUEST_ID, ledger: LEDGER, amountAtoms: "200000000", validUntilNs: "1900000000000000000", route: { kind: "direct", memoHex: REQUEST_ID } });
  const destination = decodeIcrcAccount(funding.route.to);
  expect(destination.owner.toText()).toBe(GOVERNANCE);
  expect(toHex(destination.subaccount!)).toBe(VECTOR_42);
  expect(h.operation.steps.map(step => step.step_id)).toEqual(["claim", "configure_permission", "dissolve_delay", "auto_stake"]);
  const requests = h.operation.steps.map(step => decodeManageNeuronRequest(step.args));
  expect(requests.every(request => toHex(request.subaccount) === VECTOR_42)).toBe(true);
  const claim = requests[0]!.command[0]!;
  if (!("ClaimOrRefresh" in claim)) throw new Error("Missing claim command");
  const by = claim.ClaimOrRefresh.by[0]!;
  if (!("MemoAndController" in by)) throw new Error("Missing memo and controller");
  expect(by.MemoAndController.memo).toBe(42n);
  expect(by.MemoAndController.controller[0]!.toText()).toBe(PRINCIPAL);
  const grant = requests[1]!.command[0]!;
  if (!("AddNeuronPermissions" in grant)) throw new Error("Missing configure permission grant");
  expect(grant.AddNeuronPermissions.principal_id[0]!.toText()).toBe(PRINCIPAL);
  expect(Array.from(grant.AddNeuronPermissions.permissions_to_add[0]!.permissions)).toEqual([1]);
  expect(requests[2]!.command).toEqual([{ Configure: { operation: [{ IncreaseDissolveDelay: { additional_dissolve_delay_seconds: 86400 } }] } }]);
  expect(requests[3]!.command).toEqual([{ Configure: { operation: [{ ChangeAutoStakeMaturity: { requested_setting_for_auto_stake_maturity: true } }] } }]);
  expect(JSON.parse(h.operation.review_json).commandSteps).toEqual(h.operation.steps.map(step => ({ stepId: step.step_id, args: { byteLength: step.args.length, sha256: createHash("sha256").update(step.args).digest("hex") } })));
});

test("repreparing the same operation preserves generated nonce, deadline and request after the clock changes", async () => {
  const h = harness();
  const input = stakeInput();
  delete input.nonce;
  delete input.validUntilNs;
  const clock = spyOn(Date, "now").mockReturnValue(1800000000000);
  try {
    await prepareStake(input, h.services);
    const original = h.operation;
    const reads = h.snapshots.length;
    clock.mockReturnValue(1900000000000);
    const retry = await prepareStake(input, h.services);
    expect(retry.operation).toEqual(original);
    expect(h.snapshots.length).toBe(reads);
    expect(JSON.parse(retry.operation.input_json).funding.validUntilNs).toBe("1800000600000000000");
    expect(h.events).toEqual(["wallet_overview", OPERATION_METHODS.prepare]);
    await expect(prepareStake({ ...input, amountAtoms: "300000000" }, h.services)).rejects.toThrow(/another staking intent/);
  } finally { clock.mockRestore(); }
});

test("Root continuation returns the retained instruction without a nested Root funding call", async () => {
  const h = harness({ root: true });
  await prepareStake(stakeInput(), h.services);
  const funding = JSON.parse(h.operation.input_json).funding;
  const first = await continueStake(REQUEST_ID, {}, h.services);
  const second = await continueStake(REQUEST_ID, {}, h.services);
  expect(first.status).toBe("pending");
  expect(first.fundingInstructions).toEqual([{ target: "app:wallet:background", name: "wallet_fund_root_v1", arguments: funding }]);
  expect(second.fundingInstructions).toEqual(first.fundingInstructions);
  expect(h.fundingCalls).toEqual([]);
  expect(h.dispatches).toEqual([]);
});

for (const status of ["pending", "rejected"] as const) {
  test(`${status} funding never dispatches a claim`, async () => {
    const h = harness();
    h.fundingReply = { status, commandId: `snsgov:${REQUEST_ID}`, blockIndex: null, duplicate: null, message: `Funding ${status}` };
    await prepareStake(stakeInput(), h.services);
    const result = await continueStake(REQUEST_ID, {}, h.services);
    expect(result.status).toBe(status);
    expect(JSON.parse(h.operation.state_json).fundingStatus).toBe(status);
    expect(h.dispatches).toEqual([]);
    expect(h.operation.steps.every(step => step.status === "prepared")).toBe(true);
    expect(h.snapshots.every(snapshot => snapshot.neuron === undefined)).toBe(true);
  });
}

test("a forged Root receipt with the right command ID cannot authorize claim without ledger evidence", async () => {
  const h = harness({ root: true });
  await prepareStake(stakeInput(), h.services);
  const result = await continueStake(REQUEST_ID, { fundingResults: [{ status: "transferred", commandId: `${ROOT_APP}:${REQUEST_ID}`, blockIndex: "77", duplicate: false, message: null }] }, h.services);
  expect(result.status).toBe("pending");
  expect(result.message).toContain("not yet verified");
  expect(h.walletCalls.filter(call => call.name !== "wallet_overview").map(call => call.name)).toEqual(["wallet_transaction_v1"]);
  expect(h.dispatches).toEqual([]);
  expect(JSON.parse(h.operation.state_json).fundingStatus).toBe("pending");
});

test("successful Normal funding records each claim and configuration effect exactly once", async () => {
  const h = harness({ claimerPermissions: [2, 3, 4] });
  await prepareStake(stakeInput(), h.services);
  const funding = JSON.parse(h.operation.input_json).funding;
  const result = await continueStake(REQUEST_ID, {}, h.services);
  expect(result.status).toBe("completed");
  expect(h.fundingCalls).toHaveLength(1);
  expect(h.fundingCalls[0]).toMatchObject({ name: "wallet_fund_v1", arguments: funding });
  expect(h.events.indexOf(OPERATION_METHODS.prepare)).toBeLessThan(h.events.indexOf("wallet_fund_v1"));
  expect(h.dispatches).toEqual(["claim", "configure_permission", "dissolve_delay", "auto_stake"]);
  expect(h.operation.steps.every(step => step.status === "replied" && step.reply!.length > 0)).toBe(true);
  expect(JSON.parse(h.operation.state_json)).toMatchObject({ fundingStatus: "transferred", fundingResult: { commandId: `snsgov:${REQUEST_ID}`, blockIndex: "77" } });
  expect(h.neuron?.dissolveState).toEqual({ kind: "delay", value: 86400n });
  expect(h.neuron?.autoStakeMaturity).toBe(true);
  expect(h.neuron?.permissions[0]!.permissions).toContain(1);
  const again = await continueStake(REQUEST_ID, {}, h.services);
  expect(again.status).toBe("completed");
  expect(h.fundingCalls).toHaveLength(1);
  expect(h.dispatches).toEqual(["claim", "configure_permission", "dissolve_delay", "auto_stake"]);
});

for (const terminal of ["completed", "rejected"] as const) {
  test(`continuing a ${terminal} staking operation returns retained results without authorization or reads`, async () => {
    const h = harness();
    if (terminal === "rejected") h.fundingReply = { status: "rejected", commandId: `snsgov:${REQUEST_ID}`, blockIndex: null, duplicate: null, message: "The user rejected funding" };
    await prepareStake(stakeInput(), h.services);
    expect((await continueStake(REQUEST_ID, {}, h.services)).status).toBe(terminal);
    const counts = { authorizations: h.authorizations, reads: h.snapshots.length, calls: h.walletCalls.length, events: h.events.length };
    const result = await continueStake(REQUEST_ID, {}, {
      ...h.services,
      authorize: async () => { throw new Error("A terminal retry must not reauthorize"); },
      reads: {
        snapshot: async () => { throw new Error("A terminal retry must not read the SNS"); },
        balance: async () => { throw new Error("A terminal retry must not read the ledger"); },
      },
    });
    expect(result.status).toBe(terminal);
    expect({ authorizations: h.authorizations, reads: h.snapshots.length, calls: h.walletCalls.length, events: h.events.length }).toEqual(counts);
  });
}

test("topup retains the existing neuron account and uses refresh by neuron ID", async () => {
  const h = harness({ neuron: claimedNeuron(VECTOR_42, [1, 3, 4]) });
  const input = stakeInput();
  const result = await prepareTopUp({ operationId: input.operationId, sns: input.sns, governance: input.governance, ledger: input.ledger, amountAtoms: "100000000", validUntilNs: input.validUntilNs!, neuronId: VECTOR_42 }, h.services);
  const saved = JSON.parse(result.operation.input_json);
  expect(saved.nonce).toBeNull();
  expect(saved.baselineStakeAtoms).toBe("200000000");
  expect(toHex(decodeIcrcAccount(saved.funding.route.to).subaccount!)).toBe(VECTOR_42);
  expect(result.operation.steps.map(step => step.step_id)).toEqual(["refresh"]);
  expect(decodeManageNeuronRequest(result.operation.steps[0]!.args).command).toEqual([{ ClaimOrRefresh: { by: [{ NeuronId: {} }] } }]);
  expect(h.fundingCalls).toEqual([]);
});

test("an SNS minimum stake increase between review and funding stops the transfer", async () => {
  const h = harness();
  await prepareStake(stakeInput(), h.services);
  h.minimumStake = 300000000n;
  await expect(continueStake(REQUEST_ID, {}, h.services)).rejects.toThrow(/300000000/);
  expect(h.fundingCalls).toEqual([]);
  expect(h.dispatches).toEqual([]);
  expect(JSON.parse(h.operation.state_json).fundingStatus).toBe("prepared");
});

test("topup minimum validation uses the actual account balance when cached stake is lower", async () => {
  const neuron = { ...claimedNeuron(VECTOR_42, [1, 3, 4]), stakeE8s: 1n };
  const h = harness({ neuron, balance: 90000000n });
  const input = stakeInput();
  const result = await prepareTopUp({ operationId: input.operationId, sns: input.sns, governance: input.governance, ledger: input.ledger, amountAtoms: "10000000", validUntilNs: input.validUntilNs!, neuronId: VECTOR_42 }, h.services);
  expect(result.status).toBe("prepared");
  expect(JSON.parse(result.operation.input_json).baselineStakeAtoms).toBe("90000000");
  expect(h.fundingCalls).toEqual([]);
});

test("topup below the SNS minimum after funding is rejected before creating a request", async () => {
  const h = harness({ neuron: claimedNeuron(VECTOR_42, [1, 3, 4]), balance: 1n });
  const input = stakeInput();
  await expect(prepareTopUp({ operationId: input.operationId, sns: input.sns, governance: input.governance, ledger: input.ledger, amountAtoms: "10000000", validUntilNs: input.validUntilNs!, neuronId: VECTOR_42 }, h.services)).rejects.toThrow(/at least/);
  expect(h.events).toEqual([]);
  expect(h.fundingCalls).toEqual([]);
});

test("pending funding keeps its original request and skips unfunded preflight on continuation", async () => {
  const h = harness();
  h.fundingReply = { status: "pending", commandId: `snsgov:${REQUEST_ID}`, blockIndex: null, duplicate: null, message: "Outcome remains unknown" };
  await prepareStake(stakeInput(), h.services);
  expect((await continueStake(REQUEST_ID, {}, h.services)).status).toBe("pending");
  const original = h.fundingCalls[0]!.arguments;
  h.minimumStake = 300000000n;
  h.mode = 2;
  const result = await continueStake(REQUEST_ID, {}, {
    ...h.services,
    reads: {
      snapshot: async () => { throw new Error("Pending funding cannot be reinterpreted as unfunded"); },
      balance: async () => { throw new Error("Pending funding cannot repeat initial balance checks"); },
    },
  });
  expect(result.status).toBe("pending");
  expect(h.fundingCalls).toHaveLength(2);
  expect(h.fundingCalls[1]!.arguments).toEqual(original);
  expect(h.dispatches).toEqual([]);
});

test("a missing Wallet token is included in the retained review before selection or funding", async () => {
  const h = harness({ selected: false });
  const result = await prepareStake(stakeInput(), h.services);
  expect(JSON.parse(result.operation.input_json).walletSelectionNeeded).toBe(true);
  expect(result.review.details).toContain("Add this SNS token to ICWallet, preserving every other selected token, before funding.");
  expect(h.authorizations).toBe(0);
  expect(h.walletCalls.map(call => call.name)).toEqual(["wallet_overview"]);
  expect(h.fundingCalls).toEqual([]);
});

test("Normal staking adds a reviewed missing token after authorization and before funding", async () => {
  const h = harness({ selected: false });
  await prepareStake(stakeInput(), h.services);
  expect((await continueStake(REQUEST_ID, {}, h.services)).status).toBe("completed");
  const added = h.walletCalls.filter(call => call.name === "wallet_add_ledger_v1");
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ target: "app:wallet:background", arguments: { ledger: LEDGER } });
  expect(h.events.indexOf("authorize")).toBeLessThan(h.events.indexOf("wallet_add_ledger_v1"));
  expect(h.events.indexOf("wallet_add_ledger_v1")).toBeLessThan(h.events.indexOf("wallet_fund_v1"));
  expect(h.fundingCalls).toHaveLength(1);
  expect(h.walletCalls.some(call => call.name === "wallet_add_ledger_root_v1")).toBe(false);
});

test("Root staking returns token addition first and funding only after Wallet confirms selection", async () => {
  const h = harness({ root: true, selected: false });
  await prepareStake(stakeInput(), h.services);
  const original = JSON.parse(h.operation.input_json).funding;
  const first = await continueStake(REQUEST_ID, {}, h.services);
  expect(first.status).toBe("pending");
  expect(first.fundingInstructions).toEqual([{ target: "app:wallet:background", name: "wallet_add_ledger_root_v1", arguments: { ledger: LEDGER } }]);
  expect(JSON.parse(h.operation.state_json).fundingStatus).toBe("prepared");
  expect(h.walletCalls.every(call => call.name === "wallet_overview")).toBe(true);
  expect(h.dispatches).toEqual([]);
  h.selected = true;
  const second = await continueStake(REQUEST_ID, {}, h.services);
  expect(second.status).toBe("pending");
  expect(second.fundingInstructions).toEqual([{ target: "app:wallet:background", name: "wallet_fund_root_v1", arguments: original }]);
  expect(JSON.parse(h.operation.state_json).fundingStatus).toBe("requested");
  expect(h.walletCalls.every(call => call.name === "wallet_overview")).toBe(true);
  expect(h.fundingCalls).toEqual([]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const normalTransferReceipt = () => ({ status: "transferred", commandId: `snsgov:${REQUEST_ID}`, blockIndex: "77", duplicate: false, message: null });

test("a transfer receipt merges after another continuation changes the journal revision", async () => {
  const h = harness();
  const started = deferred<void>();
  const receipt = deferred<unknown>();
  h.fundingHandler = () => { started.resolve(undefined); return receipt.promise; };
  await prepareStake(stakeInput(), h.services);
  const continuation = continueStake(REQUEST_ID, {}, h.services);
  await started.promise;
  const pending = h.operation;
  expect(JSON.parse(pending.state_json).fundingStatus).toBe("requested");
  await createOperationClient(h.services.kernel).update(pending, { ...JSON.parse(pending.state_json), concurrentObservation: "retained" });
  receipt.resolve(normalTransferReceipt());
  expect((await continuation).status).toBe("completed");
  expect(h.casConflicts).toBe(1);
  expect(JSON.parse(h.operation.state_json)).toMatchObject({ fundingStatus: "transferred", concurrentObservation: "retained", fundingResult: normalTransferReceipt() });
  expect(h.fundingCalls).toHaveLength(1);
  expect(h.dispatches).toEqual(["claim", "dissolve_delay", "auto_stake"]);
});

test("a concurrent late pending reply preserves a recorded transfer and completed neuron effects", async () => {
  const h = harness();
  const firstStarted = deferred<void>(), secondStarted = deferred<void>();
  const firstReceipt = deferred<unknown>(), secondReceipt = deferred<unknown>();
  let calls = 0;
  h.fundingHandler = () => {
    if (calls++ === 0) { firstStarted.resolve(undefined); return firstReceipt.promise; }
    secondStarted.resolve(undefined);
    return secondReceipt.promise;
  };
  await prepareStake(stakeInput(), h.services);
  const first = continueStake(REQUEST_ID, {}, h.services);
  await firstStarted.promise;
  const second = continueStake(REQUEST_ID, {}, h.services);
  await secondStarted.promise;
  firstReceipt.resolve(normalTransferReceipt());
  expect((await first).status).toBe("completed");
  secondReceipt.resolve({ status: "pending", commandId: `snsgov:${REQUEST_ID}`, blockIndex: null, duplicate: null, message: "Earlier observation has no outcome" });
  expect((await second).status).toBe("completed");
  expect(h.casConflicts).toBe(1);
  expect(JSON.parse(h.operation.state_json)).toMatchObject({ fundingStatus: "transferred", fundingResult: normalTransferReceipt() });
  expect(h.fundingCalls).toHaveLength(2);
  expect(h.fundingCalls[1]!.arguments).toEqual(h.fundingCalls[0]!.arguments);
  expect(h.dispatches).toEqual(["claim", "dissolve_delay", "auto_stake"]);
});
