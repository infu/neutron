// All rights reserved. See ../LICENSE.
// Additive release-channel storage. The released marketplace tables are retained.
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Types "./Types";

module {
  public type Mode = { #stable_; #beta };
  public type Head = { candidateId : ?Nat64; revision : Nat64 };
  public type Heads = { stableHead : Head; betaHead : Head };
  public type Selection = { appId : Text; candidateId : Nat64; version : Nat; digest : Blob; sourceDigest : ?Blob; channel : Mode; revision : Nat64 };
  public type PromotionEntry = {
    appId : Text; candidateId : Nat64; version : Nat; digest : Blob; sourceDigest : ?Blob;
    packageSize : Nat64; sourceSize : ?Nat64; dependencies : [{ appId : Text; minVersion : Nat }];
    expectedBetaRevision : Nat64; expectedStableCandidate : ?Nat64; expectedStableRevision : Nat64;
  };
  public type PromotionReceipt = { id : Nat64; owner : Principal; publisher : Principal; requestId : Text; operation : Text; channel : Text; entries : [PromotionEntry]; createdAtNs : Int };
  public type BetaReceipt = Types.PublishBatch and { operation : Text; channel : Text };
  public type ManifestSelection = { mode : Mode; selection : [Selection]; content : Blob };
  public type Mem = {
    heads : Map.Map<Text, Heads>;
    notes : Map.Map<Nat64, Text>;
    promotions : Map.Map<(Principal, Text), PromotionReceipt>;
    betaReceipts : Map.Map<(Principal, Text), BetaReceipt>;
    manifests : Map.Map<Text, ManifestSelection>;
    var nextPromotionId : Nat64;
    var bootstrapped : Bool;
  };
  public func init() : Mem {
    { heads = Map.empty(); notes = Map.empty(); promotions = Map.empty(); betaReceipts = Map.empty(); manifests = Map.empty(); var nextPromotionId = 1; var bootstrapped = false };
  };
  public func requestCompare(a : (Principal, Text), b : (Principal, Text)) : { #less; #equal; #greater } {
    switch (Principal.compare(a.0, b.0)) { case (#equal) Text.compare(a.1, b.1); case other other };
  };
  public func heads(mem : Mem, appId : Text) : Heads {
    switch (Map.get(mem.heads, Text.compare, appId)) {
      case (?value) value;
      case null ({ stableHead = { candidateId = null; revision = 0 }; betaHead = { candidateId = null; revision = 0 } });
    };
  };
  public func putHeads(mem : Mem, appId : Text, value : Heads) { Map.add(mem.heads, Text.compare, appId, value) };
  public func references(mem : Mem, appId : Text, candidateId : Nat64) : Bool {
    let value = heads(mem, appId);
    value.stableHead.candidateId == ?candidateId or value.betaHead.candidateId == ?candidateId;
  };
  public func notes(mem : Mem, candidateId : Nat64) : Text {
    switch (Map.get(mem.notes, Nat64.compare, candidateId)) { case (?value) value; case null "" };
  };
  public func putNotes(mem : Mem, candidateId : Nat64, value : Text) { Map.add(mem.notes, Nat64.compare, candidateId, value) };
  // Only this explicit forward bootstrap reads the legacy approved pointer.
  // Revoked pointers are retained; eligibility is checked by the resolver.
  public func bootstrap(mem : Mem, apps : Iter.Iter<(Nat64, Types.App)>) {
    if (mem.bootstrapped) return;
    for ((_, app) in apps) {
      if (not Map.containsKey(mem.heads, Text.compare, app.appId)) {
        putHeads(mem, app.appId, { stableHead = { candidateId = app.approvedCandidate; revision = if (app.approvedCandidate == null) 0 else 1 }; betaHead = { candidateId = null; revision = 0 } });
      };
    };
    mem.bootstrapped := true;
  };
};
