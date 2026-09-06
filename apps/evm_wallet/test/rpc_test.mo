import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Client "../backend/rpc/Client";
import Json "../backend/rpc/Json";
import Types "../backend/rpc/Types";

persistent actor {
public func run() : async Text {
assert Json.quantityText("0x0") == #ok(0);
assert Json.quantityText("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff") == #ok(2 ** 256 - 1);
assert Json.parseQuantity("0x") == null;
assert Json.parseQuantity("0x00") == null;
assert Json.parseQuantity("-0x1") == null;
assert Json.parseQuantity("0x1g") == null;
assert Json.hexQuantity(2 ** 256 - 1) == "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
assert Json.parse("\"\\ud83d\\ude00\"") == #ok(#string("😀"));
assert Json.parse("\"\\uD834\\uDD1E\"") == #ok(#string("𝄞"));
assert Json.parse("\"\\\\ud800\"") == #ok(#string("\\ud800"));
switch (Json.parse("\"\\ud800\"")) { case (#err(_)) {}; case (_) assert false };
switch (Json.parse("\"\\udc00\"")) { case (#err(_)) {}; case (_) assert false };
switch (Json.parse("{\"a\":1,\"a\":2}")) { case (#err(_)) {}; case (_) assert false };
switch (Json.parse("{\"nested\":{\"a\":1,\"\\u0061\":2}}")) { case (#err(_)) {}; case (_) assert false };
switch (Json.parse("[1,]")) { case (#err(_)) {}; case (_) assert false };
let escaped : Json.Value = #object_([("a\"\\\n", #string("b\"\\\t")), ("n", #number(#int(2 ** 256 - 1)))]);
assert Json.parse(Json.stringify(escaped)) == #ok(escaped);
switch (Json.parse("{\"gasUsedRatio\":[0.5,0.125]}")) { case (#ok(_)) {}; case (_) assert false };

func readReply(body : Text) : Caps.BackendCallResultV1 {
    let result : Types.RequestResult = #Ok(body);
    #ok(to_candid(result));
};
assert Client.decodeRead(readReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x00112233\"}")) == #ok("\"0x00112233\"");
assert Client.decodeRead(readReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}")) == #ok("null");
assert Client.decodeRead(readReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"z\":1,\"a\":{\"y\":2,\"b\":3}}}")) == #ok("{\"a\":{\"b\":3,\"y\":2},\"z\":1}");
assert Client.decodeRead(readReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"\\ud83d\\ude00\"}")) == #ok("\"😀\"");
for (invalid in [
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":null}",
    "{\"jsonrpc\":\"1.0\",\"id\":1,\"result\":null}",
    "{\"jsonrpc\":\"2.0\",\"id\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null,\"error\":null}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null,\"result\":null}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"broken\"}}",
    "0x00112233",
].vals()) {
    switch (Client.decodeRead(readReply(invalid))) { case (#err(_)) {}; case (_) assert false };
};
let error : Types.RpcError = #ProviderError(#TooFewCycles({ expected = 123; received = 122 }));
let badQuote : Types.RequestCostResult = #Err(error);
switch (Client.decodeCost(#ok(to_candid(badQuote)))) { case (#err(_)) {}; case (_) assert false };
assert Client.decodeCost(#ok(to_candid("invalid"))) == #err("EVM RPC returned an invalid cycle quote");

var scenario = 0;
var batches = 0;
var paidBatches = 0;
var quotes : [Caps.BackendCallRequestV1] = [];
var seenEstimates : [Nat64] = [];
var broadcasts = 0;
let calls : Caps.BackendCallsV1 = {
    canister_principal = Principal.fromText("aaaaa-aa");
    can_call = func(_ : Principal, _ : Text) : Bool { true };
    call = func(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 {
        if (request.method == "eth_sendRawTransactionCyclesCost") {
            assert request.cycles == 0;
            let cost : Types.RequestCostResult = #Ok(999);
            #ok(to_candid(cost));
        } else {
            assert request.method == "eth_sendRawTransaction";
            assert request.cycles == 999;
            broadcasts += 1;
            let result : Types.MultiSendRawTransactionResult = #Consistent(#Ok(#NonceTooLow));
            #ok(to_candid(result));
        };
    };
    call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
        assert requests.size() == 3;
        batches += 1;
        if (requests[0].method == "requestCost") {
            quotes := requests;
            let ?(provider, payload, estimate) : ?(Types.RpcService, Text, Nat64) = from_candid(requests[0].args) else { assert false; loop {} };
            assert provider == #EthMainnet(#Alchemy);
            assert Json.field(switch (Json.parse(payload)) { case (#ok(value)) value; case (_) { assert false; loop {} } }, "id") == ?#number(#int(1));
            seenEstimates := Array.concat(seenEstimates, [estimate]);
            Array.tabulate<Caps.BackendCallResultV1>(3, func(i) {
                assert requests[i].method == "requestCost";
                assert requests[i].cycles == 0;
                let cost : Types.RequestCostResult = if (scenario == 5 and i == 1) badQuote else #Ok(1000 + i);
                #ok(to_candid(cost));
            });
        } else {
            paidBatches += 1;
            if (scenario == 9) return [];
            Array.tabulate<Caps.BackendCallResultV1>(3, func(i) {
                assert requests[i].method == "request";
                assert requests[i].cycles == 1000 + i;
                assert requests[i].args == quotes[i].args;
                if (scenario == 4 and paidBatches == 1 and i == 2) {
                    let error : Types.RequestResult = #Err(#HttpOutcallError(#IcError({ code = #SysFatal; message = "Http body exceeds size limit" })));
                    return #ok(to_candid(error));
                };
                let value = switch (scenario) {
                    case (1) if (i == 2) "\"0x2\"" else "\"0x1\"";
                    case (2) "null";
                    case (4 or 10) if (i == 0) "{\"blockNumber\":\"0x1\",\"status\":\"0x1\",\"logs\":[{\"address\":\"0xab\",\"topics\":[\"0x1\",\"0x2\"]}]}" else "{\"logs\":[{\"topics\":[\"0x1\",\"0x2\"],\"address\":\"0xab\"}],\"status\":\"0x1\",\"blockNumber\":\"0x1\"}";
                    case (8) if (i == 0) "[1,2]" else "[2,1]";
                    case (11) if (i == 0) "{\"hash\":\"0x1234\",\"blockNumber\":null,\"nonce\":\"0x2\"}" else "{\"nonce\":\"0x2\",\"blockNumber\":null,\"hash\":\"0x1234\"}";
                    case (_) "\"0x00112233\"";
                };
                if (scenario == 3 and i == 1) return readReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"execution reverted\",\"data\":\"0x1234\"}}");
                if (scenario == 6 and i == 2) return readReply("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":null}");
                if (scenario == 7 and i == 1) return readReply("malformed");
                readReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" # value # "}");
            });
        };
    };
};
let client = Client.Client(calls);
func perform(next : Nat, method : Text) : async* Client.Result<Text> {
    scenario := next;
    batches := 0;
    paidBatches := 0;
    seenEstimates := [];
    await* client.request(1, method, "[]");
};
assert (await* perform(0, "eth_getBalance")) == #ok("\"0x00112233\"");
assert batches == 2 and paidBatches == 1;
assert (await* perform(2, "eth_getTransactionReceipt")) == #ok("null");
for (n in [1, 3, 6, 7, 8, 9].vals()) {
    switch (await* perform(n, "eth_getBalance")) { case (#err(_)) {}; case (_) assert false };
    assert paidBatches == 1;
};
switch (await* perform(5, "eth_getBalance")) { case (#err(_)) {}; case (_) assert false };
assert paidBatches == 0;
let expectedReceipt = "{\"blockNumber\":\"0x1\",\"logs\":[{\"address\":\"0xab\",\"topics\":[\"0x1\",\"0x2\"]}],\"status\":\"0x1\"}";
assert (await* perform(10, "eth_getTransactionReceipt")) == #ok(expectedReceipt);
assert (await* perform(4, "eth_getTransactionReceipt")) == #ok(expectedReceipt);
assert paidBatches == 2 and batches == 4;
assert seenEstimates == [2748, 5496];
assert (await* perform(11, "eth_getTransactionByHash")) == #ok("{\"blockNumber\":null,\"hash\":\"0x1234\",\"nonce\":\"0x2\"}");
switch (await* client.request(1, "eth_sendRawTransaction", "[\"0x02\"]")) {
    case (#err(error)) assert Text.contains(error, #text("NonceTooLow"));
    case (_) assert false;
};
assert broadcasts == 1;
let accepted : Types.MultiSendRawTransactionResult = #Consistent(#Ok(#Ok(null)));
assert Client.decodeSend(#ok(to_candid(accepted))) == #ok("null");
let sendDisagreement : Types.MultiSendRawTransactionResult = #Inconsistent([(#EthMainnet(#Alchemy), #Ok(#Ok(null))), (#EthMainnet(#PublicNode), #Ok(#NonceTooLow))]);
switch (Client.decodeSend(#ok(to_candid(sendDisagreement)))) {
    case (#err(error)) assert Text.contains(error, #text("reconcile the saved transaction hash"));
    case (_) assert false;
};
assert Client.services(1) != null;
assert Client.services(42161) != null;
assert Client.services(8453) != null;
assert Client.services(10) != null;
assert Client.services(11155111) != null;
assert Client.services(99999) == null;
"EVM RPC envelope, scalar/object/null consensus, quote, response-size retry, and broadcast tests passed";
};
};
