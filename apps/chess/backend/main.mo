import Array "mo:core/Array";
import Iter "mo:core/Iter";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import Vector "mo:core/List";
import NeutronCapabilities "mo:neutron-capabilities";
import Memory "memory/chess/v1";
import PublicIngressWire "PublicIngressWire";
import RemoteGameResultWire "RemoteGameResultWire";
import Rules "Rules";

module {
    let MAX_SESSIONS = 64;
    let MAX_HOSTED_GAMES = 32;
    let MAX_TILE_ID = 128;
    let MIN_GAME_ID = 24;
    let MAX_GAME_ID = 128;
    let MAX_REMOTE_LEGAL_MOVES = 256;
    let MAX_REMOTE_HISTORY = 128;
    let MAX_REMOTE_POSITION_KEYS = 1;
    let REMOTE_STATE_INTERVAL = 500_000_000;
    let REMOTE_COMMAND_INTERVAL = 250_000_000;
    let HOST_INVITE_TTL = 2_592_000_000_000_000;
    // This must equal public_ingress.routes[chess_v1:exchange].required_cycles
    // and the backend_calls per-call ceiling.
    let REMOTE_CALL_BASE_CYCLES = 400_000_000;
    let MAX_REVISION = 10_000_000;
    let MAX_CLOCK = 100_000_000;
    let MAX_REMOTE_TIME = 10_000_000_000_000_000_000_000;
    let REMOTE_METHOD = "app_chess__chess_v1_update";
    let REMOTE_ROUTE = "exchange";

    // Keep public wire aliases local to this module. The build-time method
    // schema generator can resolve local aliases but intentionally does not
    // follow types through imported application modules.
    public type CastlingView = {
        white_kingside : Bool;
        white_queenside : Bool;
        black_kingside : Bool;
        black_queenside : Bool;
    };

    public type LegalMoveView = {
        from : Text;
        to : Text;
        promotion : ?Text;
    };

    public type MoveView = {
        ply : Nat;
        from : Text;
        to : Text;
        piece : Text;
        placed : Text;
        captured : ?Text;
        promotion : ?Text;
        special : Text;
        notation : Text;
        at : Int;
    };

    public type GameView = {
        tile_id : Text;
        game_id : Text;
        mode : Text;
        computer_level : ?Text;
        revision : Nat;
        rows : [Text];
        turn : Text;
        castling : CastlingView;
        en_passant : ?Text;
        halfmove_clock : Nat;
        fullmove_number : Nat;
        status : Text;
        winner : ?Text;
        in_check : Bool;
        draw_offer_by : ?Text;
        local_color : ?Text;
        remote_connected : Bool;
        position_keys : [Text];
        legal_moves : [LegalMoveView];
        history : [MoveView];
    };

    public type ChessError = {
        code : Text;
        message : Text;
        expected_revision : ?Nat;
        actual_revision : ?Nat;
    };

    public type GameResult = {
        #ok : GameView;
        #err : ChessError;
    };

    public type GetGameRequest = { tile_id : Text };

    public type CreateGameRequest = {
        tile_id : Text;
        game_id : Text;
        mode : Text;
        computer_level : ?Text;
        local_color : ?Text;
    };

    public type MoveRequest = {
        tile_id : Text;
        from : Text;
        to : Text;
        promotion : ?Text;
        expected_revision : Nat;
        expected_game_id : ?Text;
        local_only : ?Bool;
    };

    public type SyncGameRequest = { tile_id : Text };

    public type RemotePushTargetRequest = { tile_id : Text };

    public type RemotePushTarget = {
        game_id : Text;
        guest : Principal;
        method : Text;
        pending_revision : ?Nat;
    };

    public type JoinGameRequest = {
        tile_id : Text;
        host : Principal;
        game_id : Text;
    };

    public type ActionRequest = {
        tile_id : Text;
        action : Text;
        player_color : ?Text;
        expected_revision : Nat;
    };

    public type UndoRequest = {
        tile_id : Text;
        expected_revision : Nat;
    };

    // Hosts set `state` to push the compact bounded guest view after local
    // mutations. All command requests leave it null.
    public type RemoteExchangeRequest = {
        op : Text;
        game_id : Text;
        from : ?Text;
        to : ?Text;
        promotion : ?Text;
        action : ?Text;
        player_color : ?Text;
        expected_revision : ?Nat;
        state : ?GameView;
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            chess : Memory.Mem;
        };
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.chess;
        let calls = env.capabilities.backend_calls;

        public func /*query*/chess_get_game(request : GetGameRequest) : ?GameView {
            switch (validTileId(request.tile_id)) {
                case (?_) return null;
                case null {};
            };
            switch (viewForTile(request.tile_id)) {
                case (#ok(view)) ?view;
                case (#err(_)) null;
            };
        };

        // Local UI-only discovery for reciprocal owner consent. The peer
        // principal is never placed in the public protocol response.
        public func /*query*/chess_remote_push_target(
            request : RemotePushTargetRequest,
        ) : ?RemotePushTarget {
            switch (validTileId(request.tile_id)) {
                case (?_) return null;
                case null {};
            };
            let ?{ kind = #host(gameId) } = Map.get(mem.sessions, Text.compare, request.tile_id) else {
                return null;
            };
            let ?game = Map.get(mem.hosted_games, Text.compare, gameId) else return null;
            let ?guest = game.remote_canister else return null;
            ?{
                game_id = game.game_id;
                guest;
                method = REMOTE_METHOD;
                pending_revision = Map.get(mem.pending_push, Text.compare, gameId);
            };
        };

        public func /*update*/chess_create_game(request : CreateGameRequest) : GameResult {
            switch (validTileId(request.tile_id)) {
                case (?error) return #err(error);
                case null {};
            };
            switch (validGameSeed(request.game_id)) {
                case (?error) return #err(error);
                case null {};
            };
            let mode : Memory.GameMode = if (request.mode == "local") {
                #local;
            } else if (request.mode == "computer") {
                #computer;
            } else if (request.mode == "remote_host") {
                #remote_host;
            } else {
                return #err(validation("mode must be local, computer, or remote_host"));
            };
            let localColor : ?Memory.Color = switch (request.local_color) {
                case (?value) {
                    let ?color = Rules.parseColor(value) else {
                        return #err(validation("local_color must be white, black, or null"));
                    };
                    ?color;
                };
                case null null;
            };
            switch (mode) {
                case (#local) {
                    if (localColor != null) return #err(validation("local games must use a null local_color"));
                    if (request.computer_level != null) return #err(validation("local games must use a null computer_level"));
                };
                case (#computer) {
                    if (localColor == null) return #err(validation("computer games require local_color"));
                    if (not validComputerLevel(request.computer_level)) {
                        return #err(validation("computer_level must be easy, medium, or hard"));
                    };
                };
                case (#remote_host) {
                    if (localColor == null) return #err(validation("remote host games require local_color"));
                    if (request.computer_level != null) return #err(validation("remote games must use a null computer_level"));
                };
            };
            let old = Map.get(mem.sessions, Text.compare, request.tile_id);
            let gameId = request.game_id # "_" # Nat.toText(mem.next_generation);
            if (gameId.size() > MAX_GAME_ID) {
                return #err(validation("game_id is too long after adding its unique generation"));
            };
            if (mode == #remote_host) {
                switch (Map.get(mem.hosted_games, Text.compare, gameId)) {
                    case (?existing) {
                        if (existing.tile_id != request.tile_id) {
                            return #err(validation("game_id is already in use by another tile"));
                        };
                    };
                    case null {};
                };
                let replacesHosted = switch (old) {
                    case (?( { kind = #host(_); generation = _ } )) true;
                    case (_) false;
                };
                if (not replacesHosted) ensureHostedSlot(gameId);
            };
            ensureSessionSlot(request.tile_id);

            removeOldHost(old);
            let now = Time.now();
            let game = Rules.newGame(
                request.tile_id,
                gameId,
                mode,
                request.computer_level,
                localColor,
                mode == #remote_host,
            );
            switch (mode) {
                case (#remote_host) {
                    Map.add(mem.hosted_games, Text.compare, gameId, game);
                    putNewSession(request.tile_id, #host(gameId), now);
                };
                case (_) putNewSession(request.tile_id, #owned(game), now);
            };
            viewForTile(request.tile_id);
        };

        public func /*update*/chess_move(request : MoveRequest) : async* GameResult {
            switch (validateMoveRequest(request)) {
                case (?error) return #err(error);
                case null {};
            };
            let ?session = Map.get(mem.sessions, Text.compare, request.tile_id) else {
                return #err(notFound("No game exists for this tile"));
            };
            switch (session.kind) {
                case (#owned(game)) {
                    switch (validateMoveBinding(request, game.game_id, game.mode == #local)) {
                        case (?error) return #err(error);
                        case null {};
                    };
                    if (game.revision != request.expected_revision) return #err(conflict(request.expected_revision, game.revision));
                    switch (Rules.makeMove(game, request.from, request.to, request.promotion, Time.now())) {
                        case (#err(message)) #err(validation(message));
                        case (#ok(next)) {
                            Map.add(mem.sessions, Text.compare, request.tile_id, {
                                generation = session.generation;
                                last_active_at = Time.now();
                                kind = #owned(next);
                            });
                            #ok(Rules.view(next, request.tile_id, null, null, null));
                        };
                    };
                };
                case (#host(gameId)) {
                    let ?game = Map.get(mem.hosted_games, Text.compare, gameId) else {
                        return #err(notFound("The hosted game is unavailable"));
                    };
                    switch (validateMoveBinding(request, game.game_id, false)) {
                        case (?error) return #err(error);
                        case null {};
                    };
                    if (game.revision != request.expected_revision) return #err(conflict(request.expected_revision, game.revision));
                    switch (requireHostTurn(game)) {
                        case (?error) return #err(error);
                        case null {};
                    };
                    switch (Rules.makeMove(game, request.from, request.to, request.promotion, Time.now())) {
                        case (#err(message)) #err(validation(message));
                        case (#ok(next)) {
                            await* commitAndPushHost(request.tile_id, gameId, next);
                        };
                    };
                };
                case (#guest(guest)) {
                    switch (validateMoveBinding(request, guest.game_id, false)) {
                        case (?error) return #err(error);
                        case null {};
                    };
                    if (guest.cached.revision != request.expected_revision) {
                        return #err(conflict(request.expected_revision, guest.cached.revision));
                    };
                    if (guest.cached.status != "active") return #err(validation("The game is not active"));
                    if (guest.cached.local_color != ?guest.cached.turn) {
                        return #err(forbidden("It is the remote host's turn"));
                    };
                    let remote = remoteRequest(
                        "move",
                        guest.game_id,
                        ?request.from,
                        ?request.to,
                        request.promotion,
                        null,
                        null,
                        ?request.expected_revision,
                    );
                    await* callAndCache(request.tile_id, session.generation, guest, remote);
                };
            };
        };

        public func /*update*/chess_sync_game(request : SyncGameRequest) : async* GameResult {
            switch (validTileId(request.tile_id)) {
                case (?error) return #err(error);
                case null {};
            };
            let ?session = Map.get(mem.sessions, Text.compare, request.tile_id) else {
                return #err(notFound("No game exists for this tile"));
            };
            switch (session.kind) {
                case (#guest(guest)) {
                    // Explicit recovery remains available, but the UI never
                    // invokes it from its periodic refresh. Normal play is
                    // updated by paid peer pushes.
                    let remote = remoteRequest("state", guest.game_id, null, null, null, null, null, null);
                    await* callAndCache(request.tile_id, session.generation, guest, remote);
                };
                case (#host(gameId)) {
                    let ?game = Map.get(mem.hosted_games, Text.compare, gameId) else {
                        return #err(notFound("The hosted game is unavailable"));
                    };
                    switch (Map.get(mem.pending_push, Text.compare, gameId)) {
                        case null #ok(Rules.view(game, request.tile_id, null, null, null));
                        case (?_) {
                            switch (await* pushHostState(game)) {
                                case (?error) #err(error);
                                case null #ok(Rules.view(game, request.tile_id, null, null, null));
                            };
                        };
                    };
                };
                case (#owned(_)) #err(validation("Only a remote game can be synchronized"));
            };
        };

        public func /*update*/chess_join_game(request : JoinGameRequest) : async* GameResult {
            switch (validTileId(request.tile_id)) {
                case (?error) return #err(error);
                case null {};
            };
            switch (validGameId(request.game_id)) {
                case (?error) return #err(error);
                case null {};
            };
            if (not Principal.isCanister(request.host)) return #err(validation("The invite host is not a canister principal"));
            if (Principal.equal(request.host, calls.canister_principal)) return #err(validation("A Neutron cannot join its own hosted game"));
            let old = Map.get(mem.sessions, Text.compare, request.tile_id);
            let previousGeneration = switch (old) { case (?value) ?value.generation; case null null };
            let remote = remoteRequest("join", request.game_id, null, null, null, null, null, null);
            let result = await* remoteCall(request.host, remote);
            let view = switch (result) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            switch (validateRemoteView(view, request.game_id)) {
                case (?error) return #err(error);
                case null {};
            };
            if (not sameGeneration(request.tile_id, previousGeneration)) {
                return #err(failure("session_changed", "The tile started another game while the join was in flight"));
            };
            removeOtherGuestSessions(request.host, request.game_id, request.tile_id);
            ensureSessionSlot(request.tile_id);
            removeOldHost(old);
            let cached = retile(view, request.tile_id);
            putNewSession(request.tile_id, #guest({
                host = request.host;
                game_id = request.game_id;
                cached;
            }), Time.now());
            #ok(cached);
        };

        public func /*update*/chess_action(request : ActionRequest) : async* GameResult {
            switch (validateActionRequest(request)) {
                case (?error) return #err(error);
                case null {};
            };
            let ?session = Map.get(mem.sessions, Text.compare, request.tile_id) else {
                return #err(notFound("No game exists for this tile"));
            };
            switch (session.kind) {
                case (#owned(game)) {
                    if (game.revision != request.expected_revision) return #err(conflict(request.expected_revision, game.revision));
                    let actingColor = switch (ownerActor(game, request.player_color)) {
                        case (#err(error)) return #err(error);
                        case (#ok(color)) color;
                    };
                    switch (applyAction(game, request.action, actingColor, false)) {
                        case (#err(error)) #err(error);
                        case (#ok(next)) {
                            Map.add(mem.sessions, Text.compare, request.tile_id, {
                                generation = session.generation;
                                last_active_at = Time.now();
                                kind = #owned(next);
                            });
                            #ok(Rules.view(next, request.tile_id, null, null, null));
                        };
                    };
                };
                case (#host(gameId)) {
                    let ?game = Map.get(mem.hosted_games, Text.compare, gameId) else return #err(notFound("The hosted game is unavailable"));
                    if (game.revision != request.expected_revision) return #err(conflict(request.expected_revision, game.revision));
                    let actingColor = switch (ownerActor(game, request.player_color)) {
                        case (#err(error)) return #err(error);
                        case (#ok(color)) color;
                    };
                    switch (applyAction(game, request.action, actingColor, true)) {
                        case (#err(error)) #err(error);
                        case (#ok(next)) {
                            await* commitAndPushHost(request.tile_id, gameId, next);
                        };
                    };
                };
                case (#guest(guest)) {
                    if (guest.cached.revision != request.expected_revision) {
                        return #err(conflict(request.expected_revision, guest.cached.revision));
                    };
                    let expectedActor = guest.cached.local_color;
                    if (request.player_color != null and request.player_color != expectedActor) {
                        return #err(forbidden("player_color must match the guest color"));
                    };
                    let remote = remoteRequest(
                        "action",
                        guest.game_id,
                        null,
                        null,
                        null,
                        ?request.action,
                        expectedActor,
                        ?request.expected_revision,
                    );
                    await* callAndCache(request.tile_id, session.generation, guest, remote);
                };
            };
        };

        public func /*update*/chess_undo(request : UndoRequest) : GameResult {
            switch (validTileId(request.tile_id)) {
                case (?error) return #err(error);
                case null {};
            };
            let ?session = Map.get(mem.sessions, Text.compare, request.tile_id) else return #err(notFound("No game exists for this tile"));
            let #owned(game) = session.kind else return #err(forbidden("Undo is unavailable in remote games"));
            switch (game.status) {
                case (#terminal(#resigned)) return #err(forbidden("A resignation cannot be undone"));
                case (#terminal(#draw_agreement)) return #err(forbidden("An agreed draw cannot be undone"));
                case (_) {};
            };
            if (game.revision != request.expected_revision) return #err(conflict(request.expected_revision, game.revision));
            if (game.history.size() == 0) return #err(validation("There is no move to undo"));
            var next = undoOne(game);
            if (game.mode == #computer) {
                let ?human = game.local_color else return #err(validation("The computer game has no human color"));
                while (next.history.size() > 0 and next.position.turn != human) {
                    next := undoOne(next);
                };
                if (next.position.turn != human) {
                    return #err(validation("There is no completed human turn to undo yet"));
                };
            };
            next := withRevision(next, game.revision + 1);
            Map.add(mem.sessions, Text.compare, request.tile_id, {
                generation = session.generation;
                last_active_at = Time.now();
                kind = #owned(next);
            });
            #ok(Rules.view(next, request.tile_id, null, null, null));
        };

        public func /*update*/chess_remote_exchange_v1(
            request : RemoteExchangeRequest,
            /*caller*/ caller : Principal,
        ) : GameResult {
            switch (validateRemoteRequestBounds(request)) {
                case (?error) return #err(error);
                case null {};
            };
            // The kernel has already proved this is a paid canister call by
            // accepting the route's required cycles. The bound peer principal
            // still authenticates the individual game.
            if (request.op == "push") return acceptRemotePush(request, caller);
            let ?game = Map.get(mem.hosted_games, Text.compare, request.game_id) else {
                return #err(notFound("The hosted game does not exist"));
            };
            let now = Time.now();
            if (game.remote_canister == null and inviteExpired(game, now)) {
                removeHostedGame(game);
                return #err(notFound("The hosted game invite has expired"));
            };
            if (request.op == "join") {
                switch (game.remote_canister) {
                    case (?bound) {
                        if (not Principal.equal(bound, caller)) return #err(forbidden("This game is already joined by another Neutron"));
                        switch (remoteRateLimit(game, now)) {
                            case (?error) return #err(error);
                            case null {};
                        };
                        let stamped = stampRemote(game, now);
                        Map.add(mem.hosted_games, Text.compare, request.game_id, stamped);
                        if (not emptyRemotePayload(request)) return #err(validation("join contains unexpected fields"));
                        touchSession(game.tile_id, now);
                        return #ok(remoteGuestView(stamped));
                    };
                    case null {
                        if (not emptyRemotePayload(request)) return #err(validation("join contains unexpected fields"));
                        if (game.status != #waiting) return #err(validation("The hosted game is not waiting for a player"));
                        let joined : Memory.Game = {
                            tile_id = game.tile_id;
                            game_id = game.game_id;
                            mode = game.mode;
                            computer_level = game.computer_level;
                            local_color = game.local_color;
                            position = game.position;
                            status = #active;
                            winner = null;
                            draw_offer_by = null;
                            revision = game.revision + 1;
                            history = game.history;
                            position_keys = game.position_keys;
                            remote_canister = ?caller;
                            last_remote_exchange_at = ?now;
                        };
                        Map.add(mem.hosted_games, Text.compare, request.game_id, joined);
                        touchSession(game.tile_id, now);
                        return #ok(remoteGuestView(joined));
                    };
                };
            };
            let ?bound = game.remote_canister else return #err(forbidden("The remote player has not joined this game"));
            if (not Principal.equal(bound, caller)) return #err(forbidden("The caller is not this game's remote player"));
            if (request.op == "state") {
                switch (remoteRateLimit(game, now)) {
                    case (?error) return #err(error);
                    case null {};
                };
                let stamped = stampRemote(game, now);
                Map.add(mem.hosted_games, Text.compare, request.game_id, stamped);
                if (not emptyRemotePayload(request)) return #err(validation("state contains unexpected fields"));
                touchSession(game.tile_id, now);
                return #ok(remoteGuestView(stamped));
            };
            switch (admitRemoteCommand(request.game_id, now)) {
                case (?error) return #err(error);
                case null {};
            };
            if (request.op == "move") {
                if (request.action != null or request.player_color != null or request.state != null) {
                    return #err(validation("move contains unexpected fields"));
                };
                let ?from = request.from else return #err(validation("move requires from"));
                let ?to = request.to else return #err(validation("move requires to"));
                let ?expected = request.expected_revision else return #err(validation("move requires expected_revision"));
                if (game.revision != expected) return #err(conflict(expected, game.revision));
                let ?hostColor = game.local_color else return #err(validation("The hosted game has no host color"));
                if (game.position.turn == hostColor) return #err(forbidden("It is the host's turn"));
                switch (Rules.makeMove(game, from, to, request.promotion, now)) {
                    case (#err(message)) return #err(validation(message));
                    case (#ok(moved)) {
                        let stamped = stampRemote(moved, now);
                        Map.add(mem.hosted_games, Text.compare, request.game_id, stamped);
                        touchSession(game.tile_id, now);
                        return #ok(remoteGuestView(stamped));
                    };
                };
            };
            if (request.op == "action") {
                if (
                    request.from != null or request.to != null or
                    request.promotion != null or request.state != null
                ) {
                    return #err(validation("action contains unexpected fields"));
                };
                let ?action = request.action else return #err(validation("action requires an action name"));
                let ?expected = request.expected_revision else return #err(validation("action requires expected_revision"));
                if (game.revision != expected) return #err(conflict(expected, game.revision));
                let ?hostColor = game.local_color else return #err(validation("The hosted game has no host color"));
                let guestColor = Rules.opposite(hostColor);
                switch (request.player_color) {
                    case (?value) {
                        if (Rules.parseColor(value) != ?guestColor) return #err(forbidden("player_color must match the guest color"));
                    };
                    case null {};
                };
                switch (applyAction(game, action, guestColor, true)) {
                    case (#err(error)) return #err(error);
                    case (#ok(changed)) {
                        let stamped = stampRemote(changed, now);
                        Map.add(mem.hosted_games, Text.compare, request.game_id, stamped);
                        touchSession(game.tile_id, now);
                        return #ok(remoteGuestView(stamped));
                    };
                };
            };
            #err(validation("op must be join, state, move, action, or push"));
        };

        func acceptRemotePush(
            request : RemoteExchangeRequest,
            caller : Principal,
        ) : GameResult {
            if (
                request.from != null or request.to != null or
                request.promotion != null or request.action != null or
                request.player_color != null
            ) {
                return #err(validation("push contains unexpected command fields"));
            };
            let ?state = request.state else return #err(validation("push requires state"));
            if (request.expected_revision != ?state.revision) {
                return #err(validation("push revision does not match its state"));
            };
            switch (validateRemoteView(state, request.game_id)) {
                case (?error) return #err(error);
                case null {};
            };
            var match : ?{
                tile_id : Text;
                session : Memory.Session;
                guest : { host : Principal; game_id : Text; cached : GameView };
            } = null;
            for ((tileId, session) in Map.entries(mem.sessions)) {
                switch (session.kind) {
                    case (#guest(guest)) {
                        if (
                            guest.game_id == request.game_id and
                            Principal.equal(guest.host, caller)
                        ) {
                            match := ?{ tile_id = tileId; session; guest };
                        };
                    };
                    case (_) {};
                };
            };
            let ?target = match else {
                return #err(notFound("No guest game is bound to this Chess host"));
            };
            // Duplicate and reordered pushes acknowledge the newest cached
            // revision without rolling it back.
            if (state.revision <= target.guest.cached.revision) {
                return #ok(retile(target.guest.cached, target.tile_id));
            };
            let cached = retile(state, target.tile_id);
            Map.add(mem.sessions, Text.compare, target.tile_id, {
                generation = target.session.generation;
                last_active_at = Time.now();
                kind = #guest({
                    host = target.guest.host;
                    game_id = target.guest.game_id;
                    cached;
                });
            });
            #ok(cached);
        };

        func viewForTile(tileId : Text) : GameResult {
            let ?session = Map.get(mem.sessions, Text.compare, tileId) else return #err(notFound("No game exists for this tile"));
            switch (session.kind) {
                case (#owned(game)) #ok(Rules.view(game, tileId, null, null, null));
                case (#host(gameId)) {
                    switch (Map.get(mem.hosted_games, Text.compare, gameId)) {
                        case (?game) #ok(Rules.view(game, tileId, null, null, null));
                        case null #err(notFound("The hosted game is unavailable"));
                    };
                };
                case (#guest(guest)) #ok(retile(guest.cached, tileId));
            };
        };

        func requireHostTurn(game : Memory.Game) : ?ChessError {
            let ?hostColor = game.local_color else return ?validation("The hosted game has no host color");
            if (game.position.turn != hostColor) ?forbidden("It is the remote player's turn") else null;
        };

        func ownerActor(game : Memory.Game, supplied : ?Text) : { #ok : Memory.Color; #err : ChessError } {
            switch (game.mode) {
                case (#local) {
                    switch (supplied) {
                        case (?value) {
                            switch (Rules.parseColor(value)) {
                                case (?color) #ok(color);
                                case null #err(validation("player_color must be white or black"));
                            };
                        };
                        case null #ok(game.position.turn);
                    };
                };
                case (_) {
                    let ?localColor = game.local_color else return #err(validation("The game has no local color"));
                    switch (supplied) {
                        case (?value) {
                            if (Rules.parseColor(value) != ?localColor) return #err(forbidden("player_color must match local_color"));
                        };
                        case null {};
                    };
                    #ok(localColor);
                };
            };
        };

        func applyAction(
            game : Memory.Game,
            action : Text,
            actingColor : Memory.Color,
            remote : Bool,
        ) : { #ok : Memory.Game; #err : ChessError } {
            switch (game.status) {
                case (#active) {};
                case (_) return #err(validation("The game is not active"));
            };
            if (action == "resign") {
                return #ok(actionGame(game, #terminal(#resigned), ?Rules.opposite(actingColor), null));
            };
            if (not remote) return #err(validation("Draw actions are available only in remote games"));
            if (game.remote_canister == null) return #err(validation("The remote player has not joined"));
            if (action == "offer_draw") {
                if (game.draw_offer_by != null) return #err(validation("A draw offer is already pending"));
                return #ok(actionGame(game, game.status, game.winner, ?actingColor));
            };
            if (action == "accept_draw") {
                switch (game.draw_offer_by) {
                    case (?offering) {
                        if (offering == actingColor) return #err(forbidden("A player cannot accept their own draw offer"));
                    };
                    case null return #err(validation("There is no draw offer to accept"));
                };
                return #ok(actionGame(game, #terminal(#draw_agreement), null, null));
            };
            if (action == "decline_draw") {
                switch (game.draw_offer_by) {
                    case (?offering) {
                        if (offering == actingColor) return #err(forbidden("A player cannot decline their own draw offer"));
                    };
                    case null return #err(validation("There is no draw offer to decline"));
                };
                return #ok(actionGame(game, game.status, game.winner, null));
            };
            #err(validation("action must be resign, offer_draw, accept_draw, or decline_draw"));
        };

        func actionGame(
            game : Memory.Game,
            status : Memory.GameStatus,
            winner : ?Memory.Color,
            offer : ?Memory.Color,
        ) : Memory.Game {
            {
                tile_id = game.tile_id;
                game_id = game.game_id;
                mode = game.mode;
                computer_level = game.computer_level;
                local_color = game.local_color;
                position = game.position;
                status;
                winner;
                draw_offer_by = offer;
                revision = game.revision + 1;
                history = game.history;
                position_keys = game.position_keys;
                remote_canister = game.remote_canister;
                last_remote_exchange_at = game.last_remote_exchange_at;
            };
        };

        func undoOne(game : Memory.Game) : Memory.Game {
            let count = game.history.size();
            let entry = game.history[count - 1];
            {
                tile_id = game.tile_id;
                game_id = game.game_id;
                mode = game.mode;
                computer_level = game.computer_level;
                local_color = game.local_color;
                position = entry.before;
                status = entry.before_status;
                winner = entry.before_winner;
                draw_offer_by = entry.before_draw_offer_by;
                revision = game.revision;
                history = Array.tabulate<Memory.MoveHistory>(count - 1, func(index) { game.history[index] });
                position_keys = Array.tabulate<Text>(game.position_keys.size() - 1, func(index) { game.position_keys[index] });
                remote_canister = game.remote_canister;
                last_remote_exchange_at = game.last_remote_exchange_at;
            };
        };

        func withRevision(game : Memory.Game, revision : Nat) : Memory.Game {
            {
                tile_id = game.tile_id;
                game_id = game.game_id;
                mode = game.mode;
                computer_level = game.computer_level;
                local_color = game.local_color;
                position = game.position;
                status = game.status;
                winner = game.winner;
                draw_offer_by = game.draw_offer_by;
                revision;
                history = game.history;
                position_keys = game.position_keys;
                remote_canister = game.remote_canister;
                last_remote_exchange_at = game.last_remote_exchange_at;
            };
        };

        func stampRemote(game : Memory.Game, now : Int) : Memory.Game {
            {
                tile_id = game.tile_id;
                game_id = game.game_id;
                mode = game.mode;
                computer_level = game.computer_level;
                local_color = game.local_color;
                position = game.position;
                status = game.status;
                winner = game.winner;
                draw_offer_by = game.draw_offer_by;
                revision = game.revision;
                history = game.history;
                position_keys = game.position_keys;
                remote_canister = game.remote_canister;
                last_remote_exchange_at = ?now;
            };
        };

        func remoteGuestView(game : Memory.Game) : GameView {
            let view = switch (game.local_color) {
                case (?hostColor) {
                    Rules.view(game, "", ?"remote_guest", ??Rules.opposite(hostColor), ?true);
                };
                case null Rules.view(game, "", ?"remote_guest", ?null, ?true);
            };
            // The host keeps the full authoritative 1,024-ply history. Peers
            // need only a recent display window and the current repetition key;
            // bounding both keeps every honest response below the route limit.
            {
                tile_id = view.tile_id;
                game_id = view.game_id;
                mode = view.mode;
                computer_level = view.computer_level;
                revision = view.revision;
                rows = view.rows;
                turn = view.turn;
                castling = view.castling;
                en_passant = view.en_passant;
                halfmove_clock = view.halfmove_clock;
                fullmove_number = view.fullmove_number;
                status = view.status;
                winner = view.winner;
                in_check = view.in_check;
                draw_offer_by = view.draw_offer_by;
                local_color = view.local_color;
                remote_connected = view.remote_connected;
                position_keys = suffix<Text>(view.position_keys, MAX_REMOTE_POSITION_KEYS);
                legal_moves = view.legal_moves;
                history = suffix<MoveView>(view.history, MAX_REMOTE_HISTORY);
            };
        };

        func suffix<T>(values : [T], limitValue : Nat) : [T] {
            let count = values.size();
            let kept = Nat.min(count, limitValue);
            let start = Nat.sub(count, kept);
            Array.tabulate<T>(kept, func(index) { values[start + index] });
        };

        func remoteRequest(
            op : Text,
            gameId : Text,
            from : ?Text,
            to : ?Text,
            promotion : ?Text,
            action : ?Text,
            actorColor : ?Text,
            expected : ?Nat,
        ) : RemoteExchangeRequest {
            {
                op;
                game_id = gameId;
                from;
                to;
                promotion;
                action;
                player_color = actorColor;
                expected_revision = expected;
                state = null;
            };
        };

        func remotePushRequest(game : Memory.Game) : RemoteExchangeRequest {
            {
                op = "push";
                game_id = game.game_id;
                from = null;
                to = null;
                promotion = null;
                action = null;
                player_color = null;
                expected_revision = ?game.revision;
                state = ?remoteGuestView(game);
            };
        };

        func remoteCall(host : Principal, request : RemoteExchangeRequest) : async* GameResult {
            let ingressRequest : NeutronCapabilities.PublicIngressRequestV1 = {
                method = REMOTE_ROUTE;
                payload = to_candid (request);
            };
            switch (await* calls.call({
                canister = host;
                method = REMOTE_METHOD;
                args = to_candid (ingressRequest);
                cycles = REMOTE_CALL_BASE_CYCLES;
            })) {
                case (#err(error)) #err({
                    code = boundedText(error.code, 64);
                    message = boundedText(error.message, 512);
                    expected_revision = null;
                    actual_revision = null;
                });
                case (#ok(reply)) {
                    let inner = switch (PublicIngressWire.unwrapOk(reply, 32_768)) {
                        case (?value) value;
                        case null return #err(failure("remote_ingress", "The host rejected the chess protocol call"));
                    };
                    switch (RemoteGameResultWire.decode(inner)) {
                        case (?#ok(view)) #ok(view);
                        case (?#err(error)) #err(sanitizeRemoteError(error));
                        case null #err(failure("remote_decode", "The host returned an invalid chess response"));
                    };
                };
            };
        };

        func markPushPending(game : Memory.Game) : () {
            switch (game.remote_canister) {
                case (?_) Map.add(mem.pending_push, Text.compare, game.game_id, game.revision);
                case null Map.remove(mem.pending_push, Text.compare, game.game_id);
            };
        };

        func clearAcknowledgedPush(gameId : Text, revision : Nat) : () {
            switch (Map.get(mem.pending_push, Text.compare, gameId)) {
                case (?pending) {
                    if (pending <= revision) Map.remove(mem.pending_push, Text.compare, gameId);
                };
                case null {};
            };
        };

        func pushHostState(game : Memory.Game) : async* ?ChessError {
            let ?guest = game.remote_canister else {
                Map.remove(mem.pending_push, Text.compare, game.game_id);
                return null;
            };
            if (not calls.can_call(guest, REMOTE_METHOD)) {
                return ?failure(
                    "remote_push",
                    "The Chess change is waiting for owner-approved access to the guest Neutron",
                );
            };
            let result = await* remoteCall(guest, remotePushRequest(game));
            let acknowledgement = switch (result) {
                case (#err(error)) {
                    return ?failure(
                        "remote_push",
                        "The Chess change was saved, but its paid peer push failed: " #
                        boundedText(error.message, 384),
                    );
                };
                case (#ok(view)) view;
            };
            switch (validateRemoteView(acknowledgement, game.game_id)) {
                case (?_) {
                    return ?failure(
                        "remote_push",
                        "The Chess change was saved, but the peer returned an invalid push acknowledgement",
                    );
                };
                case null {};
            };
            if (acknowledgement.revision < game.revision) {
                return ?failure(
                    "remote_push",
                    "The Chess change was saved, but the peer did not acknowledge its revision",
                );
            };
            clearAcknowledgedPush(game.game_id, game.revision);
            null;
        };

        func commitAndPushHost(
            tileId : Text,
            gameId : Text,
            next : Memory.Game,
        ) : async* GameResult {
            // Commit before yielding. A concurrent peer command can then only
            // conflict with this revision, never create a different state with
            // the same revision while the push is in flight.
            Map.add(mem.hosted_games, Text.compare, gameId, next);
            touchSession(tileId, Time.now());
            markPushPending(next);
            // A missing/failed reciprocal grant must not report the committed
            // move as failed. The durable pending revision is retried after
            // owner-approved access is present.
            ignore await* pushHostState(next);
            #ok(Rules.view(next, tileId, null, null, null));
        };

        func callAndCache(
            tileId : Text,
            generation : Nat,
            guest : { host : Principal; game_id : Text; cached : GameView },
            request : RemoteExchangeRequest,
        ) : async* GameResult {
            let result = await* remoteCall(guest.host, request);
            let view = switch (result) {
                case (#err(error)) {
                    if (error.code == "not_found") {
                        removeGuestIfCurrent(tileId, generation, guest.host, guest.game_id);
                    };
                    return #err(sanitizeRemoteError(error));
                };
                case (#ok(value)) value;
            };
            switch (validateRemoteView(view, guest.game_id)) {
                case (?error) return #err(error);
                case null {};
            };
            let ?current = Map.get(mem.sessions, Text.compare, tileId) else {
                return #err(failure("session_changed", "The tile game changed while the remote call was in flight"));
            };
            let #guest(currentGuest) = current.kind else {
                return #err(failure("session_changed", "The tile game changed while the remote call was in flight"));
            };
            if (
                current.generation != generation or
                not Principal.equal(currentGuest.host, guest.host) or
                currentGuest.game_id != guest.game_id
            ) {
                return #err(failure("session_changed", "The tile game changed while the remote call was in flight"));
            };
            if (view.revision < currentGuest.cached.revision) {
                return #err(failure("stale_remote", "The host returned an older game revision"));
            };
            let cached = retile(view, tileId);
            Map.add(mem.sessions, Text.compare, tileId, {
                generation;
                last_active_at = Time.now();
                kind = #guest({ host = guest.host; game_id = guest.game_id; cached });
            });
            #ok(cached);
        };

        func validateRemoteView(view : GameView, gameId : Text) : ?ChessError {
            if (view.game_id != gameId or view.game_id.size() > MAX_GAME_ID) return ?failure("invalid_remote", "The host returned the wrong game_id");
            if (view.mode != "remote_guest") return ?failure("invalid_remote", "The host returned the wrong game mode");
            if (view.computer_level != null) return ?failure("invalid_remote", "A remote game returned computer settings");
            if (view.tile_id.size() > MAX_TILE_ID) return ?failure("invalid_remote", "The remote tile_id is too long");
            if (view.rows.size() != 8) return ?failure("invalid_remote", "The host returned an invalid board");
            var whiteKings = 0;
            var blackKings = 0;
            for (row in view.rows.vals()) {
                if (row.size() != 8) return ?failure("invalid_remote", "The host returned an invalid board row");
                for (char in row.chars()) {
                    if (not validBoardChar(char)) return ?failure("invalid_remote", "The host returned an invalid board piece");
                    if (char == 'K') whiteKings += 1 else if (char == 'k') blackKings += 1;
                };
            };
            if (whiteKings != 1 or blackKings != 1) return ?failure("invalid_remote", "The host returned an invalid king count");
            if (view.turn != "white" and view.turn != "black") return ?failure("invalid_remote", "The host returned an invalid turn");
            if (view.revision > MAX_REVISION or view.halfmove_clock > MAX_CLOCK or view.fullmove_number > MAX_CLOCK) {
                return ?failure("invalid_remote", "The host returned unbounded game counters");
            };
            switch (view.local_color) {
                case (?color) { if (color != "white" and color != "black") return ?failure("invalid_remote", "The host returned an invalid local color") };
                case null return ?failure("invalid_remote", "The host omitted the guest color");
            };
            switch (view.winner) {
                case (?color) { if (color != "white" and color != "black") return ?failure("invalid_remote", "The host returned an invalid winner") };
                case null {};
            };
            switch (view.draw_offer_by) {
                case (?color) { if (color != "white" and color != "black") return ?failure("invalid_remote", "The host returned an invalid draw offer") };
                case null {};
            };
            if (not validStatus(view.status)) return ?failure("invalid_remote", "The host returned an invalid status");
            switch (view.en_passant) { case (?square) { if (Rules.parseSquare(square) == null) return ?failure("invalid_remote", "The host returned invalid en passant state") }; case null {} };
            if (not view.remote_connected) return ?failure("invalid_remote", "The host did not mark the remote game connected");
            if (view.legal_moves.size() > MAX_REMOTE_LEGAL_MOVES) return ?failure("invalid_remote", "The host returned too many legal moves");
            for (move in view.legal_moves.vals()) {
                if (Rules.parseSquare(move.from) == null or Rules.parseSquare(move.to) == null) return ?failure("invalid_remote", "The host returned an invalid legal move");
                if (not validPromotion(move.promotion)) return ?failure("invalid_remote", "The host returned an invalid promotion");
            };
            if (
                view.position_keys.size() < 1 or
                view.position_keys.size() > MAX_REMOTE_POSITION_KEYS
            ) {
                return ?failure("invalid_remote", "The host returned invalid repetition history");
            };
            for (key in view.position_keys.vals()) {
                if (key.size() < 1 or key.size() > 128) {
                    return ?failure("invalid_remote", "The host returned invalid repetition history");
                };
            };
            if (view.history.size() > MAX_REMOTE_HISTORY) {
                return ?failure("invalid_remote", "The host returned too much move history");
            };
            var previousPly : ?Nat = null;
            for (move in view.history.vals()) {
                if (Rules.parseSquare(move.from) == null or Rules.parseSquare(move.to) == null) return ?failure("invalid_remote", "The host returned invalid move history");
                switch (previousPly) {
                    case (?previous) { if (move.ply != previous + 1) return ?failure("invalid_remote", "The host returned invalid move numbering") };
                    case null { if (move.ply < 1) return ?failure("invalid_remote", "The host returned invalid move numbering") };
                };
                if (not validPieceCode(move.piece) or not validPieceCode(move.placed)) return ?failure("invalid_remote", "The host returned invalid piece history");
                switch (move.captured) { case (?piece) { if (not validPieceCode(piece)) return ?failure("invalid_remote", "The host returned invalid capture history") }; case null {} };
                if (not validPromotion(move.promotion) or not validSpecial(move.special) or move.notation.size() > 64) {
                    return ?failure("invalid_remote", "The host returned invalid move history fields");
                };
                if (move.ply > MAX_CLOCK or move.at > MAX_REMOTE_TIME or move.at < -MAX_REMOTE_TIME) {
                    return ?failure("invalid_remote", "The host returned unbounded move history fields");
                };
                previousPly := ?move.ply;
            };
            null;
        };

        func retile(view : GameView, tileId : Text) : GameView {
            {
                tile_id = tileId;
                game_id = view.game_id;
                mode = view.mode;
                computer_level = view.computer_level;
                revision = view.revision;
                rows = view.rows;
                turn = view.turn;
                castling = view.castling;
                en_passant = view.en_passant;
                halfmove_clock = view.halfmove_clock;
                fullmove_number = view.fullmove_number;
                status = view.status;
                winner = view.winner;
                in_check = view.in_check;
                draw_offer_by = view.draw_offer_by;
                local_color = view.local_color;
                remote_connected = view.remote_connected;
                position_keys = view.position_keys;
                legal_moves = view.legal_moves;
                history = view.history;
            };
        };

        func putNewSession(tileId : Text, kind : Memory.SessionKind, now : Int) : () {
            let generation = mem.next_generation;
            mem.next_generation += 1;
            Map.add(mem.sessions, Text.compare, tileId, {
                generation;
                last_active_at = now;
                kind;
            });
        };

        func touchSession(tileId : Text, now : Int) : () {
            switch (Map.get(mem.sessions, Text.compare, tileId)) {
                case (?session) {
                    Map.add(mem.sessions, Text.compare, tileId, {
                        generation = session.generation;
                        last_active_at = now;
                        kind = session.kind;
                    });
                };
                case null {};
            };
        };

        func ensureSessionSlot(tileId : Text) : () {
            if (Map.get(mem.sessions, Text.compare, tileId) != null) return;
            if (Map.size(mem.sessions) < MAX_SESSIONS) return;
            evictOldestSession(null);
        };

        func ensureHostedSlot(gameId : Text) : () {
            if (Map.get(mem.hosted_games, Text.compare, gameId) != null) return;
            if (Map.size(mem.hosted_games) < MAX_HOSTED_GAMES) return;
            var candidate : ?{ tile_id : Text; priority : Nat; at : Int } = null;
            for ((tileId, session) in Map.entries(mem.sessions)) {
                switch (session.kind) {
                    case (#host(_)) {
                        let priority = evictionPriority(session);
                        switch (candidate) {
                            case null candidate := ?{ tile_id = tileId; priority; at = session.last_active_at };
                            case (?current) {
                                if (priority < current.priority or (priority == current.priority and session.last_active_at < current.at)) {
                                    candidate := ?{ tile_id = tileId; priority; at = session.last_active_at };
                                };
                            };
                        };
                    };
                    case (_) {};
                };
            };
            switch (candidate) {
                case (?value) removeSession(value.tile_id);
                case null {
                    label orphan for ((_, game) in Map.entries(mem.hosted_games)) {
                        removeHostedGame(game);
                        break orphan;
                    };
                };
            };
        };

        func evictOldestSession(protectedTile : ?Text) : () {
            var candidate : ?{ tile_id : Text; priority : Nat; at : Int } = null;
            for ((tileId, session) in Map.entries(mem.sessions)) {
                if (protectedTile != ?tileId) {
                    let priority = evictionPriority(session);
                    switch (candidate) {
                        case null candidate := ?{ tile_id = tileId; priority; at = session.last_active_at };
                        case (?current) {
                            if (priority < current.priority or (priority == current.priority and session.last_active_at < current.at)) {
                                candidate := ?{ tile_id = tileId; priority; at = session.last_active_at };
                            };
                        };
                    };
                };
            };
            switch (candidate) { case (?value) removeSession(value.tile_id); case null {} };
        };

        func evictionPriority(session : Memory.Session) : Nat {
            switch (session.kind) {
                case (#owned(game)) switch (game.status) {
                    case (#terminal(_)) 0;
                    case (_) 2;
                };
                case (#guest(guest)) {
                    if (guest.cached.status == "active" or guest.cached.status == "waiting") 3 else 0;
                };
                case (#host(gameId)) switch (Map.get(mem.hosted_games, Text.compare, gameId)) {
                    case null 0;
                    case (?game) switch (game.status) {
                        case (#terminal(_)) 0;
                        case (#waiting) 1;
                        case (#active) 3;
                    };
                };
            };
        };

        func removeSession(tileId : Text) : () {
            let session = Map.get(mem.sessions, Text.compare, tileId);
            removeOldHost(session);
            Map.remove(mem.sessions, Text.compare, tileId);
        };

        func removeHostedGame(game : Memory.Game) : () {
            Map.remove(mem.hosted_games, Text.compare, game.game_id);
            Map.remove(mem.remote_command_at, Text.compare, game.game_id);
            Map.remove(mem.pending_push, Text.compare, game.game_id);
            switch (Map.get(mem.sessions, Text.compare, game.tile_id)) {
                case (?( { kind = #host(gameId) } )) {
                    if (gameId == game.game_id) Map.remove(mem.sessions, Text.compare, game.tile_id);
                };
                case (_) {};
            };
        };

        func inviteExpired(game : Memory.Game, now : Int) : Bool {
            switch (Map.get(mem.sessions, Text.compare, game.tile_id)) {
                case (?( { kind = #host(gameId); last_active_at } )) {
                    gameId != game.game_id or (now >= last_active_at and now - last_active_at > HOST_INVITE_TTL);
                };
                case (_) true;
            };
        };

        func remoteRateLimit(game : Memory.Game, now : Int) : ?ChessError {
            switch (game.last_remote_exchange_at) {
                case (?previous) {
                    if (now >= previous and now - previous < REMOTE_STATE_INTERVAL) {
                        return ?failure("rate_limited", "Remote state was requested too recently");
                    };
                };
                case null {};
            };
            null;
        };

        func admitRemoteCommand(gameId : Text, now : Int) : ?ChessError {
            switch (Map.get(mem.remote_command_at, Text.compare, gameId)) {
                case (?previous) {
                    if (now < previous or now - previous < REMOTE_COMMAND_INTERVAL) {
                        return ?failure("rate_limited", "Remote commands were sent too quickly");
                    };
                };
                case null {};
            };
            Map.add(mem.remote_command_at, Text.compare, gameId, now);
            null;
        };

        func removeOtherGuestSessions(host : Principal, gameId : Text, excludingTile : Text) : () {
            let duplicates = Vector.empty<Text>();
            for ((tileId, session) in Map.entries(mem.sessions)) {
                if (tileId != excludingTile) {
                    switch (session.kind) {
                        case (#guest(guest)) {
                            if (guest.game_id == gameId and Principal.equal(guest.host, host)) {
                                Vector.add(duplicates, tileId);
                            };
                        };
                        case (_) {};
                    };
                };
            };
            for (tileId in Vector.values(duplicates)) Map.remove(mem.sessions, Text.compare, tileId);
        };

        func removeGuestIfCurrent(tileId : Text, generation : Nat, host : Principal, gameId : Text) : () {
            switch (Map.get(mem.sessions, Text.compare, tileId)) {
                case (?( { generation = currentGeneration; kind = #guest(current) } )) {
                    if (
                        currentGeneration == generation and
                        Principal.equal(current.host, host) and
                        current.game_id == gameId
                    ) {
                        Map.remove(mem.sessions, Text.compare, tileId);
                    };
                };
                case (_) {};
            };
        };

        func removeOldHost(session : ?Memory.Session) : () {
            switch (session) {
                case (?( { kind = #host(gameId) } )) {
                    Map.remove(mem.hosted_games, Text.compare, gameId);
                    Map.remove(mem.remote_command_at, Text.compare, gameId);
                    Map.remove(mem.pending_push, Text.compare, gameId);
                };
                case (_) {};
            };
        };

        func sameGeneration(tileId : Text, generation : ?Nat) : Bool {
            switch (Map.get(mem.sessions, Text.compare, tileId), generation) {
                case (null, null) true;
                case (?session, ?expected) session.generation == expected;
                case (_) false;
            };
        };

        func validateMoveRequest(request : MoveRequest) : ?ChessError {
            switch (validTileId(request.tile_id)) { case (?error) return ?error; case null {} };
            switch (request.expected_game_id, request.local_only) {
                case (?gameId, ?true) {
                    switch (validGameId(gameId)) { case (?error) return ?error; case null {} };
                };
                case (null, null) {};
                case (_) {
                    return ?validation("expected_game_id and local_only=true must be supplied together");
                };
            };
            if (Rules.parseSquare(request.from) == null or Rules.parseSquare(request.to) == null) {
                return ?validation("from and to must be algebraic squares such as e2");
            };
            if (not validPromotion(request.promotion)) return ?validation("promotion must be q, r, b, n, or null");
            if (request.expected_revision > MAX_REVISION) return ?validation("expected_revision is too large");
            null;
        };

        func validateMoveBinding(request : MoveRequest, actualGameId : Text, local : Bool) : ?ChessError {
            switch (request.expected_game_id) {
                case (?expected) {
                    if (expected != actualGameId) {
                        return ?failure("game_changed", "The selected Chess tile started a different game");
                    };
                };
                case null {};
            };
            if (request.local_only == ?true and not local) {
                return ?failure("local_mode_required", "Chess agent moves require a Local players game");
            };
            null;
        };

        func validateActionRequest(request : ActionRequest) : ?ChessError {
            switch (validTileId(request.tile_id)) { case (?error) return ?error; case null {} };
            if (request.action.size() < 1 or request.action.size() > 32) return ?validation("action is invalid");
            switch (request.player_color) { case (?acting) { if (acting.size() > 5) return ?validation("player_color is invalid") }; case null {} };
            if (request.expected_revision > MAX_REVISION) return ?validation("expected_revision is too large");
            null;
        };

        func validateRemoteRequestBounds(request : RemoteExchangeRequest) : ?ChessError {
            if (request.op.size() < 1 or request.op.size() > 16) return ?validation("op is invalid");
            switch (validGameId(request.game_id)) { case (?error) return ?error; case null {} };
            switch (request.from) { case (?value) { if (value.size() > 2) return ?validation("from is too long") }; case null {} };
            switch (request.to) { case (?value) { if (value.size() > 2) return ?validation("to is too long") }; case null {} };
            switch (request.promotion) { case (?value) { if (value.size() > 1) return ?validation("promotion is too long") }; case null {} };
            switch (request.action) { case (?value) { if (value.size() > 32) return ?validation("action is too long") }; case null {} };
            switch (request.player_color) { case (?value) { if (value.size() > 5) return ?validation("player_color is too long") }; case null {} };
            switch (request.expected_revision) {
                case (?value) { if (value > MAX_REVISION) return ?validation("expected_revision is too large") };
                case null {};
            };
            null;
        };

        func emptyRemotePayload(request : RemoteExchangeRequest) : Bool {
            request.from == null and request.to == null and request.promotion == null and
            request.action == null and request.player_color == null and
            request.expected_revision == null and request.state == null;
        };

        func validTileId(value : Text) : ?ChessError {
            if (value.size() < 1 or value.size() > MAX_TILE_ID) return ?validation("tile_id must contain 1 to 128 characters");
            for (char in value.chars()) {
                if (char < ' ' or char == '\u{7f}') return ?validation("tile_id contains a control character");
            };
            null;
        };

        func validGameId(value : Text) : ?ChessError {
            if (value.size() < MIN_GAME_ID or value.size() > MAX_GAME_ID) {
                return ?validation("game_id must contain 24 to 128 URL-safe random characters");
            };
            for (char in value.chars()) {
                if (not (
                    (char >= 'a' and char <= 'z') or
                    (char >= 'A' and char <= 'Z') or
                    (char >= '0' and char <= '9') or
                    char == '-' or char == '_'
                )) return ?validation("game_id must use only letters, digits, hyphen, and underscore");
            };
            null;
        };

        func validGameSeed(value : Text) : ?ChessError {
            if (value.size() != 32) {
                return ?validation("new game_id must be a 128-bit lowercase hexadecimal seed");
            };
            for (char in value.chars()) {
                if (not ((char >= '0' and char <= '9') or (char >= 'a' and char <= 'f'))) {
                    return ?validation("new game_id must be a 128-bit lowercase hexadecimal seed");
                };
            };
            null;
        };

        func validComputerLevel(value : ?Text) : Bool {
            value == ?"easy" or value == ?"medium" or value == ?"hard";
        };

        func validPromotion(value : ?Text) : Bool {
            value == null or value == ?"q" or value == ?"r" or value == ?"b" or value == ?"n";
        };

        func validPieceCode(value : Text) : Bool {
            value == "wK" or value == "wQ" or value == "wR" or value == "wB" or value == "wN" or value == "wP" or
            value == "bK" or value == "bQ" or value == "bR" or value == "bB" or value == "bN" or value == "bP";
        };

        func validSpecial(value : Text) : Bool {
            value == "normal" or value == "castle_kingside" or value == "castle_queenside" or
            value == "en_passant" or value == "promotion";
        };

        func validStatus(value : Text) : Bool {
            value == "waiting" or value == "active" or value == "checkmate" or value == "stalemate" or
            value == "draw_fifty_move" or value == "draw_threefold" or value == "draw_insufficient_material" or
            value == "resigned" or value == "draw_agreement";
        };

        func validBoardChar(char : Char) : Bool {
            char == '.' or char == 'K' or char == 'Q' or char == 'R' or char == 'B' or char == 'N' or char == 'P' or
            char == 'k' or char == 'q' or char == 'r' or char == 'b' or char == 'n' or char == 'p';
        };

        func sanitizeRemoteError(error : ChessError) : ChessError {
            {
                code = boundedText(error.code, 64);
                message = boundedText(error.message, 512);
                expected_revision = error.expected_revision;
                actual_revision = error.actual_revision;
            };
        };

        func boundedText(value : Text, limitValue : Nat) : Text {
            if (value.size() <= limitValue) value else Text.fromIter(Iter.take(value.chars(), limitValue));
        };

        func validation(message : Text) : ChessError { failure("validation", message) };
        func forbidden(message : Text) : ChessError { failure("forbidden", message) };
        func notFound(message : Text) : ChessError { failure("not_found", message) };
        func limit(message : Text) : ChessError { failure("limit", message) };
        func failure(code : Text, message : Text) : ChessError {
            { code; message; expected_revision = null; actual_revision = null };
        };
        func conflict(expected : Nat, actual : Nat) : ChessError {
            {
                code = "conflict";
                message = "The game revision changed";
                expected_revision = ?expected;
                actual_revision = ?actual;
            };
        };

    };

    /*---NEUTRON GENERATED BEGIN---*/

public type chess_get_game_Input = (request : GetGameRequest);
public type chess_get_game_Output = ?GameView;

public type chess_remote_push_target_Input = (request : RemotePushTargetRequest,);
public type chess_remote_push_target_Output = ?RemotePushTarget;

public type chess_create_game_Input = (request : CreateGameRequest);
public type chess_create_game_Output = GameResult;

public type chess_move_Input = (request : MoveRequest);
public type chess_move_Output = GameResult;

public type chess_sync_game_Input = (request : SyncGameRequest);
public type chess_sync_game_Output = GameResult;

public type chess_join_game_Input = (request : JoinGameRequest);
public type chess_join_game_Output = GameResult;

public type chess_action_Input = (request : ActionRequest);
public type chess_action_Output = GameResult;

public type chess_undo_Input = (request : UndoRequest);
public type chess_undo_Output = GameResult;

public type chess_remote_exchange_v1_Input = (request : RemoteExchangeRequest);
public type chess_remote_exchange_v1_Output = GameResult;

/*---NEUTRON GENERATED END---*/
}
