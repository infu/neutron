// Isolated checked-upgrade fixture, never a production RPC implementation.
// The Wallet and Kernel packages run unchanged. This actor provides deterministic
// review observations and records the exact broadcast bytes before returning an
// uncertain outcome. It does not hold a signing key or fabricate a signature.
import Array "mo:core/Array";
import Text "mo:core/Text";
import Rpc "./evm_rpc_fixture_types";
import Json "../../../../apps/evm_wallet/backend/rpc/Json";

persistent actor {
  var broadcasts : [Text] = [];
  var reads : [Text] = [];
  var mode : { #uncertain; #accepted; #included } = #uncertain;
  var transactionHash : Text = "";
  let blockHash = "0xabababababababababababababababababababababababababababababababab";

  public func configure(next : { #uncertain; #accepted; #included }, hash : Text) : async () {
    mode := next;
    transactionHash := hash;
  };

  public query func capture() : async { broadcasts : [Text]; reads : [Text] } {
    { broadcasts; reads };
  };

  public func requestCost(_ : Rpc.RpcService, _ : Text, _ : Nat64) : async Rpc.RequestCostResult { #Ok(0) };
  public func eth_sendRawTransactionCyclesCost(_ : Rpc.RpcServices, _ : ?Rpc.RpcConfig, _ : Text) : async Rpc.RequestCostResult { #Ok(0) };

  public func eth_sendRawTransaction(_ : Rpc.RpcServices, _ : ?Rpc.RpcConfig, raw : Text) : async Rpc.MultiSendRawTransactionResult {
    broadcasts := Array.concat(broadcasts, [raw]);
    switch (mode) {
      case (#uncertain) #Consistent(#Err(#HttpOutcallError(#IcError({ code = #SysTransient; message = "Fixture retained broadcast bytes; acknowledgement unavailable" }))));
      case (_) #Consistent(#Ok(#Ok(?transactionHash)));
    };
  };

  public func request(_ : Rpc.RpcService, payload : Text, _ : Nat64) : async Rpc.RequestResult {
    let #ok(body) = Json.parse(payload) else { assert false; loop {} };
    let ?#string(method) = Json.field(body, "method") else { assert false; loop {} };
    let ?#array(params) = Json.field(body, "params") else { assert false; loop {} };
    reads := Array.concat(reads, [method]);
    let result = switch (method) {
      case ("eth_blockNumber") "\"0x64\"";
      case ("eth_getBalance") "\"0xde0b6b3a7640000\"";
      case ("eth_getTransactionCount") "\"0x9\"";
      case ("eth_maxPriorityFeePerGas") "\"0x2\"";
      case ("eth_gasPrice") "\"0x64\"";
      case ("eth_estimateGas") "\"0x5208\"";
      case ("eth_call") "\"0x\"";
      case ("eth_getCode") "\"0x\"";
      case ("eth_getBlockByNumber") "{\"number\":\"0x64\",\"hash\":" # Json.quote(blockHash) # ",\"baseFeePerGas\":\"0x31\"}";
      case ("eth_getTransactionByHash") "null";
      case ("eth_getTransactionReceipt") {
        let ?hash = Json.string(params[0]) else { assert false; loop {} };
        assert hash == transactionHash;
        switch (mode) {
          case (#included) "{\"transactionHash\":" # Json.quote(hash) # ",\"blockNumber\":\"0x64\",\"blockHash\":" # Json.quote(blockHash) # ",\"status\":\"0x1\",\"gasUsed\":\"0x5208\",\"effectiveGasPrice\":\"0x64\",\"logs\":[]}";
          case (_) "null";
        };
      };
      case (_) { assert false; "null" };
    };
    #Ok("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":" # result # "}");
  };
};
