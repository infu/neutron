import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat16 "mo:core/Nat16";
import Nat32 "mo:core/Nat32";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";

// Frozen explicit encoders for persistent/idempotency hashes. Never hash
// `to_candid`: equivalent Candid and compiler versions may use different bytes.
module {
    public func publicInfo(
        recipient : Principal,
        protocolVersion : Nat8,
        suite : Nat16,
        deliveryKeyEpoch : Nat64,
        contextPublicKey : Blob,
        effectiveIbeIdentity : Blob,
        recipientKeyFingerprint : Blob,
        maxEnvelopeBytes : Nat32,
    ) : Blob {
        let bytes = start("neutron-mail-public-info-v1");
        appendPrincipal(bytes, recipient);
        List.add(bytes, protocolVersion);
        appendU16(bytes, Nat16.toNat(suite));
        appendU64(bytes, Nat64.toNat(deliveryKeyEpoch));
        appendLengthPrefixed(bytes, contextPublicKey);
        appendLengthPrefixed(bytes, effectiveIbeIdentity);
        appendLengthPrefixed(bytes, recipientKeyFingerprint);
        appendU32(bytes, Nat32.toNat(maxEnvelopeBytes));
        digest(bytes);
    };

    public func command(
        commandId : Blob,
        permitId : Blob,
        recipient : Principal,
        publicInfoHash : Blob,
        envelope : Blob,
        localWrapEpoch : Nat64,
        localWrapFingerprint : Blob,
        localWrappedCek : Blob,
    ) : Blob {
        let bytes = start("neutron-mail-command-v1");
        appendLengthPrefixed(bytes, commandId);
        appendLengthPrefixed(bytes, permitId);
        appendPrincipal(bytes, recipient);
        appendLengthPrefixed(bytes, publicInfoHash);
        appendLengthPrefixed(bytes, envelope);
        appendU64(bytes, Nat64.toNat(localWrapEpoch));
        appendLengthPrefixed(bytes, localWrapFingerprint);
        appendLengthPrefixed(bytes, localWrappedCek);
        digest(bytes);
    };

    public func permit(
        requestId : Blob,
        generation : Nat,
        selfCanister : Principal,
    ) : Blob {
        let bytes = start("neutron-mail-permit-v1");
        appendLengthPrefixed(bytes, requestId);
        appendNatural(bytes, generation);
        appendPrincipal(bytes, selfCanister);
        digest(bytes);
    };

    func start(domain : Text) : List.List<Nat8> {
        let bytes = List.empty<Nat8>();
        appendLengthPrefixed(bytes, Text.encodeUtf8(domain));
        bytes;
    };

    func digest(bytes : List.List<Nat8>) : Blob {
        Sha256.fromBlob(#sha256, Blob.fromArray(List.toArray(bytes)));
    };

    func appendPrincipal(target : List.List<Nat8>, principal : Principal) : () {
        appendLengthPrefixed(target, Principal.toBlob(principal));
    };

    func appendLengthPrefixed(target : List.List<Nat8>, value : Blob) : () {
        appendU32(target, value.size());
        for (byte in value.values()) List.add(target, byte);
    };

    // Minimal unsigned big-endian natural, itself u32 length-prefixed. This
    // keeps the durable permit generation unbounded without modulo collisions.
    func appendNatural(target : List.List<Nat8>, value : Nat) : () {
        if (value == 0) {
            appendU32(target, 1);
            List.add(target, 0 : Nat8);
            return;
        };
        let littleEndian = List.empty<Nat8>();
        var remaining = value;
        while (remaining > 0) {
            List.add(littleEndian, Nat8.fromNat(remaining % 256));
            remaining /= 256;
        };
        let bytes = List.toArray(littleEndian);
        appendU32(target, bytes.size());
        var index = bytes.size();
        while (index > 0) {
            index -= 1;
            List.add(target, bytes[index]);
        };
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
