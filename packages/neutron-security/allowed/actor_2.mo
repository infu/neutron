import Prim "mo:prim";

module {
    public let fromActor : (a : actor {}) -> Principal = Prim.principalOfActor;
    public func fromText(t : Text) : Principal = fromActor(actor (t));
}