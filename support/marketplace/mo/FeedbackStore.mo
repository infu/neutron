// All rights reserved. See ../LICENSE.
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Order "mo:core/Order";
import Principal "mo:core/Principal";

module {
  public type Release = { appId : Text; candidateId : Nat64; version : Nat; digest : Blob };
  public type Histogram = { five : Nat; four : Nat; three : Nat; two : Nat; one : Nat; count : Nat; total : Nat; complete : Bool };
  public type Buckets = { five : Nat; four : Nat; three : Nat; two : Nat; one : Nat };
  public type Contribution = { appId : Text; stars : Nat };
  public type Comment = Release and { id : Nat64; owner : Principal; text : Text; createdAtNs : Int; updatedAtNs : Int };
  public type CommentRequest = Release and { text : Text; feeVersion : Nat };
  public type CommentPageRequest = Release and { cursor : ?Nat64; limit : Nat };
  public type CommentPage = { comments : [Comment]; ownComment : ?Comment; nextCursor : ?Nat64 };
  public type CommentKey = (Nat64, Nat64);
  public type OwnerKey = (Nat64, Principal);
  public type Maintenance = {
    ratingsCursor : ?Nat64; ratingsComplete : Bool;
    legacyTextCutover : Bool; legacyTextCursor : ?Nat64; legacyTextComplete : Bool;
    commentsCursor : ?CommentKey; phase : Nat;
  };

  // A new independent actor root. The released marketplace and publisher
  // schemas remain immutable; individual rating rows remain authoritative.
  public type Mem = {
    histograms : Map.Map<Text, Buckets>;
    contributions : Map.Map<Nat64, Contribution>;
    comments : Map.Map<CommentKey, Comment>;
    commentsByOwner : Map.Map<OwnerKey, Nat64>;
    var nextCommentId : Nat64;
    var maintenance : Maintenance;
  };

  public func init() : Mem {
    {
      histograms = Map.empty(); contributions = Map.empty();
      comments = Map.empty(); commentsByOwner = Map.empty();
      var nextCommentId = 1;
      var maintenance = {
        ratingsCursor = null; ratingsComplete = false;
        legacyTextCutover = false; legacyTextCursor = null; legacyTextComplete = false;
        commentsCursor = null; phase = 0;
      };
    };
  };

  public func compareComment(a : CommentKey, b : CommentKey) : Order.Order {
    switch (Nat64.compare(a.0, b.0)) { case (#equal) Nat64.compare(a.1, b.1); case (order) order };
  };
  public func compareOwner(a : OwnerKey, b : OwnerKey) : Order.Order {
    switch (Nat64.compare(a.0, b.0)) { case (#equal) Principal.compare(a.1, b.1); case (order) order };
  };
};
