// Typed client for the public ICPSwap analytics API.
//
// This is the "rich" data plane: 24h/7d/total volume, TVL and its change, OHLC
// candles, per-pool statistics, market cap and holders. It runs in the browser
// because the full token universe (~740 KB) is far larger than a replicated
// HTTPS outcall may return, and because parsing this much JSON belongs in the
// frontend rather than in canister code.
//
// Every response is treated as untrusted: fields are parsed defensively, all
// upstream numerics arrive as decimal strings, and timestamps arrive in
// milliseconds.

const BASE_URL = "https://api.icpswap.com/info";

/** The ICP ledger, used as the denominating reference for the ICP price view. */
export const ICP_LEDGER_ID = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const DEFAULT_TIMEOUT_MS = 20_000;

export class IcpSwapApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "IcpSwapApiError";
    this.status = status;
  }
}

/** Convert an upstream decimal string (or number) into a finite number. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Upstream times are epoch milliseconds; the app works in epoch seconds. */
function toSeconds(value: unknown): number {
  const ms = toNumber(value);
  if (ms <= 0) return 0;
  return Math.round(ms > 1e12 ? ms / 1000 : ms);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new IcpSwapApiError(
        `ICPSwap API returned ${response.status}`,
        response.status,
      );
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new IcpSwapApiError("Malformed ICPSwap response");
    const code = toNumber(body.code);
    if (code !== 200 && code !== 0) {
      throw new IcpSwapApiError(
        toText(body.message) || `ICPSwap API error ${code}`,
      );
    }
    return body.data;
  } catch (error) {
    if (error instanceof IcpSwapApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new IcpSwapApiError("ICPSwap request timed out or was cancelled");
    }
    throw new IcpSwapApiError(
      error instanceof Error ? error.message : "ICPSwap request failed",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------------------------------------------------------------- token stats

export type InfoToken = {
  ledgerId: string;
  name: string;
  symbol: string;
  price: number;
  priceChange24H: number;
  tvlUSD: number;
  tvlUSDChange24H: number;
  txCount24H: number;
  volumeUSD24H: number;
  volumeUSD7D: number;
  totalVolumeUSD: number;
  priceLow24H: number;
  priceHigh24H: number;
  priceLow7D: number;
  priceHigh7D: number;
  priceLow30D: number;
  priceHigh30D: number;
};

function parseInfoToken(value: unknown): InfoToken | null {
  if (!isRecord(value)) return null;
  const ledgerId = toText(value.tokenLedgerId);
  if (ledgerId === "") return null;
  return {
    ledgerId,
    name: toText(value.tokenName),
    symbol: toText(value.tokenSymbol),
    price: toNumber(value.price),
    priceChange24H: toNumber(value.priceChange24H),
    tvlUSD: toNumber(value.tvlUSD),
    tvlUSDChange24H: toNumber(value.tvlUSDChange24H),
    txCount24H: toNumber(value.txCount24H),
    volumeUSD24H: toNumber(value.volumeUSD24H),
    volumeUSD7D: toNumber(value.volumeUSD7D),
    totalVolumeUSD: toNumber(value.totalVolumeUSD),
    priceLow24H: toNumber(value.priceLow24H),
    priceHigh24H: toNumber(value.priceHigh24H),
    priceLow7D: toNumber(value.priceLow7D),
    priceHigh7D: toNumber(value.priceHigh7D),
    priceLow30D: toNumber(value.priceLow30D),
    priceHigh30D: toNumber(value.priceHigh30D),
  };
}

export async function fetchAllTokens(signal?: AbortSignal): Promise<InfoToken[]> {
  const data = await getJson("/token/all", signal);
  if (!Array.isArray(data)) throw new IcpSwapApiError("Malformed token list");
  const tokens: InfoToken[] = [];
  for (const entry of data) {
    const token = parseInfoToken(entry);
    if (token) tokens.push(token);
  }
  return tokens;
}

// ------------------------------------------------------- ranked / valuation

export type InfoTokenRank = {
  ledgerId: string;
  name: string;
  symbol: string;
  price: number;
  priceChange24H: number;
  fdv: number;
  marketCap: number;
  tvlUSD: number;
  volumeUSD24H: number;
  holders: number;
  rank: number;
};

function parseInfoTokenRank(value: unknown): InfoTokenRank | null {
  if (!isRecord(value)) return null;
  const ledgerId = toText(value.tokenLedgerId);
  if (ledgerId === "") return null;
  return {
    ledgerId,
    name: toText(value.tokenName),
    symbol: toText(value.tokenSymbol),
    price: toNumber(value.price),
    priceChange24H: toNumber(value.priceChange24H),
    fdv: toNumber(value.fdv),
    marketCap: toNumber(value.marketCap),
    tvlUSD: toNumber(value.tvlUSD),
    volumeUSD24H: toNumber(value.volumeUSD24H),
    holders: toNumber(value.holder),
    rank: toNumber(value.rank),
  };
}

/** Top tokens with market cap, fully diluted valuation, and holder counts. */
export async function fetchTokenRanks(
  signal?: AbortSignal,
): Promise<InfoTokenRank[]> {
  const data = await getJson("/token/chart/list", signal);
  if (!Array.isArray(data)) throw new IcpSwapApiError("Malformed token ranks");
  const ranks: InfoTokenRank[] = [];
  for (const entry of data) {
    const rank = parseInfoTokenRank(entry);
    if (rank) ranks.push(rank);
  }
  return ranks;
}

// ------------------------------------------------------------------- pools

export type InfoPool = {
  poolId: string;
  poolFee: number;
  token0LedgerId: string;
  token0Name: string;
  token0Symbol: string;
  token0Price: number;
  token0LiquidityAmount: number;
  token1LedgerId: string;
  token1Name: string;
  token1Symbol: string;
  token1Price: number;
  token1LiquidityAmount: number;
  tvlUSD: number;
  tvlUSDChange24H: number;
  txCount24H: number;
  feesUSD24H: number;
  volumeUSD24H: number;
  volumeUSD7D: number;
  totalVolumeUSD: number;
  createTime: number;
};

function parseInfoPool(value: unknown): InfoPool | null {
  if (!isRecord(value)) return null;
  const poolId = toText(value.poolId);
  if (poolId === "") return null;
  return {
    poolId,
    poolFee: toNumber(value.poolFee),
    token0LedgerId: toText(value.token0LedgerId),
    token0Name: toText(value.token0Name),
    token0Symbol: toText(value.token0Symbol),
    token0Price: toNumber(value.token0Price),
    token0LiquidityAmount: toNumber(value.token0LiquidityAmount),
    token1LedgerId: toText(value.token1LedgerId),
    token1Name: toText(value.token1Name),
    token1Symbol: toText(value.token1Symbol),
    token1Price: toNumber(value.token1Price),
    token1LiquidityAmount: toNumber(value.token1LiquidityAmount),
    tvlUSD: toNumber(value.tvlUSD),
    tvlUSDChange24H: toNumber(value.tvlUSDChange24H),
    txCount24H: toNumber(value.txCount24H),
    feesUSD24H: toNumber(value.feesUSD24H),
    volumeUSD24H: toNumber(value.volumeUSD24H),
    volumeUSD7D: toNumber(value.volumeUSD7D),
    totalVolumeUSD: toNumber(value.totalVolumeUSD),
    createTime: toSeconds(value.createTime),
  };
}

export async function fetchTokenPools(
  ledgerId: string,
  signal?: AbortSignal,
): Promise<InfoPool[]> {
  const data = await getJson(
    `/token/${encodeURIComponent(ledgerId)}/pool`,
    signal,
  );
  if (!Array.isArray(data)) throw new IcpSwapApiError("Malformed pool list");
  const pools: InfoPool[] = [];
  for (const entry of data) {
    const pool = parseInfoPool(entry);
    if (pool) pools.push(pool);
  }
  return pools;
}

// ------------------------------------------------------------------- charts

export type ChartLevel = "m15" | "h1" | "d1";

export type InfoCandle = {
  /** Bucket start, epoch seconds. Aligned across series. */
  t: number;
  /** When the snapshot was taken, epoch seconds. Drifts; do not align on it. */
  snapshotAt: number;
  open: number;
  high: number;
  low: number;
  close: number;
  price: number;
  volumeUSD: number;
  tvlUSD: number;
  txCount: number;
};

function parseCandle(value: unknown): InfoCandle | null {
  if (!isRecord(value)) return null;
  const snapshotAt = toSeconds(value.snapshotTime);
  // `beginTime` is the canonical bucket boundary and is what makes two series
  // comparable; fall back to the snapshot only if upstream omits it.
  const t = toSeconds(value.beginTime) || snapshotAt;
  if (t === 0) return null;
  const close = toNumber(value.close);
  const price = toNumber(value.price);
  return {
    t,
    snapshotAt,
    open: toNumber(value.open),
    high: toNumber(value.high),
    low: toNumber(value.low),
    close: close || price,
    price: price || close,
    volumeUSD: toNumber(value.volumeUSD),
    tvlUSD: toNumber(value.tvlUSD),
    txCount: toNumber(value.txCount),
  };
}

export type CandlePage = {
  candles: InfoCandle[];
  total: number;
};

function parseCandlePage(data: unknown): CandlePage {
  if (!isRecord(data) || !Array.isArray(data.content)) {
    throw new IcpSwapApiError("Malformed chart response");
  }
  const candles: InfoCandle[] = [];
  for (const entry of data.content) {
    const candle = parseCandle(entry);
    if (candle) candles.push(candle);
  }
  // Upstream returns newest first; charts read left to right.
  candles.sort((left, right) => left.t - right.t);
  return { candles, total: toNumber(data.totalElements) };
}

export async function fetchTokenChart(
  ledgerId: string,
  level: ChartLevel,
  limit: number,
  signal?: AbortSignal,
): Promise<CandlePage> {
  const data = await getJson(
    `/token/${encodeURIComponent(ledgerId)}/chart/${level}?page=1&limit=${Math.max(1, Math.min(1000, Math.trunc(limit)))}`,
    signal,
  );
  return parseCandlePage(data);
}

export async function fetchPoolChart(
  poolId: string,
  level: ChartLevel,
  limit: number,
  signal?: AbortSignal,
): Promise<CandlePage> {
  const data = await getJson(
    `/pool/${encodeURIComponent(poolId)}/chart/${level}?page=1&limit=${Math.max(1, Math.min(1000, Math.trunc(limit)))}`,
    signal,
  );
  return parseCandlePage(data);
}

// -------------------------------------------------------------- transactions

export type InfoTransaction = {
  poolId: string;
  poolFee: number;
  actionType: string;
  token0Symbol: string;
  token1Symbol: string;
  token0AmountIn: number;
  token1AmountIn: number;
  token0AmountOut: number;
  token1AmountOut: number;
  token0TxValue: number;
  token1TxValue: number;
  from: string;
  to: string;
  txHash: string;
  /** Epoch seconds. */
  txTime: number;
};

function parseTransaction(value: unknown): InfoTransaction | null {
  if (!isRecord(value)) return null;
  const poolId = toText(value.poolId);
  if (poolId === "") return null;
  return {
    poolId,
    poolFee: toNumber(value.poolFee),
    actionType: toText(value.actionType),
    token0Symbol: toText(value.token0Symbol),
    token1Symbol: toText(value.token1Symbol),
    token0AmountIn: toNumber(value.token0AmountIn),
    token1AmountIn: toNumber(value.token1AmountIn),
    token0AmountOut: toNumber(value.token0AmountOut),
    token1AmountOut: toNumber(value.token1AmountOut),
    token0TxValue: toNumber(value.token0TxValue),
    token1TxValue: toNumber(value.token1TxValue),
    from: toText(value.fromTextualId) || toText(value.fromPrincipalId),
    to: toText(value.toTextualId) || toText(value.toPrincipalId),
    txHash: toText(value.txHash),
    txTime: toSeconds(value.txTime),
  };
}

export type TransactionPage = {
  trades: InfoTransaction[];
  /** Trades the upstream reports for this token in total, across all pages. */
  total: number;
};

/**
 * One page of a token's trade log, newest first.
 *
 * `page` is 1-based, as the upstream expects. A token can have a very long
 * history — ckBTC reports 118,896 trades — so the caller pages rather than
 * asking for everything.
 */
export async function fetchTokenTransactionPage(
  ledgerId: string,
  page: number,
  limit: number,
  signal?: AbortSignal,
): Promise<TransactionPage> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const boundedPage = Math.max(1, Math.trunc(page));
  const data = await getJson(
    `/transaction/find?tokenId=${encodeURIComponent(ledgerId)}&page=${boundedPage}&limit=${boundedLimit}`,
    signal,
  );
  if (!isRecord(data) || !Array.isArray(data.content)) {
    throw new IcpSwapApiError("Malformed transaction response");
  }
  const trades: InfoTransaction[] = [];
  for (const entry of data.content) {
    const transaction = parseTransaction(entry);
    if (transaction) trades.push(transaction);
  }
  return { trades, total: Math.max(0, Math.trunc(toNumber(data.totalElements))) };
}

/** The most recent trades for a token. */
export async function fetchTokenTransactions(
  ledgerId: string,
  limit: number,
  signal?: AbortSignal,
): Promise<InfoTransaction[]> {
  const page = await fetchTokenTransactionPage(ledgerId, 1, limit, signal);
  return page.trades;
}

// -------------------------------------------------------------------- cache

type CacheEntry<T> = {
  at: number;
  value: Promise<T>;
};

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Share one in-flight request per key and reuse its result for `ttlMs`. Keeps
 * the tile, the resident background, and every agent tool from stampeding the
 * upstream API with identical requests.
 */
export function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && now - existing.at < ttlMs) {
    return existing.value as Promise<T>;
  }
  const value = load().catch((error: unknown) => {
    // A failed load must not be cached, or one blip poisons the TTL window.
    if (cache.get(key)?.value === (value as Promise<unknown>)) cache.delete(key);
    throw error;
  });
  cache.set(key, { at: now, value: value as Promise<unknown> });
  return value;
}

export function invalidateCache(): void {
  cache.clear();
}

/** The token universe, shared across the tile and the resident background. */
export function loadTokenUniverse(
  ttlMs = 60_000,
  signal?: AbortSignal,
): Promise<InfoToken[]> {
  return cached("token/all", ttlMs, () => fetchAllTokens(signal));
}

export function loadTokenRanks(
  ttlMs = 300_000,
  signal?: AbortSignal,
): Promise<InfoTokenRank[]> {
  return cached("token/ranks", ttlMs, () => fetchTokenRanks(signal));
}

export function loadTokenPools(
  ledgerId: string,
  ttlMs = 120_000,
  signal?: AbortSignal,
): Promise<InfoPool[]> {
  return cached(`token/pools/${ledgerId}`, ttlMs, () =>
    fetchTokenPools(ledgerId, signal),
  );
}

// ------------------------------------------------------- currency conversion

/**
 * Re-express a token's candles in ICP by dividing each bucket by the matching
 * ICP/USD bucket.
 *
 * Dividing by the *current* ICP price would only rescale the series and hide
 * the very thing this view exists to show: whether the token gained or lost
 * ground against ICP. Buckets are matched on `t`, which is the aligned bucket
 * start, and a bucket present in only one series is dropped rather than
 * guessed at.
 *
 * Open and close are exact — both are point-in-time values. High and low are
 * an approximation: the true extreme of a ratio inside a bucket cannot be
 * recovered from two sets of bucket extremes, so each is divided componentwise
 * and then widened to contain the body, which keeps every candle valid.
 */
export function denominateInIcp(
  candles: InfoCandle[],
  icpCandles: InfoCandle[],
): InfoCandle[] {
  const icpByBucket = new Map<number, InfoCandle>();
  for (const candle of icpCandles) icpByBucket.set(candle.t, candle);

  const converted: InfoCandle[] = [];
  for (const candle of candles) {
    const icp = icpByBucket.get(candle.t);
    if (!icp) continue;
    const open = ratio(candle.open, icp.open);
    const close = ratio(candle.close, icp.close);
    if (open === 0 && close === 0) continue;
    const high = Math.max(ratio(candle.high, icp.high), open, close);
    const low = lowerBound(Math.min(ratio(candle.low, icp.low), open, close));
    converted.push({
      ...candle,
      open,
      high,
      low,
      close,
      price: close,
      // Volume and TVL stay in USD: they are not prices and re-expressing them
      // in ICP would invite reading them as one.
    });
  }
  return converted;
}

function ratio(value: number, divisor: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) {
    return 0;
  }
  const result = value / divisor;
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function lowerBound(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
