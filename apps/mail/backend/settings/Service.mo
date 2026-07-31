import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Memory "../memory/mail/v1";
import Envelope "../protocol/Envelope";
import KeyInfo "../protocol/KeyInfo";

module {
    public let RECORD_ID_BYTES = 16;
    public let MAX_LOCAL_WRAP_BYTES = 4_096;
    public let MAX_CIPHERTEXT_BYTES = 4_096;
    public let MIN_CIPHERTEXT_BYTES = 16;

    public type EncryptedSettings = {
        record_id : Blob;
        revision : Nat64;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
        nonce : Blob;
        ciphertext_and_tag : Blob;
    };

    public type Rewrap = {
        expected_revision : Nat64;
        local_wrap_epoch : Nat64;
        local_wrap_fingerprint : Blob;
        local_wrapped_cek : Blob;
    };

    public type Mutation = {
        #create : EncryptedSettings;
        #replace : {
            expected_revision : Nat64;
            settings : EncryptedSettings;
        };
        #rewrap : Rewrap;
    };

    public type Error = {
        #invalid_request;
        #not_configured;
        #corrupt_state;
        #revision_conflict : {
            expected : ?Nat64;
            actual : ?Nat64;
        };
    };

    public type GetResult = {
        #ok : ?EncryptedSettings;
        #err : Error;
    };

    public type SetResult = {
        #ok : EncryptedSettings;
        #err : Error;
    };

    public class Service(mem : Memory.Mem) {
        public func get() : GetResult {
            let keyInfo = switch (configuredKeyInfo(mem.key_info)) {
                case null return #err(#not_configured);
                case (?value) value;
            };
            switch (mem.encrypted_settings) {
                case null #ok(null);
                case (?stored) {
                    let settings = fromMemory(stored);
                    if (not validStored(settings, keyInfo)) {
                        #err(#corrupt_state);
                    } else #ok(?settings);
                };
            };
        };

        public func set(mutation : Mutation) : SetResult {
            let keyInfo = switch (configuredKeyInfo(mem.key_info)) {
                case null return #err(#not_configured);
                case (?value) value;
            };
            switch (mutation) {
                case (#create(settings)) create(settings, keyInfo);
                case (#replace(request)) replace(request, keyInfo);
                case (#rewrap(request)) rewrap(request, keyInfo);
            };
        };

        func create(
            settings : EncryptedSettings,
            keyInfo : Memory.PublicKeyInfo,
        ) : SetResult {
            switch (mem.encrypted_settings) {
                case (?current) {
                    return #err(#revision_conflict({
                        expected = null;
                        actual = ?current.revision;
                    }));
                };
                case null {};
            };
            if (
                settings.revision != 1 or
                not validInput(settings) or
                not targetsCurrentWrap(settings, keyInfo)
            ) return #err(#invalid_request);
            mem.encrypted_settings := ?toMemory(settings);
            #ok(settings);
        };

        func replace(
            request : {
                expected_revision : Nat64;
                settings : EncryptedSettings;
            },
            keyInfo : Memory.PublicKeyInfo,
        ) : SetResult {
            let currentMemory = switch (mem.encrypted_settings) {
                case null {
                    return #err(#revision_conflict({
                        expected = ?request.expected_revision;
                        actual = null;
                    }));
                };
                case (?value) value;
            };
            let current = fromMemory(currentMemory);
            if (not validStored(current, keyInfo)) return #err(#corrupt_state);
            if (request.expected_revision != current.revision) {
                return #err(#revision_conflict({
                    expected = ?request.expected_revision;
                    actual = ?current.revision;
                }));
            };
            if (
                not validInput(request.settings) or
                not targetsCurrentWrap(request.settings, keyInfo) or
                not Blob.equal(request.settings.record_id, current.record_id) or
                Nat64.toNat(request.settings.revision) != Nat64.toNat(current.revision) + 1 or
                Blob.equal(request.settings.nonce, current.nonce) or
                Blob.equal(request.settings.ciphertext_and_tag, current.ciphertext_and_tag) or
                Blob.equal(request.settings.local_wrapped_cek, current.local_wrapped_cek)
            ) return #err(#invalid_request);
            mem.encrypted_settings := ?toMemory(request.settings);
            #ok(request.settings);
        };

        func rewrap(
            request : Rewrap,
            keyInfo : Memory.PublicKeyInfo,
        ) : SetResult {
            let currentMemory = switch (mem.encrypted_settings) {
                case null {
                    return #err(#revision_conflict({
                        expected = ?request.expected_revision;
                        actual = null;
                    }));
                };
                case (?value) value;
            };
            let current = fromMemory(currentMemory);
            if (not validStored(current, keyInfo)) return #err(#corrupt_state);
            if (request.expected_revision != current.revision) {
                return #err(#revision_conflict({
                    expected = ?request.expected_revision;
                    actual = ?current.revision;
                }));
            };
            if (
                not validWrap(
                    request.local_wrap_epoch,
                    request.local_wrap_fingerprint,
                    request.local_wrapped_cek,
                ) or
                not targetsCurrent(
                    request.local_wrap_epoch,
                    request.local_wrap_fingerprint,
                    keyInfo,
                )
            ) return #err(#invalid_request);

            let updated : EncryptedSettings = {
                record_id = current.record_id;
                revision = current.revision;
                local_wrap_epoch = request.local_wrap_epoch;
                local_wrap_fingerprint = request.local_wrap_fingerprint;
                local_wrapped_cek = request.local_wrapped_cek;
                nonce = current.nonce;
                ciphertext_and_tag = current.ciphertext_and_tag;
            };
            if (
                current.local_wrap_epoch == updated.local_wrap_epoch and
                Blob.equal(current.local_wrap_fingerprint, updated.local_wrap_fingerprint) and
                Blob.equal(current.local_wrapped_cek, updated.local_wrapped_cek)
            ) return #ok(current);
            mem.encrypted_settings := ?toMemory(updated);
            #ok(updated);
        };
    };

    func configuredKeyInfo(value : ?Memory.PublicKeyInfo) : ?Memory.PublicKeyInfo {
        let ?info = value else return null;
        if (not KeyInfo.validConfigured(info)) return null;
        ?info;
    };

    func validInput(settings : EncryptedSettings) : Bool {
        settings.record_id.size() == RECORD_ID_BYTES and
        not isZero(settings.record_id) and
        settings.revision > 0 and
        validWrap(
            settings.local_wrap_epoch,
            settings.local_wrap_fingerprint,
            settings.local_wrapped_cek,
        ) and
        settings.nonce.size() == Envelope.NONCE_BYTES and
        not isZero(settings.nonce) and
        settings.ciphertext_and_tag.size() >= MIN_CIPHERTEXT_BYTES and
        settings.ciphertext_and_tag.size() <= MAX_CIPHERTEXT_BYTES and
        not isZero(settings.ciphertext_and_tag);
    };

    func validWrap(epoch : Nat64, fingerprint : Blob, wrappedCek : Blob) : Bool {
        epoch > 0 and
        fingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(fingerprint) and
        wrappedCek.size() > 0 and wrappedCek.size() <= MAX_LOCAL_WRAP_BYTES and
        not isZero(wrappedCek);
    };

    func validStored(
        settings : EncryptedSettings,
        keyInfo : Memory.PublicKeyInfo,
    ) : Bool {
        validInput(settings) and (
            targetsCurrentWrap(settings, keyInfo) or
            targetsPreviousWrap(settings, keyInfo)
        );
    };

    func targetsCurrentWrap(
        settings : EncryptedSettings,
        keyInfo : Memory.PublicKeyInfo,
    ) : Bool {
        targetsCurrent(
            settings.local_wrap_epoch,
            settings.local_wrap_fingerprint,
            keyInfo,
        );
    };

    func targetsCurrent(
        epoch : Nat64,
        fingerprint : Blob,
        keyInfo : Memory.PublicKeyInfo,
    ) : Bool {
        epoch == keyInfo.current_epoch and
        Blob.equal(fingerprint, keyInfo.current_fingerprint);
    };

    func targetsPreviousWrap(
        settings : EncryptedSettings,
        keyInfo : Memory.PublicKeyInfo,
    ) : Bool {
        switch (keyInfo.previous_epoch, keyInfo.previous_fingerprint) {
            case (?epoch, ?fingerprint) {
                settings.local_wrap_epoch == epoch and
                Blob.equal(settings.local_wrap_fingerprint, fingerprint);
            };
            case (_) false;
        };
    };

    func fromMemory(value : Memory.EncryptedSettings) : EncryptedSettings {
        value;
    };

    func toMemory(value : EncryptedSettings) : Memory.EncryptedSettings {
        value;
    };

    func isZero(value : Blob) : Bool {
        for (byte in value.vals()) if (byte != 0) return false;
        true;
    };
};
