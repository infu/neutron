import Prim "mo:⛔";
import Blob "mo:core/Blob";

module {
    func some() : async () {
         Prim.setCertifiedData(Blob.fromArray([]));
    }
}
