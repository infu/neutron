// All rights reserved. See ../LICENSE.
import Catalog "Catalog";
import Publishing "Publishing";
import Rankings "Rankings";
import Retention "Retention";
import Store "Store";
import Types "Types";
import API "API";
import Access "Access";
import Runtime "mo:core/Runtime";
import List "mo:core/List";

module {
  public type Decision = { #approved; #rejected; #revoked };
  public type Result<T> = { #ok : T; #err : Text };

  public func validateStamp(requestId : Text, decision : Decision, analysis : Text, reason : Text) : Result<()> {
    if (not Catalog.hasText(requestId)) return #err("An audit request ID is required for safe retry.");
    if (not Catalog.hasText(analysis)) return #err("Describe what was inspected in the audit analysis.");
    switch (decision) {
      case (#approved) {};
      case (#rejected) {
        if (not Catalog.hasText(reason)) return #err("A rejection reason is required.");
      };
      case (#revoked) {
        if (not Catalog.hasText(reason)) return #err("A revocation reason is required.");
      };
    };
    #ok(());
  };

  public type StampResult = { audit : Types.Audit; candidate : Types.Candidate; app : Types.App; publicationChanged : Bool; retiredArtifacts : [Types.Artifact] };

  func must<T>(value : { #ok : T; #err : Types.Error }) : T {
    switch (value) { case (#ok(result)) result; case (#err(error)) Runtime.trap("Audit storage invariant: " # debug_show(error)) };
  };

  public func assigned(db : Store.DB, caller : Principal) : Bool {
    for (auditor in Store.config(db).auditors.vals()) { if (auditor == caller) return true };
    false;
  };

  public func stamp(db : Store.DB, caller : Principal, input : API.AuditRequest, now : Int) : Result<StampResult> {
    if (not assigned(db, caller)) return #err("Only an assigned auditor can submit a package audit.");
    stampChecked(db, caller, input, now);
  };

  // The first-party publishing identity can automatically approve only its own
  // exact candidate bytes. Administrative/auditor roles confer no such bypass.
  public func approveTrusted(db : Store.DB, caller : Principal, input : API.AuditRequest, now : Int) : Result<StampResult> {
    if (not Access.isTrustedPublisher(db, caller)) return #err("Only the configured first-party publisher can automatically approve its packages.");
    let ?candidate = db.candidates.get(input.candidateId) else return #err("This package candidate does not exist.");
    if (candidate.publisher != caller or input.decision != #approved) return #err("Automatic approval applies only to the caller's own first-party package candidates.");
    stampChecked(db, caller, input, now);
  };

  func stampChecked(db : Store.DB, caller : Principal, input : API.AuditRequest, now : Int) : Result<StampResult> {
    let reason = switch (input.reason) { case null ""; case (?value) value };
    switch (validateStamp(input.requestId, input.decision, input.analysis, reason)) {
      case (#err(error)) return #err(error); case (#ok(())) {};
    };
    let ?candidate = db.candidates.get(input.candidateId) else return #err("This package candidate does not exist.");
    if (candidate.digest != input.expectedDigest or candidate.sourceDigest != input.expectedSourceDigest) {
      return #err("This candidate does not match the package and offered-source hashes inspected by the auditor.");
    };
    let ?app = db.apps.by_appId.lookup(candidate.appId) else return #err("This candidate's app listing does not exist.");
    switch (db.audits.by_request.lookup((caller, input.requestId))) {
      case (?existing) {
        if (existing.candidateId != input.candidateId or existing.decision != input.decision or
          existing.analysis != input.analysis or existing.reason != input.reason) {
          return #err("This audit request ID already has a different retained decision.");
        };
        return #ok({ audit = existing; candidate; app; publicationChanged = false; retiredArtifacts = [] });
      };
      case null {};
    };
    var publicationChanged = false;
    var nextApp = app;
    let nextCandidate : Types.Candidate = switch (input.decision) {
      case (#approved) {
        if (not Publishing.validReleaseVersion(candidate.version)) return #err("This candidate has an unsupported packed app release version.");
        for (dependency in candidate.dependencies.vals()) {
          if (not Publishing.validReleaseVersion(dependency.minVersion)) return #err("This candidate has an unsupported dependency version.");
        };
        if (candidate.state != #pending and candidate.state != #approved) return #err("Submit a new candidate to review rejected or revoked package bytes.");
        if (not candidate.published) {
          switch (Publishing.highestPublishedVersion(db, candidate.appId)) {
            case (?version) { if (candidate.version <= version) return #err("A published release already uses this version or a higher version.") };
            case null {};
          };
          let ?artifact = db.artifacts.get(candidate.artifactId) else return #err("The candidate package artifact is unavailable.");
          if (artifact.size == 0 or artifact.size > 33_554_432) return #err("This candidate is outside Neutron’s supported package size.");
          if (artifact.digest != candidate.digest) return #err("The candidate package bytes no longer match the review identity.");
          switch (candidate.sourceArtifactId, candidate.sourceDigest) {
            case (null, null) {};
            case (?sourceId, ?digest) {
              let ?source = db.artifacts.get(sourceId) else return #err("The offered-source artifact is unavailable.");
              if (source.digest != digest) return #err("The offered source no longer matches the review identity.");
            };
            case _ return #err("The candidate offered-source identity is incomplete.");
          };
          nextApp := { app with approvedCandidate = ?candidate.id; updatedAtNs = now };
          publicationChanged := true;
        };
        { candidate with state = #approved; published = true; updatedAtNs = now };
      };
      case (#rejected) {
        if (candidate.state != #pending or candidate.published) return #err("Only an unpublished pending candidate can be rejected; revoke a published release separately.");
        { candidate with state = #rejected; updatedAtNs = now };
      };
      case (#revoked) {
        if (not candidate.published or candidate.state != #approved) return #err("Only an approved published release can be revoked.");
        // Retain the latest pointer. Falling back to old bytes would silently
        // downgrade repository clients; the publisher must issue a successor.
        if (app.approvedCandidate == ?candidate.id) nextApp := { app with updatedAtNs = now };
        publicationChanged := true;
        { candidate with state = #revoked; updatedAtNs = now };
      };
    };
    let auditId = must(db.audits.insert({
      auditor = caller; requestId = input.requestId; candidateId = candidate.id;
      decision = input.decision; analysis = input.analysis; reason = input.reason; createdAtNs = now;
    }));
    let savedCandidate = must(db.candidates.update(nextCandidate));
    let savedApp = if (nextApp != app) must(db.apps.update(nextApp)) else app;
    Rankings.refreshEligibility(db, savedApp);
    let ?audit = db.audits.get(auditId) else Runtime.trap("Saved audit missing");
    let retiredArtifacts = Retention.afterDecision(db, savedApp.appId);
    #ok({ audit; candidate = savedCandidate; app = savedApp; publicationChanged; retiredArtifacts });
  };

  public func queue(db : Store.DB, caller : Principal, after : ?Nat64, limit : Nat) : Result<API.CandidatePage> {
    if (not assigned(db, caller)) return #err("Only an assigned auditor can inspect the review queue.");
    if (limit == 0) return #err("Choose a positive review page size.");
    let pending = List.empty<Types.Candidate>();
    var last = after;
    for (candidate in db.candidates.by_state.rangeIter({ gt = null; gte = ?#pending; lt = null; lte = ?#pending; dir = #fwd }, null)) {
      let shouldInclude = switch (after) { case null true; case (?id) candidate.id > id };
      if (shouldInclude) {
        if (List.size(pending) >= limit) return #ok({ candidates = List.toArray(pending); nextCursor = last });
        List.add(pending, candidate);
        last := ?candidate.id;
      };
    };
    #ok({ candidates = List.toArray(pending); nextCursor = null });
  };
}
