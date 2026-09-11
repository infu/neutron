// Persistent schema: immutable after its first production release.
import Map "mo:core/Map";
module {
    public type Kind = { #icp_topup; #tcycles_topup; #icp_to_tcycles };
    public type Phase = {
        #prepared; #transfer_pending; #notify_pending; #withdraw_pending;
        #forward_pending; #complete; #refunded; #stopped;
    };
    public type Request = {
        id : Blob;
        kind : Kind;
        target : Principal;
        amount : Nat;
        icp_fee : Nat;
        cycles_fee : Nat;
        // Gross rate conversion, before any cycles-ledger deposit/transfer fee.
        estimated_cycles : Nat;
    };
    public type Command = {
        request : Request;
        owner : Principal;
        created_at : Int;
        var updated_at : Int;
        var phase : Phase;
        // Freeze timestamp and full Candid before the first debit. Recovery
        // never replaces these bytes or silently starts another financial intent.
        var source_args : ?Blob;
        var source_timestamp : ?Nat64;
        var source_uncertain : Bool;
        var source_block : ?Nat;
        var mint_block : ?Nat;
        var minted_cycles : ?Nat;
        var credited_cycles : ?Nat;
        var forward_args : ?Blob;
        var forward_timestamp : ?Nat64;
        var forward_uncertain : Bool;
        var forward_block : ?Nat;
        var refund_block : ?Nat;
        var duplicate : Bool;
        var error : ?Text;
    };
    public type Mem = {
        commands : Map.Map<Blob, Command>;
        // ICP CMC payments use fixed memos, and cycles withdrawals have none.
        // A durable unique timestamp distinguishes separate same-size actions.
        var last_timestamp : Nat64;
    };
    public func init() : Mem { { commands = Map.empty<Blob, Command>(); var last_timestamp = 0 } };
};
