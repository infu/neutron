// Persistent schema: keep this file immutable after release. Package imports
// are allowed; relative imports are forbidden so app-local types cannot drift.
//
// This is the Files managed-memory V2 schema. It preserves the complete V1
// encrypted-vault plane and adds plaintext Workspace and Shared planes.
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";

module {
    public type Id128 = {
        hi : Nat64;
        lo : Nat64;
    };

    // Fixed words keep ordered-map keys compact and avoid allocating Blob keys.
    public type Tag256 = (Nat64, Nat64, Nat64, Nat64);
    public type ChildNameKey = (
        Nat64,
        Nat64,
        Nat64,
        Nat64,
        Nat64,
        Nat64,
    );
    public type BlockKey = (Nat64, Nat64, Nat32);
    public type PrivateReceiptExpiryKey = (Nat64, Nat64, Nat64);
    public type ShareExpiryKey = (Nat64, Nat8, Nat64);

    public type ContentCryptoProfile = {
        #aes_256_gcm_files_v2;
    };

    public type ContentRecord = {
        content_id : Id128;
        wrapped_content_key : Blob;
        block_count : Nat32;
        ciphertext_bytes : Nat;
        crypto_profile : ContentCryptoProfile;
    };

    public type HeightCount = {
        value : Nat8;
        count : Nat32;
    };

    public type PathScalarCount = {
        value : Nat16;
        count : Nat32;
    };

    public type FolderRecord = {
        direct_child_count : Nat32;
        // Both vectors are strictly sorted by value and contain no zero count.
        child_subtree_heights : [HeightCount];
        child_relative_path_scalars : [PathScalarCount];
    };

    public type FileRecord = {
        active_content : ?ContentRecord;
    };

    public type NodeKind = {
        #folder : FolderRecord;
        #file : FileRecord;
    };

    public type NodeState = {
        #active;
        #hidden : {
            cleanup_job_id : Nat64;
            hidden_at_ns : Nat64;
        };
    };

    public type Node = {
        parent_id : Id128;
        kind : NodeKind;
        state : NodeState;
        name_tag : Tag256;
        declared_name_scalars : Nat16;
        structural_revision : Nat64;
        metadata_revision : Nat64;
        children_revision : Nat64;
        subtree_height : Nat8;
        max_relative_path_scalars : Nat16;
        subtree_plaintext_bytes : Nat;
        encrypted_metadata : Blob;
    };

    public type VaultRecord = {
        format : Nat16;
        vault_id : Id128;
        vault_salt : Tag256;
        slot_generation : Nat64;
        public_key_fingerprint : Tag256;
        ibe_wrapped_root_key : Blob;
        root_commitment : Tag256;
        record_revision : Nat64;
    };

    public type ByteDelta = {
        #increase : Nat;
        #decrease : Nat;
        #unchanged;
    };

    public type WriteIntent = {
        #create;
        #replace;
        #batch;
    };

    public type NodeMutation = {
        node_id : Id128;
        expected : ?Node;
        replacement : ?Node;
    };

    public type ChildIndexMutation = {
        key : ChildNameKey;
        expected : ?Id128;
        replacement : ?Id128;
    };

    public type ContentRetirement = {
        node_id : Id128;
        content : ContentRecord;
    };

    public type PrivateCommitPlan = {
        intent : WriteIntent;
        node_mutations : [NodeMutation];
        child_index_mutations : [ChildIndexMutation];
        retired_contents : [ContentRetirement];
        node_count_delta : ByteDelta;
        committed_plaintext_delta : ByteDelta;
        committed_ciphertext_delta : ByteDelta;
        final_physical_bytes : Nat;
    };

    public type StageBlock = {
        content_id : Id128;
        block_index : Nat32;
        ciphertext_bytes : Nat32;
        frame_ordinal : Nat8;
        payload_offset : Nat32;
        payload_length : Nat32;
    };

    public type FramePlan = {
        ordinal : Nat8;
        encoded_bytes : Nat32;
        blocks : [StageBlock];
    };

    public type PrivateStage = {
        request_id : Id128;
        request_fingerprint : Tag256;
        created_at_ns : Nat64;
        last_activity_at_ns : Nat64;
        expires_at_ns : Nat64;
        frame_count : Nat8;
        accepted_frame_bitmap : Blob;
        // Position-aligned with frame_count; accepted frames have one digest.
        frame_fingerprints : [?Tag256];
        frames : [FramePlan];
        commit_plan : PrivateCommitPlan;
        accepted_ciphertext_bytes : Nat;
        reserved_ciphertext_bytes : Nat;
        reserved_physical_bytes : Nat;
        reserved_cleanup_jobs : Nat8;
    };

    public type FilesPresentation = {
        #inline_text;
        #attachment;
    };

    public type FilesPublicationTarget = {
        collection : Text;
        collection_generation : Nat64;
        publication_generation : Nat64;
        publication_id : Tag256;
        filename : Text;
    };

    public type PublicStage = {
        request_id : Id128;
        request_fingerprint : Tag256;
        share_id : Nat64;
        source_node_id : Id128;
        // Continuations revalidate that this node remains reachable and still
        // names source_content_id. Rename/move is intentionally allowed.
        source_content_id : Id128;
        source_structural_revision : Nat64;
        presentation : FilesPresentation;
        safe_name : Text;
        begin_nonce : Id128;
        // The resident supplies the commit nonce only with the final block.
        commit_nonce : ?Id128;
        collection_generation : Nat64;
        target : ?FilesPublicationTarget;
        kernel_stage_id : ?Nat64;
        block_lengths : [Nat32];
        accepted_block_bitmap : Blob;
        // Position-aligned with block_lengths.
        block_hashes : [?Tag256];
        created_at_ns : Nat64;
        expires_at_ns : Nat64;
        // Local managed-memory capacity reserved for accepted-block metadata,
        // terminalization, and the infallible publish transition.
        reserved_physical_bytes : Nat;
    };

    public type Stage = {
        #private_write : PrivateStage;
        #public_share : PublicStage;
    };

    public type CleanupWalkFrame = {
        node_id : Id128;
        // Null starts the child range; a value resumes strictly after the tag.
        after_child_tag : ?Tag256;
        entered : Bool;
    };

    public type CleanupJobKind = {
        #subtree : {
            root_id : Id128;
            stack : [CleanupWalkFrame];
        };
        #contents : {
            contents : [{
                content_id : Id128;
                next_block_index : Nat32;
                block_count : Nat32;
            }];
            current_content : Nat8;
        };
        #private_stage : {
            // The bounded block list is copied before the active stage can be
            // retired, so cleanup never depends on a missing stage record.
            blocks : [BlockKey];
            next_block : Nat32;
        };
        #orphan_blocks : {
            content_id : Id128;
            next_block_index : Nat32;
            block_count : Nat32;
        };
    };

    public type DeleteJob = {
        job_id : Nat64;
        kind : CleanupJobKind;
        created_at_ns : Nat64;
        updated_at_ns : Nat64;
        reclaimed_entries : Nat;
        reclaimed_ciphertext_bytes : Nat;
    };

    public type StoredRecordIdentity = {
        target : FilesPublicationTarget;
        kernel_revision : Nat64;
        content_tag : Tag256;
        body_bytes : Nat;
        block_lengths : [Nat32];
        block_hashes : [Tag256];
    };

    public type StoredDeletedIdentity = {
        target : FilesPublicationTarget;
        kernel_revision : Nat64;
        prior_content_tag : Tag256;
    };

    public type StoredLifecycleOutcome = {
        committed : StoredRecordIdentity;
        deleted : ?StoredDeletedIdentity;
        // Exact semantic fingerprint of the final block request whose
        // successful commit made the publication externally visible.
        final_request_fingerprint : Tag256;
    };

    public type ShareRecord = {
        target : FilesPublicationTarget;
        presentation : FilesPresentation;
        public_bytes : Nat;
        content_tag : Tag256;
        kernel_revision : Nat64;
        source_node_id : Id128;
        source_content_id : Id128;
        source_structural_revision : Nat64;
        created_at_ns : Nat64;
        revision : Nat64;
    };

    public type ShareLifecycleState = {
        #pending : {
            stage_id : Nat64;
            publish_request_id : Id128;
        };
        #live : ShareRecord;
        #deleted : StoredDeletedIdentity;
    };

    public type ShareLifecycleCarrier = {
        share_id : Nat64;
        // Monotonic Files-owned lifecycle revision (pending=0, live=1,
        // deleted=2 for V2). It remains available after the live record is
        // replaced by its tombstone.
        share_revision : Nat64;
        source_node_id : Id128;
        source_content_id : Id128;
        source_structural_revision : Nat64;
        // Recursive detach marks every live share whose source belongs to the
        // removed subtree before hiding its root. Share-list queries can then
        // distinguish an active descendant awaiting cleanup from a reachable
        // source without repeating private ancestry walks.
        source_detached : Bool;
        presentation : FilesPresentation;
        created_at_ns : Nat64;
        publish_stage_id : Nat64;
        // Capacity held while live so exact conditional unshare can always
        // materialize its request pointer and tombstone.
        reserved_delete_physical_bytes : Nat;
        state : ShareLifecycleState;
        retained_outcome : ?StoredLifecycleOutcome;
        // Publish retry pointers expire independently while a live carrier
        // remains addressable by ShareId.
        publish_request_id : ?Id128;
        publish_request_fingerprint : ?Tag256;
        publish_reconcile_until_ns : ?Nat64;
        delete_request_id : ?Id128;
        delete_request_fingerprint : ?Tag256;
        delete_reconcile_until_ns : ?Nat64;
    };

    public type PublicTerminalReceipt = {
        request_id : Id128;
        request_fingerprint : Tag256;
        share_id : Nat64;
        stage_id : Nat64;
        source_node_id : Id128;
        source_content_id : Id128;
        stage : PublicStage;
        abort_request_fingerprint : ?Tag256;
        terminal : {
            #aborted;
            #expired;
        };
        terminal_at_ns : Nat64;
        reconcile_until_ns : Nat64;
    };

    public type PrivateReceiptNode = {
        node_id : Id128;
        content_id : ?Id128;
        structural_revision : Nat64;
        metadata_revision : Nat64;
    };

    public type PrivateReceiptTargetNode = {
        node_id : Id128;
        content_id : ?Id128;
    };

    public type StoredCleanupState = {
        #clean;
        #pending : { remaining_jobs : Nat16 };
    };

    public type PrivateReceiptOutcome = {
        #vault : {
            request_id : Id128;
            expected_record_revision : ?Nat64;
            record_revision : Nat64;
            initialized : Bool;
        };
        #write : {
            request_id : Id128;
            stage_id : ?Nat64;
            frame_ordinal : Nat8;
            accepted_frames_bitmap : Nat16;
            frame_fingerprints : [Tag256];
            nodes : [PrivateReceiptNode];
            cleanup_state : ?StoredCleanupState;
        };
        #mutation : {
            request_id : Id128;
            node_id : Id128;
            parent_id : Id128;
            structural_revision : Nat64;
            metadata_revision : Nat64;
        };
        #remove : {
            request_id : Id128;
            node_id : Id128;
            detached_plaintext_bytes : Nat64;
            reclaimed_entries : Nat16;
            reclaimed_ciphertext_bytes : Nat64;
            cleanup_state : ?StoredCleanupState;
            cleanup_job_id : ?Nat64;
        };
        #abort : {
            request_id : Id128;
            stage_id : Nat64;
            nodes : [PrivateReceiptTargetNode];
            stage_kind : ?{
                #private_write;
                #public_share;
            };
            source_node_id : ?Id128;
            source_content_id : ?Id128;
            cleanup_state : ?StoredCleanupState;
            cleanup_job_id : ?Nat64;
        };
        #expired : {
            request_id : Id128;
            stage_id : Nat64;
            nodes : [PrivateReceiptTargetNode];
            // Compact semantic fingerprints retain the pinned allocation for
            // every frame and the exact body fingerprint for accepted frames.
            frame_plan_fingerprints : [Tag256];
            frame_fingerprints : [?Tag256];
            cleanup_state : ?StoredCleanupState;
            cleanup_job_id : ?Nat64;
        };
    };

    public type PrivateReceipt = {
        request_fingerprint : Tag256;
        outcome : PrivateReceiptOutcome;
        completed_at_ns : Nat64;
        terminal_kind : ?{
            #aborted;
            #expired;
        };
        expires_at_ns : Nat64;
    };

    // Retained receipts temporarily reserve their result identities against
    // reuse. Node and content namespaces are counted independently while a
    // shared key keeps the stable index compact.
    public type PrivateReceiptIdentityOwner = {
        node_count : Nat16;
        content_count : Nat16;
    };

    public type PlainSpace = {
        #workspace;
        #shared_;
    };

    public type PlainContentKind = {
        #text;
        #binary;
    };

    public type PlainPresentation = {
        #inline_text;
        #attachment;
    };

    public type PlainPublicationTarget = {
        collection : Text;
        collection_generation : Nat64;
        publication_generation : Nat64;
        publication_id : Blob;
        filename : Text;
    };

    public type PlainSharedIdentity = {
        target : PlainPublicationTarget;
        kernel_revision : Nat64;
        content_tag : Blob;
    };

    public type PlainFile = {
        content_id : Nat64;
        block_count : Nat32;
        total_bytes : Nat;
        content_kind : PlainContentKind;
        media_type : Text;
        etag_sha256 : Text;
        presentation : ?PlainPresentation;
        publication : ?PlainSharedIdentity;
    };

    public type PlainNodeKind = {
        #folder;
        #file;
    };

    public type PlainNode = {
        node_id : Nat64;
        space : PlainSpace;
        parent_id : Nat64;
        name : Text;
        kind : PlainNodeKind;
        file : ?PlainFile;
        created_at_ns : Nat64;
        modified_at_ns : Nat64;
        revision : Nat64;
        children_revision : Nat64;
        direct_child_count : Nat32;
    };

    public type PlainBlockKey = (Nat64, Nat32);

    public type PlainMoveSource = {
        path : Text;
        node_id : Nat64;
        parent_id : Nat64;
        name : Text;
        revision : Nat64;
        if_match : ?Text;
        etag_sha256 : Text;
        total_bytes : Nat;
        presentation : PlainPresentation;
        publication : PlainSharedIdentity;
        created_at_ns : Nat64;
    };

    public type PlainStage = {
        stage_id : Nat64;
        request_id : Text;
        space : PlainSpace;
        path : Text;
        parent_id : Nat64;
        name : Text;
        node_id : Nat64;
        existing_node_id : ?Nat64;
        existing_revision : ?Nat64;
        existing_etag_sha256 : ?Text;
        content_id : Nat64;
        block_count : Nat32;
        total_bytes : Nat;
        content_kind : PlainContentKind;
        media_type : Text;
        etag_sha256 : Text;
        presentation : ?PlainPresentation;
        next_block_index : Nat32;
        received_bytes : Nat;
        kernel_stage_id : ?Nat64;
        target : ?PlainPublicationTarget;
        old_publication : ?PlainSharedIdentity;
        move_source : ?PlainMoveSource;
        begin_nonce : Blob;
        commit_nonce : ?Blob;
        delete_nonce : ?Blob;
        block_hashes : [?Blob];
        safe_name : Text;
        created_at_ns : Nat64;
        // Workspace idle-activity timestamp. Shared freezes this at stage
        // creation.
        modified_at_ns : Nat64;
        // Present only for Shared. This immutable local deadline is capped by
        // both stage start + 55 minutes and the exact Kernel expiry - 5 minutes.
        shared_expires_at_ns : ?Nat64;
    };

    public type PlainTerminalWrite = {
        path : Text;
        node : PlainNode;
    };

    public type PlainTerminalMutation = {
        path : Text;
        revision : Nat64;
        changed : Nat32;
    };

    public type PlainTerminalReceipt = {
        fingerprint : Tag256;
        outcome : {
            #write : PlainTerminalWrite;
            #mutation : PlainTerminalMutation;
            #retired_stage;
        };
        expires_at_ns : Nat64;
    };

    public let WORKSPACE_ROOT_ID : Nat64 = 1;
    public let SHARED_ROOT_ID : Nat64 = 2;
    public let FIRST_PLAIN_NODE_ID : Nat64 = 3;

    public type Mem = {
        var next_stage_id : Nat64;
        var next_job_id : Nat64;
        var next_share_id : Nat64;
        // Checked-increment snapshot binding for share-list cursors.
        var share_list_revision : Nat64;

        var vault : ?VaultRecord;
        nodes_by_id : Map.Map<Id128, Node>;
        children_by_name : Map.Map<ChildNameKey, Id128>;
        blocks : Map.Map<BlockKey, Blob>;
        stages : Map.Map<Nat64, Stage>;
        stages_by_request : Map.Map<Id128, Nat64>;
        private_receipts : Map.Map<Id128, PrivateReceipt>;
        private_receipts_by_expiry : Map.Map<PrivateReceiptExpiryKey, ()>;
        private_receipt_identity_owners :
            Map.Map<Id128, PrivateReceiptIdentityOwner>;
        delete_jobs : Map.Map<Nat64, DeleteJob>;
        share_lifecycle_by_id : Map.Map<Nat64, ShareLifecycleCarrier>;
        share_by_publish_request : Map.Map<Id128, Nat64>;
        share_by_delete_request : Map.Map<Id128, Nat64>;
        share_lifecycle_by_expiry : Map.Map<ShareExpiryKey, ()>;
        public_terminal_receipts : Map.Map<Id128, PublicTerminalReceipt>;
        public_terminal_by_expiry : Map.Map<PrivateReceiptExpiryKey, ()>;

        var node_count : Nat;
        var committed_private_plaintext_bytes : Nat;
        var committed_ciphertext_bytes : Nat;
        var staged_ciphertext_bytes : Nat;
        var reserved_staged_ciphertext_bytes : Nat;
        var physical_private_bytes : Nat;
        var reserved_physical_private_bytes : Nat;
        var reserved_cleanup_jobs : Nat;

        var next_plain_node_id : Nat64;
        var next_plain_content_id : Nat64;
        var next_plain_stage_id : Nat64;
        workspace_root_id : Nat64;
        shared_root_id : Nat64;
        plain_nodes : Map.Map<Nat64, PlainNode>;
        plain_children : Map.Map<Text, Nat64>;
        plain_blocks : Map.Map<PlainBlockKey, Blob>;
        plain_stages : Map.Map<Nat64, PlainStage>;
        plain_stage_by_request : Map.Map<Text, Nat64>;
        plain_terminal_receipts : Map.Map<Text, PlainTerminalReceipt>;
        var workspace_plaintext_bytes : Nat;
        var shared_plaintext_bytes : Nat;
        var shared_file_count : Nat;
        var staged_workspace_bytes : Nat;
    };

    public func init() : Mem {
        let plainNodes = Map.empty<Nat64, PlainNode>();
        Map.add(
            plainNodes,
            Nat64.compare,
            WORKSPACE_ROOT_ID,
            plainRoot(WORKSPACE_ROOT_ID, #workspace),
        );
        Map.add(
            plainNodes,
            Nat64.compare,
            SHARED_ROOT_ID,
            plainRoot(SHARED_ROOT_ID, #shared_),
        );
        {
            var next_stage_id = 1;
            var next_job_id = 1;
            var next_share_id = 1;
            var share_list_revision = 0;

            var vault = null;
            nodes_by_id = Map.empty<Id128, Node>();
            children_by_name = Map.empty<ChildNameKey, Id128>();
            blocks = Map.empty<BlockKey, Blob>();
            stages = Map.empty<Nat64, Stage>();
            stages_by_request = Map.empty<Id128, Nat64>();
            private_receipts = Map.empty<Id128, PrivateReceipt>();
            private_receipts_by_expiry = Map.empty<PrivateReceiptExpiryKey, ()>();
            private_receipt_identity_owners =
                Map.empty<Id128, PrivateReceiptIdentityOwner>();
            delete_jobs = Map.empty<Nat64, DeleteJob>();
            share_lifecycle_by_id = Map.empty<Nat64, ShareLifecycleCarrier>();
            share_by_publish_request = Map.empty<Id128, Nat64>();
            share_by_delete_request = Map.empty<Id128, Nat64>();
            share_lifecycle_by_expiry = Map.empty<ShareExpiryKey, ()>();
            public_terminal_receipts =
                Map.empty<Id128, PublicTerminalReceipt>();
            public_terminal_by_expiry =
                Map.empty<PrivateReceiptExpiryKey, ()>();

            var node_count = 0;
            var committed_private_plaintext_bytes = 0;
            var committed_ciphertext_bytes = 0;
            var staged_ciphertext_bytes = 0;
            var reserved_staged_ciphertext_bytes = 0;
            var physical_private_bytes = 0;
            var reserved_physical_private_bytes = 0;
            var reserved_cleanup_jobs = 0;

            var next_plain_node_id = FIRST_PLAIN_NODE_ID;
            var next_plain_content_id = 1;
            var next_plain_stage_id = 1;
            workspace_root_id = WORKSPACE_ROOT_ID;
            shared_root_id = SHARED_ROOT_ID;
            plain_nodes = plainNodes;
            plain_children = Map.empty<Text, Nat64>();
            plain_blocks = Map.empty<PlainBlockKey, Blob>();
            plain_stages = Map.empty<Nat64, PlainStage>();
            plain_stage_by_request = Map.empty<Text, Nat64>();
            plain_terminal_receipts =
                Map.empty<Text, PlainTerminalReceipt>();
            var workspace_plaintext_bytes = 0;
            var shared_plaintext_bytes = 0;
            var shared_file_count = 0;
            var staged_workspace_bytes = 0;
        };
    };

    func plainRoot(nodeId : Nat64, space : PlainSpace) : PlainNode {
        {
            node_id = nodeId;
            space;
            parent_id = nodeId;
            name = "";
            kind = #folder;
            file = null;
            created_at_ns = 0;
            modified_at_ns = 0;
            revision = 0;
            children_revision = 0;
            direct_child_count = 0;
        };
    };
};
