import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import Cert "../certified_http";
import CertV2 "../certified_http_v2";
import GatewayAuthority "../http_routes/GatewayAuthority";
import RouteNamespace "../http_routes/Namespace";
import Allocator "Allocator";
import AuthenticatedForest "AuthenticatedForest";
import Codec "Codec";
import Paths "Paths";
import Types "Types";

module {
    public let API_VERSION : Nat = 2;
    public let PHYSICAL_RESERVATION_POLICY_V1 : Text =
        "neutron.certified-assets.physical-reservation.v1";
    // One bounded, ordered staging geometry is shared by every staged
    // collection kind. The width is the public client chunk width; the
    // allocator retains its separate physical extent ceiling.
    public let STAGE_BLOCK_BYTES : Nat =
        CertV2.PUBLICATION_BLOCK_BYTES_MAX_V2;
    public let MAX_STAGE_BLOCKS : Nat = 36;
    public let MAX_BATCH_OPERATIONS : Nat = 16;
    public let MAX_COLLECTIONS_PER_SCOPE : Nat = 16;
    public let MAX_ENTRIES_PER_SCOPE : Nat = 100_000;
    public let MAX_COMMITTED_BYTES_PER_SCOPE : Nat = 1_073_741_824;
    public let MAX_OBJECT_BYTES : Nat = 67_108_864;
    public let MAX_PENDING_STAGES_PER_SCOPE : Nat = 1;
    // A small actor-wide semaphore bounds simultaneously live staging
    // transactions independently of how many apps are installed. It is an
    // actual-use runtime bound, not an install-time reservation.
    public let MAX_GLOBAL_ACTIVE_STAGES : Nat = 4;
    public let MAX_GENERAL_RECEIPTS_PER_SCOPE : Nat = 4_096;
    public let MAX_CLEANUP_JOBS_PER_SCOPE : Nat = 16;
    // At most 256 app scopes may be installed and each scope admits at most
    // MAX_CLEANUP_JOBS_PER_SCOPE jobs. Active stages reserve a slot in this
    // same finite actor-wide queue before allocating content.
    public let MAX_GLOBAL_CLEANUP_JOBS : Nat = 4_096;
    // Charged bodies are bounded separately by the allocator arena. The
    // combined body-plus-metadata envelope gets another half-arena of
    // headroom; allocator descriptors retain their own explicit reserve. This
    // is a Core physical policy, not a fit to the bundled app suite.
    public let GLOBAL_CHARGED_HEADROOM_BYTES_V3 : Nat = 939_524_096;
    public let GLOBAL_CHARGED_BYTES_MAX_V3 : Nat = 2_890_572_816;
    public let STAGE_IDLE_NS : Nat64 = 3_600_000_000_000;
    public let RECONCILE_NS : Nat64 = 86_400_000_000_000;
    public let MAX_MAINTENANCE_EXTENTS : Nat = 16;
    public let MAX_MAINTENANCE_BODY_BYTES : Nat = 16_777_216;
    public let MAX_MAINTENANCE_RECEIPTS : Nat = 256;
    public let MAX_MAINTENANCE_RECORDS : Nat = 128;
    public let MAX_MAINTENANCE_AUTH_NODES : Nat = 2_048;
    public let MAX_FOREGROUND_EXTENTS : Nat = 1;
    public let MAX_FOREGROUND_RECEIPTS : Nat = 16;
    public let MAX_FOREGROUND_RECORDS : Nat = 128;
    public let MAX_FOREGROUND_AUTH_NODES : Nat = 256;
    public let MIN_REMAINING_CYCLES : Nat = 250_000_000_000;
    public let MAX_CONTENT_OWNERSHIP_AUDIT_PAGE_NODES : Nat = 2_048;
    public let MAX_CATALOG_AUDIT_PAGE_NODES : Nat = 2_048;

    let RECORD_METADATA_CHARGE : Nat = 1_024;
    let STAGE_METADATA_CHARGE : Nat = 2_048;
    let GENERAL_RECEIPT_CHARGE : Nat = 1_024;
    let DELETE_RECEIPT_LANE_CHARGE : Nat = 768;
    let HIGH_WATER_CHARGE : Nat = 512;
    let CLEANUP_JOB_CHARGE : Nat = 256;
    let STAGE_BLOCK_METADATA_CHARGE : Nat = 160;
    let STAGE_KEY_VALUE_BASE_CHARGE : Nat = 768;
    let RECORD_KEY_VALUE_BASE_CHARGE : Nat = 768;
    let ROUTE_INDEX_CHARGE : Nat = 256;
    let CERTIFICATION_LEAF_CHARGE : Nat = 320;
    let MAX_RECORD_DYNAMIC_CHARGE : Nat = 1_024;
    let MAX_LEAF_DYNAMIC_CHARGE : Nat = 768;
    let AUTH_NODE_CHARGE : Nat = 256;
    let FOREST_CATALOG_RESERVE_PER_MOUNT : Nat = 16_384;
    // The allocator rounds a request up by at most 15 bytes and may consume a
    // free tail smaller than its 256-byte split threshold (at most 255).
    let ARENA_EXTENT_WORST_CASE_OVERHEAD : Nat = 270;
    let NAT64_MAX : Nat64 = 18_446_744_073_709_551_615;

    func limitsNondecreasing(
        prior : Types.Limits,
        next : Types.Limits,
    ) : Bool {
        next.entries >= prior.entries and
        next.committed_bytes >= prior.committed_bytes and
        next.object_bytes >= prior.object_bytes and
        next.staged_bytes >= prior.staged_bytes and
        next.pending_stages >= prior.pending_stages and
        next.batch_operations >= prior.batch_operations and
        next.batch_bytes >= prior.batch_bytes and
        next.general_receipts >= prior.general_receipts and
        next.revocation_lanes >= prior.revocation_lanes;
    };

    func collectionCapacityCompatible(
        prior : [Types.CollectionPlan],
        next : [Types.CollectionPlan],
        requireFingerprint : Bool,
    ) : Bool {
        if (prior.size() != next.size()) return false;
        var index = 0;
        while (index < prior.size()) {
            let left = prior[index];
            let right = next[index];
            if (
                left.fingerprint.size() != 32 or
                right.fingerprint.size() != 32 or
                left.id != right.id or
                left.mount != right.mount or
                left.kind != right.kind or
                left.path_prefix != right.path_prefix or
                left.exact_path != right.exact_path or
                right.max_object_bytes < left.max_object_bytes or
                left.generation != right.generation or
                (
                    requireFingerprint and
                    left.fingerprint != right.fingerprint
                )
            ) return false;
            index += 1;
        };
        true;
    };

    func sameInstalledCollections(
        prior : [Types.CollectionPlan],
        next : [Types.CollectionPlan],
    ) : Bool {
        collectionCapacityCompatible(prior, next, true) and
        collectionCapacityCompatible(next, prior, true);
    };

    func targetRetainingCollectionFingerprints(
        prior : Types.ScopeState,
        target : Types.ScopeState,
    ) : ?Types.ScopeState {
        if (
            not collectionCapacityCompatible(
                prior.collections,
                target.collections,
                false,
            )
        ) return null;
        ?{
            target with
            collections = Array.tabulate<Types.CollectionPlan>(
                target.collections.size(),
                func(index) {
                    {
                        target.collections[index] with
                        fingerprint =
                            prior.collections[index].fingerprint;
                    };
                },
            );
        };
    };

    func sameMountSemantics(
        prior : [Types.CommittedMount],
        next : [Types.CommittedMount],
    ) : Bool {
        if (prior.size() != next.size()) return false;
        var index = 0;
        while (index < prior.size()) {
            let left = prior[index];
            let right = next[index];
            if (
                not CapabilityScope.equal(left.scope, right.scope) or
                left.id != right.id or
                left.prefix != right.prefix or
                left.authority_mode != right.authority_mode or
                left.fingerprint != right.fingerprint or
                left.absence_leaf_keys != right.absence_leaf_keys
            ) return false;
            index += 1;
        };
        true;
    };

    // An exact installed AppScope may retain durable records while a package
    // widens only its numeric admission ceilings. Runtime enablement, freeze,
    // and authority epochs are intentionally excluded: commit preserves the
    // installed values rather than resetting them from authored defaults.
    public func monotonicScopePlanWidening(
        prior : Types.ScopeState,
        next : Types.ScopeState,
    ) : Bool {
        prior.committed and not prior.retiring and
        prior.reservation_active and next.reservation_active and
        CapabilityScope.equal(prior.scope, next.scope) and
        prior.installation_generation == next.installation_generation and
        (
            prior.manifest_limits != next.manifest_limits or
            prior.installed_charged_reservation !=
                next.installed_charged_reservation or
            prior.installed_arena_reservation !=
                next.installed_arena_reservation or
            prior.installed_arena_extent_reservation !=
                next.installed_arena_extent_reservation or
            not sameInstalledCollections(
                prior.collections,
                next.collections,
            )
        ) and
        limitsNondecreasing(prior.manifest_limits, next.manifest_limits) and
        limitsNondecreasing(prior.effective_limits, next.effective_limits) and
        next.installed_charged_reservation >=
            prior.installed_charged_reservation and
        next.installed_arena_reservation >=
            prior.installed_arena_reservation and
        next.installed_arena_extent_reservation >=
            prior.installed_arena_extent_reservation and
        collectionCapacityCompatible(
            prior.collections,
            next.collections,
            true,
        ) and
        sameMountSemantics(prior.mounts, next.mounts);
    };

    type PreparedPut = {
        request_index : Nat32;
        target_key : Text;
        collection : Types.CollectionPlan;
        mount : Types.CommittedMount;
        target : Types.Target;
        prior : ?Types.AssetRecord;
        revision : Nat64;
        content_id : Nat64;
        body_bytes : Nat;
        geometry : Types.StageGeometry;
        block_hashes : [Blob];
        content_tag : Blob;
        presentation : ?Types.PublicationPresentation;
        body : Types.BodySource;
        stage : ?Types.StageRecord;
    };

    type PreparedBody = (
        Nat,
        Types.StageGeometry,
        [Blob],
        Blob,
        Nat64,
        ?Types.StageRecord,
    );
    type PrepareBodyResult = { #ok : PreparedBody; #err : Types.Error };

    type ContentCleanupSlice = {
        next : Types.ContentDescriptor;
        complete : Bool;
        extents : Nat;
        logical_bytes : Nat;
        charged_bytes : Nat;
    };

    public type Certification = {
        beginV2PublicationBatch : () -> ();
        finishV2PublicationBatch : () -> Bool;
        applyV2 : [Cert.V2Mutation] -> Bool;
        retireV2 : [Cert.RetireMountV2] -> [Cert.DetachedV2];
        detachV2 : (Text, [Cert.OwnerResponses]) -> Cert.DetachedV2;
        attachV2 : (Cert.DetachedV2, [Cert.OwnerResponses]) -> Bool;
        applyDetachedV2 : (
            Cert.DetachedV2,
            [Cert.V2Mutation],
        ) -> (Cert.DetachedV2, Bool);
        discardDetachedV2 : Cert.DetachedV2 -> Bool;
        syncV2MountCatalog : (Text, Text, ?Cert.DetachedV2) -> ();
        syncV2CollectionCatalog : (
            Text,
            Text,
            Bool,
            ?Cert.DetachedV2,
        ) -> ();
        v2MountCatalogMatches : (
            Text,
            Text,
            ?Cert.DetachedV2,
        ) -> Cert.V2CatalogMatch;
        v2CollectionCatalogMatches : (
            Text,
            Text,
            Bool,
            ?Cert.DetachedV2,
        ) -> Cert.V2CatalogMatch;
        v2CatalogSnapshot : () -> ?Cert.V2CatalogSnapshot;
        removeV2MountCatalog : Text -> ();
        removeV2CollectionCatalog : Text -> ();
    };

    public func initMemory() : Types.Memory {
        {
            scopes = Map.empty<Text, Types.ScopeState>();
            scopes_by_app = Map.empty<Text, Types.AppScope>();
            mounts = Map.empty<Text, Types.CommittedMount>();
            records = Map.empty<Text, Types.AssetRecord>();
            route_index = Map.empty<Text, Text>();
            contents = Map.empty<Nat64, Types.ContentDescriptor>();
            content_extent_owners =
                Map.empty<Nat64, Types.ContentExtentOwner>();
            stages = Map.empty<Text, Types.StageRecord>();
            general_receipts = Map.empty<Text, Types.GeneralReceipt>();
            delete_nonce_index = Map.empty<Text, Text>();
            delete_receipt_lanes = Map.empty<Text, Types.DeleteReceiptLane>();
            revision_high_water = Map.empty<Text, Types.RevisionHighWater>();
            cleanup_jobs = Map.empty<Nat64, Types.CleanupJob>();
            expiry_index = Map.empty<Text, Types.ExpiryEntry>();
            cleanup_jobs_by_scope = Map.empty<Text, Nat64>();
            scope_retirement_job_by_scope = Map.empty<Text, Nat64>();
            usage_by_scope = Map.empty<Text, Types.UsageCounters>();
            allocated_extents_by_scope = Map.empty<Text, Nat>();
            arena = Allocator.init();
            authenticated_forest = AuthenticatedForest.init(
                Text.encodeUtf8(
                    CertV2.responsePolicyTableCanonicalV1()
                ),
                Allocator.layoutFingerprint(),
            );
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
    };

    public class Service(
        mem : Types.Memory,
        cert : Certification,
        canisterId : Text,
        scopeActive : Types.AppScope -> Bool,
        deploymentCommitted : () -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        cycleBalance : () -> Nat,
        clockNs : () -> Nat64,
    ) {
        assert (
            GLOBAL_CHARGED_HEADROOM_BYTES_V3 * 2 ==
                Nat64.toNat(Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3) and
            GLOBAL_CHARGED_BYTES_MAX_V3 ==
                Nat64.toNat(
                    Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3
                ) + Allocator.ARENA_METADATA_RESERVE_V3 +
                GLOBAL_CHARGED_HEADROOM_BYTES_V3
        );
        let targets = Map.empty<Text, Types.ScopeState>();
        let scopesByApp = mem.scopes_by_app;
        var configured = false;

        // -----------------------------------------------------------------
        // Configuration and activation
        // -----------------------------------------------------------------

        public func configure(declarations : [Types.AppDeclaration]) : () {
            assert (not configured);
            var priorScope : ?Text = null;
            for (declaration in declarations.vals()) {
                assert (CapabilityScope.valid(declaration.app_scope));
                let scopeKey = CapabilityScope.key(declaration.app_scope);
                switch (priorScope) {
                    case (?prior) assert (Text.compare(prior, scopeKey) == #less);
                    case null {};
                };
                priorScope := ?scopeKey;
                let derived = deriveScope(declaration);
                switch (derived) {
                    case null {
                        assert (declaration.certified_assets == null);
                    };
                    case (?scope) {
                        assert (Map.get(targets, Text.compare, scopeKey) == null);
                        let target = switch (
                            Map.get(mem.scopes, Text.compare, scopeKey)
                        ) {
                            case null {
                                installProvisional(scope);
                                scope;
                            };
                            case (?existing) {
                                let ?normalized =
                                    targetRetainingCollectionFingerprints(
                                        existing,
                                        scope,
                                    ) else {
                                        Runtime.trap(
                                            "Certified-assets installed collection semantics changed"
                                        );
                                    };
                                assert (
                                    scopePlanEqual(existing, normalized) or
                                    monotonicScopePlanWidening(
                                        existing,
                                        normalized,
                                    )
                                );
                                normalized;
                            };
                        };
                        Map.add(targets, Text.compare, scopeKey, target);
                        Map.add(
                            scopesByApp,
                            Text.compare,
                            target.scope.app_id,
                            target.scope,
                        );
                    };
                };
            };
            configured := true;
            // Declaration and stable-state admission must finish while the
            // management install can still fail back to the predecessor actor.
            // Recheck again at install commit because authorized maintenance may
            // have changed cleanup/resource counters after activation.
            assert (configurationCommitReady());
        };

        public func commitConfiguration() : () {
            assert (configured and deploymentCommitted());
            assert (configurationCommitReady());
            cert.beginV2PublicationBatch();
            let mutations = List.empty<Cert.V2Mutation>();

            // This is a hard-cut schema. Removed installation scopes are
            // detached first and their bodies become bounded cleanup jobs.
            let retired = List.empty<Types.AppScope>();
            for ((scopeKey, current) in Map.entries(mem.scopes)) {
                if (
                    not current.retiring and
                    Map.get(targets, Text.compare, scopeKey) == null
                ) {
                    List.add(retired, current.scope);
                };
            };
            for (scope in List.values(retired)) {
                assert (retireScopeState(scope));
            };
            // Retiring scopes release their logical quotas and convert their
            // unused reservations before same-scope widening is projected.
            assert (configurationCommitReady());

            for ((scopeKey, target) in Map.entries(targets)) {
                let ?current = Map.get(mem.scopes, Text.compare, scopeKey) else {
                    Runtime.trap("Certified-assets provisional scope missing");
                };
                let next = if (scopePlanEqual(current, target)) {
                    current;
                } else {
                    assert (monotonicScopePlanWidening(current, target));
                    applyScopePlanWidening(current, target);
                };
                assert (scopePlanEqual(next, target));
                let wasCommitted = next.committed;
                let committed = { next with committed = true; retiring = false };
                Map.add(mem.scopes, Text.compare, scopeKey, committed);
                if (not wasCommitted) {
                    for (mount in committed.mounts.vals()) {
                        appendAbsenceMutations(mount, mutations);
                    };
                    // A provisional scope contains no objects, so activation
                    // never scans a live high-entry-count installation.
                    for (record in recordsForScope(committed.scope).vals()) {
                        let ?mount = mountFor(committed, record.mount_id) else {
                            Runtime.trap("Certified-assets record mount missing");
                        };
                        let ?collection = collectionFor(committed, record.collection) else {
                            Runtime.trap("Certified-assets record collection missing");
                        };
                        if (
                            mount.enabled and collection.serving == #enabled and
                            registry.allowed(committed.scope, #certified_read_routes, mount.id)
                        ) {
                            List.add(
                                mutations,
                                replaceRecordMutation(
                                    null,
                                    record,
                                    mount,
                                    collection,
                                ),
                            );
                        };
                    };
                };
            };
            if (List.size(mutations) > 0) {
                ignore cert.applyV2(List.toArray(mutations));
            };
            for ((scopeKey, _) in Map.entries(targets)) {
                let ?committed = Map.get(
                    mem.scopes,
                    Text.compare,
                    scopeKey,
                ) else {
                    Runtime.trap(
                        "Certified-assets catalog scope disappeared"
                    );
                };
                syncScopeCatalogs(committed);
            };
            ignore cert.finishV2PublicationBatch();
        };

        public func syncRuntimeState() : () {
            assert (configured and deploymentCommitted());
            let changes = List.empty<(Types.AppScope, Text, Bool)>();
            for (mount in Map.values(mem.mounts)) {
                let shouldEnable = registry.allowed(mount.scope, #certified_read_routes, mount.id);
                if (mount.enabled != shouldEnable) {
                    List.add(changes, (mount.scope, mount.id, shouldEnable));
                };
            };
            if (List.size(changes) == 0) return;
            cert.beginV2PublicationBatch();
            for ((scope, mountId, enabled) in List.values(changes)) {
                toggleMount(scope, mountId, enabled);
            };
            ignore cert.finishV2PublicationBatch();
        };

        // -----------------------------------------------------------------
        // Captured app capability
        // -----------------------------------------------------------------

        public func capability(scope : Types.AppScope) : Types.CertifiedAssetsV2 {
            {
                scope_info = func() { scopeInfo(scope) };
                begin_stage = func(input) { beginStage(scope, input) };
                put_chunk = func(input) { putChunk(scope, input) };
                stage_status = func(stageId) { stageStatus(scope, stageId) };
                abort_stage = func(stageId) { abortStage(scope, stageId) };
                commit_batch = func(input) { commitBatch(scope, input) };
                record_status = func(target) { recordStatus(scope, target) };
                maintenance_page = func() { maintenancePage(scope) };
                usage = func() { usage(scope) };
            };
        };

        public func scopeInfo(scope : Types.AppScope) : Types.ScopeInfoResult {
            let ?state = currentScope(scope) else return #err(#stale_scope);
            #ok(scopeInfoValue(state));
        };

        public func usage(scope : Types.AppScope) : Types.UsageResult {
            let ?state = currentScope(scope) else return #err(#stale_scope);
            #ok({
                current = usageFor(scope);
                manifest_limits = state.manifest_limits;
                effective_limits = state.effective_limits;
            });
        };

        public func diagnostics() : Types.Diagnostics {
            let allocator = Allocator.diagnostics(mem.arena);
            let envelopeUsed =
                mem.total_charged_bytes +
                mem.global_reserved_charged_headroom +
                Allocator.ARENA_METADATA_RESERVE_V3;
            let arenaEnvelopeUsed =
                Nat64.toNat(mem.arena.allocated_bytes) +
                mem.global_reserved_arena_headroom;
            let arenaExtentEnvelopeUsed =
                mem.arena.allocated_extents +
                mem.global_reserved_arena_extent_headroom;
            {
                implementation_binding = {
                    allocator_layout_fingerprint =
                        mem.authenticated_forest.header.allocator_layout_fingerprint;
                    response_policy_fingerprint =
                        CertV2.responsePolicyTableFingerprint();
                };
                allocator;
                authenticated_forest =
                    AuthenticatedForest.diagnostics(
                        mem.authenticated_forest
                    );
                charging = {
                    total_charged_bytes = mem.total_charged_bytes;
                    total_installed_reservation_bytes =
                        mem.total_installed_charged_reservation;
                    reserved_headroom_bytes =
                        mem.global_reserved_charged_headroom;
                    allocator_metadata_charge_bytes =
                        allocator.metadata_charge_bytes;
                    envelope_used_bytes = envelopeUsed;
                    envelope_limit_bytes = GLOBAL_CHARGED_BYTES_MAX_V3;
                    total_installed_arena_reservation_bytes =
                        mem.total_installed_arena_reservation;
                    reserved_arena_headroom_bytes =
                        mem.global_reserved_arena_headroom;
                    arena_envelope_used_bytes = arenaEnvelopeUsed;
                    arena_envelope_limit_bytes =
                        Nat64.toNat(
                            Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3
                        );
                    total_installed_arena_extent_reservation =
                        mem.total_installed_arena_extent_reservation;
                    reserved_arena_extent_headroom =
                        mem.global_reserved_arena_extent_headroom;
                    arena_extent_envelope_used =
                        arenaExtentEnvelopeUsed;
                    arena_extent_envelope_limit =
                        (Allocator.MAX_ARENA_EXTENTS_V3 - 1) / 2;
                };
            };
        };

        // Explicit integrity work only. It is never called from actor
        // construction, post-upgrade, HTTP resolution, or an ordinary asset
        // mutation. The cursor snapshots both ownership and allocator epochs,
        // so same-cardinality churn forces a restart instead of evading a
        // multi-page audit.
        public func auditContentOwnershipPage(
            cursor : ?Types.ContentOwnershipAuditCursor,
            maxNodes : Nat,
        ) : Types.ContentOwnershipAuditPage {
            contentOwnershipAuditPage(cursor, maxNodes);
        };

        // Bounded Settings-only cross-audit. The response forest remains the
        // serving authority; this proves the auxiliary named catalogs exactly
        // mirror every current or retiring scope and contain no extra rows.
        public func auditCatalogPage(
            cursor : ?Types.CatalogAuditCursor,
            maxNodes : Nat,
        ) : Types.CatalogAuditPage {
            catalogAuditPage(cursor, maxNodes);
        };

        public func beginStage(
            scope : Types.AppScope,
            input : Types.BeginStageInput,
        ) : Types.BeginStageResult {
            if (not validBeginStageShape(input)) return #err(#invalid);
            let targetParts = switch (input.target) {
                case (#allocate_publication(value)) (
                    value.collection,
                    value.collection_generation,
                );
                case (#derive_body_sha256(value)) (
                    value.collection,
                    value.collection_generation,
                );
            };
            let (collectionId, collectionGeneration) = targetParts;

            let ?state = currentScope(scope) else return #err(#stale_scope);
            let ?collection = collectionFor(state, collectionId) else {
                return #err(#invalid);
            };
            let ?geometry = validateStageInput(collection, input) else {
                return finish(scope, "begin_stage", #err(#invalid));
            };
            if (collectionGeneration != collection.generation) {
                return #err(#stale_generation({ current = collection.generation }));
            };
            ignore runForegroundMaintenance(scope);
            // Fingerprint encoding contains fixed-width integers, so it is
            // reached only after every caller-controlled Nat/length vector is
            // structurally bounded.
            let fingerprint = Codec.beginFingerprint(input);
            let replayKey = generalReceiptKey(scope, #begin_stage, input.nonce);
            expireAddressedGeneralReceiptIfDue(scope, replayKey);
            switch (Map.get(mem.general_receipts, Text.compare, replayKey)) {
                case (?receipt) {
                    if (receipt.fingerprint != fingerprint) {
                        return #err(#conflict({ current = null }));
                    };
                    let #stage(stageId) = receipt.state else {
                        return #err(#conflict({ current = null }));
                    };
                    let ?stage = Map.get(
                        mem.stages,
                        Text.compare,
                        stageKey(scope, stageId),
                    ) else return #err(#not_found);
                    let ?replayCollection = collectionFor(
                        state,
                        stage.identity.collection,
                    ) else return #err(#stale_scope);
                    let ?replayMount = mountFor(
                        state,
                        replayCollection.mount,
                    ) else return #err(#stale_scope);
                    if (
                        not stageAuthorityCurrent(
                            state,
                            replayCollection,
                            replayMount,
                            stage,
                        )
                    ) return #err(#stale_scope);
                    return #ok(stage.begin_ok);
                };
                case null {};
            };

            let ?mount = mountFor(state, collection.mount) else return #err(#invalid);
            if (
                not mount.enabled or collection.serving == #disabled or
                not registry.allowed(scope, #certified_read_routes, mount.id) or
                not registry.allowed(scope, #certified_assets, "default")
            ) return finish(scope, "begin_stage", #err(#disabled));
            if (collection.writes == #frozen) {
                return finish(scope, "begin_stage", #err(#frozen));
            };

            if (mem.next_stage_id == NAT64_MAX or mem.next_content_id == NAT64_MAX) {
                return finish(scope, "begin_stage", #err(#generation_exhausted));
            };
            var publicationGeneration : ?Nat64 = null;
            var computedTarget : ?Types.Target = null;
            switch (input.target) {
                case (#allocate_publication(value)) {
                    let salt = switch (mem.publication_entropy) {
                        case (#ready(value)) value.salt;
                        case (_) {
                            return finish(
                                scope,
                                "begin_stage",
                                #err(#not_ready),
                            );
                        };
                    };
                    if (mem.next_publication_generation == NAT64_MAX) {
                        return finish(
                            scope,
                            "begin_stage",
                            #err(#generation_exhausted),
                        );
                    };
                    let generation = mem.next_publication_generation;
                    let ?publicationId = Paths.publicationId(
                        salt,
                        canisterId,
                        scope,
                        collection.id,
                        collection.generation,
                        generation,
                        input.nonce,
                    ) else {
                        return finish(scope, "begin_stage", #err(#invalid));
                    };
                    publicationGeneration := ?generation;
                    computedTarget := ?{
                        collection = collection.id;
                        collection_generation = collection.generation;
                        locator = #publication({
                            publication_id = publicationId;
                            filename = value.filename;
                        });
                    };
                };
                case (#derive_body_sha256(_)) {};
            };

            let usage = usageFor(scope);
            if (
                usage.active_stages + 1 > state.effective_limits.pending_stages or
                globalActiveStages() + 1 > MAX_GLOBAL_ACTIVE_STAGES or
                input.expected_bytes > state.effective_limits.staged_bytes or
                usage.accepted_staged_bytes + usage.reserved_staged_bytes +
                input.expected_bytes > state.effective_limits.staged_bytes or
                usage.occupied_entry_slots + usage.reserved_entry_slots + 1 >
                    state.effective_limits.entries or
                usage.committed_body_bytes +
                    usage.reserved_committed_body_bytes +
                    input.expected_bytes >
                    state.effective_limits.committed_bytes or
                not cleanupCapacityAvailable(scope, 0, 1)
            ) return finish(scope, "begin_stage", #err(#quota));
            let stageCharge = stageMetadataCharge(scope, collection, geometry);
            let commitReserve = reservedCommitMetadataCharge(
                mount,
                collection,
                geometry,
            );
            var nonemptyExtents = 0;
            for (length in geometryLengths(geometry).vals()) {
                if (length > 0) nonemptyExtents += 1;
            };
            if (not globalChargedAdmission(
                scope,
                geometryWorstBodyCharge(geometry),
                stageCharge + commitReserve,
                nonemptyExtents,
            )) return finish(scope, "begin_stage", #err(#quota));
            if (
                not Allocator.canAllocateMany(
                    mem.arena,
                    stageAllocationSizes(geometry),
                )
            ) return finish(scope, "begin_stage", #err(#quota));
            if (
                usage.general_receipt_lanes +
                usage.reserved_general_receipt_lanes + 2 >
                state.effective_limits.general_receipts
            ) return finish(scope, "begin_stage", #err(#receipt_full));
            if (cycleBalance() < MIN_REMAINING_CYCLES) {
                return finish(scope, "begin_stage", #err(#low_cycles));
            };

            let contentId = mem.next_content_id;
            let stageId = mem.next_stage_id;
            let allocation = allocateStageContent(
                scope,
                collection,
                contentId,
                geometry,
            );
            let ?content = allocation else {
                Runtime.trap(
                    "Certified-assets stage allocation diverged from preflight"
                );
            };

            let now = nowNs();
            let expiresAt = checkedTimeAdd(now, STAGE_IDLE_NS);
            let identity : Types.StageIdentity = {
                collection = collection.id;
                collection_generation = collection.generation;
                computed_target = computedTarget;
            };
            let beginOk : Types.BeginStageOk = {
                stage_id = stageId;
                identity;
                geometry;
                expires_at_ns = expiresAt;
            };
            let stage : Types.StageRecord = {
                scope;
                store_authority_epoch = state.store_authority_epoch;
                mount_authority_epoch = mount.authority_epoch;
                collection_authority_epoch = collection.authority_epoch;
                nonce = input.nonce;
                begin_ok = beginOk;
                stage_id = stageId;
                identity;
                geometry;
                presentation = switch (input.target) {
                    case (#allocate_publication(value)) ?value.presentation;
                    case (#derive_body_sha256(_)) null;
                };
                content_id = contentId;
                accepted = [];
                incremental_sha256 = Codec.sha256Init();
                stage_metadata_charge = stageCharge;
                reserved_commit_metadata_charge = commitReserve;
                expires_at_ns = expiresAt;
                lifecycle = #active;
                future_batch_reserved = true;
                reserved_entry_slots = 1;
                reserved_committed_body_bytes = input.expected_bytes;
            };

            mem.next_stage_id += 1;
            mem.next_content_id += 1;
            switch (publicationGeneration) {
                case (?_) mem.next_publication_generation += 1;
                case null {};
            };
            putContentDescriptor(content);
            setAllocatedExtentsForScope(
                scope,
                allocatedExtentsForScope(scope) +
                    contentAllocatedExtents(content),
            );
            Map.add(mem.stages, Text.compare, stageKey(scope, stageId), stage);
            Map.add(mem.general_receipts, Text.compare, replayKey, {
                scope;
                domain = #begin_stage;
                nonce = input.nonce;
                fingerprint;
                state = #stage(stageId);
                expires_at_ns = null;
            });
            addStageIdleExpiry(stage);
            setUsage(scope, {
                usage with
                allocated_body_bytes = usage.allocated_body_bytes +
                    contentAllocatedBytes(content);
                reserved_staged_bytes = usage.reserved_staged_bytes +
                    input.expected_bytes;
                reserved_entry_slots = usage.reserved_entry_slots + 1;
                reserved_committed_body_bytes =
                    usage.reserved_committed_body_bytes + input.expected_bytes;
                active_stages = usage.active_stages + 1;
                receipt_lanes = usage.receipt_lanes + 2;
                general_receipt_lanes = usage.general_receipt_lanes + 1;
                reserved_general_receipt_lanes =
                    usage.reserved_general_receipt_lanes + 1;
                receipt_nonce_indexes = usage.receipt_nonce_indexes + 1;
                charged_metadata_bytes = usage.charged_metadata_bytes +
                    stageCharge + commitReserve;
            });
            finish(scope, "begin_stage", #ok(beginOk));
        };

        public func putChunk(
            scope : Types.AppScope,
            input : Types.PutChunkInput,
        ) : Types.ChunkResult {
            let ?state = currentScope(scope) else return #err(#stale_scope);
            let key = stageKey(scope, input.stage_id);
            let ?initialStage = Map.get(mem.stages, Text.compare, key) else {
                return finish(scope, "put_chunk", #err(#not_found));
            };
            let ?collection = collectionFor(state, initialStage.identity.collection) else {
                return #err(#invalid);
            };
            if (initialStage.identity.collection_generation != collection.generation) {
                return #err(#stale_generation({ current = collection.generation }));
            };
            let ?stageMount = mountFor(state, collection.mount) else return #err(#invalid);
            if (not stageAuthorityCurrent(state, collection, stageMount, initialStage)) {
                return #err(#stale_scope);
            };
            let index = Nat32.toNat(input.index);
            if (
                index >= geometryBlockCount(initialStage.geometry) or
                input.body.size() != geometryBlockLength(initialStage.geometry, index)
            ) return finish(scope, "put_chunk", #err(#invalid));

            ignore runForegroundMaintenance(scope);
            let ?maintainedStage = Map.get(mem.stages, Text.compare, key) else {
                return finish(scope, "put_chunk", #err(#not_found));
            };
            let now = nowNs();
            let stage = if (
                maintainedStage.lifecycle == #active and
                deadlineReached(now, maintainedStage.expires_at_ns)
            ) {
                expireStage(maintainedStage);
            } else maintainedStage;

            switch (stage.lifecycle) {
                case (#aborted(_)) return finish(scope, "put_chunk", #err(#aborted));
                case (#expired(_)) return finish(scope, "put_chunk", #err(#expired));
                case (#consumed(_)) {
                    if (index >= stage.accepted.size()) {
                        return finish(
                            scope,
                            "put_chunk",
                            #err(#conflict({ current = null })),
                        );
                    };
                    let stored = stage.accepted[index];
                    let hash = Codec.sha256(input.body);
                    if (hash != stored.sha256) {
                        return finish(
                            scope,
                            "put_chunk",
                            #err(#conflict({ current = null })),
                        );
                    };
                    let status = stageDigestState(stage);
                    return finish(scope, "put_chunk", #ok({
                        stage_id = stage.stage_id;
                        index = input.index;
                        block_sha256 = hash;
                        accepted = #replayed;
                        complete = true;
                        raw_sha256 = status.0;
                        computed_target = stage.identity.computed_target;
                    }));
                };
                case (#active) {};
            };

            let hash = Codec.sha256(input.body);
            if (index < stage.accepted.size()) {
                let stored = stage.accepted[index];
                if (stored.sha256 != hash) {
                    return finish(
                        scope,
                        "put_chunk",
                        #err(#conflict({ current = null })),
                    );
                };
                let status = stageDigestState(stage);
                return finish(scope, "put_chunk", #ok({
                    stage_id = stage.stage_id;
                    index = input.index;
                    block_sha256 = hash;
                    accepted = #replayed;
                    complete = status.1;
                    raw_sha256 = status.0;
                    computed_target = stage.identity.computed_target;
                }));
            };
            if (index != stage.accepted.size()) {
                return finish(
                    scope,
                    "put_chunk",
                    #err(#conflict({ current = null })),
                );
            };

            let ?content = Map.get(mem.contents, Nat64.compare, stage.content_id) else {
                Runtime.trap("Certified-assets stage content missing");
            };
            writeStageBlock(content, index, input.body);
            let nextAccepted = Array.tabulate<Types.StoredBlock>(
                stage.accepted.size() + 1,
                func(candidate) {
                    if (candidate < stage.accepted.size()) {
                        stage.accepted[candidate];
                    } else {
                        { sha256 = hash };
                    };
                },
            );
            let complete =
                nextAccepted.size() == geometryBlockCount(stage.geometry);
            let priorSha = stage.incremental_sha256;
            if (not Codec.sha256StateValid(priorSha)) {
                Runtime.trap("Ordered stage carries invalid SHA state");
            };
            if (
                priorSha.total_bytes != Nat64.fromNat(
                    prefixLength(
                        geometryLengths(stage.geometry),
                        stage.accepted.size(),
                    )
                )
            ) {
                Runtime.trap(
                    "Ordered stage SHA byte count disagrees with progress"
                );
            };
            let nextIncremental = Codec.sha256Update(priorSha, input.body);
            var nextIdentity = stage.identity;
            var rawDigest : ?Blob = null;
            if (complete) {
                let digest = Codec.sha256Finalize(nextIncremental);
                rawDigest := ?digest;
                switch (stage.identity.computed_target) {
                    case null {
                        nextIdentity := {
                            stage.identity with
                            computed_target = ?{
                                collection = stage.identity.collection;
                                collection_generation =
                                    stage.identity.collection_generation;
                                locator = #body_sha256({ digest });
                            };
                        };
                    };
                    case (?_) {};
                };
            };
            let nextExpiry = checkedTimeAdd(now, STAGE_IDLE_NS);
            let nextStage = {
                stage with
                identity = nextIdentity;
                accepted = nextAccepted;
                incremental_sha256 = nextIncremental;
                expires_at_ns = nextExpiry;
            };
            removeStageIdleExpiry(stage);
            Map.add(mem.stages, Text.compare, key, nextStage);
            addStageIdleExpiry(nextStage);
            updateContentHash(content, index, hash);
            let usage = usageFor(scope);
            setUsage(scope, {
                usage with
                accepted_staged_bytes = usage.accepted_staged_bytes +
                    input.body.size();
                reserved_staged_bytes = usage.reserved_staged_bytes -
                    input.body.size();
            });
            finish(scope, "put_chunk", #ok({
                stage_id = stage.stage_id;
                index = input.index;
                block_sha256 = hash;
                accepted = #new;
                complete;
                raw_sha256 = rawDigest;
                computed_target = nextIdentity.computed_target;
            }));
        };

        public func stageStatus(
            scope : Types.AppScope,
            stageId : Nat64,
        ) : Types.StageStatusResult {
            let ?state = currentScope(scope) else return #err(#stale_scope);
            let ?stage = Map.get(
                mem.stages,
                Text.compare,
                stageKey(scope, stageId),
            ) else return #ok(#unknown);
            let ?collection = collectionFor(state, stage.identity.collection) else {
                return #err(#invalid);
            };
            if (stage.identity.collection_generation != collection.generation) {
                return #err(#stale_generation({ current = collection.generation }));
            };
            let ?stageMount = mountFor(state, collection.mount) else return #err(#invalid);
            if (not stageAuthorityCurrent(state, collection, stageMount, stage)) {
                return #err(#stale_scope);
            };
            switch (stage.lifecycle) {
                case (#active) {
                    if (deadlineReached(nowNs(), stage.expires_at_ns)) {
                        let terminal = terminalFor(stage, stage.expires_at_ns);
                        return #ok(#expired(terminal));
                    };
                    let digest = stageDigestState(stage);
                    #ok(#active({
                        stage_id = stage.stage_id;
                        identity = stage.identity;
                        geometry = stage.geometry;
                        progress = stageProgress(stage);
                        raw_sha256 = digest.0;
                        expires_at_ns = stage.expires_at_ns;
                    }));
                };
                case (#consumed(value)) {
                    #ok(#consumed({
                        stage = value.terminal;
                        lifecycle = value.lifecycle;
                    }));
                };
                case (#aborted(terminal)) #ok(#aborted(terminal));
                case (#expired(terminal)) #ok(#expired(terminal));
            };
        };

        public func abortStage(
            scope : Types.AppScope,
            stageId : Nat64,
        ) : Types.Result {
            let ?state = currentScope(scope) else return #err(#stale_scope);
            let key = stageKey(scope, stageId);
            let ?initial = Map.get(mem.stages, Text.compare, key) else {
                return finishSimple(scope, "abort_stage", #err(#not_found));
            };
            let ?collection = collectionFor(state, initial.identity.collection) else {
                return #err(#invalid);
            };
            if (initial.identity.collection_generation != collection.generation) {
                return #err(#stale_generation({ current = collection.generation }));
            };
            // Abort is a release operation, not a positive write. It remains
            // available after a mount/write authority epoch rotation so an
            // already-owned reservation cannot be stranded by a freeze.
            let ?_stageMount = mountFor(state, collection.mount) else {
                return #err(#invalid);
            };
            ignore runForegroundMaintenance(scope);
            let ?maintained = Map.get(mem.stages, Text.compare, key) else {
                return finishSimple(scope, "abort_stage", #err(#not_found));
            };
            let stage = if (
                maintained.lifecycle == #active and
                deadlineReached(nowNs(), maintained.expires_at_ns)
            ) expireStage(maintained) else maintained;
            switch (stage.lifecycle) {
                case (#active) {
                    let now = nowNs();
                    let terminal = terminalFor(stage, now);
                    let next = {
                        stage with
                        lifecycle = #aborted(terminal);
                        future_batch_reserved = false;
                        reserved_commit_metadata_charge = 0;
                        reserved_entry_slots = 0;
                        reserved_committed_body_bytes = 0;
                    };
                    removeStageIdleExpiry(stage);
                    Map.add(mem.stages, Text.compare, key, next);
                    detachStageContent(next);
                    setStageReceiptExpiry(next, terminal.reconcile_until_ns);
                    releaseActiveStageUsage(stage, false);
                    finishSimple(scope, "abort_stage", #ok);
                };
                case (#aborted(_)) finishSimple(scope, "abort_stage", #ok);
                case (#expired(_)) finishSimple(scope, "abort_stage", #err(#expired));
                case (#consumed(_)) {
                    finishSimple(
                        scope,
                        "abort_stage",
                        #err(#conflict({ current = null })),
                    );
                };
            };
        };

        // commitBatch is intentionally synchronous. All fallible validation,
        // allocation, response rendering, and quota admission happen before
        // the first record/tree mutation.
        public func commitBatch(
            scope : Types.AppScope,
            input : Types.CommitBatchInput,
        ) : Types.CommitBatchResult {
            let shape = validateBatchShape(input);
            let ?deleteBatch = shape else return #err(#invalid);
            let ?state = currentScope(scope) else return #err(#stale_scope);
            switch (validateBatchAgainstState(state, input, deleteBatch)) {
                case (?error) return #err(error);
                case null {};
            };
            // Structural, collection-policy, and generation checks precede
            // body-sized work. Each bounded inline body is then hashed once;
            // the same digest feeds both the nonce fingerprint and content.
            let inlineDigests = Codec.inlineBodyDigests(input);
            let fingerprint = Codec.batchFingerprintFromInlineDigests(
                input,
                deleteBatch,
                inlineDigests,
            );
            if (deleteBatch) {
                return commitDelete(scope, state, input, fingerprint);
            };
            commitPositive(
                scope,
                state,
                input,
                fingerprint,
                inlineDigests,
            );
        };

        public func recordStatus(
            scope : Types.AppScope,
            target : Types.Target,
        ) : Types.RecordStatusResult {
            let ?state = currentScope(scope) else return #err(#stale_scope);
            let ?collection = collectionFor(state, target.collection) else {
                return #err(#invalid);
            };
            if (not locatorValid(collection, target.locator)) return #err(#invalid);
            if (target.collection_generation != collection.generation) {
                return #err(#stale_generation({ current = collection.generation }));
            };
            let key = recordKey(scope, target);
            switch (Map.get(mem.records, Text.compare, key)) {
                case (?record) return #ok(#present(recordIdentity(record)));
                case null {};
            };
            switch (Map.get(mem.delete_receipt_lanes, Text.compare, key)) {
                case (?lane) {
                    switch (lane.filled) {
                        case (?filled) return #ok(#recently_deleted(filled.deleted));
                        case null {};
                    };
                };
                case null {};
            };
            switch (Map.get(mem.revision_high_water, Text.compare, key)) {
                case (?highWater) return #ok(#deleted_high_water(highWater.deleted));
                case null {};
            };
            #ok(#absent({ collection_generation = collection.generation }));
        };

        public func maintenancePage(
            scope : Types.AppScope,
        ) : Types.MaintenancePageResult {
            let ?_ = currentScope(scope) else return #err(#stale_scope);
            #ok(runMaintenance(scope, false));
        };

        // -----------------------------------------------------------------
        // Kernel-internal Settings and lifecycle API
        // -----------------------------------------------------------------

        public func settingsSetAdmissionCeilings(
            scope : Types.AppScope,
            ceilings : Types.AdmissionCeilings,
        ) : Types.Result {
            let ?state = currentScope(scope) else return #err(#stale_scope);
            if (
                ceilings.entries > state.manifest_limits.entries or
                ceilings.committed_bytes > state.manifest_limits.committed_bytes or
                ceilings.staged_bytes > state.manifest_limits.staged_bytes or
                ceilings.general_receipts > state.manifest_limits.general_receipts
            ) return #err(#invalid);
            let nextLimits = {
                state.effective_limits with
                entries = ceilings.entries;
                committed_bytes = ceilings.committed_bytes;
                staged_bytes = ceilings.staged_bytes;
                general_receipts = ceilings.general_receipts;
            };
            Map.add(mem.scopes, Text.compare, CapabilityScope.key(scope), {
                state with effective_limits = nextLimits
            });
            #ok;
        };

        public func settingsSetWritesFrozen(
            scope : Types.AppScope,
            frozen : Bool,
        ) : Types.Result {
            let ?state = currentScope(scope) else return #err(#stale_scope);
            let epoch = allocateAuthorityEpoch(state.store_authority_epoch);
            let collections = Array.map<Types.CollectionPlan, Types.CollectionPlan>(
                state.collections,
                func(collection) {
                    {
                        collection with
                        writes = if (frozen) #frozen else #enabled;
                        authority_epoch = epoch;
                    };
                },
            );
            Map.add(mem.scopes, Text.compare, CapabilityScope.key(scope), {
                state with collections; store_authority_epoch = epoch
            });
            #ok;
        };

        // Capability enablement is independent from the user-visible writes
        // freeze. Rotating this epoch invalidates every previously accepted
        // positive-write handle without changing collection policy or
        // detaching already committed public responses.
        public func rotateStoreAuthority(scope : Types.AppScope) : () {
            let key = CapabilityScope.key(scope);
            let ?state = Map.get(mem.scopes, Text.compare, key) else return;
            if (
                not state.committed or state.retiring or
                not CapabilityScope.equal(state.scope, scope)
            ) return;
            let epoch = allocateAuthorityEpoch(state.store_authority_epoch);
            let collections =
                Array.map<Types.CollectionPlan, Types.CollectionPlan>(
                    state.collections,
                    func(collection) {
                        { collection with authority_epoch = epoch }
                    },
                );
            Map.add(mem.scopes, Text.compare, key, {
                state with
                store_authority_epoch = epoch;
                collections;
            });
        };

        public func setMountEnabled(
            scope : Types.AppScope,
            mountId : Text,
            enabled : Bool,
        ) : () {
            toggleMount(scope, mountId, enabled);
        };

        func toggleMount(
            scope : Types.AppScope,
            mountId : Text,
            enabled : Bool,
        ) : () {
            let ?state = activeCommittedScope(scope) else return;
            let ?mount = mountFor(state, mountId) else return;
            if (mount.enabled == enabled) return;
            let epoch = allocateAuthorityEpoch(mount.authority_epoch);
            let next = if (enabled) {
                let ?token = mount.detached_subtree else {
                    Runtime.trap("Enabled certified-assets mount lacks detached subtree");
                };
                ignore cert.attachV2(token, absenceResponses(mount));
                {
                    mount with
                    enabled = true;
                    authority_epoch = epoch;
                    detached_subtree = null;
                };
            } else {
                let token = cert.detachV2(
                    mount.prefix,
                    absenceResponses(mount),
                );
                {
                    mount with
                    enabled = false;
                    authority_epoch = epoch;
                    detached_subtree = ?token;
                };
            };
            Map.add(mem.mounts, Text.compare, mountKey(scope, mountId), next);
            updateScopeMount(next);
            let ?updatedState = Map.get(
                mem.scopes,
                Text.compare,
                CapabilityScope.key(scope),
            ) else {
                Runtime.trap("Certified-assets toggled scope disappeared");
            };
            syncMountCatalog(next);
            for (collection in updatedState.collections.vals()) {
                if (collection.mount == mountId) {
                    syncCollectionCatalog(collection, next);
                };
            };
        };

        public func settingsRetireScope(scope : Types.AppScope) : Types.Result {
            let ?state = Map.get(
                mem.scopes,
                Text.compare,
                CapabilityScope.key(scope),
            ) else return #err(#stale_scope);
            if (state.retiring) return #ok;
            if (not cleanupCapacity(scope, 1)) return #err(#busy);
            assert (retireScopeState(scope));
            #ok;
        };

        public func settingsMaintenancePage(
            scope : Types.AppScope,
        ) : Types.MaintenancePageOk {
            runMaintenance(scope, true);
        };

        public func publicationEntropyFingerprint() : ?Blob {
            switch (mem.publication_entropy) {
                case (#ready(value)) ?value.salt_fingerprint;
                case (#uninitialized) null;
            };
        };

        // The actor obtains randomness asynchronously and hands it to this
        // synchronous store-if-empty boundary. Concurrent callers converge on
        // the first stored salt; there is no durable pending state to wedge.
        public func initializePublicationEntropy(random32 : Blob) : ?Blob {
            switch (mem.publication_entropy) {
                case (#ready(value)) return ?value.salt_fingerprint;
                case (#uninitialized) {};
            };
            if (random32.size() != 32) return null;
            let salt = Codec.sha256Chunks([
                Codec.lpText("neutron.certified-publication.salt.v1"),
                random32,
                Codec.lpText(canisterId),
            ]);
            let fingerprint = Codec.sha256Chunks([
                Codec.lpText("neutron.certified-publication.salt-fingerprint.v1"),
                salt,
            ]);
            mem.publication_entropy := #ready({
                salt;
                salt_fingerprint = fingerprint;
            });
            ?fingerprint;
        };

        // -----------------------------------------------------------------
        // HTTP lookup. Publication ranges materialize at most one staged block;
        // portable blobs materialize one complete object.
        // -----------------------------------------------------------------

        public func resolve(
            authority : Text,
            canonicalPath : Text,
            methodText : Text,
            range : Types.RangeSelection,
            hasNonemptyQuery : Bool,
        ) : ?Types.ResolveResult {
            if (not deploymentCommitted()) return null;
            let ?route = RouteNamespace.sharedTarget(canonicalPath) else return null;
            let ?scope = Map.get(scopesByApp, Text.compare, route.app_id) else {
                return null;
            };
            let ?state = activeCommittedScope(scope) else return null;
            let ?mount = mountFor(state, route.mount_id) else return null;
            if (not RouteNamespace.contains(mount.prefix, canonicalPath)) return null;
            if (not validAuthority(mount, authority)) return null;
            let method : Types.HttpMethod = if (methodText == "GET") {
                #get;
            } else if (methodText == "HEAD") {
                #head;
            } else return null;
            if (
                method == #head and
                mount.authority_mode != #exact_neutron_host_v1
            ) return null;
            if (
                hasNonemptyQuery and
                mount.authority_mode == #canister_gateway_v1
            ) return ?#bad_request;

            let maybeRecord = switch (Map.get(
                mem.route_index,
                Text.compare,
                canonicalPath,
            )) {
                case (?recordKeyValue) {
                    Map.get(mem.records, Text.compare, recordKeyValue);
                };
                case null null;
            };
            let ?record = maybeRecord else {
                let ?leaf = selectAbsenceLeaf(mount, authority, methodText) else {
                    return null;
                };
                return ?#absent({
                    scope;
                    mount_id = mount.id;
                    canonical_path = canonicalPath;
                    authority_mode = mount.authority_mode;
                    certification_leaf_key = leaf;
                });
            };
            let ?collection = collectionFor(state, record.collection) else return null;
            if (
                not CapabilityScope.equal(record.scope, scope) or
                record.mount_id != mount.id or
                record.collection_generation != collection.generation or
                record.target.collection_generation != collection.generation or
                record.mount_fingerprint != mount.fingerprint or
                record.collection_fingerprint != collection.fingerprint
            ) {
                // A stale/corrupt route-index row must never make content from
                // a prior installation or policy generation reachable.
                return null;
            };
            if (
                not mount.enabled or collection.serving == #disabled or
                not registry.allowed(record.scope, #certified_read_routes, mount.id)
            ) {
                let ?leaf = selectAbsenceLeaf(mount, authority, methodText) else {
                    return null;
                };
                return ?#absent({
                    scope;
                    mount_id = mount.id;
                    canonical_path = canonicalPath;
                    authority_mode = mount.authority_mode;
                    certification_leaf_key = leaf;
                });
            };

            let ?content = Map.get(mem.contents, Nat64.compare, record.content_id) else {
                return null;
            };
            if (content.state != #committed) return null;
            let publicationBlock : ?Nat = if (
                collection.kind == #publication
            ) {
                switch (range) {
                    case (#absent) {
                        if (content.blocks.size() < 1) {
                            return ?#bad_request;
                        };
                        ?0;
                    };
                    case (#start(start)) {
                        switch (blockAtOffset(content.blocks, start)) {
                            case (?selected) ?selected;
                            case null return ?#bad_request;
                        };
                    };
                    case (#unsupported) return ?#bad_request;
                };
            } else null;
            let selectedBlock : ?Nat = if (method == #head) {
                null;
            } else {
                switch (collection.kind) {
                    case (#publication) publicationBlock;
                    case (_) {
                        if (range != #absent or content.blocks.size() < 1) {
                            return ?#bad_request;
                        };
                        ?0;
                    };
                };
            };
            let blocks = switch (selectedBlock) {
                case null [];
                case (?index) {
                    if (collection.kind == #publication) {
                        [materializeBlock(content, index)];
                    } else [materializeWhole(content)];
                };
            };
            let ?leaf = selectRecordLeaf(
                record,
                authority,
                methodText,
                selectedBlock,
            ) else return null;
            let chunkDescriptors = Array.tabulate<Types.ResolvedChunkDescriptor>(
                content.blocks.size(),
                func(index) {
                    let block = content.blocks[index];
                    let ?hash = block.sha256 else {
                        Runtime.trap("Committed certified-assets block lacks hash");
                    };
                    {
                        index = Nat32.fromNat(index);
                        offset = block.offset;
                        length = block.length;
                        body_hash = hash;
                    };
                },
            );
            ?#present({
                scope = record.scope;
                mount_id = record.mount_id;
                collection = record.collection;
                method;
                authority_mode = mount.authority_mode;
                canonical_path = record.canonical_path;
                kind = collection.kind;
                presentation = record.presentation;
                content_tag = record.content_tag;
                body_bytes = record.body_bytes;
                body_hash = record.content_tag;
                chunk_descriptors = chunkDescriptors;
                blocks;
                filename = switch (record.target.locator) {
                    case (#publication(value)) ?value.filename;
                    case (_) null;
                };
                certification_leaf_key = ?leaf;
            });
        };

        // Remaining private implementation follows below.

        func deriveScope(
            declaration : Types.AppDeclaration,
        ) : ?Types.ScopeState {
            let ?store = declaration.certified_assets else return null;
            assert (store.api == API_VERSION);
            let limits : Types.Limits = {
                entries = store.max_entries;
                committed_bytes = store.max_committed_bytes;
                object_bytes = store.max_object_bytes;
                staged_bytes = store.max_staged_bytes;
                pending_stages = store.max_pending_stages;
                batch_operations = store.max_batch_operations;
                batch_bytes = store.max_batch_bytes;
                general_receipts = store.max_idempotency_receipts;
                revocation_lanes = store.max_entries;
            };
            assert (validLimits(limits));
            assert (
                store.collections.size() >= 1 and
                store.collections.size() <= MAX_COLLECTIONS_PER_SCOPE
            );

            // Mounts are a derived read policy, not an authored route surface.
            // A mount is either host-bound publication or portable blob; mixing
            // those trust boundaries under one prefix is rejected.
            let mountClasses = Map.empty<Text, Bool>();
            var priorCollectionId : ?Text = null;
            for (authored in store.collections.vals()) {
                switch (priorCollectionId) {
                    case (?prior) {
                        assert (Text.compare(prior, authored.id) == #less);
                    };
                    case null {};
                };
                priorCollectionId := ?authored.id;
                assert (
                    Paths.validCollectionId(authored.id) and
                    Paths.validCollectionId(authored.mount)
                );
                let publication = parseKind(authored.kind) == #publication;
                switch (Map.get(mountClasses, Text.compare, authored.mount)) {
                    case (?prior) {
                        if (prior != publication) {
                            Runtime.trap(
                                "Certified-assets mount mixes publication and blob collections"
                            );
                        };
                    };
                    case null {
                        Map.add(
                            mountClasses,
                            Text.compare,
                            authored.mount,
                            publication,
                        );
                    };
                };
            };
            assert (
                Map.size(mountClasses) >= 1 and
                Map.size(mountClasses) <= MAX_COLLECTIONS_PER_SCOPE
            );

            let mounts = List.empty<Types.CommittedMount>();
            for ((mountId, publication) in Map.entries(mountClasses)) {
                let authority : Types.AuthorityMode = if (publication) {
                    #exact_neutron_host_v1;
                } else {
                    #canister_gateway_v1;
                };
                let epoch = declaration.app_scope.installation_uid;
                let prefix = RouteNamespace.sharedPrefix(
                    declaration.app_scope.app_id,
                    mountId,
                );
                let baseMount : Types.CommittedMount = {
                    scope = declaration.app_scope;
                    id = mountId;
                    prefix;
                    authority_mode = authority;
                    authority_epoch = epoch;
                    enabled = true;
                    fingerprint = Paths.mountFingerprint(
                        declaration.app_scope,
                        mountId,
                        prefix,
                        authority,
                        epoch,
                    );
                    absence_leaf_keys = [];
                    detached_subtree = null;
                };
                List.add(mounts, attachAbsenceLeafKeys(baseMount));
            };
            let mountArray = List.toArray(mounts);

            let collections = List.empty<Types.CollectionPlan>();
            var priorCollection : ?Text = null;
            for (authored in store.collections.vals()) {
                switch (priorCollection) {
                    case (?prior) {
                        assert (Text.compare(prior, authored.id) == #less);
                    };
                    case null {};
                };
                priorCollection := ?authored.id;
                let ?mount = mountById(mountArray, authored.mount) else {
                    Runtime.trap("Certified-assets collection mount missing");
                };
                let kind = parseKind(authored.kind);
                let typed : Types.CollectionDeclaration = {
                    id = authored.id;
                    mount = authored.mount;
                    kind;
                    path_prefix = authored.path_prefix;
                    exact_path = authored.exact_path;
                    max_object_bytes = authored.max_object_bytes;
                    authority_epoch = declaration.app_scope.installation_uid;
                    generation = declaration.app_scope.installation_uid;
                    serving = #enabled;
                    writes = #enabled;
                };
                assert (Paths.validCollection(limits, mount, typed));
                for (prior in List.values(collections)) {
                    let priorTyped : Types.CollectionDeclaration = {
                        id = prior.id;
                        mount = prior.mount;
                        kind = prior.kind;
                        path_prefix = prior.path_prefix;
                        exact_path = prior.exact_path;
                        max_object_bytes = ?prior.max_object_bytes;
                        authority_epoch = prior.authority_epoch;
                        generation = prior.generation;
                        serving = prior.serving;
                        writes = prior.writes;
                    };
                    assert (not Paths.collectionsOverlap(priorTyped, typed));
                };
                let objectMaximum = switch (authored.max_object_bytes) {
                    case (?value) value;
                    case null limits.object_bytes;
                };
                if (
                    kind != #publication and
                    objectMaximum > CertV2.PORTABLE_BLOB_BODY_BYTES_MAX_V2
                ) {
                    Runtime.trap(
                        "Portable certified blob exceeds the HTTP response bound"
                    );
                };
                List.add(collections, {
                    id = typed.id;
                    mount = typed.mount;
                    kind = typed.kind;
                    path_prefix = typed.path_prefix;
                    exact_path = typed.exact_path;
                    max_object_bytes = objectMaximum;
                    authority_epoch = typed.authority_epoch;
                    generation = typed.generation;
                    serving = typed.serving;
                    writes = typed.writes;
                    fingerprint = Paths.collectionFingerprint(typed, limits.object_bytes);
                });
            };
            let collectionArray = List.toArray(collections);
            let reservations = installedScopeReservations(
                declaration.app_scope,
                limits,
                mountArray,
                collectionArray,
            );
            let chargedReservation = reservations.charged;
            let arenaReservation = reservations.arena;
            let arenaExtentReservation = reservations.arena_extents;
            let exactKey = CapabilityScope.key(declaration.app_scope);
            let exactExisting = Map.get(mem.scopes, Text.compare, exactKey);
            var projectedReservedHeadroom =
                mem.global_reserved_charged_headroom;
            var projectedArenaHeadroom =
                mem.global_reserved_arena_headroom;
            var projectedArenaExtentHeadroom =
                mem.global_reserved_arena_extent_headroom;
            switch (exactExisting) {
                case (?_) {};
                case null {
                    switch (Map.get(
                        mem.scopes_by_app,
                        Text.compare,
                        declaration.app_scope.app_id,
                    )) {
                        case (?outgoingScope) {
                            if (
                                not CapabilityScope.equal(
                                    outgoingScope,
                                    declaration.app_scope,
                                )
                            ) {
                                let outgoingKey =
                                    CapabilityScope.key(outgoingScope);
                                let ?outgoing = Map.get(
                                    mem.scopes,
                                    Text.compare,
                                    outgoingKey,
                                ) else {
                                    Runtime.trap(
                                        "Certified-assets app index names missing scope"
                                    );
                                };
                                if (outgoing.reservation_active) {
                                    let outgoingUsage = usageFor(outgoingScope);
                                    let outgoingCharge =
                                        outgoingUsage.allocated_body_bytes +
                                        outgoingUsage.charged_metadata_bytes;
                                    if (
                                        outgoingCharge >
                                            outgoing.installed_charged_reservation
                                    ) {
                                        Runtime.trap(
                                            "Certified-assets outgoing reservation underflow"
                                        );
                                    };
                                    let outgoingRetirementCharge =
                                        retainedForestCharge(
                                            outgoing.mounts.size()
                                        ) + CLEANUP_JOB_CHARGE;
                                    let outgoingUnusedReservation =
                                        outgoing.installed_charged_reservation -
                                        outgoingCharge;
                                    if (
                                        outgoingUsage.allocated_body_bytes >
                                            outgoing.installed_arena_reservation
                                    ) {
                                        Runtime.trap(
                                            "Certified-assets outgoing arena reservation underflow"
                                        );
                                    };
                                    let outgoingUnusedArena =
                                        outgoing.installed_arena_reservation -
                                        outgoingUsage.allocated_body_bytes;
                                    let outgoingAllocatedExtents =
                                        allocatedExtentsForScope(outgoingScope);
                                    if (
                                        outgoingAllocatedExtents >
                                            outgoing.installed_arena_extent_reservation
                                    ) {
                                        Runtime.trap(
                                            "Certified-assets outgoing arena extent reservation underflow"
                                        );
                                    };
                                    let outgoingUnusedArenaExtents =
                                        outgoing.installed_arena_extent_reservation -
                                        outgoingAllocatedExtents;
                                    if (
                                        outgoingRetirementCharge >
                                            outgoingUnusedReservation
                                    ) {
                                        Runtime.trap(
                                            "Certified-assets outgoing retirement reservation underflow"
                                        );
                                    };
                                    // Commit retires the outgoing generation.
                                    // Its cleanup cursor plus catalog and
                                    // detached-token reserve become actual
                                    // charge until final cleanup, so only the
                                    // remainder stops contributing to the
                                    // projected global envelope.
                                    projectedReservedHeadroom := Nat.sub(
                                        projectedReservedHeadroom,
                                        outgoingUnusedReservation -
                                            outgoingRetirementCharge,
                                    );
                                    projectedArenaHeadroom := Nat.sub(
                                        projectedArenaHeadroom,
                                        outgoingUnusedArena,
                                    );
                                    projectedArenaExtentHeadroom := Nat.sub(
                                        projectedArenaExtentHeadroom,
                                        outgoingUnusedArenaExtents,
                                    );
                                };
                            };
                        };
                        case null {};
                    };
                    projectedReservedHeadroom += chargedReservation;
                    projectedArenaHeadroom += arenaReservation;
                    projectedArenaExtentHeadroom += arenaExtentReservation;
                };
            };
            if (
                mem.total_charged_bytes +
                    projectedReservedHeadroom +
                    Allocator.ARENA_METADATA_RESERVE_V3 >
                    GLOBAL_CHARGED_BYTES_MAX_V3
            ) Runtime.trap(
                "Certified-assets installed charged-byte envelope exceeded: " #
                Nat.toText(chargedReservation)
            );
            if (
                Nat64.toNat(mem.arena.allocated_bytes) +
                    projectedArenaHeadroom >
                    Nat64.toNat(
                        Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3
                    )
            ) Runtime.trap(
                "Certified-assets installed body-arena envelope exceeded: " #
                Nat.toText(arenaReservation)
            );
            if (
                2 * (
                    mem.arena.allocated_extents +
                    projectedArenaExtentHeadroom
                ) + 1 > Allocator.MAX_ARENA_EXTENTS_V3
            ) Runtime.trap(
                "Certified-assets installed arena-extent envelope exceeded: " #
                Nat.toText(arenaExtentReservation)
            );
            ?{
                scope = declaration.app_scope;
                installation_generation = declaration.app_scope.installation_uid;
                store_authority_epoch = declaration.app_scope.installation_uid;
                manifest_limits = limits;
                effective_limits = limits;
                collections = collectionArray;
                mounts = mountArray;
                installed_charged_reservation = chargedReservation;
                installed_arena_reservation = arenaReservation;
                installed_arena_extent_reservation =
                    arenaExtentReservation;
                reservation_active = true;
                committed = false;
                retiring = false;
            };
        };

        func installProvisional(scope : Types.ScopeState) : () {
            let key = CapabilityScope.key(scope.scope);
            assert (Map.get(mem.scopes, Text.compare, key) == null);
            Map.add(mem.scopes, Text.compare, key, scope);
            for (mount in scope.mounts.vals()) {
                Map.add(mem.mounts, Text.compare, mountKey(scope.scope, mount.id), mount);
            };
            setUsage(scope.scope, emptyUsage());
            mem.total_installed_charged_reservation +=
                scope.installed_charged_reservation;
            mem.total_installed_arena_reservation +=
                scope.installed_arena_reservation;
            mem.total_installed_arena_extent_reservation +=
                scope.installed_arena_extent_reservation;
            mem.global_reserved_charged_headroom +=
                scope.installed_charged_reservation;
            mem.global_reserved_arena_headroom +=
                scope.installed_arena_reservation;
            mem.global_reserved_arena_extent_headroom +=
                scope.installed_arena_extent_reservation;
        };

        // Pure projection of the exact configuration transaction. Omitted
        // declarations retire their prior certified-assets scopes, so account
        // for every retirement (including its bounded cleanup/catalog charge)
        // before testing retained-scope quota widenings. No target state or
        // certification is mutated here.
        public func configurationCommitReady() : Bool {
            if (not configured) return false;
            // Retirement currently enqueues its cleanup job before releasing
            // the outgoing reservation. Reject a target whose provisional
            // scopes already exceed an envelope so that this intermediate
            // invariant cannot trap only after activation.
            if (
                mem.total_charged_bytes +
                    mem.global_reserved_charged_headroom +
                    Allocator.ARENA_METADATA_RESERVE_V3 >
                    GLOBAL_CHARGED_BYTES_MAX_V3 or
                Nat64.toNat(mem.arena.allocated_bytes) +
                    mem.global_reserved_arena_headroom >
                    Nat64.toNat(
                        Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3
                    ) or
                2 * (
                    mem.arena.allocated_extents +
                    mem.global_reserved_arena_extent_headroom
                ) + 1 > Allocator.MAX_ARENA_EXTENTS_V3
            ) return false;
            var projectedChargedBytes = mem.total_charged_bytes;
            var reservedHeadroom = mem.global_reserved_charged_headroom;
            var arenaHeadroom = mem.global_reserved_arena_headroom;
            var arenaExtentHeadroom =
                mem.global_reserved_arena_extent_headroom;
            var retirementCount = 0;

            for ((scopeKey, current) in Map.entries(mem.scopes)) {
                if (
                    not current.retiring and
                    Map.get(targets, Text.compare, scopeKey) == null
                ) {
                    let usage = usageFor(current.scope);
                    let currentCharge =
                        usage.allocated_body_bytes +
                        usage.charged_metadata_bytes;
                    let allocatedExtents =
                        allocatedExtentsForScope(current.scope);
                    let retirementCharge =
                        CLEANUP_JOB_CHARGE +
                        retainedForestCharge(current.mounts.size());
                    if (
                        not current.reservation_active or
                        usage.cleanup_jobs + 1 >
                            MAX_CLEANUP_JOBS_PER_SCOPE or
                        currentCharge >
                            current.installed_charged_reservation or
                        usage.allocated_body_bytes >
                            current.installed_arena_reservation or
                        allocatedExtents >
                            current.installed_arena_extent_reservation or
                        retirementCharge >
                            current.installed_charged_reservation -
                                currentCharge
                    ) return false;

                    let unusedReservation =
                        current.installed_charged_reservation -
                        currentCharge;
                    let unusedArenaReservation =
                        current.installed_arena_reservation -
                        usage.allocated_body_bytes;
                    let unusedArenaExtentReservation =
                        current.installed_arena_extent_reservation -
                        allocatedExtents;
                    if (
                        unusedReservation > reservedHeadroom or
                        unusedArenaReservation > arenaHeadroom or
                        unusedArenaExtentReservation > arenaExtentHeadroom
                    ) return false;
                    projectedChargedBytes += retirementCharge;
                    reservedHeadroom -= unusedReservation;
                    arenaHeadroom -= unusedArenaReservation;
                    arenaExtentHeadroom -= unusedArenaExtentReservation;
                    retirementCount += 1;
                };
            };

            if (
                mem.global_cleanup_jobs + mem.global_active_stages +
                    retirementCount >
                    MAX_GLOBAL_CLEANUP_JOBS or
                (
                    retirementCount > 0 and
                    mem.next_cleanup_job_id >
                        NAT64_MAX - Nat64.fromNat(retirementCount)
                )
            ) return false;

            for ((scopeKey, target) in Map.entries(targets)) {
                let ?current = Map.get(
                    mem.scopes,
                    Text.compare,
                    scopeKey,
                ) else return false;
                if (not scopePlanEqual(current, target)) {
                    if (
                        not monotonicScopePlanWidening(current, target)
                    ) return false;
                    let usage = usageFor(current.scope);
                    let currentCharge =
                        usage.allocated_body_bytes +
                        usage.charged_metadata_bytes;
                    if (
                        currentCharge >
                            current.installed_charged_reservation or
                        currentCharge >
                            target.installed_charged_reservation or
                        usage.allocated_body_bytes >
                            current.installed_arena_reservation or
                        usage.allocated_body_bytes >
                            target.installed_arena_reservation
                    ) return false;
                    let allocatedExtents =
                        allocatedExtentsForScope(current.scope);
                    if (
                        allocatedExtents >
                            current.installed_arena_extent_reservation or
                        allocatedExtents >
                            target.installed_arena_extent_reservation
                    ) return false;
                    let priorUnused =
                        current.installed_charged_reservation -
                        currentCharge;
                    let nextUnused =
                        target.installed_charged_reservation -
                        currentCharge;
                    if (priorUnused > reservedHeadroom) return false;
                    reservedHeadroom :=
                        reservedHeadroom - priorUnused + nextUnused;
                    let priorArenaUnused =
                        current.installed_arena_reservation -
                        usage.allocated_body_bytes;
                    let nextArenaUnused =
                        target.installed_arena_reservation -
                        usage.allocated_body_bytes;
                    if (priorArenaUnused > arenaHeadroom) return false;
                    arenaHeadroom :=
                        arenaHeadroom - priorArenaUnused + nextArenaUnused;
                    let priorArenaExtentUnused =
                        current.installed_arena_extent_reservation -
                        allocatedExtents;
                    let nextArenaExtentUnused =
                        target.installed_arena_extent_reservation -
                        allocatedExtents;
                    if (
                        priorArenaExtentUnused > arenaExtentHeadroom
                    ) return false;
                    arenaExtentHeadroom :=
                        arenaExtentHeadroom - priorArenaExtentUnused +
                        nextArenaExtentUnused;
                };
            };
            projectedChargedBytes + reservedHeadroom +
                Allocator.ARENA_METADATA_RESERVE_V3 <=
                GLOBAL_CHARGED_BYTES_MAX_V3 and
            Nat64.toNat(mem.arena.allocated_bytes) + arenaHeadroom <=
                Nat64.toNat(Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3) and
            2 * (
                mem.arena.allocated_extents + arenaExtentHeadroom
            ) + 1 <= Allocator.MAX_ARENA_EXTENTS_V3;
        };

        func widenedEffectiveValue(
            priorManifest : Nat,
            priorEffective : Nat,
            nextManifest : Nat,
        ) : Nat {
            assert (
                priorEffective <= priorManifest and
                priorManifest <= nextManifest
            );
            if (priorEffective == priorManifest) {
                nextManifest;
            } else priorEffective;
        };

        func widenedEffectiveLimits(
            prior : Types.ScopeState,
            target : Types.ScopeState,
        ) : Types.Limits {
            {
                entries = widenedEffectiveValue(
                    prior.manifest_limits.entries,
                    prior.effective_limits.entries,
                    target.manifest_limits.entries,
                );
                committed_bytes = widenedEffectiveValue(
                    prior.manifest_limits.committed_bytes,
                    prior.effective_limits.committed_bytes,
                    target.manifest_limits.committed_bytes,
                );
                object_bytes = widenedEffectiveValue(
                    prior.manifest_limits.object_bytes,
                    prior.effective_limits.object_bytes,
                    target.manifest_limits.object_bytes,
                );
                staged_bytes = widenedEffectiveValue(
                    prior.manifest_limits.staged_bytes,
                    prior.effective_limits.staged_bytes,
                    target.manifest_limits.staged_bytes,
                );
                pending_stages = widenedEffectiveValue(
                    prior.manifest_limits.pending_stages,
                    prior.effective_limits.pending_stages,
                    target.manifest_limits.pending_stages,
                );
                batch_operations = widenedEffectiveValue(
                    prior.manifest_limits.batch_operations,
                    prior.effective_limits.batch_operations,
                    target.manifest_limits.batch_operations,
                );
                batch_bytes = widenedEffectiveValue(
                    prior.manifest_limits.batch_bytes,
                    prior.effective_limits.batch_bytes,
                    target.manifest_limits.batch_bytes,
                );
                general_receipts = widenedEffectiveValue(
                    prior.manifest_limits.general_receipts,
                    prior.effective_limits.general_receipts,
                    target.manifest_limits.general_receipts,
                );
                revocation_lanes = widenedEffectiveValue(
                    prior.manifest_limits.revocation_lanes,
                    prior.effective_limits.revocation_lanes,
                    target.manifest_limits.revocation_lanes,
                );
            };
        };

        func applyScopePlanWidening(
            prior : Types.ScopeState,
            target : Types.ScopeState,
        ) : Types.ScopeState {
            assert (monotonicScopePlanWidening(prior, target));
            let usage = usageFor(prior.scope);
            let currentCharge =
                usage.allocated_body_bytes + usage.charged_metadata_bytes;
            assert (
                currentCharge <= prior.installed_charged_reservation and
                prior.installed_charged_reservation <=
                    target.installed_charged_reservation and
                usage.allocated_body_bytes <=
                    prior.installed_arena_reservation and
                prior.installed_arena_reservation <=
                    target.installed_arena_reservation and
                allocatedExtentsForScope(prior.scope) <=
                    prior.installed_arena_extent_reservation and
                prior.installed_arena_extent_reservation <=
                    target.installed_arena_extent_reservation
            );
            let priorUnused =
                prior.installed_charged_reservation - currentCharge;
            let nextUnused =
                target.installed_charged_reservation - currentCharge;
            let priorArenaUnused =
                prior.installed_arena_reservation -
                usage.allocated_body_bytes;
            let nextArenaUnused =
                target.installed_arena_reservation -
                usage.allocated_body_bytes;
            let allocatedExtents = allocatedExtentsForScope(prior.scope);
            let priorArenaExtentUnused =
                prior.installed_arena_extent_reservation - allocatedExtents;
            let nextArenaExtentUnused =
                target.installed_arena_extent_reservation - allocatedExtents;
            mem.total_installed_charged_reservation :=
                replaceGlobalCounter(
                    mem.total_installed_charged_reservation,
                    prior.installed_charged_reservation,
                    target.installed_charged_reservation,
                );
            mem.total_installed_arena_reservation :=
                replaceGlobalCounter(
                    mem.total_installed_arena_reservation,
                    prior.installed_arena_reservation,
                    target.installed_arena_reservation,
                );
            mem.total_installed_arena_extent_reservation :=
                replaceGlobalCounter(
                    mem.total_installed_arena_extent_reservation,
                    prior.installed_arena_extent_reservation,
                    target.installed_arena_extent_reservation,
                );
            mem.global_reserved_charged_headroom :=
                replaceGlobalCounter(
                    mem.global_reserved_charged_headroom,
                    priorUnused,
                    nextUnused,
                );
            mem.global_reserved_arena_headroom :=
                replaceGlobalCounter(
                    mem.global_reserved_arena_headroom,
                    priorArenaUnused,
                    nextArenaUnused,
                );
            mem.global_reserved_arena_extent_headroom :=
                replaceGlobalCounter(
                    mem.global_reserved_arena_extent_headroom,
                    priorArenaExtentUnused,
                    nextArenaExtentUnused,
                );
            let collections =
                Array.tabulate<Types.CollectionPlan>(
                    prior.collections.size(),
                    func(index) {
                        let current = prior.collections[index];
                        let widened = target.collections[index];
                        {
                            current with
                            max_object_bytes = widened.max_object_bytes;
                        };
                    },
                );
            let widened = {
                prior with
                manifest_limits = target.manifest_limits;
                effective_limits = widenedEffectiveLimits(prior, target);
                collections;
                installed_charged_reservation =
                    target.installed_charged_reservation;
                installed_arena_reservation =
                    target.installed_arena_reservation;
                installed_arena_extent_reservation =
                    target.installed_arena_extent_reservation;
            };
            Map.add(
                mem.scopes,
                Text.compare,
                CapabilityScope.key(prior.scope),
                widened,
            );
            widened;
        };

        func scopePlanEqual(
            left : Types.ScopeState,
            right : Types.ScopeState,
        ) : Bool {
            CapabilityScope.equal(left.scope, right.scope) and
            left.installation_generation == right.installation_generation and
            left.manifest_limits == right.manifest_limits and
            left.installed_charged_reservation ==
                right.installed_charged_reservation and
            sameInstalledCollections(left.collections, right.collections) and
            sameMountSemantics(left.mounts, right.mounts);
        };

        func validLimits(limits : Types.Limits) : Bool {
            limits.entries >= 1 and limits.entries <= MAX_ENTRIES_PER_SCOPE and
            limits.committed_bytes >= 1 and
                limits.committed_bytes <= MAX_COMMITTED_BYTES_PER_SCOPE and
            limits.object_bytes >= 1 and limits.object_bytes <= MAX_OBJECT_BYTES and
            limits.staged_bytes >= 1 and limits.staged_bytes <= MAX_OBJECT_BYTES and
            limits.pending_stages >= 1 and
                limits.pending_stages <= MAX_PENDING_STAGES_PER_SCOPE and
            limits.batch_operations >= 1 and
                limits.batch_operations <= MAX_BATCH_OPERATIONS and
            limits.batch_bytes >= 1 and limits.batch_bytes <= MAX_OBJECT_BYTES and
            limits.general_receipts >= 2 and
                limits.general_receipts <= MAX_GENERAL_RECEIPTS_PER_SCOPE and
            limits.revocation_lanes == limits.entries;
        };

        func parseKind(value : Text) : Types.CollectionKind {
            if (value == "publication") return #publication;
            if (value == "immutable_blob") return #immutable_blob;
            if (value == "mutable_blob") return #mutable_blob;
            Runtime.trap("Invalid certified-assets collection kind");
        };

        func validBeginStageShape(input : Types.BeginStageInput) : Bool {
            if (
                input.nonce.size() != 16 or
                input.expected_bytes > MAX_OBJECT_BYTES
            ) return false;
            let count = Nat.max(
                1,
                (input.expected_bytes + STAGE_BLOCK_BYTES - 1) /
                    STAGE_BLOCK_BYTES,
            );
            if (count > MAX_STAGE_BLOCKS) return false;
            switch (input.target) {
                case (#allocate_publication(value)) {
                    Paths.validCollectionId(value.collection) and
                    Paths.validFilename(value.filename);
                };
                case (#derive_body_sha256(value)) {
                    Paths.validCollectionId(value.collection) and
                    input.expected_bytes <=
                        CertV2.PORTABLE_BLOB_BODY_BYTES_MAX_V2;
                };
            };
        };

        func validateStageInput(
            collection : Types.CollectionPlan,
            input : Types.BeginStageInput,
        ) : ?Types.StageGeometry {
            if (not validBeginStageShape(input)) return null;
            if (
                input.expected_bytes > collection.max_object_bytes or
                input.expected_bytes > MAX_OBJECT_BYTES
            ) return null;
            switch (collection.kind, input.target) {
                case (#publication, #allocate_publication(value)) {
                    if (not Paths.validFilename(value.filename)) return null;
                };
                case (#immutable_blob, #derive_body_sha256(_)) {
                    if (
                        input.expected_bytes >
                            CertV2.PORTABLE_BLOB_BODY_BYTES_MAX_V2
                    ) return null;
                };
                case (_) return null;
            };
            let count = Nat.max(
                1,
                (input.expected_bytes + STAGE_BLOCK_BYTES - 1) /
                    STAGE_BLOCK_BYTES,
            );
            if (count > MAX_STAGE_BLOCKS) return null;
            ?{
                block_bytes = STAGE_BLOCK_BYTES;
                block_count = Nat32.fromNat(count);
                expected_bytes = input.expected_bytes;
            };
        };

        func allocateStageContent(
            scope : Types.AppScope,
            collection : Types.CollectionPlan,
            contentId : Nat64,
            geometry : Types.StageGeometry,
        ) : ?Types.ContentDescriptor {
            let lengths = geometryLengths(geometry);
            let blocks = Array.tabulate<Types.ContentBlock>(
                lengths.size(),
                func(index) {
                    {
                        offset = prefixLength(lengths, index);
                        length = lengths[index];
                        sha256 = null;
                    };
                },
            );
            let ?extents = Allocator.allocateMany(mem.arena, lengths) else {
                return null;
            };
            let content : Types.ContentDescriptor = {
                content_id = contentId;
                scope;
                collection = collection.id;
                collection_generation = collection.generation;
                state = #staged;
                total_length = geometry.expected_bytes;
                geometry;
                storage = #per_block_extents(extents);
                blocks;
            };
            registerContentExtents(content);
            ?content;
        };

        func inlineContentFromReserved(
            scope : Types.AppScope,
            collection : Types.CollectionPlan,
            contentId : Nat64,
            body : Blob,
            extent : ?Types.ExtentRef,
            digest : Blob,
        ) : Types.ContentDescriptor {
            if ((body.size() == 0) != (extent == null)) {
                Runtime.trap("Inline allocation does not match body geometry");
            };
            if (digest.size() != 32) {
                Runtime.trap("Inline content digest must be SHA-256");
            };
            let geometry = fixedInlineGeometry(body.size());
            let content : Types.ContentDescriptor = {
                content_id = contentId;
                scope;
                collection = collection.id;
                collection_generation = collection.generation;
                state = #committed;
                total_length = body.size();
                geometry;
                storage = #contiguous(extent);
                blocks = [{
                    offset = 0;
                    length = body.size();
                    sha256 = ?digest;
                }];
            };
            registerContentExtents(content);
            switch (extent) {
                case (?value) {
                    requireContentExtentOwner(content, #contiguous, value);
                    Allocator.write(mem.arena, value, body);
                };
                case null {};
            };
            content;
        };

        func writeStageBlock(
            content : Types.ContentDescriptor,
            index : Nat,
            body : Blob,
        ) : () {
            switch (content.storage) {
                case (#per_block_extents(extents)) {
                    switch (extents[index]) {
                        case (?extent) {
                            requireContentExtentOwner(
                                content,
                                #per_block(Nat32.fromNat(index)),
                                extent,
                            );
                            Allocator.write(mem.arena, extent, body);
                        };
                        case null {
                            assert (body.size() == 0);
                        };
                    };
                };
                case (#contiguous(extent)) {
                    switch (extent) {
                        case (?value) {
                            requireContentExtentOwner(
                                content,
                                #contiguous,
                                value,
                            );
                            Allocator.writeAt(
                                mem.arena,
                                value,
                                content.blocks[index].offset,
                                body,
                            );
                        };
                        case null assert (body.size() == 0);
                    };
                };
            };
        };

        func updateContentHash(
            content : Types.ContentDescriptor,
            index : Nat,
            digest : Blob,
        ) : () {
            let blocks = Array.tabulate<Types.ContentBlock>(
                content.blocks.size(),
                func(candidate) {
                    if (candidate == index) {
                        { content.blocks[candidate] with sha256 = ?digest };
                    } else content.blocks[candidate];
                },
            );
            putContentDescriptor({
                content with blocks
            });
        };

        func materializeContentBlock(
            content : Types.ContentDescriptor,
            index : Nat,
            length : Nat,
        ) : Blob {
            switch (content.storage) {
                case (#per_block_extents(extents)) {
                    switch (extents[index]) {
                        case (?extent) {
                            requireContentExtentOwner(
                                content,
                                #per_block(Nat32.fromNat(index)),
                                extent,
                            );
                            let ?body = Allocator.read(mem.arena, extent, length) else {
                                Runtime.trap("Certified-assets extent read failed");
                            };
                            body;
                        };
                        case null {
                            assert (length == 0);
                            Blob.fromArray([]);
                        };
                    };
                };
                case (#contiguous(extent)) {
                    switch (extent) {
                        case (?value) {
                            requireContentExtentOwner(
                                content,
                                #contiguous,
                                value,
                            );
                            let ?body = Allocator.readAt(
                                mem.arena,
                                value,
                                content.blocks[index].offset,
                                length,
                            ) else Runtime.trap("Certified-assets extent read failed");
                            body;
                        };
                        case null {
                            assert (length == 0);
                            Blob.fromArray([]);
                        };
                    };
                };
            };
        };

        func geometryLengths(geometry : Types.StageGeometry) : [Nat] {
            Array.tabulate<Nat>(
                Nat32.toNat(geometry.block_count),
                func(index) {
                    if (index + 1 < Nat32.toNat(geometry.block_count)) {
                        geometry.block_bytes;
                    } else {
                        geometry.expected_bytes -
                            geometry.block_bytes * (
                                Nat32.toNat(geometry.block_count) - 1
                            );
                    };
                },
            );
        };

        func stageAllocationSizes(geometry : Types.StageGeometry) : [Nat] {
            geometryLengths(geometry);
        };

        func geometryBlockCount(geometry : Types.StageGeometry) : Nat {
            Nat32.toNat(geometry.block_count);
        };

        func geometryExpectedBytes(geometry : Types.StageGeometry) : Nat {
            geometry.expected_bytes;
        };

        func geometryBlockLength(
            geometry : Types.StageGeometry,
            index : Nat,
        ) : Nat {
            geometryLengths(geometry)[index];
        };

        func fixedInlineGeometry(length : Nat) : Types.StageGeometry {
            {
                block_bytes = length;
                block_count = 1;
                expected_bytes = length;
            };
        };

        func prefixLength(lengths : [Nat], until : Nat) : Nat {
            var result = 0;
            var index = 0;
            while (index < until) {
                result += lengths[index];
                index += 1;
            };
            result;
        };

        func contentAllocatedBytes(content : Types.ContentDescriptor) : Nat {
            switch (content.storage) {
                case (#per_block_extents(extents)) {
                    var total = 0;
                    for (extent in extents.vals()) {
                        switch (extent) {
                            case (?value) {
                                total += Nat32.toNat(value.allocated_capacity);
                            };
                            case null {};
                        };
                    };
                    total;
                };
                case (#contiguous(extent)) {
                    switch (extent) {
                        case (?value) Nat32.toNat(value.allocated_capacity);
                        case null 0;
                    };
                };
            };
        };

        func contentAllocatedExtents(
            content : Types.ContentDescriptor,
        ) : Nat {
            switch (content.storage) {
                case (#per_block_extents(extents)) {
                    var total = 0;
                    for (extent in extents.vals()) {
                        if (extent != null) total += 1;
                    };
                    total;
                };
                case (#contiguous(extent)) {
                    if (extent == null) 0 else 1;
                };
            };
        };

        func textBytes(value : Text) : Nat {
            Text.encodeUtf8(value).size();
        };

        func normalizedExtentWorstCase(length : Nat) : Nat {
            if (length == 0) return 0;
            let normalized = ((length + 15) / 16) * 16;
            Nat.min(
                Nat64.toNat(Allocator.ARENA_EXTENT_CAPACITY_MAX_V3),
                normalized + 255,
            );
        };

        func geometryWorstBodyCharge(geometry : Types.StageGeometry) : Nat {
            var result = 0;
            for (length in geometryLengths(geometry).vals()) {
                result += normalizedExtentWorstCase(length);
            };
            result;
        };

        func stageMetadataCharge(
            scope : Types.AppScope,
            collection : Types.CollectionPlan,
            geometry : Types.StageGeometry,
        ) : Nat {
            STAGE_METADATA_CHARGE + GENERAL_RECEIPT_CHARGE +
            STAGE_KEY_VALUE_BASE_CHARGE +
            textBytes(scope.app_id) + textBytes(collection.id) +
            geometryBlockCount(geometry) * STAGE_BLOCK_METADATA_CHARGE;
        };

        func pathSegmentCount(path : Text) : Nat {
            var result = 0;
            for (segment in Text.split(path, #char '/')) {
                if (segment != "") result += 1;
            };
            result;
        };

        func maximumRecordPathSegments(
            mount : Types.CommittedMount,
            collection : Types.CollectionPlan,
        ) : Nat {
            let mountSegments = pathSegmentCount(mount.prefix);
            switch (collection.kind) {
                case (#publication) mountSegments + 2;
                case (#immutable_blob) {
                    let ?prefix = collection.path_prefix else {
                        Runtime.trap("Immutable collection lacks path prefix");
                    };
                    mountSegments + pathSegmentCount(prefix) + 1;
                };
                case (#mutable_blob) {
                    switch (collection.path_prefix, collection.exact_path) {
                        case (?prefix, null) {
                            mountSegments + pathSegmentCount(prefix) + 1;
                        };
                        case (null, ?path) {
                            mountSegments + pathSegmentCount(path);
                        };
                        case (_) {
                            Runtime.trap(
                                "Mutable collection lacks one valid path policy"
                            );
                        };
                    };
                };
            };
        };

        // Forest route labels are shared inside one record mutation. Reserve
        // the unique canonical-path spine plus expression/request branches
        // and response leaves, rather than assuming a flat node count per
        // response.
        func reservedAuthNodes(
            geometry : Types.StageGeometry,
            publication : Bool,
            pathSegments : Nat,
        ) : Nat {
            if (publication) {
                let responses =
                    GatewayAuthority.CANISTER_AUTHORITY_VARIANTS_MAX *
                    (geometryBlockCount(geometry) + 1);
                pathSegments + 7 + responses;
            } else pathSegments + 5;
        };

        func reservedRecordMetadataCharge(
            mount : Types.CommittedMount,
            collection : Types.CollectionPlan,
            geometry : Types.StageGeometry,
        ) : Nat {
            let publication = collection.kind == #publication;
            let responses = if (publication) {
                // Every admitted exact Neutron authority has one HEAD and one
                // GET alternative per fixed-width block.
                GatewayAuthority.CANISTER_AUTHORITY_VARIANTS_MAX *
                (geometryBlockCount(geometry) + 1);
            } else 1;
            RECORD_KEY_VALUE_BASE_CHARGE + RECORD_METADATA_CHARGE +
            ROUTE_INDEX_CHARGE + DELETE_RECEIPT_LANE_CHARGE +
            MAX_RECORD_DYNAMIC_CHARGE +
            geometryBlockCount(geometry) * STAGE_BLOCK_METADATA_CHARGE +
            responses * (
                CERTIFICATION_LEAF_CHARGE + MAX_LEAF_DYNAMIC_CHARGE
            ) +
            reservedAuthNodes(
                geometry,
                publication,
                maximumRecordPathSegments(mount, collection),
            ) * AUTH_NODE_CHARGE;
        };

        func reservedCommitMetadataCharge(
            mount : Types.CommittedMount,
            collection : Types.CollectionPlan,
            geometry : Types.StageGeometry,
        ) : Nat {
            GENERAL_RECEIPT_CHARGE + CLEANUP_JOB_CHARGE +
            reservedRecordMetadataCharge(
                mount,
                collection,
                geometry,
            );
        };

        func leafMetadataCharge(key : Types.CertificationLeafKey) : Nat {
            let hostBytes = switch (key.owner.host_mode) {
                case (#exact(host)) textBytes(host);
                case (#excluded) 0;
            };
            CERTIFICATION_LEAF_CHARGE +
            textBytes(key.owner.method) +
            textBytes(key.owner.canonical_path) +
            hostBytes +
            key.expression_hash.size() +
            key.request_hash.size() +
            key.response_hash.size();
        };

        func recordMetadataCharge(record : Types.AssetRecord) : Nat {
            var result =
                RECORD_KEY_VALUE_BASE_CHARGE + RECORD_METADATA_CHARGE +
                ROUTE_INDEX_CHARGE +
                textBytes(record.scope.app_id) +
                textBytes(record.collection) +
                textBytes(record.canonical_key) +
                textBytes(record.canonical_path) +
                textBytes(record.mount_id) +
                record.mount_fingerprint.size() +
                record.collection_fingerprint.size() +
                record.content_tag.size() +
                record.block_hashes.size() * STAGE_BLOCK_METADATA_CHARGE;
            for (key in record.certification_leaf_keys.vals()) {
                result += leafMetadataCharge(key);
            };
            let publication = switch (record.target.locator) {
                case (#publication(_)) true;
                case (_) false;
            };
            result += reservedAuthNodes(
                record.geometry,
                publication,
                pathSegmentCount(record.canonical_path),
            ) * AUTH_NODE_CHARGE;
            result;
        };

        func maximumRecordGeometry(
            collection : Types.CollectionPlan,
        ) : Types.StageGeometry {
            let count = if (collection.kind == #publication) {
                Nat.max(
                    1,
                    (
                        collection.max_object_bytes + STAGE_BLOCK_BYTES - 1
                    ) / STAGE_BLOCK_BYTES,
                );
            } else 1;
            {
                block_bytes = if (collection.kind == #publication) {
                    STAGE_BLOCK_BYTES;
                } else collection.max_object_bytes;
                block_count = Nat32.fromNat(count);
                expected_bytes = collection.max_object_bytes;
            };
        };

        func maximumStageGeometry(
            collection : Types.CollectionPlan,
        ) : ?Types.StageGeometry {
            switch (collection.kind) {
                case (#publication) {
                    let count = Nat.max(
                        1,
                        (
                            collection.max_object_bytes +
                            STAGE_BLOCK_BYTES - 1
                        ) / STAGE_BLOCK_BYTES,
                    );
                    ?{
                        block_bytes = STAGE_BLOCK_BYTES;
                        block_count = Nat32.fromNat(count);
                        expected_bytes = collection.max_object_bytes;
                    };
                };
                case (#immutable_blob) {
                    ?{
                        block_bytes = STAGE_BLOCK_BYTES;
                        block_count = 1;
                        expected_bytes = collection.max_object_bytes;
                    };
                };
                case (#mutable_blob) null;
            };
        };

        // Installation consumes a complete per-declaration reservation. The
        // formula deliberately includes gross replacement, one active stage,
        // bounded detached cleanup, forest leaves/nodes, receipts, and arena
        // descriptors; runtime usage then converts this headroom to actual
        // charge rather than competing first-come with another scope.
        func installedScopeReservations(
            scope : Types.AppScope,
            limits : Types.Limits,
            mounts : [Types.CommittedMount],
            collections : [Types.CollectionPlan],
        ) : { charged : Nat; arena : Nat; arena_extents : Nat } {
            var maximumRecordCharge = 0;
            var maximumExtentsPerRecord = 1;
            var maximumObjectBytes = 0;
            var maximumStageCharge = 0;
            var hasPublication = false;
            for (collection in collections.vals()) {
                let ?mount = mountById(mounts, collection.mount) else {
                    Runtime.trap("Installed charge collection mount missing");
                };
                let recordGeometry = maximumRecordGeometry(collection);
                maximumRecordCharge := Nat.max(
                    maximumRecordCharge,
                    reservedRecordMetadataCharge(
                        mount,
                        collection,
                        recordGeometry,
                    ),
                );
                maximumObjectBytes := Nat.max(
                    maximumObjectBytes,
                    collection.max_object_bytes,
                );
                maximumExtentsPerRecord := Nat.max(
                    maximumExtentsPerRecord,
                    geometryBlockCount(recordGeometry),
                );
                if (collection.kind == #publication) {
                    hasPublication := true;
                };
                switch (maximumStageGeometry(collection)) {
                    case (?geometry) {
                        maximumStageCharge := Nat.max(
                            maximumStageCharge,
                            stageMetadataCharge(scope, collection, geometry) +
                            reservedCommitMetadataCharge(
                                mount,
                                collection,
                                geometry,
                            ),
                        );
                    };
                    case null {};
                };
            };
            // One byte is the minimum nonempty allocation. Publication blocks
            // add at most one extent for each complete fixed-width prefix.
            let baseCommittedExtents =
                Nat.min(limits.entries, limits.committed_bytes);
            let committedExtents = if (hasPublication) {
                Nat.min(
                    baseCommittedExtents * maximumExtentsPerRecord,
                    baseCommittedExtents +
                        (
                            limits.committed_bytes -
                            baseCommittedExtents
                        ) / STAGE_BLOCK_BYTES,
                );
            } else baseCommittedExtents;
            // Replacement cleanup gets a bounded byte/extent pool shared by
            // the scope's cleanup jobs. Runtime arena admission rejects a
            // replacement once that pool is full; it does not promise every
            // cleanup lane enough room for a maximum-sized object. A stage
            // already consumes the committed reservation and therefore is not
            // counted as a second body lane.
            let detachedBodies = Nat.min(
                limits.committed_bytes,
                MAX_CLEANUP_JOBS_PER_SCOPE * maximumObjectBytes,
            );
            let detachedExtents = Nat.min(
                committedExtents,
                MAX_CLEANUP_JOBS_PER_SCOPE * maximumExtentsPerRecord,
            );
            let batchExtents =
                Nat.min(limits.batch_operations, limits.batch_bytes);
            let arenaExtents =
                committedExtents + detachedExtents + batchExtents;
            let arenaReservation =
                limits.committed_bytes + detachedBodies +
                limits.batch_bytes +
                arenaExtents * ARENA_EXTENT_WORST_CASE_OVERHEAD;
            let recordRows =
                limits.entries * maximumRecordCharge +
                (limits.committed_bytes / STAGE_BLOCK_BYTES) *
                    STAGE_BLOCK_METADATA_CHARGE;
            let batchGrossMetadata =
                limits.batch_operations *
                (maximumRecordCharge + CLEANUP_JOB_CHARGE);
            let receiptRows =
                limits.general_receipts * GENERAL_RECEIPT_CHARGE;
            let cleanupRows =
                MAX_CLEANUP_JOBS_PER_SCOPE * CLEANUP_JOB_CHARGE;
            let forestCatalogReserve = retainedForestCharge(mounts.size());
            {
                arena = arenaReservation;
                arena_extents = arenaExtents;
                charged =
                    arenaReservation + recordRows + batchGrossMetadata +
                    receiptRows + cleanupRows + maximumStageCharge +
                    forestCatalogReserve;
            };
        };

        func retainedForestCharge(mountCount : Nat) : Nat {
            mountCount * FOREST_CATALOG_RESERVE_PER_MOUNT;
        };

        func globalChargedAdmission(
            scope : Types.AppScope,
            bodyCharge : Nat,
            metadataCharge : Nat,
            maximumNewExtents : Nat,
        ) : Bool {
            let scopeUsage = usageFor(scope);
            let scopeCharge =
                scopeUsage.allocated_body_bytes +
                scopeUsage.charged_metadata_bytes;
            let ?state = Map.get(
                mem.scopes,
                Text.compare,
                CapabilityScope.key(scope),
            ) else return false;
            scopeCharge + bodyCharge + metadataCharge <=
                state.installed_charged_reservation and
            scopeUsage.allocated_body_bytes + bodyCharge <=
                state.installed_arena_reservation and
            allocatedExtentsForScope(scope) + maximumNewExtents <=
                state.installed_arena_extent_reservation and
            mem.total_charged_bytes + bodyCharge + metadataCharge +
                Allocator.ARENA_METADATA_RESERVE_V3 <=
                    GLOBAL_CHARGED_BYTES_MAX_V3;
        };

        func stageDigestState(stage : Types.StageRecord) : (?Blob, Bool) {
            let complete =
                stage.accepted.size() == geometryBlockCount(stage.geometry);
            let digest = if (complete) {
                ?orderedStageDigest(stage);
            } else null;
            (digest, complete);
        };

        func orderedStageDigest(stage : Types.StageRecord) : Blob {
            let state = stage.incremental_sha256;
            if (not Codec.sha256StateValid(state)) {
                Runtime.trap("Ordered stage carries invalid SHA continuation");
            };
            let digest = Codec.sha256Finalize(state);
            switch (stage.identity.computed_target) {
                case (?{ locator = #body_sha256(value) }) {
                    if (value.digest != digest) {
                        Runtime.trap("Ordered stage target disagrees with SHA state");
                    };
                };
                case (?{ locator = #publication(_) }) {};
                case null {
                    if (
                        stage.accepted.size() ==
                            geometryBlockCount(stage.geometry)
                    ) {
                        Runtime.trap("Complete ordered stage lacks digest target");
                    };
                };
                case (_) {
                    Runtime.trap("Stage carries an invalid computed target");
                };
            };
            digest;
        };

        func stageProgress(stage : Types.StageRecord) : Types.StageProgress {
            {
                next_block_index = Nat32.fromNat(stage.accepted.size());
                block_hashes = Array.map<Types.StoredBlock, Blob>(
                    stage.accepted,
                    func(block) { block.sha256 },
                );
            };
        };

        func stageAcceptedBytes(stage : Types.StageRecord) : Nat {
            Nat64.toNat(stage.incremental_sha256.total_bytes);
        };

        func validateBatchShape(input : Types.CommitBatchInput) : ?Bool {
            if (
                input.nonce.size() != 16 or input.operations.size() < 1 or
                input.operations.size() > MAX_BATCH_OPERATIONS or
                input.requires_present_after.size() > MAX_BATCH_OPERATIONS
            ) return null;
            var puts = 0;
            var deletes = 0;
            let operationTargets = Map.empty<Text, ()>();
            for (operation in input.operations.vals()) {
                let target = switch (operation) {
                    case (#put(value)) {
                        puts += 1;
                        if (
                            value.target.collection.size() == 0 or
                            not validConditionShape(value.condition) or
                            not validBodyShape(value.body)
                        ) return null;
                        value.target;
                    };
                    case (#delete(value)) {
                        deletes += 1;
                        if (
                            value.condition.revision == 0 or
                            value.condition.content_tag.size() != 32
                        ) return null;
                        value.target;
                    };
                };
                if (not validTargetShape(target)) return null;
                let key = Codec.targetKey(target);
                if (Map.get(operationTargets, Text.compare, key) != null) return null;
                Map.add(operationTargets, Text.compare, key, ());
            };
            let requirementTargets = Map.empty<Text, ()>();
            for (requirement in input.requires_present_after.vals()) {
                if (
                    requirement.content_tag.size() != 32 or
                    not validTargetShape(requirement.target)
                ) return null;
                switch (requirement.revision) {
                    case (?value) if (value == 0) return null;
                    case null {};
                };
                let key = Codec.targetKey(requirement.target);
                if (Map.get(requirementTargets, Text.compare, key) != null) {
                    return null;
                };
                Map.add(requirementTargets, Text.compare, key, ());
            };
            if (deletes == 1 and puts == 0) {
                if (
                    input.operations.size() != 1 or
                    input.requires_present_after.size() != 0
                ) return null;
                return ?true;
            };
            if (puts >= 1 and deletes == 0) return ?false;
            null;
        };

        // Validate every target against the current closed collection
        // kinds before hashing or consulting a nonce receipt. This fixes
        // the protocol precedence: invalid/stale generation wins over a
        // changed-nonce conflict, while exact replay still precedes mutable
        // authority, CAS, dependency, quota, and reserve checks.
        func validateBatchAgainstState(
            state : Types.ScopeState,
            input : Types.CommitBatchInput,
            deleteBatch : Bool,
        ) : ?Types.Error {
            if (
                input.operations.size() >
                    state.manifest_limits.batch_operations
            ) return ?#invalid;
            // Complete every collection/locator/method-policy check before
            // consulting any generation, so operation ordering is invisible.
            for (entry in input.operations.vals()) {
                switch (entry) {
                    case (#put(operation)) {
                        if (deleteBatch) return ?#invalid;
                        let ?collection = collectionFor(
                            state,
                            operation.target.collection,
                        ) else return ?#invalid;
                        if (
                            not locatorValid(
                                collection,
                                operation.target.locator,
                            ) or
                            not putShapeValid(collection, operation)
                        ) return ?#invalid;
                        switch (operation.body) {
                            case (#inline(body)) {
                                if (body.size() > collection.max_object_bytes) {
                                    return ?#quota;
                                };
                            };
                            case (#stage(_)) {};
                        };
                        if (mountFor(state, collection.mount) == null) {
                            return ?#invalid;
                        };
                    };
                    case (#delete(operation)) {
                        if (not deleteBatch) return ?#invalid;
                        let ?collection = collectionFor(
                            state,
                            operation.target.collection,
                        ) else return ?#invalid;
                        if (
                            not locatorValid(
                                collection,
                                operation.target.locator,
                            )
                        ) return ?#invalid;
                        if (mountFor(state, collection.mount) == null) {
                            return ?#invalid;
                        };
                    };
                };
            };
            for (requirement in input.requires_present_after.vals()) {
                let ?collection = collectionFor(
                    state,
                    requirement.target.collection,
                ) else return ?#invalid;
                if (
                    not locatorValid(
                        collection,
                        requirement.target.locator,
                    )
                ) return ?#invalid;
                if (mountFor(state, collection.mount) == null) {
                    return ?#invalid;
                };
            };
            for (entry in input.operations.vals()) {
                let target = switch (entry) {
                    case (#put(operation)) operation.target;
                    case (#delete(operation)) operation.target;
                };
                let ?collection = collectionFor(
                    state,
                    target.collection,
                ) else return ?#invalid;
                if (target.collection_generation != collection.generation) {
                    return ?#stale_generation({
                        current = collection.generation
                    });
                };
            };
            for (requirement in input.requires_present_after.vals()) {
                let ?collection = collectionFor(
                    state,
                    requirement.target.collection,
                ) else return ?#invalid;
                if (
                    requirement.target.collection_generation !=
                        collection.generation
                ) {
                    return ?#stale_generation({
                        current = collection.generation
                    });
                };
            };
            null;
        };

        func commitDelete(
            scope : Types.AppScope,
            state : Types.ScopeState,
            input : Types.CommitBatchInput,
            fingerprint : Blob,
        ) : Types.CommitBatchResult {
            let #delete(operation) = input.operations[0] else return #err(#invalid);
            let ?collection = collectionFor(state, operation.target.collection) else {
                return #err(#invalid);
            };
            if (
                not locatorValid(collection, operation.target.locator)
            ) return #err(#invalid);
            if (operation.target.collection_generation != collection.generation) {
                return #err(#stale_generation({ current = collection.generation }));
            };
            let ?mount = mountFor(state, collection.mount) else return #err(#invalid);
            // Exact conditional deletion remains available while positive
            // writes or the public route are frozen/disabled.
            let key = recordKey(scope, operation.target);
            let nonceKey = deleteNonceKey(scope, input.nonce);
            switch (Map.get(mem.delete_nonce_index, Text.compare, nonceKey)) {
                case (?indexedTarget) {
                    if (indexedTarget != key) {
                        return finish(
                            scope,
                            "commit_batch",
                            #err(#conflict({ current = null })),
                        );
                    };
                };
                case null {};
            };
            let initialLane = Map.get(mem.delete_receipt_lanes, Text.compare, key);
            switch (initialLane) {
                case (?existing) {
                    switch (existing.filled) {
                        case (?filled) {
                            if (
                                filled.nonce == input.nonce and
                                filled.fingerprint == fingerprint
                            ) return finish(
                                scope,
                                "commit_batch",
                                #ok(deleteBatchReceipt(filled.deleted)),
                            );
                            if (filled.nonce == input.nonce) {
                                return finish(
                                    scope,
                                    "commit_batch",
                                    #err(#conflict({ current = null })),
                                );
                            };
                        };
                        case null {};
                    };
                };
                case null {};
            };
            ignore runForegroundMaintenance(scope);
            let lane = Map.get(mem.delete_receipt_lanes, Text.compare, key);
            let ?record = Map.get(mem.records, Text.compare, key) else {
                if (
                    Map.get(mem.revision_high_water, Text.compare, key) != null
                ) return finish(scope, "commit_batch", #err(#retired_key));
                return finish(scope, "commit_batch", #err(#not_found));
            };
            if (
                record.kernel_revision != operation.condition.revision or
                record.content_tag != operation.condition.content_tag
            ) return finish(
                scope,
                "commit_batch",
                #err(#conflict({ current = ?casIdentity(record) })),
            );
            if (record.kernel_revision == NAT64_MAX) {
                return finish(scope, "commit_batch", #err(#revision_exhausted));
            };
            let ?deleteReceiptLane = lane else {
                Runtime.trap("Committed certified asset lacks delete receipt lane");
            };
            if (
                not deleteReceiptLane.reserved or
                deleteReceiptLane.filled != null
            ) {
                Runtime.trap("Invalid certified-assets delete receipt lane");
            };
            if (not cleanupCapacityAvailable(scope, 1, 0)) {
                return finish(scope, "commit_batch", #err(#quota));
            };
            let deleted : Types.DeletedIdentity = {
                target = record.target;
                kernel_revision = record.kernel_revision + 1;
                prior_content_tag = record.content_tag;
            };
            let receipt = deleteBatchReceipt(deleted);
            let mutation = removeRecordMutation(record, mount);
            var catalogMount = mount;
            if (mount.enabled) {
                cert.beginV2PublicationBatch();
                ignore cert.applyV2([mutation]);
            } else {
                let ?token = mount.detached_subtree else {
                    Runtime.trap("Disabled mount lacks detached proof subtree");
                };
                let (updated, _) = cert.applyDetachedV2(token, [mutation]);
                let nextMount = { mount with detached_subtree = ?updated };
                Map.add(
                    mem.mounts,
                    Text.compare,
                    mountKey(scope, mount.id),
                    nextMount,
                );
                updateScopeMount(nextMount);
                catalogMount := nextMount;
            };
            syncMountCatalog(catalogMount);
            syncCollectionCatalog(collection, catalogMount);
            if (mount.enabled) {
                ignore cert.finishV2PublicationBatch();
            };

            Map.add(mem.delete_nonce_index, Text.compare, nonceKey, key);
            ignore Map.delete(mem.records, Text.compare, key);
            switch (Map.get(
                mem.route_index,
                Text.compare,
                record.canonical_path,
            )) {
                case (?current) {
                    if (current == key) {
                        ignore Map.delete(
                            mem.route_index,
                            Text.compare,
                            record.canonical_path,
                        );
                    };
                };
                case null {};
            };
            detachContent(record.content_id, scope);
            let expiry = checkedTimeAdd(nowNs(), RECONCILE_NS);
            Map.add(mem.delete_receipt_lanes, Text.compare, key, {
                deleteReceiptLane with
                reserved = false;
                filled = ?{
                    nonce = input.nonce;
                    fingerprint;
                    deleted;
                    expires_at_ns = expiry;
                };
            });
            Map.add(mem.expiry_index, Text.compare, expiryKey(
                scope,
                expiry,
                "r:" # key,
            ), {
                scope;
                expires_at_ns = expiry;
                kind = #delete_receipt(key);
            });
            if (collection.kind == #mutable_blob) {
                Map.add(mem.revision_high_water, Text.compare, key, {
                    target = record.target;
                    last_revision = deleted.kernel_revision;
                    last_content_tag = record.content_tag;
                    deleted;
                });
            };
            let usage = usageFor(scope);
            let allocated = contentAllocatedForId(record.content_id);
            setUsage(scope, {
                usage with
                live_entries = usage.live_entries - 1;
                committed_body_bytes = usage.committed_body_bytes - record.body_bytes;
                detached_charged_bytes = usage.detached_charged_bytes + allocated;
                reserved_revocation_lanes =
                    usage.reserved_revocation_lanes - 1;
                filled_revocation_lanes =
                    usage.filled_revocation_lanes + 1;
                receipt_nonce_indexes = usage.receipt_nonce_indexes + 1;
                receipt_expiry_indexes = usage.receipt_expiry_indexes + 1;
                charged_metadata_bytes =
                    usage.charged_metadata_bytes -
                    record.charged_metadata_bytes +
                    (if (collection.kind == #mutable_blob) {
                        HIGH_WATER_CHARGE;
                    } else 0);
            });
            finish(scope, "commit_batch", #ok(receipt));
        };

        func deleteBatchReceipt(
            deleted : Types.DeletedIdentity,
        ) : Types.BatchReceipt {
            {
                operations = [#delete({
                    request_index = 0;
                    identity = deleted;
                })];
            };
        };

        func commitPositive(
            scope : Types.AppScope,
            state : Types.ScopeState,
            input : Types.CommitBatchInput,
            fingerprint : Blob,
            inlineDigests : [?Blob],
        ) : Types.CommitBatchResult {
            if (input.operations.size() > state.manifest_limits.batch_operations) {
                return #err(#invalid);
            };
            let receiptKey = generalReceiptKey(scope, #positive_batch, input.nonce);
            switch (Map.get(mem.general_receipts, Text.compare, receiptKey)) {
                case (?existing) {
                    if (existing.fingerprint != fingerprint) {
                        return #err(#conflict({ current = null }));
                    };
                    let #batch(receipt) = existing.state else {
                        return #err(#conflict({ current = null }));
                    };
                    return #ok(receipt);
                };
                case null {};
            };

            // Exact replay is allowed to outlive authority rotation. A new
            // request referencing an existing old stage is not: detect that
            // captured-scope failure before disabled/frozen or CAS checks.
            for (entry in input.operations.vals()) {
                let #put(operation) = entry else return #err(#invalid);
                switch (operation.body) {
                    case (#inline(_)) {};
                    case (#stage(stageId)) {
                        switch (
                            Map.get(
                                mem.stages,
                                Text.compare,
                                stageKey(scope, stageId),
                            )
                        ) {
                            case null {};
                            case (?stage) {
                                let ?stageCollection = collectionFor(
                                    state,
                                    stage.identity.collection,
                                ) else return #err(#stale_scope);
                                let ?stageMount = mountFor(
                                    state,
                                    stageCollection.mount,
                                ) else return #err(#stale_scope);
                                if (
                                    stage.identity.collection_generation !=
                                        stageCollection.generation or
                                    not stageAuthorityCurrent(
                                        state,
                                        stageCollection,
                                        stageMount,
                                        stage,
                                    )
                                ) return #err(#stale_scope);
                            };
                        };
                    };
                };
            };

            // Error classes are selected for the complete batch, not by the
            // order of its operations. In particular, a later disabled mount
            // must win over an earlier frozen collection or CAS mismatch.
            var anyFrozen = false;
            var inlineBodyCount = 0;
            for (entry in input.operations.vals()) {
                let #put(operation) = entry else return #err(#invalid);
                let ?collection = collectionFor(
                    state,
                    operation.target.collection,
                ) else return #err(#invalid);
                let ?mount = mountFor(state, collection.mount) else {
                    return #err(#invalid);
                };
                if (
                    not mount.enabled or collection.serving == #disabled or
                    not registry.allowed(scope, #certified_read_routes, mount.id) or
                    not registry.allowed(scope, #certified_assets, "default")
                ) return finish(scope, "commit_batch", #err(#disabled));
                if (collection.writes == #frozen) anyFrozen := true;
                switch (operation.body) {
                    case (#inline(_)) inlineBodyCount += 1;
                    case (#stage(_)) {};
                };
            };
            if (anyFrozen) {
                return finish(scope, "commit_batch", #err(#frozen));
            };

            // Generation/revision exhaustion precedes every target-state,
            // stage-state, dependency, and quota failure.
            let inlineBodyCount64 = Nat64.fromNat(inlineBodyCount);
            if (
                inlineBodyCount64 > 0 and
                mem.next_content_id > NAT64_MAX - inlineBodyCount64
            ) return finish(
                scope,
                "commit_batch",
                #err(#generation_exhausted),
            );
            for (entry in input.operations.vals()) {
                let #put(operation) = entry else return #err(#invalid);
                switch (
                    Map.get(
                        mem.records,
                        Text.compare,
                        recordKey(scope, operation.target),
                    )
                ) {
                    case (?record) {
                        if (record.kernel_revision == NAT64_MAX) {
                            return finish(
                                scope,
                                "commit_batch",
                                #err(#revision_exhausted),
                            );
                        };
                    };
                    case null {};
                };
            };

            ignore runForegroundMaintenance(scope);
            let prepared = List.empty<PreparedPut>();
            var logicalBatchBytes = 0;
            var newSlots = 0;
            var committedDelta : Int = 0;
            var stagedCount = 0;
            var inlineCount : Nat64 = 0;
            var objectQuotaExceeded = false;
            var requestIndex = 0;

            for (entry in input.operations.vals()) {
                let #put(operation) = entry else return #err(#invalid);
                let ?collection = collectionFor(state, operation.target.collection) else {
                    return #err(#invalid);
                };
                if (
                    not locatorValid(collection, operation.target.locator) or
                    not putShapeValid(collection, operation)
                ) return #err(#invalid);
                if (operation.target.collection_generation != collection.generation) {
                    return #err(#stale_generation({ current = collection.generation }));
                };
                let ?mount = mountFor(state, collection.mount) else return #err(#invalid);
                if (
                    not mount.enabled or collection.serving == #disabled or
                    not registry.allowed(scope, #certified_read_routes, mount.id) or
                    not registry.allowed(scope, #certified_assets, "default")
                ) return finish(scope, "commit_batch", #err(#disabled));
                if (collection.writes == #frozen) {
                    return finish(scope, "commit_batch", #err(#frozen));
                };

                let key = recordKey(scope, operation.target);
                let prior = Map.get(mem.records, Text.compare, key);
                let conditionResult = checkPutCondition(
                    collection,
                    prior,
                    Map.get(mem.revision_high_water, Text.compare, key),
                    operation.condition,
                );
                switch (conditionResult) {
                    case (?#not_found) {
                        return finish(scope, "commit_batch", #err(#not_found));
                    };
                    case (?#retired_key) {
                        return finish(scope, "commit_batch", #err(#retired_key));
                    };
                    case (?#conflict) {
                        return finish(
                            scope,
                            "commit_batch",
                            #err(#conflict({
                                current = switch (prior) {
                                    case (?value) ?casIdentity(value);
                                    case null null;
                                };
                            })),
                        );
                    };
                    case null {};
                };
                let revision = switch (prior) {
                    case null (1 : Nat64);
                    case (?value) {
                        if (value.kernel_revision == NAT64_MAX) {
                            return finish(
                                scope,
                                "commit_batch",
                                #err(#revision_exhausted),
                            );
                        };
                        value.kernel_revision + 1;
                    };
                };
                let bodyData = prepareBody(
                    scope,
                    collection,
                    operation.target,
                    operation.body,
                    mem.next_content_id + inlineCount,
                    inlineDigests[requestIndex],
                );
                let (
                    bodyBytes,
                    geometry,
                    blockHashes,
                    contentTag,
                    contentId,
                    stage,
                ) = switch (bodyData) {
                    case (#ok(value)) value;
                    case (#err(error)) {
                        return finish(scope, "commit_batch", #err(error));
                    };
                };
                if (bodyBytes > collection.max_object_bytes) {
                    objectQuotaExceeded := true;
                };
                switch (operation.target.locator) {
                    case (#body_sha256(value)) {
                        if (value.digest != contentTag) {
                            return finish(
                                scope,
                                "commit_batch",
                                #err(#conflict({ current = null })),
                            );
                        };
                    };
                    case (_) {};
                };
                if (
                    Map.get(mem.delete_receipt_lanes, Text.compare, key) != null and
                    prior == null
                ) return finish(scope, "commit_batch", #err(#not_found));
                let presentation = switch (stage) {
                    case (?value) value.presentation;
                    case null null;
                };
                logicalBatchBytes += bodyBytes;
                if (prior == null) {
                    newSlots += 1;
                    committedDelta += bodyBytes;
                } else {
                    let ?old = prior else Runtime.trap("Impossible prior");
                    committedDelta += bodyBytes;
                    committedDelta -= old.body_bytes;
                };
                switch (stage) {
                    case (?_) stagedCount += 1;
                    case null inlineCount += 1;
                };
                List.add(prepared, {
                    request_index = Nat32.fromNat(requestIndex);
                    target_key = key;
                    collection;
                    mount;
                    target = operation.target;
                    prior;
                    revision;
                    content_id = contentId;
                    body_bytes = bodyBytes;
                    geometry;
                    block_hashes = blockHashes;
                    content_tag = contentTag;
                    presentation;
                    body = operation.body;
                    stage;
                });
                requestIndex += 1;
            };
            if (
                inlineCount > 0 and
                mem.next_content_id > NAT64_MAX - inlineCount
            ) return finish(
                scope,
                "commit_batch",
                #err(#generation_exhausted),
            );
            if (
                not requirementsSatisfied(
                    scope,
                    state,
                    input,
                    List.toArray(prepared),
                )
            ) {
                return finish(
                    scope,
                    "commit_batch",
                    #err(#conflict({ current = null })),
                );
            };
            if (
                objectQuotaExceeded or
                logicalBatchBytes > state.manifest_limits.batch_bytes
            ) return finish(scope, "commit_batch", #err(#quota));
            let usage = usageFor(scope);
            var consumedReservedEntries = 0;
            var consumedReservedCommitted = 0;
            var replacementJobs = 0;
            var admissionBodyCharge = 0;
            var admissionMetadataCharge =
                if (stagedCount == 0) GENERAL_RECEIPT_CHARGE else 0;
            var maximumNewExtents = 0;
            let inlineSizes = List.empty<Nat>();
            for (item in List.values(prepared)) {
                switch (item.prior) {
                    case (?_) replacementJobs += 1;
                    case null {};
                };
                switch (item.stage) {
                    case (?stage) {
                        consumedReservedEntries += stage.reserved_entry_slots;
                        consumedReservedCommitted +=
                            stage.reserved_committed_body_bytes;
                    };
                    case null {
                        switch (item.body) {
                            case (#inline(body)) List.add(
                                inlineSizes,
                                body.size(),
                            );
                            case (#stage(_)) {
                                Runtime.trap(
                                    "Prepared staged body lost its stage"
                                );
                            };
                        };
                        admissionMetadataCharge +=
                            reservedRecordMetadataCharge(
                                item.mount,
                                item.collection,
                                item.geometry,
                            );
                        admissionBodyCharge +=
                            normalizedExtentWorstCase(item.body_bytes);
                        if (item.body_bytes > 0) maximumNewExtents += 1;
                    };
                };
            };
            admissionMetadataCharge +=
                replacementJobs * CLEANUP_JOB_CHARGE;
            if (
                consumedReservedEntries > usage.reserved_entry_slots or
                consumedReservedCommitted >
                    usage.reserved_committed_body_bytes
            ) Runtime.trap("Stage logical reservation counters underflow");
            let otherReservedEntries =
                usage.reserved_entry_slots - consumedReservedEntries;
            let otherReservedCommitted =
                usage.reserved_committed_body_bytes -
                consumedReservedCommitted;
            let baselineEntries =
                usage.occupied_entry_slots + usage.reserved_entry_slots;
            let projectedEntries =
                usage.occupied_entry_slots + otherReservedEntries + newSlots;
            let baselineCommitted = Int.fromNat(
                usage.committed_body_bytes +
                usage.reserved_committed_body_bytes,
            );
            let projectedCommitted = Int.fromNat(
                usage.committed_body_bytes + otherReservedCommitted,
            ) + committedDelta;
            if (
                (
                    projectedEntries > state.effective_limits.entries and
                    projectedEntries > baselineEntries
                ) or (
                    projectedCommitted >
                        Int.fromNat(state.effective_limits.committed_bytes) and
                    projectedCommitted > baselineCommitted
                )
            ) return finish(scope, "commit_batch", #err(#quota));
            if (
                usage.cleanup_jobs + replacementJobs +
                    (usage.active_stages - stagedCount) >
                    MAX_CLEANUP_JOBS_PER_SCOPE or
                mem.global_cleanup_jobs + replacementJobs +
                    (mem.global_active_stages - stagedCount) >
                    MAX_GLOBAL_CLEANUP_JOBS
            ) return finish(scope, "commit_batch", #err(#quota));
            if (
                not globalChargedAdmission(
                    scope,
                    admissionBodyCharge,
                    admissionMetadataCharge,
                    maximumNewExtents,
                )
            ) return finish(scope, "commit_batch", #err(#quota));
            if (
                not Allocator.canAllocateMany(
                    mem.arena,
                    List.toArray(inlineSizes),
                )
            ) return finish(scope, "commit_batch", #err(#quota));
            if (
                stagedCount == 0 and
                (
                    usage.general_receipt_lanes +
                        usage.reserved_general_receipt_lanes + 1 >
                        state.effective_limits.general_receipts
                )
            ) return finish(scope, "commit_batch", #err(#receipt_full));

            if (cycleBalance() < MIN_REMAINING_CYCLES) {
                return finish(scope, "commit_batch", #err(#low_cycles));
            };

            let inlineContents = Map.empty<Nat64, Types.ContentDescriptor>();
            let ?inlineExtents = Allocator.allocateMany(
                mem.arena,
                List.toArray(inlineSizes),
            ) else Runtime.trap(
                "Certified-assets inline allocation diverged from preflight"
            );
            var inlineIndex = 0;
            for (item in List.values(prepared)) {
                switch (item.body) {
                    case (#inline(body)) {
                        let content = inlineContentFromReserved(
                            scope,
                            item.collection,
                            item.content_id,
                            body,
                            inlineExtents[inlineIndex],
                            item.content_tag,
                        );
                        inlineIndex += 1;
                        Map.add(
                            inlineContents,
                            Nat64.compare,
                            item.content_id,
                            content,
                        );
                    };
                    case (#stage(_)) {};
                };
            };
            if (inlineIndex != inlineExtents.size()) {
                Runtime.trap("Inline allocation count mismatch");
            };

            let records = List.empty<Types.AssetRecord>();
            let mutations = List.empty<Cert.V2Mutation>();
            let receipts = List.empty<Types.OperationReceipt>();
            for (item in List.values(prepared)) {
                let ?path = Paths.targetPath(item.mount, item.collection, item.target) else {
                    Runtime.trap("Validated certified-assets target lost path");
                };
                let initialRecord : Types.AssetRecord = {
                    scope;
                    collection = item.collection.id;
                    collection_generation = item.collection.generation;
                    canonical_key = Codec.targetKey(item.target);
                    canonical_path = path;
                    target = item.target;
                    content_id = item.content_id;
                    kernel_revision = item.revision;
                    content_tag = item.content_tag;
                    body_bytes = item.body_bytes;
                    geometry = item.geometry;
                    block_hashes = item.block_hashes;
                    presentation = item.presentation;
                    mount_id = item.mount.id;
                    mount_fingerprint = item.mount.fingerprint;
                    collection_fingerprint = item.collection.fingerprint;
                    certification_leaf_keys = [];
                    charged_metadata_bytes = 0;
                };
                let record = attachLeafKeys(
                    initialRecord,
                    item.mount,
                    item.collection,
                );
                assert (
                    record.charged_metadata_bytes +
                        DELETE_RECEIPT_LANE_CHARGE <=
                    reservedRecordMetadataCharge(
                        item.mount,
                        item.collection,
                        item.geometry,
                    )
                );
                List.add(records, record);
                List.add(
                    mutations,
                    replaceRecordMutation(
                        item.prior,
                        record,
                        item.mount,
                        item.collection,
                    ),
                );
                List.add(receipts, #put({
                    request_index = item.request_index;
                    lifecycle = {
                        committed = recordIdentity(record);
                    };
                }));
            };
            let receipt : Types.BatchReceipt = {
                operations = List.toArray(receipts);
            };
            cert.beginV2PublicationBatch();
            ignore cert.applyV2(List.toArray(mutations));
            let syncedMounts = Map.empty<Text, ()>();
            let syncedCollections = Map.empty<Text, ()>();
            for (item in List.values(prepared)) {
                let mountId = mountKey(scope, item.mount.id);
                if (
                    Map.get(syncedMounts, Text.compare, mountId) == null
                ) {
                    syncMountCatalog(item.mount);
                    Map.add(syncedMounts, Text.compare, mountId, ());
                };
                let collectionId =
                    collectionCatalogKey(scope, item.collection.id);
                if (
                    Map.get(
                        syncedCollections,
                        Text.compare,
                        collectionId,
                    ) == null
                ) {
                    syncCollectionCatalog(item.collection, item.mount);
                    Map.add(
                        syncedCollections,
                        Text.compare,
                        collectionId,
                        (),
                    );
                };
            };

            let now = nowNs();
            let terminalExpiry = checkedTimeAdd(now, RECONCILE_NS);
            for (record in List.values(records)) {
                let key = recordKey(scope, record.target);
                let prior = Map.get(mem.records, Text.compare, key);
                switch (prior) {
                    case (?old) {
                        detachContent(old.content_id, scope);
                        let current = usageFor(scope);
                        setUsage(scope, {
                            current with
                            committed_body_bytes =
                                current.committed_body_bytes - old.body_bytes;
                            detached_charged_bytes =
                                current.detached_charged_bytes +
                                contentAllocatedForId(old.content_id);
                            charged_metadata_bytes =
                                current.charged_metadata_bytes -
                                old.charged_metadata_bytes +
                                record.charged_metadata_bytes;
                        });
                    };
                    case null {
                        Map.add(mem.delete_receipt_lanes, Text.compare, key, {
                            reserved = true;
                            filled = null;
                        });
                        let current = usageFor(scope);
                        setUsage(scope, {
                            current with
                            live_entries = current.live_entries + 1;
                            occupied_entry_slots =
                                current.occupied_entry_slots + 1;
                            receipt_lanes = current.receipt_lanes + 1;
                            reserved_revocation_lanes =
                                current.reserved_revocation_lanes + 1;
                            charged_metadata_bytes =
                                current.charged_metadata_bytes +
                                record.charged_metadata_bytes +
                                DELETE_RECEIPT_LANE_CHARGE;
                        });
                    };
                };
                Map.add(mem.records, Text.compare, key, record);
                Map.add(mem.route_index, Text.compare, record.canonical_path, key);
                switch (recordBodySource(record, List.toArray(prepared))) {
                    case (#inline(_)) {
                        let ?content = Map.get(
                            inlineContents,
                            Nat64.compare,
                            record.content_id,
                        ) else Runtime.trap("Inline content missing");
                        putContentDescriptor(content);
                        setAllocatedExtentsForScope(
                            scope,
                            allocatedExtentsForScope(scope) +
                                contentAllocatedExtents(content),
                        );
                        let current = usageFor(scope);
                        setUsage(scope, {
                            current with
                            allocated_body_bytes =
                                current.allocated_body_bytes +
                                contentAllocatedBytes(content);
                        });
                    };
                    case (#stage(stageId)) {
                        let stageKeyValue = stageKey(scope, stageId);
                        let ?stage = Map.get(
                            mem.stages,
                            Text.compare,
                            stageKeyValue,
                        ) else Runtime.trap("Consumed stage missing");
                        let ?content = Map.get(
                            mem.contents,
                            Nat64.compare,
                            stage.content_id,
                        ) else Runtime.trap("Consumed stage content missing");
                        putContentDescriptor({
                            content with state = #committed
                        });
                        let terminal = terminalFor(stage, now);
                        let lifecycle = {
                            committed = recordIdentity(record);
                        };
                        Map.add(mem.stages, Text.compare, stageKeyValue, {
                            stage with
                            lifecycle = #consumed({ terminal; lifecycle });
                            future_batch_reserved = false;
                            reserved_commit_metadata_charge = 0;
                            reserved_entry_slots = 0;
                            reserved_committed_body_bytes = 0;
                        });
                        removeStageIdleExpiry(stage);
                        setStageReceiptExpiry(stage, terminalExpiry);
                        let current = usageFor(scope);
                        setUsage(scope, {
                            current with
                            active_stages = current.active_stages - 1;
                            accepted_staged_bytes =
                                current.accepted_staged_bytes -
                                stageAcceptedBytes(stage);
                            reserved_staged_bytes =
                                current.reserved_staged_bytes -
                                (geometryExpectedBytes(stage.geometry) -
                                    stageAcceptedBytes(stage));
                            reserved_entry_slots =
                                current.reserved_entry_slots -
                                stage.reserved_entry_slots;
                            reserved_committed_body_bytes =
                                current.reserved_committed_body_bytes -
                                stage.reserved_committed_body_bytes;
                            reserved_general_receipt_lanes =
                                current.reserved_general_receipt_lanes - 1;
                            general_receipt_lanes =
                                current.general_receipt_lanes + 1;
                            charged_metadata_bytes =
                                current.charged_metadata_bytes -
                                stage.reserved_commit_metadata_charge;
                        });
                    };
                };
                let current = usageFor(scope);
                setUsage(scope, {
                    current with
                    committed_body_bytes =
                        current.committed_body_bytes + record.body_bytes;
                });
            };
            mem.next_content_id += inlineCount;
            Map.add(mem.general_receipts, Text.compare, receiptKey, {
                scope;
                domain = #positive_batch;
                nonce = input.nonce;
                fingerprint;
                state = #batch(receipt);
                expires_at_ns = ?terminalExpiry;
            });
            Map.add(mem.expiry_index, Text.compare, expiryKey(
                scope,
                terminalExpiry,
                "g:" # receiptKey,
            ), {
                scope;
                expires_at_ns = terminalExpiry;
                kind = #general_receipt(receiptKey);
            });
            let receiptUsage = usageFor(scope);
            setUsage(scope, {
                receiptUsage with
                receipt_lanes = if (stagedCount == 0) {
                    receiptUsage.receipt_lanes + 1;
                } else {
                    Nat.sub(
                        receiptUsage.receipt_lanes,
                        stagedCount - 1,
                    );
                };
                general_receipt_lanes = if (stagedCount == 0) {
                    receiptUsage.general_receipt_lanes + 1;
                } else {
                    Nat.sub(
                        receiptUsage.general_receipt_lanes,
                        stagedCount - 1,
                    );
                };
                charged_metadata_bytes =
                    receiptUsage.charged_metadata_bytes +
                    GENERAL_RECEIPT_CHARGE;
            });
            let current = usageFor(scope);
            setUsage(scope, {
                current with
                receipt_nonce_indexes = current.receipt_nonce_indexes + 1;
                receipt_expiry_indexes = current.receipt_expiry_indexes + 1;
            });
            ignore cert.finishV2PublicationBatch();
            finish(scope, "commit_batch", #ok(receipt));
        };

        func prepareBody(
            scope : Types.AppScope,
            collection : Types.CollectionPlan,
            target : Types.Target,
            source : Types.BodySource,
            inlineContentId : Nat64,
            inlineDigest : ?Blob,
        ) : PrepareBodyResult {
            switch (source) {
                case (#inline(body)) {
                    if (collection.kind == #publication) {
                        return #err(#invalid);
                    };
                    let ?digest = inlineDigest else {
                        Runtime.trap(
                            "Validated inline body lost its precomputed digest"
                        );
                    };
                    if (digest.size() != 32) {
                        Runtime.trap(
                            "Validated inline body digest has invalid length"
                        );
                    };
                    #ok((
                        body.size(),
                        fixedInlineGeometry(body.size()),
                        [digest],
                        digest,
                        inlineContentId,
                        null,
                    ));
                };
                case (#stage(stageId)) {
                    if (inlineDigest != null) {
                        Runtime.trap("Staged body carried an inline digest");
                    };
                    if (
                        collection.kind != #publication and
                        collection.kind != #immutable_blob
                    ) return #err(#invalid);
                    let key = stageKey(scope, stageId);
                    let ?initial = Map.get(mem.stages, Text.compare, key) else {
                        return #err(#not_found);
                    };
                    let ?state = currentScope(scope) else return #err(#stale_scope);
                    let ?mount = mountFor(state, collection.mount) else {
                        return #err(#invalid);
                    };
                    if (not stageAuthorityCurrent(state, collection, mount, initial)) {
                        return #err(#stale_scope);
                    };
                    let stage = if (
                        initial.lifecycle == #active and
                        deadlineReached(nowNs(), initial.expires_at_ns)
                    ) expireStage(initial) else initial;
                    switch (stage.lifecycle) {
                        case (#aborted(_)) return #err(#aborted);
                        case (#expired(_)) return #err(#expired);
                        case (#consumed(_)) {
                            return #err(#conflict({ current = null }));
                        };
                        case (#active) {};
                    };
                    if (
                        not stage.future_batch_reserved or
                        stage.identity.collection != collection.id or
                        stage.identity.collection_generation != collection.generation or
                        stage.identity.computed_target != ?target
                    ) return #err(#conflict({ current = null }));
                    if (
                        stage.accepted.size() !=
                            geometryBlockCount(stage.geometry)
                    ) {
                        return #err(#incomplete({
                            missing_blocks = missingBlocks(stage);
                        }));
                    };
                    let ?_ = Map.get(
                        mem.contents,
                        Nat64.compare,
                        stage.content_id,
                    ) else Runtime.trap("Certified-assets stage content missing");
                    let hashes = Array.map<Types.StoredBlock, Blob>(
                        stage.accepted,
                        func(block) { block.sha256 },
                    );
                    let contentTag = orderedStageDigest(stage);
                    #ok((
                        geometryExpectedBytes(stage.geometry),
                        stage.geometry,
                        hashes,
                        contentTag,
                        stage.content_id,
                        ?stage,
                    ));
                };
            };
        };

        func putShapeValid(
            collection : Types.CollectionPlan,
            operation : {
                target : Types.Target;
                condition : Types.Condition;
                body : Types.BodySource;
            },
        ) : Bool {
            switch (collection.kind) {
                case (#publication) {
                    operation.condition == #absent and
                    (
                        switch (operation.body) {
                            case (#stage(_)) true;
                            case (_) false;
                        }
                    );
                };
                case (#immutable_blob) {
                    operation.condition == #absent;
                };
                case (#mutable_blob) {
                    (
                        switch (operation.body) {
                            case (#inline(_)) true;
                            case (_) false;
                        }
                    );
                };
            };
        };

        func checkPutCondition(
            collection : Types.CollectionPlan,
            prior : ?Types.AssetRecord,
            highWater : ?Types.RevisionHighWater,
            condition : Types.Condition,
        ) : ?{ #not_found; #retired_key; #conflict } {
            switch (condition) {
                case (#absent) {
                    if (prior != null) return ?#conflict;
                    if (
                        collection.kind == #mutable_blob and
                        highWater != null
                    ) return ?#retired_key;
                    null;
                };
                case (#match(expected)) {
                    let ?record = prior else {
                        if (
                            collection.kind == #mutable_blob and
                            highWater != null
                        ) return ?#retired_key;
                        return ?#not_found;
                    };
                    if (
                        record.kernel_revision != expected.revision or
                        record.content_tag != expected.content_tag
                    ) ?#conflict else null;
                };
            };
        };

        func requirementsSatisfied(
            scope : Types.AppScope,
            state : Types.ScopeState,
            input : Types.CommitBatchInput,
            prepared : [PreparedPut],
        ) : Bool {
            for (requirement in input.requires_present_after.vals()) {
                let ?collection = collectionFor(state, requirement.target.collection) else {
                    return false;
                };
                if (
                    not locatorValid(collection, requirement.target.locator) or
                    requirement.target.collection_generation != collection.generation
                ) return false;
                var projected : ?Types.CasIdentity = null;
                for (item in prepared.vals()) {
                    if (item.target == requirement.target) {
                        projected := ?{
                            collection_generation = item.collection.generation;
                            kernel_revision = item.revision;
                            content_tag = item.content_tag;
                            body_bytes = item.body_bytes;
                        };
                    };
                };
                if (projected == null) {
                    switch (Map.get(
                        mem.records,
                        Text.compare,
                        recordKey(scope, requirement.target),
                    )) {
                        case (?record) projected := ?casIdentity(record);
                        case null {};
                    };
                };
                let ?identity = projected else return false;
                if (identity.content_tag != requirement.content_tag) return false;
                switch (requirement.revision) {
                    case (?revision) {
                        if (identity.kernel_revision != revision) return false;
                    };
                    case null {};
                };
            };
            true;
        };

        func validConditionShape(condition : Types.Condition) : Bool {
            switch (condition) {
                case (#absent) true;
                case (#match(value)) {
                    value.revision > 0 and value.content_tag.size() == 32;
                };
            };
        };

        func validBodyShape(source : Types.BodySource) : Bool {
            switch (source) {
                case (#inline(body)) body.size() <= MAX_OBJECT_BYTES;
                case (#stage(stageId)) stageId > 0;
            };
        };

        func validTargetShape(target : Types.Target) : Bool {
            if (not Paths.validCollectionId(target.collection)) return false;
            switch (target.locator) {
                case (#publication(value)) {
                    value.publication_id.size() == 32 and
                    Paths.validFilename(value.filename);
                };
                case (#body_sha256(value)) value.digest.size() == 32;
                case (#key32(value)) value.key.size() == 32;
                case (#exact_path) true;
            };
        };

        func missingBlocks(stage : Types.StageRecord) : [Nat32] {
            let result = List.empty<Nat32>();
            var index = stage.accepted.size();
            while (index < geometryBlockCount(stage.geometry)) {
                List.add(result, Nat32.fromNat(index));
                index += 1;
            };
            List.toArray(result);
        };

        func recordBodySource(
            record : Types.AssetRecord,
            prepared : [PreparedPut],
        ) : Types.BodySource {
            for (item in prepared.vals()) {
                if (item.target == record.target) return item.body;
            };
            Runtime.trap("Certified-assets prepared record missing");
        };

        func attachLeafKeys(
            record : Types.AssetRecord,
            mount : Types.CommittedMount,
            collection : Types.CollectionPlan,
        ) : Types.AssetRecord {
            let sets = ownerResponses(record, mount, collection);
            let keys = List.empty<Types.CertificationLeafKey>();
            for (set in sets.vals()) {
                for (response in set.responses.vals()) {
                    let key = Cert.v2LeafKey(set.owner, response);
                    List.add(keys, {
                        owner = {
                            method = key.owner.method;
                            canonical_path = key.owner.canonical_path;
                            expression_kind = key.owner.expression_kind;
                            host_mode = key.owner.host_mode;
                        };
                        expression_hash = key.expression_hash;
                        request_hash = key.request_hash;
                        response_hash = key.response_hash;
                    });
                };
            };
            let withKeys = {
                record with certification_leaf_keys = List.toArray(keys)
            };
            {
                withKeys with
                charged_metadata_bytes = recordMetadataCharge(withKeys)
            };
        };

        func ownerResponses(
            record : Types.AssetRecord,
            mount : Types.CommittedMount,
            collection : Types.CollectionPlan,
        ) : [Cert.OwnerResponses] {
            if (
                record.collection != collection.id or
                record.collection_generation != collection.generation or
                record.mount_id != mount.id or collection.mount != mount.id
            ) {
                Runtime.trap(
                    "Certified-assets record policy does not match collection"
                );
            };
            switch (collection.kind) {
                case (#publication) {
                    let #publication(locator) = record.target.locator else {
                        Runtime.trap(
                            "Publication collection carries non-publication locator"
                        );
                    };
                    let ?storedPresentation = record.presentation else {
                        Runtime.trap("Publication record has no presentation");
                    };
                    let filename = locator.filename;
                    let presentation : CertV2.PublicationPresentation =
                        switch (storedPresentation) {
                            case (#inline_text) #inline_text;
                            case (#attachment) #attachment({ filename });
                        };
                    publicationOwnerResponses(
                        record,
                        mount,
                        presentation,
                    );
                };
                case (#immutable_blob) {
                    let #body_sha256(_) = record.target.locator else {
                        Runtime.trap(
                            "Immutable collection carries non-digest locator"
                        );
                    };
                    if (record.presentation != null) {
                        Runtime.trap("Immutable blob carries presentation");
                    };
                    [portableBlobOwnerResponse(record, #immutable)];
                };
                case (#mutable_blob) {
                    switch (record.target.locator) {
                        case (#key32(_)) {};
                        case (#exact_path) {};
                        case (_) {
                            Runtime.trap(
                                "Mutable collection carries invalid locator"
                            );
                        };
                    };
                    if (record.presentation != null) {
                        Runtime.trap("Mutable blob carries presentation");
                    };
                    [portableBlobOwnerResponse(record, #mutable)];
                };
            };
        };

        func publicationOwnerResponses(
            record : Types.AssetRecord,
            mount : Types.CommittedMount,
            presentation : CertV2.PublicationPresentation,
        ) : [Cert.OwnerResponses] {
            let blocks = Array.tabulate<CertV2.PublicationBlock>(
                record.block_hashes.size(),
                func(index) {
                    {
                        length = geometryBlockLength(record.geometry, index);
                        body_hash = record.block_hashes[index];
                    };
                },
            );
            let result = List.empty<Cert.OwnerResponses>();
            for (host in RouteNamespace.authorities(
                #shared_app_path,
                canisterId,
                record.scope.app_id,
            ).vals()) {
                let rendered = CertV2.publicationOwnerResponses({
                    canonical_path = record.canonical_path;
                    host;
                    presentation;
                    content_tag = record.content_tag;
                    blocks;
                });
                let #ok(sets) = rendered else {
                    Runtime.trap(
                        "Certified publication response render failed"
                    );
                };
                for (set in sets.vals()) List.add(result, set);
            };
            List.toArray(result);
        };

        func portableBlobOwnerResponse(
            record : Types.AssetRecord,
            policy : CertV2.PortableBlobPolicy,
        ) : Cert.OwnerResponses {
            let rendered = CertV2.portableBlobOwnerResponses({
                canonical_path = record.canonical_path;
                policy;
                body_hash = record.content_tag;
                body_length = record.body_bytes;
            });
            let #ok(set) = rendered else {
                Runtime.trap("Certified blob response render failed");
            };
            set;
        };

        func replaceRecordMutation(
            prior : ?Types.AssetRecord,
            next : Types.AssetRecord,
            mount : Types.CommittedMount,
            collection : Types.CollectionPlan,
        ) : Cert.V2Mutation {
            #replace({
                prior = switch (prior) {
                    case (?record) leafKeys(record.certification_leaf_keys);
                    case null [];
                };
                next = ownerResponses(next, mount, collection);
            });
        };

        func removeRecordMutation(
            record : Types.AssetRecord,
            _mount : Types.CommittedMount,
        ) : Cert.V2Mutation {
            #remove({ leaves = leafKeys(record.certification_leaf_keys) });
        };

        func leafKeys(
            keys : [Types.CertificationLeafKey],
        ) : [Cert.V2LeafKey] {
            Array.map<Types.CertificationLeafKey, Cert.V2LeafKey>(
                keys,
                func(key) {
                    {
                        owner = {
                            method = key.owner.method;
                            canonical_path = key.owner.canonical_path;
                            expression_kind = key.owner.expression_kind;
                            host_mode = key.owner.host_mode;
                        };
                        expression_hash = key.expression_hash;
                        request_hash = key.request_hash;
                        response_hash = key.response_hash;
                    };
                },
            );
        };

        func absenceResponses(
            mount : Types.CommittedMount,
        ) : [Cert.OwnerResponses] {
            let result = List.empty<Cert.OwnerResponses>();
            switch (mount.authority_mode) {
                case (#exact_neutron_host_v1) {
                    for (host in RouteNamespace.authorities(
                        #shared_app_path,
                        canisterId,
                        mount.scope.app_id,
                    ).vals()) {
                        let #ok(sets) = CertV2.absenceOwnerResponses({
                            base_path = mount.prefix;
                            authority = #host_bound({ host });
                        }) else Runtime.trap(
                            "Invalid host-bound absence policy"
                        );
                        for (set in sets.vals()) List.add(result, set);
                    };
                };
                case (#canister_gateway_v1) {
                    let #ok(sets) = CertV2.absenceOwnerResponses({
                        base_path = mount.prefix;
                        authority = #portable;
                    }) else Runtime.trap("Invalid portable absence policy");
                    for (set in sets.vals()) List.add(result, set);
                };
            };
            List.toArray(result);
        };

        func attachAbsenceLeafKeys(
            mount : Types.CommittedMount,
        ) : Types.CommittedMount {
            let keys = List.empty<Types.CertificationLeafKey>();
            for (set in absenceResponses(mount).vals()) {
                for (response in set.responses.vals()) {
                    let key = Cert.v2LeafKey(set.owner, response);
                    List.add(keys, {
                        owner = {
                            method = key.owner.method;
                            canonical_path = key.owner.canonical_path;
                            expression_kind = key.owner.expression_kind;
                            host_mode = key.owner.host_mode;
                        };
                        expression_hash = key.expression_hash;
                        request_hash = key.request_hash;
                        response_hash = key.response_hash;
                    });
                };
            };
            { mount with absence_leaf_keys = List.toArray(keys) };
        };

        func appendAbsenceMutations(
            mount : Types.CommittedMount,
            output : List.List<Cert.V2Mutation>,
        ) : () {
            List.add(output, #replace({
                prior = leafKeys(mount.absence_leaf_keys);
                next = absenceResponses(mount);
            }));
        };

        func terminalFor(
            stage : Types.StageRecord,
            terminalAt : Nat64,
        ) : Types.StageTerminal {
            {
                stage_id = stage.stage_id;
                identity = stage.identity;
                geometry = stage.geometry;
                terminal_at_ns = terminalAt;
                reconcile_until_ns = checkedTimeAdd(terminalAt, RECONCILE_NS);
            };
        };

        func deadlineReached(now : Nat64, deadline : Nat64) : Bool {
            now >= deadline;
        };

        func expireStage(stage : Types.StageRecord) : Types.StageRecord {
            let terminal = terminalFor(stage, stage.expires_at_ns);
            let next = {
                stage with
                lifecycle = #expired(terminal);
                future_batch_reserved = false;
                reserved_commit_metadata_charge = 0;
                reserved_entry_slots = 0;
                reserved_committed_body_bytes = 0;
            };
            removeStageIdleExpiry(stage);
            Map.add(
                mem.stages,
                Text.compare,
                stageKey(stage.scope, stage.stage_id),
                next,
            );
            detachStageContent(next);
            setStageReceiptExpiry(next, terminal.reconcile_until_ns);
            releaseActiveStageUsage(stage, false);
            next;
        };

        func detachStageContent(stage : Types.StageRecord) : () {
            detachContent(stage.content_id, stage.scope);
        };

        func detachContent(contentId : Nat64, scope : Types.AppScope) : () {
            let ?content = Map.get(mem.contents, Nat64.compare, contentId) else return;
            switch (content.state) {
                case (#detached(_)) return;
                case (_) {};
            };
            putContentDescriptor({
                content with state = #detached({ cursor = (0 : Nat32) })
            });
            // Every public path that can detach content admits cleanup
            // capacity before its first mutation. Failure here therefore
            // denotes an internal invariant violation and traps atomically.
            assert (enqueueCleanup(scope, #content(contentId), #content(0)));
        };

        func cleanupCapacity(scope : Types.AppScope, count : Nat) : Bool {
            let usage = usageFor(scope);
            count > 0 and
            usage.cleanup_jobs + count <= MAX_CLEANUP_JOBS_PER_SCOPE and
            mem.global_cleanup_jobs + count <= MAX_GLOBAL_CLEANUP_JOBS and
            mem.next_cleanup_job_id <= NAT64_MAX - Nat64.fromNat(count);
        };

        // Foreground admission preserves one physical cleanup slot for every
        // active stage. `additionalActiveReservations` is used by stage begin
        // before that stage has entered the usage counters.
        func cleanupCapacityAvailable(
            scope : Types.AppScope,
            immediateJobs : Nat,
            additionalActiveReservations : Nat,
        ) : Bool {
            let usage = usageFor(scope);
            let requested = immediateJobs + additionalActiveReservations;
            usage.cleanup_jobs + usage.active_stages + requested <=
                MAX_CLEANUP_JOBS_PER_SCOPE and
            mem.global_cleanup_jobs + mem.global_active_stages + requested <=
                MAX_GLOBAL_CLEANUP_JOBS and
            (requested == 0 or
                mem.next_cleanup_job_id <=
                    NAT64_MAX - Nat64.fromNat(requested)) and
            (immediateJobs == 0 or cleanupCapacity(scope, immediateJobs));
        };

        func enqueueCleanup(
            scope : Types.AppScope,
            kind : Types.CleanupKind,
            cursor : Types.CleanupCursor,
        ) : Bool {
            let usage = usageFor(scope);
            if (not cleanupCapacity(scope, 1)) return false;
            let jobId = mem.next_cleanup_job_id;
            mem.next_cleanup_job_id += 1;
            let job : Types.CleanupJob = {
                job_id = jobId;
                scope;
                kind;
                cursor;
                created_at_ns = nowNs();
            };
            Map.add(mem.cleanup_jobs, Nat64.compare, jobId, job);
            Map.add(
                mem.cleanup_jobs_by_scope,
                Text.compare,
                cleanupScopeKey(scope, jobId),
                jobId,
            );
            switch (kind) {
                case (#content(_)) {};
                case (#scope_retirement(_)) {
                    let key = CapabilityScope.key(scope);
                    assert (
                        Map.get(
                            mem.scope_retirement_job_by_scope,
                            Text.compare,
                            key,
                        ) == null
                    );
                    Map.add(
                        mem.scope_retirement_job_by_scope,
                        Text.compare,
                        key,
                        jobId,
                    );
                };
            };
            setUsage(scope, {
                usage with
                cleanup_jobs = usage.cleanup_jobs + 1;
                charged_metadata_bytes =
                    usage.charged_metadata_bytes + CLEANUP_JOB_CHARGE;
            });
            true;
        };

        func releaseActiveStageUsage(
            stage : Types.StageRecord,
            consumed : Bool,
        ) : () {
            let usage = usageFor(stage.scope);
            let allocated = contentAllocatedForId(stage.content_id);
            setUsage(stage.scope, {
                usage with
                active_stages = usage.active_stages - 1;
                accepted_staged_bytes =
                    usage.accepted_staged_bytes - stageAcceptedBytes(stage);
                reserved_staged_bytes =
                    usage.reserved_staged_bytes -
                    (
                        geometryExpectedBytes(stage.geometry) -
                        stageAcceptedBytes(stage)
                    );
                reserved_entry_slots =
                    usage.reserved_entry_slots - stage.reserved_entry_slots;
                reserved_committed_body_bytes =
                    usage.reserved_committed_body_bytes -
                    stage.reserved_committed_body_bytes;
                detached_charged_bytes = if (consumed) {
                    usage.detached_charged_bytes;
                } else usage.detached_charged_bytes + allocated;
                receipt_lanes = if (stage.future_batch_reserved) {
                    usage.receipt_lanes - 1;
                } else usage.receipt_lanes;
                reserved_general_receipt_lanes = if (stage.future_batch_reserved) {
                    usage.reserved_general_receipt_lanes - 1;
                } else usage.reserved_general_receipt_lanes;
                charged_metadata_bytes =
                    usage.charged_metadata_bytes -
                    stage.reserved_commit_metadata_charge;
            });
        };

        func setStageReceiptExpiry(
            stage : Types.StageRecord,
            expiry : Nat64,
        ) : () {
            let key = generalReceiptKey(stage.scope, #begin_stage, stage.nonce);
            let ?receipt = Map.get(mem.general_receipts, Text.compare, key) else {
                Runtime.trap("Certified-assets stage receipt missing");
            };
            Map.add(mem.general_receipts, Text.compare, key, {
                receipt with expires_at_ns = ?expiry
            });
            Map.add(mem.expiry_index, Text.compare, expiryKey(
                stage.scope,
                expiry,
                "g:" # key,
            ), {
                scope = stage.scope;
                expires_at_ns = expiry;
                kind = #general_receipt(key);
            });
            let usage = usageFor(stage.scope);
            setUsage(stage.scope, {
                usage with receipt_expiry_indexes =
                    usage.receipt_expiry_indexes + 1
            });
        };

        func expireAddressedGeneralReceiptIfDue(
            scope : Types.AppScope,
            key : Text,
        ) : () {
            let ?receipt = Map.get(
                mem.general_receipts,
                Text.compare,
                key,
            ) else return;
            let ?expiry = receipt.expires_at_ns else return;
            if (not deadlineReached(nowNs(), expiry)) return;
            assert (CapabilityScope.equal(receipt.scope, scope));
            ignore processExpiry({
                scope;
                expires_at_ns = expiry;
                kind = #general_receipt(key);
            });
            ignore Map.delete(
                mem.expiry_index,
                Text.compare,
                expiryKey(scope, expiry, "g:" # key),
            );
        };

        func emptyReclaimed() : Types.Reclaimed {
            {
                records = 0;
                bodies = 0;
                body_bytes = 0;
                charged_bytes = 0;
                authenticated_nodes = 0;
                receipts = 0;
            };
        };

        // Ordinary successful mutation paths contribute one deliberately
        // smaller cleanup slice. Current scopes only own point-content jobs;
        // whole-scope retirement is reachable through owner Settings below.
        func runForegroundMaintenance(
            scope : Types.AppScope,
        ) : Types.Reclaimed {
            var reclaimed = emptyReclaimed();
            let scopePrefix = CapabilityScope.key(scope) # "\00";
            let candidate = Map.entriesFrom(
                mem.cleanup_jobs_by_scope,
                Text.compare,
                scopePrefix,
            ).next();
            switch (candidate) {
                case (?(key, jobId)) {
                    if (Text.startsWith(key, #text scopePrefix)) {
                        let ?job = Map.get(
                            mem.cleanup_jobs,
                            Nat64.compare,
                            jobId,
                        ) else {
                            Runtime.trap("Cleanup secondary index is stale");
                        };
                        switch (job.kind) {
                            case (#content(contentId)) {
                                reclaimed := advanceContentCleanupWithBudget(
                                    job,
                                    contentId,
                                    reclaimed,
                                    MAX_FOREGROUND_EXTENTS,
                                    Nat64.toNat(
                                        Allocator.ARENA_EXTENT_CAPACITY_MAX_V3
                                    ),
                                );
                            };
                            case (#scope_retirement(_)) {
                                Runtime.trap(
                                    "Current scope owns retirement cleanup"
                                );
                            };
                        };
                    };
                };
                case null {};
            };

            var receiptRows = 0;
            var expiredStages = 0;
            let expiryKeys = List.empty<Text>();
            let now = nowNs();
            label expiryScan for ((key, entry) in Map.entriesFrom(
                mem.expiry_index,
                Text.compare,
                scopePrefix,
            )) {
                if (
                    not Text.startsWith(key, #text scopePrefix) or
                    entry.expires_at_ns > now
                ) break expiryScan;
                switch (entry.kind) {
                    case (#stage_idle(_)) {
                        if (expiredStages >= 1) break expiryScan;
                        expiredStages += 1;
                    };
                    case (_) {
                        if (
                            receiptRows >= MAX_FOREGROUND_RECEIPTS
                        ) break expiryScan;
                        receiptRows += 1;
                    };
                };
                List.add(expiryKeys, key);
            };
            for (key in List.values(expiryKeys)) {
                let ?entry = Map.get(
                    mem.expiry_index,
                    Text.compare,
                    key,
                ) else {
                    Runtime.trap("Certified-assets expiry row disappeared");
                };
                let chargedBefore = mem.total_charged_bytes;
                let expiredReceipts = processExpiry(entry);
                ignore Map.delete(mem.expiry_index, Text.compare, key);
                let chargedAfter = mem.total_charged_bytes;
                reclaimed := {
                    reclaimed with
                    receipts = reclaimed.receipts + expiredReceipts;
                    charged_bytes = reclaimed.charged_bytes +
                        Nat.sub(chargedBefore, chargedAfter);
                };
            };
            reclaimed;
        };

        func runMaintenance(
            scope : Types.AppScope,
            includeRetired : Bool,
        ) : Types.MaintenancePageOk {
            let scopeKey = CapabilityScope.key(scope);
            let ?maintenanceState = Map.get(
                mem.scopes,
                Text.compare,
                scopeKey,
            ) else {
                Runtime.trap("Unknown certified-assets maintenance scope");
            };
            assert (CapabilityScope.equal(maintenanceState.scope, scope));
            if (not includeRetired) {
                assert (
                    maintenanceState.committed and
                    not maintenanceState.retiring
                );
            };
            var reclaimed = emptyReclaimed();
            let scopePrefix = CapabilityScope.key(scope) # "\00";
            let retiring = maintenanceState.retiring;

            // First advance the oldest persisted content/generation job.
            let candidate = Map.entriesFrom(
                mem.cleanup_jobs_by_scope,
                Text.compare,
                scopePrefix,
            ).next();
            switch (candidate) {
                case (?(key, jobId)) {
                    if (Text.startsWith(key, #text scopePrefix)) {
                        let ?job = Map.get(
                            mem.cleanup_jobs,
                            Nat64.compare,
                            jobId,
                        ) else Runtime.trap("Cleanup secondary index is stale");
                        reclaimed := advanceCleanupJob(job, reclaimed);
                    };
                };
                case null {};
            };

            // Then consume ordered expiries without inspecting unrelated
            // receipt/stage maps. Retirement owns those rows through its
            // phased cursor; running ordinary expiry concurrently could
            // enqueue a later content job behind the retirement job.
            let now = nowNs();
            if (not retiring) {
                var expiryRows = 0;
                let expiryKeys = List.empty<Text>();
                label expiryScan for ((key, entry) in Map.entriesFrom(
                    mem.expiry_index,
                    Text.compare,
                    scopePrefix,
                )) {
                    if (
                        not Text.startsWith(key, #text scopePrefix) or
                        entry.expires_at_ns > now or
                        expiryRows >= MAX_MAINTENANCE_RECEIPTS
                    ) break expiryScan;
                    List.add(expiryKeys, key);
                    expiryRows += 1;
                };
                for (key in List.values(expiryKeys)) {
                    let ?entry = Map.get(
                        mem.expiry_index,
                        Text.compare,
                        key,
                    ) else {
                        Runtime.trap("Certified-assets expiry row disappeared");
                    };
                    let chargedBefore = mem.total_charged_bytes;
                    let expiredReceipts = processExpiry(entry);
                    ignore Map.delete(mem.expiry_index, Text.compare, key);
                    let chargedAfter = mem.total_charged_bytes;
                    reclaimed := {
                        reclaimed with
                        receipts = reclaimed.receipts + expiredReceipts;
                        charged_bytes = reclaimed.charged_bytes +
                            Nat.sub(chargedBefore, chargedAfter);
                    };
                };
            };
            let remaining = cleanupCount(scope);
            {
                page = reclaimed;
                has_more =
                    remaining > 0 or
                    (not retiring and hasDueExpiry(scope, now));
                remaining_jobs = remaining;
            };
        };

        func advanceCleanupJob(
            job : Types.CleanupJob,
            initial : Types.Reclaimed,
        ) : Types.Reclaimed {
            switch (job.kind) {
                case (#content(contentId)) {
                    advanceContentCleanup(job, contentId, initial);
                };
                case (#scope_retirement(retirement)) {
                    advanceScopeRetirement(job, retirement, initial);
                };
            };
        };

        // Returns at most one frozen maintenance slice and persists null
        // storage slots only through the caller. Capacity, not logical body
        // length, is the charged-byte bound.
        func cleanupContentSlice(
            content : Types.ContentDescriptor,
            maxExtents : Nat,
            maxLogicalBytes : Nat,
            maxChargedBytes : Nat,
        ) : ContentCleanupSlice {
            var index = switch (content.state) {
                case (#detached(value)) Nat32.toNat(value.cursor);
                case (_) 0;
            };
            var extents = 0;
            var logicalBytes = 0;
            var chargedBytes = 0;
            var storage = content.storage;
            switch (storage) {
                case (#per_block_extents(current)) {
                    var next = current;
                    label blocks while (
                        index < current.size() and extents < maxExtents
                    ) {
                        switch (current[index]) {
                            case (?extent) {
                                let capacity =
                                    Nat32.toNat(extent.allocated_capacity);
                                let length = content.blocks[index].length;
                                if (
                                    logicalBytes + length > maxLogicalBytes or
                                    chargedBytes + capacity > maxChargedBytes
                                ) break blocks;
                                freeContentExtent(
                                    content,
                                    #per_block(Nat32.fromNat(index)),
                                    extent,
                                );
                                next := replaceExtent(next, index, null);
                                extents += 1;
                                logicalBytes += length;
                                chargedBytes += capacity;
                            };
                            case null {};
                        };
                        index += 1;
                    };
                    storage := #per_block_extents(next);
                };
                case (#contiguous(current)) {
                    if (index == 0) {
                        switch (current) {
                            case (?extent) {
                                let capacity =
                                    Nat32.toNat(extent.allocated_capacity);
                                if (
                                    maxExtents > 0 and
                                    content.total_length <= maxLogicalBytes and
                                    capacity <= maxChargedBytes
                                ) {
                                    freeContentExtent(
                                        content,
                                        #contiguous,
                                        extent,
                                    );
                                    storage := #contiguous(null);
                                    index := 1;
                                    extents := 1;
                                    logicalBytes := content.total_length;
                                    chargedBytes := capacity;
                                };
                            };
                            case null {
                                index := 1;
                            };
                        };
                    };
                };
            };
            let complete = switch (storage) {
                case (#per_block_extents(values)) {
                    var any = false;
                    for (extent in values.vals()) {
                        if (extent != null) any := true;
                    };
                    not any;
                };
                case (#contiguous(value)) value == null;
            };
            {
                next = {
                    content with
                    state = #detached({ cursor = Nat32.fromNat(index) });
                    storage;
                };
                complete;
                extents;
                logical_bytes = logicalBytes;
                charged_bytes = chargedBytes;
            };
        };

        func advanceContentCleanup(
            job : Types.CleanupJob,
            contentId : Nat64,
            initial : Types.Reclaimed,
        ) : Types.Reclaimed {
            advanceContentCleanupWithBudget(
                job,
                contentId,
                initial,
                MAX_MAINTENANCE_EXTENTS,
                MAX_MAINTENANCE_BODY_BYTES,
            );
        };

        func advanceContentCleanupWithBudget(
            job : Types.CleanupJob,
            contentId : Nat64,
            initial : Types.Reclaimed,
            maxExtents : Nat,
            maxBodyBytes : Nat,
        ) : Types.Reclaimed {
            let ?content = Map.get(mem.contents, Nat64.compare, contentId) else {
                finishCleanupJob(job);
                return {
                    initial with
                    charged_bytes =
                        initial.charged_bytes + CLEANUP_JOB_CHARGE;
                };
            };
            let #detached(value) = content.state else {
                Runtime.trap("Cleanup job owns nondetached content");
            };
            let expectedStart = switch (job.cursor) {
                case (#content(index)) Nat32.toNat(index);
                case (_) Runtime.trap("Invalid content cleanup cursor");
            };
            assert (Nat32.toNat(value.cursor) == expectedStart);
            let slice = cleanupContentSlice(
                content,
                maxExtents,
                maxBodyBytes,
                maxBodyBytes,
            );
            let usage = usageFor(job.scope);
            setAllocatedExtentsForScope(
                job.scope,
                Nat.sub(
                    allocatedExtentsForScope(job.scope),
                    slice.extents,
                ),
            );
            setUsage(job.scope, {
                usage with
                allocated_body_bytes = Nat.sub(
                    usage.allocated_body_bytes,
                    slice.charged_bytes,
                );
                detached_charged_bytes = Nat.sub(
                    usage.detached_charged_bytes,
                    slice.charged_bytes,
                );
            });
            let finishNow =
                slice.complete and
                slice.charged_bytes + CLEANUP_JOB_CHARGE <=
                    maxBodyBytes;
            if (finishNow) {
                ignore deleteContentDescriptor(contentId);
                finishCleanupJob(job);
            } else {
                putContentDescriptor(slice.next);
                let #detached(nextCursor) = slice.next.state else {
                    Runtime.trap("Cleanup slice did not persist detached state");
                };
                Map.add(mem.cleanup_jobs, Nat64.compare, job.job_id, {
                    job with cursor = #content(nextCursor.cursor)
                });
            };
            {
                initial with
                bodies = initial.bodies + (if (finishNow) 1 else 0);
                body_bytes =
                    initial.body_bytes + slice.logical_bytes;
                charged_bytes =
                    initial.charged_bytes + slice.charged_bytes +
                    (if (finishNow) CLEANUP_JOB_CHARGE else 0);
            };
        };

        func advanceScopeRetirement(
            job : Types.CleanupJob,
            retirement : Types.ScopeRetirementCleanup,
            initial : Types.Reclaimed,
        ) : Types.Reclaimed {
            let scope = retirement.scope;
            assert (CapabilityScope.equal(job.scope, scope));
            switch (job.cursor) {
                case (#records(after)) {
                    advanceRetiredRecords(
                        job,
                        retirement,
                        after,
                        initial,
                    );
                };
                case (#stages(after)) {
                    advanceRetiredStages(job, scope, after, initial);
                };
                case (#general_receipts(after)) {
                    advanceRetiredGeneralReceipts(job, scope, after, initial);
                };
                case (#delete_receipts(after)) {
                    advanceRetiredDeleteReceipts(job, scope, after, initial);
                };
                case (#high_water(after)) {
                    advanceRetiredHighWater(
                        job,
                        retirement,
                        after,
                        initial,
                    );
                };
                case (_) Runtime.trap("Invalid scope-retirement cleanup cursor");
            };
        };

        func persistCleanupCursor(
            job : Types.CleanupJob,
            cursor : Types.CleanupCursor,
        ) : () {
            Map.add(mem.cleanup_jobs, Nat64.compare, job.job_id, {
                job with cursor
            });
        };

        // Map iterators are not stable across mutation. Retirement therefore
        // snapshots only the next bounded key page, then mutates by key.
        func boundedRetirementKeys<V>(
            source : Map.Map<Text, V>,
            prefix : Text,
            after : ?Text,
            maximum : Nat,
        ) : [Text] {
            let keys = List.empty<Text>();
            let iterator = switch (after) {
                case (?key) {
                    Map.entriesFrom(source, Text.compare, key # "\00");
                };
                case null Map.entriesFrom(source, Text.compare, prefix);
            };
            label scan for ((key, _) in iterator) {
                if (
                    not Text.startsWith(key, #text prefix) or
                    List.size(keys) >= maximum
                ) break scan;
                List.add(keys, key);
            };
            List.toArray(keys);
        };

        func retirementKeysRemain<V>(
            source : Map.Map<Text, V>,
            prefix : Text,
            after : ?Text,
        ) : Bool {
            let iterator = switch (after) {
                case (?key) {
                    Map.entriesFrom(source, Text.compare, key # "\00");
                };
                case null Map.entriesFrom(source, Text.compare, prefix);
            };
            switch (iterator.next()) {
                case (?(key, _)) Text.startsWith(key, #text prefix);
                case null false;
            };
        };

        func advanceRetiredRecords(
            job : Types.CleanupJob,
            retirement : Types.ScopeRetirementCleanup,
            after : ?Text,
            initial : Types.Reclaimed,
        ) : Types.Reclaimed {
            let scope = retirement.scope;
            let ?retiringState = Map.get(
                mem.scopes,
                Text.compare,
                CapabilityScope.key(scope),
            ) else {
                Runtime.trap("Retiring certified-assets scope disappeared");
            };
            let prefix = CapabilityScope.key(scope) # "\00record\00";
            let keys = boundedRetirementKeys(
                mem.records,
                prefix,
                after,
                MAX_MAINTENANCE_RECORDS,
            );
            var last = after;
            var records = 0;
            var bodies = 0;
            var extents = 0;
            var bytes = 0;
            var bodyCharge = 0;
            var metadataCharge = 0;
            var authenticatedNodes = 0;
            var retiredMounts = retirement.mounts;
            var partialContent = false;
            label rows for (key in keys.vals()) {
                let ?record = Map.get(mem.records, Text.compare, key) else {
                    Runtime.trap("Retired record snapshot became stale");
                };
                let ?content = Map.get(
                    mem.contents,
                    Nat64.compare,
                    record.content_id,
                ) else Runtime.trap("Retired record content missing");
                let slice = cleanupContentSlice(
                    content,
                    Nat.sub(MAX_MAINTENANCE_EXTENTS, extents),
                    Nat.sub(MAX_MAINTENANCE_BODY_BYTES, bytes),
                    Nat.sub(
                        MAX_MAINTENANCE_BODY_BYTES,
                        bodyCharge + metadataCharge,
                    ),
                );
                extents += slice.extents;
                bytes += slice.logical_bytes;
                bodyCharge += slice.charged_bytes;
                let metadataFits =
                    bodyCharge + metadataCharge +
                        record.charged_metadata_bytes <=
                        MAX_MAINTENANCE_BODY_BYTES;
                let authenticationFits =
                    authenticatedNodes +
                        record.certification_leaf_keys.size() <=
                        MAX_MAINTENANCE_AUTH_NODES;
                if (
                    not slice.complete or not metadataFits or
                    not authenticationFits
                ) {
                    putContentDescriptor(slice.next);
                    partialContent := true;
                    break rows;
                };
                var foundMount = false;
                retiredMounts := Array.map<
                    Types.RetiredForestMount,
                    Types.RetiredForestMount,
                >(
                    retiredMounts,
                    func(retiredMount) {
                        if (retiredMount.mount_id != record.mount_id) {
                            return retiredMount;
                        };
                        assert (not foundMount);
                        foundMount := true;
                        let (updated, _) = cert.applyDetachedV2(
                            retiredMount.detached,
                            [#remove({
                                leaves = leafKeys(
                                    record.certification_leaf_keys
                                )
                            })],
                        );
                        let ?mount = mountFor(
                            retiringState,
                            retiredMount.mount_id,
                        ) else {
                            Runtime.trap(
                                "Retired catalog mount disappeared"
                            );
                        };
                        let retainedMount = {
                            mount with
                            enabled = false;
                            detached_subtree = ?updated;
                        };
                        syncMountCatalog(retainedMount);
                        let ?collection = collectionFor(
                            retiringState,
                            record.collection,
                        ) else {
                            Runtime.trap(
                                "Retired catalog collection disappeared"
                            );
                        };
                        syncCollectionCatalog(collection, retainedMount);
                        {
                            retiredMount with detached = updated
                        };
                    },
                );
                assert (foundMount);
                ignore deleteContentDescriptor(record.content_id);
                ignore Map.delete(mem.records, Text.compare, key);
                switch (Map.get(
                    mem.route_index,
                    Text.compare,
                    record.canonical_path,
                )) {
                    case (?mapped) {
                        if (mapped == key) {
                            ignore Map.delete(
                                mem.route_index,
                                Text.compare,
                                record.canonical_path,
                            );
                        };
                    };
                    case null {};
                };
                records += 1;
                bodies += 1;
                metadataCharge += record.charged_metadata_bytes;
                authenticatedNodes +=
                    record.certification_leaf_keys.size();
                last := ?key;
            };
            let more = partialContent or retirementKeysRemain(
                mem.records,
                prefix,
                last,
            );
            let usage = usageFor(scope);
            setAllocatedExtentsForScope(
                scope,
                Nat.sub(allocatedExtentsForScope(scope), extents),
            );
            setUsage(scope, {
                usage with
                allocated_body_bytes =
                    Nat.sub(usage.allocated_body_bytes, bodyCharge);
                detached_charged_bytes = Nat.sub(
                    usage.detached_charged_bytes,
                    bodyCharge,
                );
                charged_metadata_bytes = Nat.sub(
                    usage.charged_metadata_bytes,
                    metadataCharge,
                );
            });
            if (more) {
                Map.add(mem.cleanup_jobs, Nat64.compare, job.job_id, {
                    job with
                    kind = #scope_retirement({
                        retirement with mounts = retiredMounts
                    });
                    cursor = #records(last);
                });
            } else {
                Map.add(mem.cleanup_jobs, Nat64.compare, job.job_id, {
                    job with
                    kind = #scope_retirement({
                        retirement with mounts = retiredMounts
                    });
                    cursor = #stages(null);
                });
            };
            {
                initial with
                records = initial.records + records;
                bodies = initial.bodies + bodies;
                body_bytes = initial.body_bytes + bytes;
                charged_bytes =
                    initial.charged_bytes + bodyCharge + metadataCharge;
                authenticated_nodes =
                    initial.authenticated_nodes + authenticatedNodes;
            };
        };

        func advanceRetiredStages(
            job : Types.CleanupJob,
            scope : Types.AppScope,
            after : ?Text,
            initial : Types.Reclaimed,
        ) : Types.Reclaimed {
            let prefix = CapabilityScope.key(scope) # "\00stage\00";
            let keys = boundedRetirementKeys(
                mem.stages,
                prefix,
                after,
                MAX_MAINTENANCE_RECORDS,
            );
            var last = after;
            var rows = 0;
            var bodies = 0;
            var extents = 0;
            var bytes = 0;
            var bodyCharge = 0;
            var metadataCharge = 0;
            var futureLanes = 0;
            var partialContent = false;
            label stages for (key in keys.vals()) {
                let ?stage = Map.get(mem.stages, Text.compare, key) else {
                    Runtime.trap("Retired stage snapshot became stale");
                };
                let active = switch (stage.lifecycle) {
                    case (#active) true;
                    case (_) false;
                };
                var contentToFree : ?Types.ContentDescriptor = null;
                if (active) {
                    let ?content = Map.get(
                        mem.contents,
                        Nat64.compare,
                        stage.content_id,
                    ) else {
                        Runtime.trap("Retired active stage content missing");
                    };
                    contentToFree := ?content;
                    removeStageIdleExpiry(stage);
                };
                switch (contentToFree) {
                    case (?content) {
                        let slice = cleanupContentSlice(
                            content,
                            Nat.sub(MAX_MAINTENANCE_EXTENTS, extents),
                            Nat.sub(MAX_MAINTENANCE_BODY_BYTES, bytes),
                            Nat.sub(
                                MAX_MAINTENANCE_BODY_BYTES,
                                bodyCharge + metadataCharge,
                            ),
                        );
                        extents += slice.extents;
                        bytes += slice.logical_bytes;
                        bodyCharge += slice.charged_bytes;
                        if (
                            not slice.complete or
                            bodyCharge + metadataCharge +
                                stage.stage_metadata_charge +
                                stage.reserved_commit_metadata_charge >
                                MAX_MAINTENANCE_BODY_BYTES
                        ) {
                            putContentDescriptor(slice.next);
                            partialContent := true;
                            break stages;
                        };
                        ignore deleteContentDescriptor(stage.content_id);
                        bodies += 1;
                    };
                    case null {
                        if (
                            metadataCharge + stage.stage_metadata_charge +
                                stage.reserved_commit_metadata_charge >
                                MAX_MAINTENANCE_BODY_BYTES
                        ) break stages;
                    };
                };
                ignore Map.delete(mem.stages, Text.compare, key);
                rows += 1;
                last := ?key;
                metadataCharge += stage.stage_metadata_charge +
                    stage.reserved_commit_metadata_charge;
                if (stage.future_batch_reserved) futureLanes += 1;
            };
            let more = partialContent or retirementKeysRemain(
                mem.stages,
                prefix,
                last,
            );
            let usage = usageFor(scope);
            setAllocatedExtentsForScope(
                scope,
                Nat.sub(allocatedExtentsForScope(scope), extents),
            );
            setUsage(scope, {
                usage with
                allocated_body_bytes =
                    Nat.sub(usage.allocated_body_bytes, bodyCharge);
                detached_charged_bytes = Nat.sub(
                    usage.detached_charged_bytes,
                    bodyCharge,
                );
                receipt_lanes = Nat.sub(usage.receipt_lanes, futureLanes);
                reserved_general_receipt_lanes = Nat.sub(
                    usage.reserved_general_receipt_lanes,
                    futureLanes,
                );
                charged_metadata_bytes = Nat.sub(
                    usage.charged_metadata_bytes,
                    metadataCharge,
                );
            });
            if (more) {
                persistCleanupCursor(job, #stages(last));
            } else {
                persistCleanupCursor(job, #general_receipts(null));
            };
            {
                initial with
                bodies = initial.bodies + bodies;
                body_bytes = initial.body_bytes + bytes;
                charged_bytes =
                    initial.charged_bytes + bodyCharge + metadataCharge;
            };
        };

        func advanceRetiredGeneralReceipts(
            job : Types.CleanupJob,
            scope : Types.AppScope,
            after : ?Text,
            initial : Types.Reclaimed,
        ) : Types.Reclaimed {
            let prefix = CapabilityScope.key(scope) # "\00receipt\00";
            let keys = boundedRetirementKeys(
                mem.general_receipts,
                prefix,
                after,
                MAX_MAINTENANCE_RECEIPTS,
            );
            var last = after;
            var rows = 0;
            var expiryRows = 0;
            var metadataCharge = 0;
            for (key in keys.vals()) {
                let ?receipt = Map.get(
                    mem.general_receipts,
                    Text.compare,
                    key,
                ) else {
                    Runtime.trap(
                        "Retired general-receipt snapshot became stale"
                    );
                };
                switch (receipt.expires_at_ns) {
                    case (?expiry) {
                        ignore Map.delete(mem.expiry_index, Text.compare, expiryKey(
                            scope,
                            expiry,
                            "g:" # key,
                        ));
                        expiryRows += 1;
                    };
                    case null {};
                };
                switch (receipt.state) {
                    case (#batch(_)) metadataCharge += GENERAL_RECEIPT_CHARGE;
                    case (#stage(_)) {};
                };
                ignore Map.delete(mem.general_receipts, Text.compare, key);
                rows += 1;
                last := ?key;
            };
            let more = retirementKeysRemain(
                mem.general_receipts,
                prefix,
                last,
            );
            let usage = usageFor(scope);
            setUsage(scope, {
                usage with
                receipt_lanes = Nat.sub(usage.receipt_lanes, rows);
                general_receipt_lanes =
                    Nat.sub(usage.general_receipt_lanes, rows);
                receipt_nonce_indexes =
                    Nat.sub(usage.receipt_nonce_indexes, rows);
                receipt_expiry_indexes =
                    Nat.sub(usage.receipt_expiry_indexes, expiryRows);
                charged_metadata_bytes = Nat.sub(
                    usage.charged_metadata_bytes,
                    metadataCharge,
                );
            });
            if (more) {
                persistCleanupCursor(job, #general_receipts(last));
            } else {
                persistCleanupCursor(job, #delete_receipts(null));
            };
            {
                initial with
                receipts = initial.receipts + rows;
                charged_bytes = initial.charged_bytes + metadataCharge;
            };
        };

        func advanceRetiredDeleteReceipts(
            job : Types.CleanupJob,
            scope : Types.AppScope,
            after : ?Text,
            initial : Types.Reclaimed,
        ) : Types.Reclaimed {
            let prefix = CapabilityScope.key(scope) # "\00record\00";
            let keys = boundedRetirementKeys(
                mem.delete_receipt_lanes,
                prefix,
                after,
                MAX_MAINTENANCE_RECEIPTS,
            );
            var last = after;
            var rows = 0;
            var reserved = 0;
            var filled = 0;
            var nonceRows = 0;
            var expiryRows = 0;
            var occupiedRows = 0;
            for (key in keys.vals()) {
                let ?lane = Map.get(
                    mem.delete_receipt_lanes,
                    Text.compare,
                    key,
                ) else {
                    Runtime.trap(
                        "Retired delete-receipt snapshot became stale"
                    );
                };
                switch (lane.filled) {
                    case (?value) {
                        filled += 1;
                        nonceRows += 1;
                        expiryRows += 1;
                        ignore Map.delete(mem.expiry_index, Text.compare, expiryKey(
                            scope,
                            value.expires_at_ns,
                            "r:" # key,
                        ));
                        let nonceKey = deleteNonceKey(scope, value.nonce);
                        switch (Map.get(
                            mem.delete_nonce_index,
                            Text.compare,
                            nonceKey,
                        )) {
                            case (?mapped) {
                                if (mapped == key) {
                                    ignore Map.delete(
                                        mem.delete_nonce_index,
                                        Text.compare,
                                        nonceKey,
                                    );
                                };
                            };
                            case null {};
                        };
                    };
                    case null reserved += 1;
                };
                if (
                    Map.get(mem.revision_high_water, Text.compare, key) == null
                ) occupiedRows += 1;
                ignore Map.delete(mem.delete_receipt_lanes, Text.compare, key);
                rows += 1;
                last := ?key;
            };
            let more = retirementKeysRemain(
                mem.delete_receipt_lanes,
                prefix,
                last,
            );
            let metadataCharge = rows * DELETE_RECEIPT_LANE_CHARGE;
            let usage = usageFor(scope);
            setUsage(scope, {
                usage with
                occupied_entry_slots =
                    Nat.sub(usage.occupied_entry_slots, occupiedRows);
                receipt_lanes = Nat.sub(usage.receipt_lanes, rows);
                reserved_revocation_lanes =
                    Nat.sub(usage.reserved_revocation_lanes, reserved);
                filled_revocation_lanes =
                    Nat.sub(usage.filled_revocation_lanes, filled);
                receipt_nonce_indexes =
                    Nat.sub(usage.receipt_nonce_indexes, nonceRows);
                receipt_expiry_indexes =
                    Nat.sub(usage.receipt_expiry_indexes, expiryRows);
                charged_metadata_bytes = Nat.sub(
                    usage.charged_metadata_bytes,
                    metadataCharge,
                );
            });
            if (more) {
                persistCleanupCursor(job, #delete_receipts(last));
            } else {
                persistCleanupCursor(job, #high_water(null));
            };
            {
                initial with
                receipts = initial.receipts + rows;
                charged_bytes = initial.charged_bytes + metadataCharge;
            };
        };

        func advanceRetiredHighWater(
            job : Types.CleanupJob,
            retirement : Types.ScopeRetirementCleanup,
            after : ?Text,
            initial : Types.Reclaimed,
        ) : Types.Reclaimed {
            let scope = retirement.scope;
            let prefix = CapabilityScope.key(scope) # "\00record\00";
            let keys = boundedRetirementKeys(
                mem.revision_high_water,
                prefix,
                after,
                MAX_MAINTENANCE_RECORDS,
            );
            var last = after;
            var rows = 0;
            for (key in keys.vals()) {
                if (
                    Map.get(
                        mem.revision_high_water,
                        Text.compare,
                        key,
                    ) == null
                ) {
                    Runtime.trap(
                        "Retired high-water snapshot became stale"
                    );
                };
                ignore Map.delete(mem.revision_high_water, Text.compare, key);
                rows += 1;
                last := ?key;
            };
            let more = retirementKeysRemain(
                mem.revision_high_water,
                prefix,
                last,
            );
            let metadataCharge = rows * HIGH_WATER_CHARGE;
            let usage = usageFor(scope);
            setUsage(scope, {
                usage with
                occupied_entry_slots =
                    Nat.sub(usage.occupied_entry_slots, rows);
                charged_metadata_bytes = Nat.sub(
                    usage.charged_metadata_bytes,
                    metadataCharge,
                );
            });
            if (more) {
                persistCleanupCursor(job, #high_water(last));
            } else {
                finishRetiredScope(job, retirement);
            };
            {
                initial with
                charged_bytes = initial.charged_bytes + metadataCharge +
                    (
                        if (more) 0 else {
                            CLEANUP_JOB_CHARGE +
                            retainedForestCharge(retirement.mounts.size())
                        }
                    );
            };
        };

        // Returns the number of actual receipt/carrier rows reclaimed. Stale
        // ordered-expiry rows are harmless and report zero.
        func processExpiry(entry : Types.ExpiryEntry) : Nat {
            switch (entry.kind) {
                case (#stage_idle(stageId)) {
                    switch (Map.get(
                        mem.stages,
                        Text.compare,
                        stageKey(entry.scope, stageId),
                    )) {
                        case (?stage) {
                            if (
                                stage.lifecycle == #active and
                                stage.expires_at_ns == entry.expires_at_ns
                            ) {
                                ignore expireStage(stage);
                            };
                        };
                        case null {};
                    };
                    0;
                };
                case (#general_receipt(key)) {
                    switch (Map.get(mem.general_receipts, Text.compare, key)) {
                        case (?receipt) {
                            if (receipt.expires_at_ns == ?entry.expires_at_ns) {
                                var metadataCharge = 0;
                                var activeStages = 0;
                                var acceptedBytes = 0;
                                var reservedBytes = 0;
                                var reservedEntries = 0;
                                var reservedCommitted = 0;
                                var futureLanes = 0;
                                ignore Map.delete(
                                    mem.general_receipts,
                                    Text.compare,
                                    key,
                                );
                                switch (receipt.state) {
                                    case (#stage(stageId)) {
                                        let stageMapKey = stageKey(
                                            entry.scope,
                                            stageId,
                                        );
                                        switch (Map.get(
                                            mem.stages,
                                            Text.compare,
                                            stageMapKey,
                                        )) {
                                            case (?stage) {
                                                metadataCharge +=
                                                    stage.stage_metadata_charge +
                                                    stage.reserved_commit_metadata_charge;
                                                reservedEntries +=
                                                    stage.reserved_entry_slots;
                                                reservedCommitted +=
                                                    stage.reserved_committed_body_bytes;
                                                if (stage.future_batch_reserved) {
                                                    futureLanes += 1;
                                                };
                                                switch (stage.lifecycle) {
                                                    case (#active) {
                                                        activeStages += 1;
                                                        acceptedBytes +=
                                                            stageAcceptedBytes(
                                                                stage
                                                            );
                                                        reservedBytes +=
                                                            geometryExpectedBytes(
                                                                stage.geometry
                                                            ) -
                                                            stageAcceptedBytes(
                                                                stage
                                                            );
                                                    };
                                                    case (_) {};
                                                };
                                                ignore Map.delete(
                                                    mem.stages,
                                                    Text.compare,
                                                    stageMapKey,
                                                );
                                            };
                                            case null {};
                                        };
                                    };
                                    case (#batch(_)) {
                                        metadataCharge += GENERAL_RECEIPT_CHARGE;
                                    };
                                };
                                let usage = usageFor(entry.scope);
                                setUsage(entry.scope, {
                                    usage with
                                    active_stages =
                                        Nat.sub(usage.active_stages, activeStages);
                                    accepted_staged_bytes = Nat.sub(
                                        usage.accepted_staged_bytes,
                                        acceptedBytes,
                                    );
                                    reserved_staged_bytes = Nat.sub(
                                        usage.reserved_staged_bytes,
                                        reservedBytes,
                                    );
                                    reserved_entry_slots = Nat.sub(
                                        usage.reserved_entry_slots,
                                        reservedEntries,
                                    );
                                    reserved_committed_body_bytes = Nat.sub(
                                        usage.reserved_committed_body_bytes,
                                        reservedCommitted,
                                    );
                                    receipt_lanes = Nat.sub(
                                        usage.receipt_lanes,
                                        1 + futureLanes,
                                    );
                                    general_receipt_lanes =
                                        Nat.sub(usage.general_receipt_lanes, 1);
                                    reserved_general_receipt_lanes = Nat.sub(
                                        usage.reserved_general_receipt_lanes,
                                        futureLanes,
                                    );
                                    receipt_nonce_indexes =
                                        Nat.sub(usage.receipt_nonce_indexes, 1);
                                    receipt_expiry_indexes =
                                        Nat.sub(usage.receipt_expiry_indexes, 1);
                                    charged_metadata_bytes = Nat.sub(
                                        usage.charged_metadata_bytes,
                                        metadataCharge,
                                    );
                                });
                                return 1;
                            };
                        };
                        case null {};
                    };
                    0;
                };
                case (#delete_receipt(key)) {
                    switch (Map.get(mem.delete_receipt_lanes, Text.compare, key)) {
                        case (?lane) switch (lane.filled) {
                            case (?filled) {
                                if (filled.expires_at_ns == entry.expires_at_ns) {
                                    ignore Map.delete(
                                        mem.delete_receipt_lanes,
                                        Text.compare,
                                        key,
                                    );
                                    let nonceKey = deleteNonceKey(
                                        entry.scope,
                                        filled.nonce,
                                    );
                                    switch (Map.get(
                                        mem.delete_nonce_index,
                                        Text.compare,
                                        nonceKey,
                                    )) {
                                        case (?mapped) {
                                            if (mapped == key) {
                                                ignore Map.delete(
                                                    mem.delete_nonce_index,
                                                    Text.compare,
                                                    nonceKey,
                                                );
                                            };
                                        };
                                        case null {};
                                    };
                                    let mutableHighWater = Map.get(
                                        mem.revision_high_water,
                                        Text.compare,
                                        key,
                                    ) != null;
                                    let usage = usageFor(entry.scope);
                                    setUsage(entry.scope, {
                                        usage with
                                        occupied_entry_slots = if (mutableHighWater) {
                                            usage.occupied_entry_slots;
                                        } else Nat.sub(
                                            usage.occupied_entry_slots,
                                            1,
                                        );
                                        receipt_lanes =
                                            Nat.sub(usage.receipt_lanes, 1);
                                        filled_revocation_lanes =
                                            Nat.sub(
                                                usage.filled_revocation_lanes,
                                                1,
                                            );
                                        receipt_nonce_indexes =
                                            Nat.sub(
                                                usage.receipt_nonce_indexes,
                                                1,
                                            );
                                        receipt_expiry_indexes =
                                            Nat.sub(
                                                usage.receipt_expiry_indexes,
                                                1,
                                            );
                                        charged_metadata_bytes = Nat.sub(
                                            usage.charged_metadata_bytes,
                                            DELETE_RECEIPT_LANE_CHARGE,
                                        );
                                    });
                                    return 1;
                                };
                            };
                            case null {};
                        };
                        case null {};
                    };
                    0;
                };
            };
        };

        // -----------------------------------------------------------------
        // Indexed state, identity, accounting, and bounded utility helpers
        // -----------------------------------------------------------------

        func activeCommittedScope(
            scope : Types.AppScope,
        ) : ?Types.ScopeState {
            if (
                not deploymentCommitted() or not scopeActive(scope)
            ) return null;
            let ?state = Map.get(
                mem.scopes,
                Text.compare,
                CapabilityScope.key(scope),
            ) else return null;
            if (
                not state.committed or state.retiring or
                not CapabilityScope.equal(state.scope, scope)
            ) return null;
            ?state;
        };

        func currentScope(scope : Types.AppScope) : ?Types.ScopeState {
            let ?state = activeCommittedScope(scope) else return null;
            if (not registry.allowed(scope, #certified_assets, "default")) {
                return null;
            };
            ?state;
        };

        func scopeInfoValue(state : Types.ScopeState) : Types.ScopeInfo {
            {
                installation_generation = state.installation_generation;
                store_authority_epoch = state.store_authority_epoch;
                collections = Array.map<Types.CollectionPlan, Types.CollectionInfo>(
                    state.collections,
                    func(collection) {
                        let effective = {
                            state.effective_limits with
                            object_bytes = Nat.min(
                                state.effective_limits.object_bytes,
                                collection.max_object_bytes,
                            );
                        };
                        let manifest = {
                            state.manifest_limits with
                            object_bytes = Nat.min(
                                state.manifest_limits.object_bytes,
                                collection.max_object_bytes,
                            );
                        };
                        {
                            id = collection.id;
                            kind = collection.kind;
                            authority_epoch = collection.authority_epoch;
                            generation = collection.generation;
                            serving = collection.serving;
                            writes = collection.writes;
                            manifest_limits = manifest;
                            effective_limits = effective;
                        };
                    },
                );
            };
        };

        func collectionFor(
            state : Types.ScopeState,
            id : Text,
        ) : ?Types.CollectionPlan {
            for (collection in state.collections.vals()) {
                if (collection.id == id) return ?collection;
            };
            null;
        };

        func mountFor(
            state : Types.ScopeState,
            id : Text,
        ) : ?Types.CommittedMount {
            for (mount in state.mounts.vals()) {
                if (mount.id == id) return ?mount;
            };
            null;
        };

        func mountById(
            mounts : [Types.CommittedMount],
            id : Text,
        ) : ?Types.CommittedMount {
            for (mount in mounts.vals()) if (mount.id == id) return ?mount;
            null;
        };

        func updateScopeMount(mount : Types.CommittedMount) : () {
            let key = CapabilityScope.key(mount.scope);
            let ?state = Map.get(mem.scopes, Text.compare, key) else {
                Runtime.trap("Certified-assets mount scope missing");
            };
            let mounts = Array.map<Types.CommittedMount, Types.CommittedMount>(
                state.mounts,
                func(current) {
                    if (current.id == mount.id) mount else current;
                },
            );
            Map.add(mem.scopes, Text.compare, key, { state with mounts });
        };

        func stageAuthorityCurrent(
            state : Types.ScopeState,
            collection : Types.CollectionPlan,
            mount : Types.CommittedMount,
            stage : Types.StageRecord,
        ) : Bool {
            stage.store_authority_epoch == state.store_authority_epoch and
            stage.mount_authority_epoch == mount.authority_epoch and
            stage.collection_authority_epoch == collection.authority_epoch;
        };

        func allocateAuthorityEpoch(current : Nat64) : Nat64 {
            if (current == NAT64_MAX) {
                Runtime.trap("Certified-assets authority epoch exhausted");
            };
            let candidate = Nat64.max(mem.next_authority_epoch, current + 1);
            if (candidate == NAT64_MAX) {
                Runtime.trap("Certified-assets authority epoch exhausted");
            };
            mem.next_authority_epoch := candidate + 1;
            candidate;
        };

        func locatorValid(
            collection : Types.CollectionPlan,
            locator : Types.Locator,
        ) : Bool {
            switch (collection.kind, locator) {
                case (#publication, #publication(value)) {
                    value.publication_id.size() == 32 and
                    Paths.validFilename(value.filename);
                };
                case (#immutable_blob, #body_sha256(value)) {
                    value.digest.size() == 32;
                };
                case (#mutable_blob, #key32(value)) {
                    collection.path_prefix != null and
                    collection.exact_path == null and value.key.size() == 32;
                };
                case (#mutable_blob, #exact_path) {
                    collection.path_prefix == null and
                    collection.exact_path != null;
                };
                case (_) false;
            };
        };

        func recordIdentity(record : Types.AssetRecord) : Types.RecordIdentity {
            {
                target = record.target;
                kernel_revision = record.kernel_revision;
                content_tag = record.content_tag;
                body_bytes = record.body_bytes;
                geometry = record.geometry;
                block_hashes = record.block_hashes;
            };
        };

        func casIdentity(record : Types.AssetRecord) : Types.CasIdentity {
            {
                collection_generation = record.collection_generation;
                kernel_revision = record.kernel_revision;
                content_tag = record.content_tag;
                body_bytes = record.body_bytes;
            };
        };

        func emptyUsage() : Types.UsageCounters {
            {
                live_entries = 0;
                occupied_entry_slots = 0;
                committed_body_bytes = 0;
                reserved_committed_body_bytes = 0;
                allocated_body_bytes = 0;
                charged_metadata_bytes = 0;
                accepted_staged_bytes = 0;
                reserved_staged_bytes = 0;
                detached_charged_bytes = 0;
                active_stages = 0;
                reserved_entry_slots = 0;
                receipt_lanes = 0;
                general_receipt_lanes = 0;
                reserved_general_receipt_lanes = 0;
                reserved_revocation_lanes = 0;
                filled_revocation_lanes = 0;
                receipt_nonce_indexes = 0;
                receipt_expiry_indexes = 0;
                cleanup_jobs = 0;
            };
        };

        func usageFor(scope : Types.AppScope) : Types.UsageCounters {
            switch (Map.get(
                mem.usage_by_scope,
                Text.compare,
                CapabilityScope.key(scope),
            )) {
                case (?usage) usage;
                case null emptyUsage();
            };
        };

        func allocatedExtentsForScope(scope : Types.AppScope) : Nat {
            switch (Map.get(
                mem.allocated_extents_by_scope,
                Text.compare,
                CapabilityScope.key(scope),
            )) {
                case (?count) count;
                case null 0;
            };
        };

        func setAllocatedExtentsForScope(
            scope : Types.AppScope,
            next : Nat,
        ) : () {
            let prior = allocatedExtentsForScope(scope);
            switch (Map.get(
                mem.scopes,
                Text.compare,
                CapabilityScope.key(scope),
            )) {
                case (?state) {
                    if (state.reservation_active) {
                        if (
                            prior >
                                state.installed_arena_extent_reservation or
                            next >
                                state.installed_arena_extent_reservation
                        ) {
                            Runtime.trap(
                                "Certified-assets scope exceeded installed arena extent reservation"
                            );
                        };
                        mem.global_reserved_arena_extent_headroom :=
                            replaceGlobalCounter(
                                mem.global_reserved_arena_extent_headroom,
                                state.installed_arena_extent_reservation -
                                    prior,
                                state.installed_arena_extent_reservation -
                                    next,
                            );
                    };
                };
                case null {};
            };
            if (next == 0) {
                ignore Map.delete(
                    mem.allocated_extents_by_scope,
                    Text.compare,
                    CapabilityScope.key(scope),
                );
            } else {
                Map.add(
                    mem.allocated_extents_by_scope,
                    Text.compare,
                    CapabilityScope.key(scope),
                    next,
                );
            };
            assert (
                2 * (
                    mem.arena.allocated_extents +
                    mem.global_reserved_arena_extent_headroom
                ) + 1 <= Allocator.MAX_ARENA_EXTENTS_V3
            );
        };

        func setUsage(scope : Types.AppScope, usage : Types.UsageCounters) : () {
            let prior = usageFor(scope);
            let priorCharge =
                prior.allocated_body_bytes + prior.charged_metadata_bytes;
            let nextCharge =
                usage.allocated_body_bytes + usage.charged_metadata_bytes;
            switch (Map.get(
                mem.scopes,
                Text.compare,
                CapabilityScope.key(scope),
            )) {
                case (?state) {
                    if (state.reservation_active) {
                        if (
                            priorCharge > state.installed_charged_reservation or
                            nextCharge > state.installed_charged_reservation or
                            prior.allocated_body_bytes >
                                state.installed_arena_reservation or
                            usage.allocated_body_bytes >
                                state.installed_arena_reservation
                        ) {
                            Runtime.trap(
                                "Certified-assets scope exceeded installed charged reservation"
                            );
                        };
                        mem.global_reserved_charged_headroom :=
                            replaceGlobalCounter(
                                mem.global_reserved_charged_headroom,
                                state.installed_charged_reservation - priorCharge,
                                state.installed_charged_reservation - nextCharge,
                            );
                        mem.global_reserved_arena_headroom :=
                            replaceGlobalCounter(
                                mem.global_reserved_arena_headroom,
                                state.installed_arena_reservation -
                                    prior.allocated_body_bytes,
                                state.installed_arena_reservation -
                                    usage.allocated_body_bytes,
                            );
                    };
                };
                case null {};
            };
            mem.total_charged_bytes := replaceGlobalCounter(
                mem.total_charged_bytes,
                priorCharge,
                nextCharge,
            );
            mem.global_active_stages := replaceGlobalCounter(
                mem.global_active_stages,
                prior.active_stages,
                usage.active_stages,
            );
            mem.global_cleanup_jobs := replaceGlobalCounter(
                mem.global_cleanup_jobs,
                prior.cleanup_jobs,
                usage.cleanup_jobs,
            );
            assert (
                mem.total_charged_bytes +
                    mem.global_reserved_charged_headroom +
                    Allocator.ARENA_METADATA_RESERVE_V3 <=
                    GLOBAL_CHARGED_BYTES_MAX_V3
            );
            assert (
                Nat64.toNat(mem.arena.allocated_bytes) +
                    mem.global_reserved_arena_headroom <=
                    Nat64.toNat(
                        Allocator.ARENA_ALLOCATABLE_CAPACITY_MAX_V3
                    )
            );
            assert (
                mem.global_active_stages <=
                    MAX_GLOBAL_ACTIVE_STAGES
            );
            assert (
                mem.global_cleanup_jobs + mem.global_active_stages <=
                    MAX_GLOBAL_CLEANUP_JOBS
            );
            Map.add(
                mem.usage_by_scope,
                Text.compare,
                CapabilityScope.key(scope),
                usage,
            );
        };

        func replaceGlobalCounter(
            total : Nat,
            prior : Nat,
            next : Nat,
        ) : Nat {
            if (next >= prior) {
                total + (next - prior);
            } else {
                let decrease = prior - next;
                if (decrease > total) {
                    Runtime.trap("Certified-assets global usage counter underflow");
                };
                total - decrease;
            };
        };

        func globalActiveStages() : Nat {
            mem.global_active_stages;
        };

        func finish<T>(
            scope : Types.AppScope,
            operation : Text,
            result : { #ok : T; #err : Types.Error },
        ) : { #ok : T; #err : Types.Error } {
            ignore registry.record(
                scope,
                #certified_assets,
                "default",
                operation,
                switch (result) {
                    case (#ok(_)) #ok;
                    case (#err(#busy)) #busy;
                    case (#err(_)) #denied;
                },
            );
            result;
        };

        func finishSimple(
            scope : Types.AppScope,
            operation : Text,
            result : Types.Result,
        ) : Types.Result {
            ignore registry.record(
                scope,
                #certified_assets,
                "default",
                operation,
                switch (result) {
                    case (#ok) #ok;
                    case (#err(#busy)) #busy;
                    case (#err(_)) #denied;
                },
            );
            result;
        };

        func nowNs() : Nat64 {
            clockNs();
        };

        func checkedTimeAdd(left : Nat64, right : Nat64) : Nat64 {
            if (left > NAT64_MAX - right) NAT64_MAX else left + right;
        };

        func stageKey(scope : Types.AppScope, stageId : Nat64) : Text {
            CapabilityScope.key(scope) # "\00stage\00" # Nat64.toText(stageId);
        };

        func mountKey(scope : Types.AppScope, mountId : Text) : Text {
            CapabilityScope.key(scope) # "\00mount\00" # mountId;
        };

        func collectionCatalogKey(
            scope : Types.AppScope,
            collectionId : Text,
        ) : Text {
            CapabilityScope.key(scope) # "\00collection\00" # collectionId;
        };

        func collectionCatalogLocation(
            collection : Types.CollectionPlan,
            mount : Types.CommittedMount,
        ) : (Text, Bool) {
            switch (collection.kind) {
                case (#publication) (mount.prefix, false);
                case (#immutable_blob) {
                    let ?path = collection.path_prefix else {
                        Runtime.trap(
                            "Immutable collection catalog lacks path prefix"
                        );
                    };
                    let ?withoutSlash = Text.stripEnd(path, #char '/') else {
                        Runtime.trap(
                            "Immutable collection catalog prefix lacks trailing slash"
                        );
                    };
                    (mount.prefix # withoutSlash, false);
                };
                case (#mutable_blob) {
                    switch (collection.path_prefix, collection.exact_path) {
                        case (?path, null) {
                            let ?withoutSlash =
                                Text.stripEnd(path, #char '/') else {
                                    Runtime.trap(
                                        "Mutable collection catalog prefix lacks trailing slash"
                                    );
                                };
                            (mount.prefix # withoutSlash, false);
                        };
                        case (null, ?path) {
                            (mount.prefix # path, true);
                        };
                        case (_) {
                            Runtime.trap(
                                "Mutable collection catalog lacks one path policy"
                            );
                        };
                    };
                };
            };
        };

        func bumpCatalogMetadataMutationEpoch() : () {
            if (mem.catalog_metadata_mutation_epoch == NAT64_MAX) {
                Runtime.trap(
                    "Certified-assets catalog metadata epoch exhausted"
                );
            };
            mem.catalog_metadata_mutation_epoch += 1;
        };

        func syncMountCatalog(mount : Types.CommittedMount) : () {
            cert.syncV2MountCatalog(
                mountKey(mount.scope, mount.id),
                mount.prefix,
                mount.detached_subtree,
            );
            bumpCatalogMetadataMutationEpoch();
        };

        func syncCollectionCatalog(
            collection : Types.CollectionPlan,
            mount : Types.CommittedMount,
        ) : () {
            let (path, exact) =
                collectionCatalogLocation(collection, mount);
            cert.syncV2CollectionCatalog(
                collectionCatalogKey(mount.scope, collection.id),
                path,
                exact,
                mount.detached_subtree,
            );
            bumpCatalogMetadataMutationEpoch();
        };

        func syncScopeCatalogs(state : Types.ScopeState) : () {
            for (mount in state.mounts.vals()) syncMountCatalog(mount);
            for (collection in state.collections.vals()) {
                let ?mount = mountFor(state, collection.mount) else {
                    Runtime.trap(
                        "Certified-assets collection catalog mount missing"
                    );
                };
                syncCollectionCatalog(collection, mount);
            };
        };

        func removeScopeCatalogs(state : Types.ScopeState) : () {
            for (collection in state.collections.vals()) {
                cert.removeV2CollectionCatalog(
                    collectionCatalogKey(state.scope, collection.id)
                );
                bumpCatalogMetadataMutationEpoch();
            };
            for (mount in state.mounts.vals()) {
                cert.removeV2MountCatalog(
                    mountKey(state.scope, mount.id)
                );
                bumpCatalogMetadataMutationEpoch();
            };
        };

        func recordKey(scope : Types.AppScope, target : Types.Target) : Text {
            CapabilityScope.key(scope) # "\00record\00" # Codec.targetKey(target);
        };

        func generalReceiptKey(
            scope : Types.AppScope,
            domain : { #begin_stage; #positive_batch },
            nonce : Blob,
        ) : Text {
            CapabilityScope.key(scope) # "\00receipt\00" # (
                switch (domain) {
                    case (#begin_stage) "stage";
                    case (#positive_batch) "batch";
                }
            ) # "\00" # Codec.hex(nonce);
        };

        func deleteNonceKey(scope : Types.AppScope, nonce : Blob) : Text {
            CapabilityScope.key(scope) # "\00delete\00" # Codec.hex(nonce);
        };

        func expiryKey(
            scope : Types.AppScope,
            expiry : Nat64,
            suffix : Text,
        ) : Text {
            CapabilityScope.key(scope) # "\00" # Codec.hex(Codec.u64be(expiry)) #
            "\00" # suffix;
        };

        func cleanupScopeKey(scope : Types.AppScope, jobId : Nat64) : Text {
            CapabilityScope.key(scope) # "\00" #
            Codec.hex(Codec.u64be(jobId));
        };

        func addStageIdleExpiry(stage : Types.StageRecord) : () {
            Map.add(mem.expiry_index, Text.compare, expiryKey(
                stage.scope,
                stage.expires_at_ns,
                "s:" # Nat64.toText(stage.stage_id),
            ), {
                scope = stage.scope;
                expires_at_ns = stage.expires_at_ns;
                kind = #stage_idle(stage.stage_id);
            });
        };

        func removeStageIdleExpiry(stage : Types.StageRecord) : () {
            ignore Map.delete(mem.expiry_index, Text.compare, expiryKey(
                stage.scope,
                stage.expires_at_ns,
                "s:" # Nat64.toText(stage.stage_id),
            ));
        };

        func cleanupCount(scope : Types.AppScope) : Nat {
            usageFor(scope).cleanup_jobs;
        };

        func hasDueExpiry(scope : Types.AppScope, now : Nat64) : Bool {
            let prefix = CapabilityScope.key(scope) # "\00";
            let next = Map.entriesFrom(
                mem.expiry_index,
                Text.compare,
                prefix,
            ).next();
            switch (next) {
                case (?(key, entry)) {
                    Text.startsWith(key, #text prefix) and
                    entry.expires_at_ns <= now;
                };
                case null false;
            };
        };

        func textMapHasPrefix<V>(
            source : Map.Map<Text, V>,
            prefix : Text,
        ) : Bool {
            switch (Map.entriesFrom(source, Text.compare, prefix).next()) {
                case (?(key, _)) Text.startsWith(key, #text prefix);
                case null false;
            };
        };

        func usageCountersEmpty(usage : Types.UsageCounters) : Bool {
            usage.live_entries == 0 and
            usage.occupied_entry_slots == 0 and
            usage.committed_body_bytes == 0 and
            usage.reserved_committed_body_bytes == 0 and
            usage.allocated_body_bytes == 0 and
            usage.charged_metadata_bytes == 0 and
            usage.accepted_staged_bytes == 0 and
            usage.reserved_staged_bytes == 0 and
            usage.detached_charged_bytes == 0 and
            usage.active_stages == 0 and
            usage.reserved_entry_slots == 0 and
            usage.receipt_lanes == 0 and
            usage.general_receipt_lanes == 0 and
            usage.reserved_general_receipt_lanes == 0 and
            usage.reserved_revocation_lanes == 0 and
            usage.filled_revocation_lanes == 0 and
            usage.receipt_nonce_indexes == 0 and
            usage.receipt_expiry_indexes == 0 and
            usage.cleanup_jobs == 0;
        };

        func finishRetiredScope(
            job : Types.CleanupJob,
            retirement : Types.ScopeRetirementCleanup,
        ) : () {
            let scope = retirement.scope;
            assert (CapabilityScope.equal(scope, job.scope));
            let scopeKey = CapabilityScope.key(scope);
            let scopedPrefix = scopeKey # "\00";
            let recordPrefix = scopedPrefix # "record\00";
            let stagePrefix = scopedPrefix # "stage\00";
            let receiptPrefix = scopedPrefix # "receipt\00";
            let mountPrefix = scopedPrefix # "mount\00";
            assert (not textMapHasPrefix(mem.records, recordPrefix));
            assert (not textMapHasPrefix(mem.stages, stagePrefix));
            assert (not textMapHasPrefix(mem.general_receipts, receiptPrefix));
            assert (
                not textMapHasPrefix(mem.delete_receipt_lanes, recordPrefix)
            );
            assert (not textMapHasPrefix(mem.revision_high_water, recordPrefix));
            assert (not textMapHasPrefix(mem.delete_nonce_index, scopedPrefix));
            assert (not textMapHasPrefix(mem.expiry_index, scopedPrefix));
            assert (not textMapHasPrefix(mem.mounts, mountPrefix));
            let before = usageFor(scope);
            assert (before.cleanup_jobs == 1);
            let ?state = Map.get(mem.scopes, Text.compare, scopeKey) else {
                Runtime.trap("Retired certified-assets scope disappeared");
            };
            removeScopeCatalogs(state);
            for (mount in retirement.mounts.vals()) {
                assert (cert.discardDetachedV2(mount.detached));
            };
            let retainedCharge = retainedForestCharge(state.mounts.size());
            assert (before.charged_metadata_bytes >= retainedCharge);
            setUsage(scope, {
                before with
                charged_metadata_bytes =
                    before.charged_metadata_bytes - retainedCharge;
            });
            finishCleanupJob(job);
            assert (
                not textMapHasPrefix(
                    mem.cleanup_jobs_by_scope,
                    scopedPrefix,
                )
            );
            let after = usageFor(scope);
            assert (usageCountersEmpty(after));
            assert (allocatedExtentsForScope(scope) == 0);
            assert (
                state.retiring and not state.committed and
                CapabilityScope.equal(state.scope, scope)
            );
            // A reinstall may already own the app-id secondary mapping. Never
            // delete a mapping unless it still names this retired generation.
            switch (Map.get(mem.scopes_by_app, Text.compare, scope.app_id)) {
                case (?indexed) {
                    assert (not CapabilityScope.equal(indexed, scope));
                };
                case null {};
            };
            ignore Map.delete(mem.usage_by_scope, Text.compare, scopeKey);
            ignore Map.delete(
                mem.allocated_extents_by_scope,
                Text.compare,
                scopeKey,
            );
            ignore Map.delete(mem.scopes, Text.compare, scopeKey);
        };

        func finishCleanupJob(job : Types.CleanupJob) : () {
            ignore Map.delete(mem.cleanup_jobs, Nat64.compare, job.job_id);
            ignore Map.delete(
                mem.cleanup_jobs_by_scope,
                Text.compare,
                cleanupScopeKey(job.scope, job.job_id),
            );
            switch (job.kind) {
                case (#content(_)) {};
                case (#scope_retirement(_)) {
                    let key = CapabilityScope.key(job.scope);
                    assert (
                        Map.get(
                            mem.scope_retirement_job_by_scope,
                            Text.compare,
                            key,
                        ) == ?job.job_id
                    );
                    ignore Map.delete(
                        mem.scope_retirement_job_by_scope,
                        Text.compare,
                        key,
                    );
                };
            };
            let usage = usageFor(job.scope);
            setUsage(job.scope, {
                usage with
                cleanup_jobs = usage.cleanup_jobs - 1;
                charged_metadata_bytes = Nat.sub(
                    usage.charged_metadata_bytes,
                    Nat.min(usage.charged_metadata_bytes, CLEANUP_JOB_CHARGE),
                );
            });
        };

        func contentExtentOwner(
            contentId : Nat64,
            slot : Types.ContentExtentSlot,
            extent : Types.ExtentRef,
        ) : Types.ContentExtentOwner {
            { content_id = contentId; slot; extent };
        };

        func bumpContentExtentMutationEpoch() : () {
            if (mem.content_extent_mutation_epoch == NAT64_MAX) {
                Runtime.trap("Certified-assets content ownership epoch exhausted");
            };
            mem.content_extent_mutation_epoch += 1;
        };

        // This epoch covers both sides of the content/extent crosswalk.  In
        // particular, zero-byte contents have no owner row, so descriptor-only
        // churn must still invalidate a caller-held audit cursor.
        func putContentDescriptor(content : Types.ContentDescriptor) : () {
            Map.add(
                mem.contents,
                Nat64.compare,
                content.content_id,
                content,
            );
            bumpContentExtentMutationEpoch();
        };

        func deleteContentDescriptor(contentId : Nat64) : Bool {
            let removed = Map.delete(mem.contents, Nat64.compare, contentId);
            if (removed) bumpContentExtentMutationEpoch();
            removed;
        };

        func registerContentExtent(
            contentId : Nat64,
            slot : Types.ContentExtentSlot,
            extent : Types.ExtentRef,
        ) : () {
            if (not Allocator.hasExactOwnership(mem.arena, extent)) {
                Runtime.trap("Certified-assets extent is not allocator-owned");
            };
            if (
                Map.get(
                    mem.content_extent_owners,
                    Nat64.compare,
                    extent.arena_offset,
                ) != null
            ) {
                Runtime.trap("Certified-assets extent has duplicate content ownership");
            };
            Map.add(
                mem.content_extent_owners,
                Nat64.compare,
                extent.arena_offset,
                contentExtentOwner(contentId, slot, extent),
            );
            bumpContentExtentMutationEpoch();
        };

        func registerContentExtents(content : Types.ContentDescriptor) : () {
            switch (content.storage) {
                case (#per_block_extents(values)) {
                    var index = 0;
                    for (value in values.vals()) {
                        switch (value) {
                            case (?extent) {
                                registerContentExtent(
                                    content.content_id,
                                    #per_block(Nat32.fromNat(index)),
                                    extent,
                                );
                            };
                            case null {};
                        };
                        index += 1;
                    };
                };
                case (#contiguous(value)) {
                    switch (value) {
                        case (?extent) {
                            registerContentExtent(
                                content.content_id,
                                #contiguous,
                                extent,
                            );
                        };
                        case null {};
                    };
                };
            };
        };

        func requireContentExtentOwner(
            content : Types.ContentDescriptor,
            slot : Types.ContentExtentSlot,
            extent : Types.ExtentRef,
        ) : () {
            let expected = contentExtentOwner(content.content_id, slot, extent);
            if (
                Map.get(
                    mem.content_extent_owners,
                    Nat64.compare,
                    extent.arena_offset,
                ) != ?expected or
                not Allocator.hasExactOwnership(mem.arena, extent)
            ) {
                Runtime.trap("Certified-assets content extent ownership mismatch");
            };
        };

        func freeContentExtent(
            content : Types.ContentDescriptor,
            slot : Types.ContentExtentSlot,
            extent : Types.ExtentRef,
        ) : () {
            requireContentExtentOwner(content, slot, extent);
            if (
                not Map.delete(
                    mem.content_extent_owners,
                    Nat64.compare,
                    extent.arena_offset,
                )
            ) {
                Runtime.trap("Certified-assets content owner disappeared");
            };
            bumpContentExtentMutationEpoch();
            Allocator.free(mem.arena, extent);
        };

        func invalidCatalogAudit(
            scanned : Nat,
        ) : Types.CatalogAuditPage {
            {
                valid = false;
                complete = false;
                scanned_nodes = scanned;
                next = null;
            };
        };

        func catalogCursorCurrent(
            cursor : Types.CatalogAuditCursor,
        ) : Bool {
            if (cursor.snapshot_scopes != Map.size(mem.scopes)) {
                return false;
            };
            if (
                cursor.snapshot_catalog_metadata_mutation_epoch !=
                    mem.catalog_metadata_mutation_epoch
            ) return false;
            switch (cert.v2CatalogSnapshot()) {
                case null false;
                case (?snapshot) {
                    snapshot.commit_sequence ==
                        cursor.snapshot_commit_sequence and
                    snapshot.commit_fingerprint ==
                        cursor.snapshot_commit_fingerprint;
                };
            };
        };

        func initialCatalogAuditCursor()
            : ?Types.CatalogAuditCursor {
            let ?snapshot = cert.v2CatalogSnapshot() else return null;
            let first = switch (Map.entries(mem.scopes).next()) {
                case (?(key, _)) ?key;
                case null null;
            };
            ?{
                snapshot_commit_sequence = snapshot.commit_sequence;
                snapshot_commit_fingerprint =
                    snapshot.commit_fingerprint;
                snapshot_scopes = Map.size(mem.scopes);
                snapshot_catalog_metadata_mutation_epoch =
                    mem.catalog_metadata_mutation_epoch;
                scope_key = first;
                mount_index = 0;
                collection_index = 0;
                seen_scopes = 0;
                seen_mount_roots = 0;
                seen_collection_roots = 0;
            };
        };

        func catalogAuditMount(
            state : Types.ScopeState,
            mount : Types.CommittedMount,
        ) : ?Types.CommittedMount {
            if (not state.retiring) return ?mount;
            let scopeKey = CapabilityScope.key(state.scope);
            let ?jobId = Map.get(
                mem.scope_retirement_job_by_scope,
                Text.compare,
                scopeKey,
            ) else return null;
            let ?job = Map.get(
                mem.cleanup_jobs,
                Nat64.compare,
                jobId,
            ) else return null;
            let #scope_retirement(retirementState) = job.kind else {
                return null;
            };
            if (
                not CapabilityScope.equal(
                    retirementState.scope,
                    state.scope,
                )
            ) return null;
            var found : ?Cert.DetachedV2 = null;
            var foundOne = false;
            for (retired in retirementState.mounts.vals()) {
                if (retired.mount_id == mount.id) {
                    if (foundOne) return null;
                    foundOne := true;
                    found := ?retired.detached;
                };
            };
            let ?detached = found else return null;
            ?{
                mount with
                enabled = false;
                detached_subtree = ?detached;
            };
        };

        func catalogAuditPage(
            cursor : ?Types.CatalogAuditCursor,
            maxNodes : Nat,
        ) : Types.CatalogAuditPage {
            let state = switch (cursor) {
                case null {
                    let ?initial = initialCatalogAuditCursor() else {
                        return invalidCatalogAudit(0);
                    };
                    initial;
                };
                case (?value) value;
            };
            if (
                not catalogCursorCurrent(state) or
                state.seen_scopes > state.snapshot_scopes
            ) return invalidCatalogAudit(0);

            let limit = Nat.min(maxNodes, MAX_CATALOG_AUDIT_PAGE_NODES);
            var scopeKey = state.scope_key;
            var mountIndex = state.mount_index;
            var collectionIndex = state.collection_index;
            var seenScopes = state.seen_scopes;
            var seenMounts = state.seen_mount_roots;
            var seenCollections = state.seen_collection_roots;
            var scanned = 0;

            label scan while (scanned < limit) {
                let ?key = scopeKey else break scan;
                let ?scope = Map.get(mem.scopes, Text.compare, key) else {
                    return invalidCatalogAudit(scanned);
                };
                if (
                    mountIndex > scope.mounts.size() or
                    collectionIndex > scope.collections.size()
                ) return invalidCatalogAudit(scanned);
                if (mountIndex < scope.mounts.size()) {
                    let ?mount = catalogAuditMount(
                        scope,
                        scope.mounts[mountIndex],
                    ) else return invalidCatalogAudit(scanned + 1);
                    switch (cert.v2MountCatalogMatches(
                        mountKey(scope.scope, mount.id),
                        mount.prefix,
                        mount.detached_subtree,
                    )) {
                        case (#present) seenMounts += 1;
                        case (#absent) {};
                        case (_) return invalidCatalogAudit(scanned + 1);
                    };
                    mountIndex += 1;
                    scanned += 1;
                } else if (collectionIndex < scope.collections.size()) {
                    let collection = scope.collections[collectionIndex];
                    let ?declaredMount = mountFor(
                        scope,
                        collection.mount,
                    ) else {
                        return invalidCatalogAudit(scanned + 1);
                    };
                    let ?mount = catalogAuditMount(
                        scope,
                        declaredMount,
                    ) else return invalidCatalogAudit(scanned + 1);
                    let (path, exact) =
                        collectionCatalogLocation(collection, mount);
                    switch (cert.v2CollectionCatalogMatches(
                        collectionCatalogKey(
                            scope.scope,
                            collection.id,
                        ),
                        path,
                        exact,
                        mount.detached_subtree,
                    )) {
                        case (#present) seenCollections += 1;
                        case (#absent) {};
                        case (_) return invalidCatalogAudit(scanned + 1);
                    };
                    collectionIndex += 1;
                    scanned += 1;
                } else {
                    // Scope transition is itself one bounded cross-index node,
                    // including scopes with no declared catalog entries.
                    let entries = Map.entriesFrom(
                        mem.scopes,
                        Text.compare,
                        key,
                    );
                    let ?(sameKey, _) = entries.next() else {
                        return invalidCatalogAudit(scanned + 1);
                    };
                    if (sameKey != key) {
                        return invalidCatalogAudit(scanned + 1);
                    };
                    scopeKey := switch (entries.next()) {
                        case (?(nextKey, _)) ?nextKey;
                        case null null;
                    };
                    mountIndex := 0;
                    collectionIndex := 0;
                    seenScopes += 1;
                    scanned += 1;
                };
            };

            let nextState : Types.CatalogAuditCursor = {
                snapshot_commit_sequence =
                    state.snapshot_commit_sequence;
                snapshot_commit_fingerprint =
                    state.snapshot_commit_fingerprint;
                snapshot_scopes = state.snapshot_scopes;
                snapshot_catalog_metadata_mutation_epoch =
                    state.snapshot_catalog_metadata_mutation_epoch;
                scope_key = scopeKey;
                mount_index = mountIndex;
                collection_index = collectionIndex;
                seen_scopes = seenScopes;
                seen_mount_roots = seenMounts;
                seen_collection_roots = seenCollections;
            };
            if (not catalogCursorCurrent(nextState)) {
                return invalidCatalogAudit(scanned);
            };
            if (scopeKey == null) {
                let ?snapshot = cert.v2CatalogSnapshot() else {
                    return invalidCatalogAudit(scanned);
                };
                if (
                    seenScopes != state.snapshot_scopes or
                    seenMounts != snapshot.mount_roots or
                    seenCollections != snapshot.collection_roots
                ) return invalidCatalogAudit(scanned);
                return {
                    valid = true;
                    complete = true;
                    scanned_nodes = scanned;
                    next = null;
                };
            };
            {
                valid = true;
                complete = false;
                scanned_nodes = scanned;
                next = ?nextState;
            };
        };

        func contentExtentAtSlot(
            content : Types.ContentDescriptor,
            slot : Types.ContentExtentSlot,
        ) : ?Types.ExtentRef {
            switch (content.storage, slot) {
                case (#per_block_extents(values), #per_block(index)) {
                    let value = Nat32.toNat(index);
                    if (value >= values.size()) null else values[value];
                };
                case (#contiguous(value), #contiguous) value;
                case (_) null;
            };
        };

        func contentStorageSlotCount(
            content : Types.ContentDescriptor,
        ) : Nat {
            switch (content.storage) {
                case (#per_block_extents(values)) values.size();
                case (#contiguous(_)) 1;
            };
        };

        func contentStorageSlot(
            content : Types.ContentDescriptor,
            index : Nat,
        ) : (Types.ContentExtentSlot, ?Types.ExtentRef) {
            switch (content.storage) {
                case (#per_block_extents(values)) {
                    if (index >= values.size()) {
                        Runtime.trap("Certified-assets content slot out of range");
                    };
                    (#per_block(Nat32.fromNat(index)), values[index]);
                };
                case (#contiguous(value)) {
                    if (index != 0) {
                        Runtime.trap("Certified-assets contiguous slot out of range");
                    };
                    (#contiguous, value);
                };
            };
        };

        func contentOwnershipCursorValid(
            cursor : Types.ContentOwnershipAuditCursor,
        ) : Bool {
            cursor.snapshot_content_extent_mutation_epoch ==
                mem.content_extent_mutation_epoch and
            cursor.snapshot_allocator_mutation_epoch ==
                mem.arena.mutation_epoch and
            cursor.snapshot_owner_rows ==
                Map.size(mem.content_extent_owners) and
            cursor.snapshot_allocated_extents ==
                mem.arena.allocated_extents and
            cursor.snapshot_contents == Map.size(mem.contents);
        };

        func invalidContentOwnershipAudit(
            scanned : Nat,
        ) : Types.ContentOwnershipAuditPage {
            {
                valid = false;
                complete = false;
                scanned_nodes = scanned;
                next = null;
            };
        };

        func ownerRowValid(
            offset : Nat64,
            owner : Types.ContentExtentOwner,
        ) : Bool {
            if (
                offset != owner.extent.arena_offset or
                not Allocator.hasExactOwnership(mem.arena, owner.extent)
            ) return false;
            let ?content = Map.get(
                mem.contents,
                Nat64.compare,
                owner.content_id,
            ) else return false;
            if (content.content_id != owner.content_id) return false;
            contentExtentAtSlot(content, owner.slot) == ?owner.extent;
        };

        func initialContentOwnershipCursor()
            : Types.ContentOwnershipAuditCursor {
            {
                snapshot_content_extent_mutation_epoch =
                    mem.content_extent_mutation_epoch;
                snapshot_allocator_mutation_epoch = mem.arena.mutation_epoch;
                snapshot_owner_rows = Map.size(mem.content_extent_owners);
                snapshot_allocated_extents = mem.arena.allocated_extents;
                snapshot_contents = Map.size(mem.contents);
                phase = #owners({
                    next_offset = 0;
                    scanned_owner_rows = 0;
                });
            };
        };

        func contentOwnershipAuditPage(
            cursor : ?Types.ContentOwnershipAuditCursor,
            maxNodes : Nat,
        ) : Types.ContentOwnershipAuditPage {
            if (not Allocator.validateHeader(mem.arena)) {
                return invalidContentOwnershipAudit(0);
            };
            let state = switch (cursor) {
                case null initialContentOwnershipCursor();
                case (?value) {
                    if (not contentOwnershipCursorValid(value)) {
                        return invalidContentOwnershipAudit(0);
                    };
                    value;
                };
            };
            let limit = Nat.min(
                maxNodes,
                MAX_CONTENT_OWNERSHIP_AUDIT_PAGE_NODES,
            );
            switch (state.phase) {
                case (#owners(progress)) {
                    auditContentOwnerRows(state, progress, limit);
                };
                case (#contents(progress)) {
                    auditContentDescriptorSlots(state, progress, limit);
                };
            };
        };

        func auditContentOwnerRows(
            state : Types.ContentOwnershipAuditCursor,
            progress : {
                next_offset : Nat64;
                scanned_owner_rows : Nat;
            },
            limit : Nat,
        ) : Types.ContentOwnershipAuditPage {
            if (
                progress.scanned_owner_rows > state.snapshot_owner_rows or
                (
                    progress.scanned_owner_rows == 0 and
                    progress.next_offset != 0
                )
            ) return invalidContentOwnershipAudit(0);
            if (
                state.snapshot_owner_rows !=
                    state.snapshot_allocated_extents
            ) return invalidContentOwnershipAudit(0);
            if (
                progress.scanned_owner_rows == state.snapshot_owner_rows
            ) {
                return {
                    valid = true;
                    complete = false;
                    scanned_nodes = 0;
                    next = ?{
                        state with
                        phase = #contents({
                            next_content_id = 0;
                            next_slot = 0;
                            scanned_content_slots = 0;
                            scanned_owned_slots = 0;
                        });
                    };
                };
            };
            let entries = Map.entriesFrom(
                mem.content_extent_owners,
                Nat64.compare,
                progress.next_offset,
            );
            var nextOffset = progress.next_offset;
            var totalScanned = progress.scanned_owner_rows;
            var pageScanned = 0;
            var exhausted = false;
            label rows while (
                pageScanned < limit and
                totalScanned < state.snapshot_owner_rows
            ) {
                let ?(offset, owner) = entries.next() else {
                    exhausted := true;
                    break rows;
                };
                if (
                    (totalScanned > 0 and offset < nextOffset) or
                    offset == NAT64_MAX or
                    not ownerRowValid(offset, owner)
                ) return invalidContentOwnershipAudit(pageScanned + 1);
                nextOffset := offset + 1;
                totalScanned += 1;
                pageScanned += 1;
            };
            if (
                exhausted and totalScanned < state.snapshot_owner_rows
            ) return invalidContentOwnershipAudit(pageScanned);
            let nextPhase : Types.ContentOwnershipAuditPhase =
                if (totalScanned == state.snapshot_owner_rows) {
                    #contents({
                        next_content_id = 0;
                        next_slot = 0;
                        scanned_content_slots = 0;
                        scanned_owned_slots = 0;
                    });
                } else {
                    #owners({
                        next_offset = nextOffset;
                        scanned_owner_rows = totalScanned;
                    });
                };
            {
                valid = true;
                complete = false;
                scanned_nodes = pageScanned;
                next = ?{ state with phase = nextPhase };
            };
        };

        func auditContentDescriptorSlots(
            state : Types.ContentOwnershipAuditCursor,
            progress : {
                next_content_id : Nat64;
                next_slot : Nat32;
                scanned_content_slots : Nat;
                scanned_owned_slots : Nat;
            },
            limit : Nat,
        ) : Types.ContentOwnershipAuditPage {
            if (
                progress.scanned_owned_slots > state.snapshot_owner_rows
            ) return invalidContentOwnershipAudit(0);
            let entries = Map.entriesFrom(
                mem.contents,
                Nat64.compare,
                progress.next_content_id,
            );
            var nextContentId = progress.next_content_id;
            var nextSlot = Nat32.toNat(progress.next_slot);
            var scannedSlots = progress.scanned_content_slots;
            var scannedOwned = progress.scanned_owned_slots;
            var pageScanned = 0;
            var exhausted = false;
            label contents while (pageScanned < limit) {
                let ?(contentId, content) = entries.next() else {
                    exhausted := true;
                    break contents;
                };
                if (
                    contentId < nextContentId or
                    content.content_id != contentId
                ) return invalidContentOwnershipAudit(pageScanned);
                let count = contentStorageSlotCount(content);
                let start = if (contentId == nextContentId) {
                    nextSlot;
                } else {
                    0;
                };
                if (count == 0 or start > count) {
                    return invalidContentOwnershipAudit(pageScanned);
                };
                var index = start;
                while (index < count and pageScanned < limit) {
                    let (slot, extent) = contentStorageSlot(content, index);
                    switch (extent) {
                        case (?value) {
                            let expected = contentExtentOwner(
                                contentId,
                                slot,
                                value,
                            );
                            if (
                                Map.get(
                                    mem.content_extent_owners,
                                    Nat64.compare,
                                    value.arena_offset,
                                ) != ?expected or
                                not Allocator.hasExactOwnership(
                                    mem.arena,
                                    value,
                                )
                            ) {
                                return invalidContentOwnershipAudit(
                                    pageScanned + 1
                                );
                            };
                            scannedOwned += 1;
                        };
                        case null {};
                    };
                    index += 1;
                    scannedSlots += 1;
                    pageScanned += 1;
                };
                if (index < count) {
                    return {
                        valid = true;
                        complete = false;
                        scanned_nodes = pageScanned;
                        next = ?{
                            state with
                            phase = #contents({
                                next_content_id = contentId;
                                next_slot = Nat32.fromNat(index);
                                scanned_content_slots = scannedSlots;
                                scanned_owned_slots = scannedOwned;
                            });
                        };
                    };
                };
                if (contentId == NAT64_MAX) {
                    return invalidContentOwnershipAudit(pageScanned);
                };
                nextContentId := contentId + 1;
                nextSlot := 0;
            };
            if (exhausted) {
                if (scannedOwned != state.snapshot_owner_rows) {
                    return invalidContentOwnershipAudit(pageScanned);
                };
                return {
                    valid = true;
                    complete = true;
                    scanned_nodes = pageScanned;
                    next = null;
                };
            };
            {
                valid = true;
                complete = false;
                scanned_nodes = pageScanned;
                next = ?{
                    state with
                    phase = #contents({
                        next_content_id = nextContentId;
                        next_slot = Nat32.fromNat(nextSlot);
                        scanned_content_slots = scannedSlots;
                        scanned_owned_slots = scannedOwned;
                    });
                };
            };
        };

        func replaceExtent(
            values : [?Types.ExtentRef],
            index : Nat,
            value : ?Types.ExtentRef,
        ) : [?Types.ExtentRef] {
            Array.tabulate<?Types.ExtentRef>(
                values.size(),
                func(candidate) {
                    if (candidate == index) value else values[candidate];
                },
            );
        };

        func contentAllocatedForId(contentId : Nat64) : Nat {
            switch (Map.get(mem.contents, Nat64.compare, contentId)) {
                case (?content) contentAllocatedBytes(content);
                case null 0;
            };
        };

        func blockAtOffset(
            blocks : [Types.ContentBlock],
            offset : Nat,
        ) : ?Nat {
            var index = 0;
            while (index < blocks.size()) {
                let block = blocks[index];
                if (
                    offset >= block.offset and
                    offset - block.offset < block.length
                ) return ?index;
                index += 1;
            };
            null;
        };

        func materializeBlock(
            content : Types.ContentDescriptor,
            index : Nat,
        ) : Types.ResolvedBlock {
            let block = content.blocks[index];
            let ?hash = block.sha256 else {
                Runtime.trap("Committed certified-assets block lacks hash");
            };
            {
                index = Nat32.fromNat(index);
                offset = block.offset;
                length = block.length;
                body_hash = hash;
                body = materializeContentBlock(content, index, block.length);
            };
        };

        func materializeWhole(
            content : Types.ContentDescriptor,
        ) : Types.ResolvedBlock {
            let body = switch (content.storage) {
                case (#contiguous(extent)) {
                    switch (extent) {
                        case (?value) {
                            requireContentExtentOwner(
                                content,
                                #contiguous,
                                value,
                            );
                            let ?loaded = Allocator.read(
                                mem.arena,
                                value,
                                content.total_length,
                            ) else Runtime.trap("Certified-assets body read failed");
                            loaded;
                        };
                        case null {
                            assert (content.total_length == 0);
                            Blob.fromArray([]);
                        };
                    };
                };
                case (#per_block_extents(_)) {
                    if (content.blocks.size() != 1) {
                        Runtime.trap(
                            "Portable certified blob spans multiple blocks"
                        );
                    };
                    materializeContentBlock(
                        content,
                        0,
                        content.total_length,
                    );
                };
            };
            let ?hash = content.blocks[0].sha256 else {
                Runtime.trap("Committed certified-assets body lacks hash");
            };
            {
                index = 0;
                offset = 0;
                length = content.total_length;
                body_hash = hash;
                body;
            };
        };

        func selectRecordLeaf(
            record : Types.AssetRecord,
            authority : Text,
            method : Text,
            blockIndex : ?Nat,
        ) : ?Types.CertificationLeafKey {
            var responseIndex = 0;
            for (key in record.certification_leaf_keys.vals()) {
                if (
                    key.owner.method == method and
                    hostMatches(key.owner.host_mode, authority)
                ) {
                    if (method == "HEAD") return ?key;
                    switch (blockIndex) {
                        case (?expected) {
                            if (responseIndex == expected) return ?key;
                            responseIndex += 1;
                        };
                        case null return ?key;
                    };
                };
            };
            null;
        };

        func selectAbsenceLeaf(
            mount : Types.CommittedMount,
            authority : Text,
            method : Text,
        ) : ?Types.CertificationLeafKey {
            for (key in mount.absence_leaf_keys.vals()) {
                if (
                    key.owner.method == method and
                    hostMatches(key.owner.host_mode, authority)
                ) return ?key;
            };
            null;
        };

        func hostMatches(
            mode : Types.CertificationHostMode,
            authority : Text,
        ) : Bool {
            switch (mode) {
                case (#exact(value)) Text.toLower(value) == Text.toLower(authority);
                case (#excluded) true;
            };
        };

        func validAuthority(
            mount : Types.CommittedMount,
            authority : Text,
        ) : Bool {
            switch (mount.authority_mode) {
                case (#exact_neutron_host_v1) {
                    for (host in RouteNamespace.authorities(
                        #shared_app_path,
                        canisterId,
                        mount.scope.app_id,
                    ).vals()) {
                        if (Text.toLower(host) == Text.toLower(authority)) return true;
                    };
                    false;
                };
                case (#canister_gateway_v1) {
                    RouteNamespace.isSharedAuthority(
                        canisterId,
                        Text.toLower(authority),
                    );
                };
            };
        };

        func recordsForScope(scope : Types.AppScope) : [Types.AssetRecord] {
            let result = List.empty<Types.AssetRecord>();
            let prefix = CapabilityScope.key(scope) # "\00record\00";
            for ((key, record) in Map.entriesFrom(
                mem.records,
                Text.compare,
                prefix,
            )) {
                if (not Text.startsWith(key, #text prefix)) return List.toArray(result);
                List.add(result, record);
            };
            List.toArray(result);
        };

        func retireScopeState(scope : Types.AppScope) : Bool {
            let key = CapabilityScope.key(scope);
            let ?state = Map.get(mem.scopes, Text.compare, key) else return false;
            if (state.retiring) return true;
            if (not cleanupCapacity(scope, 1)) return false;
            cert.beginV2PublicationBatch();
            let detached = cert.retireV2(
                Array.map<Types.CommittedMount, Cert.RetireMountV2>(
                    state.mounts,
                    func(mount) {
                        {
                            base_path = mount.prefix;
                            current_detached = mount.detached_subtree;
                            absence_leaves =
                                leafKeys(mount.absence_leaf_keys);
                        };
                    },
                )
            );
            assert (detached.size() == state.mounts.size());
            let retiredMounts = Array.tabulate<Types.RetiredForestMount>(
                state.mounts.size(),
                func(index) {
                    {
                        mount_id = state.mounts[index].id;
                        detached = detached[index];
                    };
                },
            );
            var mountIndex = 0;
            while (mountIndex < state.mounts.size()) {
                let retainedMount = {
                    state.mounts[mountIndex] with
                    enabled = false;
                    detached_subtree = ?detached[mountIndex];
                };
                syncMountCatalog(retainedMount);
                for (collection in state.collections.vals()) {
                    if (collection.mount == retainedMount.id) {
                        syncCollectionCatalog(collection, retainedMount);
                    };
                };
                mountIndex += 1;
            };
            ignore cert.finishV2PublicationBatch();
            // Materialize the one retirement cursor while the declaration's
            // unused charged headroom still backs it.
            assert (enqueueCleanup(
                scope,
                #scope_retirement({ scope; mounts = retiredMounts }),
                #records(null),
            ));
            let usage = usageFor(scope);
            let currentCharge =
                usage.allocated_body_bytes + usage.charged_metadata_bytes;
            let allocatedExtents = allocatedExtentsForScope(scope);
            let retainedCharge = retainedForestCharge(state.mounts.size());
            if (
                not state.reservation_active or
                currentCharge > state.installed_charged_reservation or
                usage.allocated_body_bytes >
                    state.installed_arena_reservation or
                allocatedExtents >
                    state.installed_arena_extent_reservation or
                retainedCharge >
                    state.installed_charged_reservation - currentCharge
            ) {
                Runtime.trap("Invalid certified-assets retirement reservation");
            };
            // The active catalogs consumed install-time headroom rather than
            // appearing in ordinary per-scope usage. On retirement their
            // catalog rows and detached-token subtrees remain physically live
            // until the final bounded cleanup page, so convert that bounded
            // reserve into actual charge before releasing the reservation.
            let priorUnusedReservation =
                state.installed_charged_reservation - currentCharge;
            let priorUnusedArenaReservation =
                state.installed_arena_reservation -
                usage.allocated_body_bytes;
            let priorUnusedArenaExtentReservation =
                state.installed_arena_extent_reservation -
                allocatedExtents;
            if (
                priorUnusedReservation >
                    mem.global_reserved_charged_headroom or
                priorUnusedArenaReservation >
                    mem.global_reserved_arena_headroom or
                priorUnusedArenaExtentReservation >
                    mem.global_reserved_arena_extent_headroom
            ) {
                Runtime.trap(
                    "Certified-assets global charged headroom underflow"
                );
            };
            mem.global_reserved_charged_headroom -= priorUnusedReservation;
            mem.global_reserved_arena_headroom -=
                priorUnusedArenaReservation;
            mem.global_reserved_arena_extent_headroom -=
                priorUnusedArenaExtentReservation;
            mem.total_installed_charged_reservation -=
                state.installed_charged_reservation;
            mem.total_installed_arena_reservation -=
                state.installed_arena_reservation;
            mem.total_installed_arena_extent_reservation -=
                state.installed_arena_extent_reservation;
            Map.add(mem.scopes, Text.compare, key, {
                state with
                committed = false;
                retiring = true;
                reservation_active = false;
            });
            // Authority loss is O(1): logical live/stage use is retired now,
            // while every physically allocated extent remains charged as
            // detached until its bounded cleanup cursor actually frees it.
            setUsage(scope, {
                usage with
                live_entries = 0;
                committed_body_bytes = 0;
                reserved_committed_body_bytes = 0;
                accepted_staged_bytes = 0;
                reserved_staged_bytes = 0;
                detached_charged_bytes = usage.allocated_body_bytes;
                active_stages = 0;
                reserved_entry_slots = 0;
                charged_metadata_bytes =
                    usage.charged_metadata_bytes + retainedCharge;
            });
            for (mount in state.mounts.vals()) {
                ignore Map.delete(mem.mounts, Text.compare, mountKey(scope, mount.id));
            };
            switch (Map.get(mem.scopes_by_app, Text.compare, scope.app_id)) {
                case (?indexed) {
                    if (CapabilityScope.equal(indexed, scope)) {
                        ignore Map.delete(
                            mem.scopes_by_app,
                            Text.compare,
                            scope.app_id,
                        );
                    };
                };
                case null {};
            };
            true;
        };

        do {
            // Actor construction/post-upgrade is scan-free. The complete
            // free-index overlap/partition check is available only through
            // Allocator.auditPage's explicit bounded cursor. Exact extent
            // ownership is likewise audited page-by-page, but its two O(1)
            // cardinalities must agree before this service can serve bytes.
            assert (Allocator.validateHeader(mem.arena));
            assert (
                Map.size(mem.content_extent_owners) ==
                mem.arena.allocated_extents
            );
        };
    };
};
