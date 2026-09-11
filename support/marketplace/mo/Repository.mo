// All rights reserved. See ../LICENSE.
import Array "mo:core/Array";
import CertifiedData "mo:core/CertifiedData";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import CertTree "mo:ic-certification/CertTree";
import Access "./Access";
import API "./API";
import Catalog "./Catalog";
import Encoding "./Encoding";
import Http "./Http";
import Publishing "./Publishing";
import Store "./Store";
import Types "./Types";

module {
  public type ReadRequest = { index : Nat };
  public type ManifestRequest = { id : Text; index : Nat };
  public type PackageRequest = { sha256 : Text; index : Nat };
  public type CertifiedValue = { content : Blob; chunks : Nat };
  public type CertifiedRead = { certificate : Blob; witness : Blob; asset : ?CertifiedValue };
  type Resource = { artifact : Http.Artifact; content : Blob };

  public let infoPath = "/repo/v1/info.json";
  public let indexPath = "/repo/v1/manifests.json";
  public let accessPath = "/repo/v1/access.json";
  public func manifestPath(id : Text) : Text { "/repo/v1/manifests/" # id # ".json" };
  public func releasePath(id : Text) : Text { "/repo/v1/releases/" # id # ".json" };
  public func packagePath(digest : Text) : Text { "/repo/v1/packages/" # digest # ".neutron" };

  func failure<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func validId(id : Text) : Bool {
    Catalog.validAppId(id) and id != "constructor" and id != "prototype" and id != "__proto__";
  };
  func rootIds(values : [Text]) : [Text] {
    let result = List.empty<Text>();
    var previous : ?Text = null;
    for (id in Array.sort<Text>(values, Text.compare).vals()) {
      if (previous != ?id) List.add(result, id);
      previous := ?id;
    };
    List.toArray(result);
  };
  func packageFields(candidate : Types.Candidate, artifact : Types.Artifact) : Text {
    "\"id\":" # Encoding.quote(candidate.appId) #
    ",\"version\":" # Nat.toText(candidate.version) #
    ",\"sha256\":" # Encoding.quote(Encoding.hex(candidate.digest)) #
    ",\"size\":" # Nat64.toText(artifact.size);
  };
  func compatible(candidate : Types.Candidate, artifact : Types.Artifact) : Bool {
    validId(candidate.appId) and Publishing.validReleaseVersion(candidate.version) and
    candidate.digest.size() == 32 and candidate.digest == artifact.digest and
    artifact.size > 0 and Nat64.toNat(artifact.size) <= Publishing.maxPackageBytes;
  };

  // Public metadata and both certification protocols share one certified root.
  // Package bytes deliberately never enter the legacy http_assets branch.
  public class Service(db : Store.DB, memory : Http.Memory, canister : Principal) {
    let resources = Map.empty<Text, Resource>();
    let cert = CertTree.Ops(memory);

    public func artifact(path : Text) : ?Http.Artifact {
      switch (Map.get(resources, Text.compare, path)) { case (?resource) ?resource.artifact; case null null };
    };
    public func chunk(path : Text, index : Nat) : ?Blob {
      if (index != 0) return null;
      switch (Map.get(resources, Text.compare, path)) { case (?resource) ?resource.content; case null null };
    };
    public func isMetadata(path : Text) : Bool { Map.containsKey(resources, Text.compare, path) };

    func put(http : Http.Store, path : Text, content : Blob, immutable : Bool) {
      let resource : Resource = {
        content;
        artifact = { path; sha256 = Encoding.hash(content); size = content.size(); contentType = "application/json";
          chunks = 1; publicAccess = true; immutable };
      };
      Map.add(resources, Text.compare, path, resource);
      cert.put(["http_assets", Text.encodeUtf8(path)], resource.artifact.sha256);
      http.configureArtifact(resource.artifact);
    };
    func remove(http : Http.Store, path : Text) {
      Map.remove(resources, Text.compare, path);
      cert.delete(["http_assets", Text.encodeUtf8(path)]);
      http.removeArtifact(path);
    };
    func putRelease(http : Http.Store, app : Types.App) {
      let path = releasePath(app.appId);
      let ?candidate = Catalog.approvedRelease(db, app) else { remove(http, path); return };
      let ?value = Store.getArtifact(db, candidate.artifactId) else { remove(http, path); return };
      if (not compatible(candidate, value)) { remove(http, path); return };
      put(http, path, Text.encodeUtf8("{\"protocol\":\"neutron-repo-v1\"," # packageFields(candidate, value) # "}"), false);
    };
    func putAccess(http : Http.Store) {
      let fees = Store.config(db).fees;
      put(http, accessPath, Text.encodeUtf8("{\"protocol\":\"neutron-repo-access-v1\",\"fee_version\":" #
        Encoding.quote(Nat.toText(fees.version)) # ",\"cycles\":" # Encoding.quote(Nat.toText(fees.grant)) # "}"), false);
    };

    public func initialize(http : Http.Store) {
      // Rebuild metadata after upgrade from retained immutable manifests. Do
      // not clear http_expr: package grants are certified in that same tree.
      for ((path, _) in Map.entries(resources)) http.removeArtifact(path);
      Map.clear(resources);
      cert.delete(["http_assets"]);
      put(http, infoPath, Text.encodeUtf8("{\"protocol\":\"neutron-repo-v1\",\"name\":\"Neutron Marketplace\",\"provider\":{\"name\":\"Neutron Marketplace\"}}"), false);
      // Owner-specific setup selections are not a public discovery catalog.
      put(http, indexPath, Text.encodeUtf8("{\"protocol\":\"neutron-repo-v1\",\"manifests\":[]}"), false);
      putAccess(http);
      for ((_, app) in db.apps.iterPrimary(#fwd, null)) putRelease(http, app);
      for ((_, manifest) in db.manifests.iterPrimary(#fwd, null)) {
        if (Encoding.hash(manifest.content) != manifest.digest) Runtime.trap("Retained setup manifest digest is inconsistent");
        put(http, manifestPath(manifest.manifestId), manifest.content, true);
      };
      http.commitCertification();
    };
    public func refreshApp(http : Http.Store, appId : Text) {
      switch (Store.getApp(db, appId)) { case (?app) putRelease(http, app); case null remove(http, releasePath(appId)) };
      http.commitCertification();
    };
    public func refreshAccess(http : Http.Store) { putAccess(http); http.commitCertification() };

    public func read(path : Text, index : Nat) : CertifiedRead {
      let value = switch (Map.get(resources, Text.compare, path)) {
        case null null;
        case (?resource) {
          if (index != 0) Runtime.trap("Repository chunk index is out of range");
          ?{ content = resource.content; chunks = 1 };
        };
      };
      let certificate = switch (CertifiedData.getCertificate()) {
        case (?value) value;
        case null Runtime.trap("Repository certified reads must be queries");
      };
      { certificate; witness = cert.encodeWitness(cert.reveal(["http_assets", Text.encodeUtf8(path)])); asset = value };
    };
    public func absent(path : Text) : CertifiedRead {
      if (isMetadata(path)) Runtime.trap("Cannot certify a present metadata resource as absent");
      read(path, 0);
    };

    func result(manifest : Types.Manifest, appIds : [Text]) : API.InstallResult {
      let digest = Encoding.hex(manifest.digest);
      let source = Principal.toText(canister);
      { canister; manifestId = manifest.manifestId; digest; appIds;
        setupUrl = "https://" # Principal.toText(manifest.owner) # ".icp0.io/#repo=" # source #
          "&manifest=" # manifest.manifestId # "&digest=" # digest };
    };

    public func prepare(http : Http.Store, owner : Principal, request : API.InstallRequest, now : Int) : API.Result<API.InstallResult> {
      if (Principal.isAnonymous(owner)) return failure("authentication_required", "Prepare an installation through the owning Neutron.");
      if (not Catalog.hasText(request.requestId)) return failure("invalid_request_id", "An installation request ID is required for safe retry.");
      let roots = rootIds(request.appIds);
      if (roots.size() == 0) return failure("missing_apps", "Select at least one owned app to install.");
      for (id in roots.vals()) {
        if (not validId(id) or id == "kernel") return failure("invalid_app", "Setup selections must name app IDs; upgrade the Kernel through Settings.");
      };
      // The ID commits to the original roots, not the resolved dependency
      // closure. Reusing a request after a release must return identical bytes.
      let id = Encoding.hex(Encoding.hash(to_candid("marketplace-install-v1", owner, request.requestId, roots)));
      switch (db.manifests.by_request.lookup((owner, request.requestId))) {
        case (?saved) {
          if (saved.manifestId != id) return failure("request_mismatch", "This installation request ID already names a different selection.");
          let appIds = List.empty<Text>();
          for (candidateId in saved.candidateIds.vals()) {
            let ?candidate = Store.getCandidate(db, candidateId) else return failure("release_unavailable", "A release in this saved selection is unavailable.");
            if (candidate.state != #approved or not candidate.published or not Access.canAccess(db, owner, candidate.artifactId, #buyer)) {
              return failure("release_unavailable", "A release in this saved selection is no longer approved or accessible. Review a new selection without changing this saved request.");
            };
            List.add(appIds, candidate.appId);
          };
          return #ok(result(saved, List.toArray(appIds)));
        };
        case null {};
      };
      for (appId in roots.vals()) {
        if (Store.getEntitlement(db, owner, appId) == null) return failure("app_not_owned", "Add " # appId # " to My apps before installing it.");
      };
      let selected = Map.empty<Text, Types.Candidate>();
      let digests = Map.empty<Text, Text>();
      var totalBytes = 0;
      func visit(appId : Text, minimum : Nat) : API.Result<()> {
        // Setup cannot contain a Kernel archive. The package's retained
        // dependency metadata is checked against the installed Kernel by the
        // existing installer; incompatible Kernels are upgraded in Settings.
        if (appId == "kernel") return #ok(());
        switch (Map.get(selected, Text.compare, appId)) {
          case (?value) {
            if (value.version < minimum) return failure("dependency_version", "The latest approved " # appId # " release does not satisfy the dependency minimum.");
            return #ok(());
          };
          case null {};
        };
        let ?app = Store.getApp(db, appId) else return failure("dependency_unavailable", "No marketplace app exists for " # appId # ".");
        let ?candidate = Catalog.approvedRelease(db, app) else return failure("release_unavailable", "No approved published release is available for " # appId # ".");
        if (candidate.version < minimum) return failure("dependency_version", "The latest approved " # appId # " release does not satisfy the dependency minimum.");
        let ?value = Store.getArtifact(db, candidate.artifactId) else return failure("release_unavailable", "The package for " # appId # " is unavailable.");
        if (not compatible(candidate, value)) return failure("installer_incompatible", "The approved " # appId # " release does not fit the existing Neutron package format.");
        if (app.priceUsdMicros > 0 and Store.getEntitlement(db, owner, appId) == null) return failure("dependency_not_owned", "This selection needs the paid app " # appId # ". Add it to My apps before installing.");
        if (not Access.canAccess(db, owner, candidate.artifactId, #buyer)) return failure("release_unavailable", "The approved package for " # appId # " is not accessible to this Neutron.");
        // These are the existing installer codec limits, not catalog quotas.
        if (Map.size(selected) >= 64 or totalBytes + Nat64.toNat(value.size) > 67_108_864) return failure("installer_batch_limit", "This selection exceeds Neutron's existing 64-package or 64 MiB install batch format. Select fewer apps.");
        let digest = Encoding.hex(candidate.digest);
        switch (Map.get(digests, Text.compare, digest)) {
          case (?other) return failure("duplicate_package", "The same package digest cannot identify both " # other # " and " # appId # ".");
          case null {};
        };
        Map.add(selected, Text.compare, appId, candidate);
        Map.add(digests, Text.compare, digest, appId);
        totalBytes += Nat64.toNat(value.size);
        for (dependency in candidate.dependencies.vals()) {
          switch (visit(dependency.appId, dependency.minVersion)) { case (#err(error)) return #err(error); case (#ok(())) {} };
        };
        #ok(());
      };
      for (root in roots.vals()) {
        switch (visit(root, 100)) { case (#err(error)) return #err(error); case (#ok(())) {} };
      };
      let candidateIds = List.empty<Nat64>();
      let appIds = List.empty<Text>();
      var packages = "";
      for ((appId, candidate) in Map.entries(selected)) {
        let ?value = Store.getArtifact(db, candidate.artifactId) else Runtime.trap("Selected package disappeared without an await");
        if (packages != "") packages #= ",";
        packages #= "{" # packageFields(candidate, value) # "}";
        List.add(candidateIds, candidate.id);
        List.add(appIds, appId);
      };
      let content = Text.encodeUtf8("{\"protocol\":\"neutron-repo-v1\",\"id\":" # Encoding.quote(id) #
        ",\"revision\":1,\"name\":\"My apps\",\"packages\":[" # packages # "]}");
      if (content.size() > 262_144) return failure("installer_metadata_limit", "This selection exceeds Neutron's existing setup metadata format.");
      let saved = switch (Store.insertManifest(db, {
        owner; requestId = request.requestId; manifestId = id; content; digest = Encoding.hash(content);
        candidateIds = List.toArray(candidateIds); createdAtNs = now;
      })) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap("Could not retain immutable installation selection: " # debug_show(error));
      };
      put(http, manifestPath(id), saved.content, true);
      http.commitCertification();
      #ok(result(saved, List.toArray(appIds)));
    };
  };
};
