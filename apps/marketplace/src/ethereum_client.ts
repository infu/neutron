import { getAddress } from "viem";
import type { MsgBusToolContext } from "neutron-tools/app";
import { protocolClient, randomId, cycleView, type Client } from "./client.ts";
import { first, some, type Checkout } from "./protocol.ts";
import { ETHEREUM_USDC } from "./ethereum.ts";
import type { EthereumFees, EthereumInvoicePage, EthereumInvoiceResult } from "./ethereum_protocol.ts";
import type { EthereumPurchaseSelection, EthereumWalletSource, Money, OperationResult, Page, PurchaseQuote } from "./view-types.ts";

function payer(value: string | undefined): string {
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Select the Ethereum wallet that will pay for this purchase.");
  return getAddress(value.toLowerCase());
}
const usdc = (atoms: bigint): Money => ({ atoms: String(atoms), decimals: 6, symbol: "USDC" });
export async function ethereumFees(context: MsgBusToolContext): Promise<EthereumFees> {
  return (await protocolClient(context)).transport.query<EthereumFees>("ethereum_fees");
}
async function quoteView(client: Client, quote: Checkout, selection: EthereumPurchaseSelection, fees: EthereumFees): Promise<PurchaseQuote> {
  const selected = client.token("ckUSDC");
  if (selected.decimals !== 6 || selected.ledger.toText() !== quote.request.ledger.toText()) throw new Error("The Ethereum checkout quote does not use this marketplace's ckUSDC pricing ledger.");
  const view = await client.purchaseView(quote);
  return {
    ...view, payment: usdc(quote.amount), approvalFee: usdc(0n), collectionFee: usdc(quote.fee), totalDebit: usdc(quote.amount + quote.fee),
    allocations: view.allocations.map(allocation => ({ ...allocation, amount: { ...allocation.amount, symbol: "USDC" } })),
    cycles: cycleView(fees.prepare), ethereum: {
      wallet: selection.wallet, payerAddress: payer(selection.payerAddress), chainId: "1", tokenAddress: ETHEREUM_USDC,
      recipientPrincipal: client.info.canister.toText(), wrappingFee: usdc(quote.fee),
      prepareCycles: cycleView(fees.prepare), verifyCycles: cycleView(fees.verify),
    },
    warnings: [...view.warnings, "Ethereum approval and payment each cost ETH gas in addition to the displayed USDC total. App access begins after the protocol verifies the Ethereum payment; wrapping and revenue settlement continue separately."],
  };
}
export async function ethereumQuote(context: MsgBusToolContext, input: { appIds: string[]; affiliateCode?: string | undefined; ethereum: EthereumPurchaseSelection; operationId?: string }): Promise<PurchaseQuote> {
  const selection = { ...input.ethereum, payerAddress: payer(input.ethereum.payerAddress) };
  const client = await protocolClient(context), selected = client.token("ckUSDC");
  const affiliateCode = await client.purchaseCode(input.affiliateCode);
  const [quote, fees] = await Promise.all([
    client.query<Checkout>("ethereum_quote", [{ requestId: input.operationId ?? randomId(), appIds: input.appIds, ledger: selected.ledger, referralCode: some(affiliateCode || null) }]),
    client.transport.query<EthereumFees>("ethereum_fees"),
  ]);
  return quoteView(client, quote, selection, fees);
}
/** Rebuild the review from the retained protocol invoice, even if its listing
 * later changes or becomes unavailable. The original opaque checkout stays exact. */
export async function ethereumInvoiceView(context: MsgBusToolContext, result: EthereumInvoiceResult, source: EthereumWalletSource): Promise<PurchaseQuote> {
  const client = await protocolClient(context), { invoice, quote } = result;
  if (invoice.route.chainId !== 1n || invoice.route.token.toLowerCase() !== ETHEREUM_USDC || invoice.route.decimals !== 6) throw new Error("The retained invoice does not use canonical Ethereum USDC.");
  if (invoice.requestId !== quote.request.requestId || invoice.owner.toText() !== quote.buyer.toText() || invoice.route.ledger.toText() !== quote.request.ledger.toText()) throw new Error("The retained Ethereum invoice differs from its saved checkout.");
  if (invoice.saleAtoms !== quote.amount || invoice.sweepFee !== quote.fee || invoice.grossAtoms !== quote.amount + quote.fee) throw new Error("The retained Ethereum invoice amount differs from its saved checkout.");
  const view = await quoteView(client, quote, { wallet: source, payerAddress: invoice.payer }, await client.transport.query<EthereumFees>("ethereum_fees"));
  return { ...view, ethereum: { ...view.ethereum!, helperAddress: payer(invoice.route.helper), minterAddress: payer(invoice.route.minterAddress) } };
}
export function ethereumOperationView(result: EthereumInvoiceResult, source?: EthereumWalletSource): OperationResult {
  const receipt = first(result.receipt), detail = first(result.invoice.lastError) ?? first(result.order.lastError);
  const identity = {
    paymentRail: "ethereum" as const, operationId: result.invoice.requestId, appIds: result.quote.request.appIds, entitled: result.entitled,
    ...(source ? { ethereumWallet: source } : {}), ...(receipt ? { ethereumTransactionHash: receipt.transactionHash } : {}),
  };
  if (result.entitled) return {
    ...identity, state: "complete", nextAction: "none", message: "Your payment is verified. Your apps are in My Apps and can be installed anytime.",
    settlement: result.earningsAvailable
      ? { state: "complete", message: "Wrapping and revenue settlement are complete." }
      : { state: "pending", message: detail ?? "Wrapping and revenue settlement are still pending. Your app access is already available; do not pay again." },
  };
  if (first(result.invoice.canceledAtNs) !== null) {
    const pendingCredit = "settle" in result.nextAction || "review_required" in result.nextAction;
    // The protocol also marks a canceled invoice active while polling its
    // balance. That read alone does not reopen a canceled checkout.
    const checkoutCanceled = "none" in result.nextAction && !receipt
      && !result.invoice.acceptedReceiptId.length && !result.invoice.currentSweepId.length && result.invoice.nextSweepOrdinal === 0n
      && !result.sweep.length && !result.attempt.length && !result.invoice.entitlementGrantedAtNs.length && !result.invoice.revenueFinalizedAtNs.length
      && (first(result.invoice.lastBalance) ?? 0n) === 0n && result.invoice.creditedBuyerAtoms === 0n;
    return { ...identity, state: "failed", nextAction: result.active ? "none" : "settle" in result.nextAction ? "resume" : "review_required" in result.nextAction ? "review" : "none",
      ...(checkoutCanceled ? { checkoutCanceled: true } : {}),
      message: detail ?? "This invoice was canceled and has not granted app access. Retain its ID to reconcile any earlier payment.",
      ...(pendingCredit ? { settlement: { state: "pending" as const, message: "Funds associated with this canceled invoice still need buyer-credit settlement. Continue the original invoice without paying again." } } : {}),
    };
  }
  if (result.active) return { ...identity, state: "pending", nextAction: "none", message: detail ?? "The original Ethereum checkout is being processed. Check this invoice again without sending another payment." };
  if ("review_required" in result.nextAction || "fee_shortfall" in result.nextAction) return { ...identity, state: "review_required", nextAction: "review", message: detail ?? "This Ethereum checkout requires review. Retain the original invoice and transaction; do not send another payment." };
  if ("pay_ethereum" in result.nextAction) return { ...identity, state: "pending", nextAction: "resume", message: detail ?? "The invoice is ready for its original Ethereum payment. Resume this invoice with the selected wallet." };
  if ("verify_ethereum" in result.nextAction) return { ...identity, state: "pending", nextAction: "resume", message: detail ?? "The original Ethereum payment still needs protocol verification. Resume with its existing transaction hash; do not pay again." };
  if ("wait_wrapping" in result.nextAction || "settle" in result.nextAction) return { ...identity, state: "pending", nextAction: "resume", message: detail ?? "The original payment is awaiting wrapping or settlement. Continue this invoice without another Ethereum payment." };
  return { ...identity, state: "pending", nextAction: "none", message: detail ?? "App access has not been confirmed for this invoice. Retain its original payment evidence for review." };
}
export async function ethereumInvoiceStatus(context: MsgBusToolContext, operationId: string): Promise<EthereumInvoiceResult | null> {
  return first(await (await protocolClient(context)).query<[] | [EthereumInvoiceResult]>("ethereum_status", [{ requestId: operationId }]));
}
export async function ethereumStatus(context: MsgBusToolContext, operationId: string, source?: EthereumWalletSource): Promise<OperationResult | null> {
  const result = await ethereumInvoiceStatus(context, operationId);
  return result ? ethereumOperationView(result, source) : null;
}
export async function ethereumHistory(context: MsgBusToolContext, cursor?: string): Promise<Page<OperationResult>> {
  const result = await (await protocolClient(context)).query<EthereumInvoicePage>("ethereum_history", [{ cursor: cursor ? [BigInt(cursor)] : [], limit: 24n }]);
  return { items: result.invoices.map(invoice => ethereumOperationView(invoice)), nextCursor: first(result.nextCursor)?.toString() ?? null };
}
