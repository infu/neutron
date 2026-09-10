import Test "mo:test";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Sha256 "mo:sha2/Sha256";
import API "../mo/API";
import Assets "../mo/Assets";
import Billing "../mo/Billing";
import Store "../mo/Store";
import Types "../mo/Types";

persistent actor {
  func owner() : Principal { Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai") };
  func other() : Principal { Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai") };
  func must<T>(result : API.Result<T>) : T {
    switch (result) { case (#ok(value)) value; case (#err(e)) Runtime.trap(debug_show(e)) };
  };
  func memory() : Store.Mem {
    let mem = Store.init({
      admins = []; auditors = []; tokens = []; xrc = Principal.fromText("aaaaa-aa");
      fees = { version = 1; updateBase = 10; updateByte = 2; storageByteYear = 3; purchase = 10; withdraw = 10; grant = 10; xrc = 10 };
      referralTerms = { version = 1; discountBps = 1_000; affiliateBps = 3_000; developerBps = 3_000 };
    });
    let app : Types.CreateApp = {
      appId = "hello"; owner = owner(); title = "Hello"; summary = "Test app"; description = "";
      priceUsdMicros = 1_000_000; revision = 1; approvedCandidate = null; visible = false;
      iconArtifact = null; screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 0; updatedAtNs = 0;
    };
    switch (Store.insertApp(Store.Use(mem), app)) { case (#ok(_)) {}; case (#err(e)) Runtime.trap(debug_show(e)) };
    mem;
  };
  func input(requestId : Text) : API.UploadBegin {
    { requestId; appId = "hello"; digest = Sha256.fromBlob(#sha256, "abcdef"); size = 6;
      mediaType = "application/octet-stream"; purpose = #package; feeVersion = 1 };
  };
  func start(db : Store.DB, request : API.UploadBegin) : API.UploadStatus {
    let bytes = must(Assets.estimateNewStorage(db, owner(), request));
    must(Assets.begin(db, owner(), request, Billing.quote(Store.config(db).fees, #upload, 1, bytes), 10));
  };

  public func hash_progress_survives_reconstruction_and_retransmission() : async Test.Metrics {
    Test.test(func () {
      let mem = memory();
      let db = Store.Use(mem);
      let first = start(db, input("file"));
      assert first.uploadedBytes == 0 and first.charge.coveredBytes == 6;
      assert must(Assets.chunk(db, owner(), { requestId = "file"; offset = 0; bytes = "abc"; feeVersion = 1 }, 11)).uploadedBytes == 3;
      let restored = Store.Use(mem);
      assert must(Assets.status(restored, owner(), "file")).uploadedBytes == 3;
      assert must(Assets.chunk(restored, owner(), { requestId = "file"; offset = 0; bytes = "abc"; feeVersion = 1 }, 12)).uploadedBytes == 3;
      switch (Assets.chunk(restored, owner(), { requestId = "file"; offset = 0; bytes = "xxx"; feeVersion = 1 }, 13)) { case (#err(_)) {}; case (_) assert false };
      switch (Assets.finish(restored, owner(), { requestId = "file"; feeVersion = 1 }, 14)) { case (#err(e)) assert e.code == "upload_incomplete"; case (_) assert false };
      assert must(Assets.chunk(restored, owner(), { requestId = "file"; offset = 3; bytes = "def"; feeVersion = 1 }, 15)).uploadedBytes == 6;
      let completed = must(Assets.finish(restored, owner(), { requestId = "file"; feeVersion = 1 }, 16));
      assert completed.state == #attached and completed.uploadedBytes == 6;
      assert must(Assets.finish(Store.Use(mem), owner(), { requestId = "file"; feeVersion = 1 }, 17)) == completed;
      assert start(restored, input("file")) == completed;
      assert restored.uploads.size() == 1 and restored.charges.size() == 1 and restored.artifacts.size() == 1;
      let ?artifactId = completed.artifactId else Runtime.trap("Artifact missing");
      let ?artifact = Store.getArtifact(restored, artifactId) else Runtime.trap("Artifact missing");
      assert Store.readBlob(restored, artifact.content, 1, 3) == #ok("bcd");
      assert must(Assets.chunk(restored, owner(), { requestId = "file"; offset = 3; bytes = "def"; feeVersion = 1 }, 18)) == completed;
      switch (Assets.chunk(restored, owner(), { requestId = "file"; offset = 3; bytes = "xyz"; feeVersion = 1 }, 19)) { case (#err(e)) assert e.code == "upload_conflict"; case (_) assert false };
    });
  };

  public func upload_intent_and_ownership_are_preserved() : async Test.Metrics {
    Test.test(func () {
      let db = Store.Use(memory());
      ignore start(db, input("owned"));
      switch (Assets.estimateNewStorage(db, owner(), { input("owned") with size = 7 })) { case (#err(e)) assert e.code == "request_conflict"; case (_) assert false };
      switch (Assets.estimateNewStorage(db, other(), input("other"))) { case (#err(e)) assert e.code == "publisher_required"; case (_) assert false };
      switch (Assets.status(db, other(), "owned")) { case (#err(e)) assert e.code == "upload_missing"; case (_) assert false };
      switch (Assets.chunk(db, other(), { requestId = "owned"; offset = 0; bytes = "abcdef"; feeVersion = 1 }, 11)) { case (#err(e)) assert e.code == "upload_missing"; case (_) assert false };
      assert must(Assets.status(db, owner(), "owned")).uploadedBytes == 0;
      assert db.uploads.size() == 1 and db.charges.size() == 1;
    });
  };

  public func a_declared_digest_does_not_grant_an_existing_private_artifact() : async Test.Metrics {
    Test.test(func () {
      let db = Store.Use(memory());
      ignore start(db, input("original"));
      ignore must(Assets.chunk(db, owner(), { requestId = "original"; offset = 0; bytes = "abcdef"; feeVersion = 1 }, 11));
      let original = must(Assets.finish(db, owner(), { requestId = "original"; feeVersion = 1 }, 12));
      assert must(Assets.estimateNewStorage(db, owner(), input("duplicate"))) == 6;
      let duplicate = start(db, input("duplicate"));
      assert duplicate.artifactId == null and duplicate.uploadedBytes == 0;
      ignore must(Assets.chunk(db, owner(), { requestId = "duplicate"; offset = 0; bytes = "abcdef"; feeVersion = 1 }, 13));
      let attached = must(Assets.finish(db, owner(), { requestId = "duplicate"; feeVersion = 1 }, 14));
      assert attached.artifactId == original.artifactId;
      assert db.uploads.size() == 2 and db.artifacts.size() == 1;
      assert db.blobs.stats().stagedFiles == 0 and db.blobs.stats().liveFiles == 1;
    });
  };

  public func wrong_digest_never_attaches_unverified_bytes() : async Test.Metrics {
    Test.test(func () {
      let db = Store.Use(memory());
      ignore start(db, input("bad"));
      ignore must(Assets.chunk(db, owner(), { requestId = "bad"; offset = 0; bytes = "ghijkl"; feeVersion = 1 }, 11));
      switch (Assets.finish(db, owner(), { requestId = "bad"; feeVersion = 1 }, 12)) { case (#err(e)) assert e.code == "digest_mismatch"; case (_) assert false };
      assert db.artifacts.size() == 0;
      let saved = must(Assets.status(db, owner(), "bad"));
      assert saved.state == #uploading and saved.artifactId == null and saved.uploadedBytes == 6;
    });
  };
};
