import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Text "mo:core/Text";

// Exact, bounded decoder for the V1 Candid GameResult returned inside the
// public-ingress envelope. Raw backend replies are hostile input: decoding
// them with `from_candid` could trap the Chess update. This parser accepts the
// same logical GameResult values emitted by Chess, but only under the frozen
// V1 Candid type table and within the protocol's existing response limits.
module {
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

    let MAX_REPLY_BYTES = 32_768;
    let MAX_ROWS = 8;
    // The frozen decoder remains wire-compatible with captured V1 values;
    // main.mo applies the stricter one-key compact protocol bound.
    let MAX_POSITION_KEYS = 1_025;
    let MAX_LEGAL_MOVES = 256;
    let MAX_HISTORY = 128;
    let MAX_COUNTER = 10_000_000_000_000_000_000_000;

    // Canonical Candid type table and one-argument header for
    // `variant { ok : GameView; err : ChessError }`. Keeping this byte-exact
    // prevents Candid subtyping or a silently changed response schema from
    // crossing the remote trust boundary.
    let PREFIX : Blob =
        "\44\49\44\4c\0b\6b\02\9c\c2\01\03\e5\8e\b4\02\01\6c\04\ad\e2\92\8e\04\71\ec\d5\b6\fa\06\02\c7\eb\c4\d0\09\71\c2\f3\a7\ae\0d\02\6e\7d\6c\14\b2\ce\ef\2f\71\a0\e3\e3\c1\03\05\90\b9\ca\f0\03\7e\8c\af\91\ac\04\71\e3\a6\83\c3\04\71\99\ea\bb\dd\04\0a\fd\d6\97\e8\04\71\bf\c3\d0\94\05\05\fc\e8\c0\ce\05\08\d4\ea\9c\a2\06\06\c8\82\e4\cb\08\71\ae\eb\9e\ac\09\7e\c8\b8\b2\d4\09\7d\b5\b5\e4\f6\09\05\cf\c8\a7\f7\0c\05\db\ff\c6\ff\0c\7d\8a\b1\a5\87\0d\0a\a0\c8\eb\93\0e\05\b5\84\f4\ea\0e\04\d3\fc\fa\cc\0f\7d\6c\04\eb\fb\f4\f3\09\7e\84\ec\9b\92\0e\7e\ae\b0\bd\b0\0e\7e\81\81\ab\d0\0e\7e\6e\71\6d\07\6c\0a\f3\a9\01\7c\fb\ca\01\71\fd\b5\d5\02\7d\c2\e9\f1\9d\02\71\bd\f3\a0\bd\03\71\ea\ca\8a\9e\04\71\a3\8c\83\aa\09\05\9e\ca\92\82\0c\05\ee\b3\d5\94\0c\71\b9\f4\d5\fa\0d\71\6d\09\6c\03\fb\ca\01\71\ea\ca\8a\9e\04\71\a3\8c\83\aa\09\05\6d\71\01\00";

    // Motoko module constants cannot call Blob.size; the test suite asserts
    // this stays equal to the frozen prefix and the live encoder output.
    public let prefixSize : Nat = 276;

    class Reader(bytes : [Nat8], start : Nat) {
        var index = start;

        public func finished() : Bool { index == bytes.size() };

        func byte() : ?Nat8 {
            if (index >= bytes.size()) return null;
            let value = bytes[index];
            index += 1;
            ?value;
        };

        public func nat(maximum : Nat) : ?Nat {
            var value = 0;
            var multiplier = 1;
            var count = 0;
            label decoding loop {
                let ?raw = byte() else return null;
                let valueByte = Nat8.toNat(raw);
                let low = valueByte % 128;
                let increment = low * multiplier;
                if (value > maximum or increment > maximum or value + increment > maximum) return null;
                value += increment;
                count += 1;
                if (valueByte < 128) {
                    // ULEB must be shortest-form; 80 00, 81 00, etc. are not
                    // alternate spellings accepted by this frozen wire.
                    if (count > 1 and low == 0) return null;
                    break decoding;
                };
                // Any further non-zero group would exceed the bound, while an
                // all-zero continuation would be non-canonical.
                if (multiplier > maximum / 128) return null;
                multiplier *= 128;
            };
            ?value;
        };

        public func int(maximumMagnitude : Nat) : ?Int {
            var magnitude = 0;
            var multiplier = 1;
            var count = 0;
            var previous = 0;
            label decoding loop {
                let ?raw = byte() else return null;
                let valueByte = Nat8.toNat(raw);
                let low = valueByte % 128;
                magnitude += low * multiplier;
                count += 1;
                if (valueByte < 128) {
                    if (count > 1) {
                        let previousSign = previous % 128 >= 64;
                        if ((low == 0 and not previousSign) or (low == 127 and previousSign)) return null;
                    };
                    let signed : Int = if (low >= 64) {
                        Nat.toInt(magnitude) - Nat.toInt(multiplier * 128)
                    } else {
                        Nat.toInt(magnitude)
                    };
                    let limit = Nat.toInt(maximumMagnitude);
                    if (signed < -limit or signed > limit) return null;
                    return ?signed;
                };
                if (count >= 12) return null;
                previous := valueByte;
                multiplier *= 128;
            };
            null;
        };

        public func bool() : ?Bool {
            switch (byte()) {
                case (?0) ?false;
                case (?1) ?true;
                case (_) null;
            };
        };

        public func text() : ?Text {
            let ?length = nat(32_768) else return null;
            if (index > bytes.size() or index + length > bytes.size()) return null;
            let value = Array.toBlob(Array.tabulate<Nat8>(length, func(offset) {
                bytes[index + offset]
            }));
            index += length;
            Text.decodeUtf8(value);
        };

        public func option<T>(read : () -> ?T) : ??T {
            switch (nat(1)) {
                case (?0) ?null;
                case (?1) {
                    let ?value = read() else return null;
                    ??value;
                };
                case (_) null;
            };
        };

        public func array<T>(maximum : Nat, read : () -> ?T) : ?[T] {
            let ?length = nat(maximum) else return null;
            let values = List.empty<T>();
            var item = 0;
            while (item < length) {
                let ?value = read() else return null;
                List.add(values, value);
                item += 1;
            };
            ?List.toArray(values);
        };
    };

    func prefixMatches(bytes : [Nat8]) : Bool {
        if (bytes.size() < PREFIX.size() + 1) return false;
        let prefix = Blob.toArray(PREFIX);
        var index = 0;
        while (index < prefix.size()) {
            if (bytes[index] != prefix[index]) return false;
            index += 1;
        };
        true;
    };

    public func decode(reply : Blob) : ?GameResult {
        if (reply.size() > MAX_REPLY_BYTES) return null;
        let bytes = Blob.toArray(reply);
        if (not prefixMatches(bytes)) return null;
        let reader = Reader(bytes, prefixSize);
        let ?tag = reader.nat(1) else return null;
        let result = if (tag == 0) {
            let ?view = gameView(reader) else return null;
            #ok(view);
        } else {
            let ?error = chessError(reader) else return null;
            #err(error);
        };
        if (not reader.finished()) return null;
        ?result;
    };

    // Record values follow ascending Candid field hash order, not source order.
    func gameView(reader : Reader) : ?GameView {
        let ?status = reader.text() else return null;
        let ?enPassant = reader.option<Text>(reader.text) else return null;
        let ?remoteConnected = reader.bool() else return null;
        let ?tileId = reader.text() else return null;
        let ?mode = reader.text() else return null;
        let ?rows = reader.array<Text>(MAX_ROWS, reader.text) else return null;
        let ?turn = reader.text() else return null;
        let ?winner = reader.option<Text>(reader.text) else return null;
        let ?legalMoves = reader.array<LegalMoveView>(MAX_LEGAL_MOVES, func() { legalMove(reader) }) else return null;
        let ?history = reader.array<MoveView>(MAX_HISTORY, func() { move(reader) }) else return null;
        let ?gameId = reader.text() else return null;
        let ?inCheck = reader.bool() else return null;
        let ?fullmoveNumber = reader.nat(MAX_COUNTER) else return null;
        let ?drawOfferBy = reader.option<Text>(reader.text) else return null;
        let ?localColor = reader.option<Text>(reader.text) else return null;
        let ?revision = reader.nat(MAX_COUNTER) else return null;
        let ?positionKeys = reader.array<Text>(MAX_POSITION_KEYS, reader.text) else return null;
        let ?computerLevel = reader.option<Text>(reader.text) else return null;
        let ?castling = castlingView(reader) else return null;
        let ?halfmoveClock = reader.nat(MAX_COUNTER) else return null;
        ?{
            tile_id = tileId;
            game_id = gameId;
            mode;
            computer_level = computerLevel;
            revision;
            rows;
            turn;
            castling;
            en_passant = enPassant;
            halfmove_clock = halfmoveClock;
            fullmove_number = fullmoveNumber;
            status;
            winner;
            in_check = inCheck;
            draw_offer_by = drawOfferBy;
            local_color = localColor;
            remote_connected = remoteConnected;
            position_keys = positionKeys;
            legal_moves = legalMoves;
            history;
        };
    };

    func legalMove(reader : Reader) : ?LegalMoveView {
        let ?to = reader.text() else return null;
        let ?from = reader.text() else return null;
        let ?promotion = reader.option<Text>(reader.text) else return null;
        ?{ from; to; promotion };
    };

    func move(reader : Reader) : ?MoveView {
        let ?at = reader.int(MAX_COUNTER) else return null;
        let ?to = reader.text() else return null;
        let ?ply = reader.nat(MAX_COUNTER) else return null;
        let ?notation = reader.text() else return null;
        let ?placed = reader.text() else return null;
        let ?from = reader.text() else return null;
        let ?promotion = reader.option<Text>(reader.text) else return null;
        let ?captured = reader.option<Text>(reader.text) else return null;
        let ?piece = reader.text() else return null;
        let ?special = reader.text() else return null;
        ?{ ply; from; to; piece; placed; captured; promotion; special; notation; at };
    };

    func castlingView(reader : Reader) : ?CastlingView {
        let ?whiteQueenside = reader.bool() else return null;
        let ?whiteKingside = reader.bool() else return null;
        let ?blackKingside = reader.bool() else return null;
        let ?blackQueenside = reader.bool() else return null;
        ?{
            white_kingside = whiteKingside;
            white_queenside = whiteQueenside;
            black_kingside = blackKingside;
            black_queenside = blackQueenside;
        };
    };

    func chessError(reader : Reader) : ?ChessError {
        let ?code = reader.text() else return null;
        let ?actualRevision = reader.option<Nat>(func() { reader.nat(MAX_COUNTER) }) else return null;
        let ?message = reader.text() else return null;
        let ?expectedRevision = reader.option<Nat>(func() { reader.nat(MAX_COUNTER) }) else return null;
        ?{
            code;
            message;
            expected_revision = expectedRevision;
            actual_revision = actualRevision;
        };
    };
};
