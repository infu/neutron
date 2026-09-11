import type { Principal } from "@dfinity/principal";
import type { Checkout, Fee, Option, WireOperation, WireResult } from "./protocol.ts";

/** Public Candid views of the Ethereum checkout protocol. Persistent quoteContent
 * bytes belong to the protocol; the exposed quote is the frozen review payload. */
export type EthereumRoute = {
  chainId: bigint; minter: Principal; helper: string; minterAddress: string;
  token: string; ledger: Principal; decimals: number;
};
export type EthereumInvoice = {
  id: bigint; owner: Principal; requestId: string; orderId: bigint; subaccount: Uint8Array;
  route: EthereumRoute; payer: string; quoteContent: Uint8Array; saleAtoms: bigint;
  grossAtoms: bigint; sweepFee: bigint; canceledAtNs: Option<bigint>;
  acceptedReceiptId: Option<bigint>; entitlementGrantedAtNs: Option<bigint>;
  revenueFinalizedAtNs: Option<bigint>; currentSweepId: Option<bigint>; nextSweepOrdinal: bigint;
  creditedBuyerAtoms: bigint; lastBalance: Option<bigint>; lastBalanceAtNs: Option<bigint>;
  nextCheckAtNs: bigint; createdAtNs: bigint; updatedAtNs: bigint; lastError: Option<string>;
};
export type EthereumReceipt = {
  id: bigint; invoiceId: bigint; eventKey: string; transactionHash: string; logIndex: bigint;
  blockNumber: bigint; blockHash: string; payer: string; amount: bigint; observedAtNs: bigint;
};
export type EthereumSweep = {
  id: bigint; invoiceId: bigint; ordinal: bigint; purpose: { sale: null } | { buyer_credit: null };
  amount: bigint; fee: bigint; attemptId: bigint; finalizedAtNs: Option<bigint>;
  createdAtNs: bigint; updatedAtNs: bigint;
};
export type EthereumTransaction = { chainId: bigint; from: string; to: string; value: bigint; data: string };
export type EthereumPayment = { amountAtoms: bigint; saleAtoms: bigint; sweepFeeAtoms: bigint; approve: EthereumTransaction; deposit: EthereumTransaction };
export type EthereumNextAction = { pay_ethereum: null } | { verify_ethereum: null } | { wait_wrapping: null } | { settle: null } | { fee_shortfall: null } | { review_required: null } | { none: null };
export type EthereumInvoiceResult = {
  order: WireOperation; invoice: EthereumInvoice; receipt: Option<EthereumReceipt>;
  sweep: Option<EthereumSweep>; attempt: WireResult["attempt"]; quote: Checkout;
  payment: EthereumPayment; active: boolean; nextAction: EthereumNextAction;
  entitled: boolean; earningsAvailable: boolean;
};
export type EthereumFees = { prepare: Fee; verify: Fee; settle: Fee; cancel: Fee };
export type EthereumInvoicePage = { invoices: EthereumInvoiceResult[]; nextCursor: Option<bigint> };
