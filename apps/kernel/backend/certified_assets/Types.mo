import Map "mo:core/Map";
import Region "mo:core/Region";
import Caps "mo:neutron-capabilities";
import CapabilityTypes "../capabilities/Types";
import AuthenticatedForest "./AuthenticatedForest";

module {
    public type AppScope = CapabilityTypes.AppScope;

    // ---------------------------------------------------------------------
    // Install-reviewed declaration
    // ---------------------------------------------------------------------

    public type HttpMethod = { #get; #head };
    public type AuthorityMode = {
        #exact_neutron_host_v1;
        #canister_gateway_v1;
    };

    public type CollectionKind = Caps.CollectionKind;

    public type ServingState = { #enabled; #disabled };
    public type WriteState = { #enabled; #frozen };

    public type Limits = Caps.Limits;

    // A publication accepts neither path field. An immutable blob requires a
    // prefix. A mutable blob requires exactly one prefix or exact path.
    public type CollectionDeclaration = {
        id : Text;
        mount : Text;
        kind : CollectionKind;
        path_prefix : ?Text;
        exact_path : ?Text;
        max_object_bytes : ?Nat;
        authority_epoch : Nat64;
        generation : Nat64;
        serving : ServingState;
        writes : WriteState;
    };

    public type AppDeclaration = {
        app_scope : AppScope;
        certified_assets : ?AuthoredStoreDeclaration;
    };

    public type AuthoredCollectionDeclaration = {
        id : Text;
        mount : Text;
        path_prefix : ?Text;
        exact_path : ?Text;
        kind : Text;
        max_object_bytes : ?Nat;
    };

    public type AuthoredStoreDeclaration = {
        api : Nat;
        max_entries : Nat;
        max_committed_bytes : Nat;
        max_object_bytes : Nat;
        max_pending_stages : Nat;
        max_staged_bytes : Nat;
        max_batch_operations : Nat;
        max_batch_bytes : Nat;
        max_idempotency_receipts : Nat;
        collections : [AuthoredCollectionDeclaration];
    };

    // ---------------------------------------------------------------------
    // Scoped public capability
    // ---------------------------------------------------------------------

    // The capabilities package is the sole public leaf contract. Backend code
    // imports these aliases rather than maintaining a structurally mirrored API.
    public type Locator = Caps.Locator;
    public type Target = Caps.Target;
    public type Condition = Caps.Condition;
    public type PublicationPresentation = Caps.PublicationPresentation;
    public type StageTarget = Caps.StageTarget;
    public type BodySource = Caps.BodySource;
    public type BatchOperation = Caps.BatchOperation;
    public type PresentRequirement = Caps.PresentRequirement;
    public type CommitBatchInput = Caps.CommitBatchInput;
    public type BeginStageInput = Caps.BeginStageInput;
    public type PutChunkInput = Caps.PutChunkInput;
    public type CollectionInfo = Caps.CollectionInfo;
    public type ScopeInfo = Caps.ScopeInfo;
    public type StageGeometry = Caps.StageGeometry;
    public type StageIdentity = Caps.StageIdentity;
    public type BeginStageOk = Caps.BeginStageOk;
    public type StageProgress = Caps.StageProgress;
    public type StageTerminal = Caps.StageTerminal;
    public type RecordIdentity = Caps.RecordIdentity;
    public type CasIdentity = Caps.CasIdentity;
    public type DeletedIdentity = Caps.DeletedIdentity;
    public type LifecycleOutcome = Caps.LifecycleOutcome;
    public type StageStatus = Caps.StageStatus;
    public type ChunkOk = Caps.ChunkOk;
    public type PutReceipt = Caps.PutReceipt;
    public type DeleteReceipt = Caps.DeleteReceipt;
    public type OperationReceipt = Caps.OperationReceipt;
    public type BatchReceipt = Caps.BatchReceipt;
    public type RecordStatus = Caps.RecordStatus;
    public type Reclaimed = Caps.Reclaimed;
    public type MaintenancePageOk = Caps.MaintenancePageOk;
    public type UsageCounters = Caps.UsageCounters;
    public type Usage = Caps.Usage;

    public type AllocatorDiagnostics = {
        header_valid : Bool;
        mutation_epoch : Nat64;
        committed_high_water_bytes : Nat64;
        allocated_bytes : Nat64;
        allocated_extents : Nat;
        free_extents : Nat;
        descriptor_count : Nat;
        descriptor_limit : Nat;
        capacity_limit_bytes : Nat64;
        allocatable_limit_bytes : Nat64;
        allocatable_headroom_bytes : Nat64;
        metadata_charge_bytes : Nat;
    };

    public type AuthenticatedForestDiagnostics =
        AuthenticatedForest.Diagnostics;

    public type ChargingDiagnostics = {
        total_charged_bytes : Nat;
        total_installed_reservation_bytes : Nat;
        reserved_headroom_bytes : Nat;
        allocator_metadata_charge_bytes : Nat;
        envelope_used_bytes : Nat;
        envelope_limit_bytes : Nat;
        total_installed_arena_reservation_bytes : Nat;
        reserved_arena_headroom_bytes : Nat;
        arena_envelope_used_bytes : Nat;
        arena_envelope_limit_bytes : Nat;
        total_installed_arena_extent_reservation : Nat;
        reserved_arena_extent_headroom : Nat;
        arena_extent_envelope_used : Nat;
        arena_extent_envelope_limit : Nat;
    };

    public type ImplementationBindingDiagnostics = {
        allocator_layout_fingerprint : Blob;
        response_policy_fingerprint : Blob;
    };

    public type Diagnostics = {
        implementation_binding : ImplementationBindingDiagnostics;
        allocator : AllocatorDiagnostics;
        authenticated_forest : AuthenticatedForestDiagnostics;
        charging : ChargingDiagnostics;
    };

    public type AdmissionCeilings = {
        entries : Nat;
        committed_bytes : Nat;
        staged_bytes : Nat;
        general_receipts : Nat;
    };

    public type Error = Caps.Error;
    public type ScopeInfoResult = Caps.ScopeInfoResult;
    public type BeginStageResult = Caps.BeginStageResult;
    public type ChunkResult = Caps.ChunkResult;
    public type StageStatusResult = Caps.StageStatusResult;
    public type CommitBatchResult = Caps.CommitBatchResult;
    public type RecordStatusResult = Caps.RecordStatusResult;
    public type MaintenancePageResult = Caps.MaintenancePageResult;
    public type UsageResult = Caps.UsageResult;
    public type Result = Caps.Result;
    public type CertifiedAssetsV2 = Caps.CertifiedAssetsV2;
    public type Capability = Caps.CertifiedAssetsV2;

    // ---------------------------------------------------------------------
    // HTTP-facing resolution
    // ---------------------------------------------------------------------

    public type ResolvedBlock = {
        index : Nat32;
        offset : Nat;
        length : Nat;
        body_hash : Blob;
        body : Blob;
    };
    public type ResolvedChunkDescriptor = {
        index : Nat32;
        offset : Nat;
        length : Nat;
        body_hash : Blob;
    };
    public type RangeSelection = {
        #absent;
        #start : Nat;
        #unsupported;
    };

    public type Resolved = {
        scope : AppScope;
        mount_id : Text;
        collection : Text;
        method : HttpMethod;
        authority_mode : AuthorityMode;
        canonical_path : Text;
        kind : CollectionKind;
        presentation : ?PublicationPresentation;
        content_tag : Blob;
        body_bytes : Nat;
        body_hash : Blob;
        chunk_descriptors : [ResolvedChunkDescriptor];
        blocks : [ResolvedBlock];
        filename : ?Text;
        certification_leaf_key : ?CertificationLeafKey;
    };

    public type ResolvedAbsence = {
        scope : AppScope;
        mount_id : Text;
        canonical_path : Text;
        authority_mode : AuthorityMode;
        certification_leaf_key : CertificationLeafKey;
    };
    public type ResolveResult = {
        #present : Resolved;
        #absent : ResolvedAbsence;
        #bad_request;
    };

    public type CertificationHostMode = { #exact : Text; #excluded };
    public type CertificationExpressionKind = { #exact; #wildcard };
    public type CertificationOwner = {
        method : Text;
        canonical_path : Text;
        expression_kind : CertificationExpressionKind;
        host_mode : CertificationHostMode;
    };
    public type CertificationLeafKey = {
        owner : CertificationOwner;
        expression_hash : Blob;
        request_hash : Blob;
        response_hash : Blob;
    };

    // ---------------------------------------------------------------------
    // Persistent V3 model
    // ---------------------------------------------------------------------

    public type ExtentRef = {
        arena_offset : Nat64;
        allocated_capacity : Nat32;
    };

    // Exact reverse ownership for every non-null ContentDescriptor storage
    // slot. The arena index proves allocation; this index proves which one
    // content slot is allowed to read, write, and eventually free it.
    public type ContentExtentSlot = {
        #per_block : Nat32;
        #contiguous;
    };

    public type ContentExtentOwner = {
        content_id : Nat64;
        slot : ContentExtentSlot;
        extent : ExtentRef;
    };

    public type ContentOwnershipAuditPhase = {
        #owners : {
            next_offset : Nat64;
            scanned_owner_rows : Nat;
        };
        #contents : {
            next_content_id : Nat64;
            next_slot : Nat32;
            scanned_content_slots : Nat;
            scanned_owned_slots : Nat;
        };
    };

    public type ContentOwnershipAuditCursor = {
        snapshot_content_extent_mutation_epoch : Nat64;
        snapshot_allocator_mutation_epoch : Nat64;
        snapshot_owner_rows : Nat;
        snapshot_allocated_extents : Nat;
        snapshot_contents : Nat;
        phase : ContentOwnershipAuditPhase;
    };

    public type ContentOwnershipAuditPage = {
        valid : Bool;
        complete : Bool;
        scanned_nodes : Nat;
        next : ?ContentOwnershipAuditCursor;
    };

    public type CatalogAuditCursor = {
        snapshot_commit_sequence : Nat64;
        snapshot_commit_fingerprint : Blob;
        snapshot_scopes : Nat;
        snapshot_catalog_metadata_mutation_epoch : Nat64;
        scope_key : ?Text;
        mount_index : Nat;
        collection_index : Nat;
        seen_scopes : Nat;
        seen_mount_roots : Nat;
        seen_collection_roots : Nat;
    };

    public type CatalogAuditPage = {
        valid : Bool;
        complete : Bool;
        scanned_nodes : Nat;
        next : ?CatalogAuditCursor;
    };

    public type FreeExtent = {
        arena_offset : Nat64;
        capacity : Nat64;
    };

    public type ExtentSizeKey = {
        capacity : Nat64;
        arena_offset : Nat64;
    };

    public type ArenaMemory = {
        region : Region.Region;
        free_by_size : Map.Map<ExtentSizeKey, FreeExtent>;
        free_by_offset : Map.Map<Nat64, FreeExtent>;
        allocated_by_offset : Map.Map<Nat64, ExtentRef>;
        var committed_bytes : Nat64;
        var allocated_bytes : Nat64;
        var allocated_extents : Nat;
        var mutation_epoch : Nat64;
    };

    public type CollectionPlan = {
        id : Text;
        mount : Text;
        kind : CollectionKind;
        path_prefix : ?Text;
        exact_path : ?Text;
        max_object_bytes : Nat;
        authority_epoch : Nat64;
        generation : Nat64;
        serving : ServingState;
        writes : WriteState;
        fingerprint : Blob;
    };

    public type CommittedMount = {
        scope : AppScope;
        id : Text;
        prefix : Text;
        authority_mode : AuthorityMode;
        authority_epoch : Nat64;
        enabled : Bool;
        fingerprint : Blob;
        absence_leaf_keys : [CertificationLeafKey];
        detached_subtree : ?AuthenticatedForest.Detached;
    };

    public type ScopeState = {
        scope : AppScope;
        installation_generation : Nat64;
        store_authority_epoch : Nat64;
        manifest_limits : Limits;
        effective_limits : Limits;
        collections : [CollectionPlan];
        mounts : [CommittedMount];
        installed_charged_reservation : Nat;
        installed_arena_reservation : Nat;
        installed_arena_extent_reservation : Nat;
        reservation_active : Bool;
        committed : Bool;
        retiring : Bool;
    };

    public type ContentState = {
        #staged;
        #committed;
        #detached : { cursor : Nat32 };
    };

    public type StorageLayout = {
        #per_block_extents : [?ExtentRef];
        #contiguous : ?ExtentRef;
    };

    public type ContentBlock = {
        offset : Nat;
        length : Nat;
        sha256 : ?Blob;
    };

    public type ContentDescriptor = {
        content_id : Nat64;
        scope : AppScope;
        collection : Text;
        collection_generation : Nat64;
        state : ContentState;
        total_length : Nat;
        geometry : StageGeometry;
        storage : StorageLayout;
        blocks : [ContentBlock];
    };

    public type AssetRecord = {
        scope : AppScope;
        collection : Text;
        collection_generation : Nat64;
        canonical_key : Text;
        canonical_path : Text;
        target : Target;
        content_id : Nat64;
        kernel_revision : Nat64;
        // Exact SHA-256 of the committed body. It is also the HTTP digest/ETag.
        content_tag : Blob;
        body_bytes : Nat;
        geometry : StageGeometry;
        block_hashes : [Blob];
        presentation : ?PublicationPresentation;
        mount_id : Text;
        mount_fingerprint : Blob;
        collection_fingerprint : Blob;
        certification_leaf_keys : [CertificationLeafKey];
        charged_metadata_bytes : Nat;
    };

    public type StoredBlock = {
        sha256 : Blob;
    };

    // Frozen, serialization-safe SHA-256 continuation state. Ordered stages
    // persist this after every accepted block so an upgrade never
    // needs to reread already-written arena bytes.
    public type Sha256State = {
        h0 : Nat32;
        h1 : Nat32;
        h2 : Nat32;
        h3 : Nat32;
        h4 : Nat32;
        h5 : Nat32;
        h6 : Nat32;
        h7 : Nat32;
        total_bytes : Nat64;
        tail : Blob;
    };

    public type StageLifecycle = {
        #active;
        #consumed : {
            terminal : StageTerminal;
            lifecycle : LifecycleOutcome;
        };
        #aborted : StageTerminal;
        #expired : StageTerminal;
    };

    public type StageRecord = {
        scope : AppScope;
        store_authority_epoch : Nat64;
        mount_authority_epoch : Nat64;
        collection_authority_epoch : Nat64;
        nonce : Blob;
        begin_ok : BeginStageOk;
        stage_id : Nat64;
        identity : StageIdentity;
        geometry : StageGeometry;
        presentation : ?PublicationPresentation;
        content_id : Nat64;
        // Ordered accepted prefix. Its length is the only next-block cursor.
        accepted : [StoredBlock];
        incremental_sha256 : Sha256State;
        stage_metadata_charge : Nat;
        reserved_commit_metadata_charge : Nat;
        expires_at_ns : Nat64;
        lifecycle : StageLifecycle;
        future_batch_reserved : Bool;
        reserved_entry_slots : Nat;
        reserved_committed_body_bytes : Nat;
    };

    public type GeneralReceipt = {
        scope : AppScope;
        domain : { #begin_stage; #positive_batch };
        nonce : Blob;
        fingerprint : Blob;
        state : {
            #stage : Nat64;
            #batch : BatchReceipt;
        };
        expires_at_ns : ?Nat64;
    };

    public type DeleteReceiptLane = {
        reserved : Bool;
        filled : ?{
            nonce : Blob;
            fingerprint : Blob;
            deleted : DeletedIdentity;
            expires_at_ns : Nat64;
        };
    };

    public type RevisionHighWater = {
        target : Target;
        last_revision : Nat64;
        last_content_tag : Blob;
        deleted : DeletedIdentity;
    };

    public type RetiredForestMount = {
        mount_id : Text;
        detached : AuthenticatedForest.Detached;
    };

    public type ScopeRetirementCleanup = {
        scope : AppScope;
        mounts : [RetiredForestMount];
    };

    public type CleanupKind = {
        #content : Nat64;
        #scope_retirement : ScopeRetirementCleanup;
    };

    public type CleanupCursor = {
        #content : Nat32;
        #records : ?Text;
        #stages : ?Text;
        #general_receipts : ?Text;
        #delete_receipts : ?Text;
        #high_water : ?Text;
    };

    public type CleanupJob = {
        job_id : Nat64;
        scope : AppScope;
        kind : CleanupKind;
        cursor : CleanupCursor;
        created_at_ns : Nat64;
    };

    public type PublicationEntropyState = {
        #uninitialized;
        #ready : { salt : Blob; salt_fingerprint : Blob };
    };

    public type ExpiryKind = {
        #stage_idle : Nat64;
        #general_receipt : Text;
        #delete_receipt : Text;
    };
    public type ExpiryEntry = {
        scope : AppScope;
        expires_at_ns : Nat64;
        kind : ExpiryKind;
    };

    public type AuthenticatedForestMemory = AuthenticatedForest.Memory;

    public type Memory = {
        scopes : Map.Map<Text, ScopeState>;
        scopes_by_app : Map.Map<Text, AppScope>;
        mounts : Map.Map<Text, CommittedMount>;
        records : Map.Map<Text, AssetRecord>;
        route_index : Map.Map<Text, Text>;
        contents : Map.Map<Nat64, ContentDescriptor>;
        content_extent_owners : Map.Map<Nat64, ContentExtentOwner>;
        stages : Map.Map<Text, StageRecord>;
        general_receipts : Map.Map<Text, GeneralReceipt>;
        delete_nonce_index : Map.Map<Text, Text>;
        delete_receipt_lanes : Map.Map<Text, DeleteReceiptLane>;
        revision_high_water : Map.Map<Text, RevisionHighWater>;
        cleanup_jobs : Map.Map<Nat64, CleanupJob>;
        expiry_index : Map.Map<Text, ExpiryEntry>;
        cleanup_jobs_by_scope : Map.Map<Text, Nat64>;
        scope_retirement_job_by_scope : Map.Map<Text, Nat64>;
        usage_by_scope : Map.Map<Text, UsageCounters>;
        allocated_extents_by_scope : Map.Map<Text, Nat>;
        arena : ArenaMemory;
        authenticated_forest : AuthenticatedForestMemory;
        var publication_entropy : PublicationEntropyState;
        var next_publication_generation : Nat64;
        var next_stage_id : Nat64;
        var next_content_id : Nat64;
        var next_cleanup_job_id : Nat64;
        var next_authority_epoch : Nat64;
        var content_extent_mutation_epoch : Nat64;
        var catalog_metadata_mutation_epoch : Nat64;
        var total_installed_charged_reservation : Nat;
        var total_installed_arena_reservation : Nat;
        var total_installed_arena_extent_reservation : Nat;
        var global_reserved_charged_headroom : Nat;
        var global_reserved_arena_headroom : Nat;
        var global_reserved_arena_extent_headroom : Nat;
        var total_charged_bytes : Nat;
        var global_active_stages : Nat;
        var global_cleanup_jobs : Nat;
    };
};
