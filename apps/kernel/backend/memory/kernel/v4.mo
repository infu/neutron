// Persistent schema v4 baseline: keep this file immutable after release. Package imports
// are allowed; relative imports are forbidden so app-local types cannot drift.
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Queue "mo:core/Queue";
import Region "mo:core/Region";
import Set "mo:core/Set";
import Text "mo:core/Text";
import VarArray "mo:core/VarArray";
import CertTree "mo:ic-certification/CertTree";
import SHA256 "mo:sha2/Sha256";

module {
    public type AppScope = {
        app_id : Text;
        installation_uid : Nat64;
    };

    public type ResidentFrameSecurity = {
        #credentialless_opaque_v1;
        #credentialless_ephemeral_dedicated_v1;
        #persistent_dedicated_v1;
    };

    public type AppInstance = {
        scope : AppScope;
        version : Nat;
        deployment_id : Text;
        capability_plan_fingerprint : Text;
        resident_frame_security : ResidentFrameSecurity;
        browser_origin_nonce : Text;
        browser_origin_authority_epoch : Nat64;
    };

    public type Asset = {
        id : Text;
        chunks : Nat;
        content : [Blob];
        content_encoding : Text;
        content_type : Text;
    };

    public type AssetMemory = Map.Map<Text, Asset>;
    public type PrincipalSet = Set.Set<Principal>;
    public type CoreMemory = {
        assets : AssetMemory;
        authorized : PrincipalSet;
        cert : CertTree.Store;
    };

    public type FlowStatus = { #pending; #exchanging };
    public type OAuthFlow = {
        flow_id_hash : Blob;
        owner_principal : Principal;
        owner_scope : AppScope;
        provider : Text;
        declaration_scopes : [Text];
        pkce_verifier : Text;
        callback_url : Text;
        created_at : Nat64;
        expires_at : Nat64;
        status : FlowStatus;
    };
    public type Connection = {
        owner_scope : AppScope;
        provider : Text;
        declaration_scopes : [Text];
        credential : Text;
        created_at : Nat64;
    };
    public type ConnectionsMemory = {
        flows : Map.Map<Blob, OAuthFlow>;
        connections : Map.Map<Text, Connection>;
    };

    public type AssetCopy = { source : Text; target : Text };
    public type InstallJournal = {
        deployment_id : Text;
        allocation_start_uid : Nat64;
        copies : [AssetCopy];
        clear_prefixes : [Text];
        removed_apps : [Text];
        committed_app_instances : [AppInstance];
        target_app_instances : [AppInstance];
    };
    public type InstallMemory = {
        var browser_origin_epoch : ?Nat64;
        var next_installation_uid : Nat64;
        var committed_app_instances : [AppInstance];
        var pending : ?InstallJournal;
    };

    public type ReservationScope = {
        #exact : { principal : Principal; method : Text };
        #principal : Principal;
        #method : Text;
    };
    public type BackendCallReservation = {
        id : Nat;
        app_scope : AppScope;
        scope : ReservationScope;
        created_at : Nat64;
        created_by : Principal;
    };
    public type BackendCallsMemory = {
        var next_id : Nat;
        reservations : Map.Map<Nat, BackendCallReservation>;
    };

    public type CapabilityKind = {
        #backend_calls;
        #randomness;
        #https_outcalls;
        #chain_key_signing;
        #stable_store;
        #vetkeys;
        #scheduled_tasks;
        #connections;
        #persistent_browser_storage;
        #dedicated_resident_origin;
        #media_sessions;
        #http_routes;
        #certified_read_routes;
        #certified_assets;
        #public_ingress;
    };
    public type CapabilityGrantMode = {
        #declaration;
        #owner_runtime_grant;
    };
    public type CapabilityRegistration = {
        scope : AppScope;
        plan_fingerprint : Text;
        kind : CapabilityKind;
        resource_id : Text;
        api : Nat;
        declaration_fingerprint : Text;
        grant : CapabilityGrantMode;
        toggleable : Bool;
    };
    public type CapabilityOutcome = {
        #ok;
        #denied;
        #failed;
        #rate_limited;
        #busy;
        #revoked;
    };
    public type CapabilityUsage = {
        total : Nat64;
        succeeded : Nat64;
        denied : Nat64;
        failed : Nat64;
        rate_limited : Nat64;
        busy : Nat64;
        revoked : Nat64;
        last_at : ?Nat64;
        last_operation : ?Text;
        last_outcome : ?CapabilityOutcome;
    };
    public type CapabilityRegistryEntry = {
        registration : CapabilityRegistration;
        enabled : Bool;
        created_at : Nat64;
        created_by : Principal;
        updated_at : Nat64;
        updated_by : Principal;
        usage : CapabilityUsage;
    };
    public type CapabilityRegistryMemory = {
        entries : Map.Map<Text, CapabilityRegistryEntry>;
    };

    public type MediaFeature = { #camera; #microphone };
    public type MediaLeaseState = { #active; #revoked; #expired };
    public type MediaLease = {
        session_id : Text;
        scope : AppScope;
        app_version : Nat;
        plan_fingerprint : Text;
        request_id : Text;
        origin_nonce : Text;
        features : [MediaFeature];
        created_at : Nat64;
        expires_at : Nat64;
        authority_epoch : Nat64;
        state : MediaLeaseState;
    };
    public type MediaSessionsMemory = {
        var next_session_id : Nat64;
        var authority_epoch : Nat64;
        var active_session_id : ?Text;
        leases : Map.Map<Text, MediaLease>;
    };

    public type AppUsageDay = {
        day : Nat64;
        instructions : Nat64;
        executions : Nat64;
        incoming_cycles_accepted : Nat;
        outgoing_cycles_attached : Nat;
        outgoing_cycles_refunded : Nat;
        backend_cycles_attached : Nat;
        backend_cycles_refunded : Nat;
    };
    public type AppUsage = {
        scope : AppScope;
        days : Map.Map<Nat64, AppUsageDay>;
        var lifetime_instructions : Nat64;
        var lifetime_executions : Nat64;
        var lifetime_incoming_cycles_accepted : Nat;
        var lifetime_outgoing_cycles_attached : Nat;
        var lifetime_outgoing_cycles_refunded : Nat;
    };
    public type AppUsageMemory = {
        by_scope : Map.Map<Text, AppUsage>;
        var last_seen_at : Nat64;
        var next_outgoing_cycle_reservation_id : Nat;
    };

    public type ChainKeySlotState = {
        declaration_fingerprint : Text;
        identity_fingerprint : Text;
        cached_public_key : ?Blob;
    };
    public type ChainKeySigningMemory = {
        slots : Map.Map<Text, ChainKeySlotState>;
    };

    public type StableStoreUsageTotals = { entries : Nat; bytes : Nat };
    public type StableStoreEntry = {
        value : Blob;
        revision : Nat64;
        schema_version : Nat;
    };
    public type StableStoreState = {
        scope : AppScope;
        id : Text;
        namespace_uid : Nat64;
        var schema_version : Nat;
        var max_entries : Nat;
        var max_key_bytes : Nat;
        var max_value_bytes : Nat;
        var max_bytes : Nat;
        var entries : Map.Map<Blob, StableStoreEntry>;
        var bytes : Nat;
        var oversized_entries : Nat;
        var observed_revision : Nat64;
    };
    public type StableStoreMemory = {
        var next_namespace_uid : Nat64;
        var next_revision : Nat64;
        stores : Map.Map<Text, StableStoreState>;
        usage_by_scope : Map.Map<Text, StableStoreUsageTotals>;
        var total_entries : Nat;
        var total_bytes : Nat;
    };

    // Certified Assets state is embedded here rather than imported from the
    // app-local service module. Kernel memory V3 is a hard-cut fresh schema,
    // and these structural types must remain self-contained once released.
    public type AuthorityMode = {
        #exact_neutron_host_v1;
        #canister_gateway_v1;
    };
    public type CollectionKind = {
        #publication;
        #immutable_blob;
        #mutable_blob;
    };
    public type ServingState = { #enabled; #disabled };
    public type WriteState = { #enabled; #frozen };
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
    public type Color = { #red; #black };
    public type NodeId = Nat;
    public type MapId = Nat;
    public type MapRef = {
        id : MapId;
        generation : Nat64;
    };
    public type Value = {
        #leaf : Blob;
        #subtree : MapRef;
    };
    public type Node = {
        id : NodeId;
        var in_use : Bool;
        var map_id : MapId;
        var key : Blob;
        var key_hash : Blob;
        var value : Value;
        var value_hash : Blob;
        var data_hash : Blob;
        var color : Color;
        var left : NodeId;
        var right : NodeId;
        var subtree_hash : Blob;
        var free_next : NodeId;
    };
    public type MapRoot = {
        id : MapId;
        var in_use : Bool;
        var generation : Nat64;
        var root : NodeId;
        var size : Nat;
        var parent_map : MapRef;
        var parent_node : NodeId;
        var attached : Bool;
        var detach_epoch : Nat64;
        var detached_path_hash : Blob;
        var free_next : MapId;
    };
    public type ForestAuditPhase = {
        #node_slots;
        #node_free;
        #map_slots;
        #map_free;
        #deep_maps;
        #complete;
    };
    public type ForestAuditTreeState = {
        count : Nat;
        black_height : Nat;
        hash : Blob;
    };
    public type ForestAuditTreeStage = {
        #enter;
        #await_left;
        #await_right : ForestAuditTreeState;
    };
    public type ForestAuditTreeFrame = {
        node : NodeId;
        lower : ?Blob;
        upper : ?Blob;
        stage : ForestAuditTreeStage;
    };
    public type ForestAuditTreeCursor = {
        map : MapRef;
        expected_size : Nat;
        depth_bound : Nat;
        stack : [ForestAuditTreeFrame];
        value : ?ForestAuditTreeState;
        visited : Nat;
    };
    public type ForestAuditDeepState = {
        #idle;
        #ancestry : {
            target : MapRef;
            current : MapRef;
            depth : Nat;
        };
        #tree : ForestAuditTreeCursor;
    };
    public type ForestAuditCursor = {
        phase : ForestAuditPhase;
        next_slot : Nat;
        next_free : Nat;
        live_nodes_seen : Nat;
        free_nodes_seen : Nat;
        linked_free_nodes_seen : Nat;
        live_maps_seen : Nat;
        free_maps_seen : Nat;
        linked_free_maps_seen : Nat;
        commit_sequence : Nat64;
        commit_fingerprint : Blob;
        next_node_id : NodeId;
        next_map_id : MapId;
        free_node_head : NodeId;
        free_map_head : MapId;
        live_nodes : Nat;
        allocated_nodes : Nat;
        free_nodes : Nat;
        live_maps : Nat;
        allocated_maps : Nat;
        free_maps : Nat;
        deep_map_id : MapId;
        deep_nodes_seen : Nat;
        deep_state : ForestAuditDeepState;
    };
    public type NodeChunk = [var ?Node];
    public type MapChunk = [var ?MapRoot];
    public type Header = {
        schema_version : Nat32;
        forest_version : Nat32;
        response_root : MapRef;
        mount_catalog_root : MapRef;
        collection_catalog_root : MapRef;
        response_policy_table_canonical : Blob;
        response_policy_table_fingerprint : Blob;
        allocator_layout_fingerprint : Blob;
        var response_root_hash : Blob;
        var mount_catalog_root_hash : Blob;
        var collection_catalog_root_hash : Blob;
        var commit_sequence : Nat64;
        var commit_fingerprint : Blob;
        var live_nodes : Nat;
        var allocated_nodes : Nat;
        var free_nodes : Nat;
        var live_maps : Nat;
        var allocated_maps : Nat;
        var free_maps : Nat;
        var healthy : Bool;
    };
    public type OperationCounters = {
        var node_visits : Nat;
        var rotations : Nat;
        var nodes_allocated : Nat;
        var nodes_reused : Nat;
        var nodes_reclaimed : Nat;
        var maps_allocated : Nat;
        var maps_reused : Nat;
        var maps_reclaimed : Nat;
        var witness_nodes : Nat;
    };
    public type AuthenticatedForestMemory = {
        node_chunks : [var ?NodeChunk];
        map_chunks : [var ?MapChunk];
        var next_node_id : NodeId;
        var next_map_id : MapId;
        var free_node : NodeId;
        var free_map : MapId;
        var dirty : Bool;
        header : Header;
        counters : OperationCounters;
    };
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
    public type PublicationPresentation = { #inline_text; #attachment };
    public type StageGeometry = {
        block_bytes : Nat;
        block_count : Nat32;
        expected_bytes : Nat;
    };
    public type StageIdentity = {
        collection : Text;
        collection_generation : Nat64;
        computed_target : ?Target;
    };
    public type BeginStageOk = {
        stage_id : Nat64;
        identity : StageIdentity;
        geometry : StageGeometry;
        expires_at_ns : Nat64;
    };
    public type StageTerminal = {
        stage_id : Nat64;
        identity : StageIdentity;
        geometry : StageGeometry;
        terminal_at_ns : Nat64;
        reconcile_until_ns : Nat64;
    };
    public type RecordIdentity = {
        target : Target;
        kernel_revision : Nat64;
        content_tag : Blob;
        body_bytes : Nat;
        geometry : StageGeometry;
        block_hashes : [Blob];
    };
    public type DeletedIdentity = {
        target : Target;
        kernel_revision : Nat64;
        prior_content_tag : Blob;
    };
    public type LifecycleOutcome = {
        committed : RecordIdentity;
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
    public type BatchReceipt = { operations : [OperationReceipt] };
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
    public type ExtentRef = {
        arena_offset : Nat64;
        allocated_capacity : Nat32;
    };
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
        detached_subtree : ?{
            absolute_path : [Blob];
            absolute_path_hash : Blob;
            root : MapRef;
            detach_epoch : Nat64;
            root_hash : Blob;
            token_fingerprint : Blob;
        };
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
        detached : {
            absolute_path : [Blob];
            absolute_path_hash : Blob;
            root : MapRef;
            detach_epoch : Nat64;
            root_hash : Blob;
            token_fingerprint : Blob;
        };
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
    public type CertifiedAssetsMemory = {
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

    public type HttpRouteSurface = { #app_host; #shared_app_path };
    public type HttpPostUpdateHandlerRateCounter = {
        window_started_at : Nat64;
        accepted : Nat;
    };
    public type HttpPostUpdateHandlerMount = {
        scope : AppScope;
        id : Text;
        surface : HttpRouteSurface;
        prefix : Text;
        max_request_bytes : Nat;
        max_response_bytes : Nat;
        max_calls_per_hour : Nat;
        forward_headers : [Text];
        fingerprint : Text;
        authority_epoch : Nat64;
    };
    public type HttpPostUpdateHandlerStatus = {
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
    public type HttpPostUpdateHandlerResponse = {
        status : HttpPostUpdateHandlerStatus;
        content_type : Text;
        body : Blob;
    };
    public type HttpPostUpdateHandlerReplayState = {
        #pending;
        #completed : HttpPostUpdateHandlerResponse;
        #failed_unknown;
    };
    public type HttpPostUpdateHandlerReplay = {
        scope : AppScope;
        mount_id : Text;
        mount_fingerprint : Text;
        authority_epoch : Nat64;
        key_hash : Blob;
        request_hash : Blob;
        accepted_at : Nat64;
        reserved_response_bytes : Nat;
        state : HttpPostUpdateHandlerReplayState;
    };
    public type HttpPostUpdateHandlersMemory = {
        mounts : Map.Map<Text, HttpPostUpdateHandlerMount>;
        rates_by_mount : Map.Map<Text, HttpPostUpdateHandlerRateCounter>;
        rates_by_scope : Map.Map<Text, HttpPostUpdateHandlerRateCounter>;
        var global_rate : HttpPostUpdateHandlerRateCounter;
        replays : Map.Map<Blob, HttpPostUpdateHandlerReplay>;
        replay_entries_by_scope : Map.Map<Text, Nat>;
        replay_reserved_bytes_by_scope : Map.Map<Text, Nat>;
        pending_by_mount : Map.Map<Text, Nat>;
        pending_by_scope : Map.Map<Text, Nat>;
        replay_order : Queue.Queue<Blob>;
        var replay_reserved_bytes : Nat;
        var pending : Nat;
        var last_seen_at : Nat64;
    };

    public type PublicIngressRouteMode = { #query_; #update_ };
    public type PublicIngressCallerPolicy = {
        #any;
        #authenticated;
        #canister;
    };
    public type PublicIngressRoute = {
        scope : AppScope;
        protocol : Text;
        id : Text;
        handler : Text;
        mode : PublicIngressRouteMode;
        caller : PublicIngressCallerPolicy;
        max_request_bytes : Nat;
        max_response_bytes : Nat;
        max_calls_per_hour : ?Nat;
        required_cycles : ?Nat;
        fingerprint : Text;
        authority_epoch : Nat64;
    };
    public type PublicIngressRateCounter = {
        window_started_at : Nat64;
        accepted : Nat;
    };
    public type PublicIngressPendingState = {
        #waiting;
        #completed : Blob;
    };
    public type PublicIngressPendingDispatch = {
        dispatch_id : Nat64;
        scope : AppScope;
        protocol : Text;
        method : Text;
        request_hash : Blob;
        route_fingerprint : Text;
        authority_epoch : Nat64;
        accepted_at : Nat64;
        additional_cycles_available : Nat;
        additional_cycles_requested : Nat;
        state : PublicIngressPendingState;
    };
    public type PublicIngressMemory = {
        routes : Map.Map<Text, PublicIngressRoute>;
        rates_by_route : Map.Map<Text, PublicIngressRateCounter>;
        rates_by_scope : Map.Map<Text, PublicIngressRateCounter>;
        var global_rate : PublicIngressRateCounter;
        pending : Map.Map<Nat64, PublicIngressPendingDispatch>;
        pending_by_route : Map.Map<Text, Nat>;
        pending_by_scope : Map.Map<Text, Nat>;
        var pending_count : Nat;
        var next_dispatch_id : Nat64;
        var last_seen_at : Nat64;
    };

    public type VetKeySlotStatus = {
        #enabled;
        #disabled;
        #manifest_suspended;
    };
    public type VetKeyGenerationStatus = { #current; #previous };
    public type VetKeyRetirementReason = {
        #owner_retired;
        #app_uninstalled;
    };
    public type VetKeyGeneration = {
        generation : Nat64;
        status : VetKeyGenerationStatus;
        namespace_version : Nat;
        key_name : Text;
        cached_public_key : ?Blob;
        public_fingerprint : ?Blob;
        created_at : Nat64;
        created_by : Principal;
    };
    public type VetKeySlot = {
        slot_uid : Nat;
        scope : AppScope;
        slot_id : Text;
        namespace_nonce : Blob;
        key_holder : Principal;
        status : VetKeySlotStatus;
        current_generation : Nat64;
        next_generation : Nat64;
        generations : [VetKeyGeneration];
        created_at : Nat64;
        created_by : Principal;
        updated_at : Nat64;
        updated_by : Principal;
        last_used_at : ?Nat64;
        total_derivations : Nat;
        approximate_cycle_spend : Nat;
    };
    public type VetKeyRetiredTombstone = {
        slot_uid : Nat;
        retired_at : Nat64;
        retired_by : Principal;
        reason : VetKeyRetirementReason;
    };
    public type VetKeyAuditAction = {
        #reserve;
        #enable;
        #disable;
        #rotate;
        #retire_generation;
        #transfer;
        #retire_slot;
        #uninstall;
        #derive;
        #public_key;
        #manifest_suspend;
    };
    public type VetKeyAuditOutcome = {
        #ok;
        #denied;
        #busy;
        #low_cycles;
        #unavailable;
        #failed;
    };
    public type VetKeyAuditEntry = {
        at : Nat64;
        scope : AppScope;
        slot_uid : ?Nat;
        slot_id : Text;
        generation : ?Nat64;
        action : VetKeyAuditAction;
        principal : Principal;
        outcome : VetKeyAuditOutcome;
    };
    public type VetKeyMemoryV1 = {
        var next_slot_uid : Nat;
        slots_by_uid : Map.Map<Nat, VetKeySlot>;
        slot_index_by_scope_and_id : Map.Map<Text, Nat>;
        var retired_tombstones : [VetKeyRetiredTombstone];
        var audit : [VetKeyAuditEntry];
    };

    public type Mem = {
        core : CoreMemory;
        connections : ConnectionsMemory;
        install : InstallMemory;
        backend_calls : BackendCallsMemory;
        capability_registry : CapabilityRegistryMemory;
        media_sessions : MediaSessionsMemory;
        app_usage : AppUsageMemory;
        chain_key_signing : ChainKeySigningMemory;
        stable_store : StableStoreMemory;
        certified_assets : CertifiedAssetsMemory;
        http_post_update_handlers : HttpPostUpdateHandlersMemory;
        public_ingress : PublicIngressMemory;
        vetkeys : VetKeyMemoryV1;
    };

    let HOST_BOUND_CERTIFICATION_EXPRESSION =
        "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[\"host\"],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";
    let PORTABLE_CERTIFICATION_EXPRESSION =
        "default_certification(ValidationArgs{certification:Certification{request_certification:RequestCertification{certified_request_headers:[],certified_query_parameters:[]},response_certification:ResponseCertification{response_header_exclusions:ResponseHeaderList{headers:[]}}}})";
    let ALLOCATOR_LAYOUT_CANONICAL_V3 =
        "neutron.certified-assets.allocator-layout.v3\narena_page_bytes=65536\narena_growth_pages=32\narena_growth_quantum=2097152\narena_alignment=16\narena_split_min=256\narena_extent_capacity_max=2097152\narena_base_page=0\narena_capacity_max=2147483648\nmax_arena_extents=250000\nfragmentation_reserve=268435456\narena_allocatable_capacity_max=1879048192\nmax_allocation_transaction_extents=36\nmax_arena_audit_page_nodes=2048\narena_header_metadata_charge=528\narena_descriptor_metadata_charge=288\narena_metadata_reserve=72000528\nallocated_ownership_index=nat64_to_extent_ref_v1\nmutation_epoch=nat64_monotonic_every_grow_allocate_free_v1\nstage_extent_bytes_max=1900000\n";

    func responsePolicyTableCanonicalV1() : Text {
        "neutron.certified-http.response-policy-table.v1\n" #
        "publication_inline_text|host=exact|methods=GET:200_or_206,HEAD:200|cel=" #
        HOST_BOUND_CERTIFICATION_EXPRESSION #
        "|headers=Content-Type:text/plain; charset=utf-8,Cache-Control:no-store,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',Accept-Ranges:bytes,ETag:{content_tag_hex_quoted},Content-Length:{decimal},Content-Range:{optional_bytes_range},IC-CertificateExpression:{cel}\n" #
        "publication_attachment|host=exact|methods=GET:200_or_206,HEAD:200|cel=" #
        HOST_BOUND_CERTIFICATION_EXPRESSION #
        "|headers=Content-Type:application/octet-stream,Content-Disposition:attachment; filename=\"{escaped_filename}\",Cache-Control:no-store,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',Accept-Ranges:bytes,ETag:{content_tag_hex_quoted},Content-Length:{decimal},Content-Range:{optional_bytes_range},IC-CertificateExpression:{cel}\n" #
        "immutable_blob|host=excluded|methods=GET:200|cel=" #
        PORTABLE_CERTIFICATION_EXPRESSION #
        "|headers=Content-Type:application/octet-stream,Content-Length:{decimal},Content-Digest:sha-256=:{base64_sha256}:,ETag:{sha256_hex_quoted},Cache-Control:public, max-age=31536000, immutable,Access-Control-Allow-Origin:*,Access-Control-Expose-Headers:IC-Certificate, IC-CertificateExpression, Content-Length, Content-Digest, ETag,Cross-Origin-Resource-Policy:cross-origin,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',IC-CertificateExpression:{cel}\n" #
        "mutable_blob|host=excluded|methods=GET:200|cel=" #
        PORTABLE_CERTIFICATION_EXPRESSION #
        "|headers=Content-Type:application/octet-stream,Content-Length:{decimal},Content-Digest:sha-256=:{base64_sha256}:,ETag:{sha256_hex_quoted},Cache-Control:no-cache, must-revalidate,Access-Control-Allow-Origin:*,Access-Control-Expose-Headers:IC-Certificate, IC-CertificateExpression, Content-Length, Content-Digest, ETag,Cross-Origin-Resource-Policy:cross-origin,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',IC-CertificateExpression:{cel}\n" #
        "host_bound_not_found|host=exact|methods=GET:404,HEAD:404|cel=" #
        HOST_BOUND_CERTIFICATION_EXPRESSION #
        "|headers=Content-Type:text/plain; charset=utf-8,Content-Length:0,Cache-Control:no-store,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',IC-CertificateExpression:{cel}\n" #
        "portable_not_found|host=excluded|methods=GET:404|cel=" #
        PORTABLE_CERTIFICATION_EXPRESSION #
        "|headers=Content-Type:application/octet-stream,Content-Length:0,Cache-Control:no-store,Access-Control-Allow-Origin:*,Access-Control-Expose-Headers:IC-Certificate, IC-CertificateExpression, Content-Length,Cross-Origin-Resource-Policy:cross-origin,X-Content-Type-Options:nosniff,Referrer-Policy:no-referrer,Permissions-Policy:camera=(), geolocation=(), microphone=(),Content-Security-Policy:sandbox; default-src 'none'; frame-ancestors 'none',IC-CertificateExpression:{cel}\n";
    };

    // Kept public at the module level so the V3 schema lock test can validate
    // the frozen forest/policy/allocator fingerprints without constructing a
    // Region in moc's native interpreter. This is not part of the actor API.
    public func initAuthenticatedForest() : AuthenticatedForestMemory {
        let policyCanonical = Text.encodeUtf8(
            responsePolicyTableCanonicalV1(),
        );
        let policyFingerprint = SHA256.fromBlob(#sha256, policyCanonical);
        let allocatorFingerprint = SHA256.fromBlob(
            #sha256,
            Text.encodeUtf8(ALLOCATOR_LAYOUT_CANONICAL_V3),
        );
        let emptyHash = SHA256.fromBlob(
            #sha256,
            Text.encodeUtf8("\11ic-hashtree-empty"),
        );
        let zeroRef : MapRef = { id = 0; generation = 0 };
        let responseRef : MapRef = { id = 1; generation = 1 };
        let mountRef : MapRef = { id = 2; generation = 1 };
        let collectionRef : MapRef = { id = 3; generation = 1 };
        let nodeChunks = VarArray.repeat<?NodeChunk>(null, 65_536);
        let mapChunks = VarArray.repeat<?MapChunk>(null, 32_768);
        let firstMapChunk = VarArray.repeat<?MapRoot>(null, 128);
        func initialMap(id : Nat) : MapRoot {
            {
                id;
                var in_use = true;
                var generation = 1;
                var root = 0;
                var size = 0;
                var parent_map = zeroRef;
                var parent_node = 0;
                var attached = true;
                var detach_epoch = 0;
                var detached_path_hash = Blob.fromArray([]);
                var free_next = 0;
            };
        };
        firstMapChunk[0] := ?initialMap(1);
        firstMapChunk[1] := ?initialMap(2);
        firstMapChunk[2] := ?initialMap(3);
        mapChunks[0] := ?firstMapChunk;
        let commitFingerprint = initialForestCommitFingerprint(
            emptyHash,
            policyFingerprint,
            allocatorFingerprint,
        );
        {
            node_chunks = nodeChunks;
            map_chunks = mapChunks;
            var next_node_id = 1;
            var next_map_id = 4;
            var free_node = 0;
            var free_map = 0;
            var dirty = false;
            header = {
                schema_version = 3;
                forest_version = 1;
                response_root = responseRef;
                mount_catalog_root = mountRef;
                collection_catalog_root = collectionRef;
                response_policy_table_canonical = policyCanonical;
                response_policy_table_fingerprint = policyFingerprint;
                allocator_layout_fingerprint = allocatorFingerprint;
                var response_root_hash = emptyHash;
                var mount_catalog_root_hash = emptyHash;
                var collection_catalog_root_hash = emptyHash;
                var commit_sequence = 0;
                var commit_fingerprint = commitFingerprint;
                var live_nodes = 0;
                var allocated_nodes = 0;
                var free_nodes = 0;
                var live_maps = 3;
                var allocated_maps = 3;
                var free_maps = 0;
                var healthy = true;
            };
            counters = {
                var node_visits = 0;
                var rotations = 0;
                var nodes_allocated = 0;
                var nodes_reused = 0;
                var nodes_reclaimed = 0;
                var maps_allocated = 3;
                var maps_reused = 0;
                var maps_reclaimed = 0;
                var witness_nodes = 0;
            };
        };
    };

    func initialForestCommitFingerprint(
        emptyHash : Blob,
        policyFingerprint : Blob,
        allocatorFingerprint : Blob,
    ) : Blob {
        let digest = SHA256.Digest(#sha256);
        digest.writeBlob(
            Text.encodeUtf8("neutron.certified-forest.commit.v1\00"),
        );
        digest.writeBlob(u32be(3));
        digest.writeBlob(u32be(1));
        digest.writeBlob(emptyHash);
        digest.writeBlob(emptyHash);
        digest.writeBlob(emptyHash);
        digest.writeBlob(policyFingerprint);
        digest.writeBlob(allocatorFingerprint);
        digest.writeBlob(u64be(0));
        digest.writeBlob(u64be(0));
        digest.writeBlob(u64be(0));
        digest.writeBlob(u64be(0));
        digest.writeBlob(u64be(3));
        digest.writeBlob(u64be(3));
        digest.writeBlob(u64be(0));
        digest.sum();
    };

    func u32be(value : Nat32) : Blob {
        Blob.fromArray([
            Nat8.fromNat(Nat32.toNat(value >> 24)),
            Nat8.fromNat(Nat32.toNat((value >> 16) & 0xff)),
            Nat8.fromNat(Nat32.toNat((value >> 8) & 0xff)),
            Nat8.fromNat(Nat32.toNat(value & 0xff)),
        ]);
    };

    func u64be(value : Nat64) : Blob {
        Blob.fromArray([
            Nat8.fromNat(Nat64.toNat(value >> 56)),
            Nat8.fromNat(Nat64.toNat((value >> 48) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 40) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 32) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 24) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 16) & 0xff)),
            Nat8.fromNat(Nat64.toNat((value >> 8) & 0xff)),
            Nat8.fromNat(Nat64.toNat(value & 0xff)),
        ]);
    };

    public func init() : Mem {
        {
            core = {
                assets = Map.empty<Text, Asset>();
                authorized = Set.empty<Principal>();
                cert = CertTree.newStore();
            };
            connections = {
                flows = Map.empty<Blob, OAuthFlow>();
                connections = Map.empty<Text, Connection>();
            };
            install = {
                var browser_origin_epoch = null;
                var next_installation_uid = 1;
                var committed_app_instances = [];
                var pending = null;
            };
            backend_calls = {
                var next_id = 1;
                reservations = Map.empty<Nat, BackendCallReservation>();
            };
            capability_registry = {
                entries = Map.empty<Text, CapabilityRegistryEntry>();
            };
            media_sessions = {
                var next_session_id = 1;
                var authority_epoch = 1;
                var active_session_id = null;
                leases = Map.empty<Text, MediaLease>();
            };
            app_usage = {
                by_scope = Map.empty<Text, AppUsage>();
                var last_seen_at = 0;
                var next_outgoing_cycle_reservation_id = 1;
            };
            chain_key_signing = {
                slots = Map.empty<Text, ChainKeySlotState>();
            };
            stable_store = {
                var next_namespace_uid = 1;
                var next_revision = 1;
                stores = Map.empty<Text, StableStoreState>();
                usage_by_scope = Map.empty<Text, StableStoreUsageTotals>();
                var total_entries = 0;
                var total_bytes = 0;
            };
            certified_assets = {
                scopes = Map.empty<Text, ScopeState>();
                scopes_by_app = Map.empty<Text, AppScope>();
                mounts = Map.empty<Text, CommittedMount>();
                records = Map.empty<Text, AssetRecord>();
                route_index = Map.empty<Text, Text>();
                contents = Map.empty<Nat64, ContentDescriptor>();
                content_extent_owners =
                    Map.empty<Nat64, ContentExtentOwner>();
                stages = Map.empty<Text, StageRecord>();
                general_receipts = Map.empty<Text, GeneralReceipt>();
                delete_nonce_index = Map.empty<Text, Text>();
                delete_receipt_lanes = Map.empty<Text, DeleteReceiptLane>();
                revision_high_water = Map.empty<Text, RevisionHighWater>();
                cleanup_jobs = Map.empty<Nat64, CleanupJob>();
                expiry_index = Map.empty<Text, ExpiryEntry>();
                cleanup_jobs_by_scope = Map.empty<Text, Nat64>();
                scope_retirement_job_by_scope = Map.empty<Text, Nat64>();
                usage_by_scope = Map.empty<Text, UsageCounters>();
                allocated_extents_by_scope = Map.empty<Text, Nat>();
                arena = {
                    region = Region.new();
                    free_by_size = Map.empty<ExtentSizeKey, FreeExtent>();
                    free_by_offset = Map.empty<Nat64, FreeExtent>();
                    allocated_by_offset = Map.empty<Nat64, ExtentRef>();
                    var committed_bytes = 0;
                    var allocated_bytes = 0;
                    var allocated_extents = 0;
                    var mutation_epoch = 0;
                };
                authenticated_forest = initAuthenticatedForest();
                var publication_entropy = #uninitialized;
                var next_publication_generation = 1;
                var next_stage_id = 1;
                var next_content_id = 1;
                var next_cleanup_job_id = 1;
                var next_authority_epoch = 1;
                var content_extent_mutation_epoch = 0;
                var catalog_metadata_mutation_epoch = 0;
                var total_installed_charged_reservation = 0;
                var total_installed_arena_reservation = 0;
                var total_installed_arena_extent_reservation = 0;
                var global_reserved_charged_headroom = 0;
                var global_reserved_arena_headroom = 0;
                var global_reserved_arena_extent_headroom = 0;
                var total_charged_bytes = 0;
                var global_active_stages = 0;
                var global_cleanup_jobs = 0;
            };
            http_post_update_handlers = {
                mounts = Map.empty<Text, HttpPostUpdateHandlerMount>();
                rates_by_mount = Map.empty<Text, HttpPostUpdateHandlerRateCounter>();
                rates_by_scope = Map.empty<Text, HttpPostUpdateHandlerRateCounter>();
                var global_rate = { window_started_at = 0; accepted = 0 };
                replays = Map.empty<Blob, HttpPostUpdateHandlerReplay>();
                replay_entries_by_scope = Map.empty<Text, Nat>();
                replay_reserved_bytes_by_scope = Map.empty<Text, Nat>();
                pending_by_mount = Map.empty<Text, Nat>();
                pending_by_scope = Map.empty<Text, Nat>();
                replay_order = Queue.empty<Blob>();
                var replay_reserved_bytes = 0;
                var pending = 0;
                var last_seen_at = 0;
            };
            public_ingress = {
                routes = Map.empty<Text, PublicIngressRoute>();
                rates_by_route = Map.empty<Text, PublicIngressRateCounter>();
                rates_by_scope = Map.empty<Text, PublicIngressRateCounter>();
                var global_rate = { window_started_at = 0; accepted = 0 };
                pending = Map.empty<Nat64, PublicIngressPendingDispatch>();
                pending_by_route = Map.empty<Text, Nat>();
                pending_by_scope = Map.empty<Text, Nat>();
                var pending_count = 0;
                var next_dispatch_id = 1;
                var last_seen_at = 0;
            };
            vetkeys = {
                var next_slot_uid = 1;
                slots_by_uid = Map.empty<Nat, VetKeySlot>();
                slot_index_by_scope_and_id = Map.empty<Text, Nat>();
                var retired_tombstones = [];
                var audit = [];
            };
        };
    };
};
