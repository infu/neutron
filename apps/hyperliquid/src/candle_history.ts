import type { Candle } from "./market.ts";

/** Keep completed stream revisions until REST catches up. A successful snapshot
 * supplies the rolling history window; its response can still trail the stream. */
export function mergeCandleHistory(current: readonly Candle[], incoming: readonly Candle[], snapshot = false): Candle[] {
  const start = snapshot && incoming.length ? Math.min(...incoming.map((candle) => candle.t)) : -Infinity;
  const rows = new Map(current.filter((candle) => candle.t >= start).map((candle) => [candle.t, candle]));
  for (const candle of incoming) {
    const previous = rows.get(candle.t);
    // Candle trade count and cumulative volume distinguish newer observations
    // even when an older REST request completes after a stream update.
    if (!previous || candle.n > previous.n || candle.n === previous.n && Number(candle.v) >= Number(previous.v)) rows.set(candle.t, candle);
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}
