// All rights reserved. See ../../LICENSE.
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Sha256 "mo:sha2/Sha256";
import Access "../../mo/Access";
import Audits "../../mo/Audits";
import Catalog "../../mo/Catalog";
import Publishing "../../mo/Publishing";
import Store "../../mo/Store";
import Types "../../mo/Types";
import F "../motoko/Fixtures";

persistent actor {
  let memory = F.memory();
  transient let db = Store.Use(memory);
  var phase : Nat = 0;
  var seeded = false;
  var candidates : [Types.Candidate] = [];
  var retired : [Types.Artifact] = [];
  var untouched : ?Types.Artifact = null;
  var gallery : ?Types.Artifact = null;
  var recycled : ?Types.Artifact = null;
  var freshSource : ?Types.Artifact = null;

  func artifact(id : Nat64) : Types.Artifact {
    let ?value = Store.getArtifact(db, id) else Runtime.trap("Fixture artifact missing");
    value;
  };
  func source(candidate : Types.Candidate) : Types.Artifact {
    let ?id = candidate.sourceArtifactId else Runtime.trap("Fixture source missing");
    artifact(id);
  };
  func attach(appId : Text, requestId : Text, value : Types.Artifact, purpose : { #package; #source; #image }) {
    let existing = switch (db.uploads.by_artifact.rangeIter({ gt = null; gte = ?value.id; lt = null; lte = ?value.id; dir = #fwd }, null).next()) {
      case (?upload) upload;
      case null Runtime.trap("Fixture completed upload missing");
    };
    ignore F.stored(Store.insertUpload(db, {
      owner = F.owner(); requestId; appId; digest = value.digest; size = value.size;
      mediaType = value.mediaType; purpose; ticket = existing.ticket; hashState = null;
      chargeId = existing.chargeId; state = #attached; artifactId = ?value.id;
      candidateId = null;
      createdAtNs = 1; updatedAtNs = 1;
    }));
  };
  func withSource(appId : Text, version : Nat, requestId : Text, value : Types.Artifact) : Types.Candidate {
    let package = F.upload(db, appId, requestId # "package", #package);
    attach(appId, requestId # "source", value, #source);
    F.ok(Publishing.submit(db, F.owner(), {
      requestId; appId; version; artifactId = package.id; sourceArtifactId = ?value.id;
      dependencies = []; feeVersion = 1;
    }, 2));
  };
  func keepRetired(values : [Types.Artifact]) {
    retired := Array.concat(retired, values);
  };
  func stats() : { liveBytes : Nat64; freeBlocks : Nat64; liveFiles : Nat64 } {
    let value = db.blobs.stats();
    { liveBytes = value.liveBytes; freeBlocks = value.freeBlocks; liveFiles = value.liveFiles };
  };
  func readMatches(value : Types.Artifact) : Bool {
    switch (Store.readBlob(db, value.content, 0, Nat64.toNat(value.size))) {
      case (#ok(bytes)) bytes.size() == Nat64.toNat(value.size) and Sha256.fromBlob(#sha256, bytes) == value.digest;
      case (#err(_)) false;
    };
  };
  func verifyRetired() : Bool {
    for (value in retired.vals()) {
      if (Store.getArtifact(db, value.id) != null or Store.getArtifactByDigest(db, value.digest) != null) return false;
      switch (Store.readBlob(db, value.content, 0, Nat64.toNat(value.size))) {
        case (#ok(_)) return false;
        case (#err(_)) {};
      };
      if (Access.resolveArtifactPath(db, Access.artifactPath(value, #package)) != null) return false;
      if (Access.resolveArtifactPath(db, Access.artifactPath(value, #source)) != null) return false;
    };
    true;
  };

  public func seed() : async { liveBytes : Nat64; freeBlocks : Nat64; liveFiles : Nat64 } {
    assert not seeded;
    ignore F.draft(db, "alpha", 1_000_000);
    ignore F.draft(db, "beta", 0);
    ignore F.draft(db, "gallery", 0);
    let alpha100 = F.candidate(db, "alpha", 100, "alpha100");
    assert F.approve(db, alpha100, "approve-alpha100").retiredArtifacts.size() == 0;
    let sharedSource = source(alpha100);
    let beta100 = withSource("beta", 100, "beta100", sharedSource);
    assert F.approve(db, beta100, "approve-beta100").retiredArtifacts.size() == 0;
    // A byte-identical source can also be a referenced image. Its listing
    // reference must keep it alive after its package is superseded.
    let image = F.upload(db, "gallery", "gallery-image", #image);
    ignore F.ok(Catalog.save(db, F.owner(), {
      F.listing("gallery", 0, ?1) with iconArtifact = ?image.id;
    }, 3));
    let alpha101 = withSource("alpha", 101, "alpha101", image);
    let alpha102 = withSource("alpha", 102, "alpha102", sharedSource);
    let beta101 = F.candidate(db, "beta", 101, "beta101");
    untouched := ?F.upload(db, "alpha", "completed-not-submitted", #source);
    gallery := ?image;
    candidates := [alpha100, beta100, alpha101, alpha102, beta101];
    // Acquisition and accounting rows are deliberately unrelated to blob
    // lifetime, and must survive retirement and upgrade without rewrites.
    ignore F.stored(Store.insertOrder(db, {
      owner = F.owner(); requestId = "existing-purchase"; intentHash = "intent";
      quoteCommitment = "quote"; ledger = F.other(); amount = 100; fee = 10;
      affiliate = null; rateId = 1; items = []; state = #complete; currentAttempt = null;
      createdAtNs = 1; updatedAtNs = 1; finalizedAtNs = ?1; lastError = null;
    }));
    ignore F.stored(Store.insertEntitlement(db, {
      owner = F.owner(); appId = "alpha"; orderId = 1; kind = #paid; acquiredAtNs = 1;
    }));
    seeded := true;
    stats();
  };

  public func approveNext() : async {
    phase : Nat; retiredCount : Nat; retiredBytes : Nat64;
    liveBytes : Nat64; freeBlocks : Nat64; liveFiles : Nat64;
  } {
    assert seeded and phase < 4;
    let candidate = switch (phase) {
      case (0) candidates[2];
      case (1) candidates[4];
      case (2) candidates[3];
      case (_) {
        let next = F.candidate(db, "alpha", 103, "alpha103");
        candidates := Array.concat(candidates, [next]);
        next;
      };
    };
    let result = F.approve(db, candidate, "phase-" # debug_show(phase));
    var retiredBytes : Nat64 = 0;
    for (value in result.retiredArtifacts.vals()) retiredBytes += value.size;
    keepRetired(result.retiredArtifacts);
    phase += 1;
    { stats() with phase; retiredCount = result.retiredArtifacts.size(); retiredBytes };
  };

  public query func verify() : async Bool {
    if (not seeded or not verifyRetired()) return false;
    let ?unused = untouched else return false;
    let ?image = gallery else return false;
    if (Store.getArtifact(db, unused.id) == null or not readMatches(unused)) return false;
    if (Store.getArtifact(db, image.id) == null or not readMatches(image)) return false;
    let ?entitlement = Store.getEntitlement(db, F.owner(), "alpha") else return false;
    let ?order = Store.getOrder(db, F.owner(), "existing-purchase") else return false;
    if (entitlement.orderId != order.id or entitlement.kind != #paid or order.state != #complete) return false;
    let ?alpha = Store.getApp(db, "alpha") else return false;
    let ?beta = Store.getApp(db, "beta") else return false;
    let expectedAlpha = if (phase == 0) candidates[0] else if (phase < 3) candidates[2] else if (phase == 3) candidates[3] else candidates[5];
    let expectedBeta = if (phase < 2) candidates[1] else candidates[4];
    if (alpha.approvedCandidate != ?expectedAlpha.id or beta.approvedCandidate != ?expectedBeta.id) return false;
    // Every submitted/audited identity remains in its history, even where its
    // package and source allocation is gone.
    for (original in candidates.vals()) {
      let ?saved = Store.getCandidate(db, original.id) else return false;
      if (saved.digest != original.digest or saved.sourceDigest != original.sourceDigest or saved.publisher != original.publisher) return false;
      if (saved.state == #pending or alpha.approvedCandidate == ?saved.id or beta.approvedCandidate == ?saved.id) {
        if (not readMatches(artifact(saved.artifactId)) or not readMatches(source(saved))) return false;
      };
    };
    // Current beta and a pending/current alpha retain the shared old source;
    // only the final alpha successor makes that source eligible for removal.
    let sharedId = candidates[0].sourceArtifactId;
    switch (sharedId) {
      case (?id) {
        if ((Store.getArtifact(db, id) != null) != (phase < 4)) return false;
      };
      case null return false;
    };
    true;
  };

  public query func snapshot() : async Blob {
    to_candid({
      phase; candidates; retired; untouched; gallery; recycled; freshSource; stats = stats();
      apps = Iter.toArray(db.apps.iterPrimary(#fwd, null));
      candidatesStored = Iter.toArray(db.candidates.iterPrimary(#fwd, null));
      artifacts = Iter.toArray(db.artifacts.iterPrimary(#fwd, null));
      audits = Iter.toArray(db.audits.iterPrimary(#fwd, null));
      uploads = Iter.toArray(db.uploads.iterPrimary(#fwd, null));
      orders = Iter.toArray(db.orders.iterPrimary(#fwd, null));
      entitlements = Iter.toArray(db.entitlements.iterPrimary(#fwd, null));
    });
  };

  public func reuseFreedBlocks() : async Bool {
    assert phase == 4 and recycled == null;
    let before = stats();
    let value = F.upload(db, "alpha", "reuses-retired-storage", #source);
    recycled := ?value;
    let after = stats();
    // Storage is reusable, while generation-tagged retired handles remain
    // invalid instead of yielding the replacement allocation's bytes.
    after.freeBlocks < before.freeBlocks and readMatches(value) and verifyRetired();
  };

  public func dispositionChecks() : async { firstRejected : Nat; lastRejected : Nat; revoked : Nat; valid : Bool } {
    assert seeded;
    ignore F.draft(db, "declined", 0);
    ignore F.draft(db, "pending_peer", 0);
    let first = F.candidate(db, "declined", 100, "declined100");
    let sharedSource = source(first);
    let second = withSource("pending_peer", 100, "pending-peer100", sharedSource);
    func decide(candidate : Types.Candidate, decision : Audits.Decision, requestId : Text) : Audits.StampResult {
      F.ok(Audits.stamp(db, F.auditor(), {
        requestId; candidateId = candidate.id; decision; expectedDigest = candidate.digest;
        expectedSourceDigest = candidate.sourceDigest; analysis = "Fixture audit decision";
        reason = ?"Fixture rejection or revocation";
      }, 10));
    };
    let firstResult = decide(first, #rejected, "reject-first-pending");
    assert firstResult.retiredArtifacts.size() == 1;
    keepRetired(firstResult.retiredArtifacts);
    assert readMatches(sharedSource);
    let secondResult = decide(second, #rejected, "reject-last-pending");
    assert secondResult.retiredArtifacts.size() == 2;
    keepRetired(secondResult.retiredArtifacts);
    let ?alpha = Store.getApp(db, "alpha") else Runtime.trap("Current app missing");
    let ?currentId = alpha.approvedCandidate else Runtime.trap("Current release missing");
    let ?current = Store.getCandidate(db, currentId) else Runtime.trap("Current candidate missing");
    let currentPackage = artifact(current.artifactId);
    let currentSource = source(current);
    let revoked = decide(current, #revoked, "revoke-current");
    assert revoked.retiredArtifacts.size() == 0;
    let ?after = Store.getApp(db, "alpha") else Runtime.trap("Current app lost");
    let ?savedFirst = Store.getCandidate(db, first.id) else Runtime.trap("Rejected history lost");
    let ?savedSecond = Store.getCandidate(db, second.id) else Runtime.trap("Rejected history lost");
    {
      firstRejected = firstResult.retiredArtifacts.size(); lastRejected = secondResult.retiredArtifacts.size();
      revoked = revoked.retiredArtifacts.size();
      valid = after.approvedCandidate == ?currentId and readMatches(currentPackage) and readMatches(currentSource)
        and savedFirst.state == #rejected and savedSecond.state == #rejected and verifyRetired();
    };
  };

  public func prepareFreshDedup() : async Bool {
    assert seeded and freshSource == null;
    ignore F.draft(db, "fresh_app", 0);
    let original = F.candidate(db, "fresh_app", 100, "fresh100");
    ignore F.approve(db, original, "approve-fresh100");
    let successor = F.candidate(db, "fresh_app", 101, "fresh101");
    let oldSource = source(original);
    // The user has uploaded these source bytes again for a future candidate,
    // after the currently pending successor was submitted. Digest dedup means
    // this is the same artifact, but it remains a distinct unbound upload.
    attach("fresh_app", "fresh-unbound-source", oldSource, #source);
    // Replaying the old publication must not consume this fresh upload.
    ignore F.ok(Publishing.submit(db, F.owner(), {
      requestId = original.requestId; appId = original.appId; version = original.version;
      artifactId = original.artifactId; sourceArtifactId = original.sourceArtifactId;
      dependencies = original.dependencies; feeVersion = 1;
    }, 20));
    let ?pending = db.uploads.by_request.lookup((F.owner(), "fresh-unbound-source")) else Runtime.trap("Fresh upload missing");
    assert pending.candidateId == null;
    let result = F.approve(db, successor, "approve-fresh101");
    assert result.retiredArtifacts.size() == 1;
    keepRetired(result.retiredArtifacts);
    freshSource := ?oldSource;
    readMatches(oldSource) and verifyRetired();
  };

  public query func freshUploadIsUnbound() : async Bool {
    let ?value = freshSource else return false;
    let ?upload = db.uploads.by_request.lookup((F.owner(), "fresh-unbound-source")) else return false;
    upload.candidateId == null and Store.getArtifact(db, value.id) != null and readMatches(value);
  };

  public func completeFreshDedup() : async Bool {
    let ?value = freshSource else Runtime.trap("Fresh source fixture not prepared");
    let successor = withSource("fresh_app", 102, "fresh102", value);
    let ?upload = db.uploads.by_request.lookup((F.owner(), "fresh-unbound-source")) else Runtime.trap("Fresh upload missing");
    assert upload.candidateId == ?successor.id;
    let first = F.approve(db, successor, "approve-fresh102");
    assert first.retiredArtifacts.size() == 2;
    keepRetired(first.retiredArtifacts);
    assert readMatches(value);
    let last = F.candidate(db, "fresh_app", 103, "fresh103");
    let result = F.approve(db, last, "approve-fresh103");
    assert result.retiredArtifacts.size() == 2;
    keepRetired(result.retiredArtifacts);
    Store.getArtifact(db, value.id) == null and verifyRetired();
  };
};
