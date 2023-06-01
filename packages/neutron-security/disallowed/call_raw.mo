import Prim "mo:⛔";
import Principal "mo:base/Principal";
import Blob "mo:base/Blob";

module {
    func some() : async () {
         ignore Prim.call_raw(Principal.fromText("aaaaa-aa"), "some", Blob.fromArray([]));

    }
}