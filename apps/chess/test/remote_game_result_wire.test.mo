import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import RemoteGameResultWire "../backend/RemoteGameResultWire";

type GameResult = RemoteGameResultWire.GameResult;

let frozenPrefix : Blob =
    "\44\49\44\4c\0b\6b\02\9c\c2\01\03\e5\8e\b4\02\01\6c\04\ad\e2\92\8e\04\71\ec\d5\b6\fa\06\02\c7\eb\c4\d0\09\71\c2\f3\a7\ae\0d\02\6e\7d\6c\14\b2\ce\ef\2f\71\a0\e3\e3\c1\03\05\90\b9\ca\f0\03\7e\8c\af\91\ac\04\71\e3\a6\83\c3\04\71\99\ea\bb\dd\04\0a\fd\d6\97\e8\04\71\bf\c3\d0\94\05\05\fc\e8\c0\ce\05\08\d4\ea\9c\a2\06\06\c8\82\e4\cb\08\71\ae\eb\9e\ac\09\7e\c8\b8\b2\d4\09\7d\b5\b5\e4\f6\09\05\cf\c8\a7\f7\0c\05\db\ff\c6\ff\0c\7d\8a\b1\a5\87\0d\0a\a0\c8\eb\93\0e\05\b5\84\f4\ea\0e\04\d3\fc\fa\cc\0f\7d\6c\04\eb\fb\f4\f3\09\7e\84\ec\9b\92\0e\7e\ae\b0\bd\b0\0e\7e\81\81\ab\d0\0e\7e\6e\71\6d\07\6c\0a\f3\a9\01\7c\fb\ca\01\71\fd\b5\d5\02\7d\c2\e9\f1\9d\02\71\bd\f3\a0\bd\03\71\ea\ca\8a\9e\04\71\a3\8c\83\aa\09\05\9e\ca\92\82\0c\05\ee\b3\d5\94\0c\71\b9\f4\d5\fa\0d\71\6d\09\6c\03\fb\ca\01\71\ea\ca\8a\9e\04\71\a3\8c\83\aa\09\05\6d\71\01\00";

// Captured from the live Motoko `to_candid` encoder. The separate WASI test
// re-encodes honest #ok and #err values on every run, so compiler- or
// source-level type drift cannot leave this frozen prefix stale.

func append(first : Blob, second : Blob) : Blob {
    let left = Blob.toArray(first);
    let right = Blob.toArray(second);
    Blob.fromArray(Array.tabulate<Nat8>(left.size() + right.size(), func(index) {
        if (index < left.size()) left[index] else right[index - left.size()]
    }));
};

assert (frozenPrefix.size() == RemoteGameResultWire.prefixSize);

let valid : GameResult = #ok({
    tile_id = "remote:tile";
    game_id = "neutron-game-0123456789";
    mode = "remote_guest";
    computer_level = null;
    revision = 42;
    rows = ["....k...", "........", "........", "........", "........", "........", "........", "....K..."];
    turn = "white";
    castling = {
        white_kingside = true;
        white_queenside = false;
        black_kingside = true;
        black_queenside = false;
    };
    en_passant = ?"e6";
    halfmove_clock = 3;
    fullmove_number = 21;
    status = "active";
    winner = null;
    in_check = false;
    draw_offer_by = ?"black";
    local_color = ?"white";
    remote_connected = true;
    position_keys = ["position-one", "position-two"];
    legal_moves = [
        { from = "e2"; to = "e4"; promotion = null },
        { from = "a7"; to = "a8"; promotion = ?"queen" },
    ];
    history = [{
        ply = 1;
        from = "e2";
        to = "e4";
        piece = "wP";
        placed = "wP";
        captured = ?"bP";
        promotion = null;
        special = "normal";
        notation = "e4";
        at = -123_456_789;
    }];
});

let validBytes = Blob.toArray(append(
    frozenPrefix,
    "\00\06\61\63\74\69\76\65\01\02\65\36\01\0b\72\65\6d\6f\74\65\3a\74\69\6c\65\0c\72\65\6d\6f\74\65\5f\67\75\65\73\74\08\08\2e\2e\2e\2e\6b\2e\2e\2e\08\2e\2e\2e\2e\2e\2e\2e\2e\08\2e\2e\2e\2e\2e\2e\2e\2e\08\2e\2e\2e\2e\2e\2e\2e\2e\08\2e\2e\2e\2e\2e\2e\2e\2e\08\2e\2e\2e\2e\2e\2e\2e\2e\08\2e\2e\2e\2e\2e\2e\2e\2e\08\2e\2e\2e\2e\4b\2e\2e\2e\05\77\68\69\74\65\00\02\02\65\34\02\65\32\00\02\61\38\02\61\37\01\05\71\75\65\65\6e\01\eb\e5\90\45\02\65\34\01\02\65\34\02\77\50\02\65\32\00\01\02\62\50\02\77\50\06\6e\6f\72\6d\61\6c\17\6e\65\75\74\72\6f\6e\2d\67\61\6d\65\2d\30\31\32\33\34\35\36\37\38\39\00\15\01\05\62\6c\61\63\6b\01\05\77\68\69\74\65\2a\02\0c\70\6f\73\69\74\69\6f\6e\2d\6f\6e\65\0c\70\6f\73\69\74\69\6f\6e\2d\74\77\6f\00\00\01\01\00\03",
));
assert (RemoteGameResultWire.decode(Blob.fromArray(validBytes)) == ?valid);

let error : GameResult = #err({
    code = "conflict";
    message = "The game revision changed";
    expected_revision = ?41;
    actual_revision = ?42;
});
assert (RemoteGameResultWire.decode(append(
    frozenPrefix,
    "\01\08\63\6f\6e\66\6c\69\63\74\01\2a\19\54\68\65\20\67\61\6d\65\20\72\65\76\69\73\69\6f\6e\20\63\68\61\6e\67\65\64\01\29",
)) == ?error);

let empty : GameResult = #ok({
    tile_id = "";
    game_id = "";
    mode = "";
    computer_level = null;
    revision = 0;
    rows = [];
    turn = "";
    castling = {
        white_kingside = false;
        white_queenside = false;
        black_kingside = false;
        black_queenside = false;
    };
    en_passant = null;
    halfmove_clock = 0;
    fullmove_number = 0;
    status = "";
    winner = null;
    in_check = false;
    draw_offer_by = null;
    local_color = null;
    remote_connected = false;
    position_keys = [];
    legal_moves = [];
    history = [];
});
let emptyBytes = Blob.toArray(append(
    frozenPrefix,
    "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00",
));
assert (RemoteGameResultWire.decode(Blob.fromArray(emptyBytes)) == ?empty);

// Every type-table/header byte is frozen. No Candid subtype or alternate
// record shape is accepted at the untrusted backend-call boundary.
var prefixIndex = 0;
while (prefixIndex < RemoteGameResultWire.prefixSize) {
    let mutated = Blob.fromArray(Array.tabulate<Nat8>(validBytes.size(), func(index) {
        if (index == prefixIndex) validBytes[index] ^ 0xff else validBytes[index]
    }));
    assert (RemoteGameResultWire.decode(mutated) == null);
    prefixIndex += 1;
};

// Every proper truncation and any trailing data is rejected.
var truncatedSize = 0;
while (truncatedSize < validBytes.size()) {
    let truncated = Blob.fromArray(Array.tabulate<Nat8>(truncatedSize, func(index) { validBytes[index] }));
    assert (RemoteGameResultWire.decode(truncated) == null);
    truncatedSize += 1;
};
let trailing = Blob.fromArray(Array.tabulate<Nat8>(validBytes.size() + 1, func(index) {
    if (index < validBytes.size()) validBytes[index] else 0
}));
assert (RemoteGameResultWire.decode(trailing) == null);

// Mutation sweep: arbitrary one-byte damage is always handled as data, never
// as a trapping decode. Some mutations remain valid values by design.
var mutationIndex = 0;
while (mutationIndex < validBytes.size()) {
    let mutated = Blob.fromArray(Array.tabulate<Nat8>(validBytes.size(), func(index) {
        if (index == mutationIndex) validBytes[index] +% 1 else validBytes[index]
    }));
    ignore RemoteGameResultWire.decode(mutated);
    mutationIndex += 1;
};

let valueStart = RemoteGameResultWire.prefixSize;

func replaceByte(source : [Nat8], index : Nat, replacement : Nat8) : Blob {
    Blob.fromArray(Array.tabulate<Nat8>(source.size(), func(offset) {
        if (offset == index) replacement else source[offset]
    }));
};

// In the all-empty #ok value: variant, status text, en-passant option,
// remote_connected bool, tile text, mode text, then rows vector.
assert (RemoteGameResultWire.decode(replaceByte(emptyBytes, valueStart + 2, 2)) == null);
assert (RemoteGameResultWire.decode(replaceByte(emptyBytes, valueStart + 3, 2)) == null);
assert (RemoteGameResultWire.decode(replaceByte(emptyBytes, valueStart + 6, 9)) == null);

// Non-canonical ULEB (80 00) for the variant tag is not an alternate spelling.
let nonCanonicalTag = Blob.fromArray(Array.tabulate<Nat8>(emptyBytes.size() + 1, func(index) {
    if (index < valueStart) emptyBytes[index]
    else if (index == valueStart) 0x80
    else emptyBytes[index - 1]
}));
assert (RemoteGameResultWire.decode(nonCanonicalTag) == null);

func findFour(source : [Nat8], a : Nat8, b : Nat8, c : Nat8, d : Nat8) : ?Nat {
    if (source.size() < 4) return null;
    var index = 0;
    while (index + 4 <= source.size()) {
        if (source[index] == a and source[index + 1] == b and source[index + 2] == c and source[index + 3] == d) {
            return ?index;
        };
        index += 1;
    };
    null;
};

// -123456789 is canonically eb e5 90 45. Extending it with a redundant signed
// group (eb e5 90 c5 7f) must not be accepted as an alternate SLEB spelling.
let signedOffset = switch (findFour(validBytes, 0xeb, 0xe5, 0x90, 0x45)) {
    case (?offset) offset;
    case null { assert false; 0 };
};
let nonCanonicalSigned = Blob.fromArray(Array.tabulate<Nat8>(validBytes.size() + 1, func(index) {
    if (index < signedOffset + 3) validBytes[index]
    else if (index == signedOffset + 3) 0xc5
    else if (index == signedOffset + 4) 0x7f
    else validBytes[index - 1]
}));
assert (RemoteGameResultWire.decode(nonCanonicalSigned) == null);

// A text length with malformed UTF-8 is rejected without reaching Text values.
let invalidUtf8 = Blob.fromArray(Array.tabulate<Nat8>(emptyBytes.size() + 1, func(index) {
    if (index <= valueStart) emptyBytes[index]
    else if (index == valueStart + 1) 1
    else if (index == valueStart + 2) 0xff
    else emptyBytes[index - 1]
}));
assert (RemoteGameResultWire.decode(invalidUtf8) == null);

// The decoder refuses the oversized reply before parsing or allocating fields.
assert (RemoteGameResultWire.decode(Blob.fromArray(Array.repeat<Nat8>(0, 32_769))) == null);
