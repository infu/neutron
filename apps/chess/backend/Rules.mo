import Array "mo:core/Array";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Memory "memory/chess/v1";

module {
    public let MAX_HISTORY : Nat = 1_024;

    public type LegalMove = {
        from : Nat;
        to : Nat;
        promotion : ?Memory.PieceKind;
    };

    type Applied = {
        from : Nat;
        to : Nat;
        position : Memory.Position;
        piece : Memory.Piece;
        placed : Memory.Piece;
        captured : ?Memory.Piece;
        promotion : ?Memory.PieceKind;
        special : Memory.MoveSpecial;
    };

    public func initialPosition() : Memory.Position {
        let board = Array.tabulate<?Memory.Piece>(64, func(index) {
            let rank = index / 8;
            let file = index % 8;
            if (rank == 1) return ?piece(#white, #pawn);
            if (rank == 6) return ?piece(#black, #pawn);
            if (rank == 0 or rank == 7) {
                let color : Memory.Color = if (rank == 0) #white else #black;
                let kind : Memory.PieceKind = switch (file) {
                    case (0 or 7) #rook;
                    case (1 or 6) #knight;
                    case (2 or 5) #bishop;
                    case (3) #queen;
                    case (_) #king;
                };
                return ?piece(color, kind);
            };
            null;
        });
        {
            board;
            turn = #white;
            castling = {
                white_kingside = true;
                white_queenside = true;
                black_kingside = true;
                black_queenside = true;
            };
            en_passant = null;
            halfmove_clock = 0;
            fullmove_number = 1;
        };
    };

    public func newGame(
        tileId : Text,
        gameId : Text,
        mode : Memory.GameMode,
        computerLevel : ?Text,
        localColor : ?Memory.Color,
        waiting : Bool,
    ) : Memory.Game {
        let position = initialPosition();
        {
            tile_id = tileId;
            game_id = gameId;
            mode;
            computer_level = computerLevel;
            local_color = localColor;
            position;
            status = if (waiting) #waiting else #active;
            winner = null;
            draw_offer_by = null;
            revision = 0;
            history = [];
            position_keys = [positionKey(position)];
            remote_canister = null;
            last_remote_exchange_at = null;
        };
    };

    public func makeMove(
        game : Memory.Game,
        fromText : Text,
        toText : Text,
        promotionTextValue : ?Text,
        at : Int,
    ) : { #ok : Memory.Game; #err : Text } {
        switch (game.status) {
            case (#active) {};
            case (#waiting) return #err("The remote player has not joined yet");
            case (#terminal(_)) return #err("The game is already over");
        };
        let ?from = parseSquare(fromText) else return #err("The source square is invalid");
        let ?to = parseSquare(toText) else return #err("The destination square is invalid");
        let promotion : ?Memory.PieceKind = switch (promotionTextValue) {
            case null null;
            case (?value) {
                let ?kind = parsePromotion(value) else {
                    return #err("Promotion must be q, r, b, or n");
                };
                ?kind;
            };
        };
        let applied = switch (attempt(game.position, { from; to; promotion })) {
            case (#err(error)) return #err(error);
            case (#ok(value)) value;
        };

        let nextKey = positionKey(applied.position);
        let nextKeys = appendBounded<Text>(game.position_keys, nextKey, MAX_HISTORY + 1);
        let checked = inCheck(applied.position, applied.position.turn);
        let replies = legalMoves(applied.position);
        let status : Memory.GameStatus = if (replies.size() == 0) {
            if (checked) #terminal(#checkmate) else #terminal(#stalemate);
        } else if (applied.position.halfmove_clock >= 100) {
            #terminal(#draw_fifty_move);
        } else if (keyCount(nextKeys, nextKey) >= 3) {
            #terminal(#draw_threefold);
        } else if (insufficientMaterial(applied.position)) {
            #terminal(#draw_insufficient_material);
        } else {
            #active;
        };
        let winner : ?Memory.Color = switch (status) {
            case (#terminal(#checkmate)) ?game.position.turn;
            case (_) null;
        };
        let notation = san(game.position, applied, status);
        let entry : Memory.MoveHistory = {
            ply = (game.position.fullmove_number - 1) * 2 + (if (game.position.turn == #white) 1 else 2);
            from;
            to;
            piece = applied.piece;
            placed = applied.placed;
            captured = applied.captured;
            promotion = applied.promotion;
            special = applied.special;
            notation;
            at;
            before = game.position;
            before_status = game.status;
            before_winner = game.winner;
            before_draw_offer_by = game.draw_offer_by;
        };
        let nextOffer = switch (game.draw_offer_by) {
            case (?color) {
                if (sameColor(color, game.position.turn)) ?color else null;
            };
            case null null;
        };
        #ok({
            tile_id = game.tile_id;
            game_id = game.game_id;
            mode = game.mode;
            computer_level = game.computer_level;
            local_color = game.local_color;
            position = applied.position;
            status;
            winner;
            draw_offer_by = nextOffer;
            revision = game.revision + 1;
            history = appendBounded<Memory.MoveHistory>(game.history, entry, MAX_HISTORY);
            position_keys = nextKeys;
            remote_canister = game.remote_canister;
            last_remote_exchange_at = game.last_remote_exchange_at;
        });
    };

    func appendBounded<T>(values : [T], value : T, limit : Nat) : [T] {
        if (values.size() < limit) return Array.concat(values, [value]);
        Array.tabulate<T>(limit, func(index) {
            if (index + 1 < limit) values[index + 1] else value;
        });
    };

    public func legalMoves(position : Memory.Position) : [LegalMove] {
        let result = List.empty<LegalMove>();
        var from = 0;
        while (from < 64) {
            switch (position.board[from]) {
                case (?moving) {
                    if (sameColor(moving.color, position.turn)) {
                        var to = 0;
                        while (to < 64) {
                            if (to != from) {
                                let promotes = moving.kind == #pawn and (to / 8 == 0 or to / 8 == 7);
                                if (promotes) {
                                    for (kind in [#queen, #rook, #bishop, #knight].vals()) {
                                        let candidate : LegalMove = { from; to; promotion = ?kind };
                                        switch (attempt(position, candidate)) {
                                            case (#ok(_)) List.add(result, candidate);
                                            case (#err(_)) {};
                                        };
                                    };
                                } else {
                                    let candidate : LegalMove = { from; to; promotion = null };
                                    switch (attempt(position, candidate)) {
                                        case (#ok(_)) List.add(result, candidate);
                                        case (#err(_)) {};
                                    };
                                };
                            };
                            to += 1;
                        };
                    };
                };
                case null {};
            };
            from += 1;
        };
        List.toArray(result);
    };

    public func inCheck(position : Memory.Position, color : Memory.Color) : Bool {
        var king : ?Nat = null;
        var index = 0;
        while (index < 64) {
            switch (position.board[index]) {
                case (?value) {
                    if (sameColor(value.color, color) and value.kind == #king) king := ?index;
                };
                case null {};
            };
            index += 1;
        };
        let ?square = king else return true;
        isSquareAttacked(position, square, opposite(color));
    };

    public func view(
        game : Memory.Game,
        tileId : Text,
        modeOverride : ?Text,
        localColorOverride : ??Memory.Color,
        connectedOverride : ?Bool,
    ) : Memory.GameView {
        let mode = switch (modeOverride) {
            case (?value) value;
            case null modeText(game.mode);
        };
        let localColor : ?Memory.Color = switch (localColorOverride) {
            case (??value) ?value;
            case (?null) null;
            case null game.local_color;
        };
        let connected = switch (connectedOverride) {
            case (?value) value;
            case null switch (game.mode) {
                case (#remote_host) game.remote_canister != null;
                case (_) false;
            };
        };
        let legal : [Memory.LegalMoveView] = switch (game.status) {
            case (#active) Array.map<LegalMove, Memory.LegalMoveView>(legalMoves(game.position), func(move) {
                {
                    from = squareText(move.from);
                    to = squareText(move.to);
                    promotion = optionPromotionText(move.promotion);
                };
            });
            case (_) [];
        };
        {
            tile_id = tileId;
            game_id = game.game_id;
            mode;
            computer_level = game.computer_level;
            revision = game.revision;
            rows = rows(game.position);
            turn = colorText(game.position.turn);
            castling = game.position.castling;
            en_passant = switch (game.position.en_passant) {
                case (?square) ?squareText(square);
                case null null;
            };
            halfmove_clock = game.position.halfmove_clock;
            fullmove_number = game.position.fullmove_number;
            status = statusText(game.status);
            winner = optionColorText(game.winner);
            in_check = inCheck(game.position, game.position.turn);
            draw_offer_by = optionColorText(game.draw_offer_by);
            local_color = optionColorText(localColor);
            remote_connected = connected;
            position_keys = game.position_keys;
            legal_moves = legal;
            history = Array.map<Memory.MoveHistory, Memory.MoveView>(game.history, moveView);
        };
    };

    public func parseSquare(value : Text) : ?Nat {
        if (value.size() != 2) return null;
        var file : ?Nat = null;
        var rank : ?Nat = null;
        var index = 0;
        for (char in value.chars()) {
            if (index == 0) {
                file := switch (char) {
                    case ('a') ?0; case ('b') ?1; case ('c') ?2; case ('d') ?3;
                    case ('e') ?4; case ('f') ?5; case ('g') ?6; case ('h') ?7;
                    case (_) null;
                };
            } else if (index == 1) {
                rank := switch (char) {
                    case ('1') ?0; case ('2') ?1; case ('3') ?2; case ('4') ?3;
                    case ('5') ?4; case ('6') ?5; case ('7') ?6; case ('8') ?7;
                    case (_) null;
                };
            };
            index += 1;
        };
        switch (file, rank) {
            case (?f, ?r) ?(r * 8 + f);
            case (_) null;
        };
    };

    public func squareText(square : Nat) : Text {
        if (square >= 64) return "";
        fileText(square % 8) # Nat.toText(square / 8 + 1);
    };

    public func parseColor(value : Text) : ?Memory.Color {
        if (value == "white") ?#white else if (value == "black") ?#black else null;
    };

    public func colorText(color : Memory.Color) : Text {
        switch (color) { case (#white) "white"; case (#black) "black" };
    };

    public func optionColorText(color : ?Memory.Color) : ?Text {
        switch (color) { case (?value) ?colorText(value); case null null };
    };

    public func opposite(color : Memory.Color) : Memory.Color {
        switch (color) { case (#white) #black; case (#black) #white };
    };

    public func statusText(status : Memory.GameStatus) : Text {
        switch (status) {
            case (#waiting) "waiting";
            case (#active) "active";
            case (#terminal(#checkmate)) "checkmate";
            case (#terminal(#stalemate)) "stalemate";
            case (#terminal(#draw_fifty_move)) "draw_fifty_move";
            case (#terminal(#draw_threefold)) "draw_threefold";
            case (#terminal(#draw_insufficient_material)) "draw_insufficient_material";
            case (#terminal(#resigned)) "resigned";
            case (#terminal(#draw_agreement)) "draw_agreement";
        };
    };

    public func positionKey(position : Memory.Position) : Text {
        var key = "";
        var row = 0;
        while (row < 8) {
            let rank = 7 - row;
            var file = 0;
            while (file < 8) {
                key #= switch (position.board[rank * 8 + file]) {
                    case (?value) pieceCharText(value);
                    case null ".";
                };
                file += 1;
            };
            if (row < 7) key #= "/";
            row += 1;
        };
        key #= if (position.turn == #white) " w " else " b ";
        let castling =
            (if (position.castling.white_kingside) "K" else "") #
            (if (position.castling.white_queenside) "Q" else "") #
            (if (position.castling.black_kingside) "k" else "") #
            (if (position.castling.black_queenside) "q" else "");
        key #= if (castling == "") "-" else castling;
        key #= " ";
        key #= switch (position.en_passant) {
            case (?target) {
                if (hasLegalEnPassant(position, target)) squareText(target) else "-";
            };
            case null "-";
        };
        key;
    };

    func attempt(position : Memory.Position, move : LegalMove) : { #ok : Applied; #err : Text } {
        if (position.board.size() != 64) return #err("The board state is invalid");
        if (move.from >= 64 or move.to >= 64 or move.from == move.to) {
            return #err("The move squares are invalid");
        };
        let ?moving = position.board[move.from] else return #err("There is no piece on the source square");
        if (not sameColor(moving.color, position.turn)) return #err("It is not that piece's turn");
        switch (position.board[move.to]) {
            case (?target) {
                if (sameColor(target.color, moving.color)) return #err("A piece cannot capture a friendly piece");
                if (target.kind == #king) return #err("A king cannot be captured");
            };
            case null {};
        };

        let targetRank = move.to / 8;
        let mustPromote = moving.kind == #pawn and (targetRank == 0 or targetRank == 7);
        if (mustPromote and move.promotion == null) return #err("A promotion piece is required");
        if (not mustPromote and move.promotion != null) return #err("This move is not a promotion");
        switch (move.promotion) {
            case (?#queen or ?#rook or ?#bishop or ?#knight) {};
            case (?_) return #err("The promotion piece is invalid");
            case null {};
        };

        let ff = move.from % 8;
        let fr = move.from / 8;
        let tf = move.to % 8;
        let tr = move.to / 8;
        let df = distance(ff, tf);
        let dr = distance(fr, tr);
        var special : Memory.MoveSpecial = if (mustPromote) #promotion else #normal;
        var captureSquare : ?Nat = if (position.board[move.to] == null) null else ?move.to;
        var rookFrom : ?Nat = null;
        var rookTo : ?Nat = null;
        var geometry = false;

        switch (moving.kind) {
            case (#pawn) {
                let forwardOne = if (moving.color == #white) tr == fr + 1 else fr > 0 and tr + 1 == fr;
                let forwardTwo = if (moving.color == #white) {
                    fr == 1 and tr == 3;
                } else {
                    fr == 6 and tr == 4;
                };
                if (df == 0 and forwardOne and position.board[move.to] == null) {
                    geometry := true;
                } else if (
                    df == 0 and forwardTwo and position.board[move.to] == null and
                    position.board[(move.from + move.to) / 2] == null
                ) {
                    geometry := true;
                } else if (df == 1 and forwardOne) {
                    switch (position.board[move.to]) {
                        case (?_) geometry := true;
                        case null {
                            if (position.en_passant == ?move.to) {
                                let capturedAt = if (moving.color == #white) Nat.sub(move.to, 8) else move.to + 8;
                                switch (position.board[capturedAt]) {
                                    case (?target) {
                                        if (target.kind == #pawn and not sameColor(target.color, moving.color)) {
                                            geometry := true;
                                            captureSquare := ?capturedAt;
                                            special := #en_passant;
                                        };
                                    };
                                    case null {};
                                };
                            };
                        };
                    };
                };
            };
            case (#knight) geometry := (df == 1 and dr == 2) or (df == 2 and dr == 1);
            case (#bishop) geometry := df == dr and df > 0 and pathClear(position, ff, fr, tf, tr);
            case (#rook) geometry := ((df == 0 and dr > 0) or (dr == 0 and df > 0)) and pathClear(position, ff, fr, tf, tr);
            case (#queen) geometry := ((df == dr and df > 0) or (df == 0 and dr > 0) or (dr == 0 and df > 0)) and pathClear(position, ff, fr, tf, tr);
            case (#king) {
                if (df <= 1 and dr <= 1) {
                    geometry := true;
                } else {
                    let castle = castleDetails(position, moving.color, move.from, move.to);
                    switch (castle) {
                        case (?(kingSide, rf, rt)) {
                            geometry := true;
                            special := if (kingSide) #castle_kingside else #castle_queenside;
                            rookFrom := ?rf;
                            rookTo := ?rt;
                        };
                        case null {};
                    };
                };
            };
        };
        if (not geometry) return #err("That piece cannot move to the destination square");

        let captured : ?Memory.Piece = switch (captureSquare) {
            case (?square) position.board[square];
            case null null;
        };
        let placed : Memory.Piece = switch (move.promotion) {
            case (?kind) piece(moving.color, kind);
            case null moving;
        };
        let board = Array.tabulate<?Memory.Piece>(64, func(index) {
            if (index == move.from) return null;
            if (index == move.to) return ?placed;
            switch (captureSquare) { case (?square) { if (index == square) return null }; case null {} };
            switch (rookFrom) { case (?square) { if (index == square) return null }; case null {} };
            switch (rookTo) {
                case (?square) {
                    if (index == square) return ?piece(moving.color, #rook);
                };
                case null {};
            };
            position.board[index];
        });
        let castling = updatedCastling(position.castling, moving, move.from, captured, captureSquare);
        let enPassant : ?Nat = if (moving.kind == #pawn and distance(fr, tr) == 2) {
            ?((move.from + move.to) / 2);
        } else null;
        let next : Memory.Position = {
            board;
            turn = opposite(position.turn);
            castling;
            en_passant = enPassant;
            halfmove_clock = if (moving.kind == #pawn or captured != null) 0 else position.halfmove_clock + 1;
            fullmove_number = if (moving.color == #black) position.fullmove_number + 1 else position.fullmove_number;
        };
        if (inCheck(next, moving.color)) return #err("The move would leave the king in check");
        #ok({
            from = move.from;
            to = move.to;
            position = next;
            piece = moving;
            placed;
            captured;
            promotion = move.promotion;
            special;
        });
    };

    func castleDetails(
        position : Memory.Position,
        color : Memory.Color,
        from : Nat,
        to : Nat,
    ) : ?(Bool, Nat, Nat) {
        let white = color == #white;
        let kingStart = if (white) 4 else 60;
        if (from != kingStart or inCheck(position, color)) return null;
        let kingSide = to == kingStart + 2;
        let queenSide = if (white) to == 2 else to == 58;
        if (not kingSide and not queenSide) return null;
        let right = if (white and kingSide) position.castling.white_kingside
            else if (white) position.castling.white_queenside
            else if (kingSide) position.castling.black_kingside
            else position.castling.black_queenside;
        if (not right) return null;
        let rookFrom = if (kingSide) kingStart + 3 else if (white) 0 else 56;
        let rookTo = if (kingSide) kingStart + 1 else if (white) 3 else 59;
        switch (position.board[rookFrom]) {
            case (?rook) {
                if (rook.kind != #rook or not sameColor(rook.color, color)) return null;
            };
            case null return null;
        };
        if (kingSide) {
            if (position.board[kingStart + 1] != null or position.board[kingStart + 2] != null) return null;
            if (
                not kingStepSafe(position, color, kingStart, kingStart + 1) or
                not kingStepSafe(position, color, kingStart, kingStart + 2)
            ) return null;
        } else {
            if (
                position.board[kingStart - 1] != null or
                position.board[kingStart - 2] != null or
                position.board[kingStart - 3] != null
            ) return null;
            if (
                not kingStepSafe(position, color, kingStart, kingStart - 1) or
                not kingStepSafe(position, color, kingStart, kingStart - 2)
            ) return null;
        };
        ?(kingSide, rookFrom, rookTo);
    };

    func kingStepSafe(
        position : Memory.Position,
        color : Memory.Color,
        from : Nat,
        to : Nat,
    ) : Bool {
        let board = Array.tabulate<?Memory.Piece>(64, func(index) {
            if (index == from) null
            else if (index == to) ?piece(color, #king)
            else position.board[index];
        });
        let stepped : Memory.Position = {
            board;
            turn = position.turn;
            castling = position.castling;
            en_passant = position.en_passant;
            halfmove_clock = position.halfmove_clock;
            fullmove_number = position.fullmove_number;
        };
        not inCheck(stepped, color);
    };

    func updatedCastling(
        current : Memory.Castling,
        moving : Memory.Piece,
        from : Nat,
        captured : ?Memory.Piece,
        captureSquare : ?Nat,
    ) : Memory.Castling {
        var wk = current.white_kingside;
        var wq = current.white_queenside;
        var bk = current.black_kingside;
        var bq = current.black_queenside;
        if (moving.kind == #king) {
            if (moving.color == #white) { wk := false; wq := false } else { bk := false; bq := false };
        } else if (moving.kind == #rook) {
            if (from == 0) wq := false else if (from == 7) wk := false
            else if (from == 56) bq := false else if (from == 63) bk := false;
        };
        switch (captured, captureSquare) {
            case (?target, ?square) {
                if (target.kind == #rook) {
                    if (square == 0) wq := false else if (square == 7) wk := false
                    else if (square == 56) bq := false else if (square == 63) bk := false;
                };
            };
            case (_) {};
        };
        {
            white_kingside = wk;
            white_queenside = wq;
            black_kingside = bk;
            black_queenside = bq;
        };
    };

    func isSquareAttacked(position : Memory.Position, target : Nat, by : Memory.Color) : Bool {
        let tf = target % 8;
        let tr = target / 8;
        var source = 0;
        while (source < 64) {
            switch (position.board[source]) {
                case (?attacker) {
                    if (sameColor(attacker.color, by)) {
                        let sf = source % 8;
                        let sr = source / 8;
                        let df = distance(sf, tf);
                        let dr = distance(sr, tr);
                        let attacks = switch (attacker.kind) {
                            case (#pawn) {
                                df == 1 and (if (by == #white) tr == sr + 1 else sr > 0 and tr + 1 == sr);
                            };
                            case (#knight) (df == 1 and dr == 2) or (df == 2 and dr == 1);
                            case (#bishop) df == dr and df > 0 and pathClear(position, sf, sr, tf, tr);
                            case (#rook) ((df == 0 and dr > 0) or (dr == 0 and df > 0)) and pathClear(position, sf, sr, tf, tr);
                            case (#queen) ((df == dr and df > 0) or (df == 0 and dr > 0) or (dr == 0 and df > 0)) and pathClear(position, sf, sr, tf, tr);
                            case (#king) df <= 1 and dr <= 1 and (df + dr > 0);
                        };
                        if (attacks) return true;
                    };
                };
                case null {};
            };
            source += 1;
        };
        false;
    };

    func pathClear(position : Memory.Position, ff : Nat, fr : Nat, tf : Nat, tr : Nat) : Bool {
        let steps = Nat.max(distance(ff, tf), distance(fr, tr));
        if (steps <= 1) return true;
        var step = 1;
        while (step < steps) {
            let file = if (tf > ff) ff + step else if (tf < ff) Nat.sub(ff, step) else ff;
            let rank = if (tr > fr) fr + step else if (tr < fr) Nat.sub(fr, step) else fr;
            if (position.board[rank * 8 + file] != null) return false;
            step += 1;
        };
        true;
    };

    func hasLegalEnPassant(position : Memory.Position, target : Nat) : Bool {
        if (target >= 64 or position.board[target] != null) return false;
        let targetFile = target % 8;
        let fromRank : Nat = if (position.turn == #white) {
            if (target / 8 == 0) return false else Nat.sub(target / 8, 1);
        } else {
            if (target / 8 >= 7) return false else target / 8 + 1;
        };
        for (file in [if (targetFile > 0) ?Nat.sub(targetFile, 1) else null, if (targetFile < 7) ?(targetFile + 1) else null].vals()) {
            switch (file) {
                case (?value) {
                    let from = fromRank * 8 + value;
                    switch (position.board[from]) {
                        case (?pawn) {
                            if (pawn.kind == #pawn and sameColor(pawn.color, position.turn)) {
                                switch (attempt(position, { from; to = target; promotion = null })) {
                                    case (#ok(applied)) { if (applied.special == #en_passant) return true };
                                    case (#err(_)) {};
                                };
                            };
                        };
                        case null {};
                    };
                };
                case null {};
            };
        };
        false;
    };

    func insufficientMaterial(position : Memory.Position) : Bool {
        var knights = 0;
        var bishops = 0;
        var bishopColor : ?Nat = null;
        var allBishopsSame = true;
        var index = 0;
        while (index < 64) {
            switch (position.board[index]) {
                case (?value) {
                    switch (value.kind) {
                        case (#king) {};
                        case (#knight) knights += 1;
                        case (#bishop) {
                            bishops += 1;
                            let squareColor = ((index % 8) + (index / 8)) % 2;
                            switch (bishopColor) {
                                case (?first) { if (first != squareColor) allBishopsSame := false };
                                case null bishopColor := ?squareColor;
                            };
                        };
                        case (_) return false;
                    };
                };
                case null {};
            };
            index += 1;
        };
        if (knights == 0 and bishops == 0) return true;
        if (bishops == 0 and knights == 1) return true;
        knights == 0 and bishops > 0 and allBishopsSame;
    };

    func san(before : Memory.Position, applied : Applied, status : Memory.GameStatus) : Text {
        switch (applied.special) {
            case (#castle_kingside) return "O-O" # checkSuffix(applied.position, status);
            case (#castle_queenside) return "O-O-O" # checkSuffix(applied.position, status);
            case (_) {};
        };
        let capture = applied.captured != null;
        var result = "";
        if (applied.piece.kind == #pawn) {
            if (capture) result #= fileText(applied.from % 8);
        } else {
            result #= pieceLetter(applied.piece.kind);
            result #= disambiguation(before, applied);
        };
        if (capture) result #= "x";
        result #= squareText(applied.to);
        switch (applied.promotion) {
            case (?kind) result #= "=" # pieceLetter(kind);
            case null {};
        };
        result # checkSuffix(applied.position, status);
    };

    func disambiguation(before : Memory.Position, applied : Applied) : Text {
        if (applied.piece.kind == #king or applied.piece.kind == #pawn) return "";
        var ambiguous = false;
        var sameFileSource = false;
        var sameRankSource = false;
        var from = 0;
        while (from < 64) {
            if (from != applied.from) {
                switch (before.board[from]) {
                    case (?candidatePiece) {
                        if (samePiece(candidatePiece, applied.piece)) {
                            switch (attempt(before, { from; to = applied.to; promotion = null })) {
                                case (#ok(_)) {
                                    ambiguous := true;
                                    if (from % 8 == applied.from % 8) sameFileSource := true;
                                    if (from / 8 == applied.from / 8) sameRankSource := true;
                                };
                                case (#err(_)) {};
                            };
                        };
                    };
                    case null {};
                };
            };
            from += 1;
        };
        if (not ambiguous) return "";
        if (not sameFileSource) return fileText(applied.from % 8);
        if (not sameRankSource) return Nat.toText(applied.from / 8 + 1);
        squareText(applied.from);
    };

    func checkSuffix(after : Memory.Position, status : Memory.GameStatus) : Text {
        switch (status) {
            case (#terminal(#checkmate)) "#";
            case (_) { if (inCheck(after, after.turn)) "+" else "" };
        };
    };

    func rows(position : Memory.Position) : [Text] {
        Array.tabulate<Text>(8, func(row) {
            let rank = Nat.sub(7, row);
            var value = "";
            var file = 0;
            while (file < 8) {
                value #= switch (position.board[rank * 8 + file]) {
                    case (?entry) pieceCharText(entry);
                    case null ".";
                };
                file += 1;
            };
            value;
        });
    };

    func moveView(move : Memory.MoveHistory) : Memory.MoveView {
        {
            ply = move.ply;
            from = squareText(move.from);
            to = squareText(move.to);
            piece = pieceCode(move.piece);
            placed = pieceCode(move.placed);
            captured = switch (move.captured) { case (?value) ?pieceCode(value); case null null };
            promotion = optionPromotionText(move.promotion);
            special = specialText(move.special);
            notation = move.notation;
            at = move.at;
        };
    };

    func modeText(mode : Memory.GameMode) : Text {
        switch (mode) { case (#local) "local"; case (#computer) "computer"; case (#remote_host) "remote_host" };
    };

    func specialText(special : Memory.MoveSpecial) : Text {
        switch (special) {
            case (#normal) "normal";
            case (#castle_kingside) "castle_kingside";
            case (#castle_queenside) "castle_queenside";
            case (#en_passant) "en_passant";
            case (#promotion) "promotion";
        };
    };

    func parsePromotion(value : Text) : ?Memory.PieceKind {
        if (value == "q") ?#queen else if (value == "r") ?#rook
        else if (value == "b") ?#bishop else if (value == "n") ?#knight else null;
    };

    func optionPromotionText(value : ?Memory.PieceKind) : ?Text {
        switch (value) {
            case (?#queen) ?"q";
            case (?#rook) ?"r";
            case (?#bishop) ?"b";
            case (?#knight) ?"n";
            case (_) null;
        };
    };

    func pieceCode(value : Memory.Piece) : Text {
        (if (value.color == #white) "w" else "b") # pieceLetter(value.kind);
    };

    func pieceCharText(value : Memory.Piece) : Text {
        let letter = pieceLetter(value.kind);
        if (value.color == #white) letter else Text.toLower(letter);
    };

    func pieceLetter(kind : Memory.PieceKind) : Text {
        switch (kind) {
            case (#king) "K"; case (#queen) "Q"; case (#rook) "R";
            case (#bishop) "B"; case (#knight) "N"; case (#pawn) "P";
        };
    };

    func fileText(file : Nat) : Text {
        switch (file) {
            case (0) "a"; case (1) "b"; case (2) "c"; case (3) "d";
            case (4) "e"; case (5) "f"; case (6) "g"; case (_) "h";
        };
    };

    func keyCount(keys : [Text], target : Text) : Nat {
        var count = 0;
        for (key in keys.vals()) if (key == target) count += 1;
        count;
    };

    func distance(a : Nat, b : Nat) : Nat { if (a >= b) a - b else b - a };
    func sameColor(a : Memory.Color, b : Memory.Color) : Bool { a == b };
    func samePiece(a : Memory.Piece, b : Memory.Piece) : Bool { a.color == b.color and a.kind == b.kind };
    func piece(color : Memory.Color, kind : Memory.PieceKind) : Memory.Piece { { color; kind } };
};
