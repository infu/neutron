import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Replies "../../backend/replies/Admission";
import Protocol "../../backend/protocol/Types";

func repeated(byte : Nat8, count : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(count, func(_) { byte }));
};

let author = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");

func entry(id : Nat8, receivedAt : Nat64) : Protocol.ReplyIndexEntryV1 {
    {
        author;
        post_id = repeated(id, 32);
        object_digest = repeated(id + 1, 32);
        object_length = Nat32.fromNat(128);
        received_at_ns = receivedAt;
    };
};

let first = switch (Replies.promote([], entry(1, 20))) {
    case (#append(value)) value;
    case (_) Runtime.trap("first verified reply was not admitted");
};
assert (first.size() == 1);
assert (first[0].received_at_ns == 20);

let clamped = switch (Replies.promote(first, entry(2, 10))) {
    case (#append(value)) value;
    case (_) Runtime.trap("second verified reply was not admitted");
};
assert (clamped.size() == 2);
assert (clamped[1].received_at_ns == 20);

switch (Replies.promote(clamped, entry(2, 999))) {
    case (#duplicate) {};
    case (_) Runtime.trap("exact duplicate was not idempotent");
};
switch (
    Replies.promote(
        clamped,
        { entry(2, 20) with object_digest = repeated(0xee, 32) },
    )
) {
    case (#conflict) {};
    case (_) Runtime.trap("equivocating duplicate was not rejected");
};
switch (
    Replies.promote(
        clamped,
        { entry(3, 30) with object_digest = repeated(0xee, 31) },
    )
) {
    case (#invalid) {};
    case (_) Runtime.trap("invalid reply entry was not rejected");
};

let full = Array.tabulate<Protocol.ReplyIndexEntryV1>(
    Replies.MAX_PUBLISHED_DIRECT_REPLIES,
    func(index) {
        entry(Nat8.fromNat(index + 1), Nat64.fromNat(index + 1));
    },
);
switch (
    Replies.promote(
        full,
        entry(0xfe, 101),
    )
) {
    case (#terminal_unindexed) {};
    case (_) Runtime.trap("reply cap did not terminally omit reply 101");
};
switch (
    Replies.promote(
        full,
        entry(1, 999),
    )
) {
    case (#duplicate) {};
    case (_) Runtime.trap("duplicate at capacity was not idempotent");
};

let removed = switch (
    Replies.remove(full, author, repeated(50, 32))
) {
    case (#removed(value)) value;
    case (#unchanged) Runtime.trap("existing reply was not removed");
};
assert (removed.size() == Replies.MAX_PUBLISHED_DIRECT_REPLIES - 1);
switch (
    Replies.remove(
        removed,
        author,
        repeated(50, 32),
    )
) {
    case (#unchanged) {};
    case (_) Runtime.trap("missing reply removal was not idempotent");
};
