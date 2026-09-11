// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import API "./API";
import Encoding "./Encoding";
import EvmAPI "./EvmAPI";
import Evidence "./EvmEvidence";
import Minter "./EvmMinter";
import Rpc "./EvmRpc";
import Ledger "./Ledger";
import Journal "./PaymentStore";
import State "./PaymentState";
import Quotes "./Quotes";
import Store "./Store";
import Types "./Types";

module {
  public type InvoiceResult = EvmAPI.InvoiceResult;
  public type Clients = {
    ledger : Ledger.Client;
    minter : Minter.Client;
    verify : Evidence.Expected -> async* Rpc.Result<Evidence.Proof>;
  };
  // Scheduling affects background work only. An owner can settle immediately.
  public let activeIntervalNs : Int = 30_000_000_000;
  public let idleIntervalNs : Int = 86_400_000_000_000;
  let maxId : Nat64 = 18_446_744_073_709_551_615;

  func error<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func uintWord(value : Nat) : Text {
    assert value < 2 ** 256;
    let bytes = Array.tabulate<Nat8>(32, func(index) {
      Nat8.fromNat((value / (256 ** (31 - index))) % 256);
    });
    Encoding.hex(Blob.fromArray(bytes));
  };
  func addressWord(value : Text) : Text {
    let ?hex = Text.stripStart(value, #text "0x") else Runtime.trap("Invalid retained Ethereum address");
    "000000000000000000000000" # hex;
  };
  public func payment(marketplace : Principal, invoice : Types.EvmInvoice) : EvmAPI.Payment {
    let route = invoice.route;
    {
      amountAtoms = invoice.grossAtoms; saleAtoms = invoice.saleAtoms; sweepFeeAtoms = invoice.sweepFee;
      approve = { chainId = route.chainId; from = invoice.payer; to = route.token; value = 0;
        data = "0x095ea7b3" # addressWord(route.helper) # uintWord(invoice.grossAtoms) };
      deposit = { chainId = route.chainId; from = invoice.payer; to = route.helper; value = 0;
        data = "0xdb9751af" # addressWord(route.token) # uintWord(invoice.grossAtoms) #
          Encoding.hex(Minter.principalWord(marketplace)) # Encoding.hex(invoice.subaccount) };
    };
  };

  public class Service(db : Store.DB, marketplace : Principal, clock : () -> Int, clients : Clients,
                       onGranted : (Types.Order, ?Nat, Int) -> ()) {
    let active = Set.empty<Nat64>();
    public func isActive(id : Nat64) : Bool { Set.contains(active, Nat64.compare, id) };
    func invoice(id : Nat64) : Types.EvmInvoice { Journal.found(Store.getEvmInvoice(db, id)) };
    func order(row : Types.EvmInvoice) : Types.Order { Journal.found(Store.getOrderById(db, row.orderId)) };
    func savedQuote(row : Types.EvmInvoice) : API.CheckoutQuote {
      let decoded : ?API.CheckoutQuote = from_candid(row.quoteContent);
      Journal.found(decoded);
    };
    func sweep(row : Types.EvmInvoice) : ?Types.EvmSweep {
      switch (row.currentSweepId) { case null null; case (?id) Store.getEvmSweep(db, id) };
    };
    func attempt(row : Types.EvmInvoice) : ?Types.Attempt {
      switch (sweep(row)) { case null null; case (?value) Store.getAttempt(db, value.attemptId) };
    };
    func next(row : Types.EvmInvoice) : EvmAPI.NextAction {
      if (row.acceptedReceiptId != null and row.entitlementGrantedAtNs == null and row.canceledAtNs == null) return #settle;
      switch (sweep(row), attempt(row)) {
        case (?value, ?wire) if (value.finalizedAtNs == null) {
          if (State.next(Journal.evidence(wire)) == #review_required) return #review_required;
          if (wire.state == #succeeded or wire.state == #dispatched or wire.state == #outcome_unknown) return #settle;
        };
        case (_) {};
      };
      if (row.canceledAtNs != null or row.revenueFinalizedAtNs != null) {
        return switch (row.lastBalance) { case (?balance) { if (balance > applicableFee(row)) #settle else #none }; case (_) #none };
      };
      switch (row.lastBalance) {
        case (?balance) if (balance >= row.saleAtoms + applicableFee(row)) return #settle;
        case (?balance) if (balance >= row.saleAtoms and balance < row.saleAtoms + applicableFee(row)) return #fee_shortfall;
        case (_) {};
      };
      if (row.acceptedReceiptId != null or row.entitlementGrantedAtNs != null) #wait_wrapping else #pay_ethereum;
    };
    func result(row : Types.EvmInvoice) : InvoiceResult {
      {
        invoice = row; order = order(row); quote = savedQuote(row); payment = payment(marketplace, row);
        receipt = switch (row.acceptedReceiptId) { case null null; case (?id) Store.getEvmReceipt(db, id) };
        sweep = sweep(row); attempt = attempt(row); active = isActive(row.id); nextAction = next(row);
        entitled = row.entitlementGrantedAtNs != null; earningsAvailable = row.revenueFinalizedAtNs != null;
      };
    };
    public func status(owner : Principal, requestId : Text) : ?InvoiceResult {
      switch (Store.getEvmInvoiceByRequest(db, owner, requestId)) { case null null; case (?row) ?result(row) };
    };
    public func history(owner : Principal, cursor : ?Nat64, limit : Nat) : EvmAPI.InvoicePage {
      let rows = List.empty<InvoiceResult>();
      var last : ?Nat64 = null;
      var more = false;
      let range = { gte = if (cursor == null) ?(owner, 0 : Nat64) else null;
        lte = ?(owner, maxId); gt = switch cursor { case null null; case (?id) ?(owner, id) }; lt = null; dir = #fwd };
      label page for (row in db.evmInvoices.by_owner.rangeIter(range, null)) {
        if (List.size(rows) == limit) { more := true; break page };
        List.add(rows, result(row)); last := ?row.id;
      };
      { invoices = List.toArray(rows); nextCursor = if (more) last else null };
    };
    public func quote(owner : Principal, request : API.PurchaseRequest) : API.Result<API.CheckoutQuote> {
      if (request.ledger != Minter.ckusdcLedger()) return error("payment_token", "Ethereum checkout pays canonical USDC and settles in ckUSDC.");
      switch (Store.getEvmInvoiceByRequest(db, owner, request.requestId)) {
        case (?row) {
          if (order(row).intentHash != Quotes.purchaseIntent(request)) return error("request_mismatch", "This Ethereum purchase ID belongs to another selection.");
          return #ok(savedQuote(row));
        };
        case null {};
      };
      if (Store.getOrder(db, owner, request.requestId) != null) return error("payment_rail", "This request already uses IC payment. Resume that original purchase.");
      Quotes.purchase(db, marketplace, owner, request, clock());
    };
    func claimCheck(buyer : Principal, items : [Types.PurchaseItem], allowedOrder : ?Nat64) : API.Result<()> {
      for (item in items.vals()) {
        if (Store.getEntitlement(db, buyer, item.appId) != null) return error("ownership_changed", "This app is already owned. Review the remaining unowned apps before preparing payment.");
        switch (Store.getClaim(db, buyer, item.appId)) {
          case (?held) if (?held.orderId != allowedOrder) return error("purchase_active", "Another purchase is acquiring " # item.appId # ". Resume its existing request rather than creating another payment.");
          case (_) {};
        };
      };
      #ok(());
    };
    func releaseClaims(row : Types.EvmInvoice) {
      for (item in order(row).items.vals()) {
        switch (Store.getClaim(db, row.owner, item.appId)) {
          case (?held) if (held.orderId == row.orderId) { ignore Journal.must(db.claims.delete(held.id)) };
          case (_) {};
        };
      };
    };
    public func prepare(owner : Principal, supplied : API.CheckoutQuote, payer : Text) : async* API.Result<InvoiceResult> {
      if (supplied.buyer != owner) return error("owner_mismatch", "This purchase review belongs to another Neutron.");
      let normalized = switch (Minter.normalizeAddress(payer)) { case (#ok(value)) value; case (#err(message)) return error("payer", message) };
      switch (Store.getEvmInvoiceByRequest(db, owner, supplied.request.requestId)) {
        case (?saved) {
          if (saved.payer != normalized or not Quotes.samePurchase(supplied, savedQuote(saved))) return error("invoice_immutable", "This Ethereum invoice is immutable. Resume its original payer and reviewed quote.");
          return #ok(result(saved));
        };
        case null {};
      };
      let initial = switch (quote(owner, supplied.request)) { case (#ok(value)) value; case (#err(value)) return #err(value) };
      if (not Quotes.samePurchase(initial, supplied)) return error("quote_changed", "Purchase costs changed. Review the current quote before creating payment instructions.");
      if (initial.amount == 0) return error("free_purchase", "Acquire free apps through the ordinary free checkout; no Ethereum deposit is needed.");
      if (initial.amount + initial.fee >= 2 ** 256) return error("ethereum_amount", "The reviewed deposit amount does not fit the Ethereum helper's uint256 amount.");
      switch (claimCheck(owner, initial.items, null)) { case (#err(value)) return #err(value); case (_) {} };
      let route = switch (await* Minter.discover(clients.minter)) { case (#ok(value)) value; case (#err(message)) return error("minter_route", message) };
      switch (await* Minter.verifyPayer(clients.minter, route, normalized)) { case (#err(message)) return error("minter_payer", message); case (_) {} };
      // Both discovery reads yield. Revalidate the quote, ownership and shared
      // claims before making the external payment instructions usable.
      switch (Store.getEvmInvoiceByRequest(db, owner, supplied.request.requestId)) {
        case (?saved) {
          if (saved.payer != normalized or not Quotes.samePurchase(supplied, savedQuote(saved))) return error("invoice_immutable", "Another call prepared this request with different immutable terms.");
          return #ok(result(saved));
        };
        case null {};
      };
      let current = switch (quote(owner, supplied.request)) { case (#ok(value)) value; case (#err(value)) return #err(value) };
      if (not Quotes.samePurchase(current, supplied)) return error("quote_changed", "Purchase costs or ownership changed while preparing the route. Review the current quote.");
      switch (claimCheck(owner, current.items, null)) { case (#err(value)) return #err(value); case (_) {} };
      let now = clock();
      let savedOrder = Journal.must(Store.insertOrder(db, Quotes.order(current, now)));
      let subaccount = Encoding.hash(to_candid("neutron.marketplace.ethereum.invoice.v1", marketplace,
        owner, savedOrder.id, savedOrder.requestId, savedOrder.intentHash, savedOrder.quoteCommitment, normalized, route));
      let row = Journal.must(Store.insertEvmInvoice(db, {
        owner; requestId = current.request.requestId; orderId = savedOrder.id; subaccount; route; payer = normalized;
        quoteContent = to_candid(current); saleAtoms = current.amount; grossAtoms = current.amount + current.fee; sweepFee = current.fee;
        canceledAtNs = null; acceptedReceiptId = null; entitlementGrantedAtNs = null; revenueFinalizedAtNs = null;
        currentSweepId = null; nextSweepOrdinal = 0; creditedBuyerAtoms = 0; lastBalance = null; lastBalanceAtNs = null;
        workClass = 1; nextCheckAtNs = now + idleIntervalNs; createdAtNs = now; updatedAtNs = now; lastError = null;
      }));
      for (item in current.items.vals()) ignore Journal.must(Store.insertClaim(db, { owner; appId = item.appId; orderId = savedOrder.id; createdAtNs = now }));
      #ok(result(row));
    };
    // A grant is its own atomic local transaction. Revenue is still unavailable
    // until the fixed sale amount is in the treasury with a retained ledger block.
    func grant(id : Nat64, block : ?Nat) {
      let row = invoice(id);
      if (row.entitlementGrantedAtNs != null or row.canceledAtNs != null) return;
      let savedOrder = order(row);
      assert row.acceptedReceiptId != null or block != null;
      for (item in savedOrder.items.vals()) {
        assert Journal.found(Store.getClaim(db, row.owner, item.appId)).orderId == row.orderId;
        assert Store.getEntitlement(db, row.owner, item.appId) == null;
      };
      let now = clock();
      for (item in savedOrder.items.vals()) ignore Journal.must(Store.insertEntitlement(db, {
        owner = row.owner; appId = item.appId; orderId = row.orderId;
        kind = if (item.priceUsdMicros == 0) #free else #paid; acquiredAtNs = now;
      }));
      onGranted(savedOrder, block, now);
      releaseClaims(row);
      ignore Journal.must(db.evmInvoices.update({ row with entitlementGrantedAtNs = ?now; updatedAtNs = now; workClass = 0; nextCheckAtNs = now; lastError = null }));
      ignore Journal.must(db.orders.update({ savedOrder with state = #dispatched; updatedAtNs = now; lastError = null }));
    };
    func note(id : Nat64, message : ?Text, delay : Int) : Types.EvmInvoice {
      let current = invoice(id);
      Journal.must(db.evmInvoices.update({ current with updatedAtNs = clock(); workClass = if (delay == idleIntervalNs) 1 else 0; nextCheckAtNs = clock() + delay; lastError = message }));
    };
    func driveVerify(id : Nat64, transactionHash : Text) : async* API.Result<InvoiceResult> {
      let initial = invoice(id);
      switch (initial.acceptedReceiptId) {
        case (?receiptId) {
          let known = Journal.found(Store.getEvmReceipt(db, receiptId));
          if (Text.toLower(transactionHash) == known.transactionHash) {
            grant(id, null);
            return #ok(result(invoice(id)));
          };
        };
        case null {};
      };
      let expected : Evidence.Expected = {
        chainId = initial.route.chainId; helper = initial.route.helper; token = initial.route.token;
        payer = initial.payer; recipient = marketplace; subaccount = initial.subaccount;
        amount = initial.grossAtoms; transactionHash;
      };
      // The minter can change its blocklist after preparation. A successful
      // helper receipt alone does not prove this payer is accepted for minting.
      switch (await* Minter.verifyPayer(clients.minter, initial.route, initial.payer)) {
        case (#err(message)) { ignore note(id, ?message, activeIntervalNs); return error("minter_payer", message) };
        case (_) {};
      };
      let proof = switch (await* clients.verify(expected)) {
        case (#ok(value)) value;
        case (#err(value)) { ignore note(id, ?debug_show(value), activeIntervalNs); return error("ethereum_evidence", debug_show(value)) };
      };
      let current = invoice(id);
      let receipt = switch (Store.getEvmReceiptByEvent(db, proof.eventKey)) {
        case (?saved) {
          if (saved.invoiceId != id) return error("receipt_used", "This Ethereum event already belongs to another invoice.");
          saved;
        };
        case null Journal.must(Store.insertEvmReceipt(db, {
          invoiceId = id; eventKey = proof.eventKey; transactionHash = proof.transactionHash; logIndex = proof.logIndex;
          blockNumber = proof.blockNumber; blockHash = proof.blockHash; payer = proof.payer; amount = proof.amount; observedAtNs = clock();
        }));
      };
      if (current.acceptedReceiptId == null) ignore Journal.must(db.evmInvoices.update({ current with acceptedReceiptId = ?receipt.id;
        updatedAtNs = clock(); workClass = 0; nextCheckAtNs = clock(); lastError = null }));
      // Preserve validated source evidence before a callback or ownership write
      // can trap. A retry of this proof performs only the unfinished local grant.
      await async { grant(id, null) };
      #ok(result(invoice(id)));
    };
    func applicableFee(row : Types.EvmInvoice) : Nat {
      switch (attempt(row)) {
        case (?wire) {
          let evidence = Journal.evidence(wire);
          if (State.canReplaceAttempt(evidence)) switch (evidence.ledgerError) {
            case (?#BadFee(value)) return value.expected_fee;
            case (_) {};
          };
          return wire.request.fee;
        };
        case null {};
      };
      row.sweepFee;
    };
    func makeSweep(row : Types.EvmInvoice, purpose : { #sale; #buyer_credit }, amount : Nat, fee : Nat) : Types.EvmSweep {
      let now = clock();
      let ordinal = row.nextSweepOrdinal;
      let request : Types.LedgerRequest = {
        kind = #transfer; ledger = row.route.ledger; spenderSubaccount = null;
        fromAccount = { owner = marketplace; subaccount = ?row.subaccount }; to = { owner = marketplace; subaccount = null };
        amount; fee; memo = Encoding.hash(to_candid("neutron.marketplace.ethereum.sweep.v1", marketplace, row.id, purpose, ordinal));
        createdAtTimeNs = Journal.timestamp(now);
      };
      let wire = Journal.must(Store.insertAttempt(db, { owner = row.owner; operationKind = #evm_sweep; operationId = row.id; ordinal; request;
        state = #prepared; hadUnknown = false; block = null; duplicate = false; lastLedgerError = null; lastError = null; createdAtNs = now; updatedAtNs = now }));
      let created = Journal.must(Store.insertEvmSweep(db, { invoiceId = row.id; ordinal; purpose; amount; fee; attemptId = wire.id;
        finalizedAtNs = null; createdAtNs = now; updatedAtNs = now }));
      ignore Journal.must(db.evmInvoices.update({ row with currentSweepId = ?created.id; nextSweepOrdinal = ordinal + 1; workClass = 0; updatedAtNs = now; lastError = null }));
      created;
    };
    func finalizeSweep(id : Nat64, sweepId : Nat64) {
      let row = invoice(id);
      let value = Journal.found(Store.getEvmSweep(db, sweepId));
      if (value.finalizedAtNs != null) return;
      assert row.currentSweepId == ?sweepId and value.invoiceId == id;
      let wire = Journal.found(Store.getAttempt(db, value.attemptId));
      assert wire.state == #succeeded and wire.block != null;
      let now = clock();
      switch (value.purpose) {
        case (#sale) {
          assert row.canceledAtNs == null and row.revenueFinalizedAtNs == null and value.amount == row.saleAtoms;
          grant(id, wire.block);
          let savedOrder = order(row);
          for (item in savedOrder.items.vals()) {
            Journal.addCredit(db, row.route.ledger, item.publisher, false, item.developerAtoms, now);
            switch (savedOrder.affiliate) {
              case (?affiliate) Journal.addCredit(db, row.route.ledger, affiliate, false, item.affiliateAtoms, now);
              case null assert item.affiliateAtoms == 0;
            };
            Journal.addCredit(db, row.route.ledger, marketplace, true, item.burnAtoms, now);
          };
          ignore Journal.must(db.evmInvoices.update({ invoice(id) with revenueFinalizedAtNs = ?now; updatedAtNs = now; lastError = null }));
          ignore Journal.must(db.orders.update({ savedOrder with state = #complete; finalizedAtNs = ?now; updatedAtNs = now; lastError = null }));
        };
        case (#buyer_credit) {
          assert row.canceledAtNs != null or row.revenueFinalizedAtNs != null;
          Journal.addCredit(db, row.route.ledger, row.owner, false, value.amount, now);
          ignore Journal.must(db.evmInvoices.update({ row with creditedBuyerAtoms = row.creditedBuyerAtoms + value.amount; updatedAtNs = now; lastError = null }));
        };
      };
      ignore Journal.must(db.evmSweeps.update({ value with finalizedAtNs = ?now; updatedAtNs = now }));
      let latest = invoice(id);
      let debit = value.amount + value.fee;
      let remaining = switch (latest.lastBalance) { case (?balance) { if (balance >= debit) ?(balance - debit) else null }; case (_) null };
      let excess = switch remaining { case (?balance) balance > applicableFee(latest); case null false };
      ignore Journal.must(db.evmInvoices.update({ latest with lastBalance = remaining;
        workClass = if (excess) 0 else 1; nextCheckAtNs = now + (if (excess) activeIntervalNs else idleIntervalNs) }));
    };
    func dispatch(id : Nat64, value : Types.EvmSweep) : async* API.Result<InvoiceResult> {
      let wire = Journal.found(Store.getAttempt(db, value.attemptId));
      if (wire.state == #succeeded) { finalizeSweep(id, value.id); return #ok(result(invoice(id))) };
      if (State.next(Journal.evidence(wire)) == #review_required) {
        return #ok(result(note(id, ?"The original sweep outcome needs review. Its exact request remains reserved; no replacement transfer was created.", idleIntervalNs)));
      };
      let dispatched = Journal.markDispatched(db, wire, clock());
      let outcome = await* clients.ledger.transfer(dispatched.request.ledger, Journal.transferArgs(dispatched.request));
      let observed = Journal.observe(db, wire.id, outcome, clock());
      if (observed.state == #succeeded) {
        // Guaranteed ledger reply is durable before earnings/entitlements can
        // trap. Continuations finalize this block without another transfer.
        await async { finalizeSweep(id, value.id) };
        return #ok(result(invoice(id)));
      };
      #ok(result(note(id, observed.lastError, activeIntervalNs)));
    };
    func driveSettle(id : Nat64) : async* API.Result<InvoiceResult> {
      let retained = invoice(id);
      if (retained.acceptedReceiptId != null and retained.canceledAtNs == null and retained.entitlementGrantedAtNs == null) grant(id, null);
      let initial = invoice(id);
      switch (sweep(initial)) {
        case (?prior) if (prior.finalizedAtNs == null) {
          let wire = Journal.found(Store.getAttempt(db, prior.attemptId));
          if (wire.state != #no_effect or wire.hadUnknown) return await* dispatch(id, prior);
          // A proven no-effect rejection permits a fresh wire request. Its
          // predecessor remains intact; no uncertain debit can cross this branch.
        };
        case (_) {};
      };
      let balance = switch (await* Minter.invoiceBalance(clients.minter, marketplace, initial.subaccount)) {
        case (#ok(value)) value;
        case (#err(message)) return #ok(result(note(id, ?message, activeIntervalNs)));
      };
      let current = invoice(id);
      let row = Journal.must(db.evmInvoices.update({ current with lastBalance = ?balance; lastBalanceAtNs = ?clock(); updatedAtNs = clock(); lastError = null }));
      let fee = applicableFee(row);
      if (row.canceledAtNs == null and row.revenueFinalizedAtNs == null) {
        if (balance < row.saleAtoms + fee) {
          let message = if (balance >= row.saleAtoms) ?"The invoice needs more ckUSDC to cover the ledger sweep fee. Revenue allocations have not been reduced."
            else if (row.acceptedReceiptId != null) ?"Ethereum payment is verified. Waiting for the minter to credit this invoice."
            else null;
          return #ok(result(note(id, message, if (row.acceptedReceiptId != null or balance > 0) activeIntervalNs else idleIntervalNs)));
        };
        return await* dispatch(id, makeSweep(row, #sale, row.saleAtoms, fee));
      };
      if (balance <= fee) return #ok(result(note(id,
        if (balance == 0) null else ?"This invoice retains a small ckUSDC balance at or below the transfer fee. It remains available if further funds arrive.", idleIntervalNs)));
      // Only excess after a completed sale, or funds of a canceled invoice, can
      // become buyer credit. The sale itself is never automatically refunded.
      await* dispatch(id, makeSweep(row, #buyer_credit, balance - fee, fee));
    };
    func run(owner : Principal, requestId : Text, transactionHash : ?Text) : async* API.Result<InvoiceResult> {
      let ?saved = Store.getEvmInvoiceByRequest(db, owner, requestId) else return error("invoice_missing", "No Ethereum invoice exists for this request.");
      if (isActive(saved.id)) return #ok(result(saved));
      Set.add(active, Nat64.compare, saved.id);
      try {
        let outcome = await async {
          switch transactionHash { case (?hash) await* driveVerify(saved.id, hash); case null await* driveSettle(saved.id) };
        };
        Set.remove(active, Nat64.compare, saved.id);
        switch outcome { case (#ok(_)) #ok(result(invoice(saved.id))); case (#err(value)) #err(value) };
      } catch errorValue {
        Set.remove(active, Nat64.compare, saved.id);
        ignore note(saved.id, ?Error.message(errorValue), activeIntervalNs);
        error("ethereum_processing", "Ethereum invoice processing was interrupted. Its saved evidence and exact ledger request remain available: " # Error.message(errorValue));
      };
    };
    public func verify(owner : Principal, requestId : Text, transactionHash : Text) : async* API.Result<InvoiceResult> {
      await* run(owner, requestId, ?transactionHash);
    };
    public func settle(owner : Principal, requestId : Text) : async* API.Result<InvoiceResult> { await* run(owner, requestId, null) };
    public func cancel(owner : Principal, requestId : Text) : API.Result<InvoiceResult> {
      let ?row = Store.getEvmInvoiceByRequest(db, owner, requestId) else return error("invoice_missing", "No Ethereum invoice exists for this request.");
      if (row.canceledAtNs != null) return #ok(result(row));
      if (row.entitlementGrantedAtNs != null or row.revenueFinalizedAtNs != null) return error("already_acquired", "This sale already granted the apps and cannot be canceled as an unpaid invoice.");
      switch (sweep(row)) {
        case (?value) if (value.finalizedAtNs == null) {
          let wire = Journal.found(Store.getAttempt(db, value.attemptId));
          if (not State.canReplaceAttempt(Journal.evidence(wire))) return error("sweep_pending", "The original sale sweep is already processing. Resume this request before changing its disposition.");
        };
        case (_) {};
      };
      releaseClaims(row);
      let now = clock();
      let saved = Journal.must(db.evmInvoices.update({ row with canceledAtNs = ?now; workClass = 1; nextCheckAtNs = now; updatedAtNs = now;
        lastError = ?"Invoice canceled. Any later ckUSDC will remain attributable to this buyer as unapplied credit." }));
      ignore Journal.must(db.orders.update({ order(row) with state = #failed; updatedAtNs = now; lastError = saved.lastError }));
      #ok(result(saved));
    };
    func due(now : Int) : ?Types.EvmInvoice {
      for (workClass in ([0, 1] : [Nat8]).vals()) {
        for (row in db.evmInvoices.by_due.rangeIter({ gte = ?(workClass, 0 : Int, 0 : Nat64); gt = null; lt = null; lte = ?(workClass, now, maxId); dir = #fwd }, null)) {
          if (not isActive(row.id)) return ?row;
        };
      };
      null;
    };
    public func tick() : async* Bool {
      let now = clock();
      // Select before awaiting; the index can change while the request yields.
      switch (due(now)) { case (?row) ignore await* settle(row.owner, row.requestId); case null {} };
      due(clock()) != null;
    };
  };
}
