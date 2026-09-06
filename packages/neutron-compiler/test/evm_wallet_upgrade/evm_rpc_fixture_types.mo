// Wire types pinned to dfinity/evm-rpc-canister, tag evm_rpc-v2.8.0,
// candid/evm_rpc.did. Keep every variant arm: narrowing a decoded Candid
// variant would turn a legitimate remote error into a decode failure.
module {
    public type EthMainnetService = { #Alchemy; #Ankr; #BlockPi; #Cloudflare; #PublicNode; #Llama };
    public type EthSepoliaService = { #Alchemy; #Ankr; #BlockPi; #PublicNode; #Sepolia };
    public type L2MainnetService = { #Alchemy; #Ankr; #BlockPi; #PublicNode; #Llama };
    public type HttpHeader = { name : Text; value : Text };
    public type RpcApi = { url : Text; headers : ?[HttpHeader] };
    public type RpcService = {
        #Provider : Nat64;
        #Custom : RpcApi;
        #EthMainnet : EthMainnetService;
        #EthSepolia : EthSepoliaService;
        #ArbitrumOne : L2MainnetService;
        #BaseMainnet : L2MainnetService;
        #OptimismMainnet : L2MainnetService;
    };
    public type RpcServices = {
        #Custom : { chainId : Nat64; services : [RpcApi] };
        #EthMainnet : ?[EthMainnetService];
        #EthSepolia : ?[EthSepoliaService];
        #ArbitrumOne : ?[L2MainnetService];
        #BaseMainnet : ?[L2MainnetService];
        #OptimismMainnet : ?[L2MainnetService];
    };
    public type ConsensusStrategy = { #Equality; #Threshold : { total : ?Nat8; min : Nat8 } };
    public type RpcConfig = { responseSizeEstimate : ?Nat64; responseConsensus : ?ConsensusStrategy };
    public type RejectionCode = { #NoError; #CanisterError; #SysTransient; #DestinationInvalid; #Unknown; #SysFatal; #CanisterReject };
    public type RpcError = {
        #JsonRpcError : { code : Int64; message : Text };
        #ProviderError : {
            #TooFewCycles : { expected : Nat; received : Nat };
            #MissingRequiredProvider;
            #ProviderNotFound;
            #NoPermission;
            #InvalidRpcConfig : Text;
        };
        #ValidationError : { #Custom : Text; #InvalidHex : Text };
        #HttpOutcallError : {
            #IcError : { code : RejectionCode; message : Text };
            #InvalidHttpJsonRpcResponse : { status : Nat16; body : Text; parsingError : ?Text };
        };
    };
    public type RequestCostResult = { #Ok : Nat; #Err : RpcError };
    public type RequestResult = { #Ok : Text; #Err : RpcError };
    public type SendRawTransactionStatus = { #Ok : ?Text; #NonceTooLow; #NonceTooHigh; #InsufficientFunds };
    public type SendRawTransactionResult = { #Ok : SendRawTransactionStatus; #Err : RpcError };
    public type MultiSendRawTransactionResult = { #Consistent : SendRawTransactionResult; #Inconsistent : [(RpcService, SendRawTransactionResult)] };
};
