// All rights reserved. See ../LICENSE.
import Nat64 "mo:core/Nat64";
import Set "mo:core/Set";
import Access "./Access";
import Http "./Http";
import Store "./Store";
import Types "./Types";

module {
  // Use the existing repository's 1 MiB query chunks. This splits transport
  // messages without limiting the size of an application or source artifact.
  public let CHUNK_BYTES : Nat = 1_048_576;

  public func artifact(db : Store.DB, path : Text) : ?Http.Artifact {
    let ?resolved = Access.resolveArtifactPath(db, path) else return null;
    let value = resolved.artifact;
    let size = Nat64.toNat(value.size);
    // Artifact routes carry fixed repository formats. Browsers often upload
    // .neutron files without a MIME type; their filename metadata cannot change
    // the certified package/source content type expected by existing clients.
    let contentType = switch (resolved.purpose) {
      case (#package) "application/vnd.neutron.package";
      case (#source) "application/gzip";
      case (#image) value.mediaType;
    };
    ?{
      path; sha256 = value.digest; size; contentType;
      chunks = if (size == 0) 1 else (size + CHUNK_BYTES - 1) / CHUNK_BYTES;
      publicAccess = Access.isPublicPath(db, path); immutable = true;
    };
  };

  // Http.Store has already checked current authorization before it invokes
  // this callback. No actor exposes this raw reader as a separate endpoint.
  public func chunk(db : Store.DB, path : Text, index : Nat) : ?Blob {
    let ?resolved = Access.resolveArtifactPath(db, path) else return null;
    let value = resolved.artifact;
    let size = Nat64.toNat(value.size);
    if (size == 0 and index == 0) return ?("" : Blob);
    let offset = index * CHUNK_BYTES;
    if (offset >= size) return null;
    let remaining = size - offset;
    let length = if (remaining < CHUNK_BYTES) remaining else CHUNK_BYTES;
    switch (Store.readBlob(db, value.content, Nat64.fromNat(offset), length)) {
      case (#ok(bytes)) ?bytes;
      case (#err(_)) null;
    };
  };

  public class Service(db : Store.DB, http : Http.Store) {
    func refreshOne(id : Nat64) {
      let ?value = Store.getArtifact(db, id) else return;
      // Every canonical spelling starts from fixed certified denial. Only
      // currently public paths or eligible exact grants acquire a success leaf.
      for (kind in ([#package, #source, #image] : [Access.ArtifactKind]).vals()) {
        let path = Access.artifactPath(value, kind);
        let ?resource = artifact(db, path) else return;
        http.configureArtifact(resource);
        if (not resource.publicAccess) {
          let range = { gt = null; gte = ?id; lt = null; lte = ?id; dir = #fwd };
          for (grant in db.grants.by_artifact.rangeIter(range, null)) {
            if (Access.grantAuthorizesPath(db, grant, path)) {
              http.certifyGrantHash(resource, grant.authorizationHash);
            };
          };
        };
      };
    };
    public func refreshArtifact(id : Nat64) {
      refreshOne(id);
      http.commitCertification();
    };
    public func removeArtifacts(retired : [Types.Artifact]) {
      for (value in retired.vals()) {
        switch (Store.getArtifactByDigest(db, value.digest)) {
          // A digest may be uploaded again after retirement. A delayed or
          // repeated cleanup must preserve its current authorization tree.
          case (?current) refreshOne(current.id);
          case null {
            for (kind in ([#package, #source, #image] : [Access.ArtifactKind]).vals()) {
              http.removeArtifact(Access.artifactPath(value, kind));
            };
          };
        };
      };
      http.commitCertification();
    };
    public func refreshGrant(grant : Types.Grant) {
      let ids = Set.empty<Nat64>();
      for (id in grant.artifactIds.vals()) Set.add(ids, Nat64.compare, id);
      for (id in Set.values(ids)) refreshOne(id);
      http.commitCertification();
    };
    public func refreshApp(appId : Text) {
      let ids = Set.empty<Nat64>();
      let range = { gt = null; gte = ?appId; lt = null; lte = ?appId; dir = #fwd };
      for (candidate in db.candidates.by_app.rangeIter(range, null)) {
        Set.add(ids, Nat64.compare, candidate.artifactId);
        switch (candidate.sourceArtifactId) { case (?id) Set.add(ids, Nat64.compare, id); case null {} };
      };
      // Include old image references too: replacing an image must remove the
      // old public response leaf in the same update that changes the listing.
      for (listing in db.listings.by_app.rangeIter(range, null)) {
        switch (listing.iconArtifact) { case (?id) Set.add(ids, Nat64.compare, id); case null {} };
        for (id in listing.screenshots.vals()) Set.add(ids, Nat64.compare, id);
      };
      switch (Store.getApp(db, appId)) {
        case (?app) {
          switch (app.iconArtifact) { case (?id) Set.add(ids, Nat64.compare, id); case null {} };
          for (id in app.screenshots.vals()) Set.add(ids, Nat64.compare, id);
        };
        case null {};
      };
      for (id in Set.values(ids)) refreshOne(id);
      http.commitCertification();
    };
    public func refreshAllGrants() {
      let ids = Set.empty<Nat64>();
      for ((_, grant) in db.grants.iterPrimary(#fwd, null)) {
        for (id in grant.artifactIds.vals()) Set.add(ids, Nat64.compare, id);
      };
      for (id in Set.values(ids)) refreshOne(id);
      http.commitCertification();
    };
    public func refreshOwnerGrants(owner : Principal) {
      let ids = Set.empty<Nat64>();
      let range = { gt = null; gte = ?owner; lt = null; lte = ?owner; dir = #fwd };
      for (grant in db.grants.by_owner.rangeIter(range, null)) {
        for (id in grant.artifactIds.vals()) Set.add(ids, Nat64.compare, id);
      };
      for (id in Set.values(ids)) refreshOne(id);
      http.commitCertification();
    };
  };
};
