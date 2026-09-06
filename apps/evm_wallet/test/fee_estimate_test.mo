import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Estimate "../backend/fees/Estimate";
import Json "../backend/rpc/Json";
import Hex "../backend/evm/Hex";

persistent actor {
    public func run() : async Text {
        let input : Estimate.Input = { chain_id = 1; from = "0x0000000000000000000000000000000000000001"; to = "0x00000000000000000000000000000000000000AB"; value = "0x10"; data = "0xAAbb" };
        var scenario = 0;
        var methods : [Text] = [];
        var estimateBlocks : [?Text] = [];
        let rpc : Estimate.Rpc = {
            request = func(chain : Nat, method : Text, params : Text) : async* Estimate.Result<Text> {
                assert chain == 1 or chain == 42161;
                methods := Array.concat(methods, [method]);
                switch (method) {
                    case ("eth_getBlockByNumber") {
                        assert params == "[\"latest\",false]";
                        if (scenario == 2 or scenario == 4 or scenario == 10) return #err("providers disagree");
                        let base = if (scenario == 5) 2 ** 200 else 100;
                        #ok("{\"number\":\"0x7b\",\"baseFeePerGas\":" # Json.quote(Json.hexQuantity(base)) # "}");
                    };
                    case ("eth_gasPrice") {
                        assert params == "[]";
                        if (scenario == 3 or scenario == 4) return #err("gas price unavailable");
                        let price = if (scenario == 5) 2 ** 200 + 2 ** 100 else if (chain == 42161) 100 else 103;
                        #ok(Json.quote(Json.hexQuantity(price)));
                    };
                    case ("eth_maxPriorityFeePerGas") {
                        assert params == "[]" and chain != 42161;
                        #ok(Json.quote(Json.hexQuantity(if (scenario == 5) 2 ** 100 else 2)));
                    };
                    case ("eth_estimateGas") {
                        let #ok(#array(args)) = Json.parse(params) else { assert false; loop {} };
                        assert args.size() >= 1 and args.size() <= 2;
                        assert Json.field(args[0], "from") == ?#string(input.from);
                        assert Json.field(args[0], "to") == ?#string(Text.toLower(input.to));
                        assert Json.field(args[0], "value") == ?#string("0x10");
                        assert Json.field(args[0], "data") == ?#string("0xaabb");
                        assert Json.field(args[0], "nonce") == null;
                        assert Json.field(args[0], "gas") == null;
                        let block : ?Text = if (args.size() == 2) {
                            let #string(tag) = args[1] else { assert false; loop {} };
                            ?tag;
                        } else null;
                        estimateBlocks := Array.concat(estimateBlocks, [block]);
                        // The same state-changing call costs more against the
                        // observed mined state than its pending/default state.
                        // Accept omitted tags here so the regression fails on
                        // the incorrectly reported gas, not just RPC shape.
                        if (scenario == 8 or scenario == 10) {
                            let gas = if (block == ?"0x7b" or block == ?"latest") 44322 else 24437;
                            return #ok(Json.quote(Json.hexQuantity(gas)));
                        };
                        assert args.size() == 2;
                        assert block == ?(if (scenario == 2 or scenario == 4) "latest" else "0x7b");
                        if (scenario == 1) return #err("execution reverted: transfer allowance");
                        if (scenario == 9) return #err("observed block state unavailable");
                        if (scenario == 7) return #ok("\"0x00\"");
                        #ok(Json.quote(Json.hexQuantity(if (chain == 42161) 1234 else 21000)));
                    };
                    // Any nonce, signing, broadcast, or other effect fails.
                    case (_) { assert false; #err("Unexpected RPC effect") };
                };
            };
        };
        func perform(next : Nat, request : Estimate.Input) : async* Estimate.Output {
            scenario := next;
            methods := [];
            estimateBlocks := [];
            switch (await* Estimate.estimate(request, rpc)) { case (#ok(value)) value; case (#err(_)) { assert false; loop {} } };
        };
        for (chain in [1, 42161].vals()) {
            let minedState = await* perform(8, { input with chain_id = chain });
            assert minedState.block_number == ?"123" and minedState.gas_limit == ?"44322";
            assert minedState.status == "available" and minedState.reasons.size() == 0;
            assert minedState.estimated_fee == ?Nat.toText(44322 * (if (chain == 42161) 100 else 102));
            assert minedState.max_fee == ?Nat.toText(44322 * (if (chain == 42161) 200 else 202));
            assert estimateBlocks == [?"0x7b"];

            // Without an observed block, retain the independent price facts
            // and explicitly estimate latest rather than provider-default pending.
            let latestState = await* perform(10, { input with chain_id = chain });
            assert latestState.block_number == null and latestState.base_fee_per_gas == null;
            assert latestState.gas_limit == ?"44322" and latestState.status == "available";
            assert latestState.estimated_fee == ?Nat.toText(44322 * (if (chain == 42161) 100 else 103));
            assert latestState.max_fee == null and latestState.max_fee_per_gas == null;
            assert latestState.reasons == ["eth_getBlockByNumber: providers disagree"];
            assert estimateBlocks == [?"latest"];

            // A provider that cannot estimate the pinned block must not silently
            // supply the cheaper pending-state result or retry against latest.
            let unavailableState = await* perform(9, { input with chain_id = chain });
            assert unavailableState.block_number == ?"123" and unavailableState.base_fee_per_gas == ?"100";
            assert unavailableState.gas_price == ?(if (chain == 42161) "100" else "103");
            assert unavailableState.gas_limit == null and unavailableState.estimated_fee == null and unavailableState.max_fee == null;
            assert unavailableState.status == "unavailable";
            assert unavailableState.reasons == ["eth_estimateGas: observed block state unavailable"];
            assert estimateBlocks == [?"0x7b"];
        };
        let ordinary = await* perform(0, input);
        assert methods == ["eth_getBlockByNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_estimateGas"];
        assert ordinary.status == "available";
        assert ordinary.to == Text.toLower(input.to) and ordinary.from == input.from;
        assert ordinary.value == "16" and ordinary.data == "0xaabb";
        assert ordinary.block_number == ?"123" and ordinary.gas_limit == ?"21000";
        assert ordinary.gas_price == ?"103" and ordinary.base_fee_per_gas == ?"100";
        assert ordinary.max_priority_fee_per_gas == ?"2" and ordinary.max_fee_per_gas == ?"202";
        assert ordinary.estimated_fee == ?"2142000" and ordinary.max_fee == ?"4242000";
        assert ordinary.reasons.size() == 0;
        assert ordinary.fee_basis == "base_fee_plus_priority" and ordinary.posting_costs == "not_applicable";
        let reverted = await* perform(1, input);
        assert reverted.status == "unavailable";
        assert reverted.gas_limit == null and reverted.estimated_fee == null and reverted.max_fee == null;
        assert reverted.gas_price == ordinary.gas_price and reverted.base_fee_per_gas == ordinary.base_fee_per_gas;
        assert reverted.max_priority_fee_per_gas == ordinary.max_priority_fee_per_gas and reverted.max_fee_per_gas == ordinary.max_fee_per_gas;
        assert reverted.reasons == ["eth_estimateGas: execution reverted: transfer allowance"];
        assert reverted.fee_basis == "unavailable";
        let fallback = await* perform(2, input);
        assert fallback.status == "available" and fallback.base_fee_per_gas == null and fallback.block_number == null;
        assert fallback.max_fee_per_gas == null and fallback.max_fee == null and fallback.estimated_fee == ?"2163000";
        assert fallback.fee_basis == "gas_price";
        assert fallback.reasons == ["eth_getBlockByNumber: providers disagree"];
        let noGasPrice = await* perform(3, input);
        assert noGasPrice.gas_price == null and noGasPrice.estimated_fee == ordinary.estimated_fee and noGasPrice.status == "available";
        assert noGasPrice.reasons == ["eth_gasPrice: gas price unavailable"];
        let noPricing = await* perform(4, input);
        assert noPricing.status == "unavailable" and noPricing.gas_limit == ordinary.gas_limit;
        assert noPricing.estimated_fee == null and noPricing.max_fee == null and noPricing.reasons.size() == 2;
        let large = await* perform(5, input);
        assert large.estimated_fee == ?Nat.toText(21000 * (2 ** 200 + 2 ** 100));
        assert large.max_fee == ?Nat.toText(21000 * (2 ** 201 + 2 ** 100));
        assert large.max_fee_per_gas == ?Nat.toText(2 ** 201 + 2 ** 100);
        let arbitrum = await* perform(0, { input with chain_id = 42161 });
        assert methods == ["eth_getBlockByNumber", "eth_gasPrice", "eth_estimateGas"];
        assert arbitrum.max_priority_fee_per_gas == ?"0" and arbitrum.gas_limit == ?"1234";
        assert arbitrum.estimated_fee == ?"123400" and arbitrum.max_fee == ?"246800";
        assert arbitrum.fee_basis == "arbitrum_total_gas" and arbitrum.posting_costs == "included";
        // This verifies arithmetic; a mock with ID 42161 is not Nitro proof.
        let arbitrumReverted = await* perform(1, { input with chain_id = 42161 });
        assert arbitrumReverted.posting_costs == "unavailable" and arbitrumReverted.fee_basis == "unavailable";
        let arbitrumNoPricing = await* perform(4, { input with chain_id = 42161 });
        assert arbitrumNoPricing.posting_costs == "included" and arbitrumNoPricing.status == "unavailable";
        let malformed = await* perform(7, input);
        assert malformed.status == "unavailable" and malformed.gas_price == ?"103";
        assert malformed.gas_limit == null and malformed.reasons.size() == 1;
        for (invalid in [
            { input with from = "0x01" }, { input with to = "0x000000000000000000000000000000000000000z" },
            { input with data = "0x1" }, { input with value = "-1" },
            { input with value = Nat.toText(Hex.uint256Limit) }, { input with chain_id = 10 },
        ].vals()) {
            methods := [];
            switch (await* Estimate.estimate(invalid, rpc)) { case (#err(_)) {}; case (_) assert false };
            assert methods.size() == 0;
        };
        "Readonly fee estimates bind gas to observed state, preserve partial facts, exact arithmetic, and Arbitrum fee semantics";
    };
};
