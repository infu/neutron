/**
 * Browser-side merge of the ordinary per-SNS proposal reads.
 *
 * A continuation keeps both the next upstream cursor and every unread proposal
 * from each source. Keeping just the upstream cursors would lose the fetched
 * proposals that did not fit in the merged page.
 */
import { classifyError, isInactive, SnsError } from "./errors";
import { MAX_PROPOSALS_PER_CALL, type ProposalPage } from "./governance";
import type { PartialResult, ProposalSummary, SnsCanisterIds } from "./types";
import type { AgentOptions } from "./agent";
import { listDeployedSnses } from "./discovery";
import { peekRegistry, type Registry } from "./registry";
import { pool } from "./pool";

export interface FeedRegistry extends Registry {
  /** Positive governance observations only; entries still contains every discovery candidate. */
  availableRoots: string[];
}

interface AvailabilityObservation { governance: string; active: boolean }
interface AvailabilityCache {
  key: string;
  observations: Map<string, AvailabilityObservation>;
}
const availabilityCaches = new WeakMap<FeedRegistry, AvailabilityCache>();

/** Feed identities need one SNS-W query, without unrelated canister probes or ledger reads. */
export async function getFeedRegistry(options: AgentOptions = {}): Promise<FeedRegistry> {
  const cached = peekRegistry();
  const canisters = await listDeployedSnses(options);
  return projectFeedRegistry(canisters, cached, options);
}

/** Apply browser observations only to the current authoritative SNS-W identities. */
export function projectFeedRegistry(canisters: SnsCanisterIds[], cached?: Registry, options: AgentOptions = {}): FeedRegistry {
  const host = options.host ?? (typeof window !== "undefined" ? window.location.origin : "https://icp-api.io");
  const key = `snsgov.feed-availability.v1:${host}`;
  const observations = readAvailabilityCache(key);
  const entries = canisters.map((ids) => ({
    ...cached?.byRoot.get(ids.root), canisters: ids,
    // An old timeout is not a confirmed unavailable canister. Only positive
    // cached liveness may seed the selector until proposal queries complete.
    liveness: cached?.byRoot.get(ids.root)?.liveness ?? { governance: false, ledger: false },
  }));
  const availableRoots = entries.filter((entry) => {
    const observation = observations.get(entry.canisters.root);
    if (observation?.governance === entry.canisters.governance) return observation.active;
    const previous = cached?.byRoot.get(entry.canisters.root);
    return cached?.livenessKnown !== false && previous?.canisters.governance === entry.canisters.governance && previous.liveness.governance;
  }).map((entry) => entry.canisters.root);
  const registry: FeedRegistry = { entries, byRoot: new Map(entries.map((entry) => [entry.canisters.root, entry])), fetchedAt: Date.now(), livenessKnown: false, availableRoots };
  availabilityCaches.set(registry, { key, observations });
  return registry;
}

function readAvailabilityCache(key: string): Map<string, AvailabilityObservation> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return new Map();
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return new Map();
    const observations = new Map<string, AvailabilityObservation>();
    for (const row of rows) {
      if (row !== null && typeof row === "object" && typeof row.root === "string" && typeof row.governance === "string" && typeof row.active === "boolean") {
        observations.set(row.root, { governance: row.governance, active: row.active });
      }
    }
    return observations;
  } catch { return new Map(); }
}

function recordAvailability(registry: FeedRegistry | undefined, root: string, active: boolean): void {
  if (!registry) return;
  const cache = availabilityCaches.get(registry);
  const entry = registry.byRoot.get(root);
  if (!cache || !entry) return;
  cache.observations = new Map([...cache.observations, ...readAvailabilityCache(cache.key)]);
  const previous = cache.observations.get(root);
  if (previous?.governance === entry.canisters.governance && previous.active === active) return;
  cache.observations.set(root, { governance: entry.canisters.governance, active });
  // Keep observations only for identities in this registry. This cache neither
  // removes discovery candidates nor blocks a fresh query after recovery.
  const rows = [...cache.observations].flatMap(([sns, observation]) => registry.byRoot.get(sns)?.canisters.governance === observation.governance
    ? [{ root: sns, ...observation }] : []);
  try { globalThis.localStorage?.setItem(cache.key, JSON.stringify(rows)); }
  catch { /* Availability remains usable when sandbox storage is unavailable. */ }
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
  /** Confirmed inactive sources are excluded from routine feed coverage warnings. */
  unavailable?: PartialResult<never>["failures"];
  /** Successful proposal reads, including communities with no proposals. */
  activeSns?: string[];
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
  available?: boolean;
  unavailable?: PartialResult<never>["failures"][number];
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
 * A transiently failed source is retried from the same position on the next
 * call. Confirmed inactive sources are skipped during pagination and retried
 * on a fresh no-cursor read, such as Refresh. Every page is sorted, but recovered sources can
 * contribute newer proposals than a previous partial page. Callers accumulating
 * pages should sort the combined rows with `compareFeedProposals` and display
 * `failures`, rather than treating a partial result as a complete time window.
 */
export async function loadProposalFeedPage(
  params: { sns: readonly string[]; limit?: number; cursor?: string; registry?: FeedRegistry },
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
      (source) => !source.exhausted && !source.unavailable && source.buffer.length === 0 && !failed.has(source.sns),
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
        const failure = { scope: source.sns, code: error.code, message: error.message };
        if (isInactive(error)) {
          source.unavailable = failure;
          delete source.available;
          recordAvailability(params.registry, source.sns, false);
        } else failures.push(failure);
        failed.add(source.sns);
        continue;
      }
      source.available = true;
      recordAvailability(params.registry, source.sns, true);
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
  const activeSns = cursor.sources.filter((source) => source.available && !source.unavailable).map((source) => source.sns);
  const unavailable = cursor.sources.flatMap((source) => source.unavailable ? [source.unavailable] : []);
  if (activeSns.length) page.activeSns = activeSns;
  if (unavailable.length) page.unavailable = unavailable;
  if (cursor.sources.some((source) => (!source.exhausted && !source.unavailable) || source.buffer.length > 0)) {
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
        (source.available !== undefined && typeof source.available !== "boolean") ||
        (source.unavailable !== undefined && (source.unavailable === null || typeof source.unavailable !== "object" || source.unavailable.scope !== source.sns || typeof source.unavailable.code !== "string" || typeof source.unavailable.message !== "string")) ||
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
