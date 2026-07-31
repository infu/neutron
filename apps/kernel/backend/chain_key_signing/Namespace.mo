import Blob "mo:core/Blob";
import Array "mo:core/Array";
import List "mo:core/List";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Sha256 "mo:sha2/Sha256";
import CapabilityScope "../capabilities/Scope";
import Types "Types";

module {
    public let VERSION : Nat = 1;
    public let APP_ASSERTION_TAG : Blob = "neutron_app_assertion_v1";

    let KEY_DOMAIN : Blob = "neutron.chain-key-signing.key.v1";
    let ASSERTION_DOMAIN_DOMAIN : Blob =
        "neutron.chain-key-signing.assertion-domain.v1";
    let ASSERTION_DOMAIN : Blob = "neutron.chain-key-signing.assertion.v1";
    let AUTHORITY_DOMAIN : Blob =
        "neutron.chain-key-signing.slot-authority.v1";
    let PUBLIC_KEY_DOMAIN : Blob =
        "neutron.chain-key-signing.public-key.v1";
    let MAX_U32 : Nat = 4_294_967_295;
    let HEX = [
        "0", "1", "2", "3", "4", "5", "6", "7",
        "8", "9", "a", "b", "c", "d", "e", "f",
    ];

    public type Input = {
        install_epoch : Nat64;
        canister : Principal;
        app_scope : {
            app_id : Text;
            installation_uid : Nat64;
        };
        slot_id : Text;
        algorithm : Types.Algorithm;
        key_name : Text;
    };

    public type Material = {
        namespace_version : Nat;
        derivation_path : [Blob];
        signing_domain : Blob;
        identity_fingerprint : Text;
    };

    public type BuildResult = {
        #ok : Material;
        #err : { #invalid_input };
    };

    // Every item, including the fixed domain and integer encodings, has an
    // unsigned four-byte big-endian length. This makes the byte format
    // independently reproducible and prevents concatenation ambiguities.
    public func build(input : Input) : BuildResult {
        if (
            input.app_scope.installation_uid == 0 or
            not validAppId(input.app_scope.app_id) or
            not validSlotId(input.slot_id) or
            not validKeyName(input.key_name)
        ) return #err(#invalid_input);

        let namespace = hashParts([
            KEY_DOMAIN,
            u64(input.install_epoch),
            Principal.toBlob(input.canister),
            Text.encodeUtf8(input.app_scope.app_id),
            u64(input.app_scope.installation_uid),
            Text.encodeUtf8(input.slot_id),
            Text.encodeUtf8(algorithmText(input.algorithm)),
            Text.encodeUtf8(input.key_name),
            APP_ASSERTION_TAG,
        ]);
        let signingDomain = hashParts([
            ASSERTION_DOMAIN_DOMAIN,
            namespace,
            APP_ASSERTION_TAG,
        ]);
        #ok({
            namespace_version = VERSION;
            derivation_path = [namespace];
            signing_domain = signingDomain;
            identity_fingerprint = hex(namespace);
        });
    };

    public func assertionDigest(
        signingDomain : Blob,
        assertion : Blob,
    ) : ?Blob {
        if (signingDomain.size() != 32 or assertion.size() > MAX_U32) {
            return null;
        };
        ?hashParts([ASSERTION_DOMAIN, signingDomain, assertion]);
    };

    public func authorityFingerprint(
        declaration : Types.SlotDeclaration,
    ) : Text {
        hex(hashParts([
            AUTHORITY_DOMAIN,
            Text.encodeUtf8(declaration.id),
            Text.encodeUtf8(algorithmText(declaration.algorithm)),
            u64(Nat.toNat64(declaration.max_assertion_bytes)),
        ]));
    };

    public func keyFingerprint(
        algorithm : Types.Algorithm,
        normalizedPublicKey : Blob,
    ) : Blob {
        hashParts([
            PUBLIC_KEY_DOMAIN,
            Text.encodeUtf8(algorithmText(algorithm)),
            normalizedPublicKey,
        ]);
    };

    public func algorithmText(algorithm : Types.Algorithm) : Text {
        switch (algorithm) {
            case (#ecdsa_secp256k1) "ecdsa_secp256k1";
            case (#schnorr_bip340secp256k1) "schnorr_bip340secp256k1";
            case (#schnorr_ed25519) "schnorr_ed25519";
        };
    };

    public func hashParts(parts : [Blob]) : Blob {
        let bytes = List.empty<Nat8>();
        for (part in parts.vals()) appendLengthPrefixed(bytes, part);
        Sha256.fromBlob(#sha256, Array.toBlob(List.toArray(bytes)));
    };

    public func hex(value : Blob) : Text {
        var result = "";
        for (byte in value.values()) {
            let natural = Nat8.toNat(byte);
            result #= HEX[natural / 16] # HEX[natural % 16];
        };
        result;
    };

    public func validSlotId(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 40) return false;
        var first = true;
        for (char in value.chars()) {
            if (first) {
                if (char < 'a' or char > 'z') return false;
                first := false;
            } else if (not (
                (char >= 'a' and char <= 'z') or
                (char >= '0' and char <= '9') or char == '_'
            )) return false;
        };
        true;
    };

    public func validKeyName(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 64) return false;
        for (char in value.chars()) {
            if (not (
                (char >= 'a' and char <= 'z') or
                (char >= 'A' and char <= 'Z') or
                (char >= '0' and char <= '9') or
                char == '_' or char == '-'
            )) return false;
        };
        true;
    };

    func validAppId(value : Text) : Bool {
        CapabilityScope.validAppId(value);
    };

    func appendLengthPrefixed(target : List.List<Nat8>, value : Blob) : () {
        assert (value.size() <= MAX_U32);
        appendU32(target, value.size());
        for (byte in value.values()) List.add(target, byte);
    };

    func appendU32(target : List.List<Nat8>, value : Nat) : () {
        List.add(target, Nat.toNat8((value / 16_777_216) % 256));
        List.add(target, Nat.toNat8((value / 65_536) % 256));
        List.add(target, Nat.toNat8((value / 256) % 256));
        List.add(target, Nat.toNat8(value % 256));
    };

    func u64(value : Nat64) : Blob {
        let bytes = List.empty<Nat8>();
        let natural = Nat64.toNat(value);
        var divisor : Nat = 72_057_594_037_927_936; // 256^7
        var index = 0;
        while (index < 8) {
            List.add(bytes, Nat.toNat8((natural / divisor) % 256));
            if (divisor > 1) divisor /= 256;
            index += 1;
        };
        Array.toBlob(List.toArray(bytes));
    };
}
