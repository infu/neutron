import { useEffect, useRef, useState } from "react";
import type { DiscountPreference, MarketplaceClient } from "../view-types.ts";
import { ErrorNote, Icon, Modal, errorMessage, usd } from "./primitives.tsx";

export const noDiscount: DiscountPreference = { code: null, active: false, discountBps: 0, affiliate: null, error: null };
export function discountPercent(bps: number): string { return `${bps / 100}%`; }

/** Matches protocol pricing: subtract the rounded-down discount, retaining
 * exact micro-dollar amounts instead of rounding a buyer's price to cents. */
export function discountedPrice(micros: string, discount: DiscountPreference | null): string {
  const price = BigInt(micros);
  if (!discount?.active) return micros;
  return (price - price * BigInt(discount.discountBps) / 10_000n).toString();
}

export function AppPrice({ micros, discount, discountedMicros }: { micros: string; discount?: DiscountPreference | null; discountedMicros?: string }) {
  const price = discountedMicros ?? discountedPrice(micros, discount ?? null);
  const reduced = BigInt(price) < BigInt(micros);
  return <span className={`mp-price${reduced ? " is-discounted" : ""}`}>{reduced && <del><span className="mp-sr-only">Original price </span>{usd(micros)}</del>}<span>{reduced && <span className="mp-sr-only">Discounted price </span>}{usd(price)}</span></span>;
}

export function DiscountCodeDialog({ client, discount, close, changed }: {
  client: MarketplaceClient; discount: DiscountPreference; close: () => void; changed: (value: DiscountPreference) => void;
}) {
  const [code, setCode] = useState(discount.code ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState(discount.error ?? ""), [removed, setRemoved] = useState(false);
  const pending = useRef(false), mounted = useRef(true), edited = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!edited.current && !pending.current) { setCode(discount.code ?? ""); setError(discount.error ?? ""); }
  }, [discount.code, discount.error]);
  // A request may finish after dismissal; the preference belongs to the app,
  // so its successful result still reaches the parent.
  const dirty = code.trim().toUpperCase() !== (discount.code ?? "");
  const finished = (discount.active && !dirty) || (removed && !code.trim());
  async function save(input: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await client.setDiscountCode(input);
      edited.current = false;
      changed(result);
      if (mounted.current) { setCode(result.code ?? ""); setRemoved(!result.code); }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <Modal title="Discount code" close={close} footer={<>{discount.code && <button type="button" className="mp-text-button" disabled={busy} onClick={() => void save("")}>Remove code</button>}<button type="button" className="mp-primary" disabled={busy || (!code.trim() && !finished)} onClick={() => void (finished ? close() : save(code))}>{busy ? "Activating…" : finished ? "Done" : discount.code ? "Update discount" : "Activate discount"}</button></>}>
    <div className="mp-discount-form">
      {discount.active && !dirty ? <div className="mp-discount-success" role="status"><span><Icon name="check" /></span><div><h3>{discountPercent(discount.discountBps)} discount activated!</h3><p>Applied automatically to your future purchases.</p></div></div> : <div className="mp-discount-intro"><span><Icon name="discount" /></span><h3>A little off every app.</h3></div>}
      <label>Discount code<input value={code} onChange={event => { edited.current = true; setCode(event.target.value); setError(""); setRemoved(false); }} placeholder="Enter your code" autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy} onKeyDown={event => { if (event.key === "Enter" && code.trim() && !busy) { event.preventDefault(); void save(code); } }} /></label>
      <p className="mp-muted">This is also an affiliate code: the person who shared it receives part of the app payment. It is saved for this Neutron. You can change or remove it anytime.</p>
      <ErrorNote error={error} />
      {removed && <p className="mp-muted" role="status">Discount code removed.</p>}
    </div>
  </Modal>;
}
