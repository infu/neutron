// All rights reserved. See ../LICENSE.
import Test "mo:test";
import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import API "../mo/API";
import Access "../mo/Access";
import Assets "../mo/Assets";
import Audits "../mo/Audits";
import BatchPublishing "../mo/BatchPublishing";
import Billing "../mo/Billing";
import Catalog "../mo/Catalog";
import Publishing "../mo/Publishing";
import Store "../mo/Store";
import PublisherStore "../mo/PublisherStore";
import Types "../mo/Types";
import Fixtures "motoko/Fixtures";

persistent actor {
  func trusted() : Principal {
    Principal.fromText("y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe");
  };
  func memory(publisherMemory : PublisherStore.Mem) : Store.Mem {
    let mem = Fixtures.memory();
    Store.setTrustedPublishingPrincipal(Store.Use(mem, publisherMemory), ?trusted());
    mem;
  };
  func good<T>(result : API.Result<T>) : T {
    switch result { case (#ok(value)) value; case (#err(error)) Runtime.trap(debug_show(error)) };
  };
  func denied<T>(result : API.Result<T>) {
    switch result { case (#err(_)) {}; case (#ok(_)) Runtime.trap("Expected trusted publication rejection") };
  };
  func found<T>(value : ?T) : T {
    switch value { case (?result) result; case null Runtime.trap("Missing trusted publication fixture record") };
  };
  func upload(db : Store.DB, owner : Principal, appId : Text, requestId : Text, purpose : { #package; #source }) : Nat64 {
    let bytes = Text.encodeUtf8(appId # ":" # requestId);
    let input : API.UploadBegin = {
      requestId; appId; purpose; digest = Sha256.fromBlob(#sha256, bytes);
      size = Nat64.fromNat(bytes.size()); mediaType = "application/octet-stream"; feeVersion = 1;
    };
    let size = good(Assets.estimateNewStorage(db, owner, input));
    let quote = Billing.quote(Store.config(db).fees, #upload, 0, size);
    ignore good(Assets.begin(db, owner, input, quote, 1));
    ignore good(Assets.chunk(db, owner, { requestId; offset = 0; bytes; feeVersion = 1 }, 2));
    let complete = good(Assets.finish(db, owner, { requestId; feeVersion = 1 }, 3));
    assert complete.state == #attached and complete.uploadedBytes == input.size;
    found(complete.artifactId);
  };
  func candidate(db : Store.DB, owner : Principal, appId : Text, version : Nat, requestId : Text) : Types.Candidate {
    if (Store.getApp(db, appId) == null) {
      ignore Fixtures.ok(Catalog.save(db, owner, Fixtures.listing(appId, 0, null), 1));
    };
    let artifactId = upload(db, owner, appId, requestId # "-package", #package);
    let sourceId = upload(db, owner, appId, requestId # "-source", #source);
    Fixtures.ok(Publishing.submit(db, owner, {
      requestId; appId; version; artifactId; sourceArtifactId = ?sourceId; dependencies = []; feeVersion = 1;
    }, 4));
  };
  func entry(value : Types.Candidate) : { candidateId : Nat64; expectedDigest : Blob; expectedSourceDigest : ?Blob } {
    { candidateId = value.id; expectedDigest = value.digest; expectedSourceDigest = value.sourceDigest };
  };
  func request(values : [Types.Candidate]) : API.TrustedPublishRequest {
    {
      requestId = "trusted-batch-1";
      candidates = Array.map<Types.Candidate, { candidateId : Nat64; expectedDigest : Blob; expectedSourceDigest : ?Blob }>(values, entry);
      analysis = "Automated package/source structure and SHA-256 checks; no manual security review was performed.";
    };
  };
  func pending(db : Store.DB, value : Types.Candidate) {
    assert Store.getCandidate(db, value.id) == ?value;
    let app = found(Store.getApp(db, value.appId));
    assert app.approvedCandidate == null and not Catalog.eligible(db, app);
    assert Store.getArtifact(db, value.artifactId) != null;
    assert Store.getArtifact(db, found(value.sourceArtifactId)) != null;
  };

  public func trusted_cli_publishes_two_apps_and_exact_retry_survives_memory_rebind() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let mem = memory(publisherMemory); let db = Store.Use(mem, publisherMemory);
      assert not Access.isAdmin(db, trusted()) and not Access.isAuditor(db, trusted());
      let alpha = candidate(db, trusted(), "batch_alpha", 100, "alpha-100");
      let bravo = candidate(db, trusted(), "batch_bravo", 100, "bravo-100");
      let input = request([alpha, bravo]);
      let result = good(BatchPublishing.publish(db, trusted(), input, 10));
      assert result.batch.owner == trusted() and result.batch.publisher == trusted();
      assert result.batch.requestId == input.requestId and result.batch.analysis == input.analysis;
      assert result.batch.createdAtNs == 10 and result.batch.entries.size() == 2;
      assert result.appIds.size() == 2 and result.retiredArtifacts.size() == 0;
      for (value in result.batch.entries.vals()) {
        let saved = found(Store.getCandidate(db, value.candidateId));
        assert saved.state == #approved and saved.published;
        assert value.appId == saved.appId and value.version == saved.version;
        assert value.digest == saved.digest and value.sourceDigest == saved.sourceDigest;
        let app = found(Store.getApp(db, saved.appId));
        assert app.approvedCandidate == ?saved.id and Catalog.eligible(db, app);
        let audit = found(Store.getAudit(db, value.auditId));
        assert audit.auditor == trusted() and audit.candidateId == saved.id and audit.decision == #approved;
      };
      assert db.audits.size() == 2 and db.publishBatches.size() == 1;
      let repeated = good(BatchPublishing.publish(db, trusted(), input, 20));
      assert repeated.batch == result.batch and repeated.retiredArtifacts.size() == 0;
      assert db.audits.size() == 2 and db.publishBatches.size() == 1;
      let restored = Store.Use(mem, publisherMemory);
      assert Store.getPublishBatch(restored, trusted(), input.requestId) == ?result.batch;
      assert good(BatchPublishing.publish(restored, trusted(), input, 30)).batch == result.batch;
      assert restored.audits.size() == 2 and restored.publishBatches.size() == 1;
    });
  };

  public func trusted_successor_retires_old_bytes_and_keeps_batch_candidate_and_audit_history() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let mem = memory(publisherMemory); let db = Store.Use(mem, publisherMemory);
      let appId = "batch_successor";
      let first = candidate(db, trusted(), appId, 100, "successor-100");
      let firstInput = request([first]);
      let firstPublished = good(BatchPublishing.publish(db, trusted(), firstInput, 10));
      let oldCandidate = found(Store.getCandidate(db, first.id));
      let oldAudit = found(Store.getAudit(db, firstPublished.batch.entries[0].auditId));
      let oldPackage = found(Store.getArtifact(db, first.artifactId));
      let oldSource = found(Store.getArtifact(db, found(first.sourceArtifactId)));
      let packageUpload = found(Store.getUploadByRequest(db, trusted(), "successor-100-package"));
      let sourceUpload = found(Store.getUploadByRequest(db, trusted(), "successor-100-source"));
      assert packageUpload.candidateId == ?first.id and sourceUpload.candidateId == ?first.id;

      let second = candidate(db, trusted(), appId, 101, "successor-101");
      let newPackage = found(Store.getArtifact(db, second.artifactId));
      let newSource = found(Store.getArtifact(db, found(second.sourceArtifactId)));
      assert Store.getArtifact(db, oldPackage.id) == ?oldPackage;
      assert Store.getArtifact(db, oldSource.id) == ?oldSource;
      let secondInput = { request([second]) with requestId = "trusted-batch-successor" };
      let published = good(BatchPublishing.publish(db, trusted(), secondInput, 20));
      assert published.retiredArtifacts.size() == 2 and published.appIds == [appId];
      assert Array.find<Types.Artifact>(published.retiredArtifacts, func(value) { value.id == oldPackage.id }) == ?oldPackage;
      assert Array.find<Types.Artifact>(published.retiredArtifacts, func(value) { value.id == oldSource.id }) == ?oldSource;
      for (old in [oldPackage, oldSource].vals()) {
        assert Store.getArtifact(db, old.id) == null;
        assert Store.getArtifactByDigest(db, old.digest) == null;
        switch (Store.readBlob(db, old.content, 0, Nat64.toNat(old.size))) {
          case (#err(_)) {};
          case (#ok(_)) Runtime.trap("A retired first-party artifact still has readable blob bytes");
        };
      };
      assert Store.getArtifact(db, newPackage.id) == ?newPackage;
      assert Store.getArtifact(db, newSource.id) == ?newSource;
      assert Store.readBlob(db, newPackage.content, 0, Nat64.toNat(newPackage.size)) == #ok(Text.encodeUtf8(appId # ":successor-101-package"));
      assert Store.readBlob(db, newSource.content, 0, Nat64.toNat(newSource.size)) == #ok(Text.encodeUtf8(appId # ":successor-101-source"));
      assert found(Store.getApp(db, appId)).approvedCandidate == ?second.id;
      assert Store.getCandidate(db, first.id) == ?oldCandidate;
      assert Store.getAudit(db, oldAudit.id) == ?oldAudit;
      assert Store.getUploadByRequest(db, trusted(), packageUpload.requestId) == ?packageUpload;
      assert Store.getUploadByRequest(db, trusted(), sourceUpload.requestId) == ?sourceUpload;
      assert db.artifacts.size() == 2 and db.candidates.size() == 2 and db.audits.size() == 2 and db.publishBatches.size() == 2;

      let restored = Store.Use(mem, publisherMemory);
      let repeat = good(BatchPublishing.publish(restored, trusted(), secondInput, 30));
      assert repeat.batch == published.batch and repeat.retiredArtifacts == [] and repeat.appIds == [];
      let historical = good(BatchPublishing.publish(restored, trusted(), firstInput, 31));
      assert historical.batch == firstPublished.batch and historical.retiredArtifacts == [] and historical.appIds == [];
      assert Store.getPublishBatch(restored, trusted(), firstInput.requestId) == ?firstPublished.batch;
      assert Store.getPublishBatch(restored, trusted(), secondInput.requestId) == ?published.batch;
      assert found(Store.getApp(restored, appId)).approvedCandidate == ?second.id;
      assert Store.getCandidate(restored, first.id) == ?oldCandidate and Store.getAudit(restored, oldAudit.id) == ?oldAudit;
      assert Store.getArtifact(restored, oldPackage.id) == null and Store.getArtifact(restored, oldSource.id) == null;
      assert Store.getArtifact(restored, newPackage.id) == ?newPackage and Store.getArtifact(restored, newSource.id) == ?newSource;
      assert restored.artifacts.size() == 2 and restored.candidates.size() == 2 and restored.audits.size() == 2 and restored.publishBatches.size() == 2;
    });
  };

  public func ordinary_admin_auditor_and_removed_trusted_identity_cannot_use_batch_path() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(memory(publisherMemory), publisherMemory);
      let value = candidate(db, trusted(), "batch_roles", 100, "roles-100");
      let input = request([value]);
      for (caller in [Fixtures.owner(), Fixtures.auditor(), Fixtures.other(), Principal.fromText("2vxsx-fae")].vals()) {
        denied(BatchPublishing.publish(db, caller, input, 10));
        pending(db, value);
        assert Store.getPublishBatch(db, caller, input.requestId) == null;
      };
      Store.setTrustedPublishingPrincipal(db, null);
      denied(BatchPublishing.publish(db, trusted(), input, 11));
      pending(db, value);
      assert db.audits.size() == 0 and db.publishBatches.size() == 0;
    });
  };

  public func a_foreign_candidate_rejects_the_entire_batch_before_first_approval() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(memory(publisherMemory), publisherMemory);
      let own = candidate(db, trusted(), "batch_owned", 100, "owned-100");
      let foreign = candidate(db, Fixtures.other(), "batch_foreign", 100, "foreign-100");
      denied(BatchPublishing.publish(db, trusted(), request([own, foreign]), 10));
      pending(db, own); pending(db, foreign);
      assert db.audits.size() == 0 and db.publishBatches.size() == 0;
    });
  };

  public func last_package_or_source_digest_error_leaves_every_candidate_pending() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(memory(publisherMemory), publisherMemory);
      let alpha = candidate(db, trusted(), "batch_hash_alpha", 100, "hash-alpha");
      let bravo = candidate(db, trusted(), "batch_hash_bravo", 100, "hash-bravo");
      let base = request([alpha, bravo]);
      let wrong = Sha256.fromBlob(#sha256, "different reviewed bytes");
      for (last in [
        { entry(bravo) with expectedDigest = wrong },
        { entry(bravo) with expectedSourceDigest = ?wrong },
        { entry(bravo) with expectedSourceDigest = null },
      ].vals()) {
        denied(BatchPublishing.publish(db, trusted(), { base with candidates = [entry(alpha), last] }, 10));
        pending(db, alpha); pending(db, bravo);
        assert db.audits.size() == 0 and db.publishBatches.size() == 0;
      };
    });
  };

  public func a_saved_request_cannot_change_its_candidate_set_hashes_or_analysis() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(memory(publisherMemory), publisherMemory);
      let alpha = candidate(db, trusted(), "batch_retry_alpha", 100, "retry-alpha");
      let bravo = candidate(db, trusted(), "batch_retry_bravo", 100, "retry-bravo");
      let input = request([alpha, bravo]);
      let saved = good(BatchPublishing.publish(db, trusted(), input, 10));
      denied(BatchPublishing.publish(db, trusted(), { input with candidates = [entry(alpha)] }, 11));
      denied(BatchPublishing.publish(db, trusted(), { input with analysis = "Different retained analysis" }, 12));
      denied(BatchPublishing.publish(db, trusted(), {
        input with candidates = [entry(alpha), { entry(bravo) with expectedDigest = Sha256.fromBlob(#sha256, "different") }];
      }, 13));
      assert Store.getPublishBatch(db, trusted(), input.requestId) == ?saved.batch;
      assert db.audits.size() == 2 and db.publishBatches.size() == 1;
    });
  };

  public func duplicate_candidate_or_two_releases_of_one_app_are_rejected_without_changes() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(memory(publisherMemory), publisherMemory);
      let first = candidate(db, trusted(), "batch_duplicate", 100, "duplicate-100");
      let second = candidate(db, trusted(), "batch_duplicate", 101, "duplicate-101");
      denied(BatchPublishing.publish(db, trusted(), request([first, first]), 10));
      denied(BatchPublishing.publish(db, trusted(), request([first, second]), 11));
      pending(db, first); pending(db, second);
      assert db.audits.size() == 0 and db.publishBatches.size() == 0;
    });
  };

  public func empty_batch_request_identity_or_analysis_cannot_create_an_audit() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(memory(publisherMemory), publisherMemory);
      let value = candidate(db, trusted(), "batch_empty", 100, "empty-100");
      let input = request([value]);
      denied(BatchPublishing.publish(db, trusted(), request([]), 10));
      denied(BatchPublishing.publish(db, trusted(), { input with requestId = " \n " }, 11));
      denied(BatchPublishing.publish(db, trusted(), { input with analysis = " \n " }, 12));
      pending(db, value);
      assert db.audits.size() == 0 and db.publishBatches.size() == 0;
    });
  };

  public func automatic_analysis_is_retained_separately_from_an_assigned_auditor_review() : async Test.Metrics {
    Test.test(func () {
      let publisherMemory = PublisherStore.init();
      let db = Store.Use(memory(publisherMemory), publisherMemory);
      let automated = candidate(db, trusted(), "batch_automated", 100, "automated-100");
      let manual = candidate(db, Fixtures.owner(), "batch_manual", 100, "manual-100");
      let input = request([automated]);
      let published = good(BatchPublishing.publish(db, trusted(), input, 10));
      let automaticAudit = found(Store.getAudit(db, published.batch.entries[0].auditId));
      assert Text.contains(automaticAudit.analysis, #text(input.analysis));
      assert not Text.contains(automaticAudit.analysis, #text("Checked for malware"));
      let manualAnalysis = "Manual review: examined application behavior and reported the observed findings.";
      let reviewed = Fixtures.ok(Audits.stamp(db, Fixtures.auditor(), {
        requestId = "ordinary-manual-review"; candidateId = manual.id;
        expectedDigest = manual.digest; expectedSourceDigest = manual.sourceDigest;
        decision = #approved; analysis = manualAnalysis; reason = null;
      }, 11));
      assert reviewed.audit.auditor == Fixtures.auditor() and reviewed.audit.analysis == manualAnalysis;
      assert automaticAudit.auditor == trusted() and automaticAudit.analysis != manualAnalysis;
      assert db.audits.size() == 2 and db.publishBatches.size() == 1;
    });
  };
}
