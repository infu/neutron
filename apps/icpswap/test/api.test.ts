import { afterEach, describe, expect, test } from "bun:test";
import {
  IcpSwapApiError,
  cached,
  denominateInIcp,
  fetchAllTokens,
  fetchTokenChart,
  fetchTokenPools,
  fetchTokenRanks,
  fetchTokenTransactionPage,
  fetchTokenTransactions,
  invalidateCache,
  toNumber,
  type InfoCandle,
} from "../src/api.ts";

type FetchArgs = Parameters<typeof fetch>;

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string) => { status?: number; body: unknown },
): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (...args: FetchArgs) => {
    const url = String(args[0]);
    seen.push(url);
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return seen;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateCache();
});

describe("toNumber", () => {
  test("parses upstream decimal strings", () => {
    expect(toNumber("1.5")).toBe(1.5);
    expect(toNumber("0.000006561755487000")).toBeCloseTo(6.561755487e-6, 15);
    expect(toNumber(42)).toBe(42);
  });

  test("falls back to zero for unusable values", () => {
    expect(toNumber("")).toBe(0);
    expect(toNumber("abc")).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
  });
});

describe("fetchAllTokens", () => {
  test("normalises the token universe", async () => {
    mockFetch(() => ({
      body: {
        code: 200,
        message: null,
        data: [
          {
            tokenLedgerId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            tokenName: "Internet Computer",
            tokenSymbol: "ICP",
            price: "2.410094420872994500",
            priceChange24H: "-2.424479362108850000",
            tvlUSD: "1628724.749760601790345781",
            tvlUSDChange24H: "1.5",
            txCount24H: "4566",
            volumeUSD24H: "373994.914955179885765379",
            volumeUSD7D: "1000",
            totalVolumeUSD: "2000",
            priceLow24H: "2.3",
            priceHigh24H: "2.5",
            priceLow7D: "2.1",
            priceHigh7D: "2.6",
            priceLow30D: "2.0",
            priceHigh30D: "2.9",
          },
          { tokenName: "no ledger id" },
        ],
      },
    }));

    const tokens = await fetchAllTokens();
    expect(tokens).toHaveLength(1);
    const token = tokens[0]!;
    expect(token.ledgerId).toBe("ryjl3-tyaaa-aaaaa-aaaba-cai");
    expect(token.symbol).toBe("ICP");
    expect(token.price).toBeCloseTo(2.4100944, 6);
    expect(token.priceChange24H).toBeCloseTo(-2.4244793, 6);
    expect(token.txCount24H).toBe(4566);
    expect(token.priceHigh30D).toBe(2.9);
  });

  test("rejects a non-200 API envelope", async () => {
    mockFetch(() => ({ body: { code: 500, message: "upstream down", data: null } }));
    await expect(fetchAllTokens()).rejects.toThrow(IcpSwapApiError);
  });

  test("rejects an HTTP failure", async () => {
    mockFetch(() => ({ status: 503, body: {} }));
    await expect(fetchAllTokens()).rejects.toThrow(/503/);
  });

  test("rejects a malformed payload", async () => {
    mockFetch(() => ({ body: { code: 200, data: { not: "an array" } } }));
    await expect(fetchAllTokens()).rejects.toThrow(/Malformed token list/);
  });
});

describe("fetchTokenChart", () => {
  test("orders candles oldest first and converts milliseconds", async () => {
    const seen = mockFetch(() => ({
      body: {
        code: 200,
        data: {
          totalElements: 1332,
          page: 1,
          limit: 3,
          content: [
            {
              snapshotTime: 1788195614000,
              level: "d1",
              price: "2.39",
              open: "2.34",
              high: "2.43",
              low: "2.30",
              close: "2.39",
              volumeUSD: "254773.6",
              tvlUSD: "1626610.18",
              txCount: "4566",
            },
            {
              snapshotTime: 1788134457000,
              level: "d1",
              price: "2.34",
              open: "2.47",
              high: "2.48",
              low: "2.33",
              close: "2.34",
              volumeUSD: "236774.56",
              tvlUSD: "1622998.04",
              txCount: "3590",
            },
          ],
        },
      },
    }));

    const page = await fetchTokenChart("ryjl3-tyaaa-aaaaa-aaaba-cai", "d1", 2);
    expect(page.total).toBe(1332);
    expect(page.candles).toHaveLength(2);
    expect(page.candles[0]!.t).toBeLessThan(page.candles[1]!.t);
    expect(page.candles[0]!.t).toBe(1788134457);
    expect(page.candles[1]!.close).toBeCloseTo(2.39, 6);
    expect(seen[0]).toContain("/token/ryjl3-tyaaa-aaaaa-aaaba-cai/chart/d1");
    expect(seen[0]).toContain("limit=2");
  });

  test("clamps an absurd limit", async () => {
    const seen = mockFetch(() => ({
      body: { code: 200, data: { totalElements: 0, content: [] } },
    }));
    await fetchTokenChart("aaaaa-aa", "h1", 100_000);
    expect(seen[0]).toContain("limit=1000");
  });
});

describe("fetchTokenPools", () => {
  test("parses pool statistics", async () => {
    mockFetch(() => ({
      body: {
        code: 200,
        data: [
          {
            poolId: "pgcdz-7yaaa-aaaag-qnera-cai",
            poolFee: 3000,
            token0LedgerId: "pwba7-ciaaa-aaaam-qcxia-cai",
            token0Name: "GarfieldCoin",
            token0Symbol: "GFC",
            token0Price: "0.000001947401304000",
            token0LiquidityAmount: "235920424.09716186",
            token1LedgerId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            token1Name: "Internet Computer",
            token1Symbol: "ICP",
            token1Price: "2.44",
            token1LiquidityAmount: "536.86",
            tvlUSD: "1749.165975598132700000",
            tvlUSDChange24H: "0.66",
            txCount24H: "0",
            feesUSD24H: "0",
            volumeUSD24H: "0",
            volumeUSD7D: "0.537127921181615733",
            totalVolumeUSD: "69896.88",
            createTime: 1749623715000,
          },
        ],
      },
    }));

    const pools = await fetchTokenPools("ryjl3-tyaaa-aaaaa-aaaba-cai");
    expect(pools).toHaveLength(1);
    const pool = pools[0]!;
    expect(pool.poolFee).toBe(3000);
    expect(pool.token1Symbol).toBe("ICP");
    expect(pool.tvlUSD).toBeCloseTo(1749.166, 3);
    expect(pool.createTime).toBe(1749623715);
  });
});

describe("fetchTokenRanks", () => {
  test("parses valuation fields", async () => {
    mockFetch(() => ({
      body: {
        code: 200,
        data: [
          {
            tokenLedgerId: "ryjl3-tyaaa-aaaaa-aaaba-cai",
            tokenName: "Internet Computer",
            tokenSymbol: "ICP",
            price: "2.41",
            priceChange24H: "-2.42",
            fdv: "1340443014.61",
            marketCap: "755400419.56",
            tvlUSD: "1628724.74",
            volumeUSD24H: "373994.91",
            holder: "355302",
            rank: "0",
          },
        ],
      },
    }));

    const ranks = await fetchTokenRanks();
    expect(ranks[0]!.marketCap).toBeCloseTo(755400419.56, 2);
    expect(ranks[0]!.holders).toBe(355302);
  });
});

describe("fetchTokenTransactions", () => {
  test("parses trades and bounds the limit", async () => {
    const seen = mockFetch(() => ({
      body: {
        code: 200,
        data: {
          totalElements: 1,
          content: [
            {
              poolId: "pool-1",
              poolFee: 3000,
              actionType: "swap",
              token0Symbol: "ICP",
              token1Symbol: "ckBTC",
              token0AmountIn: "1",
              token1AmountIn: "0",
              token0AmountOut: "0",
              token1AmountOut: "0.0001",
              token0TxValue: "2.4",
              token1TxValue: "2.39",
              fromTextualId: "abc",
              toTextualId: "def",
              txHash: "hash",
              txTime: 1788195614000,
            },
          ],
        },
      },
    }));

    const trades = await fetchTokenTransactions("ryjl3-tyaaa-aaaaa-aaaba-cai", 999);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.txTime).toBe(1788195614);
    expect(trades[0]!.from).toBe("abc");
    expect(seen[0]).toContain("limit=100");
    expect(seen[0]).toContain("page=1");
  });
});

describe("fetchTokenTransactionPage", () => {
  const reply = (total: number) => ({
    body: {
      code: 200,
      data: {
        totalElements: total,
        content: [
          {
            poolId: "pool-1",
            poolFee: 3000,
            actionType: "swap",
            token0Symbol: "ICP",
            token1Symbol: "ckBTC",
            token0AmountIn: "1",
            token1AmountIn: "0",
            token0AmountOut: "0",
            token1AmountOut: "0.0001",
            token0TxValue: "2.4",
            token1TxValue: "2.39",
            fromTextualId: "abc",
            toTextualId: "def",
            txHash: "hash",
            txTime: 1788195614000,
          },
        ],
      },
    },
  });

  test("requests the page it was asked for and reports the total", async () => {
    // ckBTC really does report 118,896 trades.
    const seen = mockFetch(() => reply(118896));
    const page = await fetchTokenTransactionPage(
      "mxzaz-hqaaa-aaaar-qaada-cai",
      7,
      15,
    );
    expect(seen[0]).toContain("page=7");
    expect(seen[0]).toContain("limit=15");
    expect(page.total).toBe(118896);
    expect(page.trades).toHaveLength(1);
  });

  test("bounds the page and the limit", async () => {
    const seen = mockFetch(() => reply(1));
    await fetchTokenTransactionPage("ryjl3-tyaaa-aaaaa-aaaba-cai", 0, 999);
    expect(seen[0]).toContain("page=1");
    expect(seen[0]).toContain("limit=100");
  });

  test("reports no total when the upstream omits one", async () => {
    mockFetch(() => ({ body: { code: 200, data: { content: [] } } }));
    const page = await fetchTokenTransactionPage("ryjl3-tyaaa-aaaaa-aaaba-cai", 1, 15);
    expect(page.total).toBe(0);
    expect(page.trades).toEqual([]);
  });
});

describe("cached", () => {
  test("shares one result inside the ttl window", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls;
    };
    const first = await cached("k", 10_000, load);
    const second = await cached("k", 10_000, load);
    expect(first).toBe(1);
    expect(second).toBe(1);
    expect(calls).toBe(1);
  });

  test("does not cache a failure", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      throw new Error("boom");
    };
    await expect(cached("fail", 10_000, load)).rejects.toThrow("boom");
    await expect(cached("fail", 10_000, load)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });

  test("invalidate clears every entry", async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return calls;
    };
    await cached("x", 10_000, load);
    invalidateCache();
    await cached("x", 10_000, load);
    expect(calls).toBe(2);
  });
});


describe("denominateInIcp", () => {
  const candle = (
    t: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ): InfoCandle => ({
    t,
    snapshotAt: t + 5,
    open,
    high,
    low,
    close,
    price: close,
    volumeUSD: 100,
    tvlUSD: 200,
    txCount: 3,
  });

  test("divides each component by the ICP candle in the same bucket", () => {
    const [converted] = denominateInIcp(
      [candle(100, 20, 30, 10, 24)],
      [candle(100, 2, 3, 1, 2)],
    );
    expect(converted?.open).toBe(10);
    expect(converted?.close).toBe(12);
    expect(converted?.high).toBe(12);
    expect(converted?.low).toBe(10);
  });

  test("aligns on the bucket, not on the position in the series", () => {
    // Both series are hourly, but the token has a gap at bucket 200.
    const converted = denominateInIcp(
      [candle(100, 20, 20, 20, 20), candle(300, 60, 60, 60, 60)],
      [candle(100, 2, 2, 2, 2), candle(200, 4, 4, 4, 4), candle(300, 3, 3, 3, 3)],
    );
    expect(converted.map((entry) => entry.t)).toEqual([100, 300]);
    expect(converted.map((entry) => entry.close)).toEqual([10, 20]);
  });

  test("drops a bucket with no ICP reference rather than guessing one", () => {
    expect(denominateInIcp([candle(100, 1, 1, 1, 1)], [])).toEqual([]);
  });

  test("keeps the body inside the wick", () => {
    // Dividing extremes componentwise can put the body outside the range;
    // every emitted candle must still satisfy low <= open,close <= high.
    for (const converted of denominateInIcp(
      [candle(100, 10, 11, 9, 10)],
      [candle(100, 1, 0.5, 2, 1)],
    )) {
      expect(converted.high).toBeGreaterThanOrEqual(
        Math.max(converted.open, converted.close),
      );
      expect(converted.low).toBeLessThanOrEqual(
        Math.min(converted.open, converted.close),
      );
      expect(converted.low).toBeGreaterThan(0);
    }
  });

  test("skips a bucket where the ICP price is missing or zero", () => {
    expect(denominateInIcp([candle(100, 5, 5, 5, 5)], [candle(100, 0, 0, 0, 0)])).toEqual(
      [],
    );
  });

  test("leaves volume and TVL in USD", () => {
    const [converted] = denominateInIcp(
      [candle(100, 20, 20, 20, 20)],
      [candle(100, 2, 2, 2, 2)],
    );
    expect(converted?.volumeUSD).toBe(100);
    expect(converted?.tvlUSD).toBe(200);
  });

  test("reports the close as the candle price", () => {
    const [converted] = denominateInIcp(
      [candle(100, 20, 30, 10, 24)],
      [candle(100, 2, 2, 2, 2)],
    );
    expect(converted?.price).toBe(converted?.close);
  });
});
