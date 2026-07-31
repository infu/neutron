import Prim "mo:⛔";

module {
    func some() : async () {
        Prim.stableMemoryStoreNat8(1,2);
    }
}