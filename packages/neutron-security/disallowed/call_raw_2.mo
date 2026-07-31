import Prim "mo:⛔";
import Principal "mo:core/Principal";
import Blob "mo:core/Blob";

module {
    func some() : async () {
         ignore @call_raw(Principal.fromText("aaaaa-aa"), "some", Blob.fromArray([]));

    }
}
