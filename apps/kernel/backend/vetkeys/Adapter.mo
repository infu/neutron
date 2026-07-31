import Cycles "mo:core/Cycles";
import IC "../aaa_interface";
import Types "Types";

module {
    public func management() : Types.Adapter {
        {
            random_nonce = randomNonce;
            public_key = publicKey;
            derive_key = deriveKey;
            cycle_balance = Cycles.balance;
        };
    };

    func randomNonce() : async Types.AdapterBlobResult {
        try {
            #ok(await IC.management.raw_rand());
        } catch (_) {
            #err;
        };
    };

    func publicKey(
        request : Types.AdapterPublicKeyRequest,
    ) : async Types.AdapterBlobResult {
        try {
            let result = await IC.management.vetkd_public_key({
                canister_id = null;
                context = request.context;
                key_id = {
                    curve = #bls12_381_g2;
                    name = request.key_name;
                };
            });
            #ok(result.public_key);
        } catch (_) {
            // Raw management reject text is deliberately not propagated.
            #err;
        };
    };

    func deriveKey(
        request : Types.AdapterDeriveRequest,
    ) : async Types.AdapterDeriveResult {
        try {
            let result = await (with cycles = request.cycles) IC.management.vetkd_derive_key({
                input = request.derivation_input;
                context = request.context;
                transport_public_key = request.transport_public_key;
                key_id = {
                    curve = #bls12_381_g2;
                    name = request.key_name;
                };
            });
            #ok({
                encrypted_key = result.encrypted_key;
                charged_cycles = charged(request.cycles);
            });
        } catch (_) {
            #err({ charged_cycles = charged(request.cycles) });
        };
    };

    func charged(attached : Nat) : Nat {
        let refunded = Cycles.refunded();
        if (refunded >= attached) 0 else attached - refunded;
    };
};
