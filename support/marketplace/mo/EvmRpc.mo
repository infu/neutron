// All rights reserved. See ../LICENSE.
// Wire projection verified against the deployed EVM RPC candid:service on
// 2026-09-10: 7hfb6-caaaa-aaaar-qadga-cai. Preserve every decoded variant arm.
// https://github.com/dfinity/evm-rpc-canister/blob/evm_rpc-v2.8.0/candid/evm_rpc.did
import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Encoding "./Encoding";

module {
  public type EthMainnetService = { #Alchemy; #Ankr; #BlockPi; #Cloudflare; #PublicNode; #Llama };
  public type EthSepoliaService = { #Alchemy; #Ankr; #BlockPi; #PublicNode; #Sepolia };
  public type L2MainnetService = { #Alchemy; #Ankr; #BlockPi; #PublicNode; #Llama };
  public type HttpHeader = { name : Text; value : Text };
  public type RpcApi = { url : Text; headers : ?[HttpHeader] };
  public type RpcService = {
    #Provider : Nat64; #Custom : RpcApi; #EthMainnet : EthMainnetService;
    #EthSepolia : EthSepoliaService; #ArbitrumOne : L2MainnetService;
    #BaseMainnet : L2MainnetService; #OptimismMainnet : L2MainnetService;
  };
  public type RpcServices = {
    #Custom : { chainId : Nat64; services : [RpcApi] }; #EthMainnet : ?[EthMainnetService];
    #EthSepolia : ?[EthSepoliaService]; #ArbitrumOne : ?[L2MainnetService];
    #BaseMainnet : ?[L2MainnetService]; #OptimismMainnet : ?[L2MainnetService];
  };
  public type ConsensusStrategy = { #Equality; #Threshold : { total : ?Nat8; min : Nat8 } };
  public type RpcConfig = { responseSizeEstimate : ?Nat64; responseConsensus : ?ConsensusStrategy };
  public type RejectionCode = { #NoError; #CanisterError; #SysTransient; #DestinationInvalid; #Unknown; #SysFatal; #CanisterReject };
  public type RpcError = {
    #JsonRpcError : { code : Int64; message : Text };
    #ProviderError : { #TooFewCycles : { expected : Nat; received : Nat }; #MissingRequiredProvider; #ProviderNotFound; #NoPermission; #InvalidRpcConfig : Text };
    #ValidationError : { #Custom : Text; #InvalidHex : Text };
    #HttpOutcallError : {
      #IcError : { code : RejectionCode; message : Text };
      #InvalidHttpJsonRpcResponse : { status : Nat16; body : Text; parsingError : ?Text };
    };
  };
  public type LogEntry = {
    transactionHash : ?Text; blockNumber : ?Nat; data : Text; blockHash : ?Text;
    transactionIndex : ?Nat; topics : [Text]; address : Text; logIndex : ?Nat; removed : Bool;
  };
  public type TransactionReceipt = {
    to : ?Text; status : ?Nat; root : ?Text; transactionHash : Text; blockNumber : Nat;
    from : Text; logs : [LogEntry]; blockHash : Text; type_ : Text; transactionIndex : Nat;
    effectiveGasPrice : Nat; logsBloom : Text; contractAddress : ?Text; gasUsed : Nat; cumulativeGasUsed : Nat;
  };
  public type Block = {
    miner : Text; totalDifficulty : ?Nat; receiptsRoot : Text; stateRoot : Text; hash : Text;
    difficulty : ?Nat; size : Nat; uncles : [Text]; baseFeePerGas : ?Nat; extraData : Text;
    transactionsRoot : ?Text; sha3Uncles : Text; nonce : Nat; number : Nat; timestamp : Nat;
    transactions : [Text]; gasLimit : Nat; logsBloom : Text; parentHash : Text; gasUsed : Nat; mixHash : Text;
  };
  public type BlockTag = { #Earliest; #Safe; #Finalized; #Latest; #Number : Nat; #Pending };
  public type RequestCostResult = { #Ok : Nat; #Err : RpcError };
  public type GetTransactionReceiptResult = { #Ok : ?TransactionReceipt; #Err : RpcError };
  public type MultiGetTransactionReceiptResult = { #Consistent : GetTransactionReceiptResult; #Inconsistent : [(RpcService, GetTransactionReceiptResult)] };
  public type GetBlockByNumberResult = { #Ok : Block; #Err : RpcError };
  public type MultiGetBlockByNumberResult = { #Consistent : GetBlockByNumberResult; #Inconsistent : [(RpcService, GetBlockByNumberResult)] };
  public type Service = actor {
    eth_getTransactionReceipt : shared (RpcServices, ?RpcConfig, Text) -> async MultiGetTransactionReceiptResult;
    eth_getTransactionReceiptCyclesCost : shared query (RpcServices, ?RpcConfig, Text) -> async RequestCostResult;
    eth_getBlockByNumber : shared (RpcServices, ?RpcConfig, BlockTag) -> async MultiGetBlockByNumberResult;
    eth_getBlockByNumberCyclesCost : shared query (RpcServices, ?RpcConfig, BlockTag) -> async RequestCostResult;
  };
  public type Failure = {
    #invalidRequest : Text; #invalidEvidence : Text; #notMined; #reverted;
    #transport : { method : Text; message : Text };
    #rpc : { method : Text; error : RpcError };
    #inconsistent : { method : Text };
    #budget : { method : Text; required : Nat; available : Nat };
  };
  public type Result<T> = { #ok : T; #err : Failure };
  public type Client = {
    receiptCost : (RpcServices, ?RpcConfig, Text) -> async* Result<RequestCostResult>;
    receipt : (Nat, RpcServices, ?RpcConfig, Text) -> async* Result<MultiGetTransactionReceiptResult>;
    blockCost : (RpcServices, ?RpcConfig, BlockTag) -> async* Result<RequestCostResult>;
    block : (Nat, RpcServices, ?RpcConfig, BlockTag) -> async* Result<MultiGetBlockByNumberResult>;
  };
  public type Options = {
    // Callers select the three built-in providers and fixed cycle budgets.
    // No provider secrets, dynamic fees, retries, or archive state reads here.
    providers : [EthMainnetService]; receiptResponseBytes : Nat64; blockResponseBytes : Nat64;
    receiptCycles : Nat; blockCycles : Nat;
  };
  public type Observation = { receipt : TransactionReceipt; block : Block };

  public func client(canister : Principal) : Client {
    let rpc : Service = actor (Principal.toText(canister));
    {
      receiptCost = func(services : RpcServices, config : ?RpcConfig, hash : Text) : async* Result<RequestCostResult> {
        try { #ok(await rpc.eth_getTransactionReceiptCyclesCost(services, config, hash)) }
        catch error { #err(#transport({ method = "eth_getTransactionReceiptCyclesCost"; message = Error.message(error) })) };
      };
      receipt = func(cycles : Nat, services : RpcServices, config : ?RpcConfig, hash : Text) : async* Result<MultiGetTransactionReceiptResult> {
        try { #ok(await (with cycles) rpc.eth_getTransactionReceipt(services, config, hash)) }
        catch error { #err(#transport({ method = "eth_getTransactionReceipt"; message = Error.message(error) })) };
      };
      blockCost = func(services : RpcServices, config : ?RpcConfig, tag : BlockTag) : async* Result<RequestCostResult> {
        try { #ok(await rpc.eth_getBlockByNumberCyclesCost(services, config, tag)) }
        catch error { #err(#transport({ method = "eth_getBlockByNumberCyclesCost"; message = Error.message(error) })) };
      };
      block = func(cycles : Nat, services : RpcServices, config : ?RpcConfig, tag : BlockTag) : async* Result<MultiGetBlockByNumberResult> {
        try { #ok(await (with cycles) rpc.eth_getBlockByNumber(services, config, tag)) }
        catch error { #err(#transport({ method = "eth_getBlockByNumber"; message = Error.message(error) })) };
      };
    };
  };
  public func validHash(value : Text) : Bool {
    switch (Text.stripStart(Text.toLower(value), #text("0x"))) {
      case (?hex) Encoding.isHex(hex, 32);
      case null false;
    };
  };
  func cost(method : Text, response : RequestCostResult, available : Nat) : Result<()> {
    switch response {
      case (#Err(error)) #err(#rpc({ method; error }));
      case (#Ok(required)) {
        if (required > available) #err(#budget({ method; required; available })) else #ok(());
      };
    };
  };
  public func readWith(calls : Client, options : Options, transactionHash : Text) : async* Result<Observation> {
    if (not validHash(transactionHash)) return #err(#invalidRequest("Ethereum transaction hash must contain exactly 32 bytes"));
    if (options.providers.size() != 3) return #err(#invalidRequest("Choose three distinct built-in Ethereum RPC providers"));
    if (options.providers[0] == options.providers[1] or options.providers[0] == options.providers[2] or options.providers[1] == options.providers[2]) {
      return #err(#invalidRequest("Choose three distinct built-in Ethereum RPC providers"));
    };
    if (options.receiptResponseBytes == 0 or options.blockResponseBytes == 0 or options.receiptCycles == 0 or options.blockCycles == 0) {
      return #err(#invalidRequest("Receipt and block response sizes and cycle budgets must be positive"));
    };
    let hash = Text.toLower(transactionHash);
    let services : RpcServices = #EthMainnet(?options.providers);
    let receiptConfig : ?RpcConfig = ?{ responseSizeEstimate = ?options.receiptResponseBytes; responseConsensus = ?#Equality };
    let quoted = switch (await* calls.receiptCost(services, receiptConfig, hash)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
    switch (cost("eth_getTransactionReceipt", quoted, options.receiptCycles)) { case (#err(error)) return #err(error); case (_) {} };
    let response = switch (await* calls.receipt(options.receiptCycles, services, receiptConfig, hash)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
    let receipt = switch response {
      case (#Inconsistent(_)) return #err(#inconsistent({ method = "eth_getTransactionReceipt" }));
      case (#Consistent(#Err(error))) return #err(#rpc({ method = "eth_getTransactionReceipt"; error }));
      case (#Consistent(#Ok(null))) return #err(#notMined);
      case (#Consistent(#Ok(?value))) value;
    };
    if (not validHash(receipt.transactionHash) or Text.toLower(receipt.transactionHash) != hash or not validHash(receipt.blockHash)) {
      return #err(#invalidEvidence("Receipt transaction or block hash does not match the request"));
    };
    switch (receipt.status) {
      case (?1) {};
      case (?0) return #err(#reverted);
      case (_) return #err(#invalidEvidence("Receipt has no successful execution status"));
    };
    let tag : BlockTag = #Number(receipt.blockNumber);
    let blockConfig : ?RpcConfig = ?{ responseSizeEstimate = ?options.blockResponseBytes; responseConsensus = ?#Equality };
    let blockQuoted = switch (await* calls.blockCost(services, blockConfig, tag)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
    switch (cost("eth_getBlockByNumber", blockQuoted, options.blockCycles)) { case (#err(error)) return #err(error); case (_) {} };
    let blockResponse = switch (await* calls.block(options.blockCycles, services, blockConfig, tag)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
    let block = switch blockResponse {
      case (#Inconsistent(_)) return #err(#inconsistent({ method = "eth_getBlockByNumber" }));
      case (#Consistent(#Err(error))) return #err(#rpc({ method = "eth_getBlockByNumber"; error }));
      case (#Consistent(#Ok(value))) value;
    };
    if (not validHash(block.hash) or block.number != receipt.blockNumber or Text.toLower(block.hash) != Text.toLower(receipt.blockHash)) {
      return #err(#invalidEvidence("Receipt block is no longer the observed canonical Ethereum block"));
    };
    #ok({ receipt; block });
  };
  public func read(canister : Principal, options : Options, transactionHash : Text) : async* Result<Observation> {
    await* readWith(client(canister), options, transactionHash);
  };
}
