import Iter "mo:core/Iter";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import NeutronCapabilities "mo:neutron-capabilities";

module {
    public func read(backendCalls : NeutronCapabilities.BackendCallsV1, target : Principal) : async* Text {
        if (not backendCalls.can_call(target, "get_network_economics_parameters")) {
            return "Reserve exact get_network_economics_parameters access for this canister first";
        };
        switch (await* backendCalls.call({
            canister = target;
            method = "get_network_economics_parameters";
            args = to_candid ();
            cycles = 1_000_000;
        })) {
            case (#err(error)) {
                "Backend call failed (" # Text.fromIter(Iter.take(error.code.chars(), 64)) # "): " #
                Text.fromIter(Iter.take(error.message.chars(), 256));
            };
            case (#ok(reply)) {
                // Decode the two displayed fields from NNS Governance's
                // NetworkEconomics record; other parameters remain unused.
                let decoded : ?{
                    transaction_fee_e8s : Nat64;
                    neuron_minimum_stake_e8s : Nat64;
                } = from_candid reply;
                switch (decoded) {
                    case (?economics) {
                        "NNS Governance reports a transaction fee of " # Nat64.toText(economics.transaction_fee_e8s) #
                        " e8s and a minimum neuron stake of " # Nat64.toText(economics.neuron_minimum_stake_e8s) # " e8s" #
                        ". The demo attached 1,000,000 cycles; a canister that accepts none refunds them."
                    };
                    case null "The canister returned an invalid get_network_economics_parameters reply";
                };
            };
        };
    };
}
