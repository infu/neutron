// All rights reserved. See ../LICENSE.
import Access "../mo/Access";
import API "../mo/API";
import Certification "../mo/Certification";
import Encoding "../mo/Encoding";
import Http "../mo/Http";
import Retention "../mo/Retention";
import PublisherStore "../mo/PublisherStore";
import Store "../mo/Store";
import Types "../mo/Types";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

persistent actor {
  transient let publisher = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
  transient let buyer = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
  transient let auditor = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
  transient let appId = "certification_test";
  transient let requestId = "00000000000000000000000000000001";
  let memory = Store.init({
    admins = [Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai")];
    auditors = [Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai")]; tokens = [];
    xrc = Principal.fromText("aaaaa-aa");
    fees = { version = 1; updateBase = 0; updateByte = 0; storageByteYear = 0; purchase = 0; withdraw = 0; grant = 0; xrc = 0 };
    referralTerms = { version = 1; discountBps = 1_000; affiliateBps = 3_000; developerBps = 3_000 };
  });
  let httpMemory = Http.init();
  var candidateId : ?Nat64 = null;
  var paths : [Text] = [];
  let publisherMemory = PublisherStore.init();
  transient let db = Store.Use(memory, publisherMemory);
  transient let http = Http.Store(httpMemory, {
    artifact = func(path : Text) : ?Http.Artifact { Certification.artifact(db, path) };
    authorize = func(path : Text, bearer : ?Text) : Bool { Access.authorizeHttp(db, path, bearer) };
    chunk = func(path : Text, index : Nat) : ?Blob { Certification.chunk(db, path, index) };
  });
  transient let certification = Certification.Service(db, http);
  http.initialize();
  http.commitCertification();

  func stored<T>(result : { #ok : T; #err : Types.Error }) : T {
    switch (result) {
      case (#ok(value)) value;
      case (#err(error)) Runtime.trap("Certification fixture storage failed: " # debug_show(error));
    };
  };
  func accepted<T>(result : API.Result<T>) : T {
    switch (result) {
      case (#ok(value)) value;
      case (#err(error)) Runtime.trap("Certification fixture access failed: " # debug_show(error));
    };
  };
  func artifact(bytes : Blob, mediaType : Text) : Types.Artifact {
    stored(Store.insertArtifact(db, {
      digest = Encoding.hash(bytes); size = Nat64.fromNat(bytes.size()); mediaType;
      content = #bytes(bytes); publicLegacy = false; createdAtNs = 1;
    }));
  };
  func candidate() : Types.Candidate {
    let ?id = candidateId else Runtime.trap("Fixture is not initialized");
    let ?value = Store.getCandidate(db, id) else Runtime.trap("Fixture candidate is missing");
    value;
  };

  public func initialize() : async [Text] {
    if (candidateId != null) return paths;
    let package = artifact(Blob.fromArray(Array.tabulate<Nat8>(Certification.CHUNK_BYTES + 17, func(i) { if (i < Certification.CHUNK_BYTES) 65 else 66 })), "application/octet-stream");
    let source = artifact("private-offered-source", "application/gzip");
    let image = artifact("public-listing-image", "image/png");
    let app = stored(Store.insertApp(db, {
      appId; owner = publisher; title = "Certification test"; summary = "Fixture"; description = "";
      priceUsdMicros = 1_000_000; revision = 1; approvedCandidate = null; visible = true;
      iconArtifact = ?image.id; screenshots = []; ratingCount = 0; ratingTotal = 0;
      createdAtNs = 1; updatedAtNs = 1;
    }));
    let value = stored(Store.insertCandidate(db, {
      appId; version = 100; publisher; requestId; listingRevision = 1;
      artifactId = package.id; sourceArtifactId = ?source.id; digest = package.digest; sourceDigest = ?source.digest;
      dependencies = []; state = #approved; published = true; createdAtNs = 1; updatedAtNs = 1;
    }));
    candidateId := ?value.id;
    ignore stored(db.apps.update({ app with approvedCandidate = candidateId }));
    ignore stored(Store.insertEntitlement(db, { owner = buyer; appId; orderId = 1; kind = #paid; acquiredAtNs = 2 }));
    paths := [Access.artifactPath(package, #package), Access.artifactPath(source, #source), Access.artifactPath(image, #image)];
    for ((owner, purpose, token) in ([
      (buyer, #buyer, "0000000000000000000000000000000000000000000000000000000000000001"),
      (publisher, #publisher, "0000000000000000000000000000000000000000000000000000000000000002"),
      (auditor, #auditor, "0000000000000000000000000000000000000000000000000000000000000003"),
    ] : [(Principal, Access.Purpose, Text)]).vals()) {
      ignore accepted(Access.grant(db, owner, { request_id = requestId; token; paths = [paths[0], paths[1]]; fee_version = 1 }, purpose, 3));
    };
    certification.refreshApp(appId);
    paths;
  };

  public func revokeCandidate() : async () {
    ignore stored(db.candidates.update({ candidate() with state = #revoked; updatedAtNs = 4 }));
    certification.refreshApp(appId);
  };
  public func removeAuditor() : async () {
    Store.setConfig(db, { Store.config(db) with auditors = [] });
    certification.refreshAllGrants();
  };
  public func revokeGrant() : async () {
    let ?value = Store.getGrant(db, publisher, requestId) else Runtime.trap("Publisher grant missing");
    let revoked = stored(db.grants.update({ value with revoked = true; updatedAtNs = 5 }));
    certification.refreshGrant(revoked);
  };
  public func setFree(free : Bool) : async () {
    let ?app = Store.getApp(db, appId) else Runtime.trap("Fixture app missing");
    ignore stored(db.apps.update({ app with priceUsdMicros = if (free) 0 else 1_000_000 }));
    certification.refreshApp(appId);
  };
  public func approveSuccessorAndRetire() : async { paths : [Text]; retiredCount : Nat; retiredMissing : Bool; historyRetained : Bool } {
    let previous = candidate();
    let package = artifact("successor-package", "application/octet-stream");
    let source = artifact("successor-offered-source", "application/gzip");
    let successor = stored(Store.insertCandidate(db, {
      appId; version = previous.version + 1; publisher; requestId = "00000000000000000000000000000002";
      listingRevision = 1; artifactId = package.id; sourceArtifactId = ?source.id;
      digest = package.digest; sourceDigest = ?source.digest; dependencies = [];
      state = #approved; published = true; createdAtNs = 6; updatedAtNs = 6;
    }));
    let ?app = Store.getApp(db, appId) else Runtime.trap("Fixture app missing");
    ignore stored(db.apps.update({ app with approvedCandidate = ?successor.id; updatedAtNs = 6 }));
    let retired = Retention.afterDecision(db, appId);
    certification.removeArtifacts(retired);
    paths := [Access.artifactPath(package, #package), Access.artifactPath(source, #source), paths[2]];
    ignore accepted(Access.grant(db, buyer, {
      request_id = "00000000000000000000000000000002";
      token = "0000000000000000000000000000000000000000000000000000000000000004";
      paths = [paths[0], paths[1]]; fee_version = 1;
    }, #buyer, 6));
    certification.refreshApp(appId);
    candidateId := ?successor.id;
    let sourceMissing = switch (previous.sourceArtifactId) {
      case (?id) Store.getArtifact(db, id) == null;
      case null false;
    };
    {
      paths; retiredCount = retired.size();
      retiredMissing = Store.getArtifact(db, previous.artifactId) == null and sourceMissing;
      historyRetained = Store.getCandidate(db, previous.id) == ?previous;
    };
  };
  public query func buyerOwnershipRetained() : async Bool { Store.getEntitlement(db, buyer, appId) != null };
  public query func http_request(request : Http.Request) : async Http.Response { http.httpRequest(request, http_streaming_callback) };
  public query func http_streaming_callback(token : Http.Token) : async Http.StreamingResponse { http.stream(token) };
};
