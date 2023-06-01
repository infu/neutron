import Prim "mo:⛔";
import Blob "mo:base/Blob";

module {
    func some() : async Principal {
        let x = Prim.createActor;
        await x(Blob.fromArray([]), Blob.fromArray([]));
    }
}