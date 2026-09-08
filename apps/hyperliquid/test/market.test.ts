import { expect, test } from "bun:test";
import { HyperliquidData, HyperliquidMarketStream, parseMarkets, type MarketStreamEvent } from "../src/market.ts";

const address = "0x1111111111111111111111111111111111111111";
const context = { markPx: "100", midPx: "100", oraclePx: "100", funding: "0.0001", openInterest: "1000", dayNtlVlm: "900000", prevDayPx: "90" };
const metadata = [{ universe: [{ name: "OLD", szDecimals: 2, maxLeverage: 3, isDelisted: true }, { name: "BTC", szDecimals: 5, maxLeverage: 40 }], marginTables: [[40, { marginTiers: [{ lowerBound: "0", maxLeverage: 40 }] }]], collateralToken: 0 }, [context, context]];
const summary = { accountValue: "1000", totalMarginUsed: "40", totalNtlPos: "200", totalRawUsd: "980" };
const clearinghouse = { assetPositions: [], marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: "10", withdrawable: "960", time: 1_700_000_000_000 };
const order = { coin: "BTC", oid: 101, side: "B", limitPx: "100", sz: "1", origSz: "1", timestamp: 1700000000000, reduceOnly: false, isTrigger: false, isPositionTpsl: false, orderType: "Limit", triggerCondition: "N/A", triggerPx: "0" };
const fill = { coin: "BTC", oid: 101, tid: 11, time: 1700000000000, px: "100", sz: "1", side: "B", startPosition: "0", dir: "Open Long", closedPnl: "0", hash: `0x${"12".repeat(32)}`, crossed: true, fee: "0.04", feeToken: "USDC" };
const spot = { balances: [{ coin: "USDC", token: 0, total: "1234", hold: "20", entryNtl: "0" }], tokenToAvailableAfterMaintenance: [[0, "1200"]] };
const fees = { userCrossRate: "0.0003", userAddRate: "-0.00001" };
type Handler = (body: Record<string, unknown>, init: RequestInit) => unknown | Response | Promise<unknown | Response>;
function fetchFixture(handler: Handler): typeof fetch {
  return (async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api\.hyperliquid(?:-testnet)?\.xyz\/info$/);
    expect(init?.credentials).toBe("omit"); expect(init?.mode).toBe("cors"); expect(init?.cache).toBe("no-store");
    const value = await handler(JSON.parse(String(init?.body)), init ?? {});
    return value instanceof Response ? value : Response.json(value);
  }) as typeof fetch;
}
function accountFixture(mode: string, overrides: Record<string, unknown> = {}, requested: string[] = []): typeof fetch {
  const responses: Record<string, unknown> = { clearinghouseState: clearinghouse, frontendOpenOrders: [order, { ...order, coin: "@107", oid: 102 }, { ...order, coin: "xyz:ABC", oid: 103 }], userAbstraction: mode, userFees: fees, spotClearinghouseState: spot, ...overrides };
  return fetchFixture((body) => { requested.push(String(body.type)); return responses[String(body.type)]; });
}

test("default market IDs retain universe indices even when earlier market is delisted", async () => {
  const data = new HyperliquidData("mainnet", fetchFixture((body) => { expect(body).toEqual({ type: "metaAndAssetCtxs", dex: "" }); return metadata; }));
  const result = await data.markets();
  expect(result.markets[1]?.asset).toBe(1); expect(result.markets[0]?.isDelisted).toBe(true);
  expect(result.markets[1]?.context.markPx).toBe("100"); expect(result.marginTables[0]?.[0]).toBe(40);
  expect(result.environment).toBe("mainnet"); expect(result.complete).toBe(true); expect(result.observedAt).toBeGreaterThan(0);
});
test("direct fetch retains its browser global receiver", async () => {
  const browserFetch = async function (this: unknown) { expect(this).toBe(globalThis); return Response.json(metadata); } as unknown as typeof fetch;
  expect((await new HyperliquidData("mainnet", browserFetch).markets()).markets).toHaveLength(2);
});
test("misaligned metadata or duplicate/non-default identities are rejected", () => {
  expect(() => parseMarkets([metadata[0], []], "mainnet")).toThrow("alignment");
  expect(() => parseMarkets([{ universe: [{ name: "xyz:BTC", szDecimals: 5, maxLeverage: 40 }] }, [context]], "mainnet")).toThrow();
  expect(() => parseMarkets([{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [context, context]], "mainnet")).toThrow();
});
test("standard account keeps perps collateral and filters only orders outside the app scope", async () => {
  const requested: string[] = [], result = await new HyperliquidData("mainnet", accountFixture("disabled", {}, requested)).account(address);
  expect(result.complete).toBe(true); expect(result.balanceSource).toBe("perps"); expect(result.positions).toEqual([]);
  expect(result.openOrders).toHaveLength(1); expect(result.excludedOrderCount).toBe(2);
  expect(result.clearinghouseState?.marginSummary.accountValue).toBe("1000"); expect(result.balances).toBeNull();
  expect(result.fees?.userAddRate).toBe("-0.00001"); expect(requested).not.toContain("spotClearinghouseState");
  expect(result.observations.find((item) => item.source === "clearinghouseState")?.serverTime).toBe(clearinghouse.time);
});
test.each(["unifiedAccount", "portfolioMargin"])("%s uses shared token collateral instead of adding perps account value", async (mode) => {
  const result = await new HyperliquidData("testnet", accountFixture(mode)).account(address);
  expect(result.balanceSource).toBe("unified"); expect(result.balances?.balances[0]?.total).toBe("1234");
  expect(result.balances?.tokenToAvailableAfterMaintenance?.[0]?.[1]).toBe("1200"); expect(result.abstraction).toBe(mode);
  expect(result.clearinghouseState?.marginSummary.accountValue).toBe("1000");
  expect(result.warnings.length).toBe(mode === "portfolioMargin" ? 1 : 0);
});
test("unresolved default abstraction retains observed sources with an explicit balance warning", async () => {
  const result = await new HyperliquidData("mainnet", accountFixture("default")).account(address);
  expect(result.abstraction).toBe("default"); expect(result.balanceSource).toBe("unknown"); expect(result.balances).not.toBeNull();
  expect(result.warnings[0]).toContain("must not be added together");
});
test("failed account component remains null, partial observations remain useful", async () => {
  const result = await new HyperliquidData("mainnet", accountFixture("disabled", { clearinghouseState: new Response("down", { status: 503 }), userFees: {} })).account(address);
  expect(result.complete).toBe(false); expect(result.positions).toBeNull(); expect(result.clearinghouseState).toBeNull(); expect(result.fees).toBeNull();
  expect(result.openOrders).toHaveLength(1); expect(result.errors.map((item) => item.source).sort()).toEqual(["clearinghouseState", "userFees"]);
  expect(result.errors.find((item) => item.source === "clearinghouseState")?.status).toBe(503);
});
test("upstream limits provide retry metadata and never trigger an automatic retry", async () => {
  let calls = 0;
  const result = await new HyperliquidData("mainnet", fetchFixture(() => { calls++; return new Response("limited", { status: 429, headers: { "Retry-After": "3" } }); })).account(address);
  // Four independent initial reads plus token balances when mode cannot be read.
  expect(calls).toBe(5); expect(result.errors).toHaveLength(5); expect(result.errors[0]?.retryAfterMs).toBe(3000);
  expect(result.openOrders).toBeNull(); expect(result.balanceSource).toBe("unknown");
});
test("abort is propagated instead of transformed into an empty or partial success", async () => {
  const controller = new AbortController(); controller.abort(new Error("invocation canceled"));
  let calls = 0;
  await expect(new HyperliquidData("mainnet", fetchFixture(() => { calls++; return {}; })).account(address, controller.signal)).rejects.toThrow("invocation canceled");
  expect(calls).toBe(0);
});
test("book and candles bind returned coin and interval to the request", async () => {
  const book = { coin: "BTC", time: 1700000000000, levels: [[{ px: "99", sz: "2", n: 1 }], [{ px: "101", sz: "3", n: 2 }]] };
  const data = new HyperliquidData("mainnet", fetchFixture((body) => body.type === "l2Book" ? book : [{ t: 0, T: 59999, s: "BTC", i: "1m", o: "100", c: "101", h: "102", l: "99", v: "20", n: 8 }]));
  expect((await data.book("BTC")).levels[0][0]?.px).toBe("99");
  await expect(data.book("ETH")).rejects.toThrow();
  expect((await data.candles("BTC", "1m", 0, 60000)).candles[0]?.c).toBe("101");
  await expect(data.candles("BTC", "5m", 0, 60000)).rejects.toThrow();
  await expect(data.candles("BTC", "1m", 2, 1)).rejects.toThrow("Time range");
  for (const coin of ["@1", "PURR/USDC", "xyz:ABC"]) await expect(data.book(coin)).rejects.toThrow("default");
});
test("fills deduplicate stable venue identities and preserve an inclusive cursor across same-millisecond fills", async () => {
  const data = new HyperliquidData("mainnet", fetchFixture((body) => { expect(body.type).toBe("userFillsByTime"); expect(body.startTime).toBe(1700000000000); return [fill, { ...fill, tid: 12 }, fill, { ...fill, coin: "@107", tid: 14 }, { ...fill, coin: "xyz:ABC", tid: 15 }]; }));
  const result = await data.fills(address, 1700000000000);
  expect(result.fills.map((row) => row.tid)).toEqual([11, 12]); expect(result.excludedFillCount).toBe(2); expect(result.nextStartTime).toBe(1700000000000);
});
test("funding keeps signed rates and enforces requested coin", async () => {
  const data = new HyperliquidData("mainnet", fetchFixture(() => [{ coin: "BTC", fundingRate: "-0.0001", premium: "0.0002", time: 1000 }]));
  expect((await data.funding("BTC", 0, 2000)).funding[0]?.fundingRate).toBe("-0.0001");
  await expect(data.funding("ETH", 0, 2000)).rejects.toThrow("fundingHistory");
});

class SocketFixture {
  readyState = 0; sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null; onerror: (() => void) | null = null;
  open() { this.readyState = 1; this.onopen?.(); }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  receive(channel: string, data: unknown) { this.onmessage?.({ data: JSON.stringify({ channel, data }) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
test("resident stream refcounts subscriptions, identifies snapshots, filters outside-scope orders and closes cleanly", async () => {
  const socket = new SocketFixture(), events: MarketStreamEvent[] = []; let reconciliations = 0, sockets = 0;
  const stream = new HyperliquidMarketStream("mainnet", () => { sockets++; return socket as unknown as WebSocket; });
  const stopA = stream.subscribe({ type: "userFills", user: address }, (event) => events.push(event), () => { reconciliations++; });
  const stopB = stream.subscribe({ type: "userFills", user: address }, () => undefined);
  socket.open(); await Promise.resolve(); await Promise.resolve();
  expect(sockets).toBe(1); expect(socket.sent.filter((item) => item.method === "subscribe")).toHaveLength(1); expect(reconciliations).toBe(1);
  socket.receive("userFills", { user: address, isSnapshot: true, fills: [fill, { ...fill, coin: "@1" }] });
  expect(events).toHaveLength(1); expect(events[0]?.isSnapshot).toBe(true); expect(events[0]?.generation).toBe(1);
  expect((events[0]?.data as { fills: unknown[] }).fills).toHaveLength(1);
  stopA(); expect(socket.sent.filter((item) => item.method === "unsubscribe")).toHaveLength(0);
  stopB(); expect(socket.sent.filter((item) => item.method === "unsubscribe")).toHaveLength(1); expect(socket.readyState).toBe(3);
  stream.close(); expect(() => stream.subscribe({ type: "l2Book", coin: "BTC" }, () => undefined)).toThrow("closed");
});
test("stream matches exact coin and candle interval and ignores unrelated account messages", () => {
  const socket = new SocketFixture(), events: MarketStreamEvent[] = [];
  const stream = new HyperliquidMarketStream("testnet", () => socket as unknown as WebSocket);
  stream.subscribe({ type: "candle", coin: "BTC", interval: "1m" }, (event) => events.push(event));
  stream.subscribe({ type: "openOrders", user: address, dex: "" }, (event) => events.push(event)); socket.open();
  socket.receive("candle", { s: "ETH", i: "1m" }); socket.receive("candle", { s: "BTC", i: "5m" }); socket.receive("candle", { s: "BTC", i: "1m" });
  socket.receive("openOrders", { user: `0x${"22".repeat(20)}`, dex: "", orders: [] });
  socket.receive("openOrders", { user: address, dex: "xyz", orders: [] }); socket.receive("openOrders", { user: address, dex: "", orders: [order, { ...order, coin: "PURR/USDC" }] });
  expect(events).toHaveLength(2); expect((events[1]?.data as { orders: unknown[] }).orders).toHaveLength(1); stream.close();
});
test("reconnected stream resubscribes and reconciles before consumers trust new state", async () => {
  const sockets: SocketFixture[] = [], generations: number[] = []; let reconciliations = 0;
  const stream = new HyperliquidMarketStream("mainnet", () => { const socket = new SocketFixture(); sockets.push(socket); return socket as unknown as WebSocket; });
  stream.subscribe({ type: "l2Book", coin: "BTC" }, (event) => generations.push(event.generation), () => { reconciliations++; });
  const original = sockets[0]!; original.open(); await Promise.resolve(); await Promise.resolve(); original.close();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(sockets).toHaveLength(2);
  const replacement = sockets[1]!; replacement.open(); await Promise.resolve(); await Promise.resolve();
  expect(replacement.sent[0]).toEqual({ method: "subscribe", subscription: { type: "l2Book", coin: "BTC" } }); expect(reconciliations).toBe(2);
  original.receive("l2Book", { coin: "BTC" }); replacement.receive("l2Book", { coin: "BTC" });
  expect(generations).toEqual([2]); stream.close();
});
