import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Timer "mo:core/Timer";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import Types "Types";

module {
    // The compiler mirrors this actor-wide ceiling and rejects excess
    // schedules before generating the actor. The backend repeats it before
    // creating native timers.
    public let MAX_SCHEDULED_TASKS : Nat = 64;
    public let MAX_DEFERRED_TIMERS_PER_SCOPE : Nat = 8;
    public let MIN_DEFERRED_DELAY_SECONDS : Nat = 10;
    public let MAX_DEFERRED_DELAY_SECONDS : Nat = 2_592_000;
    let NANOS_PER_SECOND = 1_000_000_000;
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;

    type DeferredTimer = {
        id : Nat;
        scope : CapabilityTypes.AppScope;
        due_at_ns : Nat64;
        var phase : Types.DeferredTimerPhaseV1;
    };

    public type RunOnStartGateApi = {
        claim : () -> Bool;
        hasDispatched : () -> Bool;
    };

    // A target actor has no active app scope before the install journal
    // commits. Keep run_on_start tied to the same actor-wide commit fact and
    // make its later dispatch exact-once.
    public class RunOnStartGate(deploymentCommitted : () -> Bool) {
        var dispatched = false;

        public func claim() : Bool {
            if (dispatched or not deploymentCommitted()) return false;
            dispatched := true;
            true;
        };

        public func hasDispatched() : Bool { dispatched };
    };

    // The controller never crosses into app code. A retained capability keeps
    // only view(), which becomes permanently inactive after close().
    public class InvocationLease(live : () -> Bool) {
        var open = true;

        public func view() : Types.InvocationLease {
            {
                active = func() : Bool { open and live() };
            };
        };

        public func close() : () { open := false };

        public func isOpen() : Bool { open };
    };

    public type InvocationLeasesApi = {
        add : (Text, InvocationLease) -> ();
        close : Text -> Bool;
        remove : Text -> ();
    };

    public class InvocationLeases() {
        let byTask = Map.empty<Text, InvocationLease>();

        public func add(key : Text, lease : InvocationLease) : () {
            assert (not Map.containsKey(byTask, Text.compare, key));
            Map.add(byTask, Text.compare, key, lease);
        };

        public func close(key : Text) : Bool {
            switch (Map.get(byTask, Text.compare, key)) {
                case (?lease) {
                    lease.close();
                    true;
                };
                case null false;
            };
        };

        public func remove(key : Text) : () {
            Map.remove(byTask, Text.compare, key);
        };
    };

    public class Service(
        registry : CapabilityTypes.RuntimeRegistry,
        deploymentCommitted : () -> Bool,
        scopeActive : CapabilityTypes.AppScope -> Bool,
        nowNs : () -> Nat64,
    ) {
        let declarations = Map.empty<Text, Types.Task>();
        let running = Set.empty<Text>();
        let deferredTimers = Map.empty<Text, DeferredTimer>();
        let deferredCounts = Map.empty<Text, Nat>();
        var nextDeferredTimerId = 0;
        let activeLeases : InvocationLeasesApi = InvocationLeases();
        let runOnStartGate : RunOnStartGateApi =
            RunOnStartGate(deploymentCommitted);
        var configured = false;

        // This handle is delivered only by the compiler-created backend
        // environment. Native timer ids remain private to this service.
        public func deferredTimersCapability(
            appScope : CapabilityTypes.AppScope,
            run : (() -> ()) -> (),
        ) : Types.DeferredTimersV1 {
            {
                arm = func(
                    input : Types.DeferredTimerArmInputV1
                ) : async* Types.DeferredTimerArmResultV1 {
                    await* armDeferred(appScope, input, run);
                };
                status = func(key : Text) : ?Types.DeferredTimerStatusV1 {
                    deferredStatus(appScope, key);
                };
            };
        };

        public func start<system>(tasks : [Types.Task]) : () {
            assert (not configured);
            assert (scheduledTaskCountWithinBound(tasks.size()));
            for (task in tasks.vals()) {
                validate(task);
                let key = taskKey(task.app_scope, task.id);
                assert (not Map.containsKey(declarations, Text.compare, key));
                Map.add(declarations, Text.compare, key, task);
            };
            configured := true;

            for (task in tasks.vals()) {
                ignore Timer.recurringTimer<system>(
                    #seconds(task.interval_seconds),
                    func() : async () { await run(task) },
                );
            };
            dispatchRunOnStart<system>();
        };

        public func commitConfiguration<system>() : () {
            dispatchRunOnStart<system>();
        };

        public func summaries() : [Types.Summary] {
            Array.fromIter<Types.Summary>(Iter.map(
                Map.entries(declarations),
                func((key, task)) {
                    {
                        app_id = task.app_scope.app_id;
                        installation_uid = task.app_scope.installation_uid;
                        id = task.id;
                        method = task.method;
                        interval_seconds = task.interval_seconds;
                        run_on_start = task.run_on_start;
                        max_backend_calls = task.max_backend_calls;
                        enabled = registry.allowed(
                            task.app_scope,
                            #scheduled_tasks,
                            task.id,
                        );
                        running = Set.contains(running, Text.compare, key);
                    };
                },
            ));
        };

        // Call this only after the generic registry successfully disables the
        // exact task. It closes a running invocation without creating a
        // second enable/disable authority inside the scheduler.
        public func closeDisabledLease(
            appScope : CapabilityTypes.AppScope,
            taskId : Text,
        ) : Bool {
            let ?task = findTask(appScope, taskId) else return false;
            if (registry.allowed(task.app_scope, #scheduled_tasks, task.id)) {
                return false;
            };
            activeLeases.close(taskKey(task.app_scope, task.id));
        };

        func run(task : Types.Task) : async () {
            let key = taskKey(task.app_scope, task.id);
            if (
                not registry.allowed(
                    task.app_scope,
                    #scheduled_tasks,
                    task.id,
                ) or
                not Set.insert(running, Text.compare, key)
            ) return;
            let lease = InvocationLease(func() : Bool {
                registry.allowed(
                    task.app_scope,
                    #scheduled_tasks,
                    task.id,
                )
            });
            activeLeases.add(key, lease);
            ignore await executeInvocation(task, lease, registry);
            activeLeases.remove(key);
            Set.remove(running, Text.compare, key);
        };

        func findTask(
            appScope : CapabilityTypes.AppScope,
            taskId : Text,
        ) : ?Types.Task {
            for (task in Map.values(declarations)) {
                if (
                    task.app_scope.app_id == appScope.app_id and
                    task.app_scope.installation_uid == appScope.installation_uid and
                    task.id == taskId
                ) {
                    return ?task;
                };
            };
            null;
        };

        func armDeferred(
            appScope : CapabilityTypes.AppScope,
            input : Types.DeferredTimerArmInputV1,
            run : (() -> ()) -> (),
        ) : async* Types.DeferredTimerArmResultV1 {
            if (
                not CapabilityScope.valid(appScope) or
                not validDeferredKey(input.key) or
                input.delay_seconds < MIN_DEFERRED_DELAY_SECONDS or
                input.delay_seconds > MAX_DEFERRED_DELAY_SECONDS
            ) return #err(#invalid);
            if (
                not deploymentCommitted() or
                not scopeActive(appScope)
            ) return #err(#source_gone);

            let key = taskKey(appScope, input.key);
            let now = nowNs();
            switch (Map.get(deferredTimers, Text.compare, key)) {
                case (?current) {
                    if (
                        current.phase == #waiting and
                        now >= current.due_at_ns
                    ) {
                        // A trapping one-shot rolls its callback message back
                        // but the native timer has still fired. The next
                        // ordinary event may reclaim that overdue logical key.
                        removeDeferred(key, current.scope);
                    } else {
                        return #already_armed(deferredStatusOf(current));
                    };
                };
                case null {};
            };
            let scopeKey = CapabilityScope.key(appScope);
            let count = switch (
                Map.get(deferredCounts, Text.compare, scopeKey)
            ) {
                case (?value) value;
                case null 0;
            };
            if (count >= MAX_DEFERRED_TIMERS_PER_SCOPE) {
                return #err(#full);
            };

            let delayNs = input.delay_seconds * NANOS_PER_SECOND;
            if (delayNs > Nat64.toNat(MAX_NAT64)) {
                return #err(#invalid);
            };
            let delay = Nat64.fromNat(delayNs);
            if (delay > MAX_NAT64 - now) return #err(#invalid);
            nextDeferredTimerId += 1;
            let timer : DeferredTimer = {
                id = nextDeferredTimerId;
                scope = appScope;
                due_at_ns = now + delay;
                var phase = #waiting;
            };
            Map.add(deferredTimers, Text.compare, key, timer);
            Map.add(deferredCounts, Text.compare, scopeKey, count + 1);
            ignore Timer.setTimer<system>(
                #seconds(input.delay_seconds),
                func() : async () {
                    runDeferred(
                        key,
                        timer.id,
                        input.callback,
                        run,
                    );
                },
            );
            #armed(deferredStatusOf(timer));
        };

        func deferredStatus(
            appScope : CapabilityTypes.AppScope,
            key : Text,
        ) : ?Types.DeferredTimerStatusV1 {
            if (
                not CapabilityScope.valid(appScope) or
                not validDeferredKey(key)
            ) return null;
            switch (
                Map.get(
                    deferredTimers,
                    Text.compare,
                    taskKey(appScope, key),
                )
            ) {
                case (?timer) ?deferredStatusOf(timer);
                case null null;
            };
        };

        func runDeferred(
            key : Text,
            id : Nat,
            callback : () -> (),
            run : (() -> ()) -> (),
        ) : () {
            let ?timer = Map.get(deferredTimers, Text.compare, key) else {
                return;
            };
            if (timer.id != id) return;
            timer.phase := #running;
            if (
                deploymentCommitted() and
                scopeActive(timer.scope)
            ) {
                run(callback);
            };
            removeDeferred(key, timer.scope);
        };

        func removeDeferred(
            key : Text,
            appScope : CapabilityTypes.AppScope,
        ) : () {
            Map.remove(deferredTimers, Text.compare, key);
            let scopeKey = CapabilityScope.key(appScope);
            switch (Map.get(deferredCounts, Text.compare, scopeKey)) {
                case (?count) {
                    if (count <= 1) {
                        Map.remove(deferredCounts, Text.compare, scopeKey);
                    } else {
                        Map.add(
                            deferredCounts,
                            Text.compare,
                            scopeKey,
                            count - 1,
                        );
                    };
                };
                case null {};
            };
        };

        func dispatchRunOnStart<system>() : () {
            if (not runOnStartGate.claim()) return;
            for (task in Map.values(declarations)) {
                if (task.run_on_start) {
                    ignore Timer.setTimer<system>(
                        #seconds 0,
                        func() : async () { await run(task) },
                    );
                };
            };
        };

    };

    public func scheduledTaskCountWithinBound(count : Nat) : Bool {
        count <= MAX_SCHEDULED_TASKS;
    };

    // Shared by the timer path and interpreted tests. A callback that actually
    // starts produces exactly one terminal generic-registry event; skipped
    // ticks never enter this function.
    public func executeInvocation(
        task : Types.Task,
        lease : InvocationLease,
        registry : CapabilityTypes.RuntimeRegistry,
    ) : async CapabilityTypes.CapabilityOutcome {
        var callbackOutcome : CapabilityTypes.CapabilityOutcome = #ok;
        try {
            await (task.callback)(lease.view());
        } catch (_error) {
            callbackOutcome := #failed;
        };
        // Authority may disappear while app code is suspended at await. The
        // generic toggle closes the controller immediately, while scope/plan
        // replacement makes the registry deny the exact declaration. Either
        // signal wins over the callback's local success or failure result.
        let outcome : CapabilityTypes.CapabilityOutcome = if (
            lease.isOpen() and registry.allowed(
                task.app_scope,
                #scheduled_tasks,
                task.id,
            )
        ) {
            callbackOutcome;
        } else {
            #revoked;
        };
        lease.close();
        ignore registry.record(
            task.app_scope,
            #scheduled_tasks,
            task.id,
            "run",
            outcome,
        );
        outcome;
    };

    func taskKey(appScope : CapabilityTypes.AppScope, taskId : Text) : Text {
        CapabilityScope.key(appScope) # "\00" # taskId;
    };

    func deferredStatusOf(
        timer : DeferredTimer
    ) : Types.DeferredTimerStatusV1 {
        {
            due_at_ns = timer.due_at_ns;
            phase = timer.phase;
        };
    };

    func validDeferredKey(key : Text) : Bool {
        key.size() >= 1 and key.size() <= 40;
    };

    func validate(task : Types.Task) : () {
        assert (CapabilityScope.valid(task.app_scope));
        assert (task.id.size() >= 1 and task.id.size() <= 40);
        assert (task.method.size() >= 1 and task.method.size() <= 128);
        assert (task.interval_seconds >= 10 and task.interval_seconds <= 2_592_000);
        assert (task.max_backend_calls >= 1 and task.max_backend_calls <= 100);
    };
};
