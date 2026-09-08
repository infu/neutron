import { fromBaseUnits } from "./amount.ts";

export type LiquidityTokenDisplay = { decimals: number | null; priceUsd?: number | null };

/** Display estimates only. A missing or zero analytics price is not a zero-value asset. */
export function liquidityUsdValue(atoms: string | null, token: LiquidityTokenDisplay): number | null {
  if (atoms === null || !/^\d+$/u.test(atoms)) return null;
  if (BigInt(atoms) === 0n) return 0;
  if (token.decimals === null || !Number.isSafeInteger(token.decimals) || token.decimals < 0 || !token.priceUsd || !Number.isFinite(token.priceUsd) || token.priceUsd < 0) return null;
  const value = Number(fromBaseUnits(BigInt(atoms), token.decimals)) * token.priceUsd;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Do not present a partially priced pair as the value of the whole position. */
export function liquidityPairValue(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null || !Number.isFinite(value) || value < 0)) return null;
  const value = values.reduce<number>((sum, value) => sum + value!, 0);
  return Number.isFinite(value) ? value : null;
}

export function formatLiquidityUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value !== 0 && Math.abs(value) < 0.01) return `${value < 0 ? "-" : ""}<$0.01`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

/** Keep small positive fees distinct from zero; callers can show the exact value in a title. */
export function formatLiquidityAmount(atoms: string | null, decimals: number | null): string {
  if (atoms === null) return "Unavailable";
  if (decimals === null) return `${atoms} atoms`;
  const exact = fromBaseUnits(BigInt(atoms), decimals);
  const precision = Math.min(decimals, 6);
  const [whole = "0", fraction = ""] = exact.split(".");
  const shown = fraction.slice(0, precision).replace(/0+$/u, "");
  if (BigInt(atoms) > 0n && whole === "0" && !shown) return `<0.${"0".repeat(precision - 1)}1`;
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}${shown ? `.${shown}` : ""}`;
}

/** Linear price placement. Token decimal scaling cancels from the ratio. */
export function liquidityRangeProgress(lower: number, upper: number, current: number | null): number | null {
  if (current === null || ![lower, upper, current].every(Number.isFinite) || lower >= upper) return null;
  if (current <= lower) return 0;
  if (current >= upper) return 1;
  return Math.expm1((current - lower) * Math.log(1.0001)) / Math.expm1((upper - lower) * Math.log(1.0001));
}
