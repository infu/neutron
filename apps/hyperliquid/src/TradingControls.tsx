import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Environment, OpenOrder, Position } from "./market.ts";
import type { OrderCapacity } from "./sizing.ts";

type Controls = {
  environment: Environment;
  close: () => void;
  execute: (tool: string, args: object) => Promise<void>;
  busy: boolean;
};

/** Canonicalize input as text so the submitted amount never passes through a float. */
function decimal(value: string): string | null {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
  const [whole = "", fraction = ""] = text.split(".");
  const normalizedWhole = whole.replace(/^0+/, "") || "0";
  return fraction ? `${normalizedWhole}.${fraction}` : normalizedWhole;
}
function positive(value: string): string | null {
  const result = decimal(value);
  return result !== null && /[1-9]/.test(result) ? result : null;
}
function atMost(left: string, right: string): boolean {
  const [lw = "0", lf = ""] = left.split("."), [rw = "0", rf = ""] = right.split(".");
  const scale = Math.max(lf.length, rf.length);
  return BigInt(lw + lf.padEnd(scale, "0")) <= BigInt(rw + rf.padEnd(scale, "0"));
}
function Dialog({ title, subtitle, close, children, footer }: { title: string; subtitle: string; close: () => void; children: ReactNode; footer: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="hl-dialog" aria-label={title} onCancel={close} onClose={close}>
    <div className="hl-dialog-layout"><header><div><h2>{title}</h2><p className="hl-muted">{subtitle}</p></div><button type="button" className="hl-icon-button" aria-label="Close dialog" onClick={close}>×</button></header><div className="hl-dialog-content hl-stack">{children}</div><footer>{footer}</footer></div>
  </dialog>;
}
function Actions({ close, submit, disabled, label }: { close: () => void; submit: () => void; disabled: boolean; label: string }) {
  return <div className="hl-button-pair"><button type="button" className="hl-secondary" onClick={close}>Cancel</button><button type="button" className="hl-primary" disabled={disabled} onClick={submit}>{label}</button></div>;
}

export function LeverageDialog({ environment, coin, maxLeverage, onlyIsolated = false, position, settings, close, execute, busy }: Controls & { coin: string; maxLeverage: number; onlyIsolated?: boolean; position?: Position; settings: Pick<OrderCapacity, "leverage" | "marginMode"> | null }) {
  const [leverage, setLeverage] = useState(String(settings?.leverage ?? position?.leverage.value ?? ""));
  const [marginMode, setMarginMode] = useState<"cross" | "isolated" | "">(onlyIsolated ? "isolated" : settings?.marginMode ?? position?.leverage.type ?? "");
  const isCross = marginMode === "cross";
  const value = Number(leverage), valid = /^\d+$/.test(leverage) && Number.isSafeInteger(value) && value >= 1 && value <= maxLeverage && marginMode !== "";
  return <Dialog title={`${coin} leverage & margin`} subtitle={`${environment === "mainnet" ? "Mainnet" : "Testnet"} perpetual`} close={close} footer={<Actions close={close} disabled={busy || !valid} label="Review leverage" submit={() => { if (!valid) return; close(); void execute("hl_leverage_v1", { environment, coin, leverage: value, isCross }); }} />}>
    <label>Leverage<div className="hl-input-unit"><input aria-label="Leverage" inputMode="numeric" autoComplete="off" value={leverage} onChange={(event) => setLeverage(event.target.value)} disabled={busy} autoFocus /><span>×</span></div></label>
    <p className="hl-help">This market supports 1–{maxLeverage}× leverage. Position size and margin tiers can lower the available maximum.</p>
    <label>Margin mode<select aria-label="Margin mode" value={marginMode} onChange={(event) => setMarginMode(event.target.value as "cross" | "isolated")} disabled={busy || onlyIsolated}><option value="" disabled>Select margin mode</option><option value="cross" disabled={onlyIsolated}>Cross</option><option value="isolated">Isolated</option></select></label>
    {onlyIsolated && <p className="hl-notice">This market supports isolated margin only.</p>}
    {marginMode && <p className="hl-muted">{isCross ? "Cross margin shares available collateral with your other cross positions. Losses can put that collateral at risk." : "Isolated margin assigns collateral to this position. Its liquidation exposure depends on the margin allocated to it."}</p>}
    <p className="hl-notice">Higher leverage leaves less room for adverse price moves. Changing leverage or margin mode can change an existing position's liquidation exposure; it does not place an order.</p>
  </Dialog>;
}

export function ModifyOrderDialog({ environment, order, close, execute, busy }: Controls & { order: OpenOrder }) {
  const [size, setSize] = useState(order.sz), [price, setPrice] = useState(order.limitPx);
  const [postOnly, setPostOnly] = useState(false), [reduceOnly, setReduceOnly] = useState(order.reduceOnly);
  const amount = positive(size), limitPrice = positive(price), valid = amount !== null && limitPrice !== null && !order.isTrigger;
  return <Dialog title={`Edit ${order.coin} limit order`} subtitle={`${order.side === "B" ? "Buy" : "Sell"} · Order ${order.oid}`} close={close} footer={<Actions close={close} disabled={busy || !valid} label="Review replacement" submit={() => { if (!valid) return; close(); void execute("hl_modify_order_v1", { environment, coin: order.coin, oid: order.oid, side: order.side === "B" ? "buy" : "sell", size: amount, price: limitPrice, postOnly, reduceOnly }); }} />}>
    <label>Remaining order size<div className="hl-input-unit"><input aria-label="Remaining order size" inputMode="decimal" autoComplete="off" value={size} onChange={(event) => setSize(event.target.value)} disabled={busy} autoFocus /><span>{order.coin}</span></div></label>
    <label>Limit price<div className="hl-input-unit"><input aria-label="Replacement limit price" inputMode="decimal" autoComplete="off" value={price} onChange={(event) => setPrice(event.target.value)} disabled={busy} /><span>USD</span></div></label>
    <div className="hl-checkbox-row"><label><input type="checkbox" checked={postOnly} onChange={(event) => setPostOnly(event.target.checked)} disabled={busy} />Post only</label><label><input type="checkbox" checked={reduceOnly} onChange={(event) => setReduceOnly(event.target.checked)} disabled={busy} />Reduce only</label></div>
    <p className="hl-muted">The submitted size is the replacement order's remaining quantity. Your current order may fill before Hyperliquid processes the change.</p>
    <p className="hl-help">{postOnly ? "Post-only rejects a replacement that would execute immediately." : "This replacement can execute immediately at your limit price or better. It can also be placed if canceling the original order fails."}{reduceOnly ? " Reduce-only prevents the order from increasing or reversing your position." : " This order can increase or reverse a position."}</p>
    {order.isTrigger && <p className="hl-error" role="alert">Trigger orders cannot be edited with this limit-order form. Cancel the trigger and create a new protection order.</p>}
  </Dialog>;
}

export function ProtectPositionDialog({ environment, position, close, execute, busy }: Controls & { position: Position }) {
  const [triggerKind, setTriggerKind] = useState<"tp" | "sl">("sl"), [execution, setExecution] = useState<"market" | "limit">("market");
  const maximum = position.szi.replace(/^-/, ""), [size, setSize] = useState(maximum), [triggerPrice, setTriggerPrice] = useState(""), [price, setPrice] = useState(""), [slippage, setSlippage] = useState("50");
  const amount = positive(size), trigger = positive(triggerPrice), limitPrice = positive(price), slippageValue = decimal(slippage);
  const validSlippage = slippageValue !== null && !atMost("10000", slippageValue) && Number(slippageValue) < 10000;
  const valid = amount !== null && atMost(amount, maximum) && trigger !== null && (execution === "market" ? validSlippage : limitPrice !== null);
  return <Dialog title={`Protect ${position.coin} position`} subtitle={`${position.szi.startsWith("-") ? "Short" : "Long"} · ${maximum} ${position.coin}`} close={close} footer={<Actions close={close} disabled={busy || !valid} label="Review protection order" submit={() => { if (!valid) return; close(); void execute("hl_protect_position_v1", { environment, coin: position.coin, side: position.szi.startsWith("-") ? "buy" : "sell", size: amount, triggerPrice: trigger, triggerKind, execution, ...(execution === "limit" ? { price: limitPrice } : { slippageBps: Number(slippageValue) }) }); }} />}>
    <div className="hl-segmented" aria-label="Protection type"><button type="button" aria-pressed={triggerKind === "sl"} onClick={() => setTriggerKind("sl")} disabled={busy}>Stop loss</button><button type="button" aria-pressed={triggerKind === "tp"} onClick={() => setTriggerKind("tp")} disabled={busy}>Take profit</button></div>
    <label>Trigger price<div className="hl-input-unit"><input aria-label="Trigger price" inputMode="decimal" autoComplete="off" placeholder="0" value={triggerPrice} onChange={(event) => setTriggerPrice(event.target.value)} disabled={busy} autoFocus /><span>USD</span></div></label>
    <label>Quantity to protect<div className="hl-input-unit"><input aria-label="Quantity to protect" inputMode="decimal" autoComplete="off" value={size} onChange={(event) => setSize(event.target.value)} disabled={busy} /><span>{position.coin}</span></div></label>
    <label>Execution when triggered<select aria-label="Execution when triggered" value={execution} onChange={(event) => setExecution(event.target.value as "market" | "limit")} disabled={busy}><option value="market">Market</option><option value="limit">Limit</option></select></label>
    {execution === "limit" ? <label>Execution limit price<div className="hl-input-unit"><input aria-label="Protection execution limit price" inputMode="decimal" autoComplete="off" placeholder="0" value={price} onChange={(event) => setPrice(event.target.value)} disabled={busy} /><span>USD</span></div></label> : <label>Maximum slippage<div className="hl-input-unit"><input aria-label="Protection maximum slippage in basis points" inputMode="decimal" autoComplete="off" value={slippage} onChange={(event) => setSlippage(event.target.value)} disabled={busy} /><span>bps</span></div><span className="hl-help">50 basis points = 0.5%.</span></label>}
    <p className="hl-muted">This order only reduces your position. {execution === "market" ? "When triggered, execution is bounded by your slippage setting and can fill partially." : "After triggering, it can remain unfilled if the market moves beyond your execution limit."}</p>
    <p className="hl-notice">Each stop loss or take profit is independent. Adding one does not replace or cancel another protection order. Review your open orders when a position changes.</p>
  </Dialog>;
}

export function IsolatedMarginDialog({ environment, position, close, execute, busy }: Controls & { position: Position }) {
  const [direction, setDirection] = useState<"add" | "remove">("add"), [amount, setAmount] = useState("");
  const amountUsdc = positive(amount), valid = amountUsdc !== null && position.leverage.type === "isolated";
  return <Dialog title={`${position.coin} isolated margin`} subtitle={`${position.szi.startsWith("-") ? "Short" : "Long"} perpetual position`} close={close} footer={<Actions close={close} disabled={busy || !valid} label={direction === "add" ? "Review added margin" : "Review margin removal"} submit={() => { if (!valid) return; close(); void execute("hl_isolated_margin_v1", { environment, coin: position.coin, amountUsdc: `${direction === "remove" ? "-" : ""}${amountUsdc}` }); }} />}>
    <div className="hl-segmented" aria-label="Margin adjustment"><button type="button" aria-pressed={direction === "add"} onClick={() => setDirection("add")} disabled={busy}>Add margin</button><button type="button" aria-pressed={direction === "remove"} onClick={() => setDirection("remove")} disabled={busy}>Remove margin</button></div>
    <dl className="hl-details"><div><dt>Current margin used</dt><dd>{position.marginUsed} USDC</dd></div><div><dt>Current liquidation price</dt><dd>{position.liquidationPx === null ? "Not available" : `${position.liquidationPx} USD`}</dd></div></dl>
    <label>{direction === "add" ? "USDC to add" : "USDC to remove"}<div className="hl-input-unit"><input aria-label={direction === "add" ? "USDC margin to add" : "USDC margin to remove"} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy} autoFocus /><span>USDC</span></div></label>
    <p className={direction === "remove" ? "hl-notice" : "hl-muted"}>{direction === "add" ? "Added collateral gives this isolated position more room before liquidation. Hyperliquid checks your available USDC when the change is submitted." : "Removing margin moves this position closer to liquidation. Hyperliquid determines the removable amount from your current position and margin requirements."}</p>
    {position.leverage.type !== "isolated" && <p className="hl-error" role="alert">This position uses cross margin. Individual margin adjustments are available for isolated positions.</p>}
  </Dialog>;
}
