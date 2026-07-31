import Memory "../memory/files/v1";

module {
    public type Id128 = Memory.Id128;
    public type Digest256 = Memory.Tag256;

    public let ROOT_NODE_ID : Id128 = { hi = 0; lo = 0 };
    public let ZERO_TAG : Digest256 = (0, 0, 0, 0);

    public let MAX_NODES : Nat = 10_000;
    public let MAX_TREE_DEPTH : Nat8 = 64;
    public let MAX_NAME_SCALARS : Nat16 = 100;
    public let MAX_PATH_SCALARS : Nat16 = 240;
    public let MAX_METADATA_BYTES : Nat = 2_048;
    public let MAX_VAULT_FRAME_BYTES : Nat = 65_536;
    public let MAX_MUTATION_FRAME_BYTES : Nat = 262_144;
    public let MAX_LIST_FRAME_BYTES : Nat = 524_288;
    public let MAX_LOOKUP_FRAME_BYTES : Nat = 8_192;
    public let MAX_FILE_PLAINTEXT_BYTES : Nat = 67_108_864;
    public let MAX_PRIVATE_PLAINTEXT_BYTES : Nat = 67_108_864;
    public let MAX_FILE_CIPHERTEXT_BYTES : Nat = 67_109_440;
    public let MAX_COMMITTED_CIPHERTEXT_BYTES : Nat = 83_886_080;
    public let MAX_PHYSICAL_PRIVATE_BYTES : Nat = 167_772_160;
    public let MAX_PRIVATE_STAGES : Nat = 2;
    public let MAX_STAGED_CIPHERTEXT_BYTES : Nat = 67_109_440;
    public let MAX_CLEANUP_JOBS : Nat = 8;
    // Desired-state reconciliation is primary. Compact ambiguity receipts are
    // bounded by the filesystem node ceiling and retained for one hour.
    public let MAX_PRIVATE_RECEIPTS : Nat = MAX_NODES;
    public let RECEIPT_RETENTION_NS : Nat64 = 3_600_000_000_000;
    public let PRIVATE_STAGE_IDLE_NS : Nat64 = 1_800_000_000_000;
    public let MAX_FRAME_BYTES : Nat = 1_900_000;
    public let MAX_SINGLE_WRITE_CONTROL_BYTES : Nat = 9_996;
    public let MAX_BATCH_WRITE_CONTROL_BYTES : Nat = 196_608;
    public let MAX_CONTROL_ALLOCATION_BYTES : Nat = 524_288;
    public let MAX_PLAINTEXT_BLOCK_BYTES : Nat = 1_889_984;
    public let MAX_BLOCKS_PER_FILE : Nat = 36;
    // One extra slot lets cleanup retain the exact first over-page stage
    // shape while a valid single-file write remains capped at 36 blocks.
    public let MAX_BATCH_BLOCKS : Nat = 37;
    public let MAX_BATCH_FRAMES : Nat = 7;
    // A maximum-size single file has 36 canonical content blocks and,
    // because a full ciphertext block already consumes the attachment payload,
    // therefore requires 36 transport frames. The seven-frame ceiling is
    // the independently reviewed multi-file batch ceiling.
    public let MAX_SINGLE_WRITE_FRAMES : Nat = 36;
    public let MAX_BATCH_FILES : Nat = 20;
    public let MAX_BATCH_PLAINTEXT_BYTES : Nat = 10_485_760;
    public let MAX_BATCH_PLAN_ENTRIES : Nat = 64;
    public let MAX_MUTATION_FOLDER_TRANSITIONS : Nat = 127;
    public let MAX_MUTATION_CHILD_INDEX_TRANSITIONS : Nat = 2;
    public let MAX_CHILD_PAGE : Nat = 200;
    public let MAX_CLEANUP_ENTRIES_PER_PAGE : Nat = 128;
    public let MAX_CLEANUP_BLOCKS_PER_PAGE : Nat = 36;
    public let MAX_CLEANUP_CIPHERTEXT_PER_PAGE : Nat = 67_109_440;
    public let MAX_CLEANUP_WORK_UNITS_PER_PAGE : Nat = 512;
    public let MAX_CLEANUP_INSTRUCTIONS_PER_PAGE : Nat64 =
        2_000_000_000;
    // A no-job private retirement must finish atomically once it starts.
    // This conservative tail allowance keeps a no-job retirement atomic:
    // once removal starts, 36 block-index removals plus stage/index
    // retirement and terminal-receipt installation retain explicit headroom.
    public let PRIVATE_RETIRE_INSTRUCTION_RESERVE : Nat64 =
        250_000_000;

    public type RejectionReason = {
        #not_ready;
        #invalid_request;
        #not_found;
        #not_file;
        #not_folder;
        #invalid_index;
        #already_exists;
        #stale_revision;
        #stale_content;
        #cursor_stale;
        #id_collision;
        #batch_structure_limit;
        #conflict;
        #quota;
        #busy;
        #aborted;
        #expired;
        #superseded;
        #temporarily_unavailable;
        #incompatible;
        #corrupt_state;
    };

    public type Rejection = {
        reason : ?RejectionReason;
        retry_after_ns : ?Nat64;
    };

    public type Result<T> = {
        #ok : T;
        #err : Rejection;
    };

    public func reject(reason : RejectionReason) : Rejection {
        { reason = ?reason; retry_after_ns = null };
    };

    public func retry(reason : RejectionReason, retryAfterNs : Nat64) : Rejection {
        { reason = ?reason; retry_after_ns = ?retryAfterNs };
    };

    public type NodeKind = { #folder; #file };
    public type ContentCryptoProfile = { #aes_256_gcm_files_v2 };

    public type ContentDescriptor = {
        content_id : Id128;
        block_count : Nat32;
        ciphertext_bytes : Nat64;
        crypto_profile : ?ContentCryptoProfile;
    };

    public type NodeBinding = {
        node_id : Id128;
        parent_id : Id128;
        kind : ?NodeKind;
        structural_revision : Nat64;
        metadata_revision : Nat64;
        children_revision : Nat64;
        declared_name_scalars : Nat16;
        subtree_height : Nat8;
        max_relative_path_scalars : Nat16;
        subtree_plaintext_bytes : Nat64;
        encrypted_metadata_bytes : Nat32;
        active : Bool;
    };

    public type QuotaSnapshot = {
        nodes : Nat64;
        committed_private_plaintext_bytes : Nat64;
        committed_ciphertext_bytes : Nat64;
        staged_ciphertext_bytes : Nat64;
        physical_private_bytes : Nat64;
        cleanup_jobs : Nat16;
    };

    public type PublicUsageCounters = {
        live_entries : Nat64;
        occupied_entry_slots : Nat64;
        committed_body_bytes : Nat64;
        reserved_committed_body_bytes : Nat64;
        allocated_body_bytes : Nat64;
        charged_metadata_bytes : Nat64;
        accepted_staged_bytes : Nat64;
        reserved_staged_bytes : Nat64;
        detached_charged_bytes : Nat64;
        active_stages : Nat64;
        receipt_lanes : Nat64;
        general_receipt_lanes : Nat64;
        reserved_general_receipt_lanes : Nat64;
        reserved_revocation_lanes : Nat64;
        filled_revocation_lanes : Nat64;
        receipt_nonce_indexes : Nat64;
        receipt_expiry_indexes : Nat64;
        cleanup_jobs : Nat64;
        reserved_entry_slots : Nat64;
    };

    public type PublicUsageLimits = {
        entries : Nat64;
        committed_bytes : Nat64;
        object_bytes : Nat64;
        staged_bytes : Nat64;
        pending_stages : Nat64;
        batch_operations : Nat64;
        batch_bytes : Nat64;
        general_receipts : Nat64;
        revocation_lanes : Nat64;
    };

    public type PublicUsage = {
        current : PublicUsageCounters;
        manifest_limits : PublicUsageLimits;
        effective_limits : PublicUsageLimits;
    };

    public type CleanupState = {
        #clean;
        #pending : { remaining_jobs : Nat16 };
    };

    public type CleanupSummary = {
        remaining_jobs : Nat16;
        has_more : Bool;
        state : ?CleanupState;
    };

    public type OperationKind = {
        #vault;
        #private_write;
        #mutation;
        #remove;
        #abort;
    };

    public type OperationSummary = {
        request_id : Id128;
        kind : ?OperationKind;
        stage_id : ?Nat64;
        expires_at_ns : ?Nat64;
        target : ?OperationTarget;
    };

    public type VaultState = {
        #absent;
        #present : {
            format : Nat16;
            record_revision : Nat64;
            slot_generation : Nat64;
            public_key_fingerprint : Digest256;
            wrapper_frame_bytes : Nat32;
        };
    };

    public type BootstrapOk = {
        vault : ?VaultState;
        quota : QuotaSnapshot;
        public_usage : PublicUsage;
        cleanup : CleanupSummary;
        active_operations : [OperationSummary];
        body_bytes : Nat32;
    };

    public type ListCursor = {
        parent_id : Id128;
        children_revision : Nat64;
        last_name_tag : Digest256;
    };

    public type ListRequest = {
        parent_id : Id128;
        expected_structural_revision : ?Nat64;
        cursor : ?ListCursor;
        limit : Nat16;
    };

    public type ListOk = {
        parent_id : Id128;
        structural_revision : Nat64;
        children_revision : Nat64;
        total_children : Nat32;
        loaded_count : Nat16;
        next_cursor : ?ListCursor;
        has_more : Bool;
        body_bytes : Nat32;
    };

    public type LookupLocator = {
        #node : { node_id : Id128 };
        #child : {
            parent_id : Id128;
            expected_children_revision : ?Nat64;
        };
    };

    public type LookupRequest = { locator : ?LookupLocator };

    public type LookupOk = {
        node : NodeBinding;
        content : ?ContentDescriptor;
        body_bytes : Nat32;
    };

    public type ReadChunkRequest = {
        node_id : Id128;
        structural_revision : Nat64;
        content_id : Id128;
        index : Nat32;
    };

    public type ReadChunkOk = {
        node_id : Id128;
        structural_revision : Nat64;
        metadata_revision : Nat64;
        content_id : Id128;
        index : Nat32;
        block_count : Nat32;
        ciphertext_block_bytes : Nat32;
        ciphertext_total_bytes : Nat64;
        frame_kind : ?{ #first; #continuation };
    };

    public type OperationWriteTargetNode = {
        node_id : Id128;
        content_id : ?Id128;
    };

    public type OperationTarget = {
        #vault : { expected_record_revision : ?Nat64 };
        #private_write : { nodes : [OperationWriteTargetNode] };
        #mutation : { node_id : Id128 };
        #remove : { node_id : Id128 };
        #abort : {
            stage_id : Nat64;
        };
    };

    public type OperationStatusRequest = {
        request_id : Id128;
        target : ?OperationTarget;
    };

    public type FrameBlockMapping = {
        frame_ordinal : Nat8;
        content_id : Id128;
        block_index : Nat32;
    };

    public type CommittedNode = {
        node_id : Id128;
        content_id : ?Id128;
        structural_revision : Nat64;
        metadata_revision : Nat64;
    };

    public type CommittedDetail = {
        #vault : VaultWriteOk;
        #private_write : WriteBlockOk;
        #mutation : MutateOk;
        #remove : RemoveOk;
        #abort : AbortOk;
    };

    public type OperationState = {
        #active : {
            stage_id : ?Nat64;
            accepted_frames_bitmap : Nat16;
            frame_block_mapping : [FrameBlockMapping];
            staged_bytes : Nat64;
            expires_at_ns : ?Nat64;
        };
        #committed : {
            detail : ?CommittedDetail;
        };
        #aborted : { terminal_at_ns : Nat64; reconcile_until_ns : Nat64 };
        #expired : { terminal_at_ns : Nat64; reconcile_until_ns : Nat64 };
        #superseded : { revision : ?Nat64 };
        #unknown;
    };

    public type OperationStatusOk = {
        request_id : Id128;
        target : ?OperationTarget;
        state : ?OperationState;
        cleanup_state : ?CleanupState;
    };

    public type VaultWriteOperation = { #initialize; #rewrap };
    public type VaultWriteRequest = {
        request_id : Id128;
        operation : ?VaultWriteOperation;
        expected_record_revision : ?Nat64;
        proposed_record_revision : Nat64;
        body_bytes : Nat32;
    };
    public type VaultWriteOk = {
        request_id : Id128;
        record_revision : Nat64;
        initialized : Bool;
    };

    public type WriteBlockRequest = {
        request_id : Id128;
        stage_id : ?Nat64;
        frame_ordinal : Nat8;
        final : Bool;
        body_bytes : Nat32;
    };
    public type WriteBlockOk = {
        request_id : Id128;
        stage_id : ?Nat64;
        frame_ordinal : Nat8;
        accepted_frames_bitmap : Nat16;
        committed_nodes : [CommittedNode];
        cleanup_state : ?CleanupState;
    };

    public type MutationAction = { #create_folder; #rename; #move };
    public type MutateRequest = {
        request_id : Id128;
        action : ?MutationAction;
        body_bytes : Nat32;
    };
    public type MutateOk = {
        request_id : Id128;
        node_id : Id128;
        parent_id : Id128;
        structural_revision : Nat64;
        metadata_revision : Nat64;
    };

    public type RemoveRequest = {
        request_id : Id128;
        node_id : Id128;
        expected_structural_revision : Nat64;
        expected_parent_id : Id128;
        expected_parent_children_revision : Nat64;
        recursive : Bool;
    };
    public type RemoveOk = {
        request_id : Id128;
        node_id : Id128;
        detached_plaintext_bytes : Nat64;
        reclaimed_entries : Nat16;
        reclaimed_ciphertext_bytes : Nat64;
        cleanup_state : ?CleanupState;
    };

    public type AbortRequest = {
        request_id : Id128;
        stage_id : Nat64;
    };
    public type AbortOk = {
        request_id : Id128;
        stage_id : Nat64;
        cleanup_state : ?CleanupState;
    };

    public type CleanupOk = {
        reclaimed_entries : Nat16;
        reclaimed_ciphertext_bytes : Nat64;
        reclaimed_charged_bytes : Nat64;
        remaining_jobs : Nat16;
        has_more : Bool;
    };

    public type Attachment<T> = { value : T; body : Blob };
};
