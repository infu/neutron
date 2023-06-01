import Prim "mo:⛔";
import Blob "mo:base/Blob";

module {
    func some() : async Principal {
         await Prim.createActor(Blob.fromArray([]), Blob.fromArray([]));
    }
}