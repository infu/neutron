import Prim "mo:⛔";
import Blob "mo:base/Blob";

module {
    func some() : async () {
         Prim.setCertifiedData(Blob.fromArray([]));
    }
}