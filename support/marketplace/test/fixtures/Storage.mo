// All rights reserved. See ../../LICENSE.
import Principal "mo:core/Principal";
import Iter "mo:core/Iter";
import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Store "../../mo/Store";
import Types "../../mo/Types";

persistent actor {
  transient let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  let mem = Store.init({ admins = [owner]; auditors = [owner]; tokens = []; xrc = owner;
    fees = { version = 1; updateBase = 12; updateByte = 2; storageByteYear = 3; purchase = 4; withdraw = 5; grant = 6; xrc = 7 };
    referralTerms = { version = 1; discountBps = 1_000; affiliateBps = 3_000; developerBps = 3_000 } });
  transient let db = Store.Use(mem);
  var seeded = false;
  func require<T,E>(r : Result.Result<T,E>) : T { switch (r) { case (#ok(v)) v; case (#err(_)) Runtime.trap("Fixture setup failed") } };

  public func seed() : async () {
    assert not seeded;
    let ticket = require(Store.beginBlob(db, 8));
    assert require(Store.appendBlob(db, ticket, 0, "abcd")) == 4;
    ignore require(db.apps.insert({ appId = "test-app"; owner = owner; title = "title-fixture"; summary = "summary-fixture"; description = "description-fixture"; priceUsdMicros = 1; revision = 1; approvedCandidate = ?1; visible = true; iconArtifact = null; screenshots = []; ratingCount = 1; ratingTotal = 1; createdAtNs = 1; updatedAtNs = 1 }));
    ignore require(db.listings.insert({ appId = "test-app"; revision = 1; owner = owner; title = "title-fixture"; summary = "summary-fixture"; description = "description-fixture"; priceUsdMicros = 1; iconArtifact = null; screenshots = []; createdAtNs = 1 }));
    ignore require(db.candidates.insert({ appId = "test-app"; version = 1; publisher = owner; requestId = "requestId-fixture"; listingRevision = 1; artifactId = 1; sourceArtifactId = ?1; digest = "digest-bytes"; sourceDigest = null; dependencies = [{ appId = "dependency-app"; minVersion = 2 }]; state = #approved; published = true; createdAtNs = 1; updatedAtNs = 1 }));
    ignore require(db.artifacts.insert({ digest = "digest-bytes"; size = 1; mediaType = "mediaType-fixture"; content = #bytes("owned bytes"); publicLegacy = false; createdAtNs = 1 }));
    ignore require(db.audits.insert({ auditor = owner; requestId = "requestId-fixture"; candidateId = 1; decision = #approved; analysis = "analysis-fixture"; reason = null; createdAtNs = 1 }));
    ignore require(db.delegates.insert({ browser = owner; owner = owner; active = false; createdAtNs = 1; updatedAtNs = 1 }));
    ignore require(db.grants.insert({ owner = owner; requestId = "requestId-fixture"; credentialHash = "credentialHash-bytes"; authorizationHash = "authorizationHash-bytes"; paths = ["/repo/v1/packages/package.neutron"]; delegate = ?owner; artifactIds = [1]; purpose = #buyer; revoked = false; createdAtNs = 1; updatedAtNs = 1 }));
    ignore require(db.manifests.insert({ owner = owner; requestId = "requestId-fixture"; manifestId = "manifestId-fixture"; content = "{\"version\":1}"; digest = "digest-bytes"; candidateIds = [1]; createdAtNs = 1 }));
    ignore require(db.orders.insert({ owner = owner; requestId = "requestId-fixture"; intentHash = "intentHash-bytes"; quoteCommitment = "quoteCommitment-bytes"; ledger = owner; amount = 1; fee = 1; affiliate = null; rateId = 1; items = []; state = #outcome_unknown; currentAttempt = ?1; createdAtNs = 1; updatedAtNs = 1; finalizedAtNs = null; lastError = null }));
    ignore require(db.quoteRecords.insert({ owner = owner; requestId = "requestId-fixture"; kind = #purchase; commitment = "commitment-bytes"; content = "content-bytes"; createdAtNs = 1 }));
    ignore require(db.withdrawals.insert({ owner = owner; requestId = "requestId-fixture"; intentHash = "intentHash-bytes"; ledger = owner; to = { owner = owner; subaccount = null }; totalDebit = 1; fee = 1; isBurn = false; state = #outcome_unknown; currentAttempt = ?1; createdAtNs = 1; updatedAtNs = 1; finalizedAtNs = null; lastError = null }));
    ignore require(db.attempts.insert({ owner = owner; operationKind = #purchase; operationId = 1; ordinal = 1; request = { kind = #transfer; ledger = owner; spenderSubaccount = null; to = { owner = owner; subaccount = null }; amount = 1; fee = 1; memo = "memo-bytes"; createdAtTimeNs = 1; fromAccount = { owner = owner; subaccount = null } }; state = #outcome_unknown; hadUnknown = true; block = null; duplicate = false; lastLedgerError = ?"retained-ledger-error"; lastError = ?"reply interrupted"; createdAtNs = 1; updatedAtNs = 1 }));
    ignore require(db.credits.insert({ ledger = owner; owner = owner; isBurn = false; available = 1; reserved = 1; updatedAtNs = 1 }));
    ignore require(db.claims.insert({ owner = owner; appId = "test-app"; orderId = 1; createdAtNs = 1 }));
    ignore require(db.entitlements.insert({ owner = owner; appId = "test-app"; orderId = 1; kind = #free; acquiredAtNs = 1 }));
    ignore require(db.acquisitions.insert({ owner = owner; appId = "test-app"; orderId = 1; kind = #free; atNs = 1; paidAtoms = 1; ledger = null; block = null }));
    ignore require(db.rankings.insert({ appId = "test-app"; free7 = 4; free30 = 8; freeAll = 10; paid7 = 1; paid30 = 1; paidAll = 1; eligible = true; isFree = true }));
    ignore require(db.referrals.insert({ owner = owner; code = "code-fixture"; createdAtNs = 1 }));
    ignore require(db.ratings.insert({ owner = owner; appId = "test-app"; stars = 4; review = "Useful app"; createdAtNs = 1; updatedAtNs = 1 }));
    ignore require(db.rates.insert({ ledger = owner; symbol = "symbol-fixture"; usdRate = 1; decimals = 1; observedAtNs = 1; refreshedAtNs = 1; lastError = null }));
    ignore require(db.uploads.insert({ owner = owner; requestId = "requestId-fixture"; appId = "test-app"; digest = "digest-bytes"; size = 8; mediaType = "mediaType-fixture"; purpose = #package; ticket = ticket; hashState = ?"persisted-sha256-state"; chargeId = 1; state = #uploading; artifactId = null; createdAtNs = 1; updatedAtNs = 1 }));
    ignore require(db.charges.insert({ owner = owner; requestId = "requestId-fixture"; method = "method-fixture"; feeVersion = 1; cycles = 1; processingCycles = 1; storageCycles = 1; coveredBytes = 1; coverageFromNs = 1; coverageUntilNs = 1; createdAtNs = 1 }));
    ignore require(db.jobs.insert({ key = "key-fixture"; kind = #xrc; ledger = null; scheduledAtNs = 1; state = #waiting; operationId = ?1; attempts = 1; lastError = ?"source unavailable"; updatedAtNs = 1 }));
    assert Store.allocateReferralCodeId(db) == 1;
    Store.setRankingMaintenance(db, { expiry7 = ?{atNs = 20; id = 0}; expiry30 = null; generation = 2; asOfNs = 21; dirty = true; charts = { free7 = [{ appId = "test-app"; score = 4 }]; free30 = []; freeAll = []; paid7 = []; paid30 = []; paidAll = [] } });
    seeded := true;
  };

  public query func snapshot() : async Blob {
    to_candid({
      singleton = db.store.get();
      apps = Iter.toArray(db.apps.iterPrimary(#fwd, null));
      listings = Iter.toArray(db.listings.iterPrimary(#fwd, null));
      candidates = Iter.toArray(db.candidates.iterPrimary(#fwd, null));
      artifacts = Iter.toArray(db.artifacts.iterPrimary(#fwd, null));
      audits = Iter.toArray(db.audits.iterPrimary(#fwd, null));
      delegates = Iter.toArray(db.delegates.iterPrimary(#fwd, null));
      grants = Iter.toArray(db.grants.iterPrimary(#fwd, null));
      manifests = Iter.toArray(db.manifests.iterPrimary(#fwd, null));
      orders = Iter.toArray(db.orders.iterPrimary(#fwd, null));
      quoteRecords = Iter.toArray(db.quoteRecords.iterPrimary(#fwd, null));
      withdrawals = Iter.toArray(db.withdrawals.iterPrimary(#fwd, null));
      attempts = Iter.toArray(db.attempts.iterPrimary(#fwd, null));
      credits = Iter.toArray(db.credits.iterPrimary(#fwd, null));
      claims = Iter.toArray(db.claims.iterPrimary(#fwd, null));
      entitlements = Iter.toArray(db.entitlements.iterPrimary(#fwd, null));
      acquisitions = Iter.toArray(db.acquisitions.iterPrimary(#fwd, null));
      rankings = Iter.toArray(db.rankings.iterPrimary(#fwd, null));
      referrals = Iter.toArray(db.referrals.iterPrimary(#fwd, null));
      ratings = Iter.toArray(db.ratings.iterPrimary(#fwd, null));
      rates = Iter.toArray(db.rates.iterPrimary(#fwd, null));
      uploads = Iter.toArray(db.uploads.iterPrimary(#fwd, null));
      charges = Iter.toArray(db.charges.iterPrimary(#fwd, null));
      jobs = Iter.toArray(db.jobs.iterPrimary(#fwd, null));
    });
  };

  public query func validateIndexesAndBytes() : async Bool {
    let ?app = Store.getApp(db, "test-app") else return false;
    let ?attempt = Store.getAttempt(db, 1) else return false;
    let ?artifact = Store.getArtifact(db, 1) else return false;
    if (app.id != 1 or not app.visible or not attempt.hadUnknown or attempt.state != #outcome_unknown) return false;
    if (Store.readBlob(db, artifact.content, 0, 11) != #ok("owned bytes")) return false;
    if (not db.candidates.by_source_artifact.exists(1)) return false;
    if (not db.candidates.by_state.exists(#approved)) return false;
    if (not db.rankings.by_free7.exists((4, "test-app"))) return false;
    true;
  };

  public func finishPending() : async Blob {
    let ?upload = Store.getUpload(db, 1) else Runtime.trap("Pending upload missing");
    let info = require(Store.blobUploadInfo(db, upload.ticket));
    assert info.written == 4 and info.expiresAt == 0;
    assert require(Store.appendBlob(db, upload.ticket, 0, "abcd")) == 4;
    assert require(Store.appendBlob(db, upload.ticket, 4, "efgh")) == 8;
    let artifact = require(Store.insertArtifact(db, { digest = "new-digest"; size = 8; mediaType = "application/octet-stream"; content = #upload(upload.ticket); publicLegacy = false; createdAtNs = 10 }));
    require(Store.readBlob(db, artifact.content, 0, 8));
  };

  public func nextReferralCode() : async Nat64 { Store.allocateReferralCodeId(db) };
};
