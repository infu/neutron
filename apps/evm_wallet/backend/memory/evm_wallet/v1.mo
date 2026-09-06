// Persistent schema. Immutable after its first published release.
import Map "mo:core/Map";

module {
  public type Account = {
    id : Text; slot : Text; address : Text; public_key : Blob;
    key_fingerprint : Blob; namespace_version : Nat;
  };
  public type Network = {
    chain_id : Nat; name : Text; native_symbol : Text; explorer_url : Text;
    testnet : Bool; finality_description : Text;
  };
  public type Asset = { chain_id : Nat; address : Text; symbol : Text; decimals : Nat };
  public type Caller = { app_id : Text; installation_uid : Nat64; endpoint : Text };
  public type Identity = { caller : Caller; request_id : Text };
  public type AccessEntry = { address : Text; storageKeys : [Text] };
  public type TransactionRequest = {
    to : Text; value : Text; data : Text; gas_limit : ?Text;
    max_fee_per_gas : ?Text; max_priority_fee_per_gas : ?Text; gas_price : ?Text;
    transaction_type : ?Text;
    access_list : [AccessEntry];
  };
  public type Intent = {
    account_id : Text; chain_id : Nat;
    operation : {
      #transaction : TransactionRequest;
      #personal_message : { message : Text };
      #typed_data : { json : Text };
      #replacement : {
        operation_id : Nat; cancel : Bool;
        max_fee_per_gas : Text; max_priority_fee_per_gas : Text;
      };
    };
  };
  public type Transaction = {
    chainId : Nat; nonce : Nat; gasLimit : Nat; to : ?Text; value : Nat;
    data : Blob; accessList : [AccessEntry];
    fee : {
      #legacy : { gasPrice : Nat };
      #eip1559 : { maxFeePerGas : Nat; maxPriorityFeePerGas : Nat };
    };
  };
  public type Review = {
    nonce : Text; gas_limit : Text; max_fee_per_gas : ?Text;
    max_priority_fee_per_gas : ?Text; gas_price : ?Text; balance : Text;
    simulation : Text; observed_at : Int;
  };
  public type Command = {
    id : Nat; identity : Identity; intent : Intent; intent_bytes : Blob;
    created_at : Int; var updated_at : Int;
    var status : Text; var address : Text; var message : ?Text;
    var review_revision : Nat; var review : ?Review;
    var transaction : ?Transaction; var digest : ?Blob;
    var signature : ?Blob; var signed_raw : ?Blob; var transaction_hash : ?Text;
    var receipt_json : ?Text; var finality : ?Text;
    var replacement_hash : ?Text;
    var reserved_nonce : Bool;
  };
  public type Mem = {
    accounts : Map.Map<Text, Account>;
    networks : Map.Map<Nat, Network>;
    assets : Map.Map<Text, Asset>;
    commands : Map.Map<Text, Command>;
    // Greatest observed network nonce floor. Allocation scans retained active
    // reservations above this floor, allowing unsigned rejected slots reuse.
    nonce_next : Map.Map<Text, Nat>;
    var next_operation_id : Nat;
  };
  public func init() : Mem {
    {
      accounts = Map.empty(); networks = Map.empty(); assets = Map.empty();
      commands = Map.empty(); nonce_next = Map.empty(); var next_operation_id = 1;
    };
  };
};
