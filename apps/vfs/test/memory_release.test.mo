import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Memory "../backend/memory/files/v2";

func compareBlockKey(
    left : Memory.BlockKey,
    right : Memory.BlockKey,
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

func comparePlainBlockKey(
    left : Memory.PlainBlockKey,
    right : Memory.PlainBlockKey,
) : { #less; #equal; #greater } {
    switch (Nat64.compare(left.0, right.0)) {
        case (#equal) Nat32.compare(left.1, right.1);
        case (order) order;
    };
};

// Fresh installs use the released v2 defaults, including both plaintext roots.
let fresh = Memory.init();
assert (fresh.next_stage_id == 1 and fresh.next_job_id == 1);
assert (fresh.next_share_id == 1 and fresh.share_list_revision == 0);
assert (fresh.vault == null and Map.size(fresh.blocks) == 0);
assert (fresh.next_plain_node_id == Memory.FIRST_PLAIN_NODE_ID);
assert (fresh.workspace_root_id == Memory.WORKSPACE_ROOT_ID);
assert (fresh.shared_root_id == Memory.SHARED_ROOT_ID);
assert (Map.size(fresh.plain_nodes) == 2);
assert (Map.size(fresh.plain_blocks) == 0);
assert (fresh.workspace_plaintext_bytes == 0);
assert (fresh.shared_plaintext_bytes == 0);

// Files 0.4.3 already runs v2. The archive transition test proves the
// license-only 0.4.4 release is #keep, so representative Vault and plaintext
// plane data must survive without calling init() again.
let vaultBlock : Memory.BlockKey = (21, 22, 0);
let plainBlock : Memory.PlainBlockKey = (31, 0);
let vaultCiphertext : Blob = "vault ciphertext";
let plainBytes : Blob = "plain bytes";
fresh.next_stage_id := 71;
fresh.next_job_id := 72;
fresh.next_share_id := 73;
fresh.share_list_revision := 74;
fresh.vault := ?{
    format = 2;
    vault_id = { hi = 10; lo = 11 };
    vault_salt = (1, 2, 3, 4);
    slot_generation = 12;
    public_key_fingerprint = (5, 6, 7, 8);
    ibe_wrapped_root_key = "wrapped";
    root_commitment = (9, 10, 11, 12);
    record_revision = 13;
};
Map.add(fresh.blocks, compareBlockKey, vaultBlock, vaultCiphertext);
fresh.node_count := 3;
fresh.committed_private_plaintext_bytes := 123;
fresh.committed_ciphertext_bytes := 456;
fresh.next_plain_node_id := 19;
fresh.next_plain_content_id := 32;
fresh.next_plain_stage_id := 17;
Map.add(fresh.plain_blocks, comparePlainBlockKey, plainBlock, plainBytes);
fresh.workspace_plaintext_bytes := 789;
fresh.shared_plaintext_bytes := 321;
fresh.shared_file_count := 2;
fresh.staged_workspace_bytes := 17;

let restored : Memory.Mem = fresh;
assert (restored.next_stage_id == 71 and restored.next_job_id == 72);
assert (restored.next_share_id == 73 and restored.share_list_revision == 74);
assert (restored.node_count == 3);
assert (restored.committed_private_plaintext_bytes == 123);
assert (restored.committed_ciphertext_bytes == 456);
assert (Map.get(restored.blocks, compareBlockKey, vaultBlock) == ?vaultCiphertext);
assert (restored.next_plain_node_id == 19);
assert (restored.next_plain_content_id == 32);
assert (restored.next_plain_stage_id == 17);
assert (Map.get(restored.plain_blocks, comparePlainBlockKey, plainBlock) == ?plainBytes);
assert (restored.workspace_plaintext_bytes == 789);
assert (restored.shared_plaintext_bytes == 321);
assert (restored.shared_file_count == 2);
assert (restored.staged_workspace_bytes == 17);
