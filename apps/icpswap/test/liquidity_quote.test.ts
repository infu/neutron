import { describe, expect, test } from "bun:test";
import type { JsonObject } from "neutron-tools/app";
import { Principal } from "@icp-sdk/core/principal";
import { IDL } from "@dfinity/candid";
import { parseLiquidityPlan, type LiquidityWire } from "../src/action_backend.ts";
import { browserPoolToWire, previewLiquidity } from "../src/liquidity_quote.ts";
import { createLiquidityReadClient, ICPSWAP_FACTORY, liquidityReadMethods, type BrowserPoolView, type BrowserPosition, type LiquidityReadMethod } from "../src/liquidity_reads.ts";
import { Q96, getSqrtRatioAtTick, MIN_TICK, MAX_TICK } from "../src/liquidity_math.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const TOKEN0 = { address: "ryjl3-tyaaa-aaaaa-aaaba-cai", standard: "ICRC2" };
const TOKEN1 = { address: "xevnm-gaaaa-aaaar-qafnq-cai", standard: "ICRC2" };
const position = (): BrowserPosition => ({ id: "7", tickLower: -60, tickUpper: 120, liquidity: "123456",
  amount0: "738", amount1: "369", tokensOwed0: "11", tokensOwed1: "22", feeError: null });
function view(): BrowserPoolView {
  return {
    pool: { pool: POOL, key: "ICP/ckUSDC", token0: { ...TOKEN0 }, token1: { ...TOKEN1 }, fee: 3000, tickSpacing: 60 },
    owner: OWNER, metadata: { sqrtPriceX96: Q96.toString(), tick: 0, liquidity: "987654321098765432109876543210" },
    positions: [position()], unused: { balance0: "250000", balance1: "500000" },
    reserved: { balance0: "0", balance1: "0" }, availableUnused: { balance0: "250000", balance1: "500000" },
    cachedFees: { token0Fee: "10000", token1Fee: "10000" }, available: true, withdrawals: [], transactions: [], errors: [],
    source: { kind: "direct-canister-query", host: "https://icp-api.io", observedAt: "2026-09-09T00:00:00.123Z" },
  };
}
function request(overrides: Partial<LiquidityWire> = {}): LiquidityWire {
  return { pool: POOL, kind: "mint", position_id: null, tick_lower: "-60", tick_upper: "120",
    amount0: "1000000", amount1: "2000000", liquidity: "0", withdraw_token: "", withdraw_amount: "0", ...overrides };
}
function fixture(observed = view()) {
  const calls: unknown[][] = [];
  const reads = { readPool: async (...args: [string, string?, AbortSignal?]) => { calls.push(args); return observed; } };
  return { observed, calls, reads, preview: (input = request(), signal?: AbortSignal) => previewLiquidity(input, OWNER, reads, signal) };
}

describe("browser-only ICPSwap liquidity preview", () => {
  test("matches the independent Motoko actor mint fixture and keeps compatible exact plan fields", async () => {
    // Fixed values from liquidity_backend_actor_test.mo, not recomputed by the
    // implementation under test: maxima are not expected consumption.
    const { preview, calls } = fixture();
    const input = request(), plan = await preview(input);
    expect(plan).toMatchObject({ pool: POOL, owner: OWNER, funding0: "750000", funding1: "1500000",
      expected_liquidity: "167175499", expected_amount0: "1000000", expected_amount1: "500750",
      observed_at: "1788912000123000000", price_protection: false });
    expect(plan.request).toEqual(input);
    expect(calls).toEqual([[POOL, OWNER, undefined]]);
    const { source: _source, read_errors: _errors, ...wire } = plan;
    expect(parseLiquidityPlan(wire)).toEqual(wire);
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  test("funding respects reservations and does not subtract expected use", async () => {
    const observed = view();
    observed.reserved = { balance0: "100000", balance1: "200000" };
    observed.availableUnused = { balance0: "150000", balance1: "300000" };
    const result = await fixture(observed).preview();
    expect(result.funding0).toBe("850000"); expect(result.funding1).toBe("1700000");
    expect(result.expected_amount1).toBe("500750");
  });

  test("existing pool credit can fully fund otherwise unsupported token standards", async () => {
    const observed = view();
    observed.pool.token0.standard = "DIP20"; observed.pool.token1.standard = "DIP20";
    observed.unused = { balance0: "1000001", balance1: "2000001" };
    observed.availableUnused = { ...observed.unused };
    const result = await fixture(observed).preview();
    expect([result.funding0, result.funding1]).toEqual(["0", "0"]);
    observed.availableUnused.balance0 = "0";
    await expect(fixture(observed).preview()).rejects.toThrow("Wallet funding is unavailable for the pool token standard DIP20");
  });

  test("ICRC2 deficits must exceed the pool fee, unlike supported direct-deposit standards", async () => {
    for (const deficit of [1n, 10000n]) {
      const observed = view();
      observed.availableUnused!.balance0 = (1000000n - deficit).toString();
      await expect(fixture(observed).preview()).rejects.toThrow("deficit greater than the token fee");
      for (const standard of ["ICP", "ICRC1"]) {
        observed.pool.token0.standard = standard;
        expect((await fixture(observed).preview()).funding0).toBe(deficit.toString());
      }
    }
    const observed = view(); observed.availableUnused!.balance0 = "989999";
    expect((await fixture(observed).preview()).funding0).toBe("10001");
  });

  test("increase uses the current owned position ticks rather than caller-supplied ticks", async () => {
    const result = await fixture().preview(request({ kind: "increase", position_id: "0007", tick_lower: "120", tick_upper: "-60" }));
    expect(result.request).toMatchObject({ kind: "increase", position_id: "7", tick_lower: "-60", tick_upper: "120" });
    expect(result.expected_liquidity).toBe("167175499");
  });

  test("partial decrease floors principal and adds ALL current fees", async () => {
    const result = await fixture().preview(request({ kind: "decrease", position_id: "7", liquidity: "30864" }));
    // 25% principal is 184/92 atoms at these fixed bounds; fees are 11/22.
    expect([result.expected_amount0, result.expected_amount1, result.expected_liquidity]).toEqual(["195", "114", "30864"]);
    expect([result.funding0, result.funding1]).toEqual(["0", "0"]);
  });

  test("close captures the entire observed liquidity and current fees", async () => {
    const result = await fixture().preview(request({ kind: "close", position_id: "7", liquidity: "1" }));
    expect(result.request).toMatchObject({ liquidity: "123456" });
    expect([result.expected_amount0, result.expected_amount1, result.expected_liquidity]).toEqual(["749", "391", "123456"]);
  });

  test("claim returns known fees including a valid zero-payout preview", async () => {
    const observed = view(); const input = request({ kind: "claim", position_id: "7" });
    const result = await fixture(observed).preview(input);
    expect([result.expected_amount0, result.expected_amount1, result.expected_liquidity]).toEqual(["11", "22", "0"]);
    observed.positions![0]!.tokensOwed0 = "0"; observed.positions![0]!.tokensOwed1 = "0";
    expect(await fixture(observed).preview(input)).toMatchObject({ expected_amount0: "0", expected_amount1: "0", expected_liquidity: "0" });
  });

  test("withdrawal amounts are gross, exceed the token fee and fit unreserved credit", async () => {
    const observed = view(); observed.reserved = { balance0: "100000", balance1: "200000" };
    observed.availableUnused = { balance0: "150000", balance1: "300000" };
    const preview = fixture(observed).preview;
    expect(await preview(request({ kind: "withdraw", withdraw_token: TOKEN0.address, withdraw_amount: "150000" })))
      .toMatchObject({ expected_amount0: "150000", expected_amount1: "0", expected_liquidity: "0", funding0: "0", funding1: "0" });
    expect(await preview(request({ kind: "withdraw", withdraw_token: TOKEN1.address, withdraw_amount: "300000" })))
      .toMatchObject({ expected_amount0: "0", expected_amount1: "300000" });
    for (const amount of ["0", "10000", "150001"]) await expect(preview(request({ kind: "withdraw", withdraw_token: TOKEN0.address, withdraw_amount: amount })))
      .rejects.toThrow("gross unused withdrawal");
    await expect(preview(request({ kind: "withdraw", withdraw_token: OWNER, withdraw_amount: "10001" }))).rejects.toThrow("one of the verified pool tokens");
  });

  test("unknown reservation state blocks funding previews but does not hide a known fee claim", async () => {
    const observed = view(); observed.transactions = null; observed.reserved = null; observed.availableUnused = null;
    observed.errors = [{ canister: POOL, method: "getTransactionsByOwner", message: "query unavailable" }];
    const preview = fixture(observed).preview;
    for (const kind of ["mint", "increase", "withdraw"]) await expect(preview(request({ kind, position_id: kind === "increase" ? "7" : null,
      withdraw_token: TOKEN0.address, withdraw_amount: "10001" }))).rejects.toThrow("Unreserved pool balance is unavailable");
    expect((await preview(request({ kind: "claim", position_id: "7" }))).expected_amount0).toBe("11");
  });

  test("missing selected-position reads are errors, while unrelated failures stay nullable", async () => {
    const observed = view();
    observed.positions!.push({ ...position(), id: "8", amount0: null, amount1: null, tokensOwed0: null, tokensOwed1: null, feeError: "getUserPosition unavailable" });
    const result = await fixture(observed).preview(request({ kind: "claim", position_id: "7" }));
    const baseline = result.baseline_positions as JsonObject[];
    expect(baseline[1]).toMatchObject({ id: "8", amount0: null, amount1: null, fees0: null, fees1: null, fees_current: false, error: "getUserPosition unavailable" });
    for (const kind of ["increase", "decrease", "close", "claim"]) {
      await expect(fixture(observed).preview(request({ kind, position_id: "8", liquidity: "1" }))).rejects.toThrow("Current position state is unavailable");
      await expect(fixture(observed).preview(request({ kind, position_id: "9", liquidity: "1" }))).rejects.toThrow("does not own");
      await expect(fixture(observed).preview(request({ kind, position_id: null, liquidity: "1" }))).rejects.toThrow("position ID is required");
    }
  });

  test("an unavailable required observation does not become an empty or zero plan", async () => {
    for (const field of ["metadata", "cachedFees", "available", "positions", "unused"] as const) {
      const observed = view(); observed[field] = null;
      await expect(fixture(observed).preview()).rejects.toThrow("unavailable");
    }
    const observed = view(); observed.available = false;
    await expect(fixture(observed).preview()).rejects.toThrow("not available to this Neutron");
    observed.owner = "aaaaa-aa";
    await expect(fixture(observed).preview()).rejects.toThrow("does not match");
  });

  test("range and protocol bounds match preparation instead of reordering or clamping input", async () => {
    for (const [lower, upper] of [[120, -60], [60, 60], [-61, 120], [-887280, 120]]) {
      await expect(fixture().preview(request({ tick_lower: String(lower), tick_upper: String(upper) }))).rejects.toThrow();
    }
    for (const sqrtPrice of [getSqrtRatioAtTick(MIN_TICK) - 1n, getSqrtRatioAtTick(MAX_TICK)]) {
      const observed = view(); observed.metadata!.sqrtPriceX96 = sqrtPrice.toString();
      await expect(fixture(observed).preview()).rejects.toThrow("initialized protocol range");
    }
    await expect(fixture().preview(request({ amount0: "0", amount1: "0" }))).rejects.toThrow("zero liquidity");
    await expect(fixture().preview(request({ amount0: (1n << 256n).toString() }))).rejects.toThrow("protocol integer range");
    await expect(fixture().preview(request({ amount0: (1n << 128n).toString(), amount1: (1n << 128n).toString() }))).rejects.toThrow("Liquidity");
    for (const liquidity of ["0", "123457"]) await expect(fixture().preview(request({ kind: "decrease", position_id: "7", liquidity }))).rejects.toThrow("removal amount must be positive");
  });

  test("out-of-range sizing uses only the required token without coercing atomic amounts to Number", async () => {
    const observed = view(); observed.metadata = { ...observed.metadata!, sqrtPriceX96: getSqrtRatioAtTick(-120).toString(), tick: -120 };
    observed.unused = { balance0: "0", balance1: "0" }; observed.availableUnused = { ...observed.unused };
    const budget = "900719925474099312345";
    const result = await fixture(observed).preview(request({ amount0: budget, amount1: "0" }));
    expect(result.funding0).toBe(budget); expect(result.funding1).toBe("0");
    expect(result.expected_amount1).toBe("0");
    expect(BigInt(result.expected_amount0 as string)).toBeLessThanOrEqual(BigInt(budget));
    expect(BigInt(result.expected_amount0 as string)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  test("invalid intents and cancellation send no queries; cancellation after a reply returns no stale preview", async () => {
    const f = fixture();
    for (const input of [request({ kind: "unknown" }), request({ amount0: "-1" }), request({ tick_lower: "0.5" })]) await expect(f.preview(input)).rejects.toThrow();
    const controller = new AbortController(); controller.abort(new Error("Stopped"));
    await expect(f.preview(request(), controller.signal)).rejects.toThrow("Stopped"); expect(f.calls).toEqual([]);
    const after = new AbortController();
    await expect(previewLiquidity(request(), OWNER, { readPool: async () => { after.abort(new Error("Superseded")); return view(); } }, after.signal)).rejects.toThrow("Superseded");
  });
});

describe("compatible direct pool reconciliation fields", () => {
  test("keeps exact queue/transaction data and sums only the corresponding scheduled net tokens", () => {
    const observed = view();
    observed.withdrawals = [
      { transactionId: "900719925474099312345", token: TOKEN0.address, amount: "900719925474099312345", fee: "10000", owner: OWNER, recipient: OWNER, recipientSubaccount: null },
      { transactionId: "2", token: TOKEN0.address, amount: "3", fee: "10000", owner: OWNER, recipient: OWNER, recipientSubaccount: "01".repeat(32) },
      { transactionId: "3", token: TOKEN1.address, amount: "20000", fee: "10000", owner: OWNER, recipient: OWNER, recipientSubaccount: null },
    ];
    observed.transactions = [{ id: "1", owner: OWNER, timestampNs: "1788912000123456789", action: "Withdraw", status: "Created", error: null,
      token: TOKEN0.address, amount: "900719925474099322345", unusedReserved: true, supportRequired: false }];
    const mapped = browserPoolToWire(observed);
    expect(mapped.queued0).toBe("900719925474099312348"); expect(mapped.queued1).toBe("20000");
    expect(mapped.transactions).toEqual([{ id: "1", kind: "Withdraw", state: "Created", error: "", token: TOKEN0.address, amount: "900719925474099322345", unused_reserved: true, support_required: false }]);
    expect((mapped.queue as JsonObject[])[1]?.recipient_subaccount).toBe("01".repeat(32));
    expect(mapped.observed_at).toBe("1788912000123000000");
    expect(JSON.parse(JSON.stringify(mapped))).toEqual(mapped);
  });

  test("unknown observations remain null while successfully observed empty lists and zeros remain exact", () => {
    const observed = view();
    expect(browserPoolToWire(observed)).toMatchObject({ queued0: "0", queued1: "0", queue: [], reserved0: "0", available: true });
    for (const field of ["metadata", "positions", "unused", "reserved", "availableUnused", "cachedFees", "available", "withdrawals", "transactions"] as const) observed[field] = null;
    const result = browserPoolToWire(observed);
    for (const field of ["tick", "sqrt_price_x96", "liquidity", "positions", "unused0", "unused1", "reserved0", "reserved1", "fee0", "fee1", "available", "queued0", "queued1", "queue", "transactions"]) expect(result[field]).toBeNull();
  });
});

test("the preview uses real public Candid query projections, with no Wallet or Neutron request", async () => {
  const calls: { canister: string; method: string }[] = [];
  const principal = (value: string) => Principal.fromText(value);
  const rawPosition = { id: 7n, tickLower: -60n, tickUpper: 120n, liquidity: 123456n, tokensOwed0: 11n, tokensOwed1: 22n };
  const handlers: Partial<Record<LiquidityReadMethod, unknown>> = {
    getPools: { ok: [{ key: "ICP/ckUSDC", token0: TOKEN0, token1: TOKEN1, fee: 3000n, tickSpacing: 60n, canisterId: principal(POOL) }] },
    metadata: { ok: { key: "ICP/ckUSDC", token0: TOKEN0, token1: TOKEN1, fee: 3000n, sqrtPriceX96: Q96, tick: 0n, liquidity: 123456n } },
    getCachedTokenFee: { token0Fee: 10000n, token1Fee: 10000n }, getAvailabilityState: { available: true, whiteList: [] },
    getUserPositionsByPrincipal: { ok: [rawPosition] }, getUserPosition: { ok: rawPosition },
    getUserUnusedBalance: { ok: { balance0: 250000n, balance1: 500000n } },
    getWithdrawQueueInfo: { ok: { items: [], isProcessing: false, queueSize: 0n } },
    getTransactionsByOwner: { ok: [] },
  };
  const reads = createLiquidityReadClient({ now: () => 1788912000123, query: async ({ canister, method, args }) => {
    calls.push({ canister, method });
    const schema = liquidityReadMethods[method];
    expect(IDL.decode(schema.args, IDL.encode(schema.args, args))).toHaveLength(args.length);
    if (["getUserPositionsByPrincipal", "getUserUnusedBalance", "getTransactionsByOwner"].includes(method)) expect((args[0] as Principal).toText()).toBe(OWNER);
    return IDL.decode([schema.output], IDL.encode([schema.output], [handlers[method]]))[0];
  } });
  const result = await previewLiquidity(request(), OWNER, reads);
  expect(result).toMatchObject({ expected_liquidity: "167175499", expected_amount0: "1000000", expected_amount1: "500750", funding0: "750000", funding1: "1500000" });
  expect(calls.every((call) => [POOL, ICPSWAP_FACTORY].includes(call.canister))).toBe(true);
  expect(calls.map((call) => call.method)).not.toContain("getUserWithdrawQueue");
  expect(calls.findIndex((call) => call.method === "getTransactionsByOwner")).toBeLessThan(calls.findIndex((call) => call.method === "getUserUnusedBalance"));
});
