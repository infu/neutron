// All rights reserved. See ../LICENSE.
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Access "./Access";
import API "./API";
import Audits "./Audits";
import Catalog "./Catalog";
import Store "./Store";
import Types "./Types";

module {
  public type Published = { batch : Types.PublishBatch; retiredArtifacts : [Types.Artifact]; appIds : [Text] };
  func error<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };

  func matches(saved : Types.PublishBatch, input : API.TrustedPublishRequest) : Bool {
    if (saved.analysis != input.analysis or saved.entries.size() != input.candidates.size()) return false;
    var index = 0;
    for (entry in saved.entries.vals()) {
      let selected = input.candidates[index];
      if (entry.candidateId != selected.candidateId or entry.digest != selected.expectedDigest or entry.sourceDigest != selected.expectedSourceDigest) return false;
      index += 1;
    };
    true;
  };

  // No await is permitted in this transaction: the selected Kernel and apps
  // become public together, and their replaced blob bytes retire together.
  public func publish(db : Store.DB, caller : Principal, input : API.TrustedPublishRequest, now : Int) : API.Result<Published> {
    if (not Access.isTrustedPublisher(db, caller)) return error("trusted_publisher_required", "Only the configured first-party publishing identity can automatically publish its packages.");
    if (not Catalog.hasText(input.requestId)) return error("request_id", "A publication batch request ID is required for safe retry.");
    if (not Catalog.hasText(input.analysis)) return error("verification_required", "Describe the automated artifact checks performed for these exact packages.");
    if (input.candidates.size() == 0) return error("empty_batch", "Select at least one verified first-party package candidate.");
    switch (Store.getPublishBatch(db, caller, input.requestId)) {
      case (?saved) {
        if (saved.publisher != caller or not matches(saved, input)) return error("request_conflict", "This publication batch ID already names a different immutable candidate selection or verification report.");
        // The retained receipt describes that committed transaction even if a
        // later batch has superseded its files. It never republishes old bytes.
        return #ok({ batch = saved; retiredArtifacts = []; appIds = [] });
      };
      case null {};
    };
    let candidates = List.empty<Types.Candidate>();
    for (selected in input.candidates.vals()) {
      let ?candidate = db.candidates.get(selected.candidateId) else return error("candidate_missing", "A selected package candidate does not exist.");
      if (candidate.publisher != caller) return error("publisher_required", "Automatic publication applies only to this identity's own package candidates.");
      let ?app = Store.getApp(db, candidate.appId) else return error("app_missing", "A selected package has no app listing.");
      if (app.owner != caller) return error("publisher_required", "The selected app belongs to another publisher.");
      if (candidate.digest != selected.expectedDigest or candidate.sourceDigest != selected.expectedSourceDigest) return error("digest_mismatch", "A selected package or offered source differs from the exact bytes verified by the publishing script.");
      if (candidate.state != #pending and candidate.state != #approved) return error("candidate_state", "A rejected or revoked candidate cannot be automatically republished. Submit a new candidate.");
      if (candidate.published and app.approvedCandidate != ?candidate.id) return error("candidate_superseded", "A selected release has already been superseded. Its historical batch receipt does not republish it.");
      for (previous in List.values(candidates)) {
        if (previous.appId == candidate.appId) return error("duplicate_app", "Select one package candidate per app in an atomic publication batch.");
      };
      List.add(candidates, candidate);
    };
    let entries = List.empty<{ candidateId : Nat64; appId : Text; version : Nat; digest : Blob; sourceDigest : ?Blob; auditId : Nat64 }>();
    let retired = List.empty<Types.Artifact>();
    let appIds = List.empty<Text>();
    for (candidate in List.values(candidates)) {
      let result = switch (Audits.approveTrusted(db, caller, {
        requestId = "trusted-batch:" # input.requestId # ":" # Nat64.toText(candidate.id);
        candidateId = candidate.id; expectedDigest = candidate.digest; expectedSourceDigest = candidate.sourceDigest;
        decision = #approved; analysis = "Automated first-party artifact verification. " # input.analysis; reason = null;
      }, now)) {
        case (#ok(value)) value;
        // A later approval failure must roll back earlier approvals and blob
        // retirement in this message. Returning #err here would retain a prefix.
        case (#err(message)) Runtime.trap("The publication batch was not committed: " # message);
      };
      List.add(entries, {
        candidateId = candidate.id; appId = candidate.appId; version = candidate.version;
        digest = candidate.digest; sourceDigest = candidate.sourceDigest; auditId = result.audit.id;
      });
      List.add(appIds, candidate.appId);
      for (artifact in result.retiredArtifacts.vals()) List.add(retired, artifact);
    };
    let batch = switch (Store.insertPublishBatch(db, {
      owner = caller; publisher = caller; requestId = input.requestId;
      entries = List.toArray(entries); analysis = input.analysis; createdAtNs = now;
    })) {
      case (#ok(value)) value;
      case (#err(detail)) Runtime.trap("The publication batch receipt could not be saved: " # debug_show(detail));
    };
    #ok({ batch; retiredArtifacts = List.toArray(retired); appIds = List.toArray(appIds) });
  };
};
