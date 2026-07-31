import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Memory "../../backend/memory/files/v1";
import Frames "../../backend/files/Frames";
import Keys "../../backend/files/Keys";
import Mutation "../../backend/files/Mutation";
import Types "../../backend/files/Types";

func id(branch : Nat64, index : Nat) : Memory.Id128 {
    { hi = branch; lo = Nat64.fromNat(index) };
};

func tag(value : Nat) : Memory.Tag256 {
    (0, 0, 0, Nat64.fromNat(value));
};

func digest(value : Memory.Tag256) : Frames.Digest256 {
    Frames.digestFromTag(value);
};

func zeros(count : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(count, func(_) { 0 }));
};

func folder(
    parent : Memory.Id128,
    name : Memory.Tag256,
    direct : Nat32,
    height : Nat8,
    path : Nat16,
    childHeight : ?Nat8,
    childPath : ?Nat16,
) : Memory.Node {
    {
        parent_id = parent;
        kind = #folder({
            direct_child_count = direct;
            child_subtree_heights = switch (childHeight) {
                case null [];
                case (?value) [{ value; count = 1 }];
            };
            child_relative_path_scalars = switch (childPath) {
                case null [];
                case (?value) [{ value; count = 1 }];
            };
        });
        state = #active;
        name_tag = name;
        declared_name_scalars = 1;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = if (direct == 0) 0 else 1;
        subtree_height = height;
        max_relative_path_scalars = path;
        subtree_plaintext_bytes = 0;
        encrypted_metadata = zeros(16);
    };
};

func addNode(
    mem : Memory.Mem,
    nodeId : Memory.Id128,
    node : Memory.Node,
) {
    Map.add(mem.nodes_by_id, Keys.compareId128, nodeId, node);
    if (nodeId != Types.ROOT_NODE_ID) {
        Map.add(
            mem.children_by_name,
            Keys.compareChildNameKey,
            Keys.childNameKey(node.parent_id, node.name_tag),
            nodeId,
        );
    };
};

func folderTransition(
    nodeId : Memory.Id128,
    oldChildrenRevision : Nat64,
) : Frames.FolderAggregateTransition {
    {
        node_id = nodeId;
        expected_structural_revision = 1;
        expected_children_revision = oldChildrenRevision;
    };
};

func frame(control : Frames.MutateFrameControl, raw : Blob) : Blob {
    let candid = to_candid (control);
    let length = Nat32.fromNat(candid.size());
    Frames.append([
        Blob.fromArray([
            Nat8.fromNat(Nat32.toNat(length >> 24) % 256),
            Nat8.fromNat(Nat32.toNat(length >> 16) % 256),
            Nat8.fromNat(Nat32.toNat(length >> 8) % 256),
            Nat8.fromNat(Nat32.toNat(length) % 256),
        ]),
        candid,
        raw,
    ]);
};

// Two 63-deep branches share only the root. Moving one leaf from the bottom
// of branch A to branch B touches 63 + 63 + 1 = 127 aggregate folders. The
// shared root remains an exact CAS witness but is not a mutation because its
// direct membership and compact aggregates return to their original values.
let mem = Memory.init();
let aTag = tag(1);
let bTag = tag(2);
let leafTag = tag(3);
let root : Memory.Node = {
    parent_id = Types.ROOT_NODE_ID;
    kind = #folder({
        direct_child_count = 2;
        child_subtree_heights = [
            { value = 62; count = 1 },
            { value = 63; count = 1 },
        ];
        child_relative_path_scalars = [
            { value = 125; count = 1 },
            { value = 127; count = 1 },
        ];
    });
    state = #active;
    name_tag = Types.ZERO_TAG;
    declared_name_scalars = 0;
    structural_revision = 1;
    metadata_revision = 1;
    children_revision = 1;
    subtree_height = 64;
    max_relative_path_scalars = 127;
    subtree_plaintext_bytes = 0;
    encrypted_metadata = zeros(16);
};
addNode(mem, Types.ROOT_NODE_ID, root);

var index = 1;
while (index <= 63) {
    let parentA =
        if (index == 1) Types.ROOT_NODE_ID else id(1, index - 1);
    let oldAHeight = 64 - index;
    let oldAPath = 2 * oldAHeight + 1;
    addNode(
        mem,
        id(1, index),
        folder(
            parentA,
            if (index == 1) aTag else tag(10 + index),
            1,
            Nat8.fromNat(oldAHeight),
            Nat16.fromNat(oldAPath),
            ?Nat8.fromNat(oldAHeight - 1),
            ?Nat16.fromNat(oldAPath - 2),
        ),
    );

    let parentB =
        if (index == 1) Types.ROOT_NODE_ID else id(2, index - 1);
    let oldBHeight = 63 - index;
    let oldBPath = 2 * oldBHeight + 1;
    addNode(
        mem,
        id(2, index),
        folder(
            parentB,
            if (index == 1) bTag else tag(100 + index),
            if (index == 63) 0 else 1,
            Nat8.fromNat(oldBHeight),
            Nat16.fromNat(oldBPath),
            if (index == 63) null else ?Nat8.fromNat(oldBHeight - 1),
            if (index == 63) null else ?Nat16.fromNat(oldBPath - 2),
        ),
    );
    index += 1;
};

let leafId = id(3, 1);
addNode(
    mem,
    leafId,
    folder(id(1, 63), leafTag, 0, 0, 1, null, null),
);
mem.node_count := 128;

let transitions = List.empty<Frames.FolderAggregateTransition>();
List.add(
    transitions,
    folderTransition(Types.ROOT_NODE_ID, 1),
);
index := 1;
while (index <= 63) {
    List.add(
        transitions,
        folderTransition(
            id(1, index),
            1,
        ),
    );
    index += 1;
};
index := 1;
while (index <= 63) {
    List.add(
        transitions,
        folderTransition(
            id(2, index),
            if (index == 63) 0 else 1,
        ),
    );
    index += 1;
};
let declaredFolders = List.toArray(transitions);
assert (
    declaredFolders.size() ==
    Types.MAX_MUTATION_FOLDER_TRANSITIONS
);

let nodeTransition : Frames.NodeTransitionFrame = {
    node_id = leafId;
    expected_parent_id = ?id(1, 63);
    proposed_parent_id = id(2, 63);
    requested_kind = ?#folder;
    expected_name_tag = ?digest(leafTag);
    proposed_name_tag = digest(leafTag);
    declared_name_scalars = 1;
    expected_structural_revision = ?1;
    proposed_structural_revision = 2;
    expected_metadata_revision = ?1;
    proposed_metadata_revision = 2;
    expected_children_revision = ?0;
    proposed_children_revision = 0;
    expected_subtree_height = ?0;
    proposed_subtree_height = 0;
    expected_max_relative_path_scalars = ?1;
    proposed_max_relative_path_scalars = 1;
    expected_subtree_plaintext_bytes = ?0;
    proposed_subtree_plaintext_bytes = 0;
    encrypted_metadata = { offset = 0; length = 16 };
};
let control : Frames.MutateFrameControl = {
    request_id = id(9, 1);
    action = ?#move;
    node = nodeTransition;
    folder_transitions = declaredFolders;
    child_index_transitions = [
        {
            parent_id = id(1, 63);
            name_tag = digest(leafTag);
            expected_node_id = ?leafId;
            proposed_node_id = null;
        },
        {
            parent_id = id(2, 63);
            name_tag = digest(leafTag);
            expected_node_id = null;
            proposed_node_id = ?leafId;
        },
    ];
    raw_payload_bytes = 16;
};

// The decoder admits the exact folder-witness ceiling and rejects one more.
let smallerControl : Frames.MutateFrameControl = {
    control with
    folder_transitions = Array.tabulate<Frames.FolderAggregateTransition>(
        64,
        func(index) { declaredFolders[index] },
    );
};
switch (Frames.decodeMutate(frame(smallerControl, zeros(16)))) {
    case null assert false;
    case (?_) {};
};
switch (Frames.decodeMutate(frame(control, zeros(16)))) {
    case null assert false;
    case (?_) {};
};
let oversizedControl : Frames.MutateFrameControl = {
    control with
    folder_transitions =
        Array.tabulate<Frames.FolderAggregateTransition>(
            Types.MAX_MUTATION_FOLDER_TRANSITIONS + 1,
            func(index) {
                if (index < declaredFolders.size()) declaredFolders[index]
                else declaredFolders[0];
            },
        );
};
assert (Frames.decodeMutate(frame(oversizedControl, zeros(16))) == null);
let raw : Frames.RawPayload = {
    frame = zeros(16);
    start = 0;
    length = 16;
};
switch (Mutation.plan(mem, control, raw)) {
    case (#err(error)) {
        assert (error.reason != ?#invalid_request);
        assert (error.reason != ?#not_found);
        assert (error.reason != ?#not_folder);
        assert (error.reason != ?#already_exists);
        assert (error.reason != ?#stale_revision);
        assert (error.reason != ?#batch_structure_limit);
        assert (error.reason != ?#conflict);
        assert (error.reason != ?#corrupt_state);
        assert false;
    };
    case (#ok(plan)) {
        assert (plan.node_count_after == 128);
        // Explicit leaf plus the 126 aggregate folders whose derived state
        // actually changed. The unchanged root remains witness-only.
        assert (plan.node_mutations.size() == 127);
        assert (plan.child_index_mutations.size() == 2);
        for (mutation in plan.node_mutations.values()) {
            assert (mutation.node_id != Types.ROOT_NODE_ID);
        };
    };
};

// Two explicit creates cannot silently overwrite the same effective child
// edge. The second transition was authored against an empty edge, while the
// first transition has already made that edge point at its new node.
let duplicateMem = Memory.init();
let duplicateRoot : Memory.Node = {
    root with
    kind = #folder({
        direct_child_count = 0;
        child_subtree_heights = [];
        child_relative_path_scalars = [];
    });
    children_revision = 0;
    subtree_height = 0;
    max_relative_path_scalars = 0;
};
addNode(duplicateMem, Types.ROOT_NODE_ID, duplicateRoot);
duplicateMem.node_count := 1;
let duplicateTag = tag(500);
let firstDuplicate = folder(
    Types.ROOT_NODE_ID,
    duplicateTag,
    0,
    0,
    1,
    null,
    null,
);
let secondDuplicate : Memory.Node = {
    firstDuplicate with encrypted_metadata = zeros(17)
};
switch (
    Mutation.planWriteStructure(
        duplicateMem,
        [
            {
                node_id = id(10, 1);
                expected = null;
                replacement = firstDuplicate;
            },
            {
                node_id = id(10, 2);
                expected = null;
                replacement = secondDuplicate;
            },
        ],
        [folderTransition(Types.ROOT_NODE_ID, 0)],
        [{
            parent_id = Types.ROOT_NODE_ID;
            name_tag = digest(duplicateTag);
            expected_node_id = null;
            proposed_node_id = ?id(10, 2);
        }],
        3,
    )
) {
    case (#err(error)) assert (error.reason == ?#conflict);
    case (#ok(_)) assert false;
};
assert (duplicateMem.node_count == 1);
assert (Map.size(duplicateMem.nodes_by_id) == 1);
assert (Map.size(duplicateMem.children_by_name) == 0);
assert (
    Map.get(
        duplicateMem.nodes_by_id,
        Keys.compareId128,
        Types.ROOT_NODE_ID,
    ) == ?duplicateRoot
);

// Several direct-child changes in one atomic write advance the persisted
// parent's children revision exactly once.
let siblingsMem = Memory.init();
addNode(siblingsMem, Types.ROOT_NODE_ID, duplicateRoot);
siblingsMem.node_count := 1;
let firstSiblingTag = tag(501);
let secondSiblingTag = tag(502);
let firstSibling = folder(
    Types.ROOT_NODE_ID,
    firstSiblingTag,
    0,
    0,
    1,
    null,
    null,
);
let secondSibling = folder(
    Types.ROOT_NODE_ID,
    secondSiblingTag,
    0,
    0,
    1,
    null,
    null,
);
switch (
    Mutation.planWriteStructure(
        siblingsMem,
        [
            {
                node_id = id(11, 1);
                expected = null;
                replacement = firstSibling;
            },
            {
                node_id = id(11, 2);
                expected = null;
                replacement = secondSibling;
            },
        ],
        [folderTransition(Types.ROOT_NODE_ID, 0)],
        [
            {
                parent_id = Types.ROOT_NODE_ID;
                name_tag = digest(firstSiblingTag);
                expected_node_id = null;
                proposed_node_id = ?id(11, 1);
            },
            {
                parent_id = Types.ROOT_NODE_ID;
                name_tag = digest(secondSiblingTag);
                expected_node_id = null;
                proposed_node_id = ?id(11, 2);
            },
        ],
        3,
    )
) {
    case (#err(_)) assert false;
    case (#ok(plan)) {
        var foundRoot = false;
        for (mutation in plan.node_mutations.values()) {
            if (mutation.node_id == Types.ROOT_NODE_ID) {
                switch (mutation.replacement) {
                    case null assert false;
                    case (?replacement) {
                        foundRoot := true;
                        assert (replacement.structural_revision == 2);
                        assert (replacement.children_revision == 1);
                        switch (replacement.kind) {
                            case (#file(_)) assert false;
                            case (#folder(value)) {
                                assert (value.direct_child_count == 2);
                            };
                        };
                    };
                };
            };
        };
        assert foundRoot;
    };
};

func assertCorruptFolderRejected(corruptRoot : Memory.Node) {
    let corruptMem = Memory.init();
    addNode(corruptMem, Types.ROOT_NODE_ID, corruptRoot);
    corruptMem.node_count := 1;
    let childId = id(12, 1);
    let childTag = tag(700);
    let child = folder(
        Types.ROOT_NODE_ID,
        childTag,
        0,
        0,
        1,
        null,
        null,
    );
    switch (
        Mutation.planWriteStructure(
            corruptMem,
            [{
                node_id = childId;
                expected = null;
                replacement = child;
            }],
            [folderTransition(
                Types.ROOT_NODE_ID,
                corruptRoot.children_revision,
            )],
            [{
                parent_id = Types.ROOT_NODE_ID;
                name_tag = digest(childTag);
                expected_node_id = null;
                proposed_node_id = ?childId;
            }],
            2,
        )
    ) {
        case (#err(error)) assert (error.reason == ?#corrupt_state);
        case (#ok(_)) assert false;
    };
};

assertCorruptFolderRejected({
    duplicateRoot with
    kind = #folder({
        direct_child_count = 2;
        child_subtree_heights = [
            { value = 1; count = 1 },
            { value = 0; count = 1 },
        ];
        child_relative_path_scalars = [{ value = 1; count = 2 }];
    });
    subtree_height = 2;
    max_relative_path_scalars = 1;
});
assertCorruptFolderRejected({
    duplicateRoot with
    kind = #folder({
        direct_child_count = 1;
        child_subtree_heights = [
            { value = 0; count = 0 },
            { value = 1; count = 1 },
        ];
        child_relative_path_scalars = [{ value = 1; count = 1 }];
    });
    subtree_height = 2;
    max_relative_path_scalars = 1;
});
assertCorruptFolderRejected({
    duplicateRoot with
    kind = #folder({
        direct_child_count = 2;
        child_subtree_heights = [{ value = 0; count = 1 }];
        child_relative_path_scalars = [{ value = 1; count = 2 }];
    });
    subtree_height = 1;
    max_relative_path_scalars = 1;
});
assertCorruptFolderRejected({
    duplicateRoot with
    kind = #folder({
        direct_child_count = 1;
        child_subtree_heights = [{ value = 0; count = 1 }];
        child_relative_path_scalars = [{ value = 1; count = 1 }];
    });
    subtree_height = 2;
    max_relative_path_scalars = 1;
});
