import { exposeTool, publishAppStateChange, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { initialize, configured, connect, protocolClient, randomId } from "./client.ts";
import { runPurchase, runWithdrawal, operationStatus, operationHistory, recentOperations, resumeOperation, type SavedIntent } from "./actions.ts";
import { loadIntent } from "./store.ts";
import { first, type Option, type WireResult } from "./protocol.ts";
import { beginPublication, beginArtifact, writeArtifact, finishPublication, quotePublication } from "./publishing.ts";
import type { PublicationPlan } from "./publication.ts";
import type { PurchaseQuote, WithdrawalQuote, PublicationQuote, PaymentToken, AppTier, RankingWindow } from "./view-types.ts";

const string = { type: "string" }, id = { type: "string", pattern: "^[0-9a-f]{32}$" }, token = { type: "string", enum: ["ICP", "ckBTC", "ckUSDC"] };
const object = (properties: JsonObject = {}, required: string[] = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const reads: JsonObject = { "neutron:effects": ["read", "network"], "neutron:longRunning": true };
const writes: JsonObject = { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:longRunning": true };
const reviewed: JsonObject = { ...writes, "neutron:consent": "provider_once" };
const sameApp = { "neutron:visibility": "same_app" };
const asJson = (value: unknown): JsonValue => value as JsonValue;
const text = (value: JsonValue | undefined, fallback = ""): string => typeof value === "string" ? value : fallback;

async function install(context: MsgBusToolContext, appIds: string[]): Promise<{ message: string }> {
  const client = await protocolClient(context);
  const prepared = await client.update<{ setupUrl: string }>("install_prepare", { requestId: randomId(), appIds });
  await context.kernel.callTool({ target: "kernel", name: "apps.install_offer", arguments: { kind: "repository_setup_url", url: prepared.setupUrl } }, 0);
  return { message: "The selected apps are ready for review in the Neutron installer." };
}
async function uiRead(context: MsgBusToolContext, method: string, args: JsonObject): Promise<unknown> {
  if (method === "initialize") return initialize(context);
  const client = await protocolClient(context);
  switch (method) {
    case "catalog": return client.catalog(args as unknown as { tier: AppTier; window: RankingWindow; search: string; cursor?: string });
    case "detail": return client.detail(String(args.appId));
    case "library": return client.library(typeof args.cursor === "string" ? args.cursor : undefined);
    case "publisherApps": return client.publisherApps(typeof args.cursor === "string" ? args.cursor : undefined);
    case "earnings": return client.earnings();
    case "quotePurchase": return client.quotePurchase(args as unknown as { appIds: string[]; token: PaymentToken; affiliateCode: string });
    case "quoteWithdrawal": return client.quoteWithdrawal(args as unknown as { token: PaymentToken; amountAtoms: string; destination: string });
    case "operation": return operationStatus(context, String(args.operationId));
    case "recentOperations": return recentOperations(context);
    case "quotePublication": return quotePublication(context, args.plan as unknown as PublicationPlan);
    default: throw new Error("Unknown marketplace read.");
  }
}
async function uiWrite(context: MsgBusToolContext, method: string, args: JsonObject): Promise<unknown> {
  if (context.agentMode || context.caller?.appId !== "marketplace" || context.caller.role !== "tile") throw new Error("This interface belongs to the marketplace tile.");
  if (method === "configure") return configured(context, { canisterId: String(args.canisterId), host: String(args.host) });
  if (method === "connect") return connect(context);
  const client = await protocolClient(context);
  switch (method) {
    case "purchase": return runPurchase(context, args.quote as unknown as PurchaseQuote);
    case "withdraw": return runWithdrawal(context, args.quote as unknown as WithdrawalQuote);
    case "resumeOperation": return resumeOperation(context, String(args.operationId));
    case "install": return install(context, args.appIds as string[]);
    case "rate": await client.update("rating_set", { appId: String(args.appId), stars: BigInt(Number(args.stars)), review: String(args.text) }); return null;
    case "createReferralCode": return (await client.update<{ code: string }>("referral_get_or_create", {})).code;
    case "beginPublication": return beginPublication(context, args.quote as unknown as PublicationQuote);
    case "beginArtifact": return beginArtifact(context, String(args.requestId), Number(args.index));
    case "writeArtifact": return writeArtifact(context, args as unknown as { requestId: string; index: number; offset: number; bytes: string });
    case "finishPublication": return finishPublication(context, String(args.requestId));
    default: throw new Error("Unknown marketplace action.");
  }
}
for (const [name, handler, effects] of [["ui_query", uiRead, reads], ["ui_update", uiWrite, writes]] as const) exposeTool(name, {
  title: "Marketplace tile interface", description: "Internal marketplace view interface.",
  inputSchema: object({ method: string, paramsJson: string }), outputSchema: object({ resultJson: string }), annotations: { ...effects, ...sameApp },
}, async (args, context) => {
  const parsed: unknown = JSON.parse(text(args.paramsJson, "{}"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid marketplace request.");
  const result = await handler(context, text(args.method), parsed as JsonObject);
  if (name === "ui_update") void publishAppStateChange("marketplace", Date.now()).catch(() => undefined);
  return { resultJson: JSON.stringify(result ?? null) };
});

function register(name: string, title: string, description: string, properties: JsonObject, required: string[], annotations: JsonObject, handler: (args: JsonObject, context: MsgBusToolContext) => Promise<unknown>): void {
  exposeTool(name, { title, description, inputSchema: object(properties, required), outputSchema: object({ version: { const: 1 }, result: { type: ["object", "array", "string", "null"], additionalProperties: true } }), annotations }, async (args, context) => ({ version: 1, result: asJson(await handler(args, context)) }));
}
register("marketplace_catalog_v1", "Discover marketplace apps", "Browse audited free or paid apps ranked by distinct acquisitions over rolling 7/30 days or all time. Queries go directly to the protocol. Follow nextCursor for another page.", { tier: { enum: ["free", "paid"] }, window: { enum: ["week", "month", "all"] }, search: string, cursor: string }, [], reads, async (args, context) => (await protocolClient(context)).catalog({ tier: args.tier === "paid" ? "paid" : "free", window: args.window === "month" || args.window === "all" ? args.window : "week", search: text(args.search), ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}) }));
register("marketplace_app_v1", "Inspect a marketplace app", "Read listing, current release audit and own rating. Approval identifies the exact package digest; ownership survives uninstall.", { appId: string }, ["appId"], reads, async (args, context) => (await protocolClient(context)).detail(text(args.appId)));
register("marketplace_library_v1", "Read acquired apps", "List this Neutron's free and purchased app entitlements. Revoked packages cannot be downloaded; ownership remains for a later approved replacement.", { cursor: string }, [], reads, async (args, context) => (await protocolClient(context)).library(typeof args.cursor === "string" ? args.cursor : undefined));
register("marketplace_earnings_v1", "Read marketplace earnings", "Read available and reserved earnings plus this Neutron's referral code. Balances are exact atomic amounts; no withdrawal occurs.", {}, [], reads, async (_args, context) => (await protocolClient(context)).earnings());
register("marketplace_connect_v1", "Authorize browser marketplace reads", "Register this app's recoverable browser read delegate through Neutron with the protocol's fixed attached cycle fee. It grants no browser update authority and does not change the Neutron that owns purchases.", {}, [], writes, async (_args, context) => connect(context));
const purchaseProperties = { operationId: id, appIds: { type: "array", items: string }, token, affiliateCode: string, fundingResult: { type: "object", additionalProperties: true } };
register("marketplace_quote_v1", "Review app purchase costs", "Preview exact app prices, referral discount, actual-payment developer/affiliate/burn allocations, ledger fees and attached cycle estimate. This is a read and grants no purchase authority.", purchaseProperties, ["operationId", "appIds", "token"], reads, async (args, context) => (await protocolClient(context)).quotePurchase({ operationId: text(args.operationId), appIds: args.appIds as string[], token: args.token as PaymentToken, affiliateCode: text(args.affiliateCode) }));
register("marketplace_purchase_v1", "Acquire marketplace apps", "Acquire free or paid apps for this Neutron. Normal agents open exact owner review; root agents use the existing permission judge. Paid root requests return the original Wallet fundingInstructions: call them at root depth and supply raw fundingResult to this SAME method and operationId. Preserve original inputs after interruption. Approval is not purchase completion. One entitlement includes future approved updates.", purchaseProperties, ["operationId", "appIds", "token"], reviewed, async (args, context) => {
  const saved = await loadIntent<SavedIntent>(context.kernel, `operation:${text(args.operationId)}`);
  if (saved) {
    if (saved.kind !== "purchase" || JSON.stringify(saved.quote.appIds) !== JSON.stringify(args.appIds) || saved.quote.token !== args.token || saved.quote.affiliateCode !== text(args.affiliateCode)) throw new Error("This operation has different saved purchase inputs.");
    return resumeOperation(context, text(args.operationId), args.fundingResult);
  }
  const client = await protocolClient(context);
  const original = first(await client.query<Option<WireResult>>("purchase_status", [{ requestId: text(args.operationId) }]));
  if (original) {
    const wire = first(original.quote ?? []);
    if (!wire || !("buyer" in wire)) throw new Error("The original purchase quote is unavailable. Do not recreate its payment.");
    const quote = await client.purchaseView(wire);
    if (JSON.stringify(quote.appIds) !== JSON.stringify(args.appIds) || quote.token !== args.token || quote.affiliateCode !== text(args.affiliateCode)) throw new Error("These inputs differ from the original protocol purchase.");
    return resumeOperation(context, text(args.operationId), args.fundingResult);
  }
  const quote = await client.quotePurchase({ operationId: text(args.operationId), appIds: args.appIds as string[], token: args.token as PaymentToken, affiliateCode: text(args.affiliateCode) });
  return runPurchase(context, quote, args.fundingResult);
});
register("marketplace_operation_v1", "Read saved marketplace operation", "Query the original purchase or withdrawal without dispatching another financial effect. Pending and unknown outcomes require the same saved operation ID, never another payment.", { operationId: id }, ["operationId"], reads, async (args, context) => operationStatus(context, text(args.operationId)));
register("marketplace_history_v1", "Read durable marketplace history", "Discover this Neutron's original purchases and withdrawals, including after this UI app was uninstalled. Follow both returned cursors exactly; done skips an exhausted stream, a numeric cursor reads the next page, and omitted/start begins at newest. This only reads outcomes.", { purchaseCursor: string, withdrawalCursor: string }, [], reads, async (args, context) => operationHistory(context, { ...(typeof args.purchaseCursor === "string" ? { purchaseCursor: args.purchaseCursor } : {}), ...(typeof args.withdrawalCursor === "string" ? { withdrawalCursor: args.withdrawalCursor } : {}) }));
register("marketplace_withdraw_v1", "Withdraw marketplace earnings", "Withdraw a reviewed total debit from earned credit; the ledger fee is deducted from that debit. Same operation ID and original inputs resume an interrupted withdrawal without double spending. Normal agents require owner review; root uses its permission judge.", { operationId: id, token, amountAtoms: string, destination: string }, ["operationId", "token", "amountAtoms", "destination"], reviewed, async (args, context) => {
  const saved = await loadIntent<SavedIntent>(context.kernel, `operation:${text(args.operationId)}`);
  if (saved) {
    if (saved.kind !== "withdrawal" || saved.quote.token !== args.token || saved.quote.debit.atoms !== args.amountAtoms || saved.quote.destination !== args.destination) throw new Error("This operation has different saved withdrawal inputs.");
    return resumeOperation(context, text(args.operationId), undefined);
  }
  const client = await protocolClient(context);
  const original = first(await client.query<Option<WireResult>>("withdraw_status", [{ requestId: text(args.operationId) }]));
  if (original) {
    const wire = first(original.quote ?? []);
    if (!wire || !("netAmount" in wire)) throw new Error("The original withdrawal quote is unavailable. Do not recreate its transfer.");
    const quote = client.withdrawalView(wire);
    if (quote.token !== args.token || quote.debit.atoms !== args.amountAtoms || quote.destination !== args.destination) throw new Error("These inputs differ from the original protocol withdrawal.");
    return resumeOperation(context, text(args.operationId), undefined);
  }
  const quote = await client.quoteWithdrawal({ operationId: text(args.operationId), token: args.token as PaymentToken, amountAtoms: text(args.amountAtoms), destination: text(args.destination) });
  return runWithdrawal(context, quote);
});
register("marketplace_install_v1", "Install acquired apps", "Prepare the latest approved entitled package set and open the generic Neutron installer for one or multiple apps. Installation retains Neutron's standard review. This does not purchase missing apps.", { appIds: { type: "array", items: string } }, ["appIds"], writes, async (args, context) => install(context, args.appIds as string[]));
register("marketplace_rate_v1", "Rate an acquired app", "Save one editable 1–5 star review for an app this Neutron acquired free or paid. Charges the fixed protocol update estimate through Neutron.", { appId: string, stars: { type: "integer", minimum: 1, maximum: 5 }, review: string }, ["appId", "stars", "review"], writes, async (args, context) => {
  const client = await protocolClient(context);
  await client.update("rating_set", { appId: text(args.appId), stars: BigInt(Number(args.stars)), review: text(args.review) });
  return { saved: true };
});
