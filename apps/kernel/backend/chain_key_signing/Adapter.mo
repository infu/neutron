import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Nat32 "mo:core/Nat32";
import Prim "mo:prim";
import IC "../aaa_interface";
import Types "Types";

module {
    let ECDSA_SECP256K1_ENCODING : Nat32 = 0;
    let SCHNORR_BIP340_SECP256K1_ENCODING : Nat32 = 0;
    let SCHNORR_ED25519_ENCODING : Nat32 = 1;

    public func management() : Types.Adapter {
        {
            quote = quote;
            cycle_balance = Cycles.balance;
            public_key = publicKey;
            sign = sign;
        };
    };

    public func quote(
        algorithm : Types.Algorithm,
        keyName : Text,
    ) : Types.QuoteResult {
        let (code, cycles) = switch (algorithm) {
            case (#ecdsa_secp256k1) {
                Prim.costSignWithEcdsa(keyName, ECDSA_SECP256K1_ENCODING);
            };
            case (#schnorr_bip340secp256k1) {
                Prim.costSignWithSchnorr(
                    keyName,
                    SCHNORR_BIP340_SECP256K1_ENCODING,
                );
            };
            case (#schnorr_ed25519) {
                Prim.costSignWithSchnorr(keyName, SCHNORR_ED25519_ENCODING);
            };
        };
        if (code == 0) #ok(cycles) else #err;
    };

    func publicKey(
        request : Types.AdapterPublicKeyRequest,
    ) : async Types.AdapterPublicKeyResult {
        if (not validPath(request.derivation_path)) {
            return #err({ charged_cycles = 0; kind = #definite });
        };
        switch (request.algorithm) {
            case (#ecdsa_secp256k1) {
                try {
                    let response = await IC.management.ecdsa_public_key({
                        canister_id = null;
                        derivation_path = request.derivation_path;
                        key_id = { curve = #secp256k1; name = request.key_name };
                    });
                    #ok(response);
                } catch (_) {
                    #err({ charged_cycles = 0; kind = #definite });
                };
            };
            case (#schnorr_bip340secp256k1) {
                try {
                    let response = await IC.management.schnorr_public_key({
                        canister_id = null;
                        derivation_path = request.derivation_path;
                        key_id = {
                            algorithm = #bip340secp256k1;
                            name = request.key_name;
                        };
                    });
                    #ok(response);
                } catch (_) {
                    #err({ charged_cycles = 0; kind = #definite });
                };
            };
            case (#schnorr_ed25519) {
                try {
                    let response = await IC.management.schnorr_public_key({
                        canister_id = null;
                        derivation_path = request.derivation_path;
                        key_id = {
                            algorithm = #ed25519;
                            name = request.key_name;
                        };
                    });
                    #ok(response);
                } catch (_) {
                    #err({ charged_cycles = 0; kind = #definite });
                };
            };
        };
    };

    func sign(request : Types.AdapterSignRequest) : async Types.AdapterSignResult {
        if (request.digest.size() != 32 or not validPath(request.derivation_path)) {
            return #err({ charged_cycles = 0; kind = #definite });
        };
        switch (request.algorithm) {
            case (#ecdsa_secp256k1) {
                try {
                    let response = await (with cycles = request.cycles)
                        IC.management.sign_with_ecdsa({
                            message_hash = request.digest;
                            derivation_path = request.derivation_path;
                            key_id = {
                                curve = #secp256k1;
                                name = request.key_name;
                            };
                        });
                    #ok({
                        signature = response.signature;
                        charged_cycles = charged(request.cycles);
                    });
                } catch (cause) {
                    #err({
                        charged_cycles = charged(request.cycles);
                        kind = if (unknownOutcomeCode(Error.code(cause))) {
                            #outcome_unknown;
                        } else #definite;
                    });
                };
            };
            case (#schnorr_bip340secp256k1) {
                try {
                    let response = await (with cycles = request.cycles)
                        IC.management.sign_with_schnorr({
                            message = request.digest;
                            derivation_path = request.derivation_path;
                            key_id = {
                                algorithm = #bip340secp256k1;
                                name = request.key_name;
                            };
                            // BIP341 transaction/taproot signing is not part
                            // of assertion-only V1.
                            aux = null;
                        });
                    #ok({
                        signature = response.signature;
                        charged_cycles = charged(request.cycles);
                    });
                } catch (cause) {
                    #err({
                        charged_cycles = charged(request.cycles);
                        kind = if (unknownOutcomeCode(Error.code(cause))) {
                            #outcome_unknown;
                        } else #definite;
                    });
                };
            };
            case (#schnorr_ed25519) {
                try {
                    let response = await (with cycles = request.cycles)
                        IC.management.sign_with_schnorr({
                            message = request.digest;
                            derivation_path = request.derivation_path;
                            key_id = {
                                algorithm = #ed25519;
                                name = request.key_name;
                            };
                            aux = null;
                        });
                    #ok({
                        signature = response.signature;
                        charged_cycles = charged(request.cycles);
                    });
                } catch (cause) {
                    #err({
                        charged_cycles = charged(request.cycles);
                        kind = if (unknownOutcomeCode(Error.code(cause))) {
                            #outcome_unknown;
                        } else #definite;
                    });
                };
            };
        };
    };

    public func unknownOutcomeCode(code : Error.ErrorCode) : Bool {
        switch (code) {
            case (#system_unknown) true;
            case (#canister_error) true;
            case (_) false;
        };
    };

    func validPath(path : [Blob]) : Bool {
        path.size() == 1 and path[0].size() == 32;
    };

    func charged(attached : Nat) : Nat {
        let refunded = Cycles.refunded();
        if (refunded >= attached) 0 else attached - refunded;
    };
}
