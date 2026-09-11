// All rights reserved. See ../../LICENSE.
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import API "../../mo/API";
import PublisherStore "../../mo/PublisherStore";
import Publishers "../../mo/Publishers";
import Rankings "../../mo/Rankings";
import Ratings "../../mo/Ratings";
import Store "../../mo/Store";
import Fixtures "../motoko/Fixtures";

// Seed retained rows without the new publisher hooks, then exercise the real
// domain functions across separate messages and a state-preserving upgrade.
persistent actor {
  let memory = Fixtures.memory();
  let publisherMemory = PublisherStore.init();
  transient let db = Store.Use(memory, publisherMemory);
  var seeded = false;

  func buyer(index : Nat) : Principal {
    switch (index) {
      case (0) Principal.fromText("aaaaa-aa");
      case (1) Principal.fromText("2vxsx-fae");
      case (2) Fixtures.auditor();
      case (_) Runtime.trap("Unknown fixture buyer");
    };
  };

  func historicalApp(appId : Text, owner : Principal, ratingCount : Nat, ratingTotal : Nat) {
    ignore Fixtures.stored(db.apps.insert({
      appId; owner; title = appId; summary = "Retained publisher fixture";
      description = ""; priceUsdMicros = 0; revision = 1; approvedCandidate = null;
      visible = true; iconArtifact = null; screenshots = []; ratingCount; ratingTotal;
      createdAtNs = 1; updatedAtNs = 1;
    }));
  };

  func historicalAcquisition(appId : Text, owner : Principal, stars : Nat) {
    ignore Fixtures.stored(db.entitlements.insert({ owner; appId; orderId = 1; kind = #free; acquiredAtNs = 1 }));
    ignore Fixtures.stored(db.acquisitions.insert({ owner; appId; orderId = 1; kind = #free; atNs = 1; paidAtoms = 0; ledger = null; block = null }));
    ignore Fixtures.stored(db.ratings.insert({ owner; appId; stars; review = "Retained review"; createdAtNs = 1; updatedAtNs = 1 }));
  };

  public func seed() : async () {
    assert not seeded;
    historicalApp("alpha-one", Fixtures.owner(), 2, 8);
    historicalApp("alpha-two", Fixtures.owner(), 1, 2);
    historicalApp("beta-one", Fixtures.other(), 1, 4);
    historicalAcquisition("alpha-one", buyer(0), 5);
    historicalAcquisition("alpha-one", buyer(1), 3);
    historicalAcquisition("alpha-two", buyer(0), 2);
    historicalAcquisition("beta-one", buyer(0), 4);
    let #ok(_) = Publishers.register(db, Fixtures.owner(), { publisherId = "alpha"; name = "Alpha"; description = "First publisher"; feeVersion = 1 }, 2) else Runtime.trap("Fixture profile registration failed");
    let #ok(_) = Publishers.register(db, Fixtures.other(), { publisherId = "beta"; name = "Beta"; description = "Second publisher"; feeVersion = 1 }, 2) else Runtime.trap("Fixture profile registration failed");
    seeded := true;
  };

  public func advance(budget : Nat) : async Nat { Publishers.advance(db, budget) };

  public func rate(appId : Text, buyerIndex : Nat, stars : Nat) : async () {
    ignore Fixtures.ok(Ratings.set(db, buyer(buyerIndex), appId, stars, "Live review", 3));
  };

  public func acquire(appId : Text, buyerIndex : Nat) : async Nat64 {
    let owner = buyer(buyerIndex);
    ignore Fixtures.stored(Store.putEntitlement(db, { owner; appId; orderId = 2; kind = #free; acquiredAtNs = 3 }));
    Rankings.recordAcquisition(db, { owner; appId; orderId = 2; kind = #free; atNs = 3; paidAtoms = 0; ledger = null; block = null }).id;
  };

  public query func snapshot() : async {
    alpha : ?API.PublisherProfile; beta : ?API.PublisherProfile;
    maintenance : PublisherStore.Maintenance;
    apps : Nat; acquisitions : Nat; entitlements : Nat; ratings : Nat;
    appBaselines : Nat; memberships : Nat;
  } {
    {
      alpha = Publishers.profileFor(db, Fixtures.owner()); beta = Publishers.profileFor(db, Fixtures.other());
      maintenance = db.publishers.store.get();
      apps = db.apps.size(); acquisitions = db.acquisitions.size(); entitlements = db.entitlements.size(); ratings = db.ratings.size();
      appBaselines = db.publishers.publisherAppStats.size(); memberships = db.publishers.publisherUsers.size();
    };
  };
};
