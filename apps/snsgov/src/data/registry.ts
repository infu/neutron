/**
 * The cached SNS registry.
 *
 * One shared, TTL'd view of "which SNSes exist, which ones work, and what their
 * tokens are". Both the tile and the agent tools read through this, so the UI
 * and an agent can never disagree about the same question.
 *
 * Cache policy reflects how the underlying data actually changes:
 *   - the canister-id registry and liveness change on the order of weeks;
 *   - token identity (name/symbol/decimals) is effectively immutable;
 *   - supply, treasuries, proposals and neurons are volatile and are not cached
 *     here at all — callers read those directly.
 */

import type { AgentOptions } from "./agent";
import { listDeployedSnses, probeLiveness } from "./discovery";
import { pool } from "./pool";
import { fetchAggregatorRows, toEntry } from "./aggregator";
import { readCachedRegistry, writeCachedRegistry } from "./registry_cache";
import { classifyError, isInactive } from "./errors";
import { readMetadata } from "./governance";
import { readTokenInfo } from "./ledger";
import type { SnsCanisterIds, SnsLiveness, SnsMetadata, TokenInfo } from "./types";

export interface RegistryEntry {
  canisters: SnsCanisterIds;
  liveness: SnsLiveness;
  metadata?: SnsMetadata;
  token?: TokenInfo;
}

export interface Registry {
  entries: RegistryEntry[];
  byRoot: Map<string, RegistryEntry>;
  fetchedAt: number;
  /**
   * False for a provisional list built from the aggregator, whose liveness
   * flags are all placeholder. A view must not filter on liveness while this
   * is false or it will hide every SNS.
   */
  livenessKnown?: boolean;
}

const REGISTRY_TTL_MS = 10 * 60 * 1000;

let inFlight: Promise<Registry> | undefined;
let current: Registry | undefined;

/**
 * Seed the in-memory copy from the last run.
 *
 * Building the registry costs ~20s of fan-out, which a tile should not pay
 * every time it opens. The stored copy is served immediately and refreshed
 * behind the caller — see `getRegistry`.
 */
function seedFromStorage(): Registry | undefined {
  if (current) return current;
  const cached = readCachedRegistry();
  if (cached) current = cached;
  return current;
}

/**
 * The last known registry, without triggering any fetch.
 *
 * Lets a view paint rows on the first frame and then refresh behind them,
 * rather than showing a spinner for twenty seconds with a perfectly good copy
 * of yesterday's list sitting in storage.
 */
export function peekRegistry(): Registry | undefined {
  return seedFromStorage();
}

/**
 * A list to show while the real one is built.
 *
 * Only worth calling when there is no cached registry at all — the first run,
 * or after a long absence. It returns in about two seconds where the probed
 * build takes twenty, at the cost of one thing: every SNS is marked not-live,
 * because the aggregator cannot tell a wound-down DAO from a working one. So
 * `livenessKnown` is false, and a view showing this must not use it to filter.
 */
export async function getProvisionalRegistry(): Promise<Registry | undefined> {
  try {
    const rows = await fetchAggregatorRows();
    const entries = rows
      .map(toEntry)
      .filter((entry): entry is RegistryEntry => entry !== undefined);
    if (entries.length === 0) return undefined;
    return {
      entries,
      byRoot: new Map(entries.map((entry) => [entry.canisters.root, entry])),
      fetchedAt: Date.now(),
      livenessKnown: false,
    };
  } catch {
    // The aggregator is an accelerator, never a dependency.
    return undefined;
  }
}

/**
 * The registry, refreshed at most every ten minutes.
 *
 * Concurrent callers share one fetch: a tile mounting while an agent runs
 * should not double the fan-out.
 */
export async function getRegistry(
  options: AgentOptions & { force?: boolean } = {},
): Promise<Registry> {
  const seeded = options.force ? current : seedFromStorage();
  if (!options.force && seeded && Date.now() - seeded.fetchedAt < REGISTRY_TTL_MS) {
    return seeded;
  }
  if (!options.force && inFlight) return inFlight;

  inFlight = build(options).then(
    (registry) => {
      current = registry;
      inFlight = undefined;
      writeCachedRegistry(registry);
      return registry;
    },
    (error) => {
      inFlight = undefined;
      throw error;
    },
  );
  return inFlight;
}

export function invalidateRegistry(): void {
  current = undefined;
  inFlight = undefined;
}

/**
 * How many SNSes are worked on at once.
 *
 * Each one costs a liveness probe plus up to two reads, so this is roughly
 * three times as many calls in flight. Boundary nodes take that comfortably,
 * and the alternative — a low limit — leaves most lanes idle waiting on the
 * handful of SNSes whose canisters are gone and have to time out.
 */
const BUILD_CONCURRENCY = 16;

async function build(options: AgentOptions): Promise<Registry> {
  const canisters = await listDeployedSnses(options);

  // One task per SNS, probe and reads fused. Splitting them into two chunked
  // phases meant every SNS waited for the slowest probe in its chunk, and then
  // the whole list waited again at the phase boundary.
  const entries = await pool(canisters, BUILD_CONCURRENCY, async (ids): Promise<RegistryEntry> => {
    const live = await probeLiveness(ids, options);
    const entry: RegistryEntry = { canisters: ids, liveness: live };
    // Read only what is alive. A dead governance canister still leaves a
    // usable ledger in 6-7 cases, and the token data is worth showing.
    const [metadata, token] = await Promise.all([
      live.governance ? safe(() => readMetadata(ids.governance, options)) : undefined,
      live.ledger ? safe(() => readTokenInfo(ids.ledger, options)) : undefined,
    ]);
    if (metadata) entry.metadata = metadata;
    if (token) entry.token = token;
    return entry;
  });

  return {
    entries,
    byRoot: new Map(entries.map((entry) => [entry.canisters.root, entry])),
    fetchedAt: Date.now(),
    livenessKnown: true,
  };
}

async function safe<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    // A per-SNS failure never fails the registry. Structurally dead SNSes are
    // expected; transient ones will resolve on the next refresh.
    if (!isInactive(classifyError(error))) {
      // Kept deliberately quiet: this is a normal partial outcome, and the
      // caller sees it through `liveness`.
    }
    return undefined;
  }
}

/** Look up one entry, refreshing the registry if it is not present. */
export async function requireEntry(
  rootCanisterId: string,
  options: AgentOptions = {},
): Promise<RegistryEntry> {
  let registry = await getRegistry(options);
  let entry = registry.byRoot.get(rootCanisterId);
  if (!entry) {
    registry = await getRegistry({ ...options, force: true });
    entry = registry.byRoot.get(rootCanisterId);
  }
  if (!entry) {
    throw classifyError(new Error(`no SNS registered with root ${rootCanisterId}`), {
      sns: rootCanisterId,
    });
  }
  return entry;
}

/** Human-facing label: project name, else token symbol, else the root id. */
export function displayName(entry: RegistryEntry): string {
  return entry.metadata?.name ?? entry.token?.symbol ?? entry.canisters.root;
}

/** True when the SNS can answer governance questions at all. */
export function isGovernanceLive(entry: RegistryEntry): boolean {
  return entry.liveness.governance;
}
