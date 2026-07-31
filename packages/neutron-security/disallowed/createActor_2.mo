import Prim "mo:⛔";
import Blob "mo:core/Blob";

module {
    func some() : async Principal {
        let x = Prim.createActor;
        await x(Blob.fromArray([]), Blob.fromArray([]));
    }
}
