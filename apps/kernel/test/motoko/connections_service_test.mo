import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import AppUsageTypes "../../backend/app_usage/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import Memory "../../backend/connections/Memory";
import Service "../../backend/connections/Service";
import Types "../../backend/connections/Types";

let owner = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let canisterActor : actor {} = actor ("ryjl3-tyaaa-aaaaa-aaaba-cai");
// 32 resident backgrounds can each declare at most 8 providers.
assert (Memory.MAX_CONNECTIONS_PER_APP == 8);
assert (Memory.MAX_CONNECTIONS == 256);
let keepScope : Types.AppScope = {
    app_id = "keep_app";
    installation_uid = 1;
};
let changedScope : Types.AppScope = {
    app_id = "changed_app";
    installation_uid = 2;
};
let removedScope : Types.AppScope = {
    app_id = "removed_app";
    installation_uid = 3;
};
let undeclaredScope : Types.AppScope = {
    app_id = "plain_app";
    installation_uid = 4;
};
let providerChangedScope : Types.AppScope = {
    app_id = "provider_app";
    installation_uid = 5;
};

var reservedCycleCalls : Nat = 0;
var committedCycleCalls : Nat = 0;
var cancelledCycleCalls : Nat = 0;
var finalizedCycleCalls : Nat = 0;
func reserveCycles(
    scope : Types.AppScope,
    attached : Nat,
    dailyLimit : ?Nat,
    callCount : Nat,
) : ?AppUsageTypes.OutgoingCycleReservation {
    reservedCycleCalls += 1;
    ?{
        id = reservedCycleCalls;
        scope;
        day = 0;
        attached;
        daily_budgeted = dailyLimit != null;
        call_count = callCount;
    };
};
func commitCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
) : Bool {
    committedCycleCalls += 1;
    true;
};
func cancelCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
) : () {
    cancelledCycleCalls += 1;
};
func finalizeCycles(
    _reservation : AppUsageTypes.OutgoingCycleReservation,
    _charged : Nat,
) : () {
    finalizedCycleCalls += 1;
};
let cycleAccounting : AppUsageTypes.OutgoingCycleAccounting = {
    reserve = reserveCycles;
    commit = commitCycles;
    cancel = cancelCycles;
    finalize = finalizeCycles;
};

class FakeRegistry() {
    public var enabled = true;
    public var epoch : Nat = 0;
    public var records : Nat = 0;
    public var last : ?CapabilityTypes.CapabilityOutcome = null;

    public func setEnabled(value : Bool) : () {
        enabled := value;
        epoch += 1;
    };

    public func value() : CapabilityTypes.RuntimeRegistry {
        {
            allowed = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resource : Text,
            ) : Bool {
                enabled and kind == #connections and resource == "openrouter";
            };
            lease = func(
                _scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resource : Text,
            ) : ?CapabilityTypes.RuntimeLease {
                if (
                    not enabled or
                    kind != #connections or
                    resource != "openrouter"
                ) return null;
                let capturedEpoch = epoch;
                ?{
                    active = func() : Bool {
                        enabled and epoch == capturedEpoch;
                    };
                };
            };
            record = func(
                _scope : CapabilityTypes.AppScope,
                _kind : CapabilityTypes.CapabilityKind,
                _resource : Text,
                _operation : Text,
                outcome : CapabilityTypes.CapabilityOutcome,
            ) : Bool {
                records += 1;
                last := ?outcome;
                true;
            };
        };
    };
};

func scopeFor(appId : Text) : ?Types.AppScope {
    if (appId == keepScope.app_id) ?keepScope
    else if (appId == changedScope.app_id) ?changedScope
    else if (appId == removedScope.app_id) ?removedScope
    else if (appId == undeclaredScope.app_id) ?undeclaredScope
    else if (appId == providerChangedScope.app_id) ?providerChangedScope
    else null;
};

func provider() : Types.ProviderDeclaration {
    {
        provider = "openrouter";
        scopes = [];
    };
};

func appDeclaration(
    scope : Types.AppScope,
    declared : Bool,
) : Types.AppDeclaration {
    {
        app_scope = scope;
        connections = if (declared) ?{ providers = [provider()] } else null;
    };
};

func connection(
    scope : Types.AppScope,
    providerId : Text,
    scopes : [Text],
) : Types.Connection {
    {
        owner_scope = scope;
        provider = providerId;
        declaration_scopes = scopes;
        credential = "secret-" # scope.app_id;
        created_at = 1;
    };
};

func flow(
    id : Nat8,
    scope : Types.AppScope,
    providerId : Text,
    scopes : [Text],
) : Types.OAuthFlow {
    {
        flow_id_hash = Blob.fromArray([id]);
        owner_principal = owner;
        owner_scope = scope;
        provider = providerId;
        declaration_scopes = scopes;
        pkce_verifier = "verifier";
        callback_url = "https://example.test/callback";
        created_at = 1;
        expires_at = 10_000_000_000_000_000_000;
        status = #pending;
    };
};

let memory = Memory.init();
assert (Memory.putConnection(memory, connection(keepScope, "openrouter", [])));
assert (Memory.putConnection(
    memory,
    connection(changedScope, "openrouter", ["legacy_scope"]),
));
assert (Memory.putConnection(
    memory,
    connection(providerChangedScope, "legacy_provider", []),
));
assert (Memory.putConnection(
    memory,
    connection(undeclaredScope, "openrouter", []),
));
assert (Memory.putConnection(
    memory,
    connection(removedScope, "openrouter", []),
));
assert (Memory.addFlow(memory, flow(1, keepScope, "openrouter", [])));
assert (Memory.addFlow(
    memory,
    flow(2, changedScope, "openrouter", ["legacy_scope"]),
));
assert (Memory.addFlow(
    memory,
    flow(3, providerChangedScope, "legacy_provider", []),
));
assert (Memory.addFlow(memory, flow(4, undeclaredScope, "openrouter", [])));
assert (Memory.addFlow(memory, flow(5, removedScope, "openrouter", [])));

let registry = FakeRegistry();
let service = Service.Service(
    memory,
    scopeFor,
    func(_) { true },
    registry.value(),
    cycleAccounting,
);
service.configure([
    appDeclaration(changedScope, true),
    appDeclaration(keepScope, true),
    appDeclaration(providerChangedScope, true),
    appDeclaration(undeclaredScope, false),
]);

// Configuration is staging only: old records survive until install commit.
assert (Map.size(memory.connections) == 5);
assert (Map.size(memory.flows) == 5);

// Query-compatible listing filters stale declaration bindings and has no
// duplicate audit side effect.
let recordsBeforeList = registry.records;
assert (
    service.list(
        { app_id = "changed_app"; provider = ?"openrouter" },
        owner,
    ).size() == 0
);
assert (registry.records == recordsBeforeList);

var acquireRejected = false;
try {
    ignore await* service.acquire(
        { app_id = "changed_app"; provider = "openrouter" },
        owner,
    );
} catch (_) {
    acquireRejected := true;
};
assert (acquireRejected);

var disconnectRejected = false;
try {
    ignore await* service.disconnect(
        { app_id = "changed_app"; provider = "openrouter" },
        owner,
    );
} catch (_) {
    disconnectRejected := true;
};
assert (disconnectRejected);

// An app without the exact declaration fails before randomness or outcalls.
var beginRejected = false;
try {
    ignore await* service.begin({
        app_id = "plain_app";
        provider = "openrouter";
        callback_base = "https://ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io/connections/callback.html";
    }, owner, canisterActor);
} catch (_) {
    beginRejected := true;
};
assert (beginRejected);
assert (
    reservedCycleCalls == 0 and
    committedCycleCalls == 0 and
    cancelledCycleCalls == 0 and
    finalizedCycleCalls == 0
);

// Commit preserves only the exact provider/scopes declaration and retires the
// explicitly removed installation.
service.commitConfiguration([removedScope]);
assert (Map.size(memory.connections) == 1);
assert (Memory.findConnection(memory, keepScope, "openrouter") != null);
assert (Memory.findConnection(memory, changedScope, "openrouter") == null);
assert (
    Memory.findConnection(memory, providerChangedScope, "legacy_provider") ==
    null
);
assert (Memory.findConnection(memory, undeclaredScope, "openrouter") == null);
assert (Memory.findConnection(memory, removedScope, "openrouter") == null);
assert (Map.size(memory.flows) == 1);
assert (Memory.findFlow(memory, Blob.fromArray([1])) != null);

let recordsBeforeQuery = registry.records;
let listed = service.list(
    { app_id = "keep_app"; provider = null },
    owner,
);
assert (listed.size() == 1 and listed[0].provider == "openrouter");
assert (registry.records == recordsBeforeQuery);

let acquired = await* service.acquire(
    { app_id = "keep_app"; provider = "openrouter" },
    owner,
);
assert (acquired.credential == "secret-keep_app");
assert (registry.records == recordsBeforeQuery + 1);

// Disable blocks reads/acquire, while explicit disconnect remains available
// and physically deletes the credential instead of leaving a tombstone.
registry.setEnabled(false);
assert (
    service.list(
        { app_id = "keep_app"; provider = null },
        owner,
    ).size() == 0
);
var disabledAcquireRejected = false;
try {
    ignore await* service.acquire(
        { app_id = "keep_app"; provider = "openrouter" },
        owner,
    );
} catch (_) {
    disabledAcquireRejected := true;
};
assert (disabledAcquireRejected);
assert (registry.last == ?#denied);
let disconnected = await* service.disconnect(
    { app_id = "keep_app"; provider = "openrouter" },
    owner,
);
assert (disconnected.provider == "openrouter");
assert (Memory.findConnection(memory, keepScope, "openrouter") == null);
assert (registry.last == ?#ok);

// Aggregate declared capacity is admitted at configuration, before an OAuth
// exchange can produce a credential.
let tooManyDeclarations = Array.tabulate<Types.AppDeclaration>(
    Memory.MAX_CONNECTIONS + 1,
    func(index) {
        appDeclaration(
            {
                app_id = "app" # Nat.toText(index);
                installation_uid = Nat64.fromNat(index + 1);
            },
            true,
        );
    },
);
assert (not Service.withinConnectionCapacity(tooManyDeclarations));
assert (Service.withinConnectionCapacity(
    Array.tabulate<Types.AppDeclaration>(
        Memory.MAX_CONNECTIONS,
        func(index) {
            appDeclaration(
                {
                    app_id = "app" # Nat.toText(index);
                    installation_uid = Nat64.fromNat(index + 1);
                },
                true,
            );
        },
    )
));
