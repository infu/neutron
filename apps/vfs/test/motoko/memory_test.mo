import Map "mo:core/Map";
import Memory "../../backend/memory/files/v1";

let mem = Memory.init();

assert (mem.next_stage_id == 1);
assert (mem.next_job_id == 1);
assert (mem.next_share_id == 1);
assert (mem.share_list_revision == 0);
assert (mem.vault == null);

assert (Map.size(mem.nodes_by_id) == 0);
assert (Map.size(mem.children_by_name) == 0);
assert (Map.size(mem.blocks) == 0);
assert (Map.size(mem.stages) == 0);
assert (Map.size(mem.stages_by_request) == 0);
assert (Map.size(mem.private_receipts) == 0);
assert (Map.size(mem.private_receipts_by_expiry) == 0);
assert (Map.size(mem.private_receipt_identity_owners) == 0);
assert (Map.size(mem.delete_jobs) == 0);
assert (Map.size(mem.share_lifecycle_by_id) == 0);
assert (Map.size(mem.share_by_publish_request) == 0);
assert (Map.size(mem.share_by_delete_request) == 0);
assert (Map.size(mem.share_lifecycle_by_expiry) == 0);
assert (Map.size(mem.public_terminal_receipts) == 0);
assert (Map.size(mem.public_terminal_by_expiry) == 0);

assert (mem.node_count == 0);
assert (mem.committed_private_plaintext_bytes == 0);
assert (mem.committed_ciphertext_bytes == 0);
assert (mem.staged_ciphertext_bytes == 0);
assert (mem.reserved_staged_ciphertext_bytes == 0);
assert (mem.physical_private_bytes == 0);
assert (mem.reserved_physical_private_bytes == 0);
assert (mem.reserved_cleanup_jobs == 0);

// The filesystem root is created atomically with the vault wrapper. A fresh
// memory root therefore has neither a vault nor a partially initialized node.
let root : Memory.Id128 = { hi = 0; lo = 0 };
assert (Map.get(mem.nodes_by_id, func(left, right) {
    if (left.hi < right.hi) #less else if (left.hi > right.hi) #greater else if (left.lo < right.lo) #less else if (left.lo > right.lo) #greater else #equal;
}, root) == null);
