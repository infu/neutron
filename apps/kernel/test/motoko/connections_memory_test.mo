import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Memory "../../backend/connections/Memory";
import Types "../../backend/connections/Types";
import MemoryV3 "../../backend/memory/kernel/v3";

let _stableSchemaCompatibility :
    MemoryV3.ConnectionsMemory -> Types.Memory =
    func(memory) { memory };

let owner = Principal.fromText("aaaaa-aa");
let appScope : Types.AppScope = {
    app_id = "agent";
    installation_uid = 1;
};
let reinstalledScope : Types.AppScope = {
    app_id = "agent";
    installation_uid = 2;
};
let anotherScope : Types.AppScope = {
    app_id = "another_app";
    installation_uid = 3;
};
let memory = Memory.init();
let flow : Types.OAuthFlow = {
    flow_id_hash = Blob.fromArray([1]);
    owner_principal = owner;
    owner_scope = appScope;
    provider = "openrouter";
    declaration_scopes = [];
    pkce_verifier = "verifier";
    callback_url = "https://example.test/callback";
    created_at = 1;
    expires_at = 2;
    status = #pending;
};
assert (Memory.addFlow(memory, flow));
assert (Map.size(memory.flows) == 1);

let expiredExchange : Types.OAuthFlow = {
    flow with
    flow_id_hash = Blob.fromArray([2]);
    status = #exchanging;
};
assert (Memory.addFlow(memory, expiredExchange));
Memory.cleanupExpired(memory, 3);
assert (Map.size(memory.flows) == 0);

let currentExchange : Types.OAuthFlow = {
    flow with
    flow_id_hash = Blob.fromArray([3]);
    expires_at = 10;
    status = #exchanging;
};
assert (Memory.addFlow(memory, currentExchange));
assert (not Memory.takeCurrentExchange(
    memory,
    currentExchange.flow_id_hash,
    { currentExchange with pkce_verifier = "replacement" },
    3,
));
assert (Map.size(memory.flows) == 1);
assert (Memory.takeCurrentExchange(
    memory,
    currentExchange.flow_id_hash,
    currentExchange,
    3,
));
assert (Map.size(memory.flows) == 0);

func connection(
    scope : Types.AppScope,
    provider : Text,
    scopes : [Text],
    credential : Text,
) : Types.Connection {
    {
        owner_scope = scope;
        provider;
        declaration_scopes = scopes;
        credential;
        created_at = 1;
    };
};

assert (Memory.putConnection(
    memory,
    connection(appScope, "openrouter", [], "secret-one"),
));
assert (Memory.putConnection(
    memory,
    connection(appScope, "openrouter", [], "secret-two"),
));
assert (Map.size(memory.connections) == 1);
let ?activeConnection = Memory.findConnection(
    memory,
    appScope,
    "openrouter",
) else {
    assert false;
    loop {};
};
assert (activeConnection.credential == "secret-two");

assert (Memory.putConnection(
    memory,
    connection(reinstalledScope, "openrouter", [], "reinstalled-secret"),
));
assert (Memory.putConnection(
    memory,
    connection(anotherScope, "openrouter", ["read"], "other-secret"),
));
assert (Map.size(memory.connections) == 3);
let ?reinstalledConnection = Memory.findConnection(
    memory,
    reinstalledScope,
    "openrouter",
) else {
    assert false;
    loop {};
};
assert (reinstalledConnection.credential == "reinstalled-secret");
assert (Memory.findConnection(memory, appScope, "missing") == null);

func supports(
    _scope : Types.AppScope,
    provider : Text,
    scopes : [Text],
) : Bool {
    provider == "openrouter" and scopes == [];
};
assert (Memory.listConnections(memory, appScope, null, supports).size() == 1);
assert (
    Memory.listConnections(memory, reinstalledScope, ?"openrouter", supports).size() ==
    1
);
assert (Memory.listConnections(memory, anotherScope, null, supports).size() == 0);

let ?removed = Memory.removeConnection(memory, appScope, "openrouter") else {
    assert false;
    loop {};
};
assert (removed.provider == "openrouter");
assert (Memory.findConnection(memory, appScope, "openrouter") == null);
assert (Map.size(memory.connections) == 2);

let staleFlow : Types.OAuthFlow = {
    flow with
    flow_id_hash = Blob.fromArray([4]);
    owner_scope = anotherScope;
    declaration_scopes = ["read"];
    expires_at = 10;
};
assert (Memory.addFlow(memory, staleFlow));
Memory.removeIncompatible(memory, supports);
assert (Memory.findFlow(memory, staleFlow.flow_id_hash) == null);
assert (Memory.findConnection(memory, anotherScope, "openrouter") == null);
assert (
    Memory.findConnection(memory, reinstalledScope, "openrouter") != null
);

Memory.removeAppScope(memory, reinstalledScope);
assert (Map.size(memory.connections) == 0);
