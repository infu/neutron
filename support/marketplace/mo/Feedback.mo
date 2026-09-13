// All rights reserved. See ../LICENSE.
import List "mo:core/List";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import FeedbackStore "FeedbackStore";
import Ratings "Ratings";
import Store "Store";
import Types "Types";

module {
  public type Result<T> = { #ok : T; #err : { code : Text; message : Text } };
  public type Offered = (Text, Nat64, Nat, Blob) -> Bool;
  func failure<T>(code : Text, message : Text) : Result<T> { #err({ code; message }) };
  func buckets() : FeedbackStore.Buckets { { five = 0; four = 0; three = 0; two = 0; one = 0 } };

  public class Service(db : Store.DB, memory : FeedbackStore.Mem, offered : Offered) {
    func savedBuckets(appId : Text) : FeedbackStore.Buckets {
      switch (Map.get(memory.histograms, Text.compare, appId)) { case null buckets(); case (?value) value };
    };
    func changeBucket(value : FeedbackStore.Buckets, stars : Nat, add : Bool) : FeedbackStore.Buckets {
      func change(count : Nat) : Nat {
        if (add) count + 1 else {
          if (count == 0) Runtime.trap("Feedback rating bucket is inconsistent");
          count - 1;
        };
      };
      switch (stars) {
        case (5) ({ value with five = change(value.five) });
        case (4) ({ value with four = change(value.four) });
        case (3) ({ value with three = change(value.three) });
        case (2) ({ value with two = change(value.two) });
        case (1) ({ value with one = change(value.one) });
        case (_) Runtime.trap("Retained rating is outside the supported star range");
      };
    };

    // Replace the last contribution actually counted in this new root. An edit
    // before the backfill cursor arrives establishes a baseline; backfill then
    // sees the same baseline and cannot count the owner again.
    func syncRating(rating : Types.Rating) {
      var value = savedBuckets(rating.appId);
      switch (Map.get(memory.contributions, Nat64.compare, rating.id)) {
        case (?previous) {
          if (previous.appId != rating.appId) Runtime.trap("A retained rating changed app identity");
          if (previous.stars == rating.stars) return;
          value := changeBucket(value, previous.stars, false);
        };
        case null {};
      };
      value := changeBucket(value, rating.stars, true);
      Map.add(memory.histograms, Text.compare, rating.appId, value);
      Map.add(memory.contributions, Nat64.compare, rating.id, { appId = rating.appId; stars = rating.stars });
    };

    public func histogram(appId : Text) : Result<FeedbackStore.Histogram> {
      let ?app = Store.getApp(db, appId) else return failure("app_missing", "This app could not be found.");
      #ok({ savedBuckets(appId) with count = app.ratingCount; total = app.ratingTotal; complete = memory.maintenance.ratingsComplete });
    };

    public func validateLegacyReview(review : Text) : Result<()> {
      if (memory.maintenance.legacyTextCutover and review != "") {
        return failure("feedback_update_required", "Update Marketplace to write a comment for the selected app version. Your star rating can still be saved without review text.");
      };
      #ok(());
    };

    public func setLegacyRating(owner : Principal, appId : Text, stars : Nat, review : Text, now : Int) : Result<Types.Rating> {
      switch (validateLegacyReview(review)) { case (#err(error)) return #err(error); case (_) {} };
      switch (Ratings.set(db, owner, appId, stars, review, now)) {
        case (#err(message)) failure("rating", message);
        case (#ok(rating)) { syncRating(rating); #ok(rating) };
      };
    };

    public func setRating(owner : Principal, appId : Text, stars : Nat, now : Int) : Result<Types.Rating> {
      // The successor stars-only API does not prematurely erase legacy text
      // before the administrator has activated the explicit text cutover.
      let review = if (memory.maintenance.legacyTextCutover) "" else switch (Store.getRating(db, owner, appId)) {
        case null ""; case (?rating) rating.review;
      };
      setLegacyRating(owner, appId, stars, review, now);
    };

    func requireOffered(release : FeedbackStore.Release) : Result<()> {
      let ?candidate = Store.getCandidate(db, release.candidateId) else return failure("candidate_missing", "This app version could not be found.");
      if (candidate.appId != release.appId or candidate.version != release.version or candidate.digest != release.digest) {
        return failure("feedback_release_mismatch", "The displayed app version does not match this release. Refresh the app details.");
      };
      if (not offered(release.appId, release.candidateId, release.version, release.digest)) {
        return failure("feedback_release_retired", "Comments for this app version are no longer available. Refresh the app details.");
      };
      #ok(());
    };

    func requireOwner(owner : Principal, release : FeedbackStore.Release) : Result<()> {
      switch (requireOffered(release)) { case (#err(error)) return #err(error); case (_) {} };
      if (Store.getEntitlement(db, owner, release.appId) == null) return failure("feedback_acquisition_required", "Acquire this app before commenting on it.");
      #ok(());
    };

    public func comments(owner : ?Principal, request : FeedbackStore.CommentPageRequest) : Result<FeedbackStore.CommentPage> {
      switch (requireOffered(request)) { case (#err(error)) return #err(error); case (_) {} };
      let values = List.empty<FeedbackStore.Comment>();
      let start : Nat64 = switch (request.cursor) { case null 0; case (?cursor) cursor };
      let rows = Map.entriesFrom(memory.comments, FeedbackStore.compareComment, (request.candidateId, start));
      var nextCursor : ?Nat64 = null;
      var last : ?Nat64 = null;
      label page loop {
        let ?((candidateId, id), comment) = rows.next() else break page;
        if (candidateId != request.candidateId) break page;
        if (request.cursor != ?id) {
          if (List.size(values) == request.limit) { nextCursor := last; break page };
          List.add(values, comment);
          last := ?id;
        };
      };
      let ownComment = switch (owner) {
        case null null;
        case (?principal) switch (Map.get(memory.commentsByOwner, FeedbackStore.compareOwner, (request.candidateId, principal))) {
          case null null;
          case (?id) Map.get(memory.comments, FeedbackStore.compareComment, (request.candidateId, id));
        };
      };
      #ok({ comments = List.toArray(values); ownComment; nextCursor });
    };

    public func commentSet(owner : Principal, request : FeedbackStore.CommentRequest, now : Int) : Result<FeedbackStore.Comment> {
      switch (requireOwner(owner, request)) { case (#err(error)) return #err(error); case (_) {} };
      let ownerKey = (request.candidateId, owner);
      let previous = switch (Map.get(memory.commentsByOwner, FeedbackStore.compareOwner, ownerKey)) {
        case null null;
        case (?id) {
          let ?value = Map.get(memory.comments, FeedbackStore.compareComment, (request.candidateId, id)) else Runtime.trap("Version comment owner index is inconsistent");
          if (value.text == request.text) return #ok(value);
          ?value;
        };
      };
      let id = switch (previous) {
        case (?value) value.id;
        case null { let value = memory.nextCommentId; memory.nextCommentId += 1; value };
      };
      let comment : FeedbackStore.Comment = {
        id; owner; appId = request.appId; candidateId = request.candidateId; version = request.version; digest = request.digest;
        text = request.text; createdAtNs = switch (previous) { case null now; case (?value) value.createdAtNs }; updatedAtNs = now;
      };
      Map.add(memory.comments, FeedbackStore.compareComment, (request.candidateId, id), comment);
      Map.add(memory.commentsByOwner, FeedbackStore.compareOwner, ownerKey, id);
      #ok(comment);
    };

    func removeComment(comment : FeedbackStore.Comment) {
      Map.remove(memory.comments, FeedbackStore.compareComment, (comment.candidateId, comment.id));
      Map.remove(memory.commentsByOwner, FeedbackStore.compareOwner, (comment.candidateId, comment.owner));
    };

    public func commentDelete(owner : Principal, release : FeedbackStore.Release) : Result<()> {
      switch (requireOwner(owner, release)) { case (#err(error)) return #err(error); case (_) {} };
      switch (Map.get(memory.commentsByOwner, FeedbackStore.compareOwner, (release.candidateId, owner))) {
        case null {};
        case (?id) {
          let ?comment = Map.get(memory.comments, FeedbackStore.compareComment, (release.candidateId, id)) else Runtime.trap("Version comment owner index is inconsistent");
          removeComment(comment);
        };
      };
      #ok(());
    };

    // The public adapter authorizes the administrator and confirms rollout of
    // the stable successor before calling this. Set the rejection gate first;
    // restartable cleanup can never race an accepted versionless text write.
    public func activateLegacyTextCutover() {
      if (not memory.maintenance.legacyTextCutover) {
        memory.maintenance := { memory.maintenance with legacyTextCutover = true; legacyTextCursor = null; legacyTextComplete = false };
      };
    };

    func backfillOne() : Bool {
      if (memory.maintenance.ratingsComplete) return false;
      switch (db.ratings.iterPrimary(#fwd, memory.maintenance.ratingsCursor).next()) {
        case null { memory.maintenance := { memory.maintenance with ratingsComplete = true }; false };
        case (?(id, rating)) {
          syncRating(rating);
          memory.maintenance := { memory.maintenance with ratingsCursor = ?id };
          true;
        };
      };
    };

    func cleanLegacyOne() : Bool {
      if (not memory.maintenance.legacyTextCutover or memory.maintenance.legacyTextComplete) return false;
      switch (db.ratings.iterPrimary(#fwd, memory.maintenance.legacyTextCursor).next()) {
        case null { memory.maintenance := { memory.maintenance with legacyTextComplete = true }; false };
        case (?(id, rating)) {
          Ratings.clearLegacyReview(db, rating);
          memory.maintenance := { memory.maintenance with legacyTextCursor = ?id };
          true;
        };
      };
    };

    func cleanCommentOne() : Bool {
      let rows = switch (memory.maintenance.commentsCursor) {
        case null Map.entries(memory.comments);
        case (?cursor) Map.entriesFrom(memory.comments, FeedbackStore.compareComment, cursor);
      };
      var next = rows.next();
      switch (next, memory.maintenance.commentsCursor) {
        case (?(key, _), ?cursor) { if (key == cursor) next := rows.next() };
        case (_) {};
      };
      switch (next) {
        case null { memory.maintenance := { memory.maintenance with commentsCursor = null }; false };
        case (?(key, comment)) {
          // Reseek on the next step: deleting from a B-tree while continuing an
          // existing iterator can skip a row after its internal nodes rebalance.
          if (not offered(comment.appId, comment.candidateId, comment.version, comment.digest)) removeComment(comment);
          memory.maintenance := { memory.maintenance with commentsCursor = ?key };
          true;
        };
      };
    };

    // This is a resumable work budget supplied by the existing maintenance
    // scheduler, not a feedback quota. Rotate tasks so a large rating backfill
    // cannot postpone deletion of text from retired versions.
    public func advance(budget : Nat) : Nat {
      var processed = 0;
      var empty = 0;
      while (processed < budget and empty < 3) {
        let phase = memory.maintenance.phase;
        memory.maintenance := { memory.maintenance with phase = (phase + 1) % 3 };
        let worked = switch (phase) { case (0) backfillOne(); case (1) cleanLegacyOne(); case (_) cleanCommentOne() };
        if (worked) { processed += 1; empty := 0 } else empty += 1;
      };
      processed;
    };
  };
};
