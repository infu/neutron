import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Char "mo:core/Char";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Sha256 "mo:sha2/Sha256";
import Text "mo:core/Text";
import Blast "../backend/main";
import Memory "../backend/memory/blast/v1";

func fail<T>() : T {
    assert false;
    loop {};
};

func saveOk(response : Blast.ScriptSaveResponseV1) : Blast.ScriptSaveSuccessV1 {
    switch (response.outcome) {
        case (?#ok(value)) value;
        case (_) fail();
    };
};

func saveRejection(response : Blast.ScriptSaveResponseV1) : Blast.ScriptRejectionV1 {
    switch (response.outcome) {
        case (?#rejected(reason)) reason;
        case (_) fail();
    };
};

func listOk(response : Blast.ScriptListResponseV1) : Blast.ScriptListPageV1 {
    switch (response.outcome) {
        case (?#ok(value)) value;
        case (_) fail();
    };
};

func createRequest(name : Text, source : Blob) : Blast.ScriptSaveRequestV1 {
    {
        id = null;
        expected_revision = null;
        name;
        description = ?"Saved script";
        source_utf8 = source;
    };
};

func repeatedText(char : Char, size : Nat) : Text {
    Text.fromArray(Array.repeat<Char>(char, size));
};

let abc = Text.encodeUtf8("abc");
let abcSha256 = Blob.fromArray([
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
    0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
    0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
]);
assert (Blob.equal(Sha256.fromBlob(#sha256, abc), abcSha256));
let maximumSource = Blob.fromArray(
    Array.repeat<Nat8>(0x61, Blast.MAX_SOURCE_BYTES_V1)
);

// Create, conflict, replace, clock rollback, get, and delete are atomic.
do {
    let mem = Memory.init();
    var clock : Nat64 = 100;
    let store = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    let created = saveOk(store.save({
        id = null;
        expected_revision = null;
        name = "Unicode λ script";
        description = ?"所有者の script";
        source_utf8 = abc;
    }));
    assert (created.script.id == 1);
    assert (created.script.revision == 1);
    assert (created.script.created_at_ns == 100);
    assert (created.script.updated_at_ns == 100);
    assert (created.script.source_bytes == 3);
    assert (Blob.equal(created.script.source_sha256, abcSha256));
    assert (created.library_revision == 1);
    assert (created.total_source_bytes == 3);
    assert (mem.next_script_id == 2);
    assert (Blast.validMemoryV1(mem));

    let beforeConflictRevision = mem.library_revision;
    let beforeConflictBytes = mem.total_source_bytes;
    switch (saveRejection(store.save({
        id = ?1;
        expected_revision = ?2;
        name = "Unicode λ script";
        description = ?"Conflict";
        source_utf8 = Text.encodeUtf8("return 2;");
    }))) {
        case (#revision_conflict(conflict)) {
            assert (conflict.expected == 2 and conflict.actual == 1);
        };
        case (_) assert false;
    };
    assert (mem.library_revision == beforeConflictRevision);
    assert (mem.total_source_bytes == beforeConflictBytes);

    clock := 200;
    let unicodeSource = Text.encodeUtf8("// 你好\nreturn 'λ';");
    let replaced = saveOk(store.save({
        id = ?1;
        expected_revision = ?1;
        name = "Unicode λ script";
        description = ?"Updated";
        source_utf8 = unicodeSource;
    }));
    assert (replaced.script.id == 1);
    assert (replaced.script.revision == 2);
    assert (replaced.script.created_at_ns == 100);
    assert (replaced.script.updated_at_ns == 200);
    assert (replaced.total_source_bytes == Nat64.fromNat(unicodeSource.size()));

    switch (store.get({ id = 1 }).outcome) {
        case (?#ok(script)) {
            assert (script.revision == 2);
            assert (Blob.equal(script.source_utf8, unicodeSource));
            assert (Blob.equal(
                script.source_sha256,
                Sha256.fromBlob(#sha256, unicodeSource),
            ));
        };
        case (_) assert false;
    };

    clock := 199;
    assert (saveRejection(store.save({
        id = ?1;
        expected_revision = ?2;
        name = "Unicode λ script";
        description = null;
        source_utf8 = abc;
    })) == #clock_regressed);
    assert (mem.library_revision == 2);
    assert (mem.total_source_bytes == Nat64.fromNat(unicodeSource.size()));

    switch (store.delete({ id = 1; expected_revision = 1 }).outcome) {
        case (?#rejected(#revision_conflict(conflict))) {
            assert (conflict.expected == 1 and conflict.actual == 2);
        };
        case (_) assert false;
    };
    assert (mem.library_revision == 2);
    switch (store.delete({ id = 1; expected_revision = 2 }).outcome) {
        case (?#ok(deleted)) {
            assert (deleted.id == 1 and deleted.deleted_revision == 2);
            assert (deleted.library_revision == 3);
            assert (deleted.total_source_bytes == 0);
        };
        case (_) assert false;
    };
    assert (Map.size(mem.scripts) == 0);
    assert (mem.next_script_id == 2);
    assert (Blast.validMemoryV1(mem));
};

// Keyset pagination is exclusive, has lookahead, and is revision-bound.
do {
    let mem = Memory.init();
    var clock : Nat64 = 1_000;
    let store = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    ignore saveOk(store.save(createRequest("One", Text.encodeUtf8("1"))));
    clock += 1;
    ignore saveOk(store.save(createRequest("Two", Text.encodeUtf8("22"))));
    clock += 1;
    ignore saveOk(store.save(createRequest("Three", Text.encodeUtf8("333"))));

    let first = listOk(store.list({ cursor = null; limit = 2 }));
    assert (first.scripts.size() == 2);
    assert (first.scripts[0].id == 1 and first.scripts[1].id == 2);
    assert (first.total == 3 and first.total_source_bytes == 6);
    let cursor = switch (first.next_cursor) {
        case (?value) value;
        case null fail();
    };
    assert (cursor.after_id == 2 and cursor.library_revision == 3);
    let second = listOk(store.list({ cursor = ?cursor; limit = 2 }));
    assert (second.scripts.size() == 1 and second.scripts[0].id == 3);
    assert (second.next_cursor == null);

    switch (store.list({ cursor = null; limit = 0 }).outcome) {
        case (?#rejected(#invalid_request)) {};
        case (_) assert false;
    };
    switch (store.list({ cursor = null; limit = Blast.MAX_PAGE_V1 + 1 }).outcome) {
        case (?#rejected(#invalid_request)) {};
        case (_) assert false;
    };
    switch (store.list({
        cursor = ?{ after_id = 99; library_revision = 3 };
        limit = 1;
    }).outcome) {
        case (?#rejected(#cursor_stale(stale))) {
            assert (stale.expected_library_revision == 3);
            assert (stale.actual_library_revision == 3);
        };
        case (_) assert false;
    };

    clock += 1;
    ignore saveOk(store.save(createRequest("Four", Text.encodeUtf8("4444"))));
    switch (store.list({ cursor = ?cursor; limit = 2 }).outcome) {
        case (?#rejected(#cursor_stale(stale))) {
            assert (stale.expected_library_revision == 3);
            assert (stale.actual_library_revision == 4);
        };
        case (_) assert false;
    };
};

// Request validation is canonical and source validation is byte-exact UTF-8.
do {
    let mem = Memory.init();
    let clock : Nat64 = 1;
    let store = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    assert (saveRejection(store.save(createRequest(" Leading", abc))) == #invalid_name);
    assert (saveRejection(store.save(createRequest("Trailing ", abc))) == #invalid_name);
    let nonBreakingSpace = Char.fromNat32(0x00A0);
    assert (saveRejection(store.save(createRequest(
        Text.fromArray([nonBreakingSpace, 'N', 'a', 'm', 'e']),
        abc,
    ))) == #invalid_name);
    assert (saveRejection(store.save(createRequest(
        Text.fromArray(['N', 'a', 'm', 'e', Char.fromNat32(0x3000)]),
        abc,
    ))) == #invalid_name);
    assert (saveRejection(store.save(createRequest("Bad\nName", abc))) == #invalid_name);
    let bidiName = Text.fromArray(['O', 'k', Char.fromNat32(0x202E)]);
    assert (saveRejection(store.save(createRequest(bidiName, abc))) == #invalid_name);
    assert (saveRejection(store.save({
        id = null;
        expected_revision = null;
        name = "Description";
        description = ?"";
        source_utf8 = abc;
    })) == #invalid_description);
    assert (saveRejection(store.save({
        id = null;
        expected_revision = null;
        name = "Description";
        description = ?Text.fromArray([nonBreakingSpace, 'T', 'e', 'x', 't']);
        source_utf8 = abc;
    })) == #invalid_description);
    assert (saveRejection(store.save({
        id = null;
        expected_revision = null;
        name = "Description";
        description = ?repeatedText('x', Blast.MAX_DESCRIPTION_BYTES_V1 + 1);
        source_utf8 = abc;
    })) == #invalid_description);
    assert (saveRejection(store.save(createRequest("Empty", Blob.fromArray([])))) == #invalid_source);
    assert (saveRejection(store.save(createRequest("Invalid UTF-8", Blob.fromArray([0xff])))) == #invalid_source);
    assert (saveRejection(store.save(createRequest(
        "Oversized",
        Blob.fromArray(Array.repeat<Nat8>(0x61, Blast.MAX_SOURCE_BYTES_V1 + 1)),
    ))) == #invalid_source);
    assert (Map.size(mem.scripts) == 0);
    assert (mem.next_script_id == 1 and mem.library_revision == 0);
};

do {
    let mem = Memory.init();
    let clock : Nat64 = 1;
    let store = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    let maximumName = repeatedText(Char.fromNat32(0x1F680), Blast.MAX_NAME_SCALARS_V1);
    let maximumDescription = repeatedText('x', Blast.MAX_DESCRIPTION_BYTES_V1);
    ignore saveOk(store.save({
        id = null;
        expected_revision = null;
        name = maximumName;
        description = ?maximumDescription;
        source_utf8 = abc;
    }));
    assert (saveRejection(store.save(createRequest(
        repeatedText('n', Blast.MAX_NAME_SCALARS_V1 + 1),
        abc,
    ))) == #invalid_name);
};

// The exact 128 KiB source boundary is accepted and hashed.
do {
    let mem = Memory.init();
    let clock : Nat64 = 1;
    let store = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    let saved = saveOk(store.save(createRequest("Maximum source", maximumSource)));
    assert (saved.script.source_bytes == Nat32.fromNat(Blast.MAX_SOURCE_BYTES_V1));
    assert (saved.total_source_bytes == Nat64.fromNat(Blast.MAX_SOURCE_BYTES_V1));
    assert (Blast.validMemoryV1(mem));
};

// The bounded map admits exactly 128 scripts and rejects the next atomically.
do {
    let mem = Memory.init();
    var clock : Nat64 = 10_000;
    let store = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    var index = 0;
    while (index < Blast.MAX_SCRIPTS_V1) {
        ignore saveOk(store.save(createRequest(
            "Script " # Nat.toText(index + 1),
            Text.encodeUtf8("x"),
        )));
        clock += 1;
        index += 1;
    };
    assert (Map.size(mem.scripts) == Blast.MAX_SCRIPTS_V1);
    assert (mem.library_revision == 128 and mem.next_script_id == 129);
    assert (saveRejection(store.save(createRequest("One too many", abc))) == #script_limit);
    assert (Map.size(mem.scripts) == Blast.MAX_SCRIPTS_V1);
    assert (mem.library_revision == 128 and mem.next_script_id == 129);

    // A full catalogue can replace one entry with the maximum source without
    // rescanning every other script, then recover capacity through deletion.
    clock += 1;
    let replaced = saveOk(store.save({
        id = ?128;
        expected_revision = ?1;
        name = "Maximum source at full count";
        description = null;
        source_utf8 = maximumSource;
    }));
    assert (replaced.script.revision == 2);
    assert (
        replaced.total_source_bytes == Nat64.fromNat(
            Blast.MAX_SOURCE_BYTES_V1 + Blast.MAX_SCRIPTS_V1 - 1
        )
    );

    switch (store.delete({ id = 1; expected_revision = 1 }).outcome) {
        case (?#ok(_)) {};
        case (_) assert false;
    };
    clock += 1;
    let replacement = saveOk(
        store.save(createRequest("Replacement after delete", abc))
    );
    assert (replacement.script.id == 129);
    assert (Map.size(mem.scripts) == Blast.MAX_SCRIPTS_V1);
    assert (mem.library_revision == 131 and mem.next_script_id == 130);
    assert (
        mem.total_source_bytes == Nat64.fromNat(
            Blast.MAX_SOURCE_BYTES_V1 + Blast.MAX_SCRIPTS_V1 - 2 + abc.size()
        )
    );
    assert (Blast.validMemoryV1(mem));
};

// Retained-state integrity is checked once when the store is initialized. A
// store that opens invalid memory remains closed even if the caller later
// changes that test-owned memory reference.
do {
    let mem = Memory.init();
    let clock : Nat64 = 100;
    let writer = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    ignore saveOk(writer.save(createRequest("Digest", abc)));
    let stored = switch (Map.get(mem.scripts, Nat64.compare, Nat64.fromNat(1))) {
        case (?value) value;
        case null fail();
    };
    Map.add(mem.scripts, Nat64.compare, Nat64.fromNat(1), {
        stored with source_sha256 = Blob.fromArray(Array.repeat<Nat8>(0, 32))
    });
    assert (not Blast.validMemoryV1(mem));
    let rejected = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    switch (rejected.get({ id = 1 }).outcome) {
        case (?#rejected(#corrupt_state)) {};
        case (_) assert false;
    };
    switch (rejected.list({ cursor = null; limit = 1 }).outcome) {
        case (?#rejected(#corrupt_state)) {};
        case (_) assert false;
    };
    switch (rejected.save(createRequest("Blocked", abc)).outcome) {
        case (?#rejected(#corrupt_state)) {};
        case (_) assert false;
    };
    switch (rejected.delete({ id = 1; expected_revision = 1 }).outcome) {
        case (?#rejected(#corrupt_state)) {};
        case (_) assert false;
    };
    assert (mem.library_revision == 1 and mem.next_script_id == 2);

    Map.add(mem.scripts, Nat64.compare, Nat64.fromNat(1), stored);
    assert (Blast.validMemoryV1(mem));
    switch (rejected.get({ id = 1 }).outcome) {
        case (?#rejected(#corrupt_state)) {};
        case (_) assert false;
    };
    let restored = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    switch (restored.get({ id = 1 }).outcome) {
        case (?#ok(_)) {};
        case (_) assert false;
    };

    mem.total_source_bytes := 4;
    let badCounter = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    switch (badCounter.list({ cursor = null; limit = 1 }).outcome) {
        case (?#rejected(#corrupt_state)) {};
        case (_) assert false;
    };
    mem.total_source_bytes := 3;
    Map.remove(mem.scripts, Nat64.compare, Nat64.fromNat(1));
    Map.add(mem.scripts, Nat64.compare, Nat64.fromNat(2), stored);
    let badKey = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    switch (badKey.get({ id = 1 }).outcome) {
        case (?#rejected(#corrupt_state)) {};
        case (_) assert false;
    };
};

do {
    let mem = Memory.init();
    let source = Blob.fromArray([0xff]);
    let malformed : Memory.Script = {
        id = 1;
        revision = 1;
        name = "Invalid UTF-8";
        description = null;
        source_utf8 = source;
        source_sha256 = Sha256.fromBlob(#sha256, source);
        source_bytes = 1;
        created_at_ns = 1;
        updated_at_ns = 1;
    };
    mem.next_script_id := 2;
    mem.library_revision := 1;
    mem.total_source_bytes := 1;
    Map.add(mem.scripts, Nat64.compare, Nat64.fromNat(1), malformed);
    let clock : Nat64 = 2;
    let store = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    assert (not Blast.validMemoryV1(mem));
    switch (store.list({ cursor = null; limit = 1 }).outcome) {
        case (?#rejected(#corrupt_state)) {};
        case (_) assert false;
    };
};

do {
    let mem = Memory.init();
    mem.library_revision := 18_446_744_073_709_551_615;
    let clock : Nat64 = 1;
    let store = Blast.ScriptStoreV1(mem, func() : Nat64 { clock });
    assert (saveRejection(store.save(createRequest("Exhausted", abc))) == #capacity_exhausted);
    assert (Map.size(mem.scripts) == 0 and mem.next_script_id == 1);
};
