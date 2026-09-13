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
import Dependencies "./Dependencies";
import Encoding "./Encoding";
import Http "./Http";
import ReleaseStore "./ReleaseStore";
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
  public let channelsPath = "/repo/v1/channels.json";
  public func manifestPath(id : Text) : Text { "/repo/v1/manifests/" # id # ".json" };
  public func releasePath(id : Text) : Text { "/repo/v1/releases/" # id # ".json" };
  public func betaReleasePath(id : Text) : Text { "/repo/v1/channels/beta/releases/" # id # ".json" };
  public func channelHeadsPath(id : Text) : Text { "/repo/v1/channels/apps/" # id # ".json" };
  public func channelManifestPath(id : Text) : Text { "/repo/v1/channels/manifests/" # id # ".json" };
  public func packagePath(digest : Text) : Text { "/repo/v1/packages/" # digest # ".neutron" };

  func failure<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func validId(id : Text) : Bool {
    Dependencies.validInstallerId(id);
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
    Dependencies.installerCompatible(candidate, artifact);
  };
  func modeText(mode : ReleaseStore.Mode) : Text { switch (mode) { case (#stable_) "stable"; case (#beta) "beta" } };
  func sortedSelection(values : [ReleaseStore.Selection]) : [ReleaseStore.Selection] {
    Array.sort<ReleaseStore.Selection>(values, func(a, b) { Text.compare(a.appId, b.appId) });
  };
  func validRoots(owner : Principal, values : [Text]) : API.Result<[Text]> {
    if (Principal.isAnonymous(owner)) return failure("authentication_required", "Prepare an installation through the owning Neutron.");
    let roots = rootIds(values);
    if (roots.size() == 0) return failure("missing_apps", "Select at least one owned app to install.");
    for (id in roots.vals()) {
      if (not validId(id) or id == "kernel") return failure("invalid_app", "Setup selections must name app IDs; upgrade the Kernel through Settings.");
    };
    #ok(roots);
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
    func releaseJson(app : Types.App, head : ReleaseStore.Head) : ?Text {
      let ?candidate = Catalog.atHead(db, app, head) else return null;
      let ?value = Store.getArtifact(db, candidate.artifactId) else return null;
      if (not compatible(candidate, value)) return null;
      ?("{\"protocol\":\"neutron-repo-v1\"," # packageFields(candidate, value) # "}");
    };
    func putReleaseAt(http : Http.Store, path : Text, release : ?Text) {
      switch (release) { case null remove(http, path); case (?content) put(http, path, Text.encodeUtf8(content), false) };
    };
    func headJson(head : ReleaseStore.Head, release : ?Text) : Text {
      "{\"revision\":" # Encoding.quote(Nat64.toText(head.revision)) #
      ",\"candidate_id\":" # (switch (head.candidateId) { case null "null"; case (?id) Encoding.quote(Nat64.toText(id)) }) #
      ",\"release\":" # (switch (release) { case null "null"; case (?value) value }) # "}";
    };
    func removeApp(http : Http.Store, appId : Text) {
      remove(http, releasePath(appId));
      remove(http, betaReleasePath(appId));
      remove(http, channelHeadsPath(appId));
    };
    func putRelease(http : Http.Store, app : Types.App) {
      if (not validId(app.appId)) { removeApp(http, app.appId); return };
      let heads = ReleaseStore.heads(db.channels, app.appId);
      let stableRelease = releaseJson(app, heads.stableHead);
      let betaRelease = releaseJson(app, heads.betaHead);
      // This legacy path remains stable-only. The beta path represents its own
      // head; consumers resolve the effective beta mode from both heads.
      putReleaseAt(http, releasePath(app.appId), stableRelease);
      putReleaseAt(http, betaReleasePath(app.appId), betaRelease);
      put(http, channelHeadsPath(app.appId), Text.encodeUtf8(
        "{\"protocol\":\"neutron-repo-channel-heads-v1\",\"source\":" # Encoding.quote(Principal.toText(canister)) #
        ",\"id\":" # Encoding.quote(app.appId) # ",\"stable\":" # headJson(heads.stableHead, stableRelease) #
        ",\"beta\":" # headJson(heads.betaHead, betaRelease) # "}"), false);
    };
    func putAccess(http : Http.Store) {
      let fees = Store.config(db).fees;
      put(http, accessPath, Text.encodeUtf8("{\"protocol\":\"neutron-repo-access-v1\",\"fee_version\":" #
        Encoding.quote(Nat.toText(fees.version)) # ",\"cycles\":" # Encoding.quote(Nat.toText(fees.grant)) # "}"), false);
    };
    func selectionContent(manifest : Types.Manifest, mode : ReleaseStore.Mode, selection : [ReleaseStore.Selection]) : Blob {
      var packages = "";
      for (entry in selection.vals()) {
        let ?candidate = Store.getCandidate(db, entry.candidateId) else Runtime.trap("Selected candidate disappeared without an await");
        let ?value = Store.getArtifact(db, candidate.artifactId) else Runtime.trap("Selected package disappeared without an await");
        if (packages != "") packages #= ",";
        packages #= "{" # packageFields(candidate, value) # ",\"candidate_id\":" # Encoding.quote(Nat64.toText(entry.candidateId)) #
          ",\"channel\":" # Encoding.quote(modeText(entry.channel)) # ",\"revision\":" # Encoding.quote(Nat64.toText(entry.revision)) # "}";
      };
      Text.encodeUtf8("{\"protocol\":\"neutron-repo-channel-selection-v1\",\"source\":" # Encoding.quote(Principal.toText(canister)) #
        ",\"mode\":" # Encoding.quote(modeText(mode)) # ",\"manifest_id\":" # Encoding.quote(manifest.manifestId) #
        ",\"manifest_sha256\":" # Encoding.quote(Encoding.hex(manifest.digest)) # ",\"packages\":[" # packages # "]}");
    };
    func retainSelection(http : Http.Store, manifest : Types.Manifest, mode : ReleaseStore.Mode, selection : [ReleaseStore.Selection]) {
      let content = selectionContent(manifest, mode, selection);
      Map.add(db.channels.manifests, Text.compare, manifest.manifestId, { mode; selection; content });
      put(http, channelManifestPath(manifest.manifestId), content, true);
    };
    func restoreSelection(http : Http.Store, manifest : Types.Manifest) {
      switch (Map.get(db.channels.manifests, Text.compare, manifest.manifestId)) {
        case (?saved) {
          // Retain the exact proof even after old package blobs are retired.
          // Current eligibility is checked separately by the channel heads.
          put(http, channelManifestPath(manifest.manifestId), saved.content, true);
        };
        case null {
          // An old manifest may be given stable evidence only while every
          // retained candidate is still the available current stable release.
          // Never relabel an old beta or infer a successor from an app ID.
          let selection = List.empty<ReleaseStore.Selection>();
          for (candidateId in manifest.candidateIds.vals()) {
            let ?candidate = Store.getCandidate(db, candidateId) else return;
            let ?app = Store.getApp(db, candidate.appId) else return;
            let ?entry = Catalog.selection(db, app, #stable_) else return;
            if (entry.candidateId != candidateId) return;
            let ?value = Store.getArtifact(db, candidate.artifactId) else return;
            if (not compatible(candidate, value) or not Access.canAccess(db, manifest.owner, candidate.artifactId, #buyer)) return;
            List.add(selection, entry);
          };
          retainSelection(http, manifest, #stable_, sortedSelection(List.toArray(selection)));
        };
      };
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
      put(http, channelsPath, Text.encodeUtf8("{\"protocol\":\"neutron-repo-channels-v1\",\"source\":" # Encoding.quote(Principal.toText(canister)) # "}"), false);
      putAccess(http);
      for ((_, app) in db.apps.iterPrimary(#fwd, null)) putRelease(http, app);
      for ((_, manifest) in db.manifests.iterPrimary(#fwd, null)) {
        if (Encoding.hash(manifest.content) != manifest.digest) Runtime.trap("Retained setup manifest digest is inconsistent");
        put(http, manifestPath(manifest.manifestId), manifest.content, true);
        restoreSelection(http, manifest);
      };
      http.commitCertification();
    };
    public func refreshApp(http : Http.Store, appId : Text) {
      switch (Store.getApp(db, appId)) { case (?app) putRelease(http, app); case null removeApp(http, appId) };
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

    public func selection(owner : Principal, request : API.ChannelInstallQuery) : API.Result<API.ChannelInstallSelection> {
      let roots = switch (validRoots(owner, request.appIds)) { case (#err(error)) return #err(error); case (#ok(value)) value };
      let entries = switch (Dependencies.installation(db, owner, roots, request.mode)) {
        case (#err(error)) return #err(error);
        case (#ok(value)) value;
      };
      // Echo the reviewed roots; the separate selection contains the complete
      // sorted dependency closure. Request identity normalizes roots later.
      #ok({ appIds = request.appIds; mode = request.mode; selection = entries });
    };

    func replay(owner : Principal, saved : Types.Manifest, id : Text) : API.Result<API.InstallResult> {
      if (saved.manifestId != id) return failure("request_mismatch", "This installation request ID already names a different selection.");
      let appIds = List.empty<Text>();
      for (candidateId in saved.candidateIds.vals()) {
        let ?candidate = Store.getCandidate(db, candidateId) else return failure("release_unavailable", "A release in this saved selection is unavailable.");
        if (candidate.state != #approved or not candidate.published or not Access.canAccess(db, owner, candidate.artifactId, #buyer)) {
          return failure("release_unavailable", "A release in this saved selection is no longer approved or accessible. Review a new selection without changing this saved request.");
        };
        List.add(appIds, candidate.appId);
      };
      #ok(result(saved, List.toArray(appIds)));
    };

    func retain(http : Http.Store, owner : Principal, requestId : Text, id : Text, resolved : API.ChannelInstallSelection, now : Int) : API.Result<API.InstallResult> {
      let candidateIds = List.empty<Nat64>();
      let appIds = List.empty<Text>();
      var packages = "";
      for (entry in resolved.selection.vals()) {
        let ?candidate = Store.getCandidate(db, entry.candidateId) else Runtime.trap("Selected candidate disappeared without an await");
        let ?value = Store.getArtifact(db, candidate.artifactId) else Runtime.trap("Selected package disappeared without an await");
        if (packages != "") packages #= ",";
        packages #= "{" # packageFields(candidate, value) # "}";
        List.add(candidateIds, candidate.id);
        List.add(appIds, candidate.appId);
      };
      // Beta selections use an explicitly versioned envelope so older Kernels
      // reject them before installation even if URL channel hints are removed.
      // Stable callers retain the exact existing closed v1 manifest shape.
      let protocolFields = if (resolved.mode == #beta) "\"protocol\":\"neutron-repo-channel-manifest-v1\",\"channel\":\"beta\"" else "\"protocol\":\"neutron-repo-v1\"";
      let content = Text.encodeUtf8("{" # protocolFields # ",\"id\":" # Encoding.quote(id) #
        ",\"revision\":1,\"name\":\"My apps\",\"packages\":[" # packages # "]}");
      if (content.size() > 262_144) return failure("installer_metadata_limit", "This selection exceeds Neutron's existing setup metadata format.");
      let saved = switch (Store.insertManifest(db, {
        owner; requestId; manifestId = id; content; digest = Encoding.hash(content);
        candidateIds = List.toArray(candidateIds); createdAtNs = now;
      })) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap("Could not retain immutable installation selection: " # debug_show(error));
      };
      put(http, manifestPath(id), saved.content, true);
      retainSelection(http, saved, resolved.mode, resolved.selection);
      http.commitCertification();
      #ok(result(saved, List.toArray(appIds)));
    };

    public func prepare(http : Http.Store, owner : Principal, request : API.InstallRequest, now : Int) : API.Result<API.InstallResult> {
      let roots = switch (validRoots(owner, request.appIds)) { case (#err(error)) return #err(error); case (#ok(value)) value };
      if (not Catalog.hasText(request.requestId)) return failure("invalid_request_id", "An installation request ID is required for safe retry.");
      // Retain the legacy identity and manifest format for existing callers.
      let id = Encoding.hex(Encoding.hash(to_candid("marketplace-install-v1", owner, request.requestId, roots)));
      switch (db.manifests.by_request.lookup((owner, request.requestId))) { case (?saved) return replay(owner, saved, id); case null {} };
      let resolved = switch (selection(owner, { appIds = roots; mode = #stable_ })) {
        case (#err(error)) return #err(error); case (#ok(value)) value;
      };
      retain(http, owner, request.requestId, id, resolved, now);
    };

    public func prepareV2(http : Http.Store, owner : Principal, input : API.ChannelInstallRequest, now : Int) : API.Result<API.InstallResult> {
      let request = input.request;
      let roots = switch (validRoots(owner, request.appIds)) { case (#err(error)) return #err(error); case (#ok(value)) value };
      if (not Catalog.hasText(request.requestId)) return failure("invalid_request_id", "An installation request ID is required for safe retry.");
      let entries = sortedSelection(input.selection);
      let id = Encoding.hex(Encoding.hash(to_candid("marketplace-install-v2", owner, request.requestId, roots, input.mode, entries)));
      // A lost reply is reconciled before looking at today's channel heads.
      // The same ID cannot switch modes, roots, or exact release identities.
      switch (db.manifests.by_request.lookup((owner, request.requestId))) { case (?saved) return replay(owner, saved, id); case null {} };
      let resolved = switch (selection(owner, { appIds = roots; mode = input.mode })) {
        case (#err(error)) return #err(error); case (#ok(value)) value;
      };
      if (entries != resolved.selection) return failure("selection_changed", "The selected releases changed. Review their current channel selection before preparing this installation.");
      retain(http, owner, request.requestId, id, resolved, now);
    };
  };
};
