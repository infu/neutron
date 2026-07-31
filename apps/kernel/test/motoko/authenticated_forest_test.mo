import Base64 "mo:core/Base64";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Debug "mo:core/Debug";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import MerkleTree "mo:ic-certification/MerkleTree";
import SHA256 "mo:sha2/Sha256";
import Forest "../../backend/certified_assets/AuthenticatedForest";

let RESPONSE_POLICY_TABLE : Blob =
    "authenticated-forest-test-response-policy-v1";
let ALLOCATOR_FINGERPRINT : Blob =
    "0123456789abcdef0123456789abcdef";

func newMemory() : Forest.Memory {
    Forest.init(RESPONSE_POLICY_TABLE, ALLOCATOR_FINGERPRINT);
};

func path(parts : [Text]) : [Blob] {
    Array.map<Text, Blob>(parts, Text.encodeUtf8);
};

func deepPath(depth : Nat) : [Blob] {
    Array.tabulate<Blob>(
        depth,
        func(index) {
            Text.encodeUtf8("level-" # Nat.toText(index));
        },
    );
};

func nodeWithId(node : Forest.Node, id : Forest.NodeId) : Forest.Node {
    {
        id;
        var in_use = node.in_use;
        var map_id = node.map_id;
        var key = node.key;
        var key_hash = node.key_hash;
        var value = node.value;
        var value_hash = node.value_hash;
        var data_hash = node.data_hash;
        var color = node.color;
        var left = node.left;
        var right = node.right;
        var subtree_hash = node.subtree_hash;
        var free_next = node.free_next;
    };
};

func mapWithId(map : Forest.MapRoot, id : Forest.MapId) : Forest.MapRoot {
    {
        id;
        var in_use = map.in_use;
        var generation = map.generation;
        var root = map.root;
        var size = map.size;
        var parent_map = map.parent_map;
        var parent_node = map.parent_node;
        var attached = map.attached;
        var detach_epoch = map.detach_epoch;
        var detached_path_hash = map.detached_path_hash;
        var free_next = map.free_next;
    };
};

func memoryWithRoots(
    memory : Forest.Memory,
    response : Forest.MapRef,
    mounts : Forest.MapRef,
    collections : Forest.MapRef,
) : Forest.Memory {
    let prior = memory.header;
    let header : Forest.Header = {
        schema_version = prior.schema_version;
        forest_version = prior.forest_version;
        response_root = response;
        mount_catalog_root = mounts;
        collection_catalog_root = collections;
        response_policy_table_canonical =
            prior.response_policy_table_canonical;
        response_policy_table_fingerprint =
            prior.response_policy_table_fingerprint;
        allocator_layout_fingerprint =
            prior.allocator_layout_fingerprint;
        var response_root_hash = prior.response_root_hash;
        var mount_catalog_root_hash = prior.mount_catalog_root_hash;
        var collection_catalog_root_hash =
            prior.collection_catalog_root_hash;
        var commit_sequence = prior.commit_sequence;
        var commit_fingerprint = prior.commit_fingerprint;
        var live_nodes = prior.live_nodes;
        var allocated_nodes = prior.allocated_nodes;
        var free_nodes = prior.free_nodes;
        var live_maps = prior.live_maps;
        var allocated_maps = prior.allocated_maps;
        var free_maps = prior.free_maps;
        var healthy = true;
    };
    {
        node_chunks = memory.node_chunks;
        map_chunks = memory.map_chunks;
        var next_node_id = memory.next_node_id;
        var next_map_id = memory.next_map_id;
        var free_node = memory.free_node;
        var free_map = memory.free_map;
        var dirty = memory.dirty;
        header;
        counters = memory.counters;
    };
};

func depthOk(memory : Forest.Memory) : Nat {
    switch (
        Forest.maximumDepth(memory, Forest.responseRoot(memory))
    ) {
        case (?depth) depth;
        case null {
            assert false;
            loop {};
        };
    };
};

func commitOk(memory : Forest.Memory) : Forest.CommitReceipt {
    switch (Forest.commit(memory)) {
        case (#ok(receipt)) receipt;
        case (#err(error)) {
            Debug.print(debug_show (error));
            assert false;
            loop {};
        };
    };
};

func auditOk(memory : Forest.Memory, budget : Nat) : Nat {
    var cursor = Forest.initialAuditCursor(memory);
    var calls = 0;
    label auditing loop {
        switch (Forest.auditStep(memory, cursor, budget)) {
            case (#more(next)) cursor := next;
            case (#complete) break auditing;
            case (#stale) assert false;
            case (#err(_)) assert false;
        };
        calls += 1;
        assert (calls < 20_000);
    };
    calls;
};

func mapAt(
    memory : Forest.Memory,
    ref : Forest.MapRef,
) : Forest.MapRoot {
    let zero = ref.id - 1;
    let ?chunk = memory.map_chunks[zero / Forest.MAP_CHUNK_SIZE] else {
        assert false;
        loop {};
    };
    let ?map = chunk[zero % Forest.MAP_CHUNK_SIZE] else {
        assert false;
        loop {};
    };
    map;
};

func putNew(memory : Forest.Memory, key : [Blob], value : Blob) {
    assert (
        Forest.put(memory, key, value) ==
        #ok({ inserted = true; prior = null })
    );
};

func replace(
    memory : Forest.Memory,
    key : [Blob],
    prior : Blob,
    value : Blob,
) {
    assert (
        Forest.put(memory, key, value) ==
        #ok({ inserted = false; prior = ?prior })
    );
};

func deleteFound(memory : Forest.Memory, key : [Blob], value : Blob) {
    assert (Forest.delete(memory, key) == #ok(?value));
};

type VerifiedLookup = {
    #absent;
    #unknown;
    #found : Blob;
    #error;
};

type LabelLookup = {
    #absent;
    #unknown;
    #less;
    #greater;
    #found : MerkleTree.Witness;
};

// Mirrors ic-certification 3.2.0 / the IC verifier's sorted HashTree lookup.
// Reconstruction alone is insufficient: a pruned target reconstructs the
// signed root but classifies as Unknown rather than proving membership or
// non-membership.
func lookupLabel(
    tree : MerkleTree.Witness,
    labelValue : Blob,
) : LabelLookup {
    switch (tree) {
        case (#labeled(current, child)) {
            switch (Blob.compare(labelValue, current)) {
                case (#greater) #greater;
                case (#equal) #found(child);
                case (#less) #less;
            };
        };
        case (#fork(left, right)) {
            switch (lookupLabel(left, labelValue)) {
                case (#greater) {
                    switch (lookupLabel(right, labelValue)) {
                        case (#less) #absent;
                        case (result) result;
                    };
                };
                case (#unknown) {
                    switch (lookupLabel(right, labelValue)) {
                        case (#less) #unknown;
                        case (result) result;
                    };
                };
                case (result) result;
            };
        };
        case (#pruned(_)) #unknown;
        case _ #absent;
    };
};

func verifiedLookupAt(
    tree : MerkleTree.Witness,
    requested : [Blob],
    index : Nat,
) : VerifiedLookup {
    if (index < requested.size()) {
        switch (lookupLabel(tree, requested[index])) {
            case (#found(child)) {
                verifiedLookupAt(child, requested, index + 1);
            };
            case (#unknown) #unknown;
            case _ #absent;
        };
    } else {
        switch (tree) {
            case (#leaf(value)) #found(value);
            case (#empty) #absent;
            case (#pruned(_)) #unknown;
            case (#labeled(_, _)) #error;
            case (#fork(_, _)) #error;
        };
    };
};

func verifiedLookup(
    tree : MerkleTree.Witness,
    requested : [Blob],
) : VerifiedLookup {
    verifiedLookupAt(tree, requested, 0);
};

func witnessOk(
    memory : Forest.Memory,
    requested : [Blob],
    expected : Forest.LookupResult,
) : MerkleTree.Witness {
    switch (Forest.witness(memory, requested)) {
        case (#ok(result)) {
            assert (result.lookup == expected);
            assert (result.root_hash == memory.header.response_root_hash);
            assert (
                MerkleTree.reconstruct(result.witness) ==
                result.root_hash
            );
            result.witness;
        };
        case (#err(error)) {
            Debug.print(debug_show ("witness", requested, error));
            assert false;
            #empty;
        };
    };
};

// --------------------------------------------------------------------------
// Standard IC hash domains, deterministic LLRB shape, and exact CBOR.

let vectors = newMemory();
let emptyDiagnostics = Forest.diagnostics(vectors);
assert (emptyDiagnostics.healthy);
assert (not emptyDiagnostics.dirty);
assert (emptyDiagnostics.commit_sequence == 0);
assert (emptyDiagnostics.live_nodes == 0);
assert (emptyDiagnostics.allocated_nodes == 0);
assert (emptyDiagnostics.free_nodes == 0);
assert (emptyDiagnostics.node_capacity == Forest.MAX_NODES);
assert (emptyDiagnostics.live_maps == 3);
assert (emptyDiagnostics.allocated_maps == 3);
assert (emptyDiagnostics.free_maps == 0);
assert (emptyDiagnostics.map_capacity == Forest.MAX_MAPS);
let clean = commitOk(vectors);
assert (not clean.attached_root_changed);
assert (clean.commit_sequence == 0);

putNew(vectors, path(["b"]), "\02");
putNew(vectors, path(["a"]), "\01");
putNew(vectors, path(["c"]), "\03");
let dirtyDiagnostics = Forest.diagnostics(vectors);
assert (dirtyDiagnostics.dirty);
assert (dirtyDiagnostics.live_nodes == 3);
assert (dirtyDiagnostics.allocated_nodes == 3);
assert (dirtyDiagnostics.free_nodes == 0);
assert (Forest.lookup(vectors, path(["b"])) == #err(#unhealthy));

let vectorCommit = commitOk(vectors);
assert (vectorCommit.attached_root_changed);
assert (vectorCommit.commit_sequence == 1);
assert (
    Base64.encode(vectorCommit.response_root_hash) ==
    "i3WFlkBpl3FuFIrNuHuPPRzvjyKXFhmMCluAW3nrNfU="
);
assert (Forest.deepValidate(vectors));
assert (
    Forest.maximumDepth(vectors, Forest.responseRoot(vectors)) == ?2
);
assert (2 <= Forest.redBlackDepthBound(3));
let committedDiagnostics = Forest.diagnostics(vectors);
assert (not committedDiagnostics.dirty);
assert (committedDiagnostics.commit_sequence == 1);
assert (committedDiagnostics.live_nodes == vectorCommit.live_nodes);
assert (
    committedDiagnostics.allocated_nodes == vectorCommit.allocated_nodes
);
assert (committedDiagnostics.free_nodes == vectorCommit.free_nodes);
assert (committedDiagnostics.live_maps == vectorCommit.live_maps);
assert (
    committedDiagnostics.allocated_maps == vectorCommit.allocated_maps
);
assert (committedDiagnostics.free_maps == vectorCommit.free_maps);

let member = witnessOk(vectors, path(["b"]), #found("\02"));
assert (verifiedLookup(member, path(["b"])) == #found("\02"));
assert (
    Base64.encode(MerkleTree.encodeWitness(member)) ==
    "2dn3gwGCBFgg5VQjD5iT9suHYEY7O3uK+g4EPiUsRo+UQNAPdjEBmQKDAYMCQWKCA0ECggRYIN99g4vkrDRgutLPpQMi3xCWBsaULAEx+CEdAW6AhB4P"
);

let between = witnessOk(vectors, path(["bb"]), #absent);
assert (verifiedLookup(between, path(["bb"])) == #absent);
assert (
    Base64.encode(MerkleTree.encodeWitness(between)) ==
    "2dn3gwGCBFgg5VQjD5iT9suHYEY7O3uK+g4EPiUsRo+UQNAPdjEBmQKDAYMCQWKCBFggQHaQEvyZ0PnhcS9z6CcrBTG4JIOH8opXvJT0JPgqCAmDAkFjggRYIIP+kGFvvZFAlZcU6QBbVHyzteqG6JXfucFkQ8zg0c7c"
);

let below = witnessOk(vectors, path(["0"]), #absent);
assert (verifiedLookup(below, path(["0"])) == #absent);
assert (
    Base64.encode(MerkleTree.encodeWitness(below)) ==
    "2dn3gwGDAkFhggRYIG0CmBcEZ/wWAVsUc8h6OUdMvOkWfQyOmfUXP9oh4AQgggRYIPiUwx+YP35uQzkWRdhv/56fwS9/dNMdk5Lb7InghVPz"
);

let above = witnessOk(vectors, path(["z"]), #absent);
assert (verifiedLookup(above, path(["z"])) == #absent);
assert (
    Base64.encode(MerkleTree.encodeWitness(above)) ==
    "2dn3gwGCBFgg5VQjD5iT9suHYEY7O3uK+g4EPiUsRo+UQNAPdjEBmQKDAYIEWCDWFLj2SGvGVcbSlPd2atuQGP6cLia7/h9JoD0WdTiM44MCQWOCBFggg/6QYW+9kUCVlxTpAFtUfLO16obold+5wWRDzODRztw="
);

let merged = switch (
    Forest.witnessMany(
        vectors,
        [
            path(["a"]),
            path(["c"]),
            path(["bb"]),
            path(["a"]),
        ],
    )
) {
    case (#ok(result)) result;
    case (#err(error)) {
        Debug.print(debug_show ("witness-many", error));
        assert false;
        loop {};
    };
};
assert (merged.root_hash == vectorCommit.response_root_hash);
assert (MerkleTree.reconstruct(merged.witness) == merged.root_hash);
assert (verifiedLookup(merged.witness, path(["a"])) == #found("\01"));
assert (verifiedLookup(merged.witness, path(["c"])) == #found("\03"));
assert (verifiedLookup(merged.witness, path(["bb"])) == #absent);

// Do not claim certified absence when the requested shape conflicts with a
// terminal leaf/subtree. HTTP callers only request complete leaf paths.
assert (
    Forest.witness(vectors, path(["b", "tail"])) ==
    #err(#not_found)
);

let nestedTerminal = newMemory();
putNew(nestedTerminal, path(["branch", "child"]), "nested");
ignore commitOk(nestedTerminal);
assert (
    Forest.witness(nestedTerminal, path(["branch"])) ==
    #err(#not_subtree)
);

// --------------------------------------------------------------------------
// Ordered, reverse, and deterministic-permutation mutation histories.

let COUNT : Nat = 32;

func ordered(index : Nat, _count : Nat) : Nat { index };
func reverse(index : Nat, count : Nat) : Nat { count - 1 - index };
func permuted(index : Nat, count : Nat) : Nat {
    (index * 37 + 11) % count;
};

func keyFor(index : Nat) : [Blob] {
    let digits = Nat.toText(index);
    let padded = if (index < 10) {
        "00" # digits;
    } else if (index < 100) {
        "0" # digits;
    } else digits;
    path(["k" # padded]);
};

func valueFor(prefix : Text, index : Nat) : Blob {
    Text.encodeUtf8(prefix # Nat.toText(index));
};

func insertAll(
    memory : Forest.Memory,
    order : (Nat, Nat) -> Nat,
    valuePrefix : Text,
) : Forest.CommitReceipt {
    let priorSequence = memory.header.commit_sequence;
    var index = 0;
    while (index < COUNT) {
        let selected = order(index, COUNT);
        putNew(
            memory,
            keyFor(selected),
            valueFor(valuePrefix, selected),
        );
        index += 1;
    };
    let receipt = commitOk(memory);
    assert (receipt.commit_sequence == priorSequence + 1);
    assert (receipt.attached_root_changed);
    assert (Forest.deepValidate(memory));
    let depth = depthOk(memory);
    assert (depth <= Forest.redBlackDepthBound(COUNT));
    index := 0;
    while (index < COUNT) {
        assert (
            Forest.lookup(memory, keyFor(index)) ==
            #found(valueFor(valuePrefix, index))
        );
        let proof = witnessOk(
            memory,
            keyFor(index),
            #found(valueFor(valuePrefix, index)),
        );
        assert (
            verifiedLookup(proof, keyFor(index)) ==
            #found(valueFor(valuePrefix, index))
        );
        index += 1;
    };
    let absentLow = witnessOk(memory, path(["j999"]), #absent);
    assert (verifiedLookup(absentLow, path(["j999"])) == #absent);
    let absentHigh = witnessOk(memory, path(["z000"]), #absent);
    assert (verifiedLookup(absentHigh, path(["z000"])) == #absent);
    receipt;
};

func deleteAll(
    memory : Forest.Memory,
    order : (Nat, Nat) -> Nat,
    valuePrefix : Text,
) {
    let priorSequence = memory.header.commit_sequence;
    var index = 0;
    while (index < COUNT) {
        let selected = order(index, COUNT);
        deleteFound(
            memory,
            keyFor(selected),
            valueFor(valuePrefix, selected),
        );
        index += 1;
    };
    let receipt = commitOk(memory);
    assert (receipt.commit_sequence == priorSequence + 1);
    assert (receipt.attached_root_changed);
    assert (receipt.live_nodes == 0);
    assert (receipt.free_nodes == COUNT);
    assert (
        Forest.maximumDepth(memory, Forest.responseRoot(memory)) == ?0
    );
    assert (Forest.deepValidate(memory));
    let emptyProof = witnessOk(memory, path(["missing"]), #absent);
    assert (emptyProof == #empty);
    assert (verifiedLookup(emptyProof, path(["missing"])) == #absent);
};

let histories = newMemory();
Forest.resetOperationCounters(histories);
let orderedReceipt = insertAll(histories, ordered, "o:");
// The full integrity traversal resumes at the smallest possible page and
// covers the maximum-depth mutation vector used by this fixture.
assert (auditOk(histories, 1) > COUNT);
assert (histories.counters.nodes_allocated == COUNT);
assert (histories.counters.nodes_reused == 0);
let orderedAllocated = orderedReceipt.allocated_nodes;

// In-place replacement changes no node/map cardinality and allocates no path
// copies. A whole update still advances the commit sequence exactly once.
Forest.resetOperationCounters(histories);
var replaceIndex = 0;
while (replaceIndex < COUNT) {
    replace(
        histories,
        keyFor(replaceIndex),
        valueFor("o:", replaceIndex),
        valueFor("r:", replaceIndex),
    );
    replaceIndex += 1;
};
let replacement = commitOk(histories);
assert (replacement.live_nodes == COUNT);
assert (replacement.allocated_nodes == orderedAllocated);
assert (histories.counters.nodes_allocated == 0);
assert (histories.counters.nodes_reused == 0);
assert (histories.counters.nodes_reclaimed == 0);
assert (Forest.deepValidate(histories));

deleteAll(histories, reverse, "r:");
Forest.resetOperationCounters(histories);
let reverseReceipt = insertAll(histories, reverse, "v:");
assert (reverseReceipt.allocated_nodes == orderedAllocated);
assert (histories.counters.nodes_allocated == 0);
assert (histories.counters.nodes_reused == COUNT);
deleteAll(histories, permuted, "v:");

Forest.resetOperationCounters(histories);
let permutedReceipt = insertAll(histories, permuted, "p:");
assert (permutedReceipt.allocated_nodes == orderedAllocated);
assert (histories.counters.nodes_allocated == 0);
assert (histories.counters.nodes_reused == COUNT);
let firstPermutedRoot = permutedReceipt.response_root_hash;
deleteAll(histories, ordered, "p:");
let repeatedPermuted = insertAll(histories, permuted, "p2:");
// Values participate in the root, so reproduce the same mutation order and
// values once more after another complete reclaim/reuse cycle.
deleteAll(histories, reverse, "p2:");
let reproducedPermuted = insertAll(histories, permuted, "p2:");
assert (
    repeatedPermuted.response_root_hash ==
    reproducedPermuted.response_root_hash
);
assert (firstPermutedRoot != repeatedPermuted.response_root_hash);
deleteAll(histories, ordered, "p2:");
assert (histories.header.allocated_nodes == orderedAllocated);

// --------------------------------------------------------------------------
// Detach/reattach ownership, generation/epoch staleness, and arena reuse.

let lifecycle = newMemory();
putNew(lifecycle, path(["mount", "a"]), "A");
putNew(lifecycle, path(["mount", "b"]), "B");
let attached = commitOk(lifecycle);
let attachedRoot = attached.response_root_hash;
let allocatedBeforeDetach = attached.allocated_nodes;
let liveBeforeDetach = attached.live_nodes;
let expectedLifecycle = newMemory();
putNew(expectedLifecycle, path(["mount", "a"]), "A");
putNew(expectedLifecycle, path(["mount", "b"]), "B");
putNew(expectedLifecycle, path(["mount", "c"]), "C");
let expectedLifecycleRoot = commitOk(expectedLifecycle).response_root_hash;
assert (expectedLifecycleRoot != attachedRoot);

Forest.resetOperationCounters(lifecycle);
let firstToken = switch (Forest.detach(lifecycle, path(["mount"]))) {
    case (#ok(token)) token;
    case (#err(error)) {
        Debug.print(debug_show ("first-detach", error));
        assert false;
        loop {};
    };
};
assert (lifecycle.header.allocated_nodes == allocatedBeforeDetach);
assert (lifecycle.header.live_nodes + 1 == liveBeforeDetach);
assert (lifecycle.counters.nodes_reclaimed == 1);
let detachedCommit = commitOk(lifecycle);
assert (detachedCommit.attached_root_changed);
assert (Forest.lookup(lifecycle, path(["mount", "a"])) == #absent);

Forest.resetOperationCounters(lifecycle);
assert (Forest.attach(lifecycle, firstToken) == #ok);
assert (lifecycle.header.allocated_nodes == allocatedBeforeDetach);
assert (lifecycle.counters.nodes_allocated == 0);
assert (lifecycle.counters.nodes_reused == 1);
assert (Forest.attach(lifecycle, firstToken) == #err(#stale_token));
assert (
    Forest.putDetached(lifecycle, firstToken, path(["c"]), "C") ==
    #err(#stale_token)
);
let reattached = commitOk(lifecycle);
assert (reattached.response_root_hash == attachedRoot);
assert (Forest.deepValidate(lifecycle));

let secondToken = switch (Forest.detach(lifecycle, path(["mount"]))) {
    case (#ok(token)) token;
    case (#err(error)) {
        Debug.print(debug_show ("put-detached", error));
        assert false;
        loop {};
    };
};
assert (secondToken.detach_epoch != firstToken.detach_epoch);
assert (Forest.attach(lifecycle, firstToken) == #err(#stale_token));
let refreshed = switch (
    Forest.putDetached(lifecycle, secondToken, path(["c"]), "C")
) {
    case (#ok(result)) {
        assert (result.inserted);
        assert (result.prior == null);
        result.token;
    };
    case (#err(error)) {
        Debug.print(debug_show ("put-detached-error", error));
        assert false;
        loop {};
    };
};
assert (refreshed.root_hash != secondToken.root_hash);
assert (
    Forest.putDetached(lifecycle, secondToken, path(["d"]), "D") ==
    #err(#stale_token)
);
switch (Forest.refreshedDetached(lifecycle, secondToken)) {
    case null {};
    case (?_) assert false;
};

putNew(lifecycle, path(["mount"]), "conflict");
let conflictAttach = Forest.attach(lifecycle, refreshed);
assert (conflictAttach == #err(#exists));
deleteFound(lifecycle, path(["mount"]), "conflict");
let successfulAttach = Forest.attach(lifecycle, refreshed);
assert (successfulAttach == #ok);
let consumedAttach = Forest.attach(lifecycle, refreshed);
assert (consumedAttach == #err(#stale_token));
let changedReattach = commitOk(lifecycle);
assert (changedReattach.attached_root_changed);
assert (changedReattach.response_root_hash == expectedLifecycleRoot);
assert (Forest.lookup(lifecycle, path(["mount", "c"])) == #found("C"));
assert (Forest.deepValidate(lifecycle));

// --------------------------------------------------------------------------
// Bounded detached disposal is atomic and reuses the arena high-water mark.

let disposal = newMemory();
putNew(disposal, path(["retire", "a"]), "A");
putNew(disposal, path(["retire", "nested", "b"]), "B");
let disposalBaseline = commitOk(disposal);
let disposalToken = switch (
    Forest.detach(disposal, path(["retire"]))
) {
    case (#ok(token)) token;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
let liveNodesBeforeRejectedDiscard = disposal.header.live_nodes;
let liveMapsBeforeRejectedDiscard = disposal.header.live_maps;
assert (
    Forest.discardDetachedBounded(disposal, disposalToken, 2) ==
    #err(#capacity)
);
assert (disposal.header.live_nodes == liveNodesBeforeRejectedDiscard);
assert (disposal.header.live_maps == liveMapsBeforeRejectedDiscard);
assert (Forest.attach(disposal, disposalToken) == #ok);
assert (
    commitOk(disposal).response_root_hash ==
    disposalBaseline.response_root_hash
);

let disposableToken = switch (
    Forest.detach(disposal, path(["retire"]))
) {
    case (#ok(token)) token;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
Forest.resetOperationCounters(disposal);
assert (
    Forest.discardDetachedBounded(disposal, disposableToken, 3) ==
    #ok({ nodes = 3; maps = 2 })
);
assert (disposal.counters.nodes_reclaimed == 3);
assert (disposal.counters.maps_reclaimed == 2);
assert (Forest.attach(disposal, disposableToken) == #err(#stale_token));
let discarded = commitOk(disposal);
assert (discarded.live_nodes == 0);
assert (Forest.deepValidate(disposal));

Forest.resetOperationCounters(disposal);
putNew(disposal, path(["retire", "a"]), "A");
putNew(disposal, path(["retire", "nested", "b"]), "B");
let recreated = commitOk(disposal);
assert (recreated.response_root_hash == disposalBaseline.response_root_hash);
assert (recreated.allocated_nodes == disposalBaseline.allocated_nodes);
assert (recreated.allocated_maps == disposalBaseline.allocated_maps);
assert (disposal.counters.nodes_allocated == 0);
assert (disposal.counters.maps_allocated == 0);

// --------------------------------------------------------------------------
// Detached named roots update catalogs without changing the response root.

let detachedCatalog = newMemory();
putNew(detachedCatalog, path(["named", "base"]), "B");
putNew(
    detachedCatalog,
    path(["named", "collection", "item"]),
    "collection item",
);
ignore commitOk(detachedCatalog);
let namedRoot = switch (
    Forest.syncNamedRoot(
        detachedCatalog,
        #mount,
        "detached:one",
        path(["named"]),
    )
) {
    case (#ok(value)) value;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
ignore commitOk(detachedCatalog);
let namedCatalogBefore =
    detachedCatalog.header.mount_catalog_root_hash;
let namedToken = switch (
    Forest.detach(detachedCatalog, path(["named"]))
) {
    case (#ok(token)) token;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
let detachedResponse = commitOk(detachedCatalog).response_root_hash;
let updatedNamedToken = switch (
    Forest.putDetached(
        detachedCatalog,
        namedToken,
        path(["added"]),
        "A",
    )
) {
    case (#ok(result)) {
        assert (result.inserted);
        result.token;
    };
    case (#err(_)) {
        assert false;
        loop {};
    };
};
assert (updatedNamedToken.root_hash != namedRoot);
assert (
    Forest.syncNamedRoot(
        detachedCatalog,
        #mount,
        "detached:one",
        path(["named"]),
    ) == #err(#not_found)
);
assert (
    Forest.syncDetachedNamedRoot(
        detachedCatalog,
        #mount,
        "detached:one",
        namedToken,
    ) == #err(#stale_token)
);
assert (
    Forest.syncDetachedNamedRoot(
        detachedCatalog,
        #mount,
        "",
        updatedNamedToken,
    ) == #err(#invalid_path)
);
Forest.resetOperationCounters(detachedCatalog);
assert (
    Forest.syncDetachedNamedRoot(
        detachedCatalog,
        #mount,
        "detached:one",
        updatedNamedToken,
    ) == #ok(updatedNamedToken.root_hash)
);
assert (
    Forest.syncDetachedNamedRoot(
        detachedCatalog,
        #mount,
        "detached:one",
        updatedNamedToken,
    ) == #ok(updatedNamedToken.root_hash)
);
assert (detachedCatalog.counters.nodes_allocated == 0);
let detachedCollectionCatalogBefore =
    detachedCatalog.header.collection_catalog_root_hash;
let nestedCollectionRoot = switch (
    Forest.syncDetachedNamedRootAt(
        detachedCatalog,
        #collection,
        "detached:collection",
        updatedNamedToken,
        path(["collection"]),
    )
) {
    case (#ok(value)) value;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
assert (nestedCollectionRoot != updatedNamedToken.root_hash);
assert (
    Forest.syncDetachedNamedRootAt(
        detachedCatalog,
        #collection,
        "detached:missing",
        updatedNamedToken,
        path(["missing"]),
    ) == #err(#not_found)
);
let detachedCatalogCommit = commitOk(detachedCatalog);
assert (
    Forest.detachedNamedRootMatchesAt(
        detachedCatalog,
        #mount,
        "detached:one",
        updatedNamedToken,
        [],
    ) == #present
);
assert (
    Forest.detachedNamedRootMatchesAt(
        detachedCatalog,
        #collection,
        "detached:collection",
        updatedNamedToken,
        path(["collection"]),
    ) == #present
);
assert (not detachedCatalogCommit.attached_root_changed);
assert (detachedCatalogCommit.response_root_hash == detachedResponse);
assert (
    detachedCatalog.header.mount_catalog_root_hash != namedCatalogBefore
);
assert (
    detachedCatalog.header.collection_catalog_root_hash !=
        detachedCollectionCatalogBefore
);
let detachedCatalogHash =
    detachedCatalog.header.mount_catalog_root_hash;
assert (Forest.attach(detachedCatalog, updatedNamedToken) == #ok);
assert (
    Forest.syncNamedRoot(
        detachedCatalog,
        #mount,
        "detached:one",
        path(["named"]),
    ) == #ok(updatedNamedToken.root_hash)
);
let attachedCatalogCommit = commitOk(detachedCatalog);
assert (attachedCatalogCommit.attached_root_changed);
assert (
    detachedCatalog.header.mount_catalog_root_hash ==
    detachedCatalogHash
);
assert (Forest.deepValidate(detachedCatalog));

// --------------------------------------------------------------------------
// Named catalogs, bounded audit, restore validation, and commit fingerprints.

let metadata = newMemory();
assert (
    metadata.header.response_policy_table_fingerprint ==
    SHA256.fromBlob(#sha256, RESPONSE_POLICY_TABLE)
);
assert (
    metadata.header.allocator_layout_fingerprint ==
    ALLOCATOR_FINGERPRINT
);
let initialFingerprint = metadata.header.commit_fingerprint;
putNew(
    metadata,
    path(["catalogued", "object", "payload"]),
    "payload",
);
let contentCommit = commitOk(metadata);
let responseBeforeCatalog = contentCommit.response_root_hash;
let mountsBefore = metadata.header.mount_catalog_root_hash;
let collectionsBefore = metadata.header.collection_catalog_root_hash;

let mountValue = switch (
    Forest.syncNamedRoot(
        metadata,
        #mount,
        "mount:one",
        path(["catalogued"]),
    )
) {
    case (#ok(value)) value;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
let collectionValue = switch (
    Forest.syncNamedRoot(
        metadata,
        #collection,
        "collection:one",
        path(["catalogued", "object"]),
    )
) {
    case (#ok(value)) value;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
assert (mountValue != collectionValue);
let catalogCommit = commitOk(metadata);
assert (
    Forest.namedRootMatches(
        metadata,
        #mount,
        "mount:one",
        path(["catalogued"]),
    ) == #present
);
assert (
    Forest.namedRootMatches(
        metadata,
        #collection,
        "collection:one",
        path(["catalogued", "object"]),
    ) == #present
);
assert (not catalogCommit.attached_root_changed);
assert (catalogCommit.response_root_hash == responseBeforeCatalog);
assert (metadata.header.mount_catalog_root_hash != mountsBefore);
assert (
    metadata.header.collection_catalog_root_hash != collectionsBefore
);
assert (catalogCommit.commit_sequence == contentCommit.commit_sequence + 1);
assert (catalogCommit.commit_fingerprint != contentCommit.commit_fingerprint);
assert (catalogCommit.commit_fingerprint != initialFingerprint);

let catalogAllocated = catalogCommit.allocated_nodes;
Forest.resetOperationCounters(metadata);
assert (
    Forest.syncNamedRoot(
        metadata,
        #mount,
        "mount:one",
        path(["catalogued"]),
    ) == #ok(mountValue)
);
let sameCatalog = commitOk(metadata);
assert (not sameCatalog.attached_root_changed);
assert (sameCatalog.allocated_nodes == catalogAllocated);
assert (metadata.counters.nodes_allocated == 0);
assert (metadata.counters.nodes_reused == 0);
let collectionCatalogRetained =
    metadata.header.collection_catalog_root_hash;

assert (Forest.removeNamedRoot(metadata, #mount, "mount:one") == #ok(true));
assert (Forest.removeNamedRoot(metadata, #mount, "mount:one") == #ok(false));
let removedCatalog = commitOk(metadata);
assert (
    Forest.namedRootMatches(
        metadata,
        #mount,
        "mount:one",
        path(["catalogued"]),
    ) == #mismatch
);
assert (
    Forest.namedRootMatches(
        metadata,
        #mount,
        "missing:both",
        path(["missing"]),
    ) == #absent
);
assert (not removedCatalog.attached_root_changed);
assert (
    metadata.header.collection_catalog_root_hash ==
    collectionCatalogRetained
);
assert (Forest.deepValidate(metadata));

let auditStart = Forest.initialAuditCursor(metadata);
assert (Forest.auditStep(metadata, auditStart, 0) == #more(auditStart));
var auditCursor = auditStart;
var auditComplete = false;
var auditCalls = 0;
while (not auditComplete) {
    switch (Forest.auditStep(metadata, auditCursor, 3)) {
        case (#more(next)) auditCursor := next;
        case (#complete) auditComplete := true;
        case (#stale) assert false;
        case (#err(_)) assert false;
    };
    auditCalls += 1;
    assert (auditCalls < 1_000);
};
assert (auditCalls > 1);

let staleAudit = Forest.initialAuditCursor(metadata);
assert (
    Forest.syncNamedRoot(
        metadata,
        #collection,
        "collection:one",
        path(["catalogued", "object"]),
    ) == #ok(collectionValue)
);
ignore commitOk(metadata);
assert (Forest.auditStep(metadata, staleAudit, 1) == #stale);

// A detached root is outside the committed response hash, so this corruption
// reaches the deep map traversal instead of being rejected by the O(1)
// attached-root guard.
let corruptAudit = newMemory();
putNew(corruptAudit, path(["retired", "entry"]), "value");
ignore commitOk(corruptAudit);
let corruptToken = switch (
    Forest.detach(corruptAudit, path(["retired"]))
) {
    case (#ok(token)) token;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
ignore commitOk(corruptAudit);
let corruptMap = mapAt(corruptAudit, corruptToken.root);
corruptMap.size += 1;
var corruptCursor = Forest.initialAuditCursor(corruptAudit);
var corruptionFound = false;
var corruptCalls = 0;
while (not corruptionFound) {
    switch (Forest.auditStep(corruptAudit, corruptCursor, 1)) {
        case (#more(next)) corruptCursor := next;
        case (#err(#corrupt)) corruptionFound := true;
        case (#err(_)) assert false;
        case (#stale) assert false;
        case (#complete) assert false;
    };
    corruptCalls += 1;
    assert (corruptCalls < 1_000);
};

switch (
    Forest.validateAndRestore(
        metadata,
        RESPONSE_POLICY_TABLE,
        ALLOCATOR_FINGERPRINT,
    )
) {
    case (#ok(restored)) {
        assert (restored.response_root_hash == responseBeforeCatalog);
        assert (
            restored.commit_fingerprint ==
            metadata.header.commit_fingerprint
        );
    };
    case (#err(_)) assert false;
};

assert (
    Forest.validateAndRestore(
        metadata,
        "wrong-response-policy-table",
        ALLOCATOR_FINGERPRINT,
    ) == #err(#corrupt)
);
assert (not metadata.header.healthy);
switch (
    Forest.validateAndRestore(
        metadata,
        RESPONSE_POLICY_TABLE,
        ALLOCATOR_FINGERPRINT,
    )
) {
    case (#ok(_)) assert (metadata.header.healthy);
    case (#err(_)) assert false;
};

let beforeCleanCommit = metadata.header.commit_sequence;
let beforeCleanFingerprint = metadata.header.commit_fingerprint;
let cleanAgain = commitOk(metadata);
assert (not cleanAgain.attached_root_changed);
assert (cleanAgain.commit_sequence == beforeCleanCommit);
assert (cleanAgain.commit_fingerprint == beforeCleanFingerprint);
assert (Forest.deepValidate(metadata));

// --------------------------------------------------------------------------
// Nested updates refresh each map exactly once. These deterministic visit
// bounds reject the former quadratic repeated-parent propagation without
// relying on wall-clock timing.

let DEEP_PATH_DEPTH = 32;
let nestedPath = deepPath(DEEP_PATH_DEPTH);

let deepReplacement = newMemory();
putNew(deepReplacement, nestedPath, "before");
ignore commitOk(deepReplacement);
Forest.resetOperationCounters(deepReplacement);
replace(deepReplacement, nestedPath, "before", "after");
assert (
    deepReplacement.counters.node_visits <= 2 * DEEP_PATH_DEPTH
);
ignore commitOk(deepReplacement);
assert (Forest.lookup(deepReplacement, nestedPath) == #found("after"));
assert (Forest.deepValidate(deepReplacement));

let deepDeletion = newMemory();
putNew(deepDeletion, nestedPath, "delete-me");
ignore commitOk(deepDeletion);
Forest.resetOperationCounters(deepDeletion);
deleteFound(deepDeletion, nestedPath, "delete-me");
assert (deepDeletion.counters.node_visits <= 4 * DEEP_PATH_DEPTH);
ignore commitOk(deepDeletion);
assert (Forest.lookup(deepDeletion, nestedPath) == #absent);
assert (Forest.deepValidate(deepDeletion));

let deepDetachment = newMemory();
let nestedPayloadPath = Array.concat<Blob>(
    nestedPath,
    path(["payload"]),
);
putNew(deepDetachment, nestedPayloadPath, "detached");
let beforeDeepDetach = commitOk(deepDetachment);
Forest.resetOperationCounters(deepDetachment);
let deepToken = switch (Forest.detach(deepDetachment, nestedPath)) {
    case (#ok(token)) token;
    case (#err(_)) {
        assert false;
        loop {};
    };
};
assert (deepDetachment.counters.node_visits <= 4 * DEEP_PATH_DEPTH);
ignore commitOk(deepDetachment);
assert (Forest.lookup(deepDetachment, nestedPayloadPath) == #absent);
assert (Forest.deepValidate(deepDetachment));
assert (Forest.attach(deepDetachment, deepToken) == #ok);
let afterDeepAttach = commitOk(deepDetachment);
assert (
    afterDeepAttach.response_root_hash ==
    beforeDeepDetach.response_root_hash
);
assert (Forest.deepValidate(deepDetachment));

// --------------------------------------------------------------------------
// Header roots are three independent authorities. Empty roots have identical
// hashes, so pairwise reference checks—not hash comparison—must reject every
// alias arrangement during fast reads and O(1) restore.

func expectAliasedRootsRejected(memory : Forest.Memory) {
    assert (Forest.rootHash(memory) == null);
    assert (
        Forest.validateAndRestore(
            memory,
            RESPONSE_POLICY_TABLE,
            ALLOCATOR_FINGERPRINT,
        ) == #err(#corrupt)
    );
    assert (not memory.header.healthy);
    assert (not Forest.deepValidate(memory));
};

let responseMountSource = newMemory();
expectAliasedRootsRejected(memoryWithRoots(
    responseMountSource,
    responseMountSource.header.response_root,
    responseMountSource.header.response_root,
    responseMountSource.header.collection_catalog_root,
));

let responseCollectionSource = newMemory();
expectAliasedRootsRejected(memoryWithRoots(
    responseCollectionSource,
    responseCollectionSource.header.response_root,
    responseCollectionSource.header.mount_catalog_root,
    responseCollectionSource.header.response_root,
));

let mountCollectionSource = newMemory();
expectAliasedRootsRejected(memoryWithRoots(
    mountCollectionSource,
    mountCollectionSource.header.response_root,
    mountCollectionSource.header.mount_catalog_root,
    mountCollectionSource.header.mount_catalog_root,
));

// A record residing in arena slot N must itself name N. Fresh distinguished
// maps deliberately share generation/hash, so slot identity is independently
// necessary and cannot be replaced by generation or digest checks.
let wrongRootMap = newMemory();
let ?rootMapChunk = wrongRootMap.map_chunks[0] else {
    assert false;
    loop {};
};
let ?mountRootRecord = rootMapChunk[1] else {
    assert false;
    loop {};
};
rootMapChunk[0] := ?mountRootRecord;
assert (Forest.rootHash(wrongRootMap) == null);
assert (
    Forest.validateAndRestore(
        wrongRootMap,
        RESPONSE_POLICY_TABLE,
        ALLOCATOR_FINGERPRINT,
    ) == #err(#corrupt)
);
assert (not Forest.deepValidate(wrongRootMap));

// Free arena records are outside O(1) restore by design, but the bounded
// allocation audit must bind both live and tombstone records to their slots.
let wrongFreeNode = newMemory();
putNew(wrongFreeNode, path(["free-node"]), "value");
ignore commitOk(wrongFreeNode);
deleteFound(wrongFreeNode, path(["free-node"]), "value");
ignore commitOk(wrongFreeNode);
let freeNodeId = wrongFreeNode.free_node;
assert (freeNodeId != 0);
let freeNodeZero = freeNodeId - 1;
let ?freeNodeChunk =
    wrongFreeNode.node_chunks[
        freeNodeZero / Forest.NODE_CHUNK_SIZE
    ] else {
        assert false;
        loop {};
    };
let freeNodeSlot = freeNodeZero % Forest.NODE_CHUNK_SIZE;
let ?freeNodeRecord = freeNodeChunk[freeNodeSlot] else {
    assert false;
    loop {};
};
freeNodeChunk[freeNodeSlot] := ?nodeWithId(
    freeNodeRecord,
    freeNodeRecord.id + 10_000,
);
assert (Forest.rootHash(wrongFreeNode) != null);
switch (
    Forest.auditStep(
        wrongFreeNode,
        Forest.initialAuditCursor(wrongFreeNode),
        64,
    )
) {
    case (#err(#corrupt)) {};
    case (_) assert false;
};

let wrongFreeMap = newMemory();
putNew(wrongFreeMap, path(["free-map", "leaf"]), "value");
ignore commitOk(wrongFreeMap);
deleteFound(wrongFreeMap, path(["free-map", "leaf"]), "value");
ignore commitOk(wrongFreeMap);
let freeMapId = wrongFreeMap.free_map;
assert (freeMapId != 0);
let freeMapZero = freeMapId - 1;
let ?freeMapChunk =
    wrongFreeMap.map_chunks[
        freeMapZero / Forest.MAP_CHUNK_SIZE
    ] else {
        assert false;
        loop {};
    };
let freeMapSlot = freeMapZero % Forest.MAP_CHUNK_SIZE;
let ?freeMapRecord = freeMapChunk[freeMapSlot] else {
    assert false;
    loop {};
};
freeMapChunk[freeMapSlot] := ?mapWithId(
    freeMapRecord,
    freeMapRecord.id + 10_000,
);
assert (Forest.rootHash(wrongFreeMap) != null);
switch (
    Forest.auditStep(
        wrongFreeMap,
        Forest.initialAuditCursor(wrongFreeMap),
        128,
    )
) {
    case (#err(#corrupt)) {};
    case (_) assert false;
};
