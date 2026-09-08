/** Direct browser reads for the validator-operated perpetuals market.
 * Protocol references: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 * and /info-endpoint/perpetuals. Amounts remain decimal strings; no signing uses analysis numbers.
 */
export type Environment = "mainnet" | "testnet";
export const API_URLS = {
  mainnet: { http: "https://api.hyperliquid.xyz", ws: "wss://api.hyperliquid.xyz/ws" },
  testnet: { http: "https://api.hyperliquid-testnet.xyz", ws: "wss://api.hyperliquid-testnet.xyz/ws" },
} as const;
export const CANDLE_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"] as const;
export type CandleInterval = typeof CANDLE_INTERVALS[number];
export type ReadError = { source: string; message: string; status?: number; retryAfterMs?: number };
export type Observation = { source: string; observedAt: number; serverTime: number | null };
export type Snapshot = { environment: Environment; observedAt: number; complete: boolean; errors: ReadError[] };
export type MarginTable = [number, { description?: string; marginTiers: { lowerBound: string; maxLeverage: number }[] }];
export type MarketContext = {
  markPx: string; midPx: string | null; oraclePx: string; funding: string; openInterest: string;
  dayNtlVlm: string; prevDayPx: string; dayBaseVlm?: string; premium?: string | null; impactPxs?: [string, string] | null;
};
export type PerpMarket = {
  name: string; asset: number; szDecimals: number; maxLeverage: number; marginTableId?: number;
  onlyIsolated?: boolean; isDelisted?: boolean; marginMode?: string; context: MarketContext;
};
export type MarketsSnapshot = Snapshot & { markets: PerpMarket[]; marginTables: MarginTable[]; collateralToken: number };
export type BookLevel = { px: string; sz: string; n: number };
export type OrderBook = { coin: string; time: number; levels: [BookLevel[], BookLevel[]] };
export type BookSnapshot = OrderBook & Snapshot;
export type Candle = { t: number; T: number; s: string; i: string; o: string; c: string; h: string; l: string; v: string; n: number };
export type CandlesSnapshot = Snapshot & {
  coin: string; interval: CandleInterval; startTime: number; endTime: number; candles: Candle[];
  historyLimit: 5000; possiblyTruncated: boolean;
};
export type MarginSummary = { accountValue: string; totalMarginUsed: string; totalNtlPos: string; totalRawUsd: string };
export type Position = {
  coin: string; szi: string; entryPx: string | null; leverage: { type: "cross" | "isolated"; value: number; rawUsd?: string };
  liquidationPx: string | null; marginUsed: string; maxLeverage: number; positionValue: string;
  returnOnEquity: string; unrealizedPnl: string; cumFunding: { allTime: string; sinceChange: string; sinceOpen: string };
};
export type ClearinghouseState = {
  assetPositions: { type: "oneWay"; position: Position }[]; marginSummary: MarginSummary; crossMarginSummary: MarginSummary;
  crossMaintenanceMarginUsed: string; withdrawable: string; time: number;
};
export type OpenOrder = {
  coin: string; oid: number; cloid?: string | null; side: "A" | "B"; limitPx: string; sz: string; origSz: string;
  timestamp: number; reduceOnly: boolean; isTrigger: boolean; isPositionTpsl: boolean; orderType: string;
  triggerCondition: string; triggerPx: string; children?: OpenOrder[];
};
export type UserFees = {
  userCrossRate: string; userAddRate: string; activeReferralDiscount?: string;
  feeSchedule?: Record<string, unknown>; dailyUserVlm?: { date: string; userCross: string; userAdd: string; exchange: string }[];
  [key: string]: unknown;
};
export type SpotState = {
  balances: { coin: string; token: number; total: string; hold: string; entryNtl: string }[];
  tokenToAvailableAfterMaintenance?: [number, string][];
};
export type AccountAbstraction = "unifiedAccount" | "portfolioMargin" | "disabled" | "default" | "dexAbstraction";
export type AccountSnapshot = Snapshot & {
  address: string; observations: Observation[]; abstraction: AccountAbstraction | null;
  clearinghouseState: ClearinghouseState | null; positions: Position[] | null; openOrders: OpenOrder[] | null;
  fees: UserFees | null; balances: SpotState | null; balanceSource: "perps" | "unified" | "unknown";
  /** Spot/HIP-3 orders are outside this app and are excluded, not canceled. */
  excludedOrderCount: number | null; warnings: string[];
};
export type Fill = {
  coin: string; px: string; sz: string; side: "A" | "B"; time: number; startPosition: string; dir: string;
  closedPnl: string; hash: string; oid: number; crossed: boolean; fee: string; tid: number; feeToken: string;
  builderFee?: string;
};
export type FundingRate = { coin: string; fundingRate: string; premium: string; time: number };
export type FillsSnapshot = Snapshot & { address: string; fills: Fill[]; excludedFillCount: number; historyLimit: 2000; availableHistoryLimit: 2000 | 10000; possiblyTruncated: boolean; nextStartTime: number | null };
export type FundingSnapshot = Snapshot & { coin: string; startTime: number; endTime: number; funding: FundingRate[]; nextStartTime: number | null; possiblyTruncated: boolean };
export type ActiveAsset = { user: string; coin: string; leverage: Position["leverage"]; maxTradeSzs: [string, string]; availableToTrade: [string, string]; markPx: string };
export type OrderStatus = { status: "unknownOid" } | { status: "order"; order: { order: OpenOrder; status: string; statusTimestamp: number } };

export class HyperliquidReadError extends Error {
  readonly source: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(source: string, message: string, status?: number, retryAfterMs?: number) {
    super(message); this.name = "HyperliquidReadError"; this.source = source; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}
const messageOf = (value: unknown) => value instanceof Error ? value.message : String(value);
const readError = (source: string, error: unknown): ReadError => ({
  source, message: messageOf(error),
  ...(error instanceof HyperliquidReadError && error.status !== undefined ? { status: error.status } : {}),
  ...(error instanceof HyperliquidReadError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
});
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const decimal = (value: unknown): value is string => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function invalid(source: string): never { throw new HyperliquidReadError(source, `Hyperliquid returned an invalid ${source} response.`); }
function record(value: unknown, source: string): Record<string, unknown> { if (!isRecord(value)) invalid(source); return value; }
function array(value: unknown, source: string): unknown[] { if (!Array.isArray(value)) invalid(source); return value; }
function decimalFields(value: Record<string, unknown>, fields: string[], source: string): void { for (const field of fields) if (!decimal(value[field])) invalid(source); }
/** API coin identities: spot uses @index or BASE/QUOTE; HIP-3 uses dex:coin. */
export function isDefaultPerpCoin(coin: unknown): coin is string {
  return typeof coin === "string" && coin.length > 0 && !/[\s@:/#]/.test(coin);
}
export function assertPerpCoin(coin: string): void { if (!isDefaultPerpCoin(coin)) throw new Error("Select a default Hyperliquid perpetual market."); }
function assertAddress(address: string): void { if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("A complete EVM account address is required."); }
function assertRange(startTime: number, endTime: number): void {
  if (!integer(startTime) || !integer(endTime) || endTime < startTime) throw new Error("Time range must be ordered nonnegative epoch milliseconds.");
}
function snapshot(environment: Environment): Snapshot { return { environment, observedAt: Date.now(), complete: true, errors: [] }; }

export function parseMarkets(raw: unknown, environment: Environment): MarketsSnapshot {
  if (!Array.isArray(raw) || raw.length !== 2) invalid("metaAndAssetCtxs");
  const meta = record(raw[0], "metaAndAssetCtxs"), universe = array(meta.universe, "metaAndAssetCtxs"), contexts = array(raw[1], "metaAndAssetCtxs");
  if (universe.length !== contexts.length) invalid("metaAndAssetCtxs metadata/context alignment");
  const names = new Set<string>();
  const markets = universe.map((entry, asset): PerpMarket => {
    const market = record(entry, "market metadata"), context = record(contexts[asset], "market context");
    if (!isDefaultPerpCoin(market.name) || names.has(market.name) || !integer(market.szDecimals) || market.szDecimals > 6 || !integer(market.maxLeverage) || market.maxLeverage < 1) invalid("market metadata");
    names.add(market.name);
    decimalFields(context, ["markPx", "oraclePx", "funding", "openInterest", "dayNtlVlm", "prevDayPx"], "market context");
    if (context.midPx !== null && !decimal(context.midPx)) invalid("market context");
    if (market.marginTableId !== undefined && !integer(market.marginTableId)) invalid("market metadata");
    if (market.onlyIsolated !== undefined && typeof market.onlyIsolated !== "boolean") invalid("market metadata");
    if (market.isDelisted !== undefined && typeof market.isDelisted !== "boolean") invalid("market metadata");
    if (market.marginMode !== undefined && typeof market.marginMode !== "string") invalid("market metadata");
    return { ...market, asset, context } as PerpMarket;
  });
  const marginTables = array(meta.marginTables ?? [], "margin tables").map((entry): MarginTable => {
    if (!Array.isArray(entry) || entry.length !== 2 || !integer(entry[0])) invalid("margin tables");
    const table = record(entry[1], "margin tables");
    for (const rawTier of array(table.marginTiers, "margin tables")) {
      const tier = record(rawTier, "margin tables");
      if (!decimal(tier.lowerBound) || !integer(tier.maxLeverage) || tier.maxLeverage < 1) invalid("margin tables");
    }
    return entry as MarginTable;
  });
  if (meta.collateralToken !== undefined && !integer(meta.collateralToken)) invalid("collateral token");
  return { ...snapshot(environment), markets, marginTables, collateralToken: (meta.collateralToken as number | undefined) ?? 0 };
}
export function parseBook(raw: unknown, coin?: string): OrderBook {
  const book = record(raw, "l2Book");
  if (!isDefaultPerpCoin(book.coin) || (coin !== undefined && book.coin !== coin) || !integer(book.time)) invalid("l2Book");
  const levels = array(book.levels, "l2Book");
  if (levels.length !== 2) invalid("l2Book");
  for (const side of levels) for (const rawLevel of array(side, "l2Book")) {
    const level = record(rawLevel, "l2Book");
    if (!decimal(level.px) || Number(level.px) <= 0 || !Number.isFinite(Number(level.px)) || !decimal(level.sz) || Number(level.sz) < 0 || !Number.isFinite(Number(level.sz)) || !integer(level.n)) invalid("l2Book level");
  }
  return book as unknown as OrderBook;
}
function parseCandles(raw: unknown, coin: string, interval: string): Candle[] {
  return array(raw, "candleSnapshot").map((entry): Candle => {
    const candle = record(entry, "candleSnapshot");
    if (candle.s !== coin || candle.i !== interval || !integer(candle.t) || !integer(candle.T) || candle.T < candle.t || !integer(candle.n)) invalid("candleSnapshot");
    decimalFields(candle, ["o", "c", "h", "l", "v"], "candleSnapshot");
    return candle as Candle;
  }).sort((a, b) => a.t - b.t);
}
function parseClearinghouse(raw: unknown): ClearinghouseState {
  const state = record(raw, "clearinghouseState");
  for (const rawPosition of array(state.assetPositions, "clearinghouseState")) {
    const row = record(rawPosition, "position"), position = record(row.position, "position");
    if (row.type !== "oneWay" || !isDefaultPerpCoin(position.coin)) invalid("position");
    decimalFields(position, ["szi", "marginUsed", "positionValue", "returnOnEquity", "unrealizedPnl"], "position");
    if ((position.entryPx !== null && !decimal(position.entryPx)) || (position.liquidationPx !== null && !decimal(position.liquidationPx))) invalid("position");
    const leverage = record(position.leverage, "position leverage");
    if (!["cross", "isolated"].includes(String(leverage.type)) || !integer(leverage.value) || leverage.value < 1 || !integer(position.maxLeverage)) invalid("position leverage");
    if (leverage.rawUsd !== undefined && !decimal(leverage.rawUsd)) invalid("position leverage");
    decimalFields(record(position.cumFunding, "position funding"), ["allTime", "sinceChange", "sinceOpen"], "position funding");
  }
  for (const name of ["marginSummary", "crossMarginSummary"]) decimalFields(record(state[name], name), ["accountValue", "totalMarginUsed", "totalNtlPos", "totalRawUsd"], name);
  decimalFields(state, ["crossMaintenanceMarginUsed", "withdrawable"], "clearinghouseState");
  if (!integer(state.time)) invalid("clearinghouseState time");
  return state as unknown as ClearinghouseState;
}
function parseOpenOrders(raw: unknown): OpenOrder[] {
  return array(raw, "frontendOpenOrders").map((entry): OpenOrder => {
    const order = record(entry, "frontendOpenOrders");
    if (typeof order.coin !== "string" || !integer(order.oid) || !integer(order.timestamp) || (order.side !== "A" && order.side !== "B")) invalid("frontendOpenOrders");
    decimalFields(order, ["limitPx", "sz", "origSz", "triggerPx"], "frontendOpenOrders");
    for (const field of ["reduceOnly", "isTrigger", "isPositionTpsl"]) if (typeof order[field] !== "boolean") invalid("frontendOpenOrders");
    for (const field of ["orderType", "triggerCondition"]) if (typeof order[field] !== "string") invalid("frontendOpenOrders");
    return order as OpenOrder;
  });
}
function parseSpotState(raw: unknown): SpotState {
  const state = record(raw, "spotClearinghouseState");
  for (const entry of array(state.balances, "spotClearinghouseState")) {
    const balance = record(entry, "spotClearinghouseState");
    if (typeof balance.coin !== "string" || !integer(balance.token)) invalid("spotClearinghouseState");
    decimalFields(balance, ["total", "hold", "entryNtl"], "spotClearinghouseState");
  }
  if (state.tokenToAvailableAfterMaintenance !== undefined) for (const entry of array(state.tokenToAvailableAfterMaintenance, "spot maintenance balances")) {
    if (!Array.isArray(entry) || entry.length !== 2 || !integer(entry[0]) || !decimal(entry[1])) invalid("spot maintenance balances");
  }
  return state as unknown as SpotState;
}
function parseFills(raw: unknown): Fill[] {
  return array(raw, "userFills").map((entry): Fill => {
    const fill = record(entry, "userFills");
    if (typeof fill.coin !== "string" || !integer(fill.time) || !integer(fill.oid) || !integer(fill.tid) || (fill.side !== "A" && fill.side !== "B")) invalid("userFills");
    decimalFields(fill, ["px", "sz", "startPosition", "closedPnl", "fee"], "userFills");
    for (const field of ["dir", "hash", "feeToken"]) if (typeof fill[field] !== "string") invalid("userFills");
    if (typeof fill.crossed !== "boolean") invalid("userFills");
    return fill as Fill;
  });
}

export class HyperliquidData {
  readonly environment: Environment;
  readonly urls: typeof API_URLS[Environment];
  private readonly fetcher: typeof fetch;
  constructor(environment: Environment, fetcher: typeof fetch = globalThis.fetch) {
    if (environment !== "mainnet" && environment !== "testnet") throw new Error("Unknown Hyperliquid environment.");
    this.environment = environment; this.urls = API_URLS[environment];
    // Browser fetch is a Window method; storing it unbound makes this.fetcher bind
    // the receiver to HyperliquidData and Chrome throws "Illegal invocation".
    this.fetcher = fetcher.bind(globalThis);
  }
  /** Internal transport; tool schemas expose individual typed operations, never arbitrary request bodies. */
  async info<T = unknown>(payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const source = String(payload.type ?? "info");
    const response = await this.fetcher(`${this.urls.http}/info`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      mode: "cors", credentials: "omit", cache: "no-store", ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const retry = response.headers.get("Retry-After");
      const retryAfterMs = retry === null ? undefined : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
      throw new HyperliquidReadError(source, `Hyperliquid ${source}: HTTP ${response.status}${response.status === 429 ? " (upstream rate limit)" : ""}.`, response.status,
        retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
    }
    const result: unknown = await response.json();
    signal?.throwIfAborted();
    if (isRecord(result) && (result.status === "err" || typeof result.error === "string")) throw new HyperliquidReadError(source, `Hyperliquid ${source}: ${String(result.error ?? result.response ?? "request rejected")}`);
    return result as T;
  }
  async markets(signal?: AbortSignal): Promise<MarketsSnapshot> {
    return parseMarkets(await this.info({ type: "metaAndAssetCtxs", dex: "" }, signal), this.environment);
  }
  async book(coin: string, signal?: AbortSignal): Promise<BookSnapshot> {
    assertPerpCoin(coin);
    return { ...parseBook(await this.info({ type: "l2Book", coin }, signal), coin), ...snapshot(this.environment) };
  }
  async candles(coin: string, interval: CandleInterval, startTime: number, endTime: number, signal?: AbortSignal): Promise<CandlesSnapshot> {
    assertPerpCoin(coin); assertRange(startTime, endTime);
    if (!(CANDLE_INTERVALS as readonly string[]).includes(interval)) throw new Error("Unsupported Hyperliquid candle interval.");
    const candles = parseCandles(await this.info({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }, signal), coin, interval);
    return { ...snapshot(this.environment), coin, interval, startTime, endTime, candles, historyLimit: 5000,
      // An empty/late start may be an unlisted market, a data gap, or the venue's
      // rolling history window. Do not claim the requested period is complete.
      possiblyTruncated: candles.length >= 5000 || (candles[0]?.t ?? endTime) > startTime };
  }
  async account(address: string, signal?: AbortSignal): Promise<AccountSnapshot> {
    assertAddress(address);
    const errors: ReadError[] = [], observations: Observation[] = [];
    const read = async <T>(source: string, parse: (raw: unknown) => T, extra: Record<string, unknown> = {}): Promise<T | null> => {
      try {
        const result = parse(await this.info({ type: source, user: address, ...extra }, signal));
        const time = isRecord(result) && integer(result.time) ? result.time : null;
        observations.push({ source, observedAt: Date.now(), serverTime: time }); return result;
      } catch (error) { signal?.throwIfAborted(); errors.push(readError(source, error)); return null; }
    };
    const [clearinghouseState, allOrders, fees, abstraction] = await Promise.all([
      read("clearinghouseState", parseClearinghouse, { dex: "" }), read("frontendOpenOrders", parseOpenOrders, { dex: "" }),
      read("userFees", (raw): UserFees => { const value = record(raw, "userFees"); decimalFields(value, ["userCrossRate", "userAddRate"], "userFees"); return value as UserFees; }),
      read("userAbstraction", (raw): AccountAbstraction => { if (!["unifiedAccount", "portfolioMargin", "disabled", "default", "dexAbstraction"].includes(String(raw))) invalid("userAbstraction"); return raw as AccountAbstraction; }),
    ]);
    const balanceSource = abstraction === "unifiedAccount" || abstraction === "portfolioMargin" ? "unified" : abstraction === "disabled" || abstraction === "dexAbstraction" ? "perps" : "unknown";
    // Reading shared collateral is necessary even though this app never offers spot trading.
    const balances = balanceSource !== "perps" ? await read("spotClearinghouseState", parseSpotState) : null;
    const warnings: string[] = [];
    if (balanceSource === "unknown") warnings.push("The account balance mode is not resolved. Perps and token balances must not be added together or treated as available collateral.");
    if (abstraction === "portfolioMargin") warnings.push("Portfolio margin may include collateral and liabilities outside these default perpetual markets. This view does not estimate full-portfolio liquidation health.");
    const openOrders = allOrders?.filter((order) => isDefaultPerpCoin(order.coin)) ?? null;
    return {
      ...snapshot(this.environment), complete: errors.length === 0, errors, address, observations, abstraction,
      clearinghouseState, positions: clearinghouseState?.assetPositions.map(({ position }) => position) ?? null,
      openOrders, fees, balances, balanceSource,
      excludedOrderCount: allOrders && openOrders ? allOrders.length - openOrders.length : null, warnings,
    };
  }
  async fills(address: string, startTime?: number, signal?: AbortSignal): Promise<FillsSnapshot> {
    assertAddress(address); if (startTime !== undefined && !integer(startTime)) throw new Error("Start time must be nonnegative epoch milliseconds.");
    const all = parseFills(await this.info({ type: startTime === undefined ? "userFills" : "userFillsByTime", user: address, aggregateByTime: false, ...(startTime === undefined ? {} : { startTime }) }, signal));
    const unique = [...new Map(all.map((fill) => [`${fill.coin}:${fill.oid}:${fill.tid}`, fill])).values()].sort((a, b) => a.time - b.time || a.tid - b.tid);
    const fills = unique.filter((fill) => isDefaultPerpCoin(fill.coin));
    // A timestamp cursor is inclusive. Consumers deduplicate by (coin, oid, tid); adding 1 would lose same-millisecond fills.
    return { ...snapshot(this.environment), address, fills, excludedFillCount: unique.length - fills.length, historyLimit: 2000,
      availableHistoryLimit: startTime === undefined ? 2000 : 10000, possiblyTruncated: all.length >= 2000, nextStartTime: unique.at(-1)?.time ?? null };
  }
  async funding(coin: string, startTime: number, endTime = Date.now(), signal?: AbortSignal): Promise<FundingSnapshot> {
    assertPerpCoin(coin); assertRange(startTime, endTime);
    const funding = array(await this.info({ type: "fundingHistory", coin, startTime, endTime }, signal), "fundingHistory").map((raw): FundingRate => {
      const entry = record(raw, "fundingHistory");
      if (entry.coin !== coin || !integer(entry.time)) invalid("fundingHistory");
      decimalFields(entry, ["fundingRate", "premium"], "fundingHistory"); return entry as FundingRate;
    }).sort((a, b) => a.time - b.time);
    // Time-range info responses are capped at 500 elements by the venue.
    return { ...snapshot(this.environment), coin, startTime, endTime, funding, nextStartTime: funding.at(-1)?.time ?? null, possiblyTruncated: funding.length >= 500 };
  }
  async activeAsset(address: string, coin: string, signal?: AbortSignal): Promise<ActiveAsset & Snapshot> {
    assertAddress(address); assertPerpCoin(coin);
    const raw = record(await this.info({ type: "activeAssetData", user: address, coin }, signal), "activeAssetData");
    if (raw.coin !== coin || typeof raw.user !== "string" || raw.user.toLowerCase() !== address.toLowerCase()) invalid("activeAssetData");
    decimalFields(raw, ["markPx"], "activeAssetData");
    const leverage = record(raw.leverage, "activeAssetData leverage");
    if (!["cross", "isolated"].includes(String(leverage.type)) || !integer(leverage.value) || leverage.value < 1) invalid("activeAssetData leverage");
    for (const field of ["maxTradeSzs", "availableToTrade"]) { const pair = array(raw[field], "activeAssetData"); if (pair.length !== 2 || !pair.every(decimal)) invalid("activeAssetData"); }
    return { ...(raw as ActiveAsset), ...snapshot(this.environment) };
  }
  async orderStatus(address: string, oid: number | string, signal?: AbortSignal): Promise<OrderStatus & { environment: Environment; observedAt: number }> {
    assertAddress(address);
    if (!(integer(oid) || typeof oid === "string" && /^0x[0-9a-fA-F]{32}$/.test(oid))) throw new Error("Order ID must be a safe integer or a 16-byte client order ID.");
    const raw = record(await this.info({ type: "orderStatus", user: address, oid }, signal), "orderStatus");
    if (raw.status !== "unknownOid" && (raw.status !== "order" || !isRecord(raw.order) || !isRecord(raw.order.order) || typeof raw.order.status !== "string" || !integer(raw.order.statusTimestamp))) invalid("orderStatus");
    return { ...(raw as OrderStatus), environment: this.environment, observedAt: Date.now() };
  }
}

export type MarketSubscription =
  | { type: "l2Book" | "trades" | "activeAssetCtx"; coin: string }
  | { type: "candle"; coin: string; interval: CandleInterval }
  | { type: "allMids"; dex?: "" }
  | { type: "clearinghouseState" | "openOrders"; user: string; dex?: "" }
  | { type: "userFills" | "userFundings" | "userNonFundingLedgerUpdates"; user: string };
export type MarketStreamEvent = { subscription: MarketSubscription; data: unknown; observedAt: number; isSnapshot: boolean; generation: number };
export type MarketStreamStatus = { state: "connecting" | "connected" | "disconnected" | "closed"; generation: number; observedAt: number; error: string | null };
type StreamListener = { event: (event: MarketStreamEvent) => void; reconnect?: () => void | Promise<void> };
type StreamEntry = { subscription: MarketSubscription; listeners: Set<StreamListener> };
const subscriptionKey = (sub: MarketSubscription) => JSON.stringify(Object.fromEntries(Object.entries(sub).sort(([a], [b]) => a.localeCompare(b))));

/** One resident owns this connection and shares subscriptions across UI/tool consumers.
 * Every connection opening asks consumers to reconcile from REST. Time series snapshots are
 * identified explicitly; consumers replace/deduplicate by the venue's fill IDs, never blindly append.
 */
export class HyperliquidMarketStream {
  private socket: WebSocket | null = null;
  private readonly entries = new Map<string, StreamEntry>();
  private readonly statusListeners = new Set<(status: MarketStreamStatus) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectAttempt = 0;
  private generation = 0;
  private disposed = false;
  private lastMessageAt = 0;
  private status: MarketStreamStatus = { state: "closed", generation: 0, observedAt: Date.now(), error: null };
  constructor(readonly environment: Environment, private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url)) {
    if (!(environment in API_URLS)) throw new Error("Unknown Hyperliquid environment.");
  }
  onStatus(listener: (status: MarketStreamStatus) => void): () => void {
    this.statusListeners.add(listener); listener(this.status); return () => this.statusListeners.delete(listener);
  }
  subscribe(subscription: MarketSubscription, event: StreamListener["event"], reconnect?: StreamListener["reconnect"]): () => void {
    if (this.disposed) throw new Error("The market stream has been closed.");
    if ("coin" in subscription) assertPerpCoin(subscription.coin);
    if ("user" in subscription) assertAddress(subscription.user);
    if ("dex" in subscription && subscription.dex !== undefined && subscription.dex !== "") throw new Error("Only default perpetual markets are supported.");
    if (subscription.type === "candle" && !(CANDLE_INTERVALS as readonly string[]).includes(subscription.interval)) throw new Error("Unsupported candle interval.");
    const sub = { ...subscription, ...("user" in subscription ? { user: subscription.user.toLowerCase() } : {}),
      ...(["allMids", "clearinghouseState", "openOrders"].includes(subscription.type) ? { dex: "" } : {}) } as MarketSubscription;
    const key = subscriptionKey(sub), existing = this.entries.get(key);
    const listener: StreamListener = { event, ...(reconnect ? { reconnect } : {}) };
    if (existing) { existing.listeners.add(listener); if (this.socket?.readyState === 1) this.reconcile(listener); }
    else {
      this.entries.set(key, { subscription: sub, listeners: new Set([listener]) });
      if (this.socket?.readyState === 1) { this.send("subscribe", sub); this.reconcile(listener); }
      else this.connect();
    }
    return () => {
      const entry = this.entries.get(key); if (!entry) return;
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) { this.entries.delete(key); if (this.socket?.readyState === 1) this.send("unsubscribe", entry.subscription); }
      if (this.entries.size === 0) this.stop(false);
    };
  }
  close(): void { this.disposed = true; this.entries.clear(); this.stop(true); this.statusListeners.clear(); }
  private update(state: MarketStreamStatus["state"], error: string | null = null): void {
    this.status = { state, generation: this.generation, observedAt: Date.now(), error };
    for (const listener of this.statusListeners) { try { listener(this.status); } catch { /* A view cannot interrupt the resident stream. */ } }
  }
  private reconcile(listener: StreamListener): void {
    if (!listener.reconnect) return;
    Promise.resolve().then(listener.reconnect).catch((error: unknown) => this.update(this.status.state, `Reconciliation failed: ${messageOf(error)}`));
  }
  private send(method: "subscribe" | "unsubscribe", subscription: MarketSubscription): void { this.socket?.send(JSON.stringify({ method, subscription })); }
  private connect(): void {
    if (this.disposed || this.entries.size === 0 || this.socket || this.reconnectTimer !== undefined) return;
    this.update("connecting");
    let socket: WebSocket;
    try { socket = this.createSocket(API_URLS[this.environment].ws); } catch (error) { this.scheduleReconnect(messageOf(error)); return; }
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.generation += 1; this.reconnectAttempt = 0; this.lastMessageAt = Date.now(); this.update("connected");
      for (const entry of this.entries.values()) { this.send("subscribe", entry.subscription); for (const listener of entry.listeners) this.reconcile(listener); }
      this.heartbeat = setInterval(() => {
        if (socket !== this.socket || socket.readyState !== 1) return;
        if (Date.now() - this.lastMessageAt > 60000) socket.close();
        else socket.send(JSON.stringify({ method: "ping" }));
      }, 20000);
    };
    socket.onmessage = (message) => {
      if (socket !== this.socket) return;
      this.lastMessageAt = Date.now();
      let envelope: Record<string, unknown>;
      try { envelope = record(JSON.parse(String(message.data)), "WebSocket"); } catch { this.update("connected", "Invalid Hyperliquid WebSocket message."); return; }
      if (envelope.channel === "pong" || envelope.channel === "subscriptionResponse") return;
      if (envelope.channel === "error") { this.update("connected", `Hyperliquid stream: ${typeof envelope.data === "string" ? envelope.data : "subscription rejected"}`); return; }
      for (const entry of this.entries.values()) {
        const sub = entry.subscription; if (envelope.channel !== sub.type) continue;
        const data = envelope.data;
        const representative = Array.isArray(data) ? data[0] : data;
        if ("coin" in sub && (!isRecord(representative) || (representative.coin ?? representative.s) !== sub.coin)) continue;
        if (sub.type === "candle" && (!isRecord(representative) || representative.i !== sub.interval)) continue;
        if ("user" in sub && (!isRecord(data) || typeof data.user !== "string" || data.user.toLowerCase() !== sub.user)) continue;
        if ((sub.type === "clearinghouseState" || sub.type === "openOrders") && isRecord(data) && data.dex !== "") continue;
        let filtered = data;
        if (sub.type === "allMids" && isRecord(data) && isRecord(data.mids)) filtered = { ...data, mids: Object.fromEntries(Object.entries(data.mids).filter(([coin]) => isDefaultPerpCoin(coin))) };
        if (sub.type === "openOrders" && isRecord(data) && Array.isArray(data.orders)) filtered = { ...data, orders: data.orders.filter((row) => isRecord(row) && isDefaultPerpCoin(row.coin)) };
        if (sub.type === "userFills" && isRecord(data) && Array.isArray(data.fills)) filtered = { ...data, fills: data.fills.filter((row) => isRecord(row) && isDefaultPerpCoin(row.coin)) };
        const event: MarketStreamEvent = { subscription: sub, data: filtered, observedAt: Date.now(), isSnapshot: isRecord(data) && data.isSnapshot === true, generation: this.generation };
        for (const listener of entry.listeners) { try { listener.event(event); } catch { /* Isolate views; the stream and other consumers remain live. */ } }
      }
    };
    socket.onerror = () => { if (socket === this.socket) this.update(this.status.state, "Hyperliquid WebSocket connection failed."); };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.socket = null; if (this.heartbeat !== undefined) clearInterval(this.heartbeat); this.heartbeat = undefined;
      this.scheduleReconnect("Hyperliquid stream disconnected; REST reconciliation will run on reconnect.");
    };
  }
  private scheduleReconnect(error: string): void {
    if (this.disposed || this.entries.size === 0) { this.update("closed"); return; }
    this.update("disconnected", error);
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.connect(); }, delay);
  }
  private stop(permanent: boolean): void {
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat); this.heartbeat = undefined;
    const socket = this.socket; this.socket = null; socket?.close(); this.update("closed", permanent ? null : this.status.error);
  }
}
