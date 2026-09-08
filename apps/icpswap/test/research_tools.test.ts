import { afterEach, describe, expect, test } from "bun:test";
import { type JsonObject, type MsgBusToolContext, type MsgBusToolHandler, normalizeToolDescriptor } from "neutron-tools/app";
import { calculateLiquidityRange, registerTools, retainedPoolsFromOperations, type ResearchToolDependencies } from "../src/tools.ts";
import { type BrowserPoolView, type PoolIdentity } from "../src/liquidity_reads.ts";
import { Q96 } from "../src/liquidity_math.ts";
import { invalidateCache } from "../src/api.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const pool: PoolIdentity = { pool: POOL, key: "ICP_USDC_3000", token0: { address: ICP, standard: "ICRC2" }, token1: { address: USDC, standard: "ICRC2" }, fee: 3000, tickSpacing: 60 };
const source = { kind: "direct-canister-query" as const, host: "https://icp-api.io", observedAt: "2026-09-08T19:00:00.000Z" };
const view: BrowserPoolView = { pool, owner: OWNER, metadata: { sqrtPriceX96: Q96.toString(), tick: 0, liquidity: "10000000000" }, positions: [], unused: { balance0: "0", balance1: "0" }, reserved: { balance0: "0", balance1: "0" }, availableUnused: { balance0: "0", balance1: "0" }, cachedFees: { token0Fee: "10000", token1Fee: "10000" }, available: true, withdrawals: [], transactions: [], errors: [], source };
const context: MsgBusToolContext = { kernel: {} as MsgBusToolContext["kernel"], reportProgress() {} };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  invalidateCache();
});

function fixture(overrides: Partial<ResearchToolDependencies> = {}) {
  const handlers = new Map<string, MsgBusToolHandler>();
  const descriptors = new Map<string, ReturnType<typeof normalizeToolDescriptor>>();
  const reads: ResearchToolDependencies["reads"] = {
    discoverPools: async () => ({ pools: [pool], source }),
    discoverOwnedPools: async (owner, retainedPools = []) => ({ pools: [pool], owner, indexedPools: [POOL], retainedPools, errors: [], source }),
    readPool: async (_pool, owner) => ({ ...view, owner: owner ?? null }),
    invalidate() {},
  };
  registerTools({ accountFor: async () => OWNER, retainedPoolsFor: async () => [], reads, ...overrides, expose: (name, options, handler) => {
    descriptors.set(name, normalizeToolDescriptor({ name, ...options }));
    handlers.set(name, handler);
  } });
  return { handlers, descriptors, run: async (name: string, args: JsonObject = {}, ctx: MsgBusToolContext = context) => await handlers.get(name)!(args, ctx) as JsonObject };
}

describe("ICPSwap research registration", () => {
  test("all descriptors validate and no research alias bypasses the saved action workflow", () => {
    const { handlers } = fixture();
    expect(handlers.has("icpswap_liquidity_range_v1")).toBe(true);
    expect(handlers.has("icpswap_execute_swap")).toBe(false);
    expect(handlers.has("icpswap_agent_swap")).toBe(false);
  });

  test("watchlist tools remain cross-app discoverable under normal Kernel permissions", () => {
    const { descriptors } = fixture();
    for (const name of ["icpswap_watchlist_add", "icpswap_watchlist_remove"]) {
      const descriptor = descriptors.get(name)!;
      expect(descriptor.annotations?.["neutron:visibility"]).toBeUndefined();
      expect(descriptor.annotations?.["neutron:audience"]).toBeUndefined();
      expect(descriptor.annotations?.["neutron:consent"]).toBeUndefined();
      expect(descriptor.annotations?.readOnlyHint).toBe(false);
      expect(descriptor.inputSchema.required).toEqual(["ledger_id"]);
    }
  });

  test.each([true, false])("watchlist addition uses the calling transport without financial calls (analytics available: %s)", async (analyticsAvailable) => {
    invalidateCache();
    globalThis.fetch = (async () => {
      if (!analyticsAvailable) throw new Error("analytics unavailable");
      return new Response(JSON.stringify({ code: 200, data: [{ tokenLedgerId: ICP, tokenSymbol: "ICP", tokenName: "Internet Computer" }] }));
    }) as unknown as typeof fetch;
    const calls: unknown[] = [];
    const currentContext = {
      ...context,
      kernel: {
        updateSelf: async (method: string, args: unknown[]) => {
          calls.push({ method, args });
          return { ok: true, message: "Added to the watchlist", watchlist_size: "3" };
        },
      } as unknown as MsgBusToolContext["kernel"],
    };
    const result = await fixture().run("icpswap_watchlist_add", { ledger_id: ICP }, currentContext);
    expect(calls).toEqual([{ method: "icpswap_add", args: [{ address: ICP, symbol: analyticsAvailable ? "ICP" : "", name: analyticsAvailable ? "Internet Computer" : "", standard: "", decimals: "0" }] }]);
    expect(result).toEqual({ ok: true, message: "Added to the watchlist", watchlist_size: 3, ledger_id: ICP });
  });

  test("watchlist and legacy journal reads use the current invocation transport", async () => {
    const seen: unknown[] = [];
    const { run } = fixture({ backendFor: (kernel) => {
      seen.push(kernel);
      return {
        removeToken: async (ledger: string) => ({ ok: true, message: ledger, watchlistSize: 2 }),
        getSwapJournal: async () => ({ completed: 0, total: 0, slippage: 500, entries: [] }),
      } as unknown as ReturnType<NonNullable<ResearchToolDependencies["backendFor"]>>;
    } });
    const secondContext = { ...context, kernel: { querySelf: async () => null } as unknown as MsgBusToolContext["kernel"] };
    await run("icpswap_watchlist_remove", { ledger_id: ICP });
    await run("icpswap_swap_history", {}, secondContext);
    expect(seen).toEqual([context.kernel, secondContext.kernel]);
  });

  test("swap quotes refresh both ledger fees before pricing and do not hide metadata failures", async () => {
    const events: string[] = [];
    const deps: Partial<ResearchToolDependencies> = {
      tokenInfoFor: async (_context, ledger) => {
        events.push(`read:${ledger}`);
        return { ledger, account: OWNER, name: null, symbol: "TOKEN", decimals: 8, feeAtoms: 0n, balanceAtoms: 1000000n, observedAtNs: 1n };
      },
      backendFor: () => ({
        setTokenInfo: async (ledger: string, decimals: number, fee: bigint) => { events.push(`cache:${ledger}:${decimals}:${fee}`); },
        quoteSwap: async () => { events.push("quote"); throw new Error("price marker"); },
      }) as unknown as ReturnType<NonNullable<ResearchToolDependencies["backendFor"]>>,
    };
    const args = { from_ledger_id: ICP, to_ledger_id: USDC, amount: "100000" };
    await expect(fixture(deps).run("icpswap_quote_swap", args)).rejects.toThrow("price marker");
    expect(events).toEqual([`read:${ICP}`, `cache:${ICP}:8:0`, `read:${USDC}`, `cache:${USDC}:8:0`, "quote"]);
    events.length = 0;
    await expect(fixture({ ...deps, tokenInfoFor: async () => { throw new Error("live fee unavailable"); } }).run("icpswap_quote_swap", args)).rejects.toThrow("live fee unavailable");
    expect(events).toEqual([]);
  });

  test("pool reads derive the real account and preserve unknown fields and errors", async () => {
    const { run } = fixture({ reads: {
      ...({} as NonNullable<ResearchToolDependencies["reads"]>),
      readPool: async (_pool, owner, signal) => {
        expect(owner).toBe(OWNER);
        expect(signal).toBe(context.signal);
        return { ...view, positions: null, unused: null, reserved: null, availableUnused: null, errors: [{ canister: POOL, method: "getUserPositionsByPrincipal", message: "offline" }] };
      },
    } });
    const result = await run("icpswap_liquidity_pool_v1", { pool: POOL });
    expect(result.complete).toBe(false);
    expect(result.positions).toBe(null);
    expect(result.unused).toBe(null);
    expect(result.reserved).toBe(null);
    expect(result.availableUnused).toBe(null);
    expect(result.errors).toHaveLength(1);
  });

  test("one malformed journal row cannot hide other retained pools or its own effect hint", async () => {
    const restored = retainedPoolsFromOperations([
      { id: "good", input_json: JSON.stringify({ kind: "liquidity", input: { pool: POOL } }) },
      { id: "damaged", input_json: "{broken", effects: [{ canister: "aaaaa-aa" }] },
      { id: "no-input", input_json: "{}", effects: [{ canister: "rrkah-fqaaa-aaaaa-aaaaq-cai" }] },
      { id: "swap", input_json: JSON.stringify({ kind: "swap", input: { amount: "100" } }), effects: [{ canister: POOL }] },
    ]);
    expect(restored.pools).toEqual([POOL, "aaaaa-aa", "rrkah-fqaaa-aaaaa-aaaaq-cai"]);
    expect(restored.errors.map((error) => error.operationId)).toEqual(["damaged", "no-input"]);
    const { run } = fixture({ retainedPoolsFor: async () => restored });
    const result = await run("icpswap_positions_v1");
    expect(result.complete).toBe(false);
    expect(result.pools).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
  });

  test("owned discovery includes retained pools and reports incomplete coverage", async () => {
    const { run } = fixture({ retainedPoolsFor: async () => [POOL], reads: {
      ...({} as NonNullable<ResearchToolDependencies["reads"]>),
      discoverOwnedPools: async (owner, retainedPools = []) => {
        expect(owner).toBe(OWNER);
        expect(retainedPools).toEqual([POOL]);
        return { pools: [pool], owner, retainedPools, indexedPools: null, source, errors: [{ canister: "index", method: "getUserPools", message: "offline" }] };
      },
      readPool: async () => view,
    } });
    const result = await run("icpswap_positions_v1");
    expect(result.indexedPools).toBe(null);
    expect(result.retainedPools).toEqual([POOL]);
    expect(result.pools).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.nextCursor).toBe(null);
  });

  test("pool pagination does not silently discard later matches", async () => {
    const pools = ["aaaaa-aa", "mohjv-bqaaa-aaaag-qjyia-cai", "rrkah-fqaaa-aaaaa-aaaaq-cai"].map((id) => ({ ...pool, pool: id }));
    const { run } = fixture({ reads: { ...({} as NonNullable<ResearchToolDependencies["reads"]>), discoverPools: async () => ({ pools, source }) } });
    const first = await run("icpswap_liquidity_pools_v1", { token: ICP, limit: 1 });
    const second = await run("icpswap_liquidity_pools_v1", { token: ICP, limit: 2, cursor: first.nextCursor as string });
    expect(first.total).toBe(3);
    expect(first.pools).toHaveLength(1);
    expect(second.pools).toHaveLength(2);
    expect(second.nextCursor).toBe(null);
    await expect(run("icpswap_liquidity_pools_v1", { cursor: "missing" })).rejects.toThrow("restart");
  });
});

describe("exact range tool", () => {
  test("preserves high-precision atoms and expected remaining balances", () => {
    const amount = "1000000000000000000000000";
    const result = calculateLiquidityRange(view, { tickLower: -60, tickUpper: 60, amount0: amount, amount1: amount, decimals0: 8, decimals1: 6 });
    expect(BigInt(result.liquidity as string)).toBeGreaterThan(BigInt(amount));
    expect(BigInt(result.amount0 as string) + BigInt(result.unused0 as string)).toBe(BigInt(amount));
    expect(BigInt(result.amount1 as string) + BigInt(result.unused1 as string)).toBe(BigInt(amount));
    expect(result.inRange).toBe(true);
    expect(result.note).toContain("no protocol-enforced minimum");
  });

  test("does not invent prices, align invalid ranges, or mask missing metadata", () => {
    const args = { tickLower: -60, tickUpper: 60, amount0: "1000000", amount1: "1000000" };
    expect(calculateLiquidityRange(view, args).prices).toBe(null);
    expect(() => calculateLiquidityRange(view, { ...args, tickLower: -61 })).toThrow("aligned");
    expect(() => calculateLiquidityRange({ ...view, metadata: null }, args)).toThrow("unavailable");
    expect(() => calculateLiquidityRange(view, { ...args, decimals0: 8 })).toThrow("both decimals");
  });
});
