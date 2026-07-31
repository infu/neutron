import Blob "mo:core/Blob";
import Nat32 "mo:core/Nat32";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Sha256 "mo:sha2/Sha256";
import Crypto "../../backend/crypto/Service";
import Memory "../../backend/memory/mail/v1";
import Envelope "../../backend/protocol/Envelope";
import KeyInfo "../../backend/protocol/KeyInfo";
import Fixture "Fixture";

module {
    public func canister(last : Nat8) : Principal {
        Principal.fromBlob(Blob.fromArray([0, last, 1]));
    };

    public func holder() : Principal {
        Principal.fromText(
            "pcofx-mj5y3-27jya-3jcsk-jzcy2-2y6yj-bvf32-ousik-tb3ks-uyjkz-rqe",
        );
    };
    public func otherHolder() : Principal {
        Principal.fromText(
            "ugnk3-oybq3-qsesh-kfxvo-pl2rt-y2h2x-bbtku-g6n4j-7xkvx-7l2u3-kae",
        );
    };
    public func public7() : Blob { Fixture.repeatBlob(96, 0x31) };
    public func identity7() : Blob { Fixture.repeatBlob(32, 0x32) };
    public func fingerprint7() : Blob {
        KeyInfo.fingerprint(1, 7, public7(), identity7());
    };
    public func public8() : Blob { Fixture.repeatBlob(96, 0x41) };
    public func identity8() : Blob { Fixture.repeatBlob(32, 0x42) };
    public func fingerprint8() : Blob {
        KeyInfo.fingerprint(1, 8, public8(), identity8());
    };
    public func kernelFingerprint7() : Blob {
        Sha256.fromBlob(#sha256, public7());
    };
    public func kernelFingerprint8() : Blob {
        Sha256.fromBlob(#sha256, public8());
    };
    public func wrapSettings7() : Blob { Fixture.repeatBlob(168, 0x51) };
    public func wrapInbox7() : Blob { Fixture.repeatBlob(168, 0x52) };
    public func wrapOutbox7() : Blob { Fixture.repeatBlob(168, 0x53) };
    public func wrapSettings8() : Blob { Fixture.repeatBlob(168, 0x61) };
    public func wrapInbox8() : Blob { Fixture.repeatBlob(168, 0x62) };
    public func wrapOutbox8() : Blob { Fixture.repeatBlob(168, 0x63) };

    public func summary(
        current : Nat64,
        previous : ?Nat64,
        status : Crypto.SlotStatus,
        keyHolder : Principal,
    ) : Crypto.SlotSummary {
        {
            slot = Crypto.SLOT_ID;
            purpose = "Private Mail";
            key_holder = keyHolder;
            status;
            environment = #local;
            current_generation = current;
            previous_generation = previous;
            generations = switch (previous) {
                case null [generation(current, #current)];
                case (?old) [generation(current, #current), generation(old, #previous)];
            };
            created_at = 1;
            updated_at = current;
            last_used_at = null;
            total_derivations = 0;
            approximate_cycle_spend = 0;
        };
    };

    public func material(generation : Nat64, valid : Bool) : Crypto.PublicKeyMaterial {
        {
            canister_principal = canister(1);
            slot = Crypto.SLOT_ID;
            generation;
            suite = if (valid) "bls12_381_g2" else "invalid";
            key_name = "test_key_1";
            public_key = if (generation == 7) public7() else public8();
            public_fingerprint = kernelFingerprint(generation);
            derivation_input = if (generation == 7) identity7() else identity8();
        };
    };

    public func configured8() : Memory.PublicKeyInfo {
        {
            protocol_version = Envelope.VERSION;
            suite = 1;
            key_holder = holder();
            current_epoch = 8;
            current_fingerprint = fingerprint8();
            context_public_key = public8();
            effective_ibe_identity = identity8();
            max_envelope_bytes = Nat32.fromNat(Envelope.MAX_ENVELOPE_BYTES);
            previous_epoch = ?7;
            previous_fingerprint = ?fingerprint7();
        };
    };

    public func inboxRecord() : Memory.InboxRecord {
        {
            local_id = 1;
            sender = canister(2);
            message_id = Fixture.repeatBlob(16, 0x11);
            delivery_key_epoch = 7;
            delivery_key_fingerprint = fingerprint7();
            local_wrap_epoch = 7;
            local_wrap_fingerprint = fingerprint7();
            local_wrapped_cek = wrapInbox7();
            envelope = Fixture.envelope(1_040, 1, 7, 0x22);
            received_at_ns = 1_000;
            read = false;
            known_at_receipt = true;
            retained_bytes = 1_552;
        };
    };

    public func outboxRecord() : Memory.OutboxRecord {
        {
            local_id = 2;
            command_id = Fixture.repeatBlob(16, 0x21);
            command_fingerprint = Fixture.repeatBlob(32, 0x22);
            recipient = canister(3);
            contact_id = null;
            contact_revision = null;
            message_id = Fixture.repeatBlob(16, 0x23);
            delivery_key_epoch = 91;
            delivery_key_fingerprint = Fixture.repeatBlob(32, 0x24);
            local_wrap_epoch = 7;
            local_wrap_fingerprint = fingerprint7();
            local_wrapped_cek = wrapOutbox7();
            envelope = Fixture.envelope(1_040, 1, 91, 0x24);
            created_at_ns = 2_000;
            updated_at_ns = 2_000;
            cleanup_epoch = 0;
            attempt_no = 1;
            attempt_request_id = null;
            state = #not_sent(#crypto_unavailable);
            retained_bytes = 2_064;
        };
    };

    public func settings() : Memory.EncryptedSettings {
        {
            record_id = Fixture.repeatBlob(16, 0x31);
            revision = 4;
            local_wrap_epoch = 7;
            local_wrap_fingerprint = fingerprint7();
            local_wrapped_cek = wrapSettings7();
            nonce = Fixture.repeatBlob(12, 0x32);
            ciphertext_and_tag = Fixture.repeatBlob(48, 0x33);
        };
    };

    func generation(
        epoch : Nat64,
        status : Crypto.GenerationStatus,
    ) : Crypto.GenerationSummary {
        {
            generation = epoch;
            status;
            key_name = "test_key_1";
            public_fingerprint = ?kernelFingerprint(epoch);
        };
    };

    func kernelFingerprint(epoch : Nat64) : Blob {
        if (epoch == 7) kernelFingerprint7() else kernelFingerprint8();
    };
};
