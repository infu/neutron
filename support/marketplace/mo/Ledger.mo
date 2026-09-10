// Proprietary marketplace protocol. All rights reserved.
import Error "mo:core/Error";
import Principal "mo:core/Principal";

// Wire types stay separate from protocol persistence. Every dispatched request
// is frozen by the operation owner before entering either await below. Calls
// use the IC's default guaranteed-response await: no deadline or timeout opts
// turn a pending ledger response into an artificial unknown outcome.
module {
    public type Account = { owner : Principal; subaccount : ?Blob };
    public type TransferArgs = {
        from_subaccount : ?Blob; to : Account; amount : Nat;
        fee : ?Nat; memo : ?Blob; created_at_time : ?Nat64;
    };
    public type TransferFromArgs = {
        spender_subaccount : ?Blob; from : Account; to : Account; amount : Nat;
        fee : ?Nat; memo : ?Blob; created_at_time : ?Nat64;
    };
    public type TransferError = {
        #BadFee : { expected_fee : Nat };
        #BadBurn : { min_burn_amount : Nat };
        #InsufficientFunds : { balance : Nat };
        #TooOld;
        #CreatedInFuture : { ledger_time : Nat64 };
        #Duplicate : { duplicate_of : Nat };
        #TemporarilyUnavailable;
        #GenericError : { error_code : Nat; message : Text };
    };
    public type TransferFromError = TransferError or { #InsufficientAllowance : { allowance : Nat } };
    public type TransferResult = { #Ok : Nat; #Err : TransferError };
    public type TransferFromResult = { #Ok : Nat; #Err : TransferFromError };
    public type Outcome = { #response : TransferFromResult; #unknown : Text };
    public type Interface = actor {
        icrc1_transfer : shared TransferArgs -> async TransferResult;
        icrc2_transfer_from : shared TransferFromArgs -> async TransferFromResult;
        icrc1_fee : shared query () -> async Nat;
        icrc1_decimals : shared query () -> async Nat8;
        icrc1_balance_of : shared query Account -> async Nat;
        icrc2_allowance : shared query { account : Account; spender : Account } -> async { allowance : Nat; expires_at : ?Nat64 };
    };
    public type Client = {
        transfer : (Principal, TransferArgs) -> async* Outcome;
        transferFrom : (Principal, TransferFromArgs) -> async* Outcome;
    };
    public func transfer(ledger : Principal, args : TransferArgs) : async* Outcome {
        let target : Interface = actor (Principal.toText(ledger));
        try {
            switch (await target.icrc1_transfer(args)) {
                case (#Ok(block)) #response(#Ok(block));
                case (#Err(error)) #response(#Err(error));
            };
        } catch error { #unknown(Error.message(error)) };
    };
    public func transferFrom(ledger : Principal, args : TransferFromArgs) : async* Outcome {
        let target : Interface = actor (Principal.toText(ledger));
        try { #response(await target.icrc2_transfer_from(args)) }
        catch error { #unknown(Error.message(error)) };
    };
    public func client() : Client { { transfer; transferFrom } };
}
