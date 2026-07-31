import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Int64 "mo:core/Int64";
import List "mo:core/List";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";

// Frozen, non-trapping response wire for untrusted raw backend calls.
//
// The public methods return one Candid `blob`. Delivery accepts only the exact
// canonical Candid encoding of that simple type, unwraps it with bounded byte
// arithmetic, and then parses the compact payload below. No untrusted reply is
// ever passed to `from_candid`, whose malformed-input behavior is to trap.
module {
    public let MAX_KEY_INFO_PAYLOAD_BYTES = 8_248;
    public let MAX_RECEIVE_PAYLOAD_BYTES = 45;

    let MAX_PUBLIC_FIELD_BYTES = 4_096;
    let MAX_TIMESTAMP : Nat = 9_223_372_036_854_775_807;
    let CANDID_PREFIX : [Nat8] = [
        0x44, 0x49, 0x44, 0x4c, // DIDL
        0x01, 0x6d, 0x7b,       // one type: vec nat8
        0x01, 0x00,             // one argument of type-table index zero
    ];
    // Exact canonical Candid type table and #ok tag for
    // neutron-capabilities.PublicIngressResultV1. Error variants intentionally
    // fail this prefix check; Mail treats every broker error as unavailable or
    // delivery-uncertain without feeding attacker bytes to `from_candid`.
    let PUBLIC_INGRESS_OK_PREFIX : [Nat8] = [
        68, 73, 68, 76, 3, 107, 2, 156, 194, 1, 2, 229, 142, 180, 2, 1,
        107, 10, 254, 254, 203, 133, 1, 127, 149, 239, 154, 175,
        1, 127, 152, 153, 210, 236, 1, 127, 222, 254, 203, 140, 2, 127,
        187, 145, 186, 249, 3, 127, 185, 170, 128, 137, 4, 127, 210, 169,
        200, 152, 4, 127, 214, 229, 202, 198, 4, 127, 180, 156, 252, 217,
        12, 127, 144, 145, 208, 173, 13, 127, 109, 123, 1, 0, 0,
    ];
    let KEY_MAGIC : [Nat8] = [0x4e, 0x4d, 0x4b, 0x31]; // NMK1
    let RECEIVE_MAGIC : [Nat8] = [0x4e, 0x4d, 0x52, 0x31]; // NMR1

    public type MailKeyInfoV1 = {
        protocol_version : Nat8;
        suite : Nat16;
        delivery_key_epoch : Nat64;
        context_public_key : Blob;
        effective_ibe_identity : Blob;
        recipient_key_fingerprint : Blob;
        max_envelope_bytes : Nat32;
    };

    public type MailKeyInfoResultV1 = {
        #ok : MailKeyInfoV1;
        #unavailable;
    };

    public type ReceiveResultV1 = {
        #accepted : { received_at_ns : Int64 };
        #duplicate : { received_at_ns : Int64 };
        #rejected : {
            #invalid;
            #rate_limited : { retry_after_seconds : Nat32 };
            #mailbox_full;
            #stale_key : {
                current_epoch : Nat64;
                current_fingerprint : Blob;
            };
            #crypto_unavailable;
        };
    };

    // Key payload:
    // NMK1 | status:u8
    // status 0 = unavailable (exactly five bytes)
    // status 1 = protocol:u8 | suite:u16be | epoch:u64be |
    //            public_len:u16be | identity_len:u16be | fingerprint:32 |
    //            max_envelope:u32be | public | identity
    public func encodeKeyInfoPayload(result : MailKeyInfoResultV1) : Blob {
        switch (result) {
            case (#unavailable) tagged(KEY_MAGIC, 0 : Nat8);
            case (#ok(info)) {
                if (
                    info.context_public_key.size() == 0 or
                    info.context_public_key.size() > MAX_PUBLIC_FIELD_BYTES or
                    info.effective_ibe_identity.size() == 0 or
                    info.effective_ibe_identity.size() > MAX_PUBLIC_FIELD_BYTES or
                    info.recipient_key_fingerprint.size() != 32
                ) return tagged(KEY_MAGIC, 0);
                let bytes = List.empty<Nat8>();
                appendArray(bytes, KEY_MAGIC);
                List.add(bytes, 1 : Nat8);
                List.add(bytes, info.protocol_version);
                appendU16(bytes, Nat16.toNat(info.suite));
                appendU64(bytes, Nat64.toNat(info.delivery_key_epoch));
                appendU16(bytes, info.context_public_key.size());
                appendU16(bytes, info.effective_ibe_identity.size());
                appendBlob(bytes, info.recipient_key_fingerprint);
                appendU32(bytes, Nat32.toNat(info.max_envelope_bytes));
                appendBlob(bytes, info.context_public_key);
                appendBlob(bytes, info.effective_ibe_identity);
                Blob.fromArray(List.toArray(bytes));
            };
        };
    };

    public func decodeKeyInfoPayload(payload : Blob) : ?MailKeyInfoResultV1 {
        if (payload.size() < 5 or payload.size() > MAX_KEY_INFO_PAYLOAD_BYTES) return null;
        let bytes = Blob.toArray(payload);
        if (not magicAt(bytes, KEY_MAGIC)) return null;
        switch (bytes[4]) {
            case (0) {
                if (bytes.size() == 5) ?#unavailable else null;
            };
            case (1) {
                if (bytes.size() < 56) return null;
                let publicLength = readNat(bytes, 16, 2);
                let identityLength = readNat(bytes, 18, 2);
                if (
                    publicLength == 0 or publicLength > MAX_PUBLIC_FIELD_BYTES or
                    identityLength == 0 or identityLength > MAX_PUBLIC_FIELD_BYTES or
                    bytes.size() != 56 + publicLength + identityLength
                ) return null;
                ?#ok({
                    protocol_version = bytes[5];
                    suite = Nat16.fromNat(readNat(bytes, 6, 2));
                    delivery_key_epoch = Nat64.fromNat(readNat(bytes, 8, 8));
                    context_public_key = slice(bytes, 56, publicLength);
                    effective_ibe_identity = slice(bytes, 56 + publicLength, identityLength);
                    recipient_key_fingerprint = slice(bytes, 20, 32);
                    max_envelope_bytes = Nat32.fromNat(readNat(bytes, 52, 4));
                });
            };
            case (_) null;
        };
    };

    public func decodeKeyInfoReply(reply : Blob) : ?MailKeyInfoResultV1 {
        let ?payload = unwrapCanonicalCandidBlob(reply, MAX_KEY_INFO_PAYLOAD_BYTES) else return null;
        decodeKeyInfoPayload(payload);
    };

    // Receive payload:
    // NMR1 | status:u8 | fixed status-specific bytes
    // 0 accepted + u64be timestamp; 1 duplicate + u64be timestamp;
    // 2 invalid; 3 rate_limited + u32be seconds; 4 mailbox_full;
    // 5 stale_key + u64be epoch + 32-byte fingerprint; 6 crypto_unavailable.
    public func encodeReceivePayload(result : ReceiveResultV1) : Blob {
        switch (result) {
            case (#accepted({ received_at_ns })) timestampPayload(0 : Nat8, received_at_ns);
            case (#duplicate({ received_at_ns })) timestampPayload(1 : Nat8, received_at_ns);
            case (#rejected(#invalid)) tagged(RECEIVE_MAGIC, 2 : Nat8);
            case (#rejected(#rate_limited({ retry_after_seconds }))) {
                let bytes = receivePrefix(3 : Nat8);
                appendU32(bytes, Nat32.toNat(retry_after_seconds));
                Blob.fromArray(List.toArray(bytes));
            };
            case (#rejected(#mailbox_full)) tagged(RECEIVE_MAGIC, 4 : Nat8);
            case (#rejected(#stale_key(stale))) {
                if (stale.current_fingerprint.size() != 32) {
                    return tagged(RECEIVE_MAGIC, 2 : Nat8);
                };
                let bytes = receivePrefix(5 : Nat8);
                appendU64(bytes, Nat64.toNat(stale.current_epoch));
                appendBlob(bytes, stale.current_fingerprint);
                Blob.fromArray(List.toArray(bytes));
            };
            case (#rejected(#crypto_unavailable)) tagged(RECEIVE_MAGIC, 6 : Nat8);
        };
    };

    public func decodeReceivePayload(payload : Blob) : ?ReceiveResultV1 {
        if (payload.size() < 5 or payload.size() > MAX_RECEIVE_PAYLOAD_BYTES) return null;
        let bytes = Blob.toArray(payload);
        if (not magicAt(bytes, RECEIVE_MAGIC)) return null;
        switch (bytes[4]) {
            case (0) decodeTimestamp(bytes, false);
            case (1) decodeTimestamp(bytes, true);
            case (2) if (bytes.size() == 5) ?#rejected(#invalid) else null;
            case (3) {
                if (bytes.size() != 9) return null;
                ?#rejected(#rate_limited({
                    retry_after_seconds = Nat32.fromNat(readNat(bytes, 5, 4));
                }));
            };
            case (4) if (bytes.size() == 5) ?#rejected(#mailbox_full) else null;
            case (5) {
                if (bytes.size() != 45) return null;
                ?#rejected(#stale_key({
                    current_epoch = Nat64.fromNat(readNat(bytes, 5, 8));
                    current_fingerprint = slice(bytes, 13, 32);
                }));
            };
            case (6) if (bytes.size() == 5) ?#rejected(#crypto_unavailable) else null;
            case (_) null;
        };
    };

    public func decodeReceiveReply(reply : Blob) : ?ReceiveResultV1 {
        let ?payload = unwrapCanonicalCandidBlob(reply, MAX_RECEIVE_PAYLOAD_BYTES) else return null;
        decodeReceivePayload(payload);
    };

    // Accept exactly the canonical Candid encoding emitted for one `blob`.
    // The only variable portion before the payload is a canonical unsigned LEB
    // length. Bounds are checked before allocation and every index is guarded.
    public func unwrapCanonicalCandidBlob(reply : Blob, maximum : Nat) : ?Blob {
        if (reply.size() < CANDID_PREFIX.size() + 1) return null;
        // All Mail payload bounds fit in two ULEB bytes. Allow one additional
        // byte in this cheap precheck so malformed encodings reach the strict
        // canonical parser and return null without allocating their claim.
        if (reply.size() > CANDID_PREFIX.size() + 3 + maximum) return null;
        let bytes = Blob.toArray(reply);
        var prefixIndex = 0;
        while (prefixIndex < CANDID_PREFIX.size()) {
            if (bytes[prefixIndex] != CANDID_PREFIX[prefixIndex]) return null;
            prefixIndex += 1;
        };

        var index = CANDID_PREFIX.size();
        var length = 0;
        var multiplier = 1;
        var count = 0;
        label leb loop {
            if (index >= bytes.size() or count >= 3) return null;
            let byte = Nat8.toNat(bytes[index]);
            let low = byte % 128;
            if (low > (maximum - length) / multiplier) return null;
            length += low * multiplier;
            index += 1;
            count += 1;
            if (byte < 128) {
                // Reject overlong ULEB encodings such as 0x80 0x00.
                if (count > 1 and low == 0) return null;
                break leb;
            };
            multiplier *= 128;
        };
        if (length > maximum or index + length != bytes.size()) return null;
        ?slice(bytes, index, length);
    };

    public func unwrapPublicIngressOkReply(reply : Blob, maximum : Nat) : ?Blob {
        if (reply.size() < PUBLIC_INGRESS_OK_PREFIX.size() + 1) return null;
        if (reply.size() > PUBLIC_INGRESS_OK_PREFIX.size() + 4 + maximum) return null;
        let bytes = Blob.toArray(reply);
        var prefixIndex = 0;
        while (prefixIndex < PUBLIC_INGRESS_OK_PREFIX.size()) {
            if (bytes[prefixIndex] != PUBLIC_INGRESS_OK_PREFIX[prefixIndex]) return null;
            prefixIndex += 1;
        };
        var index = PUBLIC_INGRESS_OK_PREFIX.size();
        var length = 0;
        var multiplier = 1;
        var count = 0;
        label leb loop {
            if (index >= bytes.size() or count >= 4) return null;
            let byte = Nat8.toNat(bytes[index]);
            let low = byte % 128;
            if (low > (maximum - length) / multiplier) return null;
            length += low * multiplier;
            index += 1;
            count += 1;
            if (byte < 128) {
                if (count > 1 and low == 0) return null;
                break leb;
            };
            multiplier *= 128;
        };
        if (length > maximum or index + length != bytes.size()) return null;
        ?slice(bytes, index, length);
    };

    func decodeTimestamp(
        bytes : [Nat8],
        duplicate : Bool,
    ) : ?ReceiveResultV1 {
        if (bytes.size() != 13) return null;
        let timestamp = readNat(bytes, 5, 8);
        if (timestamp > MAX_TIMESTAMP) return null;
        let value = { received_at_ns = Int64.fromInt(timestamp) };
        if (duplicate) ?#duplicate(value) else ?#accepted(value);
    };

    func timestampPayload(status : Nat8, timestamp : Int64) : Blob {
        let value = Int64.toInt(timestamp);
        if (value < 0) return tagged(RECEIVE_MAGIC, 2 : Nat8);
        let bytes = receivePrefix(status);
        appendU64(bytes, Int.abs(value));
        Blob.fromArray(List.toArray(bytes));
    };

    func receivePrefix(status : Nat8) : List.List<Nat8> {
        let bytes = List.empty<Nat8>();
        appendArray(bytes, RECEIVE_MAGIC);
        List.add(bytes, status);
        bytes;
    };

    func tagged(magic : [Nat8], status : Nat8) : Blob {
        let bytes = List.empty<Nat8>();
        appendArray(bytes, magic);
        List.add(bytes, status);
        Blob.fromArray(List.toArray(bytes));
    };

    func magicAt(bytes : [Nat8], magic : [Nat8]) : Bool {
        if (bytes.size() < magic.size()) return false;
        var index = 0;
        while (index < magic.size()) {
            if (bytes[index] != magic[index]) return false;
            index += 1;
        };
        true;
    };

    func slice(bytes : [Nat8], offset : Nat, length : Nat) : Blob {
        Blob.fromArray(Array.tabulate<Nat8>(length, func(index) { bytes[offset + index] }));
    };

    func readNat(bytes : [Nat8], offset : Nat, length : Nat) : Nat {
        var value = 0;
        var index = 0;
        while (index < length) {
            value := value * 256 + Nat8.toNat(bytes[offset + index]);
            index += 1;
        };
        value;
    };

    func appendArray(target : List.List<Nat8>, value : [Nat8]) : () {
        for (byte in value.values()) List.add(target, byte);
    };

    func appendBlob(target : List.List<Nat8>, value : Blob) : () {
        for (byte in value.values()) List.add(target, byte);
    };

    func appendU16(target : List.List<Nat8>, value : Nat) : () {
        List.add(target, Nat8.fromNat((value / 256) % 256));
        List.add(target, Nat8.fromNat(value % 256));
    };

    func appendU32(target : List.List<Nat8>, value : Nat) : () {
        List.add(target, Nat8.fromNat((value / 16_777_216) % 256));
        List.add(target, Nat8.fromNat((value / 65_536) % 256));
        List.add(target, Nat8.fromNat((value / 256) % 256));
        List.add(target, Nat8.fromNat(value % 256));
    };

    func appendU64(target : List.List<Nat8>, value : Nat) : () {
        var divisor : Nat = 72_057_594_037_927_936; // 256^7
        var index = 0;
        while (index < 8) {
            List.add(target, Nat8.fromNat((value / divisor) % 256));
            if (divisor > 1) divisor /= 256;
            index += 1;
        };
    };
};
