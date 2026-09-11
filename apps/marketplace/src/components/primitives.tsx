import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AppListing, CycleEstimate, Money } from "../view-types.ts";

export function acquisitionStats(app: AppListing): { count: string; label: string } | null {
  const free = BigInt(app.priceUsdMicros) === 0n;
  const value = free ? app.freeAcquisitions : app.paidPurchases;
  if (value === undefined) return null;
  const count = BigInt(value);
  return { count: count.toLocaleString("en-US"), label: free ? "added" : count === 1n ? "purchase" : "purchases" };
}

export function usd(micros: string): string {
  const value = BigInt(micros);
  if (value === 0n) return "Free";
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${(value / 1_000_000n).toLocaleString("en-US")}.${fraction}`;
}
export function quantity(value: Money): string {
  const n = BigInt(value.atoms), base = 10n ** BigInt(value.decimals);
  const fraction = (n % base).toString().padStart(value.decimals, "0").replace(/0+$/, "");
  return `${(n / base).toLocaleString("en-US")}${fraction ? `.${fraction}` : ""} ${value.symbol}`;
}
export function parseAmount(input: string, decimals: number): string {
  if (!/^\d+(?:\.\d*)?$/.test(input.trim())) throw new Error("Enter a positive amount.");
  const [whole = "0", fraction = ""] = input.trim().split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const result = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (result <= 0n) throw new Error("Enter an amount greater than zero.");
  return result.toString();
}
export function decimalAmount(value: Money): string { return quantity(value).slice(0, -(value.symbol.length + 1)).replaceAll(",", ""); }
export function dateLabel(value: string | undefined): string {
  if (!value) return "";
  const milliseconds = /^\d+$/.test(value) ? Number(value.length > 15 ? BigInt(value) / 1_000_000n : value) : Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** App frames intentionally lack allow-forms; Enter activates the local action. */
export function activateOnInputEnter(event: KeyboardEvent<HTMLElement>, action: () => void) {
  if (event.key !== "Enter" || event.repeat || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !["text", "number"].includes(target.type) || target.disabled || target.readOnly) return;
  event.preventDefault();
  action();
}

export function useRead<T>(key: string | null, read: () => Promise<T>, refresh = 0, delay = 0) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string; loading: boolean }>({ key: null, data: null, error: "", loading: false });
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    setState((old) => ({ key, data: old.key === key ? old.data : null, error: "", loading: true }));
    const timer = setTimeout(() => void read().then(
      (data) => { if (alive) setState({ key, data, error: "", loading: false }); },
      (error) => { if (alive) setState((old) => ({ key, data: old.key === key ? old.data : null, error: errorMessage(error), loading: false })); },
    ), delay);
    return () => { alive = false; clearTimeout(timer); };
  }, [key, refresh, delay]);
  return key !== null && state.key === key ? state : { key, data: null, error: "", loading: key !== null };
}

type IconName = "store" | "search" | "apps" | "publish" | "earnings" | "close" | "back" | "refresh" | "check" | "arrow" | "shield" | "download" | "plus" | "copy" | "discount";
const paths: Record<IconName, ReactNode> = {
  store: <><path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0" /><path d="M9 20v-6h6v6" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  apps: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  publish: <><path d="m7 8 5-5 5 5M12 3v12M4 14v6h16v-6" /></>,
  earnings: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M16 11h5v5h-5a2.5 2.5 0 0 1 0-5M3 9h18" /></>,
  discount: <><path d="M3 4v7l9 9a2 2 0 0 0 3 0l5-5a2 2 0 0 0 0-3l-9-9H4a1 1 0 0 0-1 1Z" /><circle cx="7.5" cy="7.5" r="1" /><path d="m11 15 5-5" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />, back: <path d="m14 5-7 7 7 7" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
  check: <path d="m5 12 4 4L19 6" />, arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>,
  plus: <path d="M12 5v14M5 12h14" />, copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" /></>,
};
export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`mp-icon ${className}`} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function AppIcon({ app, large = false }: { app: Pick<AppListing, "id" | "title" | "iconUrl">; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [app.iconUrl]);
  const hue = [...app.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0);
  return <span className={`mp-app-icon${large ? " mp-app-icon-large" : ""}`} style={{ background: `hsl(${hue} 30% 18%)`, color: `hsl(${hue} 60% 80%)` }}>{app.iconUrl && !failed ? <img src={app.iconUrl} alt="" loading="lazy" onError={() => setFailed(true)} /> : app.title.slice(0, 1).toUpperCase()}</span>;
}
export function ErrorNote({ error, retry }: { error: string | null; retry?: (() => void) | undefined }) {
  return error ? <div className="mp-error" role="alert"><span>{error}</span>{retry && <button className="mp-text-button" type="button" onClick={retry}>Try again</button>}</div> : null;
}
export function EmptyState({ title, children, icon = "apps", action }: { title: string; children: ReactNode; icon?: IconName; action?: ReactNode }) {
  return <div className="mp-empty"><span className="mp-empty-icon"><Icon name={icon} /></span><h2>{title}</h2><p>{children}</p>{action}</div>;
}
export function Loading({ label = "Loading apps…" }: { label?: string }) { return <div className="mp-loading" role="status"><span className="mp-spinner" />{label}</div>; }
export function Principal({ value }: { value: string }) { return <span className="mp-principal" title={value}>{value}</span>; }
export function CycleCost({ value, storage = false }: { value: CycleEstimate; storage?: boolean }) {
  return <details className="mp-cost-detail"><summary><span>{storage ? "Upload & first-year storage" : "Protocol processing"}</span><strong>{BigInt(value.total).toLocaleString("en-US")} cycles</strong></summary><dl className="mp-facts"><div><dt>Processing</dt><dd>{BigInt(value.processing).toLocaleString("en-US")} cycles</dd></div>{value.storage && BigInt(value.storage) > 0n && <div><dt>First-year storage</dt><dd>{BigInt(value.storage).toLocaleString("en-US")} cycles</dd></div>}<div><dt>Fixed cost schedule</dt><dd>{value.schedule}</dd></div></dl><p className="mp-muted">Paid by this Neutron. {storage ? "The operator funds storage after year one. No annual renewal is required." : "Separate from token and network fees."}</p></details>;
}
export function Modal({ title, close, children, footer, wide = false }: { title: string; close: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current; dialog?.showModal();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={`mp-modal nt-app${wide ? " mp-modal-wide" : ""}`} aria-label={title} onCancel={close} onClose={close}><div className="mp-modal-layout"><header className="mp-modal-header"><h2>{title}</h2><button className="mp-icon-button" aria-label="Close dialog" onClick={close} type="button"><Icon name="close" /></button></header><div className="mp-modal-body">{children}</div>{footer && <footer className="mp-modal-footer">{footer}</footer>}</div></dialog>;
}
