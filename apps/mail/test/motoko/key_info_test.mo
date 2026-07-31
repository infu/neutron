import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import KeyInfo "../../backend/protocol/KeyInfo";
import Memory "../../backend/memory/mail/v1";
import Fixture "Fixture";

let publicKey = Fixture.repeatBlob(96, 0x31);
let identity = Fixture.repeatBlob(32, 0x32);
let fingerprint = KeyInfo.fingerprint(1, 7, publicKey, identity);
assert (fingerprint == Blob.fromArray([
    0xfe, 0x4d, 0xa1, 0x7d, 0xee, 0x11, 0xa9, 0xf7,
    0x21, 0xf2, 0xa2, 0x31, 0xd9, 0x41, 0x7e, 0xe8,
    0x29, 0xb3, 0x96, 0x03, 0x77, 0xa4, 0xd7, 0x50,
    0xa0, 0xf4, 0x4e, 0x3e, 0x32, 0x65, 0x26, 0xce,
]));

assert (KeyInfo.validPublished(
    1,
    1,
    7,
    publicKey,
    identity,
    fingerprint,
    Nat32.fromNat(39_199),
));
assert (not KeyInfo.validPublished(
    1,
    1,
    7,
    publicKey,
    identity,
    Fixture.repeatBlob(32, 0x22),
    Nat32.fromNat(39_199),
));

let configured : Memory.PublicKeyInfo = {
    protocol_version = 1;
    suite = 1;
    key_holder = Principal.fromText(
        "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe"
    );
    current_epoch = 7;
    current_fingerprint = fingerprint;
    context_public_key = publicKey;
    effective_ibe_identity = identity;
    max_envelope_bytes = Nat32.fromNat(39_199);
    previous_epoch = null;
    previous_fingerprint = null;
};
assert (KeyInfo.validConfigured(configured));
assert (not KeyInfo.validConfigured({
    configured with current_fingerprint = Fixture.repeatBlob(32, 0x22)
}));
assert (not KeyInfo.validConfigured({
    configured with key_holder = Principal.anonymous()
}));
assert (not KeyInfo.validConfigured({
    configured with
    previous_epoch = ?6;
    previous_fingerprint = ?fingerprint;
}));
assert (KeyInfo.validConfigured({
    configured with
    previous_epoch = ?6;
    previous_fingerprint = ?KeyInfo.fingerprint(1, 6, publicKey, identity);
}));
