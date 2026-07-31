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
import Text "mo:core/Text";
import NeutronCapabilities "mo:neutron-capabilities";
import Memory "../memory/files/v1";
import Accounting "Accounting";
import Fingerprint "Fingerprint";
import Frames "Frames";
import Keys "Keys";
import Mutation "Mutation";
import ReceiptOwnership "ReceiptOwnership";
import Tree "Tree";
import Types "Types";

module {
    type UnitResult = Types.Result<()>;

    public type Service = ServiceWithCounter;

    public func Service(
        mem : Memory.Mem,
        certifiedAssets : NeutronCapabilities.CertifiedAssetsV2,
        nowNs : () -> Nat64,
    ) : Service {
        ServiceWithCounter(
            mem,
            certifiedAssets,
            nowNs,
            func() : Nat64 { 0 },
        );
    };

    public class ServiceWithCounter(
        mem : Memory.Mem,
        certifiedAssets : NeutronCapabilities.CertifiedAssetsV2,
        nowNs : () -> Nat64,
        performanceCounter : () -> Nat64,
    ) {
        let tree = Tree.Tree(mem);
        var cleanupInstructionStart : Nat64 = 0;

        public func bootstrap() : Types.Result<Types.Attachment<Types.BootstrapOk>> {
            let activeResult = activeOperations();
            let #ok(active) = activeResult else {
                let #err(error) = activeResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let vaultSnapshot : {
                #absent;
                #present : {
                    vault : Memory.VaultRecord;
                    body : Blob;
                };
            } = switch (mem.vault) {
                case null {
                    if (not validAbsentState()) {
                        return #err(Types.reject(#corrupt_state));
                    };
                    #absent;
                };
                case (?vault) {
                    let rootResult = tree.reachable(Types.ROOT_NODE_ID);
                    let #ok(root) = rootResult else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (
                        root.node.subtree_plaintext_bytes !=
                            mem.committed_private_plaintext_bytes
                    ) return #err(Types.reject(#corrupt_state));
                    let ?body = vaultReadBody(vault, root.node) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    #present({ vault; body });
                };
            };
            let quotaResult = quota();
            let #ok(quotaValue) = quotaResult else {
                let #err(error) = quotaResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let cleanupValue = cleanupSummary();
            // Certified-assets usage is the only external bootstrap call. It
            // occurs only after every bounded local invariant has passed.
            let usageResult = publicUsage();
            let #ok(usage) = usageResult else {
                let #err(error) = usageResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            switch (vaultSnapshot) {
                case (#absent) {
                    #ok({
                        value = {
                            vault = ?#absent;
                            quota = quotaValue;
                            public_usage = usage;
                            cleanup = cleanupValue;
                            active_operations = active;
                            body_bytes = 0;
                        };
                        body = "";
                    });
                };
                case (#present(snapshot)) {
                    let vault = snapshot.vault;
                    let body = snapshot.body;
                    #ok({
                        value = {
                            vault = ?#present({
                                format = vault.format;
                                record_revision = vault.record_revision;
                                slot_generation = vault.slot_generation;
                                public_key_fingerprint =
                                    vault.public_key_fingerprint;
                                wrapper_frame_bytes =
                                    Nat32.fromNat(body.size());
                            });
                            quota = quotaValue;
                            public_usage = usage;
                            cleanup = cleanupValue;
                            active_operations = active;
                            body_bytes = Nat32.fromNat(body.size());
                        };
                        body;
                    });
                };
            };
        };

        func vaultReadBody(
            vault : Memory.VaultRecord,
            root : Memory.Node,
        ) : ?Blob {
            let wrapperLength = vault.ibe_wrapped_root_key.size();
            let metadataLength = root.encrypted_metadata.size();
            if (
                wrapperLength == 0 or wrapperLength > 4_294_967_295 or
                metadataLength > 4_294_967_295 or
                wrapperLength + metadataLength > 4_294_967_295
            ) return null;
            let raw = Frames.append([
                vault.ibe_wrapped_root_key,
                root.encrypted_metadata,
            ]);
            let control : Frames.VaultReadFrameControl = {
                format = vault.format;
                vault_id = vault.vault_id;
                vault_salt = Frames.digestFromTag(vault.vault_salt);
                slot_generation = vault.slot_generation;
                public_key_fingerprint =
                    Frames.digestFromTag(vault.public_key_fingerprint);
                root_commitment =
                    Frames.digestFromTag(vault.root_commitment);
                record_revision = vault.record_revision;
                root_structural_revision = root.structural_revision;
                root_metadata_revision = root.metadata_revision;
                root_children_revision = root.children_revision;
                ibe_wrapped_root_key = {
                    offset = 0;
                    length = Nat32.fromNat(wrapperLength);
                };
                encrypted_root_metadata = {
                    offset = Nat32.fromNat(wrapperLength);
                    length = Nat32.fromNat(metadataLength);
                };
                raw_payload_bytes = Nat32.fromNat(raw.size());
            };
            Frames.encodeVaultRead(control, raw);
        };

        public func list(
            request : Types.ListRequest
        ) : Types.Result<Types.Attachment<Types.ListOk>> {
            let pageResult = tree.page(request);
            let #ok(page) = pageResult else {
                let #err(error) = pageResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let controls = List.empty<Frames.ListFrameItem>();
            let parts = List.empty<Blob>();
            var offset = 0;
            for (located in page.items.values()) {
                let metadata = located.node.encrypted_metadata;
                if (
                    metadata.size() < 16 or
                    metadata.size() > Types.MAX_METADATA_BYTES or
                    offset + metadata.size() > 4_294_967_295
                ) return #err(Types.reject(#corrupt_state));
                List.add(parts, metadata);
                List.add(controls, {
                    node = Tree.summary(located);
                    content = switch (Tree.content(located.node)) {
                        case null null;
                        case (?content) ?Tree.contentSummary(content);
                    };
                    encrypted_metadata = {
                        offset = Nat32.fromNat(offset);
                        length = Nat32.fromNat(metadata.size());
                    };
                });
                offset += metadata.size();
            };
            let raw = Frames.append(List.toArray(parts));
            let frameCursor = switch (page.next_cursor) {
                case null null;
                case (?cursor) ?{
                    parent_id = cursor.parent_id;
                    children_revision = cursor.children_revision;
                    last_name_tag =
                        Frames.digestFromTag(cursor.last_name_tag);
                };
            };
            let control : Frames.ListFrameControl = {
                parent_id = request.parent_id;
                structural_revision = page.parent.node.structural_revision;
                children_revision = page.parent.node.children_revision;
                items = List.toArray(controls);
                next_cursor = frameCursor;
                raw_payload_bytes = Nat32.fromNat(raw.size());
            };
            let ?body = Frames.encodeList(control, raw) else {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                page.items.size() > 65_535 or body.size() > 4_294_967_295
            ) return #err(Types.reject(#corrupt_state));
            #ok({
                value = {
                    parent_id = request.parent_id;
                    structural_revision =
                        page.parent.node.structural_revision;
                    children_revision = page.parent.node.children_revision;
                    total_children = switch (page.parent.node.kind) {
                        case (#folder(folder)) folder.direct_child_count;
                        case (_) return #err(Types.reject(#corrupt_state));
                    };
                    loaded_count = Nat16.fromNat(page.items.size());
                    next_cursor = page.next_cursor;
                    has_more = page.has_more;
                    body_bytes = Nat32.fromNat(body.size());
                };
                body;
            });
        };

        public func lookup(
            request : Types.LookupRequest,
            inputBody : Blob,
        ) : Types.Result<Types.Attachment<Types.LookupOk>> {
            let locatedResult : Types.Result<Tree.LocatedNode> =
                switch (request.locator) {
                    case null return #err(Types.reject(#incompatible));
                    case (?#node(value)) {
                        if (inputBody.size() != 0) {
                            return #err(Types.reject(#invalid_request));
                        };
                        tree.reachable(value.node_id);
                    };
                    case (?#child(value)) {
                        let ?tag = Keys.tag256FromBytes(inputBody) else {
                            return #err(Types.reject(#invalid_request));
                        };
                        tree.lookupChild(
                            value.parent_id,
                            value.expected_children_revision,
                            tag,
                        );
                    };
                };
            let #ok(located) = locatedResult else {
                let #err(error) = locatedResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let metadata = located.node.encrypted_metadata;
            let parts = List.empty<Blob>();
            List.add(parts, metadata);
            var offset = metadata.size();
            let contentFrame = switch (Tree.content(located.node)) {
                case null null;
                case (?content) {
                    if (
                        content.wrapped_content_key.size() == 0 or
                        offset + content.wrapped_content_key.size() >
                            4_294_967_295
                    ) return #err(Types.reject(#corrupt_state));
                    List.add(parts, content.wrapped_content_key);
                    let result = ?{
                        summary = Tree.contentSummary(content);
                        wrapped_content_key = {
                            offset = Nat32.fromNat(offset);
                            length = Nat32.fromNat(
                                content.wrapped_content_key.size()
                            );
                        };
                    };
                    offset += content.wrapped_content_key.size();
                    result;
                };
            };
            if (
                metadata.size() < 16 or
                metadata.size() > Types.MAX_METADATA_BYTES
            ) return #err(Types.reject(#corrupt_state));
            let raw = Frames.append(List.toArray(parts));
            let control : Frames.LookupFrameControl = {
                node = Tree.summary(located);
                content = contentFrame;
                encrypted_metadata = {
                    offset = 0;
                    length = Nat32.fromNat(metadata.size());
                };
                raw_payload_bytes = Nat32.fromNat(raw.size());
            };
            let ?body = Frames.encodeLookup(control, raw) else {
                return #err(Types.reject(#corrupt_state));
            };
            #ok({
                value = {
                    node = Tree.binding(located);
                    content = switch (Tree.content(located.node)) {
                        case null null;
                        case (?content) ?Tree.contentDescriptor(content);
                    };
                    body_bytes = Nat32.fromNat(body.size());
                };
                body;
            });
        };

        public func readChunk(
            request : Types.ReadChunkRequest
        ) : Types.Result<Types.Attachment<Types.ReadChunkOk>> {
            let locatedResult = tree.reachable(request.node_id);
            let #ok(located) = locatedResult else {
                let #err(error) = locatedResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            if (
                located.node.structural_revision !=
                    request.structural_revision
            ) return #err(Types.reject(#stale_revision));
            let ?content = Tree.content(located.node) else {
                switch (located.node.kind) {
                    case (#folder(_)) return #err(Types.reject(#not_file));
                    case (_) return #err(Types.reject(#stale_content));
                };
            };
            if (content.content_id != request.content_id) {
                return #err(Types.reject(#stale_content));
            };
            if (request.index >= content.block_count) {
                return #err(Types.reject(#invalid_index));
            };
            let ?block = Map.get(
                mem.blocks,
                Keys.compareBlockKey,
                Keys.blockKey(content.content_id, request.index),
            ) else return #err(Types.reject(#corrupt_state));
            if (
                block.size() == 0 or block.size() > 4_294_967_295 or
                content.ciphertext_bytes > 18_446_744_073_709_551_615
            ) return #err(Types.reject(#corrupt_state));
            let (control, raw, frameKind) : (
                Frames.ReadBlockFrameControl,
                Blob,
                { #first; #continuation },
            ) = if (request.index == 0) {
                let metadata = located.node.encrypted_metadata;
                let wrapper = content.wrapped_content_key;
                let firstRaw = Frames.append([metadata, wrapper, block]);
                let firstControl : Frames.ReadBlockFrameControl = {
                    frame = ?#first({
                        node = Tree.summary(located);
                        content = Tree.contentSummary(content);
                        encrypted_metadata = {
                            offset = 0;
                            length = Nat32.fromNat(metadata.size());
                        };
                        wrapped_content_key = {
                            offset = Nat32.fromNat(metadata.size());
                            length = Nat32.fromNat(wrapper.size());
                        };
                        index = 0;
                        ciphertext_block = {
                            offset = Nat32.fromNat(
                                metadata.size() + wrapper.size()
                            );
                            length = Nat32.fromNat(block.size());
                        };
                        raw_payload_bytes = Nat32.fromNat(firstRaw.size());
                    });
                };
                (firstControl, firstRaw, #first);
            } else {
                let continuationControl : Frames.ReadBlockFrameControl = {
                    frame = ?#continuation({
                        node_id = request.node_id;
                        structural_revision =
                            located.node.structural_revision;
                        metadata_revision =
                            located.node.metadata_revision;
                        content_id = content.content_id;
                        index = request.index;
                        block_count = content.block_count;
                        ciphertext_block_bytes =
                            Nat32.fromNat(block.size());
                        ciphertext_total_bytes =
                            Nat64.fromNat(content.ciphertext_bytes);
                        ciphertext_block = {
                            offset = 0;
                            length = Nat32.fromNat(block.size());
                        };
                        raw_payload_bytes = Nat32.fromNat(block.size());
                    });
                };
                (continuationControl, block, #continuation);
            };
            let ?body = Frames.encodeRead(control, raw) else {
                return #err(Types.reject(#corrupt_state));
            };
            #ok({
                value = {
                    node_id = request.node_id;
                    structural_revision =
                        located.node.structural_revision;
                    metadata_revision = located.node.metadata_revision;
                    content_id = content.content_id;
                    index = request.index;
                    block_count = content.block_count;
                    ciphertext_block_bytes = Nat32.fromNat(block.size());
                    ciphertext_total_bytes =
                        Nat64.fromNat(content.ciphertext_bytes);
                    frame_kind = ?frameKind;
                };
                body;
            });
        };

        public func vaultWrite(
            request : Types.VaultWriteRequest,
            body : Blob,
        ) : Types.Result<Types.VaultWriteOk> {
            if (
                body.size() != Nat32.toNat(request.body_bytes) or
                body.size() > Types.MAX_VAULT_FRAME_BYTES
            ) return #err(Types.reject(#invalid_request));
            let ?decoded = Frames.decodeVaultWrite(body) else {
                return #err(Types.reject(#incompatible));
            };
            let control = decoded.control;
            if (
                control.request_id != request.request_id or
                control.expected_record_revision !=
                    request.expected_record_revision or
                control.proposed_record_revision !=
                    request.proposed_record_revision or
                operationMatches(request.operation, control.operation) == false
            ) return #err(Types.reject(#invalid_request));
            let fingerprint = Fingerprint.vaultWrite(
                request,
                decoded.digest,
            );
            switch (privateReceipt(request.request_id, fingerprint)) {
                case (#err(error)) return #err(error);
                case (#ok(?receipt)) switch (receipt.outcome) {
                    case (#vault(value)) return #ok({
                        request_id = request.request_id;
                        record_revision = value.record_revision;
                        initialized = value.initialized;
                    });
                    case (_) return #err(Types.reject(#conflict));
                };
                case (#ok(null)) {};
            };
            switch (
                freshPrivateMutationRequestId(request.request_id)
            ) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            let at = nowNs();
            switch (control.operation) {
                case null #err(Types.reject(#incompatible));
                case (?#initialize(value)) {
                    if (
                        request.operation != ?#initialize or
                        request.expected_record_revision != null or
                        request.proposed_record_revision != 1 or
                        control.proposed_record_revision != 1 or
                        value.root_structural_revision != 1 or
                        value.root_metadata_revision != 1 or
                        value.root_children_revision != 0 or
                        mem.vault != null
                    ) return #err(Types.reject(#stale_revision));
                    if (not validAbsentState()) {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?wrapper = Frames.payloadSlice(
                        decoded.raw_payload,
                        value.ibe_wrapped_root_key,
                    ) else return #err(Types.reject(#invalid_request));
                    let ?metadata = Frames.payloadSlice(
                        decoded.raw_payload,
                        value.encrypted_root_metadata,
                    ) else return #err(Types.reject(#invalid_request));
                    let vault : Memory.VaultRecord = {
                        format = value.format;
                        vault_id = value.vault_id;
                        vault_salt = Frames.digestToTag(value.vault_salt);
                        slot_generation = value.slot_generation;
                        public_key_fingerprint = Frames.digestToTag(
                            value.public_key_fingerprint
                        );
                        ibe_wrapped_root_key = wrapper;
                        root_commitment =
                            Frames.digestToTag(value.root_commitment);
                        record_revision = 1;
                    };
                    let root : Memory.Node = {
                        parent_id = Types.ROOT_NODE_ID;
                        kind = #folder({
                            direct_child_count = 0;
                            child_subtree_heights = [];
                            child_relative_path_scalars = [];
                        });
                        state = #active;
                        name_tag = Types.ZERO_TAG;
                        declared_name_scalars = 0;
                        structural_revision = 1;
                        metadata_revision = 1;
                        children_revision = 0;
                        subtree_height = 0;
                        max_relative_path_scalars = 0;
                        subtree_plaintext_bytes = 0;
                        encrypted_metadata = metadata;
                    };
                    if (vaultReadBody(vault, root) == null) {
                        return #err(Types.reject(#quota));
                    };
                    let receipt = vaultReceipt(
                        request.request_id,
                        fingerprint,
                        request.expected_record_revision,
                        1,
                        true,
                        at,
                    );
                    let structuralCharge =
                        Accounting.vaultCharge(vault) +
                        Accounting.nodeCharge(root);
                    let receiptCharge =
                        privateReceiptInsertionCharge(receipt);
                    let charge = structuralCharge + receiptCharge;
                    switch (
                        preparePrivateMutationAdmission(
                            ?request.request_id
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok(_)) {};
                    };
                    switch (physicalTransitionAdmission(0, charge, 0)) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                    switch (ensureReceiptLane()) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                    mem.vault := ?vault;
                    Map.add(
                        mem.nodes_by_id,
                        Keys.compareId128,
                        Types.ROOT_NODE_ID,
                        root,
                    );
                    mem.node_count := 1;
                    mem.committed_ciphertext_bytes :=
                        root.encrypted_metadata.size();
                    Accounting.addPhysical(mem, structuralCharge);
                    insertPrivateReceipt(
                        request.request_id,
                        receipt,
                    );
                    #ok({
                        request_id = request.request_id;
                        record_revision = 1;
                        initialized = true;
                    });
                };
                case (?#rewrap(value)) {
                    if (request.operation != ?#rewrap) {
                        return #err(Types.reject(#invalid_request));
                    };
                    let ?old = mem.vault else {
                        return #err(Types.reject(#stale_revision));
                    };
                    if (
                        value.format != old.format or
                        value.vault_id != old.vault_id or
                        Frames.digestToTag(value.vault_salt) !=
                            old.vault_salt or
                        Frames.digestToTag(value.root_commitment) !=
                            old.root_commitment
                    ) return #err(Types.reject(#conflict));
                    let ?wrapper = Frames.payloadSlice(
                        decoded.raw_payload,
                        value.ibe_wrapped_root_key,
                    ) else return #err(Types.reject(#invalid_request));
                    if (
                        request.expected_record_revision !=
                            ?old.record_revision or
                        old.record_revision == Nat64.maxValue or
                        request.proposed_record_revision !=
                            old.record_revision + 1
                    ) {
                        if (
                            old.record_revision ==
                                request.proposed_record_revision and
                            old.slot_generation == value.slot_generation and
                            old.public_key_fingerprint ==
                                Frames.digestToTag(
                                    value.public_key_fingerprint
                                ) and
                            old.ibe_wrapped_root_key == wrapper
                        ) return #ok({
                            request_id = request.request_id;
                            record_revision = old.record_revision;
                            initialized = false;
                        });
                        return #err(Types.reject(#stale_revision));
                    };
                    let replacement : Memory.VaultRecord = {
                        old with
                        slot_generation = value.slot_generation;
                        public_key_fingerprint = Frames.digestToTag(
                            value.public_key_fingerprint
                        );
                        ibe_wrapped_root_key = wrapper;
                        record_revision =
                            request.proposed_record_revision;
                    };
                    let rootResult = tree.reachable(
                        Types.ROOT_NODE_ID
                    );
                    let #ok(root) = rootResult else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    if (
                        vaultReadBody(replacement, root.node) == null
                    ) return #err(Types.reject(#quota));
                    let receipt = vaultReceipt(
                        request.request_id,
                        fingerprint,
                        request.expected_record_revision,
                        replacement.record_revision,
                        false,
                        at,
                    );
                    let oldCharge = Accounting.vaultCharge(old);
                    let newCharge = Accounting.vaultCharge(replacement);
                    let receiptCharge =
                        privateReceiptInsertionCharge(receipt);
                    switch (
                        preparePrivateMutationAdmission(
                            ?request.request_id
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok(_)) {};
                    };
                    switch (
                        physicalTransitionAdmission(
                            oldCharge,
                            newCharge,
                            receiptCharge,
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                    switch (ensureReceiptLane()) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                    if (newCharge >= oldCharge) {
                        Accounting.addPhysical(mem, newCharge - oldCharge);
                    } else {
                        Accounting.removePhysical(mem, oldCharge - newCharge);
                    };
                    mem.vault := ?replacement;
                    insertPrivateReceipt(
                        request.request_id,
                        receipt,
                    );
                    #ok({
                        request_id = request.request_id;
                        record_revision = replacement.record_revision;
                        initialized = false;
                    });
                };
            };
        };

        public func mutate(
            request : Types.MutateRequest,
            body : Blob,
        ) : Types.Result<Types.MutateOk> {
            if (
                body.size() != Nat32.toNat(request.body_bytes) or
                body.size() > Types.MAX_MUTATION_FRAME_BYTES
            ) return #err(Types.reject(#invalid_request));
            let ?decoded = Frames.decodeMutate(body) else {
                return #err(Types.reject(#incompatible));
            };
            if (
                decoded.control.request_id != request.request_id or
                mutationActionMatches(
                    request.action,
                    decoded.control.action,
                ) == false
            ) return #err(Types.reject(#invalid_request));
            let fingerprint = Fingerprint.mutate(request, decoded.digest);
            switch (privateReceipt(request.request_id, fingerprint)) {
                case (#err(error)) return #err(error);
                case (#ok(?receipt)) switch (receipt.outcome) {
                    case (#mutation(value)) {
                        return #ok({
                            request_id = value.request_id;
                            node_id = value.node_id;
                            parent_id = value.parent_id;
                            structural_revision =
                                value.structural_revision;
                            metadata_revision = value.metadata_revision;
                        });
                    };
                    case (_) return #err(Types.reject(#conflict));
                };
                case (#ok(null)) {};
            };
            switch (
                freshPrivateMutationRequestId(request.request_id)
            ) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            // Cleanup may physically retire a previously detached subtree and
            // update the global node/ciphertext/physical counters. Plan only
            // after that work so Mutation.apply cannot restore a stale
            // absolute counter snapshot.
            switch (
                preparePrivateMutationAdmission(?request.request_id)
            ) {
                case (#err(error)) return #err(error);
                case (#ok(_)) {};
            };
            switch (decoded.control.action) {
                case (?#create_folder) if (
                    nodeIdReservedByStage(
                        decoded.control.node.node_id
                    ) or
                    nodeIdRetainedByReceipt(
                        decoded.control.node.node_id
                    )
                ) return #err(Types.reject(#id_collision));
                case (_) {};
            };
            let planResult = Mutation.plan(
                mem,
                decoded.control,
                decoded.raw_payload,
            );
            let #ok(plan) = planResult else {
                let #err(error) = planResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            var proposedCiphertext = mem.committed_ciphertext_bytes;
            for (mutation in plan.node_mutations.values()) {
                switch (mutation.expected) {
                    case null {};
                    case (?node) {
                        if (
                            proposedCiphertext <
                                node.encrypted_metadata.size()
                        ) return #err(Types.reject(#corrupt_state));
                        proposedCiphertext -=
                            node.encrypted_metadata.size();
                    };
                };
                switch (mutation.replacement) {
                    case null {};
                    case (?node) {
                        proposedCiphertext +=
                            node.encrypted_metadata.size();
                    };
                };
            };
            if (
                proposedCiphertext >
                    Types.MAX_COMMITTED_CIPHERTEXT_BYTES
            ) return #err(Types.reject(#quota));
            let receipt = mutationReceipt(
                request.request_id,
                fingerprint,
                decoded.control.node.node_id,
                plan.result_node,
                nowNs(),
            );
            let receiptCharge =
                privateReceiptMaximumCharge(receipt);
            switch (
                physicalTransitionAdmission(
                    plan.physical_before,
                    plan.physical_after,
                    receiptCharge,
                )
            ) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            switch (ensureReceiptLane()) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            Mutation.apply(mem, plan);
            mem.committed_ciphertext_bytes := proposedCiphertext;
            insertPrivateReceipt(request.request_id, receipt);
            #ok({
                request_id = request.request_id;
                node_id = decoded.control.node.node_id;
                parent_id = plan.result_node.parent_id;
                structural_revision =
                    plan.result_node.structural_revision;
                metadata_revision = plan.result_node.metadata_revision;
            });
        };

        // The remaining mutating paths are implemented below the common
        // navigation/vault helpers to keep the public class surface together.
        public func writeBlock(
            request : Types.WriteBlockRequest,
            body : Blob,
        ) : Types.Result<Types.WriteBlockOk> {
            writeBlockImpl(request, body);
        };

        public func remove(
            request : Types.RemoveRequest
        ) : Types.Result<Types.RemoveOk> {
            removeImpl(request);
        };

        public func abort(
            request : Types.AbortRequest
        ) : Types.Result<Types.AbortOk> {
            abortImpl(request);
        };

        public func cleanup() : Types.Result<Types.CleanupOk> {
            cleanupImpl();
        };

        public func operationStatus(
            request : Types.OperationStatusRequest
        ) : Types.Result<Types.OperationStatusOk> {
            operationStatusImpl(request);
        };

        // In-process Motoko tests use this to assert exact ancestry-read
        // behavior. backend/main.mo deliberately exports no actor method for
        // it, and production leaves the observer null.
        public func observeTreeReads(observer : ?Tree.ReadObserver) {
            tree.observeReads(observer);
        };

        // Implemented in the second half of this module.
        func writeBlockImpl(
            request : Types.WriteBlockRequest,
            body : Blob,
        ) : Types.Result<Types.WriteBlockOk> {
            if (
                body.size() != Nat32.toNat(request.body_bytes) or
                body.size() > Types.MAX_FRAME_BYTES
            ) return #err(Types.reject(#invalid_request));
            let ?decoded = Frames.decodeWriteBlock(body) else {
                return #err(Types.reject(#incompatible));
            };
            let ?frame = decoded.control.frame else {
                return #err(Types.reject(#incompatible));
            };
            switch (frame) {
                case (#first(first)) {
                    if (
                        request.stage_id != null or
                        request.frame_ordinal != 0 or
                        first.request_id != request.request_id or
                        first.frame_ordinal != 0 or
                        first.final != request.final or
                        request.final != (first.frame_count == 1)
                    ) return #err(Types.reject(#invalid_request));
                    let fingerprint = Fingerprint.writeFirst(
                        request,
                        decoded.digest,
                    );
                    switch (
                        privateReceipt(request.request_id, fingerprint)
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok(?receipt)) switch (receipt.outcome) {
                            case (#write(value)) {
                                return #ok(writeReceiptOk(value));
                            };
                            case (#expired(_)) return #err(
                                Types.reject(#expired)
                            );
                            case (_) return #err(
                                Types.reject(#conflict)
                            );
                        };
                        case (#ok(null)) {};
                    };
                    switch (
                        Map.get(
                            mem.stages_by_request,
                            Keys.compareId128,
                            request.request_id,
                        )
                    ) {
                        case (?stageId) {
                            let ?#private_write(stage) = Map.get(
                                mem.stages,
                                Nat64.compare,
                                stageId,
                            ) else return #err(
                                Types.reject(#conflict)
                            );
                            if (
                                stage.request_fingerprint != fingerprint or
                                stage.frame_fingerprints[0] !=
                                    ?decoded.digest
                            ) return #err(Types.reject(#conflict));
                            if (stage.expires_at_ns <= nowNs()) {
                                return expirePrivateStage(
                                    stageId,
                                    stage,
                                );
                            };
                            return #ok(stageWriteOk(
                                stageId,
                                stage,
                                0,
                            ));
                        };
                        case null {};
                    };
                    switch (
                        freshPrivateMutationRequestId(
                            request.request_id
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                    let planResult = planPrivateWrite(
                        first,
                        decoded.raw_payload,
                    );
                    let #ok(baseCommitPlan) = planResult else {
                        let #err(error) = planResult else {
                            return #err(Types.reject(#corrupt_state));
                        };
                        return #err(error);
                    };
                    switch (
                        preparePrivateMutationAdmission(
                            ?request.request_id
                        )
                    ) {
                        case (#err(error)) return #err(error);
                        case (#ok(_)) {};
                    };
                    if (
                        privateStageCount() >= Types.MAX_PRIVATE_STAGES or
                        mem.next_stage_id == Nat64.maxValue
                    ) return #err(Types.reject(#busy));
                    switch (ensurePrivateStageReceiptLane()) {
                        case (#err(error)) return #err(error);
                        case (#ok) {};
                    };
                    let totalCipher = plannedCiphertext(first.frames);
                    let stageId = mem.next_stage_id;
                    let at = nowNs();
                    let commitPlan : Memory.PrivateCommitPlan = {
                        baseCommitPlan with
                        // Accounting derives authority from the full plan;
                        // this persisted field is a non-authoritative witness.
                        final_physical_bytes = 0;
                    };
                    let framePlans = Array.map<
                        Frames.WriteFramePlan,
                        Memory.FramePlan
                    >(
                        first.frames,
                        func(plan) {
                            {
                                ordinal = plan.frame_ordinal;
                                encoded_bytes =
                                    if (plan.frame_ordinal == 0) {
                                        request.body_bytes
                                    } else {
                                        // Exact encoded continuation bytes are
                                        // pinned by the correlated raw/control
                                        // bounds and verified on receipt.
                                        plan.raw_payload_bytes;
                                    };
                                blocks = Array.map<
                                    Frames.WriteBlockSlice,
                                    Memory.StageBlock
                                >(
                                    plan.blocks,
                                    func(block) {
                                        {
                                            content_id = block.content_id;
                                            block_index = block.block_index;
                                            ciphertext_bytes =
                                                block.ciphertext_bytes;
                                            frame_ordinal =
                                                plan.frame_ordinal;
                                            payload_offset =
                                                block.payload.offset;
                                            payload_length =
                                                block.payload.length;
                                        };
                                    },
                                );
                            };
                        },
                    );
                    let acceptedBytes = frameCiphertext(first.frames[0]);
                    let fingerprints = Array.tabulate<
                        ?Types.Digest256
                    >(
                        Nat8.toNat(first.frame_count),
                        func(index) {
                            if (index == 0) ?decoded.digest else null;
                        },
                    );
                    let stageDraft : Memory.PrivateStage = {
                        request_id = request.request_id;
                        request_fingerprint = fingerprint;
                        created_at_ns = at;
                        last_activity_at_ns = at;
                        expires_at_ns = deadline(
                            at,
                            Types.PRIVATE_STAGE_IDLE_NS,
                        );
                        frame_count = first.frame_count;
                        accepted_frame_bitmap =
                            bitmapSet(
                                emptyBitmap(first.frame_count),
                                0,
                            );
                        frame_fingerprints = fingerprints;
                        frames = framePlans;
                        commit_plan = commitPlan;
                        accepted_ciphertext_bytes = acceptedBytes;
                        reserved_ciphertext_bytes =
                            totalCipher - acceptedBytes;
                        reserved_physical_bytes =
                            commitPlan.final_physical_bytes;
                        reserved_cleanup_jobs = 0;
                    };
                    let reservation =
                        Accounting.privateCommitReservation(stageDraft);
                    let cleanupJobs = reservation.cleanup_jobs;
                    let stageCharge =
                        reservation.current_stage_charge;
                    let firstBlockCharge =
                        frameBlockCharge(first.frames[0]);
                    let reservationPhysical =
                        reservation.peak_reservation_charge;
                    let declaredGross = Nat64.toNat(
                        first.quota.gross_peak_physical_bytes
                    );
                    let derivedGross =
                        mem.physical_private_bytes +
                        mem.reserved_physical_private_bytes +
                        reservationPhysical;
                    if (
                        declaredGross < derivedGross or
                        declaredGross >
                            Types.MAX_PHYSICAL_PRIVATE_BYTES
                    ) return #err(Types.reject(#quota));
                    let stageBase : Memory.PrivateStage = {
                        stageDraft with
                        reserved_physical_bytes =
                            reservationPhysical -
                            stageCharge -
                            firstBlockCharge;
                        reserved_cleanup_jobs =
                            Nat8.fromNat(cleanupJobs);
                    };
                    if (
                        not Accounting.canReserve(
                            mem,
                            totalCipher,
                            reservationPhysical,
                            cleanupJobs,
                        )
                    ) return #err(Types.reject(#quota));
                    if (first.frame_count == 1) {
                        switch (privateCommitPreflight(stageBase)) {
                            case (#err(error)) return #err(error);
                            case (#ok) {};
                        };
                    };
                    Accounting.reserve(
                        mem,
                        totalCipher,
                        reservationPhysical,
                        cleanupJobs,
                    );
                    storeFrameBlocks(
                        first.frames[0],
                        decoded.raw_payload,
                    );
                    mem.staged_ciphertext_bytes += acceptedBytes;
                    Accounting.releaseReservation(
                        mem,
                        acceptedBytes,
                        stageCharge + firstBlockCharge,
                        0,
                    );
                    Accounting.addPhysical(
                        mem,
                        stageCharge + firstBlockCharge,
                    );
                    mem.next_stage_id += 1;
                    Map.add(
                        mem.stages,
                        Nat64.compare,
                        stageId,
                        #private_write(stageBase),
                    );
                    Map.add(
                        mem.stages_by_request,
                        Keys.compareId128,
                        request.request_id,
                        stageId,
                    );
                    if (first.frame_count == 1) {
                        commitPrivateStage(
                            stageId,
                            stageBase,
                            request.frame_ordinal,
                        );
                    } else {
                        #ok(stageWriteOk(stageId, stageBase, 0));
                    };
                };
                case (#continuation(continuation)) {
                    let ?stageId = request.stage_id else {
                        return #err(Types.reject(#invalid_request));
                    };
                    if (
                        continuation.request_id != request.request_id or
                        continuation.stage_id != stageId or
                        continuation.frame_ordinal !=
                            request.frame_ordinal or
                        continuation.final != request.final
                    ) return #err(Types.reject(#invalid_request));
                    switch (
                        Map.get(
                            mem.private_receipts,
                            Keys.compareId128,
                            request.request_id,
                        )
                    ) {
                        case (?receipt) {
                            if (
                                receipt.expires_at_ns > nowNs()
                            ) switch (receipt.outcome) {
                                case (#write(value)) {
                                    let ordinal =
                                        Nat8.toNat(request.frame_ordinal);
                                    if (
                                        ordinal >=
                                            value.frame_fingerprints.size() or
                                        value.frame_fingerprints[ordinal] !=
                                            decoded.digest
                                    ) return #err(
                                        Types.reject(#conflict)
                                    );
                                    return #ok(writeReceiptOk(value));
                                };
                                case (#expired(value)) {
                                    let ordinal = Nat8.toNat(
                                        request.frame_ordinal
                                    );
                                    if (
                                        value.frame_plan_fingerprints.size() !=
                                            value.frame_fingerprints.size()
                                    ) {
                                        return #err(
                                            Types.reject(#corrupt_state)
                                        );
                                    };
                                    if (
                                        value.stage_id != stageId or
                                        ordinal >=
                                            value.frame_fingerprints.size() or
                                        request.final !=
                                            (ordinal + 1 ==
                                                value.frame_fingerprints.size()) or
                                        value.frame_plan_fingerprints[ordinal] !=
                                            Fingerprint.continuationWriteFramePlan(
                                                continuation
                                            )
                                    ) {
                                        return #err(
                                            Types.reject(#conflict)
                                        );
                                    };
                                    switch (
                                        value.frame_fingerprints[ordinal]
                                    ) {
                                        case (?prior) if (
                                            prior != decoded.digest
                                        ) return #err(
                                            Types.reject(#conflict)
                                        );
                                        case (_) {};
                                    };
                                    return #err(Types.reject(#expired));
                                };
                                case (_) return #err(
                                    Types.reject(#conflict)
                                );
                            };
                        };
                        case null {};
                    };
                    let ?stored = Map.get(
                        mem.stages,
                        Nat64.compare,
                        stageId,
                    ) else return #err(Types.reject(#not_found));
                    let stage = switch (stored) {
                        case (#private_write(value)) value;
                        case (_) return #err(Types.reject(#conflict));
                    };
                    if (
                        stage.request_id != request.request_id or
                        Nat8.toNat(request.frame_ordinal) >=
                            Nat8.toNat(stage.frame_count) or
                        request.frame_ordinal == 0 or
                        request.final !=
                            (request.frame_ordinal + 1 ==
                                stage.frame_count)
                    ) return #err(Types.reject(#conflict));
                    let pinned =
                        stage.frames[Nat8.toNat(request.frame_ordinal)];
                    if (
                        not continuationMatches(
                            continuation,
                            pinned,
                        )
                    ) return #err(Types.reject(#conflict));
                    switch (
                        stage.frame_fingerprints[
                            Nat8.toNat(request.frame_ordinal)
                        ]
                    ) {
                        case (?prior) if (
                            prior != decoded.digest
                        ) return #err(Types.reject(#conflict));
                        case (_) {};
                    };
                    if (stage.expires_at_ns <= nowNs()) {
                        return expirePrivateStage(stageId, stage);
                    };
                    let fingerprint = Fingerprint.writeFrame(
                        request,
                        decoded.digest,
                    );
                    switch (
                        stage.frame_fingerprints[
                            Nat8.toNat(request.frame_ordinal)
                        ]
                    ) {
                        case (?prior) {
                            if (
                                prior != decoded.digest or
                                fingerprint ==
                                    stage.request_fingerprint
                            ) {
                                // The semantic first-frame and continuation
                                // domains are intentionally distinct.
                                if (prior != decoded.digest) {
                                    return #err(
                                        Types.reject(#conflict)
                                    );
                                };
                            };
                            return #ok(stageWriteOk(
                                stageId,
                                stage,
                                request.frame_ordinal,
                            ));
                        };
                        case null {};
                    };
                    let acceptedBytes =
                        framePlanCiphertext(pinned);
                    let blockCharge = framePlanBlockCharge(pinned);
                    if (
                        request.final and not priorFramesAccepted(
                            stage.accepted_frame_bitmap,
                            request.frame_ordinal,
                        )
                    ) return #err(Types.reject(#conflict));
                    if (request.final) {
                        switch (privateCommitPreflight(stage)) {
                            case (#err(error)) return #err(error);
                            case (#ok) {};
                        };
                    };
                    if (
                        stage.reserved_ciphertext_bytes < acceptedBytes or
                        mem.reserved_staged_ciphertext_bytes <
                            acceptedBytes or
                        mem.reserved_physical_private_bytes < blockCharge
                    ) Runtime.trap("private stage reservation invariant");
                    if (stage.reserved_physical_bytes < blockCharge) {
                        Runtime.trap(
                            "private stage local reservation invariant"
                        );
                    };
                    storeContinuationBlocks(
                        pinned,
                        decoded.raw_payload,
                    );
                    let fingerprints = Array.tabulate<
                        ?Types.Digest256
                    >(
                        stage.frame_fingerprints.size(),
                        func(index) {
                            if (
                                index ==
                                Nat8.toNat(request.frame_ordinal)
                            ) ?decoded.digest else {
                                stage.frame_fingerprints[index];
                            };
                        },
                    );
                    let acceptedAt = nowNs();
                    let updatedDraft : Memory.PrivateStage = {
                        stage with
                        last_activity_at_ns = acceptedAt;
                        expires_at_ns = deadline(
                            acceptedAt,
                            Types.PRIVATE_STAGE_IDLE_NS,
                        );
                        accepted_frame_bitmap = bitmapSet(
                            stage.accepted_frame_bitmap,
                            request.frame_ordinal,
                        );
                        frame_fingerprints = fingerprints;
                        accepted_ciphertext_bytes =
                            stage.accepted_ciphertext_bytes +
                            acceptedBytes;
                        reserved_ciphertext_bytes =
                            stage.reserved_ciphertext_bytes -
                            acceptedBytes;
                        reserved_physical_bytes =
                            stage.reserved_physical_bytes;
                    };
                    let oldCharge = Accounting.privateStageCharge(stage);
                    let newCharge =
                        Accounting.privateStageCharge(updatedDraft);
                    let metadataGrowth = if (newCharge > oldCharge) {
                        newCharge - oldCharge;
                    } else 0;
                    let consumedPhysical =
                        blockCharge + metadataGrowth;
                    if (
                        stage.reserved_physical_bytes <
                            consumedPhysical
                    ) Runtime.trap(
                        "private stage local metadata reservation"
                    );
                    let updated : Memory.PrivateStage = {
                        updatedDraft with
                        reserved_physical_bytes =
                            stage.reserved_physical_bytes -
                            consumedPhysical;
                    };
                    if (newCharge > oldCharge) {
                        if (
                            mem.reserved_physical_private_bytes <
                                consumedPhysical
                        ) Runtime.trap(
                            "private stage metadata reservation invariant"
                        );
                    };
                    Accounting.releaseReservation(
                        mem,
                        acceptedBytes,
                        blockCharge +
                            (if (newCharge > oldCharge) {
                                newCharge - oldCharge;
                            } else 0),
                        0,
                    );
                    mem.staged_ciphertext_bytes += acceptedBytes;
                    Accounting.addPhysical(mem, blockCharge);
                    if (newCharge >= oldCharge) {
                        Accounting.addPhysical(
                            mem,
                            newCharge - oldCharge,
                        );
                    } else {
                        Accounting.removePhysical(
                            mem,
                            oldCharge - newCharge,
                        );
                    };
                    Map.add(
                        mem.stages,
                        Nat64.compare,
                        stageId,
                        #private_write(updated),
                    );
                    if (request.final) {
                        commitPrivateStage(
                            stageId,
                            updated,
                            request.frame_ordinal,
                        );
                    } else {
                        #ok(stageWriteOk(
                            stageId,
                            updated,
                            request.frame_ordinal,
                        ));
                    };
                };
            };
        };

        func planPrivateWrite(
            first : Frames.WriteFirstFrame,
            raw : Frames.RawPayload,
        ) : Types.Result<Memory.PrivateCommitPlan> {
            if (
                first.request_id == Types.ROOT_NODE_ID or
                first.quota.expected_node_count !=
                    Nat64.fromNat(mem.node_count) or
                first.quota.expected_committed_plaintext_bytes !=
                    Nat64.fromNat(
                        mem.committed_private_plaintext_bytes
                    ) or
                first.quota.expected_committed_ciphertext_bytes !=
                    Nat64.fromNat(mem.committed_ciphertext_bytes)
            ) return #err(Types.reject(#stale_revision));
            let explicit = List.empty<Mutation.ExplicitWriteNode>();
            let retired = List.empty<Memory.ContentRetirement>();
            var newNodes = 0;
            var proposedPlain = mem.committed_private_plaintext_bytes;
            var proposedCipher = mem.committed_ciphertext_bytes;
            var plannedIndex = 0;
            var createdFileTargets = 0;
            var replacedFileTargets = 0;
            for (nodePlan in first.nodes.values()) {
                let transition = nodePlan.node;
                if (
                    transition.node_id == Types.ROOT_NODE_ID or
                    transition.proposed_parent_id ==
                        transition.node_id or
                    transition.proposed_name_tag ==
                        Frames.digestFromTag(Types.ZERO_TAG) or
                    transition.declared_name_scalars == 0 or
                    transition.declared_name_scalars >
                        Types.MAX_NAME_SCALARS
                ) return #err(Types.reject(#invalid_request));
                let ?metadata = Frames.payloadSlice(
                    raw,
                    transition.encrypted_metadata,
                ) else return #err(Types.reject(#invalid_request));
                let existing = Map.get(
                    mem.nodes_by_id,
                    Keys.compareId128,
                    transition.node_id,
                );
                let old : ?Memory.Node = switch (existing) {
                    case null {
                        if (
                            transition.expected_parent_id != null or
                            transition.expected_name_tag != null or
                            transition.expected_structural_revision !=
                                null or
                            transition.expected_metadata_revision !=
                                null or
                            transition.expected_children_revision !=
                                null or
                            transition.expected_subtree_height != null or
                            transition.expected_max_relative_path_scalars !=
                                null or
                            transition.expected_subtree_plaintext_bytes !=
                                null
                        ) return #err(Types.reject(#stale_revision));
                        if (
                            nodeIdReservedByStage(
                                transition.node_id
                            ) or
                            nodeIdRetainedByReceipt(
                                transition.node_id
                            )
                        ) return #err(
                            Types.reject(#id_collision)
                        );
                        newNodes += 1;
                        null;
                    };
                    case (?value) {
                        let reachable = tree.reachable(transition.node_id);
                        let #ok(_) = reachable else {
                            return #err(Types.reject(#not_found));
                        };
                        if (
                            not writeTransitionMatches(
                                transition,
                                value,
                            )
                        ) return #err(
                            Types.reject(#stale_revision)
                        );
                        ?value;
                    };
                };
                switch (old) {
                    case null {
                        proposedCipher += metadata.size();
                    };
                    case (?oldNode) {
                        if (
                            proposedCipher <
                                oldNode.encrypted_metadata.size()
                        ) return #err(Types.reject(#corrupt_state));
                        proposedCipher :=
                            proposedCipher -
                            oldNode.encrypted_metadata.size() +
                            metadata.size();
                    };
                };
                let requestedKind = switch (transition.requested_kind) {
                    case null return #err(Types.reject(#incompatible));
                    case (?value) value;
                };
                switch (old, requestedKind) {
                    case (?{ kind = #file(_) }, #file) {};
                    case (?{ kind = #folder(_) }, #folder) {
                        return #err(Types.reject(#invalid_request));
                    };
                    case (null, _) {};
                    case (_) return #err(Types.reject(#conflict));
                };
                if (requestedKind == #file) {
                    switch (old) {
                        case null createdFileTargets += 1;
                        case (?_) replacedFileTargets += 1;
                    };
                };
                if (
                    requestedKind == #folder and
                    not plannedFolderBoundsValid(
                        first.nodes,
                        transition.node_id,
                        transition.declared_name_scalars,
                    )
                ) return #err(
                    Types.reject(#batch_structure_limit)
                );
                let content : ?Memory.ContentRecord = switch (
                    requestedKind,
                    nodePlan.content,
                ) {
                    case (#folder, null) null;
                    case (#folder, ?_) return #err(
                        Types.reject(#invalid_request)
                    );
                    case (#file, null) return #err(
                        Types.reject(#invalid_request)
                    );
                    case (#file, ?plan) {
                        let ?wrapper = Frames.payloadSlice(
                            raw,
                            plan.wrapped_content_key,
                        ) else return #err(
                            Types.reject(#invalid_request)
                        );
                        if (wrapper.size() != 48) {
                            return #err(
                                Types.reject(#invalid_request)
                            );
                        };
                        if (
                            plan.content_id == Types.ROOT_NODE_ID or
                            contentIdUsedBefore(
                                first.nodes,
                                plannedIndex,
                                plan.content_id,
                            ) or
                            contentBlocksExist(plan.content_id) or
                            contentIdReservedByStage(plan.content_id) or
                            contentIdRetainedByReceipt(plan.content_id)
                        ) return #err(Types.reject(#id_collision));
                        let plain = contentPlaintextPlan(plan);
                        let ?plainBytes = plain else {
                            return #err(
                                Types.reject(#invalid_request)
                            );
                        };
                        let descriptor : Memory.ContentRecord = {
                            content_id = plan.content_id;
                            wrapped_content_key = wrapper;
                            block_count = Nat32.fromNat(
                                plan.ciphertext_block_lengths.size()
                            );
                            ciphertext_bytes =
                                Nat64.toNat(plan.ciphertext_bytes);
                            crypto_profile = #aes_256_gcm_files_v2;
                        };
                        switch (old) {
                            case (?oldNode) switch (
                                Tree.content(oldNode)
                            ) {
                                case (?oldContent) {
                                    let ?oldPlain =
                                        Tree.contentPlaintext(oldContent)
                                    else return #err(
                                        Types.reject(#corrupt_state)
                                    );
                                    if (
                                        proposedPlain < oldPlain or
                                        proposedCipher <
                                            oldContent.ciphertext_bytes
                                    ) return #err(
                                        Types.reject(#corrupt_state)
                                    );
                                    proposedPlain :=
                                        proposedPlain - oldPlain +
                                        plainBytes;
                                    proposedCipher :=
                                        proposedCipher -
                                        oldContent.ciphertext_bytes +
                                        descriptor.ciphertext_bytes;
                                    List.add(retired, {
                                        node_id = transition.node_id;
                                        content = oldContent;
                                    });
                                };
                                case null {
                                    proposedPlain += plainBytes;
                                    proposedCipher +=
                                        descriptor.ciphertext_bytes;
                                };
                            };
                            case null {
                                proposedPlain += plainBytes;
                                proposedCipher +=
                                    descriptor.ciphertext_bytes;
                            };
                        };
                        ?descriptor;
                    };
                };
                let kind : Memory.NodeKind = switch (requestedKind) {
                    case (#file) {
                        let ?descriptor = content else {
                            return #err(Types.reject(#invalid_request));
                        };
                        #file({ active_content = ?descriptor });
                    };
                    case (#folder) {
                        let aggregate = plannedFolderAggregate(
                            first.nodes,
                            transition.node_id,
                        );
                        #folder(aggregate.folder);
                    };
                };
                let replacement : Memory.Node = {
                    parent_id = transition.proposed_parent_id;
                    kind;
                    state = #active;
                    name_tag = Frames.digestToTag(
                        transition.proposed_name_tag
                    );
                    declared_name_scalars =
                        transition.declared_name_scalars;
                    structural_revision =
                        transition.proposed_structural_revision;
                    metadata_revision =
                        transition.proposed_metadata_revision;
                    children_revision =
                        transition.proposed_children_revision;
                    subtree_height = switch (kind) {
                        case (#file(_)) 0;
                        case (#folder(_)) plannedFolderAggregate(
                            first.nodes,
                            transition.node_id,
                        ).height;
                    };
                    max_relative_path_scalars = switch (kind) {
                        case (#file(_)) {
                            transition.declared_name_scalars;
                        };
                        case (#folder(_)) plannedFolderAggregate(
                            first.nodes,
                            transition.node_id,
                        ).maximum_path;
                    };
                    subtree_plaintext_bytes = switch (content) {
                        case (?descriptor) {
                            let ?plain = Tree.contentPlaintext(descriptor)
                            else return #err(
                                Types.reject(#invalid_request)
                            );
                            plain;
                        };
                        case null plannedFolderAggregate(
                            first.nodes,
                            transition.node_id,
                        ).plaintext;
                    };
                    encrypted_metadata = metadata;
                };
                if (
                    replacement.subtree_height !=
                        transition.proposed_subtree_height or
                    replacement.max_relative_path_scalars !=
                        transition.proposed_max_relative_path_scalars or
                    Nat64.fromNat(
                        replacement.subtree_plaintext_bytes
                    ) != transition.proposed_subtree_plaintext_bytes
                ) return #err(Types.reject(#invalid_request));
                switch (old) {
                    case null {
                        if (
                            replacement.structural_revision != 1 or
                            replacement.metadata_revision != 1 or
                            replacement.children_revision != 0
                        ) return #err(
                            Types.reject(#stale_revision)
                        );
                    };
                    case (?oldNode) {
                        if (
                            oldNode.structural_revision ==
                                Nat64.maxValue or
                            oldNode.metadata_revision ==
                                Nat64.maxValue or
                            replacement.parent_id != oldNode.parent_id or
                            replacement.name_tag != oldNode.name_tag or
                            replacement.declared_name_scalars !=
                                oldNode.declared_name_scalars or
                            replacement.structural_revision !=
                                oldNode.structural_revision + 1 or
                            replacement.metadata_revision !=
                                oldNode.metadata_revision + 1 or
                            replacement.children_revision !=
                                oldNode.children_revision
                        ) return #err(
                            Types.reject(#stale_revision)
                        );
                    };
                };
                List.add(explicit, {
                    node_id = transition.node_id;
                    expected = old;
                    replacement;
                });
                plannedIndex += 1;
            };
            let proposedNodes = mem.node_count + newNodes;
            if (
                proposedNodes > Types.MAX_NODES or
                proposedPlain > Types.MAX_PRIVATE_PLAINTEXT_BYTES or
                proposedCipher > Types.MAX_COMMITTED_CIPHERTEXT_BYTES or
                first.quota.proposed_node_count !=
                    Nat64.fromNat(proposedNodes) or
                first.quota.proposed_committed_plaintext_bytes !=
                    Nat64.fromNat(proposedPlain) or
                first.quota.proposed_committed_ciphertext_bytes !=
                    Nat64.fromNat(proposedCipher)
            ) return #err(Types.reject(#quota));
            switch (
                validateNewWriteGraph(first.nodes)
            ) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            if (
                not retiredMatches(
                    List.toArray(retired),
                    first.retired_contents,
                )
            ) return #err(Types.reject(#conflict));
            let structureResult = Mutation.planWriteStructure(
                mem,
                List.toArray(explicit),
                first.folder_transitions,
                first.child_index_transitions,
                proposedNodes,
            );
            let #ok(structure) = structureResult else {
                let #err(error) = structureResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            if (
                Nat64.toNat(first.quota.gross_peak_physical_bytes) >
                    Types.MAX_PHYSICAL_PRIVATE_BYTES
            ) return #err(Types.reject(#quota));
            let intent : Memory.WriteIntent = switch (first.intent) {
                case (?#create) {
                    if (
                        createdFileTargets != 1 or
                        replacedFileTargets != 0
                    ) return #err(Types.reject(#conflict));
                    #create;
                };
                case (?#replace) {
                    if (
                        createdFileTargets != 0 or
                        replacedFileTargets != 1
                    ) return #err(Types.reject(#conflict));
                    #replace;
                };
                case (?#batch) #batch;
                case null return #err(Types.reject(#incompatible));
            };
            #ok({
                intent;
                node_mutations = structure.node_mutations;
                child_index_mutations =
                    structure.child_index_mutations;
                retired_contents = List.toArray(retired);
                node_count_delta = delta(mem.node_count, proposedNodes);
                committed_plaintext_delta = delta(
                    mem.committed_private_plaintext_bytes,
                    proposedPlain,
                );
                committed_ciphertext_delta = delta(
                    mem.committed_ciphertext_bytes,
                    proposedCipher,
                );
                final_physical_bytes = 0;
            });
        };

        type FolderAggregate = {
            folder : Memory.FolderRecord;
            height : Nat8;
            maximum_path : Nat16;
            plaintext : Nat;
        };

        func plannedFolderAggregate(
            nodes : [Frames.WriteNodePlan],
            folderId : Types.Id128,
        ) : FolderAggregate {
            var heights : [Memory.HeightCount] = [];
            var paths : [Memory.PathScalarCount] = [];
            var count = 0;
            var plaintext = 0;
            var folderNameScalars : Nat16 = 0;
            for (candidate in nodes.values()) {
                if (candidate.node.node_id == folderId) {
                    folderNameScalars :=
                        candidate.node.declared_name_scalars;
                };
                if (
                    candidate.node.proposed_parent_id == folderId and
                    candidate.node.node_id != folderId
                ) {
                    heights := addHeightCount(
                        heights,
                        candidate.node.proposed_subtree_height,
                    );
                    paths := addPathCount(
                        paths,
                        candidate.node.proposed_max_relative_path_scalars,
                    );
                    plaintext += Nat64.toNat(
                        candidate.node.proposed_subtree_plaintext_bytes
                    );
                    count += 1;
                };
            };
            let height : Nat8 = if (count == 0) 0 else {
                heights[heights.size() - 1].value + 1;
            };
            let maximumPath : Nat16 = if (count == 0) {
                folderNameScalars;
            } else {
                Nat16.fromNat(
                    Nat16.toNat(folderNameScalars) + 1 +
                    Nat16.toNat(paths[paths.size() - 1].value)
                );
            };
            {
                folder = {
                    direct_child_count = Nat32.fromNat(count);
                    child_subtree_heights = heights;
                    child_relative_path_scalars = paths;
                };
                height;
                maximum_path = maximumPath;
                plaintext;
            };
        };

        func plannedFolderBoundsValid(
            nodes : [Frames.WriteNodePlan],
            folderId : Types.Id128,
            nameScalars : Nat16,
        ) : Bool {
            var hasChildren = false;
            var maximumHeight : Nat8 = 0;
            var maximumPath : Nat16 = 0;
            for (candidate in nodes.values()) {
                if (
                    candidate.node.proposed_parent_id == folderId and
                    candidate.node.node_id != folderId
                ) {
                    hasChildren := true;
                    if (
                        candidate.node.proposed_subtree_height >
                            maximumHeight
                    ) maximumHeight :=
                        candidate.node.proposed_subtree_height;
                    if (
                        candidate.node.proposed_max_relative_path_scalars >
                            maximumPath
                    ) maximumPath :=
                        candidate.node.proposed_max_relative_path_scalars;
                };
            };
            if (not hasChildren) return true;
            if (maximumHeight >= Types.MAX_TREE_DEPTH) return false;
            Nat16.toNat(nameScalars) + 1 +
                Nat16.toNat(maximumPath) <=
                Nat16.toNat(Types.MAX_PATH_SCALARS);
        };

        func addHeightCount(
            values : [Memory.HeightCount],
            value : Nat8,
        ) : [Memory.HeightCount] {
            let result = List.empty<Memory.HeightCount>();
            var inserted = false;
            for (entry in values.values()) {
                if (entry.value == value) {
                    List.add(result, {
                        value;
                        count = entry.count + 1;
                    });
                    inserted := true;
                } else {
                    if (not inserted and value < entry.value) {
                        List.add(
                            result,
                            ({ value; count = 1 } : Memory.HeightCount),
                        );
                        inserted := true;
                    };
                    List.add(result, entry);
                };
            };
            if (not inserted) {
                List.add(
                    result,
                    ({ value; count = 1 } : Memory.HeightCount),
                );
            };
            List.toArray(result);
        };

        func addPathCount(
            values : [Memory.PathScalarCount],
            value : Nat16,
        ) : [Memory.PathScalarCount] {
            let result = List.empty<Memory.PathScalarCount>();
            var inserted = false;
            for (entry in values.values()) {
                if (entry.value == value) {
                    List.add(result, {
                        value;
                        count = entry.count + 1;
                    });
                    inserted := true;
                } else {
                    if (not inserted and value < entry.value) {
                        List.add(
                            result,
                            ({
                                value;
                                count = 1;
                            } : Memory.PathScalarCount),
                        );
                        inserted := true;
                    };
                    List.add(result, entry);
                };
            };
            if (not inserted) {
                List.add(
                    result,
                    ({ value; count = 1 } : Memory.PathScalarCount),
                );
            };
            List.toArray(result);
        };

        func writeTransitionMatches(
            transition : Frames.NodeTransitionFrame,
            old : Memory.Node,
        ) : Bool {
            transition.expected_parent_id == ?old.parent_id and
            transition.expected_name_tag ==
                ?Frames.digestFromTag(old.name_tag) and
            transition.expected_structural_revision ==
                ?old.structural_revision and
            transition.expected_metadata_revision ==
                ?old.metadata_revision and
            transition.expected_children_revision ==
                ?old.children_revision and
            transition.expected_subtree_height ==
                ?old.subtree_height and
            transition.expected_max_relative_path_scalars ==
                ?old.max_relative_path_scalars and
            transition.expected_subtree_plaintext_bytes ==
                ?Nat64.fromNat(old.subtree_plaintext_bytes);
        };

        func contentPlaintextPlan(
            plan : Frames.WriteContentPlan
        ) : ?Nat {
            var total = 0;
            for (length in plan.plaintext_block_lengths.values()) {
                total += Nat32.toNat(length);
            };
            if (total > Types.MAX_FILE_PLAINTEXT_BYTES) null else ?total;
        };

        func contentIdUsedBefore(
            nodes : [Frames.WriteNodePlan],
            before : Nat,
            contentId : Types.Id128,
        ) : Bool {
            var index = 0;
            while (index < before) {
                switch (nodes[index].content) {
                    case (?content) if (
                        content.content_id == contentId
                    ) return true;
                    case (_) {};
                };
                index += 1;
            };
            false;
        };

        func contentBlocksExist(contentId : Types.Id128) : Bool {
            let iterator = Map.entriesFrom(
                mem.blocks,
                Keys.compareBlockKey,
                Keys.blockKey(contentId, 0),
            );
            switch (iterator.next()) {
                case (?(key, _)) {
                    key.0 == contentId.hi and key.1 == contentId.lo;
                };
                case null false;
            };
        };

        func nodeIdReservedByStage(nodeId : Types.Id128) : Bool {
            for ((_, stored) in Map.entries(mem.stages)) {
                switch (stored) {
                    case (#private_write(stage)) {
                        for (
                            mutation in
                            stage.commit_plan.node_mutations.values()
                        ) {
                            if (
                                mutation.node_id == nodeId and
                                mutation.expected == null
                            ) return true;
                        };
                    };
                    case (_) {};
                };
            };
            false;
        };

        func contentIdReservedByStage(contentId : Types.Id128) : Bool {
            for ((_, stored) in Map.entries(mem.stages)) {
                switch (stored) {
                    case (#private_write(stage)) {
                        for (
                            mutation in
                            stage.commit_plan.node_mutations.values()
                        ) {
                            switch (mutation.replacement) {
                                case (?node) switch (Tree.content(node)) {
                                    case (?content) if (
                                        content.content_id == contentId
                                    ) return true;
                                    case (_) {};
                                };
                                case null {};
                            };
                        };
                    };
                    case (_) {};
                };
            };
            false;
        };

        func nodeIdRetainedByReceipt(nodeId : Types.Id128) : Bool {
            switch (
                Map.get(
                    mem.private_receipt_identity_owners,
                    Keys.compareId128,
                    nodeId,
                )
            ) {
                case (?owner) owner.node_count != 0;
                case null false;
            };
        };

        func contentIdRetainedByReceipt(
            contentId : Types.Id128
        ) : Bool {
            switch (
                Map.get(
                    mem.private_receipt_identity_owners,
                    Keys.compareId128,
                    contentId,
                )
            ) {
                case (?owner) owner.content_count != 0;
                case null false;
            };
        };

        func validateNewWriteGraph(
            nodes : [Frames.WriteNodePlan]
        ) : UnitResult {
            for (candidate in nodes.values()) {
                if (candidate.node.expected_structural_revision == null) {
                    var current = candidate.node.proposed_parent_id;
                    var depth = 1;
                    let seen = List.empty<Types.Id128>();
                    List.add(seen, candidate.node.node_id);
                    label ancestors loop {
                        for (prior in List.toArray(seen).values()) {
                            if (prior == current) {
                                return #err(Types.reject(#conflict));
                            };
                        };
                        List.add(seen, current);
                        var planned : ?Frames.WriteNodePlan = null;
                        for (possible in nodes.values()) {
                            if (possible.node.node_id == current) {
                                planned := ?possible;
                            };
                        };
                        switch (planned) {
                            case (?parent) {
                                if (
                                    parent.node.requested_kind !=
                                        ?#folder
                                ) return #err(
                                    Types.reject(#not_folder)
                                );
                                current :=
                                    parent.node.proposed_parent_id;
                                depth += 1;
                            };
                            case null {
                                let result = tree.depth(current);
                                let #ok(parentDepth) = result else {
                                    let #err(error) = result else {
                                        return #err(
                                            Types.reject(#corrupt_state)
                                        );
                                    };
                                    return #err(error);
                                };
                                depth += Nat8.toNat(parentDepth);
                                break ancestors;
                            };
                        };
                        if (
                            depth >
                            Nat8.toNat(Types.MAX_TREE_DEPTH)
                        ) return #err(
                            Types.reject(#batch_structure_limit)
                        );
                    };
                    if (
                        depth +
                            Nat8.toNat(
                                candidate.node.proposed_subtree_height
                            ) >
                        Nat8.toNat(Types.MAX_TREE_DEPTH)
                    ) return #err(
                        Types.reject(#batch_structure_limit)
                    );
                };
            };
            #ok(());
        };

        func retiredMatches(
            expected : [Memory.ContentRetirement],
            declared : [Frames.RetiredContent],
        ) : Bool {
            if (expected.size() != declared.size()) return false;
            for (entry in expected.values()) {
                var matches = 0;
                for (value in declared.values()) {
                    if (
                        value.node_id == entry.node_id and
                        value.content_id == entry.content.content_id and
                        value.block_count ==
                            entry.content.block_count and
                        value.ciphertext_bytes ==
                            Nat64.fromNat(
                                entry.content.ciphertext_bytes
                            )
                    ) matches += 1;
                };
                if (matches != 1) return false;
            };
            true;
        };

        func delta(before : Nat, after : Nat) : Memory.ByteDelta {
            if (after > before) #increase(after - before) else if (
                before > after
            ) #decrease(before - after) else #unchanged;
        };

        func plannedCiphertext(
            frames : [Frames.WriteFramePlan]
        ) : Nat {
            var total = 0;
            for (frame in frames.values()) {
                total += frameCiphertext(frame);
            };
            total;
        };

        func frameCiphertext(frame : Frames.WriteFramePlan) : Nat {
            var total = 0;
            for (block in frame.blocks.values()) {
                total += Nat32.toNat(block.ciphertext_bytes);
            };
            total;
        };

        func framePlanCiphertext(frame : Memory.FramePlan) : Nat {
            var total = 0;
            for (block in frame.blocks.values()) {
                total += Nat32.toNat(block.ciphertext_bytes);
            };
            total;
        };

        func frameBlockCharge(frame : Frames.WriteFramePlan) : Nat {
            var total = 0;
            for (block in frame.blocks.values()) {
                total += Accounting.blockCharge(
                    Nat32.toNat(block.ciphertext_bytes)
                );
            };
            total;
        };

        func framePlanBlockCharge(frame : Memory.FramePlan) : Nat {
            var total = 0;
            for (block in frame.blocks.values()) {
                total += Accounting.blockCharge(
                    Nat32.toNat(block.ciphertext_bytes)
                );
            };
            total;
        };

        func allBlockCharge(
            frames : [Frames.WriteFramePlan]
        ) : Nat {
            var total = 0;
            for (frame in frames.values()) {
                total += frameBlockCharge(frame);
            };
            total;
        };

        func emptyBitmap(count : Nat8) : Blob {
            Blob.fromArray(
                Array.tabulate<Nat8>(
                    (Nat8.toNat(count) + 7) / 8,
                    func(_) { 0 },
                )
            );
        };

        func bitmapSet(bitmap : Blob, ordinal : Nat8) : Blob {
            let byteIndex = Nat8.toNat(ordinal) / 8;
            let bit = Nat8.toNat(ordinal) % 8;
            Blob.fromArray(
                Array.tabulate<Nat8>(
                    bitmap.size(),
                    func(index) {
                        if (index == byteIndex) {
                            bitmap[index] |
                                Nat8.fromNat(2 ** bit);
                        } else bitmap[index];
                    },
                )
            );
        };

        func bitmapHas(bitmap : Blob, ordinal : Nat8) : Bool {
            let byteIndex = Nat8.toNat(ordinal) / 8;
            if (byteIndex >= bitmap.size()) return false;
            let bit = Nat8.toNat(ordinal) % 8;
            (Nat8.toNat(bitmap[byteIndex]) / (2 ** bit)) % 2 == 1;
        };

        func bitmapComplete(bitmap : Blob, count : Nat8) : Bool {
            var index : Nat8 = 0;
            while (index < count) {
                if (not bitmapHas(bitmap, index)) return false;
                index += 1;
            };
            true;
        };

        func bitmapNat16(bitmap : Blob) : Nat16 {
            var result : Nat16 = 0;
            if (bitmap.size() > 0) {
                result := Nat16.fromNat(Nat8.toNat(bitmap[0]));
            };
            if (bitmap.size() > 1) {
                result |= Nat16.fromNat(Nat8.toNat(bitmap[1])) << 8;
            };
            result;
        };

        func storeFrameBlocks(
            frame : Frames.WriteFramePlan,
            raw : Frames.RawPayload,
        ) {
            for (block in frame.blocks.values()) {
                let ?body = Frames.payloadSlice(raw, block.payload) else {
                    Runtime.trap("validated first-frame block slice");
                };
                let key = Keys.blockKey(
                    block.content_id,
                    block.block_index,
                );
                if (
                    Map.get(mem.blocks, Keys.compareBlockKey, key) != null
                ) Runtime.trap("validated content id collision");
                Map.add(mem.blocks, Keys.compareBlockKey, key, body);
            };
        };

        func storeContinuationBlocks(
            frame : Memory.FramePlan,
            raw : Frames.RawPayload,
        ) {
            for (block in frame.blocks.values()) {
                let ?body = Frames.payloadSlice(raw, {
                    offset = block.payload_offset;
                    length = block.payload_length;
                }) else Runtime.trap(
                    "validated continuation block slice"
                );
                let key = Keys.blockKey(
                    block.content_id,
                    block.block_index,
                );
                if (
                    Map.get(mem.blocks, Keys.compareBlockKey, key) != null
                ) Runtime.trap("validated continuation collision");
                Map.add(mem.blocks, Keys.compareBlockKey, key, body);
            };
        };

        func continuationMatches(
            value : Frames.WriteContinuationFrame,
            pinned : Memory.FramePlan,
        ) : Bool {
            if (
                value.frame_ordinal != pinned.ordinal or
                value.blocks.size() != pinned.blocks.size() or
                value.raw_payload_bytes !=
                    totalRawBytes(pinned.blocks)
            ) return false;
            var index = 0;
            while (index < value.blocks.size()) {
                let left = value.blocks[index];
                let right = pinned.blocks[index];
                if (
                    left.content_id != right.content_id or
                    left.block_index != right.block_index or
                    left.ciphertext_bytes !=
                        right.ciphertext_bytes or
                    left.payload.offset != right.payload_offset or
                    left.payload.length != right.payload_length
                ) return false;
                index += 1;
            };
            true;
        };

        func totalRawBytes(blocks : [Memory.StageBlock]) : Nat32 {
            var total = 0;
            for (block in blocks.values()) {
                total += Nat32.toNat(block.payload_length);
            };
            Nat32.fromNat(total);
        };

        func privateStageCount() : Nat {
            var count = 0;
            for ((_, stage) in Map.entries(mem.stages)) {
                switch (stage) {
                    case (#private_write(_)) count += 1;
                    case (_) {};
                };
            };
            count;
        };

        func stageWriteOk(
            stageId : Nat64,
            stage : Memory.PrivateStage,
            ordinal : Nat8,
        ) : Types.WriteBlockOk {
            {
                request_id = stage.request_id;
                stage_id = ?stageId;
                frame_ordinal = ordinal;
                accepted_frames_bitmap =
                    bitmapNat16(stage.accepted_frame_bitmap);
                committed_nodes = [];
                cleanup_state = cleanupSummary().state;
            };
        };

        func writeReceiptOk(
            value : {
                request_id : Types.Id128;
                stage_id : ?Nat64;
                frame_ordinal : Nat8;
                accepted_frames_bitmap : Nat16;
                nodes : [Memory.PrivateReceiptNode];
                cleanup_state : ?Memory.StoredCleanupState;
            }
        ) : Types.WriteBlockOk {
            {
                request_id = value.request_id;
                stage_id = value.stage_id;
                frame_ordinal = value.frame_ordinal;
                accepted_frames_bitmap =
                    value.accepted_frames_bitmap;
                committed_nodes = Array.map<
                    Memory.PrivateReceiptNode,
                    Types.CommittedNode
                >(
                    value.nodes,
                    func(node) { node },
                );
                cleanup_state =
                    publicCleanupState(value.cleanup_state);
            };
        };

        func priorFramesAccepted(bitmap : Blob, finalOrdinal : Nat8) : Bool {
            var ordinal : Nat8 = 0;
            while (ordinal < finalOrdinal) {
                if (not bitmapHas(bitmap, ordinal)) return false;
                ordinal += 1;
            };
            true;
        };

        func privateCommitPreflight(
            stage : Memory.PrivateStage
        ) : UnitResult {
            let ?projectedNodes = checkedProjectedDelta(
                mem.node_count,
                stage.commit_plan.node_count_delta,
            ) else return #err(Types.reject(#corrupt_state));
            let ?projectedPlaintext = checkedProjectedDelta(
                mem.committed_private_plaintext_bytes,
                stage.commit_plan.committed_plaintext_delta,
            ) else return #err(Types.reject(#corrupt_state));
            let ?projectedCiphertext = checkedProjectedDelta(
                mem.committed_ciphertext_bytes,
                stage.commit_plan.committed_ciphertext_delta,
            ) else return #err(Types.reject(#corrupt_state));
            if (
                projectedNodes > Types.MAX_NODES or
                projectedPlaintext >
                    Types.MAX_PRIVATE_PLAINTEXT_BYTES or
                projectedCiphertext >
                    Types.MAX_COMMITTED_CIPHERTEXT_BYTES
            ) return #err(Types.reject(#quota));
            for (mutation in stage.commit_plan.node_mutations.values()) {
                if (
                    Map.get(
                        mem.nodes_by_id,
                        Keys.compareId128,
                        mutation.node_id,
                    ) != mutation.expected
                ) return #err(Types.reject(#stale_revision));
            };
            for (mutation in stage.commit_plan.child_index_mutations.values()) {
                if (
                    Map.get(
                        mem.children_by_name,
                        Keys.compareChildNameKey,
                        mutation.key,
                    ) != mutation.expected
                ) return #err(Types.reject(#conflict));
            };
            let cleanupNeeded = retiredNeedsCleanupJob(
                stage.commit_plan.retired_contents
            );
            if (
                cleanupNeeded and
                (stage.reserved_cleanup_jobs == 0 or
                Map.size(mem.delete_jobs) +
                    mem.reserved_cleanup_jobs >
                    Types.MAX_CLEANUP_JOBS or
                mem.next_job_id == Nat64.maxValue)
            ) return #err(Types.reject(#busy));
            if (
                Map.size(mem.private_receipts) +
                    privateStageCount() >
                    Types.MAX_PRIVATE_RECEIPTS
            ) return #err(Types.reject(#busy));
            #ok(());
        };

        func commitPrivateStage(
            stageId : Nat64,
            stage : Memory.PrivateStage,
            finalOrdinal : Nat8,
        ) : Types.Result<Types.WriteBlockOk> {
            if (not bitmapComplete(
                stage.accepted_frame_bitmap,
                stage.frame_count,
            )) Runtime.trap("final private frame before complete plan");
            switch (privateCommitPreflight(stage)) {
                case (#err(_)) Runtime.trap(
                    "private commit changed after preflight"
                );
                case (#ok) {};
            };
            for (mutation in stage.commit_plan.node_mutations.values()) {
                if (
                    Map.get(
                        mem.nodes_by_id,
                        Keys.compareId128,
                        mutation.node_id,
                    ) != mutation.expected
                ) Runtime.trap("private node CAS after preflight");
            };
            for (mutation in stage.commit_plan.child_index_mutations.values()) {
                if (
                    Map.get(
                        mem.children_by_name,
                        Keys.compareChildNameKey,
                        mutation.key,
                    ) != mutation.expected
                ) Runtime.trap("private index CAS after preflight");
            };
            if (
                stage.reserved_ciphertext_bytes != 0 or
                mem.staged_ciphertext_bytes <
                    stage.accepted_ciphertext_bytes
            ) Runtime.trap("private stage completion counters");
            let committedNodes = committedPrivateNodes(stage.commit_plan);
            let at = nowNs();
            let cleanupNeeded = retiredNeedsCleanupJob(
                stage.commit_plan.retired_contents
            );
            let receiptBase : Memory.PrivateReceipt = {
                request_fingerprint = stage.request_fingerprint;
                outcome = #write({
                    request_id = stage.request_id;
                    stage_id = ?stageId;
                    frame_ordinal = finalOrdinal;
                    accepted_frames_bitmap =
                        bitmapNat16(stage.accepted_frame_bitmap);
                    frame_fingerprints = Array.map<
                        ?Types.Digest256,
                        Types.Digest256
                    >(
                        stage.frame_fingerprints,
                        func(value) {
                            switch (value) {
                                case (?digest) digest;
                                case null Runtime.trap(
                                    "complete stage missing fingerprint"
                                );
                            };
                        },
                    );
                    nodes = committedNodes;
                    cleanup_state = null;
                });
                completed_at_ns = at;
                terminal_kind = null;
                expires_at_ns = deadline(
                    at,
                    Types.RECEIPT_RETENTION_NS,
                );
            };
            let structural = mutationPlan(stage.commit_plan);
            let growth =
                if (structural.physical_after >
                    structural.physical_before) {
                    structural.physical_after -
                        structural.physical_before;
                } else 0;
            let reservedReceipt : Memory.PrivateReceipt = {
                receiptBase with
                outcome = switch (receiptBase.outcome) {
                    case (#write(value)) #write({
                        value with cleanup_state = ?#pending({
                            remaining_jobs = Nat16.fromNat(
                                Types.MAX_CLEANUP_JOBS
                            );
                        })
                    });
                    case (_) Runtime.trap("write receipt shape");
                };
            };
            let reservedReceiptCharge =
                privateReceiptMaximumCharge(reservedReceipt);
            let cleanupJob = if (cleanupNeeded) {
                ?retiredContentsJob(
                    mem.next_job_id,
                    stage.commit_plan.retired_contents,
                    at,
                );
            } else null;
            let jobCharge = switch (cleanupJob) {
                case null 0;
                case (?job) Accounting.cleanupJobCharge(job);
            };
            let reservation =
                Accounting.privateCommitReservation(stage);
            let finalNeed = reservation.final_commit_charge;
            if (
                finalNeed < growth + reservedReceiptCharge + jobCharge
            ) Runtime.trap("accounting final reservation undercharge");
            if (
                stage.reserved_physical_bytes < finalNeed or
                mem.reserved_physical_private_bytes <
                    stage.reserved_physical_bytes
            ) Runtime.trap("private final reservation too small");
            if (
                cleanupNeeded and stage.reserved_cleanup_jobs == 0
            ) Runtime.trap("private cleanup slot reservation invariant");
            let oldStageCharge =
                Accounting.privateStageCharge(stage) +
                Accounting.stageRequestIndexCharge();
            ignore Map.remove(mem.stages, Nat64.compare, stageId);
            ignore Map.remove(
                mem.stages_by_request,
                Keys.compareId128,
                stage.request_id,
            );
            Accounting.removePhysical(mem, oldStageCharge);
            Accounting.releaseReservation(
                mem,
                0,
                stage.reserved_physical_bytes,
                Nat8.toNat(stage.reserved_cleanup_jobs),
            );
            Mutation.apply(mem, structural);
            applyDeltaPlaintext(
                mem,
                stage.commit_plan.committed_plaintext_delta,
            );
            applyDeltaCiphertext(
                mem,
                stage.commit_plan.committed_ciphertext_delta,
            );
            mem.staged_ciphertext_bytes -=
                stage.accepted_ciphertext_bytes;
            switch (cleanupJob) {
                case null {
                    synchronouslyRetire(
                        stage.commit_plan.retired_contents
                    );
                };
                case (?job) {
                    Map.add(
                        mem.delete_jobs,
                        Nat64.compare,
                        job.job_id,
                        job,
                    );
                    mem.next_job_id += 1;
                    Accounting.addPhysical(
                        mem,
                        Accounting.cleanupJobCharge(job),
                    );
                };
            };
            let cleanupState = cleanupSummary().state;
            let receipt : Memory.PrivateReceipt = {
                receiptBase with
                outcome = switch (receiptBase.outcome) {
                    case (#write(value)) #write({
                        value with
                        cleanup_state =
                            storedCleanupState(cleanupState)
                    });
                    case (_) Runtime.trap("write receipt shape");
                };
            };
            let receiptCharge =
                privateReceiptInsertionCharge(receipt);
            if (
                receiptCharge > reservedReceiptCharge
            ) Runtime.trap("write receipt reservation invariant");
            insertPrivateReceipt(stage.request_id, receipt);
            #ok(writeReceiptOk(
                switch (receipt.outcome) {
                    case (#write(value)) value;
                    case (_) Runtime.trap("write receipt shape");
                }
            ));
        };

        func expirePrivateStage(
            stageId : Nat64,
            stage : Memory.PrivateStage,
        ) : Types.Result<Types.WriteBlockOk> {
            let budget = fullCleanupBudget();
            if (
                cleanupInstructionHasHeadroom(
                    Types.PRIVATE_RETIRE_INSTRUCTION_RESERVE
                ) and
                privateStageFitsCleanupBudget(stage, budget)
            ) {
                ignore terminalizeExpiredPrivateStage(
                    stageId,
                    stage,
                    budget,
                );
            };
            #err(Types.reject(#expired));
        };

        type PrivateStageRetirement = {
            cleanup_job_id : ?Nat64;
            reclaimed_entries : Nat;
            entry_units : Nat;
            reclaimed_blocks : Nat;
            reclaimed_ciphertext_bytes : Nat;
            reclaimed_charged_bytes : Nat;
            work_units : Nat;
        };

        func terminalizeExpiredPrivateStage(
            stageId : Nat64,
            stage : Memory.PrivateStage,
            budget : CleanupBudget,
        ) : PrivateStageRetirement {
            let physicalBefore = mem.physical_private_bytes;
            let targets = privateStageReceiptTargets(stage);
            let framePlanFingerprints = Array.map<
                Memory.FramePlan,
                Types.Digest256
            >(
                stage.frames,
                Fingerprint.storedWriteFramePlan,
            );
            let reservedReceipt : Memory.PrivateReceipt = {
                request_fingerprint = stage.request_fingerprint;
                outcome = #expired({
                    request_id = stage.request_id;
                    stage_id = stageId;
                    nodes = targets;
                    frame_plan_fingerprints =
                        framePlanFingerprints;
                    frame_fingerprints =
                        stage.frame_fingerprints;
                    cleanup_state = ?#pending({
                        remaining_jobs = Nat16.fromNat(
                            Types.MAX_CLEANUP_JOBS
                        );
                    });
                    cleanup_job_id = ?0;
                });
                completed_at_ns = stage.expires_at_ns;
                terminal_kind = ?#expired;
                expires_at_ns = deadline(
                    stage.expires_at_ns,
                    Types.RECEIPT_RETENTION_NS,
                );
            };
            let reservedReceiptCharge =
                privateReceiptMaximumCharge(reservedReceipt);
            let retirement = retirePrivateStage(
                stageId,
                stage,
                reservedReceiptCharge,
                budget,
            );
            let receipt : Memory.PrivateReceipt = {
                reservedReceipt with
                outcome = #expired({
                    request_id = stage.request_id;
                    stage_id = stageId;
                    nodes = targets;
                    frame_plan_fingerprints =
                        framePlanFingerprints;
                    frame_fingerprints =
                        stage.frame_fingerprints;
                    cleanup_state =
                        storedCleanupState(cleanupSummary().state);
                    cleanup_job_id = retirement.cleanup_job_id;
                });
            };
            let receiptCharge =
                privateReceiptInsertionCharge(receipt);
            if (receiptCharge > reservedReceiptCharge) {
                Runtime.trap("expired receipt reservation invariant");
            };
            insertPrivateReceipt(stage.request_id, receipt);
            let physicalAfter = mem.physical_private_bytes;
            {
                retirement with
                reclaimed_charged_bytes =
                    if (physicalBefore >= physicalAfter) {
                        physicalBefore - physicalAfter
                    } else 0;
            };
        };

        func retirePrivateStage(
            stageId : Nat64,
            stage : Memory.PrivateStage,
            terminalReceiptCharge : Nat,
            budget : CleanupBudget,
        ) : PrivateStageRetirement {
            let physicalBefore = mem.physical_private_bytes;
            let blockKeys = List.empty<Memory.BlockKey>();
            for (frame in stage.frames.values()) {
                if (bitmapHas(stage.accepted_frame_bitmap, frame.ordinal)) {
                    for (block in frame.blocks.values()) {
                        List.add(
                            blockKeys,
                            Keys.blockKey(
                                block.content_id,
                                block.block_index,
                            ),
                        );
                    };
                };
            };
            let keys = List.toArray(blockKeys);
            let acceptedBlocks = keys.size();
            let identityRows =
                ReceiptOwnership.stage(stage).row_ids.size();
            var synchronousBlocks = 0;
            var synchronousCiphertext = 0;
            var acceptedCiphertext = 0;
            let blockSizes = List.empty<Nat>();
            label sizing for (key in keys.values()) {
                let ?body = Map.get(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                ) else Runtime.trap("private retirement block invariant");
                acceptedCiphertext += body.size();
                List.add(blockSizes, body.size());
            };
            if (acceptedCiphertext != stage.accepted_ciphertext_bytes) {
                Runtime.trap("private retirement ciphertext invariant");
            };
            let allSynchronous =
                acceptedBlocks <= budget.blocks and
                acceptedBlocks + 4 + identityRows <=
                    budget.entries and
                acceptedCiphertext <= budget.ciphertext_bytes and
                acceptedBlocks * 2 + 5 + identityRows <=
                    budget.work_units;
            if (allSynchronous) {
                synchronousBlocks := acceptedBlocks;
                synchronousCiphertext := acceptedCiphertext;
            } else {
                if (
                    stage.reserved_cleanup_jobs == 0 or
                    5 + identityRows > budget.entries or
                    acceptedBlocks + 6 + identityRows >
                        budget.work_units
                ) Runtime.trap(
                    "private retirement cleanup budget invariant"
                );
                label prefix for (
                    bodySize in
                    List.toArray(blockSizes).values()
                ) {
                    let next = synchronousBlocks + 1;
                    if (
                        next >= acceptedBlocks or
                        next > budget.blocks or
                        next + 5 + identityRows >
                            budget.entries or
                        acceptedBlocks + next + 6 +
                            identityRows >
                            budget.work_units or
                        synchronousCiphertext + bodySize >
                            budget.ciphertext_bytes
                    ) break prefix;
                    synchronousBlocks := next;
                    synchronousCiphertext += bodySize;
                };
            };
            var removed = 0;
            while (removed < synchronousBlocks) {
                let key = keys[removed];
                let ?body = Map.get(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                ) else Runtime.trap("private retirement block invariant");
                ignore Map.remove(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                );
                Accounting.removePhysical(
                    mem,
                    Accounting.blockCharge(body.size()),
                );
                removed += 1;
            };
            if (
                mem.staged_ciphertext_bytes < synchronousCiphertext
            ) Runtime.trap("private retirement staged counter");
            mem.staged_ciphertext_bytes -= synchronousCiphertext;

            let hasRemainder = synchronousBlocks < keys.size();
            let insertedJobRows = if (hasRemainder) 1 else 0;
            let pendingJob = if (not hasRemainder) null else {
                if (
                    Map.size(mem.delete_jobs) >=
                        Types.MAX_CLEANUP_JOBS or
                    mem.next_job_id == Nat64.maxValue
                ) Runtime.trap("abort cleanup reservation invariant");
                let id = mem.next_job_id;
                let at = nowNs();
                let job : Memory.DeleteJob = {
                    job_id = id;
                    kind = #private_stage({
                        blocks = keys;
                        next_block = Nat32.fromNat(synchronousBlocks);
                    });
                    created_at_ns = at;
                    updated_at_ns = at;
                    reclaimed_entries = 0;
                    reclaimed_ciphertext_bytes = 0;
                };
                ?job;
            };
            let jobCharge = switch (pendingJob) {
                case null 0;
                case (?job) Accounting.cleanupJobCharge(job);
            };
            if (
                stage.reserved_physical_bytes <
                    terminalReceiptCharge + jobCharge or
                mem.reserved_physical_private_bytes <
                    stage.reserved_physical_bytes
            ) Runtime.trap("private terminal reservation invariant");
            if (
                hasRemainder and stage.reserved_cleanup_jobs == 0
            ) Runtime.trap("private cleanup job reservation invariant");
            ignore Map.remove(mem.stages, Nat64.compare, stageId);
            ignore Map.remove(
                mem.stages_by_request,
                Keys.compareId128,
                stage.request_id,
            );
            Accounting.removePhysical(
                mem,
                Accounting.privateStageCharge(stage) +
                    Accounting.stageRequestIndexCharge(),
            );
            Accounting.releaseReservation(
                mem,
                stage.reserved_ciphertext_bytes,
                stage.reserved_physical_bytes,
                Nat8.toNat(stage.reserved_cleanup_jobs),
            );
            let cleanupJobId = switch (pendingJob) {
                case null null;
                case (?job) {
                    Map.add(
                        mem.delete_jobs,
                        Nat64.compare,
                        job.job_id,
                        job,
                    );
                    mem.next_job_id += 1;
                    Accounting.addPhysical(mem, jobCharge);
                    ?job.job_id;
                };
            };
            let physicalAfter = mem.physical_private_bytes;
            {
                cleanup_job_id = cleanupJobId;
                reclaimed_entries = synchronousBlocks + 2;
                entry_units =
                    synchronousBlocks + 4 +
                    insertedJobRows + identityRows;
                reclaimed_blocks = synchronousBlocks;
                reclaimed_ciphertext_bytes = synchronousCiphertext;
                reclaimed_charged_bytes =
                    if (physicalBefore >= physicalAfter) {
                        physicalBefore - physicalAfter
                    } else 0;
                work_units =
                    acceptedBlocks + synchronousBlocks + 5 +
                    insertedJobRows + identityRows;
            };
        };

        func mutationPlan(
            value : Memory.PrivateCommitPlan
        ) : Mutation.Plan {
            var before = 0;
            var after = 0;
            var result : ?Memory.Node = null;
            for (mutation in value.node_mutations.values()) {
                switch (mutation.expected) {
                    case (?node) before += Accounting.nodeCharge(node);
                    case null {};
                };
                switch (mutation.replacement) {
                    case (?node) {
                        after += Accounting.nodeCharge(node);
                        if (result == null) result := ?node;
                    };
                    case null {};
                };
            };
            for (mutation in value.child_index_mutations.values()) {
                if (mutation.expected != null) {
                    before += Accounting.childIndexCharge();
                };
                if (mutation.replacement != null) {
                    after += Accounting.childIndexCharge();
                };
            };
            let ?resultNode = result else Runtime.trap(
                "private plan without replacement"
            );
            {
                node_mutations = value.node_mutations;
                child_index_mutations = value.child_index_mutations;
                node_count_after = projectedDelta(
                    mem.node_count,
                    value.node_count_delta,
                );
                physical_before = before;
                physical_after = after;
                result_node = resultNode;
            };
        };

        func committedPrivateNodes(
            plan : Memory.PrivateCommitPlan
        ) : [Memory.PrivateReceiptNode] {
            let result = List.empty<Memory.PrivateReceiptNode>();
            for (mutation in plan.node_mutations.values()) {
                switch (mutation.replacement) {
                    case (?node) {
                        let explicit =
                            mutation.expected == null or
                            (switch (mutation.expected) {
                                case (?old) {
                                    old.metadata_revision !=
                                        node.metadata_revision;
                                };
                                case null true;
                            });
                        if (explicit) List.add(result, {
                            node_id = mutation.node_id;
                            content_id = switch (Tree.content(node)) {
                                case null null;
                                case (?content) ?content.content_id;
                            };
                            structural_revision =
                                node.structural_revision;
                            metadata_revision = node.metadata_revision;
                        });
                    };
                    case null {};
                };
            };
            List.toArray(result);
        };

        func retiredBlockCount(
            retired : [Memory.ContentRetirement]
        ) : Nat {
            var total = 0;
            for (entry in retired.values()) {
                total += Nat32.toNat(entry.content.block_count);
            };
            total;
        };

        func retiredNeedsCleanupJob(
            retired : [Memory.ContentRetirement]
        ) : Bool {
            var ciphertext = 0;
            for (entry in retired.values()) {
                ciphertext += entry.content.ciphertext_bytes;
            };
            retiredBlockCount(retired) >
                Types.MAX_CLEANUP_BLOCKS_PER_PAGE or
            ciphertext > Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE;
        };

        func retiredContentsJob(
            jobId : Nat64,
            retired : [Memory.ContentRetirement],
            at : Nat64,
        ) : Memory.DeleteJob {
            {
                job_id = jobId;
                kind = #contents({
                    contents = Array.map<
                        Memory.ContentRetirement,
                        {
                            content_id : Types.Id128;
                            next_block_index : Nat32;
                            block_count : Nat32;
                        }
                    >(
                        retired,
                        func(entry) {
                            {
                                content_id = entry.content.content_id;
                                next_block_index = 0;
                                block_count =
                                    entry.content.block_count;
                            };
                        },
                    );
                    current_content = 0;
                });
                created_at_ns = at;
                updated_at_ns = at;
                reclaimed_entries = 0;
                reclaimed_ciphertext_bytes = 0;
            };
        };

        func synchronouslyRetire(
            retired : [Memory.ContentRetirement]
        ) {
            for (entry in retired.values()) {
                var index : Nat32 = 0;
                while (index < entry.content.block_count) {
                    let key = Keys.blockKey(
                        entry.content.content_id,
                        index,
                    );
                    let ?body = Map.get(
                        mem.blocks,
                        Keys.compareBlockKey,
                        key,
                    ) else Runtime.trap(
                        "validated retired content missing"
                    );
                    ignore Map.remove(
                        mem.blocks,
                        Keys.compareBlockKey,
                        key,
                    );
                    Accounting.removePhysical(
                        mem,
                        Accounting.blockCharge(body.size()),
                    );
                    index += 1;
                };
            };
        };

        func projectedDelta(
            current : Nat,
            change : Memory.ByteDelta,
        ) : Nat {
            switch (change) {
                case (#unchanged) current;
                case (#increase(value)) current + value;
                case (#decrease(value)) {
                    if (current < value) Runtime.trap(
                        "counter delta underflow"
                    );
                    current - value;
                };
            };
        };

        func checkedProjectedDelta(
            current : Nat,
            change : Memory.ByteDelta,
        ) : ?Nat {
            switch (change) {
                case (#unchanged) ?current;
                case (#increase(value)) ?(current + value);
                case (#decrease(value)) {
                    if (current < value) null else ?(current - value);
                };
            };
        };

        func physicalTransitionAdmission(
            replacedCharge : Nat,
            replacementCharge : Nat,
            additionalCharge : Nat,
        ) : UnitResult {
            if (mem.physical_private_bytes < replacedCharge) {
                return #err(Types.reject(#corrupt_state));
            };
            let projected =
                mem.physical_private_bytes - replacedCharge +
                replacementCharge + additionalCharge +
                mem.reserved_physical_private_bytes;
            if (
                projected > Types.MAX_PHYSICAL_PRIVATE_BYTES
            ) #err(Types.reject(#quota)) else #ok(());
        };

        func preparePrivateMutationAdmission(
            requestId : ?Types.Id128
        ) : Types.Result<CleanupPage> {
            advancePrivateMutationAdmissionWithin(
                fullCleanupBudget(),
                requestId,
            );
        };

        func applyDeltaNodeCount(
            memory : Memory.Mem,
            change : Memory.ByteDelta,
        ) {
            memory.node_count := projectedDelta(
                memory.node_count,
                change,
            );
        };

        func applyDeltaPlaintext(
            memory : Memory.Mem,
            change : Memory.ByteDelta,
        ) {
            memory.committed_private_plaintext_bytes :=
                projectedDelta(
                    memory.committed_private_plaintext_bytes,
                    change,
                );
        };

        func applyDeltaCiphertext(
            memory : Memory.Mem,
            change : Memory.ByteDelta,
        ) {
            memory.committed_ciphertext_bytes := projectedDelta(
                memory.committed_ciphertext_bytes,
                change,
            );
        };

        func validOperationTarget(
            target : Types.OperationTarget
        ) : Bool {
            switch (target) {
                case (#vault(_)) true;
                case (#private_write(value)) {
                    if (
                        value.nodes.size() == 0 or
                        value.nodes.size() >
                            Types.MAX_BATCH_PLAN_ENTRIES
                    ) return false;
                    var previous : ?Types.Id128 = null;
                    for (node in value.nodes.values()) {
                        if (node.node_id == Types.ROOT_NODE_ID) {
                            return false;
                        };
                        switch (node.content_id) {
                            case (?contentId) if (
                                contentId == Types.ROOT_NODE_ID
                            ) return false;
                            case (_) {};
                        };
                        switch (previous) {
                            case (?prior) if (
                                Keys.compareId128(prior, node.node_id) !=
                                    #less
                            ) return false;
                            case (_) {};
                        };
                        previous := ?node.node_id;
                    };
                    true;
                };
                case (#mutation(value)) {
                    value.node_id != Types.ROOT_NODE_ID
                };
                case (#remove(value)) {
                    value.node_id != Types.ROOT_NODE_ID
                };
                case (#abort(value)) value.stage_id != 0;
            };
        };

        func privateTargetMatches(
            target : Types.OperationTarget,
            stage : Memory.PrivateStage,
        ) : Bool {
            switch (target) {
                case (#private_write(value)) {
                    value.nodes == privateStageTargets(stage);
                };
                case (_) false;
            };
        };

        func privateAbortTargetMatches(
            target : Types.OperationTarget,
            stageId : Nat64,
        ) : Bool {
            switch (target) {
                case (#abort(value)) {
                    value.stage_id == stageId
                };
                case (_) false;
            };
        };

        func privateActiveState(
            stageId : Nat64,
            stage : Memory.PrivateStage,
        ) : {
            stage_id : ?Nat64;
            accepted_frames_bitmap : Nat16;
            frame_block_mapping : [Types.FrameBlockMapping];
            staged_bytes : Nat64;
            expires_at_ns : ?Nat64;
        } {
            let mappings = List.empty<Types.FrameBlockMapping>();
            for (frame in stage.frames.values()) {
                for (block in frame.blocks.values()) {
                    List.add(mappings, {
                        frame_ordinal = frame.ordinal;
                        content_id = block.content_id;
                        block_index = block.block_index;
                    });
                };
            };
            {
                stage_id = ?stageId;
                accepted_frames_bitmap =
                    bitmapNat16(stage.accepted_frame_bitmap);
                frame_block_mapping = List.toArray(mappings);
                staged_bytes = Nat64.fromNat(
                    stage.accepted_ciphertext_bytes
                );
                expires_at_ns = ?stage.expires_at_ns;
            };
        };

        func receiptDetail(
            receipt : Memory.PrivateReceipt,
            target : Types.OperationTarget,
        ) : Types.Result<Types.CommittedDetail> {
            switch (receipt.outcome) {
                case (#vault(value)) {
                    let #vault(binding) = target else {
                        return #err(Types.reject(#conflict));
                    };
                    if (
                        binding.expected_record_revision !=
                            value.expected_record_revision
                    ) return #err(Types.reject(#conflict));
                    #ok(#vault({
                        request_id = value.request_id;
                        record_revision = value.record_revision;
                        initialized = value.initialized;
                    }));
                };
                case (#write(value)) {
                    let #private_write(binding) = target else {
                        return #err(Types.reject(#conflict));
                    };
                    let targets = List.empty<
                        Types.OperationWriteTargetNode
                    >();
                    for (node in value.nodes.values()) {
                        List.add(targets, {
                            node_id = node.node_id;
                            content_id = node.content_id;
                        });
                    };
                    if (binding.nodes != List.toArray(targets)) {
                        return #err(Types.reject(#conflict));
                    };
                    #ok(#private_write(writeReceiptOk(value)));
                };
                case (#mutation(value)) {
                    let #mutation(binding) = target else {
                        return #err(Types.reject(#conflict));
                    };
                    if (binding.node_id != value.node_id) {
                        return #err(Types.reject(#conflict));
                    };
                    #ok(#mutation({
                        request_id = value.request_id;
                        node_id = value.node_id;
                        parent_id = value.parent_id;
                        structural_revision =
                            value.structural_revision;
                        metadata_revision =
                            value.metadata_revision;
                    }));
                };
                case (#remove(value)) {
                    let #remove(binding) = target else {
                        return #err(Types.reject(#conflict));
                    };
                    if (binding.node_id != value.node_id) {
                        return #err(Types.reject(#conflict));
                    };
                    #ok(#remove({
                        request_id = value.request_id;
                        node_id = value.node_id;
                        detached_plaintext_bytes =
                            value.detached_plaintext_bytes;
                        reclaimed_entries = value.reclaimed_entries;
                        reclaimed_ciphertext_bytes =
                            value.reclaimed_ciphertext_bytes;
                        cleanup_state =
                            publicCleanupState(value.cleanup_state);
                    }));
                };
                case (#abort(value)) {
                    let #abort(binding) = target else {
                        return #err(Types.reject(#conflict));
                    };
                    if (binding.stage_id != value.stage_id) {
                        return #err(Types.reject(#conflict));
                    };
                    #ok(#abort({
                        request_id = value.request_id;
                        stage_id = value.stage_id;
                        cleanup_state =
                            publicCleanupState(value.cleanup_state);
                    }));
                };
                case (#expired(_)) #err(Types.reject(#conflict));
            };
        };

        func removeImpl(
            request : Types.RemoveRequest
        ) : Types.Result<Types.RemoveOk> {
            let fingerprint = Fingerprint.remove(request);
            switch (privateReceipt(request.request_id, fingerprint)) {
                case (#err(error)) return #err(error);
                case (#ok(?receipt)) switch (receipt.outcome) {
                    case (#remove(value)) return #ok({
                        request_id = value.request_id;
                        node_id = value.node_id;
                        detached_plaintext_bytes =
                            value.detached_plaintext_bytes;
                        reclaimed_entries = value.reclaimed_entries;
                        reclaimed_ciphertext_bytes =
                            value.reclaimed_ciphertext_bytes;
                        cleanup_state =
                            publicCleanupState(value.cleanup_state);
                    });
                    case (_) return #err(Types.reject(#conflict));
                };
                case (#ok(null)) {};
            };
            switch (
                freshPrivateMutationRequestId(request.request_id)
            ) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            if (request.node_id == Types.ROOT_NODE_ID) {
                return #err(Types.reject(#quota));
            };
            // Keep the returned page so the new subtree job can consume only
            // the residual cleanup budget, but derive its detach plan from the
            // post-cleanup state and counters.
            let admissionPage = switch (
                preparePrivateMutationAdmission(?request.request_id)
            ) {
                case (#err(error)) return #err(error);
                case (#ok(page)) page;
            };
            // Expiring a private stage during admission can allocate a
            // residual cleanup job and advance this counter.
            if (mem.next_job_id == Nat64.maxValue) {
                return #err(Types.reject(#quota));
            };
            let selectedResult = tree.reachable(request.node_id);
            let #ok(selected) = selectedResult else {
                let #err(error) = selectedResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            if (
                selected.node.structural_revision !=
                    request.expected_structural_revision or
                selected.node.parent_id != request.expected_parent_id
            ) return #err(Types.reject(#stale_revision));
            let parentResult = tree.reachable(selected.node.parent_id);
            let #ok(parent) = parentResult else {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                parent.node.children_revision !=
                    request.expected_parent_children_revision
            ) return #err(Types.reject(#stale_revision));
            switch (selected.node.kind) {
                case (#folder(folder)) if (
                    folder.direct_child_count > 0 and not request.recursive
                ) return #err(Types.reject(#conflict));
                case (_) {};
            };
            let jobId = mem.next_job_id;
            let at = nowNs();
            let planResult = Mutation.planDetach(
                mem,
                selected,
                jobId,
                at,
            );
            let #ok(plan) = planResult else {
                let #err(error) = planResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let job : Memory.DeleteJob = {
                job_id = jobId;
                kind = #subtree({
                    root_id = request.node_id;
                    stack = [{
                        node_id = request.node_id;
                        after_child_tag = null;
                        entered = false;
                    }];
                });
                created_at_ns = at;
                updated_at_ns = at;
                reclaimed_entries = 0;
                reclaimed_ciphertext_bytes = 0;
            };
            let dummyReceipt : Memory.PrivateReceipt = {
                request_fingerprint = fingerprint;
                outcome = #remove({
                    request_id = request.request_id;
                    node_id = request.node_id;
                    detached_plaintext_bytes = Nat64.fromNat(
                        selected.node.subtree_plaintext_bytes
                    );
                    reclaimed_entries = 0;
                    reclaimed_ciphertext_bytes = 0;
                    // Admission reserves the largest terminal encoding. The
                    // synchronous first cleanup page may shrink this to
                    // #clean before the exact receipt is charged.
                    cleanup_state = ?#pending({
                        remaining_jobs = Nat16.fromNat(
                            Types.MAX_CLEANUP_JOBS
                        );
                    });
                    cleanup_job_id = ?jobId;
                });
                completed_at_ns = at;
                terminal_kind = null;
                expires_at_ns = deadline(
                    at,
                    Types.RECEIPT_RETENTION_NS,
                );
            };
            let growth =
                (if (plan.physical_after > plan.physical_before) {
                    plan.physical_after - plan.physical_before;
                } else 0) +
                Accounting.cleanupJobCharge(job) +
                privateReceiptMaximumCharge(dummyReceipt);
            if (not Accounting.canReserve(mem, 0, growth, 1)) {
                return #err(Types.reject(#quota));
            };
            switch (ensureReceiptLane()) {
                case (#err(error)) return #err(error);
                case (#ok) {};
            };
            Mutation.apply(mem, plan);
            if (
                mem.committed_private_plaintext_bytes <
                    selected.node.subtree_plaintext_bytes
            ) Runtime.trap("validated plaintext counter underflow");
            mem.committed_private_plaintext_bytes -=
                selected.node.subtree_plaintext_bytes;
            mem.next_job_id += 1;
            Map.add(mem.delete_jobs, Nat64.compare, jobId, job);
            Accounting.addPhysical(mem, Accounting.cleanupJobCharge(job));
            let remaining = remainingCleanupBudget(admissionPage);
            let pageResult = if (cleanupBudgetOpen(remaining)) {
                advanceOldestJob(?jobId, remaining)
            } else #ok(emptyCleanupPage());
            let #ok(page) = pageResult else {
                Runtime.trap("newly validated cleanup job failed");
            };
            let cleanupState = cleanupSummary().state;
            let receipt : Memory.PrivateReceipt = {
                dummyReceipt with
                outcome = #remove({
                    request_id = request.request_id;
                    node_id = request.node_id;
                    detached_plaintext_bytes = Nat64.fromNat(
                        selected.node.subtree_plaintext_bytes
                    );
                    reclaimed_entries = page.reclaimed_entries;
                    reclaimed_ciphertext_bytes =
                        page.reclaimed_ciphertext_bytes;
                    cleanup_state =
                        storedCleanupState(cleanupState);
                    cleanup_job_id =
                        if (
                            Map.get(mem.delete_jobs, Nat64.compare, jobId) ==
                                null
                        ) null else ?jobId;
                });
            };
            insertPrivateReceipt(request.request_id, receipt);
            #ok({
                request_id = request.request_id;
                node_id = request.node_id;
                detached_plaintext_bytes = Nat64.fromNat(
                    selected.node.subtree_plaintext_bytes
                );
                reclaimed_entries = page.reclaimed_entries;
                reclaimed_ciphertext_bytes =
                    page.reclaimed_ciphertext_bytes;
                cleanup_state = cleanupState;
            });
        };
        func abortImpl(
            request : Types.AbortRequest
        ) : Types.Result<Types.AbortOk> {
            if (
                request.request_id == Types.ROOT_NODE_ID or
                request.stage_id == 0
            ) {
                return #err(Types.reject(#invalid_request));
            };
            let fingerprint = Fingerprint.abort(request);
            switch (
                Map.get(
                    mem.private_receipts,
                    Keys.compareId128,
                    request.request_id,
                )
            ) {
                case (?receipt) {
                    if (
                        receipt.expires_at_ns > nowNs()
                    ) switch (receipt.outcome) {
                        case (#expired(value)) {
                            if (
                                value.request_id != request.request_id or
                                value.stage_id != request.stage_id
                            ) return #err(Types.reject(#conflict));
                            return #err(Types.reject(#expired));
                        };
                        case (#abort(value)) {
                            if (
                                receipt.request_fingerprint != fingerprint
                            ) return #err(Types.reject(#conflict));
                            return #ok({
                                request_id = value.request_id;
                                stage_id = value.stage_id;
                                cleanup_state =
                                    publicCleanupState(
                                        value.cleanup_state
                                    );
                            });
                        };
                        case (_) return #err(
                            Types.reject(#conflict)
                        );
                    };
                };
                case null {};
            };
            let ?stored = Map.get(
                mem.stages,
                Nat64.compare,
                request.stage_id,
            ) else return #err(Types.reject(#not_found));
            switch (stored) {
                case (#private_write(stage)) {
                    if (
                        request.request_id != stage.request_id
                    ) return #err(Types.reject(#conflict));
                    if (stage.expires_at_ns <= nowNs()) {
                        let budget = fullCleanupBudget();
                        if (
                            cleanupInstructionHasHeadroom(
                                Types.PRIVATE_RETIRE_INSTRUCTION_RESERVE
                            ) and
                            privateStageFitsCleanupBudget(
                                stage,
                                budget,
                            )
                        ) {
                            ignore terminalizeExpiredPrivateStage(
                                request.stage_id,
                                stage,
                                budget,
                            );
                        };
                        return #err(Types.reject(#expired));
                    };
                    let at = nowNs();
                    let abortTargets =
                        privateStageReceiptTargets(stage);
                    let reservedReceipt : Memory.PrivateReceipt = {
                        request_fingerprint = fingerprint;
                        outcome = #abort({
                            request_id = request.request_id;
                            stage_id = request.stage_id;
                            nodes = abortTargets;
                            stage_kind = ?#private_write;
                            source_node_id = null;
                            source_content_id = null;
                            cleanup_state = ?#pending({
                                remaining_jobs = Nat16.fromNat(
                                    Types.MAX_CLEANUP_JOBS
                                );
                            });
                            cleanup_job_id = ?0;
                        });
                        completed_at_ns = at;
                        terminal_kind = ?#aborted;
                        expires_at_ns = deadline(
                            at,
                            Types.RECEIPT_RETENTION_NS,
                        );
                    };
                    let reservedReceiptCharge =
                        privateReceiptMaximumCharge(reservedReceipt);
                    let retirementBudget = fullCleanupBudget();
                    if (
                        not cleanupInstructionHasHeadroom(
                            Types.PRIVATE_RETIRE_INSTRUCTION_RESERVE
                        ) or
                        not privateStageFitsCleanupBudget(
                            stage,
                            retirementBudget,
                        )
                    ) return #err(Types.reject(#busy));
                    let retirement = retirePrivateStage(
                        request.stage_id,
                        stage,
                        reservedReceiptCharge,
                        retirementBudget,
                    );
                    let cleanupState = cleanupSummary().state;
                    let receipt : Memory.PrivateReceipt = {
                        reservedReceipt with
                        outcome = #abort({
                            request_id = request.request_id;
                            stage_id = request.stage_id;
                            nodes = abortTargets;
                            stage_kind = ?#private_write;
                            source_node_id = null;
                            source_content_id = null;
                            cleanup_state =
                                storedCleanupState(cleanupState);
                            cleanup_job_id =
                                retirement.cleanup_job_id;
                        });
                    };
                    let receiptCharge =
                        privateReceiptInsertionCharge(receipt);
                    if (receiptCharge > reservedReceiptCharge) {
                        Runtime.trap("abort receipt reservation invariant");
                    };
                    insertPrivateReceipt(
                        request.request_id,
                        receipt,
                    );
                    #ok({
                        request_id = request.request_id;
                        stage_id = request.stage_id;
                        cleanup_state = cleanupState;
                    });
                };
                case (#public_share(_)) {
                    #err(Types.reject(#incompatible));
                };
            };
        };
        func cleanupImpl() : Types.Result<Types.CleanupOk> {
            if (Map.size(mem.delete_jobs) > 65_535) {
                return #err(Types.reject(#corrupt_state));
            };
            let privateResult = advancePrivateCleanupPage();
            let #ok(page) = privateResult else {
                let #err(error) = privateResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let remaining = Map.size(mem.delete_jobs);
            #ok({
                reclaimed_entries = page.reclaimed_entries;
                reclaimed_ciphertext_bytes =
                    page.reclaimed_ciphertext_bytes;
                reclaimed_charged_bytes =
                    page.reclaimed_charged_bytes;
                remaining_jobs = Nat16.fromNat(remaining);
                has_more = hasEligibleCleanup();
            });
        };

        func advancePrivateCleanupPage() : Types.Result<CleanupPage> {
            advancePrivateCleanupWithin(fullCleanupBudget());
        };

        func advancePrivateMutationAdmissionWithin(
            budget : CleanupBudget,
            requestId : ?Types.Id128,
        ) : Types.Result<CleanupPage> {
            let cleanupResult =
                if (cleanupBudgetOpen(budget)) {
                    advancePrivateCleanupWithin(budget)
                } else #ok(emptyCleanupPage());
            let #ok(page) = cleanupResult else {
                let #err(error) = cleanupResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            switch (requestId) {
                case null {};
                case (?value) switch (
                    ensureExpiredPrivateReceiptConsumed(value)
                ) {
                    case (#err(error)) return #err(error);
                    case (#ok) {};
                };
            };
            #ok(page);
        };

        func advancePrivateCleanupWithin(
            budget : CleanupBudget
        ) : Types.Result<CleanupPage> {
            let stagePage = if (cleanupBudgetOpen(budget)) {
                expireDuePrivateStage(budget)
            } else emptyCleanupPage();
            let afterStage = remainingCleanupBudgetWithin(
                budget,
                stagePage,
            );
            let jobResult = if (cleanupBudgetOpen(afterStage)) {
                advanceCleanupJobs(afterStage)
            } else #ok(emptyCleanupPage());
            let #ok(jobPage) = jobResult else {
                let #err(error) = jobResult else {
                    return #err(Types.reject(#corrupt_state));
                };
                return #err(error);
            };
            let throughJobs = mergeCleanupPages(stagePage, jobPage);
            let afterJob = remainingCleanupBudgetWithin(
                budget,
                throughJobs,
            );
            let privatePage = if (cleanupBudgetOpen(afterJob)) {
                prunePrivateReceiptRows(
                    afterJob.entries,
                    afterJob.work_units,
                )
            } else emptyCleanupPage();
            #ok(mergeCleanupPages(throughJobs, privatePage));
        };
        func operationStatusImpl(
            request : Types.OperationStatusRequest
        ) : Types.Result<Types.OperationStatusOk> {
            let at = nowNs();
            let ?target = request.target else {
                return #err(Types.reject(#invalid_request));
            };
            if (
                request.request_id == Types.ROOT_NODE_ID or
                not validOperationTarget(target)
            ) {
                return #err(Types.reject(#invalid_request));
            };
            switch (
                Map.get(
                    mem.stages_by_request,
                    Keys.compareId128,
                    request.request_id,
                )
            ) {
                case (?stageId) {
                    let ?stage = Map.get(
                        mem.stages,
                        Nat64.compare,
                        stageId,
                    ) else return #err(
                        Types.reject(#corrupt_state)
                    );
                    switch (stage) {
                        case (#private_write(value)) {
                            if (
                                value.request_id != request.request_id
                            ) return #err(
                                Types.reject(#corrupt_state)
                            );
                            if (value.expires_at_ns <= at) {
                                let reconcileUntil = deadline(
                                    value.expires_at_ns,
                                    Types.RECEIPT_RETENTION_NS,
                                );
                                if (reconcileUntil <= at) {
                                    return #ok({
                                        request_id =
                                            request.request_id;
                                        target = request.target;
                                        state = ?#unknown;
                                        cleanup_state =
                                        cleanupSummary().state;
                                    });
                                };
                                if (
                                    not privateTargetMatches(
                                        target,
                                        value,
                                    ) and
                                    not privateAbortTargetMatches(
                                        target,
                                        stageId,
                                    )
                                ) return #err(
                                    Types.reject(#conflict)
                                );
                                return #ok({
                                    request_id = request.request_id;
                                    target = request.target;
                                    state = ?#expired({
                                        terminal_at_ns =
                                            value.expires_at_ns;
                                        reconcile_until_ns = deadline(
                                            value.expires_at_ns,
                                            Types.RECEIPT_RETENTION_NS,
                                        );
                                    });
                                    cleanup_state =
                                    cleanupSummary().state;
                                });
                            };
                            if (
                                privateTargetMatches(target, value)
                            ) return #ok({
                                request_id = request.request_id;
                                target = request.target;
                                state = ?#active(
                                    privateActiveState(stageId, value)
                                );
                                cleanup_state =
                                    cleanupSummary().state;
                            });
                            if (
                                privateAbortTargetMatches(
                                    target,
                                    stageId,
                                )
                            ) return #ok({
                                request_id = request.request_id;
                                target = request.target;
                                state = ?#unknown;
                                cleanup_state =
                                    cleanupSummary().state;
                            });
                            return #err(Types.reject(#conflict));
                        };
                        case (#public_share(_)) {
                            return #err(Types.reject(#incompatible));
                        };
                    };
                };
                case null {};
            };
            switch (
                Map.get(
                    mem.private_receipts,
                    Keys.compareId128,
                    request.request_id,
                )
            ) {
                case (?receipt) {
                    if (receipt.expires_at_ns > at) {
                        switch (receipt.outcome) {
                            case (#expired(value)) {
                                if (
                                    value.request_id != request.request_id
                                ) return #err(
                                    Types.reject(#corrupt_state)
                                );
                                let matches = switch (target) {
                                    case (#private_write(binding)) {
                                        binding.nodes == value.nodes
                                    };
                                    case (#abort(_)) {
                                        privateAbortTargetMatches(
                                            target,
                                            value.stage_id,
                                        )
                                    };
                                    case (_) false;
                                };
                                if (not matches) return #err(
                                    Types.reject(#conflict)
                                );
                                return #ok({
                                    request_id = request.request_id;
                                    target = request.target;
                                    state = ?#expired({
                                        terminal_at_ns =
                                            receipt.completed_at_ns;
                                        reconcile_until_ns =
                                            receipt.expires_at_ns;
                                    });
                                    cleanup_state =
                                        cleanupSummary().state;
                                });
                            };
                            case (#abort(value)) {
                                if (
                                    value.request_id !=
                                        request.request_id
                                ) return #err(
                                    Types.reject(#corrupt_state)
                                );
                                switch (target) {
                                    case (#private_write(binding)) {
                                        if (binding.nodes != value.nodes) {
                                            return #err(
                                                Types.reject(#conflict)
                                            );
                                        };
                                        return #ok({
                                            request_id =
                                                request.request_id;
                                            target = request.target;
                                            state = ?#aborted({
                                                terminal_at_ns =
                                                    receipt.completed_at_ns;
                                                reconcile_until_ns =
                                                    receipt.expires_at_ns;
                                            });
                                            cleanup_state =
                                                cleanupSummary().state;
                                        });
                                    };
                                    case (#abort(binding)) {
                                        if (
                                            not privateAbortTargetMatches(
                                                target,
                                                value.stage_id,
                                            )
                                        ) return #err(
                                            Types.reject(#conflict)
                                        );
                                        let abortFingerprint =
                                            Fingerprint.abort({
                                                request_id =
                                                    request.request_id;
                                                stage_id =
                                                    binding.stage_id;
                                            });
                                        if (
                                            receipt.request_fingerprint !=
                                                abortFingerprint
                                        ) return #err(
                                            Types.reject(#conflict)
                                        );
                                        return #ok({
                                            request_id =
                                                request.request_id;
                                            target = request.target;
                                            state = ?#committed({
                                                detail = ?#abort({
                                                    request_id =
                                                        request.request_id;
                                                    stage_id =
                                                        value.stage_id;
                                                    cleanup_state =
                                                        publicCleanupState(
                                                            value.cleanup_state
                                                        );
                                                })
                                            });
                                            cleanup_state =
                                                cleanupSummary().state;
                                        });
                                    };
                                    case (_) return #err(
                                        Types.reject(#conflict)
                                    );
                                };
                            };
                            case (_) {};
                        };
                        let detail = receiptDetail(receipt, target);
                        let #ok(value) = detail else {
                            let #err(error) = detail else {
                                return #err(
                                    Types.reject(#corrupt_state)
                                );
                            };
                            return #err(error);
                        };
                        let state : Types.OperationState = switch (
                            receipt.terminal_kind
                        ) {
                            case (?_) return #err(
                                Types.reject(#corrupt_state)
                            );
                            case null #committed({ detail = ?value });
                        };
                        return #ok({
                            request_id = request.request_id;
                            target = request.target;
                            state = ?state;
                            cleanup_state = cleanupSummary().state;
                        });
                    };
                };
                case null {};
            };
            #ok({
                request_id = request.request_id;
                target = request.target;
                state = ?#unknown;
                cleanup_state = cleanupSummary().state;
            });
        };
        type CleanupPage = {
            reclaimed_entries : Nat16;
            // Stable rows visited against the entry budget. This can exceed
            // reclaimed_entries when a shared receipt-owner row is decremented
            // but remains live.
            entry_units : Nat16;
            reclaimed_blocks : Nat8;
            reclaimed_ciphertext_bytes : Nat64;
            reclaimed_charged_bytes : Nat64;
            work_units : Nat16;
        };

        type LifecycleAdvance = {
            reclaimed_entries : Nat;
            entry_units : Nat;
        };

        type CleanupBudget = {
            entries : Nat;
            blocks : Nat;
            ciphertext_bytes : Nat;
            work_units : Nat;
        };

        func fullCleanupBudget() : CleanupBudget {
            cleanupInstructionStart := performanceCounter();
            cleanupBudgetLimits();
        };

        func cleanupBudgetLimits() : CleanupBudget {
            {
                entries = Types.MAX_CLEANUP_ENTRIES_PER_PAGE;
                blocks = Types.MAX_CLEANUP_BLOCKS_PER_PAGE;
                ciphertext_bytes =
                    Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE;
                work_units =
                    Types.MAX_CLEANUP_WORK_UNITS_PER_PAGE;
            };
        };

        func cleanupBudgetOpen(budget : CleanupBudget) : Bool {
            budget.entries > 0 and budget.blocks > 0 and
            budget.ciphertext_bytes > 0 and budget.work_units > 0 and
            cleanupInstructionOpen();
        };

        func cleanupInstructionOpen() : Bool {
            let current = performanceCounter();
            current >= cleanupInstructionStart and
            current - cleanupInstructionStart <
                Types.MAX_CLEANUP_INSTRUCTIONS_PER_PAGE;
        };

        func cleanupInstructionHasHeadroom(
            needed : Nat64
        ) : Bool {
            if (
                needed > Types.MAX_CLEANUP_INSTRUCTIONS_PER_PAGE
            ) return false;
            let current = performanceCounter();
            current >= cleanupInstructionStart and
            current - cleanupInstructionStart <=
                Types.MAX_CLEANUP_INSTRUCTIONS_PER_PAGE - needed;
        };

        func expireDuePrivateStage(
            budget : CleanupBudget
        ) : CleanupPage {
            let at = nowNs();
            let candidates = List.empty<(Nat64, Memory.PrivateStage)>();
            for ((stageId, stored) in Map.entries(mem.stages)) {
                switch (stored) {
                    case (#private_write(stage)) if (
                        stage.expires_at_ns <= at
                    ) {
                        List.add(candidates, (stageId, stage));
                    };
                    case (_) {};
                };
            };
            var page = emptyCleanupPage();
            label expiry for ((stageId, stage) in
                List.toArray(candidates).values()) {
                let remaining = remainingCleanupBudgetWithin(
                    budget,
                    page,
                );
                if (
                    not cleanupInstructionHasHeadroom(
                        Types.PRIVATE_RETIRE_INSTRUCTION_RESERVE
                    ) or
                    not privateStageFitsCleanupBudget(
                        stage,
                        remaining,
                    )
                ) break expiry;
                let retirement = terminalizeExpiredPrivateStage(
                    stageId,
                    stage,
                    remaining,
                );
                if (
                    retirement.reclaimed_entries >
                        remaining.entries or
                    retirement.entry_units > remaining.entries or
                    retirement.reclaimed_blocks >
                        remaining.blocks or
                    retirement.reclaimed_ciphertext_bytes >
                        remaining.ciphertext_bytes or
                    retirement.work_units > remaining.work_units
                ) Runtime.trap(
                    "private expiry cleanup budget invariant"
                );
                page := mergeCleanupPages(
                    page,
                    cleanupPageWithEntryUnits(
                        retirement.reclaimed_entries,
                        retirement.entry_units,
                        retirement.reclaimed_blocks,
                        retirement.reclaimed_ciphertext_bytes,
                        retirement.reclaimed_charged_bytes,
                        retirement.work_units,
                    ),
                );
            };
            page;
        };

        func privateStageFitsCleanupBudget(
            stage : Memory.PrivateStage,
            budget : CleanupBudget,
        ) : Bool {
            var blocks = 0;
            var ciphertext = 0;
            for (frame in stage.frames.values()) {
                if (bitmapHas(stage.accepted_frame_bitmap, frame.ordinal)) {
                    for (block in frame.blocks.values()) {
                        blocks += 1;
                        ciphertext += Nat32.toNat(
                            block.ciphertext_bytes
                        );
                    };
                };
            };
            let identityRows =
                ReceiptOwnership.stage(stage).row_ids.size();
            let allSynchronous =
                blocks <= budget.blocks and
                blocks + 4 + identityRows <= budget.entries and
                ciphertext <= budget.ciphertext_bytes and
                blocks * 2 + 5 + identityRows <= budget.work_units;
            let deferred =
                stage.reserved_cleanup_jobs != 0 and
                5 + identityRows <= budget.entries and
                blocks + 6 + identityRows <= budget.work_units;
            (allSynchronous or deferred) and
            cleanupInstructionHasHeadroom(
                Types.PRIVATE_RETIRE_INSTRUCTION_RESERVE
            );
        };

        func advanceCleanupJobs(
            budget : CleanupBudget
        ) : Types.Result<CleanupPage> {
            var page = emptyCleanupPage();
            var remaining = budget;
            var keepGoing = true;
            while (
                keepGoing and Map.size(mem.delete_jobs) > 0 and
                cleanupBudgetOpen(remaining)
            ) {
                let result = advanceOldestJob(null, remaining);
                let #ok(next) = result else {
                    let #err(error) = result else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    return #err(error);
                };
                page := mergeCleanupPages(page, next);
                remaining := remainingCleanupBudgetWithin(
                    budget,
                    page,
                );
                if (
                    next.reclaimed_entries == 0 and
                    next.reclaimed_blocks == 0 and
                    next.reclaimed_ciphertext_bytes == 0
                ) {
                    keepGoing := false;
                };
            };
            #ok(page);
        };

        func hasEligibleCleanup() : Bool {
            if (Map.size(mem.delete_jobs) > 0) return true;
            if (
                Map.size(mem.stages) == 0 and
                Map.size(mem.private_receipts_by_expiry) == 0
            ) return false;
            let at = nowNs();
            for ((_, stored) in Map.entries(mem.stages)) {
                switch (stored) {
                    case (#private_write(stage)) if (
                        stage.expires_at_ns <= at
                    ) return true;
                    case (_) {};
                };
            };
            switch (Map.entries(mem.private_receipts_by_expiry).next()) {
                case (?(key, _)) if (key.0 <= at) return true;
                case (_) {};
            };
            false;
        };

        func emptyCleanupPage() : CleanupPage {
            {
                reclaimed_entries = 0;
                entry_units = 0;
                reclaimed_blocks = 0;
                reclaimed_ciphertext_bytes = 0;
                reclaimed_charged_bytes = 0;
                work_units = 0;
            };
        };

        func remainingCleanupBudget(page : CleanupPage) : CleanupBudget {
            remainingCleanupBudgetWithin(cleanupBudgetLimits(), page);
        };

        func remainingCleanupBudgetWithin(
            budget : CleanupBudget,
            page : CleanupPage,
        ) : CleanupBudget {
            let entries = Nat16.toNat(page.entry_units);
            let blocks = Nat8.toNat(page.reclaimed_blocks);
            let ciphertext =
                Nat64.toNat(page.reclaimed_ciphertext_bytes);
            let work = Nat16.toNat(page.work_units);
            if (
                entries > budget.entries or
                blocks > budget.blocks or
                ciphertext > budget.ciphertext_bytes or
                work > budget.work_units
            ) Runtime.trap("cleanup budget invariant");
            {
                entries = budget.entries - entries;
                blocks = budget.blocks - blocks;
                ciphertext_bytes =
                    budget.ciphertext_bytes - ciphertext;
                work_units = budget.work_units - work;
            };
        };

        func mergeCleanupPages(
            left : CleanupPage,
            right : CleanupPage,
        ) : CleanupPage {
            cleanupPageWithEntryUnits(
                Nat16.toNat(left.reclaimed_entries) +
                    Nat16.toNat(right.reclaimed_entries),
                Nat16.toNat(left.entry_units) +
                    Nat16.toNat(right.entry_units),
                Nat8.toNat(left.reclaimed_blocks) +
                    Nat8.toNat(right.reclaimed_blocks),
                Nat64.toNat(left.reclaimed_ciphertext_bytes) +
                    Nat64.toNat(right.reclaimed_ciphertext_bytes),
                Nat64.toNat(left.reclaimed_charged_bytes) +
                    Nat64.toNat(right.reclaimed_charged_bytes),
                Nat16.toNat(left.work_units) +
                    Nat16.toNat(right.work_units),
            );
        };

        func advanceOldestJob(
            preferred : ?Nat64,
            budget : CleanupBudget,
        ) : Types.Result<CleanupPage> {
            let selected = switch (preferred) {
                case (?jobId) switch (
                    Map.get(mem.delete_jobs, Nat64.compare, jobId)
                ) {
                    case (?job) ?(jobId, job);
                    case null return #err(
                        Types.reject(#corrupt_state)
                    );
                };
                case null Map.entries(mem.delete_jobs).next();
            };
            let ?(jobId, job) = selected else {
                return #ok(emptyCleanupPage());
            };
            if (job.job_id != jobId) {
                return #err(Types.reject(#corrupt_state));
            };
            switch (job.kind) {
                case (#subtree(value)) {
                    advanceSubtreeJob(jobId, job, value, budget);
                };
                case (#contents(value)) {
                    advanceContentsJob(jobId, job, value, budget);
                };
                case (#private_stage(value)) {
                    advancePrivateStageJob(jobId, job, value, budget);
                };
                case (#orphan_blocks(value)) {
                    advanceOrphanJob(jobId, job, value, budget);
                };
            };
        };

        func advanceSubtreeJob(
            jobId : Nat64,
            job : Memory.DeleteJob,
            state : {
                root_id : Types.Id128;
                stack : [Memory.CleanupWalkFrame];
            },
            budget : CleanupBudget,
        ) : Types.Result<CleanupPage> {
            var stack = state.stack;
            var entries = 0;
            var blocks = 0;
            var ciphertext = 0;
            var work = 0;
            let physicalBefore = mem.physical_private_bytes;
            label page while (
                stack.size() > 0 and
                entries < budget.entries and
                work < budget.work_units and
                cleanupInstructionOpen()
            ) {
                work += 1;
                let topIndex = stack.size() - 1;
                let frame = stack[topIndex];
                let ?node = Map.get(
                    mem.nodes_by_id,
                    Keys.compareId128,
                    frame.node_id,
                ) else Runtime.trap("cleanup node index invariant");
                if (not frame.entered) {
                    stack := replaceStackTop(stack, {
                        frame with entered = true
                    });
                    continue page;
                };
                switch (nextCleanupChild(frame.node_id, frame.after_child_tag)) {
                    case (?child) {
                        stack := replaceStackTop(stack, {
                            frame with
                            after_child_tag = ?child.node.name_tag
                        });
                        stack := pushStack(stack, {
                            node_id = child.node_id;
                            after_child_tag = null;
                            entered = false;
                        });
                        if (
                            stack.size() >
                                Nat8.toNat(Types.MAX_TREE_DEPTH) + 1
                        ) Runtime.trap("cleanup tree depth invariant");
                        continue page;
                    };
                    case null {};
                };
                let content = Tree.content(node);
                let blockCount = switch (content) {
                    case null 0;
                    case (?value) Nat32.toNat(value.block_count);
                };
                if (blockCount > Types.MAX_BLOCKS_PER_FILE) {
                    Runtime.trap("cleanup content geometry invariant");
                };
                if (
                    work + blockCount + 2 >
                        budget.work_units
                ) break page;
                work += blockCount + 2;
                var bodyBytes = 0;
                switch (content) {
                    case null {};
                    case (?value) {
                        var index = 0;
                        while (index < blockCount) {
                            let key = Keys.blockKey(
                                value.content_id,
                                Nat32.fromNat(index),
                            );
                            let ?body = Map.get(
                                mem.blocks,
                                Keys.compareBlockKey,
                                key,
                            ) else Runtime.trap(
                                "cleanup block index invariant"
                            );
                            bodyBytes += body.size();
                            index += 1;
                        };
                    };
                };
                if (
                    bodyBytes >
                        Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE
                ) Runtime.trap("cleanup content size invariant");
                switch (content) {
                    case null {};
                    case (?value) if (
                        value.ciphertext_bytes != bodyBytes
                    ) Runtime.trap("cleanup ciphertext total invariant");
                };
                let edgeKey = Keys.childNameKey(
                    node.parent_id,
                    node.name_tag,
                );
                let edge = Map.get(
                    mem.children_by_name,
                    Keys.compareChildNameKey,
                    edgeKey,
                );
                let edgePresent = if (frame.node_id == state.root_id) {
                    if (edge != null) {
                        Runtime.trap("cleanup detached-root index invariant");
                    };
                    false;
                } else {
                    if (edge != ?frame.node_id) {
                        Runtime.trap("cleanup child index invariant");
                    };
                    true;
                };
                let required =
                    1 + blockCount + (if (edgePresent) 1 else 0);
                if (
                    entries + required > budget.entries or
                    blocks + blockCount > budget.blocks or
                    ciphertext + bodyBytes >
                        budget.ciphertext_bytes
                ) break page;
                let committedCiphertext =
                    bodyBytes + node.encrypted_metadata.size();
                if (
                    mem.committed_ciphertext_bytes <
                        committedCiphertext
                ) Runtime.trap(
                    "cleanup committed ciphertext invariant"
                );
                if (mem.node_count == 0) {
                    Runtime.trap("cleanup node counter invariant");
                };
                switch (content) {
                    case null {};
                    case (?value) {
                        var index = 0;
                        while (index < blockCount) {
                            let key = Keys.blockKey(
                                value.content_id,
                                Nat32.fromNat(index),
                            );
                            let ?body = Map.get(
                                mem.blocks,
                                Keys.compareBlockKey,
                                key,
                            ) else Runtime.trap(
                                "cleanup block index invariant"
                            );
                            ignore Map.remove(
                                mem.blocks,
                                Keys.compareBlockKey,
                                key,
                            );
                            let charge = Accounting.blockCharge(body.size());
                            Accounting.removePhysical(mem, charge);
                            ciphertext += body.size();
                            entries += 1;
                            blocks += 1;
                            index += 1;
                        };
                    };
                };
                if (edgePresent) {
                    ignore Map.remove(
                        mem.children_by_name,
                        Keys.compareChildNameKey,
                        edgeKey,
                    );
                    Accounting.removePhysical(
                        mem,
                        Accounting.childIndexCharge(),
                    );
                    entries += 1;
                };
                ignore Map.remove(
                    mem.nodes_by_id,
                    Keys.compareId128,
                    frame.node_id,
                );
                let nodeCharge = Accounting.nodeCharge(node);
                Accounting.removePhysical(mem, nodeCharge);
                entries += 1;
                mem.node_count -= 1;
                mem.committed_ciphertext_bytes -=
                    committedCiphertext;
                stack := popStack(stack);
            };
            let logicalFinished = stack.size() == 0;
            let replacement : Memory.DeleteJob = {
                job with
                kind = #subtree({
                    root_id = state.root_id;
                    stack;
                });
                updated_at_ns = nowNs();
                reclaimed_entries = job.reclaimed_entries + entries;
                reclaimed_ciphertext_bytes =
                    job.reclaimed_ciphertext_bytes + ciphertext;
            };
            let removedJob = finishJobPage(
                jobId,
                job,
                replacement,
                logicalFinished and entries < budget.entries and
                    work < budget.work_units,
            );
            if (removedJob) work += 1;
            let totalEntries = entries + (if (removedJob) 1 else 0);
            let physicalAfter = mem.physical_private_bytes;
            let reclaimedCharge = if (physicalBefore >= physicalAfter) {
                physicalBefore - physicalAfter;
            } else 0;
            #ok(cleanupPage(
                totalEntries,
                blocks,
                ciphertext,
                reclaimedCharge,
                work,
            ));
        };

        func advanceContentsJob(
            jobId : Nat64,
            job : Memory.DeleteJob,
            state : {
                contents : [{
                    content_id : Types.Id128;
                    next_block_index : Nat32;
                    block_count : Nat32;
                }];
                current_content : Nat8;
            },
            budget : CleanupBudget,
        ) : Types.Result<CleanupPage> {
            var contents = state.contents;
            var current = Nat8.toNat(state.current_content);
            var entries = 0;
            var blocks = 0;
            var ciphertext = 0;
            var work = 0;
            let physicalBefore = mem.physical_private_bytes;
            if (current > contents.size() or contents.size() > 256) {
                Runtime.trap("cleanup content cursor invariant");
            };
            label page while (
                current < contents.size() and
                entries < budget.entries and
                blocks < budget.blocks and
                work < budget.work_units and
                cleanupInstructionOpen()
            ) {
                work += 1;
                let descriptor = contents[current];
                if (descriptor.next_block_index > descriptor.block_count) {
                    Runtime.trap("cleanup block cursor invariant");
                };
                if (descriptor.next_block_index == descriptor.block_count) {
                    current += 1;
                    continue page;
                };
                let key = Keys.blockKey(
                    descriptor.content_id,
                    descriptor.next_block_index,
                );
                let ?body = Map.get(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                ) else Runtime.trap("cleanup block index invariant");
                if (
                    body.size() >
                        Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE
                ) Runtime.trap("cleanup block size invariant");
                if (
                    entries + 1 > budget.entries or
                    blocks + 1 > budget.blocks or
                    ciphertext + body.size() >
                        budget.ciphertext_bytes
                ) break page;
                ignore Map.remove(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                );
                let charge = Accounting.blockCharge(body.size());
                Accounting.removePhysical(mem, charge);
                ciphertext += body.size();
                entries += 1;
                blocks += 1;
                contents := replaceContentCursor(
                    contents,
                    current,
                    {
                        descriptor with
                        next_block_index =
                            descriptor.next_block_index + 1
                    },
                );
            };
            while (
                current < contents.size() and
                contents[current].next_block_index ==
                    contents[current].block_count and
                work < budget.work_units and
                cleanupInstructionOpen()
            ) {
                current += 1;
                work += 1;
            };
            if (
                current < contents.size() and
                contents[current].next_block_index >
                    contents[current].block_count
            ) Runtime.trap("cleanup block cursor invariant");
            let finished = current >= contents.size();
            if (not finished and current > 255) {
                Runtime.trap("cleanup content cursor invariant");
            };
            let replacement : Memory.DeleteJob = {
                job with
                kind = #contents({
                    contents;
                    current_content =
                        if (finished) 0 else Nat8.fromNat(current);
                });
                updated_at_ns = nowNs();
                reclaimed_entries = job.reclaimed_entries + entries;
                reclaimed_ciphertext_bytes =
                    job.reclaimed_ciphertext_bytes + ciphertext;
            };
            let removedJob = finishJobPage(
                jobId,
                job,
                replacement,
                finished and entries < budget.entries and
                    work < budget.work_units,
            );
            if (removedJob) work += 1;
            let totalEntries = entries + (if (removedJob) 1 else 0);
            let physicalAfter = mem.physical_private_bytes;
            let reclaimedCharge = if (physicalBefore >= physicalAfter) {
                physicalBefore - physicalAfter;
            } else 0;
            #ok(cleanupPage(
                totalEntries,
                blocks,
                ciphertext,
                reclaimedCharge,
                work,
            ));
        };

        func advancePrivateStageJob(
            jobId : Nat64,
            job : Memory.DeleteJob,
            state : {
                blocks : [Memory.BlockKey];
                next_block : Nat32;
            },
            budget : CleanupBudget,
        ) : Types.Result<CleanupPage> {
            var next = Nat32.toNat(state.next_block);
            var entries = 0;
            var blocks = 0;
            var ciphertext = 0;
            var work = 0;
            let physicalBefore = mem.physical_private_bytes;
            if (
                next > state.blocks.size() or
                state.blocks.size() > Types.MAX_BATCH_BLOCKS
            ) Runtime.trap("cleanup stage cursor invariant");
            label page while (
                next < state.blocks.size() and
                entries < budget.entries and
                blocks < budget.blocks and
                work < budget.work_units and
                cleanupInstructionOpen()
            ) {
                work += 1;
                let key = state.blocks[next];
                let ?body = Map.get(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                ) else Runtime.trap("cleanup stage block invariant");
                if (
                    body.size() >
                        Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE
                ) Runtime.trap("cleanup block size invariant");
                if (
                    entries + 1 > budget.entries or
                    blocks + 1 > budget.blocks or
                    ciphertext + body.size() >
                        budget.ciphertext_bytes
                ) break page;
                ignore Map.remove(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                );
                if (mem.staged_ciphertext_bytes < body.size()) {
                    Runtime.trap("cleanup stage staged counter invariant");
                };
                mem.staged_ciphertext_bytes -= body.size();
                let charge = Accounting.blockCharge(body.size());
                Accounting.removePhysical(mem, charge);
                ciphertext += body.size();
                entries += 1;
                blocks += 1;
                next += 1;
            };
            let finished = next >= state.blocks.size();
            let replacement : Memory.DeleteJob = {
                job with
                kind = #private_stage({
                    blocks = state.blocks;
                    next_block = Nat32.fromNat(next);
                });
                updated_at_ns = nowNs();
                reclaimed_entries = job.reclaimed_entries + entries;
                reclaimed_ciphertext_bytes =
                    job.reclaimed_ciphertext_bytes + ciphertext;
            };
            let removedJob = finishJobPage(
                jobId,
                job,
                replacement,
                finished and entries < budget.entries and
                    work < budget.work_units,
            );
            if (removedJob) work += 1;
            let totalEntries = entries + (if (removedJob) 1 else 0);
            let physicalAfter = mem.physical_private_bytes;
            let reclaimedCharge = if (physicalBefore >= physicalAfter) {
                physicalBefore - physicalAfter;
            } else 0;
            #ok(cleanupPage(
                totalEntries,
                blocks,
                ciphertext,
                reclaimedCharge,
                work,
            ));
        };

        func advanceOrphanJob(
            jobId : Nat64,
            job : Memory.DeleteJob,
            state : {
                content_id : Types.Id128;
                next_block_index : Nat32;
                block_count : Nat32;
            },
            budget : CleanupBudget,
        ) : Types.Result<CleanupPage> {
            var next = Nat32.toNat(state.next_block_index);
            let blockCount = Nat32.toNat(state.block_count);
            var entries = 0;
            var blocks = 0;
            var ciphertext = 0;
            var work = 0;
            let physicalBefore = mem.physical_private_bytes;
            if (
                next > blockCount or
                blockCount > Types.MAX_BLOCKS_PER_FILE
            ) Runtime.trap("cleanup orphan cursor invariant");
            label page while (
                next < blockCount and
                entries < budget.entries and
                blocks < budget.blocks and
                work < budget.work_units and
                cleanupInstructionOpen()
            ) {
                work += 1;
                let key = Keys.blockKey(
                    state.content_id,
                    Nat32.fromNat(next),
                );
                let ?body = Map.get(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                ) else Runtime.trap("cleanup orphan block invariant");
                if (
                    body.size() >
                        Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE
                ) Runtime.trap("cleanup block size invariant");
                if (
                    entries + 1 > budget.entries or
                    blocks + 1 > budget.blocks or
                    ciphertext + body.size() >
                        budget.ciphertext_bytes
                ) break page;
                ignore Map.remove(
                    mem.blocks,
                    Keys.compareBlockKey,
                    key,
                );
                Accounting.removePhysical(
                    mem,
                    Accounting.blockCharge(body.size()),
                );
                ciphertext += body.size();
                entries += 1;
                blocks += 1;
                next += 1;
            };
            let finished = next >= blockCount;
            let replacement : Memory.DeleteJob = {
                job with
                kind = #orphan_blocks({
                    content_id = state.content_id;
                    next_block_index = Nat32.fromNat(next);
                    block_count = state.block_count;
                });
                updated_at_ns = nowNs();
                reclaimed_entries = job.reclaimed_entries + entries;
                reclaimed_ciphertext_bytes =
                    job.reclaimed_ciphertext_bytes + ciphertext;
            };
            let removedJob = finishJobPage(
                jobId,
                job,
                replacement,
                finished and entries < budget.entries and
                    work < budget.work_units,
            );
            if (removedJob) work += 1;
            let totalEntries = entries + (if (removedJob) 1 else 0);
            let physicalAfter = mem.physical_private_bytes;
            let reclaimedCharge = if (physicalBefore >= physicalAfter) {
                physicalBefore - physicalAfter;
            } else 0;
            #ok(cleanupPage(
                totalEntries,
                blocks,
                ciphertext,
                reclaimedCharge,
                work,
            ));
        };

        func finishJobPage(
            jobId : Nat64,
            old : Memory.DeleteJob,
            replacement : Memory.DeleteJob,
            finished : Bool,
        ) : Bool {
            let oldCharge = Accounting.cleanupJobCharge(old);
            if (finished) {
                ignore Map.remove(mem.delete_jobs, Nat64.compare, jobId);
                Accounting.removePhysical(mem, oldCharge);
                true;
            } else {
                let newCharge = Accounting.cleanupJobCharge(replacement);
                Map.add(
                    mem.delete_jobs,
                    Nat64.compare,
                    jobId,
                    replacement,
                );
                if (newCharge >= oldCharge) {
                    Accounting.addPhysical(mem, newCharge - oldCharge);
                } else {
                    Accounting.removePhysical(mem, oldCharge - newCharge);
                };
                false;
            };
        };

        func nextCleanupChild(
            parentId : Types.Id128,
            after : ?Types.Digest256,
        ) : ?Tree.LocatedNode {
            let start = switch (after) {
                case null Types.ZERO_TAG;
                case (?tag) tag;
            };
            let iterator = Map.entriesFrom(
                mem.children_by_name,
                Keys.compareChildNameKey,
                Keys.childNameKey(parentId, start),
            );
            label selecting loop {
                let ?(key, nodeId) = iterator.next() else return null;
                if (Keys.childKeyParent(key) != parentId) return null;
                let tag = Keys.childKeyTag(key);
                switch (after) {
                    case (?prior) if (tag == prior) continue selecting;
                    case (_) {};
                };
                let ?node = Map.get(
                    mem.nodes_by_id,
                    Keys.compareId128,
                    nodeId,
                ) else Runtime.trap("cleanup dangling child index");
                if (
                    nodeId == Types.ROOT_NODE_ID or
                    node.parent_id != parentId or
                    node.name_tag != tag
                ) Runtime.trap("cleanup mismatched child index");
                return ?{ node_id = nodeId; node };
            };
            null;
        };

        func replaceStackTop(
            values : [Memory.CleanupWalkFrame],
            replacement : Memory.CleanupWalkFrame,
        ) : [Memory.CleanupWalkFrame] {
            Array.tabulate<Memory.CleanupWalkFrame>(
                values.size(),
                func(index) {
                    if (index + 1 == values.size()) replacement else {
                        values[index];
                    };
                },
            );
        };

        func pushStack(
            values : [Memory.CleanupWalkFrame],
            value : Memory.CleanupWalkFrame,
        ) : [Memory.CleanupWalkFrame] {
            Array.tabulate<Memory.CleanupWalkFrame>(
                values.size() + 1,
                func(index) {
                    if (index == values.size()) value else values[index];
                },
            );
        };

        func popStack(
            values : [Memory.CleanupWalkFrame]
        ) : [Memory.CleanupWalkFrame] {
            if (values.size() == 0) return [];
            Array.tabulate<Memory.CleanupWalkFrame>(
                values.size() - 1,
                func(index) { values[index] },
            );
        };

        func replaceContentCursor(
            values : [{
                content_id : Types.Id128;
                next_block_index : Nat32;
                block_count : Nat32;
            }],
            wanted : Nat,
            replacement : {
                content_id : Types.Id128;
                next_block_index : Nat32;
                block_count : Nat32;
            },
        ) : [{
            content_id : Types.Id128;
            next_block_index : Nat32;
            block_count : Nat32;
        }] {
            Array.tabulate(
                values.size(),
                func(index) {
                    if (index == wanted) replacement else values[index];
                },
            );
        };

        func cleanupPage(
            entries : Nat,
            blocks : Nat,
            ciphertext : Nat,
            charged : Nat,
            work : Nat,
        ) : CleanupPage {
            cleanupPageWithEntryUnits(
                entries,
                entries,
                blocks,
                ciphertext,
                charged,
                work,
            );
        };

        func cleanupPageWithEntryUnits(
            reclaimedEntries : Nat,
            entryUnits : Nat,
            blocks : Nat,
            ciphertext : Nat,
            charged : Nat,
            work : Nat,
        ) : CleanupPage {
            if (
                reclaimedEntries > entryUnits or
                entryUnits > Types.MAX_CLEANUP_ENTRIES_PER_PAGE or
                blocks > Types.MAX_CLEANUP_BLOCKS_PER_PAGE or
                ciphertext >
                    Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE or
                work > Types.MAX_CLEANUP_WORK_UNITS_PER_PAGE or
                charged > Nat64.toNat(Nat64.maxValue)
            ) Runtime.trap("cleanup page budget invariant");
            {
                reclaimed_entries = Nat16.fromNat(
                    reclaimedEntries
                );
                entry_units = Nat16.fromNat(entryUnits);
                reclaimed_blocks = Nat8.fromNat(blocks);
                reclaimed_ciphertext_bytes =
                    Nat64.fromNat(ciphertext);
                reclaimed_charged_bytes = Nat64.fromNat(charged);
                work_units = Nat16.fromNat(work);
            };
        };

        func storedCleanupState(
            value : ?Types.CleanupState
        ) : ?Memory.StoredCleanupState {
            value;
        };

        func publicCleanupState(
            value : ?Memory.StoredCleanupState
        ) : ?Types.CleanupState {
            value;
        };

        func freshPrivateMutationRequestId(
            requestId : Types.Id128
        ) : UnitResult {
            freshRequestIdAllowingExpiredPrivate(requestId, true);
        };

        func freshRequestId(requestId : Types.Id128) : UnitResult {
            freshRequestIdAllowingExpiredPrivate(requestId, false);
        };

        func freshRequestIdAllowingExpiredPrivate(
            requestId : Types.Id128,
            allowExpiredPrivate : Bool,
        ) : UnitResult {
            if (requestId == Types.ROOT_NODE_ID) {
                return #err(Types.reject(#invalid_request));
            };
            let privateOccupied = switch (
                Map.get(
                    mem.private_receipts,
                    Keys.compareId128,
                    requestId,
                )
            ) {
                case null false;
                case (?receipt) {
                    if (
                        allowExpiredPrivate and
                        receipt.expires_at_ns <= nowNs()
                    ) {
                        if (
                            Map.get(
                                mem.private_receipts_by_expiry,
                                Keys.comparePrivateReceiptExpiryKey,
                                (
                                    receipt.expires_at_ns,
                                    requestId.hi,
                                    requestId.lo,
                                ),
                            ) == null
                        ) return #err(
                            Types.reject(#corrupt_state)
                        );
                        false;
                    } else true;
                };
            };
            if (
                privateOccupied or
                Map.get(
                    mem.stages_by_request,
                    Keys.compareId128,
                    requestId,
                ) != null
            ) return #err(Types.reject(#conflict));
            #ok(());
        };

        func quota() : Types.Result<Types.QuotaSnapshot> {
            let ?nodes = nat64(mem.node_count) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?plain = nat64(mem.committed_private_plaintext_bytes) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?cipher = nat64(mem.committed_ciphertext_bytes) else {
                return #err(Types.reject(#corrupt_state));
            };
            let stagedNat =
                mem.staged_ciphertext_bytes +
                mem.reserved_staged_ciphertext_bytes;
            let ?staged = nat64(stagedNat) else {
                return #err(Types.reject(#corrupt_state));
            };
            let physicalNat =
                mem.physical_private_bytes +
                mem.reserved_physical_private_bytes;
            let ?physical = nat64(physicalNat) else {
                return #err(Types.reject(#corrupt_state));
            };
            let jobs = Map.size(mem.delete_jobs) + mem.reserved_cleanup_jobs;
            if (jobs > 65_535) {
                return #err(Types.reject(#corrupt_state));
            };
            #ok({
                nodes;
                committed_private_plaintext_bytes = plain;
                committed_ciphertext_bytes = cipher;
                staged_ciphertext_bytes = staged;
                physical_private_bytes = physical;
                cleanup_jobs = Nat16.fromNat(jobs);
            });
        };

        func cleanupSummary() : Types.CleanupSummary {
            let jobs = Map.size(mem.delete_jobs);
            let bounded = if (jobs > 65_535) 65_535 else jobs;
            let hasMore = hasEligibleCleanup();
            {
                remaining_jobs = Nat16.fromNat(bounded);
                has_more = hasMore;
                state = ?(
                    if (not hasMore) #clean else #pending({
                        remaining_jobs = Nat16.fromNat(bounded)
                    })
                );
            };
        };

        func validStageBitmap(bitmap : Blob, count : Nat) : Bool {
            let expectedBytes = (count + 7) / 8;
            if (bitmap.size() != expectedBytes) return false;
            let tailBits = count % 8;
            if (
                tailBits != 0 and
                Nat8.toNat(bitmap[expectedBytes - 1]) >= 2 ** tailBits
            ) return false;
            true;
        };

        // Bound every variable-size value that Accounting traverses before
        // deriving an exact active-stage reservation. Canonical commit-plan
        // validation is independent; these bounds make the reservation check
        // safe even when stable memory is malformed.
        func boundedPrivateReservationContent(
            content : Memory.ContentRecord
        ) : Bool {
            content.wrapped_content_key.size() <= 48;
        };

        func boundedPrivateReservationNode(node : Memory.Node) : Bool {
            if (
                node.encrypted_metadata.size() < 16 or
                node.encrypted_metadata.size() >
                    Types.MAX_METADATA_BYTES
            ) return false;
            switch (node.kind) {
                case (#file(file)) switch (file.active_content) {
                    case null true;
                    case (?content) {
                        boundedPrivateReservationContent(content);
                    };
                };
                case (#folder(folder)) {
                    folder.child_subtree_heights.size() <=
                        Nat8.toNat(Types.MAX_TREE_DEPTH) and
                    folder.child_relative_path_scalars.size() <=
                        Nat16.toNat(Types.MAX_PATH_SCALARS);
                };
            };
        };

        func validPrivatePlanContent(
            content : Memory.ContentRecord
        ) : Bool {
            let blockCount = Nat32.toNat(content.block_count);
            if (
                content.content_id == Types.ROOT_NODE_ID or
                content.wrapped_content_key.size() != 48 or
                blockCount == 0 or
                blockCount > Types.MAX_BLOCKS_PER_FILE or
                content.ciphertext_bytes >
                    Types.MAX_FILE_CIPHERTEXT_BYTES
            ) return false;
            let suffixCiphertext =
                (blockCount - 1) *
                (Types.MAX_PLAINTEXT_BLOCK_BYTES + 16);
            if (
                content.ciphertext_bytes < suffixCiphertext + 16 or
                content.ciphertext_bytes >
                    suffixCiphertext +
                    Types.MAX_PLAINTEXT_BLOCK_BYTES + 16 or
                (
                    blockCount > 1 and
                    content.ciphertext_bytes ==
                        suffixCiphertext + 16
                )
            ) return false;
            let ?plaintext = Tree.contentPlaintext(content) else {
                return false;
            };
            plaintext <= Types.MAX_FILE_PLAINTEXT_BYTES;
        };

        func privateFolderHeightCount(
            folder : Memory.FolderRecord,
            value : Nat8,
        ) : Nat {
            for (entry in folder.child_subtree_heights.values()) {
                if (entry.value == value) {
                    return Nat32.toNat(entry.count);
                };
            };
            0;
        };

        func privateFolderPathCount(
            folder : Memory.FolderRecord,
            value : Nat16,
        ) : Nat {
            for (
                entry in
                folder.child_relative_path_scalars.values()
            ) {
                if (entry.value == value) {
                    return Nat32.toNat(entry.count);
                };
            };
            0;
        };

        func validPrivatePlanFolder(
            nodeId : Types.Id128,
            node : Memory.Node,
            folder : Memory.FolderRecord,
        ) : Bool {
            if (
                folder.child_subtree_heights.size() >
                    Nat8.toNat(Types.MAX_TREE_DEPTH) or
                folder.child_relative_path_scalars.size() >
                    Nat16.toNat(Types.MAX_PATH_SCALARS)
            ) return false;
            let direct = Nat32.toNat(folder.direct_child_count);
            if (direct >= Types.MAX_NODES) return false;
            var heightTotal = 0;
            var previousHeight : ?Nat8 = null;
            for (entry in folder.child_subtree_heights.values()) {
                if (
                    entry.count == 0 or
                    entry.value >= Types.MAX_TREE_DEPTH
                ) return false;
                switch (previousHeight) {
                    case (?previous) if (
                        entry.value <= previous
                    ) return false;
                    case (_) {};
                };
                previousHeight := ?entry.value;
                heightTotal += Nat32.toNat(entry.count);
                if (heightTotal > direct) return false;
            };
            var pathTotal = 0;
            var previousPath : ?Nat16 = null;
            for (
                entry in
                folder.child_relative_path_scalars.values()
            ) {
                if (
                    entry.count == 0 or entry.value == 0 or
                    entry.value > Types.MAX_PATH_SCALARS
                ) return false;
                switch (previousPath) {
                    case (?previous) if (
                        entry.value <= previous
                    ) return false;
                    case (_) {};
                };
                previousPath := ?entry.value;
                pathTotal += Nat32.toNat(entry.count);
                if (pathTotal > direct) return false;
            };
            if (heightTotal != direct or pathTotal != direct) {
                return false;
            };
            if (direct == 0) {
                return folder.child_subtree_heights.size() == 0 and
                    folder.child_relative_path_scalars.size() == 0 and
                    node.subtree_height == 0 and
                    node.max_relative_path_scalars ==
                        (
                            if (nodeId == Types.ROOT_NODE_ID) {
                                (0 : Nat16);
                            } else node.declared_name_scalars
                        );
            };
            let ?maximumHeight = previousHeight else return false;
            let ?maximumPath = previousPath else return false;
            if (node.subtree_height != maximumHeight + 1) {
                return false;
            };
            if (nodeId == Types.ROOT_NODE_ID) {
                node.max_relative_path_scalars == maximumPath;
            } else {
                let expectedPath =
                    Nat16.toNat(node.declared_name_scalars) + 1 +
                    Nat16.toNat(maximumPath);
                expectedPath <=
                    Nat16.toNat(Types.MAX_PATH_SCALARS) and
                node.max_relative_path_scalars ==
                    Nat16.fromNat(expectedPath);
            };
        };

        func validPrivatePlanNode(
            nodeId : Types.Id128,
            node : Memory.Node,
        ) : Bool {
            switch (node.state) {
                case (#active) {};
                case (_) return false;
            };
            if (
                not boundedPrivateReservationNode(node) or
                node.structural_revision == 0 or
                node.metadata_revision == 0 or
                node.subtree_plaintext_bytes >
                    Types.MAX_PRIVATE_PLAINTEXT_BYTES or
                node.max_relative_path_scalars >
                    Types.MAX_PATH_SCALARS
            ) return false;
            if (nodeId == Types.ROOT_NODE_ID) {
                if (
                    node.parent_id != Types.ROOT_NODE_ID or
                    node.name_tag != Types.ZERO_TAG or
                    node.declared_name_scalars != 0
                ) return false;
            } else if (
                node.parent_id == nodeId or
                node.name_tag == Types.ZERO_TAG or
                node.declared_name_scalars == 0 or
                node.declared_name_scalars >
                    Types.MAX_NAME_SCALARS
            ) return false;
            switch (node.kind) {
                case (#file(file)) {
                    if (
                        nodeId == Types.ROOT_NODE_ID or
                        node.children_revision != 0 or
                        node.subtree_height != 0 or
                        node.max_relative_path_scalars !=
                            node.declared_name_scalars
                    ) return false;
                    let ?content = file.active_content else {
                        return false;
                    };
                    if (not validPrivatePlanContent(content)) {
                        return false;
                    };
                    let ?plaintext =
                        Tree.contentPlaintext(content) else {
                        return false;
                    };
                    node.subtree_plaintext_bytes == plaintext;
                };
                case (#folder(folder)) {
                    validPrivatePlanFolder(nodeId, node, folder);
                };
            };
        };

        func validPrivatePlanTransition(
            mutation : Memory.NodeMutation
        ) : Bool {
            let ?replacement = mutation.replacement else {
                return false;
            };
            if (
                not validPrivatePlanNode(
                    mutation.node_id,
                    replacement,
                )
            ) return false;
            switch (mutation.expected) {
                case null {
                    mutation.node_id != Types.ROOT_NODE_ID and
                    replacement.structural_revision == 1 and
                    replacement.metadata_revision == 1 and
                    replacement.children_revision == 0;
                };
                case (?expected) {
                    if (
                        not validPrivatePlanNode(
                            mutation.node_id,
                            expected,
                        ) or
                        replacement.parent_id != expected.parent_id or
                        replacement.name_tag != expected.name_tag or
                        replacement.declared_name_scalars !=
                            expected.declared_name_scalars or
                        expected.structural_revision ==
                            Nat64.maxValue or
                        replacement.structural_revision !=
                            expected.structural_revision + 1
                    ) return false;
                    switch (expected.kind, replacement.kind) {
                        case (#file(oldFile), #file(newFile)) {
                            let ?oldContent =
                                oldFile.active_content else {
                                return false;
                            };
                            let ?newContent =
                                newFile.active_content else {
                                return false;
                            };
                            expected.metadata_revision !=
                                Nat64.maxValue and
                            replacement.metadata_revision ==
                                expected.metadata_revision + 1 and
                            replacement.children_revision ==
                                expected.children_revision and
                            newContent.content_id !=
                                oldContent.content_id;
                        };
                        case (#folder(_), #folder(_)) {
                            replacement.metadata_revision ==
                                expected.metadata_revision and
                            (
                                replacement.children_revision ==
                                    expected.children_revision or
                                (
                                    expected.children_revision !=
                                        Nat64.maxValue and
                                    replacement.children_revision ==
                                        expected.children_revision + 1
                                )
                            );
                        };
                        case (_) false;
                    };
                };
            };
        };

        func privatePlanHasFolderReplacement(
            plan : Memory.PrivateCommitPlan,
            nodeId : Types.Id128,
        ) : Bool {
            for (mutation in plan.node_mutations.values()) {
                if (mutation.node_id == nodeId) {
                    switch (mutation.replacement) {
                        case (?{ kind = #folder(_) }) return true;
                        case (_) return false;
                    };
                };
            };
            false;
        };

        // Replays every changed direct-child summary against the stored
        // expected compact aggregate. This validates derived ancestor/root
        // rows without consulting the current live tree, so a legitimate
        // stale stage remains bootstrappable.
        func validDerivedPrivateFolder(
            plan : Memory.PrivateCommitPlan,
            mutation : Memory.NodeMutation,
        ) : Bool {
            let ?replacement = mutation.replacement else return false;
            let #folder(replacementFolder) =
                replacement.kind else return false;
            let (
                expectedFolder,
                expectedDirect,
                expectedPlaintext,
            ) = switch (mutation.expected) {
                case null (
                    null,
                    0,
                    0,
                );
                case (?expected) {
                    let #folder(folder) =
                        expected.kind else return false;
                    (
                        ?folder,
                        Nat32.toNat(folder.direct_child_count),
                        expected.subtree_plaintext_bytes,
                    );
                };
            };
            var removedDirect = 0;
            var addedDirect = 0;
            var removedPlaintext = 0;
            var addedPlaintext = 0;
            for (childMutation in plan.node_mutations.values()) {
                switch (childMutation.expected) {
                    case (?oldChild) if (
                        childMutation.node_id != mutation.node_id and
                        oldChild.parent_id == mutation.node_id
                    ) {
                        removedDirect += 1;
                        removedPlaintext +=
                            oldChild.subtree_plaintext_bytes;
                    };
                    case (_) {};
                };
                switch (childMutation.replacement) {
                    case (?newChild) if (
                        childMutation.node_id != mutation.node_id and
                        newChild.parent_id == mutation.node_id
                    ) {
                        addedDirect += 1;
                        addedPlaintext +=
                            newChild.subtree_plaintext_bytes;
                    };
                    case (_) {};
                };
            };
            if (
                expectedDirect < removedDirect or
                expectedPlaintext < removedPlaintext
            ) return false;
            let derivedDirect =
                expectedDirect - removedDirect + addedDirect;
            let derivedPlaintext =
                expectedPlaintext - removedPlaintext +
                addedPlaintext;
            if (
                derivedDirect >= Types.MAX_NODES or
                Nat32.toNat(
                    replacementFolder.direct_child_count
                ) != derivedDirect or
                replacement.subtree_plaintext_bytes !=
                    derivedPlaintext
            ) return false;

            var height = 0;
            while (height < Nat8.toNat(Types.MAX_TREE_DEPTH)) {
                let value = Nat8.fromNat(height);
                let expectedCount = switch (expectedFolder) {
                    case null 0;
                    case (?folder) {
                        privateFolderHeightCount(folder, value);
                    };
                };
                var removed = 0;
                var added = 0;
                for (childMutation in plan.node_mutations.values()) {
                    switch (childMutation.expected) {
                        case (?oldChild) if (
                            childMutation.node_id !=
                                mutation.node_id and
                            oldChild.parent_id == mutation.node_id and
                            oldChild.subtree_height == value
                        ) removed += 1;
                        case (_) {};
                    };
                    switch (childMutation.replacement) {
                        case (?newChild) if (
                            childMutation.node_id !=
                                mutation.node_id and
                            newChild.parent_id == mutation.node_id and
                            newChild.subtree_height == value
                        ) added += 1;
                        case (_) {};
                    };
                };
                if (
                    expectedCount < removed or
                    privateFolderHeightCount(
                        replacementFolder,
                        value,
                    ) != expectedCount - removed + added
                ) return false;
                height += 1;
            };

            var path = 1;
            while (
                path <= Nat16.toNat(Types.MAX_PATH_SCALARS)
            ) {
                let value = Nat16.fromNat(path);
                let expectedCount = switch (expectedFolder) {
                    case null 0;
                    case (?folder) {
                        privateFolderPathCount(folder, value);
                    };
                };
                var removed = 0;
                var added = 0;
                for (childMutation in plan.node_mutations.values()) {
                    switch (childMutation.expected) {
                        case (?oldChild) if (
                            childMutation.node_id !=
                                mutation.node_id and
                            oldChild.parent_id == mutation.node_id and
                            oldChild.max_relative_path_scalars == value
                        ) removed += 1;
                        case (_) {};
                    };
                    switch (childMutation.replacement) {
                        case (?newChild) if (
                            childMutation.node_id !=
                                mutation.node_id and
                            newChild.parent_id == mutation.node_id and
                            newChild.max_relative_path_scalars == value
                        ) added += 1;
                        case (_) {};
                    };
                };
                if (
                    expectedCount < removed or
                    privateFolderPathCount(
                        replacementFolder,
                        value,
                    ) != expectedCount - removed + added
                ) return false;
                path += 1;
            };

            switch (mutation.expected) {
                case null true;
                case (?expected) {
                    let membershipChanged =
                        derivedDirect != expectedDirect;
                    if (
                        expected.children_revision ==
                            Nat64.maxValue and
                        membershipChanged
                    ) return false;
                    if (
                        replacement.children_revision !=
                            (
                                if (membershipChanged) {
                                    expected.children_revision + 1;
                                } else expected.children_revision
                            )
                    ) return false;
                    replacementFolder != (
                        switch (expected.kind) {
                            case (#folder(folder)) folder;
                            case (_) return false;
                        }
                    ) or
                    replacement.subtree_height !=
                        expected.subtree_height or
                    replacement.max_relative_path_scalars !=
                        expected.max_relative_path_scalars or
                    replacement.subtree_plaintext_bytes !=
                        expected.subtree_plaintext_bytes;
                };
            };
        };

        func privatePlanPlaintext(node : Memory.Node) : Nat {
            switch (Tree.content(node)) {
                case null 0;
                case (?content) switch (
                    Tree.contentPlaintext(content)
                ) {
                    case (?value) value;
                    case null 0;
                };
            };
        };

        func privatePlanCiphertext(node : Memory.Node) : Nat {
            node.encrypted_metadata.size() +
            (switch (Tree.content(node)) {
                case null 0;
                case (?content) content.ciphertext_bytes;
            });
        };

        func validPrivateCommitPlan(
            stage : Memory.PrivateStage
        ) : Bool {
            let plan = stage.commit_plan;
            let entryCount =
                plan.node_mutations.size() +
                plan.child_index_mutations.size() +
                plan.retired_contents.size();
            if (
                plan.node_mutations.size() == 0 or
                entryCount > Types.MAX_BATCH_PLAN_ENTRIES or
                plan.retired_contents.size() >
                    Types.MAX_BATCH_BLOCKS or
                plan.final_physical_bytes != 0
            ) return false;

            var previousNodeId : ?Types.Id128 = null;
            var beforeNodes = 0;
            var afterNodes = 0;
            var beforePlaintext = 0;
            var afterPlaintext = 0;
            var beforeCiphertext = 0;
            var afterCiphertext = 0;
            var plannedPlaintext = 0;
            var createdFiles = 0;
            var replacedFiles = 0;
            var mutationIndex = 0;
            while (mutationIndex < plan.node_mutations.size()) {
                let mutation = plan.node_mutations[mutationIndex];
                switch (previousNodeId) {
                    case (?previous) if (
                        Keys.compareId128(
                            previous,
                            mutation.node_id,
                        ) != #less
                    ) return false;
                    case (_) {};
                };
                previousNodeId := ?mutation.node_id;
                if (not validPrivatePlanTransition(mutation)) {
                    return false;
                };
                if (
                    mutation.expected == null and
                    Map.get(
                        mem.nodes_by_id,
                        Keys.compareId128,
                        mutation.node_id,
                    ) != null
                ) return false;
                let ?replacement = mutation.replacement else {
                    return false;
                };
                afterNodes += 1;
                afterPlaintext += privatePlanPlaintext(replacement);
                afterCiphertext +=
                    privatePlanCiphertext(replacement);
                switch (Tree.content(replacement)) {
                    case (?content) {
                        var prior = 0;
                        while (prior < mutationIndex) {
                            switch (
                                plan.node_mutations[prior].replacement
                            ) {
                                case (?priorNode) switch (
                                    Tree.content(priorNode)
                                ) {
                                    case (?priorContent) if (
                                        priorContent.content_id ==
                                            content.content_id
                                    ) return false;
                                    case (_) {};
                                };
                                case null {};
                            };
                            prior += 1;
                        };
                        let plaintext =
                            privatePlanPlaintext(replacement);
                        plannedPlaintext += plaintext;
                        switch (mutation.expected) {
                            case null createdFiles += 1;
                            case (?_) replacedFiles += 1;
                        };
                    };
                    case null {};
                };
                switch (mutation.expected) {
                    case null {};
                    case (?expected) {
                        beforeNodes += 1;
                        beforePlaintext +=
                            privatePlanPlaintext(expected);
                        beforeCiphertext +=
                            privatePlanCiphertext(expected);
                        switch (Tree.content(expected)) {
                            case (?oldContent) {
                                var prior = 0;
                                while (prior < mutationIndex) {
                                    switch (
                                        plan.node_mutations[prior].expected
                                    ) {
                                        case (?priorNode) switch (
                                            Tree.content(priorNode)
                                        ) {
                                            case (?priorContent) if (
                                                priorContent.content_id ==
                                                    oldContent.content_id
                                            ) return false;
                                            case (_) {};
                                        };
                                        case null {};
                                    };
                                    prior += 1;
                                };
                            };
                            case null {};
                        };
                    };
                };

                let summaryChanged = switch (mutation.expected) {
                    case null true;
                    case (?expected) {
                        expected.subtree_height !=
                            replacement.subtree_height or
                        expected.max_relative_path_scalars !=
                            replacement.max_relative_path_scalars or
                        expected.subtree_plaintext_bytes !=
                            replacement.subtree_plaintext_bytes;
                    };
                };
                if (
                    summaryChanged and
                    not privatePlanHasFolderReplacement(
                        plan,
                        replacement.parent_id,
                    )
                ) return false;
                mutationIndex += 1;
            };

            var previousChildKey : ?Memory.ChildNameKey = null;
            for (child in plan.child_index_mutations.values()) {
                switch (previousChildKey) {
                    case (?previous) if (
                        Keys.compareChildNameKey(
                            previous,
                            child.key,
                        ) != #less
                    ) return false;
                    case (_) {};
                };
                previousChildKey := ?child.key;
                if (child.expected != null) return false;
                let ?replacementId = child.replacement else {
                    return false;
                };
                if (replacementId == Types.ROOT_NODE_ID) {
                    return false;
                };
                var matches = 0;
                for (mutation in plan.node_mutations.values()) {
                    if (
                        mutation.node_id == replacementId and
                        mutation.expected == null
                    ) {
                        switch (mutation.replacement) {
                            case (?replacement) if (
                                child.key ==
                                    Keys.childNameKey(
                                        replacement.parent_id,
                                        replacement.name_tag,
                                    )
                            ) matches += 1;
                            case (_) {};
                        };
                    };
                };
                if (matches != 1) return false;
            };
            for (mutation in plan.node_mutations.values()) {
                switch (
                    mutation.expected,
                    mutation.replacement,
                ) {
                    case (null, (?replacement)) {
                        var matches = 0;
                        for (
                            child in
                            plan.child_index_mutations.values()
                        ) {
                            if (
                                child.expected == null and
                                child.replacement == ?mutation.node_id and
                                child.key ==
                                    Keys.childNameKey(
                                        replacement.parent_id,
                                        replacement.name_tag,
                                    )
                            ) matches += 1;
                        };
                        if (matches != 1) return false;
                    };
                    case (_) {};
                };
                switch (mutation.replacement) {
                    case (?{ kind = #folder(_) }) if (
                        not validDerivedPrivateFolder(plan, mutation)
                    ) return false;
                    case (_) {};
                };
            };

            if (
                plan.node_count_delta !=
                    delta(beforeNodes, afterNodes) or
                plan.committed_plaintext_delta !=
                    delta(beforePlaintext, afterPlaintext) or
                plan.committed_ciphertext_delta !=
                    delta(beforeCiphertext, afterCiphertext)
            ) return false;
            let contentTargets = createdFiles + replacedFiles;
            switch (plan.intent) {
                case (#create) {
                    if (
                        createdFiles != 1 or
                        replacedFiles != 0
                    ) return false;
                };
                case (#replace) {
                    if (
                        createdFiles != 0 or
                        replacedFiles != 1
                    ) return false;
                };
                case (#batch) {
                    if (
                        contentTargets == 0 or
                        contentTargets > Types.MAX_BATCH_FILES or
                        plannedPlaintext >
                            Types.MAX_BATCH_PLAINTEXT_BYTES
                    ) return false;
                };
            };

            for (retirement in plan.retired_contents.values()) {
                if (not validPrivatePlanContent(retirement.content)) {
                    return false;
                };
                var matches = 0;
                for (mutation in plan.node_mutations.values()) {
                    if (mutation.node_id == retirement.node_id) {
                        switch (mutation.expected) {
                            case (?expected) switch (
                                Tree.content(expected)
                            ) {
                                case (?content) if (
                                    content == retirement.content
                                ) matches += 1;
                                case (_) {};
                            };
                            case null {};
                        };
                    };
                };
                if (matches != 1) return false;
            };
            for (mutation in plan.node_mutations.values()) {
                switch (mutation.expected) {
                    case (?expected) switch (Tree.content(expected)) {
                        case (?content) {
                            var matches = 0;
                            for (
                                retirement in
                                plan.retired_contents.values()
                            ) {
                                if (
                                    retirement.node_id ==
                                        mutation.node_id and
                                    retirement.content == content
                                ) matches += 1;
                            };
                            if (matches != 1) return false;
                        };
                        case null {};
                    };
                    case null {};
                };
            };
            true;
        };

        // Active-stage validation deliberately checks all collection sizes
        // before traversing them. The persisted first-frame contract caps
        // these vectors, so bootstrap work remains bounded even when stable
        // memory is malformed.
        func validPrivateStageGeometry(
            stage : Memory.PrivateStage
        ) : Bool {
            let frameCount = Nat8.toNat(stage.frame_count);
            let frameLimit = switch (stage.commit_plan.intent) {
                case (#batch) Types.MAX_BATCH_FRAMES;
                case (_) Types.MAX_SINGLE_WRITE_FRAMES;
            };
            let planEntries =
                stage.commit_plan.node_mutations.size() +
                stage.commit_plan.child_index_mutations.size() +
                stage.commit_plan.retired_contents.size();
            if (
                frameCount == 0 or frameCount > frameLimit or
                stage.frames.size() != frameCount or
                stage.frame_fingerprints.size() != frameCount or
                not validStageBitmap(
                    stage.accepted_frame_bitmap,
                    frameCount,
                ) or
                stage.commit_plan.node_mutations.size() == 0 or
                planEntries > Types.MAX_BATCH_PLAN_ENTRIES or
                stage.commit_plan.retired_contents.size() >
                    Types.MAX_BATCH_BLOCKS
            ) return false;
            if (not validPrivateCommitPlan(stage)) return false;

            var contentTargets = 0;
            var declaredBlocks = 0;
            var mutationIndex = 0;
            while (
                mutationIndex <
                stage.commit_plan.node_mutations.size()
            ) {
                switch (
                    stage.commit_plan.node_mutations[
                        mutationIndex
                    ].expected
                ) {
                    case (?node) if (
                        not boundedPrivateReservationNode(node)
                    ) return false;
                    case (_) {};
                };
                switch (
                    stage.commit_plan.node_mutations[
                        mutationIndex
                    ].replacement
                ) {
                    case (?node) {
                        if (not boundedPrivateReservationNode(node)) {
                            return false;
                        };
                        switch (Tree.content(node)) {
                        case (?content) {
                            let blockCount =
                                Nat32.toNat(content.block_count);
                            if (
                                content.content_id ==
                                    Types.ROOT_NODE_ID or
                                blockCount == 0 or
                                blockCount >
                                    Types.MAX_BLOCKS_PER_FILE or
                                content.ciphertext_bytes <
                                    blockCount * 16 or
                                content.ciphertext_bytes >
                                    Types.MAX_FILE_CIPHERTEXT_BYTES
                            ) return false;
                            var prior = 0;
                            while (prior < mutationIndex) {
                                switch (
                                    stage.commit_plan.node_mutations[
                                        prior
                                    ].replacement
                                ) {
                                    case (?priorNode) switch (
                                        Tree.content(priorNode)
                                    ) {
                                        case (?priorContent) if (
                                            priorContent.content_id ==
                                                content.content_id
                                        ) return false;
                                        case (_) {};
                                    };
                                    case null {};
                                };
                                prior += 1;
                            };
                            contentTargets += 1;
                            declaredBlocks += blockCount;
                            if (
                                contentTargets >
                                    Types.MAX_BATCH_FILES or
                                declaredBlocks >
                                    Types.MAX_BATCH_BLOCKS
                            ) return false;
                        };
                        case null {};
                        };
                    };
                    case null {};
                };
                mutationIndex += 1;
            };
            switch (stage.commit_plan.intent) {
                case (#batch) {
                    if (contentTargets == 0) return false;
                };
                case (_) {
                    if (contentTargets != 1) return false;
                };
            };

            var retiredBlocks = 0;
            var retiredCiphertext = 0;
            for (
                retirement in
                stage.commit_plan.retired_contents.values()
            ) {
                let blockCount =
                    Nat32.toNat(retirement.content.block_count);
                if (
                    not boundedPrivateReservationContent(
                        retirement.content
                    ) or
                    retirement.content.content_id ==
                        Types.ROOT_NODE_ID or
                    blockCount == 0 or
                    blockCount > Types.MAX_BLOCKS_PER_FILE or
                    retirement.content.ciphertext_bytes <
                        blockCount * 16 or
                    retirement.content.ciphertext_bytes >
                        Types.MAX_FILE_CIPHERTEXT_BYTES
                ) return false;
                retiredBlocks += blockCount;
                retiredCiphertext +=
                    retirement.content.ciphertext_bytes;
            };

            var acceptedCiphertext = 0;
            var acceptedBlockCharge = 0;
            var reservedCiphertext = 0;
            var plannedBlocks = 0;
            var frameIndex = 0;
            while (frameIndex < frameCount) {
                let frame = stage.frames[frameIndex];
                let accepted = bitmapHas(
                    stage.accepted_frame_bitmap,
                    Nat8.fromNat(frameIndex),
                );
                switch (stage.frame_fingerprints[frameIndex]) {
                    case (?_) if (not accepted) return false;
                    case null if (accepted) return false;
                    case (_) {};
                };
                let encodedBytes = Nat32.toNat(frame.encoded_bytes);
                if (
                    Nat8.toNat(frame.ordinal) != frameIndex or
                    encodedBytes == 0 or
                    encodedBytes > Types.MAX_FRAME_BYTES or
                    frame.blocks.size() == 0 or
                    frame.blocks.size() > Types.MAX_BATCH_BLOCKS or
                    plannedBlocks + frame.blocks.size() >
                        Types.MAX_BATCH_BLOCKS
                ) return false;
                var blockPosition = 0;
                var priorEnd = 0;
                while (blockPosition < frame.blocks.size()) {
                    let block = frame.blocks[blockPosition];
                    let blockIndex = Nat32.toNat(block.block_index);
                    let ciphertext =
                        Nat32.toNat(block.ciphertext_bytes);
                    let offset = Nat32.toNat(block.payload_offset);
                    let length = Nat32.toNat(block.payload_length);
                    if (
                        block.frame_ordinal != frame.ordinal or
                        ciphertext < 16 or
                        ciphertext >
                            Types.MAX_PLAINTEXT_BLOCK_BYTES + 16 or
                        length != ciphertext or
                        offset > encodedBytes or
                        length > encodedBytes - offset or
                        (blockPosition > 0 and offset != priorEnd) or
                        (
                            frameIndex > 0 and
                            blockPosition == 0 and offset != 0
                        )
                    ) return false;
                    priorEnd := offset + length;

                    var contentMatches = 0;
                    var descriptor : ?Memory.ContentRecord = null;
                    for (
                        mutation in
                        stage.commit_plan.node_mutations.values()
                    ) {
                        switch (mutation.replacement) {
                            case (?node) switch (Tree.content(node)) {
                                case (?content) if (
                                    content.content_id ==
                                        block.content_id
                                ) {
                                    contentMatches += 1;
                                    descriptor := ?content;
                                };
                                case (_) {};
                            };
                            case null {};
                        };
                    };
                    let ?content = descriptor else return false;
                    let contentBlocks =
                        Nat32.toNat(content.block_count);
                    if (
                        contentMatches != 1 or
                        blockIndex >= contentBlocks or
                        (
                            contentBlocks > 1 and
                            (
                                (blockIndex == 0 and ciphertext == 16) or
                                (
                                    blockIndex > 0 and
                                    ciphertext !=
                                        Types.MAX_PLAINTEXT_BLOCK_BYTES +
                                        16
                                )
                            )
                        )
                    ) return false;

                    var priorFrame = 0;
                    while (priorFrame <= frameIndex) {
                        let priorBlocks =
                            stage.frames[priorFrame].blocks;
                        let before = if (priorFrame == frameIndex) {
                            blockPosition;
                        } else priorBlocks.size();
                        var priorBlock = 0;
                        while (priorBlock < before) {
                            if (
                                priorBlocks[priorBlock].content_id ==
                                    block.content_id and
                                priorBlocks[priorBlock].block_index ==
                                    block.block_index
                            ) return false;
                            priorBlock += 1;
                        };
                        priorFrame += 1;
                    };

                    switch (
                        Map.get(
                            mem.blocks,
                            Keys.compareBlockKey,
                            Keys.blockKey(
                                block.content_id,
                                block.block_index,
                            ),
                        )
                    ) {
                        case (?body) {
                            if (
                                not accepted or
                                body.size() != ciphertext
                            ) return false;
                        };
                        case null {
                            if (accepted) return false;
                        };
                    };
                    if (accepted) {
                        acceptedCiphertext += ciphertext;
                        acceptedBlockCharge +=
                            Accounting.blockCharge(ciphertext);
                    } else {
                        reservedCiphertext += ciphertext;
                    };
                    plannedBlocks += 1;
                    blockPosition += 1;
                };
                if (frameIndex > 0 and priorEnd != encodedBytes) {
                    return false;
                };
                frameIndex += 1;
            };
            if (
                not bitmapHas(stage.accepted_frame_bitmap, 0) or
                plannedBlocks != declaredBlocks or
                acceptedCiphertext !=
                    stage.accepted_ciphertext_bytes or
                reservedCiphertext !=
                    stage.reserved_ciphertext_bytes or
                acceptedCiphertext + reservedCiphertext >
                    Types.MAX_STAGED_CIPHERTEXT_BYTES
            ) return false;

            for (
                mutation in
                stage.commit_plan.node_mutations.values()
            ) {
                switch (mutation.replacement) {
                    case (?node) switch (Tree.content(node)) {
                        case (?content) {
                            var contentCiphertext = 0;
                            var wantedIndex = 0;
                            while (
                                wantedIndex <
                                Nat32.toNat(content.block_count)
                            ) {
                                var matches = 0;
                                for (frame in stage.frames.values()) {
                                    for (block in frame.blocks.values()) {
                                        if (
                                            block.content_id ==
                                                content.content_id and
                                            Nat32.toNat(
                                                block.block_index
                                            ) == wantedIndex
                                        ) {
                                            matches += 1;
                                            contentCiphertext +=
                                                Nat32.toNat(
                                                    block.ciphertext_bytes
                                                );
                                        };
                                    };
                                };
                                if (matches != 1) return false;
                                wantedIndex += 1;
                            };
                            if (
                                contentCiphertext !=
                                    content.ciphertext_bytes
                            ) return false;
                        };
                        case null {};
                    };
                    case null {};
                };
            };

            let commitCleanup =
                retiredBlocks > Types.MAX_CLEANUP_BLOCKS_PER_PAGE or
                retiredCiphertext >
                    Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE;
            let abortCleanup =
                plannedBlocks > Types.MAX_CLEANUP_BLOCKS_PER_PAGE or
                acceptedCiphertext + reservedCiphertext >
                    Types.MAX_CLEANUP_CIPHERTEXT_PER_PAGE;
            let cleanupJobs =
                if (commitCleanup or abortCleanup) 1 else 0;
            if (
                Nat8.toNat(stage.reserved_cleanup_jobs) != cleanupJobs or
                cleanupJobs > Types.MAX_CLEANUP_JOBS
            ) return false;
            let reservation =
                Accounting.privateCommitReservation(stage);
            let consumed =
                reservation.current_stage_charge +
                acceptedBlockCharge;
            reservation.peak_reservation_charge >= consumed and
            stage.reserved_physical_bytes ==
                reservation.peak_reservation_charge - consumed;
        };

        func rememberPrivateStageContents(
            stage : Memory.PrivateStage,
            seen : List.List<Types.Id128>,
        ) : Bool {
            // Startup compares only the bounded active-stage plans. It must
            // not enumerate the committed node tree to rediscover content
            // ownership; runtime admission rejects existing block keys.
            for (
                mutation in
                stage.commit_plan.node_mutations.values()
            ) {
                switch (mutation.replacement) {
                    case (?node) switch (Tree.content(node)) {
                        case (?content) {
                            if (
                                contentIdRetainedByReceipt(
                                    content.content_id
                                )
                            ) return false;
                            for (prior in List.toArray(seen).values()) {
                                if (prior == content.content_id) {
                                    return false;
                                };
                            };
                            List.add(seen, content.content_id);
                        };
                        case null {};
                    };
                    case null {};
                };
            };
            true;
        };

        func rememberPrivateStageNewNodes(
            stage : Memory.PrivateStage,
            seen : List.List<Types.Id128>,
        ) : Bool {
            for (
                mutation in
                stage.commit_plan.node_mutations.values()
            ) {
                if (mutation.expected == null) {
                    if (
                        nodeIdRetainedByReceipt(mutation.node_id)
                    ) return false;
                    for (prior in List.toArray(seen).values()) {
                        if (prior == mutation.node_id) {
                            return false;
                        };
                    };
                    List.add(seen, mutation.node_id);
                };
            };
            true;
        };

        func privateReceiptRequestId(
            receipt : Memory.PrivateReceipt
        ) : Types.Id128 {
            switch (receipt.outcome) {
                case (#vault(value)) value.request_id;
                case (#write(value)) value.request_id;
                case (#mutation(value)) value.request_id;
                case (#remove(value)) value.request_id;
                case (#abort(value)) value.request_id;
                case (#expired(value)) value.request_id;
            };
        };

        func boundedPrivateReceipt(
            receipt : Memory.PrivateReceipt
        ) : Bool {
            var contentTargets = 0;
            let boundedOutcome = switch (receipt.outcome) {
                case (#vault(_)) receipt.terminal_kind == null;
                case (#write(value)) {
                    for (node in value.nodes.values()) {
                        if (node.content_id != null) {
                            contentTargets += 1;
                        };
                    };
                    receipt.terminal_kind == null and
                    value.nodes.size() <=
                        Types.MAX_BATCH_PLAN_ENTRIES and
                    value.frame_fingerprints.size() > 0 and
                    value.frame_fingerprints.size() <=
                        Types.MAX_SINGLE_WRITE_FRAMES;
                };
                case (#mutation(_)) receipt.terminal_kind == null;
                case (#remove(_)) receipt.terminal_kind == null;
                case (#abort(value)) {
                    for (node in value.nodes.values()) {
                        if (node.content_id != null) {
                            contentTargets += 1;
                        };
                    };
                    receipt.terminal_kind == ?#aborted and
                    value.nodes.size() <=
                        Types.MAX_BATCH_PLAN_ENTRIES;
                };
                case (#expired(value)) {
                    for (node in value.nodes.values()) {
                        if (node.content_id != null) {
                            contentTargets += 1;
                        };
                    };
                    receipt.terminal_kind == ?#expired and
                    value.nodes.size() <=
                        Types.MAX_BATCH_PLAN_ENTRIES and
                    value.frame_plan_fingerprints.size() > 0 and
                    value.frame_plan_fingerprints.size() <=
                        Types.MAX_SINGLE_WRITE_FRAMES and
                    value.frame_fingerprints.size() ==
                        value.frame_plan_fingerprints.size();
                };
            };
            if (
                not boundedOutcome or
                contentTargets > Types.MAX_BATCH_FILES
            ) return false;
            let identities = ReceiptOwnership.receipt(receipt);
            if (
                identities.row_ids.size() + 2 >
                    Types.MAX_CLEANUP_ENTRIES_PER_PAGE or
                identities.row_ids.size() + 1 >
                    Types.MAX_CLEANUP_WORK_UNITS_PER_PAGE
            ) return false;
            for (id in identities.row_ids.values()) {
                if (id == Types.ROOT_NODE_ID) return false;
            };
            true;
        };

        func incrementExpectedPrivateReceiptIdentity(
            expected : Map.Map<
                Types.Id128,
                Memory.PrivateReceiptIdentityOwner
            >,
            id : Types.Id128,
            node : Bool,
        ) : Bool {
            let current : Memory.PrivateReceiptIdentityOwner = switch (
                Map.get(expected, Keys.compareId128, id)
            ) {
                case null {
                    { node_count = 0; content_count = 0 };
                };
                case (?value) value;
            };
            let nodeCount = Nat16.toNat(current.node_count);
            let contentCount = Nat16.toNat(current.content_count);
            if (
                (node and nodeCount == Nat16.toNat(Nat16.maxValue)) or
                (
                    not node and
                    contentCount == Nat16.toNat(Nat16.maxValue)
                )
            ) return false;
            Map.add(
                expected,
                Keys.compareId128,
                id,
                if (node) {
                    {
                        node_count = Nat16.fromNat(nodeCount + 1);
                        content_count = current.content_count;
                    };
                } else {
                    {
                        node_count = current.node_count;
                        content_count =
                            Nat16.fromNat(contentCount + 1);
                    };
                },
            );
            true;
        };

        // Receipt count and per-receipt identity vectors are independently
        // bounded. Bootstrap therefore reconstructs this temporary index
        // without enumerating committed nodes or block rows.
        func validPrivateReceiptIdentityOwners() : Bool {
            if (
                Map.size(mem.private_receipts) >
                    Types.MAX_PRIVATE_RECEIPTS or
                Map.size(mem.private_receipts) !=
                    Map.size(mem.private_receipts_by_expiry)
            ) return false;
            let expected = Map.empty<
                Types.Id128,
                Memory.PrivateReceiptIdentityOwner
            >();
            for ((requestId, receipt) in
                Map.entries(mem.private_receipts)) {
                if (
                    requestId == Types.ROOT_NODE_ID or
                    privateReceiptRequestId(receipt) != requestId or
                    not boundedPrivateReceipt(receipt) or
                    Map.get(
                        mem.private_receipts_by_expiry,
                        Keys.comparePrivateReceiptExpiryKey,
                        (
                            receipt.expires_at_ns,
                            requestId.hi,
                            requestId.lo,
                        ),
                    ) == null
                ) return false;
                let identities = ReceiptOwnership.receipt(receipt);
                for (id in identities.node_ids.values()) {
                    if (
                        not incrementExpectedPrivateReceiptIdentity(
                            expected,
                            id,
                            true,
                        )
                    ) return false;
                };
                for (id in identities.content_ids.values()) {
                    if (
                        not incrementExpectedPrivateReceiptIdentity(
                            expected,
                            id,
                            false,
                        )
                    ) return false;
                };
            };
            for ((key, _) in
                Map.entries(mem.private_receipts_by_expiry)) {
                let requestId = { hi = key.1; lo = key.2 };
                let ?receipt = Map.get(
                    mem.private_receipts,
                    Keys.compareId128,
                    requestId,
                ) else return false;
                if (receipt.expires_at_ns != key.0) return false;
            };
            if (
                Map.size(expected) !=
                    Map.size(mem.private_receipt_identity_owners)
            ) return false;
            for ((id, owner) in
                Map.entries(mem.private_receipt_identity_owners)) {
                if (
                    (
                        owner.node_count == 0 and
                        owner.content_count == 0
                    ) or
                    Map.get(expected, Keys.compareId128, id) !=
                        ?owner
                ) return false;
            };
            true;
        };

        func validCleanupJobs() : ?{
            remaining_staged_ciphertext : Nat;
            remaining_private_stage_blocks : [Memory.BlockKey];
        } {
            if (
                mem.next_job_id == 0 or
                Map.size(mem.delete_jobs) >
                    Types.MAX_CLEANUP_JOBS
            ) return null;
            var jobCharges = 0;
            var remainingStagedCiphertext = 0;
            let remainingPrivateStageBlocks =
                List.empty<Memory.BlockKey>();
            for ((jobId, job) in Map.entries(mem.delete_jobs)) {
                if (
                    jobId == 0 or
                    job.job_id != jobId or
                    jobId >= mem.next_job_id or
                    job.updated_at_ns < job.created_at_ns or
                    job.reclaimed_ciphertext_bytes >
                        Types.MAX_COMMITTED_CIPHERTEXT_BYTES or
                    job.reclaimed_entries >
                        Types.MAX_NODES *
                            (Types.MAX_BLOCKS_PER_FILE + 2)
                ) return null;
                switch (job.kind) {
                    case (#subtree(state)) {
                        if (
                            state.root_id == Types.ROOT_NODE_ID or
                            state.stack.size() >
                                Nat8.toNat(Types.MAX_TREE_DEPTH) + 1
                        ) return null;
                        var index = 0;
                        while (index < state.stack.size()) {
                            let frame = state.stack[index];
                            if (
                                frame.node_id == Types.ROOT_NODE_ID or
                                (
                                    index == 0 and
                                    frame.node_id != state.root_id
                                ) or
                                (
                                    index + 1 < state.stack.size() and
                                    (
                                        not frame.entered or
                                        frame.after_child_tag == null
                                    )
                                ) or
                                (
                                    not frame.entered and
                                    frame.after_child_tag != null
                                )
                            ) return null;
                            var prior = 0;
                            while (prior < index) {
                                if (
                                    state.stack[prior].node_id ==
                                        frame.node_id
                                ) return null;
                                prior += 1;
                            };
                            index += 1;
                        };
                    };
                    case (#contents(state)) {
                        let size = state.contents.size();
                        let current =
                            Nat8.toNat(state.current_content);
                        if (
                            size == 0 or
                            size > Types.MAX_BATCH_BLOCKS or
                            current >= size
                        ) return null;
                        var allComplete = true;
                        for (descriptor in state.contents.values()) {
                            if (
                                descriptor.next_block_index !=
                                    descriptor.block_count
                            ) allComplete := false;
                        };
                        var cursorTotal = 0;
                        var index = 0;
                        while (index < size) {
                            let descriptor = state.contents[index];
                            let next = Nat32.toNat(
                                descriptor.next_block_index
                            );
                            let count =
                                Nat32.toNat(descriptor.block_count);
                            if (
                                descriptor.content_id ==
                                    Types.ROOT_NODE_ID or
                                count == 0 or
                                count > Types.MAX_BLOCKS_PER_FILE or
                                next > count or
                                (index < current and next != count) or
                                (
                                    not allComplete and
                                    index > current and
                                    next != 0
                                )
                            ) return null;
                            cursorTotal += next;
                            var prior = 0;
                            while (prior < index) {
                                if (
                                    state.contents[prior].content_id ==
                                        descriptor.content_id
                                ) return null;
                                prior += 1;
                            };
                            var blockIndex = 0;
                            while (blockIndex < count) {
                                let key = Keys.blockKey(
                                    descriptor.content_id,
                                    Nat32.fromNat(blockIndex),
                                );
                                let present = Map.get(
                                    mem.blocks,
                                    Keys.compareBlockKey,
                                    key,
                                ) != null;
                                if (
                                    (blockIndex < next and present) or
                                    (blockIndex >= next and not present)
                                ) return null;
                                if (blockIndex >= next) {
                                    for (
                                        priorKey in
                                        List.toArray(
                                            remainingPrivateStageBlocks
                                        ).values()
                                    ) {
                                        if (priorKey == key) return null;
                                    };
                                    List.add(
                                        remainingPrivateStageBlocks,
                                        key,
                                    );
                                };
                                blockIndex += 1;
                            };
                            index += 1;
                        };
                        if (
                            job.reclaimed_entries != cursorTotal or
                            (
                                allComplete and current != 0
                            )
                        ) return null;
                    };
                    case (#private_stage(state)) {
                        let size = state.blocks.size();
                        let next = Nat32.toNat(state.next_block);
                        if (
                            size == 0 or
                            size > Types.MAX_BATCH_BLOCKS or
                            next > size or
                            job.reclaimed_entries > next or
                            next - job.reclaimed_entries >
                                Types.MAX_CLEANUP_BLOCKS_PER_PAGE or
                            job.reclaimed_ciphertext_bytes >
                                Types.MAX_STAGED_CIPHERTEXT_BYTES
                        ) return null;
                        var index = 0;
                        while (index < size) {
                            let key = state.blocks[index];
                            if (
                                (key.0 == 0 and key.1 == 0) or
                                Nat32.toNat(key.2) >=
                                    Types.MAX_BLOCKS_PER_FILE
                            ) return null;
                            var prior = 0;
                            while (prior < index) {
                                if (state.blocks[prior] == key) {
                                    return null;
                                };
                                prior += 1;
                            };
                            switch (
                                Map.get(
                                    mem.blocks,
                                    Keys.compareBlockKey,
                                    key,
                                )
                            ) {
                                case (?body) {
                                    if (index < next) return null;
                                    for (
                                        priorKey in
                                        List.toArray(
                                            remainingPrivateStageBlocks
                                        ).values()
                                    ) {
                                        if (priorKey == key) return null;
                                    };
                                    remainingStagedCiphertext +=
                                        body.size();
                                    List.add(
                                        remainingPrivateStageBlocks,
                                        key,
                                    );
                                };
                                case null {
                                    if (index >= next) return null;
                                };
                            };
                            index += 1;
                        };
                    };
                    case (#orphan_blocks(state)) {
                        let next =
                            Nat32.toNat(state.next_block_index);
                        let count =
                            Nat32.toNat(state.block_count);
                        if (
                            state.content_id == Types.ROOT_NODE_ID or
                            count == 0 or
                            count > Types.MAX_BLOCKS_PER_FILE or
                            next > count or
                            job.reclaimed_entries != next or
                            job.reclaimed_ciphertext_bytes >
                                Types.MAX_FILE_CIPHERTEXT_BYTES
                        ) return null;
                        var blockIndex = 0;
                        while (blockIndex < count) {
                            let key = Keys.blockKey(
                                state.content_id,
                                Nat32.fromNat(blockIndex),
                            );
                            let present = Map.get(
                                mem.blocks,
                                Keys.compareBlockKey,
                                key,
                            ) != null;
                            if (
                                (blockIndex < next and present) or
                                (blockIndex >= next and not present)
                            ) return null;
                            if (blockIndex >= next) {
                                for (
                                    priorKey in
                                    List.toArray(
                                        remainingPrivateStageBlocks
                                    ).values()
                                ) {
                                    if (priorKey == key) return null;
                                };
                                List.add(
                                    remainingPrivateStageBlocks,
                                    key,
                                );
                            };
                            blockIndex += 1;
                        };
                    };
                };
                jobCharges += Accounting.cleanupJobCharge(job);
            };
            if (jobCharges > mem.physical_private_bytes) return null;
            ?{
                remaining_staged_ciphertext =
                    remainingStagedCiphertext;
                remaining_private_stage_blocks =
                    List.toArray(remainingPrivateStageBlocks);
            };
        };

        func activeOperations() : Types.Result<[Types.OperationSummary]> {
            let ?cleanupState = validCleanupJobs() else {
                return #err(Types.reject(#corrupt_state));
            };
            if (
                mem.next_stage_id == 0 or
                mem.next_job_id == 0 or
                Map.size(mem.nodes_by_id) > Types.MAX_NODES or
                mem.node_count != Map.size(mem.nodes_by_id) or
                mem.committed_private_plaintext_bytes >
                    Types.MAX_PRIVATE_PLAINTEXT_BYTES or
                mem.committed_ciphertext_bytes >
                    Types.MAX_COMMITTED_CIPHERTEXT_BYTES or
                mem.staged_ciphertext_bytes +
                    mem.reserved_staged_ciphertext_bytes >
                    Types.MAX_STAGED_CIPHERTEXT_BYTES or
                mem.physical_private_bytes +
                    mem.reserved_physical_private_bytes >
                    Types.MAX_PHYSICAL_PRIVATE_BYTES or
                Map.size(mem.stages) > Types.MAX_PRIVATE_STAGES or
                Map.size(mem.stages) !=
                    Map.size(mem.stages_by_request) or
                Map.size(mem.private_receipts_by_expiry) >
                    Types.MAX_PRIVATE_RECEIPTS or
                Map.size(mem.private_receipt_identity_owners) >
                    Types.MAX_PRIVATE_RECEIPTS *
                        (Types.MAX_CLEANUP_ENTRIES_PER_PAGE - 2) or
                Map.size(mem.delete_jobs) +
                    mem.reserved_cleanup_jobs >
                    Types.MAX_CLEANUP_JOBS or
                not validPrivateReceiptIdentityOwners()
            ) return #err(Types.reject(#corrupt_state));

            let values = List.empty<Types.OperationSummary>();
            let privateContents = List.empty<Types.Id128>();
            let privateNewNodes = List.empty<Types.Id128>();
            var acceptedCiphertext = 0;
            var reservedCiphertext = 0;
            var reservedPhysical = 0;
            var reservedCleanupJobs = 0;
            for ((stageId, stored) in Map.entries(mem.stages)) {
                if (
                    stageId == 0 or stageId >= mem.next_stage_id
                ) return #err(Types.reject(#corrupt_state));
                let #private_write(stage) = stored else {
                    return #err(Types.reject(#incompatible));
                };
                if (
                    not validPrivateStageGeometry(stage) or
                    not rememberPrivateStageContents(
                        stage,
                        privateContents,
                    ) or
                    not rememberPrivateStageNewNodes(
                        stage,
                        privateNewNodes,
                    )
                ) return #err(Types.reject(#corrupt_state));
                for (frame in stage.frames.values()) {
                    if (
                        bitmapHas(
                            stage.accepted_frame_bitmap,
                            frame.ordinal,
                        )
                    ) {
                        for (block in frame.blocks.values()) {
                            let key = Keys.blockKey(
                                block.content_id,
                                block.block_index,
                            );
                            for (
                                cleanupKey in
                                cleanupState
                                    .remaining_private_stage_blocks
                                    .values()
                            ) {
                                if (key == cleanupKey) {
                                    return #err(
                                        Types.reject(#corrupt_state)
                                    );
                                };
                            };
                        };
                    };
                };
                acceptedCiphertext += stage.accepted_ciphertext_bytes;
                reservedCiphertext += stage.reserved_ciphertext_bytes;
                reservedPhysical += stage.reserved_physical_bytes;
                reservedCleanupJobs +=
                    Nat8.toNat(stage.reserved_cleanup_jobs);
                let target : Types.OperationTarget = #private_write({
                    nodes = privateStageTargets(stage);
                });
                if (
                    stage.request_id == Types.ROOT_NODE_ID or
                    Map.get(
                        mem.private_receipts,
                        Keys.compareId128,
                        stage.request_id,
                    ) != null or
                    not validOperationTarget(target) or
                    Map.get(
                        mem.stages_by_request,
                        Keys.compareId128,
                        stage.request_id,
                    ) != ?stageId
                ) return #err(Types.reject(#corrupt_state));
                List.add(values, {
                    request_id = stage.request_id;
                    kind = ?#private_write;
                    stage_id = ?stageId;
                    expires_at_ns = ?stage.expires_at_ns;
                    target = ?target;
                });
            };
            if (
                List.size(values) > Types.MAX_PRIVATE_STAGES or
                acceptedCiphertext +
                    cleanupState.remaining_staged_ciphertext !=
                    mem.staged_ciphertext_bytes or
                reservedCiphertext !=
                    mem.reserved_staged_ciphertext_bytes or
                reservedCleanupJobs !=
                    mem.reserved_cleanup_jobs or
                reservedPhysical !=
                    mem.reserved_physical_private_bytes or
                mem.physical_private_bytes + reservedPhysical >
                    Types.MAX_PHYSICAL_PRIVATE_BYTES
            ) return #err(Types.reject(#corrupt_state));
            #ok(List.toArray(values));
        };

        func validAbsentState() : Bool {
            mem.vault == null and
            mem.next_stage_id == 1 and
            mem.next_job_id == 1 and
            Map.size(mem.nodes_by_id) == 0 and
            Map.size(mem.children_by_name) == 0 and
            Map.size(mem.blocks) == 0 and
            Map.size(mem.stages) == 0 and
            Map.size(mem.stages_by_request) == 0 and
            Map.size(mem.private_receipts) == 0 and
            Map.size(mem.private_receipts_by_expiry) == 0 and
            Map.size(mem.private_receipt_identity_owners) == 0 and
            Map.size(mem.delete_jobs) == 0 and
            mem.node_count == 0 and
            mem.committed_private_plaintext_bytes == 0 and
            mem.committed_ciphertext_bytes == 0 and
            mem.staged_ciphertext_bytes == 0 and
            mem.reserved_staged_ciphertext_bytes == 0 and
            mem.physical_private_bytes == 0 and
            mem.reserved_physical_private_bytes == 0 and
            mem.reserved_cleanup_jobs == 0;
        };

        func privateStageTargets(
            stage : Memory.PrivateStage
        ) : [Types.OperationWriteTargetNode] {
            let values = List.empty<Types.OperationWriteTargetNode>();
            for (mutation in stage.commit_plan.node_mutations.values()) {
                switch (mutation.replacement) {
                    case (?node) {
                        let explicit =
                            mutation.expected == null or
                            (switch (mutation.expected) {
                                case (?old) {
                                    old.metadata_revision !=
                                        node.metadata_revision;
                                };
                                case null true;
                            });
                        if (explicit) List.add(values, {
                            node_id = mutation.node_id;
                            content_id = switch (Tree.content(node)) {
                                case (?content) ?content.content_id;
                                case null null;
                            };
                        });
                    };
                    case null {};
                };
            };
            List.toArray(values);
        };

        func privateStageReceiptTargets(
            stage : Memory.PrivateStage
        ) : [Memory.PrivateReceiptTargetNode] {
            let values = List.empty<Memory.PrivateReceiptTargetNode>();
            for (target in privateStageTargets(stage).values()) {
                List.add(values, {
                    node_id = target.node_id;
                    content_id = target.content_id;
                });
            };
            List.toArray(values);
        };

        func publicUsage() : Types.Result<Types.PublicUsage> {
            switch (certifiedAssets.usage()) {
                case (#err(error)) #err(capabilityError(error));
                case (#ok(value)) {
                    let current = value.current;
                    let ?liveEntries = nat64(current.live_entries) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?occupied = nat64(current.occupied_entry_slots) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?committed = nat64(current.committed_body_bytes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?reservedCommitted =
                        nat64(current.reserved_committed_body_bytes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?allocated = nat64(current.allocated_body_bytes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?metadata = nat64(current.charged_metadata_bytes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?accepted = nat64(current.accepted_staged_bytes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?reserved = nat64(current.reserved_staged_bytes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?detached = nat64(current.detached_charged_bytes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?active = nat64(current.active_stages) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?reservedEntries =
                        nat64(current.reserved_entry_slots) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?lanes = nat64(current.receipt_lanes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?general = nat64(current.general_receipt_lanes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?reservedGeneral =
                        nat64(current.reserved_general_receipt_lanes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?reservedRevocation =
                        nat64(current.reserved_revocation_lanes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?filledRevocation =
                        nat64(current.filled_revocation_lanes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?nonceIndexes =
                        nat64(current.receipt_nonce_indexes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?expiryIndexes =
                        nat64(current.receipt_expiry_indexes) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let ?jobs = nat64(current.cleanup_jobs) else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let manifest = limits(value.manifest_limits);
                    let #ok(manifestLimits) = manifest else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    let effective = limits(value.effective_limits);
                    let #ok(effectiveLimits) = effective else {
                        return #err(Types.reject(#corrupt_state));
                    };
                    #ok({
                        current = {
                            live_entries = liveEntries;
                            occupied_entry_slots = occupied;
                            committed_body_bytes = committed;
                            reserved_committed_body_bytes =
                                reservedCommitted;
                            allocated_body_bytes = allocated;
                            charged_metadata_bytes = metadata;
                            accepted_staged_bytes = accepted;
                            reserved_staged_bytes = reserved;
                            detached_charged_bytes = detached;
                            active_stages = active;
                            reserved_entry_slots = reservedEntries;
                            receipt_lanes = lanes;
                            general_receipt_lanes = general;
                            reserved_general_receipt_lanes = reservedGeneral;
                            reserved_revocation_lanes =
                                reservedRevocation;
                            filled_revocation_lanes = filledRevocation;
                            receipt_nonce_indexes = nonceIndexes;
                            receipt_expiry_indexes = expiryIndexes;
                            cleanup_jobs = jobs;
                        };
                        manifest_limits = manifestLimits;
                        effective_limits = effectiveLimits;
                    });
                };
            };
        };

        func limits(
            value : NeutronCapabilities.Limits
        ) : Types.Result<Types.PublicUsageLimits> {
            let ?entries = nat64(value.entries) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?committed = nat64(value.committed_bytes) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?objectBytes = nat64(value.object_bytes) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?staged = nat64(value.staged_bytes) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?pending = nat64(value.pending_stages) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?operations = nat64(value.batch_operations) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?batch = nat64(value.batch_bytes) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?general = nat64(value.general_receipts) else {
                return #err(Types.reject(#corrupt_state));
            };
            let ?revocations = nat64(value.revocation_lanes) else {
                return #err(Types.reject(#corrupt_state));
            };
            #ok({
                entries;
                committed_bytes = committed;
                object_bytes = objectBytes;
                staged_bytes = staged;
                pending_stages = pending;
                batch_operations = operations;
                batch_bytes = batch;
                general_receipts = general;
                revocation_lanes = revocations;
            });
        };

        func operationMatches(
            outer : ?Types.VaultWriteOperation,
            inner : ?{
                #initialize : Frames.VaultInitializeFrame;
                #rewrap : Frames.VaultRewrapFrame;
            },
        ) : Bool {
            switch (outer, inner) {
                case (?#initialize, ?#initialize(_)) true;
                case (?#rewrap, ?#rewrap(_)) true;
                case (_) false;
            };
        };

        func mutationActionMatches(
            outer : ?Types.MutationAction,
            inner : ?{ #create_folder; #rename; #move },
        ) : Bool {
            switch (outer, inner) {
                case (?#create_folder, ?#create_folder) true;
                case (?#rename, ?#rename) true;
                case (?#move, ?#move) true;
                case (_) false;
            };
        };

        func vaultReceipt(
            requestId : Types.Id128,
            fingerprint : Types.Digest256,
            expectedRevision : ?Nat64,
            revision : Nat64,
            initialized : Bool,
            at : Nat64,
        ) : Memory.PrivateReceipt {
            {
                request_fingerprint = fingerprint;
                outcome = #vault({
                    request_id = requestId;
                    expected_record_revision = expectedRevision;
                    record_revision = revision;
                    initialized;
                });
                completed_at_ns = at;
                terminal_kind = null;
                expires_at_ns = deadline(at, Types.RECEIPT_RETENTION_NS);
            };
        };

        func mutationReceipt(
            requestId : Types.Id128,
            fingerprint : Types.Digest256,
            nodeId : Types.Id128,
            node : Memory.Node,
            at : Nat64,
        ) : Memory.PrivateReceipt {
            {
                request_fingerprint = fingerprint;
                outcome = #mutation({
                    request_id = requestId;
                    node_id = nodeId;
                    parent_id = node.parent_id;
                    structural_revision = node.structural_revision;
                    metadata_revision = node.metadata_revision;
                });
                completed_at_ns = at;
                terminal_kind = null;
                expires_at_ns = deadline(at, Types.RECEIPT_RETENTION_NS);
            };
        };

        func privateReceipt(
            requestId : Types.Id128,
            fingerprint : Types.Digest256,
        ) : Types.Result<?Memory.PrivateReceipt> {
            switch (
                Map.get(
                    mem.private_receipts,
                    Keys.compareId128,
                    requestId,
                )
            ) {
                case null #ok(null);
                case (?receipt) {
                    if (receipt.expires_at_ns <= nowNs()) {
                        if (
                            Map.get(
                                mem.private_receipts_by_expiry,
                                Keys.comparePrivateReceiptExpiryKey,
                                (
                                    receipt.expires_at_ns,
                                    requestId.hi,
                                    requestId.lo,
                                ),
                            ) == null
                        ) return #err(
                            Types.reject(#corrupt_state)
                        );
                        return #ok(null);
                    };
                    if (receipt.request_fingerprint != fingerprint) {
                        #err(Types.reject(#conflict));
                    } else {
                        #ok(?receipt);
                    };
                };
            };
        };

        func ensureExpiredPrivateReceiptConsumed(
            requestId : Types.Id128
        ) : UnitResult {
            switch (
                Map.get(
                    mem.private_receipts,
                    Keys.compareId128,
                    requestId,
                )
            ) {
                case null #ok(());
                case (?receipt) {
                    if (receipt.expires_at_ns > nowNs()) {
                        return #err(Types.reject(#conflict));
                    };
                    if (
                        Map.get(
                            mem.private_receipts_by_expiry,
                            Keys.comparePrivateReceiptExpiryKey,
                            (
                                receipt.expires_at_ns,
                                requestId.hi,
                                requestId.lo,
                            ),
                        ) == null
                    ) return #err(
                        Types.reject(#corrupt_state)
                    );
                    #err(Types.retry(
                        #busy,
                        receipt.expires_at_ns,
                    ));
                };
            };
        };

        func ensureReceiptLane() : UnitResult {
            if (
                Map.size(mem.private_receipts) +
                    privateStageCount() <
                    Types.MAX_PRIVATE_RECEIPTS
            ) return #ok(());
            let iterator = Map.entries(mem.private_receipts_by_expiry);
            let ?(key, _) = iterator.next() else {
                return #err(Types.reject(#corrupt_state));
            };
            #err(Types.retry(#busy, key.0));
        };

        func ensurePrivateStageReceiptLane() : UnitResult {
            ensureReceiptLane();
        };

        func idIn(
            values : [Types.Id128],
            wanted : Types.Id128,
        ) : Bool {
            for (value in values.values()) {
                if (value == wanted) return true;
            };
            false;
        };

        func privateReceiptIdentityGrowthCharge(
            receipt : Memory.PrivateReceipt
        ) : Nat {
            var rows = 0;
            for (
                id in
                ReceiptOwnership.receipt(receipt).row_ids.values()
            ) {
                if (
                    Map.get(
                        mem.private_receipt_identity_owners,
                        Keys.compareId128,
                        id,
                    ) == null
                ) rows += 1;
            };
            rows * Accounting.privateReceiptIdentityRowCharge();
        };

        func privateReceiptInsertionCharge(
            receipt : Memory.PrivateReceipt
        ) : Nat {
            Accounting.receiptCharge(receipt) +
            Accounting.privateReceiptIndexCharge() +
            privateReceiptIdentityGrowthCharge(receipt);
        };

        func privateReceiptMaximumCharge(
            receipt : Memory.PrivateReceipt
        ) : Nat {
            Accounting.receiptCharge(receipt) +
            Accounting.privateReceiptIndexCharge() +
            Accounting.privateReceiptMaximumIdentityCharge(receipt);
        };

        func privateReceiptIdentityRemovalRows(
            receipt : Memory.PrivateReceipt
        ) : Nat {
            let identities = ReceiptOwnership.receipt(receipt);
            var rows = 0;
            for (id in identities.row_ids.values()) {
                let ?owner = Map.get(
                    mem.private_receipt_identity_owners,
                    Keys.compareId128,
                    id,
                ) else Runtime.trap(
                    "private receipt identity index invariant"
                );
                let nodeDelta =
                    if (idIn(identities.node_ids, id)) 1 else 0;
                let contentDelta =
                    if (idIn(identities.content_ids, id)) 1 else 0;
                let nodeCount = Nat16.toNat(owner.node_count);
                let contentCount = Nat16.toNat(owner.content_count);
                if (
                    nodeCount < nodeDelta or
                    contentCount < contentDelta
                ) Runtime.trap(
                    "private receipt identity count invariant"
                );
                if (
                    nodeCount == nodeDelta and
                    contentCount == contentDelta
                ) rows += 1;
            };
            rows;
        };

        func privateReceiptRemovalCharge(
            receipt : Memory.PrivateReceipt
        ) : Nat {
            Accounting.receiptCharge(receipt) +
            Accounting.privateReceiptIndexCharge() +
            privateReceiptIdentityRemovalRows(receipt) *
                Accounting.privateReceiptIdentityRowCharge();
        };

        func incrementPrivateReceiptIdentity(
            id : Types.Id128,
            node : Bool,
        ) {
            let current : Memory.PrivateReceiptIdentityOwner = switch (
                Map.get(
                    mem.private_receipt_identity_owners,
                    Keys.compareId128,
                    id,
                )
            ) {
                case null {
                    { node_count = 0; content_count = 0 };
                };
                case (?value) value;
            };
            let nodeCount = Nat16.toNat(current.node_count);
            let contentCount = Nat16.toNat(current.content_count);
            if (
                (node and nodeCount == Nat16.toNat(Nat16.maxValue)) or
                (
                    not node and
                    contentCount == Nat16.toNat(Nat16.maxValue)
                )
            ) Runtime.trap(
                "private receipt identity count overflow"
            );
            Map.add(
                mem.private_receipt_identity_owners,
                Keys.compareId128,
                id,
                if (node) {
                    {
                        node_count = Nat16.fromNat(nodeCount + 1);
                        content_count = current.content_count;
                    };
                } else {
                    {
                        node_count = current.node_count;
                        content_count =
                            Nat16.fromNat(contentCount + 1);
                    };
                },
            );
        };

        func decrementPrivateReceiptIdentity(
            id : Types.Id128,
            node : Bool,
        ) : Bool {
            let ?current = Map.get(
                mem.private_receipt_identity_owners,
                Keys.compareId128,
                id,
            ) else Runtime.trap(
                "private receipt identity index invariant"
            );
            let nodeCount = Nat16.toNat(current.node_count);
            let contentCount = Nat16.toNat(current.content_count);
            if (
                (node and nodeCount == 0) or
                (not node and contentCount == 0)
            ) Runtime.trap(
                "private receipt identity count invariant"
            );
            let replacement : Memory.PrivateReceiptIdentityOwner =
                if (node) {
                    {
                        node_count = Nat16.fromNat(nodeCount - 1);
                        content_count = current.content_count;
                    };
                } else {
                    {
                        node_count = current.node_count;
                        content_count =
                            Nat16.fromNat(contentCount - 1);
                    };
                };
            if (
                replacement.node_count == 0 and
                replacement.content_count == 0
            ) {
                ignore Map.remove(
                    mem.private_receipt_identity_owners,
                    Keys.compareId128,
                    id,
                );
                true;
            } else {
                Map.add(
                    mem.private_receipt_identity_owners,
                    Keys.compareId128,
                    id,
                    replacement,
                );
                false;
            };
        };

        func insertPrivateReceipt(
            requestId : Types.Id128,
            receipt : Memory.PrivateReceipt,
        ) {
            let expiryKey = (
                receipt.expires_at_ns,
                requestId.hi,
                requestId.lo,
            );
            if (
                Map.get(
                    mem.private_receipts,
                    Keys.compareId128,
                    requestId,
                ) != null or
                Map.get(
                    mem.private_receipts_by_expiry,
                    Keys.comparePrivateReceiptExpiryKey,
                    expiryKey,
                ) != null
            ) Runtime.trap("private receipt insertion invariant");
            let charge = privateReceiptInsertionCharge(receipt);
            let identities = ReceiptOwnership.receipt(receipt);
            for (id in identities.node_ids.values()) {
                incrementPrivateReceiptIdentity(id, true);
            };
            for (id in identities.content_ids.values()) {
                incrementPrivateReceiptIdentity(id, false);
            };
            Map.add(
                mem.private_receipts,
                Keys.compareId128,
                requestId,
                receipt,
            );
            Map.add(
                mem.private_receipts_by_expiry,
                Keys.comparePrivateReceiptExpiryKey,
                expiryKey,
                (),
            );
            Accounting.addPhysical(mem, charge);
        };

        func removePrivateReceipt(
            requestId : Types.Id128,
            receipt : Memory.PrivateReceipt,
        ) {
            let expiryKey = (
                receipt.expires_at_ns,
                requestId.hi,
                requestId.lo,
            );
            if (
                Map.get(
                    mem.private_receipts,
                    Keys.compareId128,
                    requestId,
                ) != ?receipt or
                Map.get(
                    mem.private_receipts_by_expiry,
                    Keys.comparePrivateReceiptExpiryKey,
                    expiryKey,
                ) == null
            ) Runtime.trap("private receipt index invariant");
            let identityRows =
                privateReceiptIdentityRemovalRows(receipt);
            let charge = privateReceiptRemovalCharge(receipt);
            if (mem.physical_private_bytes < charge) {
                Runtime.trap("private receipt charge invariant");
            };
            let identities = ReceiptOwnership.receipt(receipt);
            var removedIdentityRows = 0;
            for (id in identities.node_ids.values()) {
                if (decrementPrivateReceiptIdentity(id, true)) {
                    removedIdentityRows += 1;
                };
            };
            for (id in identities.content_ids.values()) {
                if (decrementPrivateReceiptIdentity(id, false)) {
                    removedIdentityRows += 1;
                };
            };
            if (removedIdentityRows != identityRows) {
                Runtime.trap("private receipt identity removal invariant");
            };
            ignore Map.remove(
                mem.private_receipts_by_expiry,
                Keys.comparePrivateReceiptExpiryKey,
                expiryKey,
            );
            ignore Map.remove(
                mem.private_receipts,
                Keys.compareId128,
                requestId,
            );
            Accounting.removePhysical(
                mem,
                charge,
            );
        };

        func prunePrivateReceiptRows(
            maxEntries : Nat,
            maxWork : Nat,
        ) : CleanupPage {
            let at = nowNs();
            var keepGoing = true;
            var removedEntries = 0;
            var entryUnits = 0;
            var charged = 0;
            var work = 0;
            while (
                keepGoing and
                entryUnits + 2 <= maxEntries and
                work + 1 <= maxWork and cleanupInstructionOpen()
            ) {
                let iterator = Map.entries(mem.private_receipts_by_expiry);
                switch (iterator.next()) {
                    case null keepGoing := false;
                    case (?(key, _)) {
                        if (key.0 > at) {
                            keepGoing := false;
                        } else {
                            let requestId = { hi = key.1; lo = key.2 };
                            switch (
                                Map.get(
                                    mem.private_receipts,
                                    Keys.compareId128,
                                    requestId,
                                )
                            ) {
                                case (?receipt) if (
                                    receipt.expires_at_ns == key.0
                                ) {
                                    let identities =
                                        ReceiptOwnership.receipt(receipt);
                                    let touchedRows =
                                        identities.row_ids.size();
                                    let removedIdentityRows =
                                        privateReceiptIdentityRemovalRows(
                                            receipt
                                        );
                                    let neededEntries =
                                        2 + touchedRows;
                                    let neededWork = 1 + touchedRows;
                                    if (
                                        neededEntries >
                                            Types.MAX_CLEANUP_ENTRIES_PER_PAGE or
                                        neededWork >
                                            Types.MAX_CLEANUP_WORK_UNITS_PER_PAGE
                                    ) Runtime.trap(
                                        "private receipt cleanup bound invariant"
                                    );
                                    if (
                                        entryUnits + neededEntries >
                                            maxEntries or
                                        work + neededWork > maxWork
                                    ) {
                                        keepGoing := false;
                                    } else {
                                    let receiptCharge =
                                        privateReceiptRemovalCharge(receipt);
                                    removePrivateReceipt(requestId, receipt);
                                    removedEntries +=
                                        2 + removedIdentityRows;
                                    entryUnits += neededEntries;
                                    charged += receiptCharge;
                                    work += neededWork;
                                    };
                                };
                                case (_) Runtime.trap(
                                    "private receipt expiry invariant"
                                );
                            };
                        };
                    };
                };
            };
            cleanupPageWithEntryUnits(
                removedEntries,
                entryUnits,
                0,
                0,
                charged,
                work,
            );
        };

        func capabilityError(
            error : NeutronCapabilities.Error
        ) : Types.Rejection {
            switch (error) {
                case (#invalid) Types.reject(#invalid_request);
                case (#stale_scope) Types.reject(#temporarily_unavailable);
                case (#stale_generation(_)) Types.reject(#stale_revision);
                case (#disabled) Types.reject(#temporarily_unavailable);
                case (#frozen) Types.reject(#temporarily_unavailable);
                case (#not_found) Types.reject(#not_found);
                case (#retired_key) Types.reject(#superseded);
                case (#conflict(_)) Types.reject(#conflict);
                case (#quota) Types.reject(#quota);
                case (#receipt_full) Types.reject(#busy);
                case (#aborted) Types.reject(#aborted);
                case (#expired) Types.reject(#expired);
                case (#incomplete(_)) Types.reject(#conflict);
                case (#not_ready) Types.reject(#not_ready);
                case (#generation_exhausted) Types.reject(#quota);
                case (#revision_exhausted) Types.reject(#quota);
                case (#low_cycles) Types.reject(#temporarily_unavailable);
                case (#busy) Types.reject(#busy);
            };
        };
    };

    func nat64(value : Nat) : ?Nat64 {
        if (value > Nat64.toNat(Nat64.maxValue)) null else {
            ?Nat64.fromNat(value);
        };
    };

    func deadline(start : Nat64, interval : Nat64) : Nat64 {
        if (start > Nat64.maxValue - interval) {
            Nat64.maxValue;
        } else {
            start + interval;
        };
    };
};
