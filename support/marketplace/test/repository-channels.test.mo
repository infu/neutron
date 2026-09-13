// All rights reserved. See ../LICENSE.
import API "../mo/API";
import Encoding "../mo/Encoding";
import Http "../mo/Http";
import PublisherStore "../mo/PublisherStore";
import ReleaseStore "../mo/ReleaseStore";
import Repository "../mo/Repository";
import Store "../mo/Store";
import Types "../mo/Types";
import F "motoko/Fixtures";
import Array "mo:core/Array";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Test "mo:test";

persistent actor RepositoryChannelTests {
  type Context = { db : Store.DB; certification : Http.Memory; repo : Repository.Service; http : Http.Store };
  type Selection = API.ChannelInstallSelection and { roots : [Text] };

  func setup() : Context {
    let db = Store.Use(F.memory(), PublisherStore.init(), ReleaseStore.init());
    let certification = Http.init();
    let repo = Repository.Service(db, certification, Principal.fromActor(RepositoryChannelTests));
    let http = Http.Store(certification, {
      artifact = repo.artifact; chunk = repo.chunk;
      authorize = func(_path : Text, _grant : ?Text) : Bool { true };
    });
    http.initialize();
    repo.initialize(http);
    { db; certification; repo; http };
  };

  func accepted<T>(result : API.Result<T>) : T {
    switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(debug_show(error)) };
  };

  func rejected<T>(result : API.Result<T>) {
    switch (result) { case (#err(_)) {}; case (#ok(_)) Runtime.trap("Unexpectedly accepted channel selection") };
  };

  func publish(c : Context, appId : Text, version : Nat, channel : ReleaseStore.Mode, dependencies : [{ appId : Text; minVersion : Nat }]) : Types.Candidate {
    if (Store.getApp(c.db, appId) == null) ignore F.draft(c.db, appId, 0);
    let candidate = F.candidate(c.db, appId, version, appId # "-" # Nat.toText(version));
    // Construct already-published fixtures directly: channel transaction and
    // audit tests own the publication workflow; these tests own its consumers.
    let published = F.stored(c.db.candidates.update({ candidate with state = #approved; published = true; dependencies }));
    let heads = ReleaseStore.heads(c.db.channels, appId);
    let next = switch (channel) {
      case (#stable_) ({ heads with stableHead = { candidateId = ?published.id; revision = heads.stableHead.revision + 1 } });
      case (#beta) ({ heads with betaHead = { candidateId = ?published.id; revision = heads.betaHead.revision + 1 } });
    };
    ReleaseStore.putHeads(c.db.channels, appId, next);
    c.repo.refreshApp(c.http, appId);
    published;
  };

  func own(c : Context, appId : Text) {
    ignore F.stored(Store.insertEntitlement(c.db, {
      owner = F.other(); appId; orderId = 1; kind = #paid; acquiredAtNs = 4;
    }));
  };

  func body(c : Context, path : Text) : Text {
    let ?bytes = c.repo.chunk(path, 0) else Runtime.trap("Missing metadata: " # path);
    let ?metadata = c.repo.artifact(path) else Runtime.trap("Missing metadata artifact: " # path);
    assert metadata.sha256 == Encoding.hash(bytes) and metadata.size == bytes.size();
    assert metadata.publicAccess and metadata.contentType == "application/json" and metadata.chunks == 1;
    assert c.repo.chunk(path, 1) == null;
    let ?value = Text.decodeUtf8(bytes) else Runtime.trap("Metadata is not UTF-8");
    value;
  };

  func releaseJson(c : Context, candidate : Types.Candidate) : Text {
    let ?artifact = Store.getArtifact(c.db, candidate.artifactId) else Runtime.trap("Fixture package missing");
    "{\"protocol\":\"neutron-repo-v1\",\"id\":" # Encoding.quote(candidate.appId) #
      ",\"version\":" # Nat.toText(candidate.version) # ",\"sha256\":" # Encoding.quote(Encoding.hex(candidate.digest)) #
      ",\"size\":" # Nat64.toText(artifact.size) # "}";
  };

  func source() : Text { Principal.toText(Principal.fromActor(RepositoryChannelTests)) };

  func selected(c : Context, appIds : [Text], mode : ReleaseStore.Mode) : Selection {
    let value = accepted(c.repo.selection(F.other(), { appIds; mode }));
    ({ value with roots = appIds });
  };

  func input(requestId : Text, selection : Selection) : API.ChannelInstallRequest {
    { request = { requestId; appIds = selection.roots; feeVersion = 1 }; mode = selection.mode; selection = selection.selection };
  };

  func entry(selection : API.ChannelInstallSelection, appId : Text) : ReleaseStore.Selection {
    let ?value = Array.find<ReleaseStore.Selection>(selection.selection, func(value) { value.appId == appId }) else Runtime.trap("Missing selected app " # appId);
    value;
  };

  func saved(c : Context, result : API.InstallResult) : Types.Manifest {
    let ?value = Store.getManifest(c.db, result.manifestId) else Runtime.trap("Prepared manifest missing");
    assert Encoding.hex(Encoding.hash(value.content)) == result.digest;
    assert body(c, Repository.manifestPath(result.manifestId)) == (switch (Text.decodeUtf8(value.content)) { case (?text) text; case null Runtime.trap("Invalid manifest UTF-8") });
    value;
  };

  public func stable_v1_bytes_and_raw_beta_paths_survive_reinitialization() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      assert body(c, Repository.channelsPath) == "{\"protocol\":\"neutron-repo-channels-v1\",\"source\":" # Encoding.quote(source()) # "}";
      let stableRelease = publish(c, "channel_app", 100, #stable_, []);
      let before = body(c, Repository.releasePath(stableRelease.appId));
      assert before == releaseJson(c, stableRelease);
      assert c.repo.chunk(Repository.betaReleasePath(stableRelease.appId), 0) == null;
      let betaRelease = publish(c, stableRelease.appId, 101, #beta, []);
      assert body(c, Repository.releasePath(stableRelease.appId)) == before;
      assert body(c, Repository.betaReleasePath(stableRelease.appId)) == releaseJson(c, betaRelease);
      let heads = body(c, Repository.channelHeadsPath(stableRelease.appId));
      assert heads == "{\"protocol\":\"neutron-repo-channel-heads-v1\",\"source\":" # Encoding.quote(source()) #
        ",\"id\":\"channel_app\",\"stable\":{\"revision\":\"1\",\"candidate_id\":" # Encoding.quote(Nat64.toText(stableRelease.id)) #
        ",\"release\":" # releaseJson(c, stableRelease) # "},\"beta\":{\"revision\":\"1\",\"candidate_id\":" # Encoding.quote(Nat64.toText(betaRelease.id)) #
        ",\"release\":" # releaseJson(c, betaRelease) # "}}";
      c.repo.initialize(c.http);
      assert body(c, Repository.releasePath(stableRelease.appId)) == before;
      assert body(c, Repository.betaReleasePath(stableRelease.appId)) == releaseJson(c, betaRelease);
      assert body(c, Repository.channelHeadsPath(stableRelease.appId)) == heads;
    });
  };

  public func beta_only_apps_keep_legacy_stable_absent() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let betaRelease = publish(c, "beta_only", 100, #beta, []);
      own(c, betaRelease.appId);
      assert c.repo.artifact(Repository.releasePath(betaRelease.appId)) == null;
      assert body(c, Repository.betaReleasePath(betaRelease.appId)) == releaseJson(c, betaRelease);
      assert Text.contains(body(c, Repository.channelHeadsPath(betaRelease.appId)), #text("\"stable\":{\"revision\":\"0\",\"candidate_id\":null,\"release\":null}"));
      rejected(c.repo.selection(F.other(), { appIds = [betaRelease.appId]; mode = #stable_ }));
      let selection = selected(c, [betaRelease.appId], #beta);
      assert entry(selection, betaRelease.appId).candidateId == betaRelease.id;
      let result = accepted(c.repo.prepareV2(c.http, F.other(), input("beta-only-install", selection), 10));
      assert saved(c, result).candidateIds == [betaRelease.id];
      let content = body(c, Repository.manifestPath(result.manifestId));
      assert Text.contains(content, #text("\"protocol\":\"neutron-repo-channel-manifest-v1\""));
      assert Text.contains(content, #text("\"channel\":\"beta\""));
    });
  };

  public func revoked_raw_beta_retains_head_identity_and_resolves_eligible_stable() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let stableRelease = publish(c, "revoked_beta", 100, #stable_, []);
      let betaRelease = publish(c, stableRelease.appId, 101, #beta, []);
      own(c, stableRelease.appId);
      let heads = ReleaseStore.heads(c.db.channels, betaRelease.appId);
      ignore F.stored(c.db.candidates.update({ betaRelease with state = #revoked }));
      c.repo.refreshApp(c.http, betaRelease.appId);
      assert ReleaseStore.heads(c.db.channels, betaRelease.appId) == heads;
      assert c.repo.artifact(Repository.betaReleasePath(betaRelease.appId)) == null;
      assert Text.contains(body(c, Repository.channelHeadsPath(betaRelease.appId)), #text("\"beta\":{\"revision\":\"1\",\"candidate_id\":" # Encoding.quote(Nat64.toText(betaRelease.id)) # ",\"release\":null}"));
      let selection = selected(c, [stableRelease.appId], #beta);
      assert entry(selection, stableRelease.appId).candidateId == stableRelease.id;
      assert entry(selection, stableRelease.appId).channel == #stable_;
    });
  };

  public func channel_mode_resolves_the_complete_dependency_closure() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let dependency = publish(c, "channel_dependency", 100, #stable_, []);
      let betaDependency = publish(c, dependency.appId, 200, #beta, []);
      let fallback = publish(c, "stable_fallback", 100, #stable_, []);
      let root = publish(c, "channel_root", 100, #stable_, [{ appId = dependency.appId; minVersion = 100 }]);
      let betaRoot = publish(c, root.appId, 200, #beta, [
        { appId = dependency.appId; minVersion = 200 }, { appId = fallback.appId; minVersion = 100 }, { appId = "kernel"; minVersion = 350 },
      ]);
      own(c, root.appId);
      let stableSelection = selected(c, [root.appId], #stable_);
      assert stableSelection.selection.size() == 2;
      assert entry(stableSelection, root.appId).candidateId == root.id;
      assert entry(stableSelection, dependency.appId).candidateId == dependency.id;
      let betaSelection = selected(c, [root.appId], #beta);
      assert betaSelection.selection.size() == 3;
      assert entry(betaSelection, root.appId).candidateId == betaRoot.id;
      assert entry(betaSelection, dependency.appId).candidateId == betaDependency.id;
      assert entry(betaSelection, dependency.appId).channel == #beta;
      assert entry(betaSelection, fallback.appId).channel == #stable_;
      let result = accepted(c.repo.prepareV2(c.http, F.other(), input("mixed-beta-closure", betaSelection), 10));
      assert saved(c, result).candidateIds.size() == 3;
      assert not Text.contains(body(c, Repository.manifestPath(result.manifestId)), #text("\"id\":\"kernel\""));
      // Adding an already-selected dependency to the roots changes intent
      // even though the resolved candidate closure remains exactly the same.
      let original = input("mixed-beta-closure", betaSelection);
      let changedRoots = { original with request = { original.request with appIds = [root.appId, dependency.appId] } };
      switch (c.repo.prepareV2(c.http, F.other(), changedRoots, 11)) {
        case (#err(error)) assert error.code == "request_mismatch";
        case (#ok(_)) Runtime.trap("Reused request accepted different roots");
      };
      let legacy = accepted(c.repo.prepare(c.http, F.other(), { requestId = "legacy-stable-closure"; appIds = [root.appId]; feeVersion = 1 }, 11));
      assert saved(c, legacy).candidateIds == [dependency.id, root.id];
      let legacyContent = body(c, Repository.manifestPath(legacy.manifestId));
      assert Text.contains(legacyContent, #text("\"protocol\":\"neutron-repo-v1\""));
      assert not Text.contains(legacyContent, #text("\"channel\":"));
    });
  };

  public func stable_dependency_minimum_cannot_be_satisfied_by_beta() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let dependency = publish(c, "minimum_dependency", 100, #stable_, []);
      let betaDependency = publish(c, dependency.appId, 200, #beta, []);
      let root = publish(c, "minimum_root", 100, #stable_, [{ appId = dependency.appId; minVersion = 200 }]);
      own(c, root.appId);
      rejected(c.repo.selection(F.other(), { appIds = [root.appId]; mode = #stable_ }));
      rejected(c.repo.prepare(c.http, F.other(), { requestId = "legacy-minimum"; appIds = [root.appId]; feeVersion = 1 }, 10));
      assert c.db.manifests.size() == 0 and Map.size(c.db.channels.manifests) == 0;
      let betaSelection = selected(c, [root.appId], #beta);
      assert entry(betaSelection, dependency.appId).candidateId == betaDependency.id;
      assert entry(betaSelection, root.appId).channel == #stable_;
      ignore accepted(c.repo.prepareV2(c.http, F.other(), input("beta-minimum", betaSelection), 11));
    });
  };

  public func stale_selection_rejects_before_retaining_any_manifest() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let root = publish(c, "stale_selection", 100, #beta, []);
      own(c, root.appId);
      let stale = input("stale-request", selected(c, [root.appId], #beta));
      rejected(c.repo.prepareV2(c.http, F.other(), { stale with selection = [] }, 9));
      assert c.db.manifests.size() == 0 and Map.size(c.db.channels.manifests) == 0;
      ignore publish(c, root.appId, 101, #beta, []);
      rejected(c.repo.prepareV2(c.http, F.other(), stale, 10));
      assert c.db.manifests.size() == 0 and Map.size(c.db.channels.manifests) == 0;
      // A rejected attempt does not reserve the request ID or commit a partial
      // selection; its caller may submit the newly reviewed exact selection.
      let fresh = input("stale-request", selected(c, [root.appId], #beta));
      ignore accepted(c.repo.prepareV2(c.http, F.other(), fresh, 11));
      assert c.db.manifests.size() == 1 and Map.size(c.db.channels.manifests) == 1;
    });
  };

  public func unrelated_publication_does_not_invalidate_selected_heads() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let root = publish(c, "selected_root", 100, #stable_, []);
      own(c, root.appId);
      let request = input("independent-heads", selected(c, [root.appId], #beta));
      ignore publish(c, "unrelated_app", 100, #beta, []);
      assert saved(c, accepted(c.repo.prepareV2(c.http, F.other(), request, 10))).candidateIds == [root.id];
    });
  };

  public func retry_binds_mode_roots_and_exact_selection_while_preserving_sidecar() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let root = publish(c, "retry_channel", 100, #stable_, []);
      own(c, root.appId);
      let selection = selected(c, [root.appId], #beta);
      let request = input("immutable-channel-request", selection);
      let first = accepted(c.repo.prepareV2(c.http, F.other(), request, 10));
      let retained = saved(c, first);
      let path = Repository.channelManifestPath(first.manifestId);
      let sidecar = body(c, path);
      let ?metadata = c.repo.artifact(path) else Runtime.trap("Missing selection metadata");
      assert metadata.immutable;
      let ?artifact = Store.getArtifact(c.db, root.artifactId) else Runtime.trap("Missing retained package");
      assert sidecar == "{\"protocol\":\"neutron-repo-channel-selection-v1\",\"source\":" # Encoding.quote(source()) #
        ",\"mode\":\"beta\",\"manifest_id\":" # Encoding.quote(first.manifestId) # ",\"manifest_sha256\":" # Encoding.quote(first.digest) #
        ",\"packages\":[{\"id\":\"retry_channel\",\"version\":100,\"sha256\":" # Encoding.quote(Encoding.hex(root.digest)) #
        ",\"size\":" # Nat64.toText(artifact.size) # ",\"candidate_id\":" # Encoding.quote(Nat64.toText(root.id)) #
        ",\"channel\":\"stable\",\"revision\":\"1\"}]}";
      assert accepted(c.repo.prepareV2(c.http, F.other(), request, 11)) == first;
      rejected(c.repo.prepareV2(c.http, F.other(), { request with mode = #stable_ }, 12));
      ignore publish(c, root.appId, 101, #beta, []);
      assert accepted(c.repo.prepareV2(c.http, F.other(), request, 13)) == first;
      rejected(c.repo.prepareV2(c.http, F.other(), input(request.request.requestId, selected(c, [root.appId], #beta)), 14));
      assert saved(c, first) == retained and body(c, path) == sidecar;
      assert c.db.manifests.size() == 1;
      // Blob retention does not govern immutable setup metadata. An upgrade
      // must restore the original proof even when its archive was collected.
      ignore F.stored(c.db.artifacts.delete(root.artifactId));
      c.repo.initialize(c.http);
      assert body(c, path) == sidecar;
      assert saved(c, first) == retained;
      rejected(c.repo.prepareV2(c.http, F.other(), request, 15));
    });
  };

  public func revoked_saved_selection_remains_immutable_and_cannot_be_retried() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let root = publish(c, "revoked_selection", 100, #beta, []);
      own(c, root.appId);
      let request = input("revoked-selection-request", selected(c, [root.appId], #beta));
      let first = accepted(c.repo.prepareV2(c.http, F.other(), request, 10));
      let retained = saved(c, first);
      let path = Repository.channelManifestPath(first.manifestId);
      let sidecar = body(c, path);
      ignore F.stored(c.db.candidates.update({ root with state = #revoked }));
      ignore publish(c, root.appId, 101, #beta, []);
      rejected(c.repo.prepareV2(c.http, F.other(), request, 11));
      assert saved(c, first) == retained and body(c, path) == sidecar;
      assert c.db.manifests.size() == 1;
      c.repo.initialize(c.http);
      assert body(c, path) == sidecar;
      assert Store.getEntitlement(c.db, F.other(), root.appId) != null;
    });
  };

  public func legacy_sidecars_derive_only_for_available_current_stable_candidates() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let current = publish(c, "legacy_current", 100, #stable_, []);
      let retired = publish(c, "legacy_retired", 100, #stable_, []);
      let revoked = publish(c, "legacy_revoked", 100, #stable_, []);
      let collected = publish(c, "legacy_collected", 100, #stable_, []);
      func legacy(candidate : Types.Candidate) : API.InstallResult {
        own(c, candidate.appId);
        accepted(c.repo.prepare(c.http, F.other(), { requestId = candidate.appId; appIds = [candidate.appId]; feeVersion = 1 }, 10));
      };
      let currentResult = legacy(current);
      let retiredResult = legacy(retired);
      let revokedResult = legacy(revoked);
      let collectedResult = legacy(collected);
      let original = saved(c, currentResult);
      // An installed predecessor retained v1 manifests without the additive
      // channel root. Reproduce exactly that absence before initialization.
      Map.clear(c.db.channels.manifests);
      ignore publish(c, retired.appId, 101, #stable_, []);
      ignore F.stored(c.db.candidates.update({ revoked with state = #revoked }));
      ignore F.stored(c.db.artifacts.delete(collected.artifactId));
      c.repo.initialize(c.http);
      assert Text.contains(body(c, Repository.channelManifestPath(currentResult.manifestId)), #text("\"mode\":\"stable\""));
      assert saved(c, currentResult) == original;
      for (result in [retiredResult, revokedResult, collectedResult].vals()) {
        assert c.repo.artifact(Repository.channelManifestPath(result.manifestId)) == null;
        ignore saved(c, result);
      };
      assert c.db.manifests.size() == 4 and Map.size(c.db.channels.manifests) == 1;
    });
  };
};
