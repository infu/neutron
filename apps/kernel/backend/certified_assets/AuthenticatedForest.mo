import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import MerkleTree "mo:ic-certification/MerkleTree";
import SHA256 "mo:sha2/Sha256";

// A persistent, augmented left-leaning red-black forest for IC hash trees.
//
// The shape and three-way fork construction are pinned to the verifier-side
// `ic-certification` RbTree algorithm.  Unlike a functional/path-copying tree,
// nodes live in a mutable chunked arena and every removed slot is returned to
// a free stack in the same update.  Point writes therefore allocate at most
// one node per new keyLabel and never leak O(log n) superseded nodes.
module {
    public let SCHEMA_VERSION : Nat32 = 3;
    public let FOREST_VERSION : Nat32 = 1;

    public let NODE_CHUNK_SIZE : Nat = 256;
    public let MAP_CHUNK_SIZE : Nat = 128;
    public let MAX_NODE_CHUNKS : Nat = 65_536;
    public let MAX_MAP_CHUNKS : Nat = 32_768;
    public let MAX_NODES : Nat = 16_777_216;
    public let MAX_MAPS : Nat = 4_194_304;
    public let MAX_PATH_LABELS : Nat = 128;
    public let MAX_PATH_BYTES : Nat = 16_384;
    public let MAX_LABEL_BYTES : Nat = 1_024;
    public let MAX_AUDIT_STACK : Nat = 256;
    public let MAX_RESPONSE_POLICY_TABLE_BYTES : Nat = 65_536;

    public let KEY_HASH_DOMAIN = "neutron.certified-forest.key.v1\00";
    public let NAMED_ROOT_DOMAIN = "neutron.certified-forest.named-root.v1\00";
    public let COMMIT_DOMAIN = "neutron.certified-forest.commit.v1\00";
    public let DETACHED_TOKEN_DOMAIN =
        "neutron.certified-forest.detached-token.v1\00";

    public type Color = { #red; #black };
    public type NodeId = Nat;
    public type MapId = Nat;
    public type MapRef = {
        id : MapId;
        generation : Nat64;
    };

    public type Value = {
        #leaf : Blob;
        #subtree : MapRef;
    };

    public type Node = {
        id : NodeId;
        var in_use : Bool;
        var map_id : MapId;
        var key : Blob;
        var key_hash : Blob;
        var value : Value;
        var value_hash : Blob;
        // Cached IC `labeled(key, value_hash)` node payload.  Witness queries
        // consume this directly and never hash an authenticated leaf.
        var data_hash : Blob;
        var color : Color;
        var left : NodeId;
        var right : NodeId;
        var subtree_hash : Blob;
        var free_next : NodeId;
    };

    public type MapRoot = {
        id : MapId;
        var in_use : Bool;
        var generation : Nat64;
        var root : NodeId;
        var size : Nat;
        var parent_map : MapRef;
        var parent_node : NodeId;
        var attached : Bool;
        var detach_epoch : Nat64;
        var detached_path_hash : Blob;
        var free_next : MapId;
    };

    public type NodeChunk = [var ?Node];
    public type MapChunk = [var ?MapRoot];

    public type Header = {
        schema_version : Nat32;
        forest_version : Nat32;
        response_root : MapRef;
        mount_catalog_root : MapRef;
        collection_catalog_root : MapRef;
        response_policy_table_canonical : Blob;
        response_policy_table_fingerprint : Blob;
        allocator_layout_fingerprint : Blob;
        var response_root_hash : Blob;
        var mount_catalog_root_hash : Blob;
        var collection_catalog_root_hash : Blob;
        var commit_sequence : Nat64;
        var commit_fingerprint : Blob;
        var live_nodes : Nat;
        var allocated_nodes : Nat;
        var free_nodes : Nat;
        var live_maps : Nat;
        var allocated_maps : Nat;
        var free_maps : Nat;
        var healthy : Bool;
    };

    public type OperationCounters = {
        var node_visits : Nat;
        var rotations : Nat;
        var nodes_allocated : Nat;
        var nodes_reused : Nat;
        var nodes_reclaimed : Nat;
        var maps_allocated : Nat;
        var maps_reused : Nat;
        var maps_reclaimed : Nat;
        var witness_nodes : Nat;
    };

    public type Diagnostics = {
        healthy : Bool;
        dirty : Bool;
        commit_sequence : Nat64;
        live_nodes : Nat;
        allocated_nodes : Nat;
        free_nodes : Nat;
        node_capacity : Nat;
        live_maps : Nat;
        allocated_maps : Nat;
        free_maps : Nat;
        map_capacity : Nat;
    };

    public type Memory = {
        node_chunks : [var ?NodeChunk];
        map_chunks : [var ?MapChunk];
        var next_node_id : NodeId;
        var next_map_id : MapId;
        var free_node : NodeId;
        var free_map : MapId;
        var dirty : Bool;
        header : Header;
        counters : OperationCounters;
    };

    public type Error = {
        #capacity;
        #corrupt;
        #exists;
        #invalid_path;
        #not_found;
        #not_subtree;
        #stale_token;
        #unhealthy;
    };

    public type PutResult = {
        #ok : {
            inserted : Bool;
            prior : ?Blob;
        };
        #err : Error;
    };

    public type DeleteResult = {
        #ok : ?Blob;
        #err : Error;
    };
    public type DetachedPutResult = {
        #ok : {
            inserted : Bool;
            prior : ?Blob;
            token : Detached;
        };
        #err : Error;
    };
    public type DetachedDeleteResult = {
        #ok : {
            deleted : ?Blob;
            token : Detached;
        };
        #err : Error;
    };
    public type DiscardResult = {
        #ok : {
            nodes : Nat;
            maps : Nat;
        };
        #err : Error;
    };

    public type LookupResult = {
        #found : Blob;
        #absent;
        #err : Error;
    };
    public type PathKindResult = {
        #leaf;
        #subtree;
        #absent;
        #err : Error;
    };

    public type WitnessResult = {
        #ok : {
            lookup : LookupResult;
            witness : MerkleTree.Witness;
            root_hash : Blob;
        };
        #err : Error;
    };
    public type MultiWitnessResult = {
        #ok : {
            witness : MerkleTree.Witness;
            root_hash : Blob;
        };
        #err : Error;
    };

    public type Detached = {
        absolute_path : [Blob];
        absolute_path_hash : Blob;
        root : MapRef;
        detach_epoch : Nat64;
        root_hash : Blob;
        token_fingerprint : Blob;
    };

    public type DetachResult = {
        #ok : Detached;
        #err : Error;
    };

    public type CommitReceipt = {
        attached_root_changed : Bool;
        response_root_hash : Blob;
        commit_sequence : Nat64;
        commit_fingerprint : Blob;
        live_nodes : Nat;
        allocated_nodes : Nat;
        free_nodes : Nat;
        live_maps : Nat;
        allocated_maps : Nat;
        free_maps : Nat;
    };

    public type CommitResult = {
        #ok : CommitReceipt;
        #err : Error;
    };

    public type RestoreResult = {
        #ok : {
            response_root_hash : Blob;
            commit_fingerprint : Blob;
        };
        #err : Error;
    };

    public type RootKind = { #mount; #collection };
    public type NamedRootResult = {
        #ok : Blob;
        #err : Error;
    };
    public type NamedRootMatch = {
        // The expected subtree exists and its descriptor matches the catalog.
        #present;
        // The expected subtree and its catalog descriptor are both absent.
        #absent;
        // Missing, stale, unexpected, or otherwise unequal descriptor.
        #mismatch;
        #err : Error;
    };
    public type CatalogSnapshot = {
        commit_sequence : Nat64;
        commit_fingerprint : Blob;
        mount_roots : Nat;
        collection_roots : Nat;
    };

    public type AuditPhase = {
        #node_slots;
        #node_free;
        #map_slots;
        #map_free;
        #deep_maps;
        #complete;
    };
    public type AuditTreeState = {
        count : Nat;
        black_height : Nat;
        hash : Blob;
    };
    public type AuditTreeStage = {
        #enter;
        #await_left;
        #await_right : AuditTreeState;
    };
    public type AuditTreeFrame = {
        node : NodeId;
        lower : ?Blob;
        upper : ?Blob;
        stage : AuditTreeStage;
    };
    public type AuditTreeCursor = {
        map : MapRef;
        expected_size : Nat;
        depth_bound : Nat;
        stack : [AuditTreeFrame];
        value : ?AuditTreeState;
        visited : Nat;
    };
    public type AuditDeepState = {
        #idle;
        #ancestry : {
            target : MapRef;
            current : MapRef;
            depth : Nat;
        };
        #tree : AuditTreeCursor;
    };
    public type AuditCursor = {
        phase : AuditPhase;
        next_slot : Nat;
        next_free : Nat;
        live_nodes_seen : Nat;
        free_nodes_seen : Nat;
        linked_free_nodes_seen : Nat;
        live_maps_seen : Nat;
        free_maps_seen : Nat;
        linked_free_maps_seen : Nat;
        commit_sequence : Nat64;
        commit_fingerprint : Blob;
        next_node_id : NodeId;
        next_map_id : MapId;
        free_node_head : NodeId;
        free_map_head : MapId;
        live_nodes : Nat;
        allocated_nodes : Nat;
        free_nodes : Nat;
        live_maps : Nat;
        allocated_maps : Nat;
        free_maps : Nat;
        deep_map_id : MapId;
        deep_nodes_seen : Nat;
        deep_state : AuditDeepState;
    };
    public type AuditStep = {
        #more : AuditCursor;
        #complete;
        #stale;
        #err : Error;
    };

    let NULL_NODE : NodeId = 0;
    let NULL_MAP : MapId = 0;
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;
    let ZERO_REF : MapRef = { id = 0; generation = 0 };
    let EMPTY_BLOB : Blob = "";

    public func init(
        responsePolicyTableCanonical : Blob,
        allocatorLayoutFingerprint : Blob,
    ) : Memory {
        assert (
            responsePolicyTableCanonical.size() > 0 and
            responsePolicyTableCanonical.size() <= MAX_RESPONSE_POLICY_TABLE_BYTES
        );
        let responsePolicyTableFingerprint = SHA256.fromBlob(
            #sha256,
            responsePolicyTableCanonical,
        );
        assert allocatorLayoutFingerprint.size() == 32;
        let nodes = VarArray.repeat<?NodeChunk>(null, MAX_NODE_CHUNKS);
        let maps = VarArray.repeat<?MapChunk>(null, MAX_MAP_CHUNKS);
        let placeholder : Header = {
            schema_version = SCHEMA_VERSION;
            forest_version = FOREST_VERSION;
            response_root = ZERO_REF;
            mount_catalog_root = ZERO_REF;
            collection_catalog_root = ZERO_REF;
            response_policy_table_canonical = responsePolicyTableCanonical;
            response_policy_table_fingerprint = responsePolicyTableFingerprint;
            allocator_layout_fingerprint = allocatorLayoutFingerprint;
            var response_root_hash = emptyHash();
            var mount_catalog_root_hash = emptyHash();
            var collection_catalog_root_hash = emptyHash();
            var commit_sequence = 0;
            var commit_fingerprint = EMPTY_BLOB;
            var live_nodes = 0;
            var allocated_nodes = 0;
            var free_nodes = 0;
            var live_maps = 0;
            var allocated_maps = 0;
            var free_maps = 0;
            var healthy = true;
        };
        let memory : Memory = {
            node_chunks = nodes;
            map_chunks = maps;
            var next_node_id = 1;
            var next_map_id = 1;
            var free_node = 0;
            var free_map = 0;
            var dirty = false;
            header = placeholder;
            counters = newCounters();
        };
        let response = switch (allocateMap(memory)) {
            case (?value) value;
            case null { assert false; ZERO_REF };
        };
        let mounts = switch (allocateMap(memory)) {
            case (?value) value;
            case null { assert false; ZERO_REF };
        };
        let collections = switch (allocateMap(memory)) {
            case (?value) value;
            case null { assert false; ZERO_REF };
        };
        for (rootRef in [response, mounts, collections].vals()) {
            markRootAttached(memory, rootRef);
        };
        let header : Header = {
            schema_version = SCHEMA_VERSION;
            forest_version = FOREST_VERSION;
            response_root = response;
            mount_catalog_root = mounts;
            collection_catalog_root = collections;
            response_policy_table_canonical = responsePolicyTableCanonical;
            response_policy_table_fingerprint = responsePolicyTableFingerprint;
            allocator_layout_fingerprint = allocatorLayoutFingerprint;
            var response_root_hash = emptyHash();
            var mount_catalog_root_hash = emptyHash();
            var collection_catalog_root_hash = emptyHash();
            var commit_sequence = 0;
            var commit_fingerprint = EMPTY_BLOB;
            var live_nodes = 0;
            var allocated_nodes = 0;
            var free_nodes = 0;
            var live_maps = 3;
            var allocated_maps = 3;
            var free_maps = 0;
            var healthy = true;
        };
        // The header is immutable as a record reference; initialize its
        // compiler-owned root references by returning the final record.
        let initialized : Memory = {
            node_chunks = memory.node_chunks;
            map_chunks = memory.map_chunks;
            var next_node_id = memory.next_node_id;
            var next_map_id = memory.next_map_id;
            var free_node = memory.free_node;
            var free_map = memory.free_map;
            var dirty = false;
            header;
            counters = memory.counters;
        };
        refreshHeader(initialized, false);
        initialized;
    };

    func newCounters() : OperationCounters {
        {
            var node_visits = 0;
            var rotations = 0;
            var nodes_allocated = 0;
            var nodes_reused = 0;
            var nodes_reclaimed = 0;
            var maps_allocated = 0;
            var maps_reused = 0;
            var maps_reclaimed = 0;
            var witness_nodes = 0;
        };
    };

    public func resetOperationCounters(memory : Memory) {
        memory.counters.node_visits := 0;
        memory.counters.rotations := 0;
        memory.counters.nodes_allocated := 0;
        memory.counters.nodes_reused := 0;
        memory.counters.nodes_reclaimed := 0;
        memory.counters.maps_allocated := 0;
        memory.counters.maps_reused := 0;
        memory.counters.maps_reclaimed := 0;
        memory.counters.witness_nodes := 0;
    };

    public func diagnostics(memory : Memory) : Diagnostics {
        {
            healthy = memory.header.healthy;
            dirty = memory.dirty;
            commit_sequence = memory.header.commit_sequence;
            live_nodes = memory.header.live_nodes;
            allocated_nodes = memory.header.allocated_nodes;
            free_nodes = memory.header.free_nodes;
            node_capacity = MAX_NODES;
            live_maps = memory.header.live_maps;
            allocated_maps = memory.header.allocated_maps;
            free_maps = memory.header.free_maps;
            map_capacity = MAX_MAPS;
        };
    };

    public func responseRoot(memory : Memory) : MapRef {
        memory.header.response_root;
    };

    public func rootHash(memory : Memory) : ?Blob {
        if (
            not memory.header.healthy or memory.dirty or
            not fastHeaderValid(memory)
        ) return null;
        ?memory.header.response_root_hash;
    };

    public func canonicalKeyHash(key : Blob) : Blob {
        let digest = SHA256.Digest(#sha256);
        digest.writeBlob(Text.encodeUtf8(KEY_HASH_DOMAIN));
        digest.writeBlob(u32be(Nat32.fromNat(key.size())));
        digest.writeBlob(key);
        digest.sum();
    };

    public func canonicalPathEncoding(path : [Blob]) : Blob {
        let bytes = List.empty<Nat8>();
        appendBlob(bytes, u32be(Nat32.fromNat(path.size())));
        for (keyLabel in path.vals()) {
            appendBlob(bytes, u32be(Nat32.fromNat(keyLabel.size())));
            appendBlob(bytes, keyLabel);
        };
        Blob.fromArray(List.toArray(bytes));
    };

    public func namedRootValue(
        path : [Blob],
        root : MapRef,
        rootValueHash : Blob,
    ) : Blob {
        assert rootValueHash.size() == 32;
        let digest = SHA256.Digest(#sha256);
        digest.writeBlob(Text.encodeUtf8(NAMED_ROOT_DOMAIN));
        digest.writeBlob(canonicalPathEncoding(path));
        digest.writeBlob(u64be(Nat64.fromNat(root.id)));
        digest.writeBlob(u64be(root.generation));
        digest.writeBlob(rootValueHash);
        digest.sum();
    };

    type InsertionRequirement = {
        nodes : Nat;
        maps : Nat;
    };
    type PreflightPut = {
        #ok : InsertionRequirement;
        #err : Error;
    };

    func preflightPut(
        memory : Memory,
        map : MapRef,
        path : [Blob],
        index : Nat,
    ) : PreflightPut {
        switch (lookupMapValue(memory, map, path[index])) {
            case (#err(error)) #err(error);
            case (#ok(null)) {
                let remaining = path.size() - index;
                #ok({
                    nodes = remaining;
                    maps = remaining - 1;
                });
            };
            case (#ok(?#leaf(_))) {
                if (index + 1 == path.size()) {
                    #ok({ nodes = 0; maps = 0 });
                } else #err(#exists);
            };
            case (#ok(?#subtree(child))) {
                if (index + 1 == path.size()) {
                    #err(#exists);
                } else {
                    preflightPut(memory, child, path, index + 1);
                };
            };
        };
    };

    func capacityAvailable(
        memory : Memory,
        requirement : InsertionRequirement,
    ) : Bool {
        let availableNodes =
            memory.header.free_nodes +
            (MAX_NODES - memory.header.allocated_nodes);
        let availableMaps =
            memory.header.free_maps +
            (MAX_MAPS - memory.header.allocated_maps);
        requirement.nodes <= availableNodes and
        requirement.maps <= availableMaps;
    };

    public func put(memory : Memory, path : [Blob], value : Blob) : PutResult {
        if (not writable(memory)) return #err(#unhealthy);
        if (not validPath(path)) return #err(#invalid_path);
        switch (preflightPut(memory, memory.header.response_root, path, 0)) {
            case (#err(error)) return #err(error);
            case (#ok(requirement)) {
                if (not capacityAvailable(memory, requirement)) {
                    return #err(#capacity);
                };
            };
        };
        let result = putAt(memory, memory.header.response_root, path, 0, #leaf(value));
        switch (result) {
            case (#err(error)) {
                Runtime.trap(
                    "Authenticated forest diverged from put preflight: " #
                    debug_show(error)
                );
            };
            case (#ok(state)) {
                memory.dirty := true;
                #ok({
                    inserted = state.inserted;
                    prior = switch (state.prior) {
                        case (?#leaf(blob)) ?blob;
                        case _ null;
                    };
                });
            };
        };
    };

    public func delete(memory : Memory, path : [Blob]) : DeleteResult {
        if (not writable(memory)) return #err(#unhealthy);
        if (not validPath(path)) return #err(#invalid_path);
        switch (lookupValueAt(memory, memory.header.response_root, path, 0)) {
            case (#err(error)) return #err(error);
            case (#ok(null)) return #ok(null);
            case (#ok(?#subtree(_))) return #err(#not_subtree);
            case (#ok(?#leaf(_))) {};
        };
        switch (deleteAt(memory, memory.header.response_root, path, 0, false)) {
            case (#err(error)) {
                Runtime.trap(
                    "Authenticated forest delete diverged from preflight: " #
                    debug_show(error)
                );
            };
            case (#ok(null)) {
                Runtime.trap("Authenticated forest preflight leaf vanished");
            };
            case (#ok(?value)) {
                memory.dirty := true;
                switch (value) {
                    case (#leaf(blob)) #ok(?blob);
                    case (#subtree(_)) #err(#not_subtree);
                };
            };
        };
    };

    public func lookup(memory : Memory, path : [Blob]) : LookupResult {
        if (not readable(memory)) return #err(#unhealthy);
        if (not validPath(path)) return #err(#invalid_path);
        lookupAt(memory, memory.header.response_root, path, 0);
    };

    // Exact structural lookup for validators that must reject an existing
    // subtree authority without enumerating any of its children. This is a
    // mutation-time view: it intentionally sees pending nodes while an outer
    // publication transaction keeps the forest dirty.
    public func pathKind(memory : Memory, path : [Blob]) : PathKindResult {
        if (not writable(memory)) return #err(#unhealthy);
        if (not validPath(path)) return #err(#invalid_path);
        switch (
            lookupValueAt(memory, memory.header.response_root, path, 0)
        ) {
            case (#err(error)) #err(error);
            case (#ok(null)) #absent;
            case (#ok(?#leaf(_))) #leaf;
            case (#ok(?#subtree(_))) #subtree;
        };
    };

    public func witness(memory : Memory, path : [Blob]) : WitnessResult {
        if (not readable(memory)) return #err(#unhealthy);
        if (not validPath(path)) return #err(#invalid_path);
        switch (witnessAt(memory, memory.header.response_root, path, 0)) {
            case (#err(error)) #err(error);
            case (#ok(result)) {
                let root = mapHash(memory, memory.header.response_root);
                if (MerkleTree.reconstruct(result.witness) != root) {
                    return #err(#corrupt);
                };
                #ok({
                    lookup = result.lookup;
                    witness = result.witness;
                    root_hash = root;
                });
            };
        };
    };

    public func witnessMany(
        memory : Memory,
        paths : [[Blob]],
    ) : MultiWitnessResult {
        if (not readable(memory)) return #err(#unhealthy);
        if (paths.size() == 0 or paths.size() > 32) {
            return #err(#invalid_path);
        };
        let root = mapHash(memory, memory.header.response_root);
        var merged : MerkleTree.Witness = #pruned(root);
        for (path in paths.vals()) {
            if (not validPath(path)) return #err(#invalid_path);
            let single = switch (
                witnessAt(
                    memory,
                    memory.header.response_root,
                    path,
                    0,
                )
            ) {
                case (#err(error)) return #err(error);
                case (#ok(result)) result.witness;
            };
            merged := MerkleTree.merge(merged, single);
        };
        if (MerkleTree.reconstruct(merged) != root) return #err(#corrupt);
        #ok({ witness = merged; root_hash = root });
    };

    func detachedTokenFingerprint(token : Detached) : Blob {
        let digest = SHA256.Digest(#sha256);
        digest.writeBlob(Text.encodeUtf8(DETACHED_TOKEN_DOMAIN));
        digest.writeBlob(token.absolute_path_hash);
        digest.writeBlob(u64be(Nat64.fromNat(token.root.id)));
        digest.writeBlob(u64be(token.root.generation));
        digest.writeBlob(u64be(token.detach_epoch));
        digest.writeBlob(token.root_hash);
        digest.sum();
    };

    public func detach(memory : Memory, absolutePath : [Blob]) : DetachResult {
        if (not writable(memory)) return #err(#unhealthy);
        if (not validPath(absolutePath)) return #err(#invalid_path);
        let candidate = switch (
            lookupValueAt(
                memory,
                memory.header.response_root,
                absolutePath,
                0,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok(null)) return #err(#not_found);
            case (#ok(?#leaf(_))) return #err(#not_subtree);
            case (#ok(?#subtree(ref))) ref;
        };
        let ?candidateMap = getMap(memory, candidate) else {
            return #err(#corrupt);
        };
        if (candidateMap.detach_epoch == MAX_NAT64) return #err(#capacity);
        switch (
            detachAt(
                memory,
                memory.header.response_root,
                absolutePath,
                0,
            )
        ) {
            case (#err(error)) {
                Runtime.trap(
                    "Authenticated forest detach diverged from preflight: " #
                    debug_show(error)
                );
            };
            case (#ok(root)) {
                let ?map = getMap(memory, root) else return #err(#corrupt);
                map.attached := false;
                map.parent_map := ZERO_REF;
                map.parent_node := NULL_NODE;
                map.detach_epoch += 1;
                let pathHash = SHA256.fromBlob(
                    #sha256,
                    canonicalPathEncoding(absolutePath),
                );
                map.detached_path_hash := pathHash;
                memory.dirty := true;
                let rootHash = mapHash(memory, root);
                let base = {
                    absolute_path = absolutePath;
                    absolute_path_hash = pathHash;
                    root;
                    detach_epoch = map.detach_epoch;
                    root_hash = rootHash;
                    token_fingerprint = EMPTY_BLOB;
                };
                #ok({
                    base with
                    token_fingerprint = detachedTokenFingerprint(base);
                });
            };
        };
    };

    public func putDetached(
        memory : Memory,
        token : Detached,
        relativePath : [Blob],
        value : Blob,
    ) : DetachedPutResult {
        if (not writable(memory)) return #err(#unhealthy);
        if (not validPath(relativePath)) return #err(#invalid_path);
        let ?map = detachedMap(memory, token) else return #err(#stale_token);
        if (map.detach_epoch == MAX_NAT64) return #err(#capacity);
        switch (preflightPut(memory, mapRef(map), relativePath, 0)) {
            case (#err(error)) return #err(error);
            case (#ok(requirement)) {
                if (not capacityAvailable(memory, requirement)) {
                    return #err(#capacity);
                };
            };
        };
        switch (putAt(memory, mapRef(map), relativePath, 0, #leaf(value))) {
            case (#err(error)) {
                Runtime.trap(
                    "Authenticated detached put diverged from preflight: " #
                    debug_show(error)
                );
            };
            case (#ok(state)) {
                memory.dirty := true;
                map.detach_epoch += 1;
                let updated = refreshDetachedUnchecked(memory, token, map);
                #ok({
                    inserted = state.inserted;
                    prior = switch (state.prior) {
                        case (?#leaf(blob)) ?blob;
                        case _ null;
                    };
                    token = updated;
                });
            };
        };
    };

    public func deleteDetached(
        memory : Memory,
        token : Detached,
        relativePath : [Blob],
    ) : DetachedDeleteResult {
        if (not writable(memory)) return #err(#unhealthy);
        if (not validPath(relativePath)) return #err(#invalid_path);
        let ?map = detachedMap(memory, token) else return #err(#stale_token);
        if (map.detach_epoch == MAX_NAT64) return #err(#capacity);
        switch (lookupValueAt(memory, mapRef(map), relativePath, 0)) {
            case (#err(error)) return #err(error);
            case (#ok(null)) return #ok({ deleted = null; token });
            case (#ok(?#subtree(_))) return #err(#not_subtree);
            case (#ok(?#leaf(_))) {};
        };
        switch (deleteAt(memory, mapRef(map), relativePath, 0, false)) {
            case (#err(error)) {
                Runtime.trap(
                    "Authenticated detached delete diverged from preflight: " #
                    debug_show(error)
                );
            };
            case (#ok(null)) {
                Runtime.trap(
                    "Authenticated detached preflight leaf vanished"
                );
            };
            case (#ok(?value)) {
                memory.dirty := true;
                map.detach_epoch += 1;
                switch (value) {
                    case (#leaf(blob)) #ok({
                        deleted = ?blob;
                        token = refreshDetachedUnchecked(memory, token, map);
                    });
                    case (#subtree(_)) #err(#not_subtree);
                };
            };
        };
    };

    public func refreshedDetached(
        memory : Memory,
        token : Detached,
    ) : ?Detached {
        let ?map = detachedMap(memory, token) else return null;
        let updated = {
            token with
            detach_epoch = map.detach_epoch;
            root_hash = mapHash(memory, mapRef(map));
            token_fingerprint = EMPTY_BLOB;
        };
        ?{
            updated with
            token_fingerprint = detachedTokenFingerprint(updated);
        };
    };

    func refreshDetachedUnchecked(
        memory : Memory,
        token : Detached,
        map : MapRoot,
    ) : Detached {
        let updated = {
            token with
            detach_epoch = map.detach_epoch;
            root_hash = mapHash(memory, mapRef(map));
            token_fingerprint = EMPTY_BLOB;
        };
        {
            updated with
            token_fingerprint = detachedTokenFingerprint(updated);
        };
    };

    public func attach(memory : Memory, token : Detached) : {
        #ok;
        #err : Error;
    } {
        if (not writable(memory)) return #err(#unhealthy);
        let ?map = detachedMap(memory, token) else return #err(#stale_token);
        if (map.size == 0) return #err(#not_found);
        // Preflight before the first mutation.  `putAt` is also used for
        // replace semantics, while graft must be strictly insert-only so an
        // `#exists` result can never have changed either tree or token.
        switch (
            lookupValueAt(
                memory,
                memory.header.response_root,
                token.absolute_path,
                0,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok(?_)) return #err(#exists);
            case (#ok(null)) {};
        };
        switch (
            preflightPut(
                memory,
                memory.header.response_root,
                token.absolute_path,
                0,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok(requirement)) {
                if (not capacityAvailable(memory, requirement)) {
                    return #err(#capacity);
                };
            };
        };
        switch (
            putAt(
                memory,
                memory.header.response_root,
                token.absolute_path,
                0,
                #subtree(mapRef(map)),
            )
        ) {
            case (#err(error)) {
                Runtime.trap(
                    "Authenticated forest graft diverged from preflight: " #
                    debug_show(error)
                );
            };
            case (#ok(state)) {
                if (not state.inserted) {
                    Runtime.trap(
                        "Authenticated forest graft replaced an existing value"
                    );
                };
                map.attached := true;
                map.detached_path_hash := EMPTY_BLOB;
                memory.dirty := true;
                #ok;
            };
        };
    };

    // Lifecycle cleanup removes leaves through bounded detached point
    // mutations.  Once the detached root is empty, this O(1) finalizer
    // returns its map slot to the arena so repeated retire/install churn
    // reaches a stable high-water mark.
    public func discardDetached(memory : Memory, token : Detached) : {
        #ok;
        #err : Error;
    } {
        if (not writable(memory)) return #err(#unhealthy);
        let ?map = detachedMap(memory, token) else return #err(#stale_token);
        if (map.size != 0 or map.root != NULL_NODE) return #err(#exists);
        map.detached_path_hash := EMPTY_BLOB;
        if (not reclaimMap(memory, token.root)) {
            Runtime.trap(
                "Authenticated forest empty disposal diverged from preflight"
            );
        };
        memory.dirty := true;
        #ok;
    };

    // Atomically disposes a small detached branch, including nested maps.
    // The complete branch is structurally and cryptographically validated
    // before the first slot is reclaimed.  `maxNodes` is an explicit
    // caller-owned work bound; exceeding it leaves the branch untouched.
    public func discardDetachedBounded(
        memory : Memory,
        token : Detached,
        maxNodes : Nat,
    ) : DiscardResult {
        if (not writable(memory)) return #err(#unhealthy);
        let ?map = detachedMap(memory, token) else return #err(#stale_token);
        let scan : DisposalScan = {
            max_nodes = maxNodes;
            var nodes = 0;
            var maps = 0;
            var exceeded = false;
            var corrupt = false;
        };
        scanDiscardMap(memory, mapRef(map), null, scan);
        if (scan.exceeded) return #err(#capacity);
        if (scan.corrupt) return #err(#corrupt);
        if (not destroyDiscardMap(memory, mapRef(map))) {
            Runtime.trap(
                "Authenticated forest bounded disposal diverged from preflight"
            );
        };
        memory.dirty := true;
        #ok({ nodes = scan.nodes; maps = scan.maps });
    };

    public func syncNamedRoot(
        memory : Memory,
        kind : RootKind,
        id : Text,
        path : [Blob],
    ) : NamedRootResult {
        if (not writable(memory)) return #err(#unhealthy);
        if (id.size() == 0 or id.size() > 256 or not validPath(path)) {
            return #err(#invalid_path);
        };
        let rootRefValue = switch (lookupValueAt(memory, memory.header.response_root, path, 0)) {
            case (#err(error)) return #err(error);
            case (#ok(null)) return #err(#not_found);
            case (#ok(?#leaf(_))) return #err(#not_subtree);
            case (#ok(?#subtree(ref))) ref;
        };
        let ?rootMap = getMap(memory, rootRefValue) else return #err(#corrupt);
        let rootValueHash = mapHash(memory, mapRef(rootMap));
        putNamedRootDescriptor(
            memory,
            kind,
            id,
            namedRootValue(path, rootRefValue, rootValueHash),
            rootValueHash,
        );
    };

    // Detached mutations change a named root without an attached path that
    // `syncNamedRoot` could resolve.  Bind the refreshed, authenticated token
    // directly so the catalog descriptor can be updated before grafting.
    public func syncDetachedNamedRoot(
        memory : Memory,
        kind : RootKind,
        id : Text,
        token : Detached,
    ) : NamedRootResult {
        syncDetachedNamedRootAt(memory, kind, id, token, []);
    };

    // Catalog an actual nested subtree while its enclosing mount is detached.
    // `relativePath` is interpreted below the authenticated token root; an
    // empty path retains the original whole-mount behavior.
    public func syncDetachedNamedRootAt(
        memory : Memory,
        kind : RootKind,
        id : Text,
        token : Detached,
        relativePath : [Blob],
    ) : NamedRootResult {
        if (not writable(memory)) return #err(#unhealthy);
        if (
            id.size() == 0 or id.size() > 256 or (
                relativePath.size() > 0 and not validPath(relativePath)
            )
        ) {
            return #err(#invalid_path);
        };
        let ?map = detachedMap(memory, token) else return #err(#stale_token);
        let rootRefValue = if (relativePath.size() == 0) {
            mapRef(map);
        } else {
            switch (
                lookupValueAt(
                    memory,
                    mapRef(map),
                    relativePath,
                    0,
                )
            ) {
                case (#err(error)) return #err(error);
                case (#ok(null)) return #err(#not_found);
                case (#ok(?#leaf(_))) return #err(#not_subtree);
                case (#ok(?#subtree(ref))) ref;
            };
        };
        let ?rootMap = getMap(memory, rootRefValue) else {
            return #err(#corrupt);
        };
        let absolutePath = Array.concat<Blob>(
            token.absolute_path,
            relativePath,
        );
        if (not validPath(absolutePath)) return #err(#invalid_path);
        let rootValueHash = mapHash(memory, rootRefValue);
        putNamedRootDescriptor(
            memory,
            kind,
            id,
            namedRootValue(
                absolutePath,
                rootRefValue,
                rootValueHash,
            ),
            rootValueHash,
        );
    };

    // Read-only semantic audit primitives. Catalogs are never consulted for
    // serving; these compare their opaque descriptors with the authoritative
    // attached/detached response subtree in bounded point-lookup work.
    public func namedRootMatches(
        memory : Memory,
        kind : RootKind,
        id : Text,
        path : [Blob],
    ) : NamedRootMatch {
        if (not readable(memory)) return #err(#unhealthy);
        if (id.size() == 0 or id.size() > 256 or not validPath(path)) {
            return #err(#invalid_path);
        };
        let expected = switch (
            lookupValueAt(
                memory,
                memory.header.response_root,
                path,
                0,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok(null)) null;
            case (#ok(?#leaf(_))) return #err(#not_subtree);
            case (#ok(?#subtree(ref))) {
                let ?root = getMap(memory, ref) else return #err(#corrupt);
                let hash = mapHash(memory, ref);
                ?namedRootValue(path, mapRef(root), hash);
            };
        };
        matchNamedRootDescriptor(memory, kind, id, expected);
    };

    public func detachedNamedRootMatchesAt(
        memory : Memory,
        kind : RootKind,
        id : Text,
        token : Detached,
        relativePath : [Blob],
    ) : NamedRootMatch {
        if (not readable(memory)) return #err(#unhealthy);
        if (
            id.size() == 0 or id.size() > 256 or (
                relativePath.size() > 0 and not validPath(relativePath)
            )
        ) return #err(#invalid_path);
        let ?tokenRoot = detachedMap(memory, token) else {
            return #err(#stale_token);
        };
        let expectedRoot = if (relativePath.size() == 0) {
            ?mapRef(tokenRoot);
        } else {
            switch (
                lookupValueAt(
                    memory,
                    mapRef(tokenRoot),
                    relativePath,
                    0,
                )
            ) {
                case (#err(error)) return #err(error);
                case (#ok(null)) null;
                case (#ok(?#leaf(_))) return #err(#not_subtree);
                case (#ok(?#subtree(ref))) ?ref;
            };
        };
        let absolutePath = Array.concat<Blob>(
            token.absolute_path,
            relativePath,
        );
        if (not validPath(absolutePath)) return #err(#invalid_path);
        let expected = switch (expectedRoot) {
            case null null;
            case (?ref) {
                let ?root = getMap(memory, ref) else return #err(#corrupt);
                let hash = mapHash(memory, ref);
                ?namedRootValue(absolutePath, mapRef(root), hash);
            };
        };
        matchNamedRootDescriptor(memory, kind, id, expected);
    };

    public func catalogSnapshot(memory : Memory) : ?CatalogSnapshot {
        if (not readable(memory)) return null;
        let ?mounts = getMap(
            memory,
            memory.header.mount_catalog_root,
        ) else return null;
        let ?collections = getMap(
            memory,
            memory.header.collection_catalog_root,
        ) else return null;
        ?{
            commit_sequence = memory.header.commit_sequence;
            commit_fingerprint = memory.header.commit_fingerprint;
            mount_roots = mounts.size;
            collection_roots = collections.size;
        };
    };

    func matchNamedRootDescriptor(
        memory : Memory,
        kind : RootKind,
        id : Text,
        expected : ?Blob,
    ) : NamedRootMatch {
        let catalog = switch (kind) {
            case (#mount) memory.header.mount_catalog_root;
            case (#collection) memory.header.collection_catalog_root;
        };
        switch (
            lookupValueAt(
                memory,
                catalog,
                [Text.encodeUtf8(id)],
                0,
            )
        ) {
            case (#err(error)) #err(error);
            case (#ok(?#subtree(_))) #err(#corrupt);
            case (#ok(null)) {
                switch (expected) {
                    case null #absent;
                    case (?_) #mismatch;
                };
            };
            case (#ok(?#leaf(actual))) {
                switch (expected) {
                    case (?value) {
                        if (actual == value) #present else #mismatch;
                    };
                    case null #mismatch;
                };
            };
        };
    };

    func putNamedRootDescriptor(
        memory : Memory,
        kind : RootKind,
        id : Text,
        descriptor : Blob,
        rootValueHash : Blob,
    ) : NamedRootResult {
        let catalog = switch (kind) {
            case (#mount) memory.header.mount_catalog_root;
            case (#collection) memory.header.collection_catalog_root;
        };
        let catalogPath = [Text.encodeUtf8(id)];
        switch (preflightPut(memory, catalog, catalogPath, 0)) {
            case (#err(error)) return #err(error);
            case (#ok(requirement)) {
                if (not capacityAvailable(memory, requirement)) {
                    return #err(#capacity);
                };
            };
        };
        switch (
            putAt(
                memory,
                catalog,
                catalogPath,
                0,
                #leaf(descriptor),
            )
        ) {
            case (#err(error)) {
                Runtime.trap(
                    "Authenticated forest detach diverged from preflight: " #
                    debug_show(error)
                );
            };
            case (#ok(_)) {
                memory.dirty := true;
                #ok(rootValueHash);
            };
        };
    };

    public func removeNamedRoot(
        memory : Memory,
        kind : RootKind,
        id : Text,
    ) : {
        #ok : Bool;
        #err : Error;
    } {
        if (not writable(memory)) return #err(#unhealthy);
        if (id.size() == 0 or id.size() > 256) {
            return #err(#invalid_path);
        };
        let catalog = switch (kind) {
            case (#mount) memory.header.mount_catalog_root;
            case (#collection) memory.header.collection_catalog_root;
        };
        let catalogPath = [Text.encodeUtf8(id)];
        switch (lookupValueAt(memory, catalog, catalogPath, 0)) {
            case (#err(error)) return #err(error);
            case (#ok(null)) return #ok(false);
            case (#ok(?#subtree(_))) return #err(#not_subtree);
            case (#ok(?#leaf(_))) {};
        };
        switch (
            deleteAt(
                memory,
                catalog,
                catalogPath,
                0,
                false,
            )
        ) {
            case (#err(error)) {
                Runtime.trap(
                    "Authenticated named-root delete diverged from preflight: " #
                    debug_show(error)
                );
            };
            case (#ok(null)) {
                Runtime.trap(
                    "Authenticated named-root preflight leaf vanished"
                );
            };
            case (#ok(?_)) {
                memory.dirty := true;
                #ok(true);
            };
        };
    };

    public func commit(memory : Memory) : CommitResult {
        if (not writable(memory)) return #err(#unhealthy);
        let prior = memory.header.response_root_hash;
        if (memory.dirty) {
            refreshHeader(memory, true);
            memory.dirty := false;
        };
        if (
            not shallowValid(
                memory,
                memory.header.response_policy_table_fingerprint,
                memory.header.allocator_layout_fingerprint,
            )
        ) {
            memory.header.healthy := false;
            return #err(#corrupt);
        };
        #ok({
            attached_root_changed = prior != memory.header.response_root_hash;
            response_root_hash = memory.header.response_root_hash;
            commit_sequence = memory.header.commit_sequence;
            commit_fingerprint = memory.header.commit_fingerprint;
            live_nodes = memory.header.live_nodes;
            allocated_nodes = memory.header.allocated_nodes;
            free_nodes = memory.header.free_nodes;
            live_maps = memory.header.live_maps;
            allocated_maps = memory.header.allocated_maps;
            free_maps = memory.header.free_maps;
        });
    };

    public func validateAndRestore(
        memory : Memory,
        expectedResponsePolicyTableCanonical : Blob,
        expectedAllocatorLayoutFingerprint : Blob,
    ) : RestoreResult {
        let expectedResponsePolicyTableFingerprint = SHA256.fromBlob(
            #sha256,
            expectedResponsePolicyTableCanonical,
        );
        if (
            memory.dirty or
            memory.header.response_policy_table_canonical !=
                expectedResponsePolicyTableCanonical or
            not shallowValid(
                memory,
                expectedResponsePolicyTableFingerprint,
                expectedAllocatorLayoutFingerprint,
            )
        ) {
            memory.header.healthy := false;
            return #err(#corrupt);
        };
        memory.header.healthy := true;
        #ok({
            response_root_hash = memory.header.response_root_hash;
            commit_fingerprint = memory.header.commit_fingerprint;
        });
    };

    public func initialAuditCursor(memory : Memory) : AuditCursor {
        {
            phase = #node_slots;
            next_slot = 1;
            next_free = NULL_NODE;
            live_nodes_seen = 0;
            free_nodes_seen = 0;
            linked_free_nodes_seen = 0;
            live_maps_seen = 0;
            free_maps_seen = 0;
            linked_free_maps_seen = 0;
            commit_sequence = memory.header.commit_sequence;
            commit_fingerprint = memory.header.commit_fingerprint;
            next_node_id = memory.next_node_id;
            next_map_id = memory.next_map_id;
            free_node_head = memory.free_node;
            free_map_head = memory.free_map;
            live_nodes = memory.header.live_nodes;
            allocated_nodes = memory.header.allocated_nodes;
            free_nodes = memory.header.free_nodes;
            live_maps = memory.header.live_maps;
            allocated_maps = memory.header.allocated_maps;
            free_maps = memory.header.free_maps;
            deep_map_id = 1;
            deep_nodes_seen = 0;
            deep_state = #idle;
        };
    };

    // A bounded, resumable allocation/local-invariant audit.  It never runs
    // during upgrade or HTTP serving.  `deepValidate` additionally checks
    // complete black-height and cardinality invariants for tests/maintenance.
    public func auditStep(
        memory : Memory,
        cursor : AuditCursor,
        budget : Nat,
    ) : AuditStep {
        if (not auditSnapshotCurrent(memory, cursor)) return #stale;
        if (not memory.header.healthy or not fastHeaderValid(memory)) {
            return #err(#corrupt);
        };
        if (budget == 0) return #more(cursor);
        var phase = cursor.phase;
        var nextSlot = cursor.next_slot;
        var nextFree = cursor.next_free;
        var liveNodes = cursor.live_nodes_seen;
        var freeNodes = cursor.free_nodes_seen;
        var linkedFreeNodes = cursor.linked_free_nodes_seen;
        var liveMaps = cursor.live_maps_seen;
        var freeMaps = cursor.free_maps_seen;
        var linkedFreeMaps = cursor.linked_free_maps_seen;
        var deepMapId = cursor.deep_map_id;
        var deepNodes = cursor.deep_nodes_seen;
        var deepState = cursor.deep_state;
        var left = budget;
        while (left > 0) {
            switch (phase) {
                case (#node_slots) {
                    if (nextSlot >= cursor.next_node_id) {
                        if (
                            liveNodes != cursor.live_nodes or
                            freeNodes != cursor.free_nodes
                        ) return #err(#corrupt);
                        phase := #node_free;
                        nextFree := cursor.free_node_head;
                    } else {
                        switch (getNodeSlot(memory, nextSlot)) {
                            case null return #err(#corrupt);
                            case (?node) {
                                if (node.in_use) {
                                    if (not localNodeValid(memory, node)) {
                                        return #err(#corrupt);
                                    };
                                    liveNodes += 1;
                                } else {
                                    if (
                                        not freeNodeTombstoneValid(
                                            node,
                                            cursor.next_node_id,
                                        )
                                    ) return #err(#corrupt);
                                    freeNodes += 1;
                                };
                            };
                        };
                        nextSlot += 1;
                        left -= 1;
                    };
                };
                case (#node_free) {
                    if (nextFree == NULL_NODE) {
                        if (linkedFreeNodes != freeNodes) {
                            return #err(#corrupt);
                        };
                        phase := #map_slots;
                        nextSlot := 1;
                    } else {
                        if (linkedFreeNodes >= freeNodes) {
                            return #err(#corrupt);
                        };
                        let ?node = getNodeSlot(memory, nextFree) else {
                            return #err(#corrupt);
                        };
                        if (
                            not freeNodeTombstoneValid(
                                node,
                                cursor.next_node_id,
                            )
                        ) return #err(#corrupt);
                        nextFree := node.free_next;
                        linkedFreeNodes += 1;
                        left -= 1;
                    };
                };
                case (#map_slots) {
                    if (nextSlot >= cursor.next_map_id) {
                        if (
                            liveMaps != cursor.live_maps or
                            freeMaps != cursor.free_maps
                        ) return #err(#corrupt);
                        phase := #map_free;
                        nextFree := cursor.free_map_head;
                    } else {
                        switch (getMapSlot(memory, nextSlot)) {
                            case null return #err(#corrupt);
                            case (?map) {
                                if (map.in_use) {
                                    if (not localMapValid(memory, map)) {
                                        return #err(#corrupt);
                                    };
                                    liveMaps += 1;
                                } else {
                                    if (
                                        not freeMapTombstoneValid(
                                            map,
                                            cursor.next_map_id,
                                        )
                                    ) return #err(#corrupt);
                                    freeMaps += 1;
                                };
                            };
                        };
                        nextSlot += 1;
                        left -= 1;
                    };
                };
                case (#map_free) {
                    if (nextFree == NULL_MAP) {
                        if (linkedFreeMaps != freeMaps) {
                            return #err(#corrupt);
                        };
                        phase := #deep_maps;
                    } else {
                        if (linkedFreeMaps >= freeMaps) {
                            return #err(#corrupt);
                        };
                        let ?map = getMapSlot(memory, nextFree) else {
                            return #err(#corrupt);
                        };
                        if (
                            not freeMapTombstoneValid(
                                map,
                                cursor.next_map_id,
                            )
                        ) return #err(#corrupt);
                        nextFree := map.free_next;
                        linkedFreeMaps += 1;
                        left -= 1;
                    };
                };
                case (#deep_maps) {
                    switch (
                        deepAuditStep(
                            memory,
                            cursor,
                            deepMapId,
                            deepNodes,
                            deepState,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#complete) {
                            phase := #complete;
                        };
                        case (#next(next)) {
                            deepMapId := next.map_id;
                            deepNodes := next.nodes_seen;
                            deepState := next.state;
                        };
                    };
                    left -= 1;
                };
                case (#complete) {
                    if (not auditSnapshotCurrent(memory, cursor)) {
                        return #stale;
                    };
                    if (
                        not memory.header.healthy or
                        not fastHeaderValid(memory)
                    ) return #err(#corrupt);
                    return #complete;
                };
            };
        };
        #more({
            phase;
            next_slot = nextSlot;
            next_free = nextFree;
            live_nodes_seen = liveNodes;
            free_nodes_seen = freeNodes;
            linked_free_nodes_seen = linkedFreeNodes;
            live_maps_seen = liveMaps;
            free_maps_seen = freeMaps;
            linked_free_maps_seen = linkedFreeMaps;
            commit_sequence = cursor.commit_sequence;
            commit_fingerprint = cursor.commit_fingerprint;
            next_node_id = cursor.next_node_id;
            next_map_id = cursor.next_map_id;
            free_node_head = cursor.free_node_head;
            free_map_head = cursor.free_map_head;
            live_nodes = cursor.live_nodes;
            allocated_nodes = cursor.allocated_nodes;
            free_nodes = cursor.free_nodes;
            live_maps = cursor.live_maps;
            allocated_maps = cursor.allocated_maps;
            free_maps = cursor.free_maps;
            deep_map_id = deepMapId;
            deep_nodes_seen = deepNodes;
            deep_state = deepState;
        });
    };

    type DeepAuditNext = {
        map_id : MapId;
        nodes_seen : Nat;
        state : AuditDeepState;
    };
    type DeepAuditStep = {
        #next : DeepAuditNext;
        #complete;
        #err : Error;
    };
    type TreeAuditStep = {
        #next : AuditTreeCursor;
        #complete : AuditTreeState;
        #err : Error;
    };

    func deepAuditStep(
        memory : Memory,
        snapshot : AuditCursor,
        mapId : MapId,
        nodesSeen : Nat,
        state : AuditDeepState,
    ) : DeepAuditStep {
        switch (state) {
            case (#idle) {
                if (mapId >= snapshot.next_map_id) {
                    if (nodesSeen != snapshot.live_nodes) {
                        return #err(#corrupt);
                    };
                    return #complete;
                };
                let ?map = getMapSlot(memory, mapId) else {
                    return #err(#corrupt);
                };
                if (not map.in_use) {
                    return #next({
                        map_id = mapId + 1;
                        nodes_seen = nodesSeen;
                        state = #idle;
                    });
                };
                if (not mapLinkValid(memory, map)) return #err(#corrupt);
                let ref = mapRef(map);
                #next({
                    map_id = mapId;
                    nodes_seen = nodesSeen;
                    state = #ancestry({
                        target = ref;
                        current = ref;
                        depth = 0;
                    });
                });
            };
            case (#ancestry(chain)) {
                let ?current = getMap(memory, chain.current) else {
                    return #err(#corrupt);
                };
                if (not mapLinkValid(memory, current)) {
                    return #err(#corrupt);
                };
                if (isAuditRoot(memory, current)) {
                    let ?target = getMap(memory, chain.target) else {
                        return #err(#corrupt);
                    };
                    return #next({
                        map_id = mapId;
                        nodes_seen = nodesSeen;
                        state = #tree({
                            map = chain.target;
                            expected_size = target.size;
                            depth_bound = redBlackDepthBound(target.size);
                            stack = [{
                                node = target.root;
                                lower = null;
                                upper = null;
                                stage = #enter;
                            }];
                            value = null;
                            visited = 0;
                        });
                    });
                };
                if (
                    chain.depth >= MAX_PATH_LABELS or
                    current.parent_map.id == NULL_MAP
                ) return #err(#corrupt);
                #next({
                    map_id = mapId;
                    nodes_seen = nodesSeen;
                    state = #ancestry({
                        target = chain.target;
                        current = current.parent_map;
                        depth = chain.depth + 1;
                    });
                });
            };
            case (#tree(tree)) {
                switch (treeAuditStep(memory, tree)) {
                    case (#err(error)) #err(error);
                    case (#next(next)) #next({
                        map_id = mapId;
                        nodes_seen = nodesSeen;
                        state = #tree(next);
                    });
                    case (#complete(result)) {
                        let ?map = getMap(memory, tree.map) else {
                            return #err(#corrupt);
                        };
                        if (
                            result.count != map.size or
                            tree.visited != result.count or
                            result.hash != mapHash(memory, tree.map) or
                            nodesSeen + result.count > snapshot.live_nodes
                        ) return #err(#corrupt);
                        #next({
                            map_id = mapId + 1;
                            nodes_seen = nodesSeen + result.count;
                            state = #idle;
                        });
                    };
                };
            };
        };
    };

    func isAuditRoot(memory : Memory, map : MapRoot) : Bool {
        let ref = mapRef(map);
        if (
            ref == memory.header.response_root or
            ref == memory.header.mount_catalog_root or
            ref == memory.header.collection_catalog_root
        ) return true;
        map.parent_map.id == NULL_MAP and not map.attached and
        map.parent_node == NULL_NODE and
        map.detached_path_hash.size() == 32;
    };

    func treeAuditStep(
        memory : Memory,
        cursor : AuditTreeCursor,
    ) : TreeAuditStep {
        if (cursor.stack.size() == 0) {
            switch (cursor.value) {
                case (?value) return #complete(value);
                case null return #err(#corrupt);
            };
        };
        let index = cursor.stack.size() - 1;
        let frame = cursor.stack[index];
        switch (frame.stage) {
            case (#enter) {
                if (cursor.value != null) return #err(#corrupt);
                if (frame.node == NULL_NODE) {
                    return #next({
                        cursor with
                        stack = dropLast(cursor.stack);
                        value = ?emptyAuditTreeState();
                    });
                };
                if (
                    cursor.stack.size() > MAX_AUDIT_STACK or
                    cursor.stack.size() > cursor.depth_bound
                ) return #err(#corrupt);
                let ?node = checkedNode(memory, cursor.map, frame.node) else {
                    return #err(#corrupt);
                };
                if (not localNodeValid(memory, node)) return #err(#corrupt);
                switch (frame.lower) {
                    case (?bound) {
                        if (Blob.compare(bound, node.key) != #less) {
                            return #err(#corrupt);
                        };
                    };
                    case null {};
                };
                switch (frame.upper) {
                    case (?bound) {
                        if (Blob.compare(node.key, bound) != #less) {
                            return #err(#corrupt);
                        };
                    };
                    case null {};
                };
                let waiting = {
                    frame with stage = #await_left;
                };
                #next({
                    cursor with
                    stack = pushFrame(
                        replaceLast(cursor.stack, waiting),
                        {
                            node = node.left;
                            lower = frame.lower;
                            upper = ?node.key;
                            stage = #enter;
                        },
                    );
                    visited = cursor.visited + 1;
                });
            };
            case (#await_left) {
                let ?left = cursor.value else return #err(#corrupt);
                let ?node = getNode(memory, frame.node) else {
                    return #err(#corrupt);
                };
                #next({
                    cursor with
                    stack = pushFrame(
                        replaceLast(
                            cursor.stack,
                            { frame with stage = #await_right(left) },
                        ),
                        {
                            node = node.right;
                            lower = ?node.key;
                            upper = frame.upper;
                            stage = #enter;
                        },
                    );
                    value = null;
                });
            };
            case (#await_right(left)) {
                let ?right = cursor.value else return #err(#corrupt);
                let ?node = checkedNode(memory, cursor.map, frame.node) else {
                    return #err(#corrupt);
                };
                if (left.black_height != right.black_height) {
                    return #err(#corrupt);
                };
                let hash = switch (node.left, node.right) {
                    case (0, 0) node.data_hash;
                    case (0, _) forkHash(node.data_hash, right.hash);
                    case (_, 0) forkHash(left.hash, node.data_hash);
                    case (_, _) forkHash(
                        left.hash,
                        forkHash(node.data_hash, right.hash),
                    );
                };
                if (hash != node.subtree_hash) return #err(#corrupt);
                #next({
                    cursor with
                    stack = dropLast(cursor.stack);
                    value = ?{
                        count = left.count + 1 + right.count;
                        black_height = left.black_height + (
                            if (node.color == #black) 1 else 0
                        );
                        hash;
                    };
                });
            };
        };
    };

    func emptyAuditTreeState() : AuditTreeState {
        { count = 0; black_height = 1; hash = emptyHash() };
    };

    func replaceLast<T>(values : [T], value : T) : [T] {
        Array.tabulate<T>(
            values.size(),
            func(index) {
                if (index + 1 == values.size()) value else values[index];
            },
        );
    };

    func pushFrame(
        values : [AuditTreeFrame],
        value : AuditTreeFrame,
    ) : [AuditTreeFrame] {
        Array.tabulate<AuditTreeFrame>(
            values.size() + 1,
            func(index) {
                if (index == values.size()) value else values[index];
            },
        );
    };

    func dropLast<T>(values : [T]) : [T] {
        Array.tabulate<T>(values.size() - 1, func(index) { values[index] });
    };

    func auditSnapshotCurrent(
        memory : Memory,
        cursor : AuditCursor,
    ) : Bool {
        not memory.dirty and
        memory.header.commit_sequence == cursor.commit_sequence and
        memory.header.commit_fingerprint == cursor.commit_fingerprint and
        memory.next_node_id == cursor.next_node_id and
        memory.next_map_id == cursor.next_map_id and
        memory.free_node == cursor.free_node_head and
        memory.free_map == cursor.free_map_head and
        memory.header.live_nodes == cursor.live_nodes and
        memory.header.allocated_nodes == cursor.allocated_nodes and
        memory.header.free_nodes == cursor.free_nodes and
        memory.header.live_maps == cursor.live_maps and
        memory.header.allocated_maps == cursor.allocated_maps and
        memory.header.free_maps == cursor.free_maps and
        cursor.allocated_nodes + 1 == cursor.next_node_id and
        cursor.allocated_maps + 1 == cursor.next_map_id;
    };

    func freeNodeTombstoneValid(
        node : Node,
        nextNodeId : NodeId,
    ) : Bool {
        not node.in_use and node.map_id == NULL_MAP and
        node.key.size() == 0 and node.key_hash.size() == 0 and
        (
            switch (node.value) {
                case (#leaf(blob)) blob.size() == 0;
                case (#subtree(_)) false;
            }
        ) and
        node.value_hash.size() == 0 and node.data_hash.size() == 0 and
        node.color == #black and node.left == NULL_NODE and
        node.right == NULL_NODE and node.subtree_hash.size() == 0 and
        (node.free_next == NULL_NODE or node.free_next < nextNodeId);
    };

    func freeMapTombstoneValid(
        map : MapRoot,
        nextMapId : MapId,
    ) : Bool {
        not map.in_use and map.root == NULL_NODE and map.size == 0 and
        map.parent_map == ZERO_REF and map.parent_node == NULL_NODE and
        not map.attached and map.detached_path_hash.size() == 0 and
        (map.free_next == NULL_MAP or map.free_next < nextMapId);
    };

    public func deepValidate(memory : Memory) : Bool {
        if (
            not shallowValid(
                memory,
                memory.header.response_policy_table_fingerprint,
                memory.header.allocator_layout_fingerprint,
            )
        ) {
            return false;
        };
        var mapId = 1;
        var liveMaps = 0;
        var liveNodes = 0;
        while (mapId < memory.next_map_id) {
            let ?map = getMapSlot(memory, mapId) else return false;
            if (map.in_use) {
                if (not mapLinkValid(memory, map)) return false;
                liveMaps += 1;
                switch (validateTree(memory, mapRef(map), map.root, null, null)) {
                    case null return false;
                    case (?state) {
                        if (state.count != map.size) return false;
                        liveNodes += state.count;
                    };
                };
            };
            mapId += 1;
        };
        liveMaps == memory.header.live_maps and
        liveNodes == memory.header.live_nodes;
    };

    public func maximumDepth(memory : Memory, map : MapRef) : ?Nat {
        let ?root = getMap(memory, map) else return null;
        ?treeDepth(memory, root.root);
    };

    public func redBlackDepthBound(entries : Nat) : Nat {
        if (entries == 0) return 0;
        2 * ceilLog2(entries + 1);
    };

    // ------------------------------------------------------------------
    // Nested path operations
    // ------------------------------------------------------------------

    type PutState = {
        inserted : Bool;
        prior : ?Value;
    };
    type InternalPutResult = { #ok : PutState; #err : Error };
    type InternalDeleteResult = { #ok : ?Value; #err : Error };
    type ValueLookup = { #ok : ?Value; #err : Error };
    type InternalWitness = {
        lookup : LookupResult;
        witness : MerkleTree.Witness;
    };
    type InternalWitnessResult = { #ok : InternalWitness; #err : Error };

    func putAt(
        memory : Memory,
        mapRefValue : MapRef,
        path : [Blob],
        index : Nat,
        finalValue : Value,
    ) : InternalPutResult {
        let ?map = getMap(memory, mapRefValue) else return #err(#corrupt);
        let keyLabel = path[index];
        if (index + 1 == path.size()) {
            let prior = lookupMapValue(memory, mapRefValue, keyLabel);
            switch (prior) {
                case (#err(error)) return #err(error);
                case _ {};
            };
            let priorValue = switch (prior) {
                case (#ok(value)) value;
                case _ null;
            };
            switch (priorValue) {
                case (?#subtree(_)) return #err(#exists);
                case _ {};
            };
            switch (insertMap(memory, mapRefValue, keyLabel, finalValue)) {
                case (#err(error)) #err(error);
                case (#ok(inserted)) {
                    if (index == 0) propagateParent(memory, map);
                    #ok({ inserted; prior = priorValue });
                };
            };
        } else {
            let child = switch (lookupMapValue(memory, mapRefValue, keyLabel)) {
                case (#err(error)) return #err(error);
                case (#ok(?#leaf(_))) return #err(#exists);
                case (#ok(?#subtree(ref))) {
                    let ?childMap = getMap(memory, ref) else return #err(#corrupt);
                    ref;
                };
                case (#ok(null)) {
                    let ?newMap = allocateMap(memory) else return #err(#capacity);
                    switch (insertMap(memory, mapRefValue, keyLabel, #subtree(newMap))) {
                        case (#err(error)) {
                            ignore reclaimMap(memory, newMap);
                            return #err(error);
                        };
                        case (#ok(_)) {};
                    };
                    let ?nodeId = lookupNodeId(memory, mapRefValue, keyLabel) else {
                        return #err(#corrupt);
                    };
                    let ?childMap = getMap(memory, newMap) else return #err(#corrupt);
                    childMap.parent_map := mapRefValue;
                    childMap.parent_node := nodeId;
                    childMap.attached := true;
                    newMap;
                };
            };
            let result = putAt(memory, child, path, index + 1, finalValue);
            switch (result) {
                case (#err(error)) #err(error);
                case (#ok(state)) {
                    if (not refreshNodeAndAncestors(memory, mapRefValue, keyLabel)) {
                        return #err(#corrupt);
                    };
                    if (index == 0) propagateParent(memory, map);
                    #ok(state);
                };
            };
        };
    };

    func deleteAt(
        memory : Memory,
        mapRefValue : MapRef,
        path : [Blob],
        index : Nat,
        permitSubtree : Bool,
    ) : InternalDeleteResult {
        let ?map = getMap(memory, mapRefValue) else return #err(#corrupt);
        let keyLabel = path[index];
        if (index + 1 == path.size()) {
            let prior = switch (lookupMapValue(memory, mapRefValue, keyLabel)) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            let ?value = prior else return #ok(null);
            switch (value) {
                case (#subtree(_)) {
                    if (not permitSubtree) return #err(#not_subtree);
                };
                case _ {};
            };
            switch (deleteMap(memory, mapRefValue, keyLabel, true)) {
                case (#err(error)) #err(error);
                case (#ok(_)) {
                    if (index == 0) propagateParent(memory, map);
                    #ok(?value);
                };
            };
        } else {
            let child = switch (lookupMapValue(memory, mapRefValue, keyLabel)) {
                case (#err(error)) return #err(error);
                case (#ok(null)) return #ok(null);
                case (#ok(?#leaf(_))) return #ok(null);
                case (#ok(?#subtree(ref))) ref;
            };
            let result = deleteAt(memory, child, path, index + 1, permitSubtree);
            switch (result) {
                case (#err(error)) #err(error);
                case (#ok(null)) #ok(null);
                case (#ok(value)) {
                    let ?childMap = getMap(memory, child) else return #err(#corrupt);
                    // The child's hash changed before this parent mutation.
                    // Refresh the exact parent-node path once so deleteMap's
                    // strict cached-hash validation sees the new child hash.
                    if (
                        not refreshNodeAndAncestors(
                            memory,
                            mapRefValue,
                            keyLabel,
                        )
                    ) return #err(#corrupt);
                    if (childMap.size == 0) {
                        switch (deleteMap(memory, mapRefValue, keyLabel, true)) {
                            case (#err(error)) return #err(error);
                            case (#ok(_)) {};
                        };
                        childMap.parent_map := ZERO_REF;
                        childMap.parent_node := NULL_NODE;
                        childMap.attached := false;
                        if (not reclaimMap(memory, child)) return #err(#corrupt);
                    };
                    if (index == 0) propagateParent(memory, map);
                    #ok(value);
                };
            };
        };
    };

    func detachAt(
        memory : Memory,
        mapRefValue : MapRef,
        path : [Blob],
        index : Nat,
    ) : { #ok : MapRef; #err : Error } {
        let ?map = getMap(memory, mapRefValue) else return #err(#corrupt);
        let keyLabel = path[index];
        if (index + 1 == path.size()) {
            let value = switch (lookupMapValue(memory, mapRefValue, keyLabel)) {
                case (#err(error)) return #err(error);
                case (#ok(null)) return #err(#not_found);
                case (#ok(?#leaf(_))) return #err(#not_subtree);
                case (#ok(?#subtree(ref))) ref;
            };
            switch (deleteMap(memory, mapRefValue, keyLabel, true)) {
                case (#err(error)) #err(error);
                case (#ok(_)) {
                    if (index == 0) propagateParent(memory, map);
                    #ok(value);
                };
            };
        } else {
            let child = switch (lookupMapValue(memory, mapRefValue, keyLabel)) {
                case (#err(error)) return #err(error);
                case (#ok(null)) return #err(#not_found);
                case (#ok(?#leaf(_))) return #err(#not_subtree);
                case (#ok(?#subtree(ref))) ref;
            };
            switch (detachAt(memory, child, path, index + 1)) {
                case (#err(error)) #err(error);
                case (#ok(detached)) {
                    let ?childMap = getMap(memory, child) else return #err(#corrupt);
                    // As in deleteAt, synchronize the parent node before a
                    // possible strict delete of the now-empty child map.
                    if (
                        not refreshNodeAndAncestors(
                            memory,
                            mapRefValue,
                            keyLabel,
                        )
                    ) return #err(#corrupt);
                    if (childMap.size == 0) {
                        switch (deleteMap(memory, mapRefValue, keyLabel, true)) {
                            case (#err(error)) return #err(error);
                            case (#ok(_)) {};
                        };
                        childMap.parent_map := ZERO_REF;
                        childMap.parent_node := NULL_NODE;
                        childMap.attached := false;
                        if (not reclaimMap(memory, child)) return #err(#corrupt);
                    };
                    if (index == 0) propagateParent(memory, map);
                    #ok(detached);
                };
            };
        };
    };

    func lookupAt(
        memory : Memory,
        mapRefValue : MapRef,
        path : [Blob],
        index : Nat,
    ) : LookupResult {
        switch (lookupMapValue(memory, mapRefValue, path[index])) {
            case (#err(error)) #err(error);
            case (#ok(null)) #absent;
            case (#ok(?#leaf(value))) {
                if (index + 1 == path.size()) #found(value) else #absent;
            };
            case (#ok(?#subtree(child))) {
                if (index + 1 == path.size()) #absent else {
                    lookupAt(memory, child, path, index + 1);
                };
            };
        };
    };

    func lookupValueAt(
        memory : Memory,
        mapRefValue : MapRef,
        path : [Blob],
        index : Nat,
    ) : ValueLookup {
        switch (lookupMapValue(memory, mapRefValue, path[index])) {
            case (#err(error)) #err(error);
            case (#ok(null)) #ok(null);
            case (#ok(?value)) {
                if (index + 1 == path.size()) return #ok(?value);
                switch (value) {
                    case (#leaf(_)) #ok(null);
                    case (#subtree(child)) {
                        lookupValueAt(memory, child, path, index + 1);
                    };
                };
            };
        };
    };

    func witnessAt(
        memory : Memory,
        mapRefValue : MapRef,
        path : [Blob],
        index : Nat,
    ) : InternalWitnessResult {
        let keyLabel = path[index];
        switch (lookupMapValue(memory, mapRefValue, keyLabel)) {
            case (#err(error)) #err(error);
            case (#ok(null)) {
                switch (mapAbsenceWitness(memory, mapRefValue, keyLabel)) {
                    case null #err(#corrupt);
                    case (?tree) #ok({ lookup = #absent; witness = tree });
                };
            };
            case (#ok(?#leaf(value))) {
                if (index + 1 != path.size()) return #err(#not_found);
                let inner : MerkleTree.Witness =
                    countWitness(memory, #leaf(value));
                switch (mapMembershipWitness(memory, mapRefValue, keyLabel, inner)) {
                    case null #err(#corrupt);
                    case (?tree) #ok({
                        lookup = #found(value);
                        witness = tree;
                    });
                };
            };
            case (#ok(?#subtree(child))) {
                if (index + 1 == path.size()) return #err(#not_subtree);
                let childResult : InternalWitness = switch (
                    witnessAt(memory, child, path, index + 1)
                ) {
                    case (#err(error)) return #err(error);
                    case (#ok(result)) result;
                };
                switch (
                    mapMembershipWitness(
                        memory,
                        mapRefValue,
                        keyLabel,
                        childResult.witness,
                    )
                ) {
                    case null #err(#corrupt);
                    case (?tree) #ok({
                        lookup = childResult.lookup;
                        witness = tree;
                    });
                };
            };
        };
    };

    // ------------------------------------------------------------------
    // Arena-backed LLRB
    // ------------------------------------------------------------------

    type BoolResult = { #ok : Bool; #err : Error };
    type NodeDeleteResult = { #ok : NodeId; #err : Error };
    type MinResult = {
        root : NodeId;
        key : Blob;
        value : Value;
    };

    func insertMap(
        memory : Memory,
        mapRefValue : MapRef,
        key : Blob,
        value : Value,
    ) : BoolResult {
        let ?map = getMap(memory, mapRefValue) else return #err(#corrupt);
        let existed = switch (lookupNodeId(memory, mapRefValue, key)) {
            case null false;
            case (?_) true;
        };
        switch (insertNode(memory, mapRefValue, map.root, key, value)) {
            case (#err(error)) #err(error);
            case (#ok(root)) {
                map.root := root;
                let ?rootNode = getNode(memory, root) else return #err(#corrupt);
                rootNode.color := #black;
                updateNodeHash(memory, rootNode);
                if (not existed) map.size += 1;
                #ok(not existed);
            };
        };
    };

    func insertNode(
        memory : Memory,
        mapRefValue : MapRef,
        root : NodeId,
        key : Blob,
        value : Value,
    ) : NodeDeleteResult {
        if (root == NULL_NODE) {
            let ?node = allocateNode(memory, mapRefValue.id, key, value) else {
                return #err(#capacity);
            };
            attachChildValue(memory, mapRefValue, node, value);
            return #ok(node);
        };
        let ?node = checkedNode(memory, mapRefValue, root) else return #err(#corrupt);
        memory.counters.node_visits += 1;
        switch (Blob.compare(key, node.key)) {
            case (#equal) {
                if (not detachPriorValue(memory, node.value, value)) {
                    return #err(#corrupt);
                };
                node.value := value;
                node.value_hash := valueHash(memory, value);
                attachChildValue(memory, mapRefValue, node.id, value);
            };
            case (#less) {
                switch (insertNode(memory, mapRefValue, node.left, key, value)) {
                    case (#err(error)) return #err(error);
                    case (#ok(next)) node.left := next;
                };
            };
            case (#greater) {
                switch (insertNode(memory, mapRefValue, node.right, key, value)) {
                    case (#err(error)) return #err(error);
                    case (#ok(next)) node.right := next;
                };
            };
        };
        updateNodeHash(memory, node);
        #ok(balance(memory, mapRefValue, node.id));
    };

    func deleteMap(
        memory : Memory,
        mapRefValue : MapRef,
        key : Blob,
        preserveValue : Bool,
    ) : NodeDeleteResult {
        let ?map = getMap(memory, mapRefValue) else return #err(#corrupt);
        let ?existing = lookupNodeId(memory, mapRefValue, key) else {
            return #ok(NULL_NODE);
        };
        if (map.root == NULL_NODE) return #err(#corrupt);
        let ?root = checkedNode(memory, mapRefValue, map.root) else {
            return #err(#corrupt);
        };
        if (not isRed(memory, root.left) and not isRed(memory, root.right)) {
            root.color := #red;
        };
        switch (
            deleteNode(
                memory,
                mapRefValue,
                map.root,
                key,
                preserveValue,
            )
        ) {
            case (#err(error)) #err(error);
            case (#ok(nextRoot)) {
                map.root := nextRoot;
                if (nextRoot != NULL_NODE) {
                    let ?next = getNode(memory, nextRoot) else return #err(#corrupt);
                    next.color := #black;
                    updateNodeHash(memory, next);
                };
                map.size -= 1;
                #ok(existing);
            };
        };
    };

    func deleteNode(
        memory : Memory,
        mapRefValue : MapRef,
        root : NodeId,
        key : Blob,
        preserveValue : Bool,
    ) : NodeDeleteResult {
        let ?original = checkedNode(memory, mapRefValue, root) else {
            return #err(#corrupt);
        };
        memory.counters.node_visits += 1;
        var hId = original.id;
        var h = original;
        if (Blob.compare(key, h.key) == #less) {
            if (h.left == NULL_NODE) return #err(#corrupt);
            let ?left = checkedNode(memory, mapRefValue, h.left) else {
                return #err(#corrupt);
            };
            if (not isRed(memory, h.left) and not isRed(memory, left.left)) {
                let ?moved = moveRedLeft(memory, mapRefValue, hId) else {
                    return #err(#corrupt);
                };
                hId := moved;
                let ?updated = checkedNode(memory, mapRefValue, hId) else {
                    return #err(#corrupt);
                };
                h := updated;
            };
            switch (
                deleteNode(memory, mapRefValue, h.left, key, preserveValue)
            ) {
                case (#err(error)) return #err(error);
                case (#ok(next)) h.left := next;
            };
        } else {
            if (isRed(memory, h.left)) {
                let ?rotated = rotateRight(memory, mapRefValue, hId) else {
                    return #err(#corrupt);
                };
                hId := rotated;
                let ?updated = checkedNode(memory, mapRefValue, hId) else {
                    return #err(#corrupt);
                };
                h := updated;
            };
            if (
                Blob.compare(key, h.key) == #equal and
                h.right == NULL_NODE
            ) {
                if (h.left != NULL_NODE) return #err(#corrupt);
                if (not preserveValue) detachValue(memory, h.value);
                recycleNode(memory, h);
                return #ok(NULL_NODE);
            };
            if (h.right == NULL_NODE) return #err(#corrupt);
            let ?right = checkedNode(memory, mapRefValue, h.right) else {
                return #err(#corrupt);
            };
            if (not isRed(memory, h.right) and not isRed(memory, right.left)) {
                let ?moved = moveRedRight(memory, mapRefValue, hId) else {
                    return #err(#corrupt);
                };
                hId := moved;
                let ?updated = checkedNode(memory, mapRefValue, hId) else {
                    return #err(#corrupt);
                };
                h := updated;
            };
            if (Blob.compare(key, h.key) == #equal) {
                let prior = h.value;
                let ?minimum = takeMin(memory, mapRefValue, h.right) else {
                    return #err(#corrupt);
                };
                if (not preserveValue) detachValue(memory, prior);
                h.key := minimum.key;
                h.key_hash := canonicalKeyHash(minimum.key);
                h.value := minimum.value;
                h.value_hash := valueHash(memory, minimum.value);
                h.right := minimum.root;
                attachChildValue(memory, mapRefValue, h.id, minimum.value);
            } else {
                switch (
                    deleteNode(
                        memory,
                        mapRefValue,
                        h.right,
                        key,
                        preserveValue,
                    )
                ) {
                    case (#err(error)) return #err(error);
                    case (#ok(next)) h.right := next;
                };
            };
        };
        updateNodeHash(memory, h);
        #ok(balance(memory, mapRefValue, h.id));
    };

    func takeMin(
        memory : Memory,
        mapRefValue : MapRef,
        root : NodeId,
    ) : ?MinResult {
        let ?original = checkedNode(memory, mapRefValue, root) else return null;
        var hId = original.id;
        var h = original;
        if (h.left == NULL_NODE) {
            if (h.right != NULL_NODE) return null;
            let result = {
                root = NULL_NODE;
                key = h.key;
                value = h.value;
            };
            recycleNode(memory, h);
            return ?result;
        };
        let ?left = checkedNode(memory, mapRefValue, h.left) else return null;
        if (not isRed(memory, h.left) and not isRed(memory, left.left)) {
            let ?moved = moveRedLeft(memory, mapRefValue, hId) else return null;
            hId := moved;
            let ?updated = checkedNode(memory, mapRefValue, hId) else return null;
            h := updated;
        };
        let ?minimum = takeMin(memory, mapRefValue, h.left) else return null;
        h.left := minimum.root;
        updateNodeHash(memory, h);
        ?{
            minimum with
            root = balance(memory, mapRefValue, h.id);
        };
    };

    func balance(memory : Memory, map : MapRef, root : NodeId) : NodeId {
        var hId = root;
        var h = switch (checkedNode(memory, map, hId)) {
            case null {
                Runtime.trap("Authenticated forest balance root is corrupt");
            };
            case (?node) node;
        };
        if (isRed(memory, h.right) and not isRed(memory, h.left)) {
            switch (rotateLeft(memory, map, hId)) {
                case null {
                    Runtime.trap(
                        "Authenticated forest left rotation failed"
                    );
                };
                case (?next) {
                    hId := next;
                    h := switch (checkedNode(memory, map, hId)) {
                        case null {
                            Runtime.trap(
                                "Authenticated forest left rotation corrupted root"
                            );
                        };
                        case (?node) node;
                    };
                };
            };
        };
        if (isRed(memory, h.left)) {
            let ?left = checkedNode(memory, map, h.left) else {
                Runtime.trap("Authenticated forest red left child is corrupt");
            };
            if (isRed(memory, left.left)) {
                switch (rotateRight(memory, map, hId)) {
                    case null {
                        Runtime.trap(
                            "Authenticated forest right rotation failed"
                        );
                    };
                    case (?next) {
                        hId := next;
                        h := switch (checkedNode(memory, map, hId)) {
                            case null {
                                Runtime.trap(
                                    "Authenticated forest right rotation corrupted root"
                                );
                            };
                            case (?node) node;
                        };
                    };
                };
            };
        };
        if (isRed(memory, h.left) and isRed(memory, h.right)) {
            if (not flipColors(memory, map, hId)) {
                Runtime.trap("Authenticated forest color flip failed");
            };
        };
        let ?final = checkedNode(memory, map, hId) else {
            Runtime.trap("Authenticated forest balance result is corrupt");
        };
        updateNodeHash(memory, final);
        hId;
    };

    func rotateLeft(memory : Memory, map : MapRef, hId : NodeId) : ?NodeId {
        let ?h = checkedNode(memory, map, hId) else return null;
        let ?x = checkedNode(memory, map, h.right) else return null;
        if (x.color != #red) return null;
        h.right := x.left;
        updateNodeHash(memory, h);
        x.left := h.id;
        x.color := h.color;
        h.color := #red;
        updateNodeHash(memory, h);
        updateNodeHash(memory, x);
        memory.counters.rotations += 1;
        ?x.id;
    };

    func rotateRight(memory : Memory, map : MapRef, hId : NodeId) : ?NodeId {
        let ?h = checkedNode(memory, map, hId) else return null;
        let ?x = checkedNode(memory, map, h.left) else return null;
        if (x.color != #red) return null;
        h.left := x.right;
        updateNodeHash(memory, h);
        x.right := h.id;
        x.color := h.color;
        h.color := #red;
        updateNodeHash(memory, h);
        updateNodeHash(memory, x);
        memory.counters.rotations += 1;
        ?x.id;
    };

    func moveRedLeft(
        memory : Memory,
        map : MapRef,
        hId : NodeId,
    ) : ?NodeId {
        if (not flipColors(memory, map, hId)) return null;
        var root = hId;
        var h = switch (checkedNode(memory, map, root)) {
            case null return null;
            case (?node) node;
        };
        let ?right = checkedNode(memory, map, h.right) else return null;
        if (isRed(memory, right.left)) {
            let ?rotatedRight = rotateRight(memory, map, h.right) else {
                return null;
            };
            h.right := rotatedRight;
            updateNodeHash(memory, h);
            let ?rotatedRoot = rotateLeft(memory, map, root) else return null;
            root := rotatedRoot;
            if (not flipColors(memory, map, root)) return null;
        };
        ?root;
    };

    func moveRedRight(
        memory : Memory,
        map : MapRef,
        hId : NodeId,
    ) : ?NodeId {
        if (not flipColors(memory, map, hId)) return null;
        var root = hId;
        let ?h = checkedNode(memory, map, root) else return null;
        let ?left = checkedNode(memory, map, h.left) else return null;
        if (isRed(memory, left.left)) {
            let ?rotated = rotateRight(memory, map, root) else return null;
            root := rotated;
            if (not flipColors(memory, map, root)) return null;
        };
        ?root;
    };

    func flipColors(memory : Memory, map : MapRef, hId : NodeId) : Bool {
        let ?h = checkedNode(memory, map, hId) else return false;
        let ?left = checkedNode(memory, map, h.left) else return false;
        let ?right = checkedNode(memory, map, h.right) else return false;
        h.color := flip(h.color);
        left.color := flip(left.color);
        right.color := flip(right.color);
        updateNodeHash(memory, left);
        updateNodeHash(memory, right);
        updateNodeHash(memory, h);
        true;
    };

    func flip(color : Color) : Color {
        switch (color) {
            case (#red) #black;
            case (#black) #red;
        };
    };

    func isRed(memory : Memory, id : NodeId) : Bool {
        if (id == NULL_NODE) return false;
        switch (getNode(memory, id)) {
            case (?node) node.in_use and node.color == #red;
            case null false;
        };
    };

    // Query/witness traversal consumes hashes persisted at commit time and
    // never rehashes labels, values, or bodies.  The completed witness is
    // reconstructed against the committed root before it is returned.
    func checkedNodeFast(
        memory : Memory,
        map : MapRef,
        id : NodeId,
    ) : ?Node {
        let ?node = getNode(memory, id) else return null;
        if (
            not node.in_use or node.map_id != map.id or
            node.key_hash.size() != 32 or node.value_hash.size() != 32 or
            node.data_hash.size() != 32 or node.subtree_hash.size() != 32
        ) return null;
        ?node;
    };

    func lookupNodeId(
        memory : Memory,
        map : MapRef,
        key : Blob,
    ) : ?NodeId {
        let ?mapRoot = getMap(memory, map) else return null;
        var current = mapRoot.root;
        var depth = 0;
        let bound = redBlackDepthBound(mapRoot.size) + 1;
        while (current != NULL_NODE) {
            if (depth > bound) {
                memory.header.healthy := false;
                return null;
            };
            let ?node = checkedNode(memory, map, current) else return null;
            memory.counters.node_visits += 1;
            switch (Blob.compare(key, node.key)) {
                case (#equal) return ?node.id;
                case (#less) current := node.left;
                case (#greater) current := node.right;
            };
            depth += 1;
        };
        null;
    };

    func lookupMapValue(
        memory : Memory,
        map : MapRef,
        key : Blob,
    ) : ValueLookup {
        let ?mapRoot = getMap(memory, map) else return #err(#corrupt);
        var current = mapRoot.root;
        var depth = 0;
        let bound = redBlackDepthBound(mapRoot.size) + 1;
        while (current != NULL_NODE) {
            if (depth > bound) return #err(#corrupt);
            let ?node = checkedNodeFast(memory, map, current) else {
                return #err(#corrupt);
            };
            switch (Blob.compare(key, node.key)) {
                case (#equal) return #ok(?node.value);
                case (#less) current := node.left;
                case (#greater) current := node.right;
            };
            depth += 1;
        };
        #ok(null);
    };

    func refreshNodeAndAncestors(
        memory : Memory,
        map : MapRef,
        key : Blob,
    ) : Bool {
        let ?root = getMap(memory, map) else return false;
        refreshPath(memory, map, root.root, key);
    };

    func refreshPath(
        memory : Memory,
        map : MapRef,
        nodeId : NodeId,
        key : Blob,
    ) : Bool {
        if (nodeId == NULL_NODE) return false;
        // A child subtree has already changed, so the target node's cached
        // value/subtree hashes are intentionally stale until this walk
        // reaches it.  Validate identity/order material here and refresh
        // hashes bottom-up instead of rejecting the expected stale cache.
        let ?node = checkedStructuralNode(memory, map, nodeId) else return false;
        memory.counters.node_visits += 1;
        let found = switch (Blob.compare(key, node.key)) {
            case (#equal) {
                node.value_hash := valueHash(memory, node.value);
                true;
            };
            case (#less) refreshPath(memory, map, node.left, key);
            case (#greater) refreshPath(memory, map, node.right, key);
        };
        if (found) updateNodeHash(memory, node);
        found;
    };

    // Public path mutations currently enter at a distinguished or detached
    // root, whose parent is null. Keeping this single outer propagation makes
    // the helper safe if a future caller starts at an attached subtree,
    // without repeating the ancestor walk at every recursive path level.
    func propagateParent(memory : Memory, map : MapRoot) {
        if (map.parent_map.id == NULL_MAP) return;
        let ?parentNode = getNode(memory, map.parent_node) else {
            memory.header.healthy := false;
            return;
        };
        if (
            not parentNode.in_use or
            parentNode.map_id != map.parent_map.id
        ) {
            memory.header.healthy := false;
            return;
        };
        switch (parentNode.value) {
            case (#subtree(child)) {
                if (child != mapRef(map)) {
                    memory.header.healthy := false;
                    return;
                };
            };
            case _ {
                memory.header.healthy := false;
                return;
            };
        };
        if (
            not refreshNodeAndAncestors(
                memory,
                map.parent_map,
                parentNode.key,
            )
        ) {
            memory.header.healthy := false;
            return;
        };
        let ?parentMap = getMap(memory, map.parent_map) else {
            memory.header.healthy := false;
            return;
        };
        propagateParent(memory, parentMap);
    };

    // ------------------------------------------------------------------
    // Witness construction
    // ------------------------------------------------------------------

    func mapMembershipWitness(
        memory : Memory,
        map : MapRef,
        key : Blob,
        valueWitness : MerkleTree.Witness,
    ) : ?MerkleTree.Witness {
        let ?root = getMap(memory, map) else return null;
        membershipWitnessNode(
            memory,
            map,
            root.root,
            key,
            valueWitness,
        );
    };

    func membershipWitnessNode(
        memory : Memory,
        map : MapRef,
        nodeId : NodeId,
        key : Blob,
        valueWitness : MerkleTree.Witness,
    ) : ?MerkleTree.Witness {
        if (nodeId == NULL_NODE) return null;
        let ?node = checkedNodeFast(memory, map, nodeId) else return null;
        switch (Blob.compare(key, node.key)) {
            case (#equal) {
                ?threeWayWitness(
                    memory,
                    prunedNode(memory, node.left),
                    countWitness(memory, #labeled(node.key, valueWitness)),
                    prunedNode(memory, node.right),
                );
            };
            case (#less) {
                let ?left = membershipWitnessNode(
                    memory,
                    map,
                    node.left,
                    key,
                    valueWitness,
                ) else return null;
                ?threeWayWitness(
                    memory,
                    left,
                    countWitness(memory, #pruned(nodeDataHash(node))),
                    prunedNode(memory, node.right),
                );
            };
            case (#greater) {
                let ?right = membershipWitnessNode(
                    memory,
                    map,
                    node.right,
                    key,
                    valueWitness,
                ) else return null;
                ?threeWayWitness(
                    memory,
                    prunedNode(memory, node.left),
                    countWitness(memory, #pruned(nodeDataHash(node))),
                    right,
                );
            };
        };
    };

    func mapAbsenceWitness(
        memory : Memory,
        map : MapRef,
        key : Blob,
    ) : ?MerkleTree.Witness {
        let ?root = getMap(memory, map) else return null;
        let lower = lowerBound(memory, map, root.root, key);
        let upper = upperBound(memory, map, root.root, key);
        switch (lower, upper) {
            case (null, null) ?countWitness(memory, #empty);
            case (?lo, null) ?witnessRangeAbove(
                memory,
                map,
                root.root,
                lo,
            );
            case (null, ?hi) ?witnessRangeBelow(
                memory,
                map,
                root.root,
                hi,
            );
            case (?lo, ?hi) ?witnessRangeBetween(
                memory,
                map,
                root.root,
                lo,
                hi,
            );
        };
    };

    type KeyBound = {
        id : NodeId;
        exact : Bool;
    };

    func lowerBound(
        memory : Memory,
        map : MapRef,
        start : NodeId,
        key : Blob,
    ) : ?KeyBound {
        var current = start;
        var candidate : ?KeyBound = null;
        while (current != NULL_NODE) {
            let ?node = checkedNodeFast(memory, map, current) else return null;
            switch (Blob.compare(node.key, key)) {
                case (#less) {
                    candidate := ?{ id = node.id; exact = false };
                    current := node.right;
                };
                case (#equal) return ?{ id = node.id; exact = true };
                case (#greater) current := node.left;
            };
        };
        candidate;
    };

    func upperBound(
        memory : Memory,
        map : MapRef,
        start : NodeId,
        key : Blob,
    ) : ?KeyBound {
        var current = start;
        var candidate : ?KeyBound = null;
        while (current != NULL_NODE) {
            let ?node = checkedNodeFast(memory, map, current) else return null;
            switch (Blob.compare(node.key, key)) {
                case (#less) current := node.right;
                case (#equal) return ?{ id = node.id; exact = true };
                case (#greater) {
                    candidate := ?{ id = node.id; exact = false };
                    current := node.left;
                };
            };
        };
        candidate;
    };

    func boundKey(memory : Memory, bound : KeyBound) : ?Blob {
        let ?node = getNode(memory, bound.id) else return null;
        if (not node.in_use) return null;
        ?node.key;
    };

    func keyWitness(
        memory : Memory,
        node : Node,
    ) : MerkleTree.Witness {
        countWitness(
            memory,
            #labeled(node.key, #pruned(node.value_hash)),
        );
    };

    func selectedBoundWitness(
        memory : Memory,
        node : Node,
        bound : KeyBound,
    ) : MerkleTree.Witness {
        // Absence callers use neighbor bounds.  Keep exact handling pinned to
        // the upstream range algorithm for defensive reuse.
        if (bound.exact) keyWitness(memory, node) else {
            keyWitness(memory, node);
        };
    };

    func witnessRangeAbove(
        memory : Memory,
        map : MapRef,
        nodeId : NodeId,
        lower : KeyBound,
    ) : MerkleTree.Witness {
        if (nodeId == NULL_NODE) return countWitness(memory, #empty);
        let ?node = checkedNodeFast(memory, map, nodeId) else {
            return countWitness(memory, #empty);
        };
        let ?lowerKey = boundKey(memory, lower) else {
            return countWitness(memory, #empty);
        };
        switch (Blob.compare(node.key, lowerKey)) {
            case (#equal) threeWayWitness(
                memory,
                prunedNode(memory, node.left),
                selectedBoundWitness(memory, node, lower),
                fullKeyWitness(memory, map, node.right),
            );
            case (#less) threeWayWitness(
                memory,
                prunedNode(memory, node.left),
                countWitness(memory, #pruned(nodeDataHash(node))),
                witnessRangeAbove(memory, map, node.right, lower),
            );
            case (#greater) threeWayWitness(
                memory,
                witnessRangeAbove(memory, map, node.left, lower),
                keyWitness(memory, node),
                fullKeyWitness(memory, map, node.right),
            );
        };
    };

    func witnessRangeBelow(
        memory : Memory,
        map : MapRef,
        nodeId : NodeId,
        upper : KeyBound,
    ) : MerkleTree.Witness {
        if (nodeId == NULL_NODE) return countWitness(memory, #empty);
        let ?node = checkedNodeFast(memory, map, nodeId) else {
            return countWitness(memory, #empty);
        };
        let ?upperKey = boundKey(memory, upper) else {
            return countWitness(memory, #empty);
        };
        switch (Blob.compare(node.key, upperKey)) {
            case (#equal) threeWayWitness(
                memory,
                fullKeyWitness(memory, map, node.left),
                selectedBoundWitness(memory, node, upper),
                prunedNode(memory, node.right),
            );
            case (#greater) threeWayWitness(
                memory,
                witnessRangeBelow(memory, map, node.left, upper),
                countWitness(memory, #pruned(nodeDataHash(node))),
                prunedNode(memory, node.right),
            );
            case (#less) threeWayWitness(
                memory,
                fullKeyWitness(memory, map, node.left),
                keyWitness(memory, node),
                witnessRangeBelow(memory, map, node.right, upper),
            );
        };
    };

    func witnessRangeBetween(
        memory : Memory,
        map : MapRef,
        nodeId : NodeId,
        lower : KeyBound,
        upper : KeyBound,
    ) : MerkleTree.Witness {
        if (nodeId == NULL_NODE) return countWitness(memory, #empty);
        let ?node = checkedNodeFast(memory, map, nodeId) else {
            return countWitness(memory, #empty);
        };
        let ?lowerKey = boundKey(memory, lower) else {
            return countWitness(memory, #empty);
        };
        let ?upperKey = boundKey(memory, upper) else {
            return countWitness(memory, #empty);
        };
        let lowerVsNode = Blob.compare(lowerKey, node.key);
        let nodeVsUpper = Blob.compare(node.key, upperKey);
        switch (lowerVsNode, nodeVsUpper) {
            case (#less, #less) threeWayWitness(
                memory,
                witnessRangeBetween(memory, map, node.left, lower, upper),
                keyWitness(memory, node),
                witnessRangeBetween(memory, map, node.right, lower, upper),
            );
            case (#equal, #equal) threeWayWitness(
                memory,
                prunedNode(memory, node.left),
                selectedBoundWitness(memory, node, lower),
                prunedNode(memory, node.right),
            );
            case (_, #equal) threeWayWitness(
                memory,
                witnessRangeBetween(memory, map, node.left, lower, upper),
                selectedBoundWitness(memory, node, upper),
                prunedNode(memory, node.right),
            );
            case (#equal, _) threeWayWitness(
                memory,
                prunedNode(memory, node.left),
                selectedBoundWitness(memory, node, lower),
                witnessRangeBetween(memory, map, node.right, lower, upper),
            );
            case (#less, #greater) threeWayWitness(
                memory,
                witnessRangeBetween(memory, map, node.left, lower, upper),
                countWitness(memory, #pruned(nodeDataHash(node))),
                prunedNode(memory, node.right),
            );
            case (#greater, #less) threeWayWitness(
                memory,
                prunedNode(memory, node.left),
                countWitness(memory, #pruned(nodeDataHash(node))),
                witnessRangeBetween(memory, map, node.right, lower, upper),
            );
            case _ countWitness(memory, #pruned(node.subtree_hash));
        };
    };

    func fullKeyWitness(
        memory : Memory,
        map : MapRef,
        nodeId : NodeId,
    ) : MerkleTree.Witness {
        if (nodeId == NULL_NODE) return countWitness(memory, #empty);
        let ?node = checkedNodeFast(memory, map, nodeId) else {
            return countWitness(memory, #empty);
        };
        threeWayWitness(
            memory,
            fullKeyWitness(memory, map, node.left),
            keyWitness(memory, node),
            fullKeyWitness(memory, map, node.right),
        );
    };

    func prunedNode(memory : Memory, id : NodeId) : MerkleTree.Witness {
        if (id == NULL_NODE) return countWitness(memory, #empty);
        switch (getNode(memory, id)) {
            case null countWitness(memory, #empty);
            case (?node) countWitness(memory, #pruned(node.subtree_hash));
        };
    };

    func threeWayWitness(
        memory : Memory,
        left : MerkleTree.Witness,
        middle : MerkleTree.Witness,
        right : MerkleTree.Witness,
    ) : MerkleTree.Witness {
        switch (left, right) {
            case (#empty, #empty) middle;
            case (#empty, _) {
                countWitness(memory, #fork(middle, right));
            };
            case (_, #empty) {
                countWitness(memory, #fork(left, middle));
            };
            case _ {
                switch (left, middle, right) {
                    case (#pruned(leftHash), #pruned(middleHash), #pruned(rightHash)) {
                        countWitness(
                            memory,
                            #pruned(
                                forkHash(
                                    leftHash,
                                    forkHash(middleHash, rightHash),
                                )
                            ),
                        );
                    };
                    case (_, #pruned(middleHash), #pruned(rightHash)) {
                        countWitness(
                            memory,
                            #fork(
                                left,
                                countWitness(
                                    memory,
                                    #pruned(forkHash(middleHash, rightHash)),
                                ),
                            ),
                        );
                    };
                    case _ {
                        countWitness(
                            memory,
                            #fork(
                                left,
                                countWitness(memory, #fork(middle, right)),
                            ),
                        );
                    };
                };
            };
        };
    };

    func countWitness(
        _memory : Memory,
        witness : MerkleTree.Witness,
    ) : MerkleTree.Witness {
        witness;
    };

    type DisposalScan = {
        max_nodes : Nat;
        var nodes : Nat;
        var maps : Nat;
        var exceeded : Bool;
        var corrupt : Bool;
    };
    type DisposalParent = {
        map : MapRef;
        node : NodeId;
    };
    type DisposalTreeState = {
        count : Nat;
        black_height : Nat;
        hash : Blob;
    };

    // This bounded validator deliberately combines the arena, ordering,
    // red-black, cached-hash, and nested-parent checks.  A corrupt cycle or
    // alias cannot recurse beyond the caller's node budget.
    func scanDiscardMap(
        memory : Memory,
        ref : MapRef,
        expectedParent : ?DisposalParent,
        scan : DisposalScan,
    ) {
        if (scan.exceeded or scan.corrupt) return;
        let ?map = getMap(memory, ref) else {
            scan.corrupt := true;
            return;
        };
        switch (expectedParent) {
            case null {
                if (
                    map.attached or map.parent_map.id != NULL_MAP or
                    map.parent_node != NULL_NODE
                ) {
                    scan.corrupt := true;
                    return;
                };
            };
            case (?parent) {
                if (
                    not map.attached or map.parent_map != parent.map or
                    map.parent_node != parent.node or
                    map.detached_path_hash.size() != 0
                ) {
                    scan.corrupt := true;
                    return;
                };
            };
        };
        if (
            scan.nodes > scan.max_nodes or
            map.size > scan.max_nodes - scan.nodes
        ) {
            scan.exceeded := true;
            return;
        };
        scan.maps += 1;
        let ?tree = scanDiscardTree(
            memory,
            ref,
            map.root,
            null,
            null,
            scan,
        ) else return;
        if (
            tree.count != map.size or
            tree.hash != mapHash(memory, ref) or
            (
                map.root == NULL_NODE and
                (map.size != 0 or tree.black_height != 1)
            )
        ) {
            scan.corrupt := true;
            return;
        };
        if (map.root != NULL_NODE) {
            let ?root = getNode(memory, map.root) else {
                scan.corrupt := true;
                return;
            };
            if (root.color != #black) scan.corrupt := true;
        };
    };

    func scanDiscardTree(
        memory : Memory,
        map : MapRef,
        id : NodeId,
        lower : ?Blob,
        upper : ?Blob,
        scan : DisposalScan,
    ) : ?DisposalTreeState {
        if (scan.exceeded or scan.corrupt) return null;
        if (id == NULL_NODE) {
            return ?{
                count = 0;
                black_height = 1;
                hash = emptyHash();
            };
        };
        if (scan.nodes >= scan.max_nodes) {
            scan.exceeded := true;
            return null;
        };
        let ?node = checkedNode(memory, map, id) else {
            scan.corrupt := true;
            return null;
        };
        switch (lower) {
            case (?bound) {
                if (Blob.compare(bound, node.key) != #less) {
                    scan.corrupt := true;
                    return null;
                };
            };
            case null {};
        };
        switch (upper) {
            case (?bound) {
                if (Blob.compare(node.key, bound) != #less) {
                    scan.corrupt := true;
                    return null;
                };
            };
            case null {};
        };
        if (
            isRed(memory, node.right) or
            (
                node.color == #red and
                (isRed(memory, node.left) or isRed(memory, node.right))
            )
        ) {
            scan.corrupt := true;
            return null;
        };
        scan.nodes += 1;
        switch (node.value) {
            case (#leaf(_)) {};
            case (#subtree(child)) {
                scanDiscardMap(
                    memory,
                    child,
                    ?{ map; node = node.id },
                    scan,
                );
                if (scan.exceeded or scan.corrupt) return null;
            };
        };
        let ?left = scanDiscardTree(
            memory,
            map,
            node.left,
            lower,
            ?node.key,
            scan,
        ) else return null;
        let ?right = scanDiscardTree(
            memory,
            map,
            node.right,
            ?node.key,
            upper,
            scan,
        ) else return null;
        if (left.black_height != right.black_height) {
            scan.corrupt := true;
            return null;
        };
        let expected = switch (node.left, node.right) {
            case (0, 0) nodeDataHash(node);
            case (0, _) forkHash(nodeDataHash(node), right.hash);
            case (_, 0) forkHash(left.hash, nodeDataHash(node));
            case (_, _) forkHash(
                left.hash,
                forkHash(nodeDataHash(node), right.hash),
            );
        };
        if (expected != node.subtree_hash) {
            scan.corrupt := true;
            return null;
        };
        ?{
            count = left.count + 1 + right.count;
            black_height = left.black_height + (
                if (node.color == #black) 1 else 0
            );
            hash = expected;
        };
    };

    func destroyDiscardMap(memory : Memory, ref : MapRef) : Bool {
        let ?map = getMap(memory, ref) else return false;
        if (not destroyDiscardTree(memory, ref, map.root)) return false;
        map.root := NULL_NODE;
        map.size := 0;
        map.parent_map := ZERO_REF;
        map.parent_node := NULL_NODE;
        map.attached := false;
        map.detached_path_hash := EMPTY_BLOB;
        reclaimMap(memory, ref);
    };

    func destroyDiscardTree(
        memory : Memory,
        map : MapRef,
        id : NodeId,
    ) : Bool {
        if (id == NULL_NODE) return true;
        let ?node = getNode(memory, id) else return false;
        if (not node.in_use or node.map_id != map.id) return false;
        let left = node.left;
        let right = node.right;
        let value = node.value;
        if (not destroyDiscardTree(memory, map, left)) return false;
        if (not destroyDiscardTree(memory, map, right)) return false;
        switch (value) {
            case (#leaf(_)) {};
            case (#subtree(child)) {
                let ?childMap = getMap(memory, child) else return false;
                childMap.parent_map := ZERO_REF;
                childMap.parent_node := NULL_NODE;
                childMap.attached := false;
                if (not destroyDiscardMap(memory, child)) return false;
            };
        };
        recycleNode(memory, node);
        true;
    };

    // ------------------------------------------------------------------
    // Arena allocation and invariants
    // ------------------------------------------------------------------

    func allocateNode(
        memory : Memory,
        mapId : MapId,
        key : Blob,
        value : Value,
    ) : ?NodeId {
        let id = if (memory.free_node != NULL_NODE) {
            let freeId = memory.free_node;
            let ?slot = getNodeSlot(memory, freeId) else return null;
            if (slot.in_use) return null;
            memory.free_node := slot.free_next;
            memory.header.free_nodes -= 1;
            memory.counters.nodes_reused += 1;
            freeId;
        } else {
            if (memory.next_node_id > MAX_NODES) return null;
            let next = memory.next_node_id;
            memory.next_node_id += 1;
            memory.header.allocated_nodes += 1;
            memory.counters.nodes_allocated += 1;
            next;
        };
        let node : Node = {
            id;
            var in_use = true;
            var map_id = mapId;
            var key = key;
            var key_hash = canonicalKeyHash(key);
            var value = value;
            var value_hash = valueHash(memory, value);
            var data_hash = EMPTY_BLOB;
            var color = #red;
            var left = NULL_NODE;
            var right = NULL_NODE;
            var subtree_hash = EMPTY_BLOB;
            var free_next = NULL_NODE;
        };
        updateNodeHash(memory, node);
        putNodeSlot(memory, id, node);
        memory.header.live_nodes += 1;
        ?id;
    };

    func recycleNode(memory : Memory, node : Node) {
        node.in_use := false;
        node.map_id := NULL_MAP;
        node.key := EMPTY_BLOB;
        node.key_hash := EMPTY_BLOB;
        node.value := #leaf(EMPTY_BLOB);
        node.value_hash := EMPTY_BLOB;
        node.data_hash := EMPTY_BLOB;
        node.color := #black;
        node.left := NULL_NODE;
        node.right := NULL_NODE;
        node.subtree_hash := EMPTY_BLOB;
        node.free_next := memory.free_node;
        memory.free_node := node.id;
        memory.header.live_nodes -= 1;
        memory.header.free_nodes += 1;
        memory.counters.nodes_reclaimed += 1;
    };

    func allocateMap(memory : Memory) : ?MapRef {
        if (memory.free_map != NULL_MAP) {
            let ?candidate = getMapSlot(memory, memory.free_map) else {
                return null;
            };
            if (
                candidate.in_use or candidate.generation == MAX_NAT64
            ) return null;
        };
        let id = if (memory.free_map != NULL_MAP) {
            let freeId = memory.free_map;
            let ?slot = getMapSlot(memory, freeId) else return null;
            if (slot.in_use) return null;
            memory.free_map := slot.free_next;
            memory.header.free_maps -= 1;
            memory.counters.maps_reused += 1;
            freeId;
        } else {
            if (memory.next_map_id > MAX_MAPS) return null;
            let next = memory.next_map_id;
            memory.next_map_id += 1;
            memory.header.allocated_maps += 1;
            memory.counters.maps_allocated += 1;
            next;
        };
        let generation : Nat64 = switch (getMapSlot(memory, id)) {
            case null (1 : Nat64);
            case (?prior) prior.generation + 1;
        };
        let map : MapRoot = {
            id;
            var in_use = true;
            var generation;
            var root = NULL_NODE;
            var size = 0;
            var parent_map = ZERO_REF;
            var parent_node = NULL_NODE;
            var attached = false;
            var detach_epoch = 0;
            var detached_path_hash = EMPTY_BLOB;
            var free_next = NULL_MAP;
        };
        putMapSlot(memory, id, map);
        memory.header.live_maps += 1;
        ?mapRef(map);
    };

    func markRootAttached(memory : Memory, ref : MapRef) {
        switch (getMap(memory, ref)) {
            case (?map) map.attached := true;
            case null assert false;
        };
    };

    func reclaimMap(memory : Memory, ref : MapRef) : Bool {
        let ?map = getMap(memory, ref) else return false;
        if (
            map.root != NULL_NODE or map.size != 0 or
            map.parent_map.id != NULL_MAP or map.attached
        ) return false;
        map.in_use := false;
        map.free_next := memory.free_map;
        memory.free_map := map.id;
        memory.header.live_maps -= 1;
        memory.header.free_maps += 1;
        memory.counters.maps_reclaimed += 1;
        true;
    };

    func getNode(memory : Memory, id : NodeId) : ?Node {
        if (id == NULL_NODE) return null;
        let ?node = getNodeSlot(memory, id) else return null;
        if (node.id != id) return null;
        ?node;
    };

    func getNodeSlot(memory : Memory, id : NodeId) : ?Node {
        if (id == NULL_NODE or id >= memory.next_node_id) return null;
        let zero = id - 1;
        let chunkIndex = zero / NODE_CHUNK_SIZE;
        let slotIndex = zero % NODE_CHUNK_SIZE;
        if (chunkIndex >= memory.node_chunks.size()) return null;
        let ?chunk = memory.node_chunks[chunkIndex] else return null;
        let ?node = chunk[slotIndex] else return null;
        if (node.id != id) return null;
        ?node;
    };

    func putNodeSlot(memory : Memory, id : NodeId, node : Node) {
        assert (id != NULL_NODE and node.id == id);
        let zero = id - 1;
        let chunkIndex = zero / NODE_CHUNK_SIZE;
        let slotIndex = zero % NODE_CHUNK_SIZE;
        let chunk = switch (memory.node_chunks[chunkIndex]) {
            case (?existing) existing;
            case null {
                let created = VarArray.repeat<?Node>(null, NODE_CHUNK_SIZE);
                memory.node_chunks[chunkIndex] := ?created;
                created;
            };
        };
        chunk[slotIndex] := ?node;
    };

    func getMapSlot(memory : Memory, id : MapId) : ?MapRoot {
        if (id == NULL_MAP or id >= memory.next_map_id) return null;
        let zero = id - 1;
        let chunkIndex = zero / MAP_CHUNK_SIZE;
        let slotIndex = zero % MAP_CHUNK_SIZE;
        if (chunkIndex >= memory.map_chunks.size()) return null;
        let ?chunk = memory.map_chunks[chunkIndex] else return null;
        let ?map = chunk[slotIndex] else return null;
        if (map.id != id) return null;
        ?map;
    };

    func putMapSlot(memory : Memory, id : MapId, map : MapRoot) {
        assert (id != NULL_MAP and map.id == id);
        let zero = id - 1;
        let chunkIndex = zero / MAP_CHUNK_SIZE;
        let slotIndex = zero % MAP_CHUNK_SIZE;
        let chunk = switch (memory.map_chunks[chunkIndex]) {
            case (?existing) existing;
            case null {
                let created = VarArray.repeat<?MapRoot>(null, MAP_CHUNK_SIZE);
                memory.map_chunks[chunkIndex] := ?created;
                created;
            };
        };
        chunk[slotIndex] := ?map;
    };

    func getMap(memory : Memory, ref : MapRef) : ?MapRoot {
        if (ref.id == NULL_MAP) return null;
        let ?map = getMapSlot(memory, ref.id) else return null;
        if (
            map.id != ref.id or not map.in_use or
            map.generation != ref.generation
        ) return null;
        ?map;
    };

    func checkedNode(
        memory : Memory,
        map : MapRef,
        id : NodeId,
    ) : ?Node {
        let ?node = getNode(memory, id) else return null;
        if (
            not node.in_use or node.map_id != map.id or
            node.key_hash != canonicalKeyHash(node.key) or
            node.value_hash != valueHash(memory, node.value) or
            node.data_hash != labeledHash(node.key, node.value_hash)
        ) return null;
        ?node;
    };

    func checkedStructuralNode(
        memory : Memory,
        map : MapRef,
        id : NodeId,
    ) : ?Node {
        let ?node = getNode(memory, id) else return null;
        if (
            not node.in_use or node.map_id != map.id or
            node.key_hash != canonicalKeyHash(node.key)
        ) return null;
        ?node;
    };

    func mapRef(map : MapRoot) : MapRef {
        { id = map.id; generation = map.generation };
    };

    func mapHash(memory : Memory, ref : MapRef) : Blob {
        let ?map = getMap(memory, ref) else return emptyHash();
        nodeHash(memory, map.root);
    };

    func nodeHash(memory : Memory, id : NodeId) : Blob {
        if (id == NULL_NODE) return emptyHash();
        switch (getNode(memory, id)) {
            case null emptyHash();
            case (?node) node.subtree_hash;
        };
    };

    func valueHash(memory : Memory, value : Value) : Blob {
        switch (value) {
            case (#leaf(blob)) leafHash(blob);
            case (#subtree(ref)) mapHash(memory, ref);
        };
    };

    func nodeDataHash(node : Node) : Blob {
        node.data_hash;
    };

    func updateNodeHash(memory : Memory, node : Node) {
        node.data_hash := labeledHash(node.key, node.value_hash);
        node.subtree_hash := expectedNodeHash(
            memory,
            node,
            node.data_hash,
        );
    };

    func expectedNodeHash(
        memory : Memory,
        node : Node,
        data : Blob,
    ) : Blob {
        switch (node.left, node.right) {
            case (0, 0) data;
            case (0, _) forkHash(data, nodeHash(memory, node.right));
            case (_, 0) forkHash(nodeHash(memory, node.left), data);
            case (_, _) forkHash(
                nodeHash(memory, node.left),
                forkHash(data, nodeHash(memory, node.right)),
            );
        };
    };

    func attachChildValue(
        memory : Memory,
        parentMap : MapRef,
        parentNode : NodeId,
        value : Value,
    ) {
        switch (value) {
            case (#leaf(_)) {};
            case (#subtree(ref)) {
                switch (getMap(memory, ref)) {
                    case null memory.header.healthy := false;
                    case (?child) {
                        child.parent_map := parentMap;
                        child.parent_node := parentNode;
                        child.attached := true;
                    };
                };
            };
        };
    };

    func detachValue(memory : Memory, value : Value) {
        switch (value) {
            case (#leaf(_)) {};
            case (#subtree(ref)) {
                switch (getMap(memory, ref)) {
                    case null {};
                    case (?child) {
                        child.parent_map := ZERO_REF;
                        child.parent_node := NULL_NODE;
                        child.attached := false;
                    };
                };
            };
        };
    };

    func detachPriorValue(
        memory : Memory,
        prior : Value,
        next : Value,
    ) : Bool {
        switch (prior, next) {
            case (#subtree(a), #subtree(b)) {
                if (a == b) return true;
                detachValue(memory, prior);
                true;
            };
            case (#subtree(_), _) {
                // Replacing a nonempty subtree by a leaf would orphan live
                // nodes.  Callers must explicitly detach or clear it.
                false;
            };
            case _ true;
        };
    };

    func detachedMap(memory : Memory, token : Detached) : ?MapRoot {
        if (
            not validPath(token.absolute_path) or
            token.absolute_path_hash.size() != 32 or
            token.root_hash.size() != 32 or
            token.token_fingerprint.size() != 32 or
            token.absolute_path_hash != SHA256.fromBlob(
                #sha256,
                canonicalPathEncoding(token.absolute_path),
            ) or
            token.token_fingerprint != detachedTokenFingerprint({
                token with token_fingerprint = EMPTY_BLOB
            })
        ) return null;
        let ?map = getMap(memory, token.root) else return null;
        if (
            map.attached or map.parent_map.id != NULL_MAP or
            map.detach_epoch != token.detach_epoch or
            map.detached_path_hash != token.absolute_path_hash or
            mapHash(memory, token.root) != token.root_hash
        ) return null;
        ?map;
    };

    func writable(memory : Memory) : Bool {
        memory.header.healthy and
        memory.header.schema_version == SCHEMA_VERSION and
        memory.header.forest_version == FOREST_VERSION and
        memory.header.commit_sequence != MAX_NAT64;
    };

    func readable(memory : Memory) : Bool {
        memory.header.healthy and
        memory.header.schema_version == SCHEMA_VERSION and
        memory.header.forest_version == FOREST_VERSION and
        not memory.dirty and fastHeaderValid(memory);
    };

    func distinguishedRootsDistinct(memory : Memory) : Bool {
        let response = memory.header.response_root.id;
        let mounts = memory.header.mount_catalog_root.id;
        let collections = memory.header.collection_catalog_root.id;
        response != mounts and response != collections and
        mounts != collections;
    };

    func fastHeaderValid(memory : Memory) : Bool {
        if (
            memory.header.schema_version != SCHEMA_VERSION or
            memory.header.forest_version != FOREST_VERSION or
            not distinguishedRootsDistinct(memory) or
            memory.header.response_policy_table_fingerprint.size() != 32 or
            memory.header.allocator_layout_fingerprint.size() != 32 or
            memory.header.response_root_hash.size() != 32 or
            memory.header.mount_catalog_root_hash.size() != 32 or
            memory.header.collection_catalog_root_hash.size() != 32 or
            memory.header.commit_fingerprint.size() != 32 or
            memory.header.allocated_nodes !=
                memory.header.live_nodes + memory.header.free_nodes or
            memory.header.allocated_maps !=
                memory.header.live_maps + memory.header.free_maps
        ) return false;
        let ?response = getMap(memory, memory.header.response_root) else {
            return false;
        };
        let ?mounts = getMap(memory, memory.header.mount_catalog_root) else {
            return false;
        };
        let ?collections = getMap(
            memory,
            memory.header.collection_catalog_root,
        ) else return false;
        response.attached and mounts.attached and collections.attached and
        response.parent_map.id == NULL_MAP and
        mounts.parent_map.id == NULL_MAP and
        collections.parent_map.id == NULL_MAP and
        mapHash(memory, memory.header.response_root) ==
            memory.header.response_root_hash and
        mapHash(memory, memory.header.mount_catalog_root) ==
            memory.header.mount_catalog_root_hash and
        mapHash(memory, memory.header.collection_catalog_root) ==
            memory.header.collection_catalog_root_hash and
        computeCommitFingerprint(memory) ==
            memory.header.commit_fingerprint;
    };

    func validPath(path : [Blob]) : Bool {
        if (path.size() == 0 or path.size() > MAX_PATH_LABELS) return false;
        var total = 0;
        for (keyLabel in path.vals()) {
            if (keyLabel.size() > MAX_LABEL_BYTES) return false;
            total += keyLabel.size();
            if (total > MAX_PATH_BYTES) return false;
        };
        true;
    };

    func shallowValid(
        memory : Memory,
        expectedResponsePolicy : Blob,
        expectedAllocator : Blob,
    ) : Bool {
        if (
            memory.header.schema_version != SCHEMA_VERSION or
            memory.header.forest_version != FOREST_VERSION or
            not distinguishedRootsDistinct(memory) or
            expectedResponsePolicy.size() != 32 or
            expectedAllocator.size() != 32 or
            memory.header.response_policy_table_canonical.size() == 0 or
            memory.header.response_policy_table_canonical.size() >
                MAX_RESPONSE_POLICY_TABLE_BYTES or
            SHA256.fromBlob(
                #sha256,
                memory.header.response_policy_table_canonical,
            ) != memory.header.response_policy_table_fingerprint or
            memory.header.response_policy_table_fingerprint != expectedResponsePolicy or
            memory.header.allocator_layout_fingerprint != expectedAllocator or
            memory.header.response_root_hash.size() != 32 or
            memory.header.mount_catalog_root_hash.size() != 32 or
            memory.header.collection_catalog_root_hash.size() != 32 or
            memory.header.commit_fingerprint.size() != 32 or
            memory.header.allocated_nodes !=
                memory.header.live_nodes + memory.header.free_nodes or
            memory.header.allocated_maps !=
                memory.header.live_maps + memory.header.free_maps or
            memory.header.allocated_nodes + 1 != memory.next_node_id or
            memory.header.allocated_maps + 1 != memory.next_map_id
        ) return false;
        let ?response = getMap(memory, memory.header.response_root) else return false;
        let ?mounts = getMap(memory, memory.header.mount_catalog_root) else return false;
        let ?collections = getMap(memory, memory.header.collection_catalog_root) else return false;
        if (
            response.parent_map.id != NULL_MAP or
            mounts.parent_map.id != NULL_MAP or
            collections.parent_map.id != NULL_MAP or
            mapHash(memory, mapRef(response)) != memory.header.response_root_hash or
            mapHash(memory, mapRef(mounts)) != memory.header.mount_catalog_root_hash or
            mapHash(memory, mapRef(collections)) != memory.header.collection_catalog_root_hash or
            computeCommitFingerprint(memory) != memory.header.commit_fingerprint
        ) return false;
        localMapValid(memory, response) and
        localMapValid(memory, mounts) and
        localMapValid(memory, collections);
    };

    func refreshHeader(memory : Memory, advance : Bool) {
        memory.header.response_root_hash :=
            mapHash(memory, memory.header.response_root);
        memory.header.mount_catalog_root_hash :=
            mapHash(memory, memory.header.mount_catalog_root);
        memory.header.collection_catalog_root_hash :=
            mapHash(memory, memory.header.collection_catalog_root);
        if (advance) memory.header.commit_sequence += 1;
        memory.header.commit_fingerprint := computeCommitFingerprint(memory);
    };

    func computeCommitFingerprint(memory : Memory) : Blob {
        let digest = SHA256.Digest(#sha256);
        digest.writeBlob(Text.encodeUtf8(COMMIT_DOMAIN));
        digest.writeBlob(u32be(memory.header.schema_version));
        digest.writeBlob(u32be(memory.header.forest_version));
        digest.writeBlob(memory.header.response_root_hash);
        digest.writeBlob(memory.header.mount_catalog_root_hash);
        digest.writeBlob(memory.header.collection_catalog_root_hash);
        digest.writeBlob(memory.header.response_policy_table_fingerprint);
        digest.writeBlob(memory.header.allocator_layout_fingerprint);
        digest.writeBlob(u64be(memory.header.commit_sequence));
        digest.writeBlob(u64be(Nat64.fromNat(memory.header.live_nodes)));
        digest.writeBlob(u64be(Nat64.fromNat(memory.header.allocated_nodes)));
        digest.writeBlob(u64be(Nat64.fromNat(memory.header.free_nodes)));
        digest.writeBlob(u64be(Nat64.fromNat(memory.header.live_maps)));
        digest.writeBlob(u64be(Nat64.fromNat(memory.header.allocated_maps)));
        digest.writeBlob(u64be(Nat64.fromNat(memory.header.free_maps)));
        digest.sum();
    };

    func localNodeValid(memory : Memory, node : Node) : Bool {
        if (
            not node.in_use or node.map_id == NULL_MAP or
            node.key_hash != canonicalKeyHash(node.key) or
            node.value_hash != valueHash(memory, node.value) or
            node.data_hash != labeledHash(node.key, node.value_hash) or
            (
                switch (node.value) {
                    case (#leaf(_)) false;
                    case (#subtree(ref)) {
                        switch (getMap(memory, ref)) {
                            case null true;
                            case (?child) {
                                switch (getMapSlot(memory, node.map_id)) {
                                    case null true;
                                    case (?parent) {
                                        not parent.in_use or
                                        not child.attached or
                                        child.parent_map != mapRef(parent) or
                                        child.parent_node != node.id or
                                        child.detached_path_hash.size() != 0
                                    };
                                }
                            };
                        };
                    };
                }
            )
        ) return false;
        let leftValid = node.left == NULL_NODE or (
            switch (getNode(memory, node.left)) {
                case (?left) left.in_use and left.map_id == node.map_id and
                    Blob.compare(left.key, node.key) == #less;
                case null false;
            }
        );
        let rightValid = node.right == NULL_NODE or (
            switch (getNode(memory, node.right)) {
                case (?right) right.in_use and right.map_id == node.map_id and
                    Blob.compare(right.key, node.key) == #greater;
                case null false;
            }
        );
        if (not leftValid or not rightValid) return false;
        if (
            node.color == #red and
            (isRed(memory, node.left) or isRed(memory, node.right))
        ) return false;
        if (isRed(memory, node.right)) return false;
        node.subtree_hash ==
            expectedNodeHash(memory, node, nodeDataHash(node));
    };

    func localMapValid(memory : Memory, map : MapRoot) : Bool {
        if (not map.in_use or not mapLinkValid(memory, map)) return false;
        if (map.root == NULL_NODE) return map.size == 0;
        let ?root = getNode(memory, map.root) else return false;
        root.in_use and root.map_id == map.id and root.color == #black and
        // Upgrade/HTTP validation is deliberately root-local.  Full depth,
        // cardinality, ordering, black-height, and cached-hash validation
        // belongs exclusively to the explicit bounded/deep audit path.
        map.size > 0 and root.key_hash == canonicalKeyHash(root.key) and
        root.value_hash == valueHash(memory, root.value) and
        root.subtree_hash.size() == 32;
    };

    func mapLinkValid(memory : Memory, map : MapRoot) : Bool {
        let ref = mapRef(map);
        let distinguished =
            ref == memory.header.response_root or
            ref == memory.header.mount_catalog_root or
            ref == memory.header.collection_catalog_root;
        if (distinguished) {
            return map.attached and map.parent_map == ZERO_REF and
                map.parent_node == NULL_NODE and
                map.detached_path_hash.size() == 0;
        };
        if (map.parent_map.id == NULL_MAP) {
            return not map.attached and map.parent_node == NULL_NODE and
                map.detached_path_hash.size() == 32;
        };
        if (
            not map.attached or map.parent_node == NULL_NODE or
            map.detached_path_hash.size() != 0
        ) return false;
        let ?parent = getMap(memory, map.parent_map) else return false;
        let ?node = getNode(memory, map.parent_node) else return false;
        if (
            not node.in_use or node.map_id != parent.id
        ) return false;
        switch (node.value) {
            case (#subtree(child)) child == ref;
            case (#leaf(_)) false;
        };
    };

    type TreeValidation = {
        count : Nat;
        black_height : Nat;
        hash : Blob;
    };

    func validateTree(
        memory : Memory,
        map : MapRef,
        id : NodeId,
        lower : ?Blob,
        upper : ?Blob,
    ) : ?TreeValidation {
        if (id == NULL_NODE) {
            return ?{ count = 0; black_height = 1; hash = emptyHash() };
        };
        let ?node = checkedNode(memory, map, id) else return null;
        switch (lower) {
            case (?bound) {
                if (Blob.compare(bound, node.key) != #less) return null;
            };
            case null {};
        };
        switch (upper) {
            case (?bound) {
                if (Blob.compare(node.key, bound) != #less) return null;
            };
            case null {};
        };
        if (
            node.color == #red and
            (isRed(memory, node.left) or isRed(memory, node.right))
        ) return null;
        if (isRed(memory, node.right)) return null;
        let ?left = validateTree(memory, map, node.left, lower, ?node.key) else {
            return null;
        };
        let ?right = validateTree(memory, map, node.right, ?node.key, upper) else {
            return null;
        };
        if (left.black_height != right.black_height) return null;
        let black = left.black_height + (
            if (node.color == #black) 1 else 0
        );
        let expected = switch (node.left, node.right) {
            case (0, 0) nodeDataHash(node);
            case (0, _) forkHash(nodeDataHash(node), right.hash);
            case (_, 0) forkHash(left.hash, nodeDataHash(node));
            case (_, _) forkHash(
                left.hash,
                forkHash(nodeDataHash(node), right.hash),
            );
        };
        if (expected != node.subtree_hash) return null;
        ?{
            count = left.count + 1 + right.count;
            black_height = black;
            hash = expected;
        };
    };

    func treeDepth(memory : Memory, id : NodeId) : Nat {
        if (id == NULL_NODE) return 0;
        let ?node = getNode(memory, id) else return MAX_NODES;
        1 + Nat.max(treeDepth(memory, node.left), treeDepth(memory, node.right));
    };

    func ceilLog2(value : Nat) : Nat {
        if (value <= 1) return 0;
        var power = 1;
        var bits = 0;
        while (power < value) {
            power *= 2;
            bits += 1;
        };
        bits;
    };

    // ------------------------------------------------------------------
    // Frozen IC hash-tree primitives and canonical integer encoding
    // ------------------------------------------------------------------

    public func emptyHash() : Blob {
        sha(Text.encodeUtf8("\11ic-hashtree-empty"));
    };

    public func leafHash(value : Blob) : Blob {
        hashTwo(Text.encodeUtf8("\10ic-hashtree-leaf"), value);
    };

    public func labeledHash(keyLabel : Blob, valueHash : Blob) : Blob {
        hashThree(
            Text.encodeUtf8("\13ic-hashtree-labeled"),
            keyLabel,
            valueHash,
        );
    };

    public func forkHash(left : Blob, right : Blob) : Blob {
        hashThree(
            Text.encodeUtf8("\10ic-hashtree-fork"),
            left,
            right,
        );
    };

    func sha(value : Blob) : Blob {
        SHA256.fromBlob(#sha256, value);
    };

    func hashTwo(first : Blob, second : Blob) : Blob {
        let digest = SHA256.Digest(#sha256);
        digest.writeBlob(first);
        digest.writeBlob(second);
        digest.sum();
    };

    func hashThree(first : Blob, second : Blob, third : Blob) : Blob {
        let digest = SHA256.Digest(#sha256);
        digest.writeBlob(first);
        digest.writeBlob(second);
        digest.writeBlob(third);
        digest.sum();
    };

    func u32be(value : Nat32) : Blob {
        Blob.fromArray([
            Nat8.fromNat(Nat32.toNat(value >> 24)),
            Nat8.fromNat(Nat32.toNat((value >> 16) & 0xff)),
            Nat8.fromNat(Nat32.toNat((value >> 8) & 0xff)),
            Nat8.fromNat(Nat32.toNat(value & 0xff)),
        ]);
    };

    func u64be(value : Nat64) : Blob {
        Blob.fromArray([
            Nat8.fromNat(Nat64.toNat(value >> 56)),
            Nat8.fromNat(Nat64.toNat((value >> 48) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 40) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 32) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 24) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 16) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 8) & 0xff)),
            Nat8.fromNat(Nat64.toNat(value & 0xff)),
        ]);
    };

    func appendBlob(target : List.List<Nat8>, blob : Blob) {
        for (byte in blob.vals()) List.add(target, byte);
    };
};
