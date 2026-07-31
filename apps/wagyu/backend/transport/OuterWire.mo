import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";

import ProtocolTypes "../protocol/Types";

// Strict, non-trapping decoder for the closed kernel PublicIngressResultV1.
// Backend-call replies are hostile bytes. Matching the complete frozen Candid
// type table before bounded value parsing prevents `from_candid` from trapping
// this update and rejects non-canonical alternate encodings.
module {
    // Exact Candid type table and one-argument header, before the top-level
    // result tag. Type 0 is variant { ok : type 2; err : type 1 }, type 1 is
    // the frozen ten-tag error variant, and type 2 is blob.
    let PREFIX : [Nat8] = [
        68, 73, 68, 76, 3, 107, 2, 156, 194, 1, 2, 229, 142, 180, 2, 1,
        107, 10, 254, 254, 203, 133, 1, 127, 149, 239, 154, 175, 1, 127,
        152, 153, 210, 236, 1, 127, 222, 254, 203, 140, 2, 127, 187, 145,
        186, 249, 3, 127, 185, 170, 128, 137, 4, 127, 210, 169, 200, 152,
        4, 127, 214, 229, 202, 198, 4, 127, 180, 156, 252, 217, 12, 127,
        144, 145, 208, 173, 13, 127, 109, 123, 1, 0,
    ];

    public func decode(
        reply : Blob,
        maximumOkBytes : Nat,
    ) : ?ProtocolTypes.PublicIngressResultV1 {
        if (reply.size() < PREFIX.size() + 2) return null;
        // Four ULEB bytes cover every current route response and leave a
        // bounded malformed-input margin.
        if (reply.size() > PREFIX.size() + 1 + 4 + maximumOkBytes) {
            return null;
        };
        let bytes = Blob.toArray(reply);
        var prefixIndex = 0;
        while (prefixIndex < PREFIX.size()) {
            if (bytes[prefixIndex] != PREFIX[prefixIndex]) return null;
            prefixIndex += 1;
        };

        switch (bytes[PREFIX.size()]) {
            case (0) decodeOk(bytes, maximumOkBytes);
            case (1) decodeError(bytes);
            case (_) null;
        };
    };

    func decodeOk(
        bytes : [Nat8],
        maximum : Nat,
    ) : ?ProtocolTypes.PublicIngressResultV1 {
        var index = PREFIX.size() + 1;
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
                // Reject alternate overlong spellings such as 0x80 0x00.
                if (count > 1 and low == 0) return null;
                break leb;
            };
            multiplier *= 128;
        };
        if (length > maximum or index + length != bytes.size()) return null;
        ?#ok(slice(bytes, index, length));
    };

    func decodeError(
        bytes : [Nat8],
    ) : ?ProtocolTypes.PublicIngressResultV1 {
        if (bytes.size() != PREFIX.size() + 2) return null;
        let error : ProtocolTypes.PublicIngressErrorV1 = switch (
            bytes[PREFIX.size() + 1]
        ) {
            // Candid variants are ordered by field hash, not source order.
            case (0) #revoked_after_dispatch;
            case (1) #bad_request;
            case (2) #low_cycles;
            case (3) #revoked;
            case (4) #rate_limited;
            case (5) #busy;
            case (6) #handler_failed;
            case (7) #not_found;
            case (8) #unauthorized;
            case (9) #too_large;
            case (_) return null;
        };
        ?#err(error);
    };

    func slice(bytes : [Nat8], offset : Nat, length : Nat) : Blob {
        Blob.fromArray(Array.tabulate<Nat8>(length, func(index) {
            bytes[offset + index]
        }));
    };
};
