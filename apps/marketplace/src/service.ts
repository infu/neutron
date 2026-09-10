import { exposeTool, publishAppStateChange, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { initialize, configured, connect, protocolClient, randomId } from "./client.ts";
import { runPurchase, runWithdrawal, operationStatus, operationHistory, recentOperations, resumeOperation, type SavedIntent } from "./actions.ts";
import { quoteInstallation, installApplications, installationStatus, recentInstallations, markInstallationOpened, resumeInstallation } from "./install.ts";
import { loadIntent } from "./store.ts";
import {
  quoteEthereumPurchase, runEthereumPurchase, resumeEthereumPurchase, ethereumSavedStatus, recentEthereumPurchases,
  prepareEthereumBrowser, ethereumJournalRead, ethereumJournalClaim, ethereumJournalRecord, finishEthereumBrowser,
  settleEthereumPurchase, cancelEthereumPurchase, verifyEthereumTransaction,
} from "./ethereum_actions.ts";
import { ethereumHistory, ethereumInvoiceStatus } from "./ethereum_client.ts";
import type { EthereumFundingKind, EthereumFundingRecord } from "./ethereum.ts";
import { first, type Option, type WireResult } from "./protocol.ts";
import { beginPublication, beginArtifact, writeArtifact, finishPublication, quotePublication } from "./publishing.ts";
import type { PublicationPlan } from "./publication.ts";
import type { PurchaseQuote, WithdrawalQuote, PublicationQuote, PaymentToken, AppTier, RankingWindow, EthereumPurchaseSelection, InstallationQuote } from "./view-types.ts";

const string = { type: "string" }, id = { type: "string", pattern: "^[0-9a-f]{32}$" }, token = { type: "string", enum: ["ICP", "ckBTC", "ckUSDC"] };
const object = (properties: JsonObject = {}, required: string[] = Object.keys(properties)): JsonObject => ({ type: "object", properties, required, additionalProperties: false });
const reads: JsonObject = { "neutron:effects": ["read", "network"], "neutron:longRunning": true };
const writes: JsonObject = { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:longRunning": true };
const reviewed: JsonObject = { ...writes, "neutron:consent": "provider_once" };
const sameApp = { "neutron:visibility": "same_app" };
const asJson = (value: unknown): JsonValue => value as JsonValue;
const text = (value: JsonValue | undefined, fallback = ""): string => typeof value === "string" ? value : fallback;

function requireMarketplaceTile(context: MsgBusToolContext): void {
  if (context.agentMode || context.caller?.appId !== "marketplace" || context.caller.role !== "tile") throw new Error("This interface belongs to the marketplace tile.");
}
function fundingKind(value: unknown): EthereumFundingKind {
  if (value !== "approval" && value !== "deposit") throw new Error("Select the original approval or deposit step.");
  return value;
}
async function status(context: MsgBusToolContext, operationId: string) {
  return await installationStatus(context, operationId) ?? await ethereumSavedStatus(context, operationId) ?? operationStatus(context, operationId);
}
async function resume(context: MsgBusToolContext, operationId: string) {
  const installation = await resumeInstallation(context, operationId);
  if (installation) return installation;
  const ethereum = await ethereumSavedStatus(context, operationId);
  if (ethereum) {
    if (ethereum.ethereumWallet === "browser") throw new Error("Continue this Ethereum purchase from the marketplace tile with its original browser wallet.");
    return resumeEthereumPurchase(context, operationId);
  }
  return resumeOperation(context, operationId);
}
async function requireIcOperation(context: MsgBusToolContext, operationId: string): Promise<void> {
  if (await ethereumSavedStatus(context, operationId)) throw new Error("This operation ID belongs to an Ethereum purchase. Continue its original payment route.");
}
async function history(context: MsgBusToolContext, args: JsonObject) {
  const [ic, ethereum, installations] = await Promise.all([
    operationHistory(context, { ...(typeof args.purchaseCursor === "string" ? { purchaseCursor: args.purchaseCursor } : {}), ...(typeof args.withdrawalCursor === "string" ? { withdrawalCursor: args.withdrawalCursor } : {}) }),
    args.ethereumCursor === "done" ? Promise.resolve({ items: [], nextCursor: null }) : ethereumHistory(context, typeof args.ethereumCursor === "string" && args.ethereumCursor !== "start" ? args.ethereumCursor : undefined),
    recentInstallations(context),
  ]);
  return { ...ic, ethereumPurchases: ethereum.items, nextEthereumCursor: ethereum.nextCursor ?? "done", installations };
}
async function uiRead(context: MsgBusToolContext, method: string, args: JsonObject): Promise<unknown> {
  const client = await protocolClient(context);
  switch (method) {
    case "catalog": return client.catalog(args as unknown as { tier: AppTier; window: RankingWindow; search: string; cursor?: string });
    case "detail": return client.detail(String(args.appId));
    case "library": return client.library(typeof args.cursor === "string" ? args.cursor : undefined);
    case "publisherApps": return client.publisherApps(typeof args.cursor === "string" ? args.cursor : undefined);
    case "earnings": return client.earnings();
    case "quotePurchase": {
      if (args.ethereum) {
        const input = args as unknown as { appIds: string[]; affiliateCode: string; ethereum: EthereumPurchaseSelection };
        if (input.ethereum.wallet === "browser") requireMarketplaceTile(context);
        return quoteEthereumPurchase(context, input);
      }
      return client.quotePurchase(args as unknown as { appIds: string[]; token: PaymentToken; affiliateCode: string });
    }
    case "quoteInstallation": return quoteInstallation(context, args.appIds as string[], typeof args.operationId === "string" ? args.operationId : undefined);
    case "quoteWithdrawal": return client.quoteWithdrawal(args as unknown as { token: PaymentToken; amountAtoms: string; destination: string });
    case "operation": return status(context, String(args.operationId));
    case "recentOperations": {
      const [ic, ethereum, installations] = await Promise.all([recentOperations(context), recentEthereumPurchases(context), recentInstallations(context)]);
      return [...new Map([...ic, ...ethereum, ...installations].map(result => [result.operationId, result])).values()];
    }
    case "ethereumJournalRead": return ethereumJournalRead(context, String(args.operationId), fundingKind(args.kind));
    case "quotePublication": return quotePublication(context, args.plan as unknown as PublicationPlan);
    default: throw new Error("Unknown marketplace read.");
  }
}
async function uiWrite(context: MsgBusToolContext, method: string, args: JsonObject): Promise<unknown> {
  requireMarketplaceTile(context);
  if (method === "initialize") return initialize(context);
  if (method === "configure") return configured(context, { canisterId: String(args.canisterId), host: String(args.host) });
  if (method === "connect") return connect(context);
  const client = await protocolClient(context);
  switch (method) {
    case "purchase": {
      const quote = args.quote as unknown as PurchaseQuote;
      if (quote.ethereum) {
        if (quote.ethereum.wallet === "browser") throw new Error("Use the marketplace browser-wallet checkout to fund this invoice.");
        return runEthereumPurchase(context, quote);
      }
      await requireIcOperation(context, quote.operationId);
      return runPurchase(context, quote);
    }
    case "ethereumPrepareBrowser": return prepareEthereumBrowser(context, args.quote as unknown as PurchaseQuote | undefined, typeof args.operationId === "string" ? args.operationId : undefined);
    case "ethereumJournalClaim": return ethereumJournalClaim(context, String(args.operationId), args.record as unknown as EthereumFundingRecord);
    case "ethereumJournalRecord": return ethereumJournalRecord(context, String(args.operationId), args.previous as unknown as EthereumFundingRecord, args.next as unknown as EthereumFundingRecord);
    case "ethereumVerifyBrowser": return finishEthereumBrowser(context, String(args.operationId));
    case "ethereumCancel": return cancelEthereumPurchase(context, String(args.operationId));
    case "ethereumVerifyOriginal": return verifyEthereumTransaction(context, String(args.operationId), String(args.transactionHash));
    case "withdraw": {
      const quote = args.quote as unknown as WithdrawalQuote;
      await requireIcOperation(context, quote.operationId);
      return runWithdrawal(context, quote);
    }
    case "resumeOperation": return resume(context, String(args.operationId));
    case "install": return installApplications(context, args.appIds as string[], args.quote as unknown as InstallationQuote);
    case "installationOpened": return markInstallationOpened(context, args.quote as unknown as InstallationQuote);
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
register("marketplace_connect_v1", "Restore marketplace access", "Reuse this Neutron's saved browser read delegate, or register it once through Neutron with the protocol's fixed attached cycle fee if missing. The app sets up access automatically on opening. This explicit recovery tool can restore revoked access; transient read failures never trigger registration. Purchases still belong to this Neutron, and no browser update authority is granted.", {}, [], writes, async (_args, context) => connect(context));
const purchaseProperties = { operationId: id, appIds: { type: "array", items: string }, token, affiliateCode: string, fundingResult: { type: "object", additionalProperties: true } };
register("marketplace_quote_v1", "Review app purchase costs", "Preview exact app prices, referral discount, actual-payment developer/affiliate/burn allocations, ledger fees and attached cycle estimate. This is a read and grants no purchase authority.", purchaseProperties, ["operationId", "appIds", "token"], reads, async (args, context) => (await protocolClient(context)).quotePurchase({ operationId: text(args.operationId), appIds: args.appIds as string[], token: args.token as PaymentToken, affiliateCode: text(args.affiliateCode) }));
register("marketplace_purchase_v1", "Acquire marketplace apps", "Acquire free or paid apps for this Neutron. Normal agents open exact owner review; root agents use the existing permission judge. Paid root requests return the original Wallet fundingInstructions: call them at root depth and supply raw fundingResult to this SAME method and operationId. Preserve original inputs after interruption. Approval is not purchase completion. One entitlement includes future approved updates.", purchaseProperties, ["operationId", "appIds", "token"], reviewed, async (args, context) => {
  await requireIcOperation(context, text(args.operationId));
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
const ethereumPurchaseProperties = { operationId: id, appIds: { type: "array", items: string }, affiliateCode: string };
register("marketplace_ethereum_quote_v1", "Review Ethereum USDC app purchase", "Preview app prices and allocations paid in canonical USDC on Ethereum Mainnet from EVM Wallet's main account. Includes the ckUSDC collection fee and fixed Neutron cycle costs for invoice preparation and independent receipt verification; Ethereum approval/deposit gas is additional. This read signs nothing. Browser-wallet checkout is available only through the marketplace tile.", ethereumPurchaseProperties, ["operationId", "appIds"], reads, async (args, context) => quoteEthereumPurchase(context, { operationId: text(args.operationId), appIds: args.appIds as string[], affiliateCode: text(args.affiliateCode), ethereum: { wallet: "evm_wallet" } }));
register("marketplace_ethereum_purchase_v1", "Acquire apps with Ethereum USDC", "Prepare and fund one retained Ethereum USDC invoice using EVM Wallet. Normal agents open owner review; root agents use invocation-bound permission review. Approval is not payment. Only protocol-verified Ethereum payment grants app access; ckUSDC wrapping and revenue settlement can continue afterward. Preserve operationId and original app/referral inputs after interruption; never recreate a payment to resolve pending status.", ethereumPurchaseProperties, ["operationId", "appIds"], reviewed, async (args, context) => {
  const operationId = text(args.operationId);
  if (await loadIntent<SavedIntent>(context.kernel, `operation:${operationId}`)) throw new Error("This operation ID belongs to an IC purchase or withdrawal. Continue its original route.");
  const saved = await loadIntent<{ quote: PurchaseQuote }>(context.kernel, `ethereum:operation:${operationId}`);
  if (saved) {
    if (JSON.stringify(saved.quote.appIds) !== JSON.stringify(args.appIds) || saved.quote.affiliateCode !== text(args.affiliateCode) || saved.quote.ethereum?.wallet !== "evm_wallet") throw new Error("This operation has different saved Ethereum purchase inputs or wallet.");
    return resumeEthereumPurchase(context, operationId);
  }
  const original = await ethereumInvoiceStatus(context, operationId);
  if (original) {
    if (JSON.stringify(original.quote.request.appIds) !== JSON.stringify(args.appIds) || (first(original.quote.request.referralCode) ?? "") !== text(args.affiliateCode)) throw new Error("These inputs differ from the original Ethereum invoice.");
    return resumeEthereumPurchase(context, operationId);
  }
  return runEthereumPurchase(context, await quoteEthereumPurchase(context, { operationId, appIds: args.appIds as string[], affiliateCode: text(args.affiliateCode), ethereum: { wallet: "evm_wallet" } }));
});
register("marketplace_ethereum_continue_v1", "Continue original Ethereum app purchase", "Continue the retained EVM Wallet payment and independently verify its existing Ethereum receipt. Never creates a replacement payment ID. Browser-wallet invoices must be continued in their original marketplace tile. App access does not wait for later wrapping accounting.", { operationId: id }, ["operationId"], reviewed, async (args, context) => resumeEthereumPurchase(context, text(args.operationId)));
register("marketplace_ethereum_verify_v1", "Verify an original Ethereum payment", "Recover an already sent payment by supplying its original Ethereum transaction hash and invoice ID. The protocol independently verifies its exact payer, USDC amount and invoice recipient before granting access. Does not send, approve or replace any Ethereum transaction. Exact review includes the fixed verification cycle charge; a rejected or unavailable proof never authorizes another payment.", { operationId: id, transactionHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } }, ["operationId", "transactionHash"], reviewed, async (args, context) => verifyEthereumTransaction(context, text(args.operationId), text(args.transactionHash)));
register("marketplace_ethereum_settle_v1", "Reconcile Ethereum wrapping settlement", "Ask the protocol to reconcile the original invoice's ckUSDC wrapping and accounting using its fixed attached cycle estimate. Does not send another Ethereum payment. App access already granted by a verified Ethereum payment remains available while settlement runs; normal settlement is also handled by the protocol.", { operationId: id }, ["operationId"], reviewed, async (args, context) => settleEthereumPurchase(context, text(args.operationId)));
register("marketplace_ethereum_cancel_v1", "Cancel an unpaid Ethereum invoice", "Cancel an invoice before app access is granted. This cannot cancel a transaction already sent on Ethereum and does not refund a purchased app. A late deposit remains attributable to this original invoice for buyer credit recovery; keep the original ID and transaction evidence. Exact review precedes the fixed-cycle protocol update.", { operationId: id }, ["operationId"], reviewed, async (args, context) => cancelEthereumPurchase(context, text(args.operationId)));
register("marketplace_operation_v1", "Read saved marketplace operation", "Query the original purchase or withdrawal without dispatching another financial effect. Pending and unknown outcomes require the same saved operation ID, never another payment.", { operationId: id }, ["operationId"], reads, async (args, context) => status(context, text(args.operationId)));
register("marketplace_history_v1", "Read durable marketplace history", "Discover this Neutron's original IC purchases, Ethereum purchases and withdrawals, including after this UI app was uninstalled. Follow each returned cursor exactly; done skips an exhausted stream, a numeric cursor reads the next page, and omitted/start begins at newest. This only reads outcomes. Ethereum app access and later wrapping settlement are reported separately.", { purchaseCursor: string, withdrawalCursor: string, ethereumCursor: string }, [], reads, async (args, context) => history(context, args));
register("marketplace_withdraw_v1", "Withdraw marketplace earnings", "Withdraw a reviewed total debit from earned credit; the ledger fee is deducted from that debit. Same operation ID and original inputs resume an interrupted withdrawal without double spending. Normal agents require owner review; root uses its permission judge.", { operationId: id, token, amountAtoms: string, destination: string }, ["operationId", "token", "amountAtoms", "destination"], reviewed, async (args, context) => {
  await requireIcOperation(context, text(args.operationId));
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
register("marketplace_install_quote_v1", "Review installation preparation cost", "Read the exact cycle cost of preparing the selected apps for Neutron's installer. This quote performs no charged update. The later repository grant and installation costs are reviewed separately by Neutron.", { appIds: { type: "array", items: string }, operationId: id }, ["appIds"], reads, async (args, context) => quoteInstallation(context, args.appIds as string[], typeof args.operationId === "string" ? args.operationId : undefined));
register("marketplace_install_v1", "Install acquired apps", "Review the exact preparation cycle cost and prepare the latest approved entitled apps for the generic Neutron installer. Normal agents open owner review; Root agents use scoped authorization. The Kernel separately reviews later repository grant and installation costs. Retain operationId after an interrupted reply; this does not purchase missing apps.", { appIds: { type: "array", items: string }, operationId: id, quote: { type: "object", additionalProperties: true } }, ["appIds"], reviewed, async (args, context) => installApplications(context, args.appIds as string[], args.quote as unknown as InstallationQuote | undefined, typeof args.operationId === "string" ? args.operationId : undefined));
register("marketplace_rate_v1", "Rate an acquired app", "Save one editable 1–5 star review for an app this Neutron acquired free or paid. Charges the fixed protocol update estimate through Neutron.", { appId: string, stars: { type: "integer", minimum: 1, maximum: 5 }, review: string }, ["appId", "stars", "review"], writes, async (args, context) => {
  const client = await protocolClient(context);
  await client.update("rating_set", { appId: text(args.appId), stars: BigInt(Number(args.stars)), review: text(args.review) });
  return { saved: true };
});
