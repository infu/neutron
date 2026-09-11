import Array "mo:core/Array";
import Blob "mo:core/Blob";
import List "mo:core/List";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Sha256 "mo:sha2/Sha256";

module {
    public let SLOT = "read_access";
    // The durable root is revoked through the protocol, not a login timer.
    // IC delegations require an expiration field; this is its largest Nat64.
    public let EXPIRATION : Nat64 = 18_446_744_073_709_551_615;
    // Only the Ed25519 browser signer is delegated, with its canonical SPKI.
    public func validSessionKey(publicKey : Blob) : Bool {
        let prefix : Blob = "\30\2a\30\05\06\03\2b\65\70\03\21\00";
        if (publicKey.size() != 44) return false;
        var i = 0;
        for (byte in prefix.values()) {
            if (publicKey[i] != byte) return false;
            i += 1;
        };
        true;
    };

    func concat(parts : [Blob]) : Blob {
        let bytes = List.empty<Nat8>();
        for (part in parts.vals()) for (byte in part.values()) List.add(bytes, byte);
        Blob.fromArray(List.toArray(bytes));
    };
    func hash(value : Blob) : Blob { Sha256.fromBlob(#sha256, value) };
    func unsignedLeb128(value : Nat64) : Blob {
        let bytes = List.empty<Nat8>();
        var remaining = Nat64.toNat(value);
        loop {
            let byte = remaining % 128;
            remaining /= 128;
            List.add(bytes, Nat8.fromNat(byte + (if (remaining == 0) 0 else 128)));
            if (remaining == 0) return Blob.fromArray(List.toArray(bytes));
        };
    };

    // IC representation-independent map hash. targets is an array containing
    // exactly the configured protocol; no caller supplies a target or digest.
    public func delegationHash(publicKey : Blob, target : Principal) : Blob {
        let fields : [(Blob, Blob)] = [
            (hash("pubkey"), hash(publicKey)),
            (hash("expiration"), hash(unsignedLeb128(EXPIRATION))),
            (hash("targets"), hash(hash(Principal.toBlob(target)))),
        ];
        let ordered = Array.sort<(Blob, Blob)>(fields, func(a, b) { Blob.compare(a.0, b.0) });
        hash(concat(Array.map<(Blob, Blob), Blob>(ordered, func(field) { concat([field.0, field.1]) })));
    };
    public func signingDigest(publicKey : Blob, target : Principal) : Blob {
        hash(concat(["\1aic-request-auth-delegation", delegationHash(publicKey, target)]));
    };
};
