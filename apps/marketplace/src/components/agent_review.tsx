import { useEffect, useState } from "react";
import { exposeTool, removeExposedTool } from "neutron-tools/app";
import type { PurchaseQuote, WithdrawalQuote } from "../view-types.ts";
import { PurchaseQuoteView } from "./checkout.tsx";
import { AppIcon, CycleCost, Modal, Principal, quantity, usd } from "./primitives.tsx";

type Review = { kind: "purchase"; quote: PurchaseQuote } | { kind: "withdrawal"; quote: WithdrawalQuote };
type Prompt = { id: number; owner: boolean; review: Review; finish: (approved: boolean) => void };

/** Kernel-attested foreground or authenticated resident presentation requests approval.
 * This surface displays exact terms; it never dispatches a financial operation. */
export function AgentReviewHost() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  useEffect(() => {
    const pending = new Set<Prompt>(); let sequence = 0;
    for (const owner of [false, true]) exposeTool(owner ? "marketplace_owner_review_v1" : "marketplace_review_v1", {
      title: "Review marketplace action",
      description: "Owner review of the exact prepared purchase or earnings withdrawal, presented by the Kernel.",
      inputSchema: { type: "object", properties: { reviewJson: { type: "string" } }, required: ["reviewJson"], additionalProperties: false },
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false },
      annotations: { "neutron:effects": ["read", "user_visible_ui"], "neutron:visibility": "same_app", ...(owner ? {} : { "neutron:audience": "foreground_tile" }) },
    }, (args, context) => {
      context.signal?.throwIfAborted();
      const authenticOwner = context.caller?.appId === "marketplace" && context.caller.role === "background" && context.caller.endpoint === "app:marketplace:background";
      if (context.agentMode || (owner ? !authenticOwner : context.audience !== "foreground_tile")) throw new Error("Marketplace review requires its authenticated resident or Kernel-attested foreground presentation.");
      const review: Review = JSON.parse(String(args.reviewJson));
      if (!review || !["purchase", "withdrawal"].includes(review.kind) || !review.quote || typeof review.quote.operationId !== "string") throw new Error("The marketplace action review is invalid.");
      // Verify display-critical exact numbers before mounting so malformed
      // provider input rejects the request rather than crashing the tile.
      if (review.kind === "purchase") {
        usd(review.quote.subtotalUsdMicros); usd(review.quote.discountUsdMicros);
        [review.quote.payment, review.quote.approvalFee, review.quote.collectionFee, review.quote.totalDebit, ...review.quote.allocations.map((item) => item.amount)].forEach(quantity);
        review.quote.items.forEach((item) => usd(item.priceUsdMicros));
      } else [review.quote.debit, review.quote.fee, review.quote.receive].forEach(quantity);
      BigInt(review.quote.cycles.total); BigInt(review.quote.cycles.processing);
      if (review.quote.cycles.storage) BigInt(review.quote.cycles.storage);
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
  return <Modal key={prompt.id} title={prompt.owner ? `Review updated ${review.kind} costs` : review.kind === "purchase" ? "Agent purchase request" : "Agent withdrawal request"} close={() => prompt.finish(false)} footer={<><button type="button" className="mp-secondary" onClick={() => prompt.finish(false)}>Decline</button><button type="button" className="mp-primary" onClick={() => prompt.finish(true)}>Approve {review.kind === "purchase" ? "purchase" : "withdrawal"}</button></>}>
    {review.kind === "purchase" ? <><div className="mp-checkout-items">{review.quote.items.map((app) => <div className="mp-checkout-item" key={app.id}><AppIcon app={app} /><div><strong>{app.title}</strong><p className="mp-muted">{app.category}</p></div><span>{usd(app.priceUsdMicros)}</span></div>)}</div><PurchaseQuoteView quote={review.quote} /></> : <div className="mp-stack"><dl className="mp-facts"><div><dt>From earnings</dt><dd>{quantity(review.quote.debit)}</dd></div><div><dt>Transfer fee</dt><dd>{quantity(review.quote.fee)}</dd></div><div className="mp-total"><dt>You receive</dt><dd>{quantity(review.quote.receive)}</dd></div></dl><div className="mp-destination"><span className="mp-muted">Recipient</span><Principal value={review.quote.destination} /></div><CycleCost value={review.quote.cycles} />{review.quote.warnings.map((warning, i) => <p key={i} className="mp-notice">{warning}</p>)}</div>}
    <details className="mp-review-request"><summary>Saved request</summary><code className="mp-hash">{review.quote.operationId}</code></details>
  </Modal>;
}
