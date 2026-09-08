// backend.test.mo covers clean initialization and individual write validation.
// This program covers rebuilding the real backend over retained managed memory.
import Blob "mo:core/Blob";
import Taggr "../backend/main";
import Memory "../backend/memory/identity/v1";

// Public test seed, not an account credential. Every field is populated to
// expose any constructor reset or dropped setting during an app upgrade.
let seed = Blob.fromArray([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24,
    25, 26, 27, 28, 29, 30, 31, 32,
]);
let memory = Memory.init();
memory.secret_key := ?seed;
memory.canister_id := ?"6qfxa-ryaaa-aaaai-qbhsq-cai";
memory.domain := ?"taggr.link";
memory.created_at := 1_700_000_000_000_000_000;
memory.updated_at := 1_700_000_010_000_000_000;
memory.revision := 42;

let restored = Taggr.Init({ stable_memory = { identity = memory } });
let snapshot = restored.taggr_state_read(());
assert (snapshot.secret_key == ?seed);
assert (snapshot.canister_id == ?"6qfxa-ryaaa-aaaai-qbhsq-cai");
assert (snapshot.domain == ?"taggr.link");
assert (snapshot.created_at == 1_700_000_000_000_000_000);
assert (snapshot.updated_at == 1_700_000_010_000_000_000);
assert (snapshot.revision == 42);

// A normal settings change must still write through to that same root. It
// continues the saved revision and never rotates the account key or its age.
switch (restored.taggr_settings_write({ canister_id = "6qfxa-ryaaa-aaaai-qbhsq-cai"; domain = null })) {
    case (#ok(updated)) {
        assert (updated.secret_key == snapshot.secret_key);
        assert (updated.created_at == snapshot.created_at);
        assert (updated.revision == 43);
    };
    case (#err(_)) assert false;
};
assert (memory.secret_key == ?seed);
assert (memory.domain == null);
assert (memory.revision == 43);
assert (memory.created_at == snapshot.created_at);

let again = Taggr.Init({ stable_memory = { identity = memory } });
let saved = again.taggr_state_read(());
assert (saved.secret_key == ?seed);
assert (saved.canister_id == snapshot.canister_id);
assert (saved.domain == null);
assert (saved.created_at == snapshot.created_at);
assert (saved.updated_at == memory.updated_at);
assert (saved.revision == 43);

// An explicitly cleared account remains cleared after another reconstruction;
// the backend must not regenerate a key or reset unrelated settings/history.
let cleared = again.taggr_identity_clear(());
let afterClear = Taggr.Init({ stable_memory = { identity = memory } }).taggr_state_read(());
assert (afterClear.secret_key == null);
assert (afterClear.canister_id == snapshot.canister_id);
assert (afterClear.domain == null);
assert (afterClear.created_at == snapshot.created_at);
assert (afterClear.updated_at == cleared.updated_at);
assert (afterClear.revision == 44);
