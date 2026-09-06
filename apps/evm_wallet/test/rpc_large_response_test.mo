import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Client "../backend/rpc/Client";
import Types "../backend/rpc/Types";
persistent actor {
public func run() : async Text {
  // Two hex characters per byte of a full 24,576-byte deployed contract.
  // json@1.4.0 serializes this into a deep text rope; compare all providers.
  let code = "0x" # Text.fromIter(Array.tabulate<Char>(49_150, func(_) { 'a' }).vals());
  var scenario = 0;
  var batches = 0;
  let calls : Caps.BackendCallsV1 = {
    canister_principal = Principal.fromText("aaaaa-aa");
    can_call = func(_ : Principal, _ : Text) : Bool { true };
    call = func(_ : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 { assert false; loop {} };
    call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
      batches += 1;
      assert requests.size() == 3;
      Array.tabulate<Caps.BackendCallResultV1>(3, func(i) {
        if (requests[i].method == "requestCost") {
          let cost : Types.RequestCostResult = #Ok(1000);
          #ok(to_candid(cost));
        } else {
          assert requests[i].method == "request" and requests[i].cycles == 1000;
          let suffix = if (scenario == 1 and i == 2) "bb" else "aa";
          let value = if (scenario == 2) {
            if (i == 0) "{\"z\":\"😀\",\"code\":\"" # code # "\"}" else "{\"code\":\"" # code # "\",\"z\":\"\\ud83d\\ude00\"}";
          } else { "\"" # code # suffix # "\"" };
          let result : Types.RequestResult = #Ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" # value # "}");
          #ok(to_candid(result));
        };
      });
    };
  };
  let client = Client.Client(calls);
  let #ok(agreed) = await* client.request(42161, "eth_getCode", "[]") else { assert false; loop {} };
  assert Text.encodeUtf8(agreed) == Text.encodeUtf8("\"" # code # "aa\"");
  assert batches == 2;
  scenario := 1;
  switch (await* client.request(42161, "eth_getCode", "[]")) {
    case (#err(error)) assert Text.startsWith(error, #text("EVM RPC providers disagree:"));
    case (_) assert false;
  };
  scenario := 2;
  let #ok(nested) = await* client.request(42161, "eth_getCode", "[]") else { assert false; loop {} };
  assert Text.encodeUtf8(nested) == Text.encodeUtf8("{\"code\":\"" # code # "\",\"z\":\"😀\"}");
  "Large bytecode, last-byte disagreement and nested Unicode provider consensus passed";
};
};
