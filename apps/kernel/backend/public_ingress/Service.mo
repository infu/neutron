import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import Types "Types";

module {
    public let MAX_ROUTES_PER_APP : Nat = 32;
    public let MAX_ROUTES_GLOBAL : Nat = 2_048;
    public let MAX_REQUEST_BYTES : Nat = 1_048_576;
    public let MAX_RESPONSE_BYTES : Nat = 1_048_576;
    public let MAX_CALLS_PER_ROUTE_PER_HOUR : Nat = 3_600;
    public let MAX_CALLS_PER_APP_PER_HOUR : Nat = 3_600;
    public let MAX_CALLS_GLOBAL_PER_HOUR : Nat = 16_384;
    public let MAX_REQUIRED_CYCLES : Nat = 100_000_000_000_000;
    public let MAX_PENDING_PER_ROUTE : Nat = 1;
    public let MAX_PENDING_PER_APP : Nat = 2;
    public let MAX_PENDING_GLOBAL : Nat = 8;
    public let MIN_REMAINING_CYCLES : Nat = 250_000_000_000;

    let HOUR_NANOS : Nat64 = 3_600_000_000_000;
    let STALE_PENDING_NANOS : Nat64 = 300_000_000_000;
    let MAX_NAT64 : Nat64 = 18_446_744_073_709_551_615;
    let CALLER_RATE_PREFIX = "\00caller-rate\00";

    type ActiveHandlerDispatch = {
        dispatch_id : Nat64;
        scope : Types.AppScope;
        additional_cycles_available : Nat;
        additional_cycles_requested : Nat;
    };

    public func init() : Types.Memory {
        {
            routes = Map.empty<Text, Types.CommittedRoute>();
            rates_by_route = Map.empty<Text, Types.RateCounter>();
            rates_by_scope = Map.empty<Text, Types.RateCounter>();
            var global_rate = { window_started_at = 0; accepted = 0 };
            pending = Map.empty<Nat64, Types.PendingDispatch>();
            pending_by_route = Map.empty<Text, Nat>();
            pending_by_scope = Map.empty<Text, Nat>();
            var pending_count = 0;
            var next_dispatch_id = 1;
            var last_seen_at = 0;
        };
    };

    public class Service(
        mem : Types.Memory,
        scopeActive : Types.AppScope -> Bool,
        deploymentCommitted : () -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        cycleBalance : () -> Nat,
        cyclesAvailable : () -> Nat,
        acceptCycles : <system>(Nat) -> Nat,
        recordIncomingCycles : (Types.AppScope, Nat) -> (),
        now : () -> Nat64,
    ) {
        let targetRoutes = Map.empty<Text, Types.CommittedRoute>();
        let targetCallerLimits = Map.empty<Text, Nat>();
        let queryHandlers = Map.empty<Text, Types.QueryHandlerV1>();
        let updateHandlers = Map.empty<Text, Types.UpdateHandlerV1>();
        let leases = Map.empty<Nat64, CapabilityTypes.RuntimeLease>();
        var activeHandlerDispatch : ?ActiveHandlerDispatch = null;
        var configured = false;
        var handlersConfigured = false;

        public func configure(apps : [Types.AppDeclaration]) : () {
            assert (not configured);
            var routeCount = 0;
            var globalUpdateCalls = 0;
            for (app in apps.vals()) {
                assert (CapabilityScope.valid(app.app_scope));
                let ?declaration = app.public_ingress else continue;
                assert (
                    declaration.routes.size() >= 1 and
                    declaration.routes.size() <= MAX_ROUTES_PER_APP
                );
                var previous : ?(Text, Text) = null;
                var appUpdateCalls = 0;
                for (authored in declaration.routes.vals()) {
                    let route = normalizeRoute(app.app_scope, authored);
                    switch (previous) {
                        case (?(protocol, id)) assert (
                            Text.compare(protocol, route.protocol) == #less or
                            (
                                protocol == route.protocol and
                                Text.compare(id, route.id) == #less
                            )
                        );
                        case null {};
                    };
                    previous := ?(route.protocol, route.id);
                    let key = routeKey(route.scope, route.protocol, route.id);
                    assert (not Map.containsKey(targetRoutes, Text.compare, key));
                    Map.add(targetRoutes, Text.compare, key, route);
                    switch (authored.max_calls_per_caller_per_hour) {
                        case (?limit) {
                            Map.add(targetCallerLimits, Text.compare, key, limit);
                        };
                        case null {};
                    };
                    routeCount += 1;
                    switch (route.mode) {
                        case (#query_) {};
                        case (#update_) {
                            let ?limit = route.max_calls_per_hour else Runtime.trap(
                                "Public ingress update rate is required"
                            );
                            appUpdateCalls += limit;
                            globalUpdateCalls += limit;
                        };
                    };
                };
                assert (appUpdateCalls <= MAX_CALLS_PER_APP_PER_HOUR);
            };
            assert (routeCount <= MAX_ROUTES_GLOBAL);
            assert (globalUpdateCalls <= MAX_CALLS_GLOBAL_PER_HOUR);
            configured := true;
            recoverInterruptedDispatches();
        };

        public func configureHandlers(
            registrations : [Types.HandlerRegistrationV1],
        ) : () {
            assert (configured and not handlersConfigured);
            for (registration in registrations.vals()) {
                let key = routeKey(
                    registration.app_scope,
                    registration.protocol,
                    registration.method,
                );
                let ?route = Map.get(targetRoutes, Text.compare, key) else Runtime.trap(
                    "Public ingress handler has no declaration"
                );
                switch (route.mode, registration.handler) {
                    case (#query_, #query_(handler)) {
                        assert (not Map.containsKey(queryHandlers, Text.compare, key));
                        Map.add(queryHandlers, Text.compare, key, handler);
                    };
                    case (#update_, #update_(handler)) {
                        assert (not Map.containsKey(updateHandlers, Text.compare, key));
                        Map.add(updateHandlers, Text.compare, key, handler);
                    };
                    case (_) Runtime.trap("Public ingress handler mode does not match declaration");
                };
            };
            assert (
                Map.size(queryHandlers) + Map.size(updateHandlers) ==
                Map.size(targetRoutes)
            );
            handlersConfigured := true;
        };

        public func cyclesCapability(
            scope : Types.AppScope,
        ) : Types.PublicIngressCyclesV1 {
            assert (CapabilityScope.valid(scope));
            {
                available = func() : Nat {
                    let active = activeCyclesFor(scope);
                    active.additional_cycles_available -
                    active.additional_cycles_requested;
                };
                request = func(amount : Nat) : () {
                    let active = activeCyclesFor(scope);
                    let remaining =
                        active.additional_cycles_available -
                        active.additional_cycles_requested;
                    if (amount > remaining) Runtime.trap(
                        "Public ingress handler requested more cycles than remain attached"
                    );
                    activeHandlerDispatch := ?{
                        active with
                        additional_cycles_requested =
                            active.additional_cycles_requested + amount
                    };
                };
            };
        };

        public func commitConfiguration() : () {
            assert (configured and deploymentCommitted());
            for (route in Map.values(targetRoutes)) assert (scopeActive(route.scope));

            let nextRoutes = Map.empty<Text, Types.CommittedRoute>();
            let nextRouteRates = Map.empty<Text, Types.RateCounter>();
            let activeScopes = Map.empty<Text, ()>();
            for ((key, target) in Map.entries(targetRoutes)) {
                let prior = Map.get(mem.routes, Text.compare, key);
                let epoch = switch (prior) {
                    case (?old) {
                        if (old.fingerprint == target.fingerprint) {
                            old.authority_epoch
                        } else {
                            old.authority_epoch + (1 : Nat64)
                        };
                    };
                    case null (1 : Nat64);
                };
                Map.add(nextRoutes, Text.compare, key, {
                    target with authority_epoch = epoch
                });
                switch (prior, Map.get(mem.rates_by_route, Text.compare, key)) {
                    case (?old, ?rate) {
                        if (old.fingerprint == target.fingerprint) {
                            Map.add(nextRouteRates, Text.compare, key, rate);
                        };
                    };
                    case _ {};
                };
                Map.add(activeScopes, Text.compare, CapabilityScope.key(target.scope), ());
            };
            Map.clear(mem.routes);
            for ((key, route) in Map.entries(nextRoutes)) {
                Map.add(mem.routes, Text.compare, key, route);
            };
            Map.clear(mem.rates_by_route);
            for ((key, rate) in Map.entries(nextRouteRates)) {
                Map.add(mem.rates_by_route, Text.compare, key, rate);
            };
            let staleScopeRates = List.empty<Text>();
            for ((key, _) in Map.entries(mem.rates_by_scope)) {
                if (not Map.containsKey(activeScopes, Text.compare, key)) {
                    List.add(staleScopeRates, key);
                };
            };
            for (key in List.values(staleScopeRates)) {
                ignore Map.delete(mem.rates_by_scope, Text.compare, key);
            };
            recoverInterruptedDispatches();
        };

        // The generic registry toggle has its own actor-local lease epoch.
        // This broker epoch independently invalidates persisted dispatch data.
        public func setRouteEnabled(
            scope : Types.AppScope,
            resource : Text,
        ) : () {
            let ?parts = parseResourceId(resource) else return;
            let key = routeKey(scope, parts.protocol, parts.method);
            let ?route = Map.get(mem.routes, Text.compare, key) else return;
            Map.add(mem.routes, Text.compare, key, {
                route with authority_epoch = route.authority_epoch + 1
            });
            discardPendingForRoute(key);
        };

        public func dispatchQuery(
            scope : Types.AppScope,
            protocol : Text,
            caller : Principal,
            request : Types.RequestV1,
        ) : Types.ResultV1 {
            if (not handlersConfigured) return #err(#not_found);
            if (
                not validIdentifier(protocol) or
                not validIdentifier(request.method)
            ) return #err(#bad_request);
            let ?route = currentRoute(scope, protocol, request.method, #query_) else {
                return #err(#not_found);
            };
            if (request.payload.size() > route.max_request_bytes) {
                return finish(route, "query", #err(#too_large));
            };
            if (not callerAllowed(route.caller, caller)) {
                return finish(route, "query", #err(#unauthorized));
            };
            let resource = resourceId(route.protocol, route.id);
            let ?lease = registry.lease(scope, #public_ingress, resource) else {
                return finish(route, "query", #err(#revoked));
            };
            let key = routeKey(scope, protocol, request.method);
            let ?handler = Map.get(queryHandlers, Text.compare, key) else {
                return finish(route, "query", #err(#handler_failed));
            };
            let response = handler({ caller; payload = request.payload });
            if (not lease.active()) return finish(route, "query", #err(#revoked));
            if (response.size() > route.max_response_bytes) {
                return finish(route, "query", #err(#handler_failed));
            };
            finish(route, "query", #ok(response));
        };

        // Classify only an exact live update route with a registered handler.
        // The caller wrapper uses this before starting app-attributed outer
        // message metering. Self-authenticating ingress pays the IC ingress
        // reception base; canister-paid traffic does not.
        public func updateOrigin(
            scope : Types.AppScope,
            protocol : Text,
            caller : Principal,
            request : Types.RequestV1,
        ) : ?Types.UpdateOrigin {
            if (
                not handlersConfigured or
                not validIdentifier(protocol) or
                not validIdentifier(request.method)
            ) return null;
            let ?route = currentRoute(scope, protocol, request.method, #update_) else {
                return null;
            };
            let key = routeKey(scope, protocol, request.method);
            if (not Map.containsKey(updateHandlers, Text.compare, key)) return null;
            switch (route.caller, route.required_cycles) {
                case (#authenticated, null) {
                    if (Principal.isSelfAuthenticating(caller)) {
                        ?#authenticated_ingress
                    } else null;
                };
                case (#canister, ?amount) {
                    if (amount >= 1) ?#canister_call else null;
                };
                case (_) null;
            };
        };

        public func dispatchUpdate<system>(
            scope : Types.AppScope,
            protocol : Text,
            caller : Principal,
            request : Types.RequestV1,
        ) : async* Types.ResultV1 {
            if (not handlersConfigured) return #err(#not_found);
            if (
                not validIdentifier(protocol) or
                not validIdentifier(request.method)
            ) return #err(#bad_request);
            let ?route = currentRoute(scope, protocol, request.method, #update_) else {
                return #err(#not_found);
            };
            let requiredCycles = switch (
                route.caller,
                route.required_cycles,
            ) {
                case (#authenticated, null) {
                    if (not Principal.isSelfAuthenticating(caller)) {
                        return finish(route, "update", #err(#unauthorized));
                    };
                    0;
                };
                // A positive attachment proves the immediate message was
                // canister-mediated; do not classify the principal separately.
                case (#canister, ?amount) {
                    if (cyclesAvailable() < amount) Runtime.trap(
                        "Public ingress update requires at least " #
                        Nat.toText(amount) # " attached cycles"
                    );
                    amount;
                };
                case (_) Runtime.trap(
                    "Public ingress update cycle policy is unavailable"
                );
            };
            if (requiredCycles > 0) {
                let acceptedCycles = acceptCycles<system>(requiredCycles);
                if (acceptedCycles != requiredCycles) Runtime.trap(
                    "Public ingress update cycle acceptance was incomplete"
                );
                recordIncomingCycles(scope, acceptedCycles);
            };
            if (request.payload.size() > route.max_request_bytes) {
                return finish(route, "update", #err(#too_large));
            };
            let key = routeKey(scope, protocol, request.method);
            let ?handler = Map.get(updateHandlers, Text.compare, key) else {
                return finish(route, "update", #err(#handler_failed));
            };
            let resource = resourceId(route.protocol, route.id);
            let ?lease = registry.lease(scope, #public_ingress, resource) else {
                return finish(route, "update", #err(#revoked));
            };
            let timestamp = effectiveNow();
            reapStalePending(timestamp);
            if (cycleBalance() < MIN_REMAINING_CYCLES) {
                return finish(route, "update", #err(#low_cycles));
            };
            let scopeKey = CapabilityScope.key(scope);
            if (
                mem.pending_count >= MAX_PENDING_GLOBAL or
                count(mem.pending_by_route, key) >= MAX_PENDING_PER_ROUTE or
                count(mem.pending_by_scope, scopeKey) >= MAX_PENDING_PER_APP
            ) return finish(route, "update", #err(#busy));
            if (not consumeRate(route, caller, timestamp)) {
                return finish(route, "update", #err(#rate_limited));
            };
            let additionalCyclesAvailable = switch (route.caller) {
                case (#canister) cyclesAvailable();
                case (_) 0;
            };

            let handlerRequest : Types.HandlerRequestV1 = {
                caller;
                payload = request.payload;
            };
            let dispatchId = allocateDispatchId();
            let pending : Types.PendingDispatch = {
                dispatch_id = dispatchId;
                scope;
                protocol;
                method = request.method;
                request_hash = requestHash(route, handlerRequest);
                route_fingerprint = route.fingerprint;
                authority_epoch = route.authority_epoch;
                accepted_at = timestamp;
                additional_cycles_available = additionalCyclesAvailable;
                additional_cycles_requested = 0;
                state = #waiting;
            };
            Map.add(mem.pending, Nat64.compare, dispatchId, pending);
            Map.add(leases, Nat64.compare, dispatchId, lease);
            addPending(pending);
            let dispatch : Types.DispatchV1 = {
                dispatch_id = dispatchId;
                app_scope = scope;
                protocol;
                method = request.method;
                request = handlerRequest;
                request_hash = pending.request_hash;
                route_fingerprint = route.fingerprint;
                authority_epoch = route.authority_epoch;
            };
            ignore try {
                await handler(dispatch);
            } catch (_) {
                failPending(dispatchId);
                return finish(route, "update", #err(#handler_failed));
            };
            // The app handler has returned from a separate committed message.
            // Check live authority before consulting the persisted completion:
            // a concurrent disable removes that completion as part of pending
            // cleanup, but it must still be reported as a post-dispatch
            // revocation rather than the misleading #handler_failed.
            let current = currentRoute(scope, protocol, request.method, #update_);
            if (
                not lease.active() or
                (switch (current) {
                    case (?value) {
                        value.fingerprint != dispatch.route_fingerprint or
                        value.authority_epoch != dispatch.authority_epoch
                    };
                    case null true;
                })
            ) {
                failPending(dispatchId);
                return finish(route, "update", #err(#revoked_after_dispatch));
            };
            let completed = switch (
                Map.get(mem.pending, Nat64.compare, dispatchId)
            ) {
                case (?pending) {
                    let #completed(response) = pending.state else {
                        failPending(dispatchId);
                        return finish(route, "update", #err(#handler_failed));
                    };
                    if (
                        not CapabilityScope.equal(pending.scope, scope) or
                        pending.protocol != protocol or
                        pending.method != request.method or
                        not Blob.equal(pending.request_hash, dispatch.request_hash) or
                        pending.route_fingerprint != dispatch.route_fingerprint or
                        pending.authority_epoch != dispatch.authority_epoch or
                        pending.additional_cycles_requested >
                            pending.additional_cycles_available or
                        response.size() > route.max_response_bytes
                    ) {
                        failPending(dispatchId);
                        return finish(route, "update", #err(#handler_failed));
                    };
                    (pending, response);
                };
                case null {
                    failPending(dispatchId);
                    return finish(route, "update", #err(#handler_failed));
                };
            };
            let (completedPending, response) = completed;
            let additionalCycles =
                completedPending.additional_cycles_requested;
            if (additionalCycles > 0) {
                if (cyclesAvailable() < additionalCycles) Runtime.trap(
                    "Public ingress additional cycle reservation is unavailable"
                );
                let acceptedAdditional =
                    acceptCycles<system>(additionalCycles);
                if (acceptedAdditional != additionalCycles) Runtime.trap(
                    "Public ingress additional cycle acceptance was incomplete"
                );
                recordIncomingCycles(scope, acceptedAdditional);
            };
            ignore Map.delete(mem.pending, Nat64.compare, dispatchId);
            ignore Map.delete(leases, Nat64.compare, dispatchId);
            finish(route, "update", #ok(response));
        };

        // Called only from the compiler-generated, self-only update switch.
        public func dispatchBegin(
            scope : Types.AppScope,
            protocol : Text,
            method : Text,
            dispatch : Types.DispatchV1,
        ) : () {
            let (_, pending) = validatedHandlerDispatch(
                scope,
                protocol,
                method,
                dispatch,
            );
            assert (pending.additional_cycles_requested == 0);
            // A generated handler never suspends between begin and finish. A
            // prior malformed handler may have returned without finish, so a
            // new trusted self-handler safely supersedes that stale context.
            activeHandlerDispatch := ?{
                dispatch_id = dispatch.dispatch_id;
                scope;
                additional_cycles_available =
                    pending.additional_cycles_available;
                additional_cycles_requested = 0;
            };
        };

        public func dispatchFinish(
            scope : Types.AppScope,
            protocol : Text,
            method : Text,
            dispatch : Types.DispatchV1,
            response : Blob,
        ) : () {
            let (route, pending) = validatedHandlerDispatch(
                scope,
                protocol,
                method,
                dispatch,
            );
            assert (response.size() <= route.max_response_bytes);
            let active = activeCyclesFor(scope);
            assert (
                active.dispatch_id == dispatch.dispatch_id and
                active.additional_cycles_available ==
                    pending.additional_cycles_available and
                active.additional_cycles_requested <=
                    active.additional_cycles_available
            );
            Map.add(mem.pending, Nat64.compare, dispatch.dispatch_id, {
                pending with
                additional_cycles_requested =
                    active.additional_cycles_requested;
                state = #completed(response)
            });
            removePending(pending);
            activeHandlerDispatch := null;
        };

        func validatedHandlerDispatch(
            scope : Types.AppScope,
            protocol : Text,
            method : Text,
            dispatch : Types.DispatchV1,
        ) : (Types.CommittedRoute, Types.PendingDispatch) {
            assert (
                CapabilityScope.equal(scope, dispatch.app_scope) and
                protocol == dispatch.protocol and method == dispatch.method
            );
            let ?route = currentRoute(scope, protocol, method, #update_) else Runtime.trap(
                "Public ingress route is unavailable"
            );
            assert (
                route.fingerprint == dispatch.route_fingerprint and
                route.authority_epoch == dispatch.authority_epoch
            );
            let ?pending = Map.get(
                mem.pending,
                Nat64.compare,
                dispatch.dispatch_id,
            ) else Runtime.trap("Public ingress admission is unavailable");
            let ?lease = Map.get(
                leases,
                Nat64.compare,
                dispatch.dispatch_id,
            ) else Runtime.trap("Public ingress lease is unavailable");
            assert (
                pending.state == #waiting and lease.active() and
                CapabilityScope.equal(pending.scope, scope) and
                pending.protocol == protocol and pending.method == method and
                pending.route_fingerprint == dispatch.route_fingerprint and
                pending.authority_epoch == dispatch.authority_epoch and
                Blob.equal(pending.request_hash, dispatch.request_hash) and
                Blob.equal(
                    dispatch.request_hash,
                    requestHash(route, dispatch.request),
                ) and
                pending.additional_cycles_requested <=
                    pending.additional_cycles_available
            );
            (route, pending);
        };

        func activeCyclesFor(
            scope : Types.AppScope,
        ) : ActiveHandlerDispatch {
            let ?active = activeHandlerDispatch else Runtime.trap(
                "Public ingress cycles are available only during an update handler"
            );
            if (not CapabilityScope.equal(active.scope, scope)) Runtime.trap(
                "Public ingress cycles belong to another app scope"
            );
            assert (
                active.additional_cycles_requested <=
                active.additional_cycles_available
            );
            active;
        };

        func normalizeRoute(
            scope : Types.AppScope,
            authored : Types.RouteDeclaration,
        ) : Types.CommittedRoute {
            assert (
                validIdentifier(authored.protocol) and
                validIdentifier(authored.id) and
                resourceId(authored.protocol, authored.id).size() <= 64 and
                validHandlerName(authored.handler) and
                authored.max_request_bytes >= 1 and
                authored.max_request_bytes <= MAX_REQUEST_BYTES and
                authored.max_response_bytes >= 1 and
                authored.max_response_bytes <= MAX_RESPONSE_BYTES and
                validFingerprint(authored.fingerprint)
            );
            switch (
                authored.mode,
                authored.caller,
                authored.max_calls_per_hour,
                authored.required_cycles,
            ) {
                case (#query_, _, null, null) {};
                case (#update_, #authenticated, ?limit, null) assert (
                    limit >= 1 and
                    limit <= MAX_CALLS_PER_ROUTE_PER_HOUR
                );
                case (#update_, #canister, ?limit, ?requiredCycles) assert (
                    limit >= 1 and
                    limit <= MAX_CALLS_PER_ROUTE_PER_HOUR and
                    requiredCycles >= 1 and
                    requiredCycles <= MAX_REQUIRED_CYCLES
                );
                case (_) Runtime.trap("Invalid public ingress update declaration");
            };
            switch (
                authored.mode,
                authored.max_calls_per_hour,
                authored.max_calls_per_caller_per_hour,
            ) {
                case (#query_, null, null) {};
                case (#update_, ?_, null) {};
                case (#update_, ?routeLimit, ?callerLimit) assert (
                    callerLimit >= 1 and callerLimit <= routeLimit
                );
                case (_) Runtime.trap(
                    "Invalid public ingress caller rate declaration"
                );
            };
            {
                scope;
                protocol = authored.protocol;
                id = authored.id;
                handler = authored.handler;
                mode = authored.mode;
                caller = authored.caller;
                max_request_bytes = authored.max_request_bytes;
                max_response_bytes = authored.max_response_bytes;
                max_calls_per_hour = authored.max_calls_per_hour;
                required_cycles = authored.required_cycles;
                fingerprint = authored.fingerprint;
                authority_epoch = 0;
            };
        };

        func currentRoute(
            scope : Types.AppScope,
            protocol : Text,
            method : Text,
            mode : Types.RouteMode,
        ) : ?Types.CommittedRoute {
            if (
                not scopeActive(scope) or
                not registry.allowed(
                    scope,
                    #public_ingress,
                    resourceId(protocol, method),
                )
            ) return null;
            let key = routeKey(scope, protocol, method);
            let ?target = Map.get(targetRoutes, Text.compare, key) else return null;
            let ?committed = Map.get(mem.routes, Text.compare, key) else return null;
            if (
                target.mode != mode or committed.mode != mode or
                target.fingerprint != committed.fingerprint
            ) return null;
            ?committed;
        };

        func callerAllowed(policy : Types.CallerPolicy, caller : Principal) : Bool {
            switch (policy) {
                case (#any) true;
                case (#authenticated) not Principal.isAnonymous(caller);
                case (#canister) Principal.isCanister(caller);
            };
        };

        func consumeRate(
            route : Types.CommittedRoute,
            caller : Principal,
            timestamp : Nat64,
        ) : Bool {
            let ?routeLimit = route.max_calls_per_hour else return false;
            let key = routeKey(route.scope, route.protocol, route.id);
            let scopeKey = CapabilityScope.key(route.scope);
            let callerLimit = Map.get(targetCallerLimits, Text.compare, key);
            let globalWindowRolled = rateWindowExpired(
                mem.global_rate,
                timestamp,
            );
            let globalRate = refreshedRate(?mem.global_rate, timestamp);
            if (globalWindowRolled) clearCallerRates();
            let callerRateKey = CALLER_RATE_PREFIX # key # "\00" #
                Principal.toText(caller);
            let callerRate = switch (callerLimit) {
                case (?limit) {
                    let current = rateInWindow(
                        Map.get(
                            mem.rates_by_route,
                            Text.compare,
                            callerRateKey,
                        ),
                        globalRate.window_started_at,
                    );
                    if (current.accepted >= limit) return false;
                    ?current;
                };
                case null null;
            };
            let routeRate = refreshedRate(
                Map.get(mem.rates_by_route, Text.compare, key),
                timestamp,
            );
            let scopeRate = refreshedRate(
                Map.get(mem.rates_by_scope, Text.compare, scopeKey),
                timestamp,
            );
            if (
                routeRate.accepted >= routeLimit or
                scopeRate.accepted >= MAX_CALLS_PER_APP_PER_HOUR or
                globalRate.accepted >= MAX_CALLS_GLOBAL_PER_HOUR
            ) return false;
            switch (callerRate) {
                case (?current) {
                    Map.add(mem.rates_by_route, Text.compare, callerRateKey, {
                        current with accepted = current.accepted + 1
                    });
                };
                case null {};
            };
            Map.add(mem.rates_by_route, Text.compare, key, {
                routeRate with accepted = routeRate.accepted + 1
            });
            Map.add(mem.rates_by_scope, Text.compare, scopeKey, {
                scopeRate with accepted = scopeRate.accepted + 1
            });
            mem.global_rate := {
                globalRate with accepted = globalRate.accepted + 1
            };
            true;
        };

        // Caller counters share the kernel-global fixed window. Only admitted
        // calls create entries, so at most MAX_CALLS_GLOBAL_PER_HOUR keys are
        // removed at rollover.
        func clearCallerRates() : () {
            let removals = List.empty<Text>();
            for ((key, _) in Map.entries(mem.rates_by_route)) {
                if (Text.startsWith(key, #text CALLER_RATE_PREFIX)) {
                    List.add(removals, key);
                };
            };
            for (key in List.values(removals)) {
                ignore Map.delete(mem.rates_by_route, Text.compare, key);
            };
        };

        func rateWindowExpired(
            rate : Types.RateCounter,
            timestamp : Nat64,
        ) : Bool {
            timestamp >= rate.window_started_at and
            timestamp - rate.window_started_at >= HOUR_NANOS;
        };

        func rateInWindow(
            rate : ?Types.RateCounter,
            windowStartedAt : Nat64,
        ) : Types.RateCounter {
            switch (rate) {
                case (?value) {
                    if (
                        value.window_started_at == windowStartedAt
                    ) value else ({
                        window_started_at = windowStartedAt;
                        accepted = 0;
                    } : Types.RateCounter);
                };
                case null {
                    { window_started_at = windowStartedAt; accepted = 0 };
                };
            };
        };

        func refreshedRate(
            rate : ?Types.RateCounter,
            timestamp : Nat64,
        ) : Types.RateCounter {
            let current = switch (rate) {
                case (?value) value;
                case null ({ window_started_at = timestamp; accepted = 0 } : Types.RateCounter);
            };
            if (
                timestamp >= current.window_started_at and
                timestamp - current.window_started_at >= HOUR_NANOS
            ) {
                { window_started_at = timestamp; accepted = 0 }
            } else current;
        };

        func allocateDispatchId() : Nat64 {
            var candidate = mem.next_dispatch_id;
            while (Map.containsKey(mem.pending, Nat64.compare, candidate)) {
                candidate := if (candidate == MAX_NAT64) 1 else candidate + 1;
            };
            mem.next_dispatch_id := if (candidate == MAX_NAT64) 1 else candidate + 1;
            candidate;
        };

        func addPending(pending : Types.PendingDispatch) : () {
            mem.pending_count += 1;
            addCount(
                mem.pending_by_route,
                routeKey(pending.scope, pending.protocol, pending.method),
            );
            addCount(mem.pending_by_scope, CapabilityScope.key(pending.scope));
        };

        func removePending(pending : Types.PendingDispatch) : () {
            assert (mem.pending_count > 0);
            mem.pending_count -= 1;
            subtractCount(
                mem.pending_by_route,
                routeKey(pending.scope, pending.protocol, pending.method),
            );
            subtractCount(mem.pending_by_scope, CapabilityScope.key(pending.scope));
        };

        func failPending(dispatchId : Nat64) : () {
            switch (activeHandlerDispatch) {
                case (?active) {
                    if (active.dispatch_id == dispatchId) {
                        activeHandlerDispatch := null;
                    };
                };
                case null {};
            };
            let ?pending = Map.get(mem.pending, Nat64.compare, dispatchId) else return;
            switch (pending.state) {
                case (#waiting) removePending(pending);
                case (#completed(_)) {};
            };
            ignore Map.delete(mem.pending, Nat64.compare, dispatchId);
            ignore Map.delete(leases, Nat64.compare, dispatchId);
        };

        func discardPendingForRoute(key : Text) : () {
            let removals = List.empty<Nat64>();
            for ((dispatchId, pending) in Map.entries(mem.pending)) {
                if (routeKey(pending.scope, pending.protocol, pending.method) == key) {
                    List.add(removals, dispatchId);
                };
            };
            for (dispatchId in List.values(removals)) failPending(dispatchId);
        };

        func reapStalePending(timestamp : Nat64) : () {
            let removals = List.empty<Nat64>();
            for ((dispatchId, pending) in Map.entries(mem.pending)) {
                if (
                    timestamp >= pending.accepted_at and
                    timestamp - pending.accepted_at >= STALE_PENDING_NANOS
                ) List.add(removals, dispatchId);
            };
            for (dispatchId in List.values(removals)) failPending(dispatchId);
        };

        func recoverInterruptedDispatches() : () {
            Map.clear(mem.pending);
            Map.clear(mem.pending_by_route);
            Map.clear(mem.pending_by_scope);
            Map.clear(leases);
            mem.pending_count := 0;
            activeHandlerDispatch := null;
        };

        func count(map : Map.Map<Text, Nat>, key : Text) : Nat {
            switch (Map.get(map, Text.compare, key)) {
                case (?value) value;
                case null 0;
            };
        };

        func addCount(map : Map.Map<Text, Nat>, key : Text) : () {
            Map.add(map, Text.compare, key, count(map, key) + 1);
        };

        func subtractCount(map : Map.Map<Text, Nat>, key : Text) : () {
            let current = count(map, key);
            assert (current > 0);
            if (current == 1) {
                ignore Map.delete(map, Text.compare, key);
            } else {
                Map.add(map, Text.compare, key, current - 1);
            };
        };

        func effectiveNow() : Nat64 {
            let observed = now();
            if (observed > mem.last_seen_at) mem.last_seen_at := observed;
            mem.last_seen_at;
        };

        func finish(
            route : Types.CommittedRoute,
            operation : Text,
            result : Types.ResultV1,
        ) : Types.ResultV1 {
            ignore registry.record(
                route.scope,
                #public_ingress,
                resourceId(route.protocol, route.id),
                operation,
                switch (result) {
                    case (#ok(_)) #ok;
                    case (#err(#rate_limited)) #rate_limited;
                    case (#err(#busy)) #busy;
                    case (#err(#revoked)) #revoked;
                    case (#err(#revoked_after_dispatch)) #revoked;
                    case (#err(#handler_failed)) #failed;
                    case (#err(_)) #denied;
                },
            );
            result;
        };

        func requestHash(
            route : Types.CommittedRoute,
            request : Types.HandlerRequestV1,
        ) : Blob {
            hashFields([
                Text.encodeUtf8("neutron.public-ingress.request.v1"),
                Text.encodeUtf8(CapabilityScope.key(route.scope)),
                Text.encodeUtf8(route.protocol),
                Text.encodeUtf8(route.id),
                Text.encodeUtf8(route.fingerprint),
                Text.encodeUtf8(Principal.toText(request.caller)),
                request.payload,
            ]);
        };

        func hashFields(fields : [Blob]) : Blob {
            let hash = Sha256.Digest(#sha256);
            for (field in fields.vals()) {
                hash.writeBlob(Text.encodeUtf8(Nat.toText(field.size()) # ":"));
                hash.writeBlob(field);
            };
            hash.sum();
        };
    };

    public func resourceId(protocol : Text, method : Text) : Text {
        protocol # ":" # method;
    };

    public func routeKey(
        scope : Types.AppScope,
        protocol : Text,
        method : Text,
    ) : Text {
        CapabilityScope.key(scope) # "\00" # resourceId(protocol, method);
    };

    public func parseResourceId(value : Text) : ?{ protocol : Text; method : Text } {
        if (value.size() < 3 or value.size() > 64) return null;
        let parts = Text.split(value, #char ':');
        let ?protocol = parts.next() else return null;
        let ?method = parts.next() else return null;
        if (parts.next() != null) return null;
        if (not validIdentifier(protocol) or not validIdentifier(method)) return null;
        ?{ protocol; method };
    };

    public func validIdentifier(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 63) return false;
        var first = true;
        for (char in value.chars()) {
            if (first) {
                if (char < 'a' or char > 'z') return false;
                first := false;
            } else if (not (
                (char >= 'a' and char <= 'z') or
                (char >= '0' and char <= '9') or char == '_'
            )) return false;
        };
        true;
    };

    func validHandlerName(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 128) return false;
        var first = true;
        for (char in value.chars()) {
            if (first) {
                if (not (
                    (char >= 'a' and char <= 'z') or
                    (char >= 'A' and char <= 'Z') or char == '_'
                )) return false;
                first := false;
            } else if (not (
                (char >= 'a' and char <= 'z') or
                (char >= 'A' and char <= 'Z') or
                (char >= '0' and char <= '9') or char == '_'
            )) return false;
        };
        true;
    };

    func validFingerprint(value : Text) : Bool {
        if (value.size() != 64) return false;
        for (char in value.chars()) {
            if (not (
                (char >= '0' and char <= '9') or
                (char >= 'a' and char <= 'f')
            )) return false;
        };
        true;
    };
};
