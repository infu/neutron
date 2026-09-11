import Memory "../memory/wallet_refills/v1";
module {
    public type Request = Memory.Request;
    public type View = {
        id : Blob; kind : Memory.Kind; target : Principal; amount : Nat;
        icp_fee : Nat; cycles_fee : Nat; estimated_cycles : Nat;
        created_at : Int; updated_at : Int; phase : Memory.Phase;
        source_block : ?Nat; mint_block : ?Nat; minted_cycles : ?Nat;
        forward_block : ?Nat; refund_block : ?Nat; credited_cycles : ?Nat;
        duplicate : Bool; error : ?Text; can_continue : Bool;
    };
    public type Result = { #ok : View; #err : Text };
    public type Cursor = { created_at : Int; id : Blob };
    public type PageRequest = { before : ?Cursor; limit : Nat; pending_only : Bool };
    public type Page = { operations : [View]; next_cursor : ?Cursor };
    public type NotifyError = {
        #Refunded : { reason : Text; block_index : ?Nat64 };
        #Processing;
        #TransactionTooOld : Nat64;
        #InvalidTransaction : Text;
        #Other : { error_code : Nat64; error_message : Text };
    };
    public type NotifyTopUpArgs = { block_index : Nat64; canister_id : Principal };
    public type NotifyTopUpResult = { #Ok : Nat; #Err : NotifyError };
    public type NotifyMintArgs = { block_index : Nat64; to_subaccount : ?Blob; deposit_memo : ?Blob };
    public type NotifyMintResult = {
        #Ok : { block_index : Nat; minted : Nat; balance : Nat };
        #Err : NotifyError;
    };
    public type WithdrawArgs = { from_subaccount : ?Blob; to : Principal; amount : Nat; created_at_time : ?Nat64 };
    public type RejectionCode = {
        #NoError; #CanisterError; #SysTransient; #DestinationInvalid;
        #Unknown; #SysFatal; #CanisterReject;
    };
    public type WithdrawError = {
        #GenericError : { message : Text; error_code : Nat };
        #TemporarilyUnavailable;
        #FailedToWithdraw : { fee_block : ?Nat; rejection_code : RejectionCode; rejection_reason : Text };
        #Duplicate : { duplicate_of : Nat };
        #BadFee : { expected_fee : Nat };
        #InvalidReceiver : { receiver : Principal };
        #CreatedInFuture : { ledger_time : Nat64 };
        #TooOld;
        #InsufficientFunds : { balance : Nat };
    };
    public type WithdrawResult = { #Ok : Nat; #Err : WithdrawError };
};
