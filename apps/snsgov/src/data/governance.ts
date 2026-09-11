/**
 * SNS governance reads.
 *
 * Two traps are encoded here rather than left to callers:
 *
 *  1. `list_proposals` filters `ballots` to the *calling* principal. Our calls
 *     are anonymous, so it returns none. Ballots come from `get_proposal`,
 *     which returns the complete map to anonymous callers.
 *  2. `list_neurons` clamps `limit` to 100 and, when `of_principal` is set,
 *     ignores `start_page_at` entirely. Exhaustive discovery therefore falls
 *     back to public ordered pagination and filters permissions in the browser.
 */

import { Principal } from "@dfinity/principal";
import { actorFor, type AgentOptions } from "./agent";
import { SnsError, classifyError } from "./errors";
import { fromHex, toHex } from "./format";
import { opt, variantKey } from "./opt";
import { idlFactory as governanceIdl } from "../candid/sns_governance.did.js";
import type {
  NervousSystemFunctionInfo,
  NeuronSummary,
  ProposalDetail,
  ProposalStatus,
  ProposalSummary,
  SnsMetadata,
  SnsParameters,
} from "./types";

/** The canister clamps to this; asking for more silently returns 100. */
export const MAX_NEURONS_PER_CALL = 100;
/** The canister's own cap on a proposal page. */
export const MAX_PROPOSALS_PER_CALL = 100;

import type {
  _SERVICE as GovernanceService, NervousSystemParameters as RawParameters,
  ProposalData as RawProposalData, Neuron as RawNeuron,
  NervousSystemFunction as RawFunction, Action,
  GetRunningSnsVersionResponse, GetUpgradeJournalResponse, ListTopicsResponse,
} from "../candid/sns_governance.did";
import type { PartialResult, ProposalPayloadField } from "./types";
type Opt<T> = [] | [T];

async function governance(canisterId: string, options: AgentOptions) {
  return actorFor<GovernanceService>(governanceIdl, canisterId, options);
}

export async function readMetadata(
  governanceCanisterId: string,
  options: AgentOptions = {},
): Promise<SnsMetadata> {
  try {
    const raw = await (await governance(governanceCanisterId, options)).get_metadata({});
    const out: SnsMetadata = {};
    const logo = safeLogo(opt(raw.logo));
    if (logo !== undefined) out.logo = logo;
    const name = opt(raw.name);
    const description = opt(raw.description);
    const url = opt(raw.url);
    if (name !== undefined) out.name = name;
    if (description !== undefined) out.description = description;
    if (url !== undefined) out.url = url;
    return out;
  } catch (error) {
    throw classifyError(error, { role: "governance" });
  }
}

/** Governance mode: 1 = Normal, 2 = PreInitializationSwap. */
export async function readMode(
  governanceCanisterId: string,
  options: AgentOptions = {},
): Promise<number | undefined> {
  try {
    const raw = await (await governance(governanceCanisterId, options)).get_mode({});
    return opt(raw.mode);
  } catch (error) {
    throw classifyError(error, { role: "governance" });
  }
}

/** Note the Candid argument is `null`, not a record. */
export async function readParameters(
  governanceCanisterId: string,
  options: AgentOptions = {},
): Promise<SnsParameters> {
  let raw: RawParameters;
  try {
    raw = await (await governance(governanceCanisterId, options)).get_nervous_system_parameters(null);
  } catch (error) {
    throw classifyError(error, { role: "governance" });
  }

  return projectParameters(raw);
}

export function projectParameters(raw: RawParameters): SnsParameters {
  const rewardsRaw = opt(raw.voting_rewards_parameters);
  const out: SnsParameters = { raw };
  const claimer = opt(raw.neuron_claimer_permissions);
  const grantable = opt(raw.neuron_grantable_permissions);
  if (claimer) out.neuronClaimerPermissions = Array.from(claimer.permissions, Number);
  if (grantable) out.neuronGrantablePermissions = Array.from(grantable.permissions, Number);
  assign(out, "maxFolloweesPerFunction", opt(raw.max_followees_per_function));
  assign(out, "automaticallyAdvanceTargetVersion", opt(raw.automatically_advance_target_version));
  assign(out, "maturityModulationDisabled", opt(raw.maturity_modulation_disabled));
  assign(out, "transactionFeeE8s", opt(raw.transaction_fee_e8s));
  assign(out, "rejectCostE8s", opt(raw.reject_cost_e8s));
  assign(out, "neuronMinimumStakeE8s", opt(raw.neuron_minimum_stake_e8s));
  assign(out, "initialVotingPeriodSeconds", opt(raw.initial_voting_period_seconds));
  assign(out, "waitForQuietDeadlineIncreaseSeconds", opt(raw.wait_for_quiet_deadline_increase_seconds));
  assign(out, "neuronMinimumDissolveDelayToVoteSeconds", opt(raw.neuron_minimum_dissolve_delay_to_vote_seconds));
  assign(out, "maxDissolveDelaySeconds", opt(raw.max_dissolve_delay_seconds));
  assign(out, "maxDissolveDelayBonusPercentage", opt(raw.max_dissolve_delay_bonus_percentage));
  assign(out, "maxNeuronAgeForAgeBonusSeconds", opt(raw.max_neuron_age_for_age_bonus));
  assign(out, "maxAgeBonusPercentage", opt(raw.max_age_bonus_percentage));
  assign(out, "maxNumberOfNeurons", opt(raw.max_number_of_neurons));
  assign(out, "maxNumberOfPrincipalsPerNeuron", opt(raw.max_number_of_principals_per_neuron));
  if (rewardsRaw) {
    const rewards: NonNullable<SnsParameters["rewards"]> = {};
    assign(rewards, "initialBasisPoints", opt(rewardsRaw.initial_reward_rate_basis_points));
    assign(rewards, "finalBasisPoints", opt(rewardsRaw.final_reward_rate_basis_points));
    assign(rewards, "transitionSeconds", opt(rewardsRaw.reward_rate_transition_duration_seconds));
    assign(rewards, "roundDurationSeconds", opt(rewardsRaw.round_duration_seconds));
    out.rewards = rewards;
  }
  return out;
}

function assign<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

/**
 * The dashboard's "Max Voting Period Extension".
 *
 * A proposal's voting period extends to at most
 * `initial_voting_period + 2 * wait_for_quiet_deadline_increase`, so the
 * displayed extension is **twice** the raw parameter.
 */
export function maxVotingPeriodExtensionSeconds(params: SnsParameters): bigint | undefined {
  const increase = params.waitForQuietDeadlineIncreaseSeconds;
  return increase === undefined ? undefined : increase * 2n;
}

export interface ProposalPage {
  proposals: ProposalSummary[];
  /** Pass as `beforeProposal` to continue. Absent when the page is the last. */
  nextBefore?: bigint;
}

export async function listProposals(
  governanceCanisterId: string,
  params: { limit?: number; beforeProposal?: bigint } = {},
  options: AgentOptions = {},
): Promise<ProposalPage> {
  const limit = clamp(params.limit ?? 20, 1, MAX_PROPOSALS_PER_CALL);
  let raw: { proposals: RawProposalData[] };
  try {
    raw = await (await governance(governanceCanisterId, options)).list_proposals({
      include_reward_status: new Int32Array(),
      before_proposal: params.beforeProposal === undefined ? [] : [{ id: params.beforeProposal }],
      limit,
      exclude_type: new BigUint64Array(),
      include_topics: [],
      include_status: new Int32Array(),
    });
  } catch (error) {
    throw classifyError(error, { role: "governance" });
  }

  const proposals = raw.proposals.map(toProposalSummary);
  const last = proposals.at(-1);
  const page: ProposalPage = { proposals };
  // Only advertise a continuation when the page was full; a short page is the end.
  if (last !== undefined && proposals.length === limit) page.nextBefore = last.id;
  return page;
}

/**
 * One proposal with its complete ballot map.
 *
 * This is the only way to see ballots: `list_proposals` scopes them to the
 * caller, and we call anonymously.
 */
export async function getProposal(
  governanceCanisterId: string,
  proposalId: bigint,
  options: AgentOptions = {},
): Promise<ProposalDetail | undefined> {
  let raw: Awaited<ReturnType<GovernanceService["get_proposal"]>>;
  try {
    raw = await (await governance(governanceCanisterId, options)).get_proposal({
      proposal_id: [{ id: proposalId }],
    });
  } catch (error) {
    throw classifyError(error, { role: "governance" });
  }
  const result = opt(raw.result);
  if (!result) return undefined;
  if ("Error" in result) {
    if (result.Error.error_type === 5) return undefined;
    throw new SnsError("INVALID_REQUEST", result.Error.error_message);
  }
  return projectProposalDetail(result.Proposal);
}

export function projectProposalDetail(data: RawProposalData): ProposalDetail {

  const summary = toProposalSummary(data);
  const detail: ProposalDetail = {
    ...summary,
    raw: data,
    ballots: data.ballots.map(([neuronId, ballot]) => ({
      neuronId,
      vote: Number(ballot.vote),
      votingPower: ballot.voting_power,
      castAtSeconds: ballot.cast_timestamp_seconds,
    })),
  };
  const rendering = opt(data.payload_text_rendering);
  if (rendering !== undefined) detail.payloadTextRendering = rendering;
  const action = opt(opt(data.proposal)?.action);
  if (action) {
    detail.action = action;
    detail.payloadProvenance = proposalPayloadProvenance(action);
    detail.actionReusable = detail.payloadProvenance.every((field) => field.reusable);
  }
  const failure = opt(data.failure_reason);
  if (failure) detail.failureReason = { errorType: failure.error_type, message: failure.error_message };
  detail.rewardEventRound = data.reward_event_round;
  detail.isEligibleForRewards = data.is_eligible_for_rewards;
  assign(detail, "rewardEventEndTimestampSeconds", opt(data.reward_event_end_timestamp_seconds));
  return detail;
}

export function toProposalSummary(data: RawProposalData): ProposalSummary {
  const proposal = opt(data.proposal);
  const tallyRaw = opt(data.latest_tally);
  const out: ProposalSummary = {
    id: opt(data.id)?.id ?? 0n,
    title: proposal?.title ?? "",
    summary: proposal?.summary ?? "",
    url: proposal?.url ?? "",
    status: deriveStatus(data),
    createdAtSeconds: data.proposal_creation_timestamp_seconds,
    actionKind: variantKey(opt(proposal?.action)) ?? "Unknown",
    rejectCostE8s: data.reject_cost_e8s,
    ...proposalThresholds(data),
  };

  const proposer = opt(data.proposer);
  if (proposer) out.proposerNeuronId = toHex(normalizeBytes(proposer.id));
  const deadline = opt(data.wait_for_quiet_state)?.current_deadline_timestamp_seconds
    ?? data.proposal_creation_timestamp_seconds + data.initial_voting_period_seconds;
  if (deadline !== undefined) out.deadlineSeconds = deadline;
  if (data.decided_timestamp_seconds > 0n) out.decidedAtSeconds = data.decided_timestamp_seconds;
  if (data.executed_timestamp_seconds > 0n) out.executedAtSeconds = data.executed_timestamp_seconds;
  if (data.failed_timestamp_seconds > 0n) out.failedAtSeconds = data.failed_timestamp_seconds;
  if (tallyRaw) {
    out.tally = {
      yes: tallyRaw.yes,
      no: tallyRaw.no,
      total: tallyRaw.total,
      timestampSeconds: tallyRaw.timestamp_seconds,
    };
  }
  const topic = variantKey(opt(data.topic));
  if (topic !== undefined) out.topic = topic;
  // `action` is the nervous system function id, which for a custom proposal is
  // the registered function. Native actions use small reserved ids.
  if (out.actionKind === "ExecuteGenericNervousSystemFunction") out.functionId = data.action;
  return out;
}

/** Upstream distinguishes an absent Percentage from one with absent basis_points. */
export function proposalThresholds(data: Pick<RawProposalData,
  "minimum_yes_proportion_of_total" | "minimum_yes_proportion_of_exercised">) {
  const total = opt(data.minimum_yes_proportion_of_total);
  const exercised = opt(data.minimum_yes_proportion_of_exercised);
  return {
    minimumYesProportionOfTotal: total === undefined ? 300n : opt(total.basis_points) ?? 5000n,
    minimumYesProportionOfExercised: exercised === undefined ? 5000n : opt(exercised.basis_points) ?? 5000n,
  };
}

/** Compare with bigint: majority is strict, total voting-power quorum is inclusive. */
export function deriveStatus(data: RawProposalData): ProposalStatus {
  if (data.executed_timestamp_seconds > 0n) return "executed";
  if (data.failed_timestamp_seconds > 0n) return "failed";
  if (data.decided_timestamp_seconds === 0n) return "open";
  const tally = opt(data.latest_tally);
  if (!tally) return "unknown";
  const thresholds = proposalThresholds(data);
  return tally.yes * 10_000n > (tally.yes + tally.no) * thresholds.minimumYesProportionOfExercised
    && tally.yes * 10_000n >= tally.total * thresholds.minimumYesProportionOfTotal
    ? "adopted" : "rejected";
}

/** Decisions and eligibility for late reward votes are independent. */
export function proposalAcceptsVotes(proposal: ProposalSummary, nowSeconds = BigInt(Math.floor(Date.now() / 1000))): boolean {
  return proposal.deadlineSeconds !== undefined && nowSeconds < proposal.deadlineSeconds;
}

/** get_proposal replaces these fields above 64 bytes; list_proposals omits them. */
export function proposalPayloadProvenance(action: Action): ProposalPayloadField[] {
  const fields: { path: string; bytes: Uint8Array }[] = [];
  if ("ExecuteGenericNervousSystemFunction" in action) {
    fields.push({ path: "ExecuteGenericNervousSystemFunction.payload", bytes: action.ExecuteGenericNervousSystemFunction.payload });
  }
  if ("UpgradeSnsControlledCanister" in action) {
    const upgrade = action.UpgradeSnsControlledCanister;
    fields.push({ path: "UpgradeSnsControlledCanister.new_canister_wasm", bytes: upgrade.new_canister_wasm });
    const arg = opt(upgrade.canister_upgrade_arg);
    if (arg) fields.push({ path: "UpgradeSnsControlledCanister.canister_upgrade_arg", bytes: arg });
  }
  return fields.map(({ path, bytes }) => {
    const summarized = bytes.length > 64;
    return {
      path, provenance: summarized ? "summarized" : "original", reusable: !summarized,
      returnedBytes: bytes.length,
      ...(summarized ? { summary: new TextDecoder().decode(normalizeBytes(bytes)) } : {}),
    };
  });
}

/**
 * Neurons for one SNS.
 *
 * `ofPrincipal` matches **any** principal in a neuron's permissions, not just
 * the controller — that is how we find the neurons this Neutron may vote with.
 *
 * A full page is potentially incomplete even when a requested limit is less
 * than 100. Use listAllNeurons for exhaustive principal discovery; filtered
 * queries ignore their cursor, so it falls back to public ordered pagination.
 */
export async function listNeurons(
  governanceCanisterId: string,
  params: { ofPrincipal?: string | Principal; limit?: number; startPageAt?: Uint8Array } = {},
  options: AgentOptions = {},
): Promise<NeuronPage> {
  const limit = clamp(params.limit ?? MAX_NEURONS_PER_CALL, 1, MAX_NEURONS_PER_CALL);
  const principal =
    params.ofPrincipal === undefined
      ? undefined
      : typeof params.ofPrincipal === "string"
        ? Principal.fromText(params.ofPrincipal)
        : params.ofPrincipal;

  let raw: { neurons: RawNeuron[] };
  try {
    raw = await (await governance(governanceCanisterId, options)).list_neurons({
      of_principal: principal === undefined ? [] : [principal],
      limit,
      // Ignored by the canister when of_principal is set; sent only for the
      // unfiltered form, where it does paginate.
      start_page_at:
        params.startPageAt === undefined || principal !== undefined
          ? []
          : [{ id: params.startPageAt }],
    });
  } catch (error) {
    throw classifyError(error, { role: "governance" });
  }

  return projectNeuronPage(raw.neurons, limit, principal !== undefined);
}

export function projectNeuronPage(neurons: RawNeuron[], limit: number, principalFiltered: boolean): NeuronPage {
  return {
    neurons: neurons.map(toNeuronSummary),
    truncated: neurons.length >= limit,
    ...(!principalFiltered && neurons.length >= limit && opt(neurons.at(-1)?.id)
      ? { nextStartPageAt: normalizeBytes(opt(neurons.at(-1)?.id)!.id) } : {}),
  };
}

export interface NeuronPage {
  neurons: NeuronSummary[];
  /** True when another page may exist; never claim a full page is complete. */
  truncated: boolean;
  /** Public pagination cursor; SNS ignores cursors on principal-filtered reads. */
  nextStartPageAt?: Uint8Array;
}
export interface NeuronDiscovery extends NeuronPage {
  failures: PartialResult<never>["failures"];
}

/** Exhaustive public pagination is the upstream-supported way past filtered neuron 100. */
export async function listAllNeurons(
  governanceCanisterId: string,
  params: { ofPrincipal?: string | Principal } = {},
  options: AgentOptions = {},
): Promise<NeuronDiscovery> {
  return collectNeurons((page) => listNeurons(governanceCanisterId, page, options), params.ofPrincipal, governanceCanisterId);
}

/** Separate paginator permits protocol edge-case tests without mocking the global agent. */
export async function collectNeurons(
  readPage: (params: { ofPrincipal?: string | Principal; limit: number; startPageAt?: Uint8Array }) => Promise<NeuronPage>,
  ofPrincipal?: string | Principal,
  scope = "neurons",
): Promise<NeuronDiscovery> {
  const principal = typeof ofPrincipal === "string" ? Principal.fromText(ofPrincipal).toText() : ofPrincipal?.toText();
  const neurons = new Map<string, NeuronSummary>();
  let nextStartPageAt: Uint8Array | undefined;
  const remember = (page: NeuronPage) => {
    for (const neuron of page.neurons) {
      if (principal === undefined || neuron.permissions.some((entry) => entry.principal === principal)) neurons.set(neuron.id, neuron);
    }
  };
  try {
    if (principal !== undefined) {
      const filtered = await readPage({ ofPrincipal: principal, limit: MAX_NEURONS_PER_CALL });
      remember(filtered);
      if (!filtered.truncated) return { neurons: [...neurons.values()], truncated: false, failures: [] };
    }
    while (true) {
      const page = await readPage({ limit: MAX_NEURONS_PER_CALL, ...(nextStartPageAt ? { startPageAt: nextStartPageAt } : {}) });
      remember(page);
      if (!page.truncated) return { neurons: [...neurons.values()], truncated: false, failures: [] };
      const cursor = page.nextStartPageAt;
      if (!cursor || (nextStartPageAt && toHex(cursor) <= toHex(nextStartPageAt))) {
        throw new SnsError("INTERNAL", "SNS neuron pagination returned a full page without an advancing cursor.");
      }
      nextStartPageAt = cursor;
    }
  } catch (error) {
    const failure = classifyError(error, { role: "governance" });
    return { neurons: [...neurons.values()], truncated: true, ...(nextStartPageAt ? { nextStartPageAt } : {}),
      failures: [{ scope, code: failure.code, message: failure.message }] };
  }
}

export async function getNeuron(
  governanceCanisterId: string,
  neuronId: string,
  options: AgentOptions = {},
): Promise<NeuronSummary | undefined> {
  const id = fromHex(neuronId);
  if (id.length !== 32) throw new SnsError("INVALID_REQUEST", "A neuron ID must be 32 bytes of hexadecimal.");
  try {
    const result = opt((await (await governance(governanceCanisterId, options)).get_neuron({ neuron_id: [{ id }] })).result);
    if (!result) return undefined;
    if ("Error" in result) {
      if (result.Error.error_type === 5) return undefined;
      throw new SnsError("INVALID_REQUEST", result.Error.error_message);
    }
    return toNeuronSummary(result.Neuron);
  } catch (error) { throw classifyError(error, { role: "governance" }); }
}

export function toNeuronSummary(neuron: RawNeuron): NeuronSummary {
  const dissolve = opt(neuron.dissolve_state) as
    | { DissolveDelaySeconds?: bigint; WhenDissolvedTimestampSeconds?: bigint }
    | undefined;
  const out: NeuronSummary = {
    raw: neuron,
    id: toHex(normalizeBytes(opt(neuron.id)?.id ?? [])),
    stakeE8s: neuron.cached_neuron_stake_e8s,
    feesE8s: neuron.neuron_fees_e8s ?? 0n,
    effectiveStakeE8s: neuron.cached_neuron_stake_e8s > (neuron.neuron_fees_e8s ?? 0n)
      ? neuron.cached_neuron_stake_e8s - (neuron.neuron_fees_e8s ?? 0n) : 0n,
    followees: (neuron.followees ?? []).map(([functionId, follows]) => ({ functionId, neuronIds: follows.followees.map((id) => toHex(id.id)) })),
    topicFollowees: (opt(neuron.topic_followees)?.topic_id_to_followees ?? []).map(([topicId, follows]) => ({
      topicId, topic: variantKey(opt(follows.topic)),
      neuronIds: follows.followees.flatMap((followee) => { const id = opt(followee.neuron_id); return id ? [toHex(id.id)] : []; }),
      aliases: follows.followees.map((followee) => opt(followee.alias)),
    })),
    disburseMaturityInProgress: (neuron.disburse_maturity_in_progress ?? []).map((disbursement) => {
      const account = opt(disbursement.account_to_disburse_to);
      const subaccount = opt(account?.subaccount);
      return { amountE8s: disbursement.amount_e8s, timestampSeconds: disbursement.timestamp_of_disbursement_seconds,
        finalizeDisbursementTimestampSeconds: opt(disbursement.finalize_disbursement_timestamp_seconds),
        ...(account ? { account: { owner: opt(account.owner)?.toText(), subaccountHex: subaccount ? toHex(subaccount.subaccount) : undefined } } : {}),
      };
    }),
    maturityE8s: neuron.maturity_e8s_equivalent,
    stakedMaturityE8s: opt(neuron.staked_maturity_e8s_equivalent) ?? 0n,
    votingPowerMultiplierPercent: neuron.voting_power_percentage_multiplier,
    createdAtSeconds: neuron.created_timestamp_seconds,
    agingSinceSeconds: neuron.aging_since_timestamp_seconds,
    permissions: neuron.permissions.map((entry) => ({
      principal: opt(entry.principal)?.toText() ?? null,
      permissions: Array.from(entry.permission_type, Number),
    })),
  };
  if (dissolve?.DissolveDelaySeconds !== undefined) {
    out.dissolveState = { kind: "delay", value: dissolve.DissolveDelaySeconds };
  } else if (dissolve?.WhenDissolvedTimestampSeconds !== undefined) {
    out.dissolveState = { kind: "dissolving", value: dissolve.WhenDissolvedTimestampSeconds };
  }
  assign(out, "autoStakeMaturity", opt(neuron.auto_stake_maturity));
  assign(out, "sourceNnsNeuronId", opt(neuron.source_nns_neuron_id));
  const vesting = opt(neuron.vesting_period_seconds);
  if (vesting !== undefined) out.vestingPeriodSeconds = vesting;
  return out;
}

/**
 * The proposal types this SNS accepts.
 *
 * Never hard-code these: the native set is fixed but custom functions are
 * per-SNS and change at runtime. A generic function with no `topic` cannot be
 * proposed at all — `make_proposal` rejects it with `InvalidProposal` — so the
 * absent topic is load-bearing, not cosmetic.
 */
export async function listNervousSystemFunctions(
  governanceCanisterId: string,
  options: AgentOptions = {},
): Promise<NervousSystemFunctionInfo[]> {
  let raw: { functions: RawFunction[] };
  try {
    raw = await (await governance(governanceCanisterId, options)).list_nervous_system_functions();
  } catch (error) {
    throw classifyError(error, { role: "governance" });
  }

  return raw.functions.map((fn) => {
    const kindRaw = opt(fn.function_type);
    const generic = kindRaw && "GenericNervousSystemFunction" in kindRaw ? kindRaw.GenericNervousSystemFunction : undefined;
    const out: NervousSystemFunctionInfo = {
      id: fn.id,
      name: fn.name,
      kind: generic ? "generic" : "native",
    };
    const description = opt(fn.description);
    if (description !== undefined) out.description = description;
    if (generic) {
      const target = opt(generic.target_canister_id)?.toText();
      const targetMethod = opt(generic.target_method_name);
      const validator = opt(generic.validator_canister_id)?.toText();
      const validatorMethod = opt(generic.validator_method_name);
      const topic = variantKey(opt(generic.topic));
      if (target !== undefined) out.targetCanisterId = target;
      if (targetMethod !== undefined) out.targetMethodName = targetMethod;
      if (validator !== undefined) out.validatorCanisterId = validator;
      if (validatorMethod !== undefined) out.validatorMethodName = validatorMethod;
      if (topic !== undefined) out.topic = topic;
    }
    return out;
  });
}

/** Browser-direct, typed protocol reads. Older deployments return SNS_UNSUPPORTED_METHOD. */
export async function listTopics(governanceCanisterId: string, options: AgentOptions = {}): Promise<ListTopicsResponse> {
  try { return await (await governance(governanceCanisterId, options)).list_topics({}); }
  catch (error) { throw classifyError(error, { role: "governance" }); }
}

export async function readRunningSnsVersion(governanceCanisterId: string, options: AgentOptions = {}): Promise<GetRunningSnsVersionResponse> {
  try { return await (await governance(governanceCanisterId, options)).get_running_sns_version({}); }
  catch (error) { throw classifyError(error, { role: "governance" }); }
}

export async function readUpgradeJournal(governanceCanisterId: string, params: { offset?: bigint; limit?: bigint } = {}, options: AgentOptions = {}): Promise<GetUpgradeJournalResponse> {
  try { return await (await governance(governanceCanisterId, options)).get_upgrade_journal({
    offset: params.offset === undefined ? [] : [params.offset], limit: params.limit === undefined ? [] : [params.limit],
  }); }
  catch (error) { throw classifyError(error, { role: "governance" }); }
}

/**
 * Custom functions that cannot currently be proposed because they carry no
 * topic. 35 such functions exist across 7 live SNSes, so this is a routine
 * state to surface, not an anomaly.
 */
export function uncategorizedFunctions(
  functions: NervousSystemFunctionInfo[],
): NervousSystemFunctionInfo[] {
  return functions.filter((fn) => fn.kind === "generic" && fn.topic === undefined);
}

function normalizeBytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * Accept a DAO logo only as an inline image.
 *
 * A `data:image/…` URI renders without a network request; anything else — an
 * `http(s)` URL above all — would have the tile fetch from a third party the
 * DAO chose, leaking that the owner is looking at this SNS. Oversized payloads
 * are dropped rather than truncated: half a base64 image is not an image.
 */
const MAX_LOGO_BYTES = 512_000;

export function safeLogo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    return undefined;
  }
  return value.length > MAX_LOGO_BYTES ? undefined : value;
}
