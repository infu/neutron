import Error "mo:core/Error";
import CapabilityTypes "../../backend/capabilities/Types";
import Service "../../backend/scheduler/Service";
import Types "../../backend/scheduler/Types";

let committedScope : CapabilityTypes.AppScope = {
    app_id = "mail";
    installation_uid = 11;
};
let reinstalledScope : CapabilityTypes.AppScope = {
    app_id = "mail";
    installation_uid = 12;
};
let committedTask = committedScope.app_id # ":poll";
let reinstalledTask = reinstalledScope.app_id # ":poll";
assert (committedTask == reinstalledTask);
assert (committedScope.installation_uid != reinstalledScope.installation_uid);
assert (Service.MAX_SCHEDULED_TASKS == 64);
assert (Service.scheduledTaskCountWithinBound(
    Service.MAX_SCHEDULED_TASKS
));
assert (not Service.scheduledTaskCountWithinBound(
    Service.MAX_SCHEDULED_TASKS + 1
));

class FakeRegistry() {
    public var enabled = true;
    public var records : Nat = 0;
    public var lastOutcome : ?CapabilityTypes.CapabilityOutcome = null;
    public var lastOperation : ?Text = null;

    public func value() : CapabilityTypes.RuntimeRegistry {
        {
            allowed = func(
                scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resource : Text,
            ) : Bool {
                enabled and
                scope.app_id == committedScope.app_id and
                scope.installation_uid == committedScope.installation_uid and
                kind == #scheduled_tasks and
                resource == "poll";
            };
            lease = func(
                scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resource : Text,
            ) : ?CapabilityTypes.RuntimeLease {
                if (
                    not enabled or
                    scope != committedScope or
                    kind != #scheduled_tasks or
                    resource != "poll"
                ) return null;
                ?{ active = func() : Bool { enabled } };
            };
            record = func(
                scope : CapabilityTypes.AppScope,
                kind : CapabilityTypes.CapabilityKind,
                resource : Text,
                operation : Text,
                outcome : CapabilityTypes.CapabilityOutcome,
            ) : Bool {
                assert (scope == committedScope);
                assert (kind == #scheduled_tasks);
                assert (resource == "poll");
                records += 1;
                lastOperation := ?operation;
                lastOutcome := ?outcome;
                true;
            };
        };
    };
};

func customTask(
    callback : Types.InvocationLease -> async (),
) : Types.Task {
    {
        app_scope = committedScope;
        id = "poll";
        method = "poll";
        interval_seconds = 10;
        run_on_start = false;
        max_backend_calls = 1;
        callback;
    };
};

func task(fail : Bool) : Types.Task {
    customTask(
        func(_lease : Types.InvocationLease) : async () {
            if (fail) throw Error.reject("expected failure");
        }
    );
};

// No app scope is live in the target actor before the deployment commits.
// run_on_start likewise remains dormant, then dispatches exactly once from the
// commit path.
var deploymentIsCommitted = false;
var dispatches = 0;
let pendingGate = Service.RunOnStartGate(func() { deploymentIsCommitted });
assert (not pendingGate.claim());
assert (not pendingGate.hasDispatched());
assert (dispatches == 0);

deploymentIsCommitted := true;
if (pendingGate.claim()) dispatches += 1;
assert (pendingGate.hasDispatched());
assert (dispatches == 1);
if (pendingGate.claim()) dispatches += 1;
assert (dispatches == 1);

// Fresh actor construction already has a committed inventory and therefore
// preserves immediate run_on_start behavior without waiting for a journal.
let freshGate = Service.RunOnStartGate(func() { true });
if (freshGate.claim()) dispatches += 1;
if (freshGate.claim()) dispatches += 1;
assert (dispatches == 2);

// A task receives only the view. Closing the controller is irreversible even
// if every underlying liveness condition later becomes true again.
var taskEnabled = true;
let lease = Service.InvocationLease(func() : Bool { taskEnabled });
let retainedView = lease.view();
assert (retainedView.active());
taskEnabled := false;
assert (not retainedView.active());
taskEnabled := true;
assert (retainedView.active());
lease.close();
assert (not lease.isOpen());
assert (not retainedView.active());
taskEnabled := true;
assert (not retainedView.active());

let otherLease = Service.InvocationLease(func() : Bool { true });
assert (otherLease.view().active());
assert (not retainedView.active());

// The same lease operation reached through closeDisabledLease revokes a
// currently running invocation, and a later enable cannot revive its view.
let leases = Service.InvocationLeases();
let disabledWhileRunning = Service.InvocationLease(func() : Bool { true });
let disabledView = disabledWhileRunning.view();
leases.add(committedTask, disabledWhileRunning);
assert (disabledView.active());
assert (leases.close(committedTask));
assert (not disabledView.active());
leases.remove(committedTask);
assert (not disabledView.active());

// Every callback that actually starts records exactly one terminal outcome.
// A success and a caught callback failure therefore produce two records, while
// scheduler ticks rejected before executeInvocation produce none.
let registry = FakeRegistry();
let successfulLease = Service.InvocationLease(func() : Bool {
    registry.value().allowed(committedScope, #scheduled_tasks, "poll")
});
let success = await Service.executeInvocation(
    task(false),
    successfulLease,
    registry.value(),
);
assert (success == #ok);
assert (not successfulLease.view().active());
assert (registry.records == 1);
assert (registry.lastOperation == ?"run");
assert (registry.lastOutcome == ?#ok);

let failingLease = Service.InvocationLease(func() : Bool { true });
let failed = await Service.executeInvocation(
    task(true),
    failingLease,
    registry.value(),
);
assert (failed == #failed);
assert (not failingLease.view().active());
assert (registry.records == 2);
assert (registry.lastOutcome == ?#failed);

// A generic disable closes the controller while the callback is suspended.
// Revocation is terminal even when that same callback also rejects.
let closedDuringAwaitLease = Service.InvocationLease(func() : Bool { true });
let revokedAfterClose = await Service.executeInvocation(
    customTask(
        func(_view : Types.InvocationLease) : async () {
            closedDuringAwaitLease.close();
            throw Error.reject("failure after disable");
        }
    ),
    closedDuringAwaitLease,
    registry.value(),
);
assert (revokedAfterClose == #revoked);
assert (registry.records == 3);
assert (registry.lastOutcome == ?#revoked);

// Scope replacement/removal is independently visible through the registry,
// even if the generic endpoint did not have a local controller to close.
registry.enabled := true;
let scopeRevokedLease = Service.InvocationLease(func() : Bool { true });
let revokedByRegistry = await Service.executeInvocation(
    customTask(
        func(_view : Types.InvocationLease) : async () {
            registry.enabled := false;
            throw Error.reject("failure after scope replacement");
        }
    ),
    scopeRevokedLease,
    registry.value(),
);
assert (revokedByRegistry == #revoked);
assert (registry.records == 4);
assert (registry.lastOutcome == ?#revoked);

// Deferred timers are a bounded declaration-free primitive, not raw Timer
// authority. The runtime floor is enforced before touching the native timer;
// live Timer behavior is covered by the compiled actor rather than the
// interpreter, which has no advancing IC global timer.
assert (Service.MIN_DEFERRED_DELAY_SECONDS == 10);
assert (Service.MAX_DEFERRED_DELAY_SECONDS == 2_592_000);
assert (Service.MAX_DEFERRED_TIMERS_PER_SCOPE == 8);

let deferredService = Service.Service(
    registry.value(),
    func() { true },
    func(scope) { scope == committedScope },
    func() { 100 },
);
var deferredCallbacks = 0;
let deferred = deferredService.deferredTimersCapability(
    committedScope,
    func(callback : () -> ()) : () {
        callback();
    },
);
let tooSoon = await* deferred.arm({
    key = "batch";
    delay_seconds = 9;
    callback = func() : () { deferredCallbacks += 1 };
});
switch (tooSoon) {
    case (#err(#invalid)) {};
    case (_) assert false;
};
assert (deferred.status("batch") == null);
assert (deferredCallbacks == 0);
