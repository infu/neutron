// All rights reserved. See ../LICENSE.
import List "mo:core/List";
import Runtime "mo:core/Runtime";
import API "./API";
import Certification "./Certification";
import Http "./Http";
import Rankings "./Rankings";
import ReleaseStore "./ReleaseStore";
import Repository "./Repository";
import Retention "./Retention";
import Store "./Store";
import Types "./Types";

module {
  public type Effects = { appIds : [Text]; retiredArtifacts : [Types.Artifact] };

  // Audit validation and its durable decision precede this transition. Only
  // this module advances channel heads and applies their derived state. No
  // await may separate these writes from Projection.certify at the actor edge.
  public func afterAudit(db : Store.DB, app : Types.App, candidate : Types.Candidate, decision : { #approved; #rejected; #revoked }, publicationChanged : Bool) : [Types.Artifact] {
    let heads = ReleaseStore.heads(db.channels, app.appId);
    switch (decision) {
      case (#approved) if (publicationChanged) {
        ReleaseStore.putHeads(db.channels, app.appId, { heads with betaHead = { candidateId = ?candidate.id; revision = heads.betaHead.revision + 1 } });
      };
      case (#revoked) {
        // Revocation retains identity while invalidating its offered evidence.
        ReleaseStore.putHeads(db.channels, app.appId, {
          stableHead = if (heads.stableHead.candidateId == ?candidate.id) ({ heads.stableHead with revision = heads.stableHead.revision + 1 }) else heads.stableHead;
          betaHead = if (heads.betaHead.candidateId == ?candidate.id) ({ heads.betaHead with revision = heads.betaHead.revision + 1 }) else heads.betaHead;
        });
      };
      case (#rejected) {};
    };
    Rankings.refreshEligibility(db, app);
    Retention.afterDecision(db, app.appId);
  };

  // The batch owner validates every expected head and dependency before calling
  // this function. Retire only after every stable head has advanced, so shared
  // package/source bytes see the resulting batch as one synchronous change.
  public func promote(db : Store.DB, entries : [API.PromotionEntry], now : Int) : Effects {
    let appIds = List.empty<Text>();
    for (entry in entries.vals()) {
      let heads = ReleaseStore.heads(db.channels, entry.appId);
      if (heads.stableHead.candidateId != ?entry.candidateId) {
        ReleaseStore.putHeads(db.channels, entry.appId, { heads with stableHead = { candidateId = ?entry.candidateId; revision = heads.stableHead.revision + 1 } });
        let ?app = Store.getApp(db, entry.appId) else Runtime.trap("Promotion app disappeared without await");
        switch (db.apps.update({ app with updatedAtNs = now })) {
          case (#ok(value)) Rankings.refreshEligibility(db, value);
          case (#err(value)) Runtime.trap(debug_show(value));
        };
        List.add(appIds, entry.appId);
      };
    };
    let retired = List.empty<Types.Artifact>();
    for (appId in List.values(appIds)) {
      for (artifact in Retention.afterDecision(db, appId).vals()) List.add(retired, artifact);
    };
    { appIds = List.toArray(appIds); retiredArtifacts = List.toArray(retired) };
  };

  // One concrete projection keeps the repository's channel metadata and the
  // package authorization tree synchronized. It also serves listing/ownership
  // changes that affect the same certified resources without moving a head.
  public class Projection(http : Http.Store, repository : Repository.Service, certificates : Certification.Service) {
    public func refreshApp(appId : Text) {
      repository.refreshApp(http, appId);
      certificates.refreshApp(appId);
    };
    public func certify(effects : Effects) {
      certificates.removeArtifacts(effects.retiredArtifacts);
      for (appId in effects.appIds.vals()) refreshApp(appId);
    };
  };
};
