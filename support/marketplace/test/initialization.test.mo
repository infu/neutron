import Test "mo:test";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Catalog "../mo/Catalog";
import Initialization "../mo/Initialization";
import Store "../mo/Store";
import PublisherStore "../mo/PublisherStore";
import Types "../mo/Types";

persistent actor {
  func config() : Types.Config {
    { admins = []; auditors = []; tokens = []; xrc = Principal.fromText("aaaaa-aa");
      fees = { version = 1; updateBase = 1; updateByte = 1; storageByteYear = 1; purchase = 1; withdraw = 1; grant = 1; xrc = 1 };
      referralTerms = { version = 1; discountBps = 1000; affiliateBps = 3000; developerBps = 3000 } };
  };
  func reservation() : Types.Reservation {
    { appId = "existing_app"; publisher = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"); title = "Existing app" };
  };
  public func entire_inventory_is_validated_before_mutation() : async Test.Metrics {
    Test.test(func() {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(Store.init(config()), publisherMemory);
      let original = reservation();
      for (invalid in [
        { original with appId = "second_app"; title = "" },
        { original with publisher = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai") },
        { original with appId = "second_app"; publisher = Principal.fromText("2vxsx-fae") },
      ].vals()) {
        switch (Initialization.initialize(db, [original, invalid], 1)) { case (#err(_)) {}; case (_) assert false };
        assert db.apps.size() == 0 and db.listings.size() == 0 and db.rankings.size() == 0;
      };
    });
  };
  public func reservations_are_atomic_hidden_and_never_overwrite_existing_rows() : async Test.Metrics {
    Test.test(func() {
      let publisherMemory = PublisherStore.init();
      let original = reservation();
      let mem = Initialization.memory({ config() with reservations = ?[original, original]; trustedPublishingPrincipal = null }, 1, publisherMemory);
      let db = Store.Use(mem, publisherMemory);
      assert db.apps.size() == 1 and db.listings.size() == 1;
      let ?first = Store.getApp(db, original.appId) else Runtime.trap("Reservation missing");
      assert first.owner == original.publisher and first.title == original.title;
      assert first.approvedCandidate == null and not Catalog.eligible(db, first);
      assert Initialization.initialize(db, [{ original with title = "Do not replace" }], 100) == #ok;
      assert Store.getApp(Store.Use(mem, publisherMemory), original.appId) == ?first;
      assert db.listings.size() == 1;
      let newcomer = { original with appId = "new_app" };
      let conflict = { original with publisher = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai") };
      switch (Initialization.initialize(db, [newcomer, conflict], 101)) { case (#err(_)) {}; case (_) assert false };
      assert Store.getApp(db, newcomer.appId) == null;
      assert Store.getApp(db, original.appId) == ?first;
    });
  };
  public func omitted_reservations_keep_clean_initialization_compatible() : async Test.Metrics {
    Test.test(func() {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(Initialization.memory({ config() with reservations = null; trustedPublishingPrincipal = null }, 0, publisherMemory), publisherMemory);
      assert db.apps.size() == 0 and Store.config(db) == config();
    });
  };
};
