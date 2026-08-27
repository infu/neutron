import Runtime "mo:core/Runtime";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Text "mo:core/Text";
import Assets "../assets";
import CapabilityTypes "../capabilities/Types";
import CapabilityScope "../capabilities/Scope";
import Cert "../certified_http";
import BackendCallsMemory "../backend_calls/Memory";
import BackendCallTypes "../backend_calls/Types";
import Sha256 "mo:sha2/Sha256";
import BrowserOrigin "BrowserOrigin";
import Limits "Limits";
import Memory "Memory";
import Types "Types";

module {
    let MIN_APP_VERSION = 100;
    let DISPATCH_MARKER : Blob = "\01";
    let MAX_MODULE_GC_ENTRIES = 20_000;
    let MAX_MODULE_GC_BYTES = 1_400_000;
    let NAT64_MAX : Nat64 = 18_446_744_073_709_551_615;
    let ORIGIN_NONCE_DOMAIN = "neutron.browser-origin.v2";
    let DEPLOYMENT_BUILD_RECORD_PATH =
        "/system/deployment-build-record.json";
    let HEX = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];

    public type Certification = {
        beginV2PublicationBatch : () -> ();
        finishV2PublicationBatch : () -> Bool;
        hasPendingChunked : Text -> Bool;
        putHash : (Text, Blob) -> ();
        put : (Text, Blob) -> ();
    };

    public type ReservationPreparation = {
        target_scopes : [CapabilityTypes.AppScope];
        changed_scopes : [CapabilityTypes.AppScope];
    };

    // This is V1 initialization, not a legacy import path. A fresh schema has
    // no prior app registry from which identities could be inferred. The
    // compiler-generated inventory is validated and receives kernel-owned
    // identities exactly once. Every non-fresh actor must prove either its
    // committed deployment or the exact staged deployment it is activating.
    public func initializeFresh(
        mem : Types.Memory,
        runningDeploymentId : Text,
        active : [Types.RuntimeApp],
        freshOriginEpoch : Nat64,
    ) : () {
        assert (isRunningDeploymentId(runningDeploymentId));
        assert (isCanonicalRuntimeAppInventory(active));
        if (
            mem.next_installation_uid == 1 and
            mem.committed_app_instances.size() == 0 and
            mem.pending == null
        ) {
            assert (mem.browser_origin_epoch == null);
            mem.browser_origin_epoch := ?freshOriginEpoch;
            let initialized = reconcileTarget(
                mem,
                [],
                active,
                runningDeploymentId,
                freshOriginEpoch,
                freshOriginEpoch,
            );
            assert (isCanonicalAppInstanceInventory(
                initialized,
                runningDeploymentId,
                freshOriginEpoch,
            ));
            assert (allocatorAboveInventory(mem.next_installation_uid, initialized));
            mem.committed_app_instances := initialized;
            return;
        };

        let ?originEpoch = mem.browser_origin_epoch else Runtime.trap(
            "Browser-origin epoch is not initialized"
        );

        assert (allocatorAboveInventory(
            mem.next_installation_uid,
            mem.committed_app_instances,
        ));

        if (
            committedMatchesActiveRuntime(
                mem.committed_app_instances,
                active,
                runningDeploymentId,
                originEpoch,
            )
        ) return;

        let ?journal = mem.pending else Runtime.trap(
            "Active app-instance inventory does not match committed state"
        );
        assert (journal.deployment_id == runningDeploymentId);
        assert (
            targetMatchesActiveRuntime(
                journal,
                active,
                runningDeploymentId,
                originEpoch,
            )
        );
    };

    public class Service(
        mem : Types.Memory,
        assets : Assets.Use,
        cert : Certification,
        backendCalls : BackendCallTypes.Memory,
        runningDeploymentId : Text,
        activeAppInstanceInventory : [Types.RuntimeApp],
        currentCanisterVersion : () -> Nat64,
        backendScopeAllowed : (CapabilityTypes.AppScope, Text) -> Bool,
        publishAsset : (Text, Blob) -> (),
        deleteAssetCertification : Text -> (),
        onCommit : ([Types.AppInstance], Principal) -> (),
    ) {
        let originEpoch = switch (mem.browser_origin_epoch) {
            case (?value) value;
            case null Runtime.trap("Browser-origin epoch is not initialized");
        };
        public func publicStaticMutationsAllowed() : Bool {
            mem.pending == null;
        };

        // A new journal must never fence an incomplete upload. Once begin
        // succeeds, public static mutations are locked until commit/abort, so
        // prove every declared copy source is already durable beforehand.
        public func copySourcesAvailable(input : Types.BeginInput) : Bool {
            for (copy in input.copies.vals()) {
                if (
                    cert.hasPendingChunked(copy.source) or
                    assets.get(copy.source) == null
                ) return false;
            };
            true;
        };
        // Read-only exact-replay decision used by begin. This is intentionally
        // internal to the install service; the canister API still exposes only
        // the checked update, whose rejection is the assertion below.
        public func canReplayBegin(input : Types.BeginInput) : Bool {
            let ?journal = mem.pending else return false;
            isValidBeginInput(input) and
            input.deployment_id != runningDeploymentId and
            isValidJournal(journal, originEpoch) and
            mem.committed_app_instances ==
                journal.committed_app_instances and
            committedMatchesActiveRuntime(
                journal.committed_app_instances,
                activeAppInstanceInventory,
                runningDeploymentId,
                originEpoch,
            ) and
            expectedNextInstallationUid(journal) ==
                Nat64.toNat(mem.next_installation_uid) and
            beginInputMatchesJournal(input, journal);
        };

        public func begin(input : Types.BeginInput) : () {
            switch (mem.pending) {
                case null {};
                case (?_) {
                    // An update reply may be lost after this journal was
                    // durably created. A byte-for-byte client retry is an
                    // acknowledgement of that same transition, never a new
                    // allocation attempt. Prove it from the journal's
                    // original client-bound fields and its runtime projection;
                    // do not reconstruct the target and consume more uids.
                    assert (canReplayBegin(input));
                    return;
                };
            };
            // No claim is valid without the single global install journal.
            // Cleaning an impossible stale row is safer than allowing an
            // invisible capacity hold to wedge every later deployment.
            BackendCallsMemory.removeInstallClaims(backendCalls);
            assert (isValidBeginInput(input));
            // Every journal first created by this Kernel generation carries
            // exactly one authoritative deployment record. Restored v0.3.6
            // pending journals remain valid for activation/commit because
            // replay and isValidJournal intentionally use the structural
            // compatibility predicate above instead of this release gate.
            assert (hasExactlyOneDeploymentBuildRecordCopy(input));
            assert (copySourcesAvailable(input));
            assert (input.deployment_id != runningDeploymentId);
            // The old actor independently proves stable committed identity
            // against its compiler-generated runtime. The client supplies no
            // committed identity and cannot choose installation uids/nonces.
            assert (committedMatchesActiveRuntime(
                mem.committed_app_instances,
                activeAppInstanceInventory,
                runningDeploymentId,
                originEpoch,
            ));
            assert (allocatorAboveInventory(
                mem.next_installation_uid,
                mem.committed_app_instances,
            ));
            let issuanceCanisterVersion = currentCanisterVersion();
            let laneStart = installationUidLaneStart(issuanceCanisterVersion);
            if (mem.next_installation_uid < laneStart) {
                mem.next_installation_uid := laneStart;
            };
            assert (
                mem.next_installation_uid <=
                installationUidLaneNextLimit(issuanceCanisterVersion)
            );
            let allocationStartUid = mem.next_installation_uid;
            let target = reconcileTarget(
                mem,
                mem.committed_app_instances,
                input.target_app_inventory,
                input.deployment_id,
                originEpoch,
                issuanceCanisterVersion,
            );
            assert (
                mem.next_installation_uid <=
                installationUidLaneNextLimit(issuanceCanisterVersion)
            );
            let removed = removedInstances(
                mem.committed_app_instances,
                target,
            );
            let removedAppIds = Array.map<Types.AppInstance, Text>(
                removed,
                func(instance) { instance.scope.app_id },
            );
            let journal : Types.Journal = {
                deployment_id = input.deployment_id;
                allocation_start_uid = allocationStartUid;
                copies = input.copies;
                clear_prefixes = input.clear_prefixes;
                removed_apps = removedAppIds;
                committed_app_instances = mem.committed_app_instances;
                target_app_instances = target;
            };
            assert (isValidJournal(journal, originEpoch));
            mem.pending := ?journal;
        };

        public func status() : ?Types.Status {
            switch (mem.pending) {
                case null null;
                case (?journal) ?{
                    deployment_id = journal.deployment_id;
                    copy_count = journal.copies.size();
                    clear_count = journal.clear_prefixes.size();
                    removed_apps = journal.removed_apps;
                    committed_app_instances = journal.committed_app_instances;
                    target_app_instances = journal.target_app_instances;
                };
            };
        };

        public func reservationPreparation(
            input : Types.DeploymentInput,
        ) : ReservationPreparation {
            let ?journal = mem.pending else {
                Runtime.trap("Install journal is missing");
            };
            assert (journal.deployment_id == input.deployment_id);
            // Once the one-way management call is queued, only the compiled
            // target's authoritative commit path may reconcile claims.
            assert (
                assets.get(dispatchMarkerPath(journal.deployment_id)) == null
            );
            reservationPreparationFor(journal);
        };

        public func commitReservationPreparation(
            input : Types.DeploymentInput,
        ) : ReservationPreparation {
            let ?journal = mem.pending else {
                Runtime.trap("Install journal is missing");
            };
            assert (journal.deployment_id == input.deployment_id);
            reservationPreparationFor(journal);
        };

        func reservationPreparationFor(
            journal : Types.Journal,
        ) : ReservationPreparation {
            {
                target_scopes = Array.map<
                    Types.AppInstance,
                    CapabilityTypes.AppScope,
                >(
                    journal.target_app_instances,
                    func(instance) { instance.scope },
                );
                changed_scopes = Array.map<
                    Types.AppInstance,
                    CapabilityTypes.AppScope,
                >(
                    changedInstances(
                        journal.committed_app_instances,
                        journal.target_app_instances,
                    ),
                    func(instance) { instance.scope },
                );
            };
        };

        public func commit(
            input : Types.DeploymentInput,
            changedBy : Principal,
            commitManagedMemory : Text -> (),
        ) : [Types.AppInstance] {
            let ?journal = mem.pending else return [];
            assert (journal.deployment_id == input.deployment_id);
            // Commit runs in the newly activated actor. Bind the pending
            // target to that actor's compiler-generated runtime inventory
            // before publishing any staged asset or changing app state.
            assert (
                targetMatchesActiveRuntime(
                    journal,
                    activeAppInstanceInventory,
                    runningDeploymentId,
                    originEpoch,
                )
            );
            assert (
                mem.committed_app_instances == journal.committed_app_instances
            );
            assert (
                expectedNextInstallationUid(journal) ==
                Nat64.toNat(mem.next_installation_uid)
            );
            assert (allocatorAboveInventory(
                mem.next_installation_uid,
                journal.target_app_instances,
            ));

            // One install commit is one certification transaction. This
            // includes static asset hashes, public-response leaves published
            // by copyAsset, nested certified-assets configuration commits,
            // module GC, and the final staging cleanup. Certification batches
            // are depth-composable, so the certified-assets service may open
            // and finish its own inner batch without publishing early.
            cert.beginV2PublicationBatch();
            for (prefix in journal.clear_prefixes.vals()) clearAssets(prefix);
            for (copy in journal.copies.vals()) copyAsset(copy);
            let removed = removedInstances(
                journal.committed_app_instances,
                journal.target_app_instances,
            );
            let changed = changedInstances(
                journal.committed_app_instances,
                journal.target_app_instances,
            );
            // Promote before specialized cleanup. Any trap rolls back the
            // entire Motoko message, including assets and this assignment.
            mem.committed_app_instances := journal.target_app_instances;
            for (instance in removed.vals()) {
                BackendCallsMemory.removeAppScope(backendCalls, instance.scope);
            };
            BackendCallsMemory.removeIncompatible(
                backendCalls,
                backendScopeAllowed,
            );
            onCommit(removed, changedBy);
            // The assembler-owned callback only clears optional roots that
            // this target actor retained during activation. It is synchronous
            // and runs in this same update, so any later trap rolls back both
            // stable-memory clearing and the journal/resource promotion.
            commitManagedMemory(journal.deployment_id);
            applyModuleGc(journal.deployment_id);
            clearAssets(stagingPrefix(journal.deployment_id));
            ignore cert.finishV2PublicationBatch();
            mem.pending := null;
            changed;
        };

        // Reissue provisional browser authority in the same message that
        // persists the dispatch marker and queues the one-way management
        // install. A snapshot restored after begin therefore cannot dispatch
        // an installation uid, nonce, or rotated authority epoch that a
        // discarded branch already activated. Install-time backend-call claims
        // remain valid because they are intentionally keyed by app id with the
        // inert installation uid zero until the target actor finalizes them.
        public func markDispatched(input : Types.DeploymentInput) : () {
            let ?journal = mem.pending else Runtime.trap("Install journal is missing");
            assert (journal.deployment_id == input.deployment_id);
            let path = dispatchMarkerPath(journal.deployment_id);
            assert (assets.get(path) == null);
            let reissued = reissuePendingTargetForDispatch(
                journal,
                currentCanisterVersion(),
            );
            mem.pending := ?reissued;
            assets.put({
                id = path;
                chunks = 1;
                content = [DISPATCH_MARKER];
                content_encoding = "identity";
                content_type = "application/octet-stream";
            });
            cert.put(path, DISPATCH_MARKER);
        };

        func reissuePendingTargetForDispatch(
            journal : Types.Journal,
            dispatchCanisterVersion : Nat64,
        ) : Types.Journal {
            assert (isValidJournal(journal, originEpoch));
            assert (
                mem.committed_app_instances ==
                journal.committed_app_instances
            );
            assert (
                expectedNextInstallationUid(journal) ==
                Nat64.toNat(mem.next_installation_uid)
            );

            let laneStart = installationUidLaneStart(
                dispatchCanisterVersion
            );
            // Resetting the provisional allocator is safe only when no
            // committed identity occupies this non-rollbackable version lane.
            // The target has not activated and the dispatch marker is absent,
            // so identities minted by begin have never carried authority.
            for (committed in journal.committed_app_instances.vals()) {
                assert (committed.scope.installation_uid < laneStart);
            };
            mem.next_installation_uid := laneStart;
            let target = reconcileTarget(
                mem,
                journal.committed_app_instances,
                runtimeProjection(journal.target_app_instances),
                journal.deployment_id,
                originEpoch,
                dispatchCanisterVersion,
            );
            assert (
                mem.next_installation_uid <=
                installationUidLaneNextLimit(dispatchCanisterVersion)
            );
            let reissued : Types.Journal = {
                journal with
                allocation_start_uid = laneStart;
                removed_apps = Array.map<Types.AppInstance, Text>(
                    removedInstances(
                        journal.committed_app_instances,
                        target,
                    ),
                    func(instance) { instance.scope.app_id },
                );
                target_app_instances = target;
            };
            assert (isValidJournal(reissued, originEpoch));
            assert (
                expectedNextInstallationUid(reissued) ==
                Nat64.toNat(mem.next_installation_uid)
            );
            reissued;
        };

        public func clearDispatchAfterCallError(
            input : Types.DeploymentInput,
        ) : () {
            let ?journal = mem.pending else return;
            assert (journal.deployment_id == input.deployment_id);
            let path = dispatchMarkerPath(journal.deployment_id);
            ignore assets.delete(path);
            deleteAssetCertification(path);
        };

        public func isDispatched(input : Types.DeploymentInput) : Bool {
            let ?journal = mem.pending else return false;
            assert (journal.deployment_id == input.deployment_id);
            assets.get(dispatchMarkerPath(journal.deployment_id)) != null;
        };

        public func abort(input : Types.DeploymentInput) : () {
            let ?journal = mem.pending else return;
            assert (journal.deployment_id == input.deployment_id);
            // Once dispatch is recorded, activation may happen in the future
            // even while the old deployment is still observable. Only commit
            // or an explicit controller reinstall can resolve that state.
            assert (assets.get(dispatchMarkerPath(journal.deployment_id)) == null);
            cert.beginV2PublicationBatch();
            clearAssets(stagingPrefix(journal.deployment_id));
            BackendCallsMemory.removeInstallClaims(backendCalls);
            ignore cert.finishV2PublicationBatch();
            mem.pending := null;
        };

        public func abortAfterManagementFence(
            input : Types.DeploymentInput,
        ) : () {
            let ?journal = mem.pending else return;
            assert (journal.deployment_id == input.deployment_id);
            assert (assets.get(dispatchMarkerPath(journal.deployment_id)) != null);
            cert.beginV2PublicationBatch();
            clearAssets(stagingPrefix(journal.deployment_id));
            BackendCallsMemory.removeInstallClaims(backendCalls);
            ignore cert.finishV2PublicationBatch();
            mem.pending := null;
        };

        func copyAsset(copy : Types.AssetCopy) : () {
            let source = switch (assets.get(copy.source)) {
                case (?value) value;
                case null Runtime.trap("Staged install asset is missing");
            };
            assets.put({ source with id = copy.target });
            let bodyHash = Cert.hashChunks(source.content);
            cert.putHash(copy.target, bodyHash);
            publishAsset(copy.target, bodyHash);
        };

        func applyModuleGc(deploymentId : Text) : () {
            let ?file = assets.get(moduleGcPath(deploymentId)) else return;
            assert (file.content_encoding == "identity");
            assert (file.chunks == file.content.size());
            var totalBytes = 0;
            for (chunk in file.content.vals()) {
                totalBytes += chunk.size();
                assert (totalBytes <= MAX_MODULE_GC_BYTES);
            };
            let chunkBytes = Array.map<Blob, [Nat8]>(file.content, Blob.toArray);
            let content = Blob.fromArray(Array.flatten<Nat8>(chunkBytes));
            let ?paths = Text.decodeUtf8(content) else {
                Runtime.trap("Module cleanup list is not UTF-8");
            };
            var count = 0;
            for (path in Text.split(paths, #char '\n')) {
                if (path != "") {
                    count += 1;
                    assert (count <= MAX_MODULE_GC_ENTRIES);
                    assert (isModulePath(path));
                    let key = "/mo/" # path;
                    if (assets.delete(key)) deleteAssetCertification(key);
                };
            };
        };

        func clearAssets(prefix : Text) : () {
            if (prefix == DEPLOYMENT_BUILD_RECORD_PATH) {
                if (assets.delete(prefix)) deleteAssetCertification(prefix);
                return;
            };
            for (key in assets.allKeys(prefix).vals()) {
                ignore assets.delete(key);
                deleteAssetCertification(key);
            };
        };
    };

    public func isValidBeginInput(input : Types.BeginInput) : Bool {
        if (not isDeploymentId(input.deployment_id)) return false;
        if (
            input.copies.size() >
            Limits.MAX_ASSET_COPIES_PER_COMMIT
        ) return false;
        if (
            input.clear_prefixes.size() >
            Limits.MAX_ASSET_CLEAR_PREFIXES_PER_COMMIT
        ) return false;
        if (not isCanonicalRuntimeAppInventory(input.target_app_inventory)) {
            return false;
        };

        let stage = stagingPrefix(input.deployment_id);
        for (copy in input.copies.vals()) {
            if (
                not Cert.validCanonicalPath(copy.source) or
                not Cert.validCanonicalPath(copy.target)
            ) return false;
            if (not Text.startsWith(copy.source, #text stage)) return false;
            if (Text.startsWith(copy.target, #text "/system/staging/")) return false;
        };
        for (prefix in input.clear_prefixes.vals()) {
            if (not Cert.validCanonicalPath(prefix)) return false;
            if (
                prefix != "/pkg/legal/" and
                prefix != "/system/deployment-build-record.json" and
                not Text.startsWith(prefix, #text "/app/")
            ) return false;
            if (Text.contains(prefix, #text "..")) return false;
        };
        true;
    };

    public func hasExactlyOneDeploymentBuildRecordCopy(
        input : Types.BeginInput,
    ) : Bool {
        var count = 0;
        for (copy in input.copies.vals()) {
            if (copy.target == DEPLOYMENT_BUILD_RECORD_PATH) count += 1;
        };
        count == 1;
    };

    func beginInputMatchesJournal(
        input : Types.BeginInput,
        journal : Types.Journal,
    ) : Bool {
        input.deployment_id == journal.deployment_id and
        input.copies == journal.copies and
        input.clear_prefixes == journal.clear_prefixes and
        sameRuntimeAppInventory(
            input.target_app_inventory,
            runtimeProjection(journal.target_app_instances),
        );
    };

    public func isValidJournal(
        journal : Types.Journal,
        originEpoch : Nat64,
    ) : Bool {
        if (
            not isValidBeginInput({
                deployment_id = journal.deployment_id;
                copies = journal.copies;
                clear_prefixes = journal.clear_prefixes;
                target_app_inventory = runtimeProjection(
                    journal.target_app_instances
                );
            })
        ) return false;
        if (
            not removalCountWithinCommitBound(
                journal.removed_apps.size()
            )
        ) return false;
        if (journal.allocation_start_uid == 0) return false;
        if (not isCanonicalRemovedApps(journal.removed_apps)) return false;
        if (
            not isCanonicalAppInstanceInventory(
                journal.target_app_instances,
                journal.deployment_id,
                originEpoch,
            )
        ) return false;
        if (not isCanonicalAppInstanceInventoryAnyDeployment(
            journal.committed_app_instances,
            originEpoch,
        )) return false;
        let committedDeploymentId =
            journal.committed_app_instances[0].deployment_id;
        if (
            not isCanonicalAppInstanceInventory(
                journal.committed_app_instances,
                committedDeploymentId,
                originEpoch,
            ) or committedDeploymentId == journal.deployment_id
        ) return false;
        for (committed in journal.committed_app_instances.vals()) {
            if (
                committed.scope.installation_uid >=
                journal.allocation_start_uid
            ) return false;
        };
        let expectedRemoved = Array.map<Types.AppInstance, Text>(
            removedInstances(
                journal.committed_app_instances,
                journal.target_app_instances,
            ),
            func(instance) { instance.scope.app_id },
        );
        journal.removed_apps == expectedRemoved and
        isReconciledTransition(journal);
    };

    public func sameRuntimeAppInventory(
        left : [Types.RuntimeApp],
        right : [Types.RuntimeApp],
    ) : Bool {
        left == right;
    };

    public func committedMatchesActiveRuntime(
        committed : [Types.AppInstance],
        active : [Types.RuntimeApp],
        deploymentId : Text,
        originEpoch : Nat64,
    ) : Bool {
        isCanonicalAppInstanceInventory(
            committed,
            deploymentId,
            originEpoch,
        ) and
        isCanonicalRuntimeAppInventory(active) and
        sameRuntimeAppInventory(
            runtimeProjection(committed),
            active,
        );
    };

    public func targetMatchesActiveRuntime(
        journal : Types.Journal,
        active : [Types.RuntimeApp],
        deploymentId : Text,
        originEpoch : Nat64,
    ) : Bool {
        journal.deployment_id == deploymentId and
        isValidJournal(journal, originEpoch) and
        sameRuntimeAppInventory(
            runtimeProjection(journal.target_app_instances),
            active,
        );
    };

    public func isCanonicalRuntimeAppInventory(
        inventory : [Types.RuntimeApp],
    ) : Bool {
        if (
            inventory.size() < 1 or
            inventory.size() > Limits.MAX_APP_INSTANCES
        ) {
            return false;
        };
        var previous : ?Text = null;
        for (record in inventory.vals()) {
            if (not isAppId(record.app_id)) return false;
            if (record.version < MIN_APP_VERSION) return false;
            if (not isFingerprint(record.capability_plan_fingerprint)) return false;
            switch (previous) {
                case (?appId) {
                    if (Text.compare(appId, record.app_id) != #less) return false;
                };
                case null {};
            };
            previous := ?record.app_id;
        };
        true;
    };

    public func isCanonicalAppInstanceInventory(
        inventory : [Types.AppInstance],
        deploymentId : Text,
        originEpoch : Nat64,
    ) : Bool {
        if (not isRunningDeploymentId(deploymentId)) return false;
        if (not isCanonicalAppInstanceInventoryAnyDeployment(
            inventory,
            originEpoch,
        )) {
            return false;
        };
        for (instance in inventory.vals()) {
            if (instance.deployment_id != deploymentId) return false;
        };
        true;
    };

    func isCanonicalAppInstanceInventoryAnyDeployment(
        inventory : [Types.AppInstance],
        originEpoch : Nat64,
    ) : Bool {
        if (
            inventory.size() < 1 or
            inventory.size() > Limits.MAX_APP_INSTANCES
        ) {
            return false;
        };
        var previous : ?Text = null;
        var index = 0;
        for (instance in inventory.vals()) {
            if (not isAppId(instance.scope.app_id)) return false;
            if (instance.scope.installation_uid == 0) return false;
            if (instance.version < MIN_APP_VERSION) return false;
            if (not isRunningDeploymentId(instance.deployment_id)) return false;
            if (not isFingerprint(instance.capability_plan_fingerprint)) return false;
            if (not BrowserOrigin.isValidNonce(instance.browser_origin_nonce)) {
                return false;
            };
            if (instance.browser_origin_authority_epoch == 0) return false;
            if (
                instance.browser_origin_nonce != originNonce(
                    originEpoch,
                    instance.scope.app_id,
                    instance.scope.installation_uid,
                    instance.browser_origin_authority_epoch,
                )
            ) return false;
            switch (previous) {
                case (?appId) {
                    if (Text.compare(appId, instance.scope.app_id) != #less) {
                        return false;
                    };
                };
                case null {};
            };
            var otherIndex = 0;
            for (other in inventory.vals()) {
                if (
                    otherIndex < index and (
                        other.scope.installation_uid == instance.scope.installation_uid or
                        other.browser_origin_nonce == instance.browser_origin_nonce
                    )
                ) return false;
                otherIndex += 1;
            };
            previous := ?instance.scope.app_id;
            index += 1;
        };
        true;
    };

    public func runtimeProjection(
        instances : [Types.AppInstance],
    ) : [Types.RuntimeApp] {
        Array.map<Types.AppInstance, Types.RuntimeApp>(
            instances,
            func(instance) {
                {
                    app_id = instance.scope.app_id;
                    version = instance.version;
                    capability_plan_fingerprint =
                        instance.capability_plan_fingerprint;
                    resident_frame_security =
                        instance.resident_frame_security;
                };
            },
        );
    };

    // The compiler uses the same exact ceiling when diffing the committed and
    // target inventories. Keeping this predicate public makes the backend
    // boundary directly testable without exposing another canister method.
    public func removalCountWithinCommitBound(count : Nat) : Bool {
        count <= Limits.MAX_APP_REMOVALS_PER_COMMIT;
    };

    func reconcileTarget(
        mem : Types.Memory,
        committed : [Types.AppInstance],
        target : [Types.RuntimeApp],
        deploymentId : Text,
        originEpoch : Nat64,
        issuanceCanisterVersion : Nat64,
    ) : [Types.AppInstance] {
        assert (isCanonicalRuntimeAppInventory(target));
        Array.map<Types.RuntimeApp, Types.AppInstance>(
            target,
            func(app) {
                let identity : {
                    scope : Types.AppScope;
                    browser_origin_nonce : Text;
                    browser_origin_authority_epoch : Nat64;
                } = switch (Memory.findApp(committed, app.app_id)) {
                    case (?existing) {
                        if (
                            existing.resident_frame_security ==
                            app.resident_frame_security
                        ) {
                            {
                                scope = existing.scope;
                                browser_origin_nonce =
                                    existing.browser_origin_nonce;
                                browser_origin_authority_epoch =
                                    existing.browser_origin_authority_epoch;
                            };
                        } else {
                            let nextEpoch = nextBrowserOriginAuthorityEpoch(
                                existing.browser_origin_authority_epoch,
                                issuanceCanisterVersion,
                            );
                            {
                                scope = existing.scope;
                                browser_origin_nonce = originNonce(
                                    originEpoch,
                                    app.app_id,
                                    existing.scope.installation_uid,
                                    nextEpoch,
                                );
                                browser_origin_authority_epoch = nextEpoch;
                            };
                        };
                    };
                    case null {
                        let uid = mem.next_installation_uid;
                        assert (uid != 0);
                        mem.next_installation_uid += 1;
                        {
                            scope = {
                                app_id = app.app_id;
                                installation_uid = uid;
                            };
                            browser_origin_nonce = originNonce(
                                originEpoch,
                                app.app_id,
                                uid,
                                1,
                            );
                            browser_origin_authority_epoch = 1;
                        };
                    };
                };
                {
                    scope = identity.scope;
                    version = app.version;
                    deployment_id = deploymentId;
                    capability_plan_fingerprint = app.capability_plan_fingerprint;
                    resident_frame_security = app.resident_frame_security;
                    browser_origin_nonce = identity.browser_origin_nonce;
                    browser_origin_authority_epoch =
                        identity.browser_origin_authority_epoch;
                };
            },
        );
    };

    func removedInstances(
        committed : [Types.AppInstance],
        target : [Types.AppInstance],
    ) : [Types.AppInstance] {
        Array.filter<Types.AppInstance>(
            committed,
            func(instance) {
                Memory.findApp(target, instance.scope.app_id) == null;
            },
        );
    };

    // Deployment ids change for every actor build, including an unrelated app
    // install. Install-time defaults must therefore key only off an app being
    // newly installed or changing its authored runtime declaration. This
    // preserves a user's later reservation revocation across unrelated
    // installs while still applying defaults on a real app update.
    public func changedInstances(
        committed : [Types.AppInstance],
        target : [Types.AppInstance],
    ) : [Types.AppInstance] {
        Array.filter<Types.AppInstance>(
            target,
            func(instance) {
                switch (Memory.findApp(
                    committed,
                    instance.scope.app_id,
                )) {
                    case null true;
                    case (?previous) {
                        not CapabilityScope.equal(
                            previous.scope,
                            instance.scope,
                        ) or
                        previous.version != instance.version or
                        previous.capability_plan_fingerprint !=
                            instance.capability_plan_fingerprint or
                        previous.resident_frame_security !=
                            instance.resident_frame_security;
                    };
                };
            },
        );
    };

    func isReconciledTransition(journal : Types.Journal) : Bool {
        var nextAllocated = Nat64.toNat(journal.allocation_start_uid);
        for (target in journal.target_app_instances.vals()) {
            switch (Memory.findApp(
                journal.committed_app_instances,
                target.scope.app_id,
            )) {
                case (?committed) {
                    if (
                        committed.scope != target.scope or
                        (
                            committed.resident_frame_security ==
                            target.resident_frame_security and (
                                committed.browser_origin_nonce !=
                                target.browser_origin_nonce or
                                committed.browser_origin_authority_epoch !=
                                target.browser_origin_authority_epoch
                            )
                        ) or
                        (
                            committed.resident_frame_security !=
                            target.resident_frame_security and
                            (
                                committed.browser_origin_authority_epoch ==
                                NAT64_MAX or
                                target.browser_origin_authority_epoch <=
                                committed.browser_origin_authority_epoch
                            )
                        ) or
                        target.version < committed.version
                    ) return false;
                };
                case null {
                    if (
                        Nat64.toNat(target.scope.installation_uid) !=
                        nextAllocated
                    ) return false;
                    nextAllocated += 1;
                };
            };
        };
        true;
    };

    func expectedNextInstallationUid(journal : Types.Journal) : Nat {
        var nextAllocated = Nat64.toNat(journal.allocation_start_uid);
        for (target in journal.target_app_instances.vals()) {
            if (
                Memory.findApp(
                    journal.committed_app_instances,
                    target.scope.app_id,
                ) == null
            ) nextAllocated += 1;
        };
        nextAllocated;
    };

    func allocatorAboveInventory(
        nextUid : Nat64,
        inventory : [Types.AppInstance],
    ) : Bool {
        if (nextUid == 0) return false;
        for (instance in inventory.vals()) {
            if (instance.scope.installation_uid >= nextUid) return false;
        };
        true;
    };

    // A successful update increments the IC's non-rollbackable canister
    // version. Reserving one complete app-inventory lane per begin therefore
    // keeps identities minted after a snapshot restore disjoint from every
    // identity that a discarded branch could have minted in one begin.
    public func installationUidLaneStart(canisterVersion : Nat64) : Nat64 {
        let laneSize = Nat64.fromNat(Limits.MAX_APP_INSTANCES + 1);
        // Reserve enough room for all 256 target applications and for the
        // allocator's exclusive next value without overflowing Nat64.
        if (
            canisterVersion >
            (NAT64_MAX - laneSize) / laneSize
        ) {
            Runtime.trap("Browser-origin installation uid lane exhausted");
        };
        canisterVersion * laneSize + 1;
    };

    // Highest valid exclusive allocator value after assigning every app in a
    // single canister-version lane. Allocated installation uids are strictly
    // below this bound; equality is valid only after all 256 slots were used.
    public func installationUidLaneNextLimit(
        canisterVersion : Nat64,
    ) : Nat64 {
        installationUidLaneStart(canisterVersion) +
        Nat64.fromNat(Limits.MAX_APP_INSTANCES);
    };

    public func nextBrowserOriginAuthorityEpoch(
        existing : Nat64,
        canisterVersion : Nat64,
    ) : Nat64 {
        if (existing == NAT64_MAX or canisterVersion == NAT64_MAX) {
            Runtime.trap("Browser-origin authority epoch exhausted");
        };
        let afterExisting = existing + 1;
        let afterCanisterVersion = canisterVersion + 1;
        if (afterExisting > afterCanisterVersion) {
            afterExisting;
        } else {
            afterCanisterVersion;
        };
    };

    func originNonce(
        originEpoch : Nat64,
        appId : Text,
        uid : Nat64,
        authorityEpoch : Nat64,
    ) : Text {
        let digest = Sha256.fromBlob(
            #sha256,
            Text.encodeUtf8(
                ORIGIN_NONCE_DOMAIN # "\00" # Nat64.toText(originEpoch) #
                "\00" # appId # "\00" # Nat64.toText(uid) #
                "\00" # Nat64.toText(authorityEpoch)
            ),
        );
        var result = "";
        var count = 0;
        for (byte in digest.values()) {
            if (count < 16) {
                let value = Nat8.toNat(byte);
                result #= HEX[value / 16] # HEX[value % 16];
            };
            count += 1;
        };
        assert (result.size() == 32);
        result;
    };

    func isCanonicalRemovedApps(appIds : [Text]) : Bool {
        var previous : ?Text = null;
        for (appId in appIds.vals()) {
            if (not isAppId(appId)) return false;
            switch (previous) {
                case (?prior) {
                    if (Text.compare(prior, appId) != #less) return false;
                };
                case null {};
            };
            previous := ?appId;
        };
        true;
    };

    func stagingPrefix(deploymentId : Text) : Text {
        "/system/staging/" # deploymentId # "/";
    };

    func dispatchMarkerPath(deploymentId : Text) : Text {
        stagingPrefix(deploymentId) # "dispatched";
    };

    func moduleGcPath(deploymentId : Text) : Text {
        stagingPrefix(deploymentId) # "module-gc";
    };

    public func isDispatchMarkerPath(path : Text) : Bool {
        Text.startsWith(path, #text "/system/staging/") and
        Text.endsWith(path, #text "/dispatched");
    };

    func isDeploymentId(value : Text) : Bool {
        if (value.size() != 32) return false;
        for (char in value.chars()) {
            if (not ((char >= '0' and char <= '9') or (char >= 'a' and char <= 'f'))) {
                return false;
            };
        };
        true;
    };

    func isRunningDeploymentId(value : Text) : Bool {
        value == "development" or isDeploymentId(value);
    };

    func isModulePath(value : Text) : Bool {
        let ?hash = Text.stripEnd(value, #text ".mo") else return false;
        if (hash.size() != 64) return false;
        for (char in hash.chars()) {
            if (not ((char >= '0' and char <= '9') or (char >= 'a' and char <= 'f'))) {
                return false;
            };
        };
        true;
    };

    func isFingerprint(value : Text) : Bool {
        if (value.size() != 64) return false;
        for (char in value.chars()) {
            if (not ((char >= '0' and char <= '9') or (char >= 'a' and char <= 'f'))) {
                return false;
            };
        };
        true;
    };

    func isAppId(value : Text) : Bool {
        CapabilityScope.validAppId(value);
    };
};
