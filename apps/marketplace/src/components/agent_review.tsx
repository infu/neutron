import { useEffect, useState } from "react";
import { exposeTool, removeExposedTool } from "neutron-tools/app";
import type { CycleEstimate, InstallationQuote, PurchaseQuote, WithdrawalQuote } from "../view-types.ts";
import { PurchaseQuoteView } from "./checkout.tsx";
import { AppIcon, CycleCost, Modal, Principal, quantity, usd } from "./primitives.tsx";

type EthereumInvoiceReview = { kind: "ethereum_cancel" | "ethereum_settle"; operationId: string; quote: PurchaseQuote; cycles: CycleEstimate }
  | { kind: "ethereum_verify"; operationId: string; transactionHash: string; quote: PurchaseQuote; cycles: CycleEstimate };
type Review = { kind: "purchase"; quote: PurchaseQuote } | { kind: "withdrawal"; quote: WithdrawalQuote } | { kind: "installation"; quote: InstallationQuote } | EthereumInvoiceReview;
type Prompt = { id: number; owner: boolean; review: Review; finish: (approved: boolean) => void };
function isInvoiceReview(review: Review): review is EthereumInvoiceReview {
  return review.kind === "ethereum_cancel" || review.kind === "ethereum_settle" || review.kind === "ethereum_verify";
}
function validateCycleCost(cost: CycleEstimate) {
  BigInt(cost.total); BigInt(cost.processing);
  if (cost.storage) BigInt(cost.storage);
}

/** Kernel-attested foreground or authenticated resident presentation requests approval.
 * This surface displays exact terms; it never dispatches a financial operation. */
export function AgentReviewHost() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  useEffect(() => {
    const pending = new Set<Prompt>(); let sequence = 0;
    for (const owner of [false, true]) exposeTool(owner ? "marketplace_owner_review_v1" : "marketplace_review_v1", {
      title: "Review marketplace action",
      description: "Owner review of exact marketplace purchase, installation, earnings withdrawal or payment recovery terms, presented by the Kernel.",
      inputSchema: { type: "object", properties: { reviewJson: { type: "string" } }, required: ["reviewJson"], additionalProperties: false },
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false },
      annotations: { "neutron:effects": ["read", "user_visible_ui"], "neutron:visibility": "same_app", ...(owner ? {} : { "neutron:audience": "foreground_tile" }) },
    }, (args, context) => {
      context.signal?.throwIfAborted();
      const authenticOwner = context.caller?.appId === "marketplace" && context.caller.role === "background" && context.caller.endpoint === "app:marketplace:background";
      if (context.agentMode || (owner ? !authenticOwner : context.audience !== "foreground_tile")) throw new Error("Marketplace review requires its authenticated resident or Kernel-attested foreground presentation.");
      const review: Review = JSON.parse(String(args.reviewJson));
      if (!review || !["purchase", "withdrawal", "installation", "ethereum_cancel", "ethereum_settle", "ethereum_verify"].includes(review.kind) || !review.quote || typeof review.quote.operationId !== "string") throw new Error("The marketplace action review is invalid.");
      if (isInvoiceReview(review)) {
        if (review.operationId !== review.quote.operationId || !review.quote.ethereum) throw new Error("The Ethereum action names a different original invoice.");
        if (review.kind === "ethereum_verify" && (typeof review.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(review.transactionHash))) throw new Error("The original Ethereum transaction hash is invalid.");
        validateCycleCost(review.cycles);
      }
      // Verify display-critical exact numbers before mounting so malformed
      // provider input rejects the request rather than crashing the tile.
      if (review.kind === "installation") {
        if (!Array.isArray(review.quote.appIds) || !review.quote.appIds.length || review.quote.appIds.some((id) => typeof id !== "string" || !id)) throw new Error("The installation review has no valid app selection.");
        if (typeof review.quote.canisterId !== "string" || !review.quote.canisterId || typeof review.quote.owner !== "string" || !review.quote.owner) throw new Error("The installation review has an invalid marketplace or Neutron.");
        if (BigInt(review.quote.fee.totalCycles) !== BigInt(review.quote.cycles.total)) throw new Error("The installation review has inconsistent cycle costs.");
      } else if (review.kind !== "withdrawal") {
        usd(review.quote.subtotalUsdMicros); usd(review.quote.discountUsdMicros);
        [review.quote.payment, review.quote.totalDebit, ...review.quote.allocations.map((item) => item.amount)].forEach(quantity);
        const ethereum = review.quote.ethereum;
        if (ethereum) {
          if (ethereum.chainId !== "1" || !["evm_wallet", "browser"].includes(ethereum.wallet) || typeof ethereum.recipientPrincipal !== "string" || !ethereum.recipientPrincipal) throw new Error("The Ethereum payment review has an invalid route.");
          for (const address of [ethereum.payerAddress, ethereum.tokenAddress]) if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("The Ethereum payment review has an invalid address.");
          for (const address of [ethereum.helperAddress, ethereum.minterAddress]) if (address !== undefined && (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address))) throw new Error("The Ethereum payment review has an invalid address.");
          quantity(ethereum.wrappingFee);
          for (const cost of [ethereum.prepareCycles, ethereum.verifyCycles]) validateCycleCost(cost);
        } else [review.quote.approvalFee, review.quote.collectionFee].forEach(quantity);
        review.quote.items.forEach((item) => usd(item.priceUsdMicros));
      } else [review.quote.debit, review.quote.fee, review.quote.receive].forEach(quantity);
      validateCycleCost(review.quote.cycles);
      return new Promise((resolve, reject) => {
        let settled = false;
        const remove = () => { pending.delete(prompt); context.signal?.removeEventListener("abort", abort); setPrompts((old) => old.filter((item) => item !== prompt)); };
        const prompt: Prompt = { id: ++sequence, owner, review, finish: (approved) => { if (settled) return; settled = true; remove(); resolve({ approved }); } };
        const abort = () => { if (settled) return; settled = true; remove(); reject(context.signal?.reason ?? new Error("The marketplace review was canceled.")); };
        pending.add(prompt); setPrompts((old) => [...old, prompt]);
        context.signal?.addEventListener("abort", abort, { once: true });
        if (context.signal?.aborted) abort();
      });
    });
    return () => { removeExposedTool("marketplace_review_v1"); removeExposedTool("marketplace_owner_review_v1"); for (const prompt of pending) prompt.finish(false); };
  }, []);
  const prompt = prompts[0]; if (!prompt) return null;
  const review = prompt.review;
  const title = review.kind === "ethereum_verify" ? "Verify original payment" : review.kind === "ethereum_cancel" ? "Cancel checkout" : review.kind === "ethereum_settle" ? "Collect converted payment" : prompt.owner ? `Review updated ${review.kind} costs` : review.kind === "installation" ? "Agent installation request" : review.kind === "purchase" ? "Agent purchase request" : "Agent withdrawal request";
  const action = review.kind === "ethereum_verify" ? "Verify payment" : review.kind === "ethereum_cancel" ? "Cancel checkout" : review.kind === "ethereum_settle" ? "Collect payment" : review.kind === "installation" ? "Install apps" : review.kind === "purchase" ? "Approve purchase" : "Approve withdrawal";
  return <Modal key={prompt.id} title={title} close={() => prompt.finish(false)} footer={<><button type="button" className="mp-secondary" onClick={() => prompt.finish(false)}>Decline</button><button type="button" className="mp-primary" onClick={() => prompt.finish(true)}>{action}</button></>}>
    {review.kind === "installation" ? <div className="mp-stack">
      <section><h3>Apps to install</h3><ul>{review.quote.appIds.map((id, index) => <li key={`${id}-${index}`}><code>{id}</code></li>)}</ul></section>
      <div className="mp-destination"><span className="mp-muted">Marketplace</span><Principal value={review.quote.canisterId} /></div>
      <div className="mp-destination"><span className="mp-muted">Your Neutron</span><Principal value={review.quote.owner} /></div>
      <CycleCost value={review.quote.cycles} />
      <p className="mp-muted">This covers marketplace installation preparation. The Kernel will review app permissions and its installation costs separately.</p>
    </div> : isInvoiceReview(review) ? <div className="mp-stack">
      <p className="mp-notice">{review.kind === "ethereum_verify" ? "Check this Ethereum transaction against the original invoice and ask the protocol to verify it independently. This does not send another Ethereum payment." : review.kind === "ethereum_cancel" ? "Cancel this checkout. This cannot stop an Ethereum payment already sent; a late payment remains recoverable as ckUSDC credit. It does not refund a completed app purchase or send another Ethereum payment." : "Collect the converted ckUSDC assigned to this invoice. This finalizes protocol accounting without another Ethereum payment or another app purchase."}</p>
      <div className="mp-destination"><span className="mp-muted">Marketplace</span><Principal value={review.quote.ethereum!.recipientPrincipal} /></div>
      {review.kind === "ethereum_verify" && <div className="mp-destination"><span className="mp-muted">Ethereum transaction</span><Principal value={review.transactionHash} /></div>}
      <CycleCost value={review.cycles} />
    </div> : review.kind === "purchase" ? <><div className="mp-checkout-items">{review.quote.items.map((app) => <div className="mp-checkout-item" key={app.id}><AppIcon app={app} /><div><strong>{app.title}</strong><p className="mp-muted">{review.quote.appIds.includes(app.id) ? app.category : "Required app"}</p></div><span>{usd(app.priceUsdMicros)}</span></div>)}</div><PurchaseQuoteView quote={review.quote} /></> : <div className="mp-stack"><dl className="mp-facts"><div><dt>From earnings</dt><dd>{quantity(review.quote.debit)}</dd></div><div><dt>Transfer fee</dt><dd>{quantity(review.quote.fee)}</dd></div><div className="mp-total"><dt>You receive</dt><dd>{quantity(review.quote.receive)}</dd></div></dl><div className="mp-destination"><span className="mp-muted">Recipient</span><Principal value={review.quote.destination} /></div><CycleCost value={review.quote.cycles} />{review.quote.warnings.map((warning, i) => <p key={i} className="mp-notice">{warning}</p>)}</div>}
    <details className="mp-review-request"><summary>Saved request</summary><code className="mp-hash">{review.quote.operationId}</code></details>
  </Modal>;
}
