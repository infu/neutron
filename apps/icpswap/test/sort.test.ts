import { describe, expect, test } from "bun:test";
import { compareValues, sortMerged, sortValue, type SortableRow } from "../src/sort.ts";

type Live = NonNullable<SortableRow["live"]>;

function live(overrides: Partial<Live> = {}): Live {
  return {
    price: 1,
    priceChange24H: 0,
    volumeUSD24H: 0,
    volumeUSD7D: 0,
    tvlUSD: 0,
    ...overrides,
  };
}

function entry(
  symbol: string,
  options: {
    live?: Live | undefined;
    marketCap?: number;
    pinned?: boolean;
    poolCount?: number;
    priceUsd?: number;
    addedAt?: number;
  } = {},
): SortableRow {
  return {
    row: {
      symbol,
      pinned: options.pinned ?? false,
      priceUsd: options.priceUsd ?? 0,
      poolCount: options.poolCount ?? 0,
      addedAt: options.addedAt ?? 0,
    },
    live: options.live,
    rank:
      options.marketCap === undefined ? undefined : { marketCap: options.marketCap },
  };
}

const symbols = (rows: SortableRow[]) => rows.map((row) => row.row.symbol);

describe("sortValue", () => {
  test("separates an absent figure from a real zero", () => {
    expect(sortValue(entry("A"), "volume24h")).toBeNull();
    expect(sortValue(entry("A", { live: live() }), "volume24h")).toBe(0);
  });

  test("reports no market cap for the tokens ICPSwap does not rank", () => {
    expect(sortValue(entry("A", { live: live() }), "marketCap")).toBeNull();
    expect(sortValue(entry("A", { marketCap: 5 }), "marketCap")).toBe(5);
  });

  test("falls back to the on-chain price, and reports none at zero", () => {
    expect(sortValue(entry("A", { priceUsd: 2.5 }), "price")).toBe(2.5);
    expect(sortValue(entry("A"), "price")).toBeNull();
  });

  test("treats an empty pool count as a real zero, not as missing", () => {
    expect(sortValue(entry("A"), "pools")).toBe(0);
  });
});

describe("compareValues", () => {
  test("orders descending", () => {
    expect(compareValues(1, 2)).toBeGreaterThan(0);
    expect(compareValues(2, 1)).toBeLessThan(0);
    expect(compareValues(2, 2)).toBe(0);
  });

  test("puts an unknown value last", () => {
    expect(compareValues(null, 0)).toBeGreaterThan(0);
    expect(compareValues(0, null)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
  });
});

describe("sortMerged", () => {
  test("orders numerically, not by name", () => {
    // The regression this guards: 9K must beat 80 even though "A" < "Z".
    const rows = [
      entry("AAA", { live: live({ volumeUSD24H: 80 }) }),
      entry("ZZZ", { live: live({ volumeUSD24H: 9000 }) }),
      entry("MMM", { live: live({ volumeUSD24H: 400 }) }),
    ];
    expect(symbols(sortMerged(rows, "volume24h", false))).toEqual([
      "ZZZ",
      "MMM",
      "AAA",
    ]);
    expect(symbols(sortMerged(rows, "volume24h", true))).toEqual([
      "AAA",
      "MMM",
      "ZZZ",
    ]);
  });

  test("keeps tokens with no figure at the bottom in both directions", () => {
    const rows = [
      entry("NONE"),
      entry("BIG", { live: live({ volumeUSD24H: 500 }) }),
      entry("SMALL", { live: live({ volumeUSD24H: 5 }) }),
    ];
    expect(symbols(sortMerged(rows, "volume24h", false))).toEqual([
      "BIG",
      "SMALL",
      "NONE",
    ]);
    expect(symbols(sortMerged(rows, "volume24h", true))).toEqual([
      "SMALL",
      "BIG",
      "NONE",
    ]);
  });

  test("breaks a tie by significance rather than alphabetically", () => {
    // Most ICPSwap tokens record no market cap at all; those rows must still
    // land in a useful order instead of running A-Z.
    const rows = [
      entry("AAA", { live: live({ volumeUSD24H: 1, tvlUSD: 10 }) }),
      entry("BBB", { live: live({ volumeUSD24H: 900, tvlUSD: 10 }) }),
      entry("CCC", { live: live({ volumeUSD24H: 50, tvlUSD: 10 }) }),
    ];
    expect(symbols(sortMerged(rows, "marketCap", false))).toEqual([
      "BBB",
      "CCC",
      "AAA",
    ]);
  });

  test("does not reshuffle tied rows when the direction flips", () => {
    const rows = [
      entry("AAA", { live: live({ volumeUSD24H: 5 }) }),
      entry("BBB", { live: live({ volumeUSD24H: 90 }) }),
    ];
    expect(symbols(sortMerged(rows, "marketCap", false))).toEqual(
      symbols(sortMerged(rows, "marketCap", true)),
    );
  });

  test("falls back to the symbol only when nothing else separates rows", () => {
    const rows = [entry("ZZZ"), entry("AAA")];
    expect(symbols(sortMerged(rows, "marketCap", false))).toEqual(["AAA", "ZZZ"]);
  });

  test("keeps pinned rows on top whatever the column and direction", () => {
    const rows = [
      entry("BIG", { live: live({ volumeUSD24H: 10_000 }) }),
      entry("PIN", { live: live({ volumeUSD24H: 1 }), pinned: true }),
    ];
    expect(symbols(sortMerged(rows, "volume24h", false))[0]).toBe("PIN");
    expect(symbols(sortMerged(rows, "volume24h", true))[0]).toBe("PIN");
  });

  test("sorts names A-Z ascending and Z-A descending", () => {
    const rows = [entry("MMM"), entry("AAA"), entry("ZZZ")];
    expect(symbols(sortMerged(rows, "symbol", true))).toEqual([
      "AAA",
      "MMM",
      "ZZZ",
    ]);
    expect(symbols(sortMerged(rows, "symbol", false))).toEqual([
      "ZZZ",
      "MMM",
      "AAA",
    ]);
  });

  test("does not mutate the input", () => {
    const rows = [
      entry("AAA", { live: live({ volumeUSD24H: 1 }) }),
      entry("BBB", { live: live({ volumeUSD24H: 9 }) }),
    ];
    sortMerged(rows, "volume24h", false);
    expect(symbols(rows)).toEqual(["AAA", "BBB"]);
  });
});
