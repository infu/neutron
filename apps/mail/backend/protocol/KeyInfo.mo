import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import Memory "../memory/mail/v1";
import Envelope "Envelope";

module {
    public let MAX_PUBLIC_FIELD_BYTES = 4_096;

    // Frozen protocol fingerprint. Length prefixes are unsigned u32be; suite
    // and epoch are unsigned big-endian integers.
    public func fingerprint(
        suite : Nat16,
        epoch : Nat64,
        contextPublicKey : Blob,
        effectiveIbeIdentity : Blob,
    ) : Blob {
        let bytes = List.empty<Nat8>();
        appendLengthPrefixed(bytes, Text.encodeUtf8("neutron-mail-key-info-v1"));
        appendU16(bytes, Nat16.toNat(suite));
        appendU64(bytes, epoch);
        appendLengthPrefixed(bytes, contextPublicKey);
        appendLengthPrefixed(bytes, effectiveIbeIdentity);
        Sha256.fromBlob(#sha256, Blob.fromArray(List.toArray(bytes)));
    };

    public func validPublished(
        protocolVersion : Nat8,
        suite : Nat16,
        epoch : Nat64,
        contextPublicKey : Blob,
        effectiveIbeIdentity : Blob,
        recipientFingerprint : Blob,
        maxEnvelopeBytes : Nat32,
    ) : Bool {
        protocolVersion == Envelope.VERSION and
        suite == 1 and
        epoch > 0 and
        bounded(contextPublicKey) and
        bounded(effectiveIbeIdentity) and
        recipientFingerprint.size() == Envelope.FINGERPRINT_BYTES and
        not isZero(recipientFingerprint) and
        Blob.equal(
            recipientFingerprint,
            fingerprint(suite, epoch, contextPublicKey, effectiveIbeIdentity),
        ) and
        Nat32.toNat(maxEnvelopeBytes) == Envelope.MAX_ENVELOPE_BYTES;
    };

    public func validConfigured(info : Memory.PublicKeyInfo) : Bool {
        not Principal.isAnonymous(info.key_holder) and
        validPublished(
            info.protocol_version,
            info.suite,
            info.current_epoch,
            info.context_public_key,
            info.effective_ibe_identity,
            info.current_fingerprint,
            info.max_envelope_bytes,
        ) and
        validPrevious(info);
    };

    public func validPrevious(info : Memory.PublicKeyInfo) : Bool {
        switch (info.previous_epoch, info.previous_fingerprint) {
            case (null, null) true;
            case (?epoch, ?previousFingerprint) {
                epoch > 0 and
                epoch != info.current_epoch and
                previousFingerprint.size() == Envelope.FINGERPRINT_BYTES and
                not isZero(previousFingerprint) and
                not Blob.equal(previousFingerprint, info.current_fingerprint);
            };
            case (_) false;
        };
    };

    public func isZero(value : Blob) : Bool {
        for (byte in value.values()) if (byte != 0) return false;
        true;
    };

    func bounded(value : Blob) : Bool {
        value.size() > 0 and value.size() <= MAX_PUBLIC_FIELD_BYTES;
    };

    func appendLengthPrefixed(target : List.List<Nat8>, value : Blob) : () {
        appendU32(target, value.size());
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

    func appendU64(target : List.List<Nat8>, value : Nat64) : () {
        let natural = Nat64.toNat(value);
        var divisor : Nat = 72_057_594_037_927_936; // 256^7
        var index = 0;
        while (index < 8) {
            List.add(target, Nat8.fromNat((natural / divisor) % 256));
            if (divisor > 1) divisor /= 256;
            index += 1;
        };
    };
};
