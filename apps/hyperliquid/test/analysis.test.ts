import { expect, test } from "bun:test";
import { analyzeBook, analyzeCandles } from "../src/analysis.ts";
import type { Candle, OrderBook } from "../src/market.ts";

const start = 1_700_000_000_000;
function candles(closes: number[]): Candle[] {
  return closes.map((close, index) => ({ t: start + index * 60_000, T: start + (index + 1) * 60_000 - 1,
    s: "ETH", i: "1m", o: String(close), c: String(close), h: String(close + 1), l: String(close - 1), v: "10", n: 2 }));
}
const options = { now: start + 1_000 * 60_000 };
const book: OrderBook = { coin: "ETH", time: start, levels: [
  [{ px: "99", sz: "2", n: 2 }, { px: "98", sz: "3", n: 1 }],
  [{ px: "101", sz: "1", n: 1 }, { px: "102", sz: "2", n: 3 }, { px: "104", sz: "4", n: 1 }],
] };

test("Wilder RSI matches a published-style independent arithmetic fixture", () => {
  const values = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  expect(analyzeCandles(candles(values), options).indicators?.rsi14).toBeCloseTo(70.464135, 5);
  expect(analyzeCandles(candles([...values, 46]), options).indicators?.rsi14).toBeCloseTo(66.249619, 5);
});

test("SMA, trend, ATR, returns, and volume describe completed ascending candles", () => {
  const result = analyzeCandles(candles(Array.from({ length: 60 }, (_, index) => 100 + index)), options);
  expect(result.status).toBe("ok");
  expect(result.indicators?.sma20).toBeCloseTo(149.5);
  expect(result.indicators?.sma50).toBeCloseTo(134.5);
  expect(result.indicators?.rsi14).toBe(100);
  expect(result.indicators?.atr14).toBeCloseTo(2);
  expect(result.indicators?.trend).toBe("up");
  expect(result.returns?.twentyBarPercent).toBeCloseTo((159 / 139 - 1) * 100);
  expect(result.overview?.volume).toBe(600);
  expect(result.indicators?.volatility.observations).toBe(59);
  expect(result.indicators?.volatility.method).toContain("unannualized");
});

test("constant candles have neutral RSI and zero return volatility", () => {
  const result = analyzeCandles(candles(Array(50).fill(100)), options);
  expect(result.indicators?.rsi14).toBe(50);
  expect(result.indicators?.trend).toBe("flat");
  expect(result.indicators?.volatility.percentPerBar).toBe(0);
  const fractional = candles(Array(50).fill(1.1));
  expect(analyzeCandles(fractional, options).indicators?.trend).toBe("flat");
});

test("open candle excluded, input order normalized, and short history reported explicitly", () => {
  const rows = candles([100, 101, 200]);
  const result = analyzeCandles([...rows].reverse(), { now: rows[2]!.T });
  expect(result.status).toBe("insufficient_data");
  expect(result.quality.excludedIncompleteCandles).toBe(1);
  expect(result.quality.analyzedCandles).toBe(2);
  expect(result.overview?.close).toBe(101);
  expect(result.indicators?.rsi14).toBeNull();
  expect(result.indicators?.volatility.percentPerBar).toBeNull();
  expect(result.warnings.join(" ")).toContain("incomplete");
});

test("gaps restart indicator history and corrupt/duplicate data cannot create confident signals", () => {
  const rows = candles(Array.from({ length: 60 }, (_, index) => 100 + index));
  const gap = analyzeCandles([...rows.slice(0, 30), ...rows.slice(31)], options);
  expect(gap.quality.gaps).toBe(1);
  expect(gap.quality.analyzedCandles).toBe(29);
  expect(gap.indicators?.sma50).toBeNull();
  for (const invalid of [[...rows, rows[0]!], [{ ...rows[0]!, c: "NaN" }], [{ ...rows[0]!, l: "999" }],
    [rows[0]!, { ...rows[1]!, s: "BTC" }], [rows[0]!, { ...rows[1]!, t: rows[0]!.T - 1 }]]) {
    const result = analyzeCandles(invalid, options);
    expect(result.status).toBe("invalid_data");
    expect(result.indicators).toBeNull();
  }
});

test("book reports side depth, spread, and dimensionless imbalance", () => {
  const result = analyzeBook(book);
  expect(result.status).toBe("ok"); expect(result.mid).toBe(100); expect(result.spreadBps).toBe(200);
  expect(result.depth?.bids.size).toBe(5); expect(result.depth?.asks.size).toBe(7);
  expect(result.imbalance?.size).toBeCloseTo(-1 / 6);
  expect(result.depthBands?.at(-1)?.bids.size).toBe(2);
  expect(result.depthBands?.at(-1)?.asks.size).toBe(1);
  expect(result.execution).toBeNull();
});

test("buy estimate walks asks and accounts for partial fills at an inclusive limit", () => {
  const execution = analyzeBook(book, { side: "buy", size: "4", limitPrice: "102" }).execution;
  expect(execution?.status).toBe("partial");
  if (!execution || !("filledSize" in execution)) throw new Error("Missing execution estimate");
  expect(execution.filledSize).toBe(3); expect(execution.unfilledSize).toBe(1);
  expect(execution.totalNotional).toBe(305); expect(execution.averagePrice).toBeCloseTo(305 / 3);
  expect(execution.slippageFromBestBps).toBeCloseTo(((305 / 3) / 101 - 1) * 10_000);
  expect(execution.limitingFactor).toBe("limit_price");
});

test("sell estimate uses bids and reports adverse slippage as positive", () => {
  const execution = analyzeBook(book, { side: "sell", size: 3 }).execution;
  if (!execution || !("filledSize" in execution)) throw new Error("Missing execution estimate");
  expect(execution.status).toBe("filled"); expect(execution.totalNotional).toBe(296);
  expect(execution.slippageFromBestBps).toBeGreaterThan(0);
  expect(execution.slippageFromMidBps).toBeGreaterThan(execution.slippageFromBestBps!);
});

test("visible depth is not treated as unlimited liquidity and empty sides are explicit", () => {
  const shallow = analyzeBook(book, { side: "buy", size: 20 }).execution;
  if (!shallow || !("filledSize" in shallow)) throw new Error("Missing execution estimate");
  expect(shallow.status).toBe("partial"); expect(shallow.filledSize).toBe(7); expect(shallow.limitingFactor).toBe("visible_depth");
  const empty = analyzeBook({ ...book, levels: [book.levels[0], []] }, { side: "buy", size: 1 });
  expect(empty.status).toBe("insufficient_data"); expect(empty.mid).toBeNull(); expect(empty.execution?.status).toBe("unfilled");
  expect(analyzeBook(book, { side: "buy", size: 0 }).execution?.status).toBe("invalid_request");
  expect(analyzeBook(book, { size: 1 }).execution?.status).toBe("invalid_request");
  const zero = analyzeBook({ ...book, levels: [book.levels[0], [{ px: "100", sz: "0", n: 0 }, ...book.levels[1]]] });
  expect(zero.status).toBe("ok"); expect(zero.bestAsk).toBe(101);
});

test("crossed books, corrupt rows, and non-finite aggregate estimates are suppressed", () => {
  for (const invalid of [
    { ...book, levels: [[{ px: "105", sz: "1", n: 1 }], book.levels[1]] },
    { ...book, levels: [[{ px: "99", sz: "NaN", n: 1 }], book.levels[1]] },
    { ...book, levels: [[{ px: "99", sz: `1${"0".repeat(307)}`, n: 1 }], book.levels[1]] },
  ] as OrderBook[]) {
    const result = analyzeBook(invalid, { side: "sell", size: 2 });
    expect(result.status).toBe("invalid_data"); expect(result.execution).toBeNull();
    expect(JSON.stringify(result)).not.toContain("NaN");
  }
});
