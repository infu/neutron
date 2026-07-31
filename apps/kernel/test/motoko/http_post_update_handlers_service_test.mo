import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Queue "mo:core/Queue";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import CapabilityTypes "../../backend/capabilities/Types";
import Service "../../backend/http_post_update_handlers/Service";
import Types "../../backend/http_post_update_handlers/Types";

persistent actor Harness {
    transient let HOUR_NANOS : Nat64 = 3_600_000_000_000;
    transient let anonymous = Principal.fromText("2vxsx-fae");
    transient let authorized = Principal.fromText(
        "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe"
    );
    transient let scope : Types.AppScope = { app_id = "webhook"; installation_uid = 7 };
    transient let peerScope : Types.AppScope = { app_id = "peerhook"; installation_uid = 11 };
    transient var timestamp : Nat64 = HOUR_NANOS;
    transient var active = true;
    transient var enabled = true;
    transient var calls = 0;
    transient var sharedCalls = 0;
    transient var sharedPath = "unset";
    transient var peerSharedCalls = 0;
    transient var peerSharedPath = "unset";
    transient var measurementsStarted : Nat64 = 0;
    transient var measurementsFinished : Nat64 = 0;
    transient var balance = Service.MIN_REMAINING_CYCLES + 1;

    transient let memory : Types.Memory = {
        mounts = Map.empty<Text, Types.CommittedMount>();
        rates_by_mount = Map.empty<Text, Types.RateCounter>();
        rates_by_scope = Map.empty<Text, Types.RateCounter>();
        var global_rate = { window_started_at = 0; accepted = 0 };
        replays = Map.empty<Blob, Types.Replay>();
        replay_entries_by_scope = Map.empty<Text, Nat>();
        replay_reserved_bytes_by_scope = Map.empty<Text, Nat>();
        pending_by_mount = Map.empty<Text, Nat>();
        pending_by_scope = Map.empty<Text, Nat>();
        replay_order = Queue.empty<Blob>();
        var replay_reserved_bytes = 0;
        var pending = 0;
        var last_seen_at = 0;
    };

    transient let registry : CapabilityTypes.RuntimeRegistry = {
        allowed = func(
            candidate : CapabilityTypes.AppScope,
            kind : CapabilityTypes.CapabilityKind,
            resource : Text,
        ) : Bool {
            active and enabled and (candidate == scope or candidate == peerScope) and
            kind == #http_routes and
            (resource == "receive" or resource == "shared");
        };
        lease = func(
            candidate : CapabilityTypes.AppScope,
            kind : CapabilityTypes.CapabilityKind,
            resource : Text,
        ) : ?CapabilityTypes.RuntimeLease {
            if (not (
                active and enabled and (candidate == scope or candidate == peerScope) and
                kind == #http_routes and
                (resource == "receive" or resource == "shared")
            )) return null;
            ?{ active = func() { active and enabled } };
        };
        record = func(
            _scope : CapabilityTypes.AppScope,
            _kind : CapabilityTypes.CapabilityKind,
            _resource : Text,
            _operation : Text,
            _outcome : CapabilityTypes.CapabilityOutcome,
        ) : Bool { true };
    };

    transient let service = Service.Service(
        memory,
        "aaaaa-aa",
        func(candidate) { active and (candidate == scope or candidate == peerScope) },
        func() { true },
        func(candidate) { candidate == authorized },
        func(_scope) {
            measurementsStarted += 1;
            measurementsStarted;
        },
        func(_scope, _startedAt) { measurementsFinished += 1 },
        registry,
        func() { balance },
        func() { timestamp },
    );

    public shared func handle(
        dispatch : Types.DispatchV1,
    ) : async Types.HandlerResponseV1 {
        service.dispatchBegin(scope, "receive", dispatch);
        calls += 1;
        let response : Types.HandlerResponseV1 = {
            status = #created;
            content_type = "application/json";
            body = Text.encodeUtf8("{\"ok\":true}");
        };
        service.dispatchFinish(scope, "receive", dispatch, response);
        response;
    };

    public shared func handleShared(
        dispatch : Types.DispatchV1,
    ) : async Types.HandlerResponseV1 {
        service.dispatchBegin(scope, "shared", dispatch);
        sharedCalls += 1;
        sharedPath := dispatch.request.path;
        let response : Types.HandlerResponseV1 = {
            status = #accepted;
            content_type = "application/json";
            body = Text.encodeUtf8("{\"shared\":true}");
        };
        service.dispatchFinish(scope, "shared", dispatch, response);
        response;
    };

    public shared func handlePeerShared(
        dispatch : Types.DispatchV1,
    ) : async Types.HandlerResponseV1 {
        service.dispatchBegin(peerScope, "shared", dispatch);
        peerSharedCalls += 1;
        peerSharedPath := dispatch.request.path;
        let response : Types.HandlerResponseV1 = {
            status = #ok;
            content_type = "application/json";
            body = Text.encodeUtf8("");
        };
        service.dispatchFinish(peerScope, "shared", dispatch, response);
        response;
    };

    func declaration() : Types.AppDeclaration {
        {
            app_scope = scope;
            http_routes = ?{
                api = 1;
                mounts = [
                    {
                        id = "receive";
                        surface = "app_host";
                        prefix = ?"/hooks";
                        methods = ["POST"];
                        mode = "http_post_update_handler";
                        max_request_bytes = 32;
                        max_response_bytes = 64;
                        handler = ?"_ReceiveHook";
                        max_calls_per_hour = ?2;
                        forward_headers = ["content-type", "x-signature"];
                    },
                    {
                        id = "shared";
                        surface = "shared_app_path";
                        prefix = null;
                        methods = ["POST"];
                        mode = "http_post_update_handler";
                        max_request_bytes = 32;
                        max_response_bytes = 64;
                        handler = ?"_SharedHook";
                        max_calls_per_hour = ?2;
                        forward_headers = ["content-type", "x-signature"];
                    },
                ];
            };
        };
    };

    func acceptedTotal(counters : Map.Map<Text, Types.RateCounter>) : Nat {
        var total = 0;
        for ((_, counter) in Map.entries(counters)) total += counter.accepted;
        total;
    };

    func changedDeclaration() : Types.AppDeclaration {
        let current = declaration();
        {
            app_scope = current.app_scope;
            http_routes = ?{
                api = 1;
                mounts = [
                    {
                        id = "receive";
                        surface = "app_host";
                        prefix = ?"/hooks";
                        methods = ["POST"];
                        mode = "http_post_update_handler";
                        max_request_bytes = 32;
                        max_response_bytes = 64;
                        handler = ?"_ReceiveHook";
                        max_calls_per_hour = ?2;
                        forward_headers = ["content-type", "x-signature"];
                    },
                    {
                        id = "shared";
                        surface = "app_host";
                        prefix = ?"/shared-hook";
                        methods = ["POST"];
                        mode = "http_post_update_handler";
                        max_request_bytes = 32;
                        max_response_bytes = 64;
                        handler = ?"_SharedHook";
                        max_calls_per_hour = ?2;
                        forward_headers = ["content-type", "x-signature"];
                    },
                ];
            };
        };
    };

    func peerDeclaration() : Types.AppDeclaration {
        {
            app_scope = peerScope;
            http_routes = ?{
                api = 1;
                mounts = [{
                    id = "shared";
                    surface = "shared_app_path";
                    prefix = null;
                    methods = ["POST"];
                    mode = "http_post_update_handler";
                    max_request_bytes = 32;
                    max_response_bytes = 64;
                    handler = ?"_PeerSharedHook";
                    max_calls_per_hour = ?2;
                    forward_headers = ["content-type", "x-signature"];
                }];
            };
        };
    };

    func headers(key : Text) : [(Text, Text)] {
        [
            ("Host", "awebhooka--aaaaa-aa.icp0.io"),
            ("Idempotency-Key", key),
            ("Content-Type", "application/json"),
            ("X-Signature", "signed"),
        ];
    };

    func sharedHeaders(key : Text) : [(Text, Text)] {
        [
            ("Host", "aaaaa-aa.icp0.io"),
            ("Idempotency-Key", key),
            ("Content-Type", "application/json"),
            ("X-Signature", "signed"),
        ];
    };

    func expectOk(result : Types.Result) : Types.HandlerResponseV1 {
        switch (result) {
            case (#ok(response)) response;
            case (#err(_)) Runtime.trap("Expected HTTP POST update-handler success");
        };
    };

    func expectError(result : Types.Result, expected : Types.Error) : () {
        switch (result) {
            case (#err(actual)) assert (actual == expected);
            case (#ok(_)) Runtime.trap("Expected HTTP POST update-handler error");
        };
    };

    public shared func run() : async () {
        service.configure([declaration(), peerDeclaration()]);
        service.configureHandlers([{
            app_scope = scope;
            mount_id = "receive";
            handler = handle;
        }, {
            app_scope = scope;
            mount_id = "shared";
            handler = handleShared;
        }, {
            app_scope = peerScope;
            mount_id = "shared";
            handler = handlePeerShared;
        }]);
        service.commitConfiguration();

        let authority = "awebhooka--aaaaa-aa.icp0.io";
        let body = Text.encodeUtf8("{}");
        assert (service.canUpgrade(authority, "/hooks", "POST", headers("abcdefghijklmnop"), body));
        assert (not service.canUpgrade(
            "Awebhooka--aaaaa-aa.icp0.io",
            "/hooks",
            "POST",
            headers("abcdefghijklmnop"),
            body,
        ));
        assert (not service.canUpgrade(authority, "/hooks?x=1", "POST", headers("abcdefghijklmnop"), body));
        // Once an exact live mount owns the path, malformed route input must
        // reach the update method so its 4xx response is not an uncertified
        // query response rejected by a response-verifying gateway.
        assert (service.canUpgrade(authority, "/hooks", "POST", [("Host", authority)], body));
        assert (service.canUpgrade(authority, "/hooks", "POST", headers("short"), body));
        assert (service.canUpgrade(
            authority,
            "/hooks",
            "POST",
            headers("abcdefghijklmnop"),
            Text.encodeUtf8("123456789012345678901234567890123"),
        ));
        assert (service.canUpgrade(
            authority,
            "/hooks",
            "POST",
            [
                ("Idempotency-Key", "abcdefghijklmnop"),
                ("Cookie", "session=secret"),
            ],
            body,
        ));
        assert (service.canUpgrade(
            authority,
            "/hooks",
            "POST",
            [
                ("Idempotency-Key", "abcdefghijklmnop"),
                ("X-Signature", "one"),
                ("x-signature", "two"),
            ],
            body,
        ));
        assert (service.canUpgrade(
            authority,
            "/hooks",
            "POST",
            [
                ("Idempotency-Key", "abcdefghijklmnop"),
                ("Content-Encoding", "identity"),
                ("content-encoding", "identity"),
            ],
            body,
        ));
        expectError(
            await* service.dispatch(anonymous,
                authority,
                "/hooks",
                "POST",
                [("Host", authority)],
                body,
            ),
            #bad_request,
        );
        expectError(
            await* service.dispatch(anonymous,
                authority,
                "/hooks",
                "POST",
                headers("abcdefghijklmnop"),
                Text.encodeUtf8("123456789012345678901234567890123"),
            ),
            #too_large,
        );

        let first = expectOk(await* service.dispatch(anonymous,
            authority,
            "/hooks",
            "POST",
            headers("abcdefghijklmnop"),
            body,
        ));
        assert (first.status == #created and calls == 1);

        // An exact gateway retry is served from the stable one-hour cache and
        // cannot run the mutating handler a second time.
        let replay = expectOk(await* service.dispatch(anonymous,
            authority,
            "/hooks",
            "POST",
            headers("abcdefghijklmnop"),
            body,
        ));
        assert (replay.body == first.body and calls == 1);
        expectError(
            await* service.dispatch(anonymous,
                authority,
                "/hooks/other",
                "POST",
                headers("abcdefghijklmnop"),
                body,
            ),
            #conflict,
        );

        // Runtime disable denies even cached delivery. Re-enable changes the
        // authority epoch, but a completed exact request remains replayable.
        enabled := false;
        service.setMountEnabled(scope, "receive");
        assert (not service.canUpgrade(authority, "/hooks", "POST", headers("abcdefghijklmnop"), body));
        enabled := true;
        service.setMountEnabled(scope, "receive");
        ignore expectOk(await* service.dispatch(anonymous,
            authority,
            "/hooks",
            "POST",
            headers("abcdefghijklmnop"),
            body,
        ));
        assert (calls == 1);

        ignore expectOk(await* service.dispatch(anonymous,
            authority,
            "/hooks",
            "POST",
            headers("qrstuvwxyzabcdef"),
            body,
        ));
        assert (calls == 2);
        expectError(
            await* service.dispatch(anonymous,
                authority,
                "/hooks",
                "POST",
                headers("ghijklmnopqrstuv"),
                body,
            ),
            #rate_limited,
        );
        let acceptedBeforeAuthorized = (
            acceptedTotal(memory.rates_by_mount),
            acceptedTotal(memory.rates_by_scope),
            memory.global_rate.accepted,
        );
        ignore expectOk(await* service.dispatch(
            authorized,
            authority,
            "/hooks",
            "POST",
            headers("hijklmnopqrstuvw"),
            body,
        ));
        assert (
            calls == 3 and
            (
                acceptedTotal(memory.rates_by_mount),
                acceptedTotal(memory.rates_by_scope),
                memory.global_rate.accepted,
            ) == acceptedBeforeAuthorized
        );

        // Expiry removes the cached response and permits the same client key
        // to represent a new one-hour idempotency promise.
        timestamp += HOUR_NANOS;
        ignore expectOk(await* service.dispatch(anonymous,
            authority,
            "/hooks",
            "POST",
            headers("abcdefghijklmnop"),
            body,
        ));
        assert (calls == 4);

        balance := Service.MIN_REMAINING_CYCLES - 1;
        expectError(
            await* service.dispatch(anonymous,
                authority,
                "/hooks",
                "POST",
                headers("wxyzabcdefghijkl"),
                body,
            ),
            #low_cycles,
        );
        assert (calls == 4);

        // The shared surface derives the app and mount path and accepts only
        // the exact ordinary Neutron authority. Handler-visible paths remain
        // relative, and replay is identical to app-host POST handling.
        balance := Service.MIN_REMAINING_CYCLES + 1;
        timestamp += HOUR_NANOS;
        let sharedAuthority = "aaaaa-aa.icp0.io";
        let sharedUrl = "/app/webhook/_route/shared/item";
        let sharedKey = "sharedabcdefghijkl";
        assert (service.canUpgrade(
            sharedAuthority,
            sharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        assert (not service.canUpgrade(
            authority,
            sharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        assert (not service.canUpgrade(
            "aaaaa-aa.raw.icp0.io",
            sharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        assert (not service.canUpgrade(
            sharedAuthority,
            "/app/unknown/_route/shared/item",
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        let sharedFirst = expectOk(await* service.dispatch(anonymous,
            sharedAuthority,
            sharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        assert (
            sharedFirst.status == #accepted and
            sharedCalls == 1 and sharedPath == "/item"
        );
        ignore expectOk(await* service.dispatch(anonymous,
            sharedAuthority,
            sharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        assert (sharedCalls == 1);

        // Shared mount ids are scoped by installation, not globally. A second
        // app may choose the same id, and even the same client key, without
        // selecting the first app's handler or replay state.
        let peerSharedUrl = "/app/peerhook/_route/shared/peer-item";
        assert (service.canUpgrade(
            sharedAuthority,
            peerSharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        let peerSharedFirst = expectOk(await* service.dispatch(anonymous,
            sharedAuthority,
            peerSharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        assert (
            peerSharedFirst.status == #ok and
            peerSharedCalls == 1 and peerSharedPath == "/peer-item" and
            sharedCalls == 1 and sharedPath == "/item"
        );
        ignore expectOk(await* service.dispatch(anonymous,
            sharedAuthority,
            sharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        ignore expectOk(await* service.dispatch(anonymous,
            sharedAuthority,
            peerSharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        assert (sharedCalls == 1 and peerSharedCalls == 1);

        // A surface change is incompatible. The old shared URL disappears,
        // and its retained one-hour key conflicts at the new authority rather
        // than executing the handler twice.
        let changed = Service.Service(
            memory,
            "aaaaa-aa",
            func(candidate) { active and candidate == scope },
            func() { true },
            func(candidate) { candidate == authorized },
            func(_scope) {
                measurementsStarted += 1;
                measurementsStarted;
            },
            func(_scope, _startedAt) { measurementsFinished += 1 },
            registry,
            func() { balance },
            func() { timestamp },
        );
        changed.configure([changedDeclaration()]);
        changed.configureHandlers([{
            app_scope = scope;
            mount_id = "receive";
            handler = handle;
        }, {
            app_scope = scope;
            mount_id = "shared";
            handler = handleShared;
        }]);
        changed.commitConfiguration();
        assert (not changed.canUpgrade(
            sharedAuthority,
            sharedUrl,
            "POST",
            sharedHeaders(sharedKey),
            body,
        ));
        expectError(
            await* changed.dispatch(anonymous,
                authority,
                "/shared-hook/item",
                "POST",
                headers(sharedKey),
                body,
            ),
            #conflict,
        );
        assert (sharedCalls == 1);

        // A fresh actor for an uninstalled AppScope purges its bounded replay
        // and rate state instead of leaking it to a later installation UID.
        active := false;
        let removed = Service.Service(
            memory,
            "aaaaa-aa",
            func(_candidate) { false },
            func() { true },
            func(candidate) { candidate == authorized },
            func(_scope) {
                measurementsStarted += 1;
                measurementsStarted;
            },
            func(_scope, _startedAt) { measurementsFinished += 1 },
            registry,
            func() { balance },
            func() { timestamp },
        );
        removed.configure([{ app_scope = scope; http_routes = null }]);
        removed.configureHandlers([]);
        removed.commitConfiguration();
        assert (Map.size(memory.replays) == 0);
        assert (Map.size(memory.rates_by_scope) == 0);
        assert (
            measurementsStarted > 0 and
            measurementsStarted == measurementsFinished
        );

    };
};

await Harness.run();
