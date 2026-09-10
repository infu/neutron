// All rights reserved. See ../LICENSE.
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Store "./Store";
import Types "./Types";

module {
  func active(db : Store.DB, candidate : Types.Candidate) : Bool {
    // An in-flight audit retains its exact bytes even while another candidate
    // is published. The latest pointer also remains meaningful if revoked:
    // revocation must never fall back to an earlier release.
    if (candidate.state == #pending) return true;
    switch (Store.getApp(db, candidate.appId)) {
      case (?app) app.approvedCandidate == ?candidate.id;
      case null false;
    };
  };

  func uploadHasCandidate(db : Store.DB, upload : Types.Upload, id : Nat64) : Bool {
    let ?candidateId = upload.candidateId else return false;
    let ?candidate = Store.getCandidate(db, candidateId) else return false;
    if (candidate.appId != upload.appId or candidate.publisher != upload.owner) return false;
    switch (upload.purpose) {
      case (#package) candidate.artifactId == id;
      case (#source) candidate.sourceArtifactId == ?id;
      case (#image) false;
    };
  };

  func required(db : Store.DB, id : Nat64) : Bool {
    let range = { gt = null; gte = ?id; lt = null; lte = ?id; dir = #fwd };
    for (candidate in db.candidates.by_artifact.rangeIter(range, null)) {
      if (active(db, candidate)) return true;
    };
    for (candidate in db.candidates.by_source_artifact.rangeIter(range, null)) {
      if (active(db, candidate)) return true;
    };
    // A digest can be shared across roles. Package retention must not delete
    // an image or another publisher's upload awaiting candidate submission.
    if (db.apps.by_icon_artifact.rangeIter(range, null).next() != null) return true;
    if (db.apps.by_screenshot.rangeIter(range, null).next() != null) return true;
    for (upload in db.uploads.by_artifact.rangeIter(range, null)) {
      if (upload.state == #attached and (upload.purpose == #image or not uploadHasCandidate(db, upload, id))) return true;
    };
    false;
  };

  // Run after an audit decision and any new approved pointer are saved, without
  // an await. A rejected replacement releases its no-longer-pending reference.
  // Historical candidate/audit/ownership/payment records remain intact. Grants and saved
  // install manifests record the original identity; they do not pin old bytes.
  // The actor must remove the returned artifacts' certified paths in this same
  // update before replying. A failed storage/certification change must trap so
  // the approval, retirement, and HTTP proof tree roll back together.
  public func afterDecision(db : Store.DB, appId : Text) : [Types.Artifact] {
    let ?app = Store.getApp(db, appId) else return [];
    let ids = Set.empty<Nat64>();
    let range = { gt = null; gte = ?appId; lt = null; lte = ?appId; dir = #fwd };
    for (candidate in db.candidates.by_app.rangeIter(range, null)) {
      if (app.approvedCandidate != ?candidate.id and candidate.state != #pending) {
        Set.add(ids, Nat64.compare, candidate.artifactId);
        switch (candidate.sourceArtifactId) { case (?id) Set.add(ids, Nat64.compare, id); case null {} };
      };
    };
    let retired = List.empty<Types.Artifact>();
    for (id in Set.values(ids)) {
      if (not required(db, id)) {
        switch (Store.getArtifact(db, id)) {
          case null {};
          case (?artifact) {
            // Generated deletion drops the digest index and releases the
            // table-owned blob allocation; deleting metadata alone would leak.
            switch (db.artifacts.delete(id)) {
              case (#ok(())) List.add(retired, artifact);
              case (#err(error)) Runtime.trap("Artifact retirement failed: " # debug_show(error));
            };
          };
        };
      };
    };
    List.toArray(retired);
  };
};
