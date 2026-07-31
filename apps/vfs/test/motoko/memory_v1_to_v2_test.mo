import Map "mo:core/Map";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import V1 "../../backend/memory/files/v1";
import Migration "../../backend/memory/files/v1_to_v2";

func compareBlockKey(
    left : V1.BlockKey,
    right : V1.BlockKey,
) : { #less; #equal; #greater } {
    switch (Nat64.compare(left.0, right.0)) {
        case (#equal) {
            switch (Nat64.compare(left.1, right.1)) {
                case (#equal) Nat32.compare(left.2, right.2);
                case (order) order;
            };
        };
        case (order) order;
    };
};

let old = V1.init();
old.next_stage_id := 71;
old.next_job_id := 72;
old.next_share_id := 73;
old.share_list_revision := 74;
old.node_count := 3;
old.committed_private_plaintext_bytes := 123;
old.committed_ciphertext_bytes := 456;
old.vault := ?{
    format = 2;
    vault_id = { hi = 10; lo = 11 };
    vault_salt = (1, 2, 3, 4);
    slot_generation = 12;
    public_key_fingerprint = (5, 6, 7, 8);
    ibe_wrapped_root_key = "wrapped";
    root_commitment = (9, 10, 11, 12);
    record_revision = 13;
};
let blockKey : V1.BlockKey = (21 : Nat64, 22 : Nat64, 0 : Nat32);
let ciphertext : Blob = "ciphertext";
Map.add(old.blocks, compareBlockKey, blockKey, ciphertext);

let migrated = Migration.migrate(old);

assert (migrated.next_stage_id == 71);
assert (migrated.next_job_id == 72);
assert (migrated.next_share_id == 73);
assert (migrated.share_list_revision == 74);
assert (migrated.node_count == 3);
assert (migrated.committed_private_plaintext_bytes == 123);
assert (migrated.committed_ciphertext_bytes == 456);
assert (migrated.vault == old.vault);
assert (
    Map.get(migrated.blocks, compareBlockKey, blockKey) == ?ciphertext
);

assert (migrated.workspace_root_id == 1);
assert (migrated.shared_root_id == 2);
assert (Map.size(migrated.plain_nodes) == 2);
assert (Map.size(migrated.plain_children) == 0);
assert (Map.size(migrated.plain_blocks) == 0);
assert (Map.size(migrated.plain_stages) == 0);
assert (Map.size(migrated.plain_terminal_receipts) == 0);
assert (migrated.workspace_plaintext_bytes == 0);
assert (migrated.shared_plaintext_bytes == 0);
assert (migrated.shared_file_count == 0);

// The legacy maps are deliberately retained by reference, not copied.
let laterKey : V1.BlockKey = (21 : Nat64, 22 : Nat64, 1 : Nat32);
let later : Blob = "later";
Map.add(old.blocks, compareBlockKey, laterKey, later);
assert (
    Map.get(
        migrated.blocks,
        compareBlockKey,
        laterKey,
    ) == ?later
);
