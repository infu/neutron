/**
 * The SNS aggregator: a fast first paint, and nothing more.
 *
 * DFINITY runs a canister that polls SNS-W and every SNS and serves the result
 * as certified static JSON over plain HTTP. Measured against mainnet it returns
 * all 54 SNSes in **2.1 seconds**, where building the same list through the
 * agent takes about twenty — almost all of it the per-canister liveness probe,
 * which does not get faster with more concurrency.
 *
 * Two things it must not be used for, both measured rather than assumed:
 *
 *   Liveness. It keeps serving the last good snapshot for SNSes whose canisters
 *   are gone. Of the 16 SNSes whose governance canister has no Wasm installed —
 *   Catalyze, SONIC, Modclub, Juno Build among them — 15 still carry complete
 *   metadata, parameters, and supply here. There is no field that distinguishes
 *   them, so liveness always comes from a real probe.
 *
 *   Volatile figures. A full refresh cycle is one SNS per two-minute tick, so
 *   roughly 110 minutes end to end. Fine for a name; useless for a treasury.
 *
 * So this fills the list while the real build runs behind it, and every value
 * it produces is replaced by a probed one moments later.
 */

import type { SnsCanisterIds } from "./types";
import type { RegistryEntry } from "./registry";

const BASE = "https://3r4gx-wqaaa-aaaaq-aaaia-cai.icp0.io/v1/sns/list/page";

/** Entries per page, fixed by the aggregator's own paging. */
const PAGE_SIZE = 10;
/** Enough for ~200 SNSes. The list is 54 today; paging stops at the first gap. */
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 8_000;

interface AggregatorRow {
  canister_ids?: {
    root_canister_id?: string;
    governance_canister_id?: string;
    ledger_canister_id?: string;
    swap_canister_id?: string;
    index_canister_id?: string;
  };
  meta?: { name?: string; description?: string; url?: string };
  icrc1_metadata?: [string, Record<string, unknown>][];
  icrc1_fee?: number | string | unknown[];
}

/**
 * Fetch every page at once.
 *
 * The end of the list is an HTTP **503**, not a 404 and not an empty array: the
 * aggregator's own 404 body is not covered by its certified asset tree, so the
 * boundary node rejects it and surfaces 503 instead. Anything other than 200 is
 * therefore just "no page here".
 */
export async function fetchAggregatorRows(signal?: AbortSignal): Promise<AggregatorRow[]> {
  const pages = await Promise.all(
    Array.from({ length: MAX_PAGES }, async (_unused, index) => {
      try {
        const response = await fetch(`${BASE}/${index}/slow.json`, {
          signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status !== 200) return [];
        const rows: unknown = await response.json();
        return Array.isArray(rows) ? (rows as AggregatorRow[]) : [];
      } catch {
        // One bad page must not lose the other fifty entries.
        return [];
      }
    }),
  );

  // Stop at the first gap: a short page is the last one, and anything after a
  // missing page cannot be trusted to be contiguous.
  const out: AggregatorRow[] = [];
  for (const page of pages) {
    if (page.length === 0) break;
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

function text(metadata: AggregatorRow["icrc1_metadata"], key: string): string | undefined {
  const found = metadata?.find(([name]) => name === key)?.[1];
  const value = (found as { Text?: unknown } | undefined)?.Text;
  return typeof value === "string" ? value : undefined;
}

/**
 * An ICRC metadata `Nat`.
 *
 * Encoded as `{"Nat": [limbs]}` — a big integer as an array. Only single-limb
 * values are decoded, which covers every field read here (decimals, fee); a
 * multi-limb value would need the aggregator's limb order and base, neither of
 * which is documented, and guessing at a token fee is not worth it.
 */
function nat(metadata: AggregatorRow["icrc1_metadata"], key: string): bigint | undefined {
  const found = metadata?.find(([name]) => name === key)?.[1];
  const value = (found as { Nat?: unknown } | undefined)?.Nat;
  if (Array.isArray(value) && value.length === 1) return whole(value[0]);
  return whole(value);
}

/** A non-negative integer, however the aggregator happened to encode it. */
function whole(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (value && typeof value === "object" && "e8s" in (value as Record<string, unknown>)) {
    return whole((value as { e8s: unknown }).e8s);
  }
  return undefined;
}

function principal(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/.test(value)
    ? value
    : undefined;
}

/**
 * Project one aggregator row onto a registry entry.
 *
 * Returns undefined for a row without a complete canister set: half an SNS is
 * worse than none, because everything downstream keys on these ids.
 */
export function toEntry(row: AggregatorRow): RegistryEntry | undefined {
  const ids = row.canister_ids ?? {};
  const root = principal(ids.root_canister_id);
  const governance = principal(ids.governance_canister_id);
  const ledger = principal(ids.ledger_canister_id);
  if (!root || !governance || !ledger) return undefined;

  const canisters: SnsCanisterIds = {
    root,
    governance,
    ledger,
    swap: principal(ids.swap_canister_id) ?? null,
    index: principal(ids.index_canister_id) ?? null,
  };

  // Liveness is deliberately false here and corrected by the probe. Claiming
  // "alive" would show sixteen wound-down DAOs as active.
  const entry: RegistryEntry = { canisters, liveness: { governance: false, ledger: false } };

  const name = row.meta?.name;
  const description = row.meta?.description;
  const url = row.meta?.url;
  if (name !== undefined || description !== undefined || url !== undefined) {
    entry.metadata = {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(url === undefined ? {} : { url }),
    };
  }

  const symbol = text(row.icrc1_metadata, "icrc1:symbol");
  const decimals = nat(row.icrc1_metadata, "icrc1:decimals");
  // `icrc1_fee` is `[n]` at the top level; the metadata copy is `{"Nat":[n]}`.
  const fee =
    (Array.isArray(row.icrc1_fee) ? whole(row.icrc1_fee[0]) : whole(row.icrc1_fee)) ??
    nat(row.icrc1_metadata, "icrc1:fee");
  if (symbol !== undefined && decimals !== undefined && fee !== undefined) {
    // No `totalSupply`: see TokenInfo. The aggregator's copy is a JSON number
    // that has already lost digits for most SNSes.
    entry.token = {
      name: text(row.icrc1_metadata, "icrc1:name") ?? symbol,
      symbol,
      decimals: Number(decimals),
      fee,
    };
  }

  // The logo here is a real `data:` URI, unlike `meta.logo` which is a URL on
  // the aggregator — so it renders without contacting anyone.
  const logo = text(row.icrc1_metadata, "icrc1:logo");
  if (logo?.startsWith("data:image/")) {
    entry.metadata = { ...(entry.metadata ?? {}), logo };
  }

  return entry;
}
