// All rights reserved. See ../LICENSE.
import API "../mo/API";
import Audits "../mo/Audits";
import Encoding "../mo/Encoding";
import Http "../mo/Http";
import Repository "../mo/Repository";
import Store "../mo/Store";
import Types "../mo/Types";
import F "motoko/Fixtures";
import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Test "mo:test";

persistent actor RepositoryTests {
  type Context = {
    memory : Store.Mem;
    db : Store.DB;
    certification : Http.Memory;
    repo : Repository.Service;
    http : Http.Store;
  };

  func setup() : Context {
    let memory = F.memory();
    let db = Store.Use(memory);
    let certification = Http.init();
    let repo = Repository.Service(db, certification, Principal.fromActor(RepositoryTests));
    let http = Http.Store(certification, {
      artifact = repo.artifact;
      chunk = repo.chunk;
      authorize = func(_path : Text, _grant : ?Text) : Bool { true };
    });
    http.initialize();
    repo.initialize(http);
    { memory; db; certification; repo; http };
  };

  func accepted<T>(result : API.Result<T>) : T {
    switch (result) {
      case (#ok(value)) value;
      case (#err(error)) Runtime.trap("Repository test unexpectedly rejected: " # debug_show(error));
    };
  };

  func rejected<T>(result : API.Result<T>) {
    switch (result) {
      case (#err(_)) {};
      case (#ok(_)) Runtime.trap("Repository test unexpectedly accepted");
    };
  };

  func request(requestId : Text, appIds : [Text]) : API.InstallRequest {
    { requestId; appIds; feeVersion = 1 };
  };

  func release(db : Store.DB, appId : Text, version : Nat, price : Nat, requestId : Text, dependencies : [{ appId : Text; minVersion : Nat }]) : Types.Candidate {
    if (Store.getApp(db, appId) == null) ignore F.draft(db, appId, price);
    let candidate = F.candidate(db, appId, version, requestId);
    let linked = F.stored(db.candidates.update({ candidate with dependencies }));
    ignore F.approve(db, linked, requestId # "-audit");
    let ?approved = Store.getCandidate(db, linked.id) else Runtime.trap("Approved fixture candidate missing");
    approved;
  };

  func own(db : Store.DB, owner : Principal, appId : Text) {
    ignore F.stored(Store.insertEntitlement(db, {
      owner; appId; orderId = 1; kind = #paid; acquiredAtNs = 4;
    }));
  };

  func manifest(context : Context, result : API.InstallResult) : Types.Manifest {
    let ?saved = Store.getManifest(context.db, result.manifestId) else Runtime.trap("Prepared manifest was not retained");
    let path = "/repo/v1/manifests/" # result.manifestId # ".json";
    let ?bytes = context.repo.chunk(path, 0) else Runtime.trap("Prepared manifest has no metadata bytes");
    let ?metadata = context.repo.artifact(path) else Runtime.trap("Prepared manifest has no HTTP metadata");
    assert saved.content == bytes;
    assert Encoding.hash(bytes) == saved.digest;
    assert Encoding.hex(saved.digest) == result.digest;
    assert metadata.sha256 == saved.digest and metadata.size == bytes.size();
    assert metadata.publicAccess and metadata.contentType == "application/json";
    assert Text.contains(result.setupUrl, #text("#repo=" # Principal.toText(result.canister) # "&manifest=" # result.manifestId # "&digest=" # result.digest));
    assert context.repo.chunk(path, 1) == null;
    saved;
  };

  func contains(values : [Text], value : Text) : Bool {
    Array.find<Text>(values, func(item) { item == value }) != null;
  };

  public func approved_owned_root_includes_free_dependencies_without_acquiring_them() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let dependency = release(c.db, "free_dependency", 100, 0, "free-release", []);
      let root = release(c.db, "paid_root", 100, 1_000_000, "root-release", [{ appId = dependency.appId; minVersion = 100 }]);
      own(c.db, F.other(), root.appId);
      let input = request("owned-root", [root.appId]);
      let result = accepted(c.repo.prepare(c.http, F.other(), input, 10));
      let saved = manifest(c, result);
      assert result.appIds.size() == 2 and contains(result.appIds, root.appId) and contains(result.appIds, dependency.appId);
      assert saved.candidateIds.size() == 2;
      assert c.db.manifests.size() == 1;
      assert c.db.entitlements.size() == 1;
      assert Store.getEntitlement(c.db, F.other(), dependency.appId) == null;
      assert c.db.orders.size() == 0;
    });
  };

  public func missing_paid_dependency_denies_whole_selection_before_retention() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let dependency = release(c.db, "paid_dependency", 100, 1_000_000, "paid-dependency", []);
      let root = release(c.db, "paid_root", 100, 1_000_000, "paid-root", [{ appId = dependency.appId; minVersion = 100 }]);
      own(c.db, F.other(), root.appId);
      let input = request("unowned-dependency", [root.appId]);
      rejected(c.repo.prepare(c.http, F.other(), input, 10));
      assert c.db.manifests.size() == 0 and c.db.entitlements.size() == 1;
      own(c.db, F.other(), dependency.appId);
      let result = accepted(c.repo.prepare(c.http, F.other(), input, 11));
      assert manifest(c, result).candidateIds.size() == 2;
      assert c.db.manifests.size() == 1 and c.db.orders.size() == 0;
    });
  };

  public func unapproved_or_unowned_roots_do_not_create_an_install_manifest() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore F.draft(c.db, "pending_root", 0);
      ignore F.candidate(c.db, "pending_root", 100, "pending-candidate");
      let paid = release(c.db, "unowned_root", 100, 1_000_000, "unowned-candidate", []);
      rejected(c.repo.prepare(c.http, F.other(), request("pending", ["pending_root"]), 10));
      rejected(c.repo.prepare(c.http, F.other(), request("not-owned", [paid.appId]), 10));
      rejected(c.repo.prepare(c.http, F.other(), request("missing", ["missing_root"]), 10));
      assert c.db.manifests.size() == 0 and c.db.orders.size() == 0;
    });
  };

  public func dependency_minimums_reject_and_cyclic_closures_terminate_without_duplicates() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "old_dependency", 100, 0, "old-dependency", []);
      ignore release(c.db, "new_root", 100, 0, "new-root", [{ appId = "old_dependency"; minVersion = 101 }]);
      own(c.db, F.other(), "new_root");
      rejected(c.repo.prepare(c.http, F.other(), request("old-dependency-request", ["new_root"]), 10));
      assert c.db.manifests.size() == 0;
      ignore release(c.db, "cycle_root", 100, 0, "cycle-root", [{ appId = "cycle_dependency"; minVersion = 100 }]);
      ignore release(c.db, "cycle_dependency", 100, 0, "cycle-dependency", [{ appId = "cycle_root"; minVersion = 100 }]);
      own(c.db, F.other(), "cycle_root");
      let cyclic = accepted(c.repo.prepare(c.http, F.other(), request("cycle-request", ["cycle_root"]), 11));
      assert cyclic.appIds.size() == 2 and manifest(c, cyclic).candidateIds.size() == 2;
      assert c.db.manifests.size() == 1;
      ignore release(c.db, "old_dependency", 101, 0, "current-dependency", []);
      assert manifest(c, accepted(c.repo.prepare(c.http, F.other(), request("old-dependency-request", ["new_root"]), 12))).candidateIds.size() == 2;
    });
  };

  public func diamond_dependencies_appear_only_once() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "shared_dependency", 100, 0, "shared-dependency", []);
      let sharedDependencies = [{ appId = "shared_dependency"; minVersion = 100 }];
      ignore release(c.db, "left_branch", 100, 0, "left-branch", sharedDependencies);
      ignore release(c.db, "right_branch", 100, 0, "right-branch", sharedDependencies);
      ignore release(c.db, "diamond_root", 100, 0, "diamond-root", [
        { appId = "left_branch"; minVersion = 100 }, { appId = "right_branch"; minVersion = 100 },
      ]);
      own(c.db, F.other(), "diamond_root");
      let result = accepted(c.repo.prepare(c.http, F.other(), request("diamond", ["diamond_root"]), 10));
      assert result.appIds.size() == 4 and manifest(c, result).candidateIds.size() == 4;
      var sharedCount = 0;
      for (id in result.appIds.vals()) { if (id == "shared_dependency") sharedCount += 1 };
      assert sharedCount == 1;
    });
  };

  public func retired_release_retry_preserves_original_selection_and_requires_new_request() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let dependency = release(c.db, "retry_dependency", 100, 0, "retry-dependency-100", []);
      let root = release(c.db, "retry_root", 100, 0, "retry-root-100", [{ appId = dependency.appId; minVersion = 100 }]);
      own(c.db, F.other(), root.appId);
      let input = request("immutable-request", [root.appId]);
      let first = accepted(c.repo.prepare(c.http, F.other(), input, 10));
      let before = manifest(c, first);
      let entitlement = Store.getEntitlement(c.db, F.other(), root.appId);
      assert accepted(c.repo.prepare(c.http, F.other(), input, 11)) == first;
      ignore release(c.db, dependency.appId, 200, 0, "retry-dependency-200", []);
      ignore release(c.db, root.appId, 200, 0, "retry-root-200", [{ appId = dependency.appId; minVersion = 200 }]);
      assert Store.getArtifact(c.db, dependency.artifactId) == null;
      assert Store.getArtifact(c.db, root.artifactId) == null;
      // Retention deletes superseded package bytes, but cannot silently
      // rewrite an existing installation request to the successor release.
      switch (c.repo.prepare(c.http, F.other(), input, 20)) {
        case (#err(error)) assert error.code == "release_unavailable";
        case (#ok(_)) Runtime.trap("A retired release unexpectedly remained installable");
      };
      assert manifest(c, first) == before;
      assert Store.getEntitlement(c.db, F.other(), root.appId) == entitlement;
      // Both selections expand to the same two apps. The original selected
      // roots still differ, so the old request ID must not accept this change.
      rejected(c.repo.prepare(c.http, F.other(), { input with appIds = [root.appId, dependency.appId] }, 21));
      assert c.db.manifests.size() == 1;
      let fresh = accepted(c.repo.prepare(c.http, F.other(), { input with requestId = "new-release-request" }, 22));
      assert fresh.digest != first.digest and fresh.manifestId != first.manifestId;
      assert manifest(c, fresh).candidateIds != before.candidateIds;
    });
  };

  public func normalized_selection_and_owner_bind_retry_identity() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      ignore release(c.db, "first_root", 100, 0, "first-root", []);
      ignore release(c.db, "second_root", 100, 0, "second-root", []);
      for (owner in [F.other(), F.owner()].vals()) {
        own(c.db, owner, "first_root");
        own(c.db, owner, "second_root");
      };
      let input = request("shared-request-id", ["second_root", "first_root"]);
      let first = accepted(c.repo.prepare(c.http, F.other(), input, 10));
      let reordered = accepted(c.repo.prepare(c.http, F.other(), { input with appIds = ["first_root", "second_root"] }, 11));
      assert first == reordered;
      let anotherOwner = accepted(c.repo.prepare(c.http, F.owner(), input, 12));
      assert first.manifestId != anotherOwner.manifestId;
      assert c.db.manifests.size() == 2;
      assert manifest(c, first).owner == F.other();
      assert manifest(c, anotherOwner).owner == F.owner();
    });
  };

  public func kernel_dependency_is_retained_on_candidate_but_excluded_from_downloads() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let dependencies = [{ appId = "kernel"; minVersion = 350 }];
      let root = release(c.db, "kernel_consumer", 100, 0, "kernel-consumer", dependencies);
      own(c.db, F.other(), root.appId);
      // The installed Kernel supplies this dependency. No marketplace Kernel
      // listing or entitlement is required to prepare the app's package.
      assert Store.getApp(c.db, "kernel") == null;
      let result = accepted(c.repo.prepare(c.http, F.other(), request("kernel-dependency", [root.appId]), 10));
      let saved = manifest(c, result);
      assert result.appIds == [root.appId] and saved.candidateIds == [root.id];
      let ?content = Text.decodeUtf8(saved.content) else Runtime.trap("Manifest is not UTF-8");
      assert not Text.contains(content, #text("\"id\":\"kernel\""));
      let ?retained = Store.getCandidate(c.db, root.id) else Runtime.trap("Candidate disappeared");
      assert retained.dependencies == dependencies;
      // Selecting Kernel itself still belongs to the existing Settings
      // update path, whether it is the only root or mixed with an app.
      rejected(c.repo.prepare(c.http, F.other(), request("kernel-root", ["kernel"]), 11));
      rejected(c.repo.prepare(c.http, F.other(), request("mixed-kernel-root", [root.appId, "kernel"]), 11));
      assert c.db.manifests.size() == 1;
    });
  };

  public func revoked_retry_cannot_substitute_a_later_release_or_erase_entitlement() : async Test.Metrics {
    Test.test(func() {
      let c = setup();
      let root = release(c.db, "revoked_root", 100, 1_000_000, "revoked-root-100", []);
      own(c.db, F.other(), root.appId);
      let input = request("revocation-request", [root.appId]);
      let first = accepted(c.repo.prepare(c.http, F.other(), input, 10));
      let before = manifest(c, first);
      ignore F.ok(Audits.stamp(c.db, F.auditor(), {
        requestId = "revoke-root"; candidateId = root.id; decision = #revoked;
        expectedDigest = root.digest; expectedSourceDigest = root.sourceDigest;
        analysis = "The retained package was reviewed again"; reason = ?"Fixture revocation";
      }, 11));
      ignore release(c.db, root.appId, 101, 1_000_000, "replacement-root-101", []);
      rejected(c.repo.prepare(c.http, F.other(), input, 12));
      assert Store.getManifest(c.db, first.manifestId) == ?before;
      assert Store.getEntitlement(c.db, F.other(), root.appId) != null;
      assert c.db.manifests.size() == 1;
      let replacement = accepted(c.repo.prepare(c.http, F.other(), { input with requestId = "replacement-request" }, 13));
      assert replacement.digest != first.digest;
      assert manifest(c, replacement).candidateIds != before.candidateIds;
    });
  };
};
