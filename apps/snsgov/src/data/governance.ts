/**
 * SNS governance reads.
 *
 * Two traps are encoded here rather than left to callers:
 *
 *  1. `list_proposals` filters `ballots` to the *calling* principal. Our calls
 *     are anonymous, so it returns none. Ballots come from `get_proposal`,
 *     which returns the complete map to anonymous callers.
 *  2. `list_neurons` clamps `limit` to 100 and, when `of_principal` is set,
 *     ignores `start_page_at` entirely — there is no way to reach neuron 101.
 */

import { Principal } from "@dfinity/principal";
import { actorFor, type AgentOptions } from "./agent";
import { classifyError } from "./errors";
import { toHex } from "./format";
import { opt, variantKey } from "./opt";
import { idlFactory as governanceIdl } from "../candid/sns_governance.did.js";
import type {
  Ballot,
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

type Opt<T> = [] | [T];

interface GovernanceService {
  get_metadata: (arg: Record<string, never>) => Promise<{
    url: Opt<string>;
    logo: Opt<string>;
    name: Opt<string>;
    description: Opt<string>;
  }>;
  get_mode: (arg: Record<string, never>) => Promise<{ mode: Opt<number> }>;
  get_nervous_system_parameters: (arg: null) => Promise<RawParameters>;
  list_proposals: (arg: RawListProposals) => Promise<{ proposals: RawProposalData[] }>;
  get_proposal: (arg: { proposal_id: Opt<{ id: bigint }> }) => Promise<{
    result: Opt<{ Proposal?: RawProposalData; Error?: unknown }>;
  }>;
  list_neurons: (arg: {
    of_principal: Opt<Principal>;
    limit: number;
    start_page_at: Opt<{ id: Uint8Array | number[] }>;
  }) => Promise<{ neurons: RawNeuron[] }>;
  list_nervous_system_functions: () => Promise<{ functions: RawFunction[] }>;
}

interface RawParameters {
  transaction_fee_e8s: Opt<bigint>;
  reject_cost_e8s: Opt<bigint>;
  neuron_minimum_stake_e8s: Opt<bigint>;
  initial_voting_period_seconds: Opt<bigint>;
  wait_for_quiet_deadline_increase_seconds: Opt<bigint>;
  neuron_minimum_dissolve_delay_to_vote_seconds: Opt<bigint>;
  max_dissolve_delay_seconds: Opt<bigint>;
  max_dissolve_delay_bonus_percentage: Opt<bigint>;
  max_neuron_age_for_age_bonus: Opt<bigint>;
  max_age_bonus_percentage: Opt<bigint>;
  max_number_of_neurons: Opt<bigint>;
  max_number_of_principals_per_neuron: Opt<bigint>;
  voting_rewards_parameters: Opt<{
    initial_reward_rate_basis_points: Opt<bigint>;
    final_reward_rate_basis_points: Opt<bigint>;
    reward_rate_transition_duration_seconds: Opt<bigint>;
    round_duration_seconds: Opt<bigint>;
  }>;
}

interface RawListProposals {
  include_reward_status: Int32Array | number[];
  before_proposal: Opt<{ id: bigint }>;
  limit: number;
  exclude_type: BigUint64Array | bigint[];
  include_topics: Opt<unknown[]>;
  include_status: Int32Array | number[];
}

interface RawProposalData {
  id: Opt<{ id: bigint }>;
  payload_text_rendering: Opt<string>;
  topic: Opt<object>;
  action: bigint;
  ballots: [string, { vote: number; voting_power: bigint; cast_timestamp_seconds: bigint }][];
  reward_event_round: bigint;
  failed_timestamp_seconds: bigint;
  proposal_creation_timestamp_seconds: bigint;
  initial_voting_period_seconds: bigint;
  reject_cost_e8s: bigint;
  latest_tally: Opt<{ yes: bigint; no: bigint; total: bigint; timestamp_seconds: bigint }>;
  wait_for_quiet_deadline_increase_seconds: bigint;
  decided_timestamp_seconds: bigint;
  proposal: Opt<{ title: string; summary: string; url: string; action: Opt<object> }>;
  proposer: Opt<{ id: Uint8Array | number[] }>;
  wait_for_quiet_state: Opt<{ current_deadline_timestamp_seconds: bigint }>;
  executed_timestamp_seconds: bigint;
  minimum_yes_proportion_of_total: Opt<{ basis_points: Opt<bigint> }>;
  minimum_yes_proportion_of_exercised: Opt<{ basis_points: Opt<bigint> }>;
}

interface RawNeuron {
  id: Opt<{ id: Uint8Array | number[] }>;
  permissions: { principal: Opt<Principal>; permission_type: Int32Array | number[] }[];
  cached_neuron_stake_e8s: bigint;
  maturity_e8s_equivalent: bigint;
  staked_maturity_e8s_equivalent: Opt<bigint>;
  voting_power_percentage_multiplier: bigint;
  created_timestamp_seconds: bigint;
  aging_since_timestamp_seconds: bigint;
  dissolve_state: Opt<object>;
  vesting_period_seconds: Opt<bigint>;
}

interface RawFunction {
  id: bigint;
  name: string;
  description: Opt<string>;
  function_type: Opt<{
    NativeNervousSystemFunction?: object;
    GenericNervousSystemFunction?: {
      topic: Opt<object>;
      target_canister_id: Opt<Principal>;
      target_method_name: Opt<string>;
      validator_canister_id: Opt<Principal>;
      validator_method_name: Opt<string>;
    };
  }>;
}

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

  const rewardsRaw = opt(raw.voting_rewards_parameters);
  const out: SnsParameters = {};
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
      include_reward_status: [],
      before_proposal: params.beforeProposal === undefined ? [] : [{ id: params.beforeProposal }],
      limit,
      exclude_type: [],
      include_topics: [],
      include_status: [],
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
  let raw: { result: Opt<{ Proposal?: RawProposalData }> };
  try {
    raw = await (await governance(governanceCanisterId, options)).get_proposal({
      proposal_id: [{ id: proposalId }],
    });
  } catch (error) {
    throw classifyError(error, { role: "governance" });
  }
  const result = opt(raw.result);
  const data = result?.Proposal;
  if (!data) return undefined;

  const summary = toProposalSummary(data);
  const detail: ProposalDetail = {
    ...summary,
    ballots: data.ballots.map(([neuronId, ballot]) => ({
      neuronId,
      vote: Number(ballot.vote),
      votingPower: ballot.voting_power,
      castAtSeconds: ballot.cast_timestamp_seconds,
    })),
  };
  const rendering = opt(data.payload_text_rendering);
  if (rendering !== undefined) detail.payloadTextRendering = rendering;
  const total = opt(opt(data.minimum_yes_proportion_of_total)?.basis_points);
  if (total !== undefined) detail.minimumYesProportionOfTotal = total;
  const exercised = opt(opt(data.minimum_yes_proportion_of_exercised)?.basis_points);
  if (exercised !== undefined) detail.minimumYesProportionOfExercised = exercised;
  return detail;
}

function toProposalSummary(data: RawProposalData): ProposalSummary {
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
  };

  const proposer = opt(data.proposer);
  if (proposer) out.proposerNeuronId = toHex(normalizeBytes(proposer.id));
  const deadline = opt(data.wait_for_quiet_state)?.current_deadline_timestamp_seconds;
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

/**
 * Status is derived, not stored.
 *
 * Executed and failed are explicit timestamps. Otherwise a decided proposal is
 * adopted or rejected according to its final tally, and an undecided one is
 * open. The tally comparison is a simple majority check; the exact thresholds
 * are per-proposal (`minimum_yes_proportion_of_*`) and only matter while a vote
 * is still live, by which point the canister has already decided.
 */
function deriveStatus(data: RawProposalData): ProposalStatus {
  if (data.executed_timestamp_seconds > 0n) return "executed";
  if (data.failed_timestamp_seconds > 0n) return "failed";
  if (data.decided_timestamp_seconds === 0n) return "open";
  const tally = opt(data.latest_tally);
  if (!tally) return "unknown";
  return tally.yes > tally.no ? "adopted" : "rejected";
}

/**
 * Neurons for one SNS.
 *
 * `ofPrincipal` matches **any** principal in a neuron's permissions, not just
 * the controller — that is how we find the neurons this Neutron may vote with.
 *
 * Pagination caveat: when `ofPrincipal` is set the canister ignores
 * `startPageAt`, so at most 100 neurons are reachable for a principal. The
 * `truncated` flag says when that limit was hit; callers must surface it rather
 * than silently showing a partial set.
 */
export async function listNeurons(
  governanceCanisterId: string,
  params: { ofPrincipal?: string | Principal; limit?: number; startPageAt?: Uint8Array } = {},
  options: AgentOptions = {},
): Promise<{ neurons: NeuronSummary[]; truncated: boolean }> {
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

  return {
    neurons: raw.neurons.map(toNeuronSummary),
    truncated: principal !== undefined && raw.neurons.length >= MAX_NEURONS_PER_CALL,
  };
}

function toNeuronSummary(neuron: RawNeuron): NeuronSummary {
  const dissolve = opt(neuron.dissolve_state) as
    | { DissolveDelaySeconds?: bigint; WhenDissolvedTimestampSeconds?: bigint }
    | undefined;
  const out: NeuronSummary = {
    id: toHex(normalizeBytes(opt(neuron.id)?.id ?? [])),
    stakeE8s: neuron.cached_neuron_stake_e8s,
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
    const generic = kindRaw?.GenericNervousSystemFunction;
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
