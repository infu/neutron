import NeutronCapabilities "mo:neutron-capabilities";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Runtime "mo:core/Runtime";
import Sha256 "mo:sha2/Sha256";
import Text "mo:core/Text";
import Memory "../memory/files/v2";
import PlainFingerprint "PlainFingerprint";
import Types "PlainTypes";
import UnicodeNfc "UnicodeNfc";

module {
    type Result<T> = { #ok : T; #err : Types.Rejection };
    type ReceiptCheck<T> = {
        #none;
        #replay : T;
        #conflict;
    };
    type ParentPlan = {
        base : Memory.PlainNode;
        missing : [Text];
    };
    type StageParentState = {
        plan : ParentPlan;
        reserved_missing : Nat;
    };

    public class Service(
        mem : Memory.Mem,
        certifiedAssets : NeutronCapabilities.CertifiedAssetsV2,
        nowNs : () -> Nat64,
    ) {
        public func list(request : Types.ListRequest) : Types.ListResponse {
            let ?space = request.space else return rejected(#incompatible);
            if (
                request.limit == 0 or
                request.limit > Types.MAX_LIST_PAGE
            ) return rejected(#invalid_request);
            let ?segments = canonicalSegments(space, request.path) else {
                return rejected(#invalid_request);
            };
            let located = locate(space, segments);
            let #ok(parent) = located else {
                let #err(error) = located else return rejected(#corrupt_state);
                return { outcome = ?#rejected(error) };
            };
            if (parent.kind != #folder) return rejected(#not_folder);
            switch (request.cursor) {
                case (?cursor) {
                    if (
                        cursor.parent_node_id != parent.node_id or
                        cursor.revision != parent.children_revision or
                        not validName(cursor.after)
                    ) return rejected(#cursor_stale);
                };
                case null {};
            };

            let memory = memorySpace(space);
            let prefix = childPrefix(memory, parent.node_id);
            let start = switch (request.cursor) {
                case null prefix;
                case (?cursor) prefix # cursor.after;
            };
            let iterator = Map.entriesFrom(
                mem.plain_children,
                Text.compare,
                start,
            );
            let entries = List.empty<Types.Entry>();
            var first = true;
            var more = false;
            var lastName : ?Text = null;
            label scan loop {
                let ?(key, nodeId) = iterator.next() else break scan;
                if (not Text.startsWith(key, #text prefix)) break scan;
                let ?node = Map.get(
                    mem.plain_nodes,
                    Nat64.compare,
                    nodeId,
                ) else return rejected(#corrupt_state);
                if (
                    node.space != memory or
                    node.parent_id != parent.node_id or
                    childKey(memory, parent.node_id, node.name) != key or
                    not validName(node.name)
                ) return rejected(#corrupt_state);
                if (first) {
                    first := false;
                    switch (request.cursor) {
                        case (?cursor) {
                            if (node.name == cursor.after) continue scan;
                        };
                        case null {};
                    };
                };
                if (List.size(entries) >= Nat16.toNat(request.limit)) {
                    more := true;
                    break scan;
                };
                let childPath = joinPath(request.path, node.name);
                if (not relativePathScalarsFit(space, childPath)) {
                    return rejected(#corrupt_state);
                };
                List.add(entries, entry(node, childPath));
                lastName := ?node.name;
            };
            let next = if (more) {
                switch (lastName) {
                    case (?after) ?{
                        after;
                        revision = parent.children_revision;
                        parent_node_id = parent.node_id;
                    };
                    case null null;
                };
            } else null;
            {
                outcome = ?#ok({
                    revision = parent.children_revision;
                    entries = List.toArray(entries);
                    total = parent.direct_child_count;
                    next_cursor = next;
                    has_more = more;
                });
            };
        };

        public func stat(request : Types.StatRequest) : Types.StatResponse {
            let ?space = request.space else return rejectedStat(#incompatible);
            let ?segments = canonicalSegments(space, request.path) else {
                return rejectedStat(#invalid_request);
            };
            switch (locate(space, segments)) {
                case (#err(error)) ({ outcome = ?#rejected(error) });
                case (#ok(node)) {
                    { outcome = ?#ok(entry(node, request.path)) };
                };
            };
        };

        public func readChunk(
            request : Types.ReadChunkRequest
        ) : Types.ReadChunkOutput {
            let ?space = request.space else {
                return rejectedRead(#incompatible);
            };
            let ?segments = canonicalSegments(space, request.path) else {
                return rejectedRead(#invalid_request);
            };
            let located = locate(space, segments);
            let #ok(node) = located else {
                let #err(error) = located else return rejectedRead(#corrupt_state);
                return { value = { outcome = ?#rejected(error) }; body = "" };
            };
            if (node.kind != #file) return rejectedRead(#not_file);
            let ?file = node.file else return rejectedRead(#corrupt_state);
            if (request.block_index >= file.block_count) {
                return rejectedRead(#invalid_request);
            };
            // Shared bytes deliberately have no second Files-backend copy.
            // The current scoped Certified Assets V2 handle has no body-read
            // operation, so consumers use Entry.relative_url for Shared.
            if (space == #shared_) {
                return rejectedRead(#temporarily_unavailable);
            };
            let ?body = Map.get(
                mem.plain_blocks,
                comparePlainBlockKey,
                (file.content_id, request.block_index),
            ) else return rejectedRead(#corrupt_state);
            if (
                body.size() != expectedBlockBytes(
                    file.total_bytes,
                    file.block_count,
                    request.block_index,
                )
            ) return rejectedRead(#corrupt_state);
            {
                value = {
                    outcome = ?#ok({
                        entry = entry(node, request.path);
                        block_index = request.block_index;
                        block_count = file.block_count;
                        body_bytes = Nat32.fromNat(body.size());
                    });
                };
                body;
            };
        };

        public func writeBlock(
            request : Types.WriteBlockRequest
        ) : Types.WriteBlockResponse {
            ignore reapExpiredStages(3);
            ignore pruneExpiredReceipts(16);
            let envelope = validateWriteEnvelope(request);
            let #ok({ space; contentKind; totalBytes }) = envelope else {
                let #err(error) = envelope else return rejectedWrite(#corrupt_state);
                return { outcome = ?#rejected(error) };
            };
            let fingerprint = PlainFingerprint.writeBlock(request);
            switch (checkWriteReceipt(request.request_id, fingerprint)) {
                case (#replay(response)) return response;
                case (#conflict) return rejectedWrite(#conflict);
                case (#none) {};
            };
            let ownsStageReservation =
                request.stage_id != null or
                Map.get(
                    mem.plain_stage_by_request,
                    Text.compare,
                    request.request_id,
                ) != null;
            if (
                not ownsStageReservation and
                not terminalCapacityAvailable(false)
            ) return rejectedWrite(#busy);
            let stageResult = resolveOrBeginStage(
                request,
                space,
                contentKind,
                totalBytes,
            );
            let #ok(stage) = stageResult else {
                let #err(error) = stageResult else {
                    return rejectedWrite(#corrupt_state);
                };
                return { outcome = ?#rejected(error) };
            };
            // A null stage_id means the caller has no usable abort handle. This
            // includes an initial call and an exact retry after its successful
            // first-block response was lost. Any explicit post-resolution
            // failure must retire such a stage instead of stranding the sole
            // Shared pending-stage slot until expiry.
            let handlelessStage = request.stage_id == null;
            if (not requestMatchesStage(request, stage)) {
                return rejectHandlelessStageFailure(
                    stage,
                    handlelessStage,
                    Types.reject(#conflict),
                );
            };

            let index = request.block_index;
            if (index > stage.next_block_index) {
                return rejectHandlelessStageFailure(
                    stage,
                    handlelessStage,
                    Types.reject(#invalid_request),
                );
            };
            if (index < stage.next_block_index) {
                switch (replayBlock(stage, index, request.body)) {
                    case (#err(error)) {
                        return rejectHandlelessStageFailure(
                            stage,
                            handlelessStage,
                            error,
                        );
                    };
                    case (#ok(_)) {
                        let replayed = switch (stage.space) {
                            // Certified Assets does not extend its one-hour
                            // stage deadline for an identical chunk replay.
                            // Keep Shared's local 55-minute lifetime pinned to
                            // its original start instead of letting a replay
                            // outlive the Kernel stage.
                            case (#shared_) stage;
                            // Workspace has no external stage deadline, so an
                            // exact replay remains meaningful local activity.
                            case (#workspace) {
                                { stage with modified_at_ns = nowNs() };
                            };
                        };
                        Map.add(
                            mem.plain_stages,
                            Nat64.compare,
                            replayed.stage_id,
                            replayed,
                        );
                        if (
                            request.final and
                            replayed.next_block_index ==
                                replayed.block_count and
                            replayed.received_bytes == replayed.total_bytes
                        ) {
                            return commitResponse(
                                replayed,
                                request,
                                fingerprint,
                                handlelessStage,
                            );
                        };
                        return {
                            outcome = ?#ok({
                                stage_id = ?replayed.stage_id;
                                committed = false;
                                entry = null;
                            });
                        };
                    };
                };
            };

            let acceptedResult = acceptBlock(stage, request.body);
            let #ok(accepted) = acceptedResult else {
                let #err(error) = acceptedResult else {
                    return rejectedWrite(#corrupt_state);
                };
                return rejectHandlelessStageFailure(
                    stage,
                    handlelessStage,
                    error,
                );
            };
            Map.add(
                mem.plain_stages,
                Nat64.compare,
                accepted.stage_id,
                accepted,
            );
            if (not request.final) {
                return {
                    outcome = ?#ok({
                        stage_id = ?accepted.stage_id;
                        committed = false;
                        entry = null;
                    });
                };
            };
            if (
                accepted.next_block_index != accepted.block_count or
                accepted.received_bytes != accepted.total_bytes
            ) return rejectHandlelessStageFailure(
                accepted,
                handlelessStage,
                Types.reject(#invalid_request),
            );

            commitResponse(
                accepted,
                request,
                fingerprint,
                handlelessStage,
            );
        };

        public func mkdir(
            request : Types.MkdirRequest
        ) : Types.MutationResponse {
            ignore reapExpiredStages(3);
            ignore pruneExpiredReceipts(16);
            let ?space = request.space else return rejectedMutation(#incompatible);
            if (not validRequestId(request.request_id)) {
                return rejectedMutation(#invalid_request);
            };
            let ?segments = canonicalSegments(space, request.path) else {
                return rejectedMutation(#invalid_request);
            };
            let fingerprint = PlainFingerprint.mkdir(request);
            switch (
                checkMutationReceipt(request.request_id, fingerprint)
            ) {
                case (#replay(response)) return response;
                case (#conflict) return rejectedMutation(#conflict);
                case (#none) {};
            };
            if (terminalRequestCollidesWithStage(request.request_id)) {
                return rejectedMutation(#conflict);
            };
            if (not terminalCapacityAvailable(false)) {
                return rejectedMutation(#busy);
            };
            if (segments.size() == 0) {
                let ?root = rootNode(space) else {
                    return rejectedMutation(#corrupt_state);
                };
                return terminalMutation(
                    request.request_id,
                    fingerprint,
                    request.path,
                    root.revision,
                    0,
                );
            };
            if (mkdirConflictsWithStageTarget(space, request.path)) {
                return rejectedMutation(#busy);
            };
            // Plan the entire recursive create before touching either index.
            // This keeps a near-full store from exposing a partial folder
            // hierarchy when a later segment would cross the durable quota.
            let missingResult = missingMkdirSegments(
                space,
                segments,
                request.recursive,
            );
            let #ok(missing) = missingResult else {
                let #err(error) = missingResult else {
                    return rejectedMutation(#corrupt_state);
                };
                return { outcome = ?#rejected(error) };
            };
            let reservedResult = reservedPlainNodes(null);
            let #ok(reservedNodes) = reservedResult else {
                let #err(error) = reservedResult else {
                    return rejectedMutation(#corrupt_state);
                };
                return { outcome = ?#rejected(error) };
            };
            let reservedParentIdsResult =
                reservedPlainParentIds(null);
            let #ok(reservedParentIds) = reservedParentIdsResult else {
                let #err(error) = reservedParentIdsResult else {
                    return rejectedMutation(#corrupt_state);
                };
                return { outcome = ?#rejected(error) };
            };
            if (
                Map.size(mem.plain_nodes) +
                    reservedNodes +
                    missing >
                Types.MAX_PLAIN_NODES or
                not nodeIdsAvailable(reservedParentIds + missing)
            ) return rejectedMutation(#quota);
            var parent = switch (rootNode(space)) {
                case (?value) value;
                case null return rejectedMutation(#corrupt_state);
            };
            var changed : Nat32 = 0;
            var index = 0;
            for (name in segments.vals()) {
                index += 1;
                let key = childKey(space, parent.node_id, name);
                switch (Map.get(mem.plain_children, Text.compare, key)) {
                    case (?nodeId) {
                        let ?node = Map.get(
                            mem.plain_nodes,
                            Nat64.compare,
                            nodeId,
                        ) else return rejectedMutation(#corrupt_state);
                        if (node.kind != #folder or node.space != space) {
                            return rejectedMutation(#not_folder);
                        };
                        parent := node;
                    };
                    case null {
                        if (not request.recursive and index < segments.size()) {
                            return rejectedMutation(#not_found);
                        };
                        let create = createFolder(space, parent, name);
                        let #ok(node) = create else {
                            let #err(error) = create else {
                                return rejectedMutation(#corrupt_state);
                            };
                            return { outcome = ?#rejected(error) };
                        };
                        parent := node;
                        changed += 1;
                    };
                };
            };
            terminalMutation(
                request.request_id,
                fingerprint,
                request.path,
                parent.revision,
                changed,
            );
        };

        public func move(request : Types.MoveRequest) : Types.MutationResponse {
            ignore reapExpiredStages(3);
            ignore pruneExpiredReceipts(16);
            let ?space = request.space else return rejectedMutation(#incompatible);
            if (
                not validRequestId(request.request_id) or
                request.overwrite or
                request.expected_node_id == 0 or
                request.expected_revision == 0 or
                (
                    switch (request.if_match) {
                        case null false;
                        case (?etag) not validEtag(etag);
                    }
                )
            ) return rejectedMutation(#invalid_request);
            let ?fromSegments = canonicalSegments(space, request.from) else {
                return rejectedMutation(#invalid_request);
            };
            let ?toSegments = canonicalSegments(space, request.to) else {
                return rejectedMutation(#invalid_request);
            };
            if (fromSegments.size() == 0 or toSegments.size() == 0) {
                return rejectedMutation(#invalid_request);
            };
            let fingerprint = PlainFingerprint.move(request);
            switch (
                checkMutationReceipt(request.request_id, fingerprint)
            ) {
                case (#replay(response)) return response;
                case (#conflict) return rejectedMutation(#conflict);
                case (#none) {};
            };
            if (terminalRequestCollidesWithStage(request.request_id)) {
                return rejectedMutation(#conflict);
            };
            if (not terminalCapacityAvailable(false)) {
                return rejectedMutation(#busy);
            };
            if (hasStageAtOrBelow(space, request.to)) {
                // A deferred create_parents stage owns the shape of every
                // missing ancestor on its target path. Moving an unrelated
                // entry into one of those names would make the staged commit
                // depend on call order.
                return rejectedMutation(#busy);
            };
            if (request.from == request.to) {
                let located = locate(space, fromSegments);
                let #ok(node) = located else {
                    let #err(error) = located else {
                        return rejectedMutation(#corrupt_state);
                    };
                    return { outcome = ?#rejected(error) };
                };
                switch (checkMutationPreconditions(
                    node,
                    request.expected_node_id,
                    request.expected_revision,
                    request.if_match,
                )) {
                    case (?reason) return rejectedMutation(reason);
                    case null {};
                };
                return terminalMutation(
                    request.request_id,
                    fingerprint,
                    request.to,
                    node.revision,
                    0,
                );
            };
            let sourceResult = locate(space, fromSegments);
            let #ok(source) = sourceResult else {
                let #err(error) = sourceResult else {
                    return rejectedMutation(#corrupt_state);
                };
                return { outcome = ?#rejected(error) };
            };
            switch (checkMutationPreconditions(
                source,
                request.expected_node_id,
                request.expected_revision,
                request.if_match,
            )) {
                case (?reason) return rejectedMutation(reason);
                case null {};
            };
            if (
                space == #shared_ and
                source.kind == #file and
                fromSegments[fromSegments.size() - 1] !=
                    toSegments[toSegments.size() - 1]
            ) {
                // The certified target embeds its public filename. Every leaf
                // rename republishes through writeBlock.move_source so the
                // copied link matches the current logical name.
                return rejectedMutation(#invalid_request);
            };
            if (source.kind == #folder) {
                switch (
                    subtreeMoveFits(source, toSegments, request.to)
                ) {
                    case (#err(error)) {
                        return { outcome = ?#rejected(error) };
                    };
                    case (#ok(false)) {
                        return rejectedMutation(#invalid_request);
                    };
                    case (#ok(true)) {};
                };
            };
            let destinationParentSegments = parentSegments(toSegments);
            let destinationName = toSegments[toSegments.size() - 1];
            let parentResult = locate(space, destinationParentSegments);
            let #ok(destinationParent) = parentResult else {
                let #err(error) = parentResult else {
                    return rejectedMutation(#corrupt_state);
                };
                return { outcome = ?#rejected(error) };
            };
            if (destinationParent.kind != #folder) {
                return rejectedMutation(#not_folder);
            };
            if (
                hasStageAtOrBelow(space, request.from) or
                hasStageAtOrBelow(space, request.to)
            ) return rejectedMutation(#busy);
            if (
                Map.get(
                    mem.plain_children,
                    Text.compare,
                    childKey(space, destinationParent.node_id, destinationName),
                ) != null
            ) return rejectedMutation(#already_exists);
            if (source.kind == #folder and isDescendant(source.node_id, destinationParent)) {
                return rejectedMutation(#conflict);
            };
            let ?oldParent = Map.get(
                mem.plain_nodes,
                Nat64.compare,
                source.parent_id,
            ) else return rejectedMutation(#corrupt_state);
            if (oldParent.kind != #folder or oldParent.direct_child_count == 0) {
                return rejectedMutation(#corrupt_state);
            };
            let oldKey = childKey(space, oldParent.node_id, source.name);
            if (not Map.delete(mem.plain_children, Text.compare, oldKey)) {
                return rejectedMutation(#corrupt_state);
            };
            Map.add(
                mem.plain_children,
                Text.compare,
                childKey(space, destinationParent.node_id, destinationName),
                source.node_id,
            );
            let timestamp = nowNs();
            let revisedSource = {
                source with
                parent_id = destinationParent.node_id;
                name = destinationName;
                modified_at_ns = timestamp;
                revision = checkedNextRevision(source.revision);
            };
            Map.add(
                mem.plain_nodes,
                Nat64.compare,
                source.node_id,
                revisedSource,
            );
            if (oldParent.node_id == destinationParent.node_id) {
                Map.add(
                    mem.plain_nodes,
                    Nat64.compare,
                    oldParent.node_id,
                    reviseFolder(oldParent, 0, timestamp),
                );
            } else {
                Map.add(
                    mem.plain_nodes,
                    Nat64.compare,
                    oldParent.node_id,
                    reviseFolder(oldParent, -1, timestamp),
                );
                Map.add(
                    mem.plain_nodes,
                    Nat64.compare,
                    destinationParent.node_id,
                    reviseFolder(destinationParent, 1, timestamp),
                );
            };
            terminalMutation(
                request.request_id,
                fingerprint,
                request.to,
                revisedSource.revision,
                1,
            );
        };

        public func remove(
            request : Types.RemoveRequest
        ) : Types.MutationResponse {
            ignore reapExpiredStages(3);
            ignore pruneExpiredReceipts(16);
            let ?space = request.space else return rejectedMutation(#incompatible);
            if (
                not validRequestId(request.request_id) or
                request.expected_node_id == 0 or
                request.expected_revision == 0 or
                (
                    switch (request.if_match) {
                        case null false;
                        case (?etag) not validEtag(etag);
                    }
                )
            ) {
                return rejectedMutation(#invalid_request);
            };
            let ?segments = canonicalSegments(space, request.path) else {
                return rejectedMutation(#invalid_request);
            };
            if (segments.size() == 0) {
                return rejectedMutation(#invalid_request);
            };
            let fingerprint = PlainFingerprint.remove(request);
            switch (
                checkMutationReceipt(request.request_id, fingerprint)
            ) {
                case (#replay(response)) return response;
                case (#conflict) return rejectedMutation(#conflict);
                case (#none) {};
            };
            if (terminalRequestCollidesWithStage(request.request_id)) {
                return rejectedMutation(#conflict);
            };
            if (not terminalCapacityAvailable(false)) {
                return rejectedMutation(#busy);
            };
            let located = locate(space, segments);
            let #ok(node) = located else {
                let #err(error) = located else {
                    return rejectedMutation(#corrupt_state);
                };
                return { outcome = ?#rejected(error) };
            };
            switch (checkMutationPreconditions(
                node,
                request.expected_node_id,
                request.expected_revision,
                request.if_match,
            )) {
                case (?reason) return rejectedMutation(reason);
                case null {};
            };
            if (hasStageAtOrBelow(space, request.path)) {
                return rejectedMutation(#busy);
            };
            if (node.kind == #folder and node.direct_child_count > 0) {
                // Recursive multi-file Shared deletion requires one independent
                // certified delete nonce per file. Keep V3 bounded and honest.
                return rejectedMutation(if (request.recursive) #busy else #conflict);
            };
            let ?parent = Map.get(
                mem.plain_nodes,
                Nat64.compare,
                node.parent_id,
            ) else return rejectedMutation(#corrupt_state);
            if (
                parent.kind != #folder or
                parent.direct_child_count == 0 or
                Map.get(
                    mem.plain_children,
                    Text.compare,
                    childKey(memorySpace(space), parent.node_id, node.name),
                ) != ?node.node_id
            ) return rejectedMutation(#corrupt_state);
            switch (node.file) {
                case (?file) {
                    switch (space) {
                        case (#workspace) {
                            if (mem.workspace_plaintext_bytes < file.total_bytes) {
                                return rejectedMutation(#corrupt_state);
                            };
                            deleteWorkspaceBlocks(file);
                            mem.workspace_plaintext_bytes -= file.total_bytes;
                        };
                        case (#shared_) {
                            let ?publication = file.publication else {
                                return rejectedMutation(#corrupt_state);
                            };
                            let ?nonce = request.delete_nonce else {
                                return rejectedMutation(#invalid_request);
                            };
                            if (
                                mem.shared_plaintext_bytes < file.total_bytes or
                                mem.shared_file_count == 0
                            ) {
                                return rejectedMutation(#corrupt_state);
                            };
                            switch (deletePublication(publication, nonce)) {
                                case (#err(error)) {
                                    return { outcome = ?#rejected(error) };
                                };
                                case (#ok(_)) {};
                            };
                            mem.shared_plaintext_bytes -= file.total_bytes;
                            mem.shared_file_count -= 1;
                        };
                    };
                };
                case null {
                    if (node.kind != #folder) {
                        return rejectedMutation(#corrupt_state);
                    };
                };
            };
            if (
                not Map.delete(
                    mem.plain_children,
                    Text.compare,
                    childKey(memorySpace(space), parent.node_id, node.name),
                ) or
                not Map.delete(mem.plain_nodes, Nat64.compare, node.node_id)
            ) Runtime.trap("Files plaintext removal lost its indexed node");
            Map.add(
                mem.plain_nodes,
                Nat64.compare,
                parent.node_id,
                reviseFolder(parent, -1, nowNs()),
            );
            terminalMutation(
                request.request_id,
                fingerprint,
                request.path,
                checkedNextRevision(node.revision),
                1,
            );
        };

        public func cleanup(
            request : Types.CleanupRequest
        ) : Types.MutationResponse {
            ignore pruneExpiredReceipts(16);
            if (
                not validRequestId(request.request_id) or
                request.limit == 0 or
                request.limit > 3
            ) {
                return rejectedMutation(#invalid_request);
            };
            if (
                terminalRequestCollidesWithStage(request.request_id) or
                activeTerminalRequest(request.request_id)
            ) {
                return rejectedMutation(#conflict);
            };
            let changed = reapExpiredStages(
                Nat8.toNat(request.limit)
            );
            // Cleanup is naturally convergent and is called on every resident
            // initialization. Retaining a fresh terminal receipt per app open
            // would consume the mutation idempotency budget without protecting
            // user data or an externally visible nonce.
            mutationOk("/", 0, changed);
        };

        public func abort(request : Types.AbortRequest) : Types.MutationResponse {
            ignore pruneExpiredReceipts(16);
            let ?space = request.space else return rejectedMutation(#incompatible);
            if (not validRequestId(request.request_id)) {
                return rejectedMutation(#invalid_request);
            };
            let fingerprint = PlainFingerprint.abort(request);
            switch (
                checkMutationReceipt(request.request_id, fingerprint)
            ) {
                case (#replay(response)) return response;
                case (#conflict) return rejectedMutation(#conflict);
                case (#none) {};
            };
            if (not terminalCapacityAvailable(true)) {
                return rejectedMutation(#busy);
            };
            let stageResult : Result<Memory.PlainStage> = switch (
                request.stage_id
            ) {
                case (?stageId) switch (
                    Map.get(
                        mem.plain_stages,
                        Nat64.compare,
                        stageId,
                    )
                ) {
                    case (?stage) #ok(stage);
                    case null #err(Types.reject(#not_found));
                };
                case null switch (
                    Map.get(
                        mem.plain_stage_by_request,
                        Text.compare,
                        request.request_id,
                    )
                ) {
                    case null #err(Types.reject(#not_found));
                    case (?stageId) switch (
                        Map.get(
                            mem.plain_stages,
                            Nat64.compare,
                            stageId,
                        )
                    ) {
                        case (?stage) #ok(stage);
                        case null #err(Types.reject(#corrupt_state));
                    };
                };
            };
            let #ok(stage) = stageResult else {
                let #err(error) = stageResult else {
                    return rejectedMutation(#corrupt_state);
                };
                return { outcome = ?#rejected(error) };
            };
            if (
                stage.request_id != request.request_id or
                stage.space != memorySpace(space)
            ) {
                return rejectedMutation(#conflict);
            };
            switch (retireStage(stage, true)) {
                case (#err(error)) ({ outcome = ?#rejected(error) });
                case (#ok(_)) terminalMutation(
                    request.request_id,
                    fingerprint,
                    stage.path,
                    0,
                    0,
                );
            };
        };

        func resolveOrBeginStage(
            request : Types.WriteBlockRequest,
            space : Types.Space,
            contentKind : Types.ContentKind,
            totalBytes : Nat,
        ) : Result<Memory.PlainStage> {
            switch (request.stage_id) {
                case (?stageId) {
                    let ?stage = Map.get(
                        mem.plain_stages,
                        Nat64.compare,
                        stageId,
                    ) else return #err(Types.reject(#not_found));
                    return #ok(stage);
                };
                case null {};
            };
            switch (
                Map.get(
                    mem.plain_stage_by_request,
                    Text.compare,
                    request.request_id,
                )
            ) {
                case (?stageId) {
                    let ?stage = Map.get(
                        mem.plain_stages,
                        Nat64.compare,
                        stageId,
                    ) else return #err(Types.reject(#corrupt_state));
                    return #ok(stage);
                };
                case null {};
            };
            if (request.block_index != 0) {
                return #err(Types.reject(#invalid_request));
            };
            let ?segments = canonicalSegments(space, request.path) else {
                return #err(Types.reject(#invalid_request));
            };
            if (segments.size() == 0) {
                return #err(Types.reject(#invalid_request));
            };
            let parentPlanResult = planParent(
                space,
                parentSegments(segments),
                request.create_parents,
            );
            let #ok(parentPlan) = parentPlanResult else {
                let #err(error) = parentPlanResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            if (parentPlan.base.kind != #folder) {
                return #err(Types.reject(#not_folder));
            };
            let name = segments[segments.size() - 1];
            let existingNode = if (parentPlan.missing.size() == 0) {
                switch (
                    Map.get(
                        mem.plain_children,
                        Text.compare,
                        childKey(
                            memorySpace(space),
                            parentPlan.base.node_id,
                            name,
                        ),
                    )
                ) {
                    case (?nodeId) {
                        let ?node = Map.get(
                            mem.plain_nodes,
                            Nat64.compare,
                            nodeId,
                        ) else return #err(Types.reject(#corrupt_state));
                        if (node.kind != #file) {
                            return #err(Types.reject(#not_file));
                        };
                        ?node;
                    };
                    case null null;
                }
            } else null;
            switch (existingNode) {
                case (?node) {
                    let ?file = node.file else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (request.if_none_match) {
                        return #err(Types.reject(#already_exists));
                    };
                    let ?expectedNodeId = request.expected_node_id else {
                        return #err(Types.reject(#invalid_request));
                    };
                    let ?expectedRevision = request.expected_revision else {
                        return #err(Types.reject(#invalid_request));
                    };
                    if (
                        node.node_id != expectedNodeId or
                        node.revision != expectedRevision
                    ) return #err(Types.reject(#stale_revision));
                    switch (request.if_match) {
                        case (?expected) if (expected != file.etag_sha256) {
                            return #err(Types.reject(#stale_content));
                        };
                        case (_) {};
                    };
                };
                case null {
                    if (
                        request.if_match != null or
                        request.expected_node_id != null or
                        request.expected_revision != null
                    ) {
                        return #err(Types.reject(#not_found));
                    };
                };
            };
            let oldBytes = switch (existingNode) {
                case (?node) {
                    let ?file = node.file else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    file.total_bytes;
                };
                case null 0;
            };
            let moveSourceResult = resolveWriteMoveSource(
                request,
                space,
                existingNode,
            );
            let #ok(moveSource) = moveSourceResult else {
                let #err(error) = moveSourceResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let movedBytes = switch (moveSource) {
                case (?source) source.total_bytes;
                case null 0;
            };
            let current = if (space == #workspace) {
                mem.workspace_plaintext_bytes
            } else mem.shared_plaintext_bytes;
            let limit = if (space == #workspace) {
                Types.MAX_TOTAL_WORKSPACE_BYTES
            } else Types.MAX_TOTAL_SHARED_BYTES;
            if (
                hasStageAtOrBelow(space, request.path) or
                mkdirConflictsWithStageTarget(space, request.path)
            ) {
                return #err(Types.reject(#busy));
            };
            let projectionResult = projectedPlainBytes(space, current);
            let #ok(projected) = projectionResult else {
                let #err(error) = projectionResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let displacedBytes = oldBytes + movedBytes;
            if (
                current < displacedBytes or
                projected > limit or
                (
                    totalBytes > displacedBytes and
                    projected + (totalBytes - displacedBytes) > limit
                )
            ) {
                return #err(Types.reject(#quota));
            };
            if (
                space == #shared_ and
                existingNode == null and
                moveSource == null
            ) {
                let projectedFiles = projectedSharedFiles();
                let #ok(fileCount) = projectedFiles else {
                    let #err(error) = projectedFiles else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    return #err(error);
                };
                if (fileCount >= Types.MAX_SHARED_FILES) {
                    return #err(Types.reject(#quota));
                };
            };
            let newNodeCount =
                parentPlan.missing.size() +
                (
                    if (existingNode == null and moveSource == null) 1
                    else 0
                );
            let reservedResult = reservedPlainNodes(null);
            let #ok(reservedNodes) = reservedResult else {
                let #err(error) = reservedResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let reservedParentIdsResult =
                reservedPlainParentIds(null);
            let #ok(reservedParentIds) = reservedParentIdsResult else {
                let #err(error) = reservedParentIdsResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            if (
                Map.size(mem.plain_nodes) +
                    reservedNodes +
                    newNodeCount >
                    Types.MAX_PLAIN_NODES or
                not nodeIdsAvailable(
                    reservedParentIds + newNodeCount
                )
            ) {
                return #err(Types.reject(#quota));
            };
            let nodeId = switch (existingNode, moveSource) {
                case (?node, null) node.node_id;
                case (null, ?source) source.node_id;
                case (null, null) {
                    let id = allocateNodeId();
                    let #ok(value) = id else {
                        let #err(error) = id else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        return #err(error);
                    };
                    value;
                };
                case (_) return #err(Types.reject(#corrupt_state));
            };
            let contentIdResult = allocateContentId();
            let #ok(contentId) = contentIdResult else {
                let #err(error) = contentIdResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let stageIdResult = allocateStageId();
            let #ok(stageId) = stageIdResult else {
                let #err(error) = stageIdResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let timestamp = nowNs();
            let createdAt = switch (existingNode, moveSource) {
                case (?node, null) node.created_at_ns;
                case (null, ?source) source.created_at_ns;
                case (null, null) timestamp;
                case (_) timestamp;
            };
            var kernelStageId : ?Nat64 = null;
            var target : ?Memory.PlainPublicationTarget = null;
            var beginNonce : Blob = "";
            var safeName = "";
            var sharedExpiresAtNs : ?Nat64 = null;
            var blockHashes = Array.tabulate<?Blob>(
                Nat32.toNat(request.block_count),
                func(_) { null },
            );
            if (space == #shared_) {
                let ?presentation = request.presentation else {
                    return #err(Types.reject(#invalid_request));
                };
                let ?requestedSafeName = request.safe_name else {
                    return #err(Types.reject(#invalid_request));
                };
                let ?requestedBeginNonce = request.begin_nonce else {
                    return #err(Types.reject(#invalid_request));
                };
                if (
                    not validSafeName(requestedSafeName) or
                    requestedSafeName != sharedSafeName(name) or
                    requestedBeginNonce.size() != 16
                ) return #err(Types.reject(#invalid_request));
                let collectionGenerationResult = sharesGeneration();
                let #ok(collectionGeneration) = collectionGenerationResult else {
                    let #err(error) = collectionGenerationResult else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    return #err(error);
                };
                let begin = certifiedAssets.begin_stage({
                    nonce = requestedBeginNonce;
                    target = #allocate_publication({
                        collection = "shares";
                        collection_generation = collectionGeneration;
                        filename = requestedSafeName;
                        presentation = capPresentation(presentation);
                    });
                    expected_bytes = totalBytes;
                });
                let #ok(ok) = begin else {
                    let #err(error) = begin else {
                        return #err(Types.reject(#temporarily_unavailable));
                    };
                    return #err(capError(error));
                };
                let ?computed = ok.identity.computed_target else {
                    Runtime.trap("Files Shared begin omitted its target");
                };
                let ?computedPlainTarget = plainTarget(computed) else {
                    Runtime.trap("Files Shared begin returned a foreign target");
                };
                let blockLengths = canonicalBlockLengths(totalBytes);
                if (
                    ok.stage_id == 0 or
                    ok.stage_id == Nat64.maxValue or
                    ok.identity.collection != "shares" or
                    ok.identity.collection_generation !=
                        collectionGeneration or
                    ok.identity.computed_target != ?computed or
                    computedPlainTarget.collection != "shares" or
                    computedPlainTarget.collection_generation !=
                        collectionGeneration or
                    computedPlainTarget.publication_id.size() != 32 or
                    computedPlainTarget.filename != requestedSafeName or
                    not pinnedGeometryMatches(
                        ok.geometry,
                        blockLengths,
                        totalBytes,
                    )
                ) Runtime.trap("Files Shared begin identity mismatch");
                let ?localDeadline = sharedStageDeadline(
                    timestamp,
                    ok.expires_at_ns,
                ) else {
                    // An identical begin nonce can replay an older Kernel
                    // stage. Do not attach a fresh 55-minute local lifecycle
                    // when its remaining certified lifetime is too short.
                    abortUnattachedSharedStage(ok.stage_id);
                    return #err(Types.reject(#conflict));
                };
                kernelStageId := ?ok.stage_id;
                target := ?computedPlainTarget;
                beginNonce := requestedBeginNonce;
                safeName := requestedSafeName;
                sharedExpiresAtNs := ?localDeadline;
                blockHashes := Array.tabulate<?Blob>(
                    Nat32.toNat(request.block_count),
                    func(_) { null },
                );
            } else {
                if (
                    request.presentation != null or
                    request.safe_name != null or
                    request.begin_nonce != null
                ) return #err(Types.reject(#invalid_request));
            };
            let oldPublication = switch (existingNode) {
                case (?node) {
                    let ?file = node.file else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    file.publication;
                };
                case null switch (moveSource) {
                    case (?source) ?source.publication;
                    case null null;
                };
            };
            let stage : Memory.PlainStage = {
                stage_id = stageId;
                request_id = request.request_id;
                space;
                path = request.path;
                // For new deferred stages this is the deepest existing base,
                // not necessarily the eventual direct parent. Older stages
                // already stored their materialized direct parent here; the
                // commit planner accepts both representations.
                parent_id = parentPlan.base.node_id;
                name;
                node_id = nodeId;
                existing_node_id = switch (existingNode) {
                    case (?node) ?node.node_id;
                    case null null;
                };
                existing_revision = switch (existingNode) {
                    case (?node) ?node.revision;
                    case null null;
                };
                existing_etag_sha256 = switch (existingNode) {
                    case (?node) {
                        let ?file = node.file else {
                            return #err(
                                Types.reject(#corrupt_state)
                            );
                        };
                        ?file.etag_sha256;
                    };
                    case null null;
                };
                content_id = contentId;
                block_count = request.block_count;
                total_bytes = totalBytes;
                content_kind = memoryContentKind(contentKind);
                media_type = request.media_type;
                etag_sha256 = request.etag_sha256;
                presentation = memoryPresentation(request.presentation);
                next_block_index = 0;
                received_bytes = 0;
                kernel_stage_id = kernelStageId;
                target;
                old_publication = oldPublication;
                move_source = moveSource;
                begin_nonce = beginNonce;
                commit_nonce = null;
                delete_nonce = null;
                block_hashes = blockHashes;
                safe_name = safeName;
                created_at_ns = createdAt;
                modified_at_ns = timestamp;
                shared_expires_at_ns = sharedExpiresAtNs;
            };
            Map.add(mem.plain_stages, Nat64.compare, stageId, stage);
            Map.add(
                mem.plain_stage_by_request,
                Text.compare,
                request.request_id,
                stageId,
            );
            #ok(stage);
        };

        func resolveWriteMoveSource(
            request : Types.WriteBlockRequest,
            space : Types.Space,
            existingNode : ?Memory.PlainNode,
        ) : Result<?Memory.PlainMoveSource> {
            let ?wanted = request.move_source else return #ok(null);
            if (
                space != #shared_ or
                existingNode != null or
                not request.if_none_match or
                request.if_match != null or
                wanted.expected_node_id == 0 or
                wanted.expected_revision == 0 or
                (
                    switch (wanted.if_match) {
                        case null false;
                        case (?etag) not validEtag(etag);
                    }
                )
            ) return #err(Types.reject(#invalid_request));
            let ?segments = canonicalSegments(space, wanted.path) else {
                return #err(Types.reject(#invalid_request));
            };
            if (segments.size() == 0 or wanted.path == request.path) {
                return #err(Types.reject(#invalid_request));
            };
            let located = locate(#shared_, segments);
            let #ok(node) = located else {
                let #err(error) = located else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            if (node.kind != #file) {
                return #err(Types.reject(#not_file));
            };
            switch (
                checkMutationPreconditions(
                    node,
                    wanted.expected_node_id,
                    wanted.expected_revision,
                    wanted.if_match,
                )
            ) {
                case (?reason) return #err(Types.reject(reason));
                case null {};
            };
            let ?file = node.file else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?presentation = file.presentation else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?publication = file.publication else {
                return #err(Types.reject(#corrupt_state));
            };
            if (hasStageAtOrBelow(#shared_, wanted.path)) {
                return #err(Types.reject(#busy));
            };
            #ok(?{
                path = wanted.path;
                node_id = node.node_id;
                parent_id = node.parent_id;
                name = node.name;
                revision = node.revision;
                if_match = wanted.if_match;
                etag_sha256 = file.etag_sha256;
                total_bytes = file.total_bytes;
                presentation;
                publication;
                created_at_ns = node.created_at_ns;
            });
        };

        func acceptBlock(
            stage : Memory.PlainStage,
            body : Blob,
        ) : Result<Memory.PlainStage> {
            switch (stage.space) {
                case (#workspace) {
                    Map.add(
                        mem.plain_blocks,
                        comparePlainBlockKey,
                        (stage.content_id, stage.next_block_index),
                        body,
                    );
                    mem.staged_workspace_bytes += body.size();
                    #ok({
                        stage with
                        next_block_index = stage.next_block_index + 1;
                        received_bytes = stage.received_bytes + body.size();
                        modified_at_ns = nowNs();
                    });
                };
                case (#shared_) {
                    let ?kernelStageId = stage.kernel_stage_id else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?target = stage.target else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let result = certifiedAssets.put_chunk({
                        stage_id = kernelStageId;
                        index = stage.next_block_index;
                        body;
                    });
                    let #ok(ok) = result else {
                        let #err(error) = result else {
                            return #err(Types.reject(#temporarily_unavailable));
                        };
                        return #err(capError(error));
                    };
                    let bodyHash = Sha256.fromBlob(#sha256, body);
                    let complete =
                        stage.next_block_index + 1 == stage.block_count;
                    if (
                        ok.stage_id != kernelStageId or
                        ok.index != stage.next_block_index or
                        ok.block_sha256 != bodyHash or
                        ok.accepted != #new or
                        ok.complete != complete or
                        not rawSha256Matches(
                            ok.raw_sha256,
                            complete,
                            stage.etag_sha256,
                        ) or
                        ok.computed_target != ?capTarget(target)
                    ) Runtime.trap("Files Shared chunk identity mismatch");
                    let hashes = Array.tabulate<?Blob>(
                        stage.block_hashes.size(),
                        func(index) {
                            if (index == Nat32.toNat(stage.next_block_index)) {
                                ?ok.block_sha256
                            } else stage.block_hashes[index];
                        },
                    );
                    #ok({
                        stage with
                        next_block_index = stage.next_block_index + 1;
                        received_bytes = stage.received_bytes + body.size();
                        block_hashes = hashes;
                    });
                };
            };
        };

        func replayBlock(
            stage : Memory.PlainStage,
            index : Nat32,
            body : Blob,
        ) : Result<()> {
            switch (stage.space) {
                case (#workspace) {
                    let ?stored = Map.get(
                        mem.plain_blocks,
                        comparePlainBlockKey,
                        (stage.content_id, index),
                    ) else return #err(Types.reject(#corrupt_state));
                    if (stored != body) return #err(Types.reject(#conflict));
                    #ok(());
                };
                case (#shared_) {
                    let ?kernelStageId = stage.kernel_stage_id else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?target = stage.target else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let wanted = Nat32.toNat(index);
                    if (wanted >= stage.block_hashes.size()) {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?storedHash = stage.block_hashes[wanted] else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (storedHash != Sha256.fromBlob(#sha256, body)) {
                        return #err(Types.reject(#conflict));
                    };
                    switch (certifiedAssets.put_chunk({
                            stage_id = kernelStageId;
                            index;
                            body;
                        })) {
                        case (#ok(ok)) {
                            let complete =
                                stage.next_block_index ==
                                    stage.block_count;
                            if (
                                ok.stage_id != kernelStageId or
                                ok.index != index or
                                ok.block_sha256 != storedHash or
                                ok.accepted != #replayed or
                                ok.complete != complete or
                                not rawSha256Matches(
                                    ok.raw_sha256,
                                    complete,
                                    stage.etag_sha256,
                                ) or
                                ok.computed_target != ?capTarget(target)
                            ) Runtime.trap(
                                "Files Shared replay identity mismatch"
                            );
                            #ok(());
                        };
                        case (#err(error)) #err(capError(error));
                    };
                };
            };
        };

        func commitResponse(
            stage : Memory.PlainStage,
            request : Types.WriteBlockRequest,
            fingerprint : Memory.Tag256,
            handlelessStage : Bool,
        ) : Types.WriteBlockResponse {
            switch (commitStage(stage, request)) {
                case (#err(error)) {
                    rejectHandlelessStageFailure(
                        stage,
                        handlelessStage,
                        error,
                    );
                };
                case (#ok(node)) {
                    storeWriteReceipt(
                        request.request_id,
                        fingerprint,
                        stage.path,
                        node,
                    );
                    {
                        outcome = ?#ok({
                            stage_id = null;
                            committed = true;
                            entry = ?entry(node, stage.path);
                        });
                    };
                };
            };
        };

        func rejectHandlelessStageFailure(
            stage : Memory.PlainStage,
            handlelessStage : Bool,
            error : Types.Rejection,
        ) : Types.WriteBlockResponse {
            if (not handlelessStage) {
                return { outcome = ?#rejected(error) };
            };
            switch (retireStage(stage, true)) {
                case (#ok(_)) ({ outcome = ?#rejected(error) });
                case (#err(_)) {
                    // Trapping rolls the enclosing update back, including the
                    // synchronous capability effects. Returning a rejection
                    // after cleanup itself failed would lose the only stage
                    // handle the caller could use and recreate the pending-slot
                    // leak.
                    Runtime.trap(
                        "Files could not retire a rejected handleless stage"
                    );
                };
            };
        };

        func commitStage(
            stage : Memory.PlainStage,
            request : Types.WriteBlockRequest,
        ) : Result<Memory.PlainNode> {
            let parentStateResult = stageParentState(stage);
            let #ok(parentState) = parentStateResult else {
                let #err(error) = parentStateResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let parentPlan = parentState.plan;
            let current = switch (stage.existing_node_id) {
                case (?nodeId) Map.get(mem.plain_nodes, Nat64.compare, nodeId);
                case null null;
            };
            switch (current, stage.existing_node_id) {
                case (?node, ?expectedId) {
                    let ?expectedRevision = stage.existing_revision else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?expectedEtag = stage.existing_etag_sha256 else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (
                        node.node_id != expectedId or
                        node.revision != expectedRevision or
                        parentPlan.missing.size() != 0 or
                        node.parent_id != parentPlan.base.node_id or
                        node.name != stage.name or
                        node.kind != #file
                    ) return #err(Types.reject(#stale_revision));
                    let ?file = node.file else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (file.etag_sha256 != expectedEtag) {
                        return #err(Types.reject(#stale_content));
                    };
                };
                case (null, null) {
                    if (
                        stage.existing_revision != null or
                        stage.existing_etag_sha256 != null
                    ) {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (
                        parentPlan.missing.size() == 0 and
                        Map.get(
                            mem.plain_children,
                            Text.compare,
                            childKey(
                                stage.space,
                                parentPlan.base.node_id,
                                stage.name,
                            ),
                        ) != null
                    ) return #err(Types.reject(#already_exists));
                };
                case (_) return #err(Types.reject(#stale_revision));
            };
            let moveState : ?(Memory.PlainNode, Memory.PlainNode) = switch (
                stage.move_source
            ) {
                case null null;
                case (?planned) {
                    if (
                        stage.space != #shared_ or
                        current != null or
                        stage.existing_node_id != null or
                        stage.node_id != planned.node_id or
                        stage.old_publication != ?planned.publication
                    ) return #err(Types.reject(#corrupt_state));
                    let ?source = Map.get(
                        mem.plain_nodes,
                        Nat64.compare,
                        planned.node_id,
                    ) else return #err(Types.reject(#stale_revision));
                    if (
                        source.kind != #file or
                        source.space != #shared_ or
                        source.parent_id != planned.parent_id or
                        source.name != planned.name or
                        source.revision != planned.revision
                    ) return #err(Types.reject(#stale_revision));
                    let ?sourceFile = source.file else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (
                        sourceFile.etag_sha256 != planned.etag_sha256 or
                        sourceFile.total_bytes != planned.total_bytes
                    ) return #err(Types.reject(#stale_content));
                    if (
                        sourceFile.presentation != ?planned.presentation or
                        sourceFile.publication != ?planned.publication
                    ) return #err(Types.reject(#stale_content));
                    let ?sourceParent = Map.get(
                        mem.plain_nodes,
                        Nat64.compare,
                        planned.parent_id,
                    ) else return #err(Types.reject(#corrupt_state));
                    if (
                        sourceParent.kind != #folder or
                        sourceParent.space != #shared_ or
                        sourceParent.direct_child_count == 0 or
                        Map.get(
                            mem.plain_children,
                            Text.compare,
                            childKey(
                                #shared_,
                                sourceParent.node_id,
                                source.name,
                            ),
                        ) != ?source.node_id
                    ) return #err(Types.reject(#corrupt_state));
                    ?(source, sourceParent);
                };
            };

            let createsFileNode = current == null and moveState == null;
            switch (current, moveState) {
                case (?node, null) {
                    if (
                        stage.node_id != node.node_id or
                        node.revision == Nat64.maxValue
                    ) return #err(Types.reject(#quota));
                };
                case (null, ?(source, _)) {
                    if (
                        stage.node_id != source.node_id or
                        source.revision == Nat64.maxValue
                    ) return #err(Types.reject(#quota));
                };
                case (null, null) {
                    if (
                        stage.node_id == mem.workspace_root_id or
                        stage.node_id == mem.shared_root_id or
                        Map.get(
                            mem.plain_nodes,
                            Nat64.compare,
                            stage.node_id,
                        ) != null
                    ) return #err(Types.reject(#corrupt_state));
                };
                case (_) return #err(Types.reject(#corrupt_state));
            };

            let allReservationsResult = reservedPlainNodes(null);
            let #ok(allReservations) = allReservationsResult else {
                let #err(error) = allReservationsResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let ownReservation =
                parentState.reserved_missing +
                (if (createsFileNode) 1 else 0);
            if (allReservations < ownReservation) {
                return #err(Types.reject(#corrupt_state));
            };
            let allParentIdsResult = reservedPlainParentIds(null);
            let #ok(allParentIds) = allParentIdsResult else {
                let #err(error) = allParentIdsResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            if (allParentIds < parentState.reserved_missing) {
                return #err(Types.reject(#corrupt_state));
            };
            let otherParentIds =
                allParentIds - parentState.reserved_missing;
            let actualNodeAdditions =
                parentPlan.missing.size() +
                (if (createsFileNode) 1 else 0);
            if (
                Map.size(mem.plain_nodes) +
                    (allReservations - ownReservation) +
                    actualNodeAdditions >
                    Types.MAX_PLAIN_NODES or
                not nodeIdsAvailable(
                    otherParentIds + parentPlan.missing.size()
                )
            ) return #err(Types.reject(#quota));

            // Every folder mutation that will follow a Shared publication is
            // checked before the capability side effect. Newly created folders
            // start with ample counters, so only existing endpoints matter.
            if (parentPlan.missing.size() > 0) {
                switch (moveState) {
                    case (?(_source, sourceParent)) {
                        if (
                            sourceParent.node_id ==
                                parentPlan.base.node_id
                        ) {
                            // First attach the missing branch, then remove the
                            // republished source from this same folder.
                            if (
                                not mutableFolderFor(
                                    parentPlan.base,
                                    true,
                                    2,
                                )
                            ) return #err(Types.reject(#quota));
                        } else if (
                            not mutableFolder(parentPlan.base, true) or
                            not mutableFolder(sourceParent, false)
                        ) {
                            return #err(Types.reject(#quota));
                        };
                    };
                    case null {
                        if (not mutableFolder(parentPlan.base, true)) {
                            return #err(Types.reject(#quota));
                        };
                    };
                };
            } else if (current == null) {
                switch (moveState) {
                    case (?(_source, sourceParent)) {
                        if (
                            sourceParent.node_id ==
                                parentPlan.base.node_id
                        ) {
                            if (not mutableFolder(parentPlan.base, false)) {
                                return #err(Types.reject(#quota));
                            };
                        } else if (
                            not mutableFolder(parentPlan.base, true) or
                            not mutableFolder(sourceParent, false)
                        ) {
                            return #err(Types.reject(#quota));
                        };
                    };
                    case null {
                        if (not mutableFolder(parentPlan.base, true)) {
                            return #err(Types.reject(#quota));
                        };
                    };
                };
            };

            // Admission reserves only positive byte deltas. Recheck the
            // concrete transition before any Shared capability side effect so
            // a stage persisted by older code, or an unexpected intervening
            // state change, can never commit the counter above its limit.
            let displacedBytes = (
                switch (current) {
                    case (?node) {
                        let ?file = node.file else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        file.total_bytes;
                    };
                    case null 0;
                }
            ) + (
                switch (moveState) {
                    case (?(source, _)) {
                        let ?file = source.file else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        file.total_bytes;
                    };
                    case null 0;
                }
            );
            let committedBytes = switch (stage.space) {
                case (#workspace) mem.workspace_plaintext_bytes;
                case (#shared_) mem.shared_plaintext_bytes;
            };
            let byteLimit = switch (stage.space) {
                case (#workspace) Types.MAX_TOTAL_WORKSPACE_BYTES;
                case (#shared_) Types.MAX_TOTAL_SHARED_BYTES;
            };
            if (committedBytes < displacedBytes) {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                committedBytes - displacedBytes + stage.total_bytes >
                    byteLimit
            ) return #err(Types.reject(#quota));

            var publication : ?Memory.PlainSharedIdentity = null;
            switch (stage.space) {
                case (#workspace) {};
                case (#shared_) {
                    let ?kernelStageId = stage.kernel_stage_id else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?target = stage.target else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?commitNonce = request.commit_nonce else {
                        return #err(Types.reject(#invalid_request));
                    };
                    if (commitNonce.size() != 16) {
                        return #err(Types.reject(#invalid_request));
                    };
                    let ?_presentation = stage.presentation else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let commit = certifiedAssets.commit_batch({
                        nonce = commitNonce;
                        operations = [#put({
                            target = capTarget(target);
                            condition = #absent;
                            body = #stage(kernelStageId);
                        })];
                        requires_present_after = [];
                    });
                    let #ok(receipt) = commit else {
                        let #err(error) = commit else {
                            return #err(Types.reject(#temporarily_unavailable));
                        };
                        return #err(capError(error));
                    };
                    let ?identity = putIdentity(receipt, stage) else {
                        Runtime.trap("Files Shared commit receipt mismatch");
                    };
                    publication := ?{
                        target;
                        kernel_revision = identity.kernel_revision;
                        content_tag = identity.content_tag;
                    };
                    switch (stage.old_publication) {
                        case (?old) {
                            let ?deleteNonce = request.delete_nonce else {
                                Runtime.trap(
                                    "Files Shared replacement omitted delete nonce"
                                );
                            };
                            if (deleteNonce.size() != 16) {
                                Runtime.trap(
                                    "Files Shared replacement delete nonce invalid"
                                );
                            };
                            switch (deletePublication(old, deleteNonce)) {
                                case (#ok(_)) {};
                                case (#err(_)) Runtime.trap(
                                    "Files Shared replacement could not revoke old URL"
                                );
                            };
                        };
                        case null {};
                    };
                };
            };

            // Shared publication is now durable. The preflight above proved
            // that the current stage's reservation covers every remaining
            // folder and that IDs/counters cannot fail. Any impossible local
            // divergence traps, rolling back this synchronous capability call.
            let parent = materializeReservedParent(
                stage.space,
                parentPlan,
            );
            let effectiveParentId = parent.node_id;
            let committedMoveState : ?(
                Memory.PlainNode,
                Memory.PlainNode,
            ) = switch (moveState) {
                case null null;
                case (?(source, priorSourceParent)) {
                    let ?sourceParent = Map.get(
                        mem.plain_nodes,
                        Nat64.compare,
                        priorSourceParent.node_id,
                    ) else Runtime.trap(
                        "Files Shared republish lost its source parent"
                    );
                    if (
                        sourceParent.kind != #folder or
                        sourceParent.space != stage.space or
                        sourceParent.direct_child_count == 0 or
                        Map.get(
                            mem.plain_children,
                            Text.compare,
                            childKey(
                                stage.space,
                                sourceParent.node_id,
                                source.name,
                            ),
                        ) != ?source.node_id
                    ) Runtime.trap(
                        "Files Shared republish source parent changed"
                    );
                    ?(source, sourceParent);
                };
            };

            let file : Memory.PlainFile = {
                content_id = stage.content_id;
                block_count = stage.block_count;
                total_bytes = stage.total_bytes;
                content_kind = stage.content_kind;
                media_type = stage.media_type;
                etag_sha256 = stage.etag_sha256;
                presentation = stage.presentation;
                publication;
            };
            let revision : Nat64 = switch (current, committedMoveState) {
                case (?node, null) checkedNextRevision(node.revision);
                case (null, ?(source, _)) {
                    checkedNextRevision(source.revision);
                };
                case (null, null) 1 : Nat64;
                case (_) Runtime.trap(
                    "Files plaintext commit source overlap"
                );
            };
            let committedAt = switch (stage.space) {
                // Shared keeps modified_at_ns frozen as its conservative
                // Certified Assets lifetime anchor. The visible file still
                // receives the time of its successful final publication.
                case (#shared_) nowNs();
                case (#workspace) stage.modified_at_ns;
            };
            let node : Memory.PlainNode = {
                node_id = stage.node_id;
                space = stage.space;
                parent_id = effectiveParentId;
                name = stage.name;
                kind = #file;
                file = ?file;
                created_at_ns = stage.created_at_ns;
                modified_at_ns = committedAt;
                revision;
                children_revision = 0;
                direct_child_count = 0;
            };
            let oldBytes = switch (current) {
                case (?oldNode) {
                    let ?oldFile = oldNode.file else {
                        Runtime.trap("Files plaintext prior file missing content");
                    };
                    if (stage.space == #workspace) {
                        deleteWorkspaceBlocks(oldFile);
                    };
                    oldFile.total_bytes;
                };
                case null 0;
            };
            let movedBytes = switch (committedMoveState) {
                case (?(source, _)) {
                    let ?sourceFile = source.file else {
                        Runtime.trap(
                            "Files Shared move source lost its content"
                        );
                    };
                    sourceFile.total_bytes;
                };
                case null 0;
            };
            switch (stage.space) {
                case (#workspace) {
                    if (mem.workspace_plaintext_bytes < oldBytes) {
                        Runtime.trap("Files Workspace usage underflow");
                    };
                    mem.workspace_plaintext_bytes :=
                        mem.workspace_plaintext_bytes - oldBytes +
                        stage.total_bytes;
                    if (mem.staged_workspace_bytes < stage.total_bytes) {
                        Runtime.trap("Files Workspace staging underflow");
                    };
                    mem.staged_workspace_bytes -= stage.total_bytes;
                };
                case (#shared_) {
                    if (
                        mem.shared_plaintext_bytes < oldBytes + movedBytes
                    ) {
                        Runtime.trap("Files Shared usage underflow");
                    };
                    mem.shared_plaintext_bytes :=
                        mem.shared_plaintext_bytes - oldBytes - movedBytes +
                        stage.total_bytes;
                    if (current == null and committedMoveState == null) {
                        if (mem.shared_file_count >= Types.MAX_SHARED_FILES) {
                            Runtime.trap(
                                "Files Shared durable entry reservation overflow"
                            );
                        };
                        mem.shared_file_count += 1;
                    };
                };
            };
            Map.add(mem.plain_nodes, Nat64.compare, node.node_id, node);
            if (current == null) {
                switch (committedMoveState) {
                    case (?(source, sourceParent)) {
                        if (
                            not Map.delete(
                                mem.plain_children,
                                Text.compare,
                                childKey(
                                    stage.space,
                                    sourceParent.node_id,
                                    source.name,
                                ),
                            )
                        ) Runtime.trap(
                            "Files Shared republish lost source index"
                        );
                        Map.add(
                            mem.plain_children,
                            Text.compare,
                                childKey(
                                    stage.space,
                                    effectiveParentId,
                                    stage.name,
                                ),
                            node.node_id,
                        );
                        if (sourceParent.node_id == parent.node_id) {
                            Map.add(
                                mem.plain_nodes,
                                Nat64.compare,
                                parent.node_id,
                                reviseFolder(parent, 0, committedAt),
                            );
                        } else {
                            Map.add(
                                mem.plain_nodes,
                                Nat64.compare,
                                sourceParent.node_id,
                                reviseFolder(
                                    sourceParent,
                                    -1,
                                    committedAt,
                                ),
                            );
                            Map.add(
                                mem.plain_nodes,
                                Nat64.compare,
                                parent.node_id,
                                reviseFolder(parent, 1, committedAt),
                            );
                        };
                    };
                    case null {
                        Map.add(
                            mem.plain_children,
                            Text.compare,
                            childKey(
                                stage.space,
                                effectiveParentId,
                                stage.name,
                            ),
                            node.node_id,
                        );
                        Map.add(
                            mem.plain_nodes,
                            Nat64.compare,
                            parent.node_id,
                            reviseFolder(parent, 1, committedAt),
                        );
                    };
                };
            };
            retireStageLocal(stage);
            #ok(node);
        };

        func retireStage(
            stage : Memory.PlainStage,
            abortCertified : Bool,
        ) : Result<()> {
            switch (stage.space) {
                case (#workspace) {
                    var index : Nat32 = 0;
                    while (index < stage.next_block_index) {
                        let key = (stage.content_id, index);
                        switch (
                            Map.get(mem.plain_blocks, comparePlainBlockKey, key)
                        ) {
                            case (?body) {
                                if (mem.staged_workspace_bytes < body.size()) {
                                    return #err(Types.reject(#corrupt_state));
                                };
                                mem.staged_workspace_bytes -= body.size();
                                ignore Map.delete(
                                    mem.plain_blocks,
                                    comparePlainBlockKey,
                                    key,
                                );
                            };
                            case null return #err(Types.reject(#corrupt_state));
                        };
                        index += 1;
                    };
                };
                case (#shared_) {
                    if (abortCertified) {
                        let ?kernelStageId = stage.kernel_stage_id else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        switch (certifiedAssets.abort_stage(kernelStageId)) {
                            case (#ok) {};
                            case (#err(#aborted)) {};
                            case (#err(#expired)) {};
                            case (#err(#not_found)) {};
                            case (#err(error)) return #err(capError(error));
                        };
                    };
                };
            };
            retireStageLocal(stage);
            #ok(());
        };

        func reapExpiredStages(limit : Nat) : Nat32 {
            if (limit == 0) return 0;
            let timestamp = nowNs();
            let expired = List.empty<Memory.PlainStage>();
            label scan for ((_, stage) in Map.entries(mem.plain_stages)) {
                let isExpired = switch (stage.space) {
                    case (#workspace) {
                        // Workspace measures inactivity and refreshes this
                        // timestamp on accepted or replayed blocks.
                        timestamp >= stage.modified_at_ns and
                        timestamp - stage.modified_at_ns >=
                            Types.PLAIN_STAGE_IDLE_NS;
                    };
                    case (#shared_) {
                        // Shared uses the immutable start/Kernel-capped
                        // deadline persisted from begin_stage.
                        let ?deadline = stage.shared_expires_at_ns else {
                            Runtime.trap(
                                "Files Shared stage omitted its local deadline"
                            );
                        };
                        timestamp >= deadline;
                    };
                };
                if (isExpired) {
                    List.add(expired, stage);
                    if (List.size(expired) >= limit) break scan;
                };
            };
            var changed : Nat32 = 0;
            for (stage in List.values(expired)) {
                if (reapStage(stage)) changed += 1;
            };
            changed;
        };

        func reapStage(stage : Memory.PlainStage) : Bool {
            switch (stage.space) {
                case (#workspace) {
                    var reclaimed = 0;
                    var index : Nat32 = 0;
                    while (index < stage.next_block_index) {
                        let key = (stage.content_id, index);
                        switch (
                            Map.get(
                                mem.plain_blocks,
                                comparePlainBlockKey,
                                key,
                            )
                        ) {
                            case (?body) {
                                reclaimed += body.size();
                                ignore Map.delete(
                                    mem.plain_blocks,
                                    comparePlainBlockKey,
                                    key,
                                );
                            };
                            case null {};
                        };
                        index += 1;
                    };
                    if (mem.staged_workspace_bytes < reclaimed) {
                        Runtime.trap(
                            "Files expired Workspace stage accounting underflow"
                        );
                    };
                    mem.staged_workspace_bytes -= reclaimed;
                };
                case (#shared_) {
                    let ?kernelStageId = stage.kernel_stage_id else {
                        Runtime.trap(
                            "Files expired Shared stage omitted Kernel ID"
                        );
                    };
                    switch (certifiedAssets.abort_stage(kernelStageId)) {
                        case (#ok) {};
                        case (#err(#aborted)) {};
                        case (#err(#expired)) {};
                        case (#err(#not_found)) {};
                        case (#err(_)) {
                            // Keep both local indexes so every subsequent
                            // cleanup/app call retries the abort. Dropping the
                            // only request handle here could leave the sole
                            // Certified Assets pending slot occupied until its
                            // independently refreshed expiry.
                            return false;
                        };
                    };
                };
            };
            retireStageLocal(stage);
            storeRetiredStageReceipt(stage);
            true;
        };

        func abortUnattachedSharedStage(kernelStageId : Nat64) {
            switch (certifiedAssets.abort_stage(kernelStageId)) {
                case (#ok) {};
                case (#err(#aborted)) {};
                case (#err(#expired)) {};
                case (#err(#not_found)) {};
                case (#err(_)) {
                    // No local stage/request index exists yet. A returned error
                    // would lose the only cleanup handle, so roll back the
                    // begin-stage effect with the enclosing update.
                    Runtime.trap(
                        "Files could not retire an unattached Shared stage"
                    );
                };
            };
        };

        func retireStageLocal(stage : Memory.PlainStage) {
            ignore Map.delete(
                mem.plain_stage_by_request,
                Text.compare,
                stage.request_id,
            );
            ignore Map.delete(mem.plain_stages, Nat64.compare, stage.stage_id);
        };

        func deleteWorkspaceBlocks(file : Memory.PlainFile) {
            var index : Nat32 = 0;
            while (index < file.block_count) {
                if (
                    not Map.delete(
                        mem.plain_blocks,
                        comparePlainBlockKey,
                        (file.content_id, index),
                    )
                ) Runtime.trap("Files Workspace block missing during retirement");
                index += 1;
            };
        };

        func deletePublication(
            publication : Memory.PlainSharedIdentity,
            nonce : Blob,
        ) : Result<()> {
            if (nonce.size() != 16) {
                return #err(Types.reject(#invalid_request));
            };
            if (
                publication.kernel_revision == 0 or
                publication.kernel_revision == Nat64.maxValue or
                publication.content_tag.size() != 32
            ) return #err(Types.reject(#corrupt_state));
            switch (
                certifiedAssets.commit_batch({
                    nonce;
                    operations = [#delete({
                        target = capTarget(publication.target);
                        condition = {
                            revision = publication.kernel_revision;
                            content_tag = publication.content_tag;
                        };
                    })];
                    requires_present_after = [];
                })
            ) {
                case (#ok(receipt)) {
                    if (receipt.operations.size() != 1) {
                        Runtime.trap("Files Shared delete receipt count mismatch");
                    };
                    switch (receipt.operations[0]) {
                        case (#delete(value)) {
                            if (
                                value.request_index != 0 or
                                value.identity.target !=
                                    capTarget(publication.target) or
                                value.identity.kernel_revision !=
                                    publication.kernel_revision + 1 or
                                value.identity.prior_content_tag !=
                                    publication.content_tag
                            ) Runtime.trap(
                                "Files Shared delete receipt identity mismatch"
                            );
                        };
                        case (_) Runtime.trap(
                            "Files Shared delete receipt kind mismatch"
                        );
                    };
                    #ok(());
                };
                case (#err(error)) #err(capError(error));
            };
        };

        func putIdentity(
            receipt : NeutronCapabilities.BatchReceipt,
            stage : Memory.PlainStage,
        ) : ?NeutronCapabilities.RecordIdentity {
            if (receipt.operations.size() != 1) return null;
            switch (receipt.operations[0]) {
                case (#put(value)) {
                    if (value.request_index != 0) return null;
                    let identity = value.lifecycle.committed;
                    let ?target = stage.target else return null;
                    if (
                        identity.target != capTarget(target) or
                        identity.kernel_revision != 1 or
                        identity.content_tag.size() != 32 or
                        identity.body_bytes != stage.total_bytes or
                        not pinnedGeometryMatches(
                            identity.geometry,
                            canonicalBlockLengths(stage.total_bytes),
                            stage.total_bytes,
                        ) or
                        identity.block_hashes.size() !=
                            stage.block_hashes.size()
                    ) return null;
                    var index = 0;
                    while (index < identity.block_hashes.size()) {
                        let ?stored = stage.block_hashes[index] else {
                            return null;
                        };
                        if (
                            identity.block_hashes[index].size() != 32 or
                            identity.block_hashes[index] != stored
                        ) return null;
                        index += 1;
                    };
                    ?identity;
                };
                case (_) null;
            };
        };

        func projectedPlainBytes(
            space : Types.Space,
            committed : Nat,
        ) : Result<Nat> {
            let expectedSpace = memorySpace(space);
            var projected = committed;
            for ((_, stage) in Map.entries(mem.plain_stages)) {
                if (stage.space == expectedSpace) {
                    let replaced = switch (stage.existing_node_id) {
                        case null 0;
                        case (?nodeId) {
                            switch (
                                Map.get(
                                    mem.plain_nodes,
                                    Nat64.compare,
                                    nodeId,
                                )
                            ) {
                                case null 0;
                                case (?node) {
                                    let ?file = node.file else {
                                        return #err(
                                            Types.reject(#corrupt_state)
                                        );
                                    };
                                    file.total_bytes;
                                };
                            };
                        };
                    };
                    let moved = switch (stage.move_source) {
                        case (?source) source.total_bytes;
                        case null 0;
                    };
                    let displaced = replaced + moved;
                    if (committed < displaced) {
                        return #err(Types.reject(#corrupt_state));
                    };
                    // A pending shrink is not durable capacity and therefore
                    // cannot lend its negative delta to another stage.
                    if (stage.total_bytes > displaced) {
                        projected += stage.total_bytes - displaced;
                    };
                };
            };
            #ok(projected);
        };

        func projectedSharedFiles() : Result<Nat> {
            if (mem.shared_file_count > Types.MAX_SHARED_FILES) {
                return #err(Types.reject(#corrupt_state));
            };
            var projected = mem.shared_file_count;
            for ((_, stage) in Map.entries(mem.plain_stages)) {
                if (
                    stage.space == #shared_ and
                    stage.existing_node_id == null and
                    stage.move_source == null
                ) {
                    projected += 1;
                    if (projected > Types.MAX_SHARED_FILES) {
                        return #err(Types.reject(#quota));
                    };
                };
            };
            #ok(projected);
        };

        func reservedPlainNodes(
            excludingStageId : ?Nat64
        ) : Result<Nat> {
            var reserved = 0;
            for ((_, stage) in Map.entries(mem.plain_stages)) {
                let excluded = switch (excludingStageId) {
                    case (?stageId) stage.stage_id == stageId;
                    case null false;
                };
                if (not excluded) {
                    let stateResult = stageParentState(stage);
                    let #ok(state) = stateResult else {
                        let #err(error) = stateResult else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        return #err(error);
                    };
                    reserved += state.reserved_missing;
                    if (
                        stage.existing_node_id == null and
                        stage.move_source == null
                    ) reserved += 1;
                    if (reserved > Types.MAX_PLAIN_NODES) {
                        return #err(Types.reject(#corrupt_state));
                    };
                };
            };
            #ok(reserved);
        };

        func reservedPlainParentIds(
            excludingStageId : ?Nat64
        ) : Result<Nat> {
            var reserved = 0;
            for ((_, stage) in Map.entries(mem.plain_stages)) {
                let excluded = switch (excludingStageId) {
                    case (?stageId) stage.stage_id == stageId;
                    case null false;
                };
                if (not excluded) {
                    let stateResult = stageParentState(stage);
                    let #ok(state) = stateResult else {
                        let #err(error) = stateResult else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        return #err(error);
                    };
                    reserved += state.reserved_missing;
                    if (reserved > Types.MAX_PLAIN_NODES) {
                        return #err(Types.reject(#corrupt_state));
                    };
                };
            };
            #ok(reserved);
        };

        func hasStageAtOrBelow(space : Types.Space, path : Text) : Bool {
            let expectedSpace = memorySpace(space);
            let prefix = if (path == "/") "/" else path # "/";
            for ((_, stage) in Map.entries(mem.plain_stages)) {
                if (
                    stage.space == expectedSpace and
                    (
                        stage.path == path or
                        Text.startsWith(stage.path, #text prefix)
                    )
                ) return true;
                switch (stage.move_source) {
                    case (?source) {
                        let sourcePrefix = if (path == "/") {
                            "/"
                        } else path # "/";
                        if (
                            stage.space == expectedSpace and
                            (
                                source.path == path or
                                Text.startsWith(
                                    source.path,
                                    #text sourcePrefix,
                                )
                            )
                        ) return true;
                    };
                    case null {};
                };
            };
            false;
        };

        func mkdirConflictsWithStageTarget(
            space : Types.Space,
            path : Text,
        ) : Bool {
            let expectedSpace = memorySpace(space);
            for ((_, stage) in Map.entries(mem.plain_stages)) {
                let prefix = stage.path # "/";
                if (
                    stage.space == expectedSpace and
                    (
                        path == stage.path or
                        Text.startsWith(path, #text prefix)
                    )
                ) return true;
            };
            false;
        };

        func checkMutationPreconditions(
            node : Memory.PlainNode,
            expectedNodeId : Nat64,
            expectedRevision : Nat64,
            ifMatch : ?Text,
        ) : ?Types.RejectionReason {
            if (node.node_id != expectedNodeId) {
                return ?#stale_revision;
            };
            if (node.revision != expectedRevision) {
                return ?#stale_revision;
            };
            switch (ifMatch, node.file) {
                case (null, _) null;
                case (?expected, ?file) {
                    if (expected == file.etag_sha256) null else ?#stale_content;
                };
                case (?_, null) ?#not_file;
            };
        };

        func planParent(
            space : Types.Space,
            segments : [Text],
            createParents : Bool,
        ) : Result<ParentPlan> {
            let ?root = rootNode(space) else {
                return #err(Types.reject(#corrupt_state));
            };
            var current = root;
            var collectingMissing = false;
            let missing = List.empty<Text>();
            for (segment in segments.vals()) {
                if (collectingMissing) {
                    List.add(missing, segment);
                } else {
                    if (current.kind != #folder) {
                        return #err(Types.reject(#not_folder));
                    };
                    switch (
                        Map.get(
                            mem.plain_children,
                            Text.compare,
                            childKey(
                                memorySpace(space),
                                current.node_id,
                                segment,
                            ),
                        )
                    ) {
                        case (?nodeId) {
                            let ?node = Map.get(
                                mem.plain_nodes,
                                Nat64.compare,
                                nodeId,
                            ) else {
                                return #err(Types.reject(#corrupt_state));
                            };
                            if (
                                node.parent_id != current.node_id or
                                node.space != memorySpace(space) or
                                node.name != segment
                            ) {
                                return #err(Types.reject(#corrupt_state));
                            };
                            current := node;
                        };
                        case null {
                            if (not createParents) {
                                return #err(Types.reject(#not_found));
                            };
                            collectingMissing := true;
                            List.add(missing, segment);
                        };
                    };
                };
            };
            if (current.kind != #folder) {
                return #err(Types.reject(#not_folder));
            };
            #ok({ base = current; missing = List.toArray(missing) });
        };

        func stageParentState(
            stage : Memory.PlainStage
        ) : Result<StageParentState> {
            let space = publicSpace(stage.space);
            let ?segments = canonicalSegments(space, stage.path) else {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                segments.size() == 0 or
                segments[segments.size() - 1] != stage.name
            ) return #err(Types.reject(#corrupt_state));
            let targetParent = parentSegments(segments);
            let ?root = rootNode(space) else {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                root.kind != #folder or
                root.space != stage.space or
                root.parent_id != root.node_id
            ) return #err(Types.reject(#corrupt_state));

            var current = root;
            var storedBaseDepth : ?Nat =
                if (root.node_id == stage.parent_id) ?0 else null;
            var depth = 0;
            var collectingMissing = false;
            let missing = List.empty<Text>();
            for (name in targetParent.vals()) {
                depth += 1;
                if (collectingMissing) {
                    List.add(missing, name);
                } else {
                    if (current.kind != #folder) {
                        return #err(Types.reject(#not_folder));
                    };
                    let key = childKey(
                        stage.space,
                        current.node_id,
                        name,
                    );
                    switch (
                        Map.get(mem.plain_children, Text.compare, key)
                    ) {
                        case (?nodeId) {
                            let ?node = Map.get(
                                mem.plain_nodes,
                                Nat64.compare,
                                nodeId,
                            ) else {
                                return #err(
                                    Types.reject(#corrupt_state)
                                );
                            };
                            if (
                                node.space != stage.space or
                                node.parent_id != current.node_id or
                                node.name != name or
                                node.kind != #folder
                            ) {
                                return #err(
                                    Types.reject(
                                        if (node.kind == #folder) {
                                            #corrupt_state
                                        } else #not_folder
                                    )
                                );
                            };
                            current := node;
                            if (node.node_id == stage.parent_id) {
                                if (storedBaseDepth != null) {
                                    return #err(
                                        Types.reject(#corrupt_state)
                                    );
                                };
                                storedBaseDepth := ?depth;
                            };
                        };
                        case null {
                            // parent_id is the deepest existing base captured
                            // by the new writer, or the already-materialized
                            // final parent captured by older code. It must have
                            // appeared before the first missing segment.
                            if (storedBaseDepth == null) {
                                return #err(
                                    Types.reject(#corrupt_state)
                                );
                            };
                            collectingMissing := true;
                            List.add(missing, name);
                        };
                    };
                };
            };
            let ?baseDepth = storedBaseDepth else {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                current.kind != #folder or
                baseDepth > targetParent.size()
            ) return #err(Types.reject(#corrupt_state));
            #ok({
                plan = {
                    base = current;
                    missing = List.toArray(missing);
                };
                // Fixed for the lifetime of the stage. Concurrent mkdir or a
                // sibling commit may make some folders real, but must not lend
                // this reservation to unrelated work.
                reserved_missing = targetParent.size() - baseDepth;
            });
        };

        func materializeReservedParent(
            space : Memory.PlainSpace,
            plan : ParentPlan,
        ) : Memory.PlainNode {
            var parent = plan.base;
            for (name in plan.missing.vals()) {
                switch (insertFolder(space, parent, name)) {
                    case (#ok(node)) parent := node;
                    case (#err(_)) Runtime.trap(
                        "Files reserved parent plan could not be materialized"
                    );
                };
            };
            parent;
        };

        func createFolder(
            space : Types.Space,
            parent : Memory.PlainNode,
            name : Text,
        ) : Result<Memory.PlainNode> {
            if (
                parent.kind != #folder or
                parent.space != memorySpace(space)
            ) return #err(Types.reject(#corrupt_state));
            let reservedResult = reservedPlainNodes(null);
            let #ok(reserved) = reservedResult else {
                let #err(error) = reservedResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let reservedParentIdsResult =
                reservedPlainParentIds(null);
            let #ok(reservedParentIds) = reservedParentIdsResult else {
                let #err(error) = reservedParentIdsResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            if (
                Map.size(mem.plain_nodes) + reserved >=
                    Types.MAX_PLAIN_NODES or
                not nodeIdsAvailable(reservedParentIds + 1) or
                not mutableFolder(parent, true)
            ) return #err(Types.reject(#quota));
            insertFolder(memorySpace(space), parent, name);
        };

        func insertFolder(
            space : Memory.PlainSpace,
            parent : Memory.PlainNode,
            name : Text,
        ) : Result<Memory.PlainNode> {
            if (
                parent.kind != #folder or
                parent.space != space or
                not validName(name) or
                not mutableFolder(parent, true)
            ) return #err(Types.reject(#corrupt_state));
            if (
                Map.get(
                    mem.plain_children,
                    Text.compare,
                    childKey(space, parent.node_id, name),
                ) != null
            ) return #err(Types.reject(#already_exists));
            let idResult = allocateNodeId();
            let #ok(nodeId) = idResult else {
                let #err(error) = idResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let timestamp = nowNs();
            let node : Memory.PlainNode = {
                node_id = nodeId;
                space;
                parent_id = parent.node_id;
                name;
                kind = #folder;
                file = null;
                created_at_ns = timestamp;
                modified_at_ns = timestamp;
                revision = 1;
                children_revision = 0;
                direct_child_count = 0;
            };
            Map.add(mem.plain_nodes, Nat64.compare, nodeId, node);
            Map.add(
                mem.plain_children,
                Text.compare,
                childKey(space, parent.node_id, name),
                nodeId,
            );
            Map.add(
                mem.plain_nodes,
                Nat64.compare,
                parent.node_id,
                reviseFolder(parent, 1, timestamp),
            );
            #ok(node);
        };

        func mutableFolder(
            folder : Memory.PlainNode,
            grows : Bool,
        ) : Bool {
            mutableFolderFor(folder, grows, 1);
        };

        func mutableFolderFor(
            folder : Memory.PlainNode,
            grows : Bool,
            revisionSteps : Nat64,
        ) : Bool {
            if (
                revisionSteps == 0 or
                revisionSteps > Nat64.maxValue
            ) return false;
            folder.kind == #folder and
            folder.revision <= Nat64.maxValue - revisionSteps and
            folder.children_revision <=
                Nat64.maxValue - revisionSteps and
            (not grows or folder.direct_child_count != Nat32.maxValue);
        };

        func missingMkdirSegments(
            space : Types.Space,
            segments : [Text],
            recursive : Bool,
        ) : Result<Nat> {
            let ?root = rootNode(space) else {
                return #err(Types.reject(#corrupt_state));
            };
            var parent = root;
            var missing = 0;
            var beneathMissing = false;
            var index = 0;
            for (name in segments.vals()) {
                index += 1;
                if (beneathMissing) {
                    missing += 1;
                } else {
                    switch (
                        Map.get(
                            mem.plain_children,
                            Text.compare,
                            childKey(
                                memorySpace(space),
                                parent.node_id,
                                name,
                            ),
                        )
                    ) {
                        case (?nodeId) {
                            let ?node = Map.get(
                                mem.plain_nodes,
                                Nat64.compare,
                                nodeId,
                            ) else {
                                return #err(
                                    Types.reject(#corrupt_state)
                                );
                            };
                            if (
                                node.kind != #folder or
                                node.space != memorySpace(space) or
                                node.parent_id != parent.node_id or
                                node.name != name
                            ) {
                                return #err(
                                    Types.reject(
                                        if (node.kind == #folder) {
                                            #corrupt_state
                                        } else #not_folder
                                    )
                                );
                            };
                            parent := node;
                        };
                        case null {
                            if (
                                not recursive and
                                index < segments.size()
                            ) {
                                return #err(Types.reject(#not_found));
                            };
                            beneathMissing := true;
                            missing += 1;
                        };
                    };
                };
            };
            #ok(missing);
        };

        func nodeIdsAvailable(count : Nat) : Bool {
            count <= Nat64.toNat(
                Nat64.maxValue - mem.next_plain_node_id
            );
        };

        func locate(
            space : Types.Space,
            segments : [Text],
        ) : Result<Memory.PlainNode> {
            let memoryRoot = rootNode(space);
            let ?root = memoryRoot else return #err(Types.reject(#corrupt_state));
            var current = root;
            var depth = 0;
            for (segment in segments.vals()) {
                depth += 1;
                if (depth > 64 or current.kind != #folder) {
                    return #err(Types.reject(#not_folder));
                };
                let ?nodeId = Map.get(
                    mem.plain_children,
                    Text.compare,
                    childKey(memorySpace(space), current.node_id, segment),
                ) else return #err(Types.reject(#not_found));
                let ?node = Map.get(
                    mem.plain_nodes,
                    Nat64.compare,
                    nodeId,
                ) else return #err(Types.reject(#corrupt_state));
                if (
                    node.parent_id != current.node_id or
                    node.space != memorySpace(space) or
                    node.name != segment
                ) return #err(Types.reject(#corrupt_state));
                current := node;
            };
            #ok(current);
        };

        func rootNode(space : Types.Space) : ?Memory.PlainNode {
            Map.get(
                mem.plain_nodes,
                Nat64.compare,
                if (space == #workspace) {
                    mem.workspace_root_id
                } else mem.shared_root_id,
            );
        };

        func isDescendant(
            candidateAncestor : Nat64,
            start : Memory.PlainNode,
        ) : Bool {
            var current = start;
            var depth = 0;
            while (depth <= 64) {
                if (current.node_id == candidateAncestor) return true;
                if (current.parent_id == current.node_id) return false;
                let ?parent = Map.get(
                    mem.plain_nodes,
                    Nat64.compare,
                    current.parent_id,
                ) else return true;
                current := parent;
                depth += 1;
            };
            true;
        };

        func subtreeMoveFits(
            source : Memory.PlainNode,
            destinationSegments : [Text],
            destinationPath : Text,
        ) : Result<Bool> {
            let destinationBytes = Text.encodeUtf8(destinationPath).size();
            let destinationScalars = destinationPath.size();
            let scalarLimit = switch (source.space) {
                case (#shared_) Types.MAX_SHARED_RELATIVE_PATH_SCALARS;
                case (#workspace) Types.MAX_WORKSPACE_RELATIVE_PATH_SCALARS;
            };
            func visit(
                parent : Memory.PlainNode,
                relativeDepth : Nat,
                relativeBytes : Nat,
                relativeScalars : Nat,
            ) : Result<Bool> {
                if (parent.kind != #folder) {
                    return if (parent.direct_child_count == 0) {
                        #ok(true)
                    } else #err(Types.reject(#corrupt_state));
                };
                let prefix = childPrefix(
                    source.space,
                    parent.node_id,
                );
                let iterator = Map.entriesFrom(
                    mem.plain_children,
                    Text.compare,
                    prefix,
                );
                var seen : Nat32 = 0;
                label children loop {
                    let ?(key, childId) = iterator.next() else {
                        break children;
                    };
                    if (not Text.startsWith(key, #text prefix)) {
                        break children;
                    };
                    let ?child = Map.get(
                        mem.plain_nodes,
                        Nat64.compare,
                        childId,
                    ) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (
                        child.space != source.space or
                        child.parent_id != parent.node_id or
                        childKey(
                            source.space,
                            parent.node_id,
                            child.name,
                        ) != key or
                        not validName(child.name) or
                        seen == Nat32.maxValue
                    ) return #err(Types.reject(#corrupt_state));
                    seen += 1;
                    let childDepth = relativeDepth + 1;
                    let childBytes =
                        relativeBytes +
                        1 +
                        Text.encodeUtf8(child.name).size();
                    let childScalars =
                        relativeScalars + 1 + child.name.size();
                    if (
                        destinationSegments.size() + childDepth > 64 or
                        destinationBytes + childBytes >
                            Types.MAX_PATH_BYTES or
                        destinationScalars + childScalars > scalarLimit
                    ) return #ok(false);
                    switch (
                        visit(
                            child,
                            childDepth,
                            childBytes,
                            childScalars,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok(false)) return #ok(false);
                        case (#ok(true)) {};
                    };
                };
                if (seen != parent.direct_child_count) {
                    return #err(Types.reject(#corrupt_state));
                };
                #ok(true);
            };
            visit(source, 0, 0, 0);
        };

        func entry(node : Memory.PlainNode, path : Text) : Types.Entry {
            let (contentKind, byteLength, mediaType, etag, relativeUrl) =
                switch (node.file) {
                    case (?file) {
                        (
                            ?publicContentKind(file.content_kind),
                            ?Nat64.fromNat(file.total_bytes),
                            ?file.media_type,
                            ?file.etag_sha256,
                            switch (file.publication) {
                                case (?publication) ?relativeUrlFor(
                                    publication.target
                                );
                                case null null;
                            },
                        );
                    };
                    case null (null, null, null, null, null);
            };
            {
                node_id = node.node_id;
                path;
                name = node.name;
                kind = ?(
                    switch (node.kind) {
                        case (#folder) #folder;
                        case (#file) #file;
                    }
                );
                content_kind = contentKind;
                byte_length = byteLength;
                media_type = mediaType;
                etag_sha256 = etag;
                created_at_ns = node.created_at_ns;
                modified_at_ns = node.modified_at_ns;
                revision = node.revision;
                relative_url = relativeUrl;
            };
        };

        func validateWriteEnvelope(
            request : Types.WriteBlockRequest
        ) : Result<{
            space : Types.Space;
            contentKind : Types.ContentKind;
            totalBytes : Nat;
        }> {
            let ?space = request.space else {
                return #err(Types.reject(#incompatible));
            };
            let ?contentKind = request.content_kind else {
                return #err(Types.reject(#incompatible));
            };
            if (
                not validRequestId(request.request_id) or
                not validEtag(request.etag_sha256) or
                not validMediaType(request.media_type) or
                request.body.size() != Nat32.toNat(request.body_bytes) or
                request.block_count == 0 or
                request.block_count > Types.MAX_BLOCKS or
                request.block_index >= request.block_count or
                request.final != (
                    request.block_index + 1 == request.block_count
                )
            ) return #err(Types.reject(#invalid_request));
            switch (
                request.if_match,
                request.expected_node_id,
                request.expected_revision,
            ) {
                case (null, null, null) {
                    if (not request.if_none_match) {
                        return #err(Types.reject(#invalid_request));
                    };
                };
                case (?etag, ?nodeId, ?revision) {
                    if (
                        request.if_none_match or
                        not validEtag(etag) or
                        nodeId == 0 or
                        revision == 0
                    ) return #err(Types.reject(#invalid_request));
                };
                case (_) return #err(Types.reject(#invalid_request));
            };
            let totalBytes = Nat64.toNat(request.total_bytes);
            if (
                totalBytes > Types.MAX_FILE_BYTES or
                request.block_count != canonicalBlockCount(totalBytes) or
                request.body.size() != expectedBlockBytes(
                    totalBytes,
                    request.block_count,
                    request.block_index,
                )
            ) return #err(Types.reject(#invalid_request));
            let ?segments = canonicalSegments(space, request.path) else {
                return #err(Types.reject(#invalid_request));
            };
            if (segments.size() == 0) {
                return #err(Types.reject(#invalid_request));
            };
            if (space == #shared_) {
                let expectedPresentation = sharedPresentation(
                    segments[segments.size() - 1]
                );
                let expectedContentKind = switch (expectedPresentation) {
                    case (#inline_text) #text;
                    case (#attachment) #binary;
                };
                if (
                    request.presentation != ?expectedPresentation or
                    contentKind != expectedContentKind or
                    request.safe_name !=
                        ?sharedSafeName(segments[segments.size() - 1])
                ) return #err(Types.reject(#invalid_request));
            } else if (request.safe_name != null) {
                return #err(Types.reject(#invalid_request));
            };
            if (space == #workspace and request.move_source != null) {
                return #err(Types.reject(#invalid_request));
            };
            switch (request.move_source) {
                case (?source) {
                    if (
                        source.expected_node_id == 0 or
                        source.expected_revision == 0 or
                        (
                            switch (source.if_match) {
                                case null false;
                                case (?etag) not validEtag(etag);
                            }
                        )
                    ) return #err(Types.reject(#invalid_request));
                };
                case null {};
            };
            #ok({ space; contentKind; totalBytes });
        };

        func requestMatchesStage(
            request : Types.WriteBlockRequest,
            stage : Memory.PlainStage,
        ) : Bool {
            request.request_id == stage.request_id and
            request.space == ?publicSpace(stage.space) and
            request.path == stage.path and
            request.block_count == stage.block_count and
            Nat64.toNat(request.total_bytes) == stage.total_bytes and
            request.content_kind == ?publicContentKind(stage.content_kind) and
            request.media_type == stage.media_type and
            request.etag_sha256 == stage.etag_sha256 and
            memoryPresentation(request.presentation) == stage.presentation and
            request.expected_node_id == stage.existing_node_id and
            request.expected_revision == stage.existing_revision and
            request.if_match == stage.existing_etag_sha256 and
            moveSourceMatches(request.move_source, stage.move_source) and
            request.block_index <= stage.next_block_index
        };

        func moveSourceMatches(
            request : ?Types.WriteMoveSource,
            stored : ?Memory.PlainMoveSource,
        ) : Bool {
            switch (request, stored) {
                case (null, null) true;
                case (?outer, ?inner) {
                    outer.path == inner.path and
                    outer.expected_node_id == inner.node_id and
                    outer.expected_revision == inner.revision and
                    outer.if_match == inner.if_match;
                };
                case (_) false;
            };
        };

        func canonicalSegments(
            space : Types.Space,
            path : Text,
        ) : ?[Text] {
            let bytes = Text.encodeUtf8(path);
            if (
                bytes.size() == 0 or
                bytes.size() > Types.MAX_PATH_BYTES or
                not relativePathScalarsFit(space, path) or
                not Text.startsWith(path, #char '/') or
                Text.contains(path, #char '\\') or
                Text.contains(path, #char '\00') or
                Text.contains(path, #text "//") or
                (path != "/" and Text.endsWith(path, #char '/'))
            ) return null;
            let output = List.empty<Text>();
            for (segment in Text.split(path, #char '/')) {
                if (segment != "") {
                    if (not validName(segment)) return null;
                    List.add(output, segment);
                };
            };
            let result = List.toArray(output);
            if (result.size() > 64) null else ?result;
        };

        func relativePathScalarsFit(
            space : Types.Space,
            path : Text,
        ) : Bool {
            path.size() <= (
                if (space == #shared_) {
                    Types.MAX_SHARED_RELATIVE_PATH_SCALARS
                } else {
                    Types.MAX_WORKSPACE_RELATIVE_PATH_SCALARS
                }
            );
        };

        func validName(value : Text) : Bool {
            let bytes = Text.encodeUtf8(value);
            if (
                value == "" or value == "." or value == ".." or
                value.size() > 100 or
                bytes.size() > Types.MAX_NAME_BYTES
            ) return false;
            UnicodeNfc.isCanonicalNameText(value);
        };

        func validRequestId(value : Text) : Bool {
            let bytes = Text.encodeUtf8(value);
            if (
                bytes.size() == 0 or
                bytes.size() > Types.MAX_REQUEST_ID_BYTES
            ) return false;
            for (byte in bytes.vals()) {
                let n = Nat8.toNat(byte);
                let allowed =
                    (n >= 48 and n <= 57) or
                    (n >= 65 and n <= 90) or
                    (n >= 97 and n <= 122) or
                    n == 45 or n == 46 or n == 58 or n == 95;
                if (not allowed) return false;
            };
            true;
        };

        func validEtag(value : Text) : Bool {
            let bytes = Text.encodeUtf8(value);
            if (bytes.size() != Types.MAX_ETAG_BYTES) return false;
            for (byte in bytes.vals()) {
                let n = Nat8.toNat(byte);
                if (
                    not (
                        (n >= 48 and n <= 57) or
                        (n >= 97 and n <= 102)
                    )
                ) return false;
            };
            true;
        };

        func validMediaType(value : Text) : Bool {
            let bytes = Text.encodeUtf8(value);
            if (bytes.size() > Types.MAX_MEDIA_TYPE_BYTES) return false;
            for (byte in bytes.vals()) {
                if (byte < 32 or byte > 126) return false;
            };
            true;
        };

        func validSafeName(value : Text) : Bool {
            let bytes = Text.encodeUtf8(value);
            if (
                bytes.size() == 0 or bytes.size() > 100 or
                value == "." or value == ".."
            ) return false;
            for (byte in bytes.vals()) {
                let n = Nat8.toNat(byte);
                let allowed =
                    (n >= 48 and n <= 57) or
                    (n >= 65 and n <= 90) or
                    (n >= 97 and n <= 122) or
                    n == 45 or n == 46 or n == 95;
                if (not allowed) return false;
            };
            true;
        };

        func sharedSafeName(value : Text) : Text {
            // Mirrors the resident's public-name policy for canonical logical
            // paths: unsupported runs become one hyphen, edge hyphens are
            // trimmed, and the resulting ASCII name is capped at 100 bytes.
            let output = List.empty<Nat8>();
            var size = 0;
            var pendingHyphens = 0;
            var inUnsupportedRun = false;
            for (byte in Text.encodeUtf8(value).vals()) {
                let n = Nat8.toNat(byte);
                let allowedNonHyphen =
                    (n >= 48 and n <= 57) or
                    (n >= 65 and n <= 90) or
                    (n >= 97 and n <= 122) or
                    n == 46 or n == 95;
                if (allowedNonHyphen) {
                    inUnsupportedRun := false;
                    if (size == 0) {
                        // Leading hyphens are trimmed before the length cap.
                        pendingHyphens := 0;
                    };
                    while (pendingHyphens > 0 and size < 100) {
                        List.add(output, 45 : Nat8);
                        size += 1;
                        pendingHyphens -= 1;
                    };
                    if (size < 100) {
                        List.add(output, byte);
                        size += 1;
                    };
                } else if (n == 45) {
                    inUnsupportedRun := false;
                    pendingHyphens += 1;
                } else if (not inUnsupportedRun) {
                    inUnsupportedRun := true;
                    pendingHyphens += 1;
                };
            };
            let ?safe = Text.decodeUtf8(
                Blob.fromArray(List.toArray(output))
            ) else Runtime.trap("Files safe filename encoding failed");
            if (safe == "" or safe == "." or safe == "..") "file" else safe;
        };

        func canonicalBlockCount(totalBytes : Nat) : Nat32 {
            if (totalBytes == 0) return 1;
            Nat32.fromNat(
                (totalBytes + Types.BLOCK_BYTES - 1) / Types.BLOCK_BYTES
            );
        };

        func canonicalBlockLengths(totalBytes : Nat) : [Nat] {
            let count = Nat32.toNat(canonicalBlockCount(totalBytes));
            Array.tabulate<Nat>(
                count,
                func(index) {
                    if (totalBytes == 0) 0 else if (index + 1 < count) {
                        Types.BLOCK_BYTES
                    } else {
                        totalBytes - Types.BLOCK_BYTES * (count - 1)
                    };
                },
            );
        };

        func expectedBlockBytes(
            totalBytes : Nat,
            blockCount : Nat32,
            index : Nat32,
        ) : Nat {
            let count = Nat32.toNat(blockCount);
            let position = Nat32.toNat(index);
            if (totalBytes == 0) 0 else if (position + 1 < count) {
                Types.BLOCK_BYTES
            } else {
                totalBytes - Types.BLOCK_BYTES * (count - 1)
            };
        };

        func parentSegments(segments : [Text]) : [Text] {
            Array.tabulate<Text>(
                if (segments.size() == 0) 0 else segments.size() - 1,
                func(index) { segments[index] },
            );
        };

        func joinPath(parent : Text, name : Text) : Text {
            if (parent == "/") "/" # name else parent # "/" # name;
        };

        func childPrefix(space : Memory.PlainSpace, parentId : Nat64) : Text {
            (
                switch (space) {
                    case (#workspace) "w";
                    case (#shared_) "s";
                }
            ) # "\00" # Nat64.toText(parentId) # "\00";
        };

        func childKey(
            space : Memory.PlainSpace,
            parentId : Nat64,
            name : Text,
        ) : Text {
            childPrefix(space, parentId) # name;
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

        func reviseFolder(
            folder : Memory.PlainNode,
            childDelta : Int,
            timestamp : Nat64,
        ) : Memory.PlainNode {
            if (folder.kind != #folder) {
                Runtime.trap("Files plaintext folder revision targeted a file");
            };
            let count = if (childDelta < 0) {
                if (folder.direct_child_count == 0) {
                    Runtime.trap("Files plaintext child count underflow");
                };
                folder.direct_child_count - 1;
            } else if (childDelta > 0) {
                if (folder.direct_child_count == Nat32.maxValue) {
                    Runtime.trap("Files plaintext child count exhausted");
                };
                folder.direct_child_count + 1;
            } else folder.direct_child_count;
            {
                folder with
                modified_at_ns = timestamp;
                revision = checkedNextRevision(folder.revision);
                children_revision = checkedNextRevision(
                    folder.children_revision
                );
                direct_child_count = count;
            };
        };

        func checkedNextRevision(value : Nat64) : Nat64 {
            if (value == Nat64.maxValue) {
                Runtime.trap("Files plaintext revision exhausted");
            };
            value + 1;
        };

        func allocateNodeId() : Result<Nat64> {
            if (mem.next_plain_node_id == Nat64.maxValue) {
                return #err(Types.reject(#quota));
            };
            let value = mem.next_plain_node_id;
            mem.next_plain_node_id += 1;
            #ok(value);
        };

        func allocateContentId() : Result<Nat64> {
            if (mem.next_plain_content_id == Nat64.maxValue) {
                return #err(Types.reject(#quota));
            };
            let value = mem.next_plain_content_id;
            mem.next_plain_content_id += 1;
            #ok(value);
        };

        func allocateStageId() : Result<Nat64> {
            if (
                mem.next_plain_stage_id == Nat64.maxValue or
                Map.size(mem.plain_stages) >= 3
            ) return #err(Types.reject(#busy));
            let value = mem.next_plain_stage_id;
            mem.next_plain_stage_id += 1;
            #ok(value);
        };

        func sharedStageDeadline(
            startedAtNs : Nat64,
            kernelExpiresAtNs : Nat64,
        ) : ?Nat64 {
            if (
                startedAtNs >
                    Nat64.maxValue - Types.PLAIN_STAGE_IDLE_NS or
                kernelExpiresAtNs <= Types.SHARED_STAGE_KERNEL_MARGIN_NS
            ) return null;
            let startBound = startedAtNs + Types.PLAIN_STAGE_IDLE_NS;
            let kernelBound =
                kernelExpiresAtNs - Types.SHARED_STAGE_KERNEL_MARGIN_NS;
            let deadline = if (startBound < kernelBound) {
                startBound
            } else kernelBound;
            if (deadline <= startedAtNs) null else ?deadline;
        };

        func sharesGeneration() : Result<Nat64> {
            switch (certifiedAssets.scope_info()) {
                case (#err(error)) #err(capError(error));
                case (#ok(info)) {
                    if (
                        info.installation_generation == 0 or
                        info.store_authority_epoch == 0
                    ) Runtime.trap("Files Shared scope identity invalid");
                    var found : ?Nat64 = null;
                    for (collection in info.collections.vals()) {
                        if (collection.id == "shares") {
                            if (found != null) {
                                Runtime.trap(
                                    "Files Shared scope duplicated collection"
                                );
                            };
                            if (
                                collection.kind != #publication or
                                collection.serving != #enabled or
                                collection.writes != #enabled
                            ) return #err(Types.reject(#not_ready));
                            if (
                                collection.authority_epoch == 0 or
                                collection.generation == 0 or
                                collection.generation == Nat64.maxValue
                            ) Runtime.trap(
                                "Files Shared scope generation invalid"
                            );
                            found := ?collection.generation;
                        };
                    };
                    switch (found) {
                        case (?generation) #ok(generation);
                        case null #err(Types.reject(#not_ready));
                    };
                };
            };
        };

        func capTarget(
            value : Memory.PlainPublicationTarget
        ) : NeutronCapabilities.Target {
            {
                collection = value.collection;
                collection_generation = value.collection_generation;
                locator = #publication({
                    publication_id = value.publication_id;
                    filename = value.filename;
                });
            };
        };

        func pinnedGeometryMatches(
            geometry : NeutronCapabilities.StageGeometry,
            lengths : [Nat],
            expectedBytes : Nat,
        ) : Bool {
            geometry.expected_bytes == expectedBytes and
            geometry.block_count == Nat32.fromNat(lengths.size()) and
            geometry.block_bytes == Types.BLOCK_BYTES;
        };

        func plainTarget(
            value : NeutronCapabilities.Target
        ) : ?Memory.PlainPublicationTarget {
            switch (value.locator) {
                case (#publication(publication)) ?{
                    collection = value.collection;
                    collection_generation = value.collection_generation;
                    publication_id = publication.publication_id;
                    filename = publication.filename;
                    // Locked schema-V2 baggage from the retired share plane.
                    // Generic Certified Assets publications have no such
                    // generation; new rows store zero and never consume it.
                    publication_generation = 0;
                };
                case (_) null;
            };
        };

        func relativeUrlFor(target : Memory.PlainPublicationTarget) : Text {
            "/app/files/_route/shares/" #
            hex(target.publication_id) # "/" # target.filename;
        };

        func hex(value : Blob) : Text {
            var output = "";
            for (byte in value.vals()) {
                let n = Nat8.toNat(byte);
                output #= hexDigit(n / 16) # hexDigit(n % 16);
            };
            output;
        };

        func rawSha256Matches(
            value : ?Blob,
            complete : Bool,
            expectedHex : Text,
        ) : Bool {
            switch (value) {
                case null not complete;
                case (?digest) complete and hex(digest) == expectedHex;
            };
        };

        func hexDigit(value : Nat) : Text {
            switch (value) {
                case (0) "0";
                case (1) "1";
                case (2) "2";
                case (3) "3";
                case (4) "4";
                case (5) "5";
                case (6) "6";
                case (7) "7";
                case (8) "8";
                case (9) "9";
                case (10) "a";
                case (11) "b";
                case (12) "c";
                case (13) "d";
                case (14) "e";
                case (15) "f";
                case (_) Runtime.trap("Files hex digit out of range");
            };
        };

        func memorySpace(value : Types.Space) : Memory.PlainSpace {
            switch (value) {
                case (#workspace) #workspace;
                case (#shared_) #shared_;
            };
        };

        func publicSpace(value : Memory.PlainSpace) : Types.Space {
            switch (value) {
                case (#workspace) #workspace;
                case (#shared_) #shared_;
            };
        };

        func memoryContentKind(
            value : Types.ContentKind
        ) : Memory.PlainContentKind {
            switch (value) {
                case (#text) #text;
                case (#binary) #binary;
            };
        };

        func publicContentKind(
            value : Memory.PlainContentKind
        ) : Types.ContentKind {
            switch (value) {
                case (#text) #text;
                case (#binary) #binary;
            };
        };

        func memoryPresentation(
            value : ?Types.Presentation
        ) : ?Memory.PlainPresentation {
            switch (value) {
                case null null;
                case (?#inline_text) ?#inline_text;
                case (?#attachment) ?#attachment;
            };
        };

        func capPresentation(
            value : Types.Presentation
        ) : NeutronCapabilities.PublicationPresentation {
            switch (value) {
                case (#inline_text) #inline_text;
                case (#attachment) #attachment;
            };
        };

        // The capability's inline profile serves these as safe plain text,
        // including HTML and script source; it never executes their contents.
        let inlineTextSuffixes : [Text] = [
            ".bash",
            ".bat",
            ".c",
            ".cc",
            ".cfg",
            ".cjs",
            ".cmd",
            ".conf",
            ".config",
            ".cpp",
            ".css",
            ".csv",
            ".cts",
            ".cxx",
            ".diff",
            ".env",
            ".fish",
            ".go",
            ".gql",
            ".graphql",
            ".h",
            ".hpp",
            ".htm",
            ".html",
            ".ini",
            ".java",
            ".js",
            ".json",
            ".json5",
            ".jsonl",
            ".jsx",
            ".log",
            ".lua",
            ".md",
            ".markdown",
            ".mjs",
            ".mts",
            ".ndjson",
            ".patch",
            ".php",
            ".properties",
            ".proto",
            ".ps1",
            ".py",
            ".r",
            ".rb",
            ".rs",
            ".scss",
            ".sh",
            ".shell",
            ".source",
            ".sql",
            ".svelte",
            ".swift",
            ".text",
            ".toml",
            ".ts",
            ".tsv",
            ".tsx",
            ".txt",
            ".vue",
            ".xml",
            ".yaml",
            ".yml",
            ".zsh",
        ];

        func sharedPresentation(name : Text) : Types.Presentation {
            let lower = Text.toLower(name);
            for (suffix in inlineTextSuffixes.vals()) {
                if (hasExtension(lower, suffix)) return #inline_text;
            };
            #attachment;
        };

        func hasExtension(name : Text, suffix : Text) : Bool {
            // Equality deliberately admits exact text dotfiles such as `.env`.
            name.size() >= suffix.size() and
            Text.endsWith(name, #text suffix);
        };

        func capError(
            error : NeutronCapabilities.Error
        ) : Types.Rejection {
            switch (error) {
                case (#invalid) Types.reject(#invalid_request);
                case (#stale_scope) Types.reject(#not_ready);
                case (#stale_generation(_)) Types.reject(#stale_revision);
                case (#disabled) Types.reject(#temporarily_unavailable);
                case (#frozen) Types.reject(#temporarily_unavailable);
                case (#not_found) Types.reject(#not_found);
                case (#retired_key) Types.reject(#conflict);
                case (#conflict(_)) Types.reject(#conflict);
                case (#quota) Types.reject(#quota);
                case (#receipt_full) Types.reject(#quota);
                case (#aborted) Types.reject(#conflict);
                case (#expired) Types.reject(#conflict);
                case (#incomplete(_)) Types.reject(#invalid_request);
                case (#not_ready) Types.reject(#not_ready);
                case (#generation_exhausted) Types.reject(#quota);
                case (#revision_exhausted) Types.reject(#quota);
                case (#low_cycles) Types.reject(#temporarily_unavailable);
                case (#busy) Types.reject(#busy);
            };
        };

        func checkWriteReceipt(
            requestId : Text,
            fingerprint : Memory.Tag256,
        ) : ReceiptCheck<Types.WriteBlockResponse> {
            let ?receipt = Map.get(
                mem.plain_terminal_receipts,
                Text.compare,
                requestId,
            ) else return #none;
            if (receipt.expires_at_ns <= nowNs()) {
                ignore Map.delete(
                    mem.plain_terminal_receipts,
                    Text.compare,
                    requestId,
                );
                return #none;
            };
            if (receipt.fingerprint != fingerprint) return #conflict;
            switch (receipt.outcome) {
                case (#write(value)) {
                    #replay({
                        outcome = ?#ok({
                            stage_id = null;
                            committed = true;
                            entry = ?entry(value.node, value.path);
                        });
                    });
                };
                case (#mutation(_)) #conflict;
                case (#retired_stage) #conflict;
            };
        };

        func checkMutationReceipt(
            requestId : Text,
            fingerprint : Memory.Tag256,
        ) : ReceiptCheck<Types.MutationResponse> {
            let ?receipt = Map.get(
                mem.plain_terminal_receipts,
                Text.compare,
                requestId,
            ) else return #none;
            if (receipt.expires_at_ns <= nowNs()) {
                ignore Map.delete(
                    mem.plain_terminal_receipts,
                    Text.compare,
                    requestId,
                );
                return #none;
            };
            if (receipt.fingerprint != fingerprint) return #conflict;
            switch (receipt.outcome) {
                case (#mutation(value)) {
                    #replay(mutationOk(
                        value.path,
                        value.revision,
                        value.changed,
                    ));
                };
                case (#write(_)) #conflict;
                case (#retired_stage) #conflict;
            };
        };

        func storeRetiredStageReceipt(stage : Memory.PlainStage) {
            let expiredAt = switch (stage.space) {
                case (#workspace) {
                    if (
                        stage.modified_at_ns >
                            Nat64.maxValue -
                            Types.PLAIN_STAGE_IDLE_NS
                    ) Nat64.maxValue else
                    stage.modified_at_ns + Types.PLAIN_STAGE_IDLE_NS;
                };
                case (#shared_) {
                    let ?deadline = stage.shared_expires_at_ns else {
                        Runtime.trap(
                            "Files Shared retired stage deadline"
                        );
                    };
                    deadline;
                };
            };
            let receiptDeadline = if (
                expiredAt >
                    Nat64.maxValue -
                    Types.PLAIN_RECEIPT_RETENTION_NS
            ) Nat64.maxValue else
            expiredAt + Types.PLAIN_RECEIPT_RETENTION_NS;
            // Retention is measured from the terminal event, not from a late
            // maintenance pass that happened to discover it.
            if (receiptDeadline <= nowNs()) return;
            let requestId = stage.request_id;
            if (
                Map.get(
                    mem.plain_terminal_receipts,
                    Text.compare,
                    requestId,
                ) != null or
                Map.size(mem.plain_terminal_receipts) >=
                    Types.MAX_PLAIN_TERMINAL_RECEIPTS
            ) Runtime.trap(
                "Files plaintext expired stage receipt reservation"
            );
            let receipt : Memory.PlainTerminalReceipt = {
                fingerprint = (0, 0, 0, 0);
                outcome = #retired_stage;
                expires_at_ns = receiptDeadline;
            };
            Map.add(
                mem.plain_terminal_receipts,
                Text.compare,
                requestId,
                receipt,
            );
        };

        func storeWriteReceipt(
            requestId : Text,
            fingerprint : Memory.Tag256,
            path : Text,
            node : Memory.PlainNode,
        ) {
            if (
                Map.get(
                    mem.plain_terminal_receipts,
                    Text.compare,
                    requestId,
                ) != null or
                Map.size(mem.plain_terminal_receipts) >=
                    Types.MAX_PLAIN_TERMINAL_RECEIPTS
            ) Runtime.trap("Files plaintext terminal receipt reservation");
            Map.add(
                mem.plain_terminal_receipts,
                Text.compare,
                requestId,
                {
                    fingerprint;
                    outcome = #write({ path; node });
                    expires_at_ns = terminalReceiptDeadline();
                },
            );
        };

        func terminalMutation(
            requestId : Text,
            fingerprint : Memory.Tag256,
            path : Text,
            revision : Nat64,
            changed : Nat32,
        ) : Types.MutationResponse {
            if (
                Map.get(
                    mem.plain_terminal_receipts,
                    Text.compare,
                    requestId,
                ) != null or
                Map.size(mem.plain_terminal_receipts) >=
                    Types.MAX_PLAIN_TERMINAL_RECEIPTS
            ) Runtime.trap("Files plaintext terminal receipt reservation");
            Map.add(
                mem.plain_terminal_receipts,
                Text.compare,
                requestId,
                {
                    fingerprint;
                    outcome = #mutation({ path; revision; changed });
                    expires_at_ns = terminalReceiptDeadline();
                },
            );
            mutationOk(path, revision, changed);
        };

        func terminalCapacityAvailable(releasingStage : Bool) : Bool {
            let used =
                Map.size(mem.plain_terminal_receipts) +
                Map.size(mem.plain_stages);
            if (releasingStage) {
                used <= Types.MAX_PLAIN_TERMINAL_RECEIPTS
            } else {
                used < Types.MAX_PLAIN_TERMINAL_RECEIPTS
            };
        };

        func terminalRequestCollidesWithStage(requestId : Text) : Bool {
            Map.get(
                mem.plain_stage_by_request,
                Text.compare,
                requestId,
            ) != null;
        };

        func activeTerminalRequest(requestId : Text) : Bool {
            let ?receipt = Map.get(
                mem.plain_terminal_receipts,
                Text.compare,
                requestId,
            ) else return false;
            if (receipt.expires_at_ns <= nowNs()) {
                ignore Map.delete(
                    mem.plain_terminal_receipts,
                    Text.compare,
                    requestId,
                );
                false;
            } else true;
        };

        func pruneExpiredReceipts(limit : Nat) : Nat {
            if (limit == 0) return 0;
            let timestamp = nowNs();
            let expired = List.empty<Text>();
            label scan for ((requestId, receipt) in Map.entries(
                mem.plain_terminal_receipts
            )) {
                if (receipt.expires_at_ns <= timestamp) {
                    List.add(expired, requestId);
                    if (List.size(expired) >= limit) break scan;
                };
            };
            for (requestId in List.values(expired)) {
                ignore Map.delete(
                    mem.plain_terminal_receipts,
                    Text.compare,
                    requestId,
                );
            };
            List.size(expired);
        };

        func terminalReceiptDeadline() : Nat64 {
            let timestamp = nowNs();
            if (
                timestamp >
                    Nat64.maxValue - Types.PLAIN_RECEIPT_RETENTION_NS
            ) Nat64.maxValue else
            timestamp + Types.PLAIN_RECEIPT_RETENTION_NS;
        };

        func rejected(reason : Types.RejectionReason) : Types.ListResponse {
            { outcome = ?#rejected(Types.reject(reason)) };
        };

        func rejectedStat(
            reason : Types.RejectionReason
        ) : Types.StatResponse {
            { outcome = ?#rejected(Types.reject(reason)) };
        };

        func rejectedRead(
            reason : Types.RejectionReason
        ) : Types.ReadChunkOutput {
            {
                value = { outcome = ?#rejected(Types.reject(reason)) };
                body = "";
            };
        };

        func rejectedWrite(
            reason : Types.RejectionReason
        ) : Types.WriteBlockResponse {
            { outcome = ?#rejected(Types.reject(reason)) };
        };

        func rejectedMutation(
            reason : Types.RejectionReason
        ) : Types.MutationResponse {
            { outcome = ?#rejected(Types.reject(reason)) };
        };

        func mutationOk(
            path : Text,
            revision : Nat64,
            changed : Nat32,
        ) : Types.MutationResponse {
            { outcome = ?#ok({ path; revision; changed }) };
        };
    };
};
