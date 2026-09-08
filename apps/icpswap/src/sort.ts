// Market table ordering.
//
// Kept out of the view so it can be tested directly, and written against the
// shape of a merged row rather than the concrete backend and REST types.

/** Column identities the market table can order by. */
export type SortColumnKey =
  | "symbol"
  | "price"
  | "change24h"
  | "volume24h"
  | "volume7d"
  | "tvl"
  | "marketCap"
  | "pools"
  | "added";

/** The parts of a merged row that ordering actually reads. */
export type SortableRow = {
  row: {
    symbol: string;
    pinned: boolean;
    priceUsd: number;
    poolCount: number;
    addedAt: number;
  };
  live:
    | {
        price: number;
        priceChange24H: number;
        volumeUSD24H: number;
        volumeUSD7D: number;
        tvlUSD: number;
      }
    | undefined;
  rank: { marketCap: number } | undefined;
};

/**
 * The sortable figure behind a column, or `null` when this token has none.
 *
 * The distinction matters. ICPSwap ranks only about 105 of its ~1,240 tokens,
 * and around 1,140 of them record no volume on a given day, so most watchlists
 * hold tokens with genuinely absent figures. Reporting those as zero made them
 * tie with one another, and an alphabetical tie-break then ordered the whole
 * table — which reads as "the sort is alphabetical". A real zero (a listed
 * token that simply did not trade today) still sorts as zero.
 */
export function sortValue(entry: SortableRow, key: SortColumnKey): number | null {
  switch (key) {
    case "price": {
      const price = entry.live?.price ?? entry.row.priceUsd;
      return price > 0 ? price : null;
    }
    case "change24h":
      return entry.live ? entry.live.priceChange24H : null;
    case "volume24h":
      return entry.live ? entry.live.volumeUSD24H : null;
    case "volume7d":
      return entry.live ? entry.live.volumeUSD7D : null;
    case "tvl":
      return entry.live ? entry.live.tvlUSD : null;
    case "marketCap":
      return entry.rank ? entry.rank.marketCap : null;
    case "pools":
      return entry.row.poolCount;
    case "added":
      return entry.row.addedAt;
    default:
      return null;
  }
}

/**
 * Applied in order when the chosen column ties, so a block of tokens reporting
 * the same figure still lands in a useful order instead of A-Z.
 */
const TIE_BREAK: ReadonlyArray<SortColumnKey> = [
  "volume24h",
  "tvl",
  "marketCap",
  "pools",
];

/** Descending by value, with unknowns last. */
export function compareValues(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  if (left === right) return 0;
  return right - left;
}

/**
 * Order merged rows.
 *
 * Pinned rows stay on top so the table never reshuffles a pinned token out of
 * view. A token with no figure for the chosen column sorts last whichever way
 * the arrow points, because floating unknowns to the top on a reverse sort is
 * never what the reader wanted. Remaining ties break by significance, always in
 * the same direction, so reversing the sort does not also reshuffle the rows
 * that the chosen column could not separate.
 */
export function sortMerged<T extends SortableRow>(
  entries: readonly T[],
  key: SortColumnKey,
  ascending: boolean,
): T[] {
  const sorted = [...entries];
  sorted.sort((left, right) => {
    if (left.row.pinned !== right.row.pinned) return left.row.pinned ? -1 : 1;

    if (key === "symbol") {
      const byName = left.row.symbol.localeCompare(right.row.symbol, "en");
      if (byName !== 0) return ascending ? byName : -byName;
    } else {
      const leftValue = sortValue(left, key);
      const rightValue = sortValue(right, key);
      if (leftValue === null || rightValue === null) {
        const missing = compareValues(leftValue, rightValue);
        if (missing !== 0) return missing;
      } else {
        const comparison = compareValues(leftValue, rightValue);
        if (comparison !== 0) return ascending ? -comparison : comparison;
      }
    }

    for (const fallback of TIE_BREAK) {
      if (fallback === key) continue;
      const comparison = compareValues(
        sortValue(left, fallback),
        sortValue(right, fallback),
      );
      if (comparison !== 0) return comparison;
    }
    return left.row.symbol.localeCompare(right.row.symbol, "en");
  });
  return sorted;
}
