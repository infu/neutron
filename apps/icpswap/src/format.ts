// Display formatting helpers. Pure functions, no kernel or DOM dependencies, so
// they can be unit tested and reused by the resident service.

const COMPACT_STEPS: ReadonlyArray<readonly [number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Fixed decimals without exponent notation, trimming trailing zeros. */
function trimmed(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/\.?0+$/, "");
}

function withGrouping(text: string): string {
  const negative = text.startsWith("-");
  const body = negative ? text.slice(1) : text;
  const [whole = "", fraction] = body.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const joined = fraction === undefined ? grouped : `${grouped}.${fraction}`;
  return negative ? `-${joined}` : joined;
}

/**
 * Compact magnitude form used by market tables: 1.23M, 45.6K, 987.
 * Values under 1000 keep up to `smallDecimals` decimals.
 */
export function formatCompact(value: number, smallDecimals = 2): string {
  if (!isFiniteNumber(value)) return "-";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  for (const [scale, suffix] of COMPACT_STEPS) {
    if (magnitude >= scale) {
      const scaled = magnitude / scale;
      const decimals = scaled >= 100 ? 1 : 2;
      return `${sign}${trimmed(scaled, decimals)}${suffix}`;
    }
  }
  return `${sign}${withGrouping(trimmed(magnitude, smallDecimals))}`;
}

/** Compact USD amount for volume, TVL, and market-cap columns. */
export function formatUsdCompact(value: number): string {
  if (!isFiniteNumber(value)) return "-";
  if (value === 0) return "$0";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${formatCompact(Math.abs(value)).replace(/^-/, "")}`;
}

/**
 * Price formatting that keeps small-cap tokens readable: significant digits
 * grow as the price shrinks, so 0.00000123 does not collapse to $0.00.
 */
export function formatPrice(value: number): string {
  if (!isFiniteNumber(value)) return "-";
  if (value === 0) return "$0.00";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return `${sign}$${withGrouping(trimmed(magnitude, 2))}`;
  if (magnitude >= 1) return `${sign}$${withGrouping(trimmed(magnitude, 4))}`;
  if (magnitude >= 0.01) return `${sign}$${trimmed(magnitude, 5)}`;
  if (magnitude >= 0.0001) return `${sign}$${trimmed(magnitude, 7)}`;
  // Keep four significant digits for very small prices.
  const exponent = Math.floor(Math.log10(magnitude));
  const decimals = Math.min(18, Math.abs(exponent) + 3);
  return `${sign}$${trimmed(magnitude, decimals)}`;
}

/**
 * A price quoted in ICP rather than in dollars.
 *
 * Mirrors `formatPrice`'s precision ladder: a ckBTC quote runs to five figures
 * and needs no decimals to speak of, while a microcap quote needs eight.
 */
export function formatIcp(value: number): string {
  if (!isFiniteNumber(value)) return "-";
  if (value === 0) return "0 ICP";
  const sign = value < 0 ? "-" : "";
  const magnitude = Math.abs(value);
  const decimals =
    magnitude >= 1000
      ? 2
      : magnitude >= 1
        ? 4
        : magnitude >= 0.01
          ? 5
          : magnitude >= 0.0001
            ? 7
            : Math.min(18, Math.abs(Math.floor(Math.log10(magnitude))) + 3);
  return `${sign}${withGrouping(trimmed(magnitude, decimals))} ICP`;
}

/** Plain (non-currency) number with sensible precision. */
export function formatNumber(value: number, decimals = 2): string {
  if (!isFiniteNumber(value)) return "-";
  return withGrouping(trimmed(value, decimals));
}

/** Signed percentage with one decimal, e.g. +4.2% or -0.8%. */
export function formatPercent(value: number, decimals = 2): string {
  if (!isFiniteNumber(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${trimmed(value, decimals)}%`;
}

export type Trend = "up" | "down" | "flat";

export function trendOf(value: number | undefined): Trend {
  if (!isFiniteNumber(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

/** ICPSwap fee tiers are expressed in hundredths of a basis point. */
export function formatFeeTier(feeTier: number): string {
  if (!isFiniteNumber(feeTier)) return "-";
  return `${trimmed(feeTier / 10_000, 4)}%`;
}

/** Shorten a principal for dense table cells: aaaaa-…-cai */
export function shortPrincipal(value: string, lead = 5, tail = 3): string {
  if (typeof value !== "string" || value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/**
 * ICPSwap timestamps are seconds since epoch on the analytics canisters. Values
 * that are clearly nanoseconds or milliseconds are normalized so charts and
 * tooltips stay correct if an upstream canister changes units.
 */
export function toEpochMs(timestamp: number): number {
  if (!isFiniteNumber(timestamp) || timestamp <= 0) return 0;
  if (timestamp > 1e17) return Math.round(timestamp / 1e6); // nanoseconds
  if (timestamp > 1e14) return Math.round(timestamp / 1e3); // microseconds
  if (timestamp > 1e11) return Math.round(timestamp); // milliseconds
  return Math.round(timestamp * 1000); // seconds
}

export function formatDate(timestampSeconds: number): string {
  const ms = toEpochMs(timestampSeconds);
  if (ms === 0) return "-";
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatDateTime(timestampSeconds: number): string {
  const ms = toEpochMs(timestampSeconds);
  if (ms === 0) return "-";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export function formatRelative(timestampSeconds: number, nowMs = Date.now()): string {
  const ms = toEpochMs(timestampSeconds);
  if (ms === 0) return "-";
  const deltaSeconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86400)}d ago`;
}

/** Convert a raw ledger amount to a decimal string. */
export function formatTokenAmount(raw: bigint | number, decimals: number): string {
  const scale = 10 ** Math.max(0, Math.min(30, Math.trunc(decimals)));
  const numeric = typeof raw === "bigint" ? Number(raw) : raw;
  if (!isFiniteNumber(numeric)) return "-";
  return formatNumber(numeric / scale, decimals > 6 ? 6 : decimals);
}

/**
 * Pick the most distinctive short label for a symbol.
 *
 * Chain-key and wrapped tokens share a lowercase prefix, so `ckBTC`, `ckETH`,
 * `ckUSDC` and `ckUSDT` would all collapse to "CK". Dropping that prefix keeps
 * them apart, and up to four characters are kept so `USDC` and `USDT` stay
 * distinguishable.
 */
export function tokenInitials(symbol: string, address: string): string {
  const source = symbol.trim() || address.trim();
  if (source === "") return "?";
  const compact = source.replace(/[^A-Za-z0-9]/g, "");
  if (compact === "") return "?";
  const core = compact.replace(/^(?:ck|wrapped|w|x)(?=[A-Z0-9])/, "") || compact;
  return core.slice(0, 4).toUpperCase();
}
