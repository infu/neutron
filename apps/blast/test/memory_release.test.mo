import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Sha256 "mo:sha2/Sha256";
import Text "mo:core/Text";
import Blast "../backend/main";
import Memory "../backend/memory/blast/v1";

let fresh = Memory.init();
assert (fresh.next_script_id == 1);
assert (fresh.library_revision == 0);
assert (fresh.total_source_bytes == 0);
assert (Map.size(fresh.scripts) == 0);
assert (Blast.validMemoryV1(fresh));

let source = Text.encodeUtf8("// 代表的な UTF-8\nreturn 7;");
let retained : Memory.Script = {
    id = 7;
    revision = 3;
    name = "Retained λ script";
    description = ?"Representative saved source";
    source_utf8 = source;
    source_sha256 = Sha256.fromBlob(#sha256, source);
    source_bytes = Nat32.fromNat(source.size());
    created_at_ns = 100;
    updated_at_ns = 200;
};
fresh.next_script_id := 8;
fresh.library_revision := 9;
fresh.total_source_bytes := Nat64.fromNat(source.size());
Map.add(fresh.scripts, Nat64.compare, retained.id, retained);
assert (Blast.validMemoryV1(fresh));

// Reconstructing Init over the exact retained root models actor assembly after
// a code-only upgrade: no initializer is allowed to replace the map or counters.
let restored : Memory.Mem = fresh;
let blast = Blast.Init({ stable_memory = { blast = restored } });
let page = switch (
    blast.blast_scripts_list_v1({ cursor = null; limit = 10 }).outcome
) {
    case (?#ok(value)) value;
    case (_) { assert false; loop {} };
};
assert (page.library_revision == 9);
assert (page.total == 1);
assert (page.total_source_bytes == Nat64.fromNat(source.size()));
assert (page.scripts[0].id == 7);
assert (page.scripts[0].source_bytes == Nat32.fromNat(source.size()));

switch (blast.blast_script_get_v1({ id = 7 }).outcome) {
    case (?#ok(script)) {
        assert (script.revision == 3);
        assert (Blob.equal(script.source_utf8, source));
        assert (Blob.equal(script.source_sha256, retained.source_sha256));
    };
    case (_) assert false;
};

assert (restored.next_script_id == 8);
assert (restored.library_revision == 9);
assert (restored.total_source_bytes == Nat64.fromNat(source.size()));
assert (Map.size(restored.scripts) == 1);
