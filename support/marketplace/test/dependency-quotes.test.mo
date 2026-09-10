// All rights reserved. See ../LICENSE.
import API "../mo/API";
import Catalog "../mo/Catalog";
import Encoding "../mo/Encoding";
import Http "../mo/Http";
import Ledger "../mo/Ledger";
import Purchases "../mo/Purchases";
import Quotes "../mo/Quotes";
import Repository "../mo/Repository";
import Store "../mo/Store";
import Types "../mo/Types";
import F "motoko/Fixtures";
import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Test "mo:test";

persistent actor DependencyQuoteTests {
  type Dependency = { appId : Text; minVersion : Nat };
  type Context = { db : Store.DB; repo : Repository.Service; http : Http.Store };

  func setup() : Context {
    let db = Store.Use(F.memory());
    let token : Types.TokenConfig = {
      ledger = F.other(); symbol = "ckUSDC"; decimals = 6; fee = 10_000;
      rateSymbol = "USDC"; burnAccount = null;
    };
    Store.setConfig(db, { Store.config(db) with tokens = [token] });
    ignore F.stored(Store.putRate(db, {
      ledger = token.ledger; symbol = "USDC"; usdRate = 1_000_000_000; decimals = 9;
      observedAtNs = 1; refreshedAtNs = 1; lastError = null;
    }));
    let certification = Http.init();
    let repo = Repository.Service(db, certification, Principal.fromActor(DependencyQuoteTests));
    let http = Http.Store(certification, {
      artifact = repo.artifact; chunk = repo.chunk;
      authorize = func(_path : Text, _grant : ?Text) : Bool { true };
    });
    http.initialize();
    repo.initialize(http);
    { db; repo; http };
  };

  func accepted<T>(result : API.Result<T>) : T {
    switch result {
      case (#ok(value)) value;
      case (#err(error)) Runtime.trap("Dependency quote unexpectedly rejected: " # debug_show(error));
    };
  };

  func rejected<T>(result : API.Result<T>) : API.Error {
    switch result {
      case (#err(error)) error;
      case (#ok(_)) Runtime.trap("Dependency quote unexpectedly accepted");
    };
  };

  func release(db : Store.DB, appId : Text, version : Nat, price : Nat, requestId : Text, dependencies : [Dependency]) : Types.Candidate {
    if (Store.getApp(db, appId) == null) ignore F.draft(db, appId, price);
    let candidate = F.candidate(db, appId, version, requestId);
    let linked = F.stored(db.candidates.update({ candidate with dependencies }));
    ignore F.approve(db, linked, requestId # "-audit");
    let ?approved = Store.getCandidate(db, linked.id) else Runtime.trap("Approved dependency fixture missing");
    approved;
  };

  func own(db : Store.DB, appId : Text) {
    ignore F.stored(Store.insertEntitlement(db, {
      owner = F.other(); appId; orderId = 1; kind = #paid; acquiredAtNs = 4;
    }));
  };

  func hide(db : Store.DB, appId : Text) {
    let ?app = Store.getApp(db, appId) else Runtime.trap("Missing fixture listing");
    ignore F.ok(Catalog.save(db, F.owner(), {
      F.listing(appId, app.priceUsdMicros, ?app.revision) with visible = false;
    }, 5));
  };

  func request(requestId : Text, appIds : [Text]) : API.PurchaseRequest {
    { requestId; appIds; ledger = F.other(); referralCode = null };
  };

  func quote(c : Context, input : API.PurchaseRequest) : API.Result<API.CheckoutQuote> {
    Quotes.purchase(c.db, Principal.fromActor(DependencyQuoteTests), F.other(), input, 10);
  };

  func ids(value : API.CheckoutQuote) : [Text] {
    Array.map<Types.PurchaseItem, Text>(value.items, func(item) { item.appId });
  };

  func noPayment(db : Store.DB) {
    assert db.orders.size() == 0 and db.attempts.size() == 0;
    assert db.claims.size() == 0 and db.credits.size() == 0;
  };

  public func root_quote_pays_for_and_installs_all_required_apps() : async Test.Metrics {
    let c = setup();
    ignore release(c.db, "paid_dependency", 100, 3_000_000, "paid", []);
    ignore release(c.db, "free_dependency", 100, 0, "free", []);
    ignore release(c.db, "selected_root", 100, 2_000_000, "root", [
      { appId = "paid_dependency"; minVersion = 100 },
      { appId = "free_dependency"; minVersion = 100 },
    ]);
    let input = request("whole-selection", ["selected_root"]);
    let reviewed = accepted(quote(c, input));
    assert ids(reviewed) == ["free_dependency", "paid_dependency", "selected_root"];
    assert reviewed.request == input and reviewed.amount == 5_000_000 and reviewed.fee == 10_000;
    noPayment(c.db);

    var transfers = 0;
    var finalizations = 0;
    let marketplace = Principal.fromActor(DependencyQuoteTests);
    let client : Ledger.Client = {
      transfer = func(_ : Principal, _ : Ledger.TransferArgs) : async* Ledger.Outcome {
        Runtime.trap("Checkout must collect once with transferFrom");
      };
      transferFrom = func(ledger : Principal, args : Ledger.TransferFromArgs) : async* Ledger.Outcome {
        assert ledger == input.ledger and args.from.owner == F.other();
        assert args.to.owner == marketplace and args.to.subaccount == null;
        assert args.amount == 5_000_000 and args.fee == ?10_000;
        assert args.spender_subaccount == reviewed.spender.subaccount;
        transfers += 1;
        #response(#Ok(77));
      };
    };
    let engine = Purchases.Engine(c.db, client, marketplace, func() { 20 }, func(order, block, _now) {
      assert order.items.size() == 3 and block == ?77;
      finalizations += 1;
    });
    let prepared = F.ok(Purchases.prepare(c.db, Quotes.order(reviewed, 11)));
    let paid = F.ok(await* engine.run(prepared.id));
    let replay = F.ok(await* engine.run(prepared.id));
    let installed = accepted(c.repo.prepare(c.http, F.other(), {
      requestId = "install-acquired-selection"; appIds = input.appIds; feeVersion = 1;
    }, 30));

    Test.test(func() {
      assert paid.state == #complete and replay == paid;
      assert transfers == 1 and finalizations == 1;
      assert c.db.entitlements.size() == 3 and c.db.claims.size() == 0;
      for (item in reviewed.items.vals()) {
        let ?entitlement = Store.getEntitlement(c.db, F.other(), item.appId) else Runtime.trap("Dependency ownership was not granted");
        assert entitlement.orderId == paid.id;
        assert entitlement.kind == (if (item.priceUsdMicros == 0) #free else #paid);
      };
      let ?developer = Store.getCredit(c.db, input.ledger, F.owner(), false) else Runtime.trap("Developer allocation missing");
      let ?burn = Store.getCredit(c.db, input.ledger, marketplace, true) else Runtime.trap("Burn allocation missing");
      assert developer.available == 1_500_000 and burn.available == 3_500_000;
      assert installed.appIds == ids(reviewed);
      let ?manifest = Store.getManifest(c.db, installed.manifestId) else Runtime.trap("Install manifest missing after checkout");
      assert manifest.candidateIds.size() == 3 and manifest.owner == F.other();
      assert Encoding.hex(Encoding.hash(manifest.content)) == installed.digest;
      assert c.repo.chunk(Repository.manifestPath(installed.manifestId), 0) == ?manifest.content;
    });
  };

  public func shared_dependencies_and_cycles_are_priced_once() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "shared", 100, 3_000_000, "shared", [{ appId = "root"; minVersion = 100 }]);
      ignore release(c.db, "left", 100, 2_000_000, "left", [{ appId = "shared"; minVersion = 100 }]);
      ignore release(c.db, "right", 100, 0, "right", [{ appId = "shared"; minVersion = 100 }]);
      ignore release(c.db, "root", 100, 1_000_000, "root", [
        { appId = "left"; minVersion = 100 }, { appId = "right"; minVersion = 100 },
      ]);
      let result = accepted(quote(c, request("diamond-with-cycle", ["root"])));
      assert ids(result) == ["left", "right", "root", "shared"];
      assert result.amount == 6_000_000 and result.items.size() == 4;
      noPayment(c.db);
      assert c.db.entitlements.size() == 0;
    });
  };

  public func owned_delisted_nodes_still_resolve_latest_unowned_descendants() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "owned_dependency", 100, 8_000_000, "owned-old", []);
      ignore release(c.db, "new_paid_leaf", 100, 2_000_000, "new-paid", []);
      ignore release(c.db, "new_free_leaf", 100, 0, "new-free", []);
      ignore release(c.db, "owned_dependency", 101, 8_000_000, "owned-latest", [
        { appId = "new_paid_leaf"; minVersion = 100 }, { appId = "new_free_leaf"; minVersion = 100 },
      ]);
      ignore release(c.db, "owned_root", 100, 9_000_000, "owned-root", [{ appId = "owned_dependency"; minVersion = 100 }]);
      own(c.db, "owned_dependency");
      own(c.db, "owned_root");
      hide(c.db, "owned_dependency");
      hide(c.db, "owned_root");
      let result = accepted(quote(c, request("update-owned-app", ["owned_root"])));
      assert ids(result) == ["new_free_leaf", "new_paid_leaf"];
      assert result.amount == 2_000_000 and result.request.appIds == ["owned_root"];
      assert c.db.entitlements.size() == 2;
      noPayment(c.db);
    });
  };

  public func dependency_minimums_are_checked_again_when_graph_revisits_an_app() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "shared", 100, 1_000_000, "shared-old", []);
      ignore release(c.db, "lower", 100, 0, "lower", [{ appId = "shared"; minVersion = 100 }]);
      ignore release(c.db, "higher", 100, 0, "higher", [{ appId = "shared"; minVersion = 101 }]);
      ignore release(c.db, "root", 100, 1_000_000, "root", [
        { appId = "lower"; minVersion = 100 }, { appId = "higher"; minVersion = 100 },
      ]);
      let input = request("minimum-conflict", ["root"]);
      ignore rejected(quote(c, input));
      noPayment(c.db);
      assert c.db.entitlements.size() == 0;
      ignore release(c.db, "shared", 101, 1_000_000, "shared-current", []);
      let result = accepted(quote(c, input));
      assert result.amount == 2_000_000 and ids(result) == ["higher", "lower", "root", "shared"];
      noPayment(c.db);
    });
  };

  public func kernel_dependencies_are_not_sold_or_required_in_the_catalog() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "root", 100, 1_000_000, "root", [{ appId = "kernel"; minVersion = 99_999 }]);
      let result = accepted(quote(c, request("kernel-is-installed-separately", ["root"])));
      assert Store.getApp(c.db, "kernel") == null;
      assert ids(result) == ["root"] and result.amount == 1_000_000;
      noPayment(c.db);
      own(c.db, "root");
      let installed = accepted(c.repo.prepare(c.http, F.other(), {
        requestId = "root-with-kernel-requirement"; appIds = ["root"]; feeVersion = 1;
      }, 20));
      assert installed.appIds == ["root"];
    });
  };

  public func unowned_hidden_unapproved_and_missing_dependencies_reject_the_whole_cart() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "hidden_dependency", 100, 0, "hidden", []);
      hide(c.db, "hidden_dependency");
      ignore F.draft(c.db, "pending_dependency", 1_000_000);
      ignore F.candidate(c.db, "pending_dependency", 100, "pending");
      for (dependency in ["hidden_dependency", "pending_dependency", "missing_dependency"].vals()) {
        let appId = "root_for_" # dependency;
        ignore release(c.db, appId, 100, 1_000_000, appId, [{ appId = dependency; minVersion = 100 }]);
        ignore rejected(quote(c, request(appId, [appId])));
      };
      noPayment(c.db);
      assert c.db.entitlements.size() == 0;
    });
  };

  public func root_selection_identity_is_preserved_apart_from_resolved_items() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "dependency", 100, 2_000_000, "dependency", []);
      ignore release(c.db, "root", 100, 1_000_000, "root", [{ appId = "dependency"; minVersion = 100 }]);
      let one = accepted(quote(c, request("identity", ["root"])));
      let two = accepted(quote(c, request("identity", ["root", "dependency"])));
      let reordered = accepted(quote(c, request("identity", ["dependency", "root"])));
      assert one.items == two.items and two.items == reordered.items;
      assert one.request.appIds == ["root"] and two.request.appIds == ["root", "dependency"];
      assert one.commitment != two.commitment and two.commitment == reordered.commitment;
      assert Quotes.purchaseIntent(one.request) != Quotes.purchaseIntent(two.request);
      assert Quotes.purchaseIntent(two.request) == Quotes.purchaseIntent(reordered.request);
      noPayment(c.db);
    });
  };
}
