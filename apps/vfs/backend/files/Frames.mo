import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Sha256 "mo:sha2/Sha256";
import CandidGuard "CandidGuard";
import Keys "Keys";
import Types "Types";

// Motoko mirror of candid/files-v2-frames.did. Keep field names and nesting
// structurally identical; the outer actor ABI remains in main.mo.
module {
    public type PayloadSlice = { offset : Nat32; length : Nat32 };
    public type Digest256 = {
        a : Nat64;
        b : Nat64;
        c : Nat64;
        d : Nat64;
    };
    public type FrameNodeKind = { #folder; #file };
    public type FrameContentCryptoProfile = { #aes_256_gcm_files_v2 };

    public type FrameListCursor = {
        parent_id : Types.Id128;
        children_revision : Nat64;
        last_name_tag : Digest256;
    };

    public type FrameNodeSummary = {
        node_id : Types.Id128;
        parent_id : Types.Id128;
        kind : ?FrameNodeKind;
        name_tag : Digest256;
        declared_name_scalars : Nat16;
        structural_revision : Nat64;
        metadata_revision : Nat64;
        children_revision : Nat64;
        subtree_height : Nat8;
        max_relative_path_scalars : Nat16;
        subtree_plaintext_bytes : Nat64;
    };

    public type FrameContentSummary = {
        content_id : Types.Id128;
        block_count : Nat32;
        ciphertext_bytes : Nat64;
        crypto_profile : ?FrameContentCryptoProfile;
    };

    public type VaultReadFrameControl = {
        format : Nat16;
        vault_id : Types.Id128;
        vault_salt : Digest256;
        slot_generation : Nat64;
        public_key_fingerprint : Digest256;
        root_commitment : Digest256;
        record_revision : Nat64;
        root_structural_revision : Nat64;
        root_metadata_revision : Nat64;
        root_children_revision : Nat64;
        ibe_wrapped_root_key : PayloadSlice;
        encrypted_root_metadata : PayloadSlice;
        raw_payload_bytes : Nat32;
    };

    public type VaultInitializeFrame = {
        format : Nat16;
        vault_id : Types.Id128;
        vault_salt : Digest256;
        slot_generation : Nat64;
        public_key_fingerprint : Digest256;
        root_commitment : Digest256;
        root_structural_revision : Nat64;
        root_metadata_revision : Nat64;
        root_children_revision : Nat64;
        ibe_wrapped_root_key : PayloadSlice;
        encrypted_root_metadata : PayloadSlice;
    };

    public type VaultRewrapFrame = {
        format : Nat16;
        vault_id : Types.Id128;
        vault_salt : Digest256;
        slot_generation : Nat64;
        public_key_fingerprint : Digest256;
        root_commitment : Digest256;
        ibe_wrapped_root_key : PayloadSlice;
    };

    public type VaultWriteFrameControl = {
        request_id : Types.Id128;
        expected_record_revision : ?Nat64;
        proposed_record_revision : Nat64;
        operation : ?{
            #initialize : VaultInitializeFrame;
            #rewrap : VaultRewrapFrame;
        };
        raw_payload_bytes : Nat32;
    };

    public type ListFrameItem = {
        node : FrameNodeSummary;
        content : ?FrameContentSummary;
        encrypted_metadata : PayloadSlice;
    };

    public type ListFrameControl = {
        parent_id : Types.Id128;
        structural_revision : Nat64;
        children_revision : Nat64;
        items : [ListFrameItem];
        next_cursor : ?FrameListCursor;
        raw_payload_bytes : Nat32;
    };

    public type LookupContentFrame = {
        summary : FrameContentSummary;
        wrapped_content_key : PayloadSlice;
    };

    public type LookupFrameControl = {
        node : FrameNodeSummary;
        content : ?LookupContentFrame;
        encrypted_metadata : PayloadSlice;
        raw_payload_bytes : Nat32;
    };

    public type ReadFirstFrame = {
        node : FrameNodeSummary;
        content : FrameContentSummary;
        encrypted_metadata : PayloadSlice;
        wrapped_content_key : PayloadSlice;
        index : Nat32;
        ciphertext_block : PayloadSlice;
        raw_payload_bytes : Nat32;
    };

    public type ReadContinuationFrame = {
        node_id : Types.Id128;
        structural_revision : Nat64;
        metadata_revision : Nat64;
        content_id : Types.Id128;
        index : Nat32;
        block_count : Nat32;
        ciphertext_block_bytes : Nat32;
        ciphertext_total_bytes : Nat64;
        ciphertext_block : PayloadSlice;
        raw_payload_bytes : Nat32;
    };

    public type ReadBlockFrameControl = {
        frame : ?{
            #first : ReadFirstFrame;
            #continuation : ReadContinuationFrame;
        };
    };

    public type NodeTransitionFrame = {
        node_id : Types.Id128;
        expected_parent_id : ?Types.Id128;
        proposed_parent_id : Types.Id128;
        requested_kind : ?FrameNodeKind;
        expected_name_tag : ?Digest256;
        proposed_name_tag : Digest256;
        declared_name_scalars : Nat16;
        expected_structural_revision : ?Nat64;
        proposed_structural_revision : Nat64;
        expected_metadata_revision : ?Nat64;
        proposed_metadata_revision : Nat64;
        expected_children_revision : ?Nat64;
        proposed_children_revision : Nat64;
        expected_subtree_height : ?Nat8;
        proposed_subtree_height : Nat8;
        expected_max_relative_path_scalars : ?Nat16;
        proposed_max_relative_path_scalars : Nat16;
        expected_subtree_plaintext_bytes : ?Nat64;
        proposed_subtree_plaintext_bytes : Nat64;
        encrypted_metadata : PayloadSlice;
    };

    public type FolderAggregateTransition = {
        node_id : Types.Id128;
        expected_structural_revision : Nat64;
        expected_children_revision : Nat64;
    };

    public type ChildIndexTransition = {
        parent_id : Types.Id128;
        name_tag : Digest256;
        expected_node_id : ?Types.Id128;
        proposed_node_id : ?Types.Id128;
    };

    public type MutateFrameControl = {
        request_id : Types.Id128;
        action : ?{ #create_folder; #rename; #move };
        node : NodeTransitionFrame;
        folder_transitions : [FolderAggregateTransition];
        child_index_transitions : [ChildIndexTransition];
        raw_payload_bytes : Nat32;
    };

    public type WriteIntent = { #create; #replace; #batch };

    public type WriteContentPlan = {
        content_id : Types.Id128;
        wrapped_content_key : PayloadSlice;
        plaintext_block_lengths : [Nat32];
        ciphertext_block_lengths : [Nat32];
        ciphertext_bytes : Nat64;
        crypto_profile : ?FrameContentCryptoProfile;
    };

    public type WriteNodePlan = {
        node : NodeTransitionFrame;
        content : ?WriteContentPlan;
    };

    public type WriteBlockSlice = {
        content_id : Types.Id128;
        block_index : Nat32;
        ciphertext_bytes : Nat32;
        payload : PayloadSlice;
    };

    public type WriteFramePlan = {
        frame_ordinal : Nat8;
        raw_payload_bytes : Nat32;
        blocks : [WriteBlockSlice];
    };

    public type RetiredContent = {
        node_id : Types.Id128;
        content_id : Types.Id128;
        block_count : Nat32;
        ciphertext_bytes : Nat64;
    };

    public type WriteQuotaTransition = {
        expected_node_count : Nat64;
        proposed_node_count : Nat64;
        expected_committed_plaintext_bytes : Nat64;
        proposed_committed_plaintext_bytes : Nat64;
        expected_committed_ciphertext_bytes : Nat64;
        proposed_committed_ciphertext_bytes : Nat64;
        gross_peak_physical_bytes : Nat64;
    };

    public type WriteFirstFrame = {
        request_id : Types.Id128;
        intent : ?WriteIntent;
        frame_ordinal : Nat8;
        frame_count : Nat8;
        final : Bool;
        nodes : [WriteNodePlan];
        folder_transitions : [FolderAggregateTransition];
        child_index_transitions : [ChildIndexTransition];
        retired_contents : [RetiredContent];
        quota : WriteQuotaTransition;
        frames : [WriteFramePlan];
        raw_payload_bytes : Nat32;
    };

    public type WriteContinuationFrame = {
        request_id : Types.Id128;
        stage_id : Nat64;
        frame_ordinal : Nat8;
        final : Bool;
        blocks : [WriteBlockSlice];
        raw_payload_bytes : Nat32;
    };

    public type WriteBlockFrameControl = {
        frame : ?{
            #first : WriteFirstFrame;
            #continuation : WriteContinuationFrame;
        };
    };

    public type SplitFrame = {
        control : Blob;
        raw_payload : RawPayload;
        digest : Types.Digest256;
    };

    public type RawPayload = {
        frame : Blob;
        start : Nat;
        length : Nat;
    };

    public type Decoded<T> = {
        control : T;
        raw_payload : RawPayload;
        digest : Types.Digest256;
    };

    public type DecodedMutate = {
        control : MutateFrameControl;
        raw_payload : RawPayload;
        digest : Types.Digest256;
    };

    public func digestFromTag(value : Types.Digest256) : Digest256 {
        { a = value.0; b = value.1; c = value.2; d = value.3 };
    };

    public func digestToTag(value : Digest256) : Types.Digest256 {
        (value.a, value.b, value.c, value.d);
    };

    public func decodeVaultWrite(frame : Blob) : ?Decoded<VaultWriteFrameControl> {
        let ?parts = split(frame, Types.MAX_VAULT_FRAME_BYTES) else return null;
        if (
            not CandidGuard.validOne(
                parts.control,
                Types.MAX_CONTROL_ALLOCATION_BYTES,
            )
        ) return null;
        let decoded : ?VaultWriteFrameControl = from_candid parts.control;
        let ?control = decoded else return null;
        if (not validVaultWrite(control, parts.raw_payload.length)) return null;
        ?{ control; raw_payload = parts.raw_payload; digest = parts.digest };
    };

    public func decodeMutate(frame : Blob) : ?DecodedMutate {
        decodeMutationFrame(frame);
    };

    func decodeMutationFrame(
        frame : Blob
    ) : ?DecodedMutate {
        let ?parts = split(frame, Types.MAX_MUTATION_FRAME_BYTES) else return null;
        let ?control = decodeMutateControl(
            parts.control,
            parts.raw_payload.length,
        ) else return null;
        ?{ control; raw_payload = parts.raw_payload; digest = parts.digest };
    };

    func decodeMutateControl(
        candid : Blob,
        rawBytes : Nat,
    ) : ?MutateFrameControl {
        if (
            not CandidGuard.validOne(
                candid,
                Types.MAX_CONTROL_ALLOCATION_BYTES,
            )
        ) return null;
        let decoded : ?MutateFrameControl = from_candid candid;
        let ?control = decoded else return null;
        if (not validMutate(control, rawBytes)) return null;
        ?control;
    };

    public func decodeWriteBlock(
        frame : Blob
    ) : ?Decoded<WriteBlockFrameControl> {
        let ?parts = split(frame, Types.MAX_FRAME_BYTES) else return null;
        if (
            not CandidGuard.validOne(
                parts.control,
                Types.MAX_CONTROL_ALLOCATION_BYTES,
            )
        ) return null;
        let decoded : ?WriteBlockFrameControl = from_candid parts.control;
        let ?control = decoded else return null;
        if (
            parts.control.size() > writeControlLimit(control) or
            not validWrite(control, parts.raw_payload.length)
        ) return null;
        ?{ control; raw_payload = parts.raw_payload; digest = parts.digest };
    };

    public func encodeVaultRead(
        control : VaultReadFrameControl,
        rawPayload : Blob,
    ) : ?Blob {
        if (not validVaultRead(control, rawPayload.size())) return null;
        pack(to_candid (control), rawPayload, Types.MAX_VAULT_FRAME_BYTES);
    };

    public func encodeList(
        control : ListFrameControl,
        rawPayload : Blob,
    ) : ?Blob {
        if (not validList(control, rawPayload.size())) return null;
        pack(to_candid (control), rawPayload, Types.MAX_LIST_FRAME_BYTES);
    };

    public func encodeLookup(
        control : LookupFrameControl,
        rawPayload : Blob,
    ) : ?Blob {
        if (not validLookup(control, rawPayload.size())) return null;
        pack(to_candid (control), rawPayload, Types.MAX_LOOKUP_FRAME_BYTES);
    };

    public func encodeRead(
        control : ReadBlockFrameControl,
        rawPayload : Blob,
    ) : ?Blob {
        if (not validRead(control, rawPayload.size())) return null;
        pack(to_candid (control), rawPayload, Types.MAX_FRAME_BYTES);
    };

    public func split(frame : Blob, maximumBytes : Nat) : ?SplitFrame {
        if (frame.size() < 4 or frame.size() > maximumBytes) return null;
        let controlLength =
            Nat8.toNat(frame[0]) * 16_777_216 +
            Nat8.toNat(frame[1]) * 65_536 +
            Nat8.toNat(frame[2]) * 256 +
            Nat8.toNat(frame[3]);
        if (
            controlLength == 0 or controlLength > Types.MAX_CONTROL_ALLOCATION_BYTES or
            controlLength > frame.size() - 4
        ) return null;
        let control = Blob.fromArray(
            Array.tabulate<Nat8>(
                controlLength,
                func(index) { frame[index + 4] },
            )
        );
        let rawStart = 4 + controlLength;
        let hash = Sha256.fromBlob(#sha256, frame);
        let ?digest = Keys.tag256FromBytes(hash) else return null;
        ?{
            control;
            raw_payload = {
                frame;
                start = rawStart;
                length = frame.size() - rawStart;
            };
            digest;
        };
    };

    public func payloadSlice(raw : RawPayload, slice : PayloadSlice) : ?Blob {
        let offset = Nat32.toNat(slice.offset);
        let length = Nat32.toNat(slice.length);
        if (
            length == 0 or offset > raw.length or
            length > raw.length - offset
        ) {
            return null;
        };
        ?Blob.fromArray(
            Array.tabulate<Nat8>(
                length,
                func(index) { raw.frame[raw.start + offset + index] },
            )
        );
    };

    public func append(parts : [Blob]) : Blob {
        var total = 0;
        for (part in parts.values()) total += part.size();
        var currentPart = 0;
        var currentStart = 0;
        Blob.fromArray(
            Array.tabulate<Nat8>(
                total,
                func(index) {
                    while (
                        index >=
                        currentStart + parts[currentPart].size()
                    ) {
                        currentStart += parts[currentPart].size();
                        currentPart += 1;
                    };
                    parts[currentPart][index - currentStart];
                },
            )
        );
    };

    func pack(control : Blob, raw : Blob, maximumBytes : Nat) : ?Blob {
        if (
            control.size() == 0 or control.size() > Types.MAX_CONTROL_ALLOCATION_BYTES or
            control.size() > 4_294_967_295 or
            4 + control.size() + raw.size() > maximumBytes
        ) return null;
        let length = Nat32.fromNat(control.size());
        let header = Blob.fromArray([
            Nat8.fromNat(Nat32.toNat(length >> 24) % 256),
            Nat8.fromNat(Nat32.toNat(length >> 16) % 256),
            Nat8.fromNat(Nat32.toNat(length >> 8) % 256),
            Nat8.fromNat(Nat32.toNat(length) % 256),
        ]);
        ?append([header, control, raw]);
    };

    func validVaultWrite(
        control : VaultWriteFrameControl,
        rawBytes : Nat,
    ) : Bool {
        if (Nat32.toNat(control.raw_payload_bytes) != rawBytes) return false;
        switch (control.operation) {
            case null false;
            case (?#initialize(value)) {
                validPartition(
                    [value.ibe_wrapped_root_key, value.encrypted_root_metadata],
                    rawBytes,
                ) and validMetadataSlice(value.encrypted_root_metadata);
            };
            case (?#rewrap(value)) {
                validPartition([value.ibe_wrapped_root_key], rawBytes);
            };
        };
    };

    func validMutate(
        control : MutateFrameControl,
        rawBytes : Nat,
    ) : Bool {
        if (
            control.action == null or
            Nat32.toNat(control.raw_payload_bytes) != rawBytes or
            control.folder_transitions.size() >
                Types.MAX_MUTATION_FOLDER_TRANSITIONS or
            control.child_index_transitions.size() >
                Types.MAX_MUTATION_CHILD_INDEX_TRANSITIONS
        ) return false;
        validMetadataSlice(control.node.encrypted_metadata) and
        validPartition([control.node.encrypted_metadata], rawBytes);
    };

    func writeControlLimit(control : WriteBlockFrameControl) : Nat {
        switch (control.frame) {
            case (?#first(first)) switch (first.intent) {
                case (?#batch) Types.MAX_BATCH_WRITE_CONTROL_BYTES;
                case (_) Types.MAX_SINGLE_WRITE_CONTROL_BYTES;
            };
            case (_) Types.MAX_SINGLE_WRITE_CONTROL_BYTES;
        };
    };

    func validWrite(control : WriteBlockFrameControl, rawBytes : Nat) : Bool {
        switch (control.frame) {
            case null false;
            case (?#continuation(value)) {
                if (
                    Nat32.toNat(value.raw_payload_bytes) != rawBytes or
                    value.blocks.size() == 0 or
                    value.blocks.size() > Types.MAX_BATCH_BLOCKS
                ) return false;
                validBlockSlices(value.blocks, rawBytes);
            };
            case (?#first(value)) {
                if (
                    value.intent == null or value.frame_ordinal != 0 or
                    value.frame_count == 0 or
                    Nat8.toNat(value.frame_count) >
                        (switch (value.intent) {
                            case (?#batch) Types.MAX_BATCH_FRAMES;
                            case (_) Types.MAX_SINGLE_WRITE_FRAMES;
                        }) or
                    value.frames.size() != Nat8.toNat(value.frame_count) or
                    Nat32.toNat(value.raw_payload_bytes) != rawBytes or
                    value.nodes.size() == 0 or
                    not validWritePlanBounds(value) or
                    value.retired_contents.size() > Types.MAX_BATCH_BLOCKS
                ) return false;
                let firstSlices = Array.tabulate<PayloadSlice>(
                    countFirstSlices(value),
                    func(index) { firstSliceAt(value, index) },
                );
                if (not validPartition(firstSlices, rawBytes)) return false;
                var ordinal = 0;
                var blocks = 0;
                for (plan in value.frames.values()) {
                    if (Nat8.toNat(plan.frame_ordinal) != ordinal) return false;
                    if (plan.blocks.size() == 0) return false;
                    blocks += plan.blocks.size();
                    if (ordinal == 0) {
                        if (
                            Nat32.toNat(plan.raw_payload_bytes) != rawBytes or
                            not validBlockSlicesWithin(plan.blocks, rawBytes)
                        ) return false;
                    } else if (
                        not validBlockSlices(
                            plan.blocks,
                            Nat32.toNat(plan.raw_payload_bytes),
                        )
                    ) return false;
                    ordinal += 1;
                };
                blocks > 0 and blocks <= Types.MAX_BATCH_BLOCKS and
                validWriteGeometry(value) and validWriteBlockPlan(value);
            };
        };
    };

    // Nodes, ancestor witnesses, child-index transitions, and retirement
    // descriptors remain independently bounded before service validation.
    // Only a batch additionally shares one 64-entry structural-plan budget;
    // retirement descriptors duplicate target-content identity and are not
    // structural plan entries.
    func validWritePlanBounds(value : WriteFirstFrame) : Bool {
        if (
            value.nodes.size() > Types.MAX_BATCH_PLAN_ENTRIES or
            value.folder_transitions.size() >
                Types.MAX_BATCH_PLAN_ENTRIES or
            value.child_index_transitions.size() >
                Types.MAX_BATCH_PLAN_ENTRIES
        ) return false;
        switch (value.intent) {
            case (?#batch) {
                value.nodes.size() +
                    value.folder_transitions.size() +
                    value.child_index_transitions.size() <=
                    Types.MAX_BATCH_PLAN_ENTRIES;
            };
            case (?#create or ?#replace) true;
            case null false;
        };
    };

    // The first frame is the complete allocation contract. Validate its block
    // graph globally, not just one transport frame at a time: every declared
    // content/index appears exactly once, no undeclared pair appears, and the
    // pinned ciphertext length agrees at every representation.
    func validWriteBlockPlan(value : WriteFirstFrame) : Bool {
        var declaredBlocks = 0;
        var nodeIndex = 0;
        while (nodeIndex < value.nodes.size()) {
            switch (value.nodes[nodeIndex].content) {
                case null {};
                case (?content) {
                    var priorNode = 0;
                    while (priorNode < nodeIndex) {
                        switch (value.nodes[priorNode].content) {
                            case (?prior) if (
                                prior.content_id == content.content_id
                            ) return false;
                            case (_) {};
                        };
                        priorNode += 1;
                    };
                    declaredBlocks += content.ciphertext_block_lengths.size();
                    var blockIndex = 0;
                    while (
                        blockIndex <
                        content.ciphertext_block_lengths.size()
                    ) {
                        var matches = 0;
                        for (frame in value.frames.values()) {
                            for (block in frame.blocks.values()) {
                                if (
                                    block.content_id == content.content_id and
                                    Nat32.toNat(block.block_index) == blockIndex
                                ) {
                                    if (
                                        block.ciphertext_bytes !=
                                            content.ciphertext_block_lengths[
                                                blockIndex
                                            ]
                                    ) return false;
                                    matches += 1;
                                };
                            };
                        };
                        if (matches != 1) return false;
                        blockIndex += 1;
                    };
                };
            };
            nodeIndex += 1;
        };
        var plannedBlocks = 0;
        var frameIndex = 0;
        while (frameIndex < value.frames.size()) {
            let frame = value.frames[frameIndex];
            if (
                frameIndex > 0 and
                Nat32.toNat(frame.raw_payload_bytes) >
                    Types.MAX_FRAME_BYTES -
                    4 -
                    Types.MAX_SINGLE_WRITE_CONTROL_BYTES
            ) return false;
            var index = 0;
            while (index < frame.blocks.size()) {
                let block = frame.blocks[index];
                var declared = false;
                for (node in value.nodes.values()) {
                    switch (node.content) {
                        case (?content) if (
                            content.content_id == block.content_id and
                            Nat32.toNat(block.block_index) <
                                content.ciphertext_block_lengths.size()
                        ) {
                            declared := true;
                        };
                        case (_) {};
                    };
                };
                if (not declared) return false;
                var priorFrame = 0;
                while (priorFrame <= frameIndex) {
                    let priorBlocks = value.frames[priorFrame].blocks;
                    let before =
                        if (priorFrame == frameIndex) index else priorBlocks.size();
                    var priorIndex = 0;
                    while (priorIndex < before) {
                        if (
                            priorBlocks[priorIndex].content_id ==
                                block.content_id and
                            priorBlocks[priorIndex].block_index ==
                                block.block_index
                        ) return false;
                        priorIndex += 1;
                    };
                    priorFrame += 1;
                };
                plannedBlocks += 1;
                index += 1;
            };
            frameIndex += 1;
        };
        declaredBlocks == plannedBlocks;
    };

    func validWriteGeometry(value : WriteFirstFrame) : Bool {
        var plaintextTotal = 0;
        var contentTargets = 0;
        for (node in value.nodes.values()) {
            if (not validMetadataSlice(node.node.encrypted_metadata)) return false;
            switch (node.content) {
                case null {};
                case (?content) {
                    contentTargets += 1;
                    if (
                        content.content_id == Types.ROOT_NODE_ID or
                        content.crypto_profile != ?#aes_256_gcm_files_v2 or
                        content.wrapped_content_key.length != 48 or
                        content.plaintext_block_lengths.size() == 0 or
                        content.plaintext_block_lengths.size() >
                            Types.MAX_BLOCKS_PER_FILE or
                        content.ciphertext_block_lengths.size() !=
                            content.plaintext_block_lengths.size()
                    ) return false;
                    var ciphertextTotal = 0;
                    var filePlaintext = 0;
                    var index = 0;
                    while (index < content.plaintext_block_lengths.size()) {
                        let plain = Nat32.toNat(
                            content.plaintext_block_lengths[index]
                        );
                        let cipher = Nat32.toNat(
                            content.ciphertext_block_lengths[index]
                        );
                        if (
                            plain > Types.MAX_PLAINTEXT_BLOCK_BYTES or
                            cipher != plain + 16
                        ) return false;
                        if (
                            content.plaintext_block_lengths.size() > 1 and
                            ((index == 0 and plain == 0) or
                            (index > 0 and plain !=
                                Types.MAX_PLAINTEXT_BLOCK_BYTES))
                        ) return false;
                        if (
                            content.plaintext_block_lengths.size() == 1 and
                            plain == 0 and cipher != 16
                        ) return false;
                        filePlaintext += plain;
                        ciphertextTotal += cipher;
                        index += 1;
                    };
                    if (
                        filePlaintext > Types.MAX_FILE_PLAINTEXT_BYTES or
                        ciphertextTotal != Nat64.toNat(content.ciphertext_bytes)
                    ) return false;
                    plaintextTotal += filePlaintext;
                };
            };
        };
        switch (value.intent) {
            case (?#batch) {
                contentTargets > 0 and
                contentTargets <= Types.MAX_BATCH_FILES and
                plaintextTotal <= Types.MAX_BATCH_PLAINTEXT_BYTES;
            };
            case (_) contentTargets == 1;
        };
    };

    func countFirstSlices(value : WriteFirstFrame) : Nat {
        var count = value.frames[0].blocks.size();
        for (node in value.nodes.values()) {
            count += 1;
            if (node.content != null) count += 1;
        };
        count;
    };

    func firstSliceAt(value : WriteFirstFrame, wanted : Nat) : PayloadSlice {
        var index = 0;
        for (node in value.nodes.values()) {
            if (index == wanted) return node.node.encrypted_metadata;
            index += 1;
            switch (node.content) {
                case null {};
                case (?content) {
                    if (index == wanted) return content.wrapped_content_key;
                    index += 1;
                };
            };
        };
        value.frames[0].blocks[wanted - index].payload;
    };

    func validBlockSlices(blocks : [WriteBlockSlice], rawBytes : Nat) : Bool {
        validPartition(
            Array.map<WriteBlockSlice, PayloadSlice>(
                blocks,
                func(block) { block.payload },
            ),
            rawBytes,
        ) and validBlockSlicesWithin(blocks, rawBytes);
    };

    func validBlockSlicesWithin(
        blocks : [WriteBlockSlice],
        rawBytes : Nat,
    ) : Bool {
        var index = 0;
        while (index < blocks.size()) {
            let block = blocks[index];
            if (
                block.ciphertext_bytes != block.payload.length or
                not validSlice(block.payload, rawBytes)
            ) return false;
            var prior = 0;
            while (prior < index) {
                if (
                    blocks[prior].content_id == block.content_id and
                    blocks[prior].block_index == block.block_index
                ) return false;
                prior += 1;
            };
            index += 1;
        };
        true;
    };

    func validVaultRead(
        control : VaultReadFrameControl,
        rawBytes : Nat,
    ) : Bool {
        Nat32.toNat(control.raw_payload_bytes) == rawBytes and
        validMetadataSlice(control.encrypted_root_metadata) and
        validPartition(
            [control.ibe_wrapped_root_key, control.encrypted_root_metadata],
            rawBytes,
        );
    };

    func validList(control : ListFrameControl, rawBytes : Nat) : Bool {
        if (
            Nat32.toNat(control.raw_payload_bytes) != rawBytes or
            control.items.size() > Types.MAX_CHILD_PAGE
        ) return false;
        let slices = Array.map<ListFrameItem, PayloadSlice>(
            control.items,
            func(item) { item.encrypted_metadata },
        );
        for (slice in slices.values()) {
            if (not validMetadataSlice(slice)) return false;
        };
        validPartition(slices, rawBytes);
    };

    func validLookup(control : LookupFrameControl, rawBytes : Nat) : Bool {
        if (
            Nat32.toNat(control.raw_payload_bytes) != rawBytes or
            not validMetadataSlice(control.encrypted_metadata)
        ) return false;
        let slices = switch (control.content) {
            case null [control.encrypted_metadata];
            case (?content) [
                control.encrypted_metadata,
                content.wrapped_content_key,
            ];
        };
        validPartition(slices, rawBytes);
    };

    func validRead(control : ReadBlockFrameControl, rawBytes : Nat) : Bool {
        switch (control.frame) {
            case null false;
            case (?#first(value)) {
                value.index == 0 and
                Nat32.toNat(value.raw_payload_bytes) == rawBytes and
                validMetadataSlice(value.encrypted_metadata) and
                validPartition(
                    [
                        value.encrypted_metadata,
                        value.wrapped_content_key,
                        value.ciphertext_block,
                    ],
                    rawBytes,
                );
            };
            case (?#continuation(value)) {
                value.index > 0 and
                Nat32.toNat(value.raw_payload_bytes) == rawBytes and
                value.ciphertext_block.length ==
                    value.ciphertext_block_bytes and
                validPartition([value.ciphertext_block], rawBytes);
            };
        };
    };

    func validMetadataSlice(slice : PayloadSlice) : Bool {
        let length = Nat32.toNat(slice.length);
        length >= 16 and length <= Types.MAX_METADATA_BYTES;
    };

    func validSlice(slice : PayloadSlice, rawBytes : Nat) : Bool {
        let offset = Nat32.toNat(slice.offset);
        let length = Nat32.toNat(slice.length);
        length > 0 and offset <= rawBytes and length <= rawBytes - offset;
    };

    func validPartition(slices : [PayloadSlice], rawBytes : Nat) : Bool {
        if (rawBytes == 0) return slices.size() == 0;
        if (slices.size() == 0) return false;
        var expectedOffset = 0;
        for (slice in slices.values()) {
            if (Nat32.toNat(slice.offset) != expectedOffset) return false;
            let length = Nat32.toNat(slice.length);
            if (length == 0 or length > rawBytes - expectedOffset) return false;
            expectedOffset += length;
        };
        expectedOffset == rawBytes;
    };
};
