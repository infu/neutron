/**
 * Browser-side merge of the ordinary per-SNS proposal reads.
 *
 * A continuation keeps both the next upstream cursor and every unread proposal
 * from each source. Keeping just the upstream cursors would lose the fetched
 * proposals that did not fit in the merged page.
 */
import { classifyError, SnsError } from "./errors";
import { MAX_PROPOSALS_PER_CALL, type ProposalPage } from "./governance";
import type { PartialResult, ProposalSummary } from "./types";
import type { AgentOptions } from "./agent";
import { listDeployedSnses } from "./discovery";
import { peekRegistry, type Registry } from "./registry";
import { pool } from "./pool";

/** Feed identities need one SNS-W query, without unrelated canister probes or ledger reads. */
export async function getFeedRegistry(options: AgentOptions = {}): Promise<Registry> {
  const cached = peekRegistry();
  const canisters = await listDeployedSnses(options);
  const entries = canisters.map((ids) => ({
    ...cached?.byRoot.get(ids.root), canisters: ids,
    // A cached failed probe is not proof that today's proposal query will fail.
    liveness: cached?.byRoot.get(ids.root)?.liveness ?? { governance: false, ledger: false },
  }));
  return { entries, byRoot: new Map(entries.map((entry) => [entry.canisters.root, entry])), fetchedAt: Date.now(), livenessKnown: false };
}

export interface FeedProposal {
  /** SNS root canister id. */
  sns: string;
  proposal: ProposalSummary;
}

export interface ProposalFeedPage {
  proposals: FeedProposal[];
  /** Opaque, JSON-serializable continuation for the same set of SNS roots. */
  nextCursor?: string;
  failures: PartialResult<never>["failures"];
}

/** The service or tile supplies its existing browser proposal reader. */
export type ProposalFeedReader = (params: {
  sns: string;
  limit: number;
  beforeProposal?: bigint;
}) => Promise<ProposalPage>;

interface FeedSource {
  sns: string;
  beforeProposal?: bigint;
  exhausted: boolean;
  buffer: ProposalSummary[];
}

interface FeedCursor {
  version: 1;
  sources: FeedSource[];
}

/** Newest first; ties use root text ascending, then proposal id descending. */
export function compareFeedProposals(a: FeedProposal, b: FeedProposal): number {
  if (a.proposal.createdAtSeconds !== b.proposal.createdAtSeconds) {
    return a.proposal.createdAtSeconds > b.proposal.createdAtSeconds ? -1 : 1;
  }
  if (a.sns !== b.sns) return a.sns < b.sns ? -1 : 1;
  if (a.proposal.id === b.proposal.id) return 0;
  return a.proposal.id > b.proposal.id ? -1 : 1;
}

/**
 * Merge descending proposal streams without limiting how far they can be read.
 * SNS governance returns ids newest first, in creation order. `limit` controls
 * this result page; an individual upstream request uses governance's own cap.
 *
 * A failed source is retried from the same position on the next call while
 * available sources continue. Every page is sorted, but recovered sources can
 * contribute newer proposals than a previous partial page. Callers accumulating
 * pages should sort the combined rows with `compareFeedProposals` and display
 * `failures`, rather than treating a partial result as a complete time window.
 */
export async function loadProposalFeedPage(
  params: { sns: readonly string[]; limit?: number; cursor?: string },
  readPage: ProposalFeedReader,
): Promise<ProposalFeedPage> {
  const limit = params.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new SnsError("INVALID_REQUEST", "proposal feed limit must be a positive integer");
  }
  const sns = [...new Set(params.sns)].sort();
  const cursor: FeedCursor = params.cursor === undefined
    ? { version: 1, sources: sns.map((root) => ({ sns: root, exhausted: false, buffer: [] })) }
    : parseCursor(params.cursor, sns);
  const failures: ProposalFeedPage["failures"] = [];
  const failed = new Set<string>();
  const proposals: FeedProposal[] = [];
  const upstreamLimit = Math.min(limit, MAX_PROPOSALS_PER_CALL);

  while (proposals.length < limit) {
    // All streams need a head before selecting the next row. Refill only the
    // consumed streams, leaving the others' fetched rows in their buffers.
    const pending = cursor.sources.filter(
      (source) => !source.exhausted && source.buffer.length === 0 && !failed.has(source.sns),
    );
    // Use the registry's existing worker width; every selected source is read.
    const results = await pool(pending, 16, async (source): Promise<PromiseSettledResult<ProposalPage>> => {
      try {
      const page = await readPage({
        sns: source.sns,
        limit: upstreamLimit,
        ...(source.beforeProposal === undefined ? {} : { beforeProposal: source.beforeProposal }),
      });
      if (page.nextBefore !== undefined && (
        page.proposals.length === 0 ||
        (source.beforeProposal !== undefined && page.nextBefore >= source.beforeProposal)
      )) {
        throw new SnsError("INTERNAL", "proposal page did not advance its continuation");
      }
        return { status: "fulfilled", value: page };
      } catch (reason) { return { status: "rejected", reason }; }
    });
    for (let index = 0; index < results.length; index += 1) {
      const source = pending[index]!;
      const result = results[index]!;
      if (result.status === "rejected") {
        const error = classifyError(result.reason, { sns: source.sns, role: "governance" });
        failures.push({ scope: source.sns, code: error.code, message: error.message });
        failed.add(source.sns);
        continue;
      }
      source.buffer = [...result.value.proposals].sort((a, b) => compareFeedProposals(
        { sns: source.sns, proposal: a }, { sns: source.sns, proposal: b },
      ));
      source.exhausted = result.value.nextBefore === undefined;
      if (result.value.nextBefore === undefined) delete source.beforeProposal;
      else source.beforeProposal = result.value.nextBefore;
    }

    let selected: FeedSource | undefined;
    for (const source of cursor.sources) {
      if (source.buffer.length === 0) continue;
      if (selected === undefined || compareFeedProposals(
        { sns: source.sns, proposal: source.buffer[0]! },
        { sns: selected.sns, proposal: selected.buffer[0]! },
      ) < 0) selected = source;
    }
    if (selected === undefined) break;
    proposals.push({ sns: selected.sns, proposal: selected.buffer.shift()! });
  }

  const page: ProposalFeedPage = { proposals, failures };
  if (cursor.sources.some((source) => !source.exhausted || source.buffer.length > 0)) {
    page.nextCursor = JSON.stringify(cursor, (_key, value: unknown) =>
      typeof value === "bigint" ? { $bigint: value.toString() } : value,
    );
  }
  return page;
}

function parseCursor(value: string, sns: string[]): FeedCursor {
  try {
    const cursor = JSON.parse(value, (_key, item: unknown) => {
      if (item !== null && typeof item === "object" && "$bigint" in item) {
        if (typeof item.$bigint !== "string" || !/^\d+$/.test(item.$bigint)) throw new Error();
        return BigInt(item.$bigint);
      }
      return item;
    }) as FeedCursor;
    if (cursor.version !== 1 || !Array.isArray(cursor.sources) || cursor.sources.length !== sns.length) {
      throw new Error();
    }
    for (const [index, source] of cursor.sources.entries()) {
      if (source.sns !== sns[index] || typeof source.exhausted !== "boolean" ||
        (source.beforeProposal !== undefined && typeof source.beforeProposal !== "bigint") ||
        !Array.isArray(source.buffer) || source.buffer.some((proposal) =>
          proposal === null || typeof proposal !== "object" ||
          typeof proposal.id !== "bigint" || typeof proposal.createdAtSeconds !== "bigint",
        )) throw new Error();
    }
    return cursor;
  } catch {
    throw new SnsError("INVALID_REQUEST", "invalid proposal feed cursor for this SNS selection");
  }
}
