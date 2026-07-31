import Map "mo:core/Map";
import Caps "mo:neutron-capabilities";
import CapabilityTypes "../capabilities/Types";

module {
    public type Algorithm = Caps.ChainKeyAlgorithmV1;

    // Compiler-owned environment resolution. Apps cannot name a threshold key
    // and the kernel never falls back when one algorithm is unavailable.
    public type KeyConfiguration = {
        ecdsa_secp256k1 : ?Text;
        schnorr_bip340secp256k1 : ?Text;
        schnorr_ed25519 : ?Text;
    };

    // Purpose is presentation-only. It is validated and shown at consent time,
    // but is deliberately absent from every cryptographic and authority
    // fingerprint so copy editing cannot rotate a key or reset accounting.
    public type SlotDeclaration = {
        id : Text;
        algorithm : Algorithm;
        purpose : Text;
        max_assertion_bytes : Nat;
    };

    public type Declaration = {
        slots : [SlotDeclaration];
    };

    public type AppDeclaration = {
        app_scope : CapabilityTypes.AppScope;
        chain_key_signing : ?Declaration;
    };

    public type AssertionKind = Caps.ChainKeyMessageFormatV1;
    public type PublicKeyInfo = Caps.ChainKeyPublicKeyV1;
    public type Signature = Caps.ChainKeySignatureV1;
    public type Error = Caps.ChainKeySigningErrorV1;
    public type PublicKeyResult = Caps.ChainKeyPublicKeyResultV1;
    public type SignRequest = Caps.ChainKeySignAssertionRequestV1;
    public type SignResult = Caps.ChainKeySignatureResultV1;

    // This is the complete app-facing leaf. It contains neither a management
    // actor nor a derivation path, key name, raw-digest operation, or BIP341
    // auxiliary input.
    public type Capability = Caps.ChainKeySigningV1;

    public type SlotState = {
        declaration_fingerprint : Text;
        identity_fingerprint : Text;
        cached_public_key : ?Blob;
    };

    public type Memory = {
        slots : Map.Map<Text, SlotState>;
    };

    public type AdapterPublicKeyRequest = {
        algorithm : Algorithm;
        key_name : Text;
        derivation_path : [Blob];
    };

    public type AdapterRawPublicKey = {
        public_key : Blob;
        chain_code : Blob;
    };

    public type AdapterSignRequest = {
        algorithm : Algorithm;
        key_name : Text;
        derivation_path : [Blob];
        digest : Blob;
        cycles : Nat;
    };

    public type AdapterFailureKind = { #definite; #outcome_unknown };
    public type AdapterFailure = {
        charged_cycles : Nat;
        kind : AdapterFailureKind;
    };

    public type AdapterPublicKeyResult = {
        #ok : AdapterRawPublicKey;
        #err : AdapterFailure;
    };

    public type AdapterSignature = {
        signature : Blob;
        charged_cycles : Nat;
    };

    public type AdapterSignResult = {
        #ok : AdapterSignature;
        #err : AdapterFailure;
    };

    public type QuoteResult = { #ok : Nat; #err };

    public type Adapter = {
        quote : (Algorithm, Text) -> QuoteResult;
        cycle_balance : () -> Nat;
        public_key : AdapterPublicKeyRequest -> async AdapterPublicKeyResult;
        sign : AdapterSignRequest -> async AdapterSignResult;
    };
}
