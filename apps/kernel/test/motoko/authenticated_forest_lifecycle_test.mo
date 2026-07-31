import Text "mo:core/Text";
import Forest "../../backend/certified_assets/AuthenticatedForest";

let profile : Blob = "authenticated-forest-test-profile-v1";
let allocator : Blob = "0123456789abcdef0123456789abcdef";
let memory = Forest.init(profile, allocator);
func p(parts : [Text]) : [Blob] {
    let result = [];
    // Keep this focused fixture allocation-free outside the forest.
    switch (parts.size()) {
        case (1) [Text.encodeUtf8(parts[0])];
        case (2) [Text.encodeUtf8(parts[0]), Text.encodeUtf8(parts[1])];
        case (_) { assert false; result };
    };
};
assert (
    Forest.put(memory, p(["mount", "a"]), "A") ==
    #ok({ inserted = true; prior = null })
);
assert (
    Forest.put(memory, p(["mount", "b"]), "B") ==
    #ok({ inserted = true; prior = null })
);
ignore Forest.commit(memory);
let first = switch (Forest.detach(memory, p(["mount"]))) {
    case (#ok(token)) token;
    case (#err(_)) { assert false; loop {} };
};
ignore Forest.commit(memory);
assert (Forest.attach(memory, first) == #ok);
ignore Forest.commit(memory);
let second = switch (Forest.detach(memory, p(["mount"]))) {
    case (#ok(token)) token;
    case (#err(_)) { assert false; loop {} };
};
switch (Forest.putDetached(memory, second, p(["c"]), "C")) {
    case (#ok(result)) {
        assert (result.inserted);
        assert (result.token.detach_epoch != second.detach_epoch);
    };
    case (#err(error)) {
        assert false;
    };
};
