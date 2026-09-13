// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Test "mo:test";
import API "../mo/API";
import Encoding "../mo/Encoding";
import EvmPayments "../mo/EvmPayments";
import EvmPaymentsEvidence "../mo/EvmEvidence";
import EvmPaymentsRpc "../mo/EvmRpc";
import Ledger "../mo/Ledger";
import Minter "../mo/EvmMinter";
import Operations "../mo/Operations";
import PublisherStore "../mo/PublisherStore";
import Purchases "../mo/Purchases";
import Quotes "../mo/Quotes";
import ReleaseStore "../mo/ReleaseStore";
import Store "../mo/Store";
import Types "../mo/Types";
import F "motoko/Fixtures";

persistent actor ChannelPurchaseTests {
  func accepted<T>(value : API.Result<T>) : T {
    switch (value) { case (#ok(value)) value; case (#err(error)) Runtime.trap(debug_show(error)) };
  };
  func found<T>(value : ?T) : T { switch (value) { case (?value) value; case null Runtime.trap("Missing fixture value") } };
  func rejected<T>(value : API.Result<T>) : API.Error {
    switch (value) { case (#err(error)) error; case (#ok(_)) Runtime.trap("Expected rejection") };
  };
  func marketplace() : Principal { Principal.fromActor(ChannelPurchaseTests) };
  func setup() : Store.DB {
    let db = Store.Use(F.memory(), PublisherStore.init(), ReleaseStore.init());
    Store.setConfig(db, { Store.config(db) with tokens = [{ ledger = F.other(); symbol = "ckUSDC"; decimals = 6; fee = 10_000; rateSymbol = "USDC"; burnAccount = null }] });
    ignore F.stored(Store.putRate(db, { ledger = F.other(); symbol = "USDC"; usdRate = 1_000_000_000; decimals = 9; observedAtNs = 1; refreshedAtNs = 1; lastError = null }));
    db;
  };
  func release(db : Store.DB, appId : Text, version : Nat, price : Nat, mode : API.ChannelMode, requestId : Text, dependencies : [{ appId : Text; minVersion : Nat }]) : Types.Candidate {
    if (Store.getApp(db, appId) == null) ignore F.draft(db, appId, price);
    let candidate = F.candidate(db, appId, version, requestId);
    let saved = F.stored(db.candidates.update({ candidate with state = #approved; published = true; dependencies }));
    let heads = ReleaseStore.heads(db.channels, appId);
    let changed = switch (mode) {
      case (#stable_) ({ heads with stableHead = { candidateId = ?saved.id; revision = heads.stableHead.revision + 1 } });
      case (#beta) ({ heads with betaHead = { candidateId = ?saved.id; revision = heads.betaHead.revision + 1 } });
    };
    ReleaseStore.putHeads(db.channels, appId, changed);
    saved;
  };
  func request(id : Text) : API.PurchaseRequest {
    { requestId = id; appIds = ["root"]; ledger = F.other(); referralCode = null };
  };
  func channelRequest(id : Text, mode : API.ChannelMode) : API.ChannelPurchaseRequest {
    { request = request(id); mode; expectedSelection = null };
  };
  func channelQuote(db : Store.DB, id : Text, mode : API.ChannelMode) : API.ChannelCheckoutQuote {
    accepted(Quotes.purchaseV2(db, marketplace(), F.other(), channelRequest(id, mode), 10));
  };
  func own(db : Store.DB, appId : Text) {
    ignore F.stored(Store.insertEntitlement(db, { owner = F.other(); appId; orderId = 0; kind = #paid; acquiredAtNs = 1 }));
  };
  func freeze(db : Store.DB, quote : Quotes.PurchaseSnapshot) : Types.Order {
    let proposed = Quotes.snapshotOrder(quote, 11);
    let saved = F.stored(Store.insertOrder(db, { proposed with state = #complete; finalizedAtNs = ?11 }));
    ignore F.stored(Store.insertQuoteRecord(db, { owner = saved.owner; requestId = saved.requestId; kind = #purchase; commitment = saved.quoteCommitment; content = Quotes.snapshotContent(quote); createdAtNs = 11 }));
    saved;
  };
  func unresolved(db : Store.DB, snapshot : Quotes.PurchaseSnapshot) : Types.Order {
    let saved = freeze(db, snapshot);
    let attempt = F.stored(Store.insertAttempt(db, {
      owner = saved.owner; operationKind = #purchase; operationId = saved.id; ordinal = 0;
      request = { kind = #transfer_from; ledger = saved.ledger; spenderSubaccount = ?Purchases.spenderSubaccount(marketplace(), saved);
        fromAccount = { owner = saved.owner; subaccount = null }; to = { owner = marketplace(); subaccount = null };
        amount = saved.amount; fee = saved.fee; memo = Encoding.hash("payment"); createdAtTimeNs = 11 };
      state = #outcome_unknown; hadUnknown = true; block = null; duplicate = false; lastLedgerError = null;
      lastError = ?"Reply lost"; createdAtNs = 11; updatedAtNs = 11;
    }));
    F.stored(db.orders.update({ saved with state = #outcome_unknown; currentAttempt = ?attempt.id; finalizedAtNs = null }));
  };
  func evmClients(beforeDiscovery : () -> ()) : EvmPayments.Clients {
    {
      ledger = {
        transfer = func(_ : Principal, _ : Ledger.TransferArgs) : async* Ledger.Outcome { Runtime.trap("Unexpected payment") };
        transferFrom = func(_ : Principal, _ : Ledger.TransferFromArgs) : async* Ledger.Outcome { Runtime.trap("Unexpected payment") };
      };
      minter = {
        getInfo = func(_ : Principal) : async* Minter.Result<Minter.Info> {
          beforeDiscovery();
          #ok({ minter_address = ?"0x1111111111111111111111111111111111111111";
            deposit_with_subaccount_helper_contract_address = ?"0x2222222222222222222222222222222222222222";
            supported_ckerc20_tokens = ?[{ erc20_contract_address = Minter.usdcAddress; ledger_canister_id = Minter.ckusdcLedger() }] });
        };
        isAddressBlocked = func(_ : Principal, _ : Text) : async* Minter.Result<Bool> { #ok(false) };
        balanceOf = func(_ : Principal, _ : Ledger.Account) : async* Minter.Result<Nat> { #ok(0) };
      };
      verify = func(_ : EvmPaymentsEvidence.Expected) : async* EvmPaymentsRpc.Result<EvmPaymentsEvidence.Proof> { Runtime.trap("Unexpected Ethereum verification") };
    };
  };

  public func legacy_quote_bytes_and_recovery_remain_unchanged() : async Test.Metrics {
    Test.test(func() {
      let db = setup();
      ignore release(db, "root", 100, 1_000_000, #stable_, "old", []);
      let input = request("legacy-payment");
      let quote = accepted(Quotes.purchase(db, marketplace(), F.other(), input, 10));
      let intent = Encoding.hash(to_candid("neutron.marketplace.purchase.intent.v1", input.requestId,
        Array.sort<Text>(input.appIds, Text.compare), input.ledger, input.referralCode));
      assert Quotes.purchaseIntent(input) == intent;
      let rate = found(quote.rate);
      let observation = ?(rate.ledger, rate.usdRate, rate.decimals, rate.observedAtNs);
      assert quote.commitment == Encoding.hash(to_candid("neutron.marketplace.purchase.quote.v1", marketplace(), F.other(), intent,
        quote.items, quote.amount, quote.fee, quote.affiliate, observation, Store.config(db).referralTerms));
      assert Quotes.decodePurchaseSnapshot(to_candid(quote)) == ?#legacy(quote);
      let saved = unresolved(db, #legacy(quote));
      let spender = Purchases.spenderSubaccount(marketplace(), saved);
      ignore release(db, "root", 101, 1_000_000, #beta, "new", []);
      let restored = Operations.Service(db, marketplace(), func() { 20 });
      assert accepted(restored.purchaseQuote(F.other(), input)) == quote;
      assert found(restored.purchaseStatusV2(F.other(), input.requestId)).quote == null;
      assert Purchases.spenderSubaccount(marketplace(), saved) == spender;
      assert rejected(restored.purchaseQuoteV2(F.other(), channelRequest(input.requestId, #stable_))).code == "request_mismatch";
    });
  };

  public func channel_quote_binds_owned_dependencies_kernel_and_mode() : async Test.Metrics {
    Test.test(func() {
      let db = setup();
      ignore release(db, "kernel", 100, 0, #stable_, "kernel-old", []);
      ignore release(db, "leaf", 100, 2_000_000, #stable_, "leaf-old", []);
      ignore release(db, "root", 100, 1_000_000, #stable_, "root-old", [{ appId = "leaf"; minVersion = 100 }, { appId = "kernel"; minVersion = 100 }]);
      own(db, "leaf");
      let baseline = channelQuote(db, "graph", #beta);
      assert Array.map<API.ReleaseSelection, Text>(baseline.selection, func(value) { value.appId }) == ["kernel", "leaf", "root"];
      assert baseline.quote.items.size() == 1 and baseline.quote.amount == 1_000_000;
      assert baseline.quote.items[0].appId == "root";
      let stableQuote = channelQuote(db, "graph", #stable_);
      assert stableQuote.selection == baseline.selection and stableQuote.quote.commitment != baseline.quote.commitment;
      ignore release(db, "leaf", 101, 2_000_000, #beta, "leaf-new", []);
      let changed = channelQuote(db, "graph", #beta);
      assert changed.quote.items == baseline.quote.items and changed.quote.commitment != baseline.quote.commitment;
      assert channelQuote(db, "graph", #stable_) == stableQuote;
      assert rejected(Quotes.purchaseV2(db, marketplace(), F.other(), { channelRequest("graph", #beta) with expectedSelection = ?baseline.selection }, 10)).code == "selection_changed";
      ignore release(db, "unrelated", 100, 0, #beta, "unrelated", []);
      assert channelQuote(db, "graph", #beta) == changed;
      assert Quotes.decodePurchaseSnapshot(to_candid(changed)) == ?#channel(changed);
    });
  };

  public func frozen_channel_payment_recovers_its_original_release_selection() : async Test.Metrics {
    Test.test(func() {
      let db = setup();
      ignore release(db, "root", 100, 1_000_000, #beta, "root-first", []);
      let reviewed = channelQuote(db, "frozen", #beta);
      let saved = unresolved(db, #channel(reviewed));
      let next = release(db, "root", 101, 1_000_000, #beta, "root-next", []);
      ignore F.stored(db.candidates.update({ next with state = #revoked }));
      let restored = Operations.Service(db, marketplace(), func() { 20 });
      assert accepted(restored.purchaseQuoteV2(F.other(), channelRequest("frozen", #beta))) == reviewed;
      let status = found(restored.purchaseStatusV2(F.other(), "frozen"));
      assert status.quote == ?reviewed and status.purchase.order == saved;
      assert rejected(restored.purchaseQuoteV2(F.other(), channelRequest("frozen", #stable_))).code == "request_mismatch";
      assert rejected(restored.purchaseQuote(F.other(), request("frozen"))).code == "request_mismatch";
      assert Purchases.spenderSubaccount(marketplace(), saved) == found(reviewed.quote.spender.subaccount);
    });
  };

  public func free_channel_execute_retains_selection_and_replays_after_publication() : async Test.Metrics {
    let db = setup();
    ignore release(db, "kernel", 100, 0, #stable_, "kernel-free", []);
    ignore release(db, "root", 100, 0, #beta, "root-free", [{ appId = "kernel"; minVersion = 100 }]);
    let service = Operations.Service(db, marketplace(), func() { 20 });
    let reviewed = accepted(service.purchaseQuoteV2(F.other(), channelRequest("free", #beta)));
    let tampered = { reviewed with selection = Array.map<API.ReleaseSelection, API.ReleaseSelection>(reviewed.selection, func(entry) { { entry with version = entry.version + 1 } }) };
    assert rejected(await* service.purchaseV2(F.other(), tampered)).code == "selection_changed";
    assert db.orders.size() == 0 and db.entitlements.size() == 0;
    let acquired = accepted(await* service.purchaseV2(F.other(), reviewed));
    ignore release(db, "root", 101, 0, #beta, "root-free-next", [{ appId = "kernel"; minVersion = 100 }]);
    let restored = Operations.Service(db, marketplace(), func() { 30 });
    let replay = accepted(await* restored.purchaseV2(F.other(), reviewed));
    Test.test(func() {
      assert acquired == replay and replay.quote == ?reviewed;
      assert replay.purchase.order.state == #complete;
      assert db.orders.size() == 1 and db.entitlements.size() == 1 and db.attempts.size() == 0;
      assert Store.getEntitlement(db, F.other(), "root") != null;
      assert Store.getEntitlement(db, F.other(), "kernel") == null;
      assert replay.purchase.order.intentHash == Quotes.channelPurchaseIntent(reviewed.quote.request, reviewed.mode);
    });
  };

  public func legacy_ethereum_invoice_remains_recoverable_from_v2_status() : async Test.Metrics {
    let db = setup();
    ignore release(db, "root", 100, 1_000_000, #stable_, "root-legacy", []);
    let service = EvmPayments.Service(db, marketplace(), func() { 20 }, evmClients(func() {}), func(_, _, _) {});
    let reviewed = accepted(service.quote(F.other(), request("legacy-ethereum")));
    let payer = "0x3333333333333333333333333333333333333333";
    let prepared = accepted(await* service.prepare(F.other(), reviewed, payer));
    ignore release(db, "root", 101, 1_000_000, #beta, "root-successor", []);
    let restored = EvmPayments.Service(db, marketplace(), func() { 30 }, evmClients(func() { Runtime.trap("Legacy recovery must use its original route") }), func(_, _, _) {});
    let replay = accepted(await* restored.prepare(F.other(), reviewed, payer));
    Test.test(func() {
      assert replay == prepared and replay.invoice.quoteContent == to_candid(reviewed);
      assert accepted(restored.quote(F.other(), request("legacy-ethereum"))) == reviewed;
      let status = found(restored.statusV2(F.other(), "legacy-ethereum"));
      assert status.invoice == replay and status.quote == null;
      assert restored.historyV2(F.other(), null, 10).invoices == [status];
      assert db.orders.size() == 1 and db.evmInvoices.size() == 1;
    });
  };

  public func ethereum_rechecks_selection_after_discovery_and_retains_original_invoice() : async Test.Metrics {
    let db = setup();
    ignore release(db, "root", 100, 1_000_000, #beta, "root-first", []);
    let initial = channelQuote(db, "ethereum", #beta);
    var changed = false;
    let service = EvmPayments.Service(db, marketplace(), func() { 20 }, evmClients(func() {
      if (not changed) { changed := true; ignore release(db, "root", 101, 1_000_000, #beta, "root-next", []) };
    }), func(_, _, _) {});
    let payer = "0x3333333333333333333333333333333333333333";
    assert rejected(await* service.prepareV2(F.other(), initial, payer)).code == "selection_changed";
    assert db.orders.size() == 0 and db.evmInvoices.size() == 0 and db.claims.size() == 0;
    let reviewed = accepted(service.quoteV2(F.other(), channelRequest("ethereum", #beta)));
    let prepared = accepted(await* service.prepareV2(F.other(), reviewed, payer));
    ignore release(db, "root", 102, 1_000_000, #beta, "root-later", []);
    let restored = EvmPayments.Service(db, marketplace(), func() { 30 }, evmClients(func() { Runtime.trap("Recovery must use the retained route") }), func(_, _, _) {});
    let replay = accepted(await* restored.prepareV2(F.other(), reviewed, payer));
    Test.test(func() {
      assert replay == prepared and replay.quote == ?reviewed;
      assert accepted(restored.quoteV2(F.other(), channelRequest("ethereum", #beta))) == reviewed;
      assert found(restored.statusV2(F.other(), "ethereum")) == replay;
      assert restored.historyV2(F.other(), null, 10).invoices == [replay];
      assert db.orders.size() == 1 and db.evmInvoices.size() == 1;
      assert rejected(restored.quote(F.other(), request("ethereum"))).code == "request_mismatch";
    });
  };
}
