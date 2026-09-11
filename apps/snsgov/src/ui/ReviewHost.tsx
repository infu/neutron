import { useSyncExternalStore } from "react";
import { Dialog } from "./Common";
import { exposeTool, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import { isMsgBusInstallationUid } from "neutron-tools/protocol";
import "./review.scss";

interface Review {
  title?: string;
  summary?: string;
  snsName?: string;
  neuronId?: string;
  fields?: { label: string; value: unknown }[];
  details?: string[];
  warnings?: string[];
  [key: string]: unknown;
}
type Prompt = { id: number; review: Review; finish(approved: boolean): void };
let prompts: Prompt[] = [];
let promptSequence = 0;
const subscribers = new Set<() => void>();
const emit = () => { prompts = [...prompts]; subscribers.forEach((notify) => notify()); };

function queueReview(args: JsonObject, context: MsgBusToolContext, owner: boolean): Promise<JsonObject> {
  context.signal?.throwIfAborted();
  const caller = context.caller;
  if (!caller?.appId || !isMsgBusInstallationUid(caller.installationUid) || context.agentMode) {
    throw new Error("SNS review requires an authenticated foreground request.");
  }
  if (owner
    ? caller.appId !== "snsgov" || caller.role !== "background" || caller.endpoint !== "app:snsgov:background"
    : context.audience !== "foreground_tile") {
    throw new Error("SNS review requires its resident service or Kernel foreground attestation.");
  }
  const review: unknown = JSON.parse(String(args.reviewJson));
  if (!review || typeof review !== "object" || Array.isArray(review)) throw new Error("The SNS review is invalid.");
  return new Promise((resolve, reject) => {
    let settled = false;
    const remove = () => {
      prompts = prompts.filter((row) => row !== prompt);
      context.signal?.removeEventListener("abort", abort);
      emit();
    };
    const prompt: Prompt = { id: ++promptSequence, review: review as Review, finish: (approved) => {
      if (settled) return;
      settled = true;
      remove();
      resolve({ approved });
    } };
    const abort = () => {
      if (settled) return;
      settled = true;
      remove();
      reject(context.signal?.reason ?? new Error("SNS review interrupted."));
    };
    context.signal?.addEventListener("abort", abort, { once: true });
    prompts.push(prompt);
    emit();
    if (context.signal?.aborted) abort();
  });
}

for (const owner of [false, true]) exposeTool(owner ? "sns_owner_review_v1" : "sns_review_v1", {
  title: "Review SNS action",
  description: "Review the exact saved SNS action through the resident or Kernel foreground presentation.",
  inputSchema: { type: "object", properties: { reviewJson: { type: "string" } }, required: ["reviewJson"], additionalProperties: false },
  outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false },
  annotations: { "neutron:effects": ["read", "user_visible_ui"], "neutron:visibility": "same_app", ...(owner ? {} : { "neutron:audience": "foreground_tile" }) },
}, (args, context) => queueReview(args, context, owner));

export function ReviewHost() {
  const rows = useSyncExternalStore((listener) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; }, () => prompts);
  const prompt = rows[0];
  if (!prompt) return null;
  const review = prompt.review;
  const fields = Array.isArray(review.fields) ? review.fields : [];
  return <Dialog key={prompt.id} className="sns-review-dialog" title={review.title ?? "Review SNS action"} onClose={() => prompt.finish(false)} footer={<>
    <button type="button" className="nt-button nt-button--secondary" onClick={() => prompt.finish(false)}>Cancel</button>
    <button type="button" className="nt-button" onClick={() => prompt.finish(true)}>Approve</button>
  </>}>
    <div className="sns-review-body">
      {review.snsName && <p className="nt-muted">{review.snsName}</p>}
      {review.summary && <p>{review.summary}</p>}
      {!!fields.length && <dl className="sns-review-fields">{fields.map((field, index) => <div key={index}><dt>{field.label}</dt><dd>{typeof field.value === "string" ? field.value : JSON.stringify(field.value)}</dd></div>)}</dl>}
      {Array.isArray(review.details) && review.details.map((detail, index) => <p key={index}>{detail}</p>)}
      {Array.isArray(review.warnings) && review.warnings.map((warning, index) => <p className="sns-review-warning" key={index}>{warning}</p>)}
      <details><summary>Advanced details</summary><pre>{JSON.stringify(review, null, 2)}</pre></details>
    </div>
  </Dialog>;
}
