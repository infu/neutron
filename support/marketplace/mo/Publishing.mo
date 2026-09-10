// All rights reserved. See ../LICENSE.
import Catalog "Catalog";
import Store "Store";
import Types "Types";
import API "API";
import Runtime "mo:core/Runtime";
import List "mo:core/List";

module {
  public type Result<T> = { #ok : T; #err : Text };

  public func validReleaseVersion(version : Nat) : Bool { version >= 100 and version <= 9_007_199_254_740_991 };
  public let maxPackageBytes : Nat = 33_554_432;

  public func validateCandidate(
    requestId : Text,
    packageDigest : Blob,
    sourceDigest : Blob,
    packageSize : Nat,
    sourceSize : Nat,
  ) : Result<()> {
    if (not Catalog.hasText(requestId)) return #err("A publication request ID is required for safe retry.");
    if (packageDigest.size() != 32 or sourceDigest.size() != 32) return #err("Packages and offered source must have exact SHA-256 digests.");
    if (packageSize > maxPackageBytes) return #err("A package exceeds Neutron’s existing 32 MiB package limit.");
    if (packageSize == 0 or sourceSize == 0) return #err("Complete the package and offered-source uploads before submitting for review.");
    #ok(());
  };

  func must<T>(value : { #ok : T; #err : Types.Error }) : T {
    switch (value) { case (#ok(result)) result; case (#err(error)) Runtime.trap("Publishing storage invariant: " # debug_show(error)) };
  };

  func ownedUpload(db : Store.DB, owner : Principal, appId : Text, artifactId : Nat64, purpose : { #package; #source; #image }) : Bool {
    for (upload in db.uploads.by_artifact.rangeIter({ gt = null; gte = ?artifactId; lt = null; lte = ?artifactId; dir = #fwd }, null)) {
      if (upload.owner == owner and upload.appId == appId and upload.artifactId == ?artifactId and upload.purpose == purpose and upload.state == #attached) return true;
    };
    false;
  };

  public func highestPublishedVersion(db : Store.DB, appId : Text) : ?Nat {
    var highest : ?Nat = null;
    for (candidate in db.candidates.by_app_version.rangeIter({ gt = null; gte = ?(appId, 0); lt = null; lte = null; dir = #fwd }, null)) {
      if (candidate.appId != appId) return highest;
      if (candidate.published) {
        switch (highest) { case null highest := ?candidate.version; case (?value) { if (candidate.version > value) highest := ?candidate.version } };
      };
    };
    highest;
  };

  public func submit(db : Store.DB, caller : Principal, input : API.CandidateRequest, now : Int) : Result<Types.Candidate> {
    if (not Catalog.hasText(input.requestId)) return #err("A publication request ID is required for safe retry.");
    if (not validReleaseVersion(input.version)) return #err("Use a packed app release version from 100 through 9007199254740991.");
    let ?app = db.apps.by_appId.lookup(input.appId) else return #err("Create the app listing before submitting a package.");
    if (app.owner != caller) return #err("Only this app's publisher can submit a package.");
    switch (db.candidates.by_request.lookup((caller, input.requestId))) {
      case (?saved) {
        if (saved.appId != input.appId or saved.version != input.version or saved.artifactId != input.artifactId or
          saved.sourceArtifactId != input.sourceArtifactId or saved.dependencies != input.dependencies) {
          return #err("This publication request ID already names a different immutable candidate.");
        };
        return #ok(saved);
      };
      case null {};
    };
    switch (highestPublishedVersion(db, input.appId)) {
      case (?version) { if (input.version <= version) return #err("A changed published package requires a strictly higher app release version.") };
      case null {};
    };
    if (not ownedUpload(db, caller, input.appId, input.artifactId, #package)) return #err("The package must be a completed upload for this app by its publisher.");
    let ?artifact = db.artifacts.get(input.artifactId) else return #err("The package upload is unavailable.");
    if (artifact.size > 33_554_432) return #err("A package exceeds Neutron’s existing 32 MiB package limit.");
    if (artifact.digest.size() != 32 or artifact.size == 0) return #err("The package upload lacks complete SHA-256 and size evidence.");
    let sourceDigest = switch (input.sourceArtifactId) {
      case null null;
      case (?artifactId) {
        if (not ownedUpload(db, caller, input.appId, artifactId, #source)) return #err("Offered source must be a completed source upload for this app by its publisher.");
        let ?source = db.artifacts.get(artifactId) else return #err("The offered-source upload is unavailable.");
        if (source.digest.size() != 32 or source.size == 0) return #err("The offered-source upload lacks complete SHA-256 and size evidence.");
        ?source.digest;
      };
    };
    let seen = List.empty<Text>();
    for (dependency in input.dependencies.vals()) {
      if (not validReleaseVersion(dependency.minVersion)) return #err("Dependency minimum versions must use the supported packed app release format.");
      if (not Catalog.validAppId(dependency.appId) or dependency.appId == input.appId) return #err("Package dependencies must name other valid app IDs.");
      for (appId in List.values(seen)) { if (appId == dependency.appId) return #err("Each package dependency must appear once.") };
      List.add(seen, dependency.appId);
    };
    let id = must(db.candidates.insert({
      appId = input.appId; version = input.version; publisher = caller; requestId = input.requestId;
      listingRevision = app.revision; artifactId = input.artifactId; sourceArtifactId = input.sourceArtifactId;
      digest = artifact.digest; sourceDigest; dependencies = input.dependencies;
      state = #pending; published = false; createdAtNs = now; updatedAtNs = now;
    }));
    switch (db.candidates.get(id)) { case (?candidate) #ok(candidate); case null Runtime.trap("Submitted candidate missing") };
  };
}
