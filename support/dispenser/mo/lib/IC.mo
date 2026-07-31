// This is a generated Motoko binding.
module {
  public type canister_id = Principal;
  public type canister_settings = {
    controllers : ?[Principal];
    freezing_threshold : ?Nat;
    memory_allocation : ?Nat;
    compute_allocation : ?Nat;
    log_visibility : ?{ #controllers; #allowed_viewers : [Principal] };
    reserved_cycles_limit : ?Nat;
    snapshot_visibility : ?{ #controllers; #public_; #allowed_viewers : [Principal] };
    wasm_memory_limit : ?Nat;
    wasm_memory_threshold : ?Nat;
    environment_variables : ?[{ name : Text; value : Text }];
  };
  public type definite_canister_settings = {
    controllers : [Principal];
    freezing_threshold : Nat;
    memory_allocation : Nat;
    compute_allocation : Nat;
    log_visibility : { #controllers; #allowed_viewers : [Principal] };
    reserved_cycles_limit : Nat;
    snapshot_visibility : { #controllers; #public_; #allowed_viewers : [Principal] };
    wasm_memory_limit : Nat;
    wasm_memory_threshold : Nat;
    environment_variables : [{ name : Text; value : Text }];
  };
  public type user_id = Principal;
  public type wasm_module = Blob;
  public type install_mode = {
    #install;
  };
  public type Self = actor {
    canister_info : shared {
        canister_id : canister_id;
        num_requested_changes : ?Nat64;
      } -> async {
        controllers : [Principal];
        module_hash : ?Blob;
      };
    canister_status : shared { canister_id : canister_id } -> async {
        status : { #stopped; #stopping; #running };
        memory_size : Nat;
        cycles : Nat;
        settings : definite_canister_settings;
        module_hash : ?Blob;
        canister_version : ?Nat64;
        version : ?Nat64;
      };
    create_canister : shared { settings : ?canister_settings } -> async {
        canister_id : canister_id;
      };
    delete_canister : shared { canister_id : canister_id } -> async ();
    deposit_cycles : shared { canister_id : canister_id } -> async ();
    install_code : shared {
        arg : Blob;
        wasm_module : wasm_module;
        mode : install_mode;
        canister_id : canister_id;
        sender_canister_version : ?Nat64;
      } -> async ();
    raw_rand : shared () -> async Blob;
    start_canister : shared { canister_id : canister_id } -> async ();
    stop_canister : shared { canister_id : canister_id } -> async ();
    uninstall_code : shared { canister_id : canister_id } -> async ();
    update_settings : shared {
        canister_id : Principal;
        sender_canister_version : ?Nat64;
        settings : canister_settings;
      } -> async ();
  };
}
