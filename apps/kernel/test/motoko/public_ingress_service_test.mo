import Map "mo:core/Map";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import CapabilityTypes "../../backend/capabilities/Types";
import Service "../../backend/public_ingress/Service";
import Types "../../backend/public_ingress/Types";

persistent actor Harness {
    transient let scope : Types.AppScope = {
        app_id = "receiver";
        installation_uid = 7;
    };
    transient let peerScope : Types.AppScope = {
        app_id = "intruder";
        installation_uid = 8;
    };
    transient let anonymous = Principal.fromText("2vxsx-fae");
    transient let user = Principal.fromText(
        "6rgy7-3uukz-jrj2k-crt3v-u2wjm-dmn3t-p26d6-ndilt-3gusv-75ybk-jae"
    );
    transient let otherUser = Principal.fromText(
        "ejuqt-oe46g-x3us6-exoo7-j76pv-c6po4-bu4ue-4bng2-km2gx-ftclv-iae"
    );
    transient let canister = Principal.fromBlob(Blob.fromArray([0 : Nat8, 0, 1, 1]));
    transient let fingerprint =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    transient let requiredCycles : Nat = 2_000_000_000;
    transient let additionalCycles : Nat = 1_000;
    transient var enabled = true;
    transient var active = true;
    transient var timestamp : Nat64 = 3_600_000_000_000;
    transient var balance = Service.MIN_REMAINING_CYCLES + 1;
    transient var availableCycles = requiredCycles;
    transient var acceptedCycles = 0;
    transient var acceptedCalls = 0;
    transient var recordedIncomingCycles = 0;
    transient var recordedIncomingCalls = 0;
    transient var requestedAdditionalCycles : [Nat] = [];
    transient var observedAdditionalBefore = 0;
    transient var observedAdditionalAfter = 0;
    transient var updateCalls = 0;
    transient var skipFinish = false;
    transient var revokeAfterFinish = false;
    transient var records = 0;
    transient let memory = Service.init();

    func acceptAttachedCycles<system>(amount : Nat) : Nat {
        let accepted = if (amount <= availableCycles) amount else availableCycles;
        availableCycles -= accepted;
        acceptedCycles += accepted;
        acceptedCalls += 1;
        accepted;
    };

    func recordIncomingCycles(candidate : Types.AppScope, amount : Nat) : () {
        assert (candidate == scope);
        recordedIncomingCycles += amount;
        recordedIncomingCalls += 1;
    };

    transient let registry : CapabilityTypes.RuntimeRegistry = {
        allowed = func(
            candidate : CapabilityTypes.AppScope,
            kind : CapabilityTypes.CapabilityKind,
            resource : Text,
        ) : Bool {
            active and enabled and candidate == scope and
            kind == #public_ingress and Text.startsWith(resource, #text "rpc:");
        };
        lease = func(
            candidate : CapabilityTypes.AppScope,
            kind : CapabilityTypes.CapabilityKind,
            resource : Text,
        ) : ?CapabilityTypes.RuntimeLease {
            if (not (
                active and enabled and candidate == scope and
                kind == #public_ingress and Text.startsWith(resource, #text "rpc:")
            )) return null;
            ?{ active = func() { active and enabled } };
        };
        record = func(
            _scope : CapabilityTypes.AppScope,
            _kind : CapabilityTypes.CapabilityKind,
            _resource : Text,
            _operation : Text,
            _outcome : CapabilityTypes.CapabilityOutcome,
        ) : Bool {
            records += 1;
            true;
        };
    };

    transient let service = Service.Service(
        memory,
        func(candidate) { active and candidate == scope },
        func() { true },
        registry,
        func() { balance },
        func() { availableCycles },
        acceptAttachedCycles,
        recordIncomingCycles,
        func() { timestamp },
    );
    transient let incomingCycles = service.cyclesCapability(scope);

    func queryHandler(request : Types.HandlerRequestV1) : Blob {
        request.payload;
    };

    public shared func updateHandler(dispatch : Types.DispatchV1) : async Blob {
        service.dispatchBegin(
            dispatch.app_scope,
            dispatch.protocol,
            dispatch.method,
            dispatch,
        );
        let response = Text.encodeUtf8("stored");
        observedAdditionalBefore := incomingCycles.available();
        for (amount in requestedAdditionalCycles.vals()) {
            incomingCycles.request(amount);
        };
        observedAdditionalAfter := incomingCycles.available();
        if (skipFinish) return response;
        updateCalls += 1;
        service.dispatchFinish(
            dispatch.app_scope,
            dispatch.protocol,
            dispatch.method,
            dispatch,
            response,
        );
        if (revokeAfterFinish) {
            // Exercise the real kernel toggle path, which bumps the broker
            // epoch and removes this completed pending record before the outer
            // callback resumes.
            enabled := false;
            service.setRouteEnabled(scope, "rpc:write");
        };
        response;
    };

    func route(
        id : Text,
        mode : Types.RouteMode,
        caller : Types.CallerPolicy,
        rate : ?Nat,
        callerRate : ?Nat,
    ) : Types.RouteDeclaration {
        {
            protocol = "rpc";
            id;
            handler = "route_" # id;
            mode;
            caller;
            max_request_bytes = 8;
            max_response_bytes = 16;
            max_calls_per_hour = rate;
            max_calls_per_caller_per_hour = callerRate;
            required_cycles = switch (mode, caller) {
                case (#query_, _) null;
                case (#update_, #authenticated) null;
                case (#update_, #canister) ?requiredCycles;
                case (#update_, #any) null;
            };
            fingerprint;
        };
    };

    func queryRoute(protocol : Text, id : Text) : Types.RouteDeclaration {
        {
            protocol;
            id;
            handler = "route_" # id;
            mode = #query_;
            caller = #any;
            max_request_bytes = 8;
            max_response_bytes = 16;
            max_calls_per_hour = null;
            max_calls_per_caller_per_hour = null;
            required_cycles = null;
            fingerprint;
        };
    };

    func declaration() : Types.AppDeclaration {
        {
            app_scope = scope;
            public_ingress = ?{
                routes = [
                    route("direct", #update_, #authenticated, ?10, null),
                    route("fair", #update_, #authenticated, ?3, ?2),
                    route("open", #query_, #any, null, null),
                    route("secure", #query_, #authenticated, null, null),
                    route("service", #query_, #canister, null, null),
                    route("write", #update_, #canister, ?3, null),
                ];
            };
        };
    };

    func queryRegistration(method : Text) : Types.HandlerRegistrationV1 {
        {
            app_scope = scope;
            protocol = "rpc";
            method;
            handler = #query_(queryHandler);
        };
    };

    func expectOk(result : Types.ResultV1, expected : Text) : () {
        switch (result) {
            case (#ok(response)) assert (response == Text.encodeUtf8(expected));
            case (#err(error)) Runtime.trap(
                "Expected " # expected # ", got " # debug_show (error)
            );
        };
    };

    func expectError(result : Types.ResultV1, expected : Types.ErrorV1) : () {
        switch (result) {
            case (#err(actual)) {
                if (actual != expected) Runtime.trap(
                    "Expected " # debug_show (expected) # ", got " # debug_show (actual)
                );
            };
            case (#ok(_)) Runtime.trap("Expected public ingress error");
        };
    };

    public shared func run() : async () {
        assert (Principal.isSelfAuthenticating(user));
        assert (not Principal.isSelfAuthenticating(anonymous));
        assert (not Principal.isSelfAuthenticating(canister));
        let prefixOrdered = Service.Service(
            Service.init(),
            func(candidate) { active and candidate == scope },
            func() { true },
            registry,
            func() { balance },
            func() { availableCycles },
            acceptAttachedCycles,
            recordIncomingCycles,
            func() { timestamp },
        );
        prefixOrdered.configure([{
            app_scope = scope;
            public_ingress = ?{
                // Compiler canonical tuple order differs from concatenated
                // "protocol:id" order when one protocol prefixes another.
                routes = [
                    queryRoute("a", "x"),
                    queryRoute("a0", "x"),
                ];
            };
        }]);
        service.configure([declaration()]);
        service.configureHandlers([
            queryRegistration("open"),
            queryRegistration("secure"),
            queryRegistration("service"),
            {
                app_scope = scope;
                protocol = "rpc";
                method = "direct";
                handler = #update_(updateHandler);
            },
            {
                app_scope = scope;
                protocol = "rpc";
                method = "fair";
                handler = #update_(updateHandler);
            },
            {
                app_scope = scope;
                protocol = "rpc";
                method = "write";
                handler = #update_(updateHandler);
            },
        ]);
        service.commitConfiguration();
        assert (Map.size(memory.routes) == 6);

        expectOk(service.dispatchQuery(
            scope,
            "rpc",
            anonymous,
            { method = "open"; payload = Text.encodeUtf8("hello") },
        ), "hello");
        expectError(service.dispatchQuery(
            scope,
            "rpc",
            anonymous,
            { method = "secure"; payload = Text.encodeUtf8("") },
        ), #unauthorized);
        expectOk(service.dispatchQuery(
            scope,
            "rpc",
            user,
            { method = "secure"; payload = Text.encodeUtf8("user") },
        ), "user");
        expectError(service.dispatchQuery(
            scope,
            "rpc",
            user,
            { method = "service"; payload = Text.encodeUtf8("") },
        ), #unauthorized);
        expectOk(service.dispatchQuery(
            scope,
            "rpc",
            canister,
            { method = "service"; payload = Text.encodeUtf8("peer") },
        ), "peer");
        expectError(service.dispatchQuery(
            peerScope,
            "rpc",
            canister,
            { method = "open"; payload = Text.encodeUtf8("") },
        ), #not_found);
        expectError(service.dispatchQuery(
            scope,
            "rpc",
            canister,
            { method = "open"; payload = Text.encodeUtf8("123456789") },
        ), #too_large);

        // One caller cannot monopolize the shared route budget. Its rejected
        // third call does not consume shared capacity, so another caller can
        // still take the route's final slot.
        expectOk(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            user,
            { method = "fair"; payload = Text.encodeUtf8("one") },
        ), "stored");
        expectOk(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            user,
            { method = "fair"; payload = Text.encodeUtf8("two") },
        ), "stored");
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            user,
            { method = "fair"; payload = Text.encodeUtf8("three") },
        ), #rate_limited);
        expectOk(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            otherUser,
            { method = "fair"; payload = Text.encodeUtf8("other") },
        ), "stored");
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            otherUser,
            { method = "fair"; payload = Text.encodeUtf8("full") },
        ), #rate_limited);
        assert (Map.size(memory.rates_by_route) == 3);

        // The fixed global caller window bounds cleanup to the prior window's
        // admitted callers and leaves only the new window's live counter.
        timestamp += 3_600_000_000_000;
        expectOk(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            user,
            { method = "fair"; payload = Text.encodeUtf8("reset") },
        ), "stored");
        assert (Map.size(memory.rates_by_route) == 2);

        requestedAdditionalCycles := [];
        availableCycles := additionalCycles;
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            anonymous,
            { method = "direct"; payload = Text.encodeUtf8("direct") },
        ), #unauthorized);
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            canister,
            { method = "direct"; payload = Text.encodeUtf8("direct") },
        ), #unauthorized);
        expectOk(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            user,
            { method = "direct"; payload = Text.encodeUtf8("direct") },
        ), "stored");
        assert (
            acceptedCalls == 0 and recordedIncomingCalls == 0 and
            observedAdditionalBefore == 0 and observedAdditionalAfter == 0 and
            availableCycles == additionalCycles
        );
        assert (
            service.updateOrigin(
                scope,
                "rpc",
                user,
                { method = "direct"; payload = Text.encodeUtf8("") },
            ) == ?#authenticated_ingress
        );
        assert (
            service.updateOrigin(
                scope,
                "rpc",
                anonymous,
                { method = "direct"; payload = Text.encodeUtf8("") },
            ) == null
        );
        assert (
            service.updateOrigin(
                scope,
                "rpc",
                canister,
                { method = "direct"; payload = Text.encodeUtf8("") },
            ) == null
        );
        // Paid routes deliberately use attached cycles rather than principal
        // classification, so a self-authenticating caller is still admitted.
        assert (
            service.updateOrigin(
                scope,
                "rpc",
                user,
                { method = "write"; payload = Text.encodeUtf8("") },
            ) == ?#canister_call
        );

        // A funded request retains and attributes its declared base as soon as
        // the exact paid route is resolved, even when later admission rejects
        // its payload.
        availableCycles := requiredCycles + additionalCycles;
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            canister,
            { method = "write"; payload = Text.encodeUtf8("123456789") },
        ), #too_large);
        assert (
            acceptedCycles == requiredCycles and acceptedCalls == 1 and
            recordedIncomingCycles == requiredCycles and
            recordedIncomingCalls == 1 and
            availableCycles == additionalCycles
        );

        availableCycles := requiredCycles + additionalCycles;
        balance := Service.MIN_REMAINING_CYCLES - 1;
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            canister,
            { method = "write"; payload = Text.encodeUtf8("zero") },
        ), #low_cycles);
        assert (
            acceptedCycles == requiredCycles * 2 and acceptedCalls == 2 and
            recordedIncomingCycles == requiredCycles * 2 and
            recordedIncomingCalls == 2 and
            availableCycles == additionalCycles
        );
        balance := Service.MIN_REMAINING_CYCLES + 1;

        // With no app reservation, only the declared base is retained. The
        // full unaccepted remainder is visible synchronously to the handler.
        requestedAdditionalCycles := [];
        availableCycles := requiredCycles + additionalCycles;
        expectOk(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            user,
            { method = "write"; payload = Text.encodeUtf8("no_extra") },
        ), "stored");
        assert (
            acceptedCycles == requiredCycles * 3 and acceptedCalls == 3 and
            recordedIncomingCycles == requiredCycles * 3 and
            recordedIncomingCalls == 3 and
            observedAdditionalBefore == additionalCycles and
            observedAdditionalAfter == additionalCycles and
            availableCycles == additionalCycles
        );

        // Multiple reservations accumulate, reduce available(), and are
        // accepted once by the outer continuation after handler validation.
        requestedAdditionalCycles := [200, 300];
        availableCycles := requiredCycles + additionalCycles;
        expectOk(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            canister,
            { method = "write"; payload = Text.encodeUtf8("partial") },
        ), "stored");
        assert (
            acceptedCycles == requiredCycles * 4 + 500 and
            acceptedCalls == 5 and
            recordedIncomingCycles == requiredCycles * 4 + 500 and
            recordedIncomingCalls == 5 and
            observedAdditionalBefore == additionalCycles and
            observedAdditionalAfter == 500 and
            availableCycles == 500
        );

        // A handler failure retains the base committed by the outer message,
        // but never accepts any additional attached cycles.
        requestedAdditionalCycles := [];
        skipFinish := true;
        availableCycles := requiredCycles + additionalCycles;
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            canister,
            { method = "write"; payload = Text.encodeUtf8("failed") },
        ), #handler_failed);
        skipFinish := false;
        assert (
            acceptedCycles == requiredCycles * 5 + 500 and
            acceptedCalls == 6 and
            recordedIncomingCycles == requiredCycles * 5 + 500 and
            recordedIncomingCalls == 6 and
            updateCalls == 7 and
            availableCycles == additionalCycles
        );

        requestedAdditionalCycles := [];
        availableCycles := requiredCycles + additionalCycles;
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            canister,
            { method = "write"; payload = Text.encodeUtf8("limited") },
        ), #rate_limited);
        // Every paid protocol update shares the same rate budget; there is no
        // authorized-user bypass.
        availableCycles := requiredCycles + additionalCycles;
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            user,
            { method = "write"; payload = Text.encodeUtf8("owner") },
        ), #rate_limited);
        assert (
            acceptedCycles == requiredCycles * 7 + 500 and
            acceptedCalls == 8 and
            recordedIncomingCycles == requiredCycles * 7 + 500 and
            recordedIncomingCalls == 8
        );
        assert (memory.pending_count == 0 and Map.size(memory.pending) == 0);

        // The app mutation and dispatch completion have committed by this
        // point. A live-authority loss before the outer continuation resumes
        // must not be reported as an ordinary pre-dispatch revocation, and its
        // requested extra must not be accepted after authority is lost.
        timestamp += 3_600_000_000_000;
        revokeAfterFinish := true;
        requestedAdditionalCycles := [400];
        availableCycles := requiredCycles + additionalCycles;
        expectError(await* service.dispatchUpdate<system>(
            scope,
            "rpc",
            canister,
            { method = "write"; payload = Text.encodeUtf8("commit") },
        ), #revoked_after_dispatch);
        assert (updateCalls == 8);
        assert (
            acceptedCycles == requiredCycles * 8 + 500 and
            acceptedCalls == 9 and
            recordedIncomingCycles == requiredCycles * 8 + 500 and
            recordedIncomingCalls == 9 and
            availableCycles == additionalCycles
        );
        assert (memory.pending_count == 0 and Map.size(memory.pending) == 0);

        service.setRouteEnabled(scope, "rpc:open");
        expectError(service.dispatchQuery(
            scope,
            "rpc",
            anonymous,
            { method = "open"; payload = Text.encodeUtf8("") },
        ), #not_found);
        assert (records == 23);

        active := false;
        let removed = Service.Service(
            memory,
            func(_candidate) { true },
            func() { true },
            registry,
            func() { balance },
            func() { availableCycles },
            acceptAttachedCycles,
            recordIncomingCycles,
            func() { timestamp },
        );
        removed.configure([]);
        removed.commitConfiguration();
        assert (Map.size(memory.routes) == 0);
        assert (Map.size(memory.rates_by_route) == 0);
        assert (Map.size(memory.rates_by_scope) == 0);
    };
};

await Harness.run();
