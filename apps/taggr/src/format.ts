/** Small display helpers shared by the tile views. */

/** Taggr timestamps are nanoseconds since the epoch. */
export const nanosToMillis = (nanos: number): number => Math.floor(nanos / 1_000_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative time: "now", "4m", "3h", "6d", then an absolute date.
 * Deliberately terse — the feed rows are one line of metadata.
 */
export const relativeTime = (nanos: number, now = Date.now()): string => {
  const millis = nanosToMillis(nanos);
  if (!Number.isFinite(millis) || millis <= 0) return "";
  const elapsed = now - millis;
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  return new Date(millis).toISOString().slice(0, 10);
};

export const absoluteTime = (nanos: number): string => {
  const millis = nanosToMillis(nanos);
  if (!Number.isFinite(millis) || millis <= 0) return "unknown time";
  return new Date(millis).toISOString().replace("T", " ").slice(0, 16) + " UTC";
};

/** 1_234 -> "1.2k". Feed counters must not push the row wider than the tile. */
export const compactCount = (value: number): string => {
  if (!Number.isFinite(value)) return "0";
  if (value < 1_000) return String(Math.trunc(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
};

/** Taggr tokens carry 8 decimals in the same way ICP does. */
export const formatTokens = (value: number, decimals = 8): string => {
  if (!Number.isFinite(value)) return "0";
  const base = 10 ** decimals;
  return (value / base).toFixed(Math.min(decimals, 4)).replace(/\.?0+$/, "") || "0";
};

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong";
};

/** Trims a principal for a dense row while keeping both ends recognisable. */
export const shortPrincipal = (value: string): string =>
  value.length <= 17 ? value : `${value.slice(0, 8)}…${value.slice(-5)}`;
