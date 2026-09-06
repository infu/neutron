import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Text "mo:core/Text";

// A separate canister holds real inter-canister replies. The test sends more
// ingress messages while these calls are outstanding, then releases tickets
// in a chosen order. No immediate async* substitute can satisfy this gate.
persistent actor Gate {
  let arrivals = Map.empty<Text, Nat>();
  let releases = Map.empty<Text, Nat>();

  public func tick() : async () {};

  public func hold(key : Text) : async () {
    let ticket = switch (Map.get(arrivals, Text.compare, key)) { case null 1; case (?n) n + 1 };
    Map.add(arrivals, Text.compare, key, ticket);
    label wait loop {
      let released = switch (Map.get(releases, Text.compare, key)) { case null 0; case (?n) n };
      if (released >= ticket) break wait;
      await Gate.tick();
    };
  };

  public func release(key : Text, through : Nat) : async () {
    let previous = switch (Map.get(releases, Text.compare, key)) { case null 0; case (?n) n };
    Map.add(releases, Text.compare, key, Nat.max(previous, through));
  };

  public query func entered(key : Text) : async Nat {
    switch (Map.get(arrivals, Text.compare, key)) { case null 0; case (?n) n };
  };
};
