// All rights reserved. See ../../LICENSE.
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Feedback "../../mo/Feedback";
import FeedbackStore "../../mo/FeedbackStore";
import PublisherStore "../../mo/PublisherStore";
import Store "../../mo/Store";
import Types "../../mo/Types";
import Fixtures "../motoko/Fixtures";

persistent actor {
  let memory = Fixtures.memory();
  let publisherMemory = PublisherStore.init();
  let feedbackMemory = FeedbackStore.init();
  transient let db = Store.Use(memory, publisherMemory);
  var stableHead : ?Nat64 = null;
  var betaHead : ?Nat64 = null;
  var seeded = false;
  transient let feedback = Feedback.Service(db, feedbackMemory, func(appId : Text, candidateId : Nat64, version : Nat, digest : Blob) : Bool {
    let ?candidate = Store.getCandidate(db, candidateId) else return false;
    candidate.appId == appId and candidate.version == version and candidate.digest == digest and (stableHead == ?candidateId or betaHead == ?candidateId);
  });

  func buyer(index : Nat) : Principal {
    switch (index) { case (0) Fixtures.owner(); case (1) Fixtures.auditor(); case (2) Fixtures.other(); case (_) Principal.fromText("aaaaa-aa") };
  };
  func release(candidateId : Nat64) : FeedbackStore.Release {
    let ?candidate = Store.getCandidate(db, candidateId) else Runtime.trap("Fixture candidate missing");
    { appId = candidate.appId; candidateId; version = candidate.version; digest = candidate.digest };
  };
  public func seed() : async [FeedbackStore.Release] {
    assert not seeded;
    ignore Fixtures.stored(Store.insertApp(db, {
      appId = "feedback-app"; owner = Fixtures.owner(); title = "Feedback"; summary = "Retained ratings"; description = "";
      priceUsdMicros = 0; revision = 1; approvedCandidate = null; visible = true;
      iconArtifact = null; screenshots = []; ratingCount = 3; ratingTotal = 11; createdAtNs = 1; updatedAtNs = 1;
    }));
    for ((index, stars) in [(0, 5), (1, 4), (2, 2)].vals()) {
      ignore Fixtures.stored(Store.insertEntitlement(db, { owner = buyer(index); appId = "feedback-app"; kind = #free; orderId = 1; acquiredAtNs = 1 }));
      ignore Fixtures.stored(Store.insertRating(db, { owner = buyer(index); appId = "feedback-app"; stars; review = "Unversioned historical text"; createdAtNs = 10; updatedAtNs = 11 }));
    };
    let artifact = Fixtures.upload(db, "feedback-app", "retained-package", #package);
    for ((version, requestId) in [(10, "stable"), (11, "beta"), (12, "next")].vals()) {
      ignore Fixtures.stored(Store.insertCandidate(db, {
        appId = "feedback-app"; version; publisher = Fixtures.owner(); requestId; listingRevision = 1;
        artifactId = artifact.id; sourceArtifactId = null; digest = artifact.digest; sourceDigest = null;
        dependencies = []; state = #approved; published = true; createdAtNs = 1; updatedAtNs = 1;
      }));
    };
    stableHead := ?1; betaHead := ?2; seeded := true;
    [release(1), release(2), release(3)];
  };
  public func advance(budget : Nat) : async Nat { feedback.advance(budget) };
  public func heads(nextStable : ?Nat64, nextBeta : ?Nat64) : async () { stableHead := nextStable; betaHead := nextBeta };
  public func cutover() : async () { feedback.activateLegacyTextCutover() };
  public func legacyRate(index : Nat, stars : Nat, review : Text, now : Int) : async Feedback.Result<Types.Rating> {
    feedback.setLegacyRating(buyer(index), "feedback-app", stars, review, now);
  };
  public func rate(index : Nat, stars : Nat, now : Int) : async Feedback.Result<Types.Rating> {
    feedback.setRating(buyer(index), "feedback-app", stars, now);
  };
  public func comment(index : Nat, input : FeedbackStore.Release, text : Text, now : Int) : async Feedback.Result<FeedbackStore.Comment> {
    feedback.commentSet(buyer(index), { input with text; feeVersion = 1 }, now);
  };
  public func removeComment(index : Nat, input : FeedbackStore.Release) : async Feedback.Result<()> { feedback.commentDelete(buyer(index), input) };
  public query func comments(index : ?Nat, input : FeedbackStore.Release, cursor : ?Nat64, limit : Nat) : async Feedback.Result<FeedbackStore.CommentPage> {
    feedback.comments(switch (index) { case null null; case (?value) ?buyer(value) }, { input with cursor; limit });
  };
  public query func snapshot() : async {
    histogram : Feedback.Result<FeedbackStore.Histogram>; maintenance : FeedbackStore.Maintenance;
    ratings : [Types.Rating]; comments : [FeedbackStore.Comment]; ownerIndexes : Nat; contributions : Nat;
    publisher : ?PublisherStore.Stats; entitlements : Nat;
  } {
    {
      histogram = feedback.histogram("feedback-app"); maintenance = feedbackMemory.maintenance;
      ratings = Iter.toArray(Iter.map(db.ratings.iterPrimary(#fwd, null), func((_, value) : (Nat64, Types.Rating)) : Types.Rating { value }));
      comments = Iter.toArray(Map.values(feedbackMemory.comments));
      ownerIndexes = Map.size(feedbackMemory.commentsByOwner); contributions = Map.size(feedbackMemory.contributions);
      publisher = db.publishers.publisherStats.by_owner.lookup(Fixtures.owner()); entitlements = db.entitlements.size();
    };
  };
};
