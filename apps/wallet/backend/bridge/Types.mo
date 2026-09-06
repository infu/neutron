import Memory "../memory/wallet_bridge/v1";
module {
    public type Result<T> = { #ok : T; #err : Text };
    public type Intent = Memory.Intent;
    public type Quote = Memory.Quote;
    public type PrepareRequest = {
        id : Blob;
        ledger : Principal;
        source : Memory.Source;
        account : Text;
        amount : Nat;
        subaccount : ?Blob;
    };
    public type ClaimRequest = {
        id : Blob;
        revision : Nat;
        step : Memory.StepKind;
        operation_id : ?Text;
    };
    public type RecordStepRequest = {
        id : Blob;
        revision : Nat;
        step : Memory.StepKind;
        state : { #submitted; #confirmed; #failed; #unknown };
        transaction_hash : ?Text;
        error : ?Text;
    };
    public type RefreshRequest = { id : Blob; event_page_length : Nat64 };
    public type ListRequest = { ledger : ?Principal; after : ?Blob; limit : Nat };
    public type Page = { records : [Intent]; next : ?Blob };
};
