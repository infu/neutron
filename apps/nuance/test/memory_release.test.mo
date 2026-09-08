// Managed-memory contract for the `nuance` root.
//
// A fresh install must use `init()`, and rebuilding the backend over a retained
// root must observe the existing values rather than resetting them. That second
// property is what makes an upgrade non-destructive, so it is asserted directly
// against the current schema.
//
// The v1 -> v2 upgrade path itself is covered by `migration.test.mo`.

import Principal "mo:core/Principal";
import Array "mo:core/Array";
import Caps "mo:neutron-capabilities";

import Main "../backend/main";
import Memory "../backend/memory/nuance/v2";

let backendCalls : Caps.BackendCallsV1 = {
    canister_principal = Principal.fromText("aaaaa-aa");
    can_call = func(_ : Principal, _ : Text) : Bool { true };
    call = func(_ : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
        #err({ code = "test"; message = "offline" });
    };
    call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
        Array.tabulate<Caps.BackendCallResultV1>(
            requests.size(),
            func(_ : Nat) : Caps.BackendCallResultV1 {
                #err({ code = "test"; message = "offline" });
            },
        );
    };
};

func app(memory : Memory.Mem) : Main.Init {
    Main.Init({
        stable_memory = { nuance = memory };
        capabilities = { backend_calls = backendCalls };
    });
};

// Clean initialization: the released defaults, and nothing claimed yet.
let memory = Memory.init();
assert (memory.handle == "");
assert (not memory.registered);
assert (memory.drafts.size() == 0);
assert (memory.bookmarks.size() == 0);
assert (memory.nextDraftId == 1);

let first = app(memory);
switch (first.nuance_draft_new("Retained title", "Retained body.")) {
    case (#ok(view)) assert (view.revision == 1);
    case (_) assert false;
};
assert (memory.drafts.size() == 1);
assert (memory.activeDraftId == "d1");

// The Init class writes through to the managed root, not to a private copy.
assert (memory.drafts[0].title == "Retained title");

// Rebuilding the backend over the retained root -- what an upgrade does -- must
// preserve the draft and continue the id sequence rather than starting over.
let restored = app(memory);
switch (restored.nuance_draft_read("d1")) {
    case (#ok(view)) {
        assert (view.title == "Retained title");
        assert (view.body == "Retained body.");
        assert (view.revision == 1);
    };
    case (#err(_)) assert false;
};

switch (restored.nuance_draft_new("Second", "")) {
    case (#ok(view)) assert (view.id == "d2");
    case (_) assert false;
};
assert (memory.drafts.size() == 2);
assert (memory.nextDraftId == 3);

// Bookmarks survive the same rebuild.
switch (restored.nuance_toggle_bookmark("18318", "434go-diaaa-aaaaf-qakwq-cai", "T", "brian")) {
    case (#ok(_)) {};
    case (#err(_)) assert false;
};
let again = app(memory);
assert (again.nuance_bookmarks().size() == 1);

// The shard allowlist starts empty and is seeded from the packaged constants on
// first use, so a later upgrade cannot silently drop shards the owner granted.
assert (memory.buckets.size() == 0);
switch (again.nuance_register_bucket(Principal.fromText("aaaaa-aa"))) {
    case (#ok(_)) {};
    case (#err(_)) assert false;
};
assert (memory.buckets.size() == 5);

// A state snapshot needs no network and reflects the retained root.
let snapshot = again.nuance_state();
assert (snapshot.drafts.size() == 2);
assert (snapshot.bookmarks.size() == 1);
assert (not snapshot.identity.registered);
assert (snapshot.identity.note != "");
