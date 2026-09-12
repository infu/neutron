import { expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { buildProposalAction, decodeProposalAction, encodeProposalAction, proposalActionCatalog, proposalActionToJson, validateProposalText } from "../src/data/proposal_actions";
import { decodeManageNeuronRequest, decodeManageNeuronResponse, encodeMakeProposal, encodeManageNeuronCommand, manageNeuronCommandCatalog } from "../src/data/manage_neuron";
import { governanceMethodTypes } from "../src/data/governance_codec";

const principal = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const neuronId = "07".repeat(32);
const wasm = { hex: "0061736d01000000" };
const chunk = { store_canister_id: principal, wasm_module_hash: { hex: "11".repeat(32) }, chunk_hashes_list: [{ hex: "22".repeat(32) }] };
const fixtures: Record<string, unknown> = {
  Motion: { motion_text: "A motion" },
  ManageNervousSystemParameters: { automatically_advance_target_version: true, custom_proposal_criticality: { additional_critical_native_action_ids: ["1"] } },
  UpgradeSnsControlledCanister: { canister_id: principal, new_canister_wasm: wasm, mode: "3", canister_upgrade_options: { skip_pre_upgrade: false, wasm_memory_persistence: "1" } },
  AddGenericNervousSystemFunction: { id: "1000", name: "Example", function_type: { GenericNervousSystemFunction: { target_canister_id: principal, target_method_name: "execute", validator_canister_id: principal, validator_method_name: "validate", topic: { ApplicationBusinessLogic: null } } } },
  RemoveGenericNervousSystemFunction: "1000",
  ExecuteGenericNervousSystemFunction: { function_id: "18446744073709551615", payload: { hex: "00ff01" } },
  UpgradeSnsToNextVersion: {},
  ManageSnsMetadata: { name: "New name" },
  TransferSnsTreasuryFunds: { from_treasury: "1", amount_e8s: "9007199254740993", to_principal: principal, to_subaccount: { subaccount: { hex: "88".repeat(32) } }, memo: "0" },
  RegisterDappCanisters: { canister_ids: [principal] },
  DeregisterDappCanisters: { canister_ids: [principal], new_controllers: [principal] },
  MintSnsTokens: { amount_e8s: "100000000", to_principal: principal },
  ManageLedgerParameters: { transfer_fee: "10000", token_symbol: "SNS" },
  ManageDappCanisterSettings: { canister_ids: [principal], snapshot_visibility: "2", wasm_memory_threshold: "12345", wasm_memory_limit: "99999" },
  AdvanceSnsTargetVersion: {},
  SetTopicsForCustomProposals: { custom_function_id_to_topic: [["1000", { ApplicationBusinessLogic: null }]] },
  RegisterExtension: { chunked_canister_wasm: chunk, extension_init: { value: { Map: [["token", { Text: principal }]] } } },
  ExecuteExtensionOperation: { extension_canister_id: principal, operation_name: "withdraw", operation_arg: { value: null } },
  UpgradeExtension: { extension_canister_id: principal, wasm: { Bytes: wasm } },
};

test("all 19 proposal actions encode as actual MakeProposal variants", () => {
  const catalog = proposalActionCatalog();
  expect(catalog.map(action => action.id)).toEqual(Array.from({ length: 19 }, (_, i) => String(i + 1)));
  expect(catalog.map(action => action.actionKind).sort()).toEqual(Object.keys(fixtures).sort());
  expect(catalog.find(action => action.actionKind === "RegisterExtension")?.availabilityNote).toContain("installed Governance");
  for (const { actionKind, schema } of catalog) {
    expect(JSON.parse(JSON.stringify(schema))).toBeDefined();
    const action = buildProposalAction(actionKind, fixtures[actionKind]);
    const request = decodeManageNeuronRequest(encodeMakeProposal({ neuronId, title: actionKind, summary: "", url: "", action }));
    expect(request.command[0] && "MakeProposal" in request.command[0] ? Object.keys(request.command[0].MakeProposal.action[0] ?? {}) : []).toEqual([actionKind]);
    expect(proposalActionToJson(decodeProposalAction(encodeProposalAction(actionKind, fixtures[actionKind])))).toEqual(proposalActionToJson(action));
  }
});

test("native action codec preserves dangerous-to-drop options and wide amounts", () => {
  const transfer = buildProposalAction("TransferSnsTreasuryFunds", fixtures.TransferSnsTreasuryFunds);
  expect("TransferSnsTreasuryFunds" in transfer && transfer.TransferSnsTreasuryFunds.amount_e8s).toBe(9007199254740993n);
  const upgrade = buildProposalAction("UpgradeSnsControlledCanister", fixtures.UpgradeSnsControlledCanister);
  expect("UpgradeSnsControlledCanister" in upgrade && upgrade.UpgradeSnsControlledCanister.canister_upgrade_options[0]).toEqual({ skip_pre_upgrade: [false], wasm_memory_persistence: [1] });
  expect(() => buildProposalAction("Motion", { motion_text: "hello", misspelled: true })).toThrow(/unknown/i);
  expect(() => buildProposalAction("Unspecified", {})).toThrow(/not a valid/);
  expect(() => buildProposalAction("ExecuteGenericNervousSystemFunction", { function_id: "999", payload: [] })).toThrow(/1000/);
});

test("protocol text limits count UTF-8 bytes while URL counts characters", () => {
  expect(() => validateProposalText({ title: "é".repeat(128), summary: "", url: "😀".repeat(2048) })).not.toThrow();
  expect(() => validateProposalText({ title: "é".repeat(129), summary: "", url: "" })).toThrow(/256 UTF-8/);
  expect(() => buildProposalAction("Motion", { motion_text: "é".repeat(5001) })).toThrow(/10000 UTF-8/);
});

test("manage command JSON supports nested configuration and exact response receipts", () => {
  expect(manageNeuronCommandCatalog().map(command => command.kind)).toContain("SetFollowing");
  const request = decodeManageNeuronRequest(encodeManageNeuronCommand(neuronId, "Configure", { operation: { SetDissolveTimestamp: { dissolve_timestamp_seconds: "9007199254740993" } } }));
  expect(request.command[0]).toEqual({ Configure: { operation: [{ SetDissolveTimestamp: { dissolve_timestamp_seconds: 9007199254740993n } }] } });
  const ret = governanceMethodTypes("manage_neuron").retTypes[0]!;
  const respond = (command: unknown) => decodeManageNeuronResponse(new Uint8Array(IDL.encode([ret], [{ command: [command] }])));
  expect(respond({ Split: { created_neuron_id: [{ id: Uint8Array.from(Buffer.from(neuronId, "hex")) }] } })).toMatchObject({ ok: true, neuronId });
  expect(respond({ Disburse: { transfer_block_height: 9007199254740993n } })).toMatchObject({ ok: true, transferBlockHeight: 9007199254740993n, responseJson: { command: { Disburse: { transfer_block_height: "9007199254740993" } } } });
  expect(respond({ DisburseMaturity: { amount_disbursed_e8s: 12n, amount_deducted_e8s: [13n] } })).toMatchObject({ amountDisbursedE8s: 12n, amountDeductedE8s: 13n });
  expect(respond({ StakeMaturity: { maturity_e8s: 4n, staked_maturity_e8s: 5n } })).toMatchObject({ maturityE8s: 4n, stakedMaturityE8s: 5n });
  const empty = decodeManageNeuronResponse(new Uint8Array(IDL.encode([ret], [{ command: [] }])));
  expect(empty.ok).toBe(false);
  expect(empty.rawReplyHex).toMatch(/^4449444c/);
});
