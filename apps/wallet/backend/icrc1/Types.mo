module {
    public type Account = {
        owner : Principal;
        subaccount : ?Blob;
    };

    public type Value = {
        #Nat : Nat;
        #Int : Int;
        #Text : Text;
        #Blob : Blob;
    };

    public type Metadata = [(Text, Value)];

    public type AllowanceArgs = {
        account : Account;
        spender : Account;
    };

    public type Allowance = {
        allowance : Nat;
        expires_at : ?Nat64;
    };

    public type TransferArg = {
        from_subaccount : ?Blob;
        to : Account;
        amount : Nat;
        fee : ?Nat;
        memo : ?Blob;
        created_at_time : ?Nat64;
    };

    public type TransferError = {
        #BadFee : { expected_fee : Nat };
        #BadBurn : { min_burn_amount : Nat };
        #InsufficientFunds : { balance : Nat };
        #TooOld;
        #CreatedInFuture : { ledger_time : Nat64 };
        #TemporarilyUnavailable;
        #Duplicate : { duplicate_of : Nat };
        #GenericError : { error_code : Nat; message : Text };
    };

    public type TransferResult = {
        #Ok : Nat;
        #Err : TransferError;
    };

    public type ApproveArg = {
        from_subaccount : ?Blob;
        spender : Account;
        amount : Nat;
        expected_allowance : ?Nat;
        expires_at : ?Nat64;
        fee : ?Nat;
        memo : ?Blob;
        created_at_time : ?Nat64;
    };

    public type ApproveError = {
        #BadFee : { expected_fee : Nat };
        #InsufficientFunds : { balance : Nat };
        #AllowanceChanged : { current_allowance : Nat };
        #Expired : { ledger_time : Nat64 };
        #TooOld;
        #CreatedInFuture : { ledger_time : Nat64 };
        #Duplicate : { duplicate_of : Nat };
        #TemporarilyUnavailable;
        #GenericError : { error_code : Nat; message : Text };
    };

    public type ApproveResult = {
        #Ok : Nat;
        #Err : ApproveError;
    };

    public type Result<T> = {
        #ok : T;
        #err : Text;
    };
};
