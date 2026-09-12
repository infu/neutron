/**
 * The signed write path.
 *
 * Reads go straight to the IC anonymously. Writes cannot: they need a
 * signature, and this app deliberately holds no key. Instead the Neutron
 * canister signs, and its principal is the "hotkey" the user registers on their
 * SNS neurons.
 *
 * The route is: here -> `updateSelf` (a preapproved self call, so no dialog per
 * vote) -> our backend -> the brokered `manage_neuron` call. The backend picks
 * the target canister from the owner's allowlist; nothing on this side chooses
 * it.
 */

import { querySelf, updateSelf, type ScopedKernelClient } from "neutron-tools/app";
import { SnsError } from "./errors";
import { getProposal } from "./governance";
import type { Ballot } from "./types";
import {
  decodeManageNeuronResponse,
  encodeRegisterVote,
  isAlreadyVoted,
  type ManageNeuronOutcome,
} from "./manage_neuron";

// The self-call wire carries JSON-compatible values plus binary. Principals
// travel as text and Nat/Nat64 as lossless decimal strings; the Kernel converts
// them against the live Candid interface before signing.

/** Who initiated a signed action. Recorded in the audit trail. */
export type Initiator = "user" | "agent" | "timer";

export interface HotkeyStatus {
  /** The principal to register on your neurons. */
  principal: string;
  /** False until the owner approves the backend-call reservation. */
  canManageNeuron: boolean;
}

/** The principal the user must register, and whether we may sign yet. */
export async function readHotkey(kernel: Pick<ScopedKernelClient, "querySelf"> = { querySelf }): Promise<HotkeyStatus> {
  const raw = (await kernel.querySelf("snsgov_hotkey", [null])) as unknown as {
    principal: string | { toText(): string };
    can_manage_neuron: boolean;
  };
  return {
    principal: typeof raw.principal === "string" ? raw.principal : raw.principal.toText(),
    canManageNeuron: raw.can_manage_neuron,
  };
}

export interface VoteOutcome {
  neuronId: string;
  ok: boolean;
  /** An existing ballot is not a newly accepted vote. */
  alreadyVoted: boolean;
  actualVote?: number;
  matchesRequestedVote?: boolean;
  ballotReadError?: string;
  error?: string;
  /** The relay may have committed; read the proposal ballots before retrying. */
  outcomeUnknown?: boolean;
}

export interface VoteReport {
  attempted: number;
  succeeded: number;
  outcomes: VoteOutcome[];
  unattemptedNeuronIds: string[];
  outcomeUnknownNeuronIds: string[];
  /** Set when the batch was refused outright, e.g. the SNS is not allowlisted. */
  error?: string;
}

/**
 * Vote on one proposal with many neurons.
 *
 * Batched through the broker, which caps a batch at 20, so larger sets are
 * chunked. Partial success is the normal outcome and is reported per neuron
 * rather than collapsed into a boolean.
 */
export async function voteWithNeurons(params: {
  snsRootCanisterId: string;
  proposalId: bigint;
  neuronIds: string[];
  adopt: boolean;
  initiator?: Initiator;
  governanceCanisterId?: string;
  /** Optional browser reader for an authoritative ballot check after a race. */
  readBallots?: () => Promise<Ballot[]>;
}, kernel: Pick<ScopedKernelClient, "updateSelf"> = { updateSelf }): Promise<VoteReport> {
  const { snsRootCanisterId, proposalId, neuronIds, adopt } = params;
  const initiator = params.initiator ?? "user";
  if (neuronIds.length === 0) {
    return { attempted: 0, succeeded: 0, outcomes: [], unattemptedNeuronIds: [], outcomeUnknownNeuronIds: [] };
  }

  // Validate and encode the whole request before the first signed chunk.
  if (new Set(neuronIds.map((id) => id.toLowerCase())).size !== neuronIds.length) {
    throw new SnsError("INVALID_REQUEST", "Duplicate neuron IDs in the vote request.");
  }
  const encodedVotes = neuronIds.map((neuronId) => encodeRegisterVote(neuronId, proposalId, adopt));
  const outcomes: VoteOutcome[] = [];
  let succeeded = 0;
  const CHUNK = 20;
  const finish = async (error?: string): Promise<VoteReport> => {
    const needsBallots = outcomes.filter((outcome) => outcome.alreadyVoted || outcome.outcomeUnknown);
    const readBallots = params.readBallots ?? (params.governanceCanisterId ? async () => {
      const proposal = await getProposal(params.governanceCanisterId!, proposalId);
      if (!proposal) throw new Error("Proposal ballots were unavailable.");
      return proposal.ballots;
    } : undefined);
    if (needsBallots.length > 0 && readBallots) {
      try {
        const ballots = new Map((await readBallots()).map((ballot) => [ballot.neuronId.toLowerCase(), ballot]));
        for (const outcome of needsBallots) {
          const ballot = ballots.get(outcome.neuronId.toLowerCase());
          if (ballot) {
            outcome.actualVote = ballot.vote;
            outcome.matchesRequestedVote = ballot.vote === (adopt ? 1 : 2);
          }
        }
      } catch (failure) {
        for (const outcome of needsBallots) outcome.ballotReadError = describeRelayFailure(failure);
      }
    }
    const attempted = new Set(outcomes.map((outcome) => outcome.neuronId));
    return { attempted: outcomes.length, succeeded, outcomes,
      unattemptedNeuronIds: neuronIds.filter((id) => !attempted.has(id)),
      outcomeUnknownNeuronIds: outcomes.filter((outcome) => outcome.outcomeUnknown).map((outcome) => outcome.neuronId),
      ...(error ? { error } : {}),
    };
  };

  for (let index = 0; index < neuronIds.length; index += CHUNK) {
    const chunk = neuronIds.slice(index, index + CHUNK);
    const encoded = encodedVotes.slice(index, index + CHUNK);

    let reply: {
      results: ({ ok: Uint8Array | number[] } | { err: string })[];
      attempted: string | number;
      succeeded: string | number;
      error?: string | null;
    };
    try {
      reply = (await kernel.updateSelf("snsgov_relay_batch", [
        {
          sns: snsRootCanisterId,
          calls: encoded,
          initiator,
          kind: "vote",
          // An option on this wire is the bare value or an omitted key — never a
          // Candid-style `[value]`, which the encoder rejects as a scalar
          // mismatch. Nat64 travels as a decimal string; `vote` is an Int32 and
          // so stays a number.
          proposal_id: proposalId.toString(),
          vote: adopt ? 1 : 2,
        },
      ])) as unknown as typeof reply;
    } catch (error) {
      const message = `Vote reply interrupted: ${describeRelayFailure(error)}. Read proposal ballots before retrying.`;
      outcomes.push(...chunk.map((neuronId) => ({ neuronId, ok: false, alreadyVoted: false, outcomeUnknown: true, error: message })));
      return finish(message);
    }

    const refusal = reply?.error ?? undefined;
    if (refusal) {
      return finish(refusal);
    }

    if (!reply || !Array.isArray(reply.results)) {
      const error = "The vote relay returned no batch results. Read proposal ballots before retrying.";
      outcomes.push(...chunk.map((neuronId) => ({ neuronId, ok: false, alreadyVoted: false, outcomeUnknown: true, error })));
      return finish(error);
    }
    chunk.forEach((neuronId, offset) => {
      const result = reply.results[offset];
      if (result && "ok" in result) {
        let outcome: ManageNeuronOutcome;
        try { outcome = decodeReply(result.ok); }
        catch (error) {
          outcomes.push({ neuronId, ok: false, alreadyVoted: false, outcomeUnknown: true, error: describeRelayFailure(error) });
          return;
        }
        const already = isAlreadyVoted(outcome);
        const accepted = outcome.ok && outcome.command === "RegisterVote";
        if (accepted) succeeded += 1;
        outcomes.push({
          neuronId,
          ok: accepted,
          alreadyVoted: already,
          ...(accepted ? { actualVote: adopt ? 1 : 2, matchesRequestedVote: true } : {
            error: outcome.errorMessage ?? "The SNS returned an unexpected vote command response.",
            ...(outcome.ok ? { outcomeUnknown: true } : {}),
          }),
        });
      } else if (result && "err" in result) {
        outcomes.push({ neuronId, ok: false, alreadyVoted: false, error: result.err });
      } else {
        outcomes.push({ neuronId, ok: false, alreadyVoted: false, outcomeUnknown: true, error: "No result was returned for this neuron. Read proposal ballots before retrying." });
      }
    });
    if (outcomes.some((outcome) => outcome.outcomeUnknown)) {
      return finish("Some vote outcomes are unknown. Read proposal ballots before retrying.");
    }
  }

  return finish();
}

/** Submit one pre-encoded `manage_neuron` payload, e.g. a proposal. */
export async function relayManageNeuron(params: {
  snsRootCanisterId: string;
  args: Uint8Array;
  kind: string;
  initiator?: Initiator;
}): Promise<ManageNeuronOutcome> {
  // `proposal_id` and `vote` are absent options, so their keys are simply
  // omitted. The Kernel unwraps a two-field ok/err variant, so a refusal
  // arrives as a thrown value rather than an `{ err }` envelope, and the
  // success path is the `#ok` blob itself.
  let reply: unknown;
  try {
    reply = await updateSelf("snsgov_relay", [
      {
        sns: params.snsRootCanisterId,
        args: params.args,
        initiator: params.initiator ?? "user",
        kind: params.kind,
      },
    ]);
  } catch (error) {
    throw new SnsError("INVALID_REQUEST", describeRelayFailure(error), {
      sns: params.snsRootCanisterId,
      retryable: false,
    });
  }

  if (!(reply instanceof Uint8Array) && !Array.isArray(reply)) {
    // An ambiguous reply must never be auto-retried: the update may have
    // committed.
    throw new SnsError("OUTCOME_UNKNOWN", "the relay returned no result", {
      sns: params.snsRootCanisterId,
      retryable: false,
    });
  }
  return decodeReply(reply as Uint8Array | number[]);
}

function decodeReply(reply: Uint8Array | number[]): ManageNeuronOutcome {
  const bytes = reply instanceof Uint8Array ? reply : Uint8Array.from(reply);
  try {
    const outcome = decodeManageNeuronResponse(bytes);
    if (!outcome.command && outcome.errorType === undefined) {
      throw new Error(outcome.errorMessage ?? "empty command");
    }
    return outcome;
  } catch (error) {
    throw new SnsError("OUTCOME_UNKNOWN", `The SNS response could not be decoded: ${String(error).slice(0, 120)}. Check the proposal before retrying.`, { retryable: false });
  }
}

/** The backend's `#err` text, however the Kernel surfaced it. */
function describeRelayFailure(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
