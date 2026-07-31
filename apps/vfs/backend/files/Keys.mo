import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Memory "../memory/files/v1";

module {
    public func compareId128(
        left : Memory.Id128,
        right : Memory.Id128,
    ) : { #less; #equal; #greater } {
        switch (Nat64.compare(left.hi, right.hi)) {
            case (#equal) Nat64.compare(left.lo, right.lo);
            case order order;
        };
    };

    public func compareTag256(
        left : Memory.Tag256,
        right : Memory.Tag256,
    ) : { #less; #equal; #greater } {
        switch (Nat64.compare(left.0, right.0)) {
            case (#equal) switch (Nat64.compare(left.1, right.1)) {
                case (#equal) switch (Nat64.compare(left.2, right.2)) {
                    case (#equal) Nat64.compare(left.3, right.3);
                    case order order;
                };
                case order order;
            };
            case order order;
        };
    };

    public func compareChildNameKey(
        left : Memory.ChildNameKey,
        right : Memory.ChildNameKey,
    ) : { #less; #equal; #greater } {
        switch (Nat64.compare(left.0, right.0)) {
            case (#equal) switch (Nat64.compare(left.1, right.1)) {
                case (#equal) switch (Nat64.compare(left.2, right.2)) {
                    case (#equal) switch (Nat64.compare(left.3, right.3)) {
                        case (#equal) switch (Nat64.compare(left.4, right.4)) {
                            case (#equal) Nat64.compare(left.5, right.5);
                            case order order;
                        };
                        case order order;
                    };
                    case order order;
                };
                case order order;
            };
            case order order;
        };
    };

    public func compareBlockKey(
        left : Memory.BlockKey,
        right : Memory.BlockKey,
    ) : { #less; #equal; #greater } {
        switch (Nat64.compare(left.0, right.0)) {
            case (#equal) switch (Nat64.compare(left.1, right.1)) {
                case (#equal) Nat32.compare(left.2, right.2);
                case order order;
            };
            case order order;
        };
    };

    public func comparePrivateReceiptExpiryKey(
        left : Memory.PrivateReceiptExpiryKey,
        right : Memory.PrivateReceiptExpiryKey,
    ) : { #less; #equal; #greater } {
        switch (Nat64.compare(left.0, right.0)) {
            case (#equal) switch (Nat64.compare(left.1, right.1)) {
                case (#equal) Nat64.compare(left.2, right.2);
                case order order;
            };
            case order order;
        };
    };

    public func childNameKey(
        parent : Memory.Id128,
        tag : Memory.Tag256,
    ) : Memory.ChildNameKey {
        (parent.hi, parent.lo, tag.0, tag.1, tag.2, tag.3);
    };

    public func blockKey(
        content : Memory.Id128,
        index : Nat32,
    ) : Memory.BlockKey {
        (content.hi, content.lo, index);
    };

    public func childKeyParent(value : Memory.ChildNameKey) : Memory.Id128 {
        { hi = value.0; lo = value.1 };
    };

    public func childKeyTag(value : Memory.ChildNameKey) : Memory.Tag256 {
        (value.2, value.3, value.4, value.5);
    };

    public func id128Bytes(value : Memory.Id128) : Blob {
        wordsBytes([value.hi, value.lo]);
    };

    public func tag256Bytes(value : Memory.Tag256) : Blob {
        wordsBytes([value.0, value.1, value.2, value.3]);
    };

    public func childNameKeyBytes(value : Memory.ChildNameKey) : Blob {
        wordsBytes([value.0, value.1, value.2, value.3, value.4, value.5]);
    };

    public func blockKeyBytes(value : Memory.BlockKey) : Blob {
        let prefix = wordsBytes([value.0, value.1]);
        let prefixBytes = Blob.toArray(prefix);
        Blob.fromArray(
            Array.tabulate<Nat8>(
                20,
                func(index) {
                    if (index < 16) {
                        prefixBytes[index];
                    } else {
                        Nat8.fromNat(
                            Nat32.toNat(
                                value.2 >> Nat32.fromNat((19 - index) * 8)
                            ) % 256
                        );
                    };
                },
            )
        );
    };

    public func privateReceiptExpiryKeyBytes(
        value : Memory.PrivateReceiptExpiryKey,
    ) : Blob {
        wordsBytes([value.0, value.1, value.2]);
    };

    public func id128FromBytes(value : Blob) : ?Memory.Id128 {
        if (value.size() != 16) return null;
        let bytes = Blob.toArray(value);
        ?{
            hi = wordFromBytes(bytes, 0);
            lo = wordFromBytes(bytes, 8);
        };
    };

    public func tag256FromBytes(value : Blob) : ?Memory.Tag256 {
        if (value.size() != 32) return null;
        let bytes = Blob.toArray(value);
        ?(
            wordFromBytes(bytes, 0),
            wordFromBytes(bytes, 8),
            wordFromBytes(bytes, 16),
            wordFromBytes(bytes, 24),
        );
    };

    func wordsBytes(words : [Nat64]) : Blob {
        Blob.fromArray(
            Array.tabulate<Nat8>(
                words.size() * 8,
                func(index) {
                    let word = words[index / 8];
                    let offset = index % 8;
                    Nat8.fromNat(
                        Nat64.toNat(
                            word >> Nat64.fromNat((7 - offset) * 8)
                        ) % 256
                    );
                },
            )
        );
    };

    func u64be(value : Nat64) : Blob {
        wordsBytes([value]);
    };

    func wordFromBytes(bytes : [Nat8], start : Nat) : Nat64 {
        var value : Nat64 = 0;
        var index = 0;
        while (index < 8) {
            value := (value << 8) | Nat64.fromNat(Nat8.toNat(bytes[start + index]));
            index += 1;
        };
        value;
    };
};
