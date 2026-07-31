import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Capabilities "mo:neutron-capabilities";
import Memory "../../backend/memory/files/v1";
import Frames "../../backend/files/Frames";
import Keys "../../backend/files/Keys";
import Service "../../backend/files/Service";
import Types "../../backend/files/Types";
import Fixtures "Fixtures";

func assertReason<T>(result : Types.Result<T>, expected : Types.RejectionReason) {
    switch (result) {
        case (#err({ reason = ?actual })) assert (actual == expected);
        case (_) assert false;
    };
};

func changedLast(body : Blob) : Blob {
    Blob.fromArray(
        Array.tabulate<Nat8>(
            body.size(),
            func(index) {
                if (index + 1 == body.size()) body[index] + 1 else body[index];
            },
        )
    );
};

var now : Nat64 = 1_000;
let mem = Memory.init();
let baseUsage = Fixtures.zeroUsage();
let usage : Capabilities.Usage = {
    baseUsage with
    current = {
        baseUsage.current with
        live_entries = 7;
        allocated_body_bytes = 99;
        receipt_lanes = 3;
    };
    manifest_limits = {
        baseUsage.manifest_limits with
        entries = 256;
        staged_bytes = 33_554_720;
    };
    effective_limits = {
        baseUsage.effective_limits with
        entries = 200;
        staged_bytes = 30_000_000;
    };
};
let service = Service.Service(mem, Fixtures.assets(usage), func() { now });

switch (service.bootstrap()) {
    case (#ok(initial)) {
        assert (initial.body.size() == 0);
        assert (initial.value.body_bytes == 0);
        assert (initial.value.vault == ?#absent);
        assert (initial.value.quota.nodes == 0);
        assert (initial.value.public_usage.current.live_entries == 7);
        assert (
            initial.value.public_usage.current.allocated_body_bytes == 99
        );
        assert (
            initial.value.public_usage.manifest_limits.entries == 256
        );
        assert (
            initial.value.public_usage.effective_limits.entries == 200
        );
    };
    case (_) assert false;
};

let vaultRequestId = Fixtures.id(1);
let vaultBody = Fixtures.vaultInitializeBody(vaultRequestId);
let vaultRequest : Types.VaultWriteRequest = {
    request_id = vaultRequestId;
    operation = ?#initialize;
    expected_record_revision = null;
    proposed_record_revision = 1;
    body_bytes = Nat32.fromNat(vaultBody.size());
};
switch (service.vaultWrite(vaultRequest, vaultBody)) {
    case (#ok(value)) {
        assert (value.initialized);
        assert (value.record_revision == 1);
    };
    case (_) assert false;
};
let physicalAfterVault = mem.physical_private_bytes;
assert (Map.size(mem.private_receipts) == 1);

// Exact replay returns the stored outcome without charging twice. Reusing the
// request id with different attachment bytes is a conflict.
switch (service.vaultWrite(vaultRequest, vaultBody)) {
    case (#ok(value)) assert (value.record_revision == 1);
    case (_) assert false;
};
assert (mem.physical_private_bytes == physicalAfterVault);
assert (Map.size(mem.private_receipts) == 1);
assertReason(
    service.vaultWrite(vaultRequest, changedLast(vaultBody)),
    #conflict,
);
assertReason(
    service.vaultWrite(
        { vaultRequest with body_bytes = vaultRequest.body_bytes + 1 },
        vaultBody,
    ),
    #invalid_request,
);

switch (service.bootstrap()) {
    case (#ok(bootstrapped)) {
        assert (bootstrapped.value.body_bytes > 0);
        assert (
            Nat32.toNat(bootstrapped.value.body_bytes) ==
            bootstrapped.body.size()
        );
        switch (bootstrapped.value.vault) {
            case (?#present(value)) assert (value.record_revision == 1);
            case (_) assert false;
        };
        let ?parts = Frames.split(
            bootstrapped.body,
            Types.MAX_VAULT_FRAME_BYTES,
        ) else {
            assert false;
            loop {};
        };
        let decoded : ?Frames.VaultReadFrameControl =
            from_candid (parts.control);
        switch (decoded) {
            case (?control) {
                assert (control.record_revision == 1);
                assert (control.raw_payload_bytes == 48);
            };
            case null assert false;
        };
    };
    case (_) assert false;
};

let folderId = Fixtures.id(2);
let folderTag = Fixtures.digest(4);
let mutateControl : Frames.MutateFrameControl = {
    request_id = Fixtures.id(3);
    action = ?#create_folder;
    node = {
        node_id = folderId;
        expected_parent_id = null;
        proposed_parent_id = Types.ROOT_NODE_ID;
        requested_kind = ?#folder;
        expected_name_tag = null;
        proposed_name_tag = folderTag;
        declared_name_scalars = 1;
        expected_structural_revision = null;
        proposed_structural_revision = 1;
        expected_metadata_revision = null;
        proposed_metadata_revision = 1;
        expected_children_revision = null;
        proposed_children_revision = 0;
        expected_subtree_height = null;
        proposed_subtree_height = 0;
        expected_max_relative_path_scalars = null;
        proposed_max_relative_path_scalars = 1;
        expected_subtree_plaintext_bytes = null;
        proposed_subtree_plaintext_bytes = 0;
        encrypted_metadata = { offset = 0; length = 16 };
    };
    folder_transitions = [{
        node_id = Types.ROOT_NODE_ID;
        expected_structural_revision = 1;
        expected_children_revision = 0;
    }];
    child_index_transitions = [{
        parent_id = Types.ROOT_NODE_ID;
        name_tag = folderTag;
        expected_node_id = null;
        proposed_node_id = ?folderId;
    }];
    raw_payload_bytes = 16;
};
let mutateBody = Fixtures.pack(
    to_candid (mutateControl),
    Fixtures.zeros(16),
);
let mutateRequest : Types.MutateRequest = {
    request_id = mutateControl.request_id;
    action = ?#create_folder;
    body_bytes = Nat32.fromNat(mutateBody.size());
};
switch (service.mutate(mutateRequest, mutateBody)) {
    case (#ok(value)) {
        assert (value.node_id == folderId);
        assert (value.structural_revision == 1);
    };
    case (_) assert false;
};
let physicalAfterMutation = mem.physical_private_bytes;
switch (service.mutate(mutateRequest, mutateBody)) {
    case (#ok(value)) assert (value.node_id == folderId);
    case (_) assert false;
};
assert (mem.physical_private_bytes == physicalAfterMutation);
assertReason(
    service.mutate(mutateRequest, changedLast(mutateBody)),
    #conflict,
);

switch (service.list({
    parent_id = Types.ROOT_NODE_ID;
    expected_structural_revision = ?2;
    cursor = null;
    limit = 10;
})) {
    case (#ok(listed)) {
        assert (listed.value.total_children == 1);
        assert (listed.value.loaded_count == 1);
        assert (
            Nat32.toNat(listed.value.body_bytes) == listed.body.size()
        );
        let ?parts = Frames.split(
            listed.body,
            Types.MAX_LIST_FRAME_BYTES,
        ) else {
            assert false;
            loop {};
        };
        let control : ?Frames.ListFrameControl =
            from_candid (parts.control);
        switch (control) {
            case (?value) {
                assert (value.items.size() == 1);
                assert (value.items[0].node.node_id == folderId);
                assert (value.raw_payload_bytes == 16);
            };
            case null assert false;
        };
    };
    case (_) assert false;
};

switch (service.lookup(
    { locator = ?#node({ node_id = folderId }) },
    "",
)) {
    case (#ok(found)) {
        assert (found.value.node.node_id == folderId);
        assert (found.value.content == null);
    };
    case (_) assert false;
};
switch (service.lookup(
    {
        locator = ?#child({
            parent_id = Types.ROOT_NODE_ID;
            expected_children_revision = ?1;
        })
    },
    Keys.tag256Bytes(Frames.digestToTag(folderTag)),
)) {
    case (#ok(found)) assert (found.value.node.node_id == folderId);
    case (_) assert false;
};
assertReason(
    service.lookup(
        { locator = ?#node({ node_id = folderId }) },
        Fixtures.zeros(1),
    ),
    #invalid_request,
);

// Once the create receipt expires, removal owns the detached NodeId until its
// own receipt is pruned. Exact remove replay is idempotent, while a different
// create request cannot recycle the cleaned ID.
now += Types.RECEIPT_RETENTION_NS;
switch (service.cleanup()) {
    case (#ok(_)) {};
    case (_) assert false;
};
assert (
    Map.get(
        mem.private_receipt_identity_owners,
        Keys.compareId128,
        folderId,
    ) == null
);
let removeRequest : Types.RemoveRequest = {
    request_id = Fixtures.id(30);
    node_id = folderId;
    expected_structural_revision = 1;
    expected_parent_id = Types.ROOT_NODE_ID;
    expected_parent_children_revision = 1;
    recursive = true;
};
switch (service.remove(removeRequest)) {
    case (#ok(value)) assert (value.node_id == folderId);
    case (_) assert false;
};
assert (
    Map.get(mem.nodes_by_id, Keys.compareId128, folderId) == null
);
let physicalAfterRemove = mem.physical_private_bytes;
let ?removedOwner = Map.get(
    mem.private_receipt_identity_owners,
    Keys.compareId128,
    folderId,
) else {
    assert false;
    loop {};
};
assert (removedOwner.node_count == 1);
assert (removedOwner.content_count == 0);
switch (service.remove(removeRequest)) {
    case (#ok(value)) assert (value.node_id == folderId);
    case (_) assert false;
};
assert (mem.physical_private_bytes == physicalAfterRemove);
assert (
    Map.get(
        mem.private_receipt_identity_owners,
        Keys.compareId128,
        folderId,
    ) == ?removedOwner
);

let recycleRoot = switch (
    Map.get(
        mem.nodes_by_id,
        Keys.compareId128,
        Types.ROOT_NODE_ID,
    )
) {
    case (?value) value;
    case null {
        assert false;
        loop {};
    };
};
let recycleTag = Fixtures.digest(31);
let recycleControl : Frames.MutateFrameControl = {
    request_id = Fixtures.id(31);
    action = ?#create_folder;
    node = {
        mutateControl.node with
        node_id = folderId;
        proposed_name_tag = recycleTag;
    };
    folder_transitions = [{
        node_id = Types.ROOT_NODE_ID;
        expected_structural_revision =
            recycleRoot.structural_revision;
        expected_children_revision =
            recycleRoot.children_revision;
    }];
    child_index_transitions = [{
        parent_id = Types.ROOT_NODE_ID;
        name_tag = recycleTag;
        expected_node_id = null;
        proposed_node_id = ?folderId;
    }];
    raw_payload_bytes = 16;
};
let recycleBody = Fixtures.pack(
    to_candid (recycleControl),
    Fixtures.zeros(16),
);
assertReason(
    service.mutate(
        {
            request_id = recycleControl.request_id;
            action = ?#create_folder;
            body_bytes = Nat32.fromNat(recycleBody.size());
        },
        recycleBody,
    ),
    #id_collision,
);

// Add a committed file fixture to exercise both read frame shapes and stale
// binding checks independently of the staged writer.
let fileId = Fixtures.id(4);
let contentId = Fixtures.id(5);
let fileTag = Frames.digestToTag(Fixtures.digest(5));
let content : Memory.ContentRecord = {
    content_id = contentId;
    wrapped_content_key = Fixtures.zeros(48);
    block_count = 2;
    ciphertext_bytes = 50;
    crypto_profile = #aes_256_gcm_files_v2;
};
let file : Memory.Node = {
    parent_id = Types.ROOT_NODE_ID;
    kind = #file({ active_content = ?content });
    state = #active;
    name_tag = fileTag;
    declared_name_scalars = 1;
    structural_revision = 1;
    metadata_revision = 1;
    children_revision = 0;
    subtree_height = 0;
    max_relative_path_scalars = 1;
    subtree_plaintext_bytes = 18;
    encrypted_metadata = Fixtures.zeros(16);
};
Map.add(mem.nodes_by_id, Keys.compareId128, fileId, file);
Map.add(
    mem.children_by_name,
    Keys.compareChildNameKey,
    Keys.childNameKey(Types.ROOT_NODE_ID, fileTag),
    fileId,
);
let ?oldRoot = Map.get(
    mem.nodes_by_id,
    Keys.compareId128,
    Types.ROOT_NODE_ID,
) else {
    assert false;
    loop {};
};
let replacementRoot : Memory.Node = {
    oldRoot with
    kind = #folder({
        direct_child_count = 2;
        child_subtree_heights = [{ value = 0; count = 2 }];
        child_relative_path_scalars = [{ value = 1; count = 2 }];
    });
    structural_revision = 3;
    children_revision = 2;
    subtree_plaintext_bytes = 18;
};
Map.add(
    mem.nodes_by_id,
    Keys.compareId128,
    Types.ROOT_NODE_ID,
    replacementRoot,
);
Map.add(
    mem.blocks,
    Keys.compareBlockKey,
    Keys.blockKey(contentId, 0),
    Fixtures.zeros(24),
);
Map.add(
    mem.blocks,
    Keys.compareBlockKey,
    Keys.blockKey(contentId, 1),
    Fixtures.zeros(26),
);
mem.node_count := 3;
mem.committed_private_plaintext_bytes := 18;
mem.committed_ciphertext_bytes := 50;

switch (service.readChunk({
    node_id = fileId;
    structural_revision = 1;
    content_id = contentId;
    index = 0;
})) {
    case (#ok(read)) {
        assert (read.value.frame_kind == ?#first);
        assert (read.value.ciphertext_block_bytes == 24);
        let ?parts = Frames.split(read.body, Types.MAX_FRAME_BYTES) else {
            assert false;
            loop {};
        };
        let control : ?Frames.ReadBlockFrameControl =
            from_candid (parts.control);
        switch (control) {
            case (?{ frame = ?#first(first) }) {
                assert (first.index == 0);
                assert (first.raw_payload_bytes == 88);
            };
            case (_) assert false;
        };
    };
    case (_) assert false;
};
switch (service.readChunk({
    node_id = fileId;
    structural_revision = 1;
    content_id = contentId;
    index = 1;
})) {
    case (#ok(read)) {
        assert (read.value.frame_kind == ?#continuation);
        assert (read.value.ciphertext_block_bytes == 26);
    };
    case (_) assert false;
};
assertReason(
    service.readChunk({
        node_id = fileId;
        structural_revision = 2;
        content_id = contentId;
        index = 0;
    }),
    #stale_revision,
);
assertReason(
    service.readChunk({
        node_id = fileId;
        structural_revision = 1;
        content_id = Fixtures.id(99);
        index = 0;
    }),
    #stale_content,
);
assertReason(
    service.readChunk({
        node_id = fileId;
        structural_revision = 1;
        content_id = contentId;
        index = 2;
    }),
    #invalid_index,
);
