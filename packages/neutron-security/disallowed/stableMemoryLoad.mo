import Prim "mo:⛔";

module {
    func some() : async () {
        ignore Prim.stableMemoryLoadInt8(2);
    }
}