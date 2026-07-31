import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Iter "mo:core/Iter";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import VarArray "mo:core/VarArray";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import InstallLimits "../install/Limits";
import Memory "Memory";
import Types "Types";

module {
    let MAX_BATCH = 20;
    let MAX_ARGUMENT_BYTES = 262_144;
    let MAX_REPLY_BYTES = 1_048_576;
    let MAX_GLOBAL_IN_FLIGHT = 100;
    let MAX_RESERVATION_ACTIONS = 64;
    public let MAX_CYCLES_PER_CALL : Nat = 100_000_000_000_000;
    public let MAX_CYCLES_PER_DAY : Nat = 1_000_000_000_000_000;
    public let MIN_REMAINING_CYCLES : Nat = 250_000_000_000;
    // Longest compiler-owned app wrapper is 185 ASCII bytes in V1.
    let MAX_METHOD_BYTES = 192;

    type Prepared = {
        #ready : Types.CallResult;
        #request : Types.CallRequest;
    };

    type ConfiguredDeclaration = {
        app_scope : CapabilityTypes.AppScope;
        backend_calls : Types.BackendCallsDeclaration;
    };

    public type InvocationLease = {
        active : () -> Bool;
    };

    public class ScheduledBudget(
        taskId : Text,
        limit : Nat,
        lease : InvocationLease,
    ) {
        assert (taskId.size() >= 1 and taskId.size() <= 40);
        assert (limit >= 1 and limit <= 100);
        public let task_id = taskId;
        var remaining = limit;

        public func consume(amount : Nat) : Bool {
            if (not lease.active()) return false;
            if (amount > remaining) return false;
            remaining -= amount;
            true;
        };

        public func available() : Nat { remaining };

        public func active() : Bool { lease.active() };
    };

    public class Service(
        mem : Types.Memory,
        scopeActive : CapabilityTypes.AppScope -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        transport : Types.Transport,
        outgoingCycles : Types.OutgoingCycleAccounting,
    ) {
        let declarations = Map.empty<Text, ConfiguredDeclaration>();
        var configured = false;
        let inFlight = Map.empty<Text, Nat>();
        var globalInFlight = 0;

        public func configure(
            next : [Types.AppCapabilitiesDeclaration],
            selfPrincipal : Principal,
        ) : () {
            assert (not configured);
            let freshPlans = List.empty<Types.InstallReservationPlan>();
            let appIds = Set.empty<Text>();
            var everyScopeActive = true;
            for (declaration in next.vals()) {
                validateDeclaration(declaration, selfPrincipal);
                assert (Set.insert(
                    appIds,
                    Text.compare,
                    declaration.app_scope.app_id,
                ));
                if (not scopeActive(declaration.app_scope)) {
                    everyScopeActive := false;
                };
                switch (declaration.backend_calls) {
                    case null {};
                    case (?backendCalls) {
                        Map.add(
                            declarations,
                            Text.compare,
                            declaration.app_scope.app_id,
                            {
                                app_scope = declaration.app_scope;
                                backend_calls = backendCalls;
                            },
                        );
                        if (backendCalls.install_reservations.size() > 0) {
                            List.add(freshPlans, {
                                app_scope = declaration.app_scope;
                                reservations =
                                    backendCalls.install_reservations;
                            });
                        };
                    };
                };
            };
            configured := true;

            // A clean reinstall has no predecessor journal or reservation
            // claims. Its compiler-owned declarations are already the active
            // inventory, so materialize their reviewed defaults now. A
            // browser-upgrade target has no active scope until commit and
            // therefore consumes only the claims prepared by its predecessor.
            if (Memory.isPristine(mem) and everyScopeActive) {
                assert (Memory.finalizeInstallReservations(
                    mem,
                    List.toArray(freshPlans),
                    supportsScope,
                    selfPrincipal,
                    nowNanos(),
                ));
            };
        };

        public func supportsScope(appScope : CapabilityTypes.AppScope, mode : Text) : Bool {
            let ?declaration = backendDeclaration(appScope) else return false;
            for (allowed in declaration.reservation_scopes.vals()) {
                if (allowed == mode) return true;
            };
            false;
        };

        public func capability(
            appScope : CapabilityTypes.AppScope,
            self : actor {},
        ) : Types.Capability {
            capabilityWithBudget(appScope, self, null);
        };

        public func scheduledCapability(
            appScope : CapabilityTypes.AppScope,
            taskId : Text,
            limit : Nat,
            lease : InvocationLease,
            self : actor {},
        ) : Types.Capability {
            capabilityWithBudget(
                appScope,
                self,
                ?ScheduledBudget(taskId, limit, lease),
            );
        };

        func capabilityWithBudget(
            appScope : CapabilityTypes.AppScope,
            self : actor {},
            budget : ?ScheduledBudget,
        ) : Types.Capability {
            let declaration = switch (backendDeclaration(appScope)) {
                case (?value) value;
                case null Runtime.trap("Backend-call capability is not declared");
            };
            let selfPrincipal = Principal.fromActor(self);
            {
                canister_principal = selfPrincipal;
                can_call = func(canister : Principal, method : Text) : Bool {
                    policyError(appScope, selfPrincipal, {
                        canister;
                        method;
                        args = Blob.fromArray([]);
                        cycles = 0;
                    }, budget) == null;
                };
                call = func(request : Types.CallRequest) : async* Types.CallResult {
                    await* callOne(appScope, selfPrincipal, declaration, budget, request);
                };
                call_batch = func(requests : [Types.CallRequest]) : async* [Types.CallResult] {
                    await* callBatch(appScope, selfPrincipal, declaration, budget, requests);
                };
            };
        };

        public func reservations() : [Types.ReservationSummary] {
            Memory.list(mem);
        };

        public func applyReservations(
            input : Types.ReservationApplyInput,
            caller : Principal,
            self : actor {},
        ) : [Types.ReservationSummary] {
            assert (input.actions.size() <= MAX_RESERVATION_ACTIONS);
            let ?appScope = configuredScope(input.app_id) else {
                Runtime.trap("Backend-call capability is not declared");
            };
            assert (scopeActive(appScope));
            let selfPrincipal = Principal.fromActor(self);
            let previous = Set.empty<Text>();
            for (action in input.actions.vals()) {
                let scope = actionScope(action);
                assert (supportsScope(appScope, Memory.scopeKind(scope)));
                validateScope(scope, selfPrincipal);
                let key = scopeKey(scope);
                assert (Set.insert(previous, Text.compare, key));
            };
            switch (Memory.apply(
                mem,
                appScope,
                input.actions,
                caller,
                nowNanos(),
            )) {
                case (?reservations) reservations;
                case null Runtime.trap(
                    "Backend-call reservation conflicts with another app or the reservation limit was reached"
                );
            };
        };

        // Reserve every conflict/capacity slot while the predecessor Kernel is
        // still running. The install journal binds these plans to one target
        // deployment; install_code is dispatched only after this succeeds.
        public func prepareInstallReservations(
            apps : [Types.InstallReservationsPrepareApp],
            targetScopes : [CapabilityTypes.AppScope],
            changedScopes : [CapabilityTypes.AppScope],
            caller : Principal,
            selfPrincipal : Principal,
        ) : () {
            assert (
                apps.size() <=
                InstallLimits.MAX_APP_INSTANCES
            );
            let targets = Map.empty<Text, CapabilityTypes.AppScope>();
            for (targetScope in targetScopes.vals()) {
                assert (targetScope.installation_uid > 0);
                assert (validAppId(targetScope.app_id));
                assert (not Map.containsKey(
                    targets,
                    Text.compare,
                    targetScope.app_id,
                ));
                Map.add(
                    targets,
                    Text.compare,
                    targetScope.app_id,
                    targetScope,
                );
            };
            let changed = Set.empty<Text>();
            for (changedScope in changedScopes.vals()) {
                let ?targetScope = Map.get(
                    targets,
                    Text.compare,
                    changedScope.app_id,
                ) else Runtime.trap(
                    "Changed install reservation app is not in the target inventory"
                );
                assert (CapabilityScope.equal(targetScope, changedScope));
                assert (Set.insert(
                    changed,
                    Text.compare,
                    changedScope.app_id,
                ));
            };

            let plans = List.empty<Types.InstallReservationPlan>();
            var previousAppId : ?Text = null;
            for (app in apps.vals()) {
                assert (validAppId(app.app_id));
                switch (previousAppId) {
                    case null {};
                    case (?previous) {
                        assert (Text.compare(previous, app.app_id) == #less);
                    };
                };
                previousAppId := ?app.app_id;
                assert (
                    app.reservations.size() >= 1 and
                    app.reservations.size() <= MAX_RESERVATION_ACTIONS
                );
                let ?targetScope = Map.get(
                    targets,
                    Text.compare,
                    app.app_id,
                ) else Runtime.trap(
                    "Install reservation app is not in the target inventory"
                );
                let previousScopes = Set.empty<Text>();
                for (scope in app.reservations.vals()) {
                    validateScope(scope, selfPrincipal);
                    assert (Set.insert(
                        previousScopes,
                        Text.compare,
                        scopeKey(scope),
                    ));
                };
                // A rebuilt but otherwise unchanged app must not recreate a
                // default that its owner deliberately revoked.
                if (Set.contains(changed, Text.compare, app.app_id)) {
                    List.add(plans, {
                        app_scope = targetScope;
                        reservations = app.reservations;
                    });
                };
            };
            if (not Memory.prepareInstallClaims(
                mem,
                List.toArray(plans),
                caller,
                nowNanos(),
            )) {
                Runtime.trap(
                    "Install-time backend reservation conflicts with another app, changed between retries, or exceeds reservation capacity"
                );
            };
        };

        // Read-only readiness check used before the lifecycle commit. Claims
        // remain inert and hidden until the current commit atomically
        // materializes them together with inventory promotion.
        public func canFinalizeInstallReservations(
            appScopes : [CapabilityTypes.AppScope],
            caller : Principal,
            selfPrincipal : Principal,
        ) : Bool {
            reconcileConfiguredInstallReservations(
                appScopes,
                caller,
                selfPrincipal,
                false,
            );
        };

        // Runs in the compiled target actor before inventory promotion. The
        // transient compiler declaration, not the caller-supplied predecessor
        // plan, is authoritative. A mismatch either repairs atomically from
        // the frozen active table or returns false without consuming claims.
        public func finalizeInstallReservations(
            appScopes : [CapabilityTypes.AppScope],
            caller : Principal,
            selfPrincipal : Principal,
        ) : Bool {
            reconcileConfiguredInstallReservations(
                appScopes,
                caller,
                selfPrincipal,
                true,
            );
        };

        func reconcileConfiguredInstallReservations(
            appScopes : [CapabilityTypes.AppScope],
            caller : Principal,
            selfPrincipal : Principal,
            persist : Bool,
        ) : Bool {
            let ?plans = configuredInstallReservationPlans(
                appScopes,
                selfPrincipal,
            ) else return false;
            if (persist) {
                Memory.finalizeInstallReservations(
                    mem,
                    plans,
                    supportsScope,
                    caller,
                    nowNanos(),
                );
            } else {
                Memory.canFinalizeInstallReservations(
                    mem,
                    plans,
                    supportsScope,
                    caller,
                    nowNanos(),
                );
            };
        };

        func configuredInstallReservationPlans(
            appScopes : [CapabilityTypes.AppScope],
            selfPrincipal : Principal,
        ) : ?[Types.InstallReservationPlan] {
            if (not configured) return null;
            let plans = List.empty<Types.InstallReservationPlan>();
            let previousApps = Set.empty<Text>();
            for (appScope in appScopes.vals()) {
                if (not Set.insert(
                    previousApps,
                    Text.compare,
                    appScope.app_id,
                )) return null;
                // This broker's declarations contain exactly the target apps
                // that request backend-call authority. A changed app absent
                // from that map has no reservation work; other capability
                // services validate their own compiler-owned declarations.
                switch (Map.get(
                    declarations,
                    Text.compare,
                    appScope.app_id,
                )) {
                    case null {};
                    case (?configuredDeclaration) {
                        if (not CapabilityScope.equal(
                            configuredDeclaration.app_scope,
                            appScope,
                        )) return null;
                        let declaration =
                            configuredDeclaration.backend_calls;
                        for (
                            scope in
                            declaration.install_reservations.vals()
                        ) {
                            if (not scopeValid(
                                scope,
                                selfPrincipal,
                            )) return null;
                        };
                        if (
                            declaration.install_reservations.size() > 0
                        ) {
                            List.add(plans, {
                                app_scope = appScope;
                                reservations =
                                    declaration.install_reservations;
                            });
                        };
                    };
                };
            };
            ?List.toArray(plans);
        };

        public func removeAppScope(appScope : CapabilityTypes.AppScope) : () {
            Memory.removeAppScope(mem, appScope);
        };

        public func pendingInstallReservationBlockers(
            appScopes : [CapabilityTypes.AppScope],
            selfPrincipal : Principal,
        ) : [Types.PendingReservationBlocker] {
            let ?plans = configuredInstallReservationPlans(
                appScopes,
                selfPrincipal,
            ) else return [];
            Memory.installRecoveryBlockers(mem, plans, supportsScope);
        };

        public func releasePendingReservation(
            appScopes : [CapabilityTypes.AppScope],
            selfPrincipal : Principal,
            id : Nat,
        ) : Bool {
            let blockers = pendingInstallReservationBlockers(
                appScopes,
                selfPrincipal,
            );
            if (
                blockers.size() != 1 or
                blockers[0].reservation.id != id
            ) return false;
            Memory.removeActive(mem, id);
        };

        public func removeIncompatible() : () {
            Memory.removeIncompatible(mem, supportsScope);
        };

        func callOne(
            appScope : CapabilityTypes.AppScope,
            selfPrincipal : Principal,
            declaration : Types.BackendCallsDeclaration,
            budget : ?ScheduledBudget,
            request : Types.CallRequest,
        ) : async* Types.CallResult {
            let results = await* callBatchInner(
                appScope,
                selfPrincipal,
                declaration,
                budget,
                [request],
            );
            let result = results[0];
            ignore registry.record(
                appScope,
                #backend_calls,
                "default",
                "call",
                capabilityOutcome(results),
            );
            result;
        };

        func callBatch(
            appScope : CapabilityTypes.AppScope,
            selfPrincipal : Principal,
            declaration : Types.BackendCallsDeclaration,
            budget : ?ScheduledBudget,
            requests : [Types.CallRequest],
        ) : async* [Types.CallResult] {
            let results = await* callBatchInner(
                appScope,
                selfPrincipal,
                declaration,
                budget,
                requests,
            );
            ignore registry.record(
                appScope,
                #backend_calls,
                "default",
                "call_batch",
                capabilityOutcome(results),
            );
            results;
        };

        func callBatchInner(
            appScope : CapabilityTypes.AppScope,
            selfPrincipal : Principal,
            declaration : Types.BackendCallsDeclaration,
            budget : ?ScheduledBudget,
            requests : [Types.CallRequest],
        ) : async* [Types.CallResult] {
            if (requests.size() == 0) return [];
            if (
                requests.size() > MAX_BATCH or
                requests.size() > declaration.max_concurrency
            ) {
                return repeatedError(requests.size(), "batch_limit", "Call batch is too large");
            };

            let prepared = List.empty<Prepared>();
            var approved = 0;
            var attachedCycles = 0;
            var callCosts = 0;
            for (request in requests.vals()) {
                switch (policyError(appScope, selfPrincipal, request, budget)) {
                    case (?failure) List.add(prepared, #ready(failure));
                    case null {
                        List.add(prepared, #request(request));
                        approved += 1;
                        attachedCycles += request.cycles;
                        callCosts += transport.call_cost(
                            request.method,
                            request.args.size(),
                        );
                    };
                };
            };
            if (approved == 0) return preparedResults(prepared);

            // Capture the registry generation before creating any remote
            // future. A disable followed by re-enable must not resurrect this
            // operation while it is suspended at an await.
            let authorityLease = registry.lease(
                appScope,
                #backend_calls,
                "default",
            );
            switch (authorityLease) {
                case null return preparedError(
                    prepared,
                    "capability_disabled",
                    "Backend-call capability is disabled",
                );
                case (?_) {};
            };

            let active = appInFlight(appScope);
            if (
                active + approved > declaration.max_concurrency or
                globalInFlight + approved > MAX_GLOBAL_IN_FLIGHT
            ) {
                return preparedError(
                    prepared,
                    "concurrency_limit",
                    "Too many backend calls are already in flight",
                );
            };
            if (not scheduledBudgetAvailable(budget, approved)) {
                return preparedError(
                    prepared,
                    "scheduled_budget_exhausted",
                    "Scheduled backend-call budget is exhausted",
                );
            };
            if (not cycleBalanceAvailable(
                transport.cycle_balance(),
                attachedCycles,
                callCosts,
            )) {
                return preparedError(
                    prepared,
                    "low_cycles",
                    "Neutron does not have enough cycles for this backend call",
                );
            };
            let ?cycleReservation = outgoingCycles.reserve(
                appScope,
                attachedCycles,
                ?declaration.max_cycles_per_day,
                approved,
            ) else {
                return preparedError(
                    prepared,
                    "cycles_daily_limit",
                    "The app's daily backend-call cycle budget is exhausted",
                );
            };
            // Admission above checked this invocation-local counter without an
            // await, so this cannot fail unless an internal invariant breaks.
            assert (consumeScheduledBudget(budget, approved));
            increment(appScope, approved);

            // Build every proper remote future before the first regular await.
            // Keep them in direct-indexed mutable arrays: iterator containers
            // do not preserve this runtime-only value reliably across awaits.
            let futures = VarArray.repeat<?(async Types.TransportResult)>(null, approved);
            let futureSlots = VarArray.repeat<Nat>(0, approved);
            let futureAttached = VarArray.repeat<Nat>(0, approved);
            let slots = VarArray.repeat<?Types.CallResult>(null, requests.size());
            var slot = 0;
            var futureCount = 0;
            for (entry in List.values(prepared)) {
                switch (entry) {
                    case (#ready(result)) slots[slot] := ?result;
                    case (#request(request)) {
                        futures[futureCount] := ?transport.call(request);
                        futureSlots[futureCount] := slot;
                        futureAttached[futureCount] := request.cycles;
                        futureCount += 1;
                    };
                };
                slot += 1;
            };
            assert (outgoingCycles.commit(cycleReservation));

            var futureIndex = 0;
            var chargedCycles = 0;
            while (futureIndex < futureCount) {
                let ?future = futures[futureIndex] else {
                    Runtime.trap("Backend-call future is missing");
                };
                let transportResult : Types.TransportResult = try {
                    // The first await commits and dispatches every pending call.
                    // Later futures are already in flight, so avoid another
                    // commit point when their replies are ready.
                    if (futureIndex == 0) {
                        await future;
                    } else {
                        await? future;
                    };
                } catch (error) {
                    #err({
                        message = Error.message(error);
                        // A malformed trusted adapter must fail closed. Once a
                        // future may have dispatched, unresolved gross remains
                        // charged against the daily safety ceiling.
                        charged_cycles = futureAttached[futureIndex];
                    });
                };
                let (result, charged) : (Types.CallResult, Nat) = switch (transportResult) {
                    case (#ok(value)) {
                        let result = if (value.reply.size() > MAX_REPLY_BYTES) {
                            failure("reply_limit", "Backend call reply is too large");
                        } else #ok(value.reply);
                        (result, boundedCharge(
                            value.charged_cycles,
                            futureAttached[futureIndex],
                        ));
                    };
                    case (#err(value)) {
                        (
                            failure(
                                "call_rejected",
                                boundedText(value.message, 512),
                            ),
                            boundedCharge(
                                value.charged_cycles,
                                futureAttached[futureIndex],
                            ),
                        );
                    };
                };
                chargedCycles += charged;
                decrement(appScope, 1);
                slots[futureSlots[futureIndex]] := ?enforcePostDispatch(
                    budget,
                    scopeActive(appScope) and runtimeLeaseActive(authorityLease),
                    result,
                );
                futureIndex += 1;
            };
            outgoingCycles.finalize(cycleReservation, chargedCycles);
            Array.tabulate<Types.CallResult>(
                slots.size(),
                func(index) {
                    switch (slots[index]) {
                        case (?result) result;
                        case null failure("internal", "Backend-call result is missing");
                    };
                },
            );
        };

        func policyError(
            appScope : CapabilityTypes.AppScope,
            selfPrincipal : Principal,
            request : Types.CallRequest,
            budget : ?ScheduledBudget,
        ) : ?Types.CallResult {
            switch (budget) {
                case (?scheduled) {
                    if (not scheduled.active()) {
                        return ?failure(
                            "invocation_expired",
                            "Scheduled-task authority is no longer active",
                        );
                    };
                    if (scheduled.available() == 0) {
                        return ?failure(
                            "scheduled_budget_exhausted",
                            "Scheduled backend-call budget is exhausted",
                        );
                    };
                };
                case null {};
            };
            if (not scopeActive(appScope)) {
                return ?failure("capability_revoked", "Backend-call capability is inactive");
            };
            let ?declaration = backendDeclaration(appScope) else {
                return ?failure("capability_missing", "Backend-call capability is unavailable");
            };
            if (not registry.allowed(appScope, #backend_calls, "default")) {
                return ?failure("capability_disabled", "Backend-call capability is disabled");
            };
            if (not validTarget(request.canister, selfPrincipal)) {
                return ?failure("target_blocked", "Backend-call destination is blocked");
            };
            if (not validMethod(request.method)) {
                return ?failure("invalid_method", "Backend-call method is invalid");
            };
            if (request.args.size() > MAX_ARGUMENT_BYTES) {
                return ?failure("argument_limit", "Backend-call arguments are too large");
            };
            if (request.cycles > declaration.max_cycles_per_call) {
                return ?failure(
                    "cycles_per_call_limit",
                    "Backend-call cycles exceed the app's per-call ceiling",
                );
            };
            if (not Memory.allows(mem, appScope, request.canister, request.method)) {
                return ?failure("not_reserved", "Backend call is not reserved for this app");
            };
            null;
        };

        func backendDeclaration(
            appScope : CapabilityTypes.AppScope,
        ) : ?Types.BackendCallsDeclaration {
            if (not configured) return null;
            let ?configuredDeclaration = Map.get(
                declarations,
                Text.compare,
                appScope.app_id,
            ) else return null;
            if (
                not CapabilityScope.equal(
                    configuredDeclaration.app_scope,
                    appScope,
                )
            ) return null;
            ?configuredDeclaration.backend_calls;
        };

        func configuredScope(appId : Text) : ?CapabilityTypes.AppScope {
            if (not configured) return null;
            switch (Map.get(declarations, Text.compare, appId)) {
                case (?configured) ?configured.app_scope;
                case null null;
            };
        };

        func appInFlight(appScope : CapabilityTypes.AppScope) : Nat {
            switch (Map.get(inFlight, Text.compare, CapabilityScope.key(appScope))) {
                case (?count) count;
                case null 0;
            };
        };

        func consumeScheduledBudget(budget : ?ScheduledBudget, amount : Nat) : Bool {
            switch (budget) {
                case null true;
                case (?scheduled) scheduled.consume(amount);
            };
        };

        func scheduledBudgetAvailable(
            budget : ?ScheduledBudget,
            amount : Nat,
        ) : Bool {
            switch (budget) {
                case null true;
                case (?scheduled) {
                    scheduled.active() and scheduled.available() >= amount;
                };
            };
        };

        func runtimeLeaseActive(
            lease : ?CapabilityTypes.RuntimeLease,
        ) : Bool {
            switch (lease) {
                case (?active) active.active();
                case null false;
            };
        };

        func increment(appScope : CapabilityTypes.AppScope, amount : Nat) : () {
            if (amount == 0) return;
            Map.add(
                inFlight,
                Text.compare,
                CapabilityScope.key(appScope),
                appInFlight(appScope) + amount,
            );
            globalInFlight += amount;
        };

        func decrement(appScope : CapabilityTypes.AppScope, amount : Nat) : () {
            if (amount == 0) return;
            let key = CapabilityScope.key(appScope);
            let remaining = appInFlight(appScope) - amount;
            if (remaining == 0) {
                Map.remove(inFlight, Text.compare, key);
            } else {
                Map.add(inFlight, Text.compare, key, remaining);
            };
            globalInFlight -= amount;
        };
    };

    // Reduce one broker operation, including a batch with mixed per-request
    // results, to one bounded registry event. Revocation and dispatched-call
    // uncertainty take precedence over ordinary transport or policy failures.
    public func capabilityOutcome(
        results : [Types.CallResult],
    ) : CapabilityTypes.CapabilityOutcome {
        var denied = false;
        var failed = false;
        var busy = false;
        var revoked = false;
        for (result in results.vals()) {
            switch (result) {
                case (#ok(_)) {};
                case (#err(error)) {
                    switch (error.code) {
                        case ("invocation_expired") revoked := true;
                        case ("capability_revoked") revoked := true;
                        case ("capability_disabled") revoked := true;
                        case ("invocation_revoked_after_dispatch") revoked := true;
                        case ("revoked_after_dispatch") revoked := true;
                        case ("call_rejected") failed := true;
                        case ("reply_limit") failed := true;
                        case ("internal") failed := true;
                        case ("concurrency_limit") busy := true;
                        case ("scheduled_budget_exhausted") denied := true;
                        case (_) denied := true;
                    };
                };
            };
        };
        if (revoked) return #revoked;
        if (failed) return #failed;
        if (busy) return #busy;
        if (denied) return #denied;
        #ok;
    };

    // A dispatched update cannot be cancelled. If its invocation or app scope
    // was revoked while awaiting the reply, suppress all reply bytes and make
    // the unknown remote outcome explicit to the caller.
    public func enforcePostDispatch(
        budget : ?ScheduledBudget,
        authorityIsActive : Bool,
        result : Types.CallResult,
    ) : Types.CallResult {
        switch (budget) {
            case (?scheduled) {
                if (not scheduled.active()) {
                    return failure(
                        "invocation_revoked_after_dispatch",
                        "Scheduled-task authority ended while the request was in flight; the remote outcome is unknown",
                    );
                };
            };
            case null {};
        };
        if (not authorityIsActive) {
            return failure(
                "revoked_after_dispatch",
                "Backend-call authority changed while the request was in flight; the remote outcome is unknown",
            );
        };
        result;
    };

    func preparedResults(prepared : List.List<Prepared>) : [Types.CallResult] {
        let results = List.empty<Types.CallResult>();
        for (entry in List.values(prepared)) {
            switch (entry) {
                case (#ready(result)) List.add(results, result);
                case (#request(_)) {
                    List.add(results, failure("internal", "Approved call was not dispatched"));
                };
            };
        };
        List.toArray(results);
    };

    // Preserve the exact errors for entries rejected during static policy
    // validation while atomically denying every otherwise-approved request.
    func preparedError(
        prepared : List.List<Prepared>,
        code : Text,
        message : Text,
    ) : [Types.CallResult] {
        let results = List.empty<Types.CallResult>();
        for (entry in List.values(prepared)) {
            switch (entry) {
                case (#ready(result)) List.add(results, result);
                case (#request(_)) List.add(results, failure(code, message));
            };
        };
        List.toArray(results);
    };

    public func boundedCharge(reported : Nat, attached : Nat) : Nat {
        if (reported > attached) attached else reported;
    };

    public func cycleBalanceAvailable(
        balance : Nat,
        attached : Nat,
        callCost : Nat,
    ) : Bool {
        balance >= attached + callCost + MIN_REMAINING_CYCLES;
    };

    public func cycleDeclarationValid(
        maxPerCall : Nat,
        maxPerDay : Nat,
    ) : Bool {
        maxPerCall <= MAX_CYCLES_PER_CALL and
        maxPerDay <= MAX_CYCLES_PER_DAY and
        maxPerCall <= maxPerDay;
    };

    func actionScope(action : Types.ReservationAction) : Types.ReservationScope {
        switch (action) {
            case (#reserve(scope)) scope;
            case (#release(scope)) scope;
        };
    };

    func scopeKey(scope : Types.ReservationScope) : Text {
        switch (scope) {
            case (#exact(value)) {
                "exact:" # Principal.toText(value.principal) # ":" # value.method;
            };
            case (#principal(principal)) "principal:" # Principal.toText(principal);
            case (#method(method)) "method:" # method;
        };
    };

    func validateDeclaration(
        declaration : Types.AppCapabilitiesDeclaration,
        selfPrincipal : Principal,
    ) : () {
        assert (validAppId(declaration.app_scope.app_id));
        assert (declaration.app_scope.installation_uid > 0);
        let ?backendCalls = declaration.backend_calls else return;
        assert (
            backendCalls.max_concurrency >= 1 and
            backendCalls.max_concurrency <= MAX_BATCH
        );
        assert (cycleDeclarationValid(
            backendCalls.max_cycles_per_call,
            backendCalls.max_cycles_per_day,
        ));
        assert (backendCalls.reservation_scopes.size() >= 1);
        let previous = Set.empty<Text>();
        for (scope in backendCalls.reservation_scopes.vals()) {
            assert (scope == "exact" or scope == "principal" or scope == "method");
            assert (Set.insert(previous, Text.compare, scope));
        };
        validateInstallReservations(
            backendCalls,
            backendCalls.install_reservations,
            selfPrincipal,
        );
    };

    func validateInstallReservations(
        backendCalls : Types.BackendCallsDeclaration,
        installReservations : [Types.ReservationScope],
        selfPrincipal : Principal,
    ) : () {
        assert (
            installReservations.size() <=
            MAX_RESERVATION_ACTIONS
        );
        let previousInstallReservations = Set.empty<Text>();
        for (scope in installReservations.vals()) {
            validateScope(scope, selfPrincipal);
            var supported = false;
            for (allowed in backendCalls.reservation_scopes.vals()) {
                if (allowed == Memory.scopeKind(scope)) supported := true;
            };
            assert (supported);
            assert (
                Set.insert(
                previousInstallReservations,
                Text.compare,
                scopeKey(scope),
                )
            );
        };
    };

    func validateScope(scope : Types.ReservationScope, selfPrincipal : Principal) : () {
        assert (scopeValid(scope, selfPrincipal));
    };

    func scopeValid(
        scope : Types.ReservationScope,
        selfPrincipal : Principal,
    ) : Bool {
        switch (scope) {
            case (#exact(value)) {
                validTarget(value.principal, selfPrincipal) and
                validMethod(value.method);
            };
            case (#principal(principal)) {
                validTarget(principal, selfPrincipal);
            };
            case (#method(method)) validMethod(method);
        };
    };

    func validTarget(principal : Principal, selfPrincipal : Principal) : Bool {
        not Principal.isAnonymous(principal) and
        Principal.toText(principal) != "aaaaa-aa" and
        not Principal.equal(principal, selfPrincipal);
    };

    func validMethod(method : Text) : Bool {
        if (method.size() < 1 or method.size() > MAX_METHOD_BYTES) return false;
        for (char in method.chars()) {
            if (
                not (
                    (char >= 'a' and char <= 'z') or
                    (char >= 'A' and char <= 'Z') or
                    (char >= '0' and char <= '9') or
                    char == '_'
                )
            ) return false;
        };
        true;
    };

    func validAppId(appId : Text) : Bool {
        CapabilityScope.validAppId(appId);
    };

    func repeatedError(size : Nat, code : Text, message : Text) : [Types.CallResult] {
        Array.tabulate<Types.CallResult>(size, func(_) { failure(code, message) });
    };

    func failure(code : Text, message : Text) : Types.CallResult {
        #err({ code; message = boundedText(message, 512) });
    };

    func boundedText(value : Text, limit : Nat) : Text {
        if (value.size() <= limit) return value;
        Text.fromIter(Iter.take(value.chars(), limit));
    };

    func nowNanos() : Nat64 {
        Nat64.fromNat(Int.abs(Time.now()));
    };
};
