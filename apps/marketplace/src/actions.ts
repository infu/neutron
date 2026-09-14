import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { checkoutType, channelCheckoutType, withdrawalType, encodeOpaque, decodeOpaque, first, type Checkout, type ChannelCheckout, type ChannelPurchaseResult, type WithdrawQuote, type WireResult, type Option } from "./protocol.ts";
import { protocolClient, operationView, randomId, ProtocolError } from "./client.ts";
import { loadIntent, listIntents, saveIntent, reviseIntent } from "./store.ts";
import { createPurchaseFundingRequest, parseFundingResult, requestFunding, rootFundingInstruction, spenderAccountText, type PurchaseFundingRequest, type FundingInstruction, type FundingResult } from "./wallet.ts";
import type { OperationResult, PurchaseQuote, WithdrawalQuote } from "./view-types.ts";
import { assertReleasePreferencesUnchanged, parseReleasePreferences, readReleasePreferences, releasePreferencesEqual } from "./release_preferences.ts";
import { needsPaymentRecovery } from "./notification-state.ts";

export type Scope = { canister: string; owner: string; callerApp: string; installation: string; root: boolean };
type PurchaseProgress = {
  version: 1;
  /** Written before requesting collection. A missing reply must remain recoverable. */
  dispatch: "not_requested" | "requested" | "rejected";
  /** The same allowance request remains recoverable after a preference change. */
  fundingDispatch?: "requested";
  fundingResult?: FundingResult;
  rejection?: string;
  /** Present from the durable dispatch claim until a definitive reply. */
  pendingDispatch?: string;
};
type PurchaseIntent = { version: 1; scope: Scope; kind: "purchase"; quote: PurchaseQuote; funding: PurchaseFundingRequest | null; progress?: PurchaseProgress };
type WithdrawalIntent = { version: 1; scope: Scope; kind: "withdrawal"; quote: WithdrawalQuote; dispatch?: "not_requested" | "requested" | "rejected"; pendingDispatch?: string };
export type SavedIntent = PurchaseIntent | WithdrawalIntent;
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
/** Legacy saved financial identities remain recoverable without assigning them
 * today's channel. New quote views always carry their original preference. */
export async function assertPurchaseReleasePreferences(context: MsgBusToolContext, quote: PurchaseQuote): Promise<void> {
  if (quote.channelOpaque && !quote.releasePreferences) throw new Error("This retained purchase has no original release preference. Reconcile its existing payment; review a fresh selection before starting another financial effect.");
  if (quote.releasePreferences) assertReleasePreferencesUnchanged(parseReleasePreferences(quote.releasePreferences), await readReleasePreferences(context));
}
export function purchaseChannel(quote: PurchaseQuote): ChannelCheckout | undefined {
  if (!quote.channelOpaque) return undefined;
  const channel = decodeOpaque<ChannelCheckout>(channelCheckoutType, quote.channelOpaque);
  const inner = decodeOpaque<Checkout>(checkoutType, quote.opaque);
  if (JSON.stringify(encodeOpaque(checkoutType, inner)) !== JSON.stringify(encodeOpaque(checkoutType, channel.quote))) throw new Error("The retained channel selection differs from its exact purchase quote.");
  if (quote.releasePreferences && quote.releasePreferences.betaEnabled !== ("beta" in channel.mode)) throw new Error("The purchase selection differs from its original release preference.");
  return channel;
}
export function sameChannelSelection(left: ChannelCheckout | undefined, right: ChannelCheckout | undefined): boolean {
  if (!left || !right) return left === right;
  return JSON.stringify(encodeOpaque(channelCheckoutType, left)) === JSON.stringify(encodeOpaque(channelCheckoutType, { ...right, quote: left.quote }));
}
async function refreshPurchase(client: Awaited<ReturnType<typeof protocolClient>>, previous: Checkout, channel?: ChannelCheckout) {
  if (!channel) return { wire: await client.query<Checkout>("purchase_quote", [previous.request]), channel: undefined };
  const fresh = await client.query<ChannelCheckout>("purchase_quote_v2", [{ request: previous.request, mode: channel.mode, expectedSelection: [channel.selection] }]);
  if (!sameChannelSelection(channel, fresh)) throw new Error("The original release selection changed. Retain this purchase ID and review a new selection before another payment.");
  return { wire: fresh.quote, channel: fresh };
}
function samePurchasePreferences(left: PurchaseQuote, right: PurchaseQuote): boolean {
  return left.releasePreferences && right.releasePreferences
    ? releasePreferencesEqual(left.releasePreferences, right.releasePreferences)
    : left.releasePreferences === right.releasePreferences;
}
function purchaseWasDispatched(saved: PurchaseIntent, observed: WireResult | null): boolean {
  const attempt = observed ? first(observed.attempt) : null;
  if (attempt?.state.no_effect === null && attempt.hadUnknown === false && !observed?.active) return false;
  const state = Object.keys(observed?.order?.state ?? {})[0];
  return observed?.active === true || ["dispatched", "outcome_unknown"].includes(state ?? "")
    || saved.progress?.dispatch === "requested";
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
async function savePurchaseProgress(context: MsgBusToolContext, saved: PurchaseIntent, progress: PurchaseProgress): Promise<PurchaseIntent> {
  if (JSON.stringify(saved.progress) === JSON.stringify(progress)) return saved;
  const replacement = { ...saved, progress };
  await reviseIntent(context.kernel, `operation:${saved.quote.operationId}`, saved, replacement);
  return replacement;
}

/** Only unresolved payment dispatches require a retained recovery checkout.
 * Wallet allowance approval (including its fee) is not purchase payment. */
function purchaseObservation(operationId: string, observed: WireResult | null, saved?: PurchaseIntent): OperationResult {
  const progress = saved?.progress?.version === 1 ? saved.progress : undefined;
  const original = observed ? first(observed.quote ?? []) : null;
  const free = saved?.quote.payment.atoms === "0" || (original && "amount" in original && original.amount === 0n);
  if (observed) {
    const view = operationView(observed), attempt = first(observed.attempt);
    if (view.state === "complete" || free) return { ...view, canDismiss: true };
    if (progress?.pendingDispatch) return view;
    const state = Object.keys(observed.order?.state ?? {})[0];
    const noEffect = !observed.active && !view.ledgerBlock && attempt?.state.no_effect === null && attempt.hadUnknown === false;
    const notAttempted = !observed.active && !attempt && ["prepared", "funding_required", "failed"].includes(state ?? "");
    if (!noEffect && !notAttempted) return view;
    if (progress?.dispatch === "not_requested" && progress.fundingResult?.status === "rejected") {
      return { ...view, state: "failed", nextAction: "none", checkoutCanceled: true, canDismiss: true,
        message: `${progress.fundingResult.message ?? "The Wallet approval was declined."} No purchase payment was made.` };
    }
    return { ...view, canDismiss: true };
  }
  if (progress?.dispatch === "requested") return { operationId, state: "pending", nextAction: "resume", ...(free ? { canDismiss: true } : {}),
    message: "The original purchase was requested, but its outcome is not available yet. Check this saved request before any further payment." };
  if (progress?.dispatch === "not_requested" && progress.fundingResult?.status === "rejected") return {
    operationId, state: "failed", nextAction: "none", checkoutCanceled: true, canDismiss: true,
    message: `${progress.fundingResult.message ?? "The Wallet approval was declined."} No purchase payment was requested.`,
  };
  if (progress?.dispatch === "rejected") return { operationId, state: "failed", nextAction: "review", canDismiss: true,
    message: `${progress.rejection ?? "The protocol declined this purchase."} No protocol ledger attempt is recorded for this request.` };
  return { operationId, state: "approval_required", nextAction: "resume", canDismiss: true,
    message: progress?.dispatch === "not_requested"
      ? progress.fundingResult?.status === "approved"
        ? "The Wallet allowance was approved, but purchase payment was not requested. You can dismiss this checkout; its approval fee is already paid."
        : "The original reviewed quote is saved. Purchase payment has not been requested."
      : "No protocol purchase payment is recorded. You can dismiss this checkout and delete its saved request." };
}
function withdrawalObservation(operationId: string, observed: WireResult | null, saved?: WithdrawalIntent): OperationResult {
  if (!observed) return { operationId, state: "approval_required", nextAction: "resume", canDismiss: saved?.dispatch === "not_requested" || saved?.dispatch === "rejected",
    message: saved?.dispatch === "not_requested" || saved?.dispatch === "rejected" ? "No withdrawal payment was requested. You can dismiss this checkout." : "Check the original withdrawal before requesting another transfer." };
  const view = operationView(observed), attempt = first(observed.attempt);
  const noEffect = !saved?.pendingDispatch && !observed.active && !view.ledgerBlock && attempt?.state.no_effect === null && attempt.hadUnknown === false;
  return { ...view, canDismiss: view.state === "complete" || noEffect };
}
async function dispatchError(context: MsgBusToolContext, kind: "purchase" | "withdraw", operationId: string, error: unknown): Promise<OperationResult> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ProtocolError) {
    // An explicit protocol rejection is not a lost reply. Preserve any original
    // ledger outcome, otherwise explain that dispatch was rejected before it.
    try {
      const client = await protocolClient(context);
      const observed = kind === "purchase" ? (await client.purchaseWireStatus(operationId))?.purchase ?? null : first(await client.query<Option<WireResult>>("withdraw_status", [{ requestId: operationId }]));
      if (observed) return { ...operationView(observed), message: `${message} ${operationView(observed).message}` };
      if (!error.code.endsWith("_interrupted")) return { operationId, state: "failed", nextAction: "review", canDismiss: true, message: `${message} No protocol ledger attempt is recorded for this request.` };
    } catch { /* Preserve uncertainty if the status observation is unavailable. */ }
  }
  return { operationId, state: "pending", nextAction: "resume", message: `${message} The original ${kind} request is saved. Check its status before any further payment.` };
}

export async function runPurchase(context: MsgBusToolContext, supplied: PurchaseQuote, fundingResult?: unknown, requireSaved = false): Promise<ActionResult> {
  const client = await protocolClient(context), operationId = id(supplied.operationId);
  const key = `operation:${operationId}`;
  let saved = await loadIntent<SavedIntent>(context.kernel, key);
  if (requireSaved && !saved) throw new Error("This checkout was dismissed. Review a new purchase to continue.");
  const currentScope = scope(context, client.state.canisterId!, client.state.owner);
  let reviewedRevision = false;
  if (saved && saved.kind !== "purchase") throw new Error("This operation ID already identifies a withdrawal.");
  if (saved) {
    assertScope(saved.scope, currentScope);
    if (!samePurchasePreferences(saved.quote, supplied)) throw new Error("Resume this purchase with its original release preference and selected packages.");
    if (!sameChannelSelection(purchaseChannel(saved.quote), purchaseChannel(supplied))) throw new Error("Resume this purchase with its original release selection and packages.");
    const previous = decodeOpaque<Checkout>(checkoutType, saved.quote.opaque), proposed = decodeOpaque<Checkout>(checkoutType, supplied.opaque);
    if (saved.quote.commitment !== supplied.commitment || !samePurchase(previous, proposed)) {
      if (purchaseIntent(previous) !== purchaseIntent(proposed)) throw new Error("This operation has different purchase inputs. Resume its original terms.");
      // The protocol returns the frozen original quote for active or uncertain
      // attempts. Only its fresh canonical response can authorize a revision.
      const fresh = await refreshPurchase(client, previous, purchaseChannel(saved.quote)), authoritative = fresh.wire;
      if (!samePurchase(proposed, authoritative)) throw new Error("This operation has an existing quote. Resume its original terms or review the protocol's current costs.");
      const canonical = await client.purchaseView(authoritative, false, undefined, saved.quote.releasePreferences, fresh.channel);
      if (canonical.commitment !== supplied.commitment) throw new Error("The reviewed commitment differs from the protocol quote.");
      if (saved.funding) canonical.warnings.push("An earlier approval may remain for the previous quote. These updated terms use their own bounded Wallet approval.");
      const replacement: PurchaseIntent = { ...saved, quote: canonical, funding: fundingFor(authoritative), progress: { version: 1, dispatch: "not_requested" } };
      await assertPurchaseReleasePreferences(context, canonical);
      await authorize(context, { kind: "purchase", quote: canonical as unknown as JsonObject }, true);
      await assertPurchaseReleasePreferences(context, canonical);
      await reviseIntent(context.kernel, key, saved, replacement);
      saved = replacement; reviewedRevision = true; fundingResult = undefined;
    }
  } else {
    const wire = decodeOpaque<Checkout>(checkoutType, supplied.opaque);
    if (wire.buyer.toText() !== currentScope.owner || wire.request.requestId !== operationId || String(wire.amount) !== supplied.payment.atoms || wire.request.ledger.toText() !== client.token(supplied.token).ledger.toText()) throw new Error("The reviewed purchase does not match its retained protocol quote.");
    // Review text is derived from the exact quote that the protocol will execute.
    // Caller-provided labels and allocations must never authorize other terms.
    const canonical = await client.purchaseView(wire, false, undefined, supplied.releasePreferences, purchaseChannel(supplied));
    if (canonical.commitment !== supplied.commitment || JSON.stringify(canonical.appIds) !== JSON.stringify(supplied.appIds)) throw new Error("The purchase display does not match the selected apps and original quote.");
    const funding = fundingFor(wire);
    saved = { version: 1, kind: "purchase", scope: currentScope, quote: canonical, funding, progress: { version: 1, dispatch: "not_requested" } };
    // The exact quote and Wallet request are durable before either financial call.
    await saveIntent(context.kernel, key, saved);
  }
  const original = decodeOpaque<Checkout>(checkoutType, saved.quote.opaque);
  const observed = (await client.purchaseWireStatus(operationId))?.purchase ?? null;
  if (observed && operationView(observed).state === "complete") return purchaseObservation(operationId, observed, saved);
  if (observed && operationView(observed).nextAction === "none") return purchaseObservation(operationId, observed, saved);
  const dispatched = purchaseWasDispatched(saved, observed);
  if (!dispatched && saved.progress?.fundingDispatch !== "requested") await assertPurchaseReleasePreferences(context, saved.quote);
  if (!reviewedRevision) await authorize(context, { kind: "purchase", quote: saved.quote as unknown as JsonObject });
  const state = observed?.order ? Object.keys(observed.order.state)[0] : null;
  // Once dispatched, let the protocol reconcile its same immutable ledger attempt.
  let confirmedFunding = saved.progress?.fundingResult;
  if (saved.funding && !["dispatched", "outcome_unknown"].includes(state ?? "") && !(saved.progress?.dispatch === "requested" && !observed)) {
    if (saved.quote.releasePreferences && saved.progress?.fundingDispatch !== "requested") {
      await assertPurchaseReleasePreferences(context, saved.quote);
      saved = await savePurchaseProgress(context, saved, { ...saved.progress, version: 1, dispatch: saved.progress?.dispatch ?? "requested", fundingDispatch: "requested" });
    }
    const originalFunding = saved.funding!;
    if (context.agentMode && fundingResult === undefined) return { operationId, state: "approval_required", nextAction: "resume", canDismiss: purchaseObservation(operationId, observed, saved).canDismiss === true, message: "Authorize this exact Wallet allowance from the root agent, then call marketplace_purchase_v1 with the same operation ID and the raw fundingResult.", fundingInstructions: [rootFundingInstruction(originalFunding)] };
    let funded = context.agentMode ? parseFundingResult(fundingResult, originalFunding.requestId, currentScope.callerApp) : await requestFunding(context.kernel, originalFunding);
    const now = BigInt(Date.now()) * 1_000_000n;
    const expiredRejection = funded.status === "rejected" && now >= BigInt(originalFunding.validUntilNs);
    const expiredApproval = funded.status === "approved" && now >= BigInt(originalFunding.route.expiresAtNs);
    if (expiredRejection || expiredApproval) {
      // A timestamp alone never authorizes rotation. Wallet must have returned
      // a terminal result, and the protocol must independently prove no effect.
      const latest = (await client.purchaseWireStatus(operationId))?.purchase ?? null;
      const attempt = latest ? first(latest.attempt) : null;
      const noEffect = attempt?.state.no_effect === null && attempt.hadUnknown === false;
      const noAttempt = !latest || (!attempt && ["prepared", "funding_required", "failed"].includes(Object.keys(latest.order?.state ?? {})[0] ?? ""));
      if (latest && (latest.active || operationView(latest).nextAction === "none" || (!noAttempt && !noEffect))) return operationView(latest);
      const mayRenew = expiredRejection ? noAttempt || noEffect : noEffect && latest?.nextAction?.funding_required === null;
      if (mayRenew) {
        const authoritative = (await refreshPurchase(client, original, purchaseChannel(saved.quote))).wire;
        if (!samePurchase(original, authoritative)) throw new Error("Purchase costs changed. Continue this same operation to review the updated quote before renewing its approval.");
        const replacement: PurchaseIntent = { ...saved, quote: { ...saved.quote, warnings: [...saved.quote.warnings, "The previous Wallet approval expired. Renewing requires another bounded approval and its ledger fee; the purchase keeps its original request ID."] }, funding: fundingFor(original), progress: { version: 1, dispatch: "not_requested" } };
        await assertPurchaseReleasePreferences(context, replacement.quote);
        await authorize(context, { kind: "purchase", quote: replacement.quote as unknown as JsonObject }, true);
        await assertPurchaseReleasePreferences(context, replacement.quote);
        await reviseIntent(context.kernel, key, saved, replacement);
        saved = replacement;
        if (saved.quote.releasePreferences) saved = await savePurchaseProgress(context, saved, { version: 1, dispatch: "not_requested", fundingDispatch: "requested" });
        if (context.agentMode) return { operationId, state: "approval_required", nextAction: "resume", canDismiss: true, message: "The expired approval was retained in history. Authorize this replacement Wallet request, then continue the SAME purchase ID with its raw fundingResult.", fundingInstructions: [rootFundingInstruction(saved.funding!)] };
        funded = await requestFunding(context.kernel, saved.funding!);
      }
    }
    if (funded.status !== "approved") {
      // Allowance approval is separate from transferFrom. Retain an explicit
      // refusal so a reload cannot revive it as an unfinished purchase.
      // Legacy journals did not record dispatch. A newly rejected approval
      // cannot prove that an earlier invocation never reached collection.
      const progress: PurchaseProgress = { ...saved.progress, version: 1, dispatch: saved.progress?.dispatch ?? "requested", fundingResult: funded };
      saved = await savePurchaseProgress(context, saved, progress);
      if (funded.status === "rejected") return purchaseObservation(operationId, observed, saved);
      return { operationId, state: "pending", nextAction: "resume", canDismiss: progress.dispatch === "not_requested",
        message: funded.message ?? (progress.dispatch === "not_requested" ? "The Wallet allowance result is not confirmed. Purchase payment has not been requested." : "The Wallet allowance result is not confirmed. Check this original purchase before any further payment.") };
    }
    confirmedFunding = funded;
    saved = await savePurchaseProgress(context, saved, { ...saved.progress, version: 1, dispatch: saved.progress?.dispatch ?? "requested", fundingResult: funded });
    if (context.signal?.aborted) {
      context.signal.throwIfAborted();
    }
  }
  context.signal?.throwIfAborted();
  if (!dispatched) await assertPurchaseReleasePreferences(context, saved.quote);
  const beforeDispatch = saved;
  saved = await savePurchaseProgress(context, saved, { ...saved.progress, version: 1, dispatch: "requested", pendingDispatch: randomId(), ...(confirmedFunding ? { fundingResult: confirmedFunding } : {}) });
  if (context.signal?.aborted) {
    await reviseIntent(context.kernel, key, saved, beforeDispatch);
    context.signal.throwIfAborted();
  }
  try {
    const channel = purchaseChannel(saved.quote);
    const result = channel
      ? (await client.update<ChannelPurchaseResult>("purchase_v2", { quote: channel }, original.cycles)).purchase
      : await client.update<WireResult>("purchase", { quote: original }, original.cycles);
    const { pendingDispatch: _pending, ...progress } = saved.progress!;
    saved = await savePurchaseProgress(context, saved, progress);
    return purchaseObservation(operationId, result, saved);
  } catch (error) {
    const result = await dispatchError(context, "purchase", operationId, error);
    if (error instanceof ProtocolError && result.canDismiss === true) {
      const { pendingDispatch: _pending, ...progress } = saved.progress!;
      saved = await savePurchaseProgress(context, saved, { ...progress, dispatch: "rejected", rejection: error.message });
      return purchaseObservation(operationId, null, saved);
    }
    return result;
  }
}

export async function runWithdrawal(context: MsgBusToolContext, supplied: WithdrawalQuote, requireSaved = false): Promise<OperationResult> {
  const client = await protocolClient(context), operationId = id(supplied.operationId), key = `operation:${operationId}`;
  let saved = await loadIntent<SavedIntent>(context.kernel, key);
  if (requireSaved && !saved) throw new Error("This checkout was dismissed. Review a new withdrawal to continue.");
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
    saved = { version: 1, kind: "withdrawal", scope: currentScope, quote: client.withdrawalView(wire), dispatch: "not_requested" };
    await saveIntent(context.kernel, key, saved);
  }
  const observed = first(await client.query<Option<WireResult>>("withdraw_status", [{ requestId: operationId }]));
  if (observed && operationView(observed).state === "complete") return operationView(observed);
  if (observed && operationView(observed).nextAction === "none") return operationView(observed);
  if (!reviewedRevision) await authorize(context, { kind: "withdrawal", quote: saved.quote as unknown as JsonObject });
  const original = decodeOpaque<WithdrawQuote>(withdrawalType, saved.quote.opaque);
  const beforeDispatch = saved;
  const claimed: WithdrawalIntent = { ...saved, dispatch: "requested", pendingDispatch: randomId() };
  await reviseIntent(context.kernel, key, saved, claimed); saved = claimed;
  if (context.signal?.aborted) {
    await reviseIntent(context.kernel, key, saved, beforeDispatch);
    context.signal.throwIfAborted();
  }
  try {
    const result = await client.update<WireResult>("withdraw", { quote: original }, original.cycles);
    const { pendingDispatch: _pending, ...finished } = saved;
    await reviseIntent(context.kernel, key, saved, finished);
    return withdrawalObservation(operationId, result, finished);
  } catch (error) {
    const result = await dispatchError(context, "withdraw", operationId, error);
    if (result.canDismiss) {
      const { pendingDispatch: _pending, ...finished } = saved;
      await reviseIntent(context.kernel, key, saved, { ...finished, dispatch: "rejected" });
    }
    return result;
  }
}
export async function operationStatus(context: MsgBusToolContext, operationId: string): Promise<OperationResult> {
  const client = await protocolClient(context);
  const saved = await loadIntent<SavedIntent>(context.kernel, `operation:${id(operationId)}`);
  const names = saved ? [saved.kind === "purchase" ? "purchase_status" : "withdraw_status"] : ["purchase_status", "withdraw_status"];
  for (const name of names) {
    const result = name === "purchase_status" ? (await client.purchaseWireStatus(operationId))?.purchase ?? null : first(await client.query<Option<WireResult>>(name, [{ requestId: operationId }]));
    if (result) {
      const view = name === "purchase_status" ? purchaseObservation(operationId, result, saved?.kind === "purchase" ? saved : undefined) : withdrawalObservation(operationId, result, saved?.kind === "withdrawal" ? saved : undefined);
      if (saved && JSON.stringify(saved.scope) !== JSON.stringify(scope(context, client.state.canisterId!, client.state.owner)) && view.nextAction === "resume") return { ...view, nextAction: "none", message: `${view.message} Continue from the original ${saved.scope.callerApp} ${saved.scope.root ? "root agent" : "application"} so its saved Wallet authority remains unchanged.` };
      return view;
    }
  }
  if (saved) {
    const same = JSON.stringify(saved.scope) === JSON.stringify(scope(context, client.state.canisterId!, client.state.owner));
    if (saved.kind === "purchase") {
      const view = purchaseObservation(operationId, null, saved);
      return !same && view.nextAction !== "none" ? { ...view, nextAction: "none", message: `${view.message} Continue from the original ${saved.scope.callerApp} ${saved.scope.root ? "root agent" : "application"}.` } : view;
    }
    const view = withdrawalObservation(operationId, null, saved);
    return same ? view : { ...view, nextAction: "none", message: `${view.message} Resume from the original ${saved.scope.callerApp}.` };
  }
  throw new Error("No saved operation was found for this ID.");
}
export async function recentOperations(context: MsgBusToolContext): Promise<OperationResult[]> {
  const client = await protocolClient(context), rows = await listIntents<SavedIntent>(context.kernel), result = new Map<string, OperationResult>();
  const page = await operationHistory(context, {});
  for (const operation of [...page.purchases, ...page.withdrawals].filter(needsPaymentRecovery)) result.set(operation.operationId, operation);
  for (const row of rows) if (row.id.startsWith("operation:") && row.value.scope.canister === client.state.canisterId && row.value.scope.owner === client.state.owner) result.set(row.value.quote.operationId, await operationStatus(context, row.value.quote.operationId));
  return [...result.values()];
}
export async function operationHistory(context: MsgBusToolContext, input: { purchaseCursor?: string; withdrawalCursor?: string }) {
  const client = await protocolClient(context);
  const cursor = (value?: string) => value === "done" ? { done: null } : !value || value === "start" ? { start: null } : { after: BigInt(value) };
  type Cursor = { start: null } | { done: null } | { after: bigint };
  const next = (value: Cursor): string => "after" in value ? String(value.after) : "done" in value ? "done" : "start";
  const page = await client.query<{ purchases: WireResult[]; withdrawals: WireResult[]; nextPurchaseCursor: Cursor; nextWithdrawalCursor: Cursor }>("operation_history", [{ purchaseCursor: cursor(input.purchaseCursor), withdrawalCursor: cursor(input.withdrawalCursor), limit: 24n }]);
  return { purchases: page.purchases.map(value => purchaseObservation(value.order!.requestId, value)), withdrawals: page.withdrawals.map(value => withdrawalObservation(value.withdrawal!.requestId, value)), nextPurchaseCursor: next(page.nextPurchaseCursor), nextWithdrawalCursor: next(page.nextWithdrawalCursor) };
}
export async function resumeOperation(context: MsgBusToolContext, operationId: string, fundingResult?: unknown): Promise<ActionResult> {
  const saved = await loadIntent<SavedIntent>(context.kernel, `operation:${id(operationId)}`);
  if (!saved) {
    // Restores original protocol quotes after uninstall. Never invent another financial request.
    const client = await protocolClient(context);
    const retained = await client.purchaseWireStatus(operationId), purchase = retained?.purchase;
    if (purchase) {
      const view = operationView(purchase);
      if (view.state === "complete" || view.nextAction === "none") return view;
      if (!needsPaymentRecovery(purchaseObservation(operationId, purchase))) throw new Error("No saved checkout or unresolved payment remains. Review a new purchase to continue.");
      const quote = first(purchase.quote ?? []);
      if (!quote || !("buyer" in quote)) throw new Error("The original purchase quote is unavailable. Do not recreate its payment.");
      return runPurchase(context, await client.purchaseView(quote, false, undefined, undefined, retained?.channel), fundingResult);
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
    const fresh = await refreshPurchase(client, previous, purchaseChannel(saved.quote));
    return runPurchase(context, samePurchase(previous, fresh.wire) ? saved.quote : await client.purchaseView(fresh.wire, false, undefined, saved.quote.releasePreferences, fresh.channel), fundingResult, true);
  }
  const previous = decodeOpaque<WithdrawQuote>(withdrawalType, saved.quote.opaque);
  const fresh = await client.query<WithdrawQuote>("withdraw_quote", [previous.request]);
  return runWithdrawal(context, sameWithdrawal(previous, fresh) ? saved.quote : client.withdrawalView(fresh), true);
}
