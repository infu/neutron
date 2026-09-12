/** Shared browser-query vote planning for human controls and agent tools. */
import type { AgentOptions } from "./agent";
import { SnsError } from "./errors";
import { getProposal, listAllNeurons, proposalAcceptsVotes, type NeuronDiscovery } from "./governance";
import type { NeuronSummary, PartialResult, ProposalDetail } from "./types";

export interface VotePlanInput {
  rootCanisterId: string;
  governanceCanisterId: string;
  proposalId: bigint;
  votingPrincipal: string;
  canSign: boolean;
  votingEnabled?: boolean;
  agentVotingEnabled?: boolean;
  adopt?: boolean;
  neuronIds?: string[];
}

export interface VotePlan {
  rootCanisterId: string;
  proposalId: string;
  proposalTitle: string;
  proposalStatus: string;
  votingPrincipal: string;
  canSign: boolean;
  votingEnabled: boolean;
  agentVotingEnabled: boolean;
  acceptsVotes: boolean;
  deadlineSeconds?: string;
  eligibleNeuronIds: string[];
  /** Neurons that currently grant Vote and have an actual ballot, including cast ballots. */
  availableNeuronIds: string[];
  alreadyVotedNeuronIds: string[];
  alreadyVoted: { neuronId: string; vote: number; matchesRequestedVote?: boolean }[];
  excludedNeurons: { neuronId: string; reason: "no-vote-permission" | "no-ballot" | "deadline-passed" }[];
  discoveryComplete: boolean;
  failures: PartialResult<never>["failures"];
  note?: string;
}

const discoveries = new Map<string, Promise<NeuronDiscovery>>();
/** Share simultaneous feed reads, never reuse settled authorization snapshots. */
function discover(input: VotePlanInput, options: AgentOptions): Promise<NeuronDiscovery> {
  const key = JSON.stringify([input.governanceCanisterId, input.votingPrincipal, options.host, options.local]);
  const pending = discoveries.get(key);
  if (pending) return pending;
  const request = listAllNeurons(input.governanceCanisterId, { ofPrincipal: input.votingPrincipal }, options)
    .finally(() => discoveries.delete(key));
  discoveries.set(key, request);
  return request;
}

export async function buildVotePlan(input: VotePlanInput, options: AgentOptions = {}): Promise<VotePlan> {
  const [proposal, mine] = await Promise.all([
    getProposal(input.governanceCanisterId, input.proposalId, options), discover(input, options),
  ]);
  if (!proposal) throw new SnsError("INVALID_REQUEST", `Proposal ${input.proposalId} was not found.`);
  return planVotes({ ...input, proposal, neurons: mine.neurons, truncated: mine.truncated, failures: mine.failures });
}

export function planVotes(input: VotePlanInput & {
  proposal: ProposalDetail;
  neurons: NeuronSummary[];
  truncated?: boolean;
  failures?: PartialResult<never>["failures"];
  nowSeconds?: bigint;
}): VotePlan {
  const { proposal } = input;
  const acceptsVotes = proposalAcceptsVotes(proposal, input.nowSeconds);
  const ballots = new Map(proposal.ballots.map((ballot) => [ballot.neuronId.toLowerCase(), ballot]));
  const plan: VotePlan = {
    rootCanisterId: input.rootCanisterId,
    proposalId: input.proposalId.toString(),
    proposalTitle: proposal.title,
    proposalStatus: proposal.status,
    votingPrincipal: input.votingPrincipal,
    canSign: input.canSign,
    votingEnabled: Boolean(input.votingEnabled),
    agentVotingEnabled: Boolean(input.votingEnabled && input.agentVotingEnabled),
    acceptsVotes,
    ...(proposal.deadlineSeconds !== undefined ? { deadlineSeconds: proposal.deadlineSeconds.toString() } : {}),
    eligibleNeuronIds: [], availableNeuronIds: [], alreadyVotedNeuronIds: [], alreadyVoted: [], excludedNeurons: [],
    discoveryComplete: !input.truncated && (input.failures?.length ?? 0) === 0,
    failures: input.failures ?? [],
  };
  const seen = new Set<string>();
  for (const neuron of input.neurons) {
    const id = neuron.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (!neuron.permissions.some((entry) => entry.principal === input.votingPrincipal && entry.permissions.includes(4))) {
      plan.excludedNeurons.push({ neuronId: id, reason: "no-vote-permission" });
      continue;
    }
    const ballot = ballots.get(id);
    if (!ballot) {
      plan.excludedNeurons.push({ neuronId: id, reason: "no-ballot" });
      continue;
    }
    plan.availableNeuronIds.push(id);
    if (ballot.vote !== 0) {
      plan.alreadyVotedNeuronIds.push(id);
      plan.alreadyVoted.push({ neuronId: id, vote: ballot.vote,
        ...(input.adopt === undefined ? {} : { matchesRequestedVote: ballot.vote === (input.adopt ? 1 : 2) }),
      });
    } else if (acceptsVotes) plan.eligibleNeuronIds.push(id);
    else plan.excludedNeurons.push({ neuronId: id, reason: "deadline-passed" });
  }
  if (!acceptsVotes) plan.note = "The voting deadline has passed; this proposal no longer accepts votes.";
  else if (!input.canSign) plan.note = "The Neutron does not currently have its manage_neuron capability.";
  else if (!input.votingEnabled) plan.note = "Voting is not enabled for this SNS in the owner's preferences.";
  else if (!plan.discoveryComplete) plan.note = "Neuron discovery is incomplete; additional eligible neurons may exist. Retry the failed reads to vote with all neurons.";
  else if (proposal.status !== "open") plan.note = "This proposal is already decided but accepts votes for rewards until its deadline.";
  if (input.neuronIds !== undefined) {
    plan.eligibleNeuronIds = selectVoteNeurons(plan, input.neuronIds);
    const selected = new Set(input.neuronIds.map((id) => id.toLowerCase()));
    plan.alreadyVoted = plan.alreadyVoted.filter((ballot) => selected.has(ballot.neuronId));
    plan.alreadyVotedNeuronIds = plan.alreadyVoted.map((ballot) => ballot.neuronId);
  }
  return plan;
}

/** Validate every explicit ID before signing; cast ballots are reported separately. */
export function selectVoteNeurons(plan: VotePlan, neuronIds?: string[]): string[] {
  if (neuronIds === undefined) return [...plan.eligibleNeuronIds];
  if (neuronIds.length === 0) throw new SnsError("INVALID_REQUEST", "Choose at least one neuron or omit neuronIds to use all eligible neurons.");
  const requested = neuronIds.map((id) => id.toLowerCase());
  if (new Set(requested).size !== requested.length) throw new SnsError("INVALID_REQUEST", "The selected neuron IDs contain duplicates.");
  for (const id of requested) {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new SnsError("INVALID_REQUEST", `Invalid neuron ID: ${id}`);
    if (!plan.availableNeuronIds.includes(id)) throw new SnsError("INVALID_REQUEST", `Neuron ${id} does not grant Vote to this Neutron or has no ballot on this proposal.`);
  }
  const eligible = new Set(plan.eligibleNeuronIds);
  return requested.filter((id) => eligible.has(id));
}
