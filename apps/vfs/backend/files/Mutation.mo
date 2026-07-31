import Array "mo:core/Array";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import Memory "../memory/files/v1";
import Accounting "Accounting";
import Frames "Frames";
import Keys "Keys";
import Tree "Tree";
import Types "Types";

module {
    public type Plan = {
        node_mutations : [Memory.NodeMutation];
        child_index_mutations : [Memory.ChildIndexMutation];
        node_count_after : Nat;
        physical_before : Nat;
        physical_after : Nat;
        result_node : Memory.Node;
    };

    public type ExplicitWriteNode = {
        node_id : Types.Id128;
        expected : ?Memory.Node;
        replacement : Memory.Node;
    };

    public func plan(
        mem : Memory.Mem,
        control : Frames.MutateFrameControl,
        rawPayload : Frames.RawPayload,
    ) : Types.Result<Plan> {
        let ?action = control.action else {
            return #err(Types.reject(#incompatible));
        };
        let transition = control.node;
        if (
            transition.node_id == Types.ROOT_NODE_ID or
            transition.proposed_parent_id == transition.node_id or
            transition.proposed_name_tag ==
                Frames.digestFromTag(Types.ZERO_TAG) or
            transition.declared_name_scalars == 0 or
            transition.declared_name_scalars > Types.MAX_NAME_SCALARS
        ) return #err(Types.reject(#invalid_request));
        let ?encryptedMetadata = Frames.payloadSlice(
            rawPayload,
            transition.encrypted_metadata,
        ) else return #err(Types.reject(#invalid_request));

        let tree = Tree.Tree(mem);
        let working = Map.empty<Types.Id128, Memory.Node>();
        let explicitIds = Map.empty<Types.Id128, ()>();
        Map.add(
            explicitIds,
            Keys.compareId128,
            transition.node_id,
            (),
        );
        let candidateFolders =
            Map.empty<Types.Id128, Memory.Node>();
        let childChanges =
            Map.empty<Memory.ChildNameKey, Memory.ChildIndexMutation>();
        var nodeCountAfter = mem.node_count;
        let resultNode : Memory.Node = switch (action) {
            case (#create_folder) {
                if (
                    transition.expected_parent_id != null or
                    transition.expected_name_tag != null or
                    transition.expected_structural_revision != null or
                    transition.expected_metadata_revision != null or
                    transition.expected_children_revision != null or
                    transition.expected_subtree_height != null or
                    transition.expected_max_relative_path_scalars != null or
                    transition.expected_subtree_plaintext_bytes != null or
                    transition.requested_kind != ?#folder or
                    transition.proposed_structural_revision != 1 or
                    transition.proposed_metadata_revision != 1 or
                    transition.proposed_children_revision != 0 or
                    transition.proposed_subtree_height != 0 or
                    transition.proposed_max_relative_path_scalars !=
                        transition.declared_name_scalars or
                    transition.proposed_subtree_plaintext_bytes != 0
                ) return #err(Types.reject(#invalid_request));
                if (
                    Map.get(
                        mem.nodes_by_id,
                        Keys.compareId128,
                        transition.node_id,
                    ) != null
                ) return #err(Types.reject(#id_collision));
                if (nodeCountAfter >= Types.MAX_NODES) {
                    return #err(Types.reject(#quota));
                };
                let parentResult = tree.reachable(
                    transition.proposed_parent_id
                );
                let #ok(parent) = parentResult else {
                    let #err(error) = parentResult else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    return #err(error);
                };
                switch (
                    collectPersistedAncestorCandidates(
                        mem,
                        candidateFolders,
                        transition.proposed_parent_id,
                        0,
                    )
                ) {
                    case (#err(error)) return #err(error);
                    case (#ok) {};
                };
                switch (parent.node.kind) {
                    case (#file(_)) return #err(Types.reject(#not_folder));
                    case (#folder(_)) {};
                };
                if (
                    Map.get(
                        mem.children_by_name,
                        Keys.compareChildNameKey,
                        Keys.childNameKey(
                            transition.proposed_parent_id,
                            Frames.digestToTag(
                                transition.proposed_name_tag
                            ),
                        ),
                    ) != null
                ) return #err(Types.reject(#already_exists));
                let depthResult = tree.depth(parent.node_id);
                let #ok(parentDepth) = depthResult else {
                    let #err(error) = depthResult else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    return #err(error);
                };
                if (parentDepth == Types.MAX_TREE_DEPTH) {
                    return #err(Types.reject(#batch_structure_limit));
                };
                let created : Memory.Node = {
                    parent_id = transition.proposed_parent_id;
                    kind = #folder({
                        direct_child_count = 0;
                        child_subtree_heights = [];
                        child_relative_path_scalars = [];
                    });
                    state = #active;
                    name_tag = Frames.digestToTag(
                        transition.proposed_name_tag
                    );
                    declared_name_scalars =
                        transition.declared_name_scalars;
                    structural_revision = 1;
                    metadata_revision = 1;
                    children_revision = 0;
                    subtree_height = 0;
                    max_relative_path_scalars =
                        transition.declared_name_scalars;
                    subtree_plaintext_bytes = 0;
                    encrypted_metadata = encryptedMetadata;
                };
                Map.add(
                    working,
                    Keys.compareId128,
                    transition.node_id,
                    created,
                );
                let addResult = changeEdge(
                    mem,
                    working,
                    childChanges,
                    transition.proposed_parent_id,
                    null,
                    ?{ node_id = transition.node_id; node = created },
                    true,
                );
                switch (addResult) {
                    case (#err(error)) return #err(error);
                    case (#ok) {};
                };
                nodeCountAfter += 1;
                created;
            };
            case (#rename or #move) {
                let selectedResult = tree.reachable(transition.node_id);
                let #ok(selected) = selectedResult else {
                    let #err(error) = selectedResult else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    return #err(error);
                };
                let old = selected.node;
                switch (
                    collectPersistedAncestorCandidates(
                        mem,
                        candidateFolders,
                        old.parent_id,
                        0,
                    )
                ) {
                    case (#err(error)) return #err(error);
                    case (#ok) {};
                };
                let requestedKind = switch (transition.requested_kind) {
                    case (?#folder) #folder;
                    case (?#file) #file;
                    case null return #err(Types.reject(#incompatible));
                };
                if (
                    not transitionMatchesExisting(transition, old) or
                    (requestedKind == #folder and
                        (switch (old.kind) {
                            case (#folder(_)) false;
                            case (_) true;
                        })) or
                    (requestedKind == #file and
                        (switch (old.kind) {
                            case (#file(_)) false;
                            case (_) true;
                        })) or
                    old.structural_revision == Nat64.maxValue or
                    old.metadata_revision == Nat64.maxValue or
                    transition.proposed_structural_revision !=
                        old.structural_revision + 1 or
                    transition.proposed_metadata_revision !=
                        old.metadata_revision + 1 or
                    transition.proposed_children_revision !=
                        old.children_revision or
                    transition.proposed_subtree_height != old.subtree_height or
                    transition.proposed_subtree_plaintext_bytes !=
                        Nat64.fromNat(old.subtree_plaintext_bytes)
                ) return #err(Types.reject(#stale_revision));
                let moving = action == #move;
                if (
                    (moving and
                        transition.proposed_parent_id == old.parent_id) or
                    (not moving and
                        transition.proposed_parent_id != old.parent_id)
                ) return #err(Types.reject(#invalid_request));
                let oldKey = Keys.childNameKey(
                    old.parent_id,
                    old.name_tag,
                );
                let proposedKey = Keys.childNameKey(
                    transition.proposed_parent_id,
                    Frames.digestToTag(transition.proposed_name_tag),
                );
                if (oldKey == proposedKey) {
                    return #err(Types.reject(#invalid_request));
                };
                if (
                    Map.get(
                        mem.children_by_name,
                        Keys.compareChildNameKey,
                        proposedKey,
                    ) != null
                ) return #err(Types.reject(#already_exists));
                let newParentResult = tree.reachable(
                    transition.proposed_parent_id
                );
                let #ok(newParent) = newParentResult else {
                    let #err(error) = newParentResult else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    return #err(error);
                };
                if (moving) {
                    switch (
                        collectPersistedAncestorCandidates(
                            mem,
                            candidateFolders,
                            transition.proposed_parent_id,
                            0,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                };
                switch (newParent.node.kind) {
                    case (#file(_)) return #err(Types.reject(#not_folder));
                    case (#folder(_)) {};
                };
                if (moving) {
                    let within = tree.isWithin(
                        transition.node_id,
                        transition.proposed_parent_id,
                    );
                    switch (within) {
                        case (#err(error)) return #err(error);
                        case (#ok(true)) return #err(Types.reject(#conflict));
                        case (#ok(false)) {};
                    };
                    let depthResult = tree.depth(
                        transition.proposed_parent_id
                    );
                    let #ok(parentDepth) = depthResult else {
                        let #err(error) = depthResult else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        return #err(error);
                    };
                    if (
                        Nat8.toNat(parentDepth) + 1 +
                            Nat8.toNat(old.subtree_height) >
                            Nat8.toNat(Types.MAX_TREE_DEPTH)
                    ) return #err(Types.reject(#batch_structure_limit));
                };
                switch (old.kind) {
                    case (#folder(folder)) {
                        if (
                            not validFolderState(
                                transition.node_id,
                                old,
                                folder,
                            )
                        ) return #err(Types.reject(#corrupt_state));
                    };
                    case (#file(_)) {};
                };
                let proposedMax = relativeMaximum(
                    transition.node_id,
                    transition.declared_name_scalars,
                    old.kind,
                );
                let ?newMaximum = proposedMax else {
                    return #err(Types.reject(#batch_structure_limit));
                };
                if (
                    transition.proposed_max_relative_path_scalars != newMaximum
                ) return #err(Types.reject(#invalid_request));
                let replacement : Memory.Node = {
                    old with
                    parent_id = transition.proposed_parent_id;
                    name_tag = Frames.digestToTag(
                        transition.proposed_name_tag
                    );
                    declared_name_scalars =
                        transition.declared_name_scalars;
                    structural_revision =
                        transition.proposed_structural_revision;
                    metadata_revision =
                        transition.proposed_metadata_revision;
                    max_relative_path_scalars = newMaximum;
                    encrypted_metadata = encryptedMetadata;
                };
                Map.add(
                    working,
                    Keys.compareId128,
                    transition.node_id,
                    replacement,
                );
                if (moving) {
                    switch (
                        changeEdge(
                            mem,
                            working,
                            childChanges,
                            old.parent_id,
                            ?selected,
                            null,
                            true,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                    switch (
                        changeEdge(
                            mem,
                            working,
                            childChanges,
                            replacement.parent_id,
                            null,
                            ?{
                                node_id = transition.node_id;
                                node = replacement;
                            },
                            true,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                } else {
                    switch (
                        changeEdge(
                            mem,
                            working,
                            childChanges,
                            old.parent_id,
                            ?selected,
                            ?{
                                node_id = transition.node_id;
                                node = replacement;
                            },
                            true,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                };
                replacement;
            };
        };

        discardNoopFolders(mem, working, explicitIds);
        switch (validateChangedFolderRevisions(mem, working, explicitIds)) {
            case (#err(error)) return #err(error);
            case (#ok) {};
        };
        let validation = validateDeclaredTransitions(
            mem,
            working,
            candidateFolders,
            childChanges,
            transition.node_id,
            control.folder_transitions,
            control.child_index_transitions,
        );
        switch (validation) {
            case (#err(error)) return #err(error);
            case (#ok) {};
        };
        let nodeMutations = List.empty<Memory.NodeMutation>();
        var physicalBefore = 0;
        var physicalAfter = 0;
        for ((nodeId, replacement) in Map.entries(working)) {
            let expected = Map.get(mem.nodes_by_id, Keys.compareId128, nodeId);
            switch (expected) {
                case (?node) physicalBefore += Accounting.nodeCharge(node);
                case null {};
            };
            physicalAfter += Accounting.nodeCharge(replacement);
            List.add(nodeMutations, {
                node_id = nodeId;
                expected;
                replacement = ?replacement;
            });
        };
        let childMutations = List.empty<Memory.ChildIndexMutation>();
        for ((_, mutation) in Map.entries(childChanges)) {
            if (mutation.expected != null) {
                physicalBefore += Accounting.childIndexCharge();
            };
            if (mutation.replacement != null) {
                physicalAfter += Accounting.childIndexCharge();
            };
            List.add(childMutations, mutation);
        };
        #ok({
            node_mutations = List.toArray(nodeMutations);
            child_index_mutations = List.toArray(childMutations);
            node_count_after = nodeCountAfter;
            physical_before = physicalBefore;
            physical_after = physicalAfter;
            result_node = resultNode;
        });
    };

    public func apply(mem : Memory.Mem, plan : Plan) {
        if (plan.physical_after >= plan.physical_before) {
            Accounting.addPhysical(
                mem,
                plan.physical_after - plan.physical_before,
            );
        } else {
            Accounting.removePhysical(
                mem,
                plan.physical_before - plan.physical_after,
            );
        };
        for (mutation in plan.child_index_mutations.values()) {
            switch (mutation.replacement) {
                case null Map.remove(
                    mem.children_by_name,
                    Keys.compareChildNameKey,
                    mutation.key,
                );
                case (?nodeId) Map.add(
                    mem.children_by_name,
                    Keys.compareChildNameKey,
                    mutation.key,
                    nodeId,
                );
            };
        };
        for (mutation in plan.node_mutations.values()) {
            let replacement = switch (mutation.replacement) {
                case (?value) value;
                case null Runtime.trap("validated node replacement missing");
            };
            Map.add(
                mem.nodes_by_id,
                Keys.compareId128,
                mutation.node_id,
                replacement,
            );
        };
        mem.node_count := plan.node_count_after;
    };

    // Backend-driven remove uses the same aggregate/index machinery as move.
    // It only detaches and hides the selected root; bounded physical deletion
    // is performed by the persisted cleanup walk.
    public func planDetach(
        mem : Memory.Mem,
        selected : Tree.LocatedNode,
        cleanupJobId : Nat64,
        hiddenAtNs : Nat64,
    ) : Types.Result<Plan> {
        if (selected.node_id == Types.ROOT_NODE_ID) {
            return #err(Types.reject(#invalid_request));
        };
        switch (selected.node.kind) {
            case (#folder(folder)) {
                if (
                    not validFolderState(
                        selected.node_id,
                        selected.node,
                        folder,
                    )
                ) return #err(Types.reject(#corrupt_state));
            };
            case (#file(_)) {};
        };
        let working = Map.empty<Types.Id128, Memory.Node>();
        let explicitIds = Map.empty<Types.Id128, ()>();
        Map.add(
            explicitIds,
            Keys.compareId128,
            selected.node_id,
            (),
        );
        let childChanges =
            Map.empty<Memory.ChildNameKey, Memory.ChildIndexMutation>();
        switch (
            changeEdge(
                mem,
                working,
                childChanges,
                selected.node.parent_id,
                ?selected,
                null,
                true,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok) {};
        };
        let hidden : Memory.Node = {
            selected.node with
            state = #hidden({
                cleanup_job_id = cleanupJobId;
                hidden_at_ns = hiddenAtNs;
            });
        };
        Map.add(
            working,
            Keys.compareId128,
            selected.node_id,
            hidden,
        );
        discardNoopFolders(mem, working, explicitIds);
        switch (validateChangedFolderRevisions(mem, working, explicitIds)) {
            case (#err(error)) return #err(error);
            case (#ok) {};
        };
        let nodeMutations = List.empty<Memory.NodeMutation>();
        var physicalBefore = 0;
        var physicalAfter = 0;
        for ((nodeId, replacement) in Map.entries(working)) {
            let expected = Map.get(
                mem.nodes_by_id,
                Keys.compareId128,
                nodeId,
            );
            switch (expected) {
                case (?node) physicalBefore += Accounting.nodeCharge(node);
                case null return #err(Types.reject(#corrupt_state));
            };
            physicalAfter += Accounting.nodeCharge(replacement);
            List.add(nodeMutations, {
                node_id = nodeId;
                expected;
                replacement = ?replacement;
            });
        };
        let childMutations = List.empty<Memory.ChildIndexMutation>();
        for ((_, mutation) in Map.entries(childChanges)) {
            if (mutation.expected != null) {
                physicalBefore += Accounting.childIndexCharge();
            };
            if (mutation.replacement != null) {
                physicalAfter += Accounting.childIndexCharge();
            };
            List.add(childMutations, mutation);
        };
        #ok({
            node_mutations = List.toArray(nodeMutations);
            child_index_mutations = List.toArray(childMutations);
            node_count_after = mem.node_count;
            physical_before = physicalBefore;
            physical_after = physicalAfter;
            result_node = hidden;
        });
    };

    // Applies a fully decoded write's explicit node replacements, derives all
    // affected existing-folder aggregates, and verifies that the client's
    // frozen transition vectors describe exactly that derived state.
    public func planWriteStructure(
        mem : Memory.Mem,
        explicit : [ExplicitWriteNode],
        folderTransitions : [Frames.FolderAggregateTransition],
        childTransitions : [Frames.ChildIndexTransition],
        nodeCountAfter : Nat,
    ) : Types.Result<Plan> {
        let working = Map.empty<Types.Id128, Memory.Node>();
        let explicitIds = Map.empty<Types.Id128, ()>();
        let candidateFolders =
            Map.empty<Types.Id128, Memory.Node>();
        let childChanges =
            Map.empty<Memory.ChildNameKey, Memory.ChildIndexMutation>();
        for (entry in explicit.values()) {
            if (
                Map.get(explicitIds, Keys.compareId128, entry.node_id) != null
            ) return #err(Types.reject(#conflict));
            Map.add(explicitIds, Keys.compareId128, entry.node_id, ());
            Map.add(
                working,
                Keys.compareId128,
                entry.node_id,
                entry.replacement,
            );
        };
        for (entry in explicit.values()) {
            switch (entry.expected) {
                case null {};
                case (?old) {
                    switch (
                        collectWriteAncestorCandidates(
                            mem,
                            explicit,
                            candidateFolders,
                            old.parent_id,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                };
            };
            switch (
                collectWriteAncestorCandidates(
                    mem,
                    explicit,
                    candidateFolders,
                    entry.replacement.parent_id,
                )
            ) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
        };
        for (entry in explicit.values()) {
            switch (entry.expected) {
                case null {
                    let edge = Keys.childNameKey(
                        entry.replacement.parent_id,
                        entry.replacement.name_tag,
                    );
                    if (
                        Map.get(
                            mem.children_by_name,
                            Keys.compareChildNameKey,
                            edge,
                        ) != null
                    ) return #err(Types.reject(#already_exists));
                    switch (
                        addChildMutation(
                            mem,
                            childChanges,
                            edge,
                            null,
                            ?entry.node_id,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                    let parentIsNew = switch (
                        Map.get(
                            explicitIds,
                            Keys.compareId128,
                            entry.replacement.parent_id,
                        )
                    ) {
                        case null false;
                        case (?_) {
                            switch (
                                Map.get(
                                    mem.nodes_by_id,
                                    Keys.compareId128,
                                    entry.replacement.parent_id,
                                )
                            ) {
                                case null true;
                                case (?_) false;
                            };
                        };
                    };
                    if (not parentIsNew) {
                        switch (
                            updateParent(
                                mem,
                                working,
                                entry.replacement.parent_id,
                                null,
                                ?{
                                    node_id = entry.node_id;
                                    node = entry.replacement;
                                },
                                true,
                                0,
                            )
                        ) {
                            case (#err(error)) return #err(error);
                            case (#ok) {};
                        };
                    };
                };
                case (?old) {
                    if (
                        old.parent_id != entry.replacement.parent_id or
                        old.name_tag != entry.replacement.name_tag
                    ) return #err(Types.reject(#invalid_request));
                    if (
                        old.subtree_height !=
                            entry.replacement.subtree_height or
                        old.max_relative_path_scalars !=
                            entry.replacement.max_relative_path_scalars or
                        old.subtree_plaintext_bytes !=
                            entry.replacement.subtree_plaintext_bytes
                    ) {
                        switch (
                            updateParent(
                                mem,
                                working,
                                old.parent_id,
                                ?{ node_id = entry.node_id; node = old },
                                ?{
                                    node_id = entry.node_id;
                                    node = entry.replacement;
                                },
                                false,
                                0,
                            )
                        ) {
                            case (#err(error)) return #err(error);
                            case (#ok) {};
                        };
                    };
                };
            };
        };
        if (childTransitions.size() != Map.size(childChanges)) {
            return #err(Types.reject(#batch_structure_limit));
        };
        for ((key, expected) in Map.entries(childChanges)) {
            var matches = 0;
            for (declared in childTransitions.values()) {
                if (
                    declared.parent_id == Keys.childKeyParent(key) and
                    Frames.digestToTag(declared.name_tag) ==
                        Keys.childKeyTag(key)
                ) {
                    matches += 1;
                    if (
                        declared.expected_node_id != expected.expected or
                        declared.proposed_node_id != expected.replacement
                    ) return #err(Types.reject(#conflict));
                };
            };
            if (matches != 1) return #err(Types.reject(#conflict));
        };
        discardNoopFolders(mem, working, explicitIds);
        switch (validateChangedFolderRevisions(mem, working, explicitIds)) {
            case (#err(error)) return #err(error);
            case (#ok) {};
        };
        switch (
            validateFolderWitnesses(
                mem,
                candidateFolders,
                folderTransitions,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok) {};
        };
        for ((nodeId, _) in Map.entries(working)) {
            if (
                Map.get(explicitIds, Keys.compareId128, nodeId) == null and
                Map.get(candidateFolders, Keys.compareId128, nodeId) == null
            ) return #err(Types.reject(#corrupt_state));
        };
        let nodeMutations = List.empty<Memory.NodeMutation>();
        var physicalBefore = 0;
        var physicalAfter = 0;
        var resultNode : ?Memory.Node = null;
        for ((nodeId, replacement) in Map.entries(working)) {
            let expected = Map.get(
                mem.nodes_by_id,
                Keys.compareId128,
                nodeId,
            );
            switch (expected) {
                case (?node) physicalBefore += Accounting.nodeCharge(node);
                case null {};
            };
            physicalAfter += Accounting.nodeCharge(replacement);
            List.add(nodeMutations, {
                node_id = nodeId;
                expected;
                replacement = ?replacement;
            });
            if (resultNode == null) resultNode := ?replacement;
        };
        let childMutations = List.empty<Memory.ChildIndexMutation>();
        for ((_, mutation) in Map.entries(childChanges)) {
            if (mutation.expected != null) {
                physicalBefore += Accounting.childIndexCharge();
            };
            if (mutation.replacement != null) {
                physicalAfter += Accounting.childIndexCharge();
            };
            List.add(childMutations, mutation);
        };
        let ?oneResult = resultNode else {
            return #err(Types.reject(#invalid_request));
        };
        #ok({
            node_mutations = List.toArray(nodeMutations);
            child_index_mutations = List.toArray(childMutations);
            node_count_after = nodeCountAfter;
            physical_before = physicalBefore;
            physical_after = physicalAfter;
            result_node = oneResult;
        });
    };

    func transitionMatchesExisting(
        transition : Frames.NodeTransitionFrame,
        old : Memory.Node,
    ) : Bool {
        transition.expected_parent_id == ?old.parent_id and
        transition.expected_name_tag ==
            ?Frames.digestFromTag(old.name_tag) and
        transition.expected_structural_revision ==
            ?old.structural_revision and
        transition.expected_metadata_revision == ?old.metadata_revision and
        transition.expected_children_revision == ?old.children_revision and
        transition.expected_subtree_height == ?old.subtree_height and
        transition.expected_max_relative_path_scalars ==
            ?old.max_relative_path_scalars and
        transition.expected_subtree_plaintext_bytes ==
            ?Nat64.fromNat(old.subtree_plaintext_bytes);
    };

    func relativeMaximum(
        nodeId : Types.Id128,
        nameScalars : Nat16,
        kind : Memory.NodeKind,
    ) : ?Nat16 {
        switch (kind) {
            case (#file(_)) ?nameScalars;
            case (#folder(folder)) {
                if (folder.direct_child_count == 0) return ?nameScalars;
                let ?maximum = lastPath(folder.child_relative_path_scalars) else {
                    return null;
                };
                let total = Nat16.toNat(nameScalars) + 1 + Nat16.toNat(maximum);
                if (total > Nat16.toNat(Types.MAX_PATH_SCALARS)) null else {
                    ?Nat16.fromNat(total);
                };
            };
        };
    };

    func changeEdge(
        mem : Memory.Mem,
        working : Map.Map<Types.Id128, Memory.Node>,
        childChanges : Map.Map<
            Memory.ChildNameKey,
            Memory.ChildIndexMutation,
        >,
        parentId : Types.Id128,
        oldChild : ?Tree.LocatedNode,
        newChild : ?Tree.LocatedNode,
        membership : Bool,
    ) : Types.Result<()> {
        switch (oldChild) {
            case (?old) switch (
                addChildMutation(
                    mem,
                    childChanges,
                    Keys.childNameKey(parentId, old.node.name_tag),
                    ?old.node_id,
                    null,
                )
            ) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            case null {};
        };
        switch (newChild) {
            case (?new) switch (
                addChildMutation(
                    mem,
                    childChanges,
                    Keys.childNameKey(parentId, new.node.name_tag),
                    null,
                    ?new.node_id,
                )
            ) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            case null {};
        };
        updateParent(
            mem,
            working,
            parentId,
            oldChild,
            newChild,
            membership,
            0,
        );
    };

    func updateParent(
        mem : Memory.Mem,
        working : Map.Map<Types.Id128, Memory.Node>,
        parentId : Types.Id128,
        oldChild : ?Tree.LocatedNode,
        newChild : ?Tree.LocatedNode,
        membership : Bool,
        depth : Nat,
    ) : Types.Result<()> {
        if (depth > Nat8.toNat(Types.MAX_TREE_DEPTH)) {
            return #err(Types.reject(#corrupt_state));
        };
        let current = switch (
            Map.get(working, Keys.compareId128, parentId)
        ) {
            case (?value) value;
            case null switch (
                Map.get(mem.nodes_by_id, Keys.compareId128, parentId)
            ) {
                case (?value) value;
                case null return #err(Types.reject(#corrupt_state));
            };
        };
        switch (current.state) {
            case (#hidden(_)) return #err(Types.reject(#not_found));
            case (#active) {};
        };
        let folder = switch (current.kind) {
            case (#file(_)) return #err(Types.reject(#not_folder));
            case (#folder(value)) value;
        };
        let changed = updateFolder(parentId, current, folder, oldChild, newChild);
        let ?updatedBase = changed else {
            return #err(Types.reject(#corrupt_state));
        };
        let original = switch (
            Map.get(mem.nodes_by_id, Keys.compareId128, parentId)
        ) {
            case (?value) value;
            case null current;
        };
        if (membership and original.children_revision == Nat64.maxValue) {
            return #err(Types.reject(#stale_revision));
        };
        let updated : Memory.Node = {
            updatedBase with
            // A converging old/new ancestor path can change this node
            // transiently and then restore its exact aggregate. Defer the
            // structural overflow rejection until the final changed subset is
            // known, avoiding arithmetic wrap/trap for a final no-op.
            structural_revision =
                if (original.structural_revision == Nat64.maxValue) {
                    original.structural_revision
                } else {
                    original.structural_revision + 1
                };
            children_revision = if (membership) {
                // One atomic mutation advances a folder's membership
                // revision exactly once, even when the plan inserts or
                // removes several direct children.
                original.children_revision + 1
            } else {
                current.children_revision
            };
        };
        Map.add(working, Keys.compareId128, parentId, updated);
        if (
            parentId != Types.ROOT_NODE_ID and
            (current.subtree_height != updated.subtree_height or
            current.max_relative_path_scalars !=
                updated.max_relative_path_scalars or
            current.subtree_plaintext_bytes !=
                updated.subtree_plaintext_bytes)
        ) {
            updateParent(
                mem,
                working,
                current.parent_id,
                ?{ node_id = parentId; node = current },
                ?{ node_id = parentId; node = updated },
                false,
                depth + 1,
            );
        } else {
            #ok;
        };
    };

    func updateFolder(
        parentId : Types.Id128,
        parent : Memory.Node,
        folder : Memory.FolderRecord,
        oldChild : ?Tree.LocatedNode,
        newChild : ?Tree.LocatedNode,
    ) : ?Memory.Node {
        if (not validFolderState(parentId, parent, folder)) return null;
        var count = Nat32.toNat(folder.direct_child_count);
        var heights = folder.child_subtree_heights;
        var paths = folder.child_relative_path_scalars;
        var plaintext = parent.subtree_plaintext_bytes;
        switch (oldChild) {
            case (?old) {
                if (count == 0 or plaintext < old.node.subtree_plaintext_bytes) {
                    return null;
                };
                count -= 1;
                plaintext -= old.node.subtree_plaintext_bytes;
                let ?nextHeights = removeHeight(
                    heights,
                    old.node.subtree_height,
                ) else return null;
                heights := nextHeights;
                let ?nextPaths = removePath(
                    paths,
                    old.node.max_relative_path_scalars,
                ) else return null;
                paths := nextPaths;
            };
            case null {};
        };
        switch (newChild) {
            case (?new) {
                if (count == 4_294_967_295) return null;
                count += 1;
                plaintext += new.node.subtree_plaintext_bytes;
                let ?nextHeights = addHeight(
                    heights,
                    new.node.subtree_height,
                ) else return null;
                heights := nextHeights;
                let ?nextPaths = addPath(
                    paths,
                    new.node.max_relative_path_scalars,
                ) else return null;
                paths := nextPaths;
            };
            case null {};
        };
        let height : Nat8 = if (count == 0) {
            0;
        } else {
            let ?maximum = lastHeight(heights) else return null;
            if (maximum == Types.MAX_TREE_DEPTH) return null;
            maximum + 1;
        };
        let maximumPath : Nat16 = if (count == 0) {
            if (parentId == Types.ROOT_NODE_ID) 0 else {
                parent.declared_name_scalars;
            };
        } else {
            let ?childMaximum = lastPath(paths) else return null;
            if (parentId == Types.ROOT_NODE_ID) {
                childMaximum;
            } else {
                let total = Nat16.toNat(parent.declared_name_scalars) + 1 +
                    Nat16.toNat(childMaximum);
                if (total > Nat16.toNat(Types.MAX_PATH_SCALARS)) return null;
                Nat16.fromNat(total);
            };
        };
        ?{
            parent with
            kind = #folder({
                direct_child_count = Nat32.fromNat(count);
                child_subtree_heights = heights;
                child_relative_path_scalars = paths;
            });
            subtree_height = height;
            max_relative_path_scalars = maximumPath;
            subtree_plaintext_bytes = plaintext;
        };
    };

    func validFolderState(
        parentId : Types.Id128,
        parent : Memory.Node,
        folder : Memory.FolderRecord,
    ) : Bool {
        if (
            parentId == Types.ROOT_NODE_ID and
            (
                parent.parent_id != Types.ROOT_NODE_ID or
                parent.name_tag != Types.ZERO_TAG or
                parent.declared_name_scalars != 0
            )
        ) return false;
        if (
            parentId != Types.ROOT_NODE_ID and
            (
                parent.declared_name_scalars == 0 or
                parent.declared_name_scalars > Types.MAX_NAME_SCALARS
            )
        ) return false;

        let direct = Nat32.toNat(folder.direct_child_count);
        if (direct >= Types.MAX_NODES) return false;
        var heightTotal = 0;
        var previousHeight : ?Nat8 = null;
        for (entry in folder.child_subtree_heights.values()) {
            if (entry.count == 0 or entry.value >= Types.MAX_TREE_DEPTH) {
                return false;
            };
            switch (previousHeight) {
                case (?previous) if (entry.value <= previous) {
                    return false;
                };
                case (_) {};
            };
            previousHeight := ?entry.value;
            heightTotal += Nat32.toNat(entry.count);
            if (heightTotal > direct) return false;
        };

        var pathTotal = 0;
        var previousPath : ?Nat16 = null;
        for (entry in folder.child_relative_path_scalars.values()) {
            if (
                entry.count == 0 or entry.value == 0 or
                entry.value > Types.MAX_PATH_SCALARS
            ) return false;
            switch (previousPath) {
                case (?previous) if (entry.value <= previous) {
                    return false;
                };
                case (_) {};
            };
            previousPath := ?entry.value;
            pathTotal += Nat32.toNat(entry.count);
            if (pathTotal > direct) return false;
        };
        if (heightTotal != direct or pathTotal != direct) return false;

        if (direct == 0) {
            return folder.child_subtree_heights.size() == 0 and
                folder.child_relative_path_scalars.size() == 0 and
                parent.subtree_height == 0 and
                parent.max_relative_path_scalars ==
                    (
                        if (parentId == Types.ROOT_NODE_ID) (0 : Nat16) else {
                            parent.declared_name_scalars
                        }
                    );
        };

        let ?maximumHeight = previousHeight else return false;
        let ?maximumPath = previousPath else return false;
        if (
            parent.subtree_height != maximumHeight + 1
        ) return false;
        if (parentId == Types.ROOT_NODE_ID) {
            parent.max_relative_path_scalars == maximumPath
        } else {
            let expectedPath =
                Nat16.toNat(parent.declared_name_scalars) + 1 +
                Nat16.toNat(maximumPath);
            expectedPath <= Nat16.toNat(Types.MAX_PATH_SCALARS) and
            parent.max_relative_path_scalars ==
                Nat16.fromNat(expectedPath)
        };
    };

    func addChildMutation(
        mem : Memory.Mem,
        changes : Map.Map<
            Memory.ChildNameKey,
            Memory.ChildIndexMutation,
        >,
        key : Memory.ChildNameKey,
        expected : ?Types.Id128,
        replacement : ?Types.Id128,
    ) : Types.Result<()> {
        let actual = Map.get(
            mem.children_by_name,
            Keys.compareChildNameKey,
            key,
        );
        switch (Map.get(changes, Keys.compareChildNameKey, key)) {
            case null {
                if (expected != actual) {
                    return #err(Types.reject(#conflict));
                };
                Map.add(
                    changes,
                    Keys.compareChildNameKey,
                    key,
                    { key; expected = actual; replacement },
                );
            };
            case (?prior) {
                if (expected != prior.replacement) {
                    return #err(Types.reject(#conflict));
                };
                Map.add(
                    changes,
                    Keys.compareChildNameKey,
                    key,
                    {
                        key;
                        expected = prior.expected;
                        replacement;
                    },
                );
            };
        };
        #ok;
    };

    // Collects the complete persisted parent-to-root chain. The candidate map
    // is a set, so converging old/new paths share each ancestor exactly once.
    // Every traversed edge is checked against the canonical child index while
    // collecting the witness set.
    func collectPersistedAncestorCandidates(
        mem : Memory.Mem,
        candidates : Map.Map<Types.Id128, Memory.Node>,
        startId : Types.Id128,
        traversed : Nat,
    ) : Types.Result<()> {
        var currentId = startId;
        var depth = traversed;
        label ancestors loop {
            if (
                Map.get(candidates, Keys.compareId128, currentId) != null
            ) return #ok;
            let ?current = Map.get(
                mem.nodes_by_id,
                Keys.compareId128,
                currentId,
            ) else return #err(Types.reject(#not_found));
            switch (current.state, current.kind) {
                case (#active, #folder(_)) {};
                case (#hidden(_), _) return #err(Types.reject(#not_found));
                case (_) return #err(Types.reject(#corrupt_state));
            };
            Map.add(
                candidates,
                Keys.compareId128,
                currentId,
                current,
            );
            if (currentId == Types.ROOT_NODE_ID) {
                if (
                    current.parent_id != Types.ROOT_NODE_ID or
                    current.name_tag != Types.ZERO_TAG
                ) return #err(Types.reject(#corrupt_state));
                return #ok;
            };
            if (depth >= Nat8.toNat(Types.MAX_TREE_DEPTH)) {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                Map.get(
                    mem.children_by_name,
                    Keys.compareChildNameKey,
                    Keys.childNameKey(
                        current.parent_id,
                        current.name_tag,
                    ),
                ) != ?currentId
            ) return #err(Types.reject(#corrupt_state));
            currentId := current.parent_id;
            depth += 1;
        };
        #err(Types.reject(#corrupt_state));
    };

    func findExplicit(
        explicit : [ExplicitWriteNode],
        nodeId : Types.Id128,
    ) : ?ExplicitWriteNode {
        for (entry in explicit.values()) {
            if (entry.node_id == nodeId) return ?entry;
        };
        null;
    };

    // A batch may name a newly synthesized folder as a parent. New nodes have
    // no CAS witness, so walk through the bounded explicit graph until the
    // first persisted folder and then collect its complete chain to root.
    func collectWriteAncestorCandidates(
        mem : Memory.Mem,
        explicit : [ExplicitWriteNode],
        candidates : Map.Map<Types.Id128, Memory.Node>,
        startId : Types.Id128,
    ) : Types.Result<()> {
        let visited = Map.empty<Types.Id128, ()>();
        var currentId = startId;
        var depth = 0;
        label ancestors loop {
            if (
                Map.get(
                    mem.nodes_by_id,
                    Keys.compareId128,
                    currentId,
                ) != null
            ) {
                return collectPersistedAncestorCandidates(
                    mem,
                    candidates,
                    currentId,
                    depth,
                );
            };
            if (
                depth >= Nat8.toNat(Types.MAX_TREE_DEPTH) or
                currentId == Types.ROOT_NODE_ID or
                Map.get(visited, Keys.compareId128, currentId) != null
            ) return #err(Types.reject(#batch_structure_limit));
            Map.add(visited, Keys.compareId128, currentId, ());
            let ?entry = findExplicit(explicit, currentId) else {
                return #err(Types.reject(#not_found));
            };
            if (entry.expected != null) {
                return #err(Types.reject(#corrupt_state));
            };
            switch (entry.replacement.state, entry.replacement.kind) {
                case (#active, #folder(_)) {};
                case (_) return #err(Types.reject(#not_folder));
            };
            currentId := entry.replacement.parent_id;
            depth += 1;
        };
        #err(Types.reject(#corrupt_state));
    };

    func sameHeightCounts(
        left : [Memory.HeightCount],
        right : [Memory.HeightCount],
    ) : Bool {
        if (left.size() != right.size()) return false;
        var index = 0;
        while (index < left.size()) {
            if (
                left[index].value != right[index].value or
                left[index].count != right[index].count
            ) return false;
            index += 1;
        };
        true;
    };

    func samePathCounts(
        left : [Memory.PathScalarCount],
        right : [Memory.PathScalarCount],
    ) : Bool {
        if (left.size() != right.size()) return false;
        var index = 0;
        while (index < left.size()) {
            if (
                left[index].value != right[index].value or
                left[index].count != right[index].count
            ) return false;
            index += 1;
        };
        true;
    };

    func sameDerivedFolderState(
        expected : Memory.Node,
        proposed : Memory.Node,
    ) : Bool {
        if (
            expected.children_revision != proposed.children_revision or
            expected.subtree_height != proposed.subtree_height or
            expected.max_relative_path_scalars !=
                proposed.max_relative_path_scalars or
            expected.subtree_plaintext_bytes !=
                proposed.subtree_plaintext_bytes
        ) return false;
        switch (expected.kind, proposed.kind) {
            case (#folder(left), #folder(right)) {
                left.direct_child_count == right.direct_child_count and
                sameHeightCounts(
                    left.child_subtree_heights,
                    right.child_subtree_heights,
                ) and
                samePathCounts(
                    left.child_relative_path_scalars,
                    right.child_relative_path_scalars,
                );
            };
            case (_) false;
        };
    };

    // Sequential old/new propagation can transiently touch a converging
    // ancestor whose final compact vectors are byte-for-byte unchanged. Such
    // candidate witnesses are still required, but they are not mutations and
    // do not consume a structural revision.
    func discardNoopFolders(
        mem : Memory.Mem,
        working : Map.Map<Types.Id128, Memory.Node>,
        explicitIds : Map.Map<Types.Id128, ()>,
    ) {
        let discarded = List.empty<Types.Id128>();
        for ((nodeId, proposed) in Map.entries(working)) {
            if (
                Map.get(explicitIds, Keys.compareId128, nodeId) == null
            ) {
                switch (
                    Map.get(mem.nodes_by_id, Keys.compareId128, nodeId)
                ) {
                    case (?expected) if (
                        sameDerivedFolderState(expected, proposed)
                    ) List.add(discarded, nodeId);
                    case (_) {};
                };
            };
        };
        for (nodeId in List.toArray(discarded).values()) {
            Map.remove(working, Keys.compareId128, nodeId);
        };
    };

    func validateChangedFolderRevisions(
        mem : Memory.Mem,
        working : Map.Map<Types.Id128, Memory.Node>,
        explicitIds : Map.Map<Types.Id128, ()>,
    ) : Types.Result<()> {
        for ((nodeId, proposed) in Map.entries(working)) {
            if (
                Map.get(explicitIds, Keys.compareId128, nodeId) == null
            ) {
                let ?expected = Map.get(
                    mem.nodes_by_id,
                    Keys.compareId128,
                    nodeId,
                ) else return #err(Types.reject(#corrupt_state));
                if (
                    expected.structural_revision == Nat64.maxValue or
                    proposed.structural_revision !=
                        expected.structural_revision + 1
                ) return #err(Types.reject(#stale_revision));
            };
        };
        #ok;
    };

    // The frame is a canonical CAS witness vector, not a proposed aggregate
    // plan. Exact map-order comparison enforces the complete lexicographically
    // sorted union and rejects missing, extra, duplicate, or reordered IDs.
    func validateFolderWitnesses(
        mem : Memory.Mem,
        candidates : Map.Map<Types.Id128, Memory.Node>,
        declared : [Frames.FolderAggregateTransition],
    ) : Types.Result<()> {
        if (declared.size() != Map.size(candidates)) {
            return #err(Types.reject(#batch_structure_limit));
        };
        var index = 0;
        for ((nodeId, snapshot) in Map.entries(candidates)) {
            let witness = declared[index];
            if (witness.node_id != nodeId) {
                return #err(Types.reject(#batch_structure_limit));
            };
            let ?current = Map.get(
                mem.nodes_by_id,
                Keys.compareId128,
                nodeId,
            ) else return #err(Types.reject(#stale_revision));
            switch (current.state, current.kind) {
                case (#active, #folder(folder)) {
                    if (not validFolderState(nodeId, current, folder)) {
                        return #err(Types.reject(#corrupt_state));
                    };
                };
                case (_) return #err(Types.reject(#corrupt_state));
            };
            if (
                current.structural_revision !=
                    snapshot.structural_revision or
                current.children_revision != snapshot.children_revision or
                witness.expected_structural_revision !=
                    current.structural_revision or
                witness.expected_children_revision !=
                    current.children_revision
            ) return #err(Types.reject(#stale_revision));
            index += 1;
        };
        #ok;
    };

    func validateDeclaredTransitions(
        mem : Memory.Mem,
        working : Map.Map<Types.Id128, Memory.Node>,
        candidateFolders : Map.Map<Types.Id128, Memory.Node>,
        childChanges : Map.Map<
            Memory.ChildNameKey,
            Memory.ChildIndexMutation,
        >,
        explicitNodeId : Types.Id128,
        folderTransitions : [Frames.FolderAggregateTransition],
        childTransitions : [Frames.ChildIndexTransition],
    ) : Types.Result<()> {
        switch (
            validateFolderWitnesses(
                mem,
                candidateFolders,
                folderTransitions,
            )
        ) {
            case (#err(error)) return #err(error);
            case (#ok) {};
        };
        for ((nodeId, proposed) in Map.entries(working)) {
            if (nodeId != explicitNodeId) {
                if (
                    Map.get(
                        candidateFolders,
                        Keys.compareId128,
                        nodeId,
                    ) == null
                ) return #err(Types.reject(#corrupt_state));
                let ?expected = Map.get(
                    mem.nodes_by_id,
                    Keys.compareId128,
                    nodeId,
                ) else return #err(Types.reject(#corrupt_state));
                switch (expected.kind, proposed.kind) {
                    case (#folder(_), #folder(_)) {};
                    case (_) return #err(Types.reject(#corrupt_state));
                };
            };
        };
        if (childTransitions.size() != Map.size(childChanges)) {
            return #err(Types.reject(#batch_structure_limit));
        };
        for ((key, expected) in Map.entries(childChanges)) {
            var matches = 0;
            for (declared in childTransitions.values()) {
                if (
                    declared.parent_id == Keys.childKeyParent(key) and
                    Frames.digestToTag(declared.name_tag) ==
                        Keys.childKeyTag(key)
                ) {
                    matches += 1;
                    if (
                        declared.expected_node_id != expected.expected or
                        declared.proposed_node_id != expected.replacement
                    ) return #err(Types.reject(#conflict));
                };
            };
            if (matches != 1) return #err(Types.reject(#conflict));
        };
        #ok;
    };

    func addHeight(
        values : [Memory.HeightCount],
        value : Nat8,
    ) : ?[Memory.HeightCount] {
        let out = List.empty<Memory.HeightCount>();
        var inserted = false;
        for (entry in values.values()) {
            if (entry.value == value) {
                if (entry.count == 4_294_967_295) return null;
                List.add(out, { value; count = entry.count + 1 });
                inserted := true;
            } else {
                if (not inserted and value < entry.value) {
                    List.add(
                        out,
                        ({ value; count = 1 } : Memory.HeightCount),
                    );
                    inserted := true;
                };
                List.add(out, entry);
            };
        };
        if (not inserted) {
            List.add(out, ({ value; count = 1 } : Memory.HeightCount));
        };
        ?List.toArray(out);
    };

    func removeHeight(
        values : [Memory.HeightCount],
        value : Nat8,
    ) : ?[Memory.HeightCount] {
        let out = List.empty<Memory.HeightCount>();
        var found = false;
        for (entry in values.values()) {
            if (entry.value == value) {
                if (found or entry.count == 0) return null;
                found := true;
                if (entry.count > 1) {
                    List.add(out, { value; count = entry.count - 1 });
                };
            } else List.add(out, entry);
        };
        if (not found) null else ?List.toArray(out);
    };

    func addPath(
        values : [Memory.PathScalarCount],
        value : Nat16,
    ) : ?[Memory.PathScalarCount] {
        let out = List.empty<Memory.PathScalarCount>();
        var inserted = false;
        for (entry in values.values()) {
            if (entry.value == value) {
                if (entry.count == 4_294_967_295) return null;
                List.add(out, { value; count = entry.count + 1 });
                inserted := true;
            } else {
                if (not inserted and value < entry.value) {
                    List.add(
                        out,
                        ({ value; count = 1 } : Memory.PathScalarCount),
                    );
                    inserted := true;
                };
                List.add(out, entry);
            };
        };
        if (not inserted) {
            List.add(out, ({ value; count = 1 } : Memory.PathScalarCount));
        };
        ?List.toArray(out);
    };

    func removePath(
        values : [Memory.PathScalarCount],
        value : Nat16,
    ) : ?[Memory.PathScalarCount] {
        let out = List.empty<Memory.PathScalarCount>();
        var found = false;
        for (entry in values.values()) {
            if (entry.value == value) {
                if (found or entry.count == 0) return null;
                found := true;
                if (entry.count > 1) {
                    List.add(out, { value; count = entry.count - 1 });
                };
            } else List.add(out, entry);
        };
        if (not found) null else ?List.toArray(out);
    };

    func lastHeight(values : [Memory.HeightCount]) : ?Nat8 {
        if (values.size() == 0) null else ?values[values.size() - 1].value;
    };

    func lastPath(values : [Memory.PathScalarCount]) : ?Nat16 {
        if (values.size() == 0) null else ?values[values.size() - 1].value;
    };
};
