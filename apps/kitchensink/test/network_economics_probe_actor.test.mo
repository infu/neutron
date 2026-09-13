import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Caps "mo:neutron-capabilities";
import NetworkEconomicsProbe "../backend/NetworkEconomicsProbe";

persistent actor {
    public func run() : async Text {
        let target = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
        var allowed = false;
        var dispatches = 0;
        // NetworkEconomics shape from the official NNS Governance Candid:
        // https://github.com/dfinity/ic/blob/master/rs/nns/governance/canister/governance.did
        // Includes parameters deliberately omitted by the application decoder.
        let economics = {
            neuron_minimum_stake_e8s = 100_000_000 : Nat64;
            max_proposals_to_keep_per_topic = 100 : Nat32;
            neuron_management_fee_per_proposal_e8s = 1_000_000 : Nat64;
            reject_cost_e8s = 1_000_000_000 : Nat64;
            transaction_fee_e8s = 10_000 : Nat64;
            neuron_spawn_dissolve_delay_seconds = 604_800 : Nat64;
            minimum_icp_xdr_rate = 100 : Nat64;
            maximum_node_provider_rewards_e8s = 1_000_000_000_000 : Nat64;
            neurons_fund_economics = null;
            voting_power_economics = ?{
                start_reducing_voting_power_after_seconds = ?(15_778_800 : Nat64);
                clear_following_after_seconds = ?(2_629_800 : Nat64);
                neuron_minimum_dissolve_delay_to_vote_seconds = ?(15_778_800 : Nat64);
            };
        };
        var reply : Caps.BackendCallResultV1 = #ok(to_candid(economics));
        let calls : Caps.BackendCallsV1 = {
            canister_principal = Principal.fromText("aaaaa-aa");
            owns_principal = func(_ : Principal) : Bool { false };
            can_call = func(canister : Principal, method : Text) : Bool {
                assert canister == target;
                assert method == "get_network_economics_parameters";
                allowed;
            };
            call = func(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
                assert allowed;
                assert request.canister == target;
                assert request.method == "get_network_economics_parameters";
                assert request.args == to_candid();
                assert request.cycles == 1_000_000;
                dispatches += 1;
                reply;
            };
            call_batch = func(_ : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
                Runtime.trap("The network-economics probe must send one call");
            };
        };
        assert (await* NetworkEconomicsProbe.read(calls, target)) ==
            "Reserve exact get_network_economics_parameters access for this canister first";
        assert dispatches == 0;
        allowed := true;
        assert (await* NetworkEconomicsProbe.read(calls, target)) ==
            "NNS Governance reports a transaction fee of 10000 e8s and a minimum neuron stake of 100000000 e8s. The demo attached 1,000,000 cycles; a canister that accepts none refunds them.";
        assert dispatches == 1;
        reply := #ok(to_candid(10_000 : Nat));
        assert (await* NetworkEconomicsProbe.read(calls, target)) ==
            "The canister returned an invalid get_network_economics_parameters reply";
        reply := #err({ code = "reservation_revoked"; message = "Access was released" });
        assert (await* NetworkEconomicsProbe.read(calls, target)) ==
            "Backend call failed (reservation_revoked): Access was released";
        assert dispatches == 3;
        "Exact NNS Governance route, Candid network economics response with extra fields, denied access, malformed reply and broker errors verified";
    };
}
