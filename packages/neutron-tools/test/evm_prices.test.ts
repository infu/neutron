import { expect, test } from "bun:test";
import {
  createEvmUsdPriceCache,
  EVM_USD_PRICE_REFRESH_MS,
  EVM_USD_PRICE_STALE_MS,
  evmPriceAssetKey,
  formatUsd,
  usdPriceTitle,
  usdValue,
} from "../src/evm_prices.ts";
import {
  createEvmWalletClient,
  EVM_WALLET_TARGET,
  EVM_WALLET_TOOLS,
  EvmWalletProtocolError,
  parseEvmPricesRequest,
  parseEvmPricesResult,
  type EvmPriceAsset,
  type EvmPricesResult,
  type EvmUsdPrice,
} from "../src/evm_wallet.ts";
import type { JsonValue, MsgBusCallOptions, MsgBusClient, MsgBusToolCall } from "../src/protocol.ts";

const NOW = 1_800_000_000_000;
const ETH: EvmPriceAsset = { chainId: "1", address: null };
const ARB_ETH: EvmPriceAsset = { chainId: "42161", address: null };
const WETH: EvmPriceAsset = { chainId: "1", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" };
const ARB_WETH: EvmPriceAsset = { chainId: "42161", address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" };
const TOKEN: EvmPriceAsset = { chainId: "1", address: `0x${"ab".repeat(20)}` };
const ARB_TOKEN: EvmPriceAsset = { chainId: "42161", address: TOKEN.address };

function quote(patch: Partial<EvmUsdPrice> = {}): EvmUsdPrice {
  return {
    ...ETH, priceUsd: 2_500, observedAtMs: NOW, fetchedAtMs: NOW,
    status: "available", basis: "market", sourceId: "coingecko:ethereum", error: null,
    ...patch,
  };
}

function response(coins: Record<string, unknown>): Response {
  // Keep nonfinite test values intact so provider validation itself is exercised.
  return { ok: true, status: 200, json: async () => ({ coins }) } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type FetchCall = { url: string; signal: AbortSignal | null | undefined };
function fakeFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: input instanceof Request ? input.url : String(input), signal: init?.signal };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function providerIds(call: FetchCall): string[] {
  return decodeURIComponent(new URL(call.url).pathname.split("/").at(-1)!).split(",");
}

test("USD quotes cache successful reads for 60 seconds and refresh at the boundary", async () => {
  expect(EVM_USD_PRICE_REFRESH_MS).toBe(60_000);
  expect(EVM_USD_PRICE_STALE_MS).toBe(300_000);
  let now = NOW;
  let price = 2_500;
  const mock = fakeFetch(() => response({ "coingecko:ethereum": { price, timestamp: now / 1_000 } }));
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => now });
  const first = await cache.getPrices([ETH]);
  expect(first).toEqual({ source: "defillama", prices: [quote()] });
  now += EVM_USD_PRICE_REFRESH_MS - 1;
  expect(await cache.getPrices([ETH])).toEqual(first);
  expect(mock.calls).toHaveLength(1);
  now += 1;
  price = 2_600;
  expect((await cache.getPrices([ETH])).prices[0]).toEqual(quote({ priceUsd: price, observedAtMs: now, fetchedAtMs: now }));
  expect(mock.calls).toHaveLength(2);
});

test("missing quotes and provider failures have the same 60 second retry cache", async () => {
  for (const fails of [false, true]) {
    let now = NOW;
    const mock = fakeFetch(() => {
      if (fails) throw new Error("provider unavailable");
      return response({});
    });
    const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => now });
    const first = (await cache.getPrices([TOKEN])).prices[0]!;
    expect(first.status).toBe("unavailable");
    expect(first.priceUsd).toBeNull();
    expect(first.observedAtMs).toBeNull();
    expect(first.error).toBeTruthy();
    now += EVM_USD_PRICE_REFRESH_MS - 1;
    expect((await cache.getPrices([TOKEN])).prices[0]).toEqual(first);
    expect(mock.calls).toHaveLength(1);
    now += 1;
    await cache.getPrices([TOKEN]);
    expect(mock.calls).toHaveLength(2);
  }
});

test("ETH and canonical WETH share a provider quote while retaining each requested asset identity", async () => {
  const mock = fakeFetch(() => response({ "coingecko:ethereum": { price: 2_500, timestamp: NOW / 1_000 } }));
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => NOW });
  const assets = [ARB_WETH, ETH, WETH, ARB_ETH];
  const { prices } = await cache.getPrices(assets);
  expect(providerIds(mock.calls[0]!)).toEqual(["coingecko:ethereum"]);
  expect(prices.map(({ chainId, address }) => ({ chainId, address }))).toEqual(assets);
  expect(prices.map(({ basis }) => basis)).toEqual(["wrapped_underlying", "market", "wrapped_underlying", "market"]);
  expect(prices.every((entry) => entry.priceUsd === 2_500 && entry.sourceId === "coingecko:ethereum")).toBe(true);
  await cache.getPrices([ETH, ARB_WETH]);
  expect(mock.calls).toHaveLength(1);
  expect(evmPriceAssetKey(ETH)).not.toBe(evmPriceAssetKey(WETH));
  expect(evmPriceAssetKey(WETH)).not.toBe(evmPriceAssetKey(ARB_WETH));
  expect(evmPriceAssetKey({ ...TOKEN, address: TOKEN.address!.toUpperCase().replace("0X", "0x") })).toBe(evmPriceAssetKey(TOKEN));
});

test("token lookup uses chain and contract, and unsupported networks never fetch", async () => {
  const mock = fakeFetch(() => response({
    [`ethereum:${TOKEN.address}`]: { price: 1.01, timestamp: NOW / 1_000 },
    [`arbitrum:${TOKEN.address}`]: { price: 0.99, timestamp: NOW / 1_000 },
  }));
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => NOW });
  expect(await cache.getPrices([])).toEqual({ source: "defillama", prices: [] });
  const unknown = { chainId: "11155111", address: null };
  const unsupported = (await cache.getPrices([unknown])).prices[0]!;
  expect(unsupported).toMatchObject({ ...unknown, status: "unavailable", priceUsd: null, sourceId: null });
  expect(mock.calls).toHaveLength(0);
  const { prices } = await cache.getPrices([ARB_TOKEN, TOKEN]);
  expect(providerIds(mock.calls[0]!).sort()).toEqual([`arbitrum:${TOKEN.address}`, `ethereum:${TOKEN.address}`]);
  expect(prices.map(({ priceUsd }) => priceUsd)).toEqual([0.99, 1.01]);
});

test("overlapping requests share pending provider IDs and independently fetch only missing IDs", async () => {
  const firstResponse = deferred<Response>();
  const started = deferred<void>();
  const mock = fakeFetch((call) => {
    if (providerIds(call).includes("coingecko:ethereum")) {
      started.resolve();
      return firstResponse.promise;
    }
    return response({ [`arbitrum:${TOKEN.address}`]: { price: 0.99, timestamp: NOW / 1_000 } });
  });
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => NOW });
  const first = cache.getPrices([ETH, TOKEN]);
  await started.promise;
  const second = cache.getPrices([ARB_TOKEN, ARB_WETH, TOKEN]);
  firstResponse.resolve(response({
    "coingecko:ethereum": { price: 2_500, timestamp: NOW / 1_000 },
    [`ethereum:${TOKEN.address}`]: { price: 1.01, timestamp: NOW / 1_000 },
  }));
  const [a, b] = await Promise.all([first, second]);
  expect(mock.calls).toHaveLength(2);
  expect(mock.calls.flatMap(providerIds).sort()).toEqual([`arbitrum:${TOKEN.address}`, "coingecko:ethereum", `ethereum:${TOKEN.address}`]);
  expect(a.prices.map(({ priceUsd }) => priceUsd)).toEqual([2_500, 1.01]);
  expect(b.prices.map(({ priceUsd }) => priceUsd)).toEqual([0.99, 2_500, 1.01]);
});

test("one caller cancelling does not abort a shared fetch or prevent another caller's result", async () => {
  const pending = deferred<Response>();
  const started = deferred<void>();
  const mock = fakeFetch(() => { started.resolve(); return pending.promise; });
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => NOW });
  const abort = new AbortController();
  const cancelled = cache.getPrices([ETH], { signal: abort.signal });
  await started.promise;
  const shared = cache.getPrices([WETH]);
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  expect(mock.calls[0]!.signal?.aborted).not.toBe(true);
  pending.resolve(response({ "coingecko:ethereum": { price: 2_500, timestamp: NOW / 1_000 } }));
  expect((await shared).prices[0]).toEqual(quote({ ...WETH, basis: "wrapped_underlying" }));
  expect(mock.calls).toHaveLength(1);
  expect((await cache.getPrices([ETH])).prices[0]).toEqual(quote());
  expect(mock.calls).toHaveLength(1);
});

test("a provider timeout returns unavailable and clears the pending request for a later retry", async () => {
  let now = NOW;
  let blocked = true;
  const mock = fakeFetch((call) => {
    if (!blocked) return response({ "coingecko:ethereum": { price: 2_500, timestamp: now / 1_000 } });
    return new Promise<Response>((_resolve, reject) => {
      call.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => now, timeoutMs: 10 });
  const timedOut = (await cache.getPrices([ETH])).prices[0]!;
  expect(timedOut.status).toBe("unavailable");
  expect(timedOut.error).toBeTruthy();
  expect(mock.calls[0]!.signal?.aborted).toBe(true);
  blocked = false;
  now += EVM_USD_PRICE_REFRESH_MS;
  expect((await cache.getPrices([ETH])).prices[0]!.status).toBe("available");
  expect(mock.calls).toHaveLength(2);
});

test("failed refresh retains the last good quote as stale and a later success replaces it", async () => {
  let now = NOW;
  let fails = false;
  const mock = fakeFetch(() => {
    if (fails) throw new Error("network offline");
    return response({ "coingecko:ethereum": { price: 2_500, timestamp: now / 1_000 } });
  });
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => now });
  await cache.getPrices([ETH]);
  fails = true;
  now += EVM_USD_PRICE_REFRESH_MS;
  const stale = (await cache.getPrices([ETH])).prices[0]!;
  expect(stale).toMatchObject({ priceUsd: 2_500, observedAtMs: NOW, fetchedAtMs: NOW, status: "stale" });
  expect(stale.error).toBeTruthy();
  now += EVM_USD_PRICE_STALE_MS;
  expect((await cache.getPrices([ETH])).prices[0]).toMatchObject({ priceUsd: 2_500, observedAtMs: NOW, status: "stale" });
  fails = false;
  now += EVM_USD_PRICE_REFRESH_MS;
  expect((await cache.getPrices([ETH])).prices[0]).toEqual(quote({ observedAtMs: now, fetchedAtMs: now }));
});

test("staleness follows provider observation age even when the cached fetch is recent", async () => {
  let now = NOW;
  const observedAtMs = NOW - EVM_USD_PRICE_STALE_MS + 1_000;
  const mock = fakeFetch(() => response({ "coingecko:ethereum": { price: 2_500, timestamp: observedAtMs / 1_000 } }));
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => now });
  expect((await cache.getPrices([ETH])).prices[0]).toEqual(quote({ observedAtMs }));
  now += 2_000;
  expect((await cache.getPrices([ETH])).prices[0]).toMatchObject({ priceUsd: 2_500, observedAtMs, fetchedAtMs: NOW, status: "stale" });
  expect(mock.calls).toHaveLength(1);
});

test("malformed provider entries fail individually without hiding valid quotes", async () => {
  const badEntries = [
    { price: 0, timestamp: NOW / 1_000 },
    { price: -1, timestamp: NOW / 1_000 },
    { price: Infinity, timestamp: NOW / 1_000 },
    { price: NaN, timestamp: NOW / 1_000 },
    { price: "2", timestamp: NOW / 1_000 },
    { price: 2 },
    { price: 2, timestamp: Number.MAX_SAFE_INTEGER },
    { price: 2, timestamp: (NOW + 61_000) / 1_000 },
    { price: 2, timestamp: Infinity },
    null,
  ];
  const assets = badEntries.map((_, i): EvmPriceAsset => ({ chainId: "1", address: `0x${(i + 1).toString(16).padStart(40, "0")}` }));
  const coins = Object.fromEntries(assets.map((asset, i) => [`ethereum:${asset.address}`, badEntries[i]]));
  coins["coingecko:ethereum"] = { price: 2_500, timestamp: NOW / 1_000 };
  const mock = fakeFetch(() => response(coins));
  const cache = createEvmUsdPriceCache({ fetch: mock.fetch, now: () => NOW });
  const result = await cache.getPrices([...assets, ETH]);
  expect(result.prices.at(-1)).toEqual(quote());
  for (const entry of result.prices.slice(0, -1)) {
    expect(entry.status).toBe("unavailable");
    expect(entry.priceUsd).toBeNull();
    expect(entry.observedAtMs).toBeNull();
    expect(entry.error).toBeTruthy();
  }
  expect(parseEvmPricesResult(result, { assets: [...assets, ETH] })).toEqual(result);
});

test("USD helpers preserve missing prices, reject invalid quantities, and explain quote provenance", () => {
  expect(usdValue("1500000000000000000", 18, quote())).toBe(3_750);
  expect(usdValue("1000000", 6, quote({ priceUsd: 1 }))).toBe(1);
  expect(usdValue("0", 18, quote())).toBe(0);
  expect(usdValue("0", 18, undefined)).toBeNull();
  expect(usdValue("1", 18, quote({ status: "unavailable", priceUsd: null, observedAtMs: null, fetchedAtMs: null, error: "No quote" }))).toBeNull();
  expect(usdValue("1000000000000000000", 18, quote({ status: "stale", error: "Refresh failed" }))).toBe(2_500);
  for (const atoms of ["", "-1", "+1", "1.5", "1e18", "0x10", " 1", "1\n"]) expect(usdValue(atoms, 18, quote())).toBeNull();
  for (const decimals of [-1, 0.5, 256, NaN, Infinity]) expect(usdValue("1", decimals, quote())).toBeNull();
  expect(formatUsd(null)).toBe("—");
  expect(formatUsd(NaN)).toBe("—");
  expect(formatUsd(Infinity)).toBe("—");
  expect(formatUsd(0)).toBe("$0.00");
  expect(formatUsd(1_234.5)).toBe("$1,234.50");
  expect(formatUsd(0.001)).toBe("<$0.01");
  expect(usdPriceTitle(quote())).toMatch(/DefiLlama/i);
  expect(usdPriceTitle(quote({ status: "stale" }))).toMatch(/stale/i);
  expect(usdPriceTitle(quote({ ...WETH, basis: "wrapped_underlying" }))).toMatch(/wrapped|underlying/i);
  expect(usdPriceTitle(undefined)).toMatch(/unavailable/i);
});

test("price SDK requests normalize contract addresses and reject malformed or extra input fields", () => {
  const mixed = { ...TOKEN, address: `0x${"AB".repeat(20)}` };
  expect(parseEvmPricesRequest({ assets: [ETH, mixed] })).toEqual({ assets: [ETH, TOKEN] });
  for (const value of [
    null, [], {}, { assets: [ETH], accountId: "main" }, { assets: [ETH], caller: "agent" },
    { assets: [{ ...ETH, chainId: 1 }] }, { assets: [{ ...ETH, chainId: "0" }] },
    { assets: [{ ...ETH, chainId: "01" }] }, { assets: [{ ...ETH, chainId: "1\n" }] },
    { assets: [{ ...ETH, address: "ETH" }] }, { assets: [{ chainId: "1" }] },
    { assets: [{ ...ETH, symbol: "ETH" }] },
  ]) expect(() => parseEvmPricesRequest(value)).toThrow(EvmWalletProtocolError);
});

test("price SDK responses bind exact ordered assets and require coherent numeric quote evidence", () => {
  const request = { assets: [ETH, WETH] };
  const result: EvmPricesResult = { source: "defillama", prices: [quote(), quote({ ...WETH, basis: "wrapped_underlying" })] };
  expect(parseEvmPricesResult(result, request)).toEqual(result);
  for (const prices of [result.prices.slice(0, 1), [...result.prices].reverse(), [quote(), quote()], [...result.prices, quote()]]) {
    expect(() => parseEvmPricesResult({ ...result, prices }, request)).toThrow(EvmWalletProtocolError);
  }
  for (const patch of [
    { priceUsd: 0 }, { priceUsd: -1 }, { priceUsd: Infinity }, { priceUsd: NaN }, { priceUsd: "2500" },
    { priceUsd: null }, { observedAtMs: null }, { observedAtMs: 1.5 }, { observedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { fetchedAtMs: -1 }, { fetchedAtMs: Infinity }, { status: "unavailable" }, { basis: "guessed" },
    { sourceId: null }, { providerSecret: "secret" },
  ]) expect(() => parseEvmPricesResult({ ...result, prices: [{ ...quote(), ...patch }, result.prices[1]] }, request)).toThrow(EvmWalletProtocolError);
  expect(() => parseEvmPricesResult({ ...result, source: "unknown" }, request)).toThrow(EvmWalletProtocolError);
  expect(() => parseEvmPricesResult({ ...result, currency: "USD" }, request)).toThrow(EvmWalletProtocolError);
});

test("wallet prices client validates before transport and rejects responses for a different asset", async () => {
  const calls: Array<{ call: MsgBusToolCall; options: number | MsgBusCallOptions | undefined }> = [];
  let result: EvmPricesResult = { source: "defillama", prices: [quote({ ...TOKEN, sourceId: `ethereum:${TOKEN.address}` })] };
  const kernel: Pick<MsgBusClient, "callTool"> = {
    async callTool<T extends JsonValue = JsonValue>(call: MsgBusToolCall, options?: number | MsgBusCallOptions): Promise<T> {
      calls.push({ call, options });
      return result as unknown as T;
    },
  };
  const client = createEvmWalletClient(kernel);
  const signal = new AbortController().signal;
  const request = { assets: [{ ...TOKEN, address: `0x${"AB".repeat(20)}` }] };
  expect(await client.prices(request, { signal, timeout: 321 })).toEqual(result);
  expect(calls[0]).toEqual({
    call: { target: EVM_WALLET_TARGET, name: EVM_WALLET_TOOLS.prices, arguments: { assets: [TOKEN] } },
    options: { signal, timeout: 321 },
  });
  await expect(client.prices({ assets: [{ chainId: "1", address: "bad" }] })).rejects.toThrow(EvmWalletProtocolError);
  expect(calls).toHaveLength(1);
  result = { source: "defillama", prices: [quote()] };
  await expect(client.prices(request)).rejects.toThrow(EvmWalletProtocolError);
  expect(calls).toHaveLength(2);
});
