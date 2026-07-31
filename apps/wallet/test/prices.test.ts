import { expect, test } from "bun:test";
import {
  USD_PRICE_CACHE_KEY,
  fetchUsdPriceBook,
  formatUsd,
  optionalBrowserStorage,
  positionUsdValue,
  readUsdPriceCache,
  writeUsdPriceCache,
  type PriceFetch,
  type UsdPriceBook,
} from "../src/prices.ts";

test("Wallet treats browser storage as optional in sandboxed tiles", () => {
  const source = Object.defineProperty({}, "localStorage", {
    get() {
      throw new DOMException("opaque origin", "SecurityError");
    },
  }) as { readonly localStorage: Storage };

  expect(optionalBrowserStorage(source)).toBeNull();
});

test("Wallet fetches native-asset USD prices in one CoinGecko request", async () => {
  const urls: string[] = [];
  const fetcher: PriceFetch = async (url) => {
    urls.push(url);
    return jsonResponse({
      bitcoin: { usd: 61_985.4 },
      "internet-computer": { usd: 2.163 },
      "usd-coin": { usd: 0.9997 },
    });
  };

  const prices = await fetchUsdPriceBook(["BTC", "ICP", "USDC"], {
    fetcher,
    now: () => 1_700_000_000_000,
  });

  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("api.coingecko.com/api/v3/simple/price");
  expect(prices.updatedAt).toBe(1_700_000_000_000);
  expect(prices.providers).toEqual(["coingecko"]);
  expect(prices.quotes.BTC).toEqual({
    source: "coingecko",
    usd: 6_198_540_000_000n,
  });
  expect(prices.quotes.ICP?.usd).toBe(216_300_000n);
  expect(prices.quotes.USDC?.usd).toBe(99_970_000n);
});

test("Wallet fills missing quotes through Kraken then Coinbase", async () => {
  const urls: string[] = [];
  const fetcher: PriceFetch = async (url) => {
    urls.push(url);
    if (url.includes("coingecko")) {
      return new Response("rate limited", { status: 429 });
    }
    if (url.includes("kraken")) {
      return jsonResponse({
        error: [],
        result: {
          XXBTZUSD: { c: ["62000.25", "1"] },
        },
      });
    }
    return jsonResponse({
      data: {
        currency: "USD",
        rates: { USDC: "1.0" },
      },
    });
  };

  const prices = await fetchUsdPriceBook(["BTC", "USDC"], { fetcher });

  expect(urls).toHaveLength(3);
  expect(prices.providers).toEqual(["kraken", "coinbase"]);
  expect(prices.quotes.BTC).toEqual({
    source: "kraken",
    usd: 6_200_025_000_000n,
  });
  expect(prices.quotes.USDC).toEqual({
    source: "coinbase",
    usd: 100_000_000n,
  });
});

test("Wallet values arbitrary Nat balances without Number conversion", () => {
  const value = positionUsdValue("1100000000", 8, {
    source: "kraken",
    usd: 6_198_540_000_000n,
  });
  expect(value).toBe(68_183_940_000_000n);
  expect(formatUsd(value!)).toBe("$681,839.40");
  expect(formatUsd(1n)).toBe("<$0.01");
});

test("Wallet price cache accepts only bounded validated quotes", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  const book: UsdPriceBook = {
    providers: ["coingecko"],
    quotes: {
      BTC: { source: "coingecko", usd: 6_198_540_000_000n },
      USDT: { source: "coingecko", usd: 100_000_000n },
    },
    updatedAt: 1_700_000_000_000,
  };

  writeUsdPriceCache(storage, book);
  expect(readUsdPriceCache(storage, 1_700_000_001_000)).toEqual(book);

  values.set(
    USD_PRICE_CACHE_KEY,
    JSON.stringify({
      version: 1,
      updatedAt: 1_700_000_000_000,
      quotes: { BTC: { source: "unknown", usd: "6198540000000" } },
    }),
  );
  expect(readUsdPriceCache(storage, 1_700_000_001_000)).toBeNull();
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
