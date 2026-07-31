import Error "mo:core/Error";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Set "mo:core/Set";
import Text "mo:core/Text";
import Time "mo:core/Time";
import AppUsageTypes "../app_usage/Types";
import Codec "Codec";
import Crypto "Crypto";
import Memory "Memory";
import Scope "../capabilities/Scope";
import CapabilityTypes "../capabilities/Types";
import GatewayAuthority "../http_routes/GatewayAuthority";
import Types "Types";
import ProviderRegistry "providers/Registry";

module {
    let FLOW_TTL_NANOS : Nat64 = 600_000_000_000;
    let LEASE_REVOKED = "Connection capability lease was revoked";

    public func withinConnectionCapacity(next : [Types.AppDeclaration]) : Bool {
        var declaredConnections : Nat = 0;
        for (app in next.vals()) {
            switch (app.connections) {
                case null {};
                case (?declaration) {
                    declaredConnections += declaration.providers.size();
                    if (declaredConnections > Memory.MAX_CONNECTIONS) {
                        return false;
                    };
                };
            };
        };
        true;
    };

    public class Service(
        mem : Types.Memory,
        committedScope : Text -> ?Types.AppScope,
        scopeActive : Types.AppScope -> Bool,
        registry : CapabilityTypes.RuntimeRegistry,
        outgoingCycles : AppUsageTypes.OutgoingCycleAccounting,
    ) {
        let declarations = Map.empty<Text, Types.Declaration>();
        let appIds = Set.empty<Text>();
        var configured = false;

        // Actor construction records authority but never mutates durable
        // connection state. Lifecycle cleanup is commit-bound below.
        public func configure(next : [Types.AppDeclaration]) : () {
            assert (not configured);
            assert (withinConnectionCapacity(next));
            for (app in next.vals()) {
                validateAppScope(app.app_scope);
                assert (Set.insert(
                    appIds,
                    Text.compare,
                    app.app_scope.app_id,
                ));
                switch (app.connections) {
                    case null {};
                    case (?declaration) {
                        validateDeclaration(declaration);
                        let key = Scope.key(app.app_scope);
                        assert (not Map.containsKey(
                            declarations,
                            Text.compare,
                            key,
                        ));
                        Map.add(
                            declarations,
                            Text.compare,
                            key,
                            declaration,
                        );
                    };
                };
            };
            configured := true;
        };

        // Called only from the successful install-commit message, after the
        // target app-instance inventory has been promoted. An unchanged exact
        // declaration survives; app uninstall, installation replacement, or
        // provider/scope changes erase the old flow and credential.
        public func commitConfiguration(removedScopes : [Types.AppScope]) : () {
            assert (configured);
            for (appScope in removedScopes.vals()) {
                Memory.removeAppScope(mem, appScope);
            };
            Memory.removeIncompatible(mem, supportsDeclaration);
        };

        public func supportsDeclaration(
            appScope : Types.AppScope,
            provider : Text,
            scopes : [Text],
        ) : Bool {
            if (not configured) return false;
            let ?declaration = Map.get(
                declarations,
                Text.compare,
                Scope.key(appScope),
            ) else return false;
            for (candidate in declaration.providers.vals()) {
                if (
                    candidate.provider == provider and
                    candidate.scopes == scopes
                ) return true;
            };
            false;
        };

        public func begin(
            input : Types.BeginConnectionInput,
            caller : Principal,
            self : actor {},
        ) : async* Types.BeginConnectionResult {
            try {
                await* beginInner(input, caller, self);
            } catch (cause) {
                recordForApp(
                    input.app_id,
                    input.provider,
                    "begin",
                    if (Error.message(cause) == LEASE_REVOKED) {
                        #revoked;
                    } else {
                        #denied;
                    },
                );
                throw cause;
            };
        };

        func beginInner(
            input : Types.BeginConnectionInput,
            caller : Principal,
            self : actor {},
        ) : async* Types.BeginConnectionResult {
            let ?appScope = activeScopeFor(input.app_id, caller) else {
                throw Error.reject("App installation is unavailable");
            };
            let ?declaration = providerDeclaration(appScope, input.provider) else {
                throw Error.reject(
                    "Connection is not declared for the active app installation"
                );
            };
            let ?lease = declarationLease(
                appScope,
                input.provider,
                declaration.scopes,
            ) else throw Error.reject(
                "Connection is not declared for the active app installation"
            );
            switch (ProviderRegistry.validateRequest(
                input.provider,
                declaration.scopes,
            )) {
                case (?message) throw Error.reject(message);
                case null {};
            };
            validateCallbackBase(input.callback_base, Principal.fromActor(self));

            let now = nowNanos();
            Memory.cleanupExpired(mem, now);
            Memory.removePendingFlows(mem, caller, appScope, input.provider);
            if (Memory.hasActiveFlow(mem, caller, appScope, input.provider)) {
                throw Error.reject("A connection request is already active");
            };

            let flowId = await* managedRandomToken(appScope);
            if (not leasedDeclarationActive(
                appScope,
                input.provider,
                declaration.scopes,
                lease,
            )) throw Error.reject(LEASE_REVOKED);
            let verifier = await* managedRandomToken(appScope);
            if (not leasedDeclarationActive(
                appScope,
                input.provider,
                declaration.scopes,
                lease,
            )) throw Error.reject(LEASE_REVOKED);
            if (Memory.hasActiveFlow(mem, caller, appScope, input.provider)) {
                throw Error.reject("A connection request is already active");
            };
            let challenge = Crypto.pkceChallenge(verifier);
            let callbackUrl = input.callback_base # "?flow=" # Codec.percentEncode(flowId);
            let expiresAt = now + FLOW_TTL_NANOS;
            let flow : Types.OAuthFlow = {
                flow_id_hash = Crypto.hashText(flowId);
                owner_principal = caller;
                owner_scope = appScope;
                provider = input.provider;
                declaration_scopes = declaration.scopes;
                pkce_verifier = verifier;
                callback_url = callbackUrl;
                created_at = now;
                expires_at = expiresAt;
                status = #pending;
            };
            if (not Memory.addFlow(mem, flow)) {
                throw Error.reject("Too many active connection requests");
            };

            let ?provider = ProviderRegistry.get(input.provider) else {
                throw Error.reject("Unknown connection provider");
            };
            let authorizationUrl = provider.adapter.authorizationUrl(
                callbackUrl,
                challenge,
            );
            record(appScope, input.provider, "begin", #ok);
            {
                flow_id = flowId;
                provider = input.provider;
                authorization_url = authorizationUrl;
                expires_at = expiresAt;
            };
        };

        public func complete(
            input : Types.CompleteConnectionInput,
            caller : Principal,
        ) : async* Types.ConnectionSummary {
            if (input.flow_id.size() < 16 or input.flow_id.size() > 256) {
                throw Error.reject("Invalid connection flow");
            };
            if (input.code.size() < 1 or input.code.size() > 4096) {
                throw Error.reject("Invalid connection authorization code");
            };

            let flowHash = Crypto.hashText(input.flow_id);
            let ?flow = Memory.findFlow(mem, flowHash) else {
                throw Error.reject("Connection flow was not found or was already used");
            };
            if (not Principal.equal(flow.owner_principal, caller)) {
                throw Error.reject("Connection flow owner mismatch");
            };
            let lease = switch (activeFlowLease(flow)) {
                case (?value) value;
                case null {
                    record(
                        flow.owner_scope,
                        flow.provider,
                        "complete",
                        #denied,
                    );
                    throw Error.reject("Connection flow is no longer declared");
                };
            };
            if (flow.status != #pending) {
                throw Error.reject("Connection flow is already being completed");
            };
            if (flow.expires_at <= nowNanos()) {
                Memory.removeFlow(mem, flowHash);
                throw Error.reject("Connection flow expired");
            };
            if (not Memory.setFlowStatus(mem, flowHash, #exchanging)) {
                throw Error.reject("Connection flow is unavailable");
            };

            let credential = try {
                let ?provider = ProviderRegistry.get(flow.provider) else {
                    throw Error.reject("Unknown connection provider");
                };
                let ?cycleReservation = outgoingCycles.reserve(
                    flow.owner_scope,
                    provider.adapter.exchange_cycles,
                    null,
                    1,
                ) else throw Error.reject(LEASE_REVOKED);
                assert (outgoingCycles.commit(cycleReservation));
                let exchangeResult : Types.ExchangeResult = try {
                    await* provider.adapter.exchange(input.code, flow.pkce_verifier);
                } catch (_) {
                    #err({
                        message = "Connection provider request failed";
                        // The adapter may have trapped after dispatch, so its
                        // refund is no longer observable at this boundary.
                        charged_cycles = provider.adapter.exchange_cycles;
                    });
                };
                let chargedCycles = switch (exchangeResult) {
                    case (#ok(value)) value.charged_cycles;
                    case (#err(value)) value.charged_cycles;
                };
                outgoingCycles.finalize(cycleReservation, chargedCycles);
                switch (exchangeResult) {
                    case (#ok(value)) value.credential;
                    case (#err(failure)) throw Error.reject(failure.message);
                };
            } catch (cause) {
                Memory.removeFlow(mem, flowHash);
                let revoked = not activeFlowDeclaration(flow, lease);
                record(
                    flow.owner_scope,
                    flow.provider,
                    "complete",
                    if (revoked) #revoked else #failed,
                );
                if (revoked) {
                    throw Error.reject(
                        "App connection declaration changed during credential exchange"
                    );
                };
                throw Error.reject(safeExchangeFailure(cause));
            };

            if (not activeFlowDeclaration(flow, lease)) {
                Memory.removeFlow(mem, flowHash);
                record(
                    flow.owner_scope,
                    flow.provider,
                    "complete",
                    #revoked,
                );
                throw Error.reject(
                    "App connection declaration changed during credential exchange"
                );
            };

            if (not Memory.takeCurrentExchange(
                mem,
                flowHash,
                flow,
                nowNanos(),
            )) {
                record(
                    flow.owner_scope,
                    flow.provider,
                    "complete",
                    #failed,
                );
                throw Error.reject("Connection flow expired or was replaced");
            };

            let connection : Types.Connection = {
                owner_scope = flow.owner_scope;
                provider = flow.provider;
                declaration_scopes = flow.declaration_scopes;
                credential;
                created_at = nowNanos();
            };
            if (not Memory.putConnection(mem, connection)) {
                record(
                    flow.owner_scope,
                    flow.provider,
                    "complete",
                    #failed,
                );
                throw Error.reject("Connection storage limit reached");
            };
            record(
                flow.owner_scope,
                flow.provider,
                "complete",
                #ok,
            );
            Memory.summary(connection);
        };

        func managedRandomToken(
            appScope : Types.AppScope,
        ) : async* Text {
            let ?reservation = outgoingCycles.reserve(
                appScope,
                0,
                null,
                1,
            ) else throw Error.reject(LEASE_REVOKED);
            assert (outgoingCycles.commit(reservation));
            try {
                let token = await* Crypto.randomToken();
                outgoingCycles.finalize(reservation, 0);
                token;
            } catch (cause) {
                outgoingCycles.finalize(reservation, 0);
                throw cause;
            };
        };

        public func list(
            input : Types.ListConnectionsInput,
            caller : Principal,
        ) : [Types.ConnectionSummary] {
            let ?appScope = activeScopeFor(input.app_id, caller) else {
                Runtime.trap("App installation is unavailable");
            };
            switch (input.provider) {
                case (?provider) {
                    if (not declaresProvider(appScope, provider)) {
                        Runtime.trap("Connection provider is not declared");
                    };
                    if (not registry.allowed(
                        appScope,
                        #connections,
                        provider,
                    )) Runtime.trap(
                        "Connection capability is disabled"
                    );
                };
                case null {};
            };
            let result = Memory.listConnections(
                mem,
                appScope,
                input.provider,
                supportsRuntimeDeclaration,
            );
            result;
        };

        public func acquire(
            input : Types.ConnectionInput,
            caller : Principal,
        ) : async* Types.SensitiveCredential {
            try {
                await* acquireInner(input, caller);
            } catch (cause) {
                recordConnectionInput(input, "acquire", #denied);
                throw cause;
            };
        };

        func acquireInner(
            input : Types.ConnectionInput,
            caller : Principal,
        ) : async* Types.SensitiveCredential {
            let ?appScope = activeScopeFor(input.app_id, caller) else {
                throw Error.reject("App installation is unavailable");
            };
            let ?connection = Memory.findConnection(
                mem,
                appScope,
                input.provider,
            ) else throw Error.reject("Connection was not found");
            if (not supportsConnection(connection)) {
                throw Error.reject("Connection is no longer declared");
            };
            let ?lease = registry.lease(
                appScope,
                #connections,
                connection.provider,
            ) else {
                throw Error.reject("Connection capability is disabled");
            };
            if (not lease.active()) {
                throw Error.reject("Connection capability is disabled");
            };
            if (connection.credential.size() == 0) {
                throw Error.reject("Connection credential is unavailable");
            };
            record(
                appScope,
                connection.provider,
                "acquire",
                #ok,
            );
            {
                provider = connection.provider;
                credential = connection.credential;
            };
        };

        public func disconnect(
            input : Types.ConnectionInput,
            caller : Principal,
        ) : async* Types.ConnectionSummary {
            try {
                await* disconnectInner(input, caller);
            } catch (cause) {
                recordConnectionInput(input, "disconnect", #denied);
                throw cause;
            };
        };

        func disconnectInner(
            input : Types.ConnectionInput,
            caller : Principal,
        ) : async* Types.ConnectionSummary {
            let ?appScope = activeScopeFor(input.app_id, caller) else {
                throw Error.reject("App installation is unavailable");
            };
            let ?connection = Memory.findConnection(
                mem,
                appScope,
                input.provider,
            ) else throw Error.reject("Connection was not found");
            if (not supportsConnection(connection)) {
                throw Error.reject("Connection is no longer declared");
            };
            let ?summary = Memory.removeConnection(
                mem,
                appScope,
                input.provider,
            ) else throw Error.reject("Connection was not found");
            record(
                appScope,
                summary.provider,
                "disconnect",
                #ok,
            );
            summary;
        };

        func record(
            appScope : Types.AppScope,
            provider : Text,
            operation : Text,
            capabilityOutcome : CapabilityTypes.CapabilityOutcome,
        ) : () {
            ignore registry.record(
                appScope,
                #connections,
                provider,
                operation,
                capabilityOutcome,
            );
        };

        func activeScopeFor(
            appId : Text,
            caller : Principal,
        ) : ?Types.AppScope {
            validateIdentity(appId, caller);
            let ?appScope = committedScope(appId) else return null;
            if (not scopeActive(appScope)) return null;
            ?appScope;
        };

        func declarationLease(
            appScope : Types.AppScope,
            provider : Text,
            scopes : [Text],
        ) : ?CapabilityTypes.RuntimeLease {
            if (
                not scopeActive(appScope) or
                not supportsDeclaration(appScope, provider, scopes)
            ) return null;
            registry.lease(
                appScope,
                #connections,
                provider,
            );
        };

        func leasedDeclarationActive(
            appScope : Types.AppScope,
            provider : Text,
            scopes : [Text],
            lease : CapabilityTypes.RuntimeLease,
        ) : Bool {
            scopeActive(appScope) and
            supportsDeclaration(appScope, provider, scopes) and
            lease.active();
        };

        func activeFlowDeclaration(
            flow : Types.OAuthFlow,
            lease : CapabilityTypes.RuntimeLease,
        ) : Bool {
            scopeActive(flow.owner_scope) and supportsDeclaration(
                flow.owner_scope,
                flow.provider,
                flow.declaration_scopes,
            ) and lease.active();
        };

        func activeFlowLease(
            flow : Types.OAuthFlow,
        ) : ?CapabilityTypes.RuntimeLease {
            if (
                not scopeActive(flow.owner_scope) or
                not supportsDeclaration(
                    flow.owner_scope,
                    flow.provider,
                    flow.declaration_scopes,
                )
            ) return null;
            registry.lease(
                flow.owner_scope,
                #connections,
                flow.provider,
            );
        };

        func supportsConnection(connection : Types.Connection) : Bool {
            supportsDeclaration(
                connection.owner_scope,
                connection.provider,
                connection.declaration_scopes,
            );
        };

        func supportsRuntimeDeclaration(
            appScope : Types.AppScope,
            provider : Text,
            scopes : [Text],
        ) : Bool {
            supportsDeclaration(appScope, provider, scopes) and
            registry.allowed(appScope, #connections, provider);
        };

        func recordForApp(
            appId : Text,
            provider : Text,
            operation : Text,
            outcome : CapabilityTypes.CapabilityOutcome,
        ) : () {
            let ?appScope = committedScope(appId) else return;
            ignore registry.record(
                appScope,
                #connections,
                provider,
                operation,
                outcome,
            );
        };

        func recordConnectionInput(
            input : Types.ConnectionInput,
            operation : Text,
            outcome : CapabilityTypes.CapabilityOutcome,
        ) : () {
            let ?appScope = committedScope(input.app_id) else return;
            if (not declaresProvider(appScope, input.provider)) return;
            ignore registry.record(
                appScope,
                #connections,
                input.provider,
                operation,
                outcome,
            );
        };

        func declaresProvider(appScope : Types.AppScope, provider : Text) : Bool {
            providerDeclaration(appScope, provider) != null;
        };

        func providerDeclaration(
            appScope : Types.AppScope,
            provider : Text,
        ) : ?Types.ProviderDeclaration {
            if (not configured) return null;
            let ?declaration = Map.get(
                declarations,
                Text.compare,
                Scope.key(appScope),
            ) else return null;
            for (candidate in declaration.providers.vals()) {
                if (candidate.provider == provider) return ?candidate;
            };
            null;
        };
    };

    func validateAppScope(appScope : Types.AppScope) : () {
        assert (Scope.valid(appScope));
    };

    func validateDeclaration(declaration : Types.Declaration) : () {
        assert (
            declaration.providers.size() >= 1 and
            declaration.providers.size() <= Memory.MAX_CONNECTIONS_PER_APP
        );
        var previousProvider : ?Text = null;
        for (provider in declaration.providers.vals()) {
            switch (ProviderRegistry.validateRequest(
                provider.provider,
                provider.scopes,
            )) {
                case (?_) assert false;
                case null {};
            };
            switch (previousProvider) {
                case (?previous) {
                    assert (Text.compare(previous, provider.provider) == #less);
                };
                case null {};
            };
            var previousScope : ?Text = null;
            for (scope in provider.scopes.vals()) {
                switch (previousScope) {
                    case (?previous) {
                        assert (Text.compare(previous, scope) == #less);
                    };
                    case null {};
                };
                previousScope := ?scope;
            };
            previousProvider := ?provider.provider;
        };
    };

    func validateIdentity(appId : Text, caller : Principal) : () {
        if (Principal.isAnonymous(caller)) {
            // This is also enforced by the generated kernel authorization wrapper.
            assert false;
        };
        if (not isAppId(appId)) {
            assert false;
        };
    };

    func safeExchangeFailure(cause : Error.Error) : Text {
        let message = Error.message(cause);
        if (
            Text.startsWith(message, #text "Connection provider rejected the credential exchange (HTTP ") or
            message == "Connection provider response is too large" or
            message == "Connection provider returned an invalid content type" or
            message == "Connection provider returned invalid text" or
            message == "Connection provider returned an invalid credential"
        ) {
            return message;
        };

        switch (Error.code(cause)) {
            case (#system_fatal) "Connection provider request failed in the network";
            case (#system_transient) "Connection provider request temporarily failed";
            case (#system_unknown) "Connection provider request result is unknown";
            case (#destination_invalid) "Connection provider destination is unavailable";
            case (#canister_reject) "Connection provider request was rejected";
            case (#canister_error) "Connection provider request failed";
            case (#call_error(_)) "Connection provider request could not be sent";
            case (#future(_)) "Connection provider request failed";
        };
    };

    func isAppId(appId : Text) : Bool {
        Scope.validAppId(appId);
    };

    func validateCallbackBase(callbackBase : Text, self : Principal) : () {
        let canisterId = Principal.toText(self);
        if (callbackBase.size() > 1024) assert false;
        let (secure, remainder) = switch (
            Text.stripStart(callbackBase, #text "https://"),
            Text.stripStart(callbackBase, #text "http://"),
        ) {
            case (?rest, _) (true, rest);
            case (null, ?rest) (false, rest);
            case _ { assert false; (false, "") };
        };
        let path = Text.split(remainder, #char '/');
        let ?authority = path.next() else { assert false; return };
        let ?first = path.next() else { assert false; return };
        let ?second = path.next() else { assert false; return };
        if (path.next() != null or first != "connections" or second != "callback.html") {
            assert false;
        };
        let ?parsed = GatewayAuthority.parseCanonical(authority) else {
            assert false;
            return;
        };

        // Syntax is shared, but Connections owns this exact callback-origin
        // policy independently of certified routes and provider endpoints.
        if (secure) {
            if (
                parsed.authority != GatewayAuthority.icAuthority(canisterId)
            ) assert false;
        } else {
            if (parsed.hostname != canisterId # ".localhost") assert false;
        };
    };

    func nowNanos() : Nat64 {
        Nat64.fromNat(Int.abs(Time.now()));
    };
};
