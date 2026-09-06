import Memory "./memory/evm_wallet/v1";
module {
  public type Result<T> = { #ok : T; #err : Text };
  public type Account = Memory.Account;
  public type Network = Memory.Network;
  public type Asset = Memory.Asset;
  public type Identity = Memory.Identity;
  public type Intent = Memory.Intent;
  public type Review = Memory.Review;
  public type Operation = {
    operation_id : Nat; request_id : Text; account_id : Text; chain_id : Nat;
    caller : Memory.Caller;
    kind : Text; status : Text; address : Text; transaction_hash : ?Text;
    signature : ?Text; message : ?Text; review_revision : Nat; review : ?Review;
    replacement_hash : ?Text;
    receipt_json : ?Text; finality : ?Text; created_at : Int; updated_at : Int;
    intent : Intent;
    prepared_transaction : ?{
      to : ?Text; value : Text; data : Text; access_list : [Memory.AccessEntry];
      chain_id : Nat; nonce : Text; gas_limit : Text; transaction_type : Text;
      max_fee_per_gas : ?Text; max_priority_fee_per_gas : ?Text; gas_price : ?Text;
    };
  };
  public type Snapshot = {
    accounts : [Account]; networks : [Network]; assets : [Asset];
    lifecycle : Text;
  };
  public type PrepareRequest = { identity : Identity; intent : Intent };
  public type ExecuteRequest = { identity : Identity; review_revision : Nat };
  public type StatusRequest = { identity : Identity; refresh : Bool };
  public type IdentityRequest = { identity : Identity };
  public type HistoryRequest = { offset : Nat; limit : Nat };
  public type History = { operations : [Operation]; total : Nat };
  public type BalanceRequest = { account_id : Text; chain_id : Nat; tokens : [Text] };
  public type TokenBalance = {
    address : Text; balance : ?Text; decimals : ?Nat; symbol : ?Text; error : ?Text;
  };
  public type Balance = {
    account_id : Text; chain_id : Nat; address : Text; native_balance : Text;
    tokens : [TokenBalance]; block_number : Text; observed_at : Int; completeness : Text;
  };
  public type ReadRequest = { chain_id : Nat; to : Text; data : Text; block : Text };
  public type ReadResult = {
    chain_id : Nat; to : Text; data : Text; result : Text; code : Text;
    block_number : Text; observed_at : Int;
  };
  public type TransactionLookupRequest = {
    chain_id : Nat; transaction_hash : Text;
    wallet_request : ?{ caller_app_id : Text; caller_installation_uid : Nat64; request_id : Text };
  };
  public type TransactionLookup = {
    chain_id : Nat; transaction_hash : Text; transaction_json : Text;
    receipt_json : ?Text; finality : ?Text; observed_at : Int;
    wallet_request_matches : ?Bool;
  };
};
