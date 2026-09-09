import { afterEach, describe, expect, test } from "bun:test";
import { type JsonObject, type MsgBusToolContext, type MsgBusToolHandler, normalizeToolDescriptor, validateToolArguments, validateToolResult } from "neutron-tools/app";
import { calculateLiquidityRange, registerTools, retainedPoolsFromOperations, type ResearchToolDependencies } from "../src/tools.ts";
import { type BrowserPoolView, type PoolIdentity } from "../src/liquidity_reads.ts";
import { Q96 } from "../src/liquidity_math.ts";
import { invalidateCache } from "../src/api.ts";
import { IDL } from "@dfinity/candid";
import { readFileSync } from "node:fs";
import { extractPublicTypeAliases, motokoTypeToIdl, generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import { materializeSelfCallArguments, normalizeSelfCallResult } from "neutron-kernel/src/self_calls.ts";
import { createActionBackend } from "../src/action_backend.ts";
import { createBackendClient } from "../src/backend.ts";
import type { NeutronManifest } from "neutron-tools/src/schema.js";

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
  test("pool tools preserve both exact reported quantities without extra reads or inflated TVL claims", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return Response.json({ code: 200, data: [
        { poolId: "f3cfb-liaaa-aaaar-qcaja-cai", poolFee: 3000, token0LedgerId: USDC, token0Symbol: "AETH", token0LiquidityAmount: "9.00000138", token1LedgerId: ICP, token1Symbol: "ICP", token1LiquidityAmount: "0.09449168", tvlUSD: "210364157" },
        { poolId: "p3va5-zyaaa-aaaag-qjumq-cai", poolFee: 3000, token0LedgerId: USDC, token0Symbol: "ICPENGU", token0LiquidityAmount: "99822760.50857113", token1LedgerId: ICP, token1Symbol: "ICP", token1LiquidityAmount: "0.00000016", tvlUSD: "130710517" },
        { poolId: POOL, token0LedgerId: USDC, token0Symbol: "UNKNOWN", token1LedgerId: ICP, token1Symbol: "ICP", token1LiquidityAmount: "0" },
      ] });
    }) as typeof fetch;
    const { run, descriptors } = fixture({ accountFor: async () => { throw new Error("Analytics must not read the backend account"); } });
    const result = await run("icpswap_token_pools", { ledger_id: ICP });
    expect(() => validateToolResult(descriptors.get("icpswap_token_pools")!, result)).not.toThrow();
    expect(calls).toEqual([`https://api.icpswap.com/info/token/${ICP}/pool`]);
    const pools = result.pools as JsonObject[];
    const first = pools[0]!.composition as JsonObject;
    const second = pools[1]!.composition as JsonObject;
    const unknown = pools[2]!.composition as JsonObject;
    expect((first.token0 as JsonObject).amount_tokens).toBe("9.00000138");
    expect((first.token1 as JsonObject).amount_tokens).toBe("0.09449168");
    expect(first.reported_tvl_usd).toBe("210364157");
    expect(first.snapshot_time).toBeNull();
    expect(first.amount_semantics).toBe("reported_pool_liquidity");
    expect((second.token0 as JsonObject).amount_tokens).toBe("99822760.50857113");
    expect((second.token1 as JsonObject).amount_tokens).toBe("0.00000016");
    expect((unknown.token0 as JsonObject).amount_tokens).toBeNull();
    expect((unknown.token0 as JsonObject).amount_available).toBe(false);
    expect((unknown.token1 as JsonObject).amount_tokens).toBe("0");
    expect((unknown.token1 as JsonObject).amount_available).toBe(true);
    expect((pools[2]!.token0 as JsonObject).liquidity_amount).toBeNull();
    expect((pools[2]!.token1 as JsonObject).liquidity_amount).toBe(0);
    expect(result.note).toContain("inflated");
    expect(first.note).toContain("not verified custody balances or executable trade depth");
  });

  test.each(["icpswap_liquidity_pool_v1", "icpswap_positions_v1"])("%s uses the generated one-unit account signature through its actual backend helper", async (name) => {
    const source = readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8");
    const manifest = JSON.parse(readFileSync(new URL("../neutron.json", import.meta.url), "utf8")) as NeutronManifest;
    const aliases = extractPublicTypeAliases(source);
    const artifact = generateAppMethodSchemaArtifact(manifest, source);
    const accountInput = motokoTypeToIdl(aliases.icpswap_account_Input!, IDL, aliases);
    const accountOutput = motokoTypeToIdl(aliases.icpswap_account_Output!, IDL, aliases);
    expect(validateAppMethodArgs(artifact, "icpswap_account", []).valid).toBe(false);
    const calls: unknown[] = [];
    const current = { ...context, kernel: {
      querySelf: async (method: string, args: unknown[]) => {
        calls.push({ method, args });
        expect(method).toBe("icpswap_account");
        const bound = materializeSelfCallArguments(args, [], [accountInput], { appId: manifest.id, appVersion: manifest.version, method });
        expect(IDL.decode([accountInput], IDL.encode([accountInput], bound.args)) as unknown[]).toEqual([null]);
        expect(validateAppMethodArgs(artifact, method, args as never).valid).toBe(true);
        return normalizeSelfCallResult(IDL.decode([accountOutput], IDL.encode([accountOutput], [OWNER]))[0], accountOutput);
      },
      updateSelf: async () => { throw new Error("Account discovery must not mutate"); },
    } as unknown as MsgBusToolContext["kernel"] };
    const result = await fixture({ accountFor: (ctx) => createActionBackend(ctx.kernel).account() }).run(name, { pool: POOL }, current);
    expect(result.owner).toBe(OWNER);
    expect(result.complete).toBe(true);
    expect(calls).toEqual([{ method: "icpswap_account", args: [null] }]);
  });

  test("every no-argument backend wrapper sends the generated Candid unit argument", async () => {
    const aliases = extractPublicTypeAliases(readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"));
    const unitMethods = Object.entries(aliases).filter(([name, type]) => name.endsWith("_Input") && type === "()").map(([name]) => name.slice(0, -6)).sort();
    expect(unitMethods).toEqual(["icpswap_account", "icpswap_status"]);
    const calls: string[] = [];
    const client = { querySelf: async (method: string, args: unknown[]) => {
      const type = motokoTypeToIdl(aliases[`${method}_Input`]!, IDL, aliases);
      const bound = materializeSelfCallArguments(args, [], [type]);
      expect(IDL.decode([type], IDL.encode([type], bound.args)) as unknown[]).toEqual([null]);
      calls.push(method);
      return method === "icpswap_account" ? OWNER : {};
    } } as unknown as MsgBusToolContext["kernel"];
    await createActionBackend(client).account();
    await createBackendClient(client).getStatus();
    expect(calls.sort()).toEqual(unitMethods);
  });

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

  test("swap previews read Wallet fees and query pools directly without backend updates", async () => {
    const events: string[] = [];
    const deps: Partial<ResearchToolDependencies> = {
      tokenInfoFor: async (_context, ledger) => {
        events.push(`read:${ledger}`);
        return { ledger, account: OWNER, name: null, symbol: "TOKEN", decimals: 8, feeAtoms: 0n, balanceAtoms: 1000000n, observedAtNs: 1n };
      },
      backendFor: () => { throw new Error("A price preview must not use the backend"); },
      quotes: {
        preparePair: async (input, output) => { expect([input, output]).toEqual([ICP, USDC]); events.push("prepare-pair"); },
        quote: async (request, options) => {
          expect(request.amountIn).toBe(100000n);
          expect(options).toMatchObject({ decimalsIn: 8, decimalsOut: 8, feeIn: 0n, feeOut: 0n });
          events.push("quote"); throw new Error("price marker");
        },
      },
    };
    const args = { from_ledger_id: ICP, to_ledger_id: USDC, amount: "100000" };
    await expect(fixture(deps).run("icpswap_quote_swap", args)).rejects.toThrow("price marker");
    expect(events).toEqual([`read:${ICP}`, `read:${USDC}`, "prepare-pair", "quote"]);
    events.length = 0;
    await expect(fixture({ ...deps, tokenInfoFor: async () => { throw new Error("live fee unavailable"); } }).run("icpswap_quote_swap", args)).rejects.toThrow("live fee unavailable");
    expect(events).toEqual(["prepare-pair"]);
  });

  test.each([1.5, 0.5, 49999.5, 0, -1, 50001, "500", null, true])("quote rejects invalid slippage %j before any Wallet or pool reads", async (slippage) => {
    const calls: string[] = [];
    const unexpected = async () => { calls.push("unexpected read"); throw new Error("Slippage validation must precede I/O"); };
    const f = fixture({ tokenInfoFor: unexpected, quotes: { preparePair: unexpected, quote: unexpected } });
    const args = { from_ledger_id: ICP, to_ledger_id: USDC, amount: "10000000", slippage };
    expect(() => validateToolArguments(f.descriptors.get("icpswap_quote_swap")!, args)).toThrow();
    await expect(f.run("icpswap_quote_swap", args)).rejects.toThrow("slippage must be an integer from 1 to 50000");
    expect(calls).toEqual([]);
  });

  test.each([undefined, 1, 500, 50000])("quote preserves exact slippage units %s and the documented gross/net minimum", async (slippage) => {
    const effective = slippage ?? 500;
    const gross = 287307n, fee = 10000n;
    const minimum = gross * 100000n / (100000n + BigInt(effective));
    const f = fixture({
      tokenInfoFor: async (_context, ledger) => ({ ledger, account: OWNER, name: null, symbol: ledger === ICP ? "ICP" : "ckUSDC",
        decimals: ledger === ICP ? 8 : 6, feeAtoms: fee, balanceAtoms: 0n, observedAtNs: 1n }),
      quotes: {
        preparePair: async () => undefined,
        quote: async (request) => {
          expect(request.slippage).toBe(effective);
          return { pool: POOL, poolKey: pool.key, feeTier: 3000, inputAddress: ICP, outputAddress: USDC,
            decimalsIn: 8, decimalsOut: 6, zeroForOne: true, amountIn: request.amountIn, quotedOut: gross,
            amountOutMinimum: minimum, expectedOut: gross - fee, tokenInFee: fee, tokenOutFee: fee,
            fundingAmount: request.amountIn, totalDebit: request.amountIn + 2n * fee, priceImpact: 0.003,
            warn: false, slippage: request.slippage, fundingLedger: ICP, fundingSpender: POOL,
            at: 1788956580, contextAt: 1788956580 };
        },
      },
    });
    const descriptor = f.descriptors.get("icpswap_quote_swap")!;
    const args = { from_ledger_id: ICP, to_ledger_id: USDC, amount: "10000000", ...(slippage === undefined ? {} : { slippage }) };
    expect(() => validateToolArguments(descriptor, args)).not.toThrow();
    const result = await f.run("icpswap_quote_swap", args);
    expect(() => validateToolResult(descriptor, result)).not.toThrow();
    expect(result.slippage_thousandths_percent).toBe(effective);
    expect(result.minimum_out_gross).toBe(minimum.toString());
    expect(result.minimum_out_net_estimate).toBe((minimum - fee).toString());
    if (effective === 50000) expect(result).toMatchObject({ expected_out: "277307", minimum_out_gross: "191538", minimum_out_net_estimate: "181538" });
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
