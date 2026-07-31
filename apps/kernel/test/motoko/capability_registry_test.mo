import Principal "mo:core/Principal";
import Map "mo:core/Map";
import Runtime "mo:core/Runtime";
import Registry "../../backend/capabilities/Registry";
import Scope "../../backend/capabilities/Scope";
import Types "../../backend/capabilities/Types";

assert (Scope.validAppId("agent"));
assert (Scope.validAppId("1234"));
assert (not Scope.validAppId("_mail"));
assert (not Scope.validAppId("mail_"));
assert (not Scope.validAppId("mail__box"));
assert (not Scope.validAppId("abc"));

let owner = Principal.fromText("pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe");
let scope : Types.AppScope = { app_id = "wallet"; installation_uid = 7 };
let reinstalled : Types.AppScope = { app_id = "wallet"; installation_uid = 8 };
let planA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let planB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
let backendAuthority = "1111111111111111111111111111111111111111111111111111111111111111";
let changedAuthority = "2222222222222222222222222222222222222222222222222222222222222222";
let taskAuthority = "3333333333333333333333333333333333333333333333333333333333333333";
var activeUid : Nat64 = 7;
var deploymentCommitted = true;
var timestamp : Nat64 = 10;

func active(candidate : Types.AppScope) : Bool {
    candidate.app_id == "wallet" and candidate.installation_uid == activeUid;
};

func registration(
    target : Types.AppScope,
    plan : Text,
    kind : Types.CapabilityKind,
    resourceId : Text,
    fingerprint : Text,
) : Types.CapabilityRegistration {
    {
        scope = target;
        plan_fingerprint = plan;
        kind;
        resource_id = resourceId;
        api = switch (kind) {
            case (#certified_assets) 2;
            case (_) 1;
        };
        declaration_fingerprint = fingerprint;
        grant = if (kind == #backend_calls) #owner_runtime_grant else #declaration;
        toggleable = true;
    };
};

let memory = Registry.init();
let initial = Registry.Service(
    memory,
    active,
    func() { deploymentCommitted },
    func() { timestamp },
);
initial.configure([
    registration(scope, planA, #backend_calls, "default", backendAuthority),
    registration(scope, planA, #scheduled_tasks, "sync", taskAuthority),
]);

// Transient configuration is not authority before commit reconciliation.
assert (not initial.allowed(scope, #backend_calls, "default"));
assert (initial.enabledAfterCommit(scope, #backend_calls, "default"));
assert (initial.page({ after = null; limit = 10 }).entries.size() == 0);
assert (initial.commitConfiguration(owner));
assert (initial.allowed(scope, #backend_calls, "default"));

let ?oldTaskLease = initial.lease(scope, #scheduled_tasks, "sync") else {
    Runtime.trap("Expected initial task lease");
};
assert (oldTaskLease.active());
assert (initial.setEnabled({
    app_id = "wallet";
    installation_uid = 7;
    kind = #scheduled_tasks;
    resource_id = "sync";
    enabled = false;
}, owner) != null);
assert (initial.setEnabled({
    app_id = "wallet";
    installation_uid = 7;
    kind = #scheduled_tasks;
    resource_id = "sync";
    enabled = true;
}, owner) != null);
// Current-state checks alone would revive the old operation here. The epoch
// lease remains irreversibly dead even though the resource is enabled again.
assert (not oldTaskLease.active());
let ?newTaskLease = initial.lease(scope, #scheduled_tasks, "sync") else {
    Runtime.trap("Expected replacement task lease");
};
assert (newTaskLease.active());
// Even an idempotent successful toggle is an explicit revocation boundary.
assert (initial.setEnabled({
    app_id = "wallet";
    installation_uid = 7;
    kind = #scheduled_tasks;
    resource_id = "sync";
    enabled = true;
}, owner) != null);
assert (not newTaskLease.active());
let ?latestTaskLease = initial.lease(scope, #scheduled_tasks, "sync") else {
    Runtime.trap("Expected post-toggle task lease");
};
assert (latestTaskLease.active());
// Runtime lookups reject unbounded or malformed resource input before key
// construction, even though only compiler-validated resources can be stored.
let oversizedResource = planA # "x";
assert (initial.registration(scope, #connections, oversizedResource) == null);
assert (not initial.allowed(scope, #connections, oversizedResource));
assert (not initial.record(
    scope,
    #connections,
    oversizedResource,
    "list",
    #denied,
));

let firstPage = initial.page({ after = null; limit = 1 });
assert (firstPage.entries.size() == 1);
assert (firstPage.next != null);
let secondPage = initial.page({ after = firstPage.next; limit = 1 });
assert (secondPage.entries.size() == 1);
assert (secondPage.next == null);

timestamp := 11;
let disabled = switch (initial.setEnabled({
    app_id = "wallet";
    installation_uid = 7;
    kind = #backend_calls;
    resource_id = "default";
    enabled = false;
}, owner)) {
    case (?value) value;
    case null Runtime.trap("Expected capability toggle");
};
assert (not disabled.enabled);
assert (not initial.allowed(scope, #backend_calls, "default"));
assert (initial.setEnabled({
    app_id = "wallet";
    installation_uid = 8;
    kind = #backend_calls;
    resource_id = "default";
    enabled = true;
}, owner) == null);
assert (initial.record(scope, #backend_calls, "default", "call", #denied));
assert (initial.record(scope, #backend_calls, "default", "call", #failed));

// An unrelated plan change updates join metadata while retaining the exact
// resource's disabled state and bounded usage.
timestamp := 12;
let planChanged = Registry.Service(
    memory,
    active,
    func() { deploymentCommitted },
    func() { timestamp },
);
planChanged.configure([
    registration(scope, planB, #backend_calls, "default", backendAuthority),
    registration(scope, planB, #scheduled_tasks, "sync", taskAuthority),
]);
assert (not planChanged.enabledAfterCommit(
    scope,
    #backend_calls,
    "default",
));
assert (planChanged.commitConfiguration(owner));
let retainedPage = planChanged.page({ after = null; limit = 10 });
let retained = retainedPage.entries[0];
assert (retained.kind == #backend_calls);
assert (retained.plan_fingerprint == planB);
assert (not retained.enabled);
assert (retained.usage.total == 3);
assert (retained.usage.succeeded == 1);
assert (retained.usage.denied == 1);
assert (retained.usage.failed == 1);

// Authority changes reset generic state rather than carrying a stale grant or
// kill-switch decision into a semantically different resource.
timestamp := 13;
let authorityChanged = Registry.Service(
    memory,
    active,
    func() { deploymentCommitted },
    func() { timestamp },
);
authorityChanged.configure([
    registration(scope, planB, #backend_calls, "default", changedAuthority),
]);
assert (authorityChanged.enabledAfterCommit(
    scope,
    #backend_calls,
    "default",
));
assert (authorityChanged.commitConfiguration(owner));
let reset = authorityChanged.page({ after = null; limit = 10 }).entries[0];
assert (reset.enabled);
assert (reset.usage.total == 0);
assert (reset.created_at == 13);

// Merely activating a replacement actor cannot reconcile the predecessor's
// committed state. The explicit commit API fails without mutation.
timestamp := 14;
deploymentCommitted := false;
let pending = Registry.Service(
    memory,
    active,
    func() { deploymentCommitted },
    func() { timestamp },
);
pending.configure([
    registration(reinstalled, planA, #backend_calls, "default", backendAuthority),
]);
assert (pending.enabledAfterCommit(
    reinstalled,
    #backend_calls,
    "default",
));
assert (not pending.commitConfiguration(owner));
assert (Map.size(memory.entries) == 1);
assert (not pending.allowed(reinstalled, #backend_calls, "default"));

// A same-id reinstall receives a new scope and inherits nothing after commit.
activeUid := 8;
deploymentCommitted := true;
assert (pending.commitConfiguration(owner));
assert (not pending.allowed(scope, #backend_calls, "default"));
assert (pending.allowed(reinstalled, #backend_calls, "default"));
let fresh = pending.page({ after = null; limit = 10 }).entries[0];
assert (fresh.scope.installation_uid == 8);
assert (fresh.enabled);
assert (fresh.usage.total == 0);

// Empty target configuration purges all scoped registry records at commit.
let removed = Registry.Service(
    memory,
    func(_scope) { true },
    func() { deploymentCommitted },
    func() { 15 },
);
removed.configure([]);
assert (removed.commitConfiguration(owner));
assert (Map.size(memory.entries) == 0);

// Certified route storage registers one exact root plus one validated mount.
let routeMemory = Registry.init();
let routeService = Registry.Service(
    routeMemory,
    func(candidate) { candidate == scope },
    func() { true },
    func() { 16 },
);
routeService.configure([
    registration(scope, planA, #certified_assets, "default", backendAuthority),
    registration(
        scope,
        planA,
        #certified_read_routes,
        "public_data",
        changedAuthority,
    ),
    registration(scope, planA, #http_routes, "public_data", changedAuthority),
    registration(scope, planA, #public_ingress, "mail:receive", taskAuthority),
]);
assert (routeService.commitConfiguration(owner));
assert (Registry.kindText(#certified_assets) == "certified_assets");
assert (
    Registry.kindText(#certified_read_routes) ==
    "certified_read_routes"
);
assert (Registry.kindText(#http_routes) == "http_routes");
assert (Registry.kindText(#public_ingress) == "public_ingress");
assert (routeService.allowed(scope, #certified_assets, "default"));
assert (routeService.allowed(scope, #certified_read_routes, "public_data"));
assert (routeService.allowed(scope, #http_routes, "public_data"));
assert (routeService.allowed(scope, #public_ingress, "mail:receive"));
assert (not routeService.allowed(scope, #certified_assets, "public_data"));
assert (not routeService.allowed(scope, #certified_read_routes, "Bad-Mount"));
assert (not routeService.allowed(scope, #certified_read_routes, "a2345678901234567890123456789012345678901"));
assert (not routeService.allowed(scope, #public_ingress, "mail"));
assert (not routeService.allowed(scope, #public_ingress, "mail:Receive"));
assert (not routeService.allowed(scope, #public_ingress, "mail:receive:extra"));
assert (routeService.setEnabled({
    app_id = "wallet";
    installation_uid = 7;
    kind = #certified_read_routes;
    resource_id = "public_data";
    enabled = false;
}, owner) != null);
assert (not routeService.allowed(scope, #certified_read_routes, "public_data"));
assert (routeService.allowed(scope, #http_routes, "public_data"));
assert (routeService.setEnabled({
    app_id = "wallet";
    installation_uid = 7;
    kind = #certified_assets;
    resource_id = "default";
    enabled = false;
}, owner) != null);
let widenedRouteService = Registry.Service(
    routeMemory,
    func(candidate) { candidate == scope },
    func() { true },
    func() { 17 },
);
widenedRouteService.configure([
    registration(
        scope,
        planB,
        #certified_assets,
        "default",
        changedAuthority,
    ),
]);
assert (widenedRouteService.commitConfiguration(owner));
let widenedRoute =
    widenedRouteService.page({ after = null; limit = 10 }).entries[0];
assert (widenedRoute.plan_fingerprint == planB);
assert (widenedRoute.declaration_fingerprint == changedAuthority);
assert (not widenedRoute.enabled);
assert (widenedRoute.usage.total == 1);

// Dedicated-origin enablement is a live route authority. Every explicit
// toggle revokes the captured lease, and a mode change replaces rather than
// combines the two mutually exclusive registry resources.
let residentMemory = Registry.init();
let dedicatedService = Registry.Service(
    residentMemory,
    func(candidate) { candidate == scope },
    func() { true },
    func() { 17 },
);
dedicatedService.configure([
    registration(
        scope,
        planA,
        #dedicated_resident_origin,
        "background",
        backendAuthority,
    ),
]);
assert (dedicatedService.commitConfiguration(owner));
assert (
    Registry.kindText(#dedicated_resident_origin) ==
    "dedicated_resident_origin"
);
assert (dedicatedService.allowed(
    scope,
    #dedicated_resident_origin,
    "background",
));
let ?dedicatedLease = dedicatedService.lease(
    scope,
    #dedicated_resident_origin,
    "background",
) else Runtime.trap("Expected dedicated-origin lease");
assert (dedicatedService.setEnabled({
    app_id = "wallet";
    installation_uid = 7;
    kind = #dedicated_resident_origin;
    resource_id = "background";
    enabled = false;
}, owner) != null);
assert (not dedicatedLease.active());
assert (dedicatedService.setEnabled({
    app_id = "wallet";
    installation_uid = 7;
    kind = #dedicated_resident_origin;
    resource_id = "background";
    enabled = true;
}, owner) != null);
let ?reenabledLease = dedicatedService.lease(
    scope,
    #dedicated_resident_origin,
    "background",
) else Runtime.trap("Expected re-enabled dedicated-origin lease");

let persistentService = Registry.Service(
    residentMemory,
    func(candidate) { candidate == scope },
    func() { true },
    func() { 18 },
);
persistentService.configure([
    registration(
        scope,
        planB,
        #persistent_browser_storage,
        "background",
        changedAuthority,
    ),
]);
assert (persistentService.commitConfiguration(owner));
assert (not reenabledLease.active());
assert (not dedicatedService.allowed(
    scope,
    #dedicated_resident_origin,
    "background",
));
assert (persistentService.allowed(
    scope,
    #persistent_browser_storage,
    "background",
));
