import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Assets "../../backend/assets";
import BackendCallsMemory "../../backend/backend_calls/Memory";
import BackendCallsService "../../backend/backend_calls/Service";
import BackendCallTypes "../../backend/backend_calls/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import InstallMemory "../../backend/install/Memory";
import InstallLimits "../../backend/install/Limits";
import InstallService "../../backend/install/Service";
import InstallTypes "../../backend/install/Types";

let HASH_ZERO = "0000000000000000000000000000000000000000000000000000000000000000";
let HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let HASH_F = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
let OLD_DEPLOYMENT = "11111111111111111111111111111111";
let DEPLOYMENT = "0123456789abcdef0123456789abcdef";
let NEXT_DEPLOYMENT = "22222222222222222222222222222222";
let REINSTALL_DEPLOYMENT = "33333333333333333333333333333333";
let LEGACY_DEPLOYMENT = "44444444444444444444444444444444";
let ORIGIN_EPOCH : Nat64 = 17;
let DEPLOYMENT_BUILD_RECORD_PATH =
    "/system/deployment-build-record.json";

func stagingPrefix(deploymentId : Text) : Text {
    "/system/staging/" # deploymentId # "/";
};

func deploymentBuildRecordCopy(
    deploymentId : Text,
) : InstallTypes.AssetCopy {
    {
        source = stagingPrefix(deploymentId) #
            "deployment-build-record.json";
        target = DEPLOYMENT_BUILD_RECORD_PATH;
    };
};

func putAsset(
    store : Assets.Use,
    id : Text,
    content : Blob,
) : () {
    store.put({
        id;
        chunks = 1;
        content = [content];
        content_encoding = "identity";
        content_type = "application/octet-stream";
    });
};

assert (InstallLimits.MAX_APP_INSTANCES == 256);
assert (
    InstallService.removalCountWithinCommitBound(
        InstallLimits.MAX_APP_REMOVALS_PER_COMMIT
    )
);
assert (
    not InstallService.removalCountWithinCommitBound(
        InstallLimits.MAX_APP_REMOVALS_PER_COMMIT + 1
    )
);

func runtimeApp(
    appId : Text,
    version : Nat,
    fingerprint : Text,
) : InstallTypes.RuntimeApp {
    runtimeAppWithSecurity(
        appId,
        version,
        fingerprint,
        #credentialless_opaque_v1,
    );
};

func runtimeAppWithSecurity(
    appId : Text,
    version : Nat,
    fingerprint : Text,
    residentFrameSecurity : InstallTypes.ResidentFrameSecurity,
) : InstallTypes.RuntimeApp {
    {
        app_id = appId;
        version;
        capability_plan_fingerprint = fingerprint;
        resident_frame_security = residentFrameSecurity;
    };
};

let committedRuntime = [
    runtimeApp("mail", 100, HASH_A),
    runtimeApp("wallet", 100, HASH_F),
];
let targetRuntime = [
    // `hello` has no special capability. It is still a first-class member of
    // the complete target app-instance inventory.
    runtimeApp("hello", 100, HASH_ZERO),
    runtimeApp("wallet", 101, HASH_A),
];

assert (InstallService.isCanonicalRuntimeAppInventory(committedRuntime));
assert (not InstallService.isCanonicalRuntimeAppInventory([
    runtimeApp("wallet", 100, HASH_F),
    runtimeApp("mail", 100, HASH_A),
]));
assert (not InstallService.isCanonicalRuntimeAppInventory([
    runtimeApp("mail", 100, HASH_A),
    runtimeApp("mail", 101, HASH_F),
]));
assert (not InstallService.isCanonicalRuntimeAppInventory([
    runtimeApp("mail", 100, "short"),
]));
assert (not InstallService.isCanonicalRuntimeAppInventory([
    runtimeApp("mail", 99, HASH_A),
]));

let memory = InstallMemory.init();
InstallService.initializeFresh(
    memory,
    OLD_DEPLOYMENT,
    committedRuntime,
    ORIGIN_EPOCH,
);
assert (memory.next_installation_uid == 3);
assert (memory.committed_app_instances.size() == 2);
let ?mailInitial = InstallMemory.findApp(
    memory.committed_app_instances,
    "mail",
) else Runtime.trap("Mail instance missing");
let ?walletInitial = InstallMemory.findApp(
    memory.committed_app_instances,
    "wallet",
) else Runtime.trap("Wallet instance missing");
assert (mailInitial.scope.installation_uid == 1);
assert (walletInitial.scope.installation_uid == 2);
assert (mailInitial.browser_origin_nonce.size() == 32);
assert (mailInitial.browser_origin_nonce != walletInitial.browser_origin_nonce);
assert (mailInitial.browser_origin_authority_epoch == 1);
assert (walletInitial.browser_origin_authority_epoch == 1);
let sameDeclarationNewDeployment = {
    walletInitial with deployment_id = DEPLOYMENT;
};
assert (
    InstallService.changedInstances(
        [walletInitial],
        [sameDeclarationNewDeployment],
    ).size() == 0
);
let sameDeclarationNewScope = {
    sameDeclarationNewDeployment with
    scope = {
        app_id = "wallet";
        installation_uid = 99 : Nat64;
    };
};
let reinstalledSameDeclaration = InstallService.changedInstances(
    [walletInitial],
    [sameDeclarationNewScope],
);
assert (reinstalledSameDeclaration.size() == 1);
assert (reinstalledSameDeclaration[0].scope.installation_uid == 99);

// A full canister reinstall resets stable app identities. The IC's monotonic
// canister version becomes a new kernel epoch, so the same app/uid pair still
// receives a different browser origin without awaiting randomness in init.
let reinstalledCanisterMemory = InstallMemory.init();
InstallService.initializeFresh(
    reinstalledCanisterMemory,
    OLD_DEPLOYMENT,
    committedRuntime,
    18,
);
let ?mailAfterCanisterReinstall = InstallMemory.findApp(
    reinstalledCanisterMemory.committed_app_instances,
    "mail",
) else Runtime.trap("Reinstalled Mail instance missing");
assert (
    mailAfterCanisterReinstall.scope.installation_uid ==
    mailInitial.scope.installation_uid
);
assert (
    mailAfterCanisterReinstall.browser_origin_nonce !=
    mailInitial.browser_origin_nonce
);
assert (InstallMemory.scopeActive(memory, OLD_DEPLOYMENT, mailInitial.scope));
assert (InstallMemory.scopeActive(memory, OLD_DEPLOYMENT, walletInitial.scope));
assert (InstallMemory.deploymentCommitted(memory, OLD_DEPLOYMENT));

let validBegin : InstallTypes.BeginInput = {
    deployment_id = DEPLOYMENT;
    copies = [deploymentBuildRecordCopy(DEPLOYMENT)];
    clear_prefixes = [];
    target_app_inventory = targetRuntime;
};
assert (InstallService.isValidBeginInput(validBegin));
assert (InstallService.hasExactlyOneDeploymentBuildRecordCopy(validBegin));
assert (not InstallService.hasExactlyOneDeploymentBuildRecordCopy({
    validBegin with copies = [];
}));
assert (not InstallService.hasExactlyOneDeploymentBuildRecordCopy({
    validBegin with copies = [
        deploymentBuildRecordCopy(DEPLOYMENT),
        deploymentBuildRecordCopy(DEPLOYMENT),
    ];
}));
assert (not InstallService.hasExactlyOneDeploymentBuildRecordCopy({
    validBegin with copies = [{
        source = stagingPrefix(DEPLOYMENT) # "lookalike.json";
        target = DEPLOYMENT_BUILD_RECORD_PATH # "/extra";
    }];
}));
assert (InstallService.isValidBeginInput({
    validBegin with clear_prefixes = ["/pkg/legal/"];
}));
assert (InstallService.isValidBeginInput({
    validBegin with clear_prefixes = [
        "/system/deployment-build-record.json"
    ];
}));
assert (not InstallService.isValidBeginInput({
    validBegin with clear_prefixes = [
        "/system/deployment-build-record.json/extra"
    ];
}));
assert (not InstallService.isValidBeginInput({
    validBegin with clear_prefixes = ["/pkg/"];
}));
assert (not InstallService.isValidBeginInput({
    validBegin with clear_prefixes = ["/pkg/legal"];
}));
assert (not InstallService.isValidBeginInput({
    validBegin with clear_prefixes = ["/pkg/legal/archive/"];
}));

func capacityAppId(index : Nat) : Text {
    let suffix = Nat.toText(index);
    if (index < 10) {
        "capacity_app_00" # suffix;
    } else if (index < 100) {
        "capacity_app_0" # suffix;
    } else {
        "capacity_app_" # suffix;
    };
};

let exactCapacityInventory = Array.tabulate<InstallTypes.RuntimeApp>(
    InstallLimits.MAX_APP_INSTANCES,
    func(index) {
        runtimeApp(capacityAppId(index), 100, HASH_A);
    },
);
let overCapacityInventory = Array.tabulate<InstallTypes.RuntimeApp>(
    InstallLimits.MAX_APP_INSTANCES + 1,
    func(index) {
        runtimeApp(capacityAppId(index), 100, HASH_A);
    },
);
assert (InstallService.isValidBeginInput({
    validBegin with target_app_inventory = exactCapacityInventory;
}));
assert (not InstallService.isValidBeginInput({
    validBegin with target_app_inventory = overCapacityInventory;
}));

assert (not InstallService.isValidBeginInput({
    validBegin with deployment_id = "development";
}));
assert (not InstallService.isValidBeginInput({
    validBegin with target_app_inventory = [
        runtimeApp("wallet", 101, HASH_A),
        runtimeApp("hello", 100, HASH_ZERO),
    ];
}));

class CertificationProbe() {
    public var depth = 0;
    public var max_depth = 0;
    public var begin_count = 0;
    public var finish_count = 0;
    public var mutation_count = 0;
    public var publication_count = 0;
    var dirty = false;

    public func beginV2PublicationBatch() : () {
        begin_count += 1;
        depth += 1;
        if (depth > max_depth) max_depth := depth;
    };

    public func finishV2PublicationBatch() : Bool {
        assert (depth > 0);
        finish_count += 1;
        depth -= 1;
        if (depth > 0 or not dirty) return false;
        dirty := false;
        publication_count += 1;
        true;
    };

    public func putHash(_key : Text, _hash : Blob) : () {
        mutation_count += 1;
        dirty := true;
    };

    public func put(_key : Text, _value : Blob) : () {
        mutation_count += 1;
        dirty := true;
    };

    public func delete(_key : Text) : () {
        mutation_count += 1;
        dirty := true;
    };
};

let assetMemory = Assets.init();
let assets = Assets.use(assetMemory);
let cert = CertificationProbe();
let backendCalls : BackendCallTypes.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, BackendCallTypes.Reservation>();
};
var didCommit = false;
var removedInstances : [InstallTypes.AppInstance] = [];

func serviceFor(
    deploymentId : Text,
    active : [InstallTypes.RuntimeApp],
) : InstallService.Service {
    InstallService.Service(
        memory,
        assets,
        cert,
        backendCalls,
        deploymentId,
        active,
        func(_, _) { true },
        func(_, _) {},
        func(removed, _) {
            didCommit := true;
            removedInstances := removed;
        },
    );
};

let oldService = serviceFor(OLD_DEPLOYMENT, committedRuntime);
let deploymentRecordSource =
    deploymentBuildRecordCopy(DEPLOYMENT).source;
assert (not oldService.isPendingStagingPath(deploymentRecordSource));
assert (not oldService.copySourcesAvailable(validBegin));
putAsset(assets, deploymentRecordSource, "first-record");
assert (oldService.copySourcesAvailable(validBegin));
oldService.begin(validBegin);
assert (oldService.isPendingStagingPath(deploymentRecordSource));
assert (oldService.isPendingStagingPath(
    stagingPrefix(DEPLOYMENT) # "any-upload",
));
assert (not oldService.isPendingStagingPath(
    stagingPrefix(NEXT_DEPLOYMENT) # "any-upload",
));
assert (not oldService.isPendingStagingPath(DEPLOYMENT_BUILD_RECORD_PATH));
let ?pending = oldService.status() else Runtime.trap("Install status missing");
assert (pending.removed_apps == ["mail"]);
assert (pending.committed_app_instances == memory.committed_app_instances);
assert (pending.target_app_instances.size() == 2);
let ?helloPending = InstallMemory.findApp(
    pending.target_app_instances,
    "hello",
) else Runtime.trap("Hello target missing");
let ?walletPending = InstallMemory.findApp(
    pending.target_app_instances,
    "wallet",
) else Runtime.trap("Wallet target missing");
assert (helloPending.scope.installation_uid == 3);
assert (walletPending.scope == walletInitial.scope);
// An unrelated capability-plan change retains the resident-origin authority.
assert (walletPending.browser_origin_nonce == walletInitial.browser_origin_nonce);
assert (
    walletPending.browser_origin_authority_epoch ==
    walletInitial.browser_origin_authority_epoch
);
// Journal creation alone leaves the predecessor actor unchanged.
assert (InstallMemory.scopeActive(memory, OLD_DEPLOYMENT, mailInitial.scope));
assert (InstallMemory.scopeActive(memory, OLD_DEPLOYMENT, walletInitial.scope));
assert (InstallMemory.deploymentCommitted(memory, OLD_DEPLOYMENT));
assert (not InstallMemory.deploymentCommitted(memory, DEPLOYMENT));
// The activated target sees removed, changed, and target-only scopes as
// inactive until commit.
assert (not InstallMemory.scopeActive(memory, DEPLOYMENT, mailInitial.scope));
assert (not InstallMemory.scopeActive(memory, DEPLOYMENT, walletInitial.scope));
assert (not InstallMemory.scopeActive(memory, DEPLOYMENT, helloPending.scope));
assert (
    InstallMemory.appScopeForDeployment(memory, "mail", OLD_DEPLOYMENT) ==
    ?mailInitial.scope
);
assert (
    InstallMemory.appScopeForDeployment(memory, "hello", DEPLOYMENT) ==
    ?helloPending.scope
);
assert (
    InstallMemory.appScopeForDeployment(
        memory,
        "hello",
        "99999999999999999999999999999999",
    ) == null
);

// A pre-activation abort discards the staged snapshot, restores committed
// authority, and deliberately leaves a monotonic allocation gap.
oldService.abort({ deployment_id = DEPLOYMENT });
assert (oldService.status() == null);
assert (not oldService.isPendingStagingPath(deploymentRecordSource));
assert (assets.get(deploymentRecordSource) == null);
assert (memory.next_installation_uid == 4);
assert (memory.committed_app_instances == [mailInitial, walletInitial]);
assert (InstallMemory.scopeActive(memory, OLD_DEPLOYMENT, mailInitial.scope));
assert (InstallMemory.scopeActive(memory, OLD_DEPLOYMENT, walletInitial.scope));
assert (not didCommit);

putAsset(assets, deploymentRecordSource, "committed-record");
oldService.begin(validBegin);
assert (oldService.isPendingStagingPath(deploymentRecordSource));
let ?secondPending = oldService.status() else Runtime.trap("Second status missing");
let ?secondJournal = memory.pending else Runtime.trap("Second journal missing");
assert (InstallService.isValidJournal(secondJournal, ORIGIN_EPOCH));
let ?helloSecond = InstallMemory.findApp(
    secondPending.target_app_instances,
    "hello",
) else Runtime.trap("Second hello missing");
assert (helloSecond.scope.installation_uid == 4);
assert (helloSecond.browser_origin_nonce != helloPending.browser_origin_nonce);
assert (memory.next_installation_uid == 5);
assert (not InstallService.isValidJournal({
    secondJournal with allocation_start_uid = 3;
}, ORIGIN_EPOCH));
assert (not InstallService.isValidJournal({
    secondJournal with committed_app_instances = [
        { mailInitial with deployment_id = DEPLOYMENT },
        walletInitial,
    ];
}, ORIGIN_EPOCH));
assert (not InstallService.isValidJournal({
    secondJournal with target_app_instances = [
        helloSecond,
        { walletPending with
            scope = {
                app_id = "wallet";
                installation_uid = 99;
            };
        },
    ];
}, ORIGIN_EPOCH));
assert (not InstallService.isValidJournal({
    secondJournal with target_app_instances = [
        { helloSecond with
            browser_origin_nonce =
                "00000000000000000000000000000000";
        },
        walletPending,
    ];
}, ORIGIN_EPOCH));
assert (not InstallService.isValidJournal({
    secondJournal with target_app_instances = [
        { helloSecond with browser_origin_authority_epoch = 0 },
        walletPending,
    ];
}, ORIGIN_EPOCH));

// Actor activation reconstructs the service against the same stable journal.
// The target deployment is independently checked before any promotion.
InstallService.initializeFresh(memory, DEPLOYMENT, targetRuntime, 19);
let activated = serviceFor(DEPLOYMENT, targetRuntime);
var didCommitManagedMemory = false;
assert (
    InstallService.targetMatchesActiveRuntime(
        switch (memory.pending) {
            case (?journal) journal;
            case null Runtime.trap("Pending journal disappeared");
        },
        targetRuntime,
        DEPLOYMENT,
        ORIGIN_EPOCH,
    )
);
let changedInstances = activated.commit(
    { deployment_id = DEPLOYMENT },
    Principal.fromText("aaaaa-aa"),
    func(deploymentId) {
        assert (deploymentId == DEPLOYMENT);
        didCommitManagedMemory := true;
    },
);
assert (activated.status() == null);
assert (not activated.isPendingStagingPath(deploymentRecordSource));
assert (didCommit);
assert (didCommitManagedMemory);
var replayedManagedMemoryCommit = false;
let replayedChanges = activated.commit(
    { deployment_id = DEPLOYMENT },
    Principal.fromText("aaaaa-aa"),
    func(_) { replayedManagedMemoryCommit := true },
);
assert (not replayedManagedMemoryCommit);
assert (replayedChanges.size() == 0);
assert (removedInstances.size() == 1);
assert (removedInstances[0].scope == mailInitial.scope);
assert (changedInstances.size() == 2);
assert (changedInstances[0].scope.app_id == "hello");
assert (changedInstances[1].scope.app_id == "wallet");
let ?walletCommitted = InstallMemory.findApp(
    memory.committed_app_instances,
    "wallet",
) else Runtime.trap("Committed wallet missing");
let ?helloCommitted = InstallMemory.findApp(
    memory.committed_app_instances,
    "hello",
) else Runtime.trap("Committed hello missing");
assert (walletCommitted.scope == walletInitial.scope);
assert (InstallMemory.scopeActive(memory, DEPLOYMENT, walletCommitted.scope));
assert (InstallMemory.scopeActive(memory, DEPLOYMENT, helloCommitted.scope));
assert (InstallMemory.deploymentCommitted(memory, DEPLOYMENT));
let ?committedDeploymentRecord =
    assets.get(DEPLOYMENT_BUILD_RECORD_PATH) else {
        Runtime.trap("Committed deployment record missing");
    };
assert (committedDeploymentRecord.content == ["committed-record"]);

// Uninstall and a later reinstall are distinct installations even though the
// authored app id is the same. The old browser origin cannot be reopened.
let withoutHello = [
    runtimeAppWithSecurity(
        "wallet",
        101,
        HASH_A,
        #credentialless_ephemeral_dedicated_v1,
    ),
];
let committedService = serviceFor(DEPLOYMENT, targetRuntime);
putAsset(
    assets,
    deploymentBuildRecordCopy(NEXT_DEPLOYMENT).source,
    "next-record",
);
committedService.begin({
    deployment_id = NEXT_DEPLOYMENT;
    copies = [deploymentBuildRecordCopy(NEXT_DEPLOYMENT)];
    clear_prefixes = [DEPLOYMENT_BUILD_RECORD_PATH];
    target_app_inventory = withoutHello;
});
let ?modeChangePending = committedService.status() else {
    Runtime.trap("Mode-change install status missing");
};
let ?walletModeChanged = InstallMemory.findApp(
    modeChangePending.target_app_instances,
    "wallet",
) else Runtime.trap("Mode-change wallet missing");
assert (
    walletModeChanged.resident_frame_security ==
    #credentialless_ephemeral_dedicated_v1
);
assert (
    walletModeChanged.browser_origin_nonce != walletCommitted.browser_origin_nonce
);
assert (
    walletModeChanged.browser_origin_authority_epoch ==
    walletCommitted.browser_origin_authority_epoch + 1
);
// The old actor remains intact. The activated target cannot use even an exact
// unchanged scope until its complete deployment commits: plan equality does
// not prove that app code or public ingress is unchanged.
assert (InstallMemory.scopeActive(memory, DEPLOYMENT, walletCommitted.scope));
assert (InstallMemory.scopeActive(memory, DEPLOYMENT, helloCommitted.scope));
assert (not InstallMemory.scopeActive(
    memory,
    NEXT_DEPLOYMENT,
    walletCommitted.scope,
));
assert (InstallMemory.deploymentCommitted(memory, DEPLOYMENT));
assert (not InstallMemory.deploymentCommitted(memory, NEXT_DEPLOYMENT));
assert (not InstallMemory.scopeActive(
    memory,
    NEXT_DEPLOYMENT,
    helloCommitted.scope,
));
InstallService.initializeFresh(memory, NEXT_DEPLOYMENT, withoutHello, 20);
ignore serviceFor(NEXT_DEPLOYMENT, withoutHello).commit(
    { deployment_id = NEXT_DEPLOYMENT },
    Principal.fromText("aaaaa-aa"),
    func(deploymentId) {
        assert (deploymentId == NEXT_DEPLOYMENT);
    },
);
assert (InstallMemory.deploymentCommitted(memory, NEXT_DEPLOYMENT));

let reinstalledRuntime = [
    runtimeApp("hello", 101, HASH_ZERO),
    runtimeAppWithSecurity(
        "wallet",
        101,
        HASH_A,
        #credentialless_ephemeral_dedicated_v1,
    ),
];
putAsset(
    assets,
    deploymentBuildRecordCopy(REINSTALL_DEPLOYMENT).source,
    "reinstall-record",
);
serviceFor(NEXT_DEPLOYMENT, withoutHello).begin({
    deployment_id = REINSTALL_DEPLOYMENT;
    copies = [deploymentBuildRecordCopy(REINSTALL_DEPLOYMENT)];
    clear_prefixes = [DEPLOYMENT_BUILD_RECORD_PATH];
    target_app_inventory = reinstalledRuntime;
});
let ?reinstallPending = memory.pending else Runtime.trap("Reinstall missing");
let ?helloReinstalled = InstallMemory.findApp(
    reinstallPending.target_app_instances,
    "hello",
) else Runtime.trap("Reinstalled hello missing");
assert (InstallMemory.scopeActive(
    memory,
    NEXT_DEPLOYMENT,
    walletCommitted.scope,
));
assert (not InstallMemory.scopeActive(
    memory,
    REINSTALL_DEPLOYMENT,
    walletCommitted.scope,
));
assert (not InstallMemory.scopeActive(
    memory,
    REINSTALL_DEPLOYMENT,
    helloReinstalled.scope,
));
assert (
    helloReinstalled.scope.installation_uid !=
    helloCommitted.scope.installation_uid
);
assert (
    helloReinstalled.browser_origin_nonce !=
    helloCommitted.browser_origin_nonce
);

// Pending journals created by v0.3.6 predate deployment build records. Their
// structural predicate deliberately remains record-agnostic so an already
// staged production upgrade can activate and commit after this Kernel lands.
let legacyMemory = InstallMemory.init();
let legacyCommittedRuntime = [runtimeApp("legacy", 100, HASH_A)];
let legacyTargetRuntime = [runtimeApp("legacy", 101, HASH_F)];
InstallService.initializeFresh(
    legacyMemory,
    OLD_DEPLOYMENT,
    legacyCommittedRuntime,
    ORIGIN_EPOCH,
);
let legacyAssets = Assets.use(Assets.init());
let legacyCert = CertificationProbe();
let legacyBackendCalls : BackendCallTypes.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, BackendCallTypes.Reservation>();
};
func legacyServiceFor(
    deploymentId : Text,
    active : [InstallTypes.RuntimeApp],
) : InstallService.Service {
    InstallService.Service(
        legacyMemory,
        legacyAssets,
        legacyCert,
        legacyBackendCalls,
        deploymentId,
        active,
        func(_, _) { true },
        func(_, _) {},
        func(_, _) {},
    );
};
let legacyOldService = legacyServiceFor(
    OLD_DEPLOYMENT,
    legacyCommittedRuntime,
);
putAsset(
    legacyAssets,
    deploymentBuildRecordCopy(LEGACY_DEPLOYMENT).source,
    "legacy-bridge-record-source",
);
legacyOldService.begin({
    deployment_id = LEGACY_DEPLOYMENT;
    copies = [deploymentBuildRecordCopy(LEGACY_DEPLOYMENT)];
    clear_prefixes = [];
    target_app_inventory = legacyTargetRuntime;
});
let ?generatedLegacyJournal = legacyMemory.pending else {
    Runtime.trap("Generated legacy bridge journal missing");
};
let recordlessLegacyJournal = {
    generatedLegacyJournal with copies = [];
};
legacyMemory.pending := ?recordlessLegacyJournal;
assert (InstallService.isValidJournal(
    recordlessLegacyJournal,
    ORIGIN_EPOCH,
));
let recordlessLegacyBegin : InstallTypes.BeginInput = {
    deployment_id = LEGACY_DEPLOYMENT;
    copies = [];
    clear_prefixes = [];
    target_app_inventory = legacyTargetRuntime;
};
assert (not InstallService.hasExactlyOneDeploymentBuildRecordCopy(
    recordlessLegacyBegin
));
assert (legacyOldService.canReplayBegin(recordlessLegacyBegin));
legacyOldService.begin(recordlessLegacyBegin);
assert (legacyMemory.pending == ?recordlessLegacyJournal);
InstallService.initializeFresh(
    legacyMemory,
    LEGACY_DEPLOYMENT,
    legacyTargetRuntime,
    ORIGIN_EPOCH + 1,
);
ignore legacyServiceFor(
    LEGACY_DEPLOYMENT,
    legacyTargetRuntime,
).commit(
    { deployment_id = LEGACY_DEPLOYMENT },
    Principal.fromText("aaaaa-aa"),
    func(_) {},
);
assert (legacyMemory.pending == null);
assert (InstallMemory.deploymentCommitted(
    legacyMemory,
    LEGACY_DEPLOYMENT,
));
assert (legacyAssets.get(DEPLOYMENT_BUILD_RECORD_PATH) == null);
// The install service owns the outer certification transaction. Asset
// clearing/copying, a nested capability commit, module GC, and staging cleanup
// must all collapse into one root publication.

let batchMemory = InstallMemory.init();
let batchCommittedRuntime = [runtimeApp("batch", 100, HASH_A)];
let batchTargetRuntime = [runtimeApp("batch", 101, HASH_F)];
InstallService.initializeFresh(
    batchMemory,
    OLD_DEPLOYMENT,
    batchCommittedRuntime,
    ORIGIN_EPOCH,
);
let batchAssetMemory = Assets.init();
let batchAssets = Assets.use(batchAssetMemory);
let batchStage = "/system/staging/" # DEPLOYMENT # "/";
let batchSource = batchStage # "new.js";
let batchTarget = "/app/batch/new.js";
let batchOld = "/app/batch/old.js";
let batchModule = "/mo/" # HASH_A # ".mo";
let batchModuleGc = batchStage # "module-gc";
let batchRecordSource =
    deploymentBuildRecordCopy(DEPLOYMENT).source;
let batchRecordSuffix = DEPLOYMENT_BUILD_RECORD_PATH # "/retained";
func putBatchAsset(id : Text, content : Blob) : () {
    batchAssets.put({
        id;
        chunks = 1;
        content = [content];
        content_encoding = "identity";
        content_type = "application/octet-stream";
    });
};
putBatchAsset(batchSource, "new");
putBatchAsset(batchOld, "old");
putBatchAsset(batchModule, "module");
putBatchAsset(batchModuleGc, Text.encodeUtf8(HASH_A # ".mo\n"));
putBatchAsset(DEPLOYMENT_BUILD_RECORD_PATH, "old-record");
putBatchAsset(batchRecordSuffix, "must-survive-exact-clear");
putBatchAsset(batchRecordSource, "new-record");

let batchBackendCalls : BackendCallTypes.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, BackendCallTypes.Reservation>();
};
let certificationProbe = CertificationProbe();
var nestedFinishPublished = true;
func batchServiceFor(
    deploymentId : Text,
    active : [InstallTypes.RuntimeApp],
) : InstallService.Service {
    InstallService.Service(
        batchMemory,
        batchAssets,
        certificationProbe,
        batchBackendCalls,
        deploymentId,
        active,
        func(_, _) { true },
        func(key, hash) {
            // Model the public-response leaves installed alongside the body
            // hash.
            certificationProbe.putHash(key # "#public", hash);
        },
        func(_, _) {
            // certifiedAssets.commitConfiguration opens this inner batch in
            // the production callback.
            certificationProbe.beginV2PublicationBatch();
            certificationProbe.putHash(
                "/nested/certified-assets",
                Text.encodeUtf8("0123456789abcdef0123456789abcdef"),
            );
            nestedFinishPublished :=
                certificationProbe.finishV2PublicationBatch();
        },
    );
};
let batchService = batchServiceFor(
    OLD_DEPLOYMENT,
    batchCommittedRuntime,
);
batchService.begin({
    deployment_id = DEPLOYMENT;
    copies = [
        { source = batchSource; target = batchTarget },
        deploymentBuildRecordCopy(DEPLOYMENT),
    ];
    clear_prefixes = [
        "/app/batch/",
        DEPLOYMENT_BUILD_RECORD_PATH,
    ];
    target_app_inventory = batchTargetRuntime;
});
InstallService.initializeFresh(
    batchMemory,
    DEPLOYMENT,
    batchTargetRuntime,
    ORIGIN_EPOCH + 1,
);
ignore batchServiceFor(DEPLOYMENT, batchTargetRuntime).commit(
    { deployment_id = DEPLOYMENT },
    Principal.fromText("aaaaa-aa"),
    func(_) {},
);
assert (not nestedFinishPublished);
assert (certificationProbe.depth == 0);
assert (certificationProbe.max_depth == 2);
assert (certificationProbe.begin_count == 2);
assert (certificationProbe.finish_count == 2);
assert (certificationProbe.publication_count == 1);
assert (certificationProbe.mutation_count == 11);
assert (batchAssets.get(batchOld) == null);
assert (batchAssets.get(batchTarget) != null);
assert (batchAssets.get(batchModule) == null);
assert (batchAssets.get(batchSource) == null);
assert (batchAssets.get(batchModuleGc) == null);
let ?batchCommittedRecord =
    batchAssets.get(DEPLOYMENT_BUILD_RECORD_PATH) else {
        Runtime.trap("Batch deployment record missing");
    };
assert (batchCommittedRecord.content == ["new-record"]);
let ?batchRetainedRecordSuffix = batchAssets.get(batchRecordSuffix) else {
    Runtime.trap("Exact deployment-record clear erased a suffix key");
};
assert (
    batchRetainedRecordSuffix.content == ["must-survive-exact-clear"]
);
assert (batchAssets.get(batchRecordSource) == null);

// Install-time backend-call defaults are claimed before the one-way
// install_code dispatch. The journal decides which app scopes changed, so an
// unrelated app update cannot recreate a default that its owner revoked.
let reservationMemory = InstallMemory.init();
let reservationCommittedRuntime = [
    runtimeApp("alpha", 100, HASH_A),
    runtimeApp("beta", 100, HASH_F),
];
let reservationTargetRuntime = [
    runtimeApp("alpha", 100, HASH_A),
    runtimeApp("beta", 101, HASH_A),
];
InstallService.initializeFresh(
    reservationMemory,
    OLD_DEPLOYMENT,
    reservationCommittedRuntime,
    ORIGIN_EPOCH,
);
let ?alphaCommitted = InstallMemory.findApp(
    reservationMemory.committed_app_instances,
    "alpha",
) else Runtime.trap("Committed alpha instance missing");
let reservationAssetsMemory = Assets.init();
let reservationAssets = Assets.use(reservationAssetsMemory);
let reservationRecordSource =
    deploymentBuildRecordCopy(DEPLOYMENT).source;
let reservationCert = CertificationProbe();
let reservationBackendCalls : BackendCallTypes.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, BackendCallTypes.Reservation>();
};
let reservationOwner = Principal.fromText("aaaaa-aa");
let reservationRemote =
    Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let alphaDefault : BackendCallTypes.ReservationScope =
    #method("app_alpha__default_v1_update");
let betaDefault : BackendCallTypes.ReservationScope =
    #method("app_beta__default_v1_update");

// Model the owner explicitly removing Alpha's install-time default.
let ?_ = BackendCallsMemory.put(
    reservationBackendCalls,
    alphaCommitted.scope,
    alphaDefault,
    reservationOwner,
    1,
) else Runtime.trap("Alpha default setup failed");
assert (BackendCallsMemory.removeReservationScope(
    reservationBackendCalls,
    alphaCommitted.scope,
    alphaDefault,
));
assert (not BackendCallsMemory.allows(
    reservationBackendCalls,
    alphaCommitted.scope,
    reservationRemote,
    "app_alpha__default_v1_update",
));

let reservationRegistry : CapabilityTypes.RuntimeRegistry = {
    allowed = func(_, _, _) { true };
    lease = func(_, _, _) { ?{ active = func() { true } } };
    record = func(_, _, _, _, _) { true };
};
let reservationTransport : BackendCallTypes.Transport = {
    cycle_balance = func() { 0 };
    call_cost = func(_, _) { 0 };
    call = func(
        request : BackendCallTypes.CallRequest,
    ) : async BackendCallTypes.TransportResult {
        #ok({ reply = request.args; charged_cycles = 0 });
    };
};
let reservationCycleAccounting : BackendCallTypes.OutgoingCycleAccounting = {
    reserve = func(_, _, _, _) { null };
    commit = func(_) { false };
    cancel = func(_) {};
    finalize = func(_, _) {};
};
let reservationBroker = BackendCallsService.Service(
    reservationBackendCalls,
    func(_) { true },
    reservationRegistry,
    reservationTransport,
    reservationCycleAccounting,
);
let ?betaCommittedBeforeUpdate = InstallMemory.findApp(
    reservationMemory.committed_app_instances,
    "beta",
) else Runtime.trap("Committed beta instance missing");
reservationBroker.configure([
    {
        app_scope = alphaCommitted.scope;
        backend_calls = ?{
            reservation_scopes = ["method"];
            max_concurrency = 1;
            max_cycles_per_call = 0;
            max_cycles_per_day = 0;
            install_reservations = [alphaDefault];
        };
    },
    {
        app_scope = betaCommittedBeforeUpdate.scope;
        backend_calls = ?{
            reservation_scopes = ["method"];
            max_concurrency = 1;
            max_cycles_per_call = 0;
            max_cycles_per_day = 0;
            install_reservations = [betaDefault];
        };
    },
], reservationRemote);
var expectPromotedDuringCleanup = false;
var sawPromotedDuringCleanup = false;
var expectedPromotedScope : ?CapabilityTypes.AppScope = null;
func reservationScopeAllowed(
    appScope : CapabilityTypes.AppScope,
    scopeKind : Text,
) : Bool {
    if (expectPromotedDuringCleanup) {
        let ?expected = expectedPromotedScope else {
            Runtime.trap("Expected promoted reservation scope missing");
        };
        assert (scopeKind == "method");
        assert (appScope == expected);
        // removeIncompatible must observe the real target grant, never the
        // inert UID-0 claim.
        assert (not BackendCallsMemory.hasInstallClaims(
            reservationBackendCalls
        ));
        assert (BackendCallsMemory.allows(
            reservationBackendCalls,
            expected,
            reservationRemote,
            "app_beta__default_v1_update",
        ));
        sawPromotedDuringCleanup := true;
    };
    scopeKind == "method";
};
func reservationServiceFor(
    deploymentId : Text,
    active : [InstallTypes.RuntimeApp],
) : InstallService.Service {
    InstallService.Service(
        reservationMemory,
        reservationAssets,
        reservationCert,
        reservationBackendCalls,
        deploymentId,
        active,
        reservationScopeAllowed,
        func(_, _) {},
        func(_, _) {},
    );
};
func prepareReservationDefaults(
    service : InstallService.Service,
) : InstallService.ReservationPreparation {
    let preparation = service.reservationPreparation({
        deployment_id = DEPLOYMENT;
    });
    assert (preparation.target_scopes.size() == 2);
    assert (preparation.target_scopes[0].app_id == "alpha");
    assert (preparation.target_scopes[1].app_id == "beta");
    assert (preparation.changed_scopes.size() == 1);
    assert (preparation.changed_scopes[0].app_id == "beta");
    reservationBroker.prepareInstallReservations(
        [
            { app_id = "alpha"; reservations = [alphaDefault] },
            { app_id = "beta"; reservations = [betaDefault] },
        ],
        preparation.target_scopes,
        preparation.changed_scopes,
        reservationOwner,
        reservationRemote,
    );
    var claimCount = 0;
    for (reservation in Map.values(reservationBackendCalls.reservations)) {
        if (reservation.app_scope.installation_uid == 0) {
            claimCount += 1;
            assert (reservation.app_scope.app_id == "beta");
        };
    };
    assert (claimCount == 1);
    assert (BackendCallsMemory.hasInstallClaims(reservationBackendCalls));
    assert (not BackendCallsMemory.allows(
        reservationBackendCalls,
        preparation.changed_scopes[0],
        reservationRemote,
        "app_beta__default_v1_update",
    ));
    preparation;
};

let reservationOldService = reservationServiceFor(
    OLD_DEPLOYMENT,
    reservationCommittedRuntime,
);
let reservationBegin : InstallTypes.BeginInput = {
    deployment_id = DEPLOYMENT;
    copies = [deploymentBuildRecordCopy(DEPLOYMENT)];
    clear_prefixes = [];
    target_app_inventory = reservationTargetRuntime;
};
putAsset(reservationAssets, reservationRecordSource, "aborted-record");
reservationOldService.begin(reservationBegin);
ignore prepareReservationDefaults(reservationOldService);
reservationOldService.abort({ deployment_id = DEPLOYMENT });
assert (not BackendCallsMemory.hasInstallClaims(reservationBackendCalls));
assert (reservationOldService.status() == null);

putAsset(reservationAssets, reservationRecordSource, "fenced-record");
reservationOldService.begin(reservationBegin);
ignore prepareReservationDefaults(reservationOldService);
reservationOldService.markDispatched({ deployment_id = DEPLOYMENT });
reservationOldService.abortAfterManagementFence({
    deployment_id = DEPLOYMENT;
});
assert (not BackendCallsMemory.hasInstallClaims(reservationBackendCalls));
assert (reservationOldService.status() == null);

putAsset(reservationAssets, reservationRecordSource, "reservation-record");
reservationOldService.begin(reservationBegin);
let finalReservationPreparation =
    prepareReservationDefaults(reservationOldService);

// A lost begin reply is recovered by replaying the exact same checked update.
// The existing journal itself proves the client request, so the replay must
// neither allocate another installation identity nor disturb prepared
// backend-call claims.
func installClaim(
    mem : BackendCallTypes.Memory,
) : ?BackendCallTypes.Reservation {
    var found : ?BackendCallTypes.Reservation = null;
    for (reservation in Map.values(mem.reservations)) {
        if (reservation.app_scope.installation_uid == 0) {
            assert (found == null);
            found := ?reservation;
        };
    };
    found;
};
let ?reservationJournalBeforeReplay = reservationMemory.pending else {
    Runtime.trap("Reservation replay journal missing");
};
let reservationNextUidBeforeReplay =
    reservationMemory.next_installation_uid;
let reservationCommittedBeforeReplay =
    reservationMemory.committed_app_instances;
let reservationBackendNextIdBeforeReplay =
    reservationBackendCalls.next_id;
let reservationCountBeforeReplay =
    Map.size(reservationBackendCalls.reservations);
let ?reservationClaimBeforeReplay =
    installClaim(reservationBackendCalls) else {
        Runtime.trap("Reservation replay claim missing");
    };

func assertReservationReplayState() : () {
    assert (
        reservationMemory.pending ==
        ?reservationJournalBeforeReplay
    );
    assert (
        reservationMemory.next_installation_uid ==
        reservationNextUidBeforeReplay
    );
    assert (
        reservationMemory.committed_app_instances ==
        reservationCommittedBeforeReplay
    );
    assert (
        reservationBackendCalls.next_id ==
        reservationBackendNextIdBeforeReplay
    );
    assert (
        Map.size(reservationBackendCalls.reservations) ==
        reservationCountBeforeReplay
    );
    assert (
        installClaim(reservationBackendCalls) ==
        ?reservationClaimBeforeReplay
    );
};

assert (reservationOldService.canReplayBegin(reservationBegin));
reservationOldService.begin(reservationBegin);
assertReservationReplayState();

// begin asserts this same read-only decision before its replay return. Every
// mismatch is therefore rejected before allocation, claim cleanup, or any
// other state mutation.
func assertReservationReplayRejected(
    input : InstallTypes.BeginInput,
) : () {
    assert (not reservationOldService.canReplayBegin(input));
    assertReservationReplayState();
};

assertReservationReplayRejected({
    reservationBegin with deployment_id = NEXT_DEPLOYMENT;
});
assertReservationReplayRejected({
    reservationBegin with copies = [{
        source =
            "/system/staging/" # DEPLOYMENT # "/changed.js";
        target = "/app/beta/changed.js";
    }];
});
assertReservationReplayRejected({
    reservationBegin with clear_prefixes = ["/app/beta/"];
});
assertReservationReplayRejected({
    reservationBegin with target_app_inventory = [
        runtimeApp("alpha", 100, HASH_A),
        runtimeApp("beta", 102, HASH_A),
    ];
});

expectedPromotedScope := ?finalReservationPreparation.changed_scopes[0];
expectPromotedDuringCleanup := true;
assert (reservationBroker.finalizeInstallReservations(
    finalReservationPreparation.changed_scopes,
    reservationOwner,
    reservationRemote,
));
InstallService.initializeFresh(
    reservationMemory,
    DEPLOYMENT,
    reservationTargetRuntime,
    ORIGIN_EPOCH + 1,
);
ignore reservationServiceFor(
    DEPLOYMENT,
    reservationTargetRuntime,
).commit(
    { deployment_id = DEPLOYMENT },
    reservationOwner,
    func(_) {},
);
expectPromotedDuringCleanup := false;
assert (sawPromotedDuringCleanup);
assert (not BackendCallsMemory.hasInstallClaims(reservationBackendCalls));
assert (BackendCallsMemory.list(reservationBackendCalls).size() == 1);
let ?reservationDeploymentRecord =
    reservationAssets.get(DEPLOYMENT_BUILD_RECORD_PATH) else {
        Runtime.trap("Reservation deployment record missing");
    };
assert (reservationDeploymentRecord.content == ["reservation-record"]);
let ?betaCommitted = InstallMemory.findApp(
    reservationMemory.committed_app_instances,
    "beta",
) else Runtime.trap("Committed beta instance missing");
assert (BackendCallsMemory.allows(
    reservationBackendCalls,
    betaCommitted.scope,
    reservationRemote,
    "app_beta__default_v1_update",
));
assert (not BackendCallsMemory.allows(
    reservationBackendCalls,
    alphaCommitted.scope,
    reservationRemote,
    "app_alpha__default_v1_update",
));
