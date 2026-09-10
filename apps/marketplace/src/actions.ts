import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { checkoutType, withdrawalType, encodeOpaque, decodeOpaque, first, type Checkout, type WithdrawQuote, type WireResult, type Option } from "./protocol.ts";
import { protocolClient, operationView, randomId, ProtocolError } from "./client.ts";
import { loadIntent, listIntents, saveIntent, reviseIntent } from "./store.ts";
import { createPurchaseFundingRequest, parseFundingResult, requestFunding, rootFundingInstruction, spenderAccountText, type PurchaseFundingRequest, type FundingInstruction } from "./wallet.ts";
import type { OperationResult, PurchaseQuote, WithdrawalQuote } from "./view-types.ts";

export type Scope = { canister: string; owner: string; callerApp: string; installation: string; root: boolean };
export type SavedIntent = { version: 1; scope: Scope; kind: "purchase"; quote: PurchaseQuote; funding: PurchaseFundingRequest | null } | { version: 1; scope: Scope; kind: "withdrawal"; quote: WithdrawalQuote };
export type ActionResult = OperationResult & { fundingInstructions?: FundingInstruction[] };
export function scope(context: MsgBusToolContext, canister: string, owner: string): Scope {
  const caller = context.caller;
  if (!caller?.appId || !caller.installationUid) throw new Error("This action needs an authenticated Neutron application caller.");
  return { canister, owner, callerApp: caller.appId, installation: caller.installationUid, root: !!context.agentMode };
}
export function assertScope(saved: Scope, current: Scope): void {
  if (JSON.stringify(saved) !== JSON.stringify(current)) throw new Error("Resume this saved operation from the original application, Neutron, marketplace and agent mode.");
}
export async function authorize(context: MsgBusToolContext, review: JsonObject, changedTerms = false): Promise<void> {
  context.signal?.throwIfAborted();
  if (context.agentMode) {
    if (!context.requestApproval) throw new Error("Exact agent review is unavailable. Update the Neutron before executing this action.");
    await context.requestApproval(review);
  } else if (changedTerms && context.caller?.appId === "marketplace" && context.caller.role === "tile") {
    const target = context.caller.endpoint;
    if (!/^app:marketplace:tile:main:instance:[^:]+$/.test(target)) throw new Error("The originating marketplace review tile is unavailable.");
    const approved = await context.kernel.callTool<{ approved: boolean }>({ target: target as `app:marketplace:tile:main:instance:${string}`, name: "marketplace_owner_review_v1", arguments: { reviewJson: JSON.stringify(review) } }, context.signal ? { signal: context.signal, timeout: 0 } : 0);
    if (approved.approved !== true) throw new Error("The updated marketplace costs were declined before dispatch.");
  } else if (context.caller?.appId !== "marketplace" || context.caller.role !== "tile") {
    if (!context.presentUserInterface) throw new Error("Open Marketplace to review this purchase or withdrawal.");
    const approved = await context.presentUserInterface<{ approved: boolean }>({ tileId: "main", tool: "marketplace_review_v1", arguments: { reviewJson: JSON.stringify(review) } });
    if (approved.approved !== true) throw new Error("The marketplace action was declined before dispatch.");
  }
  context.signal?.throwIfAborted();
}
function samePurchase(left: Checkout, right: Checkout): boolean {
  // Mirrors the protocol's executable comparison. Display-only observation
  // timestamps do not create a new quote or funding request.
  return JSON.stringify(encodeOpaque(checkoutType, { ...left, rate: [], quotedAtNs: 0n })) === JSON.stringify(encodeOpaque(checkoutType, { ...right, rate: [], quotedAtNs: 0n }));
}
function sameWithdrawal(left: WithdrawQuote, right: WithdrawQuote): boolean {
  return JSON.stringify(encodeOpaque(withdrawalType, { ...left, available: 0n })) === JSON.stringify(encodeOpaque(withdrawalType, { ...right, available: 0n }));
}
function purchaseIntent(quote: Checkout): string { return JSON.stringify({ buyer: quote.buyer.toText(), requestId: quote.request.requestId, appIds: quote.request.appIds, ledger: quote.request.ledger.toText(), referral: quote.request.referralCode }); }
function withdrawalIntent(quote: WithdrawQuote): string { return JSON.stringify({ owner: quote.owner.toText(), requestId: quote.request.requestId, ledger: quote.request.ledger.toText(), recipient: quote.request.to.owner.toText(), subaccount: quote.request.to.subaccount.map(bytes => [...bytes]), totalDebit: String(quote.request.totalDebit) }); }
function fundingFor(wire: Checkout): PurchaseFundingRequest | null {
  if (wire.amount === 0n) return null;
  const now = BigInt(Date.now()) * 1_000_000n;
  return createPurchaseFundingRequest({ requestId: randomId(), ledger: wire.request.ledger.toText(), saleAtoms: String(wire.amount), spender: first(wire.spender.subaccount) ? spenderAccountText(wire.spender.owner.toText(), first(wire.spender.subaccount)!) : wire.spender.owner.toText(), validUntilNs: String(now + 240_000_000_000n), expiresAtNs: String(now + 300_000_000_000n) });
}
function id(value: string): string { if (!/^[0-9a-f]{32}$/.test(value)) throw new Error("Retain one 32-character lowercase hexadecimal operation ID."); return value; }
async function dispatchError(context: MsgBusToolContext, kind: "purchase" | "withdraw", operationId: string, error: unknown): Promise<OperationResult> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProtocolError) {
    // An explicit protocol rejection is not a lost reply. Preserve any original
    // ledger outcome, otherwise explain that dispatch was rejected before it.
    try {
      const client = await protocolClient(context);
      const observed = first(await client.query<Option<WireResult>>(`${kind}_status`, [{ requestId: operationId }]));
      if (observed) return { ...operationView(observed), message: `${message} ${operationView(observed).message}` };
      if (!error.code.endsWith("_interrupted")) return { operationId, state: "failed", nextAction: "review", message: `${message} No protocol ledger attempt is recorded for this request.` };
    } catch { /* Preserve uncertainty if the status observation is unavailable. */ }
  }
  return { operationId, state: "pending", nextAction: "resume", message: `${message} The original ${kind} request is saved. Check its status before any further payment.` };
}

export async function runPurchase(context: MsgBusToolContext, supplied: PurchaseQuote, fundingResult?: unknown): Promise<ActionResult> {
  const client = await protocolClient(context), operationId = id(supplied.operationId);
  const key = `operation:${operationId}`;
  let saved = await loadIntent<SavedIntent>(context.kernel, key);
  const currentScope = scope(context, client.state.canisterId!, client.state.owner);
  let reviewedRevision = false;
  if (saved && saved.kind !== "purchase") throw new Error("This operation ID already identifies a withdrawal.");
  if (saved) {
    assertScope(saved.scope, currentScope);
    const previous = decodeOpaque<Checkout>(checkoutType, saved.quote.opaque), proposed = decodeOpaque<Checkout>(checkoutType, supplied.opaque);
    if (saved.quote.commitment !== supplied.commitment || !samePurchase(previous, proposed)) {
      if (purchaseIntent(previous) !== purchaseIntent(proposed)) throw new Error("This operation has different purchase inputs. Resume its original terms.");
      // The protocol returns the frozen original quote for active or uncertain
      // attempts. Only its fresh canonical response can authorize a revision.
      const authoritative = await client.query<Checkout>("purchase_quote", [previous.request]);
      if (!samePurchase(proposed, authoritative)) throw new Error("This operation has an existing quote. Resume its original terms or review the protocol's current costs.");
      const canonical = await client.purchaseView(authoritative);
      if (canonical.commitment !== supplied.commitment) throw new Error("The reviewed commitment differs from the protocol quote.");
      if (saved.funding) canonical.warnings.push("An earlier approval may remain for the previous quote. These updated terms use their own bounded Wallet approval.");
      const replacement: SavedIntent = { ...saved, quote: canonical, funding: fundingFor(authoritative) };
      await authorize(context, { kind: "purchase", quote: canonical as unknown as JsonObject }, true);
      await reviseIntent(context.kernel, key, saved, replacement);
      saved = replacement; reviewedRevision = true; fundingResult = undefined;
    }
  } else {
    const wire = decodeOpaque<Checkout>(checkoutType, supplied.opaque);
    if (wire.buyer.toText() !== currentScope.owner || wire.request.requestId !== operationId || String(wire.amount) !== supplied.payment.atoms || wire.request.ledger.toText() !== client.token(supplied.token).ledger.toText()) throw new Error("The reviewed purchase does not match its retained protocol quote.");
    // Review text is derived from the exact quote that the protocol will execute.
    // Caller-provided labels and allocations must never authorize other terms.
    const canonical = await client.purchaseView(wire);
    if (canonical.commitment !== supplied.commitment || JSON.stringify(canonical.appIds) !== JSON.stringify(supplied.appIds)) throw new Error("The purchase display does not match the selected apps and original quote.");
    const funding = fundingFor(wire);
    saved = { version: 1, kind: "purchase", scope: currentScope, quote: canonical, funding };
    // The exact quote and Wallet request are durable before either financial call.
    await saveIntent(context.kernel, key, saved);
  }
  const original = decodeOpaque<Checkout>(checkoutType, saved.quote.opaque);
  const observed = first(await client.query<Option<WireResult>>("purchase_status", [{ requestId: operationId }]));
  if (observed && operationView(observed).state === "complete") return operationView(observed);
  if (observed && operationView(observed).nextAction === "none") return operationView(observed);
  if (!reviewedRevision) await authorize(context, { kind: "purchase", quote: saved.quote as unknown as JsonObject });
  const state = observed?.order ? Object.keys(observed.order.state)[0] : null;
  // Once dispatched, let the protocol reconcile its same immutable ledger attempt.
  if (saved.funding && !["dispatched", "outcome_unknown"].includes(state ?? "")) {
    if (context.agentMode && fundingResult === undefined) return { operationId, state: "approval_required", nextAction: "resume", message: "Authorize this exact Wallet allowance from the root agent, then call marketplace_purchase_v1 with the same operation ID and the raw fundingResult.", fundingInstructions: [rootFundingInstruction(saved.funding)] };
    let funded = context.agentMode ? parseFundingResult(fundingResult, saved.funding.requestId, currentScope.callerApp) : await requestFunding(context.kernel, saved.funding);
    const now = BigInt(Date.now()) * 1_000_000n;
    const expiredRejection = funded.status === "rejected" && now >= BigInt(saved.funding.validUntilNs);
    const expiredApproval = funded.status === "approved" && now >= BigInt(saved.funding.route.expiresAtNs);
    if (expiredRejection || expiredApproval) {
      // A timestamp alone never authorizes rotation. Wallet must have returned
      // a terminal result, and the protocol must independently prove no effect.
      const latest = first(await client.query<Option<WireResult>>("purchase_status", [{ requestId: operationId }]));
      const attempt = latest ? first(latest.attempt) : null;
      const noEffect = attempt?.state.no_effect === null && attempt.hadUnknown === false;
      const noAttempt = !latest || (!attempt && ["prepared", "funding_required", "failed"].includes(Object.keys(latest.order?.state ?? {})[0] ?? ""));
      if (latest && (latest.active || operationView(latest).nextAction === "none" || (!noAttempt && !noEffect))) return operationView(latest);
      const mayRenew = expiredRejection ? noAttempt || noEffect : noEffect && latest?.nextAction?.funding_required === null;
      if (mayRenew) {
        const authoritative = await client.query<Checkout>("purchase_quote", [original.request]);
        if (!samePurchase(original, authoritative)) throw new Error("Purchase costs changed. Continue this same operation to review the updated quote before renewing its approval.");
        const replacement: SavedIntent = { ...saved, quote: { ...saved.quote, warnings: [...saved.quote.warnings, "The previous Wallet approval expired. Renewing requires another bounded approval and its ledger fee; the purchase keeps its original request ID."] }, funding: fundingFor(original) };
        await authorize(context, { kind: "purchase", quote: replacement.quote as unknown as JsonObject }, true);
        await reviseIntent(context.kernel, key, saved, replacement);
        saved = replacement;
        if (context.agentMode) return { operationId, state: "approval_required", nextAction: "resume", message: "The expired approval was retained in history. Authorize this replacement Wallet request, then continue the SAME purchase ID with its raw fundingResult.", fundingInstructions: [rootFundingInstruction(saved.funding!)] };
        funded = await requestFunding(context.kernel, saved.funding!);
      }
    }
    if (funded.status !== "approved") return { operationId, state: funded.status === "pending" ? "pending" : "failed", nextAction: "resume", message: funded.message ?? "The original Wallet approval is not confirmed. Resume its saved request." };
  }
  context.signal?.throwIfAborted();
  try {
    return operationView(await client.update<WireResult>("purchase", { quote: original }, original.cycles));
  } catch (error) {
    return dispatchError(context, "purchase", operationId, error);
  }
}

export async function runWithdrawal(context: MsgBusToolContext, supplied: WithdrawalQuote): Promise<OperationResult> {
  const client = await protocolClient(context), operationId = id(supplied.operationId), key = `operation:${operationId}`;
  let saved = await loadIntent<SavedIntent>(context.kernel, key);
  const currentScope = scope(context, client.state.canisterId!, client.state.owner);
  let reviewedRevision = false;
  if (saved && saved.kind !== "withdrawal") throw new Error("This operation ID already identifies a purchase.");
  if (saved) {
    assertScope(saved.scope, currentScope);
    const previous = decodeOpaque<WithdrawQuote>(withdrawalType, saved.quote.opaque), proposed = decodeOpaque<WithdrawQuote>(withdrawalType, supplied.opaque);
    if (!sameWithdrawal(previous, proposed)) {
      if (withdrawalIntent(previous) !== withdrawalIntent(proposed)) throw new Error("Resume the withdrawal's original recipient, token and debit.");
      const authoritative = await client.query<WithdrawQuote>("withdraw_quote", [previous.request]);
      if (!sameWithdrawal(proposed, authoritative)) throw new Error("Resume the withdrawal's original saved quote or review the protocol's current costs.");
      const canonical = client.withdrawalView(authoritative), replacement: SavedIntent = { ...saved, quote: canonical };
      await authorize(context, { kind: "withdrawal", quote: canonical as unknown as JsonObject }, true);
      await reviseIntent(context.kernel, key, saved, replacement);
      saved = replacement; reviewedRevision = true;
    }
  } else {
    const wire = decodeOpaque<WithdrawQuote>(withdrawalType, supplied.opaque);
    if (wire.owner.toText() !== currentScope.owner || wire.request.requestId !== operationId || wire.request.to.owner.toText() !== supplied.destination || wire.request.totalDebit.toString() !== supplied.debit.atoms) throw new Error("The reviewed withdrawal does not match the protocol quote.");
    saved = { version: 1, kind: "withdrawal", scope: currentScope, quote: client.withdrawalView(wire) };
    await saveIntent(context.kernel, key, saved);
  }
  const observed = first(await client.query<Option<WireResult>>("withdraw_status", [{ requestId: operationId }]));
  if (observed && operationView(observed).state === "complete") return operationView(observed);
  if (observed && operationView(observed).nextAction === "none") return operationView(observed);
  if (!reviewedRevision) await authorize(context, { kind: "withdrawal", quote: saved.quote as unknown as JsonObject });
  const original = decodeOpaque<WithdrawQuote>(withdrawalType, saved.quote.opaque);
  try { return operationView(await client.update<WireResult>("withdraw", { quote: original }, original.cycles)); }
  catch (error) { return dispatchError(context, "withdraw", operationId, error); }
}
export async function operationStatus(context: MsgBusToolContext, operationId: string): Promise<OperationResult> {
  const client = await protocolClient(context);
  const saved = await loadIntent<SavedIntent>(context.kernel, `operation:${id(operationId)}`);
  const names = saved ? [saved.kind === "purchase" ? "purchase_status" : "withdraw_status"] : ["purchase_status", "withdraw_status"];
  for (const name of names) {
    const result = first(await client.query<Option<WireResult>>(name, [{ requestId: operationId }]));
    if (result) {
      const view = operationView(result);
      if (saved && JSON.stringify(saved.scope) !== JSON.stringify(scope(context, client.state.canisterId!, client.state.owner)) && view.nextAction === "resume") return { ...view, nextAction: "none", message: `${view.message} Continue from the original ${saved.scope.callerApp} ${saved.scope.root ? "root agent" : "application"} so its saved Wallet authority remains unchanged.` };
      return view;
    }
  }
  if (saved) {
    const same = JSON.stringify(saved.scope) === JSON.stringify(scope(context, client.state.canisterId!, client.state.owner));
    return { operationId, state: "approval_required", nextAction: same ? "resume" : "none", message: same ? "The original reviewed quote is saved. No protocol dispatch has been recorded." : `This request belongs to the original ${saved.scope.callerApp} ${saved.scope.root ? "root agent" : "application"}. Resume it there to preserve its exact Wallet request.` };
  }
  throw new Error("No saved operation was found for this ID.");
}
export async function recentOperations(context: MsgBusToolContext): Promise<OperationResult[]> {
  const client = await protocolClient(context), rows = await listIntents<SavedIntent>(context.kernel), result = new Map<string, OperationResult>();
  const page = await operationHistory(context, {});
  for (const operation of [...page.purchases, ...page.withdrawals]) result.set(operation.operationId, operation);
  for (const row of rows) if (row.id.startsWith("operation:") && row.value.scope.canister === client.state.canisterId && row.value.scope.owner === client.state.owner) result.set(row.value.quote.operationId, await operationStatus(context, row.value.quote.operationId));
  return [...result.values()];
}
export async function operationHistory(context: MsgBusToolContext, input: { purchaseCursor?: string; withdrawalCursor?: string }) {
  const client = await protocolClient(context);
  const cursor = (value?: string) => value === "done" ? { done: null } : !value || value === "start" ? { start: null } : { after: BigInt(value) };
  type Cursor = { start: null } | { done: null } | { after: bigint };
  const next = (value: Cursor): string => "after" in value ? String(value.after) : "done" in value ? "done" : "start";
  const page = await client.query<{ purchases: WireResult[]; withdrawals: WireResult[]; nextPurchaseCursor: Cursor; nextWithdrawalCursor: Cursor }>("operation_history", [{ purchaseCursor: cursor(input.purchaseCursor), withdrawalCursor: cursor(input.withdrawalCursor), limit: 24n }]);
  return { purchases: page.purchases.map(operationView), withdrawals: page.withdrawals.map(operationView), nextPurchaseCursor: next(page.nextPurchaseCursor), nextWithdrawalCursor: next(page.nextWithdrawalCursor) };
}
export async function resumeOperation(context: MsgBusToolContext, operationId: string, fundingResult?: unknown): Promise<ActionResult> {
  const saved = await loadIntent<SavedIntent>(context.kernel, `operation:${id(operationId)}`);
  if (!saved) {
    // Restores original protocol quotes after uninstall. Never invent another financial request.
    const client = await protocolClient(context);
    const purchase = first(await client.query<Option<WireResult>>("purchase_status", [{ requestId: operationId }]));
    if (purchase) {
      const view = operationView(purchase);
      if (view.state === "complete" || view.nextAction === "none") return view;
      const quote = first(purchase.quote ?? []);
      if (!quote || !("buyer" in quote)) throw new Error("The original purchase quote is unavailable. Do not recreate its payment.");
      return runPurchase(context, await client.purchaseView(quote), fundingResult);
    }
    const withdrawal = first(await client.query<Option<WireResult>>("withdraw_status", [{ requestId: operationId }]));
    if (withdrawal) {
      const view = operationView(withdrawal);
      if (view.state === "complete" || view.nextAction === "none") return view;
      const quote = first(withdrawal.quote ?? []);
      if (!quote || !("netAmount" in quote)) throw new Error("The original withdrawal quote is unavailable. Do not recreate its transfer.");
      return runWithdrawal(context, client.withdrawalView(quote));
    }
    throw new Error("The original marketplace intent is unavailable. Read its protocol status; do not recreate it.");
  }
  const client = await protocolClient(context);
  assertScope(saved.scope, scope(context, client.state.canisterId!, client.state.owner));
  if (saved.kind === "purchase") {
    const previous = decodeOpaque<Checkout>(checkoutType, saved.quote.opaque);
    const fresh = await client.query<Checkout>("purchase_quote", [previous.request]);
    return runPurchase(context, samePurchase(previous, fresh) ? saved.quote : await client.purchaseView(fresh), fundingResult);
  }
  const previous = decodeOpaque<WithdrawQuote>(withdrawalType, saved.quote.opaque);
  const fresh = await client.query<WithdrawQuote>("withdraw_quote", [previous.request]);
  return runWithdrawal(context, sameWithdrawal(previous, fresh) ? saved.quote : client.withdrawalView(fresh));
}
