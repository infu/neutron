// Value-axis scaling for the price chart.
//
// Separated from the view so the outlier handling can be tested on its own.

export type ChartCandle = {
  /** Epoch seconds, the aligned bucket start. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type Bounds = {
  min: number;
  max: number;
};

export function bounds(values: number[]): Bounds {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.05 : 1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/** The value at `fraction` through a sorted copy of `values`. */
function quantile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/**
 * Scale a candle series, letting an implausible wick run off the axis.
 *
 * Opens and closes are point-in-time prices and always fit. Highs and lows are
 * intraday extremes, and ICPSwap records bad ticks among them — its daily ckBTC
 * candle for 2026-08-19 reports a high of $199,924,397 against a $78,261 close,
 * and the 2026-08-31 candle a low of $47,115 against a $78,242 open. Scaling to
 * those flattens the whole month onto one line.
 *
 * Which wicks are off-scale is decided by Tukey's far-out fence over the highs
 * and lows: three interquartile ranges beyond the quartiles. The quartiles are
 * unmoved by a handful of absurd values, so a bad tick cannot widen the very
 * window meant to exclude it, while a genuinely volatile token has a wide
 * interquartile range and keeps all of its wicks.
 */
export function candleBounds(
  candles: readonly ChartCandle[],
): Bounds & { clipped: number } {
  const bodies: number[] = [];
  const extremes: number[] = [];
  for (const candle of candles) {
    bodies.push(candle.open, candle.close);
    extremes.push(candle.high, candle.low);
  }
  const body = bounds(bodies);
  if (candles.length === 0) return { ...body, clipped: 0 };

  const sorted = extremes
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  // At least a quarter of the price level, so a stablecoin whose quartiles
  // nearly coincide does not treat every ordinary wick as an error.
  const reach = Math.max((q3 - q1) * 3, Math.abs(body.max) * 0.25, Number.EPSILON);
  const ceiling = q3 + reach;
  const floor = q1 - reach;

  let min = body.min;
  let max = body.max;
  let clipped = 0;
  for (const candle of candles) {
    if (candle.high > ceiling || candle.low < floor) clipped += 1;
    if (candle.high <= ceiling && candle.high > max) max = candle.high;
    if (candle.low >= floor && candle.low < min) min = candle.low;
  }
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.05 : 1;
    return { min: min - pad, max: max + pad, clipped };
  }
  return { min, max, clipped };
}

/**
 * Whether an extreme reported alongside a spot price is believable.
 *
 * ICPSwap publishes `priceHigh24H` of $199,924,397 for ckBTC against a $78,760
 * spot. Printing that as a fact is worse than printing nothing.
 */
export function isPlausibleExtreme(value: number, reference: number): boolean {
  if (!Number.isFinite(value) || value <= 0) return false;
  if (!Number.isFinite(reference) || reference <= 0) return true;
  return value <= reference * 20 && value >= reference / 20;
}
