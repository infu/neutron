import Referrals "../mo/Referrals";
import Ratings "../mo/Ratings";
import Test "mo:test";
import Principal "mo:core/Principal";
import Store "../mo/Store";
import PublisherStore "../mo/PublisherStore";
import Types "../mo/Types";

persistent actor {
  func memory() : Store.Mem {
    Store.init({
      admins = []; auditors = []; tokens = [];
      xrc = Principal.fromText("aaaaa-aa");
      fees = { version = 1; updateBase = 0; updateByte = 0; storageByteYear = 0; purchase = 0; withdraw = 0; grant = 0; xrc = 0 };
      referralTerms = { version = 1; discountBps = 1_000; affiliateBps = 3_000; developerBps = 3_000 };
    });
  };

  public query func compact_codes_cover_sequence_boundaries() : async Test.Metrics {
    Test.test(func () {
      assert Referrals.codeFor(0) == "N0";
      assert Referrals.codeFor(1) == "N1";
      assert Referrals.codeFor(35) == "NZ";
      assert Referrals.codeFor(36) == "N10";
      assert Referrals.codeFor(1_296) == "N100";
      assert Referrals.codeFor(18_446_744_073_709_551_615) == "N3W5E11264SGSF";
      assert Referrals.normalizeCode("  n3w5e11264sgsf\n") == "N3W5E11264SGSF";
    });
  };

  public query func rating_edits_replace_the_prior_contribution() : async Test.Metrics {
    Test.test(func () {
      assert Ratings.validateStars(0) == #err("Choose a rating from 1 to 5 stars.");
      assert Ratings.validateStars(6) == #err("Choose a rating from 1 to 5 stars.");
      assert Ratings.validateStars(1) == #ok(());
      assert Ratings.validateStars(5) == #ok(());
      assert Ratings.updateSummary({ count = 0; total = 0 }, null, 5) == #ok({ count = 1; total = 5 });
      assert Ratings.updateSummary({ count = 2; total = 8 }, ?5, 1) == #ok({ count = 2; total = 4 });
      assert Ratings.updateSummary({ count = 2; total = 4 }, ?1, 1) == #ok({ count = 2; total = 4 });
      assert Ratings.updateSummary({ count = 2; total = 4 }, null, 3) == #ok({ count = 3; total = 7 });
      switch (Ratings.updateSummary({ count = 0; total = 0 }, ?5, 1)) {
        case (#err(_)) {};
        case (_) assert false;
      };
    });
  };

  public func referral_retry_restores_one_durable_code() : async Test.Metrics {
    Test.test(func () {
      let mem = memory();
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(mem, publisherMemory);
      let firstOwner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
      let buyer = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
      let first = Referrals.getOrCreate(db, firstOwner, 10);
      assert first.code == "N1";
      assert Referrals.getOrCreate(db, firstOwner, 20) == first;
      assert Referrals.getOrCreate(db, buyer, 30).code == "N2";
      assert db.referrals.size() == 2;
      assert Referrals.resolve(db, buyer, ?" n1 ") == #ok(?first);
      assert Referrals.resolve(db, buyer, null) == #ok(null);
      assert Referrals.resolve(db, buyer, ?" ") == #ok(null);
      assert Referrals.resolve(db, firstOwner, ?first.code) == #err("You cannot use your own affiliate code.");
      assert Referrals.resolve(db, buyer, ?"NUNKNOWN") == #err("This affiliate code is not registered.");
      let restored = Store.Use(mem, publisherMemory);
      assert Referrals.getOrCreate(restored, firstOwner, 100) == first;
      assert restored.referrals.size() == 2;
    });
  };

  public func referral_quote_validates_without_acquiring_or_allocating() : async Test.Metrics {
    Test.test(func () {
      let mem = memory();
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(mem, publisherMemory);
      let affiliate = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
      let buyer = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
      let anotherBuyer = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
      let referral = Referrals.getOrCreate(db, affiliate, 10);
      let expected = #ok({ code = referral.code; affiliate; discountBps = 1_000; termsVersion = 1 });
      assert Referrals.quote(db, buyer, " \tn1\r\n") == expected;
      assert Referrals.quote(db, anotherBuyer, referral.code) == expected;
      assert Referrals.quote(db, buyer, "NUNKNOWN") == #err({ code = "invalid_referral"; message = "This affiliate code is not registered." });
      assert Referrals.quote(db, buyer, " \t\n") == #err({ code = "invalid_referral"; message = "Enter a discount code." });
      assert Referrals.quote(db, affiliate, " n1 ") == #err({ code = "invalid_referral"; message = "You cannot use your own affiliate code." });
      assert db.referrals.size() == 1 and db.orders.size() == 0 and db.entitlements.size() == 0 and db.acquisitions.size() == 0;
      assert Store.getReferralByOwner(db, buyer) == null;
      assert Store.getReferralByOwner(db, anotherBuyer) == null;
      // Read validation did not advance the durable code sequence.
      assert Referrals.getOrCreate(db, buyer, 20).code == "N2";
      assert Referrals.quote(Store.Use(mem, publisherMemory), anotherBuyer, referral.code) == expected;
    });
  };

  public func entitled_owners_edit_one_rating_without_acquisition_effects() : async Test.Metrics {
    Test.test(func () {
      let mem = memory();
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(mem, publisherMemory);
      let freeOwner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
      let paidOwner = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
      let nonOwner = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
      let app : Types.CreateApp = {
        appId = "hello"; owner = nonOwner; title = "Hello"; summary = "A test app"; description = "";
        priceUsdMicros = 1_000_000; revision = 1; approvedCandidate = null; visible = false;
        iconArtifact = null; screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 0; updatedAtNs = 0;
      };
      switch (Store.insertApp(db, app)) { case (#ok(_)) {}; case (_) assert false };
      for ((owner, kind) in [(freeOwner, #free : Types.AcquisitionKind), (paidOwner, #paid : Types.AcquisitionKind)].vals()) {
        switch (Store.insertEntitlement(db, { owner; kind; appId = app.appId; orderId = 1; acquiredAtNs = 1 })) {
          case (#ok(_)) {};
          case (_) assert false;
        };
      };
      assert Ratings.set(db, nonOwner, app.appId, 5, "", 2) == #err("Acquire this app before rating it.");
      let #ok(first) = Ratings.set(db, freeOwner, app.appId, 5, "Useful", 3) else { assert false; loop {} };
      assert Ratings.set(db, freeOwner, app.appId, 5, "Useful", 4) == #ok(first);
      let #ok(second) = Ratings.set(db, paidOwner, app.appId, 3, "", 5) else { assert false; loop {} };
      assert second.id != first.id;
      let #ok(edited) = Ratings.set(db, freeOwner, app.appId, 1, "Changed review", 6) else { assert false; loop {} };
      assert edited.id == first.id and edited.createdAtNs == first.createdAtNs and edited.updatedAtNs == 6;
      assert db.ratings.size() == 2;
      assert db.entitlements.size() == 2 and db.acquisitions.size() == 0 and db.rankings.size() == 0;
      let restored = Store.Use(mem, publisherMemory);
      let ?updatedApp = Store.getApp(restored, app.appId) else { assert false; loop {} };
      assert updatedApp.ratingCount == 2 and updatedApp.ratingTotal == 4;
      assert updatedApp.revision == app.revision and updatedApp.updatedAtNs == app.updatedAtNs;
      assert Store.getRating(restored, freeOwner, app.appId) == ?edited;
      assert Ratings.set(restored, freeOwner, app.appId, 0, "Invalid", 7) == #err("Choose a rating from 1 to 5 stars.");
      assert Store.getRating(restored, freeOwner, app.appId) == ?edited;
    });
  };
}
