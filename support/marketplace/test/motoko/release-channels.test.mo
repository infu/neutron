// All rights reserved. See ../../LICENSE.
import Test "mo:test";
import Map "mo:core/Map";
import Runtime "mo:core/Runtime";
import API "../../mo/API";
import Audits "../../mo/Audits";
import BatchPublishing "../../mo/BatchPublishing";
import Catalog "../../mo/Catalog";
import Publishing "../../mo/Publishing";
import PublisherStore "../../mo/PublisherStore";
import ReleaseStore "../../mo/ReleaseStore";
import Store "../../mo/Store";
import Types "../../mo/Types";
import Fixtures "Fixtures";

persistent actor {
  func ok<T>(result : API.Result<T>) : T {
    switch (result) { case (#ok(value)) value; case (#err(value)) Runtime.trap(debug_show(value)) };
  };
  func error<T>(result : API.Result<T>, code : Text) {
    switch (result) { case (#err(value)) assert value.code == code; case _ Runtime.trap("Expected " # code) };
  };
  func beta(db : Store.DB, appId : Text, version : Nat, requestId : Text, dependencies : [{ appId : Text; minVersion : Nat }]) : Types.Candidate {
    if (Store.getApp(db, appId) == null) ignore Fixtures.draft(db, appId, 0);
    let artifact = Fixtures.upload(db, appId, requestId # "-package", #package);
    let source = Fixtures.upload(db, appId, requestId # "-source", #source);
    let candidate = Fixtures.ok(Publishing.submit(db, Fixtures.owner(), {
      requestId; appId; version; artifactId = artifact.id; sourceArtifactId = ?source.id; dependencies; feeVersion = 1;
    }, 2));
    Fixtures.ok(Audits.stamp(db, Fixtures.auditor(), {
      requestId = requestId # "-approved"; candidateId = candidate.id; decision = #approved;
      expectedDigest = candidate.digest; expectedSourceDigest = candidate.sourceDigest;
      analysis = "Approved the exact beta package and source"; reason = null;
    }, 3)).candidate;
  };
  func plan(db : Store.DB, requestId : Text, appIds : [Text]) : API.PromotionRequest {
    { requestId; entries = ok(BatchPublishing.preparePromotion(db, Fixtures.owner(), { appIds })).entries; feeVersion = 1 };
  };
  func promote(db : Store.DB, requestId : Text, appIds : [Text]) : BatchPublishing.Promoted {
    ok(BatchPublishing.promote(db, Fixtures.owner(), plan(db, requestId, appIds), 4));
  };

  public func legacy_bootstrap_preserves_revoked_pointers_and_never_repeats() : async Test.Metrics {
    Test.test(func() {
      let memory = Fixtures.memory();
      let publishers = PublisherStore.init();
      let predecessor = Store.Use(memory, publishers);
      let liveApp = Fixtures.draft(predecessor, "legacy_live", 0);
      let revokedApp = Fixtures.draft(predecessor, "legacy_revoked", 0);
      let live = Fixtures.candidate(predecessor, liveApp.appId, 100, "legacy-live");
      let revoked = Fixtures.candidate(predecessor, revokedApp.appId, 100, "legacy-revoked");
      ignore Fixtures.stored(predecessor.candidates.update({ live with state = #approved; published = true }));
      ignore Fixtures.stored(predecessor.candidates.update({ revoked with state = #revoked; published = true }));
      ignore Fixtures.stored(predecessor.apps.update({ liveApp with approvedCandidate = ?live.id }));
      ignore Fixtures.stored(predecessor.apps.update({ revokedApp with approvedCandidate = ?revoked.id }));
      let channels = ReleaseStore.init();
      let db = Store.UseWithChannels(memory, publishers, channels);
      assert channels.bootstrapped;
      assert ReleaseStore.heads(channels, liveApp.appId) == {
        stableHead = { candidateId = ?live.id; revision = 1 }; betaHead = { candidateId = null; revision = 0 };
      };
      let revokedHead = ReleaseStore.heads(channels, revokedApp.appId);
      assert revokedHead.stableHead.candidateId == ?revoked.id;
      assert Catalog.release(db, revokedApp, #stable_) == null;
      assert Store.getArtifact(db, live.artifactId) != null;
      assert Store.getArtifact(db, revoked.artifactId) != null;
      let next = beta(db, liveApp.appId, 101, "next-beta", []);
      assert ReleaseStore.heads(channels, liveApp.appId).stableHead.candidateId == ?live.id;
      assert ReleaseStore.heads(channels, liveApp.appId).betaHead.candidateId == ?next.id;
      ignore promote(db, "first-promotion", [liveApp.appId]);
      let advanced = ReleaseStore.heads(channels, liveApp.appId);
      let restored = Store.UseWithChannels(memory, publishers, channels);
      ReleaseStore.bootstrap(channels, restored.apps.iterPrimary(#fwd, null));
      assert ReleaseStore.heads(channels, liveApp.appId) == advanced;
      assert advanced.stableHead.candidateId == ?next.id;
      assert ReleaseStore.heads(channels, revokedApp.appId) == revokedHead;
      let ?retainedApp = Store.getApp(restored, liveApp.appId) else Runtime.trap("Missing retained app");
      assert retainedApp.approvedCandidate == ?live.id;
      assert Store.getCandidate(restored, revoked.id) == Store.getCandidate(predecessor, revoked.id);
    });
  };

  public func promotion_validates_the_complete_resulting_dependency_graph_before_writes() : async Test.Metrics {
    Test.test(func() {
      let db = Store.UseWithChannels(Fixtures.memory(), PublisherStore.init(), ReleaseStore.init());
      ignore beta(db, "kernel", 100, "kernel100", []);
      ignore beta(db, "library", 100, "library100", [{ appId = "kernel"; minVersion = 100 }]);
      ignore beta(db, "application", 100, "application100", [{ appId = "library"; minVersion = 100 }]);
      ignore promote(db, "initial", ["kernel", "library", "application"]);
      let kernel = beta(db, "kernel", 101, "kernel101", []);
      let library = beta(db, "library", 101, "library101", [{ appId = "kernel"; minVersion = 101 }]);
      let application = beta(db, "application", 101, "application101", [{ appId = "library"; minVersion = 101 }]);
      let beforeKernel = ReleaseStore.heads(db.channels, "kernel");
      let beforeLibrary = ReleaseStore.heads(db.channels, "library");
      let beforeApp = ReleaseStore.heads(db.channels, "application");
      let beforeId = db.channels.nextPromotionId;
      let incomplete = plan(db, "missing-kernel", ["application", "library"]);
      error(BatchPublishing.promote(db, Fixtures.owner(), incomplete, 5), "dependency_version");
      assert ReleaseStore.heads(db.channels, "kernel") == beforeKernel;
      assert ReleaseStore.heads(db.channels, "library") == beforeLibrary;
      assert ReleaseStore.heads(db.channels, "application") == beforeApp;
      assert db.channels.nextPromotionId == beforeId;
      assert Map.get(db.channels.promotions, ReleaseStore.requestCompare, (Fixtures.owner(), incomplete.requestId)) == null;
      let complete = plan(db, "complete", ["kernel", "library", "application"]);
      error(BatchPublishing.promote(db, Fixtures.other(), complete, 5), "publisher_required");
      error(BatchPublishing.promote(db, Fixtures.owner(), {
        complete with entries = [complete.entries[0], complete.entries[1], { complete.entries[2] with sourceSize = ?999 }];
      }, 5), "release_unavailable");
      assert ReleaseStore.heads(db.channels, "kernel") == beforeKernel;
      assert ReleaseStore.heads(db.channels, "library") == beforeLibrary;
      assert ReleaseStore.heads(db.channels, "application") == beforeApp;
      assert db.channels.nextPromotionId == beforeId;
      let committed = ok(BatchPublishing.promote(db, Fixtures.owner(), complete, 6));
      assert committed.receipt.entries == complete.entries;
      assert committed.appIds == ["kernel", "library", "application"];
      assert ReleaseStore.heads(db.channels, "kernel").stableHead.candidateId == ?kernel.id;
      assert ReleaseStore.heads(db.channels, "library").stableHead.candidateId == ?library.id;
      assert ReleaseStore.heads(db.channels, "application").stableHead.candidateId == ?application.id;
      for (candidate in [kernel, library, application].vals()) {
        assert Store.getArtifact(db, candidate.artifactId) != null;
        let ?sourceId = candidate.sourceArtifactId else Runtime.trap("Missing source identity");
        assert Store.getArtifact(db, sourceId) != null;
      };
    });
  };

  public func unrelated_publication_does_not_invalidate_selection_and_noop_replays_are_durable() : async Test.Metrics {
    Test.test(func() {
      let db = Store.UseWithChannels(Fixtures.memory(), PublisherStore.init(), ReleaseStore.init());
      ignore beta(db, "application", 100, "app100", []);
      let reviewed = plan(db, "reviewed", ["application"]);
      ignore beta(db, "unrelated", 100, "other100", []);
      ignore promote(db, "unrelated-stable", ["unrelated"]);
      let published = ok(BatchPublishing.promote(db, Fixtures.owner(), reviewed, 5));
      let noopRequest = plan(db, "noop", ["application"]);
      let before = ReleaseStore.heads(db.channels, "application");
      let beforeId = db.channels.nextPromotionId;
      let noop = ok(BatchPublishing.promote(db, Fixtures.owner(), noopRequest, 6));
      assert noop.receipt.id == 0 and noop.appIds == [] and noop.retiredArtifacts == [];
      assert ReleaseStore.heads(db.channels, "application") == before;
      assert db.channels.nextPromotionId == beforeId;
      assert Map.get(db.channels.promotions, ReleaseStore.requestCompare, (Fixtures.owner(), "noop")) == ?noop.receipt;
      ignore beta(db, "application", 101, "app101", []);
      let successorRequest = plan(db, "successor", ["application"]);
      ignore ok(BatchPublishing.promote(db, Fixtures.owner(), successorRequest, 7));
      let after = ReleaseStore.heads(db.channels, "application");
      let replay = ok(BatchPublishing.promote(db, Fixtures.owner(), reviewed, 8));
      assert replay.receipt == published.receipt and replay.appIds == [] and replay.retiredArtifacts == [];
      assert ok(BatchPublishing.promote(db, Fixtures.owner(), noopRequest, 8)).receipt == noop.receipt;
      error(BatchPublishing.promote(db, Fixtures.owner(), { successorRequest with requestId = "noop" }, 8), "request_conflict");
      error(BatchPublishing.promote(db, Fixtures.owner(), { successorRequest with requestId = "stale-stable" }, 8), "channel_conflict");
      assert ReleaseStore.heads(db.channels, "application") == after;
    });
  };
}
