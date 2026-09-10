// All rights reserved. See ../../LICENSE.
import Access "../../mo/Access";
import API "../../mo/API";
import Certification "../../mo/Certification";
import Encoding "../../mo/Encoding";
import Http "../../mo/Http";
import Repository "../../mo/Repository";
import Store "../../mo/Store";
import Types "../../mo/Types";
import Fixtures "../motoko/Fixtures";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

persistent actor Fixture {
  let memory = Fixtures.memory();
  let certification = Http.init();
  var seeded = false;
  var packageId : Nat64 = 0;
  var extraPackageIds : [Nat64] = [];
  transient let db = Store.Use(memory);
  transient let repo = Repository.Service(db, certification, Principal.fromActor(Fixture));
  transient let http = Http.Store(certification, {
    artifact = func(path) { switch (repo.artifact(path)) { case (?value) ?value; case null Certification.artifact(db, path) } };
    chunk = func(path, index) { if (repo.isMetadata(path)) repo.chunk(path, index) else Certification.chunk(db, path, index) };
    authorize = func(path, credential) { repo.isMetadata(path) or Access.authorizeHttp(db, path, credential) };
  });
  transient let certificates = Certification.Service(db, http);
  transient let token = "0000000000000000000000000000000000000000000000000000000000000001";
  transient let request : API.InstallRequest = { requestId = "fixture-install"; appIds = ["repo_test"]; feeVersion = 1 };
  transient let multiRequest : API.InstallRequest = { requestId = "fixture-install-two"; appIds = ["paid_alpha", "paid_beta"]; feeVersion = 1 };
  func accepted<T>(value : API.Result<T>) : T {
    switch (value) { case (#ok(result)) result; case (#err(error)) Runtime.trap(debug_show(error)) };
  };
  if (not seeded) {
    let bytes : Blob = "private-repository-package";
    let value = Fixtures.stored(Store.insertArtifact(db, {
      digest = Encoding.hash(bytes); size = Nat64.fromNat(bytes.size()); mediaType = "application/octet-stream";
      content = #bytes(bytes); publicLegacy = false; createdAtNs = 1;
    }));
    packageId := value.id;
    let app = Fixtures.stored(Store.insertApp(db, {
      appId = "repo_test"; owner = Fixtures.owner(); title = "Repository test"; summary = "Test"; description = "";
      priceUsdMicros = 1_000_000; revision = 1; approvedCandidate = null; visible = true; iconArtifact = null;
      screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 1; updatedAtNs = 1;
    }));
    let candidate = Fixtures.stored(Store.insertCandidate(db, {
      appId = app.appId; version = 100; publisher = app.owner; requestId = "fixture-release"; listingRevision = 1;
      artifactId = value.id; sourceArtifactId = null; digest = value.digest; sourceDigest = null;
      dependencies = []; state = #approved; published = true; createdAtNs = 1; updatedAtNs = 1;
    }));
    ignore Fixtures.stored(db.apps.update({ app with approvedCandidate = ?candidate.id }));
    ignore Fixtures.stored(Store.insertEntitlement(db, { owner = Fixtures.owner(); appId = app.appId; orderId = 1; kind = #paid; acquiredAtNs = 2 }));
    seeded := true;
  };
  http.initialize();
  repo.initialize(http);
  certificates.refreshArtifact(packageId);
  for (id in extraPackageIds.vals()) certificates.refreshArtifact(id);

  public func prepare() : async API.InstallResult { accepted(repo.prepare(http, Fixtures.owner(), request, 3)) };
  public func setupTwo() : async API.InstallResult {
    if (extraPackageIds.size() == 0) {
      let ?original = Store.getApp(db, "repo_test") else Runtime.trap("Missing original fixture app");
      ignore Fixtures.stored(db.apps.update({ original with approvedCandidate = null }));
      func add(appId : Text, bytes : Blob) : Nat64 {
        let value = Fixtures.stored(Store.insertArtifact(db, {
          digest = Encoding.hash(bytes); size = Nat64.fromNat(bytes.size()); mediaType = "application/octet-stream";
          content = #bytes(bytes); publicLegacy = false; createdAtNs = 1;
        }));
        let app = Fixtures.stored(Store.insertApp(db, {
          appId; owner = Fixtures.owner(); title = appId; summary = "Paid installation fixture"; description = "";
          priceUsdMicros = 1_000_000; revision = 1; approvedCandidate = null; visible = true; iconArtifact = null;
          screenshots = []; ratingCount = 0; ratingTotal = 0; createdAtNs = 1; updatedAtNs = 1;
        }));
        let candidate = Fixtures.stored(Store.insertCandidate(db, {
          appId; version = 100; publisher = app.owner; requestId = "release-" # appId; listingRevision = 1;
          artifactId = value.id; sourceArtifactId = null; digest = value.digest; sourceDigest = null;
          dependencies = []; state = #approved; published = true; createdAtNs = 1; updatedAtNs = 1;
        }));
        ignore Fixtures.stored(db.apps.update({ app with approvedCandidate = ?candidate.id }));
        ignore Fixtures.stored(Store.insertEntitlement(db, {
          owner = Fixtures.owner(); appId; orderId = 2; kind = #paid; acquiredAtNs = 2;
        }));
        value.id;
      };
      extraPackageIds := [add("paid_alpha", "paid-alpha-private-repository-package"), add("paid_beta", "paid-beta-private-repository-package")];
      repo.initialize(http);
      for (id in extraPackageIds.vals()) certificates.refreshArtifact(id);
    };
    accepted(repo.prepare(http, Fixtures.owner(), multiRequest, 3));
  };
  public func prepareTwo() : async API.InstallResult { accepted(repo.prepare(http, Fixtures.owner(), multiRequest, 3)) };
  public query func saved() : async ?Types.Manifest { db.manifests.by_request.lookup((Fixtures.owner(), request.requestId)) };
  public query func read(input : { key : Text; index : Nat }) : async Repository.CertifiedRead { repo.read(input.key, input.index) };
  public query func repo_package(input : Repository.PackageRequest) : async Repository.CertifiedRead { repo.absent(Repository.packagePath(input.sha256)) };
  public query func http_request(input : Http.Request) : async Http.Response { http.httpRequest(input, http_streaming_callback) };
  public query func http_streaming_callback(input : Http.Token) : async Http.StreamingResponse { http.stream(input) };
  public func grant() : async () {
    let ?value = Store.getArtifact(db, packageId) else Runtime.trap("Missing fixture package");
    let result = accepted(Access.grant(db, Fixtures.owner(), {
      request_id = "00000000000000000000000000000001"; token;
      paths = [Access.artifactPath(value, #package)]; fee_version = 1;
    }, #buyer, 4));
    certificates.refreshGrant(result.grant);
  };
};
