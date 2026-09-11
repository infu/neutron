/** Shared, permission-aware neuron plans for the UI and resident tools. */
import { Principal } from "@dfinity/principal";
import type { JsonObject, ScopedKernelClient } from "neutron-tools/app";
import { encodeIcrcAccount, decodeIcrcAccount } from "neutron-tools/src/icrc_account.js";
import type { Account, Command } from "../candid/sns_governance.did";
import type { NeuronSummary, SnsParameters, ProposalDetail } from "./types";
import { getNeuron, getProposal, readMode, readParameters } from "./governance";
import { encodeManageNeuron, decodeManageNeuronRequest, decodeManageNeuronResponse, type ManageNeuronOutcome } from "./manage_neuron";
import { fromHex, toHex, formatDuration, formatTokenAmount } from "./format";
import { commandEvidence, compactReviewText, compactReviewValue, createOperationClient, mergeOperationState, operationJson, operationJsonText, operationObject, type OperationDetail, type OperationStep } from "./operations";

export const NEURON_PERMISSIONS = [
  "Unspecified", "Configure dissolve state", "Manage principals", "Submit proposals", "Vote and follow", "Disburse stake",
  "Split stake", "Merge maturity", "Disburse maturity", "Stake maturity", "Manage voting access",
] as const;
export const NEURON_COMMANDS = [
  { kind: "Configure", permission: 1, title: "Configure neuron" },
  { kind: "Disburse", permission: 5, title: "Disburse stake" },
  { kind: "Split", permission: 6, title: "Split neuron" },
  { kind: "MergeMaturity", permission: 7, title: "Merge maturity into stake" },
  { kind: "StakeMaturity", permission: 9, title: "Stake maturity" },
  { kind: "DisburseMaturity", permission: 8, title: "Disburse maturity" },
  { kind: "Follow", permission: 4, title: "Change function following" },
  { kind: "SetFollowing", permission: 4, title: "Change topic following" },
  { kind: "RegisterVote", permission: 4, title: "Vote on proposal" },
  { kind: "MakeProposal", permission: 3, title: "Submit proposal" },
  { kind: "AddNeuronPermissions", permission: 2, title: "Share neuron access" },
  { kind: "RemoveNeuronPermissions", permission: 2, title: "Remove neuron access" },
  { kind: "ClaimOrRefresh", permission: null, title: "Claim or refresh neuron" },
] as const;
export type NeuronCommandKind = typeof NEURON_COMMANDS[number]["kind"];
export interface NeuronActionSnapshot {
  neuron?: NeuronSummary | undefined;
  parameters: SnsParameters;
  mode?: number | undefined;
  proposal?: ProposalDetail | undefined;
  nowSeconds: bigint;
}
export interface NeuronActionServices {
  kernel: ScopedKernelClient;
  principal: string;
  initiator?: string;
  /** Installed by the provider, never derived from a tool's input flags. */
  authorize: (review: JsonObject) => Promise<void>;
  reads?: { snapshot(governance: string, neuronId: string, command: Command): Promise<NeuronActionSnapshot>; balance?(ledger:string,governance:string,neuronId:string):Promise<bigint> };
  /** Trusted invocation identity used by ICWallet, not an authorization claim. */
  funding?: { root: boolean; callerAppId: string };
  signal?: AbortSignal;
  token?: { symbol:string; decimals:number };
}
export interface NeuronActionInput {
  operationId: string;
  sns: string;
  governance: string;
  neuronId: string;
  command: Command;
}
export interface NeuronOperationResult {
  operationId: string;
  status: "prepared" | "completed" | "pending" | "rejected";
  review: JsonObject;
  operation: OperationDetail;
  outcomes: { stepId: string; outcome?: ManageNeuronOutcome; reconciled?: boolean; message?: string }[];
  fundingInstructions: JsonObject[];
  message?: string;
}

export function neuronPermissions(neuron: NeuronSummary | undefined, principal: string): number[] {
  return [...new Set(neuron?.permissions.filter(p => p.principal === principal).flatMap(p => p.permissions) ?? [])].sort((a,b) => a-b);
}
export function neuronCapabilities(neuron: NeuronSummary, principal: string, parameters: SnsParameters = {}) {
  const permissions = neuronPermissions(neuron, principal);
  const has = (permission: number) => permissions.includes(permission);
  const fullControl = Array.from({ length: 10 }, (_,i) => i+1).every(has);
  return {
    permissions, label: fullControl ? "Full control" : permissions.length > 0 && permissions.every(p => [3,4,10].includes(p)) ? "Voting access" : "Custom access",
    fullControl, canVote: has(4), canPropose: has(3), canConfigure: has(1), canDisburse: has(5), canSplit: has(6),
    canMergeMaturity: has(7), canDisburseMaturity: has(8), canStakeMaturity: has(9), canManagePrincipals: has(2), canManageVotingAccess: has(2) || has(10),
    grantablePermissions: (parameters.neuronGrantablePermissions ?? []).filter(p => has(2) || (has(10) && [3,4,10].includes(p))),
  };
}
export function neuronCommandKind(command: Command): NeuronCommandKind {
  const keys = Object.keys(command);
  if (keys.length !== 1 || !NEURON_COMMANDS.some(c => c.kind === keys[0])) throw new Error("Choose one supported SNS neuron command");
  return keys[0] as NeuronCommandKind;
}
export function normalizedNeuronId(value: string): string {
  const bytes = fromHex(value);
  if (bytes.length !== 32) throw new Error("SNS neuron ID must contain exactly 32 bytes");
  return toHex(bytes);
}
export function dissolveDelay(neuron: NeuronSummary, now: bigint): bigint {
  const state = neuron.dissolveState;
  return !state ? 0n : state.kind === "delay" ? state.value : state.value > now ? state.value - now : 0n;
}
export async function readActionSnapshot(governance: string, neuronId: string, command: Command, services: NeuronActionServices): Promise<NeuronActionSnapshot> {
  if (services.reads) return services.reads.snapshot(governance, neuronId, command);
  const [neuron, parameters, mode, proposal] = await Promise.all([
    getNeuron(governance, neuronId), readParameters(governance), readMode(governance),
    "RegisterVote" in command && command.RegisterVote.proposal[0] ? getProposal(governance, command.RegisterVote.proposal[0].id) : Promise.resolve(undefined),
  ]);
  return { neuron, parameters, mode, proposal, nowSeconds: BigInt(Math.floor(Date.now()/1000)) };
}

/** Validates existing SNS rules only. The canister remains authoritative. */
export function validateNeuronCommand(command: Command, snapshot: NeuronActionSnapshot, principal: string): void {
  const kind = neuronCommandKind(command), { neuron, parameters: p, nowSeconds: now } = snapshot;
  if (snapshot.mode === 2 && !["Follow", "MakeProposal", "RegisterVote", "AddNeuronPermissions", "RemoveNeuronPermissions"].includes(kind)) throw new Error("The SNS does not allow this command before its launch swap is initialized");
  if (kind === "ClaimOrRefresh") {
    if (neuron && isNeuronsFundControlled(neuron)) throw new Error("SNS neurons controlled by the Neurons’ Fund cannot be refreshed");
    return;
  }
  if (!neuron) throw new Error("SNS neuron was not found");
  const held = neuronPermissions(neuron, principal), permission = NEURON_COMMANDS.find(c => c.kind === kind)!.permission;
  const changing = "AddNeuronPermissions" in command ? command.AddNeuronPermissions.permissions_to_add[0]?.permissions
    : "RemoveNeuronPermissions" in command ? command.RemoveNeuronPermissions.permissions_to_remove[0]?.permissions : undefined;
  if (changing !== undefined) {
    if (!held.includes(2) && !(held.includes(10) && Array.from(changing).every(v => [3,4,10].includes(v)))) throw new Error("This Neutron lacks permission to change the requested neuron access");
  } else if (permission !== null && !held.includes(permission)) throw new Error(`This Neutron lacks permission: ${NEURON_PERMISSIONS[permission]}`);
  const config = "Configure" in command ? command.Configure.operation[0] : undefined;
  const vesting = neuron.vestingPeriodSeconds !== undefined && neuron.createdAtSeconds + neuron.vestingPeriodSeconds >= now;
  if (vesting && (["Split","Disburse"].includes(kind) || (config && !("ChangeAutoStakeMaturity" in config)))) throw new Error("This neuron is still vesting and the SNS does not allow this action yet");
  const delay = dissolveDelay(neuron, now);
  if (config) {
    if ("IncreaseDissolveDelay" in config && config.IncreaseDissolveDelay.additional_dissolve_delay_seconds <= 0) throw new Error("Additional dissolve delay must be positive");
    if ("SetDissolveTimestamp" in config && config.SetDissolveTimestamp.dissolve_timestamp_seconds < now + delay) throw new Error("A dissolve delay cannot be reduced");
    if ("StartDissolving" in config && !(neuron.dissolveState?.kind === "delay" && delay > 0n)) throw new Error("This neuron must be locked before starting dissolution");
    if ("StopDissolving" in config && !(neuron.dissolveState?.kind === "dissolving" && delay > 0n)) throw new Error("This neuron is not currently dissolving");
  }
  const stake = neuron.effectiveStakeE8s ?? (neuron.stakeE8s > (neuron.feesE8s ?? 0n) ? neuron.stakeE8s-(neuron.feesE8s ?? 0n) : 0n);
  if ("Disburse" in command && delay > 0n) throw new Error("The neuron must be dissolved before its stake can be disbursed");
  if ("Split" in command) {
    const amount = command.Split.amount_e8s;
    if (p.neuronMinimumStakeE8s !== undefined && p.transactionFeeE8s !== undefined && amount < p.neuronMinimumStakeE8s + p.transactionFeeE8s) throw new Error("The child neuron needs the minimum stake plus its transfer fee");
    if (p.neuronMinimumStakeE8s !== undefined && stake < p.neuronMinimumStakeE8s + amount) throw new Error("Splitting would leave the parent below the SNS minimum stake");
  }
  const percent = "MergeMaturity" in command ? command.MergeMaturity.percentage_to_merge : "DisburseMaturity" in command ? command.DisburseMaturity.percentage_to_disburse : "StakeMaturity" in command ? command.StakeMaturity.percentage_to_stake[0] ?? 100 : undefined;
  if (percent !== undefined && (!Number.isInteger(percent) || percent < 1 || percent > 100)) throw new Error("Maturity percentage must be between 1 and 100");
  if (percent !== undefined && p.transactionFeeE8s !== undefined) {
    const amount = neuron.maturityE8s * BigInt(percent) / 100n;
    if (kind === "MergeMaturity" && amount <= p.transactionFeeE8s) throw new Error("Maturity to merge must exceed the SNS transaction fee threshold");
    if (kind === "DisburseMaturity" && amount * 9500n / 10000n < p.transactionFeeE8s) throw new Error("Maturity payout after worst-case modulation must reach the SNS transaction fee threshold");
  }
  if ("MakeProposal" in command) {
    if (p.neuronMinimumDissolveDelayToVoteSeconds !== undefined && delay < p.neuronMinimumDissolveDelayToVoteSeconds) throw new Error("The proposer’s dissolve delay is below the SNS voting minimum");
    if (p.rejectCostE8s !== undefined && stake < p.rejectCostE8s) throw new Error("The neuron does not have enough effective stake for the proposal rejection cost");
  }
  if ("RegisterVote" in command) {
    if (![1,2].includes(command.RegisterVote.vote)) throw new Error("Vote must be Yes or No");
    if (snapshot.proposal) {
      const ballot = snapshot.proposal.ballots.find(b => b.neuronId === neuron.id);
      if (!ballot) throw new Error("This neuron did not have a ballot when this proposal was created");
      if (ballot.vote !== 0) throw new Error(ballot.vote === command.RegisterVote.vote ? "This neuron has already cast the requested vote" : "This neuron has already cast a different vote");
      if (snapshot.proposal.deadlineSeconds !== undefined && now > snapshot.proposal.deadlineSeconds) throw new Error("The SNS voting deadline has passed");
    }
  }
  if ("Follow" in command && p.maxFolloweesPerFunction !== undefined && BigInt(command.Follow.followees.length) > p.maxFolloweesPerFunction) throw new Error("Following exceeds this SNS’s maximum followees per function");
  if ("AddNeuronPermissions" in command) {
    const add = command.AddNeuronPermissions, target = add.principal_id[0]?.toText();
    if (!target || !add.permissions_to_add[0]) throw new Error("A principal and permissions to add are required");
    if (p.neuronGrantablePermissions && Array.from(add.permissions_to_add[0].permissions).some(v => !p.neuronGrantablePermissions!.includes(v))) throw new Error("This SNS does not allow one or more requested permissions to be granted");
    if (!neuron.permissions.some(v => v.principal === target) && p.maxNumberOfPrincipalsPerNeuron !== undefined && BigInt(neuron.permissions.length) >= p.maxNumberOfPrincipalsPerNeuron) throw new Error("The neuron has reached this SNS’s maximum number of principals");
  }
  if ("RemoveNeuronPermissions" in command) {
    const remove = command.RemoveNeuronPermissions, target = remove.principal_id[0]?.toText();
    if (!target || !remove.permissions_to_remove[0]) throw new Error("A principal and permissions to remove are required");
    const existing = neuronPermissions(neuron,target);
    if (Array.from(remove.permissions_to_remove[0].permissions).some(v => !existing.includes(v))) throw new Error("The selected principal no longer has every permission requested for removal");
  }
}

export function neuronActionReview(input: NeuronActionInput, snapshot: NeuronActionSnapshot, principal: string, token?:NeuronActionServices["token"]): JsonObject {
  const command=input.command,kind=neuronCommandKind(command),warnings:string[]=[],fields:{label:string;value:string}[]=[];
  const add=(label:string,value:string)=>fields.push({label,value:compactReviewText(value)});
  const amount=(value:bigint)=>displayTokenAmount(value,token);
  const destination=(value:Account|undefined)=>!value?principal:encodeIcrcAccount({owner:decodeIcrcAccount(value.owner[0]?.toText()??principal).owner,...(value.subaccount[0]?{subaccount:value.subaccount[0].subaccount}:{})});
  let title:string=NEURON_COMMANDS.find(c=>c.kind===kind)!.title;
  if("Configure" in command){const c=command.Configure.operation[0];if(c){
    if("IncreaseDissolveDelay" in c){title="Increase dissolve delay";add("Additional lock duration",formatDuration(c.IncreaseDissolveDelay.additional_dissolve_delay_seconds));add("Resulting dissolve delay",formatDuration(dissolveDelay(snapshot.neuron!,snapshot.nowSeconds)+BigInt(c.IncreaseDissolveDelay.additional_dissolve_delay_seconds)));}
    if("SetDissolveTimestamp" in c){title="Set dissolve timestamp";add("Requested timestamp",`${c.SetDissolveTimestamp.dissolve_timestamp_seconds} seconds since Unix epoch`);add("Remaining lock duration",formatDuration(c.SetDissolveTimestamp.dissolve_timestamp_seconds-snapshot.nowSeconds));}
    if("StartDissolving" in c){title="Start dissolving";add("Time until stake is available",formatDuration(dissolveDelay(snapshot.neuron!,snapshot.nowSeconds)));warnings.push("Starting dissolution resets the neuron’s age bonus to zero.");}
    if("StopDissolving" in c){title="Stop dissolving";add("Lock duration after stopping",formatDuration(dissolveDelay(snapshot.neuron!,snapshot.nowSeconds)));add("Age bonus","Age begins accumulating again from zero.");}
    if("ChangeAutoStakeMaturity" in c)add("Automatically stake future rewards",c.ChangeAutoStakeMaturity.requested_setting_for_auto_stake_maturity?"On":"Off");
  }}
  if("Disburse" in command){add("Stake to disburse",command.Disburse.amount[0]?amount(command.Disburse.amount[0].e8s):"All available token stake");add("Recipient",destination(command.Disburse.to_account[0]));add("SNS transfer fee",snapshot.parameters.transactionFeeE8s===undefined?"Read by SNS at execution":amount(snapshot.parameters.transactionFeeE8s));add("Proposal fees",snapshot.neuron?.feesE8s?amount(snapshot.neuron.feesE8s):"None recorded");}
  if("Split" in command){add("Stake taken from parent",amount(command.Split.amount_e8s));add("Child stake",snapshot.parameters.transactionFeeE8s===undefined?"Requested stake less the SNS transfer fee":amount(command.Split.amount_e8s-snapshot.parameters.transactionFeeE8s));add("Child nonce",command.Split.memo.toString());add("Inherited settings","Permissions, dissolve state, age and following");}
  if("StakeMaturity" in command)add("Existing maturity to stake",`${command.StakeMaturity.percentage_to_stake[0]??100}%`);
  if("MergeMaturity" in command)add("Maturity to mint into token stake",`${command.MergeMaturity.percentage_to_merge}%`);
  if("DisburseMaturity" in command){add("Maturity to disburse",`${command.DisburseMaturity.percentage_to_disburse}%`);add("Recipient",destination(command.DisburseMaturity.to_account[0]));add("Payout timing","Normally at least seven days, then SNS processing");warnings.push("The SNS deducts maturity now and applies maturity modulation when it mints the payout.");}
  if("Follow" in command){add("Proposal function",command.Follow.function_id.toString());add("Followee neurons",command.Follow.followees.map(n=>toHex(n.id)).join(", ")||"Clear following for this function");}
  if("SetFollowing" in command){for(const topic of command.SetFollowing.topic_following)add(`Topic ${topic.topic[0]??"unspecified"}`,topic.followees.map(f=>`${f.alias[0]?`${f.alias[0]}: `:""}${f.neuron_id[0]?toHex(f.neuron_id[0].id):"missing neuron"}`).join(", ")||"Clear following");add("Related settings","Overlapping legacy following is removed by the SNS.");}
  if("RegisterVote" in command){add("Vote",command.RegisterVote.vote===1?"Yes":"No");add("Proposal",command.RegisterVote.proposal[0]?.id.toString()??"Missing proposal");}
  if("MakeProposal" in command){add("Proposal title",command.MakeProposal.title);add("Proposal action",Object.keys(command.MakeProposal.action[0]??{})[0]??"Missing action");add("Rejection cost",snapshot.parameters.rejectCostE8s===undefined?"SNS configured cost":amount(snapshot.parameters.rejectCostE8s));add("Proposer vote","Yes is cast automatically");}
  if("AddNeuronPermissions" in command){add("Principal receiving access",command.AddNeuronPermissions.principal_id[0]?.toText()??"Missing principal");add("Permissions to add",Array.from(command.AddNeuronPermissions.permissions_to_add[0]?.permissions??[]).map(p=>NEURON_PERMISSIONS[p]??String(p)).join(", ")||"Empty permission set");}
  if("RemoveNeuronPermissions" in command){add("Principal losing access",command.RemoveNeuronPermissions.principal_id[0]?.toText()??"Missing principal");add("Permissions to remove",Array.from(command.RemoveNeuronPermissions.permissions_to_remove[0]?.permissions??[]).map(p=>NEURON_PERMISSIONS[p]??String(p)).join(", ")||"Empty permission set");warnings.push("Removing the last management permission can leave a neuron inaccessible.");}
  add("Neuron",input.neuronId);
  const args=normalizeInput(input);
  // Decode against Candid so vec nat8 is recognized even when a caller used
  // number[]; permission and other numeric vectors remain semantic arrays.
  let commandReview=compactReviewValue(decodeManageNeuronRequest(args).command[0]);
  const rendered=operationJsonText(commandReview);
  if(new TextEncoder().encode(rendered).length>8192)commandReview={kind,...commandEvidence(args),preview:compactReviewText(rendered)};
  return operationJson({title,rootCanisterId:input.sns,governance:input.governance,neuronId:input.neuronId,principal,fields,warnings,command:commandReview,commandEvidence:commandEvidence(args),rawCommand:{operationId:input.operationId,source:"Retained journal step arguments; operation status with includeRaw"}}) as JsonObject;
}
export function displayTokenAmount(value:bigint,token?:NeuronActionServices["token"]):string{
  return token&&token.decimals<=38?`${formatTokenAmount(value,token.decimals)} ${token.symbol}`:`${value} atomic tokens`;
}

export async function previewNeuronAction(input: NeuronActionInput, services: NeuronActionServices): Promise<JsonObject> {
  normalizeInput(input); // Validate Candid before any journal mutation.
  const snapshot = await readActionSnapshot(input.governance,input.neuronId,input.command,services);
  validateNeuronCommand(input.command,snapshot,services.principal);
  return neuronActionReview(input,snapshot,services.principal,services.token);
}
function normalizeInput(input: NeuronActionInput): Uint8Array {
  if (!input.operationId) throw new Error("An operation ID is required for safe recovery");
  Principal.fromText(input.sns); Principal.fromText(input.governance);
  return encodeManageNeuron({subaccount:fromHex(normalizedNeuronId(input.neuronId)),command:[input.command]});
}
export async function prepareNeuronAction(input: NeuronActionInput, services: NeuronActionServices): Promise<NeuronOperationResult> {
  const args = normalizeInput(input), client = createOperationClient(services.kernel);
  const retainedInput = operationJsonText({version:1,kind:"manage",principal:services.principal,neuronId:input.neuronId,args:commandEvidence(args)});
  const existing = await client.get(input.operationId);
  if (existing) {
    if (existing.input_json !== retainedInput || existing.sns !== input.sns || existing.governance !== input.governance) throw new Error("This operation ID is already bound to another SNS action");
    return operationResult(existing);
  }
  const review = await previewNeuronAction(input,services);
  return operationResult(await client.prepare({operation_id:input.operationId,sns:input.sns,governance:input.governance,input_json:retainedInput,review_json:operationJsonText(review),initiator:services.initiator??"user",state_json:operationJsonText({version:1,completedSteps:[]}),steps:[{step_id:"command",args}]}));
}

export function operationResult(operation: OperationDetail): NeuronOperationResult {
  const state = operationObject(operation.state_json), completed = new Set(Array.isArray(state.completedSteps) ? state.completedSteps : []);
  const outcomes: NeuronOperationResult["outcomes"] = [];
  let pending = false, rejected = false;
  for (const step of operation.steps) {
    if (completed.has(step.step_id)) { outcomes.push({stepId:step.step_id,reconciled:true}); continue; }
    if (step.status === "replied" && step.reply) {
      try {
        const outcome = decodeManageNeuronResponse(step.reply);
        outcomes.push({stepId:step.step_id,outcome});
        if (!outcome.ok) { if (outcome.errorType !== undefined) rejected = true; else pending = true; }
        else if (!responseMatches(step,outcome)) pending = true;
      } catch (error) { pending = true; outcomes.push({stepId:step.step_id,message:String(error)}); }
    } else if (step.status !== "prepared") { pending = true; outcomes.push({stepId:step.step_id,message:step.error??"The SNS outcome is not yet known"}); }
  }
  const allDone = operation.steps.every(step=>completed.has(step.step_id) || (step.status === "replied" && outcomes.some(o=>o.stepId===step.step_id&&o.outcome?.ok&&responseMatches(step,o.outcome))));
  const funding=state.fundingStatus;
  const status:NeuronOperationResult["status"]=funding==="rejected"||rejected?"rejected":funding==="requested"||funding==="pending"||pending?"pending":allDone?"completed":"prepared";
  return {operationId:operation.operation_id,status,review:operationObject(operation.review_json,"operation review"),operation,outcomes,fundingInstructions:[]};
}
function responseMatches(step: OperationStep, outcome: ManageNeuronOutcome): boolean {
  const command = decodeManageNeuronRequest(step.args).command[0];
  if (!command) return false;
  const kind = neuronCommandKind(command);
  if(outcome.command !== (kind === "AddNeuronPermissions" ? "AddNeuronPermission" : kind === "RemoveNeuronPermissions" ? "RemoveNeuronPermission" : kind))return false;
  if(kind==="ClaimOrRefresh")return outcome.neuronId===toHex(decodeManageNeuronRequest(step.args).subaccount);
  if(kind==="Split")return outcome.neuronId!==undefined;
  if(kind==="MakeProposal")return outcome.proposalId!==undefined;
  if(kind==="Disburse")return outcome.transferBlockHeight!==undefined;
  return true;
}

/** Observe deterministic postconditions without attributing ambiguous payments. */
export function commandPostcondition(command: Command, snapshot: NeuronActionSnapshot, principal: string): boolean {
  const neuron = snapshot.neuron;
  if (!neuron) return false;
  if ("ClaimOrRefresh" in command) return false; // Creation and ledger refresh need workflow-specific evidence.
  if ("RegisterVote" in command) return [1,2].includes(command.RegisterVote.vote) && (snapshot.proposal?.ballots.some(b=>b.neuronId===neuron.id&&b.vote===command.RegisterVote.vote)??false);
  if ("AddNeuronPermissions" in command) { const target=command.AddNeuronPermissions.principal_id[0]?.toText(); return !!target && !!command.AddNeuronPermissions.permissions_to_add[0] && neuron.permissions.some(p=>p.principal===target) && Array.from(command.AddNeuronPermissions.permissions_to_add[0].permissions).every(p=>neuronPermissions(neuron,target).includes(p)); }
  if ("RemoveNeuronPermissions" in command) { const target=command.RemoveNeuronPermissions.principal_id[0]?.toText(); return !!target && !!command.RemoveNeuronPermissions.permissions_to_remove[0] && command.RemoveNeuronPermissions.permissions_to_remove[0].permissions.length > 0 && Array.from(command.RemoveNeuronPermissions.permissions_to_remove[0].permissions).every(p=>!neuronPermissions(neuron,target).includes(p)); }
  if ("Configure" in command) {
    const config=command.Configure.operation[0]; if (!config) return false;
    if ("ChangeAutoStakeMaturity" in config) return !!neuron.autoStakeMaturity===config.ChangeAutoStakeMaturity.requested_setting_for_auto_stake_maturity;
    if ("StartDissolving" in config) return neuron.dissolveState?.kind==="dissolving" && neuron.dissolveState.value > snapshot.nowSeconds;
    if ("StopDissolving" in config) return neuron.dissolveState?.kind==="delay"&&neuron.dissolveState.value>0n;
    if ("SetDissolveTimestamp" in config) return neuron.dissolveState?.kind==="dissolving"&&neuron.dissolveState.value>=config.SetDissolveTimestamp.dissolve_timestamp_seconds;
  }
  if ("Follow" in command) { const current=neuron.followees?.find(f=>f.functionId===command.Follow.function_id)?.neuronIds??[];return sameSet(current,command.Follow.followees.map(n=>toHex(n.id))); }
  return false;
}
const sameSet=(a:string[],b:string[])=>a.length===b.length&&[...a].sort().every((v,i)=>v===[...b].sort()[i]);

export async function executeNeuronOperation(operationId: string, services: NeuronActionServices): Promise<NeuronOperationResult> {
  const client=createOperationClient(services.kernel);
  let operation=await client.get(operationId); if (!operation) throw new Error("SNS operation was not found");
  const input=operationObject(operation.input_json,"operation input");
  if (input.principal!==services.principal) throw new Error("This operation belongs to another Neutron principal");
  // Votes are independent effects. A rejected or unresolved vote must retain
  // its own evidence while the other reviewed neurons can still cast theirs.
  const independentVotes=input.kind==="vote"&&operation.steps.every(step=>{
    try { const command=decodeManageNeuronRequest(step.args).command[0];return !!command&&"RegisterVote" in command; }
    catch { return false; }
  });
  const known=operationResult(operation);if(known.status==="completed"||known.status==="rejected"&&!independentVotes)return known;
  if(independentVotes){
    const state=operationObject(operation.state_json),completed=Array.isArray(state.completedSteps)?state.completedSteps:[];
    if(operation.steps.every(step=>completed.includes(step.step_id)||step.status==="replied"))return known;
  }
  // A stored undecodable or mismatched reply cannot be repaired by another
  // execution; preserve its pending evidence without asking for new consent.
  if(!independentVotes&&operation.steps.some(step=>step.status==="replied"&&!known.outcomes.some(o=>o.stepId===step.step_id&&(o.reconciled||o.outcome?.ok&&responseMatches(step,o.outcome)))))return known;
  if ((input.kind==="stake" || input.kind==="topup") && operationObject(operation.state_json).fundingStatus!=="transferred") throw new Error("Continue the retained Wallet funding step before claiming or configuring this neuron");
  await services.authorize(operationObject(operation.review_json,"operation review"));
  for (const original of operation.steps) {
    services.signal?.throwIfAborted();
    const state=operationObject(operation.state_json), completed=Array.isArray(state.completedSteps)?state.completedSteps:[];
    if (completed.includes(original.step_id)) continue;
    const step=operation.steps.find(s=>s.step_id===original.step_id)!;
    const request=decodeManageNeuronRequest(step.args),command=request.command[0];
    if (!command) throw new Error("Saved SNS step has no command");
    const neuronId=toHex(request.subaccount);
    if (step.status==="replied"&&step.reply) {
      try{const outcome=decodeManageNeuronResponse(step.reply);if(outcome.ok&&responseMatches(step,outcome))continue;}catch{/* Retain the exact undecodable response. */}
      if(independentVotes)continue;
      return operationResult(operation);
    }
    if(independentVotes&&step.status==="replied")continue;
    let snapshot:NeuronActionSnapshot;
    try { snapshot=await readActionSnapshot(operation.governance,neuronId,command,services); }
    catch(error){
      // A failed reconciliation read cannot authorize a retry of this vote,
      // and need not prevent a different, still-prepared vote from proceeding.
      if(independentVotes&&step.status!=="prepared")continue;
      throw error;
    }
    if (commandPostcondition(command,snapshot,services.principal)) {
      operation=await mergeOperationState(client,operation,current=>({...current,completedSteps:[...new Set([...(Array.isArray(current.completedSteps)?current.completedSteps:[]),step.step_id])]})); continue;
    }
    if (step.status!=="prepared") {if(independentVotes)continue;return operationResult(operation);}
    if(input.kind==="transfer_control" && step.step_id==="remove_previous_control") {
      const grant=decodeManageNeuronRequest(operation.steps[0]!.args).command[0];
      if(!grant || !commandPostcondition(grant,snapshot,services.principal)) return {...operationResult(operation),status:"pending",message:"The recipient’s reviewed permissions are not present. Previous control has been retained."};
    }
    validateNeuronCommand(command,snapshot,services.principal);
    operation=await client.dispatch(operationId,step.step_id);
    const result=operationResult(operation);
    if (!independentVotes&&(result.status==="pending"||result.status==="rejected")) return result;
  }
  return operationResult(operation);
}

export interface ControlTransferInput { operationId:string;sns:string;governance:string;neuronId:string;toPrincipal:string;keepVotingAccess?:boolean;permissions?:number[] }
export async function prepareControlTransfer(input:ControlTransferInput,services:NeuronActionServices):Promise<NeuronOperationResult> {
  const to=Principal.fromText(input.toPrincipal);
  if(to.toText()===services.principal)throw new Error("The recipient already is this Neutron");
  const client=createOperationClient(services.kernel),existing=await client.get(input.operationId);
  const original=operationJsonText({version:1,kind:"transfer_control",principal:services.principal,...input});
  if(existing){if(existing.input_json!==original)throw new Error("Operation ID already belongs to another handover");return operationResult(existing);}
  const readCommand:Command={AddNeuronPermissions:{principal_id:[to],permissions_to_add:[{permissions:Int32Array.from(input.permissions??[])}]}};
  const snapshot=await readActionSnapshot(input.governance,input.neuronId,readCommand,services);
  if(!snapshot.neuron)throw new Error("SNS neuron was not found");
  const owned=neuronPermissions(snapshot.neuron,services.principal),permissions=input.permissions??owned;
  const add:Command={AddNeuronPermissions:{principal_id:[to],permissions_to_add:[{permissions:Int32Array.from(permissions)}]}};
  validateNeuronCommand(add,snapshot,services.principal);
  const remove=owned.filter(p=>!(input.keepVotingAccess&&[3,4].includes(p)));
  const steps=[{step_id:"grant_control",args:normalizeInput({...input,command:add})}];
  if(remove.length)steps.push({step_id:"remove_previous_control",args:normalizeInput({...input,command:{RemoveNeuronPermissions:{principal_id:[Principal.fromText(services.principal)],permissions_to_remove:[{permissions:Int32Array.from(remove)}]}}})});
  const review=operationJson({title:"Transfer neuron control",rootCanisterId:input.sns,governance:input.governance,neuronId:input.neuronId,toPrincipal:input.toPrincipal,
    fields:[{label:"Recipient",value:input.toPrincipal},{label:"Granted permissions",value:permissions.map(p=>NEURON_PERMISSIONS[p]??String(p)).join(", ")},{label:"Retained access",value:input.keepVotingAccess?"Vote and submit proposals":"None"}],warnings:["Control is handed over in two steps. Other principals keep their existing permissions.","A recipient with management permission can change access before the handover finishes."]}) as JsonObject;
  return operationResult(await client.prepare({operation_id:input.operationId,sns:input.sns,governance:input.governance,input_json:original,review_json:operationJsonText(review),state_json:operationJsonText({version:1,completedSteps:[]}),initiator:services.initiator??"user",steps}));
}

/** Mirrors SNS's current permission-based Neurons' Fund predicate. */
export function isNeuronsFundControlled(neuron:NeuronSummary):boolean {
  const managers=neuron.permissions.filter(p=>p.principal!==null&&p.permissions.includes(2)).map(p=>p.principal);
  return managers.length===1&&managers[0]==="rrkah-fqaaa-aaaaa-aaaaq-cai";
}

export interface NeuronActionsInput {operationId:string;sns:string;governance:string;commands:{neuronId:string;command:Command}[];review?:JsonObject}
export async function prepareNeuronActions(input:NeuronActionsInput,services:NeuronActionServices):Promise<NeuronOperationResult>{
  if(!input.commands.length)throw new Error("Choose at least one neuron command");
  const steps=input.commands.map((item,i)=>({step_id:`command_${i}`,args:normalizeInput({...input,...item})}));
  const retained=operationJsonText({version:1,kind:"manage_batch",principal:services.principal,commands:steps.map(s=>({stepId:s.step_id,args:commandEvidence(s.args)}))});
  const client=createOperationClient(services.kernel),existing=await client.get(input.operationId);
  if(existing){if(existing.input_json!==retained||existing.sns!==input.sns||existing.governance!==input.governance)throw new Error("This operation ID is already bound to another action batch");return operationResult(existing);}
  const reviews=[];for(const command of input.commands)reviews.push(await previewNeuronAction({...input,...command},services));
  const review=operationJson({...(input.review??{}),title:input.review?.title??"Apply SNS neuron actions",rootCanisterId:input.sns,governance:input.governance,commands:reviews}) as JsonObject;
  return operationResult(await client.prepare({operation_id:input.operationId,sns:input.sns,governance:input.governance,input_json:retained,review_json:operationJsonText(review),state_json:operationJsonText({version:1,completedSteps:[]}),initiator:services.initiator??"user",steps}));
}

/**
 * A new, explicitly reviewed attempt after a definite SNS rejection. The
 * original args, failed reply, staking nonce and Wallet request stay intact.
 */
export async function retryNeuronStep(operationId:string,stepId:string,retryOperationId:string,services:NeuronActionServices):Promise<NeuronOperationResult>{
  if(!retryOperationId||retryOperationId===operationId)throw new Error("Use a distinct attempt ID while retaining the original operation and funding IDs");
  const client=createOperationClient(services.kernel),original=await client.get(operationId);
  if(!original)throw new Error("Original SNS operation was not found");
  const identity=operationObject(original.input_json);
  if(identity.principal!==services.principal)throw new Error("The original operation belongs to another Neutron");
  const step=original.steps.find(s=>s.step_id===stepId);
  if(!step||step.status!=="replied"||!step.reply)throw new Error("This step has no definite SNS rejection; reconcile its retained outcome before another attempt");
  const rejected=decodeManageNeuronResponse(step.reply);
  if(rejected.ok||rejected.errorType===undefined)throw new Error("This step has no definite SNS rejection");
  const request=decodeManageNeuronRequest(step.args),command=request.command[0];
  if(!command)throw new Error("The original step omitted its command");
  // An external/internal failure can occur after a financial substep. Claim
  // only reads/claims the same fixed account and is effect-safe to repeat.
  if(!("ClaimOrRefresh" in command)&&[0,11,17].includes(rejected.errorType))throw new Error("The SNS failure may include partial effects. Reconcile the original operation before retrying this command");
  const input=operationJsonText({version:1,kind:"retry",principal:services.principal,originalOperationId:operationId,originalStepId:stepId,args:commandEvidence(step.args)});
  let attempt=await client.get(retryOperationId);
  if(attempt){if(attempt.input_json!==input)throw new Error("This attempt ID is already bound to another operation");}
  else{
    const review=await previewNeuronAction({operationId:retryOperationId,sns:original.sns,governance:original.governance,neuronId:toHex(request.subaccount),command},services);
    attempt=await client.prepare({operation_id:retryOperationId,sns:original.sns,governance:original.governance,input_json:input,review_json:operationJsonText({...review,originalOperationId:operationId,originalStepId:stepId}),initiator:services.initiator??"user",state_json:operationJsonText({version:1,completedSteps:[]}),steps:[{step_id:"retry",args:step.args}]});
  }
  const result=await executeNeuronOperation(attempt.operation_id,services);
  if(result.status!=="completed")return result;
  const updated=await mergeOperationState(client,original,current=>({...current,completedSteps:[...new Set([...(Array.isArray(current.completedSteps)?current.completedSteps:[]),stepId])],retryOperations:{...(current.retryOperations&&typeof current.retryOperations==="object"&&!Array.isArray(current.retryOperations)?current.retryOperations:{}),[stepId]:retryOperationId}}));
  return{...operationResult(updated),message:"The linked retry completed. Continue the original operation to finish its remaining retained steps."};
}
