import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import PublicIngressWire "../backend/PublicIngressWire";

let inner = Blob.fromArray([0x2a]);
// Frozen canonical PublicIngressResultV1 #ok prefix, one-byte length, payload.
let reply = Blob.fromArray([
    68, 73, 68, 76, 3, 107, 2, 156, 194, 1, 2, 229, 142, 180, 2, 1,
    107, 10, 254, 254, 203, 133, 1, 127, 149, 239, 154, 175,
    1, 127, 152, 153, 210, 236, 1, 127, 222, 254, 203, 140, 2, 127,
    187, 145, 186, 249, 3, 127, 185, 170, 128, 137, 4, 127, 210, 169,
    200, 152, 4, 127, 214, 229, 202, 198, 4, 127, 180, 156, 252, 217,
    12, 127, 144, 145, 208, 173, 13, 127, 109, 123, 1, 0, 0,
    1, 0x2a,
]);
assert (PublicIngressWire.unwrapOk(reply, 1) == ?inner);

let bytes = Blob.toArray(reply);
// The exact one-byte payload uses one ULEB length byte.
let prefixSize = bytes.size() - 2;
var prefixIndex = 0;
while (prefixIndex < prefixSize) {
    let mutated = Blob.fromArray(Array.tabulate<Nat8>(bytes.size(), func(index) {
        if (index == prefixIndex) {
            if (bytes[index] == 0) 1 else 0
        } else bytes[index]
    }));
    assert (PublicIngressWire.unwrapOk(mutated, 1) == null);
    prefixIndex += 1;
};

let truncated = Blob.fromArray(Array.tabulate<Nat8>(bytes.size() - 1, func(index) {
    bytes[index]
}));
assert (PublicIngressWire.unwrapOk(truncated, 1) == null);

let trailing = Blob.fromArray(Array.tabulate<Nat8>(bytes.size() + 1, func(index) {
    if (index < bytes.size()) bytes[index] else 0
}));
assert (PublicIngressWire.unwrapOk(trailing, 1) == null);
