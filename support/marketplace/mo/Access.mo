// All rights reserved. See ../LICENSE.
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import API "./API";
import Catalog "./Catalog";
import Encoding "./Encoding";
import Http "./Http";
import Store "./Store";
import Types "./Types";

module {
  public type Purpose = { #buyer; #publisher; #auditor };
  public type ArtifactKind = { #package; #source; #image };
  public type ResolvedArtifact = { artifact : Types.Artifact; purpose : ArtifactKind };
  public type GrantResult = { grant : Types.Grant; new : Bool };

  func failure<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };
  func must<T>(value : { #ok : T; #err : Types.Error }) : T {
    switch (value) {
      case (#ok(result)) result;
      case (#err(error)) Runtime.trap("Could not retain marketplace access: " # debug_show(error));
    };
  };
  func includes(values : [Principal], principal : Principal) : Bool {
    for (value in values.vals()) { if (value == principal) return true };
    false;
  };
  public func isAdmin(db : Store.DB, principal : Principal) : Bool {
    not Principal.isAnonymous(principal) and includes(Store.config(db).admins, principal);
  };
  public func isAuditor(db : Store.DB, principal : Principal) : Bool {
    not Principal.isAnonymous(principal) and includes(Store.config(db).auditors, principal);
  };
  public func isTrustedPublisher(db : Store.DB, principal : Principal) : Bool {
    not Principal.isAnonymous(principal) and Store.getTrustedPublishingPrincipal(db) == ?principal;
  };
  func principalClass(principal : Principal) : ?Nat8 {
    let bytes = Principal.toBlob(principal);
    if (bytes.size() == 0) null else ?bytes[bytes.size() - 1];
  };

  public func readOwner(db : Store.DB, caller : Principal) : API.Result<Principal> {
    if (Principal.isAnonymous(caller)) return failure("authentication_required", "Connect this browser to its Neutron before reading private marketplace data.");
    // Canister identity and assigned CLI roles are already authenticated by
    // the IC. Browser delegates do not replace or alias either identity.
    if (principalClass(caller) == ?(1 : Nat8) or isAdmin(db, caller) or isAuditor(db, caller) or isTrustedPublisher(db, caller)) return #ok(caller);
    switch (Store.getDelegate(db, caller)) {
      case (?delegate) {
        if (delegate.active) #ok(delegate.owner)
        else failure("delegate_revoked", "This browser's marketplace connection was revoked. Reconnect through its Neutron.");
      };
      case null failure("delegate_required", "Connect this browser through its Neutron to read its purchases and earnings.");
    };
  };

  public func setDelegate(db : Store.DB, owner : Principal, browser : Principal, active : Bool, now : Int) : API.Result<()> {
    if (principalClass(owner) != ?(1 : Nat8)) return failure("neutron_required", "Browser access must be registered by the owning Neutron canister.");
    if (principalClass(browser) != ?(2 : Nat8)) return failure("invalid_browser_identity", "A browser connection must use its self-authenticating signing identity.");
    let existing = Store.getDelegate(db, browser);
    switch (existing) {
      case (?delegate) {
        if (delegate.owner != owner) return failure("delegate_owner_mismatch", "This browser identity is registered to another Neutron. Use a distinct browser identity for this Neutron.");
        if (delegate.active == active) return #ok(());
      };
      case null {};
    };
    ignore must(Store.putDelegate(db, {
      browser; owner; active; createdAtNs = switch (existing) { case (?delegate) delegate.createdAtNs; case null now }; updatedAtNs = now;
    }));
    #ok(());
  };

  func decodeDigest(value : Text) : ?Blob {
    if (not Encoding.isHex(value, 32)) return null;
    let text = Text.encodeUtf8(value);
    let bytes = List.empty<Nat8>();
    func digit(character : Nat8) : Nat8 {
      if (character <= 57) character - 48 else character - 87;
    };
    var i = 0;
    while (i < text.size()) {
      List.add(bytes, digit(text[i]) * 16 + digit(text[i + 1]));
      i += 2;
    };
    ?Blob.fromArray(List.toArray(bytes));
  };
  public func artifactPath(artifact : Types.Artifact, purpose : ArtifactKind) : Text {
    let digest = Encoding.hex(artifact.digest);
    switch (purpose) {
      case (#package) "/repo/v1/packages/" # digest # ".neutron";
      case (#source) "/repo/v1/sources/" # digest # ".source.v1.msgpack.gz";
      case (#image) "/repo/v1/media/" # digest;
    };
  };
  public func resolveArtifactPath(db : Store.DB, path : Text) : ?ResolvedArtifact {
    if (not Http.validPath(path)) return null;
    let parsed : ?(Text, ArtifactKind) = switch (Text.stripStart(path, #text "/repo/v1/packages/")) {
      case (?suffix) {
        switch (Text.stripEnd(suffix, #text ".neutron")) { case (?digest) ?(digest, #package); case null null };
      };
      case null switch (Text.stripStart(path, #text "/repo/v1/sources/")) {
        case (?suffix) {
          switch (Text.stripEnd(suffix, #text ".source.v1.msgpack.gz")) { case (?digest) ?(digest, #source); case null null };
        };
        case null switch (Text.stripStart(path, #text "/repo/v1/media/")) { case (?digest) ?(digest, #image); case null null };
      };
    };
    let ?(text, purpose) = parsed else return null;
    let ?digest = decodeDigest(text) else return null;
    let ?artifact = Store.getArtifactByDigest(db, digest) else return null;
    ?{ artifact; purpose };
  };

  func referencesImage(app : Types.App, id : Nat64) : Bool {
    if (app.iconArtifact == ?id) return true;
    for (image in app.screenshots.vals()) { if (image == id) return true };
    false;
  };
  func candidateVisible(db : Store.DB, candidate : Types.Candidate) : Bool {
    if (not candidate.published or candidate.state != #approved) return false;
    let ?app = Store.getApp(db, candidate.appId) else return false;
    Catalog.eligible(db, app);
  };
  func candidateAccessible(db : Store.DB, owner : Principal, candidate : Types.Candidate, purpose : Purpose) : Bool {
    switch (purpose) {
      case (#publisher) candidate.publisher == owner or (candidate.published and candidate.state == #approved and Store.getEntitlement(db, owner, candidate.appId) != null);
      case (#auditor) isAuditor(db, owner);
      case (#buyer) {
        candidate.published and candidate.state == #approved and Store.getEntitlement(db, owner, candidate.appId) != null;
      };
    };
  };
  func matchingCandidates(db : Store.DB, id : Nat64, purpose : ArtifactKind, check : Types.Candidate -> Bool) : Bool {
    let range = { gt = null; gte = ?id; lt = null; lte = ?id; dir = #fwd };
    switch (purpose) {
      case (#package) {
        for (candidate in db.candidates.by_artifact.rangeIter(range, null)) {
          if (candidate.artifactId == id and check(candidate)) return true;
        };
      };
      case (#source) {
        for (candidate in db.candidates.by_source_artifact.rangeIter(range, null)) {
          if (candidate.sourceArtifactId == ?id and check(candidate)) return true;
        };
      };
      case (#image) {};
    };
    false;
  };
  func publicPath(db : Store.DB, resolved : ResolvedArtifact) : Bool {
    let artifact = resolved.artifact;
    // This flag is set only by the explicit historical-public import path.
    if (artifact.publicLegacy) return true;
    switch (resolved.purpose) {
      case (#image) {
        // Images are public only while referenced by an eligible public app.
        // An unattached publisher upload does not become public just because
        // its caller selected an image MIME type.
        let range = { gt = null; gte = ?artifact.id; lt = null; lte = ?artifact.id; dir = #fwd };
        for (app in db.apps.by_icon_artifact.rangeIter(range, null)) {
          if (referencesImage(app, artifact.id) and Catalog.eligible(db, app)) return true;
        };
        for (app in db.apps.by_screenshot.rangeIter(range, null)) {
          if (referencesImage(app, artifact.id) and Catalog.eligible(db, app)) return true;
        };
        false;
      };
      case (_) matchingCandidates(db, artifact.id, resolved.purpose, func(candidate) {
        if (not candidateVisible(db, candidate)) return false;
        switch (Store.getApp(db, candidate.appId)) { case (?app) app.priceUsdMicros == 0; case null false };
      });
    };
  };
  public func publicArtifact(db : Store.DB, artifactId : Nat64) : Bool {
    let ?artifact = Store.getArtifact(db, artifactId) else return false;
    for (purpose in [#package, #source, #image].vals()) {
      if (publicPath(db, { artifact; purpose })) return true;
    };
    false;
  };
  public func isPublicPath(db : Store.DB, path : Text) : Bool {
    let ?resolved = resolveArtifactPath(db, path) else return false;
    publicPath(db, resolved);
  };
  func auditedImageReference(db : Store.DB, id : Nat64) : Bool {
    let range = { gt = null; gte = ?id; lt = null; lte = ?id; dir = #fwd };
    for (upload in db.uploads.by_artifact.rangeIter(range, null)) {
      if (upload.state == #attached and upload.purpose == #image and upload.artifactId == ?id) {
        let ownerRange = { gt = null; gte = ?upload.owner; lt = null; lte = ?upload.owner; dir = #fwd };
        for (app in db.apps.by_owner.rangeIter(ownerRange, null)) {
          let appRange = { gt = null; gte = ?app.appId; lt = null; lte = ?app.appId; dir = #fwd };
          for (candidate in db.candidates.by_app.rangeIter(appRange, null)) {
            // Retained listing revisions let assigned auditors inspect the
            // screenshots associated with pending or historical candidates.
            switch (Store.getListing(db, candidate.appId, candidate.listingRevision)) {
              case (?listing) {
                if (listing.iconArtifact == ?id) return true;
                for (image in listing.screenshots.vals()) { if (image == id) return true };
              };
              case null {};
            };
          };
        };
      };
    };
    false;
  };
  func accessPath(db : Store.DB, owner : Principal, resolved : ResolvedArtifact, purpose : Purpose) : Bool {
    if (publicPath(db, resolved)) return true;
    if (Principal.isAnonymous(owner)) return false;
    let id = resolved.artifact.id;
    if (matchingCandidates(db, id, resolved.purpose, func(candidate) { candidateAccessible(db, owner, candidate, purpose) })) return true;
    if (resolved.purpose == #image and purpose == #auditor and isAuditor(db, owner) and auditedImageReference(db, id)) return true;
    // An owner can inspect its completed uploads before candidate submission.
    // No other role receives blanket access to unrelated unfinished uploads.
    if (purpose == #publisher) {
      let range = { gt = null; gte = ?id; lt = null; lte = ?id; dir = #fwd };
      for (upload in db.uploads.by_artifact.rangeIter(range, null)) {
        if (upload.owner == owner and upload.state == #attached and upload.artifactId == ?id and upload.purpose == resolved.purpose) return true;
      };
    };
    false;
  };
  public func canAccess(db : Store.DB, owner : Principal, artifactId : Nat64, purpose : Purpose) : Bool {
    let ?artifact = Store.getArtifact(db, artifactId) else return false;
    for (kind in [#package, #source, #image].vals()) {
      if (accessPath(db, owner, { artifact; purpose = kind }, purpose)) return true;
    };
    false;
  };

  // The trusted publisher subsidy covers its own publishing artifacts only,
  // rather than changing the ordinary buyer/publisher grant authorization.
  public func ownsPublishingPath(db : Store.DB, owner : Principal, path : Text) : Bool {
    let ?resolved = resolveArtifactPath(db, path) else return false;
    let id = resolved.artifact.id;
    if (matchingCandidates(db, id, resolved.purpose, func(candidate) { candidate.publisher == owner })) return true;
    for (upload in db.uploads.by_artifact.rangeIter({ gt = null; gte = ?id; lt = null; lte = ?id; dir = #fwd }, null)) {
      if (upload.owner == owner and upload.state == #attached and upload.artifactId == ?id and upload.purpose == resolved.purpose) return true;
    };
    false;
  };

  public func grant(db : Store.DB, owner : Principal, request : API.RepoAccessRequest, purpose : Purpose, now : Int) : API.Result<GrantResult> {
    if (Principal.isAnonymous(owner)) return failure("authentication_required", "A source grant requires an authenticated owner.");
    if (not Encoding.isHex(request.request_id, 16)) return failure("invalid_request_id", "request_id must be 16 random bytes encoded as lowercase hexadecimal.");
    if (not Encoding.isHex(request.token, 32)) return failure("invalid_credential", "The source credential must be 32 random bytes encoded as lowercase hexadecimal.");
    if (request.paths.size() == 0) return failure("missing_paths", "Select at least one artifact for this source grant.");
    let credentialHash = Encoding.hashText(request.token);
    let authorizationHash = Http.authorizationHash(request.token);
    switch (Store.getGrant(db, owner, request.request_id)) {
      case (?saved) {
        if (saved.credentialHash != credentialHash or saved.authorizationHash != authorizationHash or saved.paths != request.paths or saved.purpose != purpose) return failure("request_mismatch", "This source request ID already identifies a different credential or artifact selection.");
        if (saved.revoked) return failure("grant_revoked", "This source grant was revoked. Create a new source request to request access again.");
        // Repeated grant requests still recheck current eligibility; an old
        // request cannot resurrect access to a revoked package or audit role.
        for (path in saved.paths.vals()) {
          let ?resolved = resolveArtifactPath(db, path) else return failure("artifact_unavailable", "A selected artifact is unavailable.");
          if (not accessPath(db, owner, resolved, purpose)) return failure("access_denied", "A selected artifact is no longer available to this owner.");
        };
        return #ok({ grant = saved; new = false });
      };
      case null {};
    };
    if (Store.getGrantByCredential(db, credentialHash) != null) return failure("credential_reused", "This credential is already bound to another source request. Use a new random credential.");
    let ids = List.empty<Nat64>();
    for (path in request.paths.vals()) {
      let ?resolved = resolveArtifactPath(db, path) else return failure("invalid_artifact_path", "A selected artifact path is not a canonical repository artifact.");
      if (not accessPath(db, owner, resolved, purpose)) return failure("access_denied", "Acquire this app before downloading its package, or use its authorized publisher/auditor review access.");
      List.add(ids, resolved.artifact.id);
    };
    let saved = must(Store.insertGrant(db, {
      owner; requestId = request.request_id; credentialHash; authorizationHash;
      paths = request.paths; delegate = null; artifactIds = List.toArray(ids);
      purpose; revoked = false; createdAtNs = now; updatedAtNs = now;
    }));
    #ok({ grant = saved; new = true });
  };

  public func grantAuthorizesPath(db : Store.DB, saved : Types.Grant, path : Text) : Bool {
    let ?resolved = resolveArtifactPath(db, path) else return false;
    if (saved.revoked) return false;
    var pathIncluded = false;
    for (selected in saved.paths.vals()) { if (selected == path) pathIncluded := true };
    if (not pathIncluded) return false;
    var artifactIncluded = false;
    for (id in saved.artifactIds.vals()) { if (id == resolved.artifact.id) artifactIncluded := true };
    if (not artifactIncluded) return false;
    switch (saved.delegate) {
      case (?browser) {
        let ?delegate = Store.getDelegate(db, browser) else return false;
        if (not delegate.active or delegate.owner != saved.owner) return false;
      };
      case null {};
    };
    accessPath(db, saved.owner, resolved, saved.purpose);
  };
  public func authorizeHttp(db : Store.DB, path : Text, bearer : ?Text) : Bool {
    let ?resolved = resolveArtifactPath(db, path) else return false;
    if (publicPath(db, resolved)) return true;
    let ?token = bearer else return false;
    if (not Encoding.isHex(token, 32)) return false;
    let ?saved = Store.getGrantByCredential(db, Encoding.hashText(token)) else return false;
    grantAuthorizesPath(db, saved, path);
  };
};
