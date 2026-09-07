import { useEffect, useState, useSyncExternalStore } from "react";
import { callTool, exposeTool, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { HyperliquidMarketStream, parseBook, type Candle, type CandleInterval, type MarketContext, type MarketStreamStatus, type OrderBook } from "./market.ts";

export type Environment = "mainnet" | "testnet";
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const operationId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const numeric = (value: unknown): number | null => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
export function number(value: unknown, digits = 2): string {
  const n = numeric(value);
  return n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });
}
export function money(value: unknown, compact = false): string {
  const n = numeric(value);
  return n === null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: compact ? 1 : 2, ...(compact ? { notation: "compact" } : {}) });
}
export function priceMoney(value: unknown): string {
  const n = numeric(value);
  return n === null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 1 ? 8 : Math.abs(n) < 100 ? 5 : 2 });
}
export function percentage(value: unknown, digits = 2): string {
  const n = numeric(value);
  return n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}
export async function invoke<T>(name: string, args: object, signal?: AbortSignal): Promise<T> {
  const response = await callTool<JsonValue>({ target: "app:hyperliquid:background", name, arguments: args as JsonObject }, { timeout: 300, ...(signal ? { signal } : {}) }) as { dataJson?: string; resultJson?: string };
  const encoded = response.dataJson ?? response.resultJson;
  if (typeof encoded !== "string") throw new Error("The Hyperliquid service returned an unreadable response. Refresh to reconnect.");
  return JSON.parse(encoded) as T;
}
/** The selected market/network never inherits a previous request's data. */
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
export function useClock(milliseconds: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") setTick((old) => old + 1); }, milliseconds);
    return () => clearInterval(timer);
  }, [milliseconds]);
  return tick;
}

/** Public market updates go directly to Hyperliquid. Scope checks also prevent
 * an old socket from showing another market or environment after tile changes. */
export function useMarketStream(environment: Environment, coin: string, interval: string, reconcile: () => void) {
  const key = `${environment}:${coin}:${interval}`;
  const [live, setLive] = useState<{ key: string; book: OrderBook | null; candle: Candle | null; context: MarketContext | null; status: MarketStreamStatus | null }>({ key, book: null, candle: null, context: null, status: null });
  useEffect(() => {
    let disposed = false, refreshQueued = false;
    const stream = new HyperliquidMarketStream(environment);
    const update = (patch: Partial<typeof live>) => { if (!disposed) setLive((old) => ({ key, book: old.key === key ? old.book : null, candle: old.key === key ? old.candle : null, context: old.key === key ? old.context : null, status: old.key === key ? old.status : null, ...patch })); };
    const refresh = () => { if (disposed || refreshQueued) return; refreshQueued = true; queueMicrotask(() => { refreshQueued = false; if (!disposed) reconcile(); }); };
    const unsubscribe = [
      stream.onStatus((status) => update({ status, ...(status.state === "connected" ? {} : { book: null, candle: null, context: null }) })),
      stream.subscribe({ type: "l2Book", coin }, (event) => { try { update({ book: parseBook(event.data, coin) }); } catch { refresh(); } }, refresh),
      stream.subscribe({ type: "candle", coin, interval: interval as CandleInterval }, (event) => {
        const raw = Array.isArray(event.data) ? event.data.at(-1) : event.data;
        if (!raw || typeof raw !== "object") return;
        const candle = raw as Candle;
        if (candle.s !== coin || candle.i !== interval || !Number.isSafeInteger(candle.t) || [candle.o, candle.h, candle.l, candle.c, candle.v].some((value) => typeof value !== "string" || numeric(value) === null)) return;
        update({ candle });
      }, refresh),
      stream.subscribe({ type: "activeAssetCtx", coin }, (event) => {
        const raw = event.data as { coin?: string; ctx?: MarketContext };
        if (raw?.coin === coin && raw.ctx && [raw.ctx.markPx, raw.ctx.oraclePx, raw.ctx.funding, raw.ctx.openInterest, raw.ctx.dayNtlVlm, raw.ctx.prevDayPx].every((value) => typeof value === "string" && numeric(value) !== null)) update({ context: raw.ctx });
      }, refresh),
    ];
    return () => { disposed = true; for (const stop of unsubscribe) stop(); stream.close(); };
  }, [key]);
  return live.key === key ? live : { key, book: null, candle: null, context: null, status: null };
}

export type ReviewPrompt = { id: string; review: Record<string, unknown>; finish: (approved: boolean) => void };
let prompts: ReviewPrompt[] = [];
const listeners = new Set<() => void>();
const emit = () => { prompts = [...prompts]; for (const listener of listeners) listener(); };
export const useReviews = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => prompts);
function queueReview(args: JsonObject, context: MsgBusToolContext, owner: boolean): Promise<JsonObject> {
  context.signal?.throwIfAborted();
  const caller = requireEvmWalletCaller(context);
  if (context.agentMode || caller.appId !== "hyperliquid") throw new Error("Hyperliquid owner review requires the authenticated Hyperliquid app.");
  if (owner ? context.caller?.role !== "background" || context.caller?.endpoint !== "app:hyperliquid:background" : context.audience !== "foreground_tile") throw new Error("Hyperliquid review requires its authenticated resident service or Kernel foreground attestation.");
  const review: unknown = JSON.parse(String(args.reviewJson));
  if (!review || typeof review !== "object" || Array.isArray(review)) throw new Error("The prepared review is invalid.");
  return new Promise((resolve, reject) => {
    let settled = false;
    const remove = () => { prompts = prompts.filter((candidate) => candidate !== prompt); context.signal?.removeEventListener("abort", abort); emit(); };
    const prompt: ReviewPrompt = { id: operationId(), review: review as Record<string, unknown>, finish: (approved) => { if (settled) return; settled = true; remove(); resolve({ approved }); } };
    const abort = () => { if (settled) return; settled = true; remove(); reject(context.signal?.reason ?? new Error("Hyperliquid review cancelled.")); };
    context.signal?.addEventListener("abort", abort, { once: true });
    prompts.push(prompt); emit();
    if (context.signal?.aborted) abort();
  });
}
for (const owner of [false, true]) exposeTool(owner ? "hl_owner_review_v1" : "hl_review_v1", {
  title: "Review Hyperliquid action",
  description: "Review the exact prepared Hyperliquid action in the owner's tile. Only the authenticated Hyperliquid service can request this presentation.",
  inputSchema: { type: "object", properties: { reviewJson: { type: "string" } }, required: ["reviewJson"], additionalProperties: false },
  outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false },
  annotations: { "neutron:effects": ["read", "user_visible_ui"], "neutron:visibility": "same_app", ...(owner ? {} : { "neutron:audience": "foreground_tile" }) },
}, (args, context) => queueReview(args, context, owner));
