import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Chart, type ChartCandle, type ChartProps } from "../src/chart.tsx";

const candle = (t: number, close: number): ChartCandle => ({
  t, open: close - 1, high: close + 2, low: close - 2, close,
});
const props: ChartProps = {
  points: [{ t: 10, v: 10 }, { t: 20, v: 20 }, { t: 40, v: 40 }],
  formatValue: (value) => `$${value.toFixed(2)}`,
  formatTime: (t) => `T${t}`,
  formatBar: (value) => `${value} USD`,
  valueLabel: "Price",
};
const render = (override: Partial<ChartProps> = {}) => renderToStaticMarkup(<Chart {...props} {...override} />);
const marks = (html: string, className: string) => [...html.matchAll(new RegExp(`<[^>]+class="${className}"[^>]*>`, "g"))].map((match) => match[0]);
const attr = (mark: string, name: string) => Number(mark.match(new RegExp(` ${name}="([^"]+)"`))?.[1]);

describe("chart time alignment", () => {
  test("candles own their sorted timeline even when line points are unrelated", () => {
    const html = render({ points: [{ t: 1, v: 1000 }, { t: 2, v: 2000 }], candles: [candle(40, 40), candle(10, 10), candle(20, 20)] });
    expect(marks(html, "ics-candle-wick")).toHaveLength(3);
    expect(html).toContain("Price candlestick chart, 3 observations");
    expect(html).toContain("Latest observed price: $40.00 · T40");
    const xs = marks(html, "ics-candle-wick").map((mark) => attr(mark, "x1"));
    expect(xs[1]! - xs[0]!).toBeCloseTo((xs[2]! - xs[1]!) / 2);
  });

  test("mismatched volume timestamps never get relabelled as another candle", () => {
    const html = render({ candles: [candle(10, 10), candle(20, 20), candle(40, 40)], bars: [{ t: 40, v: 0.3 }, { t: 99, v: 1000 }, { t: 10, v: 0.1 }] });
    const candles = marks(html, "ics-candle-wick");
    const bars = marks(html, "ics-chart-bar");
    expect(bars).toHaveLength(2);
    expect(attr(bars[0]!, "x") + attr(bars[0]!, "width") / 2).toBeCloseTo(attr(candles[0]!, "x1"));
    expect(attr(bars[1]!, "x") + attr(bars[1]!, "width") / 2).toBeCloseTo(attr(candles[2]!, "x1"));
    expect(attr(bars[0]!, "height") / attr(bars[1]!, "height")).toBeCloseTo(1 / 3);
    expect(attr(bars[1]!, "height")).toBe(Math.round(260 * 0.22));
    expect(html).not.toContain("1000 USD");
  });

  test("renders valid OHLC without requiring a duplicate close-price series", () => {
    expect(marks(render({ points: [], candles: [candle(10, 10), candle(20, 20)] }), "ics-candle-wick")).toHaveLength(2);
  });

  test("invalid timestamps do not produce malformed coordinates or displace real buckets", () => {
    const html = render({ candles: [candle(Infinity, 30), candle(20, 20), candle(10, 10), candle(NaN, 40)] });
    expect(marks(html, "ics-candle-wick")).toHaveLength(2);
    expect(html).not.toMatch(/(?:x1|y1|x2|y2|x|y)="(?:NaN|Infinity)/);
    expect(html).toContain("Latest observed price: $20.00 · T20");
  });

  test("zero volume stays zero instead of becoming a one-pixel positive bar", () => {
    const html = render({ bars: [{ t: 10, v: 0 }, { t: 20, v: 1 }] });
    expect(marks(html, "ics-chart-bar")).toHaveLength(1);
  });

  test("preserves visible off-scale wick disclosure and inspection access", () => {
    const candles = Array.from({ length: 20 }, (_, index) => candle(index + 1, 10));
    candles[5] = { ...candles[5]!, high: 1_000_000 };
    const html = render({ candles });
    expect(html).toContain("1 wick off scale");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"');
    expect(html).toContain('aria-live="polite"');
  });
});
