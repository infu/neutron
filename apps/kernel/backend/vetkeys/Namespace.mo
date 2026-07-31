import Blob "mo:core/Blob";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import List "mo:core/List";
import Sha256 "mo:sha2/Sha256";
import Scope "../capabilities/Scope";

module {
    public let VERSION : Nat = 1;
    public let NONCE_BYTES : Nat = 32;

    let CONTEXT_DOMAIN : Blob = "neutron.vetkeys.slot-context.v1";
    let IDENTITY_DOMAIN : Blob = "neutron.vetkeys.slot-identity.v1";
    let MAX_U32 : Nat = 4_294_967_295;

    public type Input = {
        canister : Principal;
        app_id : Text;
        installation_uid : Nat64;
        slot_id : Text;
        namespace_nonce : Blob;
        generation : Nat64;
    };

    public type Material = {
        namespace_version : Nat;
        context : Blob;
        derivation_input : Blob;
    };

    public type Result = {
        #ok : Material;
        #err : { #invalid_input };
    };

    // Canonical V1 context encoding uses a four-byte unsigned big-endian
    // length before every byte string and an eight-byte unsigned big-endian
    // generation. The fixed 32-byte context is appended raw to the
    // length-prefixed identity domain. Any change requires a new version.
    public func build(input : Input) : Result {
        if (
            input.namespace_nonce.size() != NONCE_BYTES or
            input.installation_uid == 0 or
            not validAppId(input.app_id) or
            not validSlotId(input.slot_id)
        ) return #err(#invalid_input);

        let contextBytes = List.empty<Nat8>();
        appendLengthPrefixed(contextBytes, CONTEXT_DOMAIN);
        appendLengthPrefixed(contextBytes, Principal.toBlob(input.canister));
        appendLengthPrefixed(contextBytes, Text.encodeUtf8(input.app_id));
        appendU64(contextBytes, input.installation_uid);
        appendLengthPrefixed(contextBytes, Text.encodeUtf8(input.slot_id));
        appendLengthPrefixed(contextBytes, input.namespace_nonce);
        appendU64(contextBytes, input.generation);
        let context = Sha256.fromBlob(
            #sha256,
            Blob.fromArray(List.toArray(contextBytes)),
        );

        let identityBytes = List.empty<Nat8>();
        appendLengthPrefixed(identityBytes, IDENTITY_DOMAIN);
        for (byte in context.values()) List.add(identityBytes, byte);
        let derivationInput = Sha256.fromBlob(
            #sha256,
            Blob.fromArray(List.toArray(identityBytes)),
        );

        #ok({
            namespace_version = VERSION;
            context;
            derivation_input = derivationInput;
        });
    };

    func appendLengthPrefixed(target : List.List<Nat8>, value : Blob) : () {
        assert (value.size() <= MAX_U32);
        appendU32(target, value.size());
        for (byte in value.values()) List.add(target, byte);
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

    func validAppId(value : Text) : Bool {
        Scope.validAppId(value);
    };

    func validSlotId(value : Text) : Bool {
        if (value.size() < 1 or value.size() > 40) return false;
        var first = true;
        for (char in value.chars()) {
            if (first and not (char >= 'a' and char <= 'z')) return false;
            if (
                not (
                    (char >= 'a' and char <= 'z') or
                    (char >= '0' and char <= '9') or
                    char == '_'
                )
            ) return false;
            first := false;
        };
        true;
    };

};
