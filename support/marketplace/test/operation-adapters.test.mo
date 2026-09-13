// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Test "mo:test";
import API "../mo/API";
import Encoding "../mo/Encoding";
import Ledger "../mo/Ledger";
import Operations "../mo/Operations";
import PublisherStore "../mo/PublisherStore";
import Purchases "../mo/Purchases";
import Quotes "../mo/Quotes";
import ReleaseStore "../mo/ReleaseStore";
import Store "../mo/Store";
import Types "../mo/Types";
import F "motoko/Fixtures";

persistent actor OperationAdapterTests {
  func accepted<T>(value : API.Result<T>) : T {
    switch (value) { case (#ok(value)) value; case (#err(error)) Runtime.trap(debug_show(error)) };
  };
  func found<T>(value : ?T) : T {
    switch (value) { case (?value) value; case null Runtime.trap("Missing fixture value") };
  };
  func assertError<T>(value : API.Result<T>, code : Text, message : Text) {
    switch (value) { case (#err(error)) assert error == { code; message }; case (#ok(_)) Runtime.trap("Expected rejection: " # code) };
  };
  func marketplace() : Principal { Principal.fromActor(OperationAdapterTests) };
  func setup() : Store.DB {
    let db = Store.Use(F.memory(), PublisherStore.init(), ReleaseStore.init());
    Store.setConfig(db, { Store.config(db) with tokens = [{ ledger = marketplace(); symbol = "ckUSDC"; decimals = 6; fee = 10_000; rateSymbol = "USDC"; burnAccount = null }] });
    ignore F.stored(Store.putRate(db, { ledger = marketplace(); symbol = "USDC"; usdRate = 1_000_000_000; decimals = 9; observedAtNs = 1; refreshedAtNs = 1; lastError = null }));
    db;
  };
  func release(db : Store.DB, version : Nat, mode : API.ChannelMode) {
    if (Store.getApp(db, "root") == null) ignore F.draft(db, "root", 1_000_000);
    let candidate = F.candidate(db, "root", version, "release-" # debug_show(version));
    let saved = F.stored(db.candidates.update({ candidate with state = #approved; published = true }));
    let heads = ReleaseStore.heads(db.channels, "root");
    ReleaseStore.putHeads(db.channels, "root", switch (mode) {
      case (#stable_) ({ heads with stableHead = { candidateId = ?saved.id; revision = heads.stableHead.revision + 1 } });
      case (#beta) ({ heads with betaHead = { candidateId = ?saved.id; revision = heads.betaHead.revision + 1 } });
    });
  };
  func request(id : Text) : API.PurchaseRequest {
    { requestId = id; appIds = ["root"]; ledger = marketplace(); referralCode = null };
  };
  func channelRequest(id : Text) : API.ChannelPurchaseRequest {
    { request = request(id); mode = #beta; expectedSelection = null };
  };
  func complete(db : Store.DB, snapshot : Quotes.PurchaseSnapshot, retain : Bool) : Types.Order {
    let saved = F.stored(Store.insertOrder(db, { Quotes.snapshotOrder(snapshot, 11) with state = #complete; finalizedAtNs = ?11 }));
    if (retain) {
      let content = switch (snapshot) { case (#legacy(value)) to_candid(value); case (#channel(value)) to_candid(value) };
      ignore F.stored(Store.insertQuoteRecord(db, { owner = saved.owner; requestId = saved.requestId; kind = #purchase; commitment = saved.quoteCommitment; content; createdAtNs = 11 }));
    };
    saved;
  };
  func invoice(db : Store.DB, quote : API.CheckoutQuote) {
    let order = F.stored(Store.insertOrder(db, Quotes.order(quote, 11)));
    ignore F.stored(Store.insertEvmInvoice(db, {
      owner = order.owner; requestId = order.requestId; orderId = order.id;
      subaccount = Encoding.hash("invoice");
      route = { chainId = 1; minter = F.owner(); helper = "0x1111111111111111111111111111111111111111";
        minterAddress = "0x2222222222222222222222222222222222222222";
        token = "0x3333333333333333333333333333333333333333"; ledger = order.ledger; decimals = 6 };
      payer = "0x4444444444444444444444444444444444444444"; quoteContent = to_candid(quote);
      saleAtoms = order.amount; grossAtoms = order.amount + order.fee; sweepFee = order.fee;
      canceledAtNs = null; acceptedReceiptId = null; entitlementGrantedAtNs = null;
      revenueFinalizedAtNs = null; currentSweepId = null; nextSweepOrdinal = 0;
      creditedBuyerAtoms = 0; lastBalance = null; lastBalanceAtNs = null; workClass = 0; nextCheckAtNs = 11;
      createdAtNs = 11; updatedAtNs = 11; lastError = null;
    }));
  };

  public func execution_preserves_legacy_and_channel_validation_order() : async Test.Metrics {
    let db = setup();
    release(db, 100, #stable_);
    let service = Operations.Service(db, marketplace(), func() { 20 });
    let legacy = accepted(service.purchaseQuote(F.other(), request("ethereum")));
    let channel = accepted(service.purchaseQuoteV2(F.other(), channelRequest("ethereum")));
    invoice(db, legacy);
    let rail = "This purchase uses Ethereum. Resume its original Ethereum invoice.";
    let owner = "The purchase review belongs to another Neutron.";
    assertError(await* service.purchase(F.other(), { legacy with buyer = F.owner() }), "payment_rail", rail);
    assertError(await* service.purchaseV2(F.other(), { channel with quote = { channel.quote with buyer = F.owner() } }), "owner_mismatch", owner);
    assertError(await* service.purchaseV2(F.other(), channel), "payment_rail", rail);
    assertError(service.purchaseQuote(F.other(), { legacy.request with appIds = ["missing"] }), "payment_rail", rail);
    assertError(service.purchaseQuoteV2(F.other(), { channelRequest("ethereum") with mode = #stable_ }), "payment_rail", rail);
    let fresh = accepted(service.purchaseQuote(F.other(), request("fresh")));
    assertError(await* service.purchase(F.other(), { fresh with buyer = F.owner() }), "owner_mismatch", owner);
    Test.test(func() { assert db.orders.size() == 1 and db.quoteRecords.size() == 0 and db.attempts.size() == 0 });
  };

  public func frozen_request_identity_precedes_missing_snapshot_errors() : async Test.Metrics {
    Test.test(func() {
      let db = setup();
      release(db, 100, #stable_);
      let service = Operations.Service(db, marketplace(), func() { 20 });
      let legacy = accepted(service.purchaseQuote(F.other(), request("legacy-missing")));
      let channel = accepted(service.purchaseQuoteV2(F.other(), channelRequest("channel-missing")));
      ignore complete(db, #legacy(legacy), false);
      ignore complete(db, #channel(channel), false);
      assertError(service.purchaseQuote(F.other(), { legacy.request with appIds = ["missing"] }), "request_mismatch",
        "This purchase ID belongs to another selection. Retain its original request to recover it.");
      assertError(service.purchaseQuoteV2(F.other(), { channelRequest("channel-missing") with mode = #stable_ }), "request_mismatch",
        "This purchase ID belongs to another selection or channel. Retain its original request to recover it.");
      let missing = "The original payment snapshot is unavailable. Inspect its saved attempt; do not create a replacement purchase.";
      assertError(service.purchaseQuote(F.other(), legacy.request), "quote_unavailable", missing);
      assertError(service.purchaseQuoteV2(F.other(), channelRequest("channel-missing")), "quote_unavailable", missing);
      assert db.quoteRecords.size() == 0 and db.attempts.size() == 0;
    });
  };

  public func frozen_selection_errors_precede_protocol_specific_quote_errors() : async Test.Metrics {
    let db = setup();
    release(db, 100, #stable_);
    let service = Operations.Service(db, marketplace(), func() { 20 });
    let legacy = accepted(service.purchaseQuote(F.other(), request("legacy-frozen")));
    let channel = accepted(service.purchaseQuoteV2(F.other(), channelRequest("channel-frozen")));
    ignore complete(db, #legacy(legacy), true);
    ignore complete(db, #channel(channel), true);
    release(db, 101, #stable_);
    release(db, 102, #beta);
    let staleSelection = Array.map<API.ReleaseSelection, API.ReleaseSelection>(channel.selection, func(value) { { value with version = value.version + 1 } });
    assertError(await* service.purchaseV2(F.other(), { channel with selection = staleSelection; quote = { channel.quote with amount = 0 } }), "selection_changed",
      "The reviewed release changed. Review the current selection before continuing.");
    assertError(await* service.purchase(F.other(), { legacy with amount = 0 }), "quote_changed",
      "Purchase costs or availability changed. Review a fresh quote under this same request ID before continuing.");
    assertError(await* service.purchaseV2(F.other(), { channel with quote = { channel.quote with amount = 0 } }), "quote_changed",
      "Purchase costs or release selection changed. Review a fresh quote under this same request ID before continuing.");
    Test.test(func() {
      assert accepted(service.purchaseQuote(F.other(), legacy.request)) == legacy;
      assert accepted(service.purchaseQuoteV2(F.other(), channelRequest("channel-frozen"))) == channel;
      assert db.orders.size() == 2 and db.quoteRecords.size() == 2 and db.attempts.size() == 0;
    });
  };

  // This actor also serves as the fixture ledger, so the active retry goes
  // through the production Ledger.client() and an actual inter-canister await.
  transient var onTransfer : Ledger.TransferFromArgs -> async* () = func(_ : Ledger.TransferFromArgs) : async* () {
    Runtime.trap("Unexpected ledger collection");
  };
  public func icrc2_transfer_from(args : Ledger.TransferFromArgs) : async Ledger.TransferFromResult {
    await* onTransfer(args);
    #Ok(77);
  };

  func paidRetries(channelMode : Bool) : async* Test.Metrics {
    let db = setup();
    release(db, 100, if (channelMode) #beta else #stable_);
    var now = 20;
    let service = Operations.Service(db, marketplace(), func() { now });
    let input = request(if (channelMode) "channel-active" else "legacy-active");
    let snapshot : Quotes.PurchaseSnapshot = if (channelMode) {
      #channel(accepted(service.purchaseQuoteV2(F.other(), { request = input; mode = #beta; expectedSelection = null })));
    } else #legacy(accepted(service.purchaseQuote(F.other(), input)));
    let reviewed = Quotes.snapshotQuote(snapshot);
    let content = switch (snapshot) { case (#legacy(value)) to_candid(value); case (#channel(value)) to_candid(value) };
    let legacyIntent = Encoding.hash(to_candid("neutron.marketplace.purchase.intent.v1", input.requestId,
      Array.sort<Text>(input.appIds, Text.compare), input.ledger, input.referralCode));
    let intent = if (channelMode) Encoding.hash(to_candid("neutron.marketplace.purchase.intent.v2", legacyIntent, #beta : API.ChannelMode)) else legacyIntent;
    func invoke(supplied : Quotes.PurchaseSnapshot) : async* API.PurchaseResult {
      switch (supplied) {
        case (#legacy(value)) accepted(await* service.purchase(F.other(), value));
        case (#channel(value)) {
          let result = accepted(await* service.purchaseV2(F.other(), value));
          assert result.quote == ?value;
          result.purchase;
        };
      };
    };
    var calls = 0;
    onTransfer := func(args : Ledger.TransferFromArgs) : async* () {
      calls += 1;
      assert calls == 1;
      let order = found(Store.getOrder(db, F.other(), input.requestId));
      let attempt = found(Store.getAttempt(db, found(order.currentAttempt)));
      assert args.spender_subaccount == reviewed.spender.subaccount;
      assert args.from == { owner = F.other(); subaccount = null };
      assert args.to == { owner = marketplace(); subaccount = null };
      assert args.amount == reviewed.amount and args.fee == ?reviewed.fee;
      assert args.memo == ?attempt.request.memo and args.created_at_time == ?attempt.request.createdAtTimeNs;
      assert order.intentHash == intent and order.quoteCommitment == reviewed.commitment;
      assert order.state == #dispatched and attempt.state == #dispatched;
      release(db, 101, if (channelMode) #beta else #stable_);
      now := 30;
      let active = await* invoke(snapshot);
      assert active.order == order and active.attempt == ?attempt and active.quote == ?reviewed;
      assert active.active and active.nextAction == #await_current_call;
      assert found(Store.getQuoteRecord(db, F.other(), #purchase, input.requestId, reviewed.commitment)).content == content;
      assert db.orders.size() == 1 and db.quoteRecords.size() == 1 and db.attempts.size() == 1 and db.entitlements.size() == 0;
    };
    let completed = await* invoke(snapshot);
    onTransfer := func(_ : Ledger.TransferFromArgs) : async* () { Runtime.trap("Completed replay attempted another collection") };
    now := 40;
    let changedDiagnostics = { reviewed with quotedAtNs = 999; rate = ?{ found(reviewed.rate) with refreshedAtNs = 999; lastError = ?"Display-only oracle warning" } };
    let replay = switch (snapshot) {
      case (#legacy(_)) accepted(await* service.purchase(F.other(), changedDiagnostics));
      case (#channel(value)) {
        let result = accepted(await* service.purchaseV2(F.other(), { value with quote = changedDiagnostics }));
        assert result.quote == ?value;
        result.purchase;
      };
    };
    let record = found(Store.getQuoteRecord(db, F.other(), #purchase, input.requestId, reviewed.commitment));
    let expectedSpender = Encoding.hash(to_candid("neutron.marketplace.purchase.spender.v1", marketplace(),
      completed.order.owner, completed.order.requestId, intent, reviewed.commitment, input.ledger,
      reviewed.amount, reviewed.fee, reviewed.affiliate, found(reviewed.rate).id, reviewed.items));
    Test.test(func() {
      assert replay == completed and replay.order.state == #complete;
      assert not replay.active and replay.nextAction == #none and replay.quote == ?reviewed;
      assert found(replay.attempt).block == ?77;
      assert record.content == content and record.content != to_candid(snapshot);
      assert Quotes.decodePurchaseSnapshot(record.content) == ?snapshot;
      assert record.createdAtNs == 20 and replay.order.createdAtNs == 20;
      assert replay.order.intentHash == intent and replay.order.quoteCommitment == reviewed.commitment;
      assert reviewed.spender == { owner = marketplace(); subaccount = ?expectedSpender };
      assert Purchases.spenderSubaccount(marketplace(), replay.order) == expectedSpender;
      assert found(replay.attempt).request.spenderSubaccount == ?expectedSpender;
      assert calls == 1 and db.orders.size() == 1 and db.quoteRecords.size() == 1 and db.attempts.size() == 1;
      assert db.entitlements.size() == 1 and db.acquisitions.size() == 1 and db.claims.size() == 0;
      switch (snapshot) {
        case (#legacy(_)) assert found(service.purchaseStatusV2(F.other(), input.requestId)).quote == null;
        case (#channel(value)) assert found(service.purchaseStatusV2(F.other(), input.requestId)).quote == ?value;
      };
    });
  };

  public func legacy_active_and_completed_retries_preserve_payment_bytes() : async Test.Metrics {
    await* paidRetries(false);
  };
  public func channel_active_and_completed_retries_preserve_payment_bytes() : async Test.Metrics {
    await* paidRetries(true);
  };
}
