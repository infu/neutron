import { useEffect, useRef, useSyncExternalStore } from "react";
import { exposeTool, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import { isMsgBusInstallationUid } from "neutron-tools/protocol";

export type ReviewPrompt = {
  id: string;
  review: Record<string, unknown>;
  finish: (approved: boolean) => void;
};
let prompts: ReviewPrompt[] = [];
const listeners = new Set<() => void>();
const emit = () => { prompts = [...prompts]; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Only the resident or a Kernel-attested foreground request can present a
 * prepared action. The reply cannot change any part of the retained intent. */
export function queueReview(args: JsonObject, context: MsgBusToolContext, owner: boolean): Promise<JsonObject> {
  if (context.signal?.aborted) return Promise.resolve({ approved: false });
  const caller = context.caller;
  if (!caller?.appId || !isMsgBusInstallationUid(caller.installationUid)) throw new Error("ICPSwap review requires an authenticated caller installation.");
  if (context.agentMode) throw new Error("Root Agent actions use the exact Kernel approval callback.");
  if (owner
    ? caller.appId !== "icpswap" || caller.role !== "background" || caller.endpoint !== "app:icpswap:background"
    : context.audience !== "foreground_tile") {
    throw new Error("ICPSwap review requires its resident service or Kernel foreground presentation.");
  }
  const review: unknown = JSON.parse(String(args.reviewJson));
  if (!review || typeof review !== "object" || Array.isArray(review)) throw new Error("The prepared review is invalid.");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      context.signal?.removeEventListener("abort", abort);
      prompts = prompts.filter((candidate) => candidate !== prompt);
      emit();
      resolve({ approved });
    };
    const abort = () => finish(false);
    const prompt: ReviewPrompt = { id: crypto.randomUUID(), review: review as Record<string, unknown>, finish };
    context.signal?.addEventListener("abort", abort, { once: true });
    prompts.push(prompt);
    emit();
    if (context.signal?.aborted) abort();
  });
}

for (const owner of [false, true]) exposeTool(owner ? "icpswap_owner_review_v1" : "icpswap_review_v1", {
  title: "Review ICPSwap action",
  description: "Review the exact prepared ICPSwap action in the owner's tile through the resident service or Kernel foreground presentation.",
  inputSchema: { type: "object", properties: { reviewJson: { type: "string" } }, required: ["reviewJson"], additionalProperties: false },
  outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false },
  annotations: { "neutron:effects": ["read", "user_visible_ui"], "neutron:visibility": "same_app", ...(owner ? {} : { "neutron:audience": "foreground_tile" }) },
}, (args, context) => queueReview(args, context, owner));

const names: Record<string, string> = {
  operationId: "Operation", kind: "Action", operation: "Action", pool: "Pool", poolId: "Pool", pair: "Pair",
  from_ledger_id: "Pay token", to_ledger_id: "Receive token", inputAddress: "Pay token", outputAddress: "Receive token",
  amount: "Amount", amount0: "Token 0 maximum", amount1: "Token 1 maximum", amount0Desired: "Token 0 maximum", amount1Desired: "Token 1 maximum",
  amountOutMinimum: "Minimum received", amountIn: "Input amount", positionId: "Position", liquidity: "Liquidity",
  tickLower: "Lower tick", tickUpper: "Upper tick", range: "Price range", feeTier: "Pool fee", account: "Owner account",
  totalDebit: "Maximum wallet debit", funding: "Funding steps", fundingSteps: "Funding steps", fundingRequests: "Funding requests",
  expectedPoolAmountsGross: "Before transfer fees", estimatedWalletAmountsNet: "Estimated in Wallet",
  expectedOutputNet: "Estimated in Wallet", liquidityToRemove: "Liquidity removed",
};
function label(key: string): string { return names[key] ?? key.replaceAll("_", " ").replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/^./u, (value) => value.toUpperCase()); }
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value, null, 2);
}
function ReviewValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length ? <ul className="ics-review-values">{value.map((item, index) => <li key={index}><ReviewValue value={item} /></li>)}</ul> : <>None required</>;
  if (value && typeof value === "object") return <dl className="ics-review-nested">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{label(key)}</dt><dd><ReviewValue value={item} /></dd></div>)}</dl>;
  return <>{valueText(value)}</>;
}
function ReviewDialog({ prompt }: { prompt: ReviewPrompt }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = dialog.current;
    node?.showModal();
    return () => { node?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  const title = typeof prompt.review.title === "string" ? prompt.review.title : "Review ICPSwap action";
  const entries = Object.entries(prompt.review).filter(([key, value]) => key !== "title" && key !== "details" && key !== "notes" && key !== "exactAction" && value !== undefined && value !== null);
  const notes = Array.isArray(prompt.review.details) ? prompt.review.details : Array.isArray(prompt.review.notes) ? prompt.review.notes : [];
  return <dialog className="ics-review-dialog" ref={dialog} aria-label={title} onCancel={(event) => { event.preventDefault(); prompt.finish(false); }} onClose={() => prompt.finish(false)}>
    <div className="ics-review-layout">
      <header><h2 className="nt-subtitle">{title}</h2><button className="nt-icon-button" aria-label="Close review" onClick={() => prompt.finish(false)} type="button">×</button></header>
      <div className="ics-review-content">
        <dl className="ics-review-fields">{entries.map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd><ReviewValue value={value} /></dd></div>)}</dl>
        {notes.length > 0 ? <ul className="ics-review-notes">{notes.map((note, index) => <li key={index}>{valueText(note)}</li>)}</ul> : null}
        <details className="ics-disclosure"><summary>Exact prepared action</summary><pre className="ics-review-raw">{JSON.stringify(prompt.review.exactAction ?? prompt.review, null, 2)}</pre></details>
      </div>
      <footer><button className="nt-button nt-button--secondary" onClick={() => prompt.finish(false)} type="button" autoFocus>Decline</button><button className="nt-button" onClick={() => prompt.finish(true)} type="button">Approve action</button></footer>
    </div>
  </dialog>;
}

export function ReviewHost() {
  const current = useSyncExternalStore(subscribe, () => prompts);
  useEffect(() => {
    const cancel = () => { for (const prompt of [...prompts]) prompt.finish(false); };
    window.addEventListener("pagehide", cancel);
    return () => { window.removeEventListener("pagehide", cancel); cancel(); };
  }, []);
  return current[0] ? <ReviewDialog key={current[0].id} prompt={current[0]} /> : null;
}
