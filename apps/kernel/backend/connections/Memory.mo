import Blob "mo:core/Blob";
import List "mo:core/List";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Scope "../capabilities/Scope";
import CatalogData "CatalogData";
import Types "Types";

module {
    public let MAX_FLOWS : Nat = 128;
    public let MAX_CONNECTIONS_PER_APP : Nat =
        CatalogData.max_connections_per_app;
    public let MAX_CONNECTIONS : Nat = CatalogData.max_connections;

    public func init() : Types.Memory {
        {
            flows = Map.empty<Blob, Types.OAuthFlow>();
            connections = Map.empty<Text, Types.Connection>();
        };
    };

    public func cleanupExpired(mem : Types.Memory, now : Nat64) : () {
        removeFlowsWhere(
            mem,
            func(flow) { flow.expires_at <= now },
        );
    };

    public func hasActiveFlow(
        mem : Types.Memory,
        principal : Principal,
        appScope : Types.AppScope,
        provider : Text,
    ) : Bool {
        for (flow in Map.values(mem.flows)) {
            if (
                Principal.equal(flow.owner_principal, principal) and
                Scope.equal(flow.owner_scope, appScope) and
                flow.provider == provider
            ) return true;
        };
        false;
    };

    public func removePendingFlows(
        mem : Types.Memory,
        principal : Principal,
        appScope : Types.AppScope,
        provider : Text,
    ) : () {
        removeFlowsWhere(
            mem,
            func(flow) {
                Principal.equal(flow.owner_principal, principal) and
                Scope.equal(flow.owner_scope, appScope) and
                flow.provider == provider and
                flow.status == #pending;
            },
        );
    };

    public func addFlow(mem : Types.Memory, flow : Types.OAuthFlow) : Bool {
        if (Map.size(mem.flows) >= MAX_FLOWS) return false;
        Map.add(mem.flows, Blob.compare, flow.flow_id_hash, flow);
        true;
    };

    public func findFlow(mem : Types.Memory, hash : Blob) : ?Types.OAuthFlow {
        Map.get(mem.flows, Blob.compare, hash);
    };

    public func setFlowStatus(
        mem : Types.Memory,
        hash : Blob,
        status : Types.FlowStatus,
    ) : Bool {
        let ?flow = Map.get(mem.flows, Blob.compare, hash) else return false;
        Map.add(mem.flows, Blob.compare, hash, { flow with status });
        true;
    };

    public func removeFlow(mem : Types.Memory, hash : Blob) : () {
        Map.remove(mem.flows, Blob.compare, hash);
    };

    public func takeCurrentExchange(
        mem : Types.Memory,
        hash : Blob,
        expected : Types.OAuthFlow,
        now : Nat64,
    ) : Bool {
        let ?current = Map.get(mem.flows, Blob.compare, hash) else return false;
        if (
            current.status != #exchanging or
            current.expires_at <= now or
            not sameFlow(current, expected)
        ) return false;
        Map.remove(mem.flows, Blob.compare, hash);
        true;
    };

    public func removeAppScope(
        mem : Types.Memory,
        appScope : Types.AppScope,
    ) : () {
        removeFlowsWhere(
            mem,
            func(flow) { Scope.equal(flow.owner_scope, appScope) },
        );
        removeConnectionsWhere(
            mem,
            func(connection) { Scope.equal(connection.owner_scope, appScope) },
        );
    };

    // Lifecycle cleanup is deliberately separate from actor construction.
    // The caller invokes it only after the install journal has promoted the
    // complete target inventory.
    public func removeIncompatible(
        mem : Types.Memory,
        supports : (Types.AppScope, Text, [Text]) -> Bool,
    ) : () {
        removeFlowsWhere(
            mem,
            func(flow) {
                not supports(
                    flow.owner_scope,
                    flow.provider,
                    flow.declaration_scopes,
                )
            },
        );
        removeConnectionsWhere(
            mem,
            func(connection) {
                not supports(
                    connection.owner_scope,
                    connection.provider,
                    connection.declaration_scopes,
                )
            },
        );
    };

    public func putConnection(
        mem : Types.Memory,
        connection : Types.Connection,
    ) : Bool {
        let key = connectionKey(connection.owner_scope, connection.provider);
        if (
            not Map.containsKey(mem.connections, Text.compare, key) and
            Map.size(mem.connections) >= MAX_CONNECTIONS
        ) {
            return false;
        };
        Map.add(mem.connections, Text.compare, key, connection);
        true;
    };

    public func listConnections(
        mem : Types.Memory,
        appScope : Types.AppScope,
        provider : ?Text,
        supports : (Types.AppScope, Text, [Text]) -> Bool,
    ) : [Types.ConnectionSummary] {
        let result = List.empty<Types.ConnectionSummary>();
        for (connection in Map.values(mem.connections)) {
            if (
                Scope.equal(connection.owner_scope, appScope) and
                supports(
                    connection.owner_scope,
                    connection.provider,
                    connection.declaration_scopes,
                ) and
                (switch (provider) {
                    case null true;
                    case (?id) connection.provider == id;
                })
            ) List.add(result, summary(connection));
        };
        List.toArray(result);
    };

    public func findConnection(
        mem : Types.Memory,
        appScope : Types.AppScope,
        provider : Text,
    ) : ?Types.Connection {
        let ?connection = Map.get(
            mem.connections,
            Text.compare,
            connectionKey(appScope, provider),
        ) else {
            return null;
        };
        if (Scope.equal(connection.owner_scope, appScope)) ?connection else null;
    };

    public func removeConnection(
        mem : Types.Memory,
        appScope : Types.AppScope,
        provider : Text,
    ) : ?Types.ConnectionSummary {
        let ?connection = findConnection(mem, appScope, provider) else {
            return null;
        };
        Map.remove(
            mem.connections,
            Text.compare,
            connectionKey(appScope, provider),
        );
        ?summary(connection);
    };

    public func summary(connection : Types.Connection) : Types.ConnectionSummary {
        {
            app_id = connection.owner_scope.app_id;
            installation_uid = connection.owner_scope.installation_uid;
            provider = connection.provider;
            created_at = connection.created_at;
        };
    };

    func removeFlowsWhere(
        mem : Types.Memory,
        predicate : Types.OAuthFlow -> Bool,
    ) : () {
        let ids = List.empty<Blob>();
        for ((id, flow) in Map.entries(mem.flows)) {
            if (predicate(flow)) List.add(ids, id);
        };
        for (id in List.values(ids)) {
            Map.remove(mem.flows, Blob.compare, id);
        };
    };

    func sameFlow(left : Types.OAuthFlow, right : Types.OAuthFlow) : Bool {
        left.flow_id_hash == right.flow_id_hash and
        Principal.equal(left.owner_principal, right.owner_principal) and
        Scope.equal(left.owner_scope, right.owner_scope) and
        left.provider == right.provider and
        left.declaration_scopes == right.declaration_scopes and
        left.pkce_verifier == right.pkce_verifier and
        left.callback_url == right.callback_url and
        left.created_at == right.created_at and
        left.expires_at == right.expires_at;
    };

    func removeConnectionsWhere(
        mem : Types.Memory,
        predicate : Types.Connection -> Bool,
    ) : () {
        let ids = List.empty<Text>();
        for ((id, connection) in Map.entries(mem.connections)) {
            if (predicate(connection)) List.add(ids, id);
        };
        for (id in List.values(ids)) {
            Map.remove(mem.connections, Text.compare, id);
        };
    };

    func connectionKey(appScope : Types.AppScope, provider : Text) : Text {
        // Scope.key already contains a NUL separator and provider ids cannot
        // contain NUL, so this is collision-free without a public connection id.
        Scope.key(appScope) # "\00" # provider;
    };
};
