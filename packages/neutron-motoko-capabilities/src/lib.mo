module {
    public type DeferredTimerPhaseV1 = {
        #waiting;
        #running;
    };

    public type DeferredTimerStatusV1 = {
        due_at_ns : Nat64;
        phase : DeferredTimerPhaseV1;
    };

    public type DeferredTimerErrorV1 = {
        #invalid;
        #full;
        #source_gone;
    };

    public type DeferredTimerArmInputV1 = {
        key : Text;
        delay_seconds : Nat;
        callback : () -> ();
    };

    public type DeferredTimerArmResultV1 = {
        #armed : DeferredTimerStatusV1;
        #already_armed : DeferredTimerStatusV1;
        #err : DeferredTimerErrorV1;
    };

    // App-scoped keyed one-shot timers. arm() is leading-edge: an existing
    // key is returned unchanged rather than moving its due time.
    public type DeferredTimersV1 = {
        arm : DeferredTimerArmInputV1 -> async* DeferredTimerArmResultV1;
        status : Text -> ?DeferredTimerStatusV1;
    };

    public type BackendCallRequestV1 = {
        canister : Principal;
        method : Text;
        args : Blob;
        // Cycles transferred through the kernel-owned broker. The app never
        // receives a raw cycle primitive; this value is bounded by its
        // installed declaration before the remote call is dispatched.
        cycles : Nat;
    };

    public type BackendCallErrorV1 = {
        code : Text;
        message : Text;
    };

    public type BackendCallResultV1 = {
        #ok : Blob;
        #err : BackendCallErrorV1;
    };

    public type BackendCallsV1 = {
        canister_principal : Principal;
        can_call : (Principal, Text) -> Bool;
        call : BackendCallRequestV1 -> async* BackendCallResultV1;
        call_batch : [BackendCallRequestV1] -> async* [BackendCallResultV1];
    };

    public type RandomnessErrorV1 = {
        #busy;
        #low_cycles;
        #management_failure;
        #source_gone;
    };

    public type RandomnessResultV1 = {
        #ok : Blob;
        #err : RandomnessErrorV1;
    };

    public type RandomnessV1 = {
        fresh_bytes : () -> async* RandomnessResultV1;
    };

    public type ChainKeyAlgorithmV1 = {
        #ecdsa_secp256k1;
        #schnorr_bip340secp256k1;
        #schnorr_ed25519;
    };

    public type ChainKeyMessageFormatV1 = {
        #neutron_app_assertion_v1;
    };

    public type ChainKeyPublicKeyV1 = {
        slot : Text;
        algorithm : ChainKeyAlgorithmV1;
        public_key : Blob;
        key_fingerprint : Blob;
        signing_domain : Blob;
        namespace_version : Nat;
        message_format : ChainKeyMessageFormatV1;
    };

    public type ChainKeySignatureV1 = {
        slot : Text;
        algorithm : ChainKeyAlgorithmV1;
        digest : Blob;
        signature : Blob;
        signing_domain : Blob;
        message_format : ChainKeyMessageFormatV1;
    };

    public type ChainKeySigningErrorV1 = {
        #invalid_request;
        #not_declared;
        #disabled;
        #busy;
        #cost_too_high;
        #low_cycles;
        #key_unavailable;
        #management_failure;
        #outcome_unknown;
        #source_gone;
        #revoked_after_dispatch;
    };

    public type ChainKeyPublicKeyResultV1 = {
        #ok : ChainKeyPublicKeyV1;
        #err : ChainKeySigningErrorV1;
    };

    public type ChainKeySignatureResultV1 = {
        #ok : ChainKeySignatureV1;
        #err : ChainKeySigningErrorV1;
    };

    public type ChainKeySignAssertionRequestV1 = {
        slot : Text;
        assertion : Blob;
    };

    // The compiler-created factory captures the app installation and exact
    // slot declarations. Callers can discover a public key or sign only the
    // kernel-framed assertion format; there is no raw digest or key-path API.
    public type ChainKeySigningV1 = {
        public_key : Text -> async* ChainKeyPublicKeyResultV1;
        sign_assertion : ChainKeySignAssertionRequestV1 -> async* ChainKeySignatureResultV1;
    };

    public type HttpsOutcallMethodV1 = {
        #get;
        #head;
        #post;
    };

    public type HttpsOutcallHeaderV1 = {
        name : Text;
        value : Text;
    };

    public type HttpsOutcallRequestV1 = {
        endpoint : Text;
        method : HttpsOutcallMethodV1;
        path : Text;
        query_params : [(Text, Text)];
        headers : [HttpsOutcallHeaderV1];
        body : Blob;
        idempotency_key : ?Text;
    };

    public type HttpsOutcallResponseV1 = {
        status : Nat;
        body : Blob;
    };

    public type HttpsOutcallErrorV1 = {
        #invalid_request;
        #not_declared;
        #disabled;
        #busy;
        #cost_too_high;
        #low_cycles;
        #redirected;
        #management_failure;
        #source_gone;
        #revoked_after_dispatch;
    };

    public type HttpsOutcallResultV1 = {
        #ok : HttpsOutcallResponseV1;
        #err : HttpsOutcallErrorV1;
    };

    // The compiler-created kernel factory captures app identity and the
    // declaration. Apps receive no management-canister reference, URL origin, transform,
    // or cycle-attachment primitive.
    public type HttpsOutcallsV1 = {
        request : HttpsOutcallRequestV1 -> async* HttpsOutcallResultV1;
    };

    public type VetKeySlotStatusV1 = {
        #enabled;
        #disabled;
        #manifest_suspended;
    };

    public type VetKeyGenerationStatusV1 = {
        #current;
        #previous;
    };

    public type VetKeyEnvironmentV1 = {
        #production;
        #local;
    };

    public type VetKeyGenerationSummaryV1 = {
        generation : Nat64;
        status : VetKeyGenerationStatusV1;
        key_name : Text;
        public_fingerprint : ?Blob;
    };

    public type VetKeySlotSummaryV1 = {
        slot : Text;
        purpose : Text;
        key_holder : Principal;
        status : VetKeySlotStatusV1;
        environment : VetKeyEnvironmentV1;
        current_generation : Nat64;
        previous_generation : ?Nat64;
        generations : [VetKeyGenerationSummaryV1];
        created_at : Nat64;
        updated_at : Nat64;
        last_used_at : ?Nat64;
        total_derivations : Nat;
        approximate_cycle_spend : Nat;
    };

    public type VetKeyPublicKeyRequestV1 = {
        slot : Text;
        generation : Nat64;
    };

    public type VetKeyPublicKeyInfoV1 = {
        canister_principal : Principal;
        slot : Text;
        generation : Nat64;
        suite : Text;
        key_name : Text;
        public_key : Blob;
        public_fingerprint : Blob;
        derivation_input : Blob;
    };

    public type VetKeysPublicErrorV1 = {
        #not_declared;
        #not_reserved;
        #manifest_suspended;
        #disabled;
        #generation_unavailable;
        #invalid_request;
        #challenge_expired;
        #challenge_consumed;
        #busy;
        #low_cycles;
        #key_unavailable;
        #management_failure;
        #source_gone;
        #owner_required;
    };

    public type VetKeyPublicKeyResultV1 = {
        #ok : VetKeyPublicKeyInfoV1;
        #err : VetKeysPublicErrorV1;
    };

    // Backend vetKey access intentionally stops at public metadata and public
    // key discovery. Browser derivation, slot administration, key adapters,
    // cycle selection, and kernel factories are not part of this package.
    public type VetKeysPublicV1 = {
        canister_principal : Principal;
        slot : Text -> ?VetKeySlotSummaryV1;
        public_key : VetKeyPublicKeyRequestV1 -> async* VetKeyPublicKeyResultV1;
    };

    // Certified Assets V2 is app/install scoped by the compiler-created
    // factory. Locators are collection-relative and cannot express a raw URL,
    // host, mount, certificate-tree key, response header, or another app.
    public type Locator = {
        #publication : {
            publication_id : Blob;
            filename : Text;
        };
        #body_sha256 : { digest : Blob };
        #key32 : { key : Blob };
        #exact_path;
    };

    public type Target = {
        collection : Text;
        collection_generation : Nat64;
        locator : Locator;
    };

    public type Condition = {
        #absent;
        #match : {
            revision : Nat64;
            content_tag : Blob;
        };
    };

    public type PublicationPresentation = {
        #inline_text;
        #attachment;
    };

    public type StageTarget = {
        #allocate_publication : {
            collection : Text;
            collection_generation : Nat64;
            filename : Text;
            presentation : PublicationPresentation;
        };
        #derive_body_sha256 : {
            collection : Text;
            collection_generation : Nat64;
        };
    };

    public type BodySource = {
        #inline : Blob;
        #stage : Nat64;
    };

    public type BatchOperation = {
        #put : {
            target : Target;
            condition : Condition;
            body : BodySource;
        };
        #delete : {
            target : Target;
            condition : {
                revision : Nat64;
                content_tag : Blob;
            };
        };
    };

    public type PresentRequirement = {
        target : Target;
        content_tag : Blob;
        revision : ?Nat64;
    };

    public type CommitBatchInput = {
        // Exactly 16 bytes.
        nonce : Blob;
        operations : [BatchOperation];
        requires_present_after : [PresentRequirement];
    };

    // Manifest and effective admission limits use the same complete shape.
    // The kernel validates every caller-provided Blob, vector, and aggregate
    // against the captured collection and these reviewed limits.
    public type Limits = {
        entries : Nat;
        committed_bytes : Nat;
        object_bytes : Nat;
        staged_bytes : Nat;
        pending_stages : Nat;
        batch_operations : Nat;
        batch_bytes : Nat;
        general_receipts : Nat;
        revocation_lanes : Nat;
    };

    public type CollectionKind = {
        #publication;
        #immutable_blob;
        #mutable_blob;
    };

    public type CollectionInfo = {
        id : Text;
        kind : CollectionKind;
        authority_epoch : Nat64;
        generation : Nat64;
        serving : {
            #enabled;
            #disabled;
        };
        writes : {
            #enabled;
            #frozen;
        };
        manifest_limits : Limits;
        effective_limits : Limits;
    };

    public type ScopeInfo = {
        installation_generation : Nat64;
        store_authority_epoch : Nat64;
        // Sorted and manifest-bounded.
        collections : [CollectionInfo];
    };

    public type StageGeometry = {
        block_bytes : Nat;
        block_count : Nat32;
        expected_bytes : Nat;
    };

    public type RecordIdentity = {
        target : Target;
        kernel_revision : Nat64;
        // Exactly 32 bytes.
        content_tag : Blob;
        body_bytes : Nat;
        geometry : StageGeometry;
        // Every entry is exactly 32 bytes; the vector has at most 36 entries.
        block_hashes : [Blob];
    };

    public type CasIdentity = {
        collection_generation : Nat64;
        kernel_revision : Nat64;
        // Exactly 32 bytes.
        content_tag : Blob;
        body_bytes : Nat;
    };

    public type DeletedIdentity = {
        target : Target;
        kernel_revision : Nat64;
        prior_content_tag : Blob;
    };

    public type StageIdentity = {
        collection : Text;
        collection_generation : Nat64;
        computed_target : ?Target;
    };

    public type BeginStageInput = {
        // Exactly 16 bytes.
        nonce : Blob;
        target : StageTarget;
        expected_bytes : Nat;
    };

    public type BeginStageOk = {
        stage_id : Nat64;
        identity : StageIdentity;
        geometry : StageGeometry;
        expires_at_ns : Nat64;
    };

    public type PutChunkInput = {
        stage_id : Nat64;
        index : Nat32;
        body : Blob;
    };

    public type StageProgress = {
        next_block_index : Nat32;
        block_hashes : [Blob];
    };

    public type StageTerminal = {
        stage_id : Nat64;
        identity : StageIdentity;
        geometry : StageGeometry;
        terminal_at_ns : Nat64;
        reconcile_until_ns : Nat64;
    };

    public type LifecycleOutcome = {
        committed : RecordIdentity;
    };

    public type StageStatus = {
        #active : {
            stage_id : Nat64;
            identity : StageIdentity;
            geometry : StageGeometry;
            progress : StageProgress;
            // Set when an ordered stage is complete; hashes the whole body.
            raw_sha256 : ?Blob;
            expires_at_ns : Nat64;
        };
        #consumed : {
            stage : StageTerminal;
            lifecycle : LifecycleOutcome;
        };
        #aborted : StageTerminal;
        #expired : StageTerminal;
        #unknown;
    };

    public type ChunkOk = {
        stage_id : Nat64;
        index : Nat32;
        block_sha256 : Blob;
        accepted : {
            #new;
            #replayed;
        };
        complete : Bool;
        raw_sha256 : ?Blob;
        computed_target : ?Target;
    };

    public type PutReceipt = {
        request_index : Nat32;
        lifecycle : LifecycleOutcome;
    };

    public type DeleteReceipt = {
        request_index : Nat32;
        identity : DeletedIdentity;
    };

    public type OperationReceipt = {
        #put : PutReceipt;
        #delete : DeleteReceipt;
    };

    public type BatchReceipt = {
        // Input indexes, sorted by request_index.
        operations : [OperationReceipt];
    };

    public type RecordStatus = {
        #present : RecordIdentity;
        #absent : { collection_generation : Nat64 };
        #recently_deleted : DeletedIdentity;
        #deleted_high_water : DeletedIdentity;
    };

    public type Reclaimed = {
        records : Nat;
        bodies : Nat;
        body_bytes : Nat;
        charged_bytes : Nat;
        authenticated_nodes : Nat;
        receipts : Nat;
    };

    public type MaintenancePageOk = {
        page : Reclaimed;
        has_more : Bool;
        remaining_jobs : Nat;
    };

    public type UsageCounters = {
        live_entries : Nat;
        occupied_entry_slots : Nat;
        committed_body_bytes : Nat;
        reserved_committed_body_bytes : Nat;
        allocated_body_bytes : Nat;
        charged_metadata_bytes : Nat;
        accepted_staged_bytes : Nat;
        reserved_staged_bytes : Nat;
        detached_charged_bytes : Nat;
        active_stages : Nat;
        reserved_entry_slots : Nat;
        receipt_lanes : Nat;
        general_receipt_lanes : Nat;
        reserved_general_receipt_lanes : Nat;
        reserved_revocation_lanes : Nat;
        filled_revocation_lanes : Nat;
        receipt_nonce_indexes : Nat;
        receipt_expiry_indexes : Nat;
        cleanup_jobs : Nat;
    };

    public type Usage = {
        current : UsageCounters;
        manifest_limits : Limits;
        effective_limits : Limits;
    };

    public type Error = {
        #invalid;
        #stale_scope;
        #stale_generation : { current : Nat64 };
        #disabled;
        #frozen;
        #not_found;
        #retired_key;
        #conflict : { current : ?CasIdentity };
        #quota;
        #receipt_full;
        #aborted;
        #expired;
        // The vector is bounded to at most 36 indexes.
        #incomplete : { missing_blocks : [Nat32] };
        #not_ready;
        #generation_exhausted;
        #revision_exhausted;
        #low_cycles;
        #busy;
    };

    public type ScopeInfoResult = {
        #ok : ScopeInfo;
        #err : Error;
    };

    public type BeginStageResult = {
        #ok : BeginStageOk;
        #err : Error;
    };

    public type ChunkResult = {
        #ok : ChunkOk;
        #err : Error;
    };

    public type StageStatusResult = {
        #ok : StageStatus;
        #err : Error;
    };

    public type CommitBatchResult = {
        #ok : BatchReceipt;
        #err : Error;
    };

    public type RecordStatusResult = {
        #ok : RecordStatus;
        #err : Error;
    };

    public type MaintenancePageResult = {
        #ok : MaintenancePageOk;
        #err : Error;
    };

    public type UsageResult = {
        #ok : Usage;
        #err : Error;
    };

    public type Result = {
        #ok;
        #err : Error;
    };

    // This synchronous local handle captures the exact app installation and
    // declared collections. It exposes neither a clear operation nor a raw
    // certification, storage, response, or cross-scope primitive.
    public type CertifiedAssetsV2 = {
        scope_info : () -> ScopeInfoResult;
        begin_stage : BeginStageInput -> BeginStageResult;
        put_chunk : PutChunkInput -> ChunkResult;
        stage_status : Nat64 -> StageStatusResult;
        abort_stage : Nat64 -> Result;
        commit_batch : CommitBatchInput -> CommitBatchResult;
        record_status : Target -> RecordStatusResult;
        maintenance_page : () -> MaintenancePageResult;
        usage : () -> UsageResult;
    };

    public type StableStoreConditionV1 = {
        #unconditional;
        #if_absent;
        #if_revision : Nat64;
    };

    // This is a bounded logical continuation, not a stable-memory pointer.
    // The broker rejects it if the store namespace generation or prefix no
    // longer matches the requested page.
    public type StableStoreCursorV1 = {
        namespace_uid : Nat64;
        prefix : Blob;
        after : Blob;
    };

    public type StableStoreEntryV1 = {
        key : Blob;
        value : Blob;
        revision : Nat64;
        schema_version : Nat;
    };

    public type StableStoreUsageV1 = {
        store : Text;
        schema_version : Nat;
        entries : Nat;
        bytes : Nat;
        max_entries : Nat;
        max_bytes : Nat;
        over_quota : Bool;
    };

    public type StableStoreErrorV1 = {
        #source_gone;
        #not_declared;
        #disabled;
        #invalid_request;
        #too_large;
        #quota_exceeded;
        #not_found;
        #conflict : { current_revision : ?Nat64 };
        #low_cycles;
        #not_replicated;
        #revision_exhausted;
        #cursor_stale;
    };

    public type StableStoreGetRequestV1 = {
        store : Text;
        key : Blob;
    };

    public type StableStorePutRequestV1 = {
        store : Text;
        key : Blob;
        value : Blob;
        condition : StableStoreConditionV1;
    };

    public type StableStorePutReceiptV1 = {
        revision : Nat64;
        schema_version : Nat;
        usage : StableStoreUsageV1;
    };

    public type StableStoreDeleteRequestV1 = {
        store : Text;
        key : Blob;
        expected_revision : ?Nat64;
    };

    public type StableStoreListRequestV1 = {
        store : Text;
        prefix : Blob;
        cursor : ?StableStoreCursorV1;
        limit : Nat;
    };

    public type StableStorePageV1 = {
        entries : [StableStoreEntryV1];
        next : ?StableStoreCursorV1;
        observed_revision : Nat64;
    };

    public type StableStoreClearPageRequestV1 = {
        store : Text;
        prefix : Blob;
        limit : Nat;
    };

    public type StableStoreClearPageReceiptV1 = {
        removed_entries : Nat;
        removed_bytes : Nat;
        more : Bool;
        usage : StableStoreUsageV1;
    };

    public type StableStoreGetResultV1 = {
        #ok : ?StableStoreEntryV1;
        #err : StableStoreErrorV1;
    };

    public type StableStorePutResultV1 = {
        #ok : StableStorePutReceiptV1;
        #err : StableStoreErrorV1;
    };

    public type StableStoreDeleteResultV1 = {
        #ok : StableStoreUsageV1;
        #err : StableStoreErrorV1;
    };

    public type StableStoreListResultV1 = {
        #ok : StableStorePageV1;
        #err : StableStoreErrorV1;
    };

    public type StableStoreUsageResultV1 = {
        #ok : StableStoreUsageV1;
        #err : StableStoreErrorV1;
    };

    public type StableStoreClearPageResultV1 = {
        #ok : StableStoreClearPageReceiptV1;
        #err : StableStoreErrorV1;
    };

    // The compiler-created factory captures the app installation. Apps can
    // address only declared logical store ids and receive no Region, raw
    // stable-memory offset, physical namespace, or installation identity.
    public type StableStoreV1 = {
        get : StableStoreGetRequestV1 -> StableStoreGetResultV1;
        put : StableStorePutRequestV1 -> StableStorePutResultV1;
        delete : StableStoreDeleteRequestV1 -> StableStoreDeleteResultV1;
        list : StableStoreListRequestV1 -> StableStoreListResultV1;
        usage : Text -> StableStoreUsageResultV1;
        clear_page : StableStoreClearPageRequestV1 -> StableStoreClearPageResultV1;
    };

    // A public-ingress update handler can inspect and logically reserve more
    // of the cycles attached to its outer call. The kernel owns the actual
    // cycle primitive and performs acceptance after the handler returns.
    public type PublicIngressCyclesV1 = {
        available : () -> Nat;
        request : Nat -> ();
    };

    // Stable cross-canister wire for compiler-generated public-ingress
    // protocol dispatchers. App and protocol identity are captured by the
    // physical Candid method; callers may select only a declared local route.
    public type PublicIngressRequestV1 = {
        method : Text;
        payload : Blob;
    };

    public type PublicIngressErrorV1 = {
        #bad_request;
        #not_found;
        #too_large;
        #unauthorized;
        #rate_limited;
        #busy;
        #low_cycles;
        #revoked;
        // The handler self-call committed, but live authority disappeared
        // before the outer dispatcher could release its reply.
        #revoked_after_dispatch;
        #handler_failed;
    };

    public type PublicIngressResultV1 = {
        #ok : Blob;
        #err : PublicIngressErrorV1;
    };

    // Public HTTP POST update handlers are compiler-bound entry points, not
    // durable capability handles. The kernel supplies only the canonical
    // route-relative path, explicitly declared headers, the bounded body,
    // and a non-secret digest of the kernel-owned idempotency key.
    public type HttpPostUpdateHandlerRequestV1 = {
        path : Text;
        headers : [(Text, Text)];
        body : Blob;
        request_id_hash : Blob;
    };

    public type HttpPostUpdateHandlerStatusV1 = {
        #ok;
        #created;
        #accepted;
        #bad_request;
        #unauthorized;
        #forbidden;
        #not_found;
        #conflict;
        #unprocessable_content;
    };

    public type HttpPostUpdateHandlerResponseV1 = {
        status : HttpPostUpdateHandlerStatusV1;
        content_type : Text;
        body : Blob;
    };
};
