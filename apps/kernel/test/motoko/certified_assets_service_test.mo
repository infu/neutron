import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import CapabilityTypes "../../backend/capabilities/Types";
import Allocator "../../backend/certified_assets/Allocator";
import Forest "../../backend/certified_assets/AuthenticatedForest";
import Codec "../../backend/certified_assets/Codec";
import Service "../../backend/certified_assets/Service";
import Types "../../backend/certified_assets/Types";
import Cert "../../backend/certified_http";

let canisterId = "aaaaa-aa";
let scope : Types.AppScope = {
    app_id = "sample";
    installation_uid = 7;
};
let staleScope : Types.AppScope = {
    app_id = "sample";
    installation_uid = 6;
};

func repeated(byte : Nat8, count : Nat) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(count, func(_index) { byte }));
};

func nonce(byte : Nat8) : Blob { repeated(byte, 16) };

func collection(
    id : Text,
    mount : Text,
    kind : Text,
    pathPrefix : ?Text,
    exactPath : ?Text,
) : Types.AuthoredCollectionDeclaration {
    {
        id;
        mount;
        kind;
        path_prefix = pathPrefix;
        exact_path = exactPath;
        max_object_bytes = ?4_096;
    };
};

func declaration() : Types.AppDeclaration {
    {
        app_scope = scope;
        certified_assets = ?{
            api = Service.API_VERSION;
            max_entries = 32;
            max_committed_bytes = 65_536;
            max_object_bytes = 4_096;
            max_pending_stages = 1;
            max_staged_bytes = 4_096;
            max_batch_operations = 4;
            max_batch_bytes = 16_384;
            max_idempotency_receipts = 64;
            collections = [
                collection(
                    "immutable",
                    "objects",
                    "immutable_blob",
                    ?"/immutable/",
                    null,
                ),
                collection(
                    "mutable_exact",
                    "records",
                    "mutable_blob",
                    null,
                    ?"/current",
                ),
                collection(
                    "mutable_key",
                    "records",
                    "mutable_blob",
                    ?"/key/",
                    null,
                ),
                collection(
                    "publication",
                    "downloads",
                    "publication",
                    null,
                    null,
                ),
            ];
        };
    };
};

func declarationFor(candidate : Types.AppScope) : Types.AppDeclaration {
    let base = declaration();
    { base with app_scope = candidate };
};

func allowed(
    _scope : CapabilityTypes.AppScope,
    kind : CapabilityTypes.CapabilityKind,
    resource : Text,
) : Bool {
    (kind == #certified_assets and resource == "default") or
    kind == #certified_read_routes;
};

let registry : CapabilityTypes.RuntimeRegistry = {
    allowed;
    lease = func(
        _scope : CapabilityTypes.AppScope,
        _kind : CapabilityTypes.CapabilityKind,
        _resource : Text,
    ) : ?CapabilityTypes.RuntimeLease {
        ?{ active = func() { true } };
    };
    record = func(
        _scope : CapabilityTypes.AppScope,
        _kind : CapabilityTypes.CapabilityKind,
        _resource : Text,
        _operation : Text,
        _outcome : CapabilityTypes.CapabilityOutcome,
    ) : Bool { true };
};

func certification(memory : Types.Memory) : Service.Certification {
    let tree = Cert.PersistentCertificationTree(
        memory.authenticated_forest,
    );
    func commit() : Bool {
        switch (Forest.commit(memory.authenticated_forest)) {
            case (#ok(receipt)) receipt.attached_root_changed;
            case (#err(error)) Runtime.trap(debug_show(error));
        };
    };
    object {
        public func beginV2PublicationBatch() : () {};
        public func finishV2PublicationBatch() : Bool { false };
        public func applyV2(mutations : [Cert.V2Mutation]) : Bool {
            tree.applyV2(mutations);
            commit();
        };
        public func retireV2(
            inputs : [Cert.RetireMountV2],
        ) : [Cert.DetachedV2] {
            let detached = tree.retireV2(inputs);
            ignore commit();
            detached;
        };
        public func detachV2(
            basePath : Text,
            wildcard : [Cert.OwnerResponses],
        ) : Cert.DetachedV2 {
            let detached = tree.detachV2(basePath, wildcard);
            ignore commit();
            detached;
        };
        public func attachV2(
            detached : Cert.DetachedV2,
            wildcard : [Cert.OwnerResponses],
        ) : Bool {
            tree.attachV2(detached, wildcard);
            commit();
        };
        public func applyDetachedV2(
            detached : Cert.DetachedV2,
            mutations : [Cert.V2Mutation],
        ) : (Cert.DetachedV2, Bool) {
            let updated = tree.applyDetachedV2(detached, mutations);
            ignore commit();
            (
                updated,
                updated.token_fingerprint != detached.token_fingerprint,
            );
        };
        public func discardDetachedV2(detached : Cert.DetachedV2) : Bool {
            tree.discardDetachedV2(detached);
            ignore commit();
            true;
        };
        public func syncV2MountCatalog(
            id : Text,
            basePath : Text,
            detached : ?Cert.DetachedV2,
        ) : () {
            tree.syncMountCatalog(id, basePath, detached);
            ignore commit();
        };
        public func syncV2CollectionCatalog(
            id : Text,
            canonicalPath : Text,
            exact : Bool,
            detached : ?Cert.DetachedV2,
        ) : () {
            tree.syncCollectionCatalog(
                id,
                canonicalPath,
                exact,
                detached,
            );
            ignore commit();
        };
        public func v2MountCatalogMatches(
            id : Text,
            basePath : Text,
            detached : ?Cert.DetachedV2,
        ) : Cert.V2CatalogMatch {
            tree.mountCatalogMatches(id, basePath, detached);
        };
        public func v2CollectionCatalogMatches(
            id : Text,
            canonicalPath : Text,
            exact : Bool,
            detached : ?Cert.DetachedV2,
        ) : Cert.V2CatalogMatch {
            tree.collectionCatalogMatches(
                id,
                canonicalPath,
                exact,
                detached,
            );
        };
        public func v2CatalogSnapshot() : ?Cert.V2CatalogSnapshot {
            tree.catalogSnapshot();
        };
        public func removeV2MountCatalog(id : Text) : () {
            tree.removeMountCatalog(id);
            ignore commit();
        };
        public func removeV2CollectionCatalog(id : Text) : () {
            tree.removeCollectionCatalog(id);
            ignore commit();
        };
    };
};

func testService(memory : Types.Memory) : Service.Service {
    Service.Service(
        memory,
        certification(memory),
        canisterId,
        func(_candidate : Types.AppScope) : Bool { true },
        func() : Bool { true },
        registry,
        func() : Nat { 1_000_000_000_000 },
        func() : Nat64 { 1_000_000_000_000 },
    );
};

func expectError<T>(
    result : { #ok : T; #err : Types.Error },
    expected : Types.Error,
) : () {
    switch (result) {
        case (#err(actual)) assert (actual == expected);
        case (#ok(_)) Runtime.trap("Expected certified-assets error");
    };
};

func scopeInfo(
    capability : Types.CertifiedAssetsV2,
) : Types.ScopeInfo {
    switch (capability.scope_info()) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap(debug_show(error));
    };
};

func kindFor(info : Types.ScopeInfo, id : Text) : Types.CollectionKind {
    for (collectionInfo in info.collections.vals()) {
        if (collectionInfo.id == id) return collectionInfo.kind;
    };
    Runtime.trap("Collection missing from scope info");
};

func commit(
    capability : Types.CertifiedAssetsV2,
    input : Types.CommitBatchInput,
) : Types.BatchReceipt {
    switch (capability.commit_batch(input)) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap(debug_show(error));
    };
};

func committedIdentity(receipt : Types.BatchReceipt) : Types.RecordIdentity {
    let #put(value) = receipt.operations[0] else {
        Runtime.trap("Expected put receipt");
    };
    value.lifecycle.committed;
};

func present(result : ?Types.ResolveResult) : Types.Resolved {
    let ?#present(value) = result else {
        Runtime.trap("Expected certified present response");
    };
    value;
};

func absent(result : ?Types.ResolveResult) : Types.ResolvedAbsence {
    let ?#absent(value) = result else {
        Runtime.trap("Expected certified absent response");
    };
    value;
};

let memory = Service.initMemory();
let service = Service.Service(
    memory,
    certification(memory),
    canisterId,
    func(candidate : Types.AppScope) : Bool { candidate == scope },
    func() : Bool { true },
    registry,
    func() : Nat { 1_000_000_000_000 },
    func() : Nat64 { 1_000_000_000_000 },
);

service.configure([declaration()]);
service.commitConfiguration();

// Cross-language parity marker for certifiedAssetsPhysicalReservation in
// neutron-tools. Any reservation-formula change must update both engines.
assert (memory.total_installed_charged_reservation == 756_649);
assert (memory.total_installed_arena_reservation == 161_496);
assert (memory.total_installed_arena_extent_reservation == 52);

let assets = service.capability(scope);
let info = scopeInfo(assets);
assert (info.installation_generation == scope.installation_uid);
assert (info.collections.size() == 4);
assert (kindFor(info, "publication") == #publication);
assert (kindFor(info, "immutable") == #immutable_blob);
assert (kindFor(info, "mutable_key") == #mutable_blob);
assert (kindFor(info, "mutable_exact") == #mutable_blob);
expectError(
    service.capability(staleScope).scope_info(),
    #stale_scope,
);

// An immutable blob can be committed inline only at its body digest.
let immutableBody = Text.encodeUtf8("immutable body");
let immutableDigest = Codec.sha256(immutableBody);
let immutableTarget : Types.Target = {
    collection = "immutable";
    collection_generation = scope.installation_uid;
    locator = #body_sha256({ digest = immutableDigest });
};
let immutableInput : Types.CommitBatchInput = {
    nonce = nonce(0x11);
    operations = [#put({
        target = immutableTarget;
        condition = #absent;
        body = #inline(immutableBody);
    })];
    requires_present_after = [];
};
let immutableReceipt = commit(assets, immutableInput);
assert (assets.commit_batch(immutableInput) == #ok(immutableReceipt));
let immutableIdentity = committedIdentity(immutableReceipt);
assert (immutableIdentity.content_tag == immutableDigest);

let immutablePath =
    "/app/sample/_route/objects/immutable/" # Codec.hex(immutableDigest);
let immutableResponse = present(service.resolve(
    canisterId # ".icp0.io",
    immutablePath,
    "GET",
    #absent,
    false,
));
assert (immutableResponse.kind == #immutable_blob);
assert (immutableResponse.blocks[0].body == immutableBody);
assert (
    service.resolve(
        canisterId # ".icp0.io",
        immutablePath,
        "HEAD",
        #absent,
        false,
    ) == null
);
assert (
    service.resolve(
        canisterId # ".icp0.io",
        immutablePath,
        "GET",
        #start(0),
        false,
    ) == ?#bad_request
);

// Mutable keyed and singleton records use the same closed CAS protocol.
let mutableKeyTarget : Types.Target = {
    collection = "mutable_key";
    collection_generation = scope.installation_uid;
    locator = #key32({ key = repeated(0x22, 32) });
};
let firstMutable = committedIdentity(commit(assets, {
    nonce = nonce(0x21);
    operations = [#put({
        target = mutableKeyTarget;
        condition = #absent;
        body = #inline(Text.encodeUtf8("v1"));
    })];
    requires_present_after = [];
}));
let secondMutable = committedIdentity(commit(assets, {
    nonce = nonce(0x22);
    operations = [#put({
        target = mutableKeyTarget;
        condition = #match({
            revision = firstMutable.kernel_revision;
            content_tag = firstMutable.content_tag;
        });
        body = #inline(Text.encodeUtf8("v2"));
    })];
    requires_present_after = [];
}));
assert (secondMutable.kernel_revision == firstMutable.kernel_revision + 1);
expectError(
    assets.commit_batch({
        nonce = nonce(0x23);
        operations = [#put({
            target = mutableKeyTarget;
            condition = #match({
                revision = firstMutable.kernel_revision;
                content_tag = firstMutable.content_tag;
            });
            body = #inline(Text.encodeUtf8("stale"));
        })];
        requires_present_after = [];
    }),
    #conflict({
        current = ?{
            collection_generation = scope.installation_uid;
            kernel_revision = secondMutable.kernel_revision;
            content_tag = secondMutable.content_tag;
            body_bytes = secondMutable.body_bytes;
        };
    }),
);

let exactTarget : Types.Target = {
    collection = "mutable_exact";
    collection_generation = scope.installation_uid;
    locator = #exact_path;
};
let exactIdentity = committedIdentity(commit(assets, {
    nonce = nonce(0x24);
    operations = [#put({
        target = exactTarget;
        condition = #absent;
        body = #inline(Text.encodeUtf8("singleton"));
    })];
    requires_present_after = [];
}));
assert (exactIdentity.kernel_revision == 1);

let deleteReceipt = assets.commit_batch({
    nonce = nonce(0x25);
    operations = [#delete({
        target = mutableKeyTarget;
        condition = {
            revision = secondMutable.kernel_revision;
            content_tag = secondMutable.content_tag;
        };
    })];
    requires_present_after = [];
});
assert (deleteReceipt == assets.commit_batch({
    nonce = nonce(0x25);
    operations = [#delete({
        target = mutableKeyTarget;
        condition = {
            revision = secondMutable.kernel_revision;
            content_tag = secondMutable.content_tag;
        };
    })];
    requires_present_after = [];
}));
switch (assets.record_status(mutableKeyTarget)) {
    case (#ok(#recently_deleted(_))) {};
    case (_) Runtime.trap("Expected recent mutable deletion");
};

// Publications allocate an opaque target, require an ordered stage, and retain
// their fixed presentation in the certified response.
assert (service.publicationEntropyFingerprint() == null);
let ?entropyFingerprint = service.initializePublicationEntropy(
    repeated(0x33, 32),
) else Runtime.trap("Expected publication entropy initialization");
assert (entropyFingerprint.size() == 32);
assert (
    service.initializePublicationEntropy(repeated(0x44, 32)) ==
    ?entropyFingerprint
);
let publicationBody = Text.encodeUtf8("published body");
let begin = switch (assets.begin_stage({
    nonce = nonce(0x31);
    target = #allocate_publication({
        collection = "publication";
        collection_generation = scope.installation_uid;
        filename = "note.txt";
        presentation = #inline_text;
    });
    expected_bytes = publicationBody.size();
})) {
    case (#ok(value)) value;
    case (#err(error)) Runtime.trap(debug_show(error));
};
assert (begin.geometry.block_count == 1);
let chunk = switch (assets.put_chunk({
    stage_id = begin.stage_id;
    index = 0;
    body = publicationBody;
})) {
    case (#ok(value)) value;
    case (#err(error)) Runtime.trap(debug_show(error));
};
assert (chunk.complete and chunk.accepted == #new);
let ?publicationTarget = begin.identity.computed_target else {
    Runtime.trap("Publication stage did not allocate a target");
};
let publicationIdentity = committedIdentity(commit(assets, {
    nonce = nonce(0x32);
    operations = [#put({
        target = publicationTarget;
        condition = #absent;
        body = #stage(begin.stage_id);
    })];
    requires_present_after = [];
}));
assert (publicationIdentity.body_bytes == publicationBody.size());

let publicationPath = switch (publicationTarget.locator) {
    case (#publication(value)) {
        "/app/sample/_route/downloads/" #
        Codec.hex(value.publication_id) # "/" # value.filename;
    };
    case (_) Runtime.trap("Expected publication locator");
};
let publicationResponse = present(service.resolve(
    canisterId # ".icp0.io",
    publicationPath,
    "GET",
    #absent,
    false,
));
assert (publicationResponse.kind == #publication);
assert (publicationResponse.presentation == ?#inline_text);
assert (publicationResponse.blocks[0].body == publicationBody);
assert (
    service.resolve(
        canisterId # ".icp0.io",
        publicationPath,
        "GET",
        #unsupported,
        false,
    ) == ?#bad_request
);
assert (
    service.resolve(
        canisterId # ".icp0.io",
        publicationPath,
        "HEAD",
        #unsupported,
        false,
    ) == ?#bad_request
);
assert (
    service.resolve(
        canisterId # ".icp0.io",
        publicationPath,
        "GET",
        #start(publicationBody.size()),
        false,
    ) == ?#bad_request
);
assert (
    service.resolve(
        canisterId # ".icp0.io",
        publicationPath,
        "HEAD",
        #start(publicationBody.size()),
        false,
    ) == ?#bad_request
);
assert (
    service.resolve(
        "untrusted.example",
        publicationPath,
        "GET",
        #absent,
        false,
    ) == null
);
ignore absent(service.resolve(
    canisterId # ".icp0.io",
    "/app/sample/_route/downloads/missing",
    "GET",
    #absent,
    false,
));

let diagnostics = service.diagnostics();
assert (diagnostics.allocator.header_valid);
assert (diagnostics.authenticated_forest.healthy);
assert (
    diagnostics.implementation_binding.allocator_layout_fingerprint ==
    Allocator.layoutFingerprint()
);

// The actor-wide stage semaphore is actual-use admission, independent of app
// identity. Four neutral scopes can stage concurrently; the fifth is rejected
// until aborting or committing one of the admitted stages releases its slot.
let semaphoreScopes : [Types.AppScope] = [
    { app_id = "sample_a"; installation_uid = 1 },
    { app_id = "sample_b"; installation_uid = 1 },
    { app_id = "sample_c"; installation_uid = 1 },
    { app_id = "sample_d"; installation_uid = 1 },
    { app_id = "sample_e"; installation_uid = 1 },
];
let semaphoreMemory = Service.initMemory();
let semaphoreService = Service.Service(
    semaphoreMemory,
    certification(semaphoreMemory),
    canisterId,
    func(_candidate : Types.AppScope) : Bool { true },
    func() : Bool { true },
    registry,
    func() : Nat { 1_000_000_000_000 },
    func() : Nat64 { 1_000_000_000_000 },
);
semaphoreService.configure(
    Array.map<Types.AppScope, Types.AppDeclaration>(
        semaphoreScopes,
        declarationFor,
    )
);
semaphoreService.commitConfiguration();

func beginSemaphoreStage(
    candidate : Types.AppScope,
    nonceByte : Nat8,
) : Types.BeginStageResult {
    semaphoreService.capability(candidate).begin_stage({
        nonce = nonce(nonceByte);
        target = #derive_body_sha256({
            collection = "immutable";
            collection_generation = candidate.installation_uid;
        });
        expected_bytes = 1;
    });
};

func begun(result : Types.BeginStageResult) : Types.BeginStageOk {
    switch (result) {
        case (#ok(value)) value;
        case (#err(error)) Runtime.trap(debug_show(error));
    };
};

let stageA = begun(beginSemaphoreStage(semaphoreScopes[0], 0x61));
let stageB = begun(beginSemaphoreStage(semaphoreScopes[1], 0x62));
ignore begun(beginSemaphoreStage(semaphoreScopes[2], 0x63));
ignore begun(beginSemaphoreStage(semaphoreScopes[3], 0x64));
expectError(beginSemaphoreStage(semaphoreScopes[4], 0x65), #quota);

let assetsA = semaphoreService.capability(semaphoreScopes[0]);
let assetsB = semaphoreService.capability(semaphoreScopes[1]);
// A capability cannot address another scope's globally allocated stage id.
assert (assetsA.stage_status(stageB.stage_id) == #ok(#unknown));
expectError(
    assetsA.put_chunk({
        stage_id = stageB.stage_id;
        index = 0;
        body = Text.encodeUtf8("x");
    }),
    #not_found,
);
assert (assetsA.abort_stage(stageA.stage_id) == #ok);
ignore begun(beginSemaphoreStage(semaphoreScopes[4], 0x65));

let stagedBodyB = Text.encodeUtf8("b");
let stagedChunkB = switch (
    assetsB.put_chunk({
        stage_id = stageB.stage_id;
        index = 0;
        body = stagedBodyB;
    })
) {
    case (#ok(value)) value;
    case (#err(error)) Runtime.trap(debug_show(error));
};
assert (stagedChunkB.accepted == #new and stagedChunkB.complete);
let immutableTargetB : Types.Target = {
    collection = "immutable";
    collection_generation = semaphoreScopes[1].installation_uid;
    locator = #body_sha256({ digest = Codec.sha256(stagedBodyB) });
};
let immutableIdentityB = committedIdentity(commit(assetsB, {
    nonce = nonce(0x72);
    operations = [#put({
        target = immutableTargetB;
        condition = #absent;
        body = #stage(stageB.stage_id);
    })];
    requires_present_after = [];
}));
switch (assetsB.record_status(immutableTargetB)) {
    case (#ok(#present(_))) {};
    case (_) Runtime.trap("Expected record in its owning scope");
};
// The same target and generation remain absent through another live scope's
// capability, and even the owning record's exact CAS identity grants no
// cross-scope deletion authority.
assert (
    assetsA.record_status(immutableTargetB) ==
    #ok(#absent({
        collection_generation = semaphoreScopes[0].installation_uid;
    }))
);
expectError(assetsA.commit_batch({
    nonce = nonce(0x73);
    operations = [#delete({
        target = immutableTargetB;
        condition = {
            revision = immutableIdentityB.kernel_revision;
            content_tag = immutableIdentityB.content_tag;
        };
    })];
    requires_present_after = [];
}), #not_found);

// Give the record-owning scope another live stage, then retire it. Retirement
// must invalidate its captured capability immediately, drain all record/stage
// state through bounded pages, and release the actor-wide stage slot.
ignore begun(beginSemaphoreStage(semaphoreScopes[1], 0x66));
assert (semaphoreService.settingsRetireScope(semaphoreScopes[1]) == #ok);
expectError(assetsB.scope_info(), #stale_scope);
var retirementComplete = false;
var retirementPages = 0;
while (not retirementComplete and retirementPages < 64) {
    let page = semaphoreService.settingsMaintenancePage(semaphoreScopes[1]);
    retirementPages += 1;
    if (not page.has_more) retirementComplete := true;
};
assert (retirementComplete);
expectError(assetsB.scope_info(), #stale_scope);
ignore begun(beginSemaphoreStage(semaphoreScopes[0], 0x67));

// A capability-free target has no certified-assets declaration. Empty and
// explicit-null inventories are both valid and require no phantom scope.
let capabilityFreeMemory = Service.initMemory();
let capabilityFreeService = testService(capabilityFreeMemory);
capabilityFreeService.configure([]);
assert (capabilityFreeService.configurationCommitReady());
capabilityFreeService.commitConfiguration();

let explicitNullMemory = Service.initMemory();
let explicitNullService = testService(explicitNullMemory);
explicitNullService.configure([{
    app_scope = { app_id = "empty"; installation_uid = 1 };
    certified_assets = null;
}]);
assert (explicitNullService.configurationCommitReady());
explicitNullService.commitConfiguration();

let retireAlpha : Types.AppScope = {
    app_id = "alpha";
    installation_uid = 1;
};
let retireBravo : Types.AppScope = {
    app_id = "bravo";
    installation_uid = 1;
};

// Aggregate readiness counts every omitted scope. With one global cleanup slot
// left, either retirement fits independently but the two-scope transaction does
// not. This state change models maintenance activity after target activation.
let aggregateMemory = Service.initMemory();
let aggregateInitial = testService(aggregateMemory);
aggregateInitial.configure([
    declarationFor(retireAlpha),
    declarationFor(retireBravo),
]);
aggregateInitial.commitConfiguration();
let aggregateRemoval = testService(aggregateMemory);
aggregateRemoval.configure([]);
assert (aggregateRemoval.configurationCommitReady());
let aggregateReservedHeadroom =
    aggregateMemory.global_reserved_charged_headroom;
aggregateMemory.global_reserved_charged_headroom :=
    Service.GLOBAL_CHARGED_BYTES_MAX_V3;
assert (not aggregateRemoval.configurationCommitReady());
aggregateMemory.global_reserved_charged_headroom :=
    aggregateReservedHeadroom;
aggregateMemory.global_cleanup_jobs :=
    Service.MAX_GLOBAL_CLEANUP_JOBS - 1;
assert (not aggregateRemoval.configurationCommitReady());

func widenedDeclaration(
    candidate : Types.AppScope,
) : Types.AppDeclaration {
    let base = declarationFor(candidate);
    let ?store = base.certified_assets else {
        Runtime.trap("Expected certified-assets declaration");
    };
    {
        base with
        certified_assets = ?{
            store with
            max_entries = store.max_entries + 1;
        };
    };
};

// The projection retires omitted scopes before testing a retained scope's
// widening. At the current global ceiling the widening alone would not fit,
// while retiring alpha releases enough reservation for the combined target.
let replacementMemory = Service.initMemory();
let replacementInitial = testService(replacementMemory);
replacementInitial.configure([
    declarationFor(retireAlpha),
    declarationFor(retireBravo),
]);
replacementInitial.commitConfiguration();
replacementMemory.total_charged_bytes :=
    Service.GLOBAL_CHARGED_BYTES_MAX_V3 -
    Allocator.ARENA_METADATA_RESERVE_V3 -
    replacementMemory.global_reserved_charged_headroom;
assert (
    replacementMemory.total_charged_bytes +
        replacementMemory.global_reserved_charged_headroom +
        Allocator.ARENA_METADATA_RESERVE_V3 ==
        Service.GLOBAL_CHARGED_BYTES_MAX_V3
);
let replacementTarget = testService(replacementMemory);
replacementTarget.configure([widenedDeclaration(retireBravo)]);
assert (replacementTarget.configurationCommitReady());
replacementTarget.commitConfiguration();
expectError(
    replacementTarget.capability(retireAlpha).scope_info(),
    #stale_scope,
);
assert (
    scopeInfo(replacementTarget.capability(retireBravo))
        .collections[0].manifest_limits.entries == 33
);
