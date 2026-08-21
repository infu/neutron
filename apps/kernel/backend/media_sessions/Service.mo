import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";
import Text "mo:core/Text";
import CapabilityTypes "../capabilities/Types";
import Scope "../capabilities/Scope";
import Types "Types";

module {
    public let MIN_DURATION_SECONDS : Nat = 300;
    public let MAX_DURATION_SECONDS : Nat = 14_400;
    let NANOS_PER_SECOND : Nat64 = 1_000_000_000;
    let NAT64_MAX : Nat64 = 18_446_744_073_709_551_615;
    let LOWER_HEX : [Text] = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];

    public class Service(
        memory : Types.Memory,
        adapter : Types.Adapter,
        committedInstance : Text -> ?CapabilityTypes.AppInstance,
        scopeActive : CapabilityTypes.AppScope -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        now : () -> Nat64,
    ) {
        let declarations = Map.empty<Text, Types.Declaration>();
        var configured = false;
        var terminalCertification : ?Types.LeaseView = null;

        public func configure(apps : [Types.AppDeclaration]) : () {
            assert (not configured);
            for (app in apps.vals()) {
                assert (Scope.valid(app.app_scope));
                let ?declaration = app.media_sessions else continue;
                assert (validDeclaration(declaration));
                let key = Scope.key(app.app_scope);
                assert (not Map.containsKey(declarations, Text.compare, key));
                Map.add(declarations, Text.compare, key, declaration);
            };
            configured := true;
            reconcile();
        };

        public func begin(input : Types.BeginInput) : async* Types.BeginResult {
            reconcile();
            if (not validRequestId(input.request_id)) return #err(#invalid_request);
            let ?instance = committedInstance(input.app_id) else return #err(#undeclared);
            if (not scopeActive(instance.scope)) return #err(#undeclared);
            let ?declaration = declarationFor(instance.scope) else return #err(#undeclared);
            if (
                input.duration_seconds < MIN_DURATION_SECONDS or
                input.duration_seconds > declaration.max_duration_seconds or
                not validRequestedFeatures(input.features, declaration.features)
            ) return #err(#invalid_request);
            let ?runtimeLease = registry.lease(
                instance.scope,
                #media_sessions,
                "default",
            ) else return #err(#disabled);
            switch (memory.active_session_id) {
                case (?_) return #err(#busy);
                case null {};
            };

            let entropy = try { await adapter.random() } catch (_) { #err };
            let nonce = switch (entropy) {
                case (#ok(value)) {
                    if (value.size() != 32) return #err(#randomness_failed);
                    lowerHex(value);
                };
                case (#err) return #err(#randomness_failed);
            };
            if (
                not runtimeLease.active() or
                not scopeActive(instance.scope) or
                declarationFor(instance.scope) == null or
                memory.active_session_id != null
            ) return #err(#disabled);

            let createdAt = now();
            let durationNanos = Nat64.fromNat(input.duration_seconds) * NANOS_PER_SECOND;
            if (createdAt > NAT64_MAX - durationNanos) return #err(#invalid_request);
            let sessionId = "media-" # nonce;
            memory.next_session_id += 1;
            memory.authority_epoch += 1;
            let lease : Types.Lease = {
                session_id = sessionId;
                scope = instance.scope;
                app_version = instance.version;
                plan_fingerprint = instance.capability_plan_fingerprint;
                request_id = input.request_id;
                origin_nonce = nonce;
                features = input.features;
                created_at = createdAt;
                expires_at = createdAt + durationNanos;
                authority_epoch = memory.authority_epoch;
                state = #active;
            };
            Map.add(memory.leases, Text.compare, sessionId, lease);
            memory.active_session_id := ?sessionId;
            ignore registry.record(instance.scope, #media_sessions, "default", "open", #ok);
            #ok(view(lease, declaration));
        };

        public func close(sessionId : Text) : Types.CloseResult {
            reconcile();
            let ?lease = Map.get(memory.leases, Text.compare, sessionId) else return #not_found;
            if (lease.state != #active) return #not_found;
            revoke(lease, #revoked);
            ignore registry.record(lease.scope, #media_sessions, "default", "close", #ok);
            #ok;
        };

        public func active(sessionId : Text, nonce : Text) : ?Types.LeaseView {
            reconcile();
            let ?lease = Map.get(memory.leases, Text.compare, sessionId) else return null;
            if (lease.state != #active or lease.origin_nonce != nonce) return null;
            if (not scopeActive(lease.scope)) return null;
            let ?declaration = declarationFor(lease.scope) else return null;
            ?view(lease, declaration);
        };

        public func current() : ?Types.LeaseView {
            reconcile();
            let ?lease = activeLease() else return null;
            let ?declaration = declarationFor(lease.scope) else return null;
            ?view(lease, declaration);
        };

        public func revokeAll() : () {
            switch (activeLease()) {
                case (?lease) revoke(lease, #revoked);
                case null {};
            };
        };

        public func takeTerminalCertification() : ?Types.LeaseView {
            let result = terminalCertification;
            terminalCertification := null;
            result;
        };

        func reconcile() : () {
            let ?lease = activeLease() else return;
            if (
                lease.expires_at <= now() or
                not scopeActive(lease.scope) or
                declarationFor(lease.scope) == null or
                not registry.allowed(lease.scope, #media_sessions, "default")
            ) {
                let state = if (lease.expires_at <= now()) #expired else #revoked;
                revoke(lease, state);
            };
        };

        func activeLease() : ?Types.Lease {
            let ?sessionId = memory.active_session_id else return null;
            Map.get(memory.leases, Text.compare, sessionId);
        };

        func revoke(lease : Types.Lease, _state : Types.LeaseState) : () {
            // The capability registry owns bounded outcome totals. Lease
            // payloads are authority, not an audit log, so retain at most the
            // one live record and erase it on every terminal transition.
            switch (declarationFor(lease.scope)) {
                case (?declaration) {
                    terminalCertification := ?view(lease, declaration);
                };
                case null {};
            };
            Map.remove(memory.leases, Text.compare, lease.session_id);
            memory.active_session_id := null;
            memory.authority_epoch += 1;
        };

        func declarationFor(scope : CapabilityTypes.AppScope) : ?Types.Declaration {
            Map.get(declarations, Text.compare, Scope.key(scope));
        };

        func view(lease : Types.Lease, declaration : Types.Declaration) : Types.LeaseView {
            {
                session_id = lease.session_id;
                app_id = lease.scope.app_id;
                installation_uid = lease.scope.installation_uid;
                app_version = lease.app_version;
                plan_fingerprint = lease.plan_fingerprint;
                origin_nonce = lease.origin_nonce;
                entrypoint = declaration.entrypoint;
                features = lease.features;
                created_at = lease.created_at;
                expires_at = lease.expires_at;
                authority_epoch = lease.authority_epoch;
            };
        };
    };

    func validDeclaration(declaration : Types.Declaration) : Bool {
        validEntrypoint(declaration.entrypoint) and
        declaration.max_duration_seconds >= MIN_DURATION_SECONDS and
        declaration.max_duration_seconds <= MAX_DURATION_SECONDS and
        validRequestedFeatures(declaration.features, [#camera, #microphone]);
    };

    public func validEntrypoint(value : Text) : Bool {
        if (
            value.size() == 0 or
            Text.startsWith(value, #text "/") or
            Text.contains(value, #char '\\') or
            Text.contains(value, #char '?') or
            Text.contains(value, #char '#')
        ) return false;
        for (segment in Text.split(value, #char '/')) {
            if (segment == "" or segment == "." or segment == "..") return false;
        };
        true;
    };

    func validRequestedFeatures(requested : [Types.Feature], allowed : [Types.Feature]) : Bool {
        if (requested.size() < 1 or requested.size() > 2) return false;
        var previous : ?Types.Feature = null;
        for (feature in requested.vals()) {
            switch (previous, feature) {
                case (?#camera, #camera) return false;
                case (?#microphone, _) return false;
                case _ {};
            };
            var found = false;
            for (candidate in allowed.vals()) if (candidate == feature) found := true;
            if (not found) return false;
            previous := ?feature;
        };
        true;
    };

    func validRequestId(value : Text) : Bool {
        if (value.size() != 32) return false;
        for (char in value.chars()) {
            if (not ((char >= '0' and char <= '9') or (char >= 'a' and char <= 'f'))) return false;
        };
        true;
    };

    func lowerHex(value : Blob) : Text {
        var result = "";
        for (byte in value.values()) {
            let natural = Nat8.toNat(byte);
            result #= LOWER_HEX[natural / 16] # LOWER_HEX[natural % 16];
        };
        result;
    };
}
