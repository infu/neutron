import { useEffect, useState } from "react";
import { callTool, type JsonObject, type JsonValue } from "neutron-tools/app";
import { createEvmWalletClient } from "neutron-tools/evm_wallet";
import { formatUnits, parseUnits } from "viem";

export const wallet = createEvmWalletClient({ callTool });
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
export const explorer = (chainId: string) => chainId === "1" ? "https://etherscan.io" : "https://arbiscan.io";
export async function invoke<T>(name: string, args: object, signal?: AbortSignal): Promise<T> {
  return await callTool<JsonValue>({ target: "app:aave:background", name, arguments: args as JsonObject }, { timeout: 300000, ...(signal ? { signal } : {}) }) as T;
}
export function atoms(value: string, decimals: number): string {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) throw new Error(`Enter an amount with at most ${decimals} decimal places.`);
  return parseUnits(value, decimals).toString();
}
export function display(value: string, decimals: number, digits = 6): string {
  const exact = formatUnits(BigInt(value), decimals), [whole, fraction] = exact.split(".");
  if (!fraction || fraction.length <= digits) return exact;
  if (BigInt(value) > 0n && Number(exact) < 10 ** -digits) return `< ${10 ** -digits}`;
  return `${whole}.${fraction.slice(0, digits).replace(/0+$/, "")}`.replace(/\.$/, "");
}
export function money(value: number | null | undefined, compact = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: compact ? 1 : 2, ...(compact ? { notation: "compact" } : {}) }).format(value);
}
export function percent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}%`;
}
/** Reads keep data during a refresh but never show a previous network or input
 * under a new scope. Aborted requests cannot overwrite the selected scope. */
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
export function ErrorNote({ error }: { error: string }) { return error ? <p className="av-error" role="alert">{error}</p> : null; }
export function Spinner({ label }: { label: string }) { return <p className="av-loading" role="status"><span className="av-spinner" aria-hidden="true" />{label}</p>; }
export function AssetMark({ symbol, address }: { symbol: string; address: string }) {
  const hue = parseInt(address.slice(-6), 16) % 360;
  return <span className="av-asset-mark" aria-hidden="true" style={{ backgroundColor: `hsl(${hue} 24% 24%)`, color: `hsl(${hue} 45% 85%)` }}>{symbol.slice(0, 2)}</span>;
}
