// Wire projections of the official ckETH minter contract:
// https://github.com/dfinity/ic/blob/master/rs/ethereum/cketh/minter/cketh_minter.did
// Optional payload uses Candid's opt rule: unknown future variants decode to
// null, while known deposits remain typed. Never narrow the wire variant.
import Capabilities "../capabilities/Types";
import Types "Types";
module {
    public type Info = {
        minter_address : ?Text;
        smart_contract_address : ?Text;
        eth_helper_contract_address : ?Text;
        erc20_helper_contract_address : ?Text;
        deposit_with_subaccount_helper_contract_address : ?Text;
        supported_ckerc20_tokens : ?[{
            erc20_contract_address : Text;
            ledger_canister_id : Principal;
        }];
        cketh_ledger_id : ?Principal;
    };
    public type EventSource = { transaction_hash : Text; log_index : Nat };
    public type Deposit = {
        transaction_hash : Text;
        block_number : Nat;
        log_index : Nat;
        from_address : Text;
        value : Nat;
        principal : Principal;
        subaccount : ?Blob;
    };
    public type Erc20Deposit = {
        transaction_hash : Text;
        block_number : Nat;
        log_index : Nat;
        from_address : Text;
        value : Nat;
        principal : Principal;
        subaccount : ?Blob;
        erc20_contract_address : Text;
    };
    public type Payload = {
        #AcceptedDeposit : Deposit;
        #AcceptedErc20Deposit : Erc20Deposit;
        #MintedCkEth : { event_source : EventSource; mint_block_index : Nat };
        #MintedCkErc20 : {
            event_source : EventSource;
            erc20_contract_address : Text;
            mint_block_index : Nat;
        };
        #InvalidDeposit : { event_source : EventSource; reason : Text };
        #QuarantinedDeposit : { event_source : EventSource };
    };
    public type Event = { timestamp : Nat64; payload : ?Payload };
    public type Events = { events : [Event]; total_event_count : Nat64 };
    public func infoRequest(minter : Principal) : Capabilities.CallRequest {
        { canister = minter; method = "get_minter_info"; args = to_candid (); cycles = 0 };
    };
    public func eventsRequest(minter : Principal, start : Nat64, length : Nat64) : Capabilities.CallRequest {
        { canister = minter; method = "get_events"; args = to_candid ({ start; length }); cycles = 0 };
    };
    public func decodeInfo(result : Capabilities.CallResult) : Types.Result<Info> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(bytes)) switch (from_candid bytes : ?Info) {
                case null #err("The ckETH minter returned invalid configuration");
                case (?info) #ok(info);
            };
        };
    };
    public func decodeEvents(result : Capabilities.CallResult) : Types.Result<Events> {
        switch (result) {
            case (#err(error)) #err(error.code # ": " # error.message);
            case (#ok(bytes)) switch (from_candid bytes : ?Events) {
                case null #err("The ckETH minter returned invalid events");
                case (?events) #ok(events);
            };
        };
    };
};
