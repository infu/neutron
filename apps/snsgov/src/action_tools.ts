/** Resident action surface shared by the tile and authenticated agent calls. */
import { IDL } from "@dfinity/candid";
import { idlFactory as governanceIdl } from "./candid/sns_governance.did.js";
import { actorFor } from "./data/agent";
import { candidArgsFromJson, candidArgsToJson, candidTypeSchema } from "./data/candid_codec";
import { governanceReadToJson } from "./tools/projections";
import { exposeTool, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { authorizeAction } from "./provider";
import { operationId as newOperationId } from "./data/actions_client";
import { readHotkey } from "./data/relay";
import { requireEntry, displayName, type RegistryEntry } from "./data/registry";
import { fromHex, toHex } from "./data/format";
import { SnsError } from "./data/errors";
import { getNeuron, readParameters, listTopics, readRunningSnsVersion, readUpgradeJournal, listProposals } from "./data/governance";
import { createOperationClient, operationJson, operationJsonText, operationObject, type OperationDetail } from "./data/operations";

const text: JsonObject = { type: "string" };
const decimal: JsonObject = { type: "string", pattern: "^[0-9]+$", description: "Exact nonnegative decimal integer; never a rounded JSON number." };
const operationIdArg: JsonObject = { type: "string", pattern: "^[0-9a-f]{32}$", description: "Create once for a new intent; retain exactly after approval, dispatch, interruption or an unknown outcome." };
const neuronIdArg: JsonObject = { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "32-byte SNS neuron ID in hexadecimal." };
const rootArg: JsonObject = { type: "string", description: "Existing SNS root canister ID from sns_list." };
const variantArg: JsonObject = { type: "object", description: "Exactly one Candid variant: {VariantName: fields}. Inspect sns_proposal_schema_v1 for supported commands/actions and natural JSON field shapes.", additionalProperties: true };
const object = (properties: JsonObject, required: string[] = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const openObject: JsonObject = { type: "object", additionalProperties: true };
const readOnly: JsonObject = { "neutron:effects": ["read", "network"], "neutron:long_running": true };
const reviewed: JsonObject = { "neutron:effects": ["read", "network", "write", "user_visible_ui"], "neutron:consent": "provider_once", "neutron:long_running": true };
const operationSchema: JsonObject = {
  type: "object", required: ["version", "operationId", "status"], additionalProperties: true,
  properties: {
    version: { const: 1 }, operationId: operationIdArg, status: { type: "string" },
    rootCanisterId: text, governanceCanisterId: text, kind: text,
    review: openObject, input: openObject, state: openObject, operation: openObject,
    steps: { type: "array", items: openObject }, outcomes: { type: "array", items: openObject },
    fundingInstructions: { type: "array", items: openObject },
    createdAtSeconds: decimal, updatedAtSeconds: decimal,
  },
};
function register(name: string, title: string, description: string, properties: JsonObject, required: string[], annotations: JsonObject, outputSchema: JsonObject, handler: (input: JsonObject, context: MsgBusToolContext) => Promise<unknown>) {
  exposeTool(name, { title, description, inputSchema: object(properties, required), outputSchema, annotations }, async (args, context) => operationJson(await handler(args, context)));
}
function singleVariant(value: unknown, label: string): [string, unknown] {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1) throw new SnsError("INVALID_REQUEST", `${label} must contain exactly one variant.`);
  return Object.entries(value)[0]!;
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return Uint8Array.from(value);
  throw new Error("The saved draft has invalid payload bytes.");
}
function principal(value: unknown): string {
  return typeof value === "object" && value !== null && "toText" in value && typeof value.toText === "function" ? value.toText() : String(value);
}
/** Stable legacy draft binding. Proposer is excluded: selecting another neuron
 * must not permit replaying a draft that already produced a proposal. */
export async function draftOperationId(draft: Record<string, unknown>): Promise<string> {
  const content = {
    kind: "sns-draft-submission-v1", sns: principal(draft.sns), id: String(draft.id),
    updatedAtSeconds: String(draft.updated_at_seconds ?? "0"),
    title: String(draft.title ?? ""), summary: String(draft.summary ?? ""), url: String(draft.url ?? ""),
    actionKind: String(draft.action_kind ?? "Motion"), functionId: draft.function_id == null ? null : String(draft.function_id),
    payload: draft.payload == null ? null : bytes(draft.payload),
  };
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operationJsonText(content))))).slice(0, 32);
}
export async function encodeNativeDraft(action: unknown): Promise<Uint8Array> {
  const [kind, value] = singleVariant(action, "action");
  return (await import("./data/proposal_actions")).encodeProposalAction(kind, value);
}
export async function decodeNativeDraft(payload: Uint8Array): Promise<unknown> {
  const module = await import("./data/proposal_actions");
  return module.proposalActionToJson(module.decodeProposalAction(payload));
}
async function connectionRows(context: MsgBusToolContext): Promise<Record<string, unknown>[]> {
  const config = await context.kernel.querySelf("snsgov_config", [null]) as unknown as { snses: Record<string, unknown>[] };
  return config.snses;
}
async function services(context: MsgBusToolContext, entry: RegistryEntry, ownerVote = false) {
  const hotkey = await readHotkey(context.kernel);
  return {
    kernel: context.kernel, principal: hotkey.principal, initiator: context.agentMode ? "agent" as const : "user" as const,
    authorize: async (review: JsonObject) => {
      const row = (await connectionRows(context)).find(row => principal(row.sns) === entry.canisters.root);
      const enable = !row?.voting_enabled || principal(row.governance) !== entry.canisters.governance;
      await authorizeAction(context, {
        ...review,
        ...(enable ? { snsAccess: { rootCanisterId: entry.canisters.root, governanceCanisterId: entry.canisters.governance, action: "Enable Neutron access to this SNS", note: "The saved unattended agent-voting preference will remain unchanged." } } : {}),
      }, { ownerVote: ownerVote && !enable });
      if (enable) {
        const latest = (await connectionRows(context)).find(row => principal(row.sns) === entry.canisters.root);
        await context.kernel.updateSelf("snsgov_sns_upsert", [{ sns: entry.canisters.root, governance: entry.canisters.governance,
          voting_enabled: true, agent_voting_enabled: Boolean(latest?.agent_voting_enabled), label_text: String(latest?.label_text ?? displayName(entry)).slice(0, 64),
        }]);
      }
    },
    ...(entry.token ? { token: { symbol: entry.token.symbol, decimals: entry.token.decimals } } : {}),
    funding: { root: !!context.agentMode, callerAppId: context.agentMode ? context.caller?.appId ?? "" : "snsgov" },
    ...(context.signal ? { signal: context.signal } : {}),
  };
}
async function target(rootCanisterId: unknown) {
  const entry = await requireEntry(String(rootCanisterId));
  if (!entry.liveness.governance) throw new SnsError("SNS_GOVERNANCE_INACTIVE", "This SNS governance canister is unavailable.");
  return entry;
}
function compactEvidence(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(compactEvidence);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "argsHex" && key !== "replyHex").map(([key, item]) => [key, compactEvidence(item)]));
  return value;
}
function operationProjection(operation: OperationDetail, includeRaw = false): JsonObject {
  const input = operationObject(operation.input_json, "operation input"), review = operationObject(operation.review_json, "operation review"), state = operationObject(operation.state_json);
  return {
    operationId: operation.operation_id, rootCanisterId: operation.sns, governanceCanisterId: operation.governance,
    kind: typeof input.kind === "string" ? input.kind : "manage_neuron", input: includeRaw ? input : compactEvidence(input), review: includeRaw ? review : compactEvidence(review), state,
    rawEvidenceIncluded: includeRaw,
    createdAtSeconds: operation.created_at_seconds, updatedAtSeconds: operation.updated_at_seconds,
    steps: operation.steps.map(step => ({ stepId: step.step_id, status: step.status,
      ...(step.error ? { error: step.error } : {}),
      ...(includeRaw ? { argsHex: toHex(step.args), ...(step.reply ? { replyHex: toHex(step.reply) } : {}) } : {}),
    })),
  };
}
function resultProjection(value: unknown): JsonObject {
  if (!value || typeof value !== "object") throw new Error("SNS operation returned an invalid result.");
  const result = value as { operationId: string; status: string; operation?: OperationDetail; [key: string]: unknown };
  const { operation, ...rest } = result;
  const json = operationJson(rest) as JsonObject;
  if (!operation) return { ...json, version: 1 };
  const { review: _duplicateReview, ...retained } = operationProjection(operation);
  return { ...json, review: compactEvidence(operationObject(operation.review_json)), version: 1, operation: retained };
}

register("sns_neuron_v1", "Read one SNS neuron", "Read the current neuron, its actual principal permissions and governance parameters directly from the SNS. Shared access does not imply ownership or permission to transfer control.", { rootCanisterId: rootArg, neuronId: neuronIdArg }, ["rootCanisterId", "neuronId"], readOnly, object({ version: { const: 1 }, rootCanisterId: text, governanceCanisterId: text, principal: text, capabilities: { type: ["object", "null"], additionalProperties: true }, neuron: { type: ["object", "null"], additionalProperties: true }, parameters: openObject, token: { type: ["object", "null"], additionalProperties: true } }), async (args, context) => {
  const entry = await target(args.rootCanisterId);
  const [hotkey, neuron, parameters] = await Promise.all([readHotkey(context.kernel), getNeuron(entry.canisters.governance, String(args.neuronId)), readParameters(entry.canisters.governance)]);
  return { version: 1, rootCanisterId: entry.canisters.root, governanceCanisterId: entry.canisters.governance, principal: hotkey.principal, neuron: neuron ?? null, capabilities: neuron ? (await import("./data/neuron_actions")).neuronCapabilities(neuron, hotkey.principal, parameters) : null, parameters, token: entry.token ? { symbol: entry.token.symbol, decimals: entry.token.decimals, feeAtoms: String(entry.token.fee), ledgerCanisterId: entry.canisters.ledger } : null };
});
register("sns_proposal_schema_v1", "Inspect SNS action and command schemas", "Discover every supported native proposal action and manage-neuron command. Natural JSON uses decimal integer strings, textual principals, null/omitted optionals, single-key variants and blobs as arrays or {hex:...}. A listed action can still be unavailable under an SNS's current mode or permissions.", { rootCanisterId: rootArg, kind: { enum: ["proposal", "command", "all"] }, actionKind: text, commandKind: text }, [], readOnly, object({ version: { const: 1 }, actions: { type: "array", items: openObject }, commands: { type: "array", items: openObject } }), async args => {
  const actions = await import("./data/proposal_actions"), commands = await import("./data/manage_neuron");
  return { version: 1, actions: args.kind === "command" ? [] : actions.proposalActionCatalog().filter(row => !args.actionKind || row.actionKind === args.actionKind), commands: args.kind === "proposal" ? [] : commands.manageNeuronCommandCatalog().filter(row => !args.commandKind || row.kind === args.commandKind || row.name === args.commandKind) };
});
for (const [name, title, method] of [["sns_topics_v1", "Read SNS voting topics", "topics"], ["sns_version_v1", "Read running SNS versions", "version"], ["sns_upgrade_journal_v1", "Read SNS upgrade journal", "upgrades"]] as const) register(name, title, "Query the SNS directly. This reads protocol state and never schedules or executes an upgrade.", { rootCanisterId: rootArg, offset: decimal, limit: decimal }, ["rootCanisterId"], readOnly, object({ version: { const: 1 }, rootCanisterId: text, result: openObject }), async args => {
  const entry = await target(args.rootCanisterId);
  const result = method === "topics" ? await listTopics(entry.canisters.governance) : method === "version" ? await readRunningSnsVersion(entry.canisters.governance) : await readUpgradeJournal(entry.canisters.governance, { ...(args.offset === undefined ? {} : { offset: BigInt(String(args.offset)) }), ...(args.limit === undefined ? {} : { limit: BigInt(String(args.limit)) }) });
  return { version: 1, rootCanisterId: entry.canisters.root, result: governanceReadToJson(method === "topics" ? "list_topics" : method === "version" ? "get_running_sns_version" : "get_upgrade_journal", result) };
});
register("sns_delete_draft_v1", "Delete a saved proposal draft", "Remove only this app's off-chain draft. A submitted proposal and its durable operation history remain unchanged.", { draftId: decimal }, ["draftId"], { "neutron:effects": ["read", "write"] }, object({ deleted: { type: "boolean" }, draftId: decimal }), async (args, context) => {
  await context.kernel.updateSelf("snsgov_draft_delete", [String(args.draftId)]);
  return { deleted: true, draftId: args.draftId };
});

const manageProperties = { operationId: operationIdArg, rootCanisterId: rootArg, neuronId: neuronIdArg, command: variantArg };
async function neuronInput(args: JsonObject, context: MsgBusToolContext) {
  const entry = await target(args.rootCanisterId), [kind, fields] = singleVariant(args.command, "command");
  const command = (await import("./data/manage_neuron")).buildManageNeuronCommand(kind, fields);
  return { entry, services: await services(context, entry), input: { operationId: String(args.operationId ?? newOperationId()), sns: entry.canisters.root, governance: entry.canisters.governance, neuronId: String(args.neuronId), command } };
}
register("sns_preview_neuron_v1", "Preview a neuron action", "Read permissions and protocol constraints and encode the exact command without saving or dispatching it. This supports every command reported by sns_proposal_schema_v1, including configure, following, split, disbursement and maturity.", manageProperties, ["rootCanisterId", "neuronId", "command"], readOnly, operationSchema, async (args, context) => {
  const plan = await neuronInput(args, context);
  const review = await (await import("./data/neuron_actions")).previewNeuronAction(plan.input, plan.services);
  return { version: 1, operationId: plan.input.operationId, status: "preview", review };
});
register("sns_manage_neuron_v1", "Manage an SNS neuron", "Execute a reviewed command using this Neutron's actual neuron permissions. Root uses exact invocation approval; Normal opens owner review. The original command and reply are retained before/after dispatch. Reuse the same operationId after interruption; an unknown non-idempotent command is never blindly replayed.", manageProperties, ["operationId", "rootCanisterId", "neuronId", "command"], reviewed, operationSchema, async (args, context) => {
  const plan = await neuronInput(args, context), actions = await import("./data/neuron_actions");
  await actions.prepareNeuronAction(plan.input, plan.services);
  return resultProjection(await actions.executeNeuronOperation(plan.input.operationId, plan.services));
});
const proposalProperties = { operationId: operationIdArg, rootCanisterId: rootArg, neuronId: neuronIdArg, title: text, summary: text, url: text, action: variantArg };
async function proposalInput(args: JsonObject, context: MsgBusToolContext) {
  const [kind, fields] = singleVariant(args.action, "action");
  const action = (await import("./data/proposal_actions")).buildProposalAction(kind, fields);
  const entry = await target(args.rootCanisterId);
  return { entry, services: await services(context, entry), input: { operationId: String(args.operationId ?? newOperationId()), sns: entry.canisters.root, governance: entry.canisters.governance, neuronId: String(args.neuronId), command: { MakeProposal: { title: String(args.title), summary: String(args.summary), url: String(args.url ?? ""), action: [action] } } as import("./candid/sns_governance.did").Command } };
}
register("sns_preview_proposal_v1", "Preview an SNS proposal", "Build any native proposal action or ExecuteGenericNervousSystemFunction from exact original payload bytes. Read proposer permissions, lock requirements and rejection cost. No proposal or saved operation is created.", proposalProperties, ["rootCanisterId", "neuronId", "title", "summary", "action"], readOnly, operationSchema, async (args, context) => {
  const plan = await proposalInput(args, context);
  return { version: 1, operationId: plan.input.operationId, status: "preview", review: await (await import("./data/neuron_actions")).previewNeuronAction(plan.input, plan.services) };
});
register("sns_submit_proposal_v1", "Submit an SNS proposal", "Submit the exact reviewed proposal using the selected neuron's SubmitProposal permission. Submission may incur the SNS rejection fee. Root can execute through scoped approval; Normal requires owner review. Preserve operationId and never submit another intent to recover an unknown proposal result.", proposalProperties, ["operationId", "rootCanisterId", "neuronId", "title", "summary", "action"], reviewed, operationSchema, async (args, context) => {
  const plan = await proposalInput(args, context), actions = await import("./data/neuron_actions");
  await actions.prepareNeuronAction(plan.input, plan.services);
  return resultProjection(await actions.executeNeuronOperation(plan.input.operationId, plan.services));
});
register("sns_submit_draft_v1", "Submit a saved SNS proposal draft", "Submit an existing Motion, custom or explicit native draft through the durable proposal journal. The draft has one deterministic submission operationId exposed by sns_drafts; omit operationId to use it. A different ID is rejected, and changing the proposer cannot replay an already dispatched draft.", { draftId: decimal, neuronId: neuronIdArg, operationId: operationIdArg }, ["draftId", "neuronId"], reviewed, operationSchema, async (args, context) => {
  const rows = await context.kernel.querySelf("snsgov_drafts", [null]) as unknown as Record<string, unknown>[];
  const draft = rows.find(row => String(row.id) === args.draftId);
  if (!draft) throw new SnsError("INVALID_REQUEST", "The saved proposal draft was not found. Read its previous operation before creating another proposal.");
  const operationId = await draftOperationId(draft);
  if (args.operationId !== undefined && args.operationId !== operationId) throw new SnsError("INVALID_REQUEST", `This draft must use its original operationId ${operationId}.`);
  let action: unknown;
  if (draft.action_kind === "NativeActionV1") action = await decodeNativeDraft(bytes(draft.payload));
  else if (draft.action_kind === "Motion") action = { Motion: { motion_text: new TextDecoder("utf-8", { fatal: true }).decode(bytes(draft.payload)) } };
  else {
    if (draft.function_id == null || draft.payload == null) throw new SnsError("INVALID_REQUEST", "The legacy custom draft lacks its original function ID or payload.");
    action = { ExecuteGenericNervousSystemFunction: { function_id: String(draft.function_id), payload: Array.from(bytes(draft.payload)) } };
  }
  const plan = await proposalInput({ operationId, rootCanisterId: principal(draft.sns), neuronId: args.neuronId!, title: String(draft.title), summary: String(draft.summary), url: String(draft.url ?? ""), action: operationJson(action) }, context);
  const actions = await import("./data/neuron_actions");
  await actions.prepareNeuronAction(plan.input, plan.services);
  return { ...resultProjection(await actions.executeNeuronOperation(operationId, plan.services)), draftId: args.draftId };
});
register("sns_transfer_control_v1", "Transfer neuron control", "Review a two-step handover: grant the chosen principal your current management permissions, then remove this Neutron's selected access. Existing third-party grants are preserved. keepVotingAccess retains Vote and SubmitProposal only. Root and Normal use the same exact review and durable steps.", { operationId: operationIdArg, rootCanisterId: rootArg, neuronId: neuronIdArg, toPrincipal: text, keepVotingAccess: { type: "boolean", default: false } }, ["operationId", "rootCanisterId", "neuronId", "toPrincipal"], reviewed, operationSchema, async (args, context) => {
  const entry = await target(args.rootCanisterId), service = await services(context, entry), actions = await import("./data/neuron_actions");
  await actions.prepareControlTransfer({ operationId: String(args.operationId), sns: entry.canisters.root, governance: entry.canisters.governance, neuronId: String(args.neuronId), toPrincipal: String(args.toPrincipal), keepVotingAccess: args.keepVotingAccess === true }, service);
  return resultProjection(await actions.executeNeuronOperation(String(args.operationId), service));
});

const stakingProperties = { operationId: operationIdArg, rootCanisterId: rootArg, amountAtoms: decimal, dissolveDelaySeconds: decimal, autoStakeMaturity: { type: "boolean" }, nonce: decimal, fundingResults: { type: "array", items: openObject } };
async function stakingInput(args: JsonObject, context: MsgBusToolContext) {
  const entry = await target(args.rootCanisterId);
  return { entry, services: await services(context, entry), input: { operationId: String(args.operationId ?? newOperationId()), sns: entry.canisters.root, governance: entry.canisters.governance, ledger: entry.canisters.ledger, amountAtoms: String(args.amountAtoms),
    ...(args.dissolveDelaySeconds === undefined ? {} : { dissolveDelaySeconds: String(args.dissolveDelaySeconds) }),
    ...(args.autoStakeMaturity === undefined ? {} : { autoStakeMaturity: args.autoStakeMaturity === true }),
    ...(args.nonce === undefined ? {} : { nonce: String(args.nonce) }),
  } };
}
register("sns_stake_preview_v1", "Preview staking SNS tokens", "Read a staking preview without saving an operation or requesting Wallet funding. Shows the deterministic governance staking account, claimer permissions, funding amount and requested lock. The preview does not claim that a new neuron already exists.", stakingProperties, ["rootCanisterId", "amountAtoms"], readOnly, operationSchema, async (args, context) => {
  const plan = await stakingInput(args, context), staking = await import("./data/staking");
  return { version: 1, operationId: plan.input.operationId, status: "preview", review: await staking.previewStake(plan.input, plan.services), token: plan.entry.token ? { symbol: plan.entry.token.symbol, decimals: plan.entry.token.decimals, feeAtoms: String(plan.entry.token.fee) } : null };
});
register("sns_stake_v1", "Stake SNS tokens", "Fund a deterministic SNS Governance staking account through ICWallet, then claim and configure a Neutron-controlled neuron. Review occurs before funding. Root first returns a depth-zero SNS preparation instruction to bind the real Wallet caller. Continue the saved operation to review and receive exact Wallet instructions; pass raw fundingResults to sns_continue_v1 using this SAME operationId. Transfer success is separate from claim/configuration success.", stakingProperties, ["operationId", "rootCanisterId", "amountAtoms"], reviewed, operationSchema, async (args, context) => {
  if (context.agentMode) return rootPreparation(args, "sns_stake_root_v1", context);
  const plan = await stakingInput(args, context), staking = await import("./data/staking");
  await staking.prepareStake(plan.input, plan.services);
  return resultProjection(await staking.continueStake(plan.input.operationId, { ...(Array.isArray(args.fundingResults) ? { fundingResults: args.fundingResults } : {}) }, plan.services));
});
register("sns_top_up_v1", "Add tokens to an SNS neuron", "Transfer SNS tokens to the selected neuron's existing staking subaccount and refresh its stake. The exact funding ID and receipt are retained. Increasing stake can reduce the age bonus. Root first receives a depth-zero preparation instruction, then continues the same operation for Wallet instructions and original fundingResults.", { operationId: operationIdArg, rootCanisterId: rootArg, neuronId: neuronIdArg, amountAtoms: decimal, fundingResults: { type: "array", items: openObject } }, ["operationId", "rootCanisterId", "neuronId", "amountAtoms"], reviewed, operationSchema, async (args, context) => {
  if (context.agentMode) return rootPreparation(args, "sns_top_up_root_v1", context);
  const plan = await stakingInput(args, context), staking = await import("./data/staking");
  await staking.prepareTopUp({ ...plan.input, neuronId: String(args.neuronId) }, plan.services);
  return resultProjection(await staking.continueStake(plan.input.operationId, { ...(Array.isArray(args.fundingResults) ? { fundingResults: args.fundingResults } : {}) }, plan.services));
});
async function retainedResult(context: MsgBusToolContext, operationId: string, includeRaw = false): Promise<JsonObject> {
  const operation = await createOperationClient(context.kernel).get(operationId);
  if (!operation) throw new SnsError("INVALID_REQUEST", "No saved SNS operation exists with this ID.");
  if (operationObject(operation.input_json).kind === "governance_recovery") return recoveryProjection(operation, includeRaw);
  const result = (await import("./data/neuron_actions")).operationResult(operation);
  return { ...(operationObject(operation.input_json).kind === "vote" ? voteResultProjection(result) : resultProjection(result)), ...operationProjection(operation, includeRaw) };
}
register("sns_operation_status_v1", "Read a saved SNS operation", "Read the original intent, exact review, per-step retained replies and known outcomes without dispatch. Unknown replies remain unresolved; do not create a replacement proposal, split, payout or transfer. includeRaw returns exact saved Candid request/reply bytes as hex for diagnosis.", { operationId: operationIdArg, includeRaw: { type: "boolean", default: false } }, ["operationId"], readOnly, operationSchema, (args, context) => retainedResult(context, String(args.operationId), args.includeRaw === true));
register("sns_continue_v1", "Continue the original SNS operation", "Resume only the saved operationId. Reconciles retained outcomes and executes only still-unattempted steps after exact review. Unknown non-idempotent steps are never replayed. For Root staking, supply the original depth-zero Wallet fundingResults; approval is not funding or neuron completion.", { operationId: operationIdArg, fundingResults: { type: "array", items: openObject } }, ["operationId"], reviewed, operationSchema, async (args, context) => {
  const operationId = String(args.operationId), operation = await createOperationClient(context.kernel).get(operationId);
  if (!operation) throw new SnsError("INVALID_REQUEST", "No original SNS operation was found. Do not reconstruct an unknown financial intent.");
  const input = operationObject(operation.input_json);
  if (input.kind === "governance_recovery" && operation.steps[0]?.status !== "prepared") return recoveryProjection(operation);
  if (input.kind !== "governance_recovery") {
    const known = (await import("./data/neuron_actions")).operationResult(operation);
    const hasUnattemptedVotes = input.kind === "vote" && operation.steps.some(step => step.status === "prepared");
    if (known.status === "completed" || (known.status === "rejected" && !hasUnattemptedVotes)) return input.kind === "vote" ? voteResultProjection(known) : resultProjection(known);
  }
  const entry = await target(operation.sns);
  if (entry.canisters.governance !== operation.governance) throw new Error("The SNS governance differs from this original operation. Its original request was not changed.");
  const service = await services(context, entry, operationObject(operation.review_json).kind === "vote");
  if (input.kind === "governance_recovery") return executeRecovery(operation, service);
  if (input.kind === "stake" || input.kind === "topup") return resultProjection(await (await import("./data/staking")).continueStake(operationId, { ...(Array.isArray(args.fundingResults) ? { fundingResults: args.fundingResults } : {}) }, service));
  const result = await (await import("./data/neuron_actions")).executeNeuronOperation(operationId, service);
  return input.kind === "vote" ? voteResultProjection(result) : resultProjection(result);
});
register("sns_operation_history_v1", "Read SNS operation history", "List durable operation summaries newest first. Per-step replied means a retained IC reply, not necessarily an accepted SNS command: use sns_operation_status_v1 for decoded outcomes. Follow nextCursor; this query never continues or replays an operation.", { cursor: decimal, limit: { type: "integer", minimum: 1, default: 25 } }, [], readOnly, object({ version: { const: 1 }, operations: { type: "array", items: openObject }, nextCursor: { type: ["string", "null"] }, total: decimal }), async (args, context) => {
  const page = await createOperationClient(context.kernel).list({ ...(args.cursor === undefined ? {} : { before: String(args.cursor) }), limit: String(args.limit ?? 25) });
  return { version: 1, operations: page.rows.map(row => ({ operationId: row.operation_id, rootCanisterId: row.sns, governanceCanisterId: row.governance, kind: row.kind ?? "operation", title: row.title ?? "SNS operation", initiator: row.initiator, createdAtSeconds: row.created_at_seconds, updatedAtSeconds: row.updated_at_seconds, steps: (row.steps as JsonObject[]).map(step => ({ stepId: step.step_id, status: step.status })), status: "recorded", outcomeVerified: false })), nextCursor: page.next_before, total: page.total };
});
register("sns_feed_v1", "Read the SNS proposal feed", "Merge proposal pages across selected SNSes or this Neutron's configured SNSes. Reads go directly to governance; nextCursor preserves unread entries from every source. Display failures and avoid claiming complete cross-SNS coverage when a source is unavailable.", { rootCanisterIds: { type: "array", items: rootArg }, limit: { type: "integer", minimum: 1, default: 20 }, cursor: text }, [], readOnly, object({ version: { const: 1 }, proposals: { type: "array", items: openObject }, nextCursor: { type: ["string", "null"] }, complete: { type: "boolean" }, failures: { type: "array", items: openObject } }), async (args, context) => {
  const sns = Array.isArray(args.rootCanisterIds) ? args.rootCanisterIds.map(String) : (await connectionRows(context)).map(row => principal(row.sns));
  const feedModule = await import("./data/feed"), registry = await feedModule.getFeedRegistry();
  const feed = await feedModule.loadProposalFeedPage({ sns, limit: Number(args.limit ?? 20), ...(args.cursor === undefined ? {} : { cursor: String(args.cursor) }) }, async page => {
    const entry = registry.byRoot.get(page.sns);
    if (!entry) throw new Error("SNS is not listed in the SNS registry.");
    return listProposals(entry.canisters.governance, { limit: page.limit, ...(page.beforeProposal === undefined ? {} : { beforeProposal: page.beforeProposal }) });
  });
  return { version: 1, proposals: feed.proposals.map(row => ({ rootCanisterId: row.sns, proposal: row.proposal })), nextCursor: feed.nextCursor ?? null, complete: feed.failures.length === 0, failures: feed.failures };
});

async function rootPreparation(args: JsonObject, method: "sns_stake_root_v1" | "sns_top_up_root_v1", context: MsgBusToolContext): Promise<JsonObject> {
  const existing = await createOperationClient(context.kernel).get(String(args.operationId));
  if (existing) return { ...await retainedResult(context, String(args.operationId)), continuationInstructions: [{ target: "app:snsgov:background", name: "sns_continue_v1", arguments: { operationId: String(args.operationId), ...(Array.isArray(args.fundingResults) ? { fundingResults: args.fundingResults } : {}) } }], message: "This operation is already saved. Continue its original ID as the same root agent; do not prepare replacement funding." };
  const { fundingResults: _funding, ...input } = args;
  return { version: 1, operationId: args.operationId!, status: "root_preparation_required", fundingInstructions: [], rootPreparationInstructions: [{ target: "app:snsgov:background", name: method, arguments: input }], message: "Call this exact SNS preparation instruction at root-agent depth zero. It binds the funding journal to the actual root Wallet caller before returning a payment instruction; no operation or payment was created by this call." };
}
const rootPreparationAnnotations: JsonObject = { "neutron:effects": ["read", "network", "write"], "neutron:audience": "agent_root", "neutron:visibility": "same_app", "neutron:long_running": true };
for (const isTopUp of [false, true]) register(isTopUp ? "sns_top_up_root_v1" : "sns_stake_root_v1", isTopUp ? "Prepare root neuron top-up" : "Prepare root SNS stake", "Root-agent-only preparation. Saves the exact staking intent bound to the authenticated depth-zero caller and returns its same-ID continuation instruction. Continuation reviews token registration and funding before returning the immutable ICWallet request. This method never transfers tokens or dispatches a governance command. Continue the same operation with the original Wallet receipt; do not replace IDs after interruption.", isTopUp ? { operationId: operationIdArg, rootCanisterId: rootArg, neuronId: neuronIdArg, amountAtoms: decimal } : { operationId: operationIdArg, rootCanisterId: rootArg, amountAtoms: decimal, dissolveDelaySeconds: decimal, autoStakeMaturity: { type: "boolean" }, nonce: decimal }, isTopUp ? ["operationId", "rootCanisterId", "neuronId", "amountAtoms"] : ["operationId", "rootCanisterId", "amountAtoms"], rootPreparationAnnotations, operationSchema, async (args, context) => {
  if (context.audience !== "agent_root" || !context.agentMode || !context.caller?.appId) throw new Error("Root staking preparation requires Kernel root-agent attestation.");
  const plan = await stakingInput(args, context), staking = await import("./data/staking");
  const result = isTopUp ? await staking.prepareTopUp({ ...plan.input, neuronId: String(args.neuronId) }, plan.services) : await staking.prepareStake(plan.input, plan.services);
  const state = operationObject(result.operation.state_json), input = operationObject(result.operation.input_json);
  if (state.fundingStatus === "transferred" || result.status === "completed" || result.status === "rejected") return resultProjection(result);
  return { ...resultProjection(result), fundingInstructions: [], continuationInstructions: [{ target: "app:snsgov:background", name: "sns_continue_v1", arguments: { operationId: args.operationId } }], message: "Prepared only. Call sns_continue_v1 as this root agent to review the exact action and receive any required Wallet token-registration instruction, followed by its original funding instruction. No token transfer or governance command was dispatched here." };
});

const governanceMethods = (governanceIdl({ IDL }) as IDL.ServiceClass)._fields;
const queryMethods = governanceMethods.filter(([, method]) => method.annotations.some(annotation => annotation === "query" || annotation === "composite_query"));
const recoveryMethods = ["fail_stuck_upgrade_in_progress", "reset_timers", "get_maturity_modulation"] as const;
register("sns_governance_query_v1", "Read complete SNS governance API", "Discover and invoke the pinned governance's genuine query methods directly from the browser. Omit method to inspect every supported query and its exact argument schema. args is an ordered Candid argument array using natural JSON. No updates, launch operations, or replicated metrics are dispatched.", { rootCanisterId: rootArg, method: { type: "string", enum: queryMethods.map(([name]) => name) }, args: { type: "array", items: {} } }, ["rootCanisterId"], readOnly, { type: "object", required: ["version", "rootCanisterId"], additionalProperties: true, properties: { version: { const: 1 }, rootCanisterId: text, method: text, result: {}, methods: { type: "array", items: openObject } } }, async args => {
  if (args.method === undefined) return { version: 1, rootCanisterId: String(args.rootCanisterId), methods: queryMethods.map(([name, method]) => ({ name, arguments: method.argTypes.map(candidTypeSchema), returns: method.retTypes.map(candidTypeSchema) })) };
  const method = queryMethods.find(([name]) => name === args.method)?.[1];
  if (!method) throw new Error("Choose a genuine governance query method.");
  const entry = await target(args.rootCanisterId);
  const values = candidArgsFromJson(method.argTypes, Array.isArray(args.args) ? args.args : []);
  const actor = await actorFor<Record<string, (...args: unknown[]) => Promise<unknown>>>(governanceIdl, entry.canisters.governance);
  const response = await actor[String(args.method)]!(...values);
  const results = candidArgsToJson(method.retTypes, method.retTypes.length === 1 ? [response] : response as unknown[]);
  return { version: 1, rootCanisterId: entry.canisters.root, method: args.method, result: method.retTypes.length === 1 ? results[0] : results };
});
function recoveryProjection(operation: OperationDetail, includeRaw = false): JsonObject {
  const input = operationObject(operation.input_json), step = operation.steps[0];
  const method = governanceMethods.find(([name]) => name === input.method)?.[1];
  let status = step?.status === "prepared" ? "prepared" : "pending", result: unknown = null, message = "The original governance request has no verified reply; do not create a replacement operation.";
  if (step?.status === "replied" && step.reply && method) {
    try {
      const decoded = candidArgsToJson(method.retTypes, IDL.decode(method.retTypes, step.reply));
      status = "completed"; result = decoded.length === 1 ? decoded[0] : decoded;
      message = "The governance method returned successfully. Read current governance state to inspect its result; this does not prove an interrupted upgrade later completed.";
    } catch (error) { message = `The original reply was retained but could not be decoded: ${String(error)}. It will not be redispatched.`; }
  }
  return { version: 1, ...operationProjection(operation, includeRaw), status, result: operationJson(result), outcomes: [{ stepId: step?.step_id ?? "maintenance", method: String(input.method), status, result: operationJson(result), message }], fundingInstructions: [], message };
}
async function executeRecovery(operation: OperationDetail, service: Awaited<ReturnType<typeof services>>): Promise<JsonObject> {
  const input = operationObject(operation.input_json);
  if (input.principal !== service.principal) throw new Error("This governance operation belongs to another Neutron principal.");
  if (!recoveryMethods.some(method => method === input.method)) throw new Error("This is not a supported saved governance maintenance operation.");
  if (operation.steps[0]?.status !== "prepared") return recoveryProjection(operation);
  await service.authorize(operationObject(operation.review_json));
  service.signal?.throwIfAborted();
  return recoveryProjection(await createOperationClient(service.kernel).dispatch(operation.operation_id, operation.steps[0].step_id));
}
register("sns_governance_recovery_v1", "Governance maintenance", "Run one reviewed public maintenance method through the durable Neutron journal. fail_stuck_upgrade_in_progress asks Governance to resolve an overdue upgrade; reset_timers restarts governance timers; get_maturity_modulation invokes the update used to refresh maturity modulation. These are updates, not queries. A missing reply never authorizes another operation.", { operationId: operationIdArg, rootCanisterId: rootArg, method: { enum: [...recoveryMethods] } }, ["operationId", "rootCanisterId", "method"], reviewed, operationSchema, async (args, context) => {
  const entry = await target(args.rootCanisterId), service = await services(context, entry), client = createOperationClient(context.kernel);
  const methodName = String(args.method), method = governanceMethods.find(([name]) => name === methodName)?.[1];
  if (!method || !recoveryMethods.some(name => name === methodName)) throw new Error("Choose a supported maintenance method.");
  const input = operationJsonText({ version: 1, kind: "governance_recovery", principal: service.principal, method: methodName });
  let operation = await client.get(String(args.operationId));
  if (operation && (operation.input_json !== input || operation.sns !== entry.canisters.root || operation.governance !== entry.canisters.governance)) throw new Error("This operation ID belongs to a different saved governance request.");
  if (!operation) {
    const labels: Record<string, string> = { fail_stuck_upgrade_in_progress: "Check stuck governance upgrade", reset_timers: "Restart governance timers", get_maturity_modulation: "Refresh maturity modulation" };
    const review = { title: labels[methodName], rootCanisterId: entry.canisters.root, governance: entry.canisters.governance, method: methodName, fields: [{ label: "SNS", value: displayName(entry) }, { label: "Action", value: labels[methodName] }], warnings: ["Governance applies its current eligibility and timing rules. A successful request is separate from the eventual state of an upgrade or timer task."] };
    operation = await client.prepare({ operation_id: String(args.operationId), sns: entry.canisters.root, governance: entry.canisters.governance, input_json: input, review_json: operationJsonText(review), state_json: operationJsonText({ version: 1 }), initiator: service.initiator, steps: [{ step_id: "maintenance", method: methodName, args: new Uint8Array(IDL.encode(method.argTypes, [{}])) }] });
  }
  return executeRecovery(operation, service);
});

const voteProperties = { rootCanisterId: rootArg, proposalId: decimal, adopt: { type: "boolean" }, neuronIds: { type: "array", items: neuronIdArg, description: "Exact subset. Omit to use all currently eligible Neutron-permissioned ballots; already-cast ballots are reported separately." }, operationId: operationIdArg };
async function votePlan(args: JsonObject, context: MsgBusToolContext) {
  const entry = await target(args.rootCanisterId), hotkey = await readHotkey(context.kernel);
  const row = (await connectionRows(context)).find(row => principal(row.sns) === entry.canisters.root);
  const plan = await (await import("./data/voting")).buildVotePlan({ rootCanisterId: entry.canisters.root, governanceCanisterId: entry.canisters.governance, proposalId: BigInt(String(args.proposalId)), votingPrincipal: hotkey.principal, canSign: hotkey.canManageNeuron, votingEnabled: Boolean(row?.voting_enabled), agentVotingEnabled: Boolean(row?.agent_voting_enabled), ...(args.adopt === undefined ? {} : { adopt: args.adopt === true }), ...(Array.isArray(args.neuronIds) ? { neuronIds: args.neuronIds.map(String) } : {}) });
  return { entry, plan };
}
register("sns_vote_plan", "Preview eligible SNS votes", "Read the current proposal deadline and actual ballots/permissions. Already-voted neurons include their actual direction and whether it matches the requested vote. Omit neuronIds for all eligible ballots or supply an exact subset. Preferences are informational; a reviewed action can enable SNS access without changing unattended agent-voting preferences.", voteProperties, ["rootCanisterId", "proposalId"], readOnly, { type: "object", required: ["rootCanisterId", "proposalId", "eligibleNeuronIds", "discoveryComplete"], additionalProperties: true, properties: { rootCanisterId: text, proposalId: decimal, eligibleNeuronIds: { type: "array", items: neuronIdArg }, discoveryComplete: { type: "boolean" } } }, async (args, context) => (await votePlan(args, context)).plan);
register("sns_vote", "Vote on an SNS proposal", "Cast Yes/No with all currently eligible ballots or an explicit neuron subset. The exact batch is saved before dispatch, and individual replies remain recoverable after interruption. Root uses exact scoped approval; owner-tile Yes/No is a direct vote. Already-cast opposite votes are never counted as success. Supply operationId and reuse it after interruption; omitted operationId is legacy compatibility and the generated ID is returned.", voteProperties, ["rootCanisterId", "proposalId", "adopt"], reviewed, operationSchema, async (args, context) => {
  const operationId = String(args.operationId ?? newOperationId()), client = createOperationClient(context.kernel);
  const existing = await client.get(operationId), requested = operationJsonText({ rootCanisterId: String(args.rootCanisterId), proposalId: String(args.proposalId), adopt: args.adopt === true, neuronIds: Array.isArray(args.neuronIds) ? args.neuronIds.map(String).map(id => id.toLowerCase()).sort() : null });
  if (existing) {
    const saved = operationObject(existing.input_json);
    if (saved.kind !== "vote" || saved.requested !== requested) throw new Error("This operation ID belongs to another saved vote. Use sns_operation_status_v1 to inspect its original intent.");
    const service = await services(context, await target(existing.sns), true);
    return voteResultProjection(await (await import("./data/neuron_actions")).executeNeuronOperation(operationId, service));
  }
  const { entry, plan } = await votePlan(args, context);
  if (!plan.discoveryComplete && args.neuronIds === undefined) throw new SnsError("INVALID_REQUEST", "Could not discover all eligible neurons. Retry the failed reads before an all-neuron vote, or explicitly review a known neuron subset.");
  if (!plan.eligibleNeuronIds.length) return { version: 1, operationId, status: "not_required", requested: plan.eligibleNeuronIds.length, succeeded: 0, alreadyVoted: plan.alreadyVoted, failed: [], outcomes: [], fundingInstructions: [], plan, message: plan.acceptsVotes ? "No uncast eligible ballot remains. Existing votes are shown separately, with their actual direction; no operation was saved or vote dispatched." : "The proposal no longer accepts votes. No operation was saved or vote dispatched." };
  const service = await services(context, entry, true), { encodeRegisterVote } = await import("./data/manage_neuron");
  const review = { kind: "vote", title: `Vote ${args.adopt ? "Yes" : "No"} · ${displayName(entry)}`, rootCanisterId: entry.canisters.root, governance: entry.canisters.governance, proposalId: plan.proposalId, adopt: args.adopt === true, neuronIds: plan.eligibleNeuronIds, proposalTitle: plan.proposalTitle,
    fields: [{ label: "Proposal", value: `#${plan.proposalId} · ${plan.proposalTitle}` }, { label: "Vote", value: args.adopt ? "Yes" : "No" }, { label: "Eligible neurons", value: String(plan.eligibleNeuronIds.length) }],
    warnings: plan.discoveryComplete ? [] : ["Only the explicitly selected neurons were reviewed; discovery of other neurons is incomplete."], alreadyVoted: plan.alreadyVoted };
  await client.prepare({ operation_id: operationId, sns: entry.canisters.root, governance: entry.canisters.governance, input_json: operationJsonText({ version: 1, kind: "vote", principal: service.principal, requested }), review_json: operationJsonText(review), state_json: operationJsonText({ version: 1, completedSteps: [] }), initiator: service.initiator, steps: plan.eligibleNeuronIds.map(id => ({ step_id: `vote_${id}`, args: encodeRegisterVote(id, BigInt(plan.proposalId), args.adopt === true) })) });
  return voteResultProjection(await (await import("./data/neuron_actions")).executeNeuronOperation(operationId, service));
});
function voteResultProjection(value: import("./data/neuron_actions").NeuronOperationResult): JsonObject {
  const projected = resultProjection(value), review = operationObject(value.operation.review_json);
  const outcomes = value.operation.steps.map(step => {
    const result = value.outcomes.find(outcome => outcome.stepId === step.step_id), neuronId = step.step_id.replace(/^vote_/, "");
    return { neuronId, stepId: step.step_id, status: result?.reconciled ? "reconciled" : result?.outcome?.ok ? "succeeded" : step.status === "prepared" ? "unattempted" : result?.outcome?.errorType !== undefined ? "rejected" : "unknown", ...(result ?? {}) };
  });
  return { ...projected, requested: outcomes.length, succeeded: outcomes.filter(outcome => outcome.status === "succeeded" || outcome.status === "reconciled").length, alreadyVoted: review.alreadyVoted ?? [], failed: operationJson(outcomes.filter(outcome => outcome.status === "rejected")), outcomes: operationJson(outcomes), unknownNeuronIds: outcomes.filter(outcome => outcome.status === "unknown").map(outcome => outcome.neuronId), unattemptedNeuronIds: outcomes.filter(outcome => outcome.status === "unattempted").map(outcome => outcome.neuronId) };
}
