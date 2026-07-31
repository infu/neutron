import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Principal "mo:core/Principal";
import Memory "../../backend/memory/mail/v1";
import Settings "../../backend/settings/Service";
import KeyInfo "../../backend/protocol/KeyInfo";
import Fixture "Fixture";

let HOLDER = Principal.fromText("pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe");
let PUBLIC_KEY = Fixture.repeatBlob(96, 0x31);
let IBE_IDENTITY = Fixture.repeatBlob(32, 0x32);

func fingerprint(epoch : Nat64) : Blob {
    KeyInfo.fingerprint(1, epoch, PUBLIC_KEY, IBE_IDENTITY);
};

func configure(
    mem : Memory.Mem,
    epoch : Nat64,
    previousEpoch : ?Nat64,
) {
    mem.key_info := ?{
        protocol_version = 1;
        suite = 1;
        key_holder = HOLDER;
        current_epoch = epoch;
        current_fingerprint = fingerprint(epoch);
        context_public_key = PUBLIC_KEY;
        effective_ibe_identity = IBE_IDENTITY;
        max_envelope_bytes = Nat32.fromNat(39_199);
        previous_epoch = previousEpoch;
        previous_fingerprint = switch (previousEpoch) {
            case null null;
            case (?value) ?fingerprint(value);
        };
    };
};

func encrypted(
    revision : Nat64,
    epoch : Nat64,
    wrapFingerprint : Blob,
    wrapByte : Nat8,
    nonceByte : Nat8,
    ciphertextByte : Nat8,
) : Settings.EncryptedSettings {
    {
        record_id = Fixture.repeatBlob(16, 0x11);
        revision;
        local_wrap_epoch = epoch;
        local_wrap_fingerprint = wrapFingerprint;
        local_wrapped_cek = Fixture.repeatBlob(168, wrapByte);
        nonce = Fixture.repeatBlob(12, nonceByte);
        ciphertext_and_tag = Fixture.repeatBlob(32, ciphertextByte);
    };
};

func expectInvalid(result : Settings.SetResult) {
    switch (result) {
        case (#err(#invalid_request)) {};
        case (_) assert false;
    };
};

// Setup is mandatory and anonymous key holders are not accepted.
do {
    let mem = Memory.init();
    let service = Settings.Service(mem);
    switch (service.get()) {
        case (#err(#not_configured)) {};
        case (_) assert false;
    };
    switch (service.set(#create(encrypted(1, 7, fingerprint(7), 0x41, 0x51, 0x61)))) {
        case (#err(#not_configured)) {};
        case (_) assert false;
    };
    configure(mem, 7, null);
    switch (mem.key_info) {
        case null assert false;
        case (?info) {
            mem.key_info := ?{ info with key_holder = Principal.anonymous() };
        };
    };
    switch (service.get()) {
        case (#err(#not_configured)) {};
        case (_) assert false;
    };
};

// A shape-correct but noncanonical cached fingerprint is not configured.
do {
    let mem = Memory.init();
    configure(mem, 7, null);
    switch (mem.key_info) {
        case null assert false;
        case (?info) {
            mem.key_info := ?{
                info with current_fingerprint = Fixture.repeatBlob(32, 0x22)
            };
        };
    };
    let service = Settings.Service(mem);
    switch (service.get()) {
        case (#err(#not_configured)) {};
        case (_) assert false;
    };
};

// Create and replace use an independent optimistic settings revision.
do {
    let mem = Memory.init();
    mem.revision := 17;
    configure(mem, 7, null);
    let service = Settings.Service(mem);
    switch (service.get()) {
        case (#ok(null)) {};
        case (_) assert false;
    };
    let first = encrypted(1, 7, fingerprint(7), 0x41, 0x51, 0x61);
    switch (service.set(#create(first))) {
        case (#ok(value)) assert (value == first);
        case (_) assert false;
    };
    assert (mem.revision == 17);
    switch (service.set(#create(first))) {
        case (#err(#revision_conflict(conflict))) {
            assert (conflict.expected == null and conflict.actual == ?1);
        };
        case (_) assert false;
    };

    let second = encrypted(2, 7, fingerprint(7), 0x42, 0x52, 0x62);
    switch (service.set(#replace({ expected_revision = 2; settings = second }))) {
        case (#err(#revision_conflict(conflict))) {
            assert (conflict.expected == ?2 and conflict.actual == ?1);
        };
        case (_) assert false;
    };
    expectInvalid(service.set(#replace({
        expected_revision = 1;
        settings = { second with record_id = Fixture.repeatBlob(16, 0x12) };
    })));
    expectInvalid(service.set(#replace({
        expected_revision = 1;
        settings = { second with nonce = first.nonce };
    })));
    expectInvalid(service.set(#replace({
        expected_revision = 1;
        settings = { second with revision = 1 };
    })));
    switch (service.set(#replace({ expected_revision = 1; settings = second }))) {
        case (#ok(value)) assert (value == second);
        case (_) assert false;
    };
    assert (mem.revision == 17);
    switch (service.get()) {
        case (#ok(?value)) assert (value == second);
        case (_) assert false;
    };

    // Rotation rewrap cannot carry or mutate encrypted content or its revision.
    configure(mem, 8, ?7);
    let rewrap : Settings.Rewrap = {
        expected_revision = 2;
        local_wrap_epoch = 8;
        local_wrap_fingerprint = fingerprint(8);
        local_wrapped_cek = Fixture.repeatBlob(168, 0x43);
    };
    switch (service.set(#rewrap(rewrap))) {
        case (#ok(value)) {
            assert (value.revision == 2 and value.record_id == second.record_id);
            assert (value.nonce == second.nonce);
            assert (value.ciphertext_and_tag == second.ciphertext_and_tag);
            assert (value.local_wrap_epoch == 8);
        };
        case (_) assert false;
    };
    // Replaying an already-applied rewrap is idempotent.
    switch (service.set(#rewrap(rewrap))) {
        case (#ok(value)) assert (value.revision == 2);
        case (_) assert false;
    };
    expectInvalid(service.set(#rewrap({ rewrap with
        local_wrap_epoch = 7;
        local_wrap_fingerprint = fingerprint(7);
    })));
    switch (service.set(#rewrap({ rewrap with expected_revision = 1 }))) {
        case (#err(#revision_conflict(conflict))) {
            assert (conflict.expected == ?1 and conflict.actual == ?2);
        };
        case (_) assert false;
    };
    assert (mem.revision == 17);
};

// Fixed sizes, bounds, and nonzero cryptographic fields fail closed.
do {
    let mem = Memory.init();
    configure(mem, 7, null);
    let service = Settings.Service(mem);
    let valid = encrypted(1, 7, fingerprint(7), 0x41, 0x51, 0x61);
    expectInvalid(service.set(#create({
        valid with record_id = Fixture.repeatBlob(15, 0x11)
    })));
    expectInvalid(service.set(#create({
        valid with record_id = Fixture.repeatBlob(16, 0)
    })));
    expectInvalid(service.set(#create({
        valid with nonce = Fixture.repeatBlob(11, 0x51)
    })));
    expectInvalid(service.set(#create({
        valid with ciphertext_and_tag = Fixture.repeatBlob(15, 0x61)
    })));
    expectInvalid(service.set(#create({
        valid with local_wrapped_cek = Fixture.repeatBlob(4_097, 0x41)
    })));
    expectInvalid(service.set(#create({
        valid with local_wrap_fingerprint = Fixture.repeatBlob(31, 0x22)
    })));
    assert (mem.encrypted_settings == null);
};

// Invalid retained state is reported, never overwritten as a normal edit.
do {
    let mem = Memory.init();
    configure(mem, 7, null);
    let service = Settings.Service(mem);
    mem.encrypted_settings := ?{
        record_id = Fixture.repeatBlob(15, 0x11);
        revision = 1;
        local_wrap_epoch = 7;
        local_wrap_fingerprint = fingerprint(7);
        local_wrapped_cek = Fixture.repeatBlob(168, 0x41);
        nonce = Fixture.repeatBlob(12, 0x51);
        ciphertext_and_tag = Fixture.repeatBlob(32, 0x61);
    };
    switch (service.get()) {
        case (#err(#corrupt_state)) {};
        case (_) assert false;
    };
    switch (service.set(#replace({
        expected_revision = 1;
        settings = encrypted(2, 7, fingerprint(7), 0x42, 0x52, 0x62);
    }))) {
        case (#err(#corrupt_state)) {};
        case (_) assert false;
    };
};
