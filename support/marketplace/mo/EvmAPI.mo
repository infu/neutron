// All rights reserved. See ../LICENSE.
import API "./API";
import Types "./Types";

module {
  public type Transaction = { chainId : Nat; from : Text; to : Text; value : Nat; data : Text };
  public type Payment = {
    amountAtoms : Nat; saleAtoms : Nat; sweepFeeAtoms : Nat;
    approve : Transaction; deposit : Transaction;
  };
  public type NextAction = {
    #pay_ethereum; #verify_ethereum; #wait_wrapping; #settle;
    #fee_shortfall; #review_required; #none;
  };
  public type InvoiceResult = {
    order : Types.Order;
    invoice : Types.EvmInvoice;
    receipt : ?Types.EvmReceipt;
    sweep : ?Types.EvmSweep;
    attempt : ?Types.Attempt;
    quote : API.CheckoutQuote;
    payment : Payment;
    active : Bool;
    nextAction : NextAction;
    entitled : Bool;
    earningsAvailable : Bool;
  };
  public type PrepareRequest = { quote : API.CheckoutQuote; payer : Text; feeVersion : Nat };
  public type VerifyRequest = { requestId : Text; transactionHash : Text; feeVersion : Nat };
  public type OperationRequest = { requestId : Text; feeVersion : Nat };
  public type HistoryRequest = { cursor : ?Nat64; limit : Nat };
  public type InvoicePage = { invoices : [InvoiceResult]; nextCursor : ?Nat64 };
}
