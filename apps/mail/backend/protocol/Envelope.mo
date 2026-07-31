import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Nat64 "mo:core/Nat64";

module {
    public let VERSION : Nat8 = 1;
    public let SUITE : Nat = 1;
    public let FINGERPRINT_BYTES = 32;
    public let MESSAGE_ID_BYTES = 16;
    public let WRAPPED_CEK_BYTES = 168;
    public let NONCE_BYTES = 12;
    public let HEADER_CIPHERTEXT_BYTES = 2_064;
    public let PREFIX_BYTES = 2_319;
    public let MAX_ENVELOPE_BYTES = 39_199;

    public type EnvelopeV1 = {
        delivery_key_epoch : Nat64;
        recipient_key_fingerprint : Blob;
        message_id : Blob;
        recipient_wrapped_cek : Blob;
        header_nonce : Blob;
        header_ciphertext_and_tag : Blob;
        body_nonce : Blob;
        body_ciphertext_and_tag : Blob;
    };

    public type DecodeResult = {
        #ok : EnvelopeV1;
        #err;
    };

    let BODY_CIPHERTEXT_SIZES : [Nat] = [1_040, 4_112, 16_400, 36_880];
    let ENVELOPE_SIZES : [Nat] = [3_359, 6_431, 18_719, 39_199];

    public func decode(payload : Blob) : DecodeResult {
        let size = payload.size();
        if (not contains(ENVELOPE_SIZES, size)) return #err;
        let bytes = Blob.toArray(payload);
        if (bytes[0] != VERSION or readNat(bytes, 1, 2) != SUITE) return #err;

        let bodySize = readNat(bytes, 2_315, 4);
        if (not contains(BODY_CIPHERTEXT_SIZES, bodySize)) return #err;
        if (PREFIX_BYTES + bodySize != size) return #err;

        let headerNonce = slice(bytes, 227, NONCE_BYTES);
        let bodyNonce = slice(bytes, 2_303, NONCE_BYTES);
        if (Blob.equal(headerNonce, bodyNonce)) return #err;

        let deliveryKeyEpoch = readNat64(bytes, 3);
        if (deliveryKeyEpoch == 0) return #err;

        let recipientKeyFingerprint = slice(bytes, 11, FINGERPRINT_BYTES);
        let messageId = slice(bytes, 43, MESSAGE_ID_BYTES);
        let recipientWrappedCek = slice(bytes, 59, WRAPPED_CEK_BYTES);
        if (
            isZero(recipientKeyFingerprint) or
            isZero(messageId) or
            isZero(recipientWrappedCek)
        ) return #err;

        #ok({
            delivery_key_epoch = deliveryKeyEpoch;
            recipient_key_fingerprint = recipientKeyFingerprint;
            message_id = messageId;
            recipient_wrapped_cek = recipientWrappedCek;
            header_nonce = headerNonce;
            header_ciphertext_and_tag = slice(bytes, 239, HEADER_CIPHERTEXT_BYTES);
            body_nonce = bodyNonce;
            body_ciphertext_and_tag = slice(bytes, PREFIX_BYTES, bodySize);
        });
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

    func readNat64(bytes : [Nat8], offset : Nat) : Nat64 {
        Nat64.fromNat(readNat(bytes, offset, 8));
    };

    func slice(bytes : [Nat8], offset : Nat, length : Nat) : Blob {
        Blob.fromArray(Array.tabulate<Nat8>(length, func(index) { bytes[offset + index] }));
    };

    func contains(values : [Nat], target : Nat) : Bool {
        for (value in values.vals()) if (value == target) return true;
        false;
    };

    func isZero(value : Blob) : Bool {
        for (byte in value.vals()) if (byte != 0) return false;
        true;
    };
};
