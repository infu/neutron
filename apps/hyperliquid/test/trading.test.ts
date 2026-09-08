import { describe, expect, test } from "bun:test";
import { createL1ActionHash, signL1Action } from "@nktkas/hyperliquid/signing";
import { privateKeyToAccount } from "viem/accounts";
import Decimal from "decimal.js";
import { boundedMarketPrice, createTradingEngine, validatePerpPrice, type TradeIntent } from "../src/trading";
import { MemoryTradingStore, type JournalRecord } from "../src/trading_store";
import { IndexedTradingStore } from "../src/trading_store";
import "fake-indexeddb/auto";

// Public, unfunded fixture from the first-party Python SDK's signing_test.py at
// 2fdb18f9517675ea03695a0962bd19eece9c83f0. These independent vectors catch key-order,
// nonce encoding, chain source, and typed-data signing regressions.
const fixtureWallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const binding = { walletAddress: "0x1111111111111111111111111111111111111111", installationId: "installation:wallet-fingerprint", environment: "testnet" as const };
const caller = { appId: "agent", installationUid: "agent-installation", role: "background" };
const operationId = "0123456789abcdef0123456789abcdef";
const intent: TradeIntent = { kind: "order", coin: "ETH", side: "buy", orderType: "market", size: "0.1", slippageBps: 50 };

function fixture(options: { store?: MemoryTradingStore; response?: (body: string) => Promise<Response>; status?: () => unknown; signal?: AbortSignal; authorize?: () => Promise<void>; fills?: unknown[]; positionSize?: string } = {}) {
  const store = options.store ?? new MemoryTradingStore();
  const sent: string[] = [];
  const reviews: unknown[] = [];
  let signed = 0;
  let clock = 1_780_000_000_000;
  const signer = { ...fixtureWallet, async signTypedData(args: any) { signed++; return fixtureWallet.signTypedData(args); } };
  const info = async <T>(body: Record<string, unknown>): Promise<T> => {
    switch (body.type) {
      case "meta": return { universe: [{ name: "ETH", szDecimals: 4, maxLeverage: 25 }, { name: "BTC", szDecimals: 5, maxLeverage: 40 }] } as T;
      case "l2Book": return { coin: body.coin, time: clock, levels: [[{ px: "1999.5", sz: "20", n: 3 }], [{ px: "2000.5", sz: "20", n: 4 }]] } as T;
      case "orderStatus": return (options.status?.() ?? { status: "unknownOid" }) as T;
      case "userFillsByTime": return (options.fills ?? []) as T;
      case "clearinghouseState": return { assetPositions: [{ position: { coin: "ETH", szi: options.positionSize ?? "-0.25", leverage: { type: "isolated", value: 3 }, marginUsed: "100" } }] } as T;
      case "openOrders": return [{ coin: "ETH", oid: 1 }, { coin: "xyz:TSLA", oid: 2 }, { coin: "@107", oid: 3 }, { coin: "BTC", oid: 4 }] as T;
      default: throw new Error(`Unexpected fixture request ${String(body.type)}`);
    }
  };
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const body = String(init.body);
    const saved = await store.list(JSON.stringify([binding.environment, binding.walletAddress, binding.installationId, caller.appId, caller.installationUid, caller.role]));
    expect(saved.some(record => record.state === "submitting" && record.envelopeJson === body)).toBe(true);
    sent.push(body);
    return options.response ? options.response(body) : Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 100 } }] } } });
  }) as typeof fetch;
  const make = (overrides: Record<string, unknown> = {}) => createTradingEngine({ binding, caller, store, data: { info }, signer: async () => signer, authorize: async review => { reviews.push(review); await options.authorize?.(); }, fetcher, now: () => clock++, ...(options.signal ? { signal: options.signal } : {}), ...overrides });
  return { store, sent, reviews, make, info, signed: () => signed };
}

describe("Hyperliquid signing compatibility", () => {
  test("matches first-party phantom-agent and order signature vectors", async () => {
    expect(createL1ActionHash({ action: { type: "order", orders: [{ a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" }, nonce: 1677777606040 })).toBe("0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908");
    const action = { type: "order", orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
    expect(await signL1Action({ wallet: fixtureWallet, action, nonce: 0 })).toEqual({ r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e", s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e", v: 28 });
    expect(await signL1Action({ wallet: fixtureWallet, action, nonce: 0, isTestnet: true })).toEqual({ r: "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54", s: "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5", v: 27 });
  });
});

describe("Perpetual price and intent validation", () => {
  test("integer exception and exact decimal precision", () => {
    expect(validatePerpPrice("123456", 4)).toBe("123456");
    expect(validatePerpPrice("0.012345", 0)).toBe("0.012345");
    expect(() => validatePerpPrice("123.456", 3)).toThrow();
    expect(() => validatePerpPrice("0.0000001", 0)).toThrow();
    expect(() => validatePerpPrice("1e2", 4)).toThrow();
    expect(() => validatePerpPrice("NaN", 4)).toThrow();
  });
  test("IOC rounding never expands the chosen boundary", () => {
    for (const reference of ["0.123456", "9.99999", "99.9999", "999.999", "99999.5", "2000.5"]) {
      for (const buy of [true, false]) {
        const actual = new Decimal(boundedMarketPrice(reference, buy, 50, 0));
        const bound = new Decimal(reference).mul(buy ? "1.005" : "0.995");
        expect(buy ? actual.lte(bound) : actual.gte(bound)).toBe(true);
      }
    }
    expect(boundedMarketPrice("2000.5", true, 50, 4)).toBe("2010.5");
    expect(() => boundedMarketPrice("2000", false, 10_000, 4)).toThrow();
  });
  test("full close uses current signed exposure, partial cannot reverse it", async () => {
    const engine = fixture().make();
    const preview = await engine.preview({ kind: "close", coin: "ETH" });
    expect((preview.action.orders as any[])[0]).toMatchObject({ b: true, s: "0.25", r: true, t: { limit: { tif: "Ioc" } } });
    await expect(engine.preview({ kind: "close", coin: "ETH", size: "0.2501" })).rejects.toThrow("exceeds");
    await expect(engine.preview({ ...intent, size: "0.00001" })).rejects.toThrow("decimal places");
  });
  test("cancel all excludes spot and HIP-3; triggers always reduce exposure", async () => {
    const engine = fixture().make();
    expect((await engine.preview({ kind: "cancelAll" })).action).toEqual({ type: "cancel", cancels: [{ a: 0, o: 1 }, { a: 1, o: 4 }] });
    const trigger = await engine.preview({ kind: "trigger", coin: "ETH", side: "sell", size: "0.1", triggerPrice: "1900", triggerKind: "sl", execution: "market" });
    expect((trigger.action.orders as any[])[0]).toMatchObject({ r: true, p: "1890.5", t: { trigger: { isMarket: true, triggerPx: "1900", tpsl: "sl" } } });
    expect((await engine.preview({ kind: "margin", coin: "ETH", amountUsdc: "-0.000001" })).action).toEqual({ type: "updateIsolatedMargin", asset: 0, isBuy: true, ntli: -1 });
  });
});

describe("Durable dispatch and recovery", () => {
  test("IndexedDB survives store recreation and serializes nonce allocation and conflicting writers", async () => {
    const store = new IndexedTradingStore();
    const scope = `test-${crypto.randomUUID()}`;
    const row: JournalRecord = { key: `${scope}:operation`, scope, operationId, revision: 0, createdAt: 1, updatedAt: 1, state: "prepared" };
    await store.add(row);
    const reloaded = new IndexedTradingStore();
    expect(await reloaded.get(row.key)).toEqual(row);
    const results = await Promise.allSettled([store.update({ ...row, revision: 1, state: "signed" }, 0), reloaded.update({ ...row, revision: 1, state: "rejected" }, 0)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.get(row.key))?.revision).toBe(1);
    const nonces = await Promise.all(Array.from({ length: 16 }, () => new IndexedTradingStore().nextNonce(scope, 1000)));
    expect(new Set(nonces).size).toBe(16);
    expect(Math.min(...nonces)).toBe(1000);
    expect(Math.max(...nonces)).toBe(1015);
  });
  test("saves exact envelope before dispatch and reports partial IOC fill", async () => {
    const state = fixture({ response: async () => Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid: 42, totalSz: "0.04", avgPx: "2001" } }] } } }) });
    const result = await state.make().execute({ operationId, intent });
    expect(result.state).toBe("partial");
    expect(result.orders[0]).toMatchObject({ filledSize: "0.04", averagePrice: "2001" });
    expect(result.orders[0]?.cloid).toMatch(/^0x[0-9a-f]{32}$/);
    expect(state.reviews).toHaveLength(1);
    expect((state.reviews[0] as any).action).toEqual(JSON.parse(state.sent[0]!).action);
    expect(JSON.stringify(result)).not.toContain('"signature"');
  });
  test("HTTP success still distinguishes an order rejection from missing per-order evidence", async () => {
    const rejected = fixture({ response: async () => Response.json({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } } }) });
    expect((await rejected.make().execute({ operationId, intent })).state).toBe("rejected");
    const incomplete = fixture({ response: async () => Response.json({ status: "ok", response: { type: "default" } }) });
    expect((await incomplete.make().execute({ operationId, intent })).state).toBe("uncertain");
  });
  test("preview uses observed fees and identifies unified collateral without summing balances", async () => {
    const state = fixture();
    const observed = { environment: "testnet", observedAt: 1234, complete: true, errors: [], warnings: [], abstraction: "unifiedAccount", balanceSource: "unified", clearinghouseState: { marginSummary: { accountValue: "500", totalMarginUsed: "100" }, crossMaintenanceMarginUsed: "10", withdrawable: "300" }, positions: [], balances: { balances: [{ coin: "USDC", total: "500", hold: "100" }] }, fees: { userCrossRate: "0.00045", userAddRate: "0.00015" } };
    const engine = state.make({ data: { info: state.info, account: async () => observed } });
    const result = await engine.preview(intent);
    expect(result.review.estimatedFeesUsdc).toEqual({ taker: "0.0904725", maker: "0.0301575" });
    expect(result.review.account).toMatchObject({ abstraction: "unifiedAccount", balanceSource: "unified", marginSummary: { accountValue: "500" }, sharedBalances: observed.balances });
    expect(result.review.fees).toEqual({ takerRate: "0.00045", makerRate: "0.00015", observedAt: 1234 });
  });
  test("order review estimates include the observed referral discount without changing raw fees", async () => {
    const state = fixture();
    const fees = { userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0.04" };
    const observed = { environment: "testnet", observedAt: 1234, complete: true, errors: [], warnings: [], abstraction: "disabled", balanceSource: "perps", clearinghouseState: null, positions: [], balances: null, fees };
    const engine = state.make({ data: { info: state.info, account: async () => observed } });
    const result = await engine.preview({ kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "1", price: "2000" });
    expect(result.review.estimatedFeesUsdc).toEqual({ taker: "0.864", maker: "0.288" });
    expect(result.review.fees).toEqual({ takerRate: "0.000432", makerRate: "0.000144", activeReferralDiscount: "0.04", observedAt: 1234 });
    expect(fees).toEqual({ userCrossRate: "0.00045", userAddRate: "0.00015", activeReferralDiscount: "0.04" });
  });
  test("timeout + reload never generates a fresh signed request; explicit retry preserves bytes", async () => {
    let requests = 0;
    const state = fixture({ response: async () => { requests++; if (requests === 1) throw new TypeError("Network response lost"); return Response.json({ status: "err", response: "Duplicate nonce" }); } });
    const initial = await state.make().execute({ operationId, intent });
    expect(initial.state).toBe("uncertain");
    const reloaded = state.make();
    expect((await reloaded.execute({ operationId, intent })).state).toBe("uncertain");
    expect(state.sent).toHaveLength(1); expect(state.signed()).toBe(1); expect(state.reviews).toHaveLength(1);
    expect((await reloaded.retryExact(operationId)).state).toBe("uncertain");
    expect(state.sent[1]).toBe(state.sent[0]); expect(state.signed()).toBe(1); expect(state.reviews).toHaveLength(2);
    await expect(reloaded.execute({ operationId, intent: { ...intent, size: "0.2" } })).rejects.toThrow("different trading intent");
  });
  test("concurrent duplicate executions dispatch once and separate IDs use increasing nonces", async () => {
    const state = fixture();
    const engine = state.make();
    const results = await Promise.all([engine.execute({ operationId, intent }), engine.execute({ operationId, intent })]);
    expect(results[0]?.orders[0]?.cloid).toBe(results[1]?.orders[0]?.cloid);
    expect(state.sent).toHaveLength(1);
    await engine.execute({ operationId: "fedcba9876543210fedcba9876543210", intent });
    expect(JSON.parse(state.sent[1]!).nonce).toBeGreaterThan(JSON.parse(state.sent[0]!).nonce);
    expect(JSON.parse(state.sent[1]!).action.orders[0].c).not.toBe(JSON.parse(state.sent[0]!).action.orders[0].c);
  });
  test("authenticated caller and wallet binding isolate operation history", async () => {
    const state = fixture();
    await state.make().execute({ operationId, intent });
    const other = state.make({ caller: { ...caller, installationUid: "different-installation" } });
    await expect(other.reconcile(operationId)).rejects.toThrow("Unknown operation");
    expect(await other.history()).toEqual([]);
    await expect(state.make({ binding: { ...binding, walletAddress: "0x2222222222222222222222222222222222222222" } }).reconcile(operationId)).rejects.toThrow("Unknown operation");
    const visible = await other.history({ allCallers: true });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ caller, ownedByCaller: false, canRetryExact: false });
    expect(JSON.stringify(visible)).not.toContain('"signature"');
    expect(JSON.stringify(visible)).not.toContain('"envelope"');
    expect(await state.make({ binding: { ...binding, environment: "mainnet" } }).history({ allCallers: true })).toEqual([]);
  });
  test("cancellation during review prevents signing and dispatch", async () => {
    const controller = new AbortController();
    const state = fixture({ signal: controller.signal, authorize: async () => controller.abort() });
    await expect(state.make().execute({ operationId, intent })).rejects.toThrow();
    expect(state.signed()).toBe(0); expect(state.sent).toHaveLength(0);
  });
  test("storage failure before signed envelope commit prevents exchange effects", async () => {
    class FailingStore extends MemoryTradingStore {
      override async update(record: JournalRecord, revision: number) { if (record.state === "signed") throw new Error("Storage full"); return super.update(record, revision); }
    }
    const state = fixture({ store: new FailingStore() });
    await expect(state.make().execute({ operationId, intent })).rejects.toThrow("Storage full");
    expect(state.sent).toHaveLength(0);
  });
  test("a canceled zero-remainder order is not misreported as fully filled", async () => {
    const state = fixture({ response: async () => { throw new Error("Lost response"); }, status: () => ({ status: "order", order: { order: { coin: "ETH", oid: 99, origSz: "0.1", sz: "0" }, status: "canceled", statusTimestamp: 1_780_000_000_000 } }) });
    const result = await state.make().execute({ operationId, intent });
    expect(result.state).toBe("canceled"); expect(result.orders[0]?.filledSize).toBeUndefined();
  });
  test("reconciliation deduplicates fills and reports actual partial quantity", async () => {
    const fill = { oid: 99, tid: 123, hash: "0xabc", coin: "ETH", sz: "0.04", px: "2001" };
    const state = fixture({ response: async () => { throw new Error("Lost response"); }, status: () => ({ status: "order", order: { order: { coin: "ETH", oid: 99, origSz: "0.1", sz: "0" }, status: "filled", statusTimestamp: 1_780_000_000_000 } }), fills: [fill, fill] });
    const result = await state.make().execute({ operationId, intent });
    expect(result.state).toBe("partial"); expect(result.orders[0]).toMatchObject({ filledSize: "0.04", averagePrice: "2001" });
  });
  test("missing fill observations are not represented as zero executed quantity", async () => {
    const state = fixture({ response: async () => { throw new Error("Lost response"); }, status: () => ({ status: "order", order: { order: { coin: "ETH", oid: 99, origSz: "0.1", sz: "0" }, status: "filled", statusTimestamp: 1_780_000_000_000 } }) });
    const engine = state.make({ data: { info: async (body: Record<string, unknown>) => { if (body.type === "userFillsByTime") throw new Error("Fills unavailable"); return state.info(body); } } });
    const result = await engine.execute({ operationId, intent });
    expect(result.state).toBe("filled");
    expect(result.orders[0]?.filledSize).toBeUndefined();
    expect(result.reconciliation?.errors).toContain("Fills unavailable");
  });
});
