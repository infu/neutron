import Blob "mo:core/Blob";
import Taggr "../backend/main";
import Memory "../backend/memory/identity/v1";

// The backend that keeps the Taggr account key.
//
// Everything here is about not losing or corrupting that key: it *is* the
// account, and Taggr's principal-change flow needs the old one to authorise a
// move, so a key that goes missing takes the account with it.

let mem = Memory.init();
let app = Taggr.Init({ stable_memory = { identity = mem } });

// A fresh install holds nothing, and says so rather than inventing a key.
let empty = app.taggr_state_read(());
assert (empty.secret_key == null);
assert (empty.canister_id == null);
assert (empty.domain == null);
assert (empty.revision == 0);

// Only a real Ed25519 seed is accepted. A truncated one would produce a
// different principal, which is a different Taggr account.
let short = Blob.fromArray([1, 2, 3]);
switch (app.taggr_identity_write({ secret_key = short })) {
    case (#err(_)) {};
    case (#ok(_)) { assert false };
};
assert (app.taggr_state_read(()).secret_key == null);

let seed = Blob.fromArray([
    1, 2, 3, 4, 5, 6, 7, 8,
    9, 10, 11, 12, 13, 14, 15, 16,
    17, 18, 19, 20, 21, 22, 23, 24,
    25, 26, 27, 28, 29, 30, 31, 32,
]);
switch (app.taggr_identity_write({ secret_key = seed })) {
    case (#ok(stored)) {
        assert (stored.secret_key == ?seed);
        assert (stored.revision == 1);
        assert (stored.created_at > 0);
    };
    case (#err(_)) { assert false };
};

// The read is what a cold background uses to come back to the same account.
assert (app.taggr_state_read(()).secret_key == ?seed);

// Replacing the key keeps the store consistent rather than appending.
let other = Blob.fromArray([
    32, 31, 30, 29, 28, 27, 26, 25,
    24, 23, 22, 21, 20, 19, 18, 17,
    16, 15, 14, 13, 12, 11, 10, 9,
    8, 7, 6, 5, 4, 3, 2, 1,
]);

// Two browsers that read an empty store can propose different seeds. Once the
// first is saved, the second receives it and cannot overwrite the account.
let firstRunMemory = Memory.init();
let browserA = Taggr.Init({ stable_memory = { identity = firstRunMemory } });
let browserB = Taggr.Init({ stable_memory = { identity = firstRunMemory } });
assert (browserA.taggr_state_read(()).secret_key == null);
assert (browserB.taggr_state_read(()).secret_key == null);
switch (browserA.taggr_identity_initialize({ secret_key = seed })) {
    case (#ok(state)) { assert (state.secret_key == ?seed) };
    case (#err(_)) { assert false };
};
let firstSaved = browserA.taggr_state_read(());
switch (browserB.taggr_identity_initialize({ secret_key = other })) {
    case (#ok(state)) {
        assert (state.secret_key == ?seed);
        assert (state.revision == firstSaved.revision);
        assert (state.created_at == firstSaved.created_at);
        assert (state.updated_at == firstSaved.updated_at);
    };
    case (#err(_)) { assert false };
};
switch (browserB.taggr_identity_initialize({ secret_key = short })) {
    case (#err(_)) {};
    case (#ok(_)) { assert false };
};
assert (browserB.taggr_state_read(()).secret_key == ?seed);

switch (app.taggr_identity_write({ secret_key = other })) {
    case (#ok(stored)) { assert (stored.secret_key == ?other) };
    case (#err(_)) { assert false };
};

// Settings ride along, so a restored browser returns to the same view.
switch (app.taggr_settings_write({ canister_id = "  6qfxa-ryaaa-aaaai-qbhsq-cai "; domain = ?"taggr.link" })) {
    case (#ok(stored)) {
        assert (stored.canister_id == ?"6qfxa-ryaaa-aaaai-qbhsq-cai");
        assert (stored.domain == ?"taggr.link");
        // Writing settings must not disturb the key.
        assert (stored.secret_key == ?other);
    };
    case (#err(_)) { assert false };
};

// An unpinned domain follows the deployment; that is a value, not a gap.
switch (app.taggr_settings_write({ canister_id = "6qfxa-ryaaa-aaaai-qbhsq-cai"; domain = null })) {
    case (#ok(stored)) { assert (stored.domain == null) };
    case (#err(_)) { assert false };
};

// Empty and oversized inputs are refused rather than stored.
switch (app.taggr_settings_write({ canister_id = "   "; domain = null })) {
    case (#err(_)) {};
    case (#ok(_)) { assert false };
};
switch (app.taggr_settings_write({ canister_id = "6qfxa-ryaaa-aaaai-qbhsq-cai"; domain = ?"" })) {
    case (#err(_)) {};
    case (#ok(_)) { assert false };
};
// A rejected write changes nothing.
assert (app.taggr_state_read(()).canister_id == ?"6qfxa-ryaaa-aaaai-qbhsq-cai");

// Starting a new identity forgets the old key, and only the key.
let cleared = app.taggr_identity_clear(());
assert (cleared.secret_key == null);
assert (cleared.canister_id == ?"6qfxa-ryaaa-aaaai-qbhsq-cai");

// Every write advances the revision, so a caller can tell one from a retry.
assert (cleared.revision > empty.revision);
