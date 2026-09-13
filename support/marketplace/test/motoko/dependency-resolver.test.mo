// All rights reserved. See ../../LICENSE.
import Test "mo:test";
import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import API "../../mo/API";
import BatchPublishing "../../mo/BatchPublishing";
import Http "../../mo/Http";
import Publishing "../../mo/Publishing";
import PublisherStore "../../mo/PublisherStore";
import Quotes "../../mo/Quotes";
import ReleaseStore "../../mo/ReleaseStore";
import Repository "../../mo/Repository";
import Store "../../mo/Store";
import Types "../../mo/Types";
import Fixtures "Fixtures";

persistent actor {
  type Dependency = { appId : Text; minVersion : Nat };
  func ok<T>(result : API.Result<T>) : T {
    switch (result) { case (#ok(value)) value; case (#err(value)) Runtime.trap(debug_show(value)) };
  };
  func error<T>(result : API.Result<T>, code : Text, message : ?Text) {
    switch (result) {
      case (#err(value)) { assert value.code == code; switch (message) { case (?expected) assert value.message == expected; case null {} } };
      case _ Runtime.trap("Expected " # code);
    };
  };
  func database() : Store.DB {
    let db = Store.Use(Fixtures.memory(), PublisherStore.init(), ReleaseStore.init());
    Store.setConfig(db, { Store.config(db) with tokens = [{
      ledger = Fixtures.auditor(); symbol = "TUSDC"; decimals = 6; fee = 10; rateSymbol = "USD"; burnAccount = null;
    }] });
    db;
  };
  func release(db : Store.DB, appId : Text, version : Nat, dependencies : [Dependency]) : Types.Candidate {
    if (Store.getApp(db, appId) == null) ignore Fixtures.draft(db, appId, 0);
    let requestId = appId # "-" # Nat.toText(version);
    let artifact = Fixtures.upload(db, appId, requestId # "-package", #package);
    let source = Fixtures.upload(db, appId, requestId # "-source", #source);
    let candidate = Fixtures.ok(Publishing.submit(db, Fixtures.owner(), {
      requestId; appId; version; artifactId = artifact.id; sourceArtifactId = ?source.id; dependencies; feeVersion = 1;
    }, 2));
    // These characterization graphs intentionally include missing dependencies
    // and cycles, so fixture publication must not validate them in advance.
    Fixtures.approve(db, candidate, requestId # "-audit").candidate;
  };
  func own(db : Store.DB, appId : Text) {
    ignore Fixtures.stored(Store.insertEntitlement(db, {
      owner = Fixtures.other(); appId; orderId = 1; kind = #free; acquiredAtNs = 4;
    }));
  };
  func request(appIds : [Text]) : API.PurchaseRequest {
    { requestId = "characterization"; appIds; ledger = Fixtures.auditor(); referralCode = null };
  };
  func purchase(db : Store.DB, roots : [Text]) : API.Result<API.CheckoutQuote> {
    Quotes.purchase(db, Fixtures.owner(), Fixtures.other(), request(roots), 10);
  };
  func channelPurchase(db : Store.DB, roots : [Text]) : API.Result<API.ChannelCheckoutQuote> {
    Quotes.purchaseV2(db, Fixtures.owner(), Fixtures.other(), { request = request(roots); mode = #stable_; expectedSelection = null }, 10);
  };
  func install(db : Store.DB, roots : [Text]) : API.Result<API.ChannelInstallSelection> {
    Repository.Service(db, Http.init(), Fixtures.owner()).selection(Fixtures.other(), { appIds = roots; mode = #stable_ });
  };
  func promotion(db : Store.DB, roots : [Text]) : API.Result<BatchPublishing.Promoted> {
    let plan = ok(BatchPublishing.preparePromotion(db, Fixtures.owner(), { appIds = roots }));
    BatchPublishing.promote(db, Fixtures.owner(), { requestId = "characterization-promotion"; entries = plan.entries; feeVersion = 1 }, 10);
  };
  func ids(values : [API.ReleaseSelection]) : [Text] { Array.map<API.ReleaseSelection, Text>(values, func(value) { value.appId }) };

  public func purposes_preserve_traversal_and_validation_error_precedence() : async Test.Metrics {
    Test.test(func() {
      let db = database();
      ignore release(db, "ordered", 100, [{ appId = "missing_first"; minVersion = 100 }, { appId = "missing_last"; minVersion = 100 }]);
      own(db, "ordered");
      // Purchase/promotion historically use a stack; install visits declared
      // dependencies in order. A shared walker must preserve both first errors.
      error(purchase(db, ["ordered"]), "dependency_unavailable", ?"No marketplace app exists for missing_last.");
      error(channelPurchase(db, ["ordered"]), "dependency_unavailable", ?"No marketplace app exists for missing_last.");
      error(install(db, ["ordered"]), "dependency_unavailable", ?"No marketplace app exists for missing_first.");
      error(promotion(db, ["ordered"]), "dependency_unavailable", ?"No stable dependency exists for missing_last.");
      error(purchase(db, ["ordered", "ordered"]), "duplicate_app", ?"Select each app once.");
      error(install(db, ["ordered", "ordered"]), "dependency_unavailable", ?"No marketplace app exists for missing_first.");
      error(purchase(db, ["missing_first", "missing_last"]), "app_missing", ?"No marketplace app exists for missing_last.");
      error(install(db, ["ordered", "unowned"]), "app_not_owned", ?"Add unowned to My apps before installing it.");
      error(purchase(db, ["ordered", "kernel"]), "invalid_app", null);
      assert db.orders.size() == 0 and db.manifests.size() == 0;
    });
  };

  public func cycles_and_shared_dependencies_recheck_later_stricter_minimums_once_per_release() : async Test.Metrics {
    Test.test(func() {
      let db = database();
      ignore release(db, "shared", 100, [{ appId = "leftside"; minVersion = 100 }]);
      ignore release(db, "leftside", 100, [{ appId = "shared"; minVersion = 100 }]);
      ignore release(db, "rightside", 100, [{ appId = "shared"; minVersion = 101 }]);
      ignore release(db, "buyroot", 100, [{ appId = "rightside"; minVersion = 100 }, { appId = "leftside"; minVersion = 100 }]);
      ignore release(db, "installroot", 100, [{ appId = "leftside"; minVersion = 100 }, { appId = "rightside"; minVersion = 100 }]);
      own(db, "buyroot"); own(db, "installroot");
      // Each purpose first selects shared 100 through the left branch, then
      // encounters the right branch's 101 minimum after traversing a cycle.
      error(purchase(db, ["buyroot"]), "dependency_version", ?"The selected shared release does not satisfy the dependency minimum.");
      error(channelPurchase(db, ["buyroot"]), "dependency_version", null);
      error(install(db, ["installroot"]), "dependency_version", ?"The selected shared release does not satisfy the dependency minimum.");
      error(promotion(db, ["buyroot"]), "dependency_version", ?"The resulting stable shared does not satisfy the required version.");
      ignore release(db, "shared", 101, [{ appId = "leftside"; minVersion = 100 }]);
      let legacy = ok(purchase(db, ["buyroot"]));
      assert Array.map<Types.PurchaseItem, Text>(legacy.items, func(item) { item.appId }) == ["leftside", "rightside", "shared"];
      assert legacy.amount == 0;
      let channel = ok(channelPurchase(db, ["buyroot"]));
      assert ids(channel.selection) == ["buyroot", "leftside", "rightside", "shared"];
      assert channel.quote.items == legacy.items;
      let setup = ok(install(db, ["installroot", "installroot"]));
      assert setup.appIds == ["installroot", "installroot"];
      assert ids(setup.selection) == ["installroot", "leftside", "rightside", "shared"];
      assert ok(promotion(db, ["buyroot"])).receipt.id == 0;
    });
  };

  public func ownership_removes_price_lines_but_only_legacy_purchase_and_install_skip_kernel() : async Test.Metrics {
    Test.test(func() {
      let db = database();
      ignore release(db, "paid_dependency", 100, []);
      let ?paid = Store.getApp(db, "paid_dependency") else Runtime.trap("Missing paid fixture");
      ignore Fixtures.stored(db.apps.update({ paid with priceUsdMicros = 1_000_000; visible = false }));
      ignore release(db, "rootapp", 100, [{ appId = "kernel"; minVersion = 900 }, { appId = "paid_dependency"; minVersion = 100 }]);
      own(db, "rootapp");
      error(purchase(db, ["rootapp"]), "not_available", ?"This required app is not available to acquire: paid_dependency.");
      error(channelPurchase(db, ["rootapp"]), "not_available", null);
      error(install(db, ["rootapp"]), "dependency_not_owned", null);
      own(db, "paid_dependency");
      assert ok(purchase(db, ["rootapp"])).items == [];
      assert ids(ok(install(db, ["rootapp"])).selection) == ["paid_dependency", "rootapp"];
      error(channelPurchase(db, ["rootapp"]), "dependency_unavailable", ?"No marketplace app exists for kernel.");
      error(promotion(db, ["rootapp"]), "dependency_unavailable", ?"No stable dependency exists for kernel.");
      ignore release(db, "kernel", 899, []);
      error(channelPurchase(db, ["rootapp"]), "dependency_version", null);
      error(promotion(db, ["rootapp"]), "dependency_version", null);
      ignore release(db, "kernel", 900, []);
      let ?kernel = Store.getApp(db, "kernel") else Runtime.trap("Missing Kernel fixture");
      ignore Fixtures.stored(db.apps.update({ kernel with priceUsdMicros = 1_000_000; visible = false }));
      let channel = ok(channelPurchase(db, ["rootapp"]));
      assert channel.quote.items == [] and channel.quote.amount == 0;
      assert ids(channel.selection) == ["kernel", "paid_dependency", "rootapp"];
      assert ids(ok(install(db, ["rootapp"])).selection) == ["paid_dependency", "rootapp"];
      assert ok(promotion(db, ["rootapp"])).receipt.id == 0;
      error(purchase(db, ["kernel"]), "invalid_app", null);
      error(install(db, ["kernel"]), "invalid_app", null);
    });
  };

  public func install_codec_bounds_remain_inclusive_and_precede_duplicate_digest_checks() : async Test.Metrics {
    Test.test(func() {
      let db = database();
      let roots = Array.tabulate<Text>(65, func(index) {
        let appId = "count_" # Nat.toText(index);
        ignore release(db, appId, 100, []); own(db, appId); appId;
      });
      assert ok(install(db, Array.tabulate<Text>(64, func(index) { roots[index] }))).selection.size() == 64;
      error(install(db, roots), "installer_batch_limit", null);
      // Purchase does not acquire the install codec's package-count limit.
      assert ok(channelPurchase(db, roots)).selection.size() == 65;

      let sizes = database();
      let first = release(sizes, "bytes_aaaa", 100, []);
      let second = release(sizes, "bytes_bbbb", 100, []);
      let last = release(sizes, "bytes_zzzz", 100, []);
      for (appId in [first.appId, second.appId, last.appId].vals()) own(sizes, appId);
      func size(candidate : Types.Candidate, bytes : Nat64) {
        let ?artifact = Store.getArtifact(sizes, candidate.artifactId) else Runtime.trap("Missing artifact fixture");
        // Selection validates advertised artifact lengths. Synthetic metadata
        // avoids allocating 64 MiB of irrelevant fixture package contents.
        ignore Fixtures.stored(sizes.artifacts.update({ artifact with size = bytes; content = #keep }));
      };
      size(first, 33_554_432); size(second, 33_554_432); size(last, 1);
      assert ok(install(sizes, [first.appId, second.appId])).selection.size() == 2;
      error(install(sizes, [first.appId, second.appId, last.appId]), "installer_batch_limit", null);
      size(last, 33_554_433);
      error(install(sizes, [first.appId, second.appId, last.appId]), "installer_incompatible", null);
      size(last, 1);
      ignore Fixtures.stored(sizes.candidates.update({ last with artifactId = first.artifactId; digest = first.digest }));
      error(install(sizes, [first.appId, last.appId]), "duplicate_package", null);
      error(install(sizes, [first.appId, second.appId, last.appId]), "installer_batch_limit", null);
    });
  };
}
