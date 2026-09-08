import { expect, test } from "bun:test";
import { mergeCandleHistory } from "../src/candle_history.ts";
import type { Candle } from "../src/market.ts";

function candle(index: number, trades = 1, close = "100"): Candle {
  const t = 1_700_000_000_000 + index * 60_000;
  return { t, T: t + 59_999, s: "ETH", i: "1m", o: "100", h: "110", l: "90", c: close, v: String(trades), n: trades };
}

test("stream rollover retains the completed candle and deduplicates its revisions", () => {
  let history = mergeCandleHistory([], [candle(0)], true);
  history = mergeCandleHistory(history, [candle(1)]);
  history = mergeCandleHistory(history, [candle(1, 3, "103")]);
  history = mergeCandleHistory(history, [candle(2)]);
  expect(history.map((row) => row.t)).toEqual([candle(0).t, candle(1).t, candle(2).t]);
  expect(history[1]?.c).toBe("103");
});

test("late REST snapshots cannot replace a more complete streamed candle or remove the tail", () => {
  const streamed = [candle(0), candle(1, 4, "104"), candle(2)];
  const history = mergeCandleHistory(streamed, [candle(0), candle(1, 2, "102")], true);
  expect(history).toEqual(streamed);
  expect(mergeCandleHistory(history, [], true)).toEqual(streamed);
});

test("REST catches up, supersedes older observations and advances its existing history window", () => {
  const history = mergeCandleHistory([candle(0), candle(1, 2), candle(2)], [candle(1, 3, "103"), candle(2, 2, "102")], true);
  expect(history).toEqual([candle(1, 3, "103"), candle(2, 2, "102")]);
});

test("out-of-order stream observations preserve newer rows and merge every timestamp", () => {
  const history = mergeCandleHistory([candle(1, 3, "103")], [candle(2), candle(1, 2, "102"), candle(0)]);
  expect(history).toEqual([candle(0), candle(1, 3, "103"), candle(2)]);
});

test("cumulative volume distinguishes observations when the reported trade count is equal", () => {
  const observed = { ...candle(1, 2, "102"), v: "2.5" };
  expect(mergeCandleHistory([observed], [candle(1, 2)])).toEqual([observed]);
  const newer = { ...observed, v: "2.75", c: "103" };
  expect(mergeCandleHistory([observed], [newer], true)).toEqual([newer]);
});
