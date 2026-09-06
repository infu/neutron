import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Json "Json";
import Types "Types";

module {
    public type Result<T> = { #ok : T; #err : Text };
    public let canisterId : Text = "7hfb6-caaaa-aaaar-qadga-cai";

    public func services(chainId : Nat) : ?Types.RpcServices {
        switch (chainId) {
            case (1) ?#EthMainnet(?[#Alchemy, #BlockPi, #PublicNode]);
            case (11155111) ?#EthSepolia(?[#Alchemy, #BlockPi, #PublicNode]);
            case (42161) ?#ArbitrumOne(?[#Alchemy, #BlockPi, #PublicNode]);
            case (8453) ?#BaseMainnet(?[#Alchemy, #BlockPi, #PublicNode]);
            case (10) ?#OptimismMainnet(?[#Alchemy, #BlockPi, #PublicNode]);
            case (_) null;
        };
    };

    func readServices(source : Types.RpcServices) : [Types.RpcService] {
        switch (source) {
            case (#EthMainnet(?providers)) Array.map<Types.EthMainnetService, Types.RpcService>(providers, func(provider) { #EthMainnet(provider) });
            case (#EthSepolia(?providers)) Array.map<Types.EthSepoliaService, Types.RpcService>(providers, func(provider) { #EthSepolia(provider) });
            case (#ArbitrumOne(?providers)) Array.map<Types.L2MainnetService, Types.RpcService>(providers, func(provider) { #ArbitrumOne(provider) });
            case (#BaseMainnet(?providers)) Array.map<Types.L2MainnetService, Types.RpcService>(providers, func(provider) { #BaseMainnet(provider) });
            case (#OptimismMainnet(?providers)) Array.map<Types.L2MainnetService, Types.RpcService>(providers, func(provider) { #OptimismMainnet(provider) });
            case (_) [];
        };
    };

    public func rpcError(error : Types.RpcError) : Text { debug_show(error) };

    public func decodeCost(reply : Caps.BackendCallResultV1) : Result<Nat> {
        switch (reply) {
            case (#err(error)) #err("EVM RPC cycle quote failed (" # error.code # "): " # error.message);
            case (#ok(bytes)) {
                let decoded : ?Types.RequestCostResult = from_candid bytes;
                switch (decoded) {
                    case (?#Ok(cycles)) #ok(cycles);
                    case (?#Err(error)) #err("EVM RPC cycle quote failed: " # rpcError(error));
                    case (null) #err("EVM RPC returned an invalid cycle quote");
                };
            };
        };
    };

    // The released request endpoint returns a complete JSON-RPC envelope.
    // Extract its result only after validating correlation and error shape.
    // Canonical object keys allow equality independent of provider key order.
    public func decodeRead(reply : Caps.BackendCallResultV1) : Result<Text> {
        let body = switch (reply) {
            case (#err(error)) return #err("EVM RPC call failed (" # error.code # "): " # error.message);
            case (#ok(bytes)) {
                let decoded : ?Types.RequestResult = from_candid bytes;
                switch (decoded) {
                    case (?#Ok(body)) body;
                    case (?#Err(error)) return #err("EVM RPC error: " # rpcError(error));
                    case (null) return #err("EVM RPC returned an invalid request response");
                };
            };
        };
        let envelope = switch (Json.parse(body)) {
            case (#ok(value)) value;
            case (#err(error)) return #err("EVM RPC returned invalid JSON: " # error);
        };
        if (Json.field(envelope, "jsonrpc") != ?#string("2.0") or Json.field(envelope, "id") != ?#number(#int(1))) {
            return #err("EVM RPC returned an invalid JSON-RPC version or response ID");
        };
        switch (Json.field(envelope, "result"), Json.field(envelope, "error")) {
            case (?result, null) #ok(Json.stringify(Json.canonical(result)));
            case (null, ?error) {
                switch (Json.field(error, "code"), Json.field(error, "message")) {
                    case (?#number(#int(_)), ?#string(_)) #err("JSON-RPC error: " # Json.stringify(Json.canonical(error)));
                    case (_) #err("EVM RPC returned an invalid JSON-RPC error");
                };
            };
            case (_) #err("EVM RPC response must contain exactly one result or error");
        };
    };

    public func decodeSend(reply : Caps.BackendCallResultV1) : Result<Text> {
        switch (reply) {
            case (#err(error)) #err("EVM RPC broadcast outcome unknown (" # error.code # "): " # error.message);
            case (#ok(bytes)) {
                let decoded : ?Types.MultiSendRawTransactionResult = from_candid bytes;
                switch (decoded) {
                    case (?#Consistent(#Ok(#Ok(?hash)))) #ok(Json.quote(hash));
                    case (?#Consistent(#Ok(#Ok(null)))) #ok("null");
                    case (?#Consistent(#Ok(status))) #err("EVM RPC broadcast status: " # debug_show(status));
                    case (?#Consistent(#Err(error))) #err("EVM RPC broadcast error: " # rpcError(error));
                    case (?#Inconsistent(results)) #err("EVM RPC broadcast providers disagree; reconcile the saved transaction hash: " # debug_show(results));
                    case (null) #err("EVM RPC returned an invalid broadcast response; reconcile the saved transaction hash");
                };
            };
        };
    };

    func responseEstimate(method : Text) : Nat64 {
        switch (method) {
            case ("eth_getBlockByNumber" or "eth_getBlockByHash") 24 * 1024 + 2048;
            case ("eth_getTransactionReceipt") 700 + 2048;
            case ("eth_feeHistory") 512 + 2048;
            case ("eth_getLogs") 1024 + 2048;
            case (_) 256 + 2048;
        };
    };

    func readMethod(method : Text) : Bool {
        switch (method) {
            case ("eth_getBalance" or "eth_getBlockByNumber" or "eth_getBlockByHash" or "eth_getTransactionReceipt" or "eth_getTransactionByHash" or "eth_getTransactionCount" or "eth_getCode" or "eth_call" or "eth_estimateGas" or "eth_gasPrice" or "eth_maxPriorityFeePerGas" or "eth_feeHistory" or "eth_getLogs" or "eth_chainId" or "eth_blockNumber") true;
            case (_) false;
        };
    };

    func responseTooLarge(reply : Caps.BackendCallResultV1) : Bool {
        let #ok(bytes) = reply else return false;
        let decoded : ?Types.RequestResult = from_candid bytes;
        switch (decoded) {
            // This precise IC error is asserted by the v2.8.0 integration
            // test should_retry_when_response_too_large. Other failures do
            // not authorize silently retrying the read or changing consensus.
            case (?#Err(#HttpOutcallError(#IcError({ code = #SysFatal; message })))) {
                Text.contains(message, #text("body exceeds size limit"));
            };
            case (_) false;
        };
    };

    public class Client(calls : Caps.BackendCallsV1) {
        let canister = Principal.fromText(canisterId);

        func quotedBroadcast(args : Blob) : async* Result<Caps.BackendCallResultV1> {
            let method = "eth_sendRawTransaction";
            let quoteMethod = "eth_sendRawTransactionCyclesCost";
            if (not calls.can_call(canister, quoteMethod) or not calls.can_call(canister, method)) {
                return #err("EVM RPC backend-call reservations are not active for " # method);
            };
            let cycles = switch (decodeCost(await* calls.call({ canister; method = quoteMethod; args; cycles = 0 }))) {
                case (#err(error)) return #err(error);
                case (#ok(value)) value;
            };
            #ok(await* calls.call({ canister; method; args; cycles }));
        };

        func quotedReads(providers : [Types.RpcService], payload : Text, estimate : Nat64) : async* Result<[Caps.BackendCallResultV1]> {
            if (not calls.can_call(canister, "requestCost") or not calls.can_call(canister, "request")) {
                return #err("EVM RPC backend-call reservations are not active for request and requestCost");
            };
            let quoteRequests = Array.map<Types.RpcService, Caps.BackendCallRequestV1>(providers, func(provider) {
                { canister; method = "requestCost"; args = to_candid(provider, payload, estimate); cycles = 0 };
            });
            let quotes = await* calls.call_batch(quoteRequests);
            if (quotes.size() != providers.size()) return #err("EVM RPC returned an incomplete cycle quote batch");
            var paidRequests : [Caps.BackendCallRequestV1] = [];
            var i = 0;
            while (i < providers.size()) {
                let cycles = switch (decodeCost(quotes[i])) {
                    case (#err(error)) return #err(debug_show(providers[i]) # ": " # error);
                    case (#ok(value)) value;
                };
                paidRequests := Array.concat(paidRequests, [{ quoteRequests[i] with method = "request"; cycles }]);
                i += 1;
            };
            // All quotes must succeed before any paid read is dispatched.
            // Each paid request uses the exact same provider/payload/size.
            let replies = await* calls.call_batch(paidRequests);
            if (replies.size() != providers.size()) return #err("EVM RPC returned an incomplete provider response batch");
            #ok(replies);
        };

        public func request(chainId : Nat, method : Text, params : Text) : async* Result<Text> {
            let ?source = services(chainId) else return #err("Unsupported EVM RPC chain: " # Nat.toText(chainId));
            let values = switch (Json.parse(params)) {
                case (#ok(#array(values))) values;
                case (#ok(_)) return #err("EVM RPC params must be a JSON array");
                case (#err(error)) return #err("Invalid EVM RPC params: " # error);
            };
            if (method == "eth_sendRawTransaction") {
                if (values.size() != 1) return #err("eth_sendRawTransaction requires one signed transaction");
                let ?raw = Json.string(values[0]) else return #err("Signed transaction must be hex text");
                let config : ?Types.RpcConfig = ?{ responseSizeEstimate = null; responseConsensus = ?#Equality };
                switch (await* quotedBroadcast(to_candid(source, config, raw))) {
                    case (#err(error)) #err(error);
                    case (#ok(reply)) decodeSend(reply);
                };
            } else {
                let providers = readServices(source);
                let payload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":" # Json.quote(method) # ",\"params\":" # Json.stringify(#array(values)) # "}";
                var estimate = responseEstimate(method);
                // Existing IC HTTPS response protocol maximum, not an app
                // quota. request takes the complete response byte allowance.
                let rpcMaximum : Nat64 = 2_000_000;
                loop {
                    let replies = switch (await* quotedReads(providers, payload, estimate)) {
                        case (#err(error)) return #err(error);
                        case (#ok(replies)) replies;
                    };
                    let grow = readMethod(method) and estimate < rpcMaximum and Array.any<Caps.BackendCallResultV1>(replies, responseTooLarge);
                    if (grow) {
                        estimate := Nat64.min(estimate * 2, rpcMaximum);
                    } else {
                        var agreed : ?Text = null;
                        var i = 0;
                        while (i < replies.size()) {
                            let value = switch (decodeRead(replies[i])) {
                                case (#err(error)) return #err("EVM RPC provider " # debug_show(providers[i]) # ": " # error);
                                case (#ok(value)) value;
                            };
                            switch (agreed) {
                                case (null) agreed := ?value;
                                case (?previous) {
                                    // JSON strings can be deep concatenation ropes (for
                                    // example deployed contract code). UTF-8 blobs preserve
                                    // exact equality without recursive rope comparison.
                                    if (Text.encodeUtf8(previous) != Text.encodeUtf8(value)) return #err("EVM RPC providers disagree: " # debug_show(providers[0]) # " returned " # previous # "; " # debug_show(providers[i]) # " returned " # value);
                                };
                            };
                            i += 1;
                        };
                        switch (agreed) {
                            case (?value) return #ok(value);
                            case (null) return #err("EVM RPC has no configured providers");
                        };
                    };
                };
            };
        };
    };
};
