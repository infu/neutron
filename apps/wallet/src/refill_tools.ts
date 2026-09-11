import { keccak256, stringToHex } from "viem";
import { exposeTool, publishAppStateChange, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import {
  assertRefillMatches, continueRefill, executeRefill, listRefillPage, loadRefillSnapshot,
  prepareRefill, quoteRefill, readRefillOwner, readRefillStatus,
  type RefillInput, type RefillOperation, type RefillQuote, type RefillSnapshot,
} from "./refill.ts";
import { WALLET_PROJECTION_TOPIC } from "./wallet_projection.ts";

export const WALLET_REFILL_PRESENT_TOOL = "wallet_refill_present_v1";
const text: JsonObject = { type: "string" };
const nat: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
const id: JsonObject = { type: "string", pattern: "^[0-9a-f]{32}$" };
const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
const closed = (properties: JsonObject): JsonObject => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const cursorSchema = closed({ createdAtNs: nat, requestId: id });
const inputProperties: JsonObject = {
  kind: { enum: ["icp_topup", "tcycles_topup", "icp_to_tcycles"], description: "Refill a canister using ICP or TCYCLES, or convert ICP into TCYCLES tokens." },
  amountAtoms: { type: "string", pattern: "^[1-9][0-9]*$", description: "ICP e8s (8 decimals) for ICP flows; raw cycles (12 decimals per TCYCLES) for TCYCLES refill. The source ledger fee is extra." },
  target: { ...nullable(text), description: "Destination canister principal for refills, or TCYCLES recipient principal for conversion. Null defaults to this Neutron." },
};
export const walletRefillInputSchema = closed({ requestId: id, ...inputProperties });
export const walletRefillQuoteInputSchema = closed(inputProperties);
export const walletRefillPresentationInputSchema: JsonObject = { oneOf: [walletRefillInputSchema, closed({ resumeRequestId: id })] };
export const walletRefillOperationSchema = closed({
  requestId: { ...id, description: "Durable backend operation ID. Pass this only to status/continue tools, never as a fresh caller request ID." }, kind: inputProperties.kind!, target: text, amountAtoms: nat,
  icpFeeAtoms: nat, cyclesFeeAtoms: nat, estimatedCycles: nat,
  createdAtNs: nat, updatedAtNs: nat,
  phase: { enum: ["prepared", "transfer_pending", "notify_pending", "withdraw_pending", "forward_pending", "complete", "refunded", "stopped"] },
  sourceBlockIndex: nullable(nat), mintBlockIndex: nullable(nat), forwardBlockIndex: nullable(nat), refundBlockIndex: nullable(nat),
  creditedCycles: nullable(nat), mintedCycles: nullable(nat), duplicate: { type: "boolean" }, error: nullable(text), canContinue: { type: "boolean" },
});
export const walletRefillOutputSchema = closed({
  version: { const: 1 }, callerRequestId: { ...nullable(id), description: "Original caller request ID for a new invocation. Null when reading or continuing a durable operation. Only this caller ID can be replayed to wallet_refill_v1 or wallet_refill_root_v1 with unchanged inputs." },
  operation: walletRefillOperationSchema,
  recovery: closed({ operationId: id, statusTool: { const: "wallet_refill_status_v1" }, continueTool: { const: "wallet_refill_continue_v1" }, rootContinueTool: { const: "wallet_refill_continue_root_v1" } }),
  nextAction: { enum: ["continue_same_request", "check_status", "none"] }, message: text,
});
export const walletRefillQuoteOutputSchema = closed({
  version: { const: 1 }, kind: inputProperties.kind!, amountAtoms: nat, target: text, owner: text,
  source: { enum: ["ICP", "TCYCLES"] }, sourceDecimals: { enum: [8, 12] },
  sourceFeeAtoms: nat, totalDebitAtoms: nat, estimatedCycles: nat, estimatedReceivedCycles: nat,
  icpFeeAtoms: nat, cyclesFeeAtoms: nat, observedAt: { type: "integer" }, warnings: { type: "array", items: text },
});
export type RefillToolServices = {
  snapshot(owner: string): Promise<RefillSnapshot>;
  publish(): Promise<void>;
};
const services: RefillToolServices = { snapshot: loadRefillSnapshot, publish: () => publishAppStateChange(WALLET_PROJECTION_TOPIC, Date.now()) };

export function registerRefillTools(): void {
  exposeTool("wallet_refill_quote_v1", {
    title: "Quote a canister refill or TCYCLES conversion",
    description: "Read balances, ledger fees and the ICP conversion rate directly from the IC, then estimate a canister refill from ICP or TCYCLES, or ICP to TCYCLES. This never saves or dispatches a payment. Null target means this Neutron. TCYCLES is a token balance, separate from the canister's operating cycles. ICP estimates can change with the CMC rate; TCYCLES minting and forwarding fees are included in the net estimate.",
    inputSchema: walletRefillQuoteInputSchema, outputSchema: walletRefillQuoteOutputSchema,
    annotations: { "neutron:effects": ["read", "network"] },
  }, handleWalletRefillQuote);
  exposeTool("wallet_refill_v1", {
    title: "Refill a canister or convert ICP to TCYCLES",
    description: "Open Wallet for one exact payment review, then save and execute that approved refill or conversion. Keep callerRequestId and original arguments unchanged when repeating this tool. The returned operation.requestId is a separate durable ID for the named status/continue tools. A source transfer is not completion: Wallet retains CMC notification and TCYCLES forwarding steps. Never start another payment to recover an uncertain result.",
    inputSchema: walletRefillInputSchema, outputSchema: walletRefillOutputSchema,
    annotations: { "neutron:consent": "provider_once", "neutron:audit": "metadata_only", "neutron:effects": ["write", "network", "user_visible_ui"], "neutron:longRunning": true },
  }, handleWalletRefill);
  exposeTool("wallet_refill_root_v1", {
    title: "Refill a canister or convert ICP to TCYCLES as the root agent",
    description: "Quote, durably save and execute one exact canister refill or ICP-to-TCYCLES conversion without interactive owner UI. Available only to the active root agent. Null target means this Neutron. Source fees are extra. Repeat only callerRequestId and the original inputs in this tool. Use recovery.operationId with recovery.rootContinueTool or recovery.statusTool, never as a fresh caller request ID; a completed, refunded or stopped request is never resubmitted.",
    inputSchema: walletRefillInputSchema, outputSchema: walletRefillOutputSchema,
    annotations: { "neutron:audience": "agent_root", "neutron:visibility": "same_app", "neutron:audit": "metadata_only", "neutron:effects": ["write", "network"], "neutron:longRunning": true },
  }, handleWalletRefillRoot);
  exposeTool("wallet_refill_continue_v1", {
    title: "Continue a saved refill or conversion",
    description: "Continue the exact durable request returned by Wallet history or a prior result. An unsent prepared payment opens its exact Wallet review; a previously dispatched payment only continues retained recovery steps. Never changes amount, destination, or ledger request identity.",
    inputSchema: closed({ requestId: id }), outputSchema: walletRefillOutputSchema,
    annotations: { "neutron:consent": "provider_once", "neutron:audit": "metadata_only", "neutron:effects": ["write", "network", "user_visible_ui"], "neutron:longRunning": true },
  }, async (args, context) => {
    if (!context.presentUserInterface) throw new Error("Wallet refill requires Kernel provider UI support");
    return context.presentUserInterface<JsonObject>({ tileId: "wallet", tool: WALLET_REFILL_PRESENT_TOOL, arguments: { resumeRequestId: requestedId(args.requestId) } });
  });
  exposeTool("wallet_refill_continue_root_v1", {
    title: "Continue a saved refill as the root agent",
    description: "Continue the exact durable refill ID returned in operation.requestId or Wallet history, without interactive owner UI. Never creates a replacement intent or changes its amounts. The root agent must retain the owner's original authorization for this payment.",
    inputSchema: closed({ requestId: id }), outputSchema: walletRefillOutputSchema,
    annotations: { "neutron:audience": "agent_root", "neutron:visibility": "same_app", "neutron:audit": "metadata_only", "neutron:effects": ["write", "network"], "neutron:longRunning": true },
  }, handleWalletRefillContinueRoot);
  exposeTool("wallet_refill_status_v1", {
    title: "Read a saved refill or TCYCLES conversion",
    description: "Read the durable Wallet operation by its returned requestId. This never dispatches a transfer, withdrawal or CMC notification. Completion requires retained protocol delivery evidence; duplicate ledger observations or balance changes alone do not prove a refill completed.",
    inputSchema: closed({ requestId: id }), outputSchema: closed({ version: { const: 1 }, result: nullable(walletRefillOutputSchema) }),
    annotations: { "neutron:effects": ["read"] },
  }, handleWalletRefillStatus);
  exposeTool("wallet_refills_v1", {
    title: "Find saved canister refills and TCYCLES conversions",
    description: "Page Wallet's retained refill/conversion requests and receipt evidence; follow nextCursor until null for complete coverage. pendingOnly=true finds unfinished work after a closed tab or interrupted tool. Read only; never creates a payment. Use the returned requestId with wallet_refill_continue_v1 or wallet_refill_continue_root_v1 to continue its exact saved intent. It also identifies the backend operation for status reads.",
    inputSchema: { type: "object", properties: { before: nullable(cursorSchema), limit: { type: "integer", minimum: 1, default: 20 }, pendingOnly: { type: "boolean", default: false } }, additionalProperties: false },
    outputSchema: closed({ version: { const: 1 }, operations: { type: "array", items: walletRefillOperationSchema }, nextCursor: nullable(cursorSchema) }),
    annotations: { "neutron:effects": ["read"] },
  }, async (args, context) => {
    const before = args.before == null ? null : parseCursor(args.before);
    const page = await listRefillPage({ before, limit: args.limit === undefined ? 20 : typeof args.limit === "number" ? args.limit : NaN, pendingOnly: args.pendingOnly === true }, context.kernel);
    return { version: 1, operations: page.operations as unknown as JsonObject[], nextCursor: page.nextCursor as unknown as JsonObject | null };
  });
}

export async function handleWalletRefillQuote(args: JsonObject, context: MsgBusToolContext, io: RefillToolServices = services): Promise<JsonObject> {
  const owner = await readRefillOwner(context.kernel);
  context.signal?.throwIfAborted();
  return quoteRefill(parseInput(args, owner), await io.snapshot(owner)) as unknown as JsonObject;
}
export async function handleWalletRefill(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  if (!context.presentUserInterface) throw new Error("Wallet refill requires Kernel provider UI support");
  walletRefillOperationId(context, requestedId(args.requestId));
  context.signal?.throwIfAborted();
  return context.presentUserInterface<JsonObject>({ tileId: "wallet", tool: WALLET_REFILL_PRESENT_TOOL, arguments: args });
}
export async function handleWalletRefillRoot(args: JsonObject, context: MsgBusToolContext, io: RefillToolServices = services): Promise<JsonObject> {
  if (context.audience !== "agent_root") throw new Error("Wallet root refill requires root-agent attestation");
  return { ...await performRefill(args, context, null, io), callerRequestId: requestedId(args.requestId) };
}
export async function handleWalletRefillPresentation(
  args: JsonObject, context: MsgBusToolContext, review: (quote: RefillQuote) => Promise<boolean>, io: RefillToolServices = services,
): Promise<JsonObject> {
  if (context.audience !== "foreground_tile") throw new Error("Wallet refill review requires foreground-tile attestation");
  if (args.resumeRequestId !== undefined) return resumeRefill(requestedId(args.resumeRequestId), context, review, io);
  return { ...await performRefill(args, context, review, io), callerRequestId: requestedId(args.requestId) };
}
export async function handleWalletRefillContinueRoot(args: JsonObject, context: MsgBusToolContext, io: RefillToolServices = services): Promise<JsonObject> {
  if (context.audience !== "agent_root") throw new Error("Wallet root refill requires root-agent attestation");
  return resumeRefill(requestedId(args.requestId), context, null, io);
}
async function resumeRefill(requestId: string, context: MsgBusToolContext, review: ((quote: RefillQuote) => Promise<boolean>) | null, io: RefillToolServices): Promise<JsonObject> {
  context.signal?.throwIfAborted();
  const saved = await readRefillStatus(requestId, context.kernel);
  if (!saved) throw new Error("Wallet refill was not found");
  if (saved.phase === "complete" || saved.phase === "refunded" || saved.phase === "stopped") return refillResult(saved);
  if (saved.phase === "prepared" && review) {
    const owner = await readRefillOwner(context.kernel);
    const quote = quoteRefill(saved, await io.snapshot(owner));
    if (!savedFeesMatchQuote(saved, quote)) throw new Error("The saved refill's fees changed. Review the original request before another payment.");
    if (!(await review(quote))) throw new Error("Refill canceled before payment approval");
  }
  context.signal?.throwIfAborted();
  try {
    return refillResult(saved.phase === "prepared" ? await executeRefill(requestId, context.kernel) : saved.canContinue ? await continueRefill(requestId, context.kernel) : saved);
  } catch (error) {
    if (!context.signal?.aborted) {
      try { const recovered = await readRefillStatus(requestId, context.kernel); if (recovered) return refillResult(recovered, errorMessage(error)); } catch { /* Keep the original saved ID. */ }
    }
    return refillResult(saved, errorMessage(error));
  } finally { try { await io.publish(); } catch { /* UI refresh is best effort. */ } }
}
export function walletRefillOperationId(context: MsgBusToolContext, requestId: string): string {
  const caller = context.caller;
  if (!caller?.appId || !caller.installationUid) throw new Error("Wallet refill requires an authenticated app installation");
  return keccak256(stringToHex(JSON.stringify(["wallet.refill.v1", caller.appId, caller.installationUid, requestedId(requestId)]))).slice(2, 34);
}
async function performRefill(args: JsonObject, context: MsgBusToolContext, review: ((quote: RefillQuote) => Promise<boolean>) | null, io: RefillToolServices): Promise<JsonObject> {
  const callerRequestId = requestedId(args.requestId);
  let requestId = walletRefillOperationId(context, callerRequestId);
  const owner = await readRefillOwner(context.kernel);
  const input = parseInput(args, owner);
  context.signal?.throwIfAborted();
  context.reportProgress({ phase: "Checking saved refill" });
  // History and results expose a durable operation ID. Recognize it before
  // namespacing a caller request, so replaying that returned ID cannot create
  // a second financial intent. Exact intent matching still applies.
  let saved = await readRefillStatus(callerRequestId, context.kernel);
  if (saved) requestId = callerRequestId;
  else saved = await readRefillStatus(requestId, context.kernel);
  if (saved) assertRefillMatches(saved, { ...input, requestId });
  if (saved && (saved.phase === "complete" || saved.phase === "refunded" || saved.phase === "stopped")) return refillResult(saved);
  if (!saved || saved.phase === "prepared") {
    context.reportProgress({ phase: "Checking balances and conversion fees" });
    const quote = quoteRefill(input, await io.snapshot(owner));
    // A prepared request keeps its original fee review, even if it was never sent.
    if (saved && (!savedFeesMatchQuote(saved, quote))) {
      throw new Error("The saved refill's ledger fees changed. Keep its original request; review its status before preparing a different payment.");
    }
    if (review && !(await review(quote))) throw new Error("Refill canceled before payment approval");
    context.signal?.throwIfAborted();
    if (!saved) {
      try { saved = await prepareRefill(quote, requestId, context.kernel); }
      catch (error) {
        if (!context.signal?.aborted) {
          try {
            const recovered = await readRefillStatus(requestId, context.kernel);
            if (recovered) { assertRefillMatches(recovered, { ...input, requestId }); return refillResult(recovered, errorMessage(error)); }
          } catch { /* The original deterministic request ID remains recoverable. */ }
        }
        throw new Error(`${errorMessage(error)} Check saved refill ${requestId} before another payment; retain the original inputs.`);
      }
    }
  }
  context.signal?.throwIfAborted();
  context.reportProgress({ phase: "Completing the saved refill" });
  try {
    const result = saved.phase === "prepared" ? await executeRefill(requestId, context.kernel) : saved.canContinue ? await continueRefill(requestId, context.kernel) : saved;
    return refillResult(result);
  } catch (error) {
    // Recover retained evidence only. A lost reply must never create another debit.
    if (!context.signal?.aborted) {
      try { const recovered = await readRefillStatus(requestId, context.kernel); if (recovered) return refillResult(recovered, errorMessage(error)); } catch { /* The original durable ID remains in the result below. */ }
    }
    return refillResult(saved, errorMessage(error));
  } finally {
    try { await io.publish(); } catch { /* A UI invalidation does not change the financial outcome. */ }
  }
}
export async function handleWalletRefillStatus(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const operation = await readRefillStatus(requestedId(args.requestId), context.kernel);
  return { version: 1, result: operation ? refillResult(operation) : null };
}
export function refillResult(operation: RefillOperation, lastCheckError: string | null = null): JsonObject {
  const terminal = operation.phase === "complete" || operation.phase === "refunded" || operation.phase === "stopped";
  const message = operation.phase === "complete" ? operation.kind === "icp_to_tcycles" ? "TCYCLES were delivered to the selected recipient." : "Cycles were delivered to the selected canister."
    : operation.phase === "refunded" ? "The conversion was refunded. Its retained refund receipt is available."
    : operation.error ?? (operation.phase === "prepared" ? "The exact refill is saved and has not been dispatched." : "The original refill is still being resolved. Keep this request ID; do not start another payment.");
  return { version: 1, callerRequestId: null, operation: operation as unknown as JsonObject,
    recovery: { operationId: operation.requestId, statusTool: "wallet_refill_status_v1", continueTool: "wallet_refill_continue_v1", rootContinueTool: "wallet_refill_continue_root_v1" },
    nextAction: terminal ? "none" : operation.canContinue || operation.phase === "prepared" ? "continue_same_request" : "check_status",
    message: lastCheckError ? `${message} Last check: ${lastCheckError}` : message,
  };
}
function savedFeesMatchQuote(saved: RefillOperation, quote: RefillQuote): boolean {
  return (saved.kind === "tcycles_topup" || saved.icpFeeAtoms === quote.icpFeeAtoms)
    && (saved.kind === "icp_topup" || saved.cyclesFeeAtoms === quote.cyclesFeeAtoms);
}
function parseInput(args: JsonObject, owner: string): RefillInput {
  const kind = args.kind;
  if (kind !== "icp_topup" && kind !== "tcycles_topup" && kind !== "icp_to_tcycles") throw new Error("Choose a supported refill or conversion");
  if (typeof args.amountAtoms !== "string" || !/^[1-9][0-9]*$/.test(args.amountAtoms)) throw new Error("Enter a positive amount in atomic units");
  if (args.target !== null && typeof args.target !== "string") throw new Error("Choose a destination principal or null for this Neutron");
  return { kind, amountAtoms: args.amountAtoms, target: args.target ?? owner };
}
function parseCursor(value: unknown): { createdAtNs: string; requestId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("createdAtNs" in value) || typeof value.createdAtNs !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.createdAtNs) || !("requestId" in value)) throw new Error("Invalid refill history cursor");
  return { createdAtNs: value.createdAtNs, requestId: requestedId(value.requestId) };
}
function requestedId(value: unknown): string { if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("Invalid refill request ID"); return value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
