import Test "mo:test";
import API "../../mo/API";
import Access "../../mo/Access";
import Catalog "../../mo/Catalog";
import Publishers "../../mo/Publishers";
import PublisherStore "../../mo/PublisherStore";
import Rankings "../../mo/Rankings";
import ReleaseStore "../../mo/ReleaseStore";
import Store "../../mo/Store";
import Types "../../mo/Types";
import Views "../../mo/Views";
import Fixtures "Fixtures";
import Runtime "mo:core/Runtime";

persistent actor {
  func ok<T>(result : API.Result<T>) : T {
    switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(debug_show(error)) };
  };
  func released(db : Store.DB, appId : Text, version : Nat, requestId : Text) : Types.Candidate {
    let candidate = Fixtures.candidate(db, appId, version, requestId);
    Fixtures.stored(db.candidates.update({ candidate with state = #approved; published = true }));
  };
  func heads(db : Store.DB, appId : Text, stableRelease : ?Types.Candidate, betaRelease : ?Types.Candidate) {
    ReleaseStore.putHeads(db.channels, appId, {
      stableHead = { candidateId = switch (stableRelease) { case null null; case (?value) ?value.id }; revision = 1 };
      betaHead = { candidateId = switch (betaRelease) { case null null; case (?value) ?value.id }; revision = 2 };
    });
    let ?app = Store.getApp(db, appId) else Runtime.trap("Fixture app missing");
    Rankings.refreshEligibility(db, app);
  };
  func catalogRequest(search : Text, tier : API.Tier) : API.CatalogRequest {
    { search; tier; window = #all; cursor = null; limit = 10 };
  };

  public func release_listing_is_frozen_while_price_and_publisher_draft_stay_live() : async Test.Metrics {
    Test.test(func() {
      let memory = Fixtures.memory();
      let publisherMemory = PublisherStore.init();
      let channelMemory = ReleaseStore.init();
      let db = Store.UseWithChannels(memory, publisherMemory, channelMemory);
      ignore Fixtures.draft(db, "listedapp", 0);
      let stableIcon = Fixtures.upload(db, "listedapp", "stable-icon", #image);
      let stableScreen = Fixtures.upload(db, "listedapp", "stable-screen", #image);
      ignore Fixtures.ok(Catalog.save(db, Fixtures.owner(), {
        Fixtures.listing("listedapp", 0, ?1) with title = "Stable title"; summary = "Stable excerpt";
        description = "Stable description"; iconArtifact = ?stableIcon.id; screenshots = [stableScreen.id];
      }, 2));
      let stableRelease = released(db, "listedapp", 100, "stable-package");
      heads(db, "listedapp", ?stableRelease, null);
      let betaIcon = Fixtures.upload(db, "listedapp", "beta-icon", #image);
      let betaScreen = Fixtures.upload(db, "listedapp", "beta-screen", #image);
      ignore Fixtures.ok(Catalog.save(db, Fixtures.owner(), {
        Fixtures.listing("listedapp", 1_000_000, ?2) with title = "Beta title"; summary = "Beta excerpt";
        description = "Beta description"; iconArtifact = ?betaIcon.id; screenshots = [betaScreen.id];
      }, 3));
      let betaRelease = released(db, "listedapp", 101, "beta-package");
      heads(db, "listedapp", ?stableRelease, ?betaRelease);
      ReleaseStore.putNotes(db.channels, stableRelease.id, "Stable notes");
      ReleaseStore.putNotes(db.channels, betaRelease.id, "Beta notes");
      let draft = Fixtures.ok(Catalog.save(db, Fixtures.owner(), {
        Fixtures.listing("listedapp", 2_000_000, ?3) with title = "Unreleased draft"; summary = "Draft excerpt";
        description = "Draft description";
      }, 4));
      ignore Fixtures.stored(Store.insertEntitlement(db, {
        owner = Fixtures.other(); appId = "listedapp"; orderId = 1; kind = #free; acquiredAtNs = 2;
      }));
      ignore Rankings.recordAcquisition(db, {
        owner = Fixtures.other(); appId = "listedapp"; orderId = 1; kind = #free; atNs = 2;
        paidAtoms = 0; ledger = null; block = null;
      });
      ignore Rankings.advance(db, 10, 10);

      let ordinary = Views.channelApp(db, Fixtures.owner(), ?Fixtures.other(), draft, #stable_);
      let opted = Views.channelApp(db, Fixtures.owner(), ?Fixtures.other(), draft, #beta);
      assert ordinary.app.title == "Stable title" and ordinary.app.summary == "Stable excerpt";
      assert ordinary.app.description == "Stable description" and ordinary.app.version == ?100;
      assert ordinary.app.iconArtifact == ?stableIcon.id and ordinary.app.screenshotArtifacts == [stableScreen.id];
      assert ordinary.app.iconUrl != null and ordinary.app.screenshots.size() == 1;
      assert Access.isPublicPath(db, Access.artifactPath(stableIcon, #image));
      assert Access.isPublicPath(db, Access.artifactPath(stableScreen, #image));
      assert Access.isPublicPath(db, Access.artifactPath(betaIcon, #image));
      assert Access.isPublicPath(db, Access.artifactPath(betaScreen, #image));
      assert opted.app.title == "Beta title" and opted.app.summary == "Beta excerpt";
      assert opted.app.description == "Beta description" and opted.app.version == ?101;
      assert opted.app.iconArtifact == ?betaIcon.id and opted.app.screenshotArtifacts == [betaScreen.id];
      assert ordinary.selected == ?stableRelease and opted.selected == ?betaRelease;
      assert ordinary.selectedChannel == ?#stable_ and opted.selectedChannel == ?#beta;
      assert ordinary.stableHead.revision == 1 and ordinary.betaHead.revision == 2;
      assert ordinary.stableHead.releaseNotes == "Stable notes" and ordinary.betaHead.releaseNotes == "Beta notes";
      assert ordinary.app.priceUsdMicros == 2_000_000 and opted.app.priceUsdMicros == 2_000_000;
      assert ordinary.app.revision == draft.revision and opted.app.revision == draft.revision;
      assert ordinary.app.owned and opted.app.owned;
      assert ordinary.app.acquisitionCounts == ?{ free = 1; paid = 0 };
      assert opted.app.acquisitionCounts == ordinary.app.acquisitionCounts;
      assert ok(Views.detail(db, Fixtures.owner(), null, "listedapp")).app.title == "Stable title";
      assert ok(Views.detail(db, Fixtures.owner(), ?Fixtures.owner(), "listedapp")).app.title == "Unreleased draft";
      assert ok(Views.publisherApps(db, Fixtures.owner(), Fixtures.owner(), { cursor = null; limit = 10 })).apps[0].title == "Unreleased draft";
      assert ok(Views.library(db, Fixtures.owner(), Fixtures.other(), { cursor = null; limit = 10 })).apps[0].title == "Stable title";
      assert ok(Views.libraryFor(db, Fixtures.owner(), Fixtures.other(), { cursor = null; limit = 10 }, #beta)).apps[0].app.title == "Beta title";
      assert ok(Views.catalog(db, Fixtures.owner(), null, catalogRequest("Stable", #paid), 10)).apps.size() == 1;
      assert ok(Views.catalog(db, Fixtures.owner(), null, catalogRequest("Beta", #paid), 10)).apps.size() == 0;
      assert ok(Views.catalogFor(db, Fixtures.owner(), null, catalogRequest("Beta", #paid), 10, #beta)).apps.size() == 1;
      assert ok(Views.catalogFor(db, Fixtures.owner(), null, catalogRequest("Unreleased", #paid), 10, #beta)).apps.size() == 0;
      assert ok(Views.catalogFor(db, Fixtures.owner(), null, catalogRequest("", #free), 10, #beta)).apps.size() == 0;

      let restored = Store.UseWithChannels(memory, publisherMemory, channelMemory);
      assert Views.channelApp(restored, Fixtures.owner(), ?Fixtures.other(), draft, #beta) == opted;
    });
  };

  public func beta_only_discovery_uses_shared_rankings_and_release_search() : async Test.Metrics {
    Test.test(func() {
      let db = Store.UseWithChannels(Fixtures.memory(), PublisherStore.init(), ReleaseStore.init());
      ignore ok(Publishers.register(db, Fixtures.owner(), { publisherId = "fixture"; name = "Fixture"; description = ""; feeVersion = 1 }, 1));
      for (appId in ["alpha", "bravo", "zulu"].vals()) {
        ignore Fixtures.draft(db, appId, 0);
        let candidate = released(db, appId, 100, appId # "-package");
        if (appId == "bravo") heads(db, appId, null, ?candidate) else heads(db, appId, ?candidate, null);
      };
      ignore Rankings.advance(db, 10, 10);
      assert ok(Views.catalog(db, Fixtures.owner(), null, catalogRequest("", #free), 10)).apps.size() == 2;
      assert ok(Views.catalogFor(db, Fixtures.owner(), null, catalogRequest("", #free), 10, #beta)).apps.size() == 3;
      assert Fixtures.ok(Rankings.chart(db, #free, #all, null, 10, 10)).entries.size() == 2;
      switch (Views.detail(db, Fixtures.owner(), null, "bravo")) { case (#err(_)) {}; case _ assert false };
      assert ok(Views.detailFor(db, Fixtures.owner(), null, "bravo", #beta)).release.app.version == ?100;
      assert ok(Views.detailFor(db, Fixtures.owner(), null, "alpha", #beta)).release.selectedChannel == ?#stable_;
      let publisher = { publisherId = "fixture"; cursor = null; limit = 10 };
      assert ok(Views.publicPublisherApps(db, Fixtures.owner(), null, publisher)).apps.size() == 2;
      assert ok(Views.publicPublisherAppsFor(db, Fixtures.owner(), null, publisher, #beta)).apps.size() == 3;

      let request = { catalogRequest("brav", #free) with limit = 1 };
      let page = ok(Views.catalogFor(db, Fixtures.owner(), null, request, 10, #beta));
      assert page.apps.size() == 1 and page.apps[0].app.appId == "bravo";
      assert page.nextCursor != null;
      let tail = ok(Views.catalogFor(db, Fixtures.owner(), null, { request with cursor = page.nextCursor }, 10, #beta));
      assert tail.apps.size() == 0 and tail.nextCursor == null;
      assert ok(Views.catalog(db, Fixtures.owner(), null, request, 10)).apps.size() == 0;
      switch (Views.catalogFor(db, Fixtures.owner(), null, { request with limit = 0 }, 10, #beta)) {
        case (#err(error)) assert error.code == "invalid_page"; case _ assert false;
      };
      ignore Rankings.advance(db, 11, 10);
      switch (Views.catalogFor(db, Fixtures.owner(), null, { request with cursor = page.nextCursor }, 11, #beta)) {
        case (#err(error)) assert error.code == "catalog_page"; case _ assert false;
      };
    });
  };

  public func revocation_falls_back_only_to_an_independently_offered_head() : async Test.Metrics {
    Test.test(func() {
      let db = Store.UseWithChannels(Fixtures.memory(), PublisherStore.init(), ReleaseStore.init());
      let app = Fixtures.draft(db, "fallback", 0);
      let older = released(db, app.appId, 100, "older");
      let newer = released(db, app.appId, 101, "newer");
      heads(db, app.appId, ?newer, ?older);
      assert Views.channelApp(db, Fixtures.owner(), null, app, #beta).selected == ?newer;
      heads(db, app.appId, ?older, ?newer);
      let revokedBeta = Fixtures.stored(db.candidates.update({ newer with state = #revoked }));
      let fallback = Views.channelApp(db, Fixtures.owner(), null, app, #beta);
      assert fallback.selected == ?older and fallback.selectedChannel == ?#stable_;
      assert fallback.betaHead.candidate == ?revokedBeta;
      ignore Fixtures.stored(Store.insertEntitlement(db, {
        owner = Fixtures.other(); appId = app.appId; orderId = 1; kind = #free; acquiredAtNs = 1;
      }));
      ignore Fixtures.stored(db.candidates.update({ older with state = #revoked }));
      for (mode in [#stable_, #beta].vals()) {
        switch (Views.detailFor(db, Fixtures.owner(), null, app.appId, mode)) { case (#err(_)) {}; case _ assert false };
        let owned = ok(Views.detailFor(db, Fixtures.owner(), ?Fixtures.other(), app.appId, mode));
        assert owned.release.selected == null and owned.release.app.version == null;
        assert owned.release.app.owned and not owned.release.app.visible;
        let library = ok(Views.libraryFor(db, Fixtures.owner(), Fixtures.other(), { cursor = null; limit = 10 }, mode));
        assert library.apps.size() == 1 and library.apps[0].app.owned and not library.apps[0].app.visible;
      };
    });
  };
}
