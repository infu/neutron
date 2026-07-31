import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat16 "mo:core/Nat16";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Memory "../../backend/memory/files/v1";
import Keys "../../backend/files/Keys";
import Tree "../../backend/files/Tree";
import Types "../../backend/files/Types";

func id(value : Nat) : Memory.Id128 {
    { hi = 0; lo = Nat64.fromNat(value) };
};

func tag(value : Nat) : Memory.Tag256 {
    (0, 0, 0, Nat64.fromNat(value));
};

func metadata() : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { 0 }));
};

func emptyFolder(
    parent : Memory.Id128,
    name : Memory.Tag256,
    nameScalars : Nat16,
) : Memory.Node {
    {
        parent_id = parent;
        kind = #folder({
            direct_child_count = 0;
            child_subtree_heights = [];
            child_relative_path_scalars = [];
        });
        state = #active;
        name_tag = name;
        declared_name_scalars = nameScalars;
        structural_revision = 1;
        metadata_revision = 1;
        children_revision = 0;
        subtree_height = 0;
        max_relative_path_scalars = nameScalars;
        subtree_plaintext_bytes = 0;
        encrypted_metadata = metadata();
    };
};

func assertReason<T>(result : Types.Result<T>, expected : Types.RejectionReason) {
    switch (result) {
        case (#err({ reason = ?actual })) assert (actual == expected);
        case (_) assert false;
    };
};

let mem = Memory.init();
let root : Memory.Node = {
    parent_id = Types.ROOT_NODE_ID;
    kind = #folder({
        direct_child_count = 3;
        child_subtree_heights = [{ value = 0; count = 3 }];
        child_relative_path_scalars = [{ value = 1; count = 3 }];
    });
    state = #active;
    name_tag = Types.ZERO_TAG;
    declared_name_scalars = 0;
    structural_revision = 7;
    metadata_revision = 2;
    children_revision = 9;
    subtree_height = 1;
    max_relative_path_scalars = 1;
    subtree_plaintext_bytes = 0;
    encrypted_metadata = metadata();
};
Map.add(mem.nodes_by_id, Keys.compareId128, Types.ROOT_NODE_ID, root);

var child = 1;
while (child <= 3) {
    let childId = id(child);
    let childTag = tag(child);
    Map.add(
        mem.nodes_by_id,
        Keys.compareId128,
        childId,
        emptyFolder(Types.ROOT_NODE_ID, childTag, 1),
    );
    Map.add(
        mem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(Types.ROOT_NODE_ID, childTag),
        childId,
    );
    child += 1;
};
mem.node_count := 4;

let tree = Tree.Tree(mem);
switch (tree.page({
    parent_id = Types.ROOT_NODE_ID;
    expected_structural_revision = ?7;
    cursor = null;
    limit = 2;
})) {
    case (#ok(first)) {
        assert (first.items.size() == 2);
        assert (first.items[0].node_id == id(1));
        assert (first.items[1].node_id == id(2));
        assert (first.has_more);
        let cursor = switch (first.next_cursor) {
            case (?value) value;
            case null {
                assert false;
                loop {};
            };
        };
        assert (cursor.last_name_tag == tag(2));
        switch (tree.page({
            parent_id = Types.ROOT_NODE_ID;
            expected_structural_revision = ?7;
            cursor = ?cursor;
            limit = 2;
        })) {
            case (#ok(second)) {
                // `Map.entriesFrom` is inclusive. The cursor row must be
                // skipped exactly once, never duplicated or skipped twice.
                assert (second.items.size() == 1);
                assert (second.items[0].node_id == id(3));
                assert (not second.has_more);
                assert (second.next_cursor == null);
            };
            case (_) assert false;
        };
    };
    case (_) assert false;
};

assertReason(
    tree.page({
        parent_id = Types.ROOT_NODE_ID;
        expected_structural_revision = null;
        cursor = null;
        limit = 0;
    }),
    #invalid_request,
);
assertReason(
    tree.page({
        parent_id = Types.ROOT_NODE_ID;
        expected_structural_revision = ?6;
        cursor = null;
        limit = 1;
    }),
    #stale_revision,
);
assertReason(
    tree.page({
        parent_id = Types.ROOT_NODE_ID;
        expected_structural_revision = null;
        cursor = ?{
            parent_id = Types.ROOT_NODE_ID;
            children_revision = 8;
            last_name_tag = tag(1);
        };
        limit = 1;
    }),
    #cursor_stale,
);
assertReason(
    tree.lookupChild(Types.ROOT_NODE_ID, ?8, tag(1)),
    #stale_revision,
);
switch (tree.lookupChild(Types.ROOT_NODE_ID, ?9, tag(2))) {
    case (#ok(found)) assert (found.node_id == id(2));
    case (_) assert false;
};

// The root plus exactly 64 edges is reachable; a 65th edge is rejected as
// corrupt rather than causing an unbounded ancestor walk.
let deepMem = Memory.init();
Map.add(
    deepMem.nodes_by_id,
    Keys.compareId128,
    Types.ROOT_NODE_ID,
    {
        emptyFolder(Types.ROOT_NODE_ID, Types.ZERO_TAG, 0) with
        name_tag = Types.ZERO_TAG;
    },
);
var depth = 1;
while (depth <= 65) {
    let nodeId = id(100 + depth);
    let parentId =
        if (depth == 1) Types.ROOT_NODE_ID else id(99 + depth);
    let nodeTag = tag(depth);
    Map.add(
        deepMem.nodes_by_id,
        Keys.compareId128,
        nodeId,
        emptyFolder(parentId, nodeTag, 1),
    );
    Map.add(
        deepMem.children_by_name,
        Keys.compareChildNameKey,
        Keys.childNameKey(parentId, nodeTag),
        nodeId,
    );
    depth += 1;
};
let deepTree = Tree.Tree(deepMem);
switch (deepTree.depth(id(164))) {
    case (#ok(value)) assert (value == 64);
    case (_) assert false;
};
assertReason(deepTree.reachable(id(165)), #corrupt_state);
switch (deepTree.isWithin(id(150), id(164))) {
    case (#ok(value)) assert value;
    case (_) assert false;
};
switch (deepTree.isWithin(id(164), id(150))) {
    case (#ok(value)) assert (not value);
    case (_) assert false;
};
