import { formatUsd, usdPriceTitle, usdValue, type EvmPriceAsset, type EvmUsdPrice } from "neutron-tools/src/evm_prices.js";
import { amountAtoms, type Token } from "./swap.ts";

export type PriceFor = (asset: EvmPriceAsset) => EvmUsdPrice | undefined;
export type TokenAmount = { token: Token; atoms: string | null };

/** Valuation is secondary display only; the transaction keeps its exact atoms. */
export function draftAtoms(amount: string, token: Token): string | null {
  if (/^0(?:\.0+)?$/.test(amount)) return "0";
  try { return amountAtoms(amount, token); } catch { return null; }
}

export function UsdAmount({ atoms, decimals, price, className = "", label = "Estimated USD value" }: { atoms: string | null; decimals: number; price: EvmUsdPrice | undefined; className?: string; label?: string }) {
  const value = atoms === null ? null : usdValue(atoms, decimals, price);
  const text = formatUsd(value), stale = value !== null && price?.status === "stale";
  return <span className={`uni-usd ${className}`} title={usdPriceTitle(price)} aria-label={`${label}: ${text}${stale ? ", price outdated" : ""}`}>{value === null ? text : `≈ ${text}`}{stale && <span className="uni-usd-stale"> · outdated</span>}</span>;
}

/** An incomplete pair is never presented as its complete USD total. */
export function UsdTotal({ amounts, priceFor, label }: { amounts: readonly TokenAmount[]; priceFor: PriceFor; label: string }) {
  const values = amounts.map(({ atoms, token }) => atoms === null ? null : usdValue(atoms, token.decimals, priceFor(token)));
  const sum = values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
  const total = sum !== null && Number.isFinite(sum) ? sum : null;
  const text = formatUsd(total), stale = total !== null && amounts.some(({ token }) => priceFor(token)?.status === "stale");
  const title = amounts.map(({ token }) => `${token.symbol}: ${usdPriceTitle(priceFor(token))}`).join("\n");
  return <span className="uni-usd" title={title} aria-label={`${label}: ${text}${stale ? ", price outdated" : ""}`}>{total === null ? text : `≈ ${text}`}{stale && <span className="uni-usd-stale"> · outdated</span>}</span>;
}
