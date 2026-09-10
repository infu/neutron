// All rights reserved. See ../LICENSE.
import Runtime "mo:core/Runtime";
import API "./API";
import Ledger "./Ledger";
import PaymentStore "./PaymentStore";
import PaymentState "./PaymentState";
import Purchases "./Purchases";
import Quotes "./Quotes";
import Rankings "./Rankings";
import Store "./Store";
import Types "./Types";
import Withdrawals "./Withdrawals";

module {
  func error<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func must<T>(value : { #ok : T; #err : Types.Error }) : T {
    switch (value) { case (#ok(result)) result; case (#err(value)) Runtime.trap(debug_show(value)) };
  };

  public class Service(db : Store.DB, marketplace : Principal, clock : () -> Int) {
    func finalized(order : Types.Order, block : ?Nat, now : Int) {
      for (item in order.items.vals()) {
        ignore Rankings.recordAcquisition(db, {
          owner = order.owner; appId = item.appId; orderId = order.id;
          kind = if (item.priceUsdMicros == 0) #free else #paid;
          atNs = now; paidAtoms = item.paidAtoms;
          ledger = if (item.paidAtoms == 0) null else ?order.ledger; block;
        });
      };
    };
    let purchases = Purchases.Engine(db, Ledger.client(), marketplace, clock, finalized);
    public let withdrawals = Withdrawals.Engine(db, Ledger.client(), marketplace, clock);

    func attempt(id : ?Nat64) : ?Types.Attempt {
      switch (id) { case null null; case (?id) Store.getAttempt(db, id) };
    };
    func frozen(state : Types.OperationState, id : ?Nat64, active : Bool) : Bool {
      if (active or state == #complete) return true;
      switch (attempt(id)) {
        case null false;
        case (?value) value.hadUnknown or value.state == #dispatched or value.state == #outcome_unknown or value.state == #succeeded;
      };
    };
    func next(state : Types.OperationState, id : ?Nat64, active : Bool) : PaymentState.NextAction {
      if (state == #complete) return #none;
      if (active) return #await_current_call;
      switch (attempt(id)) {
        case null #retry_same_attempt;
        case (?value) {
          // The driver is transient. A retained dispatched attempt after an
          // upgrade is recovered with identical arguments, never waited forever.
          if (value.state == #dispatched or value.state == #succeeded) #retry_same_attempt else PaymentState.next(PaymentStore.evidence(value));
        };
      };
    };
    func savedPurchase(order : Types.Order) : ?API.CheckoutQuote {
      let ?record = Store.getQuoteRecord(db, order.owner, #purchase, order.requestId, order.quoteCommitment) else return null;
      from_candid(record.content);
    };
    func savedWithdrawal(withdrawal : Types.Withdrawal) : ?API.WithdrawalQuote {
      let request : API.WithdrawalRequest = { requestId = withdrawal.requestId; ledger = withdrawal.ledger; to = withdrawal.to; totalDebit = withdrawal.totalDebit };
      let digest = Quotes.withdrawalCommitment(marketplace, withdrawal.owner, request, withdrawal.fee);
      let ?record = Store.getQuoteRecord(db, withdrawal.owner, #withdrawal, withdrawal.requestId, digest) else return null;
      from_candid(record.content);
    };
    func purchaseResult(order : Types.Order) : API.PurchaseResult {
      let active = purchases.isActive(order.id);
      { order; attempt = attempt(order.currentAttempt); quote = savedPurchase(order); active; nextAction = next(order.state, order.currentAttempt, active) };
    };
    func withdrawalResult(withdrawal : Types.Withdrawal) : API.WithdrawalResult {
      let active = withdrawals.isActive(withdrawal.id);
      { withdrawal; attempt = attempt(withdrawal.currentAttempt); quote = savedWithdrawal(withdrawal); active; nextAction = next(withdrawal.state, withdrawal.currentAttempt, active) };
    };
    public func purchaseStatus(owner : Principal, requestId : Text) : ?API.PurchaseResult {
      switch (Store.getOrder(db, owner, requestId)) { case null null; case (?order) ?purchaseResult(order) };
    };
    public func withdrawalStatus(owner : Principal, requestId : Text) : ?API.WithdrawalResult {
      switch (Store.getWithdrawal(db, owner, requestId)) { case null null; case (?value) ?withdrawalResult(value) };
    };
    public func purchaseQuote(owner : Principal, request : API.PurchaseRequest) : API.Result<API.CheckoutQuote> {
      if (Store.getEvmInvoiceByRequest(db, owner, request.requestId) != null) return error("payment_rail", "This purchase uses Ethereum. Resume its original Ethereum invoice.");
      switch (Store.getOrder(db, owner, request.requestId)) {
        case (?saved) {
          if (saved.intentHash != Quotes.purchaseIntent(request)) return error("request_mismatch", "This purchase ID belongs to another selection. Retain its original request to recover it.");
          if (frozen(saved.state, saved.currentAttempt, purchases.isActive(saved.id))) {
            switch (savedPurchase(saved)) { case (?quote) return #ok(quote); case null return error("quote_unavailable", "The original payment snapshot is unavailable. Inspect its saved attempt; do not create a replacement purchase.") };
          };
        };
        case null {};
      };
      Quotes.purchase(db, marketplace, owner, request, clock());
    };
    public func withdrawalQuote(owner : Principal, request : API.WithdrawalRequest) : API.Result<API.WithdrawalQuote> {
      switch (Store.getWithdrawal(db, owner, request.requestId)) {
        case (?saved) {
          if (saved.intentHash != Quotes.withdrawalIntent(request)) return error("request_mismatch", "This withdrawal ID belongs to another request.");
          if (frozen(saved.state, saved.currentAttempt, withdrawals.isActive(saved.id))) {
            switch (savedWithdrawal(saved)) { case (?quote) return #ok(quote); case null return error("quote_unavailable", "The original withdrawal snapshot is unavailable. Inspect its saved attempt before any new withdrawal.") };
          };
        };
        case null {};
      };
      Quotes.withdrawal(db, marketplace, owner, request);
    };
    func retain(owner : Principal, requestId : Text, kind : { #purchase; #withdrawal }, commitment : Blob, content : Blob) {
      switch (Store.getQuoteRecord(db, owner, kind, requestId, commitment)) {
        case null ignore must(Store.insertQuoteRecord(db, { owner; requestId; kind; commitment; content; createdAtNs = clock() }));
        case (?_) {};
      };
    };
    public func purchase(owner : Principal, supplied : API.CheckoutQuote) : async* API.Result<API.PurchaseResult> {
      if (Store.getEvmInvoiceByRequest(db, owner, supplied.request.requestId) != null) return error("payment_rail", "This purchase uses Ethereum. Resume its original Ethereum invoice.");
      if (supplied.buyer != owner) return error("owner_mismatch", "The purchase review belongs to another Neutron.");
      let expected = switch (purchaseQuote(owner, supplied.request)) { case (#err(value)) return #err(value); case (#ok(value)) value };
      // Query timestamps do not expire a purchase. Every financial, permission,
      // allocation and original price observation field must agree exactly.
      if (not Quotes.samePurchase(supplied, expected)) return error("quote_changed", "Purchase costs or availability changed. Review a fresh quote under this same request ID before continuing.");
      let order = switch (Purchases.prepare(db, Quotes.order(expected, clock()))) {
        case (#err(message)) return error("purchase_prepare", message);
        case (#ok(value)) value;
      };
      retain(owner, order.requestId, #purchase, expected.commitment, to_candid(expected));
      if (purchases.isActive(order.id) or order.state == #complete) return #ok(purchaseResult(order));
      switch (await* purchases.run(order.id)) {
        case (#ok(value)) #ok(purchaseResult(value));
        case (#err(message)) error("purchase_interrupted", message);
      };
    };
    public func withdraw(owner : Principal, supplied : API.WithdrawalQuote) : async* API.Result<API.WithdrawalResult> {
      if (supplied.owner != owner) return error("owner_mismatch", "The withdrawal review belongs to another Neutron.");
      let expected = switch (withdrawalQuote(owner, supplied.request)) { case (#err(value)) return #err(value); case (#ok(value)) value };
      // The current available balance may grow through sales. It is an
      // observation, not authorization to alter the fixed withdrawal amount.
      if (to_candid({ supplied with available = 0 }) != to_candid({ expected with available = 0 })) return error("quote_changed", "Withdrawal costs changed. Review a new quote under the same request ID.");
      let withdrawal = switch (Withdrawals.prepare(db, Quotes.withdrawalRecord(expected, clock()))) {
        case (#err(message)) return error("withdrawal_prepare", message);
        case (#ok(value)) value;
      };
      retain(owner, withdrawal.requestId, #withdrawal, expected.commitment, to_candid(expected));
      if (withdrawals.isActive(withdrawal.id) or withdrawal.state == #complete) return #ok(withdrawalResult(withdrawal));
      switch (await* withdrawals.run(withdrawal.id)) {
        case (#ok(value)) #ok(withdrawalResult(value));
        case (#err(message)) error("withdrawal_interrupted", message);
      };
    };
  };
}
