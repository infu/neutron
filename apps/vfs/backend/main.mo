import NeutronCapabilities "mo:neutron-capabilities";
import Array "mo:core/Array";
import Int "mo:core/Int";
import Nat64 "mo:core/Nat64";
import Prim "mo:⛔";
import Time "mo:core/Time";
import PlainService "./files/PlainService";
import PlainTypes "./files/PlainTypes";
import Service "./files/Service";
import BoundaryTypes "./files/Types";
import Memory "./memory/files/v2";

module {
    public type Id128V2 = {
        hi : Nat64;
        lo : Nat64;
    };

    public type Digest256V2 = {
        a : Nat64;
        b : Nat64;
        c : Nat64;
        d : Nat64;
    };

    public type FilesRejectionReasonV2 = {
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

    public type FilesRejectionV2 = {
        reason : ?FilesRejectionReasonV2;
        retry_after_ns : ?Nat64;
    };

    public type FilesNodeKindV2 = {
        #folder;
        #file;
    };

    public type FilesContentCryptoProfileV2 = {
        #aes_256_gcm_files_v2;
    };

    public type FilesContentDescriptorV2 = {
        content_id : Id128V2;
        block_count : Nat32;
        ciphertext_bytes : Nat64;
        crypto_profile : ?FilesContentCryptoProfileV2;
    };

    public type FilesNodeBindingV2 = {
        node_id : Id128V2;
        parent_id : Id128V2;
        kind : ?FilesNodeKindV2;
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

    public type FilesQuotaSnapshotV2 = {
        nodes : Nat64;
        committed_private_plaintext_bytes : Nat64;
        committed_ciphertext_bytes : Nat64;
        staged_ciphertext_bytes : Nat64;
        physical_private_bytes : Nat64;
        cleanup_jobs : Nat16;
    };

    public type FilesPublicUsageCountersV2 = {
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
        reserved_entry_slots : Nat64;
        receipt_lanes : Nat64;
        general_receipt_lanes : Nat64;
        reserved_general_receipt_lanes : Nat64;
        reserved_revocation_lanes : Nat64;
        filled_revocation_lanes : Nat64;
        receipt_nonce_indexes : Nat64;
        receipt_expiry_indexes : Nat64;
        cleanup_jobs : Nat64;
    };

    public type FilesPublicUsageLimitsV2 = {
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

    public type FilesPublicUsageV2 = {
        current : FilesPublicUsageCountersV2;
        manifest_limits : FilesPublicUsageLimitsV2;
        effective_limits : FilesPublicUsageLimitsV2;
    };

    public type FilesCleanupSummaryV2 = {
        remaining_jobs : Nat16;
        has_more : Bool;
        state : ?FilesCleanupStateV2;
    };

    public type FilesCleanupStateV2 = {
        #clean;
        #pending : {
            remaining_jobs : Nat16;
        };
    };

    public type FilesOperationKindV2 = {
        #vault;
        #private_write;
        #mutation;
        #remove;
        #abort;
    };

    public type FilesOperationSummaryV2 = {
        request_id : Id128V2;
        kind : ?FilesOperationKindV2;
        stage_id : ?Nat64;
        expires_at_ns : ?Nat64;
        target : ?FilesOperationTargetV2;
    };

    public type FilesVaultStateV2 = {
        #absent;
        #present : {
            format : Nat16;
            record_revision : Nat64;
            slot_generation : Nat64;
            public_key_fingerprint : Digest256V2;
            wrapper_frame_bytes : Nat32;
        };
    };

    public type FilesBootstrapRequestV2 = {};

    public type FilesBootstrapResponseV2 = {
        outcome : ?{
            #ok : {
                vault : ?FilesVaultStateV2;
                quota : FilesQuotaSnapshotV2;
                public_usage : FilesPublicUsageV2;
                cleanup : FilesCleanupSummaryV2;
                active_operations : [FilesOperationSummaryV2];
                body_bytes : Nat32;
            };
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesBootstrapOutputV2 = {
        value : FilesBootstrapResponseV2;
        body : Blob;
    };

    public type FilesListCursorV2 = {
        parent_id : Id128V2;
        children_revision : Nat64;
        last_name_tag : Digest256V2;
    };

    public type FilesListRequestV2 = {
        parent_id : Id128V2;
        expected_structural_revision : ?Nat64;
        cursor : ?FilesListCursorV2;
        limit : Nat16;
    };

    public type FilesListResponseV2 = {
        outcome : ?{
            #ok : {
                parent_id : Id128V2;
                structural_revision : Nat64;
                children_revision : Nat64;
                total_children : Nat32;
                loaded_count : Nat16;
                next_cursor : ?FilesListCursorV2;
                has_more : Bool;
                body_bytes : Nat32;
            };
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesListOutputV2 = {
        value : FilesListResponseV2;
        body : Blob;
    };

    public type FilesLookupLocatorV2 = {
        #node : {
            node_id : Id128V2;
        };
        #child : {
            parent_id : Id128V2;
            expected_children_revision : ?Nat64;
        };
    };

    public type FilesLookupRequestV2 = {
        locator : ?FilesLookupLocatorV2;
        body : Blob;
    };

    public type FilesLookupResponseV2 = {
        outcome : ?{
            #ok : {
                node : FilesNodeBindingV2;
                content : ?FilesContentDescriptorV2;
                body_bytes : Nat32;
            };
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesLookupOutputV2 = {
        value : FilesLookupResponseV2;
        body : Blob;
    };

    public type FilesReadChunkRequestV2 = {
        node_id : Id128V2;
        structural_revision : Nat64;
        content_id : Id128V2;
        index : Nat32;
    };

    public type FilesReadChunkResponseV2 = {
        outcome : ?{
            #ok : {
                node_id : Id128V2;
                structural_revision : Nat64;
                metadata_revision : Nat64;
                content_id : Id128V2;
                index : Nat32;
                block_count : Nat32;
                ciphertext_block_bytes : Nat32;
                ciphertext_total_bytes : Nat64;
                frame_kind : ?{
                    #first;
                    #continuation;
                };
            };
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesReadChunkOutputV2 = {
        value : FilesReadChunkResponseV2;
        body : Blob;
    };

    public type FilesOperationWriteTargetNodeV2 = {
        node_id : Id128V2;
        content_id : ?Id128V2;
    };

    public type FilesOperationTargetV2 = {
        #vault : {
            expected_record_revision : ?Nat64;
        };
        #private_write : {
            nodes : [FilesOperationWriteTargetNodeV2];
        };
        #mutation : {
            node_id : Id128V2;
        };
        #remove : {
            node_id : Id128V2;
        };
        #abort : {
            stage_id : Nat64;
        };
    };

    public type FilesOperationStatusRequestV2 = {
        request_id : Id128V2;
        target : ?FilesOperationTargetV2;
    };

    public type FilesFrameBlockMappingV2 = {
        frame_ordinal : Nat8;
        content_id : Id128V2;
        block_index : Nat32;
    };

    public type FilesCommittedNodeV2 = {
        node_id : Id128V2;
        content_id : ?Id128V2;
        structural_revision : Nat64;
        metadata_revision : Nat64;
    };

    public type FilesVaultWriteOkV2 = {
        request_id : Id128V2;
        record_revision : Nat64;
        initialized : Bool;
    };

    public type FilesWriteBlockOkV2 = {
        request_id : Id128V2;
        stage_id : ?Nat64;
        frame_ordinal : Nat8;
        accepted_frames_bitmap : Nat16;
        committed_nodes : [FilesCommittedNodeV2];
        cleanup_state : ?FilesCleanupStateV2;
    };

    public type FilesMutateOkV2 = {
        request_id : Id128V2;
        node_id : Id128V2;
        parent_id : Id128V2;
        structural_revision : Nat64;
        metadata_revision : Nat64;
    };

    public type FilesRemoveOkV2 = {
        request_id : Id128V2;
        node_id : Id128V2;
        detached_plaintext_bytes : Nat64;
        reclaimed_entries : Nat16;
        reclaimed_ciphertext_bytes : Nat64;
        cleanup_state : ?FilesCleanupStateV2;
    };

    public type FilesAbortOkV2 = {
        request_id : Id128V2;
        stage_id : Nat64;
        cleanup_state : ?FilesCleanupStateV2;
    };

    public type FilesCommittedDetailV2 = {
        #vault : FilesVaultWriteOkV2;
        #private_write : FilesWriteBlockOkV2;
        #mutation : FilesMutateOkV2;
        #remove : FilesRemoveOkV2;
        #abort : FilesAbortOkV2;
    };

    public type FilesOperationStateV2 = {
        #active : {
            stage_id : ?Nat64;
            accepted_frames_bitmap : Nat16;
            frame_block_mapping : [FilesFrameBlockMappingV2];
            staged_bytes : Nat64;
            expires_at_ns : ?Nat64;
        };
        #committed : {
            detail : ?FilesCommittedDetailV2;
        };
        #aborted : {
            terminal_at_ns : Nat64;
            reconcile_until_ns : Nat64;
        };
        #expired : {
            terminal_at_ns : Nat64;
            reconcile_until_ns : Nat64;
        };
        #superseded : {
            revision : ?Nat64;
        };
        #unknown;
    };

    public type FilesOperationStatusResponseV2 = {
        outcome : ?{
            #ok : {
                request_id : Id128V2;
                target : ?FilesOperationTargetV2;
                state : ?FilesOperationStateV2;
                cleanup_state : ?FilesCleanupStateV2;
            };
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesVaultWriteOperationV2 = {
        #initialize;
        #rewrap;
    };

    public type FilesVaultWriteRequestV2 = {
        request_id : Id128V2;
        operation : ?FilesVaultWriteOperationV2;
        expected_record_revision : ?Nat64;
        proposed_record_revision : Nat64;
        body_bytes : Nat32;
        body : Blob;
    };

    public type FilesVaultWriteResponseV2 = {
        outcome : ?{
            #ok : FilesVaultWriteOkV2;
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesWriteBlockRequestV2 = {
        request_id : Id128V2;
        stage_id : ?Nat64;
        frame_ordinal : Nat8;
        final : Bool;
        body_bytes : Nat32;
        body : Blob;
    };

    public type FilesWriteBlockResponseV2 = {
        outcome : ?{
            #ok : FilesWriteBlockOkV2;
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesMutationActionV2 = {
        #create_folder;
        #rename;
        #move;
    };

    public type FilesMutateRequestV2 = {
        request_id : Id128V2;
        action : ?FilesMutationActionV2;
        body_bytes : Nat32;
        body : Blob;
    };

    public type FilesMutateResponseV2 = {
        outcome : ?{
            #ok : FilesMutateOkV2;
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesRemoveRequestV2 = {
        request_id : Id128V2;
        node_id : Id128V2;
        expected_structural_revision : Nat64;
        expected_parent_id : Id128V2;
        expected_parent_children_revision : Nat64;
        recursive : Bool;
    };

    public type FilesRemoveResponseV2 = {
        outcome : ?{
            #ok : FilesRemoveOkV2;
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesAbortRequestV2 = {
        request_id : Id128V2;
        stage_id : Nat64;
    };

    public type FilesAbortResponseV2 = {
        outcome : ?{
            #ok : FilesAbortOkV2;
            #rejected : FilesRejectionV2;
        };
    };

    public type FilesCleanupRequestV2 = {};

    public type FilesCleanupResponseV2 = {
        outcome : ?{
            #ok : {
                reclaimed_entries : Nat16;
                reclaimed_ciphertext_bytes : Nat64;
                reclaimed_charged_bytes : Nat64;
                remaining_jobs : Nat16;
                has_more : Bool;
            };
            #rejected : FilesRejectionV2;
        };
    };

    // Files V3 adds two plaintext roots without changing the released
    // encrypted Files V2 wire contract. Keep these public boundary types
    // structurally identical to PlainTypes. They are intentionally local:
    // the package schema generator resolves local aliases but cannot inspect
    // qualified aliases imported from another Motoko module.
    // Motoko removes one trailing underscore when it emits a Candid label, so
    // the doubled source suffix preserves the checked wire tag `shared_`.
    public type FilesPlainSpaceV3 = {
        #shared__;
        #workspace;
    };

    public type FilesPlainContentKindV3 = {
        #text;
        #binary;
    };

    public type FilesPlainPresentationV3 = {
        #inline_text;
        #attachment;
    };

    public type FilesPlainEntryKindV3 = {
        #file;
        #folder;
    };

    public type FilesPlainRejectionReasonV3 = {
        #not_ready;
        #invalid_request;
        #not_found;
        #not_file;
        #not_folder;
        #already_exists;
        #stale_revision;
        #stale_content;
        #cursor_stale;
        #conflict;
        #quota;
        #busy;
        #temporarily_unavailable;
        #incompatible;
        #corrupt_state;
    };

    public type FilesPlainRejectionV3 = {
        reason : ?FilesPlainRejectionReasonV3;
        retry_after_ns : ?Nat64;
    };

    public type FilesPlainEntryV3 = {
        node_id : Nat64;
        path : Text;
        name : Text;
        kind : ?FilesPlainEntryKindV3;
        content_kind : ?FilesPlainContentKindV3;
        byte_length : ?Nat64;
        media_type : ?Text;
        etag_sha256 : ?Text;
        created_at_ns : Nat64;
        modified_at_ns : Nat64;
        revision : Nat64;
        relative_url : ?Text;
    };

    public type FilesPlainCursorV3 = {
        after : Text;
        revision : Nat64;
        parent_node_id : Nat64;
    };

    public type FilesPlainListRequestV3 = {
        space : ?FilesPlainSpaceV3;
        path : Text;
        cursor : ?FilesPlainCursorV3;
        limit : Nat16;
    };

    public type FilesPlainListOkV3 = {
        revision : Nat64;
        entries : [FilesPlainEntryV3];
        total : Nat32;
        next_cursor : ?FilesPlainCursorV3;
        has_more : Bool;
    };

    public type FilesPlainListResponseV3 = {
        outcome : ?{
            #ok : FilesPlainListOkV3;
            #rejected : FilesPlainRejectionV3;
        };
    };

    public type FilesPlainStatRequestV3 = {
        space : ?FilesPlainSpaceV3;
        path : Text;
    };

    public type FilesPlainStatResponseV3 = {
        outcome : ?{
            #ok : FilesPlainEntryV3;
            #rejected : FilesPlainRejectionV3;
        };
    };

    public type FilesPlainReadChunkRequestV3 = {
        space : ?FilesPlainSpaceV3;
        path : Text;
        block_index : Nat32;
    };

    public type FilesPlainReadChunkOkV3 = {
        entry : FilesPlainEntryV3;
        block_index : Nat32;
        block_count : Nat32;
        body_bytes : Nat32;
    };

    public type FilesPlainReadChunkResponseV3 = {
        outcome : ?{
            #ok : FilesPlainReadChunkOkV3;
            #rejected : FilesPlainRejectionV3;
        };
    };

    public type FilesPlainReadChunkOutputV3 = {
        value : FilesPlainReadChunkResponseV3;
        body : Blob;
    };

    public type FilesPlainWriteMoveSourceV3 = {
        path : Text;
        expected_node_id : Nat64;
        expected_revision : Nat64;
        if_match : ?Text;
    };

    public type FilesPlainWriteBlockRequestV3 = {
        request_id : Text;
        space : ?FilesPlainSpaceV3;
        path : Text;
        stage_id : ?Nat64;
        block_index : Nat32;
        block_count : Nat32;
        total_bytes : Nat64;
        content_kind : ?FilesPlainContentKindV3;
        media_type : Text;
        etag_sha256 : Text;
        presentation : ?FilesPlainPresentationV3;
        expected_node_id : ?Nat64;
        expected_revision : ?Nat64;
        if_match : ?Text;
        if_none_match : Bool;
        create_parents : Bool;
        final : Bool;
        safe_name : ?Text;
        begin_nonce : ?Blob;
        commit_nonce : ?Blob;
        delete_nonce : ?Blob;
        move_source : ?FilesPlainWriteMoveSourceV3;
        body_bytes : Nat32;
        body : Blob;
    };

    public type FilesPlainWriteBlockOkV3 = {
        stage_id : ?Nat64;
        committed : Bool;
        entry : ?FilesPlainEntryV3;
    };

    public type FilesPlainWriteBlockResponseV3 = {
        outcome : ?{
            #ok : FilesPlainWriteBlockOkV3;
            #rejected : FilesPlainRejectionV3;
        };
    };

    public type FilesPlainMkdirRequestV3 = {
        request_id : Text;
        space : ?FilesPlainSpaceV3;
        path : Text;
        recursive : Bool;
    };

    public type FilesPlainMoveRequestV3 = {
        request_id : Text;
        space : ?FilesPlainSpaceV3;
        from : Text;
        to : Text;
        overwrite : Bool;
        expected_node_id : Nat64;
        expected_revision : Nat64;
        if_match : ?Text;
    };

    public type FilesPlainRemoveRequestV3 = {
        request_id : Text;
        space : ?FilesPlainSpaceV3;
        path : Text;
        recursive : Bool;
        expected_node_id : Nat64;
        expected_revision : Nat64;
        if_match : ?Text;
        delete_nonce : ?Blob;
    };

    public type FilesPlainAbortRequestV3 = {
        request_id : Text;
        space : ?FilesPlainSpaceV3;
        stage_id : ?Nat64;
    };

    public type FilesPlainCleanupRequestV3 = {
        request_id : Text;
        limit : Nat8;
    };

    public type FilesPlainMutationOkV3 = {
        path : Text;
        revision : Nat64;
        changed : Nat32;
    };

    public type FilesPlainMutationResponseV3 = {
        outcome : ?{
            #ok : FilesPlainMutationOkV3;
            #rejected : FilesPlainRejectionV3;
        };
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            files : Memory.Mem;
        };
        capabilities : {
            certified_assets : NeutronCapabilities.CertifiedAssetsV2;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let service = Service.ServiceWithCounter(
            env.stable_memory.files,
            env.capabilities.certified_assets,
            func() : Nat64 {
                let value = Int.abs(Time.now());
                if (value > Nat64.toNat(Nat64.maxValue)) {
                    Nat64.maxValue;
                } else {
                    Nat64.fromNat(value);
                };
            },
            func() : Nat64 { Prim.performanceCounter(1) },
        );
        let plainService = PlainService.Service(
            env.stable_memory.files,
            env.capabilities.certified_assets,
            func() : Nat64 {
                let value = Int.abs(Time.now());
                if (value > Nat64.toNat(Nat64.maxValue)) {
                    Nat64.maxValue;
                } else {
                    Nat64.fromNat(value);
                };
            },
        );

        public func /*query*/files_bootstrap_v2(
            _request : FilesBootstrapRequestV2,
        ) : FilesBootstrapOutputV2 {
            switch (service.bootstrap()) {
                case (#err(error)) rejectedAttachment(error);
                case (#ok(result)) {
                    {
                        value = {
                            outcome = ?#ok(publicBootstrap(result.value));
                        };
                        body = result.body;
                    };
                };
            };
        };

        public func /*query*/files_list_v2(
            request : FilesListRequestV2,
        ) : FilesListOutputV2 {
            let internal : BoundaryTypes.ListRequest = {
                parent_id = request.parent_id;
                expected_structural_revision =
                    request.expected_structural_revision;
                limit = request.limit;
                cursor = switch (request.cursor) {
                    case null null;
                    case (?cursor) ?{
                        parent_id = cursor.parent_id;
                        children_revision = cursor.children_revision;
                        last_name_tag = internalDigest(
                            cursor.last_name_tag
                        );
                    };
                };
            };
            switch (service.list(internal)) {
                case (#err(error)) rejectedAttachment(error);
                case (#ok(result)) {
                    {
                        value = {
                            outcome = ?#ok(publicList(result.value));
                        };
                        body = result.body;
                    };
                };
            };
        };

        public func /*query*/files_lookup_v2(
            request : FilesLookupRequestV2,
        ) : FilesLookupOutputV2 {
            let internal : BoundaryTypes.LookupRequest = {
                locator = request.locator;
            };
            switch (service.lookup(internal, request.body)) {
                case (#err(error)) rejectedAttachment(error);
                case (#ok(result)) {
                    {
                        value = { outcome = ?#ok(result.value) };
                        body = result.body;
                    };
                };
            };
        };

        public func /*query*/files_read_chunk_v2(
            request : FilesReadChunkRequestV2,
        ) : FilesReadChunkOutputV2 {
            switch (service.readChunk(request)) {
                case (#err(error)) rejectedAttachment(error);
                case (#ok(result)) {
                    {
                        value = { outcome = ?#ok(result.value) };
                        body = result.body;
                    };
                };
            };
        };

        public func /*query*/files_operation_status_v2(
            request : FilesOperationStatusRequestV2,
        ) : FilesOperationStatusResponseV2 {
            let internal = internalOperationStatusRequest(request);
            switch (service.operationStatus(internal)) {
                case (#err(error)) {
                    { outcome = ?#rejected(publicRejection(error)) };
                };
                case (#ok(result)) {
                    { outcome = ?#ok(publicOperationStatus(result)) };
                };
            };
        };

        public func /*update*/files_vault_write_v2(
            request : FilesVaultWriteRequestV2,
        ) : FilesVaultWriteResponseV2 {
            switch (service.vaultWrite(request, request.body)) {
                case (#err(error)) {
                    { outcome = ?#rejected(publicRejection(error)) };
                };
                case (#ok(result)) { { outcome = ?#ok(result) } };
            };
        };

        public func /*update*/files_write_block_v2(
            request : FilesWriteBlockRequestV2,
        ) : FilesWriteBlockResponseV2 {
            switch (service.writeBlock(request, request.body)) {
                case (#err(error)) {
                    { outcome = ?#rejected(publicRejection(error)) };
                };
                case (#ok(result)) { { outcome = ?#ok(result) } };
            };
        };

        public func /*update*/files_mutate_v2(
            request : FilesMutateRequestV2,
        ) : FilesMutateResponseV2 {
            switch (service.mutate(request, request.body)) {
                case (#err(error)) {
                    { outcome = ?#rejected(publicRejection(error)) };
                };
                case (#ok(result)) { { outcome = ?#ok(result) } };
            };
        };

        public func /*update*/files_remove_v2(
            request : FilesRemoveRequestV2,
        ) : FilesRemoveResponseV2 {
            switch (service.remove(request)) {
                case (#err(error)) {
                    { outcome = ?#rejected(publicRejection(error)) };
                };
                case (#ok(result)) { { outcome = ?#ok(result) } };
            };
        };

        public func /*update*/files_abort_v2(
            request : FilesAbortRequestV2,
        ) : FilesAbortResponseV2 {
            switch (service.abort(request)) {
                case (#err(error)) {
                    { outcome = ?#rejected(publicRejection(error)) };
                };
                case (#ok(result)) { { outcome = ?#ok(result) } };
            };
        };

        public func /*update*/files_cleanup_v2(
            _request : FilesCleanupRequestV2,
        ) : FilesCleanupResponseV2 {
            switch (service.cleanup()) {
                case (#err(error)) {
                    { outcome = ?#rejected(publicRejection(error)) };
                };
                case (#ok(result)) { { outcome = ?#ok(result) } };
            };
        };

        public func /*query*/files_plain_list_v3(
            request : FilesPlainListRequestV3,
        ) : FilesPlainListResponseV3 {
            plainService.list({
                request with space = internalPlainSpace(request.space)
            });
        };

        public func /*query*/files_plain_stat_v3(
            request : FilesPlainStatRequestV3,
        ) : FilesPlainStatResponseV3 {
            plainService.stat({
                request with space = internalPlainSpace(request.space)
            });
        };

        public func /*query*/files_plain_read_chunk_v3(
            request : FilesPlainReadChunkRequestV3,
        ) : FilesPlainReadChunkOutputV3 {
            plainService.readChunk({
                request with space = internalPlainSpace(request.space)
            });
        };

        public func /*update*/files_plain_write_block_v3(
            request : FilesPlainWriteBlockRequestV3,
        ) : FilesPlainWriteBlockResponseV3 {
            plainService.writeBlock({
                request with space = internalPlainSpace(request.space)
            });
        };

        public func /*update*/files_plain_mkdir_v3(
            request : FilesPlainMkdirRequestV3,
        ) : FilesPlainMutationResponseV3 {
            plainService.mkdir({
                request with space = internalPlainSpace(request.space)
            });
        };

        public func /*update*/files_plain_move_v3(
            request : FilesPlainMoveRequestV3,
        ) : FilesPlainMutationResponseV3 {
            plainService.move({
                request with space = internalPlainSpace(request.space)
            });
        };

        public func /*update*/files_plain_remove_v3(
            request : FilesPlainRemoveRequestV3,
        ) : FilesPlainMutationResponseV3 {
            plainService.remove({
                request with space = internalPlainSpace(request.space)
            });
        };

        public func /*update*/files_plain_abort_v3(
            request : FilesPlainAbortRequestV3,
        ) : FilesPlainMutationResponseV3 {
            plainService.abort({
                request with space = internalPlainSpace(request.space)
            });
        };

        public func /*update*/files_plain_cleanup_v3(
            request : FilesPlainCleanupRequestV3,
        ) : FilesPlainMutationResponseV3 {
            plainService.cleanup(request);
        };
    };

    func internalPlainSpace(
        value : ?FilesPlainSpaceV3
    ) : ?PlainTypes.Space {
        switch (value) {
            case (null) null;
            case (?#shared__) ?#shared_;
            case (?#workspace) ?#workspace;
        };
    };

    func publicRejection(value : BoundaryTypes.Rejection) : FilesRejectionV2 {
        {
            reason = value.reason;
            retry_after_ns = value.retry_after_ns;
        };
    };

    func publicDigest(value : BoundaryTypes.Digest256) : Digest256V2 {
        { a = value.0; b = value.1; c = value.2; d = value.3 };
    };

    func internalDigest(value : Digest256V2) : BoundaryTypes.Digest256 {
        (value.a, value.b, value.c, value.d);
    };

    func publicCleanupState(
        value : BoundaryTypes.CleanupState
    ) : FilesCleanupStateV2 {
        switch (value) {
            case (#clean) #clean;
            case (#pending(pending)) {
                #pending({ remaining_jobs = pending.remaining_jobs });
            };
        };
    };

    func publicOptionalCleanupState(
        value : ?BoundaryTypes.CleanupState
    ) : ?FilesCleanupStateV2 {
        switch (value) {
            case null null;
            case (?state) ?publicCleanupState(state);
        };
    };

    func publicBootstrap(value : BoundaryTypes.BootstrapOk) : {
        vault : ?FilesVaultStateV2;
        quota : FilesQuotaSnapshotV2;
        public_usage : FilesPublicUsageV2;
        cleanup : FilesCleanupSummaryV2;
        active_operations : [FilesOperationSummaryV2];
        body_bytes : Nat32;
    } {
        let vault = switch (value.vault) {
            case null null;
            case (?#absent) ?#absent;
            case (?#present(present)) {
                ?#present({
                    format = present.format;
                    record_revision = present.record_revision;
                    slot_generation = present.slot_generation;
                    public_key_fingerprint = publicDigest(
                        present.public_key_fingerprint
                    );
                    wrapper_frame_bytes = present.wrapper_frame_bytes;
                });
            };
        };
        {
            vault;
            quota = value.quota;
            public_usage = value.public_usage;
            cleanup = {
                remaining_jobs = value.cleanup.remaining_jobs;
                has_more = value.cleanup.has_more;
                state = publicOptionalCleanupState(value.cleanup.state);
            };
            active_operations = Array.map<
                BoundaryTypes.OperationSummary,
                FilesOperationSummaryV2
            >(
                value.active_operations,
                func(operation) {
                    {
                        request_id = operation.request_id;
                        kind = operation.kind;
                        stage_id = operation.stage_id;
                        expires_at_ns = operation.expires_at_ns;
                        target = switch (operation.target) {
                            case null null;
                            case (?target) ?publicOperationTarget(target);
                        };
                    };
                },
            );
            body_bytes = value.body_bytes;
        };
    };

    func publicListCursor(
        value : BoundaryTypes.ListCursor
    ) : FilesListCursorV2 {
        {
            parent_id = value.parent_id;
            children_revision = value.children_revision;
            last_name_tag = publicDigest(value.last_name_tag);
        };
    };

    func publicList(value : BoundaryTypes.ListOk) : {
        parent_id : Id128V2;
        structural_revision : Nat64;
        children_revision : Nat64;
        total_children : Nat32;
        loaded_count : Nat16;
        next_cursor : ?FilesListCursorV2;
        has_more : Bool;
        body_bytes : Nat32;
    } {
        {
            parent_id = value.parent_id;
            structural_revision = value.structural_revision;
            children_revision = value.children_revision;
            total_children = value.total_children;
            loaded_count = value.loaded_count;
            next_cursor = switch (value.next_cursor) {
                case null null;
                case (?cursor) ?publicListCursor(cursor);
            };
            has_more = value.has_more;
            body_bytes = value.body_bytes;
        };
    };

    func internalOperationTarget(
        value : FilesOperationTargetV2
    ) : BoundaryTypes.OperationTarget {
        switch (value) {
            case (#vault(target)) #vault(target);
            case (#private_write(target)) {
                #private_write({
                    nodes = Array.map<
                        FilesOperationWriteTargetNodeV2,
                        BoundaryTypes.OperationWriteTargetNode
                    >(
                        target.nodes,
                        func(node) {
                            {
                                node_id = node.node_id;
                                content_id = node.content_id;
                            };
                        },
                    );
                });
            };
            case (#mutation(target)) #mutation(target);
            case (#remove(target)) #remove(target);
            case (#abort(target)) #abort(target);
        };
    };

    func publicOperationTarget(
        value : BoundaryTypes.OperationTarget
    ) : FilesOperationTargetV2 {
        switch (value) {
            case (#vault(target)) #vault(target);
            case (#private_write(target)) {
                #private_write({
                    nodes = Array.map<
                        BoundaryTypes.OperationWriteTargetNode,
                        FilesOperationWriteTargetNodeV2
                    >(
                        target.nodes,
                        func(node) {
                            {
                                node_id = node.node_id;
                                content_id = node.content_id;
                            };
                        },
                    );
                });
            };
            case (#mutation(target)) #mutation(target);
            case (#remove(target)) #remove(target);
            case (#abort(target)) #abort(target);
        };
    };

    func internalOperationStatusRequest(
        value : FilesOperationStatusRequestV2
    ) : BoundaryTypes.OperationStatusRequest {
        {
            request_id = value.request_id;
            target = switch (value.target) {
                case null null;
                case (?target) ?internalOperationTarget(target);
            };
        };
    };

    func publicWriteBlock(
        value : BoundaryTypes.WriteBlockOk
    ) : FilesWriteBlockOkV2 {
        {
            request_id = value.request_id;
            stage_id = value.stage_id;
            frame_ordinal = value.frame_ordinal;
            accepted_frames_bitmap = value.accepted_frames_bitmap;
            committed_nodes = Array.map<
                BoundaryTypes.CommittedNode,
                FilesCommittedNodeV2
            >(
                value.committed_nodes,
                func(node) {
                    {
                        node_id = node.node_id;
                        content_id = node.content_id;
                        structural_revision = node.structural_revision;
                        metadata_revision = node.metadata_revision;
                    };
                },
            );
            cleanup_state = publicOptionalCleanupState(value.cleanup_state);
        };
    };

    func publicCommittedDetail(
        value : BoundaryTypes.CommittedDetail
    ) : FilesCommittedDetailV2 {
        switch (value) {
            case (#vault(detail)) #vault(detail);
            case (#private_write(detail)) {
                #private_write(publicWriteBlock(detail));
            };
            case (#mutation(detail)) #mutation(detail);
            case (#remove(detail)) {
                #remove({
                    request_id = detail.request_id;
                    node_id = detail.node_id;
                    detached_plaintext_bytes =
                        detail.detached_plaintext_bytes;
                    reclaimed_entries = detail.reclaimed_entries;
                    reclaimed_ciphertext_bytes =
                        detail.reclaimed_ciphertext_bytes;
                    cleanup_state = publicOptionalCleanupState(
                        detail.cleanup_state
                    );
                });
            };
            case (#abort(detail)) {
                #abort({
                    request_id = detail.request_id;
                    stage_id = detail.stage_id;
                    cleanup_state = publicOptionalCleanupState(
                        detail.cleanup_state
                    );
                });
            };
        };
    };

    func publicOperationState(
        value : BoundaryTypes.OperationState
    ) : FilesOperationStateV2 {
        switch (value) {
            case (#active(active)) {
                #active({
                    stage_id = active.stage_id;
                    accepted_frames_bitmap =
                        active.accepted_frames_bitmap;
                    frame_block_mapping = Array.map<
                        BoundaryTypes.FrameBlockMapping,
                        FilesFrameBlockMappingV2
                    >(
                        active.frame_block_mapping,
                        func(mapping) {
                            {
                                frame_ordinal = mapping.frame_ordinal;
                                content_id = mapping.content_id;
                                block_index = mapping.block_index;
                            };
                        },
                    );
                    staged_bytes = active.staged_bytes;
                    expires_at_ns = active.expires_at_ns;
                });
            };
            case (#committed(committed)) {
                #committed({
                    detail = switch (committed.detail) {
                        case null null;
                        case (?detail) ?publicCommittedDetail(detail);
                    };
                });
            };
            case (#aborted(terminal)) #aborted(terminal);
            case (#expired(terminal)) #expired(terminal);
            case (#superseded(superseded)) #superseded(superseded);
            case (#unknown) #unknown;
        };
    };

    func publicOperationStatus(
        value : BoundaryTypes.OperationStatusOk
    ) : {
        request_id : Id128V2;
        target : ?FilesOperationTargetV2;
        state : ?FilesOperationStateV2;
        cleanup_state : ?FilesCleanupStateV2;
    } {
        {
            request_id = value.request_id;
            target = switch (value.target) {
                case null null;
                case (?target) ?publicOperationTarget(target);
            };
            state = switch (value.state) {
                case null null;
                case (?state) ?publicOperationState(state);
            };
            cleanup_state = publicOptionalCleanupState(value.cleanup_state);
        };
    };

    func rejectedAttachment(
        error : BoundaryTypes.Rejection
    ) : {
        value : { outcome : ?{ #rejected : FilesRejectionV2 } };
        body : Blob;
    } {
        {
            value = {
                outcome = ?#rejected(publicRejection(error));
            };
            body = "";
        };
    };

/*---NEUTRON GENERATED BEGIN---*/

public type files_bootstrap_v2_Input = (_request : FilesBootstrapRequestV2,);
public type files_bootstrap_v2_Output = FilesBootstrapOutputV2;

public type files_list_v2_Input = (request : FilesListRequestV2,);
public type files_list_v2_Output = FilesListOutputV2;

public type files_lookup_v2_Input = (request : FilesLookupRequestV2,);
public type files_lookup_v2_Output = FilesLookupOutputV2;

public type files_read_chunk_v2_Input = (request : FilesReadChunkRequestV2,);
public type files_read_chunk_v2_Output = FilesReadChunkOutputV2;

public type files_operation_status_v2_Input = (request : FilesOperationStatusRequestV2,);
public type files_operation_status_v2_Output = FilesOperationStatusResponseV2;

public type files_vault_write_v2_Input = (request : FilesVaultWriteRequestV2,);
public type files_vault_write_v2_Output = FilesVaultWriteResponseV2;

public type files_write_block_v2_Input = (request : FilesWriteBlockRequestV2,);
public type files_write_block_v2_Output = FilesWriteBlockResponseV2;

public type files_mutate_v2_Input = (request : FilesMutateRequestV2,);
public type files_mutate_v2_Output = FilesMutateResponseV2;

public type files_remove_v2_Input = (request : FilesRemoveRequestV2,);
public type files_remove_v2_Output = FilesRemoveResponseV2;

public type files_abort_v2_Input = (request : FilesAbortRequestV2,);
public type files_abort_v2_Output = FilesAbortResponseV2;

public type files_cleanup_v2_Input = (_request : FilesCleanupRequestV2,);
public type files_cleanup_v2_Output = FilesCleanupResponseV2;

public type files_plain_list_v3_Input = (request : FilesPlainListRequestV3,);
public type files_plain_list_v3_Output = FilesPlainListResponseV3;

public type files_plain_stat_v3_Input = (request : FilesPlainStatRequestV3,);
public type files_plain_stat_v3_Output = FilesPlainStatResponseV3;

public type files_plain_read_chunk_v3_Input = (request : FilesPlainReadChunkRequestV3,);
public type files_plain_read_chunk_v3_Output = FilesPlainReadChunkOutputV3;

public type files_plain_write_block_v3_Input = (request : FilesPlainWriteBlockRequestV3,);
public type files_plain_write_block_v3_Output = FilesPlainWriteBlockResponseV3;

public type files_plain_mkdir_v3_Input = (request : FilesPlainMkdirRequestV3,);
public type files_plain_mkdir_v3_Output = FilesPlainMutationResponseV3;

public type files_plain_move_v3_Input = (request : FilesPlainMoveRequestV3,);
public type files_plain_move_v3_Output = FilesPlainMutationResponseV3;

public type files_plain_remove_v3_Input = (request : FilesPlainRemoveRequestV3,);
public type files_plain_remove_v3_Output = FilesPlainMutationResponseV3;

public type files_plain_abort_v3_Input = (request : FilesPlainAbortRequestV3,);
public type files_plain_abort_v3_Output = FilesPlainMutationResponseV3;

public type files_plain_cleanup_v3_Input = (request : FilesPlainCleanupRequestV3,);
public type files_plain_cleanup_v3_Output = FilesPlainMutationResponseV3;

/*---NEUTRON GENERATED END---*/
};
