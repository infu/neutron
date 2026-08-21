import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Wire "../backend/PublicIngressWire";
let inner = Blob.fromArray([0x2a]);
let reply = Blob.fromArray([68,73,68,76,3,107,2,156,194,1,2,229,142,180,2,1,107,10,254,254,203,133,1,127,149,239,154,175,1,127,152,153,210,236,1,127,222,254,203,140,2,127,187,145,186,249,3,127,185,170,128,137,4,127,210,169,200,152,4,127,214,229,202,198,4,127,180,156,252,217,12,127,144,145,208,173,13,127,109,123,1,0,0,1,0x2a]);
assert (Wire.unwrapOk(reply, 1) == ?inner);
let bytes = Blob.toArray(reply); let prefixSize = bytes.size() - 2; var index = 0;
while (index < prefixSize) { let mutated = Blob.fromArray(Array.tabulate<Nat8>(bytes.size(), func(i) { if (i == index) { if (bytes[i] == 0) 1 else 0 } else bytes[i] })); assert (Wire.unwrapOk(mutated, 1) == null); index += 1 };
assert (Wire.unwrapOk(Blob.fromArray(Array.tabulate<Nat8>(bytes.size() - 1, func(i) { bytes[i] })), 1) == null);
assert (Wire.unwrapOk(Blob.fromArray(Array.tabulate<Nat8>(bytes.size() + 1, func(i) { if (i < bytes.size()) bytes[i] else 0 })), 1) == null);
// Non-canonical ULEB zero and an oversized declared payload fail closed.
assert (Wire.unwrapOk(Blob.fromArray(Array.concat<Nat8>(Array.tabulate<Nat8>(prefixSize, func(i) { bytes[i] }), [0x80, 0x00])), 1) == null);
