import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { protocolClient, randomId, cycleView } from "./client.ts";
import { scope, assertScope, authorize, type Scope } from "./actions.ts";
import { loadIntent, saveIntent, reviseIntent, listIntents } from "./store.ts";
import { checkoutType, decodeOpaque, type Checkout } from "./protocol.ts";
import { ethereumQuote, ethereumInvoiceView, ethereumInvoiceStatus, ethereumOperationView, ethereumFees, ethereumHistory } from "./ethereum_client.ts";
import type { EthereumInvoiceResult } from "./ethereum_protocol.ts";
import { buildEthereumFundingPlan, principalToEthereumWord, createEthereumFundingWallet, readEthereumFundingWalletState, mergeEthereumFundingRecords, executeEvmFundingStep, type EthereumFundingPlan, type EthereumFundingRecord, type EthereumFundingKind, type EthereumFundingJournal } from "./ethereum.ts";
import type { OperationResult, PurchaseQuote, EthereumPurchaseSelection, EthereumWalletSource } from "./view-types.ts";

type SavedEthereum = { version: 1; kind: "ethereum_purchase"; scope: Scope; quote: PurchaseQuote; source: EthereumWalletSource; requestIds: { approval: string; deposit: string }; plan: EthereumFundingPlan | null };
type JournalEntry = { claimNonce: string; record: EthereumFundingRecord };
const key = (id: string) => `ethereum:operation:${id}`;
function operationId(value: string) { if (!/^[0-9a-f]{32}$/.test(value)) throw new Error("Retain the original 32-character Ethereum operation ID."); return value; }
function journalKey(id: string, kind: EthereumFundingKind) { if (kind !== "approval" && kind !== "deposit") throw new Error("Unknown Ethereum payment step."); return `ethereum:step:${operationId(id)}:${kind}`; }
export async function ethereumPayer(context: MsgBusToolContext): Promise<string> {
  const account = (await createEthereumFundingWallet(context).accounts()).accounts.find(account => account.accountId === "main");
  if (!account) throw new Error("Create the main EVM Wallet account before paying with it.");
  return account.address;
}
export async function quoteEthereumPurchase(context: MsgBusToolContext, input: { appIds: string[]; affiliateCode: string; ethereum: EthereumPurchaseSelection; operationId?: string }): Promise<PurchaseQuote> {
  if (input.operationId && await loadIntent(context.kernel, `operation:${operationId(input.operationId)}`)) throw new Error("This operation ID already belongs to an IC payment. Resume its original payment rail.");
  const saved = input.operationId ? await loadIntent<SavedEthereum>(context.kernel, key(operationId(input.operationId))) : null;
  if (saved) {
    const client = await protocolClient(context); assertScope(saved.scope, scope(context, client.state.canisterId!, client.state.owner));
    if (JSON.stringify(saved.quote.appIds) !== JSON.stringify(input.appIds) || saved.source !== input.ethereum.wallet || saved.quote.affiliateCode !== input.affiliateCode.trim()) throw new Error("Resume the original Ethereum invoice instead of changing its purchase inputs.");
    return saved.quote;
  }
  const selection = input.ethereum.wallet === "evm_wallet" ? { wallet: "evm_wallet" as const, payerAddress: await ethereumPayer(context) } : input.ethereum;
  return ethereumQuote(context, { ...input, ethereum: selection });
}
async function savedEthereum(context: MsgBusToolContext, id: string, enforceScope = true): Promise<SavedEthereum> {
  const saved = await loadIntent<SavedEthereum>(context.kernel, key(operationId(id)));
  if (!saved) throw new Error("The original Ethereum checkout is not saved in this app. Inspect its protocol status before paying again.");
  const client = await protocolClient(context);
  if (enforceScope) assertScope(saved.scope, scope(context, client.state.canisterId!, client.state.owner));
  else if (saved.scope.canister !== client.state.canisterId || saved.scope.owner !== client.state.owner) throw new Error("This invoice belongs to another marketplace or Neutron.");
  return saved;
}
function assertBrowser(context: MsgBusToolContext, saved?: SavedEthereum) {
  if (context.agentMode || context.caller?.appId !== "marketplace" || context.caller.role !== "tile" || saved && saved.source !== "browser") throw new Error("Browser wallet payments require the owner's Marketplace tile. Agents use EVM Wallet.");
}
function planFor(result: EthereumInvoiceResult, recipientPrincipal: string, ids: SavedEthereum["requestIds"]): EthereumFundingPlan {
  const invoice = result.invoice;
  const route = { chainId: String(invoice.route.chainId), tokenAddress: invoice.route.token, helperAddress: invoice.route.helper, minterAddress: invoice.route.minterAddress, recipientPrincipal };
  const plan = buildEthereumFundingPlan({ operationId: invoice.requestId, amountAtoms: String(invoice.grossAtoms), payerAddress: invoice.payer, principalWord: principalToEthereumWord(recipientPrincipal), subaccountWord: `0x${[...invoice.subaccount].map(byte => byte.toString(16).padStart(2, "0")).join("")}`, route }, route, ids);
  // The protocol and browser independently encode the official helper call.
  for (const kind of ["approval", "deposit"] as const) {
    const returned = result.payment[kind === "approval" ? "approve" : "deposit"], expected = plan.steps[kind].transaction;
    if (returned.chainId !== 1n || returned.from.toLowerCase() !== expected.from.toLowerCase() || returned.to.toLowerCase() !== expected.to.toLowerCase() || returned.value !== 0n || returned.data.toLowerCase() !== expected.data.toLowerCase()) throw new Error("The protocol payment call does not match its frozen Ethereum invoice.");
  }
  return plan;
}
async function prepare(context: MsgBusToolContext, supplied?: PurchaseQuote, id?: string): Promise<{ saved: SavedEthereum; result: EthereumInvoiceResult }> {
  const client = await protocolClient(context), currentScope = scope(context, client.state.canisterId!, client.state.owner);
  const requestId = operationId(supplied?.operationId ?? id ?? "");
  let saved = await loadIntent<SavedEthereum>(context.kernel, key(requestId));
  if (!saved) {
    if (!supplied?.ethereum) throw new Error("Review an Ethereum checkout before preparing its invoice.");
    if (await loadIntent(context.kernel, `operation:${requestId}`)) throw new Error("This operation ID already belongs to an IC payment.");
    if (supplied.ethereum.wallet === "browser") assertBrowser(context);
    const wire = decodeOpaque<Checkout>(checkoutType, supplied.opaque);
    if (wire.buyer.toText() !== currentScope.owner || wire.request.requestId !== requestId) throw new Error("The checkout does not belong to this Neutron and operation.");
    const canonical = await ethereumQuote(context, { appIds: wire.request.appIds, affiliateCode: wire.request.referralCode[0] ?? "", ethereum: supplied.ethereum, operationId: requestId });
    if (canonical.commitment !== supplied.commitment || canonical.totalDebit.atoms !== supplied.totalDebit.atoms || JSON.stringify(canonical.ethereum) !== JSON.stringify(supplied.ethereum)) throw new Error("The Ethereum checkout costs or payer changed. Review a fresh quote before preparing it.");
    if (supplied.ethereum.wallet === "evm_wallet" && (await ethereumPayer(context)).toLowerCase() !== supplied.ethereum.payerAddress.toLowerCase()) throw new Error("The reviewed EVM payer changed.");
    await authorize(context, { kind: "purchase", quote: canonical as unknown as JsonObject });
    saved = { version: 1, kind: "ethereum_purchase", scope: currentScope, source: supplied.ethereum.wallet, quote: canonical, requestIds: { approval: randomId(), deposit: randomId() }, plan: null };
    await saveIntent(context.kernel, key(requestId), saved);
  } else assertScope(saved.scope, currentScope);
  if (saved.source === "browser") assertBrowser(context, saved);
  let result = await ethereumInvoiceStatus(context, requestId);
  if (!result) {
    const fees = await ethereumFees(context);
    if (String(fees.prepare.totalCycles) !== saved.quote.ethereum!.prepareCycles.total) throw new Error("The invoice preparation cycle cost changed. Review current costs before continuing.");
    result = await client.update<EthereumInvoiceResult>("ethereum_prepare", { quote: decodeOpaque<Checkout>(checkoutType, saved.quote.opaque), payer: saved.quote.ethereum!.payerAddress }, fees.prepare);
  }
  const canonical = await ethereumInvoiceView(context, result, saved.source), plan = planFor(result, client.info.canister.toText(), saved.requestIds);
  if (saved.plan && JSON.stringify(saved.plan) !== JSON.stringify(plan)) throw new Error("The protocol changed a saved invoice's Ethereum payment call. Do not pay again.");
  if (!saved.plan) {
    await authorize(context, { kind: "purchase", quote: canonical as unknown as JsonObject }, true);
    const replacement = { ...saved, quote: canonical, plan };
    await reviseIntent(context.kernel, key(requestId), saved, replacement); saved = replacement;
  }
  return { saved, result };
}
function validateRecord(saved: SavedEthereum, record: EthereumFundingRecord) {
  if (!saved.plan || record.version !== 1 || record.invoiceId !== saved.quote.operationId || record.source !== saved.source || JSON.stringify(record.step) !== JSON.stringify(saved.plan.steps[record.step.kind])) throw new Error("The funding journal does not match its retained invoice.");
}
function fundingJournal(context: MsgBusToolContext, saved: SavedEthereum): EthereumFundingJournal {
  return {
    async read(kind) { return (await loadIntent<JournalEntry>(context.kernel, journalKey(saved.quote.operationId, kind)))?.record ?? null; },
    async claim(record) {
      validateRecord(saved, record); const storageKey = journalKey(saved.quote.operationId, record.step.kind);
      const existing = await loadIntent<JournalEntry>(context.kernel, storageKey);
      if (existing) return { claimed: false, record: existing.record };
      const next = { claimNonce: randomId(), record };
      try { await saveIntent(context.kernel, storageKey, next); }
      catch (error) {
        const observed = await loadIntent<JournalEntry>(context.kernel, storageKey);
        if (!observed) throw error;
        return { claimed: observed.claimNonce === next.claimNonce, record: observed.record };
      }
      return { claimed: true, record };
    },
    async record(previous, next) {
      validateRecord(saved, previous); validateRecord(saved, next);
      const storageKey = journalKey(saved.quote.operationId, previous.step.kind), existing = await loadIntent<JournalEntry>(context.kernel, storageKey);
      if (!existing) throw new Error("The original payment journal is unavailable.");
      const merged = mergeEthereumFundingRecords(previous, existing.record, next);
      if (JSON.stringify(existing.record) === JSON.stringify(merged)) return existing.record;
      await reviseIntent(context.kernel, storageKey, existing, { ...existing, record: merged }); return merged;
    },
  };
}
function stepResult(saved: SavedEthereum, record: EthereumFundingRecord): OperationResult {
  return { operationId: saved.quote.operationId, appIds: saved.quote.appIds, ethereumWallet: saved.source, ...(record.transactionHash ? { ethereumTransactionHash: record.transactionHash } : {}), state: record.state === "reverted" || record.state === "rejected" ? "failed" : "pending", nextAction: record.state === "reverted" || record.state === "rejected" || record.state === "unknown" && !record.transactionHash ? "review" : "resume", message: record.message ?? "Retain the original Ethereum transaction and continue its receipt check." };
}
async function verify(context: MsgBusToolContext, saved: SavedEthereum, result: EthereumInvoiceResult): Promise<OperationResult> {
  if (result.entitled || result.active) return ethereumOperationView(result, saved.source);
  if ("settle" in result.nextAction) return invoiceAction(context, saved.quote.operationId, "settle");
  const deposit = await fundingJournal(context, saved).read("deposit");
  if (!deposit || deposit.state !== "confirmed" || !deposit.transactionHash) return deposit ? stepResult(saved, deposit) : ethereumOperationView(result, saved.source);
  const client = await protocolClient(context), fees = await ethereumFees(context);
  if (String(fees.verify.totalCycles) !== saved.quote.ethereum!.verifyCycles.total) throw new Error("The receipt-verification cycle fee changed. Review current fees before verifying the saved payment.");
  // Protocol receipt proof, not this local observation, is the purchase authority.
  const verified = await client.update<EthereumInvoiceResult>("ethereum_verify", { requestId: saved.quote.operationId, transactionHash: deposit.transactionHash }, fees.verify);
  return ethereumOperationView(verified, saved.source);
}
export async function runEthereumPurchase(context: MsgBusToolContext, quote: PurchaseQuote): Promise<OperationResult> {
  if (quote.ethereum?.wallet !== "evm_wallet") throw new Error("Browser payments must run from the connected Marketplace tile.");
  return executeEthereum(context, quote);
}
async function executeEthereum(context: MsgBusToolContext, quote?: PurchaseQuote, id?: string): Promise<OperationResult> {
  const { saved, result } = await prepare(context, quote, id);
  if (saved.source !== "evm_wallet") throw new Error("Reconnect the original browser wallet to continue this invoice.");
  if (result.entitled || result.active) return ethereumOperationView(result, saved.source);
  if ("settle" in result.nextAction) return invoiceAction(context, saved.quote.operationId, "settle");
  if (!("pay_ethereum" in result.nextAction || "verify_ethereum" in result.nextAction)) return ethereumOperationView(result, saved.source);
  const journal = fundingJournal(context, saved), wallet = createEthereumFundingWallet(context);
  const depositExisting = await journal.read("deposit");
  if (!depositExisting) {
    const existingApproval = await journal.read("approval");
    if (existingApproval || (await readEthereumFundingWalletState(saved.plan!, wallet)).approvalRequired) {
      const approval = await executeEvmFundingStep(saved.plan!, "approval", wallet, journal);
      if (approval.state !== "confirmed") return stepResult(saved, approval);
    }
  }
  const deposit = await executeEvmFundingStep(saved.plan!, "deposit", wallet, journal);
  if (deposit.state !== "confirmed") return stepResult(saved, deposit);
  return verify(context, saved, result);
}
export async function resumeEthereumPurchase(context: MsgBusToolContext, id: string): Promise<OperationResult> {
  const observed = await ethereumInvoiceStatus(context, operationId(id));
  if (observed?.entitled || observed?.active) return ethereumOperationView(observed);
  return executeEthereum(context, undefined, id);
}
export async function prepareEthereumBrowser(context: MsgBusToolContext, quote?: PurchaseQuote, id?: string) {
  assertBrowser(context); const { saved, result } = await prepare(context, quote, id); assertBrowser(context, saved);
  return { plan: saved.plan!, result: ethereumOperationView(result, saved.source), fundingRequired: "pay_ethereum" in result.nextAction || "verify_ethereum" in result.nextAction };
}
export async function ethereumJournalRead(context: MsgBusToolContext, id: string, kind: EthereumFundingKind) { const saved = await savedEthereum(context, id); assertBrowser(context, saved); return fundingJournal(context, saved).read(kind); }
export async function ethereumJournalClaim(context: MsgBusToolContext, id: string, record: EthereumFundingRecord) { const saved = await savedEthereum(context, id); assertBrowser(context, saved); return fundingJournal(context, saved).claim(record); }
export async function ethereumJournalRecord(context: MsgBusToolContext, id: string, previous: EthereumFundingRecord, next: EthereumFundingRecord) { const saved = await savedEthereum(context, id); assertBrowser(context, saved); return fundingJournal(context, saved).record(previous, next); }
export async function finishEthereumBrowser(context: MsgBusToolContext, id: string): Promise<OperationResult> {
  const saved = await savedEthereum(context, id); assertBrowser(context, saved);
  const result = await ethereumInvoiceStatus(context, id); if (!result) throw new Error("The original Ethereum invoice is unavailable."); return verify(context, saved, result);
}
export async function ethereumSavedStatus(context: MsgBusToolContext, id: string): Promise<OperationResult | null> {
  const raw = await loadIntent<SavedEthereum>(context.kernel, key(operationId(id)));
  if (!raw) {
    const remote = await ethereumInvoiceStatus(context, id);
    if (!remote) return null;
    const view = ethereumOperationView(remote);
    return remote.entitled || remote.active ? view : { ...view, nextAction: "review", message: `${view.message} Local wallet request details are unavailable. Do not create another payment; the original invoice can still receive and reconcile its existing deposit.` };
  }
  const saved = await savedEthereum(context, id, false), result = await ethereumInvoiceStatus(context, id);
  if (result?.entitled || result?.active) return ethereumOperationView(result, saved.source);
  const journal = fundingJournal(context, saved), record = await journal.read("deposit") ?? await journal.read("approval");
  if (record) return stepResult(saved, record);
  return result ? ethereumOperationView(result, saved.source) : { operationId: id, appIds: saved.quote.appIds, ethereumWallet: saved.source, state: "pending", nextAction: "resume", message: "The original Ethereum checkout is saved. Continue it to recover invoice preparation without another payment." };
}
export async function recentEthereumPurchases(context: MsgBusToolContext): Promise<OperationResult[]> {
  const client = await protocolClient(context), rows = await listIntents<unknown>(context.kernel), results: OperationResult[] = (await ethereumHistory(context)).items;
  for (const row of rows) if (row.id.startsWith("ethereum:operation:")) {
    const saved = row.value as SavedEthereum;
    if (saved.scope.canister === client.state.canisterId && saved.scope.owner === client.state.owner) { const result = await ethereumSavedStatus(context, saved.quote.operationId); if (result) results.push(result); }
  }
  return [...new Map(results.map(result => [result.operationId, result])).values()];
}
async function invoiceAction(context: MsgBusToolContext, id: string, kind: "settle" | "cancel") {
  operationId(id);
  const client = await protocolClient(context), fees = await ethereumFees(context), observed = await ethereumInvoiceStatus(context, id);
  if (!observed) throw new Error("The original Ethereum invoice was not found.");
  if (kind === "cancel" && observed.entitled) throw new Error("These apps are already acquired. Canceling checkout does not refund a completed purchase.");
  if (kind === "cancel" && observed.invoice.canceledAtNs.length || kind === "settle" && observed.earningsAvailable) return ethereumOperationView(observed);
  const saved = await loadIntent<SavedEthereum>(context.kernel, key(id));
  if (saved) assertScope(saved.scope, scope(context, client.state.canisterId!, client.state.owner));
  const quote = saved?.quote ?? await ethereumInvoiceView(context, observed, "evm_wallet");
  await authorize(context, { kind: `ethereum_${kind}`, operationId: id, quote: quote as unknown as JsonObject, cycles: cycleView(fees[kind]) as unknown as JsonObject }, true);
  return ethereumOperationView(await client.update<EthereumInvoiceResult>(`ethereum_${kind}`, { requestId: id }, fees[kind]), saved?.source);
}
export const settleEthereumPurchase = (context: MsgBusToolContext, id: string) => invoiceAction(context, id, "settle");
export const cancelEthereumPurchase = (context: MsgBusToolContext, id: string) => invoiceAction(context, id, "cancel");

/** Recover a known original hash after a browser reply was lost. This performs
 * protocol verification only; it never repairs recovery by sending more USDC. */
export async function verifyEthereumTransaction(context: MsgBusToolContext, id: string, transactionHash: string): Promise<OperationResult> {
  operationId(id);
  if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error("Enter the original Ethereum deposit transaction hash.");
  const client = await protocolClient(context), observed = await ethereumInvoiceStatus(context, id);
  if (!observed) throw new Error("The original Ethereum invoice was not found.");
  if (observed.entitled || observed.active) return ethereumOperationView(observed);
  const local = await loadIntent<SavedEthereum>(context.kernel, key(id));
  if (local) assertScope(local.scope, scope(context, client.state.canisterId!, client.state.owner));
  const quote = await ethereumInvoiceView(context, observed, local?.source ?? "evm_wallet"), fees = await ethereumFees(context);
  await authorize(context, { kind: "ethereum_verify", operationId: id, transactionHash, quote: quote as unknown as JsonObject, cycles: cycleView(fees.verify) as unknown as JsonObject }, true);
  const result = await client.update<EthereumInvoiceResult>("ethereum_verify", { requestId: id, transactionHash }, fees.verify);
  return ethereumOperationView(result, local?.source);
}
