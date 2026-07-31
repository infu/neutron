import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Envelope "../../backend/protocol/Envelope";
import Fixture "Fixture";

func expectInvalid(payload : Blob) {
    switch (Envelope.decode(payload)) {
        case (#err) {};
        case (#ok(_)) assert false;
    };
};

func zeroRange(payload : Blob, offset : Nat, length : Nat) : Blob {
    let bytes = Blob.toArray(payload);
    Blob.fromArray(
        Array.tabulate<Nat8>(
            bytes.size(),
            func(index) {
                if (index >= offset and index < offset + length) 0 else bytes[index];
            },
        )
    );
};

assert (Envelope.VERSION == 1 and Envelope.SUITE == 1);
assert (Envelope.FINGERPRINT_BYTES == 32 and Envelope.MESSAGE_ID_BYTES == 16);
assert (Envelope.WRAPPED_CEK_BYTES == 168 and Envelope.NONCE_BYTES == 12);
assert (Envelope.HEADER_CIPHERTEXT_BYTES == 2_064);
assert (Envelope.PREFIX_BYTES == 2_319 and Envelope.MAX_ENVELOPE_BYTES == 39_199);

for (bodySize in Fixture.BODY_SIZES.vals()) {
    let payload = Fixture.envelope(bodySize, bodySize, 7, 0x22);
    assert (payload.size() == Fixture.PREFIX_BYTES + bodySize);
    switch (Envelope.decode(payload)) {
        case (#err) assert false;
        case (#ok(decoded)) {
            assert (decoded.delivery_key_epoch == 7);
            assert (decoded.recipient_key_fingerprint == Fixture.repeatBlob(32, 0x22));
            assert (decoded.message_id.size() == Envelope.MESSAGE_ID_BYTES);
            assert (decoded.recipient_wrapped_cek == Fixture.repeatBlob(168, 0x55));
            assert (decoded.header_nonce.size() == Envelope.NONCE_BYTES);
            assert (decoded.header_ciphertext_and_tag.size() == Envelope.HEADER_CIPHERTEXT_BYTES);
            assert (decoded.body_nonce.size() == Envelope.NONCE_BYTES);
            assert (decoded.body_ciphertext_and_tag.size() == bodySize);
        };
    };
};

let canonical = Fixture.envelope(1_040, 1, 7, 0x22);
expectInvalid(Fixture.replace(canonical, 0, 2));
expectInvalid(Fixture.replace(canonical, 2, 2));
expectInvalid(Fixture.replace(canonical, 10, 0));
expectInvalid(zeroRange(canonical, 11, Envelope.FINGERPRINT_BYTES));
expectInvalid(zeroRange(canonical, 43, Envelope.MESSAGE_ID_BYTES));
expectInvalid(zeroRange(canonical, 59, Envelope.WRAPPED_CEK_BYTES));
expectInvalid(Fixture.replace(canonical, 2_318, 0x11));
expectInvalid(Fixture.copyHeaderNonceToBody(canonical));
expectInvalid(Fixture.appendByte(canonical, 0));
expectInvalid(
    Blob.fromArray(
        Array.tabulate<Nat8>(canonical.size() - 1, func(index) {
            Blob.toArray(canonical)[index];
        })
    )
);
