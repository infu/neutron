import List "mo:core/List";
import Nat "mo:core/Nat";
import Time "mo:core/Time";
import Hex "../evm/Hex";
import Json "../rpc/Json";

// Fee semantics: https://eips.ethereum.org/EIPS/eip-1559 and
// https://docs.arbitrum.io/arbitrum-essentials/how-to-estimate-gas .
// Arbitrum tips: https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees .
module {
    public type Result<T> = { #ok : T; #err : Text };
    public type Rpc = { request : (Nat, Text, Text) -> async* Result<Text> };
    public type Input = { chain_id : Nat; from : Text; to : Text; value : Text; data : Text };
    // All numeric result strings are exact decimal atomic units. max_fee is
    // gas_limit * the suggested max_fee_per_gas, not an authorization or a
    // guarantee of final cost. Gas use and fees can change before execution.
    // fee_basis: base_fee_plus_priority | gas_price | arbitrum_total_gas |
    // unavailable. posting_costs: included | not_applicable | unavailable.
    public type Output = {
        chain_id : Nat; from : Text; to : Text; value : Text; data : Text;
        status : Text;
        gas_limit : ?Text; gas_price : ?Text; base_fee_per_gas : ?Text;
        max_priority_fee_per_gas : ?Text; max_fee_per_gas : ?Text;
        estimated_fee : ?Text; max_fee : ?Text;
        block_number : ?Text; observed_at : Int; fee_basis : Text; posting_costs : Text; reasons : [Text];
    };

    func address(input : Text) : Result<Text> {
        switch (Hex.decode(input)) {
            case (#err(error)) #err(error);
            case (#ok(bytes)) {
                if (bytes.size() != 20) return #err("EVM address must contain 20 bytes");
                #ok(Hex.encode(bytes));
            };
        };
    };

    func quantity(value : Json.Value) : Result<Nat> {
        switch (Json.quantity(value)) {
            case (#err(error)) #err(error);
            case (#ok(value)) {
                if (value >= Hex.uint256Limit) #err("RPC quantity exceeds uint256") else #ok(value);
            };
        };
    };

    func decimal(value : ?Nat) : ?Text {
        switch (value) { case (?value) ?Nat.toText(value); case (null) null };
    };

    public func estimate(input : Input, rpc : Rpc) : async* Result<Output> {
        // These are the wallet's current fee models. OP Stack totals require
        // additional L1/operator fees, so cannot reuse this ETH/Nitro formula.
        if (input.chain_id != 1 and input.chain_id != 42161 and input.chain_id != 11155111) {
            return #err("Fee estimation is not available for this chain's fee model");
        };
        let from = switch (address(input.from)) { case (#err(error)) return #err("Invalid sender: " # error); case (#ok(value)) value };
        let to = switch (address(input.to)) { case (#err(error)) return #err("Invalid destination: " # error); case (#ok(value)) value };
        let value = switch (Hex.parseNat(input.value)) {
            case (#err(error)) return #err("Invalid transfer value: " # error);
            case (#ok(value)) {
                if (value >= Hex.uint256Limit) return #err("Transfer value exceeds uint256");
                value;
            };
        };
        let data = switch (Hex.decode(input.data)) { case (#err(error)) return #err("Invalid transaction data: " # error); case (#ok(bytes)) Hex.encode(bytes) };
        let reasons = List.empty<Text>();

        func read(method : Text, params : Text) : async* ?Json.Value {
            switch (await* rpc.request(input.chain_id, method, params)) {
                case (#err(error)) { List.add(reasons, method # ": " # error); null };
                case (#ok(text)) switch (Json.parse(text)) {
                    case (#err(error)) { List.add(reasons, method # ": Invalid RPC JSON: " # error); null };
                    case (#ok(value)) ?value;
                };
            };
        };
        func readQuantity(method : Text) : async* ?Nat {
            switch (await* read(method, "[]")) {
                case (null) null;
                case (?value) switch (quantity(value)) {
                    case (#ok(value)) ?value;
                    case (#err(error)) { List.add(reasons, method # ": " # error); null };
                };
            };
        };
        func blockQuantity(block : Json.Value, key : Text) : ?Nat {
            let ?field = Json.field(block, key) else { List.add(reasons, "eth_getBlockByNumber: Missing " # key); return null };
            switch (quantity(field)) {
                case (#ok(value)) ?value;
                case (#err(error)) { List.add(reasons, "eth_getBlockByNumber " # key # ": " # error); null };
            };
        };

        // Pricing and estimation failures are independent. In particular a
        // swap can revert until approved; retain prices without asserting an
        // allowance-specific cause that the RPC error did not establish.
        var blockNumber : ?Nat = null;
        var baseFee : ?Nat = null;
        switch (await* read("eth_getBlockByNumber", "[\"latest\",false]")) {
            case (?block) {
                blockNumber := blockQuantity(block, "number");
                baseFee := blockQuantity(block, "baseFeePerGas");
            };
            case (null) {};
        };
        let gasPrice = await* readQuantity("eth_gasPrice");
        // Nitro ignores priority tips. Reporting zero follows its fee model;
        // no fabricated tip RPC result is used as a network observation.
        let priority = if (input.chain_id == 42161) ?0 else await* readQuantity("eth_maxPriorityFeePerGas");
        let tx = Json.stringify(#object_([
            ("from", #string(from)), ("to", #string(to)),
            ("value", #string(Json.hexQuantity(value))), ("data", #string(data)),
        ]));
        let gas = switch (await* read("eth_estimateGas", "[" # tx # "]")) {
            case (null) null;
            case (?result) switch (quantity(result)) {
                case (#ok(value)) {
                    if (value == 0) { List.add(reasons, "eth_estimateGas: Returned zero gas for a transaction"); null } else ?value;
                };
                case (#err(error)) { List.add(reasons, "eth_estimateGas: " # error); null };
            };
        };

        var suggestedMax : ?Nat = null;
        var effectivePrice : ?Nat = null;
        var feeBasis = "";
        if (input.chain_id == 42161) {
            // Real Arbitrum One eth_estimateGas expresses execution plus L1
            // posting in L2 gas units. Multiply once; never add posting again.
            // A fixture with chain ID 42161 does not establish Nitro coverage.
            effectivePrice := switch (gasPrice) { case (?price) ?price; case (null) baseFee };
            feeBasis := "arbitrum_total_gas";
            switch (baseFee) {
                case (?base) {
                    if (2 * base < Hex.uint256Limit) suggestedMax := ?(2 * base)
                    else List.add(reasons, "Suggested maximum fee per gas exceeds uint256");
                };
                case (null) {};
            };
        } else {
            // Suggested maximum is a wallet heuristic, not an EIP-1559
            // requirement. The current estimate does not spend that cap.
            feeBasis := "base_fee_plus_priority";
            switch (baseFee, priority) {
                case (?base, ?tip) {
                    if (base + tip < Hex.uint256Limit) effectivePrice := ?(base + tip);
                    if (2 * base + tip < Hex.uint256Limit) suggestedMax := ?(2 * base + tip)
                    else List.add(reasons, "Suggested maximum fee per gas exceeds uint256");
                };
                case (_) {};
            };
            if (effectivePrice == null) {
                effectivePrice := gasPrice;
                feeBasis := "gas_price";
            };
        };
        let estimatedFee = switch (gas, effectivePrice) { case (?units, ?price) ?(units * price); case (_) null };
        let maximumFee = switch (gas, suggestedMax) { case (?units, ?price) ?(units * price); case (_) null };
        #ok({
            chain_id = input.chain_id; from; to; value = Nat.toText(value); data;
            status = if (estimatedFee == null) "unavailable" else "available";
            gas_limit = decimal(gas); gas_price = decimal(gasPrice); base_fee_per_gas = decimal(baseFee);
            max_priority_fee_per_gas = decimal(priority); max_fee_per_gas = decimal(suggestedMax);
            estimated_fee = decimal(estimatedFee); max_fee = decimal(maximumFee);
            block_number = decimal(blockNumber); observed_at = Time.now();
            // Transfer value is excluded. Observed reads may come from
            // different moments; final execution gas and prices can change.
            fee_basis = if (estimatedFee == null) "unavailable" else feeBasis;
            posting_costs = if (input.chain_id != 42161) "not_applicable" else if (gas == null) "unavailable" else "included";
            reasons = List.toArray(reasons);
        });
    };
};
