import { useEffect, useState } from "react";
import { callTool, type JsonObject, type JsonValue } from "neutron-tools/app";
import { createEvmWalletClient, type EvmBalancesResult, type EvmPriceAsset, type EvmUsdPrice } from "neutron-tools/evm_wallet";
import { evmPriceWatcher } from "neutron-tools/src/evm_price_watch.js";
import { evmPriceAssetKey, formatUsd, usdPriceTitle, usdValue } from "neutron-tools/src/evm_prices.js";
import { formatUnits, parseUnits } from "viem";
import type { Token } from "./contracts.ts";
import type { LiquidityInput } from "./plans.ts";

export const wallet = createEvmWalletClient({ callTool });
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export async function invoke<T>(name: string, args: object, signal?: AbortSignal): Promise<T> {
  return await callTool<JsonValue>({ target: "app:curve:background", name, arguments: args as JsonObject }, { timeout: 300000, ...(signal ? { signal } : {}) }) as T;
}
export function atoms(value: string, decimals: number): string {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) throw new Error(`Enter an amount with at most ${decimals} decimal places.`);
  return parseUnits(value, decimals).toString();
}
/** Keep inactive form drafts out of the operation being reviewed. */
export function liquidityDraftAmounts(mode: LiquidityInput["kind"], amounts: readonly string[], coins: readonly Pick<Token, "decimals">[], lp: string, lpDecimals: number): Pick<LiquidityInput, "amounts" | "lpAmount"> | null {
  if (mode === "deposit") {
    const parsed = amounts.map((amount, i) => amount ? atoms(amount, coins[i]!.decimals) : "0");
    return parsed.some((amount) => BigInt(amount) > 0n) ? { amounts: parsed, lpAmount: "0" } : null;
  }
  const lpAmount = lp ? atoms(lp, lpDecimals) : "0";
  return BigInt(lpAmount) > 0n ? { amounts: [], lpAmount } : null;
}
export function display(value: string, decimals: number, digits = 7): string {
  const exact = formatUnits(BigInt(value), decimals), [whole, fraction] = exact.split(".");
  if (!fraction || fraction.length <= digits) return exact;
  if (BigInt(value) > 0n && Number(exact) < 10 ** -digits) return `< ${10 ** -digits}`;
  return `${whole}.${fraction.slice(0, digits).replace(/0+$/, "")}`.replace(/\.$/, "");
}
export function balanceFor(balances: EvmBalancesResult | null, token: Token): string | null {
  if (!balances || balances.chainId !== token.chainId) return null;
  return token.address === null ? balances.nativeBalanceWei : balances.tokens.find((row) => row.address.toLowerCase() === token.address!.toLowerCase())?.balanceAtoms ?? null;
}
/** Clear stale scope immediately, cancel superseded reads and retain useful
 * data during same-scope refreshes. Missing values never masquerade as zero. */
export function useRead<T>(key: string | null, read: (signal: AbortSignal) => Promise<T>, refresh = 0, delay = 0) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string; loading: boolean }>({ key: null, data: null, error: "", loading: false });
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    setState((old) => ({ key, data: old.key === key ? old.data : null, error: "", loading: true }));
    const timer = setTimeout(() => { void read(controller.signal).then(
      (data) => { if (!controller.signal.aborted) setState({ key, data, error: "", loading: false }); },
      (error) => { if (!controller.signal.aborted) setState((old) => ({ key, data: old.key === key ? old.data : null, error: message(error), loading: false })); },
    ); }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, refresh, delay]);
  return state.key === key && key !== null ? state : { key, data: null, error: "", loading: key !== null };
}
export function usePrices(assets: readonly EvmPriceAsset[]) {
  const key = JSON.stringify(assets.map(({ chainId, address }) => ({ chainId, address })));
  const [prices, setPrices] = useState<EvmUsdPrice[]>([]);
  useEffect(() => evmPriceWatcher().subscribe(JSON.parse(key), setPrices), [key]);
  const byAsset = new Map(prices.map((price) => [evmPriceAssetKey(price), price]));
  return (asset: EvmPriceAsset) => byAsset.get(evmPriceAssetKey(asset));
}
export function Usd({ value, token, price }: { value: string | null; token: Token; price: EvmUsdPrice | undefined }) {
  const usd = value === null ? null : usdValue(value, token.decimals, price);
  return <span className="cv-usd" title={usdPriceTitle(price)}>{usd === null ? "USD unavailable" : `≈ ${formatUsd(usd)}`}{usd !== null && price?.status === "stale" ? " · outdated" : ""}</span>;
}
export function ErrorNote({ error }: { error: string }) { return error ? <p className="cv-error" role="alert">{error}</p> : null; }
export function Spinner({ label }: { label: string }) { return <p className="cv-loading" role="status"><span className="cv-spinner" aria-hidden="true" />{label}</p>; }
export function TokenMark({ token }: { token: Pick<Token, "symbol"> }) { return <span className="cv-token-mark" aria-hidden="true">{token.symbol.slice(0, 2)}</span>; }
