// Converting what a person types into what a ledger counts.
//
// Kept out of the view so it can be tested directly. Everything here stays in
// integers: a swap amount that passes through a float has already lost the
// precision the whole flow depends on.

import { formatNumber } from "./format.ts";

/**
 * Human decimal text to base units, or `null` when it cannot be expressed
 * exactly at this token's precision.
 *
 * Returning `null` rather than truncating is deliberate. Silently rounding
 * "0.001" down to zero for a two-decimal token would swap a different amount
 * than the one the owner typed.
 */
export function toBaseUnits(value: string, decimals: number): bigint | null {
  if (!Number.isSafeInteger(decimals) || decimals < 0) return null;
  const trimmed = value.trim();
  if (trimmed === "" || !/^[0-9]*\.?[0-9]*$/u.test(trimmed)) return null;
  const [whole = "", fraction = ""] = trimmed.split(".");
  if (whole === "" && fraction === "") return null;
  if (fraction.length > decimals) return null;
  const padded = fraction.padEnd(decimals, "0");
  const digits = `${whole === "" ? "0" : whole}${padded}`;
  if (!/^[0-9]+$/u.test(digits)) return null;
  const parsed = BigInt(digits);
  return parsed > 0n ? parsed : null;
}

/** Slippage is carried in thousandths of a percent, as ICPSwap carries it. */
export function slippageLabel(value: number): string {
  return `${formatNumber(value / 1000, 3)}%`;
}

/**
 * Why a typed amount could not be used, in words the owner can act on.
 *
 * Returning a reason rather than nothing matters: a filled form with no quote
 * and no explanation is the worst outcome, and it is what happens for a token
 * whose decimals this Neutron has not read yet.
 */
export function describeAmountProblem(
  raw: string,
  decimals: number,
  symbol: string,
): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || toBaseUnits(trimmed, decimals) !== null) return null;
  if (!/^[0-9]*\.?[0-9]*$/u.test(trimmed)) return "Enter a plain decimal amount.";
  const fraction = trimmed.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    return decimals === 0
      ? `${symbol} has no known decimal places yet, so only whole units can be swapped. Refresh the market and try again.`
      : `${symbol} supports at most ${decimals} decimal places.`;
  }
  return "Enter an amount greater than zero.";
}

/**
 * How much output one whole unit of input buys, as a plain number.
 *
 * Only ever used for display, so returning a `number` is safe here — the
 * amounts themselves stay in `bigint` everywhere that matters. Returns 0 when
 * there is nothing to divide, so a missing rate can never render as a real one.
 */
export function unitRate(
  amountIn: bigint,
  amountOut: bigint,
  decimalsIn: number,
  decimalsOut: number,
): number {
  if (amountIn <= 0n || amountOut <= 0n) return 0;
  const scaleIn = 10 ** Math.max(0, Math.min(30, Math.trunc(decimalsIn)));
  const scaleOut = 10 ** Math.max(0, Math.min(30, Math.trunc(decimalsOut)));
  const inUnits = Number(amountIn) / scaleIn;
  const outUnits = Number(amountOut) / scaleOut;
  if (!Number.isFinite(inUnits) || !Number.isFinite(outUnits) || inUnits === 0) {
    return 0;
  }
  const rate = outUnits / inUnits;
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/**
 * Base units back to human decimal text, exactly.
 *
 * Used for the "Max" control, so it must round-trip through `toBaseUnits`
 * without losing a single unit — a max that is one atom over the balance
 * fails, and one that is short leaves dust behind. Integer arithmetic only.
 */
export function fromBaseUnits(value: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0) throw new Error("Token decimals must be a non-negative integer.");
  if (value < 0n) return `-${fromBaseUnits(-value, decimals)}`;
  const places = decimals;
  if (places === 0) return value.toString();
  const digits = value.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/u, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
