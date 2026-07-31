import Prim "mo:prim";

module {
  public let fromActor : (value : actor {}) -> Principal = Prim.principalOfActor;
}
