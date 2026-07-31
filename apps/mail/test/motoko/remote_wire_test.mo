import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int64 "mo:core/Int64";
import Nat32 "mo:core/Nat32";
import Capabilities "../../backend/capabilities/Types";
import RemoteWire "../../backend/protocol/RemoteWire";
import Fixture "Fixture";

let info : RemoteWire.MailKeyInfoV1 = {
    protocol_version = 1;
    suite = 1;
    delivery_key_epoch = 7;
    context_public_key = Fixture.repeatBlob(96, 0x31);
    effective_ibe_identity = Fixture.repeatBlob(32, 0x32);
    recipient_key_fingerprint = Fixture.repeatBlob(32, 0x33);
    max_envelope_bytes = Nat32.fromNat(39_199);
};

let keyPayload = RemoteWire.encodeKeyInfoPayload(#ok(info));
assert (keyPayload.size() == 184);
switch (RemoteWire.decodeKeyInfoPayload(keyPayload)) {
    case (?#ok(decoded)) assert (decoded == info);
    case (_) assert false;
};
switch (RemoteWire.decodeKeyInfoReply(to_candid (keyPayload))) {
    case (?#ok(decoded)) assert (decoded == info);
    case (_) assert false;
};
let unavailable = RemoteWire.encodeKeyInfoPayload(#unavailable);
assert (unavailable == Blob.fromArray([0x4e, 0x4d, 0x4b, 0x31, 0]));
assert (RemoteWire.decodeKeyInfoPayload(unavailable) == ?#unavailable);

let accepted : RemoteWire.ReceiveResultV1 = #accepted({ received_at_ns = 123 : Int64 });
let acceptedPayload = RemoteWire.encodeReceivePayload(accepted);
assert (acceptedPayload == Blob.fromArray([
    0x4e, 0x4d, 0x52, 0x31, 0,
    0, 0, 0, 0, 0, 0, 0, 123,
]));
assert (RemoteWire.decodeReceivePayload(acceptedPayload) == ?accepted);
assert (RemoteWire.decodeReceiveReply(to_candid (acceptedPayload)) == ?accepted);

// The public-ingress result wrapper is attacker-controlled backend-call input.
// Accept its one exact canonical #ok encoding, and fail closed when any byte in
// the frozen type/tag prefix is changed. This catches prefix-loop regressions
// that could otherwise skip alternate or malformed Candid structure.
let ingressInner = Blob.fromArray([0x2a]);
let ingressOuter : Capabilities.PublicIngressResult = #ok(ingressInner);
let ingressReply = to_candid (ingressOuter);
assert (RemoteWire.unwrapPublicIngressOkReply(ingressReply, 1) == ?ingressInner);
let ingressReplyBytes = Blob.toArray(ingressReply);
// The final two bytes are the one-byte blob length and payload.
let ingressPrefixSize = ingressReplyBytes.size() - 2;
var ingressPrefixIndex = 0;
while (ingressPrefixIndex < ingressPrefixSize) {
    let mutated = Blob.fromArray(Array.tabulate<Nat8>(
        ingressReplyBytes.size(),
        func(index) {
            if (index == ingressPrefixIndex) {
                if (ingressReplyBytes[index] == 0) 1 else 0
            } else ingressReplyBytes[index]
        },
    ));
    assert (RemoteWire.unwrapPublicIngressOkReply(mutated, 1) == null);
    ingressPrefixIndex += 1;
};

let rate : RemoteWire.ReceiveResultV1 = #rejected(#rate_limited({
    retry_after_seconds = 300;
}));
assert (RemoteWire.decodeReceivePayload(RemoteWire.encodeReceivePayload(rate)) == ?rate);
let stale : RemoteWire.ReceiveResultV1 = #rejected(#stale_key({
    current_epoch = 8;
    current_fingerprint = Fixture.repeatBlob(32, 0x44);
}));
assert (RemoteWire.decodeReceivePayload(RemoteWire.encodeReceivePayload(stale)) == ?stale);

// Audit regression vectors: every malformed raw reply returns null. None is
// handed to `from_candid`, so truncated LEB/type/principal bombs cannot trap.
let truncatedTableLeb = Blob.fromArray([0x44, 0x49, 0x44, 0x4c, 0x80, 0x80]);
assert (RemoteWire.decodeKeyInfoReply(truncatedTableLeb) == null);
assert (RemoteWire.decodeReceiveReply(truncatedTableLeb) == null);

let truncatedPayloadLeb = Blob.fromArray([
    0x44, 0x49, 0x44, 0x4c, 0x01, 0x6d, 0x7b, 0x01, 0x00, 0x80,
]);
assert (RemoteWire.decodeKeyInfoReply(truncatedPayloadLeb) == null);
let overlongPayloadLeb = Blob.fromArray([
    0x44, 0x49, 0x44, 0x4c, 0x01, 0x6d, 0x7b, 0x01, 0x00, 0x80, 0x00,
]);
assert (RemoteWire.decodeKeyInfoReply(overlongPayloadLeb) == null);
let invalidTypeOpcode = Blob.fromArray([
    0x44, 0x49, 0x44, 0x4c, 0x01, 0x68, 0x7b, 0x01, 0x00, 0x00,
]);
assert (RemoteWire.decodeKeyInfoReply(invalidTypeOpcode) == null);
// Deliberately frozen interoperability: this is a semantically equivalent
// Candid blob encoding with an extra unused vec-nat8 table entry. It is valid
// Candid but not the exact V1 wrapper, so it fails closed instead of decoding.
let alternateBlobEncoding = Blob.fromArray([
    0x44, 0x49, 0x44, 0x4c,
    0x02, 0x6d, 0x7b, 0x6d, 0x7b,
    0x01, 0x01,
    0x05, 0x4e, 0x4d, 0x4b, 0x31, 0x00,
]);
assert (RemoteWire.decodeKeyInfoReply(alternateBlobEncoding) == null);
let principalLengthBomb = Blob.fromArray([
    0x44, 0x49, 0x44, 0x4c, 0x00, 0x01, 0x68,
    0xff, 0xff, 0xff, 0xff, 0x7f,
]);
assert (RemoteWire.decodeReceiveReply(principalLengthBomb) == null);

let typeBomb = Blob.fromArray(Array.tabulate<Nat8>(10_000, func(index) {
    switch (index) {
        case (0) 0x44;
        case (1) 0x49;
        case (2) 0x44;
        case (3) 0x4c;
        case (_) 0xff;
    };
}));
assert (RemoteWire.decodeKeyInfoReply(typeBomb) == null);
assert (RemoteWire.decodeReceiveReply(typeBomb) == null);

// Valid outer blob with corrupt compact payloads also remains a closed null.
let badKeyLength = Blob.fromArray([
    0x4e, 0x4d, 0x4b, 0x31, 1,
    1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 7,
    0x10, 0x01, 0, 1,
]);
assert (RemoteWire.decodeKeyInfoReply(to_candid (badKeyLength)) == null);
let trailingReceive = Blob.fromArray([0x4e, 0x4d, 0x52, 0x31, 2, 0]);
assert (RemoteWire.decodeReceiveReply(to_candid (trailingReceive)) == null);
