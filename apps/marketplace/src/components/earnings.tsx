import { useState } from "react";
import type { Earnings, MarketplaceClient, OperationResult, PaymentToken, WithdrawalQuote } from "../view-types.ts";
import { CycleCost, EmptyState, ErrorNote, Icon, Loading, Modal, Principal, decimalAmount, errorMessage, parseAmount, quantity, useRead } from "./primitives.tsx";

export function EarningsPanel({ client, connected, connect, refresh, onOperation }: {
  client: MarketplaceClient; connected: boolean; connect: () => void; refresh: number;
  onOperation: (result: OperationResult, resume?: () => Promise<OperationResult>) => void;
}) {
  const [revision, setRevision] = useState(0), [error, setError] = useState(""), [busy, setBusy] = useState(false), [copied, setCopied] = useState(false);
  const [token, setToken] = useState<PaymentToken | null>(null);
  const read = useRead(connected ? "earnings" : null, () => client.earnings(), refresh + revision);
  const earnings = read.data;
  if (!connected) return <EmptyState title="Your work. Your earnings." icon="earnings" action={<button type="button" className="mp-primary" onClick={connect}>Connect this Neutron</button>}>See publisher and affiliate earnings, share your code, and withdraw to your account.</EmptyState>;
  async function getCode() {
    setBusy(true); setError("");
    try { await client.createReferralCode(); setRevision((v) => v + 1); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="mp-stack"><div className="mp-section-title"><div><h2>Earnings</h2><p>Publisher and affiliate income, ready to withdraw.</p></div></div><ErrorNote error={read.error || error} retry={() => setRevision((v) => v + 1)} />{read.loading && !earnings && <Loading label="Loading earnings…" />}{earnings && <>
    <section className="mp-referral-card"><span className="mp-eyebrow">SHARE SOMETHING GOOD</span><h3>Give {earnings.affiliateDiscountBps / 100}% off. Earn {earnings.affiliateShareBps / 100}%.</h3><p>Your code works across the marketplace. You earn a share of the amount paid when another Neutron uses it.</p>{earnings.referralCode ? <div className="mp-code-row"><code>{earnings.referralCode}</code><button className="mp-secondary" type="button" onClick={() => { void navigator.clipboard.writeText(earnings.referralCode!).then(() => { setCopied(true); }, (cause) => setError(errorMessage(cause))); }}><Icon name="copy" />{copied ? "Copied" : "Copy"}</button></div> : <button className="mp-primary" disabled={busy} onClick={() => void getCode()} type="button">{busy ? "Creating…" : "Get my affiliate code"}</button>}<small>Codes apply to one checkout. Self-referrals are not eligible.</small></section>
    <div className="mp-balance-grid">{earnings.balances.map((balance) => <section className="mp-balance-card" key={balance.token}><div className="mp-section-title"><h3>{balance.token}</h3><span className="mp-badge">Available</span></div><strong className="mp-balance-value">{quantity(balance.available)}</strong><dl className="mp-facts"><div><dt>Reserved for withdrawals</dt><dd>{quantity(balance.reserved)}</dd></div>{balance.earned && <div><dt>Total earned</dt><dd>{quantity(balance.earned)}</dd></div>}</dl><button className="mp-secondary" type="button" disabled={BigInt(balance.available.atoms) === 0n} onClick={() => setToken(balance.token)}>Withdraw <Icon name="arrow" /></button></section>)}</div>
  </>}{token && earnings && <WithdrawDialog client={client} token={token} earnings={earnings} close={() => setToken(null)} onOperation={(result, resume) => { onOperation(result, resume); setRevision((v) => v + 1); }} />}</div>;
}

function WithdrawDialog({ client, token, earnings, close, onOperation }: {
  client: MarketplaceClient; token: PaymentToken; earnings: Earnings; close: () => void;
  onOperation: (result: OperationResult, resume?: () => Promise<OperationResult>) => void;
}) {
  const balance = earnings.balances.find((item) => item.token === token)!;
  const [amount, setAmount] = useState(""), [destination, setDestination] = useState("");
  const [quote, setQuote] = useState<WithdrawalQuote | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function review() {
    setBusy(true); setError("");
    try {
      const atoms = parseAmount(amount, balance.available.decimals);
      if (BigInt(atoms) > BigInt(balance.available.atoms)) throw new Error("The amount exceeds your available earnings.");
      setQuote(await client.quoteWithdrawal({ token, amountAtoms: atoms, destination: destination.trim() }));
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  async function submit() {
    if (!quote || busy) return;
    setBusy(true); setError("");
    try {
      const result = await client.withdraw(quote);
      onOperation(result, () => client.resumeOperation(quote.operationId));
      if (result.state === "complete" || result.state === "pending" || result.nextAction === "review") close();
      else { setError(result.message); }
    } catch (cause) {
      setError(errorMessage(cause));
      onOperation({ operationId: quote.operationId, state: "pending", message: "Withdrawal reply interrupted. Check this request’s status before continuing.", nextAction: "resume" }, () => client.resumeOperation(quote.operationId));
    } finally { setBusy(false); }
  }
  return <Modal title={`Withdraw ${token}`} close={close} footer={<button className="mp-primary" disabled={busy || !destination.trim()} onClick={() => void (quote ? submit() : review())} type="button">{busy ? "Working…" : quote ? "Confirm withdrawal" : "Review withdrawal"}</button>}><div className="mp-stack"><label>Amount<div className="mp-input-action"><input inputMode="decimal" value={amount} disabled={busy} onChange={(event) => { setAmount(event.target.value); setQuote(null); }} placeholder="0.00" /><button type="button" disabled={busy} onClick={() => { setAmount(decimalAmount(balance.available)); setQuote(null); }}>Max</button></div><small className="mp-muted">Available {quantity(balance.available)}. The transfer fee is deducted from this amount.</small></label><label>Receiving principal<input value={destination} disabled={busy} onChange={(event) => { setDestination(event.target.value); setQuote(null); }} placeholder="Principal ID" autoComplete="off" /></label><ErrorNote error={error} />{quote && <><dl className="mp-facts"><div><dt>From earnings</dt><dd>{quantity(quote.debit)}</dd></div><div><dt>Transfer fee</dt><dd>{quantity(quote.fee)}</dd></div><div className="mp-total"><dt>You receive</dt><dd>{quantity(quote.receive)}</dd></div></dl><div className="mp-destination"><span className="mp-muted">Recipient</span><Principal value={quote.destination} /></div><CycleCost value={quote.cycles} />{quote.warnings.map((warning, i) => <p key={i} className="mp-notice">{warning}</p>)}</>}</div></Modal>;
}
