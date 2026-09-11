// All rights reserved. See ../LICENSE.
import Runtime "mo:core/Runtime";
import Store "Store";
import Types "Types";
import Publishers "Publishers";

module {
  public type Result<T> = { #ok : T; #err : Text };
  public type Summary = { count : Nat; total : Nat };

  // Free and paid acquisitions have the same rating right. Audit revocation or
  // a price change does not erase that ownership. An edit updates the one saved
  // contribution; it never creates an acquisition or changes ranking counters.
  public func set(db : Store.DB, owner : Principal, appId : Text, stars : Nat, review : Text, now : Int) : Result<Types.Rating> {
    switch (validateStars(stars)) { case (#err(error)) return #err(error); case (_) {} };
    switch (Store.getEntitlement(db, owner, appId)) {
      case null return #err("Acquire this app before rating it.");
      case (?_) {};
    };
    let ?app = Store.getApp(db, appId) else return #err("This app could not be found.");
    let previous = Store.getRating(db, owner, appId);
    let previousStars = switch (previous) {
      case null null;
      case (?rating) {
        if (rating.stars == stars and rating.review == review) return #ok(rating);
        ?rating.stars;
      };
    };
    let summary = switch (updateSummary({ count = app.ratingCount; total = app.ratingTotal }, previousStars, stars)) {
      case (#ok(value)) value;
      case (#err(error)) return #err(error);
    };
    let createdAtNs = switch (previous) { case null now; case (?rating) rating.createdAtNs };
    let rating = switch (Store.putRating(db, { owner; appId; stars; review; createdAtNs; updatedAtNs = now })) {
      case (#ok(value)) value;
      case (#err(error)) Runtime.trap("Could not save the rating: " # debug_show(error));
    };
    switch (db.apps.update({ app with ratingCount = summary.count; ratingTotal = summary.total })) {
      case (#ok(updated)) { Publishers.syncApp(db, updated) };
      // Both writes belong to the same synchronous message segment. A trap
      // rolls back the rating too; returning an error here would not do that.
      case (#err(error)) Runtime.trap("Could not update the rating summary: " # debug_show(error));
    };
    #ok(rating);
  };

  public func validateStars(stars : Nat) : Result<()> {
    if (stars < 1 or stars > 5) return #err("Choose a rating from 1 to 5 stars.");
    #ok(());
  };

  // A second rating from the same owner edits its contribution. It must not
  // inflate the number of owners who rated this app or any acquisition count.
  public func updateSummary(summary : Summary, previousStars : ?Nat, stars : Nat) : Result<Summary> {
    switch (validateStars(stars)) { case (#err(error)) return #err(error); case (_) {} };
    switch (previousStars) {
      case null #ok({ count = summary.count + 1; total = summary.total + stars });
      case (?previous) {
        if (summary.count == 0 or previous < 1 or previous > 5 or summary.total < previous) {
          return #err("The saved rating summary is inconsistent with this rating.");
        };
        #ok({ count = summary.count; total = summary.total - previous + stars });
      };
    };
  };
}
