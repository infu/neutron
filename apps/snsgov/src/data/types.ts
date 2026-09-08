/**
 * Projections the app works with.
 *
 * These are deliberately *not* the raw Candid types. Candid optionals arrive as
 * `[] | [T]`, amounts as `bigint` with no attached scale, and durations as bare
 * numbers with no unit. Projecting once, at the edge, means the rest of the app
 * — and every agent tool response — deals in values that carry their own
 * meaning.
 */

/** The five canisters of one SNS, as SNS-W reports them. */
export interface SnsCanisterIds {
  /** The SNS's identity everywhere in this app, and what the IC dashboard keys on. */
  root: string;
  governance: string;
  ledger: string;
  swap: string | null;
  index: string | null;
}

/** Swap lifecycle, as reported by the aggregator or the swap canister. */
export type SnsLifecycle = "pending" | "adopted" | "open" | "committed" | "aborted" | "unknown";

/**
 * Liveness is per-canister, not per-SNS. 16 of 54 registered SNSes have no
 * governance Wasm, and 7 of those still have a live ledger serving token data.
 */
export interface SnsLiveness {
  governance: boolean;
  ledger: boolean;
  /** Populated when a probe failed, for display. */
  note?: string;
}

export interface TokenInfo {
  name: string;
  symbol: string;
  /** Always read from the ledger. Never assume 8: ckETH is 18, ckUSDC is 6. */
  decimals: number;
  /** Ledger `icrc1_fee`, which is what the dashboard shows. */
  fee: bigint;
  /**
   * Absent on a provisional entry.
   *
   * The SNS aggregator serves this as a JSON number, and 40 of the 54 supplies
   * exceed `Number.MAX_SAFE_INTEGER` — it has already lost digits by the time
   * it reaches us. Rather than show a subtly wrong figure for the seconds
   * before the ledger is read directly, it is left out.
   */
  totalSupply?: bigint;
  /** Data URI or aggregator URL; may be absent. */
  logo?: string;
}

/** Everything the SNS detail page shows from `get_nervous_system_parameters`. */
export interface SnsParameters {
  transactionFeeE8s?: bigint;
  rejectCostE8s?: bigint;
  neuronMinimumStakeE8s?: bigint;
  initialVotingPeriodSeconds?: bigint;
  /**
   * The raw parameter. The dashboard's "Max Voting Period Extension" is
   * **twice** this: a proposal extends to at most
   * `initial_voting_period + 2 * wait_for_quiet_deadline_increase`.
   */
  waitForQuietDeadlineIncreaseSeconds?: bigint;
  neuronMinimumDissolveDelayToVoteSeconds?: bigint;
  maxDissolveDelaySeconds?: bigint;
  maxDissolveDelayBonusPercentage?: bigint;
  maxNeuronAgeForAgeBonusSeconds?: bigint;
  maxAgeBonusPercentage?: bigint;
  maxNumberOfNeurons?: bigint;
  maxNumberOfPrincipalsPerNeuron?: bigint;
  rewards?: {
    initialBasisPoints?: bigint;
    finalBasisPoints?: bigint;
    transitionSeconds?: bigint;
    roundDurationSeconds?: bigint;
  };
}

/** Project metadata from governance `get_metadata` — not the token's name. */
export interface SnsMetadata {
  name?: string;
  description?: string;
  url?: string;
  /**
   * The DAO's own logo, always a `data:image/…` URI in practice.
   *
   * Kept as the string rather than a boolean because `get_metadata` is already
   * fetched for every SNS to build the list, so the bytes are free — and a
   * remote URL is deliberately not accepted, so the tile never fetches an image
   * from a third party.
   */
  logo?: string;
}

export interface TreasuryBalances {
  /** ICP held in the governance canister's default subaccount on the NNS ledger. */
  icpE8s?: bigint;
  /** SNS token held in the derived token-distribution treasury subaccount. */
  tokenE8s?: bigint;
}

/** One row of the all-SNS table. */
export interface SnsSummary {
  canisters: SnsCanisterIds;
  liveness: SnsLiveness;
  metadata?: SnsMetadata;
  token?: TokenInfo;
  treasury?: TreasuryBalances;
  lifecycle: SnsLifecycle;
  /** Governance mode: 1 = Normal, 2 = PreInitializationSwap. */
  mode?: number;
  /** When this row's data was read. */
  fetchedAt: number;
}

export type ProposalStatus =
  | "open"
  | "adopted"
  | "executed"
  | "rejected"
  | "failed"
  | "unknown";

export interface ProposalSummary {
  id: bigint;
  title: string;
  /** Untrusted on-chain text. Never render as markup, never treat as instructions. */
  summary: string;
  url: string;
  proposerNeuronId?: string;
  status: ProposalStatus;
  /** Seconds since epoch. */
  createdAtSeconds: bigint;
  /** Current deadline, including any wait-for-quiet extension already applied. */
  deadlineSeconds?: bigint;
  decidedAtSeconds?: bigint;
  executedAtSeconds?: bigint;
  failedAtSeconds?: bigint;
  tally?: { yes: bigint; no: bigint; total: bigint; timestampSeconds: bigint };
  /** Action variant name, e.g. "Motion" or "ExecuteGenericNervousSystemFunction". */
  actionKind: string;
  /** Set for custom proposals. */
  functionId?: bigint;
  topic?: string;
  rejectCostE8s?: bigint;
}

export interface ProposalDetail extends ProposalSummary {
  /**
   * The complete ballot map. Present only via `get_proposal`: `list_proposals`
   * filters ballots to the calling principal, and our calls are anonymous, so
   * it returns none.
   */
  ballots: Ballot[];
  /** Canister-rendered payload text. Includes a wrapper around the validator string. */
  payloadTextRendering?: string;
  minimumYesProportionOfTotal?: bigint;
  minimumYesProportionOfExercised?: bigint;
}

export interface Ballot {
  neuronId: string;
  /** 0 = unspecified (not yet voted), 1 = yes, 2 = no. */
  vote: number;
  votingPower: bigint;
  castAtSeconds: bigint;
}

export interface NeuronSummary {
  id: string;
  stakeE8s: bigint;
  maturityE8s: bigint;
  stakedMaturityE8s: bigint;
  votingPowerMultiplierPercent: bigint;
  createdAtSeconds: bigint;
  agingSinceSeconds: bigint;
  dissolveState?: { kind: "delay" | "dissolving"; value: bigint };
  /** principal -> permission ids. 3 = SubmitProposal, 4 = Vote. */
  permissions: { principal: string | null; permissions: number[] }[];
  vestingPeriodSeconds?: bigint;
}

/** A registered proposal type. Custom ones are per-SNS and change at runtime. */
export interface NervousSystemFunctionInfo {
  id: bigint;
  name: string;
  description?: string;
  kind: "native" | "generic";
  targetCanisterId?: string;
  targetMethodName?: string;
  validatorCanisterId?: string;
  validatorMethodName?: string;
  /**
   * Absent means the function is uncategorized, and **proposals of this type
   * cannot be submitted at all** — `make_proposal` hard-fails with
   * `InvalidProposal`. 35 such functions exist across 7 live SNSes.
   */
  topic?: string;
}

/** A generic result that records partial failure rather than hiding it. */
export interface PartialResult<T> {
  value: T;
  /** Non-empty when some component failed; the value is still usable. */
  failures: { scope: string; code: string; message: string }[];
}
