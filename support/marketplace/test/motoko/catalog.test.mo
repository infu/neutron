import Catalog "../../mo/Catalog";
import Store "../../mo/Store";
import PublisherStore "../../mo/PublisherStore";
import Fixtures "Fixtures";
import Array "mo:core/Array";
import Text "mo:core/Text";
import Test "mo:test";

persistent actor {
  func repeated(character : Char, count : Nat) : Text {
    Text.fromIter(Array.repeat<Char>(character, count).vals());
  };

  func rejected<T>(result : Catalog.Result<T>) {
    switch (result) { case (#err(_)) {}; case (#ok(_)) assert false };
  };

  public query func boundaries() : async Test.Metrics {
    Test.test(func () {
      assert Catalog.validPrice(0);
      assert not Catalog.validPrice(1);
      assert not Catalog.validPrice(999_999);
      assert Catalog.validPrice(1_000_000);
      assert Catalog.validPrice(1_000_001);
      assert Catalog.validPrice(50_000_000);
      assert not Catalog.validPrice(50_000_001);

      assert Catalog.validAppId("aave");
      assert Catalog.validAppId("sns_governance");
      assert Catalog.validAppId("app0");
      assert not Catalog.validAppId("abc");
      assert not Catalog.validAppId("_aave");
      assert not Catalog.validAppId("aave_");
      assert not Catalog.validAppId("sns__governance");
      assert not Catalog.validAppId("Aave");
      assert not Catalog.validAppId("aave-swap");
      assert not Catalog.validAppId("aave/../../kernel");
      assert not Catalog.validAppId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

      assert Catalog.hasText(" Name ");
      assert not Catalog.hasText(" \t\n\r ");
      assert Catalog.validateListing("aave", "Aave", "Lending client", "", 1_000_000) == #ok(());
      assert Catalog.validateListing("aave", "Aave", "Lending client", "", 900_000) != #ok(());
    });
  };

  public query func listing_text_boundaries_count_unicode_characters() : async Test.Metrics {
    Test.test(func() {
      for (character in ['a', '🚀'].vals()) {
        let summary = repeated(character, 255);
        let description = repeated(character, 5_000);
        assert summary.size() == 255 and description.size() == 5_000;
        assert Catalog.validateListing("testapp", "App", summary, description, 0) == #ok(());
        assert Catalog.validateListing("testapp", "App", summary, "", 0) == #ok(());
        rejected(Catalog.validateListing("testapp", "App", repeated(character, 256), description, 0));
        rejected(Catalog.validateListing("testapp", "App", summary, repeated(character, 5_001), 0));
      };
    });
  };

  public func listing_text_rejections_preserve_apps_and_listing_history() : async Test.Metrics {
    Test.test(func() {
      for (character in ['a', '🚀'].vals()) {
        let db = Store.Use(Fixtures.memory(), PublisherStore.init());
        let input = {
          Fixtures.listing("testapp", 0, null) with
          summary = repeated(character, 255); description = repeated(character, 5_000);
        };
        for (invalid in [
          { input with summary = repeated(character, 256) },
          { input with description = repeated(character, 5_001) },
        ].vals()) {
          rejected(Catalog.save(db, Fixtures.owner(), invalid, 1));
          assert db.apps.size() == 0 and db.listings.size() == 0;
          assert Store.getApp(db, input.appId) == null;
          assert Store.getListing(db, input.appId, 1) == null;
        };

        let saved = Fixtures.ok(Catalog.save(db, Fixtures.owner(), input, 2));
        let originalListing = Store.getListing(db, input.appId, saved.revision);
        assert saved.summary == input.summary and saved.description == input.description;
        assert originalListing != null;
        for (invalid in [
          { input with expectedRevision = ?saved.revision; summary = repeated(character, 256) },
          { input with expectedRevision = ?saved.revision; description = repeated(character, 5_001) },
        ].vals()) {
          rejected(Catalog.save(db, Fixtures.owner(), invalid, 3));
          assert db.apps.size() == 1 and db.listings.size() == 1;
          assert Store.getApp(db, input.appId) == ?saved;
          assert Store.getListing(db, input.appId, saved.revision) == originalListing;
          assert Store.getListing(db, input.appId, saved.revision + 1) == null;
        };

        let revisionInput = { input with title = "Updated app"; expectedRevision = ?saved.revision };
        let revised = Fixtures.ok(Catalog.save(db, Fixtures.owner(), revisionInput, 4));
        let revisedListing = Store.getListing(db, input.appId, revised.revision);
        assert revised.revision == saved.revision + 1;
        assert revised.summary == input.summary and revised.description == input.description;
        // The successful save made this request's expected revision stale.
        assert Catalog.save(db, Fixtures.owner(), revisionInput, 5) == #ok(revised);
        assert db.apps.size() == 1 and db.listings.size() == 2;
        assert Store.getApp(db, input.appId) == ?revised;
        assert Store.getListing(db, input.appId, revised.revision) == revisedListing;
        assert Store.getListing(db, input.appId, saved.revision) == originalListing;
      };
    });
  };

  public func historical_overlimit_listing_retries_preserve_retained_records() : async Test.Metrics {
    Test.test(func() {
      let memory = Fixtures.memory();
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(memory, publisherMemory);
      let input = {
        Fixtures.listing("legacyapp", 0, ?1) with
        summary = repeated('🚀', 256); description = repeated('🚀', 5_001);
      };
      // Model durable data written before the listing text limits existed.
      let historical = Fixtures.stored(Store.insertApp(db, {
        appId = input.appId; owner = Fixtures.owner(); title = input.title;
        summary = input.summary; description = input.description; priceUsdMicros = input.priceUsdMicros;
        revision = 7; approvedCandidate = null; visible = input.visible;
        iconArtifact = input.iconArtifact; screenshots = input.screenshots;
        ratingCount = 0; ratingTotal = 0; createdAtNs = 1; updatedAtNs = 2;
      }));
      let historicalListing = Fixtures.stored(Store.insertListing(db, {
        appId = input.appId; revision = historical.revision; owner = historical.owner;
        title = input.title; summary = input.summary; description = input.description;
        priceUsdMicros = input.priceUsdMicros; iconArtifact = input.iconArtifact;
        screenshots = input.screenshots; createdAtNs = historical.updatedAtNs;
      }));
      let restored = Store.Use(memory, publisherMemory);
      assert Catalog.save(restored, Fixtures.owner(), input, 3) == #ok(historical);
      assert restored.apps.size() == 1 and restored.listings.size() == 1;
      assert Store.getApp(restored, input.appId) == ?historical;
      assert Store.getListing(restored, input.appId, historical.revision) == ?historicalListing;
      rejected(Catalog.save(restored, Fixtures.other(), input, 4));

      for (invalid in [
        { input with expectedRevision = ?historical.revision; title = "Changed legacy app" },
        { input with expectedRevision = ?historical.revision; summary = "Valid excerpt" },
        { input with expectedRevision = ?historical.revision; description = "Valid description" },
      ].vals()) {
        rejected(Catalog.save(restored, Fixtures.owner(), invalid, 4));
        assert restored.apps.size() == 1 and restored.listings.size() == 1;
        assert Store.getApp(restored, input.appId) == ?historical;
        assert Store.getListing(restored, input.appId, historical.revision) == ?historicalListing;
        assert Store.getListing(restored, input.appId, historical.revision + 1) == null;
      };

      let corrected = Fixtures.ok(Catalog.save(restored, Fixtures.owner(), {
        input with expectedRevision = ?historical.revision;
        summary = "Valid excerpt"; description = "Valid description";
      }, 5));
      assert corrected.revision == historical.revision + 1;
      assert corrected.summary == "Valid excerpt" and corrected.description == "Valid description";
      assert corrected.createdAtNs == historical.createdAtNs;
      assert restored.apps.size() == 1 and restored.listings.size() == 2;
      assert Store.getListing(restored, input.appId, historical.revision) == ?historicalListing;
    });
  };
}
