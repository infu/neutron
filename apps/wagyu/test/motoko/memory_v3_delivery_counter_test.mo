import Map "mo:core/Map";
import Nat16 "mo:core/Nat16";
import Principal "mo:core/Principal";

import Memory "../../backend/memory/wagyu/v3";

let peer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let mem = Memory.init();

assert (Map.size(mem.locally_verified_delivery_counts) == 0);

// The counter lives in managed stable memory, rather than actor-local
// runtime state. Reconstructing a runtime over the same memory object sees
// the exact bounded value.
Map.add(
    mem.locally_verified_delivery_counts,
    Principal.compare,
    peer,
    (27 : Nat16),
);
let afterRestart = mem;
assert (
    Map.get(
        afterRestart.locally_verified_delivery_counts,
        Principal.compare,
        peer,
    ) == ?27
);
// Sparse zero representation restores the empty counter shape.
Map.remove(
    afterRestart.locally_verified_delivery_counts,
    Principal.compare,
    peer,
);
assert (Map.size(afterRestart.locally_verified_delivery_counts) == 0);
