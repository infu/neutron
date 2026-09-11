import { useEffect, useRef, useState } from "react";
import type { EthereumProviderConnection } from "neutron-tools/app";
import type { AppListing, EthereumWalletSource, MarketplaceClient, OperationResult, PaymentToken, PurchaseQuote, DiscountPreference } from "../view-types.ts";
import { AppPrice, discountPercent, noDiscount } from "./discount.tsx";
import { connectEthereumFundingBrowser } from "../ethereum.ts";
import { AppIcon, CycleCost, ErrorNote, Icon, Modal, Principal, dateLabel, errorMessage, quantity, usd } from "./primitives.tsx";

export function Checkout({ client, apps, discount = noDiscount, close, complete, pending }: {
  client: MarketplaceClient; apps: AppListing[]; discount?: DiscountPreference; close: () => void;
  complete: (result: OperationResult) => void; pending: (result: OperationResult, resume: () => Promise<OperationResult>) => void;
}) {
  const [token, setToken] = useState<PaymentToken>("ckUSDC");
  const [source, setSource] = useState<"ic" | "ethereum">("ic");
  const [wallet, setWallet] = useState<EthereumWalletSource>("evm_wallet");
  const [quoteDiscount, setQuoteDiscount] = useState<DiscountPreference>(noDiscount);
  const [quote, setQuote] = useState<PurchaseQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [knownPaid, setKnownPaid] = useState(false);
  const [dispatched, setDispatched] = useState(false);
  const active = useRef(false), mounted = useRef(true);
  const controlsKey = JSON.stringify([token, source, wallet, discount.code, discount.active, discount.discountBps]);
  const currentControls = useRef(controlsKey); currentControls.current = controlsKey;
  const browser = useRef<EthereumProviderConnection | null>(null);
  const isFree = quote ? BigInt(quote.payment.atoms) === 0n : !knownPaid && apps.every((app) => BigInt(app.priceUsdMicros) === 0n);
  const displayedApps = quote?.items ?? apps;
  const releaseBrowser = () => {
    const connection = browser.current; browser.current = null;
    if (connection) void connection.close().catch(() => undefined);
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (!active.current) releaseBrowser(); };
  }, []);
  // A quote belongs to precisely these controls. Editing terms always requires
  // another query/review, while a dispatched operation retains its original ID.
  useEffect(() => { if (!dispatched) setQuote(null); }, [controlsKey, dispatched]);
  useEffect(() => { if (source !== "ethereum" || wallet !== "browser") releaseBrowser(); }, [source, wallet]);
  async function review() {
    if (active.current || dispatched) return;
    active.current = true;
    const reviewedControls = controlsKey, reviewedDiscount = discount;
    // Start provider access in the tile click's original stack, before any app
    // call. Awaiting quote/configuration first loses the browser user gesture.
    const connection = source === "ethereum" && wallet === "browser"
      ? browser.current ? Promise.resolve(browser.current) : connectEthereumFundingBrowser()
      : null;
    setBusy(true); setError("");
    try {
      let payerAddress: string | undefined;
      if (connection) {
        browser.current = await connection;
        if (!mounted.current) { releaseBrowser(); return; }
        const accounts = await browser.current.provider.request({ method: "eth_accounts" });
        if (!Array.isArray(accounts) || typeof accounts[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(accounts[0])) throw new Error("The browser wallet returned no Ethereum payer. Reconnect it before reviewing.");
        payerAddress = accounts[0];
      }
      if (!mounted.current) return;
      const reviewed = await client.quotePurchase({ appIds: apps.map((app) => app.id), token: source === "ethereum" ? "ckUSDC" : token, ...(source === "ethereum" ? { ethereum: { wallet, ...(payerAddress ? { payerAddress } : {}) } } : {}) });
      if (mounted.current && reviewedControls === currentControls.current) { setQuote(reviewed); setQuoteDiscount(reviewed.affiliateCode === reviewedDiscount.code ? reviewedDiscount : noDiscount); setKnownPaid(BigInt(reviewed.payment.atoms) > 0n); }
    }
    catch (cause) { setError(errorMessage(cause)); }
    finally { active.current = false; setBusy(false); if (!mounted.current) releaseBrowser(); }
  }
  const resume = (original: PurchaseQuote) => async () => {
    if (original.ethereum?.wallet !== "browser") return client.resumeOperation(original.operationId);
    // The parent invokes this directly from Continue's click, preserving the
    // gesture even after the original checkout dialog has been closed.
    const connection = await connectEthereumFundingBrowser();
    try { return await client.resumeOperation(original.operationId, connection); }
    finally { await connection.close().catch(() => undefined); }
  };
  async function buy() {
    if (!quote || active.current) return;
    if (quote.ethereum?.wallet === "browser" && !browser.current && !dispatched) { setError("Connect your browser wallet and review this payment before continuing."); return; }
    active.current = true;
    setBusy(true); setError("");
    try {
      const wasDispatched = dispatched;
      setDispatched(true);
      const result = wasDispatched ? await resume(quote)() : await client.purchase(quote, quote.ethereum?.wallet === "browser" ? browser.current ?? undefined : undefined);
      if (quote.ethereum ? result.entitled === true : result.state === "complete") { complete(result); close(); }
      else if (quote.ethereum && result.state === "complete") {
        pending({ ...result, state: "pending", entitled: false, nextAction: "none", message: "Waiting for the marketplace to verify app access for this original Ethereum payment." }, resume(quote)); close();
      }
      else if (result.canceledBeforeSubmission) { pending(result, resume(quote)); close(); }
      else if (result.nextAction === "resume" || result.nextAction === "review" || result.state === "pending" || result.state === "approval_required") {
        pending(result, resume(quote)); close();
      } else { setError(result.message); }
    } catch (cause) {
      // The client owns the durable request. Do not clear the reviewed quote or
      // manufacture another operation after a response is interrupted.
      setError(errorMessage(cause));
      pending({ operationId: quote.operationId, state: "pending", message: "The reply was interrupted. Check this purchase's status before continuing.", nextAction: "resume", appIds: quote.appIds, ...(quote.ethereum ? { ethereumWallet: quote.ethereum.wallet } : {}) }, resume(quote));
    } finally { active.current = false; setBusy(false); if (!mounted.current) releaseBrowser(); }
  }
  return <Modal title={isFree ? "Add to My Apps" : "Review purchase"} close={close} footer={<><span className="mp-muted mp-footer-note">{busy ? "You can close this dialog; progress is retained." : "Yours on this Neutron, including future approved updates."}</span><button className="mp-primary" disabled={busy} onClick={() => void (quote ? buy() : review())} type="button">{busy ? "Working…" : dispatched ? "Continue original payment" : !quote ? source === "ethereum" && wallet === "browser" && !browser.current ? "Connect wallet & review" : "Review costs" : BigInt(quote.payment.atoms) === 0n ? "Add to My Apps" : `Buy · ${quantity(quote.ethereum ? quote.totalDebit : quote.payment)}`}</button></>}>
    <div className="mp-checkout-items">{displayedApps.map((app) => <div className="mp-checkout-item" key={app.id}><AppIcon app={app} /><div><strong>{app.title}</strong><p className="mp-muted">{apps.some(root => root.id === app.id) ? app.category : "Required app"}</p></div><AppPrice micros={app.priceUsdMicros} discount={quote ? quoteDiscount : discount} /></div>)}</div>
    {!isFree && <div className="mp-form-grid"><label>Pay with<select aria-label="Pay with" value={source === "ethereum" ? "ethereum" : token} onChange={(event) => { if (event.target.value === "ethereum") setSource("ethereum"); else { setSource("ic"); setToken(event.target.value as PaymentToken); } }} disabled={busy || dispatched}><option value="ckUSDC">ckUSDC · IC</option><option value="ICP">ICP · IC</option><option value="ckBTC">ckBTC · IC</option><option value="ethereum">USDC · Ethereum</option></select></label>{source === "ethereum" && <label>Ethereum wallet<select aria-label="Ethereum wallet" value={wallet} onChange={(event) => setWallet(event.target.value as EthereumWalletSource)} disabled={busy || dispatched}><option value="evm_wallet">EVM Wallet</option><option value="browser">MetaMask / browser wallet</option></select></label>}</div>}
    {!isFree && (quote ? quote.affiliateCode : discount.active && discount.code) && <div className="mp-checkout-discount"><Icon name="check" /><div><strong>{quote ? "Discount code activated" : `${discountPercent(discount.discountBps)} discount activated`}</strong><span>{quote ? quote.affiliateCode : discount.code}</span></div></div>}
    {!isFree && !quote && discount.code && !discount.active && <ErrorNote error={discount.error || "Your saved discount is unavailable. Change or remove it before buying."} />}
    <ErrorNote error={error} />
    {quote && <PurchaseQuoteView quote={quote} />}
  </Modal>;
}

export function PurchaseQuoteView({ quote }: { quote: PurchaseQuote }) {
  const ethereum = quote.ethereum;
  return <div className="mp-stack">
      <dl className="mp-facts mp-total-facts"><div><dt>App {quote.items.length === 1 ? "price" : "prices"}</dt><dd><AppPrice micros={quote.subtotalUsdMicros} discountedMicros={(BigInt(quote.subtotalUsdMicros) - BigInt(quote.discountUsdMicros)).toString()} /></dd></div>{BigInt(quote.discountUsdMicros) > 0n && <div><dt>Affiliate discount</dt><dd className="mp-positive">−{usd(quote.discountUsdMicros)}</dd></div>}<div className="mp-total"><dt>You pay for apps</dt><dd>{quantity(quote.payment)}</dd></div>{ethereum ? <><div><dt>ckUSDC collection fee</dt><dd>{quantity(ethereum.wrappingFee)}</dd></div><div className="mp-total"><dt>USDC from Ethereum</dt><dd>{quantity(quote.totalDebit)}</dd></div><div><dt>Ethereum gas</dt><dd>Shown in your wallet</dd></div></> : <><div><dt>Wallet approval fee</dt><dd>{quantity(quote.approvalFee)}</dd></div><div><dt>Payment collection fee</dt><dd>{quantity(quote.collectionFee)}</dd></div><div className="mp-total"><dt>Total wallet debit</dt><dd>{quantity(quote.totalDebit)}</dd></div></>}</dl>
      {ethereum && <section className="mp-stack" aria-label="Ethereum payment route"><div className="mp-destination"><span className="mp-muted">Paying from · {ethereum.wallet === "browser" ? "Browser wallet" : "EVM Wallet"}</span><Principal value={ethereum.payerAddress} /></div>{ethereum.helperAddress && <div className="mp-destination"><span className="mp-muted">Ethereum deposit helper</span><Principal value={ethereum.helperAddress} /></div>}<div className="mp-destination"><span className="mp-muted">Marketplace recipient</span><Principal value={ethereum.recipientPrincipal} /></div><details><summary>Ethereum Mainnet route</summary><div className="mp-destination"><span className="mp-muted">USDC contract</span><Principal value={ethereum.tokenAddress} /></div>{ethereum.minterAddress && <div className="mp-destination"><span className="mp-muted">Minter</span><Principal value={ethereum.minterAddress} /></div>}</details><p className="mp-muted">Your wallet shows gas for the deposit and any required USDC approval. Apps become available after the protocol verifies the confirmed Ethereum deposit; wrapping can finish afterward.</p></section>}
      {quote.allocations.length > 0 && <section className="mp-allocation"><h3>Where your payment goes</h3>{quote.allocations.map((item, index) => <div className="mp-allocation-row" key={`${item.kind}-${index}`}><div><strong>{item.kind === "burn" ? "Burning NTN" : item.kind === "affiliate" ? "Affiliate" : "Developer"}{item.label && item.kind !== "burn" ? ` · ${item.label}` : ""}</strong>{item.principal ? <Principal value={item.principal} /> : item.kind === "burn" && <small>Allocated for the burn service</small>}</div><span>{quantity(item.amount)}</span></div>)}<p className="mp-muted">Shares are calculated from the discounted app payment. Network and processing fees are separate.</p></section>}
      {quote.priceObservedAt && <p className="mp-muted" title={quote.priceObservedAt}>Token price updated {dateLabel(quote.priceObservedAt)}</p>}
      {ethereum ? <section className="mp-stack" aria-label="Neutron cycle costs"><div><h3>Prepare Ethereum payment</h3><CycleCost value={ethereum.prepareCycles} /></div><div><h3>Verify Ethereum payment</h3><CycleCost value={ethereum.verifyCycles} /></div></section> : <CycleCost value={quote.cycles} />}
      {quote.warnings.map((warning, i) => <p key={i} className="mp-notice">{warning}</p>)}
    </div>;
}
