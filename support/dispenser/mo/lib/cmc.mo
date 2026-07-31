module {
  public type BlockIndex = Nat64;
  public type Cycles = Nat;
  public type IcpXdrConversionRate = {
    xdr_permyriad_per_icp : Nat64;
    timestamp_seconds : Nat64;
  };
  public type IcpXdrConversionRateResponse = {
    certificate : [Nat8];
    data : IcpXdrConversionRate;
    hash_tree : [Nat8];
  };
  public type NotifyCreateCanisterArg = {
    controller : Principal;
    block_index : BlockIndex;
    subnet_type : ?Text;
    subnet_selection : ?{
      #Subnet : { subnet : Principal };
      #Filter : { subnet_type : ?Text };
    };
    settings : ?{
      controllers : ?[Principal];
      compute_allocation : ?Nat;
      memory_allocation : ?Nat;
      freezing_threshold : ?Nat;
      reserved_cycles_limit : ?Nat;
      log_visibility : ?{ #controllers; #public_; #allowed_viewers : [Principal] };
      snapshot_visibility : ?{ #controllers; #public_; #allowed_viewers : [Principal] };
      wasm_memory_limit : ?Nat;
      wasm_memory_threshold : ?Nat;
      environment_variables : ?[{ name : Text; value : Text }];
      log_memory_limit : ?Nat;
    };
  };
  public type NotifyCreateCanisterResult = {
    #Ok : Principal;
    #Err : NotifyError;
  };
  public type NotifyError = {
    #Refunded : { block_index : ?BlockIndex; reason : Text };
    #InvalidTransaction : Text;
    #Other : { error_message : Text; error_code : Nat64 };
    #Processing;
    #TransactionTooOld : BlockIndex;
  };
  public type NotifyTopUpArg = {
    block_index : BlockIndex;
    canister_id : Principal;
  };
  public type NotifyTopUpResult = { #Ok : Cycles; #Err : NotifyError };
  public type SubnetTypesToSubnetsResponse = { data : [(Text, [Principal])] };
  public type Self = actor {
    get_icp_xdr_conversion_rate : shared query () -> async IcpXdrConversionRateResponse;
    get_subnet_types_to_subnets : shared query () -> async SubnetTypesToSubnetsResponse;
    notify_create_canister : shared NotifyCreateCanisterArg -> async NotifyCreateCanisterResult;
    notify_top_up : shared NotifyTopUpArg -> async NotifyTopUpResult;
  }
}
