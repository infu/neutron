import Memory "../memory/kernel_cycle_calls/v1";
import Backend "../backend_calls/Types";
module {
    public type Request = Memory.Request;
    public type Receipt = Memory.Receipt;
    public type Error = Memory.Error;
    public type Result = { #ok : Receipt; #err : Error };
    public type Quote = Backend.OwnerCallQuote;
    public type QuoteResult = Backend.OwnerCallQuoteResult;
    public type StatusInput = { app_scope : Memory.AppScope; id : Blob };
    public type ListInput = { app_scope : Memory.AppScope; before : ?Nat; limit : Nat };
    // Lists omit arbitrary request/reply bytes; status retains the complete
    // operation for exact recovery and protocol-specific receipt decoding.
    public type Summary = {
        id : Blob; sequence : Nat; canister : Principal; method : Text;
        requested_cycles : Nat; actual_cycles : Nat; allow_partial : Bool;
        created_at : Nat64; updated_at : Nat64; dispatched : Bool;
        settled : Bool; charged_cycles : ?Nat; error : ?Error;
    };
    public type Page = { calls : [Summary]; next_before : ?Nat };
};
