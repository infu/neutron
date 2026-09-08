// Typed wrapper over this app's own Neutron backend.
//
// Every method here is declared in `preapproved_self_calls`, so the kernel
// signs it with the owner identity without a per-call dialog. Motoko `Nat` and
// `Int` arrive as lossless decimal strings and `?T` arrives as the value or
// null, so each field is normalised explicitly.

import {
  isJsonObject,
  querySelf,
  updateSelf,
  type JsonObject,
  type JsonValue,
  type ScopedKernelClient,
} from "neutron-tools/app";

export type BackendTransport = Pick<ScopedKernelClient, "querySelf" | "updateSelf">;
const browserBackend: BackendTransport = { querySelf, updateSelf };

/** Every Agent call retains its invocation-scoped transport. Tile callers can
 * use the existing named helpers with the ordinary browser transport. */
export function createBackendClient(kernel: BackendTransport) {
  return {
    getStatus: () => getStatus(kernel),
    getMarket: (sort: SortKey, ascending: boolean) => getMarket(sort, ascending, kernel),
    searchTokens: (term: string, offset: number, limit: number) => searchTokens(term, offset, limit, kernel),
    getToken: (address: string) => getToken(address, kernel),
    getHistory: (address: string, limit: number) => getHistory(address, limit, kernel),
    refresh: (force: boolean) => refresh(force, kernel),
    addToken: (request: AddTokenRequest) => addToken(request, kernel),
    removeToken: (address: string) => removeToken(address, kernel),
    forgetToken: (address: string) => forgetToken(address, kernel),
    setPinned: (address: string, pinned: boolean) => setPinned(address, pinned, kernel),
    setNote: (address: string, note: string) => setNote(address, note, kernel),
    quoteSwap: (request: SwapRequest) => quoteSwap(request, kernel),
    executeSwap: (request: SwapRequest) => executeSwap(request, kernel),
    getSwapJournal: (limit = 20) => getSwapJournal(limit, kernel),
    setSlippage: (value: number) => setSlippage(value, kernel),
    setTokenInfo: (address: string, decimals: number, fee: bigint) => setTokenInfo(address, decimals, fee, kernel),
  };
}

export type MarketStatus = {
  lastRefreshAt: number;
  lastRefreshError: string | null;
  refreshCount: number;
  universeTokens: number;
  universePools: number;
  verifiedTokens: number;
  icpPriceUsd: number;
  pricedTokens: number;
  pendingDecimals: number;
  cacheAgeSeconds: number;
  cacheReady: boolean;
  watchlistSize: number;
  historyLimit: number;
};

/** Which pool an on-chain price was derived from. */
export type QuoteSource = {
  pool: string;
  quoteAddress: string;
  quoteSymbol: string;
  feeTier: number;
  liquidity: number;
  viaIcp: boolean;
};

export type MarketRow = {
  address: string;
  symbol: string;
  name: string;
  standard: string;
  decimals: number;
  priceUsd: number;
  priceIcp: number;
  quote: QuoteSource | null;
  poolCount: number;
  pinned: boolean;
  note: string;
  addedAt: number;
  verified: boolean;
  sampleCount: number;
  sparkline: number[];
};

export type MarketSnapshot = {
  rows: MarketRow[];
  status: MarketStatus;
};

export type TokenCandidate = {
  address: string;
  symbol: string;
  name: string;
  standard: string;
  decimals: number;
  poolCount: number;
  verified: boolean;
  watched: boolean;
};

export type SearchPage = {
  items: TokenCandidate[];
  total: number;
  offset: number;
  universe: number;
  cacheAgeSeconds: number;
};

export type MediaLink = {
  link: string;
  mediaType: string;
};

export type TokenProfile = {
  address: string;
  symbol: string;
  name: string;
  standard: string;
  decimals: number;
  fee: number;
  totalSupply: number;
  introduction: string;
  links: MediaLink[];
  rank: number;
};

export type PoolRow = {
  pool: string;
  feeTier: number;
  token0Id: string;
  token0Symbol: string;
  token1Id: string;
  token1Symbol: string;
};

export type Sample = {
  t: number;
  priceUsd: number;
  priceIcp: number;
};

export type TokenDetail = {
  row: MarketRow;
  profile: TokenProfile | null;
  pools: PoolRow[];
  poolCount: number;
  history: Sample[];
  status: MarketStatus;
};

export type HistoryPage = {
  address: string;
  samples: Sample[];
  total: number;
  historyLimit: number;
};

export type RefreshReport = {
  refreshed: boolean;
  pools: number;
  verified: number;
  priced: number;
  decimalsResolved: number;
  recorded: number;
  callsUsed: number;
  errors: string[];
  status: MarketStatus;
};

export type WatchlistReport = {
  ok: boolean;
  message: string;
  watchlistSize: number;
};

export type SortKey = "symbol" | "price" | "pools" | "added";

// ------------------------------------------------------------------ parsing

function record(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`Invalid ${label} from backend`);
  return value;
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function flag(value: unknown): boolean {
  return value === true;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(num);
}

function parseStatus(value: JsonValue): MarketStatus {
  const raw = record(value, "market status");
  return {
    lastRefreshAt: num(raw.last_refresh_at),
    lastRefreshError: optionalText(raw.last_refresh_error),
    refreshCount: num(raw.refresh_count),
    universeTokens: num(raw.universe_tokens),
    universePools: num(raw.universe_pools),
    verifiedTokens: num(raw.verified_tokens),
    icpPriceUsd: num(raw.icp_price_usd),
    pricedTokens: num(raw.priced_tokens),
    pendingDecimals: num(raw.pending_decimals),
    cacheAgeSeconds: num(raw.cache_age_seconds),
    cacheReady: flag(raw.cache_ready),
    watchlistSize: num(raw.watchlist_size),
    historyLimit: num(raw.history_limit),
  };
}

function parseQuote(value: unknown): QuoteSource | null {
  if (!isJsonObject(value as JsonValue)) return null;
  const raw = value as JsonObject;
  return {
    pool: text(raw.pool),
    quoteAddress: text(raw.quote_address),
    quoteSymbol: text(raw.quote_symbol),
    feeTier: num(raw.fee_tier),
    liquidity: num(raw.liquidity),
    viaIcp: flag(raw.via_icp),
  };
}

function parseRow(value: JsonValue): MarketRow {
  const raw = record(value, "market row");
  return {
    address: text(raw.address),
    symbol: text(raw.symbol),
    name: text(raw.name),
    standard: text(raw.standard),
    decimals: num(raw.decimals),
    priceUsd: num(raw.price_usd),
    priceIcp: num(raw.price_icp),
    quote: parseQuote(raw.quote),
    poolCount: num(raw.pool_count),
    pinned: flag(raw.pinned),
    note: text(raw.note),
    addedAt: num(raw.added_at),
    verified: flag(raw.verified),
    sampleCount: num(raw.sample_count),
    sparkline: numbers(raw.sparkline),
  };
}

function parseCandidate(value: JsonValue): TokenCandidate {
  const raw = record(value, "token candidate");
  return {
    address: text(raw.address),
    symbol: text(raw.symbol),
    name: text(raw.name),
    standard: text(raw.standard),
    decimals: num(raw.decimals),
    poolCount: num(raw.pool_count),
    verified: flag(raw.verified),
    watched: flag(raw.watched),
  };
}

function parseSample(value: JsonValue): Sample {
  const raw = record(value, "sample");
  return {
    t: num(raw.t),
    priceUsd: num(raw.price_usd),
    priceIcp: num(raw.price_icp),
  };
}

function parsePool(value: JsonValue): PoolRow {
  const raw = record(value, "pool row");
  return {
    pool: text(raw.pool),
    feeTier: num(raw.fee_tier),
    token0Id: text(raw.token0_id),
    token0Symbol: text(raw.token0_symbol),
    token1Id: text(raw.token1_id),
    token1Symbol: text(raw.token1_symbol),
  };
}

function parseProfile(value: unknown): TokenProfile | null {
  if (!isJsonObject(value as JsonValue)) return null;
  const raw = value as JsonObject;
  const links: MediaLink[] = Array.isArray(raw.links)
    ? raw.links.flatMap((entry) =>
        isJsonObject(entry)
          ? [{ link: text(entry.link), mediaType: text(entry.mediaType) }]
          : [],
      )
    : [];
  return {
    address: text(raw.address),
    symbol: text(raw.symbol),
    name: text(raw.name),
    standard: text(raw.standard),
    decimals: num(raw.decimals),
    fee: num(raw.fee),
    totalSupply: num(raw.total_supply),
    introduction: text(raw.introduction),
    links,
    rank: num(raw.rank),
  };
}

function parseReport(value: JsonValue): WatchlistReport {
  const raw = record(value, "watchlist report");
  return {
    ok: flag(raw.ok),
    message: text(raw.message),
    watchlistSize: num(raw.watchlist_size),
  };
}

function list(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

// ------------------------------------------------------------------- calls

export async function getStatus(kernel: BackendTransport = browserBackend): Promise<MarketStatus> {
  return parseStatus((await kernel.querySelf("icpswap_status", [null])) as JsonValue);
}

export async function getMarket(sort: SortKey,
  ascending: boolean, kernel: BackendTransport = browserBackend): Promise<MarketSnapshot> {
  const raw = record(
    (await kernel.querySelf("icpswap_market", [{ sort, ascending }])) as JsonValue,
    "market snapshot",
  );
  return {
    rows: list(raw.rows).map(parseRow),
    status: parseStatus(raw.status as JsonValue),
  };
}

export async function searchTokens(term: string,
  offset: number,
  limit: number, kernel: BackendTransport = browserBackend): Promise<SearchPage> {
  const raw = record(
    (await kernel.querySelf("icpswap_search", [
      { term, offset: String(Math.max(0, Math.trunc(offset))), limit: String(Math.max(1, Math.trunc(limit))) },
    ])) as JsonValue,
    "search page",
  );
  return {
    items: list(raw.items).map(parseCandidate),
    total: num(raw.total),
    offset: num(raw.offset),
    universe: num(raw.universe),
    cacheAgeSeconds: num(raw.cache_age_seconds),
  };
}

export async function getToken(address: string, kernel: BackendTransport = browserBackend): Promise<TokenDetail | null> {
  const value = (await kernel.querySelf("icpswap_token", [address])) as JsonValue;
  if (value === null || value === undefined) return null;
  const raw = record(value, "token detail");
  return {
    row: parseRow(raw.row as JsonValue),
    profile: parseProfile(raw.profile),
    pools: list(raw.pools).map(parsePool),
    poolCount: num(raw.pool_count),
    history: list(raw.history).map(parseSample),
    status: parseStatus(raw.status as JsonValue),
  };
}

export async function getHistory(address: string,
  limit: number, kernel: BackendTransport = browserBackend): Promise<HistoryPage> {
  const raw = record(
    (await kernel.querySelf("icpswap_history", [
      { address, limit: String(Math.max(1, Math.trunc(limit))) },
    ])) as JsonValue,
    "history page",
  );
  return {
    address: text(raw.address),
    samples: list(raw.samples).map(parseSample),
    total: num(raw.total),
    historyLimit: num(raw.history_limit),
  };
}

export async function refresh(force: boolean, kernel: BackendTransport = browserBackend): Promise<RefreshReport> {
  const raw = record(
    (await kernel.updateSelf("icpswap_refresh", [force], 120)) as JsonValue,
    "refresh report",
  );
  return {
    refreshed: flag(raw.refreshed),
    pools: num(raw.pools),
    verified: num(raw.verified),
    priced: num(raw.priced),
    decimalsResolved: num(raw.decimals_resolved),
    recorded: num(raw.recorded),
    callsUsed: num(raw.calls_used),
    errors: list(raw.errors).map((entry) => text(entry)),
    status: parseStatus(raw.status as JsonValue),
  };
}

export type AddTokenRequest = {
  address: string;
  symbol: string;
  name: string;
  standard: string;
  decimals: number;
};

export async function addToken(request: AddTokenRequest, kernel: BackendTransport = browserBackend): Promise<WatchlistReport> {
  return parseReport(
    (await kernel.updateSelf("icpswap_add", [
      {
        address: request.address,
        symbol: request.symbol,
        name: request.name,
        standard: request.standard,
        decimals: String(Math.max(0, Math.trunc(request.decimals))),
      },
    ])) as JsonValue,
  );
}

export async function removeToken(address: string, kernel: BackendTransport = browserBackend): Promise<WatchlistReport> {
  return parseReport(
    (await kernel.updateSelf("icpswap_remove", [address])) as JsonValue,
  );
}

export async function forgetToken(address: string, kernel: BackendTransport = browserBackend): Promise<WatchlistReport> {
  return parseReport(
    (await kernel.updateSelf("icpswap_forget", [address])) as JsonValue,
  );
}

export async function setPinned(address: string,
  pinned: boolean, kernel: BackendTransport = browserBackend): Promise<WatchlistReport> {
  return parseReport(
    (await kernel.updateSelf("icpswap_set_pinned", [{ address, pinned }])) as JsonValue,
  );
}

export async function setNote(address: string,
  note: string, kernel: BackendTransport = browserBackend): Promise<WatchlistReport> {
  return parseReport(
    (await kernel.updateSelf("icpswap_set_note", [{ address, note }])) as JsonValue,
  );
}

// ------------------------------------------------------------------- swapping

export type SwapQuote = {
  pool: string;
  poolKey: string;
  feeTier: number;
  inputAddress: string;
  outputAddress: string;
  decimalsIn: number;
  decimalsOut: number;
  zeroForOne: boolean;
  amountIn: bigint;
  quotedOut: bigint;
  amountOutMinimum: bigint;
  expectedOut: bigint;
  tokenInFee: bigint;
  tokenOutFee: bigint;
  fundingAmount: bigint;
  totalDebit: bigint;
  priceImpact: number;
  warn: boolean;
  slippage: number;
  /** Where to send the Wallet funding request for this swap. */
  fundingLedger: string;
  fundingSpender: string;
  at: number;
};

export type SwapReceipt = {
  requestId: string;
  state: string;
  pool: string;
  inputAddress: string;
  outputAddress: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  swappedOut: bigint;
  receivedOut: bigint;
  detail: string;
  needsFunding: boolean;
  fundingLedger: string;
  fundingSpender: string;
  fundingAmount: bigint;
  at: number;
};

export type SwapJournalEntry = {
  requestId: string;
  pool: string;
  poolKey: string;
  inputAddress: string;
  outputAddress: string;
  inputSymbol: string;
  outputSymbol: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  quotedOut: bigint;
  swappedOut: bigint;
  tokenInFee: bigint;
  tokenOutFee: bigint;
  slippage: number;
  state: string;
  fundingStatus: string;
  fundingBlock: string;
  detail: string;
  startedAt: number;
  updatedAt: number;
};

export type SwapJournalPage = {
  entries: SwapJournalEntry[];
  total: number;
  completed: number;
  slippage: number;
};

/** Amounts are base units and can exceed `Number.MAX_SAFE_INTEGER`. */
function big(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^[0-9]+$/u.test(value.trim())) {
    return BigInt(value.trim());
  }
  return 0n;
}

function parseSwapQuote(raw: JsonObject): SwapQuote {
  return {
    pool: text(raw.pool),
    poolKey: text(raw.pool_key),
    feeTier: num(raw.fee_tier),
    inputAddress: text(raw.input_address),
    outputAddress: text(raw.output_address),
    decimalsIn: num(raw.decimals_in),
    decimalsOut: num(raw.decimals_out),
    zeroForOne: raw.zero_for_one === true,
    amountIn: big(raw.amount_in),
    quotedOut: big(raw.quoted_out),
    amountOutMinimum: big(raw.amount_out_minimum),
    expectedOut: big(raw.expected_out),
    tokenInFee: big(raw.token_in_fee),
    tokenOutFee: big(raw.token_out_fee),
    fundingAmount: big(raw.funding_amount),
    totalDebit: big(raw.total_debit),
    priceImpact: num(raw.price_impact),
    warn: raw.warn === true,
    slippage: num(raw.slippage),
    fundingLedger: text(raw.funding_ledger),
    fundingSpender: text(raw.funding_spender),
    at: num(raw.at),
  };
}

export type SwapRequest = {
  requestId: string;
  inputAddress: string;
  outputAddress: string;
  amountIn: bigint;
  slippage: number;
};

function toWire(request: SwapRequest): JsonValue {
  return {
    request_id: request.requestId,
    input_address: request.inputAddress,
    output_address: request.outputAddress,
    amount_in: request.amountIn.toString(),
    slippage: request.slippage,
  } as unknown as JsonValue;
}

/**
 * Price a swap. Moves nothing, grants nothing, and can be called as often as
 * the UI needs.
 */
export async function quoteSwap(request: SwapRequest, kernel: BackendTransport = browserBackend): Promise<SwapQuote> {
  const value = record(
    (await kernel.updateSelf("icpswap_swap_quote", [toWire(request)])) as JsonValue,
    "swap quote",
  );
  // Successful Candid Results are already unwrapped; the error arm rejects.
  return parseSwapQuote(value);
}

/**
 * Execute a swap against an allowance the Wallet has already granted.
 *
 * The backend re-quotes rather than trusting anything passed here, so a stale
 * minimum cannot reach the pool.
 */
export async function executeSwap(request: SwapRequest, kernel: BackendTransport = browserBackend): Promise<SwapReceipt> {
  const raw = record(
    (await kernel.updateSelf("icpswap_swap_execute", [toWire(request)])) as JsonValue,
    "swap receipt",
  );
  return {
    requestId: text(raw.request_id),
    state: text(raw.state),
    pool: text(raw.pool),
    inputAddress: text(raw.input_address),
    outputAddress: text(raw.output_address),
    amountIn: big(raw.amount_in),
    amountOutMinimum: big(raw.amount_out_minimum),
    swappedOut: big(raw.swapped_out),
    receivedOut: big(raw.received_out),
    detail: text(raw.detail),
    needsFunding: raw.needs_funding === true,
    fundingLedger: text(raw.funding_ledger),
    fundingSpender: text(raw.funding_spender),
    fundingAmount: big(raw.funding_amount),
    at: num(raw.at),
  };
}

export async function getSwapJournal(limit = 20, kernel: BackendTransport = browserBackend): Promise<SwapJournalPage> {
  const raw = record(
    (await kernel.querySelf("icpswap_swap_journal", [limit])) as JsonValue,
    "swap journal",
  );
  return {
    entries: list(raw.entries).map((entry) => {
      const item = record(entry, "swap journal entry");
      return {
        requestId: text(item.request_id),
        pool: text(item.pool),
        poolKey: text(item.pool_key),
        inputAddress: text(item.input_address),
        outputAddress: text(item.output_address),
        inputSymbol: text(item.input_symbol),
        outputSymbol: text(item.output_symbol),
        amountIn: big(item.amount_in),
        amountOutMinimum: big(item.amount_out_minimum),
        quotedOut: big(item.quoted_out),
        swappedOut: big(item.swapped_out),
        tokenInFee: big(item.token_in_fee),
        tokenOutFee: big(item.token_out_fee),
        slippage: num(item.slippage),
        state: text(item.state),
        fundingStatus: text(item.funding_status),
        fundingBlock: text(item.funding_block),
        detail: text(item.detail),
        startedAt: num(item.started_at),
        updatedAt: num(item.updated_at),
      };
    }),
    total: num(raw.total),
    completed: num(raw.completed),
    slippage: num(raw.slippage),
  };
}

export async function setSlippage(value: number, kernel: BackendTransport = browserBackend): Promise<number> {
  return num((await kernel.updateSelf("icpswap_set_slippage", [value])) as JsonValue);
}

/**
 * Cache what the Wallet reports about a token.
 *
 * This app cannot read a ledger, so decimals and the transfer fee arrive from
 * the Wallet and are kept by the backend: decimals let the scheduled refresh
 * price an uncurated token with no browser open, and the fee lets a quote
 * refuse a swap whose pool fee cache has gone stale.
 */
export async function setTokenInfo(address: string,
  decimals: number,
  fee: bigint, kernel: BackendTransport = browserBackend): Promise<boolean> {
  const value = await kernel.updateSelf("icpswap_set_token_info", [
    { address, decimals, fee: fee.toString() } as unknown as JsonValue,
  ]);
  return value === true;
}
