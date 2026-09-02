import Char "mo:core/Char";
import Iter "mo:core/Iter";
import Nat "mo:core/Nat";
import Text "mo:core/Text";

module {
    public let MAX_NAT_DIGITS = 80;
    public let MAX_TOKEN_NAME_BYTES = 128;
    public let MAX_TOKEN_SYMBOL_BYTES = 32;
    public let MAX_ERROR_CODE_CHARS = 64;
    public let MAX_ERROR_MESSAGE_CHARS = 256;

    let MAX_NAT_EXCLUSIVE : Nat =
        100000000000000000000000000000000000000000000000000000000000000000000000000000000;

    public func nat(value : Nat) : Bool {
        value < MAX_NAT_EXCLUSIVE;
    };

    public func natText(value : Nat) : Text {
        if (nat(value)) Nat.toText(value) else "<value exceeds Wallet display limit>";
    };

    public func prefix(value : Text, maximumCharacters : Nat) : Text {
        Text.fromIter(Iter.take(value.chars(), maximumCharacters));
    };

    public func callError(code : Text, message : Text) : Text {
        prefix(code, MAX_ERROR_CODE_CHARS) # ": " #
        prefix(message, MAX_ERROR_MESSAGE_CHARS);
    };

    public func safeLabel(value : Text, maximumBytes : Nat, allowSpace : Bool) : Bool {
        var bytes = 0;
        var first = true;
        var lastWasSpace = false;
        for (character in value.chars()) {
            let code = Char.toNat32(character);
            bytes += utf8Bytes(code);
            if (bytes > maximumBytes) return false;
            if (unsafeScalar(code)) return false;
            let whitespace = whitespaceScalar(code);
            if (whitespace and (not allowSpace or first)) return false;
            first := false;
            lastWasSpace := whitespace;
        };
        not first and not lastWasSpace;
    };

    func utf8Bytes(code : Nat32) : Nat {
        if (code <= 0x7F) 1 else if (code <= 0x7FF) 2 else if (code <= 0xFFFF) 3 else 4;
    };

    func whitespaceScalar(code : Nat32) : Bool {
        code == 0x0020 or
        code == 0x00A0 or
        code == 0x1680 or
        (code >= 0x2000 and code <= 0x200A) or
        code == 0x202F or
        code == 0x205F or
        code == 0x3000;
    };

    // Ledger metadata is untrusted text rendered in Wallet review surfaces.
    // Reject controls, bidi/invisible formatting, line separators,
    // variation selectors, tags, and the remaining common default-ignorable
    // scalars rather than persisting an ambiguous command review.
    func unsafeScalar(code : Nat32) : Bool {
        code < 0x0020 or
        (code >= 0x007F and code <= 0x009F) or
        code == 0x00AD or
        code == 0x034F or
        (code >= 0x0600 and code <= 0x0605) or
        code == 0x061C or
        code == 0x06DD or
        code == 0x070F or
        (code >= 0x0890 and code <= 0x0891) or
        code == 0x08E2 or
        (code >= 0x115F and code <= 0x1160) or
        (code >= 0x17B4 and code <= 0x17B5) or
        (code >= 0x180B and code <= 0x180F) or
        (code >= 0x200B and code <= 0x200F) or
        (code >= 0x2028 and code <= 0x202E) or
        (code >= 0x2060 and code <= 0x206F) or
        code == 0x3164 or
        (code >= 0xFE00 and code <= 0xFE0F) or
        code == 0xFEFF or
        (code >= 0xFFF9 and code <= 0xFFFB) or
        code == 0xFFA0 or
        code == 0x110BD or
        code == 0x110CD or
        (code >= 0x1BCA0 and code <= 0x1BCA3) or
        (code >= 0x1D173 and code <= 0x1D17A) or
        (code >= 0xE0000 and code <= 0xE0FFF);
    };
};
