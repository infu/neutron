import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Queue "mo:core/Queue";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import CapabilityScope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import GatewayAuthority "../http_routes/GatewayAuthority";
import RouteNamespace "../http_routes/Namespace";
import Types "Types";

module {
    public let MAX_MOUNTS_PER_APP : Nat = 16;
    public let MAX_REQUEST_BYTES : Nat = 65_536;
    public let MAX_RESPONSE_BYTES : Nat = 65_536;
    public let MAX_CALLS_PER_MOUNT_PER_HOUR : Nat = 240;
    public let MAX_CALLS_PER_APP_PER_HOUR : Nat = 240;
    public let MAX_CALLS_GLOBAL_PER_HOUR : Nat = 1_024;
    public let MAX_REPLAY_ENTRIES_PER_APP : Nat = 240;
    public let MAX_REPLAY_ENTRIES_GLOBAL : Nat = 1_024;
    public let MAX_REPLAY_BYTES_PER_APP : Nat = 8_388_608;
    public let MAX_REPLAY_BYTES_GLOBAL : Nat = 67_108_864;
    public let MAX_PENDING_PER_MOUNT : Nat = 1;
    public let MAX_PENDING_PER_APP : Nat = 2;
    public let MAX_PENDING_GLOBAL : Nat = 8;
    public let MIN_REMAINING_CYCLES : Nat = 250_000_000_000;

    let HOUR_NANOS : Nat64 = 3_600_000_000_000;
    let STALE_PENDING_NANOS : Nat64 = 300_000_000_000;
    let KEY_MIN_BYTES : Nat = 16;
    let KEY_MAX_BYTES : Nat = 64;
    let MAX_CONTENT_TYPE_BYTES : Nat = 256;

    public func mountFingerprint(
        surface : RouteNamespace.Surface,
        prefix : Text,
        mount : Types.MountDeclaration,
        handler : Text,
        maxCalls : Nat,
    ) : Text {
        RouteNamespace.surfaceText(surface) # "\00" # prefix #
        "\00POST\00" # handler # "\00" #
        Nat.toText(mount.max_request_bytes) # "\00" # Nat.toText(mount.max_response_bytes) #
        "\00" # Nat.toText(maxCalls) # "\00" # Text.join(mount.forward_headers.vals(), ",");
    };

    type SelectedHeaders = {
        idempotency_key : Text;
        forwarded : [(Text, Text)];
    };

    type Candidate = {
        mount : Types.CommittedMount;
        request : Types.HandlerRequestV1;
        key_hash : Blob;
    };

    type InspectResult = { #ok : Candidate; #err : Types.Error };

    public class Service(
        mem : Types.Memory,
        canisterId : Text,
        scopeActive : Types.AppScope -> Bool,
        deploymentCommitted : () -> Bool,
        isKernelAuthorized : Principal -> Bool,
        instructionUsageBegin : Types.AppScope -> Nat64,
        instructionUsageFinish : (Types.AppScope, Nat64) -> (),
        registry : CapabilityTypes.RuntimeRegistry,
        cycleBalance : () -> Nat,
        now : () -> Nat64,
    ) {
        let targetMounts = Map.empty<Text, Types.CommittedMount>();
        let handlers = Map.empty<Text, Types.HandlerV1>();
        let hostScopes = Map.empty<Text, Types.AppScope>();
        let sharedScopes = Map.empty<Text, Types.AppScope>();
        let mountsByScope = Map.empty<Text, [Types.CommittedMount]>();
        var configured = false;
        var handlersConfigured = false;

        public func configure(apps : [Types.AppDeclaration]) : () {
            assert (not configured);
            var globalCalls = 0;
            var globalReplayBytes = 0;
            for (app in apps.vals()) {
                assert (CapabilityScope.valid(app.app_scope));
                let ?routes = app.http_routes else continue;
                assert (routes.api == 1);
                assert (routes.mounts.size() >= 1 and routes.mounts.size() <= MAX_MOUNTS_PER_APP);
                var appCalls = 0;
                var appReplayBytes = 0;
                var priorId : ?Text = null;
                for (authored in routes.mounts.vals()) {
                    switch (priorId) {
                        case (?value) assert (Text.compare(value, authored.id) == #less);
                        case null {};
                    };
                    priorId := ?authored.id;
                    if (authored.mode != "http_post_update_handler") continue;
                    let mount = normalizeMount(app.app_scope, authored);
                    for (existing in Map.values(targetMounts)) {
                        if (
                            CapabilityScope.equal(existing.scope, mount.scope) and
                            existing.surface == mount.surface
                        ) {
                            assert (not prefixesOverlap(existing.prefix, mount.prefix));
                        };
                    };
                    let key = mountKey(mount.scope, mount.id);
                    assert (not Map.containsKey(targetMounts, Text.compare, key));
                    Map.add(targetMounts, Text.compare, key, mount);
                    appCalls += mount.max_calls_per_hour;
                    appReplayBytes += mount.max_calls_per_hour * mount.max_response_bytes;
                };
                assert (appCalls <= MAX_CALLS_PER_APP_PER_HOUR);
                assert (appReplayBytes <= MAX_REPLAY_BYTES_PER_APP);
                globalCalls += appCalls;
                globalReplayBytes += appReplayBytes;
            };
            assert (globalCalls <= MAX_CALLS_GLOBAL_PER_HOUR);
            assert (globalReplayBytes <= MAX_REPLAY_BYTES_GLOBAL);
            configured := true;
            recoverInterruptedDispatches();
        };

        public func configureHandlers(registrations : [Types.HandlerRegistration]) : () {
            assert (configured and not handlersConfigured);
            for (registration in registrations.vals()) {
                let key = mountKey(registration.app_scope, registration.mount_id);
                assert (Map.containsKey(targetMounts, Text.compare, key));
                assert (not Map.containsKey(handlers, Text.compare, key));
                Map.add(handlers, Text.compare, key, registration.handler);
            };
            assert (Map.size(handlers) == Map.size(targetMounts));
            handlersConfigured := true;
        };

        public func commitConfiguration() : () {
            assert (configured and deploymentCommitted());
            for (mount in Map.values(targetMounts)) assert (scopeActive(mount.scope));

            let nextMounts = Map.empty<Text, Types.CommittedMount>();
            let nextRates = Map.empty<Text, Types.RateCounter>();
            for ((key, target) in Map.entries(targetMounts)) {
                let prior = Map.get(mem.mounts, Text.compare, key);
                let authorityEpoch = switch (prior) {
                    case (?old) {
                        if (old.fingerprint == target.fingerprint) {
                            old.authority_epoch
                        } else {
                            old.authority_epoch + (1 : Nat64)
                        }
                    };
                    case null (1 : Nat64);
                };
                Map.add(nextMounts, Text.compare, key, { target with authority_epoch = authorityEpoch });
                switch (prior, Map.get(mem.rates_by_mount, Text.compare, key)) {
                    case (?old, ?rate) {
                        if (old.fingerprint == target.fingerprint) {
                            Map.add(nextRates, Text.compare, key, rate);
                        };
                    };
                    case _ {};
                };
            };
            Map.clear(mem.mounts);
            for ((key, mount) in Map.entries(nextMounts)) {
                Map.add(mem.mounts, Text.compare, key, mount);
            };
            Map.clear(mem.rates_by_mount);
            for ((key, rate) in Map.entries(nextRates)) {
                Map.add(mem.rates_by_mount, Text.compare, key, rate);
            };
            purgeInactiveScopes(effectiveNow());
            refreshIndexes();
        };

        public func setMountEnabled(scope : Types.AppScope, mountId : Text) : () {
            let key = mountKey(scope, mountId);
            let ?mount = Map.get(mem.mounts, Text.compare, key) else return;
            Map.add(mem.mounts, Text.compare, key, {
                mount with authority_epoch = mount.authority_epoch + 1
            });
            refreshIndexes();
        };

        public func canUpgrade(
            authority : Text,
            url : Text,
            method : Text,
            _headers : [(Text, Text)],
            _body : Blob,
        ) : Bool {
            if (not handlersConfigured) return false;
            if (method != "POST") return false;
            // Query decides only whether this exact live route owns the POST.
            // Request validation belongs to the update path so malformed
            // route requests still receive the intended verified HTTP error
            // instead of an uncertified query response rejected by gateways.
            mountForRequest(authority, url) != null;
        };

        public func dispatch(
            caller : Principal,
            authority : Text,
            url : Text,
            method : Text,
            headers : [(Text, Text)],
            body : Blob,
        ) : async* Types.Result {
            if (not handlersConfigured) return #err(#not_found);
            let candidate = switch (inspect(authority, url, method, headers, body)) {
                case (#ok(value)) value;
                case (#err(error)) return #err(error);
            };
            let mount = candidate.mount;
            let measurementStartedAt = instructionUsageBegin(mount.scope);
            let key = mountKey(mount.scope, mount.id);
            let ?handler = Map.get(handlers, Text.compare, key) else {
                return finishMeasured(mount, measurementStartedAt, #err(#handler_failed));
            };
            let timestamp = effectiveNow();
            cleanupExpired(timestamp);
            reapStalePending(timestamp);

            switch (Map.get(mem.replays, Blob.compare, candidate.key_hash)) {
                case (?replay) {
                    let candidateRequestHash = requestHash(mount, candidate.request);
                    if (
                        replay.mount_fingerprint != mount.fingerprint or
                        not Blob.equal(replay.request_hash, candidateRequestHash)
                    ) return finishMeasured(mount, measurementStartedAt, #err(#conflict));
                    return finishMeasured(
                        mount,
                        measurementStartedAt,
                        switch (replay.state) {
                            case (#completed(response)) #ok(response);
                            case (#pending) #err(#pending);
                            case (#failed_unknown) #err(#failed_unknown);
                        },
                    );
                };
                case null {};
            };

            if (cycleBalance() < MIN_REMAINING_CYCLES) {
                return finishMeasured(mount, measurementStartedAt, #err(#low_cycles));
            };
            let scopeKey = CapabilityScope.key(mount.scope);
            if (
                Queue.size(mem.replay_order) >= MAX_REPLAY_ENTRIES_GLOBAL or
                count(mem.replay_entries_by_scope, scopeKey) >= MAX_REPLAY_ENTRIES_PER_APP or
                mem.replay_reserved_bytes + mount.max_response_bytes > MAX_REPLAY_BYTES_GLOBAL or
                count(mem.replay_reserved_bytes_by_scope, scopeKey) + mount.max_response_bytes > MAX_REPLAY_BYTES_PER_APP
            ) return finishMeasured(mount, measurementStartedAt, #err(#capacity_exceeded));
            if (
                mem.pending >= MAX_PENDING_GLOBAL or
                count(mem.pending_by_mount, key) >= MAX_PENDING_PER_MOUNT or
                count(mem.pending_by_scope, scopeKey) >= MAX_PENDING_PER_APP
            ) return finishMeasured(mount, measurementStartedAt, #err(#busy));
            // HTTP gateways enter anonymously. Direct Candid calls by an
            // authorized Neutron user bypass request windows and never mutate
            // the external-traffic counters.
            if (not isKernelAuthorized(caller) and not rateAvailable(mount, timestamp)) {
                return finishMeasured(mount, measurementStartedAt, #err(#rate_limited));
            };
            let candidateRequestHash = requestHash(mount, candidate.request);
            if (not isKernelAuthorized(caller)) assert (consumeRate(mount, timestamp));

            let replay : Types.Replay = {
                scope = mount.scope;
                mount_id = mount.id;
                mount_fingerprint = mount.fingerprint;
                authority_epoch = mount.authority_epoch;
                key_hash = candidate.key_hash;
                request_hash = candidateRequestHash;
                accepted_at = timestamp;
                reserved_response_bytes = mount.max_response_bytes;
                state = #pending;
            };
            Map.add(mem.replays, Blob.compare, replay.key_hash, replay);
            Queue.pushBack(mem.replay_order, replay.key_hash);
            addCount(mem.replay_entries_by_scope, scopeKey, 1);
            addCount(mem.replay_reserved_bytes_by_scope, scopeKey, replay.reserved_response_bytes);
            mem.replay_reserved_bytes += replay.reserved_response_bytes;
            addPending(replay);

            let dispatch : Types.DispatchV1 = {
                request = candidate.request;
                key_hash = replay.key_hash;
                request_hash = replay.request_hash;
                mount_fingerprint = replay.mount_fingerprint;
                authority_epoch = replay.authority_epoch;
            };
            ignore try {
                await handler(dispatch);
            } catch (_) {
                failPending(replay.key_hash);
                return finishMeasured(mount, measurementStartedAt, #err(#handler_failed));
            };
            let completed = switch (Map.get(mem.replays, Blob.compare, replay.key_hash)) {
                case (?{ state = #completed(response) }) response;
                case _ {
                    failPending(replay.key_hash);
                    return finishMeasured(mount, measurementStartedAt, #err(#handler_failed));
                };
            };
            let current = currentMount(mount.scope, mount.id);
            if (switch (current) {
                case (?value) value.fingerprint != dispatch.mount_fingerprint or
                    value.authority_epoch != dispatch.authority_epoch;
                case null true;
            }) return finishMeasured(mount, measurementStartedAt, #err(#revoked));
            finishMeasured(mount, measurementStartedAt, #ok(completed));
        };

        // Invoked by compiler-generated shared wrappers after they have
        // independently asserted that the caller is this canister.
        public func dispatchBegin(
            scope : Types.AppScope,
            mountId : Text,
            dispatch : Types.DispatchV1,
        ) : () {
            let ?mount = currentMount(scope, mountId) else Runtime.trap("http_post_update_handler route is unavailable");
            assert (
                mount.fingerprint == dispatch.mount_fingerprint and
                mount.authority_epoch == dispatch.authority_epoch
            );
            let ?replay = Map.get(mem.replays, Blob.compare, dispatch.key_hash) else Runtime.trap(
                "http_post_update_handler admission is unavailable"
            );
            assert (
                replay.state == #pending and
                CapabilityScope.equal(replay.scope, scope) and
                replay.mount_id == mountId and
                replay.mount_fingerprint == dispatch.mount_fingerprint and
                replay.authority_epoch == dispatch.authority_epoch and
                Blob.equal(replay.request_hash, dispatch.request_hash)
            );
        };

        public func dispatchFinish(
            scope : Types.AppScope,
            mountId : Text,
            dispatch : Types.DispatchV1,
            response : Types.HandlerResponseV1,
        ) : () {
            dispatchBegin(scope, mountId, dispatch);
            let ?mount = currentMount(scope, mountId) else Runtime.trap("http_post_update_handler route is unavailable");
            assert (validResponse(response, mount.max_response_bytes));
            let ?replay = Map.get(mem.replays, Blob.compare, dispatch.key_hash) else Runtime.trap(
                "http_post_update_handler admission is unavailable"
            );
            Map.add(mem.replays, Blob.compare, dispatch.key_hash, {
                replay with state = #completed(response)
            });
            removePending(replay);
        };

        func inspect(
            authority : Text,
            url : Text,
            method : Text,
            headers : [(Text, Text)],
            body : Blob,
        ) : InspectResult {
            if (method != "POST") return #err(#method_not_allowed);
            let ?mount = mountForRequest(authority, url) else return #err(#not_found);
            let scope = mount.scope;
            if (body.size() > mount.max_request_bytes) return #err(#too_large);
            let ?selected = selectedHeaders(headers, mount.forward_headers) else {
                return #err(#bad_request);
            };
            let relativePath = switch (RouteNamespace.relativePath(mount.prefix, url)) {
                case (?value) value;
                case null return #err(#not_found);
            };
            let keyHash = hashFields([
                Text.encodeUtf8("neutron.http-post-update-handler.idempotency.v1"),
                Text.encodeUtf8(CapabilityScope.key(scope)),
                Text.encodeUtf8(mount.id),
                Text.encodeUtf8(selected.idempotency_key),
            ]);
            #ok({
                mount;
                key_hash = keyHash;
                request = {
                    path = relativePath;
                    headers = selected.forwarded;
                    body;
                    request_id_hash = keyHash;
                };
            });
        };

        func selectedHeaders(
            headers : [(Text, Text)],
            declared : [Text],
        ) : ?SelectedHeaders {
            var idempotencyKey : ?Text = null;
            var contentEncodingSeen = false;
            let forwarded = List.empty<(Text, Text)>();
            for ((rawName, value) in headers.vals()) {
                let name = Text.toLower(rawName);
                if (name == "cookie" or name == "set-cookie") return null;
                if (name == "content-encoding") {
                    if (contentEncodingSeen or Text.toLower(value) != "identity") return null;
                    contentEncodingSeen := true;
                };
                if (name == "idempotency-key") {
                    if (idempotencyKey != null or not validIdempotencyKey(value)) return null;
                    idempotencyKey := ?value;
                };
            };
            let ?key = idempotencyKey else return null;
            for (name in declared.vals()) {
                var selected : ?Text = null;
                for ((rawName, value) in headers.vals()) {
                    if (Text.toLower(rawName) == name) {
                        if (selected != null or not validHeaderValue(value)) return null;
                        selected := ?value;
                    };
                };
                switch (selected) {
                    case (?value) List.add(forwarded, (name, value));
                    case null {};
                };
            };
            ?{ idempotency_key = key; forwarded = List.toArray(forwarded) };
        };

        func normalizeMount(
            scope : Types.AppScope,
            authored : Types.MountDeclaration,
        ) : Types.CommittedMount {
            assert (RouteNamespace.validMountId(authored.id));
            let ?surface = RouteNamespace.parseSurface(authored.surface) else {
                Runtime.trap("Invalid HTTP route surface");
            };
            assert (authored.mode == "http_post_update_handler");
            assert (authored.methods.size() == 1 and authored.methods[0] == "POST");
            let ?prefix = RouteNamespace.publicPrefix(
                surface,
                scope.app_id,
                authored.id,
                authored.prefix,
            ) else Runtime.trap("Invalid HTTP route prefix");
            assert (authored.max_request_bytes >= 1 and authored.max_request_bytes <= MAX_REQUEST_BYTES);
            assert (authored.max_response_bytes >= 1 and authored.max_response_bytes <= MAX_RESPONSE_BYTES);
            let ?handler = authored.handler else Runtime.trap("http_post_update_handler requires a handler");
            assert (validMethodName(handler));
            let ?maxCalls = authored.max_calls_per_hour else Runtime.trap("http_post_update_handler rate is required");
            assert (maxCalls >= 1 and maxCalls <= MAX_CALLS_PER_MOUNT_PER_HOUR);
            assert (authored.forward_headers.size() <= 8 and validForwardHeaders(authored.forward_headers));
            {
                scope;
                id = authored.id;
                surface;
                prefix;
                max_request_bytes = authored.max_request_bytes;
                max_response_bytes = authored.max_response_bytes;
                max_calls_per_hour = maxCalls;
                forward_headers = authored.forward_headers;
                authority_epoch = 0;
                fingerprint = mountFingerprint(
                    surface,
                    prefix,
                    authored,
                    handler,
                    maxCalls,
                );
            };
        };

        func currentMount(scope : Types.AppScope, mountId : Text) : ?Types.CommittedMount {
            if (not scopeActive(scope) or not registry.allowed(scope, #http_routes, mountId)) return null;
            let key = mountKey(scope, mountId);
            let ?target = Map.get(targetMounts, Text.compare, key) else return null;
            let ?committed = Map.get(mem.mounts, Text.compare, key) else return null;
            if (target.fingerprint != committed.fingerprint) return null;
            ?committed;
        };

        func mountForPath(scope : Types.AppScope, url : Text) : ?Types.CommittedMount {
            let mounts = switch (Map.get(mountsByScope, Text.compare, CapabilityScope.key(scope))) {
                case (?value) value;
                case null return null;
            };
            for (mount in mounts.vals()) {
                if (
                    mount.surface == #app_host and
                    RouteNamespace.contains(mount.prefix, url) and
                    currentMount(scope, mount.id) != null
                ) return ?mount;
            };
            null;
        };

        func mountForRequest(authority : Text, url : Text) : ?Types.CommittedMount {
            if (not RouteNamespace.validAbsolutePath(url)) return null;
            let ?parsedAuthority = GatewayAuthority.parseCanonical(authority) else {
                return null;
            };
            if (RouteNamespace.isSharedAuthority(
                canisterId,
                parsedAuthority.authority,
            )) {
                let ?target = RouteNamespace.sharedTarget(url) else return null;
                let ?scope = Map.get(sharedScopes, Text.compare, target.app_id) else return null;
                let ?mount = currentMount(scope, target.mount_id) else return null;
                if (
                    mount.surface != #shared_app_path or
                    not RouteNamespace.contains(mount.prefix, url)
                ) return null;
                return ?mount;
            };
            let ?scope = Map.get(
                hostScopes,
                Text.compare,
                parsedAuthority.authority,
            ) else return null;
            mountForPath(scope, url);
        };

        func consumeRate(mount : Types.CommittedMount, timestamp : Nat64) : Bool {
            let mountKeyValue = mountKey(mount.scope, mount.id);
            let scopeKey = CapabilityScope.key(mount.scope);
            let mountRate = refreshedRate(Map.get(mem.rates_by_mount, Text.compare, mountKeyValue), timestamp);
            let scopeRate = refreshedRate(Map.get(mem.rates_by_scope, Text.compare, scopeKey), timestamp);
            let globalRate = refreshedRate(?mem.global_rate, timestamp);
            if (
                mountRate.accepted >= mount.max_calls_per_hour or
                scopeRate.accepted >= MAX_CALLS_PER_APP_PER_HOUR or
                globalRate.accepted >= MAX_CALLS_GLOBAL_PER_HOUR
            ) return false;
            Map.add(mem.rates_by_mount, Text.compare, mountKeyValue, {
                mountRate with accepted = mountRate.accepted + 1
            });
            Map.add(mem.rates_by_scope, Text.compare, scopeKey, {
                scopeRate with accepted = scopeRate.accepted + 1
            });
            mem.global_rate := { globalRate with accepted = globalRate.accepted + 1 };
            true;
        };

        func rateAvailable(mount : Types.CommittedMount, timestamp : Nat64) : Bool {
            let mountRate = refreshedRate(
                Map.get(mem.rates_by_mount, Text.compare, mountKey(mount.scope, mount.id)),
                timestamp,
            );
            let scopeRate = refreshedRate(
                Map.get(mem.rates_by_scope, Text.compare, CapabilityScope.key(mount.scope)),
                timestamp,
            );
            let globalRate = refreshedRate(?mem.global_rate, timestamp);
            mountRate.accepted < mount.max_calls_per_hour and
            scopeRate.accepted < MAX_CALLS_PER_APP_PER_HOUR and
            globalRate.accepted < MAX_CALLS_GLOBAL_PER_HOUR;
        };

        func refreshedRate(rate : ?Types.RateCounter, timestamp : Nat64) : Types.RateCounter {
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

        func cleanupExpired(timestamp : Nat64) : () {
            label expired loop {
                let ?key = Queue.peekFront(mem.replay_order) else break expired;
                let ?replay = Map.get(mem.replays, Blob.compare, key) else {
                    ignore Queue.popFront(mem.replay_order);
                    continue expired;
                };
                if (
                    timestamp < replay.accepted_at or
                    timestamp - replay.accepted_at < HOUR_NANOS
                ) break expired;
                ignore Queue.popFront(mem.replay_order);
                removeReplay(replay);
            };
        };

        func reapStalePending(timestamp : Nat64) : () {
            if (mem.pending == 0) return;
            let stale = List.empty<(Blob, Types.Replay)>();
            for ((key, replay) in Map.entries(mem.replays)) {
                if (
                    replay.state == #pending and timestamp >= replay.accepted_at and
                    timestamp - replay.accepted_at >= STALE_PENDING_NANOS
                ) List.add(stale, (key, replay));
            };
            for ((key, replay) in List.values(stale)) {
                Map.add(mem.replays, Blob.compare, key, { replay with state = #failed_unknown });
                removePending(replay);
            };
        };

        func purgeInactiveScopes(timestamp : Nat64) : () {
            cleanupExpired(timestamp);
            let removals = List.empty<Types.Replay>();
            for (replay in Map.values(mem.replays)) {
                if (not scopeActive(replay.scope)) List.add(removals, replay);
            };
            for (replay in List.values(removals)) removeReplay(replay);
            var remaining = Queue.size(mem.replay_order);
            while (remaining > 0) {
                let ?key = Queue.popFront(mem.replay_order) else Runtime.trap(
                    "HTTP replay queue changed while pruning"
                );
                if (Map.containsKey(mem.replays, Blob.compare, key)) {
                    Queue.pushBack(mem.replay_order, key);
                };
                remaining -= 1;
            };
            let staleScopeRates = List.empty<Text>();
            for ((key, _) in Map.entries(mem.rates_by_scope)) {
                var active = false;
                for (mount in Map.values(mem.mounts)) {
                    if (CapabilityScope.key(mount.scope) == key) active := true;
                };
                for (replay in Map.values(mem.replays)) {
                    if (CapabilityScope.key(replay.scope) == key) active := true;
                };
                if (not active) List.add(staleScopeRates, key);
            };
            for (key in List.values(staleScopeRates)) {
                ignore Map.delete(mem.rates_by_scope, Text.compare, key);
            };
        };

        func recoverInterruptedDispatches() : () {
            let updates = List.empty<(Blob, Types.Replay)>();
            for ((key, replay) in Map.entries(mem.replays)) {
                if (replay.state == #pending) {
                    List.add(updates, (key, { replay with state = #failed_unknown }));
                };
            };
            for ((key, replay) in List.values(updates)) {
                Map.add(mem.replays, Blob.compare, key, replay);
            };
            Map.clear(mem.pending_by_mount);
            Map.clear(mem.pending_by_scope);
            mem.pending := 0;
        };

        func removeReplay(replay : Types.Replay) : () {
            ignore Map.delete(mem.replays, Blob.compare, replay.key_hash);
            let scopeKey = CapabilityScope.key(replay.scope);
            subtractCount(mem.replay_entries_by_scope, scopeKey, 1);
            subtractCount(mem.replay_reserved_bytes_by_scope, scopeKey, replay.reserved_response_bytes);
            assert (mem.replay_reserved_bytes >= replay.reserved_response_bytes);
            mem.replay_reserved_bytes -= replay.reserved_response_bytes;
            if (replay.state == #pending) removePending(replay);
        };

        func failPending(key : Blob) : () {
            let ?replay = Map.get(mem.replays, Blob.compare, key) else return;
            if (replay.state != #pending) return;
            Map.add(mem.replays, Blob.compare, key, { replay with state = #failed_unknown });
            removePending(replay);
        };

        func addPending(replay : Types.Replay) : () {
            mem.pending += 1;
            addCount(mem.pending_by_mount, mountKey(replay.scope, replay.mount_id), 1);
            addCount(mem.pending_by_scope, CapabilityScope.key(replay.scope), 1);
        };

        func removePending(replay : Types.Replay) : () {
            assert (mem.pending > 0);
            mem.pending -= 1;
            subtractCount(mem.pending_by_mount, mountKey(replay.scope, replay.mount_id), 1);
            subtractCount(mem.pending_by_scope, CapabilityScope.key(replay.scope), 1);
        };

        func count(map : Map.Map<Text, Nat>, key : Text) : Nat {
            switch (Map.get(map, Text.compare, key)) { case (?value) value; case null 0 };
        };

        func addCount(map : Map.Map<Text, Nat>, key : Text, amount : Nat) : () {
            Map.add(map, Text.compare, key, count(map, key) + amount);
        };

        func subtractCount(map : Map.Map<Text, Nat>, key : Text, amount : Nat) : () {
            let current = count(map, key);
            assert (current >= amount);
            if (current == amount) {
                ignore Map.delete(map, Text.compare, key);
            } else {
                Map.add(map, Text.compare, key, current - amount);
            };
        };

        func effectiveNow() : Nat64 {
            let observed = now();
            if (observed > mem.last_seen_at) mem.last_seen_at := observed;
            mem.last_seen_at;
        };

        func finish(mount : Types.CommittedMount, result : Types.Result) : Types.Result {
            ignore registry.record(
                mount.scope,
                #http_routes,
                mount.id,
                "POST",
                switch (result) {
                    case (#ok(_)) #ok;
                    case (#err(#rate_limited)) #rate_limited;
                    case (#err(#busy)) #busy;
                    case (#err(#revoked)) #revoked;
                    case (#err(#handler_failed)) #failed;
                    case (#err(_)) #denied;
                },
            );
            result;
        };

        func finishMeasured(
            mount : Types.CommittedMount,
            measurementStartedAt : Nat64,
            result : Types.Result,
        ) : Types.Result {
            let recorded = finish(mount, result);
            instructionUsageFinish(mount.scope, measurementStartedAt);
            recorded;
        };

        func refreshIndexes() : () {
            Map.clear(hostScopes);
            Map.clear(sharedScopes);
            Map.clear(mountsByScope);
            for (mount in Map.values(mem.mounts)) {
                let scopeKey = CapabilityScope.key(mount.scope);
                let current = switch (Map.get(mountsByScope, Text.compare, scopeKey)) {
                    case (?value) value;
                    case null [];
                };
                Map.add(mountsByScope, Text.compare, scopeKey, Array.concat<Types.CommittedMount>(current, [mount]));
                switch (mount.surface) {
                    case (#app_host) {
                        for (authority in RouteNamespace.authorities(
                            mount.surface,
                            canisterId,
                            mount.scope.app_id,
                        ).vals()) {
                            switch (Map.get(hostScopes, Text.compare, authority)) {
                                case (?owner) assert (CapabilityScope.equal(owner, mount.scope));
                                case null Map.add(hostScopes, Text.compare, authority, mount.scope);
                            };
                        };
                    };
                    case (#shared_app_path) {
                        switch (Map.get(sharedScopes, Text.compare, mount.scope.app_id)) {
                            case (?owner) assert (CapabilityScope.equal(owner, mount.scope));
                            case null Map.add(sharedScopes, Text.compare, mount.scope.app_id, mount.scope);
                        };
                    };
                };
            };
        };

        func validResponse(response : Types.HandlerResponseV1, maxBytes : Nat) : Bool {
            response.body.size() <= maxBytes and validContentType(response.content_type)
        };

        func validContentType(value : Text) : Bool {
            if (value.size() == 0 or Text.encodeUtf8(value).size() > MAX_CONTENT_TYPE_BYTES) return false;
            for (char in value.chars()) {
                if (char < ' ' or char == '\u{7f}' or char == '\r' or char == '\n') return false;
            };
            Text.contains(value, #char '/');
        };

        func validHeaderValue(value : Text) : Bool {
            if (Text.encodeUtf8(value).size() > 4_096) return false;
            for (char in value.chars()) {
                if (char < ' ' or char == '\u{7f}') return false;
            };
            true;
        };

        func validIdempotencyKey(value : Text) : Bool {
            let bytes = Text.encodeUtf8(value).size();
            if (bytes < KEY_MIN_BYTES or bytes > KEY_MAX_BYTES) return false;
            for (char in value.chars()) {
                if (not (
                    (char >= 'a' and char <= 'z') or (char >= 'A' and char <= 'Z') or
                    (char >= '0' and char <= '9') or char == '_' or char == '-'
                )) return false;
            };
            true;
        };

        func validForwardHeaders(headers : [Text]) : Bool {
            var prior : ?Text = null;
            for (header in headers.vals()) {
                if (not validHeaderName(header) or reservedForwardHeader(header)) return false;
                switch (prior) {
                    case (?value) if (Text.compare(value, header) != #less) return false;
                    case null {};
                };
                prior := ?header;
            };
            true;
        };

        func validHeaderName(value : Text) : Bool {
            if (value.size() < 1 or value.size() > 64 or Text.toLower(value) != value) return false;
            var first = true;
            for (char in value.chars()) {
                if (first) {
                    if (not ((char >= 'a' and char <= 'z') or (char >= '0' and char <= '9'))) return false;
                    first := false;
                } else if (not (
                    (char >= 'a' and char <= 'z') or
                    (char >= '0' and char <= '9') or char == '-'
                )) return false;
            };
            true;
        };

        func reservedForwardHeader(value : Text) : Bool {
            value == "host" or value == "content-length" or value == "cookie" or
            value == "set-cookie" or value == "connection" or value == "transfer-encoding" or
            value == "upgrade" or value == "content-encoding" or value == "idempotency-key" or
            value == "keep-alive" or value == "te" or value == "trailer" or value == "origin" or
            Text.startsWith(value, #text "proxy-") or Text.startsWith(value, #text "sec-") or
            Text.startsWith(value, #text "ic-")
        };

        func validMethodName(value : Text) : Bool {
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

        func prefixesOverlap(left : Text, right : Text) : Bool {
            left == right or Text.startsWith(left, #text (right # "/")) or
            Text.startsWith(right, #text (left # "/"));
        };

        func mountKey(scope : Types.AppScope, mountId : Text) : Text {
            CapabilityScope.key(scope) # "\00" # mountId;
        };

        func requestHash(
            mount : Types.CommittedMount,
            request : Types.HandlerRequestV1,
        ) : Blob {
            let fields = List.empty<Blob>();
            List.add(fields, Text.encodeUtf8("neutron.http-post-update-handler.request.v1"));
            List.add(fields, Text.encodeUtf8(mount.fingerprint));
            List.add(fields, Text.encodeUtf8(request.path));
            for ((name, value) in request.headers.vals()) {
                List.add(fields, Text.encodeUtf8(name));
                List.add(fields, Text.encodeUtf8(value));
            };
            List.add(fields, request.body);
            hashFields(List.toArray(fields));
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
};
