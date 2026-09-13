// All rights reserved. See ../LICENSE.
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Access "./Access";
import API "./API";
import Audits "./Audits";
import Catalog "./Catalog";
import Dependencies "./Dependencies";
import Store "./Store";
import Types "./Types";
import ReleaseStore "./ReleaseStore";
import ReleaseTransitions "./ReleaseTransitions";
import Map "mo:core/Map";
import Text "mo:core/Text";

module {
  public type Published = { batch : Types.PublishBatch; retiredArtifacts : [Types.Artifact]; appIds : [Text] };
  public type Promoted = { receipt : API.PromotionReceipt; retiredArtifacts : [Types.Artifact]; appIds : [Text] };
  func error<T>(code : Text, message : Text) : API.Result<T> { #err({ code; message }) };

  public func preparePromotion(db : Store.DB, caller : Principal, input : API.PromotionPrepare) : API.Result<API.PromotionPlan> {
    if (input.appIds.size() == 0) return error("invalid_request", "Select at least one app to release.");
    let entries = List.empty<API.PromotionEntry>();
    for (appId in input.appIds.vals()) {
      for (entry in List.values(entries)) if (entry.appId == appId) return error("duplicate_app", "Select each app once.");
      let ?app = Store.getApp(db, appId) else return error("release_unavailable", "This app does not exist.");
      if (app.owner != caller) return error("publisher_required", "Release only apps owned by this publisher.");
      let heads = ReleaseStore.heads(db.channels, appId);
      let ?candidate = Catalog.atHead(db, app, heads.betaHead) else return error("release_unavailable", "This app has no approved current beta.");
      let ?artifact = Store.getArtifact(db, candidate.artifactId) else return error("release_unavailable", "The beta package is unavailable.");
      let sourceSize = switch (candidate.sourceArtifactId) {
        case null null;
        case (?id) { let ?source = Store.getArtifact(db, id) else return error("release_unavailable", "The beta source is unavailable."); ?source.size };
      };
      List.add(entries, {
        appId; candidateId = candidate.id; version = candidate.version; digest = candidate.digest; sourceDigest = candidate.sourceDigest;
        packageSize = artifact.size; sourceSize; dependencies = candidate.dependencies;
        expectedBetaRevision = heads.betaHead.revision; expectedStableCandidate = heads.stableHead.candidateId; expectedStableRevision = heads.stableHead.revision;
      });
    };
    #ok({ entries = List.toArray(entries) });
  };

  public func promote(db : Store.DB, caller : Principal, input : API.PromotionRequest, now : Int) : API.Result<Promoted> {
    if (not Catalog.hasText(input.requestId) or input.entries.size() == 0) return error("invalid_request", "A request ID and exact beta selection are required.");
    switch (Map.get(db.channels.promotions, ReleaseStore.requestCompare, (caller, input.requestId))) {
      case (?receipt) {
        if (receipt.entries != input.entries) return error("request_conflict", "This request already identifies a different exact promotion.");
        return #ok({ receipt; retiredArtifacts = []; appIds = [] });
      };
      case null {};
    };
    let selected = Map.empty<Text, Types.Candidate>();
    var changed = false;
    for (entry in input.entries.vals()) {
      if (Map.containsKey(selected, Text.compare, entry.appId)) return error("duplicate_app", "Select one current beta per app.");
      let ?app = Store.getApp(db, entry.appId) else return error("release_unavailable", "A selected app does not exist.");
      if (app.owner != caller) return error("publisher_required", "Release only apps owned by this publisher.");
      let heads = ReleaseStore.heads(db.channels, entry.appId);
      if (heads.betaHead.candidateId != ?entry.candidateId or heads.betaHead.revision != entry.expectedBetaRevision or
          heads.stableHead.candidateId != entry.expectedStableCandidate or heads.stableHead.revision != entry.expectedStableRevision) {
        return error("channel_conflict", "The stable or beta release changed. Review the current beta again.");
      };
      let ?candidate = Catalog.atHead(db, app, heads.betaHead) else return error("release_unavailable", "A selected beta is no longer approved.");
      if (candidate.publisher != caller or candidate.version != entry.version or candidate.digest != entry.digest or
          candidate.sourceDigest != entry.sourceDigest or candidate.dependencies != entry.dependencies) return error("request_conflict", "The selected beta identity does not match the frozen release request.");
      let ?artifact = Store.getArtifact(db, candidate.artifactId) else return error("release_unavailable", "A selected package is unavailable.");
      if (artifact.digest != entry.digest or artifact.size != entry.packageSize) return error("release_unavailable", "The selected package evidence changed.");
      switch (candidate.sourceArtifactId, entry.sourceDigest, entry.sourceSize) {
        case (null, null, null) {};
        case (?id, ?digest, ?size) {
          let ?source = Store.getArtifact(db, id) else return error("release_unavailable", "The selected offered source is unavailable.");
          if (source.digest != digest or source.size != size) return error("release_unavailable", "The offered-source evidence changed.");
        };
        case _ return error("request_conflict", "The selected offered-source identity is incomplete.");
      };
      if (heads.stableHead.candidateId != ?candidate.id) {
        switch (heads.stableHead.candidateId) {
          case null {};
          case (?id) {
            let ?stableCandidate = Store.getCandidate(db, id) else return error("release_unavailable", "The retained stable candidate is missing.");
            if (candidate.version <= stableCandidate.version) return error("channel_conflict", "A stable promotion must advance the release version.");
          };
        };
        changed := true;
      };
      Map.add(selected, Text.compare, entry.appId, candidate);
    };
    switch (Dependencies.promotion(db, selected)) { case (#err(value)) return #err(value); case (_) {} };
    let receipt : API.PromotionReceipt = { id = if (changed) db.channels.nextPromotionId else 0; owner = caller; publisher = caller; requestId = input.requestId; operation = "promote"; channel = "stable"; entries = input.entries; createdAtNs = now };
    if (not changed) {
      // A no-op still binds its caller's retry identity. Keep its id zero so it
      // cannot be mistaken for a new publication transaction.
      Map.add(db.channels.promotions, ReleaseStore.requestCompare, (caller, input.requestId), receipt);
      return #ok({ receipt; retiredArtifacts = []; appIds = [] });
    };
    let effects = ReleaseTransitions.promote(db, input.entries, now);
    db.channels.nextPromotionId += 1;
    Map.add(db.channels.promotions, ReleaseStore.requestCompare, (caller, input.requestId), receipt);
    #ok({ effects with receipt });
  };

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
      if (candidate.published and not ReleaseStore.references(db.channels, candidate.appId, candidate.id)) return error("candidate_superseded", "A selected release has already been superseded. Its historical batch receipt does not republish it.");
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
