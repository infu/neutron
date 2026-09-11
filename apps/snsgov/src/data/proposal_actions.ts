/**
 * Proposal capabilities known to the bundled SNS interface. Availability is
 * determined by the selected SNS's function registry, installed version and
 * state; this catalog never claims a proposal is guaranteed to be accepted.
 * Protocol reference: dfinity/ic 605a5396f12536e4e7b30479397e196c71b18961.
 */
import { IDL } from "@dfinity/candid";
import type { Action } from "../candid/sns_governance.did";
import { candidTypeSchema, candidValueFromJson, candidValueToJson } from "./candid_codec";
import { candidFieldType, governanceActionType } from "./governance_codec";

export interface ProposalActionDescriptor {
  id: string;
  actionKind: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  topic?: string;
  availabilityNote?: string;
}

const extensionNote = "Implemented in the SNS interface. The production extension Wasm allowlist is empty in upstream 605a5396 (2026-09-11); eligibility depends on this SNS's installed Governance version and extension implementation.";
const definitions: Omit<ProposalActionDescriptor, "schema">[] = [
  { id: "1", actionKind: "Motion", name: "Motion", description: "Record a community decision with motion text.", topic: "Governance" },
  { id: "2", actionKind: "ManageNervousSystemParameters", name: "Governance parameters", description: "Change selected governance parameters; omitted fields retain their values. Change the actual ledger fee with ManageLedgerParameters.", topic: "DaoCommunitySettings" },
  { id: "3", actionKind: "UpgradeSnsControlledCanister", name: "Upgrade controlled canister", description: "Install inline or chunked Wasm with explicit arguments, mode and upgrade options.", topic: "DappCanisterManagement" },
  { id: "4", actionKind: "AddGenericNervousSystemFunction", name: "Register custom function", description: "Register a new unused function ID, execution target, validator/renderer and topic.", topic: "CriticalDappOperations" },
  { id: "5", actionKind: "RemoveGenericNervousSystemFunction", name: "Remove custom function", description: "Remove a registered function. Its ID remains permanently reserved.", topic: "CriticalDappOperations" },
  { id: "6", actionKind: "ExecuteGenericNervousSystemFunction", name: "Execute custom function", description: "Propose exact payload bytes for an existing registered custom function. Its assigned topic governs voting." },
  { id: "7", actionKind: "UpgradeSnsToNextVersion", name: "Upgrade SNS to next version", description: "Advance one framework upgrade step using the supported legacy proposal path.", topic: "SnsFrameworkManagement", availabilityNote: "Supported legacy path. AdvanceSnsTargetVersion selects a framework target for automatic progression." },
  { id: "8", actionKind: "ManageSnsMetadata", name: "SNS metadata", description: "Update the SNS name, description, URL or logo.", topic: "DaoCommunitySettings" },
  { id: "9", actionKind: "TransferSnsTreasuryFunds", name: "Transfer treasury funds", description: "Transfer ICP or SNS tokens from Governance's treasury to an exact destination account.", topic: "TreasuryAssetManagement" },
  { id: "10", actionKind: "RegisterDappCanisters", name: "Register dapp canisters", description: "Register canisters whose controllers already permit SNS Root to manage them.", topic: "DappCanisterManagement" },
  { id: "11", actionKind: "DeregisterDappCanisters", name: "Deregister dapp canisters", description: "Release registered dapps to the specified new controllers.", topic: "CriticalDappOperations" },
  { id: "12", actionKind: "MintSnsTokens", name: "Mint SNS tokens", description: "Mint tokens to an exact destination account, subject to SNS treasury rules.", topic: "TreasuryAssetManagement" },
  { id: "13", actionKind: "ManageLedgerParameters", name: "Ledger parameters", description: "Change token branding or the actual ledger transfer fee; successful fee changes synchronize Governance.", topic: "DaoCommunitySettings" },
  { id: "14", actionKind: "ManageDappCanisterSettings", name: "Dapp canister settings", description: "Change resources and visibility for registered dapp canisters.", topic: "DappCanisterManagement", availabilityNote: "Upstream 605a5396 omits wasm_memory_threshold from rendered/change-detection fields. A threshold-only proposal is rejected there; the field is forwarded when another setting changes." },
  { id: "15", actionKind: "AdvanceSnsTargetVersion", name: "Advance SNS target version", description: "Choose a known framework target, or omit new_target to use the latest known upgrade step.", topic: "SnsFrameworkManagement" },
  { id: "16", actionKind: "SetTopicsForCustomProposals", name: "Set custom function topics", description: "Assign or change topics for registered custom functions.", topic: "CriticalDappOperations" },
  { id: "17", actionKind: "RegisterExtension", name: "Register extension", description: "Install an eligible extension from chunked Wasm and precise initialization values.", topic: "CriticalDappOperations", availabilityNote: extensionNote },
  { id: "18", actionKind: "ExecuteExtensionOperation", name: "Execute extension operation", description: "Propose a registered extension operation with its precise argument values.", availabilityNote: extensionNote },
  { id: "19", actionKind: "UpgradeExtension", name: "Upgrade extension", description: "Upgrade an eligible existing extension using inline or chunked Wasm.", topic: "CriticalDappOperations", availabilityNote: extensionNote },
];

export function proposalActionCatalog(): ProposalActionDescriptor[] {
  return definitions.map(definition => ({ ...definition, schema: proposalActionSchema(definition.actionKind) }));
}

export function proposalActionSchema(actionKind: string): Record<string, unknown> {
  requireKnownAction(actionKind);
  return candidTypeSchema(candidFieldType(governanceActionType(), actionKind));
}

export function buildProposalAction(actionKind: string, input: unknown): Action {
  requireKnownAction(actionKind);
  const action = candidValueFromJson(governanceActionType(), { [actionKind]: input }) as Action;
  validateProposalAction(action);
  return action;
}

/** Serialize only an Action, suitable for durable drafts without a proposer. */
export function encodeProposalAction(actionKind: string, input: unknown): Uint8Array {
  return new Uint8Array(IDL.encode([governanceActionType()], [buildProposalAction(actionKind, input)]));
}

export function decodeProposalAction(bytes: Uint8Array): Action {
  const action = IDL.decode([governanceActionType()], bytes)[0] as Action;
  validateProposalAction(action);
  return action;
}

export function proposalActionToJson(action: Action): unknown {
  return candidValueToJson(governanceActionType(), action);
}

/** Actual protocol string bounds: bytes for title/summary, characters for URL. */
export function validateProposalText(value: { title: string; summary: string; url: string }): void {
  utf8Limit("title", value.title, 256);
  utf8Limit("summary", value.summary, 30_000);
  if (typeof value.url !== "string" || Array.from(value.url).length > 2048) throw new RangeError("Proposal URL must be at most 2048 characters.");
}

/** Local structural requirements; changing remote state is validated by SNS. */
export function validateProposalAction(action: Action): void {
  const actionKind = Object.keys(action)[0];
  requireKnownAction(actionKind ?? "");
  if ("Motion" in action) utf8Limit("motion_text", action.Motion.motion_text, 10_000);
  if ("ExecuteGenericNervousSystemFunction" in action) genericId(action.ExecuteGenericNervousSystemFunction.function_id);
  if ("RemoveGenericNervousSystemFunction" in action) genericId(action.RemoveGenericNervousSystemFunction);
  if ("AddGenericNervousSystemFunction" in action) {
    const fn = action.AddGenericNervousSystemFunction;
    genericId(fn.id);
    if (!fn.name) throw new TypeError("Custom function name is required.");
    utf8Limit("function name", fn.name, 256);
    if (fn.description[0] !== undefined) utf8Limit("function description", fn.description[0], 10_000);
    const type = fn.function_type[0];
    if (!type || !("GenericNervousSystemFunction" in type)) throw new TypeError("A new custom function requires GenericNervousSystemFunction metadata.");
    const generic = type.GenericNervousSystemFunction;
    if (!generic.target_canister_id[0] || !generic.target_method_name[0] || !generic.validator_canister_id[0] || !generic.validator_method_name[0] || !generic.topic[0]) {
      throw new TypeError("A new custom function requires target, validator, both method names and a topic.");
    }
  }
  if ("SetTopicsForCustomProposals" in action) {
    const mapping = action.SetTopicsForCustomProposals.custom_function_id_to_topic;
    if (mapping.length === 0) throw new TypeError("At least one custom function topic assignment is required.");
    const ids = new Set<string>();
    for (const [id] of mapping) {
      genericId(id);
      if (ids.has(id.toString())) throw new TypeError(`Duplicate topic assignment for function ${id}.`);
      ids.add(id.toString());
    }
  }
}

function requireKnownAction(kind: string): void {
  if (!definitions.some(definition => definition.actionKind === kind)) throw new TypeError(`Unsupported proposal action: ${kind}. Unspecified is not a valid proposal.`);
}

function genericId(id: bigint): void {
  if (id < 1000n || id > 18_446_744_073_709_551_615n) throw new RangeError("Custom function IDs must be nat64 values of at least 1000.");
}

function utf8Limit(name: string, value: string, maximum: number): void {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > maximum) throw new RangeError(`${name} must be at most ${maximum} UTF-8 bytes.`);
}
