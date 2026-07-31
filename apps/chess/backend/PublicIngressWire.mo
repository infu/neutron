import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";

// Exact, non-trapping decoder for the untrusted outer result returned by a
// raw backend call to a compiler-generated public-ingress dispatcher. Chess's
// V1 inner GameResult remains Candid, but malformed bytes must not reach that
// decoder unless the broker wrapper itself is exactly the frozen V1 #ok wire.
module {
    // Canonical Candid type table, one result argument, and the #ok variant tag
    // for neutron-capabilities.PublicIngressResultV1.
    let OK_PREFIX : [Nat8] = [
        68, 73, 68, 76, 3, 107, 2, 156, 194, 1, 2, 229, 142, 180, 2, 1,
        107, 10, 254, 254, 203, 133, 1, 127, 149, 239, 154, 175,
        1, 127, 152, 153, 210, 236, 1, 127, 222, 254, 203, 140, 2, 127,
        187, 145, 186, 249, 3, 127, 185, 170, 128, 137, 4, 127, 210, 169,
        200, 152, 4, 127, 214, 229, 202, 198, 4, 127, 180, 156, 252, 217,
        12, 127, 144, 145, 208, 173, 13, 127, 109, 123, 1, 0, 0,
    ];

    public func unwrapOk(reply : Blob, maximum : Nat) : ?Blob {
        if (reply.size() < OK_PREFIX.size() + 1) return null;
        // A V1 route is capped below 2^21 bytes. Four bytes leave one bounded
        // malformed-byte margin while the canonical ULEB parser rejects it.
        if (reply.size() > OK_PREFIX.size() + 4 + maximum) return null;
        let bytes = Blob.toArray(reply);
        var prefixIndex = 0;
        while (prefixIndex < OK_PREFIX.size()) {
            if (bytes[prefixIndex] != OK_PREFIX[prefixIndex]) return null;
            prefixIndex += 1;
        };

        var index = OK_PREFIX.size();
        var length = 0;
        var multiplier = 1;
        var count = 0;
        label leb loop {
            if (index >= bytes.size() or count >= 4) return null;
            let byte = Nat8.toNat(bytes[index]);
            let low = byte % 128;
            if (length > maximum) return null;
            if (low > (maximum - length) / multiplier) return null;
            length += low * multiplier;
            index += 1;
            count += 1;
            if (byte < 128) {
                // Reject non-canonical forms such as 0x80 0x00.
                if (count > 1 and low == 0) return null;
                break leb;
            };
            multiplier *= 128;
        };
        if (length > maximum or index + length != bytes.size()) return null;
        ?Array.toBlob(Array.tabulate<Nat8>(length, func(offset) {
            bytes[index + offset]
        }));
    };
};
