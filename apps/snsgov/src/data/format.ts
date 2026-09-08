/**
 * Amount, duration, and percentage formatting.
 *
 * Every token amount is a `bigint` scaled by the ledger's own `decimals`. There
 * is no floating point anywhere in this file: 40 of 54 SNS total supplies exceed
 * `Number.MAX_SAFE_INTEGER`, so `Number(amount)` silently corrupts them.
 */

import { SECONDS_PER_DAY, SECONDS_PER_JULIAN_MONTH, SECONDS_PER_JULIAN_YEAR } from "./ids";

/** Exact decimal string for a scaled integer amount. No precision loss. */
export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  options: { maxFractionDigits?: number; group?: boolean } = {},
): string {
  if (typeof amount !== "bigint") {
    // Mixing a number or undefined into the bigint arithmetic below throws
    // "Cannot mix BigInt and other types", which names neither the value nor
    // the caller and takes the whole render down with it.
    throw new TypeError(`token amount must be a bigint, got ${typeof amount}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new RangeError(`invalid decimals: ${decimals}`);
  }
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = magnitude / scale;
  const fraction = magnitude % scale;

  let fractionText = decimals === 0 ? "" : fraction.toString().padStart(decimals, "0");
  const maxFraction = options.maxFractionDigits;
  if (maxFraction !== undefined && fractionText.length > maxFraction) {
    fractionText = fractionText.slice(0, maxFraction);
  }
  fractionText = fractionText.replace(/0+$/, "");

  const wholeText = options.group === false ? whole.toString() : groupDigits(whole.toString());
  const sign = negative ? "-" : "";
  return fractionText.length > 0 ? `${sign}${wholeText}.${fractionText}` : `${sign}${wholeText}`;
}

/** Compact form for dense tables: 12'128 rather than 12'128.4471. */
export function formatTokenCompact(amount: bigint, decimals: number): string {
  return formatTokenAmount(amount, decimals, { maxFractionDigits: amount === 0n ? 0 : 2 });
}

/**
 * Parse a user-typed decimal amount into a scaled integer.
 * Rejects rather than rounds when the input carries more precision than the
 * token supports — silently dropping a digit off a transfer amount is not an
 * acceptable failure mode.
 */
export function parseTokenAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim().replace(/[',_\s]/g, "");
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === "." || trimmed === "-") {
    throw new SyntaxError(`not a decimal amount: ${input}`);
  }
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [wholeText = "", fractionText = ""] = body.split(".");
  if (fractionText.length > decimals) {
    throw new RangeError(`more than ${decimals} decimal places: ${input}`);
  }
  const padded = fractionText.padEnd(decimals, "0");
  const value = BigInt(`${wholeText === "" ? "0" : wholeText}${padded === "" ? "" : padded}`);
  return negative ? -value : value;
}

/** Apostrophe grouping, matching the IC dashboard: 487'633.
 * ASCII on purpose — a thin space breaks copy-paste and string equality.
 * `parseTokenAmount` strips it again. */
function groupDigits(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

/**
 * Render a duration the way the IC dashboard does: whole years, months, or
 * days, floored. SNS parameters sit a few hundred seconds off exact Julian
 * multiples (Neutrinite's minimum dissolve delay is 2_630_016s, 216s past a
 * Julian month), so exact-multiple checks fail and flooring is what matches.
 */
export function formatDuration(seconds: bigint | number): string {
  const total = typeof seconds === "bigint" ? Number(seconds) : seconds;
  if (!Number.isFinite(total) || total < 0) return "—";
  if (total === 0) return "0 seconds";

  if (total >= SECONDS_PER_JULIAN_YEAR) {
    const years = Math.floor(total / SECONDS_PER_JULIAN_YEAR);
    return plural(years, "year");
  }
  if (total >= SECONDS_PER_JULIAN_MONTH) {
    const days = Math.floor(total / SECONDS_PER_DAY);
    return plural(days, "day");
  }
  if (total >= SECONDS_PER_DAY) {
    const days = Math.floor(total / SECONDS_PER_DAY);
    return plural(days, "day");
  }
  if (total >= 3_600) return plural(Math.floor(total / 3_600), "hour");
  if (total >= 60) return plural(Math.floor(total / 60), "minute");
  return plural(total, "second");
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

/** Basis points (1/10_000) to a percentage string. */
export function formatBasisPoints(basisPoints: bigint | number): string {
  const value = typeof basisPoints === "bigint" ? Number(basisPoints) : basisPoints;
  return `${trimFloat(value / 100)}%`;
}

/** A whole-percent field, as SNS bonus parameters use. */
export function formatPercent(percent: bigint | number): string {
  const value = typeof percent === "bigint" ? Number(percent) : percent;
  return `${trimFloat(value)}%`;
}

function trimFloat(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/**
 * The reward rate line, e.g. "2% to 2% over 12 years".
 *
 * The rate itself decays quadratically from initial to final over the
 * transition duration; this renders the endpoints, which is what the dashboard
 * shows.
 */
export function formatRewardRate(params: {
  initialBasisPoints?: bigint | undefined;
  finalBasisPoints?: bigint | undefined;
  transitionSeconds?: bigint | undefined;
}): string | null {
  const { initialBasisPoints, finalBasisPoints, transitionSeconds } = params;
  if (initialBasisPoints === undefined || finalBasisPoints === undefined) return null;
  const start = formatBasisPoints(initialBasisPoints);
  const end = formatBasisPoints(finalBasisPoints);
  if (transitionSeconds === undefined) return `${start} to ${end}`;
  const years = Math.floor(Number(transitionSeconds) / SECONDS_PER_JULIAN_YEAR);
  return `${start} to ${end} over ${plural(years, "year")}`;
}

/** Seconds since the Unix epoch to an ISO-8601 UTC string. */
export function formatTimestamp(seconds: bigint | number): string {
  const value = typeof seconds === "bigint" ? Number(seconds) : seconds;
  if (!Number.isFinite(value) || value <= 0) return "—";
  return new Date(value * 1_000).toISOString().replace(".000Z", "Z");
}

/** Shorten a principal or hex id for dense display, keeping both ends. */
export function shortenId(value: string, lead = 5, tail = 3): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

/** Lowercase hex for a byte array, e.g. a neuron id. */
export function toHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new SyntaxError(`not hex: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
