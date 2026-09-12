import Blob "mo:core/Blob";
import Error "mo:core/Error";
import List "mo:core/List";
import Map "mo:core/Map";

// A separate canister keeps the real manage_neuron reply outstanding while
// the test inspects or upgrades the caller. Every wait yields an IC message.
persistent actor Gate {
  type Configuration = { reply : Blob; mode : Text };
  type Observation = { args : Blob; method : Text; reply : ?Blob };

  let configurations = Map.empty<Blob, Configuration>();
  let arrivals = Map.empty<Blob, Nat>();
  let releases = Map.empty<Blob, Nat>();
  let calls = List.empty<Observation>();

  public func configure(args : Blob, reply : Blob, mode : Text) : async () {
    if (mode != "reply" and mode != "error") {
      throw Error.reject("Unknown journal gate mode: " # mode);
    };
    Map.add(configurations, Blob.compare, args, { reply; mode });
  };

  public func checkpoint() : async () {};

  public func manage_neuron(method : Text, args : Blob) : async Blob {
    let configuration = switch (Map.get(configurations, Blob.compare, args)) {
      case (?value) value;
      case null throw Error.reject("Journal gate request was not configured");
    };
    let ticket = switch (Map.get(arrivals, Blob.compare, args)) {
      case null 1;
      case (?count) count + 1;
    };
    Map.add(arrivals, Blob.compare, args, ticket);
    let observation = List.size(calls);
    List.add(calls, { args; method; reply = null });

    label wait loop {
      // The first checkpoint commits the arrival before any reply can return.
      await Gate.checkpoint();
      let released = switch (Map.get(releases, Blob.compare, args)) {
        case null 0;
        case (?count) count;
      };
      if (released >= ticket) break wait;
    };

    if (configuration.mode == "error") {
      throw Error.reject("journal gate lost reply");
    };
    List.put(calls, observation, { args; method; reply = ?configuration.reply });
    configuration.reply;
  };

  // Release only calls that have already arrived. Repeating the same payload
  // later requires another explicit release and remains visible in the log.
  public func release(args : Blob) : async () {
    let through = switch (Map.get(arrivals, Blob.compare, args)) {
      case null 0;
      case (?count) count;
    };
    Map.add(releases, Blob.compare, args, through);
  };

  public query func entered(args : Blob) : async Nat {
    switch (Map.get(arrivals, Blob.compare, args)) {
      case null 0;
      case (?count) count;
    };
  };

  public query func observations() : async [Observation] {
    List.toArray(calls);
  };
};
