import { useEffect, useState } from "react";
import type { AppListing, MarketplaceClient, OperationResult, PaymentToken, PurchaseQuote } from "../view-types.ts";
import { AppIcon, CycleCost, ErrorNote, Modal, Principal, dateLabel, errorMessage, quantity, usd } from "./primitives.tsx";

export function Checkout({ client, apps, close, complete, pending }: {
  client: MarketplaceClient; apps: AppListing[]; close: () => void;
  complete: (result: OperationResult) => void; pending: (result: OperationResult, resume: () => Promise<OperationResult>) => void;
}) {
  const [token, setToken] = useState<PaymentToken>("ckUSDC");
  const [code, setCode] = useState("");
  const [quote, setQuote] = useState<PurchaseQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isFree = quote ? BigInt(quote.payment.atoms) === 0n : apps.every((app) => BigInt(app.priceUsdMicros) === 0n);
  const displayedApps = quote?.items ?? apps;
  // A quote belongs to precisely these controls. Editing terms always requires
  // another query/review, while a dispatched operation retains its original ID.
  useEffect(() => { setQuote(null); }, [token, code]);
  async function review() {
    setBusy(true); setError("");
    try { setQuote(await client.quotePurchase({ appIds: apps.map((app) => app.id), token, affiliateCode: code.trim() })); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function buy() {
    if (!quote || busy) return;
    setBusy(true); setError("");
    try {
      const result = await client.purchase(quote);
      if (result.state === "complete") { complete(result); close(); }
      else if (result.nextAction === "resume" || result.nextAction === "review" || result.state === "pending" || result.state === "approval_required") {
        pending(result, () => client.resumeOperation(quote.operationId)); close();
      } else { setError(result.message); }
    } catch (cause) {
      // The client owns the durable request. Do not clear the reviewed quote or
      // manufacture another operation after a response is interrupted.
      setError(errorMessage(cause));
      pending({ operationId: quote.operationId, state: "pending", message: "The reply was interrupted. Check this purchase's status before continuing.", nextAction: "resume", appIds: quote.appIds }, () => client.resumeOperation(quote.operationId));
    } finally { setBusy(false); }
  }
  return <Modal title={isFree ? "Add to My Apps" : "Review purchase"} close={close} footer={<><span className="mp-muted mp-footer-note">{busy ? "You can close this dialog; progress is retained." : "Yours on this Neutron, including future approved updates."}</span><button className="mp-primary" disabled={busy} onClick={() => void (quote ? buy() : review())} type="button">{busy ? "Working…" : !quote ? "Review costs" : BigInt(quote.payment.atoms) === 0n ? "Add to My Apps" : `Buy · ${quantity(quote.payment)}`}</button></>}>
    <div className="mp-checkout-items">{displayedApps.map((app) => <div className="mp-checkout-item" key={app.id}><AppIcon app={app} /><div><strong>{app.title}</strong><p className="mp-muted">{apps.some(root => root.id === app.id) ? app.category : "Required app"}</p></div><span>{usd(app.priceUsdMicros)}</span></div>)}</div>
    {!isFree && <div className="mp-form-grid"><label>Pay with<select value={token} onChange={(event) => setToken(event.target.value as PaymentToken)} disabled={busy}><option>ckUSDC</option><option>ICP</option><option>ckBTC</option></select></label><label>Affiliate code <span className="mp-muted">Optional</span><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Enter a code" autoComplete="off" disabled={busy} /></label></div>}
    <ErrorNote error={error} />
    {quote && <PurchaseQuoteView quote={quote} />}
  </Modal>;
}

export function PurchaseQuoteView({ quote }: { quote: PurchaseQuote }) {
  return <div className="mp-stack">
      <dl className="mp-facts mp-total-facts"><div><dt>App {quote.items.length === 1 ? "price" : "prices"}</dt><dd>{usd(quote.subtotalUsdMicros)}</dd></div>{BigInt(quote.discountUsdMicros) > 0n && <div><dt>Affiliate discount</dt><dd className="mp-positive">−{usd(quote.discountUsdMicros)}</dd></div>}<div className="mp-total"><dt>You pay for apps</dt><dd>{quantity(quote.payment)}</dd></div><div><dt>Wallet approval fee</dt><dd>{quantity(quote.approvalFee)}</dd></div><div><dt>Payment collection fee</dt><dd>{quantity(quote.collectionFee)}</dd></div><div className="mp-total"><dt>Total wallet debit</dt><dd>{quantity(quote.totalDebit)}</dd></div></dl>
      {quote.allocations.length > 0 && <section className="mp-allocation"><h3>Where your payment goes</h3>{quote.allocations.map((item, index) => <div className="mp-allocation-row" key={`${item.kind}-${index}`}><div><strong>{item.kind === "burn" ? "Burning NTN" : item.kind === "affiliate" ? "Affiliate" : "Developer"}{item.label && item.kind !== "burn" ? ` · ${item.label}` : ""}</strong>{item.principal ? <Principal value={item.principal} /> : item.kind === "burn" && <small>Allocated for the burn service</small>}</div><span>{quantity(item.amount)}</span></div>)}<p className="mp-muted">Shares are calculated from the discounted app payment. Network and processing fees are separate.</p></section>}
      {quote.priceObservedAt && <p className="mp-muted" title={quote.priceObservedAt}>Token price updated {dateLabel(quote.priceObservedAt)}</p>}
      <CycleCost value={quote.cycles} />
      {quote.warnings.map((warning, i) => <p key={i} className="mp-notice">{warning}</p>)}
    </div>;
}
