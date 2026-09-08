import { describe, expect, test } from "bun:test";
import {
  bounds,
  candleBounds,
  isPlausibleExtreme,
  type ChartCandle,
} from "../src/scale.ts";

function candle(
  t: number,
  open: number,
  high: number,
  low: number,
  close: number,
): ChartCandle {
  return { t, open, high, low, close };
}

describe("bounds", () => {
  test("spans the finite values", () => {
    expect(bounds([3, 1, 2])).toEqual({ min: 1, max: 3 });
  });

  test("ignores values that are not finite", () => {
    expect(bounds([1, Number.NaN, 5, Number.POSITIVE_INFINITY])).toEqual({
      min: 1,
      max: 5,
    });
  });

  test("pads a flat series so it still has a span", () => {
    const { min, max } = bounds([4, 4, 4]);
    expect(min).toBeLessThan(4);
    expect(max).toBeGreaterThan(4);
  });

  test("falls back to a unit range with nothing usable", () => {
    expect(bounds([])).toEqual({ min: 0, max: 1 });
  });
});

describe("candleBounds", () => {
  test("ignores the bad tick that ICPSwap records for ckBTC", () => {
    // Real daily candles: 2026-08-19 reports a high of $199,924,397 against a
    // $78,261 close. Scaling to it flattened the whole month onto one line.
    const series = [
      candle(1, 69508.53, 73380.02, 68714.64, 73380.02),
      candle(2, 73447.5, 199924397.65, 72558.06, 78261.93),
      candle(3, 78177.26, 79359.76, 75680.53, 76651.47),
      candle(4, 76997.12, 78139.55, 75295.64, 77643.83),
    ];
    const scale = candleBounds(series);
    expect(scale.max).toBe(79359.76);
    expect(scale.min).toBe(68714.64);
    expect(scale.clipped).toBe(1);
  });

  test("always contains every body", () => {
    const series = [
      candle(1, 10, 1e9, 9, 11),
      candle(2, 11, 12, 1e-9, 20),
    ];
    const scale = candleBounds(series);
    expect(scale.min).toBeLessThanOrEqual(10);
    expect(scale.max).toBeGreaterThanOrEqual(20);
  });

  test("keeps an ordinary wick", () => {
    const series = [candle(1, 100, 130, 80, 120), candle(2, 120, 140, 110, 115)];
    const scale = candleBounds(series);
    expect(scale.max).toBe(140);
    expect(scale.min).toBe(80);
    expect(scale.clipped).toBe(0);
  });

  test("allows a real wick on a stablecoin whose bodies barely move", () => {
    // Bodies span a thousandth of a cent; a 2% wick must not read as an error.
    const series = [
      candle(1, 1.0, 1.02, 0.98, 1.0005),
      candle(2, 1.0005, 1.015, 0.985, 1.0),
    ];
    expect(candleBounds(series).clipped).toBe(0);
  });

  test("counts each candle with an off-scale wick once", () => {
    const series = Array.from({ length: 20 }, (_, index) =>
      candle(index, 10, 11, 9, 10.5),
    );
    series[4] = candle(4, 10, 5000, 9, 11);
    series[9] = candle(9, 10, 11, 0.001, 10.5);
    expect(candleBounds(series).clipped).toBe(2);
  });

  test("does not call the majority of a series outliers", () => {
    // Two thirds of these candles reach 5,000; that is the data, not an error.
    const series = [
      candle(1, 10, 5000, 9, 11),
      candle(2, 11, 6000, 10, 12),
      candle(3, 12, 13, 11, 12.5),
    ];
    expect(candleBounds(series).clipped).toBe(0);
  });

  test("still reports a usable span for a single flat candle", () => {
    const scale = candleBounds([candle(1, 5, 5, 5, 5)]);
    expect(scale.max).toBeGreaterThan(scale.min);
  });

  test("handles an empty series", () => {
    const scale = candleBounds([]);
    expect(scale.max).toBeGreaterThan(scale.min);
    expect(scale.clipped).toBe(0);
  });
});

describe("isPlausibleExtreme", () => {
  test("rejects the 24h high ICPSwap reports for ckBTC", () => {
    expect(isPlausibleExtreme(199_924_397.65, 78_760.98)).toBe(false);
  });

  test("keeps an extreme within reach of the traded price", () => {
    expect(isPlausibleExtreme(82_830.81, 78_760.98)).toBe(true);
    expect(isPlausibleExtreme(47_115.52, 78_760.98)).toBe(true);
  });

  test("rejects a value more than twentyfold below the price", () => {
    expect(isPlausibleExtreme(100, 78_760.98)).toBe(false);
  });

  test("rejects a value that is not a usable price", () => {
    expect(isPlausibleExtreme(0, 10)).toBe(false);
    expect(isPlausibleExtreme(Number.NaN, 10)).toBe(false);
    expect(isPlausibleExtreme(-1, 10)).toBe(false);
  });

  test("accepts anything when there is no price to compare against", () => {
    // A token with no traded price gives nothing to judge the extreme by.
    expect(isPlausibleExtreme(5, 0)).toBe(true);
  });
});
