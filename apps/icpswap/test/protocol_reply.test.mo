import Blob "mo:core/Blob";
import Array "mo:core/Array";
import Reply "../backend/icpswap/ProtocolReply";

func unknown<T>(outcome : Reply.Outcome<T>) : Bool {
    switch (outcome) { case (#unknown(_)) true; case (_) false };
};

// DIDL, one variant { ok : nat }, one argument of table type 0, branch 0.
let okZero : [Nat8] = [68,73,68,76,1,107,1,156,194,1,125,1,0,0,0];
assert (Reply.decodeNat(Blob.fromArray(okZero)) == #ok(0));
assert (unknown(Reply.decodeNat(Blob.fromArray([]))));
assert (unknown(Reply.decodeNat(Blob.fromArray([0,1,2]))));
assert (unknown(Reply.decodeNat(Blob.fromArray([68,73,68,76,128]))));

// Every truncation is unknown, including the terminating LEB128 amount byte.
var length = 0;
while (length < okZero.size()) {
    assert (unknown(Reply.decodeNat(Blob.fromArray(Array.tabulate<Nat8>(length, func(index) { okZero[index] })))));
    length += 1;
};
func replace(source : [Nat8], index : Nat, byte : Nat8) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(source.size(), func(at) { if (at == index) byte else source[at] }));
};
// Invalid branch index, unterminated amount, and impossible table/field counts.
assert (unknown(Reply.decodeNat(replace(okZero, 13, 1))));
assert (unknown(Reply.decodeNat(replace(okZero, 14, 128))));
assert (unknown(Reply.decodeNat(replace(okZero, 4, 127))));
assert (unknown(Reply.decodeNat(replace(okZero, 6, 127))));
assert (unknown(Reply.decodeNat(replace(okZero, 12, 1))));
assert (unknown(Reply.decodeNat(Blob.fromArray(Array.concat<Nat8>(okZero, [0])))));

// Wire count values never drive allocation before the remaining input check.
assert (unknown(Reply.decodeNat(Blob.fromArray([68,73,68,76,255,255,255,255,127]))));
// A recursive result type cannot make the decoder recurse indefinitely.
assert (unknown(Reply.decodeNat(Blob.fromArray([68,73,68,76,1,107,1,156,194,1,0,1,0,0]))));
// Duplicate, descending, and oversized hashed field IDs violate Candid's
// table format, even when a selected value might otherwise look successful.
assert (unknown(Reply.decodeNat(Blob.fromArray([68,73,68,76,1,107,2,0,125,0,125,1,0,0,0]))));
assert (unknown(Reply.decodeNat(Blob.fromArray([68,73,68,76,1,107,2,1,125,0,125,1,0,0,0]))));
assert (unknown(Reply.decodeNat(Blob.fromArray([68,73,68,76,1,107,1,128,128,128,128,16,125,1,0,0,0]))));
