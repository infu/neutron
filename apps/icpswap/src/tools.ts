// Tools this app exposes on the kernel message bus.
//
// They are registered by the resident background so they stay callable while no
// tile is open. Read tools are safe for cross-app discovery; the two watchlist
// mutations are marked same-app so another app cannot silently reshape the
// owner's watchlist, and they still pass the kernel's own consent path.
//
// Every result carries `source` and `as_of` so an agent can reason about
// staleness, plus an explicit note that this is third-party market data.

import { exposeTool, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import {
  IcpSwapApiError,
  fetchTokenChart,
  fetchTokenTransactions,
  loadTokenPools,
  loadTokenRanks,
  loadTokenUniverse,
  type ChartLevel,
  type InfoToken,
} from "./api.ts";
import { createBackendClient } from "./backend.ts";
import { createRequestId } from "./funding.ts";
import { readTokenInfo, type WalletTokenInfo } from "./wallet.ts";
import { createLiquidityReadClient, type BrowserPoolView } from "./liquidity_reads.ts";
import { amountsForLiquidity, getSqrtRatioAtTick, liquidityForAmounts, tickToPrice, usableTickRange } from "./liquidity_math.ts";

const DISCLAIMER =
  "ICPSwap analytics observations. Pool reads and execution quotes provide current executable amounts.";

const LEDGER_PATTERN = "^[a-z0-9-]{5,80}$";

function nowIso(): string {
  return new Date().toISOString();
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function requiredLedgerId(args: JsonObject, key = "ledger_id"): string {
  const value = args[key];
  if (typeof value !== "string" || !/^[a-z0-9-]{5,80}$/.test(value)) {
    throw new Error(`\`${key}\` must be a token ledger canister id`);
  }
  return value;
}

function tokenSummary(token: InfoToken): JsonObject {
  return {
    ledger_id: token.ledgerId,
    symbol: token.symbol,
    name: token.name,
    price_usd: token.price,
    price_change_24h_percent: token.priceChange24H,
    volume_usd_24h: token.volumeUSD24H,
    volume_usd_7d: token.volumeUSD7D,
    volume_usd_total: token.totalVolumeUSD,
    tvl_usd: token.tvlUSD,
    tvl_change_24h_percent: token.tvlUSDChange24H,
    tx_count_24h: token.txCount24H,
  };
}

function matchToken(tokens: InfoToken[], ledgerId: string): InfoToken | undefined {
  return tokens.find((token) => token.ledgerId === ledgerId);
}

function scoreMatch(token: InfoToken, needle: string): number {
  const symbol = token.symbol.toLowerCase();
  if (symbol === needle || token.ledgerId.toLowerCase() === needle) return 0;
  if (symbol.startsWith(needle)) return 1;
  if (symbol.includes(needle)) return 2;
  if (token.name.toLowerCase().includes(needle)) return 3;
  return 4;
}

function describeError(error: unknown): string {
  if (error instanceof IcpSwapApiError) return `ICPSwap API: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register every tool. Safe to call more than once: `exposeTool` replaces a
 * descriptor with the same name.
 */

/** Every swap result carries this so an agent cannot mistake it for advice. */
const SWAP_NOTE =
  "The pool enforces a gross swap minimum; the output ledger fee reduces the wallet receipt. This quote does not fund or execute the swap.";

function swapRequestFrom(args: JsonObject) {
  const from = typeof args.from_ledger_id === "string" ? args.from_ledger_id.trim() : "";
  const to = typeof args.to_ledger_id === "string" ? args.to_ledger_id.trim() : "";
  if (from === "" || to === "") throw new Error("Both ledger canister ids are required");
  const raw = typeof args.amount === "string" ? args.amount.trim() : "";
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error("amount must be a decimal integer string in base units");
  }
  const amountIn = BigInt(raw);
  if (amountIn <= 0n) throw new Error("amount must be greater than zero");
  return {
    requestId:
      typeof args.request_id === "string" && /^[0-9a-f]{32}$/u.test(args.request_id)
        ? args.request_id
        : createRequestId(),
    inputAddress: from,
    outputAddress: to,
    amountIn,
    slippage: boundedInt(args.slippage, 500, 1, 50_000),
  };
}

function pageByPool<T extends { pool: string }>(items: T[], args: JsonObject, fallback = 20) {
  const ordered = [...items].sort((a, b) => a.pool.localeCompare(b.pool));
  const cursor = args.cursor;
  if (cursor !== undefined && typeof cursor !== "string") throw new Error("cursor must be a pool id from the previous page");
  const previous = cursor === undefined ? -1 : ordered.findIndex((item) => item.pool === cursor);
  if (cursor !== undefined && previous < 0) throw new Error("The pool cursor is no longer in this result; restart without cursor");
  const limit = args.limit === undefined ? fallback : args.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const itemsPage = ordered.slice(previous + 1, previous + 1 + limit);
  const nextCursor = previous + 1 + itemsPage.length < ordered.length ? itemsPage.at(-1)?.pool ?? null : null;
  return { items: itemsPage, total: ordered.length, nextCursor };
}

function atoms(value: JsonValue | undefined, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} must be an unsigned decimal atomic amount`);
  return BigInt(value);
}

/** Independent of transport so the exact amounts shown to a researcher can be tested. */
export function calculateLiquidityRange(view: BrowserPoolView, args: JsonObject): JsonObject {
  if (!view.metadata) throw new Error("Current pool metadata is unavailable; inspect the pool errors before sizing liquidity");
  const tickLower = args.tickLower;
  const tickUpper = args.tickUpper;
  if (typeof tickLower !== "number" || !Number.isSafeInteger(tickLower) || typeof tickUpper !== "number" || !Number.isSafeInteger(tickUpper)) throw new Error("tickLower and tickUpper must be integers");
  const full = usableTickRange(view.pool.tickSpacing);
  if (tickLower < full.lower || tickUpper > full.upper || tickLower >= tickUpper || tickLower % view.pool.tickSpacing !== 0 || tickUpper % view.pool.tickSpacing !== 0) throw new Error("The range must use increasing protocol ticks aligned to this pool's tick spacing");
  const max0 = atoms(args.amount0, "amount0");
  const max1 = atoms(args.amount1, "amount1");
  const sqrt = BigInt(view.metadata.sqrtPriceX96);
  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);
  const liquidity = liquidityForAmounts(sqrt, lower, upper, max0, max1);
  const used = amountsForLiquidity(sqrt, lower, upper, liquidity, true);
  let prices: JsonObject | null = null;
  if (args.decimals0 !== undefined || args.decimals1 !== undefined) {
    if (typeof args.decimals0 !== "number" || typeof args.decimals1 !== "number") throw new Error("Provide both decimals0 and decimals1 for human token price labels");
    prices = { lower: tickToPrice(tickLower, args.decimals0, args.decimals1), upper: tickToPrice(tickUpper, args.decimals0, args.decimals1), units: "token1 per token0", decimalsSource: "caller supplied" };
  }
  return {
    source: view.source, pool: view.pool, tickLower, tickUpper, currentTick: view.metadata.tick,
    currentSqrtPriceX96: view.metadata.sqrtPriceX96, tickSpacing: view.pool.tickSpacing,
    fullRange: { tickLower: full.lower, tickUpper: full.upper }, prices,
    liquidity: liquidity.toString(), amount0: used.amount0.toString(), amount1: used.amount1.toString(),
    unused0: (max0 - used.amount0).toString(), unused1: (max1 - used.amount1).toString(),
    inRange: view.metadata.tick >= tickLower && view.metadata.tick < tickUpper,
    zeroLiquidity: liquidity === 0n,
    note: "Amounts exclude funding and withdrawal ledger fees. This is a price observation. ICPSwap liquidity calls have no protocol-enforced minimum amounts or deadline; prepare the saved action for the funding and execution review.",
  };
}

export type RetainedPoolDiscovery = { pools: string[]; errors: JsonObject[] };

/** Closed positions can disappear from the protocol index. Keep every locally
 * observed pool, and isolate malformed rows instead of hiding other funds. */
export function retainedPoolsFromOperations(operations: Array<{ id: string; input_json: string; effects?: JsonObject[] }>): RetainedPoolDiscovery {
  const pools = new Set<string>();
  const errors: JsonObject[] = [];
  for (const operation of operations) {
    for (const effect of operation.effects ?? []) {
      if (typeof effect.canister === "string" && effect.canister.length > 0) pools.add(effect.canister);
    }
    try {
      const saved: unknown = JSON.parse(operation.input_json);
      if (typeof saved !== "object" || saved === null || Array.isArray(saved)) throw new Error("Expected a saved intent record");
      const input = (saved as Record<string, unknown>).input;
      if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Saved intent has no input record");
      const pool = (input as Record<string, unknown>).pool;
      if (typeof pool === "string" && pool.length > 0) pools.add(pool);
    } catch (error) {
      errors.push({ method: "retainedPoolDiscovery", operationId: operation.id, message: `Saved input metadata is unreadable: ${describeError(error)}` });
    }
  }
  return { pools: [...pools], errors };
}

export type ResearchToolDependencies = {
  accountFor: (context: MsgBusToolContext) => Promise<string>;
  retainedPoolsFor?: (context: MsgBusToolContext) => Promise<string[] | RetainedPoolDiscovery>;
  expose?: typeof exposeTool;
  backendFor?: typeof createBackendClient;
  tokenInfoFor?: (context: MsgBusToolContext, ledger: string) => Promise<WalletTokenInfo>;
  reads?: ReturnType<typeof createLiquidityReadClient>;
};

export function registerTools(dependencies: ResearchToolDependencies): void {
  const register = dependencies.expose ?? exposeTool;
  const backendFor = dependencies.backendFor ?? createBackendClient;
  const reads = dependencies.reads ?? createLiquidityReadClient();
  const tokenInfoFor = dependencies.tokenInfoFor ?? ((context: MsgBusToolContext, ledger: string) => readTokenInfo(context.kernel, ledger));
  register(
    "icpswap_search_tokens",
    {
      title: "Search ICPSwap tokens",
      description:
        "Search every token traded on ICPSwap by symbol, name, or ledger canister id. Returns live price, 24h change, volume and TVL for each match.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Symbol, name fragment, or ledger canister id. Empty returns the highest-volume tokens.",
            maxLength: 64,
          },
          limit: {
            type: "integer",
            description: "Maximum matches to return (1-50).",
            minimum: 1,
            maximum: 50,
          },
        },
        required: [],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const limit = boundedInt(args.limit, 20, 1, 50);
      try {
        const universe = await loadTokenUniverse();
        const matched = query === ""
          ? [...universe]
          : universe.filter(
              (token) =>
                token.symbol.toLowerCase().includes(query) ||
                token.name.toLowerCase().includes(query) ||
                token.ledgerId.toLowerCase().includes(query),
            );
        matched.sort((left, right) => {
          const byScore = scoreMatch(left, query) - scoreMatch(right, query);
          if (byScore !== 0) return byScore;
          return right.volumeUSD7D - left.volumeUSD7D;
        });
        return {
          source: "icpswap-info-api",
          as_of: nowIso(),
          as_of_kind: "response_time",
          query,
          total_matches: matched.length,
          universe_size: universe.length,
          tokens: matched.slice(0, limit).map(tokenSummary),
          note: DISCLAIMER,
        };
      } catch (error) {
        // Fall back to the sovereign on-chain universe held by the backend.
        const page = await backendFor(context.kernel).searchTokens(query, 0, limit);
        return {
          source: "neutron-backend-onchain",
          as_of: nowIso(),
          as_of_kind: "response_time",
          query,
          total_matches: page.total,
          universe_size: page.universe,
          degraded_reason: describeError(error),
          tokens: page.items.map((item) => ({
            ledger_id: item.address,
            symbol: item.symbol,
            name: item.name,
            standard: item.standard,
            pool_count: item.poolCount,
            verified_listing: item.verified,
            watched: item.watched,
          })),
          degraded_note:
            "The on-chain pool registry knows which tokens trade and where, but not their volume or market value.",
          note: DISCLAIMER,
        };
      }
    },
  );

  register(
    "icpswap_token_info",
    {
      title: "ICPSwap token detail",
      description:
        "Full market detail for one token: price, 24h change, 24h/7d/total volume, TVL, 24h/7d/30d price range, market cap, fully diluted valuation, holder count, and pool count.",
      inputSchema: {
        type: "object",
        properties: {
          ledger_id: {
            type: "string",
            description: "Token ledger canister id.",
            pattern: LEDGER_PATTERN,
          },
        },
        required: ["ledger_id"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const ledgerId = requiredLedgerId(args);
      const [universe, ranks] = await Promise.all([
        loadTokenUniverse(),
        loadTokenRanks().catch(() => []),
      ]);
      const token = matchToken(universe, ledgerId);
      if (!token) {
        return {
          source: "icpswap-info-api",
          as_of: nowIso(),
          as_of_kind: "response_time",
          found: false,
          ledger_id: ledgerId,
          note: "That ledger id is not traded on ICPSwap.",
        };
      }
      const rank = ranks.find((entry) => entry.ledgerId === ledgerId);
      const pools = await loadTokenPools(ledgerId).catch(() => []);
      return {
        source: "icpswap-info-api",
        as_of: nowIso(),
        as_of_kind: "response_time",
        found: true,
        ...tokenSummary(token),
        price_low_24h: token.priceLow24H,
        price_high_24h: token.priceHigh24H,
        price_low_7d: token.priceLow7D,
        price_high_7d: token.priceHigh7D,
        price_low_30d: token.priceLow30D,
        price_high_30d: token.priceHigh30D,
        market_cap_usd: rank?.marketCap ?? null,
        fully_diluted_valuation_usd: rank?.fdv ?? null,
        holders: rank?.holders ?? null,
        icpswap_rank: rank?.rank ?? null,
        pool_count: pools.length,
        note: DISCLAIMER,
      };
    },
  );

  register(
    "icpswap_market_overview",
    {
      title: "Watchlist market overview",
      description:
        "The owner's watched tokens with live ICPSwap market data, plus this Neutron's own refresh status. Use this to see what the owner is actually tracking.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    async (_args, context): Promise<JsonValue> => {
      const snapshot = await backendFor(context.kernel).getMarket("price", false);
      const universe = await loadTokenUniverse().catch(() => []);
      const rows = snapshot.rows.map((row) => {
        const live = matchToken(universe, row.address);
        return {
          ledger_id: row.address,
          symbol: row.symbol,
          name: row.name,
          pinned: row.pinned,
          note: row.note,
          verified_on_chain: row.verified,
          price_usd: live?.price ?? row.priceUsd,
          price_usd_onchain: row.priceUsd > 0 ? row.priceUsd : null,
          price_icp: row.priceIcp,
          price_change_24h_percent: live?.priceChange24H ?? null,
          volume_usd_24h: live?.volumeUSD24H ?? null,
          volume_usd_7d: live?.volumeUSD7D ?? null,
          tvl_usd: live?.tvlUSD ?? null,
          pool_count: row.poolCount,
          onchain_quote: row.quote
            ? {
                pool: row.quote.pool,
                quoted_against: row.quote.quoteSymbol,
                fee_tier_percent: row.quote.feeTier / 10_000,
                via_icp: row.quote.viaIcp,
              }
            : null,
          recorded_samples: row.sampleCount,
        };
      });
      return {
        source: universe.length > 0 ? "icpswap-info-api+neutron-backend" : "neutron-backend-onchain",
        as_of: nowIso(),
        as_of_kind: "response_time",
        watchlist_size: snapshot.status.watchlistSize,
        icp_price_usd: snapshot.status.icpPriceUsd,
        last_onchain_refresh_at: snapshot.status.lastRefreshAt,
        last_onchain_refresh_error: snapshot.status.lastRefreshError,
        tokens: rows,
        note: DISCLAIMER,
      };
    },
  );

  register(
    "icpswap_top_tokens",
    {
      title: "Top ICPSwap tokens",
      description:
        "Leading tokens ranked by market cap, 24h volume, or TVL, including fully diluted valuation and holder counts where ICPSwap publishes them.",
      inputSchema: {
        type: "object",
        properties: {
          sort_by: {
            type: "string",
            enum: ["market_cap", "volume_24h", "tvl", "price_change_24h"],
            description: "Ranking metric. Defaults to market_cap.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum tokens to return (1-50).",
          },
        },
        required: [],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const sortBy = typeof args.sort_by === "string" ? args.sort_by : "market_cap";
      const limit = boundedInt(args.limit, 20, 1, 50);
      const ranks = await loadTokenRanks();
      const ordered = [...ranks].sort((left, right) => {
        switch (sortBy) {
          case "volume_24h":
            return right.volumeUSD24H - left.volumeUSD24H;
          case "tvl":
            return right.tvlUSD - left.tvlUSD;
          case "price_change_24h":
            return right.priceChange24H - left.priceChange24H;
          default:
            return right.marketCap - left.marketCap;
        }
      });
      return {
        source: "icpswap-info-api",
        as_of: nowIso(),
        as_of_kind: "response_time",
        sort_by: sortBy,
        tokens: ordered.slice(0, limit).map((entry) => ({
          ledger_id: entry.ledgerId,
          symbol: entry.symbol,
          name: entry.name,
          price_usd: entry.price,
          price_change_24h_percent: entry.priceChange24H,
          market_cap_usd: entry.marketCap,
          fully_diluted_valuation_usd: entry.fdv,
          volume_usd_24h: entry.volumeUSD24H,
          tvl_usd: entry.tvlUSD,
          holders: entry.holders,
        })),
        note: DISCLAIMER,
      };
    },
  );

  register(
    "icpswap_price_chart",
    {
      title: "ICPSwap price history",
      description:
        "Historical OHLC candles for one token with per-candle volume and TVL. Intervals are 15 minutes, 1 hour, or 1 day.",
      inputSchema: {
        type: "object",
        properties: {
          ledger_id: {
            type: "string",
            description: "Token ledger canister id.",
            pattern: LEDGER_PATTERN,
          },
          interval: {
            type: "string",
            enum: ["m15", "h1", "d1"],
            description: "Candle interval. Defaults to d1.",
          },
          limit: {
            type: "integer",
            minimum: 2,
            maximum: 365,
            description: "Number of most recent candles (2-365).",
          },
        },
        required: ["ledger_id"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const ledgerId = requiredLedgerId(args);
      const interval = (
        typeof args.interval === "string" && ["m15", "h1", "d1"].includes(args.interval)
          ? args.interval
          : "d1"
      ) as ChartLevel;
      const limit = boundedInt(args.limit, 90, 2, 365);
      const page = await fetchTokenChart(ledgerId, interval, limit);
      const candles = page.candles.slice(-limit);
      const first = candles[0];
      const last = candles[candles.length - 1];
      const changePercent =
        first && last && first.close > 0
          ? ((last.close - first.close) / first.close) * 100
          : null;
      return {
        source: "icpswap-info-api",
        as_of: nowIso(),
        as_of_kind: "response_time",
        ledger_id: ledgerId,
        interval,
        available_candles: page.total,
        returned_candles: candles.length,
        change_over_window_percent: changePercent,
        candles: candles.map((candle) => ({
          time: new Date(candle.t * 1000).toISOString(),
          timestamp_seconds: candle.t,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume_usd: candle.volumeUSD,
          tvl_usd: candle.tvlUSD,
          tx_count: candle.txCount,
        })),
        note: DISCLAIMER,
      };
    },
  );

  register(
    "icpswap_token_pools",
    {
      title: "ICPSwap pools for a token",
      description:
        "Liquidity pools that trade a token, with fee tier, TVL, 24h volume, 24h fees, and both sides' current price.",
      inputSchema: {
        type: "object",
        properties: {
          ledger_id: {
            type: "string",
            description: "Token ledger canister id.",
            pattern: LEDGER_PATTERN,
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum pools to return (1-50).",
          },
        },
        required: ["ledger_id"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const ledgerId = requiredLedgerId(args);
      const limit = boundedInt(args.limit, 20, 1, 50);
      const pools = await loadTokenPools(ledgerId);
      const ordered = [...pools].sort((left, right) => right.tvlUSD - left.tvlUSD);
      return {
        source: "icpswap-info-api",
        as_of: nowIso(),
        as_of_kind: "response_time",
        ledger_id: ledgerId,
        total_pools: pools.length,
        pools: ordered.slice(0, limit).map((pool) => ({
          pool_id: pool.poolId,
          fee_tier_percent: pool.poolFee / 10_000,
          token0: {
            ledger_id: pool.token0LedgerId,
            symbol: pool.token0Symbol,
            price_usd: pool.token0Price,
            liquidity_amount: pool.token0LiquidityAmount,
          },
          token1: {
            ledger_id: pool.token1LedgerId,
            symbol: pool.token1Symbol,
            price_usd: pool.token1Price,
            liquidity_amount: pool.token1LiquidityAmount,
          },
          tvl_usd: pool.tvlUSD,
          tvl_change_24h_percent: pool.tvlUSDChange24H,
          volume_usd_24h: pool.volumeUSD24H,
          volume_usd_7d: pool.volumeUSD7D,
          fees_usd_24h: pool.feesUSD24H,
          tx_count_24h: pool.txCount24H,
        })),
        note: DISCLAIMER,
      };
    },
  );

  register(
    "icpswap_recent_trades",
    {
      title: "Recent ICPSwap trades",
      description:
        "Most recent swaps involving a token, with pool, direction, amounts and USD value. Useful for judging real liquidity and activity.",
      inputSchema: {
        type: "object",
        properties: {
          ledger_id: {
            type: "string",
            description: "Token ledger canister id.",
            pattern: LEDGER_PATTERN,
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum trades to return (1-50).",
          },
        },
        required: ["ledger_id"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const ledgerId = requiredLedgerId(args);
      const limit = boundedInt(args.limit, 20, 1, 50);
      const transactions = await fetchTokenTransactions(ledgerId, limit);
      return {
        source: "icpswap-info-api",
        as_of: nowIso(),
        as_of_kind: "response_time",
        ledger_id: ledgerId,
        trades: transactions.map((entry) => ({
          time: entry.txTime > 0 ? new Date(entry.txTime * 1000).toISOString() : null,
          timestamp_seconds: entry.txTime,
          action: entry.actionType,
          pool_id: entry.poolId,
          pair: `${entry.token0Symbol}/${entry.token1Symbol}`,
          token0_amount_in: entry.token0AmountIn,
          token1_amount_in: entry.token1AmountIn,
          token0_amount_out: entry.token0AmountOut,
          token1_amount_out: entry.token1AmountOut,
          value_usd: Math.max(entry.token0TxValue, entry.token1TxValue),
        })),
        note: DISCLAIMER,
      };
    },
  );

  register(
    "icpswap_local_history",
    {
      title: "Locally recorded price history",
      description:
        "USD and ICP price samples this Neutron recorded for itself by reading live ICPSwap pool state on chain. Independent of the ICPSwap HTTP API and available even when it is unreachable.",
      inputSchema: {
        type: "object",
        properties: {
          ledger_id: {
            type: "string",
            description: "Token ledger canister id; must be on the watchlist.",
            pattern: LEDGER_PATTERN,
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 400,
            description: "Maximum samples to return, newest last (1-400).",
          },
        },
        required: ["ledger_id"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const ledgerId = requiredLedgerId(args);
      const limit = boundedInt(args.limit, 120, 1, 400);
      const page = await backendFor(context.kernel).getHistory(ledgerId, limit);
      const status = await backendFor(context.kernel).getStatus();
      return {
        source: "neutron-backend-onchain",
        as_of: nowIso(),
        as_of_kind: "response_time",
        ledger_id: page.address,
        total_recorded: page.total,
        retention_limit: page.historyLimit,
        last_refresh_at: status.lastRefreshAt,
        samples: page.samples.map((sample) => ({
          time: sample.t > 0 ? new Date(sample.t * 1000).toISOString() : null,
          timestamp_seconds: sample.t,
          price_usd: sample.priceUsd,
          price_icp: sample.priceIcp,
        })),
        note:
          "Recorded by this Neutron from live ICPSwap pool state, by squaring the pool's sqrtPriceX96. Independent of the ICPSwap HTTP API.",
      };
    },
  );

  register(
    "icpswap_watchlist_add",
    {
      title: "Add a token to the watchlist",
      description:
        "Add one token to the owner's ICPSwap watchlist so it appears in the market table and is sampled on the app's schedule.",
      inputSchema: {
        type: "object",
        properties: {
          ledger_id: {
            type: "string",
            description: "Token ledger canister id.",
            pattern: LEDGER_PATTERN,
          },
        },
        required: ["ledger_id"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { "neutron:visibility": "same_app" },
    },
    async (args, context): Promise<JsonValue> => {
      const ledgerId = requiredLedgerId(args);
      const universe = await loadTokenUniverse().catch(() => []);
      const token = matchToken(universe, ledgerId);
      const report = await backendFor(context.kernel).addToken({
        address: ledgerId,
        symbol: token?.symbol ?? "",
        name: token?.name ?? "",
        standard: "",
        decimals: 0,
      });
      return {
        ok: report.ok,
        message: report.message,
        watchlist_size: report.watchlistSize,
        ledger_id: ledgerId,
      };
    },
  );

  register(
    "icpswap_watchlist_remove",
    {
      title: "Remove a token from the watchlist",
      description:
        "Remove one token from the owner's ICPSwap watchlist. Recorded history for that token is kept.",
      inputSchema: {
        type: "object",
        properties: {
          ledger_id: {
            type: "string",
            description: "Token ledger canister id.",
            pattern: LEDGER_PATTERN,
          },
        },
        required: ["ledger_id"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      annotations: { "neutron:visibility": "same_app" },
    },
    async (args, context): Promise<JsonValue> => {
      const ledgerId = requiredLedgerId(args);
      const report = await backendFor(context.kernel).removeToken(ledgerId);
      return {
        ok: report.ok,
        message: report.message,
        watchlist_size: report.watchlistSize,
        ledger_id: ledgerId,
      };
    },
  );
  // ------------------------------------------------------------ swapping

  register(
    "icpswap_quote_swap",
    {
      title: "Quote an ICPSwap swap",
      description:
        "Compare available direct ICPSwap pools and report expected net output, the gross pool minimum after slippage, price impact and observed ledger fees. This read does not inspect existing allowances or grant funding. Use icpswap_swap_v1 to prepare and execute a saved, reviewed swap.",
      inputSchema: {
        type: "object",
        properties: {
          from_ledger_id: {
            type: "string",
            description: "Ledger canister id of the token being sold.",
            maxLength: 64,
          },
          to_ledger_id: {
            type: "string",
            description: "Ledger canister id of the token being bought.",
            maxLength: 64,
          },
          amount: {
            type: "string",
            description:
              "Amount to sell, in the input token's base units, as a decimal integer string.",
            maxLength: 40,
          },
          slippage: {
            type: "number",
            description:
              "Maximum slippage in thousandths of a percent; 500 is 0.5%. Defaults to 500 (0.5%).",
            minimum: 1,
            maximum: 50000,
          },
        },
        required: ["from_ledger_id", "to_ledger_id", "amount"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const request = swapRequestFrom(args);
      const backend = backendFor(context.kernel);
      for (const ledger of [request.inputAddress, request.outputAddress]) {
        if (context.signal?.aborted) throw context.signal.reason;
        const metadata = await tokenInfoFor(context, ledger);
        await backend.setTokenInfo(ledger, metadata.decimals, metadata.feeAtoms);
      }
      if (context.signal?.aborted) throw context.signal.reason;
      const quote = await backend.quoteSwap(request);
      return {
        source: "icpswap-pool",
        as_of: nowIso(),
        as_of_kind: "response_time",
        note: SWAP_NOTE,
        pool: quote.pool,
        pool_key: quote.poolKey,
        fee_tier: quote.feeTier,
        from_ledger_id: quote.inputAddress,
        to_ledger_id: quote.outputAddress,
        amount_in: quote.amountIn.toString(),
        expected_out: quote.expectedOut.toString(),
        minimum_out: quote.amountOutMinimum.toString(),
        minimum_out_gross: quote.amountOutMinimum.toString(),
        minimum_out_net_estimate: (quote.amountOutMinimum > quote.tokenOutFee ? quote.amountOutMinimum - quote.tokenOutFee : 0n).toString(),
        quoted_out_gross: quote.quotedOut.toString(),
        price_impact_percent: quote.priceImpact * 100,
        high_price_impact: quote.warn,
        input_ledger_fee: quote.tokenInFee.toString(),
        output_ledger_fee: quote.tokenOutFee.toString(),
        total_debited: quote.totalDebit.toString(),
        slippage_thousandths_percent: quote.slippage,
        funding: {
          continuation_tool: "icpswap_swap_v1",
          target: "app:icpswap:background",
          ledger: quote.fundingLedger,
          spender: quote.fundingSpender,
          amount_atoms: quote.fundingAmount.toString(),
          note: "Use the saved action tool before funding. Wallet adds the ledger transfer fee to its allowance; quote funding fields alone are not a retained Wallet request.",
        },
      };
    },
  );

  register(
    "icpswap_swap_history",
    {
      title: "ICPSwap swap history",
      description:
        "Legacy swap records, newest first, with their saved state and outcome. Use icpswap_history_v1 for current durable actions. Ambiguous records may have moved funds without confirmation: inspect status instead of creating a duplicate intent.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    async (args, context): Promise<JsonValue> => {
      const page = await backendFor(context.kernel).getSwapJournal(boundedInt(args.limit, 20, 1, 100));
      return {
        source: "neutron-local",
        as_of: nowIso(),
        as_of_kind: "response_time",
        completed: page.completed,
        total_recorded: page.total,
        slippage_thousandths_percent: page.slippage,
        swaps: page.entries.map((entry) => ({
          request_id: entry.requestId,
          state: entry.state,
          pool: entry.pool,
          from_ledger_id: entry.inputAddress,
          to_ledger_id: entry.outputAddress,
          from_symbol: entry.inputSymbol,
          to_symbol: entry.outputSymbol,
          amount_in: entry.amountIn.toString(),
          minimum_out: entry.amountOutMinimum.toString(),
          quoted_out: entry.quotedOut.toString(),
          swapped_out: entry.swappedOut.toString(),
          detail: entry.detail,
          started_at: entry.startedAt > 0 ? new Date(entry.startedAt * 1000).toISOString() : null,
          updated_at: entry.updatedAt > 0 ? new Date(entry.updatedAt * 1000).toISOString() : null,
        })),
      };
    },
  );

  const pageProperties = {
    cursor: { type: "string", description: "nextCursor from the preceding page; omit for the first page." },
    limit: { type: "integer", minimum: 1, description: "Number of pools per page. Defaults to 20 for discovery and 3 for position detail." },
  };
  const poolProperty = { type: "string", description: "Canonical ICPSwap pool canister id.", pattern: LEDGER_PATTERN };
  const readAnnotations = { readOnlyHint: true, "neutron:effects": ["read", "network"] };

  register("icpswap_liquidity_pools_v1", {
    title: "Discover ICPSwap liquidity pools",
    description: "Read the canonical ICPSwap factory directly. Filter by either token ledger or a pair. Returns canonical token order, token standards, pool fee and tick spacing with cursor pagination.",
    inputSchema: { type: "object", properties: { ...pageProperties, token: { type: "string", pattern: LEDGER_PATTERN }, pairedToken: { type: "string", pattern: LEDGER_PATTERN } }, additionalProperties: false },
    outputSchema: { type: "object" }, annotations: readAnnotations,
  }, async (args, context) => {
    const observed = await reads.discoverPools(context.signal);
    const token = args.token === undefined ? undefined : requiredLedgerId(args, "token");
    const paired = args.pairedToken === undefined ? undefined : requiredLedgerId(args, "pairedToken");
    const page = pageByPool(observed.pools.filter((pool) => [token, paired].every((ledger) => ledger === undefined || pool.token0.address === ledger || pool.token1.address === ledger)), args);
    return { source: observed.source, pools: page.items, total: page.total, nextCursor: page.nextCursor };
  });

  register("icpswap_liquidity_pool_v1", {
    title: "Inspect an ICPSwap liquidity pool",
    description: "Read current pool price, liquidity, tick spacing, owned positions and claimable fees, unused funds, withdrawal queue and current protocol transactions directly. Owner is this Neutron's actual account. Missing data is null with field diagnostics; an empty queue does not prove settlement.",
    inputSchema: { type: "object", properties: { pool: poolProperty }, required: ["pool"], additionalProperties: false },
    outputSchema: { type: "object" }, annotations: readAnnotations,
  }, async (args, context) => {
    const owner = await dependencies.accountFor(context);
    const view = await reads.readPool(requiredLedgerId(args, "pool"), owner, context.signal);
    return { ...view, complete: view.errors.length === 0, settlementNote: "Withdrawal settlement is asynchronous. Successful transactions leave the current protocol transaction list, and queue entries can disappear before a ledger transfer completes; absence proves neither settlement nor no effect." };
  });

  register("icpswap_positions_v1", {
    title: "Read owned ICPSwap positions and recoverable funds",
    description: "Discover this Neutron's positions through the canonical position index plus locally retained touched pools, including pools whose final position was closed. Read current fees, unused funds and payout progress. Pool pages are complete only when nextCursor is null and errors is empty; positions within each returned pool are not truncated.",
    inputSchema: { type: "object", properties: { ...pageProperties, pool: poolProperty }, additionalProperties: false },
    outputSchema: { type: "object" }, annotations: readAnnotations,
  }, async (args, context) => {
    const owner = await dependencies.accountFor(context);
    const localErrors: JsonObject[] = [];
    let retained: string[] = [];
    try {
      const result = await dependencies.retainedPoolsFor?.(context) ?? [];
      if (Array.isArray(result)) retained = result;
      else { retained = result.pools; localErrors.push(...result.errors); }
    }
    catch (error) {
      if (context.signal?.aborted) throw error;
      localErrors.push({ method: "retainedPoolDiscovery", message: describeError(error) });
    }
    const discovery = await reads.discoverOwnedPools(owner, retained, context.signal);
    const chosenPool = args.pool === undefined ? undefined : requiredLedgerId(args, "pool");
    // An explicit pool can still contain funds when its position index is stale.
    const candidates = chosenPool ? [{ pool: chosenPool }] : discovery.pools;
    const page = pageByPool(candidates, args, 3);
    const pools: BrowserPoolView[] = [];
    for (const item of page.items) {
      if (context.signal?.aborted) throw context.signal.reason;
      try { pools.push(await reads.readPool(item.pool, owner, context.signal)); }
      catch (error) {
        if (context.signal?.aborted) throw error;
        localErrors.push({ canister: item.pool, method: "readPool", message: describeError(error) });
      }
    }
    const errors = [...discovery.errors, ...localErrors, ...pools.flatMap((pool) => pool.errors)];
    return {
      owner, source: discovery.source, indexedPools: discovery.indexedPools, retainedPools: discovery.retainedPools,
      pools, totalPools: page.total, nextCursor: page.nextCursor, errors,
      complete: errors.length === 0 && page.nextCursor === null,
      settlementNote: "Current pool records and withdrawal queues are observations, not final ledger receipts. Retain operation IDs when an effect is uncertain.",
    };
  });

  register("icpswap_liquidity_range_v1", {
    title: "Size an ICPSwap liquidity range",
    description: "Use current pool price and exact integer arithmetic to size tick-aligned liquidity from maximum token0/token1 atomic amounts. Returns estimated use and remainder, full-range bounds and optional token1-per-token0 prices. Does not prepare, fund or execute an action.",
    inputSchema: { type: "object", properties: {
      pool: poolProperty, tickLower: { type: "integer" }, tickUpper: { type: "integer" },
      amount0: { type: "string", pattern: "^[0-9]+$", description: "Maximum token0 atomic amount." },
      amount1: { type: "string", pattern: "^[0-9]+$", description: "Maximum token1 atomic amount." },
      decimals0: { type: "integer", minimum: 0, maximum: 255 }, decimals1: { type: "integer", minimum: 0, maximum: 255 },
    }, required: ["pool", "tickLower", "tickUpper", "amount0", "amount1"], additionalProperties: false },
    outputSchema: { type: "object" }, annotations: readAnnotations,
  }, async (args, context) => calculateLiquidityRange(await reads.readPool(requiredLedgerId(args, "pool"), undefined, context.signal), args));

}
