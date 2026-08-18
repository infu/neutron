import Map "mo:core/Map";
import Nat16 "mo:core/Nat16";
import Principal "mo:core/Principal";

import Memory "../../backend/memory/wagyu/v3";

// Fresh installs use the released v3 defaults.
let fresh = Memory.init();
assert (fresh.state_revision == 0);
assert (fresh.author_sequence == 0);
assert (Map.size(fresh.locally_verified_delivery_counts) == 0);

// The release transition test pins the 0.3.2 archive and proves that the
// current v3 declaration produces a compiler #keep operation. Model that
// operation with representative non-default data: the existing root is reused
// and init() is not called again.
let peer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let installed = Memory.init();
installed.state_revision := 41;
installed.author_sequence := 73;
Map.add(
    installed.locally_verified_delivery_counts,
    Principal.compare,
    peer,
    (27 : Nat16),
);

let restored : Memory.Mem = installed;
assert (restored.state_revision == 41);
assert (restored.author_sequence == 73);
assert (
    Map.get(
        restored.locally_verified_delivery_counts,
        Principal.compare,
        peer,
    ) == ?27
);

restored.state_revision := 42;
assert (installed.state_revision == 42);
