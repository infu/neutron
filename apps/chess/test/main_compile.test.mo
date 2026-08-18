import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import NeutronCapabilities "mo:neutron-capabilities";
import Chess "../backend/main";
import Memory "../backend/memory/chess/v1";

let self = Principal.fromBlob(Blob.fromArray([0, 1, 1]));
let memory = Memory.init();
assert (memory.next_generation == 1);

let environment : Chess.AppBackendEnvironment = {
    stable_memory = { chess = memory };
    capabilities = {
        backend_calls = {
            canister_principal = self;
            can_call = func(_canister : Principal, _method : Text) { true };
            call = func(
                _request : NeutronCapabilities.BackendCallRequestV1,
            ) : async* NeutronCapabilities.BackendCallResultV1 {
                #err({ code = "unused"; message = "unused" });
            };
            call_batch = func(
                _requests : [NeutronCapabilities.BackendCallRequestV1],
            ) : async* [NeutronCapabilities.BackendCallResultV1] {
                [];
            };
        };
    };
};

let chess = Chess.Init(environment);
assert (chess.chess_get_game({ tile_id = "compile-fixture" }) == null);
assert (chess.chess_remote_push_target({ tile_id = "compile-fixture" }) == null);

let created = chess.chess_create_game({
    tile_id = "host-tile";
    game_id = "00112233445566778899aabbccddeeff";
    mode = "remote_host";
    computer_level = null;
    local_color = ?"white";
});
let hostedGameId = switch (created) {
    case (#ok(game)) game.game_id;
    case (#err(_)) {
        assert false;
        "";
    };
};
let guest = Principal.fromBlob(Blob.fromArray([0, 2, 1]));
switch (chess.chess_remote_exchange_v1({
    op = "join";
    game_id = hostedGameId;
    from = null;
    to = null;
    promotion = null;
    action = null;
    player_color = null;
    expected_revision = null;
    state = null;
}, guest)) {
    case (#ok(_)) {};
    case (#err(_)) assert false;
};
switch (chess.chess_remote_push_target({ tile_id = "host-tile" })) {
    case (?target) {
        assert (target.game_id == hostedGameId);
        assert (target.guest == guest);
        assert (target.method == "app_chess__chess_v1_update");
        assert (target.pending_revision == null);
    };
    case null assert false;
};

// The archive transition test proves that 0.3.1 -> 0.3.2 is a compiler #keep
// operation. Rebuilding the runtime over the same root must retain the hosted
// game and peer binding instead of calling Memory.init() again.
let restored = Chess.Init(environment);
switch (restored.chess_get_game({ tile_id = "host-tile" })) {
    case (?game) {
        assert (game.game_id == hostedGameId);
        assert (game.mode == "remote_host");
        assert game.remote_connected;
    };
    case null assert false;
};
switch (restored.chess_remote_push_target({ tile_id = "host-tile" })) {
    case (?target) {
        assert (target.game_id == hostedGameId);
        assert (target.guest == guest);
    };
    case null assert false;
};
