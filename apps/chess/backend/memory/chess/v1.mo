// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
import Map "mo:core/Map";

module {
    public type Color = { #white; #black };

    public type PieceKind = {
        #king;
        #queen;
        #rook;
        #bishop;
        #knight;
        #pawn;
    };

    public type Piece = {
        color : Color;
        kind : PieceKind;
    };

    public type Castling = {
        white_kingside : Bool;
        white_queenside : Bool;
        black_kingside : Bool;
        black_queenside : Bool;
    };

    public type Position = {
        board : [?Piece];
        turn : Color;
        castling : Castling;
        en_passant : ?Nat;
        halfmove_clock : Nat;
        fullmove_number : Nat;
    };

    public type MoveSpecial = {
        #normal;
        #castle_kingside;
        #castle_queenside;
        #en_passant;
        #promotion;
    };

    public type TerminalReason = {
        #checkmate;
        #stalemate;
        #draw_fifty_move;
        #draw_threefold;
        #draw_insufficient_material;
        #resigned;
        #draw_agreement;
    };

    public type GameStatus = {
        #waiting;
        #active;
        #terminal : TerminalReason;
    };

    public type GameMode = {
        #local;
        #computer;
        #remote_host;
    };

    public type MoveHistory = {
        ply : Nat;
        from : Nat;
        to : Nat;
        piece : Piece;
        placed : Piece;
        captured : ?Piece;
        promotion : ?PieceKind;
        special : MoveSpecial;
        notation : Text;
        at : Int;
        before : Position;
        before_status : GameStatus;
        before_winner : ?Color;
        before_draw_offer_by : ?Color;
    };

    public type Game = {
        tile_id : Text;
        game_id : Text;
        mode : GameMode;
        computer_level : ?Text;
        local_color : ?Color;
        position : Position;
        status : GameStatus;
        winner : ?Color;
        draw_offer_by : ?Color;
        revision : Nat;
        history : [MoveHistory];
        position_keys : [Text];
        remote_canister : ?Principal;
        last_remote_exchange_at : ?Int;
    };

    // This is also the public and remote wire representation. All enum-like
    // fields deliberately use Text so the kernel JSON bridge remains simple.
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

    public type SessionKind = {
        #owned : Game;
        #host : Text;
        #guest : {
            host : Principal;
            game_id : Text;
            cached : GameView;
        };
    };

    public type Session = {
        generation : Nat;
        last_active_at : Int;
        kind : SessionKind;
    };

    public type Mem = {
        var next_generation : Nat;
        sessions : Map.Map<Text, Session>;
        hosted_games : Map.Map<Text, Game>;
        remote_command_at : Map.Map<Text, Int>;
        // A host writes its newest revision here before yielding to the paid
        // peer push. The entry survives a failed call and is cleared only by
        // an acknowledgement carrying that revision (or newer state).
        pending_push : Map.Map<Text, Nat>;
    };

    public func init() : Mem {
        {
            var next_generation = 1;
            sessions = Map.empty<Text, Session>();
            hosted_games = Map.empty<Text, Game>();
            remote_command_at = Map.empty<Text, Int>();
            pending_push = Map.empty<Text, Nat>();
        };
    };
};
