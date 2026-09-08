import type { Candle, OrderBook } from "./market.ts";

/** Descriptive, approximate analytics. Never use these numbers to sign orders. */
type Status = "ok" | "insufficient_data" | "invalid_data";
type Bar = { t: number; T: number; s: string; i: string; o: number; c: number; h: number; l: number; v: number; n: number };
const decimal = (value: unknown): number | null => {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const mean = (values: number[]) => values.reduce((average, value, index) => average + (value - average) / (index + 1), 0);
const change = (before: number, after: number) => (after / before - 1) * 100;
function sampleDeviation(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2 / (values.length - 1), 0));
}
function wilder(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let average = mean(values.slice(0, period));
  for (const value of values.slice(period)) average = (average * (period - 1) + value) / period;
  return average;
}
function validBar(candle: Candle): Bar | null {
  const o = decimal(candle.o), c = decimal(candle.c), h = decimal(candle.h), l = decimal(candle.l), v = decimal(candle.v);
  if (o === null || c === null || h === null || l === null || v === null || Math.min(o, c, h, l) <= 0 ||
      l > Math.min(o, c) || h < Math.max(o, c) || l > h || !Number.isSafeInteger(candle.n) || candle.n < 0 ||
      typeof candle.s !== "string" || !candle.s || typeof candle.i !== "string" || !candle.i) return null;
  return { t: candle.t, T: candle.T, s: candle.s, i: candle.i, o, c, h, l, v, n: candle.n };
}

/** Uses completed candles only; a gap starts a new indicator history. */
export function analyzeCandles(candles: Candle[], options: { now?: number } = {}) {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now < 0) throw new Error("now must be a nonnegative millisecond timestamp");
  const warnings: string[] = [];
  const quality = { inputCandles: candles.length, closedCandles: 0, excludedIncompleteCandles: 0, corruptCandles: 0,
    duplicateCandles: 0, overlappingCandles: 0, gaps: 0, analyzedCandles: 0 };
  const bars: Bar[] = [];
  for (const candle of candles) {
    if (!candle || !Number.isSafeInteger(candle.t) || !Number.isSafeInteger(candle.T) || candle.t < 0 || candle.T < candle.t) {
      quality.corruptCandles++; continue;
    }
    if (candle.T >= now) { quality.excludedIncompleteCandles++; continue; }
    quality.closedCandles++;
    const bar = validBar(candle);
    if (bar) bars.push(bar); else quality.corruptCandles++;
  }
  bars.sort((a, b) => a.t - b.t);
  let tailStart = 0;
  for (let index = 1; index < bars.length; index++) {
    const previous = bars[index - 1]!, current = bars[index]!;
    if (previous.t === current.t) quality.duplicateCandles++;
    else if (current.t <= previous.T) quality.overlappingCandles++;
    else if (current.t > previous.T + 1) { quality.gaps++; tailStart = index; }
  }
  const mixedSeries = bars.some(bar => bar.s !== bars[0]!.s || bar.i !== bars[0]!.i);
  if (quality.excludedIncompleteCandles) warnings.push(`${quality.excludedIncompleteCandles} incomplete or future candle(s) excluded.`);
  if (quality.gaps) warnings.push(`${quality.gaps} gap(s) found; indicators use only the final contiguous segment.`);
  if (quality.corruptCandles) warnings.push(`${quality.corruptCandles} corrupt candle(s); indicators suppressed.`);
  if (quality.duplicateCandles) warnings.push("Duplicate candle timestamps; indicators suppressed.");
  if (quality.overlappingCandles) warnings.push("Overlapping candle intervals; indicators suppressed.");
  if (mixedSeries) warnings.push("Mixed coins or intervals; indicators suppressed.");
  const invalid = quality.corruptCandles > 0 || quality.duplicateCandles > 0 || quality.overlappingCandles > 0 || mixedSeries;
  const closed = invalid ? [] : bars.slice(tailStart);
  quality.analyzedCandles = closed.length;
  const requirements = { rsi14: 15, atr14: 15, sma20: 20, sma50: 50, volatility: 3 };
  if (!closed.length) return {
    status: (invalid ? "invalid_data" : "insufficient_data") as Status, approximate: true, computedAt: now, quality, requirements, warnings,
    range: null, overview: null, returns: null, indicators: null,
  };
  const first = closed[0]!, last = closed.at(-1)!;
  const closes = closed.map(bar => bar.c), deltas = closes.slice(1).map((close, index) => close - closes[index]!);
  const gain = wilder(deltas.map(delta => Math.max(0, delta)), 14), loss = wilder(deltas.map(delta => Math.max(0, -delta)), 14);
  const rsi14 = gain === null || loss === null ? null : loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  const trueRanges = closed.slice(1).map((bar, index) => Math.max(bar.h - bar.l, Math.abs(bar.h - closed[index]!.c), Math.abs(bar.l - closed[index]!.c)));
  const atr14 = wilder(trueRanges, 14);
  const sma20 = closes.length >= 20 ? mean(closes.slice(-20)) : null, sma50 = closes.length >= 50 ? mean(closes.slice(-50)) : null;
  const trend: "insufficient_data" | "up" | "down" | "flat" | "mixed" = sma20 === null || sma50 === null ? "insufficient_data" : last.c > sma20 && sma20 > sma50 ? "up" :
    last.c < sma20 && sma20 < sma50 ? "down" : last.c === sma20 && sma20 === sma50 ? "flat" : "mixed";
  const logReturns = closes.slice(1).map((close, index) => Math.log(close) - Math.log(closes[index]!));
  const deviation = sampleDeviation(logReturns);
  const historicalReturn = (period: number) => closes.length > period ? change(closes.at(-1 - period)!, last.c) : null;
  const result = {
    status: (closed.length >= 50 ? "ok" : "insufficient_data") as Status, approximate: true, computedAt: now, quality, requirements, warnings,
    range: { coin: first.s, interval: first.i, firstOpenTime: first.t, lastCloseTime: last.T },
    overview: { open: first.o, high: Math.max(...closed.map(bar => bar.h)), low: Math.min(...closed.map(bar => bar.l)), close: last.c,
      volume: closed.reduce((sum, bar) => sum + bar.v, 0), trades: closed.reduce((sum, bar) => sum + bar.n, 0), changePercent: change(first.o, last.c) },
    returns: { oneBarPercent: historicalReturn(1), fiveBarPercent: historicalReturn(5), twentyBarPercent: historicalReturn(20),
      firstToLastClosePercent: change(first.c, last.c) },
    indicators: { sma20, sma50, rsi14, atr14, atrPercent: atr14 === null ? null : atr14 / last.c * 100, trend,
      volatility: { logReturnStdDevPerBar: deviation, percentPerBar: deviation === null ? null : deviation * 100,
        observations: logReturns.length, method: "sample_standard_deviation_of_log_returns_unannualized" } },
  };
  if (closed.length < 50) warnings.push(`Only ${closed.length} completed contiguous candle(s); unavailable indicators are null.`);
  if (!finiteTree(result)) return { ...result, status: "invalid_data" as Status, overview: null, returns: null, indicators: null,
    warnings: [...warnings, "Numeric overflow in candle analytics; indicators suppressed."] };
  return result;
}

type Level = { price: number; size: number; orders: number };
type BookOptions = { side?: "buy" | "sell"; size?: string | number; limitPrice?: string | number };
const positive = (value: unknown) => {
  const number = typeof value === "number" ? value : decimal(value);
  return number !== null && Number.isFinite(number) && number > 0 ? number : null;
};
function finiteTree(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.values(value).every(finiteTree);
  return true;
}
function executionEstimate(levels: Level[], mid: number | null, options: BookOptions) {
  const side = options.side, requestedSize = positive(options.size), limitPrice = options.limitPrice === undefined ? null : positive(options.limitPrice);
  if ((side !== "buy" && side !== "sell") || requestedSize === null || (options.limitPrice !== undefined && limitPrice === null)) {
    return { status: "invalid_request" as const, error: "An execution estimate needs buy/sell side, positive size, and an optional positive limitPrice." };
  }
  let remaining = requestedSize, filledSize = 0, totalNotional = 0, consumedLevels = 0, worstPrice: number | null = null, limitedByPrice = false;
  for (const level of levels) {
    if (limitPrice !== null && (side === "buy" ? level.price > limitPrice : level.price < limitPrice)) { limitedByPrice = true; break; }
    const fill = Math.min(remaining, level.size);
    totalNotional += fill * level.price; remaining -= fill; filledSize += fill;
    consumedLevels++; worstPrice = level.price;
    if (remaining <= requestedSize * Number.EPSILON * 8) { remaining = 0; filledSize = requestedSize; break; }
  }
  const averagePrice = filledSize > 0 ? totalNotional / filledSize : null;
  const best = levels[0]?.price ?? null;
  const adverseSlippage = (reference: number | null) => averagePrice === null || reference === null ? null :
    (side === "buy" ? averagePrice / reference - 1 : 1 - averagePrice / reference) * 10_000;
  return { status: (remaining === 0 ? "filled" : filledSize > 0 ? "partial" : "unfilled") as "filled" | "partial" | "unfilled", kind: "displayed_book_ioc_estimate" as const, side,
    requestedSize, limitPrice, filledSize, unfilledSize: remaining, totalNotional, averagePrice, worstPrice, consumedLevels,
    slippageFromBestBps: adverseSlippage(best), slippageFromMidBps: adverseSlippage(mid),
    limitingFactor: remaining === 0 ? "requested_size" : limitedByPrice ? "limit_price" : levels.length ? "visible_depth" : "empty_book",
    warning: "Estimate from displayed liquidity only; excludes fees and changes before execution and is not a fill guarantee." };
}

/** Walks all provided levels, preserving the requested side and limit boundary. */
export function analyzeBook(book: OrderBook, options: BookOptions = {}) {
  const warnings: string[] = [];
  let invalid = !book || typeof book.coin !== "string" || !book.coin || !Number.isSafeInteger(book.time) || book.time < 0 ||
    !Array.isArray(book.levels) || book.levels.length !== 2 || !book.levels.every(Array.isArray);
  const parseLevels = (rows: OrderBook["levels"][number] | undefined, descending: boolean): Level[] => {
    const levels: Level[] = [];
    for (const row of rows ?? []) {
      if (!row) { invalid = true; continue; }
      const price = positive(row.px), size = decimal(row.sz);
      if (price === null || size === null || !Number.isSafeInteger(row.n) || row.n < 0) { invalid = true; continue; }
      if (size === 0) continue;
      levels.push({ price, size, orders: row.n });
    }
    return levels.sort((a, b) => descending ? b.price - a.price : a.price - b.price);
  };
  const bids = parseLevels(Array.isArray(book?.levels?.[0]) ? book.levels[0] : undefined, true);
  const asks = parseLevels(Array.isArray(book?.levels?.[1]) ? book.levels[1] : undefined, false);
  const bestBid = bids[0]?.price ?? null, bestAsk = asks[0]?.price ?? null;
  if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) { invalid = true; warnings.push("Crossed or locked order book."); }
  const emptyResult = { status: "invalid_data" as Status, approximate: true,
    coin: typeof book?.coin === "string" ? book.coin : null, time: Number.isSafeInteger(book?.time) && book.time >= 0 ? book.time : null, warnings,
    bestBid: null, bestAsk: null, mid: null, spread: null, spreadBps: null, depth: null, imbalance: null, depthBands: null, execution: null };
  if (invalid) { warnings.push("Corrupt order book; analytics and execution estimate suppressed."); return emptyResult; }
  const mid = bestBid === null || bestAsk === null ? null : bestBid / 2 + bestAsk / 2;
  const spread = bestBid === null || bestAsk === null ? null : bestAsk - bestBid;
  const depth = (levels: Level[]) => ({ levels: levels.length, size: levels.reduce((sum, level) => sum + level.size, 0),
    notional: levels.reduce((sum, level) => sum + level.price * level.size, 0), orders: levels.reduce((sum, level) => sum + level.orders, 0) });
  const bidDepth = depth(bids), askDepth = depth(asks);
  const imbalance = (bid: number, ask: number) => {
    const scale = Math.max(bid, ask);
    return scale > 0 ? (bid / scale - ask / scale) / (bid / scale + ask / scale) : null;
  };
  if (mid === null) warnings.push("One or both sides are empty; mid, spread, and midpoint depth bands are unavailable.");
  const result = { status: (mid === null ? "insufficient_data" : "ok") as Status, approximate: true, coin: book.coin, time: book.time, warnings,
    bestBid, bestAsk, mid, spread, spreadBps: mid === null || spread === null ? null : spread / mid * 10_000,
    depth: { bids: bidDepth, asks: askDepth }, imbalance: { size: imbalance(bidDepth.size, askDepth.size), notional: imbalance(bidDepth.notional, askDepth.notional) },
    depthBands: mid === null ? null : [10, 25, 50, 100].map(bps => ({ distanceFromMidBps: bps,
      bids: depth(bids.filter(level => (mid - level.price) / mid * 10_000 <= bps)),
      asks: depth(asks.filter(level => (level.price - mid) / mid * 10_000 <= bps)) })),
    execution: options.side !== undefined || options.size !== undefined || options.limitPrice !== undefined ?
      executionEstimate(options.side === "sell" ? bids : asks, mid, options) : null,
  };
  if (!finiteTree(result)) return { ...emptyResult, warnings: [...warnings, "Numeric overflow in book analytics; analytics suppressed."] };
  return result;
}

export type CandleAnalysis = ReturnType<typeof analyzeCandles>;
export type BookAnalysis = ReturnType<typeof analyzeBook>;
