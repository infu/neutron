// Opt-in read-only integration probe for the existing local fixture's actual
// evm_rpc-v2.8.0 WASM. Never run against a production environment.
import Array "mo:core/Array";
import List "mo:core/List";
import Principal "mo:core/Principal";
import Caps "mo:neutron-capabilities";
import Client "../backend/rpc/Client";
import Json "../backend/rpc/Json";
import Types "../backend/rpc/Types";

persistent actor {
  type RequestResult = { #Ok : Text; #Err : Types.RpcError };
  type LegacyMultiResult = { #Consistent : RequestResult; #Inconsistent : [(Types.RpcService, RequestResult)] };
  transient let rpc : actor {
    requestCost : shared query (Types.RpcService, Text, Nat64) -> async Types.RequestCostResult;
    request : shared (Types.RpcService, Text, Nat64) -> async RequestResult;
    multi_requestCyclesCost : shared query (Types.RpcServices, ?Types.RpcConfig, Text) -> async Types.RequestCostResult;
    multi_request : shared (Types.RpcServices, ?Types.RpcConfig, Text) -> async LegacyMultiResult;
  } = actor("7hfb6-caaaa-aaaar-qadga-cai");

  public func wire(block : Text, transactionHash : Text) : async Text {
    let output = List.empty<Json.Value>();
    let source : Types.RpcService = #EthMainnet(#PublicNode);
    for ((method, params) in [
      ("eth_blockNumber", "[]"),
      ("eth_getBlockByNumber", "[" # Json.quote(block) # ",false]"),
      ("eth_getTransactionReceipt", "[\"0x0000000000000000000000000000000000000000000000000000000000000000\"]"),
      ("eth_getTransactionReceipt", "[" # Json.quote(transactionHash) # "]"),
      ("eth_getTransactionByHash", "[" # Json.quote(transactionHash) # "]"),
    ].vals()) {
      let payload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":" # Json.quote(method) # ",\"params\":" # params # "}";
      let #Ok(cost) = await rpc.requestCost(source, payload, 65536) else { assert false; loop {} };
      let result = await (with cycles = cost) rpc.request(source, payload, 65536);
      List.add(output, #object_([("method", #string(method)), ("params", #string(params)), ("wire", #string(debug_show(result)))]));
    };
    let sources : Types.RpcServices = #EthMainnet(?[#Alchemy, #BlockPi, #PublicNode]);
    let config : ?Types.RpcConfig = ?{ responseSizeEstimate = ?2304; responseConsensus = ?#Equality };
    let payload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"0x0000000000000000000000000000000000000001\",\"latest\"]}";
    let #Ok(cost) = await rpc.multi_requestCyclesCost(sources, config, payload) else { assert false; loop {} };
    let legacy = await (with cycles = cost) rpc.multi_request(sources, config, payload);
    List.add(output, #object_([("method", #string("multi_request legacy scalar")), ("wire", #string(debug_show(legacy)))]));
    Json.stringify(#array(List.toArray(output)));
  };

  func invoke(request : Caps.BackendCallRequestV1) : async Caps.BackendCallResultV1 {
    assert request.canister == Principal.fromText("7hfb6-caaaa-aaaar-qadga-cai");
    if (request.method == "requestCost") {
      let ?(source, payload, size) : ?(Types.RpcService, Text, Nat64) = from_candid(request.args) else { assert false; loop {} };
      #ok(to_candid(await rpc.requestCost(source, payload, size)));
    } else if (request.method == "request") {
      let ?(source, payload, size) : ?(Types.RpcService, Text, Nat64) = from_candid(request.args) else { assert false; loop {} };
      #ok(to_candid(await (with cycles = request.cycles) rpc.request(source, payload, size)));
    } else { assert false; #err({ code = "unexpected"; message = request.method }) };
  };
  public func normalized(block : Text, transactionHash : Text) : async Text {
    let calls : Caps.BackendCallsV1 = {
      canister_principal = Principal.fromText("aaaaa-aa");
      can_call = func(_ : Principal, _ : Text) : Bool { true };
      call = func(request : Caps.BackendCallRequestV1) : async* Caps.BackendCallResultV1 { await invoke(request) };
      call_batch = func(requests : [Caps.BackendCallRequestV1]) : async* [Caps.BackendCallResultV1] {
        let futures = List.empty<async Caps.BackendCallResultV1>();
        for (request in requests.vals()) List.add(futures, invoke(request));
        let output = List.empty<Caps.BackendCallResultV1>();
        for (future in List.values(futures)) List.add(output, await future);
        List.toArray(output);
      };
    };
    let client = Client.Client(calls);
    let results = List.empty<Json.Value>();
    for ((method, params) in [
      ("eth_blockNumber", "[]"),
      ("eth_getBalance", "[\"0x0000000000000000000000000000000000000001\"," # Json.quote(block) # "]"),
      ("eth_getBlockByNumber", "[" # Json.quote(block) # ",false]"),
      ("eth_getTransactionReceipt", "[\"0x0000000000000000000000000000000000000000000000000000000000000000\"]"),
      ("eth_getTransactionReceipt", "[" # Json.quote(transactionHash) # "]"),
      ("eth_getTransactionByHash", "[" # Json.quote(transactionHash) # "]"),
    ].vals()) {
      let result = await* client.request(1, method, params);
      List.add(results, #object_([("method", #string(method)), ("result", #string(debug_show(result)))]));
      switch (result) {
        case (#err(_)) { assert false };
        case (#ok(value)) {
          let #ok(parsed) = Json.parse(value) else { assert false; loop {} };
          switch (method) {
            case ("eth_blockNumber" or "eth_getBalance") { assert Json.maybeQuantity(parsed) != null };
            case ("eth_getBlockByNumber") { assert Json.field(parsed, "hash") != null };
            case ("eth_getTransactionReceipt") {
              if (params == "[\"0x0000000000000000000000000000000000000000000000000000000000000000\"]") assert parsed == #null_
              else { assert Json.field(parsed, "transactionHash") == ?#string(transactionHash) };
            };
            case ("eth_getTransactionByHash") { assert Json.field(parsed, "hash") == ?#string(transactionHash) };
            case (_) { assert false };
          };
        };
      };
    };
    Json.stringify(#array(List.toArray(results)));
  };
};
