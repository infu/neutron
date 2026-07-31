import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Memory "../memory/files/v1";
import Frames "Frames";
import Keys "Keys";
import Types "Types";

module {
    public type LocatedNode = { node_id : Types.Id128; node : Memory.Node };
    public type ReadEvent = {
        #reachable;
        #ancestor_node;
        #ancestor_edge;
    };
    public type ReadObserver = (ReadEvent) -> ();
    public type Page = {
        parent : LocatedNode;
        items : [LocatedNode];
        next_cursor : ?Types.ListCursor;
        has_more : Bool;
    };

    public class Tree(mem : Memory.Mem) {
        var readObserver : ?ReadObserver = null;

        // Service exposes this only on its in-process class surface so Motoko
        // regressions can prove a path performs no ancestry work. The actor
        // does not export it, and the null production default adds no state.
        public func observeReads(observer : ?ReadObserver) {
            readObserver := observer;
        };

        func observe(event : ReadEvent) {
            switch (readObserver) {
                case (?observer) observer(event);
                case null {};
            };
        };

        public func get(nodeId : Types.Id128) : ?Memory.Node {
            Map.get(mem.nodes_by_id, Keys.compareId128, nodeId);
        };

        public func reachable(nodeId : Types.Id128) : Types.Result<LocatedNode> {
            observe(#reachable);
            let ?selected = get(nodeId) else {
                return #err(Types.reject(#not_found));
            };
            switch (selected.state) {
                case (#hidden(_)) return #err(Types.reject(#not_found));
                case (#active) {};
            };
            var currentId = nodeId;
            var current = selected;
            var depth = 0;
            label ancestors loop {
                if (currentId == Types.ROOT_NODE_ID) {
                    if (
                        current.parent_id != Types.ROOT_NODE_ID or
                        current.name_tag != Types.ZERO_TAG
                    ) return #err(Types.reject(#corrupt_state));
                    switch (current.kind) {
                        case (#folder(_)) {};
                        case (_) return #err(Types.reject(#corrupt_state));
                    };
                    return #ok({ node_id = nodeId; node = selected });
                };
                if (depth >= Nat8.toNat(Types.MAX_TREE_DEPTH)) {
                    return #err(Types.reject(#corrupt_state));
                };
                let parentId = current.parent_id;
                observe(#ancestor_node);
                let ?parent = get(parentId) else {
                    return #err(Types.reject(#corrupt_state));
                };
                switch (parent.state, parent.kind) {
                    case (#active, #folder(_)) {};
                    case (#hidden(_), _) return #err(Types.reject(#not_found));
                    case (_) return #err(Types.reject(#corrupt_state));
                };
                let key = Keys.childNameKey(parentId, current.name_tag);
                observe(#ancestor_edge);
                if (
                    Map.get(mem.children_by_name, Keys.compareChildNameKey, key) !=
                    ?currentId
                ) return #err(Types.reject(#corrupt_state));
                currentId := parentId;
                current := parent;
                depth += 1;
            };
            #err(Types.reject(#corrupt_state));
        };

        public func depth(nodeId : Types.Id128) : Types.Result<Nat8> {
            switch (reachable(nodeId)) {
                case (#err(error)) #err(error);
                case (#ok(_)) {
                    var currentId = nodeId;
                    var result : Nat8 = 0;
                    while (currentId != Types.ROOT_NODE_ID) {
                        let ?node = get(currentId) else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        if (result == Types.MAX_TREE_DEPTH) {
                            return #err(Types.reject(#corrupt_state));
                        };
                        result += 1;
                        currentId := node.parent_id;
                    };
                    #ok(result);
                };
            };
        };

        public func lookupChild(
            parentId : Types.Id128,
            expectedChildrenRevision : ?Nat64,
            tag : Types.Digest256,
        ) : Types.Result<LocatedNode> {
            let parentResult = reachable(parentId);
            let #ok(parent) = parentResult else {
                let #err(error) = parentResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            switch (parent.node.kind) {
                case (#file(_)) return #err(Types.reject(#not_folder));
                case (#folder(_)) {};
            };
            switch (expectedChildrenRevision) {
                case (?expected) if (
                    expected != parent.node.children_revision
                ) return #err(Types.reject(#stale_revision));
                case (_) {};
            };
            let key = Keys.childNameKey(parentId, tag);
            let ?nodeId = Map.get(
                mem.children_by_name,
                Keys.compareChildNameKey,
                key,
            ) else return #err(Types.reject(#not_found));
            let ?node = get(nodeId) else {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                node.parent_id != parentId or node.name_tag != tag
            ) return #err(Types.reject(#corrupt_state));
            switch (node.state) {
                case (#hidden(_)) return #err(Types.reject(#not_found));
                case (#active) #ok({ node_id = nodeId; node });
            };
        };

        public func page(request : Types.ListRequest) : Types.Result<Page> {
            if (request.limit == 0 or Nat16.toNat(request.limit) > Types.MAX_CHILD_PAGE) {
                return #err(Types.reject(#invalid_request));
            };
            let parentResult = reachable(request.parent_id);
            let #ok(parent) = parentResult else {
                let #err(error) = parentResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let folder = switch (parent.node.kind) {
                case (#file(_)) return #err(Types.reject(#not_folder));
                case (#folder(value)) value;
            };
            switch (request.expected_structural_revision) {
                case (?expected) if (
                    expected != parent.node.structural_revision
                ) return #err(Types.reject(#stale_revision));
                case (_) {};
            };
            let startTag = switch (request.cursor) {
                case null Types.ZERO_TAG;
                case (?cursor) {
                    if (
                        cursor.parent_id != request.parent_id or
                        cursor.children_revision != parent.node.children_revision
                    ) return #err(Types.reject(#cursor_stale));
                    cursor.last_name_tag;
                };
            };
            let startKey = Keys.childNameKey(request.parent_id, startTag);
            let iterator = Map.entriesFrom(
                mem.children_by_name,
                Keys.compareChildNameKey,
                startKey,
            );
            let selected = List.empty<LocatedNode>();
            var skippedInclusive = request.cursor == null;
            let wanted = Nat16.toNat(request.limit);
            var hasMore = false;
            var lastTag : ?Types.Digest256 = null;
            label paging loop {
                let ?(key, nodeId) = iterator.next() else break paging;
                if (Keys.childKeyParent(key) != request.parent_id) break paging;
                let tag = Keys.childKeyTag(key);
                if (not skippedInclusive) {
                    skippedInclusive := true;
                    if (tag == startTag) continue paging;
                };
                let ?node = get(nodeId) else {
                    return #err(Types.reject(#corrupt_state));
                };
                if (
                    node.parent_id != request.parent_id or
                    node.name_tag != tag
                ) return #err(Types.reject(#corrupt_state));
                switch (node.state) {
                    case (#hidden(_)) return #err(Types.reject(#corrupt_state));
                    case (#active) {};
                };
                if (List.size(selected) == wanted) {
                    hasMore := true;
                    break paging;
                };
                List.add(selected, { node_id = nodeId; node });
                lastTag := ?tag;
            };
            let items = List.toArray(selected);
            if (items.size() > Nat32.toNat(folder.direct_child_count)) {
                return #err(Types.reject(#corrupt_state));
            };
            let next = if (hasMore) {
                let ?tag = lastTag else {
                    return #err(Types.reject(#corrupt_state));
                };
                ?{
                    parent_id = request.parent_id;
                    children_revision = parent.node.children_revision;
                    last_name_tag = tag;
                };
            } else {
                null;
            };
            #ok({
                parent;
                items;
                next_cursor = next;
                has_more = hasMore;
            });
        };

        public func isWithin(
            rootId : Types.Id128,
            candidateId : Types.Id128,
        ) : Types.Result<Bool> {
            let candidateResult = reachable(candidateId);
            switch (candidateResult) {
                case (#err(error)) #err(error);
                case (#ok(_)) {
                    var currentId = candidateId;
                    var walked = 0;
                    loop {
                        if (currentId == rootId) return #ok(true);
                        if (currentId == Types.ROOT_NODE_ID) return #ok(false);
                        if (walked >= Nat8.toNat(Types.MAX_TREE_DEPTH)) {
                            return #err(Types.reject(#corrupt_state));
                        };
                        let ?current = get(currentId) else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        currentId := current.parent_id;
                        walked += 1;
                    };
                };
            };
        };
    };

    public func binding(value : LocatedNode) : Types.NodeBinding {
        {
            node_id = value.node_id;
            parent_id = value.node.parent_id;
            kind = ?(switch (value.node.kind) {
                case (#folder(_)) #folder;
                case (#file(_)) #file;
            });
            structural_revision = value.node.structural_revision;
            metadata_revision = value.node.metadata_revision;
            children_revision = value.node.children_revision;
            declared_name_scalars = value.node.declared_name_scalars;
            subtree_height = value.node.subtree_height;
            max_relative_path_scalars =
                value.node.max_relative_path_scalars;
            subtree_plaintext_bytes = Nat64.fromNat(
                value.node.subtree_plaintext_bytes
            );
            encrypted_metadata_bytes = Nat32.fromNat(
                value.node.encrypted_metadata.size()
            );
            active = switch (value.node.state) {
                case (#active) true;
                case (_) false;
            };
        };
    };

    public func summary(value : LocatedNode) : Frames.FrameNodeSummary {
        {
            node_id = value.node_id;
            parent_id = value.node.parent_id;
            kind = ?(switch (value.node.kind) {
                case (#folder(_)) #folder;
                case (#file(_)) #file;
            });
            name_tag = Frames.digestFromTag(value.node.name_tag);
            declared_name_scalars = value.node.declared_name_scalars;
            structural_revision = value.node.structural_revision;
            metadata_revision = value.node.metadata_revision;
            children_revision = value.node.children_revision;
            subtree_height = value.node.subtree_height;
            max_relative_path_scalars =
                value.node.max_relative_path_scalars;
            subtree_plaintext_bytes = Nat64.fromNat(
                value.node.subtree_plaintext_bytes
            );
        };
    };

    public func content(
        node : Memory.Node
    ) : ?Memory.ContentRecord {
        switch (node.kind) {
            case (#folder(_)) null;
            case (#file(file)) file.active_content;
        };
    };

    public func contentDescriptor(
        value : Memory.ContentRecord
    ) : Types.ContentDescriptor {
        {
            content_id = value.content_id;
            block_count = value.block_count;
            ciphertext_bytes = Nat64.fromNat(value.ciphertext_bytes);
            crypto_profile = ?#aes_256_gcm_files_v2;
        };
    };

    public func contentSummary(
        value : Memory.ContentRecord
    ) : Frames.FrameContentSummary {
        {
            content_id = value.content_id;
            block_count = value.block_count;
            ciphertext_bytes = Nat64.fromNat(value.ciphertext_bytes);
            crypto_profile = ?#aes_256_gcm_files_v2;
        };
    };

    public func contentPlaintext(value : Memory.ContentRecord) : ?Nat {
        let tags = Nat32.toNat(value.block_count) * 16;
        if (value.block_count == 0 or value.ciphertext_bytes < tags) return null;
        ?(value.ciphertext_bytes - tags);
    };
};
