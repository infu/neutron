import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";

import Paging "../../backend/paging/Service";

let outbox = Map.empty<Nat64, Text>();
Map.add(outbox, Nat64.compare, (1 : Nat64), "one");
Map.add(outbox, Nat64.compare, (2 : Nat64), "two");
Map.add(outbox, Nat64.compare, (3 : Nat64), "three");
Map.add(outbox, Nat64.compare, (4 : Nat64), "four");

let newest = Paging.descendingNat64(outbox, null, 2);
assert (
    newest.entries ==
    [((4 : Nat64), "four"), ((3 : Nat64), "three")]
);
assert (newest.next_before == ?(3 : Nat64));

let older = Paging.descendingNat64(outbox, newest.next_before, 2);
assert (
    older.entries ==
    [((2 : Nat64), "two"), ((1 : Nat64), "one")]
);
// An exactly full terminal page must not emit a phantom continuation.
assert (older.next_before == null);

let absentCursor = Paging.descendingNat64(outbox, ?(5 : Nat64), 2);
assert (absentCursor.entries == newest.entries);
assert (absentCursor.next_before == newest.next_before);

let p1 = Principal.fromBlob(Blob.fromArray([1]));
let p2 = Principal.fromBlob(Blob.fromArray([2]));
let p3 = Principal.fromBlob(Blob.fromArray([3]));
let p4 = Principal.fromBlob(Blob.fromArray([4]));

let following = Map.empty<Principal, Nat>();
Map.add(following, Principal.compare, p1, 1);
Map.add(following, Principal.compare, p3, 3);
let followers = Map.empty<Principal, Nat>();
Map.add(followers, Principal.compare, p2, 2);
Map.add(followers, Principal.compare, p3, 3);
Map.add(followers, Principal.compare, p4, 4);
let blocks = Map.empty<Principal, Nat>();
Map.add(blocks, Principal.compare, p1, 1);
Map.add(blocks, Principal.compare, p4, 4);

let first = Paging.descendingPrincipalUnion(
    following,
    followers,
    blocks,
    null,
    2,
);
assert (first.nodes == [p4, p3]);
assert (first.next_before == ?p3);

let second = Paging.descendingPrincipalUnion(
    following,
    followers,
    blocks,
    first.next_before,
    2,
);
assert (second.nodes == [p2, p1]);
assert (second.next_before == null);

let exact = Paging.descendingPrincipalUnion(
    following,
    followers,
    blocks,
    ?p3,
    2,
);
assert (exact.nodes == [p2, p1]);
assert (exact.next_before == null);
