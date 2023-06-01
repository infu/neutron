import Prim "mo:prim";

module {
    public let fromActor : (a : actor {}) -> Principal = Prim.principalOfActor;
}