// All rights reserved. See ../LICENSE.
import Access "../mo/Access";
import API "../mo/API";
import Encoding "../mo/Encoding";
import Store "../mo/Store";
import Types "../mo/Types";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Test "mo:test";

persistent actor {
  transient let publisher = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  transient let buyer = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
  transient let stranger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
  transient let auditor = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
  transient let browser = Principal.fromBlob(Blob.fromArray(Array.tabulate<Nat8>(29, func(i) { if (i == 28) 2 else 1 })));
  transient let token = "0000000000000000000000000000000000000000000000000000000000000001";
  transient let otherToken = "0000000000000000000000000000000000000000000000000000000000000002";
  transient let requestId = "00000000000000000000000000000001";
  transient let otherRequestId = "00000000000000000000000000000002";

  func memory() : Store.Mem {
    Store.init({
      admins = [publisher]; auditors = [auditor]; tokens = [];
      xrc = Principal.fromText("aaaaa-aa");
      fees = { version = 1; updateBase = 0; updateByte = 0; storageByteYear = 0; purchase = 0; withdraw = 0; grant = 0; xrc = 0 };
      referralTerms = { version = 1; discountBps = 1_000; affiliateBps = 3_000; developerBps = 3_000 };
    });
  };

  func stored<T>(result : { #ok : T; #err : Types.Error }) : T {
    switch (result) {
      case (#ok(value)) value;
      case (#err(error)) Runtime.trap("Access test fixture failed: " # debug_show(error));
    };
  };

  func accepted<T>(result : API.Result<T>) : T {
    switch (result) {
      case (#ok(value)) value;
      case (#err(error)) Runtime.trap("Access request unexpectedly failed: " # debug_show(error));
    };
  };

  func rejected<T>(result : API.Result<T>) {
    switch (result) {
      case (#err(_)) {};
      case (#ok(_)) Runtime.trap("Access request unexpectedly succeeded");
    };
  };

  func artifact(db : Store.DB, bytes : Blob, mediaType : Text) : Types.Artifact {
    stored(Store.insertArtifact(db, {
      digest = Encoding.hash(bytes); size = Nat64.fromNat(bytes.size()); mediaType;
      content = #bytes(bytes); publicLegacy = false; createdAtNs = 1;
    }));
  };

  type Fixture = { app : Types.App; candidate : Types.Candidate; package : Types.Artifact; source : Types.Artifact; image : Types.Artifact };

  func fixture(db : Store.DB, free : Bool) : Fixture {
    let package = artifact(db, "package-content", "application/octet-stream");
    let source = artifact(db, "offered-source-content", "application/gzip");
    let image = artifact(db, "listing-image-content", "image/png");
    let app = stored(Store.insertApp(db, {
      appId = "access_test"; owner = publisher; title = "Access test"; summary = "Test app"; description = "";
      priceUsdMicros = if (free) 0 else 1_000_000; revision = 1; approvedCandidate = null; visible = true;
      iconArtifact = ?image.id; screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 1; updatedAtNs = 1;
    }));
    let candidate = stored(Store.insertCandidate(db, {
      appId = app.appId; version = 1; publisher; requestId; listingRevision = 1;
      artifactId = package.id; sourceArtifactId = ?source.id; digest = package.digest; sourceDigest = ?source.digest;
      dependencies = []; state = #approved; published = true; createdAtNs = 1; updatedAtNs = 1;
    }));
    let linked = stored(db.apps.update({ app with approvedCandidate = ?candidate.id }));
    { app = linked; candidate; package; source; image };
  };

  func own(db : Store.DB, owner : Principal, app : Types.App) {
    ignore stored(Store.insertEntitlement(db, { owner; appId = app.appId; orderId = 1; kind = #paid; acquiredAtNs = 2 }));
  };

  func packagePath(artifact : Types.Artifact) : Text { "/repo/v1/packages/" # Encoding.hex(artifact.digest) # ".neutron" };
  func sourcePath(artifact : Types.Artifact) : Text { "/repo/v1/sources/" # Encoding.hex(artifact.digest) # ".source.v1.msgpack.gz" };
  func imagePath(artifact : Types.Artifact) : Text { "/repo/v1/media/" # Encoding.hex(artifact.digest) };
  func request(paths : [Text]) : API.RepoAccessRequest { { request_id = requestId; token; paths; fee_version = 1 } };

  public func read_delegation_is_owner_bound_and_revocable() : async Test.Metrics {
    Test.test(func() {
      let mem = memory();
      let db = Store.Use(mem);
      assert Access.isAdmin(db, publisher) and not Access.isAdmin(db, buyer);
      assert Access.isAuditor(db, auditor) and not Access.isAuditor(db, buyer);
      assert accepted(Access.readOwner(db, buyer)) == buyer;
      rejected(Access.readOwner(db, browser));
      rejected(Access.readOwner(db, Principal.fromText("2vxsx-fae")));
      ignore accepted(Access.setDelegate(db, buyer, browser, true, 10));
      assert accepted(Access.readOwner(db, browser)) == buyer;
      rejected(Access.setDelegate(db, stranger, browser, true, 11));
      rejected(Access.setDelegate(db, stranger, browser, false, 11));
      assert accepted(Access.readOwner(db, browser)) == buyer;
      rejected(Access.setDelegate(db, buyer, publisher, true, 11));
      rejected(Access.setDelegate(db, buyer, Principal.fromText("2vxsx-fae"), true, 11));
      ignore accepted(Access.setDelegate(db, buyer, browser, false, 12));
      rejected(Access.readOwner(db, browser));
      rejected(Access.setDelegate(db, stranger, browser, true, 12));
      let restored = Store.Use(mem);
      rejected(Access.readOwner(restored, browser));
      ignore accepted(Access.setDelegate(restored, buyer, browser, true, 13));
      assert accepted(Access.readOwner(restored, browser)) == buyer;
    });
  };

  public func approved_paid_artifacts_require_ownership_or_review_access() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(memory());
      let f = fixture(db, false);
      own(db, buyer, f.app);
      assert Access.canAccess(db, buyer, f.package.id, #buyer);
      assert Access.canAccess(db, buyer, f.source.id, #buyer);
      assert not Access.canAccess(db, stranger, f.package.id, #buyer);
      assert not Access.canAccess(db, stranger, f.source.id, #buyer);
      assert Access.canAccess(db, publisher, f.package.id, #publisher);
      assert Access.canAccess(db, auditor, f.source.id, #auditor);
      assert not Access.canAccess(db, stranger, f.package.id, #publisher);
      assert not Access.canAccess(db, buyer, f.package.id, #auditor);
      assert not Access.publicArtifact(db, f.package.id);
      assert not Access.publicArtifact(db, f.source.id);
      assert not Access.authorizeHttp(db, packagePath(f.package), null);
      assert not Access.authorizeHttp(db, sourcePath(f.source), null);
      rejected(Access.grant(db, stranger, request([packagePath(f.package)]), #buyer, 3));
      ignore stored(db.apps.update({ f.app with visible = false }));
      assert Access.canAccess(db, buyer, f.package.id, #buyer);
      assert Access.canAccess(db, buyer, f.source.id, #buyer);
      let ?resolved = Access.resolveArtifactPath(db, packagePath(f.package)) else Runtime.trap("Package path was not resolved");
      assert resolved.artifact.id == f.package.id and resolved.purpose == #package;
      let ?offeredSource = Access.resolveArtifactPath(db, sourcePath(f.source)) else Runtime.trap("Source path was not resolved");
      assert offeredSource.artifact.id == f.source.id and offeredSource.purpose == #source;
    });
  };

  public func revocation_stops_buyer_downloads_without_hiding_review_material() : async Test.Metrics {
    Test.test(func() {
      let mem = memory();
      let db = Store.Use(mem);
      let f = fixture(db, false);
      own(db, buyer, f.app);
      ignore accepted(Access.grant(db, buyer, request([packagePath(f.package), sourcePath(f.source)]), #buyer, 10));
      assert Access.authorizeHttp(db, packagePath(f.package), ?token);
      ignore stored(db.candidates.update({ f.candidate with state = #revoked; updatedAtNs = 11 }));
      assert not Access.canAccess(db, buyer, f.package.id, #buyer);
      assert not Access.canAccess(db, buyer, f.source.id, #buyer);
      assert not Access.authorizeHttp(db, packagePath(f.package), ?token);
      assert not Access.authorizeHttp(db, sourcePath(f.source), ?token);
      assert Access.canAccess(db, publisher, f.package.id, #publisher);
      assert Access.canAccess(db, auditor, f.source.id, #auditor);
      assert Store.getEntitlement(Store.Use(mem), buyer, f.app.appId) != null;
      let review = { request([packagePath(f.package)]) with token = otherToken; request_id = otherRequestId };
      ignore accepted(Access.grant(db, auditor, review, #auditor, 12));
      assert Access.authorizeHttp(db, packagePath(f.package), ?otherToken);
      Store.setConfig(db, { Store.config(db) with auditors = [] });
      assert not Access.authorizeHttp(db, packagePath(f.package), ?otherToken);
    });
  };

  public func public_free_downloads_and_media_follow_listing_eligibility() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(memory());
      let f = fixture(db, true);
      let orphan = artifact(db, "unlinked-image", "image/png");
      assert Access.publicArtifact(db, f.package.id);
      assert Access.publicArtifact(db, f.source.id);
      assert Access.publicArtifact(db, f.image.id);
      assert Access.authorizeHttp(db, packagePath(f.package), null);
      assert Access.authorizeHttp(db, imagePath(f.image), null);
      assert not Access.publicArtifact(db, orphan.id);
      assert not Access.authorizeHttp(db, imagePath(orphan), null);
      ignore stored(db.apps.update({ f.app with visible = false }));
      assert not Access.publicArtifact(db, f.package.id);
      assert not Access.publicArtifact(db, f.image.id);
      assert not Access.authorizeHttp(db, imagePath(f.image), null);
      ignore stored(db.apps.update(f.app));
      ignore stored(db.candidates.update({ f.candidate with state = #pending; published = false }));
      assert not Access.publicArtifact(db, f.package.id);
      assert not Access.publicArtifact(db, f.source.id);
      assert not Access.publicArtifact(db, f.image.id);
    });
  };

  public func auditors_read_images_bound_to_retained_candidate_listings() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(memory());
      let f = fixture(db, false);
      let unrelated = artifact(db, "new-unsubmitted-image", "image/png");
      ignore stored(db.candidates.update({ f.candidate with state = #pending; published = false }));
      ignore stored(Store.insertListing(db, {
        appId = f.app.appId; revision = 1; owner = publisher; title = f.app.title;
        summary = f.app.summary; description = f.app.description; priceUsdMicros = f.app.priceUsdMicros;
        iconArtifact = ?f.image.id; screenshots = []; createdAtNs = 1;
      }));
      for ((image, id) in [(f.image, requestId), (unrelated, otherRequestId)].vals()) {
        let charge = stored(Store.insertCharge(db, {
          owner = publisher; requestId = id; method = "upload_begin"; feeVersion = 1;
          cycles = 0; processingCycles = 0; storageCycles = 0; coveredBytes = image.size;
          coverageFromNs = 1; coverageUntilNs = 31_536_000_000_000_001; createdAtNs = 1;
        }));
        ignore stored(Store.insertUpload(db, {
          owner = publisher; requestId = id; appId = f.app.appId; digest = image.digest;
          size = image.size; mediaType = image.mediaType; purpose = #image;
          ticket = { upload = image.content }; hashState = null; chargeId = charge.id;
          state = #attached; artifactId = ?image.id; createdAtNs = 1; updatedAtNs = 2;
        }));
      };
      assert not Access.publicArtifact(db, f.image.id);
      assert not Access.authorizeHttp(db, imagePath(f.image), null);
      assert not Access.canAccess(db, stranger, f.image.id, #buyer);
      assert not Access.canAccess(db, stranger, f.image.id, #publisher);
      assert not Access.canAccess(db, stranger, f.image.id, #auditor);
      assert Access.canAccess(db, publisher, f.image.id, #publisher);
      assert Access.canAccess(db, publisher, unrelated.id, #publisher);
      assert Access.canAccess(db, auditor, f.image.id, #auditor);
      assert not Access.canAccess(db, auditor, unrelated.id, #auditor);
      ignore accepted(Access.grant(db, auditor, request([imagePath(f.image)]), #auditor, 3));
      assert Access.authorizeHttp(db, imagePath(f.image), ?token);

      // A publisher editing the current listing must not erase the evidence
      // associated with the older candidate that the auditor is reviewing.
      ignore stored(Store.insertListing(db, {
        appId = f.app.appId; revision = 2; owner = publisher; title = f.app.title;
        summary = f.app.summary; description = f.app.description; priceUsdMicros = f.app.priceUsdMicros;
        iconArtifact = ?unrelated.id; screenshots = []; createdAtNs = 4;
      }));
      ignore stored(db.apps.update({ f.app with revision = 2; iconArtifact = ?unrelated.id; updatedAtNs = 4 }));
      assert Access.canAccess(db, auditor, f.image.id, #auditor);
      assert Access.authorizeHttp(db, imagePath(f.image), ?token);
      assert not Access.publicArtifact(db, f.image.id);
      assert not Access.canAccess(db, auditor, unrelated.id, #auditor);
      assert not Access.authorizeHttp(db, imagePath(unrelated), ?token);
    });
  };

  public func publisher_grants_combine_owned_drafts_with_purchased_releases() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(memory());
      let purchased = fixture(db, false);
      own(db, buyer, purchased.app);
      let draftPackage = artifact(db, "buyers-unapproved-package", "application/octet-stream");
      let draftApp = stored(Store.insertApp(db, {
        appId = "buyers_draft"; owner = buyer; title = "My draft"; summary = "Pending review"; description = "";
        priceUsdMicros = 1_000_000; revision = 1; approvedCandidate = null; visible = false;
        iconArtifact = null; screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 1; updatedAtNs = 1;
      }));
      ignore stored(Store.insertCandidate(db, {
        appId = draftApp.appId; version = 1; publisher = buyer; requestId = otherRequestId; listingRevision = 1;
        artifactId = draftPackage.id; sourceArtifactId = null; digest = draftPackage.digest; sourceDigest = null;
        dependencies = []; state = #pending; published = false; createdAtNs = 1; updatedAtNs = 1;
      }));
      let paths = [packagePath(purchased.package), packagePath(draftPackage)];
      ignore accepted(Access.grant(db, buyer, request(paths), #publisher, 3));
      assert Access.authorizeHttp(db, paths[0], ?token);
      assert Access.authorizeHttp(db, paths[1], ?token);
      assert Access.canAccess(db, buyer, purchased.package.id, #publisher);
      assert Access.canAccess(db, buyer, draftPackage.id, #publisher);
      let another = { request(paths) with request_id = otherRequestId; token = otherToken };
      rejected(Access.grant(db, buyer, another, #buyer, 4));
      rejected(Access.grant(db, stranger, another, #publisher, 4));
      rejected(Access.grant(db, buyer, another, #auditor, 4));
      assert not Access.canAccess(db, stranger, purchased.package.id, #publisher);
      assert not Access.canAccess(db, stranger, draftPackage.id, #publisher);
      assert not Access.canAccess(db, buyer, purchased.package.id, #auditor);
      assert db.grants.size() == 1;
    });
  };

  public func grants_preserve_exact_retry_intent_and_credential_ownership() : async Test.Metrics {
    Test.test(func() {
      let mem = memory();
      let db = Store.Use(mem);
      let f = fixture(db, false);
      own(db, buyer, f.app);
      own(db, stranger, f.app);
      let input = request([packagePath(f.package)]);
      let first = accepted(Access.grant(db, buyer, input, #buyer, 10));
      assert first.new;
      let retry = accepted(Access.grant(Store.Use(mem), buyer, input, #buyer, 20));
      assert not retry.new and retry.grant == first.grant;
      assert db.grants.size() == 1;
      rejected(Access.grant(db, buyer, { input with token = otherToken }, #buyer, 21));
      rejected(Access.grant(db, buyer, { input with paths = [sourcePath(f.source)] }, #buyer, 21));
      rejected(Access.grant(db, stranger, { input with request_id = otherRequestId }, #buyer, 21));
      assert Access.authorizeHttp(db, packagePath(f.package), ?token);
      assert not Access.authorizeHttp(db, sourcePath(f.source), ?token);
      assert not Access.authorizeHttp(db, packagePath(f.package), ?otherToken);
      assert db.grants.size() == 1;
      ignore stored(db.grants.update({ first.grant with revoked = true; updatedAtNs = 22 }));
      assert not Access.authorizeHttp(db, packagePath(f.package), ?token);
    });
  };

  public func malformed_or_mixed_authorization_requests_create_no_partial_grant() : async Test.Metrics {
    Test.test(func() {
      let db = Store.Use(memory());
      let f = fixture(db, false);
      own(db, buyer, f.app);
      let orphan = artifact(db, "another-unlinked-image", "image/png");
      let input = request([packagePath(f.package)]);
      rejected(Access.grant(db, buyer, { input with token = "short" }, #buyer, 10));
      rejected(Access.grant(db, buyer, { input with request_id = "short" }, #buyer, 10));
      rejected(Access.grant(db, Principal.fromText("2vxsx-fae"), input, #buyer, 10));
      rejected(Access.grant(db, buyer, { input with paths = [packagePath(f.package), imagePath(orphan)] }, #buyer, 10));
      rejected(Access.grant(db, buyer, { input with paths = [imagePath(f.package)] }, #buyer, 10));
      rejected(Access.grant(db, buyer, { input with paths = [packagePath(f.source)] }, #buyer, 10));
      rejected(Access.grant(db, buyer, { input with paths = ["/repo/v1/packages/../media/" # Encoding.hex(f.image.digest)] }, #buyer, 10));
      assert Access.resolveArtifactPath(db, "/repo/v1/packages/" # Encoding.hex(f.package.digest)) == null;
      assert Access.resolveArtifactPath(db, packagePath(f.package) # "?download=1") == null;
      assert Access.resolveArtifactPath(db, packagePath(f.package) # "/suffix") == null;
      assert not Access.authorizeHttp(db, imagePath(orphan), ?token);
      assert db.grants.size() == 0;
    });
  };
}
